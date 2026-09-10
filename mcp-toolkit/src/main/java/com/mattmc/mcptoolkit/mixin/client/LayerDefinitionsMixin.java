package com.mattmc.mcptoolkit.mixin.client;

import com.mattmc.mcptoolkit.hooks.client.ToolkitModelLayers;
import net.minecraft.client.model.geom.LayerDefinitions;
import net.minecraft.client.model.geom.ModelLayerLocation;
import net.minecraft.client.model.geom.builders.LayerDefinition;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

import java.util.Map;

/**
 * Bakes {@link ToolkitModelLayers} registrations into the root map. createRoots() feeds
 * EntityModelSet, so this covers every bake.
 */
@Mixin(LayerDefinitions.class)
public abstract class LayerDefinitionsMixin {

    @Inject(method = "createRoots", at = @At("RETURN"), cancellable = true)
    private static void mcptoolkit$addLayers(final CallbackInfoReturnable<Map<ModelLayerLocation, LayerDefinition>> cir) {
        cir.setReturnValue(ToolkitModelLayers.merge(cir.getReturnValue()));
    }
}
