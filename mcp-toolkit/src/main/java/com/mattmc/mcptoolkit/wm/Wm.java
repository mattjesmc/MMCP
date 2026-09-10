package com.mattmc.mcptoolkit.wm;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.McpToolkit;
import com.mattmc.mcptoolkit.Sightlines;
import com.mattmc.mcptoolkit.hooks.ServerHooks;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

import java.io.IOException;
import java.util.List;
import java.util.Set;

/**
 * The world-model recorder's facade — the ONE name the rest of the toolkit touches
 * (the world-model project's DESIGN.md §3, §13; built to its §17 Phase 0 card). Everything here
 * no-ops at the
 * cost of a null check when recording is off, so the taps scattered through the toolkit
 * (fan walk, input-frame sinks, goal starts, the event log) cost nothing in a normal run.
 *
 * <p>Legality is structural: the only frame source is {@link Sightlines#walk} output (fan tap +
 * gait/gaze fans), the only proprioception source is the body's own state, and the only action
 * source is the input-frame sinks. No X-ray read has a path into the dataset (§7).
 */
public final class Wm {
    private Wm() {}

    private static volatile @Nullable WmRecorder recorder;

    /**
     * Who is driving the body RIGHT NOW (§13.3). The whole vocabulary:
     * {@code nav | swim | leap | idle | policy | perturb | reflex:<id> | human:<name>}.
     * Server-thread-only by construction (every driver runs on it); set by each driving context
     * immediately before it writes an input frame, read by the sinks. The label is free at record
     * time and unrecoverable afterward — which is why it exists at all.
     *
     * <p>Not every label is supervision. {@code reflex:*} ticks are an overlay the student must not
     * clone as goal-following, and {@code perturb} (V3_PLAN.md §3 R-c) is deliberate off-policy
     * noise — {@link WmPerturb} hijacks a navigating body so the expert's RESUME becomes a
     * recovery demonstration. Both are recorded in full and both stay out of the BC targets; the
     * loader draws that line by label ({@code wmloader.episodes.V0_ACTORS}), which is only possible
     * because the label was written at the one moment it was known.
     */
    private static String actor = "idle";

    /** Episode-worthy event types (§13.1's episodes stream): verdicts, reflex lifecycle, deaths. */
    private static final Set<String> EPISODE_EVENTS = Set.of(
        "action_completed", "action_failed", "reaction_fired", "reaction_done",
        "body_died", "body_removed", "drone_removed", "respawned", "hazard");

    public static void init() {
        WmConfig config = WmConfig.load();
        if (!config.record() && "off".equals(config.policy())) {
            return; // off by default; zero hooks, zero cost
        }
        // THE LABEL, IN THE SOFTWARE. Everything past this line is the world-model research
        // subsystem (see this package's package-info), not part of the toolkit's supported release
        // surface, and somebody has just turned it on in a properties file. Say so once, at the one
        // moment it becomes true, and say what it does rather than only what it is called: it writes
        // gameplay to disk, and if a human connects while it runs, their per-tick input is part of
        // what it writes. A capability this easy to forget about should announce itself.
        //
        // No section sign in a log message: MC's logger reads U+00A7 as its formatting prefix and
        // swallows the character after it.
        McpToolkit.LOGGER.warn("[MCP Toolkit] EXPERIMENTAL: the world-model recorder is ON"
            + " (wm.record={}, wm.policy={}, wm.human.capture={}). This is a research subsystem, not"
            + " part of the supported toolkit surface. It writes trajectory data under {} for as long"
            + " as this server runs, and that includes the per-tick input of any human player who"
            + " connects. Set wm.record=false in config/mcptoolkit.properties to turn it off.",
            config.record(), config.policy(), config.humanCapture(), config.dataDir());
        ServerHooks.SERVER_STARTED.register(server -> {
            String registrySha = null;
            if (config.record()) {
                try {
                    WmRegistryDump.Result reg = WmRegistryDump.ensure(server, config.dataDir());
                    recorder = new WmRecorder(server, config.dataDir(), reg.file(), reg.sha256());
                    registrySha = reg.sha256();
                } catch (IOException e) {
                    McpToolkit.LOGGER.error("[MCP Toolkit] wm recorder could not open — recording "
                        + "OFF this run: {}", e.toString());
                }
            }
            // After the recorder decision: the policy seam requires recording in v1 and says so
            // itself (WmPolicy.start) rather than silently half-running.
            WmPolicy.start(config, server, registrySha);
        });
        if (config.record() && config.humanCapture()) {
            WmHuman.init(); // §15 Phase 1: capture genuinely connected players, every tick
        }
        ServerHooks.SERVER_STOPPING.register(server -> {
            WmPolicy.stop();
            WmObsGap.clear(); // sighting windows are session-relative; never carry across runs
            WmRecorder r = recorder;
            recorder = null;
            if (r != null) {
                r.close();
            }
        });
    }

    public static boolean recording() {
        return recorder != null;
    }

    /**
     * The {@code wm} block of {@code ping}: the one fact about this subsystem a session or a probe
     * needs before it can read a knowledge verdict or a sighting window. The gait and gaze fans
     * ({@link WmGait}) and the sighting note ({@link WmObsGap}) run inside the recorder's tick, so
     * with recording off a body knows only the cells it has stood in and no fan ever marks an entity
     * sighted. Three battery files pinned those feeds as if the recorder were always on and went red
     * the day it was turned off in a dev config (RELEASE.md 2.2); a premise a probe cannot read is a
     * premise it will assume.
     */
    public static com.google.gson.JsonObject report() {
        com.google.gson.JsonObject o = new com.google.gson.JsonObject();
        boolean on = recording();
        o.addProperty("recording", on);
        o.addProperty("note", on
            ? "EXPERIMENTAL world-model recorder ON (wm.record=true): gameplay is written to disk; "
                + "gait/gaze fans feed session knowledge and sighting windows"
            : "world-model recorder off (wm.record=false, the default): bodies know only the cells "
                + "they stood in, and no fan marks an entity sighted");
        return o;
    }

    /** Package seam for {@link WmPolicy}'s server-thread row drain. */
    static @Nullable WmRecorder recorderOrNull() {
        return recorder;
    }

    // ---- per-tick --------------------------------------------------------------

    /**
     * Session/goal bookkeeping, from DroneTools.tickWatch (server thread). Attribution only — the
     * envelope rows are written by {@link #tickEntity}, because a body can exist OUTSIDE any
     * session slot (the /player command spawns one) and §13.1 says every tick a body exists, not
     * every tick a slot owns one. The validator caught exactly this on the first live session:
     * slot-driven rows left command-spawned bodies with actions but no ticks.
     */
    public static void tickBody(final @Nullable String session, final @Nullable LivingEntity body,
                                final @Nullable String goalId) {
        if (body == null || body.isRemoved()) {
            return;
        }
        // Proprioceptive knowledge feeds regardless of recording (CHECK_PATH_AUDIT.md R2): a body
        // knows the cells it occupies and the block it stands on.
        WmSeen.addBody(session, body);
        WmRecorder r = recorder;
        if (r == null) {
            return;
        }
        r.noteBody(body, session, goalId);
    }

    /** One body-tick, from the BODY's own tick: the envelope row ({@code ticks} stream) plus the
     *  gait/gaze fans (§13.2). Runs for every toolkit body — slot-owned or not. */
    public static void tickEntity(final LivingEntity body) {
        WmRecorder r = recorder;
        if (r == null || body.level().isClientSide() || body.isRemoved()) {
            return;
        }
        String session = r.sessionOf(body);
        r.writeTick(session, body, r.goalOf(body));
        WmGait.tick(r, session, body);
        WmPolicy.onObs(body); // the PROTOCOL.md obs mirror + the parked policy-row drain
    }

    // ---- actor labels + the input-frame sinks (§13.3) --------------------------

    public static void actor(final String label) {
        actor = label;
    }

    /** The dry input frame, recorded at the sink so EVERY author is caught — including zeroed
     *  idle frames, which are actions, not absences (the stale-yya lesson, §13.1). Narrow-frame
     *  sinks (the walker) land here; the widened channels serialize as their absence-defaults
     *  (pitch: {@code NaN} = the author holds the current look — absent in the row, and the
     *  loader reads the envelope's pitch, which is exactly what a hold produced). */
    public static void actionWalk(final LivingEntity body, final float yaw, final float speed,
                                  final boolean jump, final boolean sprint) {
        actionMove(body, yaw, Float.NaN, speed, 0.0F, jump, false, sprint);
    }

    /** The WIDENED dry frame (DESIGN.md §9 Phase 3): analog forward (the {@code speed} field,
     *  name kept for loader continuity) + strafe + sneak + (second slice) the requested look
     *  pitch. Strafe/sneak/pitch serialize only when non-default, which makes pre-widening rows
     *  and straight-walk rows byte-identical — the loader's defaults (0, false, envelope-hold)
     *  read both. */
    public static void actionMove(final LivingEntity body, final float yaw, final float pitch,
                                  final float forward, final float strafe, final boolean jump,
                                  final boolean sneak, final boolean sprint) {
        WmRecorder r = recorder;
        if (r == null) {
            return;
        }
        JsonObject f = new JsonObject();
        f.addProperty("k", "walk");
        f.addProperty("yaw", WmRecorder.round(yaw));
        if (!Float.isNaN(pitch)) {
            f.addProperty("pitch", WmRecorder.round(pitch));
        }
        f.addProperty("speed", WmRecorder.round(forward));
        if (strafe != 0.0F) {
            f.addProperty("strafe", WmRecorder.round(strafe));
        }
        if (sneak) {
            f.addProperty("sneak", true);
        }
        f.addProperty("jump", jump);
        f.addProperty("sprint", sprint);
        r.writeAction(body, actor, f);
        WmPolicy.onExpertTick(body); // shadow: what would the policy have done this tick?
    }

    /** The BUTTON half of the client frame (§9 Phase 3): use / attack / hotbar, recorded as their
     *  own {@code press} row at the act sites — a dig tick is attack-held, a consuming body is
     *  use-held, a slot selection is a hotbar input. Separate rows because buttons and travel
     *  have different authors on different ticks; the loader unions rows by (tick, body).
     *  {@code hotbar} −1 = no selection input this row. */
    public static void actionPress(final LivingEntity body, final boolean use, final boolean attack,
                                   final int hotbar) {
        WmRecorder r = recorder;
        if (r == null) {
            return;
        }
        JsonObject f = new JsonObject();
        f.addProperty("k", "press");
        if (use) {
            f.addProperty("use", true);
        }
        if (attack) {
            f.addProperty("atk", true);
        }
        if (hotbar >= 0) {
            f.addProperty("slot", hotbar);
        }
        r.writeAction(body, actor, f);
    }

    /** The wet input frame (§12.4's swim sibling). */
    public static void actionSwim(final LivingEntity body, final float yaw, final float pitch,
                                  final float forward, final float vertical, final boolean sprint) {
        WmRecorder r = recorder;
        if (r == null) {
            return;
        }
        JsonObject f = new JsonObject();
        f.addProperty("k", "swim");
        f.addProperty("yaw", WmRecorder.round(yaw));
        f.addProperty("pitch", WmRecorder.round(pitch));
        f.addProperty("fwd", WmRecorder.round(forward));
        f.addProperty("vert", WmRecorder.round(vertical));
        f.addProperty("sprint", sprint);
        r.writeAction(body, actor, f);
        WmPolicy.onExpertTick(body);
    }

    // ---- frames (the fan tap, §2.1) --------------------------------------------

    /**
     * Serialize one fan straight off the {@link Sightlines.Walk}s — kind, entry face, exact entity
     * positions, per-ray certified-clear distance, miss ≠ unread kept distinct (§2.3–2.5). Called
     * by the fan/raycast tools (kind {@code fan}/{@code ray}) and the gait caster
     * ({@code gait}/{@code gaze}).
     */
    public static void recordFan(final ServerLevel level, final @Nullable String session,
                                 final String kind, final Vec3 eye, final double centerYaw,
                                 final double centerPitch, final double hFov, final double vFov,
                                 final int stepsH, final int stepsV, final double range,
                                 final @Nullable Entity source, final List<WmFanRay> rays,
                                 final @Nullable List<WmFanRay.Item> items) {
        WmRecorder r = recorder;
        if (r == null) {
            return;
        }
        JsonObject o = new JsonObject();
        o.addProperty("v", WmRecorder.WMFRAME_VERSION);
        o.addProperty("t", r.tick());
        o.addProperty("kind", kind);
        if (session != null) {
            o.addProperty("session", session);
        }
        o.addProperty("dim", level.dimension().identifier().toString());
        // Fan geometry ships UNROUNDED (unlike the envelope): the loader re-derives traversed
        // cells from (origin, center, dy, dp, clear), and rounding here moved boundary-crossing
        // ties by whole cells on grazing rays (§2.4's exact-re-derivation contract, live-caught).
        JsonObject origin = new JsonObject();
        origin.addProperty("x", eye.x);
        origin.addProperty("y", eye.y);
        origin.addProperty("z", eye.z);
        o.add("origin", origin);
        JsonObject center = new JsonObject();
        center.addProperty("yaw", centerYaw);
        center.addProperty("pitch", centerPitch);
        o.add("center", center);
        JsonObject fov = new JsonObject();
        fov.addProperty("h", hFov);
        fov.addProperty("v", vFov);
        o.add("fov", fov);
        JsonObject steps = new JsonObject();
        steps.addProperty("h", stepsH);
        steps.addProperty("v", stepsV);
        o.add("steps", steps);
        o.addProperty("range", range);
        if (source instanceof LivingEntity living) {
            o.addProperty("body", r.handle(living.getUUID()));
            WmRecorder.envelope(o, living); // the frame envelope rides every frame (§2.2)
        }

        JsonArray rows = new JsonArray();
        for (WmFanRay ray : rays) {
            rows.add(serializeRay(r, ray, range));
            // §15.3 mitigation-2 feed: every entity ANY of the session's fans picks — gait, gaze,
            // tool fans — lands in the sighting window; per-session keying is the hermeticity
            // boundary (one session's sightings must not explain another's actions).
            Entity picked = ray.entity();
            if (picked != null && session != null) {
                WmObsGap.note(session, picked.getId(), r.tick());
            }
        }
        o.add("rays", rows);
        if (items != null && !items.isEmpty()) {
            JsonArray drops = new JsonArray();
            for (WmFanRay.Item item : items) {
                JsonObject d = new JsonObject();
                d.addProperty("dy", WmRecorder.round(item.dYaw()));
                d.addProperty("dp", WmRecorder.round(item.dPitch()));
                d.addProperty("dist", WmRecorder.round(item.distance()));
                d.addProperty("item", WmRecorder.itemId(item.drop().getItem()));
                d.addProperty("n", item.drop().getItem().getCount());
                Vec3 at = item.drop().position();
                d.addProperty("x", WmRecorder.round(at.x));
                d.addProperty("y", WmRecorder.round(at.y));
                d.addProperty("z", WmRecorder.round(at.z));
                drops.add(d);
            }
            o.add("items", drops);
        }
        r.writeFrame(o);
        WmPolicy.onFan(source, o); // shadow: the sidecar's belief steps at fan events (§13.2)
    }

    private static JsonObject serializeRay(final WmRecorder r, final WmFanRay ray, final double range) {
        Sightlines.Walk walk = ray.walk();
        JsonObject row = new JsonObject();
        row.addProperty("dy", ray.dYaw()); // unrounded — see the geometry note in recordFan
        row.addProperty("dp", ray.dPitch());
        // How the ray's view ended — the §2.4 vocabulary, all four ends distinct: a real wall (b),
        // range exhausted with everything clear (m), clamped at an unreadable chunk (u — beyond is
        // UNREAD, not empty), or the opacity budget spent mid-flight (o — leaves/glass stacked up).
        Sightlines.Sighting terminal = walk.terminal();
        if (terminal != null) {
            row.addProperty("end", "b");
            row.addProperty("clear", terminal.distance());
        } else {
            row.addProperty("end", ray.truncated() ? "u" : walk.distance() >= range - 0.15 ? "m" : "o");
            row.addProperty("clear", walk.distance());
        }
        if (!walk.seen().isEmpty()) {
            JsonArray seen = new JsonArray();
            for (Sightlines.Sighting s : walk.seen()) {
                JsonArray cell = new JsonArray();
                cell.add(s.pos().getX());
                cell.add(s.pos().getY());
                cell.add(s.pos().getZ());
                cell.add(BuiltInRegistries.BLOCK.getKey(s.state().getBlock()).toString());
                cell.add(kindChar(s.kind()));
                cell.add(s.distance());
                cell.add(s.face() == null ? null : faceChar(s.face()));
                if (s.throughFluid()) {
                    cell.add(1);
                }
                seen.add(cell);
            }
            row.add("seen", seen);
        }
        Entity e = ray.entity();
        if (e != null) {
            JsonObject ent = new JsonObject();
            ent.addProperty("type", BuiltInRegistries.ENTITY_TYPE.getKey(e.getType()).toString());
            ent.addProperty("h", r.handle(e.getUUID()));
            ent.addProperty("dist", WmRecorder.round(ray.entityDistance()));
            Vec3 at = e.position();
            ent.addProperty("x", WmRecorder.round(at.x));
            ent.addProperty("y", WmRecorder.round(at.y));
            ent.addProperty("z", WmRecorder.round(at.z));
            Vec3 vel = e.getDeltaMovement();
            ent.addProperty("vx", WmRecorder.round(vel.x));
            ent.addProperty("vy", WmRecorder.round(vel.y));
            ent.addProperty("vz", WmRecorder.round(vel.z));
            ent.addProperty("yaw", WmRecorder.round(e.getYRot()));
            ent.addProperty("g", e.onGround());
            row.add("ent", ent);
        }
        return row;
    }

    private static String kindChar(final Sightlines.Kind kind) {
        return switch (kind) {
            case CLUTTER -> "c";
            case FLUID -> "f";
            case PARTIAL -> "p";
            case LEAVES -> "l";
            case OPAQUE -> "o";
            case AIR -> "a"; // never recorded by the walk, present for switch totality
        };
    }

    private static String faceChar(final Direction face) {
        return switch (face) {
            case DOWN -> "d";
            case UP -> "u";
            case NORTH -> "n";
            case SOUTH -> "s";
            case WEST -> "w";
            case EAST -> "e";
        };
    }

    // ---- episodes --------------------------------------------------------------

    /** A goal was accepted and now owns the body — the episode's opening bracket (§13.5).
     *  {@code body} exists for the policy seam (goal messages key by body UUID); the episodes
     *  stream itself keys by session as always. */
    public static void goalStarted(final @Nullable String session, final @Nullable LivingEntity body,
                                   final String actionId, final String action,
                                   final @Nullable JsonObject selector,
                                   final @Nullable JsonObject profile) {
        goalStarted(session, body, actionId, action, selector, profile, null);
    }

    /** As above with episode {@code tags} (HUMAN_RIG_PLAN.md: {@code assist:route} and friends —
     *  loader-side training-eligibility marks, not goal-token content; the policy seam never sees
     *  them). */
    public static void goalStarted(final @Nullable String session, final @Nullable LivingEntity body,
                                   final String actionId, final String action,
                                   final @Nullable JsonObject selector,
                                   final @Nullable JsonObject profile,
                                   final @Nullable JsonArray tags) {
        WmPolicy.onGoalStart(body, actionId, action, selector, profile);
        WmRecorder r = recorder;
        if (r == null) {
            return;
        }
        JsonObject o = new JsonObject();
        o.addProperty("t", r.tick());
        o.addProperty("type", "goal_start");
        if (session != null) {
            o.addProperty("session", session);
        }
        o.addProperty("action_id", actionId);
        o.addProperty("action", action);
        if (selector != null) {
            o.add("selector", selector.deepCopy());
        }
        if (profile != null) {
            o.add("profile", profile);
        }
        if (tags != null && !tags.isEmpty()) {
            o.add("tags", tags.deepCopy());
        }
        r.writeEpisode(o);
    }

    /** A normalized intent record (§14.3 step 1) — written from the bridge dispatch, BEFORE the
     *  tool reaches GoalRunner. {@code intent} null = the §16.2 grammar could not cover a real
     *  act call, which is a grammar bug found free: loud, never silent. */
    public static void intent(final @Nullable String session, final String tool,
                              final @Nullable JsonObject intent) {
        WmRecorder r = recorder;
        if (r == null) {
            return;
        }
        JsonObject o = new JsonObject();
        o.addProperty("t", r.tick());
        if (session != null) {
            o.addProperty("session", session);
        }
        o.addProperty("tool", tool);
        if (intent != null) {
            o.addProperty("type", "intent");
            o.add("intent", intent);
        } else {
            o.addProperty("type", "intent_unnormalizable");
            McpToolkit.LOGGER.warn("[MCP Toolkit] wm intent grammar does not cover act tool '{}' — "
                + "grammar bug (DESIGN.md §14.3): extend WmIntents", tool);
        }
        r.writeEpisode(o);
    }

    /** The event-log tap: verdicts, reflex fire/done, deaths — the referee's records, verbatim
     *  (§13.1). Serialized synchronously so EventLog's own later compaction cannot race it. */
    public static void event(final String type, final JsonObject data, final @Nullable String target) {
        WmRecorder r = recorder;
        if (r == null || !EPISODE_EVENTS.contains(type)) {
            return;
        }
        // A verdict closes its goal's attribution immediately (see WmRecorder.goalEnded).
        if (("action_completed".equals(type) || "action_failed".equals(type))
            && data.has("action_id") && !data.get("action_id").isJsonNull()) {
            String actionId = data.get("action_id").getAsString();
            r.goalEnded(actionId);
            WmPolicy.onGoalEnd(actionId); // the sidecar's sequence boundary (PROTOCOL.md)
        }
        JsonObject o = new JsonObject();
        o.addProperty("t", r.tick());
        o.addProperty("type", "event:" + type);
        if (target != null) {
            o.addProperty("session", target);
        }
        o.add("data", data.deepCopy());
        r.writeEpisode(o);
    }

    // ---- gait overhead ---------------------------------------------------------

    static void noteGait(final long nanos, final boolean gaze) {
        WmRecorder r = recorder;
        if (r != null) {
            r.noteGait(nanos, gaze);
        }
    }
}
