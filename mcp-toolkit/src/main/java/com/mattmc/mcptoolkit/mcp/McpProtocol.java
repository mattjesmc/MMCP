package com.mattmc.mcptoolkit.mcp;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.ToolDef;
import org.jspecify.annotations.Nullable;

import java.util.Collection;
import java.util.List;
import java.util.function.Supplier;

/**
 * MCP itself — {@code initialize}, {@code tools/list}, {@code tools/call}, {@code ping} — over one
 * JSON-RPC message at a time, with no transport and no Minecraft anywhere in it.
 *
 * <p><b>That is the point of the class boundary, not tidiness.</b> A protocol implemented inside an
 * HTTP handler can only be tested by a live game, and the whole handshake — version negotiation, the
 * order a client is allowed to do things in, what an unknown tool answers — is exactly the part that
 * has to be right before a client will speak to it at all. Here the whole conversation is a
 * {@code JsonObject} in and a {@code JsonObject} out, so {@code McpProtocolTest} drives a complete
 * session with a fake registry and a fake dispatcher, offline, in the ordinary {@code gradlew test}.
 *
 * <p><b>What it does not do.</b> No resources, no prompts, no completion, no logging, no sampling:
 * this server has tools and says so in its capabilities, and an unsupported method gets a clean
 * {@code -32601} that every client is required to tolerate. {@code tools.listChanged} is declared
 * <em>false</em> and that is honest rather than cautious — the registry is filled during mod init,
 * before this endpoint can be dialled, and nothing adds a tool to a running game. The shim declares
 * it true because the shim's list really does change (the game it proxies comes and goes); this
 * server IS the game, so if it can answer at all, its list is already final.
 */
public final class McpProtocol {

    /** What this server implements. A client asking for something else gets this back and may keep going. */
    public static final String LATEST_PROTOCOL_VERSION = "2025-06-18";

    /** Versions this server will speak if a client asks for one of them by name. */
    public static final List<String> SUPPORTED_PROTOCOL_VERSIONS =
        List.of("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05");

    /**
     * What a request with no {@code MCP-Protocol-Version} header is assumed to be. The header was
     * introduced after {@code 2025-03-26}, so a request without one is by definition from before it —
     * this is the spec's own back-compatibility rule, not a guess.
     */
    public static final String FALLBACK_PROTOCOL_VERSION = "2025-03-26";

    /** Dispatches one tool call and answers the bridge's {@code {ok,result}} / {@code {ok,error}}. */
    public interface Invoker {
        JsonObject call(String tool, JsonObject args, @Nullable String session, @Nullable String surface);
    }

    private final Supplier<Collection<ToolDef>> registry;
    private final Invoker invoker;
    private final Supplier<String> version;
    private final Supplier<String> defaultInstructions;

    public McpProtocol(final Supplier<Collection<ToolDef>> registry, final Invoker invoker,
                       final Supplier<String> version, final Supplier<String> defaultInstructions) {
        this.registry = registry;
        this.invoker = invoker;
        this.version = version;
        this.defaultInstructions = defaultInstructions;
    }

    /**
     * Handle one message. Returns the response to send, or {@code null} when the message was a
     * notification — which is not the same as an empty response and must not be sent as one.
     */
    public @Nullable JsonObject handle(final JsonObject msg, final McpConn conn) {
        conn.touch();
        JsonElement id = msg.get("id");
        boolean isRequest = JsonRpc.isRequest(msg);
        String method = JsonRpc.method(msg);
        if (method == null) {
            // A response to something WE sent would land here too. This server sends no requests, so
            // anything without a method is either that (impossible) or malformed.
            return isRequest ? JsonRpc.error(id, JsonRpc.INVALID_REQUEST, "no method") : null;
        }
        JsonObject params = JsonRpc.params(msg);
        try {
            switch (method) {
                case "initialize" -> {
                    return isRequest ? JsonRpc.result(id, initialize(params, conn)) : null;
                }
                case "notifications/initialized" -> {
                    conn.markInitialized();
                    return null;
                }
                case "ping" -> {
                    return isRequest ? JsonRpc.result(id, new JsonObject()) : null;
                }
                case "tools/list" -> {
                    return isRequest ? JsonRpc.result(id, toolsList(conn)) : null;
                }
                case "tools/call" -> {
                    return isRequest ? JsonRpc.result(id, toolsCall(params, conn)) : null;
                }
                case "notifications/cancelled", "notifications/progress", "notifications/roots/list_changed" -> {
                    // Accepted and ignored. A tool call already running cannot be interrupted: the
                    // handler is on a game loop, and stopping it half-way is how a world edit lands
                    // in pieces. Saying nothing is the honest answer to a cancellation this server
                    // cannot honour — the client stops waiting, the game finishes the act, and the
                    // audit log records it either way.
                    return null;
                }
                default -> {
                    return isRequest
                        ? JsonRpc.error(id, JsonRpc.METHOD_NOT_FOUND, "method not found: " + method)
                        : null;
                }
            }
        } catch (RuntimeException e) {
            String message = e.getMessage() == null ? e.toString() : e.getMessage();
            return isRequest ? JsonRpc.error(id, JsonRpc.INTERNAL_ERROR, message) : null;
        }
    }

    // ---- the methods ---------------------------------------------------------

    private JsonObject initialize(final JsonObject params, final McpConn conn) {
        String asked = JsonRpc.str(params, "protocolVersion");
        String agreed = asked != null && SUPPORTED_PROTOCOL_VERSIONS.contains(asked)
            ? asked : LATEST_PROTOCOL_VERSION;
        conn.setProtocolVersion(agreed);
        JsonObject clientInfo = params.has("clientInfo") && params.get("clientInfo").isJsonObject()
            ? params.getAsJsonObject("clientInfo") : new JsonObject();
        conn.declare(JsonRpc.str(clientInfo, "name"), JsonRpc.str(clientInfo, "version"));

        JsonObject tools = new JsonObject();
        tools.addProperty("listChanged", false);
        JsonObject capabilities = new JsonObject();
        capabilities.add("tools", tools);

        JsonObject serverInfo = new JsonObject();
        serverInfo.addProperty("name", "mcp-toolkit");
        serverInfo.addProperty("version", version.get());

        JsonObject out = new JsonObject();
        out.addProperty("protocolVersion", agreed);
        out.add("capabilities", capabilities);
        out.add("serverInfo", serverInfo);
        out.addProperty("instructions", instructionsFor(conn));
        return out;
    }

    /**
     * The paragraph a session meets before its first call. A surface may carry its own (the config
     * file's {@code instructions}); otherwise the toolkit's, which is
     * {@code docs/guides/SESSION_CHARTER.md}'s opening block with its last sentence rewritten —
     * there is no {@code tool_surface} tool on this door, because the surface is the URL.
     */
    String instructionsFor(final McpConn conn) {
        String own = conn.surface.instructions();
        if (own != null) {
            return own;
        }
        return defaultInstructions.get()
            + " This server is the game itself: you are connected straight to the JVM, so the tool "
            + "list is whatever surface your URL named (\"" + conn.surface.name() + "\": "
            + conn.surface.description() + ") and it does not change while you are connected.";
    }

    private JsonObject toolsList(final McpConn conn) {
        JsonArray arr = new JsonArray();
        for (ToolDef def : registry.get()) {
            if (!conn.surface.serves(def)) {
                continue;
            }
            JsonObject t = new JsonObject();
            t.addProperty("name", def.name());
            t.addProperty("description", def.description());
            // The schema is the toolkit's own object, and a client is entitled to mutate what it is
            // given; the registry must not be edited by anybody's JSON parser.
            t.add("inputSchema", def.inputSchema().deepCopy());
            arr.add(t);
        }
        JsonObject out = new JsonObject();
        out.add("tools", arr);
        return out;
    }

    private JsonObject toolsCall(final JsonObject params, final McpConn conn) {
        String name = JsonRpc.str(params, "name");
        if (name == null) {
            return McpContent.error("tools/call needs a tool name");
        }
        JsonObject args = params.has("arguments") && params.get("arguments").isJsonObject()
            ? params.getAsJsonObject("arguments") : new JsonObject();
        ToolDef def = find(name);
        if (def == null || !conn.surface.serves(def)) {
            // An isError RESULT, not a JSON-RPC error, and the distinction is the whole point: the
            // model is the one that has to act on this, and a protocol error never reaches it as
            // something to read. Naming the surface and the alternative is what turns "unknown tool"
            // from a dead end into a decision — the same job the shim's `profile_hidden` does, minus
            // the switch verb, which this door does not have.
            String where = def == null
                ? "no tool called \"" + name + "\" is registered in this game"
                : "\"" + name + "\" is not served by the \"" + conn.surface.name() + "\" surface";
            return McpContent.error(where + ". This server's surface is fixed by the URL you "
                + "connected to; reconnect to /mcp/full for everything this game registers, or ask "
                + "the person running the game which surfaces it declares (/mmcp mcp).");
        }
        JsonObject envelope = invoker.call(name, args, conn.toolkitSession, conn.surface.name());
        return McpContent.fromEnvelope(envelope);
    }

    private @Nullable ToolDef find(final String name) {
        for (ToolDef def : registry.get()) {
            if (def.name().equals(name)) {
                return def;
            }
        }
        return null;
    }
}
