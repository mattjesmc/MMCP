package com.mattmc.mcptoolkit.hooks;

import com.mojang.brigadier.CommandDispatcher;
import net.minecraft.commands.CommandBuildContext;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.network.chat.PlayerChatMessage;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.Mob;

import java.util.function.Consumer;

/**
 * Server-side hooks, fired by the toolkit's own mixins (see {@code mixin/}) — the fabric-api events
 * the toolkit used, re-homed onto {@link HookEvent}. Injection points (verified against
 * vanilla-src 26.2):
 *
 * <ul>
 *   <li>{@link #SERVER_STARTED} — {@code MinecraftServer.runServer} after successful init
 *       (at the {@code loadStatusIcon} call, which only runs when {@code initServer} returned true).</li>
 *   <li>{@link #SERVER_STOPPING} / {@link #SERVER_STOPPED} — {@code stopServer} HEAD / RETURN.</li>
 *   <li>{@link #END_SERVER_TICK} — {@code tickServer} TAIL.</li>
 *   <li>{@link #CHAT_MESSAGE} — {@code PlayerList.broadcastChatMessage} (the {@code ServerPlayer}
 *       overload: player chat only, matching fabric's CHAT_MESSAGE vs COMMAND_MESSAGE split).</li>
 *   <li>{@link #COMMAND_REGISTRATION} — {@code Commands} constructor RETURN (vanilla commands are
 *       all registered by then).</li>
 *   <li>{@link #ENTITY_LOAD} — {@code ServerLevel$EntityCallbacks.onTrackingStart} TAIL; the level
 *       is reachable as {@code entity.level()}.</li>
 *   <li>{@link #MOB_CONVERSION} — {@code Mob.convertTo} (4-arg funnel) RETURN when non-null: the
 *       new mob is spawned and finalized, the old one already discarded when vanilla wants that.</li>
 * </ul>
 */
public final class ServerHooks {
    private ServerHooks() {}

    public static final HookEvent<Consumer<MinecraftServer>> SERVER_STARTED = HookEvent.create("server_started");
    public static final HookEvent<Consumer<MinecraftServer>> SERVER_STOPPING = HookEvent.create("server_stopping");
    public static final HookEvent<Consumer<MinecraftServer>> SERVER_STOPPED = HookEvent.create("server_stopped");
    public static final HookEvent<Consumer<MinecraftServer>> END_SERVER_TICK = HookEvent.create("end_server_tick");
    public static final HookEvent<Consumer<Entity>> ENTITY_LOAD = HookEvent.create("entity_load");

    @FunctionalInterface
    public interface ChatMessage {
        void onChat(PlayerChatMessage message, ServerPlayer sender);
    }

    public static final HookEvent<ChatMessage> CHAT_MESSAGE = HookEvent.create("server_chat_message");

    @FunctionalInterface
    public interface CommandRegistration {
        void register(CommandDispatcher<CommandSourceStack> dispatcher, CommandBuildContext context,
                      Commands.CommandSelection selection);
    }

    public static final HookEvent<CommandRegistration> COMMAND_REGISTRATION = HookEvent.create("command_registration");

    @FunctionalInterface
    public interface MobConversion {
        /** A conversion (e.g. zombie→drowned) replaced {@code previous} with {@code converted}. */
        void onConvert(Mob previous, Mob converted);
    }

    public static final HookEvent<MobConversion> MOB_CONVERSION = HookEvent.create("mob_conversion");
}
