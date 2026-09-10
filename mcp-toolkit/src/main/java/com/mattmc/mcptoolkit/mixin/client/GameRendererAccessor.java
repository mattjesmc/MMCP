package com.mattmc.mcptoolkit.mixin.client;

import com.mojang.blaze3d.resource.CrossFrameResourcePool;
import net.minecraft.client.renderer.GameRenderer;
import net.minecraft.client.renderer.GlobalSettingsUniform;
import net.minecraft.client.renderer.Lightmap;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

/**
 * The three per-frame things {@code GameRenderer.render} owns privately and
 * {@code Minecraft.grabPanoramixScreenshot} does not touch. <b>The panorama recipe is incomplete in
 * 26.2, and it is incomplete in a way vanilla can never notice</b>: the panorama only ever shoots
 * from the player's own head, which is the one camera position at which both omissions below happen
 * to be harmless.
 *
 * <p><b>The global settings uniform is the one that hurts.</b> {@code render()} writes it every frame
 * ({@code GameRenderer.java:411}) and it carries the CAMERA's integer position; chunk sections are
 * drawn relative to it. Leave it holding the last real frame's value and the whole world is drawn
 * offset by however far the out-of-band camera moved — which, for a camera that rose 44 blocks, means
 * rendering from inside the terrain. The frame comes back BLACK with hard geometric edges and reads
 * exactly like a lighting bug, which is what it was mistaken for on the first live run.
 *
 * <p><b>The lightmap is the second.</b> {@code render()} calls
 * {@code lightmap.render(gameRenderState.lightmapRenderState)} immediately before
 * {@code renderLevel} ({@code GameRenderer.java:423}); the panorama calls {@code update}/
 * {@code extract}/{@code renderLevel} and nothing else. {@code extract} only FILLS the
 * {@code LightmapRenderState}; the upload to the GPU texture every block face samples is that one
 * line. Omit it and the sky renders correctly — it does not sample the lightmap — while every solid
 * surface goes unlit.
 *
 * <p>The lightmap texture survives between frames, so a shot from where the player stands looks right
 * without this call. It stops looking right the moment the render happens somewhere the last real
 * frame was not — another dimension above all, which is precisely what the studio is for.
 *
 * <p>{@code resourcePool} is the frame graph's texture pool. {@code render()} ends every frame with
 * {@code renderBuffers.endFrame()} and {@code resourcePool.endFrame()}; an out-of-band render that
 * runs the graph several times over (the settle loop) and never releases would hold a set of
 * full-resolution targets per pass. {@code renderBuffers()} is public; this is the half that is not.
 */
@Mixin(GameRenderer.class)
public interface GameRendererAccessor {

    @Accessor("lightmap")
    Lightmap mcptoolkit$lightmap();

    @Accessor("resourcePool")
    CrossFrameResourcePool mcptoolkit$resourcePool();

    @Accessor("globalSettingsUniform")
    GlobalSettingsUniform mcptoolkit$globalSettingsUniform();
}
