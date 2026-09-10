package com.mattmc.mcptoolkit;

import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.tags.BlockTags;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;

import java.util.ArrayList;
import java.util.List;

/**
 * What a sightline actually finds — PERCEPTION_NAV_FIXES.md §1.1–1.3.
 *
 * <p>The retina used to ask vanilla one question, {@code level.clip(… Block.OUTLINE, Fluid.NONE …)},
 * and take its answer as both "what did I see" and "where does my view end". Those are different
 * questions, and conflating them produced three defects at once across eleven survival sessions:
 *
 * <ul>
 *   <li><b>Fluids were invisible.</b> {@code Fluid.NONE} passes rays through water and lava and
 *       reports the lake bottom, so the body read walkable sand under six feet of water and walked
 *       in. Water appeared in <b>0 of 62</b> scans — including one taken while submerged in an ocean
 *       — and {@code locate what:"water"} could never return anything, so it could not route around
 *       water either.</li>
 *   <li><b>Leaves were opaque.</b> Under {@code OUTLINE} a leaf block is a full cube, so every tree
 *       is a hollow shell with an invisible trunk: <b>0 of 28</b> scans in a spruce taiga ever saw a
 *       {@code spruce_log}. One session mined a leaf, got nothing, and wrote to memory "spruce tree
 *       exhausted" twenty seconds before a close-range ray found a trunk at distance 1, directly
 *       overhead the whole time.</li>
 *   <li><b>Clutter fabricated walls.</b> A grass tuft or a snow layer at the body's feet is a full
 *       {@code OUTLINE} hit, so it ended the sightline: <b>23.3%</b> of all ray hits landed on
 *       walk-through blocks and <b>40.1%</b> of sector horizons died under 2 blocks. Those false
 *       horizons fed {@code open_directions}, {@code least_explored} and the "sealed in rock" render,
 *       so the bot was told it was enclosed while standing in an open field.</li>
 * </ul>
 *
 * <p>So a cell is classified on two independent axes — <b>is it recorded</b> and <b>does it stop the
 * ray</b> — plus a third, whether it counts as the HORIZON (the answer to "how far can I see this
 * way", which is only ever a genuinely opaque wall).
 *
 * <p><b>Classification is derived, never a block allowlist.</b> A hand-written list of "things that
 * are see-through" is unmaintainable and silently wrong for every modded block; these tests are the
 * same properties vanilla itself uses, so a mod's blocks classify themselves. Same reasoning as
 * {@link McpToolkitTags} letting modded fluids join {@code #minecraft:lava}.
 */
public final class Sightlines {
    private Sightlines() {}

    /** How a cell behaves for a sightline. */
    public enum Kind {
        /** Nothing there. Not recorded. */
        AIR(0.0, false, false),
        /** Grass, flowers, torches, rails, crops, cobwebs — no collision at all. Seen, never a wall. */
        CLUTTER(0.0, true, false),
        /** Water and lava: seen AND traversed, so the seabed behind them is still real information. */
        FLUID(0.0, true, false),
        /** Glass, bars, fences, slabs, stairs, doors, snow layers — a partial view, not a wall. */
        PARTIAL(0.15, true, false),
        /** Leaves: seen through, but a few layers deep is a canopy, not a window. */
        LEAVES(0.5, true, false),
        /** A full, view-blocking cube. The only thing that ends a sightline or sets a horizon. */
        OPAQUE(1.0, true, true);

        /** How much of the ray's one unit of opacity budget this cell consumes. */
        final double opacity;
        final boolean recorded;
        final boolean horizon;

        Kind(double opacity, boolean recorded, boolean horizon) {
            this.opacity = opacity;
            this.recorded = recorded;
            this.horizon = horizon;
        }
    }

    /**
     * Classify one cell.
     *
     * <p>Order matters. Fluid is tested first because a water source's collision shape is empty and
     * it would otherwise read as CLUTTER — true, but it would lose the distinction the navigation
     * side needs (§2: a lake and a ravine must stop being the same answer).
     */
    public static Kind classify(final ServerLevel level, final BlockState state, final BlockPos pos) {
        if (state.isAir()) {
            return Kind.AIR;
        }
        if (!state.getFluidState().isEmpty() && state.getCollisionShape(level, pos).isEmpty()) {
            return Kind.FLUID;
        }
        // A wall is a cell that fills its own volume AND blocks light. Both halves are load-bearing:
        // glass fills the volume but does not occlude, leaves occlude nothing and do not fill it.
        if (state.canOcclude() && state.isCollisionShapeFullBlock(level, pos)) {
            return Kind.OPAQUE;
        }
        if (state.is(BlockTags.LEAVES)) {
            return Kind.LEAVES;
        }
        if (state.getCollisionShape(level, pos).isEmpty()) {
            return Kind.CLUTTER;
        }
        return Kind.PARTIAL;
    }

    /**
     * One cell a sightline recorded, in the order the ray met it.
     *
     * @param face the side the ray entered through — null only for the cell the ray STARTS inside,
     *             which has no entry face. Callers that place against a hit need it.
     */
    public record Sighting(BlockPos pos, BlockState state, Kind kind, double distance, boolean throughFluid,
                    @org.jspecify.annotations.Nullable Direction face) { }

    /**
     * The result of walking one ray: everything it saw, and where its view ended.
     *
     * @param seen      recorded cells, nearest first; the last entry is {@link #terminal} when there is one
     * @param terminal  the opaque cell that ended the ray, or null if it ran out of budget/range first
     * @param distance  distance to {@code terminal}, else how far the walk actually got
     * @param blocked   true when an opaque cell ended it — i.e. {@code distance} is a real horizon
     */
    public record Walk(List<Sighting> seen, @org.jspecify.annotations.Nullable Sighting terminal,
                double distance, boolean blocked) { }

    /**
     * March a segment cell by cell and record what it passes through.
     *
     * <p>Amanatides–Woo voxel traversal rather than {@link ServerLevel#clip}: clip answers only
     * "where does this stop", and the whole point here is that stopping and seeing are different.
     * The opacity budget is what keeps "see through leaves" from becoming "see through a forest" —
     * a ray spends 0.5 per leaf layer and dies on the third, while glass costs 0.15 and clutter is
     * free.
     *
     * <p>Reads only cells inside the segment given; the caller has already clamped it to readable
     * chunks, so this never triggers generation on the server thread.
     */
    public static Walk walk(final ServerLevel level, final Vec3 from, final Vec3 to, final int maxCells,
                     final boolean fluidsBlock) {
        return walk(level, from, to, maxCells, fluidsBlock, null);
    }

    /**
     * As above, with an optional visitor for EVERY cell the ray enters — air included. The recorded
     * sightings deliberately exclude air (token spam, §2.4 of the world-model design); the visitor
     * is for the consumer that needs the certified-clear cells as facts: the per-session seen-set
     * behind the knowledge-masked solve (CHECK_PATH_AUDIT.md R2 — "one tap, two consumers").
     */
    public static Walk walk(final ServerLevel level, final Vec3 from, final Vec3 to, final int maxCells,
                     final boolean fluidsBlock, final java.util.function.LongConsumer visited) {
        List<Sighting> seen = new ArrayList<>(8);
        Vec3 delta = to.subtract(from);
        double length = delta.length();
        if (length < 1.0e-7) {
            return new Walk(seen, null, 0.0, false);
        }
        Vec3 dir = delta.scale(1.0 / length);

        int x = (int) Math.floor(from.x);
        int y = (int) Math.floor(from.y);
        int z = (int) Math.floor(from.z);
        int stepX = dir.x > 0 ? 1 : (dir.x < 0 ? -1 : 0);
        int stepY = dir.y > 0 ? 1 : (dir.y < 0 ? -1 : 0);
        int stepZ = dir.z > 0 ? 1 : (dir.z < 0 ? -1 : 0);

        // Distance along the ray to the next cell boundary on each axis, and the distance between
        // successive boundaries. Infinite on an axis the ray does not move along.
        double tMaxX = boundary(from.x, dir.x, stepX);
        double tMaxY = boundary(from.y, dir.y, stepY);
        double tMaxZ = boundary(from.z, dir.z, stepZ);
        double tDeltaX = stepX == 0 ? Double.POSITIVE_INFINITY : Math.abs(1.0 / dir.x);
        double tDeltaY = stepY == 0 ? Double.POSITIVE_INFINITY : Math.abs(1.0 / dir.y);
        double tDeltaZ = stepZ == 0 ? Double.POSITIVE_INFINITY : Math.abs(1.0 / dir.z);

        double opacity = 0.0;
        boolean throughFluid = false;
        double travelled = 0.0;
        Direction face = null;
        BlockPos.MutableBlockPos cursor = new BlockPos.MutableBlockPos();

        for (int i = 0; i < maxCells; i++) {
            cursor.set(x, y, z);
            if (visited != null) {
                visited.accept(BlockPos.asLong(x, y, z));
            }
            BlockState state = level.getBlockState(cursor);
            Kind kind = classify(level, state, cursor);
            if (kind.recorded) {
                BlockPos at = cursor.immutable();
                Sighting s = new Sighting(at, state, kind, round(travelled), throughFluid, face);
                // `fluids:true` is the caller asking for the old meaning — the surface of a lake IS
                // the answer, not the seabed. Kept because a caller measuring a shoreline wants the
                // water to stop the ray; the DEFAULT is now see-and-traverse (§1.1).
                if (kind.horizon || (fluidsBlock && kind == Kind.FLUID)) {
                    seen.add(s);
                    return new Walk(seen, s, s.distance(), true);
                }
                seen.add(s);
                opacity += kind.opacity;
                if (kind == Kind.FLUID) {
                    // Provenance for everything BEHIND this cell: the capture layer has to be able to
                    // tell "I saw the seabed through water" from "I stood on it" (§1.1).
                    throughFluid = true;
                }
                if (opacity >= 1.0) {
                    return new Walk(seen, null, round(travelled), false);
                }
            }

            // Step to the next cell.
            if (tMaxX < tMaxY && tMaxX < tMaxZ) {
                travelled = tMaxX;
                x += stepX;
                tMaxX += tDeltaX;
                face = stepX > 0 ? Direction.WEST : Direction.EAST;
            } else if (tMaxY < tMaxZ) {
                travelled = tMaxY;
                y += stepY;
                tMaxY += tDeltaY;
                face = stepY > 0 ? Direction.DOWN : Direction.UP;
            } else {
                travelled = tMaxZ;
                z += stepZ;
                tMaxZ += tDeltaZ;
                face = stepZ > 0 ? Direction.NORTH : Direction.SOUTH;
            }
            if (travelled > length) {
                return new Walk(seen, null, round(length), false);
            }
        }
        return new Walk(seen, null, round(Math.min(travelled, length)), false);
    }

    /** Distance along the ray from {@code origin} to the first cell boundary in the step direction. */
    private static double boundary(final double origin, final double d, final int step) {
        if (step == 0) {
            return Double.POSITIVE_INFINITY;
        }
        double cell = Math.floor(origin);
        double edge = step > 0 ? cell + 1.0 : cell;
        return (edge - origin) / d;
    }

    private static double round(final double v) {
        return Math.round(v * 10.0) / 10.0;
    }
}
