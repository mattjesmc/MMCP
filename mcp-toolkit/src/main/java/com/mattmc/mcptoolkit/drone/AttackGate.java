package com.mattmc.mcptoolkit.drone;

import java.util.HashMap;
import java.util.Map;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.util.Mth;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.ai.attributes.Attributes;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;

/**
 * The melee swing's legality gate (V3_PLAN.md §2 F1): a swing is a player act, and a player cannot
 * hit what they cannot SEE or are not FACING. Shared by every swing path — {@code bot_attack},
 * the attack goal's rhythm swing, {@code bot_run} attack steps, and the reflex attack — so the
 * capability cheat the v2 audit reproduced (hits landing on a zombie directly behind the body and
 * through a 1-thick stone wall) is closed at ONE seam, not per caller.
 *
 * <p>Three gates, in order:
 * <ol>
 *   <li><b>reach</b> — the PLAYER body's entity reach is the vanilla
 *       {@code entity_interaction_range} attribute (3.0 default in 26.2, {@code Player.java:134}),
 *       not the invented {@code ENTITY_REACH = 4.0}; attacks beyond human reach are
 *       imitation-illegal data. Toolkit bodies (drone/walker — fictional, disclosed) keep 4.0.</li>
 *   <li><b>line of sight</b> — a COLLIDER clip from the eye to the target's closest-AABB point
 *       (eye-to-eye as the fallback ray). Blocked ⇒ {@code occluded}; no swing fires.</li>
 *   <li><b>facing</b> — the body must be within {@link #FACING_EPSILON} of the target bearing.
 *       When it is not, {@link #gate} TURNS the body toward the target at the nav driver's own
 *       rot-lerp rate ({@link com.mattmc.mcptoolkit.nav.NavDriver#TURN_RATE} — the same 90°/tick
 *       every steered gaze uses, so recorded attack turns share the gait's gaze dynamics), and the
 *       swing waits. The recorded turn-then-press is exactly the gaze-leads-action pattern the
 *       world-model policy should learn.</li>
 * </ol>
 *
 * <p><b>Gaze ownership</b> (audit finding S2). The turn writes rotation directly, but the movement
 * drivers rewrite yaw/pitch on EVERY driven frame from the path heading
 * ({@code FakePlayerEntity.driveMove}, {@code WalkerEntity.driveInput}). Nav runs in the entity
 * tick, this gate runs at END_SERVER_TICK — so the gate turned toward the bearing, the next entity
 * tick put the body back on the path heading, and the gate re-evaluated from scratch: a turn that
 * can never converge under an ACTIVE PATH (precisely the live kite), ending in
 * {@code facing_timeout} 60 ticks later. It looked fine in the battery only because attack probes
 * stage {@code NoAI:1b} targets whose approach leg has already finished, and
 * {@code NavDriver.idle} holds the current yaw. The fix is ONE owner, published by
 * {@link #holdsGaze}: while a turn is in flight the drivers withhold yaw/pitch and steer with the
 * legs instead. The gate owns the gaze; the path keeps the legs.
 */
public final class AttackGate {

    /** Swing tolerance, degrees, on both yaw and pitch — "facing" the way a watcher would judge it
     *  (~a fifth of a zombie's angular width at arm's length), NOT a pixel-perfect crosshair. */
    static final float FACING_EPSILON = 10.0f;

    /** Degrees per tick the attack turn covers — the nav driver's rot-lerp limit, reused verbatim
     *  so combat turns and steering turns are one visible motion vocabulary. */
    static final float TURN_RATE = com.mattmc.mcptoolkit.nav.NavDriver.TURN_RATE;

    /** The gate's verdict for this tick. */
    enum Verdict { READY, TURNING, OCCLUDED, OUT_OF_REACH }

    /**
     * Bodies whose gaze an in-flight attack turn owns → the game tick through which that ownership
     * stands. Entity id, not the entity: a hold must be releasable by a caller whose body is
     * already gone, and nothing here may keep a removed entity alive.
     *
     * <p>Server-thread-only by construction (every gate caller is a tickWatch pass or a
     * {@code SERVER}-context tool), same discipline as {@code Wm.actor}.
     */
    private static final Map<Integer, Long> GAZE_HOLD = new HashMap<>();

    /**
     * How far into the future a turn tick claims the gaze. ONE tick, deliberately: the gate runs at
     * END_SERVER_TICK and the driver frame it must out-rank runs in the NEXT entity tick, so a
     * one-tick window is exactly long enough to cover that frame and no longer. A turn that is
     * still turning re-stamps it every tick; the moment any caller stops calling — swing fired,
     * timed out, target lost, reflex ended, fight dropped, body removed — the hold LAPSES on its
     * own. A stuck gaze hold would leave a body unable to steer, which is worse than the bug this
     * closes, so the design makes leaking one impossible rather than relying on every exit path.
     */
    private static final long HOLD_TICKS = 1L;

    private AttackGate() {}

    /**
     * Does an in-flight attack turn own this body's gaze RIGHT NOW (V3_PLAN.md §2 F1)? True from
     * the first turning tick until one tick after the last {@code gate(.., turn=true)} call that
     * had a target to aim at — the turn AND the swing that ends it. The movement drivers ask
     * before writing yaw/pitch: while this is true they keep driving the legs but leave the look
     * alone, which is the only way the facing gate can converge while a path runs.
     */
    public static boolean holdsGaze(final LivingEntity body) {
        Long until = GAZE_HOLD.get(body.getId());
        if (until == null) {
            return false;
        }
        long now = body.level().getGameTime();
        // The second clause is the anti-wedge: a hold is never more than HOLD_TICKS in the future,
        // so a stamp left over from a world whose game time ran HIGHER (the eval-world swap, a
        // restored backup) cannot pin a body's gaze forever — it reads as expired, not as held.
        return now <= until && until - now <= HOLD_TICKS;
    }

    /** Claim the gaze for this tick and the next (see {@link #HOLD_TICKS}). */
    private static void holdGaze(final LivingEntity body) {
        long now = body.level().getGameTime();
        // Every write drops the windows that have passed, so bodies that died or were swept
        // mid-turn cannot accumulate here — no owner has to remember to clean up after them.
        GAZE_HOLD.entrySet().removeIf(e -> e.getValue() < now);
        GAZE_HOLD.put(body.getId(), now + HOLD_TICKS);
    }

    /**
     * Give the gaze back to the drivers. By ENTITY ID so the swing lifecycle can release on the
     * paths where the body is already removed ({@code DroneHands.failSwing}); {@link #gate} calls
     * it itself the tick a turn resolves, so the drivers steer again on the very next frame.
     */
    static void releaseGaze(final int bodyId) {
        GAZE_HOLD.remove(bodyId);
    }

    /**
     * The body's honest entity reach: the vanilla {@code entity_interaction_range} attribute for
     * the PLAYER body (3.0 default — a real client's swing gate), the disclosed fictional 4.0 for
     * toolkit bodies (drone/walker) and possessed mobs.
     */
    static double entityReach(final LivingEntity body) {
        if (body instanceof FakePlayerEntity) {
            return body.getAttributeValue(Attributes.ENTITY_INTERACTION_RANGE);
        }
        return Actuator.ENTITY_REACH;
    }

    /**
     * Run the gate one tick. {@code turn == true} also ADVANCES the body's facing toward the target
     * (rate-limited) and claims the gaze for this tick and the next ({@link #holdsGaze});
     * {@code false} only classifies (the sync-vs-async decision in bot_attack) and never touches
     * the hold — a classifier must not release the gaze another turn is steering with.
     * READY means: in reach, sightline clear, facing within epsilon — swing now.
     *
     * <p>READY keeps the gaze rather than dropping it. A fighter that let go the instant it was
     * within epsilon would have the driver steer the look back toward the path on the very next
     * frame, leave epsilon, and be turned back again the tick after — a gaze flapping between the
     * route and the enemy for the whole fight, which is both ugly to watch and exactly the
     * confused combat data F1 exists to stop recording. So any tick a caller is still gating this
     * body with {@code turn} holds the look on the target; the hold lapses by itself one tick
     * after the last such call (see {@link #HOLD_TICKS}). The two verdicts that mean "there is
     * nothing to aim at any more" — OCCLUDED and OUT_OF_REACH — release immediately, and the body
     * goes back to looking where it is going.
     */
    static Verdict gate(final LivingEntity body, final Entity target, final boolean turn) {
        if (body.distanceTo(target) > entityReach(body)) {
            if (turn) {
                releaseGaze(body.getId());
            }
            return Verdict.OUT_OF_REACH;
        }
        if (!hasLos(body, target)) {
            if (turn) {
                releaseGaze(body.getId());
            }
            return Verdict.OCCLUDED;
        }
        if (!turn) {
            return turnToward(body, target, false) ? Verdict.READY : Verdict.TURNING;
        }
        // Claim the gaze BEFORE writing rotation: from here until the turn resolves, the movement
        // drivers steer with the legs and leave the look alone (S2 — without this the next entity
        // tick's nav frame overwrites the rotation and the gate never converges). READY holds too,
        // so nobody looks away mid-swing (see the class note above).
        holdGaze(body);
        return turnToward(body, target, true) ? Verdict.READY : Verdict.TURNING;
    }

    /**
     * The shared rate-limited turn: measure the bearing to {@code target} and, when {@code rotate}
     * and the aim is not already within {@link #FACING_EPSILON}, advance the look one tick's worth
     * toward it. Returns whether the body was ALREADY facing (in which case nothing is written).
     *
     * <p>Both questions the class answers run through here — "may I swing?" ({@link #gate}) and
     * "keep the fight in view" ({@link #aim}) — so a swing turn and a combat aim can never drift
     * into two different notions of facing.
     */
    private static boolean turnToward(final LivingEntity body, final Entity target,
                                      final boolean rotate) {
        Vec3 eye = body.getEyePosition();
        Vec3 aim = target.getEyePosition();
        double dx = aim.x - eye.x;
        double dy = aim.y - eye.y;
        double dz = aim.z - eye.z;
        double horiz = Math.sqrt(dx * dx + dz * dz);
        float wantYaw = horiz < 1.0e-4 ? body.getYRot()
            : (float) (Math.toDegrees(Math.atan2(dz, dx)) - 90.0);
        float wantPitch = (float) -Math.toDegrees(Math.atan2(dy, Math.max(horiz, 1.0e-4)));
        float dYaw = Mth.wrapDegrees(wantYaw - body.getYRot());
        float dPitch = Mth.clamp(wantPitch, -90f, 90f) - body.getXRot();
        // Pitch is gated strictly only on the PLAYER body — the imitation-legal one, whose xRot
        // persists. Mob bodies (drone/walker/possessed) run vanilla LookControl, which RESETS xRot
        // toward 0 every entity tick, so a strict pitch gate there spins forever against vanilla
        // and times out (live-caught: reflex attack on a floor-level sheep from a hovering drone).
        // Their pitch is still written each turn tick — best-effort aim, disclosed fiction.
        boolean strictPitch = body instanceof FakePlayerEntity;
        if (Math.abs(dYaw) <= FACING_EPSILON
            && (!strictPitch || Math.abs(dPitch) <= FACING_EPSILON)) {
            return true; // already facing — nothing to write
        }
        if (rotate) {
            // The same wrapped-store discipline as NavDriver.rotlerp/LookDriver: bounded yaw only.
            body.setYRot(Mth.wrapDegrees(body.getYRot() + Mth.clamp(dYaw, -TURN_RATE, TURN_RATE)));
            body.setXRot(Mth.clamp(body.getXRot() + Mth.clamp(dPitch, -TURN_RATE, TURN_RATE), -90f, 90f));
            body.setYHeadRot(body.getYRot());
            // WHERE THE TURN IS RECORDED (audit S6). Not here: this gate is not an input sink, and
            // a second frame for a tick that already has one would put two contradicting walk rows
            // on the same (tick, body) — the loader makes a supervised sample out of each. The
            // recording seam is the one every author uses, the body's own drive sink, and it now
            // carries this turn because of the hold above: the next entity tick's frame requests
            // the body's CURRENT look (Wm.actionMove yaw/pitch), which is the aim this line just
            // wrote. Before the hold that frame requested the PATH heading while the body ended
            // the tick facing the target — the row was a lie about the gaze; now the sweep-then-
            // press really is in the actions stream, one row per tick, gaze leading the press
            // (V3_PLAN.md §7 decision 1). Every recorded body writes a locomotion frame every
            // tick (PlayerNavigation/WalkerNavigation idle when done), so no turn tick is silent.
            // Residual, deliberately not faked here: such a frame carries the LEG author's §13.3
            // label (nav/idle) because the vocabulary has no word for "legs by nav, gaze by
            // combat" — adding one touches the validator and the loader, which this change does
            // not own.
        }
        return false;
    }

    /** Rate-limited turn toward {@code target}, writing the rotation; true when already facing. */
    private static boolean turnToward(final LivingEntity body, final Entity target) {
        return turnToward(body, target, true);
    }

    /**
     * Aim at a target the body cannot necessarily hit yet — the FIGHT-MODE aim (V3_PLAN.md §2
     * F4/F5), as distinct from {@link #gate}, which answers "may I swing?".
     *
     * <p>Because that is its question, {@code gate} short-circuits the instant the answer is no:
     * out of reach and occluded release the gaze and never rotate. An engaged fighter needs the
     * opposite service. A bow duel stations at range 10 and is therefore ALWAYS outside swing
     * reach, so a fighter that only faced what it could already hit would spend the entire ranged
     * fight staring down its nav heading — while {@code Engage} claimed the head from the
     * LookDriver on a {@code enemyFacedThisTick} that was false. That is the unverified-courtesy-
     * aim defect of EVAL_AUDIT_V2.md §10 item 1 growing back inside its own fix, found in review.
     *
     * <p>It also settles the boundary flap: aiming only INSIDE reach makes a melee kite (stand
     * 2.25, reach 3.0) drop and re-take the gaze as the enemy drifts across 3.0 — precisely the
     * flapping the READY-holds-gaze rule above exists to prevent, merely relocated. Aim holds at
     * every distance; only the SWING is gated on reach.
     *
     * @return true when the aim is already within {@link #FACING_EPSILON} (the swing would be
     *     free to fire on reach and sightline alone)
     */
    static boolean aim(final LivingEntity body, final Entity target) {
        holdGaze(body);
        return turnToward(body, target);
    }

    /** Ticks a rate-limited turn from the current facing to the target needs (the eta the async
     *  bot_attack reply quotes). At least 1 — a TURNING verdict is never done this tick. */
    static int turnTicks(final LivingEntity body, final Entity target) {
        Vec3 eye = body.getEyePosition();
        Vec3 aim = target.getEyePosition();
        double dx = aim.x - eye.x;
        double dz = aim.z - eye.z;
        double horiz = Math.sqrt(dx * dx + dz * dz);
        float wantYaw = horiz < 1.0e-4 ? body.getYRot()
            : (float) (Math.toDegrees(Math.atan2(dz, dx)) - 90.0);
        float wantPitch = (float) -Math.toDegrees(Math.atan2(aim.y - eye.y, Math.max(horiz, 1.0e-4)));
        float arc = Math.abs(Mth.wrapDegrees(wantYaw - body.getYRot()));
        if (body instanceof FakePlayerEntity) { // pitch is gate-strict only there (see gate())
            arc = Math.max(arc, Math.abs(Mth.clamp(wantPitch, -90f, 90f) - body.getXRot()));
        }
        return Math.max(1, (int) Math.ceil(arc / TURN_RATE));
    }

    /**
     * Does the body's eye see the target? COLLIDER clip (glass occludes, torches/grass do not) to
     * the closest point of the target's box — nudged just inside so a grazing surface never reads
     * ambiguous — with an eye-to-eye ray as the fallback (a target whose feet hide behind a low
     * wall is still hittable in the face).
     */
    static boolean hasLos(final LivingEntity body, final Entity target) {
        ServerLevel level = (ServerLevel) body.level();
        Vec3 eye = body.getEyePosition();
        AABB box = target.getBoundingBox();
        Vec3 closest = new Vec3(
            Mth.clamp(eye.x, box.minX, box.maxX),
            Mth.clamp(eye.y, box.minY, box.maxY),
            Mth.clamp(eye.z, box.minZ, box.maxZ));
        Vec3 center = box.getCenter();
        if (closest.distanceToSqr(center) > 1.0e-6) {
            closest = closest.add(center.subtract(closest).normalize().scale(0.05));
        }
        return clipClear(level, body, eye, closest) || clipClear(level, body, eye, target.getEyePosition());
    }

    private static boolean clipClear(final ServerLevel level, final LivingEntity body,
                                     final Vec3 from, final Vec3 to) {
        if (from.distanceToSqr(to) < 1.0e-9) {
            return true; // the point is at the eye — nothing can stand between
        }
        return level.clip(new ClipContext(from, to,
            ClipContext.Block.COLLIDER, ClipContext.Fluid.NONE, body)).getType() == HitResult.Type.MISS;
    }
}
