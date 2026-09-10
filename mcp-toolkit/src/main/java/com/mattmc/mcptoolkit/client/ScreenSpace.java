package com.mattmc.mcptoolkit.client;

import com.mojang.blaze3d.platform.Window;
import net.fabricmc.api.EnvType;
import net.fabricmc.api.Environment;

/**
 * The window's size in SCREEN pixels, with the one case vanilla gets wrong taken out.
 *
 * <p>An iconified window is 0x0 to GLFW: the window-size callback delivers that and
 * {@code Window.onResize} stores it as it is ({@code Window.java:311}), while the framebuffer
 * callback, which sees the same 0x0, keeps the last real framebuffer size and only sets
 * {@code minimized} ({@code Window.java:297}). So while the window is minimized the framebuffer
 * (and everything derived from it: the GUI scale, the render target, an out-of-band render) is
 * intact, and the screen size alone is zero. {@code MouseHandler.getScaledXPos} divides by that
 * screen size ({@code MouseHandler.java:335}), which puts the pointer every screen renders with at
 * infinity — measured 2026-09-07: the frame kept rendering at the iconified 10 fps, {@code
 * screenshot} kept moving, {@code render} came out right, and the one thing missing was the
 * tooltip under a {@code click {hover}}. On Windows without DPI scaling the two sizes are equal
 * whenever the window is up, so the framebuffer is the right stand-in when the screen size is
 * gone: {@link ScreenSpaceMixin} hands it to vanilla's scaling, and the hover tool's inverse uses
 * the same numbers, which is what keeps the two ends of the pointer in one coordinate space.
 */
@Environment(EnvType.CLIENT)
public final class ScreenSpace {

    private ScreenSpace() {}

    /** The window's width in screen pixels, or the framebuffer's while the window is iconified. */
    public static int width(final Window window) {
        final int w = window.getScreenWidth();
        return w > 0 ? w : window.getWidth();
    }

    /** The window's height in screen pixels, or the framebuffer's while the window is iconified. */
    public static int height(final Window window) {
        final int h = window.getScreenHeight();
        return h > 0 ? h : window.getHeight();
    }
}
