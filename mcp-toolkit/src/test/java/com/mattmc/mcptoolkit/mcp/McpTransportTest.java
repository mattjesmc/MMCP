package com.mattmc.mcptoolkit.mcp;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.mattmc.mcptoolkit.ExecutionContext;
import com.mattmc.mcptoolkit.Mechanism;
import com.mattmc.mcptoolkit.ToolDef;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Streamable HTTP over a real socket, with a real handler and a real protocol — everything but the
 * game. The headers and status codes below are the half a client judges this server on before it has
 * asked for a single tool, and every one of them is a rule from the transport spec rather than a
 * preference: the session id on initialize, 404 for a session that has gone, 202 for a body that was
 * only notifications, 405 for the stream this server does not open.
 */
class McpTransportTest {

    private HttpServer http;
    private String base;
    private final HttpClient client = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(5)).build();

    @BeforeEach
    void start() throws IOException {
        McpProtocol protocol = new McpProtocol(
            () -> List.of(tool("ping", Mechanism.OBSERVE), tool("set_blocks", Mechanism.WORLD_EDIT)),
            (name, args, session, surface) -> {
                JsonObject result = new JsonObject();
                result.addProperty("tool", name);
                result.addProperty("surface", surface);
                // The toolkit session the door minted for this connection — absent for a caller
                // that never sent initialize, which is the whole point of the anonymous case below.
                if (session != null) {
                    result.addProperty("session", session);
                }
                JsonObject envelope = new JsonObject();
                envelope.addProperty("ok", true);
                envelope.add("result", result);
                return envelope;
            },
            () -> "0.0.0-test",
            () -> "INSTRUCTIONS.");
        http = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        http.createContext(McpEndpoint.PATH, new McpEndpoint(protocol));
        http.start();
        base = "http://127.0.0.1:" + http.getAddress().getPort() + McpEndpoint.PATH;
    }

    @AfterEach
    void stop() {
        http.stop(0);
    }

    @Test
    void aWholeSessionInitializesListsCallsAndEnds() throws Exception {
        HttpResponse<String> init = post(base, initialize(), null);
        assertEquals(200, init.statusCode());
        String session = init.headers().firstValue("Mcp-Session-Id").orElse(null);
        assertNotNull(session, "a client cannot continue a session it was never given the id of");
        assertEquals("0.0.0-test", json(init).getAsJsonObject("result")
            .getAsJsonObject("serverInfo").get("version").getAsString());

        assertEquals(202, post(base, notification("notifications/initialized"), session).statusCode(),
            "a body of notifications has no response to carry");

        HttpResponse<String> list = post(base, request(2, "tools/list", new JsonObject()), session);
        assertEquals(2, json(list).getAsJsonObject("result").getAsJsonArray("tools").size());

        JsonObject params = new JsonObject();
        params.addProperty("name", "ping");
        params.add("arguments", new JsonObject());
        HttpResponse<String> call = post(base, request(3, "tools/call", params), session);
        JsonObject result = json(call).getAsJsonObject("result");
        assertFalse(result.get("isError").getAsBoolean());
        assertTrue(result.getAsJsonArray("content").get(0).getAsJsonObject().get("text")
            .getAsString().contains("\"surface\":\"full\""));

        assertEquals(200, delete(base, session).statusCode());
        assertEquals(404, post(base, request(4, "tools/list", new JsonObject()), session).statusCode(),
            "after DELETE the session is gone, and the client is told to start a new one");
    }

    @Test
    void theUrlChoosesTheSurfaceAndAnUnknownOneNamesTheRealOnes() throws Exception {
        HttpResponse<String> observe = post(base + "/observe", initialize(), null);
        assertEquals(200, observe.statusCode());
        String session = observe.headers().firstValue("Mcp-Session-Id").orElseThrow();
        JsonArray tools = json(post(base + "/observe", request(2, "tools/list", new JsonObject()), session))
            .getAsJsonObject("result").getAsJsonArray("tools");
        assertEquals(1, tools.size());
        assertEquals("ping", tools.get(0).getAsJsonObject().get("name").getAsString());

        HttpResponse<String> missing = post(base + "/nope", initialize(), null);
        assertEquals(404, missing.statusCode());
        String message = json(missing).getAsJsonObject("error").get("message").getAsString();
        assertTrue(message.contains("full"), message);
        assertTrue(message.contains("observe"), message);
    }

    @Test
    void aSessionCannotChangeSurfaceUnderneathItself() throws Exception {
        String session = post(base, initialize(), null).headers()
            .firstValue("Mcp-Session-Id").orElseThrow();
        HttpResponse<String> moved = post(base + "/observe", request(2, "tools/list", new JsonObject()),
            session);
        assertEquals(400, moved.statusCode());
        assertTrue(json(moved).getAsJsonObject("error").get("message").getAsString()
            .contains("cannot be changed"));
    }

    @Test
    void anUnknownSessionIsAFourOhFourSoTheClientReInitializes() throws Exception {
        assertEquals(404, post(base, request(1, "tools/list", new JsonObject()), "mcp-nothing").statusCode());
    }

    @Test
    void aCallWithNoSessionAtAllIsServedAndGivenOne() throws Exception {
        // Out of order by the spec, and exactly what a person with curl does. This is a localhost
        // door into a dev tool: answer, and hand back the id they should have asked for.
        HttpResponse<String> res = post(base, request(1, "tools/list", new JsonObject()), null);
        assertEquals(200, res.statusCode());
        assertTrue(res.headers().firstValue("Mcp-Session-Id").isPresent());
    }

    @Test
    void twoClientsAreTwoSessionsAndNeitherIsTheOthers() throws Exception {
        // Two agent programs on one game is the ordinary case, not the exotic one: a modding session
        // in one repo and a survival session in another dial the same port all day. Everything that
        // could be shared between them is static — the connection table, the installed surfaces —
        // so "they do not collide" is a claim that has to be made rather than assumed.
        HttpResponse<String> first = post(base, initialize(), null);
        HttpResponse<String> second = post(base + "/observe", initialize(), null);
        String a = first.headers().firstValue("Mcp-Session-Id").orElseThrow();
        String b = second.headers().firstValue("Mcp-Session-Id").orElseThrow();
        assertNotEquals(a, b);

        // Each keeps the surface it dialled, and the second connection does not re-profile the first.
        assertEquals(2, listSize(base, a));
        assertEquals(1, listSize(base + "/observe", b));

        // And each acts as its own TOOLKIT session, which is what the audit log attributes to.
        String toolkitA = callPing(base, a).get("session").getAsString();
        String toolkitB = callPing(base + "/observe", b).get("session").getAsString();
        assertNotEquals(toolkitA, toolkitB,
            "two clients sharing one toolkit session would attribute one's acts to the other");

        // One client going away takes exactly its own session with it.
        assertEquals(200, delete(base, a).statusCode());
        assertEquals(404, post(base, request(9, "tools/list", new JsonObject()), a).statusCode());
        assertEquals(1, listSize(base + "/observe", b), "the other client never noticed");
        delete(base + "/observe", b);
    }

    @Test
    void aCallerThatNeverIntroducedItselfActsAnonymously() throws Exception {
        // The live run's finding, pinned: five probing curls had left five live "clients" in
        // `/mmcp mcp`, because every sessionless POST was minting a toolkit session. A stray request
        // must not leave an entry the session reapers then believe in — so it is SERVED, and the
        // audit record's way of saying nobody introduced themselves is that the field is absent.
        JsonObject params = new JsonObject();
        params.addProperty("name", "ping");
        params.add("arguments", new JsonObject());
        HttpResponse<String> res = post(base, request(1, "tools/call", params), null);
        assertEquals(200, res.statusCode());
        JsonObject result = JsonParser.parseString(json(res).getAsJsonObject("result")
            .getAsJsonArray("content").get(0).getAsJsonObject().get("text").getAsString())
            .getAsJsonObject();
        assertFalse(result.has("session"), "an anonymous caller stays anonymous: " + result);
    }

    @Test
    void aBatchIsAnsweredAsABatch() throws Exception {
        JsonArray batch = new JsonArray();
        batch.add(request(1, "ping", new JsonObject()));
        batch.add(request(2, "tools/list", new JsonObject()));
        batch.add(notification("notifications/cancelled"));
        HttpResponse<String> res = post(base, batch.toString(), null);
        assertEquals(200, res.statusCode());
        JsonArray replies = JsonParser.parseString(res.body()).getAsJsonArray();
        assertEquals(2, replies.size(), "the notification has no reply; the two requests do");
    }

    @Test
    void theStreamThisServerDoesNotOpenIsAFourOhFiveNotASilentHang() throws Exception {
        HttpResponse<String> res = client.send(HttpRequest.newBuilder(URI.create(base))
            .header("Accept", "text/event-stream").GET().build(),
            HttpResponse.BodyHandlers.ofString());
        assertEquals(405, res.statusCode());
        assertEquals(Optional.of("POST, DELETE"), res.headers().firstValue("Allow"));
    }

    @Test
    void anUnsupportedProtocolVersionHeaderIsRefusedWithTheOnesWeSpeak() throws Exception {
        HttpResponse<String> res = client.send(HttpRequest.newBuilder(URI.create(base))
            .header("Content-Type", "application/json")
            .header("MCP-Protocol-Version", "1999-01-01")
            .POST(HttpRequest.BodyPublishers.ofString(initialize().toString())).build(),
            HttpResponse.BodyHandlers.ofString());
        assertEquals(400, res.statusCode());
        assertTrue(json(res).getAsJsonObject("error").get("message").getAsString()
            .contains(McpProtocol.LATEST_PROTOCOL_VERSION));
    }

    @Test
    void aPageOnTheInternetIsRefusedBeforeAnythingElseHappens() throws Exception {
        HttpResponse<String> res = client.send(HttpRequest.newBuilder(URI.create(base))
            .header("Content-Type", "application/json")
            .header("Origin", "https://evil.example")
            .POST(HttpRequest.BodyPublishers.ofString(initialize().toString())).build(),
            HttpResponse.BodyHandlers.ofString());
        assertEquals(403, res.statusCode());
    }

    @Test
    void rubbishIsAParseErrorRatherThanAnUnhandledException() throws Exception {
        HttpResponse<String> res = post(base, "{ not json", null);
        assertEquals(400, res.statusCode());
        assertEquals(JsonRpc.PARSE_ERROR, json(res).getAsJsonObject("error").get("code").getAsInt());
    }

    // ---- helpers -------------------------------------------------------------

    private int listSize(final String url, final String session) throws Exception {
        return json(post(url, request(7, "tools/list", new JsonObject()), session))
            .getAsJsonObject("result").getAsJsonArray("tools").size();
    }

    /** Call {@code ping} and unwrap the dispatch envelope the content part carries as text. */
    private JsonObject callPing(final String url, final String session) throws Exception {
        JsonObject params = new JsonObject();
        params.addProperty("name", "ping");
        params.add("arguments", new JsonObject());
        JsonObject result = json(post(url, request(8, "tools/call", params), session))
            .getAsJsonObject("result");
        return JsonParser.parseString(result.getAsJsonArray("content").get(0).getAsJsonObject()
            .get("text").getAsString()).getAsJsonObject();
    }

    private HttpResponse<String> post(final String url, final com.google.gson.JsonElement body,
                                      final String session) throws Exception {
        return post(url, body.toString(), session);
    }

    private HttpResponse<String> post(final String url, final String body, final String session)
            throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(url))
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream")
            .POST(HttpRequest.BodyPublishers.ofString(body));
        if (session != null) {
            b.header("Mcp-Session-Id", session);
        }
        return client.send(b.build(), HttpResponse.BodyHandlers.ofString());
    }

    private HttpResponse<String> delete(final String url, final String session) throws Exception {
        return client.send(HttpRequest.newBuilder(URI.create(url))
            .header("Mcp-Session-Id", session).DELETE().build(),
            HttpResponse.BodyHandlers.ofString());
    }

    private static JsonObject json(final HttpResponse<String> res) {
        return JsonParser.parseString(res.body()).getAsJsonObject();
    }

    private static JsonObject initialize() {
        JsonObject params = new JsonObject();
        params.addProperty("protocolVersion", McpProtocol.LATEST_PROTOCOL_VERSION);
        JsonObject clientInfo = new JsonObject();
        clientInfo.addProperty("name", "transport-test");
        clientInfo.addProperty("version", "1");
        params.add("clientInfo", clientInfo);
        return request(1, "initialize", params);
    }

    private static JsonObject request(final int id, final String method, final JsonObject params) {
        JsonObject o = new JsonObject();
        o.addProperty("jsonrpc", "2.0");
        o.addProperty("id", id);
        o.addProperty("method", method);
        o.add("params", params);
        return o;
    }

    private static JsonObject notification(final String method) {
        JsonObject o = new JsonObject();
        o.addProperty("jsonrpc", "2.0");
        o.addProperty("method", method);
        return o;
    }

    private static ToolDef tool(final String name, final Mechanism mechanism) {
        JsonObject schema = new JsonObject();
        schema.addProperty("type", "object");
        return ToolDef.of(name, name, schema, ExecutionContext.ANY, mechanism,
            (ctx, args) -> new JsonObject());
    }
}
