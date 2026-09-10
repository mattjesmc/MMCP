package com.mattmc.mcptoolkit.mixin;

import com.mattmc.mcptoolkit.hooks.ServerHooks;
import net.minecraft.world.entity.Entity;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * Entity-load hook: fires when an entity starts being tracked in a server level (both fresh spawns
 * and chunk-load restores — same coverage as fabric's ENTITY_LOAD). TAIL so the entity is fully
 * registered; the level is reachable as {@code entity.level()}.
 */
@Mixin(targets = "net.minecraft.server.level.ServerLevel$EntityCallbacks")
public abstract class ServerLevelEntityCallbacksMixin {

    @Inject(method = "onTrackingStart(Lnet/minecraft/world/entity/Entity;)V", at = @At("TAIL"))
    private void mcptoolkit$entityLoad(final Entity entity, final CallbackInfo ci) {
        ServerHooks.ENTITY_LOAD.fire(l -> l.accept(entity));
    }
}
