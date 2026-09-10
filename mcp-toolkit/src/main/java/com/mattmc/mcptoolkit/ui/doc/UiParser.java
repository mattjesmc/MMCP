package com.mattmc.mcptoolkit.ui.doc;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;
import com.google.gson.JsonSyntaxException;
import com.mattmc.mcptoolkit.ui.Palette;
import com.mattmc.mcptoolkit.ui.doc.Element.Placement;
import com.mattmc.mcptoolkit.ui.doc.UiDocument.Binding;
import com.mattmc.mcptoolkit.ui.doc.UiDocument.Container;
import com.mattmc.mcptoolkit.ui.doc.UiDocument.InventoryLabel;
import com.mattmc.mcptoolkit.ui.doc.UiParseException.Problem;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.ArrayDeque;
import java.util.Collections;
import java.util.Deque;
import java.util.EnumMap;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * JSON to {@link UiDocument}, collecting every problem before refusing.
 *
 * <p>Two rules that make this the lint as well as the reader:
 * <ul>
 *   <li><b>Unknown keys are problems.</b> A misspelled {@code "colour"} that is silently ignored is a
 *       property that does nothing, and the editor's inspector (slice 4) reads its property table from
 *       {@link #propertyKeys(Kind)} - so a key the parser does not know is a key nothing knows.</li>
 *   <li><b>References are checked here, not at render time.</b> A button's action, a bar's binding, a
 *       slot's container and index all resolve against the document's own declarations, so the
 *       interpreter and the emitter can both assume a parsed document is consistent.</li>
 * </ul>
 *
 * <p>Imports Gson only - no Minecraft (section 7.1).
 */
public final class UiParser {
    private UiParser() {}

    private static final Pattern NAME = Pattern.compile("[a-z][a-z0-9_]*");
    /**
     * An element id AFTER expansion: a part or repeat namespaces its contents
     * ({@code inputs.template}, {@code sockets.2.icon}), and section 5.2 rule 2 is why - a part used
     * twice would otherwise collide on the uniqueness check below, and the second use would be a
     * refusal the author cannot see the cause of. A HAND-WRITTEN dot is still refused: see
     * {@link Ctx#expanding}.
     */
    private static final Pattern ID = Pattern.compile("[a-z][a-z0-9_]*(\\.[a-z0-9_]+)*");
    private static final Pattern RESOURCE = Pattern.compile("[a-z0-9_.-]+:[a-z0-9_./-]+");
    /**
     * A substitution: {@code $name}, optionally scaled and shifted - {@code "$i * 20 + 8"}.
     *
     * <p>Deliberately affine and nothing more. Section 5.3 refuses conditionals inside a part on the
     * grounds that "a format that needs a language has lost the argument it opened with"; the same
     * argument applies here, and an offset-and-stride is what every one of the repetitions this
     * design inventoried actually needs.
     */
    private static final Pattern AFFINE = Pattern.compile(
        "\\s*\\$([a-z][a-z0-9_]*)\\s*(?:\\*\\s*(-?\\d+)\\s*)?(?:([+-])\\s*(\\d+)\\s*)?");
    /** One {@code $name} anywhere in a string, for the interpolating case ({@code "row_$i"}). */
    private static final Pattern VARIABLE = Pattern.compile("\\$\\$|\\$([a-z][a-z0-9_]*)");

    /**
     * The names a macro binds that an OUTER expansion must leave alone.
     *
     * <p>A part whose fragment contains a {@code repeat} writes {@code "y": "$i * $pitch"}. The part's
     * own pass resolves {@code $pitch} and must walk PAST {@code $i}, which belongs to the repeat
     * inside it and is bound one pass later. Reserving the name is the whole mechanism, and it is why
     * a genuine typo is still caught: any OTHER unknown name is a problem where it is written.
     */
    public static final Set<String> LOOP_VARIABLES = Set.of("i");

    /** A repeat this long is a typo, not a screen; the refusal names the number. */
    public static final int MAX_REPEAT = 256;
    /** How deep parts may nest before the parser calls it a cycle. */
    private static final int MAX_PART_DEPTH = 8;

    private static final Set<String> DOC_KEYS = Set.of("format", "title", "width", "height", "title_pos",
        "inventory_label", "background", "sheet", "containers", "actions", "bindings", "elements");
    private static final Set<String> PART_FILE_KEYS = Set.of("format", "params", "elements");
    private static final Set<String> PARAM_KEYS = Set.of("name", "type", "default");

    /**
     * What a part parameter may be declared as. {@code container}, {@code action} and {@code binding}
     * are section 5.2 rule 3: a part declares what it references, and the reference then resolves
     * against the SCREEN's declarations because by post-pass time the part is gone.
     */
    private static final Set<String> PARAM_TYPES = Set.of("int", "number", "bool", "string", "name",
        "container", "action", "binding", "sprite", "item", "texture", "text", "color", "any");
    private static final Set<String> CELL_KEYS = Set.of("offset", "padding", "align", "row", "col",
        "row_span", "col_span");
    private static final Set<String> ABS_KEYS = Set.of("x", "y");

    /** The kind-specific keys, the inspector's property table. Common keys ({@code kind}, {@code id}, placement) are not listed. */
    private static final Map<Kind, Set<String>> KIND_KEYS = new EnumMap<>(Kind.class);

    static {
        KIND_KEYS.put(Kind.PANEL, Set.of("w", "h"));
        KIND_KEYS.put(Kind.WELL, Set.of("w", "h"));
        KIND_KEYS.put(Kind.FRAME, Set.of("w", "h"));
        KIND_KEYS.put(Kind.LABEL, Set.of("w", "h", "text", "mode", "color", "shadow"));
        KIND_KEYS.put(Kind.SLOT, Set.of("container", "index", "placeholder", "icon"));
        KIND_KEYS.put(Kind.SLOT_GRID, Set.of("cols", "rows", "container", "first", "placeholder", "icon"));
        KIND_KEYS.put(Kind.BUTTON, Set.of("w", "h", "text", "action", "args", "sprite", "sprite_hovered", "face"));
        KIND_KEYS.put(Kind.BAR, Set.of("w", "h", "binding", "orientation", "fill", "track"));
        KIND_KEYS.put(Kind.ITEM, Set.of("item", "count", "decorated"));
        KIND_KEYS.put(Kind.ICON, Set.of("w", "h", "sprite", "texture", "u", "v", "src_w", "src_h",
            "sheet_w", "sheet_h", "color"));
        KIND_KEYS.put(Kind.ENTITY, Set.of("w", "h", "subject", "equipment", "scale", "pitch", "yaw",
            "follow_mouse", "draggable"));
        KIND_KEYS.put(Kind.REGION, Set.of("w", "h"));
        KIND_KEYS.put(Kind.ROW, Set.of("spacing", "children"));
        KIND_KEYS.put(Kind.COLUMN, Set.of("spacing", "children"));
        KIND_KEYS.put(Kind.GRID, Set.of("spacing", "children"));
        KIND_KEYS.put(Kind.STACK, Set.of("spacing", "children"));
        KIND_KEYS.put(Kind.SPACER, Set.of("w", "h"));
        // A part's OTHER keys are its arguments, which only the part file knows; see element().
        KIND_KEYS.put(Kind.PART, Set.of("part"));
        KIND_KEYS.put(Kind.REPEAT, Set.of("count", "children"));
        // The leaf decorations, added here rather than typed into fifteen sets: the inspector reads
        // this table (slice 4), so a property that is not in it is a property nothing can set.
        for (Kind k : Kind.values()) {
            if (!KIND_KEYS.containsKey(k)) {
                throw new IllegalStateException("no property table for kind " + k);
            }
            if (!k.decorated()) {
                continue;
            }
            Set<String> keys = new HashSet<>(KIND_KEYS.get(k));
            keys.add("tooltip");
            keys.add("visible");
            if (k == Kind.BUTTON) {
                keys.add("enabled");
            }
            KIND_KEYS.put(k, Set.copyOf(keys));
        }
    }

    /** Every declarable parameter type, sorted, for the sentence an unknown one prints. */
    private static final Set<String> PART_TYPE_NAMES = PARAM_TYPES;

    /** The kind-specific property keys a document may set on an element of this kind. */
    public static Set<String> propertyKeys(final Kind kind) {
        return Collections.unmodifiableSet(KIND_KEYS.get(kind));
    }

    /**
     * The keys an inspector may set on ONE element - the kind's table, plus a part instance's
     * arguments, which only its part file knows (UI_PARTS_LIBRARY_DESIGN.md section 5.2 rule 5).
     */
    public static List<String> propertyKeys(final Element e) {
        List<String> out = new ArrayList<>();
        if (e instanceof Element.Part part) {
            out.add("part");
            for (Element.PartParam prm : part.params()) {
                out.add(prm.name());
            }
            return Collections.unmodifiableList(out);
        }
        out.addAll(new java.util.TreeSet<>(KIND_KEYS.get(e.kind())));
        return Collections.unmodifiableList(out);
    }

    /** Every part instance in a document, in tree order - the provenance section 5.3 asks for. */
    public static List<Element.Part> partsUsed(final UiDocument doc) {
        List<Element.Part> out = new ArrayList<>();
        for (Element e : doc.flatten()) {
            if (e instanceof Element.Part part) {
                out.add(part);
            }
        }
        return Collections.unmodifiableList(out);
    }

    /**
     * A part file's content hash - the eight hex digits generated Java cites.
     *
     * <p>Section 5.3's first mitigation: vendoring means a part bug ships N times and the part's own
     * text is copied into no repository, so a generated file that does not say WHICH version of the
     * part it was compiled from leaves nothing to grep. Line endings are normalised first, or a
     * Windows checkout and a Linux one would disagree about a file they both hold identically.
     */
    /** Line endings are git's business: two checkouts of one file must hash the same. */
    private static String normalise(final String text) {
        return text.replace(String.valueOf((char) 13) + (char) 10, String.valueOf((char) 10));
    }

    public static String hash(final String text) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                .digest(normalise(text).getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(8);
            for (int i = 0; i < 4; i++) {
                sb.append(String.format(Locale.ROOT, "%02x", digest[i]));
            }
            return sb.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is required of every JVM", e);
        }
    }

    // ---------------------------------------------------------------------------------------------

    /** Parse against a named part library rather than the ambient one - what a test and Gradle do. */
    public static UiDocument parse(final String json, final PartLibrary library) throws UiParseException {
        try (PartLibrary.Scope s = PartLibrary.scoped(library)) {
            return parse(json);
        }
    }

    public static UiDocument parse(final String json) throws UiParseException {
        JsonElement root;
        try {
            root = JsonParser.parseString(json);
        } catch (JsonSyntaxException e) {
            throw new UiParseException(List.of(new Problem("", "not JSON: " + e.getMessage())));
        }
        if (!root.isJsonObject()) {
            throw new UiParseException(List.of(new Problem("", "the document must be a JSON object")));
        }
        return parse(root.getAsJsonObject());
    }

    public static UiDocument parse(final JsonObject root) throws UiParseException {
        Ctx c = new Ctx();
        UiDocument doc = c.document(root);
        if (!c.problems.isEmpty()) {
            throw new UiParseException(c.problems);
        }
        return doc;
    }

    // ---------------------------------------------------------------------------------------------

    /** One parse: the problem list and the reference tables the post-pass checks against. */
    private static final class Ctx {
        final List<Problem> problems = new ArrayList<>();
        final Map<String, String> idPaths = new HashMap<>();
        final List<Ref> refs = new ArrayList<>();
        /**
         * How many macro expansions are open above the element being parsed.
         *
         * <p>It gates exactly one rule: a dotted id is legal only when the parser wrote it (section
         * 5.2 rule 2's namespacing). A human typing {@code "id": "a.b"} gets the same refusal they
         * always did, so the relaxed {@link #ID} pattern buys the expansion its names without
         * loosening the format.
         */
        int expanding;
        /** The part ids currently being expanded, so a cycle is a sentence and not a stack overflow. */
        final Deque<String> partStack = new ArrayDeque<>();
        /** Part files already read this parse: one read, one hash, however often a part is used. */
        final Map<String, PartFile> partCache = new HashMap<>();
        /** Buttons that named a parameterised action, checked against its arity once it is declared. */
        final List<ActionUse> actionUses = new ArrayList<>();
        /** {@code entity.equipment} entries: {@code {path, elementId}}, checked against the slots. */
        final List<String[]> slotRefs = new ArrayList<>();

        /** One button's use of an action: where it is, which action, and the argument values it packs. */
        record ActionUse(String path, String action, List<Integer> values) {}

        /** A part file, read and parsed once. */
        record PartFile(String namespace, String name, List<Element.PartParam> params, JsonArray elements,
                        String hash) {
            String id() {
                return namespace + ":" + name;
            }
        }

        /** A reference from an element to a declaration, checked once every declaration is known. */
        record Ref(String path, String what, String name, int index, int count) {}

        void problem(final String path, final String message) {
            problems.add(new Problem(path, message));
        }

        // ---- document -------------------------------------------------------------------------

        UiDocument document(final JsonObject o) {
            unknownKeys(o, DOC_KEYS, "");
            int format = optInt(o, "format", -1, "");
            if (format != UiDocument.FORMAT) {
                problem("format", "expected " + UiDocument.FORMAT + ", got " + (format < 0 ? "nothing" : format));
            }
            Text title = reqText(o, "title", "");
            int width = reqInt(o, "width", "", 1);
            int height = reqInt(o, "height", "", 1);
            int titleX = UiDocument.DEFAULT_TITLE_X;
            int titleY = UiDocument.DEFAULT_TITLE_Y;
            if (o.has("title_pos")) {
                int[] p = point(o.get("title_pos"), "title_pos");
                if (p != null) {
                    titleX = p[0];
                    titleY = p[1];
                }
            }
            InventoryLabel inv = InventoryLabel.defaultFor(height);
            if (o.has("inventory_label")) {
                JsonElement e = o.get("inventory_label");
                if (e.isJsonPrimitive() && e.getAsJsonPrimitive().isBoolean() && !e.getAsBoolean()) {
                    inv = InventoryLabel.HIDDEN;
                } else {
                    int[] p = point(e, "inventory_label");
                    if (p != null) {
                        inv = new InventoryLabel(true, p[0], p[1]);
                    } else {
                        problem("inventory_label", "expected [x, y] or false");
                    }
                }
            }
            String background = optStr(o, "background", null, "");
            if (background != null && !RESOURCE.matcher(background).matches()) {
                problem("background", "expected a texture id like mymod:textures/gui/screen.png");
            }
            UiDocument.Sheet sheet = null;
            if (o.has("sheet")) {
                JsonObject so = object(o.get("sheet"), "sheet");
                if (so != null) {
                    unknownKeys(so, Set.of("texture", "width", "height"), "sheet");
                    String texture = reqStr(so, "texture", "sheet");
                    if (texture != null && !RESOURCE.matcher(texture).matches()) {
                        problem("sheet.texture", "expected a texture id like mymod:textures/gui/screen.png");
                    } else if (texture != null && !texture.endsWith(".png")) {
                        problem("sheet.texture", "the emitter writes a PNG, so the id must end in .png");
                    }
                    sheet = new UiDocument.Sheet(texture == null ? "" : texture,
                        optInt(so, "width", Math.max(1, width), "sheet"),
                        optInt(so, "height", Math.max(1, height), "sheet"));
                }
            }

            List<Container> containers = new ArrayList<>();
            Set<String> containerNames = new HashSet<>();
            if (o.has("containers")) {
                JsonArray arr = array(o.get("containers"), "containers");
                for (int i = 0; arr != null && i < arr.size(); i++) {
                    String p = "containers[" + i + "]";
                    JsonObject co = object(arr.get(i), p);
                    if (co == null) {
                        continue;
                    }
                    unknownKeys(co, Set.of("name", "size"), p);
                    String name = reqName(co, "name", p);
                    int size = reqInt(co, "size", p, 1);
                    if (name == null) {
                        continue;
                    }
                    if (UiDocument.PLAYER_CONTAINER.equals(name)) {
                        problem(p + ".name", "'player' is reserved for the player's inventory and is always available");
                    } else if (!containerNames.add(name)) {
                        problem(p + ".name", "duplicate container '" + name + "'");
                    }
                    containers.add(new Container(name, size));
                }
            }

            List<UiDocument.Action> actions = new ArrayList<>();
            Set<String> actionNames = new HashSet<>();
            if (o.has("actions")) {
                JsonArray arr = array(o.get("actions"), "actions");
                for (int i = 0; arr != null && i < arr.size(); i++) {
                    UiDocument.Action a = action(arr.get(i), "actions[" + i + "]");
                    if (a == null) {
                        continue;
                    }
                    if (!actionNames.add(a.name())) {
                        problem("actions[" + i + "]", "duplicate action '" + a.name() + "'");
                    }
                    actions.add(a);
                }
            }

            List<Binding> bindings = new ArrayList<>();
            Set<String> bindingNames = new HashSet<>();
            if (o.has("bindings")) {
                JsonArray arr = array(o.get("bindings"), "bindings");
                for (int i = 0; arr != null && i < arr.size(); i++) {
                    String p = "bindings[" + i + "]";
                    JsonObject bo = object(arr.get(i), p);
                    if (bo == null) {
                        continue;
                    }
                    unknownKeys(bo, Set.of("name", "max", "wide", "preview"), p);
                    String name = reqName(bo, "name", p);
                    if (name == null) {
                        continue;
                    }
                    if (!bindingNames.add(name)) {
                        problem(p + ".name", "duplicate binding '" + name + "'");
                    }
                    Integer max = null;
                    String maxBinding = null;
                    if (bo.has("max")) {
                        JsonElement m = bo.get("max");
                        if (m.isJsonPrimitive() && m.getAsJsonPrimitive().isNumber()) {
                            max = m.getAsInt();
                            if (max < 1) {
                                problem(p + ".max", "must be at least 1");
                            }
                        } else if (m.isJsonPrimitive() && m.getAsJsonPrimitive().isString()) {
                            maxBinding = m.getAsString();
                            if (maxBinding.equals(name)) {
                                problem(p + ".max", "a binding cannot be its own max");
                            } else {
                                refs.add(new Ref(p + ".max", "binding", maxBinding, -1, 0));
                            }
                        } else {
                            problem(p + ".max", "expected a number or the name of another binding");
                        }
                    }
                    boolean wide = optBool(bo, "wide", false, p);
                    int preview = optInt(bo, "preview", 0, p);
                    bindings.add(new Binding(name, wide, preview, max, maxBinding));
                }
                // THE 16-BIT WIRE (section 8.2): ContainerData travels as shorts, so a binding that is
                // not `wide` silently wraps past 32767. The interpreter never crosses the wire and
                // shows such a value correctly, which is exactly why this has to be a lint and not a
                // thing you notice: the example document itself carried one until the generated
                // screen's gauge came up empty beside a 42% preview (slice 2, first live run).
                for (int i = 0; i < bindings.size(); i++) {
                    Binding b = bindings.get(i);
                    if (b.wide()) {
                        continue;
                    }
                    String p = "bindings[" + i + "]";
                    if (b.preview() > Short.MAX_VALUE || b.preview() < Short.MIN_VALUE) {
                        problem(p + ".preview", "binding '" + b.name() + "' previews " + b.preview() + ", which does not fit"
                            + " the 16-bit wire (ContainerData is sent as shorts); declare \"wide\": true");
                    }
                    if (b.max() != null && b.max() > Short.MAX_VALUE) {
                        problem(p + ".max", "binding '" + b.name() + "' can reach " + b.max() + ", which does not fit the"
                            + " 16-bit wire; declare \"wide\": true");
                    }
                    if (b.maxBinding() != null) {
                        for (Binding other : bindings) {
                            if (other.name().equals(b.maxBinding()) && other.wide()) {
                                problem(p + ".max", "binding '" + b.name() + "' can reach '" + other.name() + "', which is"
                                    + " wide, so it can exceed the 16-bit wire too; declare \"wide\": true");
                            }
                        }
                    }
                }
            }

            List<Element> elements = new ArrayList<>();
            if (o.has("elements")) {
                JsonArray arr = array(o.get("elements"), "elements");
                for (int i = 0; arr != null && i < arr.size(); i++) {
                    Element e = element(arr.get(i), "elements[" + i + "]", null);
                    if (e != null) {
                        elements.add(e);
                    }
                }
            } else {
                problem("elements", "missing (a screen with nothing on it still declares an empty list)");
            }

            UiDocument doc = new UiDocument(title == null ? Text.literal("") : title, Math.max(1, width),
                Math.max(1, height), titleX, titleY, inv, background, sheet, containers, actions, bindings,
                elements);
            checkRefs(doc);
            checkJavaNames(doc);
            return doc;
        }

        /**
         * One declared action: a bare name, or a name with an ARITY (section 4.2).
         *
         * <pre>{@code "apply"                                    one id
         * {"name": "select", "args": [4]}            four
         * {"name": "select_fitting", "args": [5, 3]} fifteen, row-major}</pre>
         */
        UiDocument.Action action(final JsonElement je, final String p) {
            if (je != null && je.isJsonPrimitive() && je.getAsJsonPrimitive().isString()) {
                String name = name(je, p);
                return name == null ? null : UiDocument.Action.of(name);
            }
            JsonObject o = object(je, p);
            if (o == null) {
                return null;
            }
            unknownKeys(o, Set.of("name", "args"), p);
            String name = reqName(o, "name", p);
            List<UiDocument.Arg> args = new ArrayList<>();
            Set<String> argNames = new HashSet<>();
            if (o.has("args")) {
                JsonArray arr = array(o.get("args"), p + ".args");
                for (int i = 0; arr != null && i < arr.size(); i++) {
                    String ap = p + ".args[" + i + "]";
                    JsonElement ae = arr.get(i);
                    String argName = UiDocument.Arg.defaultName(i);
                    int size;
                    if (ae.isJsonObject()) {
                        JsonObject ao = ae.getAsJsonObject();
                        unknownKeys(ao, Set.of("name", "size"), ap);
                        String given = reqName(ao, "name", ap);
                        if (given != null) {
                            argName = given;
                        }
                        size = reqInt(ao, "size", ap, 1);
                    } else {
                        size = checkedInt(ae, ap, 1);
                    }
                    if (!argNames.add(argName)) {
                        problem(ap + ".name", "duplicate argument name '" + argName + "'");
                    }
                    args.add(new UiDocument.Arg(argName, Math.max(1, size)));
                }
                if (arr != null && arr.isEmpty()) {
                    problem(p + ".args", "an empty arity is a plain action; write the name on its own");
                }
            }
            return name == null ? null : new UiDocument.Action(name, args);
        }

        /**
         * Two ids that become ONE Java name.
         *
         * <p>Expansion namespaces ids with dots and generated code turns a dot into an underscore, so
         * a part instance {@code a} holding {@code b} and a hand-written {@code a_b} would both emit
         * {@code drawRegion_a_b}. It is rare and it is a compile error in the CONSUMER's tree, which
         * is the worst place to find it, so it is a refusal here.
         */
        void checkJavaNames(final UiDocument doc) {
            Map<String, String> byJava = new HashMap<>();
            for (Element e : doc.flatten()) {
                if (e.id() == null) {
                    continue;
                }
                String java = e.id().replace('.', '_');
                String other = byJava.put(java, e.id());
                if (other != null && !other.equals(e.id())) {
                    problem("elements", "ids '" + other + "' and '" + e.id() + "' both become the Java name '"
                        + java + "' (generated hooks and fields are named after the id, and expansion writes"
                        + " a dot where Java needs an underscore); rename one of them");
                }
            }
        }

        /** Every reference an element made, against the declarations, plus slot-index overlap. */
        void checkRefs(final UiDocument doc) {
            Map<String, Set<Integer>> used = new HashMap<>();
            for (Ref r : refs) {
                switch (r.what()) {
                    case "action" -> {
                        if (doc.action(r.name()) == null) {
                            problem(r.path(), "undeclared action '" + r.name() + "'; declared: "
                                + actionNames(doc.actions()));
                        }
                    }
                    case "binding" -> {
                        Binding b = doc.binding(r.name());
                        if (b == null) {
                            problem(r.path(), "undeclared binding '" + r.name() + "'; declared: " + names(doc.bindings()));
                        }
                    }
                    case "bar" -> {
                        Binding b = doc.binding(r.name());
                        if (b == null) {
                            problem(r.path(), "undeclared binding '" + r.name() + "'; declared: " + names(doc.bindings()));
                        } else if (!b.hasMax()) {
                            problem(r.path(), "binding '" + r.name() + "' declares no max, so a bar cannot fill by it");
                        }
                    }
                    case "container" -> {
                        int size = doc.containerSize(r.name());
                        if (size < 0) {
                            List<String> have = new ArrayList<>();
                            for (Container c : doc.containers()) {
                                have.add(c.name());
                            }
                            have.add(UiDocument.PLAYER_CONTAINER);
                            problem(r.path(), "undeclared container '" + r.name() + "'; declared: " + have);
                        } else if (r.index() + r.count() > size) {
                            problem(r.path(), "slots " + r.index() + ".." + (r.index() + r.count() - 1)
                                + " exceed container '" + r.name() + "' (size " + size + ")");
                        } else {
                            Set<Integer> s = used.computeIfAbsent(r.name(), k -> new HashSet<>());
                            for (int i = r.index(); i < r.index() + r.count(); i++) {
                                if (!s.add(i)) {
                                    problem(r.path(), "slot " + i + " of container '" + r.name()
                                        + "' is declared twice; a menu cannot hold one index in two places");
                                }
                            }
                        }
                    }
                    default -> throw new IllegalStateException(r.what());
                }
            }
            for (ActionUse u : actionUses) {
                UiDocument.Action a = doc.action(u.action());
                if (a == null) {
                    continue; // already reported as undeclared
                }
                if (u.values().size() != a.args().size()) {
                    problem(u.path(), "action '" + a.name() + "' takes " + a.args().size() + " argument(s) "
                        + a.sizes() + " and this button supplies " + u.values().size()
                        + "; declare them as \"args\": [...] on the button");
                    continue;
                }
                for (int i = 0; i < u.values().size(); i++) {
                    int v = u.values().get(i);
                    int bound = a.args().get(i).size();
                    if (v < 0 || v >= bound) {
                        problem(u.path() + ".args[" + i + "]", "argument " + i + " of '" + a.name() + "' is "
                            + v + ", outside the declared 0.." + (bound - 1)
                            + "; the id it would press belongs to another action");
                    }
                }
            }
            for (String[] ref : slotRefs) {
                Element target = doc.byId(ref[1]);
                if (target == null) {
                    problem(ref[0], "no element with id '" + ref[1] + "'");
                } else if (!(target instanceof Element.Slot)) {
                    problem(ref[0], "'" + ref[1] + "' is a " + target.kind().jsonName()
                        + "; equipment names a slot, because what the subject wears is what a slot holds");
                }
            }
        }

        private static List<String> actionNames(final List<UiDocument.Action> as) {
            List<String> out = new ArrayList<>();
            for (UiDocument.Action a : as) {
                out.add(a.parameterised() ? a.name() + a.sizes() : a.name());
            }
            return out;
        }

        private static List<String> names(final List<Binding> bs) {
            List<String> out = new ArrayList<>();
            for (Binding b : bs) {
                out.add(b.name());
            }
            return out;
        }

        // ---- elements -------------------------------------------------------------------------

        /** @param parent the enclosing layout kind, or {@code null} at the top level */
        Element element(final JsonElement je, final String p, final Kind parent) {
            JsonObject o = object(je, p);
            if (o == null) {
                return null;
            }
            String kindName = reqStr(o, "kind", p);
            if (kindName == null) {
                return null;
            }
            Kind kind = Kind.forName(kindName);
            if (kind == null) {
                problem(p + ".kind", "unknown kind '" + kindName + "'; registered kinds: " + Kind.names());
                return null;
            }
            boolean inLayout = parent != null;
            if (inLayout && !kind.allowedInLayout()) {
                problem(p, "a " + kind.jsonName() + " cannot sit inside a layout: slot geometry is shared with"
                    + " the menu (section 4.5) and a layout computes it too late, on one side only."
                    + " Declare it at the top level with x/y.");
                return null;
            }
            if (!inLayout && !kind.allowedAtTopLevel()) {
                problem(p, "a " + kind.jsonName() + " only means something inside a row, column, grid or stack");
                return null;
            }

            // A part's other keys are its ARGUMENTS, and only its part file knows their names, so
            // that check moves into part() where the parameter list is in hand.
            if (kind != Kind.PART) {
                Set<String> allowed = new HashSet<>(KIND_KEYS.get(kind));
                allowed.add("kind");
                allowed.add("id");
                allowed.addAll(inLayout ? CELL_KEYS : ABS_KEYS);
                unknownKeys(o, allowed, p);
            }
            // Placement keys of the OTHER mode are the classic silent no-op; refuse them by name.
            for (String k : inLayout ? ABS_KEYS : CELL_KEYS) {
                if (o.has(k)) {
                    problem(p + "." + k, inLayout
                        ? "ignored inside a layout; the layout places this element - use offset for a nudge"
                        : "only applies inside a layout node; a top-level element is placed by x/y");
                }
            }

            String id = null;
            if (o.has("id")) {
                id = elementId(o.get("id"), p + ".id");
                if (id != null) {
                    String prev = idPaths.put(id, p);
                    if (prev != null) {
                        problem(p + ".id", "duplicate id '" + id + "' (also at " + prev + ")");
                    }
                }
            }
            if (kind == Kind.REGION && id == null) {
                problem(p + ".id", "a region must be named: the drawRegion_<id> hook is named after it");
            }
            if (kind.isMacro() && id == null) {
                problem(p + ".id", "a " + kind.jsonName() + " must be named: everything it expands to is named"
                    + " after it (<instance>.<inner>), which is what lets the same " + kind.jsonName()
                    + " be used twice without its ids colliding");
            }
            if (kind == Kind.SPACER && id != null) {
                problem(p + ".id", "a spacer is not a widget and cannot be named");
            }

            Placement placement = inLayout ? cell(o, p, parent == Kind.GRID)
                : kind.isMacro() ? macroOrigin(o, p) : absolute(o, p);
            Element.Decoration deco = kind.decorated() ? decoration(o, p, kind) : Element.Decoration.NONE;

            return switch (kind.family()) {
                case BOX -> new Element.Box(kind, id, placement, reqInt(o, "w", p, 1), reqInt(o, "h", p, 1), deco);
                case SLOT -> slot(o, p, kind, id, (Placement.Absolute) placement);
                case LAYOUT -> layout(o, p, kind, id, placement);
                case MACRO -> macro(o, p, kind, id, (Placement.Absolute) placement);
                case SPACER -> {
                    int w = optInt(o, "w", 0, p);
                    int h = optInt(o, "h", 0, p);
                    if (w <= 0 && h <= 0) {
                        problem(p, "a spacer needs a w or an h");
                    }
                    yield new Element.Spacer(placement, Math.max(0, w), Math.max(0, h));
                }
                case LEAF -> leaf(o, p, kind, id, placement, deco);
            };
        }

        /**
         * An id as written. A dot is the expansion's namespacing and nothing a human may type - see
         * {@link #ID} and {@link #expanding}.
         */
        String elementId(final JsonElement je, final String path) {
            if (!je.isJsonPrimitive() || !je.getAsJsonPrimitive().isString()) {
                problem(path, "expected a name");
                return null;
            }
            String v = je.getAsString();
            if (expanding > 0 && ID.matcher(v).matches()) {
                return v;
            }
            if (expanding == 0 && v.indexOf('.') >= 0) {
                problem(path, "'" + v + "' contains a dot, which only a part or repeat may put in an id"
                    + " (it namespaces what it expands to)");
                return null;
            }
            return name(je, path);
        }

        /** A macro's origin: optional, because its children carry their own coordinates around it. */
        Placement.Absolute macroOrigin(final JsonObject o, final String p) {
            return new Placement.Absolute(optInt(o, "x", 0, p), optInt(o, "y", 0, p));
        }

        // ---- the leaf decorations ---------------------------------------------------------------

        /** {@code tooltip}, {@code visible} and (buttons only) {@code enabled}. */
        Element.Decoration decoration(final JsonObject o, final String p, final Kind kind) {
            Element.Tooltip tooltip = null;
            if (o.has("tooltip")) {
                tooltip = tooltip(o.get("tooltip"), p + ".tooltip");
            }
            Element.Predicate visible = o.has("visible") ? predicate(o.get("visible"), p + ".visible") : null;
            Element.Predicate enabled = null;
            if (o.has("enabled")) {
                if (kind != Kind.BUTTON) {
                    problem(p + ".enabled", "only a button can be enabled or not; everything else is drawn"
                        + " or hidden, which is 'visible'");
                } else {
                    enabled = predicate(o.get("enabled"), p + ".enabled");
                }
            }
            return tooltip == null && visible == null && enabled == null
                ? Element.Decoration.NONE : new Element.Decoration(tooltip, visible, enabled);
        }

        Element.Tooltip tooltip(final JsonElement e, final String p) {
            if (e.isJsonObject() && e.getAsJsonObject().has("hook")) {
                JsonObject o = e.getAsJsonObject();
                unknownKeys(o, Set.of("hook"), p);
                String hook = reqName(o, "hook", p);
                return hook == null ? null : Element.Tooltip.hook(hook);
            }
            JsonObject holder = new JsonObject();
            holder.add("text", e);
            Text t = reqText(holder, "text", p.substring(0, Math.max(0, p.length() - ".tooltip".length())));
            return t == null ? null : Element.Tooltip.of(t);
        }

        /**
         * {@code "can_apply"} is {@code != 0}; {@code {"binding": "selected", "ne": 0}} names a
         * comparator. Exactly one comparator, because two would be a conjunction and a conjunction is
         * the first step of the expression language section 5.3 refuses.
         */
        Element.Predicate predicate(final JsonElement e, final String p) {
            if (e.isJsonPrimitive() && e.getAsJsonPrimitive().isString()) {
                String binding = name(e, p);
                if (binding == null) {
                    return null;
                }
                refs.add(new Ref(p, "binding", binding, -1, 0));
                return new Element.Predicate(binding, Element.Cmp.NE, 0);
            }
            JsonObject o = object(e, p);
            if (o == null) {
                return null;
            }
            Set<String> allowed = new HashSet<>(Set.of("binding"));
            for (Element.Cmp c : Element.Cmp.values()) {
                allowed.add(c.jsonName());
            }
            unknownKeys(o, allowed, p);
            String binding = reqName(o, "binding", p);
            Element.Cmp cmp = null;
            int value = 0;
            for (Element.Cmp c : Element.Cmp.values()) {
                if (!o.has(c.jsonName())) {
                    continue;
                }
                if (cmp != null) {
                    problem(p, "two comparators (" + cmp.jsonName() + " and " + c.jsonName()
                        + "); a predicate compares one binding once");
                    break;
                }
                cmp = c;
                value = checkedInt(o.get(c.jsonName()), p + "." + c.jsonName(), Integer.MIN_VALUE);
            }
            if (cmp == null) {
                problem(p, "no comparator; one of " + new TreeSet<>(cmpNames()) + " (a bare binding name"
                    + " is the != 0 case)");
                cmp = Element.Cmp.NE;
            }
            if (binding == null) {
                return null;
            }
            refs.add(new Ref(p + ".binding", "binding", binding, -1, 0));
            return new Element.Predicate(binding, cmp, value);
        }

        private static List<String> cmpNames() {
            List<String> out = new ArrayList<>();
            for (Element.Cmp c : Element.Cmp.values()) {
                out.add(c.jsonName());
            }
            return out;
        }

        Element leaf(final JsonObject o, final String p, final Kind kind, final String id, final Placement pl,
                     final Element.Decoration deco) {
            return switch (kind) {
                case LABEL -> {
                    Text text = reqText(o, "text", p);
                    Element.LabelMode mode = Element.LabelMode.PLAIN;
                    String modeName = optStr(o, "mode", null, p);
                    if (modeName != null) {
                        mode = Element.LabelMode.forName(modeName);
                        if (mode == null) {
                            problem(p + ".mode", "unknown mode '" + modeName + "'; one of plain, wrapped, scrolling, truncated");
                            mode = Element.LabelMode.PLAIN;
                        }
                    }
                    int w = optInt(o, "w", 0, p);
                    int h = optInt(o, "h", 0, p);
                    if (mode != Element.LabelMode.PLAIN && w <= 0) {
                        problem(p + ".w", "a " + mode.jsonName() + " label needs a width to " + mode.jsonName() + " within");
                    }
                    int color = optColor(o, "color", Palette.LABEL_COLOR, p);
                    boolean shadow = optBool(o, "shadow", false, p);
                    yield new Element.Label(id, pl, w, h, text == null ? Text.literal("") : text, mode, color,
                        shadow, deco);
                }
                case BUTTON -> {
                    Text text = reqText(o, "text", p);
                    String action = reqName(o, "action", p);
                    List<Integer> args = new ArrayList<>();
                    if (o.has("args")) {
                        JsonArray arr = array(o.get("args"), p + ".args");
                        for (int i = 0; arr != null && i < arr.size(); i++) {
                            args.add(checkedInt(arr.get(i), p + ".args[" + i + "]", 0));
                        }
                    }
                    if (action != null) {
                        // The arity is checked in the reference post-pass, where the declarations are
                        // known: an index outside the declared block is a click that would land on
                        // ANOTHER action's id, silently, on the server (section 4.2).
                        refs.add(new Ref(p + ".action", "action", action, -1, 0));
                        actionUses.add(new ActionUse(p, action, List.copyOf(args)));
                    }
                    String sprite = optStr(o, "sprite", null, p);
                    if (sprite != null && !RESOURCE.matcher(sprite).matches()) {
                        problem(p + ".sprite", "expected a sprite id like minecraft:icon/checkmark");
                    }
                    String hovered = optStr(o, "sprite_hovered", null, p);
                    if (hovered != null && !RESOURCE.matcher(hovered).matches()) {
                        problem(p + ".sprite_hovered", "expected a sprite id like minecraft:icon/checkmark");
                    }
                    Element.Face face = Element.Face.VANILLA;
                    String faceName = optStr(o, "face", null, p);
                    if (faceName != null) {
                        face = Element.Face.forName(faceName);
                        if (face == null) {
                            problem(p + ".face", "unknown face '" + faceName + "'; one of vanilla, none");
                            face = Element.Face.VANILLA;
                        }
                    }
                    if (hovered != null && sprite == null) {
                        problem(p + ".sprite_hovered", "a hover sprite with no sprite to replace");
                    }
                    if (face == Element.Face.NONE && sprite == null) {
                        problem(p + ".face", "a button with no face and no sprite is an invisible button;"
                            + " give it a sprite, or leave the vanilla face on");
                    }
                    yield new Element.Button(id, pl, reqInt(o, "w", p, 1), optInt(o, "h", 20, p),
                        text == null ? Text.literal("") : text, action == null ? "" : action, args, sprite,
                        hovered, face, deco);
                }
                case BAR -> {
                    String binding = reqName(o, "binding", p);
                    if (binding != null) {
                        refs.add(new Ref(p + ".binding", "bar", binding, -1, 0));
                    }
                    boolean vertical = false;
                    String orientation = optStr(o, "orientation", null, p);
                    if (orientation != null) {
                        if ("vertical".equals(orientation)) {
                            vertical = true;
                        } else if (!"horizontal".equals(orientation)) {
                            problem(p + ".orientation", "expected horizontal or vertical");
                        }
                    }
                    yield new Element.Bar(id, pl, reqInt(o, "w", p, 3), reqInt(o, "h", p, 3),
                        binding == null ? "" : binding, vertical,
                        optColor(o, "fill", Palette.BAR_FILL, p), optColor(o, "track", Palette.BAR_TRACK, p), deco);
                }
                case ITEM -> {
                    String item = reqStr(o, "item", p);
                    if (item != null && !RESOURCE.matcher(item).matches()) {
                        problem(p + ".item", "expected an item id like minecraft:diamond");
                    }
                    int count = optInt(o, "count", 1, p);
                    if (count < 1) {
                        problem(p + ".count", "must be at least 1");
                    }
                    yield new Element.Item(id, pl, item == null ? "" : item, Math.max(1, count),
                        optBool(o, "decorated", true, p), deco);
                }
                case ICON -> {
                    int w = reqInt(o, "w", p, 1);
                    int h = reqInt(o, "h", p, 1);
                    String sprite = optStr(o, "sprite", null, p);
                    String texture = optStr(o, "texture", null, p);
                    if ((sprite == null) == (texture == null)) {
                        problem(p, "name ONE source: 'sprite' (a GUI-atlas sprite) or 'texture'"
                            + " (a window into a PNG, with u/v and src_w/src_h)");
                    }
                    if (sprite != null && !RESOURCE.matcher(sprite).matches()) {
                        problem(p + ".sprite", "expected a sprite id like minecraft:icon/checkmark");
                    }
                    Element.Sheet sheet = null;
                    if (texture != null) {
                        if (!RESOURCE.matcher(texture).matches()) {
                            problem(p + ".texture", "expected a texture id like mymod:textures/gui/icons.png");
                        }
                        sheet = new Element.Sheet(texture, optInt(o, "u", 0, p), optInt(o, "v", 0, p),
                            optInt(o, "src_w", w, p), optInt(o, "src_h", h, p),
                            optInt(o, "sheet_w", Element.Sheet.DEFAULT_SHEET, p),
                            optInt(o, "sheet_h", Element.Sheet.DEFAULT_SHEET, p));
                    } else {
                        for (String k : List.of("u", "v", "src_w", "src_h", "sheet_w", "sheet_h")) {
                            if (o.has(k)) {
                                problem(p + "." + k, "only applies to a 'texture' icon; a GUI-atlas sprite is"
                                    + " addressed by name, not by pixel offset");
                            }
                        }
                    }
                    yield new Element.Icon(id, pl, w, h, sprite, sheet, optColor(o, "color", -1, p), deco);
                }
                case ENTITY -> {
                    String subjectName = reqStr(o, "subject", p);
                    List<String> equipment = new ArrayList<>();
                    if (o.has("equipment")) {
                        JsonArray arr = array(o.get("equipment"), p + ".equipment");
                        for (int i = 0; arr != null && i < arr.size(); i++) {
                            String slotId = name(arr.get(i), p + ".equipment[" + i + "]");
                            if (slotId != null) {
                                equipment.add(slotId);
                                slotRefs.add(new String[] {p + ".equipment[" + i + "]", slotId});
                            }
                        }
                    }
                    if (subjectName != null && !Element.Subject.PLAYER.equals(subjectName)
                        && !Element.Subject.ARMOR_STAND.equals(subjectName)
                        && !RESOURCE.matcher(subjectName).matches()) {
                        problem(p + ".subject", "expected 'player', 'armor_stand' or an entity type id"
                            + " like minecraft:zombie");
                    }
                    if (!equipment.isEmpty() && !Element.Subject.ARMOR_STAND.equals(subjectName)) {
                        problem(p + ".equipment", "only an armor_stand wears what a slot holds; '"
                            + subjectName + "' has no equipment to put on");
                    }
                    boolean follow = optBool(o, "follow_mouse", Element.Subject.PLAYER.equals(subjectName), p);
                    yield new Element.Entity(id, pl, reqInt(o, "w", p, 1), reqInt(o, "h", p, 1),
                        new Element.Subject(subjectName == null ? Element.Subject.PLAYER : subjectName, equipment),
                        (float) optDouble(o, "scale", 25.0, p), (float) optDouble(o, "pitch", 0.0, p),
                        (float) optDouble(o, "yaw", 0.0, p), follow, optBool(o, "draggable", false, p), deco);
                }
                case REGION -> new Element.Region(id, pl, reqInt(o, "w", p, 1), reqInt(o, "h", p, 1), deco);
                default -> throw new IllegalStateException("not a leaf kind: " + kind);
            };
        }

        Element slot(final JsonObject o, final String p, final Kind kind, final String id, final Placement.Absolute at) {
            String container = reqName(o, "container", p);
            Element.Placeholder ph = null;
            if (o.has("placeholder")) {
                ph = placeholder(o.get("placeholder"), p + ".placeholder");
            }
            // The empty-slot sprite: vanilla draws Slot.getNoItemIcon() for an empty ACTIVE slot
            // itself (AbstractContainerScreen), so this is a property of the menu's slot and not
            // anything either renderer paints - which is why it is here and not a decoration.
            String icon = optStr(o, "icon", null, p);
            if (icon != null && !RESOURCE.matcher(icon).matches()) {
                problem(p + ".icon", "expected a sprite id like minecraft:container/slot/helmet");
            }
            if (kind == Kind.SLOT) {
                int index = reqInt(o, "index", p, 0);
                if (container != null) {
                    refs.add(new Ref(p, "container", container, index, 1));
                }
                return new Element.Slot(id, at.x(), at.y(), container == null ? "" : container, index, ph, icon);
            }
            int cols = reqInt(o, "cols", p, 1);
            int rows = reqInt(o, "rows", p, 1);
            int first = optInt(o, "first", 0, p);
            if (first < 0) {
                problem(p + ".first", "must be at least 0");
            }
            if (container != null) {
                refs.add(new Ref(p, "container", container, Math.max(0, first), cols * rows));
            }
            return new Element.SlotGrid(id, at.x(), at.y(), cols, rows, container == null ? "" : container,
                Math.max(0, first), ph, icon);
        }

        // ---- macros: the parts library and repeat -----------------------------------------------

        Element macro(final JsonObject o, final String p, final Kind kind, final String id,
                      final Placement.Absolute at) {
            return kind == Kind.PART ? part(o, p, id, at) : repeat(o, p, id, at);
        }

        /**
         * <b>A part instance, expanded</b> (UI_PARTS_LIBRARY_DESIGN.md section 5).
         *
         * <p>Read the part file, check the arguments against its declared parameters, substitute,
         * namespace the ids, translate everything by the instance's origin, and parse the result as
         * ordinary elements. Nothing downstream learns a new word - the interpreter's exhaustive
         * switch, the emitter and the conformance battery all see the elements the part became.
         */
        Element part(final JsonObject o, final String p, final String id, final Placement.Absolute at) {
            String partId = reqStr(o, "part", p);
            if (partId == null) {
                return null;
            }
            if (!RESOURCE.matcher(partId).matches()) {
                problem(p + ".part", "expected a part id like mcptoolkit:player_inventory");
                return null;
            }
            if (partStack.contains(partId)) {
                problem(p + ".part", "part '" + partId + "' is already being expanded ("
                    + String.join(" -> ", partStack) + "); a part cannot contain itself");
                return null;
            }
            if (partStack.size() >= MAX_PART_DEPTH) {
                problem(p + ".part", "parts nested more than " + MAX_PART_DEPTH + " deep ("
                    + String.join(" -> ", partStack) + ")");
                return null;
            }
            PartFile file = loadPart(partId, p + ".part");
            if (file == null) {
                return null;
            }
            Set<String> allowed = new HashSet<>(Set.of("kind", "id", "x", "y", "part"));
            for (Element.PartParam prm : file.params()) {
                allowed.add(prm.name());
            }
            unknownKeys(o, allowed, p);

            Map<String, JsonElement> vars = new LinkedHashMap<>();
            Map<String, JsonElement> given = new LinkedHashMap<>();
            for (Element.PartParam prm : file.params()) {
                JsonElement value;
                if (o.has(prm.name())) {
                    value = o.get(prm.name());
                    checkParamValue(value, prm, p + "." + prm.name(), partId);
                    given.put(prm.name(), value);
                } else if (prm.required()) {
                    problem(p + "." + prm.name(), "part '" + partId + "' requires a " + prm.type()
                        + " argument '" + prm.name() + "'");
                    value = JsonNull.INSTANCE;
                } else {
                    value = prm.def() == null ? JsonNull.INSTANCE : prm.def();
                }
                vars.put(prm.name(), value);
            }

            partStack.push(partId);
            List<Element> children;
            try {
                children = expand(file.elements(), vars, id, at, p, partId);
            } finally {
                partStack.pop();
            }
            return new Element.Part(id, at.x(), at.y(), partId, file.params(), given, file.hash(), children);
        }

        /** {@code count} copies of one subtree, with {@code $i} substituted into it (section 4.1). */
        Element repeat(final JsonObject o, final String p, final String id, final Placement.Absolute at) {
            int count = reqInt(o, "count", p, 1);
            if (count > MAX_REPEAT) {
                problem(p + ".count", count + " copies is past the " + MAX_REPEAT + " a repeat allows;"
                    + " that is a typo, not a screen");
                count = MAX_REPEAT;
            }
            if (!o.has("children")) {
                problem(p + ".children", "missing (a repeat repeats a subtree, so it declares one)");
                return new Element.Repeat(id, at.x(), at.y(), Math.max(1, count), new JsonArray(), List.of());
            }
            JsonArray template = array(o.get("children"), p + ".children");
            if (template == null) {
                return null;
            }
            if (template.isEmpty()) {
                problem(p + ".children", "an empty repeat repeats nothing");
            }
            List<Element> children = new ArrayList<>();
            for (int i = 0; i < count; i++) {
                Map<String, JsonElement> vars = Map.of("i", new JsonPrimitive(i));
                children.addAll(expand(template, vars, id + "." + i, at, p, "repeat '" + id + "'"));
            }
            return new Element.Repeat(id, at.x(), at.y(), Math.max(1, count), template.deepCopy(), children);
        }

        /**
         * The shared half of both macros: substitute, namespace, translate, parse.
         *
         * @param prefix what every declared id inside is named after ({@code inputs}, {@code arrows.2})
         * @param origin the instance's position; the fragment is written around {@code (0,0)}
         */
        List<Element> expand(final JsonArray source, final Map<String, JsonElement> vars, final String prefix,
                             final Placement.Absolute origin, final String p, final String what) {
            JsonArray substituted = new JsonArray();
            for (int i = 0; i < source.size(); i++) {
                substituted.add(substitute(source.get(i), vars, p, what));
            }
            Set<String> localIds = new HashSet<>();
            for (JsonElement e : substituted) {
                collectIds(e, localIds);
            }
            for (JsonElement e : substituted) {
                namespaceIds(e, prefix, localIds);
            }
            List<Element> out = new ArrayList<>();
            expanding++;
            try {
                for (int i = 0; i < substituted.size(); i++) {
                    String cp = p + ".children[" + i + "]";
                    JsonElement je = substituted.get(i);
                    if (je.isJsonObject()) {
                        translate(je.getAsJsonObject(), origin, cp, what);
                    }
                    Element parsed = element(je, cp, null);
                    if (parsed != null) {
                        out.add(parsed);
                    }
                }
            } finally {
                expanding--;
            }
            return out;
        }

        /**
         * Move one expanded element to the instance's origin.
         *
         * <p>A fragment writes its coordinates around {@code (0,0)} - that is what makes it reusable -
         * and the instance says where. An element that declares no {@code x}/{@code y} is left alone
         * so the usual "missing" problem is still reported, except for a macro, whose origin is
         * optional everywhere.
         */
        void translate(final JsonObject o, final Placement.Absolute origin, final String p, final String what) {
            Kind kind = Kind.forName(o.has("kind") && o.get("kind").isJsonPrimitive()
                ? o.get("kind").getAsString() : "");
            boolean macro = kind != null && kind.isMacro();
            for (String axis : List.of("x", "y")) {
                int base = "x".equals(axis) ? origin.x() : origin.y();
                if (o.has(axis)) {
                    JsonElement v = o.get(axis);
                    if (v.isJsonPrimitive() && v.getAsJsonPrimitive().isNumber()) {
                        o.addProperty(axis, v.getAsInt() + base);
                    }
                } else if (macro) {
                    o.addProperty(axis, base);
                } else if (kind != null && kind.allowedAtTopLevel()) {
                    problem(p + "." + axis, "missing: every element of " + what + " is placed around the"
                        + " fragment's own origin, so it needs an x and a y");
                }
            }
        }

        /** Every {@code id} declared anywhere in one expanded subtree. */
        void collectIds(final JsonElement e, final Set<String> out) {
            if (e.isJsonArray()) {
                for (JsonElement c : e.getAsJsonArray()) {
                    collectIds(c, out);
                }
                return;
            }
            if (!e.isJsonObject()) {
                return;
            }
            JsonObject o = e.getAsJsonObject();
            if (o.has("id") && o.get("id").isJsonPrimitive() && o.get("id").getAsJsonPrimitive().isString()) {
                out.add(o.get("id").getAsString());
            }
            // A nested macro's children are ITS scope, named after ITS instance, so they are not part
            // of this one's - descending would namespace them twice (p.r.0.p.row).
            if (o.has("children") && !nestedMacro(o)) {
                collectIds(o.get("children"), out);
            }
        }

        /**
         * Section 5.2 rule 2, applied: {@code <instance>.<inner>} on every declared id, and on every
         * reference to one of them.
         *
         * <p>{@code equipment} is the one key whose values name other elements. It is listed here
         * rather than discovered, so a future key that does the same has exactly one place to be
         * added - and until it is added, a part that used it would break loudly on the id, not
         * silently on the reference.
         */
        void namespaceIds(final JsonElement e, final String prefix, final Set<String> localIds) {
            if (e.isJsonArray()) {
                for (JsonElement c : e.getAsJsonArray()) {
                    namespaceIds(c, prefix, localIds);
                }
                return;
            }
            if (!e.isJsonObject()) {
                return;
            }
            JsonObject o = e.getAsJsonObject();
            if (o.has("id") && o.get("id").isJsonPrimitive() && o.get("id").getAsJsonPrimitive().isString()) {
                o.addProperty("id", prefix + "." + o.get("id").getAsString());
            }
            if (o.has("equipment") && o.get("equipment").isJsonArray()) {
                JsonArray in = o.getAsJsonArray("equipment");
                JsonArray out = new JsonArray();
                for (JsonElement v : in) {
                    String name = v.isJsonPrimitive() && v.getAsJsonPrimitive().isString() ? v.getAsString() : null;
                    out.add(name != null && localIds.contains(name) ? new JsonPrimitive(prefix + "." + name) : v);
                }
                o.add("equipment", out);
            }
            if (o.has("children") && !nestedMacro(o)) {
                namespaceIds(o.get("children"), prefix, localIds);
            }
        }

        /** Is this element object a macro - i.e. does its {@code children} array belong to it? */
        private static boolean nestedMacro(final JsonObject o) {
            if (!o.has("kind") || !o.get("kind").isJsonPrimitive()) {
                return false;
            }
            Kind k = Kind.forName(o.get("kind").getAsString());
            return k != null && k.isMacro();
        }

        // ---- substitution -------------------------------------------------------------------------

        /**
         * {@code $name} in any value of a fragment, replaced by the argument.
         *
         * <p>Three forms, in this order: a string that is EXACTLY {@code "$name"} becomes the
         * argument's own JSON (so a part can take an object or a null); one that matches the affine
         * grammar ({@code "$i * 20 + 8"}) becomes a number; anything else has each {@code $name}
         * interpolated as text ({@code "row_$i"}), with {@code $$} for a literal dollar.
         *
         * <p>A JSON null - which is what an omitted optional argument is - REMOVES the key it landed
         * on, because "absent" is what {@code "default": null} means and a key present with a null
         * value is a different thing to every reader below.
         */
        JsonElement substitute(final JsonElement e, final Map<String, JsonElement> vars, final String p,
                               final String what) {
            if (e.isJsonObject()) {
                JsonObject out = new JsonObject();
                for (Map.Entry<String, JsonElement> en : e.getAsJsonObject().entrySet()) {
                    JsonElement v = substitute(en.getValue(), vars, p, what);
                    if (!v.isJsonNull()) {
                        out.add(en.getKey(), v);
                    }
                }
                return out;
            }
            if (e.isJsonArray()) {
                JsonArray out = new JsonArray();
                for (JsonElement c : e.getAsJsonArray()) {
                    out.add(substitute(c, vars, p, what));
                }
                return out;
            }
            if (!e.isJsonPrimitive() || !e.getAsJsonPrimitive().isString()) {
                return e;
            }
            String text = e.getAsString();
            if (text.indexOf('$') < 0) {
                return e;
            }
            if (text.length() > 1 && text.charAt(0) == '$' && NAME.matcher(text.substring(1)).matches()) {
                JsonElement v = lookup(text.substring(1), vars, p, what);
                return v == null ? e : v;
            }
            Matcher affine = AFFINE.matcher(text);
            if (affine.matches()) {
                JsonElement v = lookup(affine.group(1), vars, p, what);
                if (v == null) {
                    return e; // reserved for an inner macro, or already reported
                }
                if (!v.isJsonPrimitive() || !v.getAsJsonPrimitive().isNumber()) {
                    problem(p, "'" + text + "' does arithmetic on '" + affine.group(1) + "', which "
                        + what + " supplied as " + v);
                    return e;
                }
                long n = v.getAsLong();
                if (affine.group(2) != null) {
                    n *= Long.parseLong(affine.group(2));
                }
                if (affine.group(4) != null) {
                    n += ("-".equals(affine.group(3)) ? -1 : 1) * Long.parseLong(affine.group(4));
                }
                return new JsonPrimitive(n);
            }
            StringBuilder sb = new StringBuilder();
            Matcher m = VARIABLE.matcher(text);
            int at = 0;
            while (m.find()) {
                sb.append(text, at, m.start());
                if (m.group(1) == null) {
                    sb.append('$');
                } else {
                    JsonElement v = lookup(m.group(1), vars, p, what);
                    if (v == null) {
                        sb.append(m.group()); // reserved for an inner macro: put it back untouched
                    } else if (!v.isJsonNull()) {
                        sb.append(v.isJsonPrimitive() ? v.getAsString() : v.toString());
                    }
                }
                at = m.end();
            }
            sb.append(text.substring(at));
            return new JsonPrimitive(sb.toString());
        }

        /**
         * One {@code $name}.
         *
         * @return the value, or {@code null} when this pass must leave the reference alone - either
         *     because it is a {@link #LOOP_VARIABLES loop variable} an inner macro will bind, or
         *     because it is unknown and the problem has just been recorded
         */
        JsonElement lookup(final String name, final Map<String, JsonElement> vars, final String p,
                           final String what) {
            JsonElement v = vars.get(name);
            if (v != null) {
                return v;
            }
            if (!LOOP_VARIABLES.contains(name)) {
                problem(p, what + " uses $" + name + ", which it does not declare; it declares "
                    + new TreeSet<>(vars.keySet()));
            }
            return null;
        }

        // ---- part files ---------------------------------------------------------------------------

        /** Read and parse {@code assets/<ns>/ui/parts/<name>.part.json}; {@code null} when it is not usable. */
        PartFile loadPart(final String partId, final String p) {
            PartFile cached = partCache.get(partId);
            if (cached != null) {
                return cached;
            }
            int colon = partId.indexOf(':');
            String ns = partId.substring(0, colon);
            String name = partId.substring(colon + 1);
            String text;
            try {
                text = PartLibrary.current().read(ns, name);
            } catch (IOException e) {
                problem(p, "cannot read part '" + partId + "': " + e.getMessage());
                return null;
            }
            if (text == null) {
                problem(p, "no part '" + partId + "'; expected " + PartLibrary.pathOf(ns, name)
                    + ", looked in " + PartLibrary.current().describe(ns, name));
                return null;
            }
            JsonObject root;
            try {
                JsonElement je = JsonParser.parseString(text);
                if (!je.isJsonObject()) {
                    problem(p, "part '" + partId + "' is not a JSON object");
                    return null;
                }
                root = je.getAsJsonObject();
            } catch (JsonSyntaxException e) {
                problem(p, "part '" + partId + "' is not JSON: " + e.getMessage());
                return null;
            }
            String pp = "part " + partId;
            unknownKeys(root, PART_FILE_KEYS, pp);
            int format = optInt(root, "format", -1, pp);
            if (format != UiDocument.FORMAT) {
                problem(pp + ".format", "expected " + UiDocument.FORMAT + ", got "
                    + (format < 0 ? "nothing" : format));
            }
            List<Element.PartParam> params = new ArrayList<>();
            Set<String> paramNames = new HashSet<>();
            if (root.has("params")) {
                JsonArray arr = array(root.get("params"), pp + ".params");
                for (int i = 0; arr != null && i < arr.size(); i++) {
                    String path = pp + ".params[" + i + "]";
                    JsonObject po = object(arr.get(i), path);
                    if (po == null) {
                        continue;
                    }
                    unknownKeys(po, PARAM_KEYS, path);
                    String pname = reqName(po, "name", path);
                    String type = optStr(po, "type", "any", path);
                    if (!PARAM_TYPES.contains(type)) {
                        problem(path + ".type", "unknown parameter type '" + type + "'; one of "
                            + new TreeSet<>(PART_TYPE_NAMES));
                        type = "any";
                    }
                    if (pname == null) {
                        continue;
                    }
                    if (!paramNames.add(pname)) {
                        problem(path + ".name", "duplicate parameter '" + pname + "'");
                    }
                    boolean required = !po.has("default");
                    params.add(new Element.PartParam(pname, type, required ? null : po.get("default"), required));
                }
            }
            JsonArray elements = root.has("elements") ? array(root.get("elements"), pp + ".elements") : null;
            if (elements == null) {
                problem(pp + ".elements", "missing (a part is a fragment, so it declares one)");
                return null;
            }
            PartFile file = new PartFile(ns, name, params, elements, hash(text));
            partCache.put(partId, file);
            return file;
        }

        /** An argument against the type its parameter declared (section 5.2 rule 3). */
        void checkParamValue(final JsonElement v, final Element.PartParam prm, final String p,
                             final String partId) {
            String why = switch (prm.type()) {
                case "int" -> v.isJsonPrimitive() && v.getAsJsonPrimitive().isNumber()
                    && v.getAsDouble() == Math.rint(v.getAsDouble()) ? null : "a whole number";
                case "number" -> v.isJsonPrimitive() && v.getAsJsonPrimitive().isNumber() ? null : "a number";
                case "bool" -> v.isJsonPrimitive() && v.getAsJsonPrimitive().isBoolean() ? null : "true or false";
                case "string" -> v.isJsonPrimitive() && v.getAsJsonPrimitive().isString() ? null : "a string";
                case "name", "container", "action", "binding" -> v.isJsonPrimitive()
                    && v.getAsJsonPrimitive().isString() && NAME.matcher(v.getAsString()).matches()
                    ? null : "a name (lower-case letters, digits and _)";
                case "sprite", "item", "texture" -> v.isJsonPrimitive() && v.getAsJsonPrimitive().isString()
                    && RESOURCE.matcher(v.getAsString()).matches() ? null : "a resource id like namespace:path";
                case "color" -> colorOk(v) ? null : "a colour like #FFAA5500";
                case "text" -> v.isJsonPrimitive() && v.getAsJsonPrimitive().isString()
                    || v.isJsonObject() && v.getAsJsonObject().has("translate")
                    ? null : "a string or {\"translate\": \"key\"}";
                default -> null;
            };
            if (why != null) {
                problem(p, "part '" + partId + "' declares '" + prm.name() + "' as " + prm.type()
                    + ", so it wants " + why + "; got " + v);
            }
        }

        private static boolean colorOk(final JsonElement v) {
            if (!v.isJsonPrimitive() || !v.getAsJsonPrimitive().isString()) {
                return false;
            }
            try {
                Colors.parse(v.getAsString());
                return true;
            } catch (IllegalArgumentException e) {
                return false;
            }
        }

        Element layout(final JsonObject o, final String p, final Kind kind, final String id, final Placement pl) {
            int spacing = optInt(o, "spacing", 0, p);
            if (spacing < 0) {
                problem(p + ".spacing", "must be at least 0");
            }
            List<Element> children = new ArrayList<>();
            if (!o.has("children")) {
                problem(p + ".children", "missing (a layout with nothing in it still declares an empty list)");
            } else {
                JsonArray arr = array(o.get("children"), p + ".children");
                for (int i = 0; arr != null && i < arr.size(); i++) {
                    Element e = element(arr.get(i), p + ".children[" + i + "]", kind);
                    if (e != null) {
                        children.add(e);
                    }
                }
            }
            return new Element.Layout(kind, id, pl, Math.max(0, spacing), children);
        }

        Placement.Absolute absolute(final JsonObject o, final String p) {
            return new Placement.Absolute(reqInt(o, "x", p, Integer.MIN_VALUE), reqInt(o, "y", p, Integer.MIN_VALUE));
        }

        Placement.Cell cell(final JsonObject o, final String p, final boolean inGrid) {
            int dx = 0;
            int dy = 0;
            if (o.has("offset")) {
                int[] off = point(o.get("offset"), p + ".offset");
                if (off != null) {
                    dx = off[0];
                    dy = off[1];
                }
            }
            Element.Padding padding = Element.Padding.NONE;
            if (o.has("padding")) {
                JsonElement pe = o.get("padding");
                if (pe.isJsonPrimitive() && pe.getAsJsonPrimitive().isNumber()) {
                    int v = pe.getAsInt();
                    padding = new Element.Padding(v, v, v, v);
                } else if (pe.isJsonArray() && pe.getAsJsonArray().size() == 4) {
                    JsonArray a = pe.getAsJsonArray();
                    padding = new Element.Padding(a.get(0).getAsInt(), a.get(1).getAsInt(), a.get(2).getAsInt(), a.get(3).getAsInt());
                } else {
                    problem(p + ".padding", "expected a number or [left, top, right, bottom]");
                }
            }
            float ax = 0.0F;
            float ay = 0.0F;
            if (o.has("align")) {
                JsonElement ae = o.get("align");
                if (ae.isJsonArray() && ae.getAsJsonArray().size() == 2) {
                    ax = ae.getAsJsonArray().get(0).getAsFloat();
                    ay = ae.getAsJsonArray().get(1).getAsFloat();
                    if (ax < 0 || ax > 1 || ay < 0 || ay > 1) {
                        problem(p + ".align", "each of [x, y] is 0..1 (0 = start, 0.5 = centre, 1 = end)");
                    }
                } else {
                    problem(p + ".align", "expected [x, y] with each 0..1");
                }
            }
            int row = -1;
            int col = -1;
            int rowSpan = 1;
            int colSpan = 1;
            if (inGrid) {
                row = reqInt(o, "row", p, 0);
                col = reqInt(o, "col", p, 0);
                rowSpan = optInt(o, "row_span", 1, p);
                colSpan = optInt(o, "col_span", 1, p);
                if (rowSpan < 1 || colSpan < 1) {
                    problem(p, "row_span and col_span are at least 1");
                }
            } else {
                for (String k : List.of("row", "col", "row_span", "col_span")) {
                    if (o.has(k)) {
                        problem(p + "." + k, "only applies to a child of a grid");
                    }
                }
            }
            return new Placement.Cell(dx, dy, padding, ax, ay, row, col, Math.max(1, rowSpan), Math.max(1, colSpan));
        }

        Element.Placeholder placeholder(final JsonElement e, final String p) {
            if (e.isJsonPrimitive() && e.getAsJsonPrimitive().isString()) {
                String item = e.getAsString();
                if (!RESOURCE.matcher(item).matches()) {
                    problem(p, "expected an item id like minecraft:coal");
                }
                return new Element.Placeholder(item, 1);
            }
            JsonObject o = object(e, p);
            if (o == null) {
                return null;
            }
            unknownKeys(o, Set.of("item", "count"), p);
            String item = reqStr(o, "item", p);
            if (item != null && !RESOURCE.matcher(item).matches()) {
                problem(p + ".item", "expected an item id like minecraft:coal");
            }
            int count = optInt(o, "count", 1, p);
            if (count < 1) {
                problem(p + ".count", "must be at least 1");
            }
            return new Element.Placeholder(item == null ? "" : item, Math.max(1, count));
        }

        // ---- primitives -----------------------------------------------------------------------

        void unknownKeys(final JsonObject o, final Set<String> allowed, final String p) {
            for (String k : o.keySet()) {
                if (!allowed.contains(k)) {
                    List<String> sorted = new ArrayList<>(allowed);
                    Collections.sort(sorted);
                    problem(p.isEmpty() ? k : p + "." + k, "unknown key; allowed here: " + sorted);
                }
            }
        }

        JsonObject object(final JsonElement e, final String p) {
            if (e == null || !e.isJsonObject()) {
                problem(p, "expected an object");
                return null;
            }
            return e.getAsJsonObject();
        }

        JsonArray array(final JsonElement e, final String p) {
            if (e == null || !e.isJsonArray()) {
                problem(p, "expected an array");
                return null;
            }
            return e.getAsJsonArray();
        }

        int[] point(final JsonElement e, final String p) {
            if (e.isJsonArray() && e.getAsJsonArray().size() == 2
                && e.getAsJsonArray().get(0).isJsonPrimitive() && e.getAsJsonArray().get(1).isJsonPrimitive()) {
                try {
                    return new int[] {e.getAsJsonArray().get(0).getAsInt(), e.getAsJsonArray().get(1).getAsInt()};
                } catch (NumberFormatException | UnsupportedOperationException ignored) {
                    // fall through
                }
            }
            problem(p, "expected [x, y]");
            return null;
        }

        /** A required int with a floor; a missing or bad value is a problem and answers the floor. */
        int reqInt(final JsonObject o, final String k, final String p, final int min) {
            if (!o.has(k)) {
                problem(p.isEmpty() ? k : p + "." + k, "missing");
                return Math.max(min, 0);
            }
            return checkedInt(o.get(k), p.isEmpty() ? k : p + "." + k, min);
        }

        double optDouble(final JsonObject o, final String k, final double def, final String p) {
            if (!o.has(k)) {
                return def;
            }
            JsonElement e = o.get(k);
            if (!e.isJsonPrimitive() || !e.getAsJsonPrimitive().isNumber()) {
                problem(p.isEmpty() ? k : p + "." + k, "expected a number");
                return def;
            }
            return e.getAsDouble();
        }

        int optInt(final JsonObject o, final String k, final int def, final String p) {
            if (!o.has(k)) {
                return def;
            }
            return checkedInt(o.get(k), p.isEmpty() ? k : p + "." + k, Integer.MIN_VALUE);
        }

        int checkedInt(final JsonElement e, final String path, final int min) {
            if (!e.isJsonPrimitive() || !e.getAsJsonPrimitive().isNumber()) {
                problem(path, "expected an integer");
                return Math.max(min, 0);
            }
            double d = e.getAsDouble();
            if (d != Math.rint(d)) {
                problem(path, "expected an integer, got " + d);
            }
            int v = (int) d;
            if (v < min && min != Integer.MIN_VALUE) {
                problem(path, "must be at least " + min + ", got " + v);
                return min;
            }
            return v;
        }

        String reqStr(final JsonObject o, final String k, final String p) {
            String path = p.isEmpty() ? k : p + "." + k;
            if (!o.has(k)) {
                problem(path, "missing");
                return null;
            }
            return optStr(o, k, null, p);
        }

        String optStr(final JsonObject o, final String k, final String def, final String p) {
            if (!o.has(k)) {
                return def;
            }
            JsonElement e = o.get(k);
            if (!e.isJsonPrimitive() || !e.getAsJsonPrimitive().isString()) {
                problem(p.isEmpty() ? k : p + "." + k, "expected a string");
                return def;
            }
            return e.getAsString();
        }

        boolean optBool(final JsonObject o, final String k, final boolean def, final String p) {
            if (!o.has(k)) {
                return def;
            }
            JsonElement e = o.get(k);
            if (!e.isJsonPrimitive() || !e.getAsJsonPrimitive().isBoolean()) {
                problem(p.isEmpty() ? k : p + "." + k, "expected true or false");
                return def;
            }
            return e.getAsBoolean();
        }

        int optColor(final JsonObject o, final String k, final int def, final String p) {
            String s = optStr(o, k, null, p);
            if (s == null) {
                return def;
            }
            try {
                return Colors.parse(s);
            } catch (IllegalArgumentException e) {
                problem(p + "." + k, e.getMessage());
                return def;
            }
        }

        String reqName(final JsonObject o, final String k, final String p) {
            String path = p.isEmpty() ? k : p + "." + k;
            if (!o.has(k)) {
                problem(path, "missing");
                return null;
            }
            return name(o.get(k), path);
        }

        String name(final JsonElement e, final String path) {
            if (!e.isJsonPrimitive() || !e.getAsJsonPrimitive().isString()) {
                problem(path, "expected a name");
                return null;
            }
            String s = e.getAsString();
            if (!NAME.matcher(s).matches()) {
                problem(path, "'" + s + "' is not a name: lower-case letters, digits and _ , starting with a letter"
                    + " (it becomes a Java identifier in generated code)");
                return null;
            }
            return s;
        }

        Text reqText(final JsonObject o, final String k, final String p) {
            String path = p.isEmpty() ? k : p + "." + k;
            if (!o.has(k)) {
                problem(path, "missing");
                return null;
            }
            JsonElement e = o.get(k);
            if (e.isJsonPrimitive() && e.getAsJsonPrimitive().isString()) {
                return Text.literal(e.getAsString());
            }
            if (e.isJsonObject()) {
                JsonObject to = e.getAsJsonObject();
                unknownKeys(to, Set.of("translate"), path);
                String key = reqStr(to, "translate", path);
                return key == null ? null : Text.translate(key);
            }
            problem(path, "expected a string or {\"translate\": \"key\"}");
            return null;
        }
    }
}
