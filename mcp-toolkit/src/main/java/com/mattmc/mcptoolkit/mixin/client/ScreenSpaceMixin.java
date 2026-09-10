package com.mattmc.mcptoolkit.mixin.client;

import com.mattmc.mcptoolkit.client.ScreenSpace;
import com.mojang.blaze3d.platform.Window;
import net.minecraft.client.MouseHandler;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * The pointer survives an iconified window. Vanilla scales the cursor into GUI space by the
 * window's SCREEN size, which GLFW reports as 0x0 while the window is minimized, so every screen
 * renders with its mouse at infinity and nothing hover-drawn (the hover face, the tooltip) can
 * appear — the only part of a frame a minimized client could not produce (see {@link ScreenSpace}
 * for the measurement). Only the zero case is touched: with the window up, the arithmetic is
 * vanilla's own.
 */
@Mixin(MouseHandler.class)
public abstract class ScreenSpaceMixin {

    @Inject(method = "getScaledXPos(Lcom/mojang/blaze3d/platform/Window;D)D", at = @At("HEAD"), cancellable = true)
    private static void mcptoolkit$scaledX(final Window window, final double x,
                                           final CallbackInfoReturnable<Double> cir) {
        if (window.getScreenWidth() <= 0) {
            cir.setReturnValue(x * window.getGuiScaledWidth() / ScreenSpace.width(window));
        }
    }

    @Inject(method = "getScaledYPos(Lcom/mojang/blaze3d/platform/Window;D)D", at = @At("HEAD"), cancellable = true)
    private static void mcptoolkit$scaledY(final Window window, final double y,
                                           final CallbackInfoReturnable<Double> cir) {
        if (window.getScreenHeight() <= 0) {
            cir.setReturnValue(y * window.getGuiScaledHeight() / ScreenSpace.height(window));
        }
    }
}
