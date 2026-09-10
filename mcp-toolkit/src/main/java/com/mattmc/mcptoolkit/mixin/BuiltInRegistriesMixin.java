package com.mattmc.mcptoolkit.mixin;

import com.mattmc.mcptoolkit.drone.DroneEntities;
import net.minecraft.core.registries.BuiltInRegistries;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * Registers the toolkit's entity TYPES during vanilla's own bootstrap, in the last moment before
 * {@code BuiltInRegistries.freeze()}. Their default attributes are registered separately from
 * {@code onInitialize} - see {@link DroneEntities#registerTypes()} for why they cannot share a pass.
 *
 * <p>Why this exists rather than a call from {@code onInitialize}: {@code BuiltInRegistries.bootStrap()}
 * is {@code createContents(); freeze();}, and mod entrypoints run <em>after</em> it. Once frozen, a
 * {@link net.minecraft.core.MappedRegistry} nulls its {@code unregisteredIntrusiveHolders} map, so
 * {@code EntityType.Builder.build(key)} throws {@code "This registry can't create intrusive holders"}
 * and {@code Registry.register} throws {@code "Registry is already frozen"}. Registering from an
 * entrypoint therefore cannot work on a bare loader; fabric-registry-sync's role was to re-open that
 * door. Doing it here means the door is simply still open - this is the same moment, and the same
 * mechanism, vanilla uses for its own entity types.
 *
 * <p>This is what lets the toolkit run with NO fabric-api, the same way {@code DefaultAttributesMixin}
 * replaces {@code FabricDefaultAttributeRegistry}.
 *
 * <p><b>When fabric-api IS present this injection never runs, and that is fine.</b>
 * fabric-registry-sync's {@code BootstrapMixin} {@code @Redirect}s {@code Bootstrap.bootStrap()}'s
 * call to {@code BuiltInRegistries.bootStrap()} down to {@code createContents()} alone, so the
 * method this injects into is not called during bootstrap at all - the freeze is delayed until
 * after mod init. The injection still applies (nothing touches {@code bootStrap}'s bytecode), it is
 * just dead until fabric calls the method itself later, by which point
 * {@link DroneEntities#bootstrap()} has already registered the types through the door fabric held
 * open. {@link DroneEntities#registerTypes()} is idempotent for exactly that second visit.
 */
@Mixin(BuiltInRegistries.class)
public abstract class BuiltInRegistriesMixin {

    @Inject(
        method = "bootStrap",
        at = @At(value = "INVOKE", target = "Lnet/minecraft/core/registries/BuiltInRegistries;freeze()V"))
    private static void mcptoolkit$registerBodies(final CallbackInfo ci) {
        DroneEntities.registerTypes();
        com.mattmc.mcptoolkit.ui.sample.UiSamples.registerTypes();
    }
}
