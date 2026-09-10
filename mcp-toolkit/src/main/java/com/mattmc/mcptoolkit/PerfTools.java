package com.mattmc.mcptoolkit;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.hooks.HookEvent;
import com.mattmc.mcptoolkit.mixin.LevelTickersAccessor;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.ServerTickRateManager;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.block.entity.TickingBlockEntity;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * {@code get_perf} - where the server's tick is going (RELEASE_1.md section D7).
 *
 * <p>Two readings, one call, because a modder chasing "did my block entity tank the server" needs
 * both to answer it:
 *
 * <ol>
 *   <li><b>The tick itself.</b> {@code mspt} over vanilla's own last-100-tick ring, plus the
 *       tick-rate state. The state is not decoration: {@code /tick freeze}, {@code /tick sprint}
 *       and a non-20 tickrate each make the milliseconds mean something else, and a number that
 *       silently means something else is this repo's succeeds-falsely class. So
 *       {@code runs_normally} rides beside every reading and a {@code note} says so in words.</li>
 *   <li><b>The census.</b> Per dimension: entities and TICKING block entities, their commonest
 *       types, and the chunks holding the most of each. This is what turns a millisecond into a
 *       place - a count with no coordinates cannot be gone and looked at.</li>
 * </ol>
 *
 * <p><b>{@code runs_normally} is computed from STATE, not from vanilla's own
 * {@code TickRateManager.runsNormally()}, and the difference is a tick.</b> That method returns the
 * cached {@code runGameElements} flag, which is only recomputed inside {@code TickRateManager.tick()}
 * - so for up to one tick after {@code /tick freeze} it still answers "normal" about a server that is
 * already frozen. The first live probe run caught exactly that: {@code frozen:true} and
 * {@code runs_normally:true} in the same reply. A summary that can contradict the fields beside it
 * is worse than no summary, so this one is {@code !frozen && !sprinting && tickrate == 20}.
 *
 * <p><b>There is no profile mode, and the reason is a fact about 26.2 worth carrying.</b> The
 * obvious build was to run vanilla's own tick profiler ({@code startTimeProfiler} /
 * {@code stopTimeProfiler}, what {@code /debug start} and {@code /debug stop} drive) for N ticks and
 * report the heaviest paths. It was built, and it returned nothing: in this version
 * {@code MinecraftServer.TimeProfiler.stop()} hands back a {@code ProfileResults} whose
 * {@code getTimes} is {@code Collections.emptyList()} unconditionally - {@code /debug} measures
 * DURATION and TICK COUNT (it reports an average tps) and collects no tree at all. The tree lives
 * behind {@code startRecordingMetrics}, which is a different act entirely: it writes a whole debug
 * report directory to disk and blocks the server thread to do it, so it is PRIVILEGED surface and
 * cannot ride inside an observe read. Recorded in RELEASE_1.md as the follow-on rather than
 * half-built here.
 *
 * <p>Even that follow-on could not answer the question the census answers, which is the second half
 * of the fact: {@code ServerLevel.tickNonPassenger} pushes a profiler section named after each
 * entity's registered type, but {@code tickBlockEntities} pushes nothing per ticker - the whole list
 * ticks inside one {@code blockEntities} section. So no profiler in this version can name the
 * expensive block entity TYPE. Counts and chunks can, and do.
 *
 * <p><b>Why its own entry and not a mode of {@code get_world_info}.</b> Finding 6b asks whether an
 * existing tool's question this already is. {@code get_world_info} answers <em>which world is
 * this</em> - identity, minted once and cached by callers - and it is served in every profile,
 * including the budgeted survival one. Perf is a different question, and folding it in would tax
 * every play/survey/survival turn for a read only a modder makes. As its own {@code DEV_ONLY} entry
 * it is paid by dev sessions and nobody else.
 */
public final class PerfTools {
    private PerfTools() {}

    /** Vanilla's ring is 100 ticks wide ({@code MinecraftServer.tickTimesNanos}). */
    private static final int RING = 100;
    private static final int DEFAULT_TOP = 5;
    private static final int MAX_TOP = 50;
    public static void register() {
        McpTools.register(ToolDef.of(
            "get_perf",
            "What the attached server is spending its tick on. `mspt` (mean/p50/p95/max over the "
                + "server's own last-100-tick ring) with the derived `tps`, and `tick_rate` - READ "
                + "THAT FIRST: a frozen, stepping or sprinting server makes every millisecond here "
                + "mean something else. Then per dimension the census: loaded and force-loaded "
                + "chunks, pending chunk tasks, block/fluid ticks, entities and TICKING block "
                + "entities, their commonest types, and the chunks holding the most of each - which "
                + "is how \"my block entity tanked the server\" becomes a place to go and stand. A "
                + "chest is a block entity and never a ticker; a hopper always is, and vanilla times "
                + "no block-entity type separately - so this census is what answers WHICH. The three "
                + "ranked lists are TOP-N and each carries its own `*_omitted` count: a type absent "
                + "from a truncated list is not a zero, so raise `top` before reading an absence.",
            Schemas.objectOpt(
                Schemas.object(
                    "dimension", Schemas.str("Census only this dimension (default: every loaded one)."),
                    "top", Schemas.integer("Entries per top-N list (default " + DEFAULT_TOP + ", max "
                        + MAX_TOP + ")."),
                    "hooks", Schemas.bool("Include the toolkit's OWN per-listener tick cost since "
                        + "boot - for ruling out the instrument before blaming the mod.")),
                "dimension", "top", "hooks"),
            ExecutionContext.SERVER,
            // OBSERVE, and it stays that way BECAUSE the profile mode was cut: everything here
            // reads a counter, a ring or a list. See the class note for what the profiler would
            // have cost - a debug report written to disk is not an observation.
            Mechanism.OBSERVE,
            (ctx, a) -> perf(ctx.serverOrThrow(), a)));
    }

    // ---- the read ------------------------------------------------------------

    private static JsonElement perf(final MinecraftServer server, final JsonObject a) {
        int top = clamp(intArg(a, "top", DEFAULT_TOP), 1, MAX_TOP);
        JsonObject r = new JsonObject();
        r.addProperty("game_tick", server.overworld().getGameTime());
        r.addProperty("players", server.getPlayerCount());
        r.add("mspt", mspt(server));
        r.add("tick_rate", tickRate(server));
        r.addProperty("tps", tps(server));

        String only = a.has("dimension") && !a.get("dimension").isJsonNull()
            ? a.get("dimension").getAsString() : null;
        JsonArray levels = new JsonArray();
        boolean matched = false;
        for (ServerLevel level : server.getAllLevels()) {
            String id = level.dimension().identifier().toString();
            if (only != null && !id.equals(only) && !id.equals("minecraft:" + only)) {
                continue;
            }
            matched = true;
            levels.add(census(level, id, top));
        }
        if (only != null && !matched) {
            // The dimension a caller names and the dimensions a server HAS are two different sets,
            // and an empty `levels` array would read as "nothing is loaded there" rather than as
            // "there is no such dimension". Refuse, and say what there is.
            StringBuilder have = new StringBuilder();
            for (ServerLevel level : server.getAllLevels()) {
                have.append(have.isEmpty() ? "" : ", ").append(level.dimension().identifier());
            }
            throw new IllegalArgumentException(
                "no loaded dimension '" + only + "' - this server has: " + have);
        }
        r.add("levels", levels);

        if (a.has("hooks") && !a.get("hooks").isJsonNull() && a.get("hooks").getAsBoolean()) {
            r.add("toolkit_hooks", HookEvent.statsJson());
        }

        return r;
    }

    /**
     * The mspt block, over the FILLED part of the ring only. Vanilla writes tick times into
     * {@code tickTimesNanos[tickCount % 100]}, so on a server younger than 100 ticks the rest of
     * the array is zeros - averaging over all 100 would report a server that just booted as
     * impossibly fast, and a p95 over zeros is not a percentile of anything.
     */
    private static JsonObject mspt(final MinecraftServer server) {
        long[] ring = server.getTickTimesNanos();
        int filled = Math.min(Math.max(server.getTickCount(), 0), RING);
        JsonObject o = new JsonObject();
        o.addProperty("samples", filled);
        if (filled == 0) {
            o.addProperty("note", "no ticks recorded yet");
            return o;
        }
        long[] s = Arrays.copyOf(ring, filled);
        Arrays.sort(s);
        double sum = 0;
        for (long v : s) {
            sum += v;
        }
        o.addProperty("mean", ms(sum / filled));
        o.addProperty("p50", ms(s[(int) (filled * 0.50)]));
        o.addProperty("p95", ms(s[Math.min(filled - 1, (int) (filled * 0.95))]));
        o.addProperty("max", ms(s[filled - 1]));
        return o;
    }

    /**
     * Tick-rate state, and the {@code note} is the point of it. Every number above is per-tick or
     * per-second, and all of them are quietly reinterpreted by a server that is frozen (ticks stop,
     * mspt collapses), sprinting (ticks run as fast as they can, tps is meaningless) or set to a
     * non-default rate. {@code /tick} is one command away from any dev world, so this is not an
     * exotic state to be in.
     */
    private static JsonObject tickRate(final MinecraftServer server) {
        ServerTickRateManager trm = server.tickRateManager();
        JsonObject o = new JsonObject();
        o.addProperty("target", trm.tickrate());
        o.addProperty("frozen", trm.isFrozen());
        o.addProperty("stepping", trm.isSteppingForward());
        o.addProperty("sprinting", trm.isSprinting());
        boolean normal = !trm.isFrozen() && !trm.isSprinting() && trm.tickrate() == 20.0F;
        o.addProperty("runs_normally", normal);
        if (!normal) {
            o.addProperty("note", "this server is not ticking normally (" + describe(trm)
                + "), so mspt and tps do not mean what they usually mean");
        }
        return o;
    }

    private static String describe(final ServerTickRateManager trm) {
        if (trm.isFrozen()) {
            return trm.isSteppingForward() ? "frozen, stepping" : "frozen";
        }
        if (trm.isSprinting()) {
            return "sprinting";
        }
        return "tickrate " + trm.tickrate();
    }

    /**
     * TPS, capped at the configured tick rate. A server finishing its ticks in 1 ms is not running
     * at 1000 tps - it is running at 20 and sleeping the rest, which is what the cap says out loud.
     */
    private static double tps(final MinecraftServer server) {
        double target = server.tickRateManager().tickrate();
        long meanNanos = server.getAverageTickTimeNanos();
        if (meanNanos <= 0) {
            return target;
        }
        double uncapped = 1_000_000_000.0 / meanNanos;
        return round(Math.min(target, uncapped), 2);
    }

    // ---- the census ----------------------------------------------------------

    private static JsonObject census(final ServerLevel level, final String id, final int top) {
        JsonObject o = new JsonObject();
        o.addProperty("dimension", id);
        o.addProperty("loaded_chunks", level.getChunkSource().getLoadedChunksCount());
        o.addProperty("forced_chunks", level.getChunkSource().getForceLoadedChunks().size());
        o.addProperty("pending_tasks", level.getChunkSource().getPendingTasksCount());
        o.addProperty("block_ticks", level.getBlockTicks().count());
        o.addProperty("fluid_ticks", level.getFluidTicks().count());

        Map<String, Integer> entityTypes = new HashMap<>();
        Map<Long, int[]> chunks = new HashMap<>();
        int entities = 0;
        for (Entity e : level.getAllEntities()) {
            entities++;
            entityTypes.merge(e.typeHolder().getRegisteredName(), 1, Integer::sum);
            chunks.computeIfAbsent(e.chunkPosition().pack(), k -> new int[2])[0]++;
        }
        o.addProperty("entities", entities);

        Map<String, Integer> beTypes = new HashMap<>();
        int tickers = 0;
        for (TickingBlockEntity t : ((LevelTickersAccessor) level).mcptoolkit$blockEntityTickers()) {
            if (t.isRemoved()) {
                continue; // vanilla drops these on its next pass; they are not tick cost
            }
            tickers++;
            beTypes.merge(t.getType(), 1, Integer::sum);
            chunks.computeIfAbsent(ChunkPos.pack(t.getPos()), k -> new int[2])[1]++;
        }
        o.addProperty("block_entity_tickers", tickers);
        o.add("entity_types", topTypes(entityTypes, top));
        // A TOP-N LIST THAT DOES NOT SAY IT IS ONE MAKES ABSENCE INDISTINGUISHABLE FROM ZERO, which
        // is the succeeds-falsely class this toolkit keeps finding in its own replies. It cost a
        // real red: probes/perf.test.mjs read its hopper baseline at the default top (5), the type
        // ranked sixth in that world, the probe's `?? 0` turned "below the cutoff" into "there are
        // none", and 131 pre-existing hoppers reported as the census miscounting six placed ones.
        // The counting was right and the reader could not have known. So every truncated list says
        // how many entries it left out, and says it ALWAYS rather than only when it truncated: a
        // field that appears only in the interesting case is one every caller forgets to handle.
        o.addProperty("entity_types_omitted", omitted(entityTypes.size(), top));
        o.add("block_entity_types", topTypes(beTypes, top));
        o.addProperty("block_entity_types_omitted", omitted(beTypes.size(), top));
        o.add("hot_chunks", hotChunks(chunks, top));
        o.addProperty("hot_chunks_omitted", omitted(chunks.size(), top));
        return o;
    }

    /** How many entries a top-N list left out. Never negative; a short list omits nothing. */
    private static int omitted(final int total, final int top) {
        return Math.max(0, total - top);
    }

    private static JsonArray topTypes(final Map<String, Integer> counts, final int top) {
        List<Map.Entry<String, Integer>> sorted = new ArrayList<>(counts.entrySet());
        sorted.sort(Map.Entry.<String, Integer>comparingByValue().reversed()
            .thenComparing(Map.Entry.comparingByKey()));
        JsonArray arr = new JsonArray();
        for (int i = 0; i < Math.min(top, sorted.size()); i++) {
            JsonObject o = new JsonObject();
            o.addProperty("id", sorted.get(i).getKey());
            o.addProperty("count", sorted.get(i).getValue());
            arr.add(o);
        }
        return arr;
    }

    /**
     * The chunks carrying the most tick load, ranked by entities + tickers together. Reported with
     * BLOCK coordinates beside the chunk pair, because the next thing a caller does with this is go
     * and look, and "chunk 41, -7" is not somewhere you can teleport to.
     */
    private static JsonArray hotChunks(final Map<Long, int[]> chunks, final int top) {
        List<Map.Entry<Long, int[]>> sorted = new ArrayList<>(chunks.entrySet());
        sorted.sort(Comparator.<Map.Entry<Long, int[]>>comparingInt(e -> -(e.getValue()[0] + e.getValue()[1]))
            .thenComparingLong(Map.Entry::getKey));
        JsonArray arr = new JsonArray();
        for (int i = 0; i < Math.min(top, sorted.size()); i++) {
            ChunkPos cp = ChunkPos.unpack(sorted.get(i).getKey());
            int[] v = sorted.get(i).getValue();
            JsonObject o = new JsonObject();
            o.addProperty("chunk_x", cp.x());
            o.addProperty("chunk_z", cp.z());
            o.addProperty("x", cp.getMiddleBlockX());
            o.addProperty("z", cp.getMiddleBlockZ());
            o.addProperty("entities", v[0]);
            o.addProperty("block_entity_tickers", v[1]);
            arr.add(o);
        }
        return arr;
    }

    // ---- helpers -------------------------------------------------------------

    private static double ms(final double nanos) {
        return round(nanos / 1_000_000.0, 3);
    }

    private static double round(final double v, final int places) {
        double f = Math.pow(10, places);
        return Math.round(v * f) / f;
    }

    private static int intArg(final JsonObject a, final String key, final int fallback) {
        return a.has(key) && !a.get(key).isJsonNull() ? a.get(key).getAsInt() : fallback;
    }

    private static int clamp(final int v, final int lo, final int hi) {
        return Math.max(lo, Math.min(hi, v));
    }
}
