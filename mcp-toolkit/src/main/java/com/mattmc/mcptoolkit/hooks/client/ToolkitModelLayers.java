package com.mattmc.mcptoolkit.hooks.client;

import net.fabricmc.api.EnvType;
import net.fabricmc.api.Environment;
import net.minecraft.client.model.geom.ModelLayerLocation;
import net.minecraft.client.model.geom.builders.LayerDefinition;

import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Supplier;

/**
 * Extra model layers (fabric {@code ModelLayerRegistry} replacement). Registered suppliers are baked
 * into the root map by {@code LayerDefinitionsMixin} each time {@code LayerDefinitions.createRoots()}
 * runs (it feeds {@code EntityModelSet}, so this covers every bake including resource reloads).
 */
@Environment(EnvType.CLIENT)
public final class ToolkitModelLayers {
    private ToolkitModelLayers() {}

    private static final Map<ModelLayerLocation, Supplier<LayerDefinition>> EXTRA = new ConcurrentHashMap<>();

    public static void register(final ModelLayerLocation location, final Supplier<LayerDefinition> definition) {
        EXTRA.put(location, definition);
    }

    /** Called by the mixin: vanilla's freshly built root map + everything registered here. */
    public static Map<ModelLayerLocation, LayerDefinition> merge(final Map<ModelLayerLocation, LayerDefinition> vanilla) {
        if (EXTRA.isEmpty()) {
            return vanilla;
        }
        Map<ModelLayerLocation, LayerDefinition> out = new HashMap<>(vanilla);
        EXTRA.forEach((loc, def) -> out.put(loc, def.get()));
        return out;
    }
}
