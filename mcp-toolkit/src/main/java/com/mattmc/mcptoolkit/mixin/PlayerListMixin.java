package com.mattmc.mcptoolkit.mixin;

import com.mattmc.mcptoolkit.hooks.ServerHooks;
import net.minecraft.network.chat.ChatType;
import net.minecraft.network.chat.PlayerChatMessage;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.players.PlayerList;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** Player-chat hook: the ServerPlayer overload only, so /say and command feedback don't fire it. */
@Mixin(PlayerList.class)
public abstract class PlayerListMixin {

    @Inject(
        method = "broadcastChatMessage(Lnet/minecraft/network/chat/PlayerChatMessage;Lnet/minecraft/server/level/ServerPlayer;Lnet/minecraft/network/chat/ChatType$Bound;)V",
        at = @At("HEAD")
    )
    private void mcptoolkit$chatMessage(final PlayerChatMessage message, final ServerPlayer sender,
                                        final ChatType.Bound chatType, final CallbackInfo ci) {
        ServerHooks.CHAT_MESSAGE.fire(l -> l.onChat(message, sender));
    }
}
