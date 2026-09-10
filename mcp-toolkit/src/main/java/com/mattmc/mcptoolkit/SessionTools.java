package com.mattmc.mcptoolkit;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import java.util.Locale;

/**
 * {@code session_list} — who is connected to this bridge right now.
 *
 * <p><b>What this is left over from.</b> Until 0.143.0 this tool lived in {@code CompanionSessions},
 * beside {@code companion_spawn}, {@code companion_stop} and {@code session_send}: the toolkit could
 * start agent processes of its own, and those three tools were how one session commanded another.
 * That whole half is archived. The game starts nothing now — an agent is somebody else's process that
 * dialed this port — and the three tools that only made sense with a launcher behind them went with
 * it.
 *
 * <p>This one survived because it answers a question that is still real, and is the honest version of
 * the question the archived MMCP menu answered badly: it listed OS processes whose working directory
 * matched the game folder, which is a guess about the machine rather than a fact about the bridge.
 * {@link Sessions} knows exactly who has called it, so that is what is served — sessions that
 * handshook and are still heartbeating, the one bound as chat responder, and whether chat is muted.
 * A `client` is what a session declared itself to be at its handshake: self-declared, so absent for
 * anything that did not say.
 */
public final class SessionTools {
    private SessionTools() {}

    public static void register() {
        McpTools.register(ToolDef.of(
            "session_list",
            "List the live LLM sessions connected to this game's bridge, which one is bound as chat "
                + "responder, and whether chat is muted. Your own session id is included as `you` when "
                + "your calls carry one. `client` is what a session declared itself to be at its "
                + "handshake — self-declared, so absent for anything that did not say.",
            Schemas.object(),
            ExecutionContext.ANY,
            Mechanism.OBSERVE,
            (ctx, a) -> {
                JsonObject r = new JsonObject();
                JsonArray arr = new JsonArray();
                String responder = Sessions.chatResponder();
                for (Sessions.Entry e : Sessions.live()) {
                    JsonObject o = new JsonObject();
                    o.addProperty("session", e.id);
                    o.addProperty("kind", e.kind.name().toLowerCase(Locale.ROOT));
                    o.addProperty("label", e.label);
                    o.addProperty("started", e.startedMs);
                    o.addProperty("last_call", e.lastSeenMs());
                    o.addProperty("chat_responder", e.id.equals(responder));
                    if (e.clientId() != null) {
                        o.addProperty("client", e.clientId());
                    }
                    if (e.clientVersion() != null) {
                        o.addProperty("client_version", e.clientVersion());
                    }
                    arr.add(o);
                }
                r.add("sessions", arr);
                if (ctx.sessionId() != null) {
                    r.addProperty("you", ctx.sessionId());
                }
                r.addProperty("muted", ChatTools.muted());
                return r;
            }));
    }
}
