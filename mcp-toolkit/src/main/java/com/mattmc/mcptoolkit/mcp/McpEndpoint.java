package com.mattmc.mcptoolkit.mcp;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.mattmc.mcptoolkit.BridgeServer;
import com.mattmc.mcptoolkit.McpToolkit;
import com.mattmc.mcptoolkit.McpTools;
import com.mattmc.mcptoolkit.Sessions;
import com.mattmc.mcptoolkit.platform.Platform;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import org.jspecify.annotations.Nullable;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * <b>The game's own MCP server.</b> {@code POST http://127.0.0.1:<bridge port>/mcp} speaks MCP
 * Streamable HTTP straight to the JVM: no Node, no npm install, no extracted copy of anything, no
 * process for a client to spawn and hold. An agent program is pointed at a URL and it is talking to
 * this game.
 *
 * <h2>What this is beside, and why both</h2>
 *
 * <p>ARCHITECTURE.md's "where MCP actually lives" says the game does not speak MCP, and until this
 * class that was the whole truth: the port served a private HTTP+JSON API ({@code /tools},
 * {@code /cmd}) and the Node shim in {@code mcp-server/} turned MCP into calls against it. <b>That
 * arrangement is untouched and remains the supported one.</b> It has to be: an MCP client spawns its
 * servers when the CLIENT starts, which is routinely when Minecraft is not running, and only a
 * process that outlives the game can be there to be spawned, serve its local tools honestly while
 * the game is down, and notice when the game appears. This door cannot do that and never will — if
 * the game is not running, there is nothing here to connect to.
 *
 * <p>What it buys instead is everything that followed from the shim being a process a session starts:
 *
 * <ul>
 *   <li><b>Nothing to install.</b> A client that can dial an HTTP URL is set up. No Node on the
 *       machine, no {@code ServerExtract} copy to go stale against the game it is attached to (the
 *       0.63.0-shim-against-a-0.69.0-game drift is a class of bug this door cannot have: the tools
 *       ARE the running game's).</li>
 *   <li><b>A port that carries a surface.</b> ARCHITECTURE.md records that it could not — the profile
 *       belongs to the shim process, so the port could only ever serve the whole manifest. Here the
 *       URL names the surface ({@code /mcp/observe}), which is a thing a client can be configured
 *       with and a human can read. See {@link McpSurface}.</li>
 *   <li><b>One less place for a call to be reinterpreted.</b> Argument checking, the mechanism stamp,
 *       the audit record and the envelopes all happen exactly where they did — this handler enters
 *       {@link BridgeServer#execute} at the same chokepoint {@code /cmd} does.</li>
 * </ul>
 *
 * <p><b>And what does not come through it.</b> Everything the shim adds ABOVE the bridge stays there:
 * the {@code mem_*} memory layer, {@code bot_scan}, {@code launch_game}, {@code tool_surface}, the
 * Blockbench upstream, the image budget, the loop-file gate, the route ledger. Those are per-session
 * policy and a second upstream, not the game's business, and a session that needs them wants the
 * shim. A model is told which door it is on, in the {@code instructions} it meets at initialize.
 *
 * <h2>Transport notes</h2>
 *
 * <p>Streamable HTTP, POST only. {@code GET} answers 405: a server-initiated stream exists to carry
 * notifications, this server declares {@code tools.listChanged:false} and sends none, and the spec
 * allows exactly this answer. {@code DELETE} ends a session. Localhost-bound like the rest of the
 * bridge, and an {@code Origin} that is not a loopback origin is refused outright — that is the
 * spec's DNS-rebinding rule, and it is what stops a web page the human happens to have open from
 * quietly driving their game.
 */
public final class McpEndpoint implements HttpHandler {

    /** The context path. A surface follows it: {@code /mcp/observe}. */
    public static final String PATH = "/mcp";

    private final McpProtocol protocol;

    public McpEndpoint() {
        this(new McpProtocol(
            McpTools::all,
            BridgeServer::execute,
            () -> Platform.modVersion(McpToolkit.MOD_ID).orElse("unknown"),
            () -> INSTRUCTIONS));
    }

    McpEndpoint(final McpProtocol protocol) {
        this.protocol = protocol;
    }

    /**
     * The paragraph every session on this door meets, from {@code docs/guides/SESSION_CHARTER.md} —
     * the same one the shim serves, minus its last sentence, which names a {@code tool_surface} tool
     * that does not exist here. {@link McpProtocol#instructionsFor} adds the sentence that replaces
     * it, because what replaces it is a property of the CONNECTION (which surface) rather than of
     * this text.
     */
    static final String INSTRUCTIONS =
        "This MCP server is a bridge into a RUNNING Minecraft game. Nothing here is a mock: an act "
        + "changes the live world, and hotswap_class, push_data and push_asset change the running "
        + "game. Call ping first; it says whether a game and a world are present and which tool "
        + "profile this session has. Every reply carries `mechanism`: observe is a read you can "
        + "believe, embodied and privileged are acts you confirm with a read afterwards, local never "
        + "touched the game. A read with coverage.state other than complete is partial and says why. "
        + "run_command answers ok:true for a command that parsed, not one that did what you meant.";

    @Override
    public void handle(final HttpExchange ex) throws IOException {
        try {
            if (!originAllowed(ex)) {
                // Not a JSON-RPC error: nothing here got as far as being a JSON-RPC anything.
                respond(ex, 403, "{\"error\":\"this endpoint serves loopback origins only\"}");
                return;
            }
            String surfaceName = surfaceOf(ex.getRequestURI().getPath());
            McpSurface surface = Surfaces.installed().resolve(surfaceName);
            if (surface == null) {
                respond(ex, 404, McpContent.gson().toJson(notFound(surfaceName)));
                return;
            }
            switch (ex.getRequestMethod().toUpperCase(Locale.ROOT)) {
                case "POST" -> post(ex, surface);
                case "DELETE" -> delete(ex);
                case "GET" -> {
                    ex.getResponseHeaders().add("Allow", "POST, DELETE");
                    respond(ex, 405, "{\"error\":\"this server opens no notification stream "
                        + "(tools.listChanged is false); POST your requests\"}");
                }
                default -> {
                    ex.getResponseHeaders().add("Allow", "POST, DELETE");
                    respond(ex, 405, "{\"error\":\"use POST\"}");
                }
            }
        } catch (RuntimeException e) {
            McpToolkit.LOGGER.warn("[MCP Toolkit] /mcp failed: {}", e.toString());
            respond(ex, 500, "{\"error\":\"internal error\"}");
        } finally {
            ex.close();
        }
    }

    // ---- POST ----------------------------------------------------------------

    private void post(final HttpExchange ex, final McpSurface surface) throws IOException {
        String versionHeader = ex.getRequestHeaders().getFirst("MCP-Protocol-Version");
        if (versionHeader != null && !versionHeader.isBlank()
            && !McpProtocol.SUPPORTED_PROTOCOL_VERSIONS.contains(versionHeader.strip())) {
            respond(ex, 400, McpContent.gson().toJson(JsonRpc.error(null, JsonRpc.INVALID_REQUEST,
                "unsupported MCP-Protocol-Version \"" + versionHeader.strip() + "\"; this server "
                    + "speaks " + String.join(", ", McpProtocol.SUPPORTED_PROTOCOL_VERSIONS))));
            return;
        }

        JsonElement body;
        try {
            String raw = new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            body = JsonParser.parseString(raw.isBlank() ? "{}" : raw);
        } catch (RuntimeException e) {
            respond(ex, 400, McpContent.gson().toJson(
                JsonRpc.error(null, JsonRpc.PARSE_ERROR, "invalid JSON: " + e.getMessage())));
            return;
        }

        // A batch is an ARRAY, and it exists for clients older than 2025-06-18. Answering one is
        // cheaper than explaining why not, and the shape of the answer is the shape of the request.
        List<JsonObject> messages = new ArrayList<>();
        boolean batch = body.isJsonArray();
        if (batch) {
            for (JsonElement el : body.getAsJsonArray()) {
                if (el.isJsonObject()) {
                    messages.add(el.getAsJsonObject());
                }
            }
        } else if (body.isJsonObject()) {
            messages.add(body.getAsJsonObject());
        } else {
            respond(ex, 400, McpContent.gson().toJson(JsonRpc.error(null, JsonRpc.INVALID_REQUEST,
                "a JSON-RPC message is an object (or an array of them)")));
            return;
        }

        String sessionHeader = ex.getRequestHeaders().getFirst("Mcp-Session-Id");
        boolean initializing = messages.stream().anyMatch(m -> "initialize".equals(JsonRpc.method(m)));
        McpConn conn = McpConn.get(sessionHeader);
        boolean minted = false;
        if (conn == null) {
            if (sessionHeader != null && !sessionHeader.isBlank() && !initializing) {
                // The spec's own answer, and the one that fixes itself: a 404 tells the client its
                // session is gone and it must start a new one. A game restart is exactly this case.
                respond(ex, 404, McpContent.gson().toJson(JsonRpc.error(null, JsonRpc.INVALID_REQUEST,
                    "unknown session; send initialize to start a new one")));
                return;
            }
            // No session id and not initializing is out of order by the spec, and it is also what a
            // person with curl does. Answer it: this is a localhost door into a dev tool, and
            // refusing a well-formed tools/list to teach a lesson about handshakes helps nobody.
            //
            // It gets NO toolkit session, though, and that is not a punishment — it is the honest
            // record. A caller that never introduced itself is anonymous, which the audit log has
            // always had a way to say (the session field's absence), and minting one per stray
            // request would fill the session table with entries the reapers then believe in. Found
            // by looking: five probing curls left five live "clients" in `/mmcp mcp`.
            conn = initializing ? openConnection(surface) : McpConn.open(surface, null);
            minted = true;
        } else if (!conn.surface.name().equals(surface.name())) {
            // Same session id, different URL. The surface is the address, so this is two connections
            // wearing one id; treat the path as the truth and say so rather than silently serving
            // whichever was remembered.
            respond(ex, 400, McpContent.gson().toJson(JsonRpc.error(null, JsonRpc.INVALID_REQUEST,
                "this session was opened on /mcp/" + conn.surface.name() + "; a surface cannot be "
                    + "changed on a live session — reconnect")));
            return;
        }

        List<JsonObject> replies = new ArrayList<>();
        for (JsonObject msg : messages) {
            JsonObject reply = protocol.handle(msg, conn);
            if (reply != null) {
                replies.add(reply);
            }
        }
        if (initializing) {
            Sessions.Entry entry = Sessions.get(conn.toolkitSession);
            if (entry != null) {
                entry.declare(conn.clientName(), conn.clientVersion());
            }
            McpToolkit.LOGGER.info("[MCP Toolkit] MCP session {} opened on surface \"{}\" by {} "
                + "(protocol {}), toolkit session {}", conn.id, conn.surface.name(),
                conn.clientName() == null ? "an undeclared client" : conn.clientName(),
                conn.protocolVersion(), conn.toolkitSession);
        }
        if (minted || initializing) {
            ex.getResponseHeaders().add("Mcp-Session-Id", conn.id);
        }

        if (replies.isEmpty()) {
            // Notifications only: 202 and no body. A JSON-RPC response with a null id would be a
            // message the client has nothing to match and is required to ignore anyway.
            ex.sendResponseHeaders(202, -1);
            return;
        }
        String json = batch
            ? McpContent.gson().toJson(toArray(replies))
            : McpContent.gson().toJson(replies.get(0));
        respond(ex, 200, json);
    }

    private void delete(final HttpExchange ex) throws IOException {
        McpConn conn = McpConn.close(ex.getRequestHeaders().getFirst("Mcp-Session-Id"));
        if (conn != null && conn.toolkitSession != null) {
            // The toolkit session goes with it. A session left live holds things — the chat
            // responder binding, session-bound bodies — for whoever reaps them next.
            Sessions.abort(conn.toolkitSession);
            McpToolkit.LOGGER.info("[MCP Toolkit] MCP session {} closed by the client", conn.id);
        }
        respond(ex, 200, "{\"ok\":true}");
    }

    // ---- helpers -------------------------------------------------------------

    private static McpConn openConnection(final McpSurface surface) {
        Sessions.Entry entry = Sessions.mint(Sessions.Kind.EXTERNAL, "mcp:" + surface.name(), null);
        return McpConn.open(surface, entry.id);
    }

    /** The path segment after {@code /mcp}, or null for the bare path. */
    static @Nullable String surfaceOf(final @Nullable String path) {
        if (path == null || path.length() <= PATH.length()) {
            return null;
        }
        String rest = path.substring(PATH.length());
        while (rest.startsWith("/")) {
            rest = rest.substring(1);
        }
        while (rest.endsWith("/")) {
            rest = rest.substring(0, rest.length() - 1);
        }
        return rest.isEmpty() ? null : rest;
    }

    private static JsonObject notFound(final @Nullable String name) {
        Surfaces s = Surfaces.installed();
        return JsonRpc.error(null, JsonRpc.INVALID_REQUEST,
            "no surface called \"" + name + "\". This game serves: " + String.join(", ", s.names())
                + " (/mcp alone serves \"" + s.defaultName() + "\"). Declare more in "
                + "config/" + Surfaces.CONFIG_FILE + ".");
    }

    /**
     * Loopback only, and an absent {@code Origin} is fine: a non-browser client sends none. A browser
     * sends one it cannot forge, which is what makes this worth checking at all — without it, any
     * page the human has open could POST to this port and drive their game.
     */
    static boolean originAllowed(final HttpExchange ex) {
        String origin = ex.getRequestHeaders().getFirst("Origin");
        return isLoopbackOrigin(origin);
    }

    static boolean isLoopbackOrigin(final @Nullable String origin) {
        if (origin == null || origin.isBlank() || "null".equals(origin.strip())) {
            return true;
        }
        String o = origin.strip().toLowerCase(Locale.ROOT);
        // The scheme is checked, not skipped over: "file://127.0.0.1" has a loopback-looking host and
        // is not a loopback origin, and an origin whose scheme we do not recognize is not one either.
        int scheme = o.indexOf("://");
        if (scheme < 0 || !(o.startsWith("http://") || o.startsWith("https://"))) {
            return false;
        }
        String host = o.substring(scheme + 3);
        int slash = host.indexOf('/');
        if (slash >= 0) {
            host = host.substring(0, slash);
        }
        int colon = host.lastIndexOf(':');
        if (colon > 0 && host.indexOf(']') < colon) {
            host = host.substring(0, colon);
        }
        return host.equals("127.0.0.1") || host.equals("localhost") || host.equals("[::1]")
            || host.equals("::1");
    }

    private static JsonArray toArray(final List<JsonObject> objects) {
        JsonArray arr = new JsonArray();
        for (JsonObject o : objects) {
            arr.add(o);
        }
        return arr;
    }

    private static void respond(final HttpExchange ex, final int status, final String json) {
        try {
            byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
            ex.getResponseHeaders().add("Content-Type", "application/json");
            ex.sendResponseHeaders(status, bytes.length);
            try (OutputStream os = ex.getResponseBody()) {
                os.write(bytes);
            }
        } catch (IOException e) {
            // The client hung up mid-answer. Nothing to do and nothing worth a stack trace.
            McpToolkit.LOGGER.debug("[MCP Toolkit] /mcp response not delivered: {}", e.toString());
        }
    }
}
