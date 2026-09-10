package com.mattmc.mcptoolkit;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import java.util.Set;

/**
 * A tiny JSON Schema builder so tool registrations stay readable. Everything it produces is a plain
 * {@link JsonObject} that is valid JSON Schema and forwarded to the MCP client unchanged.
 */
public final class Schemas {
    private Schemas() {}

    /**
     * An object schema whose properties are the given {@code (name, schema)} pairs, all required.
     * Example: {@code object("name", str(), "count", integer())}.
     */
    public static JsonObject object(Object... keyValuePairs) {
        JsonObject props = new JsonObject();
        JsonArray required = new JsonArray();
        for (int i = 0; i < keyValuePairs.length; i += 2) {
            String key = (String) keyValuePairs[i];
            JsonObject schema = (JsonObject) keyValuePairs[i + 1];
            props.add(key, schema);
            required.add(key);
        }
        JsonObject obj = new JsonObject();
        obj.addProperty("type", "object");
        obj.add("properties", props);
        obj.add("required", required);
        return obj;
    }

    /** A copy of {@code base} with the named keys removed from its {@code required} list. */
    public static JsonObject objectOpt(JsonObject base, String... optionalKeys) {
        JsonObject obj = base.deepCopy();
        JsonArray required = new JsonArray();
        JsonArray old = obj.getAsJsonArray("required");
        if (old != null) {
            Set<String> drop = Set.of(optionalKeys);
            for (var el : old) {
                if (!drop.contains(el.getAsString())) required.add(el);
            }
        }
        obj.add("required", required);
        return obj;
    }

    /**
     * A copy of {@code schema} with its own {@code description} removed (nested schemas keep theirs — this
     * strips one level, which is the level a caller owns).
     *
     * <p>For the case where the SAME field is documented by a sibling tool already in the manifest, so
     * repeating the prose buys nothing and is billed on every turn. The static tool prefix is re-read every
     * turn (TOKEN_PER_TOOL_FINDINGS.md finding 1), so a duplicated description is not paid once — it is paid
     * per turn, forever. Use it only where the reader is guaranteed the other tool: a description removed
     * from a field nothing else documents is a silent capability loss, not a saving.
     */
    public static JsonObject undescribe(JsonObject schema) {
        JsonObject copy = schema.deepCopy();
        copy.remove("description");
        return copy;
    }

    public static JsonObject str() { return type("string"); }
    public static JsonObject str(String description) { return described(type("string"), description); }
    /** A string with a maxLength constraint. Advisory to the client — the tool handler is the authority. */
    public static JsonObject str(String description, int maxLength) {
        JsonObject o = described(type("string"), description);
        o.addProperty("maxLength", maxLength);
        return o;
    }
    public static JsonObject integer() { return type("integer"); }
    public static JsonObject integer(String description) { return described(type("integer"), description); }
    public static JsonObject number() { return type("number"); }
    public static JsonObject number(String description) { return described(type("number"), description); }
    public static JsonObject bool() { return type("boolean"); }
    public static JsonObject bool(String description) { return described(type("boolean"), description); }

    public static JsonObject array(JsonObject items) {
        JsonObject a = type("array");
        a.add("items", items);
        return a;
    }

    /**
     * An object with <em>caller-chosen</em> keys, every value of the given shape — a map, not a record.
     * {@code object()} with no pairs would publish {@code properties:{}}, which a strict client reads as
     * "no keys are allowed": the opposite of what a legend or a symbol table means.
     */
    public static JsonObject map(JsonObject values, String description) {
        JsonObject o = described(type("object"), description);
        o.add("additionalProperties", values);
        return o;
    }

    /**
     * A field that legitimately takes more than one SHAPE. Used sparingly: two shapes are two contracts
     * (conformance.test.mjs says so in as many words), so this is for a field whose second shape is
     * another tool's output pasted back verbatim — where refusing it would put a conversion step, and
     * therefore an off-by-one, between a read and the write that answers it.
     */
    public static JsonObject anyOf(String description, JsonObject... shapes) {
        JsonObject o = new JsonObject();
        JsonArray alts = new JsonArray();
        for (JsonObject s : shapes) {
            alts.add(s);
        }
        o.add("anyOf", alts);
        o.addProperty("description", description);
        return o;
    }

    /** A {@code {x, y, z}} integer vector, all required. */
    public static JsonObject vec3i() {
        return object("x", integer(), "y", integer(), "z", integer());
    }

    /** The same vector, carrying what this particular position MEANS to its tool. */
    public static JsonObject vec3i(String description) {
        return described(vec3i(), description);
    }

    private static JsonObject type(String t) {
        JsonObject o = new JsonObject();
        o.addProperty("type", t);
        return o;
    }

    private static JsonObject described(JsonObject o, String description) {
        o.addProperty("description", description);
        return o;
    }
}
