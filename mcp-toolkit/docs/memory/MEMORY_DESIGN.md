# Agent Memory — Design (roadmap step 6, phases A & B)

Status: IMPLEMENTED (phases A & B, build-order steps 1–6) — 2026-07-19, same day as revision 2 of the
design. Steps 7 (ablation) and 8 (companion mode) remain. Implementation: `mcp-server/memory/`
(store, tools, embeddings, probe suite — 18/18 green); mod side: `WorldIdentity` + `get_world_info`.
Extends ARCHITECTURE.md §"Memory: agent-side, typed, not a world mirror"; every decision there
(agent-side placement, typed JSONL, rendered views, no SQLite, no world mirror) carries over
unchanged.

Revision 2 corrections (see §Provenance for the full accounting):

1. **Reachable ≠ retrievable.** Block-only embeddings let demoted facts become undiscoverable.
   Retrieval is now hybrid: structured + lexical over all records, semantic over blocks.
2. **A multi-fact episode cannot carry one truthful freshness timestamp.** Verification now attaches to
   the smallest stable subject (POI / entry), never to a whole block.
3. **A file is not append-only if records inside it are mutated.** All records are now immutable;
   relationships (compaction, verification) are appended as relation records; current state is a
   derived in-memory index rebuilt at startup.
4. **The tool, not the LLM, computes machine-derivable fields** of a compacted block.
5. Memory formation gets a **pending-candidate surface** (rule-based, no classifier) so charter
   compliance is assisted, not assumed.

Phase A = the traversal log + schema-preserving compaction + linked store (harness-side, frontier model
driving). Phase B = retrieval. A learned/custom model is explicitly **phase C, out of scope** — a
distillation of this system once the data flywheel exists, not a prerequisite for it.

## Governing principles

1. **Language forms memory.** The agent remembers what it *describes*, explicitly, with location and
   time. Pixels and spatial reads contribute to perception; only described facts persist. (To remember
   what something looks like, describe its schematics to memory.)
2. **Facts compress by omission-with-a-link, never by paraphrase — and demotion must not cost
   discoverability.** Compaction generalizes prose and coarsens spatial grain, but structured fields
   survive verbatim and *exact-match retrieval reaches demoted records directly* (lexical + structured
   channels below). Nothing is lost; it is demoted — and still findable.
3. **`remembered` is the perception mode that goes stale.** Freshness attaches per subject (POI,
   entry), rendered as explicit age; old memory is a hypothesis to re-verify cheaply via the perception
   ladder, never ground truth.
4. **Rank by relevance, render in time order.** Retrieval scores by exact/spatial/semantic relevance,
   but the returned pack is chronological, clustered by episode.
5. **Pull, not push.** The copilot calls recall explicitly. Ambient auto-injection is a later, measured
   pilot — never the default.
6. **Records are immutable; state is derived.** Memory files are strictly append-only. Anything that
   "changes" (compaction membership, verification status) is a new relation record; readers rebuild the
   derived index at startup (trivial at this scale) and get a complete audit history for free.

## World identity

Memory is keyed by a **persistent `world_uuid`**, generated once and stored in the world save
(mod-side `SavedData`) — world name and seed hash are display/diagnostic metadata only (copies,
renames, and same-seed servers make them non-identifying). Exposed by a new mod tool:

```
get_world_info → {world_uuid, name, seed_hash, game_tick, dimensions}
```

This is the only mod-side change phases A/B need (checked 2026-07-19: the mod stamps `game_tick` but
exposes world identity nowhere).

**Rollback detection (replaces speculative `save_generation` bookkeeping):** memory metadata tracks the
maximum tick ever observed per world. If the world's current tick is *below* it, a backup restore or
rollback happened — renders carry a warning ("world appears rolled back past tick N; memory after that
tick describes events that no longer happened"). Cheap, legible, no extra save-side state.

## Storage: per-world, agent-side, typed JSONL, strictly append-only

```
memory/<world_uuid>/
  meta.json        world metadata, schema info, max-seen tick, event-log cursor
  log.jsonl        L0: raw agent-authored entries — immutable, append-only
  blocks.jsonl     L1+: compacted blocks — immutable, append-only
  places.jsonl     POIs (schema per ARCHITECTURE.md plan)
  relations.jsonl  compaction membership, verification, acknowledgments — append-only
  pending.json     derived queue state (rebuildable; NOT memory — see pending surface)
  index/           phase B: embedding vectors, per-model
  tasks.json       current goal / working state — mutable {v, current} via mem_task; rendered as the
                   [task] line; never a record file (outcomes go to log/blocks on close)
```

Every record carries `"v": 1` (schema version) so old worlds stay loadable across field changes.

Durability hardening (2026-07-23, probes in `memory/probes/robustness.test.mjs`): the mutable JSON
files (meta/tasks/pending, plus the shim-level `last_world.json`) are written tmp+rename, so a crash
mid-write leaves the old version instead of torn JSON that bricked every later `mem_*` call. The
advisory lock refreshes its mtime every 10s while held (a long first embedding pass no longer reads
as a crashed holder) and announces a failed release instead of silently orphaning the lock.
`embeddings.jsonl` appends moved inside the lock (concurrent sessions used to interleave rows), its
reader skips a torn tail line, and the whole semantic channel — including runtime inference failure,
which now latches like a load failure — degrades recall to lexical/structured rather than erroring.

### L0 entry (the traversal log)

Written by the agent as it works — explicit narration of traversal, observation, action, outcome:

```json
{"v":1, "id":"e-000123", "session":"s-20260719a", "t":"2026-07-19T14:03:22Z", "tick":81234,
 "kind":"obs|act|outcome|note",
 "dim":"overworld", "pos":[-120,64,300], "chunk":[-8,18], "region":"r.-1.0",
 "text":"Village well at (-120,64,300); four farms east of it; iron golem present.",
 "refs":{"events":[411,412], "places":["p-oak-village"], "undo":"u-17"}}
```

- `tick` + wall clock both: ticks join to the event log and observation envelopes; wall clock orders
  across sessions. `chunk`/`region` derived from `pos` at write time (region = 32×32 chunks, `r.x.z`,
  mirroring Minecraft's region files) — the spatial index comes free.
- `refs.events` links event-log ids. The event log is **provenance, not memory**: description is the
  memory-forming act; event ids make it auditable against mechanical history.
- No mutable fields. Compaction membership lives in `relations.jsonl`.

### L1+ block (compacted history)

```json
{"v":1, "id":"b-000007", "level":1,
 "tick_range":[80100,86400], "time_range":["2026-07-19T13:40Z","2026-07-19T15:10Z"],
 "dim":"overworld", "regions":["r.-1.0"], "bounds":[[-160,60,240],[-80,80,340]],
 "activity":"exploration", "pois":["p-oak-village","p-ravine-west"],
 "tallies":{"mined":64,"placed":0,"derived_from":"linked audit events"},
 "outcome":"Mapped oak village and west ravine; no base site chosen yet.",
 "prose":"Explored the river valley west of spawn… (general; specifics live in fields and children)",
 "links":{"entries":["e-000100","…","e-000180"], "blocks":[]},
 "created_tick":86400, "last_activity_tick":86400}
```

- `level` 1 = episode-scale (one activity, one/few regions, hours); level 2 = day/multi-region scale,
  linking child L1 blocks. Spatial grain and description grain coarsen together.
- `last_activity_tick` = max tick of linked records at creation. There is **no block-level
  `last_verified`** — freshness is per-subject (below). Blocks never mutate.
- `tallies` are computed by the tool from *linked audit events only*, and labeled so — they claim
  coverage of what was linked, not of everything that happened.

### Relation records (`relations.jsonl`)

```json
{"v":1,"kind":"compaction","block":"b-000007","entries":["e-000100","…","e-000180"],"t":"…","tick":86400}
{"v":1,"kind":"verification","target_type":"place|entry","target_id":"p-oak-village",
 "result":"confirmed|contradicted","tick":94000,"session":"s-…","note":"golem gone, village intact"}
{"v":1,"kind":"ack","event_id":412,"entry":"e-000201"}
```

- A block is **frontier** iff no compaction record lists it as a child — this drives retrieval scope.
- Verification targets the smallest stable subject: a POI or a specific entry. Contradiction does not
  rewrite history: the old record stands as what-was-believed; the verification record dates the change.
  A rendered episode can honestly say: *"episode recorded day 1; village reverified 1h ago; chest
  contents not verified since the episode."*

## The rendered context (telescope render)

`mem_recent {budget_tokens?}` produces the working-memory view — detailed near now, coarse far back:

```
## Memory @ tick 91500 (world: oak-valley)
[b-3  L2] days 1–4: base established at (-140,65,310), village allied…      (mem_read b-3)
[b-7  L1] ~2h ago, r.-1.0: cleared forest NE of base, 64 oak collected…    (mem_read b-7)
[task] Current: build workshop at ravine-west site.
[pending] 2 high-importance events not yet in memory: death @ tick 90800; chest placed (-138,65,308)
--- recent entries (verbatim) ---
e-181  tick 90100  (-120,64,300)  obs: village well, four farms east…
```

Both layers are budgeted, and each nags at its own level (rev 3, 2026-07-20):

- **Tail (L0 → L1).** Over `budget/2`, `compaction_due.entries` nominates oldest-first until the tail
  would fit `budget/4`.
- **Frontier blocks (L1 → L2).** The coarse layer gets `budget/4`. Over it, `compaction_due.blocks`
  nominates oldest-first within a single dimension at the most granular frontier level — the
  constraints `mem_write_block` actually enforces, so a nag is always a followable instruction — and
  never fewer than two children, which would compress nothing. The overflow is elided from the render
  oldest-first (those are exactly the blocks being nominated) behind an explicit `[… N older frontier
  block(s) elided …]` line naming the tick span and ids; at least one block always renders. Elision is
  the safety valve between overflow and the agent acting; compaction is what actually restores the
  deep past to the render, one level coarser.

Both triggers are tool-visible, not a background daemon. Either can fire alone, so the nag names the
level it is asking for. Note what is *not* capped: the verbatim tail still renders in full — it is
nagged, never truncated, because truncating it would break the one surface the ablation found
load-bearing. A render can therefore exceed its budget until the agent compacts; that is the designed
pressure, not a leak.

## Compaction procedure

Compaction splits cleanly: **the LLM interprets; the tool computes.**

The model supplies only what requires interpretation:

```json
{"links":{"entries":["e-000100","…","e-000180"]},
 "activity":"exploration",
 "outcome":"Mapped the village; rejected the ravine as a base site.",
 "prose":"Explored the river valley west of spawn…",
 "pois":["p-oak-village","p-ravine-west"]}
```

`mem_write_block` derives the rest — id, level, tick/time ranges, dim, regions, bounds, tallies (from
linked audit events), session set — and validates **eligibility**, not reproduction:

- linked records exist, are frontier (not already compacted), and form a sane span;
- **coherence checks** (reject or warn): multiple dimensions; distant disconnected regions; span so
  large it should be partitioned; `pois` not present in `places.jsonl` (promote via `mem_place` first);
- required interpretive fields present — a block without `outcome` is rejected, not accepted-with-gaps.

On success the tool appends the block and one `compaction` relation. Same procedure L1→L2 with
`links.blocks`. This eliminates the copy-the-data-correctly retry loop and reserves validation for what
can actually go wrong: incoherent groupings and dangling references.

## Pending-memory surface (assisted narration, not automation)

Charter compliance alone is a silent failure mode: the model forgets to note a discovery, or presses on
past `compaction_due`. The pending surface assists without taking over authorship:

- The Node server consumes the event log via its stored cursor — **lazily, on each `mem_*` call**; no
  background poller (the MCP process is passive between calls; matches the no-daemon rule).
  Two cursor rules keep that surface honest across restarts and sessions (2026-07-22 review, probes in
  `memory/probes/cursor-reset.test.mjs`): the mod's event ids restart at 1 every game launch, so when
  `get_events` flags `cursor_reset`, `resetEventCursor` takes the one sanctioned backwards move and the
  scan resumes from 0 (otherwise the persisted cursor points at a future id forever and the surface dies
  silently); and `updatePending` drops incoming candidates at or below the cursor already on disk — the
  cursor is the queue's tombstone, so a slower concurrent session can never resurrect a candidate another
  session classified and the agent dismissed.
- A **hardcoded rule list** flags candidates: death; `action_completed`/`action_failed` of delegated
  work; `world_edit`/`privileged` audit records over a size threshold; first observation of a
  new-to-memory region; explicit user "remember this" in chat. **No importance classifier** — rules
  only, or this becomes an ML subproject.
- Candidates surface as one `[pending]` line in `mem_recent`. The agent remains the author: it writes
  the `mem_note` (the ack relation links entry↔event), or explicitly dismisses. Unacknowledged
  candidates persist and are counted — visible, nagging, never auto-committed.

The event stream is still never wholesale-copied into memory (that decision stands).

## Tools (phase A) — local to `mcp-server/`, merged into the manifest

The Node server is a thin proxy over the mod's `GET /tools` manifest; memory tools are **local tools**
merged next to the proxied ones. They call the bridge only for tick stamps and `get_world_info`, and
degrade to wall-clock-only when the game is down (memory must be readable offline).

```
mem_note        {kind, text, pos?, refs?}            → append L0 entry (stamps tick/chunk/region)
mem_recent      {budget_tokens?}                     → telescope render + compaction_due + pending
mem_read        {ids:[…]}                            → drill-down: full records + their relations
mem_write_block {links, activity, outcome, prose, pois} → derived+validated compaction (see above)
mem_place       {category, pos, name?, notes?}       → promote/update a POI
mem_verify      {target_type, target_id, result, note?} → append verification relation
mem_task        {op: set|update|clear, goal?, state?} → task frame (tasks.json); clear nags to
                                                        mem_note the outcome first
mem_recall      {…}                                  → phase B, below
```

Mechanism: reads are `observe`; `mem_note`/`mem_write_block`/`mem_place`/`mem_verify`/`mem_task` get a new
`memory` mechanism tag (they mutate agent state, not the world — neither `observe` nor `world_edit` is
honest). Node-side stamp; the mod never sees these calls.

## Phase B — retrieval (hybrid: exact first, semantic for concepts)

Three channels, cheapest and most precise first. At this scale (thousands to low tens of thousands of
short JSONL records) linear scans are inexpensive; no database.

1. **Structured filters** — dimension, region/radius vs `pos` or `bounds`, tick range, POI, ids.
   Pure field predicates over *all* records, any level.
2. **Lexical scan** — exact tokens (item names, entity names, numbers, coordinates) over *all* records:
   L0 text, block prose/outcome, place notes. This is what keeps demoted facts discoverable: "12 iron
   ingots" hits e-000143 directly even when its covering block generalized to "iron supply".
3. **Semantic embeddings** — conceptual retrieval over **frontier blocks** (one vector per block:
   prose + outcome + POI names). Brute-force cosine in Node. A matched block may recursively
   lexical-search its children before rendering.

```
query → structured ∥ lexical (all records) ∥ semantic (frontier blocks)
      → merge, dedup (an entry and its covering block collapse to one result)
      → drill into matched blocks' children where useful
      → render chronologically, clustered by episode, trimmed to budget
```

**Hierarchy rule:** broad semantic search starts at the frontier; exact channels may match any level; a
result renders at its most specific useful record — and a raw L0 hit always renders *with its covering
block's one-line gloss* (an orphaned fact without episode context is not a usable memory).

**Embedding index:** `index/<model>/embeddings.jsonl` `{v, id, dim, vec}` — **per-model**. Search never
mixes models: blocks not yet embedded under the current model fall back to lexical-only until
re-embedded; switching models means rebuilding that model's index. Backend pluggable: local
(transformers.js sentence model — default, offline) vs API; decide by measuring probe 5.

`mem_recall {query?, center?, radius?, tick_range?, budget_tokens?}` — scores exposed in results so
ranking is inspectable. Age and per-subject verification render explicitly; truncation is stated,
never silent (envelope rule applies to memory reads too).

Render sketch:

```
## Recall: "iron ingots" near (-140,65,310) r=256 — 3 results, oldest first
[b-2  L1  day 1, ~4d ago | village reverified 1h ago]  Found surface iron at ravine-west (-210,58,290)…
[e-143 in b-7  day 3  | not verified since]  "Stored 12 iron ingots in the lower barrel under the
  workshop stairs (-138,64,306)."   (mem_read e-143, b-7)
(1 result below cutoff omitted — widen radius or drop query to see all)
```

## The session charter (phase A deliverable — turns tools into behavior)

In Claude Code the harness owns the context window; durable memory therefore lives on disk — which
means memory discipline is **behavioral, not structural**. The charter is the instruction that closes
the gap (the pending surface is its safety net, not its replacement):

1. **Roles & authorization state** — principal/observer/actuator and what is currently permitted.
2. **Memory protocol** — narrate traversal explicitly (position, tick, per region entered); `mem_note`
   at the moment of observation, not retrospectively; act on `compaction_due` before continuing the
   task; recall-before-assume when entering a plausibly-visited region; clear the `[pending]` line;
   describe schematics if appearance matters.
3. **Task frame** — rendered `tasks.json`: every session opens knowing what it is in the middle of.

Deployment: workbench mode → CLAUDE.md section + SessionStart hook injecting `mem_recent`. Companion
mode → the same charter as SDK system prompt. One charter, two mounts.

## Companion mode (later phase — permanent submersion)

- **Workbench** (exists today): interactive Claude Code ↔ MCP. Permission UI, iteration, debugging.
  Phases A/B are built and evaluated here.
- **Companion** (product mode): the game launches the copilot — `/copilot start` spawns a persistent
  Claude Agent SDK loop: charter as system prompt, same bridge, in-game chat as I/O.

Memory is harness-agnostic (files + tools), so companion mode inherits phases A/B unchanged. What it
forces: ARCHITECTURE.md's authorization split assumes the Claude Code harness owns call-level consent —
headless mode deletes that layer. Companion mode is the concrete scenario that makes deferred mod-side
authorization come due (autonomy windows, argument-level constraints, audit log as transparency
surface). Own phase, own design pass, after memory proves out.

## Evaluation (machine-checkable, per ARCHITECTURE.md §Evaluation)

Storage correctness:

1. **Compaction invariant (scripted, no LLM judge):** every compacted entry's `pos` within its block's
   `bounds`; every entry reachable from exactly one compaction relation; frontier set consistent;
   derived index identical after a cold rebuild from the JSONL files.
2. **Exact recall:** plant K facts (chest coordinates, POI positions, outcomes); force compaction; ask
   for each; assert exact coordinates returned; log tokens per correct recall (the phase-C ablation
   number).
3. **Cross-world isolation:** two worlds, interleaved sessions, zero leakage; plus rollback detection
   fires when a world's tick regresses.

Retrieval honesty (these encode the revision-2 fixes; write them as executable specs *before* phase B):

4. **Demoted-detail retrieval:** plant "12 iron ingots in the lower barrel beneath the stairs"; force a
   compaction whose prose omits "12", "barrel", "stairs"; query "where are the 12 iron ingots?"; assert
   the L0 entry is found and rendered with its block gloss. (Fails by construction on block-only
   embeddings — this probe is the regression test for revision-2 issue 1.)
5. **Partial verification:** three independent facts in one episode; reverify one; assert the other two
   render as explicitly stale, not refreshed.
6. **Contradiction:** record "bridge unfinished"; later verify contradicted + note completion; recall
   "bridge status"; assert current state renders first, the old belief remains reachable, and is not
   presented as current.

System value:

7. **Gameplay ablation** (the test that decides whether the architecture earns its complexity): same
   seeded tasks under (a) no durable memory, (b) recent tail only, (c) compaction without retrieval,
   (d) full system. Measure task success, tokens, perception calls, repeated exploration, stale-fact
   errors, exact location recall, time-to-resume after context reset.

## Build order (revised)

1. **Freeze schemas** — **DONE 2026-07-19, live-verified**: `get_world_info` + `WorldIdentity`
   SavedData (UUID stable across calls, present in the world save at
   `dimensions/minecraft/overworld/data/mcptoolkit/world_identity.dat`, survives a full server
   restart); record shapes frozen as code in `mcp-server/memory/schema.mjs` (validators, `v` fields,
   relation records, per-subject verification), 9/9 schema tests green.
2. **Probe skeletons as executable specs** — **DONE 2026-07-19**: probes 1, 2, 4, 5 in
   `mcp-server/memory/probes/`, written against the frozen store API (`store.mjs`), all red with the
   intended `not implemented — build-order step 3` error. `npm test` in `mcp-server/` runs the suite.
3. **Phase A tools** — **DONE 2026-07-19, live-verified**: `MemoryStore` (`mcp-server/memory/store.mjs`
   — append-only JSONL, derived index rebuilt at open, deterministic block-header derivation,
   eligibility + coherence validation, per-subject verification, rollback detection); `mem_*` tools
   (`memory/tools.mjs`) merged into the proxied manifest in `index.mjs`, bridge-stamped ticks, offline
   degradation verified (null tick + explicit `offline` warning when the game is down).
4. **Structured + lexical recall** — **DONE 2026-07-19** (built with step 3): `mem_recall` v1 —
   structured filters + lexical scan over all records, entry-vs-covering-block dedup, chronological
   episode-clustered render, explicit truncation. Probes 1, 2, 4, 5 all green (13/13 with schema
   tests). Probe 6 (contradiction) still to write alongside step 5.
5. **Block embeddings** — **DONE 2026-07-19, live-verified**: transformers.js +
   `Xenova/all-MiniLM-L6-v2` local backend (`memory/embeddings.mjs`, `MCPTK_EMBED_BACKEND=none`
   opt-out; absent backend degrades to lexical-only, never errors); per-model index
   `index/<model-slug>/embeddings.jsonl`, lazily backfilled over frontier blocks at recall; semantic
   hits merge exact-first (a verbatim match is evidence, a concept match is a suggestion; results
   carry `channel` + `score`). Probe 6 (contradiction) written and green; semantic concept-query test
   (skips when backend absent). Live: "food supply" retrieved the wheat-farm episode (cos 0.453,
   decoy 0.128, threshold 0.30) with zero lexical overlap. Suite 17/17.
6. **Charter + pending surface** — **DONE 2026-07-19, live-verified**. Charter: workspace charter at
   `<workbench>/mcmodel/CLAUDE.md` (roles, six binding memory-protocol rules, task frame) +
   SessionStart hook (`.claude/settings.json` → `memory/recent-cli.mjs`) injecting the telescope
   render at session open — verified firing on session resume. Pending surface: lazy cursor pull in
   `tools.mjs` (`classifyEvent` rules: action outcomes, failed authority calls, world edits,
   drone death; first contact adopts cursor without backfilling), `[pending]` nag in `mem_recent`,
   auto-ack via `mem_note refs.events` (ack relation), `mem_dismiss` for deliberate non-memory.
   Live-verified all three flows against the running server (real audit events); suite 15/15.
   Task frame added 2026-07-19: `tasks.json` (`{v, current}`, per-world, mutable working state),
   `mem_task set|update|clear` (set returns any replaced task; clear returns the closed task and
   nags that outcomes belong in `mem_note`), `[task]` render line between frontier blocks and
   `[pending]`. Probes in `task.test.mjs`; suite 20/20.
7. **Ablation** (probe 7) — design at **ABLATION_DESIGN.md**, rev 2 after external review
   2026-07-19 (two tracks: end-to-end product ablation A–D + cloned-corpus retrieval isolation;
   adjacent-contrast decision rules; pipeline funnel diagnostics; runner doubles as the
   companion-mode seed; agent under test: Sonnet 5). Build next; pilot ≈16 episodes gated on
   spend approval.
8. **Companion mode + mod-side authorization** — own design pass.

## Don't-build (this feature)

| Rejected | Reason |
|----------|--------|
| Vector DB / SQLite index | Linear scans over ≤ tens of thousands of short records; same reasoning as the SQLite rejection. |
| Learned embedding as model *input* (projector) | Phase C at the earliest; opaque memory contradicts legible agency; needs the flywheel this system creates. |
| Auto-ingest of the full event stream into memory | Event log is provenance, linked by id; description is the memory-forming act. Pending *candidates* point at events; they never auto-commit. |
| Importance classifier on candidates | Hardcoded rule list only; a learned scorer is an ML subproject smuggled into a queue. |
| Background pollers / compaction daemons | Triggers are tool-visible (`compaction_due`, `[pending]`); event cursor advances lazily on tool calls. |
| In-place JSONL mutation | Records immutable; relations appended; state derived at startup. Crash-safe and audit-complete. |
| `save_generation` bookkeeping | No detection story; max-seen-tick regression check covers rollback/restore legibly. |
| Freeform summary rewrite of memory files | The known failure mode; schema-validated blocks only. |
| Cross-world shared memory / a project scope | Worlds are separate lives; skills (procedural, parked) are the cross-world artifact. Reaffirmed 2026-07-20 with the real reason: this system serves **play**, and dev-agent memory is Claude Code's job — a project store here would be a second, worse copy of something that already works. |
| Confidence scores on memories | Staleness → per-subject verification timestamps; inference → planner. Same rule as observations. |

## Rev-3 pending (measured defects, 2026-07-20 — see ABLATION_RESULTS.md + ../archive/COMPANION_DESIGN.md)

- ~~**Tier-2 pressure is missing**~~ — closed 2026-07-20 (queue item 1). L1→L2 `compaction_due` and a
  budgeted, elidable block section now exist (rules in §The rendered context; probe 8 pins them,
  including that following the nag converges). Re-measured on the soak corpus that produced the
  defect: block section 860 → 212 tokens at a 900 budget, and the nag now fires at both levels
  (6 entries → L1, 12 blocks → L2) where it previously fired at neither. Total render at that budget
  is 2367 → 1727 tokens; the remainder is the deliberately untruncated tail, which the L0 nag covers.
- **Semantic channel failed rule 4 under BOTH models — decision awaiting the principal** (updated
  2026-07-20, queue item 3). MiniLM: cosines 0.0–0.25 vs the 0.30 threshold; concept 0/15, identical
  to structured+lexical on every arm — an inert channel. bge-small-en-v1.5 (swapped in via the new
  `MCPTK_EMBED_MODEL`): concept 15/15, exact 15/15, cosines 0.42–0.49 — an apparent emphatic PASS,
  and an artifact. Rule 4 was recall-only; bge scores everything highly, so returning all 3 blocks
  for every query aces it (the tell: `n=3` on every hybrid hit). Corpus-direct, "tax return filing
  deadline" scores 0.432 and "underwater shipwreck coral reef diving" 0.526 against waypoint-patrol
  blocks, versus a true-pair median of 0.448 — TRUE 0.412–0.485 inside FALSE 0.333–0.537. The best
  accuracy at **any** threshold is 88.9%, exactly the always-reject baseline: no threshold beats
  switching the channel off, which is why tuning one was forbidden and would not have worked.
  Rule 4 now carries a **decoy arm** (unanswerable queries, any result is a false positive) that
  vetoes the recall arms; bge admits 18/18 decoys and correctly reads FAIL. `DEFAULT_MODEL` is
  deliberately still MiniLM — inert beats actively polluting.
  **Decided 2026-07-20 (Matthijs): keep the channel inert until a better model exists** — a stronger
  model plausibly *would* separate (bge-small is 33M params, was tested without its documented query
  prefix, and the corpora were three near-identical blocks). Guard added so that decision is safe:
  thresholds are now per-model (`CALIBRATED` in embeddings.mjs), `bge-small` is recorded as
  known-bad, and **any uncalibrated model disables the semantic channel rather than running it** —
  an uncalibrated model does not fail loudly, it silently returns everything. `MCPTK_EMBED_THRESHOLD`
  is the deliberate override for calibration work. Gate for adopting any future model: the decoy arm.
- Render outcome-lines are the system's hardest-working surface (every ablation condition that had
  them leaned on them) — treat their information density as a design invariant in any rev.
- **Store growth is unbounded on disk and linear per call (noted 2026-07-21 code review; deferred).**
  Compaction is purely *logical*: `writeBlock` marks children `compactedInto` in the derived index,
  but the raw L0 entries stay in `log.jsonl` forever, `places.jsonl` appends a full record per
  update ("last version wins" by replay), and every `mem_*` call re-reads and re-parses the entire
  file (`#readJsonl`) — per-call CPU and resident memory grow with a world's lifetime history.
  Related fragility: `#readJsonl` tolerates no torn tail line, so a crash mid-append makes the store
  unreadable until hand-repaired (drop/repair the unparseable trailing line would close it). Fine at
  current scale; needs on-disk compaction/rotation + a torn-tail-tolerant reader before the store is
  asked to live a long world's lifetime.

## Memory scope: world vs project — **DECIDED 2026-07-20: world only**

**This system is for play. Dev-agent memory is not its job** — Claude Code already handles dev
session continuity and memory well, and duplicating that here would be building a second, worse
copy of something that already works. So: no project scope, no cross-world store, and dev history
does not belong in world memory. The don't-build list's "cross-world shared memory" entry stands,
now for a stated reason rather than an unexamined one.

The observation that raised the question was still real, and one piece of it survives as a **live
bug** worth fixing if placeless notes are ever written (below). The rest — a project store, session
kinds, dev/play filtering — is **not being built**.

The original framing, kept because it explains the bug: memory is keyed by world, which suits play
but fits dev sessions poorly, since those span worlds and care about subjects rather than
coordinates.

The mismatch is not cosmetic — it is a **structural defect**, reproduced 2026-07-20:

- `writeBlock` rejects any grouping whose children are all placeless: *"cannot derive bounds: no
  linked record carries a position"*.
- `recent()`'s L0 nag nominates from the tail with **no position check**.
- Therefore once placeless entries exceed `budget/2`, the agent receives a `compaction_due` it is
  structurally incapable of satisfying — the same unfollowable-nag failure fixed for blocks in queue
  item 1, still live for entries. That tail then grows monotonically and nags forever. Dev notes made
  it obvious, but the bug belongs to *any* placeless `mem_note`, so it outlives the scope decision.

Corroborating leakage: this session's own notes (mcp-server code, ablation verdicts, threshold
calibration) carry no spatial meaning and are filed under world `world` only because that is the
sole container; the task frame "Execute the post-ablation queue" is a project goal; and 175 stale
harness `bot_goto` events pollute every dev render. Meanwhile genuinely world-scoped play state (the
soak frame "scout for a 13th outpost site") had to be stripped via `run.mjs --corpus-only` to stop it
hijacking an experiment — the same conflict from the other direction.

**What remains to do (small, unfixed):** let `writeBlock` derive null `bounds` when no child carries
a position, so a placeless note can at least satisfy the nag it receives. Costs a block-schema
change. Low priority under the play-first scope — placeless notes are rare in play, where nearly
everything has a position — but the nag/compaction asymmetry is a genuine inconsistency, and any
`mem_note` written without `pos` still walks into it.

**Not being built** (superseded by the scope decision above): a project store, session kinds, or
dev/play render filtering.

## Open items (deliberately few)

- Local embedding model choice — pick when building step 5, measured on probes 2/5.
- `memory` mechanism tag: confirm dispatch/manifest merge tolerates a Node-stamped mechanism the mod
  never declared.
- Coherence-check thresholds in `mem_write_block` (how distant is "disconnected", how large is
  "partition it") — set from real traversal data during step 3, not guessed now.

## Provenance

Rev 1: worked out 2026-07-19 from the step-6 sketch in ARCHITECTURE.md (three-round design review of
2026-07-19 upstream). Rev 2: same day, after external review. Accepted in full: hybrid retrieval
(reachable ≠ retrievable — rev 1's own recall probe would have failed against rev 1's retrieval, which
is the strongest possible argument); per-subject verification; strict immutability via relation
records; tool-derived block headers; schema versions; per-model embedding indexes; probes 4–7; world
UUID. Accepted with constraints: pending-candidate surface (rules only, lazy cursor, no daemon).
Modified: "probes literally first" → schemas first, probes as executable specs alongside phase A;
`save_generation` → max-seen-tick rollback detection. Added in rev 2 independently: L0 hits render
with covering-block gloss; tallies labeled with their derivation source.
