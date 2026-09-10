# Ablation results — full grid, 2026-07-19

Machine-checked readout of the gameplay ablation (design + pre-registered rules: ABLATION_DESIGN.md
rev 2). Substrate: Claude Agent SDK on the Max subscription, Sonnet 5, abstracted perception view,
condition-filtered MCP shim. 63 rows (5 scenarios × 3 variants × 4 conditions + 3 identical-corpus
forks); raw data `mcp-server/ablation-results/results.jsonl`, aggregator `ablation/analyze.mjs`.
Tokens are input-side (cache reads dominate) unless noted; n=3 per cell — claims are consistency of
direction, never significance.

## Headline

**Durable memory earns its keep, and the compaction telescope specifically is the load-bearing
layer. The retrieval layer above it (mem_recall + embeddings) does not yet pay for itself.**

| condition | pass (pooled) | tokens / success |
|---|---|---|
| A amnesiac | 10/15 | 1595k |
| B tail + task frame | 12/15 | **872k** |
| C telescope | 12/15 | 1011k |
| D + recall/embeddings | 10/15 | 1184k |

## Per-scenario tables (medians; per-variant values in brackets, variant order v1,v2,v3)

**stash-fixed** — revisit a catalogued site.
A 1/3 (acq 32,15,38 calls) · B 3/3 (1,9,1) · C 3/3 (1,2,1) · D 3/3 (1,1,1). Memory turns
re-search into a single targeted flight; ~3× token gap (A 784k vs B/C/D 242–279k).

**stash-self** — return to self-chosen cache sites.
A 2/3 (acq 3,5,26) · B 3/3 (1,1,1) · C 3/3 (2,1,1) · D 2/3 (0–1; one E1 execution miss: 2 of 3
markers placed). Self-authored memory works; note the abstracted view makes markers re-findable by
scan, so A discriminates on cost, not success.

**interrogation-multi** — cross-episode recall from a multi-block corpus (THE memory scenario).
A 1/3 (facts 0,4,0) · B 1/3 (0,4,0) · C **2/3 (4,3,4)** · D 0/3 (3,2,2). The v2 A/B "passes"
carry `resurveyed_in_e2` flags (B spent 194k tokens re-flying the strips against instructions) —
honest-success A 0/3, B 0/3. C recovered demoted facts via mem_read into blocks every time.
D used mem_recall in all three cells (1–3 calls) but scored worse — see forks.

**interrogation-multi forks (Track 2: D toolset on C's byte-identical corpora)** — facts 4,3,4 =
exactly C's own scores; e2 cost 11–43k vs C's 52–93k. Retrieval **parity** on accuracy; the cost
advantage came mostly from trusting the render (recall fired in 1/3 forks). D's Track 1 deficit is
therefore **formation variance** (recall use during E1 patrols coincided with worse note-taking),
not retrieval failure.

**stale-fact** — world mutated behind the agent's back.
A 3/3 · B 2/3 · C 1/3 · D 2/3; **stale assumptions 0/24 subjects across ALL conditions** —
verification behavior is at ceiling (Sonnet 5 + explicit prompt), so rule 5 is a wash at this
scale. The discriminators: cost (A re-observes everything, 757k vs B 187k) and the audit trail
(`mem_verify contradicted` recorded: D 3/3, C 2/3, A/B structurally 0/6). Chest-relocation misses
cluster on B/C/D in v2 — weak signal that remembered layout can anchor search too narrowly.

**resume-build** — finish a half-built spec given only once.
12/12 pass, e1done 3–8/10 (resume pressure existed), spec stored by B 3/3, C 2/3, D 2/3, A 0/3 —
and A still finished. **Construction gap:** the "non-inferable" spec was inferable — pillar
materials are visible on the partial build and heights were diagonally symmetric. Measures build
competence, not memory. Fix for any rerun: irregular heights + tighter E1 cap (some pillars
untouched).

## The seven pre-registered rules, read verbatim

1. **B > A where the task frame suffices** — **CONFIRMED** (stash-fixed/self: B 6/6 vs A 3/6, acq
   1–9 vs 3–38; resume-build void — construction gap).
2. **C > B once facts age out of the tail** — **CONFIRMED** (interrogation-multi: C 2/3 vs honest-B
   0/3; B's failures were honest nulls behind the truncation banner, its "pass" was a re-survey).
3. **D ≥ C accuracy AND D < C retrieval cost** — **PARITY, NOT SUPERIORITY** — but see the
   2026-07-20 update under Harness lessons: this verdict is **not load-bearing**. `in_render` was
   true in 11/12 fact-slots, so neither condition had to retrieve; the result measures render-reading,
   not recall. Treat rule 3 as UNTESTED. Identical-corpus forks: accuracy exactly equal, cost lower
   but driven by render-trust rather than recall (1/3 fork used recall at all).
4. **D-hybrid > D-exact on concept queries** — **FAIL** (micro-ablation, offline, same corpora):
   exact 13/15 = 13/15 (lexical does the work); zero-overlap concept queries 0/15 = 0/15. MiniLM
   cosines vs real block texts run 0.0–0.25 against the 0.30 threshold; outcome-only embedding
   texts tested and refuted. The semantic channel contributed nothing on real corpora.
5. **C/D fewer stale actions than A/B** — **WASH (ceiling)**: zero stale assumptions everywhere.
   Genuine C/D-only value: the recorded contradiction trail.
6. **Economics** — cost/success table above. B is cheapest but fails exactly where memory matters
   most; C costs 1.16× B (well under the 2× engineering ceiling) and is the best
   success-× -cost compromise; D pays 1.36× B for no accuracy gain. A pays 1.8× B and fails most.
7. **No unintended world changes** — **PASS**: zero forbidden-command flags in 63 rows.

## Architecture verdict

Keep and invest: entries + task frame (B's core), compaction blocks with derived headers and
outcome lines, mem_read drill-down, mem_verify trail, the truncation-honesty banner, and the
telescope render — **the render's outcome lines are the single hardest-working surface in the
system** (they carried most correct answers in every condition that had them).

Simplification candidates for the next MEMORY_DESIGN revision (per pre-registration, losses
simplify): the semantic embedding channel (rule 4 fail; maintenance + latency for nothing measured)
and possibly mem_recall itself — though the honest caveat is that no test yet reached the corpus
size where render + mem_read must break down (dozens of blocks, multi-region history). The
overnight soak corpus is the natural next testbed before deleting anything.

## Harness/construction lessons (for the record)

Caught and fixed mid-grid: agent-side bot_spawn wiped seeded inventories (removed from surface;
stash-self v1+v2a rerun); raw get_blocks JSON defeated perception (abstracted ASCII view, also
~50× cheaper); B's silent truncation (explicit banner); drone-pos-after-despawn assert
(rescore.mjs). Still open: resume-build spec inferability; interrogation-multi render still leaks
facts via block outcomes at small corpus sizes (needs bigger corpora or tighter render budgets for
rule 3 to bite).

**Update 2026-07-20 — "bigger corpora" does NOT fix the leak, and rule 3 is weaker than recorded.**
Queue item 2 tested exactly that remedy (interrogation-multi forked onto the 14-block soak corpus)
and it cannot work, for a structural reason: facts reach the debrief through **block outcome lines**,
agents write specifics (including coordinates) into them, and the render elides *oldest* blocks
first — while the agent's own patrol blocks are always *newest*, so they are never the ones elided.
Piling history *underneath* new notes cannot push those notes out of the render. Measured on the
fixed harness: `in_render: true` for all four facts, with the e2 context containing
`gold_block on top in L-shape at (112333,201,100025)` verbatim.

The same is true of the step-7 cells: `in_render` was true in **11 of 12** fact-slots. So rule 3's
"parity" was measured where **neither** condition needed to retrieve — it says the agent can read its
own render, not that `mem_recall` ≈ `mem_read`. Do not conclude anything about `mem_recall`, in
either direction, from interrogation-multi. A real test needs bulk material with ticks *after* the
planted facts, a debrief on detail outcome lines do not carry, or a different scenario entirely.

## Provenance

Grid ran 2026-07-19 19:59–18:44+ UTC-ish local, 3.85h primary pass + reruns, detached process
(session background shells proved kill-prone), monitored. Analysis: `ablation/analyze.mjs`;
micro-ablation: `ablation/micro-embed.mjs` (offline). Written the same night; per-variant numbers
verbatim above; nothing tuned post-hoc except where explicitly labeled a fixed harness bug with
contaminated rows purged and rerun.
