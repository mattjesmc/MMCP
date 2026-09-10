# Per-tool value — leave-one-out ablation (the "is this tool a win?" baseline)

For every tool a bench category exercises, hide exactly that one tool (everything else present) and
measure the delta vs the full-toolkit baseline. The delta is the tool's **marginal** value: a tool
with a cheap substitute reads ≈0 even if useful — which is the right "does it pull weight on top of
the rest" question, and the regression baseline for working on that tool. Total value (a tool + its
substitutes) is the group-ablation (`--without` arm), not this.

Runner: `node testbench/run-tasks.mjs --loo [--loo tool1,tool2] --model haiku --seeds 2 --reps 2`.
Generates a `full` baseline + one `no-<tool>` arm each. Summary prints the table below + a coverage
footer naming candidates the baseline never called (their Δ is meaningless).

## Category T (haiku, seeds 2 × reps 2, run `…08-39-10-tasks-haiku`)

Baseline **full**: 94% acc, 81k tok/session (with-cache).

| tool | Δacc | Δtok/session | rungs it owns | verdict |
|---|---|---|---|---|
| `get_region_summary` | **−13** | +5k | r7 water 100→25%, r8 flattest 100→75% | **Load-bearing** — aggregate height/water stats, no substitute |
| `check_path` | **−6** | −2k | r4 reach 100→50% | **Load-bearing** — real pathfinder verdict, uninferable |
| `check_site` | −3 | **+8k** | r5 heights, r7 water | **Efficiency win** — accuracy mostly holds, but it's the biggest token saver |
| `scan_box` | +0 | +0 | (r2/r3, but covered) | **Substitutable** — `get_blocks_at`/`get_blocks` cover at similar cost |
| `get_blocks_at` | +0 | −2k | — | **Substitutable** |
| `get_blocks` | +0 | −2k | — | **Substitutable** — the raw primitive; everything substitutes (cf. TOKEN_PER_TOOL_FINDINGS surface-view result) |
| `check_fit` | (−6) | — | (r5) | **Noise** — the baseline never called it (coverage footer flags it); the −6 is n=4 stochasticity, not causal |

**Read (REVISED — see the referent-count correction below).** Three predicates pull real weight —
`get_region_summary` ≫ `check_path` > `check_site`. The raw reads (`scan_box`, `get_blocks_at`)
looked substitutable (Δacc≈0) here — but this ladder's rungs are single-target, and that verdict did
not survive a multi-referent test.

## Referent-count correction — the "substitutable" verdict was a task-shape artifact

Hypothesis (why single-target rungs mislead): a read tool's value is holding SEVERAL referents at
once, so a one-point / one-box rung can't tell a real win from a cheap substitute. r1 (get_blocks_at)
and r2/r3 (scan_box) are all single-referent — so their Δ≈0 above is uninformative, not a null.

Test: paired single-vs-multi rungs for the SAME tool (`t10_multipoint` = 5 points, `t11_multibox` =
4 boxes), `--loo get_blocks_at,scan_box --rungs 1-3,10-11 --seeds 2 --reps 3` (run `…14-52-23`):

| tool | single-referent | multi-referent |
|---|---|---|
| `get_blocks_at` | r1: 100%, **1.0 calls** (= full) | r10 (5 pts): **83%, 3.0 calls** (full 100%/1.0) |
| `scan_box` | r2: 100% (= full); r3: +11k tok | r11 (4 boxes): **83%** (turn-capped) (full 100%) |

Both are Δ≈0 single-target and **cost real accuracy/effort when removed multi-referent** —
`get_blocks_at` removal triples calls (1→3); `scan_box` removal turn-caps the agent on get_blocks
fallback. So: **substitutable on single-target tasks, NOT in general.** Lessons: (1) call-count is a
cleaner signal than accuracy for these effort-substitution tools (accuracy only cracks once the
extra effort blows the turn cap); (2) the token metric is swamped by the ~78k static prefix at this
scale; (3) effect sizes are still modest (one flip at n=6) — push referent count higher (10 pts /
8 boxes) and reps ≥5 for a strong argument. **Any tool whose LOO reads ~0 must be checked on a
≥3-referent rung before it's called substitutable.**

**Method caveat — the noise floor.** Each rung has n=4 here (2 seeds × 2 reps), so a tool owning one
rung moves ±25% on a single flipped session. `get_region_summary` (−13, two rungs) is clearly above
noise; `check_site` (−3) and the `check_fit` artifact are at/below it. To *argue* a single-rung tool
confidently, re-run its cell at reps ≥3. The `check_fit` row is the worked example of why the
coverage footer matters: hiding a tool the baseline never used cannot be causal.

## How to extend

Each new category ships its own LOO the same way — pass the tools that category exercises
(from `coverage-report.mjs`) as `--loo a,b,c`. That gives every tool a "win?" number and a baseline
to regression-check against when you change the tool.
