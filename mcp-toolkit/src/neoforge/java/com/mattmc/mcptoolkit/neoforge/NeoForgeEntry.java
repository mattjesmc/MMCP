package com.mattmc.mcptoolkit.neoforge;

import com.mattmc.mcptoolkit.McpToolkit;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.fml.common.Mod;
import net.neoforged.fml.event.lifecycle.FMLCommonSetupEvent;

/**
 * The NeoForge entrypoint — the counterpart of {@code fabric/FabricEntry}, and the only class in the
 * toolkit that names {@code @Mod}. See {@code FabricEntry} for why the loader interface lives on a
 * shim rather than on {@link McpToolkit} itself.
 *
 * <h2>Why {@code FMLCommonSetupEvent} and not the constructor</h2>
 *
 * <p>{@link McpToolkit#init()} opens with {@code DroneEntities.bootstrap()}, which asserts the body
 * entity types exist, and ends by starting the bridge — so it must run after registration is settled
 * and after the game is far enough along to be worth serving. A {@code @Mod} constructor runs before
 * {@code RegisterEvent}, so calling it there would assert against a registry that has not finished.
 *
 * <p><b>No {@code RegisterEvent} listener is needed.</b> That was the open question Stage 0 answered:
 * NeoForge calls {@code BuiltInRegistries.bootStrap()} on vanilla's own schedule and does not
 * redirect it the way fabric-registry-sync does, so {@code BuiltInRegistriesMixin} has already put
 * the types in by the time anything here runs — NeoForge behaves like Fabric <em>without</em>
 * fabric-api. {@code DroneEntities.bootstrap()} keeps its second-window fallback anyway; it costs an
 * idempotent check and it is the reason this class does not have to care.
 */
@Mod("mcptoolkit")
public final class NeoForgeEntry {

    public NeoForgeEntry(final IEventBus modBus, final Dist dist) {
        modBus.addListener(FMLCommonSetupEvent.class, e -> McpToolkit.init());
        // Both sides: the client sends the frame, the server is handed it. RegisterPayloadHandlersEvent
        // fires on the mod bus before either, and a registration missing on one side is a channel that
        // never negotiates.
        NeoForgePayloads.register(modBus);
        if (dist == Dist.CLIENT) {
            // A separate class so this one never loads a client type on a dedicated server. NeoForge
            // does not strip by side the way Fabric does, so the guard has to be a real one.
            NeoForgeClientEntry.register(modBus);
        }
    }
}
