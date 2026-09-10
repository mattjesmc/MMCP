package com.mattmc.mcptoolkit.wm;

import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;

/**
 * The v1 goal predicates (HUMAN_RIG_PLAN.md phase 3) — the referee's answer to "does the world now
 * satisfy this goal?", extracted NARROWLY from GoalRunner's verdict semantics rather than by
 * refactoring the live-verified goal driver. Each predicate documents the GoalRunner site it
 * mirrors; {@code verdict-equivalence.test.mjs} pins the two against each other so drift fails a
 * probe instead of silently forking the training labels.
 *
 * <p>Pure world/geometry checks only: no task state, no emission, no side effects. {@link
 * HumanReferee} owns turning these into verdicts; GoalRunner keeps its own copies untouched.
 */
public final class VerdictPredicates {
    private VerdictPredicates() {}

    /**
     * A human move arrives when the player is ON the highlighted cell, with this much slack —
     * deliberately tighter than GoalRunner's {@code MOVE_WITHIN} 2.5 (a bot goal is "get near
     * enough to work"; the presenter highlights ONE block and a task that completes 2.5 blocks
     * early reads as a broken referee to the human standing there). Decreed in the plan's phase-3
     * spec; the 0.25 matches the player body's zero-motion epsilon (DroneTools traveled eps).
     */
    public static final double MOVE_EPSILON = 0.25;

    /**
     * move: the player's feet point is within {@link #MOVE_EPSILON} of the target cell's unit
     * cube. Standing on top of the block (feet at y+1 inside the column) or inside the cell (an
     * air target) both measure 0; the epsilon is boundary slack, not a radius — being a whole
     * block away never satisfies it. Mirrors the SPIRIT of GoalRunner's arrival test
     * (canActNow "move"), with the human-rig tolerance above.
     */
    public static boolean moveArrived(final Vec3 playerPos, final BlockPos target) {
        double dx = axisDist(playerPos.x, target.getX());
        double dy = axisDist(playerPos.y, target.getY());
        double dz = axisDist(playerPos.z, target.getZ());
        return dx * dx + dy * dy + dz * dz <= MOVE_EPSILON * MOVE_EPSILON;
    }

    /** Distance from a coordinate to the closed unit interval [cell, cell+1]. */
    private static double axisDist(final double v, final int cell) {
        if (v < cell) {
            return cell - v;
        }
        return v > cell + 1 ? v - (cell + 1) : 0;
    }

    /**
     * destroy: the cell no longer holds a diggable block — air, or a fluid with no collision shape
     * (a block dug underwater floods; the solid is gone and that IS the goal). Mirrors
     * DroneHands.startMine's refusal set: {@code nothing_to_mine} (isAir) and the
     * fluid-is-not-a-block gate, which together define what GoalRunner's destroy goal considers
     * "nothing left to mine".
     */
    public static boolean destroyCleared(final ServerLevel level, final BlockPos at) {
        BlockState st = level.getBlockState(at);
        return st.isAir()
            || (!st.getFluidState().isEmpty() && st.getCollisionShape(level, at).isEmpty());
    }

    /**
     * place: a real block occupies the cell — one a placement could NOT overwrite. Mirrors
     * DroneHands.botPlace's {@code obstructed} test ({@code !canBeReplaced()}): tall grass, snow
     * layers, and fluids are replaceable and so do not count as "placed".
     */
    public static boolean placePresent(final ServerLevel level, final BlockPos at) {
        return !level.getBlockState(at).canBeReplaced();
    }
}
