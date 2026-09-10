package com.mattmc.mcptoolkit.client;

import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.hooks.client.ClientHooks;
import com.mattmc.mcptoolkit.ui.GeneratedScreens;
import com.mattmc.mcptoolkit.ui.doc.Kind;
import com.mattmc.mcptoolkit.ui.interp.UiDeclared;
import net.fabricmc.api.EnvType;
import net.fabricmc.api.Environment;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.screens.Screen;
import org.jspecify.annotations.Nullable;

/**
 * The conformance battery's falsifier (SCREEN_AUTHORING_DESIGN.md section 12): a deliberate
 * corruption of the GENERATED renderer, applied at open time, so a probe can prove that the
 * interpreted-vs-generated comparison is measuring something.
 *
 * <p>A check whose failure mode is "delete a case to go green" needs a way to make itself red on
 * purpose. The honest corruption is of the emitter, and that one is run by hand (corrupt, regenerate,
 * rebuild, watch the battery go red - section 19 records the run). This class is the cheap standing
 * version, applied to the compiled screen the emitter already produced, in two shapes that map onto
 * the comparison's two levels:
 * <ul>
 *   <li>{@link Mode#GEOMETRY} moves the first declared button one pixel right. {@code get_screen}
 *       sees it (level 1) and so does a screenshot (level 2).</li>
 *   <li>{@link Mode#PAINT} halves that button's alpha. The widget tree is IDENTICAL - id, kind, rect,
 *       label, active - so level 1 is blind to it by construction, and only the pixels differ. That is
 *       the case for having a level 2 at all, written as a check.</li>
 * </ul>
 *
 * <p>Armed by {@code open_screen {ui, generated:true, falsify}}, consumed by the first
 * {@code SCREEN_AFTER_INIT} of a registered generated screen, and reported by {@code get_screen} as
 * {@code falsified} so a red comparison names its own cause. A window resize rebuilds the widgets and
 * the corruption with them is gone - the probe opens, reads, and closes without resizing.
 */
@Environment(EnvType.CLIENT)
public final class UiFalsifier {
    private UiFalsifier() {}

    public enum Mode {
        GEOMETRY,
        PAINT;

        public static @Nullable Mode parse(final @Nullable String s) {
            if (s == null) {
                return null;
            }
            for (Mode m : values()) {
                if (m.name().equalsIgnoreCase(s)) {
                    return m;
                }
            }
            throw new IllegalArgumentException("'falsify' must be \"geometry\" or \"paint\", not '" + s + "'");
        }
    }

    private static @Nullable Mode armed;
    private static @Nullable Mode applied;
    private static @Nullable String appliedTo;

    static void register() {
        ClientHooks.SCREEN_AFTER_INIT.register((client, screen, w, h) -> apply(screen));
    }

    /** Arm (or, with {@code null}, disarm) the corruption for the next generated screen that opens. */
    static void arm(final @Nullable Mode mode) {
        armed = mode;
        applied = null;
        appliedTo = null;
    }

    /** What the last generated screen had done to it, for {@code get_screen}; {@code null} when nothing. */
    static @Nullable JsonObject report() {
        if (applied == null) {
            return null;
        }
        JsonObject o = new JsonObject();
        o.addProperty("mode", applied.name().toLowerCase(java.util.Locale.ROOT));
        o.addProperty("widget", appliedTo);
        o.addProperty("effect", applied == Mode.GEOMETRY
            ? "moved 1px right: get_screen and a screenshot both differ from the interpreted preview"
            : "alpha halved: the widget tree is identical, only the pixels differ");
        return o;
    }

    private static void apply(final Screen screen) {
        Mode mode = armed;
        if (mode == null || GeneratedScreens.forScreenClass(screen.getClass().getName()) == null) {
            return;
        }
        for (AbstractWidget w : UiTools.collectWidgets(screen).widgets()) {
            UiDeclared d = UiDeclared.of(w);
            if (d == null || d.uiKind() != Kind.BUTTON) {
                continue;
            }
            switch (mode) {
                case GEOMETRY -> w.setX(w.getX() + 1);
                case PAINT -> w.setAlpha(0.5F);
            }
            armed = null;
            applied = mode;
            appliedTo = d.uiId();
            return;
        }
    }
}
