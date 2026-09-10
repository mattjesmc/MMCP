package com.mattmc.mcptoolkit.ui.doc;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;
import com.google.gson.JsonSyntaxException;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * <b>Every mutation of a document, as one pure function per verb.</b> The editor's drag, the
 * inspector's edit and the palette's insert all go through here, and so will
 * {@code ui_doc}'s ops (SCREEN_AUTHORING_DESIGN.md section 10) - one engine, four callers, which is
 * section 5's "four editors, one document" made real rather than restated.
 *
 * <p><b>The one design decision that shapes this whole class: an edit is a JSON edit followed by a
 * FULL RE-PARSE.</b> Nothing here validates anything itself. It writes the document out with
 * {@link UiWriter}, changes one key, and hands the result back to {@link UiParser} - so:
 *
 * <ul>
 *   <li>every edit is checked by the same arbiter that will check the file on load, including the
 *       lints a single-key setter would never think of (a slot moved onto another slot's index, a
 *       binding renamed out from under a bar, a spacer inserted where it means nothing);</li>
 *   <li>there is no second property table. {@link UiParser#propertyKeys} is the only one, so a key
 *       the parser does not know is a key the inspector cannot set - and a key the parser LEARNS is
 *       one the inspector offers the same day;</li>
 *   <li>a refusal is the parser's own sentence, at the parser's own path, which is the message a
 *       human would have got from the file. The editor prints it and nothing is lost;</li>
 *   <li>the result is canonical by construction ({@link UiWriter} writes defaults out), so a save
 *       is a minimal diff.</li>
 * </ul>
 *
 * <p>The cost is a parse per keystroke-commit on a few-KB document, which is nothing, and the
 * benefit is that the editor cannot produce a document the game would refuse to load.
 *
 * <p><b>Paths are the parser's paths.</b> {@code elements[3].children[1]} addresses an element here
 * and names it in a problem there, so a refusal points at the thing the human has selected.
 *
 * <p>Imports Gson only - no Minecraft (section 7.1). {@link UiDocument} and its elements are
 * immutable records, which is also why undo is free: a snapshot IS the document.
 */
public final class UiEdit {
    private UiEdit() {}

    /** The 18px slot pitch, the coarse snap and the unit a slot grid resizes in. */
    public static final int SLOT_PITCH = 18;

    /**
     * What the palette's {@code part} button inserts.
     *
     * <p>NOT {@code player_inventory}, which is the seed library's highest-value entry but places
     * all 36 of the player's slots - so on the very common screen that already has an inventory the
     * palette's first click would be a refusal about duplicate slot indices. {@code titled_well}
     * declares nothing and collides with nothing, which is what a palette default has to do; the
     * inventory is one {@code set part} away.
     */
    public static final String DEFAULT_PART = "mcptoolkit:titled_well";

    private static final Pattern PATH_HEAD = Pattern.compile("elements\\[(\\d+)]");
    private static final Pattern PATH_STEP = Pattern.compile("\\.children\\[(\\d+)]");

    // ---------------------------------------------------------------------------------------------

    /**
     * Where an element sits in the document tree: {@code []} is the document itself, {@code [3]} is
     * {@code elements[3]}, {@code [3, 1]} is {@code elements[3].children[1]}.
     *
     * <p>An index rather than an id because an id is optional (a spacer may not even have one) and
     * the editor must be able to select, drag and delete an unnamed element.
     */
    public record Path(List<Integer> steps) {
        public static final Path ROOT = new Path(List.of());

        public Path {
            steps = List.copyOf(steps);
        }

        public static Path of(final int... indices) {
            List<Integer> l = new ArrayList<>(indices.length);
            for (int i : indices) {
                l.add(i);
            }
            return new Path(l);
        }

        public boolean isRoot() {
            return steps.isEmpty();
        }

        /** True when this element is a child of a layout node, i.e. placed by a cell, not by x/y. */
        public boolean insideLayout() {
            return steps.size() > 1;
        }

        public int depth() {
            return steps.size();
        }

        public int last() {
            return steps.get(steps.size() - 1);
        }

        public Path parent() {
            if (isRoot()) {
                throw new IllegalStateException("the document has no parent");
            }
            return new Path(steps.subList(0, steps.size() - 1));
        }

        public Path child(final int index) {
            List<Integer> l = new ArrayList<>(steps);
            l.add(index);
            return new Path(l);
        }

        /** The parser's own path syntax, so an editor selection and a parse problem read the same. */
        public String format() {
            if (isRoot()) {
                return "";
            }
            StringBuilder sb = new StringBuilder("elements[").append(steps.get(0)).append(']');
            for (int i = 1; i < steps.size(); i++) {
                sb.append(".children[").append(steps.get(i)).append(']');
            }
            return sb.toString();
        }

        public static Path parse(final String s) {
            if (s == null || s.isEmpty()) {
                return ROOT;
            }
            Matcher head = PATH_HEAD.matcher(s);
            if (!head.lookingAt()) {
                throw new IllegalArgumentException("not an element path: '" + s
                    + "' (expected elements[0] or elements[0].children[1])");
            }
            List<Integer> steps = new ArrayList<>();
            steps.add(Integer.parseInt(head.group(1)));
            int at = head.end();
            Matcher step = PATH_STEP.matcher(s);
            while (at < s.length()) {
                step.region(at, s.length());
                if (!step.lookingAt()) {
                    throw new IllegalArgumentException("not an element path: '" + s + "' (stuck at '"
                        + s.substring(at) + "')");
                }
                steps.add(Integer.parseInt(step.group(1)));
                at = step.end();
            }
            return new Path(steps);
        }

        @Override
        public String toString() {
            return format();
        }
    }

    /** The document after an insert, and where the new element landed - what the editor selects. */
    public record Added(UiDocument doc, Path path) {}

    // ---------------------------------------------------------------------------------------------
    // Reading

    /**
     * <b>The EDITABLE elements</b>, depth-first, a layout node before its children.
     *
     * <p>It stops at a macro. A part instance and a repeat are each ONE thing the human selects,
     * drags, configures and deletes (UI_PARTS_LIBRARY_DESIGN.md section 5.2 rule 5: the editor edits
     * the instance, never the expansion) - what is inside them is the part file's business, and
     * there is nowhere in the document to write a change to it.
     *
     * <p>{@link #walkAll} is the other view, for everything that RENDERS rather than edits.
     */
    public static List<Placed> walk(final UiDocument doc) {
        List<Placed> out = new ArrayList<>();
        walk(doc.elements(), Path.ROOT, out, false);
        return Collections.unmodifiableList(out);
    }

    /**
     * Every element with its path, expansions included - the view the renderers and the lint take.
     *
     * <p>The paths are real: an expanded child of {@code elements[3]} is {@code elements[3].children[0]},
     * and that is the key the interpreter files its rectangle under. What they are not is WRITABLE,
     * and every mutation below says so by name.
     */
    public static List<Placed> walkAll(final UiDocument doc) {
        List<Placed> out = new ArrayList<>();
        walk(doc.elements(), Path.ROOT, out, true);
        return Collections.unmodifiableList(out);
    }

    /** An element and where it lives. */
    public record Placed(Path path, Element element) {}

    private static void walk(final List<Element> in, final Path parent, final List<Placed> out,
                             final boolean intoMacros) {
        for (int i = 0; i < in.size(); i++) {
            Element e = in.get(i);
            Path p = parent.child(i);
            out.add(new Placed(p, e));
            if (intoMacros || !e.kind().isMacro()) {
                walk(e.children(), p, out, intoMacros);
            }
        }
    }

    /**
     * The macro this path is inside, or {@code null}.
     *
     * <p>Every mutation calls it first: an edit under a part would be written into a {@code children}
     * array {@link UiWriter} never emits, so it would be silently lost on the next save. Refusing by
     * name, with the instance's own path, is the sentence that tells the human where to go instead.
     */
    public static Placed enclosingMacro(final UiDocument doc, final Path path) {
        List<Element> level = doc.elements();
        for (int depth = 0; depth < path.steps().size(); depth++) {
            int step = path.steps().get(depth);
            if (level == null || step < 0 || step >= level.size()) {
                return null;
            }
            Element found = level.get(step);
            if (found.kind().isMacro() && depth + 1 < path.steps().size()) {
                return new Placed(new Path(path.steps().subList(0, depth + 1)), found);
            }
            level = found.children();
        }
        return null;
    }

    /** The element at this path, or {@code null} when the path does not name one. */
    public static Element elementAt(final UiDocument doc, final Path path) {
        if (path.isRoot()) {
            return null;
        }
        List<Element> level = doc.elements();
        Element found = null;
        for (int step : path.steps()) {
            if (level == null || step < 0 || step >= level.size()) {
                return null;
            }
            found = level.get(step);
            level = found.children();
        }
        return found;
    }

    /** The path of the element with this id, or {@code null}. Expansions included. */
    public static Path pathOf(final UiDocument doc, final String id) {
        for (Placed p : walkAll(doc)) {
            if (id != null && id.equals(p.element().id())) {
                return p.path();
            }
        }
        return null;
    }

    /**
     * A value typed into the inspector, as JSON. Lenient on purpose: Gson's parser reads {@code 12},
     * {@code true}, {@code [2, 0]}, {@code {"item": "minecraft:coal"}} and a bare word alike, and
     * anything it chokes on becomes a string literal - because a human editing a label's text should
     * not have to type the quotes.
     */
    public static JsonElement value(final String text) {
        try {
            JsonElement e = JsonParser.parseString(text);
            return e == null || e.isJsonNull() ? new JsonPrimitive(text) : e;
        } catch (JsonSyntaxException e) {
            return new JsonPrimitive(text);
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Writing

    /**
     * Refuse an edit that would land inside a macro's expansion.
     *
     * <p>Called by every mutation that addresses one element. The alternative - letting it through -
     * writes into a {@code children} array the writer does not emit, so the edit vanishes at the next
     * save with no message anywhere.
     */
    private static void editable(final UiDocument doc, final Path path) throws UiParseException {
        Placed macro = enclosingMacro(doc, path);
        if (macro == null) {
            return;
        }
        Element m = macro.element();
        throw refusal(path.format(), "this element came from " + (m instanceof Element.Part part
            ? "part '" + part.part() + "'" : "the repeat '" + m.id() + "'")
            + " at " + macro.path().format() + ", so the document does not hold it: edit "
            + (m instanceof Element.Part ? "the part file, or this instance's arguments"
            : "the repeat's template") + " instead.");
    }

    /** Set (or, with a {@code null} value, remove) one key of one element. */
    public static UiDocument set(final UiDocument doc, final Path path, final String key,
                                 final JsonElement value) throws UiParseException {
        editable(doc, path);
        JsonObject root = UiWriter.write(doc);
        JsonObject o = object(root, path);
        if (value == null) {
            o.remove(key);
        } else {
            o.add(key, value);
        }
        return UiParser.parse(root);
    }

    /** Set (or remove) one screen-level key: {@code title}, {@code width}, {@code title_pos}, ... */
    public static UiDocument setScreen(final UiDocument doc, final String key, final JsonElement value)
        throws UiParseException {
        JsonObject root = UiWriter.write(doc);
        if (value == null) {
            root.remove(key);
        } else {
            root.add(key, value);
        }
        return UiParser.parse(root);
    }

    /**
     * Move an element by a delta - what a drag hands over.
     *
     * <p><b>Which number a drag writes is decided by where the element sits, and section 4.3 decides
     * it:</b> at the top level, {@code x}/{@code y}, the position itself. Inside a layout node the
     * layout owns the position, so the drag writes {@code offset} - the explicit override the format
     * exists to be able to express, and the one the editor draws a marker on so it never reads as an
     * accident.
     */
    public static UiDocument dragBy(final UiDocument doc, final Path path, final int dx, final int dy)
        throws UiParseException {
        editable(doc, path);
        JsonObject root = UiWriter.write(doc);
        JsonObject o = object(root, path);
        if (path.insideLayout()) {
            int[] off = pair(o.get("offset"));
            put(o, "offset", off[0] + dx, off[1] + dy, true);
        } else {
            o.addProperty("x", intOf(o.get("x")) + dx);
            o.addProperty("y", intOf(o.get("y")) + dy);
        }
        return UiParser.parse(root);
    }

    /** Move a top-level element to an absolute panel position. */
    public static UiDocument moveTo(final UiDocument doc, final Path path, final int x, final int y)
        throws UiParseException {
        editable(doc, path);
        if (path.insideLayout()) {
            throw refusal(path.format(), "this element is placed by its layout node; a move writes an"
                + " offset (use dragBy) or you move the node itself");
        }
        JsonObject root = UiWriter.write(doc);
        JsonObject o = object(root, path);
        o.addProperty("x", x);
        o.addProperty("y", y);
        return UiParser.parse(root);
    }

    /** Drop a layout child's {@code offset} override, handing the position back to the layout. */
    public static UiDocument clearOffset(final UiDocument doc, final Path path) throws UiParseException {
        return set(doc, path, "offset", null);
    }

    /**
     * Resize by a pixel size.
     *
     * <p>A {@code slot_grid} resizes in SLOTS, not pixels - it has no {@code w}, its size is
     * {@code cols * 18}, and rounding the drag to the pitch is what makes dragging one feel like
     * dragging a grid. Kinds with no declared size (a slot is 18x18, an item 16x16, a layout is the
     * size of its children) are refused by name rather than silently ignored.
     */
    public static UiDocument resize(final UiDocument doc, final Path path, final int w, final int h)
        throws UiParseException {
        editable(doc, path);
        Element e = elementAt(doc, path);
        if (e == null) {
            throw refusal(path.format(), "no element there");
        }
        if (e.kind().isMacro()) {
            throw refusal(path.format(), "a " + e.kind().jsonName() + " has no size of its own: it is an"
                + " origin, and what it expands to is sized by the fragment");
        }
        JsonObject root = UiWriter.write(doc);
        JsonObject o = object(root, path);
        if (e.kind() == Kind.SLOT_GRID) {
            o.addProperty("cols", Math.max(1, Math.round(w / (float) SLOT_PITCH)));
            o.addProperty("rows", Math.max(1, Math.round(h / (float) SLOT_PITCH)));
            return UiParser.parse(root);
        }
        Set<String> keys = UiParser.propertyKeys(e.kind());
        if (!keys.contains("w") && !keys.contains("h")) {
            throw refusal(path.format(), "a " + e.kind().jsonName() + " has no declared size: "
                + (e.kind().isLayout() ? "a layout node is the size of its children"
                : "its size is fixed (" + e.w() + "x" + e.h() + ")"));
        }
        if (keys.contains("w")) {
            o.addProperty("w", Math.max(0, w));
        }
        if (keys.contains("h")) {
            o.addProperty("h", Math.max(0, h));
        }
        return UiParser.parse(root);
    }

    /** Delete an element (and, when it is a layout node, everything inside it). */
    public static UiDocument remove(final UiDocument doc, final Path path) throws UiParseException {
        if (path.isRoot()) {
            throw refusal("", "the document itself cannot be removed");
        }
        editable(doc, path);
        JsonObject root = UiWriter.write(doc);
        JsonArray list = list(root, path.parent());
        if (path.last() >= list.size()) {
            throw refusal(path.format(), "no element there");
        }
        list.remove(path.last());
        return UiParser.parse(root);
    }

    /**
     * <b>The palette's insert.</b> Every registered {@link Kind} can be added, and the element it
     * inserts is one the parser accepts - which for four kinds means declaring what they refer to.
     *
     * <p>That is the whole point of putting this here rather than in the editor: a palette entry that
     * inserts an invalid element is a palette entry that lies, and "every kind inserts cleanly" is
     * then a unit test enumerated from {@code Kind.values()} (the menagerie-review discipline: a new
     * kind cannot arrive without its default). So a {@code button} brings a new action, a {@code bar}
     * a new binding with a max, and a {@code slot} / {@code slot_grid} the free container indices
     * they need - a fresh container when nothing declared has room.
     *
     * <p>{@code parent} is {@link Path#ROOT} for the top level, or a layout node's path to insert
     * into it. The placement rules are NOT re-implemented here: inserting a spacer at the top level
     * simply produces the parser's own refusal, which is the sentence the human needs anyway.
     *
     * @param x panel x, ignored when inserting into a layout node (the layout places its children)
     */
    public static Added add(final UiDocument doc, final Kind kind, final Path parent, final int x, final int y)
        throws UiParseException {
        editable(doc, parent);
        JsonObject root = UiWriter.write(doc);
        boolean intoLayout = !parent.isRoot();
        Element parentElement = intoLayout ? elementAt(doc, parent) : null;
        if (parentElement != null && parentElement.kind().isMacro()) {
            throw refusal(parent.format(), "a " + parentElement.kind().jsonName() + " expands a fragment;"
                + " add to the fragment, not to the instance");
        }
        if (intoLayout && !(parentElement instanceof Element.Layout)) {
            throw refusal(parent.format(), "not a layout node, so nothing can be added inside it");
        }
        boolean intoGrid = parentElement != null && parentElement.kind() == Kind.GRID;

        JsonObject o = new JsonObject();
        o.addProperty("kind", kind.jsonName());
        if (kind != Kind.SPACER) {
            o.addProperty("id", freshId(doc, kind));
        }
        if (intoLayout) {
            if (intoGrid) {
                int[] cell = freeCell((Element.Layout) parentElement);
                o.addProperty("row", cell[0]);
                o.addProperty("col", cell[1]);
            }
        } else {
            o.addProperty("x", x);
            o.addProperty("y", y);
        }
        properties(doc, root, o, kind);

        JsonArray list = list(root, parent);
        list.add(o);
        UiDocument parsed = UiParser.parse(root);
        return new Added(parsed, parent.child(list.size() - 1));
    }

    /** The kind-specific half of an insert: the defaults, and the declarations they need. */
    private static void properties(final UiDocument doc, final JsonObject root, final JsonObject o,
                                   final Kind kind) {
        switch (kind) {
            case PANEL, WELL, FRAME -> {
                o.addProperty("w", 40);
                o.addProperty("h", 20);
            }
            case LABEL -> o.addProperty("text", "Label");
            case BUTTON -> {
                o.addProperty("w", 50);
                o.addProperty("text", "Button");
                o.addProperty("action", declareAction(doc, root));
            }
            case BAR -> {
                o.addProperty("w", 60);
                o.addProperty("h", 8);
                o.addProperty("binding", declareBinding(doc, root));
            }
            case ITEM -> o.addProperty("item", "minecraft:stone");
            case ICON -> {
                o.addProperty("w", 12);
                o.addProperty("h", 12);
                o.addProperty("sprite", "minecraft:icon/checkmark");
            }
            case ENTITY -> {
                o.addProperty("w", 40);
                o.addProperty("h", 60);
                o.addProperty("subject", Element.Subject.PLAYER);
            }
            case REGION -> {
                o.addProperty("w", 32);
                o.addProperty("h", 16);
            }
            // A macro with nothing in it is the layout-node problem again, one level up: invisible,
            // unselectable, and a dead end for whoever just clicked the palette. So the palette's
            // repeat arrives with a subtree, and its part arrives as the one part every screen wants.
            case REPEAT -> {
                o.addProperty("count", 3);
                JsonArray children = new JsonArray();
                JsonObject child = new JsonObject();
                child.addProperty("kind", "label");
                child.addProperty("id", "row_$i");
                child.addProperty("x", 0);
                child.addProperty("y", "$i * 12");
                child.addProperty("text", "row $i");
                children.add(child);
                o.add("children", children);
            }
            case PART -> {
                o.addProperty("part", DEFAULT_PART);
                fillPartArgs(doc, root, o, DEFAULT_PART);
            }
            case SLOT -> {
                int[] where = declareSlots(doc, root, 1);
                o.addProperty("container", containerName(doc, root, where[0]));
                o.addProperty("index", where[1]);
            }
            case SLOT_GRID -> {
                int cols = 3;
                int rows = 1;
                int[] where = declareSlots(doc, root, cols * rows);
                o.addProperty("cols", cols);
                o.addProperty("rows", rows);
                o.addProperty("container", containerName(doc, root, where[0]));
                if (where[1] != 0) {
                    o.addProperty("first", where[1]);
                }
            }
            case ROW, COLUMN, GRID, STACK -> {
                // A layout with no children arranges to 0x0: invisible, unselectable, and a dead end
                // for the human who just added it. One label makes it a thing on screen.
                JsonArray children = new JsonArray();
                JsonObject child = new JsonObject();
                child.addProperty("kind", "label");
                child.addProperty("id", freshId(doc, Kind.LABEL));
                child.addProperty("text", kind.jsonName());
                if (kind == Kind.GRID) {
                    child.addProperty("row", 0);
                    child.addProperty("col", 0);
                }
                children.add(child);
                o.add("children", children);
            }
            case SPACER -> {
                o.addProperty("w", 4);
                o.addProperty("h", 4);
            }
            default -> throw new IllegalStateException("no insert default for kind " + kind);
        }
    }

    /**
     * Every REQUIRED argument of an inserted part, filled with something the parser will accept.
     *
     * <p>The same rule the rest of {@link #properties} follows, one level up: a palette entry that
     * inserts an invalid element is a palette entry that lies. A part declares what it references
     * (UI_PARTS_LIBRARY_DESIGN.md section 5.2 rule 3), so the types here are the reason those
     * declarations are typed at all - {@code container} finds free indices or declares a container,
     * {@code action} and {@code binding} declare one, and a plain number is a number.
     *
     * <p>A part that cannot be read at all is left alone: the parse that follows says so, at the
     * path of the element just inserted, which is the sentence the human needs.
     */
    private static void fillPartArgs(final UiDocument doc, final JsonObject root, final JsonObject o,
                                     final String partId) {
        int colon = partId.indexOf(':');
        if (colon < 0) {
            return;
        }
        String text;
        try {
            text = PartLibrary.current().read(partId.substring(0, colon), partId.substring(colon + 1));
        } catch (java.io.IOException e) {
            return;
        }
        if (text == null) {
            return;
        }
        JsonObject file;
        try {
            com.google.gson.JsonElement je = JsonParser.parseString(text);
            if (!je.isJsonObject()) {
                return;
            }
            file = je.getAsJsonObject();
        } catch (JsonSyntaxException e) {
            return;
        }
        if (!file.has("params") || !file.get("params").isJsonArray()) {
            return;
        }
        for (JsonElement pe : file.getAsJsonArray("params")) {
            if (!pe.isJsonObject()) {
                continue;
            }
            JsonObject prm = pe.getAsJsonObject();
            if (prm.has("default") || !prm.has("name")) {
                continue;
            }
            String name = prm.get("name").getAsString();
            String type = prm.has("type") ? prm.get("type").getAsString() : "any";
            switch (type) {
                case "int", "number", "any" -> o.addProperty(name, 20);
                case "bool" -> o.addProperty(name, false);
                case "text" -> o.addProperty(name, "Title");
                case "container" -> {
                    int[] where = declareSlots(doc, root, 1);
                    o.addProperty(name, containerName(doc, root, where[0]));
                }
                case "action" -> o.addProperty(name, declareAction(doc, root));
                case "binding" -> o.addProperty(name, declareBinding(doc, root));
                case "sprite" -> o.addProperty(name, "minecraft:icon/checkmark");
                case "item" -> o.addProperty(name, "minecraft:stone");
                case "texture" -> o.addProperty(name, "minecraft:textures/gui/container/inventory.png");
                default -> o.addProperty(name, name);
            }
        }
    }

    /**
     * The first unused cell of a grid node, scanning row-major - so adding to a grid fills the next
     * hole rather than stacking a second child on an occupied cell.
     */
    private static int[] freeCell(final Element.Layout grid) {
        Set<Long> used = new HashSet<>();
        int maxRow = 0;
        int maxCol = 0;
        for (Element child : grid.children()) {
            if (child.placement() instanceof Element.Placement.Cell c && c.inGrid()) {
                for (int r = c.row(); r < c.row() + c.rowSpan(); r++) {
                    for (int q = c.col(); q < c.col() + c.colSpan(); q++) {
                        used.add(((long) r << 32) | (q & 0xFFFFFFFFL));
                        maxRow = Math.max(maxRow, r);
                        maxCol = Math.max(maxCol, q);
                    }
                }
            }
        }
        for (int r = 0; r <= maxRow + 1; r++) {
            for (int q = 0; q <= maxCol + 1; q++) {
                if (!used.contains(((long) r << 32) | (q & 0xFFFFFFFFL))) {
                    return new int[] {r, q};
                }
            }
        }
        return new int[] {0, 0};
    }

    // ---------------------------------------------------------------------------------------------
    // Declarations an inserted element needs

    private static String declareAction(final UiDocument doc, final JsonObject root) {
        Set<String> have = new HashSet<>();
        for (UiDocument.Action a : doc.actions()) {
            have.add(a.name());
        }
        String name = fresh("action", have);
        array(root, "actions").add(name);
        return name;
    }

    private static String declareBinding(final UiDocument doc, final JsonObject root) {
        Set<String> have = new HashSet<>();
        for (UiDocument.Binding b : doc.bindings()) {
            have.add(b.name());
        }
        String name = fresh("value", have);
        JsonObject b = new JsonObject();
        b.addProperty("name", name);
        // A bar over a binding with no max cannot fill, and the parser says so - so the default
        // carries one.
        b.addProperty("max", 100);
        b.addProperty("preview", 50);
        array(root, "bindings").add(b);
        return name;
    }

    /**
     * Find {@code count} contiguous free indices, declaring a container when nothing has room.
     *
     * @return {@code [containerIndex, first]}, where {@code containerIndex} is {@code -1} for the
     *     reserved {@code player} container and {@code doc.containers().size()} for a freshly
     *     declared one
     */
    private static int[] declareSlots(final UiDocument doc, final JsonObject root, final int count) {
        List<UiDocument.Container> cs = doc.containers();
        for (int i = 0; i < cs.size(); i++) {
            int first = firstFreeRun(doc, cs.get(i).name(), cs.get(i).size(), count);
            if (first >= 0) {
                return new int[] {i, first};
            }
        }
        int inPlayer = firstFreeRun(doc, UiDocument.PLAYER_CONTAINER, UiDocument.PLAYER_SLOTS, count);
        if (inPlayer >= 0) {
            return new int[] {-1, inPlayer};
        }
        JsonObject c = new JsonObject();
        Set<String> have = new HashSet<>();
        for (UiDocument.Container existing : cs) {
            have.add(existing.name());
        }
        c.addProperty("name", fresh("store", have));
        c.addProperty("size", count);
        array(root, "containers").add(c);
        return new int[] {cs.size(), 0};
    }

    private static String containerName(final UiDocument doc, final JsonObject root, final int which) {
        if (which < 0) {
            return UiDocument.PLAYER_CONTAINER;
        }
        if (which < doc.containers().size()) {
            return doc.containers().get(which).name();
        }
        JsonArray cs = array(root, "containers");
        return cs.get(cs.size() - 1).getAsJsonObject().get("name").getAsString();
    }

    /** The first index at which {@code count} consecutive slots of this container are unused. */
    private static int firstFreeRun(final UiDocument doc, final String container, final int size, final int count) {
        Set<Integer> used = new HashSet<>();
        for (Element e : doc.flatten()) {
            if (e instanceof Element.Slot s && s.container().equals(container)) {
                used.add(s.index());
            } else if (e instanceof Element.SlotGrid g && g.container().equals(container)) {
                for (int i = 0; i < g.count(); i++) {
                    used.add(g.first() + i);
                }
            }
        }
        for (int start = 0; start + count <= size; start++) {
            boolean free = true;
            for (int i = start; i < start + count; i++) {
                if (used.contains(i)) {
                    free = false;
                    break;
                }
            }
            if (free) {
                return start;
            }
        }
        return -1;
    }

    // ---------------------------------------------------------------------------------------------
    // Ids

    /** {@code panel_2}: the kind's name with the lowest free suffix, so an insert never collides. */
    public static String freshId(final UiDocument doc, final Kind kind) {
        Set<String> have = new HashSet<>();
        for (Element e : doc.flatten()) {
            if (e.id() != null) {
                have.add(e.id());
            }
        }
        return fresh(kind.jsonName(), have);
    }

    private static String fresh(final String base, final Set<String> have) {
        if (!have.contains(base)) {
            return base;
        }
        int n = 1;
        while (have.contains(base + "_" + (++n))) {
            continue;
        }
        return base + "_" + n;
    }

    // ---------------------------------------------------------------------------------------------
    // JSON navigation

    /** The element object at this path in a written document. */
    private static JsonObject object(final JsonObject root, final Path path) throws UiParseException {
        if (path.isRoot()) {
            return root;
        }
        JsonArray list = list(root, path.parent());
        if (path.last() >= list.size()) {
            throw refusal(path.format(), "no element there (" + list.size() + " at that level)");
        }
        return list.get(path.last()).getAsJsonObject();
    }

    /** The child list a path's children live in: the document's {@code elements}, or a node's. */
    private static JsonArray list(final JsonObject root, final Path parent) throws UiParseException {
        if (parent.isRoot()) {
            return array(root, "elements");
        }
        JsonObject node = object(root, parent);
        if (!node.has("children")) {
            throw refusal(parent.format(), "not a layout node, so it has no children");
        }
        return node.getAsJsonArray("children");
    }

    private static JsonArray array(final JsonObject o, final String key) {
        if (!o.has(key) || !o.get(key).isJsonArray()) {
            JsonArray a = new JsonArray();
            o.add(key, a);
            return a;
        }
        return o.getAsJsonArray(key);
    }

    private static int intOf(final JsonElement e) {
        return e == null || !e.isJsonPrimitive() ? 0 : e.getAsInt();
    }

    private static int[] pair(final JsonElement e) {
        if (e == null || !e.isJsonArray() || e.getAsJsonArray().size() != 2) {
            return new int[] {0, 0};
        }
        return new int[] {e.getAsJsonArray().get(0).getAsInt(), e.getAsJsonArray().get(1).getAsInt()};
    }

    /** Write an {@code [x, y]} pair, or drop the key entirely when it is back at the origin. */
    private static void put(final JsonObject o, final String key, final int a, final int b,
                            final boolean dropWhenZero) {
        if (dropWhenZero && a == 0 && b == 0) {
            o.remove(key);
            return;
        }
        JsonArray arr = new JsonArray();
        arr.add(a);
        arr.add(b);
        o.add(key, arr);
    }

    private static UiParseException refusal(final String path, final String message) {
        return new UiParseException(List.of(new UiParseException.Problem(path, message)));
    }
}
