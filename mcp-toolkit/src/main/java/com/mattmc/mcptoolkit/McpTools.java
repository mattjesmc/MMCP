package com.mattmc.mcptoolkit;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.jspecify.annotations.Nullable;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * The tool registry. The builtins register here during the toolkit's init and extension mods follow via
 * {@link McpToolkitEntrypoint}; the bridge dispatches by name and serves the manifest. Registration is
 * single-threaded (mod init); reads happen afterward, so a plain map is fine.
 */
public final class McpTools {
    private McpTools() {}

    private static final Map<String, ToolDef> TOOLS = new LinkedHashMap<>();

    /**
     * Register a tool. Throws if a tool with the same name already exists — a duplicate among the
     * builtins is a development bug and should be loud. Extension mods go through
     * {@link #registerExtension}, which skips collisions instead.
     */
    public static void register(ToolDef def) {
        if (TOOLS.putIfAbsent(def.name(), def) != null) {
            throw new IllegalStateException("duplicate MCP tool: " + def.name());
        }
    }

    /**
     * Register a tool on behalf of an extension mod, attributed to it. A name that is already taken is
     * <em>skipped and recorded</em> rather than thrown: one mod's collision must not deny another mod
     * its tools or stop the bridge from starting. Builtins register first, so they can never be
     * shadowed.
     */
    static boolean registerExtension(final String modId, final ToolDef def) {
        ToolDef existing = TOOLS.get(def.name());
        if (existing != null) {
            String owner = existing.source() == null ? "the toolkit" : "mod '" + existing.source() + "'";
            McpToolkit.LOGGER.error("[MCP Toolkit] mod '{}' tried to register tool '{}', already owned by "
                + "{} — skipped. Prefix extension tool names with your mod id.", modId, def.name(), owner);
            Extensions.recordFailure(modId,
                "duplicate tool name '" + def.name() + "' (already owned by " + owner + ")");
            return false;
        }
        TOOLS.put(def.name(), def.withSource(modId));
        Extensions.recordTool(modId, def.name());
        return true;
    }

    static @Nullable ToolDef get(String name) {
        return TOOLS.get(name);
    }

    /**
     * The manifest served at {@code GET /tools}: {@code [{name, description, mechanism, context,
     * inputSchema}]} in order, each extension tool additionally carrying {@code source} (the owning
     * mod id). {@code context} is the {@link ExecutionContext} lower-cased - the column a headless
     * suite reads to know which tools answer with no client attached (RELEASE_1.md section K1,
     * {@code docs/platform/HEADLESS.md}); the shim consumes it and does not forward it. The key is
     * omitted entirely for toolkit-owned tools, so a manifest without extensions is byte-identical to
     * what earlier versions served and the Node server needs no change to forward it.
     */
    static JsonArray manifest() {
        JsonArray arr = new JsonArray();
        for (ToolDef def : TOOLS.values()) {
            JsonObject o = new JsonObject();
            o.addProperty("name", def.name());
            o.addProperty("description", def.description());
            o.addProperty("mechanism", def.mechanism().id());
            o.addProperty("context", def.context().name().toLowerCase(java.util.Locale.ROOT));
            if (def.source() != null) {
                o.addProperty("source", def.source());
            }
            o.add("inputSchema", def.inputSchema());
            arr.add(o);
        }
        return arr;
    }
}
