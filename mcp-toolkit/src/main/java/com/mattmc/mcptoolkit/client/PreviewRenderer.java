package com.mattmc.mcptoolkit.client;

import com.mattmc.mcptoolkit.preview.PreviewEntity;
import com.mojang.blaze3d.vertex.PoseStack;
import net.fabricmc.api.EnvType;
import net.fabricmc.api.Environment;
import net.minecraft.client.renderer.SubmitNodeCollector;
import net.minecraft.client.renderer.entity.EntityRendererProvider;
import net.minecraft.client.renderer.entity.MobRenderer;
import net.minecraft.client.renderer.state.level.CameraRenderState;
import net.minecraft.resources.Identifier;

/**
 * Renders a staged preview wearing whatever geometry its model id resolves to.
 *
 * <p><b>The model field swap</b> is the mechanism menagerie proved and this reuses:
 * {@code LivingEntityRenderer.model} is {@code protected}, non-final, and read only inside
 * {@code submit} — where the node collector takes a reference and defers the actual draw. So one
 * renderer instance can serve many entities wearing different models: point the field at this
 * entity's cached bake, then delegate. Everything else — render type, layers, outline, shadow,
 * nameplate — is inherited vanilla behaviour, which is the point of judging the GAME's rendering
 * rather than a preview the tooling drew itself.
 *
 * <p>The construction-time model is the error cube, because a renderer is built long before any
 * model id exists, and "no geometry yet" should look like exactly what it is.
 */
@Environment(EnvType.CLIENT)
public class PreviewRenderer extends MobRenderer<PreviewEntity, PreviewRenderState, PreviewModel> {

    /** Turntable rate in degrees per tick — a full revolution in 12 seconds. */
    private static final float SPIN_DEGREES_PER_TICK = 1.5F;

    public PreviewRenderer(final EntityRendererProvider.Context context) {
        super(context, PreviewModels.errorModel(), 0.4F);
    }

    @Override
    public PreviewRenderState createRenderState() {
        return new PreviewRenderState();
    }

    @Override
    public void extractRenderState(final PreviewEntity entity, final PreviewRenderState state,
                                   final float partialTicks) {
        super.extractRenderState(entity, state, partialTicks);
        state.modelId = entity.modelId();
        state.clip = entity.clip();
        state.clipTime = entity.clipTime();
        if (entity.spinning()) {
            // Client-side turntable: the body itself never moves (it has no AI at all), so the spin
            // is a render-time rotation. Both angles are written — the base extract derives yRot as
            // head-minus-body, and leaving that offset would swivel a head the geometry may not have.
            state.bodyRot = state.ageInTicks * SPIN_DEGREES_PER_TICK % 360.0F;
            state.yRot = 0.0F;
        }
    }

    @Override
    public Identifier getTextureLocation(final PreviewRenderState state) {
        return PreviewModels.textureOf(state.modelId);
    }

    @Override
    public void submit(final PreviewRenderState state, final PoseStack poseStack,
                       final SubmitNodeCollector submitNodeCollector, final CameraRenderState camera) {
        this.model = PreviewModels.modelOf(state.modelId);
        super.submit(state, poseStack, submitNodeCollector, camera);
    }
}
