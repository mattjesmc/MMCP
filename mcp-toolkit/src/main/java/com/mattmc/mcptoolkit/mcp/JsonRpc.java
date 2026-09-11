package com.mattmc.mcptoolkit.mcp;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import org.jspecify.annotations.Nullable;

/**
 * JSON-RPC 2.0 envelopes, as much of them as MCP uses. No transport, no Minecraft — the shapes only,
 * so {@link McpProtocol} and its unit tests can build and read messages without either.
 *
 * <p>The id is copied through as a {@link JsonElement} rather than parsed: JSON-RPC allows a string
 * or a number and a response MUST echo the request's id EXACTLY. Normalizing it to either Java type
 * would make {@code "1"} and {@code 1} indistinguishable, and a client that matches responses to
 * requests by identity would then be handed the wrong one.
 */
public final class JsonRpc {
    private JsonRpc() {}

    public static final String VERSION = "2.0";

    // The standard codes. MCP adds no codes of its own for tool failures: a tool that FAILS answers
    // with an ordinary result carrying isError:true, because that failure is content the model must
    // read, not a protocol fault the client should swallow. -32602 here is for a call the protocol
    // layer itself refuses (no such tool, malformed params), never for a tool that ran and refused.
    public static final int PARSE_ERROR = -32700;
    public static final int INVALID_REQUEST = -32600;
    public static final int METHOD_NOT_FOUND = -32601;
    public static final int INVALID_PARAMS = -32602;
    public static final int INTERNAL_ERROR = -32603;

    /** True when the message is a REQUEST (has an id) rather than a notification. */
    public static boolean isRequest(final JsonObject msg) {
        return msg.has("id") && !msg.get("id").isJsonNull();
    }

    public static @Nullable String method(final JsonObject msg) {
        return msg.has("method") && msg.get("method").isJsonPrimitive()
            ? msg.get("method").getAsString() : null;
    }

    public static JsonObject params(final JsonObject msg) {
        return msg.has("params") && msg.get("params").isJsonObject()
            ? msg.getAsJsonObject("params") : new JsonObject();
    }

    public static JsonObject result(final @Nullable JsonElement id, final JsonObject result) {
        JsonObject o = new JsonObject();
        o.addProperty("jsonrpc", VERSION);
        o.add("id", id);
        o.add("result", result);
        return o;
    }

    public static JsonObject error(final @Nullable JsonElement id, final int code, final String message) {
        JsonObject err = new JsonObject();
        err.addProperty("code", code);
        err.addProperty("message", message);
        JsonObject o = new JsonObject();
        o.addProperty("jsonrpc", VERSION);
        o.add("id", id);
        o.add("error", err);
        return o;
    }

    /** One optional string field, stripped, or null when absent/blank/not a string. */
    public static @Nullable String str(final JsonObject o, final String key) {
        if (!o.has(key) || !o.get(key).isJsonPrimitive()) {
            return null;
        }
        String v = o.get(key).getAsString().strip();
        return v.isEmpty() ? null : v;
    }
}
