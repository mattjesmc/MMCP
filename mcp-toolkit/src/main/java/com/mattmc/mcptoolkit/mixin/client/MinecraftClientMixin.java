package com.mattmc.mcptoolkit.mixin.client;

import com.mattmc.mcptoolkit.hooks.client.ClientHooks;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.Screen;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * Client tick, disconnect and shutdown hooks. {@code disconnect(Screen,ZZ)} is the funnel every
 * disconnect path uses; {@code close()} is the one every shutdown path uses.
 */
@Mixin(Minecraft.class)
public abstract class MinecraftClientMixin {

    @Inject(method = "tick", at = @At("TAIL"))
    private void mcptoolkit$endClientTick(final CallbackInfo ci) {
        Minecraft self = (Minecraft) (Object) this;
        ClientHooks.END_CLIENT_TICK.fire(l -> l.accept(self));
    }

    @Inject(method = "disconnect(Lnet/minecraft/client/gui/screens/Screen;ZZ)V", at = @At("HEAD"))
    private void mcptoolkit$disconnect(final Screen screen, final boolean keepResourcePacks,
                                       final boolean stopSound, final CallbackInfo ci) {
        ClientHooks.DISCONNECT.fire(Runnable::run);
    }

    /**
     * HEAD, not TAIL: {@code close()} ends with {@code GLFW.glfwTerminate()} and tears the render
     * context down, so a listener that runs after it has no client left to act on. Every shutdown
     * path reaches here — {@code run()} calls it in a finally.
     */
    @Inject(method = "close", at = @At("HEAD"))
    private void mcptoolkit$clientStopping(final CallbackInfo ci) {
        ClientHooks.CLIENT_STOPPING.fire(Runnable::run);
    }
}
