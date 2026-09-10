package com.mattmc.mcptoolkit;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import org.jspecify.annotations.Nullable;

import java.util.concurrent.CompletableFuture;
import java.util.function.BiFunction;

/**
 * A registered tool: its MCP name, description, raw JSON Schema for arguments (the toolkit is the schema
 * authority — the Node server forwards it verbatim), the loop it runs on, its {@link Mechanism} (authority
 * class — required, so no tool can act with undeclared authority), its handler, and — for tools an
 * extension mod contributed — the id of the mod that owns it ({@link #source}, null for the builtins).
 *
 * <p>The handler always returns a {@link CompletableFuture}; most tools are synchronous and use
 * {@link #of}. Use {@link #async} only when the result can't be produced on the target thread within the
 * call (e.g. a screenshot that needs a later render frame).
 */
public record ToolDef(
    String name,
    String description,
    JsonObject inputSchema,
    ExecutionContext context,
    Mechanism mechanism,
    BiFunction<ToolContext, JsonObject, CompletableFuture<JsonElement>> handler,
    int timeoutSeconds,
    @Nullable String source
) {
    /** Default dispatch timeout — how long the bridge waits for a tool's future before failing it. */
    public static final int DEFAULT_TIMEOUT_SECONDS = 15;

    /** A synchronous tool: the handler runs on the target thread and returns its result directly. */
    public static ToolDef of(String name, String description, JsonObject inputSchema,
                             ExecutionContext context, Mechanism mechanism,
                             BiFunction<ToolContext, JsonObject, JsonElement> fn) {
        return new ToolDef(name, description, inputSchema, context, mechanism,
            (ctx, args) -> CompletableFuture.completedFuture(fn.apply(ctx, args)),
            DEFAULT_TIMEOUT_SECONDS, null);
    }

    /**
     * An asynchronous tool: the handler is invoked on the target thread but completes its own future
     * later. The handler MUST NOT block the target thread waiting for that work — blocking the client
     * thread on something the render loop must produce deadlocks the game. The bridge's HTTP thread does
     * the waiting.
     */
    public static ToolDef async(String name, String description, JsonObject inputSchema,
                                ExecutionContext context, Mechanism mechanism,
                                BiFunction<ToolContext, JsonObject, CompletableFuture<JsonElement>> fn) {
        return new ToolDef(name, description, inputSchema, context, mechanism, fn,
            DEFAULT_TIMEOUT_SECONDS, null);
    }

    /**
     * The same tool with a longer dispatch timeout — for tools that deliberately park the HTTP handler:
     * the {@code get_events} long-poll, and async embodied tools whose {@code wait:true} completes only
     * when the action finishes ticks later. The timeout parks only the bridge's HTTP thread; a
     * game-thread handler must still RETURN promptly on its loop (async — complete the future later),
     * which is a property of the handler, not something a timeout cap could enforce.
     */
    public ToolDef withTimeout(final int seconds) {
        return new ToolDef(name, description, inputSchema, context, mechanism, handler, seconds, source);
    }

    /**
     * The same tool attributed to the mod that contributed it. Set by
     * {@link McpTools#registerExtension} from the entrypoint container's own metadata — never by the
     * registering mod itself, so the attribution can't be spoofed or forgotten.
     */
    ToolDef withSource(final String modId) {
        return new ToolDef(name, description, inputSchema, context, mechanism, handler, timeoutSeconds,
            modId);
    }
}
