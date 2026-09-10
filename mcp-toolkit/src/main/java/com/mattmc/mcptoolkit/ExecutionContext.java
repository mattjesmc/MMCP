package com.mattmc.mcptoolkit;

/**
 * Which game loop a tool's handler must run on. The bridge marshals each call accordingly and, for
 * {@link #SERVER}/{@link #CLIENT}, reports a clean error when that loop isn't available.
 */
public enum ExecutionContext {
    /** Runs on the Minecraft server thread. Requires a loaded world/server. */
    SERVER,
    /** Runs on the client render/main thread. Never available on a dedicated server. */
    CLIENT,
    /** Runs directly on the HTTP handler thread. Must not touch game state. */
    ANY
}
