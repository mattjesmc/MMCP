package com.mattmc.mcptoolkit.ui.interp;

import com.mattmc.mcptoolkit.ui.doc.Element.LabelMode;
import com.mattmc.mcptoolkit.ui.doc.Kind;
import net.fabricmc.api.EnvType;
import net.fabricmc.api.Environment;
import net.minecraft.util.Util;
import net.minecraft.client.gui.ComponentPath;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.narration.NarrationElementOutput;
import net.minecraft.client.gui.navigation.FocusNavigationEvent;
import net.minecraft.client.sounds.SoundManager;
import net.minecraft.locale.Language;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.FormattedText;
import net.minecraft.util.Mth;
import org.jspecify.annotations.Nullable;

/**
 * The {@code label} element: ui-lib's four text variants over one widget.
 *
 * <p>Why not vanilla's {@code StringWidget}/{@code MultiLineTextWidget}: in 26.2 a widget's text
 * colour rides the {@code Component}'s {@code Style} and the drop shadow is the collector's default
 * (on), so a container-screen label - {@code 0xFF404040}, no shadow, exactly what
 * {@code AbstractContainerScreen.extractLabels} draws - has no vanilla widget that draws it. This one
 * draws through {@code GuiGraphicsExtractor.text(font, text, x, y, color, dropShadow)}, which takes
 * both explicitly, and slice 2 prints the same call.
 *
 * <p>Natural size: {@code w == 0} measures the text; {@code h == 0} is one line (9px) or, wrapped,
 * the line count times 9. Scrolling copies vanilla's {@code defaultScrollingHelper} timing so a
 * scrolling label and a scrolling button move in step.
 */
@Environment(EnvType.CLIENT)
public final class LabelWidget extends AbstractWidget implements UiDeclared {
    /** Vanilla's line height, the constant {@code MultiLineTextWidget} and the scrolling helper both hard-code. */
    public static final int LINE_HEIGHT = 9;
    private static final String ELLIPSIS = "...";

    private final @Nullable String id;
    private final Font font;
    private final LabelMode mode;
    private final int color;
    private final boolean shadow;

    public LabelWidget(final @Nullable String id, final int x, final int y, final int w, final int h,
                       final Component text, final Font font, final LabelMode mode, final int color, final boolean shadow) {
        super(x, y, w > 0 ? w : font.width(text), h > 0 ? h : naturalHeight(font, text, w, mode), text);
        this.id = id;
        this.font = font;
        this.mode = mode;
        this.color = color;
        this.shadow = shadow;
        this.active = false;
    }

    private static int naturalHeight(final Font font, final Component text, final int w, final LabelMode mode) {
        if (mode == LabelMode.WRAPPED && w > 0) {
            return Math.max(1, font.split(text, w).size()) * LINE_HEIGHT;
        }
        return LINE_HEIGHT;
    }

    @Override
    public @Nullable String uiId() {
        return id;
    }

    @Override
    public Kind uiKind() {
        return Kind.LABEL;
    }

    public LabelMode mode() {
        return mode;
    }

    @Override
    protected void extractWidgetRenderState(final GuiGraphicsExtractor g, final int mouseX, final int mouseY, final float a) {
        Component text = getMessage();
        int x = getX();
        int w = getWidth();
        int h = getHeight();
        // A one-line label in a box taller than a line sits where vanilla's scrolling helper would
        // put it; a natural-height label sits at its y.
        int lineY = h > LINE_HEIGHT ? (getY() + getY() + h - LINE_HEIGHT) / 2 + 1 : getY();
        switch (mode) {
            case PLAIN -> g.text(font, text, x, lineY, color, shadow);
            case WRAPPED -> g.textWithWordWrap(font, text, x, getY(), w, color, shadow);
            case TRUNCATED -> {
                if (font.width(text) <= w) {
                    g.text(font, text, x, lineY, color, shadow);
                } else {
                    FormattedText cut = font.substrByWidth(text, Math.max(0, w - font.width(ELLIPSIS)));
                    g.text(font, Language.getInstance().getVisualOrder(cut), x, lineY, color, shadow);
                    g.text(font, ELLIPSIS, x + font.width(cut), lineY, color, shadow);
                }
            }
            case SCROLLING -> {
                int lineWidth = font.width(text);
                if (lineWidth <= w) {
                    g.text(font, text, x, lineY, color, shadow);
                } else {
                    // Vanilla's defaultScrollingHelper, verbatim, so every scrolling string on a screen
                    // breathes at the same rate.
                    int maxPosition = lineWidth - w;
                    double time = Util.getMillis() / 1000.0;
                    double period = Math.max(maxPosition * 0.5, 3.0);
                    double alpha = Math.sin((Math.PI / 2) * Math.cos((Math.PI * 2) * time / period)) / 2.0 + 0.5;
                    double pos = Mth.lerp(alpha, 0.0, maxPosition);
                    g.enableScissor(x, getY(), x + w, getY() + h);
                    g.text(font, text, x - (int) pos, lineY, color, shadow);
                    g.disableScissor();
                }
            }
        }
    }

    @Override
    protected void updateWidgetNarration(final NarrationElementOutput output) {
        // Static text narrates as part of the screen, not as a focusable element.
    }

    @Override
    public @Nullable ComponentPath nextFocusPath(final FocusNavigationEvent navigationEvent) {
        return null;
    }

    @Override
    public void playDownSound(final SoundManager soundManager) {
        // Silent.
    }
}
