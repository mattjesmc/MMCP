# Gameplay ablation — does memory earn its complexity? (rev 2)

Design for MEMORY_DESIGN.md §Evaluation item 7 (build-order step 7). The storage and retrieval probes
prove the machinery is *correct*; this harness decides whether it is *worth having* — and, rev 2's
addition, *which layer* is worth having. Rev 2 follows external review (2026-07-19); what was
accepted and what was modified is recorded in §Provenance.

## Two questions, two tracks

**Track 1 — product (end-to-end).** Does the usable memory bundle improve the copilot? Conditions
A–D each run every episode independently. Formation differences between conditions (time spent
noting, compacting) are part of the treatment, not noise — this track measures the system as lived.

**Track 2 — mechanism (retrieval isolation).** Did `mem_recall` itself earn its complexity? Rev 1
could not answer this: C and D formed their own memories in E1, so a D–C difference could come from
different memory *formation*, not retrieval — comparing trajectories, not mechanisms. Fix: run E1
**once** under the C toolset, freeze and clone the memory dir, then fork **two fresh E2
conversations** from the identical world and identical corpus — one with C tools, one with D tools.
The only difference is `mem_recall`.

Constraint rev 2 adds beyond the review: the forked E2s share one world, and there is no
world-restore machinery (don't-build). **Track 2 is therefore restricted to scenarios whose E2 does
not mutate the world** — interrogation, plus the micro-ablation below. Mutating-E2 scenarios get
their C–D story from Track 1 plus the pipeline funnel (§Metrics), which localizes whether a failure
was formation or retrieval.

**Embedding micro-ablation (within Track 2).** D bundles structured + lexical + semantic retrieval;
a D win would not show the embedding layer contributed. Over the same cloned corpus: **D-exact**
(`MCPTK_EMBED_BACKEND=none` — structured+lexical) vs **D-hybrid** (+semantic), queried with
paraphrases having zero lexical overlap with the stored text (the live "food supply"→wheat-farm
check, made systematic). This alone decides whether local embeddings earn their maintenance and
latency. Never a fifth grid condition.

## Pre-registered decision rules — adjacent contrasts

Rev 1 compared D against everyone; a nested lattice deserves per-layer contrasts (D > B could hide
that C already provides nearly all the gain). Stated before any run; reported verbatim; a loss is a
finding to simplify by, not a bug to tune away.

1. **B > A** on resume speed and success where the task frame suffices (resume-build).
2. **C > B** once relevant facts have aged out of the verbatim tail (interrogation, long traversals).
3. **D ≥ C on accuracy AND D < C on retrieval cost** (tokens, tool calls, time-to-answer) for
   demoted details (interrogation, Track 2). C can drill manually via `mem_read`; D's claim is
   efficiency, not possibility — requiring higher success from D was rev 1's category error.
4. **D-hybrid > D-exact** only on conceptual queries with no lexical overlap; no regression on exact
   queries.
5. **C/D commit fewer `stale_action_error`s than A/B** (stale-fact).
6. **Economics: cost per successful task** — total tokens across all runs of a cell ÷ successes, so
   failures stay economically visible (rev 1's "on tasks B can also solve" selected the comparison
   set on the outcome — post-treatment selection). Also reported: median tokens/run, input/output
   split, memory-tool tokens, tool calls, wall clock. The 2× ceiling over B survives as an
   **engineering acceptance threshold**, labeled as such — not statistics.
7. **Safety:** the full system must not increase unintended world edits or stale actions.

## Conditions — nested lattice, one layer per step

Identical model, prompts, world, budgets; the ONLY axis is which mem_* tools exist and what the
session-open render contains. Condition-adjusted prompts mention only the tools that exist.

| | tools present | session-open render |
|---|---|---|
| **A amnesiac** | none | nothing |
| **B tail** | `mem_note`, `mem_recent`, `mem_task` | `[task]` + verbatim tail trimmed to budget **behind an explicit banner**: `tail truncated: N older entries omitted` — plus current tail token usage; no block summaries, no `compaction_due` |
| **C telescope** | B + `mem_write_block`, `mem_place`, `mem_verify`, `mem_read`, `mem_dismiss` | full telescope render |
| **D full** | C + `mem_recall` | full telescope render |

Rev 2 on B: rev 1 truncated silently, which sabotaged B epistemically — an honest scratchpad knows
it forgot and can act accordingly. B keeps the task frame: the fair cheap competitor is "a
scratchpad and a goal line", and beating a strawman proves nothing.

## Scenarios — seeded, episodic, mechanically assertable

A scenario = `{name, setup(bridge, params), episodes:[{prompt, maxTurns}], mutate?, assert}`.
`setup` builds a deterministic stage via `run_command` at parameterized coordinates; each episode is
a FRESH runner conversation; the memory dir persists across episodes within a run, destroyed between
runs. `assert` reads world/inventory/parsed answers — never an LLM judge.

1. **stash-and-retrieve** — two variants. *Fixed-site*: harness-stocked chests at undisclosed
   locations E1 must discover — isolates memory-assisted retrieval from site-selection variance.
   *Self-sited*: the agent collects, places, and sites its own chests (≥150 blocks apart) — the full
   product loop including self-authored memory. E2: "retrieve the iron you stored/found." Success:
   inventory assertion. **The staging corridor is force-loaded (chunk tickets)** so "memory failure"
   is never drone unload or unloaded-chunk behavior.
2. **resume-build** — E1: build spec given ONCE (detail such that half the structure doesn't imply
   the rest), generous turn cap. E2: "continue where you left off," spec never restated. Scored as
   **E2 delta toward spec from that run's own E1 endpoint** (paired within run); E1 endpoint quality
   reported alongside — C/D spending E1 turns on notes instead of blocks is part of their true cost,
   not noise to normalize away. The harness records whether the spec was actually stored (task
   frame / notes): separates formation failure from resume failure.
3. **stale-fact** — E1 observes a stocked chest and an intact bridge; harness `mutate` between
   episodes (chest moved, bridge broken); E2 needs both. Rev 1's detector scored any return to the
   old coordinates as an error — wrong: traveling to the remembered location to *look* is the
   rational use of stale memory. Rev 2 taxonomy:
   - `verification_attempt` — re-observed the subject before relying on it (good);
   - `stale_assumption` — stated a remembered fact as current, unqualified;
   - `stale_action_error` — consequential action premised on remembered state without re-observing
     the subject (stepping onto the remembered bridge uninspected; acting on remembered chest
     contents unopened);
   - `contradiction_recorded` — `mem_verify contradicted` written (achievable by C/D only).
   **Mutation hygiene:** mutate via privileged `run_command` (never enters pending candidates),
   outside the observer's event radius; before E2 the harness asserts no mutation trace is visible
   in `get_events` output or the pending queue.
4. **interrogation** — E2 is pure Q&A over E1's traversal: "where is X (coordinates)? how many Y?"
   Parsed answers vs planted ground truth; exact and ±2 scored separately. Construction guarantees,
   **asserted by the harness before E2**: each target fact is absent (verbatim) from the
   session-open render, present in a linked L0 record, and C and D fork from the same cloned corpus
   (this is the Track 2 scenario). Cheapest episodes, highest-purity signal for rules 2–4.

Sizing rule for 1 and 4: E1 must generate enough entries that B's tail overflows and C/D hit
`compaction_due` — the ablation is uninformative if every condition still sees everything.

## Metrics — from artifacts the runs already produce

Sources: API usage fields, the runner transcript, the memory files themselves. **Perception metrics
come from the runner transcript** — the mod's audit log covers world-edit/privileged calls only, so
the transcript preserves every call verbatim: args, response envelope, resolved
origin/coverage, game tick. It is the source of truth.

- `task_success` — scenario assertion (fractional only where the assertion is naturally fractional,
  e.g. blocks-matching-spec).
- **Targeted acquisition cost** — perception + navigation calls from episode open until the first
  correctly-targeted act (goto/observation within radius R of the true site). Replaces rev 1's
  `repeated_exploration`, which punished rational re-observation. Revisited-chunk coverage is still
  logged as a neutral descriptive series, uninterpreted.
- Stale-fact taxonomy (above).
- `exact_location_recall` — interrogation accuracy.
- `time_to_resume` — calls until the first goal-directed act; capped episodes score failure at max
  cost (getting lost is an outcome, not missing data).
- Economics per rule 6.
- **Memory-pipeline funnel, per planted fact**: observed → written → compacted → present in
  session render → recall called → returned by recall (with result rank + channel
  lexical/semantic) → used correctly. Localizes every failure: observation / formation / compaction
  / retrieval / planning — without it a failed run only says "D failed." Plus counters: mem_note
  calls, compactions and rejected attempts, recall calls and result tokens, session-open render
  tokens, unresolved pending candidates, embedding backfills.

## Variants, not repetitions

Three identical reps re-measure one scene's luck. Instead: **3 parameterized variants per scenario**
(coordinates, item identities, counts, build specs, mutation sites all vary), **1 run each** by
default — same grid size as rev 1; paired comparisons within variant; condition order rotated. A
second run per variant is added only where the pilot shows high within-variant variance, and only
for the contrasts it muddies. Frozen and logged per run: model id, sampling settings, system-prompt
hash, tool-manifest hash, mod commit, mcp-server commit, world seed, scenario params.

## Runner — deliberately the seed of companion mode

```
mcp-server/ablation/
  runner.mjs        headless tool loop: Anthropic SDK, bridge via POST /cmd, mem_* filtered by
                    condition, per-condition charter prompt, turn cap, verbatim transcript out
  scenarios/*.mjs   {name, setup, episodes, mutate?, assert} + per-scenario params generator
  clone.mjs         freeze/clone memory dirs for Track 2 forks
  run.mjs           CLI: --scenario --condition --variant [--fork] — one run; results.jsonl
  report.mjs        aggregate → the pre-registered rules as one table, per-variant rows verbatim
```

Agent under test: **Sonnet 5** — decided 2026-07-19 (cost; a weaker agent needs memory more,
sharpening the ablation). **Execution substrate (revised 2026-07-19): the Claude Agent SDK on the
principal's Max subscription — no Anthropic API key is available on this machine.** Consequences,
accepted: the agent runs on the Claude Code harness rather than a bare Messages loop; the harness
is IDENTICAL across all conditions, so every pre-registered contrast remains internally valid, but
absolute numbers are harness-inclusive (provenance notes this). The condition-filtered toolset is
served by `ablation/mcp-shim.mjs` (stdio MCP server: mem_* against the per-run memory dir, world
tools proxied to the bridge, B's truncation wrapper, verbatim tool transcript) with ALL built-in
Claude Code tools disabled. Economics stay token-denominated (usage is reported per episode);
dollar figures don't exist on subscription billing, and pilot pacing must respect Max usage windows.

The runner IS proto-companion-mode (charter as system prompt, headless, no call-level consent) —
step 8 starts from this file. It only ever drives a scratch world with `MCPTK_MEMORY_DIR` at
run-scoped scratch dirs; the authorization layer it lacks is step 8's problem, and nothing may leak
into the real world or store.

Hygiene: fixed world seed; weather/daylight locked in `setup`; drone at a fixed spawn per scenario;
per-variant coordinate offsets; per-run memory dir; serial execution.

## Pilot — 16 episodes, aimed at the fragile parts

Rev 1's pilot (A/B/D on stash + interrogation) skipped C — the condition the central D–C contrast
needs — and stale-fact, whose detector is the hardest to get right.

| scenario | conditions | validates |
|---|---|---|
| stash (fixed-site) | A, B, D | runner mechanics, end-to-end signal |
| interrogation | B, C, D | tail→telescope→retrieval separation + Track 2 fork + clone.mjs |
| stale-fact | C, D | mutation hygiene + error taxonomy |

Full grid only after pilot numbers price it: 4 conditions × 4 scenarios × 3 variants ≈ 48 runs,
~2 episodes each ≈ 96–110 episodes including Track 2 forks and the micro-ablation.

## Don't-build

| Rejected | Reason |
|----------|--------|
| LLM judge for success/staleness | Assertions on world state, inventory, parsed answers, transcript. Judges drift; probes don't. |
| World-restore machinery for Track 2 forks | Restrict Track 2 to non-mutating E2s instead; mutating scenarios get mechanism attribution from the funnel. |
| Fifth grid condition for embeddings | Cloned-store micro-ablation via `MCPTK_EMBED_BACKEND` answers it at a fraction of the cost. |
| General benchmark framework | Four scenarios, one report script. An experiment, not a product. |
| Parallel run orchestration | One drone, one world; cost is tokens, not wall clock. |
| Statistical machinery beyond paired per-variant comparisons | Honest claim at this n is "consistent direction across variants"; report rows verbatim. |
| Auto-tuning prompts per condition until D wins | Rules are pre-registered; tuning-to-verdict is the failure mode this doc exists to prevent. |

## Pilot results — COMPLETE (2026-07-19, 8 runs, Max substrate)

**stash-fixed v1 (A/B/D, abstracted perception):** all three answered perfectly (target + all
chests exact). The discriminator is acquisition cost: A re-searched the corridor (31 calls before
the correct goto, 852k tokens), B and D flew straight to the remembered chest (1 call; 228k / 305k
tokens). **Rule on end-to-end memory value: CONFIRMED — memory buys a 31→1 acquisition-cost drop
and ~3× total-token reduction on revisit tasks.** (Scored after fixing a harness bug: assert read
drone position post-despawn; rescore.mjs re-scored from transcripts, no re-runs.)

**stale-fact v1 (C/D):** both correctly detected the chest missing at its remembered position
(verification_attempt=true, stale_assumptions=0; C recorded `mem_verify contradicted` — D did not),
but both failed the task: neither hunted for the relocated chest, and both misread the broken
walkway from RAW get_blocks JSON — the 3-column gap at background-terrain height was invisible in a
truncated 3.7k-column dump. **Verification honesty: WORKING. Task failure was perception-encoding,
not memory** — which motivated the abstracted-view change (`view.mjs`, in the shim since; E2 prompt
now also says to track down relocated state). Rerun under the new encoding in the full grid.

**Pilot verdict: the harness works, the architecture shows value where predicted, and every failed
cell traced to a construction/encoding issue the pilot existed to catch — all fixed. GO for the
full grid** (with interrogation-v2 multi-block construction as the remaining precondition for
exercising rule 3).

## Pilot slice detail (interrogation v1, B/C/D-fork)

| cond | facts | outcome | e2 path |
|---|---|---|---|
| B | 2/4 | FAIL — early facts truncated off the tail; **honest nulls, no confabulation** (banner worked) |mem_recent, then null the unknowns |
| C | 4/4 | PASS — compaction fired in E1; demoted facts recovered | mem_read ×2 into the block |
| D (fork of C's corpus) | 4/4 | PASS — **mem_recall never called** | mem_read ×2, identical to C |

Read against the rules: **rule 2 (C > B after aging) CONFIRMED** in this paired variant. **Rule 3
(D vs C) NOT EXERCISED**: with a one-episode corpus (one block), the render's gloss identifies the
covering block directly, so mem_read is already the minimal path and recall adds nothing — D's
retrieval cost was ≈ C's (≈36k vs ≈35k input-side tokens in E2). Construction gap, pilot-caught:
discriminating D from C needs a MULTI-BLOCK corpus where the right block is not identifiable from
the render (multiple traversal episodes before interrogation, or cross-episode questions). Also
measured: E1 dominates cost (~4M input-side tokens/run; get_blocks payloads = 44% of context) —
post-slice lever: abstracted perception views at the shim (aligns with the phase-C input-channel
separation: perception is ephemeral, only descriptions persist).

## Full-grid readiness (2026-07-19, post-pilot build — all preconditions DONE)

- **interrogation-multi** — three patrol episodes (e1a/e1b/e1c) over three separated strips, six
  planted facts, cross-strip debrief. Builds the multi-block corpus that finally exercises rule 3;
  assert reports `retrieval_calls` (mem_recall vs mem_read) and a `multi_block` guarantee. Forkable.
- **resume-build** — non-inferable spec (4 distinct materials, asymmetric heights, 10 cells) given
  once; E1 capped at 12 turns BY DESIGN; scored as E2 delta from own E1 endpoint via harness
  `execute if block` checkpoints (live-verified: empty 0/10; 1-correct+1-wrong detected). Inventory
  seeded per episode via the new `prepare` hook; `spec_stored` diagnostic greps the memory corpus.
- **stash-self** — agent sites three marker blocks on a 220-block strip (markers, not chests: the
  mod has no bot-side chest deposit; the self-siting memory question is unchanged). Ground truth
  scanned from the world (`findMarkers`, live-verified exact); spacing compliance is a metric.
- Harness: per-episode `prepare` + `checkpoint` hooks, episodes map to asserts, rescore.mjs
  generalized. Tests 15/15; all stages dry-run against the live bridge.

**Full grid** = 4 conditions × {stash-fixed, stash-self, interrogation-multi, stale-fact,
resume-build} × 3 variants, plus interrogation-multi C→D forks (Track 2) and the embedding
micro-ablation. Run pacing against the Max window is the principal's call; per-run cost is far
below pilot-era numbers with the abstracted perception view.

## Embedding micro-ablation result (rule 4) — FAIL, honest and diagnosed (2026-07-19)

Over the three interrogation-multi C corpora (identical corpus, backend the only variable;
`micro-embed.mjs`, fully offline): exact queries hit 13/15 under BOTH backends (the lexical
channel does the work); concept paraphrases with zero lexical overlap hit **0/15 under both** —
the semantic channel returned nothing above the 0.30 threshold on any real corpus. Dissection
(`recall-cli.mjs` scores by following compaction links, so block generalization is not the cause):
MiniLM cosines between abstract paraphrases and the real block texts run 0.0–0.25; outcome-only
embedding texts were tested and do NOT fix it (0/15 at threshold; jargon/coordinate-dense short
texts sit far from abstract paraphrases in MiniLM space — the step-5 live hit was a semantically
tighter case). **Per pre-registration, the loss is a finding: local MiniLM embeddings do not earn
their maintenance on realistic corpora at this scale.** Candidate revisions recorded, not applied
(no tuning-to-verdict): stronger/asymmetric embedding model (bge-small, nomic), lower threshold
under exact-first ranking, or dropping the semantic channel (simplification). Decide at the next
memory-design revision with these numbers in hand.

Runner BUILT 2026-07-19 (`mcp-server/ablation/`): conditions lattice + B truncation banner,
per-condition charters, Sonnet 5 manual tool loop with verbatim transcripts, Track 2 `clone.mjs`,
metrics incl. per-fact funnel, three pilot scenarios, `run.mjs --dry` / `report.mjs`. Validated
without spend: harness unit tests 7/7 (`npm run test:ablation`), all three stages built live via
the bridge, stale-fact mutation verified (chest moved+stocked, walkway raycast = miss). Turn caps:
e1 30–45, e2 20–30; targeting radius 12; effort `medium` frozen (env-overridable, logged).

## Provenance

Rev 1: drafted 2026-07-19 from MEMORY_DESIGN.md §Evaluation item 7, after the task frame landed.
Rev 2: same day, after external review. **Accepted in full:** two-track split with cloned-corpus
retrieval isolation (the review's central correction — rev 1 compared trajectories, not mechanisms);
adjacent-contrast decision rules (rev 1's D-centric rules could not localize the winning layer);
D ≥ C accuracy / D < C cost framing; B's explicit truncation banner (silent truncation was epistemic
sabotage); stash fixed-site variant + force-loaded corridor; stale-fact taxonomy (rev 1's detector
punished rational verification); spec-stored diagnostic for resume-build; interrogation construction
guarantees; targeted-acquisition metric replacing repeated-exploration; memory-pipeline funnel;
embedding micro-ablation via backend toggle; cost-per-successful-task (rev 1's comparison set was
post-treatment selection); parameterized variants + frozen run config; pilot recomposed to cover C
and stale-fact. **Modified with reasons:** Track 2 restricted to non-mutating-E2 scenarios — the
review's clone covers memory but the forked E2s share one world, and world-restore machinery is
rejected; resume-build scored as delta-from-own-endpoint rather than the review's preferred
canonical-restore — restoring a structure the agent didn't build makes its memory describe a world
that changed, injecting staleness into a scenario that isn't testing staleness (canonical-checkpoint
comparison demoted to optional secondary analysis); variant scheme set to 3×1 rather than the
review's 3×2 — keeps the grid at rev-1 cost, with second runs added selectively where pilot variance
demands them.
