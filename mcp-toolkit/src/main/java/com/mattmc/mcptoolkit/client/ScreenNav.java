package com.mattmc.mcptoolkit.client;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.hooks.client.ClientHooks;
import com.mattmc.mcptoolkit.hooks.client.ToolkitScreens;
import net.fabricmc.api.EnvType;
import net.fabricmc.api.Environment;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.screens.Screen;
import org.jspecify.annotations.Nullable;

import java.util.LinkedHashSet;
import java.util.Set;

/**
 * Records the menu-navigation graph passively — each screen transition becomes a {@code (from, to, via)}
 * edge, where {@code via} is the label of the widget clicked just before it. Built by observation, never
 * by crawling (buttons have side effects). Both real user clicks (via {@code SCREEN_MOUSE_CLICKED}) and
 * programmatic {@link UiTools} clicks ({@link #noteClick}) supply the {@code via} label.
 *
 * <p>Transitions are detected by polling the current screen once per client tick, not from the screen
 * removed/added events: swapping screens removes the old one just before initializing the new one, so an
 * event-driven approach sees a spurious "&lt;none&gt;" hop between every pair of screens. Between ticks the
 * swap is already complete, so the poll sees a clean direct transition.
 */
@Environment(EnvType.CLIENT)
public final class ScreenNav {
    private ScreenNav() {}

    /** Pseudo-node for "no screen open" (in-world). */
    private static final String NONE = "<none>";

    private record Edge(String from, String to, @Nullable String via) {}

    private static final Set<String> NODES = new LinkedHashSet<>();
    private static final Set<Edge> EDGES = new LinkedHashSet<>();
    private static @Nullable String currentScreen = null;
    private static @Nullable String lastClicked = null;

    public static void register() {
        // Observe real (human) clicks so the next transition can be labeled with what was clicked.
        // The hook is global (fires for every screen) and observer-only by construction — it sits
        // before the screen's own handler and cannot consume the click.
        ClientHooks.SCREEN_MOUSE_CLICKED.register((scr, event) ->
            lastClicked = widgetLabelAt(scr, event.x(), event.y()));
        ClientHooks.END_CLIENT_TICK.register(ScreenNav::poll);
    }

    private static synchronized void poll(final Minecraft mc) {
        Screen sc = mc.gui.screen();
        String now = sc == null ? NONE : sc.getClass().getName();
        String cur = currentScreen == null ? NONE : currentScreen;
        if (!now.equals(cur)) {
            NODES.add(cur);
            NODES.add(now);
            EDGES.add(new Edge(cur, now, lastClicked));
            currentScreen = now.equals(NONE) ? null : now;
            lastClicked = null;
        }
    }

    /** Called by the {@code click} tool so programmatic navigation is labeled too. */
    public static synchronized void noteClick(final Screen screen, final @Nullable String label) {
        lastClicked = label;
    }

    private static @Nullable String widgetLabelAt(final Screen screen, final double x, final double y) {
        for (AbstractWidget w : ToolkitScreens.widgets(screen)) {
            if (w.visible
                && x >= w.getX() && x < w.getX() + w.getWidth()
                && y >= w.getY() && y < w.getY() + w.getHeight()) {
                String m = w.getMessage() == null ? "" : w.getMessage().getString();
                return m.isEmpty() ? w.getClass().getSimpleName() : m;
            }
        }
        return null;
    }

    public static synchronized JsonObject dump() {
        JsonObject r = new JsonObject();
        JsonArray nodes = new JsonArray();
        for (String n : NODES) {
            nodes.add(n);
        }
        JsonArray edges = new JsonArray();
        for (Edge e : EDGES) {
            JsonObject o = new JsonObject();
            o.addProperty("from", e.from());
            o.addProperty("to", e.to());
            if (e.via() != null) {
                o.addProperty("via", e.via());
            }
            edges.add(o);
        }
        r.add("nodes", nodes);
        r.add("edges", edges);
        return r;
    }
}
