package com.mattmc.mcptoolkit.ui.doc;

import org.junit.jupiter.api.Test;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.EnumSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The lint's contract, with no Minecraft on the classpath (SCREEN_AUTHORING_DESIGN.md section 10):
 * {@code check_layout} answering about a document with the game down.
 *
 * <p><b>The load-bearing case is {@link #everyCodeHasADocumentThatProducesIt()}</b>, and it is the
 * same discipline {@code UiEditTest} applies to the palette: it enumerates {@link UiLint.Code} and
 * fails by name when a code has no document that fires it. A lint code nothing can produce is a
 * promise in a manifest that no caller will ever see honoured, and it is exactly the shape of thing
 * that survives forever once written.
 *
 * <p>The second load-bearing case is {@link #theShippedExampleIsClean()}: the toolkit's own example
 * is the conformance battery's subject, so a lint that flagged it would be flagging the reference
 * screen - and a lint whose clean case is never tested is a lint that could be firing on everything.
 */
class UiLintTest {
    private static final String EXAMPLE = "/assets/mcptoolkit/ui/example.ui.json";

    private static UiDocument parse(final String json) throws Exception {
        return UiParser.parse(json);
    }

    /** A minimal well-formed document; each case below changes exactly one thing about it. */
    private static String doc(final String screenKeys, final String elements) {
        return "{\"format\":1,\"title\":\"t\",\"width\":176,\"height\":166" + screenKeys
            + ",\"elements\":[" + elements + "]}";
    }

    private static Set<UiLint.Code> codesOf(final UiLint.Report r) {
        Set<UiLint.Code> out = EnumSet.noneOf(UiLint.Code.class);
        for (UiLint.Note n : r.notes()) {
            out.add(n.code());
        }
        return out;
    }

    /**
     * One document per code. Kept as a map rather than as separate test methods precisely so the
     * enumeration below can loop it: a new code with no entry here fails, and an entry that stops
     * producing its code fails too.
     */
    private static Map<UiLint.Code, String> cases() {
        Map<UiLint.Code, String> m = new LinkedHashMap<>();
        m.put(UiLint.Code.OUTSIDE_PANEL,
            doc("", "{\"kind\":\"panel\",\"id\":\"p\",\"x\":160,\"y\":8,\"w\":40,\"h\":20}"));
        m.put(UiLint.Code.OVERLAP,
            doc(",\"actions\":[\"a\",\"b\"]",
                "{\"kind\":\"button\",\"id\":\"one\",\"x\":8,\"y\":8,\"w\":50,\"text\":\"1\",\"action\":\"a\"},"
                    + "{\"kind\":\"button\",\"id\":\"two\",\"x\":20,\"y\":8,\"w\":50,\"text\":\"2\",\"action\":\"b\"}"));
        m.put(UiLint.Code.UNREACHABLE_SLOTS,
            doc(",\"containers\":[{\"name\":\"box\",\"size\":9}]",
                "{\"kind\":\"slot\",\"id\":\"s\",\"x\":8,\"y\":8,\"container\":\"box\",\"index\":0}"));
        m.put(UiLint.Code.PARTIAL_PLAYER_INVENTORY,
            doc("", "{\"kind\":\"slot_grid\",\"id\":\"hotbar\",\"x\":8,\"y\":8,\"cols\":9,\"rows\":1,"
                + "\"container\":\"player\"}"));
        m.put(UiLint.Code.UNUSED_CONTAINER,
            doc(",\"containers\":[{\"name\":\"box\",\"size\":1}]",
                "{\"kind\":\"label\",\"id\":\"l\",\"x\":8,\"y\":8,\"text\":\"hi\"}"));
        m.put(UiLint.Code.UNUSED_ACTION,
            doc(",\"actions\":[\"never\"]", "{\"kind\":\"label\",\"id\":\"l\",\"x\":8,\"y\":8,\"text\":\"hi\"}"));
        // A [3] arity with two buttons: the third id is a hook nothing calls, and an arity typed
        // one too large looks exactly like this (UI_PARTS_LIBRARY_DESIGN.md section 4.2).
        m.put(UiLint.Code.PARTIAL_ACTION_ARITY,
            doc(",\"actions\":[{\"name\":\"pick\",\"args\":[3]}]",
                "{\"kind\":\"button\",\"id\":\"a\",\"x\":8,\"y\":8,\"w\":20,\"text\":\"a\","
                    + "\"action\":\"pick\",\"args\":[0]},"
                    + "{\"kind\":\"button\",\"id\":\"b\",\"x\":8,\"y\":30,\"w\":20,\"text\":\"b\","
                    + "\"action\":\"pick\",\"args\":[1]}"));
        m.put(UiLint.Code.UNUSED_BINDING,
            doc(",\"bindings\":[{\"name\":\"v\",\"max\":10}]",
                "{\"kind\":\"label\",\"id\":\"l\",\"x\":8,\"y\":8,\"text\":\"hi\"}"));
        m.put(UiLint.Code.EMPTY_LAYOUT,
            doc("", "{\"kind\":\"row\",\"id\":\"r\",\"x\":8,\"y\":8,\"children\":[]}"));
        m.put(UiLint.Code.LABEL_OFF_PANEL,
            doc(",\"title_pos\":[8,200]", "{\"kind\":\"label\",\"id\":\"l\",\"x\":8,\"y\":8,\"text\":\"hi\"}"));
        return m;
    }

    // ---------------------------------------------------------------------------------------------

    @Test
    void everyCodeHasADocumentThatProducesIt() throws Exception {
        Map<UiLint.Code, String> cases = cases();
        for (UiLint.Code code : UiLint.Code.values()) {
            String json = cases.get(code);
            assertNotNull(json, code + " has no document that produces it: either it cannot fire, or"
                + " a case for it was never written");
            UiLint.Report r = UiLint.check(parse(json));
            assertTrue(codesOf(r).contains(code),
                code + " did not fire on the document written to produce it; got " + r.notes());
        }
    }

    @Test
    void theShippedExampleIsClean() throws Exception {
        try (InputStream in = UiLintTest.class.getResourceAsStream(EXAMPLE)) {
            assertNotNull(in, "the example document ships in the toolkit's resources");
            UiLint.Report r = UiLint.check(parse(new String(in.readAllBytes(), StandardCharsets.UTF_8)));
            assertTrue(r.clean(), "the conformance battery's own subject must lint clean: " + r.notes());
            // ...and it must NOT be clean because the lint looked at nothing. The example is mostly
            // layout nodes, so the blind spot is real and declared rather than hidden.
            assertTrue(r.unchecked() > 0, "the example has layout children, which have no static rect");
            assertFalse(r.why().isEmpty(), "an unchecked count with no reason is an unexplained gap");
            assertTrue(r.why().contains("check_layout"),
                "the reason must name where the answer IS, which is the live half: " + r.why());
        }
    }

    /**
     * The parser refuses what is invalid and the lint reports what is merely wrong; a document that
     * does not parse never reaches the lint at all. This pins the line between them - if the parser
     * ever started accepting one of these, its lint code would be the thing that has to notice.
     */
    @Test
    void aCleanDocumentProducesNothing() throws Exception {
        UiLint.Report r = UiLint.check(parse(doc(",\"actions\":[\"go\"]",
            "{\"kind\":\"panel\",\"id\":\"bg\",\"x\":0,\"y\":0,\"w\":176,\"h\":166},"
                + "{\"kind\":\"button\",\"id\":\"go\",\"x\":8,\"y\":8,\"w\":50,\"text\":\"Go\",\"action\":\"go\"}")));
        assertTrue(r.clean(), "nothing is wrong with this document: " + r.notes());
        assertEquals(0, r.unchecked(), "every element here is statically placed");
        assertEquals("", r.why());
    }

    @Test
    void aButtonOverAPanelIsNotAnOverlap() throws Exception {
        // Every screen draws its widgets on top of its background. A rule that flagged this would
        // fire on every real document and be turned off within a day.
        UiLint.Report r = UiLint.check(parse(doc(",\"actions\":[\"go\"]",
            "{\"kind\":\"panel\",\"id\":\"bg\",\"x\":0,\"y\":0,\"w\":176,\"h\":166},"
                + "{\"kind\":\"button\",\"id\":\"go\",\"x\":8,\"y\":8,\"w\":50,\"text\":\"Go\",\"action\":\"go\"}")));
        assertFalse(codesOf(r).contains(UiLint.Code.OVERLAP), r.notes().toString());
    }

    @Test
    void aButtonOverASlotIs() throws Exception {
        // ...but a slot the player cannot click is a broken screen, and this is the shape it takes.
        UiLint.Report r = UiLint.check(parse(doc(",\"actions\":[\"go\"],\"containers\":[{\"name\":\"box\",\"size\":1}]",
            "{\"kind\":\"slot\",\"id\":\"s\",\"x\":8,\"y\":8,\"container\":\"box\",\"index\":0},"
                + "{\"kind\":\"button\",\"id\":\"go\",\"x\":8,\"y\":8,\"w\":50,\"text\":\"Go\",\"action\":\"go\"}")));
        assertTrue(codesOf(r).contains(UiLint.Code.OVERLAP), r.notes().toString());
    }

    @Test
    void aBindingReadOnlyAsAnotherMaxCounts() throws Exception {
        // The example's `fuel_max` is named by `fuel`'s max and by nothing else. It IS read - by the
        // bar over `fuel` - and calling it unused would flag the shipped reference document.
        UiLint.Report r = UiLint.check(parse(doc(
            ",\"bindings\":[{\"name\":\"v\",\"max\":\"v_max\"},{\"name\":\"v_max\"}]",
            "{\"kind\":\"bar\",\"id\":\"b\",\"x\":8,\"y\":8,\"w\":60,\"h\":8,\"binding\":\"v\"}")));
        assertTrue(r.clean(), r.notes().toString());
    }

    @Test
    void unreachableSlotsNameTheirRange() throws Exception {
        UiLint.Report r = UiLint.check(parse(doc(",\"containers\":[{\"name\":\"box\",\"size\":9}]",
            "{\"kind\":\"slot\",\"id\":\"s\",\"x\":8,\"y\":8,\"container\":\"box\",\"index\":0}")));
        UiLint.Note note = r.notes().stream().filter(n -> n.code() == UiLint.Code.UNREACHABLE_SLOTS)
            .findFirst().orElseThrow();
        // A range, not eight numbers: it is what a human acts on, and it is what makes the message
        // survive a 36-slot container.
        assertTrue(note.message().contains("1..8"), note.message());
    }

    @Test
    void aLabelWithNoWidthIsUncheckedRatherThanClean() throws Exception {
        // The subtle one. A label's height is a constant; its natural WIDTH is the font's, and the
        // font is not on this classpath - so a label with no declared w cannot be checked against
        // the panel edge, and saying so is the difference between a blind spot and a lie.
        UiLint.Report r = UiLint.check(parse(doc("",
            "{\"kind\":\"label\",\"id\":\"l\",\"x\":170,\"y\":8,\"text\":\"a long label\"}")));
        assertTrue(r.clean(), "nothing statically known is wrong: " + r.notes());
        assertEquals(1, r.unchecked());
        assertTrue(r.why().contains("font"), r.why());
    }
}
