package com.mattmc.mcptoolkit.neoforge;

import com.mattmc.mcptoolkit.client.McpToolkitClient;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.fml.event.lifecycle.FMLClientSetupEvent;

/**
 * Client half of the NeoForge entrypoint, kept in its own class so {@link NeoForgeEntry} never
 * references a client type on a dedicated server. NeoForge does not strip classes by side the way
 * Fabric's {@code @Environment} does, so the {@code Dist} check in the caller is the whole guard and
 * the split is what makes it effective.
 */
final class NeoForgeClientEntry {

    private NeoForgeClientEntry() {}

    static void register(final IEventBus modBus) {
        modBus.addListener(FMLClientSetupEvent.class, e -> McpToolkitClient.init());
    }
}
