# check_path legality audit — the ask-shaped tool with do-powered answers

Status: **audit complete 2026-08-07; R1 AND R2 APPLIED + LIVE-GREEN 2026-08-08** (toolkit 0.59.0).
R1: survival refuses `load:true` and forces the default load path OFF (refusing only the literal
while the default silently paged would be a refusal in name only). R2: the survival solve is
KNOWLEDGE-MASKED — `WmSeen` per-session seen-set fed at the Sightlines tap (fan/ray/gait walks
incl. air + body traversal; the tap's second consumer, as scheduled), `NavSolver.solveMasked`
reads unseen cells as bedrock (blocking, unbreakable) cache-less, verdicts tri-state over
knowledge with `knowledge_frontier` as the go-look pointer, obstruction disclosure obeys the
mask, provenance `held_knowledge`. Residual, documented: reach-mode touch shells compute on the
real level once the target block is seen (closes with the §16.3 v2 belief answerer). Probe:
`mcp-server/probes/check-path-r1.test.mjs` (R1+R2, hermetic per run via /hello session). R3 owed
at the next watched survival run; F7 (refusal-borne oracle bits) still open by design. Trigger:
`world-model/DESIGN.md`
§16.1's ask/do analysis flagged `check_path` as "ask-shaped but do-powered." This audit
confirms the flag against the code, inventories the disclosure, and proposes remediation.
Authority for the survival profile: `SURVIVAL_MODE_PLAN.md`; for the tool surface shape:
`world-model/DESIGN.md` §16.

The prior decision is on record and was *not* an oversight: SURVIVAL_MODE_PLAN.md §2
("Legal `check_path`") knowingly kept the tool, arguing the body has walked enough terrain
that prediction-over-truth is mostly indistinguishable, and that hiding it forces blind
trial navigation. It set an explicit revisit condition: **"Revisit when the observation
store can back the solver."** That condition is now arguably met (F6), which is why this
audit exists.

## Findings

**F1 — Exposure confirmed.** `index.mjs` survival hide-set = DEV_ONLY + CLIENT_SURFACE +
OPERATOR + XRAY_READS + `raycast_fan` + `raycast` + `bot_point` (index.mjs:146-147).
`check_path` is in none of them; `profiles.test.mjs:170` pins it as MUST_SURVIVE in every
profile. The index.mjs:98 comment carries the waiver ("flagged legality edge").

**F2 — The solve is fully privileged.** `PredicateTools.checkPath`
(PredicateTools.java:496-756) runs `NavSolver.solve` over the real `ServerLevel` with a
`SyntheticPhysique` walker — ground-truth blocks, no provenance filter, escalating budget to
a 512-block ceiling. Every cell the A\* expands is world truth the body may never have seen.

**F3 — Disclosure inventory** (what one response can reveal about never-seen terrain):

| field | leak |
|---|---|
| `reachable: true/false/null` | the oracle bit: topology of unseen world; unlimited calls make it binary-searchable ("is the cave connected to the surface?") |
| `stand {x,y,z}` (reach mode) | a specific occupiable cell — implies air at feet+head and footing below, at a position never sighted |
| `obstruction {x,y,z,block}` | **a literal one-cell X-ray**: `NavSolver.obstruction` reads `level.getBlockState` at the blocking cell and names the block id (PredicateTools.java:710-713) |
| `reach {candidates,visible,…}` + `reason:"occluded"` | entombment verdict — "it is enclosed" — for a block no ray ever walked (PredicateTools.java:583-599) |
| `work {break_cells, place_cells, jumps, doors}` | the chosen route's structure through unseen terrain (PredicateTools.java:721-747) |
| `nodes`, `end {x,y,z}` | path length + where the search stopped |

**F4 — `load:true` is an operator power reachable from the legal profile.** The
`ChunkLoader` honors `loadArg(a)` (PredicateTools.java:515): a survival session can force
remote chunk load/generation. A player cannot load chunks they haven't approached. This is
illegal *regardless* of the disclosure question.

**F5 — No store laundering (good).** `capture.mjs` `UNCAPTURED_WORLD_READS` deliberately
excludes `check_path` ("verdict, not an observation of cells", capture.mjs:265), so nothing
enters `legalCells()`. The leak is context-only — the LLM reads it, the store stays clean.
(Authored `mem_note`s can still quote it — the §12.2 authored-record caveat, unchanged.)

**F6 — Doctrine inconsistency, and the waiver's revisit condition is met.** `locate` answers
the same question class ("what's out there") from provenance-filtered observations;
`check_path` answers from world truth. Since the waiver was written, the pieces for a
knowledge-backed solve have appeared: `store.legalCells()` exists and is audited,
`legal-pattern.mjs` already plans over seen cells, and `world-model/DESIGN.md` §3 is about
to build a mod-side per-body seen-set at the exact Sightlines seam a legal solver needs.

**F7 — Second-order edge, named but deferred.** Act *refusals* also carry solver verdicts:
a `bot_goto` that answers `walk_refused`/unreachable without moving leaked the same oracle
bit (one solve's worth, bounded — the body was about to attempt that exact route).
Full closure requires refusals derived from held knowledge; tracked as a known edge, in
scope for the world-model project's belief-backed executor, not for this fix.

## Remediation

**R1 — immediate (one-liners, do now):**
- Refuse `load:true` under `MCPTK_PROFILE=survival` (fixes F4 outright).
- Stamp survival `check_path` responses `provenance:"privileged_solver"` with one honest
  note line. Doesn't close the leak; makes it visible to the agent and to transcripts —
  the succeeds-falsely doctrine applied to legality.

**R2 — the right fix (pairs with world-model Phase 0):** a **knowledge-masked solve**.
Mod-side per-body seen-cell set fed at the Sightlines tap (the same seam the wm recorder
builds — one tap, two consumers), and a `NavSolver` mask view where unseen cells are
UNKNOWN — distinct from blocked. Verdict becomes honestly tri-state over knowledge:
- `reachable:true` — a route exists entirely through known cells;
- `reachable:false` — blocked within known terrain;
- `reachable:null` + `knowledge_frontier {x,y,z}` — "your knowledge ends here; go look."
This is exactly `ask path_to` from DESIGN.md §16.3, and the frontier answer converts the
old blind-navigation objection into a feature: the tool now *tells the agent where to
explore* instead of either lying or going dark.

**R3 — measure the waiver's own claim:** A/B the next watched survival run with
`check_path` hidden vs privileged-flagged, counting turns lost to blind navigation. The
original waiver predicted indistinguishability; it was never measured, and `bot_goto`
running as a self-repairing move goal (W1_42257 F3) has since reduced the tool's necessity.

Recommended order: R1 with the next server touch (both lines are trivial); R2 scheduled
with world-model Phase 0 (shared seam makes it cheapest then); R3 opportunistically at the
next survival session. F7 stays a named edge until the belief-backed executor exists.
