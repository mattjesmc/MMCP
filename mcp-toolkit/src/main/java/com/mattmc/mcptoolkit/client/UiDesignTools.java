package com.mattmc.mcptoolkit.client;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.ExecutionContext;
import com.mattmc.mcptoolkit.McpTools;
import com.mattmc.mcptoolkit.Mechanism;
import com.mattmc.mcptoolkit.Schemas;
import com.mattmc.mcptoolkit.ToolContext;
import com.mattmc.mcptoolkit.ToolDef;
import net.fabricmc.api.EnvType;
import net.fabricmc.api.Environment;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.screens.Screen;

import javax.imageio.ImageIO;
import java.awt.BasicStroke;
import java.awt.Color;
import java.awt.Font;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.concurrent.CompletableFuture;

/**
 * UI-design tools: make the design loop fast and its feedback machine-legible. Where {@link UiTools} lets an
 * agent <em>drive</em> an existing screen, these help it <em>author</em> one —
 * <ul>
 *   <li>{@code screenshot_annotated} — a framebuffer capture with each widget's box + index drawn on, so a
 *       screenshot correlates to the {@code get_screen} tree instead of being opaque pixels;</li>
 *   <li>{@code measure_text} — the pixel width of a string in Minecraft's variable-width font, which an
 *       agent otherwise cannot compute (so button/field sizing stops being guesswork);</li>
 *   <li>{@code check_layout} — a deterministic problem list (off-screen, overlap, label overflow) so layout
 *       feedback is something to act on, not something to eyeball.</li>
 * </ul>
 * All run on the client thread.
 */
@Environment(EnvType.CLIENT)
public final class UiDesignTools {
    private UiDesignTools() {}

    public static void register() {
        McpTools.register(ToolDef.async(
            "screenshot_annotated",
            "Capture the current screen with every widget's bounding box and get_screen index drawn on top "
                + "(colored by state: lime=active, grey=inactive, magenta=focused, cyan=hovered). This is the "
                + "bridge between get_screen (structure) and screenshot (pixels) — use it to judge layout. "
                + "Optional \"grid\":true overlays a coordinate ruler in GUI-scaled pixels. Errors if no screen is open.",
            Schemas.objectOpt(
                Schemas.object("grid", Schemas.bool("Overlay a GUI-scaled coordinate ruler (default false).")),
                "grid"),
            ExecutionContext.CLIENT,
            Mechanism.OBSERVE,
            UiDesignTools::screenshotAnnotated));

        McpTools.register(ToolDef.of(
            "measure_text",
            "Measure a string in Minecraft's font. Returns {\"width\":<GUI-scaled px>, \"lineHeight\":9, "
                + "\"guiScale\":<n>}. width is in GUI (unscaled) pixels — the same coordinate space as widget "
                + "x/y/width from get_screen — so you can size a button or field to fit its label without guessing.",
            Schemas.object("text", Schemas.str("The string to measure.")),
            ExecutionContext.CLIENT,
            Mechanism.OBSERVE,
            (ctx, a) -> measureText(a)));

        McpTools.register(ToolDef.of(
            "check_layout",
            "Lint the current screen's layout geometrically and return a list of problems: widgets off the "
                + "screen edges, overlapping interactable widgets, and labels wider than their widget. Each "
                + "problem names the widget index/indices (as in get_screen) so you can fix and re-check. "
                + "Returns {\"problems\":[]} for a clean screen (with unenumerated_listeners naming any "
                + "interactive children the geometry check could not cover); errors if no screen is open.",
            Schemas.object(),
            ExecutionContext.CLIENT,
            Mechanism.OBSERVE,
            (ctx, a) -> checkLayout()));
    }

    // ---- geometry snapshot ---------------------------------------------------

    /** Immutable snapshot of one widget's geometry + state, taken on the client thread. */
    private record WidgetBox(int index, String cls, int x, int y, int w, int h, String label,
                             boolean active, boolean visible, boolean focused, boolean hovered, boolean isText) {}

    private static List<WidgetBox> snapshot(final Screen screen) {
        // The full recursive walk (UiTools.collectWidgets), not ToolkitScreens.widgets: top-level-only
        // enumeration made check_layout issue clean verdicts over list rows it never examined, and
        // annotated screenshots under-count. Indexes match get_screen/click.
        List<AbstractWidget> ws = UiTools.collectWidgets(screen).widgets();
        List<WidgetBox> out = new ArrayList<>(ws.size());
        for (int i = 0; i < ws.size(); i++) {
            AbstractWidget w = ws.get(i);
            out.add(new WidgetBox(i, w.getClass().getSimpleName(), w.getX(), w.getY(), w.getWidth(), w.getHeight(),
                w.getMessage() == null ? "" : w.getMessage().getString(),
                w.active, w.visible, w.isFocused(), w.isHovered(),
                w instanceof net.minecraft.client.gui.components.AbstractStringWidget
                    || w instanceof com.mattmc.mcptoolkit.ui.interp.LabelWidget
                    // A GENERATED screen's label is a vendored class this toolkit cannot name; it
                    // declares its kind instead (slice 2's first live run flagged "Fuel" on one).
                    || isDeclaredLabel(w)));
        }
        return out;
    }

    private static boolean isDeclaredLabel(final AbstractWidget w) {
        com.mattmc.mcptoolkit.ui.interp.UiDeclared d = com.mattmc.mcptoolkit.ui.interp.UiDeclared.of(w);
        return d != null && d.uiKind() == com.mattmc.mcptoolkit.ui.doc.Kind.LABEL;
    }

    // ---- screenshot_annotated (async) ----------------------------------------

    private static CompletableFuture<JsonElement> screenshotAnnotated(final ToolContext ctx, final JsonObject a) {
        Minecraft mc = Minecraft.getInstance();
        Screen screen = mc.gui.screen();
        if (screen == null) {
            throw new IllegalStateException("no screen open");
        }
        boolean grid = a.has("grid") && !a.get("grid").isJsonNull() && a.get("grid").getAsBoolean();
        // Snapshot geometry now, on the client thread. The screenshot callback fires on a later render frame;
        // touching the live widget tree from there would be a cross-thread read.
        List<WidgetBox> boxes = snapshot(screen);
        int unenumerated = UiTools.collectWidgets(screen).unenumerated();
        int scaledW = screen.width;
        int scaledH = screen.height;

        var target = mc.gameRenderer.mainRenderTarget();
        CompletableFuture<JsonElement> out = new CompletableFuture<>();
        net.minecraft.client.Screenshot.takeScreenshot(target, image -> {
            try (image) {
                Path tmp = Files.createTempFile("mcptk-annot", ".png");
                BufferedImage img;
                try {
                    image.writeToFile(tmp);
                    img = ImageIO.read(tmp.toFile());
                } finally {
                    Files.deleteIfExists(tmp);
                }
                // GUI coords -> physical pixels. Derive the scale from the image itself so it's right even
                // for odd window sizes and needs no gui-scale API.
                double sx = img.getWidth() / (double) scaledW;
                double sy = img.getHeight() / (double) scaledH;
                draw(img, boxes, grid, sx, sy, scaledW, scaledH);

                ByteArrayOutputStream baos = new ByteArrayOutputStream();
                ImageIO.write(img, "png", baos);
                byte[] png = baos.toByteArray();

                JsonObject r = new JsonObject();
                JsonObject imgOut = new JsonObject();
                imgOut.addProperty("mimeType", "image/png");
                imgOut.addProperty("base64", Base64.getEncoder().encodeToString(png));
                r.add("_image", imgOut);
                r.addProperty("width", img.getWidth());
                r.addProperty("height", img.getHeight());
                r.addProperty("widgetCount", boxes.size());
                if (unenumerated > 0) {
                    r.addProperty("unenumerated_listeners", unenumerated);
                }
                out.complete(r);
            } catch (Exception e) {
                out.completeExceptionally(e);
            }
        });
        return out;
    }

    private static void draw(final BufferedImage img, final List<WidgetBox> boxes, final boolean grid,
                             final double sx, final double sy, final int scaledW, final int scaledH) {
        Graphics2D g = img.createGraphics();
        try {
            g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
            g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);

            if (grid) {
                drawGrid(g, sx, sy, scaledW, scaledH);
            }

            Font labelFont = new Font(Font.MONOSPACED, Font.BOLD, 12);
            g.setFont(labelFont);
            for (WidgetBox b : boxes) {
                if (!b.visible()) {
                    continue;
                }
                int px = (int) Math.round(b.x() * sx);
                int py = (int) Math.round(b.y() * sy);
                int pw = (int) Math.round(b.w() * sx);
                int ph = (int) Math.round(b.h() * sy);

                Color c = b.focused() ? Color.MAGENTA
                    : b.hovered() ? Color.CYAN
                    : b.active() ? new Color(0x66, 0xFF, 0x33)
                    : new Color(0xAA, 0xAA, 0xAA);
                g.setStroke(new BasicStroke(2f));
                g.setColor(c);
                g.drawRect(px, py, pw, ph);

                // Index chip at the box's top-left, on a solid backing so it reads over any content.
                String tag = String.valueOf(b.index());
                var fm = g.getFontMetrics();
                int tw = fm.stringWidth(tag);
                int th = fm.getAscent() + fm.getDescent();
                int chipX = px;
                int chipY = Math.max(0, py - th);
                g.setColor(new Color(0, 0, 0, 200));
                g.fillRect(chipX, chipY, tw + 6, th);
                g.setColor(c);
                g.drawString(tag, chipX + 3, chipY + fm.getAscent());
            }
        } finally {
            g.dispose();
        }
    }

    private static void drawGrid(final Graphics2D g, final double sx, final double sy,
                                 final int scaledW, final int scaledH) {
        final int step = 20; // GUI-scaled pixels between rulers
        g.setStroke(new BasicStroke(1f));
        g.setFont(new Font(Font.MONOSPACED, Font.PLAIN, 10));
        Color line = new Color(255, 255, 255, 60);
        Color text = new Color(255, 255, 255, 160);
        int physW = (int) Math.round(scaledW * sx);
        int physH = (int) Math.round(scaledH * sy);
        for (int gx = 0; gx <= scaledW; gx += step) {
            int px = (int) Math.round(gx * sx);
            g.setColor(line);
            g.drawLine(px, 0, px, physH);
            g.setColor(text);
            g.drawString(String.valueOf(gx), px + 2, 10);
        }
        for (int gy = 0; gy <= scaledH; gy += step) {
            int py = (int) Math.round(gy * sy);
            g.setColor(line);
            g.drawLine(0, py, physW, py);
            g.setColor(text);
            g.drawString(String.valueOf(gy), 2, py - 1);
        }
    }

    // ---- measure_text --------------------------------------------------------

    private static JsonElement measureText(final JsonObject a) {
        if (!a.has("text") || a.get("text").isJsonNull()) {
            throw new IllegalArgumentException("missing argument 'text'");
        }
        Minecraft mc = Minecraft.getInstance();
        String text = a.get("text").getAsString();
        JsonObject r = new JsonObject();
        r.addProperty("width", mc.font.width(text));
        r.addProperty("lineHeight", mc.font.lineHeight);
        r.addProperty("guiScale", mc.getWindow().getGuiScale());
        return r;
    }

    // ---- check_layout --------------------------------------------------------

    private static JsonElement checkLayout() {
        Minecraft mc = Minecraft.getInstance();
        Screen screen = mc.gui.screen();
        if (screen == null) {
            throw new IllegalStateException("no screen open");
        }
        int sw = screen.width;
        int sh = screen.height;
        List<WidgetBox> boxes = snapshot(screen);
        JsonArray problems = new JsonArray();

        for (WidgetBox b : boxes) {
            if (!b.visible()) {
                continue;
            }
            // Off-screen: any part outside the screen rect.
            if (b.x() < 0 || b.y() < 0 || b.x() + b.w() > sw || b.y() + b.h() > sh) {
                JsonObject p = new JsonObject();
                p.addProperty("type", "offscreen");
                p.add("widgets", one(b.index()));
                p.addProperty("detail", describe(b) + " extends outside the "
                    + sw + "x" + sh + " screen (bounds " + b.x() + "," + b.y()
                    + " " + b.w() + "x" + b.h() + ")");
                problems.add(p);
            }
            // Label overflow: text wider than the widget can show (buttons render with ~a few px of padding).
            // Not for widgets that ARE text: a natural-width label is exactly as wide as its string, and
            // a scrolling or truncated one is narrower by design.
            if (!b.label().isEmpty() && b.w() > 0 && !b.isText()) {
                int textW = mc.font.width(b.label());
                if (textW > b.w() - 4) {
                    JsonObject p = new JsonObject();
                    p.addProperty("type", "label_overflow");
                    p.add("widgets", one(b.index()));
                    p.addProperty("detail", describe(b) + " label \"" + b.label() + "\" is "
                        + textW + "px wide but the widget is only " + b.w() + "px");
                    problems.add(p);
                }
            }
        }

        // Overlap between interactable widgets — a common accidental-stacking bug.
        for (int i = 0; i < boxes.size(); i++) {
            WidgetBox bi = boxes.get(i);
            if (!bi.visible() || !bi.active()) {
                continue;
            }
            for (int j = i + 1; j < boxes.size(); j++) {
                WidgetBox bj = boxes.get(j);
                if (!bj.visible() || !bj.active()) {
                    continue;
                }
                int ox = Math.max(0, Math.min(bi.x() + bi.w(), bj.x() + bj.w()) - Math.max(bi.x(), bj.x()));
                int oy = Math.max(0, Math.min(bi.y() + bi.h(), bj.y() + bj.h()) - Math.max(bi.y(), bj.y()));
                if (ox > 0 && oy > 0) {
                    JsonObject p = new JsonObject();
                    p.addProperty("type", "overlap");
                    JsonArray idx = new JsonArray();
                    idx.add(bi.index());
                    idx.add(bj.index());
                    p.add("widgets", idx);
                    p.addProperty("detail", describe(bi) + " and " + describe(bj)
                        + " overlap by " + ox + "x" + oy + "px");
                    problems.add(p);
                }
            }
        }

        JsonObject r = new JsonObject();
        JsonObject s = new JsonObject();
        s.addProperty("width", sw);
        s.addProperty("height", sh);
        s.addProperty("class", screen.getClass().getSimpleName());
        r.add("screen", s);
        r.add("problems", problems);
        r.addProperty("problemCount", problems.size());
        int unenumerated = UiTools.collectWidgets(screen).unenumerated();
        if (unenumerated > 0) {
            // A clean verdict must name its blind spot: these interactive children were not
            // geometry-checked because they cannot be read as widget boxes.
            r.addProperty("unenumerated_listeners", unenumerated);
            r.addProperty("note", "problems cover the " + boxes.size() + " enumerable widgets; "
                + unenumerated + " interactive listener(s) could not be geometry-checked");
        }
        return r;
    }

    private static JsonArray one(final int index) {
        JsonArray a = new JsonArray();
        a.add(index);
        return a;
    }

    private static String describe(final WidgetBox b) {
        String lbl = b.label().isEmpty() ? "" : " \"" + b.label() + "\"";
        return "widget " + b.index() + " (" + b.cls() + lbl + ")";
    }
}
