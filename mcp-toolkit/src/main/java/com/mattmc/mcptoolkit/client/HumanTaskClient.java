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
import net.minecraft.world.phys.Vec3;
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
 * The client half of the §15 task presenter (HUMAN_RIG_PLAN.md phase 4): renders the human's active
 * task as a world-space goal highlight (26.2 gizmos, emitted per client tick — strictly
 * CLIENT-RENDERED, so no fan can ever sight it; the plan's leak-proof-by-construction rule) plus a
 * HUD task card, in the house style the archived subtitle overlay set.
 *
 * <p>Task state arrives by PULL: a daemon tailer polls the bridge's {@code GET /humantask} snapshot
 * (the TranscriptTailer pattern) and keeps one volatile {@link TaskState}. The same loop works
 * against the integrated server (own JVM's bridge) and a localhost dedicated server (its bridge on
 * the same port this client failed to bind) — whichever process owns the port owns the task state.
 * A poll failure clears the card rather than freezing a stale task on screen.
 *
 * <p>Goal-token content only, by wire contract: the snapshot carries verb, target, rights, text,
 * tags — never waypoints (§13.4). The one route-shaped thing this class could ever draw, the
 * {@code assist:route} breadcrumbs, is deliberately NOT implemented yet: the server ships no route
 * to draw, and any future warm-up mode must carry its training-exclusion tag with it.
 */
@Environment(EnvType.CLIENT)
public final class HumanTaskClient {
    private HumanTaskClient() {}

    private static final long POLL_MS = 250;
    /** Beyond this, a guide arrow points from the eye toward the (possibly out-of-sight) target. */
    private static final double ARROW_DIST = 32;

    private record TaskState(String actionId, String action, BlockPos pos, String mayModify,
                             String text, List<String> tags) {}

    private static volatile @Nullable TaskState state;
    /** The local player's profile name, stashed on the client thread for the tailer. */
    private static volatile @Nullable String localName;
    private static volatile boolean running;

    public static void register() {
        ClientHooks.END_CLIENT_TICK.register(HumanTaskClient::tick);
        ClientHooks.HUD_EXTRACT.register(HumanTaskClient::draw);
        ClientHooks.DISCONNECT.register(() -> {
            state = null;
            localName = null;
        });
        running = true;
        Thread t = new Thread(HumanTaskClient::pollLoop, "mcptoolkit-humantask");
        t.setDaemon(true);
        t.start();
    }

    // ---- the tailer -------------------------------------------------------------

    private static void pollLoop() {
        HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(1)).build();
        int port = BridgeServer.boundPort() > 0 ? BridgeServer.boundPort() : 25599;
        URI uri = URI.create("http://127.0.0.1:" + port + "/humantask");
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
                JsonObject tasks = JsonParser.parseString(body).getAsJsonObject()
                    .getAsJsonObject("tasks");
                JsonObject t = tasks == null ? null
                    : tasks.getAsJsonObject(name.toLowerCase(Locale.ROOT));
                state = t == null ? null : parse(t);
            } catch (Exception e) {
                // Bridge unreachable or malformed — drop the card instead of freezing a stale task.
                if (state != null) {
                    McpToolkit.LOGGER.debug("[MCP Toolkit] humantask poll failed: {}", e.toString());
                }
                state = null;
            }
        }
    }

    private static TaskState parse(final JsonObject t) {
        JsonObject at = t.getAsJsonObject("at");
        List<String> tags = new ArrayList<>();
        if (t.has("tags") && t.get("tags").isJsonArray()) {
            for (var el : t.getAsJsonArray("tags")) {
                tags.add(el.getAsString());
            }
        }
        return new TaskState(
            t.get("action_id").getAsString(),
            t.get("action").getAsString(),
            new BlockPos(at.get("x").getAsInt(), at.get("y").getAsInt(), at.get("z").getAsInt()),
            t.has("may_modify") ? t.get("may_modify").getAsString() : "none",
            t.get("text").getAsString(),
            List.copyOf(tags));
    }

    // ---- world-space highlight (per client tick — inside the tick gizmo collector) ----

    private static void tick(final Minecraft mc) {
        localName = mc.player == null ? null : mc.player.getGameProfile().name();
        TaskState s = state;
        if (s == null || mc.level == null || mc.player == null) {
            return;
        }
        int rgb = verbColor(s.action());
        GizmoStyle style = GizmoStyle.strokeAndFill(
            0xFF000000 | rgb, 3.0F, 0x30000000 | rgb);
        // Always-on-top: a traverse target behind two hills must still read as "over there".
        Gizmos.cuboid(s.pos(), 0.05F, style).setAlwaysOnTop();
        Gizmos.billboardTextOverBlock(verbLabel(s.action()), s.pos(), 0, 0xFF000000 | rgb, 1.0F);

        Vec3 target = Vec3.atCenterOf(s.pos());
        if (mc.player.position().distanceTo(target) > ARROW_DIST) {
            Vec3 eye = mc.player.getEyePosition();
            Vec3 dir = target.subtract(eye).normalize();
            Gizmos.arrow(eye.add(dir.scale(2.0)), eye.add(dir.scale(4.5)), 0xE0000000 | rgb, 2.5F)
                .setAlwaysOnTop();
        }
    }

    // ---- the task card (anchored top-right) ------------------------------------

    private static void draw(final GuiGraphicsExtractor g, final DeltaTracker delta,
                             final boolean hidden) {
        TaskState s = state;
        if (s == null || hidden) {
            return;
        }
        Minecraft mc = Minecraft.getInstance();
        if (mc.player == null) {
            return;
        }
        Font font = mc.font;
        int dist = (int) Math.round(mc.player.position().distanceTo(Vec3.atCenterOf(s.pos())));

        record Row(FormattedCharSequence text, int color) {}
        List<Row> rows = new ArrayList<>(4);
        int rgb = 0xFF000000 | verbColor(s.action());
        rows.add(new Row(seq("TASK · " + verbLabel(s.action())), rgb));
        rows.add(new Row(seq(s.text()), ARGB.white(255)));
        rows.add(new Row(seq("(" + s.pos().getX() + ", " + s.pos().getY() + ", " + s.pos().getZ()
            + ")  —  " + dist + " m"), ARGB.white(210)));
        if (!"none".equals(s.mayModify())) {
            rows.add(new Row(seq("may modify: " + s.mayModify()), ARGB.white(160)));
        }
        if (!s.tags().isEmpty()) {
            rows.add(new Row(seq(String.join("  ", s.tags())), 0xFFFFB84D));
        }

        int maxW = 0;
        for (Row r : rows) {
            maxW = Math.max(maxW, font.width(r.text()));
        }
        int lineH = font.lineHeight + 2;
        int cx = g.guiWidth() - 6 - maxW / 2 - 3;
        int y = 6;
        g.nextStratum();
        int plate = ARGB.multiply(mc.options.getBackgroundColor(0.0F), ARGB.white(255));
        if (plate != 0) {
            g.fill(cx - maxW / 2 - 3, y - 3, cx + maxW / 2 + 3, y + rows.size() * lineH + 1, plate);
        }
        for (Row r : rows) {
            g.centeredText(font, r.text(), cx, y, r.color());
            y += lineH;
        }
    }

    // ---- helpers ----------------------------------------------------------------

    private static FormattedCharSequence seq(final String s) {
        return Component.literal(s).getVisualOrderText();
    }

    private static int verbColor(final String action) {
        return switch (action) {
            case "destroy" -> 0xFF5040; // break = warm red
            case "place" -> 0x40E070;   // place = green
            default -> 0xFFC825;        // move = gold
        };
    }

    private static String verbLabel(final String action) {
        return switch (action) {
            case "destroy" -> "BREAK";
            case "place" -> "PLACE";
            default -> "GO HERE";
        };
    }
}
