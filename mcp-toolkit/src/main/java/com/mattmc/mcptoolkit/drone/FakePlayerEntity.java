package com.mattmc.mcptoolkit.drone;

import com.mattmc.mcptoolkit.nav.NavBody;
import com.mattmc.mcptoolkit.nav.NavProfile;
import com.mattmc.mcptoolkit.nav.PlayerNavigation;
import com.mojang.authlib.GameProfile;
import java.util.EnumMap;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ClientInformation;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.util.Mth;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.level.pathfinder.PathComputationType;
import net.minecraft.world.level.pathfinder.PathType;
import net.minecraft.world.level.pathfinder.PathTypeCache;
import net.minecraft.world.level.storage.ValueOutput;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

/**
 * The PLAYER body — step 2 of the body architecture (BOT_SURFACE_DESIGN.md §11.4): a real
 * {@code ServerPlayer} with no client behind it, driven by the same {@link NavBody} input frame the
 * walker uses. It is what the §11.2 decision was for — the search, the evaluator and
 * {@code NavDriver} are reused unchanged; only the sink below is new.
 *
 * <p><b>Why a player and not another Mob.</b> {@code Player.isEffectiveAi()} and
 * {@code canSimulateMovement()} are both {@code !level().isClientSide()} — so on the server
 * {@code LivingEntity.aiStep} feeds {@code travel(xxa, yya, zza)} for a player exactly as it does
 * for a mob. Writing the input fields therefore produces <em>authentic player physics</em>: the
 * sprint-jump arc is the engine's, not a tuned impulse. That is the §11.6 decision-4 promise ("the
 * player body has ZERO tuned constants") and it is why {@link #launch} is a no-op here: the walker
 * needs a ballistic shove because mobs do not sprint-jump; this body just holds sprint+forward and
 * jumps, and the vanilla arc carries it.
 *
 * <p><b>The tick pump.</b> {@code ServerPlayer.doTick()} — which calls {@code super.tick()} and so
 * runs all of {@code LivingEntity}'s physics — is invoked from exactly one place in vanilla:
 * {@code ServerGamePacketListenerImpl.tick()}, which runs only for connections registered with
 * {@code ServerConnectionListener}. {@link FakeConnection} deliberately is not (no keep-alive can
 * then kick a player who cannot answer), so without intervention this body would have no physics at
 * all — it would hang in the air, never falling. {@link #tick()} pumps {@code doTick()} itself.
 * The level still drives {@code ServerPlayer.tick()} as it does for any player entity, so both
 * halves run once per tick in vanilla's own order.
 *
 * <p><b>Never persisted.</b> Same doctrine as {@link BotBodyEntity#shouldBeSaved()}: this body is
 * session-bound, so {@link #saveWithoutId} writes nothing and {@link FakePlayers} deletes the
 * playerdata file {@code PlayerList.remove} insists on writing. A resurrected fake player would be
 * an ownerless ghost holding a stale inventory.
 */
public class FakePlayerEntity extends ServerPlayer implements NavBody, Shields.Watcher {

    /** Player safe-fall, matching {@code SyntheticPhysique.walker} so prediction and body agree. */
    private static final int MAX_FALL = 3;

    /** What this body's shield ate this tick ({@link Shields}) — written by
     *  {@link #applyItemBlocking}, drained once per tick by the watch. */
    private Shields.@Nullable Hit blocked;

    /** Where this body stood when {@link #computeSpeed} last ran — the baseline the movement
     *  mirror differences against. Null means "no baseline", exactly as {@code Entity}'s own
     *  {@code lastKnownPosition} does after {@link #reapplyPosition}. */
    private @Nullable Vec3 lastMirroredPos;

    /** The body owns its malus table (§11.6 decision 3) — a Player has no {@code getPathfindingMalus}. */
    private final Map<PathType, Float> malus = new EnumMap<>(PathType.class);

    private final PlayerNavigation navigation = new PlayerNavigation(this);

    FakePlayerEntity(final MinecraftServer server, final ServerLevel level, final GameProfile profile) {
        super(server, level, profile, ClientInformation.createDefault());
        // Doors: a player may always open them. The walker's rights come from its NavProfile because a
        // Mob's malus map is the search's only channel; here the table is ours, so this is just the seed.
        malus.put(PathType.DOOR_WOOD_CLOSED, 0.0F);
        malus.put(PathType.DOOR_OPEN, 0.0F);
    }

    /** The path-follower/driver host — the player's answer to {@code WalkerNavigation}. */
    public PlayerNavigation navigation() {
        return navigation;
    }

    @Override
    public void tick() {
        super.tick();
        // The pump (see the class javadoc): nothing else calls doTick for a connectionless player.
        this.doTick();
        this.navigation.tick();
        // World-model ticks-stream row + gait fans (DESIGN.md §13.1/§13.2) — from the body's own
        // tick so command-spawned bodies record too, not just slot-owned ones.
        com.mattmc.mcptoolkit.wm.Wm.tickEntity(this);
        // The use button, per tick (§9 Phase 3): vanilla's isUsingItem IS use-held — consumption
        // (startUsingItem), shields, bows all pass through it, so one tap here catches every
        // author the way the driveMove sink catches every travel author.
        if (this.isUsingItem()) {
            com.mattmc.mcptoolkit.wm.Wm.actionPress(this, true, false, -1);
        }
    }

    // ---- the movement mirror (COMBAT_KIT_PLAN.md §14, J1) ----------------------

    /**
     * <b>Tell the server how fast this body is actually going.</b> {@code Entity.getKnownSpeed}
     * returns a realized position delta, but {@code ServerPlayer} <em>overrides</em> it to return
     * {@code lastKnownClientMovement} — written only by {@code setKnownMovement}, which
     * {@code ServerGamePacketListenerImpl.handlePlayerKnownMovement} calls when a real client's
     * movement packet arrives. A body with no client therefore reported a speed of <b>zero,
     * forever</b>: a spear in its hand could never pass {@code ofRelativeSpeed}, an arrow it loosed
     * while sprinting inherited none of its motion ({@code Projectile.shootFromRotation}), and
     * {@code ProjectileUtil.getHitEntitiesAlong} never extended its reach into the direction it was
     * travelling. Not a combat bug — a <em>sensing</em> one, and the fourth instance of this
     * workstream's recurring shape: the arsenal is carried and no path pulls the trigger.
     *
     * <p><b>Why here and not in {@link #tick()}.</b> This is exactly where vanilla computes it:
     * {@code Entity.computeSpeed} runs at the top of {@code baseTick}, so the value published is the
     * previous tick's full displacement, on the engine's own clock. And what a real client sends is
     * precisely a realized position delta ({@code this.player.getX() - startX, …} at
     * {@code ServerGamePacketListenerImpl:1153}), so the mirror is not an approximation of the
     * packet — it is the same quantity, computed from the same positions.
     *
     * <p><b>No tuned constant, and no threshold of ours.</b> A teleport is not motion, so the
     * baseline is dropped at the two places a body is MOVED rather than moves — {@link #snapTo} and
     * {@link #teleportSetPosition} — and nowhere else. Deliberately not at {@code reapplyPosition},
     * which {@code Entity} uses for the same purpose but which also rides every <em>pose</em> change
     * (crouch, swim, fall-fly): a real client keeps reporting movement straight through a crouch, so
     * zeroing there would invent a stationary tick the thing being mirrored never has. Nothing else
     * is guarded and no speed is clamped, which is what keeps this body's physics the engine's
     * rather than ours (§11.6 decision 4).
     */
    @Override
    protected void computeSpeed() {
        super.computeSpeed(); // keep Entity's own lastKnownSpeed honest; ServerPlayer just hides it
        Vec3 here = this.position();
        if (this.lastMirroredPos == null) {
            this.lastMirroredPos = here;
        }
        this.setKnownMovement(here.subtract(this.lastMirroredPos));
        this.lastMirroredPos = here;
    }

    /** A snap is not motion: drop the baseline so the next tick's mirror reads zero rather than
     *  the whole jump, which is what a real client's silence produces through
     *  {@code handleClientTickEnd}'s {@code setKnownMovement(Vec3.ZERO)}. Every {@code snapTo}
     *  overload funnels here. */
    @Override
    public void snapTo(final double x, final double y, final double z,
                       final float yRot, final float xRot) {
        super.snapTo(x, y, z, yRot, xRot);
        this.lastMirroredPos = null;
    }

    /** The other half of the same rule: {@code teleport(TeleportTransition)} and the connection's
     *  own teleport both land here. Without it a body that steps through a portal would, for one
     *  tick, be reported as travelling the whole distance — and {@code Projectile.shootFromRotation}
     *  would hand that to the next arrow it fired. */
    @Override
    public void teleportSetPosition(final net.minecraft.world.entity.PositionMoveRotation current,
                                    final net.minecraft.world.entity.PositionMoveRotation destination,
                                    final java.util.Set<net.minecraft.world.entity.Relative> relatives) {
        super.teleportSetPosition(current, destination, relatives);
        this.lastMirroredPos = null;
    }

    /**
     * Session-bound: never written to disk. The file itself is still created by
     * {@code PlayerDataStorage.save} (it does not consult {@code shouldBeSaved}) — {@link FakePlayers}
     * removes it after despawn.
     */
    @Override
    public void saveWithoutId(final ValueOutput output) {
        // Deliberately empty.
    }

    @Override
    public boolean shouldBeSaved() {
        return false;
    }

    // ---- the shield (COMBAT_KIT_PLAN.md §4.6, step 4) --------------------------

    /**
     * <b>Did the shield hold?</b> Vanilla answers this and then throws the answer away: the blocked
     * amount is a local in {@code LivingEntity.hurtServer}, and a blow the shield ate WHOLE changes
     * no health at all — so the toolkit's health-delta watch could not see it even in principle. An
     * agent under fire behind a working shield read exactly the same as one nobody was shooting at.
     *
     * <p>Overridden rather than mixed in because this body is OURS: {@code applyItemBlocking} is
     * public on {@code LivingEntity}, the super call does all of vanilla's arc/delay/reduction
     * maths, and nothing about the game changes for anyone else.
     *
     * <p>The blocking stack is captured BEFORE the super call on purpose: an axe strike disables the
     * shield inside it ({@code Player.blockUsingItem} → {@code BlocksAttacks.disable}, which calls
     * {@code stopUsingItem}), so by the time it returns there is no longer a shield being blocked
     * with to ask about.
     */
    @Override
    public float applyItemBlocking(final ServerLevel level,
                                   final net.minecraft.world.damagesource.DamageSource source,
                                   final float damage) {
        net.minecraft.world.item.ItemStack blocking = this.getItemBlockingWith();
        float blocked = super.applyItemBlocking(level, source, damage);
        Shields.observe(this, source, damage, blocked, blocking);
        return blocked;
    }

    @Override
    public void mcptkRecordBlock(final Shields.Hit hit) {
        this.blocked = hit;
    }

    @Override
    public Shields.@Nullable Hit mcptkTakeBlock() {
        Shields.Hit hit = this.blocked;
        this.blocked = null;
        return hit;
    }

    // ---- NavBody: the input sink ----------------------------------------------

    @Override
    public float yRot() {
        return this.getYRot();
    }

    @Override
    public float xRot() {
        return this.getXRot();
    }

    @Override
    public void driveInput(final float yawDegrees, final float speedModifier,
                           final boolean jump, final boolean sprint) {
        // The narrow frame is now a view onto the widened one, and forward is ANALOG: a 0.5 goal
        // speed is half input, as the mob sink always honoured it. The old 0/1 threshold was the
        // world-model's "impoverished frame" (DESIGN.md §9 Phase 3) — and it recorded requested
        // speeds the physics then refused to run. Pitch passes through unchanged: a narrow-frame
        // author holds the current look.
        driveMove(yawDegrees, this.getXRot(), Mth.clamp(speedModifier, 0.0F, 1.0F), 0.0F, jump,
            false, sprint);
    }

    @Override
    public boolean canStrafeInput() {
        return true;
    }

    /**
     * The widened sink (DESIGN.md §9 Phase 3). Inputs are compiled exactly as the vanilla client
     * compiles keys — {@code LocalPlayer.applyInput}/{@code modifyInput}: clamp to the unit disc,
     * {@code ×0.98}, {@code ×SNEAKING_SPEED} while crouching, then the square-movement stretch —
     * so every frame this body runs is one a real client could have sent. That is the legality
     * standard everywhere else in the toolkit (what the vanilla client tells/permits a player),
     * applied to actuation. No speed constant of ours enters the physics.
     */
    @Override
    public void driveMove(final float yawDegrees, final float pitchDegrees, final float forward,
                          final float strafe, final boolean jump, final boolean sneak,
                          final boolean sprint) {
        // These four writes are what an in-flight attack turn used to fight every tick (audit S2:
        // the gate turns at END_SERVER_TICK, this ran the next entity tick and put the body back
        // on the path heading). The gaze-ownership contract is enforced by the AUTHOR, not here:
        // NavDriver asks AttackGate.holdsGaze and requests the body's current look instead of a
        // steered one. It has to be that way round — the sink RECORDS the frame it is handed
        // (Wm.actionMove below), so a sink that quietly refused a write would make every recorded
        // row a claim about a rotation that never happened (V3_PLAN.md §2 F1).
        this.setYRot(yawDegrees);
        this.setYHeadRot(yawDegrees);
        this.yBodyRot = yawDegrees;
        this.setXRot(Mth.clamp(pitchDegrees, -90.0F, 90.0F));
        this.setShiftKeyDown(sneak);
        // Vanilla clients only sprint moving forward and never while sneaking (LocalPlayer's
        // sprint gate); an unconditional flag here would be an input no client can produce.
        this.setSprinting(sprint && forward > 0.0F && !sneak);
        float fx = Mth.clamp(strafe, -1.0F, 1.0F);
        float fz = Mth.clamp(forward, -1.0F, 1.0F);
        float len = Mth.sqrt(fx * fx + fz * fz);
        if (len > 1.0F) {
            fx /= len;
            fz /= len;
        }
        float scale = 0.98F * (sneak
            ? (float) this.getAttributeValue(
                net.minecraft.world.entity.ai.attributes.Attributes.SNEAKING_SPEED)
            : 1.0F);
        fx *= scale;
        fz *= scale;
        // modifyInputSpeedForSquareMovement: stretch the direction toward the unit square, cap 1.
        float slen = Mth.sqrt(fx * fx + fz * fz);
        if (slen > 1.0e-5F) {
            float ax = Math.abs(fx) / slen;
            float az = Math.abs(fz) / slen;
            float tan = az > ax ? ax / az : az / ax;
            float stretch = Math.min(slen * Mth.sqrt(1.0F + tan * tan), 1.0F) / slen;
            fx *= stretch;
            fz *= stretch;
        }
        this.xxa = fx;
        this.zza = fz;
        this.setJumping(jump);
        // World-model actions tap (DESIGN.md §3): the sink is the ONE place every author's input
        // frame passes through, so recording here catches nav, reflexes and leaps alike — with the
        // actor label the driving context set (§13.3). The REQUESTED frame is what is recorded;
        // the client-compilation above is engine detail the loader can re-derive.
        com.mattmc.mcptoolkit.wm.Wm.actionMove(this, yawDegrees, pitchDegrees, forward, strafe,
            jump, sneak, sprint);
    }

    /**
     * The leap, actuated the player way: <b>the impulse vector is ignored</b> and the body simply
     * jumps. {@code NavDriver.leap} has already pointed it at the landing and set sprint+full-forward
     * for the tick; {@code LivingEntity.aiStep} turns {@code jumping} into {@code jumpFromGround()},
     * and the engine's own sprint-jump arc carries the body across. That is §11.6 decision 4's
     * per-body half: the walker needs the driver's ballistic constants because mobs do not sprint-jump
     * natively; this body has ZERO tuned constants, which is the whole point of §11.4.
     *
     * <p>The flag is one-shot: the next airborne tick re-drives inputs with {@code jump=false}, so it
     * fires exactly once at take-off and the sprint/forward hold does the rest.
     */
    @Override
    public void launch(final double vx, final double vy, final double vz) {
        this.setJumping(true);
    }

    @Override
    public int maxJumpGap() {
        return NavProfile.VANILLA.maxJumpGap();
    }

    @Override
    public boolean canSneak() {
        return true;
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
     * The wet input frame. Like {@link #driveInput} it writes only input fields — no velocity — so the
     * physics stays the engine's: {@code travelInWater} feeds this vector through
     * {@code Entity.getInputVector}, which rotates x/z by yaw and passes <b>y through untouched</b>.
     * That is why {@code yya} alone is a complete vertical control and nothing here needs a tuned
     * impulse, which keeps §11.4's "ZERO tuned constants" promise wet as well as dry.
     *
     * <p>{@code jumping} rides along with a rising thrust because vanilla's {@code jumpInLiquid} is
     * the same motion by another route (and it is what pops the body up over a shoreline lip via
     * {@code jumpOutOfFluid}). The swimming pose is set only when sprint-swimming underwater, matching
     * vanilla's own gate — it is what makes {@code Player.travel} pull the body along its look vector.
     */
    @Override
    public void driveSwim(final float yawDegrees, final float pitchDegrees, final float forward,
                          final float vertical, final boolean sprintSwim) {
        this.setYRot(yawDegrees);
        this.setYHeadRot(yawDegrees);
        this.yBodyRot = yawDegrees;
        this.setXRot(pitchDegrees);
        this.setSprinting(sprintSwim);
        this.setSwimming(sprintSwim && this.isInWater() && this.isUnderWater());
        this.zza = forward > 0.0F ? 1.0F : 0.0F;
        this.xxa = 0.0F;
        this.yya = vertical;
        this.setJumping(vertical > 0.0F);
        com.mattmc.mcptoolkit.wm.Wm.actionSwim(this, yawDegrees, pitchDegrees, forward, vertical,
            sprintSwim);
    }

    @Override
    public boolean swimmableAt(final double wx, final double wz) {
        // Scan DOWN the column like footingAt does, not just the body's own feet level: water one
        // step below a bank is still "the next medium", and sampling only feet height meant every
        // dive-in from a ledge froze at the lip under the edge-hold (w1_42257 F6's pond probe —
        // the body pressed the shoreline with forward zeroed while the swim path waited in the
        // water). Same survivable-drop bound as footing: water past a lethal fall is not an entry.
        int bx = Mth.floor(wx);
        int bz = Mth.floor(wz);
        int feetY = Mth.floor(this.getY() + 1.0e-3);
        int scan = this.getMaxFallDistance() + 1;
        for (int dy = 0; dy <= scan; dy++) {
            BlockPos at = new BlockPos(bx, feetY - dy, bz);
            if (this.level().getFluidState(at).is(net.minecraft.tags.FluidTags.WATER)) {
                return true;
            }
            if (!this.level().getBlockState(at).isPathfindable(PathComputationType.LAND)) {
                return false; // solid before any water — a floor, not a shoreline
            }
        }
        return false;
    }

    @Override
    public int airSupply() {
        return this.getAirSupply();
    }

    @Override
    public int maxAirSupply() {
        return this.getMaxAirSupply();
    }

    /** Real physics: the arc is built from momentum, so the approach must already be a sprint. */
    @Override
    public boolean leapNeedsRunUp() {
        return true;
    }

    @Override
    public boolean footingAt(final double wx, final double wz) {
        int bx = Mth.floor(wx);
        int bz = Mth.floor(wz);
        int feetY = Mth.floor(this.getY() + 1.0e-3);
        int scan = this.getMaxFallDistance() + 1;
        for (int dy = 1; dy <= scan; dy++) {
            if (!this.level().getBlockState(new BlockPos(bx, feetY - dy, bz))
                    .isPathfindable(PathComputationType.LAND)) {
                return true;
            }
        }
        return false;
    }

    // ---- NavPhysique -----------------------------------------------------------

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
    public boolean canStandOnFluid(final FluidState fluid) {
        return super.canStandOnFluid(fluid);
    }

    @Override
    public int maxFallDistance() {
        return MAX_FALL;
    }

    @Override
    public float pathfindingMalus(final PathType type) {
        Float override = malus.get(type);
        return override != null ? override : type.getMalus();
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
