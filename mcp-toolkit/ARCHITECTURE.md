# mcp-toolkit — Architecture & Decision Record

Last updated: 2026-07-19, end of session 6 — copilot-first decided AND roadmap steps 1–3 built +
live-verified headless the same day (contract layer 19/19, event/audit log 22/22, drone observer 14/14).
Same-day addendum: roadmap step 6 (typed agent memory) designed, externally reviewed, built and
live-verified — see MEMORY_DESIGN.md, which is the authority for everything memory.
This document is the authority on vocabulary, seams, and roadmap. Javadoc headers point here; if code
comments and this file disagree, this file wins and the comment is stale.

## What this is

A standalone Fabric mod hosting a localhost HTTP → MCP bridge (`BridgeServer` + Node `mcp-server/`) with a
tool registry (`McpTools` / `ToolDef`) that gives an LLM eyes, hands, and editing authority inside a running
Minecraft instance. Tool groups today (~50 server-side tools, live-verified except the 0.35.0
additions — their probes are written but unrun, see TODO.md): world perception
(ladder + region rollup) with derived spatial predicates (`check_fit`/`check_clearance`/
`check_path`/`check_site`), body control + body hands (mine/place/use/attack/craft/inventory),
primitive build shapes with transactional undo (`undo_edit`/`list_edits`), game control
(`run_command`, `get_chat`), the unified event/audit log (`get_events`), the game's own log
(`get_log` + the `error` event type — 0.91.0), UI inspection/navigation/
design, Blockbench asset live-push, JVM hotswap, plus consumer-mod tools (Village Jobs building
pipeline). The Node server adds local tools of its own on top of the bridge manifest
(`launch_game`, the `mem_*` layer, `bot_scan`).

**Product thesis:** a server-native Minecraft copilot with movable symbolic perception, delegated embodied
action, and transparent world-editing authority — capable of operating autonomously when asked, but designed
primarily to extend a human player rather than imitate one.

## Where MCP actually lives (the split, stated plainly)

> **AMENDED 0.146.0: the game speaks MCP too now, on a second door** — `POST
> http://127.0.0.1:<port>/mcp`, served from the jar with no Node and nothing to install
> (`docs/platform/IN_JAR_MCP_DESIGN.md`). Everything below is still true of the *shim* door, which is
> unchanged and remains the supported path, and the paragraph at the end of this section ("the
> consequence, when someone asks for a port that carries a profile") is the design the new door was
> built to, clause by clause — including which layers do not come along.

**The game does not speak MCP** *on the port the shim dials.* This is the first thing to know about
the shape of the toolkit, and it is easy to assume otherwise because the mod ships the MCP server
inside its own jar.

| | In the JVM (the mod) | In the Node shim (`mcp-server/`) |
|---|---|---|
| Protocol | **none** — a private HTTP+JSON API: `/tools` (the manifest), `/cmd` (execute), `/hello`, `/heartbeat`, `/activity`, `/humantask`, `/review` | **MCP** — stdio JSON-RPC, `tools/list`, `tools/call`, `notifications/tools/list_changed` |
| Tools | every tool: schema, implementation, permission, mechanism stamp; extension mods register here | local tools that never touch the game (`mem_*`, the loop kit, `bot_scan`, `launch_game`) |
| Surface | serves one list to anyone who dials the port | **profiles / keep-lists** (`MCPTK_PROFILE`) slice it per session |
| Also | - | the memory layer, the Blockbench upstream merged in as a second source, the image budget, the loop file |

The AI program never talks to the game. It spawns `node <gameDir>/mcptoolkit/mcp-server/index.mjs`,
speaks MCP to that process, and the shim turns each call into an HTTP request into the JVM. **The mod
carries the MCP server as a FILE** (`mcp-server-dist` in the jar, extracted to the game directory by
`ServerExtract` at boot, `npm install --omit=dev` on first extract) **but never as a process.**

**Why the split is this way.** An MCP client spawns its servers when the client starts — which is
routinely when Minecraft is not running, and the game cannot be a stdio child of a program that
outlives it. So something must exist to be spawned and held. It is not a baked-in tool list:
`buildToolList` always fetches `/tools` fresh, serves **local tools only, honestly** while the bridge
is down, polls (3s down / 15s up) and fires `listChanged` when the game appears. The rest of what
lives shim-side is there because it is per-session policy — which slice of the surface, what memory
this agent has, what a picture costs — and none of that is the game's business.

**The consequence, when someone asks for a port that carries a profile.** It cannot, today: the port
serves the whole manifest over a private API, and the profile belongs to the shim process a session
starts. Making the port itself an MCP endpoint with a fixed tool surface means putting an MCP server
in the JVM and moving profile slicing into Java with it — a new front door, not a rewrite, and the
shim-only layers above (memory, Blockbench, local tools) do not come along.

## The governing decision: copilot-first

Decided 2026-07-19 after a three-round design review. Not a binary choice but a hierarchy:

- **Primary product:** a mixed-initiative, in-world copilot that inspects, reasons about, modifies, and
  (eventually) operates inside a human's world. Superhuman access is the point.
- **Secondary research mode:** a *bounded autonomous-player profile* for honest evaluation — kept possible
  without a rewrite, never allowed to drive the architecture.

Why: every existing thread (Village Jobs authoring, building editor, Blockbench push, UI tools, the drone
as movable camera) is a copilot/world-operation capability. Survival autonomy is an experiment beside that
trajectory, not its organizing purpose.

Consequences, in one line each:

- **Omniscience is a feature. *Unlabeled* omniscience is a bug.**
- Constraints on the agent are **authorization** constraints (what did the user permit), not
  human-realism constraints (what could a human body do).
- The core product principle is **legible, bounded agency** — not credible eyesight or physiology.

## Perception

### The ladder

Coarse-to-fine, queryable, symbolic — the agent asks questions instead of consuming frames:

```
get_region_summary   survey: tile grid of aggregates over up to 256 chunks (the rung ABOVE orient)
scene_summary        orient: one structured situation read + one-line sentence
get_surface          terrain: heightmap surface grid around a vantage point
get_entities         actors: distance-sorted spatial radius query
raycast              crosshair: first block/entity along a ray (occlusion-respecting)
screenshot           raw pixels (client framebuffer; off-ladder, not origin-aware)
```

**Renamed 2026-07-25 (0.20.0), principal-directed — names must state the question the tool
answers**: `get_blocks` → **`get_surface`** (it answers "what does the surface look like", never a
block dump — the old name was the manifest's worst question-mismatch) and `scan_box` →
**`describe_box`** (it returns a description, its own first line says so; "scan" promised raw
output). The name is the cheapest routing signal a model gets — descriptions are provably
under-read (47/75 dark; cross-tool `detail` guessing). Names judged already question-shaped and
kept: `get_blocks_at`, `get_entities`, `raycast`, the `check_*` predicates, `find_site`,
`resolve_anchor`, `locate` (bench-proven: the block-search instinct routed to it by name).
Historical docs/traces keep the old names as evidence; live surface, probes, bench hide-lists and
system prompts all renamed. `MCPTK_GET_BLOCKS_VIEW` keeps its env name for compat.

Beside the ladder sit the **derived spatial predicates** (`check_fit`, `check_clearance`,
`check_path`, `check_site` — `PredicateTools`, added 2026-07-22 from the world-representation
research): the toolkit answers geometry questions itself because model arithmetic over coordinate
lists is the documented failure mode, not perception. Same envelope + coverage contract; a verdict
is never issued over unread space (explicit `null` — the bridge serializes nulls for exactly this
tri-state). `check_path` answers with the real vanilla pathfinder via a throwaway body
(walker/flyer) and was promoted from Village Jobs.

**Spatial inversion** (0.7.0): the predicates above are verification-shaped — the model proposes
coordinates (the failing step) and the tool checks them. Two tools invert that so the model states
the *relation* and the server produces the coordinates:

- **`find_site`** — the search-shaped inverse of check_fit/check_site: footprint + search area in,
  ranked candidates out (sorted by cut+fill terrain work against each candidate's modal ground,
  distance tie-break; `max_water_columns`/`max_stddev` filters report their kill counts).
  Escalation lives inside the tool: a cheap heightmap-column proxy ranks every anchor, the real
  volume fit check runs only on the returned top-k. `candidates` is a verdict — null over a fully
  unread scan, never an empty list.
- **`resolve_anchor`** — relation → coordinates for placement: "w×h×d on the north face of that
  box, gap 2, base-aligned" resolves to a min-corner `origin` the model copies into
  set_blocks/place_shape (copying is a lookup; models do lookups at ceiling and arithmetic at
  floor). `on_ground` drops the box onto the modal ground under its own footprint; `check` (default
  on) runs the fit verdict in the same call. With `check:false` and no `on_ground` the call is pure
  arithmetic and coverage is vacuously complete.

**Relation-shaped reads** (0.8.0): `locate` closes the loop spatial inversion opened. The predicates
removed the model's coordinate *arithmetic*; `locate` removes its *map building* — the other
documented failure mode (sequential-observation map integration, the same one region connectivity is
computed tool-side for). Every find comes back already related to the observer and to what this
session located earlier ("tower, W of you 200, WNW of lookout_tree 140"), so the model never
integrates observations: the integration arrives done. That is the representation humans actually
hold — landmarks and bearings between them, never coordinates.

- **Two-way, one relation.** `at(thing, position)` solved for whichever variable is blank: `what`
  searches (thing → positions), `at` identifies (positions → thing). **Which argument is blank
  selects the direction — there is no mode flag**, the same way `what` resolves against the
  registries instead of taking a `kind:` prefix. That is the general collapse rule this replaces the
  earlier "same question, different arity" one with: *merge tools that compute the same relation with
  a different unknown; never tools that answer different questions.* The `at` direction delegates its
  cell read to `WorldPerceptionTools.getBlocksAt`, so palette syntax, `expect` semantics (vanilla
  `BlockInput`), the −1 not-read convention and the coverage contract keep exactly one definition.
  One `at` entry is a *referent* (handle, relations, anchor, plus any entity standing there); a list
  is a *reading* (palette + rows) — a 64-position batch verification is not 64 landmarks — and, since
  0.32.0, **an extent is a description**: `dx/dy/dz` on the entry, one axis giving a run-length line
  (a column costs its layers, not its height) and two or more giving the material census, delegated
  to `describe_box`'s implementation. That is the arity ladder the collapse rule asks for — same
  question, same unknown, three resolutions — and it is where the region referent comes from: `as` on
  an extent names it, `in:"<name>"` scopes a later search to it, `in` alone re-describes it. Regions
  hold **corners only** and re-read on use, on the right side of the world-mirror line for the same
  reason anchors are. `in:` refuses the nearest-only indexes (structure, biome): filtering a single
  nearest result to a box could hide a match inside the region behind a nearer one outside it, which
  would manufacture a negative. `at`
  requires **no observer**: "what is at (x,y,z)" does not depend on where you are, and requiring one
  would have made the direction unusable headless, which is where the bench runs.
- **One routing level, deliberately.** The cheap relations (bearing, distance, dy) ride the `locate`
  payload; there is no follow-up `relate` call, because a mandatory two-step *is* a second routing
  level and those measurably hurt (progressive-disclosure evidence — "a second, deeper routing level
  never helps and sometimes breaks accuracy outright"; corroborated locally by the agent calling
  `get_blocks` 0–1× per 32 sessions, i.e. it never climbs the ladder anyway). Only simulation-grade
  relations stay behind their own tools: `check_path`, `check_site`.
- **Which questions it can route at all** is audited in **LOCATE_ROUTES.md** (2026-07-29): the
  route table, the missing routes with the survey task each one kills, and the five fixed since.
  Since 2026-08-02 that audit is also *measured* rather than only reasoned — **ROUTE_LEDGER_DESIGN.md**
  records every unanswered call across every session, bucketed by the fix it wants, so "which
  questions can it not route" has a frequency table behind it. The same build adds **concept routes**
  ("tree" → `#minecraft:logs`, "wood" → logs ∨ planks): a route executor owns all its legs, which is
  the only way the disjunctive negative composes honestly, and an **unauthored** route can never
  prove one — the extent may be perfect while the definition is a guess, which is the result-set
  provenance rule applied to vocabulary. Every routed answer discloses the question it really
  answered, beside `search.promoted`.
  0.29.0: the **biome** index (the climate sampler; nothing else in the toolkit could answer
  "where is the nearest desert"), **block tags** in `what` and pattern nodes (the disjunctive
  question — "any log", "any ore" — which no set of separate searches can answer as one negative),
  and **nearest-first** scan results (the promoted `what:<block id>` front door was answering
  "nearest X" with the corner-most X of the extent). 0.30.0: **POI `occupancy`** plus free/max
  ticket counts on every POI hit (the village-capacity survey — is there a spare bed, is this job
  site claimed; vanilla's two predicates are not complements, so the payload reports counts and says
  which types cannot be claimed at all), and **`anchors show:<set>`** — the *enumeration* door beside
  the referent one: a stored result set reads out 64 members per page, each re-tested live, with
  `complete_enumeration` as the enumeration counterpart of `negative_is_proof`. 0.31.0: **cell
  properties** on pattern nodes (`light`, `sky_light`, `sees_sky`, `spawnable`) — the non-geometric
  half the pattern language lacked, and with it the spawn-proofing class. `spawnable` is vanilla's own
  ON_GROUND spawn-position rule plus the dimension's block-light limit, and it **over-reports on
  purpose**: the real spawn decision samples a random light draw, so no boolean can claim "a mob will
  spawn here" — the tool claims the sound direction instead, where a match is a candidate and a clean
  miss over a fully-read extent *is* spawn-proofing. Open items are ranked there; the sharpest is that
  volume material statistics have no route under the `standard` profile (with a recommendation to
  restore `describe_box`, pending a decision).
- **`what` search is index lookup, not scanning.** It covers exactly what the server already
  indexes — worldgen structure placement (`findNearestMapStructure`, the `/locate` path with
  `createReference:false`), the `PoiManager` section index, resident entity sections, and the
  biome climate sampler (0.29.0 — seed state, reads no chunks; its negative is a proof only when
  the dimension cannot generate that biome at all, since sampling every 32/64 blocks can step over
  a small patch). The
  volume-scan rung was deliberately deferred until this benched; the gate ran 2026-07-24
  (TOOL_BILL_PLAN §4a) and the rung shipped 2026-07-25 as **`pattern`** (0.18.0, design authority
  **PATTERN_SEARCH_DESIGN.md**): a declarative conjunctive pattern — nodes {block matcher in
  `expect`/set_blocks syntax | entity type/category | stored result set} plus cell relations
  (adjacent/above/below/offset/within) and, since 0.31.0, non-geometric **cell properties**
  (`light`/`sky_light`/`sees_sky`/`spawnable`) that gate at enumeration time — a node may state
  properties *instead of* a matcher, and because nothing indexes light that node visits every cell in
  the extent, which is **refused over budget rather than truncated**: a partial spawn-proofing survey
  reports safety it never verified, and that is a worse failure than an error. Matched over a bounded, budgeted extent. The scan is
  seeded by the section-palette prefilter (`maybeHas` — the palette IS an index), joined
  smallest-candidate-set-first, and priced in the response (`ms`, chunk accounting). `as:` stores
  every distinct anchor cell as a **result set** (bounded ring of 8, ≤256 cells) that a later
  pattern uses as a node: members are re-tested live on every use (`stale_dropped`/
  `unverifiable`), the set's provenance (creation tick + extent + truncation) rides
  `search.scope`, and a chained `negative_is_proof` is the AND of extent, caps, and every input
  set's cleanliness — a partial scan can never launder into a universal negative two calls
  later. A set is also **readable**, not just chainable (`anchors show:`, 0.30.0): the referent cap
  of 8 is right for landmarks and wrong for "list every chest", so the enumeration gets its own door
  — paged, re-verified per page, and flagged `complete_enumeration` only when the page is the whole
  set, the extent was fully read, nothing was truncated and every member re-read. Entity results stay
  volatile anchors, never sets (gone-vs-unloaded is indistinguishable on re-use). **A bare block id in `what` promotes to a one-node pattern scan** (0.19.0, from the
  first pricing run: the one session that reached for the tool asked `what:"minecraft:gold_block"`
  and was refused — the collapse rule wants the same question answered wherever it is asked; the
  promotion is disclosed via `search.promoted` and stamped `pattern_scan`, never a silent index
  probe). Live-verified 8/8+1 + locate 16 + conformance 40 (2026-07-25, headless); standing
  probe `mcp-server/probes/pattern-search.test.mjs`; priced on the relational rungs t14–t16
  (`--loo locate`). The payload stays small because the cost lives server-side.
- **Handles, not coordinates.** A find returns `village_plains@-104,71,238` — semantic (the
  opaque-palette argument applies to referents too: never `ref_17`) and copy-pasteable, so the model
  passes identity around instead of retyping the coordinates the predicates exist to keep it away
  from. `as:` names a find for later reference.
- **Relations are MAP relations.** `{to, bearing, map_distance, dy}` — `map_distance` is horizontal
  and `dy` carries the vertical separately, deliberately *not* reusing get_entities' 3D `distance`
  name for a different metric. Live-caught: a 3D figure against an observer y that was assumed (the
  `near {x,z}` case) reported a mob 20 blocks away as 238.8 away. Same rule made `radius` horizontal
  with full-height search on both the entity and POI paths — a locate radius is a map radius.
- **Unknown heights stay unknown.** Structure placement resolves a *column*: vanilla returns y=0,
  which is not a height. So a structure find reads `village_plains@1488,~,-224`, its `pos.y` is
  null, and `dy` is suppressed in its relations — `map_distance` still works, which is the second
  reason the horizontal metric is the right one. Reporting that 0 as a coordinate would be the
  0.6.0 confident-falsehood class in a new place.
- **Typed negatives.** `search.negative_is_proof` is the honesty field: worldgen placement is
  deterministic from the seed, so a structure miss within radius is a *real* negative; the POI index
  only knows generated chunks and the entity read only resident ones, so those misses are not. This
  is the coverage contract applied to **search** rather than to a cell sweep, and it exists because
  finds mostly speak for themselves while negatives are what quietly lie once a result is restated
  later in a conversation. Every search also records its mechanism, extent and measured `ms`.
- **The ledger is a symbol table, not a world mirror** — see the don't-build row. `anchors` reads and
  edits it. Relation fan-out is capped at the observer plus two anchors, because relating every find
  to every prior find is O(n²) text growth, which re-creates the context problem the design exists
  to avoid; pinned anchors (a base, a work site) always win that selection.

Measured on the dev world (the tool reports its own `ms`, so this stays honest): POI index 23ms;
entity sections <1ms; **structure placement 845ms cold** for a 100-chunk radius — the same order as
generating a virgin chunk, on the server thread — dropping to ~0ms once `StructureCheck` has the
answer cached. The tool description says so; a wide structure search is not a cheap read.

Live-verified 10/10 + conformance 40/40 (2026-07-24, headless). The first run caught three real
defects, all the same shape — a vertical axis being bounded or measured against a height nobody
supplied: the entity box was a cube around an assumed sea-level y (so a fixture 240 blocks up was
invisible), the POI path went through `getInRange`'s 3D radius test with the same flaw, and the
observer relation reported 3D distance. Standing probe: `mcp-server/probes/locate.test.mjs`.

**Affordance carrying** (0.7.0, MineDojo pattern via the round-three survey): palettes everywhere
carry per-entry affordance flags — `solid|pass|air|water|lava`, then `repl`/`hazard`/`tool`/
`unbreakable` — computed from the first actually-observed state, so the cost is O(palette), not
O(cells) (`Affordances`). get_blocks_at/get_blocks (aligned array / `aff` field), scan_box
materials (`aff`), raycast block hits (`aff`). Entity rows in get_entities carry `bearing`
(8-point, N = −z) and `dy` from the query origin; scene_summary's nearestHostile carries `bearing`.
The reads answer the *next* question (walk through it? stand on it? mine it? which way?) in the
same payload instead of leaving a subtraction to the model.

**Region connectivity** (0.7.0, opt-in): `get_region_summary connectivity:true` (implied by
`points`) computes surface-walk connected components over the survey (stride 2; adjacency = ground
step ≤1, no water/lava) — region-scale topology computed tool-side because sequential-observation
map integration is the other documented failure mode. Tiles gain `walk_components`; `points`
[{x,z}…] each get their component plus a tri-state `connected`: true = same component, false =
provably separate *within the surveyed cells*, null = unread cells could hide the join (a
component bordering unread space cannot prove separation). Sub-stride obstacles (fences, 1-wide
walls) are below resolution and the description says so — `check_path` stays the definitive
point-to-point verdict.

**One profile, all the way down** (0.43.0, after a watched session drowned). A `NavProfile` (`swim`,
`may_modify` + budgets, `open_doors`) was parsed, echoed back in the verdict, and then reached only
the *search*. Three separate leaks dropped it before anything moved: `Bodies.PlayerNav` hardcoded
`NavProfile.DEFAULT`, so the walking navigation always planned with the swim right; `NavDriver` asked
`NavBody.canSwim()` — the body's INTRINSIC ability, hardcoded `true` on both live bodies — rather
than the navigation's grant, so a correctly-planned land route still swam the instant the body
touched water; and the goal loop synthesized fresh `bot_goto` args for each leg, which re-parsed to
DEFAULT. A `swim:false` goal therefore planned a water route, swam it, dove, and drowned a player
body. The rule this establishes: **a right the caller states must reach the actuator, not just the
planner** — an echoed profile that governs nothing is a lie with a receipt. The profile now rides
`Bodies.Nav`, is stored on `PendingNav` so repairs re-plan identically, is written back into
synthesized legs by `NavProfile.writeArgs`, and gates the driver via `setSwimAllowed`. Possession
honours the one part that maps onto vanilla (`GroundPathNavigation.setCanFloat`) and documents the
rest as not applying, rather than pretending.

**Reach goals** (0.5.0, from the round-three mineflayer survey — `GoalGetToBlock`/`GoalLookAtBlock`
realized server-side): `check_path` and `bot_goto` accept `reach {x,y,z}` instead of `to` — "get
somewhere you can TOUCH that block from" (hand reach 4.5 from the eye + line of sight). The shared
`ReachSolver` computes the touch shell *geometrically only* and feeds the whole set to
`PathNavigation.createPath(Set, 0)` — vanilla A* takes multi-target sets natively, and the body's
own `NodeEvaluator` decides which members it can occupy. That keeps the solver mode-blind: walkers,
the flying drone, possessed swimmers, and any future water body share it unchanged, and the
embodied side never names a movement mode at all. Verdicts stay staged and honest: `occluded`
(false — no touchable position exists, pathing can't help), `no_path_to_reach_position` (false —
touchable positions exist, this body can't get to any), null over unreadable shell cells; success
returns the chosen `stand`, and a reach flight's completion re-verifies the touch predicate with
`gates {range, los}` naming any failed precondition. Effort escalates (the 0.4.1 budget ladder),
the truth predicate never silently relaxes. A goal already satisfied at start completes as
`already_there` without moving the body — and since 0.88.0 it still does when the body has since
**drifted**: a hovering body wanders about a block while doing nothing, which is the whole reason
`TRAVELED_EPSILON` exists, but the arrival test did not use it, so a reach goal satisfied at the
moment it was asked reported `did_not_start` a second later on 0.14 blocks of drift outside a 4.5
shell (`reach-goals` case 8, three consecutive batteries). A verdict for a body that never moved is
now read from where it **started**, because re-sampling the shell after zero displacement measures
drift rather than the goal. It is never silent: the completion carries `arrival_from:"start"` and the
`drift`, while `gates {range, los}` keeps reporting the instantaneous test — so a reader can see both
the verdict and the reading it declined to use. Anything that actually travelled is past the epsilon
and untouched, including a body genuinely shoved out of range. Live-verified 16/16 (2026-07-23, headless; the first run
caught and fixed four real defects — range anchor, corner-graze LOS, boundary landings,
eye-inside-target — details in TODO.md).

All ladder tools are `ExecutionContext.SERVER` with zero client imports → dedicated-server-safe, works
headless. This is deliberate: perception exists independently of rendering.

**The ladder has two rungs, not five** (measured 2026-07-24 — full evidence and prices in
**TOOL_BILL_PLAN.md**, which is the authority on the tool bill). The static tool prefix is re-read
every turn and is 50–92% of the bill, so which tools a session is *shipped* is a first-order cost.
Ablation says the value sits at the extremes: `get_region_summary` (LOO **−13**) at the top, exact
point identity at the bottom, and the middle — `get_blocks`, `scan_box`, the surface grid — reads
Δacc ≈ 0 and was called **twice in 60 sessions**. The middle tiers were built as a *resolution*
hierarchy, but resolution is not what a model lacks: it needs either a computed answer over many
cells or an exact fact about one. A surface grid is neither — too lossy to be a fact, too raw to be
an answer, and it hands back the coordinate soup the predicates exist to avoid. This is also why the
ladder was never climbed in production and why compressing the middle (the surface-view arm) changed
nothing.

Consequence, shipped as `MCPTK_PROFILE` in the Node shim (decision record TOOL_BILL_PLAN.md §4b):
the raw reads are **not deleted, just not shipped** to a session whose role never calls them.
`standard` — full minus the three block reads with a benched 1:1 substitute — was the default from
0.28.0 to 0.107.0.

**The default is now `modding`, and the reason is that the ladder above is a claim about a
NAVIGATION rung, not about every role** (RELEASE_1.md §C2). A session authoring geometry writes a
box and reads it back; `locate` does not substitute for `describe_box` there, and for three releases
the default profile could not perform the read half of its own authoring round trip. `modding` is a
keep-list authored from the role the release supports, it carries all three block reads, and it is
smaller anyway (52 tools / ~24.6k tok against `standard`'s 100 / ~42.3k, live 2026-08-28) because it
drops the embodied surface a modder does not use. `standard` stays exactly as benched, so no arm
moves.
Hiding all six benched **97% vs 97%** at ~5% fewer tokens, with `locate` substituting for
`get_blocks_at` 1:1 in the call log. Two caveats ride in the profile definitions: `survey` keeps
`raycast` (hiding it benched neutral, but no rung tests occlusion and it is the only line-of-sight
read), and `play` keeps `get_entities` (substituting `locate what:"hostile"` is reasoned, not
benched — the rungs were terrain and geometry). Standing probe: `mcp-server/probes/profiles.test.mjs`.

**`survival` is the fifth cut, and its reason is different** (mcp-server 0.12.0; plan authority
SURVIVAL_MODE_PLAN.md §3): the other profiles withhold reads that *measured* redundant, this one
withholds reads a player body has no legal access to — the world-truth searches, the operator/edit
surface, and (§5b) `raycast_fan`. The fan goes because the ambient retina already fires it and
`bot_scan` sweeps it deliberately, so a hand-called fan is fan-spam X-ray. **Hidden ≠ illegal**:
`raycast_fan` stays a legal provenance name in the observation store, which is precisely what keeps
the retina's own captures admissible. What replaces it is *embodied* — **`bot_scan`**
(`mcp-server/memory/scan.mjs`, a Node-local tool) turns the body with real `bot_look` steps, fires
the retina's own fan args at each facing, captures every fan as DELIBERATE, and returns **only a
summary**: coverage before/after, the sectors swept, the annotate appendix. No block data enters the
context — memory rides the reads. 360° is four fans at 90°; `direction`/`arc`/`pitch` scan one way
(the direction a locate miss names). A deliberate look is paced by real look calls, never an instant
omniscan.

**What is over your head is part of that summary, and it is a classifier, not an inference** (`overhead`: `open_sky | canopy | surface | water | solid`, mcp-server 0.33.0). `sees_sky` is `level.canSeeSky()`, whose MOTION_BLOCKING heightmap counts leaves AND water as blocking — so a forest floor, a kelp bed and a real cavern all arrive as `sees_sky:false`, and the render has to tell them apart from the materials tally alone. It did not, and for months answered all three with "a cave or cavity worth following". The cave voice now speaks only over `solid`; the other states each say what the roof is made of. `classifyOverhead` is pure and exported precisely so the cases are checkable offline — see PERCEPTION_NAV_FIXES.md §4.1a for why the veto excludes dirt, sand and gravel, which is the part that is easy to get backwards.

Rejected while deciding this: **moving the shared coverage doctrine out of tool descriptions into the
session charter.** It measures 14% of description text (`get_entities` is 68% contract restatement),
but descriptions must be **self-contained** — the charter reaches Claude Code sessions via the
SessionStart hook and does not reach an arbitrary MCP client. Factoring it out would leave the
honesty contract present for our sessions and silently absent for every other consumer.

### Perception modes (vocabulary now, enforcement later)

| Mode            | Meaning                                              | Status |
|-----------------|------------------------------------------------------|--------|
| `authoritative` | Direct server- or client-state query (registries, menus, chat, assets, data) | **Labeled, live** (0.87.0): the client observe tools carry it; `query_registry`-class server reads carry the mechanism tag and no world envelope, being world-anchored to nothing |
| `spatial`       | Everything in a geometric region, visibility ignored | **Labeled, live**: `get_entities` / `get_blocks` / `scene_summary` carry `perception_mode:"spatial"` + per-entity `line_of_sight` |
| `visible`       | Frustum + line-of-sight (+ light) — simulated eyesight | Enforcement deliberately not implemented; `raycast` is labeled `visible` (a ray IS a look) |
| `rendered`      | What a framebuffer actually displays                 | `screenshot` |
| `remembered`    | Agent memory; possibly stale                         | **Built** (step 6, 2026-07-19): `mem_*` tools, MEMORY_DESIGN.md |

**Decision — label, don't enforce.** Every observation gets a `perception_mode` field. `visible`-mode
*enforcement* is parked until the autonomous-player profile needs it, because:

1. There is no product reason to make the copilot rotate a drone through six viewpoints to learn what the
   server can answer accurately and cheaply.
2. Naive "realism" models are *sub*-human, not human-equivalent: Minecraft doesn't hide entities in darkness
   from a player's screen, and FOV limits penalize an agent that can freely `bot_look` no differently than a
   human turning their head. Honest labeling beats dishonest simulation.
3. Interim nuance is cheap: spatial results can carry a per-entity `line_of_sight` flag — the planner still
   gets the entity, but knows it's behind an obstruction.

### Observation envelope (built — step 1, 2026-07-19)

Every perception-ladder observation carries a standard envelope: `game_tick`, `perception_mode`, `source`
(origin label), coverage (see below), truncation flags.
Rationale: **ground-truth sensing guarantees returned facts are correct — it does not guarantee missing
facts are absent.** The real epistemic hazard here is the false negative from a truncated/capped read ("no
water nearby" concluded from a clipped grid), not sensor noise.

**The client twin (0.87.0 — the backfill this paragraph used to defer).** The non-ladder observe tools
were reaching the model with a mechanism tag and nothing else, so a screen tree read this tick and one
read three minutes ago were the same object in a transcript, and memory capture had to refuse them
rather than date them by guess. `client/ClientEnvelope` now stamps every CLIENT-context `observe`
result at the same `BridgeServer` chokepoint as the mechanism tag and the embodied envelope, and only
into fields the handler left unset. Two things make it not simply a copy of the server envelope, and
both are stated rather than papered over: the clock is **the client's** level (on a multiplayer client
that is not the server's tick, and reporting the wrong one is the silent-wrong-answer path `dimension`
exists to close), and there may be **no world at all** — a title screen, a server list, a disconnect
screen are screens these tools legitimately read, so `game_tick` and `dimension` are written as
explicit JSON `null` there. The absence of a clock is a fact about the read; an omitted key is a hole
a consumer has to guess about, and a fabricated `0` is the lie. `perception_mode` is `rendered` for
the two tools that read pixels (`screenshot`, `screenshot_annotated`) and `authoritative` for the ones
that query client state. The server-side remainder needs nothing: `query_registry` and its siblings
are anchored to no world, so the envelope has nothing to say about them and the mechanism tag is the
whole contract.

**The embodied twin (0.35.0, SURVIVAL_MODE_PLAN.md §4).** Acting produces observations too, and an
observation nothing can date or place is uncapturable. `DroneTools.stampEnvelope`/`stampEnvelopeFor`
gives every `embodied` result `game_tick` + `dimension` **from the body's own level** — the read
side's `WorldPerceptionTools.addEnvelope` twin, stamped at the same `BridgeServer` chokepoint the
mechanism tag is stamped at, and only when the tool did not stamp already (an async waited verdict
carries its completion-time stamp, which is the honest one). On top of that, **traversal is
observation**: `nav/TraversalTrail.java` records one cell per path node the grounded navigations
(walker and player) actually reach, storing the **real feet/head/ground block ids read AT TRAVERSAL
TIME** — a swimming body's feet honestly record water; nothing is assumed air. Nav verdicts carry the
drained trail as `traversed` rows `[x,y,z,feet,head,ground]`, capped at 256 with a
`traversed_truncated` flag when cells were dropped (a silent cap would read as full coverage). Node's
`captureProprioception` (`memory/capture.mjs`) writes those cells under the reserved
`proprioception` provenance name — "a player knows the corridor they walked through" — and refuses
to capture a trail whose envelope is missing rather than dating it by guess.

**Enforcement (2026-07-23): `mcp-server/probes/conformance.test.mjs`** sweeps the live `/tools`
manifest and holds every tool to a declared contract tier (spatial envelope+coverage / observe /
act) including the null-verdict-over-unread-space rule, with a ratchet: a manifest tool without a
spec entry fails the suite, so new tools declare their tier the day they ship. Known deviations are
carried as flagged gaps in the suite (currently `scene_summary`'s divergent `dimension`/`coverage`
shape — TODO, part of the wider trust-repair item). Two holes in the sweep itself closed in 0.87.0.
**Argument shapes**: the ratchet is keyed by tool NAME, so it could only ever hold whichever shape of
a tool was written into the table first — which is how `check_path`'s `reach` (shipped 0.5.0,
live-verified 16/16 by `reach-goals.test.mjs`) went years without an entry; a spec may now declare
`variants`, and `reach` has one. **The client surface**: the client tier's "never called" rule was
doing two jobs, keeping the probe's hands off the human's screen and, by accident, keeping the whole
client surface out of every contract check there is — the five read-only client tools (`get_screen`,
`get_screen_graph`, `get_chat`, `list_assets`, `measure_text`) are now called and held to the client
envelope above, while the eleven that click, type, capture pixels or quit stay untouched; the 2026-07-23 sweep also showed
`raycast`/`raycast_fan` already fully envelope-compliant. `get_entities` came into contract in
0.4.3 (2026-07-23): chunk-counted coverage via residency accounting and a null `total` over a
fully unsearchable radius, enforced as its conformance verdict. In 0.5.1 it additionally *stages*
absent chunks (see "Entity reads stage; ticking is truth" below), so the unread remainder shrank
to never-generated terrain, the paging budget, `load:false`, or in-flight entity data.

#### The coverage contract (hardened 2026-07-21)

`get_blocks`, `get_blocks_at`, `scan_box` and `scene_summary` return a `coverage` object — `{requested, read, unloaded,
unvisited, state, note?}` — where **`state` ∈ complete | partial | none** is the field to branch on.
`none` means *nothing was read at all*, and its note says in words that absence is not evidence of
absence. `scene_summary` additionally reports `origin_loaded` and **leads its `sentence` with the
caveat**, because the sentence is the line an agent reads first.

Two invariants make it trustworthy: **accounting closes** (`read + unloaded + unvisited == requested` —
`unvisited` exists because truncation stops the sweep early, so those columns are neither read nor
known-unloaded), and **`covered_radius` only advances through rings with no holes**, so "no X within
covered_radius" stays a valid conclusion.

Motivation, from the 2026-07-19 ablation transcripts: these tools used not to force-load, so in a
headless world they sampled a non-resident world and returned *confident-looking default terrain*.
`get_blocks` reported `covered_radius == grid` beside zero columns — survey extent claimed over an
area it never looked at — and `scene_summary` narrated a clean sentence built from generator defaults.
Agents correctly distrusted the output and fell back to **662 `data get block` / `execute if block`
commands**, none of which can report a block id either, so none of them ever got an answer. An unread
read must never be mistakable for an empty one. Regression guard:
`mcp-server/probes/perception-coverage.test.mjs` (`npm run test:live`, needs the dev server).

#### Reads page chunks in; reads never generate (2026-07-21)

Perception pulls absent chunks in by itself, so remote coordinates read without staging and the agent
never has to think about residency. **Generation is excluded, on measured cost.** On the dev world:

| | per chunk | non-local? |
|---|---|---|
| page in an existing chunk | ~12–16ms | no |
| generate a virgin chunk | **~900ms** | yes — the pyramid reaches `MAX_STRUCTURE_DISTANCE` (8), so one chunk touches hundreds of slots |

A single generated chunk costs more than an entire wide survey of existing terrain, so implicit
generation would mean "looking at a map" silently creating world, slowly. Virgin chunks are counted as
`coverage.chunks.ungenerated` and the note names the deliberate remedy — `forceload` via `run_command`,
where creating terrain stays audited as `privileged` instead of hiding inside an `observe`. Paging is
bounded by a chunk count (48) and a wall-clock backstop (1.5s); leftovers ride the coverage contract.

Rays ride the same rule (2026-07-22 review): `raycast` / `raycast_fan` used to hand vanilla `Level.clip`
an unclamped segment, and clip resolves chunks through the blocking load-or-*generate* path — an observe
tool that created terrain and stalled the server thread. Rays are now clamped at the first chunk the
loader can't supply (one shared budget per fan) and report `hit:"unread"` with `range_covered` — never
"miss" — when nothing was struck in the readable stretch. `get_entities`' per-entity `line_of_sight`
went tri-state for the same reason: `null` when the sightline crosses a non-resident chunk (a cheap
residency test; a per-entity embellishment doesn't rate paging), because an unknown sightline must not
masquerade as a verdict in either direction. Regression guard: `mcp-server/probes/review-fixes.test.mjs`.

#### Entity reads stage; ticking is truth (0.5.1, 2026-07-23)

Entity data loads through `PersistentEntitySectionManager`'s *async inbox*: paging a chunk to FULL
queues its entities (`requestChunkLoad` fires on the FULL broadcast — plain accessibility, not
entity-ticking), and `processPendingLoads` applies them on the **next** entity-manager tick. So
"reads cannot page entities in" was only true *within one tick*. `get_entities` now exploits that:
it pages absent chunks through the same shared `ChunkLoader` (never generating), then **parks as an
async tool** until every awaited chunk reports `areEntitiesLoaded` — normally the next tick, with a
10-tick deadline for a slow entities-region read — and answers with the same coverage contract.
Remote entity surveys work without staging, exactly like block reads. Chunks still unread have a
named cause (never-generated / budget / `load:false` / data still arriving at the deadline — that
last one wants a re-query, not a forceload).

The axis that stays privileged is **simulation**. A paged-in chunk is loaded but *not ticking*: its
entities exist frozen at their as-saved state — not acting, not moving, no despawn timers. Implying
entity-ticking from an observe would let looking at a place perturb it (the exact line the read
ticket draws); `forceload` via `run_command` remains the audited way to make an area run. Instead
the freshness is *reported*: every described entity in a non-entity-ticking chunk carries
`ticking:false` (`ServerLevel.isPositionEntityTicking`; absent = live — get_entities rows and
raycast entity hits alike), and `get_entities` totals them as `frozen` + `frozen_note`.
**0.21.0: `locate` rides the same staging** — the generalized `stageEntityRect` (one mechanism,
one definition) pre-stages `what` entity searches and pattern entity nodes, so the full-ladder
substitution verdict carries the staged-remote-negative capability with it; locate's entity
coverage counts `areEntitiesLoaded` post-stage, and a chunk whose data misses the deadline is
named as wanting a re-query, never sold as empty. Without the
flag, a frozen villager reads exactly like a live one — the coverage-contract failure class on the
freshness axis instead of the visibility axis. `scene_summary`'s `entityCounts` got the residency
annotation half of this (`searched_chunks`/`unsearched_chunks` + a lower-bounds caveat in the
sentence); it stays a one-tick snapshot and deliberately does not stage.

#### `get_blocks_at` — the point-read rung (2026-07-21)

The ladder had no rung that answers **"what is at (x,y,z)?"**: `get_blocks` samples the *top* block of
each column (a heightmap), `scan_box` describes a volume statistically, `raycast` needs line of sight.
Meanwhile `set_blocks` *writes* exact coordinates with full state and NBT — the ladder could write a
block precisely and never read it back. That asymmetry is what the 662 commands were flailing at.

`get_blocks_at` takes up to 256 `{x,y,z}` entries and returns a shared palette of `id[state]` strings
in **set_blocks syntax, so a read round-trips into a write**, plus rows `[x,y,z,paletteIndex]`.

> That rule had exactly one exception for two years, and 0.89.0 closed it: `describe_box`
> `detail:"layers"` keyed its legend by BLOCK ID, so a wall of stairs facing four ways drew as four
> identical characters — the view whose entire job is exact geometry was the one that could not be
> written back. Its glyphs are per STATE now and its legend speaks the same syntax, and `set_blocks`
> takes the picture (`min` + `legend` + `layers`) as a second encoding of its own `blocks` array.
> See STRUCTURE_AUTHORING_DESIGN.md §9. An
optional per-entry `expect` tests that position with vanilla's own `BlockInput` predicate — the exact
matcher `/execute if block` uses, partial-property and NBT semantics included — turning N verification
probes into one call that reports `check.all_matched` and, for each failure, *what was actually there*.
`-1` in the palette or match slot means "not read", never a guess, and an unreadable position can
never count as a pass. Measured against the original ablation task: 12 positions verified in **one
call, 30ms, ~241 tokens**, versus 662 commands and ~33,595 tokens that confirmed nothing.

The read ticket is deliberately the opposite of `/forceload`'s. Vanilla's `FORCED` is
`persist|load|simulate|keep-dimension-active` with no timeout — it survives restarts and leaves the
region *ticking*, which is why a forgotten one is permanent. Reads use `load|can-expire-if-unloaded`
with a timeout: no simulation, never written to the save, and leak-proof (there is no unload call to
skip if a read throws). Vanilla's own `MAX_CHUNK_LIMIT = 256` on `/forceload` is an argument-arity
guard, not a cost control — there is no cost control in that path at all.

**No confidence scores, ever** (see Don't-build). Uncertainty in this domain is *staleness* (timestamps)
and *inference* (the planner's job), never detection noise.

## Origin is a sensor seam, not embodiment

The corrected claim (the old javadoc overstated this; fixed 2026-07-19):

`Origin(level, eye, view, label, source)` answers **"from where is an observation made?"** — nothing more.
It is an excellent *observation-origin* seam: player eyes, explicit coordinates, and the drone's eye all
slot in with zero tool changes. It is **not** an embodiment contract: it carries no body, reach, inventory,
capabilities, or action authority.

Embodiment arrives as a separate **actuator contract** — built with drone hands (roadmap step 4,
2026-07-19), generalized to two body kinds with possession (2026-07-21): `drone/Actuator.java` wraps the
session's **active body** — its possessed mob while a possession is live, otherwise its spawned body
(flyer, walker, or player — the body architecture, authority **BOT_SURFACE_DESIGN.md** §11) — and every
acting tool passes through `Actuator.require()`. Capabilities are honest per body kind: every body can
move/look/attack; the hand-having bodies have **hands**; only the drone has the **beam**; a possessed
mob moves with its own legs (ground pathfinding) and sees with its own eyes (the `drone: true`
perception origin follows the active body).

```
ObservationOrigin   where information comes from        (exists: Origin)
Actuator            body the AI commands: position, reach, inventory, capabilities
                    (exists: Actuator → active body = possessed mob | walker | player | drone)
Hands               the hand verbs' subset of a body    (exists: Hands → toolkit body | player)
```

**The `Hands` seam** (0.35.0, design authority BOT_SURFACE_DESIGN.md §13.1): `drone/Hands.java` is one
contract for the two hand-having body kinds — `BotBodyEntity` (the toolkit bodies, now
`implements Hands`, behaviour unchanged) and `Hands.PlayerHands` over `FakePlayerEntity`.
`Actuator.hands()` returns a `Hands` (it used to return the drone entity itself) and still refuses with
`no_hands` semantics for a possessed mob rather than pretending a wolf can hold a pickaxe; `DroneHands`' verbs
— mine/place/use/shoot/give/inventory — all run through it, so there is one verb body per question,
not one per body. The interface is deliberately the *used* subset (carried container, selected slot,
insert-with-leftover, dig ticks, the visuals, and "am I a real player?"); position, level and reach
already live on `Actuator`. What the player body wins is **native, not simulated**: dig timing is the
engine's own (`getDestroyProgress` — tool tier, efficiency, haste, fatigue, water, off-ground; zero
tuned constants, against the drone's `hardness × 10` house rule), `bot_use` passes a **real player**
into `UseOnContext` so the behaviours that need one finally work, and drops land in the real 36-slot
`Inventory`. Two consequences of taking the engine's word: a named `item:` on a *player* dig is
selected into the hand first, because the formula reads what the body **holds** (the drone's house
rule ignores the tool for timing, so its held slot stays untouched), and a dig the engine prices at
zero progress refuses `cannot_break` up front instead of sitting "in progress" forever.

**Possession** (`bot_possess`/`bot_release`, `drone/Possession.java`): two `PuppetGoal`s injected at
priority 0 (one per goal selector) claim every control flag, starving the mob's native AI without erasing
it — release restores the mind untouched. Goal-driven mobs only; brain-driven mobs (villager-like) are
refused with `brain_mob_unsupported` (detected via `Brain.isBrainDead()`). One session per body, enforced.

### Session roles (to build, small)

Three roles, enforced — not a YAML blob nobody checks:

- **principal** — who authorizes and owns the task (the player)
- **observer** — where information comes from (active body / player / coords)
- **actuator** — what the AI may command (the active body: drone or possessed mob; else none)

Configurations this expresses: `{principal: player, observer: drone, actuator: drone}` once a drone is
spawned (Claude watches *and* acts through it), `{…, observer: possessed mob, actuator: possessed mob}`
during a possession, or `actuator: none` with no body — the acting tools enforce exactly this, refusing
when `Actuator.current()` is null. Benchmark profile: observer = actuator = a constrained body,
`perception_mode: visible` required. A `collaborator` role was considered and **dropped** — derivable
from principal in every configuration this project will see.

### Control layers above single commands (built 2026-07-21)

The tick watch renders continuous/batched behavior in Java while the agent thinks — the agent sets
intent; code executes it every tick with player-visible feedback:

- **Follow mode** (`bot_follow`, `drone/Follow.java`) — station-keeping on a moving target with
  automatic re-pathing and camera aim (`look: target|mirror|forward`; mirror = behind-the-shoulder,
  copying the target's view). Replaces the goto-per-correction loop; ends on explicit movement
  commands, `stop`, or target loss (`follow_lost` event).
- **Step queue** (`bot_run`, `drone/QueueRunner.java`) — up to 64 embodied steps run sequentially
  server-side (goto|mine|look|place|use|attack|select|point|wait), abort-on-first-failure with
  `{step_index, op, reason}`; steps reuse the exact tool bodies, so events/audit/visuals are identical
  to hand-issued actions.
- **The corridor verb** (`bot_tunnel`, 0.50.0, `GoalRunner.startTunnel`/`tickTunnel`) — a
  `height`-tall passage `length` blocks in a compass direction, dug and walked and optionally lit, as
  ONE call. Session w2-56123 spent 347 `bot_mine` + 187 `bot_target` calls — a third of everything it
  did — hand-cranking corridors one block at a time. It is a **goal, not a client-side loop**, and
  that is the design: it inherits budgets, the profile, the ledger (so a partial tunnel resumes
  without a survey turn), supersession and the watchdogs for free. Its state machine is
  *position-driven* — every tick re-decides from where the body actually is, never from a step counter
  that can drift out of agreement with the world. `slope:"up"` is the same primitive rotated: a
  **staircase**, which with `until_sky`/`to_y` is the answer to "there is no route home" — descending
  is gravity plus a pickaxe, while ascending 50 blocks was asking the solver for a path it will not
  find (w2-56123 ended stranded at y=16 with `pillar_blocked` 28 times). It stops honestly on
  `fluid_ahead` (it never digs a fluid — see the act-verdict section), `unbreakable_ahead`,
  `break_budget_spent`, `stuck`.
- **`wait: true`** on `bot_goto`/`bot_mine`/`bot_run` — the tool's future completes when the action
  finishes; the bridge's HTTP thread parks (dispatch timeout raised per-tool), deleting the
  poll-get_events loop for single actions. A wait timeout abandons only the wait, never the action.
- **The beam** (`bot_point`, synced entity data + guardian-style client render) — the drone's action
  language: white-cyan pointer (agent→player "look here"), orange dig beam (with the vanilla crack
  overlay via `destroyBlockProgress`), red attack flash (plus a client-side lunge). Drone-only
  hardware.
- **The goal loop** (`bot_target`, `drone/GoalRunner.java`, 0.15.0 onward — full record in
  BOT_SURFACE_DESIGN.md §§3, 10–13): navigate-repair-act as one server-side goal instead of an
  agent-side goto/dig/place loop.
  **Widened `Mob` → `LivingEntity` in 0.35.0** (§13.2): the runner reaches navigation through the
  existing `Bodies.nav` seam (extended with `drainSelfLeaps()` and `trail()`) and reaches
  `NavSolver.solve` through a new `physique()` dispatch (a `Mob` wraps as `MobPhysique.of` with the
  profile's door rights overlaid; the player **is** its own `NavPhysique`), and `Targets.resolve`
  widened the same way. So `bot_target`'s `player_goals_pending` refusal is **gone because the
  capability landed, not because the gate was loosened** — the honest-refusal doctrine means a
  refusal disappears only when the body can really do the thing. Repair actuation stays honest *per
  body*: a player's JUMP repair navigates to the landing so the driver's own gated run-up self-leap
  takes it from the lip (a bare impulse fired from repair range undershoots into exactly the gap it
  planned over — §11.8's measured finding), while PILLAR uses the generic impulse plus a real
  `bot_place`.
- **`bot_target action:"vantage"`** (0.35.0, `drone/Vantage.java` + GoalRunner; SURVIVAL_MODE_PLAN.md
  §7) — "get somewhere you can SEE that", the reach goal's line-of-sight sibling and the piece that
  closes the legal profile's exploration loop (locate miss → frontier direction → walk somewhere with
  a view → the retina fills the store → re-ask). Standable stand cells are sampled on rings around
  the target (nearest ring first, feet/head pathfindable over solid ground), kept only with an
  eye-to-target sightline, and tried nearest-the-body-first through the reach-goal nav shape.
  **Arrival is not the verdict**: LOS is re-verified live from the body's real eye on arrival →
  `los_achieved` (the body is turned to face the target), else the next candidate, else
  `no_vantage_reachable` / `no_vantage_found` carrying the standard obstruction locus. A candidate
  occluded en route therefore costs one leg of travel, never a false success.
- **The danger sense** (`drone/Hazards.java` + the player-body vitals watch in `DroneTools.tickWatch`,
  0.36.0) — the environmental half of proprioception, and it exists because the first human-watched
  survival session **drowned**. Neither the model nor the reflex layer reacted, and neither *could*:
  `bot_status` reported health and food and nothing about air, water or footing; the reflex trigger
  vocabulary had no environmental term at all; and the player body sat outside the vitals watch
  entirely (the whole watch was gated `if (drone != null)`), so it took damage and died in total
  silence — the only trace was its own absence. The model then invented a cause (a cave pocket and a
  flee reflex that never fired) and chased a phantom respawn blocker. **A body that can be killed by
  something it has no word for will keep confabulating, so the fix is a sense, not a prompt.**
  `Hazards` ticks once per server tick beside the observer and evaluates six causes — `air_low`
  (breath ≤150 of 300), `in_lava`, `on_fire`, `falling` (fall distance >4), `suffocating`,
  `starving` (player food ≤6) — emitting the `body_endangered`/`body_safe` onset/clear pair
  (vocabulary below). Every cause is *also* readable on demand: `bot_status` gained `onGround`,
  `inWater`, `submerged`, `air`/`maxAir` and a `dangers` array, reported always rather than
  only-when-interesting, because an event is a notification and the agent may arrive after it.
  **Acting on the sense is the reflex layer's job**, not the agent's: the `air_below {ticks}` trigger
  (default 150) pairs with the `surface {ticks}` response, which holds the jump input until the eye
  clears water and is honest when it cannot (`ok:false`, `still_submerged`). Drowning kills in ~15s,
  which is faster than one agent turn, so this is the layer that *has* to act — and a player rises in
  water by HOLDING JUMP, a flag the nav driver only ever set for a leap, which is precisely why the
  body sank. One claim in this slice was deliberately left **unasserted until the probe settled it**:
  that `setJumping` survives `PlayerNavigation`'s per-tick `driver.idle`. It does — verified live, not
  reasoned into the doc. Standing probe: `mcp-server/probes/hazards.test.mjs` (7/7 live headless — the
  dry-vs-submerged `bot_status` control, exactly-once onset across seconds of drowning, the clear, the
  named damage cause, the reflex demonstrably raising the body, and the unsaved death with cause +
  hazards + a freed name).

## Action: mechanisms, never conflated

Every `ToolDef` declares a **mechanism**; the dispatch layer stamps and (where applicable) gates it:

| Mechanism    | Meaning                                                            | Examples |
|--------------|--------------------------------------------------------------------|----------|
| `observe`    | Reads; no world mutation                                           | perception ladder, `get_screen`, `bot_status`, `get_log` |
| `embodied`   | An actor body does it; respects reach; can fail physically         | `bot_goto`, `bot_mine`/`bot_place`/`bot_use`/`bot_attack`/`bot_select`/`bot_craft`, `bot_follow`/`bot_run`/`bot_point`/`bot_target`, `bot_possess`/`bot_release`, and Node-side `bot_scan` |
| `world_edit` | Direct server edit; instant; mass-effect; previewable; undoable    | `place_shape`, `place_shapes`, `set_blocks`, `place_structure`, `edit_building` |
| `privileged` | Arbitrary authority; audit mandatory                               | `run_command`, `hotswap_class`, `push_asset`, `push_data`, `capture_structure` |

"Clear these trees" done by drone-mining and done by `world_edit` are **different acts** with different
failure modes, permissions, and consequences — responses must say which happened
(`mechanism`, `authorized_by`, `undo_id` where applicable).

**Enforcement locus decision:** the `McpTools` dispatch chokepoint, where `ExecutionContext` already lives.
A declared-but-unchecked contract would repeat the Origin mistake — a claim the code doesn't embody — and
would *look* like a security boundary while not being one.

**Sharpest known gap (motivates roadmap step 1):** `run_command` and the world-edit tools currently act
with *undeclared* authority — no mechanism tag, no audit trail of what the AI changed.

### Authorization split (decision)

The copilot runs inside Claude Code, whose harness already provides **call-level** consent: per-tool
prompts, allowlists, deny. The mod must not duplicate that. Mod-side authorization covers only what the
harness cannot see:

- **argument-level constraints** (edit only inside this region; attack hostiles, never pets; autonomy
  windows) — added *when a concrete scenario needs one*, not as a speculative taxonomy;
- the **audit trail** (see event log) — the harness approves calls, the mod records consequences.

### Transactional world edits (built — step 5, 2026-07-19)

`world_edit` responses carry the transactional envelope — `game_tick`, the `dimension` actually written
(2026-07-22: identity over enforcement, mirroring the perception envelope), affected `region`
(min/max/size), block counts, and a per-op `undo_id`. `dry_run` (now on both `place_shape` and
`set_blocks`) previews as a count + region with a null `undo_id`, changing nothing. Undo is a shared
bounded journal (`EditJournal`, 32 edits): each edit snapshots prior block **state + block-entity NBT**
and restores bit-identically through vanilla `BlockInput`, so undoing over a chest brings its items back.
The single-slot `undo_shape` is replaced by `undo_edit {undo_id?}` (defaults to latest, undoes out of
order) + `list_edits`; an over-cap edit (>200k cells) applies and says so (`undo_reason: over_cap` beside
the null `undo_id`, distinguishable from a dry run). Preview stays a **dry-run diff report** — explicitly
not a hologram/ghost renderer.

Journal lifecycle hardening (2026-07-22 review): the write tools take an optional `dimension` (default
overworld — the read/write round-trip `get_blocks_at` promises now lands in the same world, and `bot_spawn`
with an explicit `pos` takes one too); the journal clears at SERVER_STOPPING (an edit is only restorable
into the level it was recorded against, and on the integrated server the process outlives worlds); and
`undo` removes the journal entry only after the restore loop finishes — a mid-restore throw re-files the
unrestored remainder under the same id and says so, instead of destroying the only record of a half-undone
region.

**Batched ops share one transaction** (0.76.0, `place_shapes` — STRUCTURE_AUTHORING_DESIGN.md §4/§6). The
batch is the unit a person reverts, so an N-op call files **one** journal edit and returns **one**
`undo_id`, and the block ceiling is a budget over the *call* rather than per op — with `truncated_at_op`
plus per-op `partial`/`not_run`, because a call-wide budget means an op can be reached with the budget
already spent and all-zero counters would otherwise mean two different things. Ops apply in array order
and each reads what the ones before it left, which forces the preview's shape: a batch `dry_run` carries
an **overlay of pending writes** so the simulated ops see each other. Without it every op reads the
untouched world, and the canonical authoring move — fill a shell, then carve air inside it — previews the
carve as "already air, 0 placed" while a second solid op over the same cells previews them twice. Same
cause, opposite errors; the probe therefore asserts the preview equals the live run rather than a
hand-computed constant. Parse is separated from execute for the same reason order matters: a malformed op
refuses the whole call naming its index, because a half-applied batch leaves a structure whose remaining
ops were written against geometry that never appeared.

### Act verdicts are verified (0.6.0 — the succeeds-falsely purge)

The perception side had the envelope/tri-state doctrine; the action side got its counterpart in 0.6.0,
after the 2026-07-23 tool-surface audit named the class: **silent wrong-success is worse than failing
opaquely**. The rule, now embodied across the act tools: *a success claim is computed from the
operation's observed outcome, never from intent* — and where the outcome can't be known, the response
says so instead of asserting.

- **Hands**: `bot_mine`/`bot_attack` refuse `item_missing` for a named item not carried (no more silent
  bare-handed digs sold as success); mine echoes `tool` and pre-announces `drops_expected:false` on a
  wrong-tier dig; `bot_place` pre-checks `canSurvive` (`unsupported_position`) and branches on the
  actual `setBlock` result (`place_rejected`) — the item is consumed only after a confirmed write;
  `bot_use` surfaces the vanilla `InteractionResult` as `effect: used|none` + `block_changed`, and its
  `use_unsupported` catch-all carries the underlying `detail`. `bot_attack` wields a copy (no
  equipment/inventory aliasing → no dupe) and writes durability back; the held weapon now genuinely
  applies by default.
- **The tool-tier gate is ours to run** (0.49.0, `DroneHands.tick`). Vanilla puts the "wrong tool ⇒ no
  drops" rule in exactly one place — `player.hasCorrectToolForDrops(state)` gating `playerDestroy` in
  `ServerPlayerGameMode#destroyBlock` — and **not** in the loot table. Coal ore's table
  (`VanillaBlockLoot#createOreDrop`) is a bare silk-touch dispatch with no tool condition. Since a
  non-player harvester can only enter through `Block.getDrops`, which does not run that gate, every
  dig this toolkit performed dropped as if correctly tooled: a **sword mined coal ore and got the
  coal**. That is not a cosmetic divergence — it deletes the entire incentive to craft a pickaxe,
  which is the first rung of the survival tech tree. Worse, `startMine` had *already* been announcing
  `drops_expected:false` on those digs since 0.6.0, so the one honest instrument the body owned was
  falsified by the very next event; a prediction contradicted every time it fires trains the reader to
  discard the field. `tick` now computes `mayHarvest` and passes an empty drop list when the recorded
  tool is not correct-tier, and the completion repeats `drops_expected:false` with a note naming the
  block and the tool actually swung. Start and finish now agree.
- **Enchantments are disclosed** (0.50.0, closing the gap this bullet used to record). `Block.getDrops`
  receives the recorded `ItemStack`, so the loot table *does* consult its enchantments: Silk Touch
  flips ore to the ore **block**, Fortune multiplies the yield. Both change what the body receives,
  and neither appeared anywhere in the tool surface — `bot_mine` echoed `tool` as a bare item id, so a
  Silk Touch pickaxe and a plain one were indistinguishable in every response the agent could read.
  The failure mode is quiet and specifically bad for a survival body: it mines a coal vein, banks
  eight `minecraft:coal_ore` items, and owns no fuel. `startMine` now echoes `tool_enchantments`, and
  when Silk Touch would change *what item class* the dig yields it pre-announces `drops_as` — asked of
  the loot table both ways rather than hard-coded, so it is true for modded blocks too.
- **The one-way mirror is closed** (0.50.0, `DroneHands.echoAct`). Every honesty measure above lives in
  a *reply*, and `GoalRunner`/`QueueRunner` read three fields off that reply (`started`, `reason`,
  `action_id`) and drop the rest. Since most digs in a survival run are goal-driven, most warnings this
  toolkit produced never reached a reader: `drops_expected` appears **zero times** in session
  w2-56123's 6 MB transcript, which is also how 7.5 minutes of sworded mining and an 8-minute dig on a
  water source stayed invisible. Goal- and queue-driven acts now emit `act_warning` whenever the
  swallowed reply carried a note, a `drops_expected:false`, or an eta over a minute. A warning the
  agent cannot see is not a warning.
- **Crafting is the game's verdict, not ours** (`bot_craft`, 0.35.0, `drone/Crafting.java`; design
  authority BOT_SURFACE_DESIGN.md §13.3). There was **no crafting surface at all** before this — the
  2026-07-30 survival session failed to make planks through a *missing verb*, not through incapacity,
  and an absent verb is indistinguishable from an incapable body from inside the session. Vanilla's
  own matcher is the authority: candidates are laid into the recipe's own grid and verified by
  `recipe.matches(CraftingInput)` **before anything is consumed**, the result comes from
  `recipe.assemble`, and `getRemainingItems` is honoured (buckets come back) — nothing is hand-priced,
  and each round re-reserves from the live container and re-matches. The 3×3 gate is **world truth,
  not a simulated menu**: a recipe wider than the 2×2 pocket grid refuses `needs_crafting_table`
  unless a crafting table sits within block reach of the eye — the reach every hand verb already
  enforces, so "you carry 2×2, a table unlocks 3×3, you must be AT the table" is enforced without
  inventing a container UI. Refusals name which of the four things is wrong (`unknown_item`,
  `no_recipe`, `ingredients_missing` — with the closest recipe's shortfall — `needs_crafting_table`),
  and `produced` vs `requested` differ honestly when the ingredients run out mid-batch. **0.88.0
  extends the same shape to the two menu-only stations that are also recipes** (design §13.4):
  smithing and stonecutting run through this verb rather than a new one, matched and assembled by the
  game's matcher and gated on vanilla's own `SmithingMenu`/`StonecutterMenu` `isValidBlock` predicate
  — that block, within the same reach. Netherite upgrades had no route at all before it. The
  vocabulary grows by `needs_smithing_table` and `needs_stonecutter`; the anvil, grindstone, loom and
  cartography table stay unreachable **on purpose**, because their outputs are not recipes and a verb
  for them would have to simulate a screen.
- **A fluid is not a diggable block, and a lock names itself** (0.50.0). Water and lava carry
  `strength(100.0F)` and no tool is ever correct for them, so `getDestroyProgress` yields 0.0001/tick
  — **10 000 ticks, 8m20s** — during which `slot.dig` answers `busy` to every other dig in the world,
  for a block with an empty loot table that refills from its neighbours. `startMine` refuses
  `fluid_target` (waterlogged solids are unaffected: they have a real collision shape), any dig over
  1200 ticks announces its own length, `busy` carries `holder {action_id, at, block, eta_ticks,
  started_ticks_ago}`, and `bot_mine {action:"cancel"}` exists at all — there was previously **no way
  to abandon a dig from the tool surface**. The dig also gained the watchdog nav has had since
  0.37.0: frozen under reflex or combat ownership it emits `dig_starved` and eventually fails
  honestly, instead of stopping existing in time. Every one of these is the same lesson: *a body
  denied the real cause will manufacture one* — w2-56123 wrote a fabricated repair recipe into
  persistent memory because nothing would say why its digs were refused.
- **An act may not entomb its own body** (0.50.0). `bot_place`'s precondition is vanilla's own
  `Level.isUnobstructed` (an AABB intersection over every `blocksBuilding` entity), and it now also
  *verifies the outcome*: if the placing body is suffocating in the block it just wrote, the write is
  reverted and the item kept (`would_entomb_self`). The refusal also names the occupant
  (`blocked_by {type, id, self}`) instead of hedging "possibly your own" — a question the server can
  always answer. Note the boundary case that makes the precondition insufficient on its own: vanilla's
  intersection is a *strict* overlap, so a 0.6-wide body at `x.3` spans exactly `[x.0, x.6]` and is
  flush with the neighbouring cell's face, which then reads as free.
- **A goal's verdict is re-verified at the body** (0.35.0): `bot_target action:"vantage"` re-tests the
  sightline from the real eye on arrival rather than trusting the candidate it planned against — the
  reach goal's `gates {range, los}` discipline applied to seeing (see control layers above).
- **World edits count outcomes**: `place_shape` buckets `placed`/`unchanged`/`rejected` from the real
  `setBlock` returns (build-height overflow was counted as placed); `set_blocks` expands its reported
  `region` only on confirmed writes; both drop rejected cells from the undo snapshot. **And a preview
  counts the outcomes it is predicting** (0.76.0): the dry run reads an overlay of its own pending
  writes, so a thick `line` revisiting its own cells previews them as `unchanged` exactly as the live
  run buckets them — it had over-reported them as `placed` since `place_shape` shipped, unnoticed
  because nothing compared the two numbers. `undo_edit`
  verifies each cell's restore and re-files silently-refused cells (`not_restored`) retriably under the
  same id. Edits are session-stamped: bare `undo_edit` defaults to the *caller's own* latest edit;
  cross-session undo needs an explicit id and names the owning session.
- **Removal reasons are real**: `isAlive()` inside an `isRemoved() || !isAlive()` branch is always
  false, so Follow/Possession discriminate on `getRemovalReason()` (`died`/`despawned`/`disconnected`/
  `unloaded`/`changed_dimension`); a possessed body's conversion releases as `body_converted` with the
  successor id (Fabric MOB_CONVERSION hook), and possession verifies its puppet goal actually engaged
  (`possession_ineffective` within ~5 ticks) instead of assuming ownership from injection.
- **Streams and dispatch**: the EventLog clears at SERVER_STOPPING behind a `world_closed` boundary
  event (world A's events no longer serve under world B; the loss is announced, never silent); a bridge
  dispatch that times out *after* the handler started says so ("may still complete — check
  get_events/list_edits") instead of asserting nothing happened.
- **Client tools verify effects**: `close_screen` re-reads which screen is open (`closed` is a checked
  boolean + `now_open`); `click` checks what actually sits at the target point (`blocked_by`) and only
  feeds *consumed* clicks to the nav graph; `get_screen`/`check_layout` walk the full recursive widget
  tree and disclose `unenumerated_listeners`; `set_text` compares read-back to requested; `push_asset`
  propagates the reload's `selected` verdict as `active`.
- **A summary may not contradict the fields beside it** (0.95.0, `get_perf`). The newest member of
  this class is not a wrong verdict but a LAGGING one. `get_perf` reports `mspt` and `tps`, both of
  which are quietly reinterpreted by a frozen, stepping or sprinting server, so it carries a
  `runs_normally` summary and a `note` — and the first draft computed that summary from vanilla's own
  `TickRateManager.runsNormally()`. That method returns `runGameElements`, a flag recomputed once per
  tick inside `TickRateManager.tick()`, so for up to a tick after `/tick freeze` it answers "normal"
  about a server that is already frozen: the probe's first live run got `frozen:true` and
  `runs_normally:true` in one reply. A reader who trusts the summary over the fields is then wrong
  about the numbers the summary exists to qualify. It is now computed from state
  (`!frozen && !sprinting && tickrate == 20`), which is the general rule: **a derived field must be
  derived from the same instant as the fields it summarises**, not from a cache of an earlier one.
- **A truncated list may not look like an empty one** (0.109.0, `get_perf`). The same tool, a
  second time, and the shape is the one this class is named for: `entity_types`,
  `block_entity_types` and `hot_chunks` are ranked TOP-N lists (`top`, default 5), and nothing in
  the reply said so. A caller reading a type it cares about therefore could not distinguish *there
  are none of these* from *this one ranked sixth* — absence and zero were the same value, which is
  the succeeds-falsely pattern with no verdict field anywhere near it. It cost a real red rather
  than a hypothetical one: `probes/perf.test.mjs` read its hopper baseline at the default `top`,
  coerced the missing row to zero, and reported 131 pre-existing hoppers as the census miscounting
  the six it had just placed. **The counting was correct and the reader could not have known**,
  which is why the fix is in the reply and not only in the probe: each list now carries its own
  `*_omitted` count, always present — a field that appears only in the interesting case is one
  every caller forgets to handle — and the description says an absence in a truncated list is not
  a zero. The general rule: **a list that was cut has to say it was cut**, because every consumer
  of a top-N list is one `?? 0` away from asserting something false about the tail.
- **A reload that succeeds is not a file that loaded** (0.91.0, `LogCapture` + `get_log`). The last
  member of this class, and it survived every purge above for a structural reason: the truth was
  never in a tool's reach. Vanilla's data loaders are forgiving *by design* —
  `SimpleJsonResourceReloadListener.scanDirectory` logs a recipe or loot table that fails its codec
  at ERROR and steps over it, and `MinecraftServer.reloadResources` completes normally. So
  `push_data` wrote the bytes, `reload_data` answered `reloaded: true`, and the file had loaded
  nothing; the client half is the same with a model naming a missing texture. Every other entry here
  fixed a claim the code could already have computed. **This one needed a new sense**: an appender on
  the root logger, a watermark taken before the reload, and the WARN-or-worse lines from that window
  handed back as `problems` (with `ok`), plus `get_log` for the log after the fact and an `error`
  event so a session that is not asking still hears. The honest half, on the record: a bad *tag*
  reference always did fail the future and was always reported — recipes and loot tables were the
  silent ones.

  Two rules generalize out of it, both learned within an hour of the tool existing. **A new
  "did it go wrong" field must be validated against a clean baseline or it is permanently true and
  therefore meaningless** — the first live reload reported a problem, and it was the *toolkit's own*
  `pack.mcmeta`, malformed on every reload the toolkit had ever done (`PackFormat` requires
  `min_format`/`max_format` above `lastPreMinorVersion`, 81 for server data and 64 for client
  resources). Left in place, `ok:false` would have meant nothing forever. And **a write-if-missing
  repair never reaches state that already exists** — the packs persist in the game and world folders,
  so the mcmeta fix had to rewrite a stale file rather than skip it.

  **And the glue is part of the sense** (0.97.0, found by §D1's owed client run). `reload()` on the
  client side had computed `ok` and `problems` since 0.91.0, and `push_asset`/`clear_assets` read
  exactly one field out of that object (`selected`) and dropped the rest — so the COMMONEST path,
  push a file and let it auto-reload, answered `written / reloaded:true / active:true` while the
  ERROR naming the caller's broken model sat in the object that had just been discarded. The server
  half (`DataTools.push`) merged the whole thing from the start; the two client callers were the
  asymmetry. A diagnosis that exists and is not carried to the reply is not a diagnosis, and the
  path that gets used must not be the blind one.

  **And a channel that reads what the game SAID has a blind spot the game never speaks into**
  (0.100.0, `DataCodecs`). The bullet above is exact about its own boundary — it catches *rejection*,
  and only rejection the game bothered to log. Three cases were outside it entirely and stayed
  outside it for nine versions: **worldgen is never reloaded at all**, so no line is ever logged
  about a malformed biome and the only instrument was restarting the world; a **batched push**
  (`reload:false`) has no reload window to watch; and a file in a directory **no loader scans**
  produces no log because nothing looked. The fix is not a second opinion — it is the *same*
  authority, asked one step earlier: every datapack loader's codec is loaded in the running JVM, so
  `push_data` decodes the bytes with the loader's own codec before writing them and reports
  `validation`. Verified live to be the same opinion, not a parallel one: a recipe naming a
  nonexistent item comes back with the **byte-identical** message the reload logs a moment later.
  The purge's own rule applies to the new field too — `checked_by` names the mechanism, and a path
  no loader claims gets **no `valid` field at all**, because a validator that answers "valid" about
  a file nothing reads is a new member of exactly this class rather than a cure for it.

  It found its first bug in this repo's own manifest, as every entry in this section has: `push_data`'s
  documented example path had read `data/minecraft/tags/blocks/…` since it was written, and tag
  directories have been **singular** since 1.21 (`Registries.tagsDirPath` is `"tags/" + <registry key
  path>`; `Registries.BLOCK` is `block`). The toolkit was pointing modders at a directory the game
  does not scan — the exact silent failure the new resolution exists to name.

- **A boolean can lie in either direction, and which one decides what the reply must carry**
  (0.97.0, `click`'s wheel and drag, `send_keys`). Both new screen mechanisms return a boolean from
  vanilla, and neither answers the question the caller has. `AbstractScrollArea.mouseScrolled`
  returns true whenever the widget is VISIBLE and clamps inside `setScrollAmount`, so `handled` is
  exactly as true at the bottom of a list as in the middle — a caller paging on it never stops.
  `Screen.keyPressed` is the mirror image: it returns **false** for Tab and the four arrows even
  when focus MOVED, because it builds a FocusNavigationEvent, changes focus, and then falls out of
  the switch to `return false` — so the one instrument reads nothing-happened for precisely the keys
  the tool exists to send. The rule the pair produces: **when the mechanism's own return value is
  not the observable, report the observable** — `scrolled_from`/`scrolled_to`/`at_end` off the
  scroll area's own amount, `focus_before`/`focus_after` off the screen's focus. The same audit
  found a third, already shipped and merely unstated: `ContainerEventHandler.mouseClicked` returns
  true whenever a CHILD WAS AT THE POINT, consumed or not, so `click`'s `clicked:true` was never
  quite "the event was consumed" — the pre-dispatch occlusion check is what makes it mean the right
  thing, and the description now says so rather than implying more.

- **An argument the tool does not have is a refusal** (0.46.0, `ArgCheck.java`, enforced at the
  bridge dispatch chokepoint). Silently dropping an unknown argument is this same class with an
  argument NAME as the vector: the call runs, answers a different question than the one asked, and
  the reply — computed honestly from the arguments that did apply — reads back as agreement.
  `locate` learned it expensively (thirteen live calls carrying a `center` that is not an argument;
  both models kept going all session because the echoed `center` looked like confirmation) and grew
  a hand-maintained refusal; 0.46.0 generalizes it to every builtin from the schema each tool
  already declares, so nothing new is maintained alongside the tools. It also names a **JSON-encoded
  string passed where an object belongs** (`{target: "{\"at\": …}"}`), which is a different mistake
  from a wrong key and needs saying. Deliberately NOT type/range/required checking: those verdicts
  belong to handlers, which own the semantics and phrase them better ("give `to` OR `reach`, not
  both"); this gate answers the one question no handler can, an unknown key having no handler to
  reach. Extension-contributed tools are exempt — their schema is their mod's contract, not ours.
- **A reflex that cannot run says so once, loudly** (0.46.0, `Reflexes.java`). A response whose
  precondition is absent (`eat` with no food) fails in the tick it fires, leaves its trigger true,
  and is re-picked next tick — forever. Every fire was honestly reported, which is exactly how the
  honesty drowned: at 20/s it became the noise burying the `body_damaged` rows that mattered (live,
  session w1-85918, through two deaths). Three identical consecutive failures now suspend the
  reaction behind an urgent `reaction_suspended` naming the reason and the fix, with a doubling
  re-arm window and `suspended` on `bot_reactions list`. That is the honest description of the state
  it was already in: a response that cannot execute is disarmed in every way that matters, and only
  the volume was hiding it.

- **A tool description is part of the contract, and it can lie on its own** (0.88.0,
  `drone/Containers.java`). `bot_container`'s description had promised `cook_progress` and
  `fuel_ticks` to every caller since the tool shipped; `furnaceState` emitted neither, and the class
  doc three screens above explained why it never would. Every reply was internally honest and the
  *surface* was false — a caller planning around a field that does not exist gets no error, just
  silence where a number should be. Note the failure mode this adds to the family: the other entries
  here are about a reply disagreeing with the world, and this is a reply disagreeing with its own
  advertisement, which no act-verdict check can see because nothing is verified against a
  description. The resolution was never "silence or invention" — it was **delete the promise or keep
  it** — and `lit` cannot answer the question the body actually has ("will this fuel outlast this
  smelt?"), so the promise was kept and made true through typed `@Accessor` mixins. The handoff note
  that caught the *entry* describing this tool wrongly went on to repeat the tool's own claim about
  itself, one level in, which is why "grep the code before believing a doc" has to mean the doc AND
  the docstring.
- **Two bodies disagreed about what "give me three" means, and one of them was lying** (0.88.0,
  `drone/BotBodyEntity.java`). `SimpleContainer.addItem` claims an empty slot with
  `setItem(slot, sourceStack.copyAndClear())` and only *then* clamps it, so a stack larger than the
  item's max-stack silently loses the excess and returns EMPTY — which the `Hands.insert` contract
  reads as "all of it fit". `bot_give {item: "minecraft:potion", count: 3}` on the drone answered
  `added: 3, overflow: 0` with **one** potion in the bag; the player body, whose `Inventory.add`
  splits by max-stack, got all three. Vanilla never hits it because nothing in the game hands a
  `SimpleContainer` an oversized stack. Fixed in `insert` rather than in `bot_give`, because the lie
  belonged to the method and every caller of it was exposed. Found by a probe that merely *depended*
  on the verb while testing something else — which is the argument for probes that stage through the
  real surface instead of through commands.
- **A body reported a speed of zero, forever, and four systems believed it** (0.88.0, `J1`,
  `drone/FakePlayerEntity.java`). `Entity.getKnownSpeed()` is a realized position delta, but
  `ServerPlayer` **overrides** it to return `lastKnownClientMovement`, written only when a real
  client's movement packet arrives. A connectionless body has no client, so it read `Vec3.ZERO`
  while walking at 4.2 b/s — and that zero is what `KineticWeapon.getMotion` (a spear could never
  pass its speed gate at any approach speed), `ProjectileUtil.getHitEntitiesAlong` (no reach
  extension in the direction of travel), `Projectile.shootFromRotation` (arrows inherited none of
  the shooter's motion) and `Player.isSweepAttack` (a grounded blow always swept) all consult. This
  is the **sensing** member of the family: nothing threw, nothing logged, no reply was wrong, and
  every probe passed — the body was simply answering a question about itself falsely, and four
  behaviours downstream were correct code acting on a false reading. The mirror publishes realized
  displacement from `computeSpeed()`, vanilla's own site inside `baseTick`. `bot_status` gained
  `speed_known`/`speed_delta` so the reading is checkable from outside, and
  `probes/known-movement.test.mjs` asserts it against displacement measured outside the game — a
  witness with a different code path and a different clock, because a probe that validates a reading
  against a second copy of its own formula is not a check.
- **Two heightmaps, opposite conventions, and the difference looked exactly like the finding the
  tool exists to report** (0.103.0, `WorldgenTools.worldFloor`). `preview_worldgen`'s `compare` puts
  the generator's `OCEAN_FLOOR_WG` beside the world's `OCEAN_FLOOR` and reports the delta, and the
  reply tells the caller to read *a large or one-directional shift* as "your generator has changed
  since these chunks were written". `ChunkGenerator.getBaseHeight` returns the first **free** y;
  `ChunkAccess.getHeight` returns `getFirstAvailable() - 1`, the topmost **solid** one. Subtracting
  them straight put a systematic −1 on every undisturbed column, so the instrument reported **every
  world as stale** — a false positive shaped precisely like a true one. This is the family's purest
  member so far: nothing threw, no field was absent, and the probe was **green 9/9** while asserting
  that the delta equalled its own operands, that the coverage counts added up, and that the refusals
  refused. What caught it was reading the numbers rather than the pass count, and the general lesson
  is narrow and reusable: when a reply *interprets* a number for the caller, the interpretation is
  part of the contract and needs an assertion of its own — here, "undisturbed terrain must agree with
  the generator", which no amount of internal-consistency checking implies.

Standing probe: `mcp-server/probes/act-honesty.test.mjs`.

## One log, three consumers (built — steps 2–3, 2026-07-19)

A single append-only, cursor-consumed event stream (`EventLog`, read via `get_events`), on the proven
`ChatLog` pattern: bounded ring (1000), monotonic ids, `missed` count for evicted events, `more` flag,
returned cursor always safe to continue from. Ids are in-memory and restart at 1 every JVM launch while
consumers persist cursors (the memory layer's `pending.json` outlives restarts by design), so a cursor
at or past `nextId` is flagged `cursor_reset` instead of polling "nothing new" forever — the one silent-
forever failure the stream had (2026-07-22 review; long-polls return the verdict immediately, and the
memory layer heals by re-scanning from 0). It serves:

1. **World events** (native): live — `weather_changed` (granular: vanilla ramps rain/thunder levels, so
   rain-began and thunder-began arrive separately), `time_of_day` (dawn|day|dusk|night), and
   `block_sighted` (0.43.0 — the watchlist, below). Entity spawn/death in tracked range is covered by
   the observer events below.
2. **Action feedback**: live on `bot_goto` — returns `{started, action_id}`, then `action_completed
   {arrived, outcome: arrived|already_there|stopped_short|did_not_start|stalled|nav_timeout,
   distance_to_target, traveled, path_partial?, arrival_from?, drift?, note?}` / `action_failed {reason: superseded|drone_replaced|drone_despawned|…}`.
   The enumerated `outcome` (0.4.3) is the action-side twin of `check_path`'s tri-state: a partial
   path near the target is disclosed, never sold as arrival, and every non-arrival names its remedy
   (`check_path` to diagnose / raise `within`). `within` is the caller's arrival radius (default
   2.5, max 16). Goto-before-mine/place should use the goal-shaped form instead: `reach {x,y,z}`
   lands anywhere the hand can touch the block and its completion carries `gates {range, los}`
   (0.5.0 — see reach goals above); plain `to` + `within:4` remains the distance-only fallback.
   Closed-loop execution without blocking a tool call; this is the channel drone hands (step 4) plug into.
   Instant operations (world edits) stay synchronous; asyncifying them would be pattern purity over sense.
3. **Audit records**: live — every `world_edit`/`privileged` call auto-emits at dispatch (tool, mechanism,
   size-compacted args, `ok`), **including failed attempts**. Audit and situational awareness can never
   disagree because they are the same stream. Undo ids join the record with step 5.

**The vocabulary is an artifact, not prose** (0.42.0). `EventTypes` holds every type with its group,
its one-line doc and its urgency; `get_events`' description is *rendered* from it and `EventLog.emit`
warns once about any type missing from it. This closes a capability bug, not a documentation one:
thirteen live types (every body event, both reflex events, `world_closed`, the engage/possession
pairs) were emitted and named nowhere the model could read, and `type` is an exact-match filter — a
type you cannot see is a type you cannot subscribe to. Cost is flat (26 types in ~1930 chars, against
13 in ~1900): the static prefix is re-read every turn, so the grouped rendering buys coverage without
buying tokens.

**And that cost argument is now priced, not estimated** (2026-08-17, `TOKEN_PER_TOOL_FINDINGS.md`
Finding 4). Adding `place_shapes` raised measured turn-1 input by **954 tokens** — ~11.9% of the whole
prefix for one tool, re-read every turn of every session *including the ones that never call it*. So a
description is a per-turn tax on the entire surface, and the rule for extending the toolkit is:
**price a new tool's prefix cost, not just its benefit.** A tool earns its schema only in the sessions
that call it and pays for it in all of them; the counting above ("cost is flat") is the right instinct
and there is now a number and a method (`run-shapebatch.mjs`) for checking it instead of eyeballing
character counts.

**Refined 2026-08-23 (Finding 5), because the rule above named the wrong half.** The 954 is measured
and stands; attributing it to the *description* did not survive decomposing the entry. The
description was 36.5% of it and the **schema was the larger half** — because `place_shapes.ops.items`
repeated, field for field, the descriptions `place_shape` carries three lines above it in the same
manifest. So the rule is sharper than "descriptions are expensive": **price the whole entry, and look
for the same words twice.** A description duplicated across sibling tools is paid twice per turn,
forever, and buys nothing the first copy did not. `Schemas.undescribe` removes the second copy, under
one guardrail — never strip a description nothing else in the manifest carries, or the saving is a
silent capability loss. Entries can be rebuilt and re-priced offline at zero cost (`Schemas` is
deterministic; 3.199 chars/token calibrates it), so this is checkable before shipping, not after.

**And the other tax, named 2026-09-05 (`LOOP_KIT_DESIGN.md` §5.4): price a tool by its ARITY.** A
session costs turns × the context each turn carries, and the turn count is set by whichever tool
acts on ONE unit per call — every call re-sends the whole conversation. ArmorPieces measured it
twice on two painters: a part went from 144 turns and $5.08 with 82 per-stroke calls to 42 turns and
$2.01 with 2 calls to a face-addressed batch painter; a skin from 148 turns to 38 through a `stamps`
list. This repo had measured it once already (`place_shapes`, 2026-08-17). So the manifest entry and
the arity are two taxes traded against each other, not one rule: a batch form costs a larger entry
on every turn of every session, and saves a hundred turns in the sessions that use it. Decide with
both numbers on the table (`tools/loop/analyse.mjs` prints the second one from any session log), and
never add a per-unit verb without asking what its list form would be.

**The stream can see the world, by subscription** (0.43.0, `drone/Watch.java`). Until here the whole
vocabulary was body-and-entity — what hurt you, what walked near you, what your commands did — and the
world itself produced two types. So a body could mine for an hour past a vein of diamond and never be
told. The ore *was* perceived (the ambient retina's fan hits it, `capture` indexes it); perception and
notification simply never met, and the only way to find out was to think to ask `locate` — the
pull-shaped failure `annotate` was built to fix for reads and nothing fixed for the stream.

`bot_watch` takes standing orders (`{id, block, within?, once?, urgent?}`, block id or `#tag`, capped
at 16 per session) and every ray hit is offered to them: `block_sighted {watch_id, watching, block,
pos, distance, sighted_by}`. Three properties carry the design:

- **Subscription, not a firehose.** A generic block-change stream would be strictly worse than the
  dropped-item spam it would replace, and `get_events` filters by exact `type` with no predicate over
  `data`, so it could not be narrowed client-side either. The narrowing has to be server-side and
  *agent-authored*. The mod never decides that diamond matters — it answers a question that was asked,
  which is why this is not the importance classifier that stays on the don't-build list.
- **Legal by construction.** Sightings come from ray hits and nowhere else, so ore behind stone is not
  sighted: the ray stopped at the stone. No scan, no chunk sweep — this adds no reach a body did not
  have, it wires an existing sense to the stream. Under `survival` the ambient retina fires that fan
  every 2s so the watch runs continuously; under other profiles it fires when something looks
  (`bot_scan`, a hand-called ray). The tool doc says so, because a watch that silently depended on an
  unrelated env var would be a listen filter that lies.
- **Urgency is declared by the watcher.** `block_sighted` is not urgent as a type — a priority covering
  opportunity as well as injury prioritizes nothing — but sighting lava three blocks into a tunnel is
  danger, and only the agent knows which of its watches mean that. So an entry may carry
  `urgent:true` and its events then ride the danger preview. This is why `EventTypes.isUrgent` gained a
  `(type, data)` overload and a closed `INSTANCE_URGENT` set, and why `EventLog` now decides urgency
  **once, at emit, and stores it**: an evicted event keeps only its identity, so re-deriving urgency
  later from a `data` that is gone would silently under-count `missed_urgent`.

**The reflex layer gained its first world trigger** (0.43.0): `block_near {block, within}` fires while a
matching block is inside the body's contact neighbourhood — default radius 3, hard cap 5. It is the tick
*before* `hazard {in_lava}`, whose own remedy text admits that reading it is already late; the cap is
what keeps it a proprioceptive sense ("what am I about to break into") rather than a prospecting scan
wearing a reflex's clothes. Prospecting has its own legal answer in the watchlist above. Both layers
parse specs through the same `BlockTools.Matcher`, for the reason `Hazards.CAUSES` taught: a sense that
can name things the fast layer has no word for is a sense that cannot be acted on.

**`inventory_full`** (0.43.0) — a success event carrying a loss. Mining with a full pack pops the drops
on the ground (they despawn in ~5 minutes) and a container take stops short, and both reported it only
as `collected:0` inside an `action_completed` nobody re-reads. Mining a vein you cannot carry and
walking away is a survival failure with no other witness, so it became subscribable.

**A page is read as a group, so it is encoded as one** (0.43.0). Measured on a live survival session:
40 events, 21.7 KB, of which 28% was pure repetition. `game_tick` was written twice per event (the
envelope, and again by `stampEnvelope` inside `data`); `dimension` was written on every row and is
near-constant across a page; per-event `time` was a 13-digit epoch nothing in the shim read. Both
stamped fields are now lifted out of `data` **once, at emit** — never on the read path, because the
log owns `data` and re-delivers it, so a read that edited it would corrupt the record for the next
reader — and `dimension`/`now` ride the result. A row carries its own `dimension` only when the page
genuinely spans several: a hoisted value that is wrong for some rows is worse than a repeated one.
Entity events drop a `name` that merely restates `type` (a vanilla mob's display name is its type
prettified) and round to one decimal, because a proximity notification is not a survey.

**The traversal trail was never the model's to read** (0.43.0). Nav verdicts carry `traversed` rows
so `captureProprioception` can index them — walking somewhere is how it counts as having looked at
it. The shim already intercepted every `get_events` row to capture them and then passed the event
through untouched, so 15% of a page was sensor data for the memory layer sitting in the agent's
context. It is the same category as the ambient retina, which is deliberately never served into
context; this one rode the nav verdict's payload by accident. Stripped after capture, replaced by
`traversed_cells` — a count, not a deletion, because "my walking is remembered" should stay a legible
fact.

**Danger cannot be buried by chatter** (0.42.0). A cursor read is oldest-first and pages at `limit`,
which is right for a cursor and wrong for a body: `body_endangered {air_low}` has a 15-second fuse and
could sit behind a page of routine rows for several polls. Page order is not negotiable — a cursor
that skips is a cursor that lies — so the page is unchanged and a compact **`urgent` preview** of the
danger events still queued behind it rides along (`EventTypes.isUrgent`: the events meaning the body
is losing, or has lost, integrity). It is **non-consuming**: the cursor does not advance past them and
they are delivered again, in order, later. The same knowledge feeds `missed_urgent` — how much of what
was evicted was danger.

**`missed` is counted through the caller's own filter** (0.42.0). It used to be the raw ring gap, so a
session filtering by `type` — or merely sharing the process with a busy copilot — was told it had
missed hundreds of events that were never its to see: a false alarm in the one field whose entire job
is honesty. An eviction ledger (4× the ring: id, type, `to` of departed events) makes the count exact
for the caller's own filter, and `missed_exact:false` admits when even the ledger has rolled past.

**Audit and `error` records are not delivered to player-legal sessions** (0.42.0 for `audit`; 0.91.0
added `error`, which rides the same rule for the same reason — a log ERROR is the server process
complaining, and a body that could read stderr would know a datapack was malformed without ever
having touched it. `get_log` is hidden from those profiles too, so the manifest half and the stream
half cannot drift into a tool that is served and answers nothing.) Closing the edge flagged in
SURVIVAL_MODE_PLAN §3). Audit is broadcast and carries the tool, coordinates and block ids of edits
*another* session made; a `survival` body perceived none of that, and its charter tells it to poll all
types. The shim declares its profile per call (`X-MCPTK-Profile` → `ToolContext.legal()`) and
`EventTools` excludes `audit` at the source — same enforcement seam as chat routing, same trust model
as session ids (the caller declares, the bridge stays localhost-trusted; which tools exist at all was
always shim-side). This exclusion is deliberately **silent**, the one place in this log where hiding
something is not disclosed per call: "3 events were withheld" would itself be the leak. A sense
boundary is not a truncation, so the disclosure lives in the contract (the tool description says legal
sessions get no audit, and asking for `type:"audit"` fails fast) rather than in the stream.

**Danger rides the acts** (mcp-server 0.16.0, SURVIVAL_SMALL_MODEL_PLAN.md P5). Every body loss to
date shared one mechanism: event polling is a *discipline*, and sessions lose disciplines — the first
watched run read its drowning warning post-mortem from inside a blocking goal; the haiku probe's body
was shot dead turns after its listen loop lapsed. Under the `survival` profile the shim peeks the log
after every successful non-poll call (read-only — cursors are client state, nothing is consumed) and
appends any unread `body_*`/`reaction_fired` events to the tool result as a compact `danger` field.
Each event is digested once; the agent's own `get_events` still delivers the full rows — the same
promise as the `urgent` header. An agent-side polling lapse can no longer blind the body; this is the
shim-side mirror of "memory rides the reads". The same release makes survival's *manifest* truthful
(`memory/survival-overrides.mjs`): the shim reroutes `locate` to the belief store, so it now also
serves the legal-locate description and schema instead of the bridge's X-ray prose — a description
that contradicts the behavior it fronts is worse than a terse one, because the description is what
the model reads at call time.

*Not* closed, and worth naming: **time of day leaks structurally**. A legal body underground still
knows dusk fell, because `get_world_info` returns `game_tick` and every embodied result carries one in
its envelope — `tick % 24000` is the clock. Filtering `time_of_day` events would be theater while that
holds; making it honest is a clock-legality slice (a sky-visibility gate on the envelope itself), not
an event filter.

Derived observer-relative events come from **one implicit observer — the active drone** (`DroneObserver`,
5-tick diff): `entity_entered_radius` / `entity_left_radius` (enter 24 / leave 26 hysteresis; "entered" =
became observable, including entities present at spawn) and `nearest_threat_changed` (identity change or
`cleared` — distance drift never re-fires). **Living entities only** since 0.42.0: a player body
auto-collects, so evented item drops meant two events per mined block — thirty blocks of mining was
sixty events of the agent's own footsteps, and oldest-first paging makes that noise precisely what a
`body_endangered` queues behind. Items stay perceivable through `sense_entities` and the inventory.
The removal was by entity *class*, not by cause, so it also silenced drops the body did not create (a
mob's death drop, an item someone threw). Accepted: the noise argument dominates while every drop the
body makes is auto-collected, and `sense_entities` still answers on demand.
The schema carries an `observer` field (general schema), but
the implementation is a singleton. **No watcher-session API** (`watch_start/stop` etc.) — that is
multi-agent machinery for a system with one agent; rejected until a second concurrent agent actually
exists. Drone state events: `drone_damaged`, `drone_removed {reason: despawned|replaced|died_or_unloaded}`.

**Body events** (0.36.0) — the player body's twin of those two, plus the environmental sense (see §the
danger sense above): `body_damaged {body, damage, health, maxHealth, cause, pos}` and
`body_died {body, name, pos, cause, hazards}` from the vitals watch, `body_endangered {cause, body,
pos, …}` / `body_safe {cause}` from `Hazards`. The onset/clear **pair** is chosen over per-tick fields
for exactly the reason the radius events are: a per-tick emit would flood the log and drown the signal
it exists to carry — and the pairing is what makes a `get_events {wait_ms}` long-poll wake the agent
ON DANGER instead of only on chat. `body_endangered` carries the cause-specific numbers that say how
bad rather than only that (`air_low`: `air`/`max_air`/`seconds_left`/`remedy`; `falling`:
`fall_distance`; `starving`: `food`). Two mechanism facts worth recording:

- **Death is detected on liveness, not removal.** Vanilla does not remove a dead `ServerPlayer` — it
  keeps the corpse for the respawn screen — so `!isAlive()` is the trigger and the corpse is **reaped
  at the event**. Without that, `bot_status` kept answering `spawned:true` at health 0 and the offline
  name stayed taken, which is what the drowned session misread as a lingering connection: an
  observable artefact of an unreaped corpse read as an external blocker.
- **`body_died` carries the hazards the body was suffering**, so "it drowned" is *in the record*
  rather than reconstructible from a health series. That required settling the tick order: `Hazards`
  runs first and **holds** the cause set for a dead-but-unreaped body, and the death handler owns the
  clear. Clearing it in `Hazards` emptied the field before it could be read — caught by the probe, and
  it is the same confabulation-enabling gap in miniature that the whole slice exists to close.

## Memory: agent-side, typed, not a world mirror

**Minecraft is the world model.** Blocks, entities (with stable UUIDs — identity is already solved by the
game), inventories, time, weather: all authoritative, always current, cheap to re-query. A mod-side scene
graph mirroring loaded chunks would be redundant state plus synchronization bugs. Rejected.

What deserves persistence is what is *expensive to rediscover* or *not in the world at all*: explored-region
knowledge, points of interest, project/task state, outcomes of attempts. That is **agent memory**, stored
agent-side as **typed, append-preferred JSONL** — not one free-prose file the LLM rewrites (failure modes:
silently dropped coordinates, stale-as-current, duplicate naming), and not SQLite (overkill at this scale):

```
places.jsonl     POIs: id, category, dimension, position, discovered/last-verified tick, source, notes
episodes.jsonl   summarized successes/failures of attempted tasks
tasks.json       current goal / working state
events.jsonl     archived observations worth keeping
skills/          (deferred) validated reusable procedures
```

The model reads *rendered summaries* of these stores, not raw dumps. Three memory kinds stay distinct:
episodic (above), semantic (game rules — largely covered by registry/recipe queries), procedural (skills —
parked). Records carry ticks and provenance (`source: {observer, perception_mode}`), because `remembered`
is the one perception mode that can silently go stale.

## Evaluation

Small, early, **machine-checkable** — a harness before architecture changes, so each addition gets an
ablation answer. Human-judgment metrics ("was the recommendation good?") are for occasional qualitative
passes, never the inner loop, or the benchmark dies of friction.

1. **Inspection** (runnable today): scripted world; "find a workshop site near the village and justify it";
   assert a valid site; log perception calls + tokens + wrong claims.
2. **Delegated physical** (hands built — now runnable): "clear these trees, collect the wood"; assert N
   logs collected (mined drops land in the drone's inventory), zero blocks changed outside the authorized
   region, count action failures/interventions from the `action_failed` events.
3. **Creative/editing** (transactional edits built — now runnable): "import structure, align to road,
   preview, place"; assert alignment tolerance, dry-run preceded placement, `undo_edit` restores the prior
   region bit-identically (state + block-entity NBT — verified).

Later, one autonomous sanity test (survive a night under a restricted profile) proves the bounded mode runs
honestly — without pretending it is the product.

## Roadmap (decided order)

1. **Contract layer** — **DONE 2026-07-19, live-verified 19/19 headless** (scenario-1 harness still
   pending): `mechanism` required on every `ToolDef` (no default — undeclared authority is a compile
   error), stamped into the manifest and inside every dispatch result at the `BridgeServer` chokepoint;
   observation envelope (`game_tick` via `Level.getGameTime()`, `perception_mode` — `spatial` for the
   radius reads, `visible` for raycast — `covered_radius` on get_blocks); entity enrichment (`velocity`
   blocks/tick + `speed`, per-entity `line_of_sight` clip test). Verified semantics: a walled-off entity
   stays in the spatial result with `line_of_sight:false` while raycast reports the wall.
2. **Unified event/audit log** — **DONE 2026-07-19, live-verified 22/22 headless**: `EventLog` (bounded
   ring, monotonic ids, cursor query with `missed`/`more` — no silent truncation), `get_events` tool;
   audit records emitted at dispatch for every `world_edit`/`privileged` call, successes AND failed
   attempts, with size-compacted args; `WorldEvents` tick-diff watcher (`weather_changed`, `time_of_day` —
   weather transitions are granular because vanilla ramps rain/thunder levels: rain-began and thunder-began
   arrive as separate events); action-feedback channel proven on `bot_goto` (`action_id` →
   `action_completed {arrived, distance}` / `action_failed {reason}` incl. superseded/replaced/despawned),
   plus `drone_damaged`/`drone_removed`. Also fixed en route: on a dedicated server the bridge now stops at
   SERVER_STOPPED, else the non-daemon HTTP thread pins the JVM after `/stop` (zombie process holding port
   + jar lock).
3. **Drone-derived events** — **DONE 2026-07-19, live-verified 14/14 headless**: `DroneObserver` diffs the
   entity population around the active drone every 5 ticks; `entity_entered_radius` /
   `entity_left_radius` (enter 24 / leave 26 hysteresis; living entities + items; "entered" = became
   observable, including entities present at drone spawn) and `nearest_threat_changed` (hostile identity
   changes or `cleared` — never per-tick distance spam). Singleton observer with an `observer` field in
   the schema, as decided. Removal resets silently — `drone_removed` tells the story, no leave-flush.
4. **Drone hands** — **DONE 2026-07-19, live-verified 37/37 headless**: the actuator contract
   (`drone/Actuator.java` — one commandable body, reach + 27-slot inventory, `require()` gate) plus
   `drone/DroneHands.java`: `bot_mine` (async, hardness-scaled dig → `action_completed{mined,drops}` with
   drops harvested into the inventory / `action_failed{reason}`; the dig is advanced by
   `DroneTools.tickWatch`), `bot_place` (deterministic default state or an explicit `state` string —
   orientation is caller-controlled, not fake-player-inferred), `bot_use` (item-on-block, best-effort with
   a null player → `use_unsupported` when an item needs a real one), `bot_attack` (`doHurtTarget`,
   reach-gated), `bot_inventory`/`bot_select`, and `bot_give` (privileged — materializes items, audited).
   Structured failures: `nothing_to_mine`/`unbreakable`/`out_of_reach`/`block_changed`/`busy`/
   `drone_removed`/`drone_replaced`/`drone_despawned`, `empty_hand`/`not_placeable`/`obstructed`,
   `no_target`. Every embodied mutation also drops an `action_completed` into the event log, so the
   embodiment trail is complete beside the world-edit audit. Auto-approach (path-then-dig) was
   deliberately deferred — mine requires the target already in reach (`bot_goto` first), keeping hands
   decoupled from navigation (the goal loop, `bot_target`, later took that job as an explicit layer
   above the verbs). **v2 in 0.35.0**: the verbs now run against the `Hands` contract instead of the
   drone entity, so the player body has hands too — with the engine's own dig timing, a real player in
   `UseOnContext`, and `bot_craft` — see §"Origin is a sensor seam" above.
5. **Transactional world edits** — **DONE 2026-07-19, live-verified 28/28 headless**: shared `EditJournal`
   (bounded 32-edit ring, per-op `undo_id`, snapshots prior state + block-entity NBT, restores via
   `BlockInput`), `dry_run` on `place_shape` and `set_blocks`, `game_tick`+`region`+`undo_id` envelope on
   every world-edit response, `undo_edit`/`list_edits` replacing single-slot `undo_shape`. Verified incl.
   NBT fidelity (undo over an overwritten chest restores its items) and out-of-order undo by id.
6. **Typed agent memory** — **DONE 2026-07-19 (phases A & B), live-verified**. Design authority:
   **MEMORY_DESIGN.md** (rev 2, externally reviewed). Agent-side in `mcp-server/memory/`: append-only
   traversal log + schema-validated compaction with tool-derived headers, per-subject verification,
   hybrid recall (structured + lexical + local embeddings), pending-candidate surface, session
   charter + SessionStart hook, task frame (`tasks.json` + `mem_task`). Mod side: `WorldIdentity`
   SavedData + `get_world_info` (the world key). Probe suite 20/20. Step 7 gameplay ablation RAN
   2026-07-19 (design **ABLATION_DESIGN.md**, verdict **ABLATION_RESULTS.md**): memory earns its
   keep and the compaction telescope is the load-bearing layer; the recall/embedding layer showed
   only parity (embeddings failed rule 4 honestly) — simplification candidates for the next
   memory-design rev. Step 8 companion mode: **shipped 2026-07-21** as human-launched persistent
   sessions — see **COMPANION_REDESIGN.md** and §Sessions below. The original rails-based draft
   (**archive/COMPANION_DESIGN.md**) and its overnight-soak prototype
   (`soak.mjs`, in the archive repository beside this one since 2026-09-06) are research archive.
7. **Skills** (parked until 1–6 prove out), then the **autonomous-player profile** when we want to evaluate
   autonomy seriously.

## Post-ablation queue — **PAUSED 2026-07-20 (Matthijs): play is a secondary objective**

> **Scope decision, and it settles an open question.** The world memory system exists for the
> **play/companion** copilot. It is *not* infrastructure for dev-agent work — Claude Code already
> handles dev session continuity and memory perfectly well. So the "should there be a project store
> alongside the world store?" question raised earlier today is **answered: no.** Don't build a
> project scope, don't file dev history in world memory. What remains of that finding is a narrower
> bug worth keeping (placeless entries can be nagged for compaction but can never satisfy it — see
> MEMORY_DESIGN.md §Memory scope), which matters only if placeless notes are written at all.
>
> Nothing below is abandoned; it is parked with its state recorded so it can resume cold. Items 1
> and 3 landed and are worth keeping regardless. Item 2 stopped for cause. Items 4–5 never started.

In execution order; each item names its gate. Full rationale: ABLATION_RESULTS.md +
archive/COMPANION_DESIGN.md (historical).

1. ~~**Tier-2 memory pressure**~~ — **DONE 2026-07-20.** L1→L2 `compaction_due`, budgeted/elidable
   block section in `mem_recent`, one shared nag formatter, probe 8 (budget, eligibility of the
   nomination, convergence). Verified against the soak corpus that produced the defect: block section
   860 → 212 tok at a 900 budget, nag now fires at both levels. Rules in MEMORY_DESIGN.md §The
   rendered context. Unblocks item 2.
2. **Recall re-measure under tier-2 pressure** — **STOPPED FOR CAUSE 2026-07-20, ~$6 of the approved
   spend used; do not simply restart it.** Two findings came out of the attempt, both keepers:
   - *Harness bug, fixed:* `stage.forceload()` issued rectangles over vanilla's 256-chunk
     per-command cap (368 for interrogation-multi) and the failure appears in the command **output**,
     which `bridge.cmd()` never checked — so every stage ran unticketed, the drone despawned on its
     first `bot_goto`, and agents burned whole episodes polling a dead drone. Now issued in
     ≤256-chunk strips and verified. Void cells: `ablation-results/item2-recall/VOID.md`.
   - *The scenario cannot answer the question.* Facts reach the debrief inside **block outcome
     lines**, and the render elides *oldest* blocks first while the agent's own blocks are always
     *newest* — so forking bulk history underneath them can never push them out. `in_render` was
     true for all 4 facts on a healthy run, and for 11/12 fact-slots in the step-7 baseline.
     Rule 3 is therefore **untested, not confirmed** (ABLATION_RESULTS.md updated).
   Restarting requires a redesign, not a rerun: bulk material with ticks *after* the planted facts,
   a debrief on detail outcome lines don't carry, or a different scenario. Gate: principal.
3. ~~**Embedding swap-then-decide**~~ — **DONE 2026-07-20: measured, decided, guarded.** bge-small
   (env-swappable via `MCPTK_EMBED_MODEL`) clears the 0.30 threshold and is nonetheless *worse than
   useless* — it scores unanswerable decoy queries as highly as real ones, and the best accuracy at
   **any** threshold equals the always-reject baseline. Rule 4 gained a decoy veto arm; both models
   now FAIL, MiniLM by matching nothing, bge by matching everything.
   **Matthijs's call: keep the channel inert until a better model exists** rather than delete it —
   a stronger model plausibly would separate. Shipped guard so that is safe: per-model thresholds,
   bge recorded known-bad, and **any uncalibrated model disables the channel instead of running it**
   (a bad embedder doesn't fail loudly, it silently matches everything). Adoption gate for any future
   model: the decoy arm. Detail: MEMORY_DESIGN.md §Rev-3 pending.
4. ~~**Step-8 slice 1**~~ — **SUPERSEDED 2026-07-21.** The autonomy-window/turn-countdown model
   and its rails were replaced wholesale by human-launched persistent sessions
   (COMPANION_REDESIGN.md); the rails were deliberately removed, not deferred. Only the
   spawn-at-task-frame-work-site idea remains unbuilt — revisit it against the redesign, not
   archive/COMPANION_DESIGN.md.
5. **Step-8 slice 2** — in-game chat I/O (`/copilot`, chat events, send-chat tool); first mod-side
   change of the phase. Gate: item 4 proven, principal present. **Landed 2026-07-20 in production
   form** (principal present and directing): `chat` events in the EventLog + `send_chat` with a
   hard 256-char reject — see §Sessions below for the 2026-07-21 routing redesign. The companion
   runs as a real Claude Code session (full tools + memory; headless `claude -p` since the
   redesign), NOT the experimental shim/SDK harness; `mcp-server/ablation/` and `companion/`
   remain research archive.

Parked: resume-build scenario fix (only for a full-grid rerun); memory-dir concurrency lock (needed
before workbench + companion run simultaneously); phase C (feeds on step-8 data).

## Two working modes (decided 2026-07-20)

The bridge is a bare localhost port, so mode is made explicit rather than inferred. **Identity over
enforcement** (the perception-mode philosophy applied to instances): `ping` reports
`env: development|production`, absolute `gameDir`, and a per-launch `instanceId` — sessions check it
before workspace-coupled workflows and notice restarts; nothing blocks cross-attachment.

- **Dev**: port 25599 (automatic in gradle runs). The Node server's `launch_game` local tool
  (dev checkouts only) brings the instance up via rebuild.ps1, which refuses to kill a production
  instance. Memory root: repo `mcp-server/memory-data/`.
- **Production (play)**: port 25600, bridge on by default (`config/mcptoolkit.properties` opt-out,
  `-Dmcptoolkit.port` overrides). The in-game **Claude** button bootstraps the game dir into a
  Claude workspace on first click — extracts a slim bundled Node server, writes the charter
  if-absent and the machine-generated configs *reconciled to the running port* — and offers the
  launch-type choice (§Sessions below). Memory root: `<gameDir>/mcptoolkit/memory-data`.

Operating detail: LIVE_MODDING.md §Two working modes.

## Sessions: workbench & companions (redesigned 2026-07-21)

> **HISTORY since 0.143.0.** Everything below describes sessions the GAME started, and the game
> starts none: the launcher, the kits, the companions and the menu they were driven from were
> archived after the release sitting (`RELEASE.md` section 3, `CHANGELOG.md` 0.143.0). What survives
> is the part that was never about launching — a session registers itself over `POST /hello`, is
> attributed on every call, and can be bound as the chat responder with `/mmcp chat responder`.
> `session_list` still answers who is here; `companion_spawn`, `companion_stop` and `session_send`
> are gone with the mechanism that gave them meaning.


Full spec + implementation record: **COMPANION_REDESIGN.md**. The inversion that organizes it: the
**human at the keyboard is the only launcher** — chat never spawns anything — so the old
containment rails (cooldown, `--max-turns`, hourly cap, one-at-a-time) lost their justification
and were removed. Sessions are persistent, not ephemeral. Two roles:

- **Interactive Workbench (IW)** — visible terminal, interactive `claude`, human-facing; the cheap
  control surface / orchestrator. Launched from the Claude menu (or `claude` in a dev workspace).
- **Companion** — headless (no console window), non-interactive `claude -p`, persistent; does the
  token-heavy in-world work. Launched from the Claude menu, or by any session via
  `companion_spawn` (the IW-as-orchestrator step); `companion_stop` / `session_list` manage them.

Substrate: a **session registry** (`Sessions`). Every launch registers (id, label, type, process);
the Node shim heartbeats `/heartbeat` every 30s so dead externals reap within minutes; orphaned
companions are reaped at mod init (persisted pid file — headless orphans must not survive a
crash). Each session gets **its own drone** (per-session `DroneTools` slot): `bot_spawn` replaces
only the caller's drone, drone events are targeted at the owning session, and the drone is
destroyed when its owner session ends.

**Chat routing** — chat is a routable input, not a spawn signal. The player picks the **responder**
in the Claude menu or via `/mmcp session responder <id|none>`; the mod delivers `chat` events only to
the bound session (pull model: `get_events` long-poll, `wait_ms` ≤60s), and a chat-only
`get_events` from a non-responder fails fast instead of silently starving. Unbound + unmuted =
legacy broadcast (all sessions hear).

**The routing table is read at the wrong moment** — twice, and fixed on both layers in 0.87.0.
*Binding* used to happen when a session was **minted**, before the terminal it launches has connected
to anything. A window opened and closed without ever connecting — or one still sitting on the
folder-trust prompt — therefore held the responder slot for the whole 10-minute never-seen grace and
ate the player's chat for all of it. Auto-bind now waits for that session's **first bridge call**: a
session that has never spoken has no claim on chat. *Delivery* used to snapshot the responder when a
long-poll started, so a rebind took effect only when the poll returned — up to a full minute in which
the log double-delivered (the old responder was still excluding nothing) or withheld (the new one was
still excluding chat) exactly the events the rebind was performed to redirect. `EventTools` now
re-derives its exclusions on every wake of the poll (`EventLog.queryWaiting` takes a supplier, not a
set), and every rebind calls `EventLog.wakePollers()` so a poller asleep on a quiet stream learns
about it now rather than whenever the next event happens to land. Sessions converse via `session_send {to, message}`
(privileged, audited; targeted `session_msg` events — `"chat,session_msg"` is the canonical
companion listen filter). Speaking: `send_chat` (256-char hard reject).

**A listen filter is a sense organ** (0.36.0, learned the expensive way). That canonical two-type
filter was written for a *conversational* companion and is wrong for an embodied one: the survival
charter told the session to poll `get_events {type:"chat,session_msg"}`, so every body event was
emitted and then filtered out before the model saw it — a body that could not feel anything, for
prompt reasons, while the mod side was working. It was the single highest-value fix of the drowning
round: the charter's loop now takes the default all-types subscription, names each body event
(`body_endangered`/`body_safe`, `body_damaged`/`body_died`, `reaction_fired`/`reaction_done`), arms an
`air_below`→`surface` reflex in its first actions, warns that water is not pathed, and forbids
narrating a cause not read from an event or a tool result. A narrow filter and a silent world are
indistinguishable from inside the session.

**Disable, both sides** — `"claude stop"` in chat kills all companions (process-level, not an
honor-system ask); `/mmcp chat mute` is the mod-enforced hard switch: chat events cease at the source
AND `send_chat` rejects, persisted across restarts (`/mmcp chat unmute` restores; the menu's "None
(muted)" responder maps to the same persisted marker). `/mmcp session` lists the registry.
Enforcement lives in `ChatTools`/`EventTools`, not agent goodwill.

## Extending: third-party tools and modded data (0.41.0, cross-loader since 0.83.0)

Another mod contributes tools by naming a class in
**`META-INF/services/com.mattmc.mcptoolkit.McpToolkitEntrypoint`** — it implements
`McpToolkitEntrypoint` and receives a `ToolRegistrar` bound to its own mod id, which stamps
`ToolDef.source` and surfaces in both the manifest and `ping.extensions`. That declaration means the
extension's class loads only when the toolkit asks for it: no `isModLoaded` guard, and a toolkit-less
game cannot crash on it. Extension registration is **contained** — a throw or a name collision costs
that mod its tool, is recorded, and never stops the bridge — where a builtin duplicate still throws,
because that is a development bug.

The file is `ServiceLoader`'s, but the lookup is not: discovery reads the text out of each loaded
mod's own contents and loads no class, so a mod built against another toolkit version costs only its
own tools instead of aborting the iteration, and the mod id comes from where the file was found
rather than from the modder. Fabric's `"mcptoolkit"` entrypoint (0.41.0–0.82.0) is still read for
mods that ship no service file; a mod declaring both is discovered once, through the file. See
`CROSS_LOADER_DESIGN.md` §13.

Modded *identity* was already recognized everywhere (live registries, tags, `MobCategory`,
behavior-derived affordances). Modded *behavior* the game doesn't expose is tag-driven:
`#mcptoolkit:contact_hazards` (read by both `Affordances` and the walker's node evaluator — one seam,
two consumers) and `#mcptoolkit:crafting_stations`. Both **add to a Java vanilla floor** rather than
defining it, because a mod's `data/` directory only loads as a datapack under fabric-api and the
toolkit is loader-only; classification must not silently regress on a pack that didn't load.

Authority: `EXTENSION_DESIGN.md` (decisions) and `EXTENDING.md` (modder-facing).

## The review layer: owed human tests, queued (0.77.0)

The agent→human direction, for judgement rather than for action. `human_task` (§15) asks a person to
*do* something and a referee decides whether they did; `review/` asks a person to *look* at something
and files what they say. Both were built for the same reason — a claim about the world that only a
human can settle — and the second one existed twice in consumer mods before it existed here.

**The queue is one shared file**, `<server dir>/review/asks.json` (+ an `answers.md` rendering), with
`source` carrying the per-mod attribution. Two ways in and neither is sufficient alone: **declared
subjects** (`Review.declare`, enumerated from a mod's own enums so the list cannot drift from the
code — re-declared each boot, `ReviewQueue.merge` keeps the answers) and **posted asks**
(`review_post`, `/mmcp review ask` — the question that exists only in the head of whoever just built the
thing and can never be enumerated). menagerie built the first; rocketeer built the second.

Four rules carry the design:

- **An ask with no failure mode is refused**, in the record's constructor. A step that cannot fail
  collects a nod instead of a judgement. The client card keeps `FAILS IF` on screen for the same
  reason — a reviewer who has forgotten what wrong looks like agrees with whatever is in front of
  them.
- **Staging is a list of server commands and nothing else.** This is what let the walk leave the
  mods: a command crosses the mod boundary and a Java staging callback cannot. A mod exposes one
  `stage` command; the toolkit owns the file, the walk, the cursor, the card and the verdicts. The
  consequence is stated rather than hidden: the queue file is as trusted as the console.
- **What staging PRINTS is kept** as the ask's `staged` note and rides the verdict. That is how
  menagerie's seed survives the crossing, and it is why the walk runs setup against a capturing
  `CommandSource` instead of `withSuppressedOutput()` — suppression is what would have thrown the
  provenance away. A rejection nobody can stand in front of again is a bug report that cannot be
  acted on.
- **A machine-answerable ask never reaches a human.** An ask may carry `check`, a command whose
  success closes it as `checked` — never `ok`, because "the world satisfies this" and "a person
  looked and was happy" are different facts and this layer exists to keep such things apart. Swept
  at server start, before anyone reads the queue. A `checked` verdict is **provisional** and re-opens
  when the world stops satisfying it; a human verdict is never re-evaluated. A *failing* check is
  silent by design: it cannot distinguish a broken feature from an unstaged world.

**A verdict gates nothing**, deliberately — a subjective judgement that could fail a build turns a
person's opinion into a merge conflict. The consumers are `review_status` (any later session, no
knowledge of where the file lives — replacing the standing "read the answers file first next
session" handoff note with a mechanism) and the `review_posted`/`review_answered` events, which is
what a session *still running* reads: post an ask, watch for the verdict, fix it, stage it again
while the person is still standing there.

One implementation fact worth carrying: **a command run from inside a command is queued, not
executed** (`Commands.executeCommandInContext` joins the open `ExecutionContext`), so staging and
checks fired from `/mmcp review …` run at `END_SERVER_TICK` instead. Done naively, both features fail
totally and silently — every staging note empty, every check reading "did not hold".

Authority: `EXTENDING.md` (modder-facing), `review/Review.java` (the front door's javadoc).

## Two worlds, and the toolkit boots in both (0.80.0)

The toolkit needs no fabric-api. That is a real property — its `hooks/` + `mixin/` layer replaces the
events and registries it used to borrow — but for two releases it was stated as though it were the
whole story, and the other half went unchecked: **the toolkit must also not care when fabric-api IS
there.** Every consumer mod brings it.

The trap is that fabric-api does not merely *add* things. `fabric-registry-sync`'s `BootstrapMixin`
`@Redirect`s `Bootstrap.bootStrap()`'s call to `BuiltInRegistries.bootStrap()` down to
`createContents()` alone, and calls `bootStrap()` itself later (`MainMixin` on the server, client
`MinecraftMixin`) — **it moves the registry freeze to after mod init.** So the toolkit's
`BuiltInRegistriesMixin` was not overwritten, not out-prioritised, and not in conflict: it applied
cleanly to a method that, during bootstrap, was never called. The entrypoint then asserted the types
were registered, threw on its first line, and took every later `register()` with it —
`Review.register()` included. The mod that hit it looked like the broken one.

The rule that fell out: **do not assume WHEN the freeze happens; try both windows.**

| | Registers the types | Registry at `onInitialize` |
|---|---|---|
| No fabric-api | `BuiltInRegistriesMixin`, at vanilla's `freeze()` call | frozen — types already there |
| fabric-api present | `DroneEntities.bootstrap()`, from the entrypoint | still OPEN — the door fabric mods use |

`registerTypes()` is idempotent, so the mixin's later visit under fabric-api is a no-op, and
`bootstrap()` throws only if *neither* window was open — a diagnostic, not an assertion about which
world this is. Attributes moved the same way: `ToolkitAttributes` takes a `Supplier` and builds on
first use, because `new AttributeInstance` reads `attribute.value()` and those holders bind at
`freeze()` — an eager build in an entrypoint is correct in one world and fatal in the other.

**The arbiter is in this repo now**: `gradlew runServer|runClient -Pfabricapi=true` boots the
toolkit's own dev game with fabric-api loaded (`localRuntime` only — it must never reach the compile
classpath). This bug was invisible here for exactly as long as no run in this repo looked like the
runs its consumers make.

## Don't-build list (with reasons — as binding as the build list)

| Rejected | Reason |
|----------|--------|
| Per-mod tool hiding (`MCPTK_HIDE_MODS`) / per-mod profiles | No consumer. `ToolDef.source` (0.41.0) makes it a one-line filter the day one exists; building it first is a config surface nobody asked for. |
| A physical `mcp-toolkit-api` Gradle module | Real build complexity while every consumer is in-workspace. The API is doc-declared instead (`EXTENDING.md`): eight classes, additive changes bump minor. Revisit at the repo split. |
| Declarative JSON tool definitions (schema without a handler) | A tool *is* its handler; schema-only registration produces manifest entries that cannot act — a confident lie at the protocol level. |
| Tool unregistration / hot re-registration | The registry is init-time by design (single-threaded, then read-only). Dev iteration already has `hotswap_class`. |
| Enforcing the modid name prefix | Would break Village Jobs' six grandfathered names for no live benefit; convention + collision reporting covers it. |
| `visible`-mode enforcement (FOV/occlusion/darkness) | No product need; naive realism is sub-human, not human-equivalent; label instead. Revisit only for the autonomous profile. |
| Mod-side scene graph / world mirror | Minecraft is the world model; a mirror is redundant state + sync bugs. **Not this: `locate`'s session ledger** (0.8.0) — a scene graph mirrors *the world*, the ledger holds only the referents *one session named*, stores handles rather than block state, re-reads the world on every use (volatile anchors re-resolve through their entity UUID — storing a mobile thing's position is exactly the bug), is bounded, and dies with the session or the world. It is a symbol table for deixis — what makes "the tree", "that tower", "north-west of it" resolvable — not a copy of anything. If it ever starts caching block state or outliving its conversation, it has become the rejected thing. |
| Confidence scores on observations | Ground-truth sensing has no detection noise. Staleness → timestamps; inference → planner. |
| Watcher-session API | Multi-agent machinery for a singleton; general schema + singleton implementation instead. |
| SQLite memory store | Typed JSONL suffices at this scale. |
| Hologram/ghost previews | Dry-run diff reports suffice; a ghost renderer is a feature, not a contract need. |
| `collaborator` session role | Derivable from principal in every foreseeable configuration. |
| Speculative permission taxonomy | Constraints are added when a scenario needs one; unused permission models rot. |
| Call-level permission duplication | The Claude Code harness owns call-level consent; mod adds argument-level + audit only. |
| Mod-side admin tools | Vanilla `net.minecraft.server.jsonrpc` covers dedicated-server admin; `run_command` covers dev ops. |
| Networked client patching (server → client `push_asset`/`hotswap_class` broadcast; any cross-JVM code/asset channel) | A server op broadcasting a hotswap or asset to players' JVMs is **remote code execution on clients** — it breaks the trust boundary Minecraft deliberately keeps (a server changes its world, never runs code on your machine). `push_asset`/`hotswap_class` stay strictly local-JVM. In multiplayer the toolkit is a **server-side operator tool**: it acts on the authoritative world, clients receive only vanilla-synced state and need no toolkit. Decided 2026-07-19. |
| Opaque/numeric block palettes (token-saving) | Semantic `id[state]` labels are load-bearing for model spatial reasoning (label-permutation evidence, RESEARCH_WORLD_REPRESENTATION.md). Corollary: no serialization-format switch without a local Category-B bench measurement first. |
| Dense set-of-marks on renders | If an annotated render ever ships: few *sparse* server-truth marks, IDs mapping to real entity/block refs, the VLM proposes over mark IDs and the symbolic layer grounds/executes, and marks must be visually distinct from world content (signs, item counts). Dense overlays occlude the scene and invite ungrounded references. |

## Known gaps (acknowledged, not hidden)

- **Spatial reads are X-ray vision** — now labeled honestly end to end (tool descriptions, envelope
  `perception_mode`, per-entity `line_of_sight`); enforcement deliberately deferred.
- **No drone-POV pixels**: `screenshot` captures the client framebuffer only; the embodiment seam covers
  symbolic tools. Optional off-screen drone render is a possible future sensor backend — only if a
  benchmark task shows symbolic perception failing (GUIs and texture-dependent tasks are where pixels
  actually earn their cost).
- **The drone unloads with its chunk**: it holds no chunk-loading ticket, so on a server with no nearby
  player (headless, or the drone flown far past the player's view distance) its chunk unloads and the drone
  is removed (`drone_removed: died_or_unloaded`). Fine for copilot-with-player (the player keeps nearby
  chunks loaded); a remote-scouting or autonomous profile would need the drone to hold its own ticket.
  Headless verification must `forceload` the work area.
- ~~**`bot_use` needs no fake player, so it is partial**~~ — closed for the player body in 0.35.0: the
  `Hands` contract hands `UseOnContext` a real `ServerPlayer` when the active body is one, so the
  behaviours that need a player work instead of returning `use_unsupported`. The gap **remains for the
  drone and walker**, which still pass a null player and still refuse honestly — the fix was a new body
  kind, not a loosened contract.
- ~~`run_command` / world edits act with undeclared authority~~ — closed by roadmap step 1 (2026-07-19):
  every tool now declares and stamps its mechanism. Audit *events* still wait for the log (step 2).
- ~~The planner is still the only memory~~ — closed by step 6 (2026-07-19): durable per-world agent
  memory (`mcp-server/memory/`, design in MEMORY_DESIGN.md) with traversal log, schema-validated
  compaction, per-subject verification, hybrid recall, pending-candidate surface, session charter.

## Provenance

Decisions emerged from a three-round design review (2026-07-19) of the perception stack. Notable
corrections adopted along the way: the original "embodiment seam" claim was an overstatement propagated
from code comments into analysis (now corrected everywhere); "capability constraints are research concerns"
was wrong — for a copilot they are *authorization* concerns and more urgent, not less; free-text agent
memory was under-specified — typed records with rendered views won; "SOTA memory is text" was 2023-vintage
(later systems use structured agent-side memory — which still supports agent-side, not mod-side, placement).
External literature referenced during the review (Voyager, GITM, JARVIS-1, Optimus-1; also
"MineNPC-Task" / "Talking-to-Build", the latter two unverified) informed but does not carry any decision:
each stands on its stated reasoning.

The 2026-07-22 world-representation research (RESEARCH_WORLD_REPRESENTATION.md) is external evidence
for several don't-build entries — the world-mirror, confidence-scores and query-on-demand decisions,
plus the opaque-palette and set-of-marks rows — with per-claim source ratings in that report.

The 2026-07-23 agent-platform survey (RESEARCH_WORLD_REPRESENTATION.md round three:
minecraft-dev-mcp, MineDojo, TeamCraft, mineflayer/Voyager/Mindcraft) adds external corroboration
from running systems: TeamCraft's own symbolic-text ablation beating its vision models (and GPT-4o
failing 3D grounding from renders) backs the symbolic ladder; the MineDojo team's migration to
code-as-actions on a live server backs the architecture class; Mindcraft's independent
mutate-vs-query split backs the mechanism taxonomy; TeamCraft's centralized-vs-decentralized gap
(1% vs 15–24% redundant actions) is direct input for the companion redesign. Explorative options
from the survey (goal-shaped navigation, enumerated action-failure reasons, affordance-carrying
observations, action masks, composite automation verbs) are documented there — each gated on a
testbench motivation, none adopted on survey enthusiasm alone.
