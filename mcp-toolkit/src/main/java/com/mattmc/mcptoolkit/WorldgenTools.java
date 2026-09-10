package com.mattmc.mcptoolkit;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.ReadSupport.ChunkLoader;
import net.minecraft.core.Holder;
import net.minecraft.core.QuartPos;
import net.minecraft.core.registries.Registries;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.NoiseColumn;
import net.minecraft.world.level.biome.Biome;
import net.minecraft.world.level.biome.BiomeSource;
import net.minecraft.world.level.biome.Climate;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.ChunkAccess;
import net.minecraft.world.level.chunk.ChunkGenerator;
import net.minecraft.world.level.levelgen.Heightmap;
import net.minecraft.world.level.levelgen.NoiseBasedChunkGenerator;
import net.minecraft.world.level.levelgen.NoiseGeneratorSettings;
import net.minecraft.world.level.levelgen.RandomState;
import net.minecraft.core.BlockPos;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static com.mattmc.mcptoolkit.ReadSupport.loadArg;

/**
 * {@code preview_worldgen} - phase 1 of {@code WORLDGEN_ITERATION_DESIGN.md}, RELEASE_1.md SD4.
 *
 * <p>The worldgen loop today is <em>edit JSON, restart the world, fly ten thousand blocks, look at
 * different terrain</em>. The last clause is the expensive one: the iterations are not comparable,
 * because each one is a different landscape in a different place. This tool asks the loaded
 * generator directly what it makes at a coordinate - the same calls vanilla itself uses to place a
 * structure or find a spawn - so the same view can be re-evaluated after every restart, and so the
 * question "did my edit actually land" has an answer that is not a screenshot.
 *
 * <p><b>It generates nothing.</b> {@code getBaseHeight} and {@code getBaseColumn} run the density
 * router over a column and return; no chunk, no ticket, no disk. That keeps
 * {@link ReadSupport.ChunkLoader}'s rule intact in the strongest possible form - a virgin chunk is
 * not merely "reported, not paid for" here, it is never touched - and it means a caller can ask
 * about ground a thousand blocks past the loaded edge for microseconds.
 *
 * <p><b>The boundary, and it is declared in the description, in the reply and here.</b>
 * {@code iterateNoiseColumn} is the density-function router and the aquifer, and nothing else. It
 * runs <em>before</em> surface rules ({@code buildSurface} needs a {@code WorldGenRegion}), before
 * carvers, before features and before structures. So this tool sees a {@code noise_settings} or
 * {@code density_function} edit instantly, and sees a {@code surface_rule} edit, a new carver, a
 * moved ore or a changed tree count <b>not at all</b>. A tool that answered "the terrain" and
 * silently meant "the noise" would be this repo's succeeds-falsely class; the word used throughout
 * is {@code noise_*}, never {@code terrain}.
 *
 * <p><b>The one thing it does that a restart cannot: a different seed.</b>
 * {@code RandomState.create} builds an independent {@code RandomState} at any seed from registries
 * that are already loaded, so "what does seed 12345 look like here" is an argument rather than a
 * world rebuild - for the half of worldgen this door sees. It needs the generator's
 * {@code NoiseGeneratorSettings}, so a flat or otherwise non-noise generator refuses by name rather
 * than quietly sampling the live seed and answering the wrong question.
 *
 * <p><b>{@code compare} is the staleness read, and it is a distribution rather than a verdict.</b>
 * The world's {@code OCEAN_FLOOR} heightmap and the generator's {@code OCEAN_FLOOR_WG} share a
 * predicate exactly, so they are comparable - but the world's has had surface rules, carvers,
 * features and a hundred human block placements applied to it since, and a tree raises it by six.
 * A boolean "stale" would therefore be a lie a large fraction of the time. What is reported is the
 * per-sample delta and its spread, plus how many samples could be read at all, and the caller reads
 * <em>systematic</em> difference as their answer.
 *
 * <p><b>Why its own entry.</b> Finding 6b's question - is there an existing tool whose question this
 * already is? {@code get_region_summary} and {@code check_site} take the same shape of argument and
 * report ground statistics, and folding a {@code source:"generator"} flag into one of them would
 * have cost no new manifest line. It is refused for {@code roll_loot}'s reason: this read is an
 * oracle. It reports the shape of ground that has never been generated, which is what is over the
 * horizon, and inside a perception tool that authority would ride into every play, survey and
 * survival turn. {@code DEV_ONLY}, beside {@code push_data} and {@code query_registry} - the two
 * calls a worldgen modder makes before this one.
 */
public final class WorldgenTools {
    private WorldgenTools() {}

    /** Hard cap on sampled columns - fail-fast, never silently shrink (that would fake coverage). */
    private static final int MAX_SAMPLES = 1024;
    private static final int DEFAULT_STRIDE = 16;
    /** Run-length cap on a reported column, so a 384-high column cannot flood a reply. */
    private static final int MAX_COLUMN_RUNS = 64;

    public static void register() {
        McpTools.register(ToolDef.of(
            "preview_worldgen",
            // Finding 5's trim, taken BEFORE the first commit rather than after: the honest first
            // draft priced 2,132 chars / ~666 tok/turn, over the ~589 floor a new entry is measured
            // against. What went was repetition and the argument prose that the reply itself
            // carries better (`note`, `how_to_read`); the BOUNDARY sentence stayed whole, because
            // it is the one clause a caller cannot recover from the reply after acting on it.
            "What the LOADED chunk generator would make at a coordinate, generating nothing - no "
                + "chunk, ticket or disk. Noise height and biome, at a point or over a `radius` "
                + "grid. Worldgen registries load ONCE per world, so after a push_data + restart "
                + "this is how you check the edit landed: the reply names the noise_settings id and "
                + "seed in force. `seed` samples another seed with no restart. `compare:true` puts "
                + "the world's own heightmap beside it, which is the staleness question. BOUNDARY: "
                + "NOISE ONLY, before surface rules, carvers, features and structures, so a "
                + "surface_rule or feature edit is invisible here by construction.",
            Schemas.objectOpt(
                Schemas.object(
                    "center", Schemas.object("x", Schemas.integer(), "z", Schemas.integer()),
                    "dimension", Schemas.str("Which dimension's generator (default: overworld)."),
                    "radius", Schemas.integer("Half-width in BLOCKS of a grid around `center` "
                        + "(default 0 = the single column at `center`)."),
                    "stride", Schemas.integer("Grid spacing in blocks (default " + DEFAULT_STRIDE
                        + "); " + MAX_SAMPLES + " samples max."),
                    "seed", Schemas.integer("Sample a DIFFERENT seed, no restart. Noise gens only."),
                    "column", Schemas.bool("Also the full noise column at `center`, run-length "
                        + "encoded."),
                    "compare", Schemas.bool("Put the world's own OCEAN_FLOOR beside each sample and "
                        + "report the delta spread. Never generates."),
                    "load", Schemas.bool("compare only: page existing chunks in (default true).")),
                "center", "dimension", "radius", "stride", "seed", "column", "compare", "load"),
            ExecutionContext.SERVER,
            // OBSERVE and honestly so: every call here is a pure function of registries already in
            // memory. `compare` is the only half that touches the world, and it borrows the read
            // path's own loader, which refuses to generate.
            Mechanism.OBSERVE,
            (ctx, a) -> preview(ctx.serverOrThrow(), a)));
    }

    // ---- the read ------------------------------------------------------------

    private static JsonElement preview(final MinecraftServer server, final JsonObject a) {
        ServerLevel level = level(server, a);
        ChunkGenerator generator = level.getChunkSource().getGenerator();

        JsonObject centerArg = a.getAsJsonObject("center");
        if (centerArg == null) {
            throw new IllegalArgumentException("missing 'center' {x,z}");
        }
        int cx = centerArg.get("x").getAsInt();
        int cz = centerArg.get("z").getAsInt();
        int radius = Math.max(0, intArg(a, "radius", 0));
        int stride = Math.max(1, intArg(a, "stride", DEFAULT_STRIDE));

        int perAxis = radius == 0 ? 1 : (2 * (radius / stride)) + 1;
        long total = (long) perAxis * perAxis;
        if (total > MAX_SAMPLES) {
            // Fail-fast rather than shrink: a silently reduced grid reports coverage it does not
            // have, which is the class of lie this repo purges rather than rounds off.
            throw new IllegalArgumentException(
                "radius " + radius + " at stride " + stride + " is " + perAxis + "x" + perAxis
                    + " = " + total + " columns, over the " + MAX_SAMPLES + " cap - widen `stride` "
                    + "or narrow `radius`");
        }

        // The seed decides which RandomState every sample below is taken against, so it is resolved
        // FIRST and reported beside the answer. A reply that does not say which seed it sampled is
        // unusable for the question this tool exists to answer.
        long worldSeed = level.getSeed();
        boolean overridden = a.has("seed") && !a.get("seed").isJsonNull();
        long seed = overridden ? a.get("seed").getAsLong() : worldSeed;
        RandomState randomState = overridden
            ? randomStateAt(level, generator, seed)
            : level.getChunkSource().randomState();
        Climate.Sampler sampler = randomState.sampler();
        BiomeSource biomes = generator.getBiomeSource();

        JsonObject r = new JsonObject();
        r.addProperty("dimension", level.dimension().identifier().toString());
        r.add("generator", describeGenerator(level, generator, seed, worldSeed, overridden));

        boolean compare = flag(a, "compare");
        ChunkLoader loader = compare ? new ChunkLoader(level, loadArg(a)) : null;

        JsonArray samples = new JsonArray();
        List<Integer> floors = new ArrayList<>();
        List<Integer> deltas = new ArrayList<>();
        Map<String, Integer> biomeCounts = new LinkedHashMap<>();
        int unread = 0;

        int half = radius == 0 ? 0 : (perAxis - 1) / 2;
        for (int gz = -half; gz <= half; gz++) {
            for (int gx = -half; gx <= half; gx++) {
                int x = cx + gx * stride;
                int z = cz + gz * stride;
                int floor = generator.getBaseHeight(
                    x, z, Heightmap.Types.OCEAN_FLOOR_WG, level, randomState);
                int surface = generator.getBaseHeight(
                    x, z, Heightmap.Types.WORLD_SURFACE_WG, level, randomState);
                Holder<Biome> biome = biomes.getNoiseBiome(
                    QuartPos.fromBlock(x), QuartPos.fromBlock(floor), QuartPos.fromBlock(z), sampler);
                String biomeId = idOf(biome);

                floors.add(floor);
                biomeCounts.merge(biomeId, 1, Integer::sum);

                JsonObject s = new JsonObject();
                s.addProperty("x", x);
                s.addProperty("z", z);
                s.addProperty("noise_floor", floor);
                // Only when it differs: with no water above it these two are the same number, and a
                // grid of identical pairs is pure token cost.
                if (surface != floor) {
                    s.addProperty("noise_surface", surface);
                }
                s.addProperty("biome", biomeId);

                if (loader != null) {
                    Integer world = worldFloor(level, loader, x, z);
                    if (world == null) {
                        unread++;
                        s.addProperty("world_floor", "unread");
                    } else {
                        s.addProperty("world_floor", world);
                        s.addProperty("delta", world - floor);
                        deltas.add(world - floor);
                    }
                }
                samples.add(s);
            }
        }

        if (samples.size() == 1) {
            r.add("at", samples.get(0));
        } else {
            r.add("samples", samples);
            r.add("summary", summary(floors, biomeCounts));
        }

        if (loader != null) {
            r.add("compare", compareBlock(deltas, unread, samples.size(), loader));
        }
        if (flag(a, "column")) {
            r.add("column", column(level, generator, randomState, cx, cz));
        }

        r.addProperty("note", "NOISE ONLY: the density router and the aquifer, before surface "
            + "rules, carvers, features and structures. A surface_rule or feature edit cannot be "
            + "seen from here. Nothing was generated and no chunk was created.");
        return r;
    }

    // ---- the pieces ----------------------------------------------------------

    private static JsonObject describeGenerator(final ServerLevel level, final ChunkGenerator gen,
                                                final long seed, final long worldSeed,
                                                final boolean overridden) {
        JsonObject g = new JsonObject();
        // `codec()` is PROTECTED on both ChunkGenerator and BiomeSource, so the registered id is
        // not reachable from an instance the way it is for a block or an item. The generator has a
        // public back door - getTypeNameForDataFixer() looks its own codec up in
        // BuiltInRegistries.CHUNK_GENERATOR - and the biome source has none, so that one is named
        // by its class. A class name is honest and stable; inventing an id would not be.
        g.addProperty("type", gen.getTypeNameForDataFixer()
            .map(Object::toString).orElseGet(() -> gen.getClass().getSimpleName()));
        g.addProperty("biome_source", gen.getBiomeSource().getClass().getSimpleName());
        // The question under this number is "is my biome even in the source" - a biome that is
        // registered but unreachable is the commonest worldgen defect there is.
        g.addProperty("possible_biomes", gen.getBiomeSource().possibleBiomes().size());
        if (gen instanceof NoiseBasedChunkGenerator noise) {
            // The id is the point of the whole reply for "did my edit land": an inline settings
            // object has no key, and saying so is better than omitting the field.
            g.addProperty("noise_settings", noise.generatorSettings().unwrapKey()
                .map(k -> k.identifier().toString()).orElse("(inline, not registered)"));
        }
        g.addProperty("seed", seed);
        g.addProperty("seed_source", overridden ? "override" : "world");
        if (overridden) {
            g.addProperty("world_seed", worldSeed);
        }
        g.addProperty("sea_level", gen.getSeaLevel());
        g.addProperty("min_y", level.getMinY());
        g.addProperty("height", level.getHeight());
        return g;
    }

    /**
     * A {@link RandomState} at an arbitrary seed, built from registries already in memory.
     *
     * <p>This is the door S3 of the design calls "a parameter rather than a restart". It only
     * exists for noise generators, because {@code NoiseGeneratorSettings} is what a
     * {@code RandomState} is made of - a flat or debug generator has no noise to reseed, and its
     * output does not depend on the seed at all. Refusing by name beats answering the live seed's
     * question under someone else's seed.
     */
    private static RandomState randomStateAt(final ServerLevel level, final ChunkGenerator gen,
                                             final long seed) {
        if (!(gen instanceof NoiseBasedChunkGenerator noise)) {
            throw new IllegalArgumentException(
                "`seed` needs a noise generator; this dimension's is "
                    + gen.getTypeNameForDataFixer().map(Object::toString)
                        .orElseGet(() -> gen.getClass().getSimpleName())
                    + ", whose output does not depend on the world seed. Drop `seed` to sample the "
                    + "live one.");
        }
        NoiseGeneratorSettings settings = noise.generatorSettings().value();
        return RandomState.create(
            settings, level.registryAccess().lookupOrThrow(Registries.NOISE), seed);
    }

    /**
     * The world's own floor at a column, or null when nothing may be read there without generating.
     *
     * <p><b>The +1 is the whole point of this method, and it was a real bug on the first live
     * run.</b> The two sides use OPPOSITE conventions for the same terrain:
     * {@code ChunkGenerator.getBaseHeight} returns the first FREE y (vanilla's heightmap
     * convention, topmost solid + 1), while {@code ChunkAccess.getHeight} returns
     * {@code getFirstAvailable() - 1}, i.e. the topmost SOLID block. Subtracting one from the other
     * put a systematic -1 on every untouched column: {@code identical:0} over a 49-column grid at
     * spawn, with {@code delta_min:-2} and a p50 of 1. That is precisely the "large or
     * one-directional shift" this tool tells a caller to read as <em>the generator has changed</em>,
     * so the headline feature was reporting every world as stale. Both sides are now first-free.
     */
    private static Integer worldFloor(final ServerLevel level, final ChunkLoader loader,
                                      final int x, final int z) {
        if (!loader.ensure(new BlockPos(x, level.getMinY(), z))) {
            return null;
        }
        ChunkAccess chunk = level.getChunk(x >> 4, z >> 4);
        return chunk.getHeight(Heightmap.Types.OCEAN_FLOOR, x, z) + 1;
    }

    private static JsonObject compareBlock(final List<Integer> deltas, final int unread,
                                           final int requested, final ChunkLoader loader) {
        JsonObject c = new JsonObject();
        c.addProperty("compared", deltas.size());
        c.addProperty("unread", unread);
        c.addProperty("requested", requested);
        if (!deltas.isEmpty()) {
            List<Integer> sorted = new ArrayList<>(deltas);
            sorted.sort(Comparator.naturalOrder());
            List<Integer> abs = new ArrayList<>(deltas.size());
            for (int d : deltas) {
                abs.add(Math.abs(d));
            }
            abs.sort(Comparator.naturalOrder());
            int same = 0;
            for (int d : deltas) {
                if (d == 0) {
                    same++;
                }
            }
            c.addProperty("identical", same);
            c.addProperty("delta_min", sorted.get(0));
            c.addProperty("delta_max", sorted.get(sorted.size() - 1));
            c.addProperty("abs_delta_p50", abs.get(abs.size() / 2));
            c.addProperty("abs_delta_p95", abs.get(Math.min(abs.size() - 1, (abs.size() * 95) / 100)));
        }
        JsonObject shortfall = loader.report();
        if (shortfall != null) {
            c.add("chunks", shortfall);
        }
        // Deliberately not a verdict. The two heightmaps share a predicate exactly, but the world's
        // has had surface rules, carvers, features and every hand-placed block applied to it since - 
        // a tree raises it by six. Systematic difference is the signal; a single sample is not.
        c.addProperty("how_to_read", "`world_floor` has had surface rules, carvers, features and "
            + "any hand-placed blocks applied; `noise_floor` has not. A few blocks of scatter is "
            + "normal terrain. A large or one-directional shift across the grid is the generator "
            + "having changed since these chunks were written - which is the only thing "
            + "regenerating them would fix.");
        return c;
    }

    private static JsonObject summary(final List<Integer> floors, final Map<String, Integer> biomes) {
        JsonObject s = new JsonObject();
        s.addProperty("count", floors.size());
        s.add("noise_floor", ReadSupport.groundStats(floors));
        JsonObject b = new JsonObject();
        biomes.entrySet().stream()
            .sorted(Map.Entry.<String, Integer>comparingByValue().reversed())
            .forEach(e -> b.addProperty(e.getKey(), e.getValue()));
        s.add("biomes", b);
        return s;
    }

    /**
     * The noise column at a point, run-length encoded.
     *
     * <p>Run-length because a 384-block column of {@code minecraft:stone} is one fact, not 384, and
     * because the boundaries are what a modder is looking at: where the aquifer put water, where the
     * default fluid stops, where deepslate would begin if a surface rule were going to do it.
     */
    private static JsonObject column(final ServerLevel level, final ChunkGenerator gen,
                                     final RandomState randomState, final int x, final int z) {
        NoiseColumn col = gen.getBaseColumn(x, z, level, randomState);
        JsonObject c = new JsonObject();
        c.addProperty("x", x);
        c.addProperty("z", z);
        JsonArray runs = new JsonArray();
        String current = null;
        int runStart = 0;
        int top = level.getMinY() + level.getHeight();
        boolean truncated = false;
        for (int y = level.getMinY(); y <= top; y++) {
            String id = y == top ? null : blockId(col.getBlock(y));
            if (current != null && (id == null || !current.equals(id))) {
                if (runs.size() >= MAX_COLUMN_RUNS) {
                    truncated = true;
                    break;
                }
                JsonObject run = new JsonObject();
                run.addProperty("y", runStart);
                run.addProperty("height", y - runStart);
                run.addProperty("block", current);
                runs.add(run);
            }
            if (id != null && !id.equals(current)) {
                runStart = y;
            }
            current = id;
        }
        c.add("runs", runs);
        if (truncated) {
            // Say it rather than let a short list read as a simple column.
            c.addProperty("truncated_at_runs", MAX_COLUMN_RUNS);
        }
        return c;
    }

    // ---- small helpers -------------------------------------------------------

    private static ServerLevel level(final MinecraftServer server, final JsonObject a) {
        String want = a.has("dimension") && !a.get("dimension").isJsonNull()
            ? a.get("dimension").getAsString() : null;
        if (want == null) {
            return server.overworld();
        }
        StringBuilder have = new StringBuilder();
        for (ServerLevel level : server.getAllLevels()) {
            String id = level.dimension().identifier().toString();
            if (id.equals(want) || id.equals("minecraft:" + want)) {
                return level;
            }
            have.append(have.isEmpty() ? "" : ", ").append(id);
        }
        throw new IllegalArgumentException(
            "no loaded dimension '" + want + "' - this server has: " + have);
    }

    private static String idOf(final Holder<Biome> biome) {
        return biome.unwrapKey().map(k -> k.identifier().toString()).orElse("(unregistered)");
    }

    private static String blockId(final BlockState state) {
        return net.minecraft.core.registries.BuiltInRegistries.BLOCK.getKey(state.getBlock())
            .toString();
    }

    private static int intArg(final JsonObject a, final String key, final int fallback) {
        return a.has(key) && !a.get(key).isJsonNull() ? a.get(key).getAsInt() : fallback;
    }

    private static boolean flag(final JsonObject a, final String key) {
        return a.has(key) && !a.get(key).isJsonNull() && a.get(key).getAsBoolean();
    }
}
