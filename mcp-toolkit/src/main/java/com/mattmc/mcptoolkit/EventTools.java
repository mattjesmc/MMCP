package com.mattmc.mcptoolkit;

import org.jspecify.annotations.Nullable;

/** Registers {@code get_events} — the read side of the unified {@link EventLog}. */
public final class EventTools {
    private EventTools() {}

    private static final int DEFAULT_LIMIT = 50;
    private static final int MAX_LIMIT = 200;
    /** Long-poll cap — must stay under this tool's dispatch timeout ({@link #DISPATCH_TIMEOUT_SECONDS}). */
    private static final long MAX_WAIT_MS = 60_000;
    /** Dispatch timeout for get_events only: wait cap + headroom. Other tools keep the 15s default. */
    private static final int DISPATCH_TIMEOUT_SECONDS = 70;

    public static void register() {
        McpTools.register(ToolDef.of(
            "get_events",
            "Poll the unified event/audit log (append-only, cursor-consumed) — YOUR NERVOUS SYSTEM while "
                + "embodied. Without `cursor`: the newest "
                + "events plus a `cursor` to poll from next. With `cursor`: only events with id > cursor, "
                + "plus `missed` (events evicted before you polled — counted through YOUR filter, never "
                + "silently dropped; `missed_urgent` = how many were danger), `more` "
                + "(true = poll again immediately from the returned cursor) and `urgent` (danger events "
                + "still queued BEHIND this page, so a page of routine events can never bury them — they "
                + "are delivered normally later too). Event types. "
                + EventTypes.toolDoc()
                + " A page is read as a GROUP, so fields constant across it ride the RESULT, not every "
                + "row: `dimension` (present when the whole page agrees; a row that disagrees carries "
                + "its own) and `now` (wall-clock ms for the page). Each event carries `game_tick` — "
                + "20 per second, and the clock everything else here reasons in. "
                + " Body, drone and reflex events are per-session: you receive them for YOUR body only. "
                + "`type` accepts a comma-separated list — but do NOT narrow to \"chat,session_msg\" while "
                + "embodied: a filter that excludes your body events is a body that cannot feel. "
                + "Every event carries game_tick. Optional `wait_ms` "
                + "(max 60000) long-polls: when no matching event exists yet, the call blocks until one "
                + "arrives or the wait elapses. Longer waits are strictly cheaper for a listen loop — the "
                + "per-call cost is the same regardless of wait. Use wait_ms 20000 by default; above "
                + "~25000 make sure the MCP client's tool timeout is raised - every host names that "
                + "setting differently (in Claude Code it is the MCP_TOOL_TIMEOUT env var) - or the "
                + "client gives up before the poll returns.",
            Schemas.objectOpt(Schemas.object(
                "cursor", Schemas.integer("Last event id you have seen; returns strictly newer events."),
                "limit", Schemas.integer("Max events to return (default 50, cap 200)."),
                "type", Schemas.str("Event type filter — one type or a comma-separated list, "
                    + "e.g. \"chat,session_msg\"."),
                "wait_ms", Schemas.integer("Long-poll: block up to this long (max 60000) for a match. "
                    + "Above ~25000 the MCP client's tool timeout must be raised to match.")),
                "cursor", "limit", "type", "wait_ms"),
            ExecutionContext.ANY,
            Mechanism.OBSERVE,
            (ctx, a) -> {
                Long cursor = a.has("cursor") && !a.get("cursor").isJsonNull()
                    ? a.get("cursor").getAsLong() : null;
                int limit = a.has("limit") && !a.get("limit").isJsonNull()
                    ? a.get("limit").getAsInt() : DEFAULT_LIMIT;
                if (limit <= 0) {
                    limit = DEFAULT_LIMIT;
                }
                String type = a.has("type") && !a.get("type").isJsonNull()
                    ? a.get("type").getAsString() : null;
                long waitMs = a.has("wait_ms") && !a.get("wait_ms").isJsonNull()
                    ? Math.min(Math.max(a.get("wait_ms").getAsLong(), 0), MAX_WAIT_MS) : 0;
                // Delivery filters are derived HERE and re-derived on every long-poll wake (the
                // supplier is what queryWaiting calls again on each wake), never snapshotted for the
                // life of the call — see exclusionsFor.
                java.util.function.Supplier<java.util.Set<String>> exclusions =
                    () -> exclusionsFor(ctx, type);
                try {
                    return waitMs > 0
                        ? EventLog.queryWaiting(cursor, Math.min(limit, MAX_LIMIT), type, waitMs,
                            exclusions, ctx.sessionId())
                        : EventLog.query(cursor, Math.min(limit, MAX_LIMIT), type,
                            exclusions.get(), ctx.sessionId());
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException("long-poll interrupted");
                }
            }).withTimeout(DISPATCH_TIMEOUT_SECONDS));
    }

    /**
     * The event types this caller must not be delivered, for the routing table AS IT IS RIGHT NOW.
     *
     * <p>Called once for an immediate poll and again on every wake of a long-poll, because a
     * 60-second poll outlives the facts it filters on. Chat routing is rebound with
     * {@code /mmcp session responder}
     * mid-poll, and evaluating it only at poll start meant the rebind did not take hold until the
     * poll returned: the old responder kept receiving chat it was no longer the responder for, and
     * the new one kept being denied chat that was already its. {@code Sessions} nudges parked pollers
     * on every rebind so this re-derivation actually happens promptly instead of waiting for whatever
     * event lands next.
     *
     * <p>Throws for a request that can no longer be satisfied at all, rather than letting it starve:
     * a poll asking for ONLY chat while chat is routed elsewhere will never deliver anything, and
     * saying so is the same verdict a fresh call gets.
     */
    private static java.util.Set<String> exclusionsFor(final ToolContext ctx,
                                                       final @Nullable String type) {
        java.util.Set<String> exclude = new java.util.HashSet<>();
        // Chat routing: while a responder is bound, chat events flow only to that session. Everyone
        // else gets them filtered out — and a request for ONLY chat fails fast instead of polling a
        // stream that will never deliver (silent starvation). A multi-type request that includes chat
        // degrades silently to the other types.
        String responder = Sessions.chatResponder();
        boolean excludeChat = responder != null && !responder.equals(ctx.sessionId());
        if (excludeChat && type != null && "chat".equals(type.strip())) {
            Sessions.Entry r = Sessions.get(responder);
            throw new IllegalStateException("chat is routed to session " + responder
                + (r == null ? "" : " (\"" + r.label + "\")")
                + " — this session will not receive chat events. The player rebinds the "
                + "responder with /mmcp session responder <id|none>.");
        }
        if (excludeChat) {
            exclude.add("chat");
        }
        // Legality: audit records are the SERVER's ledger of consequential calls, carrying the tool,
        // the coordinates and the block ids of edits some other session made. A player-legal body
        // never perceived any of that, and the stream is broadcast, so a survival session polling all
        // types (which its charter tells it to do) was reading the copilot's edits as world
        // knowledge. Filtered at the source, like chat routing — enforcement here, not agent goodwill
        // (SURVIVAL_MODE_PLAN §3's flagged edge).
        //
        // This exclusion is deliberately SILENT. Everywhere else in this log, hiding something
        // without saying so is the cardinal sin; here saying so would itself be the leak ("3 events
        // were withheld" announces that something happened). A sense boundary is not a truncation, so
        // the disclosure belongs at contract level — the tool description states that legal sessions
        // do not receive audit — not per poll.
        //
        // `error` rides the same rule for the same reason: a log ERROR is the server process
        // complaining, not a thing that happened in the world. A body that could read stderr would
        // know a datapack was malformed without ever having touched it.
        if (ctx.legal()) {
            exclude.add("audit");
            exclude.add("error");
            String t = type == null ? null : type.strip();
            if ("audit".equals(t) || "error".equals(t)) {
                throw new IllegalStateException(t + " records are not delivered to a "
                    + "player-legal session: they are the server's own ledger, "
                    + "not something a body can perceive. Use your senses (sense_entities, "
                    + "bot_scan) and your memory (locate, mem_recall) instead.");
            }
        }
        return exclude;
    }
}
