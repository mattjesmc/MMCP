package com.mattmc.mcptoolkit.mixin.client;

import com.mattmc.mcptoolkit.hooks.client.ClientHooks;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.Screen;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;
import net.minecraft.client.input.KeyEvent;

/**
 * SCREEN_KEY_PRESSED fires from {@code keyPressed} HEAD and can CONSUME the key - which is what
 * lets a chord (ctrl+U, the attached preview's swap) be seen before a container screen's own
 * inventory-key close, because {@code AbstractContainerScreen.keyPressed} calls {@code super} first.
 *
 * <p>SCREEN_AFTER_INIT fires from both {@code init(II)} (open/re-open) and {@code resize(II)}: resize
 * rebuilds the widget list via {@code repositionElements → rebuildWidgets} without re-entering
 * {@code init(II)}, so widgets added by listeners would silently vanish on resize otherwise
 * (fabric AFTER_INIT parity — it also re-fires on resize).
 */
@Mixin(Screen.class)
public abstract class ScreenMixin {

    @Inject(method = "init(II)V", at = @At("TAIL"))
    private void mcptoolkit$afterInit(final int width, final int height, final CallbackInfo ci) {
        Screen self = (Screen) (Object) this;
        ClientHooks.SCREEN_AFTER_INIT.fire(l -> l.afterInit(Minecraft.getInstance(), self, width, height));
    }

    @Inject(method = "keyPressed", at = @At("HEAD"), cancellable = true)
    private void mcptoolkit$keyPressed(final KeyEvent event, final CallbackInfoReturnable<Boolean> cir) {
        Screen self = (Screen) (Object) this;
        if (ClientHooks.SCREEN_KEY_PRESSED.fireHandled(l -> l.onKey(self, event))) {
            cir.setReturnValue(true);
        }
    }

    @Inject(method = "resize(II)V", at = @At("TAIL"))
    private void mcptoolkit$afterResize(final int width, final int height, final CallbackInfo ci) {
        Screen self = (Screen) (Object) this;
        ClientHooks.SCREEN_AFTER_INIT.fire(l -> l.afterInit(Minecraft.getInstance(), self, width, height));
    }
}
