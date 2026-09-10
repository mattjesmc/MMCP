# The difficulty ceiling — which categories need harder rungs before freeze

Status: PROPOSAL 2026-07-26 (Matthijs asked: recent ~98% run with the new locate tool ⇒ the bench is
saturating; investigate + propose which categories get higher-difficulty settings, freeze-blocking).
Evidence is from `bench-report.mjs` over the current `testbench-results/` corpus (haiku, 38 dirs).

## 1. The diagnosis — the ceiling is in the STRONG arm, and the difficulty ladder is an illusion

Per-tier accuracy, Category T, split by arm (`bench-report --model haiku --by difficulty,arm`):

| tier | **with-arm** (all tools) | without-arm (predicates hidden) |
|---|---|---|
| easy | 96% | 94% |
| medium | 96% | 86% |
| hard | 96% | 87% |
| very_hard | 96% | 29% |
| frontier | 97% | 45% |

**The with-arm is pinned at ~96% across every labeled tier.** The `difficulty` field grades the
*without*-arm (tool-dependence: 94%→29%) but says nothing about difficulty for a capable agent. The
strong arm's per-unit ceiling confirms it — with-arm = **100%** on t1, t3, t6, t8, t10, t11, t12, t13,
t15, t16 (`--by unit,arm`, "· with").

Three consequences, all freeze-blocking:
1. **Tool-value headroom is gone** on the saturated rungs — with=100%/without=100% (t1, t3) measures
   nothing for P1. (The rungs that DO carry P1 — t7 96/29, t8 100/44, t4 93/50 — still work.)
2. **The second-model axis is dead.** haiku-with-tools already maxes the with-arm; a frontier model
   (sonnet/opus) has nowhere to go. Both papers' model comparison and P1's secondary hypothesis
   need with-arm headroom that does not exist. **This is the ~98% run.**
3. The `difficulty` labels are miscalibrated against data (t8 tagged "frontier", with-arm 100%).

## 2. The design principle — two kinds of "harder", and we only have one

- **(A) more tool-DEPENDENT** — widen the without-arm gap. The bench already does this well; the
  predicate tools do real work on aggregation/pathfinding rungs. *Not* what's missing.
- **(B) more REASONING-hard for the strong arm** — lower the with-arm off the ceiling. This is the
  gap. A tool that returns raw data doesn't remove the need to *combine* it correctly; difficulty of
  kind B comes from **compounding** (many referents / a long chain, so a strong agent's per-step
  error rate accumulates below ceiling) and from **breaking tool shortcuts** (relational chains where
  `locate`'s one-hop `pattern` returns several candidates that must be disambiguated).

**Acceptance target for a frozen rung:** the strong (best-arm) model lands roughly **50–85%** — enough
headroom to separate models and show tool value, not so low it's noise. Today the strong arm is 96–100%.

**Freeze-safety:** ADD new hard rungs/tiers as *distinct units* (keep the easy ones as anchors) — do
NOT mutate existing units. Even pre-freeze, mutation discards the haiku baseline and destroys the
easy→hard gradient the bench needs; additive rungs are a minor-version change under the SemVer policy.

## 3. Recommendation — prioritized, NOT all categories

### Tier 1 — MUST (saturated AND carries a paper claim)

**T (tool ablation) — the priority.** Add a genuine "frontier+" band whose *with*-arm lands 50–80%:
- **Compounding (counting/multi-referent):** new harder siblings that scale the referent/decoy count
  far up — t3 pillars `n=ri(r,3,6)`→~12–20 (`tasks.mjs:224`); t10 points 5→12 (`:481`); t11 boxes
  4→8 (`:506`); t16 golds 6→12 (`:733`). Many correct reads that must ALL land is where the strong
  arm finally drops.
- **Break the locate shortcut (relational):** t13 chain length 5→longer + multiple decoy chains
  (`:599`); t15 more decoy entities (`:697`); a NEW multi-hop rung where `locate pattern` returns
  several candidates needing a reasoning step to disambiguate (the whole point of the pattern arm).
- **Enlarge search space:** t7 3×3→5×5 tiles (`:313`); t9 tighten footprint / widen the anchor
  window (`:427-428`).
- Recalibrate the `difficulty` labels against the new `--by difficulty` pivot.

**AB (spatial VQA) — freeze-relevant, no knob today.** Fully static 14-question arena, 13/14 at 100%,
and it is the *no-tools model-cognition baseline* both papers compare models on. It has **no seed and
no scaler** — hardening is hand-authoring: thin the walk transcript (fewer/more-separated vantage
points → more egocentric integration, `layout.mjs:56-68`), add decoy features/towers (currently 4
towers + 1 anomaly), and add multi-step spatial questions. Highest effort, but it gates the model axis.

**R (rotation) — cheap, high headroom.** N=5 grid at 100%; one-line master knob `N`→7/9
(`rotate-scenario.mjs:28`) plus 3-deep transform compositions (currently max 2, `:48-51`). Nearly free.

### Tier 2 — SHOULD (saturated, lower claim-weight; confirm n first)

- **P (perceive/survive)** — both 100%. Seed knobs already exist: raise `nZombies = 1 + seed*3`
  (`play-scenario.mjs:141`) and add hidden mobs / tighten FOV for perceive (`:68`). Cheap.
- **W (wbuild)** — 100% but only n=1 (get more reps before trusting it). Fixed 5×5×3, no seed scaler;
  bump `W/D/H` (`wbuild-scenario.mjs:23`) and the repair deviation count (fixed 3, `:149-153`).
- **Z-diagnose** — 100% at n=2 (weak). Raise candidate/lane/branch count (`diagnose-scenario.mjs:44,
  92-96,129-134`). Cheap, but confirm saturation with more n first.

### Tier 3 — LEAVE ALONE (already discriminating; hardening would only add noise)

- **C (memory)** — 0–50% (breadth 0%, anchor/stale 25%). Near the floor; do not harden.
- **Z-gates (build)** — 25–50%. XOR is already the ceiling. (Optional: one capstone adder/MUX rung as
  headroom for a *frontier* model — not needed for haiku.)
- **E-combat / milestone / dungeon** — 33% / hard. Already discriminating. E-traverse t1–t3 are 100%
  but the harder tiers (t4 water, t5 S-maze) simply have not been RUN — the `COURSES` ladder already
  extends (`traverse-scenario.mjs:61-67`); run t4/t5 rather than invent new ones.
- **Mid-T (t2 80%, t4 91%, t5 90%, t7 96%/29%, t9 88%)** — good headroom; keep as-is.

## 4. Enabling change already landed

`bench-report --by difficulty` (+ `difficulty,arm`) added, so saturation-by-tier is now visible and
labels can be recalibrated against data. Follow-up (cheap): promote `difficulty` from a row label to a
first-class **registry unit field** so it becomes a run-bench *selection* axis (run only the frontier
tier) and a clean report pivot — mirrors how `disciplines` already work.

## 5. One-line summary

Harden **T (first), AB, R** now; **P, W, Z-diagnose** after confirming their n; **leave C, Z-gates, E,
mid-T**. The lever is reasoning-compounding + breaking the `locate` shortcut, added as *new* hard rungs
so the easy anchors survive the freeze. Target: strong-arm 50–85%, not 96–100%.
