package com.mattmc.mcptoolkit.client;

import com.mattmc.mcptoolkit.drone.WalkerEntity;
import net.fabricmc.api.EnvType;
import net.fabricmc.api.Environment;
import net.minecraft.client.model.HumanoidModel;
import net.minecraft.client.model.geom.ModelLayers;
import net.minecraft.client.renderer.entity.EntityRendererProvider;
import net.minecraft.client.renderer.entity.HumanoidMobRenderer;
import net.minecraft.client.renderer.entity.state.HumanoidRenderState;
import net.minecraft.resources.Identifier;

/**
 * The walker rendered as what it IS: a player-shaped body (SURVIVAL_MODE_PLAN.md — the survival
 * smoke's first complaint was "the agent body is still a drone": the walker had been reusing the
 * drone's ball renderer). Vanilla player geometry (the PLAYER model layer) with the default wide
 * skin; the nameplate above it comes from the session-id custom name set at spawn.
 */
@Environment(EnvType.CLIENT)
public class WalkerRenderer extends HumanoidMobRenderer<WalkerEntity, HumanoidRenderState, HumanoidModel<HumanoidRenderState>> {
    private static final Identifier SKIN =
        Identifier.withDefaultNamespace("textures/entity/player/wide/steve.png");

    public WalkerRenderer(final EntityRendererProvider.Context context) {
        super(context, new HumanoidModel<>(context.bakeLayer(ModelLayers.PLAYER)), 0.5F);
    }

    @Override
    public HumanoidRenderState createRenderState() {
        return new HumanoidRenderState();
    }

    @Override
    public Identifier getTextureLocation(final HumanoidRenderState state) {
        return SKIN;
    }
}
