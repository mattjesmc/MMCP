package com.mattmc.mcptoolkit.ui.doc;

import org.junit.jupiter.api.Test;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.EnumSet;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The model's contract, with no Minecraft on the classpath - which is itself the test that the model
 * imports none (SCREEN_AUTHORING_DESIGN.md section 7.1): this source set has no Minecraft dependency
 * beyond what {@code main} compiles against, and a {@code net.minecraft} import in {@code ui.doc}
 * would still compile here, so the compile-time half of that rule is pinned by
 * {@link #modelImportsNoMinecraft()} reading the sources.
 */
class UiDocumentTest {
    private static final String EXAMPLE = "/assets/mcptoolkit/ui/example.ui.json";

    private static String example() throws Exception {
        try (InputStream in = UiDocumentTest.class.getResourceAsStream(EXAMPLE)) {
            assertNotNull(in, "the example document ships in the toolkit's resources");
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    /** A minimal valid document around the given elements JSON, with one of everything to reference. */
    private static String doc(final String elements) {
        return "{\"format\":1,\"title\":\"t\",\"width\":176,\"height\":166,"
            + "\"containers\":[{\"name\":\"input\",\"size\":3}],"
            + "\"actions\":[\"launch\"],"
            + "\"bindings\":[{\"name\":\"progress\",\"max\":200},{\"name\":\"nomax\"}],"
            + "\"elements\":[" + elements + "]}";
    }

    private static UiParseException refused(final String json) {
        return assertThrows(UiParseException.class, () -> UiParser.parse(json));
    }

    // ---- the registry ---------------------------------------------------------------------------

    @Test
    void exampleCoversEveryRegisteredKind() throws Exception {
        UiDocument doc = UiParser.parse(example());
        assertEquals(EnumSet.allOf(Kind.class), doc.kindsUsed(),
            "the shipped example is the living reference: every registered kind renders in it");
    }

    @Test
    void everyKindHasAPropertyTable() {
        for (Kind k : Kind.values()) {
            assertNotNull(UiParser.propertyKeys(k), k.name());
        }
    }

    @Test
    void unknownKindIsRefusedByNameWithTheRegistry() {
        UiParseException e = refused(doc("{\"kind\":\"gauge\",\"x\":0,\"y\":0}"));
        String msg = e.getMessage();
        assertTrue(msg.contains("unknown kind 'gauge'"), msg);
        for (String name : Kind.names()) {
            assertTrue(msg.contains(name), "the refusal lists " + name);
        }
    }

    // ---- the round trip -------------------------------------------------------------------------

    @Test
    void parseWriteParseIsIdentical() throws Exception {
        UiDocument once = UiParser.parse(example());
        String written = UiWriter.toJson(once);
        UiDocument twice = UiParser.parse(written);
        assertEquals(once, twice, "parse -> serialize -> parse yields an identical tree");
        assertEquals(written, UiWriter.toJson(twice), "and the canonical text is a fixed point");
    }

    @Test
    void exampleIsInCanonicalForm() throws Exception {
        String text = example().replace("\r\n", "\n");
        assertEquals(UiWriter.toJson(UiParser.parse(text)), text,
            "the shipped example is written the way the writer writes, so an editor save is a minimal diff");
    }

    @Test
    void defaultsAreOmittedAndRestored() throws Exception {
        UiDocument doc = UiParser.parse(doc("{\"kind\":\"label\",\"id\":\"a\",\"x\":1,\"y\":2,\"text\":\"hi\"}"));
        Element.Label l = (Element.Label) doc.byId("a");
        assertEquals(Element.LabelMode.PLAIN, l.mode());
        assertEquals(com.mattmc.mcptoolkit.ui.Palette.LABEL_COLOR, l.color());
        String json = UiWriter.toJson(doc);
        assertTrue(!json.contains("\"mode\"") && !json.contains("\"color\"") && !json.contains("title_pos"),
            "defaults are not written:\n" + json);
        assertEquals(doc, UiParser.parse(json));
    }

    @Test
    void translationKeysSurviveTheRoundTrip() throws Exception {
        UiDocument doc = UiParser.parse(doc("{\"kind\":\"label\",\"x\":1,\"y\":2,\"text\":{\"translate\":\"gui.x.y\"}}"));
        Element.Label l = (Element.Label) doc.elements().get(0);
        assertTrue(l.text().isTranslation());
        assertEquals(doc, UiParser.parse(UiWriter.toJson(doc)));
    }

    // ---- the lint -------------------------------------------------------------------------------

    @Test
    void slotInsideALayoutIsRefused() {
        String msg = refused(doc("{\"kind\":\"row\",\"x\":0,\"y\":0,\"children\":["
            + "{\"kind\":\"slot\",\"container\":\"input\",\"index\":0}]}")).getMessage();
        assertTrue(msg.contains("cannot sit inside a layout"), msg);
    }

    @Test
    void referencesResolveAgainstDeclarations() {
        assertTrue(refused(doc("{\"kind\":\"button\",\"x\":0,\"y\":0,\"w\":40,\"text\":\"go\",\"action\":\"fly\"}"))
            .getMessage().contains("undeclared action 'fly'"));
        assertTrue(refused(doc("{\"kind\":\"bar\",\"x\":0,\"y\":0,\"w\":40,\"h\":8,\"binding\":\"heat\"}"))
            .getMessage().contains("undeclared binding 'heat'"));
        assertTrue(refused(doc("{\"kind\":\"bar\",\"x\":0,\"y\":0,\"w\":40,\"h\":8,\"binding\":\"nomax\"}"))
            .getMessage().contains("declares no max"));
        assertTrue(refused(doc("{\"kind\":\"slot\",\"x\":0,\"y\":0,\"container\":\"output\",\"index\":0}"))
            .getMessage().contains("undeclared container 'output'"));
        assertTrue(refused(doc("{\"kind\":\"slot\",\"x\":0,\"y\":0,\"container\":\"input\",\"index\":3}"))
            .getMessage().contains("exceed container 'input'"));
        assertTrue(refused(doc("{\"kind\":\"slot_grid\",\"x\":0,\"y\":0,\"cols\":2,\"rows\":2,\"container\":\"input\"}"))
            .getMessage().contains("exceed container 'input'"));
    }

    @Test
    void oneSlotIndexInTwoPlacesIsRefused() {
        String msg = refused(doc("{\"kind\":\"slot\",\"x\":0,\"y\":0,\"container\":\"input\",\"index\":1},"
            + "{\"kind\":\"slot_grid\",\"x\":0,\"y\":20,\"cols\":3,\"rows\":1,\"container\":\"input\"}")).getMessage();
        assertTrue(msg.contains("declared twice"), msg);
    }

    @Test
    void playerContainerIsImplicitAndReserved() throws Exception {
        UiDocument ok = UiParser.parse(doc("{\"kind\":\"slot_grid\",\"x\":8,\"y\":84,\"cols\":9,\"rows\":4,\"container\":\"player\"}"));
        assertEquals(36, ok.containerSize("player"));
        String msg = assertThrows(UiParseException.class, () -> UiParser.parse(
            "{\"format\":1,\"title\":\"t\",\"width\":1,\"height\":1,\"containers\":[{\"name\":\"player\",\"size\":9}],\"elements\":[]}"))
            .getMessage();
        assertTrue(msg.contains("reserved"), msg);
    }

    @Test
    void placementKeysOfTheOtherModeAreRefused() {
        assertTrue(refused(doc("{\"kind\":\"panel\",\"x\":0,\"y\":0,\"w\":1,\"h\":1,\"offset\":[1,1]}"))
            .getMessage().contains("only applies inside a layout"));
        assertTrue(refused(doc("{\"kind\":\"row\",\"x\":0,\"y\":0,\"children\":[{\"kind\":\"panel\",\"x\":3,\"w\":1,\"h\":1}]}"))
            .getMessage().contains("ignored inside a layout"));
        assertTrue(refused(doc("{\"kind\":\"row\",\"x\":0,\"y\":0,\"children\":[{\"kind\":\"panel\",\"row\":0,\"col\":0,\"w\":1,\"h\":1}]}"))
            .getMessage().contains("child of a grid"));
        assertTrue(refused(doc("{\"kind\":\"spacer\",\"x\":0,\"y\":0,\"w\":4}"))
            .getMessage().contains("only means something inside"));
    }

    @Test
    void unknownKeysAreProblemsNotSilence() {
        String msg = refused(doc("{\"kind\":\"label\",\"x\":0,\"y\":0,\"text\":\"a\",\"colour\":\"#FF000000\"}")).getMessage();
        assertTrue(msg.contains("colour") && msg.contains("unknown key"), msg);
    }

    @Test
    void idsAreUniqueNamesAndRegionsAreNamed() {
        assertTrue(refused(doc("{\"kind\":\"panel\",\"id\":\"a\",\"x\":0,\"y\":0,\"w\":1,\"h\":1},"
            + "{\"kind\":\"panel\",\"id\":\"a\",\"x\":0,\"y\":0,\"w\":1,\"h\":1}")).getMessage().contains("duplicate id 'a'"));
        assertTrue(refused(doc("{\"kind\":\"panel\",\"id\":\"Bad-Name\",\"x\":0,\"y\":0,\"w\":1,\"h\":1}"))
            .getMessage().contains("not a name"));
        assertTrue(refused(doc("{\"kind\":\"region\",\"x\":0,\"y\":0,\"w\":1,\"h\":1}"))
            .getMessage().contains("must be named"));
    }

    @Test
    void everyProblemIsCollectedNotJustTheFirst() {
        UiParseException e = refused(doc("{\"kind\":\"nope\"},"
            + "{\"kind\":\"button\",\"x\":0,\"y\":0,\"w\":40,\"text\":\"go\",\"action\":\"fly\"},"
            + "{\"kind\":\"region\",\"x\":0,\"y\":0,\"w\":1,\"h\":1}"));
        List<UiParseException.Problem> ps = e.problems();
        assertEquals(3, ps.size(), e.getMessage());
        assertEquals("elements[0].kind", ps.get(0).path());
        assertEquals("elements[2].id", ps.get(1).path());
        assertEquals("elements[1].action", ps.get(2).path(), "reference problems come after structural ones");
    }

    @Test
    void wideBindingsAndBindingMaxChainsParse() throws Exception {
        UiDocument doc = UiParser.parse("{\"format\":1,\"title\":\"t\",\"width\":1,\"height\":1,"
            + "\"bindings\":[{\"name\":\"fuel\",\"max\":\"cap\",\"wide\":true},{\"name\":\"cap\",\"wide\":true,\"preview\":70000}],"
            + "\"elements\":[]}");
        assertEquals("cap", doc.binding("fuel").maxBinding());
        assertTrue(doc.binding("cap").wide());
        assertEquals(70000, doc.binding("cap").preview());
        assertEquals(doc, UiParser.parse(UiWriter.toJson(doc)));
    }

    @Test
    void theSixteenBitWireIsALint() {
        // ContainerData is sent as shorts. A value that cannot fit, or a max that lets it grow past
        // one, is a wrap the interpreter can never show - the example document carried exactly this
        // (fuel 42000, not wide) until the generated screen's gauge came up empty (slice 2).
        String head = "{\"format\":1,\"title\":\"t\",\"width\":1,\"height\":1,\"elements\":[],\"bindings\":[";
        assertTrue(refused(head + "{\"name\":\"fuel\",\"preview\":42000}]}").getMessage().contains("16-bit"), "preview");
        assertTrue(refused(head + "{\"name\":\"fuel\",\"max\":100000}]}").getMessage().contains("16-bit"), "literal max");
        String msg = refused(head + "{\"name\":\"fuel\",\"max\":\"cap\"},{\"name\":\"cap\",\"wide\":true}]}").getMessage();
        assertTrue(msg.contains("'cap', which is wide"), msg);
        assertDoesNotThrow(() -> UiParser.parse(head + "{\"name\":\"fuel\",\"preview\":42000,\"wide\":true}]}"));
        assertDoesNotThrow(() -> UiParser.parse(head + "{\"name\":\"fuel\",\"preview\":32767,\"max\":32767}]}"));
    }

    // ---- the primitives the parts-library design found missing (sections 3.2, 3.3, 3.4, 4.2) ----

    @Test
    void aTooltipIsTextOrAHookAndNothingElse() throws Exception {
        UiDocument doc = UiParser.parse(doc("{\"kind\":\"label\",\"id\":\"a\",\"x\":1,\"y\":2,\"text\":\"hi\","
            + "\"tooltip\":\"why\"},"
            + "{\"kind\":\"label\",\"id\":\"b\",\"x\":1,\"y\":20,\"text\":\"hi\","
            + "\"tooltip\":{\"hook\":\"lines\"}},"
            + "{\"kind\":\"label\",\"id\":\"c\",\"x\":1,\"y\":40,\"text\":\"hi\","
            + "\"tooltip\":{\"translate\":\"gui.x\"}}"));
        assertEquals("why", doc.byId("a").deco().tooltip().text().literal());
        assertTrue(doc.byId("b").deco().tooltip().isHook());
        assertEquals("lines", doc.byId("b").deco().tooltip().hook());
        assertTrue(doc.byId("c").deco().tooltip().text().isTranslation());
        assertEquals(doc, UiParser.parse(UiWriter.toJson(doc)), "and every form round trips");
        // A slot is the MENU's, not a widget: its emptiness is an icon and its visibility is
        // Slot.isActive, so the decorations do not apply and saying so beats ignoring it.
        assertTrue(refused(doc("{\"kind\":\"slot\",\"x\":0,\"y\":0,\"container\":\"input\",\"index\":0,"
            + "\"tooltip\":\"x\"}")).getMessage().contains("unknown key"));
    }

    @Test
    void aPredicateIsABareBindingOrOneComparator() throws Exception {
        UiDocument doc = UiParser.parse(doc("{\"kind\":\"button\",\"id\":\"go\",\"x\":0,\"y\":0,\"w\":40,"
            + "\"text\":\"go\",\"action\":\"launch\",\"enabled\":\"progress\","
            + "\"visible\":{\"binding\":\"progress\",\"gt\":10}}"));
        Element.Decoration deco = doc.byId("go").deco();
        assertEquals(Element.Cmp.NE, deco.enabled().cmp());
        assertEquals(0, deco.enabled().value(), "a bare binding name is the != 0 case");
        assertEquals(Element.Cmp.GT, deco.visible().cmp());
        assertEquals(10, deco.visible().value());
        assertTrue(deco.stateful());
        assertEquals(doc, UiParser.parse(UiWriter.toJson(doc)));

        assertTrue(refused(doc("{\"kind\":\"button\",\"x\":0,\"y\":0,\"w\":40,\"text\":\"g\","
            + "\"action\":\"launch\",\"enabled\":\"heat\"}")).getMessage().contains("undeclared binding 'heat'"));
        assertTrue(refused(doc("{\"kind\":\"button\",\"x\":0,\"y\":0,\"w\":40,\"text\":\"g\","
            + "\"action\":\"launch\",\"visible\":{\"binding\":\"progress\",\"gt\":1,\"lt\":9}}"))
            .getMessage().contains("two comparators"), "one binding, once - a conjunction is a language");
        // Only a button can be inactive; everything else is drawn or hidden.
        assertTrue(refused(doc("{\"kind\":\"label\",\"x\":0,\"y\":0,\"text\":\"a\",\"enabled\":\"progress\"}"))
            .getMessage().contains("only a button can be enabled"));
    }

    @Test
    void anIconNamesOneSourceAndAButtonWithNoFaceNeedsASprite() throws Exception {
        UiDocument doc = UiParser.parse(doc("{\"kind\":\"icon\",\"id\":\"a\",\"x\":0,\"y\":0,\"w\":8,\"h\":8,"
            + "\"texture\":\"mymod:textures/gui/x.png\",\"u\":16,\"v\":32,\"src_w\":16,\"src_h\":16,"
            + "\"sheet_w\":64,\"sheet_h\":64,\"color\":\"#80FFFFFF\"}"));
        Element.Icon icon = (Element.Icon) doc.byId("a");
        assertNull(icon.sprite());
        assertEquals(16, icon.sheet().u());
        assertEquals(16, icon.sheet().srcW(), "8 drawn from 16 sampled IS the half scale, in one blit");
        assertEquals(64, icon.sheet().sheetW());
        assertEquals(doc, UiParser.parse(UiWriter.toJson(doc)));

        assertTrue(refused(doc("{\"kind\":\"icon\",\"x\":0,\"y\":0,\"w\":8,\"h\":8}"))
            .getMessage().contains("name ONE source"));
        assertTrue(refused(doc("{\"kind\":\"icon\",\"x\":0,\"y\":0,\"w\":8,\"h\":8,"
            + "\"sprite\":\"minecraft:icon/checkmark\",\"u\":2}"))
            .getMessage().contains("only applies to a 'texture' icon"));
        assertTrue(refused(doc("{\"kind\":\"button\",\"x\":0,\"y\":0,\"w\":10,\"text\":\"\","
            + "\"action\":\"launch\",\"face\":\"none\"}"))
            .getMessage().contains("invisible button"));
    }

    @Test
    void anEntityNamesASubjectAndOnlyAStandWearsSlots() throws Exception {
        UiDocument doc = UiParser.parse(doc("{\"kind\":\"slot\",\"id\":\"head\",\"x\":0,\"y\":0,"
            + "\"container\":\"input\",\"index\":0},"
            + "{\"kind\":\"entity\",\"id\":\"who\",\"x\":40,\"y\":0,\"w\":40,\"h\":60,"
            + "\"subject\":\"armor_stand\",\"equipment\":[\"head\"],\"scale\":20,\"pitch\":25,"
            + "\"yaw\":210,\"draggable\":true}"));
        Element.Entity e = (Element.Entity) doc.byId("who");
        assertTrue(e.subject().isArmorStand());
        assertEquals(List.of("head"), e.subject().equipment());
        assertEquals(20.0F, e.scale());
        assertFalse(e.followMouse(), "only the player follows the pointer by default");
        assertEquals(doc, UiParser.parse(UiWriter.toJson(doc)));

        assertTrue(refused(doc("{\"kind\":\"entity\",\"x\":0,\"y\":0,\"w\":10,\"h\":10,"
            + "\"subject\":\"player\",\"equipment\":[\"nope\"]}"))
            .getMessage().contains("has no equipment to put on"));
        assertTrue(refused(doc("{\"kind\":\"label\",\"id\":\"l\",\"x\":0,\"y\":0,\"text\":\"a\"},"
            + "{\"kind\":\"entity\",\"x\":0,\"y\":0,\"w\":10,\"h\":10,\"subject\":\"armor_stand\","
            + "\"equipment\":[\"l\"]}")).getMessage().contains("equipment names a slot"));
    }

    @Test
    void anActionsArityIsCheckedWhereTheButtonIsWritten() throws Exception {
        String head = "{\"format\":1,\"title\":\"t\",\"width\":176,\"height\":166,\"actions\":["
            + "\"apply\",{\"name\":\"pick\",\"args\":[{\"name\":\"row\",\"size\":5},3]}],\"elements\":[";
        UiDocument doc = UiParser.parse(head + "{\"kind\":\"button\",\"id\":\"b\",\"x\":0,\"y\":0,\"w\":10,"
            + "\"text\":\"p\",\"action\":\"pick\",\"args\":[2,1]}]}");
        // The id block: apply is 0, pick is 1..15, and the button presses 1 + (2 * 3 + 1).
        assertEquals(0, doc.actionId("apply"));
        assertEquals(1, doc.actionId("pick"));
        assertEquals(16, doc.actionIdCount());
        assertEquals(1 + 7, doc.actionId("pick", List.of(2, 1)));
        assertEquals("row", doc.action("pick").args().get(0).name());
        assertEquals("arg1", doc.action("pick").args().get(1).name(), "an unnamed argument is positional");
        assertEquals(doc, UiParser.parse(UiWriter.toJson(doc)));

        // An index outside the declared block is a click that would land on ANOTHER action, silently,
        // on the server - which is the whole reason the arity is declared at all.
        assertTrue(assertThrows(UiParseException.class, () -> UiParser.parse(head
            + "{\"kind\":\"button\",\"x\":0,\"y\":0,\"w\":10,\"text\":\"p\",\"action\":\"pick\","
            + "\"args\":[5,0]}]}")).getMessage().contains("outside the declared 0..4"));
        assertTrue(assertThrows(UiParseException.class, () -> UiParser.parse(head
            + "{\"kind\":\"button\",\"x\":0,\"y\":0,\"w\":10,\"text\":\"p\",\"action\":\"pick\"}]}"))
            .getMessage().contains("takes 2 argument(s)"));
    }

    // ---- the constraint that is cheap now and expensive later ---------------------------------

    @Test
    void modelAndEmitterImportNoMinecraft() throws Exception {
        // Both packages: the emitter runs from a Gradle task with no game on the classpath, and the
        // model is what it reads. UiGenerate's main is the proof, this is the pin.
        for (String pkg : new String[] {"doc", "emit"}) {
            java.nio.file.Path dir = java.nio.file.Path.of("src/main/java/com/mattmc/mcptoolkit/ui/" + pkg);
            assertTrue(java.nio.file.Files.isDirectory(dir), "run from the mcp-toolkit project root: " + dir.toAbsolutePath());
            try (var files = java.nio.file.Files.list(dir)) {
                for (java.nio.file.Path f : (Iterable<java.nio.file.Path>) files::iterator) {
                    // Import LINES, not substrings: the emitter legitimately mentions import statements
                    // in string literals (it prints and strips them).
                    for (String line : java.nio.file.Files.readAllLines(f)) {
                        if (!line.startsWith("import ")) {
                            continue;
                        }
                        assertTrue(!line.startsWith("import net.minecraft") && !line.startsWith("import net.fabricmc")
                                && !line.startsWith("import com.mattmc.mcptoolkit.ui.interp") && !line.startsWith("import org.jspecify"),
                            f.getFileName() + " imports Minecraft or the interpreter; ui." + pkg + " must not (section 7.1): " + line);
                    }
                }
            }
        }
        String palette = java.nio.file.Files.readString(java.nio.file.Path.of("src/main/java/com/mattmc/mcptoolkit/ui/Palette.java"));
        assertTrue(!palette.contains("import net.minecraft"), "Palette is shared with the model and must not import Minecraft");
    }
}
