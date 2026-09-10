package com.mattmc.mcptoolkit.ui.interp;

import com.mattmc.mcptoolkit.ui.doc.Kind;
import net.fabricmc.api.EnvType;
import net.fabricmc.api.Environment;
import net.minecraft.client.gui.ComponentPath;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.narration.NarrationElementOutput;
import net.minecraft.client.gui.navigation.FocusNavigationEvent;
import net.minecraft.client.sounds.SoundManager;
import net.minecraft.network.chat.Component;
import org.jspecify.annotations.Nullable;

/**
 * A decorative element as a real widget: panels, wells, frames, bars, regions.
 *
 * <p>Why a widget at all for something that cannot be clicked: because {@code get_screen},
 * {@code check_layout} and {@code screenshot_annotated} read the widget tree and nothing else. A
 * panel painted from {@code render()} is invisible to all three - the exact blindness
 * SCREEN_AUTHORING_DESIGN.md section 1 exists to end. So decoration is declared, and it is
 * {@code active = false}: vanilla's {@code AbstractWidget.mouseClicked} gates on {@code active}, so a
 * panel under a button never takes the click, and {@code check_layout}'s overlap rule (active
 * widgets only) does not flag a button for sitting on the panel it belongs on.
 */
@Environment(EnvType.CLIENT)
public final class DecorWidget extends AbstractWidget implements UiDeclared {
    /**
     * How to paint this rectangle, in absolute coordinates. The mouse and partial tick ride along
     * because the emitted screen's {@code drawRegion_*} hooks (section 4.4) take them; the
     * interpreter's own painters ignore them, and the two signatures are kept identical so the
     * vendored copy of this class is this class.
     */
    @FunctionalInterface
    public interface Painter {
        void paint(GuiGraphicsExtractor g, int x, int y, int w, int h, int mouseX, int mouseY, float partialTick);
    }

    private final @Nullable String id;
    private final Kind kind;
    private final Painter painter;

    public DecorWidget(final @Nullable String id, final Kind kind, final int x, final int y, final int w, final int h,
                       final Painter painter) {
        // An EMPTY message, not the id: the message is the label a human reads and check_layout
        // measures against the width (the first live run flagged every bar and icon as "label
        // overflow" for carrying its id there). The id travels through UiDeclared instead.
        super(x, y, w, h, Component.empty());
        this.id = id;
        this.kind = kind;
        this.painter = painter;
        this.active = false;
    }

    @Override
    public @Nullable String uiId() {
        return id;
    }

    @Override
    public Kind uiKind() {
        return kind;
    }

    @Override
    protected void extractWidgetRenderState(final GuiGraphicsExtractor graphics, final int mouseX, final int mouseY, final float partialTick) {
        painter.paint(graphics, getX(), getY(), getWidth(), getHeight(), mouseX, mouseY, partialTick);
    }

    @Override
    protected void updateWidgetNarration(final NarrationElementOutput output) {
        // Decoration narrates nothing.
    }

    @Override
    public @Nullable ComponentPath nextFocusPath(final FocusNavigationEvent navigationEvent) {
        return null; // never in the tab order
    }

    @Override
    public void playDownSound(final SoundManager soundManager) {
        // Silent: nothing was pressed.
    }
}
