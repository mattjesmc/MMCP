package com.mattmc.spike;

import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.damagesource.DamageSource;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.storage.ValueInput;
import net.minecraft.world.level.storage.ValueOutput;
import net.minecraft.network.syncher.SynchedEntityData;

/**
 * The least entity that can exist. Its TYPE is what the spike is about — the doors in
 * {@link SpikeEntities} — but it is summonable, and for one client boot that was a landmine.
 *
 * <p>A REGISTERED ENTITY TYPE WITH NO RENDERER IS A CLIENT CRASH, not a missing model:
 * {@code EntityRenderDispatcher.shouldRender} NPEs on the render frame one comes into view, the
 * entity is SAVED, so the world then crashes on every subsequent join and the only way back in is
 * to delete the save. That cost two client boots on 2026-08-23 (CROSS_LOADER_DESIGN.md §15.4).
 * {@link SpikeClient} now hands both types vanilla's {@code NoopRenderer}, so a summon is a
 * nothing-shaped entity rather than a dead world.
 */
public class SpikeEntity extends Entity {

    public SpikeEntity(final EntityType<?> type, final Level level) {
        super(type, level);
    }

    @Override
    protected void defineSynchedData(final SynchedEntityData.Builder entityData) {
    }

    @Override
    public boolean hurtServer(final ServerLevel level, final DamageSource source, final float damage) {
        return false;
    }

    @Override
    protected void readAdditionalSaveData(final ValueInput input) {
    }

    @Override
    protected void addAdditionalSaveData(final ValueOutput output) {
    }
}
