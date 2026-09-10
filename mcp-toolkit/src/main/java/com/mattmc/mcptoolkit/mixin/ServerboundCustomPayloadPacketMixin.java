package com.mattmc.mcptoolkit.mixin;

import com.mattmc.mcptoolkit.wm.HumanFramePayload;
import net.minecraft.network.FriendlyByteBuf;
import net.minecraft.network.protocol.common.ServerboundCustomPayloadPacket;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.ModifyArg;

import java.util.List;

/**
 * Registers {@code HumanFramePayload}'s codec in the serverbound custom-payload registry — the
 * toolkit's first real networking, fabric-api-free. Vanilla builds the codec list in the packet's
 * static initializer as a MUTABLE ArrayList passed through {@code Util.make(list, types -> {})};
 * that empty consumer is the designed-for-modding seam (fabric-api injects its registrations at the
 * same spot). This {@code @ModifyArg} appends our entry to the list argument before the codec map
 * is built from it, on whichever side loads the class — the client needs it to ENCODE, the server
 * to DECODE, and both load this common mixin.
 *
 * <p>Sides without the mod are safe by vanilla design: an unknown payload id falls back to
 * {@code DiscardedPayload} (32 KB cap) and the empty {@code handleCustomPayload} ignores it.
 *
 * <p><b>On NeoForge this is necessary and not sufficient</b>, which is why it still applies there.
 * Vanilla's map is consulted before NeoForge's registry, so the codec below is the one that runs on
 * both loaders — but NeoForge refuses to SEND a payload whose channel was never negotiated, and only
 * a {@code RegisterPayloadHandlersEvent} registration negotiates one. {@code NeoForgePayloads} is
 * that half. See {@code CROSS_LOADER_DESIGN.md} §14.
 */
@Mixin(ServerboundCustomPayloadPacket.class)
public abstract class ServerboundCustomPayloadPacketMixin {

    @SuppressWarnings("unchecked")
    @ModifyArg(
        method = "<clinit>",
        at = @At(
            value = "INVOKE",
            target = "Lnet/minecraft/util/Util;make(Ljava/lang/Object;Ljava/util/function/Consumer;)Ljava/lang/Object;"),
        index = 0)
    private static Object mcptoolkit$registerHumanFrame(final Object list) {
        ((List<CustomPacketPayload.TypeAndCodec<? super FriendlyByteBuf, ?>>) list)
            .add(new CustomPacketPayload.TypeAndCodec<>(
                HumanFramePayload.TYPE, HumanFramePayload.STREAM_CODEC));
        return list;
    }
}
