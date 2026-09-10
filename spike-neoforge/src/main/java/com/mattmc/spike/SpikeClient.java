package com.mattmc.spike;

import net.minecraft.client.renderer.entity.EntityRenderers;
import net.minecraft.client.renderer.entity.NoopRenderer;
import net.minecraft.resources.Identifier;
import net.minecraft.world.entity.EntityType;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.fml.event.lifecycle.FMLClientSetupEvent;
import net.neoforged.neoforge.client.event.ClientPlayerNetworkEvent;
import net.neoforged.neoforge.common.NeoForge;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The half of the spike that a single-process test cannot answer.
 *
 * <p>A type registered outside the loader's own window might still be missing from the registry
 * SYNC a server sends a joining client — which is invisible in singleplayer and fatal on a
 * dedicated server. So: log on the client the moment it finishes logging in. Reaching that point at
 * all is most of the answer, because NeoForge refuses a connection whose registries do not
 * reconcile; what the line SAYS is the rest of it.
 */
public final class SpikeClient {
    private static final Logger LOG = LoggerFactory.getLogger("spike");

    private SpikeClient() {}

    static void init(final IEventBus modBus) {
        modBus.addListener(FMLClientSetupEvent.class, e -> registerRenderers());
        NeoForge.EVENT_BUS.addListener(ClientPlayerNetworkEvent.LoggingIn.class, e -> {
            LOG.info("[spike] CLIENT joined a server - registry sync did NOT reject the connection");
            SpikeEntities.report("CLIENT after join");
        });
        NeoForge.EVENT_BUS.addListener(ClientPlayerNetworkEvent.LoggingOut.class,
            e -> LOG.info("[spike] CLIENT logged out"));
    }

    /**
     * Nothing to do with the registration question, and not optional: a registered entity type with
     * no renderer crashes the client on the render frame one becomes visible, and the entity is
     * saved, so the world crashes on every join afterwards. See {@link SpikeEntity}.
     *
     * <p>Both doors get a renderer, or a door that opened would still be a trap. Fetched from the
     * registry rather than held in a field because {@link SpikeEntities} deliberately keeps no
     * static type references — and via {@code typeOrNull}, so a door that did NOT open here (which
     * is the outcome the spike exists to detect) is skipped rather than turned into a pig.
     *
     * <p>{@code FMLClientSetupEvent} is early enough for {@code EntityRenderers.register}, which is
     * the same event and the same vanilla call {@code McpToolkitClient.init()} uses on this loader.
     */
    private static void registerRenderers() {
        for (final Identifier id : new Identifier[] {SpikeEntities.MIXIN_DOOR_ID, SpikeEntities.EVENT_DOOR_ID}) {
            final EntityType<SpikeEntity> type = SpikeEntities.typeOrNull(id);
            if (type == null) {
                LOG.warn("[spike] no renderer for {} - the type is not registered", id);
                continue;
            }
            EntityRenderers.register(type, NoopRenderer::new);
            LOG.info("[spike] renderer registered for {} (NoopRenderer)", id);
        }
    }
}
