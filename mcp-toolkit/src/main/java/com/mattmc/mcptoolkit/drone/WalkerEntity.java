package com.mattmc.mcptoolkit.drone;

import com.mattmc.mcptoolkit.nav.NavBody;
import com.mattmc.mcptoolkit.nav.NavProfile;
import com.mattmc.mcptoolkit.nav.WalkerNavigation;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.ai.attributes.AttributeSupplier;
import net.minecraft.world.entity.ai.attributes.Attributes;
import net.minecraft.world.entity.ai.control.MoveControl;
import net.minecraft.world.entity.ai.navigation.PathNavigation;
import net.minecraft.util.Mth;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.pathfinder.PathComputationType;
import net.minecraft.world.level.pathfinder.PathType;
import net.minecraft.world.level.pathfinder.PathTypeCache;
import net.minecraft.world.phys.AABB;
import org.jspecify.annotations.Nullable;

/**
 * The GROUNDED toolkit body — {@link DroneEntity}'s walking sibling (BOT_SURFACE_DESIGN.md §11.3) and
 * the first {@link NavBody}. Player-shaped (0.6 x 1.8, eye 1.62, step 0.6), subject to gravity and
 * fall damage, walks with player kinematics: the input sink drives UNIT forward impulse with a
 * player-scale MOVEMENT_SPEED attribute (0.1), so {@code travel()} integrates the same accelerations
 * a player's held-forward key produces — not the mob convention of squaring a 0.25 attribute.
 *
 * <p><b>The inert MoveControl is load-bearing.</b> {@code Mob.serverAiStep} ticks the move control
 * right after the navigation, and vanilla {@code MoveControl}'s WAIT state zeroes {@code zza} every
 * tick — it would erase the driver's inputs the same tick they were written (§11.6 gotcha). The
 * walker's control does nothing; {@link WalkerNavigation}'s driver is the only writer of inputs,
 * including zeroing them when idle.
 */
public class WalkerEntity extends BotBodyEntity implements NavBody {

    public WalkerEntity(final EntityType<? extends WalkerEntity> type, final Level level) {
        super(type, level);
        this.moveControl = new MoveControl<>(this) {
            @Override
            public void tick() {
                // Inert on purpose — see the class javadoc.
            }
        };
    }

    public static AttributeSupplier.Builder createAttributes() {
        return Mob.createMobAttributes()
            .add(Attributes.MAX_HEALTH, 20.0)
            .add(Attributes.MOVEMENT_SPEED, 0.1)   // player walk scale; the sink drives unit zza
            .add(Attributes.STEP_HEIGHT, 0.6)
            .add(Attributes.FOLLOW_RANGE, 64.0)
            .add(Attributes.ATTACK_DAMAGE, 4.0);
    }

    @Override
    protected PathNavigation createNavigation(final Level level) {
        return new WalkerNavigation(this, level);
    }

    /** The navigation, typed — the goal loop's leap actuation goes through this. */
    public WalkerNavigation walkerNavigation() {
        return (WalkerNavigation) this.getNavigation();
    }

    // ---- NavBody: the input sink ----------------------------------------------

    @Override
    public float yRot() {
        return this.getYRot();
    }

    @Override
    public void driveInput(final float yawDegrees, final float speedModifier,
                           final boolean jump, final boolean sprint) {
        this.setYRot(yawDegrees);
        this.setYBodyRot(yawDegrees);
        this.setYHeadRot(yawDegrees);
        if (this.isSprinting() != sprint) {
            this.setSprinting(sprint); // attribute modifier — set BEFORE the speed read below
        }
        float speed = (float) (speedModifier * this.getAttributeValue(Attributes.MOVEMENT_SPEED));
        this.setSpeed(speed);            // Mob.setSpeed also sets zza = speed (mob convention) ...
        this.setZza(speedModifier > 0 ? 0.98F : 0.0F); // ... overwrite with player-style unit input
        this.setXxa(0.0F);               // narrow frame: no sideways intent
        if (jump) {
            this.getJumpControl().jump(); // applied by JumpControl.tick later this same tick
        }
        // World-model actions tap — same seam as the player body's sink (DESIGN.md §3, §13.3).
        com.mattmc.mcptoolkit.wm.Wm.actionWalk(this, yawDegrees, speedModifier, jump, sprint);
    }

    @Override
    public boolean canStrafeInput() {
        return true;
    }

    /**
     * The widened sink for the walker (DESIGN.md §9 Phase 3), and the reason it had to exist: with
     * only {@link #driveInput}, {@link NavBody#driveMove}'s default DROPS the strafe channel and
     * quantises forward to {@code speedModifier > 0 ? 0.98 : 0}. Once the attack gate owns the gaze
     * (V3_PLAN.md §2 F1) the driver decomposes the route into forward/strafe about the HELD facing,
     * so any route component behind that facing arrives as a non-positive forward — and the walker
     * stood perfectly still. In a melee fight the held facing is the enemy and the kite anchor is
     * directly behind the body ({@code |off| ≈ 180°}), so the body could not back away at all:
     * the audited death of EVAL_AUDIT_V2.md §10 item 3 — a walker pinned in contact with one
     * zombie — rebuilt by a new mechanism, on the very body family it happened to. Found in review
     * before it ever ran.
     *
     * <p>Legacy path preserved exactly: with {@code strafe == 0} the magnitude is {@code |forward|}
     * and the unit input is {@code ±0.98} on zza alone, which is byte-identical to the narrow sink
     * above for the forward case every existing navigation produces.
     */
    @Override
    public void driveMove(final float yawDegrees, final float pitchDegrees, final float forward,
                          final float strafe, final boolean jump, final boolean sneak,
                          final boolean sprint) {
        this.setYRot(yawDegrees);
        this.setYBodyRot(yawDegrees);
        this.setYHeadRot(yawDegrees);
        if (this.isSprinting() != sprint) {
            this.setSprinting(sprint); // attribute modifier — set BEFORE the speed read below
        }
        // Clamp to the unit disc the way a client compiles keys: magnitude carries the requested
        // speed, direction carries the intent. Pitch is deliberately NOT written — a Mob's vanilla
        // LookControl resets xRot every entity tick, so a write here would only fight it (the same
        // reason AttackGate gates pitch strictly on the player body alone).
        float fx = Mth.clamp(strafe, -1.0F, 1.0F);
        float fz = Mth.clamp(forward, -1.0F, 1.0F);
        float mag = Mth.sqrt(fx * fx + fz * fz);
        if (mag > 1.0F) {
            fx /= mag;
            fz /= mag;
            mag = 1.0F;
        }
        this.setSpeed((float) (mag * this.getAttributeValue(Attributes.MOVEMENT_SPEED)));
        // setSpeed writes zza = speed (mob convention); overwrite both channels with the player-
        // style UNIT input, so `travel` gets direction from these and magnitude from the speed.
        this.setZza(mag > 0.0F ? fz / mag * 0.98F : 0.0F);
        this.setXxa(mag > 0.0F ? fx / mag * 0.98F : 0.0F);
        if (jump) {
            this.getJumpControl().jump();
        }
        com.mattmc.mcptoolkit.wm.Wm.actionMove(this, yawDegrees, pitchDegrees, fz, fx, jump, sneak,
            sprint);
    }

    @Override
    public void launch(final double vx, final double vy, final double vz) {
        this.setDeltaMovement(vx, vy, vz);
        this.hurtMarked = true; // sync the impulse to clients so the leap renders
    }

    @Override
    public int maxJumpGap() {
        return NavProfile.VANILLA.maxJumpGap();
    }

    // ---- NavBody: the SWIM sink (§12.4) ----------------------------------------

    @Override
    public boolean canSwim() {
        return true;
    }

    @Override
    public boolean inWater() {
        return this.isInWater();
    }

    @Override
    public boolean submerged() {
        return this.isEyeInFluid(net.minecraft.tags.FluidTags.WATER);
    }

    /**
     * The wet input frame — the same shape as {@link #driveInput}, and for the same reason it writes
     * inputs rather than velocity: {@code travelInWater} rotates x/z by yaw and passes y straight
     * through, so {@code yya} is the whole vertical control.
     *
     * <p>The mob-convention dance in {@code driveInput} applies here too: {@code setSpeed} also writes
     * {@code zza}, so the player-style unit input has to be written after it or it is silently
     * overwritten by a 0.1-scale value.
     */
    @Override
    public void driveSwim(final float yawDegrees, final float pitchDegrees, final float forward,
                          final float vertical, final boolean sprintSwim) {
        this.setYRot(yawDegrees);
        this.setYBodyRot(yawDegrees);
        this.setYHeadRot(yawDegrees);
        this.setXRot(pitchDegrees);
        if (this.isSprinting() != sprintSwim) {
            this.setSprinting(sprintSwim);
        }
        this.setSwimming(sprintSwim && this.isInWater() && this.isUnderWater());
        this.setSpeed((float) (forward * this.getAttributeValue(Attributes.MOVEMENT_SPEED)));
        this.setZza(forward > 0.0F ? 0.98F : 0.0F);
        this.yya = vertical;
        this.setJumping(vertical > 0.0F);
        com.mattmc.mcptoolkit.wm.Wm.actionSwim(this, yawDegrees, pitchDegrees, forward, vertical,
            sprintSwim);
    }

    @Override
    public boolean swimmableAt(final double wx, final double wz) {
        return this.level().getFluidState(new BlockPos(Mth.floor(wx),
            Mth.floor(this.getY() + 1.0e-3), Mth.floor(wz))).is(net.minecraft.tags.FluidTags.WATER);
    }

    @Override
    public int airSupply() {
        return this.getAirSupply();
    }

    @Override
    public int maxAirSupply() {
        return this.getMaxAirSupply();
    }

    @Override
    public boolean footingAt(final double wx, final double wz) {
        int bx = Mth.floor(wx);
        int bz = Mth.floor(wz);
        int feetY = Mth.floor(this.getY() + 1.0e-3);
        // Anything solid within a survivable drop below the lookahead catches the body; nothing within
        // it is an edge/void the driver must not stride into. maxFall+1 aligns the guard with the
        // search's own descent limit — every drop the returned path plans lands within this scan, so
        // only a deeper pit (the bench's 4-trench, past a walker's max fall of 3) trips the hold.
        int scan = this.getMaxFallDistance() + 1;
        for (int dy = 1; dy <= scan; dy++) {
            if (!this.level().getBlockState(new BlockPos(bx, feetY - dy, bz))
                    .isPathfindable(PathComputationType.LAND)) {
                return true;
            }
        }
        return false;
    }

    // ---- NavPhysique: reads the Entity API doesn't already provide under these names ----

    @Override
    public float bbWidth() {
        return this.getBbWidth();
    }

    @Override
    public float bbHeight() {
        return this.getBbHeight();
    }

    @Override
    public AABB boundingBox() {
        return this.getBoundingBox();
    }

    @Override
    public double x() {
        return this.getX();
    }

    @Override
    public double y() {
        return this.getY();
    }

    @Override
    public double z() {
        return this.getZ();
    }

    @Override
    public int maxFallDistance() {
        return this.getMaxFallDistance();
    }

    @Override
    public float pathfindingMalus(final PathType type) {
        return this.getPathfindingMalus(type); // never mutated — profiles overlay via MobPhysique
    }

    @Override
    public @Nullable PathTypeCache pathTypeCache() {
        return this.level() instanceof ServerLevel serverLevel ? serverLevel.getPathTypeCache() : null;
    }

    @Override
    public @Nullable Entity collisionEntity() {
        return this;
    }
}
