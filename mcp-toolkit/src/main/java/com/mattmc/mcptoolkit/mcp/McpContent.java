package com.mattmc.mcptoolkit.mcp;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

/**
 * The bridge's dispatch envelope, turned into an MCP {@code tools/call} result.
 *
 * <p>One rule and one special case, both of them copied deliberately from the Node shim so a model
 * cannot tell which door it came through:
 *
 * <ul>
 *   <li><b>A failed call is a RESULT, not a protocol error.</b> {@code {ok:false,error}} becomes
 *       {@code isError:true} with the message as text. A JSON-RPC error would be swallowed by the
 *       client as a transport fault; the model must READ "that block is out of reach", because the
 *       refusal is the answer.</li>
 *   <li><b>{@code _image}</b> ({@code {mimeType, base64}}) becomes an image part, and whatever else the
 *       result carried follows as one compact JSON text part. Compact on purpose: pretty-printing
 *       inflates every result 25-40% in tokens and every result is re-read by every later model call
 *       for the life of the session.</li>
 * </ul>
 *
 * <p>What does NOT come through this door is everything the shim layers ON TOP of the same envelope —
 * the image budget, the memory annotation, the loop-file check, the route ledger. Those are
 * per-session policy belonging to a process a session starts, and this is a port. See
 * {@code IN_JAR_MCP_DESIGN.md} section 2.
 */
public final class McpContent {
    private McpContent() {}

    // serializeNulls for the reason BridgeServer has it: an explicit null is a deliberate tri-state
    // verdict (check_* predicates, line_of_sight), and dropping it on the wire turns "observed as
    // unknown" into an absent key indistinguishable from "this field does not exist".
    private static final Gson GSON = new GsonBuilder().serializeNulls().create();

    public static Gson gson() {
        return GSON;
    }

    /** {@code {ok,result}} / {@code {ok,error}} from the dispatcher, as a {@code tools/call} result. */
    public static JsonObject fromEnvelope(final JsonObject envelope) {
        boolean ok = envelope.has("ok") && envelope.get("ok").getAsBoolean();
        if (!ok) {
            String error = envelope.has("error") && !envelope.get("error").isJsonNull()
                ? envelope.get("error").getAsString() : "the call failed and said nothing";
            return error(error);
        }
        JsonElement result = envelope.get("result");
        JsonArray content = new JsonArray();
        if (result != null && result.isJsonObject() && result.getAsJsonObject().has("_image")
            && result.getAsJsonObject().get("_image").isJsonObject()) {
            JsonObject rest = result.getAsJsonObject().deepCopy();
            JsonObject image = rest.getAsJsonObject("_image");
            rest.remove("_image");
            JsonObject part = new JsonObject();
            part.addProperty("type", "image");
            part.addProperty("data", image.has("base64") ? image.get("base64").getAsString() : "");
            part.addProperty("mimeType", image.has("mimeType")
                ? image.get("mimeType").getAsString() : "image/png");
            content.add(part);
            if (!rest.entrySet().isEmpty()) {
                content.add(text(GSON.toJson(rest)));
            }
        } else {
            content.add(text(result == null ? "null" : GSON.toJson(result)));
        }
        JsonObject out = new JsonObject();
        out.add("content", content);
        out.addProperty("isError", false);
        return out;
    }

    /** A refusal the model must read: {@code isError:true} with the reason as its only content. */
    public static JsonObject error(final String message) {
        JsonArray content = new JsonArray();
        content.add(text(message));
        JsonObject out = new JsonObject();
        out.add("content", content);
        out.addProperty("isError", true);
        return out;
    }

    private static JsonObject text(final String s) {
        JsonObject part = new JsonObject();
        part.addProperty("type", "text");
        part.addProperty("text", s);
        return part;
    }
}
