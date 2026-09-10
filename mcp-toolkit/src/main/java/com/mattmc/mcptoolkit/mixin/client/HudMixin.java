package com.mattmc.mcptoolkit.mixin.client;

import com.mattmc.mcptoolkit.hooks.client.ClientHooks;
import net.minecraft.client.DeltaTracker;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.Hud;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** HUD overlay hook: 26.2's HUD is render-STATE extraction ({@code Hud.extractRenderState}), so the
 *  toolkit's overlay (Claude subtitles) extracts at TAIL — above vanilla's strata, every frame. */
@Mixin(Hud.class)
public abstract class HudMixin {

    @Inject(method = "extractRenderState", at = @At("TAIL"))
    private void mcptoolkit$hudExtract(final GuiGraphicsExtractor graphics,
                                       final DeltaTracker deltaTracker, final CallbackInfo ci) {
        Hud self = (Hud) (Object) this;
        ClientHooks.HUD_EXTRACT.fire(l -> l.onHudExtract(graphics, deltaTracker, self.isHidden()));
    }
}
