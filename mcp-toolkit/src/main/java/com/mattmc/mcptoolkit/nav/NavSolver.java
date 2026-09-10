package com.mattmc.mcptoolkit.nav;

import com.google.gson.JsonObject;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.util.Mth;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.PathNavigationRegion;
import net.minecraft.world.level.block.DoorBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.pathfinder.Path;
import net.minecraft.world.level.pathfinder.PathComputationType;
import net.minecraft.world.level.pathfinder.PathType;
import org.jspecify.annotations.Nullable;

import java.util.Set;

/**
 * One place where "solve a path for THIS body with THIS profile" happens — so {@code check_path}
 * (prediction) and the goal loop (execution) can never run different solvers and disagree
 * (BOT_SURFACE_DESIGN.md §1.1). It also answers the question the vanilla result cannot: <b>which block
 * stopped the search</b> (§2.1).
 *
 * <p>This deliberately bypasses {@code PathNavigation.createPath}, which would use the body's own
 * hardcoded evaluator. It reproduces that method's region construction exactly and substitutes a
 * {@link BuildWalkNodeEvaluator} configured from the caller's {@link NavProfile}.
 */
public final class NavSolver {

    /** Matches {@code PathNavigation}: visited-node budget scales with the requested path length. */
    private static final int VISITED_NODES_PER_BLOCK = 16;

    private NavSolver() {}

    /** A solved (or partly solved) path plus the evaluator that produced it, for its build plan. */
    public record Result(@Nullable Path path, BuildWalkNodeEvaluator evaluator) {

        public boolean reached() {
            return path != null && path.canReach();
        }

        /** True when the body cannot simply walk this path — it has blocks to break/place/open. */
        public boolean needsWork() {
            return !evaluator.plan().isEmpty();
        }

        /**
         * The budget the COMMITTED plan exceeds — {@code "break_budget_exceeded"} /
         * {@code "place_budget_exceeded"} — or null when the plan fits the profile. The search cannot
         * count per-path work while exploring (a node explored is not a node committed), so the
         * honest budget check happens here, on the winning path's plan. This is what lets
         * {@code check_path} say "a route exists but not under this budget" instead of promising a
         * traversal execution would stop with {@code break_budget_spent}.
         */
        public @Nullable String overBudget() {
            NavProfile profile = evaluator.profile();
            if (evaluator.planned(BuildWalkNodeEvaluator.Action.BREAK) > profile.breakBudget()) {
                return "break_budget_exceeded";
            }
            // A pillar-up spends a placed block just like a bridge cell, so both draw on the place
            // budget — otherwise a towering route would predict as free and execution would refuse it.
            int placed = evaluator.planned(BuildWalkNodeEvaluator.Action.PLACE)
                + evaluator.planned(BuildWalkNodeEvaluator.Action.PILLAR);
            if (placed > profile.placeBudget()) {
                return "place_budget_exceeded";
            }
            return null;
        }
    }

    /**
     * Solve for {@code targets} from the body's current position. {@code maxPathLength} bounds both
     * the search and the region read, exactly as {@code PathNavigation.createPath} does. The body is
     * a {@link NavPhysique} — shape data, not necessarily a live entity — and its door rights must
     * already reflect the profile (both factory paths below guarantee that).
     */
    public static Result solve(final Level level, final NavPhysique body, final Set<BlockPos> targets,
                               final float maxPathLength, final NavProfile profile) {
        BuildWalkNodeEvaluator evaluator = new BuildWalkNodeEvaluator(profile);
        if (targets.isEmpty()) {
            return new Result(null, evaluator);
        }
        PathFinder finder = new PathFinder(evaluator, Mth.floor(maxPathLength * VISITED_NODES_PER_BLOCK));
        BlockPos from = body.blockPosition();
        int radius = (int) maxPathLength + 1;
        PathNavigationRegion region = new PathNavigationRegion(level,
            from.offset(-radius, -radius, -radius), from.offset(radius, radius, radius));
        Path path = finder.findPath(region, body, targets, maxPathLength, 0, 1.0F);
        // Commit the plan to the edges actually on the winning path — work recorded by losing
        // branches must never drive execution or inflate the reported work counts.
        evaluator.commitPlan(path);
        return new Result(path, evaluator);
    }

    /** Convenience for live-entity callers: wraps the mob with the profile's door rights overlaid. */
    public static Result solve(final Level level, final Mob body, final Set<BlockPos> targets,
                               final float maxPathLength, final NavProfile profile) {
        return solve(level, MobPhysique.of(body, profile.canOpenDoors()), targets, maxPathLength, profile);
    }

    // ---- knowledge-masked solve (CHECK_PATH_AUDIT.md R2) ----------------------

    /**
     * {@link #solve}, but over HELD KNOWLEDGE only: cells outside {@code known} read as bedrock —
     * blocking, unbreakable, unbridgeable — so the search can neither route through nor plan work
     * in terrain the session never observed, and the answer is derivable from knowledge alone.
     * Every unknown cell the search actually consulted lands in {@code touchedUnknown}: a failed
     * search that touched none is genuinely sealed within known terrain (an honest
     * {@code reachable:false}); one that touched some ran out of knowledge, not of world
     * ({@code reachable:null} + a frontier).
     *
     * <p>The physique MUST carry no {@code PathTypeCache} (use
     * {@link SyntheticPhysique#walkerUncached}): the shared cache would leak real-world verdicts in
     * and write masked ones out.
     */
    public static Result solveMasked(final Level level, final NavPhysique body,
                                     final Set<BlockPos> targets, final float maxPathLength,
                                     final NavProfile profile,
                                     final java.util.function.LongPredicate known,
                                     final it.unimi.dsi.fastutil.longs.LongSet touchedUnknown) {
        if (body.pathTypeCache() != null) {
            throw new IllegalArgumentException("masked solve requires a cache-less physique");
        }
        BuildWalkNodeEvaluator evaluator = new BuildWalkNodeEvaluator(profile);
        if (targets.isEmpty()) {
            return new Result(null, evaluator);
        }
        PathFinder finder = new PathFinder(evaluator, Mth.floor(maxPathLength * VISITED_NODES_PER_BLOCK));
        BlockPos from = body.blockPosition();
        int radius = (int) maxPathLength + 1;
        PathNavigationRegion region = new MaskedRegion(level,
            from.offset(-radius, -radius, -radius), from.offset(radius, radius, radius),
            known, touchedUnknown);
        Path path = finder.findPath(region, body, targets, maxPathLength, 0, 1.0F);
        evaluator.commitPlan(path);
        return new Result(path, evaluator);
    }

    /**
     * From the unknown cells a masked search touched, the one nearest the goal — the honest "your
     * knowledge ends here; go look" pointer. Derived from search behavior over known cells plus
     * the seen-set itself, never from world truth, so it cannot disclose unseen terrain.
     */
    public static @Nullable BlockPos knowledgeFrontier(
            final it.unimi.dsi.fastutil.longs.LongSet touchedUnknown, final BlockPos goal) {
        BlockPos best = null;
        double bestSq = Double.MAX_VALUE;
        for (it.unimi.dsi.fastutil.longs.LongIterator it = touchedUnknown.iterator(); it.hasNext();) {
            BlockPos p = BlockPos.of(it.nextLong());
            double dSq = p.distSqr(goal);
            if (dSq < bestSq) {
                bestSq = dSq;
                best = p;
            }
        }
        return best;
    }

    /** Unseen cells read as bedrock: opaque to the walk, unbreakable to the build router. The
     *  fluid read reports empty for unseen cells for the same reason — an unknown lake must not
     *  classify as water any more than unknown stone may classify as minable. */
    private static final class MaskedRegion extends PathNavigationRegion {
        private static final net.minecraft.world.level.block.state.BlockState UNKNOWN_STATE =
            net.minecraft.world.level.block.Blocks.BEDROCK.defaultBlockState();

        private final java.util.function.LongPredicate known;
        private final it.unimi.dsi.fastutil.longs.LongSet touched;

        MaskedRegion(final Level level, final BlockPos start, final BlockPos end,
                     final java.util.function.LongPredicate known,
                     final it.unimi.dsi.fastutil.longs.LongSet touched) {
            super(level, start, end);
            this.known = known;
            this.touched = touched;
        }

        @Override
        public BlockState getBlockState(final BlockPos pos) {
            if (!known.test(pos.asLong())) {
                touched.add(pos.asLong());
                return UNKNOWN_STATE;
            }
            return super.getBlockState(pos);
        }

        @Override
        public net.minecraft.world.level.material.FluidState getFluidState(final BlockPos pos) {
            if (!known.test(pos.asLong())) {
                touched.add(pos.asLong());
                return net.minecraft.world.level.material.Fluids.EMPTY.defaultFluidState();
            }
            return super.getFluidState(pos);
        }
    }

    /**
     * The first action the build-aware plan calls for, walking the path from the body outward — the
     * <em>next thing to do</em> to make progress, chosen by the search's global cost (jump vs bridge
     * vs mine vs door), not by eyeballing one cell. Null when the path is a plain walk with no planned
     * work. This is what lets execution follow the planner instead of greedily re-deciding.
     *
     * <p><b>A node's work is not always AT the node.</b> The evaluator records BREAK against the
     * blocked cell (feet OR head) and PLACE against the missing floor — so each path node must be
     * checked at feet, head, and floor. Missing the head lookup was a live-caught execution bug: the
     * loop mined a column's feet, re-solved, could no longer see the head's planned break (the feet
     * key was gone), and wandered off to the next column until the budget died. The APEX lookup
     * (feet+2) is the same bug one cell higher, live-caught by the pit-escape probe (w1_42257 F5):
     * a stair-up edge records its launch-headroom BREAK over the TAKE-OFF column at y+2, and the
     * pillar edge records its ceiling breaks there too — without the lookup the executor mined the
     * destination columns, could not see the headroom cell hanging over its own path, and walked
     * off toward far work it could never reach (g-13: 5 stair cells mined, body wedged one step up,
     * no_progress blaming a cell it had budget for).
     */
    public record Step(BlockPos at, BuildWalkNodeEvaluator.Action action) {}

    public static @Nullable Step firstPlannedStep(final Result result) {
        Path path = result.path();
        if (path == null) {
            return null;
        }
        for (int i = 0; i < path.getNodeCount(); i++) {
            BlockPos feet = path.getNode(i).asBlockPos();
            for (BlockPos at : new BlockPos[] { feet, feet.above(), feet.above(2), feet.below() }) {
                BuildWalkNodeEvaluator.Action action = result.evaluator().plannedAt(at);
                if (action != null) {
                    return new Step(at, action);
                }
            }
        }
        return null;
    }

    // ---- obstruction locus ---------------------------------------------------

    /**
     * Which block stopped the search — the honest complement to "where the path stopped"
     * (BOT_SURFACE_DESIGN.md §2.1). {@code end} tells the agent a coordinate it must then survey;
     * this tells it a coordinate it can act on.
     *
     * <p>Method: from the frontier, step one cell toward the goal and report the first cell that is
     * not pathfindable, naming the block, its {@link PathType}, and — the part that turns a report
     * into a plan — whether the profile's rights would have let the solver route through it.
     *
     * @return null when nothing blocks the immediate step (the search died of budget, not geometry)
     */
    public static @Nullable JsonObject obstruction(final Level level, final BlockPos frontier,
                                                   final BlockPos goal, final NavProfile profile) {
        Direction dir = towards(frontier, goal);
        if (dir == null) {
            return null;
        }
        BlockPos feet = frontier.relative(dir);
        BlockPos head = feet.above();
        BlockPos floor = feet.below();

        BlockState feetState = level.getBlockState(feet);
        BlockState headState = level.getBlockState(head);
        BlockState floorState = level.getBlockState(floor);

        if (!feetState.isPathfindable(PathComputationType.LAND)) {
            return describe(level, feet, feetState, "blocked", profile);
        }
        if (!headState.isPathfindable(PathComputationType.LAND)) {
            return describe(level, head, headState, "head_blocked", profile);
        }
        // FLUIDS FIRST — before the gap test. Water is pathfindable for LAND, so a lake used to fall
        // straight through to `no_floor` and be reported as "a gap: re-run with may_modify place|both
        // to bridge it". A lake and a ravine were literally the same answer, and the remedy told the
        // body to bridge a lake it could have swum (PERCEPTION_NAV_FIXES §2). Naming the fluid is what
        // lets the caller choose between swimming, routing around, and refusing.
        if (!feetState.getFluidState().isEmpty()) {
            return fluid(level, feet, feetState, "fluid_ahead", profile);
        }
        if (!floorState.getFluidState().isEmpty()) {
            return fluid(level, floor, floorState, "fluid_below", profile);
        }
        if (floorState.isPathfindable(PathComputationType.LAND)) {
            JsonObject o = describe(level, floor, floorState, "no_floor", profile);
            o.addProperty("remedy", profile.canPlace()
                ? "bridgeable — the solver may place here"
                : "a gap: re-run with may_modify place|both to bridge it");
            return o;
        }
        return null;
    }

    /**
     * Describe a cell the caller ALREADY KNOWS stopped it — the counterpart to {@link #obstruction},
     * which derives the cell by stepping one from a frontier.
     *
     * <p>Callers that hold the offending cell were using the frontier form and getting a different
     * cell back: it steps again, so passing the blocked cell reported its *neighbour*. The goal loop
     * did exactly this (it passed `cell.below()`), and the result was a stop reason that contradicted
     * the block it named — `fluid_ahead` against diggable dirt. `08ef510b` believed the reason,
     * concluded the shaft was flooded, abandoned the dig and lost its iron tier
     * (PERCEPTION_NAV_FIXES §3).
     *
     * @return null when this cell does not in fact obstruct anything
     */
    public static @Nullable JsonObject obstructionOf(final Level level, final BlockPos at,
                                                     final NavProfile profile) {
        BlockState state = level.getBlockState(at);
        if (!state.getFluidState().isEmpty()) {
            return fluid(level, at, state, "fluid_ahead", profile);
        }
        if (!state.isPathfindable(PathComputationType.LAND)) {
            return describe(level, at, state, "blocked", profile);
        }
        // The cell itself is enterable, so what stopped the body is under it.
        BlockPos floor = at.below();
        BlockState floorState = level.getBlockState(floor);
        if (!floorState.getFluidState().isEmpty()) {
            return fluid(level, floor, floorState, "fluid_below", profile);
        }
        if (floorState.isPathfindable(PathComputationType.LAND)) {
            JsonObject o = describe(level, floor, floorState, "no_floor", profile);
            o.addProperty("remedy", profile.canPlace()
                ? "bridgeable — the solver may place here"
                : "a gap: re-run with may_modify place|both to bridge it");
            return o;
        }
        return null;
    }

    /**
     * A fluid in the way, named as one. `kind` is `fluid_ahead` when the body would step INTO it and
     * `fluid_below` when it would step over it — the difference between wading and falling in.
     */
    private static JsonObject fluid(final Level level, final BlockPos at, final BlockState state,
                                    final String kind, final NavProfile profile) {
        JsonObject o = describe(level, at, state, kind, profile);
        boolean lava = state.getFluidState().is(net.minecraft.tags.FluidTags.LAVA);
        o.addProperty("fluid", lava ? "lava" : "water");
        if (lava) {
            // Never offer swimming as a remedy for lava, whatever the profile says.
            o.addProperty("remedy", "LAVA — route around it; entering it kills the body");
        } else if (profile.canSwim()) {
            o.addProperty("remedy", "water — the body may swim it; expect air to drain, and surface before it runs out");
        } else {
            o.addProperty("remedy", profile.canPlace()
                ? "water — bridge over it, or re-run with swim:true to cross it"
                : "water — re-run with swim:true to cross it, or with may_modify place|both to bridge over it");
        }
        return o;
    }

    private static JsonObject describe(final Level level, final BlockPos at, final BlockState state,
                                       final String kind, final NavProfile profile) {
        JsonObject o = new JsonObject();
        o.addProperty("x", at.getX());
        o.addProperty("y", at.getY());
        o.addProperty("z", at.getZ());
        o.addProperty("kind", kind);
        o.addProperty("block", net.minecraft.core.registries.BuiltInRegistries.BLOCK
            .getKey(state.getBlock()).toString());
        PathType type = BuildWalkNodeEvaluator.pathTypeAt(level, at);
        o.addProperty("path_type", type.name());

        // Name the remedy in the caller's terms — this is what saves the follow-up survey turn.
        if (state.getBlock() instanceof DoorBlock) {
            boolean iron = type == PathType.DOOR_IRON_CLOSED;
            if (iron) {
                // Not "give up" — an iron door opens from a redstone control. Locate the nearest one
                // and name it, so the agent (or a future sub-goal) can go activate it.
                BlockPos control = findControl(level, at);
                if (control != null) {
                    o.addProperty("remedy", "iron door — activate its control (a "
                        + net.minecraft.core.registries.BuiltInRegistries.BLOCK
                            .getKey(level.getBlockState(control).getBlock()).getPath()
                        + ") at " + control.getX() + "," + control.getY() + "," + control.getZ());
                    JsonObject c = new JsonObject();
                    c.addProperty("x", control.getX());
                    c.addProperty("y", control.getY());
                    c.addProperty("z", control.getZ());
                    o.add("control", c);
                } else {
                    o.addProperty("remedy", "iron door — no button/lever/plate found nearby; "
                        + "it needs a redstone control this search could not locate");
                }
            } else {
                o.addProperty("remedy", profile.canOpenDoors()
                    ? "wooden door — the body may open it"
                    : "wooden door — re-run with open_doors:true");
            }
        } else if (!"no_floor".equals(kind) && !kind.startsWith("fluid")) {
            float hardness = state.getDestroySpeed(level, at);
            if (hardness < 0.0F) {
                o.addProperty("remedy", "unbreakable — route around it");
            } else {
                o.addProperty("remedy", profile.canBreak()
                    ? "breakable — the solver may mine here"
                    : "breakable: re-run with may_modify break|both to mine through");
            }
        }
        return o;
    }

    /**
     * The nearest redstone control (lever / button / pressure plate) to an iron door, searched in a
     * small box around it. This is a PROXIMITY heuristic, not a wiring trace — it finds a control that
     * plausibly opens this door, not a proven one; the honest word for the caller is "activate this,"
     * and if it is the wrong control the door simply stays shut and the goal reports that. A full
     * redstone-graph trace is a deeper feature (BOT_SURFACE_DESIGN.md §10 slice 3).
     */
    private static @Nullable BlockPos findControl(final Level level, final BlockPos door) {
        int r = 3;
        BlockPos best = null;
        double bestSq = Double.MAX_VALUE;
        for (BlockPos p : BlockPos.betweenClosed(door.offset(-r, -r, -r), door.offset(r, r, r))) {
            var block = level.getBlockState(p).getBlock();
            if (block instanceof net.minecraft.world.level.block.LeverBlock
                || block instanceof net.minecraft.world.level.block.ButtonBlock
                || block instanceof net.minecraft.world.level.block.BasePressurePlateBlock) {
                double dSq = p.distSqr(door);
                if (dSq < bestSq) {
                    bestSq = dSq;
                    best = p.immutable();
                }
            }
        }
        return best;
    }

    /** The dominant horizontal step from {@code a} toward {@code b}, or null if they are the same column. */
    private static @Nullable Direction towards(final BlockPos a, final BlockPos b) {
        int dx = b.getX() - a.getX();
        int dz = b.getZ() - a.getZ();
        if (dx == 0 && dz == 0) {
            return null;
        }
        return Math.abs(dx) >= Math.abs(dz)
            ? (dx > 0 ? Direction.EAST : Direction.WEST)
            : (dz > 0 ? Direction.SOUTH : Direction.NORTH);
    }
}
