package com.mattmc.mcptoolkit.ui;

/**
 * The workspace's inventory-screen palette, as named constants.
 *
 * <p>Relocated from {@code ui-kit/} slice 1 ({@code com.mattmc.mcui.Palette}) per
 * SCREEN_AUTHORING_DESIGN.md section 16: it is now the interpreter's palette and, from slice 2 on,
 * the source the emitter inlines into each mod's {@code <Mod>Paint.java}. Every colour here was
 * already a {@code private static final int} in at least two of villagejobs' {@code CatalogScreen} /
 * {@code BuildingBrowserScreen} / {@code BuilderWorkstationScreen}, nijntje's {@code NijntjeScreen}
 * and rocketeer's {@code RocketScreen}.
 *
 * <p>Plain ints, no Minecraft classes: the document model ({@code ui.doc}) reads its default label
 * colour from here, and the model must not import Minecraft (section 7.1).
 */
public final class Palette {
    private Palette() {}

    // --- The bevel. Vanilla's own container grey, lit from the top-left. ---
    public static final int PANEL_BG = 0xFFC6C6C6;
    public static final int PANEL_EDGE_LIGHT = 0xFFFFFFFF;
    public static final int PANEL_EDGE_DARK = 0xFF555555;
    /** The recessed interior of a list or field - a panel with the light source inverted. */
    public static final int WELL_BG = 0xFF8B8B8B;

    // --- Text. These two are vanilla's: AbstractContainerScreen.extractLabels passes -12566464
    // for both the title and the inventory label, which is 0xFF404040. ---
    /** 0xFF404040, i.e. vanilla's -12566464. */
    public static final int LABEL_COLOR = 0xFF404040;
    /** 0xFF808080, i.e. -8355712. Secondary text: units, hints, column headers. */
    public static final int DIM_COLOR = 0xFF808080;

    /** Selection wash for a list row. Deliberately translucent, so it darkens whatever is beneath. */
    public static final int SELECTED_BG = 0x60000000;

    // --- Status. The bill-of-materials shape: one colour per line, not per screen. ---
    public static final int MISSING_COLOR = 0xFFAA0000;
    public static final int OK_COLOR = 0xFF206020;

    // --- Frames. The outer screen border nijntje and rocketeer both draw as two nested fills. ---
    public static final int SCREEN_FRAME = 0xFF373737;
    /** The 1px surround on a progress bar. Darker than {@link #SCREEN_FRAME}: it sits on the panel. */
    public static final int BAR_FRAME = 0xFF202020;

    // --- Bars. The defaults a `bar` element paints with when the document names no colour. ---
    /** The filled part of a bar: the same green the status colour uses for "ok". */
    public static final int BAR_FILL = OK_COLOR;
    /** The empty part of a bar: the well grey, so an empty bar reads as a recessed track. */
    public static final int BAR_TRACK = WELL_BG;
}
