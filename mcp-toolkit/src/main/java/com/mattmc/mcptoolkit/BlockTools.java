package com.mattmc.mcptoolkit;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mojang.brigadier.StringReader;
import com.mojang.brigadier.exceptions.CommandSyntaxException;
import net.minecraft.commands.arguments.blocks.BlockInput;
import net.minecraft.commands.arguments.blocks.BlockPredicateArgument;
import net.minecraft.commands.arguments.blocks.BlockStateParser;
import net.minecraft.core.BlockPos;
import net.minecraft.core.HolderLookup;
import net.minecraft.core.HolderSet;
import net.minecraft.core.registries.Registries;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.pattern.BlockInWorld;
import net.minecraft.world.level.block.state.properties.Property;

import java.util.Set;

/**
 * Blockstate- and NBT-aware block placement. Unlike {@code place_blocks} (default states only) and
 * {@code place_shape} (one default-state block over a volume), {@code set_blocks} parses the full vanilla
 * {@code id[state=...]{nbt}} syntax through Minecraft's own {@link BlockStateParser}, so oriented blocks
 * (stairs/logs/observers), multi-property blocks, and block entities with NBT (chests with loot, signs,
 * jigsaws, beehives, spawners) all place exactly as {@code /setblock} would — but many at once, structured.
 *
 * <p>The shared {@link #parseInput} / {@link #parseState} helpers are also used by {@link ShapeTools} so a
 * shape can take a stated block id too.
 */
public final class BlockTools {
    private BlockTools() {}

    /** Cap on blocks changed by one call, so a huge batch can't stall the server thread. */
    private static final int MAX_BLOCKS = 100_000;

    public static void register() {
        McpTools.register(ToolDef.of(
            "set_blocks",
            "Set blocks with full blockstate and block-entity NBT support — the structured equivalent of "
                + "running many /setblock commands. TWO WAYS to say which cells, one engine: `blocks` for "
                + "scattered exact positions, `min`+`layers` for a dense little volume drawn as text. "
                + "(1) `blocks`: entries of {x,y,z, block} where `block` is the vanilla string — an id, "
                + "optional [state], optional {nbt}: \"minecraft:oak_stairs[facing=east,half=top]\", "
                + "\"minecraft:chest[facing=north]{Items:[{Slot:0b,id:\\\"minecraft:diamond\\\",count:5}]}\". "
                + "(2) `layers`: a grid of characters you never index — the tool turns every character "
                + "into a coordinate. layers[0] is the bottom course (y=min.y), rows[0] is z=min.z, "
                + "character i is x=min.x+i; `legend` maps one character to one block string or to "
                + "\"keep\" ('.' defaults to air, ' ' to keep). describe_box detail:\"layers\" output pastes "
                + "back VERBATIM — its y keys, \"z=20|\" labels and \"x: 10..14\" ruler are all CHECKED "
                + "against `min`. Ragged rows, an unknown character or a label that disagrees refuse the "
                + "whole call having written nothing; the reply echoes `parsed` (the size read) and "
                + "`per_symbol` (counts per character), so you confirm the grid by COUNT. "
                + "Coordinates are absolute; the write goes to `dimension` (default minecraft:overworld — "
                + "pass the dimension you read from so the round-trip lands in the same world). "
                + "By default physics/neighbour updates are suppressed (no water/gravity cascade mid-build); "
                + "set `physics`:true for normal updates. `dry_run`:true validates + reports the region without "
                + "changing anything. Returns placed count, any per-entry parse/place errors, the affected "
                + "`region`, and an `undo_id` (null on dry_run) revertible with undo_edit.",
            Schemas.objectOpt(
                Schemas.object(
                    "blocks", Schemas.array(Schemas.object(
                        "x", Schemas.integer(), "y", Schemas.integer(), "z", Schemas.integer(),
                        "block", Schemas.str("Vanilla block string: id[state]{nbt}, e.g. minecraft:oak_stairs[facing=east]"))),
                    "min", Schemas.vec3i("Grid form: the cell layers[0]'s first character lands on."),
                    "legend", Schemas.map(Schemas.str(), "One character -> one block string, or \"keep\"."),
                    "layers", Schemas.anyOf("Layers bottom-first, or keyed by y as describe_box returns them.",
                        Schemas.array(Schemas.array(Schemas.str())),
                        Schemas.map(Schemas.array(Schemas.str()), "y -> rows")),
                    "physics", Schemas.bool("Apply neighbour/physics updates (default false = quiet, WorldEdit-style)."),
                    "dry_run", Schemas.bool("If true, validate + report the region but change nothing."),
                    "dimension", Schemas.str("Dimension to write in (e.g. minecraft:the_nether). Default: "
                        + "minecraft:overworld; the result stamps the dimension actually written.")),
                "blocks", "min", "legend", "layers", "physics", "dry_run", "dimension"),
            ExecutionContext.SERVER,
            Mechanism.WORLD_EDIT,
            (ctx, a) -> setBlocks(ctx.serverOrThrow(), a, ctx.sessionId())));
    }

    private static JsonObject setBlocks(final MinecraftServer server, final JsonObject a,
                                        final @org.jspecify.annotations.Nullable String session) {
        ServerLevel level = WorldPerceptionTools.levelArg(server, a);
        boolean hasBlocks = a.has("blocks") && !a.get("blocks").isJsonNull();
        boolean hasLayers = a.has("layers") && !a.get("layers").isJsonNull();
        if (hasBlocks == hasLayers) {
            throw new IllegalArgumentException(hasBlocks
                ? "pass EITHER `blocks` (exact {x,y,z,block} entries) OR `min`+`legend`+`layers` (a grid) "
                    + "— both were given and they would fight over the same cells; nothing was placed"
                : "missing `blocks` array of {x,y,z,block} — or, for a dense little volume, "
                    + "`min`+`legend`+`layers`");
        }
        // The grid is parsed to the SAME {x,y,z,block} entries the explicit form takes, so everything
        // below — parsing, physics, the undo record, per-entry errors, the region — has one definition.
        if (hasBlocks && !a.get("blocks").isJsonArray()) {
            throw new IllegalArgumentException("`blocks` must be an array of {x,y,z,block}");
        }
        HolderLookup<Block> lookup = server.registryAccess().lookupOrThrow(Registries.BLOCK);
        Grid grid = hasLayers ? parseGrid(a, lookup) : null;
        JsonArray blocks = grid != null ? grid.blocks() : a.getAsJsonArray("blocks");
        if (blocks.size() > MAX_BLOCKS) {
            throw new IllegalArgumentException("too many blocks (" + blocks.size() + " > " + MAX_BLOCKS + ")");
        }
        boolean physics = a.has("physics") && !a.get("physics").isJsonNull() && a.get("physics").getAsBoolean();
        boolean dryRun = a.has("dry_run") && !a.get("dry_run").isJsonNull() && a.get("dry_run").getAsBoolean();
        int flags = physics ? Block.UPDATE_ALL : Block.UPDATE_CLIENTS;

        EditJournal.Recorder recorder = dryRun ? null : EditJournal.recorder(level, "set_blocks", session);

        int placed = 0;
        int unchanged = 0;
        JsonArray errors = new JsonArray();
        Bounds bounds = new Bounds();
        for (int i = 0; i < blocks.size(); i++) {
            JsonObject b = blocks.get(i).getAsJsonObject();
            try {
                BlockPos pos = new BlockPos(b.get("x").getAsInt(), b.get("y").getAsInt(), b.get("z").getAsInt());
                BlockStateParser.BlockResult parsed = parseBlockResult(lookup, b.get("block").getAsString());
                BlockInput input = new BlockInput(parsed.blockState(), parsed.properties().keySet(), parsed.nbt());
                // A cell ALREADY in the asked-for state is `unchanged`, not failed — the same bucket
                // place_shape has always had. setBlock returns false there, and reporting that as
                // "placement rejected" made re-stating what is already correct look like a broken
                // write. That is the NORMAL case for the grid form, where changing three characters
                // means re-stating the whole box; before this, editing a 150-cell room reported 147
                // errors. Checked before the dry-run branch so the preview and the live run agree.
                if (parsed.nbt() == null && level.getBlockState(pos) == input.getState()) {
                    unchanged++;
                    continue;
                }
                if (dryRun) {
                    bounds.expand(pos); // intent-bounds: what a live run would try to touch
                    placed++; // a valid entry that would place
                    continue;
                }
                if (recorder != null) {
                    recorder.capture(pos, level.getBlockState(pos)); // snapshot prior state + BE NBT
                }
                // Bounds (and the undo snapshot) only cover CONFIRMED writes — a rejected entry used
                // to stretch the reported region and leave a phantom cell in the undo record.
                if (input.place(level, pos, flags)) {
                    bounds.expand(pos);
                    placed++;
                } else {
                    if (recorder != null) {
                        recorder.dropLast();
                    }
                    JsonObject e = new JsonObject();
                    e.addProperty("index", i);
                    e.addProperty("error", "placement rejected (unchanged)");
                    errors.add(e);
                }
            } catch (Exception ex) {
                JsonObject e = new JsonObject();
                e.addProperty("index", i);
                e.addProperty("error", ex.getMessage() == null ? ex.toString() : ex.getMessage());
                errors.add(e);
            }
        }

        int[] region = bounds.toArray();
        String undoId = recorder == null ? null : recorder.commit(placed, region);

        JsonObject r = new JsonObject();
        r.addProperty("count", blocks.size());
        r.addProperty("placed", placed);
        r.addProperty("failed", errors.size());
        if (unchanged > 0) {
            r.addProperty("unchanged", unchanged); // already the asked-for state; setBlock would no-op
        }
        r.addProperty("dryRun", dryRun);
        if (errors.size() > 0) {
            r.add("errors", errors);
        }
        if (grid != null) {
            // What the tool READ out of the text, echoed before anything about what it wrote: the
            // caller stated this geometry implicitly, in whitespace, and never sees it otherwise.
            JsonObject parsed = new JsonObject();
            JsonObject size = new JsonObject();
            size.addProperty("x", grid.sx());
            size.addProperty("y", grid.sy());
            size.addProperty("z", grid.sz());
            parsed.add("size", size);
            parsed.addProperty("cells", grid.cells());
            r.add("parsed", parsed);
            r.addProperty("kept", grid.kept());
            r.add("per_symbol", grid.perSymbol());
        }
        EditJournal.stampEnvelope(r, level, region, undoId); // game_tick + region + undo_id (null on dry_run)
        if (recorder != null && recorder.overCap()) {
            r.addProperty("undo_reason", "over_cap: the edit changed more than " + EditJournal.UNDO_CAP
                + " cells, so it was applied but is not undoable");
        }
        return r;
    }

    // ---- the grid form: dense text in, and the CALLER never computes a coordinate --------------

    /**
     * A parsed grid, expressed in the shape the explicit form already speaks — the entries to write —
     * plus the census that proves what was read out of the text.
     *
     * <p><b>Why the write side takes a picture at all.</b> {@code describe_box detail:"layers"} has
     * returned one since 0.22.0 and nothing could answer it: the loop it belongs to is "read what is
     * there, change some of it, write it back", and the write half was 150 JSON objects. The measured
     * hazard with grids (PATTERN_SEARCH_DESIGN.md: the same wrong cell from layers character-arithmetic
     * in three independent sessions) is an <em>extraction</em> failure — a model deriving a coordinate
     * out of a picture. This direction has no extraction step: the model emits the whole grid and the
     * TOOL does every index. That is the claim, and it is falsifiable — a run that builds a chamber
     * offset by one on any axis says the hazard was never confined to extraction and this form should
     * not have shipped.
     */
    private record Grid(JsonArray blocks, JsonObject perSymbol, int sx, int sy, int sz, int cells, int kept) {}

    /** The legend value that means "this cell is not mine" — the symbol that makes the form composable. */
    private static final String KEEP = "keep";
    /** {@code describe_box}'s own row label. Present ⇒ checked against the frame; absent ⇒ nothing to check. */
    private static final java.util.regex.Pattern ROW_LABEL = java.util.regex.Pattern.compile("^z=(-?\\d+)\\|");
    /** {@code describe_box}'s west-edge x ruler, which it puts first in every slice. */
    private static final java.util.regex.Pattern RULER =
        java.util.regex.Pattern.compile("^x:\\s*(-?\\d+)\\s*\\.\\.\\s*(-?\\d+)");

    /**
     * Read {@code min} + {@code legend} + {@code layers} into entries. Throws — writing nothing — on
     * anything malformed, which is the same rule {@code place_shapes} follows and for the same reason:
     * a half-applied layered write leaves a structure whose later layers were authored against geometry
     * that never appeared. <b>Ragged rows are never padded.</b> Padding is exactly how a character
     * offset survives to become a valid-looking build.
     */
    private static Grid parseGrid(final JsonObject a, final HolderLookup<Block> lookup) {
        if (!a.has("min") || !a.get("min").isJsonObject()) {
            throw new IllegalArgumentException("the grid form needs `min` {x,y,z} — the cell the first "
                + "character of the first row lands on; nothing was placed");
        }
        JsonObject minObj = a.getAsJsonObject("min");
        int mx = coord(minObj, "x"), my = coord(minObj, "y"), mz = coord(minObj, "z");

        // '.' and ' ' carry describe_box's own conventions so its output is writable as it stands;
        // either can be overridden, because a legend the caller wrote outranks a default we assumed.
        java.util.Map<Character, String> legend = new java.util.LinkedHashMap<>();
        legend.put('.', "minecraft:air");
        legend.put(' ', KEEP);
        if (a.has("legend") && !a.get("legend").isJsonNull()) {
            if (!a.get("legend").isJsonObject()) {
                throw new IllegalArgumentException("`legend` must be an object mapping one character to "
                    + "one block string (or \"keep\"); nothing was placed");
            }
            for (var e : a.getAsJsonObject("legend").entrySet()) {
                if (e.getKey().length() != 1) {
                    throw new IllegalArgumentException("legend key \"" + e.getKey() + "\" is "
                        + e.getKey().length() + " characters — a legend key is exactly ONE character, the "
                        + "one that appears in the rows; nothing was placed");
                }
                if (!e.getValue().isJsonPrimitive() || !e.getValue().getAsJsonPrimitive().isString()) {
                    throw new IllegalArgumentException("legend value for '" + e.getKey() + "' must be a "
                        + "block string or \"keep\"; nothing was placed");
                }
                legend.put(e.getKey().charAt(0), e.getValue().getAsString());
            }
        }

        // Both accepted shapes normalize to (y, rows) ascending. The y-keyed object is what
        // describe_box returns, and taking it verbatim is the point: a caller who has to convert an
        // object into an array to write back is doing the arithmetic this form exists to remove.
        java.util.List<Integer> ys = new java.util.ArrayList<>();
        java.util.List<JsonArray> raw = new java.util.ArrayList<>();
        com.google.gson.JsonElement le = a.get("layers");
        if (le.isJsonArray()) {
            JsonArray arr = le.getAsJsonArray();
            if (arr.isEmpty()) {
                throw new IllegalArgumentException("`layers` is empty — nothing to write");
            }
            for (int i = 0; i < arr.size(); i++) {
                if (!arr.get(i).isJsonArray()) {
                    throw new IllegalArgumentException("layers[" + i + "] is not an array of row strings; "
                        + "nothing was placed");
                }
                ys.add(my + i);
                raw.add(arr.get(i).getAsJsonArray());
            }
        } else if (le.isJsonObject()) {
            JsonObject o = le.getAsJsonObject();
            if (o.size() == 0) {
                throw new IllegalArgumentException("`layers` is empty — nothing to write");
            }
            java.util.TreeMap<Integer, String> keys = new java.util.TreeMap<>();
            for (String k : o.keySet()) {
                try {
                    keys.put(Integer.parseInt(k.trim()), k);
                } catch (NumberFormatException ex) {
                    throw new IllegalArgumentException("`layers` key \"" + k + "\" is not a y coordinate "
                        + "— the object form is keyed by y, exactly as describe_box returns it; "
                        + "nothing was placed");
                }
            }
            if (keys.firstKey() != my) {
                throw new IllegalArgumentException("`layers` is keyed by y: its lowest key is y="
                    + keys.firstKey() + " but `min`.y is " + my + " — one of the two is wrong and the "
                    + "tool will not guess which; nothing was placed");
            }
            int expect = my;
            for (var e : keys.entrySet()) {
                if (e.getKey() != expect) {
                    throw new IllegalArgumentException("`layers` skips y=" + expect + " (next key is y="
                        + e.getKey() + ") — the keys must be contiguous, or the box has a hole nothing "
                        + "declares; nothing was placed");
                }
                if (!o.get(e.getValue()).isJsonArray()) {
                    throw new IllegalArgumentException("layers[\"" + e.getValue() + "\"] is not an array "
                        + "of row strings; nothing was placed");
                }
                ys.add(expect);
                raw.add(o.get(e.getValue()).getAsJsonArray());
                expect++;
            }
        } else {
            throw new IllegalArgumentException("`layers` must be an array of layers (bottom-first) or an "
                + "object keyed by y; nothing was placed");
        }

        // Strip and CHECK the labels, then hold every layer to the first one's shape.
        java.util.List<java.util.List<String>> grid = new java.util.ArrayList<>();
        int width = -1;
        int depth = -1;
        for (int li = 0; li < raw.size(); li++) {
            int y = ys.get(li);
            JsonArray rows = raw.get(li);
            java.util.List<String> data = new java.util.ArrayList<>();
            String ruler = null;
            for (int ri = 0; ri < rows.size(); ri++) {
                if (!rows.get(ri).isJsonPrimitive() || !rows.get(ri).getAsJsonPrimitive().isString()) {
                    throw new IllegalArgumentException("layer y=" + y + " row " + ri + " is not a string "
                        + "— a layer is an array of rows; nothing was placed");
                }
                String s = rows.get(ri).getAsString();
                // The ruler is only ever describe_box's first row; a data row is never tested for it.
                if (ri == 0 && rows.size() > 1 && RULER.matcher(s).find()) {
                    ruler = s;
                    continue;
                }
                var m = ROW_LABEL.matcher(s);
                if (m.find()) {
                    int labelled = Integer.parseInt(m.group(1));
                    int actual = mz + data.size();
                    if (labelled != actual) {
                        throw new IllegalArgumentException("layer y=" + y + ": row " + data.size()
                            + " is labelled z=" + labelled + " but at this `min` it is z=" + actual
                            + " — the labels and the frame disagree; nothing was placed");
                    }
                    s = s.substring(m.end());
                }
                data.add(s);
            }
            if (data.isEmpty()) {
                throw new IllegalArgumentException("layer y=" + y + " has no rows; nothing was placed");
            }
            if (width < 0) {
                width = data.get(0).length();
                depth = data.size();
                if (width == 0) {
                    throw new IllegalArgumentException("layer y=" + y + " row 0 is empty; nothing was placed");
                }
            } else if (data.size() != depth) {
                throw new IllegalArgumentException("layer y=" + y + " has " + data.size() + " rows but "
                    + "layer y=" + ys.get(0) + " has " + depth + " — every layer is the same z depth; "
                    + "nothing was placed");
            }
            for (int ri = 0; ri < data.size(); ri++) {
                if (data.get(ri).length() != width) {
                    throw new IllegalArgumentException("layer y=" + y + ", row z=" + (mz + ri) + " is "
                        + data.get(ri).length() + " characters, expected " + width + " — ragged rows are "
                        + "refused, never padded; nothing was placed");
                }
            }
            if (ruler != null) {
                var m = RULER.matcher(ruler);
                if (m.find()) {
                    int from = Integer.parseInt(m.group(1));
                    int to = Integer.parseInt(m.group(2));
                    if (from != mx || to != mx + width - 1) {
                        throw new IllegalArgumentException("layer y=" + y + " carries the ruler \"" + ruler
                            + "\" but at this `min` its row spans x=" + mx + ".." + (mx + width - 1)
                            + " — the ruler and the frame disagree; nothing was placed");
                    }
                }
            }
            grid.add(data);
        }

        int cells = width * depth * grid.size();
        if (cells > MAX_BLOCKS) {
            throw new IllegalArgumentException("grid is " + cells + " cells (> " + MAX_BLOCKS
                + ") — split it; nothing was placed");
        }

        JsonArray blocks = new JsonArray();
        java.util.LinkedHashMap<Character, Integer> counts = new java.util.LinkedHashMap<>();
        java.util.HashSet<Character> checked = new java.util.HashSet<>();
        int kept = 0;
        for (int li = 0; li < grid.size(); li++) {
            int y = ys.get(li);
            java.util.List<String> data = grid.get(li);
            for (int ri = 0; ri < data.size(); ri++) {
                String row = data.get(ri);
                for (int ci = 0; ci < width; ci++) {
                    char c = row.charAt(ci);
                    String spec = legend.get(c);
                    if (spec == null) {
                        throw new IllegalArgumentException("no legend entry for '" + c + "' (at x="
                            + (mx + ci) + ", y=" + y + ", z=" + (mz + ri) + ") — every character needs "
                            + "one, except '.' (air) and ' ' (keep); nothing was placed");
                    }
                    counts.merge(c, 1, Integer::sum);
                    if (KEEP.equalsIgnoreCase(spec)) {
                        kept++;
                        continue;
                    }
                    // Parsed on first use, HERE, so a typo in the legend refuses the whole call. Left
                    // to the shared loop below it would be one per-entry error per cell wearing that
                    // symbol — a half-written box, which is the one thing this form promises not to do.
                    if (checked.add(c)) {
                        try {
                            parseBlockResult(lookup, spec);
                        } catch (RuntimeException ex) {
                            throw new IllegalArgumentException("legend '" + c + "' = " + ex.getMessage()
                                + "; nothing was placed", ex);
                        }
                    }
                    JsonObject e = new JsonObject();
                    e.addProperty("x", mx + ci);
                    e.addProperty("y", y);
                    e.addProperty("z", mz + ri);
                    e.addProperty("block", spec);
                    blocks.add(e);
                }
            }
        }
        JsonObject perSymbol = new JsonObject();
        counts.forEach((c, n) -> perSymbol.addProperty(String.valueOf(c), n));
        return new Grid(blocks, perSymbol, width, grid.size(), depth, cells, kept);
    }

    private static int coord(final JsonObject o, final String key) {
        if (!o.has(key) || o.get(key).isJsonNull()) {
            throw new IllegalArgumentException("`min` needs " + key + "; nothing was placed");
        }
        return o.get(key).getAsInt();
    }

    /** Running inclusive min/max box over the placed positions, for region reporting. */
    private static final class Bounds {
        private boolean has = false;
        private int minX, minY, minZ, maxX, maxY, maxZ;

        void expand(final BlockPos p) {
            int x = p.getX(), y = p.getY(), z = p.getZ();
            if (!has) {
                minX = maxX = x;
                minY = maxY = y;
                minZ = maxZ = z;
                has = true;
                return;
            }
            minX = Math.min(minX, x); maxX = Math.max(maxX, x);
            minY = Math.min(minY, y); maxY = Math.max(maxY, y);
            minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
        }

        int @org.jspecify.annotations.Nullable [] toArray() {
            return has ? EditJournal.bounds(minX, minY, minZ, maxX, maxY, maxZ) : null;
        }
    }

    // ---- shared parsing (also used by ShapeTools) ----------------------------

    /** Parse a full {@code id[state]{nbt}} string into a placeable {@link BlockInput}. */
    public static BlockInput parseInput(final HolderLookup<Block> lookup, final String spec) {
        BlockStateParser.BlockResult result = parseBlockResult(lookup, spec);
        return new BlockInput(result.blockState(), result.properties().keySet(), result.nbt());
    }

    /**
     * The same parse, kept WHOLE — {@link BlockInput} hides whether NBT came with the block, and
     * "is this cell already what was asked for" cannot be answered from the state alone: two chests
     * with different contents are the same {@link BlockState}.
     */
    static BlockStateParser.BlockResult parseBlockResult(final HolderLookup<Block> lookup, final String spec) {
        try {
            return BlockStateParser.parseForBlock(lookup, spec, true);
        } catch (CommandSyntaxException e) {
            throw new IllegalArgumentException("bad block '" + spec + "': " + e.getMessage());
        }
    }

    /** Parse a {@code id[state]} string into a {@link BlockState} (ignores any NBT). */
    public static BlockState parseState(final MinecraftServer server, final String spec) {
        HolderLookup<Block> lookup = server.registryAccess().lookupOrThrow(Registries.BLOCK);
        return parseInput(lookup, spec).getState();
    }

    // ---- shared matching (reads: `expect`, pattern nodes, set re-verification) ------

    /**
     * A block <em>matcher</em>: everything {@link #parseInput} accepts, plus <b>tags</b>
     * ({@code #minecraft:logs}, {@code #minecraft:beds[part=head]}) — exactly the syntax
     * {@code /execute if block} takes, because it is parsed by the same vanilla parser
     * ({@link BlockStateParser#parseForTesting}, the testing half of the one {@link #parseInput}
     * uses for writes).
     *
     * <p>Two faces, because a scan needs both. {@link #prefilter} is a STATE-level test with no
     * world access — that is what lets a section-palette sweep skip whole 16³ sections — and it is
     * deliberately a <em>superset</em> (it ignores NBT, and a tag's vague properties), so anything
     * the real predicate could match survives it. {@link #test} is vanilla's own predicate,
     * properties and block-entity NBT included. Reads used to parse writes ({@code parseInput}),
     * which silently made a tag a syntax error everywhere a question could be asked; this type is
     * why "matches" now has one definition across `expect`, pattern nodes and set re-verification.
     */
    public static final class Matcher {
        private final String spec;
        private final BlockPredicateArgument.Result predicate;
        /** Exact form: the state whose block + defined properties gate the prefilter. */
        private final @org.jspecify.annotations.Nullable BlockState state;
        private final Set<Property<?>> properties;
        /** Tag form: the tag's members gate the prefilter. Exactly one of this/{@link #state}. */
        private final @org.jspecify.annotations.Nullable HolderSet<Block> tag;

        private Matcher(final String spec, final BlockPredicateArgument.Result predicate,
                        final @org.jspecify.annotations.Nullable BlockState state,
                        final Set<Property<?>> properties,
                        final @org.jspecify.annotations.Nullable HolderSet<Block> tag) {
            this.spec = spec;
            this.predicate = predicate;
            this.state = state;
            this.properties = properties;
            this.tag = tag;
        }

        public String spec() {
            return spec;
        }

        /** True when this matcher is a tag, so no single block id describes what it matched. */
        public boolean isTag() {
            return tag != null;
        }

        /** The matched block's id for an exact matcher; null for a tag (read the cell instead). */
        public @org.jspecify.annotations.Nullable String blockId() {
            return state == null ? null
                : net.minecraft.core.registries.BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
        }

        /** State-level superset test: no world access, no NBT. Safe to run over a whole palette. */
        public boolean prefilter(final BlockState candidate) {
            if (tag != null) {
                return candidate.is(tag);
            }
            if (!candidate.is(state.getBlock())) {
                return false;
            }
            for (Property<?> prop : properties) {
                if (candidate.getValue(prop) != state.getValue(prop)) {
                    return false;
                }
            }
            return true;
        }

        /** The full vanilla predicate — properties and block-entity NBT — at one position. */
        public boolean test(final ServerLevel level, final BlockPos pos) {
            return predicate.test(new BlockInWorld(level, pos, false));
        }
    }

    /** Parse a matcher: {@code id[state]{nbt}} or {@code #tag[state]{nbt}}. */
    public static Matcher parseMatcher(final HolderLookup<Block> lookup, final String spec) {
        try {
            // Parsed twice on purpose: `parseForTesting` yields the pieces the state-level
            // prefilter needs, and BlockPredicateArgument yields vanilla's own predicate for the
            // confirming test. Reimplementing the latter is how NBT semantics drift.
            BlockPredicateArgument.Result predicate =
                BlockPredicateArgument.parse(lookup, new StringReader(spec));
            return BlockStateParser.parseForTesting(lookup, spec, true).map(
                block -> new Matcher(spec, predicate, block.blockState(),
                    block.properties().keySet(), null),
                tag -> new Matcher(spec, predicate, null, Set.of(), tag.tag()));
        } catch (CommandSyntaxException e) {
            throw new IllegalArgumentException("bad block matcher '" + spec + "': " + e.getMessage()
                + " (expected id[state]{nbt} or #tag[state]{nbt}, e.g. minecraft:chest, "
                + "minecraft:oak_log[axis=y], #minecraft:logs)");
        }
    }
}
