package com.mattmc.mcptoolkit;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.hooks.ServerHooks;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.MinecraftServer;
import net.minecraft.util.Mth;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.shapes.CollisionContext;
import org.jspecify.annotations.Nullable;

import com.mattmc.mcptoolkit.ReadSupport.ChunkLoader;

import static com.mattmc.mcptoolkit.ReadSupport.clampToReadable;
import static com.mattmc.mcptoolkit.ReadSupport.coverage;
import static com.mattmc.mcptoolkit.ReadSupport.loadArg;
import static com.mattmc.mcptoolkit.ReadSupport.segmentChunksLoaded;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;

/**
 * Structured world perception for the copilot: symbolic reads of the world, arranged as a coarse-to-fine
 * "perception ladder" ({@code scene_summary} → {@code get_surface} / {@code get_entities} → {@code raycast})
 * instead of low-res screenshots. All tools run on the server thread ({@link ExecutionContext#SERVER}) over
 * the proven {@code supplyOn → server.execute} plumbing and import zero client types, so the group is
 * dedicated-server-safe by construction.
 *
 * <p><b>Perception mode.</b> These are authoritative server-state queries, not simulated eyesight:
 * {@code get_entities}, {@code get_surface} and {@code scene_summary} are <em>spatial</em> reads — a radius
 * query reports entities through walls, behind the observer and in darkness. Only {@code raycast} respects
 * occlusion. That omniscience is a copilot feature, but it must be labeled, never passed off as vision
 * (see ARCHITECTURE.md, "Perception modes"). Human-equivalent {@code visible}-mode enforcement
 * (FOV/occlusion/light) is deliberately NOT implemented; it is reserved for a future constrained
 * autonomous-player profile.
 *
 * <p><b>Key seam — {@link #resolveOrigin}.</b> Every perception tool asks this helper for a vantage point:
 * a level, an eye position and a view direction. Origins today: the active drone's eye ({@code drone:true}),
 * explicit coordinates, or a player's eyes. The precise claim: {@link Origin} decouples perception from the
 * <em>sensor location</em> only — it is an observation-origin seam, not an embodiment contract. It carries
 * no body, reach, inventory, capabilities or action authority; those belong to the separate actuator
 * contract ({@link com.mattmc.mcptoolkit.drone.Actuator}, driven by {@code DroneHands}) — see
 * ARCHITECTURE.md, "Origin is a sensor seam, not embodiment".
 */
public final class WorldPerceptionTools {
    private WorldPerceptionTools() {}

    /** Hard ceiling on raycast reach, so a stray {@code range} can't sweep the whole loaded world. */
    private static final double MAX_RANGE = 256.0;
    private static final double DEFAULT_RANGE = 32.0;

    /** get_entities defaults/caps: keep the search box and payload bounded. */
    private static final double DEFAULT_RADIUS = 32.0;
    private static final double MAX_RADIUS = 128.0;
    private static final int DEFAULT_LIMIT = 50;
    private static final int MAX_LIMIT = 200;

    /** get_surface surface-grid defaults/caps: grid is (2r+1)² columns, hard-capped in total. */
    private static final int DEFAULT_GRID = 16;
    private static final int MAX_GRID = 48;
    private static final int MAX_COLUMNS = 6000;
    /** detail:"full" output cap — keeps the serialized result inside the ~8KB response budget
     * (measured: ~26 bytes/column serialized; 280 columns ≈ 7.3KB with headroom). */
    private static final int FULL_MAX_COLUMNS = 280;
    /** detail:"summary": columns outside the top-N palette are the signal ("something built here"). */
    private static final int SUMMARY_TOP_PALETTE = 3;
    private static final int SUMMARY_MAX_ANOMALIES = 40;

    /** scene_summary sampling defaults. */
    private static final int SCENE_GRID = 12;
    private static final double SCENE_ENTITY_RADIUS = 24.0;

    public static void register() {
        // get_entities staged reads park here until the entity manager's async inbox delivers
        // (or the tick deadline passes); a stopping server fails them instead of leaving the
        // bridge's HTTP thread to ride out the dispatch timeout.
        ServerHooks.END_SERVER_TICK.register(WorldPerceptionTools::pumpPendingEntityReads);
        ServerHooks.SERVER_STOPPING.register(s -> {
            for (PendingEntityStage p : PENDING_ENTITY_STAGES) {
                p.future().completeExceptionally(
                    new IllegalStateException("server stopping before entity data arrived"));
            }
            PENDING_ENTITY_STAGES.clear();
        });

        McpTools.register(ToolDef.of(
            "scene_summary",
            "One high-level read of the situation at a vantage point — the top of the perception ladder. "
                + "Composes dimension, time of day, weather, light, sky exposure, a top-block histogram of the "
                + "surrounding terrain, and nearby-entity counts (spatial, not line-of-sight) into structured "
                + "JSON plus a one-line sentence. "
                + "Origin defaults to the (first) online player; override with `player` or explicit `origin`. "
                + "Use it first to orient, then raycast / get_entities / get_surface to drill in. "
                + "Already-generated chunks are paged in automatically, so this works at coordinates "
                + "nobody is standing near — no staging needed, and reading never generates terrain. "
                + "`origin_loaded` and top-level `coverage.state` qualify the whole read: if the vantage "
                + "point could NOT be made resident, the positional fields (biome, light, seesSky, "
                + "weather.rainingHere) are null — never generator defaults — and the `sentence` says "
                + "so up front.",
            Schemas.objectOpt(Schemas.object(
                "drone", Schemas.bool("If true, summarize from the active drone (spawn via bot_body first). Overrides player/origin."),
                "player", Schemas.str("Name of the player to center on. Defaults to the first online player."),
                "origin", Schemas.object("x", Schemas.number(), "y", Schemas.number(), "z", Schemas.number()),
                "load", Schemas.bool("Pull absent chunks in so they can be read. Default true; set false to report only what is already resident.")),
                "drone", "player", "origin", "load"),
            ExecutionContext.SERVER,
            Mechanism.OBSERVE,
            (ctx, a) -> sceneSummary(ctx.serverOrThrow(), a, ctx.sessionId())));

        McpTools.register(ToolDef.of(
            "get_surface",
            "Survey the top block of every column in a square grid around a vantage point — a coarse "
                + "terrain/surface map (\"what's the ground around me\"). Origin defaults to the (first) "
                + "online player; override with `player` or explicit `origin` {x,y,z}. `grid` is the "
                + "half-width in blocks (default 16 → 33×33 columns, capped at 48). `heightmap` selects "
                + "which surface: world_surface (default, top non-air incl. trees), motion_blocking, "
                + "motion_blocking_no_leaves, or ocean_floor (ignores water/leaves). Already-generated "
                + "chunks are paged in automatically within a bounded budget, so remote coordinates "
                + "read fine without staging; reading NEVER generates new terrain, and never-generated "
                + "chunks are reported rather than created. Palette entries carry `aff` affordance "
                + "flags (vocabulary: see get_blocks_at). detail:\"summary\" (default) "
                + "returns a palette histogram, height stats, and up to " + SUMMARY_MAX_ANOMALIES
                + " anomalous columns (blocks outside the top-" + SUMMARY_TOP_PALETTE
                + " palette — the \"something is built here\" signal), nearest first. detail:\"full\" "
                + "returns palette-indexed columns [x,y,z,paletteIndex], nearest first, capped at "
                + FULL_MAX_COLUMNS + " — prefer summary unless exact per-column geometry is needed. "
                + "Coordinates are for reading, not arithmetic: for geometry derived from them (distance, "
                + "fit, clearance, reachability) use a check_* predicate or compute in code. "
                + "covered_radius is the last ring read with no holes: conclusions like \"no X nearby\" are "
                + "only valid within covered_radius. ALWAYS check `coverage.state` first — complete | "
                + "partial | none. \"none\" means every column was in an unloaded chunk and the result "
                + "describes nothing at all; an empty palette then means \"not observed\", NOT \"nothing "
                + "there\".",
            getBlocksSchema(),
            ExecutionContext.SERVER,
            Mechanism.OBSERVE,
            (ctx, a) -> {
                // A heightmap read needs no y, but the shared origin resolver requires one — and
                // the observed failure (M5, 2026-07-26) was two errored calls that detoured a
                // session into a worse tool. Fill sea level in; it only anchors the vantage label.
                if (a.has("origin") && a.get("origin").isJsonObject()
                    && !a.getAsJsonObject("origin").has("y")) {
                    a.getAsJsonObject("origin").addProperty("y",
                        ctx.serverOrThrow().overworld().getSeaLevel());
                }
                return getBlocks(ctx.serverOrThrow(), a, ctx.sessionId());
            }));

        McpTools.register(ToolDef.of(
            "get_blocks_at",
            "Read the exact block at each of a list of coordinates — the point-query counterpart to "
                + "set_blocks, and the only tool that answers \"what is at (x,y,z)\". get_surface samples "
                + "the TOP block of each column (a heightmap) and describe_box describes a volume "
                + "statistically; neither can report a specific buried block. Each entry is {x,y,z} plus "
                + "an optional `expect`: when given, that position is tested against the world with the "
                + "same matcher /execute if block uses (bare id matches any state; id[state] requires "
                + "those properties; an {nbt} suffix is matched too), so verifying N placements is ONE "
                + "call returning matched/mismatches instead of N probes. Returns a shared `palette` of "
                + "id[state] strings — set_blocks syntax, so a read round-trips into a write — an "
                + "`affordances` array aligned with it (per palette entry, comma-joined flags: "
                + "solid|pass|air|water|lava first, then repl = placing overwrites it, hazard = "
                + "contact damage, tool = drops need the correct tool, unbreakable — answering "
                + "\"can I walk through / stand on / place into / mine it\" without a follow-up "
                + "read), plus rows "
                + "[x,y,z,paletteIndex] (+ a 1/0 match flag when `expect` was used; -1 in either slot "
                + "means the position could not be read, never a guess). detail:\"full\" adds "
                + "block-entity NBT. Already-generated chunks are paged in automatically; reading never "
                + "generates terrain. Max " + POINT_MAX + " positions per call. Reads the OVERWORLD "
                + "unless `dimension` says otherwise; the result stamps which dimension was read. "
                + "Coordinates are for reading, not arithmetic: for geometry derived from them (distance, "
                + "fit, clearance, reachability) use a check_* predicate or compute in code.",
            getBlocksAtSchema(),
            ExecutionContext.SERVER,
            Mechanism.OBSERVE,
            (ctx, a) -> getBlocksAt(ctx.serverOrThrow(), a)));

        McpTools.register(ToolDef.async(
            "get_entities",
            "List entities around a vantage point, nearest first — the world's \"who/what is near me\". "
                + "NOTE: this is a spatial radius query, not eyesight — it reports entities through walls, "
                + "behind the observer, and in darkness (perception mode: spatial; use raycast when "
                + "line-of-sight matters; each returned entity carries a line_of_sight flag; "
                + "detail:\"full\" adds uuid and velocity in blocks/tick). Each row carries "
                + "`distance`, `bearing` (8-point compass from the origin; N = -z) and `dy` "
                + "(entity minus origin height) — use these instead of deriving direction from "
                + "coordinates. "
                + "Origin defaults to the (first) online player; override with `player` or explicit `origin` "
                + "{x,y,z}. Filter with `type` (exact entity id like minecraft:zombie) or `category` "
                + "(player|living|hostile|item). Returns a distance-sorted, capped list; reports total found "
                + "vs returned when the cap truncates. Works at remote coordinates without staging: absent "
                + "chunks in the radius are paged in automatically (never generating terrain) and the call "
                + "waits the extra tick(s) entity data needs to arrive through the entity manager's async "
                + "inbox. coverage counts CHUNKS in the search radius; chunks that stayed unread "
                + "(never-generated terrain, the paging budget, load:false, or entity data still arriving "
                + "at the wait deadline) make the state partial — or \"none\" with `total` null when "
                + "nothing was searchable — and entities there are invisible to this query: absence is "
                + "not evidence of absence. FRESHNESS: a paged-in chunk is loaded but NOT ticking, so its "
                + "entities are frozen at their as-saved state — such rows carry ticking:false (absent "
                + "means live). Reading never makes an area tick; if you need it actually running "
                + "(mobs acting, timers advancing), forceload via run_command (audited).",
            getEntitiesSchema(),
            ExecutionContext.SERVER,
            Mechanism.OBSERVE,
            (ctx, a) -> getEntitiesStaged(ctx.serverOrThrow(), a, ctx.sessionId())));

        McpTools.register(ToolDef.of(
            "raycast",
            "Cast a ray from a vantage point and report the first block or entity it hits — the world's "
                + "equivalent of \"what am I looking at\", and the only occlusion-respecting perception read "
                + "(an entity behind a wall is not reported). Origin defaults to the (first) online player's "
                + "eyes and facing; override with `player` (name), or with explicit `origin` {x,y,z} plus "
                + "`yaw`/`pitch` (degrees) or a `direction` {x,y,z} vector. Returns hit=block|entity|miss "
                + "with distance, the hit point, and either the block id/pos/face or the entity type/name/health "
                + "(an entity hit carries ticking:false when its chunk is loaded but not entity-ticking — "
                + "the entity is frozen at its as-saved state). "
                + "A ray that reaches an unreadable chunk (never-generated terrain, or the paging budget) "
                + "stops there and reports hit=unread with `range_covered` — beyond that point is unread, "
                + "not empty; reading never generates terrain. "
                + "For sweeping a whole area, prefer ONE raycast_fan call over many raycast calls.",
            raycastSchema(),
            ExecutionContext.SERVER,
            Mechanism.OBSERVE,
            (ctx, a) -> raycast(ctx.serverOrThrow(), a, ctx.sessionId())));

        McpTools.register(ToolDef.of(
            "raycast_fan",
            "Cast a fan of rays from one vantage point in a single call — the cheap way to sweep-look at "
                + "a scene (one call replaces a burst of raycast calls). Same origin resolution as raycast "
                + "(drone/player/origin + yaw/pitch/direction for the CENTER of the fan). `h_fov`/`v_fov` "
                + "degrees (default 90/0) spread `steps_h`×`steps_v` rays (default 9×1, max 64 total) "
                + "evenly around the center direction. Returns compact rows [dyaw, dpitch, kind, id, "
                + "distance, x, y, z] (kind b=block e=entity m=miss, or u=unread when the ray stopped at "
                + "an unreadable chunk after the given distance — unread is not empty; id is the "
                + "block/entity id; x,y,z is the block pos or entity pos) plus a `hits` histogram of what "
                + "the fan saw. Occlusion-respecting like raycast.",
            raycastFanSchema(),
            ExecutionContext.SERVER,
            Mechanism.OBSERVE,
            (ctx, a) -> raycastFan(ctx.serverOrThrow(), a, ctx.sessionId())));

        McpTools.register(ToolDef.of(
            "describe_box",
            "Survey a bounded block volume in one call and return a DESCRIPTION, not a block dump — "
                + "material histogram with per-material bounding boxes, the non-air bounding box, a per-"
                + "layer solid-block profile, and shell air counts (openings signal: windows/doors read as "
                + "air on an otherwise solid face). This is the structure-survey tool: one describe_box "
                + "replaces a raycast fan + get_surface dance when studying a building or cavity. `min`/"
                + "`max` corners inclusive, volume capped at " + SCAN_MAX_VOLUME + " blocks. Never loads "
                + "chunks — already-generated ones are paged in automatically within a bounded budget, "
                + "and reading never generates new terrain; check `coverage.state` (complete | partial "
                + "| none) before trusting the histogram, since \"none\" means nothing was read and an "
                + "empty result is not an empty box. Reads the OVERWORLD unless `dimension` says "
                + "otherwise; the result stamps which dimension was read. detail:\"layers\" adds exact geometry "
                + "as per-y text slices ('.'=air) for SMALL boxes, keyed by a `legend` of one character per "
                + "block STATE in set_blocks syntax — hand that legend and those slices straight back to "
                + "set_blocks with a `min` to edit what is here; use summary (default) "
                + "first and layers only on the sub-box you actually need.",
            scanBoxSchema(),
            ExecutionContext.SERVER,
            Mechanism.OBSERVE,
            (ctx, a) -> scanBox(ctx.serverOrThrow(), a)));
    }

    private static JsonObject raycastSchema() {
        // Everything is optional: with no args at all, raycast uses the first player's eyes.
        JsonObject base = Schemas.object(
            "drone", Schemas.bool("If true, cast from the active drone's eye (spawn via bot_body first). Overrides player/origin."),
            "player", Schemas.str("Name of the player whose eyes/facing to cast from. Defaults to the first online player."),
            "origin", Schemas.object("x", Schemas.number(), "y", Schemas.number(), "z", Schemas.number()),
            "yaw", Schemas.number("Facing yaw in degrees (Minecraft convention: 0=south, -90=east). Used with `origin`, or to override a player's facing."),
            "pitch", Schemas.number("Facing pitch in degrees (-90=straight up, 90=straight down)."),
            "direction", Schemas.object("x", Schemas.number(), "y", Schemas.number(), "z", Schemas.number()),
            "range", Schemas.number("How far to cast, in blocks. Default 32, capped at 256."),
            "fluids", Schemas.bool("If true, fluids (water/lava) count as blocking hits. Default false."),
            "load", Schemas.bool("Pull absent chunks in so the ray can cross them. Default true; set false "
                + "to read only what is already resident."));
        return Schemas.objectOpt(base, "drone", "player", "origin", "yaw", "pitch", "direction", "range", "fluids", "load");
    }

    private static JsonObject getEntitiesSchema() {
        JsonObject base = Schemas.object(
            "drone", Schemas.bool("If true, center on the active drone (spawn via bot_body first). Overrides player/origin."),
            "player", Schemas.str("Name of the player to center on. Defaults to the first online player."),
            "origin", Schemas.object("x", Schemas.number(), "y", Schemas.number(), "z", Schemas.number()),
            "radius", Schemas.number("Search radius in blocks. Default 32, capped at 128."),
            "type", Schemas.str("Exact entity type id to match, e.g. minecraft:zombie. Mutually exclusive with `category`."),
            "category", Schemas.str("Coarse filter: player | living | hostile | item. Mutually exclusive with `type`."),
            "limit", Schemas.integer("Max entities to return (nearest first). Default 50, capped at 200."),
            "detail", Schemas.str("compact (default: id/type/name/pos/health) | full (adds uuid, velocity, speed)."),
            "load", Schemas.bool("Pull absent chunks in (and wait the tick their entity data needs to "
                + "arrive) so they can be searched. Default true; set false to search only chunks whose "
                + "entity data is already loaded."));
        return Schemas.objectOpt(base, "drone", "player", "origin", "radius", "type", "category", "limit", "detail", "load");
    }

    // ---- scene_summary -------------------------------------------------------

    private static JsonObject sceneSummary(final MinecraftServer server, final JsonObject a, final @Nullable String session) {
        Origin origin = resolveOrigin(a, server, session);
        ServerLevel level = origin.level();
        Vec3 eye = origin.eye();
        BlockPos pos = BlockPos.containing(eye);
        net.minecraft.world.level.dimension.DimensionType dim = level.dimensionType();
        boolean hasSky = dim.hasSkyLight();

        // Pull the vantage point in before reading anything from it: biome, light and sky exposure
        // are all generator defaults until the chunk is actually resident, so this has to happen
        // ahead of every read below, not alongside the surface histogram.
        ChunkLoader loader = new ChunkLoader(level, loadArg(a));
        boolean originLoaded = loader.ensure(pos);

        JsonObject r = new JsonObject();
        r.addProperty("source", origin.label());
        addEnvelope(r, level, "spatial");
        addVec(r, "origin", eye);
        addPos(r, "block", pos);

        // Dimension + biome. The envelope already stamped `dimension` as the plain id string every
        // other tool sends — the old {id,hasSkyLight,hasCeiling} object OVERWROTE it into the one
        // divergent shape on the whole surface (conformance flagged it). The extra dimension facts
        // ride under `dimension_info` instead.
        JsonObject dimInfo = new JsonObject();
        dimInfo.addProperty("hasSkyLight", hasSky);
        dimInfo.addProperty("hasCeiling", dim.hasCeiling());
        r.add("dimension_info", dimInfo);
        // Positional readings below (biome, light, sky, rain-here) are generator defaults when the
        // vantage point could not be made resident — the JSON fields go null over unread space (the
        // predicate rule); the sentence keeps the readable description behind its [UNOBSERVED] flag.
        String biome = level.getBiome(pos).getRegisteredName();
        r.addProperty("biome", originLoaded ? biome : null);

        // Time of day (only meaningful where a sky clock runs).
        long tod = ((level.getDefaultClockTime() % 24000L) + 24000L) % 24000L;
        String timeLabel = timeLabel(tod);
        JsonObject time = new JsonObject();
        time.addProperty("timeOfDay", tod);
        time.addProperty("label", timeLabel);
        r.add("time", time);

        // Weather. raining/thundering are world-global facts; rainingHere is positional and goes
        // null when the vantage point was never resident.
        JsonObject weather = new JsonObject();
        boolean raining = level.isRaining();
        boolean thundering = level.isThundering();
        weather.addProperty("raining", raining);
        weather.addProperty("thundering", thundering);
        if (originLoaded) {
            weather.addProperty("rainingHere", level.isRainingAt(pos));
        } else {
            weather.add("rainingHere", null);
        }
        r.add("weather", weather);

        // Light + sky exposure — positional: explicit nulls over an unloaded vantage point instead
        // of confident generator defaults (a JSON consumer used to get "light 15, sees sky" for a
        // place nobody observed).
        boolean seesSky = level.canSeeSky(pos);
        if (originLoaded) {
            JsonObject light = new JsonObject();
            light.addProperty("sky", level.getBrightness(net.minecraft.world.level.LightLayer.SKY, pos));
            light.addProperty("block", level.getBrightness(net.minecraft.world.level.LightLayer.BLOCK, pos));
            light.addProperty("effective", level.getMaxLocalRawBrightness(pos));
            r.add("light", light);
            r.addProperty("seesSky", seesSky);
        } else {
            r.add("light", null);
            r.add("seesSky", null);
        }

        // Surface histogram (top blocks in a small grid), sharing the vantage point's load budget.
        // Its coverage is the read's overall coverage and sits TOP-LEVEL like every other spatial
        // tool (it lived under surface.coverage — the other conformance-flagged divergence).
        JsonObject surface = surfaceHistogram(level, pos.getX(), pos.getZ(), SCENE_GRID, loader);
        JsonObject cov = surface.remove("coverage").getAsJsonObject();
        r.add("coverage", cov);
        r.add("surface", surface);

        // Whether the vantage point itself could be made resident. When it could not, the biome/
        // light/sky readings are null above — the single most important qualifier on this whole
        // result, so it rides in the sentence too.
        r.addProperty("origin_loaded", originLoaded);

        // Nearby-entity counts, bucketed.
        JsonObject entities = entityCounts(level, origin.source(), eye, SCENE_ENTITY_RADIUS);
        r.add("entities", entities);

        // One-line sentence — reads the positional values directly (they may be null in the JSON;
        // behind the [UNOBSERVED] flag the prose keeps describing what the generator would say).
        r.addProperty("sentence", sentence(biome, pos, seesSky, hasSky, timeLabel, raining, thundering,
            level.getMaxLocalRawBrightness(pos), entities, originLoaded, cov));
        return r;
    }

    /** Package-visible: {@link WorldEvents} reuses the same labeling for time_of_day transition events. */
    static String timeLabel(final long tod) {
        // Vanilla milestones: 12000 sunset begins, 13000 night/monster-spawn, 23000 sunrise begins.
        if (tod < 1000 || tod >= 23000) return "dawn";
        if (tod < 12000) return "day";
        if (tod < 13000) return "dusk";
        return "night";
    }

    /** Top-block histogram over a (2·grid+1)² column grid, honoring the never-force-load rule. */
    private static JsonObject surfaceHistogram(final ServerLevel level, final int cx, final int cz,
                                               final int grid, final ChunkLoader loader) {
        var counts = new java.util.HashMap<String, Integer>();
        int columns = 0;
        int unloaded = 0;
        BlockPos.MutableBlockPos probe = new BlockPos.MutableBlockPos();
        var hm = net.minecraft.world.level.levelgen.Heightmap.Types.WORLD_SURFACE;
        for (int x = cx - grid; x <= cx + grid; x++) {
            for (int z = cz - grid; z <= cz + grid; z++) {
                if (!loader.ensure(probe.set(x, level.getSeaLevel(), z))) {
                    unloaded++;
                    continue;
                }
                int topY = level.getHeight(hm, x, z) - 1;
                BlockState st = level.getBlockState(probe.set(x, topY, z));
                String name = BuiltInRegistries.BLOCK.getKey(st.getBlock()).toString();
                counts.merge(name, 1, Integer::sum);
                columns++;
            }
        }
        JsonObject out = new JsonObject();
        out.addProperty("columns", columns);
        out.addProperty("unloaded", unloaded);
        out.add("coverage", coverage(columns, unloaded, columns + unloaded, false, loader));
        com.google.gson.JsonArray top = new com.google.gson.JsonArray();
        counts.entrySet().stream()
            .sorted((p, q) -> q.getValue() - p.getValue())
            .limit(5)
            .forEach(e -> {
                JsonObject o = new JsonObject();
                o.addProperty("block", e.getKey());
                o.addProperty("count", e.getValue());
                top.add(o);
            });
        out.add("top", top);
        return out;
    }

    /** Bucket entities within {@code radius} into players / hostile / passive / item / other. */
    private static JsonObject entityCounts(final ServerLevel level, final @Nullable Entity except,
                                           final Vec3 center, final double radius) {
        AABB box = new AABB(center, center).inflate(radius);
        double r2 = radius * radius;
        List<Entity> ents = level.getEntities(except, box,
            e -> e.isAlive() && e.position().distanceToSqr(center) <= r2);
        int players = 0, hostile = 0, passive = 0, items = 0, other = 0;
        Entity nearestHostile = null;
        double nearestHostileD2 = Double.MAX_VALUE;
        for (Entity e : ents) {
            if (e instanceof Player) {
                players++;
            } else if (e instanceof Enemy) {
                hostile++;
                double d2 = e.position().distanceToSqr(center);
                if (d2 < nearestHostileD2) { nearestHostileD2 = d2; nearestHostile = e; }
            } else if (e instanceof ItemEntity) {
                items++;
            } else if (e instanceof LivingEntity) {
                passive++;
            } else {
                other++;
            }
        }
        JsonObject o = new JsonObject();
        o.addProperty("radius", round3(radius)); // echoed rounded like every other envelope number
        // Residency annotation (same blind spot get_entities had): the AABB query only sees chunks
        // whose entity data is loaded, so the counts are lower bounds when any chunk is unsearched.
        // scene_summary stays a one-tick snapshot — it annotates instead of paging and waiting;
        // get_entities is the tool that stages absent chunks in.
        int minCx = ((int) Math.floor(box.minX)) >> 4;
        int maxCx = ((int) Math.floor(box.maxX)) >> 4;
        int minCz = ((int) Math.floor(box.minZ)) >> 4;
        int maxCz = ((int) Math.floor(box.maxZ)) >> 4;
        int chunksRequested = 0;
        int chunksSearched = 0;
        for (int ccx = minCx; ccx <= maxCx; ccx++) {
            for (int ccz = minCz; ccz <= maxCz; ccz++) {
                chunksRequested++;
                if (level.areEntitiesLoaded(net.minecraft.world.level.ChunkPos.pack(ccx, ccz))) {
                    chunksSearched++;
                }
            }
        }
        o.addProperty("searched_chunks", chunksSearched);
        o.addProperty("unsearched_chunks", chunksRequested - chunksSearched);
        o.addProperty("total", ents.size());
        o.addProperty("players", players);
        o.addProperty("hostile", hostile);
        o.addProperty("passive", passive);
        o.addProperty("items", items);
        o.addProperty("other", other);
        if (nearestHostile != null) {
            JsonObject nh = new JsonObject();
            nh.addProperty("type", BuiltInRegistries.ENTITY_TYPE.getKey(nearestHostile.getType()).toString());
            nh.addProperty("distance", round3(Math.sqrt(nearestHostileD2)));
            String bearing = Affordances.bearing(nearestHostile.getX() - center.x,
                nearestHostile.getZ() - center.z);
            if (bearing != null) {
                nh.addProperty("bearing", bearing);
            }
            o.add("nearestHostile", nh);
        }
        return o;
    }

    private static String sentence(final String biome, final BlockPos pos, final boolean seesSky,
                                   final boolean hasSky, final String timeLabel, final boolean raining,
                                   final boolean thundering, final int light, final JsonObject entities,
                                   final boolean originLoaded, final JsonObject surfaceCoverage) {
        StringBuilder sb = new StringBuilder();
        // Lead with the caveat, not bury it: an unloaded vantage point produces a fully confident-
        // sounding scene ("In ocean, out under open sky, day") that describes nothing observed.
        String cov = surfaceCoverage.get("state").getAsString();
        if (!originLoaded || "none".equals(cov)) {
            sb.append("[UNOBSERVED — this location is not loaded; readings below are generator defaults, "
                + "not world state. Load the area and re-read before concluding anything.] ");
        } else if ("partial".equals(cov)) {
            sb.append("[PARTIAL — ").append(surfaceCoverage.get("unloaded").getAsInt())
              .append(" of ").append(surfaceCoverage.get("requested").getAsInt())
              .append(" surrounding columns are unloaded and unread.] ");
        }
        sb.append("In ").append(biome)
          .append(" at ").append(pos.getX()).append(",").append(pos.getY()).append(",").append(pos.getZ())
          .append(seesSky ? ", out under open sky" : ", enclosed/underground");
        if (hasSky) {
            sb.append(", ").append(timeLabel);
            if (thundering) sb.append(", thunderstorm");
            else if (raining) sb.append(", raining");
        }
        sb.append(" (light ").append(light).append(").");
        int hostile = entities.get("hostile").getAsInt();
        int passive = entities.get("passive").getAsInt();
        int players = entities.get("players").getAsInt();
        sb.append(" Nearby: ").append(hostile).append(" hostile, ")
          .append(passive).append(" passive, ").append(players).append(" players");
        int unsearched = entities.get("unsearched_chunks").getAsInt();
        if (unsearched > 0) {
            sb.append(" (entity counts cover ").append(entities.get("searched_chunks").getAsInt())
              .append(" of ").append(entities.get("searched_chunks").getAsInt() + unsearched)
              .append(" nearby chunks — the rest have no entity data loaded; counts are lower bounds)");
        }
        sb.append(".");
        if (entities.has("nearestHostile")) {
            JsonObject nh = entities.getAsJsonObject("nearestHostile");
            sb.append(" Closest threat: ").append(nh.get("type").getAsString())
              .append(" ").append(String.format(java.util.Locale.ROOT, "%.1f", nh.get("distance").getAsDouble()))
              .append("m.");
        }
        return sb.toString();
    }

    // ---- get_surface (surface grid) -------------------------------------------

    private static JsonObject getBlocksSchema() {
        JsonObject base = Schemas.object(
            "drone", Schemas.bool("If true, center on the active drone (spawn via bot_body first). Overrides player/origin."),
            "player", Schemas.str("Name of the player to center on. Defaults to the first online player."),
            "origin", Schemas.objectOpt(Schemas.object(
                "x", Schemas.number("The CENTRE of the sampled square (grid is its half-width)."),
                "y", Schemas.number("Optional — a heightmap read needs no y."),
                "z", Schemas.number("The CENTRE of the sampled square.")), "y"),
            "grid", Schemas.integer("Half-width of the sampled square, in blocks. Default 16, capped at 48."),
            "heightmap", Schemas.str("Which surface to sample: world_surface | motion_blocking | motion_blocking_no_leaves | ocean_floor. Default world_surface."),
            "detail", Schemas.str("summary (default: palette histogram + height stats + anomalous columns) | full (palette-indexed per-column data, capped)."),
            "load", Schemas.bool("Pull absent chunks in so they can be read. Default true; set false to report only what is already resident."));
        return Schemas.objectOpt(base, "drone", "player", "origin", "grid", "heightmap", "detail", "load");
    }

    private record Column(int x, int y, int z, String block) {}

    private static JsonObject getBlocks(final MinecraftServer server, final JsonObject a, final @Nullable String session) {
        Origin origin = resolveOrigin(a, server, session);
        ServerLevel level = origin.level();
        Vec3 c = origin.eye();
        int cx = (int) Math.floor(c.x);
        int cz = (int) Math.floor(c.z);
        int grid = clampGrid(a);
        boolean full = "full".equals(detail(a, "summary", "full"));
        net.minecraft.world.level.levelgen.Heightmap.Types hm = heightmapType(a);
        // Summary always samples the whole grid (cheap server-side); full caps to the response budget.
        int cap = full ? FULL_MAX_COLUMNS : MAX_COLUMNS;

        JsonObject r = new JsonObject();
        addVec(r, "origin", c);
        r.addProperty("source", origin.label());
        addEnvelope(r, level, "spatial");
        r.addProperty("grid", grid);
        r.addProperty("heightmap", hm.name().toLowerCase(java.util.Locale.ROOT));
        r.addProperty("detail", full ? "full" : "summary");

        List<Column> cols = new ArrayList<>();
        // Affordance flags per palette id, from the first actually-observed state — O(palette).
        java.util.HashMap<String, String> aff = new java.util.HashMap<>();
        int unloaded = 0;
        boolean truncated = false;
        // The last ring fully READ — the honest extent of this read. "No X within covered_radius" is a
        // valid conclusion; "no X within grid" is not (false-negative hazard). A ring that lost columns
        // to unloaded chunks was NOT fully read, so it must not extend covered_radius: an all-unloaded
        // grid used to report covered_radius == grid alongside zero columns, i.e. "I surveyed this and
        // found nothing" about an area it never looked at.
        int coveredRadius = -1;
        boolean stillComplete = true;
        ChunkLoader loader = new ChunkLoader(level, loadArg(a));
        BlockPos.MutableBlockPos probe = new BlockPos.MutableBlockPos();
        // Walk columns in rings out from the center so a truncated result keeps the nearest data.
        outer:
        for (int ring = 0; ring <= grid; ring++) {
            boolean ringComplete = true;
            for (int dx = -ring; dx <= ring; dx++) {
                for (int dz = -ring; dz <= ring; dz++) {
                    if (Math.max(Math.abs(dx), Math.abs(dz)) != ring) {
                        continue; // only the perimeter of this ring
                    }
                    int x = cx + dx;
                    int z = cz + dz;
                    probe.set(x, level.getSeaLevel(), z);
                    if (!loader.ensure(probe)) {
                        unloaded++;
                        ringComplete = false;
                        continue;
                    }
                    if (cols.size() >= cap) {
                        truncated = true;
                        break outer;
                    }
                    int topY = level.getHeight(hm, x, z) - 1;
                    BlockState state = level.getBlockState(probe.set(x, topY, z));
                    String id = BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
                    aff.putIfAbsent(id, Affordances.flags(state));
                    cols.add(new Column(x, topY, z, id));
                }
            }
            // Outer rings are still sampled (a loaded island past an unloaded gap is real data), but
            // covered_radius stops at the last ring with no holes in it.
            if (ringComplete && stillComplete) {
                coveredRadius = ring;
            } else {
                stillComplete = false;
            }
        }
        r.addProperty("columns", cols.size());
        r.addProperty("covered_radius", coveredRadius);
        r.addProperty("unloaded", unloaded);
        r.addProperty("truncated", truncated);
        r.add("coverage",
            coverage(cols.size(), unloaded, (2 * grid + 1) * (2 * grid + 1), truncated, loader));

        // Shared palette: block id → count, ordered by frequency.
        java.util.LinkedHashMap<String, Integer> counts = new java.util.LinkedHashMap<>();
        for (Column col : cols) {
            counts.merge(col.block(), 1, Integer::sum);
        }
        List<Map.Entry<String, Integer>> byFreq = new ArrayList<>(counts.entrySet());
        byFreq.sort((p, q) -> q.getValue() - p.getValue());

        if (full) {
            // palette + [x,y,z,paletteIndex] rows — exact geometry inside the budget.
            java.util.LinkedHashMap<String, Integer> index = new java.util.LinkedHashMap<>();
            com.google.gson.JsonArray palette = new com.google.gson.JsonArray();
            com.google.gson.JsonArray affArr = new com.google.gson.JsonArray();
            for (Map.Entry<String, Integer> e : byFreq) {
                index.put(e.getKey(), palette.size());
                palette.add(e.getKey());
                affArr.add(aff.get(e.getKey()));
            }
            r.add("affordances", affArr);
            com.google.gson.JsonArray arr = new com.google.gson.JsonArray();
            for (Column col : cols) {
                com.google.gson.JsonArray row = new com.google.gson.JsonArray();
                row.add(col.x());
                row.add(col.y());
                row.add(col.z());
                row.add(index.get(col.block()));
                arr.add(row);
            }
            r.add("palette", palette);
            r.add("blocks", arr);
            return r;
        }

        // Summary: histogram + height stats + anomalies (nearest-first, since cols is ring-ordered).
        com.google.gson.JsonArray palette = new com.google.gson.JsonArray();
        for (Map.Entry<String, Integer> e : byFreq) {
            JsonObject o = new JsonObject();
            o.addProperty("block", e.getKey());
            o.addProperty("count", e.getValue());
            o.addProperty("aff", aff.get(e.getKey()));
            palette.add(o);
        }
        r.add("palette", palette);

        if (!cols.isEmpty()) {
            int minY = Integer.MAX_VALUE;
            int maxY = Integer.MIN_VALUE;
            long sumY = 0;
            for (Column col : cols) {
                minY = Math.min(minY, col.y());
                maxY = Math.max(maxY, col.y());
                sumY += col.y();
            }
            JsonObject heights = new JsonObject();
            heights.addProperty("min", minY);
            heights.addProperty("max", maxY);
            heights.addProperty("mean", Math.round((double) sumY / cols.size() * 10.0) / 10.0);
            r.add("heights", heights);
        }

        var common = new java.util.HashSet<String>();
        for (int i = 0; i < byFreq.size() && i < SUMMARY_TOP_PALETTE; i++) {
            common.add(byFreq.get(i).getKey());
        }
        com.google.gson.JsonArray anomalies = new com.google.gson.JsonArray();
        int anomaliesTotal = 0;
        for (Column col : cols) {
            if (common.contains(col.block())) {
                continue;
            }
            anomaliesTotal++;
            if (anomalies.size() < SUMMARY_MAX_ANOMALIES) {
                JsonObject b = new JsonObject();
                b.addProperty("x", col.x());
                b.addProperty("y", col.y());
                b.addProperty("z", col.z());
                b.addProperty("block", col.block());
                anomalies.add(b);
            }
        }
        r.addProperty("anomalies_total", anomaliesTotal);
        r.add("anomalies", anomalies);
        return r;
    }

    // ---- get_blocks_at (exact point reads) -----------------------------------

    /** Positions one call may read; keeps the response inside the 8KB result budget. */
    private static final int POINT_MAX = 256;
    private static final int POINT_MAX_MISMATCHES = 40;

    private static JsonObject getBlocksAtSchema() {
        JsonObject entry = Schemas.objectOpt(Schemas.object(
            "x", Schemas.integer(), "y", Schemas.integer(), "z", Schemas.integer(),
            "expect", Schemas.str("Optional block to test this position against, in set_blocks syntax: "
                + "\"minecraft:chest\" matches any chest, \"minecraft:chest[facing=north]\" also requires "
                + "that property, \"#minecraft:logs\" matches any member of the tag, and an {nbt} suffix "
                + "is matched too. Same semantics as /execute if block."),
            "clear", Schemas.bool("Test that this cell is CLEAR (air or replaceable growth — grass, "
                + "snow, water): the fit predicate. A batch of clear checks over a box's cells IS a "
                + "fit check (check.all_matched = fits). Mutually exclusive with `expect`.")),
            "expect", "clear");
        JsonObject base = Schemas.object(
            "blocks", Schemas.array(entry),
            "detail", Schemas.str("state (default: id[state] palette) | full (also returns block-entity NBT)."),
            "load", Schemas.bool("Page absent chunks in so they can be read. Default true; set false to report only what is already resident."),
            "dimension", Schemas.str("Dimension to read (e.g. minecraft:the_nether). Default: minecraft:overworld; the result stamps the dimension actually read."));
        return Schemas.objectOpt(base, "detail", "load", "dimension");
    }

    /**
     * Package-visible so {@code locate}'s {@code at} mode is the SAME read, not a second
     * implementation of it: palette syntax, {@code expect} semantics (vanilla {@code BlockInput}),
     * the −1 not-read convention and the coverage contract all have exactly one definition. A
     * reimplementation is how two tools start disagreeing about what "unread" means.
     */
    static JsonObject getBlocksAt(final MinecraftServer server, final JsonObject a) {
        ServerLevel level = levelArg(server, a);
        if (!a.has("blocks") || !a.get("blocks").isJsonArray()) {
            throw new IllegalArgumentException("missing `blocks` array of {x,y,z}");
        }
        com.google.gson.JsonArray entries = a.getAsJsonArray("blocks");
        if (entries.isEmpty()) {
            throw new IllegalArgumentException("`blocks` is empty — pass at least one {x,y,z}");
        }
        if (entries.size() > POINT_MAX) {
            throw new IllegalArgumentException("too many positions (" + entries.size() + " > " + POINT_MAX
                + ") — split the read, or use describe_box for a contiguous volume");
        }
        boolean full = "full".equals(detail(a, "state", "full"));
        ChunkLoader loader = new ChunkLoader(level, loadArg(a));
        net.minecraft.core.HolderLookup<net.minecraft.world.level.block.Block> lookup =
            server.registryAccess().lookupOrThrow(net.minecraft.core.registries.Registries.BLOCK);

        // Shared palette: the same block repeated across many positions costs one string, not N.
        java.util.LinkedHashMap<String, Integer> index = new java.util.LinkedHashMap<>();
        // Affordance flags aligned with the palette, from the observed state — O(palette).
        java.util.ArrayList<String> affList = new java.util.ArrayList<>();
        com.google.gson.JsonArray rows = new com.google.gson.JsonArray();
        JsonObject nbt = new JsonObject();
        com.google.gson.JsonArray mismatches = new com.google.gson.JsonArray();
        int read = 0;
        int unreadable = 0;
        int expectedCount = 0;
        int matched = 0;
        int mismatchTotal = 0;
        boolean anyExpect = false;

        BlockPos.MutableBlockPos probe = new BlockPos.MutableBlockPos();
        for (int i = 0; i < entries.size(); i++) {
            JsonObject e = entries.get(i).getAsJsonObject();
            if (!e.has("x") || !e.has("y") || !e.has("z")) {
                throw new IllegalArgumentException("blocks[" + i + "] needs x, y and z");
            }
            int x = e.get("x").getAsInt();
            int y = e.get("y").getAsInt();
            int z = e.get("z").getAsInt();
            probe.set(x, y, z);
            String expectSpec = e.has("expect") && !e.get("expect").isJsonNull()
                ? e.get("expect").getAsString() : null;
            // `clear` (0.22.0, the check_fit fold-in): a DIFFERENT named predicate beside `expect`,
            // deliberately not a pseudo block matcher — `expect` stays exactly vanilla BlockInput.
            // Clear = air or replaceable growth (grass, snow, water), the predicate the whole
            // site/fit family shares.
            boolean clearCheck = e.has("clear") && !e.get("clear").isJsonNull()
                && e.get("clear").getAsBoolean();
            if (clearCheck && expectSpec != null) {
                throw new IllegalArgumentException("blocks[" + i + "]: give `expect` or `clear`, "
                    + "not both — they are different predicates");
            }
            if (expectSpec != null || clearCheck) {
                anyExpect = true;
                expectedCount++;
            }

            com.google.gson.JsonArray row = new com.google.gson.JsonArray();
            row.add(x);
            row.add(y);
            row.add(z);
            if (!loader.ensure(probe)) {
                // -1 is "not read", distinct from every real palette index and from a failed match.
                // The whole point of this tool is that unknown never renders as a fact.
                unreadable++;
                row.add(-1);
                if (expectSpec != null || clearCheck) {
                    row.add(-1);
                }
                rows.add(row);
                continue;
            }
            read++;
            BlockState state = level.getBlockState(probe);
            String desc = describeState(state);
            Integer idx = index.get(desc);
            if (idx == null) {
                idx = index.size();
                index.put(desc, idx);
                affList.add(Affordances.flags(state));
            }
            row.add(idx);

            if (expectSpec != null || clearCheck) {
                boolean ok;
                if (clearCheck) {
                    ok = state.isAir() || state.canBeReplaced();
                } else {
                    try {
                        // Vanilla's own predicate, so `expect` means exactly what /execute if block
                        // means — including partial property matching, NBT, and #tags.
                        ok = BlockTools.parseMatcher(lookup, expectSpec).test(level, probe.immutable());
                    } catch (IllegalArgumentException ex) {
                        throw new IllegalArgumentException("blocks[" + i + "].expect: " + ex.getMessage());
                    }
                }
                row.add(ok ? 1 : 0);
                if (ok) {
                    matched++;
                } else {
                    mismatchTotal++;
                    if (mismatches.size() < POINT_MAX_MISMATCHES) {
                        JsonObject m = new JsonObject();
                        m.addProperty("x", x);
                        m.addProperty("y", y);
                        m.addProperty("z", z);
                        m.addProperty("expected", clearCheck
                            ? "clear (air or replaceable growth)" : expectSpec);
                        m.addProperty("actual", desc);
                        mismatches.add(m);
                    }
                }
            }
            if (full) {
                net.minecraft.world.level.block.entity.BlockEntity be = level.getBlockEntity(probe);
                if (be != null) {
                    nbt.addProperty(x + "," + y + "," + z,
                        be.saveWithoutMetadata(server.registryAccess()).toString());
                }
            }
            rows.add(row);
        }

        JsonObject r = new JsonObject();
        // Not a radius sample and not occlusion-limited: these are the exact positions asked for, so
        // the false-negative hazard the `spatial` label warns about does not apply here.
        addEnvelope(r, level, "authoritative");
        r.addProperty("detail", full ? "full" : "state");
        com.google.gson.JsonArray palette = new com.google.gson.JsonArray();
        for (String key : index.keySet()) {
            palette.add(key);
        }
        r.add("palette", palette);
        com.google.gson.JsonArray affArr = new com.google.gson.JsonArray();
        affList.forEach(affArr::add);
        r.add("affordances", affArr);
        r.add("blocks", rows);
        if (anyExpect) {
            JsonObject check = new JsonObject();
            check.addProperty("expected", expectedCount);
            check.addProperty("matched", matched);
            check.addProperty("mismatched", mismatchTotal);
            check.addProperty("unreadable", unreadable);
            // An unreadable position is not a pass: "all matched" must mean every check was answered.
            check.addProperty("all_matched", mismatchTotal == 0 && unreadable == 0);
            r.add("check", check);
            if (mismatches.size() > 0) {
                r.add("mismatches", mismatches);
                r.addProperty("mismatches_total", mismatchTotal);
            }
        }
        if (full && nbt.size() > 0) {
            r.add("nbt", nbt);
        }
        r.add("coverage", coverage(read, unreadable, entries.size(), false, loader));
        return r;
    }

    /** Render a state in set_blocks syntax ({@code id[state]}) so a read round-trips into a write. */
    private static String describeState(final BlockState state) {
        String id = BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
        var props = state.getProperties();
        if (props.isEmpty()) {
            return id;
        }
        StringBuilder sb = new StringBuilder(id).append('[');
        boolean first = true;
        for (net.minecraft.world.level.block.state.properties.Property<?> p : props) {
            if (!first) {
                sb.append(',');
            }
            first = false;
            sb.append(p.getName()).append('=').append(propertyValue(state, p));
        }
        return sb.append(']').toString();
    }

    /**
     * The same syntax with the DEFAULTS left out — {@code minecraft:purpur_stairs[facing=west]} rather
     * than the same block with all five of its properties spelled out. Parsing it back yields the state
     * it came from, because a property is omitted only where its value already equals the block's
     * default. Used by the layers legend, where the string is repeated once per distinct state and the
     * whole view has a character budget; {@link #describeState} stays exhaustive for {@code get_blocks_at},
     * whose palette is a per-cell answer rather than a picture's key.
     */
    private static String describeStateCompact(final BlockState state) {
        BlockState def = state.getBlock().defaultBlockState();
        String id = BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
        StringBuilder sb = null;
        for (net.minecraft.world.level.block.state.properties.Property<?> p : state.getProperties()) {
            if (state.getValue(p).equals(def.getValue(p))) {
                continue;
            }
            sb = sb == null ? new StringBuilder(id).append('[') : sb.append(',');
            sb.append(p.getName()).append('=').append(propertyValue(state, p));
        }
        return sb == null ? id : sb.append(']').toString();
    }

    private static <T extends Comparable<T>> String propertyValue(
            final BlockState state, final net.minecraft.world.level.block.state.properties.Property<T> p) {
        return p.getName(state.getValue(p));
    }

    /** Parse a two-valued `detail` argument, defaulting and validating. */
    private static String detail(final JsonObject a, final String def, final String other) {
        if (!a.has("detail") || a.get("detail").isJsonNull()) {
            return def;
        }
        String s = a.get("detail").getAsString().toLowerCase(java.util.Locale.ROOT);
        if (!s.equals(def) && !s.equals(other)) {
            // Cross-tool vocabulary drift is the observed failure (bench 2026-07-25: models guess
            // get_blocks_at's "full" here) — the remedy names where the guessed word belongs.
            throw new IllegalArgumentException("unknown detail '" + s + "' (" + def + "|" + other + ")"
                + ("full".equals(s)
                    ? " — \"full\" is get_blocks_at's vocabulary; here \"" + other
                        + "\" is the exact-geometry option"
                    : ""));
        }
        return s;
    }

    private static int clampGrid(final JsonObject a) {
        if (!a.has("grid") || a.get("grid").isJsonNull()) {
            return DEFAULT_GRID;
        }
        int grid = a.get("grid").getAsInt();
        if (grid < 0) {
            throw new IllegalArgumentException("`grid` must be >= 0");
        }
        return Math.min(grid, MAX_GRID);
    }

    private static net.minecraft.world.level.levelgen.Heightmap.Types heightmapType(final JsonObject a) {
        if (!a.has("heightmap") || a.get("heightmap").isJsonNull()) {
            return net.minecraft.world.level.levelgen.Heightmap.Types.WORLD_SURFACE;
        }
        String s = a.get("heightmap").getAsString().toLowerCase(java.util.Locale.ROOT);
        return switch (s) {
            case "world_surface" -> net.minecraft.world.level.levelgen.Heightmap.Types.WORLD_SURFACE;
            case "motion_blocking" -> net.minecraft.world.level.levelgen.Heightmap.Types.MOTION_BLOCKING;
            case "motion_blocking_no_leaves" -> net.minecraft.world.level.levelgen.Heightmap.Types.MOTION_BLOCKING_NO_LEAVES;
            case "ocean_floor" -> net.minecraft.world.level.levelgen.Heightmap.Types.OCEAN_FLOOR;
            default -> throw new IllegalArgumentException("unknown heightmap '" + s
                + "' (world_surface|motion_blocking|motion_blocking_no_leaves|ocean_floor)");
        };
    }

    // ---- get_entities --------------------------------------------------------

    /**
     * A parked entity-data stage: chunks were paged in this tick, which queued their entity data
     * through the entity manager's async inbox (PersistentEntitySectionManager.requestChunkLoad
     * fires on the FULL broadcast, and processPendingLoads applies the inbox next
     * entityManager.tick()). Completes when every awaited chunk reports
     * {@code areEntitiesLoaded} — normally the very next tick — or at the deadline, whichever
     * comes first, with the count of chunks whose data still had not arrived. Server-thread only.
     *
     * <p>Generalized 0.21.0 so {@code locate}'s entity paths (the `what` entity search and
     * pattern entity nodes) ride the SAME staging as get_entities — the substitution the
     * full-ladder bench recommended is only complete if the staged-remote-negative capability
     * comes along, and one mechanism means one definition of what "staged" promises.
     */
    private record PendingEntityStage(ServerLevel level, List<Long> awaiting, int deadlineTick,
                                      CompletableFuture<Integer> future) {}

    private static final List<PendingEntityStage> PENDING_ENTITY_STAGES = new ArrayList<>();
    /** Ticks a staged read waits for the entity inbox before answering with what has arrived.
     * One tick is the normal case; the headroom covers a slow disk read of the entities region. */
    private static final int ENTITY_LOAD_MAX_TICKS = 10;

    /**
     * Stage entity data over a chunk rect: page absent chunks in (block residency is what queues
     * the entity data — reading never generates terrain), then complete now or park until the
     * inbox delivers. The completion value is the still-pending chunk count; the caller re-reads
     * {@code areEntitiesLoaded} for its own coverage accounting either way.
     */
    static CompletableFuture<Integer> stageEntityRect(final MinecraftServer server,
            final ServerLevel level, final ChunkLoader loader,
            final int minCx, final int maxCx, final int minCz, final int maxCz) {
        List<Long> awaiting = new ArrayList<>();
        for (int cx = minCx; cx <= maxCx; cx++) {
            for (int cz = minCz; cz <= maxCz; cz++) {
                long key = net.minecraft.world.level.ChunkPos.pack(cx, cz);
                if (level.areEntitiesLoaded(key)) {
                    continue;
                }
                // ensure() pages the chunk to FULL (or refuses: load:false / never-generated /
                // budget — the read reports those per shortfallReason). A chunk that is readable
                // but not yet entity-loaded is the async gap this whole staging exists for.
                if (loader.ensure(new BlockPos(cx << 4, level.getSeaLevel(), cz << 4))) {
                    awaiting.add(key);
                }
            }
        }
        if (awaiting.isEmpty()) {
            return CompletableFuture.completedFuture(0);
        }
        CompletableFuture<Integer> future = new CompletableFuture<>();
        PENDING_ENTITY_STAGES.add(new PendingEntityStage(level, awaiting,
            server.getTickCount() + ENTITY_LOAD_MAX_TICKS, future));
        return future;
    }

    /**
     * Stage a get_entities call. Validation runs before any paging so a malformed call costs
     * nothing; the read itself runs when the stage completes (server thread either way).
     */
    private static CompletableFuture<JsonElement> getEntitiesStaged(final MinecraftServer server,
            final JsonObject a, final @Nullable String session) {
        Origin origin = resolveOrigin(a, server, session);
        clampLimit(a);
        categoryFilter(a);
        ServerLevel level = origin.level();
        Vec3 center = origin.eye();
        double radius = clampRadius(a);
        AABB box = new AABB(center, center).inflate(radius);
        ChunkLoader loader = new ChunkLoader(level, loadArg(a));
        return stageEntityRect(server, level, loader,
            ((int) Math.floor(box.minX)) >> 4, ((int) Math.floor(box.maxX)) >> 4,
            ((int) Math.floor(box.minZ)) >> 4, ((int) Math.floor(box.maxZ)) >> 4)
            .thenApply(pending -> readEntities(server, a, session, loader, pending));
    }

    /** END_SERVER_TICK: complete parked stages whose entity data arrived (or deadline passed). */
    private static void pumpPendingEntityReads(final MinecraftServer server) {
        if (PENDING_ENTITY_STAGES.isEmpty()) {
            return;
        }
        var it = PENDING_ENTITY_STAGES.iterator();
        while (it.hasNext()) {
            PendingEntityStage p = it.next();
            boolean arrived = true;
            for (long key : p.awaiting()) {
                if (!p.level().areEntitiesLoaded(key)) {
                    arrived = false;
                    break;
                }
            }
            if (!arrived && server.getTickCount() < p.deadlineTick()) {
                continue;
            }
            it.remove();
            int stillPending = 0;
            for (long key : p.awaiting()) {
                if (!p.level().areEntitiesLoaded(key)) {
                    stillPending++;
                }
            }
            p.future().complete(stillPending);
        }
    }

    private static JsonObject readEntities(final MinecraftServer server, final JsonObject a,
            final @Nullable String session, final ChunkLoader loader, final int pending) {
        Origin origin = resolveOrigin(a, server, session);
        ServerLevel level = origin.level();
        Vec3 center = origin.eye();
        double radius = clampRadius(a);
        int limit = clampLimit(a);
        java.util.function.Predicate<Entity> filter = categoryFilter(a);

        boolean fullDetail = "full".equals(detail(a, "compact", "full"));

        AABB box = new AABB(center, center).inflate(radius);
        double r2 = radius * radius;
        // Exclude the origin entity itself (a player asking "what's near me" doesn't mean themselves).
        List<Entity> found = level.getEntities(origin.source(), box,
            e -> e.isAlive() && filter.test(e) && e.position().distanceToSqr(center) <= r2);

        found.sort(java.util.Comparator.comparingDouble(e -> e.position().distanceToSqr(center)));
        int total = found.size();

        // Residency accounting in CHUNKS: getEntities only sees chunks whose entity data is
        // loaded. Staging paged absent chunks in and waited for the entity inbox, so the normal
        // remote survey comes back complete; what stays unread has a specific cause (load:false,
        // never-generated terrain, spent budget, or data still arriving at the deadline), counted
        // and named, never searched. Without this, a radius over non-resident chunks returned a
        // confident total:0, the exact false-negative class the coverage contract exists for.
        int minCx = ((int) Math.floor(box.minX)) >> 4;
        int maxCx = ((int) Math.floor(box.maxX)) >> 4;
        int minCz = ((int) Math.floor(box.minZ)) >> 4;
        int maxCz = ((int) Math.floor(box.maxZ)) >> 4;
        int chunksRequested = 0;
        int chunksRead = 0;
        for (int cx = minCx; cx <= maxCx; cx++) {
            for (int cz = minCz; cz <= maxCz; cz++) {
                chunksRequested++;
                if (level.areEntitiesLoaded(net.minecraft.world.level.ChunkPos.pack(cx, cz))) {
                    chunksRead++;
                }
            }
        }

        JsonObject r = new JsonObject();
        addVec(r, "origin", center);
        r.addProperty("source", origin.label());
        addEnvelope(r, level, "spatial");
        r.addProperty("radius", radius);
        // total is a count-verdict: over a fully unsearchable radius it is null, never 0.
        if (chunksRead == 0) {
            r.add("total", com.google.gson.JsonNull.INSTANCE);
        } else {
            r.addProperty("total", total);
        }

        com.google.gson.JsonArray arr = new com.google.gson.JsonArray();
        int frozen = 0;
        for (int i = 0; i < found.size() && i < limit; i++) {
            Entity e = found.get(i);
            JsonObject o = describeEntity(e, e.position(), fullDetail);
            if (o.has("ticking")) {
                frozen++;
            }
            o.addProperty("distance", Math.round(Math.sqrt(e.position().distanceToSqr(center)) * 10.0) / 10.0);
            // Relation carried in-payload (bearing + Δy from the query origin) — deriving these
            // from raw coordinates is the documented model-arithmetic failure mode.
            String bearing = Affordances.bearing(e.getX() - center.x, e.getZ() - center.z);
            if (bearing != null) {
                o.addProperty("bearing", bearing);
            }
            o.addProperty("dy", (int) Math.round(e.getY() - center.y));
            // The spatial query sees through walls; this flag restores the nuance per entity.
            // Null = the sightline crosses a non-resident chunk, so visibility is unknown.
            o.addProperty("line_of_sight", hasLineOfSight(level, center, e));
            arr.add(o);
        }
        r.addProperty("returned", arr.size());
        r.addProperty("truncated", total > arr.size());
        if (frozen > 0) {
            // Loaded-not-ticking entities read exactly like live ones — same false-confidence class
            // the coverage envelope kills, on the freshness axis instead of the visibility axis.
            r.addProperty("frozen", frozen);
            r.addProperty("frozen_note", frozen + " of the returned entities are in loaded but "
                + "non-ticking chunks (ticking:false): position/health are their as-saved state, and "
                + "they are not acting. Reading never makes an area tick; forceload via run_command "
                + "if you need it running.");
        }
        r.add("entities", arr);
        r.add("coverage", entityCoverage(chunksRead, chunksRequested, pending, loader));
        return r;
    }

    /**
     * Coverage for an entity query, counted in chunks. Same field shape as {@link ReadSupport#coverage},
     * with entity-specific remedies layered on the loader's: a chunk can additionally be unread because
     * its entity data was still in the async inbox when the wait deadline passed — that one just wants
     * a re-query, not a forceload.
     */
    private static JsonObject entityCoverage(final int read, final int requested, final int pending,
                                             final ChunkLoader loader) {
        int unloaded = requested - read;
        JsonObject c = new JsonObject();
        c.addProperty("requested", requested);
        c.addProperty("read", read);
        c.addProperty("unloaded", unloaded);
        JsonObject chunks = loader.report();
        if (chunks != null) {
            c.add("chunks", chunks);
        }
        c.addProperty("unvisited", 0);
        c.addProperty("state", read == 0 ? "none" : (unloaded == 0 ? "complete" : "partial"));
        if (unloaded > 0) {
            int refused = unloaded - pending;
            StringBuilder why = new StringBuilder();
            if (pending > 0) {
                why.append(pending).append(" chunk(s) were paged in but their entity data had not "
                    + "arrived by the wait deadline — re-query to pick them up");
            }
            if (refused > 0) {
                if (why.length() > 0) {
                    why.append("; ");
                }
                why.append(loader.shortfallReason());
            }
            if (read == 0) {
                c.addProperty("note", "NOTHING WAS SEARCHED — none of the " + requested + " chunks in "
                    + "the radius were searchable (" + why + "), so this result describes no entities "
                    + "at all; absence is not evidence of absence.");
            } else {
                c.addProperty("note", "Searched " + read + " of " + requested + " chunks in the radius; "
                    + "entities in the other " + unloaded + " are invisible to this query (" + why
                    + "). total/returned cover only the searched chunks.");
            }
        }
        return c;
    }

    /** Build the type/category predicate, rejecting the combination of both or an unknown type id. */
    private static java.util.function.Predicate<Entity> categoryFilter(final JsonObject a) {
        boolean hasType = a.has("type") && !a.get("type").isJsonNull();
        boolean hasCat = a.has("category") && !a.get("category").isJsonNull();
        if (hasType && hasCat) {
            throw new IllegalArgumentException("pass only one of `type` or `category`");
        }
        if (hasType) {
            net.minecraft.resources.Identifier id = net.minecraft.resources.Identifier.parse(a.get("type").getAsString());
            var et = BuiltInRegistries.ENTITY_TYPE.getOptional(id);
            if (et.isEmpty()) {
                throw new IllegalArgumentException("unknown entity type '" + id + "'");
            }
            var type = et.get();
            return e -> e.getType() == type;
        }
        if (hasCat) {
            String cat = a.get("category").getAsString().toLowerCase(java.util.Locale.ROOT);
            return switch (cat) {
                case "player" -> e -> e instanceof Player;
                case "living" -> e -> e instanceof LivingEntity;
                case "hostile" -> e -> e instanceof Enemy;
                case "item" -> e -> e instanceof ItemEntity;
                default -> throw new IllegalArgumentException(
                    "unknown category '" + cat + "' (player|living|hostile|item)");
            };
        }
        return e -> true;
    }

    // ---- raycast -------------------------------------------------------------

    private static JsonObject raycast(final MinecraftServer server, final JsonObject a, final @Nullable String session) {
        Origin origin = resolveOrigin(a, server, session);
        double range = clampRange(a);
        boolean fluids = a.has("fluids") && !a.get("fluids").isJsonNull() && a.get("fluids").getAsBoolean();

        Vec3 from = origin.eye();
        Vec3 to = from.add(origin.view().scale(range));
        ServerLevel level = origin.level();

        JsonObject r = new JsonObject();
        addVec(r, "origin", from);
        addVec(r, "direction", origin.view());
        r.addProperty("source", origin.label());
        addEnvelope(r, level, "visible"); // the one occlusion-respecting read: a ray IS a look
        r.addProperty("range", range);

        // The ray may only traverse readable chunks (vanilla clip would load-or-GENERATE the rest).
        ChunkLoader loader = new ChunkLoader(level, loadArg(a));
        Vec3 safeTo = clampToReadable(loader, from, to);
        boolean rayTruncated = safeTo != to;
        double covered = rayTruncated ? from.distanceTo(safeTo) : range;

        // Block hit first — the first cell that genuinely BLOCKS the view, not the first cell the ray
        // touches. Under the old OUTLINE clip a grass tuft ended the sightline, so "what am I looking
        // at" answered `short_grass` while the wall behind it went unseen (§1.2). Its distance caps
        // how far entities can count — an entity behind a wall is not "what you're looking at".
        Sightlines.Walk walk = Sightlines.walk(level, from, safeTo, (int) Math.ceil(range * 3.0) + 4, fluids,
            com.mattmc.mcptoolkit.wm.WmSeen.feed(session));
        Sightlines.Sighting hit = walk.terminal();
        boolean blockMiss = hit == null;
        double reach = blockMiss ? covered : hit.distance();

        // Entity hit: the nearest pickable entity whose bounding box the ray pierces before `reach`.
        EntityPick entity = nearestEntity(level, origin.source(), from, safeTo, reach);

        // World-model frames tap (DESIGN.md §13.1: single rays are frames too — a one-ray fan).
        if (com.mattmc.mcptoolkit.wm.Wm.recording()) {
            Vec3 view = origin.view();
            double basePitch = Math.toDegrees(-Math.asin(Math.max(-1.0, Math.min(1.0, view.y))));
            double baseYaw = Math.toDegrees(Math.atan2(-view.x, view.z));
            com.mattmc.mcptoolkit.wm.Wm.recordFan(level, session, "ray", from, baseYaw, basePitch,
                0.0, 0.0, 1, 1, range, origin.source(),
                List.of(new com.mattmc.mcptoolkit.wm.WmFanRay(0.0, 0.0, walk, covered, rayTruncated,
                    entity == null ? null : entity.entity(), entity == null ? 0.0 : entity.distance())),
                null);
        }

        if (rayTruncated) {
            r.addProperty("range_covered", Math.round(covered * 10.0) / 10.0);
            r.addProperty("truncated", true);
        }
        if (entity != null) {
            r.addProperty("hit", "entity");
            r.addProperty("distance", entity.distance());
            addVec(r, "point", entity.point());
            r.add("entity", describeEntity(entity.entity(), entity.point()));
        } else if (!blockMiss) {
            r.addProperty("hit", "block");
            r.addProperty("distance", reach);
            r.add("block", describeSighting(hit));
            // Same sighting hook as the fan: a ray hit is the one thing a body legally SAW.
            com.mattmc.mcptoolkit.drone.Watch.sight(session, level, hit.state(), hit.pos(), reach, "raycast");
        } else if (rayTruncated) {
            // Nothing hit within the readable stretch, and the rest was never looked at — "miss"
            // here would be the confident false negative the coverage contract forbids.
            r.addProperty("hit", "unread");
            r.addProperty("note", "no hit within the first " + Math.round(covered * 10.0) / 10.0
                + " blocks; the ray then reached an unreadable chunk (" + loader.shortfallReason()
                + "), so the remaining " + Math.round((range - covered) * 10.0) / 10.0
                + " blocks are unread, not empty");
        } else {
            r.addProperty("hit", "miss");
        }
        return r;
    }

    // ---- raycast_fan ----------------------------------------------------------

    /**
     * Fan cap. Was 64 — an arbitrary constant that made the retina ALIAS: at 15° steps adjacent rays
     * are 8.4 blocks apart at range 32, so a 5-wide spruce canopy subtends 8.9° against a 15° grid
     * and two of every three trees at range were missed by geometry alone. Eleven survival sessions
     * never once saw a log in a spruce taiga (PERCEPTION_NAV_FIXES §1.4).
     *
     * <p>The budget is split by CALLER, not by this number: the ambient retina stays cheap and wide
     * (45 rays every 2 s — it must not tax the tick), while a deliberate {@code bot_scan} spends
     * ~1024 and summarises. The cap only has to be high enough not to be the thing that binds.
     *
     * <p>Note that the row payload grows linearly with ray count, so a dense fan belongs to a caller
     * that reduces it (bot_scan returns a tally, never positions) rather than one that hands raw rows
     * to a model.
     */
    private static final int FAN_MAX_RAYS = 1024;

    /**
     * Trailing marker on a ray row: this cell was seen ACROSS water or lava. The navigation side
     * needs it — "walkable sand" seen through six feet of water does not mean the body can walk
     * there, and believing it is the root of "walking into water" (§1.1). Appended as a 9th element,
     * which consumers that read fixed indices 0–7 ignore.
     */
    private static final String THROUGH_FLUID = "wf";

    /** One aimed, readability-clamped ray, held between the fan's two passes. */
    private record FanRay(double dYaw, double dPitch, Vec3 to, boolean truncated, double covered) { }

    private static JsonObject raycastFanSchema() {
        JsonObject base = Schemas.object(
            "drone", Schemas.bool("If true, cast from the active drone's eye (spawn via bot_body first). Overrides player/origin."),
            "player", Schemas.str("Name of the player whose eyes/facing center the fan. Defaults to the first online player."),
            "origin", Schemas.object("x", Schemas.number(), "y", Schemas.number(), "z", Schemas.number()),
            "yaw", Schemas.number("Center yaw in degrees (overrides the origin's own facing)."),
            "pitch", Schemas.number("Center pitch in degrees."),
            "direction", Schemas.object("x", Schemas.number(), "y", Schemas.number(), "z", Schemas.number()),
            "h_fov", Schemas.number("Horizontal spread in degrees (default 90; 360 sweeps all around)."),
            "v_fov", Schemas.number("Vertical spread in degrees (default 0 = single row)."),
            "steps_h", Schemas.integer("Rays across h_fov (default 9)."),
            "steps_v", Schemas.integer("Rays across v_fov (default 1). steps_h*steps_v capped at " + FAN_MAX_RAYS + "."),
            "range", Schemas.number("How far each ray reaches, in blocks. Default 32, capped at 256."),
            "fluids", Schemas.bool("If true, fluids count as blocking hits. Default false."),
            "load", Schemas.bool("Pull absent chunks in so rays can cross them (one shared budget for the "
                + "whole fan). Default true; set false to read only what is already resident."));
        return Schemas.objectOpt(base, "drone", "player", "origin", "yaw", "pitch", "direction",
            "h_fov", "v_fov", "steps_h", "steps_v", "range", "fluids", "load");
    }

    private static JsonObject raycastFan(final MinecraftServer server, final JsonObject a, final @Nullable String session) {
        Origin origin = resolveOrigin(a, server, session);
        ServerLevel level = origin.level();
        double range = clampRange(a);
        boolean fluids = a.has("fluids") && !a.get("fluids").isJsonNull() && a.get("fluids").getAsBoolean();
        double hFov = optDouble(a, "h_fov", 90.0);
        double vFov = optDouble(a, "v_fov", 0.0);
        int stepsH = Math.max(1, (int) optDouble(a, "steps_h", 9));
        int stepsV = Math.max(1, (int) optDouble(a, "steps_v", 1));
        if (stepsH * stepsV > FAN_MAX_RAYS) {
            throw new IllegalArgumentException("steps_h*steps_v = " + (stepsH * stepsV)
                + " exceeds the cap of " + FAN_MAX_RAYS + " rays");
        }

        // Base yaw/pitch from the resolved view vector (Minecraft convention, inverse of directionFromRotation).
        Vec3 view = origin.view();
        double basePitch = Math.toDegrees(-Math.asin(Math.max(-1.0, Math.min(1.0, view.y))));
        double baseYaw = Math.toDegrees(Math.atan2(-view.x, view.z));

        Vec3 from = origin.eye();
        JsonObject r = new JsonObject();
        addVec(r, "origin", from);
        r.addProperty("source", origin.label());
        addEnvelope(r, level, "visible");
        r.addProperty("center_yaw", Math.round(baseYaw * 10.0) / 10.0);
        r.addProperty("center_pitch", Math.round(basePitch * 10.0) / 10.0);
        r.addProperty("range", range);

        // One loader for the whole fan: the rays share the paging budget, and vanilla clip must never
        // see a chunk the loader hasn't supplied (it would load-or-GENERATE it on the server thread).
        ChunkLoader loader = new ChunkLoader(level, loadArg(a));
        long t0 = System.nanoTime();
        int unread = 0;
        com.google.gson.JsonArray rows = new com.google.gson.JsonArray();
        java.util.LinkedHashMap<String, Integer> hits = new java.util.LinkedHashMap<>();

        // Pass A — aim every ray and clamp it to what is readable, accumulating the volume they span.
        // Geometry only: no world reads beyond the loader's own paging, so it is cheap to do first.
        List<FanRay> fan = new ArrayList<>(stepsH * stepsV);
        AABB span = null;
        for (int j = 0; j < stepsV; j++) {
            double dPitch = stepsV == 1 ? 0 : -vFov / 2 + j * (vFov / (stepsV - 1));
            for (int i = 0; i < stepsH; i++) {
                double dYaw = stepsH == 1 ? 0 : -hFov / 2 + i * (hFov / (stepsH - 1));
                double pitch = Math.max(-90, Math.min(90, basePitch + dPitch));
                Vec3 dir = exactDirection(pitch, baseYaw + dYaw);
                Vec3 to = from.add(dir.scale(range));
                Vec3 safeTo = clampToReadable(loader, from, to);
                boolean rayTruncated = safeTo != to;
                fan.add(new FanRay(dYaw, dPitch, safeTo, rayTruncated,
                    rayTruncated ? from.distanceTo(safeTo) : range));
                AABB ray = new AABB(from, safeTo);
                span = span == null ? ray : span.minmax(ray);
            }
        }

        // ONE entity query for the whole fan, then each ray clips against that list. This used to be
        // per-ray — 45 overlapping getEntities sweeps inside one cone. Worth ~2x on a 1024-ray fan
        // in a crowded scene, and it removes the tail: un-hoisted, cost grew with the crowd (6.4ms
        // mean / 12ms worst vs 3.8 / 4.8) because every ray re-queried the whole cone. The union box
        // is a superset of every per-ray box, so each ray still sees exactly the candidates it saw
        // before. Measurements in PERCEPTION_NAV_FIXES §1.4a.
        List<Entity> candidates = span == null ? List.of()
            : pickableIn(level, origin.source(), span.inflate(1.0));

        // Pass B — trace, and decide what each ray struck.
        //
        // Every cell a ray passes THROUGH is reported too, deduped across the fan (a dense fan lands
        // many rays on one grass tuft). Those rows are what make water, and a trunk behind leaves,
        // exist for memory at all — but they are never per-ray, because the per-ray rows are what
        // the horizon arithmetic reads, and a horizon is only ever an opaque wall (§1.3).
        // A cell-walk visits at most one cell per axis crossing, so a segment of length L meets
        // fewer than 3L+3 cells. Bounding it by the range keeps a long ray from being an open loop.
        int maxCells = (int) Math.ceil(range * 3.0) + 4;
        java.util.HashSet<Long> passed = new java.util.HashSet<>();
        // World-model frames tap (DESIGN.md §2.1): the recorder serializes the WALK itself — kind,
        // face, exact entity positions — which the agent-facing rows below deliberately discard.
        // Collected per ray, handed over once after the drops pass.
        List<com.mattmc.mcptoolkit.wm.WmFanRay> wmRays =
            com.mattmc.mcptoolkit.wm.Wm.recording() ? new ArrayList<>(fan.size()) : null;
        List<com.mattmc.mcptoolkit.wm.WmFanRay.Item> wmItems = wmRays != null ? new ArrayList<>() : null;
        // The seen-set feed (CHECK_PATH_AUDIT.md R2): every cell these rays visit — air included —
        // becomes held knowledge for this session's knowledge-masked check_path. Independent of the
        // recorder flag: legality does not switch off when the dataset does.
        java.util.function.LongConsumer seenFeed = com.mattmc.mcptoolkit.wm.WmSeen.feed(session);
        for (FanRay ray : fan) {
            Vec3 safeTo = ray.to();
            double covered = ray.covered();

            Sightlines.Walk walk = Sightlines.walk(level, from, safeTo, maxCells, fluids, seenFeed);
            Sightlines.Sighting hit = walk.terminal();
            boolean blockMiss = hit == null;
            double reach = blockMiss ? covered : hit.distance();
            EntityPick entity = nearestEntityIn(candidates, from, safeTo, reach);
            if (wmRays != null) {
                wmRays.add(new com.mattmc.mcptoolkit.wm.WmFanRay(ray.dYaw(), ray.dPitch(), walk,
                    covered, ray.truncated(), entity == null ? null : entity.entity(),
                    entity == null ? 0.0 : entity.distance()));
            }

            for (Sightlines.Sighting s : walk.seen()) {
                if (s == hit || (entity != null && s.distance() > entity.distance())) {
                    continue;
                }
                if (!passed.add(s.pos().asLong())) {
                    continue;
                }
                com.google.gson.JsonArray through = new com.google.gson.JsonArray();
                through.add(Math.round(ray.dYaw() * 10.0) / 10.0);
                through.add(Math.round(ray.dPitch() * 10.0) / 10.0);
                through.add("b");
                String id = BuiltInRegistries.BLOCK.getKey(s.state().getBlock()).toString();
                through.add(id);
                through.add(s.distance());
                through.add(s.pos().getX());
                through.add(s.pos().getY());
                through.add(s.pos().getZ());
                if (s.throughFluid()) {
                    through.add(THROUGH_FLUID);
                }
                com.mattmc.mcptoolkit.drone.Watch.sight(session, level, s.state(), s.pos(),
                    s.distance(), "raycast_fan");
                hits.merge(id, 1, Integer::sum);
                rows.add(through);
            }

            com.google.gson.JsonArray row = new com.google.gson.JsonArray();
            row.add(Math.round(ray.dYaw() * 10.0) / 10.0);
            row.add(Math.round(ray.dPitch() * 10.0) / 10.0);
            if (entity == null && blockMiss && ray.truncated()) {
                // No hit in the readable stretch and the rest never looked at: unread, not a miss.
                row.add("u");
                row.add(Math.round(covered * 10.0) / 10.0);
                hits.merge("unread", 1, Integer::sum);
                unread++;
                rows.add(row);
                continue;
            }
            if (entity != null) {
                String id = BuiltInRegistries.ENTITY_TYPE.getKey(entity.entity().getType()).toString();
                row.add("e");
                row.add(id);
                row.add(Math.round(entity.distance() * 10.0) / 10.0);
                row.add((int) Math.floor(entity.entity().position().x));
                row.add((int) Math.floor(entity.entity().position().y));
                row.add((int) Math.floor(entity.entity().position().z));
                hits.merge(id, 1, Integer::sum);
            } else if (!blockMiss) {
                BlockPos bp = hit.pos();
                String id = BuiltInRegistries.BLOCK.getKey(hit.state().getBlock()).toString();
                // A ray hit is a SIGHTING: offer it to the caller's standing block watches
                // (drone.Watch). No-op — one volatile read — when nothing is watched.
                com.mattmc.mcptoolkit.drone.Watch.sight(session, level, hit.state(), bp, reach, "raycast_fan");
                row.add("b");
                row.add(id);
                row.add(Math.round(reach * 10.0) / 10.0);
                row.add(bp.getX());
                row.add(bp.getY());
                row.add(bp.getZ());
                if (hit.throughFluid()) {
                    row.add(THROUGH_FLUID);
                }
                hits.merge(id, 1, Integer::sum);
            } else {
                row.add("m");
                hits.merge("miss", 1, Integer::sum);
            }
            rows.add(row);
        }
        // DROPPED ITEMS — collected separately, on purpose.
        //
        // They were invisible to the fan entirely: the ray's entity filter is `isPickable()`, and a
        // vanilla ItemEntity is not pickable, so a body that had just mined three logs looked around
        // and was told nothing about them (live-caught by a human watching a survival run,
        // 2026-08-06). They must not simply join that filter either — a dropped nugget is not a wall,
        // and letting one terminate a ray would mask the block behind it. Same rule as §1.3: being
        // SEEN and being an OCCLUDER are different questions.
        //
        // So: one query over the fan's own span, kept to what is inside the cone and genuinely in
        // line of sight, appended as rows without disturbing any ray's verdict.
        if (span != null) {
            for (ItemEntity drop : level.getEntitiesOfClass(ItemEntity.class, span.inflate(1.0))) {
                Vec3 at = drop.position().add(0, drop.getBbHeight() / 2.0, 0);
                Vec3 to = at.subtract(from);
                double dist = to.length();
                if (dist > range || dist < 1.0e-4) {
                    continue;
                }
                double itemPitch = Math.toDegrees(-Math.asin(Math.max(-1.0, Math.min(1.0, to.y / dist))));
                double itemYaw = Math.toDegrees(Math.atan2(-to.x, to.z));
                double dYaw = Mth.wrapDegrees(itemYaw - baseYaw);
                double dPitch = itemPitch - basePitch;
                if (Math.abs(dYaw) > hFov / 2 + 1 || Math.abs(dPitch) > Math.max(vFov, 10.0) / 2 + 1) {
                    continue;
                }
                Sightlines.Walk los = Sightlines.walk(level, from, at, maxCells, fluids, seenFeed);
                if (los.blocked() && los.distance() < dist - 0.5) {
                    continue; // something opaque stands between the eye and the stack
                }
                if (wmItems != null) {
                    wmItems.add(new com.mattmc.mcptoolkit.wm.WmFanRay.Item(drop, dist, dYaw, dPitch));
                }
                com.google.gson.JsonArray row = new com.google.gson.JsonArray();
                row.add(Math.round(dYaw * 10.0) / 10.0);
                row.add(Math.round(dPitch * 10.0) / 10.0);
                row.add("e");
                row.add("minecraft:item");
                row.add(Math.round(dist * 10.0) / 10.0);
                row.add((int) Math.floor(drop.position().x));
                row.add((int) Math.floor(drop.position().y));
                row.add((int) Math.floor(drop.position().z));
                row.add(BuiltInRegistries.ITEM.getKey(drop.getItem().getItem()).toString());
                row.add(drop.getItem().getCount());
                hits.merge("minecraft:item", 1, Integer::sum);
                rows.add(row);
            }
        }

        if (wmRays != null) {
            com.mattmc.mcptoolkit.wm.Wm.recordFan(level, session, "fan", from, baseYaw, basePitch,
                hFov, vFov, stepsH, stepsV, range, origin.source(), wmRays, wmItems);
        }

        r.add("rays", rows);
        JsonObject hist = new JsonObject();
        hits.entrySet().stream().sorted((p, q) -> q.getValue() - p.getValue())
            .forEach(e -> hist.addProperty(e.getKey(), e.getValue()));
        r.add("hits", hist);
        if (unread > 0) {
            r.addProperty("note", unread + " ray(s) reached unreadable chunks ("
                + loader.shortfallReason() + "); their 'u' rows carry the distance actually covered — "
                + "beyond it is unread, not empty");
        }
        // What the fan cost on the server thread. Ray density is a standing budget question — how
        // dense a scan can afford to be is the input to every later perception change — so the
        // measurement ships with the tool instead of being re-derived by hand each time (§1.4).
        r.addProperty("rays_cast", fan.size());
        // Tenths: at ambient density (45 rays) a whole-millisecond timer reads 0 for BOTH the
        // hoisted and the un-hoisted fan, which is exactly the regime the retina lives in.
        r.addProperty("ms", Math.round((System.nanoTime() - t0) / 1_000_0.0) / 100.0);
        return r;
    }

    private static double optDouble(final JsonObject a, final String key, final double def) {
        return a.has(key) && !a.get(key).isJsonNull() ? a.get(key).getAsDouble() : def;
    }

    /**
     * {@code Vec3.directionFromRotation} in DOUBLE precision. Vanilla's version runs on
     * {@code Mth}'s float sine TABLE (~1e-4), which is fine for aiming a mob but breaks the
     * world-model contract that traversed cells are re-derivable exactly from (origin, angles,
     * distance) — a table-precision direction flips boundary-crossing order on grazing rays, and
     * the loader then certifies the wrong cell as air (world-model DESIGN.md §2.4; live-caught by
     * the Phase-1 exactness test). Same convention, real trig: the ray a fan casts IS the ray the
     * loader re-walks, to 1 ulp.
     */
    public static Vec3 exactDirection(final double pitchDeg, final double yawDeg) {
        double pitch = Math.toRadians(pitchDeg);
        double yaw = Math.toRadians(yawDeg);
        double cosPitch = Math.cos(pitch);
        return new Vec3(-Math.sin(yaw) * cosPitch, -Math.sin(pitch), Math.cos(yaw) * cosPitch);
    }

    // ---- describe_box --------------------------------------------------------------

    /** Volume cap: a 32×32×32 box. Layers detail is additionally budget-capped at serialization. */
    private static final int SCAN_MAX_VOLUME = 32 * 32 * 32;
    private static final int SCAN_TOP_MATERIALS = 8;
    /** Rough serialized-char budget for detail:"layers" (stays inside the 8KB response budget). */
    private static final int SCAN_LAYERS_CHAR_BUDGET = 7000;

    private static JsonObject scanBoxSchema() {
        JsonObject base = Schemas.object(
            "min", Schemas.object("x", Schemas.number(), "y", Schemas.number(), "z", Schemas.number()),
            "max", Schemas.object("x", Schemas.number(), "y", Schemas.number(), "z", Schemas.number()),
            "detail", Schemas.str("summary (default) | layers (adds per-y text slices; small boxes only)."),
            "load", Schemas.bool("Pull absent chunks in so they can be read. Default true; set false to report only what is already resident."),
            "dimension", Schemas.str("Dimension to read (e.g. minecraft:the_nether). Default: minecraft:overworld; the result stamps the dimension actually read."));
        return Schemas.objectOpt(base, "detail", "load", "dimension");
    }

    /**
     * Package-private so {@code locate at} can serve a REGION read with the same code (0.32.0): the
     * region arity of "what is at this position" is a description, and a second implementation of
     * the census would be a second definition of what a volume is made of.
     */
    static JsonObject scanBox(final MinecraftServer server, final JsonObject a) {
        ServerLevel level = levelArg(server, a);
        BlockPos min = posArg(a, "min");
        BlockPos max = posArg(a, "max");
        int x0 = Math.min(min.getX(), max.getX()), x1 = Math.max(min.getX(), max.getX());
        int y0 = Math.min(min.getY(), max.getY()), y1 = Math.max(min.getY(), max.getY());
        int z0 = Math.min(min.getZ(), max.getZ()), z1 = Math.max(min.getZ(), max.getZ());
        int worldMinY = level.dimensionType().minY();
        y0 = Math.max(y0, worldMinY);
        y1 = Math.min(y1, worldMinY + level.dimensionType().height() - 1);
        long volume = (long) (x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1);
        if (volume > SCAN_MAX_VOLUME) {
            throw new IllegalArgumentException("box volume " + volume + " exceeds the cap of "
                + SCAN_MAX_VOLUME + " blocks — describe a smaller box (one building, not a whole "
                + "area), or split it into parts");
        }
        boolean layers = "layers".equals(detail(a, "summary", "layers"));

        // Column-wise walk honoring never-force-load; per-material counts + bounds; per-layer solids.
        java.util.LinkedHashMap<String, int[]> mats = new java.util.LinkedHashMap<>(); // id -> {count, bbox…}
        java.util.HashMap<String, String> matAff = new java.util.HashMap<>(); // id -> affordance flags
        int[] layerSolids = new int[y1 - y0 + 1];
        // The layers view is glyphed per STATE, not per block id: a wall of stairs all facing
        // different ways is one material and four different geometries, and the id-keyed legend it
        // used to emit drew them identically. The materials histogram above stays id-keyed — that is
        // its job — so the two maps are deliberately separate.
        BlockState[] cells = layers ? new BlockState[(x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1)] : null;
        java.util.LinkedHashMap<BlockState, int[]> stateCounts = layers ? new java.util.LinkedHashMap<>() : null;
        int air = 0;
        int unloadedColumns = 0;
        int nx0 = Integer.MAX_VALUE, ny0 = Integer.MAX_VALUE, nz0 = Integer.MAX_VALUE;
        int nx1 = Integer.MIN_VALUE, ny1 = Integer.MIN_VALUE, nz1 = Integer.MIN_VALUE;
        ChunkLoader loader = new ChunkLoader(level, loadArg(a));
        BlockPos.MutableBlockPos probe = new BlockPos.MutableBlockPos();
        for (int x = x0; x <= x1; x++) {
            for (int z = z0; z <= z1; z++) {
                if (!loader.ensure(probe.set(x, y0, z))) {
                    unloadedColumns++;
                    continue;
                }
                for (int y = y0; y <= y1; y++) {
                    BlockState st = level.getBlockState(probe.set(x, y, z));
                    if (st.isAir()) {
                        air++;
                        continue;
                    }
                    String id = BuiltInRegistries.BLOCK.getKey(st.getBlock()).toString();
                    matAff.putIfAbsent(id, Affordances.flags(st));
                    int[] m = mats.computeIfAbsent(id, k -> new int[]{0,
                        Integer.MAX_VALUE, Integer.MAX_VALUE, Integer.MAX_VALUE,
                        Integer.MIN_VALUE, Integer.MIN_VALUE, Integer.MIN_VALUE});
                    m[0]++;
                    m[1] = Math.min(m[1], x); m[2] = Math.min(m[2], y); m[3] = Math.min(m[3], z);
                    m[4] = Math.max(m[4], x); m[5] = Math.max(m[5], y); m[6] = Math.max(m[6], z);
                    layerSolids[y - y0]++;
                    nx0 = Math.min(nx0, x); ny0 = Math.min(ny0, y); nz0 = Math.min(nz0, z);
                    nx1 = Math.max(nx1, x); ny1 = Math.max(ny1, y); nz1 = Math.max(nz1, z);
                    if (cells != null) {
                        cells[((y - y0) * (z1 - z0 + 1) + (z - z0)) * (x1 - x0 + 1) + (x - x0)] = st;
                        stateCounts.computeIfAbsent(st, k -> new int[1])[0]++;
                    }
                }
            }
        }

        JsonObject r = new JsonObject();
        addEnvelope(r, level, "spatial");
        JsonObject box = new JsonObject();
        box.addProperty("min", x0 + "," + y0 + "," + z0);
        box.addProperty("max", x1 + "," + y1 + "," + z1);
        r.add("box", box);
        r.addProperty("volume", volume);
        r.addProperty("air", air);
        r.addProperty("unloaded_columns", unloadedColumns);
        int requestedColumns = (x1 - x0 + 1) * (z1 - z0 + 1);
        r.add("coverage", coverage(requestedColumns - unloadedColumns, unloadedColumns,
            requestedColumns, false, loader));

        boolean any = nx1 != Integer.MIN_VALUE;
        if (any) {
            JsonObject bb = new JsonObject();
            bb.addProperty("min", nx0 + "," + ny0 + "," + nz0);
            bb.addProperty("max", nx1 + "," + ny1 + "," + nz1);
            r.add("nonair_bbox", bb);
        }

        List<Map.Entry<String, int[]>> byCount = new ArrayList<>(mats.entrySet());
        byCount.sort((p, q) -> q.getValue()[0] - p.getValue()[0]);
        com.google.gson.JsonArray palette = new com.google.gson.JsonArray();
        for (int i = 0; i < byCount.size(); i++) {
            Map.Entry<String, int[]> e = byCount.get(i);
            JsonObject o = new JsonObject();
            o.addProperty("block", e.getKey());
            o.addProperty("count", e.getValue()[0]);
            o.addProperty("aff", matAff.get(e.getKey()));
            if (i < SCAN_TOP_MATERIALS) {
                int[] m = e.getValue();
                o.addProperty("bbox", m[1] + "," + m[2] + "," + m[3] + " .. " + m[4] + "," + m[5] + "," + m[6]);
            }
            palette.add(o);
        }
        r.add("materials", palette);

        // Per-layer solid counts inside the non-air bbox — the y-profile that shows floors/roofs.
        if (any) {
            com.google.gson.JsonArray profile = new com.google.gson.JsonArray();
            for (int y = ny0; y <= ny1; y++) {
                com.google.gson.JsonArray row = new com.google.gson.JsonArray();
                row.add(y);
                row.add(layerSolids[y - y0]);
                profile.add(row);
            }
            r.add("y_profile", profile);

            // Shell air counts on the non-air bbox faces: openings (doors/windows) read as air cells
            // on an otherwise-solid face. Counts only — layers detail gives exact geometry.
            JsonObject shellAir = new JsonObject();
            shellAir.addProperty("west", faceAir(level, nx0, ny0, ny1, nz0, nz1));
            shellAir.addProperty("east", faceAir(level, nx1, ny0, ny1, nz0, nz1));
            shellAir.addProperty("north", faceAirZ(level, nz0, nx0, nx1, ny0, ny1));
            shellAir.addProperty("south", faceAirZ(level, nz1, nx0, nx1, ny0, ny1));
            r.add("shell_air", shellAir);
        }

        if (layers && any) {
            // Palette-keyed text slices, y-ascending; '.'=air. Budget-guarded, not silently truncated.
            // Every row carries its z coordinate and each slice a west-edge x ruler (M3,
            // 2026-07-26): the reproducible bench failure was models recovering coordinates by
            // COUNTING CHARACTERS from the box corner — the same wrong cell three runs straight.
            // Labeled rows make the mapping a lookup instead of arithmetic.
            String glyphs = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
            long est = (long) (ny1 - ny0 + 1) * ((long) (nz1 - nz0 + 1) * (nx1 - nx0 + 17) + 40);
            if (est > SCAN_LAYERS_CHAR_BUDGET) {
                throw new IllegalArgumentException("layers detail for this box would serialize ~" + est
                    + " chars (budget " + SCAN_LAYERS_CHAR_BUDGET + ") — shrink the box or scan per-layer "
                    + "sub-boxes; the summary fields above are already complete");
            }
            // Glyphs go to the commonest STATES, and the legend speaks set_blocks syntax so this view
            // round-trips into a write (the rule get_blocks_at has followed since 0.21.0 and this one
            // did not). Beyond the 62nd distinct state cells are '?' — which was always true and was
            // never said; `legend_overflow` says it now, because an unglyphed cell in a picture that
            // claims to be exact geometry is the silent kind of wrong.
            List<Map.Entry<BlockState, int[]>> statesByCount = new ArrayList<>(stateCounts.entrySet());
            statesByCount.sort((p, q) -> q.getValue()[0] - p.getValue()[0]);
            java.util.LinkedHashMap<BlockState, Character> glyphOf = new java.util.LinkedHashMap<>();
            JsonObject legend = new JsonObject();
            int overflow = 0;
            for (int i = 0; i < statesByCount.size(); i++) {
                char g = i < glyphs.length() ? glyphs.charAt(i) : '?';
                glyphOf.put(statesByCount.get(i).getKey(), g);
                if (g != '?') {
                    legend.addProperty(String.valueOf(g), describeStateCompact(statesByCount.get(i).getKey()));
                } else {
                    overflow += statesByCount.get(i).getValue()[0];
                }
            }
            JsonObject slices = new JsonObject();
            StringBuilder sb = new StringBuilder();
            for (int y = ny0; y <= ny1; y++) {
                com.google.gson.JsonArray rows = new com.google.gson.JsonArray();
                rows.add("x: " + nx0 + ".." + nx1 + " (left..right)");
                for (int z = nz0; z <= nz1; z++) {
                    sb.setLength(0);
                    sb.append("z=").append(z).append('|');
                    for (int x = nx0; x <= nx1; x++) {
                        BlockState st = cells[((y - y0) * (z1 - z0 + 1) + (z - z0)) * (x1 - x0 + 1) + (x - x0)];
                        sb.append(st == null ? '.' : glyphOf.get(st));
                    }
                    rows.add(sb.toString());
                }
                slices.add(String.valueOf(y), rows);
            }
            r.add("legend", legend);
            r.add("layers", slices);
            if (overflow > 0) {
                r.addProperty("legend_overflow", overflow);
                r.addProperty("legend_overflow_note", "cells drawn '?': more than " + glyphs.length()
                    + " distinct block states in this box, so the rarest have no glyph and this picture "
                    + "is not complete geometry — describe a smaller box for those");
            }
            r.addProperty("layers_axes", "slice key = y; each row is one z (labeled z=N|); "
                + "column i after the | is x = " + nx0 + "+i. Read coordinates off the labels — "
                + "never count characters from a corner. This view is writable: hand `legend` and "
                + "`layers` back to set_blocks with min=" + nx0 + "," + ny0 + "," + nz0
                + " and it rebuilds what is here ('.' = air).");
        }
        return r;
    }

    /** Air cells on a constant-x face of the box (west/east shell). Unloaded cells count as air=false. */
    private static int faceAir(final ServerLevel level, final int x,
                               final int y0, final int y1, final int z0, final int z1) {
        int airCells = 0;
        BlockPos.MutableBlockPos probe = new BlockPos.MutableBlockPos();
        for (int y = y0; y <= y1; y++) {
            for (int z = z0; z <= z1; z++) {
                if (level.isLoaded(probe.set(x, y, z)) && level.getBlockState(probe).isAir()) {
                    airCells++;
                }
            }
        }
        return airCells;
    }

    /** Air cells on a constant-z face of the box (north/south shell). */
    private static int faceAirZ(final ServerLevel level, final int z,
                                final int x0, final int x1, final int y0, final int y1) {
        int airCells = 0;
        BlockPos.MutableBlockPos probe = new BlockPos.MutableBlockPos();
        for (int y = y0; y <= y1; y++) {
            for (int x = x0; x <= x1; x++) {
                if (level.isLoaded(probe.set(x, y, z)) && level.getBlockState(probe).isAir()) {
                    airCells++;
                }
            }
        }
        return airCells;
    }

    private static BlockPos posArg(final JsonObject a, final String key) {
        if (!a.has(key) || !a.get(key).isJsonObject()) {
            throw new IllegalArgumentException("missing required `" + key + "` {x,y,z}");
        }
        JsonObject o = a.getAsJsonObject(key);
        return new BlockPos(o.get("x").getAsInt(), o.get("y").getAsInt(), o.get("z").getAsInt());
    }

    /** Scan entities along the ray and return the closest one struck within {@code maxDist}, or null. */
    private static @Nullable EntityPick nearestEntity(final ServerLevel level, final @Nullable Entity except,
                                                      final Vec3 from, final Vec3 to, final double maxDist) {
        return nearestEntityIn(pickableIn(level, except, new AABB(from, to).inflate(1.0)), from, to, maxDist);
    }

    /** The pickable entities in a volume — one world query, shareable by every ray that fits inside it. */
    private static List<Entity> pickableIn(final ServerLevel level, final @Nullable Entity except, final AABB box) {
        return level.getEntities(except, box, e -> e.isPickable() && !e.isSpectator());
    }

    /**
     * The ray-vs-entity half of {@link #nearestEntity}, over candidates someone else already queried.
     *
     * <p>Split out because the fan called the whole thing <b>once per ray</b>, so a 45-ray fan ran 45
     * {@code getEntities} sweeps over 45 heavily-overlapping boxes inside one cone — a defect at any
     * ray count. Note the plan predicted this was the retina's DOMINANT cost and it is not: measured,
     * the block march dominates and the hoist is worth ~2x. That correction is what bounds how dense
     * later batches can afford to be (PERCEPTION_NAV_FIXES §1.4a).
     */
    private static @Nullable EntityPick nearestEntityIn(final List<Entity> candidates,
                                                        final Vec3 from, final Vec3 to, final double maxDist) {
        EntityPick best = null;
        for (Entity e : candidates) {
            AABB box = e.getBoundingBox().inflate(e.getPickRadius());
            Optional<Vec3> clip = box.clip(from, to);
            Vec3 point;
            double dist;
            if (box.contains(from)) {
                point = from;      // origin already inside the entity
                dist = 0.0;
            } else if (clip.isPresent()) {
                point = clip.get();
                dist = from.distanceTo(point);
            } else {
                continue;
            }
            if (dist <= maxDist && (best == null || dist < best.distance())) {
                best = new EntityPick(e, point, dist);
            }
        }
        return best;
    }

    /**
     * Describe a cell a sightline landed on: the block, its affordance flags (the next question a hit
     * raises — mineable? walkable? hazard?), its position, and the side the ray entered through.
     * `face` is omitted only for a hit the ray started INSIDE (a body with its head in a block),
     * which has no entry face. Replaces the old clip-result describer; the cell walk is now the one
     * source of sightline truth, so there is one definition rather than two that could disagree.
     */
    private static JsonObject describeSighting(final Sightlines.Sighting hit) {
        JsonObject b = new JsonObject();
        b.addProperty("block", BuiltInRegistries.BLOCK.getKey(hit.state().getBlock()).toString());
        b.addProperty("aff", Affordances.flags(hit.state()));
        addPos(b, "pos", hit.pos());
        if (hit.face() != null) {
            b.addProperty("face", hit.face().getName());
        }
        if (hit.throughFluid()) {
            // Provenance the navigation side needs: this was seen ACROSS water, so "walkable sand"
            // here does not mean the body can walk to it (§1.1 — the root of "walking into water").
            b.addProperty("through_fluid", true);
        }
        return b;
    }

    private static JsonObject describeEntity(final Entity e, final Vec3 point) {
        return describeEntity(e, point, true);
    }

    /** Compact by default in list contexts: uuid/velocity/speed are rarely load-bearing and cost
     * ~40% of each entity row — opt back in with detail:"full". Single-entity reads stay full. */
    private static JsonObject describeEntity(final Entity e, final Vec3 point, final boolean full) {
        JsonObject o = new JsonObject();
        o.addProperty("id", e.getId());
        if (full) {
            o.addProperty("uuid", e.getUUID().toString());
        }
        o.addProperty("type", BuiltInRegistries.ENTITY_TYPE.getKey(e.getType()).toString());
        o.addProperty("name", e.getDisplayName() == null ? e.getType().toShortString() : e.getDisplayName().getString());
        // Freshness truth: an entity in a loaded-but-not-ticking chunk (e.g. one a read paged in)
        // is frozen at its as-saved state — without this flag it reads exactly like a live one.
        // Emitted only when frozen; the common case (live) stays out of every row.
        if (e.level() instanceof ServerLevel sl && !sl.isPositionEntityTicking(e.blockPosition())) {
            o.addProperty("ticking", false);
        }
        addVec(o, "pos", e.position());
        if (full) {
            Vec3 vel = e.getDeltaMovement();
            addVec(o, "velocity", vel); // blocks per tick
            o.addProperty("speed", vel.length());
        }
        if (e instanceof LivingEntity le) {
            o.addProperty("health", le.getHealth());
            o.addProperty("maxHealth", le.getMaxHealth());
        }
        return o;
    }

    // ---- origin resolution (the embodiment seam) -----------------------------

    /**
     * A vantage point for observation: which level, where the eye is, and which way it looks (normalized).
     * Deliberately <em>not</em> an embodiment — it says where information comes from, never what the AI may
     * command. Bodies that act get a separate actuator contract (ARCHITECTURE.md).
     */
    public record Origin(ServerLevel level, Vec3 eye, Vec3 view, String label, @Nullable Entity source) {}

    private record EntityPick(Entity entity, Vec3 point, double distance) {}

    /**
     * Resolve the vantage point for a perception read. Precedence:
     * <ul>
     *   <li>{@code drone: true} — the active {@link com.mattmc.mcptoolkit.drone.DroneEntity}'s eye and
     *       facing (facing still overridable), otherwise</li>
     *   <li>an explicit {@code origin} {x,y,z} (facing from {@code direction} or {@code yaw}/{@code pitch},
     *       default level = overworld), otherwise</li>
     *   <li>the named {@code player}, otherwise the first online player (facing from its own look, unless
     *       {@code direction} or {@code yaw}/{@code pitch} override it).</li>
     * </ul>
     * This resolves <em>where the sensor is</em>, nothing more — adding an origin here grants that body no
     * ability to act. Acting bodies get their own contract (see ARCHITECTURE.md, actuator seam).
     */
    static Origin resolveOrigin(final JsonObject a, final MinecraftServer server,
                                final @Nullable String session) {
        @Nullable Vec3 overrideView = viewOverride(a);

        // The body is a first-class origin: its eye IS the sensor. Same tools, third vantage.
        // Per-session bodies: `drone: true` means YOUR session's ACTIVE body — the possessed mob
        // while a possession is live, otherwise your drone. The ghost sees through whichever body
        // it inhabits.
        if (a.has("drone") && !a.get("drone").isJsonNull() && a.get("drone").getAsBoolean()) {
            net.minecraft.world.entity.LivingEntity body =
                com.mattmc.mcptoolkit.drone.DroneTools.activeBodyFor(session);
            if (body == null) {
                throw new IllegalStateException(
                    "your session has no body — spawn one with bot_body {action:\"spawn\"} first");
            }
            Vec3 eye = body.getEyePosition();
            Vec3 view = overrideView != null ? overrideView : body.getViewVector(1.0F);
            String label = body instanceof com.mattmc.mcptoolkit.drone.WalkerEntity ? "walker"
                : body instanceof com.mattmc.mcptoolkit.drone.DroneEntity ? "drone"
                : "possessed " + net.minecraft.core.registries.BuiltInRegistries.ENTITY_TYPE
                    .getKey(body.getType());
            return new Origin((ServerLevel) body.level(), eye, view, label, body);
        }

        if (a.has("origin") && !a.get("origin").isJsonNull()) {
            JsonObject o = a.getAsJsonObject("origin");
            Vec3 eye = new Vec3(o.get("x").getAsDouble(), o.get("y").getAsDouble(), o.get("z").getAsDouble());
            Vec3 view = overrideView != null ? overrideView : new Vec3(0, 0, 1);
            return new Origin(server.overworld(), eye, view, "coords", null);
        }

        ServerPlayer player;
        if (a.has("player") && !a.get("player").isJsonNull()) {
            String name = a.get("player").getAsString();
            player = server.getPlayerList().getPlayerByName(name);
            if (player == null) {
                throw new IllegalArgumentException("no player named '" + name + "' online");
            }
        } else {
            List<ServerPlayer> players = server.getPlayerList().getPlayers();
            if (players.isEmpty()) {
                throw new IllegalStateException("no player online; pass an explicit `origin` {x,y,z}");
            }
            player = players.get(0);
        }

        Vec3 eye = player.getEyePosition();
        Vec3 view = overrideView != null ? overrideView : player.getViewVector(1.0F);
        return new Origin((ServerLevel) player.level(), eye, view, "player " + player.getGameProfile().name(),
            player);
    }

    /** A caller-supplied view direction from {@code direction} {x,y,z} or {@code yaw}/{@code pitch}, or null. */
    private static @Nullable Vec3 viewOverride(final JsonObject a) {
        if (a.has("direction") && !a.get("direction").isJsonNull()) {
            JsonObject d = a.getAsJsonObject("direction");
            Vec3 v = new Vec3(d.get("x").getAsDouble(), d.get("y").getAsDouble(), d.get("z").getAsDouble());
            if (v.lengthSqr() < 1.0e-9) {
                throw new IllegalArgumentException("`direction` must be non-zero");
            }
            return v.normalize();
        }
        if (a.has("yaw") || a.has("pitch")) {
            float yaw = a.has("yaw") && !a.get("yaw").isJsonNull() ? a.get("yaw").getAsFloat() : 0.0F;
            float pitch = a.has("pitch") && !a.get("pitch").isJsonNull() ? a.get("pitch").getAsFloat() : 0.0F;
            return Vec3.directionFromRotation(pitch, yaw);
        }
        return null;
    }

    // ---- helpers -------------------------------------------------------------

    /**
     * Standard observation envelope (ARCHITECTURE.md): what kind of read this was
     * ({@code perception_mode}) and when ({@code game_tick}, world game time in ticks — the timestamp that
     * makes staleness measurable once observations are remembered).
     */
    static void addEnvelope(final JsonObject r, final ServerLevel level, final String mode) {
        r.addProperty("perception_mode", mode);
        r.addProperty("game_tick", level.getGameTime());
        // Which world was read — identity over enforcement: a hidden dimension assumption is a
        // silent-wrong-answer path (overworld blocks reported for Nether coordinates).
        r.addProperty("dimension", level.dimension().identifier().toString());
    }

    /**
     * Resolve the optional {@code dimension} arg for tools that take absolute coordinates with no
     * origin to infer a world from. Default: overworld — but the choice is stamped into the envelope
     * so it is never silent. Shared with the world-edit tools ({@code set_blocks}, {@code place_shape},
     * {@code bot_spawn}) so the read and write sides resolve dimensions identically.
     */
    public static ServerLevel levelArg(final MinecraftServer server, final JsonObject a) {
        if (!a.has("dimension") || a.get("dimension").isJsonNull()) {
            return server.overworld();
        }
        String id = a.get("dimension").getAsString();
        ServerLevel level = server.getLevel(net.minecraft.resources.ResourceKey.create(
            net.minecraft.core.registries.Registries.DIMENSION,
            net.minecraft.resources.Identifier.parse(id)));
        if (level == null) {
            throw new IllegalArgumentException("unknown dimension: " + id
                + " (e.g. minecraft:overworld, minecraft:the_nether, minecraft:the_end)");
        }
        return level;
    }

    /**
     * True when the straight line from {@code from} to the entity's eyes crosses no colliding blocks;
     * null when the segment crosses a non-resident chunk — vanilla clip would synchronously
     * load-or-generate it, and a per-entity embellishment is not worth that (nor may an unknown
     * sightline masquerade as a verdict, in either direction).
     */
    private static @Nullable Boolean hasLineOfSight(final ServerLevel level, final Vec3 from, final Entity e) {
        Vec3 eye = e.getEyePosition();
        if (!segmentChunksLoaded(level, from, eye)) {
            return null;
        }
        BlockHitResult hit = level.clip(new ClipContext(from, eye,
            ClipContext.Block.COLLIDER, ClipContext.Fluid.NONE, CollisionContext.empty()));
        return hit.getType() == HitResult.Type.MISS;
    }

    private static double clampRange(final JsonObject a) {
        if (!a.has("range") || a.get("range").isJsonNull()) {
            return DEFAULT_RANGE;
        }
        double range = a.get("range").getAsDouble();
        if (range <= 0) {
            throw new IllegalArgumentException("`range` must be positive");
        }
        return Math.min(range, MAX_RANGE);
    }

    private static double clampRadius(final JsonObject a) {
        if (!a.has("radius") || a.get("radius").isJsonNull()) {
            return DEFAULT_RADIUS;
        }
        double radius = a.get("radius").getAsDouble();
        if (radius <= 0) {
            throw new IllegalArgumentException("`radius` must be positive");
        }
        return Math.min(radius, MAX_RADIUS);
    }

    private static int clampLimit(final JsonObject a) {
        if (!a.has("limit") || a.get("limit").isJsonNull()) {
            return DEFAULT_LIMIT;
        }
        int limit = a.get("limit").getAsInt();
        if (limit <= 0) {
            throw new IllegalArgumentException("`limit` must be positive");
        }
        return Math.min(limit, MAX_LIMIT);
    }

    private static void addVec(final JsonObject r, final String key, final Vec3 v) {
        // 3 decimals: sub-millimeter precision is meaningless in-world, and raw doubles serialize
        // with 15+ digit tails that are pure token waste in every response.
        JsonObject o = new JsonObject();
        o.addProperty("x", round3(v.x));
        o.addProperty("y", round3(v.y));
        o.addProperty("z", round3(v.z));
        r.add(key, o);
    }

    private static double round3(final double v) {
        return Math.round(v * 1000.0) / 1000.0;
    }

    private static void addPos(final JsonObject r, final String key, final BlockPos p) {
        JsonObject o = new JsonObject();
        o.addProperty("x", p.getX());
        o.addProperty("y", p.getY());
        o.addProperty("z", p.getZ());
        r.add(key, o);
    }
}
