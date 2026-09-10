# Observation memory — captured, not authored

Status: DESIGNED 2026-07-27 (Matthijs' proposal, this session's evidence). Supersedes the observation
half of `MEMORY_DESIGN.md`; the authored half of that document stands. Contains the **pre-registered
prediction** (§6) that FREEZE_PLAN G5 requires — that section is committed BEFORE any code exists and
must not be edited afterwards.

---

## 1. The decision this reverses, and why

`MEMORY_DESIGN.md` §"Pending-memory surface" is subtitled **"assisted narration, not automation"** and
states the rule plainly: *"The agent remains the author"*, and *"the event stream is still never
wholesale-copied into memory."* That was a deliberate, defensible call — it kept memory small,
intentional, and free of an importance classifier.

The evidence from 2026-07-27 says it fails at the observation layer specifically. Every Category C
failure localised this session was a **narration** failure, never a storage or retrieval one:

- `emerald` was **written down wrong** — the corpus recorded *"emerald_block cap at y=201 (4-block
  cluster)"* against a construction truth of **6**. Retrieval returned that entry faithfully; the
  agent answered 4; it scored `confident_wrong`. A model summarised a tool result into prose and the
  number changed on the way through.
- `bookshelf` and `copper` were **observed and never written** (`observed:true, written:false` in the
  per-fact funnel). Not evicted, not compacted away — never authored. `mem_recall "bookshelf"`
  returned 0 results because there was nothing to return.
- Retrieval, in every case examined, returned everything that existed.

Authorship is a discretionary act competing for turns with the task the agent was actually given. The
failure is structural, not a prompt-quality problem, and no amount of charter text fixes "the model
had 40 platforms to survey and summarised one of them loosely."

**The axis is not index-vs-transcript.** Both of those are authored; one just writes shorter prose.
The axis is **authored vs captured**. This document specifies the captured layer.

## 2. What the evidence supports (and what it does not)

Category C, bench 0.9.5, after the instrument repairs — 5 seeds (`2026-07-27T08-39-40-mem-haiku`),
per-unit pooled over 7 seeds with the 2-seed dir (`2026-07-27T08-21-57-mem-haiku`):

| unit | score | what the question asks for |
|---|---|---|
| `anchor` | **100%** (7/7) | a block id, verifiable by looking |
| `stale` | **100%** (7/7) | current chest contents, explicitly verify-against-world |
| `region` | **100%** (7/7) | *which region* held the bookshelf — an INDEX fact |
| `breadth` | 71% | a count of structures in a region |
| `count` | **57%** [25–84] | the exact size of a cluster |
| `where` | **57%** [25–84] | the exact coordinates of a cluster |

The pattern: **memory reliably retains "which region / what kind"; it does not reliably retain exact
values.** Questions answerable by looking sit at ceiling. The two cells at 57% are precisely the
exact-value questions — the ones prose compaction destroys.

Honest limits on this evidence: n=7 seeds, one model (haiku), one scenario family. A 2-seed
intermediate read of the same corpus said the deficit had "moved to quantitative·C at 25%", which was
an **n=2 artifact** (`count` 0/2 there, 4/5 in the larger sample). Treat any single-digit-n cell here
as direction. The per-unit split above is the durable observation; the exact percentages are not.

## 3. The model

An observation record is *what a tool returned, when, about where*. It is never a summary.

```
observation := {
  tick,                  # game tick — the claim is ABOUT this tick, not about now
  dim,                   # dimension id
  tool, query,           # provenance: which read produced this, with what arguments
  key,                   # cell (x,y,z) for block reads | region+what for searches
  value,                 # the tool's own value, verbatim (block id, entity id, match list)
  session,               # which session observed it
}
```

Two access patterns, both falling out of the same store:

- **"What did I see at X?"** → the latest observation whose `key` covers X, returned *with its tick*.
- **"What changed at X since T?"** → the diff of observations covering X across the tick boundary.

`locate`-style searches store their **result sets** the same way (`what`, region searched, matches,
tick), so "where did I last see chests" is the same query shape as the live search — Matthijs' point
that one `what:` vocabulary should serve both. This aligns with PATTERN_SEARCH_DESIGN's finding that
`what:<id>` is the universal model instinct: make it land on everything, live and remembered.

### 3.1 Storage scales with CHANGE, not with looking

This is the answer to the volume objection that motivated prose compaction. `get_surface` at radius 8
is 1089 columns; storing every call verbatim sounds impossible. It isn't, because **the key is the
cell, not the call**:

- A newer observation of a cell **supersedes** the older *as current state*.
- The older is retained **only where the value differed** — that is the change history.
- Re-observing an unchanged room extends a tick range; it does not append records.

A Minecraft world is overwhelmingly static, so the second pass over known terrain is nearly free.
Compare prose compaction, which is lossy along the **wrong dimension**: it discards precision and
keeps narrative, which is exactly backwards from what every failed question needed.

### 3.2 Decay is representation, not deletion

An observation is a claim about its tick. The store returns age with the value — *"gold_block at
(x,y,z), observed 40 000 ticks ago"* — and staleness becomes **representable** rather than something
the agent must remember to be suspicious about. Old observations are not deleted (they are the change
history); they are returned with their age, and confidence is the caller's to weigh.

This is what the `stale` rung has always been trying to test. Under capture it tests whether the model
reads a timestamp, which is a fair and mechanical thing to test.

## 4. What is deliberately KEPT from the authored design

**The authored layer survives, for interpretation.** "This looks like a storage room", "the hopper
line feeds the east chest", goals, tasks, user instructions — a tool-result log cannot hold intent and
should not try. `mem_note` becomes **rare and high-value** instead of load-bearing for facts it keeps
getting wrong. This is a promotion, not a demotion.

**Provenance stays explicit.** Unifying `what:` across live and remembered is valuable, but merging
live and remembered results *silently* is exactly the "succeeds-falsely" class the toolkit spent
0.6.0 purging (~20 sites). Remembered hits come back **labelled and tick-stamped**, never blended into
the live set. A caller must always be able to tell "I can see this now" from "I saw this once".

**No importance classifier.** MEMORY_DESIGN's don't-build rule stands. Capture is mechanical: every
read is recorded, superseded by cell. There is no model deciding what mattered — that decision was
the failure mode.

## 5. What this obsoletes

FREEZE_PLAN **D3** ("the temporal read: event-log/envelope diff, answer-shaped verdict, its own
conformance entry") largely **stops being a feature and becomes a query**. `observations(loc, t1) −
observations(loc, t0)` is a derived read over the store specified above. D3 should be re-scoped to
"expose the diff query", not "build a diffing subsystem".

Category C as currently designed is also affected, but that was already true before this document:
this session established that C **cannot isolate recall while the quiz session holds remote world
reads** — `describe_box` reads a remote box with no flight, so a prompt saying "do not re-fly" does
not bind, and the recall arm scored 6/6 by re-surveying (describe_box ×23 vs mem_recall ×2). Measuring
recall requires removing world reads at the TOOL level. Measuring the *useful* thing requires a cost
metric — see §6.

---

## 6. PRE-REGISTRATION (FREEZE_PLAN G5)

**Committed 2026-07-27, before any implementation of §3 exists. Verbatim; not to be edited after
this commit. Falsification is reported whatever the outcome.**

**Hypothesis.** Category C's exact-value deficit is caused by *authored narration of observations*,
not by retrieval, compaction, or model capability. Replacing the observation layer with mechanical
capture (§3) will move the exact-value cells and nothing else.

**Predictions.** Measured at bench ≥1.0.x, haiku, seeds ≥5, against the 0.9.5 baseline recorded in §2:

1. **MOVES — `where` and `count`** rise to ≥85% each (baseline 57% each, CI [25–84]). These are the
   exact-value cells; capture records the tool's own value so there is no transcription step to lose
   it. Criterion: CI non-overlap with the 0.9.5 baseline OR paired sign test p<.05.
2. **MOVES — change detection becomes answerable at all.** A new rung asking "what changed at X since
   your last visit" scores ≥70%, from a floor of *not expressible* today.
3. **DOES NOT MOVE — `anchor`, `region`, `stale`** (all 100% at 0.9.5). At ceiling; capture cannot
   improve them and must not break them. Criterion: each stays ≥90%.
4. **DOES NOT MOVE — the controls.** E-traverse, E-repair, Z-gates, Z-diagnose, R-rotate and Category
   T rungs stay within noise of their 1.0.x baselines. Criterion: no control cell moves by more than
   its CI width.
5. **COST — capture does not pay for accuracy with tokens.** Quiz-session tokens for C do not rise
   more than 25% over the 0.9.5 baseline. (Capture happens at write time, in the harness, not in the
   agent's context; if the agent's cost rises materially the design has leaked into the context.)

**What falsifies the hypothesis.** Any of: `where`/`count` fail to move while capture is verified
present; the controls move (⇒ the change was not confined to the observation layer); or accuracy rises
only alongside a token rise beyond the §6.5 bound (⇒ bought with context, not with representation).

**Pre-committed caveat.** The 0.9.5 baseline is n=7 seeds, one model, one scenario family. If the
baseline itself moves materially on re-measurement at 1.0.x, the comparison uses the 1.0.x baseline
and this fact is reported, not the more favourable of the two.

---

## 7. Build order

Steps 1–3 BUILT 2026-07-27 (same session as the design; §6 was committed first and is untouched).
Sequencing per FREEZE_PLAN's rule *"pre-register before building"*.

1. **Store + supersession** (`memory/observations.mjs`) — **DONE 2026-07-27**: append-only
   `observations.jsonl` per world, ONE record per captured read carrying only new/changed cells
   (palette-compressed) plus the read's coverage area; current-per-cell and change history are
   derived; freshness derives from later `confirms` records whose complete area covers a cell
   (surface reads only re-confirm current column tops; aggregates never confirm per-cell); complete
   box scans imply air for unlisted cells and record disappearances as explicit changes to air.
   Offline probes: `memory/probes/observations.test.mjs` (synthetic streams; 25/25 with step 2's).
2. **Capture hook** (`memory/capture.mjs`, wired in `index.mjs`) — **DONE 2026-07-27**: extractors
   for get_blocks_at, get_surface (full + summary/anomalies), describe_box (summary + layers),
   locate (search sweeps + identify cells), raycast block hits. Reads only; unread positions (-1),
   unloaded columns and partial scans never index as facts. Never throws, but shape drift logs
   loudly; `UNCAPTURED_WORLD_READS` declares every world read deliberately not captured (tested —
   the anti-silent-narrowing ledger). `MCPTK_OBS_CAPTURE=off` is the ablation arm. NOT wired into
   the bench shim — that is step 4, after the instrument freezes.
3. **Query surface** (`memory/obs-tools.mjs`: `mem_seen`, `mem_changes`, `mem_last_seen`) — **DONE
   2026-07-27**: what-did-I-see-at-X (box answers include per-id exact counts + bounding boxes),
   what-changed-since-T (stale cells report as UNKNOWN, never unchanged; same-id detail differences
   as refinements, not changes), where-did-I-last-see (cells clustered per dimension+region, plus
   sweep sightings). All return value + tick + age and are labelled remembered — never blended with
   live reads (§4). Probes: `memory/probes/capture.test.mjs`.
4. **Bench**: a change-detection rung (prediction 2) and a re-run of C at ≥5 seeds. New units in
   `registry.mjs`; ratchet must stay green.
5. **Measure against §6.** Report every prediction, including the ones that fail.

**Freeze interaction.** This is a TOOLKIT change, not a bench-instrument change. Do not block the
v1.0.0 bench freeze on it: freeze the instrument, then measure this as the intervention. That
sequencing is what makes it a genuine prospective cycle rather than a retrospective story — which is
the whole of Paper A's methodological claim.

## 8. Provenance

Proposed by Matthijs, 2026-07-27, after this session localised C's failures to the write path.
Evidence: `2026-07-27T08-39-40-mem-haiku` (5 seeds), `2026-07-27T08-21-57-mem-haiku` (2 seeds), bench
0.9.5; the per-fact funnel in those rows; FREEZE_PLAN B4/B1 entries from the same session. The
instrument repairs that made this measurable — the `get_blocks` rename that had silently removed
Category C's block reader, and the `anchor`/`breadth` question defects — are recorded in
`mcp-server/testbench/version.mjs` under 0.9.4 and 0.9.5.
