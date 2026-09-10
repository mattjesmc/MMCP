package com.mattmc.mcptoolkit;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.platform.LoaderPlatform;
import com.mattmc.mcptoolkit.platform.Platform;
import org.jspecify.annotations.Nullable;

import java.io.IOException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.CodeSource;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * The crash fold on {@code get_log} (RELEASE_1.md section J3): the previous game's death, read by
 * the next one.
 *
 * <p>The log ring cannot hold a crash. {@code LogCapture} lives in the JVM that dies, so the one
 * message a modder most wants - why the game went down - is exactly the one no in-process capture
 * can hand back. Vanilla writes it to {@code <gameDir>/crash-reports/} on the way out, and that
 * file survives the JVM. This class reads it, and it does three things beyond reading:
 *
 * <ol>
 *   <li><b>Summarises</b> - the title, the exception line, the top frames of the head trace and of
 *   each cause, the crashing thread. Not the thread dump, not the system details: a report is
 *   200 to 2,000 lines and a tool reply is a turn's context.</li>
 *   <li><b>Attributes</b> each frame to the mod that loaded its class: the class resolves (without
 *   initialising) to its {@code ProtectionDomain}'s code-source location, and that location to a
 *   mod through {@link LoaderPlatform#loadedMods()}. Identical on Fabric and NeoForge, because it
 *   asks the JVM rather than parsing either loader's prose. A loader's own "Suspected Mods" section
 *   is carried as a secondary field when the report has one.</li>
 *   <li><b>Announces</b> - {@code ping.last_crash} names a report newer than the previous boot, so
 *   a session learns a crash happened without having to suspect it. "Previous boot" is a stamp
 *   file this class writes at init; without one (first boot on this toolkit) the newest report on
 *   record is named, dated, and the agent judges its age.</li>
 * </ol>
 *
 * <p>What attribution says when it cannot: a frame whose class no loaded jar provides is
 * {@code unresolved}, not guessed. That is the common case for a report written by ANOTHER project's
 * game in a shared directory, and for a class the crash itself was about (a
 * {@code NoClassDefFoundError} names a class that, by definition, did not load). The count of
 * unresolved frames sits beside the mod counts so the reader sees the gap rather than a clean-looking
 * table with a hole in it.
 */
public final class CrashReports {
    private CrashReports() {}

    /** Beside {@code mcptoolkit.properties}: the toolkit's config dir is the one dir it already owns. */
    static final String STAMP_FILE = "mcptoolkit-boot.stamp";

    private static final int MAX_FRAMES = 10;
    private static final int MAX_CAUSE_FRAMES = 4;
    private static final int MAX_CAUSES = 4;
    private static final int MAX_LISTED = 6;
    private static final int MAX_SUSPECTED = 12;

    private static final long THIS_BOOT = System.currentTimeMillis();
    /** Millis of the previous boot's stamp; {@code -1} while unread or when there was none. */
    private static volatile long previousBoot = -1;

    private static final Map<String, String> ATTRIBUTION = new ConcurrentHashMap<>();
    private static volatile @Nullable List<LoaderPlatform.LoadedMod> mods;

    // ---- boot stamp -----------------------------------------------------------------------------

    /**
     * Read the previous boot's stamp and write this boot's. Called once from {@link McpToolkit#init}
     * after the log ring is up; a failure is logged and costs only {@code last_crash}'s
     * "newer than the previous boot" bound, never the boot.
     */
    public static void stampBoot() {
        try {
            Path stamp = Platform.configDir().resolve(STAMP_FILE);
            if (Files.isRegularFile(stamp)) {
                try {
                    previousBoot = Long.parseLong(Files.readString(stamp, StandardCharsets.UTF_8).trim());
                } catch (NumberFormatException e) {
                    previousBoot = -1;
                }
            }
            Files.createDirectories(stamp.getParent());
            Files.writeString(stamp, Long.toString(THIS_BOOT), StandardCharsets.UTF_8);
        } catch (IOException | RuntimeException e) {
            McpToolkit.LOGGER.warn("[MCP Toolkit] could not write the boot stamp; ping.last_crash will "
                + "name the newest report regardless of age: {}", e.toString());
        }
    }

    // ---- the directory --------------------------------------------------------------------------

    public static Path dir() {
        return Platform.gameDir().resolve("crash-reports");
    }

    /** Every {@code crash-*.txt}, newest first by modification time, file name as the tiebreak. */
    public static List<Path> reports() {
        Path dir = dir();
        if (!Files.isDirectory(dir)) {
            return List.of();
        }
        List<Path> out = new ArrayList<>();
        try (var stream = Files.list(dir)) {
            stream.filter(p -> {
                String n = p.getFileName().toString();
                return n.startsWith("crash-") && n.endsWith(".txt") && Files.isRegularFile(p);
            }).forEach(out::add);
        } catch (IOException e) {
            return List.of();
        }
        out.sort(Comparator.comparingLong(CrashReports::modified).reversed()
            .thenComparing((Path p) -> p.getFileName().toString(), Comparator.reverseOrder()));
        return out;
    }

    private static long modified(final Path p) {
        try {
            return Files.getLastModifiedTime(p).toMillis();
        } catch (IOException e) {
            return 0L;
        }
    }

    // ---- ping.last_crash ------------------------------------------------------------------------

    /**
     * The newest report if it post-dates the previous boot (or if no previous boot is on record),
     * else null. {@code at} is the report's own {@code Time:} line - the crash's clock - and
     * {@code modified} the file's, which is what the "newer than" test uses, so a report copied into
     * the directory is announced by when it arrived rather than by what it says.
     */
    public static @Nullable JsonObject lastCrash() {
        List<Path> all = reports();
        if (all.isEmpty()) {
            return null;
        }
        Path newest = all.get(0);
        long mod = modified(newest);
        if (previousBoot >= 0 && mod <= previousBoot) {
            return null;
        }
        JsonObject r = new JsonObject();
        Header h = header(newest);
        r.addProperty("at", h.time != null ? h.time : Instant.ofEpochMilli(mod).toString());
        r.addProperty("path", newest.toAbsolutePath().toString());
        r.addProperty("title", h.title != null ? h.title : "(no Description line)");
        if (previousBoot < 0) {
            r.addProperty("note", "no previous boot on record, so this is simply the newest report");
        }
        r.addProperty("read", "get_log {crash: \"latest\"}");
        return r;
    }

    // ---- get_log {crash} ------------------------------------------------------------------------

    /**
     * Resolve the {@code crash} argument - {@code "latest"}, a 1-based index from the newest, or a
     * file name - and summarise that report. A miss is a refusal (thrown; the bridge answers
     * {@code ok:false}) that lists what exists.
     */
    public static JsonObject read(final JsonElement crash) {
        List<Path> all = reports();
        JsonObject r = new JsonObject();
        if (all.isEmpty()) {
            throw new IllegalArgumentException("no crash reports in " + dir().toAbsolutePath()
                + " - the game has not crashed in this directory, or the report went elsewhere");
        }
        Path chosen = null;
        String want = crash.isJsonPrimitive() && crash.getAsJsonPrimitive().isNumber()
            ? crash.getAsString() : crash.getAsString().trim();
        if (want.isEmpty() || want.equalsIgnoreCase("latest")) {
            chosen = all.get(0);
        } else if (want.matches("\\d+")) {
            int n = Integer.parseInt(want);
            if (n >= 1 && n <= all.size()) {
                chosen = all.get(n - 1);
            }
        } else {
            for (Path p : all) {
                if (p.getFileName().toString().equals(want)) {
                    chosen = p;
                    break;
                }
            }
        }
        if (chosen == null) {
            throw new IllegalArgumentException("no crash report matches " + want + " - `crash` is "
                + "\"latest\", an index from 1 (newest) to " + all.size() + ", or a file name; the "
                + "newest are " + names(all, 0, MAX_LISTED));
        }
        JsonObject report;
        try {
            report = summarize(chosen);
        } catch (IOException e) {
            throw new IllegalStateException("could not read " + chosen + ": " + e, e);
        }
        r.add("report", report);
        r.addProperty("reports", all.size());
        int idx = all.indexOf(chosen);
        if (idx > 0) {
            r.add("newer", names(all, 0, idx));
        }
        if (idx + 1 < all.size()) {
            r.add("older", names(all, idx + 1, idx + 1 + MAX_LISTED));
        }
        return r;
    }

    private static JsonArray names(final List<Path> all, final int from, final int toExclusive) {
        JsonArray a = new JsonArray();
        for (int i = from; i < Math.min(toExclusive, all.size()); i++) {
            a.add(all.get(i).getFileName().toString());
        }
        return a;
    }

    // ---- parsing --------------------------------------------------------------------------------

    private record Header(@Nullable String time, @Nullable String title) {}

    private static Header header(final Path p) {
        String time = null;
        String title = null;
        try {
            for (String line : Files.readAllLines(p, StandardCharsets.UTF_8)) {
                if (line.startsWith("Time: ")) {
                    time = line.substring(6).trim();
                } else if (line.startsWith("Description: ")) {
                    title = line.substring(13).trim();
                }
                if (time != null && title != null) {
                    break;
                }
                if (line.startsWith("-- ")) {
                    break;
                }
            }
        } catch (IOException e) {
            // a header that cannot be read is reported as absent
        }
        return new Header(time, title);
    }

    /** The whole summary for one report. Package-private so a unit test can hand it a fixture. */
    static JsonObject summarize(final Path p) throws IOException {
        List<String> lines = Files.readAllLines(p, StandardCharsets.UTF_8);
        JsonObject r = new JsonObject();
        r.addProperty("path", p.toAbsolutePath().toString());
        r.addProperty("modified", modified(p));

        String time = null;
        String title = null;
        String exception = null;
        String thread = null;
        List<String> headFrames = new ArrayList<>();
        List<Cause> causes = new ArrayList<>();
        List<String> suspected = new ArrayList<>();
        Map<String, Integer> attribution = new LinkedHashMap<>();

        // Phase 1: the header - up to the walkthrough separator. The exception line is the first
        // non-frame, non-blank line after Description; frames follow it; `Caused by:` opens a cause.
        int i = 0;
        List<String> currentFrames = headFrames;
        boolean inTrace = false;
        for (; i < lines.size(); i++) {
            String line = lines.get(i);
            if (line.startsWith("A detailed walkthrough")) {
                break;
            }
            if (line.startsWith("Time: ")) {
                time = line.substring(6).trim();
            } else if (line.startsWith("Description: ")) {
                title = line.substring(13).trim();
                inTrace = true;
            } else if (inTrace) {
                String t = line.strip();
                if (t.isEmpty()) {
                    continue;
                }
                if (t.startsWith("at ")) {
                    currentFrames.add(t.substring(3).trim());
                } else if (t.startsWith("Caused by: ")) {
                    currentFrames = new ArrayList<>();
                    causes.add(new Cause(t.substring(11).trim(), currentFrames));
                } else if (t.startsWith("...") || t.startsWith("Suppressed:")) {
                    continue;
                } else if (exception == null) {
                    exception = t;
                }
            }
        }

        // Phase 2: sections. `-- Head --` carries the thread; a "Suspected Mods" block, when a
        // loader writes one, is a list of indented lines until the next blank or section.
        for (; i < lines.size(); i++) {
            String line = lines.get(i);
            if (line.equals("-- Head --")) {
                for (int j = i + 1; j < lines.size() && !lines.get(j).startsWith("-- "); j++) {
                    String t = lines.get(j).strip();
                    if (t.startsWith("Thread: ")) {
                        thread = t.substring(8).trim();
                        break;
                    }
                }
            } else if (line.strip().toLowerCase(Locale.ROOT).replace("--", "").trim()
                .startsWith("suspected mods")) {
                for (int j = i + 1; j < lines.size() && suspected.size() < MAX_SUSPECTED; j++) {
                    String raw = lines.get(j);
                    String t = raw.strip();
                    if (t.isEmpty() || raw.startsWith("-- ") || (!raw.startsWith("\t") && !raw.startsWith(" "))) {
                        break;
                    }
                    suspected.add(t);
                }
            }
        }

        r.addProperty("at", time != null ? time : Instant.ofEpochMilli(modified(p)).toString());
        r.addProperty("title", title != null ? title : "(no Description line)");
        if (exception != null) {
            r.addProperty("exception", exception);
        }
        if (thread != null) {
            r.addProperty("thread", thread);
        }
        r.add("frames", frames(headFrames, MAX_FRAMES, attribution));
        if (headFrames.size() > MAX_FRAMES) {
            r.addProperty("frames_omitted", headFrames.size() - MAX_FRAMES);
        }
        if (!causes.isEmpty()) {
            JsonArray cs = new JsonArray();
            for (int c = 0; c < Math.min(MAX_CAUSES, causes.size()); c++) {
                Cause cause = causes.get(c);
                JsonObject o = new JsonObject();
                o.addProperty("exception", cause.exception());
                o.add("frames", frames(cause.frames(), MAX_CAUSE_FRAMES, attribution));
                cs.add(o);
            }
            r.add("causes", cs);
        }
        // The attribution table, and the first mod in it that is neither the game, the JDK, the
        // loader nor unresolved: the frame nearest the throw that belongs to somebody's mod.
        JsonObject att = new JsonObject();
        String suspect = null;
        for (Map.Entry<String, Integer> e : attribution.entrySet()) {
            att.addProperty(e.getKey(), e.getValue());
        }
        for (String frame : headFrames) {
            String who = attribute(classOf(frame));
            if (isSomebodysMod(who)) {
                suspect = who;
                break;
            }
        }
        if (suspect == null) {
            for (Cause cause : causes) {
                for (String frame : cause.frames()) {
                    String who = attribute(classOf(frame));
                    if (isSomebodysMod(who)) {
                        suspect = who;
                        break;
                    }
                }
                if (suspect != null) {
                    break;
                }
            }
        }
        r.add("attribution", att);
        if (suspect != null) {
            r.addProperty("suspect", suspect);
        }
        boolean anyUnclaimed = attribution.keySet().stream().anyMatch(k -> k.startsWith("?"));
        if (anyUnclaimed && !UNMATCHED.isEmpty()) {
            JsonArray u = new JsonArray();
            UNMATCHED.forEach(u::add);
            r.add("unclaimed_locations", u);
        }
        if (attribution.containsKey("unresolved")) {
            r.addProperty("unresolved_means", "no jar THIS game loaded provides that class - the "
                + "report may be another project's, or the class is the one the crash is about");
        }
        if (!suspected.isEmpty()) {
            JsonArray s = new JsonArray();
            suspected.forEach(s::add);
            r.add("loader_suspected_mods", s);
        }
        return r;
    }

    private record Cause(String exception, List<String> frames) {}

    private static boolean isSomebodysMod(final String who) {
        return !(who.equals("minecraft") || who.equals("java") || who.equals("unresolved")
            || who.equals("fabricloader") || who.equals("neoforge") || who.equals("fml")
            || who.startsWith("?"));
    }

    private static JsonArray frames(final List<String> raw, final int max,
                                    final Map<String, Integer> attribution) {
        JsonArray out = new JsonArray();
        for (int i = 0; i < Math.min(max, raw.size()); i++) {
            String frame = raw.get(i);
            String who = attribute(classOf(frame));
            attribution.merge(who, 1, Integer::sum);
            JsonObject f = new JsonObject();
            f.addProperty("at", stripLoaderPrefix(frame));
            f.addProperty("mod", who);
            out.add(f);
        }
        return out;
    }

    /**
     * {@code knot//com.x.Y.m(Y.java:12)}, {@code java.base/java.lang.Thread.run(Thread.java:1474)},
     * {@code platform/jdk.httpserver@25.0.3/sun.net...} - everything before the last {@code /}
     * ahead of the parenthesis is a loader or module prefix.
     */
    static String stripLoaderPrefix(final String frame) {
        int paren = frame.indexOf('(');
        String head = paren < 0 ? frame : frame.substring(0, paren);
        int slash = head.lastIndexOf('/');
        return slash < 0 ? frame : frame.substring(slash + 1);
    }

    /** The binary class name of a frame, or the whole frame when it is not one. */
    static String classOf(final String frame) {
        String f = stripLoaderPrefix(frame);
        int paren = f.indexOf('(');
        String method = paren < 0 ? f : f.substring(0, paren);
        int dot = method.lastIndexOf('.');
        return dot < 0 ? method : method.substring(0, dot);
    }

    // ---- attribution ----------------------------------------------------------------------------

    /**
     * The mod id whose origin loaded {@code className}; {@code "java"} for the platform;
     * {@code "?:<file>"} for a code source no mod claims; {@code "unresolved"} when this JVM cannot
     * load a class by that name at all. Cached per class for the life of the process.
     */
    static String attribute(final String className) {
        return ATTRIBUTION.computeIfAbsent(className, CrashReports::attributeUncached);
    }

    private static String attributeUncached(final String className) {
        if (className.startsWith("java.") || className.startsWith("javax.")
            || className.startsWith("jdk.") || className.startsWith("sun.")
            || className.startsWith("com.sun.")) {
            return "java";
        }
        URL location;
        try {
            Class<?> c = Class.forName(className, false, CrashReports.class.getClassLoader());
            if (c.getModule() != null && c.getModule().isNamed()
                && c.getModule().getLayer() == ModuleLayer.boot()) {
                return "java";
            }
            CodeSource cs = c.getProtectionDomain().getCodeSource();
            location = cs == null ? null : cs.getLocation();
        } catch (Throwable t) {
            // ClassNotFoundException, NoClassDefFoundError, LinkageError, SecurityException: all
            // mean the same thing to the reader - this game cannot say where that class lives.
            return "unresolved";
        }
        if (location == null) {
            return fallback(className, null);
        }
        Path loc;
        try {
            String s = location.toString();
            if (s.startsWith("jar:")) {
                s = s.substring(4);
                int bang = s.indexOf("!/");
                if (bang >= 0) {
                    s = s.substring(0, bang);
                }
                location = new URL(s);
            }
            loc = Path.of(location.toURI()).toAbsolutePath().normalize();
        } catch (Exception e) {
            return fallback(className, location.toString());
        }
        String owner = ownerOf(loc);
        if (owner == null) {
            // Gradle's layout: a dev run loads classes from build/classes/<lang>/<set>, while the
            // loader found the mod by its fabric.mod.json in the sibling build/resources/<set> and
            // may list only that. The two are one source set; ask again by the sibling.
            Path sibling = resourcesSibling(loc);
            if (sibling != null) {
                owner = ownerOf(sibling);
            }
        }
        if (owner != null) {
            return owner;
        }
        UNMATCHED.add(loc.toString());
        return fallback(className, loc.getFileName() == null ? loc.toString() : loc.getFileName().toString());
    }

    private static @Nullable String ownerOf(final Path loc) {
        for (LoaderPlatform.LoadedMod mod : loadedMods()) {
            for (Path origin : mod.origins()) {
                Path o = origin.toAbsolutePath().normalize();
                if (loc.equals(o) || loc.startsWith(o)) {
                    return mod.modId();
                }
            }
        }
        return null;
    }

    /** {@code .../build/classes/java/main} to {@code .../build/resources/main}, else null. */
    static @Nullable Path resourcesSibling(final Path loc) {
        int n = loc.getNameCount();
        if (n < 4) {
            return null;
        }
        // <build>/classes/<lang>/<set>
        if (!loc.getName(n - 3).toString().equals("classes")) {
            return null;
        }
        Path build = loc.getParent().getParent().getParent();
        return build.resolve("resources").resolve(loc.getName(n - 1).toString());
    }

    /** Code-source locations no loaded mod claimed, reported beside the table so a `?:` is traceable. */
    private static final java.util.Set<String> UNMATCHED = java.util.concurrent.ConcurrentHashMap.newKeySet();

    private static String fallback(final String className, final @Nullable String where) {
        if (className.startsWith("net.minecraft.") || className.startsWith("com.mojang.")) {
            return "minecraft";
        }
        if (className.startsWith("net.fabricmc.loader.")) {
            return "fabricloader";
        }
        if (className.startsWith("net.neoforged.fml.") || className.startsWith("cpw.mods.")) {
            return "fml";
        }
        return where == null ? "?" : "?:" + where;
    }

    private static List<LoaderPlatform.LoadedMod> loadedMods() {
        List<LoaderPlatform.LoadedMod> m = mods;
        if (m == null) {
            try {
                m = Platform.loadedMods();
            } catch (RuntimeException e) {
                McpToolkit.LOGGER.warn("[MCP Toolkit] the loader's mod list is unavailable for crash "
                    + "attribution: {}", e.toString());
                m = List.of();
            }
            mods = m;
            if (McpToolkit.LOGGER.isDebugEnabled()) {
                StringBuilder sb = new StringBuilder();
                for (LoaderPlatform.LoadedMod mod : m) {
                    sb.append("\n  ").append(mod.modId()).append(" <- ").append(mod.origins());
                }
                McpToolkit.LOGGER.debug("[MCP Toolkit] crash attribution origins:{}", sb);
            }
        }
        return m;
    }
}
