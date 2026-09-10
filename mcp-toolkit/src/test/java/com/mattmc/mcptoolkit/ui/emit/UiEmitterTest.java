package com.mattmc.mcptoolkit.ui.emit;

import com.mattmc.mcptoolkit.ui.Palette;
import com.mattmc.mcptoolkit.ui.doc.Element;
import com.mattmc.mcptoolkit.ui.doc.SlotPlan;
import com.mattmc.mcptoolkit.ui.doc.UiDocument;
import com.mattmc.mcptoolkit.ui.doc.UiParser;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.InputStream;
import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The emitter's contract, with no Minecraft on the classpath. Three things are load-bearing here:
 * the checked-in sample under {@code ui/sample} IS what the emitter produces today (so the live
 * comparison never runs against stale Java), the generated code imports nothing of this toolkit,
 * and the vendored paint and widget bodies are the interpreter's own (so a pixel comparison compares
 * renderers, not two drifted copies of a bevel).
 */
class UiEmitterTest {
    private static final String EXAMPLE = "/assets/mcptoolkit/ui/example.ui.json";
    private static final Path SRC = Path.of("src/main/java");
    private static final Path RESOURCES = Path.of("src/main/resources");
    private static final Path INTERP = SRC.resolve("com/mattmc/mcptoolkit/ui/interp");

    /** Where a generated file of each side lands, for the toolkit's own sample. */
    private static Path rootOf(final GeneratedFile f) {
        return switch (f.side()) {
            case COMMON, CLIENT -> SRC;
            case RESOURCES -> RESOURCES;
        };
    }

    private static UiDocument example() throws Exception {
        try (InputStream in = UiEmitterTest.class.getResourceAsStream(EXAMPLE)) {
            assertNotNull(in);
            return UiParser.parse(new String(in.readAllBytes(), StandardCharsets.UTF_8));
        }
    }

    private static EmitRequest sample() {
        return new EmitRequest("mcptoolkit", "com.mattmc.mcptoolkit.ui.sample", "example", Target.FABRIC);
    }

    // ---- the sample is never stale --------------------------------------------------------------

    @Test
    void checkedInSampleIsWhatTheEmitterProducesToday() throws Exception {
        assertTrue(Files.isDirectory(SRC), "run from the mcp-toolkit project root");
        Emission em = UiEmitter.emit(example(), sample());
        List<String> stale = new ArrayList<>();
        for (GeneratedFile f : em.files()) {
            Path on = rootOf(f).resolve(f.path());
            assertTrue(Files.isRegularFile(on), "the sample ships " + f.path());
            if (!f.isMachine()) {
                continue;
            }
            boolean same = f.isBinary()
                ? java.util.Arrays.equals(Files.readAllBytes(on), f.bytes())
                : UiGenerate.normalise(Files.readString(on)).equals(f.content());
            if (!same) {
                stale.add(f.path());
            }
        }
        assertEquals(List.of(), stale, "regenerate the sample: gradlew :generateUi (or the UiGenerate main)");
    }

    // ---- the no-dependency promise --------------------------------------------------------------

    @Test
    void generatedCodeImportsNothingOfTheToolkit() throws Exception {
        Emission em = UiEmitter.emit(example(), new EmitRequest("demo", "com.example.demo", "example", Target.FABRIC));
        for (GeneratedFile f : em.files()) {
            if (f.isBinary()) {
                continue; // a generated sheet has no imports; it has pixels
            }
            for (String line : f.content().split("\n")) {
                if (line.startsWith("import ")) {
                    assertFalse(line.contains("mcptoolkit"), f.path() + ": " + line);
                    assertTrue(line.startsWith("import net.minecraft") || line.startsWith("import java.")
                        || line.startsWith("import net.fabricmc.api.") || line.startsWith("import org.joml.")
                        || line.startsWith("import com.example.demo"),
                        f.path() + " imports outside vanilla + fabric-loader: " + line);
                }
            }
        }
        assertEquals(6, em.files().size(), "four Java files, the vendored one, and the generated sheet");
        assertEquals(2, em.files().stream().filter(f -> !f.isMachine()).count(), "two human stubs");
        assertEquals(1, em.files().stream().filter(GeneratedFile::isBinary).count(), "the sheet");
    }

    @Test
    void neoforgeIsDesignedForButRefusedByName() throws Exception {
        UiDocument doc = example();
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
            () -> UiEmitter.emit(doc, new EmitRequest("demo", "com.example.demo", "example", Target.NEOFORGE)));
        assertTrue(e.getMessage().contains("neoforge") && e.getMessage().contains("not built"), e.getMessage());
    }

    // ---- every element lands on the right side --------------------------------------------------

    @Test
    void everyDeclaredElementIsEmittedOnItsSide() throws Exception {
        UiDocument doc = example();
        Emission em = UiEmitter.emit(doc, sample());
        String layout = em.file("ExampleLayout").content();
        String menu = em.file("ExampleMenuBase").content();
        for (Element e : doc.flatten()) {
            if (e.id() == null || e.kind().isMacro()) {
                // A macro is expanded at parse time: what it became is checked, it is not.
                continue;
            }
            if (e.kind().isSlot()) {
                assertTrue(menu.contains("this.createSlot(\"" + e.id() + "\""), e.id() + " is a slot of the menu");
                assertFalse(layout.contains("\"" + e.id() + "\""), e.id() + " is not a widget");
            } else if (e.kind().isLayout()) {
                assertTrue(layout.contains("this.node(\"" + e.id() + "\", \"" + e.kind().jsonName() + "\""), e.id() + " is a node widget");
            } else {
                assertTrue(layout.contains("this.declare(\"" + e.id() + "\""), e.id() + " is declared in the layout");
            }
        }
        for (UiDocument.Action a : doc.actions()) {
            String hook = "protected abstract boolean on" + JavaNames.pascal(a.name()) + "(Player player";
            assertTrue(menu.contains(hook), a.name());
            assertTrue(menu.contains("ACTION_" + a.name().toUpperCase(Locale.ROOT)), a.name() + " has an id");
        }
        // The parameterised action (UI_PARTS_LIBRARY_DESIGN.md section 4.2): the stride exists once,
        // and BOTH halves of it are generated from that one declaration.
        assertTrue(menu.contains("public static final int ACTION_SELECT_INDEX_SIZE = 3;"), "the arity is a constant");
        assertTrue(menu.contains("protected abstract boolean onSelect(Player player, int index);"), "a named argument");
        assertTrue(menu.contains("if (id >= ACTION_SELECT && id < ACTION_SELECT + ACTION_SELECT_COUNT)"), "the block");
        assertTrue(layout.contains("protected void pressSelect(final int index)"), "one packer on the client");
        assertTrue(layout.contains("this.press(ExampleMenuBase.ACTION_SELECT + index);"), "and it is the only stride");
        for (UiDocument.Binding b : doc.bindings()) {
            assertTrue(menu.contains("protected abstract int supply" + JavaNames.pascal(b.name()) + "();"), b.name());
        }
        assertTrue(layout.contains("drawRegion_gauge("), "the region hook");
        assertTrue(layout.contains("(g, x, y, w, h, mx, my, pt) -> this.drawRegion_gauge(g, x, y, w, h, mx, my, pt)"),
            "the region widget calls its hook");
    }

    /**
     * The emitter-level falsifier (section 12): geometry the document changes by one pixel must
     * reach the machine-owned Layout file and ONLY that file. If it did not reach it, the pin above
     * would protect a file the comparison never reads; if it reached a stub too, a regenerate would
     * overwrite the human's half. Same button the live falsifier moves (UiFalsifier), one pixel wider
     * instead of one pixel right, so the two checks bracket the same widget from both sides.
     */
    @Test
    void aOnePixelChangeInTheDocumentReachesTheLayoutFileAndNothingElse() throws Exception {
        String text;
        try (InputStream in = UiEmitterTest.class.getResourceAsStream(EXAMPLE)) {
            assertNotNull(in);
            text = new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
        String nudged = text.replaceFirst("(\"id\": \"launch\",\\s*\"w\": )50", "$151");
        assertFalse(nudged.equals(text), "the example's Launch button is 50 wide");
        Emission before = UiEmitter.emit(UiParser.parse(text), sample());
        Emission after = UiEmitter.emit(UiParser.parse(nudged), sample());
        List<String> changed = new ArrayList<>();
        for (int i = 0; i < before.files().size(); i++) {
            GeneratedFile a = before.files().get(i);
            GeneratedFile b = after.files().get(i);
            assertEquals(a.path(), b.path());
            if (!a.content().equals(b.content())) {
                changed.add(a.path().substring(a.path().lastIndexOf('/') + 1));
            }
        }
        assertEquals(List.of("ExampleLayout.java"), changed,
            "one pixel of a WIDGET changes the Layout file and nothing else - not the menu, not a stub,"
                + " and not the generated sheet, which is painted from the boxes and slots only");
        assertTrue(before.file("ExampleLayout").content().contains("PressButton(\"launch\", 0, 0, 50, 20,"), "50 wide before");
        assertTrue(after.file("ExampleLayout").content().contains("PressButton(\"launch\", 0, 0, 51, 20,"), "51 wide after");
    }

    @Test
    void wideBindingsSplitOnTheWireAndReassembleOnTheClient() throws Exception {
        String menu = UiEmitter.emit(example(), sample()).file("ExampleMenuBase").content();
        assertTrue(menu.contains("DATA_FUEL_MAX_LOW"), "a wide binding takes two data slots");
        assertTrue(menu.contains("this.supplyFuelMax() >> 16") && menu.contains("this.supplyFuelMax() & 0xFFFF"), "split on the server");
        assertTrue(menu.contains("(this.synced[DATA_FUEL_MAX] << 16) | (this.synced[DATA_FUEL_MAX_LOW] & 0xFFFF)"),
            "reassembled on the client, low half masked because readShort sign-extends");
        assertTrue(menu.contains("private static final int DATA_COUNT = 5;"), "progress, fuel x2, fuel_max x2");
        assertTrue(menu.contains("McptoolkitUi") == false, "the menu base is common code and knows no client class");
    }

    @Test
    void slotPlanIsVanillaOrderWhateverTheDocumentOrder() throws Exception {
        SlotPlan plan = SlotPlan.of(example());
        assertEquals(4, plan.containerEnd(), "two written out, two from the station_inputs part");
        assertEquals(31, plan.backpackEnd());
        assertEquals(40, plan.hotbarEnd());
        assertEquals("fuel_slot", plan.entries().get(0).elementId());
        assertEquals("inputs.template", plan.entries().get(2).elementId(),
            "a part's slots are the menu's like any other, under their namespaced ids");
        assertEquals(9, plan.entries().get(4).index(), "backpack starts at inventory index 9");
        assertEquals(0, plan.entries().get(31).index(), "hotbar after the backpack, from index 0");
        // A document that lists the hotbar FIRST still plans backpack-then-hotbar.
        UiDocument flipped = UiParser.parse("{\"format\":1,\"title\":\"t\",\"width\":176,\"height\":166,\"elements\":["
            + "{\"kind\":\"slot_grid\",\"x\":8,\"y\":142,\"cols\":9,\"rows\":1,\"container\":\"player\"},"
            + "{\"kind\":\"slot_grid\",\"x\":8,\"y\":84,\"cols\":9,\"rows\":3,\"container\":\"player\",\"first\":9}]}");
        SlotPlan fp = SlotPlan.of(flipped);
        assertEquals(0, fp.containerEnd());
        assertEquals(27, fp.backpackEnd());
        assertEquals(36, fp.hotbarEnd());
        assertEquals(9, fp.entries().get(0).index());
    }

    @Test
    void namesAreJavaSafe() {
        assertEquals("FuelMax", JavaNames.pascal("fuel_max"));
        assertEquals("fuelMax", JavaNames.camel("fuel_max"));
        assertEquals("FUEL_MAX", JavaNames.constant("fuel_max"));
        assertEquals("default_", JavaNames.ident("default"));
        assertEquals("launch", JavaNames.ident("launch"));
        assertEquals("\"a \\\"q\\\" \\u00E9\"", JavaNames.str("a \"q\" \u00E9"));
        assertEquals("0xFF404040", JavaNames.argb(0xFF404040));
        assertEquals("RocketCockpit", new EmitRequest("m", "a.b", "rocket_cockpit", Target.FABRIC).screenClass());
        assertEquals("VillageJobsUi", new EmitRequest("village_jobs", "a.b", "x", Target.FABRIC).vendorClass());
        assertThrows(IllegalArgumentException.class, () -> new EmitRequest("m", "a.b", "Rocket-Cockpit", Target.FABRIC));
    }

    // ---- the vendored bodies are the interpreter's ----------------------------------------------

    @Test
    void vendoredPaintIsTheInterpretersPaintWithThePaletteInlined() throws Exception {
        String paint = Files.readString(INTERP.resolve("Paint.java"));
        String vendor = UiEmitter.vendor(sample());
        // The interpreter names colours; the vendored copy inlines them (it has no Palette). Substitute
        // every Palette constant by its value before comparing, from the class itself so a palette
        // change cannot leave this test comparing stale numbers.
        for (Field f : Palette.class.getDeclaredFields()) {
            if (Modifier.isStatic(f.getModifiers()) && f.getType() == int.class) {
                paint = paint.replace("Palette." + f.getName(), JavaNames.argb(f.getInt(null)));
            }
        }
        for (String m : List.of("panel", "well", "screenFrame", "bar", "barVertical", "slots")) {
            assertEquals(squash(body(paint, "public static void " + m + "(")), squash(body(vendor, "public static void " + m + "(")),
                "Paint." + m + " drifted between the interpreter and the vendored template");
        }
    }

    @Test
    void vendoredWidgetsDrawWhatTheInterpretersWidgetsDraw() throws Exception {
        String vendor = UiEmitter.vendor(sample());
        String label = Files.readString(INTERP.resolve("LabelWidget.java"));
        assertEquals(squash(body(label, "protected void extractWidgetRenderState(")),
            squash(body(vendor, "protected void extractWidgetRenderState(final GuiGraphicsExtractor g,")),
            "the label's draw body");
        assertEquals(squash(body(label, "private static int naturalHeight(")), squash(body(vendor, "private static int naturalHeight(")),
            "the label's natural height");
        String declared = Files.readString(INTERP.resolve("DeclaredWidgets.java"));
        assertEquals(squash(body(declared, "protected void extractContents(")), squash(body(vendor, "protected void extractContents(")),
            "the button's sprite overlay");
        String decor = Files.readString(INTERP.resolve("DecorWidget.java"));
        assertEquals(squash(body(decor, "protected void extractWidgetRenderState(")),
            squash(body(vendor, "protected void extractWidgetRenderState(final GuiGraphicsExtractor graphics, final int mouseX, final int mouseY, final float partialTick)")),
            "the decor painter call");
        // The parts-library widgets (UI_PARTS_LIBRARY_DESIGN.md sections 3.1, 3.2, 3.4). The entity
        // preview is the one with real arithmetic in it, so a drift here is a drift in what a screen
        // that shows an armour set actually LOOKS like - the exact thing the pixel battery would then
        // have to catch, one level too late.
        assertEquals(squash(body(declared, "private @Nullable LivingEntity livingSubject(")),
            squash(body(vendor, "private LivingEntity livingSubject(")), "EntityView.livingSubject");
        assertEquals(squash(body(declared, "private void equip(")), squash(body(vendor, "private void equip(")),
            "EntityView.equip - vanilla's own equipment routing, written once");
        assertEquals(squash(body(declared, "private @Nullable EntityRenderState renderState(")),
            squash(body(vendor, "private EntityRenderState renderState(")),
            "EntityView.renderState (the interpreter annotates the nullability the vendor cannot import)");
        assertEquals(squash(body(declared, "private @Nullable Entity subjectEntity(")),
            squash(body(vendor, "private Entity subjectEntity(")), "EntityView.subjectEntity");
        String paint = Files.readString(INTERP.resolve("Paint.java"));
        assertEquals(squash(body(paint, "public static void tooltips(")), squash(body(vendor, "public static void tooltips(")),
            "the tooltip hit test");
    }

    /** The brace-matched body after the first occurrence of {@code signatureStart}. */
    private static String body(final String src, final String signatureStart) {
        int at = src.indexOf(signatureStart);
        assertTrue(at >= 0, "no '" + signatureStart + "' in source");
        int open = src.indexOf('{', at);
        int depth = 0;
        for (int i = open; i < src.length(); i++) {
            char c = src.charAt(i);
            if (c == '{') {
                depth++;
            } else if (c == '}' && --depth == 0) {
                return src.substring(open, i + 1);
            }
        }
        throw new AssertionError("unbalanced braces after " + signatureStart);
    }

    private static String squash(final String s) {
        return s.replaceAll("//[^\n]*", "").replaceAll("\\s+", "");
    }

    // ---- the generator's file discipline --------------------------------------------------------

    @Test
    void machineFilesAreRewrittenAndStubsAreKept(@TempDir final Path tmp) throws Exception {
        // A real assets/<mod>/ui layout: the resources root is DERIVED from it (a mod's own parts
        // live under it, and a generated sheet lands in it), so a flat directory is not the shape.
        Path docs = tmp.resolve("resources/assets/demo/ui");
        Files.createDirectories(docs);
        try (InputStream in = UiEmitterTest.class.getResourceAsStream(EXAMPLE)) {
            Files.copy(in, docs.resolve("example.ui.json"));
        }
        Path common = tmp.resolve("common");
        Path client = tmp.resolve("client");
        UiGenerate.Report first = UiGenerate.run("demo", "com.example.demo", docs, common, client, Target.FABRIC, false, null);
        assertEquals(List.of(), first.problems(), "the toolkit's own parts resolve off the classpath");
        assertEquals(6, first.files().size());
        assertEquals(4, first.files().values().stream().filter(f -> f == UiGenerate.Fate.WRITTEN).count());
        assertTrue(Files.isRegularFile(tmp.resolve("resources/assets/mcptoolkit/textures/gui/example.png")),
            "the generated sheet lands under the resources root the documents directory named");
        assertEquals(2, first.files().values().stream().filter(f -> f == UiGenerate.Fate.STUB_WRITTEN).count());
        Path stub = common.resolve("com/example/demo/menu/ExampleMenu.java");
        Path machine = common.resolve("com/example/demo/menu/ExampleMenuBase.java");
        Files.writeString(stub, "// mine now\n");
        Files.writeString(machine, "// hand edited, will be lost\n");

        UiGenerate.Report check = UiGenerate.run("demo", "com.example.demo", docs, common, client, Target.FABRIC, true, null);
        assertTrue(check.drifted());
        assertEquals(UiGenerate.Fate.STALE, check.files().get(machine));
        assertEquals(UiGenerate.Fate.STUB_PRESENT, check.files().get(stub));
        assertEquals("// hand edited, will be lost\n", Files.readString(machine), "check writes nothing");

        UiGenerate.Report second = UiGenerate.run("demo", "com.example.demo", docs, common, client, Target.FABRIC, false, null);
        assertEquals(UiGenerate.Fate.WRITTEN, second.files().get(machine));
        assertEquals(UiGenerate.Fate.STUB_PRESENT, second.files().get(stub));
        assertEquals("// mine now\n", Files.readString(stub), "a stub is never overwritten");
        assertTrue(Files.readString(machine).contains("GENERATED"), "a machine file is");
        Files.delete(stub);
        UiGenerate.Report missing = UiGenerate.run("demo", "com.example.demo", docs, common, client, Target.FABRIC, true, null);
        assertEquals(UiGenerate.Fate.STUB_MISSING, missing.files().get(stub));
        assertTrue(missing.drifted(), "a missing stub is drift: the mod would not compile");
        Map<String, List<String>> notes = missing.notes();
        assertTrue(notes.get("example").stream().anyMatch(n -> n.contains("Registry.register(BuiltInRegistries.MENU")),
            "the registration line is reported: " + notes.get("example"));
        assertTrue(notes.get("example").stream().anyMatch(n -> n.contains("is GENERATED from this document")),
            "and so is the sheet, which is not a file anyone should hand-edit"); 
    }
}
