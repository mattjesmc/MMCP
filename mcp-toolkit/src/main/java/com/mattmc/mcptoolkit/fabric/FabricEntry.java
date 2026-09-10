package com.mattmc.mcptoolkit.fabric;

import com.mattmc.mcptoolkit.McpToolkit;
import net.fabricmc.api.ModInitializer;

/**
 * The Fabric {@code main} entrypoint, and nothing else.
 *
 * <p>This class exists so that {@link McpToolkit} — which holds {@code MOD_ID} and {@code LOGGER} and
 * is therefore loaded by essentially every code path in the toolkit — does not itself name a Fabric
 * type. On a loader where {@code net.fabricmc.api.ModInitializer} is absent, a class that implements
 * it cannot be loaded at all; putting that interface on the class 41 files reference would turn a
 * missing loader API into a total failure. Here it costs nothing, because nothing references this
 * class except Fabric's own entrypoint lookup.
 *
 * <p>Deliberately does <em>not</em> call {@code Platform.install(new FabricPlatform())}. The probe in
 * {@code Platform} has to work anyway — several mixins can reach the platform before any entrypoint
 * runs — so installing here would only give the real mechanism a second, easier path that masks its
 * bugs on the one loader where they would be cheapest to find.
 *
 * <p>See {@code CROSS_LOADER_DESIGN.md}.
 */
public final class FabricEntry implements ModInitializer {

    @Override
    public void onInitialize() {
        McpToolkit.init();
    }
}
