package com.mattmc.mcptoolkit.ui.interp;

import com.mattmc.mcptoolkit.McpToolkit;
import com.mattmc.mcptoolkit.ui.Palette;
import com.mattmc.mcptoolkit.ui.edit.UiEditor;
import com.mattmc.mcptoolkit.ui.doc.Element;
import com.mattmc.mcptoolkit.ui.doc.SlotPlan;
import com.mattmc.mcptoolkit.ui.doc.UiDocument;
import com.mattmc.mcptoolkit.ui.doc.UiParseException;
import net.fabricmc.api.EnvType;
import net.fabricmc.api.Environment;
import net.minecraft.util.Util;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.gui.screens.inventory.AbstractContainerScreen;
import net.minecraft.client.renderer.RenderPipelines;
import net.minecraft.client.input.KeyEvent;
import net.minecraft.client.input.MouseButtonEvent;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.Identifier;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.inventory.ContainerInput;
import net.minecraft.world.inventory.Slot;
import org.jspecify.annotations.Nullable;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The interpreter (SCREEN_AUTHORING_DESIGN.md section 6.1): a container screen that draws a document.
 *
 * <p>One code path, two fidelities. Detached, the menu is a {@link DetachedMenu} built from the
 * document; <b>attached (slice 6), it is the live menu the real screen was wrapping</b> - the same
 * instance, so the slots hold the real stacks and the bindings are the values the server synced.
 * The screen does not care which: it reads slots off {@code menu.slots} and bindings through
 * {@link UiBindings}, and that indifference is what made the attached swap a small change rather
 * than a second screen.
 *
 * <p><b>{@code init()} re-reads the document.</b> That is section 1's whole resolution of the "a live
 * tweak evaporates on the next {@code init()}" objection: the destination is the document, so a
 * rebuild (window resize, reopen after {@code /reload}) shows the file as it is now. A document that
 * fails to parse keeps the last good tree on screen and prints the problems where the screen is, so
 * a typo mid-edit never blanks the preview. {@code imageWidth}/{@code imageHeight} are final in the
 * superclass, so a size change is reported and needs a reopen.
 */
@Environment(EnvType.CLIENT)
public final class InterpretedScreen extends AbstractContainerScreen<AbstractContainerMenu> {
    private static final long ACTION_TOAST_MS = 2000L;

    private final UiSource source;
    private UiDocument doc;
    private @Nullable String loadError;
    private final Map<String, AbstractWidget> byId = new LinkedHashMap<>();
    private final Map<String, int[]> rectsByPath = new LinkedHashMap<>();
    /** {@code visible} / {@code enabled}, re-run every tick - exactly what the emitter generates. */
    private final List<Runnable> states = new ArrayList<>();
    /** The tooltip zones (section 3.2), in document order. */
    private final List<Paint.Hover> tooltips = new ArrayList<>();
    private @Nullable String lastAction;
    private long lastActionAt;
    private @Nullable UiEditor editor;
    private @Nullable Screen wrapped;
    private UiBindings.Source bindingSource = UiBindings.Source.NONE;
    private SlotPlan.@Nullable Drift drift;

    public InterpretedScreen(final UiSource source, final UiDocument doc, final AbstractContainerMenu menu,
                             final Inventory inventory) {
        super(menu, inventory, WidgetBuilder.component(doc.title()), doc.width(), doc.height());
        this.source = source;
        this.doc = doc;
        applyLabels();
    }

    private void applyLabels() {
        titleLabelX = doc.titleX();
        titleLabelY = doc.titleY();
        inventoryLabelX = doc.inventoryLabel().x();
        inventoryLabelY = doc.inventoryLabel().y();
    }

    public UiSource source() {
        return source;
    }

    public UiDocument document() {
        return doc;
    }

    /** The problems of the last failed re-read, or {@code null} when the screen shows the file as it is. */
    public @Nullable String loadError() {
        return loadError;
    }

    /** Declared widgets by id, from the last {@code init()}. Layout nodes included; slots are not widgets. */
    public Map<String, AbstractWidget> widgetsById() {
        return Collections.unmodifiableMap(byId);
    }

    /** The last action a button fired, detached - what a probe reads to prove the wiring. */
    public @Nullable String lastAction() {
        return lastAction;
    }

    public boolean isDetached() {
        return menu instanceof DetachedMenu;
    }

    /**
     * The screen this preview was swapped IN FRONT OF, attached - and what {@code detach} puts back.
     *
     * <p>Holding the instance rather than its class is deliberate: the screen and the menu are what
     * the swap must not disturb (section 6.1), and putting the same object back is the cheapest
     * proof that neither was.
     */
    public @Nullable Screen wrapped() {
        return wrapped;
    }

    /** Attached mode: remember the screen that was showing this menu. Set once, by {@link UiAttach}. */
    void wrap(final Screen previous) {
        this.wrapped = previous;
    }

    /** Which shape the menu answered its bindings through, from the last {@code init()}. */
    public UiBindings.Source bindingSource() {
        return bindingSource;
    }

    /**
     * Attached: how far the live menu's slots have drifted from the document's, from the last
     * {@code init()}. Detached it is always clean - the menu was built from the document.
     */
    public SlotPlan.@Nullable Drift slotDrift() {
        return drift;
    }

    /** The live menu, for a report that names its class and container id. */
    public AbstractContainerMenu menu() {
        return menu;
    }

    /**
     * Screen-space rectangles by element path ({@code elements[3].children[1]}), from the last
     * {@code init()}. The editor's hit test: unlike {@link #widgetsById()} this covers UNNAMED
     * elements and a spacer, neither of which can be addressed by id.
     */
    public Map<String, int[]> rectsByPath() {
        return Collections.unmodifiableMap(rectsByPath);
    }

    public int panelLeft() {
        return leftPos;
    }

    public int panelTop() {
        return topPos;
    }

    public int imageWidth() {
        return imageWidth;
    }

    public int imageHeight() {
        return imageHeight;
    }

    public Font fontRef() {
        return font;
    }

    /** The editor when this preview is in edit mode (slice 4), else {@code null}. */
    public @Nullable UiEditor editorMode() {
        return editor;
    }

    /** Turn the editor on: handles, palette, inspector, undo, save (section 9). */
    public UiEditor enterEdit() {
        if (editor == null) {
            editor = new UiEditor(this);
            rebuildWidgets();
        }
        return editor;
    }

    /**
     * Turn the editor off. Unsaved edits stay in the document on screen rather than being thrown
     * away silently - the next {@code init()} will re-read the file, so the tool reply says so.
     */
    public void leaveEdit() {
        editor = null;
        rebuildWidgets();
    }

    /**
     * Adopt a document the editor produced: the destination of an edit is the document
     * (SCREEN_AUTHORING_DESIGN.md section 1), and this is where it lands on screen.
     */
    public void adopt(final UiDocument next) {
        doc = next;
        applyLabels();
        rebuildWidgets();
    }

    // ---------------------------------------------------------------------------------------------

    @Override
    protected void init() {
        super.init();
        reload();
        byId.clear();
        rectsByPath.clear();
        states.clear();
        tooltips.clear();
        UiBindings.Bound bound = UiBindings.bind(menu);
        bindingSource = bound.source();
        new WidgetBuilder(doc, font, leftPos, topPos, this::addRenderableWidget, byId, rectsByPath,
            this::onAction, bound.values(), menu, states, tooltips).buildAll();
        // Before the first frame, not on the first tick: a screen opened on a hidden button would
        // show it for a frame otherwise. The generated screen does the same, in the same place.
        applyStates();
        drift = measureDrift();
        if (editor != null) {
            // The editor's furniture goes on AFTER the document's widgets, so nothing of the
            // document ever sits above a palette button in the click order.
            editor.install(this::addRenderableWidget);
        }
    }

    /**
     * Re-read the document; keep the last good tree and remember why if it fails.
     *
     * <p><b>While the editor is on it owns the document and nothing is re-read.</b> A window resize
     * calls {@code init()}, and so does every single edit - re-reading there would throw away the
     * human's unsaved work on the next keystroke, which is the failure section 1 is about.
     */
    private void reload() {
        if (editor != null) {
            doc = editor.document();
            applyLabels();
            return;
        }
        try {
            UiDocument fresh = source.load();
            if (fresh.width() != imageWidth || fresh.height() != imageHeight) {
                loadError = "size changed to " + fresh.width() + "x" + fresh.height()
                    + "; reopen the preview to apply it";
            } else {
                loadError = null;
            }
            doc = fresh;
            applyLabels();
        } catch (IOException e) {
            loadError = "cannot read " + source.describe() + ": " + e.getMessage();
        } catch (UiParseException e) {
            loadError = e.getMessage();
        }
        if (loadError != null) {
            McpToolkit.LOGGER.warn("[MCP Toolkit] ui preview {}: {}", source.describe(), loadError);
        }
    }

    /**
     * The document's slots against the ones the live menu actually has. A final {@code Slot.x}
     * (26.2) is why this is a REPORT and not a correction.
     */
    private SlotPlan.@Nullable Drift measureDrift() {
        if (isDetached()) {
            return null;
        }
        int[][] live = new int[menu.slots.size()][];
        for (int i = 0; i < live.length; i++) {
            Slot s = menu.slots.get(i);
            live[i] = new int[] {s.x, s.y};
        }
        return SlotPlan.compare(SlotPlan.of(doc), live);
    }

    /**
     * A button was pressed.
     *
     * <p>The id is the DOCUMENT's arithmetic - the base of the action's block plus the row-major
     * offset of the button's own arguments (UI_PARTS_LIBRARY_DESIGN.md section 4.2) - which is the
     * same number the generated screen's {@code press<Action>} helper computes, from the same one
     * declared arity.
     */
    private void onAction(final Element.Button button) {
        lastAction = button.action() + (button.args().isEmpty() ? "" : button.args().toString());
        lastActionAt = Util.getMillis();
        if (!isDetached()) {
            int id = doc.actionId(button.action(), button.args());
            if (id >= 0 && minecraft != null && minecraft.gameMode != null && minecraft.player != null) {
                minecraft.gameMode.handleInventoryButtonClick(menu.containerId, id);
            }
        }
    }

    /**
     * Re-read every {@code visible} / {@code enabled} predicate (section 3.3).
     *
     * <p><b>Per FRAME, not per tick.</b> Vanilla syncs data slots without a slot change, so nothing
     * tells a screen that a flag moved - the footgun every hand-written screen answers with its own
     * {@code containerTick} override. But {@code AbstractContainerMenu.setData} does not notify
     * listeners on the client (they fire from {@code broadcastChanges}, the server's), so a value can
     * arrive and sit unread until the next tick. The generated screen does exactly this, in the same
     * place, and a divergence here is a divergence the conformance battery catches - which is how
     * the tick-lag was found in the first place.
     */
    private void applyStates() {
        for (Runnable state : states) {
            state.run();
        }
    }

    // ---------------------------------------------------------------------------------------------

    @Override
    public void extractBackground(final GuiGraphicsExtractor g, final int mouseX, final int mouseY, final float a) {
        super.extractBackground(g, mouseX, mouseY, a);
        if (doc.background() != null) {
            // The seam section 4.1 leaves open: a texture at the panel origin, vanilla's 256x256 sheet.
            g.blit(RenderPipelines.GUI_TEXTURED, Identifier.parse(doc.background()), leftPos, topPos,
                0.0F, 0.0F, imageWidth, imageHeight, 256, 256, 0xFFFFFFFF);
        } else {
            Paint.screenFrame(g, leftPos, topPos, imageWidth, imageHeight);
        }
    }

    /**
     * Wells first, then the labels. This hook runs after the widgets and before the slot items, with
     * the pose at the panel origin - the one moment a well is over every panel and under every item.
     */
    @Override
    protected void extractLabels(final GuiGraphicsExtractor g, final int mouseX, final int mouseY) {
        Paint.slots(g, menu, 0, 0);
        g.text(font, title, titleLabelX, titleLabelY, Palette.LABEL_COLOR, false);
        if (doc.inventoryLabel().shown()) {
            g.text(font, playerInventoryTitle, inventoryLabelX, inventoryLabelY, Palette.LABEL_COLOR, false);
        }
    }

    @Override
    public void extractRenderState(final GuiGraphicsExtractor g, final int mouseX, final int mouseY, final float a) {
        applyStates();
        super.extractRenderState(g, mouseX, mouseY, a);
        if (loadError != null) {
            g.nextStratum();
            g.textWithWordWrap(font, Component.literal(loadError), 4, 4, width - 8, Palette.MISSING_COLOR, true);
        }
        if (lastAction != null && Util.getMillis() - lastActionAt < ACTION_TOAST_MS) {
            g.nextStratum();
            String toast = "action: " + lastAction + (isDetached()
                ? " (detached - nothing to send it to)"
                : " (sent to the server on menu " + menu.containerId + ")");
            g.text(font, toast, leftPos, topPos + imageHeight + 4, 0xFFFFFFFF, true);
        }
        if (drift != null && !drift.clean()) {
            // Attached over a menu that no longer matches the document. Say it on screen: a slot that
            // will not follow the drag is the one thing about attached mode a human cannot deduce.
            g.nextStratum();
            g.text(font, drift.moved() + " slot(s) differ from the document - the running menu was"
                + " compiled from another version of it", leftPos, topPos + imageHeight + 14,
                Palette.MISSING_COLOR, true);
        }
        if (editor != null) {
            editor.drawOverlay(g, mouseX, mouseY);
        } else {
            // Not in edit mode: the document's tooltips. In edit mode the pointer is a tool and a
            // tooltip under it would cover the handles.
            Paint.tooltips(g, font, tooltips, mouseX, mouseY);
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Editor input. Every one of these hands the event to the editor FIRST and only then to vanilla,
    // because in edit mode a press on a button means "select this button", not "press it", and a
    // press on a slot means "select this slot", not "pick up the placeholder".

    @Override
    public boolean mouseClicked(final MouseButtonEvent event, final boolean doubleClick) {
        if (editor != null && !editor.overChrome(event.x(), event.y())
            && editor.mousePressed(event.x(), event.y(), event.button())) {
            return true;
        }
        return super.mouseClicked(event, doubleClick);
    }

    @Override
    public boolean mouseDragged(final MouseButtonEvent event, final double dx, final double dy) {
        // The absolute position, not the per-event delta: a drag driven by the `click` tool arrives
        // as a handful of steps, and summing deltas would drift.
        if (editor != null && editor.mouseDragged(event.x(), event.y())) {
            return true;
        }
        return super.mouseDragged(event, dx, dy);
    }

    @Override
    public boolean mouseReleased(final MouseButtonEvent event) {
        if (editor != null && editor.mouseReleased(event.x(), event.y())) {
            return true;
        }
        return super.mouseReleased(event);
    }

    /**
     * <b>Ctrl+G toggles the editor</b>, and it is checked before anything else for a reason worth
     * writing down: {@code KeyMapping.matches} ignores modifiers, so ANY chord containing the
     * inventory key (E by default) closes a container screen. A chord on E was the obvious choice
     * and it is unusable.
     */
    @Override
    public boolean keyPressed(final KeyEvent event) {
        if (event.hasControlDown() && event.key() == com.mojang.blaze3d.platform.InputConstants.KEY_G) {
            if (editor == null) {
                enterEdit();
            } else {
                leaveEdit();
            }
            return true;
        }
        if (editor != null && editor.keyPressed(event)) {
            return true;
        }
        return super.keyPressed(event);
    }

    /**
     * Detached, a slot click is applied to the synthetic menu locally so placeholders can be picked
     * up and put down; nothing is sent. Only the two inputs a preview needs; a drop or a hotbar swap
     * would reach into the real player.
     */
    @Override
    protected void slotClicked(final Slot slot, final int slotId, final int button, final ContainerInput input) {
        if (editor != null) {
            return; // in edit mode a slot is a thing you move, not a thing you reach into
        }
        if (!isDetached()) {
            super.slotClicked(slot, slotId, button, input);
            return;
        }
        if (minecraft == null || minecraft.player == null) {
            return;
        }
        if (input == ContainerInput.PICKUP || input == ContainerInput.QUICK_MOVE) {
            menu.clicked(slotId, button, input, minecraft.player);
        }
    }
}
