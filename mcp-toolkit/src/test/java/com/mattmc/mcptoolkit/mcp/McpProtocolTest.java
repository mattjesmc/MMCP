package com.mattmc.mcptoolkit.mcp;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.ExecutionContext;
import com.mattmc.mcptoolkit.Mechanism;
import com.mattmc.mcptoolkit.ToolDef;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The whole MCP conversation, with no game and no socket — which is the reason
 * {@link McpProtocol} is a class of its own (see its javadoc). A client will not speak to a server
 * that gets the handshake wrong, and "boot the game and try it" is not a way to find out which of
 * these is wrong.
 */
class McpProtocolTest {

    private final List<String> calls = new ArrayList<>();
    private JsonObject nextEnvelope = ok(new JsonObject());

    private final List<ToolDef> registry = List.of(
        tool("ping", Mechanism.OBSERVE),
        tool("set_blocks", Mechanism.WORLD_EDIT),
        tool("run_command", Mechanism.PRIVILEGED));

    private final McpProtocol protocol = new McpProtocol(
        () -> registry,
        (tool, args, session, surface) -> {
            calls.add(tool + " session=" + session + " surface=" + surface + " args=" + args);
            return nextEnvelope;
        },
        () -> "9.9.9",
        () -> "INSTRUCTIONS.");

    // ---- handshake -----------------------------------------------------------

    @Test
    void initializeEchoesASupportedVersionAndDeclaresTools() {
        McpConn conn = conn(full());
        JsonObject params = new JsonObject();
        params.addProperty("protocolVersion", "2025-06-18");
        JsonObject clientInfo = new JsonObject();
        clientInfo.addProperty("name", "claude-code");
        clientInfo.addProperty("version", "2.1.246");
        params.add("clientInfo", clientInfo);

        JsonObject reply = handle(request(1, "initialize", params), conn);
        JsonObject result = reply.getAsJsonObject("result");
        assertEquals("2025-06-18", result.get("protocolVersion").getAsString());
        assertEquals("mcp-toolkit", result.getAsJsonObject("serverInfo").get("name").getAsString());
        assertEquals("9.9.9", result.getAsJsonObject("serverInfo").get("version").getAsString());
        assertFalse(result.getAsJsonObject("capabilities").getAsJsonObject("tools")
            .get("listChanged").getAsBoolean(),
            "the registry is filled at mod init and never changes; declaring otherwise promises a "
                + "notification this server never sends");
        assertEquals("claude-code", conn.clientName());
        assertEquals("2.1.246", conn.clientVersion());
        assertEquals("2025-06-18", conn.protocolVersion());
    }

    @Test
    void anUnknownProtocolVersionIsAnsweredWithOurLatestRatherThanRefused() {
        McpConn conn = conn(full());
        JsonObject params = new JsonObject();
        params.addProperty("protocolVersion", "1999-01-01");
        JsonObject result = handle(request(1, "initialize", params), conn).getAsJsonObject("result");
        assertEquals(McpProtocol.LATEST_PROTOCOL_VERSION, result.get("protocolVersion").getAsString());
    }

    @Test
    void instructionsNameTheSurfaceTheUrlChose() {
        McpConn conn = conn(Surfaces.load(null, "observe").resolve(null));
        String text = handle(request(1, "initialize", new JsonObject()), conn)
            .getAsJsonObject("result").get("instructions").getAsString();
        assertTrue(text.startsWith("INSTRUCTIONS."), text);
        assertTrue(text.contains("\"observe\""), text);
    }

    @Test
    void aSurfaceMayCarryItsOwnInstructions() {
        McpSurface own = full().withInstructions("Only build in the quarry.");
        String text = handle(request(1, "initialize", new JsonObject()), conn(own))
            .getAsJsonObject("result").get("instructions").getAsString();
        assertEquals("Only build in the quarry.", text);
    }

    @Test
    void notificationsAnswerNothingAtAll() {
        McpConn conn = conn(full());
        assertNull(protocol.handle(notification("notifications/initialized"), conn));
        assertTrue(conn.initialized());
        assertNull(protocol.handle(notification("notifications/cancelled"), conn));
    }

    @Test
    void pingIsAnEmptyResult() {
        assertEquals(0, handle(request(7, "ping", new JsonObject()), conn(full()))
            .getAsJsonObject("result").size());
    }

    @Test
    void anUnknownMethodIsMethodNotFoundAndKeepsItsId() {
        JsonObject reply = handle(request(12, "resources/list", new JsonObject()), conn(full()));
        assertEquals(JsonRpc.METHOD_NOT_FOUND, reply.getAsJsonObject("error").get("code").getAsInt());
        assertEquals(12, reply.get("id").getAsInt());
    }

    // ---- tools/list ----------------------------------------------------------

    @Test
    void toolsListIsTheSurfaceNotTheRegistry() {
        JsonArray all = handle(request(2, "tools/list", new JsonObject()), conn(full()))
            .getAsJsonObject("result").getAsJsonArray("tools");
        assertEquals(3, all.size());

        McpSurface observe = Surfaces.load(null, "observe").resolve("observe");
        JsonArray reads = handle(request(2, "tools/list", new JsonObject()), conn(observe))
            .getAsJsonObject("result").getAsJsonArray("tools");
        assertEquals(1, reads.size());
        assertEquals("ping", reads.get(0).getAsJsonObject().get("name").getAsString());
        assertTrue(reads.get(0).getAsJsonObject().has("inputSchema"));
    }

    @Test
    void theSchemaHandedOutIsACopy() {
        JsonArray tools = handle(request(2, "tools/list", new JsonObject()), conn(full()))
            .getAsJsonObject("result").getAsJsonArray("tools");
        tools.get(0).getAsJsonObject().getAsJsonObject("inputSchema").addProperty("type", "wrecked");
        assertEquals("object", registry.get(0).inputSchema().get("type").getAsString(),
            "a client is entitled to mutate what it is given; the registry must not be edited by it");
    }

    // ---- tools/call ----------------------------------------------------------

    @Test
    void toolsCallCarriesTheSessionAndTheSurfaceToTheDispatcher() {
        McpConn conn = conn(full());
        JsonObject args = new JsonObject();
        args.addProperty("x", 3);
        nextEnvelope = ok(result("pong"));

        JsonObject result = handle(request(3, "tools/call", callParams("ping", args)), conn)
            .getAsJsonObject("result");
        assertEquals(1, calls.size());
        assertEquals("ping session=x-test surface=full args={\"x\":3}", calls.get(0));
        assertFalse(result.get("isError").getAsBoolean());
        assertEquals("{\"said\":\"pong\"}", text(result));
    }

    @Test
    void aToolTheSurfaceDoesNotServeIsARefusalTheModelCanRead() {
        McpSurface observe = Surfaces.load(null, "observe").resolve("observe");
        JsonObject result = handle(request(4, "tools/call", callParams("set_blocks", new JsonObject())),
            conn(observe)).getAsJsonObject("result");
        assertTrue(result.get("isError").getAsBoolean());
        assertTrue(text(result).contains("\"observe\" surface"), text(result));
        assertTrue(calls.isEmpty(), "a hidden tool must not reach the dispatcher");
    }

    @Test
    void anUnregisteredToolSaysSoRatherThanBlamingTheSurface() {
        JsonObject result = handle(request(5, "tools/call", callParams("nope", new JsonObject())),
            conn(full())).getAsJsonObject("result");
        assertTrue(result.get("isError").getAsBoolean());
        assertTrue(text(result).contains("no tool called \"nope\""), text(result));
    }

    @Test
    void aFailedCallIsAResultNotATransportError() {
        JsonObject envelope = new JsonObject();
        envelope.addProperty("ok", false);
        envelope.addProperty("error", "out of reach");
        nextEnvelope = envelope;

        JsonObject reply = handle(request(6, "tools/call", callParams("ping", new JsonObject())), conn(full()));
        assertFalse(reply.has("error"), "the model has to READ the refusal; an error is swallowed");
        JsonObject result = reply.getAsJsonObject("result");
        assertTrue(result.get("isError").getAsBoolean());
        assertEquals("out of reach", text(result));
    }

    // ---- helpers -------------------------------------------------------------

    private JsonObject handle(final JsonObject msg, final McpConn conn) {
        JsonObject reply = protocol.handle(msg, conn);
        assertNotNull(reply, "a request must be answered");
        assertEquals("2.0", reply.get("jsonrpc").getAsString());
        return reply;
    }

    private static McpConn conn(final McpSurface surface) {
        return new McpConn("mcp-test", surface, "x-test");
    }

    private static McpSurface full() {
        return McpSurface.all("full", "everything");
    }

    private static ToolDef tool(final String name, final Mechanism mechanism) {
        JsonObject schema = new JsonObject();
        schema.addProperty("type", "object");
        schema.add("properties", new JsonObject());
        return ToolDef.of(name, name + " does a thing", schema, ExecutionContext.ANY, mechanism,
            (ctx, args) -> new JsonObject());
    }

    private static JsonObject request(final int id, final String method, final JsonObject params) {
        JsonObject o = notification(method);
        o.addProperty("id", id);
        o.add("params", params);
        return o;
    }

    private static JsonObject notification(final String method) {
        JsonObject o = new JsonObject();
        o.addProperty("jsonrpc", "2.0");
        o.addProperty("method", method);
        return o;
    }

    private static JsonObject callParams(final String name, final JsonObject args) {
        JsonObject p = new JsonObject();
        p.addProperty("name", name);
        p.add("arguments", args);
        return p;
    }

    private static JsonObject ok(final JsonObject result) {
        JsonObject o = new JsonObject();
        o.addProperty("ok", true);
        o.add("result", result);
        return o;
    }

    private static JsonObject result(final String said) {
        JsonObject o = new JsonObject();
        o.addProperty("said", said);
        return o;
    }

    private static String text(final JsonObject toolResult) {
        JsonArray content = toolResult.getAsJsonArray("content");
        return content.get(content.size() - 1).getAsJsonObject().get("text").getAsString();
    }

}
