package com.mattmc.mcptoolkit.fabric;

import com.mattmc.mcptoolkit.client.McpToolkitClient;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.api.EnvType;
import net.fabricmc.api.Environment;

/**
 * The Fabric {@code client} entrypoint, and nothing else — the client counterpart of
 * {@link FabricEntry}. See that class for why the interface lives on a shim rather than on
 * {@link McpToolkitClient}.
 */
@Environment(EnvType.CLIENT)
public final class FabricClientEntry implements ClientModInitializer {

    @Override
    public void onInitializeClient() {
        McpToolkitClient.init();
    }
}
