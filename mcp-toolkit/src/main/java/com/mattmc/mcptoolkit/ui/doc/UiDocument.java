package com.mattmc.mcptoolkit.ui.doc;

import java.util.ArrayList;
import java.util.Collections;
import java.util.EnumSet;
import java.util.List;
import java.util.Set;

/**
 * One screen, as {@code assets/<mod>/ui/<screen>.ui.json} states it (SCREEN_AUTHORING_DESIGN.md
 * section 4). Parsed once by {@link UiParser}; rendered by the interpreter and printed by the emitter
 * from this same object, which is what makes section 12's conformance check a comparison of two
 * renderings of ONE reading rather than of two readings.
 *
 * <p>Imports nothing from Minecraft (section 7.1): the emitter has to run from a Gradle task with
 * no game on the classpath, and a Minecraft-coupled model would mean a second emitter.
 *
 * @param title          the screen title
 * @param width          {@code imageWidth}
 * @param height         {@code imageHeight}
 * @param titleX         title label position, panel-relative (vanilla default 8)
 * @param titleY         (vanilla default 6)
 * @param inventoryLabel the "Inventory" label: shown or not, and where
 * @param background     a texture id blitted at the panel origin, or {@code null} for the textureless
 *                       frame (section 4.1 leaves the art question open; this is the seam)
 * @param containers     the menu's containers by name and size; {@code player} is implicit
 * @param sheet          a background PNG the emitter writes from this document's own boxes, or
 *                       {@code null} (UI_PARTS_LIBRARY_DESIGN.md section 3.6 - the third copy of the
 *                       layout numbers, deleted)
 * @param actions        declared actions, in id order (section 8.1); a parameterised one takes a
 *                       BLOCK of ids (UI_PARTS_LIBRARY_DESIGN.md section 4.2)
 * @param bindings       declared bindings (section 8.2)
 * @param elements       the top-level elements in paint order
 */
public record UiDocument(Text title, int width, int height, int titleX, int titleY,
                         InventoryLabel inventoryLabel, String background, Sheet sheet,
                         List<Container> containers, List<Action> actions, List<Binding> bindings,
                         List<Element> elements) {

    /** The {@code "format"} value this model reads and writes. */
    public static final int FORMAT = 1;

    /** The reserved container name for the player's inventory: hotbar 0-8, main 9-35. */
    public static final String PLAYER_CONTAINER = "player";
    /** How many of the player's inventory slots a container screen may place. */
    public static final int PLAYER_SLOTS = 36;

    public static final int DEFAULT_TITLE_X = 8;
    public static final int DEFAULT_TITLE_Y = 6;
    public static final int DEFAULT_INVENTORY_LABEL_X = 8;

    /** Vanilla's {@code inventoryLabelY = imageHeight - 94}. */
    public static int defaultInventoryLabelY(final int height) {
        return height - 94;
    }

    public UiDocument {
        containers = List.copyOf(containers);
        actions = List.copyOf(actions);
        bindings = List.copyOf(bindings);
        elements = List.copyOf(elements);
    }

    /** The "Inventory" label: vanilla always draws it; a document may move it or hide it. */
    public record InventoryLabel(boolean shown, int x, int y) {
        public static InventoryLabel defaultFor(final int height) {
            return new InventoryLabel(true, DEFAULT_INVENTORY_LABEL_X, defaultInventoryLabelY(height));
        }

        public static final InventoryLabel HIDDEN = new InventoryLabel(false, 0, 0);
    }

    /** A named container the menu is built over. */
    public record Container(String name, int size) {}

    /**
     * A PNG the emitter draws from this document's own decorative elements
     * (UI_PARTS_LIBRARY_DESIGN.md section 3.6).
     *
     * <p>The finding it answers, found in the wild: a mod that generates its background sheet from
     * the layout constants has those numbers THREE times - in the menu, in the screen, and in the
     * generator script - and nothing checks that the three agree. Here the document is the one
     * place, and the sheet falls out of the same parse as the two Java files.
     *
     * @param texture the texture id to write, e.g. {@code mymod:textures/gui/station.png}
     * @param width   the image's width in pixels; defaults to the document's
     * @param height  the image's height
     */
    public record Sheet(String texture, int width, int height) {}

    /**
     * A declared action, and the arity its id block covers (UI_PARTS_LIBRARY_DESIGN.md section 4.2).
     *
     * <p>{@code ["apply", {"name": "select", "args": [4]}]} declares five ids: {@code apply} is one,
     * {@code select} is four. A button naming {@code select} supplies one index, the emitter writes
     * the packing and the matching unpacking, and <b>the stride exists once</b> - which is the whole
     * point, because a screen that packs {@code row * 3 + slot} and a menu that unpacks
     * {@code id / 3} are two copies of one number and nothing checks that they agree.
     *
     * @param args the arguments, outermost first; empty for a plain action
     */
    public record Action(String name, List<Arg> args) {
        public Action {
            args = List.copyOf(args);
        }

        public static Action of(final String name) {
            return new Action(name, List.of());
        }

        public boolean parameterised() {
            return !args.isEmpty();
        }

        /** How many ids this action takes: the product of its argument sizes, or 1. */
        public int count() {
            int n = 1;
            for (Arg a : args) {
                n *= a.size();
            }
            return n;
        }

        /** {@code row * MAX + slot}: the row-major offset of one argument tuple within the block. */
        public int offset(final List<Integer> values) {
            int off = 0;
            for (int i = 0; i < args.size(); i++) {
                off = off * args.get(i).size() + values.get(i);
            }
            return off;
        }

        /** The declared sizes, for a message that shows the shape rather than the names. */
        public List<Integer> sizes() {
            List<Integer> out = new java.util.ArrayList<>(args.size());
            for (Arg a : args) {
                out.add(a.size());
            }
            return out;
        }
    }

    /**
     * One argument of a parameterised action: how many values it takes, and what to call it.
     *
     * <p>The name is what the generated hook's parameter is called
     * ({@code onSelectFitting(Player, int row, int slot)}), which is the difference between a
     * subclass that reads and one that is a puzzle. {@code [5, 3]} spells the sizes with the default
     * names; {@code [{"name": "row", "size": 5}, {"name": "slot", "size": 3}]} names them.
     */
    public record Arg(String name, int size) {
        /** What an unnamed argument is called: positional, so it is stable rather than guessed. */
        public static String defaultName(final int index) {
            return "arg" + index;
        }
    }

    /**
     * A synced integer (section 8.2). {@code max} is a literal or {@code maxBinding} names another
     * binding; a bar over this binding fills by {@code value / max}. {@code wide} asks the emitter for
     * the two-slot split, because ContainerData is 16-bit on the wire. {@code preview} is what the
     * detached preview shows.
     */
    public record Binding(String name, boolean wide, int preview, Integer max, String maxBinding) {
        public boolean hasMax() {
            return max != null || maxBinding != null;
        }
    }

    // ---------------------------------------------------------------------------------------------

    /** Every element depth-first, a layout node before its children. */
    public List<Element> flatten() {
        List<Element> out = new ArrayList<>();
        collect(elements, out);
        return Collections.unmodifiableList(out);
    }

    private static void collect(final List<Element> in, final List<Element> out) {
        for (Element e : in) {
            out.add(e);
            collect(e.children(), out);
        }
    }

    /** The element with this id, or {@code null}. */
    public Element byId(final String id) {
        for (Element e : flatten()) {
            if (id.equals(e.id())) {
                return e;
            }
        }
        return null;
    }

    /** The kinds this document uses - what a "renders every kind" check compares against the registry. */
    public Set<Kind> kindsUsed() {
        Set<Kind> out = EnumSet.noneOf(Kind.class);
        for (Element e : flatten()) {
            out.add(e.kind());
        }
        return out;
    }

    /** The size of a named container; the reserved {@code player} answers 36. {@code -1} if undeclared. */
    public int containerSize(final String name) {
        if (PLAYER_CONTAINER.equals(name)) {
            return PLAYER_SLOTS;
        }
        for (Container c : containers) {
            if (c.name().equals(name)) {
                return c.size();
            }
        }
        return -1;
    }

    public Binding binding(final String name) {
        for (Binding b : bindings) {
            if (b.name().equals(name)) {
                return b;
            }
        }
        return null;
    }

    /** The declared action, or {@code null}. */
    public Action action(final String name) {
        for (Action a : actions) {
            if (a.name().equals(name)) {
                return a;
            }
        }
        return null;
    }

    /**
     * The FIRST id of a declared action's block, or {@code -1}.
     *
     * <p>Not the index in {@link #actions()} any more: a parameterised action takes {@code count()}
     * consecutive ids, so the base is the sum of every earlier action's count.
     */
    public int actionId(final String name) {
        int base = 0;
        for (Action a : actions) {
            if (a.name().equals(name)) {
                return base;
            }
            base += a.count();
        }
        return -1;
    }

    /** The id a button with these argument values presses. {@code -1} for an undeclared action. */
    public int actionId(final String name, final List<Integer> values) {
        Action a = action(name);
        int base = actionId(name);
        return a == null || base < 0 ? -1 : base + a.offset(values);
    }

    /** How many ids the whole action block covers - what a dispatch switch has to cover. */
    public int actionIdCount() {
        int n = 0;
        for (Action a : actions) {
            n += a.count();
        }
        return n;
    }
}
