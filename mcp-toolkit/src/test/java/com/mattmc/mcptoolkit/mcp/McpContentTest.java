package com.mattmc.mcptoolkit.mcp;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonNull;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** The dispatch envelope, as a {@code tools/call} result. */
class McpContentTest {

    @Test
    void anObjectResultIsOneCompactTextPart() {
        JsonObject result = new JsonObject();
        result.addProperty("blocks", 4);
        result.addProperty("mechanism", "world_edit");

        JsonObject out = McpContent.fromEnvelope(ok(result));
        assertFalse(out.get("isError").getAsBoolean());
        JsonArray content = out.getAsJsonArray("content");
        assertEquals(1, content.size());
        assertEquals("text", content.get(0).getAsJsonObject().get("type").getAsString());
        assertEquals("{\"blocks\":4,\"mechanism\":\"world_edit\"}",
            content.get(0).getAsJsonObject().get("text").getAsString());
    }

    @Test
    void anExplicitNullSurvivesTheSerializer() {
        JsonObject result = new JsonObject();
        result.add("fits", JsonNull.INSTANCE);
        assertEquals("{\"fits\":null}", text(McpContent.fromEnvelope(ok(result)), 0),
            "a tri-state verdict that loses its null becomes indistinguishable from a missing field");
    }

    @Test
    void anImageBecomesAnImagePartAndTheRestFollowsAsText() {
        JsonObject image = new JsonObject();
        image.addProperty("mimeType", "image/png");
        image.addProperty("base64", "AAAA");
        JsonObject result = new JsonObject();
        result.add("_image", image);
        result.addProperty("width", 1920);

        JsonArray content = McpContent.fromEnvelope(ok(result)).getAsJsonArray("content");
        assertEquals(2, content.size());
        assertEquals("image", content.get(0).getAsJsonObject().get("type").getAsString());
        assertEquals("AAAA", content.get(0).getAsJsonObject().get("data").getAsString());
        assertEquals("image/png", content.get(0).getAsJsonObject().get("mimeType").getAsString());
        assertEquals("{\"width\":1920}", content.get(1).getAsJsonObject().get("text").getAsString());
    }

    @Test
    void anImageWithNothingElseIsOnlyThePicture() {
        JsonObject image = new JsonObject();
        image.addProperty("base64", "AAAA");
        JsonObject result = new JsonObject();
        result.add("_image", image);
        JsonArray content = McpContent.fromEnvelope(ok(result)).getAsJsonArray("content");
        assertEquals(1, content.size());
        assertEquals("image/png", content.get(0).getAsJsonObject().get("mimeType").getAsString(),
            "a picture that does not say what it is, is a PNG — that is what every tool here emits");
    }

    @Test
    void aFailureIsAnErrorRESULTCarryingTheReason() {
        JsonObject envelope = new JsonObject();
        envelope.addProperty("ok", false);
        envelope.addProperty("error", "no server running — load a world first");

        JsonObject out = McpContent.fromEnvelope(envelope);
        assertTrue(out.get("isError").getAsBoolean());
        assertEquals("no server running — load a world first", text(out, 0));
    }

    @Test
    void aFailureThatSaysNothingStillSaysSomething() {
        JsonObject envelope = new JsonObject();
        envelope.addProperty("ok", false);
        assertTrue(text(McpContent.fromEnvelope(envelope), 0).contains("said nothing"));
    }

    private static JsonObject ok(final JsonObject result) {
        JsonObject o = new JsonObject();
        o.addProperty("ok", true);
        o.add("result", result);
        return o;
    }

    private static String text(final JsonObject toolResult, final int index) {
        return toolResult.getAsJsonArray("content").get(index).getAsJsonObject()
            .get("text").getAsString();
    }
}
