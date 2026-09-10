package com.mattmc.spike;

import net.neoforged.api.distmarker.Dist;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.fml.common.Mod;
import net.neoforged.neoforge.common.NeoForge;
import net.neoforged.neoforge.event.server.ServerStartedEvent;
import net.neoforged.neoforge.registries.RegisterEvent;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The NeoForge entrypoint. Logs the registry state at every point where it could have changed, so
 * the ORDER of the two doors is visible and not inferred.
 */
@Mod("spike")
public class SpikeMod {
    private static final Logger LOG = LoggerFactory.getLogger("spike");

    public SpikeMod(final IEventBus modBus, final Dist dist) {
        // By the time a @Mod constructor runs, BuiltInRegistries.bootStrap() has already happened on
        // vanilla's schedule. Whether the mixin got in there is therefore already decided.
        SpikeEntities.report("mod-constructor (dist=" + dist + ")");

        modBus.addListener(RegisterEvent.class, e -> {
            if (e.getRegistryKey().equals(net.minecraft.core.registries.Registries.ENTITY_TYPE)) {
                LOG.info("[spike] DOOR 2: RegisterEvent for ENTITY_TYPE fired");
                SpikeEntities.registerViaEvent();
                SpikeEntities.report("after RegisterEvent");
            }
        });

        NeoForge.EVENT_BUS.addListener(ServerStartedEvent.class,
            e -> SpikeEntities.report("SERVER started"));

        if (dist == Dist.CLIENT) {
            SpikeClient.init(modBus);
        }
    }
}
