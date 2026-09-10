package com.mattmc.mcptoolkit.preview;

import net.minecraft.network.syncher.EntityDataAccessor;
import net.minecraft.network.syncher.EntityDataSerializers;
import net.minecraft.network.syncher.SynchedEntityData;
import net.minecraft.world.entity.EntityDimensions;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.PathfinderMob;
import net.minecraft.world.entity.Pose;
import net.minecraft.world.entity.ai.attributes.AttributeSupplier;
import net.minecraft.world.entity.ai.attributes.Attributes;
import net.minecraft.world.level.Level;
import org.jspecify.annotations.Nullable;

/**
 * The authoring stage — a body whose only job is to WEAR a model
 * (ENTITY_AUTHORING_DESIGN.md §3). It stands where {@code stage_entity} put it, turns when told,
 * and does nothing else: no goals, no travel, no damage, no persistence.
 *
 * <p><b>The server never parses geometry.</b> It knows a model ID string and a hitbox size, both
 * arguments of the stage call, both synched; the client resolves the ID against the resource
 * manager ({@code client/PreviewModels}). That split is what keeps this class loadable on a
 * dedicated server and keeps the format's ONE interpreter on the side that renders it.
 *
 * <p><b>{@code setNoAi(true)} is the whole "stands still" mechanism</b>, not a decoration:
 * {@code LivingEntity.aiStep} gates both {@code serverAiStep()} and {@code travel()} on
 * {@code isEffectiveAi()}, which {@code Mob} answers with {@code !isNoAi()}. With it set the body
 * never integrates gravity, never drifts, and never runs a goal — which is what a stage on a
 * contact-sheet grid three blocks up in the air has to do. {@code setNoGravity} is belt and braces
 * for anything that reaches {@code travel} by another door.
 *
 * <p>Never persisted: {@code .noSave()} on the type, {@link #shouldBeSaved()} false, and
 * {@code setPersistenceRequired()} so it is not despawned out from under an author who walked away.
 * That also forecloses the landmine in the record — a registered entity type saved into a world that
 * later opens without the mod's renderer is a client crash that survives in the save — because a
 * preview is never in a save to begin with.
 */
public class PreviewEntity extends PathfinderMob {

    /** Which interchange asset this instance wears: {@code assets/mcptoolkit/preview/<id>.json}. */
    private static final EntityDataAccessor<String> DATA_MODEL_ID =
        SynchedEntityData.defineId(PreviewEntity.class, EntityDataSerializers.STRING);
    private static final EntityDataAccessor<Float> DATA_WIDTH =
        SynchedEntityData.defineId(PreviewEntity.class, EntityDataSerializers.FLOAT);
    private static final EntityDataAccessor<Float> DATA_HEIGHT =
        SynchedEntityData.defineId(PreviewEntity.class, EntityDataSerializers.FLOAT);
    /** 0 = hold yaw, 1 = slow turntable — the cheapest "walk around it" a headless author has. */
    private static final EntityDataAccessor<Byte> DATA_SPIN =
        SynchedEntityData.defineId(PreviewEntity.class, EntityDataSerializers.BYTE);
    /** Which authored clip poses it, or "" for the rest pose (§9.2). */
    private static final EntityDataAccessor<String> DATA_CLIP =
        SynchedEntityData.defineId(PreviewEntity.class, EntityDataSerializers.STRING);
    /**
     * Seconds into {@link #DATA_CLIP} to freeze at. NEGATIVE means PLAY, and that sentinel is
     * deliberate: the alternative is a third synched field carrying one bit, and every preview
     * packet pays for it forever so that one number can stay tidy. {@link #PLAY} names it so the
     * sentinel is never spelled as a bare -1 anywhere else.
     */
    private static final EntityDataAccessor<Float> DATA_CLIP_TIME =
        SynchedEntityData.defineId(PreviewEntity.class, EntityDataSerializers.FLOAT);

    /** {@link #clipTime()} value meaning "play the clip", as against scrubbing to an instant. */
    public static final float PLAY = -1.0F;

    /** Which stage slot this is — re-staging the same tag replaces it. Server-side only. */
    private @Nullable String tag;

    public PreviewEntity(final EntityType<? extends PreviewEntity> type, final Level level) {
        super(type, level);
        this.setNoAi(true);              // the whole "stands where staged" mechanism — see javadoc
        this.setNoGravity(true);
        this.setPersistenceRequired();
        this.setInvulnerable(true);
        this.setSilent(true);
    }

    public static AttributeSupplier.Builder createAttributes() {
        return Mob.createMobAttributes().add(Attributes.MAX_HEALTH, 20.0);
    }

    @Override
    protected void defineSynchedData(final SynchedEntityData.Builder builder) {
        super.defineSynchedData(builder);
        builder.define(DATA_MODEL_ID, "");
        builder.define(DATA_WIDTH, 1.0F);
        builder.define(DATA_HEIGHT, 1.0F);
        builder.define(DATA_SPIN, (byte) 0);
        builder.define(DATA_CLIP, "");
        builder.define(DATA_CLIP_TIME, PLAY);
    }

    // ---- what the client reads ------------------------------------------------

    public String modelId() {
        return this.entityData.get(DATA_MODEL_ID);
    }

    public void setModelId(final String id) {
        this.entityData.set(DATA_MODEL_ID, id);
    }

    public String clip() {
        return this.entityData.get(DATA_CLIP);
    }

    public float clipTime() {
        return this.entityData.get(DATA_CLIP_TIME);
    }

    /** Pose it with {@code clip}; {@code time} is seconds, or {@link #PLAY} to run it looping. */
    public void setClip(final String clip, final float time) {
        this.entityData.set(DATA_CLIP, clip);
        this.entityData.set(DATA_CLIP_TIME, time);
    }

    public boolean spinning() {
        return this.entityData.get(DATA_SPIN) != 0;
    }

    public void setSpinning(final boolean spin) {
        this.entityData.set(DATA_SPIN, (byte) (spin ? 1 : 0));
    }

    public float stageWidth() {
        return this.entityData.get(DATA_WIDTH);
    }

    public float stageHeight() {
        return this.entityData.get(DATA_HEIGHT);
    }

    /** Set the hitbox the stage occupies. The plugin computes it from the geometry bounds (§4.3). */
    public void setStageSize(final float width, final float height) {
        this.entityData.set(DATA_WIDTH, width);
        this.entityData.set(DATA_HEIGHT, height);
        this.refreshDimensions();
    }

    public @Nullable String tag() {
        return this.tag;
    }

    public void setTag(final @Nullable String tag) {
        this.tag = tag;
    }

    // ---- a body sized by its arguments ----------------------------------------

    /**
     * {@code LivingEntity.getDimensions} is final and reads {@code getDefaultDimensions(pose)
     * .scale(getScale())} — so this is the hook for the synched size, and the {@code scale} argument
     * rides the vanilla {@code minecraft:scale} attribute on top of it, scaling render and hitbox
     * together the way a scaled mob already does.
     */
    @Override
    protected EntityDimensions getDefaultDimensions(final Pose pose) {
        return EntityDimensions.scalable(this.stageWidth(), this.stageHeight());
    }

    @Override
    public void onSyncedDataUpdated(final EntityDataAccessor<?> accessor) {
        if (DATA_WIDTH.equals(accessor) || DATA_HEIGHT.equals(accessor)) {
            this.refreshDimensions(); // the CLIENT half of setStageSize — its box must follow too
        }
        super.onSyncedDataUpdated(accessor);
    }

    // ---- inert on every axis a stage can be disturbed on ----------------------

    @Override
    public boolean shouldBeSaved() {
        return false;
    }

    /** A shoved stage is a moved subject: a contact sheet must not drift as mobs walk through it. */
    @Override
    public boolean isPushable() {
        return false;
    }

    @Override
    public void push(final double xa, final double ya, final double za) {
        // Inert on purpose — see isPushable.
    }

    @Override
    public boolean isAffectedByFluids() {
        return false;
    }
}
