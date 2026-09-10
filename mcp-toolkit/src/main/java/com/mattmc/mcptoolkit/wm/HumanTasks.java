package com.mattmc.mcptoolkit.wm;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.EventLog;
import com.mattmc.mcptoolkit.ExecutionContext;
import com.mattmc.mcptoolkit.McpTools;
import com.mattmc.mcptoolkit.Mechanism;
import com.mattmc.mcptoolkit.Schemas;
import com.mattmc.mcptoolkit.ToolDef;
import com.mattmc.mcptoolkit.hooks.ServerHooks;
import net.minecraft.commands.Commands;
import net.minecraft.commands.arguments.coordinates.BlockPosArgument;
import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import org.jspecify.annotations.Nullable;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * The §15 task presenter (HUMAN_RIG_PLAN.md phase 4): {@code human_task} presents a §14 intent to a
 * connected HUMAN player as a client-rendered goal highlight + task card, and opens the episode that
 * makes their play goal-conditioned BC data — the same {@code goal_start} bracket a bot goal gets,
 * with the same loader join. The intents can come from anywhere the bridge reaches: a curriculum
 * sampler, an operator, or a live LLM survival session playing strategist while the human plays body.
 *
 * <p><b>Delivery is a PULL, not a packet.</b> The plan's TaskPresentPayload ships here as the
 * pre-serialized {@link #snapshotJson()} behind {@code GET /humantask}, polled by the client's
 * {@code HumanTaskClient} tailer (the TranscriptTailer/OBS-activity pattern). Same content contract
 * as the payload design — goal-token fields only, never waypoints (§13.4 laundering) — but state-sync
 * instead of fire-once: a client that restarts mid-task re-fetches the live task, and the channel
 * works identically against the integrated server and the localhost dedicated server. Real S2C
 * networking arrives with the Phase-2 client-capture channel and can carry this then.
 *
 * <p><b>The referee</b> (phase 3): {@link HumanReferee} judges every active task once per tick from
 * the END_SERVER_TICK sweep — the goal predicate holding closes the episode as a real
 * {@code action_completed} (achieved, or the honest {@code already_*} degenerates at accept), an
 * optional {@code timeout_ticks} or the lifecycle ends (cancel, replacement, disconnect, server
 * stop) close it as {@code action_failed outcome:"stopped"}. All verdicts ride {@link EventLog} so
 * the wm event tap does the goal-detach bookkeeping exactly as for bot goals. Still no synthetic
 * successes: "achieved" means the predicate held against the live world, nothing else.
 *
 * <p>All task state is server-thread-only ({@link #ACTIVE}); the HTTP poll reads one volatile
 * pre-serialized string (the ActivitySnapshot doctrine — lock-free, no game-thread hop).
 */
public final class HumanTasks {
    private HumanTasks() {}

    /** v1 verb set: block-targeted verbs the highlight can render and the referee can judge.
     *  {@code attack} still waits on entity-handle resolution and a moving highlight — the
     *  referee's target-dead predicate is the easy third of that work. */
    private static final Set<String> VERBS = Set.of("move", "destroy", "place");

    private static final int MAX_TEXT = 200;

    private record Active(String actionId, String action, BlockPos at, String mayModify,
                          String text, List<String> tags, @Nullable String session,
                          long startTick, String playerName, String dim, int timeoutTicks) {}

    /** Server thread only (tool handlers are SERVER-context, commands and ticks run there). */
    private static final Map<UUID, Active> ACTIVE = new HashMap<>();
    private static int seq;

    /** The whole presenter state as one JSON string — safe from any thread, rebuilt on change. */
    private static volatile String snapshot = "{\"tasks\":{}}";

    /** The {@code GET /humantask} body: {@code {"tasks":{"<player lowercase>": {goal-token fields}}}}. */
    public static String snapshotJson() {
        return snapshot;
    }

    /** The active task's action id for this player, or null — WmHuman stamps it on every captured
     *  tick/action row so human trajectories carry goal attribution (§13.5's episode join). */
    public static @Nullable String goalIdFor(final ServerPlayer p) {
        Active a = ACTIVE.get(p.getUUID());
        return a == null ? null : a.actionId();
    }

    public static void register() {
        ServerHooks.END_SERVER_TICK.register(HumanTasks::sweep);
        // Close open episodes BEFORE the recorder does (registration order: this runs only if
        // register() is called before Wm.init() — see McpToolkit.onInitialize).
        ServerHooks.SERVER_STOPPING.register(s -> cancelAll("server_stopping"));

        ServerHooks.COMMAND_REGISTRATION.register((dispatcher, registryAccess, environment) ->
            dispatcher.register(Commands.literal("wmdemo")
                .then(Commands.literal("move").then(Commands.argument("pos", BlockPosArgument.blockPos())
                    .executes(c -> demo(c, "move"))))
                .then(Commands.literal("dig").then(Commands.argument("pos", BlockPosArgument.blockPos())
                    .executes(c -> demo(c, "destroy"))))
                .then(Commands.literal("place").then(Commands.argument("pos", BlockPosArgument.blockPos())
                    .executes(c -> demo(c, "place"))))
                .then(Commands.literal("cancel").executes(HumanTasks::demoCancel))
                .then(Commands.literal("status").executes(HumanTasks::demoStatus))));

        McpTools.register(ToolDef.of(
            "human_task",
            "Present a task to the connected HUMAN player (the §15 human-demo rig): the target block "
                + "gets a client-rendered highlight + task card, and a wm episode opens so every input "
                + "the human makes records as goal-conditioned demonstration data until the task ends. "
                + "Verbs: move (go to the block), destroy (break it), place (put a block there). "
                + "A referee judges the task every tick and closes it with a REAL verdict: "
                + "action_completed achieved when the goal predicate holds against the world (move: "
                + "the player stands on the cell; destroy: the cell is cleared; place: a block is "
                + "present), or already_there/already_clear instantly when the goal was satisfied at "
                + "accept. timeout_ticks, human_task_cancel, being superseded, or the player leaving "
                + "close it as action_failed outcome:stopped instead. Requires the wm recorder ON and "
                + "a genuinely connected non-spectator human — never a fake-player body. The human "
                + "can also self-serve tasks in-game with /wmdemo.",
            Schemas.objectOpt(Schemas.object(
                "action", Schemas.str("move | destroy | place"),
                "at", Schemas.vec3i("the goal's target block"),
                "player", Schemas.str("which human, by name — needed only when several are connected"),
                "may_modify", Schemas.str("terrain rights shown to the human and recorded in the "
                    + "goal token: none | break | place | both. Defaults: move=none, destroy=break, "
                    + "place=place."),
                "text", Schemas.str("task-card text (defaults to a plain rendering of the goal)",
                    MAX_TEXT),
                "tags", Schemas.array(Schemas.str("episode tag, e.g. assist:route — tagged episodes "
                    + "can be excluded from training by the loader")),
                "timeout_ticks", Schemas.integer("fail the task (reason timeout) after this many "
                    + "ticks if the goal predicate never held — 0 or absent = no deadline")),
                "player", "may_modify", "text", "tags", "timeout_ticks"),
            ExecutionContext.SERVER,
            Mechanism.PRIVILEGED,
            (ctx, a) -> {
                MinecraftServer server = ctx.serverOrThrow();
                String action = requireStr(a, "action").toLowerCase(Locale.ROOT);
                if (!VERBS.contains(action)) {
                    throw new IllegalArgumentException("unknown action '" + action
                        + "' — v1 human-task verbs: " + String.join(", ", VERBS)
                        + " (attack arrives with the referee)");
                }
                if (!a.has("at") || !a.get("at").isJsonObject()) {
                    throw new IllegalArgumentException("missing argument 'at' {x,y,z}");
                }
                JsonObject at = a.getAsJsonObject("at");
                BlockPos pos = new BlockPos(at.get("x").getAsInt(), at.get("y").getAsInt(),
                    at.get("z").getAsInt());
                String mm = a.has("may_modify") && !a.get("may_modify").isJsonNull()
                    ? a.get("may_modify").getAsString() : defaultRights(action);
                if (!Set.of("none", "break", "place", "both").contains(mm)) {
                    throw new IllegalArgumentException(
                        "may_modify must be none | break | place | both");
                }
                String text = a.has("text") && !a.get("text").isJsonNull()
                    ? a.get("text").getAsString() : null;
                if (text != null && text.length() > MAX_TEXT) {
                    throw new IllegalArgumentException("text is " + text.length()
                        + " chars; cap is " + MAX_TEXT);
                }
                List<String> tags = new ArrayList<>();
                if (a.has("tags") && a.get("tags").isJsonArray()) {
                    for (var el : a.getAsJsonArray("tags")) {
                        tags.add(el.getAsString());
                    }
                }
                int timeout = a.has("timeout_ticks") && !a.get("timeout_ticks").isJsonNull()
                    ? a.get("timeout_ticks").getAsInt() : 0;
                if (timeout < 0) {
                    throw new IllegalArgumentException("timeout_ticks must be >= 0 (0 = none)");
                }
                ServerPlayer p = resolvePlayer(server,
                    a.has("player") && !a.get("player").isJsonNull()
                        ? a.get("player").getAsString() : null);
                return accept(p, action, pos, mm, text, tags, ctx.sessionId(), timeout);
            }));

        McpTools.register(ToolDef.of(
            "human_task_cancel",
            "Cancel the human player's active task: the episode closes as action_failed "
                + "(outcome stopped, your reason), the highlight and task card disappear.",
            Schemas.objectOpt(Schemas.object(
                "player", Schemas.str("which human, by name — needed only when several have tasks"),
                "reason", Schemas.str("recorded on the episode's terminal verdict (default "
                    + "'cancelled')")),
                "player", "reason"),
            ExecutionContext.SERVER,
            Mechanism.PRIVILEGED,
            (ctx, a) -> {
                String name = a.has("player") && !a.get("player").isJsonNull()
                    ? a.get("player").getAsString() : null;
                String reason = a.has("reason") && !a.get("reason").isJsonNull()
                    ? a.get("reason").getAsString() : "cancelled";
                Map.Entry<UUID, Active> hit = null;
                for (Map.Entry<UUID, Active> e : ACTIVE.entrySet()) {
                    if (name == null || e.getValue().playerName().equalsIgnoreCase(name)) {
                        if (hit != null) {
                            throw new IllegalArgumentException("several humans have active tasks ("
                                + activeNames() + ") — say which with 'player'");
                        }
                        hit = e;
                    }
                }
                if (hit == null) {
                    throw new IllegalStateException(name == null ? "no active human task"
                        : "no active task for '" + name + "'"
                            + (ACTIVE.isEmpty() ? "" : " (active: " + activeNames() + ")"));
                }
                Active a2 = hit.getValue();
                ACTIVE.remove(hit.getKey());
                close(a2, reason);
                rebuild();
                JsonObject r = new JsonObject();
                r.addProperty("cancelled", a2.actionId());
                r.addProperty("player", a2.playerName());
                return r;
            }));

        HumanReferee.register(); // the wm_verdict dev probe tool (equivalence probe's headless half)
        WmObsGap.register(); // the wm_obsgap dev probe tool (obs-gap synthetic probe's headless half)
        // This method is the wm package's ONE tool-registration entry (McpToolkit.onInitialize
        // calls it, and Wm.init() registers hooks rather than tools), so the R-block's two dev
        // tools land here too — V3_PLAN.md §3 R-b and §4.3 tier 1.
        WmSessionTag.register(); // wm_session_tag: the corpus purpose stamp
        WmPerturb.register(); // wm_perturb: the recovery-leg hijack (+ its own tick sweep)
    }

    // ---- accept / close ---------------------------------------------------------

    private static JsonObject accept(final ServerPlayer p, final String action, final BlockPos pos,
                                     final String mayModify, final @Nullable String text,
                                     final List<String> tags, final @Nullable String session,
                                     final int timeoutTicks) {
        if (!Wm.recording()) {
            throw new IllegalStateException("the wm recorder is OFF — a human task's whole point is "
                + "the recorded episode; set wm.record=true (config/mcptoolkit.properties) and "
                + "restart the server");
        }
        if (!WmHuman.armed(p)) {
            throw new IllegalStateException("'" + p.getGameProfile().name() + "' is not being "
                + "captured (spectator, fake-player body, or wm.human.capture=false) — a task for an "
                + "uncaptured player would present a goal and record no demonstration");
        }
        Active old = ACTIVE.remove(p.getUUID());
        if (old != null) {
            close(old, "superseded");
        }
        String actionId = "h-" + (++seq);
        String taskText = text != null ? text : defaultText(action, pos);

        // The §14.3 intent row, written at accept rather than at bridge dispatch so a /wmdemo-minted
        // task normalizes identically to a tool-minted one — followed on the same tick by its
        // goal_start (the loader joins the two by adjacency + equal t).
        JsonObject intent = new JsonObject();
        intent.addProperty("verb", action);
        intent.addProperty("persistence", "move".equals(action) ? "until_done" : "once");
        JsonObject at = new JsonObject();
        at.addProperty("x", pos.getX());
        at.addProperty("y", pos.getY());
        at.addProperty("z", pos.getZ());
        intent.add("at", at);
        if (!"none".equals(mayModify)) {
            JsonObject rights = new JsonObject();
            rights.addProperty("may_modify", mayModify);
            intent.add("rights", rights);
        }
        JsonObject meta = new JsonObject();
        meta.addProperty("human", p.getGameProfile().name());
        intent.add("meta", meta);
        Wm.intent(session, "human_task", intent);

        JsonObject selector = new JsonObject();
        selector.add("at", at.deepCopy());
        // The same profile shape NavProfile.describe() gives bot goals, so the loader's goal-token
        // derivation (may_modify / swim / open_doors) reads human episodes unchanged.
        JsonObject profile = new JsonObject();
        profile.addProperty("may_modify", mayModify);
        profile.addProperty("open_doors", true);
        profile.addProperty("swim", true);
        JsonArray tagArr = null;
        if (!tags.isEmpty()) {
            tagArr = new JsonArray();
            for (String t : tags) {
                tagArr.add(t);
            }
        }
        Wm.goalStarted(session, p, actionId, action, selector, profile, tagArr);

        long t0 = p.level().getGameTime();
        Active task = new Active(actionId, action, pos, mayModify, taskText,
            List.copyOf(tags), session, t0, p.getGameProfile().name(),
            p.level().dimension().identifier().toString(), timeoutTicks);

        // GoalRunner's first-tick canActNow verdicts, mirrored: a goal the world already satisfies
        // closes instantly and honestly (already_there / already_clear / stopped:obstructed) — the
        // episode brackets exist (intent + goal_start above), it is just zero ticks long, and the
        // human never sees a card for work that does not exist.
        HumanReferee.Verdict instant = HumanReferee.atAccept(action, (ServerLevel) p.level(),
            p.position(), pos);
        if (instant != null) {
            emitVerdict(task, p, instant);
            JsonObject r = new JsonObject();
            r.addProperty("action_id", actionId);
            r.addProperty("action", action);
            r.add("at", at.deepCopy());
            r.addProperty("player", p.getGameProfile().name());
            r.addProperty("presented", false);
            r.addProperty("outcome", instant.outcome());
            if (instant.reason() != null) {
                r.addProperty("reason", instant.reason());
            }
            if (instant.note() != null) {
                r.addProperty("note", instant.note());
            }
            return r;
        }

        ACTIVE.put(p.getUUID(), task);
        rebuild();

        JsonObject r = new JsonObject();
        r.addProperty("action_id", actionId);
        r.addProperty("action", action);
        r.add("at", at.deepCopy());
        r.addProperty("player", p.getGameProfile().name());
        r.addProperty("presented", true);
        r.addProperty("may_modify", mayModify);
        r.addProperty("text", taskText);
        if (tagArr != null) {
            r.add("tags", tagArr.deepCopy());
        }
        if (timeoutTicks > 0) {
            r.addProperty("timeout_ticks", timeoutTicks);
        }
        r.addProperty("note", "presented — the human sees the highlight and task card now; the "
            + "referee closes the task as achieved the tick its goal predicate holds"
            + (timeoutTicks > 0 ? ", or as stopped (timeout) after " + timeoutTicks + " ticks" : "")
            + ". human_task_cancel or a new human_task ends it early as stopped");
        return r;
    }

    /** A lifecycle stop (cancel/supersede/disconnect/server-stop): GoalRunner's fail shape minus
     *  the bot-only fields, built by the referee's one payload builder. No envelope — the player
     *  may already be gone, and an undatable stamp would be a fabricated one. */
    private static void close(final Active a, final String reason) {
        EventLog.emit("action_failed", HumanReferee.payload(a.actionId(), a.action(),
            new HumanReferee.Verdict("stopped", reason, null), a.playerName()), a.session());
    }

    /** A REFEREE verdict — the player is at hand, so the payload is envelope-stamped exactly as
     *  GoalRunner's terminal block stamps bot verdicts (embodied verdicts are datable, §4). */
    private static void emitVerdict(final Active a, final ServerPlayer p,
                                    final HumanReferee.Verdict v) {
        JsonObject d = HumanReferee.payload(a.actionId(), a.action(), v, a.playerName());
        d.addProperty("game_tick", p.level().getGameTime());
        d.addProperty("dimension", p.level().dimension().identifier().toString());
        EventLog.emit(v.completed() ? "action_completed" : "action_failed", d, a.session());
    }

    // ---- lifecycle sweeps -------------------------------------------------------

    private static void sweep(final MinecraftServer server) {
        if (ACTIVE.isEmpty()) {
            return;
        }
        List<UUID> gone = new ArrayList<>();
        for (UUID id : ACTIVE.keySet()) {
            if (server.getPlayerList().getPlayer(id) == null) {
                gone.add(id);
            }
        }
        if (!gone.isEmpty()) {
            for (UUID id : gone) {
                close(ACTIVE.remove(id), "player_left");
            }
            rebuild();
        }
        // The referee: judge every surviving task against the live world, once per tick. Judged
        // only in the task's own dimension — a portal trip must not let nether coordinates satisfy
        // an overworld goal; the task simply does not progress until the player returns.
        List<UUID> judged = null;
        for (Map.Entry<UUID, Active> e : ACTIVE.entrySet()) {
            ServerPlayer p = server.getPlayerList().getPlayer(e.getKey());
            Active a = e.getValue();
            if (p == null || p.isRemoved()
                || !p.level().dimension().identifier().toString().equals(a.dim())) {
                continue;
            }
            HumanReferee.Verdict v = HumanReferee.onTick(a.action(), (ServerLevel) p.level(),
                p.position(), a.at(), p.level().getGameTime() - a.startTick(), a.timeoutTicks());
            if (v != null) {
                emitVerdict(a, p, v);
                if (judged == null) {
                    judged = new ArrayList<>();
                }
                judged.add(e.getKey());
            }
        }
        if (judged != null) {
            judged.forEach(ACTIVE::remove);
            rebuild();
        }
    }

    private static void cancelAll(final String reason) {
        if (ACTIVE.isEmpty()) {
            return;
        }
        for (Active a : ACTIVE.values()) {
            close(a, reason);
        }
        ACTIVE.clear();
        rebuild();
    }

    // ---- /wmdemo ----------------------------------------------------------------

    private static int demo(final com.mojang.brigadier.context.CommandContext<net.minecraft.commands.CommandSourceStack> c,
                            final String action) {
        ServerPlayer p = c.getSource().getPlayer();
        if (p == null) {
            c.getSource().sendFailure(Component.literal("/wmdemo tasks a PLAYER — run it in-game."));
            return 0;
        }
        BlockPos pos = BlockPosArgument.getBlockPos(c, "pos");
        JsonObject r;
        try {
            r = accept(p, action, pos, defaultRights(action), null, List.of(), null, 0);
        } catch (RuntimeException e) {
            c.getSource().sendFailure(Component.literal("wmdemo: " + e.getMessage()));
            return 0;
        }
        boolean presented = r.get("presented").getAsBoolean();
        c.getSource().sendSuccess(() -> Component.literal(presented
            ? "Task: " + defaultText(action, pos)
                + " (recording; the referee completes it when done, /wmdemo cancel aborts)"
            : "Already done: " + r.get("outcome").getAsString()
                + " — nothing to demonstrate."), false);
        return 1;
    }

    private static int demoCancel(final com.mojang.brigadier.context.CommandContext<net.minecraft.commands.CommandSourceStack> c) {
        ServerPlayer p = c.getSource().getPlayer();
        Active a = p == null ? null : ACTIVE.remove(p.getUUID());
        if (a == null) {
            c.getSource().sendFailure(Component.literal("No active task."));
            return 0;
        }
        close(a, "cancelled");
        rebuild();
        c.getSource().sendSuccess(() -> Component.literal("Task cancelled (" + a.actionId() + ")."), false);
        return 1;
    }

    private static int demoStatus(final com.mojang.brigadier.context.CommandContext<net.minecraft.commands.CommandSourceStack> c) {
        ServerPlayer p = c.getSource().getPlayer();
        Active a = p == null ? null : ACTIVE.get(p.getUUID());
        c.getSource().sendSuccess(() -> Component.literal(a == null ? "No active task."
            : "Active: " + a.text() + " [" + a.actionId() + ", since t=" + a.startTick() + "]"), false);
        return 1;
    }

    // ---- helpers ----------------------------------------------------------------

    private static ServerPlayer resolvePlayer(final MinecraftServer server, final @Nullable String name) {
        List<ServerPlayer> humans = new ArrayList<>();
        for (ServerPlayer p : server.getPlayerList().getPlayers()) {
            if (WmHuman.armed(p) && !p.isRemoved()) {
                if (name != null && p.getGameProfile().name().equalsIgnoreCase(name)) {
                    return p;
                }
                humans.add(p);
            }
        }
        if (name != null) {
            throw new IllegalArgumentException("no captured human player named '" + name + "'"
                + (humans.isEmpty() ? " (none connected)" : " (connected: "
                    + humans.stream().map(q -> q.getGameProfile().name()).toList() + ")"));
        }
        if (humans.isEmpty()) {
            throw new IllegalStateException("no human player connected (fake-player bodies and "
                + "spectators don't count) — human_task presents to a real person");
        }
        if (humans.size() > 1) {
            throw new IllegalArgumentException("several humans connected ("
                + humans.stream().map(q -> q.getGameProfile().name()).toList()
                + ") — say which with 'player'");
        }
        return humans.get(0);
    }

    private static String defaultRights(final String action) {
        return switch (action) {
            case "destroy" -> "break";
            case "place" -> "place";
            default -> "none";
        };
    }

    private static String defaultText(final String action, final BlockPos p) {
        String at = "(" + p.getX() + ", " + p.getY() + ", " + p.getZ() + ")";
        return switch (action) {
            case "destroy" -> "Break the block at " + at;
            case "place" -> "Place a block at " + at;
            default -> "Go to " + at;
        };
    }

    private static String activeNames() {
        return String.join(", ", ACTIVE.values().stream().map(Active::playerName).toList());
    }

    private static String requireStr(final JsonObject a, final String key) {
        if (!a.has(key) || a.get(key).isJsonNull()) {
            throw new IllegalArgumentException("missing argument '" + key + "'");
        }
        return a.get(key).getAsString();
    }

    private static void rebuild() {
        JsonObject root = new JsonObject();
        JsonObject tasks = new JsonObject();
        for (Active a : ACTIVE.values()) {
            JsonObject t = new JsonObject();
            t.addProperty("action_id", a.actionId());
            t.addProperty("action", a.action());
            JsonObject at = new JsonObject();
            at.addProperty("x", a.at().getX());
            at.addProperty("y", a.at().getY());
            at.addProperty("z", a.at().getZ());
            t.add("at", at);
            t.addProperty("may_modify", a.mayModify());
            t.addProperty("text", a.text());
            if (!a.tags().isEmpty()) {
                JsonArray tags = new JsonArray();
                for (String s : a.tags()) {
                    tags.add(s);
                }
                t.add("tags", tags);
            }
            t.addProperty("t0", a.startTick());
            t.addProperty("player", a.playerName());
            tasks.add(a.playerName().toLowerCase(Locale.ROOT), t);
        }
        root.add("tasks", tasks);
        snapshot = root.toString();
    }
}
