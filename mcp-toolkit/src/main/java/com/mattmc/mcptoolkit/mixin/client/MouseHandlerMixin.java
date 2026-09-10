package com.mattmc.mcptoolkit.mixin.client;

import com.llamalad7.mixinextras.sugar.Local;
import com.mattmc.mcptoolkit.hooks.client.ClientHooks;
import net.minecraft.client.Minecraft;
import net.minecraft.client.MouseHandler;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.input.MouseButtonEvent;
import net.minecraft.client.input.MouseButtonInfo;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * Mouse observation hooks, all observer-only (nothing here can consume an event):
 *
 * <ul>
 *   <li>Screen clicks — fires just before the screen's own {@code mouseClicked} handler, so
 *       listeners see the widget layout as it was when the human clicked (a handler may navigate
 *       away and rebuild the list).</li>
 *   <li>In-game button transitions — {@code onButton} HEAD when no screen is open, pre-
 *       {@code simulateRightClick}: the physical keybind-level press truth for §15 human capture,
 *       at GLFW-event resolution (multiple presses can land in one client tick).</li>
 *   <li>Look deltas — {@code turnPlayer} HEAD: the raw accumulated dx/dy about to be applied as
 *       rotation. Vanilla zeroes the accumulators every frame in {@code handleAccumulatedMovement},
 *       so sampling here (grabbed, in-game — the only path that reaches rotation) is the one place
 *       the sub-tick mouse trace exists at all.</li>
 * </ul>
 */
@Mixin(MouseHandler.class)
public abstract class MouseHandlerMixin {

    @Shadow
    @Final
    private Minecraft minecraft;

    @Shadow
    private double accumulatedDX;

    @Shadow
    private double accumulatedDY;

    @Inject(
        method = "onButton",
        at = @At(
            value = "INVOKE",
            target = "Lnet/minecraft/client/gui/screens/Screen;mouseClicked(Lnet/minecraft/client/input/MouseButtonEvent;Z)Z"
        )
    )
    private void mcptoolkit$screenMouseClicked(final CallbackInfo ci,
                                               final @Local Screen screen,
                                               final @Local MouseButtonEvent event) {
        ClientHooks.SCREEN_MOUSE_CLICKED.fire(l -> l.onClick(screen, event));
    }

    @Inject(method = "onButton", at = @At("HEAD"))
    private void mcptoolkit$ingameButton(final long handle, final MouseButtonInfo buttonInfo,
                                         final int action, final CallbackInfo ci) {
        if (handle == minecraft.getWindow().handle() && minecraft.gui.screen() == null) {
            // Position 0,0: gameplay listeners match on the button, not the cursor.
            MouseButtonEvent event = new MouseButtonEvent(0, 0, buttonInfo);
            ClientHooks.MOUSE_BUTTON.fire(l -> l.onButton(event, action == 1));
        }
    }

    @Inject(method = "turnPlayer", at = @At("HEAD"))
    private void mcptoolkit$turnPlayer(final double mousea, final CallbackInfo ci) {
        if (accumulatedDX != 0.0 || accumulatedDY != 0.0) {
            final double dx = accumulatedDX;
            final double dy = accumulatedDY;
            ClientHooks.MOUSE_TURN.fire(l -> l.onTurn(dx, dy));
        }
    }
}
