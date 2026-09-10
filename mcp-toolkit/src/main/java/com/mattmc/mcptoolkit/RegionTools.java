package com.mattmc.mcptoolkit;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.ReadSupport.ChunkLoader;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Registry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.tags.FluidTags;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.ai.village.poi.PoiManager;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.ChunkAccess;
import net.minecraft.world.level.chunk.status.ChunkStatus;
import net.minecraft.world.level.levelgen.Heightmap;
import net.minecraft.world.level.levelgen.structure.Structure;
import net.minecraft.world.level.levelgen.structure.StructureStart;
import net.minecraft.world.phys.AABB;

import java.util.Map;

import static com.mattmc.mcptoolkit.ReadSupport.coverage;
import static com.mattmc.mcptoolkit.ReadSupport.loadArg;

/**
 * Region rollup — one perception rung above {@code scene_summary}: a tile grid of aggregate
 * statistics over square-kilometre-ish extents, derived on demand from the world (no cache; the
 * world is the world model — see REPRESENTATION_DESIGN §2, decision 2). Vocabulary is semantic on
 * purpose — structure names, biome names, block ids — because models anchor on meaningful labels
 * (label-permutation evidence, RESEARCH_WORLD_REPRESENTATION.md).
 *
 * <p>Coverage counts CHUNKS here (the block tools count columns): tiles over unreadable chunks are
 * reported {@code state:"unread"} with no statistics — never synthesized — and paging rides the
 * shared {@link ChunkLoader} budget, so reading never generates terrain.
 */
public final class RegionTools {
    private RegionTools() {}

    /** Hard cap on chunks per call — fail-fast, never silently shrink (that would fake coverage). */
    private static final int MAX_CHUNKS = 256;
    private static final int DEFAULT_TILES = 3;
    private static final int DEFAULT_TILE_CHUNKS = 4;
    /** Heightmap sampling stride in blocks (design-fixed: 256 samples per 64×64 tile). */
    private static final int STRIDE = 4;
    /** Biome samples per tile axis (4×4 = 16 samples/tile; biomes are 4-block cells anyway). */
    private static final int BIOME_AXIS_SAMPLES = 4;
    /**
     * Connectivity sampling stride — finer than {@link #STRIDE} because thin barriers (rivers,
     * ravines) are exactly what the analysis exists to see; sub-stride obstacles remain invisible,
     * which the tool description declares.
     */
    private static final int CONNECT_STRIDE = 2;
    private static final int CONNECT_MAX_POINTS = 8;
    private static final int CONNECT_TOP_COMPONENTS = 8;

    public static void register() {
        McpTools.register(ToolDef.of(
            "get_region_summary",
            "Aggregate survey of a large area as a grid of tiles — the rung ABOVE scene_summary "
                + "(scene_summary ≈ 2 chunks; one default call here covers 12×12 chunks = 192×192 "
                + "blocks). Per tile: ground-height stats, top-block histogram, water/lava columns, "
                + "structure names (authoritative world data, e.g. minecraft:village_plains), POI "
                + "count + kinds (the village-ness signal), entity counts, and the biome mix. "
                + "`center` {x,z} centres a `tiles`×`tiles` grid (default 3) of `tile_chunks`-chunk "
                + "tiles (default 4 → 64×64 blocks per tile). Hard cap " + MAX_CHUNKS + " chunks per "
                + "call — oversized requests fail fast rather than silently shrink. Heights are "
                + "sampled at stride " + STRIDE + "; entity counts cover only chunks whose entities "
                + "are currently loaded. coverage counts CHUNKS; tiles over unreadable chunks say "
                + "state:\"unread\" with no statistics (never synthesized), and the sentence leads "
                + "with the caveat when partial. Reading never generates terrain. "
                + "`connectivity`:true (off by default — costs extra sampling) additionally "
                + "computes surface-walk connected components over the whole area (samples at "
                + "stride " + CONNECT_STRIDE + "; adjacent samples connect when the ground step is "
                + "≤1 and neither is water/lava): tiles gain `walk_components` (which components "
                + "touch them) and the result a `connectivity` rollup, answering \"is A reachable "
                + "from B without crossing water\" region-wide without mental map-building. Pass "
                + "`points` [{x,z}…, max " + CONNECT_MAX_POINTS + "] to get each point's component "
                + "and a tri-state `connected` verdict: true = same component (definitive at "
                + "sample resolution), false = provably separate within the surveyed area, null = "
                + "unread cells could join them. Sub-stride obstacles (fences, thin walls) are "
                + "below resolution — check_path is the definitive point-to-point verdict.",
            Schemas.objectOpt(Schemas.object(
                "center", Schemas.object("x", Schemas.integer(), "z", Schemas.integer()),
                "tiles", Schemas.integer("Grid side in tiles, default " + DEFAULT_TILES + "."),
                "tile_chunks", Schemas.integer("Tile side in chunks, default " + DEFAULT_TILE_CHUNKS + " (= 64×64 blocks)."),
                "connectivity", Schemas.bool("Also compute surface-walk connected components (default false)."),
                "points", Schemas.array(Schemas.object("x", Schemas.integer(), "z", Schemas.integer())),
                "dimension", Schemas.str("Dimension id, default minecraft:overworld."),
                "load", Schemas.bool("Pull absent chunks in so they can be read. Default true.")),
                "tiles", "tile_chunks", "connectivity", "points", "dimension", "load"),
            ExecutionContext.SERVER,
            Mechanism.OBSERVE,
            (ctx, a) -> regionSummary(WorldPerceptionTools.levelArg(ctx.serverOrThrow(), a), a)));
    }

    private static JsonObject regionSummary(final ServerLevel level, final JsonObject a) {
        JsonObject centerArg = a.getAsJsonObject("center");
        if (centerArg == null) {
            throw new IllegalArgumentException("missing 'center' {x,z}");
        }
        int cx = centerArg.get("x").getAsInt();
        int cz = centerArg.get("z").getAsInt();
        int tiles = optInt(a, "tiles", DEFAULT_TILES);
        int tileChunks = optInt(a, "tile_chunks", DEFAULT_TILE_CHUNKS);
        if (tiles < 1 || tileChunks < 1) {
            throw new IllegalArgumentException("tiles and tile_chunks must be at least 1");
        }
        int sideChunks = tiles * tileChunks;
        int totalChunks = sideChunks * sideChunks;
        if (totalChunks > MAX_CHUNKS) {
            throw new IllegalArgumentException("too_large: " + totalChunks + " chunks (cap "
                + MAX_CHUNKS + ") — fewer/smaller tiles, or several calls");
        }
        // Chunk-aligned grid centred on the centre's chunk.
        int minChunkX = (cx >> 4) - sideChunks / 2;
        int minChunkZ = (cz >> 4) - sideChunks / 2;

        ChunkLoader loader = new ChunkLoader(level, loadArg(a));
        Registry<Structure> structures = level.registryAccess().lookupOrThrow(Registries.STRUCTURE);
        PoiManager pois = level.getPoiManager();

        JsonArray tileArr = new JsonArray();
        // Kept by grid position so the connectivity pass can attach walk_components after labeling.
        JsonObject[][] tileRefs = new JsonObject[tiles][tiles];
        int chunksRead = 0;
        int chunksUnread = 0;
        // Region-level rollups for the sentence.
        java.util.HashMap<String, Integer> regionBiomes = new java.util.HashMap<>();
        java.util.TreeSet<String> regionStructures = new java.util.TreeSet<>();
        long regionPois = 0;
        int heightMin = Integer.MAX_VALUE;
        int heightMax = Integer.MIN_VALUE;
        int players = 0;
        int hostiles = 0;
        int entityChunksSearched = 0;
        int entityChunksTotal = 0;

        for (int tx = 0; tx < tiles; tx++) {
            for (int tz = 0; tz < tiles; tz++) {
                int tileMinChunkX = minChunkX + tx * tileChunks;
                int tileMinChunkZ = minChunkZ + tz * tileChunks;
                int minX = tileMinChunkX << 4;
                int minZ = tileMinChunkZ << 4;
                int sizeBlocks = tileChunks * 16;

                JsonObject t = new JsonObject();
                tileRefs[tx][tz] = t;
                JsonObject tileId = new JsonObject();
                tileId.addProperty("x", tx);
                tileId.addProperty("z", tz);
                t.add("tile", tileId);
                JsonObject blocks = new JsonObject();
                blocks.addProperty("min_x", minX);
                blocks.addProperty("min_z", minZ);
                blocks.addProperty("size", sizeBlocks);
                t.add("blocks", blocks);

                // Residency, chunk by chunk — statistics only ever cover ready chunks.
                boolean[][] ready = new boolean[tileChunks][tileChunks];
                int tileRead = 0;
                int tileUnread = 0;
                for (int dx = 0; dx < tileChunks; dx++) {
                    for (int dz = 0; dz < tileChunks; dz++) {
                        ready[dx][dz] = loader.ensure(
                            new BlockPos((tileMinChunkX + dx) << 4, 0, (tileMinChunkZ + dz) << 4));
                        if (ready[dx][dz]) {
                            tileRead++;
                        } else {
                            tileUnread++;
                        }
                    }
                }
                chunksRead += tileRead;
                chunksUnread += tileUnread;
                JsonObject chunkCov = new JsonObject();
                chunkCov.addProperty("read", tileRead);
                chunkCov.addProperty("unread", tileUnread);
                t.add("chunks", chunkCov);
                if (tileRead == 0) {
                    t.addProperty("state", "unread");
                    tileArr.add(t);
                    continue;
                }
                t.addProperty("state", tileUnread == 0 ? "complete" : "partial");

                // Heights, surface, fluids — sampled columns in ready chunks only.
                java.util.ArrayList<Integer> heights = new java.util.ArrayList<>();
                java.util.HashMap<String, Integer> surface = new java.util.HashMap<>();
                int water = 0;
                int lava = 0;
                BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
                for (int ox = 0; ox < sizeBlocks; ox += STRIDE) {
                    for (int oz = 0; oz < sizeBlocks; oz += STRIDE) {
                        if (!ready[ox >> 4][oz >> 4]) {
                            continue;
                        }
                        int x = minX + ox;
                        int z = minZ + oz;
                        int groundY = level.getHeight(Heightmap.Types.MOTION_BLOCKING_NO_LEAVES, x, z) - 1;
                        heights.add(groundY);
                        BlockState top = level.getBlockState(m.set(x, groundY, z));
                        surface.merge(BuiltInRegistries.BLOCK.getKey(top.getBlock()).toString(), 1, Integer::sum);
                        if (top.getFluidState().is(FluidTags.WATER)) {
                            water++;
                        } else if (top.getFluidState().is(FluidTags.LAVA)) {
                            lava++;
                        }
                    }
                }
                if (!heights.isEmpty()) {
                    JsonObject ground = ReadSupport.groundStats(heights);
                    t.add("height", ground);
                    heightMin = Math.min(heightMin, ground.get("min").getAsInt());
                    heightMax = Math.max(heightMax, ground.get("max").getAsInt());
                }
                t.add("surface", ReadSupport.histogram(surface, 5));
                JsonObject fluids = new JsonObject();
                fluids.addProperty("water", water);
                fluids.addProperty("lava", lava);
                t.add("fluids", fluids);

                // Structures + POIs, per ready chunk (authoritative world data, semantic names).
                java.util.TreeSet<String> tileStructures = new java.util.TreeSet<>();
                long poiCount = 0;
                java.util.HashMap<String, Integer> poiKinds = new java.util.HashMap<>();
                for (int dx = 0; dx < tileChunks; dx++) {
                    for (int dz = 0; dz < tileChunks; dz++) {
                        if (!ready[dx][dz]) {
                            continue;
                        }
                        int ccx = tileMinChunkX + dx;
                        int ccz = tileMinChunkZ + dz;
                        // Non-blocking FULL fetch — the loader's ensure() above already completed
                        // this chunk, so this is a cache hit. getChunkNow would be null for chunks
                        // that are readable but not in the loaded-chunk map (paged-in reads), which
                        // silently dropped every structure start outside player range.
                        ChunkAccess chunk = level.getChunkSource().getChunk(ccx, ccz, ChunkStatus.FULL, false);
                        if (chunk != null) {
                            for (Map.Entry<Structure, StructureStart> e : chunk.getAllStarts().entrySet()) {
                                if (e.getValue() != null && e.getValue().isValid()) {
                                    var key = structures.getKey(e.getKey());
                                    if (key != null) {
                                        tileStructures.add(key.toString());
                                    }
                                }
                            }
                        }
                        // Materialized, not peek().count() — count() on a sized stream may elide peek.
                        var recs = pois.getInChunk(h -> true, new ChunkPos(ccx, ccz), PoiManager.Occupancy.ANY).toList();
                        poiCount += recs.size();
                        for (var rec : recs) {
                            rec.getPoiType().unwrapKey().ifPresent(
                                k -> poiKinds.merge(k.identifier().toString(), 1, Integer::sum));
                        }
                    }
                }
                JsonArray sArr = new JsonArray();
                tileStructures.forEach(sArr::add);
                t.add("structures", sArr);
                t.addProperty("poi_count", poiCount);
                if (!poiKinds.isEmpty()) {
                    t.add("poi_kinds", ReadSupport.histogram(poiKinds, 5));
                }
                regionStructures.addAll(tileStructures);
                regionPois += poiCount;

                // Entities: one AABB query per tile — spatial (X-ray) and index-backed. Block
                // residency above is a DIFFERENT ladder: a freshly paged chunk has no entity data
                // yet (it arrives through the entity manager's async inbox a tick later), so a tile
                // marked complete could still be entirely entity-unread — the counts used to come
                // out as a confident 0 over it. Same rule as get_entities 0.4.3/scene_summary: the
                // verdict is null when NO chunk in the tile is entity-searchable, and lower-bound
                // counts carry their searched/unsearched accounting otherwise.
                int entitySearchable = 0;
                for (int dx = 0; dx < tileChunks; dx++) {
                    for (int dz = 0; dz < tileChunks; dz++) {
                        if (level.areEntitiesLoaded(ChunkPos.pack(tileMinChunkX + dx, tileMinChunkZ + dz))) {
                            entitySearchable++;
                        }
                    }
                }
                int tileChunkCount = tileChunks * tileChunks;
                entityChunksSearched += entitySearchable;
                entityChunksTotal += tileChunkCount;
                AABB box = new AABB(minX, level.getMinY(), minZ,
                    minX + sizeBlocks, level.getMaxY(), minZ + sizeBlocks);
                int p = 0;
                int hostile = 0;
                int passive = 0;
                int items = 0;
                int found = 0;
                for (Entity e : level.getEntities((Entity) null, box, x -> true)) {
                    found++;
                    if (e instanceof Player) {
                        p++;
                    } else if (e instanceof Enemy) {
                        hostile++;
                    } else if (e instanceof ItemEntity) {
                        items++;
                    } else if (e instanceof LivingEntity) {
                        passive++;
                    }
                }
                // Found entities are facts even over "unsearchable" chunks (a freshly added mob is
                // queryable before its chunk's persisted entity data loads) — only the confident
                // ZERO is untrustworthy there. So: null solely when nothing was searchable AND
                // nothing was found; otherwise lower-bound counts + their residency accounting.
                if (entitySearchable == 0 && found == 0) {
                    t.add("entities", null); // unknown, not zero
                } else {
                    JsonObject ents = new JsonObject();
                    ents.addProperty("players", p);
                    ents.addProperty("hostile", hostile);
                    ents.addProperty("passive", passive);
                    ents.addProperty("items", items);
                    ents.addProperty("searched_chunks", entitySearchable);
                    ents.addProperty("unsearched_chunks", tileChunkCount - entitySearchable);
                    t.add("entities", ents);
                    players += p;
                    hostiles += hostile;
                }

                // Biome mix: 16 samples at ground height (biomes are 4×4×4 cells — this saturates
                // a 64×64 tile's horizontal variation well enough for a mix answer).
                java.util.HashMap<String, Integer> biomes = new java.util.HashMap<>();
                int step = Math.max(1, sizeBlocks / BIOME_AXIS_SAMPLES);
                for (int ox = step / 2; ox < sizeBlocks; ox += step) {
                    for (int oz = step / 2; oz < sizeBlocks; oz += step) {
                        if (!ready[ox >> 4][oz >> 4]) {
                            continue;
                        }
                        int x = minX + ox;
                        int z = minZ + oz;
                        int y = level.getHeight(Heightmap.Types.MOTION_BLOCKING_NO_LEAVES, x, z);
                        String biome = level.getBiome(m.set(x, y, z)).unwrapKey()
                            .map(k -> k.identifier().toString()).orElse("unknown");
                        biomes.merge(biome, 1, Integer::sum);
                        regionBiomes.merge(biome, 1, Integer::sum);
                    }
                }
                t.add("biomes", ReadSupport.histogram(biomes, 4));

                tileArr.add(t);
            }
        }

        JsonObject r = new JsonObject();
        // Opt-in (escalation, not default — extra sampling only when topology is the question);
        // giving `points` implies it.
        boolean connect = (a.has("connectivity") && !a.get("connectivity").isJsonNull()
            && a.get("connectivity").getAsBoolean())
            || (a.has("points") && a.get("points").isJsonArray()
                && !a.getAsJsonArray("points").isEmpty());
        if (connect) {
            r.add("connectivity", connectivity(level, loader, minChunkX << 4, minChunkZ << 4,
                sideChunks * 16, tileChunks * 16, tiles, tileRefs, a));
        }
        r.add("tiles", tileArr);
        JsonObject extent = new JsonObject();
        extent.addProperty("min_x", minChunkX << 4);
        extent.addProperty("min_z", minChunkZ << 4);
        extent.addProperty("size", sideChunks * 16);
        r.add("extent", extent);
        r.addProperty("sentence", sentence(totalChunks, chunksRead, chunksUnread, sideChunks,
            regionBiomes, regionStructures, regionPois, heightMin, heightMax, players, hostiles,
            entityChunksSearched, entityChunksTotal));
        r.add("coverage", coverage(chunksRead, chunksUnread, totalChunks, false, loader));
        WorldPerceptionTools.addEnvelope(r, level, "spatial");
        return r;
    }

    /**
     * Surface-walk connected components over the survey area — region-scale topology computed
     * tool-side, because integrating a map from sequential observations is the best-documented
     * model failure mode (RESEARCH_WORLD_REPRESENTATION.md). Semantics are deliberately modest and
     * declared: samples at {@link #CONNECT_STRIDE}, adjacency = ground step ≤1 and neither cell
     * water/lava; sub-stride obstacles are invisible. The tri-state honesty rule carries over:
     * {@code connected} is true on shared component, false only when separation is provable within
     * the surveyed cells, null when unread cells could hide the join.
     */
    private static JsonObject connectivity(final ServerLevel level, final ChunkLoader loader,
                                           final int minX, final int minZ, final int sideBlocks,
                                           final int tileBlocks, final int tiles,
                                           final JsonObject[][] tileRefs, final JsonObject a) {
        final int n = sideBlocks / CONNECT_STRIDE;
        final int unreadCell = -3;
        final int waterCell = -2;
        final int openCell = -1;
        int[] cell = new int[n * n];
        int[] gy = new int[n * n];
        int waterCells = 0;
        int unreadCells = 0;
        BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
        for (int i = 0; i < n; i++) {
            for (int j = 0; j < n; j++) {
                int x = minX + i * CONNECT_STRIDE;
                int z = minZ + j * CONNECT_STRIDE;
                int idx = i * n + j;
                if (!loader.ensure(m.set(x, 0, z))) {
                    cell[idx] = unreadCell;
                    unreadCells++;
                    continue;
                }
                int g = level.getHeight(Heightmap.Types.MOTION_BLOCKING_NO_LEAVES, x, z) - 1;
                gy[idx] = g;
                BlockState top = level.getBlockState(m.set(x, g, z));
                if (top.getFluidState().is(FluidTags.WATER) || top.getFluidState().is(FluidTags.LAVA)) {
                    cell[idx] = waterCell;
                    waterCells++;
                } else {
                    cell[idx] = openCell;
                }
            }
        }

        // BFS labeling; a component remembers whether it borders an unread cell — that is what
        // separates a provable "false" from an honest "null" later.
        java.util.ArrayList<Integer> sizes = new java.util.ArrayList<>();
        java.util.ArrayList<Boolean> unreadEdge = new java.util.ArrayList<>();
        java.util.ArrayDeque<Integer> queue = new java.util.ArrayDeque<>();
        int nextId = 0;
        for (int s = 0; s < n * n; s++) {
            if (cell[s] != openCell) {
                continue;
            }
            int id = nextId++;
            int size = 0;
            boolean touch = false;
            cell[s] = id;
            queue.add(s);
            while (!queue.isEmpty()) {
                int cur = queue.poll();
                size++;
                int ci = cur / n;
                int cj = cur % n;
                for (int dir = 0; dir < 4; dir++) {
                    int ni = ci + (dir == 0 ? 1 : dir == 1 ? -1 : 0);
                    int nj = cj + (dir == 2 ? 1 : dir == 3 ? -1 : 0);
                    if (ni < 0 || nj < 0 || ni >= n || nj >= n) {
                        continue;
                    }
                    int nidx = ni * n + nj;
                    if (cell[nidx] == unreadCell) {
                        touch = true;
                        continue;
                    }
                    if (cell[nidx] != openCell || Math.abs(gy[nidx] - gy[cur]) > 1) {
                        continue;
                    }
                    cell[nidx] = id;
                    queue.add(nidx);
                }
            }
            sizes.add(size);
            unreadEdge.add(touch);
        }

        // Rank ids by size so component 0 is always "the big landmass" — stable, meaningful labels.
        Integer[] order = new Integer[nextId];
        for (int i = 0; i < nextId; i++) {
            order[i] = i;
        }
        java.util.Arrays.sort(order, (p, q) -> sizes.get(q) - sizes.get(p));
        int[] rank = new int[nextId];
        for (int i = 0; i < nextId; i++) {
            rank[order[i]] = i;
        }

        // Which components touch each tile — the "region adjacency sketch" answer, per tile.
        for (int tx = 0; tx < tiles; tx++) {
            for (int tz = 0; tz < tiles; tz++) {
                JsonObject t = tileRefs[tx][tz];
                if (t == null) {
                    continue;
                }
                java.util.TreeSet<Integer> present = new java.util.TreeSet<>();
                int i0 = tx * tileBlocks / CONNECT_STRIDE;
                int i1 = (tx + 1) * tileBlocks / CONNECT_STRIDE;
                int j0 = tz * tileBlocks / CONNECT_STRIDE;
                int j1 = (tz + 1) * tileBlocks / CONNECT_STRIDE;
                for (int i = i0; i < i1 && i < n; i++) {
                    for (int j = j0; j < j1 && j < n; j++) {
                        int c = cell[i * n + j];
                        if (c >= 0) {
                            present.add(rank[c]);
                        }
                    }
                }
                if (!present.isEmpty()) {
                    JsonArray comps = new JsonArray();
                    present.stream().limit(CONNECT_TOP_COMPONENTS).forEach(comps::add);
                    t.add("walk_components", comps);
                }
            }
        }

        JsonObject out = new JsonObject();
        out.addProperty("stride", CONNECT_STRIDE);
        JsonArray compArr = new JsonArray();
        for (int i = 0; i < nextId && i < CONNECT_TOP_COMPONENTS; i++) {
            int old = order[i];
            JsonObject c = new JsonObject();
            c.addProperty("id", i);
            c.addProperty("cells", sizes.get(old));
            if (unreadEdge.get(old)) {
                c.addProperty("touches_unread", true);
            }
            compArr.add(c);
        }
        out.add("components", compArr);
        out.addProperty("components_total", nextId);
        out.addProperty("water_cells", waterCells);
        out.addProperty("unread_cells", unreadCells);

        if (a.has("points") && a.get("points").isJsonArray() && !a.getAsJsonArray("points").isEmpty()) {
            JsonArray pts = a.getAsJsonArray("points");
            if (pts.size() > CONNECT_MAX_POINTS) {
                throw new IllegalArgumentException("too many points (" + pts.size() + " > "
                    + CONNECT_MAX_POINTS + ")");
            }
            JsonArray outPts = new JsonArray();
            java.util.ArrayList<Integer> pointComps = new java.util.ArrayList<>();
            java.util.ArrayList<Boolean> pointTouch = new java.util.ArrayList<>();
            boolean anyUnlabeled = false;
            for (int k = 0; k < pts.size(); k++) {
                JsonObject p = pts.get(k).getAsJsonObject();
                int px = p.get("x").getAsInt();
                int pz = p.get("z").getAsInt();
                if (px < minX || pz < minZ || px >= minX + sideBlocks || pz >= minZ + sideBlocks) {
                    throw new IllegalArgumentException("point (" + px + "," + pz + ") is outside "
                        + "the surveyed area [" + minX + "," + minZ + ")–(" + (minX + sideBlocks)
                        + "," + (minZ + sideBlocks) + ") — recenter or enlarge the survey");
                }
                int i = Math.min((px - minX) / CONNECT_STRIDE, n - 1);
                int j = Math.min((pz - minZ) / CONNECT_STRIDE, n - 1);
                int c = cell[i * n + j];
                JsonObject po = new JsonObject();
                po.addProperty("x", px);
                po.addProperty("z", pz);
                if (c >= 0) {
                    po.addProperty("component", rank[c]);
                    pointComps.add(rank[c]);
                    pointTouch.add(unreadEdge.get(c));
                } else {
                    po.add("component", null);
                    po.addProperty("cell", c == waterCell ? "water" : "unread");
                    anyUnlabeled = true;
                }
                outPts.add(po);
            }
            out.add("points", outPts);
            if (pts.size() >= 2) {
                if (anyUnlabeled) {
                    out.add("connected", null);
                    out.addProperty("connected_note", "a point sits on water or an unread cell — "
                        + "it has no walk component to compare; use check_path for the definitive "
                        + "answer");
                } else if (new java.util.HashSet<>(pointComps).size() == 1) {
                    out.addProperty("connected", true);
                } else if (pointTouch.stream().allMatch(Boolean::booleanValue) && unreadCells > 0) {
                    // Every involved component borders unread cells, so a join could hide there —
                    // "separate" would be a guess, not a finding.
                    out.add("connected", null);
                    out.addProperty("connected_note", "separate at sample resolution, but every "
                        + "involved component borders unread cells that could join them — load the "
                        + "area or use check_path");
                } else {
                    out.addProperty("connected", false);
                }
            }
        }
        return out;
    }

    /** One-line gist; the coverage caveat comes FIRST when partial (same rule as scene_summary). */
    private static String sentence(final int total, final int read, final int unread, final int sideChunks,
                                   final java.util.HashMap<String, Integer> biomes,
                                   final java.util.TreeSet<String> structures,
                                   final long pois, final int hMin, final int hMax,
                                   final int players, final int hostiles,
                                   final int entitySearched, final int entityTotal) {
        StringBuilder sb = new StringBuilder();
        if (read == 0) {
            return "[UNOBSERVED] none of the " + total + " chunks were readable — this summarizes nothing.";
        }
        if (unread > 0) {
            sb.append("[PARTIAL — ").append(unread).append(" of ").append(total)
                .append(" chunks unread] ");
        }
        sb.append(sideChunks * 16).append("×").append(sideChunks * 16).append(" blocks");
        if (!biomes.isEmpty()) {
            String top = biomes.entrySet().stream()
                .max(Map.Entry.comparingByValue()).orElseThrow().getKey();
            sb.append(", mostly ").append(top.replace("minecraft:", ""));
        }
        if (hMin <= hMax) {
            sb.append(", ground y ").append(hMin).append("–").append(hMax);
        }
        if (!structures.isEmpty()) {
            sb.append("; structures: ").append(String.join(", ",
                structures.stream().map(s -> s.replace("minecraft:", "")).toList()));
        }
        if (pois > 0) {
            sb.append("; ").append(pois).append(" POI(s)");
        }
        if (players > 0) {
            sb.append("; ").append(players).append(" player(s)");
        }
        if (hostiles > 0) {
            sb.append("; ").append(hostiles).append(" hostile(s)");
        }
        if (entitySearched < entityTotal) {
            // The threat claims above only cover entity-searchable chunks — say so in the same
            // breath, or "no hostiles" reads as a fact about chunks nothing ever searched.
            sb.append(" (entity counts cover ").append(entitySearched).append(" of ")
              .append(entityTotal).append(" chunks — the rest have no entity data loaded)");
        }
        return sb.append(".").toString();
    }

    private static int optInt(final JsonObject o, final String key, final int fallback) {
        return o.has(key) && !o.get(key).isJsonNull() ? o.get(key).getAsInt() : fallback;
    }
}
