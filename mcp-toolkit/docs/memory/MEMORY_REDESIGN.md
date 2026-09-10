# Memory redesign — memory rides the reads

Status: DESIGNED 2026-07-29 (Matthijs' direction, this session's synthesis). Supersedes the QUERY
half of `OBSERVATION_MEMORY_DESIGN.md` (§7 step 3's three tools) and the retrieval-tool list of
`MEMORY_DESIGN.md`; the observation STORE (§3, §3.1, §3.2 of the observation design) and the
authored layer's write path survive and are load-bearing here. Contains a **pre-registered
prediction** (§8) in the FREEZE_PLAN G5 discipline: committed before any code exists, hashed into
`PAPER_BENCH.md` before implementation begins, not edited afterwards.

---

## 1. The evidence this design is built from

All of it is our own bench data, not taste:

- **Discovery is the bottleneck, not capability.** The three obs tools took **5.9%** of
  retrieval/read traffic (14 calls vs 225 to `describe_box`/`get_blocks_at`/`mem_recall`/`mem_read`);
  `mem_changes` — the tool built for precisely the discriminating question — was called **zero times
  in 30 sessions, including the arm explicitly instructed to use the surface**
  (`2026-07-28T03-01-32-mem-haiku`, bench 0.9.7). PATTERN_SEARCH_DESIGN finding #1, reproduced at
  bench scale for the second time.
- **`locate` succeeded for the opposite reason**: the `what:<id>` instinct routed to it by name,
  unprompted (ARCHITECTURE.md, 0.8.0 bench evidence). Tools agents already reach for get used; tools
  they must remember exist do not.
- **The captured store itself works.** Capture round-trips; storage scales with change, not with
  looking (one record for three re-reads of an unchanged cell; 6.5 KB for a full three-session
  explore pass); provenance labelling is honest. The §6 falsification of the observation design was
  a null about *`mem_seen` as a separate tool* — the designed mechanism (`mem_changes`) never
  executed, so the representation was never actually tested under delivery.
- **The authored layer earned its keep.** 14/15 on prior-only change probes from authored notes
  alone. The write path is not the problem; the read path is.

**The principle that falls out: stop building doors the agent must find; put memory inside the
doors it already walks through.** A remembered answer must arrive on the read the agent was already
making, or — the evidence says — it does not arrive at all.

## 2. The three layers

### 2.1 Capture (exists — keep)

`memory/capture.mjs` + `memory/observations.mjs`, unchanged in role: every captured world read
propagates into the per-world observation store; supersession by cell; unknown never indexes as a
fact. One addition: wire the **`raycast_fan` extractor** (currently on `UNCAPTURED_WORLD_READS` as
"not wired yet") — per-ray block hits are the same shape as single `raycast` hits.

This store IS the "second save of observed blocks": cell-addressable, box-addressable,
dimension-aware, every tool read propagates in. It is not rebuilt in a chunk format, because a save
format cannot carry "observed at tick T by tool X", and staleness-as-representation is what makes a
remembered answer honest (§3.2 of the observation design).

### 2.2 Annotate (new — the heart of this design)

The capture hook already intercepts every captured read with the result in hand. The same hook
grows a second job: **compare before recording, and append a labelled `remembered` section to the
tool response** when memory has something the live result does not. One mechanism, uniform across
every captured read — `get_blocks_at`, `describe_box`, `get_surface`, `locate`, `raycast`,
`raycast_fan` — because the extractors already normalize cells. It must ride ALL of them from day
one: the traffic is in `get_blocks_at`/`describe_box` (225 calls in the 0.9.7 run), and an annexe
on `locate` alone would repeat the discovery failure one door over.

What the appendix says, by case:

- **Unread cells** (`-1` palette rows, unloaded columns): the `-1` convention stays untouched in the
  live payload — never blend — plus, per remembered cell:
  *"remembered: minecraft:gold_block, seen 2h ago @tick N — NOT a live read"*.
- **A read that differs from the agent's last-deliberate observation** (§2.3):
  *"CHANGED since you last looked: was chest (your read, 3h ago), now air"* — and capture
  supersedes as it already does. **This is the replacement for `mem_changes`: change detection
  becomes a push, not a pull.** The agent never has to know to ask; the delta arrives on the read
  it was already making.
- **`locate what:` with few or no live hits**: a labelled remembered section —
  *"no live matches; remembered: chest ×3 near (120,64,-40), 2h ago, +4 more sites"* — or, in one
  truthful sentence, *"…and nothing in memory either."* Remembered hits are positions + age. They
  are **not** counted in `found`, **not** given handles, **not** entered into the referent ledger
  (v1 decision: a handle implies re-resolvable-now; a stale site should be walked to and looked at).
- **Silence on agreement.** When the live read matches memory, the appendix says nothing — no news
  costs no bytes. Freshness confirmation on demand belongs to `mem_recall`.

Guardrails, carried from the 0.6.0 succeeds-falsely purge and §4 of the observation design:
remembered content is a separate, labelled, tick-stamped section; it is never merged into the live
result set; a caller can always tell "I can see this now" from "I saw this once". The appendix
NEVER blocks or mutates the live payload — annotate failure degrades to the plain result plus a
loud stderr line, exactly like capture failure.

Aggregate-only reads (`describe_box` summary detail, `get_surface` summary) get cell-level deltas
only where cell values exist (anomaly columns, complete-scan implied air); diffing aggregates
against aggregates is deferred (§7). `UNANNOTATED_CASES` names every deliberate gap, the same
anti-silent-narrowing ledger pattern as `UNCAPTURED_WORLD_READS`, with the same test: a captured
read absent from both the annotate path and the ledger is a declaration gap.

`MCPTK_OBS_ANNOTATE=off` disables the appendix (capture keeps running) — the ablation arm §8 needs.

### 2.3 Channels: deliberate vs ambient — the comparand fix

"Changed since the store last saw it" and "changed since the AGENT last saw it" are different
ticks, and the delta the agent cares about is the second. The store's supersession tick stops being
a proxy for agent knowledge the moment any observation enters the store without passing through a
context window. This is not hypothetical-future: **two concurrent sessions already produce it**
(session B's read supersedes; session A's next read agrees with the store; A's delta is eaten).
Ambient capture (auto-rayfan, §7) would merely make it universal.

So observations carry a **channel**:

- **`deliberate`** — a read whose result was served into an agent's context. All of today's capture.
- **`ambient`** — a sensor writing without anyone reading the result (auto-rayfan when it lands;
  none exist yet).

Per cell, the derived model keeps **current** (freshest, either channel) plus **last-deliberate**
(value + tick). The on-read delta compares live against **last-deliberate** — "since you last
looked" keeps meaning exactly what it says. Ambient data then *enriches* the delta rather than
eating it, because the annotation can date the change: *"changed since you last looked (was chest,
your read 3h ago); ambient scan saw it gone ~40m ago."* Strictly better than a deliberate-only
store could say.

**Disclosure is per-agent (per-world), not per-session.** All sessions share one authored memory
and are treated as one continuous agent everywhere else in the architecture; the deliberate channel
follows the same doctrine. A concurrent session's read updates last-deliberate for everyone. That
is a decision, not an oversight: per-session disclosure cursors are exactly the unbounded
bookkeeping this redesign exists to avoid, and the shared-memory model already tells sessions they
are one agent.

### 2.4 The unseen-changes ledger and the digest

The push has a second prong. When any observation (ambient, or another session's deliberate read)
supersedes a cell whose last-deliberate value differs, that is a **detected-but-untold change**. It
enters a small per-world **unseen-changes ledger**, which `mem_recent` and the session-open render
surface as a digest: *"while you were away: wool tower at (x,y,z) gone; 2 cells changed at the
farm."*

Bounded by construction — only cells with a last-deliberate value can enter — and self-clearing:
disclosing a change updates last-deliberate (a digest render is itself a disclosure; an on-read
delta is too, because the read it rides becomes the new last-deliberate), which removes the entry.
No importance classifier: entry is mechanical (value differs from last-deliberate), and the noise
rule for ambient churn is explicitly deferred until ambient capture exists (§7).

So change detection is: **deltas on the reads you were already making, and a digest for the cells
you would have no reason to re-read.** Both push. Nothing to discover.

## 3. The tool surface after

13 memory tools become 8. The three that mattered most stop existing as tools and become
properties of reads.

| tool | fate |
|---|---|
| `mem_seen` | **DELETED** — point mode → the annotate appendix; box mode → `mem_recall` |
| `mem_changes` | **DELETED** — becomes the on-read delta + the digest (§2.2, §2.4) |
| `mem_last_seen` | **DELETED** — becomes `locate what:`'s remembered section |
| `mem_locate` | **DELETED** — folds into `locate what:` fallthrough (below) |
| `mem_verify` | **DELETED** — freshness is derived from capture (below) |
| `mem_read` | **MERGED** into `mem_recall` (`ids` param, same by-id drill-down render) |
| `mem_recall` | **STAYS, unified** — the one "ask memory directly" tool, over BOTH stores |
| `mem_recent` | stays — session-open telescope + compaction driver + the digest (§2.4) |
| `mem_note` | stays — interpretation, rare and high-value |
| `mem_write_block` | stays |
| `mem_place` | stays |
| `mem_task` | stays |
| `mem_dismiss` | stays (pending surface unchanged) |

**`locate what:` fallthrough** (server-side, in the proxy path — the mod is untouched): a `what`
that resolves against no registry (structure, POI, entity, block) no longer dead-ends; it falls
through to a concept search over authored places, notes and episode blocks plus captured sweep
sightings — `mem_locate`'s job, answered per-dimension/region with staleness, labelled remembered.
"Where's the wheat farm" and "where's gold_block" are finally one vocabulary, which was
PATTERN_SEARCH's original point. The absent-concept-says-absent rule carries: no nearest-match
guessing.

**`mem_recall` unified**: structured filters (query words, center+radius, box, tick range, ids)
over authored records AND captured observations in one render — authored episodes clustered as
today, captured cells as per-id counts + bounding boxes (absorbing `mem_seen`'s box answer).
Remembered-vs-live labelling as everywhere.

**Derived freshness replaces `mem_verify`**: capture mechanically re-confirms cells, so a place's
render can say *"cells at this place re-observed 40m ago, unchanged"* — a better signal than an
authored verification stamp, and free. The interpretive remainder ("the farm is conceptually
gone") is a `mem_note`. The authored verification relations already in stores remain readable;
no migration deletes data.

## 4. History stays bounded

At the file layer, `observations.jsonl` stays append-only (crash-safe, simple, already proven
compact). At the derived layer, per cell: **current + last-deliberate + one previous value**. The
deep per-cell change chain is dropped from the model — nothing ever queried it (`mem_changes`: 0
calls; FREEZE_PLAN D3's diff query is dead), and the on-read delta plus the ledger need exactly one
step of history. If a store's file grows pathological, compaction-on-load rewrites it to the
derived model; not built until observed to be needed.

## 5. Decisions taken (recorded so they are not re-litigated silently)

1. **No handles / referent-ledger entries for remembered hits** (v1). Walk there and look.
2. **Silent on agreement** — the appendix speaks only when memory disagrees with, or extends, the
   live read.
3. **`mem_verify` dies**; freshness derives from capture.
4. **Disclosure is per-agent, not per-session** (§2.3).
5. **History is bounded** to current + last-deliberate + one previous (§4).
6. **Annotate rides every captured read from day one**, not `locate` alone (§2.2).
7. **The mod is untouched**; annotate, fallthrough and consolidation are all mcp-server side.

## 6. What this deletes from the plans

- FREEZE_PLAN D3's remaining scope ("expose the diff query") — superseded by the on-read delta and
  the digest; there is no pull-diff tool to expose.
- The observation design's §7 step 3 surface — replaced by §2.2/§3 here. Its §6 pre-registration is
  history and stays byte-identical; its result (falsified, with the mem_changes-never-ran scope
  limit) is what this design answers.

## 7. Deferred, explicitly

- **Ambient auto-rayfan.** Its own flagged experiment (`MCPTK_OBS_AMBIENT`, name reserved), with
  its own measurement, after this redesign is measured. The channel split (§2.3) and the ledger
  (§2.4) are built ambient-ready so landing it later changes no semantics. Before it lands, the
  ledger needs a hardcoded churn rule (rules only, no classifier — e.g. state-only changes on an
  unchanged block id do not ledger, plus a per-region cap), tuned against observed churn rates, not
  guessed now.
- **Aggregate-vs-aggregate diffs** for summary-detail reads ("this box's material counts moved").
  Cell-level only in v1; every deferral is named in `UNANNOTATED_CASES`.
- **Handles for remembered hits** — revisit only if agents demonstrably retype remembered
  coordinates into follow-up calls at a rate that costs more than the guardrail protects.

---

## 8. PRE-REGISTRATION (FREEZE_PLAN G5 discipline)

**Committed 2026-07-29, before any implementation of §2–§4 exists. Verbatim; not to be edited
after this commit; sha256 of this section to be recorded in `PAPER_BENCH.md` before implementation
begins. Falsification is reported whatever the outcome.**

**Hypothesis.** The observation-memory null of 2026-07-28 (bench 0.9.7) was a DELIVERY failure,
not a representation failure: the captured layer's value was unreachable because it sat behind
tools agents do not discover. Routing the same representation through the reads agents already
make (the annotate appendix, §2.2–§2.4) will cause the change-detection mechanism to execute under
free choice and to carry answer-relevant priors, at bounded token cost.

**Lesson encoded from 0.9.7**: at n≈5 seeds, absolute thresholds sit below the instrument's
resolution (a perfect 5/5 is consistent with 57%). **Paired comparisons on a shared frozen corpus
are the primary criteria throughout**; absolute floors are secondary and read against the
prior-observability column (answerable probes only).

**Arms.** New conditions, added alongside the existing lattice (a–f byte-identical, baselines
preserved): **g** = the redesigned 8-tool surface + `locate` in the world tools + annotate ON;
**h** = byte-identical tools to g, `MCPTK_OBS_ANNOTATE=off`. For the representation-isolation
pair: **i** = world reads only (no authored-memory read tools) + annotate ON; **j** = byte-identical
to i, annotate OFF. No arm's prompt steers toward the appendix — there is nothing to steer toward;
the appendix arrives unbidden. The change rung is re-staged with the `chg_vanished` tower replaced
by a flat cluster (the 0.9.7 staging defect, fixed at this comparability boundary); rung version
bumps.

**Predictions.** Measured at ≥5 seeds, haiku, change + recall workflows:

1. **MECHANISM EXECUTES under free choice.** ≥80% of g change-workflow sessions are SERVED at
   least one remembered-delta annotation (structural count, server-side) — against `mem_changes`'
   0/30 under explicit instruction. This is a claim about delivery, not accuracy.
2. **REPRESENTATION carries priors when delivered.** On the change rung's prior-only probes
   (answerable per the observability column), **i beats j** — paired sign test p<.05 over the
   shared corpus. Secondary: i ≥60% absolute on answerable prior-only probes; j is expected near
   floor (it has no memory surface at all — its score IS the guessing floor, measured not assumed).
3. **NO REGRESSION from the consolidation.** Paired g vs h across recall-workflow units
   (`anchor`/`region`/`stale`/`where`/`count`/`breadth`): no unit differs (sign test p<.05 in
   either direction). g vs the 0.9.7 `full` arm is REPORTED but is a comparability boundary
   (different tool surface), not a criterion.
4. **COST.** g's quiz output tokens ≤ h + 10%, paired per seed/workflow (silence-on-agreement is
   the mechanism; if the appendix chatters on unchanged worlds, this bound catches it).
5. **DEEP-DIG UPTAKE IS NOT A CRITERION.** `mem_recall` call counts are reported, and a low number
   is a design success (the appendix answered first), not a failure. Pre-committing this so the
   5.9% class of number cannot be read against the design later.

**What falsifies the hypothesis.** Any of: prediction 1 fails (annotations demonstrably not served
on the reads made — a build defect, reported as such); annotations verified served but i does not
beat j (delivery was not the bottleneck — the representation itself does not help, and the 0.9.7
null generalizes); prediction 4's bound breaks (the appendix buys accuracy with context, the §6.5
failure mode of the prior design); prediction 3 regresses (the consolidation broke what worked).

**Pre-committed caveats.** The change rung's absolute level is read against answerable probes
(observability column), as established 2026-07-28. If the re-staged rung shifts difficulty, the
paired i-vs-j and g-vs-h comparisons within this run remain valid; cross-version absolute
comparisons to 0.9.7 are reported with the boundary flagged. n≈5 per-unit cells cannot support
absolute-threshold verdicts; where predictions 2's secondary floor and the paired primary
disagree, the paired result is the verdict and the disagreement is reported.

---

## 9. Build order

Pre-register first: record §8's sha256 in `PAPER_BENCH.md`, then build.

1. **Store: channel + bounds** (`observations.mjs`). `channel: deliberate|ambient` on records
   (default deliberate; nothing writes ambient yet); derived per-cell model → current +
   last-deliberate + one previous; the unseen-changes ledger + its self-clearing disclosure rule.
   Probes extend `observations.test.mjs`.
2. **Annotate** (`capture.mjs` grows the compare-before-record path + appendix injection; or a
   sibling `annotate.mjs` sharing the extractors). All captured reads; `UNANNOTATED_CASES` ledger +
   coverage test; `MCPTK_OBS_ANNOTATE` flag; never blocks the live payload. Probes: a new
   `annotate.test.mjs` — synthetic streams asserting delta/remembered/silent cases per tool.
3. **Consolidation** (`tools.mjs`, `obs-tools.mjs` deleted into it; `local/registry.mjs`).
   `mem_recall` unified (ids, box, both stores); `locate what:` fallthrough in the proxy path;
   derived freshness in place/recall renders; delete the five tools per §3's table. The charter
   text describing the old regime updates in the same change (open question 4 of the status doc).
4. **Digest** (`mem_recent` + session-open render read the ledger; disclosure clears).
5. **Wire `raycast_fan` extractor** (small; rides on 2).
6. **Bench**: conditions g/h/i/j; `locate` into the arm tool lists (also resolving the 0.9.7
   scope note that `mem_last_seen`'s framing referenced an absent tool); re-staged change rung
   (new version); ratchet green; then the §8 run:
   `--arch <g,h,i,j> --workflow change,recall --seeds 5`.
7. **Measure against §8. Report every prediction, including the ones that fail.**

Versioning: mcp-server minor bump at step 3 (tool surface change), bench minor bump at step 6
(new conditions + rung version). Nothing here blocks the v1.0.0 instrument freeze; as before,
freeze the instrument, then measure this as the intervention.

## 10. Provenance

Direction and the two seed ideas (memory results riding `locate`; the observed-blocks "second
save") proposed by Matthijs, 2026-07-29. Synthesis, channel split (deliberate/ambient,
last-deliberate comparand — prompted by Matthijs' observation that ambient capture breaks a
store-tick delta), ledger/digest, consolidation table and §8 by this session. Evidence:
`2026-07-28T03-01-32-mem-haiku` (bench 0.9.7, §7 step 5 measurement + scope limits),
OBSERVATION_MEMORY_STATUS.md, PATTERN_SEARCH_DESIGN.md finding #1, ARCHITECTURE.md (0.6.0
succeeds-falsely doctrine; locate 0.8.0; the world-mirror rejection and its ledger boundary).

---

# Addendum (2026-07-29, same day, after §8 was hashed): cycles 3 and 4

Sections 11–12 were added AFTER §8's sha256 was recorded in `PAPER_BENCH.md`. They do not modify
§§1–9 and are deliberately OUTSIDE the committed pre-registration: each is its own later cycle with
its own (not yet committed) pre-registration. §8's byte range and hash are unaffected.

## 11. The authored layer — cycle 3 (write-path redesign)

### 11.1 The evidence

Usage counts from the bench corpora (0.9.7 run `2026-07-28T03-01-32` and the 7-seed 0.9.5 corpus):

- **`mem_verify`: 1 call across every result directory ever recorded.** Dead. §3's deletion is
  confirmed by data, not just by argument.
- **`mem_dismiss`: 16/13 calls, every sampled call sweeping `action_outcome` spam** (`rule:
  "action_outcome"`, batches of goto-mechanics event ids). The pending surface's traffic is a chore
  tax, not memory formation.
- **`mem_write_block`: 24/14 calls, all `compaction_due`-nag-driven**, per the charter's "act on it
  before continuing the task".
- **`mem_place`: 8/0 — nearly dark**, despite places being the concept layer `locate what:` is
  about to search.
- **`mem_note`: 119/78 calls — dominant, and the texts are the §1 failure verbatim.** Sampled from
  seed1's explore sessions: *"base 35 cobblestone blocks at y=200 (5×1×7 area); topped with 6
  emerald blocks at y=201 (2×1×3 center structure)"* — essentially every explore note is a
  transcription of a `describe_box`/`get_blocks_at` result into prose. This is the exact channel
  that produced the emerald 4-vs-6 `confident_wrong`: the agent as a lossy copy machine between two
  stores that can be joined mechanically. (Caveat, stated: the scenario is a survey task, so
  fact-heavy notes are partly scenario-shaped — but the charter is what instructs observation
  narration, and the hazard is documented, so the fix stands.)

### 11.2 The changes

1. **The render-time join — the authored counterpart of the annotate appendix.** Notes stop
   carrying values; a note is pure interpretation (*"R1-W2: construction platform, gold cluster on
   top"*). `mem_recall` and `mem_recent` join authored records with the captured layer **by
   position at render time**: the note renders with *"[captured here: gold_block ×4 at (…), last
   confirmed 2h ago]"*. The number the agent reads back is always capture's number, never the
   note's paraphrase — the transcription-error class becomes structurally impossible because the
   transcription step no longer exists. The charter is rewritten to match: **never write down what
   a tool returned — capture holds it verbatim; note what it means.** Expected side effect: explore
   note volume (and its tokens) drops sharply.
2. **Pending goes on a diet.** Rules shrink to: failures (`action_failed`,
   `failed_authority_call`), death/`drone_lost`, `event_gap`, and user "remember this". The
   `world_edit` rule is deleted — capture records the resulting cells and the event log keeps
   provenance, so the candidate duplicates two other stores. Candidates un-acted-on after N renders
   expire with an explicit *"expired unacknowledged"* line (bounded nagging, honest rather than
   silent). `mem_dismiss` stays, but its traffic should approach zero; today it is a chore tax.
3. **Compaction moves to session boundaries.** The `compaction_due` nag fires at natural seams —
   `mem_task clear`, session open (in `mem_recent`'s first render), not mid-task; the charter's
   "before continuing the task" clause is deleted. With interpretation-only notes, L0 volume drops
   and most of the pressure evaporates anyway. Same telescope, same mechanism, calmer cadence.
   While in there: fix the known placeless-note defect (`writeBlock` derives null bounds when no
   child carries a position) so the one structurally unfollowable nag dies (MEMORY_DESIGN
   §"Memory scope", live bug).
4. **`mem_place` rides locate.** `locate ... as:"lookout_tree" persist:true` promotes the named
   find to a durable place on the read that discovered it. `mem_place` stays for offline/manual
   promotion but stops being the only door. (Places matter more under §3's fallthrough; promotion
   being a separate deliberate act is why the tool is dark.)
5. **`mem_task` and `mem_recent` are left alone** — both used, both cheap, and `mem_recent`
   already gains the digest (§2.4).

### 11.3 Sequencing — why this is NOT in the §8 cycle

The charter rewrite changes what authored memory retains, which is exactly the control-arm floor §8
measures against (the `full`/`h` arms answer change probes from authored notes). Folding cycle 3
into the §8 build would confound the annotate measurement with the write-path change. So: run the
§8 cycle with the charter and write path untouched; then land cycle 3 with its own small
pre-registration, committed before its build, predicting roughly: transcription-shaped notes →
near zero; `where`/`count` held BY THE JOIN (not by narration) — no accuracy loss; explore-session
tokens down; `mem_dismiss` traffic → near zero. Exact thresholds are set when that registration is
written, not here.

## 12. The legal profile — cycle 4: locate answers only from memory

Matthijs' framing: for the non-cheating player profile, `locate` must answer only from what has
been SEEN — only observed blocks/objects are known.

### 12.1 Same tool, profile-gated

The precedent is `bot_profile {perception: authoritative|perceived}`, which already makes
`threats_nearby`/`flee` read the Perception belief store instead of ground truth. The legal locate
is the block-world half of the same idea: under the legal profile, `locate what:` does not run the
authoritative registry/pattern scan; it searches the **observation store**. The tool keeps its name
and schema — the name-routing instinct is the benched success this whole redesign leans on — and
swaps its knowledge source. `locate at:` likewise answers from memory for cells not currently
perceivable. Entity paths read the per-body Perception belief store (seen-fresh|heard|stale|
decayed), so blocks and entities obey one epistemic regime. The mod is untouched: the store lives
in mcp-server, so the legal answer path is local.

### 12.2 Legality is a provenance FILTER, not a second store

Every observation already records the tool that produced it. Legal knowledge is therefore a
query-time filter: `LEGAL_OBSERVATION_TOOLS` (v1: `raycast`, `raycast_fan` — sightline reads from
the body's eye) and the legal locate ignores cells whose provenance is an X-ray read. Copilot and
legal sessions share one world store without leakage — a copilot `describe_box` sits in the store,
labelled, invisible to the legal profile. One open edge, flagged not solved: **authored records
carry no legality provenance** — a note written during an X-ray session knows things the legal
profile should not. Cheap v1: stamp the session's profile onto authored records at write time so
legal-mode `mem_recall` filters the same way. For bench arms it is moot (fresh corpus per
scenario).

### 12.3 Coverage-honest negatives

Authoritative locate can prove absence within a radius; the legal one never can, structurally.
Its extent statement: *"searched your memory of this area — ~12% of the radius ever observed; not
found among seen blocks (absent from memory, not proven absent from the world)"*.
`negative_is_proof: false` always. The store's area records support the coverage estimate.

### 12.4 This is where ambient autofan belongs

For the copilot, ambient capture is an unproven optimization (§7 deferred it). For the legal
profile it is the **retina**: a human player passively sees everything they walk past, and a legal
bot that knows only what it explicitly scanned is sub-human in exactly the way ARCHITECTURE.md
says not to enforce. Sequencing that falls out: v1 legal profile ships with active scanning only
(look to know — rayfan, capture records, locate-from-memory finds), and ambient vision-capture
lands later as this profile's perception substrate, feeding the same store through the `ambient`
channel §2.3 reserved. The deliberate/ambient split and the deferred churn rule get their real
customer — and the last-deliberate comparand (§2.3) is what keeps on-read deltas meaningful when
the retina is writing continuously.

### 12.5 The bench bonus: the instrument fix Category C has needed

0.9.7's standing caveat: C **cannot isolate recall while the quiz session holds remote world
reads** — agents re-survey with `describe_box` instead of remembering, and no prompt can bind a
tool capability. A legal-profile arm removes X-ray at the TOOL level, making memory load-bearing
**by construction** — real headroom instead of ceiling effects, and the first arm where "did
memory retain it" is the only path to a correct answer. When cycle 4 is built, a legal arm joins
the lattice with its own pre-registration; it is likely the single most discriminating memory
measurement this bench can express.

**Arm construction (2026-07-30, building now — instrument only; the measurement run keeps its own
pre-registration before any spend):**

- `--arch legal` → condition **`k`** `{name:"legal", memTools: G_TOOLS, worldTools:
  LEGAL_WORLD_TOOLS, openingRender:true}`. `LEGAL_WORLD_TOOLS` is `G_WORLD_TOOLS` with the
  X-ray/operator names removed at the tool level (`scene_summary`, `get_entities`, `run_command`
  out) and the legal senses in (`sense_entities`; NOT `raycast_fan` — production's §5b hides the
  fan, so the arm gets **`bot_scan`** instead, the shared `memory/scan.mjs` orchestration, keeping
  bench and survival on the same deliberate-look verb).
- The shim routes `locate` through `legalLocate` for condition `k` (the same provenance-filtered
  answer path index.mjs gives the survival profile — §12.1's "swap the knowledge source, keep the
  name"), and captures quiz-session reads (`MCPTK_OBS_CAPTURE=on` — the arm's own raycasts/scans
  must enter the store or its locate is blind by construction). Annotate ON (the
  production-shaped appendix; `k` is not an on/off pair — its comparand is `full`, like every
  arm).
- Prompt: `k` gets a LEGAL core (no X-ray sentence — the standard core names tools the arm does
  not have) + the same MEM addendum; not a member of `PROMPT_CHAIN` or `PROMPT_PAIRS`.
- Expected instrument property, stated now so the first run cannot redefine it: the explore
  corpus is X-ray-provenance, so the legal quiz's `locate` structurally CANNOT re-survey it —
  correct answers must come through `mem_*` recall or fresh legal observation. That asymmetry is
  the point (the fix), not a bug to patch around.
- Guards extended, not new: `assertMemToolsLive`/`assertWorldToolsLive` cover `k` as-is;
  harness.test.mjs pins `LEGAL_WORLD_TOOLS`'s exclusions (no X-ray name, no `run_command`) and
  that `locate` + `bot_scan` are present. Bench version bumps (arm addition = construct change).

### 12.6 Ordering

Cycle 4 depends on §2.3's channel field and the store's provenance (already in the §9 build) plus
`raycast_fan` capture (§9 step 5). It does not block cycles 2–3 and should not be built before
them: the annotate cycle validates the store's delivery, cycle 3 cleans the write path, and cycle
4 then flips the profile switch on surfaces that have already earned trust.
