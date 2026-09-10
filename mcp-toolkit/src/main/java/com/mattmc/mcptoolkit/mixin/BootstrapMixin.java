package com.mattmc.mcptoolkit.mixin;

import com.mattmc.mcptoolkit.hooks.ToolkitTranslations;
import net.minecraft.locale.Language;
import net.minecraft.server.Bootstrap;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

import java.util.Set;

/**
 * Teach vanilla's bootstrap translation check about the strings the toolkit actually ships.
 *
 * <p>{@code Bootstrap.validate()} logs one {@code Missing translations: <key>} at ERROR for every id
 * in {@code BuiltInRegistries} that {@code Language.DEFAULT_INSTANCE} has no string for. That map is
 * read from the GAME's jar alone and can never contain a mod's strings — see
 * {@link ToolkitTranslations} for why that is structural rather than an oversight — so the bodies
 * registered by {@code BuiltInRegistriesMixin} during bootstrap draw two permanent ERRORs.
 *
 * <p>This removes only the keys {@code assets/mcptoolkit/lang/en_us.json} genuinely provides. A key
 * the toolkit does NOT translate still reports, so this narrows the check rather than disabling it:
 * add an entity type without a string and the ERROR comes back.
 *
 * <p>The whole check is inside {@code if (SharedConstants.IS_RUNNING_IN_IDE)}, so nothing here runs
 * in production. It is worth doing anyway because a dev boot log is this project's primary arbiter,
 * and two ERROR lines that must be mentally filtered on every run of every consumer are exactly the
 * cover a real error hides under.
 *
 * <p>Injected at {@code getMissingTranslations} RETURN rather than into {@code Language}: the missing
 * set is a mutable {@code TreeSet} returned by reference and iterated by the caller afterwards, and
 * this point is unambiguously after the toolkit's own registration. Appending to
 * {@code Language.DEFAULT_INSTANCE} instead is not possible (its map is a {@code Map.copyOf}) and
 * would race class-init besides.
 */
@Mixin(Bootstrap.class)
public class BootstrapMixin {

    @Inject(method = "getMissingTranslations", at = @At("RETURN"))
    private static void mcptoolkit$dropTranslatedKeys(final Language language,
                                                      final CallbackInfoReturnable<Set<String>> cir) {
        cir.getReturnValue().removeIf(ToolkitTranslations::has);
    }
}
