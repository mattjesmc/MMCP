package com.mattmc.mcptoolkit.ui.sample.client;

import com.mattmc.mcptoolkit.ui.sample.menu.ExampleMenuBase;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import net.fabricmc.api.EnvType;
import net.fabricmc.api.Environment;

import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.layouts.FrameLayout;
import net.minecraft.client.gui.layouts.GridLayout;
import net.minecraft.client.gui.layouts.Layout;
import net.minecraft.client.gui.layouts.LinearLayout;
import net.minecraft.client.gui.layouts.SpacerElement;
import net.minecraft.client.gui.screens.inventory.AbstractContainerScreen;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.Identifier;
import net.minecraft.world.entity.player.Inventory;

/**
 * GENERATED from assets/mcptoolkit/ui/example.ui.json by the mcp-toolkit screen compiler - DO NOT EDIT.
 * Regenerated on every save of the document; hand edits are lost. Behaviour goes in the
 * subclass (SCREEN_AUTHORING_DESIGN.md section 7).
 *
 * The screen's machine half: every element as a widget at the document's geometry, layouts arranged the way the dev-time interpreter arranges them, the slot wells, and a hook per region.
 *
 * Parts used (UI_PARTS_LIBRARY_DESIGN.md section 5):
 *   mcptoolkit:entity_preview #afb28f8b as preview
 *   mcptoolkit:player_inventory #b29b2ea2 as inv
 *   mcptoolkit:station_inputs #d4e01fce as inputs
 */
@Environment(EnvType.CLIENT)
public abstract class ExampleLayout<M extends ExampleMenuBase> extends AbstractContainerScreen<M> {
    private final Map<String, AbstractWidget> declared = new LinkedHashMap<>();
    /** What `visible` and `enabled` mean, re-read whenever a synced value can have changed. */
    private final List<Runnable> states = new ArrayList<>();
    /** The rectangles that show a tooltip, with what to show (section 3.2). */
    private final List<McptoolkitUi.Paint.Hover> tooltips = new ArrayList<>();

    protected ExampleLayout(final M menu, final Inventory inventory, final Component title) {
        super(menu, inventory, title, 256, 222);
        this.titleLabelX = 8;
        this.titleLabelY = 6;
        this.inventoryLabelX = 8;
        this.inventoryLabelY = 128;
    }

    /**
     * The declared widgets by document id, from the last {@code init()}. Layout nodes included;
     * slots are the menu's ({@code this.menu.slots}), not widgets.
     */
    public Map<String, AbstractWidget> declaredWidgets() {
        return Collections.unmodifiableMap(this.declared);
    }

    /**
     * A declared widget by id, or {@code null} before {@code init()} or for an unnamed element.
     */
    protected AbstractWidget widget(final String id) {
        return this.declared.get(id);
    }

    @Override
    protected void init() {
        super.init();
        this.declared.clear();
        this.states.clear();
        this.tooltips.clear();
        this.declare("outer", this.addRenderableWidget(new McptoolkitUi.Decor("outer", "frame", this.leftPos + 0, this.topPos + 0, 256, 222, (g, x, y, w, h, mx, my, pt) -> McptoolkitUi.Paint.screenFrame(g, x, y, w, h))));
        this.declare("smelting", this.addRenderableWidget(new McptoolkitUi.Decor("smelting", "well", this.leftPos + 8, this.topPos + 18, 160, 40, (g, x, y, w, h, mx, my, pt) -> McptoolkitUi.Paint.well(g, x, y, w, h))));
        this.declare("fuel_label", this.addRenderableWidget(new McptoolkitUi.Label("fuel_label", this.leftPos + 14, this.topPos + 24, 0, 0, Component.literal("Fuel"), this.font, McptoolkitUi.LabelMode.PLAIN, 0xFF404040, false)));
        // Slots are the menu's (ExampleMenuBase); their wells are painted in extractLabels.
        this.declare("progress_bar", this.addRenderableWidget(new McptoolkitUi.Decor("progress_bar", "bar", this.leftPos + 40, this.topPos + 40, 60, 8, (g, x, y, w, h, mx, my, pt) -> McptoolkitUi.Paint.bar(g, x, y, w, h, McptoolkitUi.fraction(this.menu.progress(), 200), 0xFF206020, 0xFF8B8B8B))));
        this.declare("logo", this.addRenderableWidget(new McptoolkitUi.ItemView("logo", this.leftPos + 134, this.topPos + 37, McptoolkitUi.stack("minecraft:diamond", 3), true)));
        this.declare("check", this.addRenderableWidget(new McptoolkitUi.Icon("check", this.leftPos + 154, this.topPos + 38, 12, 12, Identifier.parse("minecraft:icon/checkmark"), null, 0, 0, 12, 12, 256, 256, 0xFFFFFFFF)));
        this.declare("blurb", this.addRenderableWidget(new McptoolkitUi.Label("blurb", this.leftPos + 8, this.topPos + 60, 140, 0, Component.literal("A wrapped label runs on to a second line."), this.font, McptoolkitUi.LabelMode.WRAPPED, 0xFF404040, false)));
        this.declare("fuel_gauge", this.addRenderableWidget(new McptoolkitUi.Decor("fuel_gauge", "bar", this.leftPos + 160, this.topPos + 60, 8, 30, (g, x, y, w, h, mx, my, pt) -> McptoolkitUi.Paint.barVertical(g, x, y, w, h, McptoolkitUi.fraction(this.menu.fuel(), this.menu.fuelMax()), 0xFFAA5500, 0xFF8B8B8B))));
        this.declare("ticker", this.addRenderableWidget(new McptoolkitUi.Label("ticker", this.leftPos + 8, this.topPos + 82, 80, 0, Component.literal("This scrolling label is much longer than eighty pixels"), this.font, McptoolkitUi.LabelMode.SCROLLING, 0xFF808080, false)));
        this.declare("clipped", this.addRenderableWidget(new McptoolkitUi.Label("clipped", this.leftPos + 92, this.topPos + 82, 56, 0, Component.literal("Truncated with an ellipsis"), this.font, McptoolkitUi.LabelMode.TRUNCATED, 0xFF404040, false)));
        this.declare("gauge", this.addRenderableWidget(new McptoolkitUi.Decor("gauge", "region", this.leftPos + 150, this.topPos + 82, 18, 10, (g, x, y, w, h, mx, my, pt) -> this.drawRegion_gauge(g, x, y, w, h, mx, my, pt))));
        {
            // the 'footer' row: arranged by vanilla's layout, then handed over, exactly as the interpreter does it.
            LinearLayout l_footer = LinearLayout.horizontal().spacing(4);
            McptoolkitUi.PressButton w_launch = this.declare("launch", new McptoolkitUi.PressButton("launch", 0, 0, 50, 20, Component.literal("Launch"), null, null, false, btn -> this.press(ExampleMenuBase.ACTION_LAUNCH)));
            this.states.add(() -> { w_launch.active = this.menu.progress() != 0; });
            this.tooltips.add(new McptoolkitUi.Paint.Hover(w_launch, () -> List.of(Component.literal("Send it up"))));
            l_footer.addChild(w_launch, l_footer.newCellSettings());
            McptoolkitUi.PressButton w_ok = this.declare("ok", new McptoolkitUi.PressButton("ok", 0, 0, 20, 20, Component.literal(""), Identifier.parse("minecraft:icon/checkmark"), null, false, btn -> this.press(ExampleMenuBase.ACTION_CANCEL)));
            this.tooltips.add(new McptoolkitUi.Paint.Hover(w_ok, () -> this.tooltip_ok()));
            l_footer.addChild(w_ok, l_footer.newCellSettings());
            l_footer.addChild(new SpacerElement(4, 0), l_footer.newCellSettings());
            LinearLayout l_notes = LinearLayout.vertical().spacing(1);
            McptoolkitUi.Label w_note_a = this.declare("note_a", new McptoolkitUi.Label("note_a", 0, 0, 0, 0, Component.literal("col a"), this.font, McptoolkitUi.LabelMode.PLAIN, 0xFF404040, false));
            l_notes.addChild(w_note_a, l_notes.newCellSettings());
            McptoolkitUi.Label w_note_b = this.declare("note_b", new McptoolkitUi.Label("note_b", 0, 0, 0, 0, Component.literal("col b"), this.font, McptoolkitUi.LabelMode.PLAIN, 0xFF404040, false));
            l_notes.addChild(w_note_b, l_notes.newCellSettings());
            l_footer.addChild(l_notes, l_footer.newCellSettings());
            FrameLayout l_badge = new FrameLayout();
            McptoolkitUi.Decor w_badge_bg = this.declare("badge_bg", new McptoolkitUi.Decor("badge_bg", "panel", 0, 0, 32, 20, (g, x, y, w, h, mx, my, pt) -> McptoolkitUi.Paint.panel(g, x, y, w, h)));
            l_badge.addChild(w_badge_bg, l_badge.newChildLayoutSettings());
            McptoolkitUi.Label w_badge_text = this.declare("badge_text", new McptoolkitUi.Label("badge_text", 0, 0, 0, 0, Component.literal("on"), this.font, McptoolkitUi.LabelMode.PLAIN, 0xFF404040, false));
            l_badge.addChild(w_badge_text, l_badge.newChildLayoutSettings().align(0.5F, 0.5F));
            l_footer.addChild(l_badge, l_footer.newCellSettings());
            GridLayout l_pairs = new GridLayout().spacing(2);
            McptoolkitUi.Label w_g00 = this.declare("g00", new McptoolkitUi.Label("g00", 0, 0, 0, 0, Component.literal("1"), this.font, McptoolkitUi.LabelMode.PLAIN, 0xFF404040, false));
            l_pairs.addChild(w_g00, 0, 0, 1, 1, l_pairs.newCellSettings());
            McptoolkitUi.Label w_g01 = this.declare("g01", new McptoolkitUi.Label("g01", 0, 0, 0, 0, Component.literal("2"), this.font, McptoolkitUi.LabelMode.PLAIN, 0xFF404040, false));
            l_pairs.addChild(w_g01, 0, 1, 1, 1, l_pairs.newCellSettings());
            McptoolkitUi.Label w_g10 = this.declare("g10", new McptoolkitUi.Label("g10", 0, 0, 0, 0, Component.literal("3"), this.font, McptoolkitUi.LabelMode.PLAIN, 0xFF404040, false));
            l_pairs.addChild(w_g10, 1, 0, 1, 1, l_pairs.newCellSettings());
            McptoolkitUi.Label w_g11 = this.declare("g11", new McptoolkitUi.Label("g11", 0, 0, 0, 0, Component.literal("4"), this.font, McptoolkitUi.LabelMode.PLAIN, 0xFF404040, false));
            l_pairs.addChild(w_g11, 1, 1, 1, 1, l_pairs.newCellSettings().padding(1, 1, 1, 1));
            l_footer.addChild(l_pairs, l_footer.newCellSettings());
            l_footer.setX(this.leftPos + 8);
            l_footer.setY(this.topPos + 94);
            l_footer.arrangeElements();
            w_note_b.setX(w_note_b.getX() + 2);
            l_footer.visitWidgets(this::addRenderableWidget);
            this.node("footer", "row", l_footer);
            this.node("notes", "column", l_notes);
            this.node("badge", "stack", l_badge);
            this.node("pairs", "grid", l_pairs);
        }
        // part 'preview' (mcptoolkit:entity_preview #afb28f8b), expanded at parse time:
        this.declare("preview.back", this.addRenderableWidget(new McptoolkitUi.Decor("preview.back", "well", this.leftPos + 176, this.topPos + 18, 36, 52, (g, x, y, w, h, mx, my, pt) -> McptoolkitUi.Paint.well(g, x, y, w, h))));
        this.declare("preview.subject", this.addRenderableWidget(new McptoolkitUi.EntityView("preview.subject", this.leftPos + 177, this.topPos + 19, 34, 50, "armor_stand", 22.0F, 25.0F, 210.0F, false, false, () -> List.of())));
        // part 'inputs' (mcptoolkit:station_inputs #d4e01fce), expanded at parse time:
        // repeat 'arrows', expanded at parse time:
        this.declare("arrows.0.pick", this.addRenderableWidget(new McptoolkitUi.PressButton("arrows.0.pick", this.leftPos + 218, this.topPos + 40, 12, 16, Component.literal(""), Identifier.parse("minecraft:widget/page_forward"), Identifier.parse("minecraft:widget/page_forward_highlighted"), true, btn -> this.pressSelect(0))));
        this.declare("arrows.1.pick", this.addRenderableWidget(new McptoolkitUi.PressButton("arrows.1.pick", this.leftPos + 218, this.topPos + 58, 12, 16, Component.literal(""), Identifier.parse("minecraft:widget/page_forward"), Identifier.parse("minecraft:widget/page_forward_highlighted"), true, btn -> this.pressSelect(1))));
        this.declare("arrows.2.pick", this.addRenderableWidget(new McptoolkitUi.PressButton("arrows.2.pick", this.leftPos + 218, this.topPos + 76, 12, 16, Component.literal(""), Identifier.parse("minecraft:widget/page_forward"), Identifier.parse("minecraft:widget/page_forward_highlighted"), true, btn -> this.pressSelect(2))));
        this.declare("crop", this.addRenderableWidget(new McptoolkitUi.Icon("crop", this.leftPos + 176, this.topPos + 74, 16, 16, null, Identifier.parse("minecraft:textures/gui/container/inventory.png"), 7, 83, 18, 18, 256, 256, 0xFFFFFFFF)));
        McptoolkitUi.Label w_hidden_note = this.declare("hidden_note", this.addRenderableWidget(new McptoolkitUi.Label("hidden_note", this.leftPos + 176, this.topPos + 94, 60, 0, Component.literal("never shown"), this.font, McptoolkitUi.LabelMode.TRUNCATED, 0xFF404040, false)));
        this.states.add(() -> { w_hidden_note.visible = this.menu.progress() > 1000; });
        // part 'inv' (mcptoolkit:player_inventory #b29b2ea2), expanded at parse time:
        // Before anything is drawn: a screen opened on a hidden button would show it for a
        // frame otherwise.
        this.applyStates();
    }

    /**
     * Re-read every {@code visible} / {@code enabled} predicate.
     *
     * <b>Per FRAME, not per tick, and that is a finding rather than a preference.</b> Vanilla
     * syncs data slots without a slot change, so nothing tells a screen that a flag moved -
     * which is why every hand-written screen that has one grows a {@code containerTick}
     * override. But {@code AbstractContainerMenu.setData} does NOT notify listeners on the
     * client (they fire from {@code broadcastChanges}, which is the server's), so a value can
     * arrive and sit there until the next tick: a button that should be live reads dead for up
     * to 50ms, and two renderers compared in that window disagree. A predicate is a pure
     * function of the current values, so it is evaluated where it is used.
     */
    private void applyStates() {
        for (Runnable state : this.states) {
            state.run();
        }
    }

    @Override
    public void extractRenderState(final GuiGraphicsExtractor g, final int mouseX, final int mouseY, final float partialTick) {
        this.applyStates();
        super.extractRenderState(g, mouseX, mouseY, partialTick);
        McptoolkitUi.Paint.tooltips(g, this.font, this.tooltips, mouseX, mouseY);
    }

    private <W extends AbstractWidget> W declare(final String id, final W widget) {
        if (id != null) {
            this.declared.put(id, widget);
        }
        return widget;
    }

    /**
     * A layout node as an inactive widget over its arranged bounds, so a tool can name it.
     */
    private void node(final String id, final String kind, final Layout layout) {
        this.declare(id, this.addRenderableWidget(new McptoolkitUi.Decor(id, kind, layout.getX(), layout.getY(), layout.getWidth(), layout.getHeight(), (g, x, y, w, h, mx, my, pt) -> { })));
    }

    /**
     * Send a declared action down vanilla's button channel (section 8.1); the server answers in
     * {@code ExampleMenuBase.clickMenuButton}.
     */
    protected void press(final int action) {
        if (this.minecraft != null && this.minecraft.gameMode != null) {
            this.minecraft.gameMode.handleInventoryButtonClick(this.menu.containerId, action);
        }
    }

    /**
     * Press {@code select} with these arguments.
     *
     * The id arithmetic lives here and in {@code ExampleMenuBase.clickMenuButton}, both
     * generated from the one arity the document declares - so a stride typo cannot make a
     * click land on another action (section 4.2).
     */
    protected void pressSelect(final int index) {
        if (index < 0 || index >= ExampleMenuBase.ACTION_SELECT_INDEX_SIZE) {
            throw new IllegalArgumentException("select index must be 0.." + (ExampleMenuBase.ACTION_SELECT_INDEX_SIZE - 1) + ", got " + index);
        }
        this.press(ExampleMenuBase.ACTION_SELECT + index);
    }

    @Override
    public void extractBackground(final GuiGraphicsExtractor g, final int mouseX, final int mouseY, final float partialTick) {
        super.extractBackground(g, mouseX, mouseY, partialTick);
        McptoolkitUi.Paint.screenFrame(g, this.leftPos, this.topPos, this.imageWidth, this.imageHeight);
    }

    /**
     * Wells first, then the labels: this hook runs after the widgets and before the slot items,
     * with the pose at the panel origin.
     */
    @Override
    protected void extractLabels(final GuiGraphicsExtractor g, final int mouseX, final int mouseY) {
        McptoolkitUi.Paint.slots(g, this.menu, 0, 0);
        g.text(this.font, this.title, this.titleLabelX, this.titleLabelY, 0xFF404040, false);
        g.text(this.font, this.playerInventoryTitle, this.inventoryLabelX, this.inventoryLabelY, 0xFF404040, false);
    }

    /**
     * The {@code gauge} region (section 4.4): a named rectangle that draws nothing until you
     * override this. {@code (x, y)} is its top-left in window coordinates; {@code w}/{@code h} its size.
     */
    protected void drawRegion_gauge(final GuiGraphicsExtractor g, final int x, final int y, final int w, final int h, final int mouseX, final int mouseY, final float partialTick) {
        // Empty by default; the interpreter draws nothing here either, so the two agree.
    }

    /**
     * The {@code ok} tooltip (section 3.2): the lines to show while the pointer is over it.
     * Empty by default - and the interpreter shows nothing either, so a preview and this screen
     * agree until you fill it in. Called every frame the pointer is inside the rectangle.
     */
    protected List<Component> tooltip_ok() {
        return List.of();
    }
}
