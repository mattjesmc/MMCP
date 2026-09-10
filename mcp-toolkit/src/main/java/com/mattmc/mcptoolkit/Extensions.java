package com.mattmc.mcptoolkit;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.platform.LoaderPlatform;
import com.mattmc.mcptoolkit.platform.Platform;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Discovery and containment for extension mods: invokes every {@link McpToolkitEntrypoint} the loader
 * reports (see {@link LoaderPlatform#extensions()}), and remembers what each mod contributed — and what went
 * wrong — so {@code ping} can answer "which extensions are live, and did any fail?".
 *
 * <p><b>Containment is the point.</b> A broken extension must cost only its own tools: a throw from one
 * mod's {@code registerTools} is logged and recorded, and the next mod still runs. The builtins keep the
 * opposite policy — {@link McpTools#register} throws on a duplicate, because a builtin collision is a
 * development bug that should be loud.
 *
 * <p>Registration failures are otherwise invisible (a log line nobody reads while an agent wonders why a
 * tool is missing), which is why they are surfaced as data rather than only logged.
 */
public final class Extensions {
    private Extensions() {}

    /** modId -> tool names it successfully registered, in registration order. */
    private static final Map<String, List<String>> REGISTERED = new LinkedHashMap<>();
    /** modId -> human-readable failures (a throw, or a name collision). */
    private static final Map<String, List<String>> FAILURES = new LinkedHashMap<>();

    /**
     * Invoke every declared extension entrypoint. Called during the toolkit's own init, after the
     * builtins are registered (so a builtin name can never be shadowed) and before the bridge serves.
     */
    static void discover() {
        List<LoaderPlatform.Extension> found = Platform.extensions();
        for (LoaderPlatform.Extension ext : found) {
            String modId = ext.modId();
            REGISTERED.computeIfAbsent(modId, k -> new ArrayList<>());
            try {
                // entrypoint() is a supplier, so CONSTRUCTING the mod's class happens inside this try
                // too - a throwing constructor is contained exactly like a throwing registerTools.
                McpToolkitEntrypoint impl = ext.entrypoint().get();
                impl.registerTools(def -> McpTools.registerExtension(modId, def));
            } catch (Throwable t) {
                // Containment: one mod's failure must not deny the others their tools, nor stop the
                // bridge from starting. Throwable, not Exception — a LinkageError from a mod compiled
                // against a different toolkit version is exactly the case this must survive.
                McpToolkit.LOGGER.error("[MCP Toolkit] extension '{}' failed to register its tools", modId, t);
                recordFailure(modId, t.getClass().getSimpleName()
                    + (t.getMessage() == null ? "" : ": " + t.getMessage()));
            }
        }
        if (!found.isEmpty()) {
            McpToolkit.LOGGER.info("[MCP Toolkit] {} extension mod(s) registered tools: {}",
                REGISTERED.size(), REGISTERED.keySet());
        }
    }

    static void recordTool(final String modId, final String toolName) {
        REGISTERED.computeIfAbsent(modId, k -> new ArrayList<>()).add(toolName);
    }

    static void recordFailure(final String modId, final String reason) {
        FAILURES.computeIfAbsent(modId, k -> new ArrayList<>()).add(reason);
    }

    /**
     * The {@code extensions} array in {@code ping}: one entry per extension mod, with the tools it
     * contributed and any failures. A mod that registered nothing still appears (with an empty tool
     * list) — "loaded but contributed nothing" and "not loaded at all" are different diagnoses.
     */
    static JsonArray report() {
        JsonArray arr = new JsonArray();
        for (Map.Entry<String, List<String>> e : REGISTERED.entrySet()) {
            JsonObject o = new JsonObject();
            o.addProperty("mod", e.getKey());
            JsonArray tools = new JsonArray();
            e.getValue().forEach(tools::add);
            o.add("tools", tools);
            JsonArray failures = new JsonArray();
            FAILURES.getOrDefault(e.getKey(), List.of()).forEach(failures::add);
            o.add("failures", failures);
            arr.add(o);
        }
        return arr;
    }
}
