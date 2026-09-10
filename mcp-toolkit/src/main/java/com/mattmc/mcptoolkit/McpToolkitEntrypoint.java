package com.mattmc.mcptoolkit;

/**
 * The seam a mod implements to contribute its own MCP tools — see {@code EXTENSION_DESIGN.md} and the
 * modder-facing {@code EXTENDING.md}.
 *
 * <p>Declare the implementing class in a resource file named after this interface — the same shape
 * {@code ServiceLoader} uses, and the same file on every loader:
 *
 * <pre>{@code
 * src/main/resources/META-INF/services/com.mattmc.mcptoolkit.McpToolkitEntrypoint
 *     com.example.mymod.mcp.MyModTools
 * }</pre>
 *
 * <p>and depend on the toolkit only optionally ({@code "suggests"} in {@code fabric.mod.json}, an
 * {@code optional} dependency in {@code neoforge.mods.toml}).
 *
 * <p>Fabric's {@code "entrypoints": &#123;"mcptoolkit": [...]&#125;} block still works and is read when
 * no service file is present — it is what shipped from 0.41.0 to 0.82.0. A jar that declares both is
 * discovered once, through the service file. NeoForge has no entrypoint mechanism, so a mod that wants
 * to work on both loaders declares the service file.
 *
 * <p><b>Why a declaration and not a direct call.</b> The class named here is loaded only when the
 * toolkit itself asks for it — discovery reads the file and nothing else. If the toolkit isn't
 * installed, nothing here is ever touched, so an extension mod needs no {@code isModLoaded} guard and
 * cannot crash a game that lacks the toolkit by accidentally referencing a toolkit class from its own
 * init path.
 *
 * <p><b>Register definitions, not resolved game objects.</b> This runs during the <em>toolkit's</em>
 * initialization, so another mod's registries (including your own) may not be populated yet, and no world
 * is loaded. Build {@link ToolDef}s whose handlers resolve blocks, items and levels when they are
 * <em>called</em> — the builtin tools all follow this discipline.
 *
 * <p>Two further seams hang off this interface as {@code default} methods — {@link #registerKits} and
 * {@link #registerAgentClients}. They are {@code default} precisely so every extension that
 * implements this as a lambda (which is what the {@code @FunctionalInterface} above invites) keeps
 * compiling and linking across the version that added them.
 *
 * <p>A failure thrown from {@link #registerTools} is contained: it is logged, recorded against your mod
 * id (visible in {@code ping}), and the toolkit continues to start. It will not take down the game or
 * other extensions.
 */
@FunctionalInterface
public interface McpToolkitEntrypoint {
    /**
     * Register this mod's tools. Called exactly once, during the toolkit's init, before the bridge
     * starts serving.
     *
     * @param registrar sink for this mod's {@link ToolDef}s; stamps each one with your mod id
     */
    void registerTools(ToolRegistrar registrar);

}
