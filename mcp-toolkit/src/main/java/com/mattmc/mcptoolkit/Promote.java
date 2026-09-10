package com.mattmc.mcptoolkit;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Arrays;
import java.util.List;

/**
 * Promotion - live pack to mod source (RELEASE_1.md section D9), shared by {@code clear_assets} (the
 * client's resource pack) and {@code clear_data} (the server's world datapack).
 *
 * <p><b>Why it is an argument of CLEAR and not a verb of its own.</b> {@code LIVE_MODDING.md} has
 * documented promotion as three manual steps for as long as it has existed, and calls forgetting
 * step 2 - clearing the override so it stops shadowing the copy you just made - "the classic way to
 * spend an hour debugging a texture that changed long ago". A separate {@code promote_asset} would
 * leave that step exactly as forgettable as it is today, and cost a manifest entry per pack for the
 * privilege. Riding it on the clear makes the forgettable step the one you cannot skip: the copy
 * happens because you asked for the delete.
 *
 * <p><b>The destination is never defaulted.</b> A game does not know where a mod's checkout is, and
 * the failure mode of guessing is a file written into a directory nobody is looking at - the exact
 * trap {@code mcptoolkit_sync.js} already refuses by the name of its {@code sourceRoot} setting
 * (LIVE_MODDING.md, "target:'source' has no default destination"). So the root must be named, must
 * already exist, and must look like a resources root; a tree is never created to hold a promotion.
 *
 * <p><b>The copy happens before any delete.</b> A half-promotion that has already removed the
 * override is the one state worse than not promoting at all: the bytes are gone from the pack and
 * were never written anywhere else. Everything is copied first, and a failure anywhere leaves the
 * pack untouched.
 */
public final class Promote {
    private Promote() {}

    /** What makes a directory recognisable as a mod's {@code src/main/resources}. */
    private static final List<String> MARKERS = List.of("fabric.mod.json", "META-INF", "assets", "data");

    /**
     * Validate a caller-supplied destination root. Refuses rather than creating anything - see the
     * class note on why a promotion with nowhere to go must not invent somewhere.
     */
    public static Path destination(final String raw) {
        Path dest = Path.of(raw).normalize();
        if (!Files.exists(dest)) {
            throw new IllegalArgumentException("no such directory: " + dest
                + " - `promote` takes a mod's EXISTING resources root (src/main/resources); "
                + "nothing is created to hold a promotion");
        }
        if (!Files.isDirectory(dest)) {
            throw new IllegalArgumentException("not a directory: " + dest);
        }
        boolean looksRight = MARKERS.stream().anyMatch(m -> Files.exists(dest.resolve(m)));
        if (!looksRight) {
            throw new IllegalArgumentException(dest + " does not look like a mod resources root - "
                + "expected one of " + MARKERS + " inside it. Point `promote` at src/main/resources.");
        }
        return dest;
    }

    /**
     * The files a {@code path} argument names inside a pack: one file, or every file under a
     * directory (so {@code assets/mymod} promotes a whole namespace and {@code assets} promotes the
     * lot). Deepest-last, sorted, so a caller reading the reply sees them in the order they appear
     * in a listing.
     *
     * @param what the noun for the refusal message ("asset" / "entry"), so it reads like the tool
     *             the caller actually called.
     */
    public static List<Path> resolve(final Path packRoot, final String rel, final String what) {
        Path target = packRoot.resolve(rel).normalize();
        if (!target.startsWith(packRoot)) {
            throw new IllegalArgumentException("path escapes the pack root: " + rel);
        }
        if (Files.isRegularFile(target)) {
            return List.of(target);
        }
        if (Files.isDirectory(target)) {
            try (var walk = Files.walk(target)) {
                List<Path> files = walk.filter(Files::isRegularFile).sorted().toList();
                if (files.isEmpty()) {
                    throw new IllegalArgumentException("no files under " + rel + " in the live pack");
                }
                return files;
            } catch (IOException e) {
                throw new RuntimeException("could not walk " + rel + ": " + e, e);
            }
        }
        throw new IllegalArgumentException("no such " + what + " in the live pack: " + rel);
    }

    /**
     * Copy each file into {@code dest} at its pack-relative path and report what happened to it.
     * {@code unchanged} is the interesting one: it says the source tree already had these exact
     * bytes, which is the difference between "you just promoted this" and "you promoted this an
     * hour ago and have been editing a copy of it since".
     */
    public static JsonArray copy(final Path packRoot, final List<Path> files, final Path dest) {
        JsonArray out = new JsonArray();
        try {
            for (Path f : files) {
                String rel = packRoot.relativize(f).toString().replace('\\', '/');
                Path to = dest.resolve(rel).normalize();
                if (!to.startsWith(dest)) {
                    throw new IllegalArgumentException("promotion target escapes the destination: " + rel);
                }
                boolean existed = Files.isRegularFile(to);
                boolean unchanged = existed && Arrays.equals(Files.readAllBytes(to), Files.readAllBytes(f));
                Files.createDirectories(to.getParent());
                Files.copy(f, to, StandardCopyOption.REPLACE_EXISTING);
                JsonObject o = new JsonObject();
                o.addProperty("path", rel);
                o.addProperty("to", to.toString());
                o.addProperty("bytes", Files.size(to));
                o.addProperty("overwrote", existed);
                if (unchanged) {
                    o.addProperty("unchanged", true);
                }
                out.add(o);
            }
        } catch (IOException e) {
            throw new RuntimeException("promotion failed (nothing was cleared): " + e, e);
        }
        return out;
    }

    /**
     * The sentence a promotion has to end with. The override is gone the moment this call returns,
     * so what the game shows from here on is what the JAR has - the promoted file only reaches it
     * on the next build. Saying so is the difference between "my change vanished" and "my change is
     * one rebuild away".
     */
    public static String note(final Path dest) {
        return "copied into " + dest + " and the live override is gone: the game now shows what the "
            + "BUILT mod has, and the promoted file reaches it on the next build";
    }
}
