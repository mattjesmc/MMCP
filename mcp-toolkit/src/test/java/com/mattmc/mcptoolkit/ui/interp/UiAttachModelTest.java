package com.mattmc.mcptoolkit.ui.interp;

import com.mattmc.mcptoolkit.ui.doc.SlotPlan;
import com.mattmc.mcptoolkit.ui.doc.UiDocument;
import com.mattmc.mcptoolkit.ui.doc.UiParser;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The two halves of the ATTACHED preview (SCREEN_AUTHORING_DESIGN.md section 6.1, slice 6) that are
 * Minecraft-free, and are therefore falsifiable with the game down.
 *
 * <p><b>The binding adapter</b> is open decision 8 cashed out. Attached, the menu belongs to a mod,
 * and generated code implements no toolkit interface - it carries {@code public int
 * bindingValue(String)} and nothing else. So {@link UiBindings#bind} reads either shape, and the
 * case that matters most is the third: a menu that answers NEITHER must yield zeroes AND say so,
 * because "every gauge is empty" and "nothing answered" look identical on screen.
 *
 * <p><b>The slot comparison</b> exists because {@code Slot.x} is final in 26.2. An attached preview
 * cannot move a slot, so the honest thing - the only honest thing - is to measure how far the live
 * menu has drifted from the document and say it.
 */
class UiAttachModelTest {

    // ---- the binding adapter ---------------------------------------------------------------------

    /** The toolkit's own menu: the interface. */
    private static final class Interfaced implements UiBindings {
        @Override
        public int bindingValue(final String name) {
            return "fuel".equals(name) ? 42000 : 0;
        }
    }

    /** What a generated {@code <Screen>MenuBase} looks like from here: the method, no interface. */
    public static final class Generated {
        public int bindingValue(final String name) {
            return "fuel".equals(name) ? 42000 : 7;
        }
    }

    /** Someone else's {@code bindingValue}, which is not this contract. */
    public static final class WrongShape {
        public String bindingValue(final String name) {
            return name;
        }
    }

    /** A menu whose binding read throws: a preview must still draw. */
    public static final class Throwing {
        public int bindingValue(final String name) {
            throw new IllegalStateException("no data slot " + name);
        }
    }

    @Test
    void theInterfaceAnswersAndSaysSo() {
        UiBindings.Bound b = UiBindings.bind(new Interfaced());
        assertEquals(UiBindings.Source.INTERFACE, b.source());
        assertEquals(42000, b.values().bindingValue("fuel"));
        assertTrue(b.answers());
    }

    @Test
    void aGeneratedMenuAnswersByShape() {
        UiBindings.Bound b = UiBindings.bind(new Generated());
        assertEquals(UiBindings.Source.SHAPE, b.source(),
            "a generated menu carries the method without the interface (section 15.8) and must still be read");
        assertEquals(42000, b.values().bindingValue("fuel"));
        assertEquals(7, b.values().bindingValue("anything"));
    }

    @Test
    void aMenuThatAnswersNothingReadsZeroAndSaysWhy() {
        UiBindings.Bound b = UiBindings.bind(new Object());
        assertEquals(UiBindings.Source.NONE, b.source());
        assertFalse(b.answers(), "the report needs to distinguish 'all zero' from 'nobody answered'");
        assertEquals(0, b.values().bindingValue("fuel"));
    }

    @Test
    void aBindingValueOfAnotherTypeIsSomebodyElsesMethod() {
        assertEquals(UiBindings.Source.NONE, UiBindings.bind(new WrongShape()).source());
    }

    @Test
    void aThrowingMenuStillDraws() {
        UiBindings.Bound b = UiBindings.bind(new Throwing());
        assertEquals(UiBindings.Source.SHAPE, b.source());
        assertEquals(0, b.values().bindingValue("fuel"), "contained: a broken menu must not blank the preview");
    }

    @Test
    void theAdapterItselfImportsNoMinecraft() throws Exception {
        // It lives in the interpreter's package, which is Minecraft to the core - but the adapter is a
        // method lookup, and keeping it free of the game is what lets every case above run with no
        // game. A test that could not fail without this pin would be one relaunch away from useless.
        java.nio.file.Path f = java.nio.file.Path.of("src/main/java/com/mattmc/mcptoolkit/ui/interp/UiBindings.java");
        assertTrue(java.nio.file.Files.isRegularFile(f), "run from the mcp-toolkit project root: " + f.toAbsolutePath());
        for (String line : java.nio.file.Files.readAllLines(f)) {
            assertFalse(line.startsWith("import net.minecraft") || line.startsWith("import net.fabricmc"),
                "UiBindings is the seam a menu is read through, with or without a game: " + line);
        }
    }

    // ---- the slot comparison ---------------------------------------------------------------------

    private static final String DOC = "{\"format\":1,\"title\":\"t\",\"width\":176,\"height\":166,"
        + "\"containers\":[{\"name\":\"input\",\"size\":2}],\"elements\":["
        + "{\"kind\":\"slot\",\"id\":\"in\",\"x\":14,\"y\":36,\"container\":\"input\",\"index\":0},"
        + "{\"kind\":\"slot\",\"id\":\"out\",\"x\":110,\"y\":36,\"container\":\"input\",\"index\":1}]}";

    private static SlotPlan plan(final String json) throws Exception {
        UiDocument doc = UiParser.parse(json);
        return SlotPlan.of(doc);
    }

    private static int[][] live(final int... xy) {
        int[][] out = new int[xy.length / 2][];
        for (int i = 0; i < out.length; i++) {
            out[i] = new int[] {xy[i * 2], xy[i * 2 + 1]};
        }
        return out;
    }

    @Test
    void aMenuBuiltFromTheDocumentIsClean() throws Exception {
        SlotPlan.Drift d = SlotPlan.compare(plan(DOC), live(14, 36, 110, 36));
        assertTrue(d.clean(), () -> "expected no drift, got " + d.notes());
        assertEquals(0, d.moved());
        assertEquals(2, d.documentSlots());
        assertEquals(2, d.menuSlots());
    }

    @Test
    void aMovedSlotIsNamedWithBothPositions() throws Exception {
        SlotPlan.Drift d = SlotPlan.compare(plan(DOC), live(14, 36, 110, 40));
        assertEquals(1, d.moved());
        assertEquals(1, d.notes().size());
        String note = d.notes().get(0);
        assertTrue(note.contains("'out'"), note);
        assertTrue(note.contains("110,36"), () -> "the document's position: " + note);
        assertTrue(note.contains("110,40"), () -> "the live menu's position: " + note);
    }

    @Test
    void aMenuWithAnotherSlotCountSaysItIsNotThisDocumentsMenu() throws Exception {
        SlotPlan.Drift d = SlotPlan.compare(plan(DOC), live(14, 36));
        assertFalse(d.clean());
        assertTrue(d.notes().get(0).contains("not from this"), d.notes()::toString);
        assertEquals(1, d.menuSlots());
        assertEquals(2, d.documentSlots());
    }

    @Test
    void everySlotOutOfPlaceIsCountedRatherThanListed() throws Exception {
        StringBuilder elements = new StringBuilder();
        for (int i = 0; i < 10; i++) {
            elements.append(i == 0 ? "" : ",").append("{\"kind\":\"slot\",\"id\":\"s").append(i)
                .append("\",\"x\":").append(8 + i * 18).append(",\"y\":8,\"container\":\"input\",\"index\":")
                .append(i).append("}");
        }
        String json = "{\"format\":1,\"title\":\"t\",\"width\":400,\"height\":166,"
            + "\"containers\":[{\"name\":\"input\",\"size\":10}],\"elements\":[" + elements + "]}";
        int[] xy = new int[20];
        for (int i = 0; i < 10; i++) {
            xy[i * 2] = 8 + i * 18;
            xy[i * 2 + 1] = 9; // every one off by a pixel
        }
        SlotPlan.Drift d = SlotPlan.compare(plan(json), live(xy));
        assertEquals(10, d.moved());
        assertEquals(7, d.notes().size(), () -> "six named and one counted, not ten: " + d.notes());
        assertTrue(d.notes().get(6).contains("4 more"), d.notes()::toString);
    }
}
