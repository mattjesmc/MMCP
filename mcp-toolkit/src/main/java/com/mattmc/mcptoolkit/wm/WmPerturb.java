package com.mattmc.mcptoolkit.wm;

import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.ExecutionContext;
import com.mattmc.mcptoolkit.McpToolkit;
import com.mattmc.mcptoolkit.McpTools;
import com.mattmc.mcptoolkit.Mechanism;
import com.mattmc.mcptoolkit.Schemas;
import com.mattmc.mcptoolkit.ToolDef;
import com.mattmc.mcptoolkit.drone.Bodies;
import com.mattmc.mcptoolkit.drone.DroneTools;
import com.mattmc.mcptoolkit.hooks.ServerHooks;
import com.mattmc.mcptoolkit.nav.NavBody;
import net.minecraft.server.MinecraftServer;
import net.minecraft.util.Mth;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import org.jspecify.annotations.Nullable;

import java.util.Random;
import java.util.UUID;

/**
 * The §4.3 tier-1 recovery generator (V3_PLAN.md): {@code wm_perturb} hijacks a navigating body's
 * inputs for a few ticks of random heading and the odd jump, and then hands it straight back to the
 * expert — <b>the resume IS the recovery demonstration</b>, produced and labeled by the expert
 * itself, with no model in the loop (DART, not DAgger).
 *
 * <p>Why it has to exist: pure behaviour cloning has ZERO recovery examples by construction. The
 * expert never leaves its own distribution, so the student is never shown the way back from a state
 * its own drift will certainly reach — the audit's structural finding (EVAL_AUDIT_V2.md §10, the
 * novel-jump recall collapse is the same shape). Perturbation manufactures exactly those states for
 * free: taskgen sprinkles one per ~30–60s of play, and every one of them is followed by an expert
 * demonstrating the correction.
 *
 * <p>The hijacked ticks carry actor {@code perturb} (§3 R-c): recorded in full, never supervised —
 * the same treatment reflex ticks get, drawn by label in the loader. The rows AFTER the hijack are
 * ordinary {@code nav} rows, and they are the point.
 *
 * <p><b>A hijack cannot strand a body.</b> Two independent expiries, either sufficient alone: the
 * tick budget spent inside {@link #step} (counted by the driver that actually used it) and an
 * absolute deadline swept every server tick. So a hijack whose goal ends, whose body dies, or whose
 * driver simply stops being ticked expires anyway, and nothing survives a server stop — the
 * {@link WmObsGap} rule: within-run state stays within the run.
 *
 * <p>Server-thread only in practice (the SERVER-context handler, the tick sweep and every nav
 * driver all run there); the field is {@code volatile} so a disarm is never read stale.
 */
public final class WmPerturb {
    private WmPerturb() {}

    /** The plan's band (§4.3 tier 1), sampled per call when the caller names no length. */
    private static final int DEFAULT_MIN = 5;
    private static final int DEFAULT_MAX = 15;
    /**
     * Hard cap on a requested burst — deliberately well under PlayerNavigation's 100-tick
     * {@code NODE_TIMEOUT_TICKS}. That stall timer keeps counting through hijacked ticks (a
     * perturbation makes no progress toward the waypoint, which is its whole purpose), so the
     * hijack PLUS the walk back has to fit inside it. Past that the "recovery" ends as a wedged
     * verdict instead of a demonstration — a silently poisoned episode, the failure mode this
     * whole plan is reacting to.
     */
    private static final int MAX_TICKS = 40;
    /**
     * Ticks past the budget before the absolute deadline fires. Slack, not a second budget: the
     * driver only spends budget on ticks it actually steers, and a body that spends a few ticks
     * mid-leap or waiting on its goal loop would otherwise lose them.
     */
    private static final int GRACE_TICKS = 40;
    /**
     * How long one random heading is held. A fresh heading every tick is jitter that averages to
     * standing still — the driver's rot-lerp never even reaches it — and the point is to leave the
     * body somewhere the expert would not have put it, which takes a few ticks of commitment.
     */
    private static final int HEADING_TICKS = 5;
    /** Chance of requesting a jump on a hijacked tick (held jumps are ignored while airborne). */
    private static final float JUMP_CHANCE = 0.15F;

    private static final Random RNG = new Random();

    /** The live hijack, or null when nothing is being perturbed. */
    private static volatile @Nullable Hijack active;
    /** The last hijack's honest report — how many ticks it actually drove and how it ended. Kept
     *  because the rows themselves are inside an open gzip stream: this is the only live proof. */
    private static volatile @Nullable JsonObject last;

    /** One tick of hijacked input, as the driver should actuate it. */
    public record Step(float yaw, float forward, boolean jump) {}

    private static final class Hijack {
        private final UUID body;
        private final String bodyKind;
        private final int requested;
        private final int armedTick;
        /** Absolute expiry (server tick count) — the expiry that does not need the driver. */
        private final int deadline;
        private int remaining;
        private int driven;
        private float yaw;
        private int headingTicks;

        Hijack(final UUID body, final String bodyKind, final int requested, final int now) {
            this.body = body;
            this.bodyKind = bodyKind;
            this.requested = requested;
            this.remaining = requested;
            this.armedTick = now;
            this.deadline = now + requested + GRACE_TICKS;
        }
    }

    // ---- the driver seam --------------------------------------------------------

    /**
     * One hijacked tick for {@code body}, or null when this body is not being perturbed right now
     * (the overwhelmingly common answer — one identity check and out). Called from
     * {@code NavDriver.steer} AFTER its leap branch: an arc must be flown straight, and steering
     * mid-air is how a body lands in the gap rather than on the far lip.
     *
     * <p>Consuming a tick of budget is the ACT of driving it, so a body that is not being steered
     * (goal finished, drivers idle) burns nothing and leaves the absolute deadline to do the work.
     */
    public static @Nullable Step step(final NavBody body) {
        Hijack h = active;
        if (h == null) {
            return null;
        }
        // Identity through the physique's own entity: the hijack names ONE body by uuid, because
        // probe files and battery lanes drive several bodies at once and a global hijack would
        // perturb somebody else's goal (the site-ownership lesson, in the time dimension).
        Entity e = body.collisionEntity();
        if (e == null || !h.body.equals(e.getUUID())) {
            return null;
        }
        MinecraftServer server = e.level().getServer();
        if (server == null) {
            return null; // no server clock = no honest budget; let the sweep end it
        }
        int now = server.getTickCount();
        if (now >= h.deadline || h.remaining <= 0) {
            finish(h, h.remaining <= 0 ? "budget" : "deadline", now);
            return null;
        }
        h.remaining--;
        h.driven++;
        if (h.headingTicks <= 0) {
            h.yaw = Mth.wrapDegrees(RNG.nextFloat() * 360.0F);
            h.headingTicks = HEADING_TICKS;
        }
        h.headingTicks--;
        // Full forward input: the displacement IS the product — a half-hearted nudge lands inside
        // the expert's own distribution and teaches nothing.
        return new Step(h.yaw, 1.0F, RNG.nextFloat() < JUMP_CHANCE);
    }

    // ---- lifecycle ---------------------------------------------------------------

    private static void finish(final Hijack h, final String ended, final int now) {
        JsonObject r = new JsonObject();
        r.addProperty("body", h.bodyKind);
        r.addProperty("actor", "perturb");
        r.addProperty("ticks_requested", h.requested);
        r.addProperty("ticks_driven", h.driven);
        r.addProperty("ended", ended);
        r.addProperty("armed_tick", h.armedTick);
        r.addProperty("ended_tick", now);
        last = r;
        active = null;
        McpToolkit.LOGGER.info("[MCP Toolkit] wm perturb ended ({}) — {}/{} ticks driven on the {} "
            + "body; the expert has the body back", ended, h.driven, h.requested, h.bodyKind);
    }

    /** The expiry that needs nobody: the deadline fires from the server tick itself, so a goal that
     *  ended, a body that died and a driver that simply stopped being ticked all end the hijack. */
    private static void sweep(final MinecraftServer server) {
        Hijack h = active;
        if (h != null && server.getTickCount() >= h.deadline) {
            finish(h, "deadline", server.getTickCount());
        }
    }

    // ---- the dev tool -------------------------------------------------------------

    static void register() {
        ServerHooks.END_SERVER_TICK.register(WmPerturb::sweep);
        ServerHooks.SERVER_STOPPING.register(s -> {
            Hijack h = active;
            if (h != null) {
                finish(h, "server_stopping", s.getTickCount());
            }
            last = null; // within-run state stays within the run (WmObsGap.clear's rule)
        });

        McpTools.register(ToolDef.of(
            "wm_perturb",
            "DEV: hijack YOUR navigating body for a few ticks of random heading + the odd jump "
                + "(actor 'perturb'), then hand it straight back to the expert — the RESUME is the "
                + "recovery demonstration this exists to record (V3_PLAN.md §4.3 tier 1: pure BC "
                + "has zero recovery examples by construction). Perturbed ticks are recorded and "
                + "never supervised; the nav ticks that follow are. Requires an ACTIVE navigation "
                + "(issue bot_goto without wait, then perturb it mid-leg) on a walker or player "
                + "body — a possessed mob steers with vanilla's MoveControl, which has no seam. "
                + "ticks defaults to a random " + DEFAULT_MIN + "-" + DEFAULT_MAX + " and clamps to "
                + MAX_TICKS + " (longer bursts risk tripping the follower's own stall timer, which "
                + "would end the leg as wedged instead of as a recovery). Edge care survives the "
                + "hijack: it perturbs, it does not push bodies off cliffs. Call with status:true "
                + "to read the live/last hijack without arming one.",
            Schemas.objectOpt(Schemas.object(
                "ticks", Schemas.integer("how many ticks to hijack (1-" + MAX_TICKS + "; default a "
                    + "random " + DEFAULT_MIN + "-" + DEFAULT_MAX + ")"),
                "session", Schemas.str("whose body — defaults to the calling bridge session"),
                "status", Schemas.bool("report the live/last hijack and change nothing")),
                "ticks", "session", "status"),
            ExecutionContext.SERVER,
            Mechanism.EMBODIED, // it drives a body's input frames, which is what EMBODIED means
            (ctx, a) -> {
                MinecraftServer server = ctx.serverOrThrow();
                if (a.has("status") && !a.get("status").isJsonNull()
                    && a.get("status").getAsBoolean()) {
                    return report(server, null, null);
                }
                String session = a.has("session") && !a.get("session").isJsonNull()
                    ? a.get("session").getAsString() : ctx.sessionId();
                LivingEntity body = DroneTools.activeBodyFor(session);
                if (body == null || body.isRemoved()) {
                    throw new IllegalStateException("no body in session '"
                        + (session == null ? "(anonymous)" : session) + "' — wm_perturb hijacks a "
                        + "body's steering; spawn one (bot_body) and start a move goal first");
                }
                if (!(body instanceof NavBody)) {
                    throw new IllegalStateException("a '" + Bodies.kind(body) + "' body does not "
                        + "steer through NavDriver, which is where the perturbation seam lives (the "
                        + "flyer has its own controller, a possessed mob keeps vanilla's) — perturb "
                        + "a walker or player body");
                }
                if (Bodies.nav(body).isDone()) {
                    throw new IllegalStateException("that body is not navigating — a perturbation "
                        + "with no expert to recover from it is just a random walk, not a recovery "
                        + "demonstration (V3_PLAN.md §4.3). Issue the goal first (bot_goto with no "
                        + "wait), then perturb it mid-leg");
                }
                int requested;
                boolean clamped = false;
                if (a.has("ticks") && !a.get("ticks").isJsonNull()) {
                    int want = a.get("ticks").getAsInt();
                    requested = Math.clamp(want, 1, MAX_TICKS);
                    clamped = requested != want;
                } else {
                    requested = DEFAULT_MIN + RNG.nextInt(DEFAULT_MAX - DEFAULT_MIN + 1);
                }
                Hijack prior = active;
                if (prior != null) {
                    // HumanTasks' supersede idiom: the old one closes honestly, it does not vanish.
                    finish(prior, "superseded", server.getTickCount());
                }
                Hijack h = new Hijack(body.getUUID(), Bodies.kind(body), requested,
                    server.getTickCount());
                active = h;
                return report(server, h, clamped
                    ? "ticks clamped into 1-" + MAX_TICKS + " (see the tool description)" : null);
            }));
    }

    private static JsonObject report(final MinecraftServer server, final @Nullable Hijack armed,
                                     final @Nullable String clampNote) {
        Hijack h = armed != null ? armed : active;
        JsonObject r = new JsonObject();
        r.addProperty("armed", h != null);
        // Disclosed rather than refused (unlike human_task, whose whole point is the episode): a
        // perturbation with the recorder off still exercises the seam honestly, it just produces
        // no data — and a probe should not have to read the server's config to know which it got.
        r.addProperty("recording", Wm.recording());
        if (h != null) {
            r.addProperty("body", h.bodyKind);
            r.addProperty("actor", "perturb");
            r.addProperty("ticks", h.requested);
            r.addProperty("ticks_remaining", h.remaining);
            r.addProperty("ticks_driven", h.driven);
            r.addProperty("expires_tick", h.deadline);
        }
        r.addProperty("now", server.getTickCount());
        r.add("last", last == null ? null : last.deepCopy());
        if (h != null) {
            StringBuilder note = new StringBuilder("the body's next ").append(h.remaining)
                .append(" steering ticks record as actor 'perturb' (never supervision); the expert "
                    + "resumes the moment the budget is spent, and THAT resume is the recovery "
                    + "demonstration. Tick ")
                .append(h.deadline).append(" ends it regardless");
            if (!Wm.recording()) {
                note.append(". The wm recorder is OFF — this hijack records nothing");
            }
            if (clampNote != null) {
                note.append(". ").append(clampNote);
            }
            r.addProperty("note", note.toString());
        }
        return r;
    }
}
