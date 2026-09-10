package com.mattmc.mcptoolkit.ui.doc;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

/**
 * <b>What is legal but probably wrong.</b> SCREEN_AUTHORING_DESIGN.md section 10's claim that
 * {@code check_layout} can lint a document "without the game even running", made good.
 *
 * <p><b>The line this class draws, and it is the whole design:</b> {@link UiParser} refuses what is
 * INVALID - an undeclared binding, a slot index outside its container, a duplicate id - and a
 * document that fails to parse never reaches here. This reports what parses fine and still ships a
 * broken screen: a button half off the panel, two buttons on the same pixels, a container whose
 * slots nothing places. Nothing here is a second copy of a parser rule, and nothing here can refuse
 * a document; a lint note is advice, which is why it carries a {@link Code} a caller can filter on
 * rather than a sentence a caller has to read.
 *
 * <p><b>Its blind spot is declared rather than hidden.</b> A layout node's children are arranged by
 * vanilla's {@code LayoutSettings} at {@code init()} time, so their positions do not exist until a
 * client has one open - and a plain label's WIDTH is the font's business, which is not on this
 * classpath either. Both are counted into {@link Report#unchecked()} and named, and the answer for
 * them is the live half of the same claim: open the preview and run {@code check_layout}, which
 * measures the arranged widgets with the real font. A lint that quietly skipped them would report a
 * clean document that is not one.
 *
 * <p>Imports no Minecraft (section 7.1), which is what lets {@code ui_doc op:"lint"} answer with the
 * game down and a Gradle task use it later.
 */
public final class UiLint {
    private UiLint() {}

    /** Vanilla's font line height. A constant, not a measurement - the WIDTH is what needs a font. */
    public static final int LINE_HEIGHT = 9;

    /**
     * The kinds of thing a document can get wrong while parsing cleanly.
     *
     * <p>Enumerated, not free text, for the same reason {@link Kind} is: the unit test loops
     * {@code values()} and fails by name when a code has no case that produces it, so a code cannot
     * be added without a demonstration that it fires, or removed while a caller still filters on it.
     */
    public enum Code {
        /** An element's rectangle leaves the panel: drawn clipped, or not at all. */
        OUTSIDE_PANEL,
        /** Two clickable elements share pixels: one of them cannot be clicked there. */
        OVERLAP,
        /** A declared container has slots no element places - items can enter and never come out. */
        UNREACHABLE_SLOTS,
        /** Some of the player's 36 slots are placed and some are not. */
        PARTIAL_PLAYER_INVENTORY,
        /** A container is declared and nothing places any of it. */
        UNUSED_CONTAINER,
        /** An action is declared and no button fires it: a generated hook nothing calls. */
        UNUSED_ACTION,
        /**
         * A parameterised action has ids no button presses - the id arithmetic reaches further than
         * the screen does. Harmless on its own; a symptom of an arity typed one too large, which is
         * the shape section 4.2 exists to make visible.
         */
        PARTIAL_ACTION_ARITY,
        /** A binding is declared and nothing reads it: a synced int nothing shows. */
        UNUSED_BINDING,
        /** A layout node with no children arranges to 0x0: invisible, and it cannot be selected. */
        EMPTY_LAYOUT,
        /** The title or the inventory label runs off the panel. */
        LABEL_OFF_PANEL
    }

    /**
     * One note.
     *
     * @param code    what kind of wrong
     * @param path    the parser's own path ({@code elements[3].children[1]}), or a screen-level key,
     *                or {@code ""} for the document
     * @param message the sentence, naming the numbers that make it true
     */
    public record Note(Code code, String path, String message) {
        @Override
        public String toString() {
            return path.isEmpty() ? code.name().toLowerCase(java.util.Locale.ROOT) + ": " + message
                : code.name().toLowerCase(java.util.Locale.ROOT) + " at " + path + ": " + message;
        }
    }

    /**
     * The notes, and what could not be looked at.
     *
     * @param notes     every note, in document order within each check
     * @param unchecked how many elements have no statically known rectangle
     * @param why       one sentence naming why, and where the answer is; empty when nothing was skipped
     */
    public record Report(List<Note> notes, int unchecked, String why) {
        public Report {
            notes = List.copyOf(notes);
        }

        public boolean clean() {
            return notes.isEmpty();
        }
    }

    // ---------------------------------------------------------------------------------------------

    public static Report check(final UiDocument doc) {
        List<Note> notes = new ArrayList<>();
        // walkAll, not walk: a part's contents are drawn, so a part that puts a button off the panel
        // is exactly as broken as one written inline, and a lint that stopped at the instance would
        // report a clean document that is not one.
        List<UiEdit.Placed> all = UiEdit.walkAll(doc);

        Set<String> reasons = new TreeSet<>();
        List<Rect> rects = new ArrayList<>();
        int unchecked = 0;
        for (UiEdit.Placed p : all) {
            Rect r = rect(p);
            if (r == null) {
                unchecked++;
                reasons.add(reason(p));
                continue;
            }
            rects.add(r);
        }

        panel(doc, rects, notes);
        overlaps(rects, notes);
        containers(doc, notes);
        declarations(doc, notes);
        layouts(all, notes);
        screenLabels(doc, notes);

        String why = reasons.isEmpty() ? ""
            : String.join("; ", reasons) + " - open the document as a preview and run check_layout,"
                + " which measures the arranged widgets with the real font";
        return new Report(notes, unchecked, why);
    }

    // ---------------------------------------------------------------------------------------------
    // Geometry

    /** An element whose rectangle is known before any client arranges anything. */
    private record Rect(String path, Element element, int x, int y, int w, int h) {
        boolean clickable() {
            return element.kind() == Kind.BUTTON || element.kind().isSlot();
        }

        boolean intersects(final Rect o) {
            return x < o.x + o.w && o.x < x + w && y < o.y + o.h && o.y < y + h;
        }

        String name() {
            return element.kind().jsonName() + (element.id() == null ? "" : " '" + element.id() + "'");
        }
    }

    /**
     * The rectangle, or {@code null} when it is not statically knowable.
     *
     * <p>Two ways it is not: an element inside a layout node has no position until vanilla arranges
     * it, and a layout node itself has no size until its children are measured. A plain label is the
     * third and subtler one - its height is {@link #LINE_HEIGHT}, a constant, but its natural width
     * is the font's, so a label that declared no {@code w} is unchecked too.
     */
    private static Rect rect(final UiEdit.Placed p) {
        Element e = p.element();
        if (!(e.placement() instanceof Element.Placement.Absolute a)) {
            return null;
        }
        if (e.kind().isLayout() || e.kind().isMacro()) {
            return null;
        }
        int w = e.w();
        int h = e.h();
        if (e instanceof Element.Label) {
            if (w <= 0) {
                return null;
            }
            if (h <= 0) {
                h = LINE_HEIGHT;
            }
        }
        if (w <= 0 || h <= 0) {
            return null;
        }
        return new Rect(p.path().format(), e, a.x(), a.y(), w, h);
    }

    private static String reason(final UiEdit.Placed p) {
        Element e = p.element();
        if (e.kind().isMacro()) {
            return "a " + e.kind().jsonName() + " is an origin, not a rectangle (what it expands to IS checked)";
        }
        if (e.kind().isLayout()) {
            return "a layout node's size is its arranged children's";
        }
        if (!(e.placement() instanceof Element.Placement.Absolute)) {
            return "a layout node's children are placed at init() time";
        }
        return "a label with no declared width is as wide as the font makes it";
    }

    private static void panel(final UiDocument doc, final List<Rect> rects, final List<Note> notes) {
        for (Rect r : rects) {
            if (r.x >= 0 && r.y >= 0 && r.x + r.w <= doc.width() && r.y + r.h <= doc.height()) {
                continue;
            }
            notes.add(new Note(Code.OUTSIDE_PANEL, r.path, r.name() + " covers " + r.x + "," + r.y
                + " to " + (r.x + r.w) + "," + (r.y + r.h) + ", which leaves the "
                + doc.width() + "x" + doc.height() + " panel"));
        }
    }

    /**
     * Clickable on clickable only. A button over a {@code panel} is how every screen is drawn and
     * flagging it would make the whole check noise; two buttons on the same pixels is one button the
     * player can never press, and a button over a slot is a slot the player can never take from.
     */
    private static void overlaps(final List<Rect> rects, final List<Note> notes) {
        for (int i = 0; i < rects.size(); i++) {
            Rect a = rects.get(i);
            if (!a.clickable()) {
                continue;
            }
            for (int j = i + 1; j < rects.size(); j++) {
                Rect b = rects.get(j);
                if (!b.clickable() || !a.intersects(b)) {
                    continue;
                }
                notes.add(new Note(Code.OVERLAP, a.path, a.name() + " and " + b.name() + " (" + b.path
                    + ") share pixels; only one of them can take a click there"));
            }
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Declarations

    /**
     * Slots that exist in the menu and nowhere on the screen.
     *
     * <p>The nastiest thing on this list, and it is invisible in every other instrument: the menu is
     * built over the container's full size, so vanilla's shift-click can move a stack into an index
     * no element draws, and the player watches the item disappear. It is legal - a document may
     * deliberately place a subset - so it is a note and not a refusal.
     */
    private static void containers(final UiDocument doc, final List<Note> notes) {
        for (UiDocument.Container c : doc.containers()) {
            Set<Integer> placed = placedIndices(doc, c.name());
            if (placed.isEmpty()) {
                notes.add(new Note(Code.UNUSED_CONTAINER, "containers",
                    "container '" + c.name() + "' declares " + c.size()
                        + " slot(s) and no element places any of them"));
                continue;
            }
            List<Integer> missing = missing(placed, c.size());
            if (!missing.isEmpty()) {
                notes.add(new Note(Code.UNREACHABLE_SLOTS, "containers",
                    "container '" + c.name() + "' has " + c.size() + " slot(s) but " + describe(missing)
                        + " are not placed; a shift-click can put an item where nothing draws it"));
            }
        }
        Set<Integer> player = placedIndices(doc, UiDocument.PLAYER_CONTAINER);
        if (!player.isEmpty() && player.size() < UiDocument.PLAYER_SLOTS) {
            notes.add(new Note(Code.PARTIAL_PLAYER_INVENTORY, "elements",
                "the player's inventory is partly placed: " + player.size() + " of "
                    + UiDocument.PLAYER_SLOTS + " slots, missing "
                    + describe(missing(player, UiDocument.PLAYER_SLOTS))));
        }
    }

    private static Set<Integer> placedIndices(final UiDocument doc, final String container) {
        Set<Integer> used = new LinkedHashSet<>();
        for (Element e : doc.flatten()) {
            if (e instanceof Element.Slot s && s.container().equals(container)) {
                used.add(s.index());
            } else if (e instanceof Element.SlotGrid g && g.container().equals(container)) {
                for (int i = 0; i < g.count(); i++) {
                    used.add(g.first() + i);
                }
            }
        }
        return used;
    }

    private static List<Integer> missing(final Set<Integer> placed, final int size) {
        List<Integer> out = new ArrayList<>();
        for (int i = 0; i < size; i++) {
            if (!placed.contains(i)) {
                out.add(i);
            }
        }
        return out;
    }

    /** {@code 3..7} rather than a list of forty numbers; the ranges are what a human acts on. */
    private static String describe(final List<Integer> indices) {
        StringBuilder sb = new StringBuilder();
        int i = 0;
        while (i < indices.size()) {
            int start = indices.get(i);
            int end = start;
            while (i + 1 < indices.size() && indices.get(i + 1) == end + 1) {
                end = indices.get(++i);
            }
            if (sb.length() > 0) {
                sb.append(", ");
            }
            sb.append(start == end ? String.valueOf(start) : start + ".." + end);
            i++;
        }
        return sb.toString();
    }

    /**
     * Declared and unreferenced. Both matter to the EMITTER rather than to the screen: an unused
     * action generates an {@code onAction_<name>} hook nothing ever calls, and an unused binding
     * generates a {@code ContainerData} slot nothing shows - dead weight that reads as a wiring bug
     * to whoever opens the generated file.
     */
    private static void declarations(final UiDocument doc, final List<Note> notes) {
        Set<String> actions = new HashSet<>();
        Set<String> bindings = new HashSet<>();
        Map<String, Set<Integer>> pressed = new java.util.HashMap<>();
        for (Element e : doc.flatten()) {
            if (e instanceof Element.Button b) {
                actions.add(b.action());
                UiDocument.Action declared = doc.action(b.action());
                if (declared != null && declared.parameterised() && b.args().size() == declared.args().size()) {
                    pressed.computeIfAbsent(b.action(), k -> new HashSet<>()).add(declared.offset(b.args()));
                }
            } else if (e instanceof Element.Bar bar) {
                bindings.add(bar.binding());
            }
            // A predicate READS a binding: a button whose `enabled` follows can_apply is the whole
            // reason can_apply is synced, and calling it unused would be the note that trains people
            // to ignore notes.
            Element.Decoration deco = e.deco();
            if (deco.visible() != null) {
                bindings.add(deco.visible().binding());
            }
            if (deco.enabled() != null) {
                bindings.add(deco.enabled().binding());
            }
        }
        // A binding named as another binding's max IS read, by the bar over that other binding.
        for (UiDocument.Binding b : doc.bindings()) {
            if (b.maxBinding() != null && bindings.contains(b.name())) {
                bindings.add(b.maxBinding());
            }
        }
        for (UiDocument.Action a : doc.actions()) {
            if (!actions.contains(a.name())) {
                notes.add(new Note(Code.UNUSED_ACTION, "actions",
                    "action '" + a.name() + "' is declared and no button fires it"));
                continue;
            }
            if (!a.parameterised()) {
                continue;
            }
            int used = pressed.getOrDefault(a.name(), Set.of()).size();
            if (used < a.count()) {
                notes.add(new Note(Code.PARTIAL_ACTION_ARITY, "actions",
                    "action '" + a.name() + "' declares " + a.sizes() + " = " + a.count()
                        + " id(s) and buttons press " + used + " of them; the rest are hooks nothing calls"));
            }
        }
        for (UiDocument.Binding b : doc.bindings()) {
            if (!bindings.contains(b.name())) {
                notes.add(new Note(Code.UNUSED_BINDING, "bindings",
                    "binding '" + b.name() + "' is declared and nothing reads it"));
            }
        }
    }

    private static void layouts(final List<UiEdit.Placed> all, final List<Note> notes) {
        for (UiEdit.Placed p : all) {
            if (p.element() instanceof Element.Layout l && l.children().isEmpty()) {
                notes.add(new Note(Code.EMPTY_LAYOUT, p.path().format(),
                    "an empty " + l.kind().jsonName() + " arranges to 0x0: nothing is drawn and nothing"
                        + " can be selected"));
            }
        }
    }

    private static void screenLabels(final UiDocument doc, final List<Note> notes) {
        if (doc.titleX() < 0 || doc.titleY() < 0 || doc.titleY() + LINE_HEIGHT > doc.height()) {
            notes.add(new Note(Code.LABEL_OFF_PANEL, "title_pos",
                "the title sits at " + doc.titleX() + "," + doc.titleY() + " on a " + doc.width() + "x"
                    + doc.height() + " panel"));
        }
        UiDocument.InventoryLabel inv = doc.inventoryLabel();
        if (inv.shown() && (inv.x() < 0 || inv.y() < 0 || inv.y() + LINE_HEIGHT > doc.height())) {
            notes.add(new Note(Code.LABEL_OFF_PANEL, "inventory_label",
                "the inventory label sits at " + inv.x() + "," + inv.y() + " on a " + doc.width() + "x"
                    + doc.height() + " panel (set inventory_label to false when the screen has no"
                    + " player inventory)"));
        }
    }

    /** Every code, for a caller that wants to say what it filters on. */
    public static List<String> codes() {
        List<String> out = new ArrayList<>();
        for (Code c : Code.values()) {
            out.add(c.name().toLowerCase(java.util.Locale.ROOT));
        }
        return Collections.unmodifiableList(out);
    }
}
