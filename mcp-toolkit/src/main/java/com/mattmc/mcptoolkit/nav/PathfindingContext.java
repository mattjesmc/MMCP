package com.mattmc.mcptoolkit.nav;

import net.minecraft.core.BlockPos;
import net.minecraft.world.level.CollisionGetter;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.pathfinder.PathType;
import net.minecraft.world.level.pathfinder.PathTypeCache;
import net.minecraft.world.level.pathfinder.WalkNodeEvaluator;
import org.jspecify.annotations.Nullable;

/**
 * Our copy of vanilla {@code PathfindingContext}, the one place its {@code Mob} constructor parameter
 * actually mattered: it only ever read {@code mob.level()} (for the shared {@link PathTypeCache}) and
 * {@code mob.blockPosition()}. Retyped to take those two facts directly from a {@link NavPhysique}.
 * The cache is READ-ONLY from here, exactly as vanilla uses it.
 */
public final class PathfindingContext {
    private final CollisionGetter level;
    private final @Nullable PathTypeCache cache;
    private final BlockPos mobPosition;
    private final BlockPos.MutableBlockPos mutablePos = new BlockPos.MutableBlockPos();

    public PathfindingContext(final CollisionGetter level, final NavPhysique body) {
        this.level = level;
        this.cache = body.pathTypeCache();
        this.mobPosition = body.blockPosition();
    }

    /**
     * <b>The chokepoint for walker block classification.</b> Every {@code getPathType} query in the
     * A* resolves here, through vanilla's classifier (directly, or via the server's shared
     * {@link PathTypeCache}) — our copied {@code WalkNodeEvaluator.getPathTypeFromState} is NOT on
     * this path, which is why the toolkit's modded-hazard overlay has to be applied here rather than
     * in that copy (EXTENSION_DESIGN.md §3.2; the 0.41.0 probes caught the difference).
     *
     * <p>The overlay is applied AFTER the lookup, deliberately: the shared cache keeps storing
     * vanilla's own verdict, so nothing the toolkit believes about hazards can leak into the
     * pathfinding of ordinary mobs that read the same cache.
     */
    public PathType getPathTypeFromState(final int x, final int y, final int z) {
        BlockPos pos = this.mutablePos.set(x, y, z);
        PathType computed = this.cache == null
            ? WalkNodeEvaluatorBridge.pathTypeFromState(this.level, pos)
            : this.cache.getOrCompute(this.level, pos);
        if (computed != PathType.OPEN) {
            return computed;
        }
        return com.mattmc.mcptoolkit.McpToolkitTags.hazardOverlay(computed, this.level.getBlockState(pos));
    }

    public BlockState getBlockState(final BlockPos pos) {
        return this.level.getBlockState(pos);
    }

    public CollisionGetter level() {
        return this.level;
    }

    public BlockPos mobPosition() {
        return this.mobPosition;
    }

    /**
     * Vanilla's {@code WalkNodeEvaluator.getPathTypeFromState} is {@code protected static}; this
     * subclass republishes it so the cache-less branch classifies blocks IDENTICALLY to vanilla
     * (our copied evaluator has its own copy of the method — using vanilla's here means the two can
     * never drift apart on the cache-vs-direct read path).
     */
    private static final class WalkNodeEvaluatorBridge extends WalkNodeEvaluator {
        static PathType pathTypeFromState(final net.minecraft.world.level.BlockGetter level, final BlockPos pos) {
            return getPathTypeFromState(level, pos);
        }
    }
}
