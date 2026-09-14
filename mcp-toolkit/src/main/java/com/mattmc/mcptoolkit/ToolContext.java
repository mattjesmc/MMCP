package com.mattmc.mcptoolkit;

import net.minecraft.server.MinecraftServer;
import org.jspecify.annotations.Nullable;

/**
 * The environment handed to a tool handler. Deliberately free of client types so it stays loadable on a
 * dedicated server — client handlers reach {@code Minecraft.getInstance()} directly from their own
 * client-only classes instead.
 */
public interface ToolContext {
    /** The running server, or {@code null} when no world is loaded. */
    @Nullable MinecraftServer server();

    /** The running server, or throws {@link IllegalStateException} if none. */
    MinecraftServer serverOrThrow();

    /**
     * The calling session's id ({@code X-MCPTK-Session} header, stamped per request by the bridge), or
     * {@code null} for an anonymous caller (older shim, curl). Identity is attribution/arbitration
     * only — see {@link Sessions}.
     */
    default @Nullable String sessionId() {
        return null;
    }

    /**
     * The calling session's tool profile ({@code X-MCPTK-Profile} header — the shim's
     * {@code MCPTK_PROFILE}), or {@code null} when it did not say. Profiles are defined shim-side
     * (mcp-server/index.mjs {@code PROFILES}); the mod learns the name so stream-level rules can be
     * enforced where the stream lives.
     *
     * <p>Same trust model as {@link #sessionId()}: the caller declares it, the bridge stays
     * localhost-trusted. That is not a weakening — profile enforcement (which tools exist at all)
     * has always been shim-side; this only lets the log apply the same role the shim already has.
     */
    default @Nullable String profile() {
        return null;
    }

    /**
     * True for a PLAYER-LEGAL session — one whose whole point is that it may only know what a body
     * could perceive ({@code survival}; SURVIVAL_MODE_PLAN.md §3). Read by {@code EventTools} to keep
     * the server's own audit ledger out of a body's senses, and by {@code check_path} to answer from
     * held knowledge instead of from the level.
     *
     * <p><b>Ask this, never the profile string.</b> The default below is the SHIM's answer and only
     * the shim's: over there the profile is the role, and the role called {@code survival} is the
     * player-legal one. The in-jar MCP door fills the same parameter with a URL path segment its
     * operator chose, so it overrides this with the surface's declared {@code legal} flag (see
     * {@code mcp/McpSurface}). A handler that compares {@code profile()} to {@code "survival"} itself
     * gets the coincidence instead of the answer.
     */
    default boolean legal() {
        return "survival".equals(profile());
    }
}
