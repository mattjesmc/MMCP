package com.mattmc.mcptoolkit.drone;

import com.mattmc.mcptoolkit.McpToolkit;
import com.mattmc.mcptoolkit.nav.NavProfile;
import com.mojang.authlib.GameProfile;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.core.UUIDUtil;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.network.CommonListenerCookie;
import net.minecraft.world.level.GameType;
import net.minecraft.world.level.storage.LevelResource;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

/**
 * Lifecycle for {@link FakePlayerEntity} bodies — spawn, despawn, and the guarantee that none of
 * them outlives the server (BOT_SURFACE_DESIGN.md §11.4).
 *
 * <p><b>Not in a session slot yet, deliberately.</b> The whole {@code bot_*} control surface is typed
 * to {@code Mob} ({@code DroneTools.Slot.activeBody}, {@code Actuator.body}, possession, the goal
 * loop), and a {@code ServerPlayer} is not one. Widening that to {@code LivingEntity} is a refactor
 * of code the 0.24.0 review round just hardened, so it is its own slice; this registry keeps the
 * player body reachable and verifiable without forking a second control surface in the meantime.
 * Bodies here are keyed by name, not by session.
 */
public final class FakePlayers {

    private static final Map<String, FakePlayerEntity> BODIES = new LinkedHashMap<>();

    private FakePlayers() {
    }

    public static void register() {
        // No fake player may survive the server: the same discipline every toolkit body follows.
        com.mattmc.mcptoolkit.hooks.ServerHooks.SERVER_STOPPING.register(
            server -> despawnAll(server, "server_stopping"));
        FakePlayerCommand.register();
    }

    /** Live bodies by name, dropping any whose entity has been removed underneath us. */
    public static Map<String, FakePlayerEntity> live() {
        BODIES.entrySet().removeIf(e -> e.getValue().isRemoved());
        return Map.copyOf(BODIES);
    }

    public static @Nullable FakePlayerEntity get(final String name) {
        FakePlayerEntity body = BODIES.get(name);
        if (body != null && body.isRemoved()) {
            BODIES.remove(name);
            return null;
        }
        return body;
    }

    /**
     * Bring a headless player into {@code level} at {@code at}. Throws when the name is taken — by
     * another fake body or by a real logged-in player, since both would collide on the same offline
     * UUID and the second placement would evict the first.
     */
    public static FakePlayerEntity spawn(final MinecraftServer server, final ServerLevel level,
                                         final String name, final Vec3 at, final float yaw) {
        if (get(name) != null) {
            throw new IllegalStateException("a fake player named '" + name + "' already exists");
        }
        GameProfile profile = UUIDUtil.createOfflineProfile(name);
        if (server.getPlayerList().getPlayer(profile.id()) != null) {
            throw new IllegalStateException("a player with the name '" + name + "' is already connected");
        }

        FakePlayerEntity body = new FakePlayerEntity(server, level, profile);
        // Position BEFORE placement so the login bookkeeping (chunk ticket, tracking) starts at the
        // right place rather than at world spawn and then teleporting.
        body.absSnapTo(at.x, at.y, at.z, yaw, 0.0F);
        server.getPlayerList().placeNewPlayer(new FakeConnection(), body,
            CommonListenerCookie.createInitial(profile, false));
        // placeNewPlayer may reposition from (absent) saved data; snap again so `at` is authoritative.
        body.absSnapTo(at.x, at.y, at.z, yaw, 0.0F);
        body.setGameMode(GameType.SURVIVAL);
        BODIES.put(name, body);
        McpToolkit.LOGGER.info("fake player '{}' spawned at {} {} {}", name, at.x, at.y, at.z);
        return body;
    }

    /** Walk a body to {@code target}; false when no path exists (reported, never walked hopefully). */
    public static boolean goTo(final FakePlayerEntity body, final BlockPos target, final double speed) {
        return body.navigation().moveTo(body.level(), target, speed, NavProfile.DEFAULT);
    }

    /** Remove a body and its playerdata file. Returns false when no such body was live. */
    public static boolean despawn(final MinecraftServer server, final String name, final String reason) {
        FakePlayerEntity body = BODIES.remove(name);
        if (body == null) {
            return false;
        }
        removeBody(server, body, reason);
        return true;
    }

    public static void despawnAll(final MinecraftServer server, final String reason) {
        for (FakePlayerEntity body : Map.copyOf(BODIES).values()) {
            removeBody(server, body, reason);
        }
        BODIES.clear();
    }

    private static void removeBody(final MinecraftServer server, final FakePlayerEntity body,
                                   final String reason) {
        body.navigation().stop();
        // PlayerList.remove does the bookkeeping no shortcut should skip (chunk tracking, stats,
        // boss events, playersByUUID) — but it also insists on writing playerdata, which this body
        // must never leave behind. saveWithoutId writes nothing; this deletes the husk.
        server.getPlayerList().remove(body);
        deletePlayerData(server, body.getStringUUID());
        McpToolkit.LOGGER.info("fake player '{}' despawned ({})",
            body.getGameProfile().name(), reason);
    }

    /**
     * Delete the {@code <uuid>.dat} (and its {@code .dat_old} backup) that {@code PlayerList.remove}
     * writes. {@code PlayerDataStorage.save} does not consult {@code shouldBeSaved}, so overriding it
     * on the entity is not enough on its own — the file is created regardless and only its contents
     * are ours to suppress.
     */
    private static void deletePlayerData(final MinecraftServer server, final String uuid) {
        try {
            Path dir = server.getWorldPath(LevelResource.PLAYER_DATA_DIR);
            Files.deleteIfExists(dir.resolve(uuid + ".dat"));
            Files.deleteIfExists(dir.resolve(uuid + ".dat_old"));
        } catch (Exception e) {
            // Never fatal: a stray file is untidy, not incorrect, and a despawn must still complete.
            McpToolkit.LOGGER.warn("could not delete fake-player data for {}: {}", uuid, e.toString());
        }
    }
}
