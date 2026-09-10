package com.mattmc.mcptoolkit.ui.doc;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;

import java.util.List;
import java.util.Map;

/**
 * One element of a document, as a closed family of records - one per registered {@link Kind} family.
 *
 * <p>This is the shared model of SCREEN_AUTHORING_DESIGN.md section 5: the interpreter renders it
 * and the emitter (slice 2) prints Java from it, both from the same parse. It imports nothing from
 * Minecraft (section 7.1), which is why the vanilla-named kinds ({@code slot}, {@code button}) are
 * nested here as {@code Element.Slot} / {@code Element.Button} rather than clashing with the classes
 * the interpreter builds from them.
 *
 * <p>Coordinates are panel-relative, the same space as {@code Slot.x}/{@code Slot.y}: {@code (0,0)}
 * is the screen's top-left corner ({@code leftPos}, {@code topPos}), not the window's.
 */
public sealed interface Element {
    Kind kind();

    /** The declared id, or {@code null}. Unique within a document when present. */
    String id();

    /** Where it sits: absolute at the top level, a cell inside a layout node. */
    Placement placement();

    /** Declared width; {@code 0} means "natural" for kinds that can size themselves (labels). */
    default int w() {
        return 0;
    }

    /** Declared height; {@code 0} means "natural". */
    default int h() {
        return 0;
    }

    /**
     * The children of a node that has any - a layout, and the two macros. Empty for everything else.
     *
     * <p>One accessor rather than three {@code instanceof} chains, because three walkers already
     * existed ({@link UiDocument#flatten}, {@link UiEdit#walk}, the interpreter's builder) and the
     * parts library adds two more shapes of node to every one of them.
     */
    default List<Element> children() {
        return List.of();
    }

    /**
     * The decorations every widget-shaped element may carry: a tooltip and the two predicates over
     * bindings. {@link Decoration#NONE} for the kinds that are not widgets (slots, layouts, macros).
     */
    default Decoration deco() {
        return Decoration.NONE;
    }

    // ---------------------------------------------------------------------------------------------

    /** Absolute at the top level, or a cell inside a layout node (section 4.3). */
    sealed interface Placement {
        /** Panel-relative position. Every top-level element has one; slots always do. */
        record Absolute(int x, int y) implements Placement {}

        /**
         * A child of a layout node. {@code dx}/{@code dy} is the explicit offset a drag leaves behind
         * (section 4.3 - the override, always legible as one); {@code padding} and {@code alignX}/
         * {@code alignY} map one-to-one onto vanilla's {@code LayoutSettings}; {@code row}/{@code col}
         * and the spans are grid cells only ({@code row < 0} when not in a grid).
         */
        record Cell(int dx, int dy, Padding padding, float alignX, float alignY,
                    int row, int col, int rowSpan, int colSpan) implements Placement {
            public static final Cell DEFAULT = new Cell(0, 0, Padding.NONE, 0.0F, 0.0F, -1, -1, 1, 1);

            public boolean inGrid() {
                return row >= 0;
            }

            public boolean hasOffset() {
                return dx != 0 || dy != 0;
            }
        }
    }

    /** Vanilla's four-sided padding. */
    record Padding(int left, int top, int right, int bottom) {
        public static final Padding NONE = new Padding(0, 0, 0, 0);

        public boolean isNone() {
            return left == 0 && top == 0 && right == 0 && bottom == 0;
        }

        public boolean uniform() {
            return left == top && top == right && right == bottom;
        }
    }

    /** What a slot shows in a detached preview (section 6.1). {@code null} on a slot means empty. */
    record Placeholder(String item, int count) {}

    /** ui-lib's four text variants (section 4.2). */
    enum LabelMode {
        PLAIN("plain"), WRAPPED("wrapped"), SCROLLING("scrolling"), TRUNCATED("truncated");

        private final String jsonName;

        LabelMode(final String jsonName) {
            this.jsonName = jsonName;
        }

        public String jsonName() {
            return jsonName;
        }

        public static LabelMode forName(final String s) {
            for (LabelMode m : values()) {
                if (m.jsonName.equals(s)) {
                    return m;
                }
            }
            return null;
        }
    }

    // ---------------------------------------------------------------------------------------------

    /**
     * A tooltip on a leaf: either the text itself, or the name of a hook the behaviour subclass
     * fills in (the {@code region} escape hatch's shape, reused rather than reinvented).
     *
     * <p>Exactly one of the two is non-null. A hook tooltip draws NOTHING in the interpreter, for
     * the same reason a region does: the generated screen's default hook returns no lines, and the
     * conformance check compares pixels.
     */
    record Tooltip(Text text, String hook) {
        public static Tooltip of(final Text t) {
            return new Tooltip(t, null);
        }

        public static Tooltip hook(final String name) {
            return new Tooltip(null, name);
        }

        public boolean isHook() {
            return hook != null;
        }
    }

    /** How a {@link Predicate} compares a binding's value. */
    enum Cmp {
        EQ("eq"), NE("ne"), LT("lt"), LTE("lte"), GT("gt"), GTE("gte");

        private final String jsonName;

        Cmp(final String jsonName) {
            this.jsonName = jsonName;
        }

        public String jsonName() {
            return jsonName;
        }

        public boolean test(final int value, final int against) {
            return switch (this) {
                case EQ -> value == against;
                case NE -> value != against;
                case LT -> value < against;
                case LTE -> value <= against;
                case GT -> value > against;
                case GTE -> value >= against;
            };
        }

        public static Cmp forName(final String s) {
            for (Cmp c : values()) {
                if (c.jsonName.equals(s)) {
                    return c;
                }
            }
            return null;
        }
    }

    /**
     * A condition over one declared binding: {@code "can_apply"} is {@code != 0}, and the object form
     * {@code {"binding": "selected", "ne": 0}} names a comparator.
     *
     * <p>A flag is an int and section 8.2 already carries ints, diffed and synced by vanilla - so
     * this adds no channel and no packet. What it removes is the {@code containerTick} override every
     * hand-written screen grows in order to write one {@code button.active = ...} line.
     */
    record Predicate(String binding, Cmp cmp, int value) {
        public boolean test(final int bindingValue) {
            return cmp.test(bindingValue, value);
        }
    }

    /**
     * One declared parameter of a {@code .part.json} (UI_PARTS_LIBRARY_DESIGN.md section 5.2 rule 3).
     *
     * <p>A part declares what it references; it never assumes. The instance carries the whole list,
     * not only the arguments it supplied, because that list IS the inspector's property table for a
     * part instance - rule 5's "filled in and configured", with no second table to keep in step.
     *
     * @param def {@code null} when the parameter is required; a JSON null when it is optional and
     *            defaults to absent
     */
    record PartParam(String name, String type, JsonElement def, boolean required) {}

    /** {@link Tooltip} plus the two predicates: what every widget-shaped element may carry. */
    record Decoration(Tooltip tooltip, Predicate visible, Predicate enabled) {
        public static final Decoration NONE = new Decoration(null, null, null);

        public boolean isNone() {
            return tooltip == null && visible == null && enabled == null;
        }

        /** Does anything here have to be re-evaluated as bindings change? */
        public boolean stateful() {
            return visible != null || enabled != null;
        }
    }

    /** Where an {@code icon}'s pixels come from: the GUI atlas, or a window into a raw texture. */
    record Sheet(String texture, int u, int v, int srcW, int srcH, int sheetW, int sheetH) {
        /** Vanilla's default sheet size, and the one every {@code textures/gui} PNG in this workspace uses. */
        public static final int DEFAULT_SHEET = 256;
    }

    /** How a {@code button} is drawn behind its label and sprite. */
    enum Face {
        /** Vanilla's button face. */
        VANILLA("vanilla"),
        /** Nothing: the sprite IS the button (half alpha when inactive, the hover sprite when hovered). */
        NONE("none");

        private final String jsonName;

        Face(final String jsonName) {
            this.jsonName = jsonName;
        }

        public String jsonName() {
            return jsonName;
        }

        public static Face forName(final String s) {
            for (Face f : values()) {
                if (f.jsonName.equals(s)) {
                    return f;
                }
            }
            return null;
        }
    }

    /** What an {@code entity} element shows. */
    record Subject(String kind, List<String> equipment) {
        /** The client player, the one subject every screen has. */
        public static final String PLAYER = "player";
        /** An armour stand, which is what wears the slots a screen holds. */
        public static final String ARMOR_STAND = "armor_stand";

        public boolean isPlayer() {
            return PLAYER.equals(kind);
        }

        public boolean isArmorStand() {
            return ARMOR_STAND.equals(kind);
        }

        /** Neither of the two names: an entity type id to create a render state from. */
        public boolean isEntityType() {
            return !isPlayer() && !isArmorStand();
        }
    }

    /** {@code panel} / {@code well} / {@code frame}: the bevel helper written four times, as data. */
    record Box(Kind kind, String id, Placement placement, int w, int h, Decoration deco) implements Element {
        public Box {
            if (kind.family() != Kind.Family.BOX) {
                throw new IllegalArgumentException(kind + " is not a box kind");
            }
        }
    }

    /** Text. {@code w == 0} is natural width, allowed only in {@link LabelMode#PLAIN}. */
    record Label(String id, Placement placement, int w, int h, Text text, LabelMode mode,
                 int color, boolean shadow, Decoration deco) implements Element {
        @Override
        public Kind kind() {
            return Kind.LABEL;
        }
    }

    /**
     * One menu slot: index {@code index} of container {@code container}, drawn with its 18x18 well at
     * {@code (x-1, y-1)} exactly as vanilla places {@code Slot(container, index, x, y)}. Absolute only.
     */
    record Slot(String id, int x, int y, String container, int index, Placeholder placeholder,
                String icon) implements Element {
        @Override
        public Kind kind() {
            return Kind.SLOT;
        }

        @Override
        public Placement placement() {
            return new Placement.Absolute(x, y);
        }

        @Override
        public int w() {
            return 18;
        }

        @Override
        public int h() {
            return 18;
        }
    }

    /** {@code cols x rows} slots on the 18px pitch; indices row-major from {@code first}. */
    record SlotGrid(String id, int x, int y, int cols, int rows, String container, int first,
                    Placeholder placeholder, String icon) implements Element {
        @Override
        public Kind kind() {
            return Kind.SLOT_GRID;
        }

        @Override
        public Placement placement() {
            return new Placement.Absolute(x, y);
        }

        @Override
        public int w() {
            return cols * 18;
        }

        @Override
        public int h() {
            return rows * 18;
        }

        public int count() {
            return cols * rows;
        }
    }

    /**
     * A button bound to a declared action. {@code sprite} is optional, drawn over the face;
     * {@code face} may be {@code none}, which is how a bare arrow off a sheet becomes a button
     * (the parts-library design section 3.4).
     *
     * @param args the action's arguments when the action is parameterised (section 4.2): one value
     *             per declared arity slot, checked against it at parse time so the id arithmetic
     *             exists ONCE, in the emitter, instead of once in the screen and once in the menu
     */
    record Button(String id, Placement placement, int w, int h, Text text, String action, List<Integer> args,
                  String sprite, String spriteHovered, Face face, Decoration deco) implements Element {
        public Button {
            args = List.copyOf(args);
        }

        @Override
        public Kind kind() {
            return Kind.BUTTON;
        }
    }

    /** A fill bar over binding {@code binding}; fills upward when {@code vertical}. */
    record Bar(String id, Placement placement, int w, int h, String binding, boolean vertical,
               int fill, int track, Decoration deco) implements Element {
        @Override
        public Kind kind() {
            return Kind.BAR;
        }
    }

    /** A static 16x16 item display. */
    record Item(String id, Placement placement, String item, int count, boolean decorated,
                Decoration deco) implements Element {
        @Override
        public Kind kind() {
            return Kind.ITEM;
        }

        @Override
        public int w() {
            return 16;
        }

        @Override
        public int h() {
            return 16;
        }
    }

    /**
     * A GUI-atlas sprite, or a window into a raw texture at any scale.
     *
     * <p>Exactly one of {@code sprite} (the atlas) and {@code sheet} (a texture plus u/v and a source
     * rectangle) is set. The sheet form is one vanilla {@code blit} call and it is what deletes the
     * four hand-rolled {@code pushMatrix()/scale(0.5f)} blocks section 3.4 counted.
     */
    record Icon(String id, Placement placement, int w, int h, String sprite, Sheet sheet, int color,
                Decoration deco) implements Element {
        @Override
        public Kind kind() {
            return Kind.ICON;
        }
    }

    /**
     * A live entity drawn into a rectangle - vanilla's {@code GuiGraphicsExtractor.entity}, which the
     * inventory, the smithing table and every mob-preview screen call with the same twenty lines
     * around it (the parts-library design section 3.1).
     *
     * @param subject     what to show: the player, an armour stand, or an entity type id
     * @param scale       vanilla's {@code size} argument (the inventory uses 30, smithing 25)
     * @param pitch       degrees, positive tips the subject forward
     * @param yaw         degrees around the vertical axis
     * @param followMouse the inventory's behaviour: the subject looks at the pointer
     * @param draggable   a drag inside the rectangle turns the subject, which is the one interaction
     *                    every such screen writes by hand
     */
    record Entity(String id, Placement placement, int w, int h, Subject subject, float scale,
                  float pitch, float yaw, boolean followMouse, boolean draggable,
                  Decoration deco) implements Element {
        @Override
        public Kind kind() {
            return Kind.ENTITY;
        }
    }

    /** The escape hatch (section 4.4). Its id is required: the hook is named after it. */
    record Region(String id, Placement placement, int w, int h, Decoration deco) implements Element {
        @Override
        public Kind kind() {
            return Kind.REGION;
        }
    }

    /** {@code row} / {@code column} / {@code grid} / {@code stack}: a vanilla layout over children. */
    record Layout(Kind kind, String id, Placement placement, int spacing, List<Element> children) implements Element {
        public Layout {
            if (!kind.isLayout()) {
                throw new IllegalArgumentException(kind + " is not a layout kind");
            }
            children = List.copyOf(children);
        }

        @Override
        public List<Element> children() {
            return children;
        }
    }

    /**
     * <b>An instance of a {@code .part.json} library fragment</b> (the parts-library design section 5).
     *
     * <p>The document keeps the INSTANCE - the part's id, the arguments, and where it sits - and the
     * parser keeps the expansion beside it. That split is the whole of rule 5: {@link UiWriter} writes
     * only what is above the line, so a save writes {@code {"kind": "part", ...}} and never the six
     * elements it became; every renderer walks {@link #children()} and never learns the word.
     *
     * @param x        the instance's origin: the part's own elements are written around {@code (0,0)}
     *                 and translated here, which is what makes a part reusable at all
     * @param part     {@code <namespace>:<name>}, resolved through a {@link PartLibrary}
     * @param params   the part's declared parameters, carried so the inspector needs no second table
     * @param args     the arguments as given, for the writer and the inspector
     * @param hash     the part FILE's content hash, so generated Java can name the version it was
     *                 compiled from (section 5.3 - a part bug ships N times and there is nothing to grep)
     * @param children the expansion: ordinary elements, ids namespaced {@code <instance>.<inner>}
     */
    record Part(String id, int x, int y, String part, List<PartParam> params,
                Map<String, JsonElement> args, String hash, List<Element> children) implements Element {
        public Part {
            params = List.copyOf(params);
            args = Map.copyOf(args);
            children = List.copyOf(children);
        }

        @Override
        public Kind kind() {
            return Kind.PART;
        }

        @Override
        public Placement placement() {
            return new Placement.Absolute(x, y);
        }

        @Override
        public List<Element> children() {
            return children;
        }
    }

    /**
     * {@code count} copies of one subtree, with {@code $i} substituted into it.
     *
     * <p>{@code slot_grid} was already this, for one kind only (section 4.1). Like {@link Part} it
     * keeps its source - the {@code template} the writer puts back - beside its expansion.
     *
     * @param template the children AS WRITTEN, with the {@code $i} references still in them
     */
    record Repeat(String id, int x, int y, int count, JsonArray template,
                  List<Element> children) implements Element {
        public Repeat {
            children = List.copyOf(children);
        }

        @Override
        public Kind kind() {
            return Kind.REPEAT;
        }

        @Override
        public Placement placement() {
            return new Placement.Absolute(x, y);
        }

        @Override
        public List<Element> children() {
            return children;
        }
    }

    /** A {@code SpacerElement}. Never at the top level, never named. */
    record Spacer(Placement placement, int w, int h) implements Element {
        @Override
        public Kind kind() {
            return Kind.SPACER;
        }

        @Override
        public String id() {
            return null;
        }
    }
}
