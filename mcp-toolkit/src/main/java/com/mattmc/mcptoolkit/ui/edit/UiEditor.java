package com.mattmc.mcptoolkit.ui.edit;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.McpToolkit;
import com.mattmc.mcptoolkit.ui.UiSaveTarget;
import com.mattmc.mcptoolkit.ui.doc.Element;
import com.mattmc.mcptoolkit.ui.doc.Kind;
import com.mattmc.mcptoolkit.ui.doc.PartLibrary;
import com.mattmc.mcptoolkit.ui.doc.UiDocument;
import com.mattmc.mcptoolkit.ui.doc.UiEdit;
import com.mattmc.mcptoolkit.ui.doc.UiParseException;
import com.mattmc.mcptoolkit.ui.doc.UiParser;
import com.mattmc.mcptoolkit.ui.doc.UiWriter;
import com.mattmc.mcptoolkit.ui.emit.Target;
import com.mattmc.mcptoolkit.ui.emit.UiGenerate;
import com.mattmc.mcptoolkit.ui.emit.UiProject;
import com.mattmc.mcptoolkit.ui.interp.InterpretedScreen;
import com.mojang.blaze3d.platform.InputConstants;
import net.fabricmc.api.EnvType;
import net.fabricmc.api.Environment;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.components.EditBox;
import net.minecraft.client.input.KeyEvent;
import net.minecraft.network.chat.Component;
import org.jspecify.annotations.Nullable;

import java.io.IOException;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;
import java.util.function.Consumer;

/**
 * <b>The in-game editor</b> (SCREEN_AUTHORING_DESIGN.md section 9): handles, snap, a palette, a
 * property inspector, undo/redo and save, over the screen the human is already standing in front of.
 *
 * <p><b>It is not a screen. It is a mode of the interpreter</b>, and that is the whole reason its
 * fidelity is free: what you drag is what the document says, drawn by the renderer the conformance
 * battery holds against the generated Java. An editor that drew its own approximation of a Minecraft
 * GUI would be a second renderer, and section 12 would have three things to keep in agreement.
 *
 * <p><b>Where an edit goes.</b> Every mutation is a {@link UiEdit} call, so the destination is the
 * DOCUMENT - section 1's answer to "a live tweak evaporates on the next {@code init()}" - and every
 * refusal is the parser's own sentence. Undo is a stack of documents, because a document is an
 * immutable record: a snapshot is free and exact.
 *
 * <p><b>Two things the editor draws that the renderer must not.</b> A {@code region} paints nothing
 * (open decision 7: the generated screen's default hook is empty and the battery compares pixels),
 * and a layout node paints nothing either. Both are shown here, as overlay, on top - so the human
 * can see and grab what the player will never see. An explicit {@code offset} (section 4.3) gets a
 * marker for the same reason: an override must be legible AS an override.
 *
 * <p><b>A save regenerates</b> (slice 6, section 7.1's first caller): writing the document runs the
 * emitter over the mod's documents in-process, because {@code gradlew} cannot run while this game
 * holds the jar - that is the standing rule of this workbench and the reason the emitter had to be
 * callable from inside the running game at all. The generated Java is checked in beside the
 * document, so a drag that did not regenerate would leave the repository holding two versions of one
 * screen and {@code checkUi} failing the next build. The running game keeps executing the OLD
 * classes until it is rebuilt, and the status line says so.
 *
 * <p><b>Its furniture is undeclared on purpose</b> ({@link UiChrome}), so the battery's declared-
 * widget comparison cannot see the editor at all, while {@code click}/{@code set_text}/
 * {@code get_screen} can drive every part of it.
 */
@Environment(EnvType.CLIENT)
public final class UiEditor {
    private static final int UNDO_LIMIT = 64;
    private static final int ROW_H = 11;
    private static final int PALETTE_W = 56;
    private static final int INSPECTOR_W = 118;
    private static final int KEY_W = 48;
    private static final int HANDLE = 3;

    /** Which part of the selection a drag has hold of. */
    public enum Handle {
        MOVE, N, S, E, W, NE, NW, SE, SW;

        boolean movesX() {
            return this == W || this == NW || this == SW || this == MOVE;
        }

        boolean movesY() {
            return this == N || this == NW || this == NE || this == MOVE;
        }

        boolean sizesX() {
            return this != MOVE && this != N && this != S;
        }

        boolean sizesY() {
            return this != MOVE && this != E && this != W;
        }
    }

    private final InterpretedScreen screen;
    private UiDocument doc;
    private final Deque<UiDocument> undo = new ArrayDeque<>();
    private final Deque<UiDocument> redo = new ArrayDeque<>();
    private boolean dirty;
    private int snap = 1;

    private UiEdit.@Nullable Path selection;
    private String message = "";
    private boolean messageIsError;
    private boolean escapeArmed;

    private UiSaveTarget.@Nullable Target target;
    private @Nullable String targetError;

    /** Regenerate the mod's Java on every save (slice 6). A toggle, because a human may not want it. */
    private boolean regenerate = true;
    /** What the last save's generate did, or why it did nothing. */
    private @Nullable String generated;
    private boolean generateFailed;

    /** Screen-space rectangles by path, rebuilt every {@code init()}: the editor's hit test. */
    private final Map<String, int[]> rects = new LinkedHashMap<>();
    private final List<AbstractWidget> chrome = new ArrayList<>();
    private final List<Row> rows = new ArrayList<>();
    private @Nullable String focusRow;
    private @Nullable Grab grab;

    /** One inspector line: a document key, and the box holding its JSON text. */
    private record Row(String key, boolean screenLevel, EditBox box) {}

    /**
     * A live drag. The base document is the one the press started from, so every intermediate frame
     * is computed from IT rather than from the previous frame - a drag is therefore one undo entry
     * and cannot accumulate rounding.
     */
    private record Grab(UiEdit.Path path, Handle handle, UiDocument base, double px, double py) {}

    public UiEditor(final InterpretedScreen screen) {
        this.screen = screen;
        this.doc = screen.document();
        resolveTarget();
    }

    // ---------------------------------------------------------------------------------------------
    // State

    public UiDocument document() {
        return doc;
    }

    public boolean isDirty() {
        return dirty;
    }

    /** Where a save would land, or {@code null} when it could not be resolved. */
    public UiSaveTarget.@Nullable Target target() {
        return target;
    }

    public UiEdit.@Nullable Path selection() {
        return selection;
    }

    public void select(final UiEdit.@Nullable Path path) {
        selection = path;
        focusRow = null;
        screen.adopt(doc); // rebuild the inspector for the new selection
    }

    private void resolveTarget() {
        try {
            com.mattmc.mcptoolkit.ui.interp.UiSource src = screen.source();
            target = src instanceof com.mattmc.mcptoolkit.ui.interp.UiSource.File f
                ? UiSaveTarget.resolveFile(f.path())
                : UiSaveTarget.resolve(((com.mattmc.mcptoolkit.ui.interp.UiSource.Res) src).screen());
            targetError = null;
        } catch (IOException e) {
            target = null;
            targetError = e.getMessage();
        }
    }

    private void say(final String text, final boolean error) {
        message = text;
        messageIsError = error;
        if (error) {
            McpToolkit.LOGGER.warn("[MCP Toolkit] ui editor: {}", text);
        }
    }

    /** Apply an edit: one undo entry, the document adopted, the screen rebuilt. */
    /** A mutation, so {@link #edit} can wrap the lot of them in one thing. */
    @FunctionalInterface
    private interface Mutation<T> {
        T run() throws UiParseException;
    }

    /**
     * Run one mutation against THIS document's part library.
     *
     * <p>Every edit is a full re-parse, so an edit made without the library the document was OPENED
     * with would refuse a part that loaded a moment ago - the worst shape of failure, because the
     * screen in front of the human is proof it worked. One place, so no mutation can forget.
     */
    private <T> T edit(final Mutation<T> mutation) throws UiParseException {
        try (PartLibrary.Scope scope = PartLibrary.scoped(screen.source().library())) {
            return mutation.run();
        }
    }

    private void apply(final UiDocument next, final String what) {
        undo.push(doc);
        while (undo.size() > UNDO_LIMIT) {
            undo.removeLast();
        }
        redo.clear();
        dirty = true;
        setDoc(next);
        say(what, false);
    }

    private void setDoc(final UiDocument next) {
        String selectedId = selection == null ? null : idAt(doc, selection);
        doc = next;
        selection = reselect(next, selection, selectedId);
        screen.adopt(next);
    }

    private static @Nullable String idAt(final UiDocument d, final UiEdit.Path p) {
        Element e = UiEdit.elementAt(d, p);
        return e == null ? null : e.id();
    }

    /**
     * Keep the selection across an edit that moved things. An insert or a delete renumbers every
     * sibling after it, so a held path can silently come to mean a different element - the id is
     * followed when there is one, and the selection is dropped rather than left pointing at a
     * stranger.
     */
    private static UiEdit.@Nullable Path reselect(final UiDocument next, final UiEdit.@Nullable Path old,
                                                  final @Nullable String oldId) {
        if (old == null) {
            return null;
        }
        if (oldId != null) {
            UiEdit.Path byId = UiEdit.pathOf(next, oldId);
            if (byId != null) {
                return byId;
            }
        }
        return UiEdit.elementAt(next, old) == null ? null : old;
    }

    private void fail(final UiParseException e) {
        // The parser's own problem list, at the parser's own paths: the message the file would have
        // given. Nothing is applied, so the document on screen is still the last good one.
        say(e.getMessage().replace('\n', ' '), true);
    }

    // ---------------------------------------------------------------------------------------------
    // Chrome

    /**
     * Rebuild the editor's furniture and its hit-test index. Called at the end of every
     * {@code init()} of the screen, which is also after every edit - so the palette, the inspector
     * and the rectangles are never one edit behind.
     */
    public void install(final Consumer<AbstractWidget> add) {
        chrome.clear();
        rows.clear();
        rects.clear();
        // ONLY the editable elements (UI_PARTS_LIBRARY_DESIGN.md section 5.2 rule 5). The screen's
        // rectangle index covers a macro's expansion too, because the renderers need it - but a part's
        // contents are the part file's, so offering them to the hit test would let a human select a
        // thing no edit can reach. A macro's own rectangle IS in there: the instance is one object.
        Map<String, int[]> all = screen.rectsByPath();
        for (UiEdit.Placed p : UiEdit.walk(doc)) {
            String path = p.path().format();
            if (p.element().kind().isSlot()) {
                // Slots are the menu's, not widgets, so their geometry comes from the document -
                // which is exactly section 4.5's point: it is the same number on both sides.
                rects.put(path, slotRect(p.element()));
            } else if (all.containsKey(path)) {
                rects.put(path, all.get(path));
            }
        }
        toolbar(add);
        palette(add);
        inspector(add);
        if (focusRow != null) {
            for (Row r : rows) {
                if (r.key().equals(focusRow)) {
                    r.box().setFocused(true);
                    r.box().moveCursorToEnd(false);
                }
            }
        }
    }

    private int[] slotRect(final Element e) {
        int left = screen.panelLeft();
        int top = screen.panelTop();
        if (e instanceof Element.Slot s) {
            return new int[] {left + s.x() - 1, top + s.y() - 1, 18, 18};
        }
        Element.SlotGrid g = (Element.SlotGrid) e;
        return new int[] {left + g.x() - 1, top + g.y() - 1, g.cols() * 18, g.rows() * 18};
    }

    private AbstractWidget chrome(final AbstractWidget w, final Consumer<AbstractWidget> add) {
        chrome.add(w);
        add.accept(w);
        return w;
    }

    private void toolbar(final Consumer<AbstractWidget> add) {
        int x = 2;
        int y = 2;
        // Widths measured against the labels rather than guessed: the first build had "dele..",
        // "pare.." and "exit e.." on screen, which a probe reading labels off the widget tree
        // cannot see at all.
        x += btn(add, x, y, 30, "save", b -> save()).getWidth() + 2;
        // The depth rides the button, not the status line: state that has a widget belongs on it,
        // and the status line has room for exactly the things that do not (which document, which
        // file, which menu, and what just happened).
        // 44, not 38: a badge takes its width out of the LABEL's room (UiChrome.Btn), and 38 rendered
        // "und.. 0" - slice 4's own truncation defect, walked back into by adding the badge.
        x += btn(add, x, y, 44, "undo", b -> undo()).badge(String.valueOf(undo.size())).getWidth() + 2;
        x += btn(add, x, y, 44, "redo", b -> redo()).badge(String.valueOf(redo.size())).getWidth() + 2;
        UiChrome.Btn snapBtn = new UiChrome.Btn(x, y, 52, ROW_H, "snap", b -> toggleSnap());
        snapBtn.toggled(snap != 1).badge(snap + "px");
        chrome(snapBtn, add);
        x += 54;
        UiChrome.Btn genBtn = new UiChrome.Btn(x, y, 46, ROW_H, "gen", b -> toggleRegenerate());
        genBtn.toggled(regenerate).badge(regenerate ? "on" : "off");
        chrome(genBtn, add);
        x += 48;
        x += btn(add, x, y, 40, "delete", b -> deleteSelection()).getWidth() + 2;
        // Selecting a container: a click finds the SMALLEST rectangle under it, which is what a
        // human means every time except when they mean the box around it. Every layout editor grows
        // this button for the same reason.
        x += btn(add, x, y, 40, "parent", b -> selectParent()).getWidth() + 2;
        btn(add, x, y, 52, "exit edit", b -> screen.leaveEdit());
    }

    private UiChrome.Btn btn(final Consumer<AbstractWidget> add, final int x, final int y, final int w,
                             final String label, final Consumer<UiChrome.Btn> onPress) {
        return btn(add, x, y, w, ROW_H, label, onPress);
    }

    private UiChrome.Btn btn(final Consumer<AbstractWidget> add, final int x, final int y, final int w,
                             final int h, final String label, final Consumer<UiChrome.Btn> onPress) {
        UiChrome.Btn b = new UiChrome.Btn(x, y, w, h, label, onPress);
        chrome(b, add);
        return b;
    }

    /**
     * <b>The palette, enumerated from the registry.</b> {@code Kind.values()}, in declaration order,
     * one button each - so a kind that exists is offered and a kind that is offered exists. The
     * menagerie-review discipline (subjects enumerated from the enums so they cannot go stale), and
     * here it is what makes "the palette IS the library" true rather than aspirational.
     */
    private void palette(final Consumer<AbstractWidget> add) {
        Kind[] kinds = Kind.values();
        int top = 16 + 10;
        int room = screen.height - top - 26;
        int pitch = Math.max(8, Math.min(ROW_H, room / kinds.length));
        for (int i = 0; i < kinds.length; i++) {
            Kind kind = kinds[i];
            btn(add, 2, top + i * pitch, PALETTE_W, pitch - 1, kind.jsonName(), b -> addKind(kind));
        }
    }

    /**
     * The property inspector, read from {@link UiParser#propertyKeys} - the parser's own table, so
     * the inspector offers exactly the keys the format has and a key it does not know is a key
     * nothing knows.
     *
     * <p>Sorted, deliberately: {@code Set.of} iteration order varies per JVM run in this workbench's
     * experience, and an inspector whose rows move between launches is unusable and untestable.
     */
    private void inspector(final Consumer<AbstractWidget> add) {
        Font font = screen.fontRef();
        int x = Math.max(PALETTE_W + 6, screen.width - INSPECTOR_W - 2);
        int y = 16;
        Element selected = selection == null ? null : UiEdit.elementAt(doc, selection);
        List<String> keys = new ArrayList<>();
        boolean screenLevel = selected == null;
        if (screenLevel) {
            keys.addAll(List.of("title", "width", "height", "title_pos", "inventory_label", "background"));
        } else {
            keys.add("id");
            if (selection.insideLayout()) {
                keys.addAll(List.of("offset", "padding", "align"));
                Element parent = UiEdit.elementAt(doc, selection.parent());
                if (parent != null && parent.kind() == Kind.GRID) {
                    keys.addAll(List.of("row", "col", "row_span", "col_span"));
                }
            } else {
                keys.addAll(List.of("x", "y"));
            }
            // The parser's own table - and for a PART instance, the table its part file declares,
            // which is what makes "filled in and configured" the inspector over `params` (section 5.2
            // rule 5) rather than a second property list to keep in step.
            keys.addAll(UiParser.propertyKeys(selected));
            keys.remove("children"); // a subtree is not a text field; select the child instead
        }
        y += 10; // the header, drawn by the overlay
        JsonObject json = screenLevel ? UiWriter.write(doc) : elementJson(selection);
        for (String key : keys) {
            int boxX = x + KEY_W;
            EditBox box = new EditBox(font, boxX, y, INSPECTOR_W - KEY_W - 2, ROW_H, Component.literal(key));
            box.setMaxLength(256);
            box.setValue(json != null && json.has(key) ? UiWriter.pretty(json.get(key)).replace("\n", "") : "");
            // setValue leaves the cursor at the END, so a value longer than the box shows its TAIL
            // ("ogress_bar" for "progress_bar"). Show the head: a property inspector is read before
            // it is typed into.
            box.moveCursorToStart(false);
            rows.add(new Row(key, screenLevel, box));
            chrome(box, add);
            y += ROW_H + 2;
            if (y > screen.height - 26) {
                break;
            }
        }
    }

    private @Nullable JsonObject elementJson(final UiEdit.Path path) {
        JsonObject root = UiWriter.write(doc);
        com.google.gson.JsonElement level = root.get("elements");
        JsonObject found = null;
        for (int step : path.steps()) {
            if (level == null || !level.isJsonArray() || step >= level.getAsJsonArray().size()) {
                return null;
            }
            found = level.getAsJsonArray().get(step).getAsJsonObject();
            level = found.get("children");
        }
        return found;
    }

    // ---------------------------------------------------------------------------------------------
    // Commands

    private void selectParent() {
        if (selection == null) {
            say("nothing selected", false);
            return;
        }
        if (!selection.insideLayout()) {
            select(null);
            say("selected the screen (that element is top-level)", false);
            return;
        }
        UiEdit.Path parent = selection.parent();
        select(parent);
        Element e = UiEdit.elementAt(doc, parent);
        say("selected " + (e == null ? parent.format() : e.kind().jsonName()
            + (e.id() == null ? " at " + parent.format() : " '" + e.id() + "'")), false);
    }

    private void toggleSnap() {
        snap = snap == 1 ? UiEdit.SLOT_PITCH : 1;
        say("snap " + snap + "px", false);
        screen.adopt(doc);
    }

    public void undo() {
        if (undo.isEmpty()) {
            say("nothing to undo", false);
            return;
        }
        redo.push(doc);
        UiDocument prev = undo.pop();
        dirty = true; // the file on disk is still whatever it was; only a save settles that
        setDoc(prev);
        say("undo (" + undo.size() + " left)", false);
    }

    public void redo() {
        if (redo.isEmpty()) {
            say("nothing to redo", false);
            return;
        }
        undo.push(doc);
        setDoc(redo.pop());
        dirty = true;
        say("redo (" + redo.size() + " left)", false);
    }

    private void addKind(final Kind kind) {
        // Into the selected layout node when there is one, else at the top level under the cursor's
        // last known spot - the panel's top-left plus a step, which is always inside the screen.
        //
        // ...unless the kind cannot LIVE in a layout, which is Kind's own predicate rather than a
        // copy of it: a slot's geometry is shared with the menu and a macro is a group of absolutely
        // placed elements. Palette-clicking one while a layout child happens to be selected would
        // otherwise be a refusal about where the human was standing, not about what they asked for.
        UiEdit.Path parent = UiEdit.Path.ROOT;
        Element selected = !kind.allowedInLayout() || selection == null
            ? null : UiEdit.elementAt(doc, selection);
        if (selected != null && selected.kind().isLayout()) {
            parent = selection;
        } else if (selected != null && selection.insideLayout()) {
            parent = selection.parent();
        }
        try {
            UiEdit.Path where = parent;
            UiEdit.Added added = edit(() -> UiEdit.add(doc, kind, where, 8, 8));
            String selectedId = idAt(added.doc(), added.path());
            undo.push(doc);
            redo.clear();
            dirty = true;
            doc = added.doc();
            selection = added.path();
            screen.adopt(doc);
            say("added " + kind.jsonName() + (selectedId == null ? "" : " '" + selectedId + "'")
                + " at " + added.path().format(), false);
        } catch (UiParseException e) {
            fail(e);
        }
    }

    private void deleteSelection() {
        if (selection == null) {
            say("nothing selected", false);
            return;
        }
        Element e = UiEdit.elementAt(doc, selection);
        try {
            UiDocument next = edit(() -> UiEdit.remove(doc, selection));
            UiEdit.Path gone = selection;
            selection = null;
            undo.push(doc);
            redo.clear();
            dirty = true;
            doc = next;
            screen.adopt(next);
            say("deleted " + (e == null ? gone.format() : e.kind().jsonName()
                + (e.id() == null ? " at " + gone.format() : " '" + e.id() + "'")), false);
        } catch (UiParseException ex) {
            fail(ex);
        }
    }

    /** Commit one inspector row through the parser. An empty box removes the key. */
    private void commit(final Row row) {
        String text = row.box().getValue().trim();
        try {
            com.google.gson.JsonElement value = text.isEmpty() ? null : UiEdit.value(text);
            focusRow = row.key();
            if (row.screenLevel()) {
                apply(edit(() -> UiEdit.setScreen(doc, row.key(), value)),
                    text.isEmpty() ? "cleared " + row.key() : row.key() + " = " + text);
                if (doc.width() != screen.imageWidth() || doc.height() != screen.imageHeight()) {
                    say("size is now " + doc.width() + "x" + doc.height()
                        + "; imageWidth/imageHeight are final in vanilla, so reopen the preview to apply it", true);
                }
            } else if (selection != null) {
                apply(edit(() -> UiEdit.set(doc, selection, row.key(), value)),
                    text.isEmpty() ? "cleared " + row.key() : row.key() + " = " + text);
            }
        } catch (UiParseException e) {
            fail(e);
        }
    }

    /** Write the document out. The source tree is the truth; the loaded pack is kept in step. */
    public String save() {
        if (target == null) {
            resolveTarget();
        }
        if (target == null) {
            say(targetError == null ? "no save target" : targetError, true);
            return message;
        }
        try {
            String result = UiSaveTarget.write(target, UiWriter.toJson(doc));
            dirty = false;
            regenerateFrom(target);
            say(generated == null ? result : result + "; " + generated, generateFailed);
        } catch (IOException e) {
            say("could not write " + target.file() + ": " + e.getMessage(), true);
        }
        return message;
    }

    private void toggleRegenerate() {
        regenerate = !regenerate;
        generated = null;
        generateFailed = false;
        say(regenerate ? "a save will regenerate this mod's Java" : "a save writes the DOCUMENT ONLY -"
            + " the generated Java will be stale until `gradlew generateUi` or ui_doc op:generate", !regenerate);
        screen.adopt(doc); // rebuilds the furniture, so the button's own badge tells the truth
    }

    /**
     * Run the emitter over the mod this document belongs to, in-process.
     *
     * <p><b>A failure here is not a failed save.</b> The document is on disk either way, and the two
     * ways this can decline are different things: a project that never opted in ({@code mcmod.ui.package}
     * absent) is a fact about the mod, said once and quietly; an emitter that threw is an error and
     * says so in red. Neither undoes the write.
     */
    private void regenerateFrom(final UiSaveTarget.Target where) {
        generated = null;
        generateFailed = false;
        if (!regenerate) {
            return;
        }
        UiProject project;
        try {
            project = UiProject.of(where.file());
        } catch (IOException e) {
            generated = "not generated (" + e.getMessage() + ")";
            return;
        }
        try {
            UiGenerate.Report report = project.run(Target.FABRIC, false);
            int written = 0;
            for (UiGenerate.Fate f : report.files().values()) {
                if (f == UiGenerate.Fate.WRITTEN || f == UiGenerate.Fate.STUB_WRITTEN) {
                    written++;
                }
            }
            generated = written == 0
                ? "generated Java already matched"
                : "rewrote " + written + " generated file(s) - the game runs the OLD classes until a rebuild";
            if (!report.problems().isEmpty()) {
                generated = generated + "; " + String.join("; ", report.problems());
                generateFailed = true;
            }
        } catch (IOException | RuntimeException e) {
            generated = "SAVED, but generate failed: " + e.getMessage();
            generateFailed = true;
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Mouse

    /** Is the point over the editor's own furniture? Those clicks belong to the widgets. */
    public boolean overChrome(final double mx, final double my) {
        for (AbstractWidget w : chrome) {
            if (w.visible && mx >= w.getX() && mx < w.getX() + w.getWidth()
                && my >= w.getY() && my < w.getY() + w.getHeight()) {
                return true;
            }
        }
        return false;
    }

    public boolean mousePressed(final double mx, final double my, final int button) {
        if (button != 0) {
            return false;
        }
        escapeArmed = false;
        Handle handle = handleAt(mx, my);
        if (handle != null && selection != null) {
            grab = new Grab(selection, handle, doc, mx, my);
            return true;
        }
        UiEdit.Path hit = pick(mx, my);
        if (hit == null) {
            if (selection != null) {
                select(null);
            }
            return false;
        }
        boolean changed = !hit.equals(selection);
        selection = hit;
        focusRow = null;
        grab = new Grab(hit, Handle.MOVE, doc, mx, my);
        Element e = UiEdit.elementAt(doc, hit);
        say((e == null ? "" : e.kind().jsonName() + " ") + hit.format()
            + (e != null && e.id() != null ? " '" + e.id() + "'" : ""), false);
        if (changed) {
            screen.adopt(doc); // the inspector follows the selection
        }
        return true;
    }

    public boolean mouseDragged(final double mx, final double my) {
        if (grab == null) {
            return false;
        }
        int rawDx = (int) Math.round(mx - grab.px());
        int rawDy = (int) Math.round(my - grab.py());
        Element base = UiEdit.elementAt(grab.base(), grab.path());
        if (base == null) {
            return false;
        }
        try {
            UiDocument next = grab.base();
            Handle h = grab.handle();
            int dx = 0;
            int dy = 0;
            if (h.movesX() || h.movesY()) {
                int wantX = h.movesX() ? rawDx : 0;
                int wantY = h.movesY() ? rawDy : 0;
                if (grab.path().insideLayout()) {
                    dx = snapDelta(wantX);
                    dy = snapDelta(wantY);
                } else {
                    Element.Placement.Absolute a = (Element.Placement.Absolute) base.placement();
                    dx = snapTo(a.x() + wantX) - a.x();
                    dy = snapTo(a.y() + wantY) - a.y();
                }
                if (dx != 0 || dy != 0) {
                    UiDocument from = next;
                    int stepX = dx;
                    int stepY = dy;
                    next = edit(() -> UiEdit.dragBy(from, grab.path(), stepX, stepY));
                }
            }
            if (h.sizesX() || h.sizesY()) {
                // A left/top handle moved the origin, so the size takes the opposite delta.
                int w = base.w() + (h.sizesX() ? (h.movesX() ? -dx : snapSize(base.w(), rawDx)) : 0);
                int hh = base.h() + (h.sizesY() ? (h.movesY() ? -dy : snapSize(base.h(), rawDy)) : 0);
                UiDocument from = next;
                next = edit(() -> UiEdit.resize(from, grab.path(), Math.max(1, w), Math.max(1, hh)));
            }
            if (!next.equals(doc)) {
                dirty = true;
                doc = next;
                screen.adopt(next);
            }
            return true;
        } catch (UiParseException e) {
            fail(e);
            return true;
        }
    }

    public boolean mouseReleased(final double mx, final double my) {
        if (grab == null) {
            return false;
        }
        // ONE undo entry for the whole drag, and none at all for a drag that changed nothing (a
        // click to select is a drag of zero pixels).
        if (!grab.base().equals(doc)) {
            undo.push(grab.base());
            while (undo.size() > UNDO_LIMIT) {
                undo.removeLast();
            }
            redo.clear();
            Element e = UiEdit.elementAt(doc, grab.path());
            say((e == null ? grab.path().format() : e.kind().jsonName()) + " "
                + (grab.handle() == Handle.MOVE ? "moved" : "resized") + " (unsaved)", false);
        }
        grab = null;
        return true;
    }

    private int snapTo(final int v) {
        return snap <= 1 ? v : Math.round(v / (float) snap) * snap;
    }

    private int snapDelta(final int d) {
        return snap <= 1 ? d : Math.round(d / (float) snap) * snap;
    }

    private int snapSize(final int base, final int delta) {
        return snap <= 1 ? delta : snapTo(base + delta) - base;
    }

    /**
     * The element under the point: the SMALLEST rectangle containing it, later-declared winning a
     * tie. A panel is bigger than the label on it and a layout node is bigger than its children, so
     * this picks the thing a human means without needing a z-order the document does not have.
     */
    private UiEdit.@Nullable Path pick(final double mx, final double my) {
        String best = null;
        long bestArea = Long.MAX_VALUE;
        for (Map.Entry<String, int[]> e : rects.entrySet()) {
            int[] r = e.getValue();
            if (mx < r[0] || mx >= r[0] + r[2] || my < r[1] || my >= r[1] + r[3]) {
                continue;
            }
            long area = (long) Math.max(1, r[2]) * Math.max(1, r[3]);
            if (area <= bestArea) {
                bestArea = area;
                best = e.getKey();
            }
        }
        return best == null ? null : UiEdit.Path.parse(best);
    }

    /** Which resize handle is under the point, or {@code null}. */
    private @Nullable Handle handleAt(final double mx, final double my) {
        int[] r = selectionRect();
        if (r == null || !resizable()) {
            return null;
        }
        for (Handle h : Handle.values()) {
            if (h == Handle.MOVE) {
                continue;
            }
            int[] c = handleCenter(r, h);
            if (Math.abs(mx - c[0]) <= HANDLE && Math.abs(my - c[1]) <= HANDLE) {
                return h;
            }
        }
        return null;
    }

    private static int[] handleCenter(final int[] r, final Handle h) {
        int midX = r[0] + r[2] / 2;
        int midY = r[1] + r[3] / 2;
        return switch (h) {
            case N -> new int[] {midX, r[1]};
            case S -> new int[] {midX, r[1] + r[3]};
            case E -> new int[] {r[0] + r[2], midY};
            case W -> new int[] {r[0], midY};
            case NE -> new int[] {r[0] + r[2], r[1]};
            case NW -> new int[] {r[0], r[1]};
            case SE -> new int[] {r[0] + r[2], r[1] + r[3]};
            case SW -> new int[] {r[0], r[1] + r[3]};
            default -> new int[] {midX, midY};
        };
    }

    private @Nullable int[] selectionRect() {
        return selection == null ? null : rects.get(selection.format());
    }

    /** A kind is resizable when the format lets it declare a size (a slot grid, in slots). */
    private boolean resizable() {
        Element e = selection == null ? null : UiEdit.elementAt(doc, selection);
        if (e == null) {
            return false;
        }
        if (e.kind() == Kind.SLOT_GRID) {
            return true;
        }
        // A macro has no size of its own: it is an origin, and the fragment sizes what it expands to.
        return UiParser.propertyKeys(e.kind()).contains("w") && !e.kind().isLayout() && !e.kind().isMacro();
    }

    // ---------------------------------------------------------------------------------------------
    // Keyboard

    public boolean keyPressed(final KeyEvent event) {
        Row focused = focusedRow();
        if (focused != null) {
            if (event.isConfirmation()) {
                commit(focused);
                return true;
            }
            if (event.isEscape()) {
                focused.box().setFocused(false);
                focusRow = null;
                screen.adopt(doc); // discard the typing by rebuilding the row from the document
                return true;
            }
            return false; // everything else belongs to the box
        }
        if (event.hasControlDown()) {
            switch (event.key()) {
                case InputConstants.KEY_Z -> {
                    if (event.hasShiftDown()) {
                        redo();
                    } else {
                        undo();
                    }
                    return true;
                }
                case InputConstants.KEY_Y -> {
                    redo();
                    return true;
                }
                case InputConstants.KEY_S -> {
                    save();
                    return true;
                }
                case InputConstants.KEY_B -> {
                    toggleSnap();
                    return true;
                }
                default -> { }
            }
        }
        if (event.key() == InputConstants.KEY_DELETE || event.key() == InputConstants.KEY_BACKSPACE) {
            deleteSelection();
            return true;
        }
        if (selection != null && (event.isLeft() || event.isRight() || event.isUp() || event.isDown())) {
            int step = event.hasShiftDown() ? UiEdit.SLOT_PITCH : 1;
            int dx = event.isLeft() ? -step : event.isRight() ? step : 0;
            int dy = event.isUp() ? -step : event.isDown() ? step : 0;
            try {
                apply(edit(() -> UiEdit.dragBy(doc, selection, dx, dy)), "nudged " + dx + "," + dy);
            } catch (UiParseException e) {
                fail(e);
            }
            return true;
        }
        if (event.isEscape()) {
            if (selection != null) {
                select(null);
                return true;
            }
            if (dirty && !escapeArmed) {
                // Unsaved edits live only in this document. Say so once rather than discarding them
                // on a keypress that usually means "close".
                escapeArmed = true;
                say("UNSAVED edits - press Escape again to discard them, or Ctrl+S to save", true);
                return true;
            }
        }
        return false;
    }

    private @Nullable Row focusedRow() {
        for (Row r : rows) {
            if (r.box().isFocused()) {
                return r;
            }
        }
        return null;
    }

    // ---------------------------------------------------------------------------------------------
    // Overlay

    public void drawOverlay(final GuiGraphicsExtractor g, final int mouseX, final int mouseY) {
        Font font = screen.fontRef();
        g.nextStratum();

        // What the player will never see: a region's rectangle and a layout node's bounds. Both
        // paint nothing in either renderer (open decision 7), so both are the editor's job.
        for (UiEdit.Placed p : UiEdit.walk(doc)) {
            int[] r = rects.get(p.path().format());
            if (r == null) {
                continue;
            }
            if (p.element().kind() == Kind.REGION) {
                UiChrome.dashed(g, r[0], r[1], r[2], r[3], UiChrome.REGION);
            } else if (p.element().kind().isMacro()) {
                // A macro paints nothing in either renderer either: what the human drags is the union
                // of what it expanded to, so the editor draws that boundary or there is nothing to aim at.
                UiChrome.dashed(g, r[0], r[1], r[2], r[3], UiChrome.NODE);
            } else if (p.element().kind().isLayout()) {
                UiChrome.dashed(g, r[0], r[1], r[2], r[3], UiChrome.NODE);
            }
            if (p.element().placement() instanceof Element.Placement.Cell c && c.hasOffset()) {
                // The override marker: the layout put it there, a human moved it here.
                UiChrome.outline(g, r[0] - c.dx(), r[1] - c.dy(), Math.max(2, r[2]), Math.max(2, r[3]),
                    UiChrome.OFFSET_MARK);
                g.fill(r[0], r[1], r[0] + 2, r[1] + 2, UiChrome.OFFSET_MARK);
            }
        }

        // The panel's own edge, so the document's bounds are visible even when it draws no frame.
        UiChrome.outline(g, screen.panelLeft() - 1, screen.panelTop() - 1,
            screen.imageWidth() + 2, screen.imageHeight() + 2, UiChrome.CHROME_BORDER);

        if (grab == null && !overChrome(mouseX, mouseY)) {
            UiEdit.Path hover = pick(mouseX, mouseY);
            if (hover != null && !hover.equals(selection)) {
                int[] r = rects.get(hover.format());
                if (r != null) {
                    UiChrome.outline(g, r[0], r[1], r[2], r[3], UiChrome.HOVER);
                }
            }
        }

        int[] sel = selectionRect();
        if (sel != null) {
            UiChrome.outline(g, sel[0] - 1, sel[1] - 1, sel[2] + 2, sel[3] + 2, UiChrome.SELECT);
            if (resizable()) {
                for (Handle h : Handle.values()) {
                    if (h == Handle.MOVE) {
                        continue;
                    }
                    int[] c = handleCenter(sel, h);
                    UiChrome.handle(g, c[0], c[1], HANDLE);
                }
            }
            Element e = UiEdit.elementAt(doc, selection);
            if (e != null) {
                String readout = geometry(e, sel);
                int ty = sel[1] - 11 < 24 ? sel[1] + sel[3] + 3 : sel[1] - 11;
                g.fill(sel[0] - 1, ty - 1, sel[0] + font.width(readout) + 2, ty + 9, 0xC0000000);
                g.text(font, readout, sel[0] + 1, ty, UiChrome.SELECT, false);
            }
        }

        headers(g, font);
        status(g, font);
    }

    private String geometry(final Element e, final int[] rect) {
        if (e.placement() instanceof Element.Placement.Absolute a) {
            return a.x() + "," + a.y() + " " + rect[2] + "x" + rect[3];
        }
        Element.Placement.Cell c = (Element.Placement.Cell) e.placement();
        return "in layout" + (c.hasOffset() ? " offset " + c.dx() + "," + c.dy() : "")
            + " " + rect[2] + "x" + rect[3];
    }

    private void headers(final GuiGraphicsExtractor g, final Font font) {
        int paletteTop = 16;
        g.fill(1, paletteTop - 1, 3 + PALETTE_W, paletteTop + 9, 0xC0000000);
        g.text(font, "palette", 3, paletteTop, UiChrome.CHROME_TEXT_DIM, false);

        int x = Math.max(PALETTE_W + 6, screen.width - INSPECTOR_W - 2);
        Element selected = selection == null ? null : UiEdit.elementAt(doc, selection);
        String header = selected == null ? "screen" : selected.kind().jsonName()
            + (selected.id() == null ? "" : " " + selected.id());
        g.fill(x - 1, 15, x + INSPECTOR_W, 25, 0xC0000000);
        g.text(font, UiChrome.clip(font, header, INSPECTOR_W - 4), x + 1, 16, UiChrome.CHROME_TEXT, false);
        for (Row r : rows) {
            g.text(font, UiChrome.clip(font, r.key(), KEY_W - 3), x + 1, r.box().getY() + 2,
                UiChrome.CHROME_TEXT_DIM, false);
        }
    }

    private void status(final GuiGraphicsExtractor g, final Font font) {
        int y = screen.height - 20;
        g.fill(0, y - 1, screen.width, screen.height, 0xD0000000);
        String where = target != null ? target.file().getFileName().toString()
            : "NO SAVE TARGET (" + (targetError == null ? "?" : "see below") + ")";
        boolean attached = !screen.isDetached();
        String line = (dirty ? "*" : " ") + screen.source().describe() + "  ->  " + where
            + (attached ? "   ATTACHED to " + screen.menu().getClass().getSimpleName() : "");
        g.text(font, UiChrome.clip(font, line, screen.width - 4), 2, y, UiChrome.CHROME_TEXT, false);
        // The key hints live on the SECOND line, which is idle most of the time - on the first they
        // were the part that got clipped away, and a hint nobody can read is worse than no hint.
        // `gen` is not here either: its button says on or off, one place.
        String hints = "ctrl+s save, ctrl+z undo, ctrl+b snap, arrows nudge, ctrl+g leave"
            + (attached ? ", ctrl+u back" : "");
        String second = !message.isEmpty() ? message : targetError != null ? targetError : hints;
        if (Math.max(PALETTE_W + 6, screen.width - INSPECTOR_W - 2) < screen.panelLeft() + imageRight()) {
            // The chrome is sitting ON the document. Nothing can be done about it here - it is the
            // GUI scale - but an editor that silently covers the thing being edited is worse than
            // one that says so.
            second = "the GUI scale leaves no room beside the panel: the inspector is covering the"
                + " document. Lower it in Options > Video Settings.";
        }
        if (!second.isEmpty()) {
            g.text(font, UiChrome.clip(font, second, screen.width - 4), 2, y + 10,
                messageIsError || targetError != null ? UiChrome.ERROR_TEXT
                    : message.isEmpty() ? UiChrome.CHROME_TEXT_DIM : UiChrome.OK_TEXT, false);
        }
    }

    /** The panel's right edge, panel-relative - what the inspector must stay clear of. */
    private int imageRight() {
        return screen.imageWidth();
    }

    // ---------------------------------------------------------------------------------------------
    // What get_screen reports

    /**
     * The editor's state, for {@code get_screen} - so a probe (or an agent) can see the selection,
     * the palette, the undo depth and the save target without a screenshot.
     */
    public JsonObject report() {
        JsonObject o = new JsonObject();
        o.addProperty("on", true);
        o.addProperty("dirty", dirty);
        o.addProperty("snap", snap);
        o.addProperty("undo", undo.size());
        o.addProperty("redo", redo.size());
        if (selection != null) {
            o.addProperty("selected", selection.format());
            Element e = UiEdit.elementAt(doc, selection);
            if (e != null) {
                o.addProperty("selected_kind", e.kind().jsonName());
                if (e.id() != null) {
                    o.addProperty("selected_id", e.id());
                }
                o.addProperty("resizable", resizable());
            }
            int[] r = selectionRect();
            if (r != null) {
                JsonArray rect = new JsonArray();
                for (int v : r) {
                    rect.add(v);
                }
                o.add("selected_rect", rect);
            }
        }
        JsonArray palette = new JsonArray();
        for (Kind k : Kind.values()) {
            palette.add(k.jsonName());
        }
        o.add("palette", palette);
        JsonArray keys = new JsonArray();
        for (Row r : rows) {
            keys.add(r.key());
        }
        o.add("inspector", keys);
        if (target != null) {
            o.addProperty("save_target", target.file().toString());
            if (target.mirror() != null) {
                o.addProperty("save_mirror", target.mirror().toString());
            }
            o.addProperty("save_target_rule", target.how());
        }
        if (targetError != null) {
            o.addProperty("save_problem", targetError);
        }
        o.addProperty("regenerate", regenerate);
        if (generated != null) {
            o.addProperty("generated", generated);
        }
        if (!message.isEmpty()) {
            o.addProperty("message", message);
            o.addProperty("message_is_error", messageIsError);
        }
        return o;
    }
}
