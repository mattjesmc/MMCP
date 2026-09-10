package com.mattmc.mcptoolkit.ui.interp;

import com.mattmc.mcptoolkit.ui.Palette;
import net.fabricmc.api.EnvType;
import net.fabricmc.api.Environment;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.renderer.RenderPipelines;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.Identifier;
import net.minecraft.util.Mth;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.inventory.Slot;

import java.util.List;
import java.util.function.Supplier;

/**
 * The texture-less drawing primitives every screen in this workspace already re-derives.
 *
 * <p>Relocated from {@code ui-kit/} slice 1 ({@code com.mattmc.mcui.Paint}) per
 * SCREEN_AUTHORING_DESIGN.md section 16. Two roles now: the interpreter paints with these, and from
 * slice 2 the emitter inlines this exact source into each mod's {@code <Mod>Paint.java} - so the
 * bodies here are the reference the conformance battery (section 12) compares pixels against, and a
 * change to one of them is a change to what every generated screen will look like.
 *
 * <p>Nothing here is invented. {@link #panel} and {@link #well} are lifted verbatim from
 * {@code BuildingBrowserScreen}, which was already the fourth copy of that bevel. {@link #bar} is
 * nijntje's {@code drawBar}, which rocketeer wrote again vertically. {@link #slots} is the
 * {@code container/slot} loop nijntje and rocketeer each carry.
 */
@Environment(EnvType.CLIENT)
public final class Paint {
    /** Vanilla's own slot background. The one sprite a texture-less container screen still needs. */
    public static final Identifier SLOT_SPRITE = Identifier.withDefaultNamespace("container/slot");

    private Paint() {}

    /**
     * A raised panel: vanilla's container grey, lit from the top-left.
     *
     * <p>The edge fills are drawn AFTER the body and overlap at the corners; the dark edges win
     * there, which is what gives the corner its vanilla look. Reordering them is a visible change.
     */
    public static void panel(final GuiGraphicsExtractor g, final int x, final int y, final int w, final int h) {
        g.fill(x, y, x + w, y + h, Palette.PANEL_BG);
        g.fill(x, y, x + w, y + 1, Palette.PANEL_EDGE_LIGHT);
        g.fill(x, y, x + 1, y + h, Palette.PANEL_EDGE_LIGHT);
        g.fill(x, y + h - 1, x + w, y + h, Palette.PANEL_EDGE_DARK);
        g.fill(x + w - 1, y, x + w, y + h, Palette.PANEL_EDGE_DARK);
    }

    /**
     * A recessed well: the inside of a list, a text field, a preview box.
     *
     * <p>Only the top and left edges are drawn, and they are the DARK colour - that inversion is the
     * whole of "recessed". No bottom-right highlight on purpose; vanilla's own wells have none.
     */
    public static void well(final GuiGraphicsExtractor g, final int x, final int y, final int w, final int h) {
        g.fill(x, y, x + w, y + h, Palette.WELL_BG);
        g.fill(x, y, x + w, y + 1, Palette.PANEL_EDGE_DARK);
        g.fill(x, y, x + 1, y + h, Palette.PANEL_EDGE_DARK);
    }

    /** The outer border of a texture-less screen: a dark frame with the panel grey inset by one pixel. */
    public static void screenFrame(final GuiGraphicsExtractor g, final int x, final int y, final int w, final int h) {
        g.fill(x, y, x + w, y + h, Palette.SCREEN_FRAME);
        g.fill(x + 1, y + 1, x + w - 1, y + h - 1, Palette.PANEL_BG);
    }

    /**
     * A horizontal fill-proportion bar, framed, with a track behind the fill.
     *
     * <p>{@code frac} is clamped, so a caller that divides by a live capacity cannot paint outside
     * the frame when the numerator briefly exceeds it. A zero-width fill draws nothing rather than a
     * one-pixel stub: "empty" and "almost empty" must look different.
     */
    public static void bar(final GuiGraphicsExtractor g, final int x, final int y, final int w, final int h,
                           final float frac, final int fg, final int track) {
        g.fill(x, y, x + w, y + h, Palette.BAR_FRAME);
        g.fill(x + 1, y + 1, x + w - 1, y + h - 1, track);
        int filled = (int) ((w - 2) * Mth.clamp(frac, 0.0F, 1.0F));
        if (filled > 0) {
            g.fill(x + 1, y + 1, x + 1 + filled, y + h - 1, fg);
        }
    }

    /** The same bar stood on end and filling upward, which is how rocketeer's tank gauge reads. */
    public static void barVertical(final GuiGraphicsExtractor g, final int x, final int y, final int w, final int h,
                                   final float frac, final int fg, final int track) {
        g.fill(x, y, x + w, y + h, Palette.BAR_FRAME);
        g.fill(x + 1, y + 1, x + w - 1, y + h - 1, track);
        int filled = (int) ((h - 2) * Mth.clamp(frac, 0.0F, 1.0F));
        if (filled > 0) {
            g.fill(x + 1, y + h - 1 - filled, x + w - 1, y + h - 1, fg);
        }
    }

    /**
     * Vanilla's slot background under every active slot of a menu.
     *
     * <p>{@code leftPos}/{@code topPos} are the screen's, because {@link Slot#x}/{@link Slot#y} are
     * panel-relative while a background is drawn in absolute coordinates. Pass {@code 0, 0} when the
     * pose is already translated to the panel origin (inside {@code extractLabels}).
     */
    public static void slots(final GuiGraphicsExtractor g, final AbstractContainerMenu menu,
                             final int leftPos, final int topPos) {
        for (Slot slot : menu.slots) {
            if (slot.isActive()) {
                g.blitSprite(RenderPipelines.GUI_TEXTURED, SLOT_SPRITE,
                    leftPos + slot.x - 1, topPos + slot.y - 1, 18, 18);
            }
        }
    }

    /**
     * A widget that shows a tooltip, and what to show (the parts-library design section 3.2).
     *
     * <p>The lines are a {@link Supplier} rather than a value because three of the four tooltip
     * sources that design inventoried are DYNAMIC - built from whatever the hovered thing currently
     * holds - and a static one is simply a supplier that ignores the question.
     */
    public record Hover(AbstractWidget widget, Supplier<List<Component>> lines) {}

    /**
     * The first tooltip zone under the pointer, drawn.
     *
     * <p><b>Why the screen does this rather than {@code AbstractWidget.setTooltip}:</b> vanilla's
     * holder takes a fixed {@code Tooltip}, so a dynamic one would have to be rebuilt every frame
     * and pushed in, and decoration widgets are {@code active = false} - which is fine for the
     * tooltip holder but makes every "is it hovered" question the widget's own rather than the
     * screen's. One loop, one rule, and the interpreter and the generated screen run the same one.
     */
    public static void tooltips(final GuiGraphicsExtractor g, final Font font, final List<Hover> zones,
                                final int mouseX, final int mouseY) {
        for (Hover h : zones) {
            AbstractWidget w = h.widget();
            if (!w.visible || mouseX < w.getX() || mouseY < w.getY()
                || mouseX >= w.getX() + w.getWidth() || mouseY >= w.getY() + w.getHeight()) {
                continue;
            }
            List<Component> lines = h.lines().get();
            if (lines == null || lines.isEmpty()) {
                continue;
            }
            g.setComponentTooltipForNextFrame(font, lines, mouseX, mouseY);
            return;
        }
    }
}
