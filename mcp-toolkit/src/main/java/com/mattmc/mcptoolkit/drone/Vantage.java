package com.mattmc.mcptoolkit.drone;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.pathfinder.PathComputationType;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;

/**
 * The vantage solver (SURVIVAL_MODE_PLAN.md §7): find stand cells with <b>line of sight</b> into a
 * target point, for {@code bot_target action:"vantage"}. Closes the legal profile's exploration
 * loop — locate miss → frontier direction → walk somewhere you can SEE it → the retina fills the
 * store → re-ask.
 *
 * <p>Candidates are sampled on rings around the target (nearest ring first — a vantage wants to be
 * close to the thing it looks at, and small rings are cheap), each needing standable footing
 * (solid below, feet+head pathfindable) and an eye-to-target sightline. The GOAL LOOP then tries
 * them nearest-the-body first; arrival is never the verdict — the LOS is re-verified live from the
 * body's real eye, because a candidate computed before travel can be occluded by the time the body
 * stands there.
 */
final class Vantage {
    private Vantage() {}

    /** Ring radii step (blocks) and per-ring sample count. */
    private static final int RING_STEP = 3;
    private static final int RING_SAMPLES = 16;
    /** How far above/below the target's Y a stand column is probed. */
    private static final int Y_PROBE = 6;
    /** How many candidates the goal loop will try before conceding. */
    static final int MAX_CANDIDATES = 12;

    /**
     * Stand cells with LOS into {@code target}, nearest-the-body first, at most
     * {@link #MAX_CANDIDATES}. Empty means no reachable-looking vantage exists within {@code range}.
     */
    static List<BlockPos> candidates(final ServerLevel level, final LivingEntity body,
                                     final Vec3 target, final int range) {
        List<BlockPos> found = new ArrayList<>();
        double eyeHeight = body.getEyeHeight();
        for (int r = RING_STEP; r <= range && found.size() < MAX_CANDIDATES * 3; r += RING_STEP) {
            for (int s = 0; s < RING_SAMPLES; s++) {
                double angle = (2 * Math.PI * s) / RING_SAMPLES;
                int x = (int) Math.floor(target.x + r * Math.cos(angle));
                int z = (int) Math.floor(target.z + r * Math.sin(angle));
                BlockPos stand = standAt(level, x, (int) Math.floor(target.y), z);
                if (stand != null && hasLos(level, body,
                        new Vec3(stand.getX() + 0.5, stand.getY() + eyeHeight, stand.getZ() + 0.5), target)) {
                    found.add(stand);
                }
            }
        }
        found.sort(Comparator.comparingDouble(
            p -> body.distanceToSqr(p.getX() + 0.5, p.getY(), p.getZ() + 0.5)));
        return found.size() > MAX_CANDIDATES ? found.subList(0, MAX_CANDIDATES) : found;
    }

    /**
     * COVER: the nearest standable cell that {@code threatEye} CANNOT see — this solver with its
     * sightline predicate negated and its rings centred on the BODY instead of the target.
     *
     * <p>Why it belongs here rather than in Reflexes: "find somewhere with a sightline" and "find
     * somewhere without one" are the same ring search, the same column probe and the same clip;
     * only the predicate flips. F3's flee had none of this — it picked a compass heading off the
     * away-vector and probed ONE cell for footing, so it could not seek cover, could not tell an
     * alley from open ground, and (FLEE_OFFSETS spanning only ±90°) could not leave by an exit that
     * lay past the threat. Live 2026-08-11: a body in a 3-sided pen with the threat on its open
     * side wedged in the corner 5 runs out of 5.
     *
     * <p>Returns null when nothing within {@code range} breaks the sightline — open field, where
     * running is the only answer and the caller should keep its heading fallback.
     *
     * <p>COST: rings × samples column probes, each with one clip — the same order as
     * {@link Engage} stationing, which is already known to be too expensive per tick. Call this
     * ONCE PER FLEE LEG and hold the result; never per tick.
     */
    static @org.jspecify.annotations.Nullable BlockPos cover(final ServerLevel level,
                                                             final LivingEntity body,
                                                             final Vec3 threatEye, final int range) {
        double eyeHeight = body.getEyeHeight();
        BlockPos best = null;
        double bestD2 = Double.MAX_VALUE;
        Vec3 here = body.position();
        for (int r = RING_STEP; r <= range; r += RING_STEP) {
            for (int s = 0; s < RING_SAMPLES; s++) {
                double angle = (2 * Math.PI * s) / RING_SAMPLES;
                int x = (int) Math.floor(here.x + r * Math.cos(angle));
                int z = (int) Math.floor(here.z + r * Math.sin(angle));
                BlockPos stand = standAt(level, x, (int) Math.floor(here.y), z);
                if (stand == null) {
                    continue;
                }
                Vec3 cellEye = new Vec3(stand.getX() + 0.5, stand.getY() + eyeHeight, stand.getZ() + 0.5);
                if (hasLos(level, body, threatEye, cellEye)) {
                    continue; // the threat can still see it — not cover
                }
                // COVER YOU CANNOT WALK TO IS NOT COVER. The cells that best break a sightline are
                // the ones BEHIND a wall, and a reflex steers by heading — it has no pathfinder — so
                // an unreachable pick walks the body into that wall and wedges it there. Measured
                // 2026-08-11: without this test the pen case simply changed which corner it stuck
                // in. A straight-line walkability probe is the honest match for straight-line
                // steering: if the body cannot get there by walking at it, it is not a candidate.
                if (!walkableLine(level, here, stand)) {
                    continue;
                }
                double d2 = body.distanceToSqr(stand.getX() + 0.5, stand.getY(), stand.getZ() + 0.5);
                if (d2 < bestD2) {
                    bestD2 = d2;
                    best = stand;
                }
            }
            if (best != null) {
                return best; // nearest ring that offers cover wins; no reason to scan wider
            }
        }
        return best;
    }

    /**
     * Can the body walk from {@code from} to {@code to} by heading straight at it? Samples the
     * horizontal segment every half block and requires feet+head clearance the whole way, allowing
     * the step up/down that {@link #standAt} would find. Deliberately NOT a pathfinder: this
     * validates the only motion a reflex can actually perform.
     */
    private static boolean walkableLine(final ServerLevel level, final Vec3 from, final BlockPos to) {
        double tx = to.getX() + 0.5, tz = to.getZ() + 0.5;
        double dx = tx - from.x, dz = tz - from.z;
        double len = Math.sqrt(dx * dx + dz * dz);
        if (len < 1.0e-6) {
            return true;
        }
        int steps = (int) Math.ceil(len * 2);
        int y = (int) Math.floor(from.y);
        for (int i = 1; i <= steps; i++) {
            double f = (double) i / steps;
            int cx = (int) Math.floor(from.x + dx * f);
            int cz = (int) Math.floor(from.z + dz * f);
            BlockPos step = standAt(level, cx, y, cz);
            if (step == null || Math.abs(step.getY() - y) > 1) {
                return false; // wall, hole, or a climb no walk can make
            }
            y = step.getY();
        }
        return true;
    }

    /** The standable cell in column (x,z) nearest {@code aroundY}, or null. Package-visible:
     *  Engage validates its combat anchors through this column search (F4). */
    static BlockPos standAt(final ServerLevel level, final int x, final int aroundY, final int z) {
        for (int dy = 0; dy <= Y_PROBE; dy = dy > 0 ? -dy : -dy + 1) { // 0, 1, -1, 2, -2, …
            BlockPos feet = new BlockPos(x, aroundY + dy, z);
            if (standable(level, feet)) {
                return feet;
            }
        }
        return null;
    }

    private static boolean standable(final ServerLevel level, final BlockPos feet) {
        return !level.getBlockState(feet.below()).isPathfindable(PathComputationType.LAND)
            && level.getBlockState(feet).isPathfindable(PathComputationType.LAND)
            && level.getBlockState(feet.above()).isPathfindable(PathComputationType.LAND);
    }

    /**
     * Does {@code from} see {@code target}? A clean miss counts (nothing stood in the way), and so
     * does clipping the target's OWN block — "LOS on the region" means the sightline ends AT the
     * thing, not that the thing is air.
     *
     * <p>The end test is an exact block-pos identity, deliberately, not a distance tolerance. A
     * tolerance is what makes this predicate lie: a 1-block shell around a sealed target is clipped
     * ~1.5 blocks from its centre, so any threshold loose enough to accept "hit the target's far
     * face" also accepts "hit the wall enclosing it" — and the enclosed case is precisely the one
     * that must concede.
     */
    static boolean hasLos(final ServerLevel level, final LivingEntity body, final Vec3 from,
                          final Vec3 target) {
        var hit = level.clip(new ClipContext(from, target,
            ClipContext.Block.COLLIDER, ClipContext.Fluid.NONE, body));
        if (hit.getType() == HitResult.Type.MISS) {
            return true;
        }
        return hit instanceof net.minecraft.world.phys.BlockHitResult bhr
            && bhr.getBlockPos().equals(BlockPos.containing(target));
    }
}
