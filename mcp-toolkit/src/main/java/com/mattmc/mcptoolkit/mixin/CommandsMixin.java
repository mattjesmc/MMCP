package com.mattmc.mcptoolkit.mixin;

import com.mattmc.mcptoolkit.hooks.ServerHooks;
import com.mojang.brigadier.CommandDispatcher;
import net.minecraft.commands.CommandBuildContext;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** Command-registration hook: constructor RETURN — all vanilla commands are registered by then. */
@Mixin(Commands.class)
public abstract class CommandsMixin {

    @Shadow
    @Final
    private CommandDispatcher<CommandSourceStack> dispatcher;

    @Inject(method = "<init>", at = @At("RETURN"))
    private void mcptoolkit$registerCommands(final Commands.CommandSelection selection,
                                             final CommandBuildContext context, final CallbackInfo ci) {
        ServerHooks.COMMAND_REGISTRATION.fire(l -> l.register(this.dispatcher, context, selection));
    }
}
