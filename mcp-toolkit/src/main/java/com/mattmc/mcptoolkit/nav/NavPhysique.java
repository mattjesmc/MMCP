package com.mattmc.mcptoolkit.nav;

import net.minecraft.core.BlockPos;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.level.pathfinder.PathType;
import net.minecraft.world.level.pathfinder.PathTypeCache;
import net.minecraft.world.phys.AABB;
import org.jspecify.annotations.Nullable;

/**
 * The body as the <b>search</b> sees it — shape, physics limits, malus table, start position. Pure
 * reads: everything the vanilla {@code WalkNodeEvaluator} ever asked a {@code Mob} turns out to be a
 * query about the body's physique, none of it needing a live entity (BOT_SURFACE_DESIGN.md §11.6).
 * That is what makes a {@link SyntheticPhysique} possible: {@code check_path} can solve for a
 * player-shaped body that does not exist yet.
 *
 * <p>The malus table is OWNED by the implementation (§11.6 decision 3): profile rights (door opening)
 * are written into the physique per solve, never into a real entity's persistent malus map.
 */
public interface NavPhysique {

    // ---- shape ----------------------------------------------------------------

    float bbWidth();

    float bbHeight();

    /** The body's collision box at its current position (start-node corner probing). */
    AABB boundingBox();

    // ---- start position --------------------------------------------------------

    double x();

    double y();

    double z();

    BlockPos blockPosition();

    // ---- physics limits ---------------------------------------------------------

    boolean onGround();

    boolean isInWater();

    boolean canStandOnFluid(FluidState fluid);

    /**
     * Breath left, in ticks (vanilla's scale: 300 = 20 seconds). The search prices deep water against
     * this — a body with half a lungful should not be routed under a reef it cannot cross. Bodies that
     * do not drown report {@link #maxAirSupply}, which makes the pricing a no-op for them.
     */
    default int airSupply() {
        return maxAirSupply();
    }

    /** Full breath in ticks — the denominator for the air fraction the swim pricing reads. */
    default int maxAirSupply() {
        return 300;
    }

    /** True for a body that never drowns; submerged cells then carry no air pressure at all. */
    default boolean canBreatheUnderwater() {
        return false;
    }

    float maxUpStep();

    int maxFallDistance();

    // ---- costs -------------------------------------------------------------------

    /** The body's cost multiplier for a path type; negative means impassable. */
    float pathfindingMalus(PathType type);

    // ---- environment hooks ---------------------------------------------------------

    /**
     * The server's shared path-type cache, or null when the solve runs detached from a server level.
     * Read-only from the search's side either way.
     */
    @Nullable PathTypeCache pathTypeCache();

    /**
     * The entity whose collision context {@code noCollision} checks should use, or null for a pure
     * shape check (a synthetic physique has no entity to collide as).
     */
    @Nullable Entity collisionEntity();

    /** Mob lifecycle hooks around a search; no-ops for bodies that are not vanilla mobs. */
    default void onPathfindingStart() {}

    default void onPathfindingDone() {}
}
