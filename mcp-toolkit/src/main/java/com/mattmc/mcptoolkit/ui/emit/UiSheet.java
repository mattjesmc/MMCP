package com.mattmc.mcptoolkit.ui.emit;

import com.mattmc.mcptoolkit.ui.Palette;
import com.mattmc.mcptoolkit.ui.doc.Element;
import com.mattmc.mcptoolkit.ui.doc.Kind;
import com.mattmc.mcptoolkit.ui.doc.SlotPlan;
import com.mattmc.mcptoolkit.ui.doc.UiDocument;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.zip.CRC32;
import java.util.zip.Deflater;

/**
 * <b>The background sheet, painted from the document's own boxes</b> (UI_PARTS_LIBRARY_DESIGN.md
 * section 3.6).
 *
 * <p>The finding this answers came from outside the design, in a mod written without knowledge of
 * it: {@code ArmorPieces} generates its GUI sheet with a Python script whose header says the layout
 * constants "are the ones {@code AdvancedSmithingMenu} and {@code AdvancedSmithingScreen} read, and
 * moving a slot means moving a number in both places and running this again." Three copies of one
 * number, and nothing checks that the three agree. Here the sheet falls out of the same parse as the
 * two Java files, so there is one place that says where a well is.
 *
 * <p><b>What it paints, and what it does not.</b> The decorative layer: the screen frame, every
 * {@code panel} and {@code well}, and an 18x18 seat under every slot the {@link SlotPlan} places.
 * Not labels (they are text, drawn live and translated), not items, not bars (they move). The
 * bevels are {@link Palette}'s and the same arithmetic {@code Paint} uses, which is why a sheet
 * generated from a document and the same document drawn live look the same.
 *
 * <p><b>The slot seat is an approximation and says so.</b> Vanilla's own slot background is a GUI
 * <i>atlas sprite</i> ({@code minecraft:container/slot}), and an atlas is not on this classpath -
 * the emitter runs from a Gradle task with no game (section 7.1). What is drawn here is the same
 * recessed bevel by hand. It is what a mod would have hand-painted anyway; a screen that wants
 * vanilla's exact pixels leaves its slots to the live renderer, which is the default.
 *
 * <p>The PNG encoder is 60 lines of {@code java.util.zip} rather than {@code javax.imageio}: it
 * keeps the emitter's dependency footprint at "the JDK's base module and Gson", and it is
 * deterministic, which a generated file that a build compares byte for byte has to be.
 */
public final class UiSheet {
    private UiSheet() {}

    /** The pixel pitch of a slot, and the size of the seat drawn under one. */
    private static final int SLOT = 18;

    /**
     * The sheet's bytes for a document that declares one.
     *
     * @return the PNG, or {@code null} when the document declares no {@code sheet}
     */
    public static byte[] render(final UiDocument doc) {
        UiDocument.Sheet sheet = doc.sheet();
        if (sheet == null) {
            return null;
        }
        int w = Math.max(1, sheet.width());
        int h = Math.max(1, sheet.height());
        int[] px = new int[w * h];
        // Transparent, not grey: a sheet is blitted onto whatever is behind it, and a document may
        // well cover only part of its own texture.
        for (Element e : doc.flatten()) {
            if (!(e instanceof Element.Box b) || !(e.placement() instanceof Element.Placement.Absolute at)) {
                continue;
            }
            switch (b.kind()) {
                case FRAME -> screenFrame(px, w, h, at.x(), at.y(), b.w(), b.h());
                case PANEL -> panel(px, w, h, at.x(), at.y(), b.w(), b.h());
                case WELL -> well(px, w, h, at.x(), at.y(), b.w(), b.h());
                default -> throw new IllegalStateException("not a box kind: " + b.kind());
            }
        }
        for (SlotPlan.Entry s : SlotPlan.of(doc).entries()) {
            slotSeat(px, w, h, s.x() - 1, s.y() - 1);
        }
        return png(px, w, h);
    }

    /** Where the sheet goes, relative to a resources root: {@code assets/<ns>/<path>}. */
    public static String path(final UiDocument.Sheet sheet) {
        String id = sheet.texture();
        int colon = id.indexOf(':');
        return "assets/" + id.substring(0, colon) + "/" + id.substring(colon + 1);
    }

    // ---------------------------------------------------------------------------------------------
    // The bevels. Deliberately the same order of fills Paint uses, corners and all.

    private static void panel(final int[] px, final int w, final int h, final int x, final int y,
                              final int bw, final int bh) {
        fill(px, w, h, x, y, x + bw, y + bh, Palette.PANEL_BG);
        fill(px, w, h, x, y, x + bw, y + 1, Palette.PANEL_EDGE_LIGHT);
        fill(px, w, h, x, y, x + 1, y + bh, Palette.PANEL_EDGE_LIGHT);
        fill(px, w, h, x, y + bh - 1, x + bw, y + bh, Palette.PANEL_EDGE_DARK);
        fill(px, w, h, x + bw - 1, y, x + bw, y + bh, Palette.PANEL_EDGE_DARK);
    }

    private static void well(final int[] px, final int w, final int h, final int x, final int y,
                             final int bw, final int bh) {
        fill(px, w, h, x, y, x + bw, y + bh, Palette.WELL_BG);
        fill(px, w, h, x, y, x + bw, y + 1, Palette.PANEL_EDGE_DARK);
        fill(px, w, h, x, y, x + 1, y + bh, Palette.PANEL_EDGE_DARK);
    }

    private static void screenFrame(final int[] px, final int w, final int h, final int x, final int y,
                                    final int bw, final int bh) {
        fill(px, w, h, x, y, x + bw, y + bh, Palette.SCREEN_FRAME);
        fill(px, w, h, x + 1, y + 1, x + bw - 1, y + bh - 1, Palette.PANEL_BG);
    }

    /** The 18x18 seat under a slot: a well with the highlight vanilla's own sprite carries. */
    private static void slotSeat(final int[] px, final int w, final int h, final int x, final int y) {
        well(px, w, h, x, y, SLOT, SLOT);
        fill(px, w, h, x + 1, y + SLOT - 1, x + SLOT, y + SLOT, Palette.PANEL_EDGE_LIGHT);
        fill(px, w, h, x + SLOT - 1, y + 1, x + SLOT, y + SLOT, Palette.PANEL_EDGE_LIGHT);
    }

    private static void fill(final int[] px, final int w, final int h, final int x0, final int y0,
                             final int x1, final int y1, final int argb) {
        for (int y = Math.max(0, y0); y < Math.min(h, y1); y++) {
            for (int x = Math.max(0, x0); x < Math.min(w, x1); x++) {
                px[y * w + x] = argb;
            }
        }
    }

    // ---------------------------------------------------------------------------------------------
    // A minimal PNG writer: 8-bit RGBA, non-interlaced, one IDAT, filter 0 per scanline.

    static byte[] png(final int[] argb, final int w, final int h) {
        byte[] raw = new byte[h * (1 + w * 4)];
        int at = 0;
        for (int y = 0; y < h; y++) {
            raw[at++] = 0; // filter: none. A generated file must be byte-stable, not small.
            for (int x = 0; x < w; x++) {
                int c = argb[y * w + x];
                raw[at++] = (byte) (c >> 16);
                raw[at++] = (byte) (c >> 8);
                raw[at++] = (byte) c;
                raw[at++] = (byte) (c >>> 24);
            }
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try {
            out.write(new byte[] {(byte) 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A});
            ByteArrayOutputStream ihdr = new ByteArrayOutputStream();
            writeInt(ihdr, w);
            writeInt(ihdr, h);
            ihdr.write(8);  // bit depth
            ihdr.write(6);  // colour type: RGBA
            ihdr.write(0);  // deflate
            ihdr.write(0);  // adaptive filtering
            ihdr.write(0);  // no interlace
            chunk(out, "IHDR", ihdr.toByteArray());
            chunk(out, "IDAT", deflate(raw));
            chunk(out, "IEND", new byte[0]);
        } catch (IOException e) {
            throw new IllegalStateException("a ByteArrayOutputStream cannot fail", e);
        }
        return out.toByteArray();
    }

    private static byte[] deflate(final byte[] data) {
        // A fixed level, because the bytes land in a repository and a build compares them: the same
        // document must produce the same file on every JDK this ever runs on.
        Deflater deflater = new Deflater(Deflater.DEFAULT_COMPRESSION);
        try {
            deflater.setInput(data);
            deflater.finish();
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            while (!deflater.finished()) {
                out.write(buf, 0, deflater.deflate(buf));
            }
            return out.toByteArray();
        } finally {
            deflater.end();
        }
    }

    private static void chunk(final ByteArrayOutputStream out, final String type, final byte[] data)
        throws IOException {
        writeInt(out, data.length);
        byte[] name = type.getBytes(java.nio.charset.StandardCharsets.US_ASCII);
        out.write(name);
        out.write(data);
        CRC32 crc = new CRC32();
        crc.update(name);
        crc.update(data);
        writeInt(out, (int) crc.getValue());
    }

    private static void writeInt(final ByteArrayOutputStream out, final int v) {
        out.write(v >>> 24);
        out.write(v >>> 16);
        out.write(v >>> 8);
        out.write(v);
    }

    /** Only used by the check above; kept so the class reads as a whole. */
    static boolean paints(final Kind kind) {
        return kind.family() == Kind.Family.BOX;
    }
}
