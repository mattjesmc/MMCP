package com.mattmc.mcptoolkit.mixin.client;

import com.mattmc.mcptoolkit.hooks.client.ToolkitResourcePack;
import com.mattmc.mcptoolkit.platform.Platform;
import net.minecraft.client.Minecraft;
import net.minecraft.server.packs.repository.PackRepository;
import net.minecraft.server.packs.repository.RepositorySource;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.ModifyArg;

import java.util.Arrays;

/**
 * Adds the toolkit's own assets to the CLIENT resource-pack repository as it is constructed.
 *
 * <p>Gated on {@link Platform#needsOwnAssetPack()}: NeoForge already exposes a mod's own assets to
 * the client, so contributing this pack there would register the same files twice. The mixin still
 * APPLIES on every loader — it just contributes nothing where the loader has already done the job.
 *
 * <p>Why the argument and not the repository: {@code PackRepository.sources} is a final
 * {@code ImmutableSet} taken in the constructor, so there is nothing to append to afterwards. And
 * why {@code Minecraft} rather than {@code PackRepository} itself: the same class also backs the
 * SERVER's datapack repository, and this pack holds only {@code assets/} - it has no business being
 * offered as a datapack.
 */
@Mixin(Minecraft.class)
public abstract class MinecraftPackRepositoryMixin {

    @ModifyArg(
        method = "<init>",
        at = @At(
            value = "INVOKE",
            target = "Lnet/minecraft/server/packs/repository/PackRepository;<init>([Lnet/minecraft/server/packs/repository/RepositorySource;)V"),
        index = 0)
    private RepositorySource[] mcptoolkit$addOwnAssets(final RepositorySource[] sources) {
        if (!Platform.needsOwnAssetPack()) {
            return sources;
        }
        RepositorySource[] extended = Arrays.copyOf(sources, sources.length + 1);
        extended[sources.length] = ToolkitResourcePack.source();
        return extended;
    }
}
