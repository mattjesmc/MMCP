package com.mattmc.mcptoolkit.client;

import com.mattmc.mcptoolkit.BridgeServer;
import com.mattmc.mcptoolkit.McpToolkit;
import com.mattmc.mcptoolkit.drone.DroneEntities;
import com.mattmc.mcptoolkit.hooks.client.ClientHooks;
import com.mattmc.mcptoolkit.hooks.client.ToolkitModelLayers;
import net.fabricmc.api.EnvType;
import net.fabricmc.api.Environment;
import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.entity.EntityRenderers;
import net.minecraft.client.model.geom.ModelLayerLocation;
import net.minecraft.resources.Identifier;

/**
 * Client half of the toolkit: hands the bridge a client-thread executor so CLIENT-context tools can run.
 * Client-only tool groups (chat, UI inspection) register from here in later stages.
 *
 * <p>Implements no loader interface, for the same reason {@link McpToolkit} does not: it holds
 * {@link #DRONE_LAYER}, which {@code DroneRenderer} references, so the class is reachable from
 * rendering code and must load on any loader. {@code fabric/FabricClientEntry} is the shim.
 */
@Environment(EnvType.CLIENT)
public final class McpToolkitClient {
    public static final ModelLayerLocation DRONE_LAYER =
        new ModelLayerLocation(Identifier.fromNamespaceAndPath(McpToolkit.MOD_ID, "drone"), "main");

    private McpToolkitClient() {}

    /** The toolkit's whole client-side startup, in order. Called once, by the live loader shim. */
    public static void init() {
        ToolkitModelLayers.register(DRONE_LAYER, DroneModel::createBodyLayer);
        // Vanilla's EntityRenderers.register is public static — no fabric-api shim needed for these.
        EntityRenderers.register(DroneEntities.DRONE, DroneRenderer::new);
        // The walker renders as the player-shaped body it is (vanilla player geometry + default
        // skin) — the drone-ball placeholder read as "still a drone" in the survival watch-session.
        EntityRenderers.register(DroneEntities.WALKER, WalkerRenderer::new);
        // The authoring stage. Type and renderer ship in ONE jar, deliberately: a registered entity
        // type with no renderer is a client crash, and one that reached a save would keep crashing.
        EntityRenderers.register(DroneEntities.PREVIEW, PreviewRenderer::new);
        // ... and the server-visible half of that: `stage_entity` asks this whether geometry parsed.
        PreviewModels.register();
        com.mattmc.mcptoolkit.ui.sample.client.UiSamplesClient.register();
        // The part library every document in this game expands against: the classpath (this jar's
        // own seed library) plus every loaded pack, so a screen in another mod can say
        // "mcptoolkit:player_inventory" and get it (UI_PARTS_LIBRARY_DESIGN.md section 5).
        com.mattmc.mcptoolkit.ui.interp.ResourceParts.install();
        // Resolve Minecraft.getInstance() lazily at call time — safe even if this runs early in startup.
        BridgeServer.setClientExecutor(r -> Minecraft.getInstance().execute(r));
        BridgeServer.setClientEnvelopeStamper(ClientEnvelope::stamp);
        // Close the bridge when the client goes away. Without this the HTTP dispatcher (non-daemon)
        // keeps the JVM alive past shutdown and the watchdog writes a crash report for a clean quit -
        // which is exactly what happened between 0.79.0 (fabric-api removed, taking
        // ClientLifecycleEvents.CLIENT_STOPPING with it) and 0.81.0.
        ClientHooks.CLIENT_STOPPING.register(BridgeServer::stop);
        // Keep <gameDir>/mcptoolkit/mcp-server current on a CLIENT too.
        //
        // BridgeServer does this for a dedicated server, and until 0.143.0 a launcher did it for a
        // session the GAME started. That launcher is archived and this is now the ONLY path there
        // is - the one docs/guides/ADAPTER.md always called primary: a modder on a single-player
        // client, registering this MCP server in their own host and pointing it at
        // <gameDir>/mcptoolkit/mcp-server/index.mjs. That directory was never created, so the
        // documented instruction named a file that did not exist. The inbound path needs nothing
        // from the toolkit's configuration - which is exactly why nothing was extracting for it.
        //
        // Off-thread for the same reason as the server's copy: a first-boot npm install must not
        // stall startup. Skipped when the bridge is off (requestedPort <= 0), because an extracted
        // server nobody can reach is pure cost.
        if (BridgeServer.requestedPort() > 0) {
            Thread extract = new Thread(() -> {
                String err = com.mattmc.mcptoolkit.ServerExtract.ensureFresh(
                    com.mattmc.mcptoolkit.platform.Platform.gameDir());
                if (err != null) {
                    McpToolkit.LOGGER.warn("[MCP Toolkit] client extract refresh: {}", err);
                }
            }, "mcptoolkit-extract");
            extract.setDaemon(true);
            extract.start();
        }
        // The bridge drives the game while other windows (Claude, Blockbench) hold focus. With
        // pauseOnLostFocus on, Minecraft re-opens the pause menu every tick the window is unfocused,
        // which blanks screenshots and blocks UI tools — so the dev client keeps it off.
        Minecraft.getInstance().execute(() -> Minecraft.getInstance().options.pauseOnLostFocus = false);
        ChatLog.register();
        HumanTaskClient.register(); // §15 task presenter: goal highlight + task card + poll tailer
        ReviewCard.register();      // the review question, on screen while you look at its subject
        HumanCapture.register();    // §15 phase-2 client capture: the true input frame, per tick
        ClientTools.register();
        ScreenNav.register();
        UiTools.register();
        UiWorldClient.register();  // the door into the authoring world + the -Dmcptoolkit.ui.open latch
        UiDesignTools.register();
        RenderTools.register();    // the camera: an out-of-band frame from a viewpoint nobody stands at
        StudioTools.register();    // the white room the camera points at, and the trip there and back
        AssetTools.register();
        LifecycleTools.register();
        WorldCreation.register();  // create_world: a world with its datapacks enabled AT CREATION (K2)
        TooltipTools.register();   // get_tooltip: the one UI line nothing could read back (K2)
        // No menu entry and no launcher: 0.143.0 archived the MMCP screen and the agent launcher
        // both. What a person types is `/mmcp`; what an agent program needs is a registration, and
        // `/mmcp server register <dir>` writes it.
    }
}
