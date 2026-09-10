package com.mattmc.mcptoolkit.drone;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import net.minecraft.util.Mth;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

import java.util.concurrent.CompletableFuture;

/**
 * The body's smooth-turn servo: one in-flight {@link Turn} per slot, stepped a bounded number of
 * degrees per tick toward a target, so a watcher sees the head SWEEP instead of teleport. Instant
 * aims ({@code bot_look} without {@code sweep_ticks}, attack facing, reflex aims) bypass this
 * entirely — the servo exists for acts whose looking IS part of the visible performance: a scan
 * sweeping the horizon, a dig turning to its block, a ceremony facing its bench.
 *
 * <p><b>Rotation contract.</b> Only {@code yRot}/{@code xRot}/{@code yHeadRot} are written, and
 * {@code yHeadRot} always as a copy of {@code yRot}: on a player body {@code Player.aiStep}
 * overwrites {@code yHeadRot = yRot} every tick anyway, and {@code yBodyRot} is deliberately left
 * to vanilla's {@code tickHeadTurn} lerp so the torso trails the head naturally instead of
 * snapping with it.
 *
 * <p><b>Precedence.</b> Serviced FIRST in the base branch of {@code DroneTools.tickWatch}, so
 * reflex- and fight-ownership already exclude it. Two further vetoes freeze (not cancel) a turn:
 * {@code slot.enemyFacedThisTick} — combat aim ({@code Engage.tick}) beats camera work even in
 * defend mode — and a live nav leg, whose driver writes yaw from the path every tick
 * ({@code FakePlayerEntity.driveInput}); fighting either produces head jitter, so the servo
 * simply waits. A frozen turn still burns its timeout, and a timed-out waiter completes with the
 * ACTUAL yaw/pitch and {@code swept:false} — a preempted sweep is not a lie about facing.
 */
final class LookDriver {

    /** Degrees per tick a deliberate {@code bot_look} sweep covers when the caller gives ticks
     *  rather than a rate; also the default rate cap so a 1-tick "sweep" cannot snap. */
    static final float MAX_DEGREES_PER_TICK = 45.0f;
    /** Hard backstop: no turn outlives this many serviced ticks (vetoed ticks count). */
    static final int TIMEOUT_TICKS = 100;
    /** Arrival tolerance in degrees — under one packed-rotation-byte unit (~1.4°). */
    private static final float ARRIVED_DEG = 1.0f;

    private LookDriver() {}

    /** One smooth turn in flight. Either {@code at} (a tracked point, re-resolved every tick so a
     *  moving body keeps aiming true) or a fixed {@code targetYaw}/{@code targetPitch}. */
    static final class Turn {
        final @Nullable Vec3 at;
        final float targetYaw;
        final float targetPitch;
        final float degreesPerTick;
        /** Keep tracking {@code at} after arrival instead of finishing — the dig gaze-lock. A held
         *  turn has no waiter and is cleared by its owner (dig end, ceremony end). */
        final boolean hold;
        /** Who installed it ("look" | "dig" | "ceremony") — owners clear only their own turn. */
        final String owner;
        final @Nullable CompletableFuture<JsonElement> waiter;
        int ticksLeft = TIMEOUT_TICKS;

        private Turn(final @Nullable Vec3 at, final float targetYaw, final float targetPitch,
                     final float degreesPerTick, final boolean hold, final String owner,
                     final @Nullable CompletableFuture<JsonElement> waiter) {
            this.at = at;
            this.targetYaw = targetYaw;
            this.targetPitch = targetPitch;
            this.degreesPerTick = Math.min(Math.max(degreesPerTick, 0.5f), MAX_DEGREES_PER_TICK);
            this.hold = hold;
            this.owner = owner;
            this.waiter = waiter;
        }
    }

    /** Install a sweep toward absolute yaw/pitch (the {@code bot_look sweep_ticks} path). Replaces
     *  any turn in flight — the newest deliberate aim wins, and the loser's waiter completes with
     *  actuals rather than hanging. */
    static void sweepTo(final DroneTools.Slot slot, final LivingEntity body, final float yaw,
                        final float pitch, final int sweepTicks,
                        final @Nullable CompletableFuture<JsonElement> waiter) {
        float arc = Math.max(Math.abs(Mth.wrapDegrees(yaw - body.getYRot())),
            Math.abs(Mth.wrapDegrees(pitch - body.getXRot())));
        float rate = arc / Math.max(sweepTicks, 1);
        install(slot, body, new Turn(null, Mth.wrapDegrees(yaw), Mth.clamp(pitch, -90f, 90f),
            rate, false, "look", waiter));
    }

    /** Install a sweep toward a world point (the {@code bot_look at + sweep_ticks} path). */
    static void sweepAt(final DroneTools.Slot slot, final LivingEntity body, final Vec3 at,
                        final int sweepTicks, final @Nullable CompletableFuture<JsonElement> waiter) {
        float arc = arcTo(body, at);
        install(slot, body, new Turn(at, 0f, 0f, arc / Math.max(sweepTicks, 1), false, "look", waiter));
    }

    /** Install a held gaze on a point: turn there at {@code degreesPerTick}, then keep tracking it
     *  until {@link #clear} — the dig's block-lock and the ceremony's bench-face. */
    static void holdOn(final DroneTools.Slot slot, final LivingEntity body, final Vec3 at,
                       final float degreesPerTick, final String owner) {
        install(slot, body, new Turn(at, 0f, 0f, degreesPerTick, true, owner, null));
    }

    /** Drop the slot's turn if {@code owner} installed it (a dig clearing "look"'s sweep would
     *  strand that sweep's parked waiter — owners only ever clear their own). */
    static void clear(final DroneTools.Slot slot, final String owner) {
        Turn t = slot.look;
        if (t != null && t.owner.equals(owner)) {
            finish(slot, t, null, false);
        }
    }

    /** True when a turn is in flight (the /activity "look_sweep" hold). */
    static boolean active(final DroneTools.Slot slot) {
        return slot.look != null;
    }

    /** Complete-and-drop whatever turn is in flight, whoever owns it — slot teardown (session
     *  ended) removes the slot from the tick loop, so a parked waiter would otherwise hang to its
     *  HTTP timeout. */
    static void abortAll(final DroneTools.Slot slot) {
        Turn t = slot.look;
        if (t != null) {
            finish(slot, t, null, false);
        }
    }

    private static void install(final DroneTools.Slot slot, final LivingEntity body, final Turn turn) {
        Turn old = slot.look;
        if (old != null) {
            finish(slot, old, body, false);
        }
        slot.look = turn;
    }

    /**
     * Advance the slot's turn one tick. Called from the base branch of {@code tickWatch} (reflex/
     * fight ownership already excluded); applies the precedence vetoes documented on the class.
     */
    static void tick(final DroneTools.Slot slot, final @Nullable LivingEntity body) {
        Turn t = slot.look;
        if (t == null) {
            return;
        }
        if (body == null || body.isRemoved() || !body.isAlive()) {
            finish(slot, t, null, false);
            return;
        }
        boolean vetoed = slot.enemyFacedThisTick
            || slot.swing != null // an attack turn owns the head until its swing lands (F1)
            || slot.use != null   // a draw aims the weapon; vanilla fires along the look vector
            || (slot.pendingNav != null && !Bodies.nav(body).isDone());
        if (!t.hold && --t.ticksLeft <= 0) {
            finish(slot, t, body, false); // timed out (possibly vetoed throughout) — report actuals
            return;
        }
        if (vetoed) {
            return; // frozen, not cancelled: combat aim / the nav driver own the head right now
        }

        float wantYaw;
        float wantPitch;
        if (t.at != null) {
            Vec3 eye = body.getEyePosition();
            double dx = t.at.x - eye.x;
            double dy = t.at.y - eye.y;
            double dz = t.at.z - eye.z;
            double horiz = Math.sqrt(dx * dx + dz * dz);
            wantYaw = (float) (Math.toDegrees(Math.atan2(dz, dx)) - 90.0);
            wantPitch = (float) -Math.toDegrees(Math.atan2(dy, horiz));
        } else {
            wantYaw = t.targetYaw;
            wantPitch = t.targetPitch;
        }
        // The step is wrapped AND the stored result is wrapped: advancing from a current yaw near
        // ±180 used to leave a non-canonical angle (live: bot_status yaw 221° after a dig
        // gaze-lock — bounded, but outside the ±180 every consumer assumes; NavDriver.rotlerp
        // keeps the same contract).
        float dYaw = Mth.wrapDegrees(wantYaw - body.getYRot());
        float dPitch = wantPitch - body.getXRot();
        body.setYRot(Mth.wrapDegrees(
            body.getYRot() + Mth.clamp(dYaw, -t.degreesPerTick, t.degreesPerTick)));
        body.setXRot(Mth.clamp(body.getXRot() + Mth.clamp(dPitch, -t.degreesPerTick, t.degreesPerTick),
            -90f, 90f));
        body.setYHeadRot(body.getYRot());

        if (!t.hold && Math.abs(dYaw) <= ARRIVED_DEG && Math.abs(dPitch) <= ARRIVED_DEG) {
            finish(slot, t, body, true);
        }
    }

    /** Complete the turn's waiter (if any) with the body's ACTUAL facing and drop the turn. */
    private static void finish(final DroneTools.Slot slot, final Turn t,
                               final @Nullable LivingEntity body, final boolean swept) {
        if (slot.look == t) {
            slot.look = null;
        }
        if (t.waiter != null) {
            JsonObject r = new JsonObject();
            if (body != null) {
                r.addProperty("yaw", body.getYRot());
                r.addProperty("pitch", body.getXRot());
            }
            r.addProperty("swept", swept);
            if (!swept) {
                r.addProperty("note", body == null ? "body removed mid-sweep"
                    : "sweep preempted (combat aim, navigation, or timeout) — yaw/pitch are actuals");
            }
            t.waiter.complete(r);
        }
    }

    /** Total angular distance (deg) from the body's facing to the point — for rate derivation. */
    private static float arcTo(final LivingEntity body, final Vec3 at) {
        Vec3 eye = body.getEyePosition();
        double dx = at.x - eye.x;
        double dy = at.y - eye.y;
        double dz = at.z - eye.z;
        double horiz = Math.sqrt(dx * dx + dz * dz);
        float wantYaw = (float) (Math.toDegrees(Math.atan2(dz, dx)) - 90.0);
        float wantPitch = (float) -Math.toDegrees(Math.atan2(dy, horiz));
        return Math.max(Math.abs(Mth.wrapDegrees(wantYaw - body.getYRot())),
            Math.abs(wantPitch - body.getXRot()));
    }
}
