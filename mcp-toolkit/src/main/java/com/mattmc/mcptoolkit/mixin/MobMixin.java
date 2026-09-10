package com.mattmc.mcptoolkit.mixin;

import com.mattmc.mcptoolkit.hooks.ServerHooks;
import net.minecraft.world.entity.ConversionParams;
import net.minecraft.world.entity.EntitySpawnReason;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.Mob;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * Mob-conversion hook: the 4-arg {@code convertTo} is the funnel (the 3-arg overload delegates).
 * RETURN with a null guard — null means the conversion didn't happen (removed mob / create failure).
 */
@Mixin(Mob.class)
public abstract class MobMixin {

    @Inject(
        method = "convertTo(Lnet/minecraft/world/entity/EntityType;Lnet/minecraft/world/entity/ConversionParams;Lnet/minecraft/world/entity/EntitySpawnReason;Lnet/minecraft/world/entity/ConversionParams$AfterConversion;)Lnet/minecraft/world/entity/Mob;",
        at = @At("RETURN")
    )
    private <T extends Mob> void mcptoolkit$mobConverted(final EntityType<T> entityType, final ConversionParams params,
                                                         final EntitySpawnReason spawnReason,
                                                         final ConversionParams.AfterConversion<T> afterConversion,
                                                         final CallbackInfoReturnable<T> cir) {
        T converted = cir.getReturnValue();
        if (converted != null) {
            Mob previous = (Mob) (Object) this;
            ServerHooks.MOB_CONVERSION.fire(l -> l.onConvert(previous, converted));
        }
    }
}
