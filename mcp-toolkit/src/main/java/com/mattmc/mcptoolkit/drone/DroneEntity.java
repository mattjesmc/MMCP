package com.mattmc.mcptoolkit.drone;

import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.ai.attributes.AttributeSupplier;
import net.minecraft.world.entity.ai.attributes.Attributes;
import net.minecraft.world.entity.ai.control.FlyingMoveControl;
import net.minecraft.world.entity.ai.navigation.FlyingPathNavigation;
import net.minecraft.world.entity.ai.navigation.PathNavigation;
import net.minecraft.world.level.Level;
import net.minecraft.world.phys.Vec3;

/**
 * The recon drone — the FLYING toolkit body ({@link BotBodyEntity} carries the shared hands/beam/
 * lifecycle): a hovering mechanical sensor platform and embodied actor. Modeled on the Allay's
 * flight (a {@link FlyingMoveControl} + {@link FlyingPathNavigation}, no gravity), so it can be told
 * to path anywhere in 3D. Its eye is a perception origin: {@code WorldPerceptionTools.resolveOrigin}'s
 * {@code drone} case reads {@code getEyePosition()} + view vector off this entity, so the sensor and
 * the body are the same object.
 *
 * <p>Aerial recon is what it keeps being for after the walker lands: it flies over gaps and through
 * doorways, which is exactly why it can never prove the walker capabilities (BOT_SURFACE_DESIGN.md
 * §11.1) — the grounded sibling {@link WalkerEntity} exists for that.
 */
public class DroneEntity extends BotBodyEntity {

    public DroneEntity(final EntityType<? extends DroneEntity> type, final Level level) {
        super(type, level);
        // maxTurn 20°, hoversInPlace = true → holds altitude when idle instead of drifting down.
        this.moveControl = new FlyingMoveControl(this, 20, true);
        this.setNoGravity(true);
    }

    public static AttributeSupplier.Builder createAttributes() {
        return Mob.createMobAttributes()
            .add(Attributes.MAX_HEALTH, 20.0)
            .add(Attributes.MOVEMENT_SPEED, 0.4)
            .add(Attributes.FLYING_SPEED, 0.6)
            .add(Attributes.FOLLOW_RANGE, 64.0)
            .add(Attributes.ATTACK_DAMAGE, 4.0);
    }

    @Override
    protected PathNavigation createNavigation(final Level level) {
        FlyingPathNavigation navigation = new FlyingPathNavigation(this, level);
        navigation.setCanOpenDoors(false);
        navigation.setCanFloat(true);
        return navigation;
    }

    @Override
    public void travel(final Vec3 travelVector) {
        // Same flight integration the Allay uses — no ground friction, applies flying speed.
        this.travelFlying(travelVector, this.getSpeed());
    }

    @Override
    protected void customServerAiStep(final net.minecraft.server.level.ServerLevel level) {
        super.customServerAiStep(level);
        // Direct-control puppet: when not flying to a target, bleed off residual momentum quickly so it
        // parks crisply where it was told instead of coasting past (FlyingMoveControl otherwise drifts).
        if (this.getNavigation().isDone()) {
            this.setDeltaMovement(this.getDeltaMovement().scale(0.6));
        }
    }

    /** Purely mechanical: unaffected by currents, and no fall damage (it hovers). */
    @Override
    public boolean isAffectedByFluids() {
        return false;
    }

    @Override
    public boolean causeFallDamage(final double distance, final float multiplier,
                                   final net.minecraft.world.damagesource.DamageSource source) {
        return false;
    }
}
