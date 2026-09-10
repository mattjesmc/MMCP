package com.mattmc.mcptoolkit.client;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.mattmc.mcptoolkit.BridgeServer;
import com.mattmc.mcptoolkit.McpToolkit;
import com.mattmc.mcptoolkit.hooks.client.ClientHooks;
import net.fabricmc.api.EnvType;
import net.fabricmc.api.Environment;
import net.minecraft.client.DeltaTracker;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.core.BlockPos;
import net.minecraft.gizmos.GizmoStyle;
import net.minecraft.gizmos.Gizmos;
import net.minecraft.network.chat.Component;
import net.minecraft.util.ARGB;
import net.minecraft.util.FormattedCharSequence;
import org.jspecify.annotations.Nullable;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * <b>The review question, on screen while you are looking at the thing it is about.</b>
 *
 * <p>Both mods this layer came from asked their questions in chat, and chat is where a question goes
 * to be scrolled away: by the time somebody has walked round the subject twice, "what was I supposed
 * to be judging?" costs a {@code /mmcp review status}. The card stays up until the ask is answered, and
 * — the half that matters most — <b>it keeps FAILS IF in front of the reviewer</b>, which is the
 * whole reason the failure mode is a required field.
 *
 * <p>Same delivery as the §15 task presenter ({@link HumanTaskClient}): a daemon tailer polls
 * {@code GET /review} and keeps one volatile state, so the integrated server and a localhost
 * dedicated server work identically, and a poll failure clears the card rather than freezing a
 * stale question on screen. Anchored top-LEFT, because the task card owns top-right and the Claude
 * subtitles own top-centre.
 */
@Environment(EnvType.CLIENT)
public final class ReviewCard {
    private ReviewCard() {}

    private static final long POLL_MS = 500;
    /** Wrap width for the card's prose rows — wide enough to read, narrow enough to stay a card. */
    private static final int WRAP = 210;

    private record AskState(String id, String source, String title, String look, String failure,
                            int open, @Nullable String staged, @Nullable BlockPos at) {}

    private static volatile @Nullable AskState state;
    private static volatile @Nullable String localName;
    private static volatile boolean running;

    public static void register() {
        ClientHooks.END_CLIENT_TICK.register(ReviewCard::tick);
        ClientHooks.HUD_EXTRACT.register(ReviewCard::draw);
        ClientHooks.DISCONNECT.register(() -> {
            state = null;
            localName = null;
        });
        running = true;
        Thread t = new Thread(ReviewCard::pollLoop, "mcptoolkit-review");
        t.setDaemon(true);
        t.start();
    }

    // ---- the tailer -------------------------------------------------------------

    private static void pollLoop() {
        HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(1)).build();
        int port = BridgeServer.boundPort() > 0 ? BridgeServer.boundPort() : 25599;
        URI uri = URI.create("http://127.0.0.1:" + port + "/review");
        while (running) {
            try {
                Thread.sleep(POLL_MS);
            } catch (InterruptedException e) {
                return;
            }
            String name = localName;
            if (name == null) {
                state = null;
                continue;
            }
            try {
                HttpRequest req = HttpRequest.newBuilder(uri)
                    .timeout(Duration.ofSeconds(1)).GET().build();
                String body = http.send(req, HttpResponse.BodyHandlers.ofString()).body();
                JsonObject asks = JsonParser.parseString(body).getAsJsonObject()
                    .getAsJsonObject("asks");
                JsonObject mine = asks == null ? null
                    : asks.getAsJsonObject(name.toLowerCase(Locale.ROOT));
                state = mine == null ? null : parse(mine);
            } catch (Exception e) {
                if (state != null) {
                    McpToolkit.LOGGER.debug("[MCP Toolkit] review poll failed: {}", e.toString());
                }
                state = null;
            }
        }
    }

    private static AskState parse(final JsonObject o) {
        BlockPos at = null;
        if (o.has("at") && o.get("at").isJsonObject()) {
            JsonObject p = o.getAsJsonObject("at");
            at = new BlockPos(p.get("x").getAsInt(), p.get("y").getAsInt(), p.get("z").getAsInt());
        }
        return new AskState(
            o.get("id").getAsString(),
            o.has("source") ? o.get("source").getAsString() : "?",
            o.get("title").getAsString(),
            o.get("look").getAsString(),
            o.get("failure").getAsString(),
            o.has("open") ? o.get("open").getAsInt() : 0,
            o.has("staged") ? o.get("staged").getAsString() : null,
            at);
    }

    // ---- the subject's highlight ------------------------------------------------

    private static void tick(final Minecraft mc) {
        localName = mc.player == null ? null : mc.player.getGameProfile().name();
        AskState s = state;
        if (s == null || s.at() == null || mc.level == null) {
            return;
        }
        // Client-rendered, like the task highlight: nothing the server can sight, so a marker put
        // up for a human can never leak into anything the toolkit's own senses read.
        GizmoStyle style = GizmoStyle.strokeAndFill(0xFF35D0E0, 3.0F, 0x3035D0E0);
        Gizmos.cuboid(s.at(), 0.05F, style).setAlwaysOnTop();
        Gizmos.billboardTextOverBlock("REVIEW", s.at(), 0, 0xFF35D0E0, 1.0F);
    }

    // ---- the card ---------------------------------------------------------------

    /** One drawn line: pre-wrapped text and the colour that says what kind of line it is. */
    private record Row(FormattedCharSequence text, int color) {}

    private static void draw(final GuiGraphicsExtractor g, final DeltaTracker delta,
                             final boolean hidden) {
        AskState s = state;
        if (s == null || hidden) {
            return;
        }
        Font font = Minecraft.getInstance().font;

        List<Row> rows = new ArrayList<>(8);
        rows.add(new Row(seq("REVIEW · " + s.source() + "  ·  " + s.open() + " open"), 0xFF35D0E0));
        wrap(font, rows, s.title(), ARGB.white(255));
        wrap(font, rows, "LOOK: " + s.look(), ARGB.white(215));
        // The one row this card exists for. Amber rather than white: a reviewer who has forgotten
        // what wrong looks like will agree with whatever is in front of them.
        wrap(font, rows, "FAILS IF: " + s.failure(), 0xFFFFB84D);
        if (s.staged() != null && !s.staged().isBlank()) {
            wrap(font, rows, s.staged(), ARGB.white(150));
        }
        rows.add(new Row(seq("/mmcp review ok | no <why> | note <what> | skip"), ARGB.white(130)));

        int maxW = 0;
        for (Row r : rows) {
            maxW = Math.max(maxW, font.width(r.text()));
        }
        int lineH = font.lineHeight + 2;
        int x = 6;
        int y = 6;
        g.nextStratum();
        int plate = ARGB.multiply(Minecraft.getInstance().options.getBackgroundColor(0.0F),
            ARGB.white(255));
        if (plate != 0) {
            g.fill(x - 3, y - 3, x + maxW + 3, y + rows.size() * lineH + 1, plate);
        }
        for (Row r : rows) {
            g.text(font, r.text(), x, y, r.color());
            y += lineH;
        }
    }

    private static void wrap(final Font font, final List<Row> rows, final String text,
                             final int color) {
        for (FormattedCharSequence line : font.split(Component.literal(text), WRAP)) {
            rows.add(new Row(line, color));
        }
    }

    private static FormattedCharSequence seq(final String s) {
        return Component.literal(s).getVisualOrderText();
    }
}
