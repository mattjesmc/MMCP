package com.mattmc.spike.mixin;

import com.mattmc.spike.SpikeEntities;
import net.minecraft.core.registries.BuiltInRegistries;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * mcp-toolkit's {@code BuiltInRegistriesMixin}, copied verbatim except for what it calls. If this
 * behaves differently on NeoForge than it does on Fabric, that difference is the finding.
 *
 * <p>Note this file is also a test of a second claim: that because Minecraft 26.x is unobfuscated,
 * a mixin config written for Fabric is portable to NeoForge with no refmap and no edits.
 */
@Mixin(BuiltInRegistries.class)
public abstract class BuiltInRegistriesMixin {

    @Inject(
        method = "bootStrap",
        at = @At(value = "INVOKE", target = "Lnet/minecraft/core/registries/BuiltInRegistries;freeze()V"))
    private static void spike$registerAtFreeze(final CallbackInfo ci) {
        org.slf4j.LoggerFactory.getLogger("spike")
            .info("[spike] DOOR 1: bootStrap() injection FIRED - the freeze call was reached");
        SpikeEntities.registerViaMixin();
    }
}
