package com.mattmc.mcptoolkit;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.jspecify.annotations.Nullable;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Set;
import java.util.function.LongSupplier;
import java.util.function.Supplier;

/**
 * The unified append-only event stream — one log, three consumers (ARCHITECTURE.md, "One log, three
 * consumers"):
 * <ol>
 *   <li><b>Native world events</b> — weather/time-of-day transitions, drone state ({@link WorldEvents},
 *       {@code DroneTools}).</li>
 *   <li><b>Action feedback</b> — async embodied actions finish with {@code action_completed} /
 *       {@code action_failed}, correlated by {@code action_id}.</li>
 *   <li><b>Audit records</b> — every {@code world_edit}/{@code privileged} call, success or failure,
 *       emitted at the {@link BridgeServer} dispatch chokepoint. Audit and situational awareness can never
 *       disagree because they are the same stream.</li>
 * </ol>
 *
 * <p>Consumption is cursor-based on the proven ChatLog pattern: bounded ring, monotonic ids, poll with
 * {@code get_events} passing the last seen id. A consumer that falls behind the ring is told exactly how
 * many events it {@code missed} instead of silently losing them (the no-silent-truncation rule).
 *
 * <p><b>Two survival properties on top of that</b> (0.42.0), both about a stream that is honest but
 * unusable under load:
 * <ol>
 *   <li><b>{@code missed} is counted through the caller's own filter.</b> It used to be the raw ring
 *       gap, so a session filtering by {@code type} — or merely sharing the process with a busy
 *       copilot — was told it had missed hundreds of events that were never its to see. A false alarm
 *       in the one field whose whole job is honesty. The {@link #EVICTED} ledger keeps the (id, type,
 *       to) of departed events so the count can be exact for the caller's filter, and says
 *       {@code missed_exact:false} when even the ledger has rolled past.</li>
 *   <li><b>Danger cannot be buried by chatter.</b> Reads are oldest-first and page at {@code limit},
 *       which is right for a cursor but wrong for a body: a {@code body_endangered {air_low}} with a
 *       15-second fuse could sit behind a page of routine events for several polls. Ordering is NOT
 *       negotiable (a cursor that skips is a cursor that lies), so the page is unchanged and a compact
 *       {@code urgent} preview of the danger events STILL QUEUED behind it rides along
 *       ({@link EventTypes#isUrgent(String, JsonObject)}). They are delivered again, in order, in a later page — the
 *       preview consumes nothing.</li>
 * </ol>
 *
 * <p>Thread-safety: {@code emit} is called from the server thread (world/drone watchers) and the bridge's
 * HTTP thread (audit); all state is guarded by the class monitor.
 */
public final class EventLog {
    private EventLog() {}

    private static final int CAP = 1000;
    /** How many departed events keep their (id, type, to) so {@code missed} can be filtered exactly.
     *  Several rings deep: a consumer that has fallen further behind than this is told so. */
    private static final int EVICTED_CAP = 4000;
    /** Cap on the {@code urgent} preview — a headline, not a second page. */
    private static final int URGENT_PREVIEW = 5;
    private static final Deque<Entry> LOG = new ArrayDeque<>();
    /** Metadata of events that have left the ring, oldest first — what {@code missed} is counted from. */
    private static final Deque<Evicted> EVICTED = new ArrayDeque<>();
    private static final Set<String> WARNED_TYPES = java.util.concurrent.ConcurrentHashMap.newKeySet();
    /**
     * The last event id served to each caller — the memory that lets a cursorless poll be told apart
     * from a first poll (see {@link #query}). Bounded because sessions are transient and this must
     * not become a leak; eviction is oldest-insertion-first, and losing an entry only costs that
     * caller the recovery, degrading to the old tail-and-say-nothing behaviour.
     */
    private static final int SERVED_CAP = 64;
    private static final java.util.LinkedHashMap<String, Long> LAST_SERVED =
        new java.util.LinkedHashMap<>(16, 0.75F, false) {
            @Override
            protected boolean removeEldestEntry(final java.util.Map.Entry<String, Long> eldest) {
                return size() > SERVED_CAP;
            }
        };
    private static long nextId = 1;
    private static volatile LongSupplier tick = () -> -1L;

    /** What survives an event's eviction: enough to answer "was it mine, and was it danger?".
     *  {@code urgent} is CARRIED rather than re-derived because the data it was decided from is
     *  gone by then — see {@link EventTypes#isUrgent(String, JsonObject)}. */
    private record Evicted(long id, String type, @Nullable String to, boolean urgent) {}

    /** {@code to} — targeted delivery: non-null means only the session with that id receives the
     * event ({@code session_msg}, per-session drone events). Null = broadcast (everything else).
     * {@code urgent} is decided once, at emit, by {@link EventTypes}. {@code dimension} is LIFTED
     * OUT of {@code data} at emit (see {@link #compact}) so a page can hoist it. */
    private record Entry(long id, long timeMs, long gameTick, String type, JsonObject data,
                         @Nullable String to, boolean urgent, @Nullable String dimension) {}

    /**
     * Squeeze the per-event envelope, ONCE, at emit — never on the read path, because {@code data}
     * is owned by the log and re-delivered on later pages, so a read that edited it would corrupt
     * the record for the next reader.
     *
     * <p>Two removals, both pure duplication (measured on a live survival session, 2026-08-01):
     * <ul>
     *   <li><b>{@code game_tick}</b> — {@code DroneTools.stampEnvelope} writes it into every embodied
     *       payload and {@link #toJson} writes it again on the envelope. 3% of a page, saying the
     *       same number twice.</li>
     *   <li><b>{@code dimension}</b> — same stamp, 5% of a page, and near-constant across it. Lifted
     *       onto the entry so {@link #query} can print it once for the whole page and per-event only
     *       when a page genuinely spans dimensions.</li>
     * </ul>
     * The stamp itself stays: it is what makes a SYNCHRONOUS verdict datable, and that is a
     * different payload from this one.
     */
    private static @Nullable String compact(final JsonObject data, final long gameTick) {
        if (data.has("game_tick") && data.get("game_tick").isJsonPrimitive()
            && data.get("game_tick").getAsLong() == gameTick) {
            data.remove("game_tick");
        }
        if (!data.has("dimension") || !data.get("dimension").isJsonPrimitive()) {
            return null;
        }
        String dim = data.get("dimension").getAsString();
        data.remove("dimension");
        return dim;
    }

    /** Set at SERVER_STARTED so every event carries the world game time; pass null at SERVER_STOPPING. */
    public static void setTickSupplier(final @Nullable LongSupplier supplier) {
        tick = supplier == null ? () -> -1L : supplier;
    }

    /** Append a broadcast event and return its id. The log owns {@code data} after this call. */
    public static long emit(final String type, final JsonObject data) {
        return emit(type, data, null);
    }

    /**
     * World boundary: drop the closed world's events and announce it. On the integrated server the
     * process outlives worlds, and without this world A's events (carrying world A's ticks) kept
     * serving after world B opened, nothing marking the seam. A plain clear would be silent loss —
     * the ring's {@code missed} arithmetic cannot see it — so the boundary rides in as an event:
     * ids stay monotonic across the clear, cursors stay valid, and every consumer's next poll leads
     * with {@code world_closed} naming how many events went with the world.
     */
    public static synchronized void clearForWorldClose(final String world) {
        int dropped = LOG.size();
        // The dropped events are gone the same way evicted ones are, so they leave the same trace:
        // a consumer whose cursor predates the boundary still gets an exact `missed` for its own
        // filter, on top of the world_closed record's coarse dropped_events.
        for (Entry e : LOG) {
            evict(e);
        }
        LOG.clear();
        // Served positions belong to the world that produced them. Keeping them across a world
        // boundary would let a cursorless poll "recover" to an id from the previous world — the
        // exact confusion `world_closed` exists to prevent.
        LAST_SERVED.clear();
        JsonObject d = new JsonObject();
        d.addProperty("world", world);
        d.addProperty("dropped_events", dropped);
        d.addProperty("note", "this world closed; earlier events (and their game_ticks) belonged to "
            + "it and are no longer served");
        emit("world_closed", d, null);
    }

    /** Append an event, optionally targeted at one session id ({@code to}); null broadcasts. */
    public static synchronized long emit(final String type, final JsonObject data,
                                         final @Nullable String to) {
        // World-model episodes tap (DESIGN.md §13.1): verdicts and reflex lifecycle are already
        // assembled HERE, with their ledgers — one seam instead of edits at every emitter. Runs
        // before compact() lifts fields out of `data`, and serializes synchronously, so the row on
        // disk is the row the emitter built. No-op unless the recorder is on.
        com.mattmc.mcptoolkit.wm.Wm.event(type, data, to);
        // Drift alarm: the vocabulary the model can subscribe to is EventTypes, and an emitter absent
        // from it ships a type nobody can name in a `type` filter — how thirteen live types once
        // became invisible. Warn once per type; never fail an emit over documentation.
        if (!EventTypes.isKnown(type) && WARNED_TYPES.add(type)) {
            McpToolkit.LOGGER.warn("[MCP Toolkit] event type '{}' is not registered in EventTypes — "
                + "it will not appear in the get_events vocabulary and cannot be documented to the "
                + "model; add it there", type);
        }
        long gameTick = tick.getAsLong();
        String dimension = compact(data, gameTick);
        Entry e = new Entry(nextId++, System.currentTimeMillis(), gameTick, type, data, to,
            EventTypes.isUrgent(type, data), dimension);
        LOG.addLast(e);
        while (LOG.size() > CAP) {
            evict(LOG.removeFirst());
        }
        EventLog.class.notifyAll(); // wake long-pollers (queryWaiting)
        return e.id();
    }

    /**
     * Wake every parked {@link #queryWaiting} so it re-runs its query — including re-deriving its
     * delivery filters. Nothing was appended, so a poll with nothing to return simply goes back to
     * sleep for the rest of its window; what this exists for is the filters CHANGING under a sleeping
     * poller. Chat routing is the case: rebinding the responder ({@code Sessions}) changes who a
     * {@code chat} event is for, and without a nudge the new routing would not take hold until the
     * next event happened to land — up to a full 60s poll of chat delivered by the old table.
     */
    public static synchronized void wakePollers() {
        EventLog.class.notifyAll();
    }

    /** Retire an event's identity into the ledger {@code missed} is counted from. */
    private static void evict(final Entry e) {
        EVICTED.addLast(new Evicted(e.id(), e.type(), e.to(), e.urgent()));
        while (EVICTED.size() > EVICTED_CAP) {
            EVICTED.removeFirst();
        }
    }

    /**
     * {@link #query}, but blocks up to {@code waitMs} for a matching event when the immediate result is
     * empty — the long-poll a chat companion listens with. Callers must be off the game thread
     * ({@code ExecutionContext.ANY} tools run on the HTTP handler); the wait must stay under the bridge's
     * dispatch timeout.
     */
    public static JsonObject queryWaiting(final @Nullable Long cursor, final int limit,
                                          final @Nullable String type, final long waitMs)
            throws InterruptedException {
        // Cast disambiguates the Set overload from the Supplier one.
        return queryWaiting(cursor, limit, type, waitMs, (Set<String>) null, null);
    }

    /**
     * {@link #queryWaiting} with exclusions and a caller identity: events of the {@code excludeTypes}
     * neither match nor wake, and targeted events wake only their addressee.
     */
    public static JsonObject queryWaiting(final @Nullable Long cursor, final int limit,
                                          final @Nullable String type, final long waitMs,
                                          final @Nullable Set<String> excludeTypes,
                                          final @Nullable String caller)
            throws InterruptedException {
        return queryWaiting(cursor, limit, type, waitMs, () -> excludeTypes, caller);
    }

    /**
     * {@link #queryWaiting} whose exclusions are RE-DERIVED on every wake rather than snapshotted at
     * poll start.
     *
     * <p>The filters a poll delivers through are not constant for its lifetime: chat routing can be
     * rebound with {@code /mmcp session responder} at any moment, and a poll can run for a full
     * minute. Evaluating
     * the responder once, when the call arrived, meant a rebind took up to 60 seconds to take effect
     * — and in that window the log double-delivered (the old responder still excluded nothing) or
     * withheld (the new one still excluded chat) exactly the events the rebind was performed to
     * redirect. Same defect as binding the responder at session mint, one layer down: the routing
     * table read at the wrong moment.
     *
     * <p>The supplier may throw — {@code EventTools} uses it to fail a chat-only poll fast when the
     * route is lost mid-wait, which is the same verdict a fresh call would have been given, rather
     * than starving silently on a stream that can no longer deliver.
     */
    public static JsonObject queryWaiting(final @Nullable Long cursor, final int limit,
                                          final @Nullable String type, final long waitMs,
                                          final Supplier<Set<String>> excludeTypes,
                                          final @Nullable String caller)
            throws InterruptedException {
        long deadline = System.currentTimeMillis() + waitMs;
        synchronized (EventLog.class) {
            while (true) {
                JsonObject r = query(cursor, limit, type, excludeTypes.get(), caller);
                // A stale-launch cursor never matches anything; return the reset verdict instead of
                // parking the poll until timeout on a stream that will stay silent.
                if (r.get("returned").getAsInt() > 0 || r.has("cursor_reset")) {
                    return r;
                }
                long remaining = deadline - System.currentTimeMillis();
                if (remaining <= 0) {
                    return r;
                }
                EventLog.class.wait(remaining);
            }
        }
    }

    /**
     * Read events. With a {@code cursor}: strictly-after semantics ({@code id > cursor}) plus a
     * {@code missed} count for events already evicted from the ring, and {@code more:true} when the limit
     * cut the result (poll again from the returned cursor). Without a cursor: the newest {@code limit}
     * events — the catch-up/first-call form. The returned {@code cursor} is always safe to poll from
     * without skipping anything.
     */
    public static synchronized JsonObject query(final @Nullable Long cursor, final int limit,
                                                final @Nullable String type) {
        return query(cursor, limit, type, null, null);
    }

    /**
     * {@link #query} with delivery filters. {@code type} may be a single type or a comma-separated
     * list. Events whose type is in {@code excludeTypes} are treated as non-matching (chat routing —
     * {@code EventTools} hides {@code chat} events from sessions that are not the bound responder;
     * legality — {@code audit} records are not delivered to player-legal sessions). Targeted events
     * (non-null {@code to}) match only when {@code caller} is the addressee — an anonymous caller
     * sees broadcast events only. Filtered-out events do not advance the returned cursor when nothing
     * else matched, which is safe: cursors are strictly-after markers, so the caller simply re-scans
     * them next poll along with whatever new events arrived.
     *
     * <p>{@code missed} counts only events THIS caller would have been given — same type filter, same
     * exclusions, same addressing — because a count of other people's evictions is a false alarm, not
     * a disclosure. {@code missed_urgent} names how many of them were danger, and
     * {@code missed_exact:false} admits the ledger itself has rolled past the cursor.
     */
    public static synchronized JsonObject query(final @Nullable Long cursor, final int limit,
                                                final @Nullable String type,
                                                final @Nullable Set<String> excludeTypes,
                                                final @Nullable String caller) {
        // A cursor at or past nextId cannot have come from this log: ids restart at 1 every JVM
        // launch, so a persisted cursor from a previous run points at a future this run will not
        // reach for a long time. Without this flag such a consumer polls "nothing new" forever —
        // a permanently silent stream that looks quiet rather than broken.
        boolean reset = cursor != null && cursor >= nextId;

        // A CALLER THAT HAS POLLED BEFORE AND ARRIVES WITHOUT A CURSOR HAS LOST IT, NOT RESTARTED.
        //
        // Cursorless used to mean "tail the newest page" with `missed: 0` — correct for a session's
        // first ever poll (nothing can have been missed yet) and a silent lie for every later one.
        // The routine way a live session loses its cursor is CONTEXT COMPACTION: the cursor exists
        // only in the conversation, the compact summary is a prose paragraph, and the model comes
        // back with no number. It then polls bare, gets the tail, reads `missed: 0`, and believes it
        // has continuity — while every death, `body_endangered` and `reaction_fired` in the gap is
        // dropped without trace. Found 2026-08-02 reading a compacted survival session
        // (ROUTE_LEDGER work, session w2-75927); the compact payload was 190 characters and
        // contained no cursor.
        //
        // So the log remembers what it last served each caller and resumes from there. Disclosed,
        // never silent: `cursor_recovered` says it happened, and `missed` is then computed against
        // the real cursor, so a gap too big for the ring still reports itself honestly.
        long effective = cursor == null ? -1 : cursor;
        boolean recovered = false;
        Long served = caller == null ? null : LAST_SERVED.get(caller);
        if (cursor == null && served != null && served < nextId) {
            effective = served;
            recovered = true;
        }
        Long useCursor = (cursor == null && !recovered) ? null : effective;

        Set<String> types = null;
        if (type != null && !type.isBlank()) {
            types = new java.util.HashSet<>();
            for (String t : type.split(",")) {
                if (!t.isBlank()) {
                    types.add(t.strip());
                }
            }
        }

        // Eviction accounting, through the caller's own filter (see the class doc).
        long missed = 0;
        long missedUrgent = 0;
        boolean missedExact = true;
        if (useCursor != null) {
            for (Evicted ev : EVICTED) {
                if (ev.id() <= useCursor || !delivers(ev.type(), ev.to(), types, excludeTypes, caller)) {
                    continue;
                }
                missed++;
                if (ev.urgent()) {
                    missedUrgent++;
                }
            }
            // Evictions older than the ledger's own window are unknowable — say so rather than
            // reporting the short count as if it were the whole loss.
            missedExact = EVICTED.isEmpty() || EVICTED.peekFirst().id() <= useCursor + 1;
        }

        List<Entry> matched = new ArrayList<>();
        for (Entry e : LOG) {
            if (useCursor != null && e.id() <= useCursor) {
                continue;
            }
            if (delivers(e.type(), e.to(), types, excludeTypes, caller)) {
                matched.add(e);
            }
        }

        // Cursor mode reads oldest-first (nothing may be skipped); catch-up mode tails the newest.
        int from = useCursor == null ? Math.max(0, matched.size() - limit) : 0;
        int count = Math.min(limit, matched.size() - from);

        // Hoist the page's dimension: events are read as a GROUP, and a field that is the same on
        // every row of it belongs on the group, not repeated down it. Only when the whole page
        // agrees — a page that genuinely spans dimensions stamps each row instead, because a hoisted
        // value that is wrong for some rows is worse than a repeated one.
        String pageDimension = null;
        boolean uniform = true;
        for (int i = from; i < from + count && uniform; i++) {
            String d = matched.get(i).dimension();
            if (d == null) {
                continue;
            }
            if (pageDimension == null) {
                pageDimension = d;
            } else if (!pageDimension.equals(d)) {
                uniform = false;
            }
        }
        if (!uniform) {
            pageDimension = null;
        }

        JsonArray arr = new JsonArray();
        for (int i = from; i < from + count; i++) {
            arr.add(toJson(matched.get(i), pageDimension));
        }

        long nextCursor;
        if (count > 0) {
            nextCursor = matched.get(from + count - 1).id();
        } else {
            nextCursor = useCursor != null ? useCursor : nextId - 1;
        }

        JsonObject r = new JsonObject();
        r.addProperty("cursor", nextCursor);
        r.addProperty("returned", count);
        if (pageDimension != null) {
            r.addProperty("dimension", pageDimension); // every event below is in this dimension
        }
        // One wall clock for the page, replacing a 13-digit epoch on every row. Per-event timing is
        // `game_tick` (20/second), which is the clock everything else in the toolkit reasons in.
        r.addProperty("now", System.currentTimeMillis());
        boolean more = useCursor != null && from + count < matched.size();
        r.addProperty("more", more);
        r.addProperty("missed", missed);
        if (missedUrgent > 0) {
            r.addProperty("missed_urgent", missedUrgent);
        }
        if (!missedExact) {
            r.addProperty("missed_exact", false);
            r.addProperty("missed_note", "more events were evicted than the log still remembers the "
                + "identity of — `missed` is a lower bound");
        }
        // The danger preview: what is still queued behind this page. Non-consuming — the cursor does
        // not move past these, so they arrive again, in order, in a later page.
        if (more) {
            JsonArray urgent = new JsonArray();
            for (int i = from + count; i < matched.size() && urgent.size() < URGENT_PREVIEW; i++) {
                Entry e = matched.get(i);
                if (!e.urgent()) {
                    continue;
                }
                JsonObject u = new JsonObject();
                u.addProperty("id", e.id());
                u.addProperty("type", e.type());
                u.addProperty("summary", EventTypes.summarize(e.type(), e.data()));
                urgent.add(u);
            }
            if (!urgent.isEmpty()) {
                r.add("urgent", urgent);
                r.addProperty("urgent_note", "danger events still queued behind this page — act on "
                    + "them now; they are also delivered in order as you keep polling");
            }
        }
        if (reset) {
            r.addProperty("cursor_reset", true);
            r.addProperty("note", "your cursor is from a previous game launch (event ids restart at 1); "
                + "re-poll from cursor 0 to catch up on this launch's events");
        }
        if (recovered) {
            r.addProperty("cursor_recovered", effective);
            r.addProperty("cursor_recovered_note", "you polled without a cursor but this session has "
                + "polled before, so the stream resumed from where you left off (" + effective + ") "
                + "instead of jumping to the newest page — a cursor is usually lost to context "
                + "compaction, and tailing would have skipped everything in between while reporting "
                + "missed:0. Keep passing `cursor` from each reply.");
        }
        // Remember what this caller has now been served. Recorded even for an empty page: `nextCursor`
        // is then the caller's own position, which is exactly what a later cursorless poll needs.
        if (caller != null) {
            LAST_SERVED.put(caller, nextCursor);
        }
        r.add("events", arr);
        return r;
    }

    /**
     * The single delivery predicate — "would this caller be given this event?". Used for the page,
     * for the {@code missed} count and for the urgent preview, so those three can never disagree
     * about what belongs to whom (they used to: {@code missed} ignored every filter).
     */
    private static boolean delivers(final String type, final @Nullable String to,
                                    final @Nullable Set<String> types,
                                    final @Nullable Set<String> excludeTypes,
                                    final @Nullable String caller) {
        if (types != null && !types.contains(type)) {
            return false;
        }
        if (excludeTypes != null && excludeTypes.contains(type)) {
            return false;
        }
        return to == null || to.equals(caller); // targeted at someone else
    }

    /**
     * One event row. {@code time} is NOT written per event: it is wall-clock, every consumer in the
     * shim reads {@code game_tick} instead (grepped, 2026-08-01), and 40 events carried 840 bytes of
     * 13-digit epoch millis. The page carries one {@code now} instead — see {@link #query}.
     * {@code dimension} is written only when this event disagrees with the page's.
     */
    private static JsonObject toJson(final Entry e, final @Nullable String pageDimension) {
        JsonObject o = new JsonObject();
        o.addProperty("id", e.id());
        o.addProperty("game_tick", e.gameTick());
        o.addProperty("type", e.type());
        if (e.dimension() != null && !e.dimension().equals(pageDimension)) {
            o.addProperty("dimension", e.dimension());
        }
        o.add("data", e.data());
        return o;
    }
}
