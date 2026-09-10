package com.mattmc.mcptoolkit.mixin;

import net.minecraft.server.level.ServerPlayerGameMode;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

/** Dig-hold read for {@code WmHuman}: destroy progress ticks server-side off this flag, making a
 *  human's dig tick attack-held on the authoritative clock — same convention as the bot's dig. */
@Mixin(ServerPlayerGameMode.class)
public interface ServerPlayerGameModeAccessor {

    @Accessor("isDestroyingBlock")
    boolean mcptoolkit$isDestroyingBlock();
}
