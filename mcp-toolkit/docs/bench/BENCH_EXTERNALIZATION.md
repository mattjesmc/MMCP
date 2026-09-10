# Bench externalization — the seam, the versioning, the split plan

Status: 2026-07-25 — seam + versioning SHIPPED (step 1 below); repo split deliberately deferred to
the v1.0.0 freeze. Companion to PAPER_BENCH.md (§8 versioning policy, §3.1 the two-channel
contribution) and testbench/README.md.

## Why externalize

The bench paper claims an *analytic framework*, not "our test suite." That claim needs two things
the in-tree layout only implied:

1. **A citable, versioned instrument** — every result row traceable to the bench version that
   produced it, so paper tables survive registry churn.
2. **A system-under-test boundary** — the bench must be *able* to run a different agent surface
   without the runners changing, even while only one SUT exists today.

## The two channels (the load-bearing distinction)

- **ORACLE channel** — staging, truth generation, intervention-verification, server-state scoring.
  Runs on the bridge/mod. It is *part of the instrument*: every SUT needs it, and no SUT under
  test may touch it. This is why truths stay trustworthy under every ablation arm, and why the mod
  is *instrumentation* in Paper A while being the *subject* of Paper B — two roles, one codebase,
  distinguished by channel, not by repo.
- **AGENT channel** — the tool surface the SUT exposes to its model. Ablation arms are *degraded
  agent channels* (hide/swap/view = surface transforms); the oracle never varies with the arm.
  This is also the cleaner description of the reproduction suite (PAPER_BENCH.md §7): the FLE
  reproduction is an adapter without predicates; a text-vs-pixels arm is an adapter whose
  perception is a screenshot.

Rule that falls out: **an adapter that cannot express a requested surface transform must throw,
never silently ignore it** — an arm that isn't the arm we think it is invalidates the run (the
run-tasks manifest-validation lesson, generalized).

## What shipped (step 1, 2026-07-25)

- `testbench/version.mjs` — `BENCH_VERSION` (0.9.0 pre-freeze) + the SemVer policy in comments.
  All 11 runners stamp `bench_version` into manifest.json beside `git_head` / `tools_hash` /
  `questions_hash` / `toolkit_version`.
- `testbench/adapter.mjs` — the SUT adapter contract (episode record + `surface` transform),
  `ADAPTERS` registry, adapter #1 `mcp-shim` wrapping `agent.mjs` unchanged.
- `run-tasks.mjs` — routed through `getAdapter(--adapter, default "mcp-shim")`; manifest records
  the adapter name. Category T is the ablation workhorse, so the seam lands there first.

## The path (remaining steps, in order)

2. **Unify the ablation launcher.** `ablation/runner-sdk.mjs` (C/P/E/Z/W sessions via the
   ablation mcp-shim) becomes adapter #2 or — better — the `mcp-shim` adapter grows the
   `system`/`allowedTools`/transcript-path options those runners need and both launchers collapse
   into one. Decide when the next E/P harness change is needed anyway; do not refactor green
   harnesses mid-measurement. `quiz.mjs` stays outside the seam on purpose: no-tools transcript QA
   has no agent channel.
3. **Registry carries adapter requirements.** A unit that needs embodiment (E) or a client (future
   vision arm) declares it, so `run-bench --list` can say which units a given adapter can run
   instead of failing mid-run.
4. **Freeze = v1.0.0 = split.** At the tag: extract `testbench/` (+ the ablation runner pieces it
   still imports) to its own package/repo with the bench's citable name (open decision,
   PAPER_BENCH.md §10). The oracle stays a declared *dependency* (a running bridge at a port), not
   vendored code — the bench talks to `/tools` and the bridge HTTP surface only. Until the tag,
   the seam is enforced in-tree.

## External SUTs — honest scoping

A mineflayer adapter is the obvious candidate and is currently **impossible on the same world**:
protocol support ends at 1.21.x, the server is 26.2 (RESEARCH_WORLD_REPRESENTATION.md round
three). Options if a cross-stack arm is ever funded: best-effort parallel staging on a 1.21 world
(clearly labeled non-identical — forfeits same-truth comparability), or wait for a 26.x-capable
substrate. Neither blocks the papers: the reproduction suite needs only our own degraded
adapters, and the cross-stack comparison is scoped out explicitly in both limitation sections.

## Non-goals

- No abstract multi-game "framework" layer. One game, one oracle, adapters for agent surfaces —
  generalization is argued in the paper, not speculatively coded.
- No adapter for quiz-style offline categories (A/B/R transcripts, rotate) — no agent channel.
- No repo split before the freeze (versioning friction while the registry still moves).
