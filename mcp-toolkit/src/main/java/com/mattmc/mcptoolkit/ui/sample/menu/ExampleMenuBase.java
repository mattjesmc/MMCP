package com.mattmc.mcptoolkit.ui.sample.menu;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

import net.minecraft.network.chat.Component;
import net.minecraft.resources.Identifier;
import net.minecraft.world.Container;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.inventory.ContainerData;
import net.minecraft.world.inventory.MenuType;
import net.minecraft.world.inventory.Slot;
import net.minecraft.world.item.ItemStack;

/**
 * GENERATED from assets/mcptoolkit/ui/example.ui.json by the mcp-toolkit screen compiler - DO NOT EDIT.
 * Regenerated on every save of the document; hand edits are lost. Behaviour goes in the
 * subclass (SCREEN_AUTHORING_DESIGN.md section 7).
 *
 * The menu's machine half: the slot list (section 4.5, one declaration, both sides), the synced ints (section 8.2), the action dispatch (section 8.1) and vanilla's shift-click.
 *
 * Parts used (UI_PARTS_LIBRARY_DESIGN.md section 5):
 *   mcptoolkit:entity_preview #afb28f8b as preview
 *   mcptoolkit:player_inventory #b29b2ea2 as inv
 *   mcptoolkit:station_inputs #d4e01fce as inputs
 */
public abstract class ExampleMenuBase extends AbstractContainerMenu {
    /** The document's title: what a MenuProvider's getDisplayName answers. */
    public static final Component TITLE = Component.literal("UI example");

    // The declared containers' sizes, in document order.
    public static final int INPUT_SIZE = 4;

    // Slot ranges: the declared containers' slots first, then the player's backpack, then the
    // hotbar - vanilla's order, whatever order the document listed them in (SlotPlan).
    public static final int CONTAINER_SLOTS_END = 4;
    public static final int BACKPACK_SLOTS_END = 31;
    public static final int HOTBAR_SLOTS_END = 40;

    // Actions (section 8.1): an action's id on vanilla's button channel. A PARAMETERISED
    // action takes a block of ids from its base, row-major over its arguments
    // (UI_PARTS_LIBRARY_DESIGN.md section 4.2) - the stride lives here and nowhere else.
    public static final int ACTION_LAUNCH = 0;
    public static final int ACTION_CANCEL = 1;
    public static final int ACTION_SELECT = 2;
    public static final int ACTION_SELECT_INDEX_SIZE = 3;
    public static final int ACTION_SELECT_COUNT = 3;

    // Data slots (section 8.2). ContainerData is 16-bit on the wire, so a `wide` binding takes
    // two: the high half, then the low half.
    private static final int DATA_PROGRESS = 0;
    private static final int DATA_FUEL = 1;
    private static final int DATA_FUEL_LOW = 2;
    private static final int DATA_FUEL_MAX = 3;
    private static final int DATA_FUEL_MAX_LOW = 4;
    private static final int DATA_COUNT = 5;

    private final boolean serverSide;
    private final int[] synced = new int[DATA_COUNT];

    protected ExampleMenuBase(final MenuType<?> type, final int containerId, final Inventory playerInventory, final Container inputContainer) {
        super(type, containerId);
        checkContainerSize(inputContainer, INPUT_SIZE);
        this.serverSide = !playerInventory.player.level().isClientSide();
        // The slots, in menu order, at the document's coordinates. The screen paints its wells
        // from this same list, so the two sides cannot disagree.
        this.addSlot(this.createSlot("fuel_slot", inputContainer, 0, 14, 36));
        this.addSlot(this.createSlot("output_slot", inputContainer, 1, 110, 36));
        this.addSlot(this.createSlot("inputs.template", inputContainer, 2, 216, 18));
        this.addSlot(this.createSlot("inputs.material", inputContainer, 3, 234, 18));
        this.addSlot(this.createSlot("inv.backpack", playerInventory, 9, 8, 139));
        this.addSlot(this.createSlot("inv.backpack", playerInventory, 10, 26, 139));
        this.addSlot(this.createSlot("inv.backpack", playerInventory, 11, 44, 139));
        this.addSlot(this.createSlot("inv.backpack", playerInventory, 12, 62, 139));
        this.addSlot(this.createSlot("inv.backpack", playerInventory, 13, 80, 139));
        this.addSlot(this.createSlot("inv.backpack", playerInventory, 14, 98, 139));
        this.addSlot(this.createSlot("inv.backpack", playerInventory, 15, 116, 139));
        this.addSlot(this.createSlot("inv.backpack", playerInventory, 16, 134, 139));
        this.addSlot(this.createSlot("inv.backpack", playerInventory, 17, 152, 139));
        this.addSlot(this.createSlot("inv.backpack", playerInventory, 18, 8, 157));
        this.addSlot(this.createSlot("inv.backpack", playerInventory, 19, 26, 157));
        this.addSlot(this.createSlot("inv.backpack", playerInventory, 20, 44, 157));
        this.addSlot(this.createSlot("inv.backpack", playerInventory, 21, 62, 157));
        this.addSlot(this.createSlot("inv.backpack", playerInventory, 22, 80, 157));
        this.addSlot(this.createSlot("inv.backpack", playerInventory, 23, 98, 157));
        this.addSlot(this.createSlot("inv.backpack", playerInventory, 24, 116, 157));
        this.addSlot(this.createSlot("inv.backpack", playerInventory, 25, 134, 157));
        this.addSlot(this.createSlot("inv.backpack", playerInventory, 26, 152, 157));
        this.addSlot(this.createSlot("inv.backpack", playerInventory, 27, 8, 175));
        this.addSlot(this.createSlot("inv.backpack", playerInventory, 28, 26, 175));
        this.addSlot(this.createSlot("inv.backpack", playerInventory, 29, 44, 175));
        this.addSlot(this.createSlot("inv.backpack", playerInventory, 30, 62, 175));
        this.addSlot(this.createSlot("inv.backpack", playerInventory, 31, 80, 175));
        this.addSlot(this.createSlot("inv.backpack", playerInventory, 32, 98, 175));
        this.addSlot(this.createSlot("inv.backpack", playerInventory, 33, 116, 175));
        this.addSlot(this.createSlot("inv.backpack", playerInventory, 34, 134, 175));
        this.addSlot(this.createSlot("inv.backpack", playerInventory, 35, 152, 175));
        this.addSlot(this.createSlot("inv.hotbar", playerInventory, 0, 8, 197));
        this.addSlot(this.createSlot("inv.hotbar", playerInventory, 1, 26, 197));
        this.addSlot(this.createSlot("inv.hotbar", playerInventory, 2, 44, 197));
        this.addSlot(this.createSlot("inv.hotbar", playerInventory, 3, 62, 197));
        this.addSlot(this.createSlot("inv.hotbar", playerInventory, 4, 80, 197));
        this.addSlot(this.createSlot("inv.hotbar", playerInventory, 5, 98, 197));
        this.addSlot(this.createSlot("inv.hotbar", playerInventory, 6, 116, 197));
        this.addSlot(this.createSlot("inv.hotbar", playerInventory, 7, 134, 197));
        this.addSlot(this.createSlot("inv.hotbar", playerInventory, 8, 152, 197));
        this.addDataSlots(this.syncedData());
    }

    /**
     * Every slot passes through here. Override to filter one ({@code mayPlace}) or cap its stack
     * size, switching on {@code element} (the document id of the slot or slot grid it came from).
     * The GEOMETRY is the document's: return a slot at this x and y.
     */
    protected Slot createSlot(final String element, final Container container, final int index, final int x, final int y) {
        Identifier icon = EMPTY_SLOT_ICONS.get(element);
        return icon == null ? new Slot(container, index, x, y) : new IconSlot(container, index, x, y, icon);
    }

    /**
     * The empty-slot sprite each named slot wears, from the document's {@code icon} property.
     * Vanilla draws {@code Slot.getNoItemIcon()} for an empty active slot itself, so this is a
     * property of the MENU's slot rather than anything either renderer paints.
     */
    private static final Map<String, Identifier> EMPTY_SLOT_ICONS = emptySlotIcons();

    private static Map<String, Identifier> emptySlotIcons() {
        Map<String, Identifier> m = new LinkedHashMap<>();
        m.put("output_slot", Identifier.parse("minecraft:container/slot/smithing_template_armor_trim"));
        m.put("inputs.template", Identifier.parse("minecraft:container/slot/smithing_template_netherite_upgrade"));
        return Collections.unmodifiableMap(m);
    }

    /**
     * A slot that shows a sprite while it is empty.
     */
    public static class IconSlot extends Slot {
        private final Identifier icon;

        public IconSlot(final Container container, final int index, final int x, final int y, final Identifier icon) {
            super(container, index, x, y);
            this.icon = icon;
        }

        @Override
        public Identifier getNoItemIcon() {
            return this.icon;
        }
    }

    // ---- bindings (section 8.2) ----------------------------------------------------------------

    /**
     * What supplies {@code progress} on the server. Never called on the client, where the
     * value is whatever the server last synced.
     */
    protected abstract int supplyProgress();

    /**
     * The current {@code progress}: live on the server, synced on the client.
     */
    public final int progress() {
        return this.serverSide ? this.supplyProgress() : this.synced[DATA_PROGRESS];
    }

    /**
     * What supplies {@code fuel} on the server. Never called on the client, where the
     * value is whatever the server last synced.
     */
    protected abstract int supplyFuel();

    /**
     * The current {@code fuel}: live on the server, synced on the client. Wide: reassembled from two 16-bit halves.
     */
    public final int fuel() {
        return this.serverSide ? this.supplyFuel() : (this.synced[DATA_FUEL] << 16) | (this.synced[DATA_FUEL_LOW] & 0xFFFF);
    }

    /**
     * What supplies {@code fuel_max} on the server. Never called on the client, where the
     * value is whatever the server last synced.
     */
    protected abstract int supplyFuelMax();

    /**
     * The current {@code fuel_max}: live on the server, synced on the client. Wide: reassembled from two 16-bit halves.
     */
    public final int fuelMax() {
        return this.serverSide ? this.supplyFuelMax() : (this.synced[DATA_FUEL_MAX] << 16) | (this.synced[DATA_FUEL_MAX_LOW] & 0xFFFF);
    }

    /**
     * A binding by its document name - the dev-time interpreter reads a live menu through this
     * (section 15.8); {@code 0} for a name the document does not declare.
     */
    public int bindingValue(final String name) {
        return switch (name) {
            case "progress" -> this.progress();
            case "fuel" -> this.fuel();
            case "fuel_max" -> this.fuelMax();
            default -> 0;
        };
    }

    /**
     * One ContainerData over the suppliers; vanilla's {@code broadcastChanges} diffs and syncs it.
     */
    private ContainerData syncedData() {
        return new ContainerData() {
            @Override
            public int get(final int id) {
                return ExampleMenuBase.this.serverSide ? ExampleMenuBase.this.live(id) : ExampleMenuBase.this.synced[id];
            }

            @Override
            public void set(final int id, final int value) {
                ExampleMenuBase.this.synced[id] = value;
            }

            @Override
            public int getCount() {
                return DATA_COUNT;
            }
        };
    }

    private int live(final int id) {
        return switch (id) {
            case DATA_PROGRESS -> this.supplyProgress();
            case DATA_FUEL -> this.supplyFuel() >> 16;
            case DATA_FUEL_LOW -> this.supplyFuel() & 0xFFFF;
            case DATA_FUEL_MAX -> this.supplyFuelMax() >> 16;
            case DATA_FUEL_MAX_LOW -> this.supplyFuelMax() & 0xFFFF;
            default -> 0;
        };
    }

    // ---- actions (section 8.1) -----------------------------------------------------------------

    /**
     * What {@code launch} does. Runs on the server when a client pressed the button;
     * return true if something happened.
     */
    protected abstract boolean onLaunch(Player player);

    /**
     * What {@code cancel} does. Runs on the server when a client pressed the button;
     * return true if something happened.
     */
    protected abstract boolean onCancel(Player player);

    /**
     * What {@code select} does. Runs on the server when a client pressed the button;
     * return true if something happened.
     *
     * The arguments are decoded from the button id and BOUNDS-CHECKED before you see them ({@code index} is 0..2),
     * so the packing in the screen and the unpacking here cannot disagree (section 4.2).
     */
    protected abstract boolean onSelect(Player player, int index);

    @Override
    public boolean clickMenuButton(final Player player, final int id) {
        if (id == ACTION_LAUNCH) {
            return this.onLaunch(player);
        }
        if (id == ACTION_CANCEL) {
            return this.onCancel(player);
        }
        if (id >= ACTION_SELECT && id < ACTION_SELECT + ACTION_SELECT_COUNT) {
            int off = id - ACTION_SELECT;
            int index = off;
            return this.onSelect(player, index);
        }
        return false;
    }

    // ---- shift-click: vanilla's AbstractFurnaceMenu algorithm over the document's ranges ----------

    /**
     * The declared containers' attempt to absorb a stack arriving from the player. Override when
     * the insert is filtered (fuel goes to the fuel slot and only fuel does) rather than a plain
     * range insert. Return true if the stack was fully or partly taken.
     */
    protected boolean quickMoveIntoContainers(final ItemStack stack) {
        return this.moveItemStackTo(stack, 0, CONTAINER_SLOTS_END, false);
    }

    @Override
    public ItemStack quickMoveStack(final Player player, final int slotIndex) {
        Slot slot = this.slots.get(slotIndex);
        if (!slot.hasItem()) {
            return ItemStack.EMPTY;
        }
        ItemStack stack = slot.getItem();
        ItemStack clicked = stack.copy();
        if (slotIndex < CONTAINER_SLOTS_END) {
            // Leaving a container: into the player's inventory, hotbar first.
            if (!this.moveItemStackTo(stack, CONTAINER_SLOTS_END, HOTBAR_SLOTS_END, true)) {
                return ItemStack.EMPTY;
            }
        }
        else if (!this.quickMoveIntoContainers(stack)) {
            // Refused by the containers: hop backpack to hotbar or hotbar to backpack.
            if (slotIndex < BACKPACK_SLOTS_END) {
                if (!this.moveItemStackTo(stack, BACKPACK_SLOTS_END, HOTBAR_SLOTS_END, false)) {
                    return ItemStack.EMPTY;
                }
            }
            else if (!this.moveItemStackTo(stack, CONTAINER_SLOTS_END, BACKPACK_SLOTS_END, false)) {
                return ItemStack.EMPTY;
            }
        }
        if (stack.isEmpty()) {
            slot.setByPlayer(ItemStack.EMPTY);
        }
        else {
            slot.setChanged();
        }
        // A move that reported success without moving anything is not a move.
        if (stack.getCount() == clicked.getCount()) {
            return ItemStack.EMPTY;
        }
        slot.onTake(player, stack);
        return clicked;
    }
}
