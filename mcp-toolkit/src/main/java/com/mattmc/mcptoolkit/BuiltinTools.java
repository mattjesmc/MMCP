package com.mattmc.mcptoolkit;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/** Tools the toolkit itself provides, independent of any consuming mod. */
public final class BuiltinTools {
    private BuiltinTools() {}

    /** Random per-JVM-launch id — lets a session notice the game restarted (possibly as a different instance). */
    private static final String INSTANCE_ID = java.util.UUID.randomUUID().toString();

    public static void register() {
        McpTools.register(ToolDef.of(
            "ping",
            "Check the MCP toolkit bridge is reachable and identify the instance: whether a server and "
                + "client are present, env (\"development\" = gradle dev run, \"production\" = normal "
                + "launcher install), the absolute gameDir, the port this bridge is listening on, and a "
                + "per-launch instanceId — if instanceId "
                + "changes mid-session the game restarted and prior assumptions about its state are stale. "
                + "Check env before dev-workspace workflows (hotswap, rebuild): a production instance has "
                + "no build tree. Also lists the extension mods contributing tools to this bridge, with "
                + "the tools each registered and any registration failures — the place to look when a "
                + "mod's tool is missing from the manifest. This game LAUNCHES NOTHING: an agent "
                + "reaches it by registering this MCP server in its own host and dialing the port "
                + "above, which needs no configuration here at all. `last_crash` {at, path, title} "
                + "names a crash report newer than the previous boot; read it with get_log {crash}. `build` "
                + "{started_at, mods_hash, mods:[{id, version, origins:[{path, mtime}]}], stale} names the "
                + "BUILD: a suite refuses an instance whose mod origin is not the jar it built, and "
                + "stale:true means an origin is newer than this JVM (rebuilt underneath it).",
            Schemas.object(),
            ExecutionContext.ANY,
            Mechanism.OBSERVE,
            (ctx, args) -> {
                JsonObject r = new JsonObject();
                r.addProperty("pong", true);
                r.addProperty("mod", McpToolkit.MOD_ID);
                MinecraftServer s = ctx.server();
                r.addProperty("serverRunning", s != null);
                r.addProperty("clientPresent", BridgeServer.hasClient());
                r.addProperty("loader", com.mattmc.mcptoolkit.platform.Platform.loaderName());
                r.addProperty("env", com.mattmc.mcptoolkit.platform.Platform.isDevelopment()
                    ? "development" : "production");
                r.addProperty("gameDir",
                    com.mattmc.mcptoolkit.platform.Platform.gameDir().toAbsolutePath().toString());
                // The port this bridge is actually listening on. docs/guides/ADAPTER.md has told
                // readers to get it from here since it was written; it never reported one.
                r.addProperty("port", BridgeServer.boundPort());
                r.addProperty("instanceId", INSTANCE_ID);
                r.add("build", BuildIdentity.report());
                JsonObject lastCrash = CrashReports.lastCrash();
                if (lastCrash != null) {
                    r.add("last_crash", lastCrash);
                }
                r.add("extensions", Extensions.report());
                r.add("wm", com.mattmc.mcptoolkit.wm.Wm.report());
                return r;
            }));

        McpTools.register(ToolDef.of(
            "get_world_info",
            "Identify the loaded world: persistent world_uuid (minted on first call, stored in the world save — the key for per-world agent memory), display name, seed hash, current game tick, and dimension ids.",
            Schemas.object(),
            ExecutionContext.SERVER,
            Mechanism.OBSERVE,
            (ctx, args) -> worldInfo(ctx.serverOrThrow())));
    }

    private static JsonObject worldInfo(final MinecraftServer server) {
        JsonObject r = new JsonObject();
        r.addProperty("world_uuid", WorldIdentity.get(server));
        r.addProperty("name", server.getWorldData().getLevelName());
        r.addProperty("seed_hash", seedHash(server.overworld().getSeed()));
        r.addProperty("game_tick", server.overworld().getGameTime());
        JsonArray dims = new JsonArray();
        for (ServerLevel level : server.getAllLevels()) {
            dims.add(level.dimension().identifier().toString());
        }
        r.add("dimensions", dims);
        return r;
    }

    /** First 8 bytes of SHA-256 over the seed's decimal string — diagnostic identity, not the raw seed. */
    private static String seedHash(final long seed) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] digest = md.digest(Long.toString(seed).getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(16);
            for (int i = 0; i < 8; i++) {
                sb.append(String.format("%02x", digest[i]));
            }
            return sb.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
