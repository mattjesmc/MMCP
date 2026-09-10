package com.mattmc.mcptoolkit.ui;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.ExecutionContext;
import com.mattmc.mcptoolkit.McpTools;
import com.mattmc.mcptoolkit.Mechanism;
import com.mattmc.mcptoolkit.Schemas;
import com.mattmc.mcptoolkit.ToolContext;
import com.mattmc.mcptoolkit.ToolDef;
import com.mattmc.mcptoolkit.ui.doc.Element;
import com.mattmc.mcptoolkit.ui.doc.Kind;
import com.mattmc.mcptoolkit.ui.doc.PartLibrary;
import com.mattmc.mcptoolkit.ui.doc.UiDocument;
import com.mattmc.mcptoolkit.ui.doc.UiEdit;
import com.mattmc.mcptoolkit.ui.doc.UiLint;
import com.mattmc.mcptoolkit.ui.doc.UiParseException;
import com.mattmc.mcptoolkit.ui.doc.UiParser;
import com.mattmc.mcptoolkit.ui.doc.UiWriter;
import com.mattmc.mcptoolkit.ui.emit.Target;
import com.mattmc.mcptoolkit.ui.emit.UiGenerate;
import com.mattmc.mcptoolkit.ui.emit.UiProject;
import net.minecraft.resources.Identifier;
import org.jspecify.annotations.Nullable;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

/**
 * <b>{@code ui_doc} - the fourth editor</b> (SCREEN_AUTHORING_DESIGN.md sections 5 and 10): the
 * agent's hands on a screen-authoring document, as one tool with an {@code op}.
 *
 * <p><b>One tool, not eight.</b> The workbench's own measurement is that a manifest entry floors at
 * ~589 tokens per turn and that the SCHEMA is the bigger half of the bill, so a verb-per-tool
 * surface would spend more on describing this than the whole authoring surface saves. The
 * {@code studio} precedent, for the same reason.
 *
 * <p><b>It implements almost nothing.</b> Every mutation is {@link UiEdit}'s - the same engine the
 * in-game editor's drag runs through, which means an edit made here is checked by the parser that
 * will check the file on load, refused in the parser's own sentence at the parser's own path, and
 * written back canonical. Where the file goes is {@link UiSaveTarget}'s, the same two destinations
 * Ctrl+S writes. What is legal-but-wrong is {@link UiLint}'s. What the emitter's arguments are is
 * {@link UiProject}'s, read from the same {@code gradle.properties} key the Gradle task reads. The
 * only thing this class decides is how those answers are shaped as JSON.
 *
 * <p><b>There is no session, and that is the design.</b> The editor holds a document in memory with
 * an undo stack; a tool call cannot, so every mutation writes the file immediately and git is the
 * undo. That is what makes the two editors composable: the file is the shared state, and it is
 * always the truth.
 *
 * <p><b>The one conflict that follows, handled by name.</b> While the in-game editor is open it OWNS
 * the document (it stops re-reading the file, or a window resize would discard unsaved work), so a
 * write underneath it would be lost on the next Ctrl+S. A mutation is therefore refused while an
 * editor holds the same document with unsaved edits - and only then; a clean editor is no obstacle,
 * because it has nothing to lose.
 *
 * <p>Runs on {@link ExecutionContext#ANY}: reading, linting, editing and generating are files and
 * the model, and none of them needs a world or even a client. {@code preview}, {@code attach} and
 * {@code detach} are the exceptions - they are about a SCREEN - and the reason {@link Client}
 * exists; on a headless game they refuse by name.
 */
public final class UiDocTools {
    private UiDocTools() {}

    /**
     * The client half, installed by {@code UiTools} when a client exists.
     *
     * <p>Two things need one: opening a preview (a screen, on the client thread) and asking whether
     * the in-game editor is sitting on unsaved edits. On a dedicated server neither exists, and
     * {@code preview} says so rather than failing obscurely.
     */
    public interface Client {
        /** Open the document as a detached preview (or the editor), and answer as open_screen does. */
        CompletableFuture<JsonObject> preview(@Nullable Identifier id, @Nullable Path file, boolean edit);

        /**
         * The same preview, but from a client that may be at the title screen: enter the AUTHORING
         * WORLD (creating it on first use) and open the document once the player is standing in it.
         * A client that is already in a world previews there and stays there.
         */
        CompletableFuture<JsonObject> open(@Nullable Identifier id, @Nullable Path file, boolean edit);

        /**
         * Wrap the container screen that is open in the interpreter, over its LIVE menu (section
         * 6.1). A null document is derived from the open screen when it is a generated one.
         */
        CompletableFuture<JsonObject> attach(@Nullable Identifier id, @Nullable Path file, boolean edit);

        /** Put back the screen an attached preview wrapped. */
        CompletableFuture<JsonObject> detach();

        /**
         * One sentence when the in-game editor currently holds this document with unsaved edits,
         * else {@code null}. Compared on the RESOLVED file rather than on how it was addressed, so
         * an editor that opened {@code mcptoolkit:example} and a call that named the same file by
         * path are recognised as the same document. Reads two fields off the open screen - no game
         * state is touched, which is what lets it answer on the HTTP thread.
         */
        @Nullable String unsavedHold(Path resolvedFile);
    }

    private static volatile @Nullable Client client;

    public static void installClient(final Client c) {
        client = c;
    }

    // ---------------------------------------------------------------------------------------------

    private static final String DESCRIPTION =
        "Author a screen-authoring document (assets/<mod>/ui/<screen>.ui.json) without opening the game's editor: "
            + "the same mutation engine, the same parser, the same two save destinations as the in-game editor's "
            + "drag and Ctrl+S. Name the document with \"ui\":\"<mod>:<screen>\" (resolved to the mod's SOURCE TREE, "
            + "which is the truth) or \"ui_file\":\"<path>\". Address an element by \"path\" (the parser's own, "
            + "elements[3].children[1]) or by \"id\". ops: "
            + "read - the canonical document plus an index of every element's path/kind/id, which is where paths come from, "
            + "and the part instances with the hash of the part FILE each was expanded from; "
            + "lint - what parses fine and is still wrong (a button off the panel, two clickables on the same pixels, "
            + "a container whose slots nothing places, a declared action no button fires), plus the count it could NOT "
            + "check (a layout node's children are arranged at init() time and a label with no width is the font's) - "
            + "on a document that does not parse it answers the parse problems instead of refusing; "
            + "add - insert a registered kind (see `kinds`), declaring the action/binding/slots it needs; "
            + "set - one key of one element, or a screen-level key (title, width, title_pos, ...) when no element is given; "
            + "the value is read leniently, so 12 is a number, [2,0] a pair and a bare word a string. Omit `value` to clear a key; "
            + "move - to \"x\"/\"y\", or by \"dx\"/\"dy\"; a layout child moves by writing the explicit offset override; "
            + "remove - delete an element and, for a layout node, everything in it; "
            + "A `part` or a `repeat` is a MACRO: the document holds the instance and the parser holds what it expanded to, "
            + "so `read` lists the expansion as read-only and every mutation inside one is refused by name - edit the part "
            + "file (assets/<ns>/ui/parts/<name>.part.json), or the instance's arguments; "
            + "generate - run the emitter over this mod's documents, into the packages the project's gradle.properties names "
            + "(mcmod.ui.package - the same key `gradlew generateUi` reads, so the two cannot disagree); \"check\":true writes "
            + "nothing and reports drift, which is the staleness guarantee without a build; "
            + "open - preview it from wherever the client is, INCLUDING THE TITLE SCREEN: with no world loaded this "
            + "enters the toolkit's authoring world (a flat, empty, weatherless, mobless save it creates on first use) "
            + "and opens the document once the player is standing there; with a world already loaded it is exactly "
            + "`preview` and names the world it used. Never disconnects an open world; "
            + "preview - open it in the client as a detached preview (\"edit\":true arms the in-game editor); "
            + "attach - swap the interpreter IN FRONT OF the container screen that is already open, over its LIVE menu: "
            + "real slots, real stacks, the bindings the server actually synced, and still editable (\"edit\":true). "
            + "Name no document and it is taken from the open screen when that screen is a document's generated one. "
            + "A slot cannot move while attached (vanilla's Slot.x is final) and the reply says how far the live menu "
            + "has drifted from the document; "
            + "detach - put the wrapped screen back, same instance, same menu. "
            + "Every mutation writes the file at once (there is no session and no undo - git is the undo) and is refused while "
            + "the in-game editor holds the same document with unsaved edits. A refusal is the parser's, listing every problem.";

    public static void register() {
        McpTools.register(ToolDef.async(
            "ui_doc",
            DESCRIPTION,
            Schemas.objectOpt(
                Schemas.object(
                    "op", Schemas.str("read | lint | add | set | move | remove | generate | open | preview | attach | detach."),
                    "ui", Schemas.str("The document as <mod>:<screen>, e.g. mcptoolkit:example."),
                    "ui_file", Schemas.str("The document as a path, for one no loaded mod owns."),
                    "path", Schemas.str("The element, in the parser's path syntax: elements[3].children[1]."),
                    "id", Schemas.str("The element by its declared id - an alternative to `path`."),
                    "parent", Schemas.str("add: the layout node (path or id) to insert INTO; omit for the top level."),
                    "kind", Schemas.str("add: the element kind. read/lint list the registered ones."),
                    "key", Schemas.str("set: the property. With no element addressed it is a screen-level key."),
                    "value", Schemas.str("set: the new value, read leniently (12, true, [2,0], {\"item\":\"...\"}, or a bare string). Omit to CLEAR the key."),
                    "x", Schemas.integer("add/move: panel x."),
                    "y", Schemas.integer("add/move: panel y."),
                    "dx", Schemas.integer("move: x delta, instead of an absolute x/y."),
                    "dy", Schemas.integer("move: y delta."),
                    "edit", Schemas.bool("preview/attach: arm the in-game editor (handles, palette, inspector)."),
                    "check", Schemas.bool("generate: write nothing, report whether any generated file is stale.")),
                "ui", "ui_file", "path", "id", "parent", "kind", "key", "value", "x", "y", "dx", "dy",
                "edit", "check"),
            ExecutionContext.ANY,
            // Disk writes, in the developer's own source tree, and a code generator that rewrites
            // Java files. PRIVILEGED is exactly that class - `read` and `lint` ride along because a
            // mechanism is a property of the tool, and the higher one is the honest one to declare.
            Mechanism.PRIVILEGED,
            UiDocTools::dispatch));
    }

    private static CompletableFuture<JsonElement> dispatch(final ToolContext ctx, final JsonObject a) {
        String op = str(a, "op");
        if (op == null) {
            throw new IllegalArgumentException("'op' is required: read, lint, add, set, move, remove,"
                + " generate, open, preview, attach, detach");
        }
        // `attach` may take its document from the open screen and `detach` names none at all; every
        // other op is about a document and says which.
        boolean optional = "attach".equalsIgnoreCase(op) || "detach".equalsIgnoreCase(op);
        Where where = optional ? Where.optional(a) : Where.of(a);
        // Parts resolve against the document's OWN source tree first, then the classpath - which in a
        // dev game is the toolkit's jar, so the seed library is reachable from a sibling checkout with
        // no wiring (PartLibrary). Scoped rather than installed: two sessions may hold two checkouts.
        try (PartLibrary.Scope scope = PartLibrary.scoped(where == null
            ? PartLibrary.current() : where.library())) {
            return run(op, where, a);
        }
    }

    private static CompletableFuture<JsonElement> run(final String op, final @Nullable Where where,
                                                      final JsonObject a) {
        return switch (op.toLowerCase(Locale.ROOT)) {
            case "read" -> done(read(where));
            case "lint" -> done(lint(where));
            case "add" -> done(add(where, a));
            case "set" -> done(set(where, a));
            case "move" -> done(move(where, a));
            case "remove" -> done(remove(where, a));
            case "generate" -> done(generate(where, a));
            case "open" -> open(where, a);
            case "preview" -> preview(where, a);
            case "attach" -> attach(where, a);
            case "detach" -> detach();
            default -> throw new IllegalArgumentException("unknown op '" + op
                + "'; one of read, lint, add, set, move, remove, generate, open, preview, attach, detach");
        };
    }

    private static CompletableFuture<JsonElement> done(final JsonObject o) {
        return CompletableFuture.completedFuture(o);
    }

    // ---------------------------------------------------------------------------------------------
    // Which document

    /** The addressed document: how it was named, and where its bytes live. */
    private record Where(@Nullable Identifier id, @Nullable Path file, UiSaveTarget.Target target) {
        /** The document when one was named, else null - for the ops that can find their own. */
        static @Nullable Where optional(final JsonObject a) {
            return a.has("ui") || a.has("ui_file") ? of(a) : null;
        }

        static Where of(final JsonObject a) {
            String ui = str(a, "ui");
            String path = str(a, "ui_file");
            if ((ui == null) == (path == null)) {
                throw new IllegalArgumentException("name ONE document: 'ui' (a resource id like"
                    + " mcptoolkit:example) or 'ui_file' (a path)");
            }
            if (ui != null) {
                Identifier id = Identifier.tryParse(ui);
                if (id == null) {
                    throw new IllegalArgumentException("'ui' must be a resource id like mcptoolkit:example");
                }
                try {
                    return new Where(id, null, UiSaveTarget.resolve(id));
                } catch (IOException e) {
                    throw new IllegalArgumentException(e.getMessage());
                }
            }
            Path p = Path.of(path).toAbsolutePath().normalize();
            if (!Files.isRegularFile(p)) {
                throw new IllegalArgumentException("no such file: " + p);
            }
            return new Where(null, p, UiSaveTarget.resolveFile(p));
        }

        String describe() {
            return id != null ? id.toString() : String.valueOf(file);
        }

        /**
         * Where this document's parts come from: its own resources root, then the classpath.
         *
         * <p>The root is derived from the file - {@code <root>/assets/<mod>/ui/<screen>.ui.json} - for
         * the same reason {@link UiProject} derives everything else from it: the path already states
         * it, and a second way of saying it is a second thing that can disagree.
         */
        PartLibrary library() {
            Path ui = target.file().getParent();
            Path mod = ui == null ? null : ui.getParent();
            Path assets = mod == null ? null : mod.getParent();
            Path root = assets == null ? null : assets.getParent();
            return root == null ? PartLibrary.classpath()
                : PartLibrary.chain(PartLibrary.assets(root), PartLibrary.classpath());
        }

        String read() {
            try {
                return Files.readString(target.file(), StandardCharsets.UTF_8);
            } catch (IOException e) {
                throw new IllegalArgumentException("cannot read " + target.file() + ": " + e.getMessage());
            }
        }

        UiDocument document() {
            try {
                return UiParser.parse(read());
            } catch (UiParseException e) {
                throw refusal(describe(), e);
            }
        }

        /** Write both destinations, after checking nobody is holding the document. */
        String write(final UiDocument doc) {
            Client c = client;
            if (c != null) {
                String hold = c.unsavedHold(target.file());
                if (hold != null) {
                    throw new IllegalStateException(hold + " Save or discard there first, or the next"
                        + " Ctrl+S would overwrite what this call wrote.");
                }
            }
            try {
                return UiSaveTarget.write(target, UiWriter.toJson(doc));
            } catch (IOException e) {
                throw new IllegalStateException("could not write " + target.file() + ": " + e.getMessage());
            }
        }

        void place(final JsonObject r) {
            r.addProperty("document", describe());
            r.addProperty("file", target.file().toString());
            if (target.mirror() != null) {
                r.addProperty("mirror", target.mirror().toString());
            }
            r.addProperty("how", target.how());
        }
    }

    /** The addressed element, or null when the call addressed none. */
    private static UiEdit.@Nullable Path element(final UiDocument doc, final JsonObject a, final String pathKey,
                                                 final String idKey) {
        String path = str(a, pathKey);
        String id = str(a, idKey);
        if (path != null && id != null) {
            throw new IllegalArgumentException("address the element ONCE: '" + pathKey + "' or '" + idKey + "'");
        }
        if (path != null) {
            UiEdit.Path p;
            try {
                p = UiEdit.Path.parse(path);
            } catch (IllegalArgumentException e) {
                throw new IllegalArgumentException(e.getMessage());
            }
            if (UiEdit.elementAt(doc, p) == null) {
                throw new IllegalArgumentException("no element at " + path + "; read the document for the paths");
            }
            return p;
        }
        if (id != null) {
            UiEdit.Path p = UiEdit.pathOf(doc, id);
            if (p == null) {
                throw new IllegalArgumentException("no element with id '" + id + "'; read the document for the ids");
            }
            return p;
        }
        return null;
    }

    // ---------------------------------------------------------------------------------------------
    // read / lint

    private static JsonObject read(final Where where) {
        UiDocument doc = where.document();
        JsonObject r = new JsonObject();
        where.place(r);
        JsonObject screen = new JsonObject();
        screen.addProperty("title", doc.title().raw());
        screen.addProperty("width", doc.width());
        screen.addProperty("height", doc.height());
        r.add("screen", screen);
        r.add("elements", index(doc));
        r.add("json", UiWriter.write(doc));
        r.add("kinds", strings(Kind.names()));
        JsonArray parts = parts(doc);
        if (!parts.isEmpty()) {
            r.add("parts", parts);
        }
        JsonObject lint = new JsonObject();
        UiLint.Report report = UiLint.check(doc);
        lint.addProperty("notes", report.notes().size());
        lint.addProperty("unchecked", report.unchecked());
        r.add("lint", lint);
        r.addProperty("note", "paths above are what `path` takes; `json` is the file as the parser"
            + " canonicalises it, so it is also what a save would write");
        return r;
    }

    /**
     * One line per element: the path, the kind, the id. The document's own JSON carries every
     * property already - what it does NOT carry is the addresses, which is the whole reason a caller
     * reads this before editing anything.
     */
    private static JsonArray index(final UiDocument doc) {
        JsonArray out = new JsonArray();
        for (UiEdit.Placed p : UiEdit.walkAll(doc)) {
            Element e = p.element();
            UiEdit.Placed macro = UiEdit.enclosingMacro(doc, p.path());
            out.add(p.path().format() + " " + e.kind().jsonName()
                + (e.id() == null ? "" : " '" + e.id() + "'")
                + (macro == null ? "" : " [from " + macro.element().kind().jsonName() + " "
                    + macro.path().format() + " - read-only]"));
        }
        return out;
    }

    /**
     * Every part instance, with the hash of the part FILE it was expanded from
     * (UI_PARTS_LIBRARY_DESIGN.md section 5.3).
     *
     * <p>Vendoring means a part bug ships N times and the part's own text is copied into no
     * repository. The hash is what a reader greps for, and it is written into the generated Java's
     * header too - so "is this screen compiled from the part I am looking at?" is a comparison rather
     * than a guess.
     */
    private static JsonArray parts(final UiDocument doc) {
        JsonArray out = new JsonArray();
        for (Element.Part part : UiParser.partsUsed(doc)) {
            JsonObject o = new JsonObject();
            o.addProperty("id", part.id());
            o.addProperty("part", part.part());
            o.addProperty("hash", part.hash());
            o.addProperty("expanded", part.children().size());
            JsonArray params = new JsonArray();
            for (Element.PartParam prm : part.params()) {
                params.add(prm.name() + ": " + prm.type() + (prm.required() ? " (required)"
                    : part.args().containsKey(prm.name()) ? "" : " (default)"));
            }
            o.add("params", params);
            out.add(o);
        }
        return out;
    }

    /**
     * Lint is the one op that answers on a document that does not parse: refusing to say what is
     * wrong with a file whose problem is that it is wrong would be the wrong shape of tool.
     */
    private static JsonObject lint(final Where where) {
        JsonObject r = new JsonObject();
        where.place(r);
        UiDocument doc;
        try {
            doc = UiParser.parse(where.read());
        } catch (UiParseException e) {
            r.addProperty("parses", false);
            JsonArray problems = new JsonArray();
            for (UiParseException.Problem p : e.problems()) {
                problems.add(p.toString());
            }
            r.add("problems", problems);
            r.addProperty("note", "the document does not load at all; these are refusals, not advice");
            return r;
        }
        r.addProperty("parses", true);
        JsonArray parts = parts(doc);
        if (!parts.isEmpty()) {
            r.add("parts", parts);
            r.add("part_drift", partDrift(where, doc));
        }
        UiLint.Report report = UiLint.check(doc);
        r.add("notes", notes(report));
        r.addProperty("unchecked", report.unchecked());
        if (!report.why().isEmpty()) {
            r.addProperty("unchecked_why", report.why());
        }
        r.add("codes", strings(UiLint.codes()));
        return r;
    }

    /**
     * Which part instances the checked-in generated Java was compiled from a DIFFERENT version of
     * (section 5.3's second mitigation).
     *
     * <p>The emitter writes {@code <part> #<hash> as <instance>} into every machine file's header, so
     * this is a text comparison against the layout file on disk - no build, no game, and it answers
     * the one question vendoring makes hard to ask.
     */
    private static JsonElement partDrift(final Where where, final UiDocument doc) {
        JsonArray out = new JsonArray();
        Path layout;
        try {
            UiProject project = UiProject.of(where.target().file());
            String stem = where.target().file().getFileName().toString();
            stem = stem.substring(0, stem.length() - ".ui.json".length());
            layout = project.client().resolve(project.basePackage().replace('.', '/') + "/client/"
                + com.mattmc.mcptoolkit.ui.emit.EmitRequest.pascal(stem) + "Layout.java");
        } catch (IOException e) {
            JsonObject o = new JsonObject();
            o.addProperty("unchecked", "no generated code to compare against: " + e.getMessage());
            out.add(o);
            return out;
        }
        String generated;
        try {
            generated = Files.readString(layout, StandardCharsets.UTF_8);
        } catch (IOException e) {
            JsonObject o = new JsonObject();
            o.addProperty("unchecked", "no " + layout + " yet - run generate");
            out.add(o);
            return out;
        }
        for (Element.Part part : UiParser.partsUsed(doc)) {
            String stamp = part.part() + " #" + part.hash() + " as " + part.id();
            if (generated.contains(stamp)) {
                continue;
            }
            JsonObject o = new JsonObject();
            o.addProperty("id", part.id());
            o.addProperty("part", part.part());
            o.addProperty("hash", part.hash());
            o.addProperty("problem", layout.getFileName() + " was not generated from this version of the"
                + " part; run generate");
            out.add(o);
        }
        return out;
    }

    private static JsonArray notes(final UiLint.Report report) {
        JsonArray out = new JsonArray();
        for (UiLint.Note n : report.notes()) {
            JsonObject o = new JsonObject();
            o.addProperty("code", n.code().name().toLowerCase(Locale.ROOT));
            if (!n.path().isEmpty()) {
                o.addProperty("at", n.path());
            }
            o.addProperty("problem", n.message());
            out.add(o);
        }
        return out;
    }

    // ---------------------------------------------------------------------------------------------
    // Mutations

    private static JsonObject add(final Where where, final JsonObject a) {
        UiDocument doc = where.document();
        String kindName = str(a, "kind");
        if (kindName == null) {
            throw new IllegalArgumentException("'kind' is required; registered kinds: " + Kind.names());
        }
        Kind kind = Kind.forName(kindName);
        if (kind == null) {
            throw new IllegalArgumentException("unknown kind '" + kindName + "'; registered kinds: " + Kind.names());
        }
        UiEdit.Path parent = UiEdit.Path.ROOT;
        String p = str(a, "parent");
        if (p != null) {
            UiEdit.Path byPath = UiEdit.pathOf(doc, p);
            if (byPath != null) {
                parent = byPath;
            } else {
                try {
                    parent = UiEdit.Path.parse(p);
                } catch (IllegalArgumentException e) {
                    throw new IllegalArgumentException("'parent' is a layout node's path or id: " + e.getMessage());
                }
                if (UiEdit.elementAt(doc, parent) == null) {
                    throw new IllegalArgumentException("no element at " + p);
                }
            }
        }
        UiEdit.Added added;
        try {
            added = UiEdit.add(doc, kind, parent, intOf(a, "x", 8), intOf(a, "y", 8));
        } catch (UiParseException e) {
            throw refusal(where.describe(), e);
        }
        JsonObject r = result(where, added.doc(), added.path());
        r.addProperty("added", added.path().format());
        return r;
    }

    private static JsonObject set(final Where where, final JsonObject a) {
        UiDocument doc = where.document();
        UiEdit.Path target = element(doc, a, "path", "id");
        String key = str(a, "key");
        if (key == null) {
            throw new IllegalArgumentException("'key' is required");
        }
        // A string is read leniently (UiEdit.value, the same reading the inspector's boxes get, so
        // "12" is the number and a bare word is a string); anything already typed as JSON - a real
        // number, an array, an object - is taken as it stands.
        JsonElement raw = a.has("value") && !a.get("value").isJsonNull() ? a.get("value") : null;
        JsonElement value = raw == null ? null
            : raw.isJsonPrimitive() && raw.getAsJsonPrimitive().isString()
                ? UiEdit.value(raw.getAsString()) : raw;
        UiDocument next;
        try {
            next = target == null ? UiEdit.setScreen(doc, key, value) : UiEdit.set(doc, target, key, value);
        } catch (UiParseException e) {
            throw refusal(where.describe(), e);
        }
        JsonObject r = result(where, next, target);
        r.addProperty("set", (target == null ? "" : target.format() + ".") + key);
        if (value == null) {
            r.addProperty("cleared", true);
        } else {
            r.add("value", value);
        }
        if (target == null && (next.width() != doc.width() || next.height() != doc.height())) {
            r.addProperty("reopen", "imageWidth/imageHeight are final in vanilla: an open preview keeps"
                + " the old size until it is reopened");
        }
        return r;
    }

    private static JsonObject move(final Where where, final JsonObject a) {
        UiDocument doc = where.document();
        UiEdit.Path target = element(doc, a, "path", "id");
        if (target == null) {
            throw new IllegalArgumentException("move needs an element: 'path' or 'id'");
        }
        boolean delta = a.has("dx") || a.has("dy");
        boolean absolute = a.has("x") || a.has("y");
        if (delta == absolute) {
            throw new IllegalArgumentException("move by 'dx'/'dy' or to 'x'/'y', not both and not neither");
        }
        UiDocument next;
        try {
            next = delta
                ? UiEdit.dragBy(doc, target, intOf(a, "dx", 0), intOf(a, "dy", 0))
                : UiEdit.moveTo(doc, target, intOf(a, "x", 0), intOf(a, "y", 0));
        } catch (UiParseException e) {
            throw refusal(where.describe(), e);
        }
        JsonObject r = result(where, next, target);
        r.addProperty("moved", target.format());
        if (delta && target.insideLayout()) {
            r.addProperty("note", "this element is placed by its layout node, so the move wrote an"
                + " explicit offset override rather than an x/y");
        }
        return r;
    }

    private static JsonObject remove(final Where where, final JsonObject a) {
        UiDocument doc = where.document();
        UiEdit.Path target = element(doc, a, "path", "id");
        if (target == null) {
            throw new IllegalArgumentException("remove needs an element: 'path' or 'id'");
        }
        Element gone = UiEdit.elementAt(doc, target);
        UiDocument next;
        try {
            next = UiEdit.remove(doc, target);
        } catch (UiParseException e) {
            throw refusal(where.describe(), e);
        }
        JsonObject r = result(where, next, null);
        r.addProperty("removed", target.format() + " (" + gone.kind().jsonName()
            + (gone.id() == null ? "" : " '" + gone.id() + "'") + ")");
        r.addProperty("note", "every sibling after it moved up one index; read the document again"
            + " before addressing another element by path");
        return r;
    }

    /**
     * The shared tail of every mutation: write, then say what the document now holds at the path
     * that changed. Re-resolving the element from the SAVED document rather than echoing the
     * request is what makes a lenient value visible - {@code value:"12"} that became the number 12
     * says so here.
     */
    private static JsonObject result(final Where where, final UiDocument next, final UiEdit.@Nullable Path at) {
        String saved = where.write(next);
        JsonObject r = new JsonObject();
        where.place(r);
        r.addProperty("saved", saved);
        if (at != null) {
            JsonObject written = UiWriter.write(next);
            JsonElement e = at(written, at);
            if (e != null) {
                r.add("element", e);
            }
        }
        UiLint.Report report = UiLint.check(next);
        if (!report.clean()) {
            r.add("lint", notes(report));
        }
        return r;
    }

    /** The written element at a path, for the echo above. */
    private static @Nullable JsonElement at(final JsonObject written, final UiEdit.Path path) {
        JsonElement level = written.get("elements");
        JsonElement found = null;
        for (int step : path.steps()) {
            if (level == null || !level.isJsonArray() || step >= level.getAsJsonArray().size()) {
                return null;
            }
            found = level.getAsJsonArray().get(step);
            level = found.isJsonObject() ? found.getAsJsonObject().get("children") : null;
        }
        return found;
    }

    // ---------------------------------------------------------------------------------------------
    // generate

    private static JsonObject generate(final Where where, final JsonObject a) {
        boolean check = bool(a, "check");
        UiProject project;
        try {
            project = UiProject.of(where.target().file());
        } catch (IOException e) {
            throw new IllegalArgumentException(e.getMessage());
        }
        UiGenerate.Report report;
        try {
            report = project.run(Target.FABRIC, check);
        } catch (IOException e) {
            throw new IllegalStateException("generate failed: " + e.getMessage());
        }
        JsonObject r = new JsonObject();
        where.place(r);
        r.addProperty("mod", project.modId());
        r.addProperty("package", project.basePackage());
        r.addProperty("docs", project.docs().toString());
        r.addProperty("common", project.common().toString());
        r.addProperty("client", project.client().toString());
        r.addProperty("checked_only", check);
        JsonObject files = new JsonObject();
        for (Map.Entry<Path, UiGenerate.Fate> e : report.files().entrySet()) {
            files.addProperty(e.getKey().toString(), e.getValue().name().toLowerCase(Locale.ROOT));
        }
        r.add("files", files);
        r.addProperty("drift", report.drifted());
        if (!report.problems().isEmpty()) {
            r.add("problems", strings(report.problems()));
        }
        JsonObject notes = new JsonObject();
        for (Map.Entry<String, java.util.List<String>> e : report.notes().entrySet()) {
            notes.add(e.getKey(), strings(e.getValue()));
        }
        r.add("still_yours", notes);
        r.addProperty("note", check
            ? "drift:true means a checked-in generated file no longer matches its document - the same"
                + " thing `gradlew checkUi` fails a build on"
            : "generated Java is checked in: commit it with the document. The game keeps running the"
                + " OLD classes until it is rebuilt");
        return r;
    }

    // ---------------------------------------------------------------------------------------------
    // preview

    /**
     * {@code open} - preview from wherever the client is, including nowhere (SCREEN_AUTHORING_DESIGN.md
     * section 23). At the title screen it enters the authoring world, creating it the first time;
     * in a world it is exactly {@code preview} and says which world that was.
     */
    private static CompletableFuture<JsonElement> open(final Where where, final JsonObject a) {
        Client c = client;
        if (c == null) {
            throw new IllegalStateException("no client attached: the authoring world is a client's"
                + " world and a preview is a screen, and this game has neither");
        }
        return c.open(where.id(), where.file(), bool(a, "edit")).thenApply(o -> {
            where.place(o);
            return o;
        });
    }

    private static CompletableFuture<JsonElement> preview(final Where where, final JsonObject a) {
        Client c = client;
        if (c == null) {
            throw new IllegalStateException("no client attached: a preview is a screen, and this game has"
                + " none (read, lint, add, set, move, remove and generate all work without one)");
        }
        return c.preview(where.id(), where.file(), bool(a, "edit")).thenApply(o -> {
            where.place(o);
            return o;
        });
    }

    // ---------------------------------------------------------------------------------------------
    // attach / detach (slice 6)

    /**
     * The attached preview (section 6.1). The interpreter is swapped in front of whatever container
     * screen is open, over the menu that screen was already showing - so what it draws is the
     * document's geometry filled with the running game's state.
     */
    private static CompletableFuture<JsonElement> attach(final @Nullable Where where, final JsonObject a) {
        Client c = requireClient("attach");
        return c.attach(where == null ? null : where.id(), where == null ? null : where.file(), bool(a, "edit"))
            .thenApply(o -> {
                if (where != null) {
                    where.place(o);
                }
                return o;
            });
    }

    private static CompletableFuture<JsonElement> detach() {
        return requireClient("detach").detach().thenApply(o -> o);
    }

    private static Client requireClient(final String op) {
        Client c = client;
        if (c == null) {
            throw new IllegalStateException("no client attached: '" + op + "' is about a SCREEN, and this"
                + " game has none (read, lint, add, set, move, remove and generate all work without one)");
        }
        return c;
    }

    // ---------------------------------------------------------------------------------------------

    private static IllegalArgumentException refusal(final String document, final UiParseException e) {
        JsonArray problems = new JsonArray();
        for (UiParseException.Problem p : e.problems()) {
            problems.add(p.toString());
        }
        return new IllegalArgumentException(document + " would have " + e.problems().size()
            + " problem(s) and was NOT written: " + problems);
    }

    private static @Nullable String str(final JsonObject a, final String key) {
        return a.has(key) && !a.get(key).isJsonNull() ? a.get(key).getAsString() : null;
    }

    private static int intOf(final JsonObject a, final String key, final int fallback) {
        return a.has(key) && !a.get(key).isJsonNull() ? a.get(key).getAsInt() : fallback;
    }

    private static boolean bool(final JsonObject a, final String key) {
        return a.has(key) && !a.get(key).isJsonNull() && a.get(key).getAsBoolean();
    }

    private static JsonArray strings(final Iterable<String> values) {
        JsonArray out = new JsonArray();
        for (String s : values) {
            out.add(s);
        }
        return out;
    }
}
