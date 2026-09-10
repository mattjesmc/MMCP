# Paper B (toolkit) — working draft & direction record

Status: DRAFT 2026-07-25. Working outline for the system paper: thesis, the four principles with
their receipts, section skeleton, claim→evidence→run mapping, and the runs Paper B still needs.
Companion: PAPER_BENCH.md (Paper A — the instrument this paper's evidence runs on; see its §2 for
the agreed claim split: A claims instrument validity, B claims design validity, same data never
carries the same claim twice).

Working title candidates:
- *The Game Is the Model: Building the Agent Interface at the Model Layer*
- *A Second View: an Agent Interface Designed for Model Cognition*
- *Answer-Shaped Tools: a Measured Design Doctrine for Embodied LLM Copilots*

## 1. Thesis

**The client is not the game — it is the interface Mojang designed for human cognition.** The
server holds the authoritative world model; the client is a projection built against human
strengths and limits (high-bandwidth vision, egocentric continuous control, poor recall of exact
coordinates). Agent stacks built on that channel — pixels, or protocol-level bots — inherit an
interface optimized for a reader the LLM is not, then spend their machinery (VLM grounding,
client-side physics re-implementation, mental map integration) compensating.

The toolkit's move: **build the analogous interface for model cognition** — a second view on the
same model layer, designed against the *measured* failure profile of LLMs (spatial arithmetic,
sequential-observation map integration, confident restatement of unqualified output) the way the
client is designed against the human one. In MVC terms: server = model, vanilla client = view for
humans, toolkit = view for models. Omniscience is then a non-issue: human-realism constraints are
properties of the human interface, not of the game ("label, don't enforce").

**The doctrine is routing, not prohibition** (thesis-level line, added 2026-07-25): no channel is
forbidden — every channel is *reserved for the question class whose referent it holds*. Symbolic
reads for facts about the world; renders for judgments about the view (P5 — "does it look nice" is
a question *about the human interface's output*, so pixels are its native domain, which is a far
stronger statement than a blanket pixel ban); raw reads for exact facts a session's role needs —
not deleted, just not shipped (P4 profiles). The failure the paper names is not "using pixels" but
*mis-routing*: deriving facts from the view, or taste from the block list.

Generalization claim (the paper must make it or reviewers will scope it to Minecraft): wherever an
authoritative substrate exists (DOM, OS accessibility tree, database, game server), building the
agent interface on the human-facing projection is a category error. Cross-domain evidence: OSWorld
a11y-tree ≈ 2× screenshot-only; the maze text-vs-image results; TeamCraft's own text ablation
beating its vision models. Minecraft is the unusually clean laboratory: substrate total, queries
cheap, ground truth absolute.

## 2. The four principles (each a section, each with receipts)

### P1 — Answer-shaped, not resolution-shaped

The documented LLM failure mode is not perception but spatial *computation* (FLE placement
failures with clean symbolic input; map-integration failures confirmed at 2026 frontier). So the
interface serves computed verdicts (`check_*`, `find_site`, `locate` relations) and treats
coordinates as handles to copy, never operands ("models do lookups at ceiling and arithmetic at
floor"). The empirical anchor is the **two-rung finding**: the resolution ladder's middle was never
climbed (get_blocks 0–3 calls per 32–60 sessions when predicates exist) because a model needs
either a computed answer over many cells or an exact fact about one — a surface grid is neither.
Action-side twin: the model states intent and policy (designation → profile → engage); loops with
crisp invariants run server-side (threat table, reflexes, goal loop).

Receipts: T with/without 94–100% vs ~72% at 39k vs 246k tokens; two-rung call-log evidence;
get_blocks_at 1 call/30ms/~241 tok vs 662 commands/33.6k tok confirming nothing; E-traverse goal
arm 51k vs 74k tokens at equal turns.

### P2 — Whole truths as an interface requirement

The consumer of a tool result is a language model that will *restate* it later, stripped of
hedges. The contract is therefore not "be accurate" but: **no truthful-sounding restatement of the
output may be false.** Coverage accounting that closes; tri-state verdicts (never a verdict over
unread space); typed negatives (`negative_is_proof`); freshness disclosure (`ticking:false`);
success computed from observed outcome, never intent (the 0.6.0 succeeds-falsely purge); failure
loci that name the remedy (obstruction + control, progress ledger). Motivating anecdote: agents
correctly *distrusted* confident-looking default terrain and burned 662 commands — dishonesty is
expensive even when detected. Measured payoff: the check_path episode — opaque truncated verdict
50% with confident-wrongs → tri-state + remedy 100% at 1/20th the tokens.

### P3 — Escalation lives server-side; the agent surface has one routing level

Scattered across the docs as separate decisions; the paper states it as one principle. Escalate
*effort and resolution inside the tool* (find_site's proxy-rank-then-exact-fit; the reach budget
ladder that raises effort but never relaxes the truth predicate; repair moving from greedy patch
to plan-driven search, 0.16.0). Escalate *authority only explicitly and audited* (observe never
generates terrain; simulation stays privileged; designation never implicitly enables engagement;
`may_modify` defaults none, every modification ledgered). And never make the model the escalation
router: a second agent-facing routing level measurably hurts (progressive-disclosure evidence;
locate's relations ride the payload for exactly this reason), and escalation-to-raw-data does not
substitute for answers (detail:full hatch failed to rescue the predicate-less arm on both axes).

### P4 — The economics of the tool surface

The static tool prefix is re-read every turn: 50–92% of the bill; a saved turn ≈ the whole
manifest (~18.7k tokens), so structural work outranks copy-editing and *turns are the currency*.

**P4 is regime-dependent, and the paper must say so.** Prefix cost grows linearly with turns;
accumulated-context cost grows ~quadratically (every result is re-read on every subsequent turn it
stays in context — the persistence-weighted metric). Measured: prefix share 92% at ~7 turns (P) →
50% at ~38 turns (C), falling further beyond. Consequences per regime: short sessions (copilot
quick tasks) are prefix-dominated — profiles and manifest structure are the levers; long sessions
(companion play) are persistence-dominated — the manifest lever fades relatively, the turn lever
*strengthens* (a late turn costs prefix + full context, so 18.7k is the lower bound on a saved
turn), and result-size hygiene dominates because a result's true cost is size × turns-it-remains.
In the long regime P4 therefore collapses into P1: answer-shaped verdicts win twice — fewer turns
AND smaller persistent payloads (a 5KB raw read emitted early is quadratically worse than a 500B
verdict). C's variable bill is ~49% memory reads — the long-session cost center is what
accumulates, not what ships. Caveat: compaction/summarization resets the accumulated term (a
sawtooth, amplitude set by result-size hygiene — the memory layer's compaction telescope is this
mechanism made deliberate; cf. OSWorld's "never carry screenshots forward, summarize immediately").
Missing measurement (add to §4 table): a long-session decomposition (companion soak or extended C)
to place the prefix/persistence crossover empirically instead of extrapolating from two points.
Consequences, all measured: profiles not deletions (hiding is free, collapsing is not; full/play
−27%/survey −57%); the collapse criterion (merge tools that compute the same relation with a
different unknown — `locate`'s two directions — never tools that answer different questions —
bot_act withdrawn); dark-in-bench ≠ useless-in-production (world_edit 0/6 dark because no bench
task edits); the locate swap 97%=97% at −5.5% real (never quote the 17.6% manifest headline).
Falsified sub-hypothesis reported as such: consolidation moved text instead of deleting it (+215
tokens), so the bot-surface case rests on turns, not prefix.

### P5 (candidate, added 2026-07-25) — The subjectivity boundary

Route every question by the kind of truth that answers it. Facts about the world resolve at the
model layer — never derived from pixels (P1). Judgments defined over human perception ("does this
look nice?") have **no model-layer truth**: their referent is the output of the *human* interface,
not the block list — beauty is a property of the view, and the view is the interface built for
human cognition (§1). So the agent reaches such judgments by reconstructing the human view (a
render) and consulting a **calibrated proxy for human judgment** (VLM judge), shipped as an
*internal tool* whose verdict is typed subjective and carries calibration provenance (judge model,
criteria version, measured human agreement) — the P2 contract extended to taste: a proxy verdict
must be unrestateable as fact. The evaluation-side corollary is Paper A's: **the oracle scores
facts; humans score taste; the judge is an instrument the agent may consult and the bench may only
calibrate, never employ.** This is why judge_build renders and `get_screen` does not (MCU: judge
strong on aesthetics, worst on GUI detail) — the one question class where pixels are the *correct*
channel is the class whose referent is the pixels. Slots into existing machinery: `perception_mode:
rendered` + a proxy label; the MineCLIP human-validation protocol already adopted.

Status: candidate principle — argued from the architecture, calibration unmeasured on our criteria
(open question 5). If the calibration ablation fails, P5 demotes to a design note.

## 3. Section skeleton

1. **Introduction + thesis** (§1). Stub: *"Every interface is designed against its reader's
   cognitive profile. Minecraft's client serves frames to human vision; we serve relations,
   verdicts, and handles to model cognition — and measure what that buys."*
2. **The failure profile of the reader** (lit): spatial arithmetic, map integration at frontier,
   ASCII/format hazards, text-beats-pixels, label semantics. (Cite only [verified]/[checked] tiers
   per RESEARCH_WORLD_REPRESENTATION.md; the unverified leads stay out or are marked as leads.)
3. **System**: bridge + tool registry; perception ladder (two rungs) + predicates + spatial
   inversion + locate/anchors; mechanism taxonomy (observe/embodied/world_edit/privileged) with
   dispatch-chokepoint enforcement; envelope + coverage contract; event/audit log; embodiment
   (actuator, possession, reflexes, goal loop); memory (typed, agent-side, not a world mirror).
4. **P1–P4** (§2), each closing with its bench evidence *via the Paper A loop* — the design was
   flagged, repaired, and re-verified, not argued.
5. **Negative results** (their own section, deliberately): consolidation break-even; surface view
   ~2% (and the crippled-arm artifact that produced the 84% projection); escalation-no-rescue;
   embeddings under the decoy veto; the repair loop's `repairs:0` caveat. The research process
   obeys the same no-confident-falsehoods contract as the tools — state the symmetry explicitly.
   **And carry the stronger form of that symmetry as an argument: the honesty constraints are
   generative, not a tax.** Three instances, one per level: dishonest output is *expensive even
   when detected* (agents distrusted default-terrain reads and burned 662 commands — the coverage
   contract paid for itself in tokens, check_path 100% at 1/20th the cost); server-verified truth
   is what makes the diagnostic loop possible at all (an LLM-judged bench could not attribute);
   human-truth-for-taste is what makes proxy-gaming *measurable* (P5/Goodhart — the rule enables
   its own test). Each constraint looked like a limitation and turned out to be the enabling
   condition of a capability the unconstrained design could not have.
6. **What the interface does not yet fix**: the discipline profile (temporal 38 / epistemic 25
   pending confound split) localizes the remaining deficit to integration-over-time; the same
   design move (compute the integration server-side) is the registered prediction of Paper A's
   prospective cycle. Future work that derives itself from the instrument.
7. **Related work**: FLE (closest cousin — typed API, no embodiment/honesty contracts/economics);
   AriGraph (its own graph ≤ oracle numbers back game-as-model); Voyager/GITM/JARVIS-1/Optimus-1
   (the pixel/human-realism design point, deliberately not imported); TeamCraft/MineDojo
   (corroborating ablations + the field's revealed migration to live-server architectures);
   mineflayer (API vocabulary imported, substrate rejected: version ceiling, client-side physics).
8. **Limitations**: single environment; internal ablations only (no same-world external stack —
   honest scoping, same as Paper A); model coverage; several design decisions shipped ahead of
   their bench gate (marked in the docs; the paper marks them too).

## 4. Claim → evidence → run mapping

| claim | evidence (pre-freeze) | v1.0.0 run needed |
|---|---|---|
| P1 headline: predicates beat raw reads on accuracy AND cost | T with/without, haiku (94–100% / 39k vs 72% / 246k) | rerun both arms, haiku + sonnet (shared with Paper A matrix) |
| P1 two-rung: middle tier unused in production | call logs, 3 runs (0–3 get_blocks / 32–60 sessions) | derived from headline reruns — analysis only |
| P2 tri-state pays on both axes | L1 episode (50%→100% at 1/20 tokens) | L1 retest row (Paper A matrix) |
| P2 verified act verdicts | act-honesty probe suite (functional, not comparative) | optional: a small confident-wrong count on E cells pre/post 0.6.0 is NOT reconstructible — state as design + probe, no retro bench claim |
| P3 one routing level | locate-in-payload design + progressive-disclosure external + R6 arm | R6 short-manifest arm (Paper A matrix) |
| P3 escalation-no-rescue | detail:full second run (without-surface 66% / 4.37M) | rerun the 4-arm view bench once at v1.0.0, haiku |
| P4 prefix dominance 50–92% | tool-cacheread decomposition over C/P/T | recompute over v1.0.0 runs (T needs its sdk log — now recorded) |
| P4 regime dependence: prefix share falls with session length; long sessions are persistence-dominated | two points only (92% @ ~7 turns, 50% @ ~38) | long-session decomposition (companion soak or extended C, ≥100 turns) to place the crossover + verify the quadratic persistence term |
| P4 locate swap −5.5% real | 6c run 2026-07-24T18-03-57 | L2 retest row (Paper A matrix) |
| P4 profiles | priced table + profiles probe; survey benched, play reasoned | the play/combat profile arm (Category P/E with `play`) — the one TOOL_BILL names as the missing measurement |
| goal-shape saves tokens (P1 action-side) | E-traverse 51k vs 74k, n=1 seed, repairs:0 | E-traverse goal/predict, 3 seeds; PLUS the possessed-walker course with may_modify — or the repair claim stays out of the paper |
| discipline deficit → future work | 2026-07-25 pivot | confound split + Paper A prospective cycle (shared) |

## 5. Runs Paper B needs that Paper A's matrix doesn't already carry

1. **Play-profile arm** (P/E under `MCPTK_PROFILE=play`) — closes the last unpriced profile claim.
2. **Walker repair traverse** (possessed walker, may_modify on, gap/door courses) — the repair
   thesis is currently `repairs:0`; without this run the claim is cut from the paper, per the
   BOT_SURFACE §5.6 honesty rule.
3. **4-arm view bench rerun** (raw/surface × with/without) once, at the tag.
4. E-traverse at 3 seeds (turn deltas of ±1 are noise at n=1).

Everything else rides Paper A's §9 matrix. Budget note: models — haiku + sonnet on shared rows;
sonnet-only where a frontier-null claim needs it (R3).

## 6. Open decisions

- Which title/framing: "game as model" (thesis-led) vs "answer-shaped tools" (doctrine-led).
  Current lean: thesis-led intro, doctrine-led section structure (P1–P4 carry the paper).
- Whether judge_build / the VLM-judge rung (shipped, §4 unscripted) appears at all — it is the one
  place pixels enter; probably one paragraph in §3 with the MCU evidence, no claims.
- Authorship/venue with Matthijs.
