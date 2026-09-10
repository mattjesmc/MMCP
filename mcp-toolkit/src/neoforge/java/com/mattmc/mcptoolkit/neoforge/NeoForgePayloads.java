package com.mattmc.mcptoolkit.neoforge;

import com.mattmc.mcptoolkit.wm.HumanFramePayload;
import com.mattmc.mcptoolkit.wm.WmHuman;
import net.minecraft.server.level.ServerPlayer;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.neoforge.network.event.RegisterPayloadHandlersEvent;
import net.neoforged.neoforge.network.registration.PayloadRegistrar;

/**
 * The toolkit's serverbound payload, registered the way NeoForge requires — the second half of a
 * registration whose first half is a vanilla mixin, and the reason human input capture works here at
 * all (CROSS_LOADER_DESIGN.md section 14).
 *
 * <h2>Why the vanilla seam was not enough</h2>
 *
 * <p>{@code ServerboundCustomPayloadPacketMixin} adds {@code HumanFramePayload}'s codec to vanilla's
 * own known-types list, which is the whole mechanism on Fabric: it makes the frame encodable on the
 * client and decodable on the server. NeoForge puts a layer ABOVE that. Before a custom payload
 * leaves the client, {@code NetworkRegistry.checkPacket} refuses any id that is neither
 * {@code minecraft:} nor a NEGOTIATED channel, and the negotiation only knows about payloads
 * declared through this event — so the frame was written, refused at the send, and the refusal was
 * thrown once per client tick. Registering here is what makes the channel exist.
 *
 * <p>The registration is not a duplicate of the mixin's, even though both name the same type and the
 * same codec. Vanilla's map is consulted first and NeoForge's registry is the fallback, so the codec
 * that actually runs is still the mixin's — this entry exists for the negotiation and the handler,
 * which vanilla's map has no notion of. Leaving the mixin applied on both loaders is deliberate: it
 * is one mixin config for one jar, and the thing that genuinely must not run twice is the DELIVERY,
 * which stands down through {@code LoaderPlatform#dispatchesCustomPayloads}.
 *
 * <h2>Ordering is preserved</h2>
 *
 * <p>{@code WmHuman}'s cross-check depends on the frame being consumed after the same client tick's
 * input packets. {@code PayloadRegistrar} wraps the handler in {@code MainThreadPayloadHandler},
 * which calls {@code enqueueWork} — the connection's own main-thread queue, in packet order, exactly
 * what the Fabric path's explicit {@code server.execute} hop gets.
 */
final class NeoForgePayloads {

    /**
     * The channel version. Not the toolkit's version: it names the WIRE format, so it moves when
     * {@code HumanFramePayload}'s layout does and stays put for every release that does not touch
     * it. The payload's own {@code schema} field is the finer-grained form of the same care.
     */
    private static final String VERSION = "1";

    private NeoForgePayloads() {}

    static void register(final IEventBus modBus) {
        modBus.addListener(RegisterPayloadHandlersEvent.class, event -> {
            PayloadRegistrar registrar = event.registrar(VERSION);
            registrar.playToServer(
                HumanFramePayload.TYPE,
                HumanFramePayload.STREAM_CODEC,
                (payload, context) -> {
                    // Serverbound, so this is the sending player - but the cast is checked rather
                    // than assumed: a payload arriving on the wrong side must cost nothing.
                    if (context.player() instanceof ServerPlayer player) {
                        WmHuman.noteClientFrame(player, payload);
                    }
                });
        });
    }
}
