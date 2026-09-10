package com.mattmc.mcptoolkit;

/**
 * The sink an {@link McpToolkitEntrypoint} registers its tools into. One registrar is handed to each
 * extension mod, bound to that mod's id, so every tool it accepts is attributed to its real owner
 * ({@link ToolDef#source}) without the mod having to name — or being able to misname — itself.
 *
 * <p>Name your tools with your mod id as a prefix ({@code mymod_survey}, not {@code survey}): the tool
 * namespace is flat and shared with the builtins and every other extension. A name that is already taken
 * is skipped and recorded as a registration failure for your mod (reported by {@code ping}), rather than
 * throwing — one mod's collision must not cost another mod its tools.
 */
@FunctionalInterface
public interface ToolRegistrar {
    /**
     * Register one tool. Returns false if the name was already taken (the tool was skipped and the
     * collision recorded); most callers can ignore the result.
     */
    boolean register(ToolDef def);
}
