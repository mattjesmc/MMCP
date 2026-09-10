package com.mattmc.mcptoolkit.mixin.client;

import net.minecraft.client.MouseHandler;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

/**
 * The pointer vanilla holds, writable. {@code MouseHandler.xpos}/{@code ypos} are set by the GLFW
 * cursor callback and by nothing else; every screen's {@code render} is handed their scaled value
 * as its mouse coordinates, which is what hover faces and the screen-drawn tooltip zones
 * ({@code Paint.tooltips}) read. A programmatic click carries its own coordinates in the
 * {@code MouseButtonEvent} and never moves them, so until {@code click {hover:true}} nothing in the
 * toolkit could put the pointer over a widget without a hand on the mouse (UiTools).
 */
@Mixin(MouseHandler.class)
public interface MouseHandlerAccessor {

    @Accessor("xpos")
    void mcptoolkit$setXpos(double xpos);

    @Accessor("ypos")
    void mcptoolkit$setYpos(double ypos);
}
