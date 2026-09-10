# `locate` — the route audit

Status: audited 2026-07-29 (this doc); eight fixes BUILT — A1/B1/C1 + A4's note in toolkit 0.29.0,
then **A2 + C2 in 0.30.0**, **B5's light/sky/spawn half in 0.31.0**, and **D3 + D2 in toolkit 0.32.0 /
mcp-server 0.10.4** (the region arity: `at` + `dx/dy/dz`, named regions, `in:` — Matthijs's design,
2026-07-30, §Fixed). Compiles, 88/88
offline probes green, **live probes for all of it written and NOT yet run**: the changes are
structural, so hotswap cannot carry them into a running dev server, and as of 2026-07-30 a bench is
occupying the dev server — the pending live pass needs a restart and then covers all three builds at
once. Every bump changes the manifest, so `tools_hash` moves: bench rows from before and after must
not be pooled (`testbench/resume.mjs` treats that drift as fatal, by design). Authority: ARCHITECTURE.md §locate for doctrine, PATTERN_SEARCH_DESIGN.md for
pattern/set semantics, this doc for **which questions the tool can and cannot route at all**.

`locate` is the survey front door: since 2026-07-29 the default profile is `standard`
(`mcp-server/index.mjs`), which withholds `get_surface` / `get_blocks_at` / `describe_box` on the
measured 1:1 substitution — so a question `locate` cannot route is, by default, a question the
session cannot ask. That raises the price of a missing route from "inconvenient" to "unanswerable",
which is why this audit exists.

## The routes that exist

| direction | target | mechanism | negative is proof? |
|---|---|---|---|
| `what` | structure id / `structure:#tag` | worldgen placement (`findNearestMapStructure`) | yes (unless structures disabled) |
| `what` | POI id / `poi:#tag` (+ `occupancy`, 0.30.0) | POI section index | no (generated chunks only) |
| `what` | entity id / `#tag` / category | entity sections, staged | yes iff every chunk entity-searched |
| `what` | **biome id / `#tag`** (0.29.0) | climate sampler (`findClosestBiome3d`) | only when the biome cannot occur here |
| `what` | block id / **`#tag`** (0.29.0) | promoted one-node `pattern` scan | per the scan's own accounting |
| `what` | anything unresolvable | mcp-server memory fallthrough (`locateFromMemory`) | no, and says so |
| `at` | positions | `getBlocksAt` + occupants; one entry = referent | n/a |
| `at` | **an extent** (0.32.0): 1 axis = line, 2+ = region | RLE runs / material census (`describe_box`'s engine) | coverage (columns read) |
| `in` | **a named region or set bbox** (0.32.0) | scopes `what`/`pattern`; alone = describe | rides the scoped route's own negative |
| `pattern` | nodes + relations | palette-prefiltered bounded scan | composed (extent ∧ caps ∧ set provenance) |
| `pattern` | **cell properties** (0.31.0): light / sky_light / sees_sky / spawnable | enumeration-time gate; property-only nodes sweep every cell, bounded | composed, ∧ computed lighting |
| `anchors` | — | the session ledger | n/a |
| `anchors show:` | a stored set's members (0.30.0) | paged read-out, each cell re-verified live | `complete_enumeration` |

## The audit

Each item: what is missing, where it lives in the code, and the survey task it kills.

### A. Index routes the server has and `locate` did not reach

**A1. Biome — FIXED 0.29.0.** `parseTarget` probed structure → POI → entity → block and threw;
`minecraft:desert` is none of those, so `locate what:minecraft:desert` errored while
`query_registry` cheerfully reported that a `biome` registry exists. Vanilla answers this with
`ServerLevel.findClosestBiome3d` — the climate sampler, deterministic from the seed, no chunk
reads. *Killed: "where's the nearest desert / ocean / dark forest / mushroom island", i.e. every
go-somewhere-of-type-X task.* Only `get_region_summary`'s per-tile biome mix came close, over a
capped grid, with a miss that proves nothing.

**A2. POI occupancy — FIXED 0.30.0.** `findPoi` hardcoded `PoiManager.Occupancy.ANY`; vanilla also
offers `HAS_SPACE` and `IS_OCCUPIED`. *Killed: "is there a free bed for another villager", "which job
sites are unclaimed", "can this village grow" — the whole village-capacity survey.* Estimated at
"three lines"; it was three lines plus two honesty problems the estimate had not seen (below).

**A3. Structure route is nearest-only.** `findStructure` returns `List.of(nearest)`; `limit` is
accepted at the schema and silently ignored, there is no second-nearest, no all-in-radius, no
structure bounding box and no piece list. *Killed: "how many villages within 2000 blocks", "where
is the next one", "how big is this village", "where are its chest rooms".* A full fix needs a
different mechanism (chunk `StructureStart` reads) for the box/pieces half; the multi-result half
is cheap (repeat the placement query outward, or walk the returned start).

**A4. Structure `pos.y` is null and nothing signposted the recovery — FIXED 0.29.0.** Correct —
placement resolves a column — but the model was left holding an unusable coordinate. `check_site
at:{x,z} size:{w:1,d:1}` returns the ground height and is in every profile; the payload never said
so. *Killed in practice: "how high is the ground at that village", and every handoff from a
structure find to `check_path` / `bot_goto`.* Fixed by one sentence in the structure `note` (and
the same pointer rides a biome find's `detail`, whose y is a climate sample cell, not a surface).

**A5. Entity filters stop at type / `#tag` / category.** `entityMatcher` covers exactly those.
No item id for dropped items, no villager profession, no tamed-by, no custom name, no UUID, no
health or NBT selector. *Killed: "where are my dropped diamonds", "where's the farmer", "where's
my tamed wolf", "which mob is injured".* `run_command` with a vanilla selector is the escape
hatch — audited, unstructured, and outside the relation vocabulary.

### B. Predicate vocabulary the scan cannot express

**B1. Block tags / disjunction — FIXED 0.29.0.** `parseTarget` rejected a bare `#tag` with a
message offering only `structure:` and `poi:` prefixes (there was no `block:` prefix), and the
pattern `block` node went through `BlockTools.parseInput` → `BlockStateParser.parseForBlock`,
the *state* parser, which rejects tags outright. Vanilla's `parseForTesting` is the one that takes
them (it is what `/execute if block #minecraft:logs` uses). *Killed: "is there any ore / any log /
any bed / any door nearby" — and worse, N separate scans cannot compose one honest negative.*

**B2. No negation.** Relations are a pure conjunction of positive matchers. *Killed: "gold ore not
adjacent to lava", "a ledge with nothing above it", "a chest that isn't inside the village" — the
absence-shaped half of every siting question,* which is ironic in a tool whose honesty machinery is
built entirely around negatives. A `not:true` flag on a relation is expressible (filter after the
join; the extent contract is unchanged because the negated node's candidates come from the same
scan) — but it changes what `negative_is_proof` means and wants its own design pass.

**B3. No cardinality or aggregation.** No "cells with ≥4 stone neighbours", no cluster/component
extraction, no per-chunk counts. `matches_total` is the only number, and it is a *match* count,
not a *material* count.

**B4. No mid-range distance relation.** `within` caps at Chebyshev 16 (`WITHIN_MAX`) and `offset`
is an exact delta. *Killed: "two villages within 200 of each other", "a chest within 40 of that
door", "ore within 10 of the corridor" — anything whose relation is loose but not adjacent.*

**B5. No non-geometric cell properties — light/sky/spawn FIXED 0.31.0.** Light level, sky exposure,
biome-at-cell, heightmap-relative ("the surface block of this column"), fluid flow, redstone power.
*Killed: "where can hostile mobs spawn near my base" (spawn-proofing — a standing, repeated player
task), "is this room lit", "which columns see the sky".* `scene_summary` reported light at exactly
one point; nothing surveyed it. Fixed for light, sky and spawn candidacy; biome-at-cell,
heightmap-relative, fluid flow and redstone power are still open (see §Fixed in 0.31.0 for why those
four are a different shape).

### C. Result shape

**C1. Scan matches were not distance-ordered — FIXED 0.29.0.** `findPoi` and `findEntities` both
sort by horizontal distance; `patternSearch` did not. Matches were reported in `enumerate` order,
which is the chunk sweep (`minCx..maxCx`, `minCz..maxCz`) and then `findBlocks`' bottom-up section
order — so the answer was the **corner-most, lowest** match in the extent, dressed in `relations`
that read exactly like an answer. This mattered more than a stray ordering bug should, because
PATTERN_SEARCH_DESIGN §Results finding 2 established that `what:<block id>` — which promotes to
this scan — is the universal front door: *"where is the nearest diamond ore" was answered with an
arbitrary diamond ore.* No probe asserted ordering.

**C2. Result sets were write-only — FIXED 0.30.0.** A scan reporting `matches_total: 40` shows 8
referents (`MAX_LIMIT`) and stores up to 256 anchor cells as a set — and `anchors` printed the member
*count*, never the members. The other 32 positions could be fed to a later pattern and never read
out. *Killed: "list every chest in this village", "give me all the ore veins you found" — questions
the tool had already answered internally.*

**C3. `limit` caps at 8** (`MAX_LIMIT`), which is right for referents and wrong for enumeration —
the two doors now exist (C2's `show` pages 64 at a time); the referent cap stays 8 deliberately.

**C4. Set truncation is positional, not spatial.** When a scan exceeds `SET_MAX_MEMBERS` (256) the
kept members are the first 256 *in sweep order* — same corner bias as C1, and unlike C1 it is not
fixed by sorting the reported list, because the set is filled during enumeration.

### D. Cross-cutting

**D1. No memory union for resolvable ids.** `mcp-server/index.mjs` routes to `locateFromMemory`
only when the bridge says the `what` is *unresolvable* (`isUnresolvableWhat`). So a clean
proof-negative over r=32 never mentions the remembered sighting at r=300. *Killed: "where did I see
diamond ore earlier" — answerable only by knowing to call the memory tools instead.* This is the
seam MEMORY_REDESIGN §§11–12 (cycle 4, the legal profile / provenance filter) already wants to
rework; do it there, not here.

**D2. Anchors are points; there were no region referents — FIXED 0.32.0.** "The area I have already
surveyed" was not nameable, and survived only as up to 8 shown rows in the search log. A second
survey could not say "the part I have not covered yet". Regions are now the ledger's third kind
(`as` on an `at` extent), and `in:` scopes a search to one.

**D3. Volume material statistics have no route in the default profile.** `describe_box` is hidden
under `standard`; pattern counting caps at `MATCH_CAP` 512 / `NODE_CANDIDATE_CAP` 4096 (a stone
scan blows both instantly); `check_site`'s box door counts *not-clear cells*, not materials; and
`get_region_summary` is top-block only. *Killed: "what is this building made of", "how much iron is
in this chunk" (lower bound at best).* PATTERN_SEARCH_DESIGN §Results finding 5 already named
volume statistics as the one capability gap in the swap surface — adopting `standard` as the
default turned that noted caveat into the shipped hole. Either a counting rung prices `describe_box`
out properly, or `standard` should keep it. **Decision needed** (this is a profile question, not a
locate question). **FIXED 0.32.0 the other way:** the census became the region arity of `at`, so
nothing had to move back into the profile — see §Fixed in 0.32.0.

**D4. Scan reach is 128 blocks** (`PATTERN_MAX_RADIUS`) against 6400 for structures and 256 for
POIs. Fine as a cost bound, but it means "find gold anywhere near here" is walk-and-rescan, and
nothing in the payload suggests the walk.

**D5. No cross-dimension anything.** Sets refuse to cross dimensions (correct), relations are
per-dimension (correct), and there is no route for "where does this portal link" (portals are
findable as POIs; the link calculation is not exposed).

## First live run of the 0.29.0–0.32.0 probes (2026-07-30) — 4 red, one root, two real defects under it

The dev restart finally happened (client rebuild for the survival watch-session) and the pending
probes ran for the first time — against a CLIENT with a logged-in player, which no locate-route
probe had ever seen. 229/233 green; the 4 locate reds share one root: **the probes assume an
observer-less dedicated server, and `locate`'s default-to-first-player changes centres/sources the
moment a real player exists.** Two of the reds were hiding real defects behind that root; both are
now fixed in the tree (0.35.0) — **built, not re-run**, so nothing below is live-verified.

- `locate at: no observer is required` — expects `source: "no observer"`; got `player Player767`.
  The answer content is identical; the assertion is coupled to the empty-server label. **Not
  code-fixed:** nothing here says the mod is wrong, and the headless run is what separates the
  coupling from a defect.
- `pattern: a set node refines WITHOUT restating the extent` — the refine call omitted `near`
  expecting scope to travel from the set (created at 3.36M); the search centred on the player
  (3.48M) instead, so the staged zombie fell outside the extent. **This was a REAL design defect,
  now FIXED** in `patternSearch`'s scan-extent block: the observer used to win by merely existing,
  so the refinement loop broke the moment anybody was logged in. The precedence is now stated — a
  named region (`in`) *is* the extent; an EXPLICIT `near` is the caller's stated extent and wins;
  a merely DEFAULTED observer (the first online player, or the body) no longer outranks positioned
  set members — when the set nodes carry members, the set's own extent is used. A new local
  `nearExplicit` flag is what makes the distinction expressible at all: before it, a stated centre
  and a defaulted one arrived as the same `obs` vector, so the code could not tell them apart.
- `locate in: a named region scopes a search` — the missing box on the search record was a **REAL
  gap, now FIXED**: only the `pattern` route had ever written `scope_region`, so a scoped `what`
  negative could not say which box it was a negative *about*, which is the entire point of naming
  the region (D2). The `what`-route search block now records
  `search.scope_region = scope.describe()` whenever a scope is present, beside where `search.found`
  is set, as the pattern route always did.
- `search honesty: entity search states its chunk extent` (77/81 chunks) — environment shift
  (integrated-server chunk residency), and `negative_is_proof` is computed off that count, so the
  number has to be re-read on a server before anything in the mod moves. **Not code-fixed.**
- (5th red, not locate: the conformance ratchet had no specs for the 16 CLIENT-context tools —
  `screenshot`/`click`/UI/asset/`get_chat`/`quit_game` — because it had only ever run headless.
  **FIXED** in `mcp-server/probes/conformance.test.mjs` by a new `client` TIER: the 16
  CLIENT_SURFACE tools are declared `spec("client", {callable: false})`, a `CONDITIONAL` set exempts
  client-tier entries from the ratchet's `stale` half (they legitimately vanish headless), and none
  is ever called — they read and drive the *human's* screen, or quit the process. That closes the
  hole in both directions: with a client attached all 16 came back `unclassified`, and as plain
  entries they would instead have failed `stale` on every headless run.)

**Disposition:** unchanged for the two open reds — re-run this file against `launch_game
target:server` to separate genuine 0.32.0 defects from probe-environment coupling, which is the
same pass that settles reds #1 and #4. The two fixes above are compiled claims until that run:
the set-extent precedence and the `what`-route `scope_region` have no live evidence yet.

## Fixed in 0.32.0 — the region arity: D3 closed, D2 closed

Matthijs's design, and it lands on the two items this audit could not fix by adding a route: `at`
gained an **extent**, and the extent became **nameable**.

**`at` + `dx/dy/dz` — shape decides representation.** One axis is a LINE and enumerates exactly, as
run-length `[from, to, block]` runs, so a 60-block column costs its layers rather than its height and
"what is under me" stops being 64 hand-generated coordinate triples inside a 64-position budget. Two
or more axes are DESCRIBED — material counts with bounding boxes, the non-air box, the per-layer
solid profile, shell-air openings — delegated to `describe_box`'s implementation so what a volume is
made of keeps one definition, exactly as `at` already delegates its cell reads to `get_blocks_at`.
The `layers` view is deliberately **not** offered through this door: it is the one output with a
measured extraction hazard (PATTERN_SEARCH §Findings 3 — the same wrong cell in three independent
sessions), and this direction exists to hand back a description instead of a rendering.

**Why this is the same tool and not a new one.** The collapse rule in TOOL_BILL_PLAN §3 says merge
tools that answer the same question at a different arity or resolution, never tools that answer
different questions. `at` solves `at(thing, position)` for the thing: one cell is a referent, a list
is a reading, **a region is a description**. The evidence that models will actually find it is
already on record — TOOL_BILL_PLAN §6c r11, where the swap agent reached for `locate at` on a volume
question and had to sample points, taking the arm's only confident-wrong; and PATTERN_SEARCH
§Findings 2, where the promoted `what:<block id>` was the discovery bridge that hand-written pattern
syntax never was. This is the same promotion move applied to the volume question.

**Regions (D2).** `as` on an extent names it, and the ledger gains a third kind beside anchors and
sets. A region stores **corners, dimension and tick — never contents**; every use re-reads. (A region
that cached what was inside it would be the mod-side world mirror the don't-build list rejects — the
same line the anchor ledger has to stay on the right side of.) `in:"<name>"` then scopes a `what` or
`pattern` search to it, and `in` alone describes it again. `in:` also accepts a **result set**, using
its bounding box, so the refinement chain closes: scan for chests → describe the area they are in.

**What `in:` refuses, and why.** It cannot scope a **structure** or **biome** search: those indexes
return only the *nearest* match, and a match inside the region can sit behind a nearer one outside
it, so filtering the single result to the box would manufacture "there is none here" out of "there is
one, elsewhere". It also refuses `radius` or `y_range` alongside it — the region *is* the extent, and
two extents in one call is a contradiction rather than a refinement. POI and entity routes clip
**before** the limit (filtering afterwards would let sites outside the region eat the result slots),
the pattern scan sweeps the covering square and clips every candidate to the box, and the region
rides `search.extent` and `search.scope_region` so a remembered negative stays about the room.

**This supersedes the D3 recommendation below.** Don't restore `describe_box` to `standard` — the
census now arrives through the front door, which is strictly better than re-adding a tool whose
description every session pays for and which the r11 trace shows models did not reach for anyway.
`standard` stops having a hole; `describe_box` stays available in `full` for the `layers` view.

Probes (live, pending the restart): `probes/locate.test.mjs` — the three-run column over the platform
(air / stone / air), a 5×3×5 census with exact stone and air counts and no `blocks`/`layers` in the
payload, `as` landing a region in the ledger, `in` alone re-describing it, a scoped entity search that
finds the fixture zombie in one region and *proves* its absence in another, both nearest-only
refusals, and the mixed-entry / `expect` / line-cap refusals. `probes/pattern-search.test.mjs` — a
region around the staged gold pair returning exactly 2 of the 6 golds with the region named in the
extent, a set's bounding box used as an extent, and the two double-extent refusals.

## Fixed in 0.31.0 — B5's light/sky/spawn half

Pattern nodes gained **cell properties**: `light` and `sky_light` `{min,max}` on the 0–15 scale,
`sees_sky`, and `spawnable`. A node may carry them *instead of* `block`/`entity`/`set`, which is what
makes "where can a mob spawn" a first-class question rather than a hand-built three-node pattern.

**`spawnable` is vanilla's rule, and it over-reports on purpose.** It is
`SpawnPlacements.isSpawnPositionOk` for an ON_GROUND hostile (valid spawn surface below, this cell
*and* the one above both valid-empty) plus the dimension's `monsterSpawnBlockLightLimit`, which the
payload reads out as `search.spawn_block_light_limit` so the threshold comes from the world rather
than from prose. The rest of the real decision cannot be a boolean: `Monster.isDarkEnoughToSpawn`
*samples* `monsterSpawnLightTest` and compares against a random draw, and biome mob lists, difficulty,
pack rules and mob caps sit on top. So the tool claims the direction that is sound — a match is a
**candidate**, and a clean miss over a fully-read extent **is** spawn-proofing, which is the useful
half of the task anyway ("prove nothing can spawn in my base"). Zombie is the representative type
because ON_GROUND geometry is shared by every ON_GROUND mob (vanilla requires two free cells
regardless of mob height), so the over-approximation runs in the safe direction for the negative.

Three implementation decisions worth keeping:

- **Enumeration-time gates, not post-filters.** The property test runs in the same visitor as the
  block matcher, before a cell becomes a candidate. That is what keeps it affordable: spawnable cells
  are rare in a lit base, so `NODE_CANDIDATE_CAP` counts real matches instead of every air cell.
- **Property-only nodes are bounded up front, and REFUSED over budget** (`CELL_SWEEP_MAX` 262144
  cells) rather than truncated. Nothing indexes light, so such a node visits every cell in the
  extent; a silently-truncated spawn survey would report safety it never verified, which is worse
  than an error naming `y_range` and `radius`. `search.cells_swept` states what was actually visited.
- **Uncomputed lighting is skipped, not read.** A chunk can sit at FULL with its light engine not yet
  run, and `getBrightness` then returns 0 — i.e. "dark", i.e. manufactured spawn candidates. Cells in
  such chunks are skipped, the chunk count rides `search.light_unknown_chunks`, and it poisons
  `negative_is_proof` with its own cause. This is the one branch the probes cannot stage
  deterministically; they assert instead that a normal forceloaded scan raises no false alarm.

Cell properties apply to **every** node kind, not just block nodes — an entity node ("a mob standing
in the dark") and a set node ("of those chests, the ones in the dark") are the same cell test at a
different candidate source, so refusing them there would have been arbitrary. `groupKey` includes the
property summary, because two air nodes that disagree about light are not interchangeable and match
dedup must not collapse them.

**The latent lie this exposed in result sets.** A `ResultSet` stored only a block matcher, so a set
built from "dark air cells" would have been re-verified as merely "air cells" — quietly re-admitting
every cell someone lit in the meantime, and passing that into any chained negative built on it. Sets
now carry the cell predicates that were part of membership (accumulated down a chain, so a set built
from a set keeps the parent's), `ResultSet.matcher` is nullable for a property-only anchor whose
predicates *are* the membership rule, and both re-verification paths — pattern set nodes and
`anchors show:` — re-test the whole rule. A member whose light cannot be read now counts as
`unverifiable` rather than passing. The set's displayed `matcher` is the full spec
(`minecraft:air light<=0`), because a set whose printed rule is weaker than its real one invites
exactly the restatement that loses the constraint.

The four properties still missing are a different shape and stay open: biome-at-cell wants the
climate sampler per cell (A1's mechanism, not the light engine), heightmap-relative wants a *derived*
coordinate rather than a predicate, and fluid flow / redstone power are per-cell state reads whose
survey value is unproven — no task in the source list asks for them yet.

Probes (live, pending the restart): `probes/pattern-search.test.mjs` stages a sealed 3×3×2 stone room
so both the light and the geometry are exact — 9 spawn candidates on the feet layer only (the head
layer's ceiling is the roof), 18 dark air cells, `sees_sky` false inside and zero cells seeing sky,
`cells_swept` 50, the dimension's limit read out, then **a torch goes in and every candidate
disappears with `negative_is_proof` still true** — the spawn-proofing claim end to end. Plus the
refusals: an unbounded property-only sweep, light levels off the 0–15 scale, a malformed range, and a
node with neither matcher nor properties. The set-honesty path is probed through the same torch: a
`darkcells` set stored before it, read back after it, must drop all 18 members on the *property*
rather than pass a block-only re-test.

## Fixed in 0.30.0 — A2 and C2

**A2, POI occupancy.** `occupancy`: `any` (default) | `free` (`HAS_SPACE`) | `claimed`
(`IS_OCCUPIED`), and **every POI hit now carries its claim state** as `detail` ("tickets 1 of 1 free
(unclaimed)"). The counts matter more than the filter: they are what actually answers "can this
village grow", while the filter is what makes the *negative* mean something. Two things the
three-line estimate had not seen, both of which would have shipped as confident falsehoods:

- **Vanilla's two predicates are not complements.** `hasSpace` is "a ticket is left"; `isOccupied`
  is "a ticket has been taken" — so a 32-ticket meeting point with one villager on it is **both**.
  Exposing `free`/`occupied` as a boolean pair would have said a bell was full when 31 villagers
  still fit. Hence `claimed` (not `full`) as the word, and free/max counts on every hit.
- **Zero-ticket POI types match neither filter.** `nether_portal`, `lodestone`, `beehive`,
  `bee_nest` have `maxTickets 0`, so `hasSpace` and `isOccupied` are both false forever: a
  `occupancy:free` lodestone search returns nothing while the lodestone sits right there. Named in
  the filtered `note` and in the argument description, and their detail reads "no tickets (this POI
  type is not claimable)" rather than "0 of 0 free" (which reads as full) or "unclaimed" (which
  reads as available).

Filtered searches also record `occupancy` in the search log and append ", free sites only" to
`extent`, because a remembered negative that loses its filter becomes a claim about all beds. And
the argument is **refused, not ignored**, on `at`, `pattern`, and every non-POI `what` — A3 is in
this doc precisely because `limit` was accepted at the schema and silently dropped.

**C2, `anchors show:<set>`.** Pages a stored set's members, `SET_SHOW_MAX` 64 at a time, `from` to
continue, `next_from` in the reply. Sized like `AT_MAX` rather than `MAX_LIMIT`: eight is the right
number of landmarks to name and the wrong number of chests to list. Decisions worth recording:

- **Every member in the page is re-tested, not recited** — same matcher, same loader discipline as a
  set node in a pattern (PATTERN_SEARCH_DESIGN §Sets). A mined member comes back under `dropped`
  with a count, an unreadable one as `unverifiable` + `loader.shortfallReason()`. So the page bounds
  the *re-read*, not just the text, which is why paging is the right shape rather than a bigger dump.
- **`complete_enumeration`** is the enumeration counterpart of `negative_is_proof`: true only when
  the page is the whole set, the set was built over a fully-read extent, it was not truncated at 256,
  and nothing failed to re-read. Each failure mode is a different lie, so the note names whichever
  applies — including that a set is what matched *then*, so "complete" never means "complete now".
- **Order is the creating sweep, not distance.** Paging needs a stable key and the observer moves
  between calls; each row instead carries its own bearing/`map_distance`/`dy`, and the note says the
  nearest member overall is only knowable from a whole set. This is C1's ranking rule declined on
  purpose, and it inherits C4's corner bias, which the truncation note now states outright.
- **No observer is fine.** Bearings come from the session's body, else a player, else are omitted
  with `source` saying so — the headless bench has neither, and a member list is worth having anyway.
- The ledger read now signposts the door (`members` is a COUNT — `anchors show:<name>` reads them
  out), since the count was exactly what made the contents look unavailable.

Probes (live, pending the restart): `probes/locate.test.mjs` stages a composter + a lodestone —
ticket detail, the free/claimed pair on an unclaimed site, the filtered-miss note, the zero-ticket
trap on both sides, and the four refusal sites; `probes/pattern-search.test.mjs` stages a 72-block
iron slab (deliberately > one page) — window/`next_from`/note wording, a two-page partition with no
repeats or gaps, a mined member reappearing as `dropped` across pages, `complete_enumeration` true
on a 3-member set, the ledger signpost, and the unknown-set / negative-offset refusals.

Not touched, deliberately: the memory layer. `capture.mjs` forwards a hit's `detail` into the store
but nothing renders it, so claim state cannot yet be recited as durable — **if a later memory cycle
starts printing `detail`, POI tickets must be excluded or timestamped**, since they are villager
bookkeeping and go stale without any block changing.

## Fixed in 0.29.0

The three cheapest-per-value items, chosen because two of them are one-registry-probe wide and the
third is a wrong answer rather than a missing feature:

1. **A1 biome route.** `what` resolves biome ids and `#tags` (explicit `biome:` prefix too), via
   `findClosestBiome3d` at vanilla's 32/64 sample resolution. Nearest only, like structures. The
   negative is honest in a way vanilla's is not: `negative_is_proof` is **true** only when the
   biome cannot occur in this dimension's generator at all (`possibleBiomes` has no match — a
   categorical absence), and **false** otherwise with the cause named as a *sampling-resolution*
   limit, not an unread-chunk one, so widening the radius is not sold as the remedy.
2. **B1 block tags.** Both `what:#minecraft:logs` and pattern `block:"#minecraft:logs[axis=y]"`,
   through vanilla's `parseForTesting` — the same matcher `/execute if block` uses, so `expect`
   (in `locate at` *and* `get_blocks_at`), set re-verification and pattern nodes keep one
   definition. A bare `#tag` now resolves against structure → POI → entity → biome → block in the
   same order bare ids do (first hit wins; `search.mechanism` names the index that answered, so a
   wrong resolution is visible), and `block:` / `biome:` force one. A tag referent is named from
   the block actually in the cell, since a tag has no single id.
3. **C1 nearest-first.** Pattern matches are ranked from the observer before the `limit` cut.
   Ranking is 3D when the centre's y is real (a body, a player, or `near` with an explicit y) and
   horizontal when it is an assumption (sea-level fill, set-derived centre) — the same rule that
   made `findEntities` sort horizontally, applied where the y is actually known instead of blanket.
   The `limit` cut moved after the ranking, so the reported few really are the nearest few, and the
   note says "the N NEAREST" rather than "the first N".

Plus A4's one sentence, since it was free: a structure find now says how to turn its column into a
height (`check_site at:{x,z} size:{w:1,d:1}`).

Probes: `probes/locate.test.mjs` (biome route + typed biome negative + tag resolution + the
unknown-tag error naming every index) and `probes/pattern-search.test.mjs` (tag node matching two
different logs named from their cells, the `what:#tag` promotion, `#tag[state]`, nearest-first
ordering, and the 3D-vs-horizontal rule staged as two emeralds that disagree about which is
nearest). `memory/probes/capture.test.mjs` tracks the reworded unresolvable-`what` sentence — the
memory fallthrough keys on it, so the wording is load-bearing in two repos.

## The ranking below is now measurable — the route ledger (2026-08-02)

Everything in this document, including the ranking that follows, was produced by reading code and
reasoning about what a model *might* ask. `ROUTE_LEDGER_DESIGN.md` (mcp-server 0.17.0, built, live-
unrun) makes it empirical: every unanswered call is now recorded across all sessions, bucketed by
the fix it wants — `vocabulary` (write a route) / `affordance` (fix the error text) / `capability`
(**these open items, ranked by demand**) / `referent` / `silent_miss` / `environment` / `crash` —
and read out by `node memory/routes-cli.mjs overview`.

The first backfill over the archived bench transcripts produced 131 rows and three things this audit
could not have known: `box volume … exceeds the cap` fired **23×**, which is D3's counting rung
arriving as measured demand; `"chest"` was asked through the **entity** door in 3 independent
sessions, which is an A5-shaped miss nobody logged; and seven `bot_engage` calls named entity ids
that did not exist, which is a failure class (`referent`) this audit does not have a letter for.

Two of this document's holes are also half-closed by the same build. **B1's disjunction** — "N
separate scans cannot compose one honest negative" — is exactly what a route *executor* can do,
because it owns all its legs and holds the extent fixed; `wood` = logs ∨ planks is now one call with
one composed verdict. And **D1's memory union** gains its ordering rule: route first (a class of
block, searched live), memory second (a place, remembered). The route layer's own honesty rule is
this document's set-provenance rule one level up — an **unauthored** route can never prove a
negative, because the extent was fine and the *definition* was guessed.

## Still open, ranked

1. **B2 negation** — now the biggest hole in the predicate vocabulary, and cell properties make it
   sharper: `spawnable` proved that the *absence* shape is what siting questions want, and a
   `not:true` relation is the general form of it.
2. **A3 structure multiplicity + bounds**, **A5 entity attribute filters**, **B4 loose distance**,
   **B3 cardinality**, **C4 set truncation bias**, **D4/D5**, and B5's remaining four properties
   (biome-at-cell, heightmap-relative, fluid flow, redstone power).
3. **D1 memory union** — parked on purpose: it belongs to MEMORY_REDESIGN §§11–12 (cycle 4).

**D3 and D2 are closed by 0.32.0** (see above). The D3 recommendation kept below is **superseded** —
the census moved into the front door instead of `describe_box` moving back into the profile — but the
reasoning is kept because it is the argument the region arity had to answer, and because the census
rung it asks for is still worth building: nothing has *measured* the region arity yet.

### The D3 recommendation (SUPERSEDED by 0.32.0's region arity — kept as the argument it answered)

D3 splits in two, and only one half is buildable inside `locate`:

- *"How much iron is in this chunk"* — a **closed-palette count**. Expressible: a counting rung on
  the promoted block scan would be exact and uncapped, because counting needs no candidate lists and
  no join, so `MATCH_CAP` 512 / `NODE_CANDIDATE_CAP` 4096 stop applying. Real work, worth doing on
  its own merits, and it would kill the "lower bound at best" wording.
- *"What is this building made of"* — an **open-palette census**. Not expressible as a pattern at
  all: a pattern needs a matcher, and the whole question is that you do not know the palette. That
  is precisely `describe_box` (material histogram, per-material boxes, non-air box, per-layer solid
  profile, shell air counts), and re-homing it into `locate` would be a copy of that code with a
  different door, not a cheaper capability.

So the honest reading of the evidence: the measured 1:1 substitution covered **point identity and
predicates** (`get_blocks_at`, `get_surface`), and PATTERN_SEARCH_DESIGN §Results finding 5 already
named volume statistics as the unswapped capability. No bench rung has ever asked a census question,
so the parity claim never extended to `describe_box` — hiding it under `standard` priced out a
capability the bench cannot see. Recommendation, in order:

1. `SWAPPED_BLOCK_READS` → `["get_surface", "get_blocks_at"]`; `describe_box` rides in
   `MIDDLE_TIER_READS` only, so `survey` (where hiding it *was* measured neutral) is unchanged.
2. Add a census rung to the bench so the next freeze rerun can price it properly — if a census arm
   then shows the model solving it without `describe_box`, hide it again with evidence.
3. Independently, the counting rung for the closed-palette half.

Cost of being wrong this way is one tool description in the default profile; cost of the other way is
a question class that cannot be asked at all. **Matthijs's call** — one line in `mcp-server/index.mjs`.

## Survey tasks that still fail (the task-source list)

Kept here as candidate bench rungs — each maps to an item above:

- how many villages within 2000 blocks, and where's the second (A3) · where are my dropped diamonds /
  the farmer / my tamed wolf (A5)
- gold ore not adjacent to lava (B2) · a ledge with nothing above it (B2) · the biggest ore vein
  (B3) · two structures within 200 blocks of each other (B4) · what biome is this cell in / what is
  the surface block of this column (B5's remaining properties)
- where did I see X an hour ago (D1) · what is this building made of, by material (D3) · how much
  iron is in this chunk (D3) · find gold beyond 128 blocks without walking (D4) · where does this
  portal link (D5)

Answered since the audit, and therefore candidate rungs for the *working* surface rather than the
failing one: which beds/job sites are free (A2) · list every chest in this village (C2) · where's the
nearest desert (A1) · is there any log/ore/bed nearby (B1) · where is the NEAREST gold (C1) · where
can hostile mobs spawn near my base, and is my base spawn-proof (B5) · is this room lit (B5) · which
columns see the sky (B5).

Cross-references: ARCHITECTURE.md §locate (doctrine), PATTERN_SEARCH_DESIGN.md (§Results finding 5
= D3, finding 2 = why C1 mattered), TOOL_BILL_PLAN.md §4b (the `standard` profile that raised the
stakes), MEMORY_REDESIGN.md §§11–12 (D1's real home), TODO.md §`locate` route audit (status ledger).
