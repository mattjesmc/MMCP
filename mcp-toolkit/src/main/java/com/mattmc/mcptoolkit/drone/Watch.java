package com.mattmc.mcptoolkit.drone;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.BlockTools;
import com.mattmc.mcptoolkit.EventLog;
import com.mattmc.mcptoolkit.ExecutionContext;
import com.mattmc.mcptoolkit.McpTools;
import com.mattmc.mcptoolkit.Mechanism;
import com.mattmc.mcptoolkit.Schemas;
import com.mattmc.mcptoolkit.ToolDef;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.state.BlockState;
import org.jspecify.annotations.Nullable;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.List;

/**
 * The <b>block watchlist</b> — a per-session subscription that turns the body's own sightlines into
 * {@code block_sighted} events (TODO.md §"The event stream cannot see the world").
 *
 * <p><b>The hole this fills.</b> The event vocabulary was entirely body-and-entity: what hurt you,
 * what walked near you, what your commands did. The world itself produced two types
 * ({@code weather_changed}, {@code time_of_day}), so a body could mine for an hour past a vein of
 * diamond and never be told — the ore WAS perceived (the ambient retina's fan hits it and
 * {@code capture} indexes it), but perception and notification never met. The agent found out only
 * by thinking to ask {@code locate}, which is the pull-shaped failure {@code annotate} was built to
 * fix for reads and which nothing fixed for the stream.
 *
 * <p><b>Why a subscription and not a block-change stream.</b> A generic "blocks changed" event would
 * be strictly worse than the dropped-item spam it would replace (TODO.md: thirty blocks of mining was
 * sixty events of the agent's own footsteps). And {@code get_events} filters by exact {@code type}
 * with no predicate over {@code data}, so a generic block event could not be narrowed client-side
 * either. The narrowing therefore has to be SERVER-SIDE and AGENT-AUTHORED: the agent declares what
 * it cares about, the mod reports first sighting. That ordering matters — this is emphatically not
 * an importance classifier (still on the don't-build list, TODO.md §"Not built, deliberately"); the
 * toolkit never decides that diamond matters. It only answers a question that was asked.
 *
 * <p><b>Legal by construction.</b> Sightings come from ray HITS — the first block each ray of
 * {@code raycast}/{@code raycast_fan} strikes — and nowhere else. Ore behind stone is not sighted,
 * because the ray stopped at the stone. There is no scan, no chunk sweep, no registry query over the
 * world: this adds no reach a body did not already have, it only wires an existing sense to the
 * stream. Under the survival profile the ambient retina fires that fan every 2s, so the watch runs
 * continuously without the agent doing anything; under other profiles it fires when something LOOKS
 * ({@code bot_scan}, a hand-called ray). Said plainly in the tool doc, because a watch that quietly
 * depends on an unrelated env var would be a listen filter that lies.
 *
 * <p>The vantage is whatever the CALLER aimed, not necessarily the caller's own body: a copilot that
 * casts a fan from a human player's eyes gets sightings from that vantage. That is the honest reading
 * of "what this call saw", and it cannot widen a legal session's reach, because the profile that
 * cares hides the whole ray family and leaves only the body-anchored retina.
 *
 * <p><b>Urgency is declared by the watcher.</b> {@code block_sighted} is not urgent as a type — a
 * priority that covers opportunity as well as injury prioritizes nothing ({@link
 * com.mattmc.mcptoolkit.EventTypes}). But sighting LAVA three blocks into a tunnel is danger, and
 * only the agent knows which of its watches mean that, so an entry may carry {@code urgent:true} and
 * its events then ride the danger preview. Agent-authored, per instance, no classifier.
 */
public final class Watch {
    private Watch() {}

    /** Watches per session. Small on purpose: this is a standing question list, not a database. */
    private static final int MAX_WATCHES = 16;
    /**
     * Positions an entry remembers for {@code once} de-duplication. Bounded because a body that
     * walks a long tunnel past one tag would otherwise grow this set forever; the oldest position is
     * evicted, so a re-sighting after 512 other sites re-fires. That is the harmless direction to be
     * wrong in — the agent is told about something it already knows, rather than not told at all.
     */
    private static final int MAX_SEEN = 512;

    /**
     * Total armed entries across every session, maintained on add/remove. {@link #sight} is called
     * once per ray hit inside {@code raycast_fan}'s inner loop — up to 64 per call, every 2s from
     * the retina — so the no-watches case must cost one volatile read and return.
     *
     * <p>A PERFORMANCE hint, never an authority: a reaped session's slot leaves this reading high
     * until the next mutation, which costs one map lookup that finds nothing. Nothing reads it to
     * decide whether an event should fire.
     */
    private static volatile int armed;

    /** One standing question: "tell me when I SEE this". */
    static final class Entry {
        final String id;
        final String spec;
        final BlockTools.Matcher matcher;
        /** Max distance from the eye, or -1 for "however far the ray reached". */
        final double within;
        final boolean once;
        final boolean urgent;
        /** Positions already reported, oldest first (see {@link #MAX_SEEN}). */
        private final LinkedHashSet<Long> seen = new LinkedHashSet<>();
        int sightings;
        /**
         * Sightings already delivered on an act reply. The counter is the thing sessions poll for —
         * 100 identical {@code bot_watch {action:"list"}} calls in w2-56123, all to read a number
         * that only changes when a ray hits — so the DELTA rides the next act instead
         * ({@code DroneTools.stampBodyState}). A watch is a standing attention primitive; making it
         * a thing you must ask about is the one shape it must never have.
         */
        int reported;

        Entry(final String id, final String spec, final BlockTools.Matcher matcher,
              final double within, final boolean once, final boolean urgent) {
            this.id = id;
            this.spec = spec;
            this.matcher = matcher;
            this.within = within;
            this.once = once;
            this.urgent = urgent;
        }

        /** True when this position is newly reported (false = already told you about it). */
        boolean remember(final BlockPos pos) {
            if (!seen.add(pos.asLong())) {
                return false;
            }
            if (seen.size() > MAX_SEEN) {
                Iterator<Long> it = seen.iterator();
                it.next();
                it.remove();
            }
            return true;
        }

        JsonObject describe() {
            JsonObject o = new JsonObject();
            o.addProperty("id", id);
            o.addProperty("block", spec);
            if (within >= 0) {
                o.addProperty("within", within);
            }
            o.addProperty("once", once);
            if (urgent) {
                o.addProperty("urgent", true);
            }
            o.addProperty("sightings", sightings);
            return o;
        }
    }

    // ---- the sighting hook ---------------------------------------------------

    /**
     * Offer one ray hit to the caller's watchlist, emitting {@code block_sighted} for every entry it
     * newly satisfies. Called from {@code raycast} and each ray of {@code raycast_fan}.
     *
     * <p>Never throws: a malformed watch must not be able to break the perception tool it rides on.
     * A watch that errors is dropped with a loud log rather than left to fail on every subsequent
     * ray (silent repetition in the server log is how a broken sense stays broken).
     */
    public static void sight(final @Nullable String session, final ServerLevel level,
                             final BlockState state, final BlockPos pos, final double distance,
                             final String by) {
        if (armed == 0) {
            return;
        }
        DroneTools.Slot slot = DroneTools.peekSlot(session);
        if (slot == null || slot.watches.isEmpty()) {
            return;
        }
        // Indexed, and any failure is collected rather than removed mid-iteration: this runs once
        // per ray hit (up to 64 per fan, every couple of seconds), so it allocates nothing in the
        // common case.
        List<Entry> broken = null;
        for (int i = 0; i < slot.watches.size(); i++) {
            Entry e = slot.watches.get(i);
            try {
                if (e.within >= 0 && distance > e.within) {
                    continue;
                }
                // Cheap state-level superset first, then vanilla's own predicate (the one that knows
                // about NBT) — the two-stage test BlockTools.Matcher exists to give.
                if (!e.matcher.prefilter(state) || !e.matcher.test(level, pos)) {
                    continue;
                }
                if (e.once && !e.remember(pos)) {
                    continue;
                }
                e.sightings++;
                emitSighting(slot, e, state, pos, distance, by);
            } catch (RuntimeException ex) {
                com.mattmc.mcptoolkit.McpToolkit.LOGGER.warn(
                    "[MCP Toolkit] watch '{}' failed while matching {} — dropping it", e.id, pos, ex);
                if (broken == null) {
                    broken = new ArrayList<>(1);
                }
                broken.add(e);
            }
        }
        if (broken != null) {
            slot.watches.removeAll(broken);
            recount();
        }
    }

    private static void emitSighting(final DroneTools.Slot slot, final Entry e,
                                     final BlockState state, final BlockPos pos,
                                     final double distance, final String by) {
        JsonObject d = new JsonObject();
        d.addProperty("watch_id", e.id);
        d.addProperty("watching", e.spec);
        // The concrete block, always — a tag watch (#minecraft:iron_ores) is answered with WHICH ore.
        d.addProperty("block", BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString());
        JsonObject p = new JsonObject();
        p.addProperty("x", pos.getX());
        p.addProperty("y", pos.getY());
        p.addProperty("z", pos.getZ());
        d.add("pos", p);
        d.addProperty("distance", Math.round(distance * 10.0) / 10.0);
        d.addProperty("sighted_by", by);
        if (e.urgent) {
            d.addProperty("urgent", true);
        }
        EventLog.emit("block_sighted", d, slot.target());
    }

    /** Recompute the fast-path counter after any mutation. */
    private static void recount() {
        int n = 0;
        for (DroneTools.Slot s : DroneTools.allSlots()) {
            n += s.watches.size();
        }
        armed = n;
    }

    /**
     * World boundary: positions are only meaningful in the world they were seen in, so a watch's
     * de-dup memory must not survive one. The ENTRIES survive (the standing question is still the
     * agent's question) — only what they have already reported is forgotten, so the first sighting
     * in the new world is reported as new. Called beside {@code EventLog.clearForWorldClose}.
     */
    public static void clearSeenForWorldClose() {
        for (DroneTools.Slot s : DroneTools.allSlots()) {
            for (Entry e : s.watches) {
                e.seen.clear();
            }
        }
    }

    // ---- tool ----------------------------------------------------------------

    public static void register() {
        McpTools.register(ToolDef.of(
            "bot_watch",
            "Standing orders for YOUR EYES: name blocks you want to be TOLD about, and every time a "
                + "sightline of yours lands on one you get a `block_sighted` event (poll get_events) "
                + "instead of having to go looking. This is how you notice ore while mining, or lava "
                + "before you break into it. `action`: add|remove|list|clear (default list). "
                + "add takes `watches`:[{id, block, within?, once?, urgent?}] and adds/replaces by id: "
                + "`block` is a block id or #tag (minecraft:diamond_ore, #c:ores, "
                + "minecraft:oak_log[axis=y]); `within` caps the sighting distance in blocks (default "
                + "any); `once` (default true) reports each POSITION once, not every glance; `urgent` "
                + "(default false) marks the sighting as danger so it rides the get_events urgent "
                + "preview — set it for lava, not for ore. remove takes `ids`. "
                + "WHAT IT SEES IS WHAT YOU SEE: sightings come only from ray hits, so ore behind "
                + "stone is not sighted, and the watch fires only when something looks. Under the "
                + "survival profile your ambient vision does that continuously; otherwise it fires "
                + "on bot_scan and hand-called rays.",
            Schemas.objectOpt(Schemas.object(
                "action", Schemas.str("add | remove | list | clear (default list)."),
                "watches", Schemas.array(Schemas.objectOpt(Schemas.object(
                    "id", Schemas.str("Unique watch id (re-adding the same id replaces it)."),
                    "block", Schemas.str("Block id, #tag, or id[state] to watch for."),
                    "within", Schemas.number("Max sighting distance in blocks (default any)."),
                    "once", Schemas.bool("Report each position once (default true)."),
                    "urgent", Schemas.bool("Treat sightings as danger (default false).")),
                    "within", "once", "urgent")),
                "ids", Schemas.array(Schemas.str("Watch id to remove."))),
                "action", "watches", "ids"),
            ExecutionContext.SERVER,
            // EMBODIED, like bot_reactions: this configures the body's standing attention, it does
            // not read the world. Nothing here can answer a question — only arrange to be told.
            Mechanism.EMBODIED,
            (ctx, a) -> handle(ctx.serverOrThrow(), a, DroneTools.slotFor(ctx.sessionId()))));
    }

    private static JsonObject handle(final MinecraftServer server, final JsonObject a,
                                     final DroneTools.Slot slot) {
        String action = a.has("action") && !a.get("action").isJsonNull()
            ? a.get("action").getAsString() : "list";
        JsonObject r = new JsonObject();
        switch (action) {
            case "add" -> {
                if (!a.has("watches") || !a.get("watches").isJsonArray()) {
                    throw new IllegalArgumentException(
                        "add needs `watches`:[{id, block, within?, once?, urgent?}]");
                }
                List<Entry> parsed = new ArrayList<>();
                for (JsonElement el : a.getAsJsonArray("watches")) {
                    parsed.add(parse(server, el));
                }
                // Check the resulting size BEFORE mutating: refuse the whole call rather than
                // half-arming it or silently evicting, because an evicted watch is a sense the
                // agent still believes it has.
                int resulting = slot.watches.size();
                for (Entry e : parsed) {
                    if (slot.watches.stream().noneMatch(w -> w.id.equals(e.id))) {
                        resulting++;
                    }
                }
                if (resulting > MAX_WATCHES) {
                    throw new IllegalArgumentException("that would arm " + resulting
                        + " watches, over the cap of " + MAX_WATCHES + " — remove some first, or "
                        + "watch one #tag instead of many ids");
                }
                for (Entry e : parsed) {
                    slot.watches.removeIf(w -> w.id.equals(e.id));
                    slot.watches.add(e);
                }
                recount();
                r.addProperty("ok", true);
                r.addProperty("added", parsed.size());
            }
            case "remove" -> {
                if (!a.has("ids") || !a.get("ids").isJsonArray()) {
                    throw new IllegalArgumentException("remove needs `ids`:[\"...\"]");
                }
                int before = slot.watches.size();
                for (JsonElement el : a.getAsJsonArray("ids")) {
                    String id = el.getAsString();
                    slot.watches.removeIf(w -> w.id.equals(id));
                }
                recount();
                r.addProperty("ok", true);
                r.addProperty("removed", before - slot.watches.size());
            }
            case "clear" -> {
                int n = slot.watches.size();
                slot.watches.clear();
                recount();
                r.addProperty("ok", true);
                r.addProperty("removed", n);
            }
            case "list" -> r.addProperty("ok", true);
            default -> throw new IllegalArgumentException(
                "unknown action '" + action + "' (add | remove | list | clear)");
        }
        JsonArray arr = new JsonArray();
        for (Entry e : slot.watches) {
            arr.add(e.describe());
        }
        r.add("watches", arr);
        if (slot.watches.isEmpty() && !"clear".equals(action)) {
            r.addProperty("note", "nothing is being watched — add {id, block} entries to be told "
                + "when you see something");
        }
        return r;
    }

    private static Entry parse(final MinecraftServer server, final JsonElement el) {
        if (!el.isJsonObject()) {
            throw new IllegalArgumentException("each watch must be an object {id, block, ...}");
        }
        JsonObject o = el.getAsJsonObject();
        String id = str(o, "id");
        if (id == null || id.isBlank()) {
            throw new IllegalArgumentException("each watch needs an `id`");
        }
        String spec = str(o, "block");
        if (spec == null || spec.isBlank()) {
            throw new IllegalArgumentException("watch '" + id + "' needs a `block` (id or #tag)");
        }
        BlockTools.Matcher matcher = matcher(server, spec);
        double within = o.has("within") && !o.get("within").isJsonNull()
            ? o.get("within").getAsDouble() : -1;
        if (o.has("within") && !o.get("within").isJsonNull() && within <= 0) {
            // A watch that can never match is the same failure as a reflex that can never fire.
            throw new IllegalArgumentException("watch '" + id + "' has within:" + within
                + ", which can never match — omit `within` for any distance");
        }
        boolean once = !o.has("once") || o.get("once").isJsonNull() || o.get("once").getAsBoolean();
        boolean urgent = o.has("urgent") && !o.get("urgent").isJsonNull()
            && o.get("urgent").getAsBoolean();
        return new Entry(id, spec, matcher, within, once, urgent);
    }

    /**
     * Parse a block spec into the toolkit's shared matcher. Shared with the {@code block_near} reflex
     * trigger ({@link Reflexes}) so the two layers can never disagree about what a spec means — the
     * same lesson {@code Hazards.CAUSES} taught when the danger sense could name causes the reflex
     * layer had no word for.
     */
    static BlockTools.Matcher matcher(final MinecraftServer server, final String spec) {
        return BlockTools.parseMatcher(
            server.registryAccess().lookupOrThrow(Registries.BLOCK), spec);
    }

    private static @Nullable String str(final JsonObject o, final String key) {
        return o.has(key) && !o.get(key).isJsonNull() ? o.get(key).getAsString() : null;
    }
}
