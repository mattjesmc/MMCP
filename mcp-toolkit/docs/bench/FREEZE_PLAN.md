# The road to v1.0.0 and the two papers — full plan

Status: PLANNED 2026-07-25. This is the execution plan from today's state to (1) the bench freeze,
(2) the v1.0.0 measurement campaign, (3) both paper drafts becoming submittable. It sequences the
pre-freeze gap review (chat 2026-07-25) with the paper requirement tables (PAPER_BENCH.md §9,
PAPER_TOOLKIT.md §5) and the externalization path (BENCH_EXTERNALIZATION.md).

Governing sequencing rules:
- **No model spend on an instrument that hasn't passed its own ratchet.** All of Workstream A is
  verifiable offline against historical result dirs — hardening costs zero tokens.
- **Pre-register before building.** The prospective cycle's prediction is committed before the
  temporal read exists (Gate G5 before Workstream D3).
- **Freeze before any cited run.** Every number in either paper comes from a bench_version 1.0.x
  manifest. Pre-freeze runs are direction, never citation.
- **Cut lines are named now**, so budget pressure trims scope instead of rigor.

---

## Workstream A — instrument hardening (offline; blocks everything)

**A1. Bench conformance ratchet** — ✅ DONE 2026-07-25 (mcp-server 0.4.0). `testbench/ratchet.mjs`
(engine + CLI) + `probes/bench-conformance.test.mjs` (test wrapper). Over every result dir
(historical included): (a) each row joins **exactly one** registry unit — zero-match and
double-match both fail; (b) every unit a run's MANIFEST selected that PRODUCED rows had ≥1 **scored**
— the fatal case is rows-present-but-none-scorable (an accessor defect); a selected unit that
produced **no** rows (interrupted/crashed run, or rows deleted as artifacts) is a non-fatal
INCOMPLETE note, allowlisted when deliberate; (c) matcher-overlap aggregated from (a)'s
multi-matches. GREEN over all 32 dirs / 1012 rows: 0 orphan, 0 collision, 0 unscorable. `expectedUnitIds`
resolves every historical manifest dialect (categories/rungs/slices/kinds/gates/tiers/families/modes)
— 0 manifest-unresolvable. ALLOWLIST (in ratchet.mjs) documents 3 deliberate deletions
(07-40-59 milestone+dungeon pre-latch, 07-18-18 whatif pre-BOOLEAN-fix). **Drove two A4 accessor
fixes** (below): the ratchet's (b) is what surfaced them.

**A2. bench-report upgrades** — ✅ DONE 2026-07-25 (mcp-server 0.5.0). Full rewrite of
`testbench/bench-report.mjs`: manifest join (model/model_id/bench_version/adapter/tools_hash lifted
onto rows) + `--model`/`--bench-version` filters; metric columns success / **conf-wrong / abstain /
turn-cap** (`hit_turn_cap`|`capped`|`error_max_turns`) / **mean turns** / **tokens nc/wc** (was
`tokens_out`-only, now via `tokens.mjs`) / n; calibration columns gate on field presence so graded
build/traverse units drop out where undefined; composable cross pivots `--by discipline,cat` /
`model,arm` / `unit,arm` (discipline is multi-valued, cartesian-product keys); `--coverage`
(per-category tool-call histogram, offline — DARK/universe still needs the live `coverage-report.mjs`);
footer discloses unscored-row count, memory even-split token approximation, per-cell n. **Acceptance
met**: `--by discipline,cat` reproduces the recorded pivot — temporal·C = 38%, **epistemic·C = 25%**
(the recorded "weakest") — and reveals the confound (epistemic looks like 40% overall only because
`p_perceive`·P scores 100% after the A4 fix; the memory deficit is still 25%). This IS the G4 split,
already answerable offline. Shared `expandRow` moved to ratchet.mjs (no more duplication). The
`categoryOfDir`→(cat,slice) resolution and metric doctrine here carry the paper tables.

Original A2 spec (all satisfied):
- Join manifests into rows: model_id, bench_version, adapter, tools_hash, arms become row
  attributes; add `--model`, `--bench-version` filters.
- Metric columns: mean success, **confident-wrong, abstain, turn-caps, mean turns**, tokens
  **nc/wc** (fix `tokens_out`-only), n per cell. Distinguish boolean vs graded units in cells so
  calibration columns only aggregate over units where they're defined.
- Cross pivots: `--by discipline,cat` (the confound split), `--by model,arm` (secondary
  hypothesis), `--by unit,arm`.
- Footer disclosures: C token split approximation; unscored-row counts; per-cell n.
- Integrate coverage: `--coverage` emits the tool-call coverage table per run (join
  coverage-report.mjs or import it) — metric 4 becomes printable from the same tool.
Acceptance: reproduces the known 6c table and the 2026-07-25 discipline pivot from existing dirs
(numbers match the recorded summaries), plus the new columns.

**A3. Statistics** — ✅ DONE 2026-07-25 (mcp-server 0.5.0). New `testbench/stats.mjs` (dependency-free,
unit-tested `stats.test.mjs`, 8/8 — Wilson checked against textbook values, binomial against exact
enumeration): `wilson(k,n)`, `normalCI(values)`, `binomTwoSided(k,n,p0)`, `pairedSignTest(pairs)`.
Wired into bench-report: success column is now a **95% CI** (Wilson for boolean cells, normal-approx
marked `~` for graded coverage/fidelity/deepest); **min-n policy** (seeds ≥2, reps ≥3) flags thin
cells with `†` (currently the new semantic/relational rungs). **`--delta with,without`** = the paired
arm test: pairs by (id, seed, rep), exact two-sided sign test (McNemar) over discordant pairs, prints
Δ + p + sig. First result already instructive: t7/t8 show +50% Δ *directionally* but p=0.50 (only 2
discordant pairs) → "ns" — the tool-value signal is real but UNDERPOWERED at current n, which is the
quantitative case for the campaign's reps≥3/seeds≥2. Falsification threshold for the prospective
cycle (G5/G8): a moved cell = CI-nonoverlap OR paired p<.05; "nothing else moved" = control cells
within noise. Acceptance met: CIs printed; the 6c/t-ladder deltas render with intervals + p-values.

**→ Gate G1 (instrument trusted) is now SATISFIABLE**: A1 green over all 34 dirs, A2 reproduces the
recorded tables + adds the doctrine columns, A3 prints intervals. Zero model spend to here, as
planned. Remaining before G6 freeze: A5 (censoring reform) + A4 tail (E graded / tokens audit —
tokens now nc/wc in reports but the per-unit `tokens` accessor is still `tokens_out`), then B/C/D/E.

**A4. Registry hygiene found in review**: `success`/`tokens` accessors audited per unit (E graded
units, C expansion); `categoryOfDir` collisions checked by A1 anyway. — ⏳ PARTIAL 2026-07-25: A1's
(b) caught two `success` accessors that couldn't score their own rows — `p_perceive` (read
`correct`/`score`; rows carry the scenario's `honest` verdict → now `sBool("honest")` with the old
keys as fallback) and `e_survive_build` (read `fidelity`/`silhouette_iou`; rows carry `coverage` ==
silhouette_iou → now `sFrac("coverage")` first). Both now score (4/4, 1/1) in bench-report. Remaining
A4: full sweep of the E graded units + `tokens` accessors (still `tokens_out`-only — folded into A2).

**A5. Censoring reform (Matthijs, 2026-07-25): budgets leave the instrument.** The current
per-template `maxTurns` commits, at session level, the L1 confusion (budget exhaustion scored as
inability) — a cap censors the very variable under comparison and can zero out both arms of a
task that simply needs many tokens. Three changes:
- **`censored` becomes a first-class outcome** beside correct/wrong/abstain (`hit_turn_cap` rows
  reclassified): accuracy null, cost a lower bound, excluded/flagged by the A3 statistics — never
  folded into failure.
- **Caps become circuit breakers**: a generous **token** ceiling (tokens are the cost currency;
  turns only its proxy) set relative to observed behavior (~10× with-arm median), plus a stall
  detector (repeat-call loops = no progress) — trips must be rare, reported, and typed, never
  scored. Applies to agent.mjs/adapters (needs in-stream usage monitoring + abort) and every
  runner's per-template maxTurns.
- **Budgets move post-hoc**: bench-report computes **accuracy@budget curves** per arm from
  recorded traces — arms compared as anytime curves, any operating budget recoverable as a slice.
  The pre-hoc cap destroyed information; the curve preserves it.
Campaign implication: worst-case arms get more expensive (the 246k without-arm was WITH caps) —
budget rows sized accordingly; the ceiling protects only against runaways.

✅ **A5 changes 1 + 2 DONE 2026-07-25 (mcp-server 0.5.0→0.6.0). The doctrine (Matthijs): "a turn-cap
being hit is only evidence against the turn-cap"** — a cap hit carries ZERO information about the
subject (model/arm/task), only that the cap was too low, and it censors the very variable under test.
So the cap is REMOVED, not re-tuned.
- **Change 1 (censored = first-class)** in bench-report `metrics()`: any censored row
  (`hit_turn_cap`|`capped`|`stop_reason`/`subtype` ∈ {stalled, runaway, error_max_turns}) has
  success/conf-wrong/abstain forced null (out of the CIs + calibration), counted only in the
  `censored` column and in tokens (a lower bound). Effect: T 89%(880/880)→90% with the caps no longer
  scored as failures.
- **Change 2 (caps removed from the harness)**: new unit-tested `testbench/session-guards.mjs`
  (`makeStallGuard`, `runawayBound`, `overTokenCeiling`; `session-guards.test.mjs` 5/5) is the single
  source of the doctrine, wired into BOTH session chokepoints — `agent.mjs` (Category T) and
  `ablation/runner-sdk.mjs` (embodied/Z/P). The SDK loop bound is now a generous runaway guard
  (`RUNAWAY_TURNS=200`, never below the caller's advisory — strictly MORE permissive, so it cannot
  cut a run shorter than before); per-template `maxTurns` (t1=8…) are advisory only. The one
  LEGITIMATE early stop is a STALL (`STALL_STREAK=8` consecutive no-progress = all-repeated calls) —
  evidence about the session, not the instrument. A `TOKEN_CEILING_OUT=200k` output-token backstop
  catches true runaways (a trip is "only evidence against the ceiling" → re-run, never cite). Both
  runners synthesize a typed result (`stop_reason`/`subtype` = answered|stalled|runaway) instead of
  crashing; run-tasks records `stop_reason`. Scope note: quiz.mjs (single-shot recall, maxTurns 2) and
  run-memory explore (generous 45) and run-rotate (offline) bypass these chokepoints and keep their
  own bounds — a follow-up if strict consistency is wanted, but they are not tool-loop caps.
- **Change 3 (accuracy@budget curves, `--budget-curve`)** — still offline, not yet built.

## Workstream B — harness robustness (offline + one kill-test)

**B1. `--resume`**: answers.jsonl is append-only; on relaunch with `--resume <dir>`, completed
(id, arm, rep) cells are skipped. Required for campaign-scale runs. — ⏳ PARTIAL 2026-07-27
(bench 0.9.5). Shared, unit-tested `testbench/resume.mjs` (`resumeDrift` / `completedCells` /
`parseRows`; `resume.test.mjs` 8/8) + wired into **run-tasks** and **run-memory**; remaining runners
still to adopt it. Design rules, each learned from a failure this session:
- **Drift is FATAL, not a warning.** A resumed dir holds rows from two invocations under ONE
  manifest, and every report treats a dir as homogeneous. Guarded: bench_version, model, adapter,
  **tools_hash**, questions_hash + per-runner selectors. tools_hash is in the set because
  `e_repair_bridge_gap` read 60% purely by pooling a pre-fix toolkit build with post-fix ones under
  an unchanged bench_version — a resume is exactly where that would happen silently. Refusal exits 2.
- **An error row is not a result**: the cell is retried, so a crashed session never becomes a
  permanent hole; the error row stays on disk as the record that it happened.
- **A torn trailing line** (a kill mid-write) is skipped, not fatal.
- **Category C reuses the on-disk corpus** rather than rebuilding: its arms are only comparable
  because they share ONE frozen corpus, so rebuilding for a half-done seed would pool arms across
  two corpora. A seed with every arm done skips setup + 3 explore sessions + mutate entirely; explore
  transcripts are re-read from disk so the funnel's `observed` stage stays truthful.
  — ⚠ **This bullet was FALSE from the day it was written until 2026-07-28.** The reuse predicate
  tested `<memDir>/log.jsonl`, but the store namespaces by world and writes
  `<memDir>/<world-uuid>/log.jsonl`, so it was ALWAYS false and the whole reuse branch was dead code.
  Every resumed C seed silently re-ran explore into the same directory, LAYERING a second pass on the
  first, and quizzed the remaining arms against a corpus no earlier arm had ever seen — doing the
  exact opposite of the bullet's intent while looking like it worked. Caught live, mid-run, when a
  resumed seed logged an explore session it should have skipped. The predicate now lives in
  `resume.mjs` as `corpusOnDisk()` with regression tests over the real on-disk layout.
- **Lesson, recorded because it generalizes**: the end-to-end verification below exercised a COMPLETE
  dir, which short-circuits at the all-arms-done check and never evaluates the reuse predicate at
  all. Verifying the happy path verified the happy path. A resume test must cover the PARTIAL case —
  that is the only case where reuse does any work.
Verified end-to-end at zero spend: resuming a complete C dir skips both seeds and regenerates the
summary; a drifted invocation refuses with exit 2. Motivation: a killed run cost Category T twice on
2026-07-26 (the agent-harness background cap kills at 10 min — long runs must be launched detached).
**B2. Staging try/finally**: releaseArea + world cleanup run on crash paths; runner exits nonzero
but leaves no forceload tickets. Kill-test: SIGKILL mid-run, verify no leaked tickets, resume
completes the run.
**B3. Shared model alias map** (`testbench/models.mjs`): alias → exact model_id, used by every
runner; `model_id` recorded in every manifest (run-tasks currently records the alias only).
**B4. Hide-list/arm validation everywhere**: every runner that transforms the surface validates
against the live manifest (run-tasks/run-combat pattern) — adapter rule "can't express ⇒ throw."
**B5. A session that opens with NO TOOLS is CENSORED, never scored.** — ✅ 2026-07-28 (bench 0.9.6).
B4 checks the tools the SHIM can serve; this checks the tools the SESSION actually received, one
layer out. Found the hard way: a Category C smoke arm scored 1/6 with 5 abstains because its MCP
shim never connected (`mcp_servers:[{status:"pending"}]`, `tools:[]`, a 0-byte tool transcript) — and
the SDK still reported `subtype:"success"`, so every existing guard passed it through. A stall is
evidence about the session and a runaway is evidence about the guard; a missing tool surface is
evidence about **nothing**, so it is the strongest censoring case there is.
`session-guards.toolSurfaceFailure` now inspects the SDK's session-open `init` message (server status,
zero tools, and any allow-listed tool absent — a PARTIAL surface is the same silent narrowing) and
aborts before the agent can answer. The runner types the stop `no_tools`; run-memory retries once
(the failed session wrote nothing, and the one occurrence was transient), then throws for an explore
session — a corpus built with no tools is empty and every arm quizzing it would score a fiction — and
records a censored row for a quiz session. `completedCells` treats an instrument-failure row as
incomplete so a resume re-runs the cell.
**Second hole, same shape, found alongside it**: a Category C row records its terminal state on the
nested `quiz` object, so the session-level censoring axis never reached the per-question subrows —
a stalled or runaway quiz was scored question-by-question exactly like a healthy one. `expandRow`
now carries `stop_reason`/`capped` down. Score effect on the current corpus: the two 2026-07-23
`error_max_turns` C rows become censored; the 0.9.5 baseline re-reports bit-for-bit.

## Workstream C — seam + arm vocabulary (the externalization steps 2–3)

**C1. Arms as named surface transforms in the registry** (supersedes toolset-only arms): an arm =
{hiddenTools?, view?, manifest?, format?, adapter?}. run-bench selects arms; harnesses execute
them through the adapter. This is what R3–R6 need to exist as selectable arms.
**C2. Adapter requirements on units** (seam step 3): units declare needs (embodiment, client,
oracle features); `run-bench --list` reports runnable-vs-not per adapter instead of failing
mid-run.
**C3. runner-sdk unification** (seam step 2): fold `ablation/runner-sdk.mjs` sessions under the
adapter contract. Decision: pre-freeze IF C1/C2 land cleanly and E/P/C harnesses need touching
anyway; otherwise post-freeze (it changes no scores — patch-class by the SemVer policy). Default:
**defer**, do not refactor green harnesses against the clock.

## Workstream D — new arms/units and toolkit-side dependencies

**D1. Reproduction arms** (bench-side, cheap):
- R4 label-permutation: an `index.mjs` view that maps palette ids to opaque tokens (b1[s]…),
  stable per session. Arm over B + t1/t10.
- R6 short-manifest: `MCPTK_MANIFEST=short` + `tool_help` local tool (TOOL_BILL L3 gate arm),
  measured WITH tool-call coverage (A2).
- R3 formats-as-arms: registry exposure of run.mjs `--formats` (falls out of C1).
**D2. Paper-B runs' prerequisites**:
- Play-profile arm: nothing to build (MCPTK_PROFILE exists) — just a campaign row.
- **Walker repair traverse**: ~~BLOCKED on a walker actuator~~ **UNBLOCKED 2026-07-25** — the
  Mob-walker landed (toolkit 0.17.0, live-proven: bot_target move sprint-jumps a real gap with
  `ledger.jumped`, mines a sealed corridor with `repairs>0`, opens doors; NavPhysique/NavBody +
  input-frame driver; entity-free check_path — note the contract change: plain walker checks now
  jump, which touches T r4-class truths and MUST be re-validated by the A1 ratchet + a dry pass
  before the freeze). The walker traverse rows go INTO the matrix; the G3 decision flips from
  "walker in/out" to "walker rows sized" (arms: predict/goal × may_modify none/break, the §7
  BOT_SURFACE probe courses). Paper B's repair claim is measurable at v1.0.0.
- Long-session decomposition: analysis over companion-soak/extended-C logs; needs a ≥100-turn C
  variant OR reuse of existing soak transcripts if per-turn usage was recorded. Investigate first
  (zero spend), only then schedule a run.
**D3. The temporal read ("what changed since")**: built ONLY after G5 pre-registration. Toolkit
work (event-log/envelope diff, answer-shaped verdict), conformance entry, probe — then the
post-intervention half of the prospective cycle.
**D4. R5 vision adapter** (screenshot-only perception on A-format questions): needs the client
instance + an adapter whose perception is `screenshot`. FIRST CUT if budget/time presses
(pre-named in PAPER_BENCH §9).

## Workstream F — bench expansion round (Matthijs 2026-07-26: ALL pre-freeze)

From the 0.24.0 review + first walker A/B (BOT_SURFACE_DESIGN §12.1). Decision: every point lands
before G6, because F1/F2 change what a row means (comparability) and the rest are additive units
the campaign should run at 1.0.0, not 1.1.0.

- **F1. E-repair — the failure-path ladder** (the repair-loop thesis measurement; repairs never
  fired on E-traverse's mild courses). Walker-only rungs where the cheapest route REQUIRES work:
  sealed plug (break), 7-gap (bridge), shut wooden door, iron door + lever (a DIAGNOSIS rung —
  `bot_use` is item-centric so no arm can pull the lever; success = the agent names the control's
  location from the obstruction locus), budget-exhaustion resume (stops `break_budget_spent`
  mid-course; success = finishing off the resumable ledger without a re-survey). Arms: `goal`
  (bot_target + rights) vs `hand` (check_path + bot_goto + bot_mine/bot_place by hand — the
  remedial-turn loop §0 prices).
- **F2. claimed-vs-actual arrival columns** (instrument change → MUST precede freeze): every E row
  records `claimed_arrived` (the agent's ARRIVED/BLOCKED reply) beside server-truth `arrived` —
  keeps predict-vs-execute clean (the flyer 5/6 "mismatch" was an agent claim, not a solver miss)
  and adds an agent-honesty axis for free.
- **F3. Seeds ≥5 for cited E rows** — campaign sizing, not harness work; today's n=1 walker/flyer
  numbers are direction only. Folded into the G7 schedule (row 5).
- **F4. Walker as default body for new E slices** — the 2-high flyer-grounding trick distorts
  course design (it is why jumps were unplannable); E-combat's hover bug has the same root. Walker
  arms for E-combat replace the altitude-platform workaround.
- **F5. E-engage** — the second turn thesis (§4.2: a killed target no longer costs a turn). Wave
  ladder arms: reactions-only vs defend vs fight, plus destroy-while-interrupted (defend keeps the
  base goal). Kill-handover turns countable from transcripts.
- **F6. Possessed-body rung** — possession × goals is guarded (0.24.0) but only probe-covered; one
  course: possessed move succeeds, destroy refuses `no_hands` honestly. Prediction parity for
  possessed bodies stays unowned — the rung documents it rather than pretending.
- **F7. Server-load per row** (`mspt` sampled via `tick query` before/after each episode) — a slow
  row must be attributable to the server, not the agent (the battery's 182-s door goal; same
  doctrine as A5's censoring: a lagging server is a censoring instrument and the row should say
  so). Score-neutral, patch-class.
- **F8. W-describe/W-picture human-rated harness + a goal-build arm** — E-survive-build's bridge
  task is now partly inside `bot_target` (bridging is a repair), so the live arm question is
  goal-loop-build vs hand-build; also the future measurement target for `bot_target action:"build"`.

Status 2026-07-26: F1/F2/F7 built + first-run same day (bench 0.9.3 — E-repair slice
`run-repair.mjs` + `repair-scenario.mjs`, claimed/mspt columns on E-traverse and E-repair,
registry units `e_repair_*`, ratchet green). First run (BOT_SURFACE_DESIGN §12.2): plug/door/
budget-resume rungs behave as designed; `iron_control` iterated once (modification physically
removed — agents mined the breakable iron door); `bridge_gap` was a KNOWN-RED capability rung —
it caught a driver edge-fall near unbridged voids and the missing vertical-edge class
(pillar-up/stair-mine). **Both toolkit work items now BUILT (toolkit 0.26.0, BOT_SURFACE_DESIGN
§12.3): driver edge-care (`NavBody.footingAt` + `NavDriver` forward-hold at an unsupported lip) and
the vertical edges (`Action.PILLAR` place-below-and-climb + stair-mine break-to-ascend, budget/
disclosure-parity wired, `walker-vert.test.mjs` probe).** **LIVE PASS DONE 2026-07-26 (BOT_SURFACE
§12.3): `walker-vert` 8/8 including execution; battery re-green (walker 7/7, walker-caps 16/16,
bot-target 13/13, predicates 8/8, reach-goals 11/11, conformance 34/34); the reasoned pillar timing
constants held without tuning. One real defect found and fixed — a pillar could only be planned ONCE
(`hasFloorBelow` reads the world, which has no block the search merely planned), so towering out of
anything deeper than one block was unreachable.** **F1 IS NOW COMPLETE — E-repair re-run
`2026-07-26T18-40-27-repair-haiku` (1 seed × 5 rungs × goal/hand): goal 5/5, hand 4/4, ratchet green.
`bridge_gap` FLIPPED GREEN on both arms (arrived, dist 0.6, alive — goal 2 turns/12k wc vs hand 3
turns/25k), so the last KNOWN-RED capability rung is closed and the rung now measures what it was
built to measure. `iron_control` correctly stays `arrived:false` — it is the DIAGNOSIS rung and both
arms named the control (`named_control: true`). Every row `claim_matches: true`; no false ARRIVED
this time.** The goal-vs-hand shape holds across the ladder: same turns (13/13) at 67k vs 105k wc.
F3 scheduled into G7 row 5; F4–F6, F8 open.

## Workstream E — documentation truth pass (before the tag)

- README T section: 8→13 rungs; swap/surface arms; adapter/version note (partially done).
- BENCH_EXPANSION.md: statuses to match registry (E proven, W-schematic/repair proven,
  W-describe/picture unbuilt) or mark historical.
- ARCHITECTURE.md §Evaluation: point at the registry bench as the standing eval.
- Regenerate DISCIPLINE_INDEX.md at the tag (`bench-report --index`).
- PAPER_BENCH §9: fold in the pre-freeze checklist rows (A1–A3 as freeze criteria).

---

## Gates (each is a checkable state, not a date)

- **G1 — instrument trusted**: A1 green over all historical dirs; A2 reproduces the known tables;
  A3 intervals printed. *Zero model spend to reach.*
- **G2 — harness survivable**: B1–B4 done; kill-test passed.
- **G3 — arms exist**: C1/C2 + D1 arms dry-green (`run-bench --dry` stages and self-checks without
  spend). **Walker in/out decision here.** R5 in/out decision here.
- **G4 — confound split read**: A2's discipline×cat pivot over existing results answers whether
  temporal/epistemic deficits are discipline-intrinsic or category-bound. *Offline; uses old runs.*
- **G5 — pre-registration**: the prospective prediction (PAPER_BENCH §6, re-scoped per G4 if
  needed) committed to the repo verbatim, hash recorded in PAPER_BENCH. After this, D3 may build.
- **G6 — FREEZE = v1.0.0**: E done; BENCH_VERSION → 1.0.0; tag; repo split per
  BENCH_EXTERNALIZATION §4 (bench name decided); DOI optional.
- **G7 — campaign complete**: matrix run per schedule below, all dirs ratchet-green.
- **G8 — prospective cycle closed**: pre cells → build D3 → post cells → per-cell deltas reported,
  including controls, whatever the outcome.
- **G9 — papers**: tables generated from bench-report only; drafts → full prose; internal review
  pass (the docs' own verification culture applied to the manuscripts: every number traced to a
  1.0.x dir).

## The campaign (G7) — run order, priorities, cut lines

All sessions on the Max-subscription substrate: cost is wall-clock + rate limits more than
dollars. Rough scale (sessions ≈ 1–3 min each, serial on the one dev server; ~250–450 sessions
per model for the full set below → several overnights with --resume):

1. **Headline full bench** (all proven units, best arm), haiku + second model, 2 seeds × 3 reps.
   Feeds: discipline table, both papers' overview, R2 analysis cut.
2. **T std ablation** (with/without, 13 rungs), both models. Feeds: P1 headline, R1, secondary
   hypothesis (with row 1's model axis).
3. **L1/L2 retest cells** (t4 with; r1/5/8/10/11 with/swap), both models. Feeds: loop episodes at
   1.0.x.
4. **Reproduction arms**: R3 (B formats, sonnet-class model for the frontier-null half), R4, R6.
5. **Paper-B rows**: play-profile arm (P/E), 4-arm view rerun (once, haiku), E-traverse 3 seeds;
   walker rows if G3 said yes.
6. **Prospective cycle pre-cells** (temporal/epistemic + spatial controls) — then G8's post-cells
   after D3.
7. R5 vision arm if it survived G3.

Cut order under pressure (pre-committed): R5 → walker rows (claim cut with them) → second-model
coverage on rows 4–5 (haiku-only there) → reduce reps on row 1 (never below 2×2). Rows 1–3 and 6
are not cuttable — they carry both hypotheses and the loop.

## Risks & responses

- **Dev server stability at campaign scale** → B2 kill-test + --resume; run categories in separate
  invocations; watchdog already disabled on the dev world.
- **Bench churn after freeze** → SemVer policy (version.mjs); anything score-affecting post-tag is
  1.1.0+ and re-runs its cells.
- **G4 dissolves the prospective target** (deficit is category-bound, not discipline-intrinsic) →
  re-scope the registered prediction to the C-cells explicitly (already allowed in PAPER_BENCH §6);
  the loop demo survives either way.
- **Walker driver slips** → pre-named cut; Paper B keeps the goal-shape token win, drops the
  repair claim.
- **Second-model rate limits** → rows 1–3 are the only both-model rows; everything else degrades
  to haiku-only without touching the hypotheses.

## Decisions needed from Matthijs (none block Workstream A)

1. **Bench name** (needed at G6 — the split repo takes it).
2. **Second model** for the campaign (sonnet assumed; opus-class raises cost, strengthens the
   frontier-null claims).
3. ~~**Walker scope**~~ — RESOLVED 2026-07-25: NavBody walker built + live-proven (0.17.0);
   walker rows enter the matrix. Residual: check_path's contract changed (walkers jump) —
   pre-freeze re-validation of affected truths.
4. **R5 vision arm**: in or out (needs client + adapter work).
5. Venue/genre targets for both papers (needed at G9, not before).
