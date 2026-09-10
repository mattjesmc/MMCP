package com.mattmc.mcptoolkit.nav;

import it.unimi.dsi.fastutil.longs.Long2ObjectMap;
import it.unimi.dsi.fastutil.longs.Long2ObjectOpenHashMap;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.block.DoorBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.pathfinder.Node;
import net.minecraft.world.level.pathfinder.PathComputationType;
import net.minecraft.world.level.pathfinder.PathType;
import org.jspecify.annotations.Nullable;

/**
 * A {@link WalkNodeEvaluator} (our body-agnostic copy) that can also route through blocks it intends
 * to <b>break</b>, over gaps it intends to <b>bridge</b>, and through doors it intends to <b>open</b>
 * — the build-aware pathfinder of BOT_SURFACE_DESIGN.md §1.
 *
 * <p><b>The tractability rule (§1.3): mutation is an edge, not a state.</b> The naive framing — search
 * over (position × world-mutation) — has an unbounded state space. This does not do that. The search
 * state stays {@code (x,y,z)}; {@link #getNeighbors} simply emits neighbour nodes that <em>do not exist
 * yet</em>, each tagged in {@link #plan} with the action needed to make it exist. No combinatorial
 * blowup, and it fits vanilla's {@code getNeighbors} contract unchanged.
 *
 * <p>The price is <b>optimism</b>: the search assumes bridging material lasts and breaks succeed, and
 * it does not know which of several candidate paths will actually be walked, so it cannot enforce a
 * budget during the search (a node explored is not a node committed). Budgets are enforced in two
 * honest places instead: a zero budget emits no edges of that kind at all, and after the solve the
 * COMMITTED plan (the winning path's edges only — see {@link #commitPlan}) is counted against the
 * budgets by {@link NavSolver.Result#overBudget}, so prediction can say "a route exists but not
 * under this budget" instead of promising what execution will refuse. Execution re-checks for real
 * as it goes and reports what it actually did in the ledger. That is the succeeds-falsely doctrine
 * doing structural work: the optimism is disclosed, not hidden.
 *
 * <p><b>Cost currency.</b> {@code PathFinder} computes {@code g = parent.g + distance + costMalus},
 * where {@code distance} is in blocks — so {@code costMalus} must be in <em>block-equivalents</em>,
 * not raw ticks. Action costs are estimated in ticks (reusing the same hardness model as
 * {@code bot_mine}'s {@code eta_ticks}, so the solver and the hands agree) and divided by
 * {@link #TICKS_PER_BLOCK}. A stone break (~15 ticks) therefore costs about 3 blocks of detour, which
 * is the trade the agent would make by hand.
 *
 * <p><b>The shared cache is never written.</b> {@code PathfindingContext} resolves path types through
 * {@code ServerLevel.getPathTypeCache()}, which belongs to the server and every mob on it. This class
 * only ever reads it; "this will be air once I mine it" stays local to {@link #plan}.
 */
public final class BuildWalkNodeEvaluator extends WalkNodeEvaluator {

    /**
     * What the body must do to reach a planned node. JUMP spends nothing; PILLAR and PLACE both spend a
     * placed block (PILLAR is the vertical variant — a block dropped underfoot and climbed onto);
     * BREAK/stair-mine spend a mined block; the rest modify the world.
     */
    public enum Action { BREAK, PLACE, OPEN_DOOR, JUMP, PILLAR }

    /** Rough walk speed used to convert action ticks into the A*'s block-distance currency. */
    private static final float TICKS_PER_BLOCK = 5.0F;
    /** Same hardness→ticks model as {@code DroneHands}' dig, so solver and hands agree on effort. */
    private static final float DIG_TICKS_PER_HARDNESS = 10.0F;
    /** Placing a block: the swing itself is cheap; the surcharge discourages gratuitous bridging. */
    private static final float PLACE_TICKS = 10.0F;
    /** Opening a door is nearly free, but not free — prefer a genuinely open route. */
    private static final float DOOR_TICKS = 5.0F;
    /** Never plan a break costing more than this in block-equivalents (obsidian and friends). */
    private static final float MAX_BREAK_COST = 40.0F;
    /** A jump's surcharge beyond the distance it already covers: tiny, so a jump beats bridging a gap
     * (which costs place-ticks per cell) but a same-length flat walk is still preferred. */
    private static final float JUMP_SURCHARGE = 0.5F;
    /** Pillar-up: a place plus the jump-and-climb around it. Priced well above a flat step so A* only
     * towers out of a genuine pit — never as a shortcut when a same-Y walk or bridge would do. */
    private static final float PILLAR_TICKS = 20.0F;
    /**
     * Surcharge on a MINED descent, beyond the break itself. Small: going down through stone is a
     * normal way to travel when down is where the goal is (§12.5). It exists only so that, between two
     * routes of equal length, the one that does not rearrange the world wins.
     */
    private static final float DESCENT_SURCHARGE = 1.0F;
    /**
     * Surcharge for a cell crossed by SWIMMING, in block-equivalents. Swimming is roughly half walk
     * speed, so a wet cell costs about a cell of detour — enough that a dry route of similar length
     * wins, far too little to justify vanilla's {@link PathType#WATER} malus of 8, which is a
     * "land mob, stay out" number and would refuse every crossing a swimmer should make.
     */
    private static final float SWIM_MALUS = 1.0F;
    /**
     * Extra surcharge for a cell where the HEAD is under water — the cells that actually spend air.
     * At full breath it is a mild preference for surface routes; {@link #AIR_PRESSURE} multiplies it
     * as breath runs down.
     */
    private static final float SUBMERGED_MALUS = 1.5F;
    /**
     * How hard an empty lung pushes the route back to the surface. The submerged surcharge is scaled
     * by {@code 1 + AIR_PRESSURE * (1 - airFraction)}, so a full body barely notices and a nearly
     * drowned one will pay a long detour to breathe. This is the SEARCH's half of air management —
     * it biases the route; {@link SwimControl} enforces the real budget on the live body, because
     * only the body knows what it has actually spent.
     */
    private static final float AIR_PRESSURE = 4.0F;

    private final NavProfile profile;

    /** One planned work cell attached to an edge (parent node → child node). */
    private record Work(long cell, Action action) {}

    /** The work one specific parent→child edge requires; a child can be entered from many parents. */
    private static final class EdgeWork {
        final long parent;
        final java.util.List<Work> cells = new java.util.ArrayList<>(2);

        EdgeWork(final long parent) {
            this.parent = parent;
        }
    }

    /**
     * Work recorded PER EDGE while the search explores, keyed by the child node's
     * {@link BlockPos#asLong}. Most explored edges lose; only {@link #commitPlan} decides which
     * entries were actually chosen. Deliberately NOT cleared in {@link #done()} — {@code
     * PathFinder.findPath} calls {@code done()} before returning, and this has to outlive the search
     * for the caller to commit the plan off the returned path.
     */
    private final Long2ObjectMap<java.util.List<EdgeWork>> edgeWork = new Long2ObjectOpenHashMap<>();

    /**
     * The COMMITTED plan: work on the winning path's edges only, keyed by cell. Empty until
     * {@link #commitPlan} runs. The old form of this map accumulated every explored candidate —
     * which let a BREAK planned by a rejected branch, at a cell the winning route merely passes
     * (its floor, say), drive execution into mining the floor out from under its own path.
     */
    private final Long2ObjectMap<Action> plan = new Long2ObjectOpenHashMap<>();

    /**
     * Cells whose floor is a block the search PLANNED to place beneath them — the landing of a
     * {@link Action#PILLAR} edge. {@link #hasFloorBelow} reads the world, and the world does not yet
     * contain the pillar; without this a body could pillar exactly ONCE and then stand on a cell that
     * looks unsupported, so no second pillar was ever generated and towering out of anything deeper
     * than one block was unreachable (live-caught by {@code walker-vert}'s 4-deep pit, 0.26.0).
     *
     * <p>Chains stay physically sound because the FIRST pillar of any chain still requires a real
     * {@link #hasFloorBelow}: support grounds out on real terrain by induction. Entries from losing
     * branches are harmless for the same reason — every one of them is a cell some branch proved
     * placeable over supported ground, and only {@link #commitPlan} decides what execution performs.
     */
    private final it.unimi.dsi.fastutil.longs.LongSet pillarSupported =
        new it.unimi.dsi.fastutil.longs.LongOpenHashSet();

    public BuildWalkNodeEvaluator(final NavProfile profile) {
        this.profile = profile;
        profile.applyTo(this);
    }

    /** The profile this evaluator plans under (for budget post-checks on the committed plan). */
    public NavProfile profile() {
        return profile;
    }

    /** The action committed for a position, or null if the body can simply walk it. Valid after
     * {@link #commitPlan}. */
    public @Nullable Action plannedAt(final BlockPos pos) {
        return plan.get(pos.asLong());
    }

    /** Every position the COMMITTED plan modifies (valid after {@link #commitPlan}). */
    public Long2ObjectMap<Action> plan() {
        return plan;
    }

    /** How many committed cells carry {@code action} (valid after {@link #commitPlan}). */
    public int planned(final Action action) {
        int n = 0;
        for (Action a : plan.values()) {
            if (a == action) {
                n++;
            }
        }
        return n;
    }

    /**
     * Filter the per-edge work down to the edges actually ON {@code path}. Called by every solve
     * owner ({@link NavSolver#solve}, the walker façade's bridge) right after {@code findPath}
     * returns; until then {@link #plan()} is empty. A null or empty path commits nothing — no route
     * means no work, honestly.
     */
    public void commitPlan(final net.minecraft.world.level.pathfinder.@Nullable Path path) {
        plan.clear();
        if (path == null) {
            return;
        }
        for (int i = 1; i < path.getNodeCount(); i++) {
            Node parent = path.getNode(i - 1);
            Node child = path.getNode(i);
            java.util.List<EdgeWork> candidates = edgeWork.get(BlockPos.asLong(child.x, child.y, child.z));
            if (candidates == null) {
                continue;
            }
            long parentKey = BlockPos.asLong(parent.x, parent.y, parent.z);
            for (EdgeWork e : candidates) {
                if (e.parent == parentKey) {
                    for (Work w : e.cells) {
                        plan.put(w.cell(), w.action());
                    }
                    break;
                }
            }
        }
    }

    /** Record {@code action} at {@code cell} against the (parent → child) edge that needs it. */
    private void record(final Node parent, final long child, final long cell, final Action action) {
        long parentKey = BlockPos.asLong(parent.x, parent.y, parent.z);
        java.util.List<EdgeWork> list = edgeWork.computeIfAbsent(child, k -> new java.util.ArrayList<>(2));
        EdgeWork mine = null;
        for (EdgeWork e : list) {
            if (e.parent == parentKey) {
                mine = e;
                break;
            }
        }
        if (mine == null) {
            mine = new EdgeWork(parentKey);
            list.add(mine);
        }
        for (Work w : mine.cells) {
            if (w.cell() == cell && w.action() == action) {
                return; // re-expansion of the same edge; don't double-record
            }
        }
        mine.cells.add(new Work(cell, action));
    }

    /**
     * Water is traversable exactly when the profile grants the swim right (§12.4). This one override
     * flips vanilla's whole amphibious branch: {@code findAcceptedNode} stops diverting water cells
     * through {@code tryFindFirstNonWaterBelow} — i.e. stops planning a walk along the seabed, which
     * for a body that breathes is a drowning route dressed as a path.
     */
    @Override
    protected boolean isAmphibious() {
        return profile.canSwim();
    }

    /**
     * A swimming body starts where it actually IS. Vanilla's {@code getStart} assumes a floating body
     * wants the surface (it climbs to the top of the water column) and, for a body it thinks cannot
     * float, scans DOWN through the water — which is pathfindable — all the way to the seabed. Either
     * way a submerged body's start node lands metres from its real position, so waypoint zero is
     * unreachable and the follower stalls on the first tick. That was one half of the live hang.
     */
    @Override
    public Node getStart() {
        if (profile.canSwim() && this.mob.isInWater()) {
            return this.getStartNode(this.mob.blockPosition());
        }
        return super.getStart();
    }

    @Override
    public int getNeighbors(final Node[] neighbors, final Node pos) {
        int p = super.getNeighbors(neighbors, pos);

        // Swimming adds the axis walking does not have. Vertical edges FIRST, so they are in the
        // array before the water pricing pass below reaches them.
        if (profile.canSwim()) {
            for (int dy : new int[] { 1, -1 }) {
                if (p >= neighbors.length) {
                    break;
                }
                Node swim = swimNode(pos, dy);
                if (swim != null && !swim.closed && !contains(neighbors, p, swim.x, swim.y, swim.z)) {
                    neighbors[p++] = swim;
                }
            }
            priceWater(neighbors, p);
        } else {
            p = refuseWater(neighbors, p);
        }

        // Closed wooden doors the search routes through are WORK, not free passage. With door rights
        // the vanilla evaluator retypes DOOR_WOOD_CLOSED to WALKABLE_DOOR and routes it — which is a
        // prediction; a body without a vanilla door-opening AI goal walks INTO the shut door and
        // stalls. Recording the cell as OPEN_DOOR is what lets the goal loop actually open it
        // (GoalRunner's repair), the same optimism-reconciled-at-execution contract as BREAK/PLACE.
        for (int i = 0; i < p; i++) {
            Node n = neighbors[i];
            if (n != null && n.type == PathType.WALKABLE_DOOR) {
                long key = BlockPos.asLong(n.x, n.y, n.z);
                record(pos, key, key, Action.OPEN_DOOR);
                n.costMalus = Math.max(n.costMalus, DOOR_TICKS / TICKS_PER_BLOCK);
            }
        }

        // Sprint-jump edges first: a movement capability (no blocks), so they apply to EVERY profile,
        // and being cheaper than any bridge they make A* leap a gap instead of filling it. Only from
        // a genuine standing node — you cannot jump off air.
        if (profile.canSprintJump() && hasFloorBelow(pos.x, pos.y, pos.z)) {
            for (Direction dir : Direction.Plane.HORIZONTAL) {
                if (p >= neighbors.length) {
                    break;
                }
                Node jump = jumpNode(pos, dir);
                if (jump != null && !jump.closed && !contains(neighbors, p, jump.x, jump.y, jump.z)) {
                    neighbors[p++] = jump;
                }
            }
        }

        if (!profile.modifiesWorld()) {
            return p;
        }
        for (Direction dir : Direction.Plane.HORIZONTAL) {
            if (p >= neighbors.length) {
                break;
            }
            int nx = pos.x + dir.getStepX();
            int nz = pos.z + dir.getStepZ();
            // Only consider cells vanilla could NOT already route to — never shadow a legal move.
            if (contains(neighbors, p, nx, pos.y, nz)) {
                continue;
            }
            Node planned = planNode(pos, nx, pos.y, nz);
            if (planned != null && !planned.closed) {
                neighbors[p++] = planned;
            }
        }

        // The VERTICAL edge class (BOT_SURFACE_DESIGN.md §12.2): same-Y break/place cannot express a
        // body climbing OUT of a pit, so a fallen walker with a full inventory was honestly stuck.
        // Only from a genuine standing node (you cannot pillar off air) — hasFloorBelow gates both,
        // counting a pillar this search already planned underfoot as the floor it will be.
        if (hasFloorBelow(pos.x, pos.y, pos.z) || standsOnPlannedPillar(pos)) {
            if (p < neighbors.length) {
                Node pillar = pillarNode(pos);
                if (pillar != null && !pillar.closed
                    && !contains(neighbors, p, pillar.x, pillar.y, pillar.z)) {
                    neighbors[p++] = pillar;
                }
            }
            for (Direction dir : Direction.Plane.HORIZONTAL) {
                if (p >= neighbors.length) {
                    break;
                }
                Node stair = stairUpNode(pos, dir);
                if (stair != null && !stair.closed
                    && !contains(neighbors, p, stair.x, stair.y, stair.z)) {
                    neighbors[p++] = stair;
                }
            }
            // ...and the DESCENT half (§12.5). Vanilla already routes a body DOWN through open air
            // (tryFindFirstGroundNodeBelow), so the only unrepresented descent was the one through
            // SOLID ground — which made every "go deeper" goal answer unreachable and cost the agent
            // a call per level, mining by hand. Both edges are gated on standing on a real floor,
            // which is the same block dig-down is about to break.
            if (p < neighbors.length) {
                Node shaft = digDownNode(pos);
                if (shaft != null && !shaft.closed
                    && !contains(neighbors, p, shaft.x, shaft.y, shaft.z)) {
                    neighbors[p++] = shaft;
                }
            }
            for (Direction dir : Direction.Plane.HORIZONTAL) {
                if (p >= neighbors.length) {
                    break;
                }
                Node down = stairDownNode(pos, dir);
                if (down != null && !down.closed
                    && !contains(neighbors, p, down.x, down.y, down.z)) {
                    neighbors[p++] = down;
                }
            }
        }
        return p;
    }

    /**
     * A PILLAR-UP edge: drop a block into the body's own feet cell and jump onto it, rising one block
     * in the same column — the escape from a pit no same-Y bridge can solve. Needs place rights + a
     * live budget and the block's support (the parent's floor, gated by the caller's
     * {@code hasFloorBelow}). The two cells the body climbs into — {@code y+1} (new feet) and
     * {@code y+2} (new head, also the jump apex) — are clear, OR, with break rights, MINED first:
     * that combination is the mine-up edge, the only way a roofed body rises through solid rock
     * (BREAKs recorded alongside the PILLAR; the goal loop clears the ceiling before it launches).
     * Modest jump only, so the head never rises past {@code y+2}. The placed block lands in the
     * parent cell {@code (x,y,z)} — recorded as {@link Action#PILLAR} so the goal loop actuates the
     * jump-and-place rather than walking to a side cell.
     */
    private @Nullable Node pillarNode(final Node from) {
        if (!profile.canPlace() || profile.placeBudget() <= 0) {
            return null;
        }
        int x = from.x;
        int y = from.y;
        int z = from.z;
        BlockPos climb = new BlockPos(x, y + 1, z);
        BlockPos apex = new BlockPos(x, y + 2, z);
        BlockState climbState = this.currentContext.getBlockState(climb);
        BlockState apexState = this.currentContext.getBlockState(apex);
        boolean climbClear = climbState.isPathfindable(PathComputationType.LAND);
        boolean apexClear = apexState.isPathfindable(PathComputationType.LAND);
        float mineTicks = 0.0F;
        if (!climbClear || !apexClear) {
            // MINE-UP (w2-79881): with a solid ceiling this edge used to refuse, and NO other edge
            // broke upward — so from a roofed tunnel, may_modify:"both" could mine along and down
            // but never rise, every route to the surface answered `unreachable`, and a body 80
            // blocks deep was one-way-trapped. With break rights the ceiling is work, not a wall.
            if (!profile.canBreak() || profile.breakBudget() <= 0) {
                return null;
            }
            if (!safeToBreachCeiling(x, y + 2, z)) {
                return null; // lava on a face, or a falling column poised above the opening
            }
            BlockGetter level = this.currentContext.level();
            if (!climbClear) {
                float c = breakTicks(level, climb, climbState);
                if (c < 0) {
                    return null;
                }
                mineTicks += c;
            }
            if (!apexClear) {
                float c = breakTicks(level, apex, apexState);
                if (c < 0) {
                    return null;
                }
                mineTicks += c;
            }
            if (mineTicks / TICKS_PER_BLOCK > MAX_BREAK_COST) {
                return null;
            }
        }
        long childKey = BlockPos.asLong(x, y + 1, z);
        if (!climbClear) {
            record(from, childKey, climb.asLong(), Action.BREAK);
        }
        if (!apexClear) {
            record(from, childKey, apex.asLong(), Action.BREAK);
        }
        record(from, childKey, BlockPos.asLong(x, y, z), Action.PILLAR);
        // The child stands on the block this edge places — remember that, or the next expansion of
        // this node reads the (still empty) world and refuses to pillar again.
        pillarSupported.add(childKey);
        Node n = this.getNode(x, y + 1, z);
        n.type = PathType.OPEN;
        n.costMalus = Math.max(n.costMalus, (PILLAR_TICKS + mineTicks) / TICKS_PER_BLOCK);
        return n;
    }

    /**
     * A STAIR-MINE edge: step up one block in {@code dir}, cutting away the feet/head cells that block
     * the ascent — the break-rights sibling of pillar-up. Needs break rights + a live budget and a
     * SOLID step to climb onto at {@code (nx, y, nz)} (you cannot mine a stair out of thin air). Apex
     * headroom over the take-off column ({@code (x, y+2, z)}) is clear or MINED like the rest — inside
     * solid rock these edges chain into the 1-wide staircase a human digs, which is how an ascent
     * through stone finally beats an 80-pillar tower on cost. The mined cells are recorded as plain
     * {@link Action#BREAK}: once cleared the ledge is an ordinary 1-block step-up the driver already
     * climbs, so no new actuation is needed — the search edge is the whole addition.
     */
    private @Nullable Node stairUpNode(final Node from, final Direction dir) {
        if (!profile.canBreak() || profile.breakBudget() <= 0) {
            return null;
        }
        int x = from.x;
        int y = from.y;
        int z = from.z;
        // Apex headroom over the take-off column: clear, or MINED — this is the other half of the
        // mine-up fix (w2-79881). Requiring it pre-clear meant no stair could ever START inside
        // solid rock, so the staircase a human digs to the surface had no edge to chain from.
        BlockPos apex = new BlockPos(x, y + 2, z);
        BlockState apexState = this.currentContext.getBlockState(apex);
        boolean apexClear = apexState.isPathfindable(PathComputationType.LAND);
        BlockGetter level = this.currentContext.level();
        float ticks = 0.0F;
        if (!apexClear) {
            if (!safeToBreachCeiling(x, y + 2, z)) {
                return null;
            }
            float c = breakTicks(level, apex, apexState);
            if (c < 0) {
                return null;
            }
            ticks += c;
        }
        int nx = x + dir.getStepX();
        int nz = z + dir.getStepZ();
        if (!hasFloorBelow(nx, y + 1, nz)) {
            return null; // nothing solid at (nx,y,nz) to climb onto
        }
        BlockPos feet = new BlockPos(nx, y + 1, nz);
        BlockPos head = new BlockPos(nx, y + 2, nz);
        BlockState feetState = this.currentContext.getBlockState(feet);
        BlockState headState = this.currentContext.getBlockState(head);
        boolean feetClear = feetState.isPathfindable(PathComputationType.LAND);
        boolean headClear = headState.isPathfindable(PathComputationType.LAND);
        if (feetClear && headClear && apexClear) {
            return null; // nothing to mine — vanilla's step-up already routes this ledge
        }
        if (!feetClear) {
            float c = breakTicks(level, feet, feetState);
            if (c < 0) {
                return null;
            }
            ticks += c;
        }
        if (!headClear) {
            // The head cell is the top of ITS column too — opening it exposes (nx, y+3, nz).
            if (!safeToBreachCeiling(nx, y + 2, nz)) {
                return null;
            }
            float c = breakTicks(level, head, headState);
            if (c < 0) {
                return null;
            }
            ticks += c;
        }
        float cost = ticks / TICKS_PER_BLOCK;
        if (cost > MAX_BREAK_COST) {
            return null;
        }
        long childKey = BlockPos.asLong(nx, y + 1, nz);
        if (!apexClear) {
            record(from, childKey, apex.asLong(), Action.BREAK);
        }
        if (!feetClear) {
            record(from, childKey, feet.asLong(), Action.BREAK);
        }
        if (!headClear) {
            record(from, childKey, head.asLong(), Action.BREAK);
        }
        Node n = this.getNode(nx, y + 1, nz);
        n.type = PathType.OPEN;
        n.costMalus = Math.max(n.costMalus, cost + JUMP_SURCHARGE); // + the step-up itself
        return n;
    }

    /**
     * A running-jump edge across a gap in {@code dir}, or null if none is possible. The landing must be
     * a real standing cell (floor below, 2-high clearance), the span between must be a genuine gap
     * (else vanilla already walks it), and the whole arc needs APEX headroom — a sprint-jump lifts a
     * full-height body into the {@code y+2} layer, so every cell of the arc (take-off included) must
     * be clear three high, not two. Under a 2-high roof the body bonks and undershoots into the gap;
     * planning that jump was a live-risk prediction/execution divergence on the roofed bench courses.
     * Same Y only in v1 — vanilla already handles single drops, and an up-jump is not a sprint-jump.
     */
    private @Nullable Node jumpNode(final Node from, final Direction dir) {
        int y = from.y;
        if (!clear(from.x, y + 2, from.z)) {
            return null; // no apex headroom over the take-off cell itself
        }
        // The first cell ahead must itself be a gap — if it were standable, vanilla already routed it
        // and this is not a jump.
        int fx = from.x + dir.getStepX();
        int fz = from.z + dir.getStepZ();
        if (hasFloorBelow(fx, y, fz) || !clear(fx, y, fz) || !clear(fx, y + 1, fz)
            || !clear(fx, y + 2, fz)) {
            return null; // not a gap, or blocked headroom right off the take-off
        }
        for (int d = 2; d <= profile.maxJumpGap(); d++) {
            int lx = from.x + dir.getStepX() * d;
            int lz = from.z + dir.getStepZ() * d;
            int mx = from.x + dir.getStepX() * (d - 1);
            int mz = from.z + dir.getStepZ() * (d - 1);
            // Every intermediate cell must be an open gap (feet + head + apex clear, no floor) — a
            // wall or a low roof in the arc stops the jump.
            if (hasFloorBelow(mx, y, mz) || !clear(mx, y, mz) || !clear(mx, y + 1, mz)
                || !clear(mx, y + 2, mz)) {
                return null;
            }
            // Landing: standable (floor below, feet + head clear) with apex headroom (the body is
            // still descending through y+2 as it comes in).
            if (hasFloorBelow(lx, y, lz) && clear(lx, y, lz) && clear(lx, y + 1, lz)
                && clear(lx, y + 2, lz)) {
                long key = new BlockPos(lx, y, lz).asLong();
                record(from, key, key, Action.JUMP);
                Node n = this.getNode(lx, y, lz);
                n.type = PathType.WALKABLE;
                n.costMalus = Math.max(n.costMalus, JUMP_SURCHARGE);
                return n;
            }
        }
        return null;
    }

    /**
     * A DIG-DOWN edge (§12.5): break the floor underfoot and drop into its cell — the mirror of
     * {@link #pillarNode}, and the descent a strip-mining body actually wants.
     *
     * <p>Like {@link #stairUpNode} the work is recorded as a plain {@link Action#BREAK}, so no new
     * actuation is needed anywhere: the goal loop mines the cell it already knows how to mine, gravity
     * does the rest, and the next tick re-navigates from one block lower. That is the whole reason
     * this is a search-side change only.
     *
     * <p><b>The cell must have a floor of its own</b> ({@code y-2} solid) — otherwise this is not a
     * step down but the top of a shaft, and the body would drop an unknown distance onto whatever is
     * at the bottom. And it must not breach lava: digging straight down into it is the classic way to
     * die mining, so {@link #safeToBreach} refuses rather than pricing it.
     */
    private @Nullable Node digDownNode(final Node from) {
        if (!profile.canBreak() || profile.breakBudget() <= 0) {
            return null;
        }
        int x = from.x;
        int y = from.y;
        int z = from.z;
        BlockPos floor = new BlockPos(x, y - 1, z);
        BlockState floorState = this.currentContext.getBlockState(floor);
        if (floorState.isPathfindable(PathComputationType.LAND)) {
            return null; // already open — vanilla's own descent handles an air drop
        }
        if (!hasFloorBelow(x, y - 1, z) || !safeToBreach(x, y - 1, z)) {
            return null;
        }
        float ticks = breakTicks(this.currentContext.level(), floor, floorState);
        if (ticks < 0) {
            return null;
        }
        float cost = ticks / TICKS_PER_BLOCK;
        if (cost > MAX_BREAK_COST) {
            return null;
        }
        long childKey = BlockPos.asLong(x, y - 1, z);
        record(from, childKey, floor.asLong(), Action.BREAK);
        Node n = this.getNode(x, y - 1, z);
        n.type = PathType.OPEN;
        n.costMalus = Math.max(n.costMalus, cost + DESCENT_SURCHARGE);
        return n;
    }

    /**
     * A STAIR-DOWN edge (§12.5): descend one level and move one cell across, cutting whatever blocks
     * the way — the staircase a human miner digs, and the break-rights mirror of {@link #stairUpNode}.
     *
     * <p>Preferred over {@link #digDownNode} by A* whenever both reach, because a diagonal descent
     * leaves a walkable route back up while a vertical shaft does not — the search does not model
     * "can I get home", but the staircase's cost naturally comes out similar and its edges chain into
     * an actual staircase.
     */
    private @Nullable Node stairDownNode(final Node from, final Direction dir) {
        if (!profile.canBreak() || profile.breakBudget() <= 0) {
            return null;
        }
        int y = from.y;
        int nx = from.x + dir.getStepX();
        int nz = from.z + dir.getStepZ();
        // Landing: feet at y-1, head at y, standing on y-2.
        if (!hasFloorBelow(nx, y - 1, nz) || !safeToBreach(nx, y - 1, nz)) {
            return null;
        }
        BlockGetter level = this.currentContext.level();
        BlockPos feet = new BlockPos(nx, y - 1, nz);
        BlockPos head = new BlockPos(nx, y, nz);
        BlockState feetState = this.currentContext.getBlockState(feet);
        BlockState headState = this.currentContext.getBlockState(head);
        boolean feetClear = feetState.isPathfindable(PathComputationType.LAND);
        boolean headClear = headState.isPathfindable(PathComputationType.LAND);
        if (feetClear && headClear) {
            return null; // nothing to mine — vanilla's step-down already routes this
        }
        float ticks = 0.0F;
        if (!feetClear) {
            float c = breakTicks(level, feet, feetState);
            if (c < 0) {
                return null;
            }
            ticks += c;
        }
        if (!headClear) {
            float c = breakTicks(level, head, headState);
            if (c < 0) {
                return null;
            }
            ticks += c;
        }
        float cost = ticks / TICKS_PER_BLOCK;
        if (cost > MAX_BREAK_COST) {
            return null;
        }
        long childKey = BlockPos.asLong(nx, y - 1, nz);
        if (!feetClear) {
            record(from, childKey, feet.asLong(), Action.BREAK);
        }
        if (!headClear) {
            record(from, childKey, head.asLong(), Action.BREAK);
        }
        Node n = this.getNode(nx, y - 1, nz);
        n.type = PathType.OPEN;
        n.costMalus = Math.max(n.costMalus, cost + DESCENT_SURCHARGE);
        return n;
    }

    /**
     * Is it safe to open {@code (x,y,z)}? Refuses when any face of the cell touches LAVA — breaking
     * into a lava pocket is the classic way a descending miner dies, and it is not a cost to price
     * but an edge not to emit. Water is deliberately allowed: it floods, which is survivable, and
     * with the swim right (§12.4) it is a medium the body can leave under its own power.
     */
    private boolean safeToBreach(final int x, final int y, final int z) {
        for (Direction d : Direction.values()) {
            BlockPos side = new BlockPos(x + d.getStepX(), y + d.getStepY(), z + d.getStepZ());
            if (this.currentContext.getBlockState(side).getFluidState()
                    .is(net.minecraft.tags.FluidTags.LAVA)) {
                return false;
            }
        }
        return true;
    }

    /**
     * Is it safe to open a CEILING cell? {@link #safeToBreach}'s lava test (all faces — which
     * covers the cell above), plus the upward-specific hazard: an unsupported falling column
     * (sand, gravel) directly above the opening pours down onto the body the moment the ceiling
     * goes. Like lava, that is an edge not to emit, not a cost to price — the server can see it
     * and the body cannot.
     */
    private boolean safeToBreachCeiling(final int x, final int y, final int z) {
        if (!safeToBreach(x, y, z)) {
            return false;
        }
        return !(this.currentContext.getBlockState(new BlockPos(x, y + 1, z)).getBlock()
            instanceof net.minecraft.world.level.block.FallingBlock);
    }

    /**
     * A VERTICAL SWIM edge — the axis a walking search has no way to express. {@code dy} is +1 to rise
     * and -1 to dive.
     *
     * <p>The gating is what keeps this from becoming flight. Rising requires the body to be in water
     * NOW, so the only air cell it can ever reach this way is the one directly above the surface — the
     * breath cell — and from there {@code isWater(from)} is false, so there is no second step up.
     * Diving requires the destination to be water. Both need the two cells the body occupies clear.
     *
     * <p>Cost is the swim surcharge plus whatever air pressure {@link #submergedSurcharge} puts on the
     * destination, so an ascent toward air is priced BELOW a dive at the same depth — the search
     * prefers to breathe, without anything having to tell it to.
     */
    private @Nullable Node swimNode(final Node from, final int dy) {
        int x = from.x;
        int y = from.y + dy;
        int z = from.z;
        boolean fromWater = isWater(from.x, from.y, from.z);
        if (dy > 0) {
            if (!fromWater) {
                return null; // you cannot swim up out of thin air
            }
        } else if (!isWater(x, y, z)) {
            return null; // you cannot dive into something that is not water
        }
        if (!clear(x, y, z) || !clear(x, y + 1, z)) {
            return null; // no room for feet + head
        }
        // NO "already BLOCKED?" guard here: Node.type defaults to PathType.BLOCKED, so a freshly
        // created node always looks blocked and such a check rejects every new edge. Live-caught —
        // it made surface swimming work (those nodes arrive pre-typed from super.getNeighbors) while
        // no dive or ascent edge ever fired, which reads exactly like "the search won't go down".
        // Every other edge builder here sets the type unconditionally; this one now matches.
        Node n = this.getNode(x, y, z);
        n.type = isWater(x, y, z) ? PathType.WATER : PathType.OPEN;
        n.costMalus = Math.max(0.0F, SWIM_MALUS + submergedSurcharge(x, y, z));
        return n;
    }

    /**
     * Re-price water neighbours off vanilla's land-mob malus of 8 and onto the swim model. Applied to
     * every neighbour in the array, not just the vertical ones, because the horizontal water cells
     * come from {@code super.getNeighbors} carrying that 8 — which would make any crossing longer
     * than a couple of cells lose to almost any detour, including ones that do not exist.
     */
    private void priceWater(final Node[] neighbors, final int count) {
        for (int i = 0; i < count; i++) {
            Node n = neighbors[i];
            if (n == null || n.costMalus < 0.0F) {
                continue;
            }
            if (n.type == PathType.WATER || n.type == PathType.WATER_BORDER) {
                n.costMalus = SWIM_MALUS + submergedSurcharge(n.x, n.y, n.z);
            }
        }
    }

    /**
     * Without the swim right, water is not merely EXPENSIVE — it is out of bounds.
     *
     * <p>This is the §2.1 defect, and it was not what the plan expected. The profile is threaded
     * correctly (every goal leg calls {@code writeArgs}, and the start echoes {@code swim:false}); the
     * solver simply never refused water. Two vanilla behaviours let it through:
     *
     * <ul>
     *   <li>a WATER cell keeps vanilla's land-mob malus of <b>8</b> — costly, but passable, so any
     *       crossing shorter than the detour around wins; and</li>
     *   <li>with {@link #isAmphibious()} false, {@code findAcceptedNode} diverts a water cell DOWN to
     *       the first non-water below, so the accepted node sits on the <b>seabed</b> and is typed
     *       WALKABLE. A type-based refusal alone would sail straight past that one.</li>
     * </ul>
     *
     * <p>So the test is positional, not type-based: a node is refused when the body would stand with
     * its feet or its head in water. {@code swim:false} then means what a caller reading it believes
     * it means. Live repro: a 5-wide channel, {@code swim:false}, answered {@code reachable:true,
     * nodes:31} and the body was in the water twelve seconds later — exactly session 983c8359, where
     * it drowned in a flooded cave (probes/swim-rights.test.mjs).
     *
     * <p>The refusal REMOVES the neighbour from the array rather than marking it. Marking was the
     * first attempt and it silently did the opposite: vanilla filters on {@code costMalus >= 0} inside
     * {@code super.getNeighbors}, which has already run by the time this sees the array, so writing
     * {@code -1} afterwards does not discard the node — {@code PathFinder} keeps it, and a negative
     * malus makes water CHEAPER than land. The probe caught it: identical {@code nodes:31} before and
     * after the "fix".
     *
     * @return the new neighbour count
     */
    private int refuseWater(final Node[] neighbors, final int count) {
        int keep = 0;
        for (int i = 0; i < count; i++) {
            Node n = neighbors[i];
            if (n != null && (isWater(n.x, n.y, n.z) || isWater(n.x, n.y + 1, n.z))) {
                continue;
            }
            neighbors[keep++] = n;
        }
        for (int i = keep; i < count; i++) {
            neighbors[i] = null;
        }
        return keep;
    }

    /**
     * The air price of standing at {@code (x,y,z)}: zero unless the body's HEAD cell is under water,
     * and rising sharply as breath runs down (see {@link #AIR_PRESSURE}). A body that never drowns
     * pays nothing, so this is inert for a drowned-proof body rather than being special-cased away.
     */
    private float submergedSurcharge(final int x, final int y, final int z) {
        if (this.mob.canBreatheUnderwater() || !isWater(x, y + 1, z)) {
            return 0.0F; // head in air (or gills): this cell costs no breath
        }
        int max = Math.max(1, this.mob.maxAirSupply());
        float airFraction = Math.max(0.0F, Math.min(1.0F, this.mob.airSupply() / (float) max));
        return SUBMERGED_MALUS * (1.0F + AIR_PRESSURE * (1.0F - airFraction));
    }

    /** Is this cell water the body can swim through? */
    private boolean isWater(final int x, final int y, final int z) {
        return this.currentContext.getBlockState(new BlockPos(x, y, z))
            .getFluidState().is(net.minecraft.tags.FluidTags.WATER);
    }

    /** Is (x,y,z) an open cell a body can occupy (air-like for LAND movement)? */
    private boolean clear(final int x, final int y, final int z) {
        return this.currentContext.getBlockState(new BlockPos(x, y, z)).isPathfindable(PathComputationType.LAND);
    }

    /** Does this cell rest on a block an earlier PILLAR edge in this search planned to place? */
    private boolean standsOnPlannedPillar(final Node pos) {
        return pillarSupported.contains(BlockPos.asLong(pos.x, pos.y, pos.z));
    }

    /** Is there something solid to stand on directly below (x,y,z)? */
    private boolean hasFloorBelow(final int x, final int y, final int z) {
        return !this.currentContext.getBlockState(new BlockPos(x, y - 1, z)).isPathfindable(PathComputationType.LAND);
    }

    /**
     * Can this cell be made walkable by one action? Returns the node (cost already applied) and
     * records the action, or null when no single action helps.
     *
     * <p>Walkability needs three cells: the body's feet {@code (x,y,z)}, its head {@code (x,y+1,z)},
     * and a floor at {@code (x,y-1,z)}. Breaking fixes a blocked feet/head; placing fixes a missing
     * floor. A cell needing both is left alone — a two-action cell is a repair the goal loop can
     * choose to make, not something to hide inside a single edge cost.
     */
    private @Nullable Node planNode(final Node parent, final int x, final int y, final int z) {
        BlockGetter level = this.currentContext.level();
        BlockPos feet = new BlockPos(x, y, z);
        BlockPos head = feet.above();
        BlockPos floor = feet.below();

        BlockState feetState = this.currentContext.getBlockState(feet);
        BlockState headState = this.currentContext.getBlockState(head);
        BlockState floorState = this.currentContext.getBlockState(floor);

        boolean feetClear = feetState.isPathfindable(PathComputationType.LAND);
        boolean headClear = headState.isPathfindable(PathComputationType.LAND);
        boolean hasFloor = !floorState.isPathfindable(PathComputationType.LAND);

        // A closed wooden door is a door problem, not a breaking problem — and it is only a problem
        // at all when the profile withheld door rights (otherwise vanilla's malus already routes it).
        if (feetState.getBlock() instanceof DoorBlock && profile.canOpenDoors()) {
            return null; // vanilla handles it via the malus; nothing to plan
        }

        if (feetClear && headClear && !hasFloor) {
            if (!profile.canPlace() || profile.placeBudget() <= 0) {
                return null; // a zero budget is no rights: prediction must not route what execution refuses
            }
            long childKey = BlockPos.asLong(x, y, z);
            record(parent, childKey, floor.asLong(), Action.PLACE);
            return node(x, y, z, PLACE_TICKS / TICKS_PER_BLOCK);
        }

        if (!feetClear || !headClear) {
            if (!profile.canBreak() || profile.breakBudget() <= 0 || !hasFloor) {
                return null; // no rights/budget, or nothing to stand on even after breaking
            }
            float ticks = 0.0F;
            if (!feetClear) {
                float c = breakTicks(level, feet, feetState);
                if (c < 0) {
                    return null; // unbreakable
                }
                ticks += c;
            }
            if (!headClear) {
                float c = breakTicks(level, head, headState);
                if (c < 0) {
                    return null;
                }
                ticks += c;
            }
            float cost = ticks / TICKS_PER_BLOCK;
            if (cost > MAX_BREAK_COST) {
                return null; // obsidian-grade: routing around is always better than planning this
            }
            // Record both cells when both are blocked — the goal loop has to clear each of them.
            long childKey = BlockPos.asLong(x, y, z);
            if (!feetClear) {
                record(parent, childKey, feet.asLong(), Action.BREAK);
            }
            if (!headClear) {
                record(parent, childKey, head.asLong(), Action.BREAK);
            }
            return node(x, y, z, cost);
        }

        return null;
    }

    private Node node(final int x, final int y, final int z, final float cost) {
        Node n = this.getNode(x, y, z);
        // OPEN is "passable air" — the cell will be walkable once the action has been performed.
        n.type = PathType.OPEN;
        n.costMalus = Math.max(n.costMalus, cost);
        return n;
    }

    /** Estimated dig ticks, or -1 when the block cannot be broken at all. */
    private static float breakTicks(final BlockGetter level, final BlockPos pos, final BlockState state) {
        if (state.isAir()) {
            return 0.0F;
        }
        if (!state.getFluidState().isEmpty()) {
            return -1.0F; // fluids are not a digging problem; let vanilla's malus decide
        }
        float hardness = state.getDestroySpeed(level, pos);
        if (hardness < 0.0F) {
            return -1.0F; // bedrock and friends
        }
        return Math.max(1.0F, hardness * DIG_TICKS_PER_HARDNESS);
    }

    private static boolean contains(final Node[] neighbors, final int count,
                                    final int x, final int y, final int z) {
        for (int i = 0; i < count; i++) {
            Node n = neighbors[i];
            if (n != null && n.x == x && n.y == y && n.z == z) {
                return true;
            }
        }
        return false;
    }

    /** Cost of opening a door, in the A*'s block-distance currency (exposed for the goal loop). */
    public static float doorCost() {
        return DOOR_TICKS / TICKS_PER_BLOCK;
    }

    /**
     * Vanilla's per-position {@link PathType} classification, republished. {@code getPathTypeFromState}
     * is {@code protected static} on {@link WalkNodeEvaluator}, so a subclass is the only place that
     * can hand it to {@link NavSolver}'s obstruction report. Reads only — never touches the server's
     * shared {@code PathTypeCache}.
     */
    public static PathType pathTypeAt(final BlockGetter level, final BlockPos pos) {
        // Same modded-hazard overlay the A* applies in PathfindingContext, from the one definition —
        // so the obstruction report NavSolver builds cannot disagree with the route it explains.
        return com.mattmc.mcptoolkit.McpToolkitTags.hazardOverlay(
            getPathTypeFromState(level, pos), level.getBlockState(pos));
    }
}
