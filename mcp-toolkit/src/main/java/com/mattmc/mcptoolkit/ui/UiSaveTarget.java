package com.mattmc.mcptoolkit.ui;

import com.mattmc.mcptoolkit.platform.Platform;
import net.minecraft.resources.Identifier;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * Where a save goes - which is a harder question than it looks, and getting it wrong loses the
 * human's work in one of two ways.
 *
 * <p>Shared by both writers of a document: the in-game editor's Ctrl+S (slice 4) and
 * {@code ui_doc}'s mutations (slice 5), so "the source tree is the truth" is one rule with one
 * implementation rather than an agreement between two.
 *
 * <p><b>Trap 1: the file the game reads is not the file the repository keeps.</b> A document opened
 * as {@code mcptoolkit:example} comes through the resource manager, and in a dev run that resource
 * lives in {@code build/resources/main} - a copy Gradle overwrites from {@code src/main/resources}
 * on the next build. An editor that saves there has saved nothing durable, and says "saved".
 *
 * <p><b>Trap 2: the file the repository keeps is not the file the game reads.</b> Save only into
 * {@code src/main/resources} and the running game still has the old bytes, so the next
 * {@code init()} - a window resize is enough - re-reads the stale copy and the edit disappears on
 * screen. That is SCREEN_AUTHORING_DESIGN.md section 1's "a live tweak evaporates on the next
 * init()" objection, coming back one level lower down than where it was answered.
 *
 * <p>So a save has <b>two destinations</b>: {@link Target#file()}, the source tree, which is the
 * truth and what git sees; and {@link Target#mirror()}, the loaded pack's copy, so the running game
 * agrees with the file immediately. Both are reported, and a target that resolves ONLY to a build
 * directory is refused by name rather than written.
 */
public final class UiSaveTarget {
    private UiSaveTarget() {}

    /**
     * @param file   the durable file: the source tree when one was found, else the only file there is
     * @param mirror the loaded resource pack's copy to keep in step, or {@code null} when
     *               {@link #file} IS the file the game reads
     * @param how    one sentence naming the rule that resolved it, for the tool reply
     */
    public record Target(Path file, Path mirror, String how) {}

    /** Build-output roots, and the source root each one is a copy of. Ordered: longest match first. */
    private static final String[][] BUILD_TWINS = {
        {"build/resources/main", "src/main/resources"},
        {"build/resources/client", "src/client/resources"},
        {"build/processedResources/main", "src/main/resources"},
        {"out/production/resources", "src/main/resources"},
        {"bin/main", "src/main/resources"},
    };

    /**
     * A document addressed as a file: that path IS the document, and whoever reads it reads it
     * directly - there is no pack copy to keep in step.
     */
    public static Target resolveFile(final Path path) {
        return new Target(path, null, "the file the document was opened from");
    }

    /** A document addressed as {@code <mod>:<screen>}, resolved through the mod's own roots. */
    public static Target resolve(final Identifier id) throws IOException {
        String relative = "assets/" + id.getNamespace() + "/ui/" + id.getPath() + ".ui.json";
        List<String> tried = new ArrayList<>();
        for (Path root : Platform.modRoots(id.getNamespace())) {
            Path candidate;
            try {
                candidate = root.resolve(relative);
            } catch (RuntimeException e) {
                tried.add(root + " (not a resolvable root: " + e.getMessage() + ")");
                continue;
            }
            if (candidate.getFileSystem() != java.nio.file.FileSystems.getDefault()) {
                // A jar. Nothing to edit: the mod is a build artefact, not a checkout.
                tried.add(candidate + " (inside a jar - there is no source tree to write to)");
                continue;
            }
            if (!Files.isRegularFile(candidate)) {
                tried.add(candidate + " (no such file)");
                continue;
            }
            Path twin = sourceTwin(candidate);
            if (twin != null && Files.isRegularFile(twin)) {
                return new Target(twin, candidate,
                    "the source tree behind the loaded pack, mirrored into the pack so the running game agrees");
            }
            if (underBuildOutput(candidate)) {
                throw new IOException("the only copy of " + relative + " is a build output (" + candidate
                    + ") and its source twin " + (twin == null ? "could not be derived" : twin + " does not exist")
                    + ". Saving there would be overwritten by the next build, so nothing was written."
                    + " Open the document with ui_file to edit a path directly.");
            }
            return new Target(candidate, null, "the mod's resource root, which is not a build output");
        }
        throw new IOException("cannot find a writable " + relative + " for mod '" + id.getNamespace()
            + "'. Tried: " + (tried.isEmpty() ? "no roots at all - is that mod loaded?" : String.join("; ", tried)));
    }

    /**
     * The document text with the line endings the file on disk already uses.
     *
     * <p><b>Found on this slice's first Windows save, and it is exactly the failure the format's
     * canonical form exists to prevent.</b> {@code UiWriter} emits LF; a checkout with
     * {@code core.autocrlf=true} leaves CRLF in the working tree. Writing LF over it changes every
     * line of the file, so {@code git status} reports it modified while {@code git diff} prints
     * NOTHING (the diff normalises what the status compares) - the most confusing shape a diff can
     * have, and the opposite of "an editor save is a minimal diff".
     */
    static String asFileHasIt(final Path file, final String json) {
        try {
            String current = Files.readString(file, java.nio.charset.StandardCharsets.UTF_8);
            if (current.contains("\r\n")) {
                return json.replace("\n", "\r\n");
            }
        } catch (IOException e) {
            // A file that is not there yet gets the canonical LF, which is what the repo holds.
        }
        return json;
    }

    /** {@code .../build/resources/main/assets/x} to {@code .../src/main/resources/assets/x}. */
    static Path sourceTwin(final Path candidate) {
        String s = candidate.toAbsolutePath().toString().replace('\\', '/');
        for (String[] twin : BUILD_TWINS) {
            int at = s.lastIndexOf(twin[0]);
            if (at >= 0) {
                return Path.of(s.substring(0, at) + twin[1] + s.substring(at + twin[0].length()));
            }
        }
        return null;
    }

    /** Any {@code build}/{@code out}/{@code bin} directory on the way down. */
    static boolean underBuildOutput(final Path candidate) {
        for (Path part : candidate.toAbsolutePath()) {
            String name = part.toString();
            if (name.equals("build") || name.equals("out") || name.equals("bin")) {
                return true;
            }
        }
        return false;
    }

    /**
     * Write the document text to both destinations. The source tree first: if the mirror fails, the
     * durable copy is still on disk and the message says the running game is behind.
     *
     * @return one sentence naming what was written where
     */
    public static String write(final Target target, final String json) throws IOException {
        Files.createDirectories(target.file().toAbsolutePath().getParent());
        Files.writeString(target.file(), asFileHasIt(target.file(), json), java.nio.charset.StandardCharsets.UTF_8);
        if (target.mirror() == null) {
            return "saved " + target.file();
        }
        try {
            Files.writeString(target.mirror(), asFileHasIt(target.mirror(), json),
                java.nio.charset.StandardCharsets.UTF_8);
        } catch (IOException e) {
            return "saved " + target.file() + ", but the loaded pack copy (" + target.mirror()
                + ") could not be updated: " + e.getMessage()
                + " - the preview will show the OLD file if it re-reads before the next build";
        }
        return "saved " + target.file() + " (and mirrored into the loaded pack)";
    }
}
