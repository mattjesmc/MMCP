package com.mattmc.mcptoolkit;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mojang.datafixers.util.Pair;
import com.mattmc.mcptoolkit.hooks.ServerHooks;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Holder;
import net.minecraft.core.HolderSet;
import net.minecraft.core.Registry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.Identifier;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.tags.TagKey;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.ai.village.poi.PoiManager;
import net.minecraft.world.entity.ai.village.poi.PoiType;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.biome.Biome;
import net.minecraft.world.level.levelgen.structure.Structure;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

import com.google.gson.JsonElement;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.concurrent.CompletableFuture;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.function.Predicate;

/**
 * {@code locate} — the relation-shaped read, and the session ledger behind it.
 *
 * <p><b>Why this exists.</b> ARCHITECTURE.md names two model failure modes, not one. Coordinate
 * arithmetic is the one the {@code check_*} predicates attack. The other is <em>sequential-
 * observation map integration</em>: a model reading observations turn by turn cannot assemble them
 * into a map. {@code locate} attacks that one — every find is reported <em>already related</em> to
 * the observer and to what this session located earlier ("tower, W of you 200, WNW of the tree
 * 140"). The model never integrates anything, because the integration arrives done. That is the
 * representation humans actually hold: landmarks and bearings between them, never coordinates.
 *
 * <p><b>One routing level.</b> The relations ride the locate payload; there is no follow-up
 * "relate" call, because a mandatory two-step is a second routing level and those measurably hurt
 * (progressive-disclosure evidence, and the repo's own finding that the agent never climbs the
 * ladder anyway). Only genuinely expensive relations — real pathfinding, footprint terrain work —
 * stay behind their own tools ({@code check_path}, {@code check_site}).
 *
 * <p><b>`what` search is index lookup; `pattern` is the one direction that scans, bounded.</b>
 * v1 covered only targets the server already indexes: worldgen structure placement, the
 * {@link PoiManager} section index, and the entity sections — the volume-scan rung was gated on
 * that benching, which ran 2026-07-24 (TOOL_BILL_PLAN §4a). The rung is {@code pattern}
 * (PATTERN_SEARCH_DESIGN.md): a declarative conjunctive pattern — block/entity/set nodes plus
 * cell relations — matched over a bounded, budgeted, section-palette-prefiltered extent. The
 * payload stays small either way: the scan cost lives server-side and the model sees a handful
 * of referents plus what the search covered.
 *
 * <p><b>The ledger records the search, not just the finds.</b> Finds mostly speak for themselves;
 * it is the <em>negatives</em> that lie, because "no village nearby" is a claim about an extent and
 * the extent is exactly what evaporates when a result gets restated later in a conversation. So
 * every search records its mechanism, centre, radius, elapsed ms, and — the field that matters —
 * {@code negative_is_proof}: worldgen structure placement is deterministic from the seed, so "not
 * found within radius" is a real negative; the POI and entity indices only know chunks that have
 * been generated (and, for entities, entity-searchable after the 0.21.0 staged read), so absence there is not evidence of absence.
 *
 * <p><b>This is not the rejected world mirror.</b> ARCHITECTURE.md's don't-build list rejects a
 * mod-side scene graph, and the distinction has to stay explicit or this rots into one: a scene
 * graph mirrors <em>the world</em>; this ledger holds only the referents <em>this session named</em>,
 * stores handles rather than block state, and re-reads the world on every use (volatile anchors are
 * re-resolved through their entity UUID, never trusted from the record). It is a symbol table for
 * reference — what makes "the tree", "that tower", "north-west of it" resolvable — not a copy of
 * anything.
 */
public final class LocateTools {
    private LocateTools() {}

    /** Anchors kept per session; oldest unpinned is evicted first. Bounded so a long session can't bloat. */
    private static final int MAX_ANCHORS = 24;
    /** Search records kept; the ledger read shows the most recent {@link #SHOWN_SEARCHES}. */
    private static final int MAX_SEARCHES = 32;
    private static final int SHOWN_SEARCHES = 8;
    /**
     * Anchors a find is related against, beyond the observer. Deliberately tiny: relating every find
     * to every prior find is O(n²) text growth, which re-creates the context-size problem the whole
     * design exists to avoid. Pinned anchors win, then most-recent.
     */
    private static final int RELATE_MAX = 2;

    private static final int DEFAULT_LIMIT = 3;
    private static final int MAX_LIMIT = 8;
    /** Positions per `at` (identify) call. Below get_blocks_at's 256 on purpose: this direction is
     *  for referents and batch verification, not for sweeping a volume — describe_box does that. */
    private static final int AT_MAX = 64;
    /** Structure placement search is chunk-radius based (vanilla /locate uses 100 chunks). */
    private static final int STRUCTURE_DEFAULT_RADIUS = 1600;
    private static final int STRUCTURE_MAX_RADIUS = 6400;
    private static final int POI_DEFAULT_RADIUS = 128;
    private static final int POI_MAX_RADIUS = 256;
    private static final int ENTITY_DEFAULT_RADIUS = 64;
    private static final int ENTITY_MAX_RADIUS = 128;
    /** Biome search is a seed computation, not a read — the radius bound is cost, not residency. */
    private static final int BIOME_DEFAULT_RADIUS = 1600;
    private static final int BIOME_MAX_RADIUS = 6400;
    /** Vanilla's own /locate biome sample resolution; changing it changes what a miss means. */
    private static final int BIOME_SAMPLE_H = 32;
    private static final int BIOME_SAMPLE_V = 64;
    private static final int PATTERN_DEFAULT_RADIUS = 32;
    private static final int PATTERN_MAX_RADIUS = 128;
    /** Candidate cells per pattern node before the enumeration flags itself truncated. */
    private static final int NODE_CANDIDATE_CAP = 4096;
    /** Distinct matches before enumeration stops (flagged; the negative dies with it). */
    private static final int MATCH_CAP = 512;
    /**
     * Cells one property-only node may sweep. Nothing indexes light, so a node selected purely by
     * cell properties visits every cell in the extent — 2^18 keeps that a tens-of-milliseconds read
     * (a 32-radius survey affords ~60 y-levels). Over budget is REFUSED, never truncated: a
     * silently-partial spawn survey reports safety it did not verify.
     */
    private static final int CELL_SWEEP_MAX = 262_144;
    /** Anchor cells one result set may hold; overflow flags the set truncated forever. */
    private static final int SET_MAX_MEMBERS = 256;
    /**
     * Members one {@code anchors show:} page reads out. Sized like {@code AT_MAX} rather than
     * {@link #MAX_LIMIT}, because this is the ENUMERATION door, not the referent one: eight is the
     * right number of landmarks to name and the wrong number of chests to list (LOCATE_ROUTES.md
     * C2/C3). Bounded all the same — the page also bounds how many cells get re-verified per call.
     */
    private static final int SET_SHOW_MAX = 64;
    /** Result sets kept per session, oldest evicted — a ring, like the edit journal. */
    private static final int MAX_SETS = 8;
    /** Named regions kept per session; same ring discipline as sets. */
    private static final int MAX_REGIONS = 8;
    /**
     * Cells one LINE read may return. A line is the one shape whose exact contents stay model-safe
     * (run-length runs along a single axis — a lookup, not character arithmetic over a grid), so it
     * enumerates where a box describes. Sized to a full world column.
     */
    private static final int AT_LINE_MAX = 384;
    private static final int PATTERN_MAX_NODES = 6;
    private static final int PATTERN_MAX_RELATIONS = 12;
    /** `within` radius cap — a loose relation is a candidate-set filter, not a second scan. */
    private static final int WITHIN_MAX = 16;

    private static final String ANON = "anon";
    private static final int REAP_INTERVAL = 100;
    private static int reapCounter;

    // ---- the ledger ----------------------------------------------------------

    /**
     * One named referent. <b>Static anchors</b> (structures, POIs) keep the position they were found
     * at; <b>volatile anchors</b> (entities) keep only a handle and are re-resolved through
     * {@link #uuid} on every use, because storing a mobile thing's position is the bug that makes a
     * relation quietly false. Staleness is carried as age + a flag, never as a confidence score.
     */
    static final class Anchor {
        final String handle;
        final String kind;
        final String id;
        final String dimension;
        final @Nullable UUID uuid;
        final boolean yKnown;
        int x;
        int y;
        int z;
        long tick;
        boolean pinned;
        boolean stale;

        Anchor(final String handle, final String kind, final String id, final String dimension,
               final @Nullable UUID uuid, final BlockPos pos, final boolean yKnown,
               final long tick) {
            this.handle = handle;
            this.kind = kind;
            this.id = id;
            this.dimension = dimension;
            this.uuid = uuid;
            this.yKnown = yKnown;
            this.x = pos.getX();
            this.y = pos.getY();
            this.z = pos.getZ();
            this.tick = tick;
        }

        boolean isVolatile() {
            return uuid != null;
        }
    }

    /**
     * A named result set: the anchor-node cells of one pattern search, plus the provenance that
     * keeps a chained negative honest (what extent produced it, when, and whether anything was
     * cut). <b>Members are never trusted on re-use</b> — every use re-tests each cell with the
     * stored matcher, so a mined member drops out ({@code stale_dropped}) and an unreadable one
     * is excluded and poisons the downstream negative ({@code unverifiable}). Stored members are
     * immutable: the set records what the query found <em>then</em>; re-verification happens on
     * every use, not once. Block cells only (PATTERN_SEARCH_DESIGN.md §Sets — entity results are
     * volatile anchors, and a stored entity set cannot tell <em>gone</em> from <em>unloaded</em>).
     */
    static final class ResultSet {
        final String name;
        final String dimension;
        /**
         * The anchor node's block spec, re-testable through {@code BlockTools.parseInput} — or null
         * when the node had no matcher at all (a property-only node, 0.31.0), in which case
         * {@link #cells} alone defines membership.
         */
        final @Nullable String matcher;
        final @Nullable String matcherId;
        /**
         * Cell properties that were part of membership, ANDed. Stored because re-verification has to
         * re-test the WHOLE condition: a set of "dark air cells" re-checked as merely "air" would
         * quietly re-admit cells someone has since lit, and every chained negative built on it would
         * inherit that. Chains accumulate — a set built from a set carries the parent's too.
         */
        final List<CellPred> cells;
        final List<BlockPos> members;
        final long tick;
        final String extent;
        final boolean fullyRead;
        final boolean truncated;

        ResultSet(final String name, final String dimension, final @Nullable String matcher,
                  final @Nullable String matcherId, final List<CellPred> cells,
                  final List<BlockPos> members, final long tick,
                  final String extent, final boolean fullyRead, final boolean truncated) {
            this.name = name;
            this.dimension = dimension;
            this.matcher = matcher;
            this.matcherId = matcherId;
            this.cells = List.copyOf(cells);
            this.members = List.copyOf(members);
            this.tick = tick;
            this.extent = extent;
            this.fullyRead = fullyRead;
            this.truncated = truncated;
        }

        /** What membership in this set means, as one readable line. */
        String spec() {
            StringBuilder sb = new StringBuilder(matcher == null ? "any block" : matcher);
            for (CellPred c : cells) {
                sb.append(c.summary());
            }
            return sb.toString();
        }

        boolean needsLight() {
            return cells.stream().anyMatch(CellPred::needsLight);
        }

        boolean cellsOk(final ServerLevel level, final BlockPos pos) {
            for (CellPred c : cells) {
                if (!c.test(level, pos)) {
                    return false;
                }
            }
            return true;
        }
    }

    /**
     * A named REGION — the extent referent the ledger lacked (LOCATE_ROUTES.md D2). "The room I am
     * standing in", "the area I already surveyed" become nameable, so a later search can be scoped
     * to them and its negative can be stated about a thing rather than about a radius.
     *
     * <p>It stores <b>corners, dimension and tick — never contents</b>. A region that cached what was
     * inside it would be the mod-side world mirror the don't-build list rejects; every use re-reads
     * the world, exactly like an anchor.
     */
    static final class Region {
        final String name;
        final String dimension;
        final BlockPos min;
        final BlockPos max;
        final long tick;

        Region(final String name, final String dimension, final BlockPos min, final BlockPos max,
               final long tick) {
            this.name = name;
            this.dimension = dimension;
            this.min = min;
            this.max = max;
            this.tick = tick;
        }

        long volume() {
            return (long) (max.getX() - min.getX() + 1) * (max.getY() - min.getY() + 1)
                * (max.getZ() - min.getZ() + 1);
        }

        BlockPos center() {
            return new BlockPos((min.getX() + max.getX()) / 2, (min.getY() + max.getY()) / 2,
                (min.getZ() + max.getZ()) / 2);
        }

        String describe() {
            return min.getX() + "," + min.getY() + "," + min.getZ() + " .. "
                + max.getX() + "," + max.getY() + "," + max.getZ();
        }
    }

    /** One session's referents and the searches that produced them. Insertion order = recency. */
    static final class Ledger {
        final LinkedHashMap<String, Anchor> anchors = new LinkedHashMap<>();
        final LinkedHashMap<String, ResultSet> sets = new LinkedHashMap<>();
        final LinkedHashMap<String, Region> regions = new LinkedHashMap<>();
        final ArrayDeque<JsonObject> searches = new ArrayDeque<>();

        void addRegion(final Region g) {
            regions.remove(g.name);
            regions.put(g.name, g);
            while (regions.size() > MAX_REGIONS) {
                regions.remove(regions.keySet().iterator().next());
            }
        }

        void record(final JsonObject search) {
            searches.addLast(search);
            while (searches.size() > MAX_SEARCHES) {
                searches.removeFirst();
            }
        }

        void addSet(final ResultSet s) {
            sets.remove(s.name); // re-naming replaces and moves to most-recent
            sets.put(s.name, s);
            while (sets.size() > MAX_SETS) {
                sets.remove(sets.keySet().iterator().next());
            }
        }

        void add(final Anchor a) {
            anchors.remove(a.handle); // re-locating something moves it to most-recent
            anchors.put(a.handle, a);
            while (anchors.size() > MAX_ANCHORS) {
                String victim = null;
                for (var e : anchors.entrySet()) {
                    if (!e.getValue().pinned) {
                        victim = e.getKey();
                        break;
                    }
                }
                if (victim == null) {
                    break; // everything pinned: the caller owns the consequences, don't drop pins
                }
                anchors.remove(victim);
            }
        }
    }

    private static final Map<String, Ledger> LEDGERS = new HashMap<>();

    private static String key(final @Nullable String sessionId) {
        return sessionId == null || sessionId.isBlank() ? ANON : sessionId;
    }

    private static Ledger ledgerFor(final @Nullable String sessionId) {
        return LEDGERS.computeIfAbsent(key(sessionId), k -> new Ledger());
    }

    // ---- registration --------------------------------------------------------

    public static void register() {
        // Dead sessions lose their ledger; a ledger is meaningless without the conversation that
        // built it. Mirrors the drone-slot reap.
        ServerHooks.END_SERVER_TICK.register(s -> {
            if (++reapCounter < REAP_INTERVAL) {
                return;
            }
            reapCounter = 0;
            Iterator<Map.Entry<String, Ledger>> it = LEDGERS.entrySet().iterator();
            while (it.hasNext()) {
                String owner = it.next().getKey();
                if (!ANON.equals(owner) && !Sessions.isLive(owner)) {
                    it.remove();
                }
            }
        });
        // An anchor is only meaningful in the level it was recorded against, and on the integrated
        // server the process outlives worlds — same reasoning as the edit journal.
        ServerHooks.SERVER_STOPPING.register(s -> LEDGERS.clear());

        McpTools.register(ToolDef.async(
            "locate",
            "TWO-WAY. `what` searches (thing -> positions); `at` identifies (positions -> thing) — "
                + "one position, a list, or a whole EXTENT, which comes back described. "
                + "Same relation, solved for whichever variable you leave blank — give exactly one. "
                + "`at` [{x,y,z,expect?}] reads those exact cells and is the ONLY way to answer "
                + "\"what block is at (x,y,z)\": returns a palette of id[state] strings in set_blocks "
                + "syntax (a read round-trips into a write), aligned affordance flags, rows "
                + "[x,y,z,paletteIndex], and -1 for any position that could not be read — never a "
                + "guess. Optional per-entry `expect` tests that cell with vanilla's own matcher (as "
                + "/execute if block, partial properties and NBT included), so verifying N placements "
                + "is ONE call reporting check.all_matched plus what was actually there. ONE `at` "
                + "entry becomes a referent (handle + relations + anchor, and any entity standing "
                + "there); several stay a batch reading. Max " + AT_MAX + " positions. "
                + "An `at` entry may instead carry an EXTENT (dx/dy/dz = extra blocks per axis), "
                + "which is how you read more than points: ONE axis is a LINE — dy alone reads the "
                + "whole COLUMN, returned as run-length [from,to,block] runs, so a 60-block column "
                + "costs its layers not its height — and TWO OR MORE axes DESCRIBE the volume "
                + "(material counts with bounding boxes, the non-air box, the per-layer solid "
                + "profile, shell-air openings). That is the answer to \"what is this building made "
                + "of\" and \"how much iron is in here\"; it is a description on purpose, because a "
                + "dumped grid is where cell-counting mistakes come from. `as` on an extent NAMES "
                + "the region, and `in`:\"<name>\" then scopes a later `what`/`pattern` to it "
                + "(\"any spawnable cell IN my base\", \"chests IN the vault\") with the region "
                + "named in search.extent, so the negative is about the room rather than about a "
                + "radius; `in` with nothing else describes it again. Regions store CORNERS ONLY "
                + "and re-read on every use. `in` cannot scope a structure or biome search (those "
                + "return the nearest match only, so a box filter could hide one inside your "
                + "region behind a nearer one outside it). "
                + "Find something and get it back ALREADY RELATED to you and to what you located earlier "
                + "(\"tower, W of you 200 blocks, WNW of lookout_tree 140\") — use this instead of "
                + "collecting coordinates and working out where things are relative to each other. "
                + "`what` is a namespaced id or #tag, optionally kind-prefixed: a structure "
                + "(minecraft:village_plains, structure:#minecraft:village), a POI type "
                + "(minecraft:home, poi:#minecraft:bee_home), an entity type (minecraft:zombie), "
                + "an entity category (hostile|living|item|player), a BIOME "
                + "(minecraft:desert, biome:#minecraft:is_forest — the only way to ask where a "
                + "terrain TYPE is) or a BLOCK id/tag "
                + "(minecraft:gold_block, block:#minecraft:logs — runs as a one-node `pattern` "
                + "scan, stamped pattern_scan; a tag is how you ask for ANY log/ore/bed, which no "
                + "list of separate searches can answer as one negative). A bare id or tag is "
                + "resolved against the structure, POI, entity, biome and block registries in that "
                + "order, and `search.mechanism` names which one answered. Every POI hit reports "
                + "its claim state as free-of-total tickets, and `occupancy`:free|claimed narrows "
                + "the search to sites with a ticket left / already taken — that is how you ask "
                + "whether a village has a spare bed or an unclaimed job site. `near` {x,z} centres the "
                + "search (default: your body, else the first player) and `radius` is HORIZONTAL — "
                + "every height is searched, so a map radius means what it looks like; `as` names "
                + "the find so you can refer to it later. Each result carries a `handle` "
                + "(village_plains@-104,71,238) — pass handles around, never retyped coordinates — "
                + "and `relations` [{to, bearing, map_distance, dy}], where map_distance is "
                + "HORIZONTAL and dy carries the vertical, the way a landmark relation is stated. "
                + "`what` search is INDEX LOOKUP (worldgen structure placement, the POI section "
                + "index, entity sections, the biome climate sampler — STAGED: absent chunks are "
                + "paged in and the read waits the tick their entity data needs, like "
                + "get_entities) — except a block `what`, which runs as the bounded pattern scan "
                + "above and reports its matches NEAREST FIRST. Read "
                + "`search.negative_is_proof`: TRUE for structures (placement is deterministic "
                + "from the seed, so not-found-within-radius is a real negative) and for entity "
                + "searches whose whole radius was entity-searched after staging; FALSE for POIs "
                + "(that index only knows generated chunks) and wherever chunks stayed unreadable "
                + "— the cause is always named. A biome miss is its own case: TRUE only when this "
                + "dimension cannot generate that biome at all (then no radius will ever find it), "
                + "FALSE otherwise because sampling is every 32 blocks — a resolution limit, not "
                + "an unread one, so widening the radius searches further without making a miss "
                + "more conclusive. A structure find resolves a COLUMN, so its handle reads "
                + "village_plains@1488,~,-224 and pos.y is null — the height is not known, and a "
                + "wide structure search costs ~0.8s of server thread (see search.ms). "
                + "`pattern` is the THIRD direction and the only one that scans (bounded, "
                + "palette-prefiltered, reads page in but never generate): state a CONFIGURATION "
                + "as nodes + relations and get back where it holds. Nodes {id, block|entity|set}: "
                + "`block` is a matcher in set_blocks syntax OR a #tag (same semantics as "
                + "`expect`), `entity` "
                + "a type/#tag/category, `set` a stored result set. Relations "
                + "{rel, of:[a,b], dx/dy/dz/r}: adjacent (share a face) | above | below (a directly "
                + "above/below b — an entity above a block is STANDING ON it) | offset (a=b+d) | "
                + "within (Chebyshev<=r). One block node with no relations = \"find this block\". "
                + "Example, a gold block with a mob on it beside a second gold: nodes "
                + "a/b=minecraft:gold_block, e=living; relations adjacent(a,b), above(e,a). "
                + "Nodes ALSO take CELL PROPERTIES — the non-geometric half, and the only way to ask "
                + "about light: `light` and `sky_light` {min,max} on the 0-15 scale, `sees_sky`, and "
                + "`spawnable`:true = a hostile mob could spawn in this cell (vanilla's own "
                + "ON_GROUND spawn-position rule — valid surface below, this cell and the one above "
                + "both free — plus this dimension's block-light limit, both read out as "
                + "search.spawn_block_light_limit). `spawnable` OVER-reports deliberately (the "
                + "per-mob rules, the randomised light draw, biome lists, difficulty and caps are "
                + "not applied), so a match is a candidate cell and the sound claim is the NEGATIVE: "
                + "no candidate over a fully-read extent IS spawn-proofing, which is the question "
                + "worth asking. A node may carry cell properties INSTEAD of block/entity/set, which "
                + "tests every cell (nothing indexes light) — that needs a `y_range` and a modest "
                + "`radius` or it is refused rather than silently cut short. Chunks whose lighting "
                + "has not been computed are skipped, not read as dark, and counted in "
                + "search.light_unknown_chunks. "
                + "Matches come back as referents for the `anchor` node (default: first) plus "
                + "matches_total; `as` ALSO stores every distinct anchor cell as a RESULT SET (cap "
                + "256) usable as a later pattern's node — members are re-tested live on every use "
                + "(mined ones drop out as stale_dropped), so a refinement chain never trusts an "
                + "old read. matches_total is exact and a miss is proof ONLY when "
                + "search.negative_is_proof is true (full extent read, no caps, clean set "
                + "provenance — otherwise the cause is named and it is a lower bound). "
                + "Finds become anchors for the next locate; "
                + "`anchors` reads and edits that ledger (sets included). For expensive relations "
                + "use check_path (can a body get there) and check_site (terrain work).",
            Schemas.objectOpt(Schemas.object(
                "what", Schemas.str("Target: namespaced id (structure, POI, entity or block), #tag, kind:id (structure:/poi:/entity:), or an entity category."),
                "at", Schemas.array(Schemas.objectOpt(Schemas.object(
                    "x", Schemas.integer(), "y", Schemas.integer(), "z", Schemas.integer(),
                    "dx", Schemas.integer("Extra blocks along x (0 = this block; negative goes the "
                        + "other way). With dy/dz: one axis = a LINE read, two or more = the "
                        + "region description. Must be the only `at` entry."),
                    "dy", Schemas.integer("Extra blocks along y — dy alone reads the COLUMN."),
                    "dz", Schemas.integer("Extra blocks along z."),
                    "expect", Schemas.str("Optional block to test this position against, in set_blocks "
                        + "syntax (\"minecraft:chest\", \"minecraft:chest[facing=north]\", "
                        + "\"#minecraft:logs\", {nbt} suffix matched too) — same semantics as "
                        + "/execute if block."),
                    "clear", Schemas.bool("Test that this cell is CLEAR (air or replaceable growth): "
                        + "the fit predicate. Batch-clear a box's cells and check.all_matched IS the "
                        + "does-it-fit verdict. Mutually exclusive with `expect`.")),
                    "expect", "clear", "dx", "dy", "dz")),
                "pattern", Schemas.objectOpt(Schemas.object(
                    "nodes", Schemas.array(Schemas.objectOpt(Schemas.object(
                        "id", Schemas.str("Node name, referenced by relations."),
                        "block", Schemas.str("Block matcher: id[state]{nbt} or #tag[state]{nbt} — `expect` semantics."),
                        "entity", Schemas.str("Entity type id, #tag, or hostile|living|item|player."),
                        "set", Schemas.str("Name of a result set stored earlier with `as`."),
                        "light", Schemas.objectOpt(Schemas.object(
                            "min", Schemas.integer(), "max", Schemas.integer()),
                            "min", "max"),
                        "sky_light", Schemas.objectOpt(Schemas.object(
                            "min", Schemas.integer(), "max", Schemas.integer()),
                            "min", "max"),
                        "sees_sky", Schemas.bool("Cell has open sky above it."),
                        "spawnable", Schemas.bool("Cell is a hostile-mob spawn candidate (see the "
                            + "tool description: over-reports, so the NEGATIVE is the sound claim).")),
                        "block", "entity", "set", "light", "sky_light", "sees_sky", "spawnable")),
                    "relations", Schemas.array(Schemas.objectOpt(Schemas.object(
                        "rel", Schemas.str("adjacent|above|below|offset|within."),
                        "of", Schemas.array(Schemas.str()),
                        "dx", Schemas.integer(), "dy", Schemas.integer(), "dz", Schemas.integer(),
                        "r", Schemas.integer("For within: Chebyshev radius, 1.." + WITHIN_MAX + ".")),
                        "dx", "dy", "dz", "r")),
                    "anchor", Schemas.str("Node whose cells are THE result (default: first node).")),
                    "relations", "anchor"),
                "near", Schemas.objectOpt(Schemas.object(
                    "x", Schemas.integer(), "y", Schemas.integer("Optional; only affects dy. Default sea level."),
                    "z", Schemas.integer()), "y"),
                "radius", Schemas.integer("HORIZONTAL search half-width in blocks (every height is "
                    + "searched). Defaults: structures "
                    + STRUCTURE_DEFAULT_RADIUS + ", biomes " + BIOME_DEFAULT_RADIUS + " (cap "
                    + BIOME_MAX_RADIUS + "), POIs " + POI_DEFAULT_RADIUS + ", entities "
                    + ENTITY_DEFAULT_RADIUS + ", patterns " + PATTERN_DEFAULT_RADIUS
                    + " (cap " + PATTERN_MAX_RADIUS + ")."),
                "y_range", Schemas.objectOpt(Schemas.object(
                    "min", Schemas.integer(), "max", Schemas.integer()), "min", "max"),
                "limit", Schemas.integer("Max results (default " + DEFAULT_LIMIT + ", cap " + MAX_LIMIT
                    + "). Structure search returns the nearest one only."),
                "in", Schemas.str("Name of a region (or result set) to scope this call to. Alone: "
                    + "describes what that region is MADE OF."),
                "occupancy", Schemas.str("POI searches only: any (default) | free (a ticket is "
                    + "still available — an unclaimed bed/job site) | claimed (at least one ticket "
                    + "taken). Unclaimable types (portals, lodestones, hives) have no tickets and "
                    + "match neither — ask for those unfiltered."),
                "as", Schemas.str("Name the first find, so later locates relate to it by this name. "
                    + "On a pattern search: also stores the anchor node's cells as a result set."),
                "drone", Schemas.bool("Centre on your body rather than a player."),
                "player", Schemas.str("Centre on this player."),
                "dimension", Schemas.str("Dimension id, default minecraft:overworld."),
                // Read by the `at` box census (boxCensus → scanBox) since it was built, never
                // declared. Same class as bot_goto's route profile: the tool accepted more than its
                // schema admitted, which was invisible until ArgCheck made the schema binding.
                "load", Schemas.bool("Pull absent chunks in so they can be read. Default true.")),
                "what", "at", "pattern", "in", "near", "radius", "y_range", "limit",
                "occupancy", "as", "drone", "player", "dimension", "load"),
            ExecutionContext.SERVER,
            Mechanism.OBSERVE,
            (ctx, a) -> {
                MinecraftServer server = ctx.serverOrThrow();
                String session = ctx.sessionId();
                // Entity searches STAGE like get_entities (0.21.0): absent chunks are paged in
                // and the read parks the tick(s) their entity data needs. The stage is a
                // best-effort pre-pass — any argument problem is deliberately re-raised by
                // locate() itself so error messages keep one definition.
                return prestageForLocate(server, a, session)
                    .thenApply(pending -> (JsonElement) locate(server, a, session));
            }));

        McpTools.register(ToolDef.of(
            "anchors",
            "Read or edit YOUR locate ledger: the referents this session has named, the result sets "
                + "pattern searches stored, and the searches that produced them (what was looked "
                + "for, over what extent, and whether a negative was proof). Call with no arguments "
                + "to read it. `pin` a handle to keep it as a relation reference for every later "
                + "locate (your base, a work site — pinned anchors survive eviction); `drop` a "
                + "handle, set or region name to forget it; `clear`:true forgets everything "
                + "unpinned (sets and regions included). Regions are the named extents `locate at` "
                + "+ dx/dy/dz + `as` creates — corners only, re-read on use, and the thing `locate "
                + "in:` scopes a search to. `show`:<set name> READS OUT a stored set's member positions — this is "
                + "how you list EVERY match a pattern search found (locate reports only the nearest "
                + "few as referents, but `as` stored all of them, up to " + SET_MAX_MEMBERS + "): "
                + SET_SHOW_MAX + " per page, `from` pages the rest, each member re-tested against "
                + "the world as it is now (changed ones come back as `dropped`, not as members) and "
                + "carrying its bearing/distance from you. Read `complete_enumeration` before "
                + "saying \"these are all of them\". Anchors for entities are re-resolved live on "
                + "use, so a moved mob relates from where it is now, with staleness flagged if it "
                + "is gone.",
            Schemas.objectOpt(Schemas.object(
                "pin", Schemas.str("Handle to pin."),
                "drop", Schemas.str("Handle to forget."),
                "clear", Schemas.bool("Forget all unpinned anchors."),
                "show", Schemas.str("Name of a result set whose members to read out."),
                "from", Schemas.integer("With `show`: 0-based member offset to page from (default 0; "
                    + "the reply's `next_from` continues).")),
                "pin", "drop", "clear", "show", "from"),
            ExecutionContext.SERVER,
            Mechanism.OBSERVE,
            (ctx, a) -> anchors(ctx.serverOrThrow(), a, ctx.sessionId())));
    }

    // ---- target parsing ------------------------------------------------------

    private enum Kind { STRUCTURE, POI, ENTITY, CATEGORY, BIOME, BLOCK }

    private record Target(Kind kind, @Nullable Identifier id, boolean tag, @Nullable String category) {}

    /**
     * Resolve {@code what} to a search kind. Explicit {@code kind:} prefixes win; a bare namespaced
     * id — <b>or tag</b> — is looked up in the structure, POI, entity, biome and block registries in
     * that order (ids are namespaced, so this is unambiguous in practice, and the index that
     * answered is always visible afterwards as {@code search.mechanism}). Failure names every
     * registry that was tried — a target that silently resolves to the wrong index would be a
     * confident wrong answer.
     *
     * <p>The tag probe used to be refused as not-cheap-per-registry, which was simply wrong
     * ({@code Registry.get(TagKey)} is a map lookup) and cost the whole disjunctive question class
     * — "any log", "any ore", "any bed" — since a tag was the only way to ask it
     * (LOCATE_ROUTES.md B1). Biome was missing outright (A1): the climate sampler answers it, and
     * nothing else in the toolkit can.
     */
    private static Target parseTarget(final ServerLevel level, final String raw) {
        String what = raw.trim();
        if (what.isEmpty()) {
            throw new IllegalArgumentException("`what` is empty");
        }
        String lower = what.toLowerCase(java.util.Locale.ROOT);
        if (lower.equals("hostile") || lower.equals("living") || lower.equals("item")
            || lower.equals("player")) {
            return new Target(Kind.CATEGORY, null, false, lower);
        }
        Kind forced = null;
        if (lower.startsWith("structure:")) {
            forced = Kind.STRUCTURE;
            what = what.substring("structure:".length());
        } else if (lower.startsWith("poi:")) {
            forced = Kind.POI;
            what = what.substring("poi:".length());
        } else if (lower.startsWith("entity:")) {
            forced = Kind.ENTITY;
            what = what.substring("entity:".length());
        } else if (lower.startsWith("biome:")) {
            forced = Kind.BIOME;
            what = what.substring("biome:".length());
        } else if (lower.startsWith("block:")) {
            forced = Kind.BLOCK;
            what = what.substring("block:".length());
        }
        if (forced == Kind.ENTITY) {
            String c = what.toLowerCase(java.util.Locale.ROOT);
            if (c.equals("hostile") || c.equals("living") || c.equals("item") || c.equals("player")) {
                return new Target(Kind.CATEGORY, null, false, c);
            }
        }
        boolean tag = what.startsWith("#");
        if (tag) {
            what = what.substring(1);
        }
        Identifier id;
        try {
            id = Identifier.parse(what);
        } catch (Exception e) {
            throw new IllegalArgumentException("`what` is not a valid id: " + raw
                + " (expected e.g. minecraft:village_plains, #minecraft:village, minecraft:zombie, "
                + "minecraft:desert, #minecraft:logs, or a category: hostile|living|item|player)");
        }
        if (forced != null) {
            return new Target(forced, id, tag, null);
        }
        Registry<Structure> structures = level.registryAccess().lookupOrThrow(Registries.STRUCTURE);
        Registry<net.minecraft.world.level.biome.Biome> biomes =
            level.registryAccess().lookupOrThrow(Registries.BIOME);
        // Bare target: try each index in turn — ids and tags alike, same precedence order.
        if (tag) {
            if (structures.get(TagKey.create(Registries.STRUCTURE, id)).isPresent()) {
                return new Target(Kind.STRUCTURE, id, true, null);
            }
            if (BuiltInRegistries.POINT_OF_INTEREST_TYPE
                    .get(TagKey.create(Registries.POINT_OF_INTEREST_TYPE, id)).isPresent()) {
                return new Target(Kind.POI, id, true, null);
            }
            if (BuiltInRegistries.ENTITY_TYPE
                    .get(TagKey.create(Registries.ENTITY_TYPE, id)).isPresent()) {
                return new Target(Kind.ENTITY, id, true, null);
            }
            if (biomes.get(TagKey.create(Registries.BIOME, id)).isPresent()) {
                return new Target(Kind.BIOME, id, true, null);
            }
            if (BuiltInRegistries.BLOCK.get(TagKey.create(Registries.BLOCK, id)).isPresent()) {
                return new Target(Kind.BLOCK, id, true, null);
            }
            throw new IllegalArgumentException("unknown tag '#" + id + "' — not a structure, "
                + "point-of-interest, entity, biome or block tag in this world. Prefix it to say "
                + "which index you meant (structure:#" + id + ", poi:#" + id + ", entity:#" + id
                + ", biome:#" + id + ", block:#" + id + "), or use query_registry to find the "
                + "right tag.");
        }
        if (structures.get(id).isPresent()) {
            return new Target(Kind.STRUCTURE, id, false, null);
        }
        if (BuiltInRegistries.POINT_OF_INTEREST_TYPE.get(id).isPresent()) {
            return new Target(Kind.POI, id, false, null);
        }
        if (BuiltInRegistries.ENTITY_TYPE.get(id).isPresent()) {
            return new Target(Kind.ENTITY, id, false, null);
        }
        if (biomes.get(id).isPresent()) {
            return new Target(Kind.BIOME, id, false, null);
        }
        // The observed miss (bench 2026-07-25): a model searching for a BLOCK reaches for `what`
        // first — right instinct. 0.18.1 answered with an error carrying the pattern recipe;
        // 0.19.0 goes the whole way (principal's nod, same day): a bare block id IS the same
        // relation at(thing, position) with the same unknown, so the collapse rule wants it in
        // `what`, promoted to a one-node pattern scan — same code path, honestly stamped
        // `pattern_scan` with its typed negative, never a silent index probe.
        if (BuiltInRegistries.BLOCK.get(id).isPresent()) {
            return new Target(Kind.BLOCK, id, false, null);
        }
        throw new IllegalArgumentException("unknown target '" + raw + "' — not a structure, "
            + "point-of-interest type, entity type, biome or block in this world. Prefix it "
            + "(structure:/poi:/entity:/biome:/block:) to force one index, or use query_registry "
            + "to find the right id.");
    }

    // ---- entity-data pre-stage (0.21.0) --------------------------------------

    /**
     * Best-effort pre-stage for the entity-touching directions: `what` entity/category searches
     * and patterns with entity nodes get their chunk rect's entity data paged-and-waited through
     * {@link WorldPerceptionTools#stageEntityRect} — the same mechanism as get_entities, so
     * "staged" has exactly one definition. Errors here are swallowed on purpose: locate() runs
     * regardless and raises its own (authoritative) validation messages; a failed pre-stage only
     * means the read reports honest partial residency, exactly as before staging existed.
     */
    private static CompletableFuture<Integer> prestageForLocate(final MinecraftServer server,
            final JsonObject a, final @Nullable String session) {
        try {
            boolean hasWhat = a.has("what") && !a.get("what").isJsonNull();
            boolean hasPattern = a.has("pattern") && a.get("pattern").isJsonObject();
            int radius;
            if (hasWhat) {
                ServerLevel level = levelForPrestage(server, a, session);
                Target t = parseTarget(level, a.get("what").getAsString());
                if (t.kind() != Kind.ENTITY && t.kind() != Kind.CATEGORY) {
                    return CompletableFuture.completedFuture(0);
                }
                radius = clampRadius(a, ENTITY_DEFAULT_RADIUS, ENTITY_MAX_RADIUS);
            } else if (hasPattern) {
                boolean anyEntity = false;
                JsonObject p = a.getAsJsonObject("pattern");
                if (p.has("nodes") && p.get("nodes").isJsonArray()) {
                    for (var n : p.getAsJsonArray("nodes")) {
                        if (n.isJsonObject() && n.getAsJsonObject().has("entity")) {
                            anyEntity = true;
                            break;
                        }
                    }
                }
                if (!anyEntity) {
                    return CompletableFuture.completedFuture(0);
                }
                radius = clampRadius(a, PATTERN_DEFAULT_RADIUS, PATTERN_MAX_RADIUS);
            } else {
                return CompletableFuture.completedFuture(0);
            }
            if (optStr(a, "in") != null) {
                // The region is the extent; stage what the search will actually read.
                radius = resolveIn(ledgerFor(session), levelForPrestage(server, a, session),
                    a.get("in").getAsString()).coveringRadius();
            }
            if (!ReadSupport.loadArg(a)) {
                return CompletableFuture.completedFuture(0);
            }
            ServerLevel level = levelForPrestage(server, a, session);
            BlockPos center = centerForPrestage(server, a, session, level);
            if (center == null) {
                return CompletableFuture.completedFuture(0); // set-derived extents skip pre-staging
            }
            ReadSupport.ChunkLoader loader = new ReadSupport.ChunkLoader(level, true);
            return WorldPerceptionTools.stageEntityRect(server, level, loader,
                (center.getX() - radius) >> 4, (center.getX() + radius) >> 4,
                (center.getZ() - radius) >> 4, (center.getZ() + radius) >> 4);
        } catch (RuntimeException e) {
            return CompletableFuture.completedFuture(0);
        }
    }

    private static ServerLevel levelForPrestage(final MinecraftServer server, final JsonObject a,
                                                final @Nullable String session) {
        if (a.has("near") && !a.get("near").isJsonNull()) {
            return WorldPerceptionTools.levelArg(server, a);
        }
        try {
            return WorldPerceptionTools.resolveOrigin(a, server, session).level();
        } catch (RuntimeException e) {
            return WorldPerceptionTools.levelArg(server, a);
        }
    }

    private static @Nullable BlockPos centerForPrestage(final MinecraftServer server,
            final JsonObject a, final @Nullable String session, final ServerLevel level) {
        // An `in` search is centred by its region, so the entity data staged must be the region's
        // rect — staging around the observer would page in the wrong chunks and then report an
        // honest-looking negative over data that was never fetched.
        String in = optStr(a, "in");
        if (in != null) {
            try {
                return resolveIn(ledgerFor(session), level, in).center();
            } catch (RuntimeException e) {
                return null;
            }
        }
        if (a.has("near") && !a.get("near").isJsonNull()) {
            JsonObject n = a.getAsJsonObject("near");
            return new BlockPos(n.get("x").getAsInt(), level.getSeaLevel(), n.get("z").getAsInt());
        }
        try {
            return BlockPos.containing(WorldPerceptionTools.resolveOrigin(a, server, session).eye());
        } catch (RuntimeException e) {
            return null;
        }
    }

    // ---- locate --------------------------------------------------------------

    /**
     * Every argument {@code locate} understands. An argument outside this set is REFUSED, not
     * ignored (see {@link #rejectUnknownArgs}).
     */
    // `show` and `from` used to be listed here and are NOT locate's arguments — they belong to
    // `anchors`. So locate accepted them and silently ignored them, which is precisely the failure
    // this set exists to prevent, hiding inside the fix for it. Removed 2026-08-02; the schema
    // (which never had them) is the authority, and ArgCheck now enforces it for every tool.
    private static final Set<String> LOCATE_ARGS = Set.of(
        "what", "at", "pattern", "near", "radius", "y_range", "limit", "in", "occupancy", "as",
        "drone", "player", "dimension", "load");

    /** Misspellings worth answering by name rather than by list. `center` is here because two live
     *  survival sessions used it thirteen times between them (2026-08-02) and were never told. */
    private static final Map<String, String> LOCATE_ARG_HINTS = Map.of(
        "center", "near", "centre", "near", "pos", "at", "position", "at", "origin", "near",
        "range", "radius", "max", "limit", "count", "limit", "type", "what", "block", "what");

    /**
     * Refuse arguments this tool does not have.
     *
     * <p>Ignoring them is not neutral. Live, 2026-08-02: two survival sessions passed {@code center}
     * on thirteen {@code locate} calls; it is not an argument, so every search silently ran from the
     * BODY instead, and the reply's {@code center} field — the tool's own, honest, computed centre —
     * read back exactly like a confirmation of what had been asked. Both models kept doing it for
     * the whole session. It went unnoticed only because they happened to be passing their own
     * position; asking about a remote place would have returned a confident answer about somewhere
     * else entirely. That is the succeeds-falsely class (ARCHITECTURE §"Act verdicts are verified")
     * with an argument name as the vector.
     *
     * <p>Refusal is also the cheap fix: PATTERN_SEARCH §Findings 6 — error text is a routing
     * surface, and a correction delivered at the moment of the mistake beats description growth the
     * tool bill taxes every turn.
     */
    private static void rejectUnknownArgs(final JsonObject a) {
        List<String> unknown = new ArrayList<>();
        for (String key : a.keySet()) {
            if (!LOCATE_ARGS.contains(key)) {
                unknown.add(key);
            }
        }
        if (unknown.isEmpty()) {
            return;
        }
        java.util.Collections.sort(unknown);
        StringBuilder msg = new StringBuilder("locate has no argument ");
        for (int i = 0; i < unknown.size(); i++) {
            String k = unknown.get(i);
            msg.append(i > 0 ? ", " : "").append('`').append(k).append('`');
            String hint = LOCATE_ARG_HINTS.get(k.toLowerCase(java.util.Locale.ROOT));
            if (hint != null) {
                msg.append(" (did you mean `").append(hint).append("`?)");
            }
        }
        msg.append(". It was NOT applied — the call would have answered a different question than "
            + "the one you asked. Arguments: what | at | pattern (exactly one), near, radius, "
            + "y_range, limit, in, occupancy, as, show, from, drone, player, dimension.");
        throw new IllegalArgumentException(msg.toString());
    }

    private static JsonObject locate(final MinecraftServer server, final JsonObject a,
                                     final @Nullable String session) {
        rejectUnknownArgs(a);
        boolean hasWhat = a.has("what") && !a.get("what").isJsonNull();
        boolean hasAt = a.has("at") && a.get("at").isJsonArray() && !a.getAsJsonArray("at").isEmpty();
        boolean hasPattern = a.has("pattern") && a.get("pattern").isJsonObject();
        boolean hasIn = optStr(a, "in") != null;
        // The directions of one relation `at(thing, position)`: leave the position unknown and you
        // are searching (`what`, or `pattern` for a composite thing); leave the thing unknown and
        // you are identifying (`at`). Which ARGUMENT is given selects the direction — there is
        // deliberately no mode flag, the same way `what` resolves against the registries instead
        // of taking a kind: prefix. `in` alone is the same identify direction at REGION arity: the
        // thing is unknown and the position is a whole extent, so the answer is a description
        // rather than one id (0.32.0).
        if ((hasWhat ? 1 : 0) + (hasAt ? 1 : 0) + (hasPattern ? 1 : 0) != 1 && !(hasIn
                && !hasWhat && !hasAt && !hasPattern)) {
            throw new IllegalArgumentException(
                "give exactly one of `what` (search: thing -> positions), `at` (identify: "
                + "positions -> thing) or `pattern` (search: configuration -> positions) — or `in` "
                + "alone (describe: what a named region is MADE OF)");
        }
        if (hasIn && hasAt) {
            throw new IllegalArgumentException("`at` states its own positions — `in` scopes a "
                + "search (`what`/`pattern`) or, alone, describes a region");
        }
        ServerLevel level;
        @Nullable Vec3 obs;
        String obsLabel;
        // Whether the observer's HEIGHT came from somewhere real (an eye position, or a stated y)
        // rather than being filled in. Only the scan ranks in 3D, and only when this is true —
        // sorting by distance from a number nobody supplied is the defect that made every other
        // distance in this file horizontal.
        boolean yTrusted;
        if (a.has("near") && !a.get("near").isJsonNull()) {
            JsonObject n = a.getAsJsonObject("near");
            level = WorldPerceptionTools.levelArg(server, a);
            double x = n.get("x").getAsDouble();
            double z = n.get("z").getAsDouble();
            boolean hasY = n.has("y") && !n.get("y").isJsonNull();
            obs = new Vec3(x, hasY ? n.get("y").getAsDouble() : level.getSeaLevel(), z);
            obsLabel = hasY ? "coords" : "coords (y assumed: sea level)";
            yTrusted = hasY;
        } else {
            // The two directions need the observer differently: a SEARCH has to be centred somewhere,
            // but "what is at (x,y,z)" is answerable with no idea where you are — the observer only
            // supplies the optional `you` relation. Requiring one would have made `at` unusable on a
            // headless server (no player, no drone), which is exactly where the bench runs.
            WorldPerceptionTools.Origin o = null;
            try {
                o = WorldPerceptionTools.resolveOrigin(a, server, session);
            } catch (RuntimeException ex) {
                // `at` never needs an observer; a `pattern` over set nodes can derive its own
                // scan centre from the set (checked inside patternSearch — no sets, real error);
                // an `in` search is centred by the region, which is why it names one.
                if (!hasAt && !hasPattern && !hasIn) {
                    throw ex;
                }
            }
            level = o != null ? o.level() : WorldPerceptionTools.levelArg(server, a);
            obs = o != null ? o.eye() : null;
            obsLabel = o != null ? o.label() : "none (no observer — relations to `you` omitted)";
            yTrusted = o != null;
        }
        Ledger led = ledgerFor(session);
        // `occupancy` is a POI-index filter and nothing else. Accepting it silently anywhere else
        // would repeat A3's sin: `limit` was taken at the schema and dropped on the floor by the
        // structure route, so the caller believed a bound that never applied.
        if (hasAt || hasPattern) {
            occupancyRefused(a, hasAt ? "`at` (identify)" : "`pattern`");
        }
        @Nullable Box scope = hasIn ? resolveIn(led, level, a.get("in").getAsString()) : null;
        if (hasAt) {
            @Nullable Box extent = atExtent(a);
            return extent != null
                ? regionRead(server, level, a, extent, obs, obsLabel, led)
                : identifyAt(server, level, a, obs, obsLabel, led);
        }
        if (scope != null && !hasWhat && !hasPattern) {
            return regionRead(server, level, a, scope, obs, obsLabel, led);
        }
        if (hasPattern) {
            return patternSearch(server, level, a, scope, obs, obsLabel, yTrusted, led, session);
        }
        BlockPos center = scope != null ? scope.center() : BlockPos.containing(obs);
        String whatRaw = a.get("what").getAsString();
        Target target = parseTarget(level, whatRaw);
        if (target.kind() != Kind.POI) {
            occupancyRefused(a, "a " + target.kind().name().toLowerCase(java.util.Locale.ROOT)
                + " search");
        }
        // `in` scopes an ENUMERATING index (POIs, entities, the scan). The nearest-only mechanisms
        // cannot honour it: a structure or biome just outside the box can be nearer to its centre
        // than one inside, so filtering the single nearest result to the box would turn "there is
        // one, elsewhere" into "there is none here" — a manufactured negative. Refuse instead.
        if (scope != null && (target.kind() == Kind.STRUCTURE || target.kind() == Kind.BIOME)) {
            throw new IllegalArgumentException("`in` cannot scope a "
                + target.kind().name().toLowerCase(java.util.Locale.ROOT) + " search: that index "
                + "returns only the NEAREST match, so a match inside your region could be hidden "
                + "behind a nearer one outside it. Use `near`/`radius` and read the position, or "
                + "scope a POI/entity/block search instead.");
        }
        // A block id promotes to a one-node pattern scan: same question ("where is this thing"),
        // same unknown, answered by the direction that can actually answer it — with the scan's
        // own honesty contract (extent, caps, negative_is_proof) instead of an index's.
        if (target.kind() == Kind.BLOCK) {
            JsonObject synth = a.deepCopy();
            synth.remove("what");
            JsonObject node = new JsonObject();
            node.addProperty("id", "b");
            // The PARSED form, never whatRaw: a kind-prefixed `block:#minecraft:logs` must reach
            // the matcher as `#minecraft:logs` — the raw string fails its parse (live-caught: the
            // tool description's own example errored).
            node.addProperty("block", (target.tag() ? "#" : "") + target.id());
            JsonArray nodes = new JsonArray();
            nodes.add(node);
            JsonObject pattern = new JsonObject();
            pattern.add("nodes", nodes);
            synth.add("pattern", pattern);
            JsonObject r = patternSearch(server, level, synth, scope, obs, obsLabel, yTrusted,
                led, session);
            r.addProperty("what", whatRaw);
            r.getAsJsonObject("search").addProperty("promoted",
                "block id in `what` ran as a one-node pattern scan; add pattern relations to "
                + "search for a configuration, `as` to keep the results as a set");
            return r;
        }
        int limit = Math.max(1, Math.min(MAX_LIMIT, optInt(a, "limit", DEFAULT_LIMIT)));
        Ledger ledger = led;

        JsonObject r = new JsonObject();
        r.addProperty("what", a.get("what").getAsString());
        // Structure placement and the POI index are direct server-state queries; an entity radius
        // query is the usual X-ray spatial read. The label follows the mechanism, per ARCHITECTURE.
        WorldPerceptionTools.addEnvelope(r, level,
            target.kind() == Kind.ENTITY || target.kind() == Kind.CATEGORY ? "spatial" : "authoritative");
        r.addProperty("source", obsLabel);
        r.add("center", pos(center));

        if (scope != null) {
            int cap = target.kind() == Kind.POI ? POI_MAX_RADIUS : ENTITY_MAX_RADIUS;
            if (scope.coveringRadius() > cap) {
                throw new IllegalArgumentException("region spans " + (2 * scope.coveringRadius() + 1)
                    + " blocks horizontally, beyond this index's " + (2 * cap + 1)
                    + "-block reach — name a smaller region, or search it in parts");
            }
        }
        // Ranking needs an origin even when nobody is standing anywhere: an `in` search on a
        // headless server is centred by its region, so rank from the region's own centre.
        Vec3 rankFrom = obs != null ? obs : Vec3.atCenterOf(center);

        JsonObject search = new JsonObject();
        List<Hit> hits = switch (target.kind()) {
            case STRUCTURE -> findStructure(level, target, center, a, search);
            case POI -> findPoi(level, target, center, a, search, limit, scope);
            case BIOME -> findBiome(level, target, center, a, search);
            default -> findEntities(level, target, center, rankFrom, a, search, limit, session,
                scope);
        };
        search.addProperty("tick", level.getGameTime());
        search.addProperty("what", a.get("what").getAsString());
        search.add("center", pos(center));
        search.addProperty("found", hits.size());
        if (scope != null) {
            // The pattern route always recorded its scope on the search record; the `what` route
            // silently didn't — so a scoped negative could not SAY what box it was a negative
            // about (first-live-run red #3, LOCATE_ROUTES.md).
            search.addProperty("scope_region", scope.describe());
        }
        ledger.record(search.deepCopy());
        r.add("search", search);

        // Relations are computed against the ledger as it stands BEFORE this call's finds land, so
        // a find never relates to itself and a batch relates to the same reference frame.
        List<Anchor> refs = selectAnchors(ledger, level);
        JsonArray found = new JsonArray();
        String as = a.has("as") && !a.get("as").isJsonNull() ? a.get("as").getAsString() : null;
        for (int i = 0; i < hits.size(); i++) {
            Hit h = hits.get(i);
            String name = (i == 0 && as != null) ? as : h.shortName();
            String handle = name + "@" + h.pos().getX() + ","
                + (h.yKnown() ? String.valueOf(h.pos().getY()) : "~") + "," + h.pos().getZ();
            JsonObject o = new JsonObject();
            o.addProperty("handle", handle);
            o.addProperty("kind", h.kind());
            o.addProperty("id", h.id());
            o.add("pos", h.yKnown() ? pos(h.pos()) : posNoY(h.pos()));
            if (h.detail() != null) {
                o.addProperty("detail", h.detail());
            }
            o.add("relations", relations(h.pos(), h.yKnown(), obs, refs));
            found.add(o);
            ledger.add(new Anchor(handle, h.kind(), h.id(),
                level.dimension().identifier().toString(), h.uuid(), h.pos(), h.yKnown(),
                level.getGameTime()));
        }
        r.add("found", found);
        if (hits.isEmpty()) {
            r.addProperty("note", search.get("negative_is_proof").getAsBoolean()
                ? "Not found within the searched radius, and for this index that is a real negative "
                  + "(see search.negative_is_proof). Widen `radius` to search further."
                : "Nothing found — but this index cannot prove absence (see search.negative_is_proof "
                  + "and search.extent). Absence here is not evidence of absence.");
        }
        return r;
    }

    /**
     * Resolve `in:<name>` to an extent: a named region first, then a stored result set's bounding
     * box. Sets are included because a refinement chain wants to close — "scan for chests, then
     * describe the area they are in" — and the set already knows where its members are.
     */
    private static Box resolveIn(final Ledger ledger, final ServerLevel level, final String name) {
        String dim = level.dimension().identifier().toString();
        Region g = ledger.regions.get(name);
        if (g != null) {
            if (!g.dimension.equals(dim)) {
                throw new IllegalArgumentException("region '" + name + "' was named in "
                    + g.dimension + ", not " + dim + " — extents never cross dimensions");
            }
            return Box.of(g.min, g.max, "region '" + name + "' (" + g.describe() + ")");
        }
        ResultSet s = ledger.sets.get(name);
        if (s != null) {
            if (!s.dimension.equals(dim)) {
                throw new IllegalArgumentException("set '" + name + "' was recorded in "
                    + s.dimension + ", not " + dim + " — extents never cross dimensions");
            }
            if (s.members.isEmpty()) {
                throw new IllegalArgumentException("set '" + name + "' has no members, so it "
                    + "bounds no region");
            }
            int x0 = Integer.MAX_VALUE, y0 = Integer.MAX_VALUE, z0 = Integer.MAX_VALUE;
            int x1 = Integer.MIN_VALUE, y1 = Integer.MIN_VALUE, z1 = Integer.MIN_VALUE;
            for (BlockPos m : s.members) {
                x0 = Math.min(x0, m.getX());
                y0 = Math.min(y0, m.getY());
                z0 = Math.min(z0, m.getZ());
                x1 = Math.max(x1, m.getX());
                y1 = Math.max(y1, m.getY());
                z1 = Math.max(z1, m.getZ());
            }
            return new Box(x0, y0, z0, x1, y1, z1, "bounding box of set '" + name + "' ("
                + s.members.size() + " members)");
        }
        String known = String.join(", ", ledger.regions.keySet());
        String knownSets = String.join(", ", ledger.sets.keySet());
        throw new IllegalArgumentException("no region or set named '" + name + "'"
            + (known.isEmpty() ? " — name one with `at` + an extent + `as`" : " — regions: " + known)
            + (knownSets.isEmpty() ? "" : "; sets: " + knownSets));
    }

    /**
     * The extent an `at` entry states, or null when every entry is a bare position.
     *
     * <p>{@code dx/dy/dz} are ADDITIONAL blocks along each axis (vanilla's selector convention), so
     * {@code dx:0} is one block and a negative extends the other way. Mixing an extent with other
     * positions is refused: a box and a point list are different result shapes, and one call cannot
     * honestly be both.
     */
    private static @Nullable Box atExtent(final JsonObject a) {
        JsonArray at = a.getAsJsonArray("at");
        int withExtent = 0;
        JsonObject carrier = null;
        for (var e : at) {
            JsonObject o = e.getAsJsonObject();
            if (o.has("dx") || o.has("dy") || o.has("dz")) {
                withExtent++;
                carrier = o;
            }
        }
        if (withExtent == 0) {
            return null;
        }
        if (withExtent > 1 || at.size() > 1) {
            throw new IllegalArgumentException("an `at` entry with dx/dy/dz reads a whole extent, "
                + "so it must be the only entry — a box and a list of positions are different "
                + "answers (a description vs palette rows)");
        }
        int x = carrier.get("x").getAsInt();
        int y = carrier.get("y").getAsInt();
        int z = carrier.get("z").getAsInt();
        int dx = optInt(carrier, "dx", 0);
        int dy = optInt(carrier, "dy", 0);
        int dz = optInt(carrier, "dz", 0);
        if (carrier.has("expect") || carrier.has("clear")) {
            throw new IllegalArgumentException("`expect`/`clear` test ONE cell each — they cannot "
                + "ride an extent. Use check_site's box door for a whole-volume clear verdict, or "
                + "a `pattern` scan to find the cells that match.");
        }
        Box box = Box.of(new BlockPos(x, y, z), new BlockPos(x + dx, y + dy, z + dz), "at extent");
        if (box.volume() == 1) {
            return null; // dx=dy=dz=0 is just a position; let the referent path have it
        }
        return box;
    }

    /**
     * `at` with an extent, and `in:<region>` alone: the REGION arity of "what is at this position"
     * (LOCATE_ROUTES.md D3 / the r11 finding in TOOL_BILL_PLAN §6c, where the swap agent reached for
     * `locate at` on a volume question and had to sample points).
     *
     * <p><b>Shape decides representation, and neither shape is a grid.</b> A LINE (one axis extends)
     * enumerates exactly, as run-length runs along that axis — a column is the one shape whose
     * contents stay a lookup rather than character arithmetic. A BOX (two or more axes) is
     * DESCRIBED, never dumped: the most reproduced defect on this bench was models recovering the
     * wrong cell from a rendered volume (PATTERN_SEARCH_DESIGN §Findings 3), so the region arity
     * hands back a material census — counts, bounds, a y-profile — which is the half that was
     * load-bearing anyway.
     */
    private static JsonObject regionRead(final MinecraftServer server, final ServerLevel level,
                                         final JsonObject a, final Box box,
                                         final @Nullable Vec3 obs, final String obsLabel,
                                         final Ledger ledger) {
        int axes = (box.x1() > box.x0() ? 1 : 0) + (box.y1() > box.y0() ? 1 : 0)
            + (box.z1() > box.z0() ? 1 : 0);
        JsonObject r = axes <= 1 ? lineRead(level, a, box) : boxCensus(server, level, a, box);
        r.addProperty("source", obsLabel);
        r.addProperty("direction", axes <= 1 ? "identify (line)" : "describe (region)");
        JsonObject region = new JsonObject();
        region.addProperty("box", box.describe());
        region.addProperty("from", box.source());
        region.addProperty("volume", box.volume());
        r.add("region", region);
        // A region is a referent like any other find: it relates to you and to your anchors from its
        // centre, so "the room" can be talked about afterwards.
        r.add("relations", relations(box.center(), true, obs, selectAnchors(ledger, level)));
        String as = optStr(a, "as");
        if (as != null) {
            ledger.addRegion(new Region(as, level.dimension().identifier().toString(),
                box.min(), box.max(), level.getGameTime()));
            r.addProperty("named", as);
            r.addProperty("note", "Region '" + as + "' is now a referent: pass `in`:\"" + as
                + "\" to scope a later `what`/`pattern` search to it, or `in` alone to describe it "
                + "again. It stores CORNERS ONLY — every use re-reads the world.");
        }
        return r;
    }

    /** A single-axis extent, run-length encoded — the model-safe way to hand back exact contents. */
    private static JsonObject lineRead(final ServerLevel level, final JsonObject a, final Box box) {
        long len = box.volume();
        if (len > AT_LINE_MAX) {
            throw new IllegalArgumentException("line of " + len + " blocks exceeds the cap of "
                + AT_LINE_MAX + " — shorten it, or give the other axes an extent so it is described "
                + "as a volume instead of listed");
        }
        ReadSupport.ChunkLoader loader = new ReadSupport.ChunkLoader(level, ReadSupport.loadArg(a));
        JsonArray runs = new JsonArray();
        int axis = box.x1() > box.x0() ? 0 : box.z1() > box.z0() ? 2 : 1;
        int unread = 0;
        String current = null;
        int runStart = 0;
        int i = 0;
        BlockPos.MutableBlockPos p = new BlockPos.MutableBlockPos();
        for (int v = axisMin(box, axis); v <= axisMax(box, axis); v++, i++) {
            p.set(axis == 0 ? v : box.x0(), axis == 1 ? v : box.y0(), axis == 2 ? v : box.z0());
            String id;
            if (!loader.ensure(p)) {
                unread++;
                id = null; // never a guess: an unread cell is its own run value
            } else {
                id = BuiltInRegistries.BLOCK.getKey(level.getBlockState(p).getBlock()).toString();
            }
            boolean same = current == null ? id == null : current.equals(id);
            if (i > 0 && same) {
                continue;
            }
            if (i > 0) {
                runs.add(run(runStart, v - 1, current));
            }
            current = id;
            runStart = v;
        }
        if (i > 0) {
            runs.add(run(runStart, axisMax(box, axis), current));
        }

        JsonObject r = new JsonObject();
        WorldPerceptionTools.addEnvelope(r, level, "spatial");
        r.addProperty("axis", axis == 0 ? "x" : axis == 1 ? "y" : "z");
        r.add("runs", runs);
        r.addProperty("runs_note", "[from, to, block] along that axis, inclusive; block null = the "
            + "cell could not be read (never a guess). Consecutive equal cells are ONE run, so a "
            + "column costs its layers, not its height.");
        r.addProperty("cells", len);
        if (unread > 0) {
            r.addProperty("unread_cells", unread);
            r.addProperty("unread_cause", loader.shortfallReason());
        }
        return r;
    }

    private static JsonArray run(final int from, final int to, final @Nullable String id) {
        JsonArray a = new JsonArray();
        a.add(from);
        a.add(to);
        if (id == null) {
            a.add((String) null);
        } else {
            a.add(id);
        }
        return a;
    }

    private static int axisMin(final Box b, final int axis) {
        return axis == 0 ? b.x0() : axis == 1 ? b.y0() : b.z0();
    }

    private static int axisMax(final Box b, final int axis) {
        return axis == 0 ? b.x1() : axis == 1 ? b.y1() : b.z1();
    }

    /**
     * The census: what a volume is MADE OF. Delegated to {@code describe_box}'s implementation so
     * "what is in this volume" keeps exactly one definition — the same discipline that makes
     * {@code at} delegate its cell reads to {@code get_blocks_at}. The {@code layers} view is
     * deliberately NOT offered here: it is the one output with a measured extraction hazard, and
     * this direction exists to hand back a description instead of a rendering.
     */
    private static JsonObject boxCensus(final MinecraftServer server, final ServerLevel level,
                                        final JsonObject a, final Box box) {
        JsonObject sub = new JsonObject();
        sub.add("min", pos(box.min()));
        sub.add("max", pos(box.max()));
        sub.addProperty("dimension", level.dimension().identifier().toString());
        if (a.has("load")) {
            sub.add("load", a.get("load"));
        }
        return WorldPerceptionTools.scanBox(server, sub);
    }

    /**
     * The DOWN direction of the same relation: positions in, identity out.
     *
     * <p>The cell read itself is delegated to {@link WorldPerceptionTools#getBlocksAt} so palette
     * syntax, {@code expect} semantics, the −1 not-read convention and the coverage contract keep
     * exactly one definition. What this adds is the reason {@code locate} exists: <b>one</b> position
     * is a REFERENT — it gets a handle, relations to your anchors, and joins the ledger — while a
     * LIST stays a reading (palette + rows), because a 64-position batch verification is not 64
     * landmarks and must not dump 64 anchors into the ledger.
     */
    private static JsonObject identifyAt(final MinecraftServer server, final ServerLevel level,
                                         final JsonObject a, final @Nullable Vec3 obs,
                                         final String obsLabel, final Ledger ledger) {
        JsonArray at = a.getAsJsonArray("at");
        if (at.size() > AT_MAX) {
            throw new IllegalArgumentException("too many positions (" + at.size() + " > " + AT_MAX
                + ") — split the call, or use describe_box for a contiguous volume");
        }
        JsonObject sub = new JsonObject();
        sub.add("blocks", at);
        // Pin the dimension the origin resolved to, so an `at` read from a body in the Nether cannot
        // silently answer with overworld blocks.
        sub.addProperty("dimension", level.dimension().identifier().toString());
        if (a.has("load")) {
            sub.add("load", a.get("load"));
        }
        JsonObject r = WorldPerceptionTools.getBlocksAt(server, sub);
        r.addProperty("source", obsLabel);
        r.addProperty("direction", "identify");

        if (at.size() != 1) {
            r.addProperty("note", at.size() + " positions read as a batch: palette + rows, no "
                + "referents created. Call with a single `at` entry to get a handle and relations "
                + "for a position you intend to refer to again.");
            return r;
        }

        JsonObject e0 = at.get(0).getAsJsonObject();
        BlockPos pos = new BlockPos(e0.get("x").getAsInt(), e0.get("y").getAsInt(), e0.get("z").getAsInt());
        JsonArray row = r.getAsJsonArray("blocks").get(0).getAsJsonArray();
        int idx = row.get(3).getAsInt();
        if (idx < 0) {
            // Unread stays unread: no handle, no anchor, no relation to something we never saw.
            r.addProperty("note", "position could not be read — no referent created (see coverage).");
            return r;
        }
        String desc = r.getAsJsonArray("palette").get(idx).getAsString();
        String id = desc.contains("[") ? desc.substring(0, desc.indexOf('[')) : desc;
        String shortName = id.contains(":") ? id.substring(id.indexOf(':') + 1) : id;
        String as = a.has("as") && !a.get("as").isJsonNull() ? a.get("as").getAsString() : null;
        String handle = (as != null ? as : shortName)
            + "@" + pos.getX() + "," + pos.getY() + "," + pos.getZ();

        JsonObject found = new JsonObject();
        found.addProperty("handle", handle);
        found.addProperty("kind", "block");
        found.addProperty("id", id);
        found.add("pos", pos(pos));
        // "What is here" includes anything standing here — a block id alone answers half the question.
        JsonArray occupants = new JsonArray();
        for (Entity ent : level.getEntities((Entity) null, new AABB(pos), Entity::isAlive)) {
            JsonObject o = new JsonObject();
            o.addProperty("type", BuiltInRegistries.ENTITY_TYPE.getKey(ent.getType()).toString());
            o.addProperty("id", ent.getId());
            occupants.add(o);
        }
        if (!occupants.isEmpty()) {
            found.add("occupants", occupants);
        }
        found.add("relations", relations(pos, true, obs, selectAnchors(ledger, level)));
        r.add("found", found);
        ledger.add(new Anchor(handle, "block", id, level.dimension().identifier().toString(),
            null, pos, true, level.getGameTime()));
        return r;
    }

    /** An axis-aligned extent, resolved from `at` extents, an `in:` region, or a set's bounds. */
    private record Box(int x0, int y0, int z0, int x1, int y1, int z1, String source) {
        static Box of(final BlockPos a, final BlockPos b, final String source) {
            return new Box(Math.min(a.getX(), b.getX()), Math.min(a.getY(), b.getY()),
                Math.min(a.getZ(), b.getZ()), Math.max(a.getX(), b.getX()),
                Math.max(a.getY(), b.getY()), Math.max(a.getZ(), b.getZ()), source);
        }

        BlockPos min() {
            return new BlockPos(x0, y0, z0);
        }

        BlockPos max() {
            return new BlockPos(x1, y1, z1);
        }

        BlockPos center() {
            return new BlockPos((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
        }

        boolean containsXZ(final int x, final int z) {
            return x >= x0 && x <= x1 && z >= z0 && z <= z1;
        }

        boolean contains(final BlockPos p) {
            return containsXZ(p.getX(), p.getZ()) && p.getY() >= y0 && p.getY() <= y1;
        }

        /** Half-width of the smallest centred square covering this box — the radius index routes take. */
        int coveringRadius() {
            BlockPos c = center();
            return Math.max(Math.max(c.getX() - x0, x1 - c.getX()),
                Math.max(c.getZ() - z0, z1 - c.getZ()));
        }

        long volume() {
            return (long) (x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1);
        }

        String describe() {
            return x0 + "," + y0 + "," + z0 + " .. " + x1 + "," + y1 + "," + z1;
        }
    }

    /** One search result before it becomes an anchor. {@code uuid} non-null ⇒ volatile (an entity). */
    private record Hit(String kind, String id, BlockPos pos, boolean yKnown,
                       @Nullable UUID uuid, @Nullable String detail) {
        String shortName() {
            int slash = id.indexOf(':');
            return slash < 0 ? id : id.substring(slash + 1);
        }
    }

    private static List<Hit> findStructure(final ServerLevel level, final Target t, final BlockPos center,
                                           final JsonObject a, final JsonObject search) {
        Registry<Structure> reg = level.registryAccess().lookupOrThrow(Registries.STRUCTURE);
        HolderSet<Structure> set;
        if (t.tag()) {
            set = reg.get(TagKey.create(Registries.STRUCTURE, t.id()))
                .orElseThrow(() -> new IllegalArgumentException("unknown structure tag: #" + t.id()));
        } else {
            set = HolderSet.direct(reg.get(t.id())
                .orElseThrow(() -> new IllegalArgumentException("unknown structure: " + t.id())));
        }
        int radius = clampRadius(a, STRUCTURE_DEFAULT_RADIUS, STRUCTURE_MAX_RADIUS);
        int chunkRadius = Math.max(1, radius / 16);
        boolean structuresOn = level.getServer().getWorldGenSettings().options().generateStructures();

        long t0 = System.nanoTime();
        Pair<BlockPos, Holder<Structure>> nearest = structuresOn
            ? level.getChunkSource().getGenerator()
                .findNearestMapStructure(level, set, center, chunkRadius, false)
            : null;
        long ms = (System.nanoTime() - t0) / 1_000_000L;

        search.addProperty("mechanism", "structure_placement");
        search.addProperty("radius", radius);
        search.addProperty("ms", ms);
        // Placement is computed from the seed, so within the searched radius a miss is a fact, not
        // an unread. The one exception is a world generated without structures at all.
        search.addProperty("negative_is_proof", structuresOn);
        search.addProperty("extent", "worldgen placement within " + chunkRadius + " chunks of centre"
            + (structuresOn ? "" : " — DISABLED: this world generates no structures"));
        search.addProperty("note", "Nearest match only, and the result is a COLUMN — placement "
            + "resolves x/z, never a height, so `pos.y` is null. Chunks are taken no further than "
            + "STRUCTURE_STARTS and no structure reference is created (the /locate path); terrain "
            + "is never generated. COST: this runs on the server thread and is not cheap — measured "
            + "845ms for a 100-chunk radius on the dev world, the same order as generating a virgin "
            + "chunk. `ms` is this call's real cost; narrow `radius` when you can. To turn the "
            + "column into a usable position, check_site at:{x,z} size:{w:1,d:1} reports the "
            + "ground height there.");

        if (nearest == null) {
            return List.of();
        }
        String id = nearest.getSecond().unwrapKey()
            .map(k -> k.identifier().toString()).orElse(t.id().toString());
        // Placement search resolves a COLUMN, not a height: the returned BlockPos has y = 0, which
        // is not where the structure is. Reporting it as a coordinate would be a confident
        // falsehood, so the y travels as unknown (`~`) and dy is suppressed against it.
        return List.of(new Hit("structure", id, nearest.getFirst(), false, null, null));
    }

    private static List<Hit> findPoi(final ServerLevel level, final Target t, final BlockPos center,
                                     final JsonObject a, final JsonObject search, final int limit,
                                     final @Nullable Box scope) {
        int radius = scope != null ? scope.coveringRadius()
            : clampRadius(a, POI_DEFAULT_RADIUS, POI_MAX_RADIUS);
        Predicate<Holder<PoiType>> pred = t.tag()
            ? h -> h.is(TagKey.create(Registries.POINT_OF_INTEREST_TYPE, t.id()))
            : h -> h.unwrapKey().map(k -> k.identifier().equals(t.id())).orElse(false);
        PoiManager.Occupancy occupancy = occupancyArg(a);

        // getInSquare filters HORIZONTALLY; findAllClosestFirstWithType would go through getInRange,
        // whose 3D radius test silently excludes anything far above or below the centre — and the
        // centre's y is an assumption whenever `near` omits it. A locate radius is a map radius.
        long t0 = System.nanoTime();
        List<net.minecraft.world.entity.ai.village.poi.PoiRecord> raw = level.getPoiManager()
            .getInSquare(pred, center, radius, occupancy)
            // Clipped BEFORE the limit: filtering afterwards would let sites outside the region
            // eat the result slots and under-report what is actually inside it.
            .filter(rec -> scope == null || scope.contains(rec.getPos()))
            .sorted(Comparator.comparingDouble(rec -> horizSqr(rec.getPos(), center)))
            .limit(limit)
            .toList();
        long ms = (System.nanoTime() - t0) / 1_000_000L;

        search.addProperty("mechanism", "poi_index");
        search.addProperty("radius", radius);
        search.addProperty("ms", ms);
        search.addProperty("occupancy", occupancyLabel(occupancy));
        search.addProperty("vertical_extent", "full world height");
        // The POI index only holds sections for chunks that have been generated and had their POIs
        // scanned. Never-generated terrain simply has no entry, which is indistinguishable here from
        // "generated, nothing there" — so a miss is not a proof and must not be sold as one.
        search.addProperty("negative_is_proof", false);
        search.addProperty("extent", (scope != null
                ? "saved POI sections inside " + scope.source()
                : "saved POI sections within " + radius + " blocks of centre")
            + (occupancy == PoiManager.Occupancy.ANY ? ""
               : ", " + occupancyLabel(occupancy) + " sites only"));
        search.addProperty("note", "The POI index covers only chunks that have been generated; "
            + "never-visited terrain has no entry at all, so a miss here cannot distinguish "
            + "'nothing there' from 'never generated'."
            + (occupancy == PoiManager.Occupancy.ANY ? ""
               : " This search was FILTERED by occupancy, so a miss means 'none in that state' — "
                 + "not 'none at all'; drop `occupancy` to ask the wider question. Two traps: POI "
                 + "types with NO tickets at all (nether_portal, lodestone, beehive, bee_nest) are "
                 + "unclaimable and so match NEITHER free nor claimed — always ask for those "
                 + "unfiltered; and claim state is villager bookkeeping, not a block property, so "
                 + "it goes stale if the villager holding a ticket died away from the site."));

        List<Hit> hits = new ArrayList<>();
        for (var rec : raw) {
            String id = rec.getPoiType().unwrapKey().map(k -> k.identifier().toString())
                .orElse(t.id() == null ? "?" : t.id().toString());
            hits.add(new Hit("poi", id, rec.getPos(), true, null, tickets(rec)));
        }
        return hits;
    }

    /**
     * The claim state of a POI, as free/total tickets (LOCATE_ROUTES.md A2). This rides every POI
     * hit because it is the actual village-capacity answer — the {@code occupancy} filter only
     * decides which sites come back, while "1 of 1 free" says what to do about it.
     *
     * <p>Reported as counts rather than a free/occupied word because vanilla's two predicates are
     * not complements: {@code hasSpace} is "a ticket is left" and {@code isOccupied} is "a ticket
     * has been taken", so a 32-ticket meeting point with one villager on it is BOTH. Collapsing
     * that into "occupied" would be a confident falsehood about whether another villager fits.
     *
     * <p>{@code getFreeTickets} is {@code @Deprecated @VisibleForDebug} upstream — deliberately
     * used anyway, because the alternative is the two booleans, and they cannot say <em>how many</em>
     * villagers still fit. If a future MC drops the accessor, fall back to {@code hasSpace}/
     * {@code isOccupied} and report the pair rather than inventing counts.
     */
    @SuppressWarnings("deprecation")
    private static String tickets(final net.minecraft.world.entity.ai.village.poi.PoiRecord rec) {
        int free = rec.getFreeTickets();
        int max = rec.getPoiType().value().maxTickets();
        if (max == 0) {
            // Portals, lodestones, hives: nothing can claim them, so "0 of 0 free" would read as
            // full and "unclaimed" would read as available. Neither is true — say what is.
            return "no tickets (this POI type is not claimable)";
        }
        return "tickets " + free + " of " + max + " free"
            + (free == max ? " (unclaimed)" : free == 0 ? " (full)" : " (partly claimed)");
    }

    /**
     * `occupancy` -> vanilla's {@link PoiManager.Occupancy}. Named for what a survey asks — is a
     * bed free, is this job site taken — rather than for the enum, and deliberately not defaulted
     * to a filter: the unfiltered question is the one whose miss means the most.
     */
    private static PoiManager.Occupancy occupancyArg(final JsonObject a) {
        String s = optStr(a, "occupancy");
        if (s == null) {
            return PoiManager.Occupancy.ANY;
        }
        return switch (s.trim().toLowerCase(java.util.Locale.ROOT)) {
            case "any" -> PoiManager.Occupancy.ANY;
            case "free" -> PoiManager.Occupancy.HAS_SPACE;
            case "claimed" -> PoiManager.Occupancy.IS_OCCUPIED;
            default -> throw new IllegalArgumentException("occupancy must be any|free|claimed "
                + "(got '" + s + "'): free = a ticket is still available (a bed nobody has claimed), "
                + "claimed = at least one ticket has been taken");
        };
    }

    /** Refuse `occupancy` where no index can honour it, naming the direction that was actually run. */
    private static void occupancyRefused(final JsonObject a, final String direction) {
        if (optStr(a, "occupancy") != null) {
            throw new IllegalArgumentException("`occupancy` filters the POI index only — this was "
                + direction + ". Claim state exists for POI types (beds, job sites, meeting points); "
                + "blocks and entities have none.");
        }
    }

    private static String occupancyLabel(final PoiManager.Occupancy o) {
        return switch (o) {
            case HAS_SPACE -> "free";
            case IS_OCCUPIED -> "claimed";
            case ANY -> "any";
        };
    }

    /**
     * The biome route (LOCATE_ROUTES.md A1) — vanilla's own {@code /locate biome} mechanism.
     *
     * <p>Cheap in the way that matters: the climate sampler computes biomes from the seed and reads
     * no chunks, so this answers at coordinates nobody has ever visited. It is expensive in the way
     * a spiral search is — cost scales with radius² and is reported as {@code ms}.
     *
     * <p><b>The negative here is a different animal</b>, and the payload says so rather than
     * flattening it into the structure route's true/false. Two failure modes hide behind "not
     * found": the biome cannot occur in this dimension at all (the generator's own
     * {@code possibleBiomes} has no match — categorical, so a real proof at any radius), or it was
     * not sampled (sampling is every 32 blocks horizontally / 64 vertically, vanilla's own
     * resolution, so a small patch can be stepped over — a resolution limit, NOT an unread-chunk
     * one, which means widening the radius does not make the miss more conclusive).
     */
    private static List<Hit> findBiome(final ServerLevel level, final Target t, final BlockPos center,
                                       final JsonObject a, final JsonObject search) {
        Registry<Biome> reg = level.registryAccess().lookupOrThrow(Registries.BIOME);
        Predicate<Holder<Biome>> pred;
        if (t.tag()) {
            TagKey<Biome> key = TagKey.create(Registries.BIOME, t.id());
            if (reg.get(key).isEmpty()) {
                throw new IllegalArgumentException("unknown biome tag: #" + t.id());
            }
            pred = h -> h.is(key);
        } else {
            if (reg.get(t.id()).isEmpty()) {
                throw new IllegalArgumentException("unknown biome: " + t.id());
            }
            pred = h -> h.unwrapKey().map(k -> k.identifier().equals(t.id())).orElse(false);
        }
        int radius = clampRadius(a, BIOME_DEFAULT_RADIUS, BIOME_MAX_RADIUS);
        boolean possible = level.getChunkSource().getGenerator().getBiomeSource().possibleBiomes()
            .stream().anyMatch(pred);

        long t0 = System.nanoTime();
        Pair<BlockPos, Holder<Biome>> nearest = possible
            ? level.findClosestBiome3d(pred, center, radius, BIOME_SAMPLE_H, BIOME_SAMPLE_V)
            : null;
        long ms = (System.nanoTime() - t0) / 1_000_000L;

        search.addProperty("mechanism", "biome_climate_sampler");
        search.addProperty("radius", radius);
        search.addProperty("ms", ms);
        search.addProperty("vertical_extent", "sampled every " + BIOME_SAMPLE_V
            + " blocks of height, outward from the centre's y");
        search.addProperty("negative_is_proof", !possible);
        search.addProperty("extent", possible
            ? "climate samples every " + BIOME_SAMPLE_H + " blocks horizontally within " + radius
              + " blocks of centre"
            : "this dimension's generator cannot produce that biome at all (it is not in its "
              + "biome list)");
        search.addProperty("note", possible
            ? "Nearest match only. The sampler is computed from the seed and reads no chunks, so a "
              + "miss is not an unread-terrain problem — it is a RESOLUTION one: samples are every "
              + BIOME_SAMPLE_H + " blocks horizontally and " + BIOME_SAMPLE_V + " vertically, so a "
              + "patch smaller than that can be stepped over. Widening `radius` searches further; "
              + "it does not make a miss more conclusive, and it costs (see `ms`)."
            : "DEFINITIVE: this dimension's generator has no such biome in its list, so it occurs "
              + "nowhere here, at any radius.");

        if (nearest == null) {
            return List.of();
        }
        String id = nearest.getSecond().unwrapKey()
            .map(k -> k.identifier().toString()).orElse(t.id().toString());
        return List.of(new Hit("biome", id, nearest.getFirst(), true, null,
            "pos is the climate sample cell that matched, not a surface height — check_site "
            + "at:{x,z} size:{w:1,d:1} gives the ground there"));
    }

    private static List<Hit> findEntities(final ServerLevel level, final Target t, final BlockPos center,
                                          final Vec3 obs, final JsonObject a, final JsonObject search,
                                          final int limit, final @Nullable String session,
                                          final @Nullable Box scope) {
        int radius = scope != null ? scope.coveringRadius()
            : clampRadius(a, ENTITY_DEFAULT_RADIUS, ENTITY_MAX_RADIUS);
        Entity self = com.mattmc.mcptoolkit.drone.DroneTools.activeBodyFor(session);
        Predicate<Entity> match = entityMatcher(t);
        // Horizontal radius, FULL world height. An inflated cube would bound the search vertically
        // around a centre y that is an assumption whenever `near` omits it — and a locate radius is
        // a map radius: "nearest zombie" never means "within 48 blocks of sea level".
        // A region search is a BOX search, heights included — that is what naming a room means.
        AABB box = scope != null
            ? new AABB(scope.x0(), scope.y0(), scope.z0(),
                scope.x1() + 1.0, scope.y1() + 1.0, scope.z1() + 1.0)
            : new AABB(
                center.getX() - radius, level.getMinY(), center.getZ() - radius,
                center.getX() + radius + 1.0, level.getMaxY() + 1.0, center.getZ() + radius + 1.0);

        long t0 = System.nanoTime();
        List<Entity> raw = level.getEntities((Entity) null, box,
            e -> e != self && e.isAlive() && match.test(e));
        long ms = (System.nanoTime() - t0) / 1_000_000L;
        // Ranked horizontally for the same reason: a 3D sort against an assumed observer y would
        // order finds by how far they are from a number nobody supplied.
        raw.sort(Comparator.comparingDouble(e -> {
            double dx = e.getX() - obs.x;
            double dz = e.getZ() - obs.z;
            return dx * dx + dz * dz;
        }));

        // Coverage counts chunks by ENTITY-data residency, post-stage: the registration wrapper
        // pre-staged this rect (paged absent chunks + waited the tick their entity data needs —
        // the same mechanism as get_entities, 0.21.0), so what stays unsearchable has a specific
        // cause: never-generated terrain, the paging budget, load:false, or data still in flight
        // at the stage deadline (that one wants a re-query, not a forceload).
        int chunkRadius = radius / 16 + 1;
        int cx = center.getX() >> 4;
        int cz = center.getZ() >> 4;
        int resident = 0;
        int absent = 0;
        for (int x = cx - chunkRadius; x <= cx + chunkRadius; x++) {
            for (int z = cz - chunkRadius; z <= cz + chunkRadius; z++) {
                if (level.areEntitiesLoaded(net.minecraft.world.level.ChunkPos.pack(x, z))) {
                    resident++;
                } else {
                    absent++;
                }
            }
        }
        search.addProperty("mechanism", "entity_sections");
        search.addProperty("radius", radius);
        search.addProperty("ms", ms);
        search.addProperty("vertical_extent", scope != null
            ? "y " + scope.y0() + ".." + scope.y1() + " (the region's own heights)"
            : "full world height");
        search.addProperty("negative_is_proof", absent == 0);
        search.addProperty("extent", resident + " of " + (resident + absent)
            + " chunks in radius entity-searched"
            + (scope != null ? ", results confined to " + scope.source()
               : " at every height") + " (absent ones were staged in first)");
        if (absent > 0) {
            search.addProperty("note", absent + " chunk(s) stayed entity-unsearchable after "
                + "staging (never-generated terrain, paging budget, load:false, or entity data "
                + "still arriving — the last wants a re-query). Entities there are invisible to "
                + "this search.");
        }

        List<Hit> hits = new ArrayList<>();
        for (Entity e : raw) {
            if (hits.size() >= limit) {
                break;
            }
            String id = BuiltInRegistries.ENTITY_TYPE.getKey(e.getType()).toString();
            // A paged-but-not-ticking chunk holds entities frozen at their as-saved state; without
            // the flag a frozen mob reads exactly like a live one.
            String detail = level.isPositionEntityTicking(e.blockPosition()) ? null : "ticking:false";
            hits.add(new Hit("entity", id, e.blockPosition(), true, e.getUUID(), detail));
        }
        return hits;
    }

    private static Predicate<Entity> entityMatcher(final Target t) {
        if (t.kind() == Kind.CATEGORY) {
            return switch (t.category()) {
                case "hostile" -> e -> e instanceof Enemy;
                case "living" -> e -> e instanceof LivingEntity;
                case "item" -> e -> e instanceof ItemEntity;
                default -> e -> e instanceof Player;
            };
        }
        if (t.tag()) {
            TagKey<net.minecraft.world.entity.EntityType<?>> tag =
                TagKey.create(Registries.ENTITY_TYPE, t.id());
            return e -> e.getType().builtInRegistryHolder().is(tag);
        }
        String want = t.id().toString();
        return e -> BuiltInRegistries.ENTITY_TYPE.getKey(e.getType()).toString().equals(want);
    }

    // ---- pattern search (PATTERN_SEARCH_DESIGN.md) ---------------------------

    /**
     * Non-geometric cell properties a node can require (LOCATE_ROUTES.md B5). The pattern language
     * could already say <em>where</em> blocks are relative to each other and could not say anything
     * about light — which is the whole spawn-proofing task class, plus "is this room lit" and
     * "which columns see the sky".
     *
     * <p>These are enumeration-time gates, not post-filters: they run in the same visitor as the
     * block matcher, before a cell becomes a candidate. That matters for cost — spawnable cells are
     * rare in a lit base, so the node candidate cap counts only cells that actually passed, and the
     * expensive thing (materialising every air cell) never happens.
     *
     * <p><b>{@code spawnable} over-reports on purpose.</b> It is vanilla's own deterministic spawn
     * <em>position</em> rule ({@code SpawnPlacements.isSpawnPositionOk} for an ON_GROUND hostile:
     * valid spawn surface below, this cell and the one above both valid-empty) plus the dimension's
     * {@code monsterSpawnBlockLightLimit}. The rest of the real spawn decision is randomised per
     * attempt ({@code Monster.isDarkEnoughToSpawn} samples the light test), or depends on biome mob
     * lists, difficulty, caps and per-mob rules. A boolean cannot honestly claim "a mob WILL spawn
     * here", so this claims the direction that is sound: a match is a <em>candidate</em>, and a
     * clean miss over a fully-read extent is real spawn-proofing.
     */
    private static final class CellPred {
        final @Nullable Integer lightMin;
        final @Nullable Integer lightMax;
        final @Nullable Integer skyMin;
        final @Nullable Integer skyMax;
        final @Nullable Boolean seesSky;
        final @Nullable Boolean spawnable;

        CellPred(final @Nullable Integer lightMin, final @Nullable Integer lightMax,
                 final @Nullable Integer skyMin, final @Nullable Integer skyMax,
                 final @Nullable Boolean seesSky, final @Nullable Boolean spawnable) {
            this.lightMin = lightMin;
            this.lightMax = lightMax;
            this.skyMin = skyMin;
            this.skyMax = skyMax;
            this.seesSky = seesSky;
            this.spawnable = spawnable;
        }

        /**
         * Does this predicate read the light engine? {@code sees_sky} deliberately does not — it is
         * a heightmap question, correct as soon as a chunk is at FULL, while a light level read out
         * of a chunk whose lighting has not been computed reports 0 (i.e. "dark", i.e. a spawnable
         * false positive). Cells in such chunks are skipped and counted instead.
         */
        boolean needsLight() {
            return lightMin != null || lightMax != null || skyMin != null || skyMax != null
                || spawnable != null;
        }

        boolean test(final ServerLevel level, final BlockPos pos) {
            if (lightMin != null || lightMax != null) {
                int b = level.getBrightness(net.minecraft.world.level.LightLayer.BLOCK, pos);
                if (lightMin != null && b < lightMin || lightMax != null && b > lightMax) {
                    return false;
                }
            }
            if (skyMin != null || skyMax != null) {
                int s = level.getBrightness(net.minecraft.world.level.LightLayer.SKY, pos);
                if (skyMin != null && s < skyMin || skyMax != null && s > skyMax) {
                    return false;
                }
            }
            if (seesSky != null && level.canSeeSky(pos) != seesSky) {
                return false;
            }
            if (spawnable != null && isSpawnCandidate(level, pos) != spawnable) {
                return false;
            }
            return true;
        }

        String summary() {
            StringBuilder sb = new StringBuilder();
            if (lightMin != null || lightMax != null) {
                sb.append(" light").append(range(lightMin, lightMax));
            }
            if (skyMin != null || skyMax != null) {
                sb.append(" sky_light").append(range(skyMin, skyMax));
            }
            if (seesSky != null) {
                sb.append(seesSky ? " sees_sky" : " !sees_sky");
            }
            if (spawnable != null) {
                sb.append(spawnable ? " spawnable" : " !spawnable");
            }
            return sb.toString();
        }

        private static String range(final @Nullable Integer min, final @Nullable Integer max) {
            if (min != null && max != null) {
                return min.equals(max) ? "=" + min : "=" + min + ".." + max;
            }
            return min != null ? ">=" + min : "<=" + max;
        }
    }

    /**
     * The deterministic half of "a hostile mob can spawn in this cell": vanilla's ON_GROUND spawn
     * position rule for a representative hostile, plus the dimension's block-light limit.
     *
     * <p>Zombie is the representative because ON_GROUND geometry is shared by every ON_GROUND mob
     * (vanilla requires this cell AND the one above to be valid-empty regardless of the mob's
     * height), so a cell rejected here is rejected for the taller ones too — the over-approximation
     * runs in the safe direction for the negative that spawn-proofing actually needs.
     */
    private static boolean isSpawnCandidate(final ServerLevel level, final BlockPos pos) {
        int limit = level.dimensionType().monsterSpawnBlockLightLimit();
        if (limit < 15
            && level.getBrightness(net.minecraft.world.level.LightLayer.BLOCK, pos) > limit) {
            return false;
        }
        return net.minecraft.world.entity.SpawnPlacements.isSpawnPositionOk(
            net.minecraft.world.entity.EntityTypes.ZOMBIE, level, pos);
    }

    /** One pattern node. Exactly one of {@code block}/{@code entityTarget}/{@code set} is non-null,
     *  unless the node carries only {@link CellPred} properties (then every cell is a candidate). */
    private static final class PNode {
        final String id;
        final String spec;
        final BlockTools.@Nullable Matcher block;
        final @Nullable Target entityTarget;
        final @Nullable ResultSet set;
        final @Nullable CellPred cell;
        /** Enumerated candidates; a value is a {@link Cand}. */
        final List<Cand> cands = new ArrayList<>();
        final HashMap<BlockPos, List<Cand>> byCell = new HashMap<>();
        boolean capped;

        PNode(final String id, final String spec,
              final BlockTools.@Nullable Matcher block,
              final @Nullable Target entityTarget, final @Nullable ResultSet set,
              final @Nullable CellPred cell) {
            this.id = id;
            this.spec = spec;
            this.block = block;
            this.entityTarget = entityTarget;
            this.set = set;
            this.cell = cell;
        }

        boolean isCellNode() {
            return entityTarget == null; // block, set or bare cell: binds a cell, may anchor a set
        }

        /** True when nothing but cell properties selects this node's candidates. */
        boolean isBareCell() {
            return block == null && entityTarget == null && set == null;
        }

        /** Does this cell pass the node's non-geometric properties (no predicate ⇒ yes)? */
        boolean cellOk(final ServerLevel level, final BlockPos pos) {
            return cell == null || cell.test(level, pos);
        }

        /**
         * Kind+spec — the identity that makes two nodes interchangeable for match dedup. Cell
         * properties are part of it: two air nodes that disagree about light are NOT the same node,
         * and treating them as interchangeable would dedup away real distinct matches.
         */
        String groupKey() {
            return (block != null ? "b|" : set != null ? "s|" : entityTarget != null ? "e|" : "c|")
                + spec + (cell != null ? cell.summary() : "");
        }

        boolean add(final Cand c) {
            if (cands.size() >= NODE_CANDIDATE_CAP) {
                capped = true;
                return false;
            }
            cands.add(c);
            byCell.computeIfAbsent(c.cell, k -> new ArrayList<>(1)).add(c);
            return true;
        }
    }

    /** One candidate binding: the cell it occupies, plus the entity when the node is an entity node. */
    private record Cand(BlockPos cell, @Nullable Entity ent) {}

    /**
     * Visit every cell of one chunk column inside the extent, feeding the property-only nodes.
     * This is the one enumeration path with no index behind it — the volume was bounded before the
     * sweep started ({@link #CELL_SWEEP_MAX}), and the cost shows up in {@code search.ms} like
     * every other scan cost.
     */
    private static void sweepCellNodes(final ServerLevel level, final List<PNode> bare,
                                       final LightGate lightGate, final int ccx, final int ccz,
                                       final int cx0, final int cz0, final int radius,
                                       final int fyMin, final int fyMax,
                                       final @Nullable Box scope) {
        int x0 = Math.max(ccx << 4, scope != null ? scope.x0() : cx0 - radius);
        int x1 = Math.min((ccx << 4) + 15, scope != null ? scope.x1() : cx0 + radius);
        int z0 = Math.max(ccz << 4, scope != null ? scope.z0() : cz0 - radius);
        int z1 = Math.min((ccz << 4) + 15, scope != null ? scope.z1() : cz0 + radius);
        BlockPos.MutableBlockPos cursor = new BlockPos.MutableBlockPos();
        for (int x = x0; x <= x1; x++) {
            for (int z = z0; z <= z1; z++) {
                for (int y = fyMin; y <= fyMax; y++) {
                    cursor.set(x, y, z);
                    for (PNode n : bare) {
                        if (n.capped) {
                            continue;
                        }
                        if (n.cell.needsLight() && !lightGate.ok(cursor)) {
                            continue;
                        }
                        if (!n.cell.test(level, cursor)) {
                            continue;
                        }
                        n.add(new Cand(cursor.immutable(), null));
                    }
                }
            }
        }
    }

    /**
     * Per-chunk light correctness, cached and counted. A chunk can be at FULL with its lighting not
     * yet computed; {@code getBrightness} then returns 0, which reads as "dark" — so a light-
     * dependent test over such a chunk would manufacture spawnable cells out of missing data. Cells
     * there are skipped, and the number of chunks skipped is disclosed so the negative can be typed.
     */
    private static final class LightGate {
        private final ServerLevel level;
        private final HashMap<Long, Boolean> known = new HashMap<>();
        private final HashSet<Long> skipped = new HashSet<>();

        LightGate(final ServerLevel level) {
            this.level = level;
        }

        boolean ok(final BlockPos pos) {
            int cx = pos.getX() >> 4;
            int cz = pos.getZ() >> 4;
            long key = net.minecraft.world.level.ChunkPos.pack(cx, cz);
            Boolean cached = known.get(key);
            if (cached == null) {
                cached = level.getChunk(cx, cz).isLightCorrect();
                known.put(key, cached);
            }
            if (!cached) {
                skipped.add(key);
            }
            return cached;
        }

        int chunksSkipped() {
            return skipped.size();
        }
    }

    /** Parse a node's cell properties, or null when it states none. */
    private static @Nullable CellPred parseCellPred(final JsonObject n, final String id) {
        Integer[] light = lightRange(n, "light", id);
        Integer[] sky = lightRange(n, "sky_light", id);
        Boolean seesSky = optBool(n, "sees_sky");
        Boolean spawnable = optBool(n, "spawnable");
        if (light == null && sky == null && seesSky == null && spawnable == null) {
            return null;
        }
        return new CellPred(light == null ? null : light[0], light == null ? null : light[1],
            sky == null ? null : sky[0], sky == null ? null : sky[1], seesSky, spawnable);
    }

    /** A {min,max} light bound, validated to vanilla's 0..15 scale. */
    private static Integer @Nullable [] lightRange(final JsonObject n, final String key,
                                                   final String id) {
        if (!n.has(key) || n.get(key).isJsonNull()) {
            return null;
        }
        if (!n.get(key).isJsonObject()) {
            throw new IllegalArgumentException("node '" + id + "'." + key
                + " must be an object {min?, max?} on the 0-15 light scale");
        }
        JsonObject o = n.getAsJsonObject(key);
        Integer min = o.has("min") && !o.get("min").isJsonNull() ? o.get("min").getAsInt() : null;
        Integer max = o.has("max") && !o.get("max").isJsonNull() ? o.get("max").getAsInt() : null;
        if (min == null && max == null) {
            throw new IllegalArgumentException("node '" + id + "'." + key
                + " needs `min`, `max`, or both");
        }
        for (Integer v : new Integer[] {min, max}) {
            if (v != null && (v < 0 || v > 15)) {
                throw new IllegalArgumentException("node '" + id + "'." + key
                    + ": light levels are 0-15, got " + v);
            }
        }
        if (min != null && max != null && min > max) {
            throw new IllegalArgumentException("node '" + id + "'." + key + ".min > max");
        }
        return new Integer[] {min, max};
    }

    private static @Nullable Boolean optBool(final JsonObject o, final String k) {
        return o.has(k) && !o.get(k).isJsonNull() ? o.get(k).getAsBoolean() : null;
    }

    private record PRel(String rel, int a, int b, int dx, int dy, int dz, int r) {
        /** Does this relation hold between cell(a) and cell(b)? Pure cell arithmetic. */
        boolean holds(final BlockPos ca, final BlockPos cb) {
            int ddx = ca.getX() - cb.getX();
            int ddy = ca.getY() - cb.getY();
            int ddz = ca.getZ() - cb.getZ();
            return switch (rel) {
                case "adjacent" -> Math.abs(ddx) + Math.abs(ddy) + Math.abs(ddz) == 1;
                case "above" -> ddx == 0 && ddz == 0 && ddy == 1;
                case "below" -> ddx == 0 && ddz == 0 && ddy == -1;
                case "offset" -> ddx == dx && ddy == dy && ddz == dz;
                case "within" -> Math.max(Math.abs(ddx), Math.max(Math.abs(ddy), Math.abs(ddz))) <= r;
                default -> false;
            };
        }

        /** How far this relation can place a partner from a known cell (extent-derivation reach). */
        int reach() {
            return switch (rel) {
                case "adjacent", "above", "below" -> 1;
                case "offset" -> Math.max(Math.abs(dx), Math.max(Math.abs(dy), Math.abs(dz)));
                case "within" -> r;
                default -> 0;
            };
        }
    }

    /**
     * The `pattern` direction: configuration -> positions. The model states a conjunction of cell
     * relations over typed nodes; the server enumerates candidates (one palette-prefiltered chunk
     * sweep for every block node, one entity-section query per entity node, a re-verified stored
     * set for set nodes) and joins them smallest-first. Escalation lives inside the tool, and cost
     * is reported (`ms`, chunk accounting), never hidden.
     */
    private static JsonObject patternSearch(final MinecraftServer server, final ServerLevel level,
                                            final JsonObject a, final @Nullable Box scope,
                                            final @Nullable Vec3 obs,
                                            final String obsLabel, final boolean yTrusted,
                                            final Ledger ledger,
                                            final @Nullable String session) {
        long t0 = System.nanoTime();
        JsonObject p = a.getAsJsonObject("pattern");
        net.minecraft.core.HolderLookup<net.minecraft.world.level.block.Block> lookup =
            server.registryAccess().lookupOrThrow(Registries.BLOCK);

        // -- parse nodes ------------------------------------------------------
        if (!p.has("nodes") || !p.get("nodes").isJsonArray() || p.getAsJsonArray("nodes").isEmpty()) {
            throw new IllegalArgumentException("pattern.nodes must be a non-empty array of "
                + "{id, block|entity|set}");
        }
        JsonArray nodesJson = p.getAsJsonArray("nodes");
        if (nodesJson.size() > PATTERN_MAX_NODES) {
            throw new IllegalArgumentException("too many pattern nodes (" + nodesJson.size()
                + " > " + PATTERN_MAX_NODES + ")");
        }
        List<PNode> nodes = new ArrayList<>();
        Map<String, Integer> idIndex = new HashMap<>();
        List<ResultSet> usedSets = new ArrayList<>();
        for (int i = 0; i < nodesJson.size(); i++) {
            JsonObject n = nodesJson.get(i).getAsJsonObject();
            String id = n.has("id") && !n.get("id").isJsonNull() ? n.get("id").getAsString() : null;
            if (id == null || id.isBlank()) {
                throw new IllegalArgumentException("pattern.nodes[" + i + "] needs an `id`");
            }
            if (idIndex.put(id, i) != null) {
                throw new IllegalArgumentException("duplicate node id '" + id + "'");
            }
            String block = optStr(n, "block");
            String entity = optStr(n, "entity");
            String set = optStr(n, "set");
            CellPred cell = parseCellPred(n, id);
            int given = (block != null ? 1 : 0) + (entity != null ? 1 : 0) + (set != null ? 1 : 0);
            if (given > 1 || given == 0 && cell == null) {
                throw new IllegalArgumentException("pattern node '" + id + "' needs exactly one of "
                    + "`block` (matcher, set_blocks syntax), `entity` (type/#tag/category) or "
                    + "`set` (a stored result set name) — or none of them plus cell properties "
                    + "(light/sky_light/sees_sky/spawnable), which selects cells by property alone");
            }
            if (given == 0) {
                // Property-only node: no matcher can narrow the candidates, so every cell in the
                // extent is tested. Bounded up front rather than truncated silently.
                nodes.add(new PNode(id, "cell", null, null, null, cell));
            } else if (block != null) {
                BlockTools.Matcher in;
                try {
                    in = BlockTools.parseMatcher(lookup, block);
                } catch (IllegalArgumentException ex) {
                    throw new IllegalArgumentException("node '" + id + "'.block: " + ex.getMessage());
                }
                nodes.add(new PNode(id, block, in, null, null, cell));
            } else if (entity != null) {
                nodes.add(new PNode(id, entity, null, parseEntityNode(entity), null, cell));
            } else {
                ResultSet rs = ledger.sets.get(set);
                if (rs == null) {
                    throw new IllegalArgumentException("no result set named '" + set + "'"
                        + (ledger.sets.isEmpty() ? " — nothing stored yet; a pattern search with `as` creates one"
                           : " — stored sets: " + String.join(", ", ledger.sets.keySet())));
                }
                if (!rs.dimension.equals(level.dimension().identifier().toString())) {
                    throw new IllegalArgumentException("result set '" + set + "' was recorded in "
                        + rs.dimension + ", not " + level.dimension().identifier()
                        + " — sets never cross dimensions");
                }
                usedSets.add(rs);
                nodes.add(new PNode(id, rs.spec(), null, null, rs, cell));
            }
        }

        // -- parse relations --------------------------------------------------
        List<PRel> rels = new ArrayList<>();
        if (p.has("relations") && p.get("relations").isJsonArray()) {
            JsonArray relsJson = p.getAsJsonArray("relations");
            if (relsJson.size() > PATTERN_MAX_RELATIONS) {
                throw new IllegalArgumentException("too many relations (" + relsJson.size()
                    + " > " + PATTERN_MAX_RELATIONS + ")");
            }
            for (int i = 0; i < relsJson.size(); i++) {
                JsonObject rj = relsJson.get(i).getAsJsonObject();
                String rel = optStr(rj, "rel");
                if (rel == null || !(rel.equals("adjacent") || rel.equals("above")
                    || rel.equals("below") || rel.equals("offset") || rel.equals("within"))) {
                    throw new IllegalArgumentException("relations[" + i + "].rel must be "
                        + "adjacent|above|below|offset|within");
                }
                if (!rj.has("of") || !rj.get("of").isJsonArray()
                    || rj.getAsJsonArray("of").size() != 2) {
                    throw new IllegalArgumentException("relations[" + i + "].of must name exactly "
                        + "two node ids");
                }
                String ida = rj.getAsJsonArray("of").get(0).getAsString();
                String idb = rj.getAsJsonArray("of").get(1).getAsString();
                Integer na = idIndex.get(ida);
                Integer nb = idIndex.get(idb);
                if (na == null || nb == null) {
                    throw new IllegalArgumentException("relations[" + i + "] names unknown node '"
                        + (na == null ? ida : idb) + "'");
                }
                if (na.equals(nb)) {
                    throw new IllegalArgumentException("relations[" + i + "] relates '" + ida
                        + "' to itself");
                }
                int dx = optInt(rj, "dx", 0);
                int dy = optInt(rj, "dy", 0);
                int dz = optInt(rj, "dz", 0);
                int r = optInt(rj, "r", -1);
                if (rel.equals("offset") && dx == 0 && dy == 0 && dz == 0) {
                    throw new IllegalArgumentException("relations[" + i + "]: offset needs a "
                        + "non-zero dx/dy/dz (a = b + offset)");
                }
                if (rel.equals("within") && (r < 1 || r > WITHIN_MAX)) {
                    throw new IllegalArgumentException("relations[" + i + "]: within needs r in "
                        + "1.." + WITHIN_MAX);
                }
                rels.add(new PRel(rel, na, nb, dx, dy, dz, r));
            }
        }
        // Connectivity: a disconnected pattern is a cross product, which answers no spatial
        // question and explodes combinatorially — reject with the reason.
        requireConnected(nodes, rels);

        // -- anchor node ------------------------------------------------------
        String anchorId = optStr(p, "anchor");
        int anchorIdx = 0;
        if (anchorId != null) {
            Integer ai = idIndex.get(anchorId);
            if (ai == null) {
                throw new IllegalArgumentException("pattern.anchor names unknown node '" + anchorId + "'");
            }
            anchorIdx = ai;
        }
        PNode anchorNode = nodes.get(anchorIdx);
        String asName = optStr(a, "as");
        if (asName != null && !anchorNode.isCellNode()) {
            throw new IllegalArgumentException("`as` stores the anchor node's cells as a result "
                + "set, and '" + anchorNode.id + "' is an entity node — entity results are "
                + "volatile anchors, not sets (PATTERN_SEARCH_DESIGN.md). Anchor a block node, "
                + "or drop `as`.");
        }

        // -- scan extent ------------------------------------------------------
        int radiusArg = clampRadius(a, PATTERN_DEFAULT_RADIUS, PATTERN_MAX_RADIUS);
        boolean radiusGiven = a.has("radius") && !a.get("radius").isJsonNull();
        boolean nearExplicit = a.has("near") && !a.get("near").isJsonNull();
        int relReach = rels.stream().mapToInt(PRel::reach).max().orElse(0);
        int derivedRadius = radiusArg;
        BlockPos scanCenter;
        String extentSource;
        if (scope != null) {
            // A named region IS the extent. The sweep still runs on the covering square (the chunk
            // walk is square), but every candidate is clipped to the box below, so the answer is
            // about the region and nothing else — and the region is what the negative is stated
            // about, which is the point of naming it.
            if (radiusGiven) {
                throw new IllegalArgumentException("`in` and `radius` both set the extent — the "
                    + "region already says how far to look; drop one");
            }
            if (a.has("y_range") && a.get("y_range").isJsonObject()) {
                throw new IllegalArgumentException("`in` and `y_range` both set the extent — the "
                    + "region carries its own heights; drop one");
            }
            scanCenter = scope.center();
            derivedRadius = scope.coveringRadius();
            if (derivedRadius > PATTERN_MAX_RADIUS) {
                throw new IllegalArgumentException("region spans " + (2 * derivedRadius + 1)
                    + " blocks horizontally, beyond the scan's " + (2 * PATTERN_MAX_RADIUS + 1)
                    + "-block reach — name a smaller region, or scan it in parts");
            }
            extentSource = "region";
        } else if (obs != null && (nearExplicit
                || usedSets.stream().allMatch(s -> s.members.isEmpty()))) {
            // An EXPLICIT `near` is the caller's stated extent. A merely-defaulted observer (the
            // first online player, the body) is not — when set nodes carry positioned members, the
            // set's own extent wins below. First live run of the 0.32.0 probes caught this: the
            // refine centred on Player767 at 3.48M while the set lived at 3.36M, so the refinement
            // loop broke the moment anyone was logged in (LOCATE_ROUTES.md "First live run").
            scanCenter = BlockPos.containing(obs);
            extentSource = "centre";
        } else {
            // No explicit centre: a set can supply its own extent — the refinement loop should not
            // force the caller to restate where the members already are.
            List<BlockPos> seed = usedSets.stream().flatMap(s -> s.members.stream()).toList();
            if (seed.isEmpty()) {
                throw new IllegalStateException("pattern search needs a centre: pass `near` {x,z} "
                    + "(or have a body/player, or include a `set` node to search around)");
            }
            int minX = Integer.MAX_VALUE, maxX = Integer.MIN_VALUE;
            int minZ = Integer.MAX_VALUE, maxZ = Integer.MIN_VALUE;
            for (BlockPos m : seed) {
                minX = Math.min(minX, m.getX());
                maxX = Math.max(maxX, m.getX());
                minZ = Math.min(minZ, m.getZ());
                maxZ = Math.max(maxZ, m.getZ());
            }
            scanCenter = new BlockPos((minX + maxX) / 2, level.getSeaLevel(), (minZ + maxZ) / 2);
            int spread = Math.max(maxX - minX, maxZ - minZ) / 2 + relReach + 2;
            derivedRadius = radiusGiven ? radiusArg : Math.min(PATTERN_MAX_RADIUS, Math.max(16, spread));
            extentSource = "derived from set members";
        }
        final int radius = derivedRadius;
        int yMin = scope != null ? Math.max(level.getMinY(), scope.y0()) : level.getMinY();
        int yMax = scope != null ? Math.min(level.getMaxY(), scope.y1()) : level.getMaxY();
        if (a.has("y_range") && a.get("y_range").isJsonObject()) {
            JsonObject yr = a.getAsJsonObject("y_range");
            if (yr.has("min") && !yr.get("min").isJsonNull()) {
                yMin = Math.max(yMin, yr.get("min").getAsInt());
            }
            if (yr.has("max") && !yr.get("max").isJsonNull()) {
                yMax = Math.min(yMax, yr.get("max").getAsInt());
            }
            if (yMin > yMax) {
                throw new IllegalArgumentException("y_range.min > y_range.max");
            }
        }
        final int fyMin = yMin;
        final int fyMax = yMax;
        final int cx0 = scanCenter.getX();
        final int cz0 = scanCenter.getZ();

        // -- candidate enumeration -------------------------------------------
        ReadSupport.ChunkLoader loader = new ReadSupport.ChunkLoader(level, ReadSupport.loadArg(a));
        List<PNode> blockNodes = nodes.stream().filter(n -> n.block != null).toList();
        List<PNode> bareCellNodes = nodes.stream().filter(PNode::isBareCell).toList();
        // A property-only node has no matcher to narrow anything, so its candidates come from
        // visiting every cell in the extent. Refused up front when that is too much volume rather
        // than swept partially: a truncated spawn-proofing scan is worse than a refused one, because
        // its miss looks exactly like safety (LOCATE_ROUTES.md B5).
        long sweptCells = 0;
        if (!bareCellNodes.isEmpty()) {
            long columns = scope != null
                ? (long) (scope.x1() - scope.x0() + 1) * (scope.z1() - scope.z0() + 1)
                : (2L * radius + 1) * (2L * radius + 1);
            sweptCells = columns * (fyMax - fyMin + 1);
            if (sweptCells > CELL_SWEEP_MAX) {
                throw new IllegalArgumentException("a property-only node scans every cell: "
                    + sweptCells + " cells (radius " + radius + " x y " + fyMin + ".." + fyMax
                    + ") exceeds the " + CELL_SWEEP_MAX + "-cell budget. Give a `y_range` (a spawn "
                    + "survey wants the floors you care about, not the whole column) and/or a "
                    + "smaller `radius`, or add a `block` matcher to the node so the scan can use "
                    + "the section palette index.");
            }
        }
        // Light is not readable from a chunk whose lighting has not been computed — it reads 0,
        // which is "dark", which would be a spawnable FALSE POSITIVE. Such cells are skipped and
        // counted, and the count poisons the negative with its cause named.
        LightGate lightGate = new LightGate(level);
        int chunksRequested = 0;
        int chunksRead = 0;
        int minCx = (cx0 - radius) >> 4;
        int maxCx = (cx0 + radius) >> 4;
        int minCz = (cz0 - radius) >> 4;
        int maxCz = (cz0 + radius) >> 4;
        // One sweep serves every block node: the per-section palette test skips whole 16^3
        // sections that cannot contain any wanted block, which is what makes a rare-block scan
        // nearly free. State prefilter first; the full matcher (properties + NBT) confirms.
        Predicate<net.minecraft.world.level.block.state.BlockState> combined = blockNodes.isEmpty()
            ? st -> false
            : st -> {
                for (PNode n : blockNodes) {
                    if (n.block.prefilter(st)) {
                        return true;
                    }
                }
                return false;
            };
        for (int ccx = minCx; ccx <= maxCx; ccx++) {
            for (int ccz = minCz; ccz <= maxCz; ccz++) {
                chunksRequested++;
                if (!loader.ensure(new BlockPos(ccx << 4, level.getSeaLevel(), ccz << 4))) {
                    continue;
                }
                chunksRead++;
                if (!bareCellNodes.isEmpty()) {
                    sweepCellNodes(level, bareCellNodes, lightGate, ccx, ccz,
                        cx0, cz0, radius, fyMin, fyMax, scope);
                }
                if (blockNodes.isEmpty()) {
                    continue;
                }
                level.getChunk(ccx, ccz).findBlocks(combined, (pos, state) -> {
                    if (pos.getY() < fyMin || pos.getY() > fyMax
                        || Math.abs(pos.getX() - cx0) > radius
                        || Math.abs(pos.getZ() - cz0) > radius
                        // The sweep is square; the ANSWER is the region. Clipping here keeps
                        // "nothing in `room`" a statement about the room.
                        || scope != null && !scope.containsXZ(pos.getX(), pos.getZ())) {
                        return;
                    }
                    for (PNode n : blockNodes) {
                        if (!n.block.prefilter(state)) {
                            continue;
                        }
                        // Full vanilla predicate (NBT included) — same meaning as `expect`.
                        if (!n.block.test(level, pos.immutable())) {
                            continue;
                        }
                        // Cell properties gate here, not after the join: a cell that fails them
                        // never becomes a candidate, so the candidate cap counts real matches.
                        if (n.cell != null) {
                            if (n.cell.needsLight() && !lightGate.ok(pos)) {
                                continue;
                            }
                            if (!n.cell.test(level, pos.immutable())) {
                                continue;
                            }
                        }
                        n.add(new Cand(pos.immutable(), null));
                    }
                });
            }
        }
        // Entity nodes: the usual X-ray spatial read over the same horizontal extent. Entity data
        // is chunk-resident separately from blocks; the registration wrapper pre-staged this rect
        // (get_entities' own mechanism, 0.21.0), so the residency counted here is post-stage — an
        // entity-node negative over chunks that STILL have no entity data must not read as proof.
        Entity self = com.mattmc.mcptoolkit.drone.DroneTools.activeBodyFor(session);
        boolean anyEntityNode = nodes.stream().anyMatch(n -> n.entityTarget != null);
        int entityUnsearched = 0;
        if (anyEntityNode) {
            for (int ccx = minCx; ccx <= maxCx; ccx++) {
                for (int ccz = minCz; ccz <= maxCz; ccz++) {
                    if (!level.areEntitiesLoaded(net.minecraft.world.level.ChunkPos.pack(ccx, ccz))) {
                        entityUnsearched++;
                    }
                }
            }
        }
        for (PNode n : nodes) {
            if (n.entityTarget == null) {
                continue;
            }
            Predicate<Entity> match = entityMatcher(n.entityTarget);
            AABB box = scope != null
                ? new AABB(scope.x0(), fyMin, scope.z0(),
                    scope.x1() + 1.0, fyMax + 1.0, scope.z1() + 1.0)
                : new AABB(cx0 - radius, fyMin, cz0 - radius,
                    cx0 + radius + 1.0, fyMax + 1.0, cz0 + radius + 1.0);
            for (Entity e : level.getEntities((Entity) null, box,
                    ent -> ent != self && ent.isAlive() && match.test(ent))) {
                // Cell properties apply to an entity's own cell too ("a mob standing in the dark").
                if (n.cell != null) {
                    if (n.cell.needsLight() && !lightGate.ok(e.blockPosition())) {
                        continue;
                    }
                    if (!n.cell.test(level, e.blockPosition())) {
                        continue;
                    }
                }
                if (!n.add(new Cand(e.blockPosition(), e))) {
                    break;
                }
            }
        }
        // Set nodes: stored members, re-verified live — never trusted from the record.
        int staleDropped = 0;
        int unverifiable = 0;
        for (PNode n : nodes) {
            if (n.set == null) {
                continue;
            }
            BlockTools.@Nullable Matcher matcher = n.set.matcher == null
                ? null : BlockTools.parseMatcher(lookup, n.set.matcher);
            for (BlockPos m : n.set.members) {
                if (scope != null && !scope.contains(m)) {
                    continue; // outside the region this search is about; not a staleness event
                }
                if (!loader.ensure(m)) {
                    unverifiable++;
                    continue;
                }
                // Light the stored predicates need is as unavailable as an unread chunk: not knowing
                // whether a member still qualifies is `unverifiable`, never a silent pass.
                if (n.set.needsLight() && !lightGate.ok(m)) {
                    unverifiable++;
                    continue;
                }
                if (matcher != null && !matcher.test(level, m) || !n.set.cellsOk(level, m)) {
                    staleDropped++;
                    continue;
                }
                // "Of those chests, the ones in the dark" — a refinement chain over a stored set.
                if (n.cell != null) {
                    if (n.cell.needsLight() && !lightGate.ok(m)) {
                        continue;
                    }
                    if (!n.cell.test(level, m)) {
                        continue;
                    }
                }
                n.add(new Cand(m, null));
            }
        }

        // -- join, smallest candidate set first ------------------------------
        List<Integer> order = joinOrder(nodes, rels);
        LinkedHashSet<BlockPos> anchorCells = new LinkedHashSet<>();
        List<Cand[]> matches = new ArrayList<>();
        HashSet<String> seenSignatures = new HashSet<>();
        int limit = Math.max(1, Math.min(MAX_LIMIT, optInt(a, "limit", DEFAULT_LIMIT)));
        int[] matchesTotal = {0};
        boolean[] matchesCapped = {false};
        boolean[] membersTruncated = {false};
        Cand[] bound = new Cand[nodes.size()];
        enumerate(nodes, rels, order, 0, bound, seenSignatures, anchorIdx, anchorCells,
            matches, matchesTotal, matchesCapped, membersTruncated);
        // NEAREST FIRST, and only then the `limit` cut. Enumeration order is the chunk sweep
        // (−x,−z corner outward) and then findBlocks' bottom-up section walk, so reporting it raw
        // answered "where is the nearest X" with the corner-most, deepest X — wrapped in relations
        // that read exactly like an answer (LOCATE_ROUTES.md C1). The other two `what` routes have
        // always ranked; this one is the promoted front door for block searches, so it must too.
        // Ranking is 3D where the centre's y is REAL and horizontal where it is an assumption —
        // the same rule that made findEntities sort horizontally, applied to the case where the
        // number actually came from somewhere rather than blanket.
        Vec3 rankFrom = obs != null ? obs : Vec3.atCenterOf(scanCenter);
        final int rankIdx = anchorIdx;
        matches.sort(Comparator.comparingDouble(m -> rankDistance(m[rankIdx].cell(), rankFrom, yTrusted)));
        List<Cand[]> reported = matches.subList(0, Math.min(limit, matches.size()));
        long ms = (System.nanoTime() - t0) / 1_000_000L;

        // -- honesty: the composed negative ----------------------------------
        boolean anyCandidateCap = nodes.stream().anyMatch(n -> n.capped);
        boolean setsClean = usedSets.stream().allMatch(s -> s.fullyRead && !s.truncated)
            && unverifiable == 0;
        boolean nothingRead = chunksRead == 0 && nodes.stream().allMatch(n -> n.cands.isEmpty());
        int lightUnknown = lightGate.chunksSkipped();
        boolean proof = chunksRead == chunksRequested && !anyCandidateCap && !matchesCapped[0]
            && setsClean && entityUnsearched == 0 && !nothingRead && lightUnknown == 0;

        JsonObject r = new JsonObject();
        // A geometric region read with visibility ignored — the spatial X-ray label, honestly.
        WorldPerceptionTools.addEnvelope(r, level, "spatial");
        r.addProperty("source", obsLabel);
        r.add("center", pos(scanCenter));

        JsonObject search = new JsonObject();
        search.addProperty("mechanism", "pattern_scan");
        search.addProperty("what", patternSummary(nodes, rels));
        search.addProperty("radius", radius);
        search.addProperty("vertical_extent", (a.has("y_range") ? "y " + fyMin + ".." + fyMax
            : "full world height"));
        search.addProperty("ms", ms);
        search.addProperty("extent", chunksRead + " of " + chunksRequested + " chunks readable ("
            + (scope != null ? scope.source() + "; matches clipped to that box"
               : extentSource + " " + cx0 + "," + cz0 + " r" + radius) + ")");
        if (scope != null) {
            search.addProperty("scope_region", scope.describe());
        }
        JsonObject candCounts = new JsonObject();
        for (PNode n : nodes) {
            candCounts.addProperty(n.id, n.cands.size());
        }
        search.add("candidates", candCounts);
        if (sweptCells > 0) {
            search.addProperty("cells_swept", sweptCells);
        }
        // The spawn threshold is the WORLD's number, not this tool's prose — read it out so the
        // model never has to remember which dimension tolerates which light level.
        if (nodes.stream().anyMatch(n -> n.cell != null && n.cell.spawnable != null)) {
            search.addProperty("spawn_block_light_limit",
                level.dimensionType().monsterSpawnBlockLightLimit());
            search.addProperty("spawnable_means", "vanilla's ON_GROUND spawn POSITION rule (valid "
                + "spawn surface below, this cell and the one above both free) plus that block-light "
                + "limit. Over-reports on purpose: the per-mob rules, the randomised light draw, "
                + "biome mob lists, difficulty and mob caps are NOT applied, so a match is a "
                + "candidate cell and the sound claim is the NEGATIVE (no candidate = spawn-proof "
                + "for the extent read).");
        }
        if (lightUnknown > 0) {
            search.addProperty("light_unknown_chunks", lightUnknown);
        }
        if (staleDropped > 0) {
            search.addProperty("stale_dropped", staleDropped);
        }
        if (unverifiable > 0) {
            search.addProperty("unverifiable", unverifiable);
        }
        search.addProperty("negative_is_proof", proof);
        if (!proof) {
            StringBuilder why = new StringBuilder();
            if (nothingRead) {
                why.append("nothing was read at all; ");
            } else if (chunksRead < chunksRequested) {
                why.append(chunksRequested - chunksRead).append(" chunk(s) unreadable (")
                   .append(loader.shortfallReason()).append("); ");
            }
            if (anyCandidateCap) {
                why.append("a node hit the ").append(NODE_CANDIDATE_CAP).append("-candidate cap; ");
            }
            if (matchesCapped[0]) {
                why.append("match enumeration stopped at ").append(MATCH_CAP).append("; ");
            }
            if (entityUnsearched > 0) {
                why.append(entityUnsearched).append(" chunk(s) had no entity data even after "
                    + "staging (never-generated / budget / load:false / still arriving — the "
                    + "last wants a re-query); ");
            }
            for (ResultSet s : usedSets) {
                if (!s.fullyRead || s.truncated) {
                    why.append("set '").append(s.name).append("' has partial provenance (")
                       .append(!s.fullyRead ? "created over a partially-read extent" : "truncated")
                       .append("); ");
                }
            }
            if (unverifiable > 0) {
                why.append(unverifiable).append(" set member(s) unreadable now; ");
            }
            if (lightUnknown > 0) {
                why.append(lightUnknown).append(" chunk(s) had no computed lighting, so their cells "
                    + "were SKIPPED rather than read as dark (an uncomputed light level reads 0, "
                    + "which would invent dark cells); ");
            }
            search.addProperty("note", "Not a proof: " + why + "absence within the UNREAD part is "
                + "unknown — matches_total is a lower bound.");
        }
        // Set provenance travels with the search record: a negative restated later must stay
        // scoped to what the set actually was ("no X above any of THOSE golds, found THERE, THEN").
        if (!usedSets.isEmpty()) {
            JsonArray setScope = new JsonArray();
            for (ResultSet s : usedSets) {
                JsonObject o = new JsonObject();
                o.addProperty("set", s.name);
                o.addProperty("members", s.members.size());
                o.addProperty("created_tick", s.tick);
                o.addProperty("created_extent", s.extent);
                setScope.add(o);
            }
            search.add("scope", setScope);
        }
        search.addProperty("tick", level.getGameTime());
        search.add("center", pos(scanCenter));
        if (nothingRead) {
            search.add("found", null);
        } else {
            search.addProperty("found", matchesTotal[0]);
        }
        ledger.record(search.deepCopy());
        r.add("search", search);

        // -- report matches as referents -------------------------------------
        List<Anchor> refs = selectAnchors(ledger, level);
        JsonArray found = new JsonArray();
        // The matcher's own id is not the answer once a matcher can be a TAG (#minecraft:logs
        // matched *something*, and which one is the interesting half), so a block referent is named
        // from the cell that actually matched. Free: the chunk is resident, the scan just read it.
        String anchorBlockId = anchorNode.block != null
            ? (anchorNode.block.isTag() ? anchorNode.block.spec() : anchorNode.block.blockId())
            : anchorNode.set != null ? anchorNode.set.matcherId : null;
        for (int i = 0; i < reported.size(); i++) {
            Cand[] b = reported.get(i);
            Cand anchorCand = b[anchorIdx];
            BlockPos cell = anchorCand.cell();
            boolean isEntity = anchorCand.ent() != null;
            String kind = isEntity ? "entity" : "block";
            String rid = isEntity
                ? BuiltInRegistries.ENTITY_TYPE.getKey(anchorCand.ent().getType()).toString()
                : BuiltInRegistries.BLOCK.getKey(level.getBlockState(cell).getBlock()).toString();
            String shortName = rid.contains(":") ? rid.substring(rid.indexOf(':') + 1) : rid;
            String name = (i == 0 && asName != null) ? asName : shortName;
            String handle = name + "@" + cell.getX() + "," + cell.getY() + "," + cell.getZ();
            JsonObject o = new JsonObject();
            o.addProperty("handle", handle);
            o.addProperty("kind", kind);
            o.addProperty("id", rid);
            o.add("pos", pos(cell));
            JsonObject bindings = new JsonObject();
            for (int nn = 0; nn < nodes.size(); nn++) {
                JsonObject bo = new JsonObject();
                bo.add("pos", pos(b[nn].cell()));
                if (b[nn].ent() != null) {
                    bo.addProperty("type",
                        BuiltInRegistries.ENTITY_TYPE.getKey(b[nn].ent().getType()).toString());
                    bo.addProperty("id", b[nn].ent().getId());
                }
                bindings.add(nodes.get(nn).id, bo);
            }
            o.add("bindings", bindings);
            o.add("relations", relations(cell, true, obs, refs));
            found.add(o);
            ledger.add(new Anchor(handle, kind, rid, level.dimension().identifier().toString(),
                isEntity ? anchorCand.ent().getUUID() : null, cell, true, level.getGameTime()));
        }
        r.add("found", found);
        if (nothingRead) {
            r.add("matches_total", null);
            r.addProperty("note", "NOTHING WAS READ — no chunk in the extent was readable and no "
                + "set member was verifiable, so this result describes no world state at all. "
                + "Absence here is not evidence of absence (" + loader.shortfallReason() + ").");
        } else {
            r.addProperty("matches_total", matchesTotal[0]);
            if (matchesTotal[0] > reported.size()) {
                r.addProperty("note", matchesTotal[0] + " matches; the " + reported.size()
                    + " NEAREST are reported as referents" + (asName != null
                        ? ", and all distinct anchor cells are stored in set '" + asName + "'" : "")
                    + ".");
            } else if (matchesTotal[0] == 0) {
                r.addProperty("note", proof
                    ? "No match, and the whole extent was read with clean inputs — within this "
                      + "extent that is a real negative (see search.negative_is_proof)."
                    : "No match found, but this was NOT an exhaustive read (see search.note) — "
                      + "absence is not evidence of absence.");
            }
        }

        // -- store the result set --------------------------------------------
        if (asName != null && !nothingRead) {
            String matcherSpec = anchorNode.block != null ? anchorNode.spec
                : anchorNode.set != null ? anchorNode.set.matcher
                : null; // property-only anchor: the cell predicates ARE the membership rule
            // The whole membership condition travels, parent-set predicates included, so a chain
            // never loses a constraint it was built on.
            List<CellPred> storedCells = new ArrayList<>();
            if (anchorNode.set != null) {
                storedCells.addAll(anchorNode.set.cells);
            }
            if (anchorNode.cell != null) {
                storedCells.add(anchorNode.cell);
            }
            ResultSet rs = new ResultSet(asName, level.dimension().identifier().toString(),
                matcherSpec, anchorBlockId, storedCells,
                new ArrayList<>(anchorCells), level.getGameTime(),
                chunksRead + "/" + chunksRequested + " chunks around " + cx0 + "," + cz0
                    + " r" + radius,
                chunksRead == chunksRequested && setsClean,
                membersTruncated[0] || anyCandidateCap || matchesCapped[0]);
            ledger.addSet(rs);
            JsonObject setInfo = new JsonObject();
            setInfo.addProperty("name", asName);
            setInfo.addProperty("members", rs.members.size());
            setInfo.addProperty("truncated", rs.truncated);
            setInfo.addProperty("fully_read", rs.fullyRead);
            r.add("set", setInfo);
        }
        return r;
    }

    /** Recursive join over the BFS order; returns false when the match cap aborted enumeration. */
    private static boolean enumerate(final List<PNode> nodes, final List<PRel> rels,
                                     final List<Integer> order, final int k, final Cand[] bound,
                                     final HashSet<String> seen, final int anchorIdx,
                                     final LinkedHashSet<BlockPos> anchorCells,
                                     final List<Cand[]> matches,
                                     final int[] matchesTotal, final boolean[] matchesCapped,
                                     final boolean[] membersTruncated) {
        if (k == order.size()) {
            String sig = signature(nodes, bound);
            if (!seen.add(sig)) {
                return true; // same unordered match through symmetric node labels
            }
            matchesTotal[0]++;
            if (anchorCells.size() < SET_MAX_MEMBERS) {
                anchorCells.add(bound[anchorIdx].cell());
            } else if (!anchorCells.contains(bound[anchorIdx].cell())) {
                membersTruncated[0] = true;
            }
            // Every match is kept (bounded by MATCH_CAP just below) because the `limit` cut now
            // happens AFTER ranking — keeping only the first `limit` would re-create the
            // enumeration-order bias the ranking exists to remove.
            matches.add(bound.clone());
            if (matchesTotal[0] >= MATCH_CAP) {
                matchesCapped[0] = true;
                return false;
            }
            return true;
        }
        int ni = order.get(k);
        PNode node = nodes.get(ni);
        // Relations connecting this node to already-bound ones — the join constraints.
        List<PRel> active = new ArrayList<>();
        PRel exact = null;
        for (PRel rel : rels) {
            int other = rel.a() == ni ? rel.b() : rel.b() == ni ? rel.a() : -1;
            if (other < 0 || bound[other] == null) {
                continue;
            }
            active.add(rel);
            if (exact == null && !rel.rel().equals("within")) {
                exact = rel;
            }
        }
        Iterable<Cand> pool;
        if (exact != null) {
            // An exact relation pins the cell (or six of them): candidate lookup is a hash probe,
            // not a list walk. This is what keeps the join cheap at scale.
            List<Cand> picked = new ArrayList<>();
            BlockPos partner = bound[exact.a() == ni ? exact.b() : exact.a()].cell();
            boolean nodeIsA = exact.a() == ni;
            List<BlockPos> cells = switch (exact.rel()) {
                case "above" -> List.of(nodeIsA ? partner.above() : partner.below());
                case "below" -> List.of(nodeIsA ? partner.below() : partner.above());
                case "offset" -> List.of(nodeIsA
                    ? partner.offset(exact.dx(), exact.dy(), exact.dz())
                    : partner.offset(-exact.dx(), -exact.dy(), -exact.dz()));
                default -> List.of(partner.above(), partner.below(), partner.north(),
                    partner.south(), partner.east(), partner.west());
            };
            for (BlockPos c : cells) {
                List<Cand> here = node.byCell.get(c);
                if (here != null) {
                    picked.addAll(here);
                }
            }
            pool = picked;
        } else {
            pool = node.cands; // only `within` constraints: filter the full candidate list
        }
        for (Cand cand : pool) {
            boolean ok = true;
            for (PRel rel : active) {
                BlockPos ca = rel.a() == ni ? cand.cell() : bound[rel.a()].cell();
                BlockPos cb = rel.b() == ni ? cand.cell() : bound[rel.b()].cell();
                if (!rel.holds(ca, cb)) {
                    ok = false;
                    break;
                }
            }
            if (!ok) {
                continue;
            }
            // Distinctness: a pattern's nodes are distinct things. Two cell nodes never share a
            // cell; two entity nodes never bind the same entity. Block-beside-entity may coincide.
            for (int b = 0; b < bound.length && ok; b++) {
                if (bound[b] == null || b == ni) {
                    continue;
                }
                if (node.isCellNode() && nodes.get(b).isCellNode()
                    && bound[b].cell().equals(cand.cell())) {
                    ok = false;
                } else if (!node.isCellNode() && nodes.get(b).entityTarget != null
                    && bound[b].ent() == cand.ent()) {
                    ok = false;
                }
            }
            if (!ok) {
                continue;
            }
            bound[ni] = cand;
            boolean go = enumerate(nodes, rels, order, k + 1, bound, seen, anchorIdx, anchorCells,
                matches, matchesTotal, matchesCapped, membersTruncated);
            bound[ni] = null;
            if (!go) {
                return false;
            }
        }
        return true;
    }

    /** Seed on the smallest candidate set, then BFS along relation edges (graph is connected). */
    private static List<Integer> joinOrder(final List<PNode> nodes, final List<PRel> rels) {
        int seed = 0;
        for (int i = 1; i < nodes.size(); i++) {
            if (nodes.get(i).cands.size() < nodes.get(seed).cands.size()) {
                seed = i;
            }
        }
        List<Integer> order = new ArrayList<>();
        HashSet<Integer> done = new HashSet<>();
        ArrayDeque<Integer> queue = new ArrayDeque<>();
        queue.add(seed);
        done.add(seed);
        while (!queue.isEmpty()) {
            int n = queue.removeFirst();
            order.add(n);
            for (PRel rel : rels) {
                int other = rel.a() == n ? rel.b() : rel.b() == n ? rel.a() : -1;
                if (other >= 0 && done.add(other)) {
                    queue.add(other);
                }
            }
        }
        return order;
    }

    /**
     * Unordered-match signature: nodes sharing kind+spec are interchangeable labels, so
     * "two golds adjacent" counts each physical pair once, not once per labeling.
     */
    private static String signature(final List<PNode> nodes, final Cand[] bound) {
        java.util.TreeMap<String, List<String>> groups = new java.util.TreeMap<>();
        for (int i = 0; i < nodes.size(); i++) {
            Cand c = bound[i];
            String v = c.ent() != null ? "e" + c.ent().getId()
                : c.cell().getX() + "," + c.cell().getY() + "," + c.cell().getZ();
            groups.computeIfAbsent(nodes.get(i).groupKey(), k -> new ArrayList<>()).add(v);
        }
        StringBuilder sb = new StringBuilder();
        for (var e : groups.entrySet()) {
            java.util.Collections.sort(e.getValue());
            sb.append(e.getKey()).append('=').append(e.getValue()).append(';');
        }
        return sb.toString();
    }

    /** Entity node spec: category, #tag or type id — never probed against block/POI registries. */
    private static Target parseEntityNode(final String raw) {
        String what = raw.trim();
        String lower = what.toLowerCase(java.util.Locale.ROOT);
        if (lower.startsWith("entity:")) {
            what = what.substring("entity:".length());
            lower = lower.substring("entity:".length());
        }
        if (lower.equals("hostile") || lower.equals("living") || lower.equals("item")
            || lower.equals("player")) {
            return new Target(Kind.CATEGORY, null, false, lower);
        }
        boolean tag = what.startsWith("#");
        if (tag) {
            what = what.substring(1);
        }
        Identifier id;
        try {
            id = Identifier.parse(what);
        } catch (Exception e) {
            throw new IllegalArgumentException("entity node '" + raw + "' is not a valid id, #tag "
                + "or category (hostile|living|item|player)");
        }
        if (!tag && BuiltInRegistries.ENTITY_TYPE.get(id).isEmpty()) {
            throw new IllegalArgumentException("unknown entity type '" + raw
                + "' — use query_registry to find the right id");
        }
        return new Target(Kind.ENTITY, id, tag, null);
    }

    private static void requireConnected(final List<PNode> nodes, final List<PRel> rels) {
        if (nodes.size() <= 1) {
            return;
        }
        HashSet<Integer> reach = new HashSet<>();
        ArrayDeque<Integer> queue = new ArrayDeque<>();
        queue.add(0);
        reach.add(0);
        while (!queue.isEmpty()) {
            int n = queue.removeFirst();
            for (PRel rel : rels) {
                int other = rel.a() == n ? rel.b() : rel.b() == n ? rel.a() : -1;
                if (other >= 0 && reach.add(other)) {
                    queue.add(other);
                }
            }
        }
        if (reach.size() < nodes.size()) {
            List<String> stranded = new ArrayList<>();
            for (int i = 0; i < nodes.size(); i++) {
                if (!reach.contains(i)) {
                    stranded.add(nodes.get(i).id);
                }
            }
            throw new IllegalArgumentException("pattern is disconnected — node(s) " + stranded
                + " have no relation path to '" + nodes.get(0).id + "'. A disconnected pattern "
                + "is a cross product, not a spatial question; relate every node.");
        }
    }

    /** Compact human-readable pattern descriptor for the search ledger. */
    private static String patternSummary(final List<PNode> nodes, final List<PRel> rels) {
        StringBuilder sb = new StringBuilder("pattern[");
        for (int i = 0; i < nodes.size(); i++) {
            if (i > 0) {
                sb.append(' ');
            }
            PNode n = nodes.get(i);
            sb.append(n.id).append(':')
              .append(n.set != null ? "set " + n.set.name : n.spec);
            if (n.cell != null) {
                sb.append(n.cell.summary());
            }
        }
        for (PRel rel : rels) {
            sb.append("; ").append(rel.rel()).append('(').append(nodes.get(rel.a()).id)
              .append(',').append(nodes.get(rel.b()).id);
            if (rel.rel().equals("offset")) {
                sb.append(',').append(rel.dx()).append(',').append(rel.dy()).append(',').append(rel.dz());
            } else if (rel.rel().equals("within")) {
                sb.append(",r").append(rel.r());
            }
            sb.append(')');
        }
        return sb.append(']').toString();
    }

    private static @Nullable String optStr(final JsonObject o, final String key) {
        return o.has(key) && !o.get(key).isJsonNull() ? o.get(key).getAsString() : null;
    }

    // ---- relations -----------------------------------------------------------

    /**
     * The anchors a find is related against: pinned first (most recent pinned first), then most
     * recently located, capped at {@link #RELATE_MAX} and confined to this level. Volatile anchors
     * are re-resolved here, so a relation is against where a mob is <em>now</em>.
     */
    private static List<Anchor> selectAnchors(final Ledger ledger, final ServerLevel level) {
        String dim = level.dimension().identifier().toString();
        List<Anchor> all = new ArrayList<>(ledger.anchors.values());
        java.util.Collections.reverse(all); // most recent first
        List<Anchor> picked = new ArrayList<>();
        for (boolean pinnedPass : new boolean[] {true, false}) {
            for (Anchor an : all) {
                if (picked.size() >= RELATE_MAX) {
                    return picked;
                }
                if (an.pinned != pinnedPass || !an.dimension.equals(dim) || picked.contains(an)) {
                    continue;
                }
                refresh(an, level);
                picked.add(an);
            }
        }
        return picked;
    }

    /** Re-read a volatile anchor from the world; a gone entity keeps its last position, flagged. */
    private static void refresh(final Anchor an, final ServerLevel level) {
        if (an.uuid == null) {
            return;
        }
        Entity e = level.getEntity(an.uuid);
        if (e != null && e.isAlive()) {
            BlockPos p = e.blockPosition();
            an.x = p.getX();
            an.y = p.getY();
            an.z = p.getZ();
            an.tick = level.getGameTime();
            an.stale = false;
        } else {
            an.stale = true;
        }
    }

    private static JsonArray relations(final BlockPos at, final boolean yKnown,
                                       final @Nullable Vec3 obs, final List<Anchor> refs) {
        JsonArray arr = new JsonArray();
        if (obs != null) {
            arr.add(relation("you", at.getX() - obs.x, at.getY() - obs.y, at.getZ() - obs.z,
                yKnown, null));
        }
        for (Anchor an : refs) {
            if (an.x == at.getX() && an.y == at.getY() && an.z == at.getZ()) {
                continue; // the anchor IS this find
            }
            arr.add(relation(an.handle, at.getX() - an.x, at.getY() - an.y, at.getZ() - an.z,
                yKnown && an.yKnown, an));
        }
        return arr;
    }

    private static JsonObject relation(final String to, final double dx, final double dy,
                                       final double dz, final boolean dyKnown,
                                       final @Nullable Anchor an) {
        JsonObject o = new JsonObject();
        o.addProperty("to", to);
        String bearing = Affordances.bearing(dx, dz);
        if (bearing != null) {
            o.addProperty("bearing", bearing);
        }
        // HORIZONTAL, and named so it can never be confused with get_entities' 3D `distance`. A
        // landmark relation is a map relation ("200 west and 12 up"); a 3D figure here would be
        // dominated by the vertical whenever the observer's y is an assumption rather than an eye
        // position — 20 blocks away reading as 238 was the live defect that produced this rule.
        o.addProperty("map_distance", Math.round(Math.sqrt(dx * dx + dz * dz) * 10.0) / 10.0);
        if (dyKnown) {
            o.addProperty("dy", (int) Math.round(dy));
        }
        if (an != null && an.stale) {
            o.addProperty("stale", true);
            o.addProperty("note", "anchor is gone from the world; related against its last known position");
        }
        return o;
    }

    // ---- anchors tool --------------------------------------------------------

    private static JsonObject anchors(final MinecraftServer server, final JsonObject a,
                                      final @Nullable String session) {
        Ledger ledger = ledgerFor(session);
        ServerLevel level = server.overworld();
        JsonObject r = new JsonObject();
        JsonArray acted = new JsonArray();

        if (a.has("pin") && !a.get("pin").isJsonNull()) {
            String h = a.get("pin").getAsString();
            Anchor an = ledger.anchors.get(h);
            if (an == null) {
                throw new IllegalArgumentException("no anchor with handle '" + h
                    + "' — call anchors with no arguments to list them");
            }
            an.pinned = true;
            acted.add("pinned " + h);
        }
        if (a.has("drop") && !a.get("drop").isJsonNull()) {
            String h = a.get("drop").getAsString();
            acted.add(ledger.anchors.remove(h) != null ? "dropped " + h
                : ledger.sets.remove(h) != null ? "dropped set " + h
                : ledger.regions.remove(h) != null ? "dropped region " + h
                : "no such anchor, set or region: " + h);
        }
        if (a.has("clear") && !a.get("clear").isJsonNull() && a.get("clear").getAsBoolean()) {
            int before = ledger.anchors.size();
            ledger.anchors.values().removeIf(an -> !an.pinned);
            int sets = ledger.sets.size();
            int regions = ledger.regions.size();
            ledger.sets.clear();
            ledger.regions.clear();
            acted.add("cleared " + (before - ledger.anchors.size()) + " unpinned anchor(s), "
                + sets + " set(s) and " + regions + " region(s)");
        }
        if (!acted.isEmpty()) {
            r.add("actions", acted);
        }
        // Read-out comes before the ledger listing: it is the answer when it was asked for, and the
        // ledger below is context. `drop`+`show` in one call reads the set that is still there.
        if (optStr(a, "show") != null) {
            r.add("set_members", showSet(server, ledger, a.get("show").getAsString(),
                optInt(a, "from", 0), session));
        }

        long tick = level.getGameTime();
        JsonArray arr = new JsonArray();
        List<Anchor> all = new ArrayList<>(ledger.anchors.values());
        java.util.Collections.reverse(all);
        for (Anchor an : all) {
            ServerLevel own = server.getLevel(net.minecraft.resources.ResourceKey.create(
                Registries.DIMENSION, Identifier.parse(an.dimension)));
            if (own != null) {
                refresh(an, own);
            }
            JsonObject o = new JsonObject();
            o.addProperty("handle", an.handle);
            o.addProperty("kind", an.kind);
            o.addProperty("id", an.id);
            o.add("pos", an.yKnown ? pos(new BlockPos(an.x, an.y, an.z))
                : posNoY(new BlockPos(an.x, an.y, an.z)));
            o.addProperty("dimension", an.dimension);
            o.addProperty("age_ticks", Math.max(0, tick - an.tick));
            if (an.pinned) {
                o.addProperty("pinned", true);
            }
            if (an.isVolatile()) {
                o.addProperty("volatile", true);
            }
            if (an.stale) {
                o.addProperty("stale", true);
            }
            arr.add(o);
        }
        r.add("anchors", arr);

        if (!ledger.sets.isEmpty()) {
            JsonArray setArr = new JsonArray();
            List<ResultSet> allSets = new ArrayList<>(ledger.sets.values());
            java.util.Collections.reverse(allSets);
            for (ResultSet s : allSets) {
                JsonObject o = new JsonObject();
                o.addProperty("name", s.name);
                o.addProperty("matcher", s.spec());
                o.addProperty("members", s.members.size());
                o.addProperty("dimension", s.dimension);
                o.addProperty("age_ticks", Math.max(0, tick - s.tick));
                o.addProperty("extent", s.extent);
                if (!s.fullyRead) {
                    o.addProperty("fully_read", false);
                }
                if (s.truncated) {
                    o.addProperty("truncated", true);
                }
                setArr.add(o);
            }
            r.add("sets", setArr);
        }

        if (!ledger.regions.isEmpty()) {
            JsonArray regionArr = new JsonArray();
            List<Region> all2 = new ArrayList<>(ledger.regions.values());
            java.util.Collections.reverse(all2);
            for (Region g : all2) {
                JsonObject o = new JsonObject();
                o.addProperty("name", g.name);
                o.addProperty("box", g.describe());
                o.addProperty("volume", g.volume());
                o.addProperty("dimension", g.dimension);
                o.addProperty("age_ticks", Math.max(0, tick - g.tick));
                regionArr.add(o);
            }
            r.add("regions", regionArr);
        }

        // The search log is the honest half: it is what makes a remembered negative interpretable.
        // Bounded on purpose — an unbounded ledger read would re-create the context problem.
        JsonArray searches = new JsonArray();
        List<JsonObject> recent = new ArrayList<>(ledger.searches);
        int from = Math.max(0, recent.size() - SHOWN_SEARCHES);
        for (int i = recent.size() - 1; i >= from; i--) {
            searches.add(recent.get(i));
        }
        r.add("searches", searches);
        if (from > 0) {
            r.addProperty("searches_older", from);
        }
        r.addProperty("note", "Anchors are this session's named referents, not a world model: "
            + "positions are re-read on use and the ledger is discarded when the session or the "
            + "world ends. `searches` records what was looked for and whether a miss was proof."
            + (ledger.sets.isEmpty() ? "" : " A set's `members` is a COUNT, not its contents — "
                + "`anchors show:<name>` reads the positions out, re-verified against the world."));
        return r;
    }

    /**
     * {@code anchors show:} — read a stored result set out, member by member (LOCATE_ROUTES.md C2).
     *
     * <p><b>Why this door exists.</b> A pattern search that finds 40 chests reports 8 of them as
     * referents and stores all 40 as a set; before this, the other 32 could be fed to a later
     * pattern and never <em>read</em>. So "list every chest in this village" had no route at all,
     * even though the tool had already found every chest. The referent cap is right for landmarks
     * and wrong for enumeration — two doors, not a bigger cap.
     *
     * <p><b>Members are re-tested, never recited.</b> Same rule as a set node in a pattern: each
     * cell in the page is re-read and re-matched now, so a mined chest comes back under
     * {@code dropped} instead of being listed as if it were still there, and one that cannot be
     * read is counted as {@code unverifiable} rather than assumed either way. That is also why the
     * page is bounded: it bounds the re-read, not just the text.
     *
     * <p><b>Order is the sweep that created the set</b>, not distance — deliberately, because
     * paging needs a stable key and the observer moves between calls. Each row still carries its
     * own bearing/distance, so "which of these is nearest" is answerable from the page; what is not
     * answerable is "the nearest overall" from page 1 alone, and the note says so (the same
     * corner-bias caveat as the set's own truncation, C4).
     */
    private static JsonObject showSet(final MinecraftServer server, final Ledger ledger,
                                      final String name, final int fromArg,
                                      final @Nullable String session) {
        ResultSet s = ledger.sets.get(name);
        if (s == null) {
            throw new IllegalArgumentException("no result set named '" + name + "'"
                + (ledger.sets.isEmpty()
                   ? " — nothing stored yet; a pattern search with `as` creates one"
                   : " — stored sets: " + String.join(", ", ledger.sets.keySet())));
        }
        if (fromArg < 0) {
            throw new IllegalArgumentException("`from` must be 0 or more");
        }
        ServerLevel level = server.getLevel(net.minecraft.resources.ResourceKey.create(
            Registries.DIMENSION, Identifier.parse(s.dimension)));
        if (level == null) {
            throw new IllegalStateException("the dimension this set was recorded in ("
                + s.dimension + ") is not loaded, so its members cannot be re-verified");
        }
        int total = s.members.size();
        int start = Math.min(fromArg, total);
        int end = Math.min(total, start + SET_SHOW_MAX);

        // Relations come from wherever the caller is — their body first, else a player, else
        // nowhere. A member list is worth having without an observer, so this never throws.
        WorldPerceptionTools.Origin o = null;
        try {
            JsonObject originArgs = new JsonObject();
            if (com.mattmc.mcptoolkit.drone.DroneTools.activeBodyFor(session) != null) {
                originArgs.addProperty("drone", true);
            }
            o = WorldPerceptionTools.resolveOrigin(originArgs, server, session);
        } catch (RuntimeException ignored) {
            o = null;
        }
        Vec3 obs = o != null && o.level() == level ? o.eye() : null;

        net.minecraft.core.HolderLookup<net.minecraft.world.level.block.Block> lookup =
            server.registryAccess().lookupOrThrow(Registries.BLOCK);
        BlockTools.@Nullable Matcher matcher = s.matcher == null
            ? null : BlockTools.parseMatcher(lookup, s.matcher);
        ReadSupport.ChunkLoader loader = new ReadSupport.ChunkLoader(level, true);
        LightGate lightGate = new LightGate(level);

        JsonArray rows = new JsonArray();
        JsonArray dropped = new JsonArray();
        int unverifiable = 0;
        for (int i = start; i < end; i++) {
            BlockPos m = s.members.get(i);
            if (!loader.ensure(m) || s.needsLight() && !lightGate.ok(m)) {
                unverifiable++;
                continue;
            }
            // The WHOLE membership rule is re-tested, cell properties included — a set of dark cells
            // read back as merely "air cells" would hand out positions someone has since lit.
            if (matcher != null && !matcher.test(level, m) || !s.cellsOk(level, m)) {
                dropped.add(cellRow(m));
                continue;
            }
            JsonArray row = cellRow(m);
            if (obs != null) {
                double dx = m.getX() - obs.x;
                double dz = m.getZ() - obs.z;
                String bearing = Affordances.bearing(dx, dz);
                row.add(bearing == null ? "here" : bearing);
                row.add(Math.round(Math.sqrt(dx * dx + dz * dz) * 10.0) / 10.0);
                row.add((int) Math.round(m.getY() - obs.y));
            }
            rows.add(row);
        }

        JsonObject r = new JsonObject();
        r.addProperty("set", s.name);
        r.addProperty("matcher", s.spec());
        r.addProperty("dimension", s.dimension);
        r.addProperty("stored", total);
        r.addProperty("from", start);
        r.addProperty("shown", rows.size());
        r.addProperty("age_ticks", Math.max(0, level.getGameTime() - s.tick));
        JsonArray columns = new JsonArray();
        columns.add("x");
        columns.add("y");
        columns.add("z");
        if (obs != null) {
            columns.add("bearing");
            columns.add("map_distance");
            columns.add("dy");
        }
        r.add("columns", columns);
        r.add("rows", rows);
        r.addProperty("source", o == null ? "none (no observer — bearings omitted)"
            : obs == null ? "observer is in another dimension — bearings omitted" : o.label());
        if (!dropped.isEmpty()) {
            r.addProperty("stale_dropped", dropped.size());
            r.add("dropped", dropped);
        }
        if (unverifiable > 0) {
            r.addProperty("unverifiable", unverifiable);
            r.addProperty("unverifiable_cause", loader.shortfallReason());
        }
        if (end < total) {
            r.addProperty("next_from", end);
        }
        r.addProperty("extent", s.extent);
        if (!s.fullyRead) {
            r.addProperty("fully_read", false);
        }
        if (s.truncated) {
            r.addProperty("truncated", true);
        }
        // The enumeration counterpart of negative_is_proof: whether "these are all of them" is a
        // claim this page can support. Every way it can fail is a different lie, so each is named.
        boolean whole = start == 0 && end == total;
        boolean complete = whole && s.fullyRead && !s.truncated && unverifiable == 0;
        r.addProperty("complete_enumeration", complete);
        StringBuilder note = new StringBuilder();
        if (!complete) {
            note.append("NOT a complete enumeration: ");
            if (!whole) {
                note.append("this is members ").append(start).append("..").append(end - 1)
                    .append(" of ").append(total)
                    .append(end < total ? " — page on with from:" + end + "; " : "; ");
            }
            if (!s.fullyRead) {
                note.append("the search that built this set could not read its whole extent; ");
            }
            if (s.truncated) {
                note.append("the set hit the ").append(SET_MAX_MEMBERS)
                    .append("-member cap when it was created, and the members kept were the first "
                        + "in sweep order (a corner bias, not the nearest ones); ");
            }
            if (unverifiable > 0) {
                note.append(unverifiable).append(" member(s) could not be re-read just now; ");
            }
        }
        note.append("Members are listed in the order the scan found them, NOT by distance — each "
            + "row carries its own bearing, but the nearest member overall is only knowable from a "
            + "whole set. Every position was re-tested against '").append(s.spec())
            .append("' as the world is NOW: anything under `dropped` matched when the set was made "
                + "and does not any more. A set is what matched THEN over the extent above, so "
                + "'complete' means complete for that search — a block that appeared since is not "
                + "a member; re-run the search to ask about now.");
        r.addProperty("note", note.toString());
        return r;
    }

    // ---- helpers -------------------------------------------------------------

    /** A member row: [x,y,z], the compact form the `at` direction already uses for cell lists. */
    private static JsonArray cellRow(final BlockPos p) {
        JsonArray row = new JsonArray();
        row.add(p.getX());
        row.add(p.getY());
        row.add(p.getZ());
        return row;
    }

    private static int clampRadius(final JsonObject a, final int def, final int max) {
        int r = optInt(a, "radius", def);
        if (r < 1) {
            throw new IllegalArgumentException("radius must be at least 1");
        }
        return Math.min(r, max);
    }

    private static int optInt(final JsonObject a, final String k, final int def) {
        return a.has(k) && !a.get(k).isJsonNull() ? a.get(k).getAsInt() : def;
    }

    /**
     * Scan ranking metric: squared distance from the observer to a match cell — 3D when the
     * observer's y is real, horizontal when it is an assumption (see the call site in
     * patternSearch, and findEntities for why the default is horizontal).
     */
    private static double rankDistance(final BlockPos cell, final Vec3 from, final boolean yTrusted) {
        double dx = cell.getX() + 0.5 - from.x;
        double dz = cell.getZ() + 0.5 - from.z;
        double flat = dx * dx + dz * dz;
        if (!yTrusted) {
            return flat;
        }
        double dy = cell.getY() + 0.5 - from.y;
        return flat + dy * dy;
    }

    /** Horizontal (map) distance squared — the ranking metric, see findEntities/findPoi. */
    private static double horizSqr(final BlockPos p, final BlockPos c) {
        double dx = p.getX() - c.getX();
        double dz = p.getZ() - c.getZ();
        return dx * dx + dz * dz;
    }

    /** Position whose height is genuinely unknown (structure placement resolves a column only). */
    private static JsonObject posNoY(final BlockPos p) {
        JsonObject o = new JsonObject();
        o.addProperty("x", p.getX());
        o.add("y", null);
        o.addProperty("z", p.getZ());
        o.addProperty("y_note", "structure placement resolves a column, not a height");
        return o;
    }

    private static JsonObject pos(final BlockPos p) {
        JsonObject o = new JsonObject();
        o.addProperty("x", p.getX());
        o.addProperty("y", p.getY());
        o.addProperty("z", p.getZ());
        return o;
    }
}
