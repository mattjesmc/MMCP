package com.mattmc.mcptoolkit.client;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import com.mattmc.mcptoolkit.ExecutionContext;
import com.mattmc.mcptoolkit.McpTools;
import com.mattmc.mcptoolkit.Mechanism;
import com.mattmc.mcptoolkit.Schemas;
import com.mattmc.mcptoolkit.ToolDef;
import com.mattmc.mcptoolkit.hooks.client.ToolkitScreens;
import com.mojang.blaze3d.platform.InputConstants;
import net.fabricmc.api.EnvType;
import net.fabricmc.api.Environment;
import net.minecraft.client.InputType;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.components.AbstractScrollArea;
import com.mattmc.mcptoolkit.ui.GeneratedScreens;
import com.mattmc.mcptoolkit.ui.doc.UiParseException;
import com.mattmc.mcptoolkit.ui.interp.InterpretedScreen;
import com.mattmc.mcptoolkit.ui.interp.UiDeclared;
import com.mattmc.mcptoolkit.ui.interp.UiPreview;
import com.mattmc.mcptoolkit.ui.interp.UiSource;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.resources.Identifier;
import net.minecraft.client.gui.components.EditBox;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.gui.screens.TitleScreen;
import net.minecraft.client.gui.screens.inventory.AbstractContainerScreen;
import net.minecraft.client.input.CharacterEvent;
import net.minecraft.client.input.KeyEvent;
import net.minecraft.client.input.MouseButtonEvent;
import net.minecraft.client.input.MouseButtonInfo;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.inventory.Slot;
import net.minecraft.world.item.ItemStack;
import org.jspecify.annotations.Nullable;

import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.List;
import java.util.concurrent.CompletableFuture;

/**
 * Client UI tools: inspect the current screen at three abstraction levels (widget tree, container/menu
 * state, screenshot), drive it (click, type, open/close), and read the passively-recorded navigation
 * graph. All run on the client thread.
 */
@Environment(EnvType.CLIENT)
public final class UiTools {
    private UiTools() {}

    private static final Gson GSON = new Gson();

    public static void register() {
        UiFalsifier.register();
        com.mattmc.mcptoolkit.ui.UiDocTools.installClient(UI_DOC_CLIENT);
        // The human's half of the attached preview (section 6.1): ctrl+U on any container screen
        // swaps the interpreter in over its live menu, and again puts the screen back. The tools
        // below do the same thing for an agent; this is the one that works with a mouse in hand.
        com.mattmc.mcptoolkit.hooks.client.ClientHooks.SCREEN_KEY_PRESSED.register(
            com.mattmc.mcptoolkit.ui.interp.UiAttach::onKeyPressed);
        McpTools.register(ToolDef.async(
            "screenshot",
            "Capture the current game framebuffer as a PNG image (whatever is on screen right now — menu or world).",
            Schemas.object(),
            ExecutionContext.CLIENT,
            Mechanism.OBSERVE,
            UiTools::screenshot));

        McpTools.register(ToolDef.of(
            "get_screen",
            "Describe the currently open screen: its class/title, the widget tree walked recursively (rows inside lists/containers carry nested:true), and — for container screens — the menu's non-empty slots and any synced status record. unenumerated_listeners counts interactive children that could not be rendered as widget rows (the tree's disclosed blind spot). Returns {\"screen\":null} when no screen is open. `detail` (summary, default | layout): summary answers what this screen is and what can be clicked — index, label, class, and only the state flags actually set; layout adds every widget's x/y/width/height, the screen size, and each slot's pixel position, needed only for UI DESIGN work (check_layout, measure_text, screenshot_annotated) or clicking by raw coordinates. Clicking by label or index needs no geometry.",
            Schemas.objectOpt(Schemas.object(
                "detail", Schemas.str("summary (default) | layout — layout adds pixel geometry.")),
                "detail"),
            ExecutionContext.CLIENT,
            Mechanism.OBSERVE,
            (ctx, a) -> getScreen(a)));

        McpTools.register(ToolDef.of(
            "click",
            "Drive the pointer on the current screen: CLICK a widget, DRAG from it to a destination, SCROLL the wheel over it, or HOVER over it (hover:true moves the pointer there and presses nothing, so the frames after render with it there - hover faces and the tooltip zones a screen draws off the pointer - until the next real mouse movement). Target by \"label\", \"index\" (from get_screen) or raw \"x\"/\"y\". Routes real mouse events through the screen, so list rows and container slots work too. Verified rather than assumed: another widget sitting at the target's point blocks the dispatch and blocked_by names it; clicked/handled say the SCREEN took the event, which vanilla answers whenever a child was at the point — the block check above is what makes that the right child; a drag whose opening press the child did not consume never enters drag mode (vanilla gates mouseDragged on isDragging) and says so; and a scroll reports scrolled_from/scrolled_to, because a scroll area consumes the wheel even when it is already at the end.",
            Schemas.objectOpt(
                Schemas.object("label", Schemas.str("Case-insensitive substring of the widget's label."),
                    "index", Schemas.integer("Widget index from get_screen."),
                    "x", Schemas.number("Screen x (GUI-scaled)."),
                    "y", Schemas.number("Screen y (GUI-scaled)."),
                    "hover", Schemas.bool("Move the pointer to the target and press nothing. Takes no button, wheel or destination."),
                    "button", Schemas.integer("0=left (default), 1=right."),
                    "scroll", Schemas.number("Wheel notches, vanilla's sign: POSITIVE scrolls toward the top of the list, negative toward the bottom."),
                    "scroll_x", Schemas.number("Horizontal wheel notches (rare)."),
                    "to_label", Schemas.str("Drag destination widget, by label."),
                    "to_index", Schemas.integer("Drag destination widget, by index."),
                    "to_x", Schemas.number("Drag destination x."),
                    "to_y", Schemas.number("Drag destination y."),
                    "steps", Schemas.integer("Intermediate drag events (default 4, max 64).")),
                "label", "index", "x", "y", "hover", "button", "scroll", "scroll_x",
                "to_label", "to_index", "to_x", "to_y", "steps"),
            ExecutionContext.CLIENT,
            Mechanism.EMBODIED,
            (ctx, a) -> click(a)));

        McpTools.register(ToolDef.of(
            "send_keys",
            "Send keyboard input to the current screen: press a \"key\" with optional \"modifiers\", and/or type \"text\" as characters. This is the half click cannot reach — tab order, list arrow keys, slider left/right, and any screen whose own keyPressed does the work. Verified rather than assumed: focus_before/focus_after are always reported, because Screen.keyPressed returns FALSE for Tab and the arrow keys even when focus DID move, so `handled` alone reads as nothing-happened; the open screen is re-read after every press (Escape and Enter routinely close it) and a run stops there rather than typing into whatever appeared; and when a focused edit box received the input, its value before and after is reported.",
            Schemas.objectOpt(
                Schemas.object(
                    "key", Schemas.str("Key name: \"tab\", \"enter\", \"escape\", \"up\", \"page.down\", \"left.shift\", \"a\", \"f3\" — the suffix of a key.keyboard.* id (underscores accepted for dots), or the full id."),
                    "modifiers", Schemas.array(Schemas.str("shift | ctrl | alt | super")),
                    "times", Schemas.integer("Repeat the press (default 1, max 64)."),
                    "text", Schemas.str("Typed as individual characters into whatever holds focus; sent BEFORE `key`, so text+enter is one call. To set a box's value outright use set_text.")),
                "key", "modifiers", "times", "text"),
            ExecutionContext.CLIENT,
            Mechanism.EMBODIED,
            (ctx, a) -> sendKeys(a)));

        McpTools.register(ToolDef.of(
            "set_text",
            "Set the text of an edit box on the current screen, targeted by \"label\" or \"index\" (as in click).",
            Schemas.objectOpt(
                Schemas.object("text", Schemas.str("The text to set."),
                    "label", Schemas.str("Case-insensitive substring of the widget's label."),
                    "index", Schemas.integer("Widget index from get_screen.")),
                "label", "index"),
            ExecutionContext.CLIENT,
            Mechanism.EMBODIED,
            (ctx, a) -> setText(a)));

        McpTools.register(ToolDef.of(
            "open_screen",
            "Open a screen. {\"name\":\"title\"} for the main menu; {\"className\":\"<fully.qualified.Screen>\"} to construct a Screen subclass (no-arg or single-Screen-parent constructor); {\"ui\":\"<mod>:<screen>\"} for a DETACHED PREVIEW of a screen-authoring document (assets/<mod>/ui/<screen>.ui.json via the resource manager, so /reload then reopen shows edits) or {\"ui_file\":\"<path>\"} for one on disk. A preview needs the client in a world; its slots hold the document's placeholders and a copy of your inventory, its buttons fire nowhere, and get_screen names every declared element by id and kind. Add {\"edit\":true} to open it in the in-game EDITOR: drag/resize handles, a palette of every element kind, a property inspector, undo/redo and save straight into the mod's source tree. In edit mode a click SELECTS instead of pressing, and get_screen reports an `editor` object (selection, palette, undo depth, save target). Ctrl+G toggles it in the game. Real container screens (chests, workstations) can't be opened this way — they need a server-side menu; interact with the block/click a route instead.",
            Schemas.objectOpt(
                Schemas.object("name", Schemas.str("\"title\" for the main menu."),
                    "className", Schemas.str("Fully-qualified Screen subclass name."),
                    "ui", Schemas.str("A ui document by id, e.g. \"mcptoolkit:example\" -> assets/mcptoolkit/ui/example.ui.json."),
                    "ui_file", Schemas.str("A ui document by path on disk."),
                    "edit", Schemas.bool("Open the preview in the in-game editor (slice 4): handles, palette, inspector, undo, Ctrl+S save. Dev-only, and it writes to the source tree - get_screen's `editor.save_target` says which file before you save anything."),
                    "generated", Schemas.bool("With `ui`: open the document's GENERATED screen (the mod's compiled Java) instead of the interpreted preview, through the integrated server's real menu - the other side of the interpreted-vs-generated comparison. Only for documents a loaded mod registered a generated screen for (the toolkit's own mcptoolkit:example always is). Opens asynchronously: poll get_screen. Its buttons need a NON-SPECTATOR player: vanilla drops a spectator's button clicks server-side while still syncing the data slots."),
                    "falsify", Schemas.str("With `generated`: deliberately corrupt the generated screen as it opens, so the conformance comparison can prove it measures something. \"geometry\" moves the first button 1px (get_screen AND a screenshot differ); \"paint\" halves its alpha (the widget tree is identical, ONLY the pixels differ). get_screen reports `falsified` on such a screen.")),
                "name", "className", "ui", "ui_file", "edit", "generated", "falsify"),
            ExecutionContext.CLIENT,
            Mechanism.EMBODIED,
            (ctx, a) -> openScreen(a)));

        McpTools.register(ToolDef.of(
            "close_screen",
            "Close the current screen (equivalent to pressing Escape). Verified: closed reports whether the screen actually went away, and now_open names what is on screen afterwards — closing can reveal a parent screen or a confirm dialog instead of the game view.",
            Schemas.object(),
            ExecutionContext.CLIENT,
            Mechanism.EMBODIED,
            (ctx, a) -> closeScreen()));

        McpTools.register(ToolDef.of(
            "get_screen_graph",
            "Dump the passively-recorded menu navigation graph: nodes are screen classes (plus \"<none>\" for no-screen), edges are transitions labeled with the widget clicked to cause them.",
            Schemas.object(),
            ExecutionContext.CLIENT,
            Mechanism.OBSERVE,
            (ctx, a) -> ScreenNav.dump()));
    }

    // ---- screenshot (async) --------------------------------------------------

    private static CompletableFuture<JsonElement> screenshot(final com.mattmc.mcptoolkit.ToolContext ctx,
                                                             final JsonObject a) {
        Minecraft mc = Minecraft.getInstance();
        var target = mc.gameRenderer.mainRenderTarget();
        CompletableFuture<JsonElement> out = new CompletableFuture<>();
        // The callback fires on a later render frame; complete the future from there. Never block here.
        net.minecraft.client.Screenshot.takeScreenshot(target, image -> {
            try (image) {
                int width = image.getWidth();
                int height = image.getHeight();
                Path tmp = Files.createTempFile("mcptk-shot", ".png");
                try {
                    image.writeToFile(tmp);
                    byte[] png = Files.readAllBytes(tmp);
                    JsonObject r = new JsonObject();
                    JsonObject img = new JsonObject();
                    img.addProperty("mimeType", "image/png");
                    img.addProperty("base64", Base64.getEncoder().encodeToString(png));
                    r.add("_image", img);
                    r.addProperty("width", width);
                    r.addProperty("height", height);
                    out.complete(r);
                } finally {
                    Files.deleteIfExists(tmp);
                }
            } catch (Exception e) {
                out.completeExceptionally(e);
            }
        });
        return out;
    }

    // ---- get_screen ----------------------------------------------------------

    /**
     * @param a tool args; {@code detail:"layout"} restores the full geometric dump.
     *
     * <p><b>Why summary is the default.</b> Every widget carried twelve fields, most of them pixel
     * geometry, and every container slot carried its x/y plus a {@code null} row for each EMPTY
     * slot — a 27-slot chest holding three items rendered twenty-seven rows. The overwhelmingly
     * common use of this tool is "what screen am I on, what can I click", which title, label and
     * index answer; clicking by label or index needs no coordinates at all. Geometry is not deleted,
     * it is behind a flag, because the UI-design surface (check_layout, measure_text) needs it.
     */
    private static JsonElement getScreen(final com.google.gson.JsonObject a) {
        boolean layout = a != null && a.has("detail") && !a.get("detail").isJsonNull()
            && "layout".equalsIgnoreCase(a.get("detail").getAsString());
        Minecraft mc = Minecraft.getInstance();
        Screen screen = mc.gui.screen();
        JsonObject r = new JsonObject();
        // What the boot latch was asked for and what became of it. Top-level and outside the null
        // check on purpose: it is a fact about this CLIENT'S LIFE, not about whatever is on screen
        // now, and the question it answers ("did `launch_game {ui:...}` keep its promise") is asked
        // long after the screen it opened has been replaced. Absent when the latch was never armed.
        JsonObject boot = UiWorldClient.bootRecord();
        if (boot != null) {
            r.add("ui_boot", boot);
        }
        if (screen == null) {
            r.add("screen", JsonNull.INSTANCE);
            return r;
        }
        JsonObject s = new JsonObject();
        s.addProperty("class", screen.getClass().getSimpleName());
        s.addProperty("title", screen.getTitle() == null ? "" : screen.getTitle().getString());
        if (screen instanceof InterpretedScreen is) {
            s.addProperty("document", is.source().describe());
            s.addProperty("detached", is.isDetached());
            if (is.loadError() != null) {
                // The screen is showing its last GOOD tree; say so rather than let a stale preview
                // pass for the file on disk.
                s.addProperty("document_problem", is.loadError());
            }
            if (is.lastAction() != null) {
                s.addProperty("last_action", is.lastAction());
            }
            if (!is.isDetached()) {
                // Attached (slice 6): which live menu, read the same way the reply to `attach` did.
                s.add("attached", attachedMenu(is));
                if (is.wrapped() != null) {
                    s.addProperty("wrapped", is.wrapped().getClass().getSimpleName());
                }
                if (GeneratedScreens.lastAction() != null) {
                    // The SERVER's record. An interpreted button attached rides vanilla's button
                    // channel, so this is where its arrival shows up.
                    s.addProperty("server_action", GeneratedScreens.lastAction());
                }
            }
            if (is.editorMode() != null) {
                // Slice 4: what is selected, what the palette offers, how deep undo goes and where a
                // save would land - so the editor is drivable without a screenshot.
                s.add("editor", is.editorMode().report());
            }
            s.add("bindings", bindings(is.document(), is.getMenu()));
        }
        GeneratedScreens.Entry generated = GeneratedScreens.forScreenClass(screen.getClass().getName());
        if (generated != null && screen instanceof AbstractContainerScreen<?> acs) {
            // The OTHER renderer of a document (section 12): the mod's compiled screen. Same fields as
            // the interpreted one, so a comparison reads both the same way.
            s.addProperty("document", generated.docId());
            s.addProperty("generated", true);
            if (GeneratedScreens.lastAction() != null) {
                s.addProperty("last_action", GeneratedScreens.lastAction());
                // The same fact under the name an ATTACHED preview uses (slice 6), so one field
                // answers "did the server's menu get it" on both renderers. On an interpreted screen
                // `last_action` is what the CLIENT fired - immediately, before any round trip - and a
                // comparison that read it as the server's answer would pass before the packet left.
                s.addProperty("server_action", GeneratedScreens.lastAction());
            }
            JsonObject falsified = UiFalsifier.report();
            if (falsified != null) {
                // Say so, or a red comparison against a deliberately corrupted screen reads as a bug.
                s.add("falsified", falsified);
            }
            try {
                s.add("bindings", bindings(new UiSource.Res(Identifier.parse(generated.docId())).load(), acs.getMenu()));
            } catch (java.io.IOException | UiParseException e) {
                s.addProperty("bindings_problem", e.getMessage());
            }
        }
        if (layout) {
            s.addProperty("classFull", screen.getClass().getName());
            s.addProperty("width", screen.width);
            s.addProperty("height", screen.height);
        }
        r.add("screen", s);

        JsonArray widgets = new JsonArray();
        Collected col = collectWidgets(screen);
        List<AbstractWidget> ws = col.widgets();
        for (int i = 0; i < ws.size(); i++) {
            AbstractWidget w = ws.get(i);
            JsonObject o = new JsonObject();
            o.addProperty("index", i);
            o.addProperty("class", w.getClass().getSimpleName());
            o.addProperty("label", w.getMessage() == null ? "" : w.getMessage().getString());
            UiDeclared d = UiDeclared.of(w);
            if (d != null) {
                // A widget that came from a screen-authoring document says which element: this is
                // how our own screens become nameable (SCREEN_AUTHORING_DESIGN.md section 1, point 4).
                // Interpreted or generated - UiDeclared.of reads both shapes.
                if (d.uiId() != null) {
                    o.addProperty("id", d.uiId());
                }
                o.addProperty("kind", d.uiKind().jsonName());
            }
            if (layout) {
                o.addProperty("x", w.getX());
                o.addProperty("y", w.getY());
                o.addProperty("width", w.getWidth());
                o.addProperty("height", w.getHeight());
                o.addProperty("active", w.active);
                o.addProperty("visible", w.visible);
                o.addProperty("focused", w.isFocused());
                o.addProperty("hovered", w.isHovered());
            } else {
                // Only the flags whose UNUSUAL value carries information. active/visible are true on
                // nearly every widget, so printing them everywhere says nothing; printing the false
                // ones says "you cannot click this", which is the whole reason to ask.
                if (!w.active) {
                    o.addProperty("active", false);
                }
                if (!w.visible) {
                    o.addProperty("visible", false);
                }
                if (w.isFocused()) {
                    o.addProperty("focused", true);
                }
            }
            if (col.nested().contains(w)) {
                o.addProperty("nested", true); // inside a list/container widget, not top-level
            }
            widgets.add(o);
        }
        r.add("widgets", widgets);
        if (col.unenumerated() > 0) {
            // Coverage honesty: interactive children that could not be rendered as widget rows
            // (non-AbstractWidget listeners). Without this the list reads as the complete tree.
            r.addProperty("unenumerated_listeners", col.unenumerated());
        }

        if (screen instanceof AbstractContainerScreen<?> acs) {
            JsonObject menu = new JsonObject();
            AbstractContainerMenu m = acs.getMenu();
            menu.addProperty("class", m.getClass().getSimpleName());
            // The menu's identity on the wire. It is what makes "the same menu instance" checkable
            // across an attached preview's swap (slice 6), and what vanilla drops a mismatched click on.
            menu.addProperty("container_id", m.containerId);
            JsonArray slots = new JsonArray();
            int empty = 0;
            for (Slot slot : m.slots) {
                ItemStack st = slot.getItem();
                if (st.isEmpty() && !layout) {
                    empty++;
                    continue; // a row per empty slot is padding; the COUNT is the fact
                }
                JsonObject so = new JsonObject();
                so.addProperty("index", slot.index);
                if (layout) {
                    so.addProperty("x", slot.x);
                    so.addProperty("y", slot.y);
                }
                if (st.isEmpty()) {
                    so.add("item", JsonNull.INSTANCE);
                } else {
                    so.addProperty("item", BuiltInRegistries.ITEM.getKey(st.getItem()).toString());
                    so.addProperty("count", st.getCount());
                }
                slots.add(so);
            }
            menu.add("slots", slots);
            menu.addProperty("slot_count", m.slots.size());
            if (empty > 0) {
                // Stated, never silent: the caller knows how many slots it is NOT being shown, so an
                // empty-looking chest stays distinguishable from a truncated read.
                menu.addProperty("empty_slots", empty);
            }
            // Bonus abstraction level: if the menu exposes a status() record (CatalogMenu/BuilderWorkstation
            // and any mod following the convention), serialize it. Best-effort — skip on any failure.
            try {
                Method statusMethod = m.getClass().getMethod("status");
                Object status = statusMethod.invoke(m);
                if (status != null) {
                    menu.add("status", statusToJson(status, 0));
                }
            } catch (NoSuchMethodException ignored) {
                // menu has no status() — fine
            } catch (Exception e) {
                menu.addProperty("statusError", e.getClass().getSimpleName());
            }
            r.add("menu", menu);
        }
        return r;
    }

    /**
     * Serialize a status record without Gson's field reflection, which trips JPMS on JDK types (Gson
     * reaching into Optional's private field throws InaccessibleObjectException → JsonIOException).
     * Records are read through their public accessors instead; Optionals unwrap; unknown leaf types fall
     * back to toString(), which reads fine for Identifier ("ns:path") and BlockPos.
     */
    private static JsonElement statusToJson(final @Nullable Object v, final int depth) {
        if (v == null) {
            return JsonNull.INSTANCE;
        }
        if (depth > 6) {
            // Disclosed truncation marker — a JsonNull here would be indistinguishable from a
            // genuinely-null field value.
            return new JsonPrimitive("<depth-capped>");
        }
        if (v instanceof java.util.Optional<?> opt) {
            return statusToJson(opt.orElse(null), depth + 1);
        }
        if (v instanceof String s) {
            return new JsonPrimitive(s);
        }
        if (v instanceof Number n) {
            return new JsonPrimitive(n);
        }
        if (v instanceof Boolean b) {
            return new JsonPrimitive(b);
        }
        if (v instanceof Enum<?> e) {
            return new JsonPrimitive(e.name());
        }
        if (v instanceof java.util.Collection<?> c) {
            JsonArray a = new JsonArray();
            for (Object el : c) {
                a.add(statusToJson(el, depth + 1));
            }
            return a;
        }
        if (v instanceof java.util.Map<?, ?> mp) {
            JsonObject o = new JsonObject();
            for (var en : mp.entrySet()) {
                o.add(String.valueOf(en.getKey()), statusToJson(en.getValue(), depth + 1));
            }
            return o;
        }
        if (v.getClass().isRecord()) {
            JsonObject o = new JsonObject();
            for (java.lang.reflect.RecordComponent rc : v.getClass().getRecordComponents()) {
                try {
                    o.add(rc.getName(), statusToJson(rc.getAccessor().invoke(v), depth + 1));
                } catch (Exception e) {
                    o.addProperty(rc.getName(), "<" + e.getClass().getSimpleName() + ">");
                }
            }
            return o;
        }
        return new JsonPrimitive(String.valueOf(v));
    }

    // ---- click / drag / scroll ----------------------------------------------

    /** A resolved pointer target: a point, and the widget it came from when it was named. */
    private record Point(double x, double y, @Nullable AbstractWidget widget, @Nullable String label) {}

    private static JsonElement click(final JsonObject a) {
        Screen screen = requireScreen();
        boolean wantScroll = has(a, "scroll") || has(a, "scroll_x");
        boolean wantDrag = has(a, "to_label") || has(a, "to_index") || has(a, "to_x") || has(a, "to_y");
        // ArgCheck's rule one level down (RELEASE_1 §D2): an argument this call's MODE cannot use is
        // refused, not dropped. A scroll has no destination and a drag has no wheel.
        if (wantScroll && wantDrag) {
            throw new IllegalArgumentException(
                "give 'scroll' OR a drag destination ('to_label'/'to_index'/'to_x'+'to_y'), not both");
        }
        boolean wantHover = has(a, "hover") && a.get("hover").getAsBoolean();
        if (wantHover && (wantScroll || wantDrag || has(a, "button"))) {
            throw new IllegalArgumentException(
                "'hover' moves the pointer and presses nothing: it takes no 'button', no 'scroll' and no drag destination");
        }
        Point from = point(screen, a, "x", "y", "label", "index");
        if (wantHover) {
            return hover(screen, from);
        }
        if (wantScroll) {
            return scroll(screen, a, from);
        }
        if (wantDrag) {
            return drag(screen, a, from);
        }
        return press(screen, a, from);
    }

    /**
     * Point without pressing. The pointer vanilla holds ({@code MouseHandler.xpos}/{@code ypos}) is
     * moved to the target, so every frame after this one renders with it there: hover faces, and
     * the tooltip zones both renderers draw off the render call's mouse coordinates
     * ({@code Paint.tooltips}). A programmatic click never moved it - the {@code MouseButtonEvent}
     * carries its own coordinates and those two fields are written only by the GLFW cursor
     * callback - so a tooltip could be photographed only with a hand on the mouse, which is why the
     * dynamic-tooltip half of the parts library stayed "half proved" (UI_PARTS_LIBRARY_DESIGN.md
     * 7.10). The next real mouse movement takes the pointer back; the reply says so.
     *
     * <p>Occlusion is reported, not refused: a hover over a covered widget is a real question
     * ("what shows there?"), and {@code over} names what the pointer is actually on.
     */
    private static JsonElement hover(final Screen screen, final Point from) {
        Minecraft mc = Minecraft.getInstance();
        var window = mc.getWindow();
        // MouseHandler.getScaledXPos(window, x) is x * guiScaledWidth / screenWidth; this is its inverse,
        // in the space ScreenSpaceMixin reads it back in (an iconified window has no screen size).
        double ax = from.x() * ScreenSpace.width(window) / (double) window.getGuiScaledWidth();
        double ay = from.y() * ScreenSpace.height(window) / (double) window.getGuiScaledHeight();
        com.mattmc.mcptoolkit.mixin.client.MouseHandlerAccessor mh =
            (com.mattmc.mcptoolkit.mixin.client.MouseHandlerAccessor) mc.mouseHandler;
        mh.mcptoolkit$setXpos(ax);
        mh.mcptoolkit$setYpos(ay);
        Minecraft.getInstance().setLastInputType(InputType.MOUSE);
        screen.mouseMoved(from.x(), from.y());
        screen.afterMouseMove();

        JsonObject r = new JsonObject();
        r.addProperty("hovered", true);
        r.addProperty("x", from.x());
        r.addProperty("y", from.y());
        if (from.label() != null) {
            r.addProperty("targetLabel", from.label());
        }
        var atPoint = screen.getChildAt(from.x(), from.y()).orElse(null);
        if (atPoint != null) {
            JsonObject over = new JsonObject();
            over.addProperty("class", atPoint.getClass().getSimpleName());
            if (atPoint instanceof AbstractWidget aw) {
                over.addProperty("label", label(aw));
            }
            r.add("over", over);
        }
        JsonObject blocked = blockedBy(screen, from);
        if (blocked != null) {
            r.add("blocked_by", blocked);
        }
        r.addProperty("note", "the pointer stays there until the next real mouse movement; "
            + "the frame that shows it is the NEXT one, so screenshot after a beat");
        return r;
    }

    /** The plain click: one press/release at the point, with the pre-dispatch occlusion check. */
    private static JsonElement press(final Screen screen, final JsonObject a, final Point from) {
        JsonObject r = new JsonObject();
        // Verify the coordinate actually lands on the requested widget BEFORE dispatching: a row
        // scrolled out of view keeps stale bounds, and an overlapping widget consumes the event —
        // clicking anyway hits the wrong thing while the result asserts the target was clicked.
        JsonObject blocked = blockedBy(screen, from);
        if (blocked != null) {
            r.addProperty("clicked", false);
            r.addProperty("reason", "blocked");
            r.addProperty("targetLabel", from.label());
            r.add("blocked_by", blocked);
            r.addProperty("note", "another widget sits at the target's center (overlap, or a "
                + "list row scrolled out of view keeping stale bounds) — nothing was clicked; "
                + "scroll it into view or click by x/y");
            return r;
        }
        MouseButtonInfo info = new MouseButtonInfo(button(a), 0);
        MouseButtonEvent ev = new MouseButtonEvent(from.x(), from.y(), info);
        // Vanilla's MouseHandler stamps this on every press and screens read it back:
        // Screen.setInitialFocus only auto-focuses when the LAST input was a keyboard one, so a
        // synthetic click that skips the stamp leaves the next screen focused as if a key had been
        // pressed. Faithful is cheaper than surprising.
        Minecraft.getInstance().setLastInputType(InputType.MOUSE);
        boolean handled = screen.mouseClicked(ev, false);
        screen.mouseReleased(ev);
        screen.afterMouseAction();
        // Fabric's mouse hooks don't fire for programmatic clicks, so feed the nav recorder directly
        // — but only with a VERIFIED cause: an unconsumed click must not label a graph edge.
        if (handled) {
            ScreenNav.noteClick(screen, from.label());
        }

        r.addProperty("clicked", handled);
        r.addProperty("handled", handled);
        if (!handled) {
            r.addProperty("note", "no widget consumed the click");
        }
        r.addProperty("x", from.x());
        r.addProperty("y", from.y());
        if (from.label() != null) {
            r.addProperty("targetLabel", from.label());
        }
        return r;
    }

    /**
     * The wheel. Reported with the scroll area's own amount before and after, because
     * {@code AbstractScrollArea.mouseScrolled} returns true whenever the widget is VISIBLE — it
     * clamps inside {@code setScrollAmount} and still answers "handled" at either end. A caller
     * paging a list off {@code handled} alone would loop forever at the bottom.
     */
    private static JsonElement scroll(final Screen screen, final JsonObject a, final Point at) {
        double sy = has(a, "scroll") ? a.get("scroll").getAsDouble() : 0.0;
        double sx = has(a, "scroll_x") ? a.get("scroll_x").getAsDouble() : 0.0;
        AbstractScrollArea area = scrollAreaAt(screen, at);
        Double before = area == null ? null : area.scrollAmount();
        boolean handled = screen.mouseScrolled(at.x(), at.y(), sx, sy);
        screen.afterMouseAction();
        JsonObject r = new JsonObject();
        r.addProperty("handled", handled);
        r.addProperty("x", at.x());
        r.addProperty("y", at.y());
        if (at.label() != null) {
            r.addProperty("targetLabel", at.label());
        }
        if (area == null) {
            r.addProperty("scroll_area", false);
            r.add("scrolled_from", JsonNull.INSTANCE);
            r.add("scrolled_to", JsonNull.INSTANCE);
            r.addProperty("note", handled
                ? "the wheel was consumed, but nothing under that point is an AbstractScrollArea — "
                    + "the screen scrolls by its own mechanism, so how far it moved cannot be read here"
                : "nothing under that point consumed the wheel (no scrollable widget there)");
            return r;
        }
        double after = area.scrollAmount();
        r.addProperty("scroll_area", true);
        r.addProperty("scrolled_from", before);
        r.addProperty("scrolled_to", after);
        r.addProperty("max_scroll", area.maxScrollAmount());
        r.addProperty("at_top", after <= 0.0);
        r.addProperty("at_end", after >= area.maxScrollAmount());
        if (before != null && before == after) {
            r.addProperty("note", handled
                ? "the wheel was consumed but the list did not move — it is already at "
                    + (after <= 0.0 ? "the top" : "the end")
                    + " (a scroll area consumes the wheel at either end)"
                : "the list did not move");
        }
        return r;
    }

    /**
     * Press, move, release — the sequence vanilla's own MouseHandler runs, and the only one that
     * works: {@code ContainerEventHandler.mouseDragged} forwards to the focused child ONLY while
     * {@code isDragging()}, which is set by a mouseClicked that child consumed. So a drag whose
     * opening press went nowhere is a guaranteed no-op, and is reported as one rather than as a
     * successful drag that happened to move nothing.
     */
    private static JsonElement drag(final Screen screen, final JsonObject a, final Point from) {
        Point to = point(screen, a, "to_x", "to_y", "to_label", "to_index");
        JsonObject r = new JsonObject();
        JsonObject blocked = blockedBy(screen, from);
        if (blocked != null) {
            r.addProperty("pressed", false);
            r.addProperty("dragged", false);
            r.addProperty("reason", "blocked");
            r.add("blocked_by", blocked);
            r.addProperty("note", "another widget sits at the drag's start point — nothing was pressed");
            return r;
        }
        int steps = clampInt(a, "steps", 4, 1, 64);
        AbstractScrollArea area = scrollAreaAt(screen, from);
        Double scrollBefore = area == null ? null : area.scrollAmount();
        String labelBefore = from.widget() == null ? null : label(from.widget());

        MouseButtonInfo info = new MouseButtonInfo(button(a), 0);
        Minecraft.getInstance().setLastInputType(InputType.MOUSE);
        boolean pressed = screen.mouseClicked(new MouseButtonEvent(from.x(), from.y(), info), false);
        screen.afterMouseAction();
        boolean anyDrag = false;
        double px = from.x();
        double py = from.y();
        for (int i = 1; i <= steps; i++) {
            double nx = from.x() + (to.x() - from.x()) * i / steps;
            double ny = from.y() + (to.y() - from.y()) * i / steps;
            screen.mouseMoved(nx, ny);
            anyDrag |= screen.mouseDragged(new MouseButtonEvent(nx, ny, info), nx - px, ny - py);
            screen.afterMouseMove();
            px = nx;
            py = ny;
        }
        boolean released = screen.mouseReleased(new MouseButtonEvent(to.x(), to.y(), info));
        screen.afterMouseAction();

        r.addProperty("pressed", pressed);
        r.addProperty("dragged", anyDrag);
        r.addProperty("released", released);
        r.addProperty("steps", steps);
        r.add("from", pointJson(from));
        r.add("to", pointJson(to));
        if (labelBefore != null) {
            String labelAfter = label(from.widget());
            if (!labelAfter.equals(labelBefore)) {
                // A slider's message carries its value ("FOV: 80"), so this IS the observable for
                // the commonest drag there is.
                r.addProperty("label_before", labelBefore);
                r.addProperty("label_after", labelAfter);
            }
        }
        if (area != null) {
            r.addProperty("scrolled_from", scrollBefore);
            r.addProperty("scrolled_to", area.scrollAmount());
            r.addProperty("max_scroll", area.maxScrollAmount());
        }
        if (!pressed) {
            r.addProperty("note", "the opening press was not consumed, so the screen never entered "
                + "drag mode (vanilla forwards mouseDragged only while isDragging) — nothing moved");
        } else if (!anyDrag) {
            r.addProperty("note", "the press landed but no drag event was consumed — whatever is "
                + "under the start point does not handle dragging");
        }
        return r;
    }

    // ---- send_keys -----------------------------------------------------------

    /**
     * Keyboard input, dispatched the way {@code KeyboardHandler} does it: {@code charTyped} per
     * codepoint for text, then {@code keyPressed}/{@code keyReleased} per repeat for a named key.
     *
     * <p>The reported fields are chosen against one fact: <b>{@code Screen.keyPressed} returns false
     * for Tab and the four arrows even when focus moved</b> — it builds a FocusNavigationEvent,
     * changes focus, then falls out of the switch to {@code return false}. {@code handled} is
     * therefore the wrong instrument for exactly the keys this tool exists to send, and
     * {@code focus_before}/{@code focus_after} are the right one.
     */
    private static JsonElement sendKeys(final JsonObject a) {
        Screen screen = requireScreen();
        boolean hasText = has(a, "text");
        boolean hasKey = has(a, "key");
        if (!hasText && !hasKey) {
            throw new IllegalArgumentException("provide 'key' and/or 'text'");
        }
        JsonObject r = new JsonObject();
        r.addProperty("screen_was", screen.getClass().getSimpleName());
        r.add("focus_before", focusJson(screen));
        String valueBefore = focusedBoxValue(screen);
        int mods = modifiers(a);

        if (hasText) {
            String text = a.get("text").getAsString();
            int sent = 0;
            int consumed = 0;
            for (int i = 0; i < text.length(); ) {
                int cp = text.codePointAt(i);
                i += Character.charCount(cp);
                sent++;
                if (screen.charTyped(new CharacterEvent(cp))) {
                    consumed++;
                }
            }
            JsonObject t = new JsonObject();
            t.addProperty("chars_sent", sent);
            t.addProperty("chars_consumed", consumed);
            if (consumed == 0 && sent > 0) {
                t.addProperty("note", screen.getFocused() == null
                    ? "nothing has focus, so no widget could receive the characters — focus one first "
                        + "(click it, or send_keys {key:\"tab\"})"
                    : "the focused widget refused every character (an edit box only consumes them "
                        + "while active, focused and editable)");
            }
            r.add("typed", t);
        }

        if (hasKey) {
            InputConstants.Key key = resolveKey(a.get("key").getAsString());
            int times = clampInt(a, "times", 1, 1, 64);
            KeyEvent ev = new KeyEvent(key.getValue(), 0, mods);
            JsonArray presses = new JsonArray();
            Screen live = screen;
            for (int i = 0; i < times; i++) {
                // Vanilla stamps these before dispatching and focus rendering reads them back.
                if (key.getValue() == 258) {
                    Minecraft.getInstance().setLastInputType(InputType.KEYBOARD_TAB);
                } else if (key.getValue() >= 262 && key.getValue() <= 265) {
                    Minecraft.getInstance().setLastInputType(InputType.KEYBOARD_ARROW);
                }
                live.afterKeyboardAction();
                boolean handled = live.keyPressed(ev);
                live.keyReleased(ev);
                JsonObject one = new JsonObject();
                one.addProperty("handled", handled);
                presses.add(one);
                Screen now = Minecraft.getInstance().gui.screen();
                if (now != live) {
                    // Escape and Enter routinely close or replace the screen. Sending the rest of
                    // the repeats would be acting on a screen nobody asked for.
                    one.addProperty("closed_or_replaced", true);
                    if (i + 1 < times) {
                        r.addProperty("stopped_early", true);
                        r.addProperty("note", "the screen changed after press " + (i + 1)
                            + ", so the remaining " + (times - i - 1) + " were not sent");
                    }
                    break;
                }
            }
            JsonObject k = new JsonObject();
            k.addProperty("key", key.getName());
            k.addProperty("keysym", key.getValue());
            k.addProperty("modifiers", mods);
            k.add("presses", presses);
            r.add("pressed", k);
        }

        Screen now = Minecraft.getInstance().gui.screen();
        r.addProperty("screen_changed", now != screen);
        r.addProperty("now_open", now == null ? null : now.getClass().getSimpleName());
        r.add("focus_after", now == null ? JsonNull.INSTANCE : focusJson(now));
        String valueAfter = now == screen ? focusedBoxValue(screen) : null;
        if (valueBefore != null || valueAfter != null) {
            r.addProperty("box_value_before", valueBefore);
            r.addProperty("box_value_after", valueAfter);
        }
        return r;
    }

    /** {@code "tab"}, {@code "page.down"}, {@code "page_down"} or a full {@code key.keyboard.*} id. */
    private static InputConstants.Key resolveKey(final String raw) {
        String name = raw.trim().toLowerCase(java.util.Locale.ROOT).replace('_', '.');
        String full = name.startsWith("key.") ? name : "key.keyboard." + name;
        InputConstants.Key key;
        try {
            key = InputConstants.getKey(full);
        } catch (RuntimeException e) {
            throw new IllegalArgumentException("unknown key '" + raw + "' (looked up '" + full
                + "'). Names are the suffix of a key.keyboard.* id: tab, enter, escape, backspace, "
                + "delete, space, up, down, left, right, page.up, page.down, home, end, insert, "
                + "left.shift, left.control, left.alt, f1..f25, a..z, 0..9, keypad.0..keypad.9, "
                + "comma, period, minus, equal, slash, semicolon, apostrophe, grave.accent, "
                + "left.bracket, right.bracket, backslash");
        }
        if (key.getType() != InputConstants.Type.KEYSYM) {
            throw new IllegalArgumentException("'" + raw + "' names a " + key.getType()
                + " input, not a keyboard key — send_keys drives the keyboard; the mouse is click");
        }
        return key;
    }

    /** GLFW modifier bits, which 26.2 reads off the EVENT (InputWithModifiers), not the real keyboard. */
    private static int modifiers(final JsonObject a) {
        if (!has(a, "modifiers")) {
            return 0;
        }
        JsonElement raw = a.get("modifiers");
        if (!raw.isJsonArray()) {
            throw new IllegalArgumentException("'modifiers' is a list, e.g. [\"ctrl\",\"shift\"]");
        }
        int mods = 0;
        for (JsonElement el : raw.getAsJsonArray()) {
            String m = el.getAsString().trim().toLowerCase(java.util.Locale.ROOT);
            mods |= switch (m) {
                case "shift" -> 1;
                case "ctrl", "control" -> 2;
                case "alt", "option" -> 4;
                case "super", "cmd", "command", "win", "meta" -> 8;
                default -> throw new IllegalArgumentException("unknown modifier '" + m
                    + "' (shift | ctrl | alt | super)");
            };
        }
        return mods;
    }

    /** What holds focus, as a row a caller can compare across calls. */
    private static JsonElement focusJson(final Screen screen) {
        var f = screen.getFocused();
        if (f == null) {
            return JsonNull.INSTANCE;
        }
        JsonObject o = new JsonObject();
        o.addProperty("class", f.getClass().getSimpleName());
        if (f instanceof AbstractWidget w) {
            o.addProperty("label", label(w));
            int i = collectWidgets(screen).widgets().indexOf(w);
            if (i >= 0) {
                o.addProperty("index", i);
            }
        }
        return o;
    }

    /** The focused edit box's text, or null when what holds focus is not one. */
    private static @Nullable String focusedBoxValue(final Screen screen) {
        return screen.getFocused() instanceof EditBox box ? box.getValue() : null;
    }

    // ---- pointer helpers -----------------------------------------------------

    private static Screen requireScreen() {
        Screen screen = Minecraft.getInstance().gui.screen();
        if (screen == null) {
            throw new IllegalStateException("no screen open");
        }
        return screen;
    }

    private static boolean has(final JsonObject a, final String k) {
        return a.has(k) && !a.get(k).isJsonNull();
    }

    private static int button(final JsonObject a) {
        return has(a, "button") ? a.get("button").getAsInt() : 0;
    }

    private static int clampInt(final JsonObject a, final String k, final int def, final int lo, final int hi) {
        if (!has(a, k)) {
            return def;
        }
        int v = a.get(k).getAsInt();
        if (v < lo || v > hi) {
            throw new IllegalArgumentException("'" + k + "' must be " + lo + ".." + hi + " (got " + v + ")");
        }
        return v;
    }

    /** Resolve a target point: raw coordinates under {@code xk}/{@code yk}, else a widget's centre. */
    private static Point point(final Screen screen, final JsonObject a,
                               final String xk, final String yk, final String lk, final String ik) {
        boolean hx = has(a, xk);
        boolean hy = has(a, yk);
        if (hx && hy) {
            return new Point(a.get(xk).getAsDouble(), a.get(yk).getAsDouble(), null, null);
        }
        if (hx || hy) {
            throw new IllegalArgumentException("give both '" + xk + "' and '" + yk
                + "', or name the widget with '" + lk + "'/'" + ik + "'");
        }
        AbstractWidget w = resolveWidget(screen, a, lk, ik);
        return new Point(w.getX() + w.getWidth() / 2.0, w.getY() + w.getHeight() / 2.0, w, label(w));
    }

    private static JsonObject pointJson(final Point p) {
        JsonObject o = new JsonObject();
        o.addProperty("x", p.x());
        o.addProperty("y", p.y());
        if (p.label() != null) {
            o.addProperty("label", p.label());
        }
        return o;
    }

    /**
     * The pre-dispatch occlusion check: null when the point really lands on the named widget, else
     * a row naming what sits there instead. A raw x/y target skips it — the caller named a point,
     * not a thing, so there is nothing to be wrong about.
     */
    private static @Nullable JsonObject blockedBy(final Screen screen, final Point p) {
        AbstractWidget target = p.widget();
        if (target == null) {
            return null;
        }
        var atPoint = screen.getChildAt(p.x(), p.y()).orElse(null);
        if (atPoint == null || atPoint == target || contains(atPoint, target) || contains(target, atPoint)) {
            return null;
        }
        JsonObject b = new JsonObject();
        b.addProperty("class", atPoint.getClass().getSimpleName());
        if (atPoint instanceof AbstractWidget bw) {
            b.addProperty("label", label(bw));
        }
        return b;
    }

    /**
     * The deepest {@link AbstractScrollArea} under the point — the widget whose {@code scrollAmount}
     * is the observable for a wheel or a scrollbar drag. Walks the same child chain
     * {@code ContainerEventHandler.mouseScrolled} routes down, so it finds what the event will hit.
     */
    private static @Nullable AbstractScrollArea scrollAreaAt(final Screen screen, final Point p) {
        if (p.widget() instanceof AbstractScrollArea direct) {
            return direct;
        }
        AbstractScrollArea found = null;
        net.minecraft.client.gui.components.events.GuiEventListener node = screen;
        for (int depth = 0; depth < 16; depth++) {
            if (node instanceof AbstractScrollArea area) {
                found = area;
            }
            if (!(node instanceof net.minecraft.client.gui.components.events.ContainerEventHandler c)) {
                break;
            }
            var next = c.getChildAt(p.x(), p.y()).orElse(null);
            if (next == null || next == node) {
                break;
            }
            node = next;
        }
        return found;
    }

    /** Whether {@code child} is inside {@code root}'s event subtree (list rows vs their list). */
    private static boolean contains(final net.minecraft.client.gui.components.events.GuiEventListener root,
                                    final net.minecraft.client.gui.components.events.GuiEventListener child) {
        if (!(root instanceof net.minecraft.client.gui.components.events.ContainerEventHandler c)) {
            return false;
        }
        for (var el : c.children()) {
            if (el == child || contains(el, child)) {
                return true;
            }
        }
        return false;
    }

    // ---- set_text ------------------------------------------------------------

    private static JsonElement setText(final JsonObject a) {
        Minecraft mc = Minecraft.getInstance();
        Screen screen = mc.gui.screen();
        if (screen == null) {
            throw new IllegalStateException("no screen open");
        }
        if (!a.has("text") || a.get("text").isJsonNull()) {
            throw new IllegalArgumentException("missing argument 'text'");
        }
        AbstractWidget target = resolveWidget(screen, a);
        if (!(target instanceof EditBox box)) {
            throw new IllegalArgumentException("widget is not a text field (it is "
                + target.getClass().getSimpleName() + ")");
        }
        box.setFocused(true);
        String requested = a.get("text").getAsString();
        box.setValue(requested);
        // EditBox.setValue silently truncates to maxLength and rejects filtered values — read back
        // and compare instead of asserting the set matched the request.
        String actual = box.getValue();
        JsonObject r = new JsonObject();
        r.addProperty("set", actual.equals(requested));
        r.addProperty("value", actual);
        if (!actual.equals(requested)) {
            r.addProperty("note", requested.startsWith(actual) || actual.length() < requested.length()
                ? "the box truncated or filtered the text (its max length/filter applied) — `value` "
                    + "is what it actually holds"
                : "the box rejected the text via its filter — `value` is what it actually holds");
        }
        return r;
    }

    // ---- open_screen / close_screen ------------------------------------------

    private static JsonElement openScreen(final JsonObject a) {
        Minecraft mc = Minecraft.getInstance();
        boolean hasUi = a.has("ui") && !a.get("ui").isJsonNull();
        boolean hasUiFile = a.has("ui_file") && !a.get("ui_file").isJsonNull();
        if (hasUi || hasUiFile) {
            if (hasUi && hasUiFile) {
                throw new IllegalArgumentException("give ONE document: 'ui' (a resource id) or 'ui_file' (a path)");
            }
            UiSource source;
            boolean edit = a.has("edit") && !a.get("edit").isJsonNull() && a.get("edit").getAsBoolean();
            boolean generated = a.has("generated") && !a.get("generated").isJsonNull() && a.get("generated").getAsBoolean();
            if (edit && generated) {
                throw new IllegalArgumentException("the editor edits the DOCUMENT, and a generated screen is"
                    + " compiled Java - open the interpreted preview to edit ('generated' off)");
            }
            UiFalsifier.Mode falsify = UiFalsifier.Mode.parse(
                a.has("falsify") && !a.get("falsify").isJsonNull() ? a.get("falsify").getAsString() : null);
            if (falsify != null && !generated) {
                throw new IllegalArgumentException("'falsify' corrupts the GENERATED screen: it needs 'generated':true");
            }
            if (hasUi) {
                Identifier id = Identifier.tryParse(a.get("ui").getAsString());
                if (id == null) {
                    throw new IllegalArgumentException("'ui' must be a resource id like mcptoolkit:example");
                }
                if (generated) {
                    return openGenerated(id, falsify);
                }
                source = new UiSource.Res(id);
            } else if (generated) {
                throw new IllegalArgumentException("'generated' needs 'ui' (a resource id): a generated screen is registered by id, not by file");
            } else {
                source = new UiSource.File(java.nio.file.Path.of(a.get("ui_file").getAsString()));
            }
            return openUiPreview(source, edit);
        }
        if (a.has("name") && !a.get("name").isJsonNull()) {
            String name = a.get("name").getAsString();
            if (!"title".equalsIgnoreCase(name)) {
                throw new IllegalArgumentException("unknown screen name '" + name + "' (only \"title\" is supported)");
            }
            mc.setScreenAndShow(new TitleScreen());
            return opened("TitleScreen");
        }
        if (a.has("className") && !a.get("className").isJsonNull()) {
            String cn = a.get("className").getAsString();
            Class<?> cls;
            try {
                cls = Class.forName(cn);
            } catch (ClassNotFoundException e) {
                throw new IllegalArgumentException("no such class '" + cn + "'");
            }
            if (!Screen.class.isAssignableFrom(cls)) {
                throw new IllegalArgumentException(cn + " is not a Screen subclass");
            }
            Screen sc = construct(cls, mc.gui.screen());
            mc.setScreenAndShow(sc);
            return opened(cls.getSimpleName());
        }
        throw new IllegalArgumentException("provide 'name':'title' or 'className':'<fully.qualified.Screen>'");
    }

    // ---- the client half of ui_doc (slice 5) ---------------------------------
    //
    // `ui_doc` runs on ANY: files and the model need no game. Two of its answers do need a client -
    // opening a preview is opening a SCREEN, and asking whether the in-game editor is sitting on
    // unsaved edits means looking at the one that is open - so the tool holds a seam and this fills
    // it. On a dedicated server it is never installed, and `preview` says so by name.

    private static final com.mattmc.mcptoolkit.ui.UiDocTools.Client UI_DOC_CLIENT =
        new com.mattmc.mcptoolkit.ui.UiDocTools.Client() {
            @Override
            public java.util.concurrent.CompletableFuture<JsonObject> preview(
                final Identifier id, final java.nio.file.Path file, final boolean edit) {
                UiSource source = id != null ? new UiSource.Res(id) : new UiSource.File(file);
                java.util.concurrent.CompletableFuture<JsonObject> out = new java.util.concurrent.CompletableFuture<>();
                Minecraft.getInstance().execute(() -> {
                    try {
                        out.complete((JsonObject) openUiPreview(source, edit));
                    } catch (RuntimeException e) {
                        out.completeExceptionally(e);
                    }
                });
                return out;
            }

            @Override
            public java.util.concurrent.CompletableFuture<JsonObject> open(
                final Identifier id, final java.nio.file.Path file, final boolean edit) {
                UiSource source = id != null ? new UiSource.Res(id) : new UiSource.File(file);
                return onClient(() -> UiWorldClient.open(source, edit));
            }

            @Override
            public java.util.concurrent.CompletableFuture<JsonObject> attach(
                final Identifier id, final java.nio.file.Path file, final boolean edit) {
                UiSource source = id != null ? new UiSource.Res(id) : file != null ? new UiSource.File(file) : null;
                return onClient(() -> attachHere(source, edit));
            }

            @Override
            public java.util.concurrent.CompletableFuture<JsonObject> detach() {
                return onClient(UiTools::detachHere);
            }

            @Override
            public String unsavedHold(final java.nio.file.Path resolvedFile) {
                // Two field reads off the open screen, from the HTTP thread. Nothing is mutated and
                // a stale answer is the safe one either way: the editor could always save a moment
                // after this returns, which is why the refusal it drives is about the NEXT Ctrl+S.
                Screen screen = Minecraft.getInstance().gui.screen();
                if (!(screen instanceof InterpretedScreen is) || is.editorMode() == null
                    || !is.editorMode().isDirty()) {
                    return null;
                }
                var target = is.editorMode().target();
                if (target == null || !target.file().equals(resolvedFile)) {
                    return null;
                }
                return "the in-game editor has " + is.source().describe() + " open with unsaved edits.";
            }
        };

    /**
     * Run a screen operation on the client thread and hand back its JSON. Every one of {@code ui_doc}'s
     * client ops arrives on the HTTP thread and touches screens, so they all go through here.
     */
    private static java.util.concurrent.CompletableFuture<JsonObject> onClient(
        final java.util.function.Supplier<JsonObject> work) {
        java.util.concurrent.CompletableFuture<JsonObject> out = new java.util.concurrent.CompletableFuture<>();
        Minecraft.getInstance().execute(() -> {
            try {
                out.complete(work.get());
            } catch (RuntimeException e) {
                out.completeExceptionally(e);
            }
        });
        return out;
    }

    /**
     * The ATTACHED preview (SCREEN_AUTHORING_DESIGN.md section 6.1, slice 6): the interpreter over
     * the live menu of whatever container screen is open. The reply is the detached one's plus what
     * only attached mode can say - which menu, which container id, how the bindings were read, and
     * how far the running menu's slots have drifted from the document.
     */
    private static JsonObject attachHere(final UiSource source, final boolean edit) {
        com.mattmc.mcptoolkit.ui.interp.UiAttach.Attached a;
        try {
            a = com.mattmc.mcptoolkit.ui.interp.UiAttach.attach(source);
        } catch (UiParseException e) {
            JsonArray problems = new JsonArray();
            for (UiParseException.Problem p : e.problems()) {
                problems.add(p.toString());
            }
            throw new IllegalArgumentException((source == null ? "the derived document" : source.describe())
                + " has " + e.problems().size() + " problem(s): " + problems);
        } catch (java.io.IOException e) {
            throw new IllegalArgumentException("cannot read the document: " + e.getMessage());
        }
        InterpretedScreen screen = a.screen();
        JsonObject r = describePreview(screen, edit);
        r.addProperty("opened", "InterpretedScreen");
        r.addProperty("attached", true);
        r.addProperty("wrapped", a.wrapped());
        if (a.derived()) {
            r.addProperty("document_derived_from", a.wrapped());
        }
        r.add("menu", attachedMenu(screen));
        r.addProperty("note", "this is the LIVE menu: slot contents and binding values are the running"
            + " game's, a button press rides vanilla's button channel to the server, and detach puts the"
            + " wrapped screen back. Vanilla's Slot.x is final, so a slot edit shows up only after"
            + " generate + rebuild - `menu.slot_drift` is what has already diverged");
        return r;
    }

    /** What only an attached preview can report: the menu it wrapped, and how far it has drifted. */
    private static JsonObject attachedMenu(final InterpretedScreen screen) {
        JsonObject m = new JsonObject();
        m.addProperty("class", screen.menu().getClass().getSimpleName());
        m.addProperty("container_id", screen.menu().containerId);
        m.addProperty("slots", screen.menu().slots.size());
        m.addProperty("bindings_read_by", screen.bindingSource().name().toLowerCase(java.util.Locale.ROOT));
        if (screen.bindingSource() == com.mattmc.mcptoolkit.ui.interp.UiBindings.Source.NONE
            && !screen.document().bindings().isEmpty()) {
            m.addProperty("bindings_problem", "this menu has no bindingValue(String), so every binding"
                + " reads 0: the gauges are empty because nothing answered, not because the values are");
        }
        m.add("bindings", bindings(screen.document(), screen.getMenu()));
        var drift = screen.slotDrift();
        if (drift != null) {
            m.addProperty("document_slots", drift.documentSlots());
            m.addProperty("slots_moved", drift.moved());
            if (!drift.clean()) {
                JsonArray notes = new JsonArray();
                for (String n : drift.notes()) {
                    notes.add(n);
                }
                m.add("slot_drift", notes);
            }
        }
        return m;
    }

    private static JsonObject detachHere() {
        Screen back = com.mattmc.mcptoolkit.ui.interp.UiAttach.detach();
        JsonObject r = new JsonObject();
        r.addProperty("detached", true);
        r.addProperty("opened", back.getClass().getSimpleName());
        r.addProperty("note", "the same screen instance over the same menu: the swap never closed it"
            + " (AbstractContainerScreen.removed forwards to menu.removed, which is server-side only)");
        return r;
    }

    /**
     * A detached preview of a screen-authoring document (SCREEN_AUTHORING_DESIGN.md section 6.1).
     * The reply lists what the document declared, so a caller can go straight to {@code get_screen}
     * and {@code click} by id or label; a document that fails to parse is refused with every problem.
     */
    /**
     * Package-private rather than private since slice 7: {@link UiWorldClient} opens the same preview
     * from the boot latch and from {@code ui_doc op:"open"}, and a second copy of this would be a
     * second answer to "what does an opened preview report".
     */
    static JsonElement openUiPreview(final UiSource source, final boolean edit) {
        InterpretedScreen screen;
        try {
            screen = UiPreview.openDetached(source);
        } catch (UiParseException e) {
            JsonArray problems = new JsonArray();
            for (UiParseException.Problem p : e.problems()) {
                problems.add(p.toString());
            }
            throw new IllegalArgumentException(source.describe() + " has " + e.problems().size()
                + " problem(s): " + problems);
        } catch (java.io.IOException e) {
            throw new IllegalArgumentException("cannot read " + source.describe() + ": " + e.getMessage());
        }
        JsonObject r = describePreview(screen, edit);
        r.addProperty("opened", "InterpretedScreen");
        r.addProperty("detached", true);
        r.addProperty("note", "get_screen names each declared widget by id and kind; layout nodes appear as"
            + " inactive widgets the size of their bounds; slots are the menu's, listed under menu.slots");
        return r;
    }

    /**
     * What both fidelities say about an open preview: the document, its size, what it declared, and
     * the editor's state when one was asked for. Attached mode adds to this rather than repeating it.
     */
    private static JsonObject describePreview(final InterpretedScreen screen, final boolean edit) {
        JsonObject r = new JsonObject();
        r.addProperty("document", screen.source().describe());
        com.mattmc.mcptoolkit.ui.doc.UiDocument doc = screen.document();
        r.addProperty("width", doc.width());
        r.addProperty("height", doc.height());
        JsonArray declared = new JsonArray();
        int slots = 0;
        for (com.mattmc.mcptoolkit.ui.doc.Element e : doc.flatten()) {
            if (e.kind().isSlot()) {
                slots += e instanceof com.mattmc.mcptoolkit.ui.doc.Element.SlotGrid g ? g.count() : 1;
            }
            if (e.id() != null) {
                declared.add(e.kind().jsonName() + ":" + e.id());
            }
        }
        r.add("declared", declared);
        r.addProperty("slots", slots);
        r.add("kinds", kinds(doc));
        if (edit) {
            // Arming the editor rebuilds the widgets, so its own state is reported straight away -
            // in particular the save target, which is the one thing worth reading BEFORE editing.
            r.add("editor", screen.enterEdit().report());
        }
        return r;
    }

    /**
     * The element registry as this JVM has it, beside the kinds this document uses - what the
     * conformance battery enumerates from (SCREEN_AUTHORING_DESIGN.md section 12), so a kind added
     * to {@link com.mattmc.mcptoolkit.ui.doc.Kind} without an element in the compared document fails
     * a live case by name rather than silently having no coverage.
     */
    private static JsonObject kinds(final com.mattmc.mcptoolkit.ui.doc.UiDocument doc) {
        JsonObject out = new JsonObject();
        JsonArray registered = new JsonArray();
        for (com.mattmc.mcptoolkit.ui.doc.Kind k : com.mattmc.mcptoolkit.ui.doc.Kind.values()) {
            JsonObject o = new JsonObject();
            o.addProperty("name", k.jsonName());
            o.addProperty("family", k.family().name().toLowerCase(java.util.Locale.ROOT));
            registered.add(o);
        }
        out.add("registered", registered);
        java.util.LinkedHashSet<String> used = new java.util.LinkedHashSet<>();
        for (com.mattmc.mcptoolkit.ui.doc.Element e : doc.flatten()) {
            used.add(e.kind().jsonName());
        }
        JsonArray usedArr = new JsonArray();
        used.forEach(usedArr::add);
        out.add("used", usedArr);
        return out;
    }

    /**
     * The document's bindings as the menu currently answers them. The interpreter's menu implements
     * {@code UiBindings}; a generated menu carries the same method without the interface (section
     * 15.8), read by shape - so a wrapped 16-bit value shows up here as the number it became.
     */
    private static JsonObject bindings(final com.mattmc.mcptoolkit.ui.doc.UiDocument doc, final AbstractContainerMenu menu) {
        JsonObject out = new JsonObject();
        com.mattmc.mcptoolkit.ui.interp.UiBindings.Bound bound =
            com.mattmc.mcptoolkit.ui.interp.UiBindings.bind(menu);
        if (!bound.answers()) {
            return out;
        }
        for (com.mattmc.mcptoolkit.ui.doc.UiDocument.Binding b : doc.bindings()) {
            out.addProperty(b.name(), bound.values().bindingValue(b.name()));
        }
        return out;
    }

    /**
     * The generated screen of a document (SCREEN_AUTHORING_DESIGN.md section 12): the mod's compiled
     * Java, opened the way a player would get it - the integrated server opens the real menu for this
     * client's player and the client builds the registered screen from the open packet. So it needs
     * singleplayer, and it is asynchronous: the reply says what will open, and get_screen says when.
     */
    private static JsonElement openGenerated(final Identifier id, final UiFalsifier.@Nullable Mode falsify) {
        GeneratedScreens.Entry entry = GeneratedScreens.forDocument(id.toString());
        if (entry == null) {
            throw new IllegalArgumentException("no generated screen is registered for " + id + "; documents with one: "
                + GeneratedScreens.documents());
        }
        Minecraft mc = Minecraft.getInstance();
        net.minecraft.client.server.IntegratedServer server = mc.getSingleplayerServer();
        if (server == null || mc.player == null) {
            throw new IllegalStateException("a generated screen opens through the SERVER's menu, so this needs a"
                + " singleplayer world (open_world first)");
        }
        com.mattmc.mcptoolkit.ui.doc.UiDocument doc;
        try {
            doc = new UiSource.Res(id).load();
        } catch (UiParseException e) {
            throw new IllegalArgumentException(id + " has problems: " + e.getMessage());
        } catch (java.io.IOException e) {
            throw new IllegalArgumentException("cannot read " + id + ": " + e.getMessage());
        }
        net.minecraft.world.MenuProvider provider = entry.provider().apply(doc);
        // Armed before the open packet can arrive; consumed by the screen's first init. Also the
        // disarm: a plain generated open clears a previous falsification's report.
        UiFalsifier.arm(falsify);
        java.util.UUID who = mc.player.getUUID();
        server.execute(() -> {
            net.minecraft.server.level.ServerPlayer sp = server.getPlayerList().getPlayer(who);
            if (sp != null) {
                sp.openMenu(provider);
            }
        });
        JsonObject r = new JsonObject();
        r.addProperty("opening", entry.screenClassName().substring(entry.screenClassName().lastIndexOf('.') + 1));
        r.addProperty("document", id.toString());
        r.addProperty("generated", true);
        if (falsify != null) {
            r.addProperty("falsify", falsify.name().toLowerCase(java.util.Locale.ROOT));
        }
        r.addProperty("note", "opens through the server: poll get_screen until screen.class is the one above");
        return r;
    }

    private static Screen construct(final Class<?> cls, final @Nullable Screen parent) {
        // Try no-arg, then a single-Screen (parent) constructor — the common Screen shapes.
        try {
            Constructor<?> c = cls.getDeclaredConstructor();
            c.setAccessible(true);
            return (Screen) c.newInstance();
        } catch (NoSuchMethodException noNoArg) {
            try {
                Constructor<?> c = cls.getDeclaredConstructor(Screen.class);
                c.setAccessible(true);
                return (Screen) c.newInstance(parent);
            } catch (Exception e) {
                throw new IllegalArgumentException(cls.getSimpleName()
                    + " has no no-arg or (Screen) constructor to open it with");
            }
        } catch (Exception e) {
            throw new RuntimeException("could not construct " + cls.getSimpleName() + ": " + e.getMessage(), e);
        }
    }

    private static JsonElement closeScreen() {
        Minecraft mc = Minecraft.getInstance();
        Screen prev = mc.gui.screen();
        if (prev != null) {
            prev.onClose();
        }
        // onClose() is routinely overridden — options screens return to a PARENT, unsaved-state
        // screens open a confirm dialog. Re-read what is actually open instead of asserting closure.
        Screen now = mc.gui.screen();
        JsonObject r = new JsonObject();
        if (prev == null) {
            r.add("closed", JsonNull.INSTANCE);
            r.addProperty("note", "no screen was open");
            return r;
        }
        r.addProperty("closed", now != prev);
        r.addProperty("was", prev.getClass().getSimpleName());
        r.addProperty("now_open", now == null ? null : now.getClass().getSimpleName());
        if (now == prev) {
            r.addProperty("note", "the screen refused to close (it may need confirmation) — "
                + "get_screen to see its current state");
        } else if (now != null) {
            r.addProperty("note", "closing revealed another screen (parent or confirm dialog), "
                + "not the game view");
        }
        return r;
    }

    // ---- helpers -------------------------------------------------------------

    /** The walked widget set: all reachable {@link AbstractWidget}s (DFS), which of them are nested
     * inside container widgets, and how many interactive listeners could NOT be rendered as widgets. */
    record Collected(List<AbstractWidget> widgets, java.util.Set<AbstractWidget> nested, int unenumerated) {}

    /**
     * Walk the screen's full event tree, not just its top-level widgets. {@code Screens.getWidgets}
     * only sees top-level {@link AbstractWidget}s — rows inside selection lists and children of
     * layout containers were invisible to get_screen/click-by-index while the output presented
     * itself as "the widget tree". Shared by get_screen and resolveWidget so indexes stay aligned.
     */
    static Collected collectWidgets(final Screen screen) {
        List<AbstractWidget> out = new java.util.ArrayList<>();
        java.util.Set<AbstractWidget> nested = new java.util.HashSet<>();
        java.util.IdentityHashMap<Object, Boolean> seen = new java.util.IdentityHashMap<>();
        int[] unenumerated = {0};
        walk(screen.children(), out, nested, seen, unenumerated, false);
        // Union with the screen's renderable list: catches top-level widgets a screen registered as
        // renderables without adding them as children (rare, but they are clickable UI).
        for (AbstractWidget w : ToolkitScreens.widgets(screen)) {
            if (seen.put(w, Boolean.TRUE) == null) {
                out.add(w);
            }
        }
        return new Collected(out, nested, unenumerated[0]);
    }

    private static void walk(final List<? extends net.minecraft.client.gui.components.events.GuiEventListener> children,
                             final List<AbstractWidget> out, final java.util.Set<AbstractWidget> nested,
                             final java.util.IdentityHashMap<Object, Boolean> seen,
                             final int[] unenumerated, final boolean insideContainer) {
        for (var child : children) {
            if (seen.put(child, Boolean.TRUE) != null) {
                continue;
            }
            boolean isWidget = child instanceof AbstractWidget;
            if (isWidget) {
                out.add((AbstractWidget) child);
                if (insideContainer) {
                    nested.add((AbstractWidget) child);
                }
            }
            if (child instanceof net.minecraft.client.gui.components.events.ContainerEventHandler c) {
                walk(c.children(), out, nested, seen, unenumerated, true);
            } else if (!isWidget) {
                unenumerated[0]++; // interactive but not renderable as a widget row
            }
        }
    }

    /** Resolve a widget on the screen by {@code label} (substring) or {@code index}. */
    private static AbstractWidget resolveWidget(final Screen screen, final JsonObject a) {
        return resolveWidget(screen, a, "label", "index");
    }

    /**
     * The same resolution under caller-chosen argument names, so a drag's DESTINATION
     * ({@code to_label}/{@code to_index}) is looked up by the one implementation the source and
     * every other target already use — two lookups that drifted apart would be two vocabularies.
     */
    private static AbstractWidget resolveWidget(final Screen screen, final JsonObject a,
                                                final String labelKey, final String indexKey) {
        List<AbstractWidget> ws = collectWidgets(screen).widgets();
        if (a.has(indexKey) && !a.get(indexKey).isJsonNull()) {
            int i = a.get(indexKey).getAsInt();
            if (i < 0 || i >= ws.size()) {
                throw new IllegalArgumentException("widget index " + i + " out of range (0.." + (ws.size() - 1) + ")");
            }
            return ws.get(i);
        }
        if (a.has(labelKey) && !a.get(labelKey).isJsonNull()) {
            String needle = a.get(labelKey).getAsString().toLowerCase();
            for (AbstractWidget w : ws) {
                if (label(w).toLowerCase().contains(needle)) {
                    return w;
                }
            }
            StringBuilder avail = new StringBuilder();
            for (AbstractWidget w : ws) {
                if (avail.length() > 0) {
                    avail.append(", ");
                }
                avail.append('"').append(label(w)).append('"');
            }
            throw new IllegalArgumentException("no widget matching label '"
                + a.get(labelKey).getAsString() + "'. Available: " + avail);
        }
        throw new IllegalArgumentException("provide '" + labelKey + "' or '" + indexKey + "'");
    }

    private static String label(final AbstractWidget w) {
        return w.getMessage() == null ? "" : w.getMessage().getString();
    }

    private static JsonElement opened(final String name) {
        JsonObject r = new JsonObject();
        r.addProperty("opened", name);
        return r;
    }
}
