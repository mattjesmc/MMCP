package com.mattmc.mcptoolkit.drone;

import net.minecraft.network.syncher.EntityDataAccessor;
import net.minecraft.network.syncher.EntityDataSerializers;
import net.minecraft.network.syncher.SynchedEntityData;
import net.minecraft.world.SimpleContainer;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.PathfinderMob;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.Level;
import net.minecraft.world.phys.Vec3;
import org.joml.Vector3f;
import org.joml.Vector3fc;

/**
 * The shared substrate of every toolkit-owned body — flyer ({@link DroneEntity}) and walker
 * ({@link WalkerEntity}): a directly-commanded puppet with <b>hands</b> (inventory + selected slot,
 * the state the {@link Actuator} contract acts through), the <b>beam</b> action language, and the
 * session-bound lifecycle (never saved to disk, cargo spills on death). Subclasses supply the
 * locomotion: how the body moves is the one thing they do not share (BOT_SURFACE_DESIGN.md §11).
 *
 * <p>Neither body registers AI goals — all movement comes from the bot_* bridge tools driving the
 * body's navigation.
 */
public abstract class BotBodyEntity extends PathfinderMob implements Hands, Shields.Watcher {
    public static final byte BEAM_NONE = 0;
    public static final byte BEAM_POINT = 1;
    public static final byte BEAM_DIG = 2;
    public static final byte BEAM_ATTACK = 3;

    /** Entity-event id for the attack lunge (client-side animation). */
    public static final byte EVENT_LUNGE = 4;
    /** Lunge animation length in client ticks. */
    public static final int LUNGE_TICKS = 6;

    private static final EntityDataAccessor<Byte> DATA_BEAM_MODE =
        SynchedEntityData.defineId(BotBodyEntity.class, EntityDataSerializers.BYTE);
    private static final EntityDataAccessor<Vector3fc> DATA_BEAM_TARGET =
        SynchedEntityData.defineId(BotBodyEntity.class, EntityDataSerializers.VECTOR3);

    /** The body's carried items — mined drops accumulate here; place/use/attack draw from it. */
    private final SimpleContainer inventory = new SimpleContainer(27);
    /** Which inventory slot is "held": the default item for place/use/attack, moved by bot_select. */
    private int selectedSlot = 0;
    /** Server-side beam lifetime; at 0 the beam clears. Dig beams are refreshed while the dig runs. */
    private int beamTicks;
    /** Client-side lunge countdown, driven by {@link #EVENT_LUNGE}. */
    private int lungeTicks;

    protected BotBodyEntity(final EntityType<? extends BotBodyEntity> type, final Level level) {
        super(type, level);
        this.setPersistenceRequired();
    }

    @Override
    protected void defineSynchedData(final SynchedEntityData.Builder builder) {
        super.defineSynchedData(builder);
        builder.define(DATA_BEAM_MODE, BEAM_NONE);
        builder.define(DATA_BEAM_TARGET, new Vector3f());
    }

    /** The body's carried-item container (27 slots). */
    public SimpleContainer inventory() {
        return inventory;
    }

    /** Index of the currently held slot. */
    public int selectedSlot() {
        return selectedSlot;
    }

    /** Move the held slot; throws if out of range. */
    public void setSelectedSlot(final int slot) {
        if (slot < 0 || slot >= inventory.getContainerSize()) {
            throw new IllegalArgumentException("slot out of range 0.." + (inventory.getContainerSize() - 1));
        }
        this.selectedSlot = slot;
    }

    /** The stack in the held slot (possibly {@link ItemStack#EMPTY}). */
    @Override
    public ItemStack selectedStack() {
        return inventory.getItem(selectedSlot);
    }

    // ---- Hands (the drone half of the §13.1 contract; behaviour unchanged from v1) ----

    @Override
    public net.minecraft.world.entity.LivingEntity handsBody() {
        return this;
    }

    @Override
    public net.minecraft.world.Container container() {
        return inventory;
    }

    /**
     * <b>Insert, in stacks the container can actually hold.</b> {@code SimpleContainer.addItem}
     * claims an empty slot with {@code setItem(slot, sourceStack.copyAndClear())} and only THEN
     * clamps it — {@code setItem} calls {@code limitSize(getMaxStackSize(stack))}. So handing it a
     * stack bigger than the item's max-stack silently DESTROYS the excess and returns
     * {@code ItemStack.EMPTY}, which this contract reads as "all of it fit".
     *
     * <p>Vanilla never hits it because nothing in the game hands a {@code SimpleContainer} an
     * oversized stack. {@code bot_give} did: {@code bot_give {item: "minecraft:potion", count: 3}}
     * on this body reported {@code added: 3, overflow: 0} and left ONE potion in the inventory,
     * because a potion's max stack is 1. The player body was fine — {@code Inventory.add} splits by
     * max-stack — so the two bodies disagreed about what "give me three" means, and only one of them
     * was telling the truth.
     *
     * <p>Chunking here rather than in {@code bot_give} because the lie belongs to this method: any
     * caller of {@link Hands#insert} was exposed to it, and a leftover this returns is now genuinely
     * what did not fit.
     */
    @Override
    public ItemStack insert(final ItemStack stack) {
        int max = Math.min(stack.getMaxStackSize(), inventory.getMaxStackSize());
        if (max <= 0 || stack.getCount() <= max) {
            return inventory.addItem(stack);
        }
        int remaining = stack.getCount();
        while (remaining > 0) {
            int chunk = Math.min(max, remaining);
            ItemStack left = inventory.addItem(stack.copyWithCount(chunk));
            remaining -= chunk - left.getCount();
            if (!left.isEmpty()) {
                break; // the container is full — the rest is honest overflow
            }
        }
        return remaining > 0 ? stack.copyWithCount(remaining) : ItemStack.EMPTY;
    }

    @Override
    public net.minecraft.server.level.ServerPlayer handsPlayer() {
        return null;
    }

    /** Server ticks a dig takes per point of block hardness (stone 1.5 → ~15 ticks). */
    private static final int DIG_TICKS_PER_HARDNESS = 10;

    @Override
    public int digTicks(final net.minecraft.server.level.ServerLevel level,
                        final net.minecraft.world.level.block.state.BlockState state,
                        final net.minecraft.core.BlockPos pos) {
        return Math.max(1, Math.round(state.getDestroySpeed(level, pos) * DIG_TICKS_PER_HARDNESS));
    }

    @Override
    public void digVisual(final net.minecraft.core.BlockPos at, final int ticks) {
        setBeam(BEAM_DIG, Vec3.atCenterOf(at), ticks + 10);
    }

    @Override
    public void clearDigVisual() {
        clearBeam();
    }

    @Override
    public void attackVisual(final Vec3 target) {
        setBeam(BEAM_ATTACK, target, DroneHands.ATTACK_FLASH_TICKS);
        if (this.level() instanceof net.minecraft.server.level.ServerLevel sl) {
            sl.broadcastEntityEvent(this, EVENT_LUNGE);
        }
    }

    // ---- beam ----------------------------------------------------------------

    /** Aim the beam (server side): mode color + world-space target, auto-clearing after {@code ticks}. */
    public void setBeam(final byte mode, final Vec3 target, final int ticks) {
        this.entityData.set(DATA_BEAM_TARGET, new Vector3f((float) target.x, (float) target.y, (float) target.z));
        this.entityData.set(DATA_BEAM_MODE, mode);
        this.beamTicks = ticks;
    }

    /** Switch the beam off (server side). */
    public void clearBeam() {
        this.entityData.set(DATA_BEAM_MODE, BEAM_NONE);
        this.beamTicks = 0;
    }

    /** Current beam mode ({@link #BEAM_NONE} when off). Readable on both sides (synced). */
    public byte beamMode() {
        return this.entityData.get(DATA_BEAM_MODE);
    }

    /** World-space beam target; meaningful only when {@link #beamMode()} is not {@link #BEAM_NONE}. */
    public Vec3 beamTarget() {
        Vector3fc v = this.entityData.get(DATA_BEAM_TARGET);
        return new Vec3(v.x(), v.y(), v.z());
    }

    /** Client-side lunge strength in [0,1] for the render tick, 0 when idle. */
    public float lungeAmount(final float partialTick) {
        if (lungeTicks <= 0) {
            return 0.0F;
        }
        return Math.max(0.0F, (lungeTicks - partialTick) / (float) LUNGE_TICKS);
    }

    @Override
    public void handleEntityEvent(final byte id) {
        if (id == EVENT_LUNGE) {
            this.lungeTicks = LUNGE_TICKS;
        } else {
            super.handleEntityEvent(id);
        }
    }

    @Override
    public void tick() {
        super.tick();
        if (this.level().isClientSide() && lungeTicks > 0) {
            lungeTicks--;
        }
        // World-model ticks-stream row + gait fans (DESIGN.md §13.1/§13.2); covers the walker too.
        com.mattmc.mcptoolkit.wm.Wm.tickEntity(this);
    }

    @Override
    protected void customServerAiStep(final net.minecraft.server.level.ServerLevel level) {
        super.customServerAiStep(level);
        // Transient beams (point/attack) burn down and switch off; dig beams are refreshed by the dig.
        if (beamTicks > 0 && --beamTicks == 0) {
            clearBeam();
        }
    }

    @Override
    protected void registerGoals() {
        // Intentionally empty: toolkit bodies are directly-commanded puppets, not autonomous mobs.
    }

    /**
     * Never written to disk. Toolkit bodies are session-bound — owner slot, inventory, and control
     * state live in memory and die with the session — so a saved copy can only ever resurrect as an
     * ownerless ghost with a silently-emptied inventory (reproduced live 2026-07-22). This also
     * matches what the mod already tells the agent: chunk unload emits {@code drone_removed:
     * died_or_unloaded} and forgets the body. Cargo drops at commanded despawn/replace, session
     * reap, and death; a world quit loses it by design (items spawned during stopServer don't
     * survive the shutdown save — verified live).
     */
    @Override
    public boolean shouldBeSaved() {
        return false;
    }

    /** Death spills the cargo — a body dying in lava must not take forty logs with it. */
    @Override
    protected void dropCustomDeathLoot(final net.minecraft.server.level.ServerLevel level,
                                       final net.minecraft.world.damagesource.DamageSource source,
                                       final boolean killedByPlayer) {
        super.dropCustomDeathLoot(level, source, killedByPlayer);
        for (int i = 0; i < inventory.getContainerSize(); i++) {
            ItemStack st = inventory.getItem(i);
            if (!st.isEmpty()) {
                this.spawnAtLocation(level, st.copy());
                st.setCount(0);
            }
        }
    }

    // ---- the shield (COMBAT_KIT_PLAN.md §4.6, step 4) --------------------------

    /** What this body's shield ate this tick ({@link Shields}), drained once per tick by the watch. */
    private Shields.@org.jspecify.annotations.Nullable Hit blocked;

    /**
     * Report what vanilla's blocking maths decided, so a blow the shield ate WHOLE is still news.
     * See {@link FakePlayerEntity#applyItemBlocking} for the reasoning — it applies here for the
     * same reason it applies there, and the drone gets it for the same reason it got honest
     * {@code shot_landed} reporting in 0.73.0: a caller must not be able to tell the two body
     * families apart by which facts they are capable of stating.
     *
     * <p>The drone is never DISABLED, and that is vanilla's doing rather than an omission here:
     * knocking a shield aside runs through {@code Player.blockUsingItem}, which only players have.
     */
    @Override
    public float applyItemBlocking(final net.minecraft.server.level.ServerLevel level,
                                   final net.minecraft.world.damagesource.DamageSource source,
                                   final float damage) {
        ItemStack blocking = this.getItemBlockingWith();
        float blocked = super.applyItemBlocking(level, source, damage);
        Shields.observe(this, source, damage, blocked, blocking);
        return blocked;
    }

    @Override
    public void mcptkRecordBlock(final Shields.Hit hit) {
        this.blocked = hit;
    }

    @Override
    public Shields.@org.jspecify.annotations.Nullable Hit mcptkTakeBlock() {
        Shields.Hit hit = this.blocked;
        this.blocked = null;
        return hit;
    }
}
