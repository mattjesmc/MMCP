package com.mattmc.mcptoolkit;

import com.mattmc.mcptoolkit.ReadSupport.ChunkLoader;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.util.Mth;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.shapes.CollisionContext;
import org.jspecify.annotations.Nullable;

import java.util.LinkedHashSet;
import java.util.Set;

/**
 * The reach-goal solver: given a target block, compute every cell a body could occupy from which its
 * hand can TOUCH the block — within {@link #HAND_REACH} of the eye, with line of sight to a face.
 * The mineflayer-pathfinder goal vocabulary ({@code GoalGetToBlock}/{@code GoalLookAtBlock}) realized
 * server-side (RESEARCH_WORLD_REPRESENTATION.md round three, explorative option 1).
 *
 * <p><b>Geometry only — occupancy is deliberately NOT filtered.</b> The shell includes cells inside
 * solid rock or mid-air; whether a given body can stand/hover/swim in a cell is the pathfinder's
 * knowledge (its per-mode {@code NodeEvaluator}), so callers feed the whole shell to
 * {@code PathNavigation.createPath(Set, 0)} — vanilla A* natively takes a multi-target set and
 * terminates at the cheapest member it can occupy. That keeps this solver mode-agnostic: walkers,
 * flyers, and future swimmers share it unchanged.
 *
 * <p>Rays use {@code ClipContext.Block.COLLIDER} (same as perception's line-of-sight): non-colliding
 * blocks (torches, grass) don't occlude, glass does — you cannot touch through glass. Chunk-honest:
 * candidate cells in unreadable chunks (and rays that would cross one) are counted as
 * {@code unreadable}, never silently dropped — {@code visible == 0} with {@code unreadable > 0} is
 * "unknown", not "occluded".
 */
public final class ReachSolver {

    /** Hand reach from the eye, in blocks. Mirrors {@code Actuator.BLOCK_REACH} — same number AND
     * same anchor (distance to the block's CENTER, the hands' {@code inBlockReach} measure), so a
     * stand this solver accepts is a stand the hands accept. First live run caught the mismatch:
     * nearest-point-anchored stands passed the touch gates and still drew out_of_reach from mine. */
    public static final double HAND_REACH = 4.5;

    /** Planning margin: preferred stands keep this much slack inside {@link #HAND_REACH}. A* picks
     * the CHEAPEST shell member — typically the boundary cell facing the approach — and a hovering
     * drone drifts ~1 block, so boundary landings verify out_of_reach by centimeters (measured on
     * the first live run: stopped_short at 5.8 with the follow-up goto arriving after 0.86). Plan
     * tight, verify at the true reach; fall back to the full shell when the tight set is empty. */
    private static final double PLAN_MARGIN = 1.0;

    /** Inset for line-of-sight ray targets: aim at the face's interior, never its edges. A ray to a
     * box corner can graze exactly along the seam between two occluders and read "visible" (the
     * entombed-chest case, first live run: visible:1 through a solid tomb). */
    private static final double FACE_INSET = 0.05;

    /** Shell result: the touch-capable cells plus the honesty counters the verdict needs. */
    public record Result(Set<BlockPos> stands, int candidates, int visible, int unreadable) {}

    /** The two reach gates from one specific eye position, separable for failure reporting:
     * {@code inRange} (eye within {@link #HAND_REACH} of the block's box) and {@code los}
     * (sightline to the nearest face — null when unreadable chunks hide the answer). */
    public record Touch(boolean inRange, @Nullable Boolean los) {
        public boolean ok() {
            return inRange && Boolean.TRUE.equals(los);
        }
    }

    private ReachSolver() {}

    /** Convenience for embodied callers outside this package (their own {@link ChunkLoader} is hidden). */
    public static Result solve(final ServerLevel level, final BlockPos target, final double eyeHeight,
                               final boolean load) {
        return solve(level, target, eyeHeight, new ChunkLoader(level, load));
    }

    /**
     * Compute the reach shell for {@code target}: every cell whose occupant's eye (feet + {@code
     * eyeHeight}) is within {@link #HAND_REACH} of the block with line of sight. The target's own
     * cell is excluded (adjacent-to, not inside — the chest case).
     */
    static Result solve(final ServerLevel level, final BlockPos target, final double eyeHeight,
                        final ChunkLoader loader) {
        Set<BlockPos> preferred = new LinkedHashSet<>();
        Set<BlockPos> all = new LinkedHashSet<>();
        int candidates = 0;
        int visible = 0;
        int unreadable = 0;
        Vec3 center = Vec3.atCenterOf(target);
        // Feet-cell bounds from the eye constraint: eye x/z are cell + 0.5 and must fall within
        // HAND_REACH of the block center; eye y = cell y + eyeHeight.
        int r = (int) Math.ceil(HAND_REACH + 0.5);
        int yMin = Mth.floor(target.getY() + 0.5 - HAND_REACH - eyeHeight);
        int yMax = Mth.floor(target.getY() + 0.5 + HAND_REACH);
        for (int y = yMin; y <= yMax; y++) {
            for (int x = target.getX() - r; x <= target.getX() + r; x++) {
                for (int z = target.getZ() - r; z <= target.getZ() + r; z++) {
                    if (x == target.getX() && y == target.getY() && z == target.getZ()) {
                        continue;
                    }
                    // Adjacent-to, not inside — for the EYE as well as the feet: a stand whose eye
                    // lands inside the target's cell "sees" it from within (rays from inside a
                    // shape read clear), producing a phantom visible cell inside solid ground that
                    // corrupts the occluded-vs-unreachable distinction (first live run: a walker
                    // head-inside an entombed chest).
                    if (x == target.getX() && z == target.getZ()
                        && Mth.floor(y + eyeHeight) == target.getY()) {
                        continue;
                    }
                    Vec3 eye = new Vec3(x + 0.5, y + eyeHeight, z + 0.5);
                    double range = eye.distanceTo(center);
                    if (range > HAND_REACH) {
                        continue;
                    }
                    candidates++;
                    BlockPos cell = new BlockPos(x, y, z);
                    if (!loader.ensure(cell)) {
                        unreadable++;
                        continue;
                    }
                    Touch t = touch(level, eye, target);
                    if (t.los() == null) {
                        unreadable++;
                    } else if (t.ok()) {
                        visible++;
                        all.add(cell);
                        if (range <= HAND_REACH - PLAN_MARGIN) {
                            preferred.add(cell);
                        }
                    }
                }
            }
        }
        return new Result(preferred.isEmpty() ? all : preferred, candidates, visible, unreadable);
    }

    /**
     * Both reach gates from a concrete eye position — also the arrival verdict for a reach-goal
     * flight (arrived means "can touch it now", re-verified against real geometry, not assumed
     * from the path).
     */
    public static Touch touch(final ServerLevel level, final Vec3 eye, final BlockPos target) {
        Vec3 center = Vec3.atCenterOf(target);
        if (eye.distanceTo(center) > HAND_REACH) {
            return new Touch(false, null);
        }
        // Ray 1 aims at the nearest FACE-INTERIOR point, nudged just inside so a solid target
        // registers as a hit ON target rather than a grazing surface ambiguity; an eye already
        // inside the cell trivially touches. Rays 2..4 aim at the CENTERS of the eye-facing faces:
        // a single nearest-point ray under-reports plain adjacency — from an eye above a feet-level
        // neighbor the nearest point sits in the top edge region, and the ray to it clips the
        // head-level block in front, while the face center is plainly visible. Live-caught
        // (2026-08-02): `los:false` at range 1.08 to a block the body was staring at, which starved
        // the goal loop's repair of every mineable step and wedged it for 25 rounds.
        Vec3 nearest = nearestFacePoint(eye, target);
        Vec3 first = nearest.distanceToSqr(center) < 1.0e-6
            ? center
            : nearest.add(center.subtract(nearest).normalize().scale(0.01));
        java.util.List<Vec3> ends = new java.util.ArrayList<>(4);
        ends.add(first);
        Vec3 delta = eye.subtract(center);
        if (Math.abs(delta.x) > 0.5) {
            ends.add(center.add(Math.copySign(0.49, delta.x), 0.0, 0.0));
        }
        if (Math.abs(delta.y) > 0.5) {
            ends.add(center.add(0.0, Math.copySign(0.49, delta.y), 0.0));
        }
        if (Math.abs(delta.z) > 0.5) {
            ends.add(center.add(0.0, 0.0, Math.copySign(0.49, delta.z)));
        }
        boolean unreadable = false;
        for (Vec3 end : ends) {
            if (eye.distanceToSqr(end) < 1.0e-9) {
                return new Touch(true, true);
            }
            if (!ReadSupport.segmentChunksLoaded(level, eye, end)) {
                unreadable = true;
                continue;
            }
            BlockHitResult hit = level.clip(new ClipContext(eye, end,
                ClipContext.Block.COLLIDER, ClipContext.Fluid.NONE, CollisionContext.empty()));
            if (hit.getType() == HitResult.Type.MISS || hit.getBlockPos().equals(target)) {
                return new Touch(true, true);
            }
        }
        // No ray reached the block; an unreadable segment means "unknown", never "occluded".
        return new Touch(true, unreadable ? null : false);
    }

    /** Nearest point of the block's box shrunk by {@link #FACE_INSET} — a target on a face's
     * interior, never on an edge or corner where a ray can graze between two occluders. */
    private static Vec3 nearestFacePoint(final Vec3 eye, final BlockPos target) {
        return new Vec3(
            Mth.clamp(eye.x, target.getX() + FACE_INSET, target.getX() + 1.0 - FACE_INSET),
            Mth.clamp(eye.y, target.getY() + FACE_INSET, target.getY() + 1.0 - FACE_INSET),
            Mth.clamp(eye.z, target.getZ() + FACE_INSET, target.getZ() + 1.0 - FACE_INSET));
    }
}
