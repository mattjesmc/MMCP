package com.mattmc.mcptoolkit.nav;

import java.util.EnumMap;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.level.pathfinder.PathType;
import net.minecraft.world.level.pathfinder.PathTypeCache;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

/**
 * A body that does not exist: pure physique data, for solving paths with NO entity — the §11.6
 * payoff that deletes {@code check_path}'s throwaway probe mob and lets prediction run for a
 * player-shaped body before any such body is spawned (or even implemented). Malus table is owned
 * here, seeded from the {@link PathType} defaults, with door rights overlaid at construction.
 *
 * <p>Standing start: a synthetic physique is always {@code onGround} at its start cell — it is a
 * question ("could a body shaped like this walk from here?"), not a falling object.
 */
public final class SyntheticPhysique implements NavPhysique {

    private final float width;
    private final float height;
    private final float eyeHeight;
    private final float stepHeight;
    private final int maxFall;
    private final Vec3 pos;
    private final @Nullable ServerLevel cacheLevel;
    private final Map<PathType, Float> malusOverrides = new EnumMap<>(PathType.class);

    private SyntheticPhysique(final float width, final float height, final float eyeHeight,
                              final float stepHeight, final int maxFall, final Vec3 pos,
                              final @Nullable ServerLevel cacheLevel, final boolean canOpenDoors) {
        this.width = width;
        this.height = height;
        this.eyeHeight = eyeHeight;
        this.stepHeight = stepHeight;
        this.maxFall = maxFall;
        this.pos = pos;
        this.cacheLevel = cacheLevel;
        malusOverrides.put(PathType.DOOR_WOOD_CLOSED, canOpenDoors ? 0.0F : -1.0F);
        malusOverrides.put(PathType.DOOR_OPEN, 0.0F);
    }

    /**
     * The walker shape: player dimensions (0.6 x 1.8, eye 1.62, step 0.6, safe fall 3) — matches
     * {@code WalkerEntity} so check_path predicts for the body that will actually execute.
     */
    public static SyntheticPhysique walker(final ServerLevel level, final BlockPos start,
                                           final boolean canOpenDoors) {
        return new SyntheticPhysique(0.6F, 1.8F, 1.62F, 0.6F, 3,
            Vec3.atBottomCenterOf(start), level, canOpenDoors);
    }

    /**
     * The walker shape with NO shared {@link net.minecraft.world.level.pathfinder.PathTypeCache}.
     * Mandatory for a knowledge-masked solve (CHECK_PATH_AUDIT.md R2): the shared cache holds
     * verdicts computed from the REAL world — reading it would leak truth through classification,
     * and {@code getOrCompute} against a masked view would poison it for every ordinary mob.
     */
    public static SyntheticPhysique walkerUncached(final BlockPos start, final boolean canOpenDoors) {
        return new SyntheticPhysique(0.6F, 1.8F, 1.62F, 0.6F, 3,
            Vec3.atBottomCenterOf(start), null, canOpenDoors);
    }

    /** Eye height above feet — for reach/touch predicates (not part of {@link NavPhysique}). */
    public float eyeHeight() {
        return eyeHeight;
    }

    @Override
    public float bbWidth() {
        return width;
    }

    @Override
    public float bbHeight() {
        return height;
    }

    @Override
    public AABB boundingBox() {
        double half = width / 2.0;
        return new AABB(pos.x - half, pos.y, pos.z - half, pos.x + half, pos.y + height, pos.z + half);
    }

    @Override
    public double x() {
        return pos.x;
    }

    @Override
    public double y() {
        return pos.y;
    }

    @Override
    public double z() {
        return pos.z;
    }

    @Override
    public BlockPos blockPosition() {
        return BlockPos.containing(pos);
    }

    @Override
    public boolean onGround() {
        return true;
    }

    @Override
    public boolean isInWater() {
        return false;
    }

    @Override
    public boolean canStandOnFluid(final FluidState fluid) {
        return false;
    }

    @Override
    public float maxUpStep() {
        return stepHeight;
    }

    @Override
    public int maxFallDistance() {
        return maxFall;
    }

    @Override
    public float pathfindingMalus(final PathType type) {
        Float override = malusOverrides.get(type);
        return override != null ? override : type.getMalus();
    }

    @Override
    public @Nullable PathTypeCache pathTypeCache() {
        return cacheLevel == null ? null : cacheLevel.getPathTypeCache();
    }

    @Override
    public @Nullable Entity collisionEntity() {
        return null;
    }
}
