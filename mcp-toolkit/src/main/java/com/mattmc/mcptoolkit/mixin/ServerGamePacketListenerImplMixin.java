package com.mattmc.mcptoolkit.mixin;

import com.mattmc.mcptoolkit.platform.Platform;
import com.mattmc.mcptoolkit.wm.HumanFramePayload;
import com.mattmc.mcptoolkit.wm.WmHuman;
import net.minecraft.network.protocol.common.ServerboundCustomPayloadPacket;
import net.minecraft.network.protocol.game.ServerboundSetCarriedItemPacket;
import net.minecraft.network.protocol.game.ServerboundSwingPacket;
import net.minecraft.network.protocol.game.ServerboundUseItemOnPacket;
import net.minecraft.network.protocol.game.ServerboundUseItemPacket;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.network.ServerGamePacketListenerImpl;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * Press-edge taps for §15 human capture ({@code WmHuman}): swing = attack edge, use-item packets =
 * use edge, carried-item = hotbar selection. TAIL injection on purpose — the handlers re-dispatch
 * off the netty thread at HEAD ({@code ensureRunningOnSameThread} throws there), and an early
 * return means vanilla REJECTED the packet (bad slot, dead player), which is then not an input the
 * demonstration contains. Dig needs no tap: {@code isDestroyingBlock} is read as a hold per tick.
 */
@Mixin(ServerGamePacketListenerImpl.class)
public abstract class ServerGamePacketListenerImplMixin {

    @Shadow
    public ServerPlayer player;

    @Inject(method = "handleAnimate", at = @At("TAIL"))
    private void mcptoolkit$swing(final ServerboundSwingPacket packet, final CallbackInfo ci) {
        if (WmHuman.armed(player)) {
            WmHuman.noteSwing(player);
        }
    }

    @Inject(method = "handleUseItem", at = @At("TAIL"))
    private void mcptoolkit$useItem(final ServerboundUseItemPacket packet, final CallbackInfo ci) {
        if (WmHuman.armed(player)) {
            WmHuman.noteUse(player);
        }
    }

    @Inject(method = "handleUseItemOn", at = @At("TAIL"))
    private void mcptoolkit$useItemOn(final ServerboundUseItemOnPacket packet, final CallbackInfo ci) {
        if (WmHuman.armed(player)) {
            WmHuman.noteUse(player);
        }
    }

    @Inject(method = "handleSetCarriedItem", at = @At("TAIL"))
    private void mcptoolkit$hotbar(final ServerboundSetCarriedItemPacket packet, final CallbackInfo ci) {
        if (WmHuman.armed(player)) {
            WmHuman.noteHotbar(player, packet.getSlot());
        }
    }

    /** The phase-2 client frame. Vanilla leaves this handler EMPTY — no
     *  {@code ensureRunningOnSameThread} re-dispatch to ride — so it runs on the netty thread and
     *  we hop explicitly. The server task queue is FIFO per connection, so the frame is consumed
     *  after the same client tick's input packets, preserving the cross-check's ordering claim.
     *
     *  <p>Only where the loader does not deliver modded payloads itself. On NeoForge the registrar's
     *  handler ({@code NeoForgePayloads}) is called for this payload as well, and both paths running
     *  would record the frame twice — a duplicate the cross-check would read as real input. The
     *  check is the platform's, not the loader's name; see
     *  {@code LoaderPlatform#dispatchesCustomPayloads}. */
    @Inject(method = "handleCustomPayload", at = @At("HEAD"))
    private void mcptoolkit$humanFrame(final ServerboundCustomPayloadPacket packet, final CallbackInfo ci) {
        if (Platform.dispatchesCustomPayloads()) {
            return;
        }
        if (packet.payload() instanceof HumanFramePayload frame) {
            ServerPlayer p = player;
            MinecraftServer server = p.level().getServer();
            if (server != null) {
                server.execute(() -> WmHuman.noteClientFrame(p, frame));
            }
        }
    }
}
