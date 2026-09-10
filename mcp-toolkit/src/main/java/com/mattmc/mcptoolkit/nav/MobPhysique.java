package com.mattmc.mcptoolkit.nav;

import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.level.pathfinder.PathType;
import net.minecraft.world.level.pathfinder.PathTypeCache;
import net.minecraft.world.phys.AABB;
import org.jspecify.annotations.Nullable;

/**
 * A live {@link Mob} as a {@link NavPhysique}. Shape and physics delegate to the entity; the malus
 * lookup delegates to the mob's own table EXCEPT for the door types, which are overlaid per solve
 * from the profile's rights — the §11.6 fix for {@code NavProfile.applyTo(Mob)} mutating the real
 * mob's persistent malus map. The entity is never written to.
 */
public final class MobPhysique implements NavPhysique {

    private final Mob mob;
    private final float doorWoodClosedMalus;

    private MobPhysique(final Mob mob, final boolean canOpenDoors) {
        this.mob = mob;
        this.doorWoodClosedMalus = canOpenDoors ? 0.0F : -1.0F;
    }

    /** Wrap {@code mob} with the profile's door rights overlaid (nothing on the mob is mutated). */
    public static MobPhysique of(final Mob mob, final boolean canOpenDoors) {
        return new MobPhysique(mob, canOpenDoors);
    }

    @Override
    public float bbWidth() {
        return mob.getBbWidth();
    }

    @Override
    public float bbHeight() {
        return mob.getBbHeight();
    }

    @Override
    public AABB boundingBox() {
        return mob.getBoundingBox();
    }

    @Override
    public double x() {
        return mob.getX();
    }

    @Override
    public double y() {
        return mob.getY();
    }

    @Override
    public double z() {
        return mob.getZ();
    }

    @Override
    public BlockPos blockPosition() {
        return mob.blockPosition();
    }

    @Override
    public boolean onGround() {
        return mob.onGround();
    }

    @Override
    public boolean isInWater() {
        return mob.isInWater();
    }

    @Override
    public boolean canStandOnFluid(final FluidState fluid) {
        return mob.canStandOnFluid(fluid);
    }

    @Override
    public int airSupply() {
        return mob.getAirSupply();
    }

    @Override
    public int maxAirSupply() {
        return mob.getMaxAirSupply();
    }

    @Override
    public boolean canBreatheUnderwater() {
        return mob.canBreatheUnderwater();
    }

    @Override
    public float maxUpStep() {
        return mob.maxUpStep();
    }

    @Override
    public int maxFallDistance() {
        return mob.getMaxFallDistance();
    }

    @Override
    public float pathfindingMalus(final PathType type) {
        if (type == PathType.DOOR_WOOD_CLOSED) {
            return doorWoodClosedMalus;
        }
        if (type == PathType.DOOR_OPEN) {
            return 0.0F;
        }
        return mob.getPathfindingMalus(type);
    }

    @Override
    public @Nullable PathTypeCache pathTypeCache() {
        return mob.level() instanceof ServerLevel serverLevel ? serverLevel.getPathTypeCache() : null;
    }

    @Override
    public @Nullable Entity collisionEntity() {
        return mob;
    }

    @Override
    public void onPathfindingStart() {
        mob.onPathfindingStart();
    }

    @Override
    public void onPathfindingDone() {
        mob.onPathfindingDone();
    }
}
