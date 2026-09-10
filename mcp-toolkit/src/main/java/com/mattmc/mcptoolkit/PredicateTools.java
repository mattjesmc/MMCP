package com.mattmc.mcptoolkit;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.ReadSupport.ChunkLoader;
import com.mattmc.mcptoolkit.nav.NavProfile;
import com.mattmc.mcptoolkit.nav.NavSolver;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Vec3i;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.tags.FluidTags;
import net.minecraft.world.entity.EntitySpawnReason;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.levelgen.Heightmap;
import net.minecraft.world.level.levelgen.structure.templatesystem.StructureTemplate;
import net.minecraft.world.level.pathfinder.Path;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

import java.util.Optional;

import static com.mattmc.mcptoolkit.ReadSupport.coverage;
import static com.mattmc.mcptoolkit.ReadSupport.loadArg;
import static com.mattmc.mcptoolkit.ReadSupport.walkChunks;

/**
 * Derived spatial predicates — the toolkit answers geometry questions itself instead of serving
 * coordinate lists for the model to do arithmetic over (model spatial arithmetic is the documented
 * failure mode; see RESEARCH_WORLD_REPRESENTATION.md). Four game-generic predicates:
 * the fit/clear predicates (folded 0.22.0: fit = locate at+clear, corridor = check_site from/to),
 * {@code check_path} (can a body actually walk/fly there — promoted from Village Jobs),
 * {@code check_site} (terrain statistics for a building footprint).
 *
 * <p>Shared contract, same as every observe tool: observation envelope + {@code coverage}, and a
 * verdict is NEVER issued over unread space — any queried cell unreadable ⇒ the verdict field is
 * {@code null} with {@code coverage.state} partial/none and a note naming the remedy. Reading
 * never generates terrain. Predicates serve arithmetic, not judgment: {@code check_site} reports
 * stats plus a labeled hint; the decision stays with the planner.
 */
public final class PredicateTools {
    private PredicateTools() {}

    /** Fail-fast volume ceiling (64³). A verdict over a truncated footprint would be worthless. */
    private static final int MAX_VOLUME = 64 * 64 * 64;
    /** check_site footprint ceiling (64×64 columns). */
    private static final int MAX_SITE_COLUMNS = 64 * 64;
    /** check_clearance corridor length ceiling, in blocks. */
    private static final double MAX_CORRIDOR = 256.0;
    /** Conflicts listed by position before collapsing into the count. */
    private static final int MAX_CONFLICTS = 16;
    /** check_site "flat enough" hint threshold on ground-height stddev — a labeled hint, not a verdict. */
    private static final double FLAT_STDDEV = 1.0;
    /** find_site scan ceiling in columns (128×128) — 4× check_site, still heightmap-cheap. */
    private static final int MAX_SEARCH_COLUMNS = 128 * 128;
    private static final int FIND_DEFAULT_RADIUS = 48;
    private static final int FIND_DEFAULT_STRIDE = 4;
    private static final int FIND_DEFAULT_LIMIT = 5;
    private static final int FIND_MAX_LIMIT = 12;

    public static void register() {
        // check_fit and check_clearance were FOLDED (0.22.0): fit is now locate `at` + `clear`
        // (a batch of clear checks over a box IS the fit verdict), and the corridor sweep is
        // check_site's `from`+`to` door — obstruction count is cut-only work, the same relation.
        // The functions below survive as plumbing (find_site's verification stage and
        // resolve_anchor's check still run fitScan/checkFit).
        McpTools.register(ToolDef.of(
            "check_path",
            "Can a body actually get from `from` to `to`? Solves with the real pathfinder for "
                + "`body` — \"walker\" (player-shaped ground body, the default: the same solver and "
                + "shape the spawnable walker executes with, sprint-jump gap crossings included, "
                + "solved entity-free) or \"flyer\" (the drone's flying navigation, via a throwaway "
                + "probe). Reports reachable / partial (path exists but stops short) / node count / "
                + "where the path actually ends, and `work.jumps` when the route leaps gaps. This is "
                + "ground truth for reachability — never infer it from "
                + "coordinates or terrain reads. Give `reach` {x,y,z} (a block) INSTEAD of `to` for "
                + "a goal-shaped question: \"can the body get somewhere it can TOUCH that block "
                + "from\" (within hand reach " + (int) Math.floor(ReachSolver.HAND_REACH) + ".5 of "
                + "the eye, with line of sight — the goto-before-mine/place question). A reach "
                + "verdict is staged: reachable false with reason `occluded` means NO position in "
                + "hand reach has line of sight (the block is enclosed — expose a face first, no "
                + "amount of pathing helps); reason `no_path_to_reach_position` means touchable "
                + "positions exist but this body cannot get to any of them; true comes with `stand`, "
                + "the position the path ends at — hand it to bot_goto, or trust bot_goto `reach` "
                + "to do both steps itself. The search escalates its budget internally: "
                + "reachable is TRUE when a path reaches, FALSE only when the search exhausted the "
                + "reachable area (frontier stopped growing), and NULL when it hit the `max_length` "
                + "ceiling (default max(256, 4x straight-line)) still expanding, or when the chunks "
                + "along the straight line were unreadable (check coverage.state and the note); "
                + "reading never generates terrain. When a path does NOT reach, the answer names the "
                + "BLOCKING BLOCK (`obstruction` {x,y,z,kind,block,path_type,remedy}) and not just "
                + "where the path stopped — act on it directly instead of surveying `end`. "
                + "BUILD-ASSISTED ROUTING (walker only): `may_modify` break|place|both lets the "
                + "solver route THROUGH blocks it would mine and OVER gaps it would bridge, and "
                + "`open_doors`:true lets it route through closed wooden doors (iron doors are never "
                + "assumed — they need a button/lever). NOTE `open_doors` defaults FALSE here but "
                + "TRUE on bot_target — pass it explicitly when comparing prediction to execution. "
                + "Default none: a plain check_path is a can-I-WALK-there question and is unchanged. "
                + "With it on, the reply carries `work` {break_cells, place_cells} — the chosen "
                + "route's plan, optimistic (the body verifies materials/breakability for real as it "
                + "goes) — and a route whose plan exceeds `budget` answers reachable FALSE with "
                + "reason break/place_budget_exceeded, matching what execution would refuse. "
                + "WATER: routes may swim by default (`swim`:false for the land-only question). A "
                + "prediction assumes a FULL lungful, because `from` need not be a live body — a body "
                + "that is already half-drowned will prefer shallower routes than this predicts.",
            Schemas.objectOpt(Schemas.object(
                "from", Schemas.vec3i("Where the route starts. DEFAULTS TO YOUR BODY'S position "
                    + "when you have one (the reply echoes `from` and `from_from`:\"body\"), so the "
                    + "can-I-get-there question costs one call, not a status read plus this."),
                "to", Schemas.vec3i(),
                "reach", Schemas.vec3i(),
                "body", Schemas.str("walker (default) — player-shaped ground navigation (matches the spawnable walker); flyer — the drone's flying navigation."),
                "max_length", Schemas.number("Search budget ceiling in blocks; default max(256, 4x straight-line distance), clamped to 512. Raise it when reachable comes back null."),
                "may_modify", Schemas.str("Build-assisted routing (walker only): none (default) | break | place | both."),
                "open_doors", Schemas.bool("Let the route pass closed WOODEN doors (default false). Iron doors are never assumed."),
                "swim", Schemas.bool("Let the route cross water — surface swim, dive, ascend (default "
                    + "true, matching bot_goto/bot_target). false answers the land-only question."),
                "budget", Schemas.objectOpt(Schemas.object(
                    "break", Schemas.integer("Max cells the plan may break (default 16, cap 256)."),
                    "place", Schemas.integer("Max cells the plan may bridge (default 16, cap 256).")),
                    "break", "place"),
                "dimension", Schemas.str("Dimension id, default minecraft:overworld."),
                "load", Schemas.bool("Pull absent chunks in so they can be read. Default true.")),
                "from", "to", "reach", "body", "max_length", "may_modify", "open_doors", "swim",
                "budget", "dimension", "load"),
            ExecutionContext.SERVER,
            Mechanism.OBSERVE,
            (ctx, a) -> {
                // The asking body, when there is one: it supplies both the default `from` and — when
                // the caller named no dimension either — the level to solve in. Resolving the level
                // from the body matters: defaulting `from` to a nether-standing body while the level
                // defaulted to the overworld would solve a route through the wrong world's terrain
                // and answer it confidently.
                LivingEntity self = com.mattmc.mcptoolkit.drone.DroneTools.activeBodyFor(ctx.sessionId());
                boolean bodyDecides = self != null
                    && !(a.has("from") && a.get("from").isJsonObject())
                    && !(a.has("dimension") && !a.get("dimension").isJsonNull());
                ServerLevel level = bodyDecides
                    ? (ServerLevel) self.level()
                    : WorldPerceptionTools.levelArg(ctx.serverOrThrow(), a);
                // CHECK_PATH_AUDIT.md R1+R2, enforced at the source off the profile header.
                // R1: a survival session may not FORCE-LOAD remote chunks (F4), and the default
                // load path is forced off too — refusing only the literal `load:true` while the
                // default silently paged would be a refusal in name only.
                // R2: the survival solve is KNOWLEDGE-MASKED — it runs over the session's seen-set
                // (fed at the Sightlines tap + body traversal), unknown ≠ blocked, and a search
                // that runs out of knowledge answers null with a knowledge_frontier instead of
                // disclosing unseen terrain. One residual, documented: in `reach` mode the touch
                // shell is computed on the real level once the target block itself is seen —
                // bounded to the seen block's immediate shell, closed fully when the belief-backed
                // answerer lands (DESIGN.md §16.3 v2).
                boolean survival = "survival".equals(ctx.profile());
                if (survival && a.has("load") && !a.get("load").isJsonNull()
                    && a.get("load").getAsBoolean()) {
                    throw new IllegalArgumentException("load_refused: `load:true` pages in remote "
                        + "chunks — an operator power this profile does not have; re-issue without "
                        + "`load` to solve over already-resident terrain only");
                }
                JsonObject callArgs = a;
                if (survival) {
                    callArgs = a.deepCopy();
                    callArgs.addProperty("load", false);
                }
                JsonObject verdict = checkPath(level, callArgs, self,
                    survival ? com.mattmc.mcptoolkit.wm.WmSeen.view(ctx.sessionId()) : null);
                if (survival) {
                    verdict.addProperty("provenance", "held_knowledge");
                    verdict.addProperty("provenance_note", "answered from what this session has "
                        + "OBSERVED (" + com.mattmc.mcptoolkit.wm.WmSeen.size(ctx.sessionId())
                        + " cells) — terrain never seen counts as unknown, not as blocked");
                }
                return verdict;
            }));

        McpTools.register(ToolDef.of(
            "check_site",
            "ONE relation — terrain/modification WORK over an extent — three doors, selected by "
                + "which argument you give (exactly one; no mode flag): "
                + "(1) `at` {x,z} + `size` {w,d}: the footprint VERDICT — `at` is the footprint's "
                + "MIN corner, NOT its centre (the reply echoes `region` so a shifted read is "
                + "visible) — ground height min/max/mean/stddev (MOTION_BLOCKING_NO_LEAVES — "
                + "trees don't count as ground), cut/fill volumes against `y` (or the modal "
                + "ground height when omitted), a top-block histogram, water/lava column counts; "
                + "flat_enough_hint is a labeled stddev hint (≤ " + FLAT_STDDEV + "), not a "
                + "verdict. Footprint capped at 64x64. "
                + "(2) `near` {x,z} + `radius`, OR `bounds` {min_x,min_z,max_x,max_z} for an "
                + "EXACT anchor rectangle (a radius answers \"near here\"; bounds answers "
                + "\"within THIS stated area\" — use bounds whenever the task names a domain), "
                + "+ `size` {w,h,d} (or a structure `template`): the site SEARCH — the server "
                + "scans candidate anchors (grid `stride` default " + FIND_DEFAULT_STRIDE
                + ", 1 = exhaustive) and returns "
                + "the top `limit` (default " + FIND_DEFAULT_LIMIT + ") sorted by least terrain "
                + "work, distance tie-break; each candidate carries pos (min corner, y = ground+1 — "
                + "hand it straight to placement or resolve_anchor), cut/fill, stddev, "
                + "water_columns, and a real fit verdict (`fits`, `clearance` honored) over the "
                + "actual volume; `max_water_columns` (default 0) and `max_stddev` filter, "
                + "`rejected` counts each filter's kills; candidates is null when nothing was "
                + "readable, and partial coverage says better sites may hide in the unread area. "
                + "(3) `from` + `to` {x,y,z} + `profile` {w,h}: the CORRIDOR door — sweeps the "
                + "profile along the straight-line voxel walk and reports `clear` true/false "
                + "(obstruction count is cut-only work; zero = clear), the first obstruction, and "
                + "the obstructed-cell total — the \"does the doorway have headroom / can the drone "
                + "fly straight through\" read (for CAN-I-GET-THERE-somehow, use check_path — that "
                + "is a different question, answered by the real pathfinder). "
                + "(4) `box` {min:{x,y,z}, max:{x,y,z}}: the VOLUME door — ONE call counts the "
                + "cells that are not clear in an exact box (`obstruction_count`, each conflict "
                + "named up to " + MAX_CONFLICTS + "; clear = air or replaceable growth) — "
                + "\"how many blocks intrude / must be removed\" answered exactly, never by "
                + "enumerating cells yourself and summing across batches. All doors: verdicts "
                + "are null over unread space (check coverage.state), reading never generates "
                + "terrain, the decision stays with you — this tool does arithmetic, not judgment. "
                + "Use it instead of reading blocks and doing coordinate arithmetic yourself.",
            Schemas.objectOpt(Schemas.object(
                "at", Schemas.object("x", Schemas.integer("The footprint's MIN corner x — NOT the centre."),
                    "z", Schemas.integer("The footprint's MIN corner z — NOT the centre.")),
                "near", Schemas.object("x", Schemas.integer(), "z", Schemas.integer()),
                "bounds", Schemas.object(
                    "min_x", Schemas.integer(), "min_z", Schemas.integer(),
                    "max_x", Schemas.integer(), "max_z", Schemas.integer()),
                "from", Schemas.vec3i(),
                "to", Schemas.vec3i(),
                "box", Schemas.object("min", Schemas.vec3i(), "max", Schemas.vec3i()),
                "size", Schemas.objectOpt(Schemas.object(
                    "w", Schemas.integer(), "h", Schemas.integer("Needed by the search door only."),
                    "d", Schemas.integer()), "h"),
                "template", Schemas.str("Structure template id whose size to use instead of `size` (search door)."),
                "y", Schemas.integer("Verdict door: target ground level for cut/fill; default modal ground height."),
                "radius", Schemas.integer("Search door: half-width in blocks around `near`. Default " + FIND_DEFAULT_RADIUS + "."),
                "stride", Schemas.integer("Search door: candidate-anchor grid step. Default " + FIND_DEFAULT_STRIDE + "; 1 = exhaustive."),
                "limit", Schemas.integer("Search door: candidates returned (fit-verified). Default " + FIND_DEFAULT_LIMIT + ", max " + FIND_MAX_LIMIT + "."),
                "clearance", Schemas.objectOpt(Schemas.object(
                    "above", Schemas.integer("Extra clear blocks required above the footprint."),
                    "margin", Schemas.integer("Extra clear ring required around the sides.")), "above", "margin"),
                "max_water_columns", Schemas.integer("Search door: reject candidates with more water/lava columns. Default 0."),
                "max_stddev", Schemas.number("Search door: reject candidates whose ground stddev exceeds this."),
                "profile", Schemas.object("w", Schemas.integer(), "h", Schemas.integer()),
                "dimension", Schemas.str("Dimension id, default minecraft:overworld."),
                "load", Schemas.bool("Pull absent chunks in so they can be read. Default true.")),
                "at", "near", "bounds", "from", "to", "box", "size", "template", "y", "radius", "stride", "limit",
                "clearance", "max_water_columns", "max_stddev", "profile", "dimension", "load"),
            ExecutionContext.SERVER,
            Mechanism.OBSERVE,
            (ctx, a) -> {
                ServerLevel level = WorldPerceptionTools.levelArg(ctx.serverOrThrow(), a);
                boolean hasAt = a.has("at") && a.get("at").isJsonObject();
                boolean hasSearch = (a.has("near") && a.get("near").isJsonObject())
                    || (a.has("bounds") && a.get("bounds").isJsonObject());
                boolean hasFrom = a.has("from") && a.get("from").isJsonObject();
                boolean hasBox = a.has("box") && a.get("box").isJsonObject();
                if ((hasAt ? 1 : 0) + (hasSearch ? 1 : 0) + (hasFrom ? 1 : 0) + (hasBox ? 1 : 0) != 1) {
                    throw new IllegalArgumentException("give exactly one door: `at` {x,z} "
                        + "(footprint verdict), `near` {x,z} / `bounds` {min_x,min_z,max_x,max_z} "
                        + "(site search), `from`+`to` (corridor) or `box` {min,max} (volume "
                        + "clearing count)");
                }
                if (hasAt) {
                    return checkSite(level, a);
                }
                if (hasSearch) {
                    return findSite(level, a);
                }
                if (hasBox) {
                    return checkBox(level, a);
                }
                return checkClearance(level, a);
            }));

        McpTools.register(ToolDef.of(
            "resolve_anchor",
            "Turn a spatial RELATION into coordinates: \"a w×h×d box on the north face of that "
                + "chest/wall/house, gap 2, base-aligned\" — the server does the subtraction, you "
                + "copy the result into set_blocks/place_shape/bot_place. State the box (`size` "
                + "{w,h,d} or structure `template`), the reference `to` (a point {x,y,z} or a box "
                + "{min,max}), a `face` (north|south|east|west|up|down — north is −z), optional "
                + "`gap` (blocks of space between, default 0) and `align` (min|center|max along "
                + "the free axes, default center; `align_y` for vertical alignment on horizontal "
                + "faces, default min = same base). `on_ground`:true instead drops the box so its "
                + "base sits on the modal ground height under its own footprint (heightmap, trees "
                + "excluded). Returns the resolved `box` {min,max,size} and `origin` (the min "
                + "corner — the base coordinate every placement tool takes), and by default "
                + "(`check`:true) also a real fit verdict over that volume (`fits`, "
                + "`clearance` honored) so resolve+verify is ONE call. fits is null over unread "
                + "space; reading never generates terrain. Use this instead of computing offsets "
                + "from coordinates yourself — model coordinate arithmetic is the documented "
                + "failure mode.",
            Schemas.objectOpt(Schemas.object(
                "size", Schemas.object("w", Schemas.integer(), "h", Schemas.integer(), "d", Schemas.integer()),
                "template", Schemas.str("Structure template id whose size to use instead of `size`."),
                "to", toRefSchema(),
                "face", Schemas.str("Which face of the reference the box goes on: north|south|east|west|up|down (north = -z)."),
                "gap", Schemas.integer("Clear blocks between reference and box. Default 0 (touching)."),
                "align", Schemas.str("Alignment along the free axes: min|center|max. Default center."),
                "align_y", Schemas.str("Vertical alignment for horizontal faces: min (same base, default)|center|max."),
                "on_ground", Schemas.bool("Drop the box onto the modal ground height under its footprint (overrides align_y)."),
                "check", Schemas.bool("Also run the fit check over the resolved volume. Default true."),
                "clearance", Schemas.objectOpt(Schemas.object(
                    "above", Schemas.integer("Extra clear blocks required above the box."),
                    "margin", Schemas.integer("Extra clear ring required around the sides.")), "above", "margin"),
                "dimension", Schemas.str("Dimension id, default minecraft:overworld."),
                "load", Schemas.bool("Pull absent chunks in so they can be read. Default true.")),
                "size", "template", "gap", "align", "align_y", "on_ground", "check", "clearance",
                "dimension", "load"),
            ExecutionContext.SERVER,
            Mechanism.OBSERVE,
            (ctx, a) -> resolveAnchor(WorldPerceptionTools.levelArg(ctx.serverOrThrow(), a), a)));
    }

    // ---- check_fit -----------------------------------------------------------

    private static JsonObject checkFit(final ServerLevel level, final JsonObject a) {
        BlockPos at = pos(a, "at");
        Vec3i size = fitSize(level, a);
        int above = 0;
        int margin = 0;
        if (a.has("clearance") && a.get("clearance").isJsonObject()) {
            JsonObject c = a.getAsJsonObject("clearance");
            above = optInt(c, "above", 0);
            margin = optInt(c, "margin", 0);
        }
        if (size.getX() < 1 || size.getY() < 1 || size.getZ() < 1 || above < 0 || margin < 0) {
            throw new IllegalArgumentException("size must be at least 1x1x1 and clearance non-negative");
        }
        // The checked volume is the footprint grown by the clearance shell: margin on all four
        // sides, `above` on top. One box, so the report needs no second coordinate system.
        BlockPos min = at.offset(-margin, 0, -margin);
        BlockPos max = at.offset(size.getX() - 1 + margin, size.getY() - 1 + above, size.getZ() - 1 + margin);
        long volume = (long) (max.getX() - min.getX() + 1) * (max.getY() - min.getY() + 1) * (max.getZ() - min.getZ() + 1);
        if (volume > MAX_VOLUME) {
            throw new IllegalArgumentException("too_large: " + volume + " cells including clearance "
                + "(cap " + MAX_VOLUME + " = 64x64x64) — a fit verdict over a truncated footprint "
                + "would be worthless, so shrink the request instead");
        }

        ChunkLoader loader = new ChunkLoader(level, loadArg(a));
        FitScan scan = fitScan(level, loader, min, max);

        JsonObject r = new JsonObject();
        // Verdict only over fully-read space: a conflict found in a partial read is still a real
        // conflict, but "fits" would be claiming the unread cells are clear.
        if (scan.unread > 0) {
            r.add("fits", null);
        } else {
            r.addProperty("fits", scan.conflictCount == 0);
        }
        r.add("conflicts", scan.conflicts);
        r.addProperty("conflict_count", scan.conflictCount);
        r.add("region", region(min, max));
        r.add("coverage", coverage(scan.read, scan.unread, (int) volume, false, loader));
        WorldPerceptionTools.addEnvelope(r, level, "spatial");
        return r;
    }

    /** Result of one air-or-replaceable sweep over an inclusive box. */
    private record FitScan(JsonArray conflicts, int conflictCount, int read, int unread) {}

    /**
     * The check_fit core, shared with find_site's verification stage and resolve_anchor's check:
     * every cell must be air or replaceable growth; conflicts listed up to {@link #MAX_CONFLICTS}.
     */
    private static FitScan fitScan(final ServerLevel level, final ChunkLoader loader,
                                   final BlockPos min, final BlockPos max) {
        JsonArray conflicts = new JsonArray();
        int conflictCount = 0;
        int read = 0;
        int unread = 0;
        BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
        for (int x = min.getX(); x <= max.getX(); x++) {
            for (int z = min.getZ(); z <= max.getZ(); z++) {
                // One residency test per column — every y shares the chunk.
                if (!loader.ensure(m.set(x, min.getY(), z))) {
                    unread += max.getY() - min.getY() + 1;
                    continue;
                }
                for (int y = min.getY(); y <= max.getY(); y++) {
                    read++;
                    BlockState state = level.getBlockState(m.set(x, y, z));
                    if (state.isAir() || state.canBeReplaced()) {
                        continue;
                    }
                    conflictCount++;
                    if (conflicts.size() < MAX_CONFLICTS) {
                        JsonObject c = new JsonObject();
                        c.addProperty("x", x);
                        c.addProperty("y", y);
                        c.addProperty("z", z);
                        c.addProperty("block", BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString());
                        conflicts.add(c);
                    }
                }
            }
        }
        return new FitScan(conflicts, conflictCount, read, unread);
    }

    /** The footprint size: explicit {@code size}, or the named structure template's. */
    private static Vec3i fitSize(final ServerLevel level, final JsonObject a) {
        boolean hasSize = a.has("size") && a.get("size").isJsonObject();
        boolean hasTemplate = a.has("template") && !a.get("template").isJsonNull();
        if (hasSize == hasTemplate) {
            throw new IllegalArgumentException("give exactly one of `size` or `template`");
        }
        if (hasSize) {
            JsonObject s = a.getAsJsonObject("size");
            return new Vec3i(reqInt(s, "w"), reqInt(s, "h"), reqInt(s, "d"));
        }
        Identifier id = Identifier.parse(a.get("template").getAsString());
        // The template STORE (structure files) — world-placed structure starts are a different API.
        Optional<StructureTemplate> template = level.getStructureManager().get(id);
        if (template.isEmpty()) {
            throw new IllegalArgumentException("no structure template '" + id + "'");
        }
        return template.get().getSize();
    }

    // ---- check_clearance -----------------------------------------------------

    private static JsonObject checkClearance(final ServerLevel level, final JsonObject a) {
        BlockPos from = pos(a, "from");
        BlockPos to = pos(a, "to");
        int w = 1;
        int h = 2;
        if (a.has("profile") && a.get("profile").isJsonObject()) {
            JsonObject p = a.getAsJsonObject("profile");
            w = optInt(p, "w", 1);
            h = optInt(p, "h", 2);
        }
        if (w < 1 || h < 1) {
            throw new IllegalArgumentException("profile must be at least 1x1");
        }
        Vec3 a0 = Vec3.atCenterOf(from);
        Vec3 b0 = Vec3.atCenterOf(to);
        double length = a0.distanceTo(b0);
        if (length > MAX_CORRIDOR) {
            throw new IllegalArgumentException("too_long: corridor is " + Math.round(length)
                + " blocks (cap " + (int) MAX_CORRIDOR + ") — check it in segments");
        }

        // Swept cells: walk the segment at quarter-block steps collecting each base voxel once (a
        // step below the voxel diagonal, so the walk cannot tunnel through a corner), then stamp
        // the w×w×h profile on each. The profile is w in BOTH horizontal axes on purpose — a body
        // of width w needs that regardless of travel direction, and it keeps the corridor
        // orientation-free.
        ChunkLoader loader = new ChunkLoader(level, loadArg(a));
        java.util.LinkedHashSet<Long> line = new java.util.LinkedHashSet<>();
        int steps = Math.max(1, (int) Math.ceil(length * 4.0));
        for (int i = 0; i <= steps; i++) {
            Vec3 p = a0.lerp(b0, (double) i / steps);
            line.add(BlockPos.asLong((int) Math.floor(p.x), (int) Math.floor(p.y), (int) Math.floor(p.z)));
        }
        int lo = -((w - 1) / 2);
        int hi = w / 2;
        long profileCells = (long) w * w * h;
        long volume = line.size() * profileCells;
        if (volume > MAX_VOLUME) {
            throw new IllegalArgumentException("too_large: corridor sweeps " + volume + " cells "
                + "(cap " + MAX_VOLUME + ") — shrink the profile or check in segments");
        }

        java.util.HashSet<Long> seen = new java.util.HashSet<>();
        JsonObject firstObstruction = null;
        int obstructed = 0;
        int read = 0;
        int unread = 0;
        BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
        for (long key : line) {
            BlockPos base = BlockPos.of(key);
            for (int dx = lo; dx <= hi; dx++) {
                for (int dz = lo; dz <= hi; dz++) {
                    for (int dy = 0; dy < h; dy++) {
                        m.set(base.getX() + dx, base.getY() + dy, base.getZ() + dz);
                        if (!seen.add(m.asLong())) {
                            continue;
                        }
                        if (!loader.ensure(m)) {
                            unread++;
                            continue;
                        }
                        read++;
                        BlockState state = level.getBlockState(m);
                        if (state.isAir() || state.canBeReplaced()) {
                            continue;
                        }
                        obstructed++;
                        if (firstObstruction == null) {
                            firstObstruction = new JsonObject();
                            firstObstruction.addProperty("x", m.getX());
                            firstObstruction.addProperty("y", m.getY());
                            firstObstruction.addProperty("z", m.getZ());
                            firstObstruction.addProperty("block",
                                BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString());
                        }
                    }
                }
            }
        }

        JsonObject r = new JsonObject();
        if (unread > 0) {
            r.add("clear", null);
        } else {
            r.addProperty("clear", obstructed == 0);
        }
        if (firstObstruction != null) {
            r.add("first_obstruction", firstObstruction);
        }
        r.addProperty("obstruction_count", obstructed);
        r.addProperty("length", Math.round(length * 10.0) / 10.0);
        r.add("coverage", coverage(read, unread, read + unread, false, loader));
        WorldPerceptionTools.addEnvelope(r, level, "spatial");
        return r;
    }

    // ---- check_path ----------------------------------------------------------

    /**
     * The Village Jobs {@code check_path} mechanism, promoted and generalized — and since the body
     * architecture (BOT_SURFACE_DESIGN.md §11.6), <b>entity-free for the walker</b>: a
     * {@link com.mattmc.mcptoolkit.nav.SyntheticPhysique} with the walker body's exact shape solves
     * through the same {@link NavSolver} stack execution uses, so prediction models the body that
     * will actually walk (sprint-jump edges included) with nothing spawned or discarded. Only the
     * {@code flyer} check still spawns a throwaway drone — flight is a different evaluator, owned by
     * the drone's own navigation.
     */
    private static JsonObject checkPath(final ServerLevel level, final JsonObject a,
                                        final @Nullable LivingEntity self,
                                        final java.util.function.@Nullable LongPredicate seen) {
        BlockPos from = fromArg(a, self);
        boolean reachMode = a.has("reach") && !a.get("reach").isJsonNull();
        if (reachMode && a.has("to") && !a.get("to").isJsonNull()) {
            throw new IllegalArgumentException("give `to` (arrive at a point) OR `reach` (get in "
                + "touching range of a block), not both");
        }
        BlockPos to = pos(a, reachMode ? "reach" : "to");
        String body = a.has("body") && !a.get("body").isJsonNull() ? a.get("body").getAsString() : "walker";
        if (!body.equals("walker") && !body.equals("flyer")) {
            throw new IllegalArgumentException("unknown body '" + body + "' (walker | flyer)");
        }
        // CHECK_PATH_AUDIT.md R2: with a seen-set, the solve runs over HELD KNOWLEDGE only. The
        // flyer path solves through a live drone's vanilla navigation, which cannot be masked —
        // and the profile that carries a mask has no drone anyway.
        boolean masked = seen != null;
        if (masked && !body.equals("walker")) {
            throw new IllegalArgumentException(
                "flyer prediction is not available in this profile (no drone body)");
        }

        // Residency along the straight line first: the A* explores AROUND this line, but if the
        // line itself crosses unreadable chunks the search would be walled off by absent terrain
        // and report a confident false "unreachable" — the exact false-negative class the coverage
        // contract exists for. (Chunks the search wanders through beyond the line may still be
        // absent; the line is the honest cheap bound, not a guarantee.)
        ChunkLoader loader = new ChunkLoader(level, loadArg(a));
        int[] visited = new int[2]; // columns visited / columns readable
        double t = walkChunks(Vec3.atCenterOf(from), Vec3.atCenterOf(to), (cx, cz) -> {
            visited[0]++;
            boolean ok = loader.ensure(new BlockPos(cx << 4, from.getY(), cz << 4));
            if (ok) {
                visited[1]++;
            }
            return ok;
        });

        JsonObject r = new JsonObject();
        // Echo the start, and say when it was DEFAULTED. A silent default that happens to be right
        // reads exactly like agreement with an argument the caller never sent — the `center_from`
        // lesson from locate, which is the same tool-shaped honesty problem.
        JsonObject fromEcho = new JsonObject();
        fromEcho.addProperty("x", from.getX());
        fromEcho.addProperty("y", from.getY());
        fromEcho.addProperty("z", from.getZ());
        r.add("from", fromEcho);
        if (!(a.has("from") && a.get("from").isJsonObject())) {
            r.addProperty("from_from", "body");
        }
        if (t < 1.0) {
            r.add("reachable", null);
            r.add("coverage", coverage(visited[1], visited[0] - visited[1], visited[0], false, loader));
            WorldPerceptionTools.addEnvelope(r, level, "spatial");
            return r;
        }

        boolean walkerBody = body.equals("walker");
        NavProfile navProfile = NavProfile.fromJson(a);
        // Masked mode, the cheapest honest check first: a target the session has never observed
        // gets no verdict at all — not even "the search failed" is derivable from knowledge about
        // a cell you have not looked at. The frontier IS the target: go look at it.
        if (masked && !seen.test(to.asLong())) {
            r.add("reachable", null);
            JsonObject kf = new JsonObject();
            kf.addProperty("x", to.getX());
            kf.addProperty("y", to.getY());
            kf.addProperty("z", to.getZ());
            r.add("knowledge_frontier", kf);
            r.addProperty("note", "the target itself has never been observed by this session — "
                + "go look at it (scan toward it, or a vantage goal), then re-check");
            r.add("coverage", coverage(visited[1], 0, visited[0], false, loader));
            WorldPerceptionTools.addEnvelope(r, level, "spatial");
            return r;
        }
        // The walker check is ENTITY-FREE: a synthetic physique in the walker's exact shape, solved
        // through the same stack the real walker executes with. The flyer still needs its throwaway
        // drone (FlyNodeEvaluator is a different solver, owned by the drone's navigation). A masked
        // solve runs cache-less: the shared PathTypeCache holds real-world verdicts (see
        // SyntheticPhysique.walkerUncached).
        com.mattmc.mcptoolkit.nav.SyntheticPhysique physique = walkerBody
            ? masked
                ? com.mattmc.mcptoolkit.nav.SyntheticPhysique.walkerUncached(from, navProfile.canOpenDoors())
                : com.mattmc.mcptoolkit.nav.SyntheticPhysique.walker(level, from, navProfile.canOpenDoors())
            : null;
        Mob probe = null;
        if (!walkerBody) {
            probe = com.mattmc.mcptoolkit.drone.DroneEntities.DRONE.spawn(level, from, EntitySpawnReason.MOB_SUMMONED);
            if (probe == null) {
                throw new IllegalStateException("could not spawn a test " + body + " at " + from.toShortString());
            }
            // A mob spawned this tick hasn't fallen yet, so onGround is false — and
            // PathNavigation.createPath early-returns null unless canUpdatePath() holds.
            // Force it so the pathfinder actually runs; the A* itself keys off blockPosition.
            probe.setOnGround(true);
        }
        try {
            r.addProperty("body", body);

            // Goal resolution. `to` is the single-point goal; `reach` resolves to the touch shell —
            // the set of cells from which this probe's eye could touch the block — and the whole
            // set goes to the pathfinder (vanilla A* takes multi-target sets natively; its
            // per-mode NodeEvaluator decides which members are occupiable, so the shell needs no
            // standability filtering here). Reach dead-ends short-circuit the search: an enclosed
            // block is `occluded` (false — no amount of pathing helps), an unreadable shell is
            // null, both cheaper AND more diagnostic than a doomed A*.
            java.util.Set<BlockPos> targets;
            if (reachMode) {
                float eyeHeight = walkerBody ? physique.eyeHeight() : probe.getEyeHeight();
                ReachSolver.Result reach = ReachSolver.solve(level, to, eyeHeight, loader);
                JsonObject rj = new JsonObject();
                rj.addProperty("candidates", reach.candidates());
                rj.addProperty("visible", reach.visible());
                rj.addProperty("unreadable", reach.unreadable());
                r.add("reach", rj);
                if (reach.visible() == 0) {
                    if (reach.unreadable() > 0) {
                        r.add("reachable", null);
                        r.addProperty("note", reach.unreadable() + " cell(s) of the touch shell "
                            + "were unreadable — a touchable position may exist there; retry with "
                            + "load:true or after forceload");
                    } else {
                        r.addProperty("reachable", false);
                        r.addProperty("reason", "occluded");
                        r.addProperty("note", "no position within hand reach has line of sight to "
                            + "the block — it is enclosed; expose a face first (pathing cannot fix "
                            + "this)");
                    }
                    r.add("coverage", coverage(visited[1], 0, visited[0], false, loader));
                    WorldPerceptionTools.addEnvelope(r, level, "spatial");
                    return r;
                }
                targets = reach.stands();
            } else {
                targets = java.util.Set.of(to);
            }

            // Escalation search with a tri-state verdict. A budget-truncated search used to answer
            // a confident reachable:false on any detour longer than straight-line+16 (testbench t4
            // caught the with-arm trusting exactly that). The honest contract: TRUE when a search
            // reaches; FALSE only when the search frontier stops growing under a 4x larger budget
            // (reachable set exhausted — a sealed pen still reads false); NULL when the ceiling
            // cuts a still-growing search, with max_length named as the remedy.
            double distance = Math.sqrt(to.distSqr(from));
            float start = (float) distance + 16.0F;
            // The ceiling is clamped: the solve runs on the server thread and its region read +
            // visited-node budget scale with the ceiling, so an unbounded caller value could stall
            // the tick. 512 is far beyond any repair-scale route; longer journeys should be staged.
            float ceiling = Math.min(512.0F,
                a.has("max_length") && !a.get("max_length").isJsonNull()
                    ? a.get("max_length").getAsFloat()
                    : Math.max(256.0F, start * 4.0F));
            float budget = Math.min(start, ceiling);
            // Build-assisted routing is a WALKER capability: a flyer has no gap to bridge, and its
            // FlyNodeEvaluator is a different solver. Every walker solve runs our stack now (that is
            // what the walker body executes with), so even a profile-less check sees sprint-jump
            // edges — the plan below discloses them; break/place/door edges still require opt-in.
            boolean buildAware = walkerBody
                && (navProfile.modifiesWorld() || navProfile.canOpenDoors());
            com.mattmc.mcptoolkit.nav.BuildWalkNodeEvaluator planner = null;
            NavSolver.Result solvedResult = null;
            Path path;
            Path prev = null;
            boolean reached;
            boolean stabilized = false;
            // Masked mode: every unknown cell any solve iteration consulted, pooled — the final
            // verdict needs "did the search run out of knowledge", not per-iteration bookkeeping.
            it.unimi.dsi.fastutil.longs.LongSet touchedUnknown = masked
                ? new it.unimi.dsi.fastutil.longs.LongOpenHashSet() : null;
            while (true) {
                if (walkerBody) {
                    NavSolver.Result solved = masked
                        ? NavSolver.solveMasked(level, physique, targets, budget, navProfile,
                            seen, touchedUnknown)
                        : NavSolver.solve(level, physique, targets, budget, navProfile);
                    solvedResult = solved;
                    path = solved.path();
                    planner = solved.evaluator();
                } else {
                    probe.getNavigation().setRequiredPathLength(budget);
                    path = probe.getNavigation().createPath(targets, 0);
                }
                reached = path != null && path.canReach();
                if (reached) {
                    break;
                }
                if (prev != null && samePartialResult(prev, path)) {
                    stabilized = true;
                    break;
                }
                if (budget >= ceiling) {
                    break;
                }
                prev = path;
                budget = Math.min(budget * 4.0F, ceiling);
            }
            // Budget parity with execution: a route whose committed plan needs more break/place
            // work than the budget allows is NOT reachable under this profile — execution would
            // stop with break/place_budget_spent partway, so prediction must not promise arrival.
            String overBudget = reached && solvedResult != null ? solvedResult.overBudget() : null;
            if (reached && overBudget != null) {
                r.addProperty("reachable", false);
                r.addProperty("reason", overBudget);
                r.addProperty("note", "a route EXISTS but its cheapest plan needs more "
                    + (overBudget.startsWith("break") ? "breaking" : "bridging")
                    + " than the budget allows (see `work` vs `profile`) — raise budget."
                    + (overBudget.startsWith("break") ? "break" : "place")
                    + ", or treat the target as unreachable under this profile");
            } else if (reached) {
                r.addProperty("reachable", true);
                if (reachMode) {
                    // The satisfied stand — by construction a cell the body can occupy AND touch
                    // the block from. This is the bot_goto target a planner needs next.
                    BlockPos stand = path.getTarget();
                    JsonObject s = new JsonObject();
                    s.addProperty("x", stand.getX());
                    s.addProperty("y", stand.getY());
                    s.addProperty("z", stand.getZ());
                    r.add("stand", s);
                }
            } else if (masked && !touchedUnknown.isEmpty()) {
                // The search consulted terrain this session never observed. That is not "no route"
                // — it is "no route WITHIN YOUR KNOWLEDGE": the honest verdict is null, and the
                // remedy is a look, not a dig. This is `ask path_to` from DESIGN.md §16.3, and the
                // frontier converts the old blind-navigation objection into an explore hint.
                r.add("reachable", null);
                BlockPos frontier = NavSolver.knowledgeFrontier(touchedUnknown, to);
                if (frontier != null) {
                    JsonObject kf = new JsonObject();
                    kf.addProperty("x", frontier.getX());
                    kf.addProperty("y", frontier.getY());
                    kf.addProperty("z", frontier.getZ());
                    r.add("knowledge_frontier", kf);
                }
                r.addProperty("note", "the search ran out of OBSERVED terrain before reaching the "
                    + "target — your knowledge ends at knowledge_frontier; go look (scan toward "
                    + "it, or a vantage goal), then re-check");
            } else if (stabilized) {
                r.addProperty("reachable", false);
                if (reachMode) {
                    r.addProperty("reason", "no_path_to_reach_position");
                    r.addProperty("note", "touchable positions exist (" + targets.size()
                        + " with line of sight) but this body cannot get to any of them");
                } else if (masked) {
                    r.addProperty("note", "sealed within KNOWN terrain: the search exhausted every "
                        + "reachable observed cell without touching unknown ones — no amount of "
                        + "looking changes this verdict from here");
                }
            } else {
                r.add("reachable", null);
                r.addProperty("note", "search hit its budget (" + (int) ceiling
                    + ") while still expanding — raise max_length to confirm reachability either way");
            }
            r.addProperty("partial", path != null && !path.canReach());
            r.addProperty("nodes", path == null ? 0 : path.getNodeCount());
            JsonObject search = new JsonObject();
            search.addProperty("budget_used", (int) budget);
            search.addProperty("ceiling", (int) ceiling);
            search.addProperty("stabilized", stabilized);
            r.add("search", search);
            if (path != null && path.getEndNode() != null) {
                BlockPos end = path.getEndNode().asBlockPos();
                JsonObject e = new JsonObject();
                e.addProperty("x", end.getX());
                e.addProperty("y", end.getY());
                e.addProperty("z", end.getZ());
                r.add("end", e);
                // WHICH block stopped it, not just where it stopped — the difference between a
                // verdict the agent must survey and one it can act on (BOT_SURFACE_DESIGN.md §2.1).
                // Masked mode disclosures obey the mask: obstruction() reads the REAL level, so a
                // blocking cell the session never saw stays undisclosed — the frontier verdict
                // above already told it where to look. (Residual: a SEEN iron door's control search
                // may name a nearby control cell; bounded to a 7-cell box around a seen block.)
                if (!reached) {
                    JsonObject blocker = NavSolver.obstruction(level, end, to, navProfile);
                    if (blocker != null && (!masked || seen.test(BlockPos.asLong(
                            blocker.get("x").getAsInt(), blocker.get("y").getAsInt(),
                            blocker.get("z").getAsInt())))) {
                        r.add("obstruction", blocker);
                    }
                }
            }
            if (buildAware) {
                r.add("profile", navProfile.describe());
            }
            // Disclose planned work whenever the search assumed any — under a plain profile that can
            // only be jumps (sprint-jump edges are a movement capability, on for every walker solve).
            if (planner != null && !planner.plan().isEmpty()) {
                // The path is NOT a plain walk — disclose the work it assumes, and that the
                // assumption is optimistic (materials/breaks verified for real only at execution).
                JsonObject work = new JsonObject();
                int breaks = 0;
                int places = 0;
                int jumps = 0;
                int doors = 0;
                for (var entry : planner.plan().values()) {
                    switch (entry) {
                        case PLACE, PILLAR -> places++; // a pillar-up is a placed block, vertically
                        case BREAK -> breaks++;
                        case JUMP -> jumps++;
                        case OPEN_DOOR -> doors++;
                    }
                }
                work.addProperty("break_cells", breaks);
                work.addProperty("place_cells", places);
                work.addProperty("jumps", jumps);          // gaps crossed by a running jump — no blocks
                work.addProperty("doors", doors);
                work.addProperty("note", "this route is not a plain walk — jumps are free gap "
                    + "crossings; break/place counts are the CHOSEN route's plan (committed to the "
                    + "returned path, not the explored frontier), still optimistic: the body "
                    + "verifies materials and breakability for real as it goes and reports what it "
                    + "actually did");
                r.add("work", work);
            }
        } finally {
            if (probe != null) {
                probe.discard(); // flyer only — the walker check spawned nothing
            }
        }
        r.add("coverage", coverage(visited[1], 0, visited[0], false, loader));
        WorldPerceptionTools.addEnvelope(r, level, "spatial");
        return r;
    }

    /**
     * Two partial searches with the same node count and end position: raising the budget did not
     * grow the frontier, so the pathfinder has exhausted what is reachable from {@code from}.
     * Both-null counts too (the pathfinder could not even start — blocked origin, say).
     */
    private static boolean samePartialResult(Path prev, Path next) {
        if (prev == null && next == null) {
            return true;
        }
        if (prev == null || next == null) {
            return false;
        }
        if (prev.getNodeCount() != next.getNodeCount()) {
            return false;
        }
        if (prev.getEndNode() == null || next.getEndNode() == null) {
            return prev.getEndNode() == next.getEndNode();
        }
        return prev.getEndNode().asBlockPos().equals(next.getEndNode().asBlockPos());
    }

    // ---- check_site ----------------------------------------------------------

    private static JsonObject checkSite(final ServerLevel level, final JsonObject a) {
        JsonObject atArg = a.getAsJsonObject("at");
        if (atArg == null) {
            throw new IllegalArgumentException("missing position 'at'");
        }
        int ax = reqInt(atArg, "x");
        int az = reqInt(atArg, "z");
        JsonObject sizeArg = a.getAsJsonObject("size");
        if (sizeArg == null) {
            throw new IllegalArgumentException("missing 'size'");
        }
        int w = reqInt(sizeArg, "w");
        int d = reqInt(sizeArg, "d");
        if (w < 1 || d < 1) {
            throw new IllegalArgumentException("size must be at least 1x1");
        }
        if ((long) w * d > MAX_SITE_COLUMNS) {
            throw new IllegalArgumentException("too_large: " + ((long) w * d) + " columns (cap "
                + MAX_SITE_COLUMNS + " = 64x64) — sample a smaller footprint");
        }

        ChunkLoader loader = new ChunkLoader(level, loadArg(a));
        java.util.ArrayList<Integer> heights = new java.util.ArrayList<>(w * d);
        java.util.HashMap<String, Integer> surface = new java.util.HashMap<>();
        java.util.HashMap<Integer, Integer> heightCounts = new java.util.HashMap<>();
        int water = 0;
        int lava = 0;
        int unread = 0;
        BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
        for (int x = ax; x < ax + w; x++) {
            for (int z = az; z < az + d; z++) {
                if (!loader.ensure(m.set(x, 0, z))) {
                    unread++;
                    continue;
                }
                // The Roads.java pattern: heightmap value is the first air ABOVE the top blocking
                // block, so the ground itself sits one below.
                int groundY = level.getHeight(Heightmap.Types.MOTION_BLOCKING_NO_LEAVES, x, z) - 1;
                heights.add(groundY);
                heightCounts.merge(groundY, 1, Integer::sum);
                BlockState top = level.getBlockState(m.set(x, groundY, z));
                surface.merge(BuiltInRegistries.BLOCK.getKey(top.getBlock()).toString(), 1, Integer::sum);
                if (top.getFluidState().is(FluidTags.WATER)) {
                    water++;
                } else if (top.getFluidState().is(FluidTags.LAVA)) {
                    lava++;
                }
            }
        }

        JsonObject r = new JsonObject();
        // Echo the box actually read (M1a, 2026-07-26): `at` is a MIN corner, and both arms of a
        // bench run once passed the centre — the shifted extent was invisible because the reply
        // never said which columns it covered. Now it does, so the mistake is self-checkable.
        JsonObject region = new JsonObject();
        region.addProperty("min_x", ax);
        region.addProperty("min_z", az);
        region.addProperty("max_x", ax + w - 1);
        region.addProperty("max_z", az + d - 1);
        r.add("region", region);
        // The search-door breadcrumb (M4): hand-looping this verdict door over many anchors is
        // the observed slow path; the door that ranks anchors automatically is one argument away.
        r.addProperty("search_hint", "comparing many anchors? `near`+`size` ranks them "
            + "automatically; `bounds` {min_x,min_z,max_x,max_z} searches an exact area");
        int read = heights.size();
        if (read > 0) {
            JsonObject ground = ReadSupport.groundStats(heights);
            int targetY = a.has("y") && !a.get("y").isJsonNull()
                ? a.get("y").getAsInt()
                : heightCounts.entrySet().stream()
                    .max(java.util.Map.Entry.comparingByValue()).orElseThrow().getKey();
            long cut = 0;
            long fill = 0;
            for (int y : heights) {
                if (y > targetY) {
                    cut += y - targetY;
                } else {
                    fill += targetY - y;
                }
            }

            r.add("ground_y", ground);
            r.addProperty("target_y", targetY);
            r.addProperty("cut", cut);
            r.addProperty("fill", fill);
            // A hint over partial coverage would smuggle a verdict about unread ground.
            if (unread == 0) {
                r.addProperty("flat_enough_hint", ground.get("stddev").getAsDouble() <= FLAT_STDDEV);
            } else {
                r.add("flat_enough_hint", null);
            }
            r.add("surface", ReadSupport.histogram(surface, 8));
            JsonObject fluids = new JsonObject();
            fluids.addProperty("water_columns", water);
            fluids.addProperty("lava_columns", lava);
            r.add("fluids", fluids);
        }
        r.add("coverage", coverage(read, unread, w * d, false, loader));
        WorldPerceptionTools.addEnvelope(r, level, "spatial");
        return r;
    }

    // ---- find_site -----------------------------------------------------------

    /**
     * The BOX door (0.25.0, from the t3 gap): cut-only work over an explicit volume — "how many
     * cells must be removed to clear this box", the same predicate as the corridor door with the
     * fourth extent geometry. One call replaces the 4-batch cell enumeration whose model-side
     * summing produced reproducible off-by-ones.
     *
     * <p>TRIPWIRE (design boundary, SURFACE_MERGE_DESIGN.md): this door sits on the COST side of
     * the contents-vs-cost line. If a material-histogram / palette door is ever proposed here,
     * that is describe_box's question ("what is in it") and the merge becomes the mode-flag tool
     * the collapse rule forbids. Work doors count and locate conflicts; they never describe.
     */
    private static JsonObject checkBox(final ServerLevel level, final JsonObject a) {
        JsonObject boxArg = a.getAsJsonObject("box");
        BlockPos min = pos(boxArg, "min");
        BlockPos max = pos(boxArg, "max");
        if (max.getX() < min.getX() || max.getY() < min.getY() || max.getZ() < min.getZ()) {
            throw new IllegalArgumentException("box.max must be >= box.min on every axis");
        }
        long volume = (long) (max.getX() - min.getX() + 1) * (max.getY() - min.getY() + 1)
            * (max.getZ() - min.getZ() + 1);
        if (volume > MAX_VOLUME) {
            throw new IllegalArgumentException("too_large: " + volume + " cells (cap " + MAX_VOLUME
                + " = 64x64x64) — a count over a truncated box would be worthless, so shrink it");
        }
        ChunkLoader loader = new ChunkLoader(level, loadArg(a));
        FitScan scan = fitScan(level, loader, min, max);

        JsonObject r = new JsonObject();
        JsonObject region = new JsonObject();
        region.addProperty("min", min.getX() + "," + min.getY() + "," + min.getZ());
        region.addProperty("max", max.getX() + "," + max.getY() + "," + max.getZ());
        r.add("region", region);
        // Verdict + count only over fully-read space: a partial count sold as exact is the
        // confident-falsehood class; conflicts already found stay listed either way.
        if (scan.unread() > 0) {
            r.add("clear", null);
            r.add("obstruction_count", null);
            r.addProperty("obstruction_count_lower_bound", scan.conflictCount());
        } else {
            r.addProperty("clear", scan.conflictCount() == 0);
            r.addProperty("obstruction_count", scan.conflictCount());
        }
        r.add("obstructions", scan.conflicts());
        r.add("coverage", coverage(scan.read(), scan.unread(), (int) volume, false, loader));
        WorldPerceptionTools.addEnvelope(r, level, "spatial");
        return r;
    }

    /** A scored candidate anchor: min-corner footprint at (x, targetY+1, z). */
    private record Candidate(int x, int z, int targetY, long cut, long fill, double stddev,
                             int water, double dist) {}

    private static JsonObject findSite(final ServerLevel level, final JsonObject a) {
        JsonObject nearArg = a.has("near") && a.get("near").isJsonObject()
            ? a.getAsJsonObject("near") : null;
        JsonObject boundsArg = a.has("bounds") && a.get("bounds").isJsonObject()
            ? a.getAsJsonObject("bounds") : null;
        if (nearArg == null && boundsArg == null) {
            throw new IllegalArgumentException("give `near` {x,z} (+`radius`) or `bounds` "
                + "{min_x,min_z,max_x,max_z} for an exact anchor rectangle");
        }
        Vec3i size = fitSize(level, a);
        int w = size.getX();
        int h = size.getY();
        int d = size.getZ();
        int stride = optInt(a, "stride", FIND_DEFAULT_STRIDE);
        int limit = optInt(a, "limit", FIND_DEFAULT_LIMIT);
        int maxWater = optInt(a, "max_water_columns", 0);
        Double maxStddev = a.has("max_stddev") && !a.get("max_stddev").isJsonNull()
            ? a.get("max_stddev").getAsDouble() : null;
        // Anchor domain (M1b, 2026-07-26): a radius answers "near here"; `bounds` answers the
        // question tasks actually state — "within THIS rectangle" — as min-corner anchor
        // positions, inclusive. The failure it closes: a radius search overshooting the stated
        // domain onto trivially-flat ground and returning honest answers to the wrong question.
        int minX;
        int minZ;
        int anchorSpanX;
        int anchorSpanZ;
        double refX;
        double refZ;
        if (boundsArg != null) {
            int bMinX = reqInt(boundsArg, "min_x");
            int bMinZ = reqInt(boundsArg, "min_z");
            int bMaxX = reqInt(boundsArg, "max_x");
            int bMaxZ = reqInt(boundsArg, "max_z");
            if (bMaxX < bMinX || bMaxZ < bMinZ) {
                throw new IllegalArgumentException("bounds max must be >= min");
            }
            minX = bMinX;
            minZ = bMinZ;
            anchorSpanX = bMaxX - bMinX + 1;
            anchorSpanZ = bMaxZ - bMinZ + 1;
            refX = (bMinX + bMaxX) / 2.0;
            refZ = (bMinZ + bMaxZ) / 2.0;
        } else {
            int nx = reqInt(nearArg, "x");
            int nz = reqInt(nearArg, "z");
            int radius = optInt(a, "radius", FIND_DEFAULT_RADIUS);
            if (radius < 1) {
                throw new IllegalArgumentException("radius must be at least 1");
            }
            minX = nx - radius;
            minZ = nz - radius;
            anchorSpanX = 2 * radius + 1;
            anchorSpanZ = 2 * radius + 1;
            refX = nx;
            refZ = nz;
        }
        if (w < 1 || h < 1 || d < 1 || stride < 1 || limit < 1) {
            throw new IllegalArgumentException("size, stride and limit must be at least 1");
        }
        limit = Math.min(limit, FIND_MAX_LIMIT);
        // Columns the scan touches: the anchor span, plus windows extending w−1 / d−1 beyond.
        int countX = anchorSpanX + w - 1;
        int countZ = anchorSpanZ + d - 1;
        long totalCols = (long) countX * countZ;
        if (totalCols > MAX_SEARCH_COLUMNS) {
            throw new IllegalArgumentException("too_large: the scan covers " + totalCols
                + " columns (cap " + MAX_SEARCH_COLUMNS + " = 128x128) — shrink the area or the "
                + "footprint");
        }

        // Column precompute: one heightmap + top-block read each. Trees are excluded from
        // "ground", so trunks/canopies surface as cut volume, not as ground height.
        ChunkLoader loader = new ChunkLoader(level, loadArg(a));
        int[][] ground = new int[countX][countZ];
        byte[][] colState = new byte[countX][countZ]; // 0 unread, 1 dry, 2 water/lava
        int readCols = 0;
        int unreadCols = 0;
        BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
        for (int ix = 0; ix < countX; ix++) {
            for (int iz = 0; iz < countZ; iz++) {
                int x = minX + ix;
                int z = minZ + iz;
                if (!loader.ensure(m.set(x, 0, z))) {
                    unreadCols++;
                    continue;
                }
                readCols++;
                int gy = level.getHeight(Heightmap.Types.MOTION_BLOCKING_NO_LEAVES, x, z) - 1;
                ground[ix][iz] = gy;
                BlockState top = level.getBlockState(m.set(x, gy, z));
                boolean wet = top.getFluidState().is(FluidTags.WATER)
                    || top.getFluidState().is(FluidTags.LAVA);
                colState[ix][iz] = (byte) (wet ? 2 : 1);
            }
        }

        // Candidate sweep: window stats per stride anchor; filters count their kills so an empty
        // result names what was binding instead of reading as "no terrain exists".
        java.util.ArrayList<Candidate> candidates = new java.util.ArrayList<>();
        int evaluated = 0;
        int rejUnread = 0;
        int rejWater = 0;
        int rejSteep = 0;
        java.util.HashMap<Integer, Integer> mode = new java.util.HashMap<>();
        for (int ax = 0; ax + w <= countX; ax += stride) {
            for (int az = 0; az + d <= countZ; az += stride) {
                evaluated++;
                mode.clear();
                long sum = 0;
                long sumSq = 0;
                int water = 0;
                boolean unread = false;
                for (int ix = ax; ix < ax + w && !unread; ix++) {
                    for (int iz = az; iz < az + d; iz++) {
                        byte st = colState[ix][iz];
                        if (st == 0) {
                            unread = true;
                            break;
                        }
                        if (st == 2) {
                            water++;
                        }
                        int gy = ground[ix][iz];
                        sum += gy;
                        sumSq += (long) gy * gy;
                        mode.merge(gy, 1, Integer::sum);
                    }
                }
                if (unread) {
                    rejUnread++;
                    continue;
                }
                if (water > maxWater) {
                    rejWater++;
                    continue;
                }
                int n = w * d;
                double mean = (double) sum / n;
                double stddev = Math.sqrt(Math.max(0, (double) sumSq / n - mean * mean));
                if (maxStddev != null && stddev > maxStddev) {
                    rejSteep++;
                    continue;
                }
                int targetY = mode.entrySet().stream()
                    .max(java.util.Map.Entry.comparingByValue()).orElseThrow().getKey();
                long cut = 0;
                long fill = 0;
                for (int ix = ax; ix < ax + w; ix++) {
                    for (int iz = az; iz < az + d; iz++) {
                        int gy = ground[ix][iz];
                        if (gy > targetY) {
                            cut += gy - targetY;
                        } else {
                            fill += targetY - gy;
                        }
                    }
                }
                double cxc = minX + ax + (w - 1) / 2.0;
                double czc = minZ + az + (d - 1) / 2.0;
                double dist = Math.hypot(cxc - refX, czc - refZ);
                candidates.add(new Candidate(minX + ax, minZ + az, targetY, cut, fill, stddev,
                    water, dist));
            }
        }
        candidates.sort(java.util.Comparator
            .comparingLong((Candidate c) -> c.cut + c.fill)
            .thenComparingDouble(c -> c.dist));

        // Verification stage — escalation inside the tool: the cheap column proxy ranks ALL
        // candidates, the full volume fit check runs only on the returned top-k.
        int above = 0;
        int margin = 0;
        if (a.has("clearance") && a.get("clearance").isJsonObject()) {
            JsonObject c = a.getAsJsonObject("clearance");
            above = optInt(c, "above", 0);
            margin = optInt(c, "margin", 0);
        }
        JsonArray out = new JsonArray();
        for (int i = 0; i < candidates.size() && i < limit; i++) {
            Candidate c = candidates.get(i);
            JsonObject o = new JsonObject();
            JsonObject pos = new JsonObject();
            pos.addProperty("x", c.x);
            pos.addProperty("y", c.targetY + 1);
            pos.addProperty("z", c.z);
            o.add("pos", pos);
            o.addProperty("cut", c.cut);
            o.addProperty("fill", c.fill);
            o.addProperty("stddev", Math.round(c.stddev * 100.0) / 100.0);
            o.addProperty("water_columns", c.water);
            o.addProperty("distance", Math.round(c.dist * 10.0) / 10.0);
            BlockPos fitMin = new BlockPos(c.x - margin, c.targetY + 1, c.z - margin);
            BlockPos fitMax = new BlockPos(c.x + w - 1 + margin, c.targetY + h + above,
                c.z + d - 1 + margin);
            FitScan scan = fitScan(level, loader, fitMin, fitMax);
            if (scan.unread > 0) {
                o.add("fits", null);
            } else {
                o.addProperty("fits", scan.conflictCount == 0);
            }
            if (scan.conflictCount > 0) {
                o.addProperty("conflict_count", scan.conflictCount);
            }
            out.add(o);
        }

        JsonObject r = new JsonObject();
        // candidates is a verdict: over a fully-unread scan it is null, never an empty list —
        // "no sites found" must not be conflatable with "nothing was read".
        if (readCols == 0) {
            r.add("candidates", null);
        } else {
            r.add("candidates", out);
        }
        r.addProperty("evaluated", evaluated);
        JsonObject rej = new JsonObject();
        rej.addProperty("unread", rejUnread);
        rej.addProperty("water", rejWater);
        rej.addProperty("steep", rejSteep);
        r.add("rejected", rej);
        if (readCols > 0 && unreadCols > 0) {
            r.addProperty("note", "the scan area was partly unreadable — better sites may exist "
                + "among the unread columns (see coverage)");
        } else if (readCols > 0 && out.size() == 0) {
            r.addProperty("note", "no candidate survived the filters — `rejected` says which "
                + "filter was binding; widen radius, raise max_water_columns/max_stddev, or "
                + "shrink the footprint");
        }
        r.add("coverage", coverage(readCols, unreadCols, (int) totalCols, false, loader));
        WorldPerceptionTools.addEnvelope(r, level, "spatial");
        return r;
    }

    // ---- resolve_anchor ------------------------------------------------------

    /** Schema for resolve_anchor's `to`: a point {x,y,z} or a box {min,max}, all keys optional. */
    private static JsonObject toRefSchema() {
        JsonObject s = Schemas.objectOpt(Schemas.object(
            "x", Schemas.integer(), "y", Schemas.integer(), "z", Schemas.integer(),
            "min", Schemas.vec3i(), "max", Schemas.vec3i()),
            "x", "y", "z", "min", "max");
        s.addProperty("description", "Reference to anchor against: a point {x,y,z} (a block) or a "
            + "box {min,max} (inclusive corners — e.g. the `region` an earlier edit/scan reported).");
        return s;
    }

    private static JsonObject resolveAnchor(final ServerLevel level, final JsonObject a) {
        Vec3i size = fitSize(level, a);
        int w = size.getX();
        int h = size.getY();
        int d = size.getZ();
        JsonObject toArg = a.getAsJsonObject("to");
        if (toArg == null) {
            throw new IllegalArgumentException("missing 'to' — a point {x,y,z} or a box {min,max}");
        }
        BlockPos refMin;
        BlockPos refMax;
        if (toArg.has("min") || toArg.has("max")) {
            BlockPos p1 = pos(toArg, "min");
            BlockPos p2 = pos(toArg, "max");
            refMin = new BlockPos(Math.min(p1.getX(), p2.getX()), Math.min(p1.getY(), p2.getY()),
                Math.min(p1.getZ(), p2.getZ()));
            refMax = new BlockPos(Math.max(p1.getX(), p2.getX()), Math.max(p1.getY(), p2.getY()),
                Math.max(p1.getZ(), p2.getZ()));
        } else {
            refMin = new BlockPos(reqInt(toArg, "x"), reqInt(toArg, "y"), reqInt(toArg, "z"));
            refMax = refMin;
        }
        String face = a.has("face") && !a.get("face").isJsonNull() ? a.get("face").getAsString() : null;
        if (face == null) {
            throw new IllegalArgumentException("missing 'face' (north|south|east|west|up|down)");
        }
        int gap = optInt(a, "gap", 0);
        if (gap < 0) {
            throw new IllegalArgumentException("gap must be non-negative");
        }
        String align = optStr(a, "align", "center");
        String alignY = optStr(a, "align_y", "min");
        boolean onGround = a.has("on_ground") && !a.get("on_ground").isJsonNull()
            && a.get("on_ground").getAsBoolean();
        boolean check = !a.has("check") || a.get("check").isJsonNull() || a.get("check").getAsBoolean();

        // Face offset + free-axis alignment. North is −z, east is +x (vanilla Direction semantics);
        // "min" base-aligns, "max" top/far-aligns, "center" centers over the reference span.
        int bx;
        int by;
        int bz;
        boolean horizontal = true;
        switch (face) {
            case "north" -> {
                bz = refMin.getZ() - gap - d;
                bx = alignAxis(align, refMin.getX(), refMax.getX(), w);
                by = alignAxis(alignY, refMin.getY(), refMax.getY(), h);
            }
            case "south" -> {
                bz = refMax.getZ() + 1 + gap;
                bx = alignAxis(align, refMin.getX(), refMax.getX(), w);
                by = alignAxis(alignY, refMin.getY(), refMax.getY(), h);
            }
            case "west" -> {
                bx = refMin.getX() - gap - w;
                bz = alignAxis(align, refMin.getZ(), refMax.getZ(), d);
                by = alignAxis(alignY, refMin.getY(), refMax.getY(), h);
            }
            case "east" -> {
                bx = refMax.getX() + 1 + gap;
                bz = alignAxis(align, refMin.getZ(), refMax.getZ(), d);
                by = alignAxis(alignY, refMin.getY(), refMax.getY(), h);
            }
            case "up" -> {
                by = refMax.getY() + 1 + gap;
                bx = alignAxis(align, refMin.getX(), refMax.getX(), w);
                bz = alignAxis(align, refMin.getZ(), refMax.getZ(), d);
                horizontal = false;
            }
            case "down" -> {
                by = refMin.getY() - gap - h;
                bx = alignAxis(align, refMin.getX(), refMax.getX(), w);
                bz = alignAxis(align, refMin.getZ(), refMax.getZ(), d);
                horizontal = false;
            }
            default -> throw new IllegalArgumentException(
                "unknown face '" + face + "' (north|south|east|west|up|down)");
        }

        ChunkLoader loader = new ChunkLoader(level, loadArg(a));
        JsonObject r = new JsonObject();
        int groundRequested = 0;
        int groundRead = 0;
        int groundUnread = 0;
        if (onGround) {
            if (!horizontal) {
                throw new IllegalArgumentException("on_ground only makes sense with a horizontal "
                    + "face (north|south|east|west) — an up/down anchor already fixes y");
            }
            // Modal ground under the box's own footprint, trees excluded — same definition as
            // check_site/find_site, so the three tools land boxes at the same height.
            java.util.HashMap<Integer, Integer> mode = new java.util.HashMap<>();
            BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
            groundRequested = w * d;
            for (int x = bx; x < bx + w; x++) {
                for (int z = bz; z < bz + d; z++) {
                    if (!loader.ensure(m.set(x, 0, z))) {
                        groundUnread++;
                        continue;
                    }
                    groundRead++;
                    mode.merge(level.getHeight(Heightmap.Types.MOTION_BLOCKING_NO_LEAVES, x, z) - 1,
                        1, Integer::sum);
                }
            }
            if (groundRead == 0) {
                // No ground was readable, so there is no honest y — the box stays unresolved
                // rather than floating at a guessed height.
                r.add("box", null);
                r.add("origin", null);
                r.addProperty("note", "on_ground could not read any footprint column, so no y "
                    + "exists to resolve to — load the area first (or drop on_ground)");
                r.add("coverage", coverage(0, groundUnread, groundRequested, false, loader));
                WorldPerceptionTools.addEnvelope(r, level, "spatial");
                return r;
            }
            by = mode.entrySet().stream()
                .max(java.util.Map.Entry.comparingByValue()).orElseThrow().getKey() + 1;
            if (groundUnread > 0) {
                r.addProperty("note", "on_ground used the modal ground of the " + groundRead
                    + " readable footprint columns; " + groundUnread + " were unreadable");
            }
        }

        BlockPos boxMin = new BlockPos(bx, by, bz);
        BlockPos boxMax = new BlockPos(bx + w - 1, by + h - 1, bz + d - 1);
        r.add("box", region(boxMin, boxMax));
        JsonObject origin = new JsonObject();
        origin.addProperty("x", bx);
        origin.addProperty("y", by);
        origin.addProperty("z", bz);
        r.add("origin", origin);
        r.addProperty("face", face);
        r.addProperty("gap", gap);

        int volRequested = 0;
        int volRead = 0;
        int volUnread = 0;
        if (check) {
            int above = 0;
            int margin = 0;
            if (a.has("clearance") && a.get("clearance").isJsonObject()) {
                JsonObject c = a.getAsJsonObject("clearance");
                above = optInt(c, "above", 0);
                margin = optInt(c, "margin", 0);
            }
            BlockPos fitMin = boxMin.offset(-margin, 0, -margin);
            BlockPos fitMax = boxMax.offset(margin, above, margin);
            long volume = (long) (fitMax.getX() - fitMin.getX() + 1)
                * (fitMax.getY() - fitMin.getY() + 1) * (fitMax.getZ() - fitMin.getZ() + 1);
            if (volume > MAX_VOLUME) {
                throw new IllegalArgumentException("too_large: the checked volume is " + volume
                    + " cells including clearance (cap " + MAX_VOLUME + ") — pass check:false or "
                    + "shrink the box");
            }
            volRequested = (int) volume;
            FitScan scan = fitScan(level, loader, fitMin, fitMax);
            volRead = scan.read;
            volUnread = scan.unread;
            if (scan.unread > 0) {
                r.add("fits", null);
            } else {
                r.addProperty("fits", scan.conflictCount == 0);
            }
            if (scan.conflictCount > 0) {
                r.add("conflicts", scan.conflicts);
                r.addProperty("conflict_count", scan.conflictCount);
            }
        }
        if (groundRequested + volRequested > 0) {
            r.add("coverage", coverage(groundRead + volRead, groundUnread + volUnread,
                groundRequested + volRequested, false, loader));
        } else {
            // check:false and no on_ground — pure arithmetic, no world was consulted. Vacuously
            // complete coverage, NOT "none": nothing was asked of the world, so nothing is missing.
            JsonObject c = new JsonObject();
            c.addProperty("requested", 0);
            c.addProperty("read", 0);
            c.addProperty("unloaded", 0);
            c.addProperty("unvisited", 0);
            c.addProperty("state", "complete");
            r.add("coverage", c);
        }
        WorldPerceptionTools.addEnvelope(r, level, "spatial");
        return r;
    }

    /** Min corner of a span of {@code size} aligned min|center|max against [refLo, refHi]. */
    private static int alignAxis(final String align, final int refLo, final int refHi, final int size) {
        return switch (align) {
            case "min" -> refLo;
            case "max" -> refHi - size + 1;
            case "center" -> refLo + ((refHi - refLo + 1) - size) / 2;
            default -> throw new IllegalArgumentException(
                "unknown alignment '" + align + "' (min|center|max)");
        };
    }

    private static String optStr(final JsonObject o, final String key, final String fallback) {
        return o.has(key) && !o.get(key).isJsonNull() ? o.get(key).getAsString() : fallback;
    }

    // ---- json helpers --------------------------------------------------------

    /**
     * Where the route starts: the caller's {@code from}, or — when they have a body — where that
     * body is standing.
     *
     * <p>check_path is sold as the look-before-you-leap tool ("the one tool that says the route
     * crosses water before you are in it"), but requiring {@code from} made it cost a bot_status
     * first, which is one more round trip than the leap it was meant to save. A body has exactly one
     * sensible starting point. Live, session w1-85918: the single check_path call of the run failed
     * on the missing argument and was never retried — the agent walked into the terrain instead.
     *
     * <p>A session with no body keeps the error, because there is nothing to default TO — it just
     * says why now, rather than naming an argument the caller thought they didn't need.
     */
    private static BlockPos fromArg(final JsonObject a, final @Nullable LivingEntity self) {
        if (a.has("from") && a.get("from").isJsonObject()) {
            return pos(a, "from");
        }
        if (self == null) {
            throw new IllegalArgumentException("missing position 'from' {x,y,z} — this session has "
                + "no body, so there is nothing to measure from. Spawn one (bot_body "
                + "{action:\"spawn\"}) and `from` defaults to where it stands, or pass `from` to ask "
                + "about a route you are not standing on");
        }
        return self.blockPosition();
    }

    private static BlockPos pos(final JsonObject a, final String key) {
        JsonObject p = a.getAsJsonObject(key);
        if (p == null) {
            throw new IllegalArgumentException("missing position '" + key + "'");
        }
        return new BlockPos(reqInt(p, "x"), reqInt(p, "y"), reqInt(p, "z"));
    }

    private static int reqInt(final JsonObject o, final String key) {
        if (!o.has(key) || o.get(key).isJsonNull()) {
            throw new IllegalArgumentException("missing integer '" + key + "'");
        }
        return o.get(key).getAsInt();
    }

    private static int optInt(final JsonObject o, final String key, final int fallback) {
        return o.has(key) && !o.get(key).isJsonNull() ? o.get(key).getAsInt() : fallback;
    }

    private static JsonObject region(final BlockPos min, final BlockPos max) {
        JsonObject region = new JsonObject();
        JsonObject lo = new JsonObject();
        lo.addProperty("x", min.getX());
        lo.addProperty("y", min.getY());
        lo.addProperty("z", min.getZ());
        JsonObject hi = new JsonObject();
        hi.addProperty("x", max.getX());
        hi.addProperty("y", max.getY());
        hi.addProperty("z", max.getZ());
        JsonObject size = new JsonObject();
        size.addProperty("x", max.getX() - min.getX() + 1);
        size.addProperty("y", max.getY() - min.getY() + 1);
        size.addProperty("z", max.getZ() - min.getZ() + 1);
        region.add("min", lo);
        region.add("max", hi);
        region.add("size", size);
        return region;
    }
}
