package com.mattmc.mcptoolkit.nav;

import java.util.Set;
import net.minecraft.core.BlockPos;
import net.minecraft.util.Mth;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.ai.navigation.GroundPathNavigation;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.PathNavigationRegion;
import net.minecraft.world.level.pathfinder.Path;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

/**
 * The walker's {@code PathNavigation}-shaped façade (BOT_SURFACE_DESIGN.md §11.6, "where the driver
 * ticks"): everything that already composes with {@code Mob.getNavigation()} — {@code startNav},
 * follow mode, engage — keeps working, but the SEARCH runs our body-agnostic stack (with sprint-jump
 * edges) and the STEERING runs the {@link NavDriver} input frames instead of {@code MoveControl}.
 *
 * <p>Two seams do all the work:
 * <ul>
 *   <li>{@link #createPathFinder} returns a vanilla-typed {@link Bridge} whose {@code findPath}
 *       delegates to our {@link PathFinder} + {@link BuildWalkNodeEvaluator} under
 *       {@link NavProfile#VANILLA} — walk + sprint-jump edges, no world modification. Build-assisted
 *       routing stays the goal loop's business: it solves with the caller's profile and performs the
 *       work itself, so a path from THIS navigation never assumes un-performed repairs. All of
 *       vanilla's path bookkeeping (trim, stuck detection, timeouts, recompute) is inherited intact.
 *   <li>{@link #tick} mirrors {@code PathNavigation.tick} but hands the next waypoint to the driver,
 *       flagging waypoints the last search planned as JUMP landings so the driver leaps the gap
 *       instead of walking off the edge.
 * </ul>
 *
 * <p>The walker's own {@code MoveControl} must be inert (the §11.6 gotcha: its WAIT state zeroes
 * {@code zza} every tick, right after this navigation ticks) — {@code WalkerEntity} guarantees that.
 */
public class WalkerNavigation extends GroundPathNavigation {

    private final NavBody body;
    private final NavDriver driver = new NavDriver();
    private final TraversalTrail trail = new TraversalTrail();
    private Bridge bridge;

    public <T extends Mob & NavBody> WalkerNavigation(final T mob, final Level level) {
        super(mob, level);
        this.body = mob;
    }

    @Override
    protected net.minecraft.world.level.pathfinder.PathFinder createPathFinder(final int maxVisitedNodes) {
        // The dummy vanilla evaluator only absorbs setCanOpenDoors/setCanFloat calls from generic
        // PathNavigation plumbing; the real search never touches it.
        this.nodeEvaluator = new net.minecraft.world.level.pathfinder.WalkNodeEvaluator();
        this.bridge = new Bridge(this.nodeEvaluator, maxVisitedNodes);
        return this.bridge;
    }

    /** Was {@code pos} planned as a sprint-jump landing by the search that produced the current path? */
    private boolean isJumpLanding(final net.minecraft.core.Vec3i pos) {
        BuildWalkNodeEvaluator evaluator = bridge.lastEvaluator;
        return evaluator != null
            && evaluator.plannedAt(new BlockPos(pos.getX(), pos.getY(), pos.getZ())) == BuildWalkNodeEvaluator.Action.JUMP;
    }

    /**
     * Actuate a leap to {@code landing} directly — the goal loop's repair path lands here so a
     * planned JUMP uses the same actuation as path-following (one leap, not two implementations).
     * Like every driver leap it is recorded at VERIFIED touchdown and surfaces via
     * {@link #drainSelfLeaps}; the caller must not also log it at actuation.
     */
    public void leapTo(final BlockPos landing) {
        driver.leap(body, Vec3.atBottomCenterOf(landing));
    }

    /**
     * Verified landings of the driver's leaps (path-following self-leaps AND {@link #leapTo}) since
     * the last drain — the goal loop folds these into its ledger, because a leap the body actually
     * made and did not disclose would be a silent world-interaction (the same doctrine as
     * mined/placed cells). Recorded only at touchdown within range of the planned landing.
     */
    public java.util.List<BlockPos> drainSelfLeaps() {
        return driver.drainSelfLeaps();
    }

    /** Sprint every forward frame — fight-mode repositioning (F4). Sticky: caller clears it. */
    public void setSprint(final boolean on) {
        driver.setSprintAll(on);
    }

    /**
     * The proprioception trail since the last drain (SURVIVAL_MODE_PLAN.md §4) — cells this body
     * actually reached, with their true contents at traversal time.
     */
    public TraversalTrail trail() {
        return trail;
    }

    @Override
    public void tick() {
        this.tick++;
        if (this.hasDelayedRecomputation) {
            this.recomputePath();
        }

        // A leap owns the inputs from launch to touchdown, even if the path ended underneath it.
        if (driver.isLeaping()) {
            driver.steer(body, Vec3.ZERO, this.speedModifier, false); // waypoint unused mid-leap
            return;
        }

        if (this.isDone()) {
            driver.idle(body); // the inert MoveControl won't zero zza — the driver must
            return;
        }

        // Vanilla advances the path inside followThePath (and the airborne branch below); the trail
        // records every node the index moved past — reached cells, read at traversal time (§4).
        Path beforePath = this.path;
        int beforeIndex = beforePath == null ? 0 : beforePath.getNextNodeIndex();

        if (this.canUpdatePath()) {
            this.followThePath();
        } else if (this.path != null && !this.path.isDone()) {
            // Falling: advance past a node we've dropped below (vanilla's airborne branch).
            Vec3 mobPos = this.getTempMobPos();
            Vec3 next = this.path.getNextEntityPos(this.mob);
            if (mobPos.y > next.y && !this.mob.onGround()
                && Mth.floor(mobPos.x) == Mth.floor(next.x) && Mth.floor(mobPos.z) == Mth.floor(next.z)) {
                this.path.advance();
            }
        }

        if (this.path == beforePath && beforePath != null) {
            int afterIndex = beforePath.isDone() ? beforePath.getNodeCount() : beforePath.getNextNodeIndex();
            for (int i = beforeIndex; i < afterIndex; i++) {
                net.minecraft.core.Vec3i node = beforePath.getNodePos(i);
                trail.record(this.level, new BlockPos(node.getX(), node.getY(), node.getZ()));
            }
        }

        if (!this.isDone()) {
            Vec3 target = this.path.getNextEntityPos(this.mob);
            boolean jumpLanding = isJumpLanding(this.path.getNextNodePos());
            // Floor-anchoring the waypoint is what a WALKING body wants; a swimming one needs the
            // cell's own height, because the vertical component is the entire content of a dive or
            // ascend edge. getGroundY would flatten every swim waypoint onto the seabed.
            double wy = body.canSwim() && body.inWater() ? target.y : this.getGroundY(target);
            driver.steer(body, new Vec3(target.x, wy, target.z), this.speedModifier, jumpLanding);
        } else {
            driver.idle(body);
        }
    }

    @Override
    public void stop() {
        super.stop();
        // Without MoveControl's WAIT state, stopping the path must also stop the legs.
        if (driver != null && !driver.isLeaping()) {
            driver.idle(body);
        }
    }

    /**
     * Vanilla-typed {@code PathFinder} whose {@code findPath} runs OUR stack — the seam that lets
     * {@code PathNavigation.createPath}'s untouched bookkeeping (targetPos, stuck timers, region
     * construction) drive a body-agnostic search. A fresh {@link BuildWalkNodeEvaluator} per solve,
     * retained so the façade can read the jump plan off the returned path.
     */
    private static final class Bridge extends net.minecraft.world.level.pathfinder.PathFinder {
        private int maxVisitedNodes;
        @Nullable BuildWalkNodeEvaluator lastEvaluator;

        Bridge(final net.minecraft.world.level.pathfinder.NodeEvaluator dummy, final int maxVisitedNodes) {
            super(dummy, maxVisitedNodes);
            this.maxVisitedNodes = maxVisitedNodes;
        }

        @Override
        public void setMaxVisitedNodes(final int maxVisitedNodes) {
            super.setMaxVisitedNodes(maxVisitedNodes);
            this.maxVisitedNodes = maxVisitedNodes;
        }

        @Override
        public @Nullable Path findPath(final PathNavigationRegion region, final Mob entity,
                                       final Set<BlockPos> targets, final float maxPathLength,
                                       final int reachRange, final float maxVisitedNodesMultiplier) {
            // DEFAULT, not VANILLA: same rights (no doors, no world edits) plus the swim capability,
            // so a walker's own navigation crosses water instead of treating every pond as a wall.
            BuildWalkNodeEvaluator evaluator = new BuildWalkNodeEvaluator(NavProfile.DEFAULT);
            this.lastEvaluator = evaluator;
            PathFinder finder = new PathFinder(evaluator,
                (int) (this.maxVisitedNodes * maxVisitedNodesMultiplier));
            NavPhysique physique = entity instanceof NavBody nav ? nav : MobPhysique.of(entity, false);
            Path path = finder.findPath(region, physique, targets, maxPathLength, reachRange, 1.0F);
            // Only the winning path's jump landings may steer the driver — a landing planned by a
            // losing branch must not flag a waypoint the body reaches by plain walking.
            evaluator.commitPlan(path);
            return path;
        }
    }
}
