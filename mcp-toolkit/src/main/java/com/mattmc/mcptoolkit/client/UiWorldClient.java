package com.mattmc.mcptoolkit.client;

import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.McpToolkit;
import com.mattmc.mcptoolkit.hooks.client.ClientHooks;
import com.mattmc.mcptoolkit.ui.UiWorld;
import com.mattmc.mcptoolkit.ui.interp.InterpretedScreen;
import com.mattmc.mcptoolkit.ui.interp.UiSource;
import net.fabricmc.api.EnvType;
import net.fabricmc.api.Environment;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.screens.BackupConfirmScreen;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.gui.screens.TitleScreen;
import net.minecraft.client.input.MouseButtonEvent;
import net.minecraft.client.input.MouseButtonInfo;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.Identifier;
import org.jspecify.annotations.Nullable;

import java.nio.file.Path;

/**
 * <b>The door into the authoring world, and the latch that opens a document once you are through
 * it.</b> ({@code SCREEN_AUTHORING_DESIGN.md} §23.)
 *
 * <p>{@link UiWorld} is what the world IS; this is how a client gets into it without a human
 * clicking through the world-selection list. Two doors, one path behind them:
 *
 * <ul>
 *   <li><b>Warm</b> — {@code ui_doc op:"open"} on a client that is already running. At the title
 *       screen it creates the world if it is missing, loads it, and opens the document when the
 *       player arrives (and on a client that has not finished STARTING it refuses rather than
 *       queues - see {@link #ready}, which is the defect the first live run found).
 *       In a world it just opens the document THERE, and says which world that was:
 *       this door never disconnects anybody, because a load started from inside a world is a
 *       disconnect nobody asked for ({@code LifecycleTools.openWorld} refuses for the same reason).</li>
 *   <li><b>Cold</b> — {@code -Dmcptoolkit.ui.open=<doc>} (which {@code launch_game}'s {@code ui}
 *       argument pushes down through {@code rebuild.ps1 -Ui} and {@code -PuiDoc}). One command from a
 *       stopped game to a screen on screen.</li>
 * </ul>
 *
 * <p><b>Why a latch and not {@code --quickPlaySingleplayer}.</b> Vanilla's launch argument loads a
 * save that already exists and can create nothing, so the first run of the cold door would need this
 * code anyway — and then there would be two paths into the same world, one of which only ever runs
 * once. {@code LifecycleTools}' javadoc already names quickPlay as the road not taken for the warm
 * case; this is the same answer for the cold one.
 *
 * <h2>The two things the latch waits for, and why neither is obvious</h2>
 *
 * <p><b>Not "the title screen is up".</b> During startup the loading overlay sits over an already-set
 * {@code TitleScreen}, so a world load fired on the first tick that sees one would race the resource
 * reload. The latch waits for {@code gui.overlay() == null} as well.
 *
 * <p><b>Not "the player exists".</b> {@code mc.player} is non-null while
 * {@code ReceivingLevelScreen} is still up, and that screen is dismissed by the packet listener with
 * {@code setScreen(null)} — which would close the preview we had just opened. So the latch waits for
 * no screen at all, and then for a few more ticks, before opening anything.
 */
@Environment(EnvType.CLIENT)
public final class UiWorldClient {

    private UiWorldClient() {}

    /** The document to open at boot: {@code <mod>:<screen>} or a path. */
    public static final String OPEN_PROPERTY = "mcptoolkit.ui.open";
    /** Arm the in-game editor on that document rather than a read-only preview. */
    public static final String EDIT_PROPERTY = "mcptoolkit.ui.edit";

    /** Ticks of quiet after the loading screens go away before the document is opened. */
    private static final int SETTLE_TICKS = 10;

    private enum Phase {
        /** Nothing pending. */
        IDLE,
        /** A boot request is waiting for the client to finish starting up. */
        BOOT,
        /** A world load is in flight. */
        LOADING,
        /** In the world; counting down before opening the document. */
        SETTLE
    }

    /** How long a started load may take before the latch calls it dead (ticks). */
    private static final int LOAD_DEADLINE_TICKS = 20 * 60;
    /** Grace after a load starts, before "back at the title screen" counts as a failed load. */
    private static final int TITLE_GRACE_TICKS = 40;

    private static Phase phase = Phase.IDLE;
    private static @Nullable UiSource pending;
    private static boolean pendingEdit;
    /**
     * What the boot latch was asked for and what became of it, for the life of this client.
     *
     * <p><b>Why this exists at all.</b> The latch's only evidence used to be the screen it opened,
     * and a screen is the most perishable thing in the game: anything that opens another one erases
     * it. So the probe asserting the launcher's promise could only ever pass as the FIRST thing run
     * against a fresh client - the coupling this workbench has caught before ("a probe that only
     * ever ran one way is coupled to it"), and it went red the first time the ui files were run as
     * a set, six probe files after the latch fired. The armed request and its outcome are durable;
     * they are what {@code get_screen} reports as {@code ui_boot}, and they can be asserted at any
     * point in a client's life.
     *
     * <p>The perishable half is not dropped, it is COPIED IN: {@code screen}/{@code document} are
     * read back off the client the moment the latch's open returns, so the record says what was
     * actually up rather than that a call did not throw. "The latch opened the document" and "an
     * InterpretedScreen showing that document was on screen" stay two claims, and both survive.
     */
    private static @Nullable JsonObject bootRecord;
    private static int settle;
    private static int waited;
    /** One confirm per load. The dialog outlives the click by a tick or two - see {@link #skipAndJoin}. */
    private static boolean confirmed;

    public static void register() {
        String doc = System.getProperty(OPEN_PROPERTY);
        if (doc != null && !doc.isBlank()) {
            pending = parse(doc.trim());
            pendingEdit = Boolean.parseBoolean(System.getProperty(EDIT_PROPERTY, "false"));
            phase = Phase.BOOT;
            bootRecord = new JsonObject();
            bootRecord.addProperty("requested", pending.describe());
            bootRecord.addProperty("edit", pendingEdit);
            bootRecord.addProperty("outcome", "pending");
            McpToolkit.LOGGER.info("[MCP Toolkit] {}={} — the authoring world will open with {} once"
                + " this client has started{}", OPEN_PROPERTY, doc, pending.describe(),
                pendingEdit ? " (editor armed)" : "");
        }
        ClientHooks.END_CLIENT_TICK.register(UiWorldClient::tick);
    }

    /**
     * How {@code -Dmcptoolkit.ui.open} and {@code ui_doc op:"open"} both read a document: an
     * identifier if it parses as one, a path otherwise. A Windows path contains a colon and is not a
     * legal identifier, so the two cannot be confused.
     */
    public static UiSource parse(final String doc) {
        Identifier id = doc.indexOf(':') >= 0 ? Identifier.tryParse(doc) : null;
        return id != null ? new UiSource.Res(id) : new UiSource.File(Path.of(doc));
    }

    // ---------------------------------------------------------------------------------------------
    // the warm door

    /**
     * Open a document, entering the authoring world first when there is no world at all. Runs on the
     * client thread ({@code UiTools} hops it there).
     */
    public static JsonObject open(final UiSource source, final boolean edit) {
        Minecraft mc = Minecraft.getInstance();
        if (mc.level != null) {
            // Already somewhere: preview HERE. Which world that was is part of the answer, because
            // "the document opened" and "the document opened in the world you meant" are two claims.
            JsonObject r = (JsonObject) UiTools.openUiPreview(source, edit);
            r.addProperty("entered", false);
            r.addProperty("world", worldName(mc));
            r.addProperty("authoring_world", isInAuthoringWorld(mc));
            if (!isInAuthoringWorld(mc)) {
                r.addProperty("note_world", "opened in the world that was already loaded, not the"
                    + " authoring world — this door never disconnects. Quit to the title screen first"
                    + " if you want " + UiWorld.LEVEL_ID + ".");
            }
            return r;
        }
        if (phase != Phase.IDLE) {
            throw new IllegalStateException("a world load is already in flight for "
                + (pending == null ? "a document" : pending.describe()) + "; wait for it");
        }
        // REFUSED RATHER THAN QUEUED, and this is the one thing the first live run got wrong: called
        // while the client was still starting up, createWorldOpenFlows started a load that the rest
        // of startup then discarded - and this method had already answered "the load has STARTED".
        // A door that reports an act it did not perform is worse than one that says "not yet".
        if (!ready(mc)) {
            throw new IllegalStateException("the client is still starting up (screen: "
                + (mc.gui.screen() == null ? "none" : mc.gui.screen().getClass().getSimpleName())
                + (mc.gui.overlay() != null ? ", loading overlay up" : "") + ") - a world load started"
                + " now would be discarded by the rest of startup. Poll get_screen until the title"
                + " screen is up, then call again.");
        }
        // Fail on an unreadable or unparseable document BEFORE loading a world for it. A four-second
        // world load followed by "that file has 3 problems" is the same refusal, later and dearer.
        try {
            source.load();
        } catch (java.io.IOException e) {
            throw new IllegalArgumentException("cannot read " + source.describe() + ": " + e.getMessage());
        } catch (com.mattmc.mcptoolkit.ui.doc.UiParseException e) {
            throw new IllegalArgumentException(source.describe() + " has " + e.problems().size()
                + " problem(s): " + e.problems());
        }

        boolean fresh = !mc.getLevelSource().levelExists(UiWorld.LEVEL_ID);
        pending = source;
        pendingEdit = edit;
        enter(mc);

        JsonObject r = new JsonObject();
        r.addProperty("document", source.describe());
        r.addProperty("editor", edit);
        r.addProperty("entered", true);
        r.addProperty("world", UiWorld.LEVEL_ID);
        r.addProperty("created", fresh);
        r.addProperty("note", "the world load has STARTED and the document opens by itself when the"
            + " player arrives; poll get_screen until it names InterpretedScreen (a load that fails"
            + " leaves the client at the title screen and says so in the log)");
        return r;
    }

    /** Start the load: create the world on its first use, open it every time after. */
    private static void enter(final Minecraft mc) {
        phase = Phase.LOADING;
        waited = 0;
        confirmed = false;
        if (mc.getLevelSource().levelExists(UiWorld.LEVEL_ID)) {
            mc.createWorldOpenFlows().openWorld(UiWorld.LEVEL_ID, () -> mc.gui.setScreen(new TitleScreen()));
        } else {
            mc.createWorldOpenFlows().createFreshLevel(UiWorld.LEVEL_ID, UiWorld.levelSettings(),
                UiWorld.worldOptions(), UiWorld::dimensions, new TitleScreen());
        }
    }

    // ---------------------------------------------------------------------------------------------
    // the latch

    /**
     * True when a world load started now will survive: no loading overlay, no world yet, and the
     * title screen up. Startup sets a {@code GenericMessageScreen} and then the title screen over
     * whatever is there, which is precisely how a load fired too early disappears.
     */
    private static boolean ready(final Minecraft mc) {
        return mc.gui.overlay() == null && mc.level == null && mc.gui.screen() instanceof TitleScreen;
    }

    private static void tick(final Minecraft mc) {
        switch (phase) {
            case BOOT -> {
                if (mc.level != null) {
                    phase = Phase.LOADING;
                    waited = 0;
                } else if (ready(mc)) {
                    try {
                        enter(mc);
                    } catch (RuntimeException e) {
                        McpToolkit.LOGGER.warn("[MCP Toolkit] could not enter the authoring world: {}",
                            e.toString());
                        record("not_entered", e.toString());
                        clear();
                    }
                }
            }
            case LOADING -> {
                // Not "the player exists": ReceivingLevelScreen is dismissed with setScreen(null),
                // which would close a preview opened a moment too early.
                if (mc.player != null && mc.level != null && mc.gui.screen() == null) {
                    settle = SETTLE_TICKS;
                    phase = Phase.SETTLE;
                    return;
                }
                if (!confirmed && mc.gui.screen() instanceof BackupConfirmScreen confirm) {
                    // A world carrying ANY non-vanilla dimension is EXPERIMENTAL, and vanilla stops
                    // every open of one on this dialog. Canvas no longer writes its dimensions into
                    // this world, which removes the usual cause - but the cause is not the point:
                    // a door that promised to open a world must not leave a modal sitting on it. Only
                    // ever while WE are loading THIS world, and never the backup button: the save is
                    // toolkit-made, disposable and recreated on demand.
                    skipAndJoin(confirm);
                    return;
                }
                waited++;
                // A load that failed puts the title screen back with no level. Bounded, because a
                // latch that waits forever turns a failed load into a silent hang.
                boolean failed = waited > TITLE_GRACE_TICKS && mc.level == null
                    && mc.gui.screen() instanceof TitleScreen;
                if (failed || waited > LOAD_DEADLINE_TICKS) {
                    String why = failed ? "back at the title screen" : "timed out";
                    McpToolkit.LOGGER.warn("[MCP Toolkit] the authoring world did not load ({}); {} was"
                        + " not opened", why,
                        pending == null ? "the document" : pending.describe());
                    record("not_loaded", why);
                    clear();
                }
            }
            case SETTLE -> {
                if (mc.player == null || mc.level == null) {
                    phase = Phase.LOADING;
                } else if (--settle <= 0) {
                    UiSource source = pending;
                    boolean edit = pendingEdit;
                    clear();
                    if (source != null) {
                        openNow(source, edit);
                    }
                }
            }
            default -> { }
        }
    }

    /**
     * Press "Skip and join" on the backup dialog, the way {@code click} does it: a synthetic press at
     * the widget's centre through the screen's own handler, rather than reaching for a private
     * listener. The button is found by its MESSAGE, so it is not the button ORDER that is being
     * trusted, and the translatable compares by key rather than by rendered text.
     *
     * <p><b>Once per load, and the live run is why.</b> The dialog is still the open screen for a
     * tick or two after its button runs, so a latch that clicks whenever it sees one clicked twice -
     * two world loads against one {@code LevelStorageAccess}, and the client died on
     * {@code IllegalStateException: Lock is no longer valid} while starting the integrated server.
     */
    private static void skipAndJoin(final BackupConfirmScreen confirm) {
        confirmed = true;
        Component skip = Component.translatable("selectWorld.backupJoinSkipButton");
        for (var child : confirm.children()) {
            if (child instanceof AbstractWidget w && skip.equals(w.getMessage())) {
                MouseButtonEvent ev = new MouseButtonEvent(
                    w.getX() + w.getWidth() / 2.0, w.getY() + w.getHeight() / 2.0,
                    new MouseButtonInfo(0, 0));
                confirm.mouseClicked(ev, false);
                confirm.mouseReleased(ev);
                McpToolkit.LOGGER.info("[MCP Toolkit] the authoring world asked for a backup"
                    + " (experimental settings); joined without one");
                return;
            }
        }
        McpToolkit.LOGGER.warn("[MCP Toolkit] a backup dialog is holding the authoring world's load"
            + " and its skip button was not found - the load will time out");
    }

    private static void openNow(final UiSource source, final boolean edit) {
        try {
            UiTools.openUiPreview(source, edit);
            McpToolkit.LOGGER.info("[MCP Toolkit] authoring world: opened {}{}", source.describe(),
                edit ? " in the editor" : "");
            record("opened", null);
            // What is ACTUALLY up, read back off the client rather than assumed from the call
            // returning. This is the perishable half made durable: "the latch opened the document"
            // and "an InterpretedScreen showing that document was on screen" are two claims, and
            // recording the second here is what stops the first from being a record of an INTENT.
            Screen now = Minecraft.getInstance().gui.screen();
            if (bootRecord != null) {
                bootRecord.addProperty("screen", now == null ? null : now.getClass().getSimpleName());
                if (now instanceof InterpretedScreen is) {
                    bootRecord.addProperty("document", is.source().describe());
                    bootRecord.addProperty("detached", is.isDetached());
                }
            }
        } catch (RuntimeException e) {
            // The world is loaded and usable; only the document failed. Say so where a launch log
            // will show it, and leave the player standing in the world rather than at a dead end.
            String why = e.getMessage() == null ? e.toString() : e.getMessage();
            McpToolkit.LOGGER.warn("[MCP Toolkit] authoring world: could not open {}: {}",
                source.describe(), why);
            record("error", why);
        }
    }

    /**
     * Write the latch's outcome into the lifetime record. Only ever called when the latch was armed
     * (there is nothing to record otherwise), and never cleared: {@link #clear} resets the machine,
     * not the history.
     */
    private static void record(final String outcome, final @Nullable String why) {
        if (bootRecord == null) {
            return;
        }
        bootRecord.addProperty("outcome", outcome);
        if (why != null) {
            bootRecord.addProperty("why", why);
        }
    }

    /** What the boot latch was asked for and what became of it, or null when it was never armed. */
    public static @Nullable JsonObject bootRecord() {
        return bootRecord == null ? null : bootRecord.deepCopy();
    }

    private static void clear() {
        phase = Phase.IDLE;
        pending = null;
        pendingEdit = false;
        settle = 0;
        waited = 0;
        confirmed = false;
    }

    // ---------------------------------------------------------------------------------------------

    /** True when this client is in the authoring world (the integrated server knows its own name). */
    public static boolean isInAuthoringWorld(final Minecraft mc) {
        return mc.getSingleplayerServer() != null && UiWorld.isAuthoringWorld(mc.getSingleplayerServer());
    }

    private static String worldName(final Minecraft mc) {
        if (mc.getSingleplayerServer() != null) {
            return mc.getSingleplayerServer().getWorldData().getLevelName();
        }
        return mc.level == null ? "(none)" : mc.level.dimension().identifier().toString();
    }
}
