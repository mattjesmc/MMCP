package com.mattmc.mcptoolkit.client;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.hooks.client.ClientHooks;
import net.fabricmc.api.EnvType;
import net.fabricmc.api.Environment;

import java.util.ArrayDeque;
import java.util.Deque;

/**
 * A bounded client-side ring buffer of received chat and system messages, so a tool can read what the
 * player sees — including command feedback broadcast to the client. Cleared on disconnect.
 */
@Environment(EnvType.CLIENT)
public final class ChatLog {
    private ChatLog() {}

    private static final int CAP = 200;
    private static final Deque<Entry> LOG = new ArrayDeque<>();
    /** Monotonic count of every message ever received this launch — lets get_chat disclose how many
     * messages the cap/disconnect-wipe dropped instead of presenting the tail as the full picture. */
    private static long totalReceived = 0;
    /** When the ring was last wiped on disconnect (0 = never). */
    private static long lastClearedMs = 0;

    private record Entry(long timeMs, String kind, String sender, String text) {}

    public static void register() {
        ClientHooks.CHAT_RECEIVED.register((message, senderName) ->
            add("chat", senderName == null ? "" : senderName, message.getString()));
        ClientHooks.GAME_RECEIVED.register((message, overlay) ->
            add(overlay ? "overlay" : "game", "", message.getString()));
        ClientHooks.DISCONNECT.register(ChatLog::clear);
    }

    private static synchronized void add(final String kind, final String sender, final String text) {
        totalReceived++;
        LOG.addLast(new Entry(System.currentTimeMillis(), kind, sender, text));
        while (LOG.size() > CAP) {
            LOG.removeFirst();
        }
    }

    private static synchronized void clear() {
        LOG.clear();
        lastClearedMs = System.currentTimeMillis();
    }

    /** Coverage facts for get_chat: what the ring holds vs what ever arrived. */
    public static synchronized JsonObject stats() {
        JsonObject o = new JsonObject();
        o.addProperty("buffered", LOG.size());
        o.addProperty("total_received", totalReceived);
        o.addProperty("dropped", totalReceived - LOG.size());
        if (lastClearedMs > 0) {
            o.addProperty("cleared_on_disconnect_at", lastClearedMs);
        }
        return o;
    }

    /** The last {@code limit} messages, oldest first. */
    public static synchronized JsonArray tail(final int limit) {
        int skip = Math.max(0, LOG.size() - limit);
        JsonArray arr = new JsonArray();
        int i = 0;
        for (Entry e : LOG) {
            if (i++ < skip) {
                continue;
            }
            JsonObject o = new JsonObject();
            o.addProperty("time", e.timeMs());
            o.addProperty("kind", e.kind());
            o.addProperty("sender", e.sender());
            o.addProperty("text", e.text());
            arr.add(o);
        }
        return arr;
    }
}
