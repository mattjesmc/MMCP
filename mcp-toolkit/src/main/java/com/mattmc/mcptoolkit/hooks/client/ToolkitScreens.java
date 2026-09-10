package com.mattmc.mcptoolkit.hooks.client;

import com.mattmc.mcptoolkit.mixin.client.ScreenAccessor;
import net.fabricmc.api.EnvType;
import net.fabricmc.api.Environment;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.components.Renderable;
import net.minecraft.client.gui.components.events.GuiEventListener;
import net.minecraft.client.gui.narration.NarratableEntry;
import net.minecraft.client.gui.screens.Screen;

import java.util.ArrayList;
import java.util.List;

/**
 * Screen widget access (fabric {@code Screens} replacement), backed by {@link ScreenAccessor}.
 * Unlike fabric's live proxy list, {@link #widgets} is a read-only snapshot — mutation goes through
 * {@link #addWidget}, which wires the widget into all three of the screen's lists
 * (renderables/children/narratables) via the real {@code addRenderableWidget}.
 */
@Environment(EnvType.CLIENT)
public final class ToolkitScreens {
    private ToolkitScreens() {}

    /** The screen's widgets (its renderables that are {@link AbstractWidget}s), top-level only, as a snapshot. */
    public static List<AbstractWidget> widgets(final Screen screen) {
        List<AbstractWidget> out = new ArrayList<>();
        for (Renderable r : ((ScreenAccessor) screen).mcptoolkit$renderables()) {
            if (r instanceof AbstractWidget w) {
                out.add(w);
            }
        }
        return out;
    }

    /** Add a widget to the screen exactly as the screen itself would ({@code addRenderableWidget}). */
    public static <T extends GuiEventListener & Renderable & NarratableEntry> T addWidget(final Screen screen, final T widget) {
        return ((ScreenAccessor) screen).mcptoolkit$addRenderableWidget(widget);
    }
}
