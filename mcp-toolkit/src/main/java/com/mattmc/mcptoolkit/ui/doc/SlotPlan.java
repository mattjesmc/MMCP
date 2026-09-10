package com.mattmc.mcptoolkit.ui.doc;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/**
 * The menu's slot list, in the order {@code addSlot} is called - derived from the document by ONE
 * function that both sides use (SCREEN_AUTHORING_DESIGN.md section 4.5).
 *
 * <p>The interpreter's {@code DetachedMenu} and the emitted {@code <Screen>MenuBase} both add their
 * slots from this plan, so a slot has the same index, container, and coordinates on both sides by
 * construction rather than by two readings of the same file agreeing. That index is what
 * {@code get_screen} reports and what section 12 compares.
 *
 * <p>The order is vanilla's: the declared containers' slots first, in document order; then the
 * player's backpack (inventory 9..35, ascending); then the hotbar (0..8, ascending) - exactly what
 * {@code AbstractContainerMenu.addStandardInventorySlots} produces, so the emitted
 * {@code quickMoveStack} can name three contiguous ranges however the document happened to list
 * its grids. A document need not place every player slot; the ranges shrink accordingly.
 *
 * @param entries      one per slot, in menu index order
 * @param containerEnd index one past the last declared-container slot ({@code [0, containerEnd)})
 * @param backpackEnd  index one past the last backpack slot ({@code [containerEnd, backpackEnd)})
 * @param hotbarEnd    index one past the last hotbar slot ({@code [backpackEnd, hotbarEnd)}); the
 *                     total slot count
 */
public record SlotPlan(List<Entry> entries, int containerEnd, int backpackEnd, int hotbarEnd) {

    /** The first inventory index of the backpack; below it is the hotbar. */
    public static final int HOTBAR_SIZE = 9;

    /**
     * One slot: which element declared it, which container and index it reads, and where it sits
     * (panel-relative, the {@code Slot(container, index, x, y)} convention).
     */
    public record Entry(String elementId, String container, int index, int x, int y) {
        public boolean isPlayer() {
            return UiDocument.PLAYER_CONTAINER.equals(container);
        }
    }

    public SlotPlan {
        entries = List.copyOf(entries);
    }

    public int size() {
        return entries.size();
    }

    /** The plan for a document: every {@code slot} and {@code slot_grid}, ordered as described above. */
    public static SlotPlan of(final UiDocument doc) {
        List<Entry> declared = new ArrayList<>();
        List<Entry> backpack = new ArrayList<>();
        List<Entry> hotbar = new ArrayList<>();
        for (Element e : doc.flatten()) {
            if (e instanceof Element.Slot s) {
                place(new Entry(s.id(), s.container(), s.index(), s.x(), s.y()), declared, backpack, hotbar);
            } else if (e instanceof Element.SlotGrid g) {
                for (int r = 0; r < g.rows(); r++) {
                    for (int c = 0; c < g.cols(); c++) {
                        int index = g.first() + r * g.cols() + c;
                        place(new Entry(g.id(), g.container(), index, g.x() + c * 18, g.y() + r * 18),
                            declared, backpack, hotbar);
                    }
                }
            }
        }
        Comparator<Entry> byIndex = Comparator.comparingInt(Entry::index);
        backpack.sort(byIndex);
        hotbar.sort(byIndex);
        List<Entry> all = new ArrayList<>(declared.size() + backpack.size() + hotbar.size());
        all.addAll(declared);
        all.addAll(backpack);
        all.addAll(hotbar);
        int containerEnd = declared.size();
        int backpackEnd = containerEnd + backpack.size();
        return new SlotPlan(all, containerEnd, backpackEnd, backpackEnd + hotbar.size());
    }

    /**
     * What the document says the slots are, against what a LIVE menu actually has
     * (SCREEN_AUTHORING_DESIGN.md section 6.1, attached mode).
     *
     * <p><b>Why this exists at all: {@code Slot.x} and {@code Slot.y} are FINAL in 26.2</b>
     * ({@code vanilla-src/net/minecraft/world/inventory/Slot.java:14-15}). An attached preview wraps
     * a menu that some mod's compiled code built, so the interpreter can draw the document's labels,
     * buttons and gauges wherever the document now says - and cannot move one slot. Dragging a slot
     * in the editor therefore edits the document correctly while the screen keeps showing the old
     * position until the mod is regenerated, rebuilt and reopened. That divergence is real; the only
     * wrong thing to do with it is leave it invisible.
     *
     * @param menuSlots the live menu's slot rectangles in menu order, {@code {x, y}} panel-relative
     */
    public static Drift compare(final SlotPlan plan, final int[][] menuSlots) {
        List<String> notes = new ArrayList<>();
        if (plan.size() != menuSlots.length) {
            notes.add("the document declares " + plan.size() + " slot(s) and the live menu has "
                + menuSlots.length + " - this menu was not built from this document, or not from this"
                + " version of it");
        }
        int compared = Math.min(plan.size(), menuSlots.length);
        int moved = 0;
        for (int i = 0; i < compared; i++) {
            Entry e = plan.entries().get(i);
            int[] live = menuSlots[i];
            if (live[0] == e.x() && live[1] == e.y()) {
                continue;
            }
            moved++;
            if (notes.size() < MAX_NOTES) {
                notes.add("slot " + i + (e.elementId() == null ? "" : " ('" + e.elementId() + "')")
                    + ": the document says " + e.x() + "," + e.y() + " and the live menu has "
                    + live[0] + "," + live[1]);
            }
        }
        if (moved > MAX_NOTES) {
            notes.add("and " + (moved - MAX_NOTES) + " more slot(s) in different places");
        }
        return new Drift(plan.size(), menuSlots.length, moved, List.copyOf(notes));
    }

    /** How far the live menu has drifted from the document. Empty notes means they agree exactly. */
    public record Drift(int documentSlots, int menuSlots, int moved, List<String> notes) {
        public boolean clean() {
            return notes.isEmpty();
        }
    }

    /** Slot notes past this many are counted rather than listed - a stale 36-slot menu says it once. */
    private static final int MAX_NOTES = 6;

    private static void place(final Entry e, final List<Entry> declared, final List<Entry> backpack, final List<Entry> hotbar) {
        if (!e.isPlayer()) {
            declared.add(e);
        } else if (e.index() >= HOTBAR_SIZE) {
            backpack.add(e);
        } else {
            hotbar.add(e);
        }
    }
}
