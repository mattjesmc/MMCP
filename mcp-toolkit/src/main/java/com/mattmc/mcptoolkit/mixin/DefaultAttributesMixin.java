package com.mattmc.mcptoolkit.mixin;

import com.mattmc.mcptoolkit.hooks.ToolkitAttributes;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.ai.attributes.AttributeSupplier;
import net.minecraft.world.entity.ai.attributes.DefaultAttributes;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * Consults {@link ToolkitAttributes} before vanilla's immutable SUPPLIERS map, so the toolkit's
 * entity types (drone, walker) get default attributes without mutating vanilla state.
 */
@Mixin(DefaultAttributes.class)
public abstract class DefaultAttributesMixin {

    @Inject(method = "getSupplier", at = @At("HEAD"), cancellable = true)
    private static void mcptoolkit$getSupplier(final EntityType<? extends LivingEntity> type,
                                               final CallbackInfoReturnable<AttributeSupplier> cir) {
        AttributeSupplier ours = ToolkitAttributes.get(type);
        if (ours != null) {
            cir.setReturnValue(ours);
        }
    }

    @Inject(method = "hasSupplier", at = @At("HEAD"), cancellable = true)
    private static void mcptoolkit$hasSupplier(final EntityType<?> type, final CallbackInfoReturnable<Boolean> cir) {
        if (ToolkitAttributes.get(type) != null) {
            cir.setReturnValue(true);
        }
    }
}
