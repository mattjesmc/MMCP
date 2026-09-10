package com.mattmc.mcptoolkit.ui.emit;

import java.nio.charset.StandardCharsets;

/**
 * One emitted file.
 *
 * <p>Almost always Java source; a document that declares a {@code sheet}
 * (UI_PARTS_LIBRARY_DESIGN.md section 3.6) also emits a PNG, which is why this carries BYTES and
 * offers the text as a view of them rather than the other way round.
 *
 * @param path  relative to the root of its {@link Side}, e.g. {@code com/x/menu/RocketMenuBase.java}
 *              or {@code assets/mymod/textures/gui/station.png}
 * @param side  which root it belongs under
 * @param owner machine files are overwritten on every generation; a human stub is written once
 * @param bytes the file's content; UTF-8 with LF line endings for source
 */
public record GeneratedFile(String path, Side side, Owner owner, byte[] bytes) {

    /** Common code, client-only code, or the mod's resources. */
    public enum Side { COMMON, CLIENT, RESOURCES }

    /** SCREEN_AUTHORING_DESIGN.md section 7: the base is the machine's, the subclass is the human's. */
    public enum Owner { MACHINE, HUMAN_STUB }

    /** A source file. */
    public static GeneratedFile source(final String path, final Side side, final Owner owner, final String content) {
        return new GeneratedFile(path, side, owner, content.getBytes(StandardCharsets.UTF_8));
    }

    /** A generated asset - written as bytes, compared as bytes, never line-ending-normalised. */
    public static GeneratedFile binary(final String path, final Side side, final byte[] bytes) {
        return new GeneratedFile(path, side, Owner.MACHINE, bytes);
    }

    public boolean isMachine() {
        return owner == Owner.MACHINE;
    }

    /** True for anything that is not Java source: compared byte for byte, never normalised. */
    public boolean isBinary() {
        return !path.endsWith(".java");
    }

    /** The content as text. Meaningless for a {@link #isBinary()} file, and nothing asks it for one. */
    public String content() {
        return new String(bytes, StandardCharsets.UTF_8);
    }
}
