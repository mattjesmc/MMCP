# Paper A (bench) — working draft & direction record

Status: DRAFT 2026-07-25. This file is the working outline for the bench paper: hypothesis,
contribution list, section skeleton with prose stubs, the claim→evidence→run mapping, and the
v1.0.0 rerun matrix. It is also the *work queue*: every row in §9 that lacks a run directory is a
measurement the paper still needs. Companion: PAPER_TOOLKIT.md (Paper B, the system paper).
Division of claims between the two papers: §2.

Working title candidates:
- *Closing the Loop: a Diagnostic Benchmark for Tool-Using Game Agents*
- *An Ablative, Discipline-Typed Bench with Server-Verified Truths*
- *Beyond Leaderboards: Benchmarks as Diagnostic Instruments for Agent Interfaces*

## 1. Hypothesis

**Primary (the instrument claim):** an ablative bench with server-verified truths and
discipline-typed units can **attribute** an agent's failure to a specific interface component,
**predict** which intervention will repair it, and **verify** the repair — a loop that
accuracy-only evaluation cannot close.

Falsification condition (stated in the paper): when a discipline × tool cell flags a deficit, the
targeted intervention must move *that cell* and approximately nothing else. If fixes move scores
only diffusely, or flagged cells do not respond to the attributed component, the attribution claim
dies.

**Secondary (the headline empirical demo):** interface ablation moves task success and cost more
than model choice does, on the same cells. Falsifiable by running the model axis and the toolset
axis over the same units: if the model delta ≥ the with/without delta, the premise of tool-surface
analytics is weakened. (Current evidence, single model: with/without = 94–100% vs ~72% at 6× the
tokens. The model axis is a v1.0.0 rerun-matrix row.)

Explicitly NOT the claim: a leaderboard. The bench is small on purpose; its product is
attributions, not rankings.

## 2. Claim split vs Paper B (agreed 2026-07-25)

Same data may appear in both papers carrying **different claims**:

- Paper A claims **instrument validity**: the cell flagged a deficit, attribution named a
  component, the retest confirmed the repair moved that cell and nothing else. Paper A is
  deliberately agnostic about whether the repaired design is *good*.
- Paper B claims **design validity**: the intervention was the right design, evidenced through the
  loop that Paper A validates.

Paper A must survive Paper B's rejection: its validation is the retrospective episodes (§5) plus
one **prospective pre-registered cycle** (§6) — never a citation of Paper B. Paper B citing Paper A
for methods is fine (preprint citation works).

## 3. Contributions (each must be defended, in this order)

1. **The two-channel architecture: oracle vs agent.** The bench has a world-oracle channel
   (staging, truth generation, intervention-verification, server-state scoring — runs on the
   bridge/mod, part of the instrument, untouchable by the system under test) and an agent channel
   (whatever tool surface the SUT exposes to its model). Ablation arms are *degraded agent
   channels*; the oracle channel never varies. This is what makes truths trustworthy under every
   arm. Implementation record: BENCH_EXTERNALIZATION.md.
2. **Truth discipline.** No LLM judge anywhere in the scoring path. Truths are computed from server
   state; Z-diagnose truths are proven by live intervention before model spend; reachability truths
   are co-validated against the live pathfinder at generation time; boolean truths are seed-parity
   balanced; the answer key self-checks against the live world in --dry before any spend.
3. **The metric set beyond accuracy.** Confident-wrong vs abstain vs **censored** as first-class
   outcomes (calibration + honest budget accounting), turns, prefix/variable token split,
   tool-call coverage (did a tool go dark), repeat/error calls, and ordered per-call traces that
   make new motivator counts computable offline from any recorded run — no re-spend.
   **No pre-hoc budgets** (Matthijs, 2026-07-25): a turn cap scored as failure commits the L1
   confusion at session level — budget exhaustion sold as inability — and censors the very
   variable (cost) the arms are being compared on; two strategies with different cost shapes can
   both be zeroed by a ceiling chosen before the data existed. So: caps are circuit breakers only
   (generous token ceiling + stall detection, trips typed `censored`, never scored), and budgets
   are applied **post-hoc** — bench-report derives accuracy@budget curves per arm from recorded
   traces, so arms compare as anytime curves and every operating budget is a slice, not a design
   decision. The coverage contract applied to the bench's own rows: the instrument must not
   contain a confident falsehood about what an agent *couldn't* do.
4. **Four construction axes over one registry.** Full / category / discipline / ablation are
   selections over a single unit index (registry.mjs); selection and reporting share the axes, so
   any past run pivots along them. Ablation arms are manifest transforms in the shim
   (hide/swap/view), not system rebuilds — with/without/swap/LOO cost no Java.
5. **Validation: the loop has closed, retrospectively and prospectively.** §5 and §6.
6. **A reproduction suite**: published failure-mode findings recovered (or honestly not) as bench
   arms — construct validity plus independent replication in a field whose evidence base this
   project's own survey found unreliable (4/25 load-bearing claims refuted on full-text reading).

## 4. Section skeleton (with prose stubs)

1. **Introduction.** Agent benches score; they rarely diagnose. When a tool-using agent fails a
   task, the score cannot say whether the model lacked the capability, the tool lacked the answer,
   the description hid the tool, or the verdict lied. Stub: *"A benchmark that cannot distinguish
   'the model can't' from 'the interface didn't let it' cannot guide interface design. We present a
   bench built to make exactly that distinction, and show it closing the
   attribute→predict→repair→verify loop on a production tool surface."*
2. **The instrument.** Two channels (§3.1); unit registry + discipline taxonomy (10 disciplines,
   DISCIPLINE_INDEX.md); categories as staging harnesses (A/B spatial-VQA, T tool-ablation ladder,
   C memory depth, P perception honesty, E embodied, Z causal/redstone with intervention-verified
   truths, R offline transforms, W build-to-spec); arms as manifest transforms.
3. **Truth discipline.** §3.2 above, with the staging self-check lessons (argmin-shaped wild-terrain
   tasks, forceload strip-batching, answerability audits).
4. **Metrics.** §3.3, with the confident-wrong ledger and why calibration is the axis interface
   work moves (the tri-state episode converts confident-wrong to correct-or-abstain).
5. **Validation — retrospective loop episodes.** §5.
6. **Validation — the prospective cycle.** §6 (pre-registered before the run; reported whatever the
   outcome).
7. **Reproduction suite.** §7.
8. **The discipline profile and its confound.** The 2026-07-25 pivot (semantic 100 … temporal 38,
   epistemic 25) demonstrated the analysis axis; the paper must also show the discipline × category
   split, because discipline scores are confounded with category membership (epistemic units
   concentrate in C/P). Honest form: report both pivots; attribute deficits only where a
   discipline's failures span categories.
9. **Limitations.** One environment; one team built bench and system (defense: server truths can't
   be argued with, arms are symmetric transforms, and the bench falsified its builders' own
   sub-hypotheses — §5.4); model coverage bounded by budget; no same-world external SUT (mineflayer
   protocol ceiling: 1.21.x vs server 26.2) — cross-stack comparison is scoped out honestly, the
   adapter seam exists for when a 26.x-capable substrate appears.
10. **Related work.** MineDojo/TeamCraft task-spec + validation-protocol patterns (adopted, cited);
    FLE (typed-API environment, no diagnostic loop); OSWorld/VWA (ablation culture in GUI agents);
    the field's evidence-quality problem (RESEARCH_WORLD_REPRESENTATION.md meta-finding) as the
    motivation for reproduction.

## 5. Retrospective loop episodes (the core evidence — all already run)

Each episode: flag → attribution → intervention → retest. v1.0.0 reruns replace the historical run
dirs with tagged ones (§9).

| # | flag (cell, run) | attribution | intervention | retest result |
|---|---|---|---|---|
| L1 | T rung-4 reach, with-arm 50%, 2 confident-wrongs (2026-07-23T06-31-05) | agent trusted a budget-truncated `reachable:false, partial:true` — opaque verdict, interface fault not model fault | check_path tri-state: null verdict over un-stabilized search + remedy note (toolkit 0.4.1) | same cell 100% (4/4, one call, ~570 tok/session; 2026-07-23T07-56-23); without-arm unchanged at 50% and 20× tokens |
| L2 | swap-arm t1 point identity 100%→0%, degrading to ABSTAIN (§6a partial run) | not "keep get_blocks_at" but structural: `locate` had no bottom-up direction — hiding raw reads removed a *direction*, not a tool | two-way `locate` (`at:` solves positions→thing, 0.8.1) | r1 0%→100%, r10 (5-referent) 100%, full swap arm 97% vs 97% at −5.5% tokens (2026-07-24T18-03-57) |
| L3 | E-traverse goal arm 18 turns vs 10, all on one course (BOT_SURFACE §9 first run) | verdict ambiguity: `achieved` at 0.56 blocks read as not-arrived → re-issue thrash (12 turns) | `already_there` + explicit do-not-reissue note | goal arm 10 turns vs 11, 51k vs 74k tokens (second run) |
| L4 | discipline pivot flags temporal 38% / epistemic 25% (2026-07-25) | pending confound split; candidate attribution: integration-over-time has no answer-shaped read | → the prospective cycle, §6 | — |

**§5.3b Argument thread — the truth constraint is what makes diagnosis possible** (promote into
the introduction, 2026-07-25): "no LLM judge" reads as rigor hygiene but is actually the
*enabling condition* of the primary hypothesis. Attribution requires that when a cell moves, the
instrument itself cannot have moved — server-verified truths are arm-invariant and
model-invariant, so a delta is attributable to the interface component under test; a judged score
is neither, and a judged bench could flag but never attribute. Same argument one level up: keeping
*humans* as the truth for subjective quality (§7b) is what makes proxy-gaming measurable — the
constraint enables its own test. The general form, worth a sentence in the intro: **every truth
source the bench refuses to soften is a class of diagnosis it becomes able to make.**

**§5.4 The nulls are validation too.** An instrument that only confirms is broken. The bench
returned: surface view = ~2% not the projected 12%+ (and the 84%-of-bill figure was the *crippled
ablation arm*, identified as such by the arm structure itself); bot-surface consolidation
break-even in prefix tokens (+215, falsifying the sub-hypothesis); the detail:full escalation
hatch failing to rescue the predicate-less arm; embeddings worse-than-useless under the decoy veto.
Every one of these contradicted its builders' expectation and was reported. That is the strongest
available answer to "you built the bench that grades your own system."

## 6. The prospective cycle (pre-registered; the run that makes Paper A self-sufficient)

Registered claim, to be frozen verbatim before the implementation exists:

> The temporal/epistemic deficit (L4) is attributed to missing tool-side integration over time —
> the same failure class as spatial map integration, on the time axis. Prediction: an answer-shaped
> "what changed since" read (diff against the event log / a prior observation envelope, server-side)
> will move the **temporal** cells (C: stale, count, where; E: milestone ordering) materially, move
> **epistemic** cells only where their failure mode is staleness-typed, and leave **spatial /
> quantitative / semantic** cells statistically unchanged.

Protocol: (1) freeze this prediction + the affected-cell list in the paper repo before building the
tool; (2) run the pre-intervention cells at v1.0.0; (3) build the read; (4) rerun the same cells,
same seeds, same model; (5) report the delta per cell, including the no-change cells, whatever the
outcome. A negative is reportable: it would falsify the attribution and demonstrate the loop's
verify step killing a wrong prediction — which is still the loop working.

Prerequisite honesty check (before pre-registration): the discipline × category confound split
(§4.8). If temporal/epistemic deficits collapse into "Category C is hard," the registered
prediction must be re-scoped to C-cells explicitly or the attribution reframed.

### 6.1 The honesty check FIRED — the claim above is WITHDRAWN, and replaced (2026-07-27)

The prerequisite check did not merely re-scope the prediction; it dissolved its subject. The
temporal/epistemic deficit was **an instrument artifact**, not a capability result:

- `ablation/conditions.mjs AGENT_WORLD_TOOLS` named `get_blocks`, renamed to `get_surface` in toolkit
  0.6.0. The shim filters that list against the LIVE manifest, so the stale name **silently
  vanished** and Category C ran with no structured block reader — 70+ raycasts hunting a chest 6
  blocks from a coordinate the prompt had supplied. Fixed at bench 0.9.4, together with
  `assertWorldToolsLive` (FREEZE_PLAN B4) so a named-but-absent tool now throws.
- Two C questions were defective: `anchor` printed the platform's y beside the words "on top of"
  while its truth sat one block higher (three independent sessions returned the same wrong block),
  and `breadth` asked what the agent "recorded" but graded construction truth. Fixed at 0.9.5.

Same fixture, same corpus, same questions, repaired instrument: **C 17% → 87%** (5 seeds).
Pooled at 7 seeds: **epistemic·C 93%** [77–98] (was 17%), **temporal·C 79%** [60–90] (was 25%). No
cell in C is now low enough to falsify a prediction against, so the registered claim above has no
target and is withdrawn rather than quietly re-scoped. The 0.9.3 C rows must not be cited.

A second finding independently limits the old prediction: C **cannot isolate recall at all** while
the quiz session holds remote world reads. `describe_box` reads a remote box without moving, so the
prompt-level "do not re-fly" rule does not bind — the recall arm scored 6/6 by re-surveying
(`describe_box` ×23 vs `mem_recall` ×2) and beat its own memory on `count`. A prompt cannot constrain
a tool capability.

**The replacement pre-registration lives in `OBSERVATION_MEMORY_DESIGN.md` §6**, committed
2026-07-27 before any implementation exists:

> sha256(§6, verbatim, 2284 bytes) = `1517b19de35f8e30b41136f50610fe79b9d9760f85fcd4b1176da5faa7044a39`

It targets a deficit this session *localised* rather than inferred: memory reliably retains "which
region / what kind" (`region` 100%, `anchor` 100%, `stale` 100%) and not exact values (`where` 57%,
`count` 57%) — because observations are **authored prose**, and the narration step loses the number
(the corpus recorded a 6-block cluster as "4-block"). The intervention is mechanical capture of tool
results; the prediction names both the cells that must move and the controls that must not.

### 6.2 Cycle 1 outcome, and the second registration (2026-07-29)

The §6.1 registration was measured 2026-07-28 (bench 0.9.7, `2026-07-28T03-01-32-mem-haiku`, 5
seeds): **FALSIFIED on its own condition** — capture verified present, `where`/`count` did not move
(paired p=1.000, zero discordant pairs on the prior-only change probes). Reported in full in
`OBSERVATION_MEMORY_STATUS.md`, including the scope limit found on review: `mem_changes` — the
designed mechanism — was called **zero times in 30 sessions**, so the null is honestly scoped to
"`mem_seen` did not improve priors", not "the captured layer cannot help". For Paper A this is the
loop's verify step killing a wrong prediction — the loop working, and reported as such.

**The successor pre-registration lives in `MEMORY_REDESIGN.md` §8**, committed 2026-07-29 before
any implementation exists. It re-frames the hypothesis as delivery-vs-representation (the annotate
appendix rides existing reads; discovery cost is zero by construction, so a free-choice arm finally
measures representation), encodes the 0.9.7 resolution lesson (paired tests on a shared corpus are
primary; absolute thresholds are secondary), and pre-commits that deep-dig tool uptake is not a
criterion:

> sha256(§8, verbatim from `## 8. PRE-REGISTRATION` to the last non-whitespace byte before `## 9`,
> 4351 bytes) = `6b1cbb27e5e033d193bc339941939f55fd3c25e6795970d722812ae90917de32`

## 7. Reproduction suite (construct validity + independent replication)

Conceptual reproductions — the bench recovers the *direction and mechanism* of a published effect
in a new environment; never "we reran their benchmark." Each is an arm; keep the list at six.

| # | published finding | source status | bench reproduction | status |
|---|---|---|---|---|
| R1 | clean symbolic observations don't fix spatial arithmetic (FLE Insight 2) | [verified] | Category T without-arm: 72%, coordinate thrash, 94–99 raw-read calls | **already run**; rerun at v1.0.0 |
| R2 | sequential-observation map integration fails at frontier (SPACE, IndustryNav) | [verified]/[checked] | Category A walk-then-quiz (a2/a5/a12/a13 integration questions) | exists; needs the topology-question analysis cut |
| R3 | format effects: ASCII-grid hazard at small scale, null at frontier (2502.16690, McMillan p=0.484) | [checked]/[unverified] | Category B json_coords vs palette_rows vs ascii_grid | exists; needs a second model for the frontier-null half |
| R4 | semantic labels are load-bearing; permutation degrades (FloorplanQA) | [checked] | NEW arm: opaque palette (`b1[s]`-style ids) vs `id[state]` on B/T rungs | **to build** (cheap shim view) |
| R5 | text beats pixels for spatial structure (maze 6%→80%; TeamCraft VLA) | [checked]/[verified] | NEW vision arm: screenshot-only perception on A-format questions | **to build**; needs client instance |
| R6 | a second routing level breaks accuracy (progressive disclosure, 2607.17598) | external | `MCPTK_MANIFEST=short` + tool_help arm with tool-call-coverage metric | planned anyway as TOOL_BILL L3 gate |

Selection rule: transferable *model-capability* findings only — no system-specific results (GITM
action-space gains etc.), and none of the four claims the survey refuted.

## 7b. Research direction — subjective quality: calibrate the proxy, never employ it

(Added 2026-07-25; NOT on the v1.0.0 critical path — post-freeze minor-version work.)

The no-LLM-judge rule (§3.2) governs *objective* truths. Subjective quality ("does this build look
nice?") has no server truth — its referent is the human view — so the layering is: **humans are
ground truth for taste; the VLM judge is the agent's internal calibrated instrument (Paper B P5);
the bench measures the instrument, never scores with it.** W-describe/W-picture (human-rated,
BENCH_EXPANSION.md) are the calibration apparatus. Three rungs:

1. **Calibration**: judge vs human rater agreement on OUR criteria (research open question 5;
   MineCLIP protocol — labeled sets, report F1). Gate: if agreement fails, the judge tool carries
   a failed-calibration label and P5 demotes.
2. **Judge-in-the-loop value**: build→judge→revise vs build-once, human ratings as endpoint,
   quality-per-token.
3. **Goodhart detection** — the novel one: when the judge sits inside the agent's feedback loop,
   the agent optimizes the proxy. The bench can quantify the divergence directly: human-rate
   judge-optimized vs judge-naive builds; proxy score inflating while human score doesn't =
   measured reward-hacking of an aesthetic proxy in a live environment. Only possible because
   truth stayed human and the judge stayed an instrument — the rule enables its own test.

## 8. Versioning & reproducibility (v1.0.0 policy)

- `testbench/version.mjs` is the single version constant; every runner stamps `bench_version` into
  its manifest.json beside the existing `git_head` / `tools_hash` / `questions_hash` /
  `toolkit_version`. (Shipped 2026-07-25 at 0.9.0 — pre-freeze.)
- **v1.0.0 = the freeze.** Tag criteria (execution plan: FREEZE_PLAN.md, gates G1–G6): registry +
  question sets + truths frozen; the adapter seam (BENCH_EXTERNALIZATION.md) in place; **the bench
  conformance ratchet green over all result dirs** (every row joins exactly one unit, every
  selected unit produced rows, no matcher overlap); **bench-report carries the full metric doctrine**
  (conf-wrong/abstain/turns/tokens-nc-wc/coverage, manifest-joined model_id + bench_version,
  discipline×cat and model×arm pivots) and reproduces the known pre-freeze tables; **statistics in
  the report** (Wilson CIs, paired arm-delta test, stated thresholds for the falsification
  condition, minimum-n policy reps≥3 × seeds≥2 for cited cells); every paper-cited table
  re-runnable from the tag. SemVer from then on: patch = harness fixes that cannot change scores;
  minor = new units/arms (additive); major = anything that invalidates cross-version comparison of
  an existing unit.
- Every number in either paper cites a run directory whose manifest carries bench_version 1.0.x.
  Numbers from pre-freeze runs (all of §5) are re-earned by the rerun matrix, not carried over.
- Repo split happens AT the freeze, not before (decision 2026-07-25): the bench extracts to its own
  repo/package when its contents stop moving; until then the seam is enforced in-tree.

## 9. v1.0.0 rerun matrix (the work queue)

Every table the paper will print, with what it needs. Union of this table and Paper B's §Runs is
the total v1.0.0 budget.

| paper table | cells | models | seeds/reps | exists pre-freeze? |
|---|---|---|---|---|
| headline: full bench, no ablation | all proven units | haiku + sonnet | ≥2 seeds × 3 reps | partial (haiku only, mixed versions) |
| T with/without (R1 + secondary hypothesis) | t1–t13 × 2 arms | haiku + sonnet | 2 × 3 | haiku yes (pre-freeze) |
| model axis vs toolset axis (secondary hypothesis) | same cells as above, pivoted | both | same runs | no — derived from the two rows above |
| L1 retest (check_path cell) | t4 × with | both | 2 × 3 | haiku, pre-freeze |
| L2 retest (swap arm) | r1,5,8,10,11 × with/swap | both | 2 × 3 | haiku, pre-freeze |
| discipline pivot + category split | full bench | both | as headline | 2026-07-25 run (haiku, pre-freeze) |
| prospective cycle pre/post | temporal+epistemic cells + spatial controls | haiku (+sonnet if budget) | 2 × 3 each side | no — §6 |
| R2 topology cut | Cat A integration questions | both | as headline | analysis only |
| R3 second model | Cat B formats | sonnet | 1 × 3 | no |
| R4 label permutation | B + t1/t10 opaque-palette arm | haiku | 2 × 3 | no (build arm first) |
| R5 vision arm | A-format questions, screenshot-only | haiku | 1 × 3 | no (build arm first; client) |
| R6 short-manifest arm | T std cells + coverage metric | haiku | 2 × 3 | no (build arm first) |

Budget triage if needed: R5 and the sonnet arm of the prospective cycle are the first cuts; the
secondary-hypothesis rows and L1/L2 retests are not cuttable — they carry the two hypotheses.

## 10. Open decisions

- Venue/genre: methods paper (how to build verifiable agent benches on live game servers), not
  leaderboard. Candidate venues TBD with Matthijs.
- Whether e_combat/e_traverse walker arms make the freeze (they also serve Paper B's repair thesis
  — shared budget row).
- Name the bench. "testbench" is a directory, not a citable artifact. Decide before the freeze; the
  repo split takes the name.

## 5b. The 2026-07-25/26 live loop — the workflow as it actually ran (appended 2026-07-26)

Seven runs in two days (pattern-search arc → surface merge; full ledger in
PATTERN_SEARCH_DESIGN.md §Results, SURFACE_MERGE_DESIGN.md). Written down while fresh because
the loop that actually ran differs from the idealized "bench → build → re-bench" in ways that
ARE the paper's argument. The naive phase model ("evaluate bench → build tools → accuracy up;
evaluate manifest → merge → efficiency up; improve bench → repeat") is right about intent but
wrong about the unit of evidence and the ordering. What actually happened:

**The loop, one iteration:**
1. **Hypothesize from design principles, pre-register the falsifier, build behind probes.**
   The pattern rung was checked against the collapse rule/tool bill/honesty contracts BEFORE
   code; the design doc named its own kill condition ("the middle-rung failure mode — a tool
   nobody calls — is what falsifies this") before run 1. Probes are the correctness gate and
   are deliberately NOT the bench: the bench never has to argue about whether the tool works.
2. **Bench with paired arms on truth-by-construction instances**, versions stamped
   (questions_hash / tools_hash / toolkit version) so every run stays comparable to its
   predecessor.
3. **Autopsy TRACES, not score tables.** This is the step the naive model misses entirely.
   Score deltas said "no difference, full arm slightly costlier"; the traces said: one session
   called `locate what:"minecraft:gold_block"`, was refused, and hand-rolled 21 blind reads.
   That single refused call — an n=1 trace event — produced the two highest-value changes of
   the arc (error-remedy 0.18.1, promotion 0.19.0). Symmetrically, ABSENCES are first-class
   evidence: zero pattern calls (run 2), zero find_site calls on its own home rung (run 5),
   dark check_fit — each absence became a routing intervention.
4. **Route every finding to exactly one of three sinks:**
   - **Instrument defect** → fix the bench, rerun before believing anything. Run 1's binding
     turn caps censored both accuracy AND cost and INVERTED the token verdict (306k/233k
     capped → 479k/564k uncapped — the concrete inversion example for §1's L1 claim); the
     t9/t10 and t4/t12 staging collisions would have corrupted any full-ladder run and were
     found only because scale-up forced them.
   - **Routing defect** (right instinct, wrong door) → error-text remedies, argument
     promotion, door merges per the collapse rule. NOT description growth (the bill taxes it)
     and NOT prompt hints (self-contained-descriptions doctrine + would teach to the test).
   - **Capability/task defect** → new rungs (t14–16 + xyz_oneof), task rebalance (t16 k
     seed-mix), or an accepted gap (volume stats).
5. **Deconfound before concluding.** The free-choice arm measures discovery×capability
   entangled; the forced-surface arm (swap) separated them — capability 100% @ 113k/correct
   while free-choice discovery sat at 2/12. Without the deconfounding arm the capability
   verdict was unreadable.
6. **Scale to generality last** (full ladder, 128 sessions), then loop: the manifest
   evaluation (which tools earned their slot) fed the merge, which is being benched as this is
   written.

**Corrections to the naive phase model, explicitly:** (a) accuracy and efficiency phases were
not separate — every intervention was a ROUTING change (which door the model finds), and
routing moves both axes at once; (b) instrument improvement was not a third phase but
interleaved — roughly half the iterations' findings were instrument defects, which is itself
evidence for the diagnostic-instrument hypothesis (§1): an instrument that cannot distinguish
budget exhaustion from inability, or corrupted staging from model error, returns INVERTED
verdicts, and we have the inversion on disk; (c) the driver alternated between bench-reads and
PRINCIPLED MANIFEST REVIEW (the operator interrogating each tool's keep-argument against the
collapse rule) — the bench then adjudicated proposals it did not generate. The bench was the
judge, the design principles were the generator, and the traces were the messenger between
them.

**Two headline regularities the arc adds to §5's episode list:** (1) for small models,
DISCOVERY, not capability, is the binding constraint on tool value, and it is fixed by door
placement (promotion: the universal `what`-instinct now lands on the scan; all 12 forced-arm
sessions entered through it), not by documentation; (2) reproducible confident-wrongs cluster
in raw-view extraction (the same describe_box-layers wrong cell three times across independent
runs) and never in reasoning over few clean referents — the representation claim, now with a
deterministic counterexample class.
