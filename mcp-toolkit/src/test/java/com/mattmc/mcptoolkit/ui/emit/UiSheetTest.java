package com.mattmc.mcptoolkit.ui.emit;

import com.mattmc.mcptoolkit.ui.Palette;
import com.mattmc.mcptoolkit.ui.doc.UiDocument;
import com.mattmc.mcptoolkit.ui.doc.UiParser;
import org.junit.jupiter.api.Test;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.zip.Inflater;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * <b>The generated background sheet</b> (UI_PARTS_LIBRARY_DESIGN.md section 3.6).
 *
 * <p>The finding it answers came from a mod written without knowledge of this design: {@code
 * ArmorPieces} generates its GUI sheet from the layout constants with a Python script, so those
 * numbers exist THREE times - in the menu, in the screen, and in the generator - and nothing checks
 * that the three agree. Here the sheet falls out of the same parse as the two Java files.
 *
 * <p>Three things are checked, and the third is the one that bites: the file is a PNG a decoder can
 * read, the pixels come from the document's own boxes, and the bytes are <b>deterministic</b> -
 * because a generated file lands in a repository and {@code checkUi} compares it byte for byte, so a
 * compressor that varied by JDK would report drift on a document nobody touched.
 */
class UiSheetTest {
    private static final String EXAMPLE = "/assets/mcptoolkit/ui/example.ui.json";

    private static UiDocument example() throws Exception {
        try (InputStream in = UiSheetTest.class.getResourceAsStream(EXAMPLE)) {
            assertNotNull(in);
            return UiParser.parse(new String(in.readAllBytes(), StandardCharsets.UTF_8));
        }
    }

    @Test
    void theSheetIsAPngPaintedFromTheDocumentsOwnBoxes() throws Exception {
        UiDocument doc = example();
        assertNotNull(doc.sheet(), "the example declares a sheet, so this path ships exercised");
        Png png = Png.decode(UiSheet.render(doc));
        assertEquals(doc.width(), png.width);
        assertEquals(doc.height(), png.height);

        // The frame: a dark border with the container grey inset by one pixel, exactly as Paint draws
        // it live. That equality is the whole claim - the sheet and the screen are one set of numbers.
        assertEquals(Palette.SCREEN_FRAME, png.at(0, 0), "the frame's own edge");
        assertEquals(Palette.PANEL_BG, png.at(1, 1), "and the panel grey inside it");
        // The 'smelting' well at 8,18: its top-left is the recessed dark edge, its body the well grey.
        assertEquals(Palette.PANEL_EDGE_DARK, png.at(8, 18));
        assertEquals(Palette.WELL_BG, png.at(10, 20));
        // A slot seat under the fuel slot, which the document places at 14,36 (its well at 13,35).
        assertEquals(Palette.PANEL_EDGE_DARK, png.at(13, 35));
        assertEquals(Palette.WELL_BG, png.at(20, 40));
    }

    @Test
    void theBytesAreTheSameEveryRun() throws Exception {
        UiDocument doc = example();
        assertArrayEquals(UiSheet.render(doc), UiSheet.render(doc),
            "a generated file a build compares byte for byte cannot vary between two calls");
    }

    @Test
    void theCheckedInSheetIsWhatTheDocumentSaysToday() throws Exception {
        UiDocument doc = example();
        Path on = Path.of("src/main/resources").resolve(UiSheet.path(doc.sheet()));
        assertTrue(Files.isRegularFile(on), "the toolkit ships its own generated sheet: " + on);
        assertArrayEquals(UiSheet.render(doc), Files.readAllBytes(on),
            "regenerate the sample: gradlew :generateUi (or the UiGenerate main)");
    }

    @Test
    void aDocumentWithoutASheetEmitsNone() throws Exception {
        UiDocument bare = UiParser.parse("{\"format\":1,\"title\":\"t\",\"width\":8,\"height\":8,\"elements\":[]}");
        assertNull(bare.sheet());
        assertNull(UiSheet.render(bare));
        assertFalse(UiEmitter.emit(bare, new EmitRequest("demo", "com.example.demo", "bare", Target.FABRIC))
            .files().stream().anyMatch(GeneratedFile::isBinary));
    }

    // ---------------------------------------------------------------------------------------------

    /** Enough of a PNG reader to check what was written: 8-bit RGBA, one IDAT, filter 0 per row. */
    private record Png(int width, int height, byte[] rgba) {
        int at(final int x, final int y) {
            int i = (y * width + x) * 4;
            return (rgba[i + 3] & 0xFF) << 24 | (rgba[i] & 0xFF) << 16 | (rgba[i + 1] & 0xFF) << 8
                | (rgba[i + 2] & 0xFF);
        }

        static Png decode(final byte[] bytes) throws Exception {
            assertArrayEquals(new byte[] {(byte) 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A},
                Arrays.copyOf(bytes, 8), "the PNG signature");
            int pos = 8;
            int w = 0;
            int h = 0;
            byte[] idat = new byte[0];
            while (pos < bytes.length) {
                int len = int32(bytes, pos);
                String type = new String(bytes, pos + 4, 4, StandardCharsets.US_ASCII);
                if ("IHDR".equals(type)) {
                    w = int32(bytes, pos + 8);
                    h = int32(bytes, pos + 12);
                    assertEquals(8, bytes[pos + 16], "8-bit");
                    assertEquals(6, bytes[pos + 17], "RGBA");
                    assertEquals(0, bytes[pos + 20], "non-interlaced");
                } else if ("IDAT".equals(type)) {
                    byte[] more = Arrays.copyOfRange(bytes, pos + 8, pos + 8 + len);
                    byte[] joined = Arrays.copyOf(idat, idat.length + more.length);
                    System.arraycopy(more, 0, joined, idat.length, more.length);
                    idat = joined;
                } else if ("IEND".equals(type)) {
                    break;
                }
                pos += 12 + len;
            }
            Inflater inflater = new Inflater();
            inflater.setInput(idat);
            byte[] raw = new byte[h * (1 + w * 4)];
            assertEquals(raw.length, inflater.inflate(raw), "the whole image, and no more");
            inflater.end();
            byte[] rgba = new byte[w * h * 4];
            for (int y = 0; y < h; y++) {
                assertEquals(0, raw[y * (1 + w * 4)], "filter 0: the bytes must be stable, not small");
                System.arraycopy(raw, y * (1 + w * 4) + 1, rgba, y * w * 4, w * 4);
            }
            return new Png(w, h, rgba);
        }

        private static int int32(final byte[] b, final int at) {
            return (b[at] & 0xFF) << 24 | (b[at + 1] & 0xFF) << 16 | (b[at + 2] & 0xFF) << 8 | (b[at + 3] & 0xFF);
        }
    }
}
