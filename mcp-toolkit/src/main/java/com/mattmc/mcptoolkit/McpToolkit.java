package com.mattmc.mcptoolkit;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Standalone mod that hosts the MCP bridge and tool registry, plus the built-in tool groups (world
 * perception, drone, shapes, game control, event/audit log, UI inspection/design, assets, hotswap).
 * Other mods (Village Jobs, and later others) contribute their own tools through the
 * {@code "mcptoolkit"} entrypoint — see {@link McpToolkitEntrypoint} and {@code EXTENDING.md}.
 *
 * <p>Architecture and decision record: {@code mcp-toolkit/ARCHITECTURE.md} — read it before extending the
 * toolkit; it fixes the vocabulary (perception modes, tool mechanisms, sensor vs actuator seams) and the
 * copilot-first roadmap.
 *
 * <p><b>This class deliberately implements no loader interface.</b> It holds {@link #MOD_ID} and
 * {@link #LOGGER}, which 41 files reference, so it is loaded on every code path there is. An
 * {@code implements ModInitializer} here would mean loading it on NeoForge throws
 * {@link NoClassDefFoundError} and takes the whole toolkit down with it. The loader-facing entrypoint
 * is a thin per-loader shim ({@code fabric/FabricEntry}) that calls {@link #init()}; see
 * {@code CROSS_LOADER_DESIGN.md}.
 */
public final class McpToolkit {
    public static final String MOD_ID = "mcptoolkit";
    public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

    private McpToolkit() {}

    /**
     * The toolkit's whole server-side startup, in order. Called once per game, by whichever loader
     * shim is live. The ordering comments below are load-bearing — read them before reordering.
     */
    public static void init() {
        // FIRST: the log ring. Everything below this line can log, and a capture that attaches
        // after the toolkit's own startup would miss exactly the messages a broken startup writes.
        // It cannot see the loader's phase (mod resolution, mixin apply) either way — mod init is
        // the earliest this code runs at all — and get_log's contract says so.
        LogCapture.start();
        // SECOND: the boot stamp. ping.last_crash is "a report newer than the PREVIOUS boot", and
        // the previous boot is only knowable if every boot writes the time down (CrashReports).
        CrashReports.stampBoot();
        // The body entity types and their attributes. Where the types actually get registered
        // depends on whether fabric-api is on the classpath - DroneEntities.bootstrap() owns that
        // fork and works either way; nothing below it needs to know which world this is.
        com.mattmc.mcptoolkit.drone.DroneEntities.bootstrap();
        // The screen-authoring sample: the shipped example document's GENERATED screen, registered
        // through the same two windows the body types use (UiSamples.registerTypes rides the same
        // mixin hook). It is what the conformance probe compares the interpreter against.
        com.mattmc.mcptoolkit.ui.sample.UiSamples.register();
        // ui_doc (SCREEN_AUTHORING_DESIGN.md section 10): the fourth editor. Registered COMMON, not
        // client - reading, linting, editing and generating a document are files and the model, and
        // a dedicated server can do all four. Its one client-side op fills a seam UiTools installs.
        com.mattmc.mcptoolkit.ui.UiDocTools.register();
        // The authoring world's game rules, applied on the start of the server that IS it (section
        // 23). Server-side because a rule is: the client half of the door is McpToolkitClient's.
        com.mattmc.mcptoolkit.ui.UiWorld.register();
        WorldEvents.register();
        BuiltinTools.register();
        EventTools.register();
        LogTools.register();
        ChatTools.register();
        SessionTools.register();
        GameTools.register();
        WorldPerceptionTools.register();
        PredicateTools.register();
        RegionTools.register();
        LocateTools.register();
        ShapeTools.register();
        BlockTools.register();
        EditTools.register();
        RegistryTools.register();
        LootTools.register();
        DataTools.register();
        StructureTools.register();
        PerfTools.register();
        WorldgenTools.register();
        ClassTools.register();
        com.mattmc.mcptoolkit.drone.DroneTools.register();
        com.mattmc.mcptoolkit.drone.DroneHands.register();
        com.mattmc.mcptoolkit.drone.Crafting.register();
        com.mattmc.mcptoolkit.drone.Containers.register();
        com.mattmc.mcptoolkit.drone.Reflexes.register();
        com.mattmc.mcptoolkit.drone.Watch.register();
        com.mattmc.mcptoolkit.drone.Perception.register();
        com.mattmc.mcptoolkit.drone.FakePlayers.register();
        com.mattmc.mcptoolkit.drone.WalkerThreat.register();
        // The entity editor's whole bridge surface (ENTITY_AUTHORING_DESIGN.md §5.1): one tool.
        com.mattmc.mcptoolkit.preview.PreviewTools.register();
        HotswapTools.register();
        // The canvas: two shipped dimensions and the human edit loop (RENDER_SEAM_DESIGN.md §4.2,
        // §10). AFTER DataTools.register() only for reading order — it uses the live datapack's root,
        // not its tools — and before the bridge serves, like everything else here.
        com.mattmc.mcptoolkit.canvas.Canvas.register();
        // The review layer: owed human tests as a queue a person can walk. Registered BEFORE
        // Extensions.discover() so an extension's Review.declare() call in its entrypoint lands on
        // a subsystem that already exists.
        com.mattmc.mcptoolkit.review.Review.register();
        // The §15 task presenter — BEFORE Wm.init() so its SERVER_STOPPING listener closes open
        // human episodes while the recorder is still writing (hooks fire in registration order).
        com.mattmc.mcptoolkit.wm.HumanTasks.register();
        // The world-model recorder (the world-model project's DESIGN.md §3, §17 — a separate repository;
        // see the wm package-info): off by default, config-gated;
        // when on it taps the fan walks, input-frame sinks, goal starts and the event log.
        com.mattmc.mcptoolkit.wm.Wm.init();
        // `/mmcp server` — the registrations this game has written, manageable from a console: the
        // whole inbound path, and the only surface a headless probe can drive. The game never starts
        // an agent of its own (0.143.0 archived the launcher); it is registered IN one's workspace.
        com.mattmc.mcptoolkit.agent.AgentCommands.register();
        // `/mmcp mcp` — the URL of this game's OWN MCP server and what each surface serves. The
        // server itself is started by BridgeServer.init() below; this is only how a person finds it.
        com.mattmc.mcptoolkit.mcp.McpCommands.register();
        // Extensions last, so a builtin name can never be shadowed, and before the bridge serves, so
        // the first manifest a session fetches is already complete.
        Extensions.discover();
        BridgeServer.init();
    }
}
