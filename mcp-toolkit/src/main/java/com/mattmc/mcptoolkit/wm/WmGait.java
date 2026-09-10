package com.mattmc.mcptoolkit.wm;

import com.mattmc.mcptoolkit.Sightlines;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.util.Mth;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

import java.util.ArrayList;
import java.util.List;

/**
 * The gait fan (the world-model project's DESIGN.md §13.2): a small, cheap, forward-down fan cast every other
 * tick while the body is MOVING, centered on the <b>movement heading</b> — what a player actually
 * does: watch your feet. It is the legal sensory replacement for the driver's ground-truth
 * {@code footingAt}; without it the student's between-fan perception has no training distribution
 * and it learns edge care by falling.
 *
 * <p>Alongside it the <b>gaze fan</b> — same geometry along the LOOK direction when it diverges
 * materially from the heading — for every actor (§13.2's capture symmetry: a combat seed trained
 * with a gaze channel the deployed bot never casts would blind the student exactly when the seed
 * matters). Look control + gaze fan = active sensing; where-to-look becomes learnable.
 *
 * <p>Geometry starts at the §12.6 hand-authored guess (5×3, 60°×45°, range 8, forward-down) and is
 * tuned against the overhead numbers the recorder reports — measured, not assumed.
 *
 * <p>Human capture (§15.3) casts DENSER profiles through the same path — recording is cheap and
 * human sessions are rare enough to afford it; the denser fan is the first of the three mandated
 * information-gap mitigations. All grids stay ODD×ODD: an even step count has no centre ray
 * (the 385-probe lesson), and the demo data must sight what the human is looking straight at.
 */
final class WmGait {
    private WmGait() {}

    /** One fan density: geometry + cadence. {@code every} staggers per body by handle. */
    record Profile(int stepsH, int stepsV, double hFov, double vFov, double range, int every) {
        int maxCells() {
            return (int) Math.ceil(range * 3.0) + 4;
        }
    }

    /** The bot profile — unchanged from the §12.6 hand-authored start. */
    private static final Profile BOT = new Profile(5, 3, 60.0, 45.0, 8.0, 2);
    /** Human gait: every tick, wider and longer (§15.3 denser-fans mandate). Start values are
     *  HUMAN_RIG_PLAN.md open decision #5 — tune against the manifest's fan-cost numbers. */
    private static final Profile HUMAN_GAIT = new Profile(7, 5, 70.0, 50.0, 12.0, 1);
    /** Human look fan: cast along the gaze on cadence UNCONDITIONALLY (look direction IS part of
     *  the demonstrated policy, §13.2) — the human counterpart of the retina cadence. */
    private static final Profile HUMAN_LOOK = new Profile(11, 7, 100.0, 60.0, 32.0, 5);

    /** Down-tilt of the fan center: with v_fov 45 the rays sweep ~12°–57° below level — the
     *  footing band a walking player's eyes actually cover. */
    private static final double DOWN_PITCH = 35.0;
    /** Horizontal speed² below which the body counts as stationary (a stale belief is then correct). */
    private static final double MOVING_SQ = 1.0e-4;
    /** Look-vs-heading divergence that earns a gaze fan, degrees. */
    private static final double GAZE_YAW_DIVERGENCE = 25.0;
    private static final double GAZE_PITCH_DIVERGENCE = 20.0;

    /** One body-tick: cast the due fans. Server thread, from the per-tick watch. */
    static void tick(final WmRecorder r, final @Nullable String session, final LivingEntity body) {
        Vec3 vel = body.getDeltaMovement();
        if (vel.x * vel.x + vel.z * vel.z < MOVING_SQ) {
            return;
        }
        if ((r.tick() + r.handle(body.getUUID())) % BOT.every() != 0) {
            return;
        }
        ServerLevel level = (ServerLevel) body.level();
        Vec3 eye = body.getEyePosition();
        // Residency guard: the fan reads only resident chunks (Sightlines.walk never pages). A
        // ticking body's 8-block surround is loaded except at the very edge of the loaded area —
        // skip the fan there rather than clamp per-ray; a missing fan is honest sparseness.
        if (!surroundLoaded(level, eye, BOT.range())) {
            return;
        }

        long t0 = System.nanoTime();
        double moveYaw = Math.toDegrees(Math.atan2(-vel.x, vel.z));
        castFan(r, session, level, body, eye, BOT, "gait", moveYaw, DOWN_PITCH);
        Wm.noteGait(System.nanoTime() - t0, false);

        double lookYaw = body.getYRot();
        double lookPitch = body.getXRot();
        if (Math.abs(Mth.wrapDegrees(lookYaw - moveYaw)) > GAZE_YAW_DIVERGENCE
            || Math.abs(lookPitch - DOWN_PITCH) > GAZE_PITCH_DIVERGENCE && lookPitch < 0.0) {
            long t1 = System.nanoTime();
            castFan(r, session, level, body, eye, BOT, "gaze", lookYaw, lookPitch);
            Wm.noteGait(System.nanoTime() - t1, true);
        }
    }

    /** One HUMAN body-tick (§15.3): gait fan every tick while moving, look fan on cadence whether
     *  moving or not. The divergence-triggered gaze is subsumed — the cadence look fan is denser
     *  and unconditional. Server thread, from {@link WmHuman}. */
    static void tickHuman(final WmRecorder r, final @Nullable String session, final LivingEntity body) {
        ServerLevel level = (ServerLevel) body.level();
        Vec3 eye = body.getEyePosition();

        Vec3 vel = body.getDeltaMovement();
        if (vel.x * vel.x + vel.z * vel.z >= MOVING_SQ
            && surroundLoaded(level, eye, HUMAN_GAIT.range())) {
            long t0 = System.nanoTime();
            double moveYaw = Math.toDegrees(Math.atan2(-vel.x, vel.z));
            castFan(r, session, level, body, eye, HUMAN_GAIT, "gait", moveYaw, DOWN_PITCH);
            Wm.noteGait(System.nanoTime() - t0, false);
        }

        if ((r.tick() + r.handle(body.getUUID())) % HUMAN_LOOK.every() == 0
            && surroundLoaded(level, eye, HUMAN_LOOK.range())) {
            long t1 = System.nanoTime();
            castFan(r, session, level, body, eye, HUMAN_LOOK, "gaze",
                body.getYRot(), body.getXRot());
            Wm.noteGait(System.nanoTime() - t1, true);
        }
    }

    private static boolean surroundLoaded(final ServerLevel level, final Vec3 eye, final double range) {
        int y = (int) Math.floor(eye.y);
        return level.isLoaded(BlockPos.containing(eye.x - range, y, eye.z - range))
            && level.isLoaded(BlockPos.containing(eye.x - range, y, eye.z + range))
            && level.isLoaded(BlockPos.containing(eye.x + range, y, eye.z - range))
            && level.isLoaded(BlockPos.containing(eye.x + range, y, eye.z + range));
    }

    private static void castFan(final WmRecorder r, final @Nullable String session,
                                final ServerLevel level, final LivingEntity body, final Vec3 eye,
                                final Profile p, final String kind,
                                final double centerYaw, final double centerPitch) {
        // One entity query for the whole fan (the hoist the big fan learned the hard way).
        List<Entity> candidates = level.getEntities(body,
            new AABB(eye, eye).inflate(p.range()), e -> e.isPickable() && e.isAlive());

        java.util.function.LongConsumer seenFeed = WmSeen.feed(session);
        List<WmFanRay> rays = new ArrayList<>(p.stepsH() * p.stepsV());
        for (int j = 0; j < p.stepsV(); j++) {
            double dPitch = -p.vFov() / 2 + j * (p.vFov() / (p.stepsV() - 1));
            for (int i = 0; i < p.stepsH(); i++) {
                double dYaw = -p.hFov() / 2 + i * (p.hFov() / (p.stepsH() - 1));
                double pitch = Math.max(-90, Math.min(90, centerPitch + dPitch));
                Vec3 dir = com.mattmc.mcptoolkit.WorldPerceptionTools.exactDirection(
                    pitch, centerYaw + dYaw); // double trig: the loader re-walks this exact ray
                Vec3 to = eye.add(dir.scale(p.range()));
                Sightlines.Walk walk = Sightlines.walk(level, eye, to, p.maxCells(), false, seenFeed);
                double reach = walk.terminal() != null ? walk.terminal().distance() : walk.distance();
                Entity hit = null;
                double hitDist = Double.MAX_VALUE;
                for (Entity e : candidates) {
                    var clip = e.getBoundingBox().inflate(0.3).clip(eye, to);
                    if (clip.isPresent()) {
                        double d = eye.distanceTo(clip.get());
                        if (d < hitDist && d <= reach) {
                            hit = e;
                            hitDist = d;
                        }
                    }
                }
                rays.add(new WmFanRay(dYaw, dPitch, walk, p.range(), false, hit,
                    hit == null ? 0.0 : Math.round(hitDist * 10.0) / 10.0));
            }
        }
        Wm.recordFan(level, session, kind, eye, centerYaw, centerPitch, p.hFov(), p.vFov(),
            p.stepsH(), p.stepsV(), p.range(), body, rays, null);
    }
}
