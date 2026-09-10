package com.mattmc.mcptoolkit.mixin.client;

import com.mattmc.mcptoolkit.hooks.client.ClientHooks;
import com.mojang.authlib.GameProfile;
import net.minecraft.client.multiplayer.chat.ChatListener;
import net.minecraft.network.chat.ChatType;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.PlayerChatMessage;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * Received-message hooks, at HEAD = "as received" (before chat-delay queuing and block-list
 * filtering — same point in the pipeline fabric's ClientReceiveMessageEvents observes).
 */
@Mixin(ChatListener.class)
public abstract class ChatListenerMixin {

    @Inject(method = "handlePlayerChatMessage", at = @At("HEAD"))
    private void mcptoolkit$playerChat(final PlayerChatMessage message, final GameProfile sender,
                                       final ChatType.Bound boundChatType, final CallbackInfo ci) {
        ClientHooks.CHAT_RECEIVED.fire(l -> l.onChat(message.decoratedContent(), sender.name()));
    }

    @Inject(method = "handleDisguisedChatMessage", at = @At("HEAD"))
    private void mcptoolkit$disguisedChat(final Component message, final ChatType.Bound boundChatType,
                                          final CallbackInfo ci) {
        ClientHooks.CHAT_RECEIVED.fire(l -> l.onChat(message, null));
    }

    @Inject(method = "handleSystemMessage", at = @At("HEAD"))
    private void mcptoolkit$systemMessage(final Component message, final boolean remote, final CallbackInfo ci) {
        ClientHooks.GAME_RECEIVED.fire(l -> l.onGame(message, false));
    }

    @Inject(method = "handleOverlay", at = @At("HEAD"))
    private void mcptoolkit$overlayMessage(final Component message, final CallbackInfo ci) {
        ClientHooks.GAME_RECEIVED.fire(l -> l.onGame(message, true));
    }
}
