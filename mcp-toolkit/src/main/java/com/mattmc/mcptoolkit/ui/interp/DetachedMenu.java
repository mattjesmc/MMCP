package com.mattmc.mcptoolkit.ui.interp;

import com.mattmc.mcptoolkit.McpToolkit;
import com.mattmc.mcptoolkit.ui.doc.Element;
import com.mattmc.mcptoolkit.ui.doc.SlotPlan;
import com.mattmc.mcptoolkit.ui.doc.UiDocument;
import net.fabricmc.api.EnvType;
import net.fabricmc.api.Environment;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.world.Container;
import net.minecraft.world.SimpleContainer;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.inventory.DataSlot;
import net.minecraft.world.inventory.Slot;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;

import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;

/**
 * The synthetic menu behind a DETACHED preview (SCREEN_AUTHORING_DESIGN.md section 6.1): built from
 * the document's own slot declarations, filled with its placeholder stacks, answering its bindings
 * from their {@code preview} values. No server knows it exists.
 *
 * <p>Three things it deliberately is not:
 * <ul>
 *   <li><b>Not the player's real inventory.</b> The {@code player} container is a COPY of the
 *       client's inventory at open time. A preview click moves stacks locally
 *       ({@link InterpretedScreen}), and moving the real client-side inventory without a server round
 *       trip would desync it from the one the server holds.</li>
 *   <li><b>Not reachable from the server.</b> {@link #CONTAINER_ID} matches no server menu, so even
 *       a click that escaped to {@code MultiPlayerGameMode.handleContainerInput} is dropped there
 *       ("Ignoring click in mismatching container", verified in 26.2 source) rather than applied to
 *       whatever menu the player really has open.</li>
 *   <li><b>Not a quick-move implementation.</b> {@code quickMoveStack} answers EMPTY; the emitted
 *       one (slice 2) is the real thing, written once to vanilla's algorithm.</li>
 * </ul>
 *
 * <p>Data slots are registered one per binding (two for a {@code wide} one) so the count matches
 * what the emitter will lay out; nothing syncs them here, and the interpreter reads bindings by name
 * through {@link UiBindings} rather than by slot index.
 */
@Environment(EnvType.CLIENT)
public final class DetachedMenu extends AbstractContainerMenu implements UiBindings {
    /** A container id no server menu will ever carry (vanilla's cycle 1..100, inventory 0). */
    public static final int CONTAINER_ID = 0x7FFF0000;

    private final UiDocument doc;
    private final Map<String, Container> containers = new LinkedHashMap<>();
    private final Map<String, Integer> values = new HashMap<>();

    public DetachedMenu(final UiDocument doc, final Inventory playerInventory) {
        super(null, CONTAINER_ID);
        this.doc = doc;
        SimpleContainer player = new SimpleContainer(UiDocument.PLAYER_SLOTS);
        for (int i = 0; i < UiDocument.PLAYER_SLOTS; i++) {
            player.setItem(i, playerInventory.getItem(i).copy());
        }
        containers.put(UiDocument.PLAYER_CONTAINER, player);
        for (UiDocument.Container c : doc.containers()) {
            containers.put(c.name(), new SimpleContainer(c.size()));
        }
        // The slot list is the PLAN's, not the document's paint order: SlotPlan orders declared
        // containers, then backpack, then hotbar, and the emitted menu base adds from the same plan,
        // so an index here is the same index there (section 4.5, made literal).
        Map<String, String> icons = new HashMap<>();
        for (Element e : doc.flatten()) {
            String icon = e instanceof Element.Slot s ? s.icon()
                : e instanceof Element.SlotGrid g ? g.icon() : null;
            if (icon != null && e.id() != null) {
                icons.put(e.id(), icon);
            }
        }
        for (SlotPlan.Entry s : SlotPlan.of(doc).entries()) {
            String icon = s.elementId() == null ? null : icons.get(s.elementId());
            addSlot(icon == null ? new Slot(container(s.container()), s.index(), s.x(), s.y())
                : new IconSlot(container(s.container()), s.index(), s.x(), s.y(), Identifier.parse(icon)));
        }
        for (Element e : doc.flatten()) {
            if (e instanceof Element.Slot s) {
                fill(s.container(), s.index(), s.placeholder());
            } else if (e instanceof Element.SlotGrid g) {
                for (int i = 0; i < g.count(); i++) {
                    fill(g.container(), g.first() + i, g.placeholder());
                }
            }
        }
        for (UiDocument.Binding b : doc.bindings()) {
            values.put(b.name(), b.preview());
            addDataSlot(DataSlot.standalone()).set(b.wide() ? (b.preview() >>> 16) & 0xFFFF : b.preview());
            if (b.wide()) {
                addDataSlot(DataSlot.standalone()).set(b.preview() & 0xFFFF);
            }
        }
    }

    /**
     * A slot that shows a sprite while it is empty - the emitted menu base carries the identical
     * class, because {@code Slot.getNoItemIcon()} is what vanilla's own container screen draws and
     * neither renderer paints it.
     */
    private static final class IconSlot extends Slot {
        private final Identifier icon;

        IconSlot(final Container container, final int index, final int x, final int y, final Identifier icon) {
            super(container, index, x, y);
            this.icon = icon;
        }

        @Override
        public Identifier getNoItemIcon() {
            return icon;
        }
    }

    private Container container(final String name) {
        Container c = containers.get(name);
        if (c == null) {
            throw new IllegalStateException("undeclared container '" + name + "' survived parsing");
        }
        return c;
    }

    /** Only a declared placeholder fills a slot; the player copy keeps what the player had. */
    private void fill(final String container, final int index, final Element.Placeholder ph) {
        if (ph == null) {
            return;
        }
        Item item = null;
        Identifier id = Identifier.tryParse(ph.item());
        if (id != null) {
            Optional<Item> found = BuiltInRegistries.ITEM.getOptional(id);
            item = found.orElse(null);
        }
        if (item == null) {
            McpToolkit.LOGGER.warn("[MCP Toolkit] ui placeholder '{}' is not an item; showing a barrier", ph.item());
            item = Items.BARRIER;
        }
        container(container).setItem(index, new ItemStack(item, ph.count()));
    }

    public UiDocument document() {
        return doc;
    }

    @Override
    public int bindingValue(final String name) {
        return values.getOrDefault(name, 0);
    }

    /** A preview knob for later slices (the editor, {@code ui_doc op:"preview"}): set a binding. */
    public void setBindingValue(final String name, final int value) {
        values.put(name, value);
    }

    @Override
    public ItemStack quickMoveStack(final Player player, final int slotIndex) {
        return ItemStack.EMPTY;
    }

    @Override
    public boolean stillValid(final Player player) {
        return true;
    }
}
