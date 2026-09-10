package com.mattmc.mcptoolkit.ui.doc;

import com.google.gson.JsonPrimitive;
import org.junit.jupiter.api.Test;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The editor's engine, with no Minecraft on the classpath (SCREEN_AUTHORING_DESIGN.md section 7.1)
 * - which is the point of putting the mutations in {@code ui.doc} rather than in the editor: the
 * half of slice 4 that can be wrong silently is testable without a game.
 *
 * <p>The load-bearing case is {@link #everyRegisteredKindInsertsCleanly()}: it enumerates
 * {@code Kind.values()}, so a kind added to the registry with no insert default fails here by name
 * rather than becoming a palette button that produces a document the game refuses to load. Same
 * discipline as the conformance battery (section 12) and the palette itself (section 9).
 */
class UiEditTest {
    private static final String EXAMPLE = "/assets/mcptoolkit/ui/example.ui.json";

    private static UiDocument example() throws Exception {
        try (InputStream in = UiEditTest.class.getResourceAsStream(EXAMPLE)) {
            assertNotNull(in, "the example document ships in the toolkit's resources");
            return UiParser.parse(new String(in.readAllBytes(), StandardCharsets.UTF_8));
        }
    }

    private static UiEdit.Path pathOf(final UiDocument doc, final String id) {
        UiEdit.Path p = UiEdit.pathOf(doc, id);
        assertNotNull(p, "the example declares '" + id + "'");
        return p;
    }

    // ---------------------------------------------------------------------------------------------
    // Paths

    @Test
    void aPathIsTheParsersOwnPath() {
        // The editor addresses an element with the string the parser reports problems at, so a
        // refusal points at what the human has selected.
        assertEquals("elements[3]", UiEdit.Path.of(3).format());
        assertEquals("elements[13].children[2]", UiEdit.Path.of(13, 2).format());
        assertEquals("", UiEdit.Path.ROOT.format());
        assertEquals(UiEdit.Path.of(13, 2), UiEdit.Path.parse("elements[13].children[2]"));
        assertEquals(UiEdit.Path.of(3), UiEdit.Path.parse("elements[3]"));
        assertEquals(UiEdit.Path.ROOT, UiEdit.Path.parse(""));
        assertThrows(IllegalArgumentException.class, () -> UiEdit.Path.parse("elements[3].kids[0]"));
        assertThrows(IllegalArgumentException.class, () -> UiEdit.Path.parse("outer"));
    }

    @Test
    void walkNamesEveryElementIncludingTheUnnamedOnes() throws Exception {
        UiDocument doc = example();
        // TWO views, and the difference is exactly a macro's expansion (UI_PARTS_LIBRARY_DESIGN.md
        // section 5.2 rule 5): walkAll is what RENDERS, walk is what can be EDITED, and a part's
        // contents are the part file's rather than this document's.
        List<UiEdit.Placed> all = UiEdit.walkAll(doc);
        assertEquals(doc.flatten().size(), all.size(), "one entry per element, nested included");
        List<UiEdit.Placed> editable = UiEdit.walk(doc);
        assertTrue(editable.size() < all.size(), "the example uses parts, so the two views differ");
        for (UiEdit.Placed p : editable) {
            assertNull(UiEdit.enclosingMacro(doc, p.path()),
                p.path().format() + " is offered for editing but lives inside a macro");
        }
        for (UiEdit.Placed p : all) {
            assertEquals(p.element(), UiEdit.elementAt(doc, p.path()), p.path().format());
        }
        // The spacer has no id and cannot get one; a path is the only way to select it.
        boolean spacer = false;
        for (UiEdit.Placed p : all) {
            if (p.element().kind() == Kind.SPACER) {
                spacer = true;
                assertNull(p.element().id());
                assertTrue(p.path().insideLayout());
            }
        }
        assertTrue(spacer, "the example carries a spacer");
        assertNull(UiEdit.elementAt(doc, UiEdit.Path.of(999)));
        assertNull(UiEdit.elementAt(doc, UiEdit.Path.of(0, 0)), "a frame has no children");
    }

    // ---------------------------------------------------------------------------------------------
    // Move, resize

    @Test
    void aTopLevelDragWritesXY() throws Exception {
        UiDocument doc = example();
        UiEdit.Path p = pathOf(doc, "smelting");
        Element.Box before = (Element.Box) UiEdit.elementAt(doc, p);
        UiDocument moved = UiEdit.dragBy(doc, p, 3, -4);
        Element.Box after = (Element.Box) UiEdit.elementAt(moved, p);
        Element.Placement.Absolute a = (Element.Placement.Absolute) before.placement();
        Element.Placement.Absolute b = (Element.Placement.Absolute) after.placement();
        assertEquals(a.x() + 3, b.x());
        assertEquals(a.y() - 4, b.y());
        assertEquals(before.w(), after.w(), "a move does not resize");
    }

    @Test
    void aLayoutChildsDragWritesAnOffsetAndClearingItIsOneCall() throws Exception {
        // Section 4.3: the layout owns the position, so the drag writes the override - and the
        // override is droppable, because the editor marks it as one.
        UiDocument doc = example();
        UiEdit.Path p = pathOf(doc, "note_a");
        assertTrue(p.insideLayout());
        UiDocument moved = UiEdit.dragBy(doc, p, 2, 5);
        Element.Placement.Cell cell = (Element.Placement.Cell) UiEdit.elementAt(moved, p).placement();
        assertEquals(2, cell.dx());
        assertEquals(5, cell.dy());
        assertTrue(cell.hasOffset());

        // note_b already carries offset [2, 0]: a drag ADDS to it rather than replacing it.
        UiEdit.Path q = pathOf(doc, "note_b");
        assertEquals(2, ((Element.Placement.Cell) UiEdit.elementAt(doc, q).placement()).dx());
        UiDocument again = UiEdit.dragBy(doc, q, 3, 0);
        assertEquals(5, ((Element.Placement.Cell) UiEdit.elementAt(again, q).placement()).dx());

        UiDocument cleared = UiEdit.clearOffset(again, q);
        assertTrue(!((Element.Placement.Cell) UiEdit.elementAt(cleared, q).placement()).hasOffset());
        // And back at the origin the key is GONE, not written as [0, 0]: canonical form (section
        // 4.2.1), which is what keeps a save a minimal diff.
        assertTrue(!UiWriter.toJson(cleared).contains("\"offset\""),
            "an offset dragged back to zero leaves no trace in the file");

        assertThrows(UiParseException.class, () -> UiEdit.moveTo(doc, p, 4, 4));
    }

    @Test
    void resizeWritesWhatTheKindActuallyDeclares() throws Exception {
        UiDocument doc = example();
        UiDocument wide = UiEdit.resize(doc, pathOf(doc, "progress_bar"), 80, 10);
        assertEquals(80, UiEdit.elementAt(wide, pathOf(doc, "progress_bar")).w());
        assertEquals(10, UiEdit.elementAt(wide, pathOf(doc, "progress_bar")).h());

        // A slot grid has no w: its size is cols * 18, so a pixel drag rounds to the pitch.
        UiDocument gridded = UiParser.parse("{\"format\":1,\"title\":\"t\",\"width\":176,\"height\":166,"
            + "\"elements\":[{\"kind\":\"slot_grid\",\"id\":\"g\",\"x\":8,\"y\":8,\"cols\":9,\"rows\":1,"
            + "\"container\":\"player\"}]}");
        UiEdit.Path grid = pathOf(gridded, "g");
        UiDocument regrid = UiEdit.resize(gridded, grid, 4 * UiEdit.SLOT_PITCH + 5, 2 * UiEdit.SLOT_PITCH - 3);
        Element.SlotGrid g = (Element.SlotGrid) UiEdit.elementAt(regrid, grid);
        assertEquals(4, g.cols());
        assertEquals(2, g.rows());
        assertEquals(4 * 18, g.w());

        // And a kind with no declared size is refused by name rather than silently ignored.
        UiParseException noSize = assertThrows(UiParseException.class,
            () -> UiEdit.resize(doc, pathOf(doc, "fuel_slot"), 30, 30));
        assertTrue(noSize.getMessage().contains("no declared size"), noSize.getMessage());
        UiParseException layout = assertThrows(UiParseException.class,
            () -> UiEdit.resize(doc, pathOf(doc, "footer"), 30, 30));
        assertTrue(layout.getMessage().contains("size of its children"), layout.getMessage());
    }

    // ---------------------------------------------------------------------------------------------
    // Set: the inspector's one code path

    @Test
    void setGoesThroughTheParserSoARefusalIsTheParsersOwnSentence() throws Exception {
        UiDocument doc = example();
        UiEdit.Path label = pathOf(doc, "fuel_label");

        UiDocument retitled = UiEdit.set(doc, label, "text", new JsonPrimitive("Coal"));
        assertEquals("Coal", ((Element.Label) UiEdit.elementAt(retitled, label)).text().literal());

        // An unknown key: the inspector cannot offer one, but an agent can try, and the answer is
        // the parser's list of what IS allowed there.
        UiParseException unknown = assertThrows(UiParseException.class,
            () -> UiEdit.set(doc, label, "colour", new JsonPrimitive("#FFFFFFFF")));
        assertTrue(unknown.getMessage().contains("unknown key"), unknown.getMessage());
        assertTrue(unknown.getMessage().contains("color"), "it lists the keys that ARE allowed");

        // A reference broken by an edit is caught by the same post-pass the file gets.
        UiParseException ref = assertThrows(UiParseException.class,
            () -> UiEdit.set(doc, pathOf(doc, "progress_bar"), "binding", new JsonPrimitive("nope")));
        assertTrue(ref.getMessage().contains("undeclared binding"), ref.getMessage());

        // The lint no single-key setter would think of: two slots on one container index.
        UiParseException clash = assertThrows(UiParseException.class,
            () -> UiEdit.set(doc, pathOf(doc, "output_slot"), "index", new JsonPrimitive(0)));
        assertTrue(clash.getMessage().contains("declared twice"), clash.getMessage());

        // The placement mode is enforced too: x on a layout child is the classic silent no-op.
        assertThrows(UiParseException.class,
            () -> UiEdit.set(doc, pathOf(doc, "note_a"), "x", new JsonPrimitive(4)));
    }

    @Test
    void aTypedValueIsJsonWhenItCanBeAndAStringWhenItCannot() {
        assertEquals(12, UiEdit.value("12").getAsInt());
        assertTrue(UiEdit.value("true").getAsBoolean());
        assertEquals(2, UiEdit.value("[2, 0]").getAsJsonArray().size());
        assertEquals("minecraft:coal", UiEdit.value("{\"item\": \"minecraft:coal\"}")
            .getAsJsonObject().get("item").getAsString());
        // A human typing a label does not type the quotes.
        assertEquals("Fuel", UiEdit.value("Fuel").getAsString());
        assertEquals("Fuel level", UiEdit.value("Fuel level").getAsString());
        assertEquals("#FFAA5500", UiEdit.value("#FFAA5500").getAsString());
        assertEquals("", UiEdit.value("").getAsString());
    }

    @Test
    void screenLevelKeysAreEditableToo() throws Exception {
        UiDocument doc = example();
        assertEquals("UI example", doc.title().literal());
        UiDocument renamed = UiEdit.setScreen(doc, "title", new JsonPrimitive("Rocket"));
        assertEquals("Rocket", renamed.title().literal());
        UiDocument hidden = UiEdit.setScreen(doc, "inventory_label", new JsonPrimitive(false));
        assertTrue(!hidden.inventoryLabel().shown());
        assertThrows(UiParseException.class, () -> UiEdit.setScreen(doc, "widht", new JsonPrimitive(200)));
    }

    // ---------------------------------------------------------------------------------------------
    // The palette

    @Test
    void everyRegisteredKindInsertsCleanly() throws Exception {
        // Section 9: the palette enumerates from the registry, so this is the check that a palette
        // entry cannot be a lie. Every kind, into the placement it is legal in, and the result must
        // PARSE - which for a button, a bar and a slot means the insert declared what they refer to.
        UiDocument doc = example();
        UiEdit.Path layoutNode = pathOf(doc, "footer");
        List<String> covered = new ArrayList<>();
        for (Kind kind : Kind.values()) {
            UiEdit.Path parent = kind.allowedAtTopLevel() ? UiEdit.Path.ROOT : layoutNode;
            UiEdit.Added added = UiEdit.add(doc, kind, parent, 20, 100);
            Element e = UiEdit.elementAt(added.doc(), added.path());
            assertNotNull(e, kind + " landed at " + added.path().format());
            assertEquals(kind, e.kind());
            if (kind != Kind.SPACER) {
                assertNotNull(e.id(), kind + " gets a generated id");
            }
            // The insert survives a round trip through the file, which is what a save writes.
            assertNotNull(UiParser.parse(UiWriter.toJson(added.doc())));
            covered.add(kind.jsonName());
        }
        assertEquals(Kind.names(), covered, "every registered kind, in registry order");
    }

    @Test
    void anInsertDeclaresWhatItReferencesAndFindsFreeSlots() throws Exception {
        UiDocument doc = example();

        UiEdit.Added button = UiEdit.add(doc, Kind.BUTTON, UiEdit.Path.ROOT, 8, 110);
        Element.Button b = (Element.Button) UiEdit.elementAt(button.doc(), button.path());
        assertNotNull(button.doc().action(b.action()),
            "the action a new button fires is declared, or the parser would refuse the document");
        assertEquals(doc.actions().size() + 1, button.doc().actions().size());

        UiEdit.Added bar = UiEdit.add(doc, Kind.BAR, UiEdit.Path.ROOT, 8, 110);
        Element.Bar r = (Element.Bar) UiEdit.elementAt(bar.doc(), bar.path());
        UiDocument.Binding binding = bar.doc().binding(r.binding());
        assertNotNull(binding, "the binding a new bar fills by is declared");
        assertTrue(binding.hasMax(), "and it has a max, or a bar cannot fill by it");

        // The example's only container is full and the player's 36 slots are all placed, so a new
        // slot cannot
        // land there. It goes to the first free run - here the player's inventory, which the example
        // places 36 of... so a fresh container is declared instead.
        UiEdit.Added slot = UiEdit.add(doc, Kind.SLOT, UiEdit.Path.ROOT, 8, 110);
        Element.Slot s = (Element.Slot) UiEdit.elementAt(slot.doc(), slot.path());
        assertTrue(slot.doc().containerSize(s.container()) > s.index(),
            "a new slot's index fits its container");
        assertEquals(doc.containers().size() + 1, slot.doc().containers().size(),
            "nothing declared had room, so the insert declared a container");

        // A document WITH room reuses it rather than declaring more.
        UiDocument roomy = UiParser.parse("{\"format\":1,\"title\":\"t\",\"width\":176,\"height\":166,"
            + "\"containers\":[{\"name\":\"input\",\"size\":4}],\"elements\":[]}");
        UiEdit.Added reused = UiEdit.add(roomy, Kind.SLOT_GRID, UiEdit.Path.ROOT, 8, 8);
        Element.SlotGrid g = (Element.SlotGrid) UiEdit.elementAt(reused.doc(), reused.path());
        assertEquals("input", g.container());
        assertEquals(1, reused.doc().containers().size());
        // And the next one lands after it, not on top of it.
        UiEdit.Added next = UiEdit.add(reused.doc(), Kind.SLOT, UiEdit.Path.ROOT, 8, 30);
        Element.Slot after = (Element.Slot) UiEdit.elementAt(next.doc(), next.path());
        assertEquals(3, after.index(), "3 slots taken, so index 3 is the first free one");
    }

    @Test
    void anInsertedLayoutIsVisibleAndAnInsertedGridChildGetsACell() throws Exception {
        UiDocument doc = example();
        UiEdit.Added row = UiEdit.add(doc, Kind.ROW, UiEdit.Path.ROOT, 8, 110);
        Element.Layout l = (Element.Layout) UiEdit.elementAt(row.doc(), row.path());
        assertEquals(1, l.children().size(),
            "an empty layout arranges to 0x0 - invisible and unselectable, a dead end for the human");

        // Into a grid, the child needs a cell or the parser refuses it.
        UiEdit.Path grid = pathOf(doc, "pairs");
        UiEdit.Added cell = UiEdit.add(doc, Kind.LABEL, grid, 0, 0);
        Element.Placement.Cell c = (Element.Placement.Cell) UiEdit.elementAt(cell.doc(), cell.path()).placement();
        assertTrue(c.inGrid(), "row/col were filled in");
        assertEquals(2, c.col(), "the example's grid uses cols 0 and 1, so the free cell is 2");

        // Into a stack, it must NOT carry row/col, and does not.
        UiEdit.Added stacked = UiEdit.add(doc, Kind.LABEL, pathOf(doc, "badge"), 0, 0);
        assertTrue(!((Element.Placement.Cell) UiEdit.elementAt(stacked.doc(), stacked.path())
            .placement()).inGrid());
    }

    @Test
    void placementRulesAreNotReimplementedTheyAreTheParsers() throws Exception {
        UiDocument doc = example();
        // A spacer at the top level and a slot inside a layout are the two rules the format has, and
        // the palette does not carry a copy of either: it inserts, the parse refuses, the human reads
        // the sentence the file would have given them.
        UiParseException spacer = assertThrows(UiParseException.class,
            () -> UiEdit.add(doc, Kind.SPACER, UiEdit.Path.ROOT, 8, 8));
        assertTrue(spacer.getMessage().contains("inside a row, column, grid or stack"), spacer.getMessage());
        UiParseException slot = assertThrows(UiParseException.class,
            () -> UiEdit.add(doc, Kind.SLOT, pathOf(doc, "footer"), 0, 0));
        assertTrue(slot.getMessage().contains("cannot sit inside a layout"), slot.getMessage());
        assertThrows(UiParseException.class, () -> UiEdit.add(doc, Kind.PANEL, pathOf(doc, "outer"), 0, 0));
    }

    @Test
    void removeTakesTheSubtreeAndReindexesWhatFollows() throws Exception {
        UiDocument doc = example();
        int before = doc.flatten().size();
        UiEdit.Path footer = pathOf(doc, "footer");
        int inFooter = 1 + UiEdit.walk(doc).stream()
            .filter(p -> p.path().format().startsWith(footer.format() + ".")).toList().size();
        UiDocument cut = UiEdit.remove(doc, footer);
        assertEquals(before - inFooter, cut.flatten().size(), "the node and everything in it");
        assertNull(UiEdit.pathOf(cut, "launch"), "its children are gone with it");
        // The elements after it moved down one index - which is why the editor re-resolves its
        // selection after every edit instead of holding a path across one.
        assertEquals(footer, UiEdit.pathOf(cut, "preview"), "the part that followed it moved down one");
        assertThrows(UiParseException.class, () -> UiEdit.remove(doc, UiEdit.Path.ROOT));
        assertThrows(UiParseException.class, () -> UiEdit.remove(doc, UiEdit.Path.of(99)));
    }

    // ---------------------------------------------------------------------------------------------
    // What a save writes

    @Test
    void anEditIsAMinimalDiffAndUndoIsExact() throws Exception {
        // The two file-level promises of the editor: a save changes the lines the edit changed and
        // nothing else (section 4.2.1 - canonical form, so a human's git diff is readable), and undo
        // is a snapshot of an immutable document, so it restores the file BYTE FOR BYTE.
        UiDocument doc = example();
        String original = UiWriter.toJson(doc);
        UiEdit.Path p = pathOf(doc, "smelting");
        String edited = UiWriter.toJson(UiEdit.dragBy(doc, p, 1, 0));
        assertNotEquals(original, edited);

        List<String> a = original.lines().toList();
        List<String> b = edited.lines().toList();
        assertEquals(a.size(), b.size(), "a nudge adds no lines");
        List<Integer> changed = new ArrayList<>();
        for (int i = 0; i < a.size(); i++) {
            if (!a.get(i).equals(b.get(i))) {
                changed.add(i);
            }
        }
        assertEquals(1, changed.size(), "one line changed: " + changed);
        assertTrue(b.get(changed.get(0)).contains("\"x\": 9"), b.get(changed.get(0)));

        // Undo: the document before the edit, written again, is the original text.
        assertEquals(original, UiWriter.toJson(doc));
        assertEquals(original, UiWriter.toJson(UiParser.parse(original)), "and the file is a fixed point");
    }

    @Test
    void anEditedDocumentStaysAFixedPointOfTheWriter() throws Exception {
        // Every mutation goes out through the writer and back through the parser, so the editor can
        // only ever produce canonical text. If this ever fails, a save writes a file that a save
        // would then rewrite - a permanently dirty git status.
        UiDocument doc = example();
        UiDocument edited = UiEdit.add(doc, Kind.PANEL, UiEdit.Path.ROOT, 8, 100).doc();
        edited = UiEdit.dragBy(edited, pathOf(edited, "panel"), 2, 2);
        edited = UiEdit.resize(edited, pathOf(edited, "panel"), 30, 12);
        edited = UiEdit.set(edited, pathOf(edited, "panel"), "id", new JsonPrimitive("box"));
        String once = UiWriter.toJson(edited);
        assertEquals(once, UiWriter.toJson(UiParser.parse(once)));
    }
}
