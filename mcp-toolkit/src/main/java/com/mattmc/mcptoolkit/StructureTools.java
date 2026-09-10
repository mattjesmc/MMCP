package com.mattmc.mcptoolkit;

import com.google.gson.JsonObject;
import net.minecraft.commands.arguments.blocks.BlockStateParser;
import net.minecraft.core.BlockPos;
import net.minecraft.core.HolderGetter;
import net.minecraft.core.registries.Registries;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.ListTag;
import net.minecraft.nbt.NbtUtils;
import net.minecraft.resources.Identifier;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.util.RandomSource;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.Mirror;
import net.minecraft.world.level.block.Rotation;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import net.minecraft.world.level.levelgen.structure.templatesystem.StructurePlaceSettings;
import net.minecraft.world.level.levelgen.structure.templatesystem.StructureTemplate;
import org.jspecify.annotations.Nullable;

import com.google.gson.JsonArray;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Optional;

/**
 * {@code place_structure} — the write half of {@code capture_structure}, and the reason it had to exist is
 * not that the capability was missing but that <b>the toolkit was already telling people it had it</b>:
 * {@code GoalRunner}'s refusal of {@code bot_target action:"build"} named {@code place_structure} as the
 * thing to use instead, and no such tool existed anywhere in the repo (RELEASE_1.md §D3).
 *
 * <p><b>Why a new entry rather than a field on {@code set_blocks}.</b> Finding 6b's test is whether two
 * argument shapes share the engine <em>below</em> the parse. They do not. {@code set_blocks} parses cells
 * and applies them itself; a template placement is vanilla's {@link StructureTemplate#placeInWorld}, which
 * owns block entities, waterlogging fixup, jigsaw handling and entity spawning. Routing a template through
 * {@code set_blocks}' applier would mean re-implementing that, which is the drift this repo spends its
 * effort avoiding. What IS shared is the transactional layer, and that is shared for real: the same
 * {@link EditJournal}, the same {@code undo_id} / {@code region} envelope, the same {@code dry_run}
 * vocabulary. It is {@code DEV_ONLY} beside {@code capture_structure}, so no play/survey/survival session
 * pays for its manifest entry.
 *
 * <p><b>What it adds over {@code run_command "/place template …"}, which is the honest comparison.</b>
 * <ol>
 *   <li><b>A verdict.</b> {@code run_command} reports {@code ok:true} for a command that failed — a
 *       recorded trap of that tool — so the existing route cannot tell you the template was not found.
 *       Here a missing id is a refusal that names it and says how to list what IS loaded.</li>
 *   <li><b>Undo.</b> The cells the template will write are snapshotted first, so {@code undo_edit} reverts
 *       a placement bit-identically, block entities included. {@code /place} has no undo at all.</li>
 *   <li><b>A dry run.</b> The footprint and what is standing in it, without touching the world — which
 *       is the question "will this land where I think, and on top of what" actually asks.</li>
 *   <li><b>Unloaded destination is a refusal.</b> Vanilla's own command checks this; the point here is
 *       that it is reported as a refusal rather than as a half-placed building.</li>
 * </ol>
 *
 * <p><b>The one thing undo does not cover, said in the reply rather than in a doc.</b> Entities the
 * template spawns are not blocks and the journal cannot restore them, so {@code entities} defaults to
 * <b>false</b> (matching {@code capture_structure}'s default) and a placement that did spawn some carries
 * an {@code undo_note} saying undo covers blocks only. A tool that silently half-undoes is worse than one
 * that does not undo.
 */
public final class StructureTools {
    private StructureTools() {}

    /**
     * Cells one placement may cover. Deliberately the same cap as {@code capture_structure}'s volume: a
     * template this tool refuses is one {@code capture_structure} would have refused to make. Note it is
     * larger than {@link EditJournal#UNDO_CAP}, so a placement between the two is applied and reported
     * with a null {@code undo_id} — the journal's own documented bound, not a new one.
     */
    private static final int MAX_CELLS = 64 * 64 * 64;
    /** How many differing cells `compare` names individually before it only counts them. */
    private static final int DIFF_LIMIT = 40;

    public static void register() {
        McpTools.register(ToolDef.of(
            "place_structure",
            "Place a loaded structure template into the world — the write half of capture_structure, and "
                + "the only route that reports whether it worked (run_command \"/place template\" answers "
                + "ok:true even when the template was not found). `id` is the namespaced template id; "
                + "query_registry {registry:\"structure_template\"} lists what is loaded. `at` is where the "
                + "template's own origin corner lands, and `rotation`/`mirror` turn it about that corner. "
                + "Entities are NOT placed by default, because undo cannot remove them. `compare` changes "
                + "NOTHING and answers the other question: how does the world here already differ from this "
                + "template? Use it to check that what got built — by hand, by a generator, by an earlier "
                + "place — is what the file says, which is the one thing screenshots cannot tell you. It "
                + "returns `match`/`differ`, a `differences` sample of {at, expected, actual} in set_blocks "
                + "syntax, `verdict`, and `not_specified` — cells the template leaves as structure_void and "
                + "therefore has no opinion about, which is NOT the same fact as cells that match. `dry_run` "
                + "reports the footprint, `occupied` — what is standing there now — and `would_change`. A "
                + "destination chunk that cannot be read refuses the "
                + "whole call rather than placing half a building. Returns `region`, `cells` (footprint "
                + "volume), `occupied`, `changed`/`unchanged`, `block_entities`, `entities_placed`, and an "
                + "`undo_id` (null on dry_run) revertible with undo_edit.",
            Schemas.objectOpt(
                Schemas.object(
                    "id", Schemas.str("Namespaced template id, e.g. mymod:rooms/library."),
                    "at", Schemas.vec3i("Where the template's origin corner lands."),
                    "rotation", Schemas.str("none|clockwise_90|180|counterclockwise_90 (default none)."),
                    "mirror", Schemas.str("none|left_right|front_back (default none)."),
                    "entities", Schemas.bool("Place the file's entities too (default false)."),
                    "physics", Schemas.bool("Apply neighbour/physics updates (default false = quiet)."),
                    "dry_run", Schemas.bool("If true, report the footprint but change nothing."),
                    "compare", Schemas.bool("If true, CHANGE NOTHING and report how the world already "
                        + "differs from this template at this position."),
                    "dimension", Schemas.str("Dimension to write in. Default: minecraft:overworld.")),
                "rotation", "mirror", "entities", "physics", "dry_run", "compare", "dimension"),
            ExecutionContext.SERVER,
            Mechanism.WORLD_EDIT,
            (ctx, a) -> place(ctx.serverOrThrow(), a, ctx.sessionId())));
    }

    private static JsonObject place(final MinecraftServer server, final JsonObject a,
                                    final @Nullable String session) {
        ServerLevel level = WorldPerceptionTools.levelArg(server, a);
        Identifier id = templateId(a);
        Optional<StructureTemplate> maybe = server.getStructureManager().get(id);
        if (maybe.isEmpty()) {
            // The whole reason this tool exists rather than a run_command: a template that is not there
            // is an answer, and it names the way to find out what IS there.
            throw new IllegalArgumentException("no loaded structure template '" + id + "' — list them with "
                + "query_registry {registry:\"structure_template\", contains:\"…\"}. A template pushed into "
                + "the live datapack needs a reload_data before the game can see it.");
        }
        StructureTemplate template = maybe.get();

        BlockPos at = vec(a, "at");
        Rotation rotation = rotation(a);
        Mirror mirror = mirror(a);
        boolean entities = flag(a, "entities", false);
        boolean physics = flag(a, "physics", false);
        boolean dryRun = flag(a, "dry_run", false);
        boolean compare = flag(a, "compare", false);

        StructurePlaceSettings settings = new StructurePlaceSettings()
            .setRotation(rotation)
            .setMirror(mirror)
            .setIgnoreEntities(!entities);

        BoundingBox box = template.getBoundingBox(settings, at);
        int[] region = EditJournal.bounds(box.minX(), box.minY(), box.minZ(), box.maxX(), box.maxY(), box.maxZ());

        // THE FOOTPRINT, NOT THE TEMPLATE'S CELL LIST — and the difference is a finding worth keeping.
        // The obvious route is StructureTemplate.filterBlocks(at, settings, STRUCTURE_VOID), which reads
        // like "every cell except the voids" and is the exact opposite: `Palette.blocks(Block)` filters
        // TO that block, because its caller is jigsaw code looking for connector blocks. The first draft
        // used it and every count came back 0. The template's real block list lives behind a private
        // `palettes` field; reaching it would mean an access widener (Fabric-only, and this jar also
        // ships NeoForge) or re-deriving the transform from the saved NBT — a second implementation of
        // exactly the arithmetic placeInWorld owns. So the reply is computed from the WORLD instead:
        // snapshot the footprint, place, diff. Everything reported is then a fact about what happened
        // rather than a prediction about what should have.
        long volume = (long) box.getXSpan() * box.getYSpan() * box.getZSpan();
        if (volume > MAX_CELLS) {
            throw new IllegalArgumentException("footprint volume " + volume + " exceeds the cap of "
                + MAX_CELLS + " — place it in pieces");
        }

        // Page the footprint in the way every read tool does, and REFUSE on a column that will not read.
        // Vanilla's /place makes the same check; what matters here is that a half-placed building is not
        // reported as a placement.
        ReadSupport.ChunkLoader loader = new ReadSupport.ChunkLoader(level, true);
        BlockPos.MutableBlockPos probe = new BlockPos.MutableBlockPos();
        int unread = 0;
        int columns = 0;
        for (int x = box.minX(); x <= box.maxX(); x++) {
            for (int z = box.minZ(); z <= box.maxZ(); z++) {
                columns++;
                if (!loader.ensure(probe.set(x, box.minY(), z))) {
                    unread++;
                }
            }
        }
        if (unread > 0) {
            throw new IllegalArgumentException(unread + " of " + columns + " columns under the footprint "
                + "could not be read (never-generated terrain, or the paging budget) — nothing was placed, "
                + "because a placement into unloaded chunks is a half-built structure reported as a whole one");
        }

        JsonObject r = new JsonObject();
        r.addProperty("id", id.toString());
        r.add("at", xyz(at.getX(), at.getY(), at.getZ()));
        r.addProperty("rotation", rotation.getSerializedName());
        r.addProperty("mirror", mirror.getSerializedName());
        var size = template.getSize(rotation);
        r.add("size", xyz(size.getX(), size.getY(), size.getZ()));
        r.addProperty("cells", (int) volume);
        r.addProperty("dry_run", dryRun);

        // Read the whole footprint ONCE. `occupied` is the half a dry run can answer exactly — what is
        // standing where this would build — and it is computed by the same loop in both modes, so the
        // preview cannot drift from the run (the place_shapes lesson: never assert a preview against a
        // constant; make it the live run's own first half).
        int cells = (int) volume;
        BlockState[] before = new BlockState[cells];
        int occupied = 0;
        int i = 0;
        for (int x = box.minX(); x <= box.maxX(); x++) {
            for (int y = box.minY(); y <= box.maxY(); y++) {
                for (int z = box.minZ(); z <= box.maxZ(); z++) {
                    BlockState st = level.getBlockState(probe.set(x, y, z));
                    before[i++] = st;
                    if (!st.isAir()) {
                        occupied++;
                    }
                }
            }
        }
        r.addProperty("occupied", occupied);

        if (compare || dryRun) {
            // The paragraph that used to stand here said a dry run could not report how many cells WOULD
            // differ, because this tool had no access to the template's own cell list — and that a number
            // it cannot compute is not a number it may guess. `cells()` is that list, so both modes can
            // now answer it exactly, from the SAME loop the live path would have run.
            List<Cell> want = cells(server, template, id, settings);
            int match = 0;
            int differ = 0;
            int outside = 0;
            JsonArray diffs = new JsonArray();
            for (Cell c : want) {
                BlockPos where = StructureTemplate.calculateRelativePosition(settings, c.pos()).offset(at);
                if (!box.isInside(where)) {
                    // Cannot happen while this transform agrees with getBoundingBox — which is exactly
                    // why it is counted rather than assumed. A non-zero `outside` is this tool telling
                    // you its own arithmetic disagrees with vanilla's, not a fact about your build.
                    outside++;
                    continue;
                }
                BlockState expected = c.state();
                BlockState actual = level.getBlockState(probe.set(where.getX(), where.getY(), where.getZ()));
                if (expected.equals(actual)) {
                    match++;
                    continue;
                }
                differ++;
                if (diffs.size() < DIFF_LIMIT) {
                    JsonObject d = new JsonObject();
                    d.add("at", xyz(where.getX(), where.getY(), where.getZ()));
                    d.addProperty("expected", BlockStateParser.serialize(expected));
                    d.addProperty("actual", BlockStateParser.serialize(actual));
                    diffs.add(d);
                }
            }
            r.addProperty("template_cells", want.size());
            r.addProperty(compare ? "match" : "would_keep", match);
            r.addProperty(compare ? "differ" : "would_change", differ);
            if (outside > 0) {
                r.addProperty("outside_footprint", outside);
            }
            if (compare) {
                r.addProperty("compare", true);
                r.add("differences", diffs);
                if (differ > diffs.size()) {
                    r.addProperty("differences_truncated", differ - diffs.size());
                }
                // A template stores no cell where it has structure_void, so those positions carry no
                // opinion and are not compared. Said out loud because "cells the template does not
                // mention" and "cells that match" are different facts and reading one as the other is
                // how an unfinished room reports as a finished one.
                r.addProperty("not_specified", cells - want.size() - outside);
                r.addProperty("verdict", differ == 0 ? "identical" : "differs");
            }
            EditJournal.stampEnvelope(r, level, region, null);
            return r;
        }

        EditJournal.Recorder recorder = EditJournal.recorder(level, "place_structure", session);
        i = 0;
        for (int x = box.minX(); x <= box.maxX(); x++) {
            for (int y = box.minY(); y <= box.maxY(); y++) {
                for (int z = box.minZ(); z <= box.maxZ(); z++) {
                    recorder.capture(probe.set(x, y, z), before[i++]);
                }
            }
        }

        int flags = physics ? Block.UPDATE_ALL : Block.UPDATE_CLIENTS;
        int entitiesBefore = entities ? countEntities(level, box) : 0;
        boolean placed = template.placeInWorld(level, at, at, settings, RandomSource.create(), flags);
        if (!placed) {
            // placeInWorld returns false for an empty palette or a degenerate size — both properties of
            // the FILE, so say that rather than reporting a placement of nothing.
            throw new IllegalStateException("the template '" + id + "' placed nothing — its palette is "
                + "empty or its size is degenerate on some axis. Check it with query_registry "
                + "{registry:\"structure_template\", entry:\"" + id + "\"}.");
        }

        int changed = 0;
        int blockEntities = 0;
        i = 0;
        for (int x = box.minX(); x <= box.maxX(); x++) {
            for (int y = box.minY(); y <= box.maxY(); y++) {
                for (int z = box.minZ(); z <= box.maxZ(); z++) {
                    BlockState now = level.getBlockState(probe.set(x, y, z));
                    if (!now.equals(before[i++])) {
                        changed++;
                    }
                    if (now.hasBlockEntity()) {
                        blockEntities++;
                    }
                }
            }
        }
        r.addProperty("changed", changed);
        // A cell the template left exactly as it found it is `unchanged`, not a failure — the bucket
        // set_blocks and place_shape both have, and the normal case when a piece is re-placed to nudge
        // it. Before those tools had it, re-writing a correct room read back as a wall of errors.
        r.addProperty("unchanged", cells - changed);
        r.addProperty("block_entities", blockEntities);

        int entitiesPlaced = entities ? Math.max(0, countEntities(level, box) - entitiesBefore) : 0;
        r.addProperty("entities_placed", entitiesPlaced);

        String undoId = recorder.commit(changed, region);
        if (entitiesPlaced > 0) {
            r.addProperty("undo_note", "undo_edit restores BLOCKS only — the " + entitiesPlaced
                + " entity/entities this placed are not removed by it");
        }
        EditJournal.stampEnvelope(r, level, region, undoId);
        return r;
    }

    private static int countEntities(final ServerLevel level, final BoundingBox box) {
        return level.getEntities((net.minecraft.world.entity.Entity) null, new net.minecraft.world.phys.AABB(
            box.minX(), box.minY(), box.minZ(),
            box.maxX() + 1.0, box.maxY() + 1.0, box.maxZ() + 1.0), e -> true).size();
    }

    private static Identifier templateId(final JsonObject a) {
        if (!a.has("id") || a.get("id").isJsonNull() || a.get("id").getAsString().isBlank()) {
            throw new IllegalArgumentException("missing `id` — the namespaced template id, e.g. "
                + "mymod:rooms/library");
        }
        String s = a.get("id").getAsString().trim();
        return Identifier.parse(s.contains(":") ? s : "minecraft:" + s);
    }

    private static Rotation rotation(final JsonObject a) {
        String s = optLower(a, "rotation");
        if (s == null || s.equals("none") || s.equals("0")) {
            return Rotation.NONE;
        }
        return switch (s) {
            case "clockwise_90", "cw_90", "90" -> Rotation.CLOCKWISE_90;
            case "180", "clockwise_180" -> Rotation.CLOCKWISE_180;
            case "counterclockwise_90", "ccw_90", "270" -> Rotation.COUNTERCLOCKWISE_90;
            default -> throw new IllegalArgumentException("unknown `rotation` '" + s
                + "' (none|clockwise_90|180|counterclockwise_90)");
        };
    }

    private static Mirror mirror(final JsonObject a) {
        String s = optLower(a, "mirror");
        if (s == null || s.equals("none")) {
            return Mirror.NONE;
        }
        return switch (s) {
            case "left_right" -> Mirror.LEFT_RIGHT;
            case "front_back" -> Mirror.FRONT_BACK;
            default -> throw new IllegalArgumentException("unknown `mirror` '" + s
                + "' (none|left_right|front_back)");
        };
    }

    private static @Nullable String optLower(final JsonObject a, final String key) {
        return a.has(key) && !a.get(key).isJsonNull()
            ? a.get(key).getAsString().trim().toLowerCase(Locale.ROOT) : null;
    }

    private static boolean flag(final JsonObject a, final String key, final boolean def) {
        return a.has(key) && !a.get(key).isJsonNull() ? a.get(key).getAsBoolean() : def;
    }

    private static BlockPos vec(final JsonObject a, final String key) {
        if (!a.has(key) || !a.get(key).isJsonObject()) {
            throw new IllegalArgumentException("missing `" + key + "` {x,y,z}");
        }
        JsonObject o = a.getAsJsonObject(key);
        for (String axis : new String[] {"x", "y", "z"}) {
            if (!o.has(axis) || o.get(axis).isJsonNull()) {
                throw new IllegalArgumentException("`" + key + "` needs " + axis);
            }
        }
        return new BlockPos(o.get("x").getAsInt(), o.get("y").getAsInt(), o.get("z").getAsInt());
    }

    /** One cell a template actually specifies: its template-local position and its placed state. */
    private record Cell(BlockPos pos, BlockState state) {}

    /**
     * The template's own cell list — what {@code place_structure} was written without, and the reason its
     * dry run could not say how many cells a placement would change.
     *
     * <p>The obvious route is {@link StructureTemplate#filterBlocks}, and it is a trap this file already
     * documents: {@code Palette.blocks(Block)} filters TO a block, not away from it. The real list lives
     * behind a private {@code palettes} field, and reaching it would need an access widener — Fabric-only,
     * and this jar also ships NeoForge. So the list is read back out of the template's OWN SAVED TAG, the
     * same idiom {@code capture_structure} uses for its census: a fact taken from the bytes rather than
     * asserted about them.
     *
     * <p><b>Mirror THEN rotate.</b> That is what {@link StructureTemplate#placeInWorld} does, and
     * placeInWorld is what actually drew the blocks being compared. {@code filterBlocks} rotates and does
     * NOT mirror — copying it would have made every mirrored comparison wrong, and wrong in a way that
     * reads as the build being at fault.
     */
    private static List<Cell> cells(final MinecraftServer server, final StructureTemplate template,
                                    final Identifier id, final StructurePlaceSettings settings) {
        CompoundTag tag = template.save(new CompoundTag());
        if (tag.getList("palettes").isPresent()) {
            // capture_structure's javadoc names this trap: a reader that expects the single-palette key
            // resolves every block to air. Refuse rather than compare against one arbitrary variant and
            // report the other variants' cells as differences.
            throw new IllegalArgumentException("template '" + id + "' has multiple palettes, so there is "
                + "no single authored state to compare against — which variant a placement uses is chosen "
                + "at random per position. Compare a single-palette template.");
        }
        ListTag palette = tag.getListOrEmpty("palette");
        HolderGetter<Block> lookup = server.registryAccess().lookupOrThrow(Registries.BLOCK);
        BlockState[] states = new BlockState[palette.size()];
        for (int i = 0; i < palette.size(); i++) {
            states[i] = NbtUtils.readBlockState(lookup, palette.getCompoundOrEmpty(i));
        }
        Mirror mirror = settings.getMirror();
        Rotation rotation = settings.getRotation();
        ListTag blocks = tag.getListOrEmpty("blocks");
        List<Cell> out = new ArrayList<>(blocks.size());
        for (int i = 0; i < blocks.size(); i++) {
            CompoundTag b = blocks.getCompoundOrEmpty(i);
            ListTag p = b.getListOrEmpty("pos");
            BlockPos local = new BlockPos(p.getIntOr(0, 0), p.getIntOr(1, 0), p.getIntOr(2, 0));
            int index = b.getIntOr("state", 0);
            BlockState st = index >= 0 && index < states.length
                ? states[index] : Blocks.AIR.defaultBlockState();
            out.add(new Cell(local, st.mirror(mirror).rotate(rotation)));
        }
        return out;
    }

    private static JsonObject xyz(final int x, final int y, final int z) {
        JsonObject o = new JsonObject();
        o.addProperty("x", x);
        o.addProperty("y", y);
        o.addProperty("z", z);
        return o;
    }
}
