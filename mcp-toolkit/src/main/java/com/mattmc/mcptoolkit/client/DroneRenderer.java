package com.mattmc.mcptoolkit.client;

import com.mojang.blaze3d.vertex.PoseStack;
import com.mojang.blaze3d.vertex.VertexConsumer;
import com.mojang.math.Axis;
import com.mattmc.mcptoolkit.McpToolkit;
import com.mattmc.mcptoolkit.drone.BotBodyEntity;
import com.mattmc.mcptoolkit.drone.DroneEntity;
import net.fabricmc.api.EnvType;
import net.fabricmc.api.Environment;
import net.minecraft.client.renderer.SubmitNodeCollector;
import net.minecraft.client.renderer.entity.EntityRendererProvider;
import net.minecraft.client.renderer.entity.MobRenderer;
import net.minecraft.client.renderer.rendertype.RenderType;
import net.minecraft.client.renderer.rendertype.RenderTypes;
import net.minecraft.client.renderer.state.level.CameraRenderState;
import net.minecraft.client.renderer.texture.OverlayTexture;
import net.minecraft.resources.Identifier;
import net.minecraft.util.Mth;
import net.minecraft.world.phys.Vec3;

/**
 * Renders the drone body, the emissive eye layer, and the laser beam. The beam is the drone's action
 * language (guardian-beam technique: crossed scrolling ribbons from the eye to a world-space target),
 * color-coded by mode: white-cyan pointer ("look here"), orange dig, red attack.
 */
@Environment(EnvType.CLIENT)
public class DroneRenderer extends MobRenderer<BotBodyEntity, DroneRenderState, DroneModel> {
    private static final Identifier TEXTURE =
        Identifier.fromNamespaceAndPath(McpToolkit.MOD_ID, "textures/entity/drone.png");
    private static final RenderType BEAM_RENDER_TYPE = RenderTypes.entityCutout(
        Identifier.fromNamespaceAndPath(McpToolkit.MOD_ID, "textures/entity/drone_beam.png"));

    /** Beam ribbon half-width in blocks — a thin laser, not the guardian's fat ray. */
    private static final float BEAM_RADIUS = 0.09F;
    private static final int FULL_BRIGHT = 15728880;

    public DroneRenderer(final EntityRendererProvider.Context context) {
        super(context, new DroneModel(context.bakeLayer(McpToolkitClient.DRONE_LAYER)), 0.3F);
        this.addLayer(new DroneEyesLayer(this));
    }

    @Override
    public Identifier getTextureLocation(final DroneRenderState state) {
        return TEXTURE;
    }

    @Override
    public DroneRenderState createRenderState() {
        return new DroneRenderState();
    }

    @Override
    public void extractRenderState(final BotBodyEntity entity, final DroneRenderState state,
                                   final float partialTicks) {
        super.extractRenderState(entity, state, partialTicks);
        state.lunge = entity.lungeAmount(partialTicks);
        state.beamMode = entity.beamMode();
        state.beamVector = state.beamMode == DroneEntity.BEAM_NONE ? null
            : entity.beamTarget().subtract(entity.getEyePosition(partialTicks));
    }

    @Override
    public void submit(final DroneRenderState state, final PoseStack poseStack,
                       final SubmitNodeCollector submitNodeCollector, final CameraRenderState camera) {
        super.submit(state, poseStack, submitNodeCollector, camera);
        Vec3 beam = state.beamVector;
        if (beam != null && beam.lengthSqr() > 1.0e-4) {
            poseStack.pushPose();
            poseStack.translate(0.0F, state.eyeHeight, 0.0F);
            renderBeam(poseStack, submitNodeCollector, beam, state.ageInTicks, colorFor(state.beamMode));
            poseStack.popPose();
        }
    }

    /** Per-mode beam tint {r,g,b} (multiplies the grayscale beam texture). */
    private static int[] colorFor(final byte mode) {
        return switch (mode) {
            case DroneEntity.BEAM_DIG -> new int[] {255, 150, 40};    // orange: working
            case DroneEntity.BEAM_ATTACK -> new int[] {255, 60, 50};  // red: hostile flash
            default -> new int[] {170, 255, 255};                     // white-cyan: pointer
        };
    }

    /**
     * Two crossed scrolling ribbons from the local origin (the eye) along {@code beamVector} — the
     * guardian's beam geometry, thinner and tinted per mode, drawn full-bright.
     */
    private static void renderBeam(final PoseStack poseStack, final SubmitNodeCollector collector,
                                   Vec3 beamVector, final float timeInTicks, final int[] rgb) {
        float length = (float) beamVector.length();
        beamVector = beamVector.normalize();
        float xRot = (float) Math.acos(beamVector.y);
        float yRot = (float) (Math.PI / 2) - (float) Math.atan2(beamVector.z, beamVector.x);
        poseStack.mulPose(Axis.YP.rotationDegrees(yRot * (180.0F / (float) Math.PI)));
        poseStack.mulPose(Axis.XP.rotationDegrees(xRot * (180.0F / (float) Math.PI)));

        float spin = timeInTicks * -0.06F;
        float texVOff = timeInTicks * 0.08F % 1.0F;
        int red = rgb[0];
        int green = rgb[1];
        int blue = rgb[2];
        float wx = Mth.cos(spin + (float) Math.PI) * BEAM_RADIUS;
        float wz = Mth.sin(spin + (float) Math.PI) * BEAM_RADIUS;
        float ex = Mth.cos(spin) * BEAM_RADIUS;
        float ez = Mth.sin(spin) * BEAM_RADIUS;
        float nx = Mth.cos(spin + (float) (Math.PI / 2)) * BEAM_RADIUS;
        float nz = Mth.sin(spin + (float) (Math.PI / 2)) * BEAM_RADIUS;
        float sx = Mth.cos(spin + (float) (Math.PI * 3.0 / 2.0)) * BEAM_RADIUS;
        float sz = Mth.sin(spin + (float) (Math.PI * 3.0 / 2.0)) * BEAM_RADIUS;
        float top = length;
        float minV = -1.0F + texVOff;
        float maxV = minV + length * 2.5F;
        collector.submitCustomGeometry(poseStack, BEAM_RENDER_TYPE, (pose, buffer) -> {
            vertex(buffer, pose, wx, top, wz, red, green, blue, 0.4999F, maxV);
            vertex(buffer, pose, wx, 0.0F, wz, red, green, blue, 0.4999F, minV);
            vertex(buffer, pose, ex, 0.0F, ez, red, green, blue, 0.0F, minV);
            vertex(buffer, pose, ex, top, ez, red, green, blue, 0.0F, maxV);
            vertex(buffer, pose, nx, top, nz, red, green, blue, 0.4999F, maxV);
            vertex(buffer, pose, nx, 0.0F, nz, red, green, blue, 0.4999F, minV);
            vertex(buffer, pose, sx, 0.0F, sz, red, green, blue, 0.0F, minV);
            vertex(buffer, pose, sx, top, sz, red, green, blue, 0.0F, maxV);
        });
    }

    private static void vertex(final VertexConsumer builder, final PoseStack.Pose pose,
                               final float x, final float y, final float z,
                               final int red, final int green, final int blue,
                               final float u, final float v) {
        builder.addVertex(pose, x, y, z)
            .setColor(red, green, blue, 255)
            .setUv(u, v)
            .setOverlay(OverlayTexture.NO_OVERLAY)
            .setLight(FULL_BRIGHT)
            .setNormal(pose, 0.0F, 1.0F, 0.0F);
    }
}
