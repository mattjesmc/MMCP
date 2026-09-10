package com.mattmc.mcptoolkit;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.platform.LoaderPlatform;
import com.mattmc.mcptoolkit.platform.Platform;

import java.io.IOException;
import java.lang.management.ManagementFactory;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.stream.Stream;

/**
 * {@code ping.build} - which BUILD this game is running, not only which launch (RELEASE_1.md
 * section K1). {@code instanceId} catches a restart; it cannot catch "this is the wrong build": a
 * second dev run that cannot bind the project port keeps a suite talking to the older JVM, whose
 * answers are about code that is not the code just written. The block gives a suite three things to
 * refuse on:
 *
 * <ul>
 *   <li><b>{@code started_at}</b> - the JVM's start instant.</li>
 *   <li><b>{@code mods_hash}</b> - a short hash over every loaded {@code id@version}, sorted. One
 *       string to compare; a change anywhere in the load changes it. Fabric API's sixty modules and
 *       the loader's own pseudo-mods ride HERE and are not listed, because a sixty-row list on
 *       every ping is a cost the fact does not need.</li>
 *   <li><b>{@code mods}</b> - only the mods a suite could have BUILT: those whose origin is a
 *       directory (a dev run's {@code build/resources/main}, and its {@code build/classes} sibling,
 *       which the loader does not name) or a jar under the game's {@code mods/} folder. Each origin
 *       carries its newest mtime, and {@code stale} says an origin is newer than the JVM - the code
 *       on disk is not the code running, which is the exact shape of the wrong-build failure.</li>
 * </ul>
 *
 * <p>The report is a pure function of a mod list, a game directory and a start instant
 * ({@link #report(List, Path, Instant)}), so the unit test can hand it a temp tree; the loader is
 * asked only by {@link #report()}.
 */
public final class BuildIdentity {

    private BuildIdentity() {}

    /** The JVM's start, once. The loader's classes came after it, so anything newer is a rebuild. */
    static final Instant STARTED_AT =
        Instant.ofEpochMilli(ManagementFactory.getRuntimeMXBean().getStartTime());

    /**
     * The loader's pseudo-mods. Both loaders list {@code java} (origin: the JDK directory - a
     * directory, so it would be walked and listed as buildable) and {@code minecraft}; neither is
     * anything a suite built. They ride the hash like everything else.
     */
    private static final java.util.Set<String> PSEUDO = java.util.Set.of("java", "minecraft");

    /** Entries walked per directory origin before the newest-mtime search stops; a resources tree is small. */
    private static final int WALK_CAP = 5000;

    public static JsonObject report() {
        return report(Platform.loadedMods(), Platform.gameDir(), STARTED_AT);
    }

    static JsonObject report(final List<LoaderPlatform.LoadedMod> mods, final Path gameDir,
                             final Instant startedAt) {
        JsonObject r = new JsonObject();
        r.addProperty("started_at", startedAt.toString());
        r.addProperty("mods_hash", modsHash(mods));
        Path modsDir = gameDir.toAbsolutePath().normalize().resolve("mods");
        JsonArray list = new JsonArray();
        boolean stale = false;
        for (LoaderPlatform.LoadedMod mod : mods) {
            if (PSEUDO.contains(mod.modId())) {
                continue;
            }
            JsonArray origins = new JsonArray();
            for (Path origin : buildableOrigins(mod, modsDir)) {
                JsonObject o = new JsonObject();
                o.addProperty("path", origin.toString());
                Instant mtime = newestMtime(origin);
                if (mtime != null) {
                    o.addProperty("mtime", mtime.toString());
                    if (mtime.isAfter(startedAt)) {
                        stale = true;
                    }
                }
                origins.add(o);
            }
            if (origins.isEmpty()) {
                continue;
            }
            JsonObject m = new JsonObject();
            m.addProperty("id", mod.modId());
            m.addProperty("version", mod.version());
            m.add("origins", origins);
            list.add(m);
        }
        r.add("mods", list);
        r.addProperty("stale", stale);
        return r;
    }

    /** {@code sha-256(sorted "id@version" lines)}, first twelve hex digits. */
    static String modsHash(final List<LoaderPlatform.LoadedMod> mods) {
        List<String> lines = new ArrayList<>();
        for (LoaderPlatform.LoadedMod mod : mods) {
            lines.add(mod.modId() + "@" + mod.version());
        }
        lines.sort(null);
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            for (String line : lines) {
                md.update(line.getBytes(StandardCharsets.UTF_8));
                md.update((byte) '\n');
            }
            StringBuilder sb = new StringBuilder();
            for (byte b : md.digest()) {
                sb.append(String.format(Locale.ROOT, "%02x", b));
            }
            return sb.substring(0, 12);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /**
     * The origins a suite could have built: directories (plus the {@code classes} sibling of a
     * {@code resources} one - on Fabric a dev mod's origin is ONLY {@code build/resources/main}, and
     * the classes are what a rebuild changes) and jars sitting directly in {@code mods/}.
     */
    private static List<Path> buildableOrigins(final LoaderPlatform.LoadedMod mod, final Path modsDir) {
        List<Path> out = new ArrayList<>();
        for (Path raw : mod.origins()) {
            Path origin = raw.toAbsolutePath().normalize();
            if (Files.isDirectory(origin)) {
                if (!out.contains(origin)) {
                    out.add(origin);
                }
                Path classes = classesSibling(origin);
                if (classes != null && Files.isDirectory(classes) && !out.contains(classes)) {
                    out.add(classes);
                }
            } else if (Files.isRegularFile(origin) && origin.getParent() != null
                && origin.getParent().equals(modsDir) && !out.contains(origin)) {
                out.add(origin);
            }
        }
        return out;
    }

    /** {@code .../build/resources/<set>} to {@code .../build/classes/java/<set>}, else null. */
    static Path classesSibling(final Path loc) {
        int n = loc.getNameCount();
        if (n < 3 || !loc.getName(n - 2).toString().equals("resources")) {
            return null;
        }
        Path build = loc.getParent().getParent();
        return build.resolve("classes").resolve("java").resolve(loc.getName(n - 1).toString());
    }

    /** A file's mtime; a directory's newest mtime among its files, walk capped. Null if unreadable. */
    static Instant newestMtime(final Path origin) {
        try {
            if (!Files.isDirectory(origin)) {
                return Files.getLastModifiedTime(origin).toInstant();
            }
            FileTime newest = Files.getLastModifiedTime(origin);
            try (Stream<Path> walk = Files.walk(origin)) {
                for (Path p : (Iterable<Path>) walk.limit(WALK_CAP)::iterator) {
                    if (!Files.isRegularFile(p)) {
                        continue;
                    }
                    FileTime t = Files.getLastModifiedTime(p);
                    if (t.compareTo(newest) > 0) {
                        newest = t;
                    }
                }
            }
            return newest.toInstant();
        } catch (IOException | RuntimeException e) {
            return null;
        }
    }
}
