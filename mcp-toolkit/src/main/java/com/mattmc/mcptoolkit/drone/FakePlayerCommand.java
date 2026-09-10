package com.mattmc.mcptoolkit.drone;

import com.mattmc.mcptoolkit.CommandRoot;
import com.mattmc.mcptoolkit.hooks.ServerHooks;
import com.mojang.brigadier.arguments.StringArgumentType;
import net.minecraft.commands.Commands;
import net.minecraft.commands.arguments.coordinates.BlockPosArgument;
import net.minecraft.commands.arguments.coordinates.Vec3Argument;
import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.phys.Vec3;

/**
 * The dev seam for the player body: {@code /mmcp fakeplayer …}.
 *
 * <p><b>Why a command and not a tool.</b> The toolkit's surface is budgeted — every MCP tool costs
 * static-prefix tokens in every session, and the collapse rule governs what earns a slot
 * (TOOL_BILL_PLAN, SURFACE_MERGE_DESIGN). A body that cannot yet act (no hands, no goal loop — the
 * {@code Mob}-typing slice is not done) has not earned one, and a throwaway tool would have to be
 * un-shipped later. A server command is reachable from probes through the existing
 * {@code run_command} tool at ZERO manifest cost, which is exactly what a capability under
 * verification should cost.
 */
final class FakePlayerCommand {

    private FakePlayerCommand() {
    }

    static void register() {
        ServerHooks.COMMAND_REGISTRATION.register((dispatcher, registryAccess, environment) ->
            dispatcher.register(CommandRoot.root()
                // The watcher's door to the session bodies (SURVIVAL_MODE_PLAN.md — the smoke's
                // third complaint: "impossible to teleport to or /spectate"). `/mmcp body` lists
                // them with positions; `/mmcp body tp [session]` teleports YOU to one (then F5 to
                // shoulder-watch, or /spectate its nameplate entity from spectator mode).
                .then(CommandRoot.gated("body")
                    .executes(ctx -> {
                        var bodies = com.mattmc.mcptoolkit.drone.DroneTools.liveBodies();
                        ctx.getSource().sendSuccess(() -> Component.literal(bodies.isEmpty()
                            ? "no session bodies live"
                            : bodies.entrySet().stream()
                                .map(e -> e.getKey() + " @ " + fmt(e.getValue().position())
                                    + " (" + e.getValue().level().dimension().identifier() + ")")
                                .reduce((a, b) -> a + "\n" + b).orElse("")), false);
                        return bodies.size();
                    })
                    .then(Commands.literal("tp")
                        .executes(ctx -> tpToBody(ctx.getSource(), null))
                        .then(Commands.argument("session", StringArgumentType.word())
                            .executes(ctx -> tpToBody(ctx.getSource(),
                                StringArgumentType.getString(ctx, "session"))))))
                .then(CommandRoot.gated("fakeplayer")
                    .then(Commands.literal("spawn")
                        .then(Commands.argument("name", StringArgumentType.word())
                            .then(Commands.argument("at", Vec3Argument.vec3())
                                .executes(ctx -> {
                                    String name = StringArgumentType.getString(ctx, "name");
                                    Vec3 at = Vec3Argument.getVec3(ctx, "at");
                                    ServerLevel level = ctx.getSource().getLevel();
                                    FakePlayerEntity body = FakePlayers.spawn(
                                        ctx.getSource().getServer(), level, name, at, 0.0F);
                                    ctx.getSource().sendSuccess(() -> Component.literal(
                                        "fake player '" + name + "' at " + fmt(body.position())), false);
                                    return 1;
                                }))))
                    .then(Commands.literal("goto")
                        .then(Commands.argument("name", StringArgumentType.word())
                            .then(Commands.argument("to", BlockPosArgument.blockPos())
                                .executes(ctx -> {
                                    String name = StringArgumentType.getString(ctx, "name");
                                    FakePlayerEntity body = require(name);
                                    BlockPos to = BlockPosArgument.getLoadedBlockPos(ctx, "to");
                                    boolean started = FakePlayers.goTo(body, to, 1.0);
                                    ctx.getSource().sendSuccess(() -> Component.literal(started
                                        ? "'" + name + "' pathing to " + to.toShortString()
                                        : "'" + name + "' has NO PATH to " + to.toShortString()), false);
                                    return started ? 1 : 0;
                                }))))
                    .then(Commands.literal("stop")
                        .then(Commands.argument("name", StringArgumentType.word())
                            .executes(ctx -> {
                                String name = StringArgumentType.getString(ctx, "name");
                                require(name).navigation().stop();
                                ctx.getSource().sendSuccess(() -> Component.literal(
                                    "'" + name + "' stopped"), false);
                                return 1;
                            })))
                    .then(Commands.literal("status")
                        .then(Commands.argument("name", StringArgumentType.word())
                            .executes(ctx -> {
                                String name = StringArgumentType.getString(ctx, "name");
                                FakePlayerEntity body = require(name);
                                String line = "'" + name + "' at " + fmt(body.position())
                                    + " onGround=" + body.onGround()
                                    + " sprinting=" + body.isSprinting()
                                    + " navDone=" + body.navigation().isDone()
                                    + " health=" + body.getHealth();
                                ctx.getSource().sendSuccess(() -> Component.literal(line), false);
                                return 1;
                            })))
                    .then(Commands.literal("list")
                        .executes(ctx -> {
                            var live = FakePlayers.live();
                            ctx.getSource().sendSuccess(() -> Component.literal(live.isEmpty()
                                ? "no fake players" : "fake players: " + String.join(", ", live.keySet())),
                                false);
                            return live.size();
                        }))
                    .then(Commands.literal("despawn")
                        .then(Commands.argument("name", StringArgumentType.word())
                            .executes(ctx -> {
                                String name = StringArgumentType.getString(ctx, "name");
                                boolean gone = FakePlayers.despawn(
                                    ctx.getSource().getServer(), name, "commanded");
                                ctx.getSource().sendSuccess(() -> Component.literal(gone
                                    ? "fake player '" + name + "' despawned"
                                    : "no fake player named '" + name + "'"), false);
                                return gone ? 1 : 0;
                            }))))));
    }

    /** Teleport the calling player to a live session body — the named session's, or the only/first
     *  one when no name is given. Same-dimension only, stated honestly otherwise. */
    private static int tpToBody(final net.minecraft.commands.CommandSourceStack source,
                                final @org.jspecify.annotations.Nullable String session) {
        var bodies = com.mattmc.mcptoolkit.drone.DroneTools.liveBodies();
        BotBodyEntity body = session != null ? bodies.get(session)
            : bodies.values().stream().findFirst().orElse(null);
        if (body == null) {
            throw new IllegalStateException(session != null
                ? "no live body for session '" + session + "' (try /mmcp body)"
                : "no session bodies live");
        }
        var player = source.getPlayer();
        if (player == null) {
            throw new IllegalStateException("only a player can teleport to a body");
        }
        if (player.level() != body.level()) {
            throw new IllegalStateException("the body is in " + body.level().dimension().identifier()
                + " — switch dimension first");
        }
        player.teleportTo(body.getX(), body.getY(), body.getZ());
        source.sendSuccess(() -> Component.literal("teleported to "
            + (session != null ? session : "the session body") + " @ " + fmt(body.position())), false);
        return 1;
    }

    private static FakePlayerEntity require(final String name) {
        FakePlayerEntity body = FakePlayers.get(name);
        if (body == null) {
            throw new IllegalStateException("no fake player named '" + name + "'");
        }
        return body;
    }

    private static String fmt(final Vec3 v) {
        return String.format("%.2f %.2f %.2f", v.x, v.y, v.z);
    }
}
