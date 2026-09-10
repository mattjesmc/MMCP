package com.mattmc.mcptoolkit.client;

import net.fabricmc.api.EnvType;
import net.fabricmc.api.Environment;
import net.minecraft.client.model.EntityModel;
import net.minecraft.client.model.geom.ModelPart;
import net.minecraft.client.model.geom.PartPose;
import net.minecraft.client.model.geom.builders.CubeListBuilder;
import net.minecraft.client.model.geom.builders.LayerDefinition;
import net.minecraft.client.model.geom.builders.MeshDefinition;
import net.minecraft.client.model.geom.builders.PartDefinition;
import net.minecraft.util.Mth;

/**
 * The drone: a compact hovering body ({@code body}) with a single eye lens bulging from its front
 * ({@code eye}). The whole body tilts with the drone's pitch so the eye visibly points where it looks
 * (yaw is applied by the renderer via the entity's body rotation); a gentle idle bob gives it life. The
 * eye's glow is a separate emissive pass — see {@link DroneEyesLayer}.
 *
 * <p>Hand-built for v1; can be replaced with a Blockbench export through the push pipeline later. UV
 * layout on a 64×64 sheet: eye cube at texOffs(0,0), body cube at texOffs(20,0) (non-overlapping).
 */
@Environment(EnvType.CLIENT)
public class DroneModel extends EntityModel<DroneRenderState> {
    private final ModelPart body;

    public DroneModel(final ModelPart root) {
        super(root);
        this.body = root.getChild("body");
    }

    public static LayerDefinition createBodyLayer() {
        MeshDefinition mesh = new MeshDefinition();
        PartDefinition root = mesh.getRoot();

        PartDefinition body = root.addOrReplaceChild(
            "body",
            CubeListBuilder.create().texOffs(20, 0).addBox(-5.0F, -5.0F, -5.0F, 10.0F, 9.0F, 10.0F),
            PartPose.offset(0.0F, 18.0F, 0.0F));

        // Eye lens on the front (-Z) face, protruding slightly.
        body.addOrReplaceChild(
            "eye",
            CubeListBuilder.create().texOffs(0, 0).addBox(-2.0F, -2.0F, -2.0F, 4.0F, 4.0F, 4.0F),
            PartPose.offset(0.0F, -1.0F, -5.0F));

        return LayerDefinition.create(mesh, 64, 64);
    }

    @Override
    public void setupAnim(final DroneRenderState state) {
        super.setupAnim(state);
        // Tilt the whole body to the look pitch so the eye aims correctly.
        this.body.xRot = state.xRot * ((float) Math.PI / 180.0F);
        // Subtle hover bob.
        this.body.y = 18.0F + Mth.sin(state.ageInTicks * 0.1F) * 0.6F;
        // Attack lunge: a quick nose-dip-and-jab toward the target, fading over a few ticks.
        if (state.lunge > 0.0F) {
            this.body.xRot += state.lunge * 0.55F;
            this.body.z = -state.lunge * 2.5F;
        } else {
            this.body.z = 0.0F;
        }
    }
}
