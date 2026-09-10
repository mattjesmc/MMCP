package com.mattmc.mcptoolkit.ui.doc;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * <b>The element registry: the single enumeration of what a {@code .ui.json} may contain.</b>
 *
 * <p>SCREEN_AUTHORING_DESIGN.md sections 9 and 12: the editor's palette and the conformance battery
 * both enumerate from here, never from a hand-kept list, so a kind that is not registered cannot be
 * rendered, offered or checked. The interpreter dispatches on this enum with an exhaustive switch,
 * which is what turns "not registered" into a compile error rather than a silent gap.
 *
 * <p>Every kind here is one the palette, the battery and BOTH emitters carry forever, so the set is
 * deliberately the ui-lib set plus what containers need plus the escape hatch (section 4.2), and
 * nothing that a {@link #REGION} already covers. {@code list} is NOT here: its rows need a data
 * transport section 8 does not provide (ContainerData carries ints, not rows). A candidate answer
 * now exists - the row source is a SLOT, because slot sync already carries arbitrary structured data
 * (UI_PARTS_LIBRARY_DESIGN.md section 4.3) - but registering a kind whose meaning is undecided would
 * commit every downstream to a placeholder, so until a real screen decides it a hand-drawn list is a
 * {@code region}.
 *
 * <p><b>Two of these do not survive the parse.</b> {@link #PART} and {@link #REPEAT} are
 * {@link Family#MACRO}: the document keeps the instance and the parser keeps the expansion beside
 * it, so every renderer walks ordinary elements and never learns the word, while a save writes the
 * instance back. They are registered all the same - the palette offers them, the battery enumerates
 * them, and {@code kindsUsed()} reports them - because a kind that is not registered cannot be
 * offered or checked, and that rule has no exception for a kind whose job is to disappear.
 */
public enum Kind {
    /** Raised bevel, the container grey. Decorative. */
    PANEL("panel", Family.BOX),
    /** Recessed bevel: the inside of a list, a field, a preview box. Decorative. */
    WELL("well", Family.BOX),
    /** The outer screen border: dark frame, panel grey inset by one pixel. Decorative. */
    FRAME("frame", Family.BOX),
    /** Text in one of four modes: plain, wrapped, scrolling, truncated. */
    LABEL("label", Family.LEAF),
    /** One menu slot. Generates into BOTH sides (section 4.5), so it is absolute-only. */
    SLOT("slot", Family.SLOT),
    /** A cols x rows block of slots on the 18px pitch, indices running row-major from {@code first}. */
    SLOT_GRID("slot_grid", Family.SLOT),
    /** A vanilla button bound to a declared action (section 8.1). Text, or text plus a sprite. */
    BUTTON("button", Family.LEAF),
    /** A fill-proportion bar bound to a declared binding (section 8.2). */
    BAR("bar", Family.LEAF),
    /** A static item display, decorated (count/durability) or not. Always 16x16. */
    ITEM("item", Family.LEAF),
    /** A GUI-atlas sprite, optionally a window into a sheet at a scale. */
    ICON("icon", Family.LEAF),
    /** A live entity in a rectangle: the player, an armour stand wearing slots, or an entity type. */
    ENTITY("entity", Family.LEAF),
    /** The escape hatch: a named empty rectangle the behaviour subclass draws into (section 4.4). */
    REGION("region", Family.LEAF),
    /** Horizontal {@code LinearLayout}. Children reflow; opt-in (section 4.3). */
    ROW("row", Family.LAYOUT),
    /** Vertical {@code LinearLayout}. */
    COLUMN("column", Family.LAYOUT),
    /** {@code GridLayout}; children carry {@code row}/{@code col}. */
    GRID("grid", Family.LAYOUT),
    /** {@code FrameLayout}: children overlap and align inside the largest. */
    STACK("stack", Family.LAYOUT),
    /** {@code SpacerElement}. Only meaningful inside a layout node. */
    SPACER("spacer", Family.SPACER),
    /** An instance of a {@code .part.json} library fragment, with its arguments (the parts library). */
    PART("part", Family.MACRO),
    /** {@code count} copies of one subtree, with {@code $i} substituted into it. */
    REPEAT("repeat", Family.MACRO);

    /** What shape of element a kind is; the parser and the interpreter branch on this. */
    public enum Family {
        /** A decorative rectangle: needs x/y (or a cell) and w/h. */
        BOX,
        /** A single widget with kind-specific properties. */
        LEAF,
        /** A menu slot or block of slots: absolute x/y only, never inside a layout. */
        SLOT,
        /** A layout node over vanilla's {@code layouts} package: has children, no w/h of its own. */
        LAYOUT,
        /** A spacer: w/h and nothing else, and only inside a layout. */
        SPACER,
        /**
         * A macro: an origin plus a subtree the PARSER expands into ordinary elements. The document
         * keeps the instance (so a save writes the part, not its expansion, and the editor edits the
         * instance - the parts-library design section 5.2 rule 5); every renderer sees the children.
         */
        MACRO
    }

    private final String jsonName;
    private final Family family;

    Kind(final String jsonName, final Family family) {
        this.jsonName = jsonName;
        this.family = family;
    }

    /** The {@code "kind"} value in the document. */
    public String jsonName() {
        return jsonName;
    }

    public Family family() {
        return family;
    }

    public boolean isLayout() {
        return family == Family.LAYOUT;
    }

    public boolean isSlot() {
        return family == Family.SLOT;
    }

    /**
     * A macro node: it holds an origin and the elements the parser expanded from it.
     *
     * <p>A macro is NOT a widget on either renderer - it draws nothing of its own, and its children
     * are drawn exactly as if they had been written inline. What it is, is one thing the editor can
     * select, drag and delete, and one line the writer puts back.
     */
    public boolean isMacro() {
        return family == Family.MACRO;
    }

    /**
     * May this kind sit inside a layout node?
     *
     * <p>Slots may not: their geometry is shared with the menu and a layout computes it too late, on
     * one side only. Macros may not either, and for a related reason - a macro is a GROUP of
     * absolutely placed elements around an origin, and a layout arranges measured children one cell
     * at a time, so "is this one cell or six?" has no answer the two renderers would agree on.
     */
    public boolean allowedInLayout() {
        return family != Family.SLOT && family != Family.MACRO;
    }

    /** May this kind sit at the top level of the document? A spacer may not (it would space nothing). */
    public boolean allowedAtTopLevel() {
        return family != Family.SPACER;
    }

    /**
     * Does an element of this kind carry the leaf decorations - {@code tooltip} and {@code visible}?
     *
     * <p>Anything that becomes a widget does. A slot is the MENU's (its emptiness icon is
     * {@code icon}, its visibility {@code Slot.isActive}); a layout node and a macro are grouping,
     * and hiding one would mean hiding children that each say for themselves.
     */
    public boolean decorated() {
        return family == Family.LEAF || family == Family.BOX;
    }

    /** Lookup by document name; {@code null} when unregistered. */
    public static Kind forName(final String name) {
        for (Kind k : values()) {
            if (k.jsonName.equals(name)) {
                return k;
            }
        }
        return null;
    }

    /** Every registered name, in declaration order - what an "unknown kind" refusal lists. */
    public static List<String> names() {
        List<String> out = new ArrayList<>(values().length);
        for (Kind k : values()) {
            out.add(k.jsonName);
        }
        return Collections.unmodifiableList(out);
    }
}
