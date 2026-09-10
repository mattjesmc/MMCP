package com.mattmc.mcptoolkit.client;

import com.mattmc.mcptoolkit.McpToolkit;
import net.fabricmc.api.EnvType;
import net.fabricmc.api.Environment;
import net.minecraft.client.renderer.entity.RenderLayerParent;
import net.minecraft.client.renderer.entity.layers.EyesLayer;
import net.minecraft.client.renderer.rendertype.RenderType;
import net.minecraft.client.renderer.rendertype.RenderTypes;
import net.minecraft.resources.Identifier;

/**
 * Draws the drone's eye at full brightness — the same emissive trick vanilla uses for spider/enderman
 * eyes. The eye texture is transparent everywhere except the lens, so only the lens glows.
 */
@Environment(EnvType.CLIENT)
public class DroneEyesLayer extends EyesLayer<DroneRenderState, DroneModel> {
    private static final RenderType EYES = RenderTypes.eyes(
        Identifier.fromNamespaceAndPath(McpToolkit.MOD_ID, "textures/entity/drone_eye.png"));

    public DroneEyesLayer(final RenderLayerParent<DroneRenderState, DroneModel> parent) {
        super(parent);
    }

    @Override
    public RenderType renderType() {
        return EYES;
    }
}
