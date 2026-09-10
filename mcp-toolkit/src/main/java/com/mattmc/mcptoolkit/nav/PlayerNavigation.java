package com.mattmc.mcptoolkit.nav;

import java.util.List;
import java.util.Set;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Vec3i;
import net.minecraft.world.level.pathfinder.Path;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

/**
 * The player body's path-follower — what {@code WalkerNavigation} is for the walker, minus the one
 * thing a non-Mob cannot have: {@code PathNavigation} itself. Vanilla's navigation hierarchy is
 * typed to {@code Mob} from {@code PathNavigation}'s constructor down, so a {@code ServerPlayer}
 * body cannot inherit its bookkeeping the way {@code WalkerNavigation} does; this class re-states
 * the small part of it that path-following actually needs.
 *
 * <p><b>What is reused, which is the point of §11.2:</b> the search ({@link NavSolver} +
 * {@link BuildWalkNodeEvaluator}) and the steering ({@link NavDriver}) are the walker's, unchanged.
 * Only the loop between them is written twice, and it is ~40 lines.
 *
 * <p><b>What is deliberately NOT re-stated</b> from {@code PathNavigation.followThePath}: corner
 * cutting ({@code shouldTargetNextNodeInDirection}), which lets a body skip toward the node after
 * next when it can move there directly. That is precisely the straight-line shortcutting the 0.26.0
 * driver edge-care exists to defend against near unbridged voids (§12.3), so this follower advances
 * strictly node by node.
 *
 * <p><b>Stuck detection is NOT optional here (§12.4).</b> It used to be, on the reasoning that the
 * goal loop re-solves — but the goal loop cannot: {@code GoalRunner.tick} returns immediately while
 * it has a sub-action in flight, and that sub-action only ends when this navigation reports
 * {@link #isDone()}. A path that merely stops advancing is never done, so the delegation was
 * circular and a body wedged against a shoreline left the agent waiting forever. The follower now
 * owns the invariant it is the only one that can see: a node not reached within
 * {@link #NODE_TIMEOUT_TICKS} ends the path, and the nav verdict reports {@code stopped_short} with
 * a real obstruction instead of silence.
 */
public final class PlayerNavigation {

    /** How far the search may look; the same ceiling {@code check_path} clamps to. */
    private static final float MAX_PATH_LENGTH = 512.0F;
    /** Vanilla's vertical waypoint tolerance for a ground navigation. */
    private static final double MAX_VERTICAL_DISTANCE = 1.0;
    /**
     * How many nodes ahead a planned jump switches the run-up on. Sprint acceleration reaches its
     * terminal speed within a few blocks, and starting earlier than that only means sprinting down
     * corridors that never jump.
     */
    private static final int RUN_UP_LOOKAHEAD = 4;
    /**
     * How long the follower will chase ONE waypoint before conceding the path (5 seconds). Generous
     * against the worst legitimate case — a slow diagonal swim into a current — and still an order
     * of magnitude below the "waited forever" it replaces. A circuit breaker, never a budget: the
     * timer resets on every node reached, so a long route never trips it by being long.
     */
    private static final int NODE_TIMEOUT_TICKS = 100;

    private final NavBody body;
    private final NavDriver driver = new NavDriver();
    private final TraversalTrail trail = new TraversalTrail();

    private @Nullable Path path;
    private @Nullable BuildWalkNodeEvaluator evaluator;
    private double speedModifier = 1.0;
    private net.minecraft.world.level.@Nullable Level level;
    /** Ticks spent on the current waypoint, and which one it is — the stuck detector's whole state. */
    private int nodeTicks;
    private int nodeIndex = -1;
    /** Set when the node timeout ended the path — vanilla's {@code isStuck}, for a body that is not
     *  a Mob and so has no {@code PathNavigation} to inherit it from. Cleared by the next solve. */
    private boolean timedOut;
    /** The node cell that ended the path because the body cannot physically enter it (see
     *  {@link #tick}'s blocked-node stop) — the obstruction, for callers that report it. */
    private @Nullable BlockPos blockedOn;

    public PlayerNavigation(final NavBody body) {
        this.body = body;
    }

    /**
     * Solve to {@code target} and start following. Returns false when no path exists — the caller
     * reports that as honestly as {@code check_path} does; a body that cannot get there must not be
     * left walking hopefully at a wall.
     */
    public boolean moveTo(final net.minecraft.world.level.Level level, final BlockPos target,
                          final double speed, final NavProfile profile) {
        return moveToStands(level, Set.of(target), speed, profile) != null;
    }

    /**
     * Solve to the nearest of {@code stands} (a reach goal's candidate cells) and start following.
     * Returns the stand the path actually ends at, or null when no path exists.
     */
    public @Nullable BlockPos moveToStands(final net.minecraft.world.level.Level level,
                                           final Set<BlockPos> stands, final double speed,
                                           final NavProfile profile) {
        // The walker's invariant, restored for the player body (NavProfile.withoutBuildRights): a
        // path this follower is about to WALK never assumes un-performed repairs. Nothing mines or
        // bridges during path-following, so a break-edge in a followed path is a wall the body will
        // march into until the node timeout — 101 ticks per leg on the 2026-08-02 live wedge. The
        // goal loop still solves build-assisted (NavSolver directly) and performs each step itself;
        // this solve keeps only the movement rights (doors, swim).
        NavSolver.Result result = NavSolver.solve(level, body, stands, MAX_PATH_LENGTH,
            profile.withoutBuildRights());
        if (result.path() == null) {
            stop();
            return null;
        }
        this.path = result.path();
        this.evaluator = result.evaluator();
        // The steering must obey the SAME swim right the route was planned under. Without this the
        // planner routed around water on `swim:false` and the driver swam anyway the moment the body
        // touched any (NavDriver.swimAllowed) — a land-only goal that drowned a player body.
        this.driver.setSwimAllowed(profile.canSwim());
        this.speedModifier = speed;
        this.level = level;
        this.nodeTicks = 0;
        this.nodeIndex = -1;
        this.timedOut = false; // a fresh solve is not stuck until it proves otherwise
        this.blockedOn = null;
        return result.path().getTarget();
    }

    /**
     * The proprioception trail since the last drain (SURVIVAL_MODE_PLAN.md §4) — cells this body
     * actually reached, with their true contents at traversal time.
     */
    public TraversalTrail trail() {
        return trail;
    }

    /** True when there is nothing left to follow (arrived, never started, or stopped). */
    public boolean isDone() {
        return path == null || path.isDone();
    }

    /** The path currently being followed, for callers that need to report progress. */
    public @Nullable Path path() {
        return path;
    }

    /** Drop the path and stop the legs — the driver is the only input writer, so it must zero them. */
    public void stop() {
        path = null;
        evaluator = null;
        nodeTicks = 0;
        nodeIndex = -1;
        if (!driver.isLeaping()) {
            driver.idle(body);
        }
    }

    /** True while the swim control has the body off its route to breathe (§12.4) — not a stall. */
    public boolean isSurfacing() {
        return driver.isSurfacing();
    }

    /** Sprint every forward frame of the current (and following) paths — fight-mode repositioning
     *  (F4). Sticky: the caller that sets it clears it. */
    public void setSprint(final boolean on) {
        driver.setSprintAll(on);
    }

    /**
     * Did the node timeout end the last path? The player body's answer to vanilla's
     * {@code PathNavigation.isStuck}, which it cannot inherit for want of being a Mob. Read by
     * {@code Bodies.Nav.stalled} so the nav verdict can name a wedged body as wedged.
     */
    public boolean timedOut() {
        return timedOut;
    }

    /** The impassable node cell that ended the last path, or null when it ended any other way. */
    public @Nullable BlockPos blockedOn() {
        return blockedOn;
    }

    /**
     * Is either cell of the body's would-be column at {@code node} clearly impassable? The test the
     * blocked-node stop runs each tick — deliberately cruder than the evaluator's classification:
     * it only needs to catch what a walking body can never pass (full blocks, doors, panes), while
     * slabs, carpets and snow layers read passable and anything ambiguous defers to the timeout.
     */
    private static boolean cellBlocked(final net.minecraft.world.level.Level level, final Vec3i node) {
        return solidAt(level, new BlockPos(node.getX(), node.getY(), node.getZ()))
            || solidAt(level, new BlockPos(node.getX(), node.getY() + 1, node.getZ()));
    }

    /** Does this cell hold collision taller than the step height — i.e. a wall, not a floor detail? */
    private static boolean solidAt(final net.minecraft.world.level.Level level, final BlockPos pos) {
        net.minecraft.world.level.block.state.BlockState state = level.getBlockState(pos);
        if (state.isAir()) {
            return false;
        }
        net.minecraft.world.phys.shapes.VoxelShape shape = state.getCollisionShape(level, pos);
        return !shape.isEmpty() && shape.max(net.minecraft.core.Direction.Axis.Y) > 0.6;
    }

    /**
     * Verified landings of leaps this body made, drained for the caller's ledger — same contract as
     * {@code WalkerNavigation.drainSelfLeaps}: recorded at touchdown, never at launch.
     */
    public List<BlockPos> drainSelfLeaps() {
        return driver.drainSelfLeaps();
    }

    /** One tick of following. Mirrors {@code WalkerNavigation.tick}'s shape. */
    public void tick() {
        // A leap owns the inputs from launch to touchdown, even if the path ended underneath it.
        if (driver.isLeaping()) {
            driver.steer(body, Vec3.ZERO, speedModifier, false);
            return;
        }
        if (isDone()) {
            driver.idle(body);
            return;
        }

        advanceIfReached();

        if (isDone()) {
            driver.idle(body);
            return;
        }
        if (timedOutOnNode()) {
            // Record BEFORE stopping — stop() clears the follower's state, and this flag is the only
            // thing that lets the verdict say "wedged" rather than a generic stopped_short.
            timedOut = true;
            stop();
            return;
        }
        Vec3i node = path.getNextNodePos();
        // A node the body cannot physically enter RIGHT NOW ends the path immediately — the world
        // changed under the plan (gravel fell, a door closed, another body built). Waiting out the
        // node timeout against the wall instead was measured at 101 ticks per attempt on the live
        // wedge, and the goal loop cannot repair what it has not yet been told about. Conservative
        // on purpose: only clearly-impassable cells trip it; anything uncertain still falls back to
        // the timeout, so a false negative costs the old 5 seconds, never correctness.
        if (level != null && cellBlocked(level, node)) {
            blockedOn = new BlockPos(node.getX(), node.getY(), node.getZ());
            timedOut = true; // wedged-class verdict: re-issuing the same call hits the same wall
            stop();
            return;
        }
        // A swim waypoint is aimed at the CENTRE of its cell, not its floor: the vertical component
        // is the whole point of a dive/ascend edge, and floor-anchoring it (what a walking follower
        // wants) would ask the body to swim to the seabed of every cell it crosses.
        double wy = body.canSwim() && body.inWater() ? node.getY() + 0.5 : node.getY();
        Vec3 waypoint = new Vec3(node.getX() + 0.5, wy, node.getZ() + 0.5);
        driver.steer(body, waypoint, speedModifier, isJumpLanding(node), jumpWithin(RUN_UP_LOOKAHEAD));
    }

    /**
     * Has the follower been stuck on one waypoint too long? The timer resets whenever the path index
     * advances, and is held (not incremented) while the swim control has legitimately taken the body
     * away to breathe — surfacing is progress toward finishing the route, and counting it as a stall
     * would abort exactly the bodies that were saving themselves.
     */
    private boolean timedOutOnNode() {
        int index = path.getNextNodeIndex();
        if (index != nodeIndex) {
            nodeIndex = index;
            nodeTicks = 0;
            return false;
        }
        if (driver.isSurfacing() || driver.isLeaping()) {
            return false;
        }
        return ++nodeTicks > NODE_TIMEOUT_TICKS;
    }

    /**
     * Is a planned jump landing within the next {@code nodes} waypoints? The run-up signal: a body
     * whose leap is real physics must already be sprinting when it reaches the take-off lip, and by
     * the time the landing is the CURRENT waypoint the leap gate fires the same tick — measured
     * (§11.8), the difference between clearing a 3-gap and landing 0.3 short against its far face.
     */
    private boolean jumpWithin(final int nodes) {
        if (path == null || evaluator == null) {
            return false;
        }
        int from = path.getNextNodeIndex();
        int to = Math.min(path.getNodeCount(), from + nodes);
        for (int i = from; i < to; i++) {
            if (isJumpLanding(path.getNodePos(i))) {
                return true;
            }
        }
        return false;
    }

    /** Vanilla's close-enough test ({@code followThePath}), sized off the body's width. */
    private void advanceIfReached() {
        Vec3i node = path.getNextNodePos();
        double maxDistance = body.bbWidth() > 0.75F
            ? body.bbWidth() / 2.0F
            : 0.75F - body.bbWidth() / 2.0F;
        double dx = Math.abs(body.x() - (node.getX() + 0.5));
        double dy = Math.abs(body.y() - node.getY());
        double dz = Math.abs(body.z() - (node.getZ() + 0.5));
        if (dx < maxDistance && dz < maxDistance && dy < MAX_VERTICAL_DISTANCE) {
            if (level != null) { // a reached node is a KNOWN cell — proprioception (§4)
                trail.record(level, new BlockPos(node.getX(), node.getY(), node.getZ()));
            }
            path.advance();
        }
    }

    /** Was this waypoint planned as a sprint-jump landing by the search that produced the path? */
    private boolean isJumpLanding(final Vec3i pos) {
        return evaluator != null
            && evaluator.plannedAt(new BlockPos(pos.getX(), pos.getY(), pos.getZ()))
                == BuildWalkNodeEvaluator.Action.JUMP;
    }
}
