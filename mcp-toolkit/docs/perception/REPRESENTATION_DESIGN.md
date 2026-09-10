# Representation Upgrades — Implementation Design

> **STATUS 2026-07-23: EXECUTED** except §4 `judge_build` (recipe below remains the plan; was
> blocked on Blockbench not running during the build session). Everything else shipped and
> live-verified — see the dated status block in TODO.md for commits, probe counts, and the
> measured rollup timings that closed open question 2 (no cache). Do not re-execute; this doc is
> now the rationale record for what was built.

Written 2026-07-22, end of the world-representation research session. This is the build plan for the
research shortlist; execute from here in a cold session. Evidence and mismatch analysis live in
**RESEARCH_WORLD_REPRESENTATION.md** (do not re-litigate them here); ARCHITECTURE.md remains the
authority on vocabulary, contracts, and the don't-build list. Code facts below were validated
against the actual source on 2026-07-22 (two Explore sweeps) — file/line refs are from that day.

## Decisions locked this session (Matthijs)

1. Toolkit predicate set is **fit / clearance / path / site** — four, all game-generic.
   `check_connected` (road-graph connectivity) is **NOT a toolkit tool**: road graphs are
   villagejobs game logic (the roads TODO in the root TODO.md), built inside the repair job; if the
   copilot ever needs to see connectivity, VJ exposes a VJ-registered bridge tool (precedent:
   `check_path` is VJ-registered today).
2. Region rollup is **derived on demand, no persistent cache** in v1. A cache is considered only if
   measured per-query latency actually hurts (research open question 2).
3. `mem_locate` is **narrowed**: `mem_recall` already has center+radius spatial filtering
   (validated); build only the concept→location direction. Bucket index deferred.
4. `judge_build` v1 renders **via Blockbench** (pipeline verified end-to-end this session, see §5).
5. Testbench stays **small** with a deliberate easy→hard difficulty gradient (spec in
   mcp-toolkit/TODO.md §Testbench).
6. The small doc/charter changes (§7) are approved — ship as one commit.

## Step 0 — precondition: promote the read-support helpers (do this first)

`WorldPerceptionTools` privately owns the machinery every new observe tool needs. Validated state:

- `ChunkLoader` — private static nested class, `WorldPerceptionTools.java:1564-1656`. Budgets:
  `LOAD_MAX_CHUNKS=48` (:1527), `LOAD_BUDGET_NANOS=1.5s` (:1533); refuses ungenerated chunks
  (probes `ChunkStatus.EMPTY`, requires `isOrAfter(FULL)`, :1605-1613); self-expiring `READ_TICKET`
  (:1544-1545). API: `ensure(BlockPos)→boolean`, `report()→{resident,paged_in,ungenerated}`,
  `shortfallReason()`.
- `coverage(read, unloaded, requested, truncated, loader)` — private static,
  `WorldPerceptionTools.java:1742-1787`, emits `{requested, read, unloaded, chunks?, unvisited,
  state, note?}`.
- Also private: `clampToReadable(loader,from,to)` (:1716), `walkChunks` (:1674).

**Task:** move these to a shared package-level util (suggestion: `perception/ReadSupport.java`,
same package so nothing else moves), byte-identical behavior, `WorldPerceptionTools` delegates.
**Regression gate:** `npm run test:live` perception-coverage + review-fixes probes pass unchanged.
Every tool below depends on this step.

## 1. Predicates (mod-side, all `Mechanism.OBSERVE`)

Shared rules: every response carries the observation envelope (`game_tick`, `perception_mode:
"spatial"`, dimension) + `coverage`; a verdict is NEVER issued over unread space — if any queried
cell is unloaded/ungenerated, the verdict field is `null` with `coverage.state: partial` and the
note naming the remedy (same philosophy as `get_blocks_at`'s `-1`). Optional `dimension` arg
(default overworld) like the write tools. Register in a new `PredicateTools.java`.

### 1a. `check_fit`
Args: `{at:{x,y,z}, size:{w,h,d}} | {at, template:"villagejobs:..."}`, optional
`clearance:{above?:int, margin?:int}`, `dimension`.
Semantics: every cell in the footprint (plus clearance shell if given) must be air or
`canBeReplaced()` — the exact predicate of `SiteCheck.clear` (`build/SiteCheck.java:67-70`; take
the logic, don't import VJ from toolkit). Template form resolves size via the template manager
(`level.getStructureManager().get(id)` — NOTE: that method is the *template store*;
world-placed structure starts are `chunk.getAllStarts()`, don't confuse, validated 2026-07-22).
Returns: `{fits:bool|null, conflicts:[{x,y,z,block}...capped 16], conflict_count, region, coverage}`.
Cap footprint volume (suggest 64×64×64 = fail-fast `too_large`, not truncate — a fit verdict over a
truncated footprint is worthless).

### 1b. `check_clearance`
Args: `{from:{x,y,z}, to:{x,y,z}, profile:{w,h}}` — is there a clear w×h corridor along the
axis-aligned segment (or straight-line voxel walk). Returns first obstruction + count, same
envelope rules. (This is the "can I fly the drone through / does the door have headroom" read.)

### 1c. `check_path` — promote + generalize
Exists today as `VillageJobsTools.checkPath` (`VillageJobsTools.java:247-274`): spawns a throwaway
`Villager` via `EntityTypes.VILLAGER.spawn`, `setOnGround(true)` (works around `createPath`
returning null off-ground — keep this), `getNavigation().createPath(to, 0)`, `discard()` in
finally. Returns `reachable` (path!=null && `canReach()`), `partial`, `nodes`, `end`.
**Task:** move the mechanism into mcp-toolkit `PredicateTools` with a `body` arg:
`walker` (villager-sized ground walker, the default), `flyer` (drone: `FlyingPathNavigation` —
DroneEntity's own nav class), later `player` if a scenario needs it. VJ keeps a thin
`check_path` alias or drops its registration (breaking-change note in the manifest either way;
bump toolkit version — 0.3.0→0.4.0 rule: bump every release touching mcp-server/).
Add `max_length` arg (path length cap; the throwaway-entity cost is per-call, fine).

### 1d. `check_site` — the genuinely new math
No flatness/height-variance helper exists anywhere in the codebase (validated — VJ site selection
is clearance-only, player-chosen). Args: `{at:{x,z}, size:{w,d}, y?:int}`.
Computes over the footprint columns via `getHeight(MOTION_BLOCKING_NO_LEAVES, x, z)` (the Roads.java
pattern): `{ground_y:{min,max,mean,stddev}, flat_enough_hint, cut:volumeAboveTargetY,
fill:volumeBelowTargetY, surface:{top-block histogram}, fluids:{water_columns,lava_columns},
target_y}` where `target_y` = arg `y` or the height-mode. Cut/fill = per-column
`|h - target_y|` sums — the number a builder actually needs ("how much terrain work is this
site"). No verdict field beyond the stats + a `flat_enough_hint` (stddev threshold, labeled hint —
the *decision* stays with the planner; we serve arithmetic, not judgment).
First consumer: VJ site selection; second: the copilot's own build placement.

**Explicit non-goals:** no `check_connected` (see decision 1); no enclosure/mob-proof predicate yet
(add when a scenario needs it — don't speculate the taxonomy).

**Verification:** probe suite `mcp-server/probes/predicates.test.mjs` — staged terrain via
`set_blocks`, assert fit/no-fit, clearance hit, path reachable/partial/unreachable (wall it off),
site stats against hand-computed values, and the unloaded-area null-verdict behavior (forceload
strips pattern, ≤256/command).

## 2. Region rollup — `get_region_summary` (mod-side, `OBSERVE`)

Nothing aggregates beyond ~2 chunks today (validated: `scene_summary` = 25×25 columns via
`SCENE_GRID=12`; `scan_box` caps at 32³; `surfaceHistogram` is the reusable histogram piece at
`WorldPerceptionTools.java:340-376`). This is a new rung, one level above `scene_summary`.

Args: `{center:{x,z} | bounds, tiles:int (default 3 → 3×3 grid), tile_chunks:int (default 4 →
64×64 blocks/tile), dimension?}`. Hard cap total chunks per call (suggest 256) — fail-fast, don't
silently shrink.

Per tile, computed per query (no cache — decision 2):
- `height {min,max,mean,stddev}` + `surface` top-N histogram — heightmap samples at stride 4
  (256 columns/tile), the same numbers `check_site` uses (shared helper — write once).
- `fluids {water,lava}` column counts (top-block check).
- `structures: [names]` — `level.getChunkSource().getChunkNow(cx,cz)` → `chunk.getAllStarts()` →
  `Map<Structure,StructureStart>` (the `VillageManager.java:555-570` pattern; `authoritative` mode).
- `poi_count` (+ optional breakdown) — `level.getPoiManager()` (`VillageManager.java:520-522`
  pattern) — the "village-ness" signal.
- `entities {players,hostile,passive,items}` — one AABB query per tile.
- `biomes` — sampled mix (biomes are 4×4×4 cells; 16 samples/tile suffice).

Response: `tiles:[{tile:{x,z}, ...fields}]`, region-level `sentence` (leads with the coverage
caveat when partial — same rule as `scene_summary`), full envelope + `coverage` where
`requested/read/unloaded/unvisited` count CHUNKS. Unloaded tiles are listed with
`state:"unread"`, never synthesized. Paging rides the promoted `ChunkLoader` budget; ungenerated
chunks counted and named, `forceload` stays the audited remedy (ARCHITECTURE §reads-never-generate).

Rollup vocabulary is semantic (structure names, biome names, block names) — models anchor on
meaningful labels (FloorplanQA label-permutation finding).

**Verification:** probe with a staged known world region; assert tile stats, structure detection
over a placed village piece, honest unloaded-tile reporting; measure wall-clock per call (this
number decides the cache question — record it in the probe output).

## 3. `mem_locate` (Node-side only)

Narrowed scope (validated 2026-07-22): `mem_recall` already filters by `center`+`radius`
(3D Euclidean `inSpace`, `store.mjs:626-631`; schema `tools.mjs:256-263`); records carry `pos`,
`bounds`, `chunk`, `region` (`r.x.z`, 32×32 chunks) tags. Missing is the reverse direction only.

Build: a `locate(concept)` method on `MemoryStore` (`mcp-server/memory/store.mjs`, class at :132) +
`mem_locate` registration in `tools.mjs`: lexical(+semantic when calibrated) match over
places/blocks/entries → return matching places (id, name, pos, dim, last-verified tick) +
**centroid + spread** (max distance from centroid) + the region tags involved; rendered summary
within the existing token budget. Multi-cluster concepts (two "farms"): report per-region clusters,
don't average across dimensions — never merge positions from different `dim`.
Staleness: echo `discovered_tick`/verification state; recommend `mem_verify` in the render when
stale (the osmAG recheck pattern is already our pattern).
Deferred: region-bucket acceleration index in `#resyncRecords` (:820-838) — only when linear scan
measurably hurts. Note existing backlog items in TODO.md §Node/memory (results-cap, tick_range
places bug) — fix those first if touching recall paths.

**Verification:** extend probe suite: seeded corpus, "where is X" for unique / multi-cluster /
absent concepts (absent must say absent, not nearest-match), token budget respected.

## 4. `judge_build` (client-channel; v1 = Blockbench, zero mod code)

Pipeline **verified end-to-end 2026-07-22** on `lumberjack_1.nbt` (163 textured cubes, correct
oak/hay/workstation-with-axe render). Recipe (automate as a script in `mcp-server/` or the sync
plugin):

1. Assets (one-time per MC version): extract from
   `~/.gradle/caches/fabric-loom/<ver>/minecraft-client.jar` →
   `assets/minecraft/{blockstates,models,textures/block,textures/item}` (item textures ARE needed —
   workstations reference them; missing texture = hard error). Second asset root:
   `src/main/resources/assets` (villagejobs blocks — resolved correctly in the verified run).
2. Blockbench side (via mcp bridge `risky_eval`): Structure Importer store plugin (id
   `structure_importer`, installed 2026-07-22). Headless import without dialogs:
   `globalThis.require = require` once (plugin eval scope lacks it); indirect-eval the plugin file
   (`%APPDATA%\Blockbench\plugins\structure_importer.js` — top-level vars, not an IIFE, so
   `(0,eval)(src)` exposes `StructureBuilder` + `nbt`); then `newProject(Formats.free)`,
   `new StructureBuilder()` with `scale=16`, `assetPaths=[mcAssets, vjAssets]`,
   `nbt.parse(fs.readFileSync(nbtPath), cb)` → `sb.buildStructure(data)`.
   `getAssetsPath` accepts paths ending in `\assets`.
3. Cameras: compute bounds from `Cube.all` (import scale is arbitrary — bounds came out 5×3×6 for
   the lumberjack yard); `set_camera_angle` at 3–4 perspectives (two opposite 3/4 views, one
   elevated overview, one interior if applicable) + `capture_screenshot` each.
4. Judge: the copilot itself reads the screenshots against **explicit criteria** (MCU pattern —
   criteria in, per-dimension verdicts out): proportions/silhouette, palette coherence, detailing,
   site integration (v1: n/a for isolated templates), function (does a lumberjack yard read as
   one). Output structured: per-criterion score + one-line rationale + a ranking verdict when
   judging multiple candidates.

Contract boundaries (from verified evidence, non-negotiable): ranking/flagging, not fine-grained
absolute scores (creativity correlation 0.63); never GUI reads (`get_screen` stays authoritative);
judgments are summarized to TEXT before anything persists — screenshots never enter memory.
Known render caveats (fine for judging, note in output): grass/foliage untinted (no biome
colormap), arbitrary scale, no sky/lighting context.
v2 (later): in-game multi-angle screenshots for placed builds in context (player-camera or, if a
benchmark ever justifies it, the off-screen drone render — still gated per ARCHITECTURE).

**Verification:** the shortlist ablation — judge N builds Matthijs also rates; per-criterion
agreement decides which dimensions the tool may report.

## 5. Testbench

Spec + sizing live in **mcp-toolkit/TODO.md §Testbench** (categories A spatial / B formats /
C memory; small; difficulty gradient; fresh-session quiz rule; metrics; manifest). Implementation
notes beyond that spec:
- Question generation is programmatic: sample POIs/paths from the staged world, compute ground
  truth server-side (`get_blocks_at`, `check_path` once built — the bench and the predicates
  co-validate).
- Store per-run results like `ablation-results/` (manifest: model, toolkit version, feature flags,
  seed, question set hash).
- Category B serializers can be pure Node-side re-renderings of one `get_blocks`/`get_blocks_at`
  response — no mod changes needed for the format arm.
- Build AFTER predicates step 0/1 (bench wants `check_path` for reachability ground truth).

## 6. Sequencing

1. **Step 0** helper promotion (small refactor, gates everything).
2. **Predicates** (§1) + probes — `check_path` promotion first (mechanism exists), then fit/
   clearance, then site.
3. **Testbench slice A+B** (§5) — now measurable.
4. **`mem_locate`** (§3) — independent, Node-only, can go anytime.
5. **Region rollup** (§2) — biggest new surface; bench before/after run is its acceptance test.
6. **`judge_build`** (§4) — independent; script the Blockbench pipeline when wanted.
7. §7 doc commit — anytime, ideally first (it's one commit).

## 7. Small doc changes (one commit, approved)

- **Charter/tool docs**: add "coordinates are for reading, not arithmetic — for geometry derived
  from coordinates (distance, fit, intersection) use a `check_*` predicate or compute in code"
  to the charter template and the `get_blocks`/`get_blocks_at` descriptions.
- **Charter**: add "visual observations never persist as images — summarize to text before
  filing anything in memory."
- **ARCHITECTURE.md don't-build list**, two rows:
  - "Opaque/numeric block palettes (token-saving) — semantic `id[state]` labels are load-bearing
    for model spatial reasoning (label-permutation evidence, RESEARCH_WORLD_REPRESENTATION.md);
    also: no serialization-format switch without a local Category-B bench measurement."
  - "Dense set-of-marks on renders — if an annotated render ever ships: few sparse server-truth
    marks, IDs mapping to real entity/block refs, VLM proposes over mark IDs and the symbolic
    layer grounds/executes, marks visually distinct from world content (signs/item counts)."
- **ARCHITECTURE.md provenance**: one line pointing at RESEARCH_WORLD_REPRESENTATION.md as
  external evidence for the don't-build list (mirror/confidence-scores/query-on-demand entries).
