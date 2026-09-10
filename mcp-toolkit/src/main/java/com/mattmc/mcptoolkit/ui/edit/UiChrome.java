package com.mattmc.mcptoolkit.ui.edit;

import net.fabricmc.api.EnvType;
import net.fabricmc.api.Environment;
import net.minecraft.client.gui.ComponentPath;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.narration.NarrationElementOutput;
import net.minecraft.client.gui.navigation.FocusNavigationEvent;
import net.minecraft.network.chat.Component;
import org.jspecify.annotations.Nullable;

import java.util.function.Consumer;

/**
 * The editor's own furniture: a compact button, and the primitives its overlay is drawn with.
 *
 * <p><b>Deliberately not the document's widgets and deliberately not vanilla's.</b> Two reasons,
 * both load-bearing:
 *
 * <ol>
 *   <li><b>Nothing here implements {@code UiDeclared}.</b> The conformance battery (section 12)
 *       compares DECLARED widgets across the two renderers, so the editor's toolbar, palette and
 *       inspector are invisible to it by construction - the editor cannot make the battery lie, and
 *       cannot be made to pass by being mistaken for a document element.</li>
 *   <li>Every one of these IS a real {@code AbstractWidget}, so {@code get_screen} lists it,
 *       {@code click} presses it by label and {@code set_text} types into its boxes. That is section
 *       9's claim that the toolkit's own tools can drive the editor - and it is what lets a probe
 *       exercise a drag-and-drop editor without a human hand.</li>
 * </ol>
 *
 * <p>Vanilla's {@code Button} is 20px tall and pays for a sprite sheet; a sixteen-entry palette in a
 * 240px-tall screen cannot afford that, so the button here is flat, any size, and 40 lines.
 */
@Environment(EnvType.CLIENT)
public final class UiChrome {
    private UiChrome() {}

    /** Chrome sits over the document, so it is opaque enough to read against any panel. */
    public static final int CHROME_BG = 0xF01A1A1A;
    public static final int CHROME_BORDER = 0xFF505050;
    public static final int CHROME_TEXT = 0xFFDDDDDD;
    public static final int CHROME_TEXT_DIM = 0xFF909090;
    public static final int BTN_BG = 0xFF2E2E2E;
    public static final int BTN_BG_HOVER = 0xFF4A4A4A;
    public static final int BTN_BG_ON = 0xFF2F5E36;
    public static final int BTN_BG_OFF = 0xFF2E2E2E;
    /** The selection: a colour nothing in a vanilla GUI uses, so it can never be mistaken for art. */
    public static final int SELECT = 0xFF33CCFF;
    public static final int HOVER = 0x8033CCFF;
    /** A layout node's bounds, and a region's rectangle: the two things only the editor shows. */
    public static final int NODE = 0x66FFAA00;
    public static final int REGION = 0x88FF55FF;
    /** An explicit offset override (section 4.3): always legible as an override, never an accident. */
    public static final int OFFSET_MARK = 0xFFFF5555;
    public static final int OK_TEXT = 0xFF77DD77;
    public static final int ERROR_TEXT = 0xFFFF6666;

    // ---------------------------------------------------------------------------------------------

    /** A one-pixel rectangle outline. */
    public static void outline(final GuiGraphicsExtractor g, final int x, final int y, final int w,
                               final int h, final int argb) {
        g.fill(x, y, x + w, y + 1, argb);
        g.fill(x, y + h - 1, x + w, y + h, argb);
        g.fill(x, y + 1, x + 1, y + h - 1, argb);
        g.fill(x + w - 1, y + 1, x + w, y + h - 1, argb);
    }

    /** A dashed outline: 2 on, 2 off. What marks a thing that paints nothing of its own. */
    public static void dashed(final GuiGraphicsExtractor g, final int x, final int y, final int w,
                              final int h, final int argb) {
        for (int i = 0; i < w; i += 4) {
            int len = Math.min(2, w - i);
            g.fill(x + i, y, x + i + len, y + 1, argb);
            g.fill(x + i, y + h - 1, x + i + len, y + h, argb);
        }
        for (int i = 0; i < h; i += 4) {
            int len = Math.min(2, h - i);
            g.fill(x, y + i, x + 1, y + i + len, argb);
            g.fill(x + w - 1, y + i, x + w, y + i + len, argb);
        }
    }

    /** The editor's own background panel: dark, bordered, over whatever the document painted. */
    public static void panel(final GuiGraphicsExtractor g, final int x, final int y, final int w, final int h) {
        g.fill(x, y, x + w, y + h, CHROME_BG);
        outline(g, x, y, w, h, CHROME_BORDER);
    }

    /** A filled square handle, dark-edged so it reads on any background. */
    public static void handle(final GuiGraphicsExtractor g, final int cx, final int cy, final int size) {
        int half = size / 2;
        g.fill(cx - half - 1, cy - half - 1, cx + half + 1, cy + half + 1, 0xFF000000);
        g.fill(cx - half, cy - half, cx + half, cy + half, SELECT);
    }

    /** Text clipped to a pixel width, with an ellipsis when it did not fit. */
    public static String clip(final Font font, final String text, final int width) {
        if (font.width(text) <= width) {
            return text;
        }
        String out = text;
        while (!out.isEmpty() && font.width(out + "..") > width) {
            out = out.substring(0, out.length() - 1);
        }
        return out + "..";
    }

    // ---------------------------------------------------------------------------------------------

    /**
     * A flat button of any size, with an optional on/off tint.
     *
     * <p>Its {@code message} is its label, which is how {@code click {label}} finds it - so the
     * labels are the editor's command names ("save", "undo", "panel", ...) and a probe presses them
     * by name rather than by pixel.
     */
    public static final class Btn extends AbstractWidget {
        private final Consumer<Btn> onPress;
        private boolean on;
        private boolean toggle;
        private @Nullable String badge;

        public Btn(final int x, final int y, final int w, final int h, final String label,
                   final Consumer<Btn> onPress) {
            super(x, y, w, h, Component.literal(label));
            this.onPress = onPress;
        }

        /** Mark this a toggle and set its state; a toggle paints its state instead of a hover. */
        public Btn toggled(final boolean state) {
            this.toggle = true;
            this.on = state;
            return this;
        }

        /** A short suffix drawn dim and right-aligned: a count, a unit, a shortcut. */
        public Btn badge(final @Nullable String text) {
            this.badge = text;
            return this;
        }

        public boolean isOn() {
            return on;
        }

        @Override
        public void onClick(final net.minecraft.client.input.MouseButtonEvent event, final boolean doubleClick) {
            onPress.accept(this);
        }

        @Override
        protected void extractWidgetRenderState(final GuiGraphicsExtractor g, final int mouseX, final int mouseY,
                                                final float partialTick) {
            int bg = toggle ? (on ? BTN_BG_ON : BTN_BG_OFF) : (isHovered() && active ? BTN_BG_HOVER : BTN_BG);
            g.fill(getX(), getY(), getX() + getWidth(), getY() + getHeight(), bg);
            outline(g, getX(), getY(), getWidth(), getHeight(), isFocused() ? SELECT : CHROME_BORDER);
            net.minecraft.client.gui.Font font = net.minecraft.client.Minecraft.getInstance().font;
            int textY = getY() + (getHeight() - 8) / 2 + 1;
            int room = getWidth() - 6 - (badge == null ? 0 : font.width(badge) + 3);
            g.text(font, clip(font, getMessage().getString(), Math.max(4, room)), getX() + 3, textY,
                active ? CHROME_TEXT : CHROME_TEXT_DIM, false);
            if (badge != null) {
                g.text(font, badge, getX() + getWidth() - 3 - font.width(badge), textY, CHROME_TEXT_DIM, false);
            }
        }

        @Override
        protected void updateWidgetNarration(final NarrationElementOutput output) {
            defaultButtonNarrationText(output);
        }

        @Override
        public @Nullable ComponentPath nextFocusPath(final FocusNavigationEvent navigationEvent) {
            // Out of the tab order: Tab belongs to the inspector's boxes, not to sixteen palette
            // buttons the human would have to walk past to reach them.
            return null;
        }
    }
}
