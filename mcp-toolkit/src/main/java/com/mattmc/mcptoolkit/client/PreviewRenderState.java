package com.mattmc.mcptoolkit.client;

import net.fabricmc.api.EnvType;
import net.fabricmc.api.Environment;
import net.minecraft.client.renderer.entity.state.LivingEntityRenderState;

/** Per-frame snapshot for a staged preview: WHICH model it wears, how it is posed, and whether it
 *  is turning. */
@Environment(EnvType.CLIENT)
public class PreviewRenderState extends LivingEntityRenderState {
    /** The interchange asset id this instance wears; resolved through {@link PreviewModels}. */
    public String modelId = "";
    /** The clip to pose it with, or empty for the rest pose (§9.2). */
    public String clip = "";
    /** Seconds into {@link #clip} to freeze at; NEGATIVE means play from the body's own age. */
    public float clipTime = -1.0F;
}
