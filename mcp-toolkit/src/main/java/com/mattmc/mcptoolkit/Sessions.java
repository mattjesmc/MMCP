package com.mattmc.mcptoolkit;

import org.jspecify.annotations.Nullable;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * The mod-side registry of live LLM sessions — the identity substrate for session concurrency
 * (COMPANION_REDESIGN.md, "New machinery this requires").
 *
 * <p>Every session that talks to the bridge carries a session id: mod-launched sessions (workbench and
 * companions) inherit a minted id through the {@code MCPTK_SESSION} env var, and externally-launched
 * sessions self-register through the bridge's {@code POST /hello} (the Node shim does this lazily when
 * it has no env id). The bridge stamps the id onto every dispatched call ({@link ToolContext#sessionId()})
 * and every audit event, so shared single-slot resources — the drone lease ({@code DroneTools}), chat
 * routing ({@code EventTools}) — can arbitrate between callers instead of silently clobbering.
 *
 * <p><b>Liveness</b> is process-verified for entries the mod spawned (companions hold their
 * {@link Process}) and activity-based for the rest: a bridge call carrying the id refreshes
 * {@code lastSeen}. The registry is advisory bookkeeping, not security — the bridge stays
 * localhost-trusted; ids exist to attribute and arbitrate, not to authenticate.
 *
 * <p><b>Chat responder</b>: at most one live session is bound as the chat responder — the one session
 * {@code get_events} delivers {@code chat} events to while a binding exists (see {@code EventTools}).
 * The player picks it with {@code /mmcp session responder}; "none" there maps to the hard mute
 * ({@code ChatTools}). A workbench/companion auto-binds on its FIRST BRIDGE CALL — not at mint —
 * when nothing live is bound and chat is not muted, so the common single-session case needs no menu
 * visit. Binding at mint was wrong: a terminal that opens and is closed without ever connecting (or
 * one still sitting on the folder-trust prompt) held the responder slot for the whole
 * {@link #NEVER_SEEN_GRACE_MS} window and ate the player's chat for ten minutes. A session that has
 * never spoken to the bridge has no claim on chat.
 */
public final class Sessions {
    private Sessions() {}

    public enum Kind { WORKBENCH, COMPANION, EXTERNAL }

    /** Grace for a spawned-but-not-yet-connected entry (workbench boot, trust prompt). */
    private static final long NEVER_SEEN_GRACE_MS = 10 * 60_000L;
    /**
     * Staleness window for entries without a Process. The shim heartbeats every ~30s (POST
     * /heartbeat), so a session unseen for this long has genuinely ended/disconnected — this window
     * is what makes session-bound resource reaping (drones) responsive. Kept a few beats wide so a
     * busy game or a long tool call can't fake a death.
     */
    private static final long EXTERNAL_STALE_MS = 3 * 60_000L;
    /** Dead entries linger this long (visible in status as recently-ended), then are pruned. */
    private static final long PRUNE_AFTER_MS = 60 * 60_000L;

    public static final class Entry {
        public final String id;
        public final Kind kind;
        public final String label;
        public final long startedMs;
        /**
         * What the session says it is — the agent client's id and version, self-declared at hello.
         *
         * <p>Inbound sessions have always worked; what they lacked was IDENTITY. {@code /hello}
         * accepted only a label, so nothing on the mod side knew WHICH client had connected or what
         * it could do, and a session list could not tell a hand-run host from a mod-launched one.
         * Self-declared and therefore advisory, exactly like the profile header: the bridge is
         * localhost-trusted and this exists to attribute, not to authenticate.
         */
        volatile @Nullable String clientId;
        volatile @Nullable String clientVersion;
        /** The spawned process (companions: the launcher wrapper, alive as long as the session).
         * Attached just after spawn — the id must exist first, it goes into the launch env. */
        volatile @Nullable Process process;
        volatile long lastSeenMs;

        Entry(final String id, final Kind kind, final String label, final @Nullable Process process) {
            this.id = id;
            this.kind = kind;
            this.label = label;
            this.startedMs = System.currentTimeMillis();
            this.process = process;
        }

        public void attach(final Process p) {
            this.process = p;
        }

        /** Record what this session declared itself to be. Blank values are left unset. */
        public void declare(final @Nullable String client, final @Nullable String version) {
            if (client != null && !client.isBlank()) {
                this.clientId = client.length() > 60 ? client.substring(0, 60) : client;
            }
            if (version != null && !version.isBlank()) {
                this.clientVersion = version.length() > 40 ? version.substring(0, 40) : version;
            }
        }

        public @Nullable String clientId() {
            return clientId;
        }

        public @Nullable String clientVersion() {
            return clientVersion;
        }

        public @Nullable Process process() {
            return process;
        }

        /** Best liveness estimate: the process when we own one, recency of bridge calls otherwise. */
        public boolean live() {
            Process p = process;
            if (p != null) {
                return p.isAlive();
            }
            long now = System.currentTimeMillis();
            return lastSeenMs > 0
                ? now - lastSeenMs < EXTERNAL_STALE_MS
                : now - startedMs < NEVER_SEEN_GRACE_MS;
        }

        public long lastSeenMs() {
            return lastSeenMs;
        }

        /** One status line: {@code c1-91422 [companion] "build survey" — live, seen 12s ago}. */
        public String describe() {
            long now = System.currentTimeMillis();
            Process p = process;
            String seen = lastSeenMs > 0 ? (now - lastSeenMs) / 1000 + "s ago" : "never";
            String who = clientId == null ? ""
                : " via " + clientId + (clientVersion == null ? "" : " " + clientVersion);
            return id + " [" + kind.name().toLowerCase(java.util.Locale.ROOT) + "] \"" + label + "\"" + who
                + " — " + (live() ? "live" : "ended") + ", last call " + seen
                + (p != null ? ", pid " + p.pid() : "");
        }
    }

    private static final Map<String, Entry> BY_ID = new ConcurrentHashMap<>();
    private static final AtomicInteger SEQ = new AtomicInteger();
    private static volatile @Nullable String chatResponder;

    /** Register a session the mod is launching; the id goes out via the {@code MCPTK_SESSION} env var. */
    public static synchronized Entry mint(final Kind kind, final String label, final @Nullable Process process) {
        String prefix = switch (kind) {
            case WORKBENCH -> "w";
            case COMPANION -> "c";
            case EXTERNAL -> "x";
        };
        String id = prefix + SEQ.incrementAndGet() + "-" + (System.currentTimeMillis() / 1000 % 100_000);
        Entry e = new Entry(id, kind, label, process);
        BY_ID.put(id, e);
        // No auto-bind here — see maybeAutoBind, which runs on this entry's first bridge call.
        prune();
        return e;
    }

    /**
     * Forget an entry whose launch failed after minting. Without this, a failed spawn leaves a
     * phantom that {@code live()} reports alive for the whole 10-minute never-seen grace, listed in
     * {@code /mmcp session} as a session that never existed. It can no longer be holding the
     * responder slot (binding waits for a first bridge call a failed spawn never makes), but the
     * unbind stays as a belt-and-braces clear for any other path that reaches here.
     */
    public static synchronized void abort(final String id) {
        BY_ID.remove(id);
        if (id.equals(chatResponder)) {
            chatResponder = null;
            McpToolkit.LOGGER.info("[MCP Toolkit] chat responder unbound — {} failed to launch", id);
        }
    }

    /**
     * A bridge call carried this id — refresh liveness. Unknown ids are adopted as EXTERNAL entries:
     * they are sessions from before a game restart (their env id outlives our map) or shims minted by
     * an older /hello; adopting keeps them attributable instead of anonymous.
     */
    public static void touch(final @Nullable String id) {
        if (id == null || id.isBlank()) {
            return;
        }
        Entry e = BY_ID.get(id);
        if (e == null) {
            e = new Entry(id, Kind.EXTERNAL, "adopted", null);
            BY_ID.putIfAbsent(id, e);
            e = BY_ID.get(id);
        }
        boolean first = e.lastSeenMs == 0;
        e.lastSeenMs = System.currentTimeMillis();
        if (first) {
            maybeAutoBind(e);
        }
    }

    /**
     * The auto-bind, run once per entry when it first speaks to the bridge: a launch that finds
     * nothing live routed (and chat unmuted) becomes the responder — the single-session fast path.
     * External hellos never steal the binding.
     *
     * <p>Waking any parked {@code get_events} long-poll matters as much as setting the field: chat
     * exclusion is re-derived on every wake, and a poller sleeping on a quiet stream would otherwise
     * not learn it had just been handed the route until the next event or its own timeout.
     */
    private static synchronized void maybeAutoBind(final Entry e) {
        if (e.kind == Kind.EXTERNAL || ChatTools.muted() || isLive(chatResponder)) {
            return;
        }
        chatResponder = e.id;
        McpToolkit.LOGGER.info("[MCP Toolkit] chat responder auto-bound to {} ({}) on first call",
            e.id, e.label);
        EventLog.wakePollers();
    }

    public static @Nullable Entry get(final @Nullable String id) {
        return id == null ? null : BY_ID.get(id);
    }

    public static boolean isLive(final @Nullable String id) {
        Entry e = get(id);
        return e != null && e.live();
    }

    /** All live entries, newest first. */
    public static List<Entry> live() {
        prune();
        List<Entry> out = new ArrayList<>();
        for (Entry e : BY_ID.values()) {
            if (e.live()) {
                out.add(e);
            }
        }
        out.sort(Comparator.comparingLong((Entry e) -> e.startedMs).reversed());
        return out;
    }

    public static List<Entry> liveCompanions() {
        List<Entry> out = new ArrayList<>();
        for (Entry e : live()) {
            if (e.kind == Kind.COMPANION) {
                out.add(e);
            }
        }
        return out;
    }

    /** The bound chat responder id, or null when unrouted (all sessions hear). Dead bindings self-clear. */
    public static @Nullable String chatResponder() {
        String id = chatResponder;
        if (id != null && !isLive(id)) {
            chatResponder = null;
            return null;
        }
        return id;
    }

    public static void setChatResponder(final @Nullable String id) {
        chatResponder = id;
        McpToolkit.LOGGER.info("[MCP Toolkit] chat responder set to {}", id == null ? "none (unrouted)" : id);
        // A rebind changes who chat is FOR, and the sessions it changes it for are asleep inside a
        // long-poll that re-derives its own exclusions on wake. Without this the rebind takes
        // effect only when the next event happens to land — up to 60s of chat going to the old
        // responder, which is the same "routing read at the wrong moment" bug one layer up.
        EventLog.wakePollers();
    }

    /** Multi-line listing for {@code /mmcp session} and logs. */
    public static String describeAll() {
        List<Entry> all = live();
        if (all.isEmpty()) {
            return "no live sessions";
        }
        StringBuilder sb = new StringBuilder(all.size() + " live session(s):");
        String responder = chatResponder();
        for (Entry e : all) {
            sb.append("\n  ").append(e.describe());
            if (e.id.equals(responder)) {
                sb.append("  <- chat responder");
            }
        }
        if (responder == null) {
            sb.append("\n  chat: ").append(ChatTools.muted() ? "MUTED" : "unrouted (all sessions hear)");
        }
        return sb.toString();
    }

    private static void prune() {
        long now = System.currentTimeMillis();
        BY_ID.values().removeIf(e -> !e.live()
            && now - Math.max(e.lastSeenMs, e.startedMs) > PRUNE_AFTER_MS);
    }
}
