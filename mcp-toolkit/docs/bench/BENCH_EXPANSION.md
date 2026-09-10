# Bench expansion — covering the dark tools (evidence-driven)

Motivation: the coverage scan (`mcp-server/testbench/coverage-report.mjs`, run 2026-07-24) shows the
testbench exercises only **28 of 75 tools**; **47 are DARK** (no task can call them). By the
toolkit's own `mechanism` taxonomy:

| mechanism | tested | dark | what's dark |
|---|---|---|---|
| observe (read/predicate) | 15/27 | 12 | `get_region`, `raycast_fan`, `check_clearance`, `find_site`, `resolve_anchor`, registries/lists, `bot_profile` |
| embodied (move + act) | 5/20 | **15** | every bot ACTION — `bot_mine`/`place`/`use`/`attack`/`shoot`/`eat`/`drink`, `bot_spawn`/`possess`/`run`/`follow`/`point`/`select` |
| world_edit (mutation) | **0/6** | 6 | `set_blocks`, `place_blocks`, `place_shape`, `undo_edit`, `import_building`, `edit_building` |
| privileged | 1/11 | 10 | `send_chat`, `push_data`, `save_building`, `bot_give`, companions, sessions, `hotswap_class` |
| local (memory) | 7/11 | 4 | `mem_place`, `mem_verify`, `mem_locate`, `launch_game` |

Existing categories: **A/B** spatial+serialization (observe), **T** task ladder (observe/predicate),
**C** memory recall (local), **P** true-play perception (a slice of embodied). The two big untested
mechanism clusters are **embodied actions** and **world_edit** — exactly what this expansion targets.

## Category E — Embodied (the drone as a body). Auto-scored from server truth.

Extends Category P's harness (`play-scenario.mjs`: `stageArena`, mob `summon`, `bot_give`,
`bot_profile`, `runEpisodeSdk`, server-truth scoring, legal-vs-xray arms). Every slice reports two
axes the user asked for: **skill** (did it succeed) and **token efficiency** (tokens + turns per unit
of success). Legal (player-legal perception) vs xray (omniscient) stays the ablation.

### E-combat — multi-round arena of increasing difficulty  ← FIRST BUILD
P-survive is already a *single* round (a seed-scaled skeleton ring, gear via `bot_give`, threat made
real with `/damage … by <drone>`, scored alive/health/kills/damage). E-combat makes it a **wave
ladder**: round _r_ spawns a harder threat (r1: 3 zombies → r2: 5 → r3: skeletons at range → r4:
mixed + a brute), the body re-geared between rounds, run until it dies or clears round N. Report per
round: cleared?, final health, kills, damage taken, **tokens & turns to clear** — so the deliverable
is a skill×cost curve per arm, like T's.

**Unblocks P-survive's hover bug** (documented: the drone floats ~y151, out of ground-melee reach →
0 damage/0 kills). Approach: **altitude-matched threats** — after `bot_spawn`, read the body's rest
`y` from `bot_status`, stage a barrier/glass platform at that `y`, and `summon` the mobs on it so
they fight at the body's level. (Fallbacks if that's insufficient: pin drone combat altitude
mod-side, or possess a grounded player body via `bot_possess`.) This is the one part needing live
in-game iteration; the harness around it is straight P-pattern code.
Tools lit: `bot_spawn`, `bot_status`, `bot_equip`, `bot_engage`, `bot_attack`, `bot_shoot`,
`bot_reactions`, `bot_eat`/`drink`, `sense_entities`, `bot_goto`.

### E-traverse — in-body pathfinding / obstacle course
Stage a course (gaps, walls, water, a maze) between A and B; the body must actually get there.
`check_path` predicts, `bot_goto`/`bot_run` execute — score arrival, path length vs optimal, falls,
time, tokens. Lights `bot_run`/`follow`/`point`/`select` and validates `check_path` against real
traversal (the predicate bench T only checks its *verdict*, never that a body can follow it).

### E-survive-build — gather-and-build under survival rules
A goal ("wall off this 5×5 / bridge this gap / reach shelter before night") with an empty inventory:
the body must `bot_mine` resources and `bot_place` them. Auto-scored against the goal predicate
(`check_clearance`/`check_fit`/`scan_box`). Lights `bot_mine`/`place`/`use` — the embodied build loop.

## Category W — World-edit building. Human-rated + auto where possible.

The `world_edit` cluster (0/6 tested). Here the agent builds with `set_blocks`/`place_blocks`/
`place_shape`/`edit_building` (no body), and the output is a *structure* — quality is aesthetic, so
scoring is **human-rated** with an auto-scored floor. Three input modalities the user named:

- **W-describe** — build from a text description ("a 7×7 cottage with a peaked roof and a door").
- **W-schematic** — build to match a target structure (`import_building`/NBT). This one is
  **auto-scorable**: diff the built region against the target (block-match %, silhouette) — no human
  needed, and it doubles as a `save_building`/`import_building` round-trip test.
- **W-picture** — build from a reference image (multimodal prompt → structure).

Harness: stage a clean plot → run the build session → **render** the result (the toolkit already
does renders/`judge_build`) → for W-describe/picture, present render+brief to a human rater (a small
rating CLI collecting 1–5 on fidelity/structure/aesthetics); for W-schematic, auto-diff. Report
score × tokens. This is a *new* harness shape (human-in-the-loop), heavier than E — proposed second.

## Build order

1. **E-combat** (this session, delegated) — highest-value: biggest dark cluster, extends P, unblocks
   a known-blocked slice, fully auto-scored.
2. E-traverse, E-survive-build — same harness, incremental.
3. W-schematic (auto-scored) → W-describe/W-picture (human-rated harness).

Per-tool marginal value for the tools each new category lights up is measured the same way as the
Category-T LOO (`run-tasks.mjs --loo`) — so each category ships with its own "are these tools wins?"
scorecard.
