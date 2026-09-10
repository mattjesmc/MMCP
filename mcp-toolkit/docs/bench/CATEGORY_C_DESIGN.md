# Category C — memory recall bench (standing fixture)

Date: 2026-07-23. The fourth testbench category (README: A voxel-spatial, B serialization, T
tool-ablation, C memory). Designed here, built in `mcp-server/testbench/run-memory.mjs` +
`mem-scenario.mjs`. It **reuses the completed memory-ablation harness** (`mcp-server/ablation/`)
rather than re-deriving it, and **upgrades** it from a one-shot experiment into a repeatable
model×architecture fixture that finally runs the test the ablation could not.

## Why this exists (what the ablation left open)

The gameplay ablation (`ABLATION_DESIGN.md` / `ABLATION_RESULTS.md`) shipped a full A/B/C/D grid and
answered most of MEMORY_DESIGN §Evaluation. But its central caveat, stated twice in the results, is
that **rule 3 (`mem_recall` ≥ `mem_read`) was never actually exercised**: in 11 of 12 fact-slots the
quizzed fact was still `in_render:true`, so neither condition had to retrieve — the grid measured
render-reading, not recall. The results name the fix verbatim:

> A real test needs bulk material with ticks *after* the planted facts, a debrief on detail outcome
> lines do not carry, or a different scenario entirely.

Category C **is** that scenario, and it is standing (re-run on every model swap and every
memory-architecture change), not a single verdict. Its spine is **corpus depth**: enough regions ×
facts × explore episodes that the quizzed facts are provably demoted out of the session-open render
(`in_render:false`, asserted by the pipeline funnel before any score is trusted), so recall vs.
manual `mem_read` drilling can differ.

## What is reused, verbatim (imported, not copied)

| From `ablation/` | Role in C |
|---|---|
| `runner-sdk.mjs` (`runEpisodeSdk`) | fresh-session SDK runner (Max substrate, no API key) |
| `mcp-shim.mjs` | condition-filtered MCP shim: mem_* against the per-run dir, world tools proxied, abstracted perception view, verbatim tool transcript |
| `conditions.mjs` | `CONDITIONS.d` (full copilot toolset), `AGENT_WORLD_TOOLS`, `tailOnlyRecent` |
| `charter.mjs` | `buildSystemPrompt("d")`, `buildOpeningMessage` (session-open render) |
| `render-cli.mjs` | child-process session-open render (sees the shim's writes) |
| `clone.mjs` (`cloneMemoryDir`) | freeze the explore corpus, fork it per architecture arm |
| `scenarios/stage.mjs` | deterministic staging (`platform`/`cluster`/`tower`/`chest`/`forceload`) |
| `metrics.mjs` | `factFunnel`, `extractJson`, `posMatch`, staleness helpers — all mechanical, no LLM judge |

The reuse is the point: C and the ablation share one runner, one shim, one staging vocabulary and
one funnel, so a corpus/metric change lands in both and they can never silently diverge.

## What is new (the Category-C layer)

Two files in `testbench/`, peers of `run.mjs`/`run-tasks.mjs`:

- **`mem-scenario.mjs`** — one parameterized, seeded, multi-session scenario with a **difficulty
  gradient** of question types, machine-scored against construction/server truth.
- **`run-memory.mjs`** — the orchestrator. Output shape matches A/B/T: results land in
  `testbench-results/<stamp>-mem-<model>/` (`manifest.json` + `answers.jsonl` + `summary.md`), the
  manifest freezes model, toolkit version, git head, `tools_hash` of the running bridge, and the
  question-set hash so runs stay comparable.

### Axis — model and architecture, not the A/B/C/D lattice

The ablation's axis was *which memory layer exists* (the lattice). C is a fixture, so its axes are
the two things a fixture compares:

- `--model <id>` — the primary use (does model X remember better than Y over the same corpus).
- `--arch full | no-recall` — architecture on/off over a **byte-identical frozen corpus**
  (`cloneMemoryDir`), the retrieval layer being the only difference. This is the ablation's Track-2
  fork, repurposed as the standing rule-3 test — now over a corpus deep enough that `in_render` is
  false for the demoted facts.

The arch axis maps directly onto the ablation's own validated conditions, so no new toolset lattice
is invented: **`full` = condition `d`** (the real copilot, all mem_* incl. `mem_recall`),
**`no-recall` = condition `c`** (`d` minus `mem_recall` exactly — the agent keeps `mem_read` as the
"drill manually" competitor). The **explore phase always builds under `d`**; only the quiz arm
varies. The system prompt follows the condition (`charter.buildSystemPrompt`), so the no-recall arm
is never nagged to use a tool it lacks.

### Phases (all serial — no concurrency required)

1. **Setup** — stage N spatially-separated regions, each with several countable fact structures,
   plus a depot chest that will be mutated. Idempotent staging (stage.mjs), forceloaded in
   ≤256-chunk strips, released at run end.
2. **Explore** — one fresh session per region cluster (3 by default) patrols its waypoints and
   narrates into memory. These sessions BUILD the corpus; depth is tuned (regions × facts × episodes,
   render budget) so early facts compact to L1 blocks and drop out of the tail.
3. **Freeze + mutate** — the explore corpus is frozen at `<runDir>/memory`; the scenario's `mutate()`
   runs once (drone despawned), moving/restocking the depot chest so the staleness question has a
   live-changed subject.
4. **Quiz** — for each `--arch` arm: clone the frozen corpus to `<runDir>/quiz-<arm>/memory`, run
   ONE fresh no-re-survey session that answers the whole gradient as a single JSON object, score
   per question. Cloning first (freezing) is mandatory — a full-tools quiz appends `mem_verify`/notes,
   which must not leak into the other arm's corpus.

### Question gradient (construction/server truth only)

Every truth is known by construction or read from the server at generation time; **no LLM judge**,
matching the ablation's don't-build list. Reported by difficulty tier so a regression shows as a
shifted cliff, not a noisy mean (the Category-A design rule).

| id | tier | question | truth source | tests |
|---|---|---|---|---|
| `anchor` | easy | block on the start marker | recent note / `get_blocks_at` | format floor (should be `in_render`) |
| `where` | medium | coordinates of the gold cluster | construction | demoted-fact location recall |
| `count` | medium | size of the emerald cluster | construction | demoted-fact count recall |
| `region` | hard | which sector held the bookshelf tower | construction | cross-region attribution |
| `breadth` | hard | how many distinct structure types in sector 3 | construction | recall breadth over one block |
| `stale` | hard | CURRENT depot-chest contents (mutated) | post-mutate server | staleness + `mem_verify` catch |

Per-question scoring: exact and ±tolerance scored separately; `null` = honest abstain (never
confident-wrong); confident-wrong = non-null and wrong (the metric the whole bench cares about).
`where`/`stale` reuse `posMatch`; `stale` reuses the stale-fact taxonomy
(`verification_attempt` / `stale_assumption` / `contradiction_recorded`). Each fact runs through
`factFunnel` so a wrong answer localizes to observation / formation / compaction / render /
retrieval, and the run asserts `blocks_total ≥ 2` and the demoted facts are `in_render:false`
before the score is believed (the guarantee interrogation-multi could not make).

### Metrics per run

Accuracy per tier, confident-wrong count, abstentions, tokens (in/out/cache), tool calls,
`mem_recall` vs `mem_read` call counts (the rule-3 discriminator), wall time, turn-caps, and the
per-fact funnel. `--arch full` vs `no-recall` are reported as a paired table over the same corpus:
accuracy delta (should be ≥0 for recall to matter) and retrieval-cost delta (recall's actual claim).

## Deliberately gated / deferred (honest scope)

- **Concurrent-writer variant.** Running C *while a live workbench session writes the same memory
  dir* is the one piece that needs the parked memory-dir concurrency lock (TODO §Testbench "Gate for
  C"). C's core is serial (the ablation proved serial multi-session works), so it ships now; the
  concurrent staleness variant stays behind the gate. Not built.
- **True multi-world.** v1 is single-world / multi-**region** (the store tags region/chunk; the
  cross-region questions exercise the same retrieval machinery). Switching between distinct world
  saves ("which places did you visit in world W") is a v2 extension — it needs either sequential
  world-save loading or the concurrency work. Documented, not built.
- **"What happened around tick T."** Dropped from v1: robust EventLog ground truth is fragile to
  plumb (event ticks are agent-timing-dependent). Construction/server truth is bulletproof; the
  tick-query type is a v2 extension once EventLog truth is scripted deterministically.

## Verifications & gates (to decide after the first full run)

The principal decides these after the shakedown run, per the plan:
- corpus-depth knobs (regions/facts/episodes/render budget) that reliably force `in_render:false`;
- whether `--arch no-recall` shows any accuracy or cost separation at this depth (if not, that is
  itself the finding the ablation asked for — recall simplification candidate);
- a standing probe (`node --test`) that dry-validates the answer key against the live world before
  any spend, mirroring `run-tasks.mjs --dry`.
