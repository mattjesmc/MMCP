package com.mattmc.mcptoolkit.client;

import com.mattmc.mcptoolkit.Reentry;
import net.fabricmc.api.EnvType;
import net.fabricmc.api.Environment;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.Screen;
import org.jspecify.annotations.Nullable;

import java.util.concurrent.TimeUnit;

/**
 * The client half of the re-entry tier ({@code HOTSWAP_CEILING.md} §3): the one subsystem whose
 * "nothing changed" is the most common and the most confusing, because the screen you are LOOKING AT
 * is the screen whose swapped code visibly did nothing.
 *
 * <p>A {@code Screen}'s widgets are built once, by {@code init()}, and held in its children list for
 * the life of the screen. Redefining the class changes the code that builds them; it does not touch
 * the buttons already on the glass. The re-entry is the one the game performs on itself every time
 * the window is resized — {@code Screen.resize}, which calls {@code rebuildWidgets}: clear, re-run
 * {@code init()}, restore focus. That is deliberately the vanilla path rather than a
 * {@code setScreen(new …)}: it keeps the screen's own fields (a container menu, a text field's
 * contents, a scroll offset) and rebuilds only what {@code init()} owns, and it is the ONLY re-entry
 * that works for a container screen, which cannot be reconstructed by tool at all because its menu
 * lives on the server.
 *
 * <p>Everything here runs on the render thread by submitting to it, because the caller is the
 * bridge's HTTP thread: {@code hotswap_class} is an {@code ANY}-context tool, so it must marshal
 * anything that touches the client.
 */
@Environment(EnvType.CLIENT)
public final class ScreenReentry implements Reentry.ClientReentry {

    /** How long the swap may wait on the render thread before reporting that it did not answer. */
    private static final long WAIT_SECONDS = 5;

    /** Installed by the client entrypoint; a dedicated server installs nothing and has no screens. */
    public static void register() {
        Reentry.setClient(new ScreenReentry());
    }

    @Override
    public boolean isScreen(final Class<?> cls) {
        return Screen.class.isAssignableFrom(cls);
    }

    @Override
    public @Nullable String currentScreenIs(final Class<?> cls) {
        // A plain read of one field. Done on the render thread anyway, because reading it from the
        // HTTP thread mid-transition can see a screen that is already gone.
        return onClient(() -> {
            Screen screen = Minecraft.getInstance().gui.screen();
            return screen != null && cls.isInstance(screen) ? screen.getClass().getName() : null;
        }, UNKNOWN);
    }

    @Override
    public String rebuildCurrentScreen() {
        String done = onClient(() -> {
            Minecraft mc = Minecraft.getInstance();
            Screen screen = mc.gui.screen();
            if (screen == null) {
                return "the client is on no screen now";
            }
            screen.resize(mc.getWindow().getGuiScaledWidth(), mc.getWindow().getGuiScaledHeight());
            return "re-ran init() on the live " + screen.getClass().getSimpleName()
                + " (widgets cleared and rebuilt in place; the screen's own fields are untouched)";
        }, null);
        return done == null ? "the render thread did not answer in " + WAIT_SECONDS + "s" : done;
    }

    private static <T> T onClient(final java.util.function.Supplier<T> job, final T fallback) {
        try {
            return Minecraft.getInstance().submit(job::get).get(WAIT_SECONDS, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return fallback;
        } catch (Exception e) {
            return fallback;
        }
    }
}
