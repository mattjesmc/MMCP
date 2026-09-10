package com.mattmc.mcptoolkit.ui.doc;

import org.junit.jupiter.api.Test;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * <b>The parts library and the two macros</b> (UI_PARTS_LIBRARY_DESIGN.md sections 4.1, 4.2 and 5),
 * with no Minecraft on the classpath.
 *
 * <p>Two things here are load-bearing rather than illustrative.
 *
 * <p><b>{@link #corruptingOnePartFileMovesTheExpansionAndNothingElse()} is the falsifier</b> section 6
 * asks for by name: "a part needs its own falsifier in slice 3's style: corrupt one substitution and
 * watch the battery go red. Without it, D ships a substitution pass nothing checks." Slice 3's
 * registry-enumerated battery covers a part's expansion for FREE - but only for the kinds it uses,
 * not for the expansion being correct, so a substitution that silently stopped substituting would be
 * invisible to every other check in this project.
 *
 * <p><b>{@link #aPartUsedTwiceDoesNotCollide()} is rule 2</b>, and the reason it is a rule: without
 * namespacing the second use of any part is a refusal about duplicate ids, at a path inside a file
 * the author did not write.
 */
class UiPartsTest {
    private static final String EXAMPLE = "/assets/mcptoolkit/ui/example.ui.json";

    /** A library the case builds inline: the parts under test, and nothing that can drift. */
    private static PartLibrary lib(final String name, final String body) {
        return PartLibrary.chain(PartLibrary.of(Map.of("test:" + name, body)), PartLibrary.classpath());
    }

    private static String screen(final String screenKeys, final String elements) {
        return "{\"format\":1,\"title\":\"t\",\"width\":176,\"height\":166" + screenKeys
            + ",\"elements\":[" + elements + "]}";
    }

    private static UiParseException refused(final String json, final PartLibrary library) {
        return assertThrows(UiParseException.class, () -> UiParser.parse(json, library));
    }

    private static String example() throws Exception {
        try (InputStream in = UiPartsTest.class.getResourceAsStream(EXAMPLE)) {
            assertNotNull(in);
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Expansion

    @Test
    void aPartExpandsAtItsOriginAndKeepsItsInstance() throws Exception {
        PartLibrary library = lib("pair", "{\"format\":1,\"params\":[{\"name\":\"w\",\"type\":\"int\"}],"
            + "\"elements\":[{\"kind\":\"panel\",\"id\":\"a\",\"x\":0,\"y\":0,\"w\":\"$w\",\"h\":4},"
            + "{\"kind\":\"panel\",\"id\":\"b\",\"x\":0,\"y\":6,\"w\":\"$w\",\"h\":4}]}");
        UiDocument doc = UiParser.parse(screen("",
            "{\"kind\":\"part\",\"id\":\"p\",\"part\":\"test:pair\",\"x\":20,\"y\":30,\"w\":12}"), library);

        Element.Part part = (Element.Part) doc.elements().get(0);
        assertEquals("test:pair", part.part());
        assertEquals(2, part.children().size());
        // The fragment is written around (0,0) and the instance says where: that translation is what
        // makes a part reusable at all, and it is why the instance carries an x/y like anything else.
        Element.Box a = (Element.Box) part.children().get(0);
        Element.Box b = (Element.Box) part.children().get(1);
        assertEquals(new Element.Placement.Absolute(20, 30), a.placement());
        assertEquals(new Element.Placement.Absolute(20, 36), b.placement());
        assertEquals(12, a.w(), "the argument reached the fragment");

        // Rule 5: the writer puts back the INSTANCE, never the six elements it became - or the first
        // drag in the editor would unpick every part in the document, permanently.
        String written = UiWriter.toJson(doc);
        assertTrue(written.contains("\"part\": \"test:pair\""), written);
        assertFalse(written.contains("\"kind\": \"panel\""), "the expansion is not written:\n" + written);
        assertEquals(doc, UiParser.parse(written, library), "and it reads back identically");
    }

    @Test
    void aPartUsedTwiceDoesNotCollide() {
        PartLibrary library = lib("one", "{\"format\":1,\"elements\":["
            + "{\"kind\":\"panel\",\"id\":\"box\",\"x\":0,\"y\":0,\"w\":4,\"h\":4}]}");
        UiDocument doc = assertDoesNotRefuse(screen("",
            "{\"kind\":\"part\",\"id\":\"left\",\"part\":\"test:one\",\"x\":8,\"y\":8},"
                + "{\"kind\":\"part\",\"id\":\"right\",\"part\":\"test:one\",\"x\":80,\"y\":8}"), library);
        assertNotNull(doc.byId("left.box"));
        assertNotNull(doc.byId("right.box"));
        assertNull(doc.byId("box"), "the local id is namespaced away, so nothing outside can reach it");
    }

    @Test
    void aDotInAHandWrittenIdIsStillRefused() {
        UiParseException e = refused(screen("",
            "{\"kind\":\"panel\",\"id\":\"a.b\",\"x\":0,\"y\":0,\"w\":4,\"h\":4}"), PartLibrary.empty());
        assertTrue(e.getMessage().contains("contains a dot"), e.getMessage());
    }

    @Test
    void twoIdsThatBecomeOneJavaNameAreRefused() {
        PartLibrary library = lib("one", "{\"format\":1,\"elements\":["
            + "{\"kind\":\"panel\",\"id\":\"box\",\"x\":0,\"y\":0,\"w\":4,\"h\":4}]}");
        // 'a.box' and 'a_box' both become drawRegion_a_box / a field called a_box in generated Java,
        // and the compile error would land in the CONSUMER's tree, which is the worst place to find it.
        UiParseException e = refused(screen("",
            "{\"kind\":\"part\",\"id\":\"a\",\"part\":\"test:one\",\"x\":8,\"y\":8},"
                + "{\"kind\":\"panel\",\"id\":\"a_box\",\"x\":8,\"y\":40,\"w\":4,\"h\":4}"), library);
        assertTrue(e.getMessage().contains("both become the Java name 'a_box'"), e.getMessage());
    }

    // ---------------------------------------------------------------------------------------------
    // Substitution

    @Test
    void theThreeSubstitutionFormsAndNothingElse() {
        PartLibrary library = lib("forms", "{\"format\":1,\"params\":["
            + "{\"name\":\"n\",\"type\":\"int\"},{\"name\":\"t\",\"type\":\"text\"},"
            + "{\"name\":\"hint\",\"type\":\"sprite\",\"default\":null}],"
            + "\"elements\":["
            // exact: the argument's own JSON, whatever type it is
            + "{\"kind\":\"label\",\"id\":\"exact\",\"x\":\"$n\",\"y\":0,\"text\":\"$t\"},"
            // affine: offset and stride, and nothing more of a language than that
            + "{\"kind\":\"label\",\"id\":\"affine\",\"x\":\"$n * 2 + 3\",\"y\":\"$n - 1\",\"text\":\"x\"},"
            // interpolation, with $$ for a literal dollar
            + "{\"kind\":\"label\",\"id\":\"text\",\"x\":0,\"y\":20,\"text\":\"n is $n$$\"},"
            // an omitted optional argument REMOVES the key it landed on
            + "{\"kind\":\"slot\",\"id\":\"s\",\"x\":0,\"y\":40,\"container\":\"player\",\"index\":0,"
            + "\"icon\":\"$hint\"}]}");
        UiDocument doc = assertDoesNotRefuse(screen("",
            "{\"kind\":\"part\",\"id\":\"p\",\"part\":\"test:forms\",\"n\":5,\"t\":{\"translate\":\"a.b\"}}"),
            library);
        assertEquals(new Element.Placement.Absolute(5, 0), doc.byId("p.exact").placement());
        assertTrue(((Element.Label) doc.byId("p.exact")).text().isTranslation(), "an object argument survives");
        assertEquals(new Element.Placement.Absolute(13, 4), doc.byId("p.affine").placement());
        assertEquals("n is 5$", ((Element.Label) doc.byId("p.text")).text().literal());
        assertNull(((Element.Slot) doc.byId("p.s")).icon(), "a null default is ABSENT, not a null value");
    }

    @Test
    void anUnknownVariableIsAProblemButALoopVariableIsLeftForTheRepeatInsideIt() {
        PartLibrary typo = lib("typo", "{\"format\":1,\"params\":[{\"name\":\"w\",\"type\":\"int\"}],"
            + "\"elements\":[{\"kind\":\"panel\",\"id\":\"a\",\"x\":0,\"y\":0,\"w\":\"$width\",\"h\":4}]}");
        UiParseException e = refused(screen("",
            "{\"kind\":\"part\",\"id\":\"p\",\"part\":\"test:typo\",\"w\":4}"), typo);
        assertTrue(e.getMessage().contains("$width") && e.getMessage().contains("[w]"), e.getMessage());

        // $i belongs to the repeat inside the part, and is bound one pass later. Without the reserved
        // name, a part could not contain a repeat at all.
        PartLibrary nested = lib("stack", "{\"format\":1,\"params\":[{\"name\":\"pitch\",\"type\":\"int\"}],"
            + "\"elements\":[{\"kind\":\"repeat\",\"id\":\"r\",\"count\":3,\"children\":["
            + "{\"kind\":\"panel\",\"id\":\"row\",\"x\":0,\"y\":\"$i * $pitch\",\"w\":4,\"h\":4}]}]}");
        UiDocument doc = assertDoesNotRefuse(screen("",
            "{\"kind\":\"part\",\"id\":\"p\",\"part\":\"test:stack\",\"x\":8,\"y\":8,\"pitch\":10}"), nested);
        assertEquals(new Element.Placement.Absolute(8, 8), doc.byId("p.r.0.row").placement());
        assertEquals(new Element.Placement.Absolute(8, 18), doc.byId("p.r.1.row").placement());
        assertEquals(new Element.Placement.Absolute(8, 28), doc.byId("p.r.2.row").placement());
    }

    @Test
    void argumentsAreCheckedAgainstTheDeclaredTypes() {
        PartLibrary library = lib("typed", "{\"format\":1,\"params\":["
            + "{\"name\":\"n\",\"type\":\"int\"},{\"name\":\"c\",\"type\":\"container\"}],"
            + "\"elements\":[{\"kind\":\"slot\",\"id\":\"s\",\"x\":0,\"y\":0,\"container\":\"$c\",\"index\":0}]}");
        assertTrue(refused(screen("", "{\"kind\":\"part\",\"id\":\"p\",\"part\":\"test:typed\",\"c\":\"player\"}"), library)
            .getMessage().contains("requires a int argument 'n'"));
        assertTrue(refused(screen("", "{\"kind\":\"part\",\"id\":\"p\",\"part\":\"test:typed\",\"n\":\"big\",\"c\":\"player\"}"), library)
            .getMessage().contains("wants a whole number"));
        assertTrue(refused(screen("", "{\"kind\":\"part\",\"id\":\"p\",\"part\":\"test:typed\",\"n\":1,\"c\":\"player\",\"z\":1}"), library)
            .getMessage().contains("unknown key"), "an argument the part does not declare");
        // Rule 3: the reference resolves against the SCREEN's declarations, because by the time the
        // post-pass runs the part is gone.
        assertTrue(refused(screen("", "{\"kind\":\"part\",\"id\":\"p\",\"part\":\"test:typed\",\"n\":1,\"c\":\"nope\"}"), library)
            .getMessage().contains("undeclared container 'nope'"));
    }

    @Test
    void aMissingPartNamesWhereItLooked() {
        UiParseException e = refused(screen("",
            "{\"kind\":\"part\",\"id\":\"p\",\"part\":\"test:absent\"}"), PartLibrary.classpath());
        assertTrue(e.getMessage().contains("assets/test/ui/parts/absent.part.json"), e.getMessage());
        assertTrue(e.getMessage().contains("looked in"), e.getMessage());
    }

    @Test
    void aPartThatContainsItselfIsASentenceAndNotAStackOverflow() {
        PartLibrary library = lib("loop", "{\"format\":1,\"elements\":["
            + "{\"kind\":\"part\",\"id\":\"inner\",\"part\":\"test:loop\"}]}");
        UiParseException e = refused(screen("",
            "{\"kind\":\"part\",\"id\":\"p\",\"part\":\"test:loop\"}"), library);
        assertTrue(e.getMessage().contains("cannot contain itself"), e.getMessage());
    }

    // ---------------------------------------------------------------------------------------------
    // repeat

    @Test
    void repeatSubstitutesItsIndexAndKeepsItsTemplate() {
        UiDocument doc = assertDoesNotRefuse(screen("",
            "{\"kind\":\"repeat\",\"id\":\"rows\",\"x\":4,\"y\":6,\"count\":3,\"children\":["
                + "{\"kind\":\"label\",\"id\":\"n\",\"x\":0,\"y\":\"$i * 10\",\"text\":\"row $i\"}]}"),
            PartLibrary.empty());
        Element.Repeat r = (Element.Repeat) doc.elements().get(0);
        assertEquals(3, r.children().size());
        assertEquals(new Element.Placement.Absolute(4, 6), doc.byId("rows.0.n").placement());
        assertEquals(new Element.Placement.Absolute(4, 26), doc.byId("rows.2.n").placement());
        assertEquals("row 2", ((Element.Label) doc.byId("rows.2.n")).text().literal());
        String written = UiWriter.toJson(doc);
        assertTrue(written.contains("\"$i * 10\""), "the TEMPLATE is written back, not the expansion:\n" + written);
        assertEquals(1, written.split("\"kind\": \"label\"", -1).length - 1, "one label, not three");
    }

    @Test
    void aRepeatLongEnoughToBeATypoIsRefusedByNumber() {
        UiParseException e = refused(screen("",
            "{\"kind\":\"repeat\",\"id\":\"r\",\"count\":100000,\"children\":["
                + "{\"kind\":\"label\",\"id\":\"n\",\"x\":0,\"y\":0,\"text\":\"x\"}]}"), PartLibrary.empty());
        assertTrue(e.getMessage().contains(String.valueOf(UiParser.MAX_REPEAT)), e.getMessage());
    }

    // ---------------------------------------------------------------------------------------------
    // Editing: rule 5

    @Test
    void everyMutationInsideAMacroIsRefusedByName() throws Exception {
        UiDocument doc = UiParser.parse(example());
        UiEdit.Path inner = UiEdit.pathOf(doc, "inv.backpack");
        assertNotNull(inner, "the example's inventory comes from a part");
        for (String what : List.of("set", "move", "resize", "remove")) {
            UiParseException e = assertThrows(UiParseException.class, () -> {
                switch (what) {
                    case "set" -> UiEdit.set(doc, inner, "cols", new com.google.gson.JsonPrimitive(3));
                    case "move" -> UiEdit.moveTo(doc, inner, 0, 0);
                    case "resize" -> UiEdit.resize(doc, inner, 18, 18);
                    default -> UiEdit.remove(doc, inner);
                }
            }, what);
            assertTrue(e.getMessage().contains("mcptoolkit:player_inventory"), what + ": " + e.getMessage());
        }
        // The INSTANCE is editable, and that is the whole of rule 5.
        UiEdit.Path instance = UiEdit.pathOf(doc, "inv");
        assertNotNull(instance);
        UiDocument moved = UiEdit.moveTo(doc, instance, 8, 100);
        assertEquals(new Element.Placement.Absolute(8, 100), UiEdit.elementAt(moved, instance).placement());
        assertEquals(new Element.Placement.Absolute(8, 100),
            UiEdit.elementAt(moved, instance).children().get(0).placement(),
            "and moving the instance moved what it expanded to");
    }

    // ---------------------------------------------------------------------------------------------
    // The falsifier (section 6)

    @Test
    void corruptingOnePartFileMovesTheExpansionAndNothingElse() throws Exception {
        String good = new String(UiPartsTest.class.getResourceAsStream(
            "/assets/mcptoolkit/ui/parts/station_inputs.part.json").readAllBytes(), StandardCharsets.UTF_8);
        assertTrue(good.contains("\"$gap\""), "the part places its second slot at $gap");
        // The corruption: the part stops substituting - the literal string survives where a number
        // should be. If nothing downstream noticed, the substitution pass would have no check at all.
        String broken = good.replace("\"x\": \"$gap\"", "\"x\": 0");
        assertNotEquals(good, broken);

        PartLibrary library = PartLibrary.chain(
            PartLibrary.of(Map.of("mcptoolkit:station_inputs", broken)), PartLibrary.classpath());
        UiDocument before = UiParser.parse(example());
        UiDocument after = UiParser.parse(example(), library);
        assertNotEquals(before, after, "a one-pixel change in a PART file changes the document it expands into");

        Element.Slot was = (Element.Slot) before.byId("inputs.material");
        Element.Slot now = (Element.Slot) after.byId("inputs.material");
        assertEquals(was.x() - 18, now.x(), "the second slot lost its gap, and nothing else moved");
        assertEquals(was.y(), now.y());
        assertEquals(before.byId("inputs.template"), after.byId("inputs.template"));

        // And the provenance moved with it, which is what makes a shipped screen greppable
        // (section 5.3): two versions of one part cannot both claim the same hash.
        assertNotEquals(((Element.Part) before.byId("inputs")).hash(),
            ((Element.Part) after.byId("inputs")).hash());
    }

    @Test
    void aPartFileHashIsTheSameOnEveryCheckout() {
        // Line endings are git's business. A Windows checkout and a Linux one hold the same file and
        // must stamp the same hash into generated Java, or every cross-platform build reports drift.
        String unix = "{\n  \"format\": 1\n}\n";
        assertEquals(UiParser.hash(unix), UiParser.hash(unix.replace("\n", "\r\n")));
    }

    // ---------------------------------------------------------------------------------------------

    private static UiDocument assertDoesNotRefuse(final String json, final PartLibrary library) {
        try {
            return UiParser.parse(json, library);
        } catch (UiParseException e) {
            throw new AssertionError(e.getMessage(), e);
        }
    }
}
