package com.mattmc.mcptoolkit.mcp;

import org.jspecify.annotations.Nullable;

import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * One MCP connection: what a client got back in {@code Mcp-Session-Id} and everything the protocol
 * layer has to remember between its requests.
 *
 * <h2>Two session ideas, deliberately kept apart</h2>
 *
 * <p>The {@link #id} here is the TRANSPORT's — the spec's session id, minted at {@code initialize},
 * echoed on every later request, and ended by {@code DELETE}. {@link #toolkitSession} is the
 * toolkit's own ({@code Sessions}), the one the audit log attributes acts to and the drone lease
 * arbitrates on. They are one-to-one and they are still not the same thing: a toolkit session is
 * minted by the door the caller came through (a shim's {@code POST /hello}, or here), and the rest
 * of the mod knows only that kind. Mapping one to the other at the transport edge is what lets every
 * session-bound resource in the toolkit work for an MCP client without knowing MCP exists.
 *
 * <p><b>The surface is fixed at connect</b> and is not part of the state a request may change: the
 * client dialled {@code /mcp/<name>}, and a connection cannot re-profile itself. That is the same
 * rule the survival profile rides shim-side ("legality is a launch property, never a running
 * choice") arrived at from the other end — here it is not a rule at all, but a consequence of the
 * surface being the address.
 */
public final class McpConn {

    /** How long an idle connection is kept before it is reaped. */
    static final long IDLE_MS = 30 * 60_000L;

    private static final Map<String, McpConn> LIVE = new ConcurrentHashMap<>();
    private static final AtomicLong SEQ = new AtomicLong();

    public final String id;
    public final McpSurface surface;
    /** The toolkit-side session id this connection acts as, for audit attribution and arbitration. */
    public final @Nullable String toolkitSession;

    private volatile String protocolVersion = McpProtocol.FALLBACK_PROTOCOL_VERSION;
    private volatile boolean initialized;
    private volatile long lastSeenMs = System.currentTimeMillis();
    private volatile @Nullable String clientName;
    private volatile @Nullable String clientVersion;

    McpConn(final String id, final McpSurface surface, final @Nullable String toolkitSession) {
        this.id = id;
        this.surface = surface;
        this.toolkitSession = toolkitSession;
    }

    // ---- the live table ------------------------------------------------------

    /** Mint a connection and register it. The id is opaque to the client and must stay ASCII-visible. */
    public static McpConn open(final McpSurface surface, final @Nullable String toolkitSession) {
        String id = "mcp-" + Long.toHexString(System.currentTimeMillis()) + "-"
            + Long.toHexString(SEQ.incrementAndGet());
        McpConn conn = new McpConn(id, surface, toolkitSession);
        reap();
        LIVE.put(id, conn);
        return conn;
    }

    public static @Nullable McpConn get(final @Nullable String id) {
        if (id == null) {
            return null;
        }
        McpConn c = LIVE.get(id);
        if (c != null) {
            c.lastSeenMs = System.currentTimeMillis();
        }
        return c;
    }

    public static @Nullable McpConn close(final @Nullable String id) {
        return id == null ? null : LIVE.remove(id);
    }

    public static Collection<McpConn> live() {
        reap();
        return new ArrayList<>(LIVE.values());
    }

    /**
     * Drop connections nothing has spoken on for {@link #IDLE_MS}. A client that goes away without a
     * DELETE (the common case: the whole agent program exited) leaves its entry behind, and an entry
     * costs a toolkit session that the drone reaper and the session list both still believe in.
     */
    static void reap() {
        reap(System.currentTimeMillis());
    }

    /** {@link #reap()} against a stated now, so a test can age a connection instead of waiting out {@link #IDLE_MS}. */
    static void reap(final long nowMs) {
        long cutoff = nowMs - IDLE_MS;
        List<String> dead = new ArrayList<>();
        for (Map.Entry<String, McpConn> e : LIVE.entrySet()) {
            if (e.getValue().lastSeenMs < cutoff) {
                dead.add(e.getKey());
            }
        }
        for (String id : dead) {
            LIVE.remove(id);
        }
    }

    // ---- per-connection state ------------------------------------------------

    public String protocolVersion() {
        return protocolVersion;
    }

    void setProtocolVersion(final String v) {
        this.protocolVersion = v;
    }

    public boolean initialized() {
        return initialized;
    }

    void markInitialized() {
        this.initialized = true;
    }

    void declare(final @Nullable String name, final @Nullable String version) {
        this.clientName = name;
        this.clientVersion = version;
    }

    public @Nullable String clientName() {
        return clientName;
    }

    public @Nullable String clientVersion() {
        return clientVersion;
    }

    void touch() {
        touch(System.currentTimeMillis());
    }

    /** {@link #touch()} against a stated moment — the other half of {@link #reap(long)}'s test seam. */
    void touch(final long nowMs) {
        this.lastSeenMs = nowMs;
    }

    public long lastSeenMs() {
        return lastSeenMs;
    }
}
