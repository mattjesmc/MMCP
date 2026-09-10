package com.mattmc.mcptoolkit.mixin;

import com.mattmc.mcptoolkit.hooks.ServerHooks;
import net.minecraft.server.MinecraftServer;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** Server lifecycle + tick hooks. See {@link ServerHooks} for the injection-point rationale. */
@Mixin(MinecraftServer.class)
public abstract class MinecraftServerMixin {

    /** After successful init: loadStatusIcon only runs when initServer() returned true. */
    @Inject(
        method = "runServer",
        at = @At(value = "INVOKE", target = "Lnet/minecraft/server/MinecraftServer;loadStatusIcon()Ljava/util/Optional;")
    )
    private void mcptoolkit$serverStarted(final CallbackInfo ci) {
        MinecraftServer self = (MinecraftServer) (Object) this;
        ServerHooks.SERVER_STARTED.fire(l -> l.accept(self));
    }

    @Inject(method = "stopServer", at = @At("HEAD"))
    private void mcptoolkit$serverStopping(final CallbackInfo ci) {
        MinecraftServer self = (MinecraftServer) (Object) this;
        ServerHooks.SERVER_STOPPING.fire(l -> l.accept(self));
    }

    @Inject(method = "stopServer", at = @At("RETURN"))
    private void mcptoolkit$serverStopped(final CallbackInfo ci) {
        MinecraftServer self = (MinecraftServer) (Object) this;
        ServerHooks.SERVER_STOPPED.fire(l -> l.accept(self));
    }

    @Inject(method = "tickServer", at = @At("TAIL"))
    private void mcptoolkit$endServerTick(final CallbackInfo ci) {
        MinecraftServer self = (MinecraftServer) (Object) this;
        ServerHooks.END_SERVER_TICK.fire(l -> l.accept(self));
    }
}
