package com.mattmc.mcptoolkit;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import it.unimi.dsi.fastutil.longs.Long2ObjectMap;
import it.unimi.dsi.fastutil.longs.Long2ObjectOpenHashMap;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import org.jspecify.annotations.Nullable;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.function.UnaryOperator;

/**
 * Primitive geometry for building: place {@code box | line | cylinder | ellipsoid} shapes of one block each,
 * with explicit fill mode, a replace mask, and a dry-run preview. Deliberately low-level — there are no
 * "house parts" here; you compose structures yourself from these primitives and stay in full control of
 * exactly which blocks change.
 *
 * <p>Two tools, one engine. {@code place_shape} takes one shape; {@code place_shapes} takes an ordered
 * array of them and applies them in one call. The plural form exists for a measured reason, not for
 * convenience: by TOKEN_PER_TOOL_FINDINGS.md finding 1 the static tool prefix is re-read on <em>every</em>
 * turn (92% of the bill on short sessions), so a forty-fill room built one call at a time re-pays the whole
 * schema set thirty-nine times to carry information the model already had when it emitted the first shape.
 * The cost of a build is dominated by turn count, so batching the ops is the lever
 * (STRUCTURE_AUTHORING_DESIGN.md §4).
 *
 * <p>Placement uses {@link Block#UPDATE_CLIENTS} (no neighbour physics) so a bulk shape doesn't trigger
 * water flow / gravity cascades mid-build, matching how schematic pasters work.
 *
 * <p>Mechanism note (ARCHITECTURE.md): these are {@code world_edit} operations — direct server edits, not
 * embodied actions. Nothing "mined" these blocks; they change by editing authority. {@code dry_run} is the
 * preview; each applied call records into the shared {@link EditJournal} and returns an {@code undo_id} plus
 * its affected {@code region}, reverted through the general {@code undo_edit} tool. A batch files <b>one</b>
 * edit, because the batch is the unit a person would want to revert.
 */
public final class ShapeTools {
    private ShapeTools() {}

    /**
     * Hard ceiling on blocks changed by one <b>call</b>, so a huge radius can't lock the server. For
     * {@code place_shapes} this is a budget over the whole array, not per op: a per-op ceiling with no
     * aggregate is how one call locks the server thread anyway, just with more steps. The response reports
     * {@code truncated} and (for a batch) {@code truncated_at_op} so the ceiling is never silent.
     */
    private static final int MAX_BLOCKS = 500_000;
    /**
     * Ceiling on ops in one {@code place_shapes} call. The point of the batch is to collapse the turns of
     * one authored structure, and a structure is tens of shapes; past this the response itself is the cost
     * and the caller wants two calls.
     */
    private static final int MAX_OPS = 256;
    private static final int FLAGS = Block.UPDATE_CLIENTS;

    /** Shared by both tools, so the two responses cannot drift on what `rejected` means. */
    private static final String REJECTED_NOTE = "cells outside the build height or refused by the world "
        + "— not placed, not counted, not in the region/undo record";

    /**
     * Which fill modes each shape actually honours — the single source of truth, so a batch can refuse a bad
     * mode <em>before</em> it writes anything and the generators below can trust their input. {@code line}
     * is listed with only {@code solid} because it has no fill/shell distinction at all: it takes
     * {@code thickness}. It used to accept any mode and ignore it, which is the silent kind of wrong.
     * Ordered lists, not sets, so the error message naming the alternatives is stable.
     */
    private static final Map<String, List<String>> MODES = Map.of(
        "box", List.of("solid", "hollow", "frame", "walls"),
        "line", List.of("solid"),
        "cylinder", List.of("solid", "hollow"),
        "ellipsoid", List.of("solid", "hollow"));

    public static void register() {
        McpTools.register(ToolDef.of(
            "place_shape",
            "Place one primitive shape of a single block, with full control over what changes. "
                + "shape=box|line|cylinder|ellipsoid. Geometry: box/line take `p1` and `p2` {x,y,z}; cylinder "
                + "and ellipsoid take `center`, plus `radius` (or per-axis `radii` {x,y,z} for ellipsoid), "
                + "cylinder also `height` and `axis` (x|y|z, default y). `mode`: box supports "
                + "solid|hollow|frame|walls, cylinder/ellipsoid solid|hollow (line uses `thickness`). "
                + "Control: `dry_run`:true returns the block count + region without placing; `replace` (a "
                + "block id) only overwrites that block; `air_only`:true only fills empty space; `dimension` "
                + "picks the world written (default minecraft:overworld). Returns "
                + "placed/skipped/truncated (plus unchanged: cells already in the target state, and "
                + "rejected: cells the world refused, e.g. outside build height — only confirmed writes "
                + "count as placed or appear in the region) plus the affected `region` and an `undo_id` "
                + "(null on dry_run) — revert it with undo_edit. To place several shapes at once, use "
                + "place_shapes.",
            shapeSchema(true, true),
            ExecutionContext.SERVER,
            Mechanism.WORLD_EDIT,
            (ctx, a) -> placeShape(ctx.serverOrThrow(), a, ctx.sessionId())));

        McpTools.register(ToolDef.of(
            "place_shapes",
            "Batch form of place_shape: MANY shapes in ONE call (a room is typically 10-40). `ops` is an "
                + "array of place_shape argument objects; `dry_run` and `dimension` are per-CALL, outside the "
                + "array. Ops apply IN ORDER and each sees what earlier ones wrote, so shell-then-carve-air "
                + "works as written. The " + MAX_BLOCKS + "-block ceiling is a budget for the whole CALL "
                + "(then `truncated_at_op`, later ops `not_run`); one malformed op refuses the batch having "
                + "written nothing. Returns per-op counts, the union `region`, and ONE `undo_id`. `dry_run` "
                + "simulates the ops against each other.",
            shapesSchema(),
            ExecutionContext.SERVER,
            Mechanism.WORLD_EDIT,
            (ctx, a) -> placeShapes(ctx.serverOrThrow(), a, ctx.sessionId())));
    }

    /**
     * The shape-argument schema. With {@code callControls} it is the whole {@code place_shape} input; without,
     * it is one element of {@code place_shapes.ops} — {@code dry_run} and {@code dimension} are deliberately
     * absent there rather than present-and-ignored, because a per-op dimension the tool silently drops is the
     * kind of accepted-then-discarded argument this project treats as a bug.
     *
     * <p>{@code describeFields} is a TOKEN decision, measured. The 2026-08-17 shapebatch measurement priced
     * carrying {@code place_shapes} at 954 prefix tokens re-read every turn, and the reconstruction that
     * followed (2026-08-23) split that bill: the description was only 36.5% of it and the SCHEMA was the
     * larger half — because {@code ops.items} repeated, field for field, the descriptions {@code place_shape}
     * already carries. The two tools are hidden together and shown together (the shim's {@code OPERATOR} list
     * names both), so a caller that can see {@code place_shapes} can always see {@code place_shape} beside it:
     * the field docs are in the prefix exactly once, where they belong, and {@code ops} points at them. Types
     * and the required/optional split stay — those are the machine-checkable half and cost little.
     */
    private static JsonObject shapeSchema(final boolean callControls, final boolean describeFields) {
        final UnaryOperator<JsonObject> d = describeFields ? UnaryOperator.identity() : Schemas::undescribe;
        List<Object> fields = new ArrayList<>(List.of(
            "shape", d.apply(Schemas.str("box | line | cylinder | ellipsoid")),
            "block", d.apply(Schemas.str("Block to place; supports states, e.g. minecraft:oak_planks, "
                + "minecraft:oak_log[axis=x], minecraft:air to clear.")),
            "p1", Schemas.vec3i(),
            "p2", Schemas.vec3i(),
            "center", Schemas.vec3i(),
            "radius", d.apply(Schemas.integer("Radius for cylinder/ellipsoid (uniform).")),
            "radii", Schemas.vec3i(),
            "height", d.apply(Schemas.integer("Cylinder length along its axis.")),
            "axis", d.apply(Schemas.str("Cylinder axis: x | y | z (default y).")),
            "mode", d.apply(Schemas.str("box: solid|hollow|frame|walls; cylinder/ellipsoid: solid|hollow; "
                + "line takes `thickness` instead. Default solid.")),
            "thickness", d.apply(Schemas.integer("Shell/line thickness (default 1).")),
            "replace", d.apply(Schemas.str("Only overwrite this block id (a mask).")),
            "air_only", d.apply(Schemas.bool("If true, only place into air."))));
        if (callControls) {
            fields.addAll(List.of(
                "dry_run", Schemas.bool("If true, count blocks + report bounds but change nothing."),
                "dimension", Schemas.str("Dimension to write in (e.g. minecraft:the_nether). Default: "
                    + "minecraft:overworld; the result stamps the dimension actually written.")));
        }
        return Schemas.objectOpt(Schemas.object(fields.toArray()), "p1", "p2", "center", "radius", "radii",
            "height", "axis", "mode", "thickness", "replace", "air_only", "dry_run", "dimension");
    }

    private static JsonObject shapesSchema() {
        JsonObject base = Schemas.object(
            "ops", Schemas.array(shapeSchema(false, false)),
            "dry_run", Schemas.bool("If true, simulate the whole batch (ops against each other) and report "
                + "counts + bounds without changing anything."),
            "dimension", Schemas.str("Dimension every op writes in (e.g. minecraft:the_nether). Default: "
                + "minecraft:overworld; the result stamps the dimension actually written."));
        return Schemas.objectOpt(base, "dry_run", "dimension");
    }

    // ---- the call: shared budget, shared undo record, shared region ----------

    /**
     * The state one <em>call</em> owns, however many ops it runs: the block budget, the undo recorder, the
     * union region, and — on a dry run — the overlay that lets the ops see each other.
     *
     * <p><b>The overlay is the whole reason a batch dry run can be trusted.</b> A live run needs none: each
     * op reads {@code level.getBlockState}, which already reflects every op before it. A dry run writes
     * nothing, so without an overlay every op reads the untouched world — and then a shell followed by an
     * air carve reports both volumes in full, roughly double the true count, for the single most common way
     * anyone authors a room. It also fixed a discrepancy that predates the batch: a thick {@code line}
     * revisits its own cells, so its live count buckets the repeats as {@code unchanged} while the old dry
     * run counted them as {@code placed}. Overlaid, preview and reality agree.
     */
    private static final class Batch {
        final ServerLevel level;
        final boolean dryRun;
        final EditJournal.@Nullable Recorder recorder;
        /** Dry-run only: cells this call has already "written". Null on a live run — there the world is it. */
        final @Nullable Long2ObjectMap<BlockState> overlay;

        int placedTotal = 0;
        boolean truncated = false;
        int truncatedAtOp = -1;
        boolean hasBounds = false;
        int minX, minY, minZ, maxX, maxY, maxZ;

        Batch(final ServerLevel level, final boolean dryRun, final EditJournal.@Nullable Recorder recorder) {
            this.level = level;
            this.dryRun = dryRun;
            this.recorder = recorder;
            // Bounded by the block budget, which is what keeps the preview's memory bounded too.
            this.overlay = dryRun ? new Long2ObjectOpenHashMap<>() : null;
        }

        /** What the next op sees at {@code pos}: this call's pending write if there is one, else the world. */
        BlockState stateAt(final BlockPos pos) {
            if (overlay != null) {
                BlockState pending = overlay.get(pos.asLong());
                if (pending != null) {
                    return pending;
                }
            }
            return level.getBlockState(pos);
        }

        /** Dry-run bookkeeping: remember a pending write so the ops after it read what it left. */
        void preview(final BlockPos pos, final BlockState written) {
            Objects.requireNonNull(overlay, "overlay exists exactly when dryRun").put(pos.asLong(), written);
        }

        void markTruncated(final int opIndex) {
            truncated = true;
            if (truncatedAtOp < 0) {
                truncatedAtOp = opIndex;
            }
        }

        void expand(final int x, final int y, final int z) {
            if (!hasBounds) {
                minX = maxX = x;
                minY = maxY = y;
                minZ = maxZ = z;
                hasBounds = true;
                return;
            }
            if (x < minX) minX = x; else if (x > maxX) maxX = x;
            if (y < minY) minY = y; else if (y > maxY) maxY = y;
            if (z < minZ) minZ = z; else if (z > maxZ) maxZ = z;
        }

        int @Nullable [] bounds() {
            return hasBounds ? EditJournal.bounds(minX, minY, minZ, maxX, maxY, maxZ) : null;
        }

        /** Stamp the transactional envelope and the undo-cap disclosure onto a response. */
        void stamp(final JsonObject r) {
            int[] bounds = bounds();
            String undoId = recorder == null ? null : recorder.commit(placedTotal, bounds);
            EditJournal.stampEnvelope(r, level, bounds, undoId); // game_tick + region + undo_id
            // Distinguish "not undoable by design" from a dry run — both produce undo_id:null, and the
            // ARCHITECTURE contract is applied-but-reported-non-undoable, never silence.
            if (recorder != null && recorder.overCap()) {
                r.addProperty("undo_reason", "over_cap: the edit changed more than " + EditJournal.UNDO_CAP
                    + " cells, so it was applied but is not undoable");
            }
        }
    }

    // ---- the op: masking, capping, bounds, undo capture ----------------------

    /** One shape's masking rules and outcome counters, writing through its {@link Batch}. */
    private static final class Op {
        final Batch batch;
        final int index;
        final BlockState state;
        final @Nullable Block replace;
        final boolean airOnly;
        final BlockPos.MutableBlockPos cursor = new BlockPos.MutableBlockPos();

        int placed = 0;
        int skipped = 0;
        int unchanged = 0;
        int rejected = 0;

        Op(final Batch batch, final int index, final Prepared p) {
            this.batch = batch;
            this.index = index;
            this.state = p.state();
            this.replace = p.replace();
            this.airOnly = p.airOnly();
        }

        /** True once the call's block budget is spent — the generators use it to stop looping. */
        boolean capped() {
            return batch.truncated;
        }

        void at(int x, int y, int z) {
            if (batch.truncated) {
                return;
            }
            cursor.set(x, y, z);
            // Everything below counts OUTCOMES, not intent: `placed`, the region bounds, and the
            // undo snapshot only ever cover cells whose write was actually confirmed — a shape
            // hanging past the build-height limit used to count those cells as placed.
            if (batch.level.isOutsideBuildHeight(cursor)) {
                rejected++;
                return;
            }
            BlockState current = batch.stateAt(cursor);
            if (replace != null && current.getBlock() != replace) {
                skipped++;
                return;
            }
            if (airOnly && !current.isAir()) {
                skipped++;
                return;
            }
            if (current == state) {
                unchanged++; // already the target state; setBlock would no-op
                return;
            }
            if (batch.placedTotal >= MAX_BLOCKS) {
                batch.markTruncated(index); // the budget belongs to the CALL, so record WHERE it ran out
                return;
            }
            if (batch.dryRun) {
                batch.preview(cursor, state); // so the ops after this one see it
                batch.expand(x, y, z);
                placed++;
                batch.placedTotal++;
                return;
            }
            if (batch.recorder != null) {
                batch.recorder.capture(cursor, current); // snapshot prior state + BE NBT before overwriting
            }
            if (!batch.level.setBlock(cursor, state, FLAGS)) {
                if (batch.recorder != null) {
                    batch.recorder.dropLast(); // nothing changed — nothing to undo for this cell
                }
                rejected++;
                return;
            }
            batch.expand(x, y, z);
            placed++;
            batch.placedTotal++;
        }
    }

    // ---- parse, then execute -------------------------------------------------

    /**
     * One op with every argument already resolved and validated. Separating parse from execute is what lets
     * {@code place_shapes} refuse a malformed op having written nothing: ops apply in order and later ones
     * routinely carve into what earlier ones laid, so a batch that died halfway would leave a half-authored
     * structure whose remaining ops were written against geometry that never appeared.
     */
    private record Prepared(String shape, String blockId, BlockState state, String mode, int thickness,
                            @Nullable Block replace, boolean airOnly,
                            @Nullable BlockPos p1, @Nullable BlockPos p2, @Nullable BlockPos center,
                            int radius, int @Nullable [] radii, int height, char axis) {}

    /** Resolve and validate one op's arguments. Throws (writing nothing) on anything malformed. */
    private static Prepared prepare(final MinecraftServer server, final JsonObject a) {
        String shape = str(a, "shape").toLowerCase(Locale.ROOT);
        List<String> modes = MODES.get(shape);
        if (modes == null) {
            throw new IllegalArgumentException(
                "unknown shape '" + shape + "' (box|line|cylinder|ellipsoid)");
        }
        String mode = a.has("mode") && !a.get("mode").isJsonNull()
            ? a.get("mode").getAsString().toLowerCase(Locale.ROOT) : "solid";
        if (!modes.contains(mode)) {
            throw new IllegalArgumentException("shape '" + shape + "' does not support mode '" + mode
                + "' (" + String.join("|", modes) + ")"
                + (shape.equals("line") ? " — a line's shell is `thickness`, not a mode" : ""));
        }
        BlockState state = BlockTools.parseState(server, str(a, "block"));
        int thickness = a.has("thickness") && !a.get("thickness").isJsonNull()
            ? Math.max(1, a.get("thickness").getAsInt()) : 1;
        boolean airOnly = a.has("air_only") && !a.get("air_only").isJsonNull() && a.get("air_only").getAsBoolean();
        Block replace = a.has("replace") && !a.get("replace").isJsonNull()
            ? parseBlock(a.get("replace").getAsString()).getBlock() : null;

        BlockPos p1 = null, p2 = null, center = null;
        int[] radii = null;
        int radius = 0, height = 0;
        char axis = 'y';
        switch (shape) {
            case "box", "line" -> {
                p1 = pos(a, "p1");
                p2 = pos(a, "p2");
            }
            case "cylinder" -> {
                center = pos(a, "center");
                radius = radius(a);
                height = height(a);
                axis = axis(a);
            }
            default -> { // ellipsoid — MODES already rejected anything else
                center = pos(a, "center");
                radii = radii(a);
            }
        }
        return new Prepared(shape, str(a, "block"), state, mode, thickness, replace, airOnly,
            p1, p2, center, radius, radii, height, axis);
    }

    /** Run a prepared op's generator. Every argument it reads was validated by {@link #prepare}. */
    private static void execute(final Prepared p, final Op op) {
        switch (p.shape()) {
            case "box" -> box(op, Objects.requireNonNull(p.p1()),
                Objects.requireNonNull(p.p2()), p.mode(), p.thickness());
            case "line" -> line(op, Objects.requireNonNull(p.p1()),
                Objects.requireNonNull(p.p2()), p.thickness());
            case "cylinder" -> cylinder(op, Objects.requireNonNull(p.center()), p.radius(),
                p.height(), p.axis(), p.mode(), p.thickness());
            case "ellipsoid" -> ellipsoid(op, Objects.requireNonNull(p.center()),
                Objects.requireNonNull(p.radii()), p.mode(), p.thickness());
            default -> throw new IllegalStateException("unvalidated shape '" + p.shape() + "'");
        }
    }

    // ---- the two tools -------------------------------------------------------

    private static JsonObject placeShape(final MinecraftServer server, final JsonObject a,
                                         final @Nullable String session) {
        ServerLevel level = WorldPerceptionTools.levelArg(server, a);
        boolean dryRun = a.has("dry_run") && !a.get("dry_run").isJsonNull() && a.get("dry_run").getAsBoolean();
        Prepared p = prepare(server, a);

        // Record undo only for applied ops; the journal assigns the undo id after the op runs.
        Batch batch = new Batch(level, dryRun,
            dryRun ? null : EditJournal.recorder(level, "place_shape", session));
        Op op = new Op(batch, 0, p);
        execute(p, op);

        JsonObject r = new JsonObject();
        r.addProperty("shape", p.shape());
        r.addProperty("block", p.blockId());
        r.addProperty("mode", p.mode());
        r.addProperty("dryRun", dryRun);
        r.addProperty("placed", op.placed);
        r.addProperty("skipped", op.skipped);
        if (op.unchanged > 0) {
            r.addProperty("unchanged", op.unchanged); // already the target state, not rewritten
        }
        if (op.rejected > 0) {
            r.addProperty("rejected", op.rejected);
            r.addProperty("rejected_note", REJECTED_NOTE);
        }
        r.addProperty("truncated", batch.truncated);
        batch.stamp(r);
        return r;
    }

    private static JsonObject placeShapes(final MinecraftServer server, final JsonObject a,
                                          final @Nullable String session) {
        ServerLevel level = WorldPerceptionTools.levelArg(server, a);
        if (!a.has("ops") || !a.get("ops").isJsonArray()) {
            throw new IllegalArgumentException("missing `ops` array of shape ops (each one takes the same "
                + "arguments as place_shape, minus dimension/dry_run)");
        }
        JsonArray ops = a.getAsJsonArray("ops");
        if (ops.isEmpty()) {
            throw new IllegalArgumentException("`ops` is empty — nothing to place");
        }
        if (ops.size() > MAX_OPS) {
            throw new IllegalArgumentException("too many ops (" + ops.size() + " > " + MAX_OPS
                + ") — split the structure across calls");
        }
        boolean dryRun = a.has("dry_run") && !a.get("dry_run").isJsonNull() && a.get("dry_run").getAsBoolean();

        // PARSE EVERYTHING FIRST — see Prepared's javadoc for why a batch must not half-apply.
        List<Prepared> plan = new ArrayList<>(ops.size());
        for (int i = 0; i < ops.size(); i++) {
            if (!ops.get(i).isJsonObject()) {
                throw new IllegalArgumentException("ops[" + i + "] is not an object — nothing was placed");
            }
            JsonObject op = ops.get(i).getAsJsonObject();
            // The schema leaves these two out of an op deliberately; refusing them keeps that honest.
            // Accepting a per-op `dimension` and quietly writing to the call's is exactly the kind of
            // accepted-then-discarded argument that turns into "the tool ignored me" hours later.
            for (String perCall : new String[] {"dry_run", "dimension"}) {
                if (op.has(perCall)) {
                    throw new IllegalArgumentException("ops[" + i + "] carries `" + perCall + "`, which is "
                        + "per-CALL — move it beside `ops`. Nothing was placed");
                }
            }
            try {
                plan.add(prepare(server, op));
            } catch (RuntimeException ex) {
                throw new IllegalArgumentException("ops[" + i + "]: " + ex.getMessage()
                    + " — nothing was placed", ex);
            }
        }

        Batch batch = new Batch(level, dryRun,
            dryRun ? null : EditJournal.recorder(level, "place_shapes", session));
        JsonArray results = new JsonArray();
        int skipped = 0, unchanged = 0, rejected = 0;
        for (int i = 0; i < plan.size(); i++) {
            Prepared p = plan.get(i);
            // Captured BEFORE the op runs: an op that never got to try is all-zeros, which is otherwise
            // indistinguishable from an op that legitimately changed nothing.
            boolean startedSpent = batch.truncated;
            Op op = new Op(batch, i, p);
            execute(p, op);
            skipped += op.skipped;
            unchanged += op.unchanged;
            rejected += op.rejected;

            JsonObject o = new JsonObject();
            o.addProperty("op", i);
            o.addProperty("shape", p.shape());
            o.addProperty("block", p.blockId());
            o.addProperty("placed", op.placed);
            if (op.skipped > 0) o.addProperty("skipped", op.skipped);
            if (op.unchanged > 0) o.addProperty("unchanged", op.unchanged);
            if (op.rejected > 0) o.addProperty("rejected", op.rejected);
            if (startedSpent) {
                o.addProperty("not_run", true); // the budget was already gone when this op's turn came
            } else if (batch.truncatedAtOp == i) {
                o.addProperty("partial", true); // this is the op the budget ran out inside
            }
            results.add(o);
        }

        JsonObject r = new JsonObject();
        r.addProperty("ops_count", plan.size());
        r.addProperty("dryRun", dryRun);
        r.addProperty("placed", batch.placedTotal);
        r.addProperty("skipped", skipped);
        if (unchanged > 0) {
            r.addProperty("unchanged", unchanged);
        }
        if (rejected > 0) {
            r.addProperty("rejected", rejected);
            r.addProperty("rejected_note", REJECTED_NOTE);
        }
        r.addProperty("truncated", batch.truncated);
        if (batch.truncated) {
            r.addProperty("truncated_at_op", batch.truncatedAtOp);
            r.addProperty("truncated_note", "the call's " + MAX_BLOCKS + "-block budget ran out inside op "
                + batch.truncatedAtOp + "; that op is `partial` and the ones after it are `not_run`");
        }
        r.add("ops", results);
        if (dryRun) {
            // Say exactly what the preview does and does not model. A number that looks like a block
            // count and is not one is worse than no number.
            r.addProperty("dry_run_note", "ops were simulated in array order against each other, so a cell "
                + "written twice is counted once; only build-height rejections are modelled, so a write the "
                + "live world would refuse for another reason still counts as placed here");
        }
        batch.stamp(r);
        return r;
    }

    // ---- shape generators ----------------------------------------------------

    private static void box(final Op op, final BlockPos p1, final BlockPos p2, final String mode, final int thk) {
        int minX = Math.min(p1.getX(), p2.getX()), maxX = Math.max(p1.getX(), p2.getX());
        int minY = Math.min(p1.getY(), p2.getY()), maxY = Math.max(p1.getY(), p2.getY());
        int minZ = Math.min(p1.getZ(), p2.getZ()), maxZ = Math.max(p1.getZ(), p2.getZ());
        for (int x = minX; x <= maxX; x++) {
            if (op.capped()) return;
            boolean atX = x - minX < thk || maxX - x < thk;
            for (int y = minY; y <= maxY; y++) {
                boolean atY = y - minY < thk || maxY - y < thk;
                for (int z = minZ; z <= maxZ; z++) {
                    boolean atZ = z - minZ < thk || maxZ - z < thk;
                    boolean place = switch (mode) {
                        case "solid" -> true;
                        case "hollow" -> atX || atY || atZ;
                        case "frame" -> (atX ? 1 : 0) + (atY ? 1 : 0) + (atZ ? 1 : 0) >= 2;
                        case "walls" -> atX || atZ;
                        // Unreachable: MODES + prepare() validate the mode before any write. Kept as an
                        // invariant guard, not a user-facing check — the user-facing one names the
                        // alternatives and fires before the batch touches the world.
                        default -> throw new IllegalStateException("unvalidated box mode '" + mode + "'");
                    };
                    if (place) {
                        op.at(x, y, z);
                    }
                }
            }
        }
    }

    private static void line(final Op op, final BlockPos p1, final BlockPos p2, final int thk) {
        int dx = p2.getX() - p1.getX(), dy = p2.getY() - p1.getY(), dz = p2.getZ() - p1.getZ();
        int n = Math.max(Math.abs(dx), Math.max(Math.abs(dy), Math.abs(dz)));
        int r = (thk - 1) / 2;
        for (int i = 0; i <= n; i++) {
            if (op.capped()) return;
            double t = n == 0 ? 0.0 : (double) i / n;
            int px = (int) Math.round(p1.getX() + dx * t);
            int py = (int) Math.round(p1.getY() + dy * t);
            int pz = (int) Math.round(p1.getZ() + dz * t);
            if (thk <= 1) {
                op.at(px, py, pz);
            } else {
                for (int ox = -r; ox <= r; ox++)
                    for (int oy = -r; oy <= r; oy++)
                        for (int oz = -r; oz <= r; oz++)
                            op.at(px + ox, py + oy, pz + oz);
            }
        }
    }

    private static void cylinder(final Op op, final BlockPos c, final int radius, final int height,
                                 final char axis, final String mode, final int thk) {
        boolean hollow = requireSolidOrHollow(mode);
        double outer = (radius + 0.5) * (radius + 0.5);
        double innerR = radius - thk + 0.5;
        double inner = innerR * innerR;
        for (int h = 0; h < height; h++) {
            if (op.capped()) return;
            for (int a = -radius; a <= radius; a++) {
                for (int b = -radius; b <= radius; b++) {
                    double d2 = a * a + b * b;
                    if (d2 > outer) continue;
                    if (hollow && innerR > 0 && d2 <= inner) continue;
                    switch (axis) {
                        case 'x' -> op.at(c.getX() + h, c.getY() + a, c.getZ() + b);
                        case 'z' -> op.at(c.getX() + a, c.getY() + b, c.getZ() + h);
                        default -> op.at(c.getX() + a, c.getY() + h, c.getZ() + b);
                    }
                }
            }
        }
    }

    private static void ellipsoid(final Op op, final BlockPos c, final int[] rr, final String mode, final int thk) {
        boolean hollow = requireSolidOrHollow(mode);
        double rx = rr[0] + 0.5, ry = rr[1] + 0.5, rz = rr[2] + 0.5;
        double ix = rr[0] - thk + 0.5, iy = rr[1] - thk + 0.5, iz = rr[2] - thk + 0.5;
        boolean innerValid = ix > 0 && iy > 0 && iz > 0;
        for (int dx = -rr[0]; dx <= rr[0]; dx++) {
            if (op.capped()) return;
            for (int dy = -rr[1]; dy <= rr[1]; dy++) {
                for (int dz = -rr[2]; dz <= rr[2]; dz++) {
                    double e = (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) + (dz * dz) / (rz * rz);
                    if (e > 1.0) continue;
                    if (hollow && innerValid) {
                        double inner = (dx * dx) / (ix * ix) + (dy * dy) / (iy * iy) + (dz * dz) / (iz * iz);
                        if (inner <= 1.0) continue;
                    }
                    op.at(c.getX() + dx, c.getY() + dy, c.getZ() + dz);
                }
            }
        }
    }

    /** solid|hollow, already validated by {@link #prepare} against {@link #MODES}. */
    private static boolean requireSolidOrHollow(final String mode) {
        if (mode.equals("solid")) return false;
        if (mode.equals("hollow")) return true;
        throw new IllegalStateException("unvalidated mode '" + mode + "' for a solid|hollow shape");
    }

    // ---- parsing helpers -----------------------------------------------------

    private static BlockState parseBlock(final String id) {
        return BuiltInRegistries.BLOCK.getOptional(Identifier.parse(id))
            .orElseThrow(() -> new IllegalArgumentException("unknown block '" + id + "'"))
            .defaultBlockState();
    }

    private static String str(final JsonObject a, final String key) {
        if (!a.has(key) || a.get(key).isJsonNull()) {
            throw new IllegalArgumentException("missing argument '" + key + "'");
        }
        return a.get(key).getAsString();
    }

    private static BlockPos pos(final JsonObject a, final String key) {
        if (!a.has(key) || a.get(key).isJsonNull()) {
            throw new IllegalArgumentException("missing position '" + key + "' {x,y,z}");
        }
        JsonObject p = a.getAsJsonObject(key);
        return new BlockPos(p.get("x").getAsInt(), p.get("y").getAsInt(), p.get("z").getAsInt());
    }

    private static int radius(final JsonObject a) {
        if (!a.has("radius") || a.get("radius").isJsonNull()) {
            throw new IllegalArgumentException("missing `radius`");
        }
        int r = a.get("radius").getAsInt();
        if (r < 0) throw new IllegalArgumentException("`radius` must be >= 0");
        return r;
    }

    private static int[] radii(final JsonObject a) {
        if (a.has("radii") && !a.get("radii").isJsonNull()) {
            JsonObject r = a.getAsJsonObject("radii");
            return new int[] {r.get("x").getAsInt(), r.get("y").getAsInt(), r.get("z").getAsInt()};
        }
        int r = radius(a);
        return new int[] {r, r, r};
    }

    private static int height(final JsonObject a) {
        if (!a.has("height") || a.get("height").isJsonNull()) {
            throw new IllegalArgumentException("missing `height` for cylinder");
        }
        int h = a.get("height").getAsInt();
        if (h <= 0) throw new IllegalArgumentException("`height` must be positive");
        return h;
    }

    private static char axis(final JsonObject a) {
        if (!a.has("axis") || a.get("axis").isJsonNull()) {
            return 'y';
        }
        String s = a.get("axis").getAsString().toLowerCase(java.util.Locale.ROOT);
        if (s.equals("x") || s.equals("y") || s.equals("z")) {
            return s.charAt(0);
        }
        throw new IllegalArgumentException("`axis` must be x|y|z");
    }
}
