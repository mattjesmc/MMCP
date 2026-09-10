# Testbench — the complete bench, constructed from full / category / discipline / ablation

The standing dev bench from RESEARCH_WORLD_REPRESENTATION.md / REPRESENTATION_DESIGN §5 —
small on purpose: a fixture for comparing **models** and for **before/after runs on architecture
changes** (predicates, region rollup, formats), not a leaderboard.

## The four construction axes (registry.mjs is the single index)

Every runnable unit (a rung, a question, a gate, a course, a family) is one record in
`registry.mjs`: its category + runner + subset selector, the ablation arms its harness supports,
and the world-understanding disciplines it makes load-bearing (`disciplines.mjs` taxonomy,
reference: `mcp-toolkit/docs/bench/DISCIPLINE_INDEX.md`, regenerate via `bench-report.mjs --index`).
Selection and display share that index:

```
node testbench/run-bench.mjs --list                          # resolved plan, no execution
node testbench/run-bench.mjs --dry                           # FULL bench, staging self-checks only
node testbench/run-bench.mjs --model haiku                   # FULL bench, full arms
node testbench/run-bench.mjs --cat T,Z --model haiku         # by category
node testbench/run-bench.mjs --discipline causal,relational  # by discipline (load-bearing)
node testbench/run-bench.mjs --cat T --ablation std          # paired toolset arms (with/without …)
node testbench/run-bench.mjs --cat T --ablation loo          # per-tool leave-one-out where supported

node testbench/bench-report.mjs --by cat|discipline|arm|unit # pivot ALL results the same four ways
node testbench/bench-report.mjs --index                      # the discipline marker index (markdown)
```

The per-category entrypoints below keep their own CLIs — run-bench composes them; ablation stays
IN the harnesses (toolset subsets via `MCPTK_HIDE_TOOLS`/`MCPTK_WORLD_TOOLS`), run-bench only picks
which named arms run.

**Versioning & the SUT seam** (2026-07-25, mcp-toolkit/docs/bench/BENCH_EXTERNALIZATION.md): `version.mjs`
holds `BENCH_VERSION`; every runner stamps `bench_version` into its manifest (0.9.x = pre-freeze,
1.0.0 = the freeze + repo split — paper-citable results carry 1.0.x). `adapter.mjs` is the
system-under-test boundary: the ORACLE channel (staging/truths/scoring on the bridge) never varies;
the AGENT channel (the tool surface, arms as surface transforms) enters through an adapter —
`mcp-shim` is adapter #1, run-tasks takes `--adapter`. Paper direction: mcp-toolkit/docs/bench/PAPER_BENCH.md
(instrument) + PAPER_TOOLKIT.md (system).

```
node testbench/run.mjs --dry                 # stage + walk + verify answer key, no model spend
node testbench/run.mjs --model haiku         # full A+B run
node testbench/run.mjs --model sonnet --cat b --formats ascii_grid,palette_rows

node testbench/run-tasks.mjs --dry --seeds 2                    # Category T: stage + truths only
node testbench/run-tasks.mjs --model haiku --seeds 2 --reps 2   # full with/without ablation
node testbench/run-tasks.mjs --model haiku --rungs 4-4 --arms with  # one cell, one arm
```

Needs the dev server up (`gradlew runServer`). Results land in
`testbench-results/<stamp>-<model>/` (manifest.json + answers.jsonl + summary.md); the manifest
records model, toolkit version, git head and the question-set hash so runs stay comparable.

- **Category A** (spatial cognition): `stage.mjs` builds a deterministic arena (layout.mjs),
  `observe.mjs` walks it recording verbatim scene_summary/get_blocks envelopes, and each of the
  14 gradient questions (easy anchors → egocentric/reachability integration) is asked in a FRESH
  no-tools SDK session whose entire world is that transcript. Reachability truths are verified
  against the live pathfinder (`check_path`) at generation time — the bench and the predicates
  co-validate.
- **Category B** (serialization formats): identical questions over the identical 9×9 patch,
  served as `json_coords` vs `palette_rows` (the toolkit's native shape) vs `ascii_grid`.
  Accuracy + input tokens per format; a null at frontier scale closes research open question 1
  cheaply.

- **Category T** (tool ablation, 2026-07-23): are the representation tools *wins*? An 8-rung task
  ladder (point query → box clear → conflict count → pen reachability → wild height stats →
  3-site cut/fill → 9-tile water survey → flattest-tile argmin), each instance a FRESH tool-using
  SDK session through the MCP shim. The `without` arm hides exactly the representation tools
  (`MCPTK_HIDE_TOOLS` in index.mjs); both arms lose mutation/commands/delegation. Truths are
  live-computed at full resolution (staged sites by construction, wild terrain via the
  probe-validated predicates); bool truths seed-parity balanced. Recorded per session: accuracy,
  confident-wrong, turns, tool calls, tokens, turn-caps, and an ordered per-call **trace**
  (tool/args/error/result size) with `repeat_calls`/`error_calls` — the counts the round-three
  motivators in RESEARCH_WORLD_REPRESENTATION.md ask for. Manifests record a `tools_hash` of the
  RUNNING bridge (build.gradle's version once lied while an orphaned old server held the world).
  Baseline (haiku, 2026-07-23): with-arm 94→100% (after the check_path 0.4.1 fix) at 39k tokens
  vs without-arm ~72% at 246k; wins concentrate at rungs 6–8, and rung 4 caught + confirmed the
  check_path tri-state fix (50% → 100%).

Lessons already encoded: quiz questions must be answerable from the transcript (a vantage was
added when haiku exposed a gap); `fill ... hollow` closes top/bottom faces (the pen is built from
four walls); the answer key self-checks against the live world before any model is spent.
Category-T staging additions: forceload-adding a whole ungenerated region stalls a tick past the
watchdog and gets the world force-killed — generation is strip-batched with a verification sweep,
and the dev world runs `max-tick-time=0` (run/server.properties); staged sites stay forceloaded
for the run (`check_path` spawns a real walker — unloaded chunks mean null verdicts, by design);
wild-terrain tasks must be argmin-shaped, not threshold-shaped (fixed thresholds are a biome
lottery — NO_LEAVES heightmaps still count tree trunks).

The tool-output consistency contract lives next door: `probes/conformance.test.mjs` sweeps the
manifest and enforces envelope/coverage/null-verdict conformance per declared tier, with a
classification ratchet for new tools.

- **Category C** (memory recall depth, 2026-07-23): the standing memory fixture, designed in
  `mcp-toolkit/docs/bench/CATEGORY_C_DESIGN.md`. It **reuses the completed ablation harness** (`ablation/`
  runner, MCP shim, staging, pipeline funnel, corpus freeze/clone, charter — all imported) and
  **upgrades** it from a one-shot A/B/C/D experiment into a repeatable model×architecture fixture.
  Its spine is corpus DEPTH: three explore sessions patrol three separated regions and narrate
  ~7 planted facts into memory until the early ones compact to L1 blocks and drop out of the
  session-open render — the regime the ablation results said was missing, where `mem_recall` can
  finally differ from manual `mem_read`. A fourth fresh session answers a six-question difficulty
  gradient (easy anchor → cross-region attribution → post-mutation staleness) as one JSON object,
  scored mechanically against construction/server truth (no LLM judge). Axes: `--model` (model
  swap) and `--arch full,no-recall` (paired over a byte-identical frozen corpus clone; `full` = the
  ablation's condition `d`, `no-recall` = condition `c` = `d` minus `mem_recall`). Every run asserts
  the demoted facts are `in_render:false` (via the funnel) before trusting a score, and reports the
  staleness taxonomy + `mem_recall`/`mem_read` call counts.

  ```
  node testbench/run-memory.mjs --dry --seeds 1            # stage + prompts + truths, no spend
  node testbench/run-memory.mjs --model haiku --seeds 1    # explore → mutate → quiz (full arch)
  node testbench/run-memory.mjs --model haiku --arch full,no-recall   # paired rule-3 comparison
  ```

  Still SERIAL only. The concurrent-writer variant (C running while a live workbench writes the same
  memory dir) stays behind the parked memory-dir concurrency lock; true multi-world-save switching
  and "what happened around tick T" event queries are documented v2 extensions. See the design doc.

- **Category P** (true-play, CATEGORY_P_DESIGN.md): P-perceive perception honesty (sense-only,
  legal FOV) + P-survive (legal-vs-xray survival). **Category E** (embodied, BENCH_EXPANSION.md):
  run-combat (wave ladder), run-traverse (roofed obstacle courses, predict/blind/goal arms),
  run-objectives (survive-build / milestone ladder / dungeon capstone). **Category Z**: run-redstone
  BUILDS a circuit to a driven truth table; run-diagnose READS one — which input controls the lamp
  (relational), where is the one break (causal, repair-verified), would the lamp survive removing
  this wire (counterfactual, intervention-verified). Every diagnose truth is proven by live
  intervention at setup before model spend. **Category R**: run-rotate, offline rigid-transform VQA.
  **Category W**: run-wbuild, world-edit build-to-spec + repair, auto-diffed (build-score).

- **INSTRUMENTS, which are not units** (`run-shapebatch.mjs` is the first). A bench unit asks whether
  the *model* can do something; an instrument asks what a *tool* costs and buys. `run-shapebatch`
  measures `place_shapes` — one authored room built with and without it, two arms differing by exactly
  one tool (results: `mcp-toolkit/docs/platform/TOKEN_PER_TOOL_FINDINGS.md` Finding 4 and
  `STRUCTURE_AUTHORING_DESIGN.md` §7). Three exclusions are **deliberate, not oversights** — please
  do not "fix" them:
  - **not in `registry.mjs`**, so `run-bench` never sweeps it into a full run. It is not a capability
    rung and has no discipline tags; it must not appear in `DISCIPLINE_INDEX.md` either.
  - **writes to `mcp-server/measurements/`, not `testbench-results/`**, so it cannot pool with the
    frozen bench corpus (`BENCH_VERSION`) — a report treats a result dir as homogeneous, and this run
    deliberately varies the tool surface, which is exactly the `tools_hash` drift `resume.mjs` calls
    fatal.
  - **summary math lives in a pure core** (`shapebatch-report.mjs`), so `--from <dir>` re-derives the
    whole report from the recorded rows with no bridge and no model spend. Re-report rather than
    re-run when you only want to change how the numbers are presented or argued.

  Its own scenario note is worth reading before writing another instrument: it does NOT reuse Category
  W, because wbuild's target is 75 cells and `set_blocks` has always batched those into one call — the
  run would have measured nothing. Sizing the subject so the tool under test is the efficient path is
  the whole design.

- **Discipline coverage** (2026-07-25): rungs r12 (machine-room: purpose→identity, semantic) and
  r13 (hopper-chain: follow facings to the fed chest, relational) close the last read-side gaps in
  the T ladder; with Z-diagnose that makes all 10 disciplines load-bearing somewhere. The matrix and
  per-unit tags live in `mcp-toolkit/docs/bench/DISCIPLINE_INDEX.md` (generated — edit registry.mjs instead).
