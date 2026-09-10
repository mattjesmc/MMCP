package com.mattmc.mcptoolkit.client;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.ExecutionContext;
import com.mattmc.mcptoolkit.McpTools;
import com.mattmc.mcptoolkit.Mechanism;
import com.mattmc.mcptoolkit.Schemas;
import com.mattmc.mcptoolkit.ToolDef;
import net.fabricmc.api.EnvType;
import net.fabricmc.api.Environment;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.TitleScreen;

import java.util.concurrent.CompletableFuture;

/**
 * Process lifecycle control, used by the rebuild/relaunch loop: {@code quit_game} cleanly stops the client so
 * its lock on the built jar is released, letting a host script rebuild and relaunch. The stop is scheduled a
 * beat after the response is sent, so the caller gets an acknowledgement before the game exits.
 *
 * <p>{@code open_world} is the other end of that cycle and the half that was missing
 * ({@code RENDER_SEAM_DESIGN.md} §4.3, phase 4). {@code launch_game} brings a client up and leaves it
 * at the title screen; every CLIENT-context probe then needs a world, and until now the only ways in
 * were a human click or a chain of {@code click} calls through the world-selection list. The launch
 * argument route exists too ({@code --quickPlaySingleplayer}) and answers a different question: this
 * one works on a client that is <b>already running</b>, so changing worlds costs no relaunch.
 */
@Environment(EnvType.CLIENT)
public final class LifecycleTools {
    private LifecycleTools() {}

    public static void register() {
        McpTools.register(ToolDef.async(
            "open_world",
            "Open a singleplayer world on a client that is sitting at the title screen — the cold path with no "
                + "human click in it. Call with no arguments to list the save folders this client can see. "
                + "Returns as soon as the load is STARTED, never claiming it finished: a world load takes many "
                + "seconds and can still fail on its own screen, so poll get_world_info (or ping's "
                + "serverRunning) until the level is actually there. Refuses when a world is already open — "
                + "quit to the title screen first, which is a different act and should look like one.",
            Schemas.objectOpt(Schemas.object(
                    "world", Schemas.str("The save FOLDER name, exactly as listed (not the display name).")),
                "world"),
            ExecutionContext.CLIENT,
            Mechanism.PRIVILEGED,
            (ctx, a) -> CompletableFuture.completedFuture(openWorld(a))));

        McpTools.register(ToolDef.async(
            "quit_game",
            "Cleanly quit the Minecraft client to desktop (saving first). Use before a rebuild so the jar lock "
                + "is released. Returns immediately with {stopping:true}; the game exits a moment later, after "
                + "which the bridge stops answering.",
            Schemas.object(),
            ExecutionContext.CLIENT,
            Mechanism.PRIVILEGED,
            (ctx, a) -> quit()));
    }

    /**
     * List the saves, or start one loading. The listing is vanilla's own candidate scan rather than a
     * directory read, so a folder the game would refuse (a symlink it distrusts, a level it cannot
     * read) is absent here for the same reason it would be absent from the world-selection screen —
     * a list that disagrees with the thing it is a list OF is worse than no list.
     */
    private static JsonElement openWorld(final JsonObject a) {
        Minecraft mc = Minecraft.getInstance();
        boolean named = a != null && a.has("world") && !a.get("world").isJsonNull();
        if (!named) {
            JsonObject r = new JsonObject();
            com.google.gson.JsonArray worlds = new com.google.gson.JsonArray();
            try {
                for (var level : mc.getLevelSource().findLevelCandidates()) {
                    worlds.add(level.directoryName());
                }
            } catch (Exception e) {
                throw new IllegalStateException("could not read the saves directory: " + e.getMessage(), e);
            }
            r.add("worlds", worlds);
            r.addProperty("saves_dir", mc.getLevelSource().getBaseDir().toString());
            r.addProperty("open", mc.level != null);
            return r;
        }
        // A load started from inside a world is not "switch worlds", it is a disconnect nobody asked
        // for. Refusing here keeps the two acts distinguishable to whoever is reading the transcript.
        if (mc.level != null) {
            throw new IllegalStateException("a world is already open ("
                + mc.level.dimension().identifier() + "); quit to the title screen first");
        }
        String id = a.get("world").getAsString();
        if (!mc.getLevelSource().levelExists(id)) {
            throw new IllegalArgumentException("no save folder named \"" + id
                + "\" — call open_world with no arguments to list what is there");
        }
        mc.createWorldOpenFlows().openWorld(id, () -> mc.gui.setScreen(new TitleScreen()));
        JsonObject r = new JsonObject();
        r.addProperty("opening", id);
        // Said in the reply and not only in the description, because the honest fact about this call
        // is that it returns before the thing it started has happened.
        r.addProperty("note", "the load has STARTED; poll get_world_info until the level answers");
        return r;
    }

    private static CompletableFuture<JsonElement> quit() {
        // Schedule the shutdown off-thread so this response flushes first; Minecraft.stop() tears the client
        // down and would otherwise strand the HTTP reply.
        Thread t = new Thread(() -> {
            try {
                Thread.sleep(400);
            } catch (InterruptedException ignored) {
                return;
            }
            Minecraft.getInstance().execute(() -> Minecraft.getInstance().stop());
        }, "mcptoolkit-quit");
        t.setDaemon(true);
        t.start();

        JsonObject r = new JsonObject();
        r.addProperty("stopping", true);
        return CompletableFuture.completedFuture(r);
    }
}
