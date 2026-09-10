package com.mattmc.mcptoolkit.ui.emit;

import com.mattmc.mcptoolkit.ui.doc.Element;
import com.mattmc.mcptoolkit.ui.doc.Element.Placement;
import com.mattmc.mcptoolkit.ui.doc.Kind;
import com.mattmc.mcptoolkit.ui.doc.SlotPlan;
import com.mattmc.mcptoolkit.ui.doc.Text;
import com.mattmc.mcptoolkit.ui.doc.UiDocument;
import com.mattmc.mcptoolkit.ui.doc.UiDocument.Action;
import com.mattmc.mcptoolkit.ui.doc.UiDocument.Arg;
import com.mattmc.mcptoolkit.ui.doc.UiDocument.Binding;
import com.mattmc.mcptoolkit.ui.doc.UiParser;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.TreeSet;

/**
 * <b>The screen compiler</b> (SCREEN_AUTHORING_DESIGN.md sections 7, 8, 11): a {@link UiDocument} to
 * plain vanilla-API Java the mod ships, with no runtime dependency on this toolkit or on anything.
 *
 * <p>Imports NOTHING from Minecraft, and {@code UiDocumentTest} reads this package's sources to keep
 * it so (section 7.1): the same emitter runs inside the dev game (the editor's save, {@code ui_doc
 * op:"generate"}) and from a Gradle task with no game on the classpath ({@link UiGenerate}). One
 * emitter, or the two would drift one level below where the conformance check looks.
 *
 * <p>What comes out, per screen {@code X} (section 7):
 * <table>
 *   <tr><td>{@code menu/XMenuBase}</td><td>MACHINE</td><td>slots from the {@link SlotPlan}, the
 *       ContainerData over abstract suppliers (16-bit split for {@code wide}), {@code clickMenuButton}
 *       dispatch to abstract {@code onX} hooks, vanilla's {@code quickMoveStack}</td></tr>
 *   <tr><td>{@code menu/XMenu}</td><td>HUMAN, once</td><td>the stub: {@code TYPE}, the client
 *       constructor, empty suppliers and actions</td></tr>
 *   <tr><td>{@code client/XLayout}</td><td>MACHINE</td><td>every element as a widget, layouts
 *       arranged exactly as the interpreter arranges them, wells, labels, {@code drawRegion_*} hooks</td></tr>
 *   <tr><td>{@code client/XScreen}</td><td>HUMAN, once</td><td>the stub</td></tr>
 *   <tr><td>{@code client/<Mod>Ui}</td><td>MACHINE, per mod</td><td>the vendored widgets and paint
 *       primitives - the interpreter's own bodies, inlined</td></tr>
 * </table>
 *
 * <p>The {@code switch} over {@link Element} is exhaustive, so a kind added to the registry without
 * an emission here is a compile error - the same enforcement the interpreter's {@code WidgetBuilder}
 * has, for the other renderer.
 */
public final class UiEmitter {
    /** The vendored file's template, a resource so the test can read it beside the interpreter's sources. */
    public static final String VENDOR_TEMPLATE = "/mcptoolkit/ui/templates/ModUi.java.txt";

    private static final String LABEL_COLOR = JavaNames.argb(0xFF404040);

    private final UiDocument doc;
    private final EmitRequest req;
    private final SlotPlan plan;
    private final List<String> notes = new ArrayList<>();

    private UiEmitter(final UiDocument doc, final EmitRequest req) {
        this.doc = doc;
        this.req = req;
        this.plan = SlotPlan.of(doc);
    }

    /** Compile one document. Throws for a target that is designed for but not built. */
    public static Emission emit(final UiDocument doc, final EmitRequest req) {
        if (!req.target().isBuilt()) {
            throw new IllegalArgumentException("target '" + req.target().jsonName() + "' is designed for but not"
                + " built yet (SCREEN_AUTHORING_DESIGN.md section 11); use 'fabric'");
        }
        UiEmitter e = new UiEmitter(doc, req);
        List<GeneratedFile> files = new ArrayList<>();
        files.add(GeneratedFile.source(path(req.menuPackage(), req.menuBaseClass()), GeneratedFile.Side.COMMON,
            GeneratedFile.Owner.MACHINE, e.menuBase()));
        files.add(GeneratedFile.source(path(req.menuPackage(), req.menuClass()), GeneratedFile.Side.COMMON,
            GeneratedFile.Owner.HUMAN_STUB, e.menuStub()));
        files.add(GeneratedFile.source(path(req.clientPackage(), req.layoutClass()), GeneratedFile.Side.CLIENT,
            GeneratedFile.Owner.MACHINE, e.layout()));
        files.add(GeneratedFile.source(path(req.clientPackage(), req.screenClassName()), GeneratedFile.Side.CLIENT,
            GeneratedFile.Owner.HUMAN_STUB, e.screenStub()));
        files.add(GeneratedFile.source(path(req.clientPackage(), req.vendorClass()), GeneratedFile.Side.CLIENT,
            GeneratedFile.Owner.MACHINE, vendor(req)));
        if (doc.sheet() != null) {
            files.add(GeneratedFile.binary(UiSheet.path(doc.sheet()), GeneratedFile.Side.RESOURCES,
                UiSheet.render(doc)));
            e.notes.add("the background sheet " + doc.sheet().texture() + " is GENERATED from this document's"
                + " own frame, panels, wells and slots (UI_PARTS_LIBRARY_DESIGN.md section 3.6) - do not hand-edit"
                + " the PNG, move the boxes");
        }
        e.notes.add(req.target().registerMenuTypeHint(req.modId(), req.screenId(), req.menuClass()));
        e.notes.add(req.target().registerScreenHint(req.menuClass(), req.screenClassName()));
        e.notes.add(req.target().registrationAccessHint());
        if (req.target() == Target.FABRIC) {
            e.notes.add("no fabric-api needed: this screen declares no open payload, so the output is vanilla"
                + " plus fabric-loader's @Environment (section 11)");
        }
        return new Emission(req, files, e.notes);
    }

    private static String path(final String pkg, final String cls) {
        return pkg.replace('.', '/') + "/" + cls + ".java";
    }

    /** The vendored {@code <Mod>Ui.java}: the template with its package and class filled in. */
    public static String vendor(final EmitRequest req) {
        String t;
        try (InputStream in = UiEmitter.class.getResourceAsStream(VENDOR_TEMPLATE)) {
            if (in == null) {
                throw new IllegalStateException("vendor template missing from the toolkit jar: " + VENDOR_TEMPLATE);
            }
            t = new String(in.readAllBytes(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new IllegalStateException("cannot read " + VENDOR_TEMPLATE, e);
        }
        t = t.replace("\r\n", "\n");
        t = t.replace("${package}", req.clientPackage()).replace("${class}", req.vendorClass())
            .replace("${toolkitVersion}", "format " + UiDocument.FORMAT);
        if (req.target().clientAnnotation() == null) {
            t = t.replace("import net.fabricmc.api.EnvType;\nimport net.fabricmc.api.Environment;\n", "")
                .replace("@Environment(EnvType.CLIENT)\n", "");
        }
        return t;
    }

    // =============================================================================================
    // The menu base (common)
    // =============================================================================================

    private void header(final JavaWriter w, final String what) {
        List<String> lines = new ArrayList<>(List.of(
            "GENERATED from " + req.documentPath() + " by the mcp-toolkit screen compiler - DO NOT EDIT.",
            "Regenerated on every save of the document; hand edits are lost. Behaviour goes in the",
            "subclass (SCREEN_AUTHORING_DESIGN.md section 7).",
            "",
            what));
        // The parts this screen was compiled from, with the hash of each part FILE
        // (UI_PARTS_LIBRARY_DESIGN.md section 5.3): vendoring means a part bug ships N times and the
        // part's own text is copied into no repository, so a generated file that did not name the
        // version it came from would leave nothing to grep.
        List<Element.Part> parts = UiParser.partsUsed(doc);
        if (!parts.isEmpty()) {
            lines.add("");
            lines.add("Parts used (UI_PARTS_LIBRARY_DESIGN.md section 5):");
            TreeSet<String> seen = new TreeSet<>();
            for (Element.Part part : parts) {
                seen.add("  " + part.part() + " #" + part.hash() + " as " + part.id());
            }
            lines.addAll(seen);
        }
        w.doc(lines.toArray(new String[0]));
    }

    private String menuBase() {
        JavaWriter w = new JavaWriter();
        imports = new TreeSet<>(List.of(
            "net.minecraft.network.chat.Component",
            "net.minecraft.world.Container",
            "net.minecraft.world.entity.player.Inventory",
            "net.minecraft.world.entity.player.Player",
            "net.minecraft.world.inventory.AbstractContainerMenu",
            "net.minecraft.world.inventory.ContainerData",
            "net.minecraft.world.inventory.MenuType",
            "net.minecraft.world.inventory.Slot",
            "net.minecraft.world.item.ItemStack"));
        TreeSet<String> imports = this.imports;
        String cls = req.menuBaseClass();

        header(w, "The menu's machine half: the slot list (section 4.5, one declaration, both sides), the"
            + " synced ints (section 8.2), the action dispatch (section 8.1) and vanilla's shift-click.");
        w.open("public abstract class " + cls + " extends AbstractContainerMenu");

        // --- constants ---
        w.line("/** The document's title: what a MenuProvider's getDisplayName answers. */");
        w.line("public static final Component TITLE = " + component(doc.title()) + ";");
        w.blank();
        if (!doc.containers().isEmpty()) {
            w.line("// The declared containers' sizes, in document order.");
            for (UiDocument.Container c : doc.containers()) {
                w.line("public static final int " + JavaNames.constant(c.name()) + "_SIZE = " + c.size() + ";");
            }
            w.blank();
        }
        w.line("// Slot ranges: the declared containers' slots first, then the player's backpack, then the");
        w.line("// hotbar - vanilla's order, whatever order the document listed them in (SlotPlan).");
        w.line("public static final int CONTAINER_SLOTS_END = " + plan.containerEnd() + ";");
        w.line("public static final int BACKPACK_SLOTS_END = " + plan.backpackEnd() + ";");
        w.line("public static final int HOTBAR_SLOTS_END = " + plan.hotbarEnd() + ";");
        w.blank();
        if (!doc.actions().isEmpty()) {
            w.line("// Actions (section 8.1): an action's id on vanilla's button channel. A PARAMETERISED");
            w.line("// action takes a block of ids from its base, row-major over its arguments");
            w.line("// (UI_PARTS_LIBRARY_DESIGN.md section 4.2) - the stride lives here and nowhere else.");
            int id = 0;
            for (Action a : doc.actions()) {
                w.line("public static final int ACTION_" + JavaNames.constant(a.name()) + " = " + id + ";");
                for (Arg arg : a.args()) {
                    w.line("public static final int " + argSizeConstant(a, arg) + " = " + arg.size() + ";");
                }
                if (a.parameterised()) {
                    w.line("public static final int " + countConstant(a) + " = " + a.count() + ";");
                }
                id += a.count();
            }
            w.blank();
        }
        int dataCount = 0;
        if (!doc.bindings().isEmpty()) {
            w.line("// Data slots (section 8.2). ContainerData is 16-bit on the wire, so a `wide` binding takes");
            w.line("// two: the high half, then the low half.");
            for (Binding b : doc.bindings()) {
                w.line("private static final int DATA_" + JavaNames.constant(b.name()) + " = " + dataCount + ";");
                dataCount++;
                if (b.wide()) {
                    w.line("private static final int DATA_" + JavaNames.constant(b.name()) + "_LOW = " + dataCount + ";");
                    dataCount++;
                }
            }
        }
        w.line("private static final int DATA_COUNT = " + dataCount + ";");
        w.blank();
        w.line("private final boolean serverSide;");
        w.line("private final int[] synced = new int[DATA_COUNT];");
        w.blank();

        // --- constructor ---
        StringBuilder params = new StringBuilder("final MenuType<?> type, final int containerId, final Inventory playerInventory");
        for (UiDocument.Container c : doc.containers()) {
            params.append(", final Container ").append(containerParam(c.name()));
        }
        w.open("protected " + cls + "(" + params + ")");
        w.line("super(type, containerId);");
        for (UiDocument.Container c : doc.containers()) {
            w.line("checkContainerSize(" + containerParam(c.name()) + ", " + JavaNames.constant(c.name()) + "_SIZE);");
        }
        w.line("this.serverSide = !playerInventory.player.level().isClientSide();");
        if (plan.size() > 0) {
            w.line("// The slots, in menu order, at the document's coordinates. The screen paints its wells");
            w.line("// from this same list, so the two sides cannot disagree.");
            for (SlotPlan.Entry s : plan.entries()) {
                String container = s.isPlayer() ? "playerInventory" : containerParam(s.container());
                w.line("this.addSlot(this.createSlot(" + JavaNames.str(s.elementId() == null ? "" : s.elementId()) + ", "
                    + container + ", " + s.index() + ", " + s.x() + ", " + s.y() + "));");
            }
        }
        if (dataCount > 0) {
            w.line("this.addDataSlots(this.syncedData());");
        }
        w.close();
        w.blank();

        // --- slot hook ---
        List<String[]> icons = slotIcons();
        w.doc("Every slot passes through here. Override to filter one ({@code mayPlace}) or cap its stack",
            "size, switching on {@code element} (the document id of the slot or slot grid it came from).",
            "The GEOMETRY is the document's: return a slot at this x and y.");
        w.open("protected Slot createSlot(final String element, final Container container, final int index, final int x, final int y)");
        if (icons.isEmpty()) {
            w.line("return new Slot(container, index, x, y);");
        } else {
            imports.add("net.minecraft.resources.Identifier");
            w.line("Identifier icon = EMPTY_SLOT_ICONS.get(element);");
            w.line("return icon == null ? new Slot(container, index, x, y) : new IconSlot(container, index, x, y, icon);");
        }
        w.close();
        w.blank();
        if (!icons.isEmpty()) {
            imports.add("java.util.Collections");
            imports.add("java.util.LinkedHashMap");
            imports.add("java.util.Map");
            w.doc("The empty-slot sprite each named slot wears, from the document's {@code icon} property.",
                "Vanilla draws {@code Slot.getNoItemIcon()} for an empty active slot itself, so this is a",
                "property of the MENU's slot rather than anything either renderer paints.");
            w.line("private static final Map<String, Identifier> EMPTY_SLOT_ICONS = emptySlotIcons();");
            w.blank();
            w.open("private static Map<String, Identifier> emptySlotIcons()");
            w.line("Map<String, Identifier> m = new LinkedHashMap<>();");
            for (String[] e : icons) {
                w.line("m.put(" + JavaNames.str(e[0]) + ", Identifier.parse(" + JavaNames.str(e[1]) + "));");
            }
            w.line("return Collections.unmodifiableMap(m);");
            w.close();
            w.blank();
            w.doc("A slot that shows a sprite while it is empty.");
            w.open("public static class IconSlot extends Slot");
            w.line("private final Identifier icon;");
            w.blank();
            w.open("public IconSlot(final Container container, final int index, final int x, final int y, final Identifier icon)");
            w.line("super(container, index, x, y);");
            w.line("this.icon = icon;");
            w.close();
            w.blank();
            w.line("@Override");
            w.open("public Identifier getNoItemIcon()");
            w.line("return this.icon;");
            w.close();
            w.close();
            w.blank();
        }

        // --- bindings ---
        if (!doc.bindings().isEmpty()) {
            w.line("// ---- bindings (section 8.2) ----------------------------------------------------------------");
            w.blank();
            for (Binding b : doc.bindings()) {
                String pas = JavaNames.pascal(b.name());
                String cam = JavaNames.camel(b.name());
                String hi = "DATA_" + JavaNames.constant(b.name());
                w.doc("What supplies {@code " + b.name() + "} on the server. Never called on the client, where the",
                    "value is whatever the server last synced.");
                w.line("protected abstract int supply" + pas + "();");
                w.blank();
                w.doc("The current {@code " + b.name() + "}: live on the server, synced on the client."
                    + (b.wide() ? " Wide: reassembled from two 16-bit halves." : ""));
                w.open("public final int " + cam + "()");
                if (b.wide()) {
                    w.line("return this.serverSide ? this.supply" + pas + "() : (this.synced[" + hi + "] << 16) | (this.synced["
                        + hi + "_LOW] & 0xFFFF);");
                } else {
                    w.line("return this.serverSide ? this.supply" + pas + "() : this.synced[" + hi + "];");
                }
                w.close();
                w.blank();
            }
            w.doc("A binding by its document name - the dev-time interpreter reads a live menu through this",
                "(section 15.8); {@code 0} for a name the document does not declare.");
            w.open("public int bindingValue(final String name)");
            w.open("return switch (name)");
            for (Binding b : doc.bindings()) {
                w.line("case " + JavaNames.str(b.name()) + " -> this." + JavaNames.camel(b.name()) + "();");
            }
            w.line("default -> 0;");
            w.close(";");
            w.close();
            w.blank();
            w.doc("One ContainerData over the suppliers; vanilla's {@code broadcastChanges} diffs and syncs it.");
            w.open("private ContainerData syncedData()");
            w.open("return new ContainerData()");
            w.line("@Override");
            w.open("public int get(final int id)");
            w.line("return " + cls + ".this.serverSide ? " + cls + ".this.live(id) : " + cls + ".this.synced[id];");
            w.close();
            w.blank();
            w.line("@Override");
            w.open("public void set(final int id, final int value)");
            w.line(cls + ".this.synced[id] = value;");
            w.close();
            w.blank();
            w.line("@Override");
            w.open("public int getCount()");
            w.line("return DATA_COUNT;");
            w.close();
            w.close(";");
            w.close();
            w.blank();
            w.open("private int live(final int id)");
            w.open("return switch (id)");
            for (Binding b : doc.bindings()) {
                String pas = JavaNames.pascal(b.name());
                String hi = "DATA_" + JavaNames.constant(b.name());
                if (b.wide()) {
                    w.line("case " + hi + " -> this.supply" + pas + "() >> 16;");
                    w.line("case " + hi + "_LOW -> this.supply" + pas + "() & 0xFFFF;");
                } else {
                    w.line("case " + hi + " -> this.supply" + pas + "();");
                }
            }
            w.line("default -> 0;");
            w.close(";");
            w.close();
            w.blank();
        } else {
            w.doc("No bindings declared; {@code 0} for every name.");
            w.open("public int bindingValue(final String name)");
            w.line("return 0;");
            w.close();
            w.blank();
        }

        // --- actions ---
        w.line("// ---- actions (section 8.1) -----------------------------------------------------------------");
        w.blank();
        for (Action a : doc.actions()) {
            StringBuilder hookParams = new StringBuilder("Player player");
            for (Arg arg : a.args()) {
                hookParams.append(", int ").append(JavaNames.ident(arg.name()));
            }
            if (a.parameterised()) {
                StringBuilder ranges = new StringBuilder();
                for (Arg arg : a.args()) {
                    ranges.append(ranges.length() == 0 ? "" : ", ").append("{@code ").append(arg.name())
                        .append("} is 0..").append(arg.size() - 1);
                }
                w.doc("What {@code " + a.name() + "} does. Runs on the server when a client pressed the button;",
                    "return true if something happened.",
                    "",
                    "The arguments are decoded from the button id and BOUNDS-CHECKED before you see them ("
                        + ranges + "),",
                    "so the packing in the screen and the unpacking here cannot disagree (section 4.2).");
            } else {
                w.doc("What {@code " + a.name() + "} does. Runs on the server when a client pressed the button;",
                    "return true if something happened.");
            }
            w.line("protected abstract boolean on" + JavaNames.pascal(a.name()) + "(" + hookParams + ");");
            w.blank();
        }
        w.line("@Override");
        w.open("public boolean clickMenuButton(final Player player, final int id)");
        if (doc.actions().isEmpty()) {
            w.line("return false;");
        } else {
            boolean anyParameterised = false;
            for (Action a : doc.actions()) {
                anyParameterised |= a.parameterised();
            }
            if (!anyParameterised) {
                w.open("return switch (id)");
                for (Action a : doc.actions()) {
                    w.line("case ACTION_" + JavaNames.constant(a.name()) + " -> this.on"
                        + JavaNames.pascal(a.name()) + "(player);");
                }
                w.line("default -> false;");
                w.close(";");
            } else {
                for (Action a : doc.actions()) {
                    String base = "ACTION_" + JavaNames.constant(a.name());
                    if (!a.parameterised()) {
                        w.open("if (id == " + base + ")");
                        w.line("return this.on" + JavaNames.pascal(a.name()) + "(player);");
                        w.close();
                        continue;
                    }
                    w.open("if (id >= " + base + " && id < " + base + " + " + countConstant(a) + ")");
                    w.line("int off = id - " + base + ";");
                    StringBuilder call = new StringBuilder("player");
                    for (int i = a.args().size() - 1; i >= 0; i--) {
                        Arg arg = a.args().get(i);
                        String v = JavaNames.ident(arg.name());
                        if (i == 0) {
                            w.line("int " + v + " = off;");
                        } else {
                            w.line("int " + v + " = off % " + argSizeConstant(a, arg) + ";");
                            w.line("off /= " + argSizeConstant(a, arg) + ";");
                        }
                    }
                    for (Arg arg : a.args()) {
                        call.append(", ").append(JavaNames.ident(arg.name()));
                    }
                    w.line("return this.on" + JavaNames.pascal(a.name()) + "(" + call + ");");
                    w.close();
                }
                w.line("return false;");
            }
        }
        w.close();
        w.blank();

        // --- quick move ---
        w.line("// ---- shift-click: vanilla's AbstractFurnaceMenu algorithm over the document's ranges ----------");
        w.blank();
        w.doc("The declared containers' attempt to absorb a stack arriving from the player. Override when",
            "the insert is filtered (fuel goes to the fuel slot and only fuel does) rather than a plain",
            "range insert. Return true if the stack was fully or partly taken.");
        w.open("protected boolean quickMoveIntoContainers(final ItemStack stack)");
        w.line("return this.moveItemStackTo(stack, 0, CONTAINER_SLOTS_END, false);");
        w.close();
        w.blank();
        w.line("@Override");
        w.open("public ItemStack quickMoveStack(final Player player, final int slotIndex)");
        w.line("Slot slot = this.slots.get(slotIndex);");
        w.open("if (!slot.hasItem())");
        w.line("return ItemStack.EMPTY;");
        w.close();
        w.line("ItemStack stack = slot.getItem();");
        w.line("ItemStack clicked = stack.copy();");
        w.open("if (slotIndex < CONTAINER_SLOTS_END)");
        w.line("// Leaving a container: into the player's inventory, hotbar first.");
        w.open("if (!this.moveItemStackTo(stack, CONTAINER_SLOTS_END, HOTBAR_SLOTS_END, true))");
        w.line("return ItemStack.EMPTY;");
        w.close();
        w.close();
        w.open("else if (!this.quickMoveIntoContainers(stack))");
        w.line("// Refused by the containers: hop backpack to hotbar or hotbar to backpack.");
        w.open("if (slotIndex < BACKPACK_SLOTS_END)");
        w.open("if (!this.moveItemStackTo(stack, BACKPACK_SLOTS_END, HOTBAR_SLOTS_END, false))");
        w.line("return ItemStack.EMPTY;");
        w.close();
        w.close();
        w.open("else if (!this.moveItemStackTo(stack, CONTAINER_SLOTS_END, BACKPACK_SLOTS_END, false))");
        w.line("return ItemStack.EMPTY;");
        w.close();
        w.close();
        w.open("if (stack.isEmpty())");
        w.line("slot.setByPlayer(ItemStack.EMPTY);");
        w.close();
        w.open("else");
        w.line("slot.setChanged();");
        w.close();
        w.line("// A move that reported success without moving anything is not a move.");
        w.open("if (stack.getCount() == clicked.getCount())");
        w.line("return ItemStack.EMPTY;");
        w.close();
        w.line("slot.onTake(player, stack);");
        w.line("return clicked;");
        w.close();
        w.close();

        return file(req.menuPackage(), imports, w.toString());
    }

    private static String containerParam(final String name) {
        return JavaNames.camel(name) + "Container";
    }

    /** {@code ACTION_SELECT_FITTING_ROW_SIZE}: how many values one argument of an action takes. */
    private static String argSizeConstant(final Action a, final Arg arg) {
        return "ACTION_" + JavaNames.constant(a.name()) + "_" + JavaNames.constant(arg.name()) + "_SIZE";
    }

    /** {@code ACTION_SELECT_FITTING_COUNT}: how many ids the whole block covers. */
    private static String countConstant(final Action a) {
        return "ACTION_" + JavaNames.constant(a.name()) + "_COUNT";
    }

    /** {@code {elementId, sprite}} for every slot or slot grid the document gave an icon. */
    private List<String[]> slotIcons() {
        List<String[]> out = new ArrayList<>();
        for (Element e : doc.flatten()) {
            String id = e.id();
            String icon = e instanceof Element.Slot s ? s.icon()
                : e instanceof Element.SlotGrid g ? g.icon() : null;
            if (icon != null && id != null) {
                out.add(new String[] {id, icon});
            }
        }
        return out;
    }

    // =============================================================================================
    // The menu stub (common, human)
    // =============================================================================================

    private String menuStub() {
        JavaWriter w = new JavaWriter();
        TreeSet<String> imports = new TreeSet<>(List.of(
            "net.minecraft.world.entity.player.Inventory",
            "net.minecraft.world.entity.player.Player",
            "net.minecraft.world.flag.FeatureFlags",
            "net.minecraft.world.inventory.MenuType"));
        if (!doc.containers().isEmpty()) {
            imports.add("net.minecraft.world.Container");
            imports.add("net.minecraft.world.SimpleContainer");
        }
        String cls = req.menuClass();
        String base = req.menuBaseClass();
        w.doc("The hand-written half of the " + req.screenClass() + " menu (SCREEN_AUTHORING_DESIGN.md section 7):",
            "what the actions DO and what supplies the bindings. Generated ONCE as a stub and never",
            "overwritten - this file is yours.",
            "",
            "Register the menu type from your mod initializer:",
            "  " + req.target().registerMenuTypeHint(req.modId(), req.screenId(), cls));
        w.open("public class " + cls + " extends " + base);
        w.line("public static final MenuType<" + cls + "> TYPE = new MenuType<>(" + cls + "::new, FeatureFlags.DEFAULT_FLAGS);");
        w.blank();
        StringBuilder args = new StringBuilder();
        StringBuilder params = new StringBuilder();
        for (UiDocument.Container c : doc.containers()) {
            args.append(", new SimpleContainer(").append(JavaNames.constant(c.name())).append("_SIZE)");
            params.append(", final Container ").append(containerParam(c.name()));
        }
        w.doc("The client-side constructor the menu type calls" + (doc.containers().isEmpty() ? "." :
            ": the containers are stand-ins the server syncs into."));
        w.open("public " + cls + "(final int containerId, final Inventory playerInventory)");
        w.line("this(containerId, playerInventory" + args + ");");
        w.close();
        w.blank();
        w.doc("The server-side constructor: hand it the real containers.");
        w.open("public " + cls + "(final int containerId, final Inventory playerInventory" + params + ")");
        StringBuilder sup = new StringBuilder("super(TYPE, containerId, playerInventory");
        for (UiDocument.Container c : doc.containers()) {
            sup.append(", ").append(containerParam(c.name()));
        }
        w.line(sup + ");");
        w.close();
        for (Binding b : doc.bindings()) {
            w.blank();
            w.line("@Override");
            w.open("protected int supply" + JavaNames.pascal(b.name()) + "()");
            w.line("return 0;");
            w.close();
        }
        for (Action a : doc.actions()) {
            StringBuilder hookParams = new StringBuilder("final Player player");
            for (Arg arg : a.args()) {
                hookParams.append(", final int ").append(JavaNames.ident(arg.name()));
            }
            w.blank();
            w.line("@Override");
            w.open("protected boolean on" + JavaNames.pascal(a.name()) + "(" + hookParams + ")");
            w.line("return false;");
            w.close();
        }
        w.blank();
        w.line("@Override");
        w.open("public boolean stillValid(final Player player)");
        w.line("return true;");
        w.close();
        w.close();
        return file(req.menuPackage(), imports, w.toString());
    }

    // =============================================================================================
    // The layout (client)
    // =============================================================================================

    /** Emission state for one {@code init()}: the imports it needs and the counters for unnamed elements. */
    private TreeSet<String> imports;
    private int anon;
    /** Nested layouts in the interpreter's node order (a nested layout is listed once its own children are). */
    private List<String[]> nodes;
    /** Nudges, in encounter order: {variable, dx, dy, isLayout}. */
    private List<String[]> nudges;
    /** Whether the "slots are the menu's" comment has been printed for this init(). */
    private boolean saidSlots;

    /**
     * The top-level elements, walking THROUGH a macro.
     *
     * <p>A part instance and a repeat draw nothing of their own: what they expand to is already
     * ordinary elements at absolute coordinates (the parser translated them by the instance's
     * origin), so they are emitted exactly as if they had been written inline - which is what
     * "nothing downstream learns a new word" means when the downstream is a code generator.
     */
    private void emitTopLevel(final JavaWriter w, final List<Element> elements, final String base) {
        for (Element e : elements) {
            if (e.kind().isMacro()) {
                w.line("// " + e.kind().jsonName() + " '" + e.id() + "'"
                    + (e instanceof Element.Part part ? " (" + part.part() + " #" + part.hash() + ")" : "")
                    + ", expanded at parse time:");
                emitTopLevel(w, e.children(), base);
                continue;
            }
            Placement.Absolute at = (Placement.Absolute) e.placement();
            String x = "this.leftPos + " + at.x();
            String y = "this.topPos + " + at.y();
            if (e instanceof Element.Layout l) {
                emitLayoutBlock(w, l, x, y);
            } else if (e.kind().isSlot()) {
                if (!saidSlots) {
                    w.line("// Slots are the menu's (" + base + "); their wells are painted in extractLabels.");
                    saidSlots = true;
                }
            } else if (needsLocal(e)) {
                String v = var(e, "w");
                w.line(req.vendorClass() + "." + widgetType(e) + " " + v + " = this.declare(" + idArg(e)
                    + ", this.addRenderableWidget(" + widget(e, x, y) + "));");
                emitDecoration(w, e, v);
            } else {
                w.line("this.declare(" + idArg(e) + ", this.addRenderableWidget(" + widget(e, x, y) + "));");
            }
        }
    }

    /** Does this element need a named local - because something has to be said ABOUT the widget? */
    private static boolean needsLocal(final Element e) {
        return !e.deco().isNone();
    }

    /** The {@code states} and {@code tooltips} registrations for one widget local. */
    private void emitDecoration(final JavaWriter w, final Element e, final String v) {
        Element.Decoration deco = e.deco();
        if (deco.stateful()) {
            StringBuilder body = new StringBuilder();
            if (deco.visible() != null) {
                body.append(v).append(".visible = ").append(test(deco.visible())).append("; ");
            }
            if (deco.enabled() != null) {
                body.append(v).append(".active = ").append(test(deco.enabled())).append("; ");
            }
            w.line("this.states.add(() -> { " + body.toString().trim() + " });");
        }
        if (deco.tooltip() != null) {
            imports.add("java.util.List");
            String lines = deco.tooltip().isHook()
                ? "this.tooltip_" + JavaNames.ident(hookName(e)) + "()"
                : "List.of(" + component(deco.tooltip().text()) + ")";
            w.line("this.tooltips.add(new " + req.vendorClass() + ".Paint.Hover(" + v + ", () -> " + lines + "));");
        }
    }

    /** {@code this.menu.bindingValue("can_apply") != 0} - the predicate, as one expression. */
    private String test(final Element.Predicate p) {
        String op = switch (p.cmp()) {
            case EQ -> "==";
            case NE -> "!=";
            case LT -> "<";
            case LTE -> "<=";
            case GT -> ">";
            case GTE -> ">=";
        };
        Binding b = doc.binding(p.binding());
        String read = b != null ? "this.menu." + JavaNames.camel(b.name()) + "()"
            : "this.menu.bindingValue(" + JavaNames.str(p.binding()) + ")";
        return read + " " + op + " " + p.value();
    }

    /** The hook method's name for a dynamic tooltip: the element's id, dots to underscores. */
    private static String hookName(final Element e) {
        return e.id() == null ? "anonymous" : e.id().replace('.', '_');
    }

    private boolean hasStates() {
        for (Element e : doc.flatten()) {
            if (e.deco().stateful()) {
                return true;
            }
        }
        return false;
    }

    private boolean hasTooltips() {
        for (Element e : doc.flatten()) {
            if (e.deco().tooltip() != null) {
                return true;
            }
        }
        return false;
    }

    private String layout() {
        JavaWriter w = new JavaWriter();
        imports = new TreeSet<>(List.of(
            req.menuPackage() + "." + req.menuBaseClass(),
            "net.minecraft.client.gui.GuiGraphicsExtractor",
            "net.minecraft.client.gui.components.AbstractWidget",
            "net.minecraft.client.gui.screens.inventory.AbstractContainerScreen",
            "net.minecraft.network.chat.Component",
            "net.minecraft.world.entity.player.Inventory",
            "java.util.Collections",
            "java.util.LinkedHashMap",
            "java.util.Map"));
        for (String i : req.target().clientImports()) {
            imports.add(i);
        }
        String cls = req.layoutClass();
        String base = req.menuBaseClass();
        String ui = req.vendorClass();

        header(w, "The screen's machine half: every element as a widget at the document's geometry, layouts"
            + " arranged the way the dev-time interpreter arranges them, the slot wells, and a hook per region.");
        if (req.target().clientAnnotation() != null) {
            w.line(req.target().clientAnnotation());
        }
        w.open("public abstract class " + cls + "<M extends " + base + "> extends AbstractContainerScreen<M>");
        w.line("private final Map<String, AbstractWidget> declared = new LinkedHashMap<>();");
        if (hasStates()) {
            imports.add("java.util.ArrayList");
            imports.add("java.util.List");
            w.line("/** What `visible` and `enabled` mean, re-read whenever a synced value can have changed. */");
            w.line("private final List<Runnable> states = new ArrayList<>();");
        }
        if (hasTooltips()) {
            imports.add("java.util.ArrayList");
            imports.add("java.util.List");
            w.line("/** The rectangles that show a tooltip, with what to show (section 3.2). */");
            w.line("private final List<" + ui + ".Paint.Hover> tooltips = new ArrayList<>();");
        }
        w.blank();
        w.open("protected " + cls + "(final M menu, final Inventory inventory, final Component title)");
        w.line("super(menu, inventory, title, " + doc.width() + ", " + doc.height() + ");");
        w.line("this.titleLabelX = " + doc.titleX() + ";");
        w.line("this.titleLabelY = " + doc.titleY() + ";");
        if (doc.inventoryLabel().shown()) {
            w.line("this.inventoryLabelX = " + doc.inventoryLabel().x() + ";");
            w.line("this.inventoryLabelY = " + doc.inventoryLabel().y() + ";");
        }
        w.close();
        w.blank();
        w.doc("The declared widgets by document id, from the last {@code init()}. Layout nodes included;",
            "slots are the menu's ({@code this.menu.slots}), not widgets.");
        w.open("public Map<String, AbstractWidget> declaredWidgets()");
        w.line("return Collections.unmodifiableMap(this.declared);");
        w.close();
        w.blank();
        w.doc("A declared widget by id, or {@code null} before {@code init()} or for an unnamed element.");
        w.open("protected AbstractWidget widget(final String id)");
        w.line("return this.declared.get(id);");
        w.close();
        w.blank();

        // --- init ---
        w.line("@Override");
        w.open("protected void init()");
        w.line("super.init();");
        w.line("this.declared.clear();");
        if (hasStates()) {
            w.line("this.states.clear();");
        }
        if (hasTooltips()) {
            w.line("this.tooltips.clear();");
        }
        anon = 0;
        saidSlots = false;
        emitTopLevel(w, doc.elements(), base);
        if (hasStates()) {
            w.line("// Before anything is drawn: a screen opened on a hidden button would show it for a");
            w.line("// frame otherwise.");
            w.line("this.applyStates();");
        }
        w.close();
        w.blank();
        if (hasStates()) {
            w.doc("Re-read every {@code visible} / {@code enabled} predicate.",
                "",
                "<b>Per FRAME, not per tick, and that is a finding rather than a preference.</b> Vanilla",
                "syncs data slots without a slot change, so nothing tells a screen that a flag moved -",
                "which is why every hand-written screen that has one grows a {@code containerTick}",
                "override. But {@code AbstractContainerMenu.setData} does NOT notify listeners on the",
                "client (they fire from {@code broadcastChanges}, which is the server's), so a value can",
                "arrive and sit there until the next tick: a button that should be live reads dead for up",
                "to 50ms, and two renderers compared in that window disagree. A predicate is a pure",
                "function of the current values, so it is evaluated where it is used.");
            w.open("private void applyStates()");
            w.open("for (Runnable state : this.states)");
            w.line("state.run();");
            w.close();
            w.close();
            w.blank();
        }
        if (hasStates() || hasTooltips()) {
            w.line("@Override");
            w.open("public void extractRenderState(final GuiGraphicsExtractor g, final int mouseX, final int mouseY, final float partialTick)");
            if (hasStates()) {
                w.line("this.applyStates();");
            }
            w.line("super.extractRenderState(g, mouseX, mouseY, partialTick);");
            if (hasTooltips()) {
                w.line(ui + ".Paint.tooltips(g, this.font, this.tooltips, mouseX, mouseY);");
            }
            w.close();
            w.blank();
        }

        // --- helpers ---
        w.open("private <W extends AbstractWidget> W declare(final String id, final W widget)");
        w.open("if (id != null)");
        w.line("this.declared.put(id, widget);");
        w.close();
        w.line("return widget;");
        w.close();
        w.blank();
        if (hasLayouts()) {
            imports.add("net.minecraft.client.gui.layouts.Layout");
            w.doc("A layout node as an inactive widget over its arranged bounds, so a tool can name it.");
            w.open("private void node(final String id, final String kind, final Layout layout)");
            w.line("this.declare(id, this.addRenderableWidget(new " + ui + ".Decor(id, kind, layout.getX(), layout.getY(),"
                + " layout.getWidth(), layout.getHeight(), (g, x, y, w, h, mx, my, pt) -> { })));");
            w.close();
            w.blank();
        }
        if (!doc.actions().isEmpty()) {
            w.doc("Send a declared action down vanilla's button channel (section 8.1); the server answers in",
                "{@code " + base + ".clickMenuButton}.");
            w.open("protected void press(final int action)");
            w.open("if (this.minecraft != null && this.minecraft.gameMode != null)");
            w.line("this.minecraft.gameMode.handleInventoryButtonClick(this.menu.containerId, action);");
            w.close();
            w.close();
            w.blank();
            // One packer per parameterised action, and it is the ONLY place the stride is written -
            // UI_PARTS_LIBRARY_DESIGN.md section 4.2's whole point. A hand-written hit test (a cell
            // grid drawn by a region) calls this rather than re-deriving `row * MAX + slot`.
            for (Action a : doc.actions()) {
                if (!a.parameterised()) {
                    continue;
                }
                StringBuilder params = new StringBuilder();
                StringBuilder offset = new StringBuilder();
                for (int i = 0; i < a.args().size(); i++) {
                    Arg arg = a.args().get(i);
                    String v = JavaNames.ident(arg.name());
                    params.append(params.length() == 0 ? "" : ", ").append("final int ").append(v);
                    offset = new StringBuilder(offset.length() == 0 ? v
                        : "(" + offset + ") * " + base + "." + argSizeConstant(a, arg) + " + " + v);
                }
                w.doc("Press {@code " + a.name() + "} with these arguments.",
                    "",
                    "The id arithmetic lives here and in {@code " + base + ".clickMenuButton}, both",
                    "generated from the one arity the document declares - so a stride typo cannot make a",
                    "click land on another action (section 4.2).");
                w.open("protected void press" + JavaNames.pascal(a.name()) + "(" + params + ")");
                for (Arg arg : a.args()) {
                    String v = JavaNames.ident(arg.name());
                    w.open("if (" + v + " < 0 || " + v + " >= " + base + "." + argSizeConstant(a, arg) + ")");
                    w.line("throw new IllegalArgumentException(" + JavaNames.str(a.name() + " " + arg.name()
                        + " must be 0..") + " + (" + base + "." + argSizeConstant(a, arg) + " - 1) + \", got \" + " + v + ");");
                    w.close();
                }
                w.line("this.press(" + base + ".ACTION_" + JavaNames.constant(a.name()) + " + " + offset + ");");
                w.close();
                w.blank();
            }
        }

        // --- background + labels ---
        w.line("@Override");
        w.open("public void extractBackground(final GuiGraphicsExtractor g, final int mouseX, final int mouseY, final float partialTick)");
        w.line("super.extractBackground(g, mouseX, mouseY, partialTick);");
        if (doc.background() != null) {
            imports.add("net.minecraft.client.renderer.RenderPipelines");
            imports.add("net.minecraft.resources.Identifier");
            w.line("g.blit(RenderPipelines.GUI_TEXTURED, Identifier.parse(" + JavaNames.str(doc.background()) + "), this.leftPos, this.topPos,"
                + " 0.0F, 0.0F, this.imageWidth, this.imageHeight, 256, 256, 0xFFFFFFFF);");
        } else {
            w.line(ui + ".Paint.screenFrame(g, this.leftPos, this.topPos, this.imageWidth, this.imageHeight);");
        }
        w.close();
        w.blank();
        w.doc("Wells first, then the labels: this hook runs after the widgets and before the slot items,",
            "with the pose at the panel origin.");
        w.line("@Override");
        w.open("protected void extractLabels(final GuiGraphicsExtractor g, final int mouseX, final int mouseY)");
        w.line(ui + ".Paint.slots(g, this.menu, 0, 0);");
        w.line("g.text(this.font, this.title, this.titleLabelX, this.titleLabelY, " + LABEL_COLOR + ", false);");
        if (doc.inventoryLabel().shown()) {
            w.line("g.text(this.font, this.playerInventoryTitle, this.inventoryLabelX, this.inventoryLabelY, " + LABEL_COLOR + ", false);");
        }
        w.close();

        // --- region hooks ---
        for (Element e : doc.flatten()) {
            if (e instanceof Element.Region r) {
                w.blank();
                w.doc("The {@code " + r.id() + "} region (section 4.4): a named rectangle that draws nothing until you",
                    "override this. {@code (x, y)} is its top-left in window coordinates; {@code w}/{@code h} its size.");
                w.open("protected void drawRegion_" + hookName(r) + "(final GuiGraphicsExtractor g, final int x, final int y, final int w,"
                    + " final int h, final int mouseX, final int mouseY, final float partialTick)");
                w.line("// Empty by default; the interpreter draws nothing here either, so the two agree.");
                w.close();
            }
        }
        // --- tooltip hooks ---
        for (Element e : doc.flatten()) {
            Element.Tooltip t = e.deco().tooltip();
            if (t == null || !t.isHook()) {
                continue;
            }
            imports.add("java.util.List");
            w.blank();
            w.doc("The {@code " + e.id() + "} tooltip (section 3.2): the lines to show while the pointer is over it.",
                "Empty by default - and the interpreter shows nothing either, so a preview and this screen",
                "agree until you fill it in. Called every frame the pointer is inside the rectangle.");
            w.open("protected List<Component> tooltip_" + JavaNames.ident(hookName(e)) + "()");
            w.line("return List.of();");
            w.close();
        }
        w.close();
        return file(req.clientPackage(), imports, w.toString());
    }

    private boolean hasLayouts() {
        for (Element e : doc.flatten()) {
            if (e instanceof Element.Layout) {
                return true;
            }
        }
        return false;
    }

    private static String idArg(final Element e) {
        return e.id() == null ? "null" : JavaNames.str(e.id());
    }

    /** A local variable name for an element: its id, prefixed so it can never shadow a lambda parameter. */
    private String var(final Element e, final String prefix) {
        return e.id() != null ? prefix + "_" + JavaNames.ident(e.id()) : prefix + "_" + (++anon);
    }

    // ---- layouts --------------------------------------------------------------------------------

    private void emitLayoutBlock(final JavaWriter w, final Element.Layout l, final String x, final String y) {
        nodes = new ArrayList<>();
        nudges = new ArrayList<>();
        w.open("");
        w.line("// " + (l.id() == null ? "a" : "the '" + l.id() + "'") + " " + l.kind().jsonName()
            + ": arranged by vanilla's layout, then handed over, exactly as the interpreter does it.");
        String v = emitLayoutDecl(w, l);
        w.line(v + ".setX(" + x + ");");
        w.line(v + ".setY(" + y + ");");
        w.line(v + ".arrangeElements();");
        for (String[] n : nudges) {
            boolean dx = !"0".equals(n[1]);
            boolean dy = !"0".equals(n[2]);
            if ("layout".equals(n[3])) {
                w.open(n[0] + ".visitWidgets(nudged ->");
                if (dx) {
                    w.line("nudged.setX(nudged.getX() + " + n[1] + ");");
                }
                if (dy) {
                    w.line("nudged.setY(nudged.getY() + " + n[2] + ");");
                }
                w.close(");");
            } else {
                if (dx) {
                    w.line(n[0] + ".setX(" + n[0] + ".getX() + " + n[1] + ");");
                }
                if (dy) {
                    w.line(n[0] + ".setY(" + n[0] + ".getY() + " + n[2] + ");");
                }
            }
        }
        w.line(v + ".visitWidgets(this::addRenderableWidget);");
        w.line("this.node(" + idArg(l) + ", " + JavaNames.str(l.kind().jsonName()) + ", " + v + ");");
        for (String[] n : nodes) {
            w.line("this.node(" + n[0] + ", " + n[1] + ", " + n[2] + ");");
        }
        w.close();
    }

    /** Declare a layout variable and add its children; returns the variable name. */
    private String emitLayoutDecl(final JavaWriter w, final Element.Layout l) {
        String v = var(l, "l");
        switch (l.kind()) {
            case ROW -> {
                imports.add("net.minecraft.client.gui.layouts.LinearLayout");
                w.line("LinearLayout " + v + " = LinearLayout.horizontal().spacing(" + l.spacing() + ");");
            }
            case COLUMN -> {
                imports.add("net.minecraft.client.gui.layouts.LinearLayout");
                w.line("LinearLayout " + v + " = LinearLayout.vertical().spacing(" + l.spacing() + ");");
            }
            case GRID -> {
                imports.add("net.minecraft.client.gui.layouts.GridLayout");
                w.line("GridLayout " + v + " = new GridLayout().spacing(" + l.spacing() + ");");
            }
            case STACK -> {
                imports.add("net.minecraft.client.gui.layouts.FrameLayout");
                w.line("FrameLayout " + v + " = new FrameLayout();");
            }
            default -> throw new IllegalStateException("not a layout kind: " + l.kind());
        }
        for (Element child : l.children()) {
            Placement.Cell c = (Placement.Cell) child.placement();
            String cv;
            boolean isLayout = false;
            if (child instanceof Element.Layout nested) {
                cv = emitLayoutDecl(w, nested);
                nodes.add(new String[] {idArg(nested), JavaNames.str(nested.kind().jsonName()), cv});
                isLayout = true;
            } else if (child instanceof Element.Spacer s) {
                imports.add("net.minecraft.client.gui.layouts.SpacerElement");
                cv = "new SpacerElement(" + s.w() + ", " + s.h() + ")";
            } else {
                cv = var(child, "w");
                w.line(req.vendorClass() + "." + widgetType(child) + " " + cv + " = this.declare(" + idArg(child) + ", "
                    + widget(child, "0", "0") + ");");
                emitDecoration(w, child, cv);
            }
            String settings = switch (l.kind()) {
                case STACK -> v + ".newChildLayoutSettings()";
                default -> v + ".newCellSettings()";
            };
            Element.Padding p = c.padding();
            if (!p.isNone()) {
                settings += ".padding(" + p.left() + ", " + p.top() + ", " + p.right() + ", " + p.bottom() + ")";
            }
            if (c.alignX() != 0.0F || c.alignY() != 0.0F) {
                settings += ".align(" + JavaNames.flt(c.alignX()) + ", " + JavaNames.flt(c.alignY()) + ")";
            }
            if (l.kind() == Kind.GRID) {
                w.line(v + ".addChild(" + cv + ", " + c.row() + ", " + c.col() + ", " + c.rowSpan() + ", " + c.colSpan()
                    + ", " + settings + ");");
            } else {
                w.line(v + ".addChild(" + cv + ", " + settings + ");");
            }
            if (c.hasOffset() && !(child instanceof Element.Spacer)) {
                nudges.add(new String[] {cv, Integer.toString(c.dx()), Integer.toString(c.dy()), isLayout ? "layout" : "widget"});
            }
        }
        return v;
    }

    // ---- widgets --------------------------------------------------------------------------------

    /** The vendored widget class an element becomes. */
    private static String widgetType(final Element e) {
        return switch (e) {
            case Element.Box b -> "Decor";
            case Element.Label l -> "Label";
            case Element.Button b -> "PressButton";
            case Element.Bar b -> "Decor";
            case Element.Item i -> "ItemView";
            case Element.Icon i -> "Icon";
            case Element.Entity en -> "EntityView";
            case Element.Region r -> "Decor";
            case Element.Slot s -> throw new IllegalStateException("slots are the menu's, not widgets");
            case Element.SlotGrid s -> throw new IllegalStateException("slots are the menu's, not widgets");
            case Element.Spacer s -> throw new IllegalStateException("a spacer is a layout element, not a widget");
            case Element.Layout l -> throw new IllegalStateException("layouts are emitted by emitLayoutDecl");
            case Element.Part part -> throw new IllegalStateException("a part is expanded, not a widget");
            case Element.Repeat r -> throw new IllegalStateException("a repeat is expanded, not a widget");
        };
    }

    /** One non-slot, non-layout element as a {@code new ...} expression. Exhaustive by construction. */
    private String widget(final Element e, final String x, final String y) {
        String ui = req.vendorClass();
        String id = idArg(e);
        return switch (e) {
            case Element.Box b -> "new " + ui + ".Decor(" + id + ", " + JavaNames.str(b.kind().jsonName()) + ", " + x + ", " + y + ", "
                + b.w() + ", " + b.h() + ", (g, x, y, w, h, mx, my, pt) -> " + ui + ".Paint." + switch (b.kind()) {
                    case PANEL -> "panel";
                    case WELL -> "well";
                    case FRAME -> "screenFrame";
                    default -> throw new IllegalStateException("not a box kind: " + b.kind());
                } + "(g, x, y, w, h))";
            case Element.Label l -> "new " + ui + ".Label(" + id + ", " + x + ", " + y + ", " + l.w() + ", " + l.h() + ", "
                + component(l.text()) + ", this.font, " + ui + ".LabelMode." + l.mode().name() + ", " + JavaNames.argb(l.color())
                + ", " + l.shadow() + ")";
            case Element.Button b -> {
                if (b.sprite() != null || b.spriteHovered() != null) {
                    imports.add("net.minecraft.resources.Identifier");
                }
                UiDocument.Action declared = doc.action(b.action());
                String press;
                if (declared != null && declared.parameterised()) {
                    StringBuilder args = new StringBuilder();
                    for (int v : b.args()) {
                        args.append(args.length() == 0 ? "" : ", ").append(v);
                    }
                    press = "btn -> this.press" + JavaNames.pascal(b.action()) + "(" + args + ")";
                } else {
                    press = "btn -> this.press(" + req.menuBaseClass() + ".ACTION_"
                        + JavaNames.constant(b.action()) + ")";
                }
                yield "new " + ui + ".PressButton(" + id + ", " + x + ", " + y + ", " + b.w() + ", " + b.h() + ", "
                    + component(b.text()) + ", " + sprite(b.sprite()) + ", " + sprite(b.spriteHovered()) + ", "
                    + (b.face() == Element.Face.NONE) + ", " + press + ")";
            }
            case Element.Bar b -> "new " + ui + ".Decor(" + id + ", \"bar\", " + x + ", " + y + ", " + b.w() + ", " + b.h()
                + ", (g, x, y, w, h, mx, my, pt) -> " + ui + ".Paint." + (b.vertical() ? "barVertical" : "bar")
                + "(g, x, y, w, h, " + fraction(doc.binding(b.binding())) + ", " + JavaNames.argb(b.fill()) + ", "
                + JavaNames.argb(b.track()) + "))";
            case Element.Item i -> "new " + ui + ".ItemView(" + id + ", " + x + ", " + y + ", " + ui + ".stack("
                + JavaNames.str(i.item()) + ", " + i.count() + "), " + i.decorated() + ")";
            case Element.Icon i -> {
                imports.add("net.minecraft.resources.Identifier");
                Element.Sheet sh = i.sheet();
                yield "new " + ui + ".Icon(" + id + ", " + x + ", " + y + ", " + i.w() + ", " + i.h() + ", "
                    + sprite(i.sprite()) + ", " + sprite(sh == null ? null : sh.texture()) + ", "
                    + (sh == null ? 0 : sh.u()) + ", " + (sh == null ? 0 : sh.v()) + ", "
                    + (sh == null ? i.w() : sh.srcW()) + ", " + (sh == null ? i.h() : sh.srcH()) + ", "
                    + (sh == null ? Element.Sheet.DEFAULT_SHEET : sh.sheetW()) + ", "
                    + (sh == null ? Element.Sheet.DEFAULT_SHEET : sh.sheetH()) + ", "
                    + JavaNames.argb(i.color()) + ")";
            }
            case Element.Entity en -> {
                StringBuilder stacks = new StringBuilder();
                for (String slotId : en.subject().equipment()) {
                    int index = menuSlotIndex(slotId);
                    stacks.append(stacks.length() == 0 ? "" : ", ")
                        .append(index < 0 ? "net.minecraft.world.item.ItemStack.EMPTY"
                            : "this.menu.slots.get(" + index + ").getItem()");
                }
                imports.add("java.util.List");
                yield "new " + ui + ".EntityView(" + id + ", " + x + ", " + y + ", " + en.w() + ", " + en.h() + ", "
                    + JavaNames.str(en.subject().kind()) + ", " + JavaNames.flt(en.scale()) + ", "
                    + JavaNames.flt(en.pitch()) + ", " + JavaNames.flt(en.yaw()) + ", " + en.followMouse() + ", "
                    + en.draggable() + ", () -> List.of(" + stacks + "))";
            }
            case Element.Region r -> "new " + ui + ".Decor(" + id + ", \"region\", " + x + ", " + y + ", " + r.w() + ", " + r.h()
                + ", (g, x, y, w, h, mx, my, pt) -> this.drawRegion_" + hookName(r) + "(g, x, y, w, h, mx, my, pt))";
            case Element.Slot s -> throw new IllegalStateException("slots are the menu's, not widgets");
            case Element.SlotGrid s -> throw new IllegalStateException("slots are the menu's, not widgets");
            case Element.Spacer s -> throw new IllegalStateException("a spacer is a layout element, not a widget");
            case Element.Layout l -> throw new IllegalStateException("layouts are emitted by emitLayoutDecl");
            case Element.Part part -> throw new IllegalStateException("a part is expanded, not a widget");
            case Element.Repeat r -> throw new IllegalStateException("a repeat is expanded, not a widget");
        };
    }

    /** {@code Identifier.parse("...")}, or {@code null} for an absent one. */
    private String sprite(final String id) {
        if (id == null) {
            return "null";
        }
        imports.add("net.minecraft.resources.Identifier");
        return "Identifier.parse(" + JavaNames.str(id) + ")";
    }

    /** The MENU index of a slot element, through the shared {@link SlotPlan} (section 4.5). */
    private int menuSlotIndex(final String elementId) {
        for (int i = 0; i < plan.entries().size(); i++) {
            if (elementId.equals(plan.entries().get(i).elementId())) {
                return i;
            }
        }
        return -1;
    }

    /** The bar's fill fraction as an expression over the menu's accessors (section 8.2). */
    private String fraction(final Binding b) {
        if (b == null || !b.hasMax()) {
            return "0.0F";
        }
        String value = "this.menu." + JavaNames.camel(b.name()) + "()";
        String max = b.max() != null ? Integer.toString(b.max()) : "this.menu." + JavaNames.camel(b.maxBinding()) + "()";
        return req.vendorClass() + ".fraction(" + value + ", " + max + ")";
    }

    private static String component(final Text t) {
        return t.isTranslation() ? "Component.translatable(" + JavaNames.str(t.translate()) + ")"
            : "Component.literal(" + JavaNames.str(t.literal()) + ")";
    }

    // =============================================================================================
    // The screen stub (client, human)
    // =============================================================================================

    private String screenStub() {
        JavaWriter w = new JavaWriter();
        TreeSet<String> imports = new TreeSet<>(List.of(
            req.menuPackage() + "." + req.menuClass(),
            "net.minecraft.network.chat.Component",
            "net.minecraft.world.entity.player.Inventory"));
        for (String i : req.target().clientImports()) {
            imports.add(i);
        }
        String cls = req.screenClassName();
        List<String> regions = new ArrayList<>();
        for (Element e : doc.flatten()) {
            if (e instanceof Element.Region r) {
                regions.add("drawRegion_" + hookName(r));
            }
            Element.Tooltip t = e.deco().tooltip();
            if (t != null && t.isHook()) {
                regions.add("tooltip_" + JavaNames.ident(hookName(e)));
            }
        }
        w.doc("The hand-written half of the " + req.screenClass() + " screen (SCREEN_AUTHORING_DESIGN.md section 7):",
            "tooltips, render overrides, and the region hooks" + (regions.isEmpty() ? "." : " (" + String.join(", ", regions) + ")."),
            "Generated ONCE as a stub and never overwritten - this file is yours.",
            "",
            "Register the screen from your client initializer:",
            "  " + req.target().registerScreenHint(req.menuClass(), cls));
        if (req.target().clientAnnotation() != null) {
            w.line(req.target().clientAnnotation());
        }
        w.open("public class " + cls + " extends " + req.layoutClass() + "<" + req.menuClass() + ">");
        w.open("public " + cls + "(final " + req.menuClass() + " menu, final Inventory inventory, final Component title)");
        w.line("super(menu, inventory, title);");
        w.close();
        w.close();
        return file(req.clientPackage(), imports, w.toString());
    }

    // =============================================================================================

    private static String file(final String pkg, final TreeSet<String> imports, final String body) {
        StringBuilder b = new StringBuilder();
        b.append("package ").append(pkg).append(";\n\n");
        String lastGroup = null;
        for (String i : imports) {
            String group = i.startsWith("java.") ? "java" : i.startsWith("net.minecraft") ? "mc" : i.startsWith("net.fabricmc") ? "fabric" : "own";
            if (lastGroup != null && !lastGroup.equals(group)) {
                b.append('\n');
            }
            b.append("import ").append(i).append(";\n");
            lastGroup = group;
        }
        b.append('\n').append(body);
        return b.toString();
    }
}
