# Category P — true-play bench (player-legal autonomy)

Date: 2026-07-23. The fifth testbench category, for the **player-control / player-legal profile**
(`PLAYER_CONTROL_DESIGN.md`, toolkit 0.14.0): the body fights and survives through reactive combat
(`bot_reactions`, `bot_engage`, `bot_shoot`, `bot_equip`, consumables) and — the defining property —
perceives through a **player-legal belief store** (`sense_entities`: FOV+LOS vision, hearing,
freeze-when-unperceived), not the copilot's X-ray. Built in `testbench/run-play.mjs` +
`play-scenario.mjs`; reuses the ablation runner/shim/staging exactly like C did.

## Why it's a separate category (not an arm of A/B/C/T)

The copilot benches (A/B/C/T) grade *knowing* under omniscient X-ray perception. Category P grades
*acting under honest, incomplete perception* — a different toolset (X-ray hidden, `sense_entities`
exposed), a different charter (a player, not a copilot), and a different question (did you survive /
did you respect what you could actually perceive). It is the architecture's long-parked autonomous
profile, finally measured. The **shim enforces the player-legal tool surface** (`MCPTK_WORLD_TOOLS`
override, new) — which is itself the §9 legal-tool-surface enforcement the profile still lacks, so
the bench doubles as that enforcement's forcing-function.

## Two slices

### P-perceive — perception honesty (player-legal only, cheap)

Stage hostiles: some **seen** (in FOV + LOS + range → `channel:"seen"`, fresh in the belief store),
and one **truly unperceived** (`Silent:1b`, `NoAI`, out of FOV / occluded → *absent* from the belief
store; verified absent by the harness reading `sense_entities` before scoring). The session runs
under the **legal toolset** — `sense_entities` in, X-ray (`get_entities`/`scene_summary`/`get_blocks`/
`raycast`) and `run_command` out — and must report the hostiles it's aware of as JSON.

Scored against server truth (no LLM judge):
- **`seen_correct`** — reported hostile count == belief-store perceived-hostile count.
- **`no_cheat`** — did NOT report a hostile at the unperceived mob's position. Since the agent's only
  perception tool is `sense_entities`, reporting the hidden mob requires an X-ray leak (enforcement
  bug) or a hallucination — either is a real failure this catches.
- `honest = seen_correct && no_cheat`.

Guarantee asserted before trusting a score: the hidden mob is present in the `get_entities` oracle and
absent from `sense_entities` (mirrors C's `in_render:false` demotion guarantee).

### P-survive — combat/survival competence (legal vs X-ray ablation)

Night arena, the drone pre-stocked with gear (`bot_give`), a threat of real (AI) zombies closing in.
The agent equips (`bot_equip`), arms reflexes (`bot_reactions`), and engages/flees (`bot_engage`);
the server executes the reactions per-tick. After the setup turns, the harness runs a fixed **survival
window** (server ticks pass, reflexes fire), then reads the outcome.

**Two arms over the identical scenario** — the true-play analog of Category T's with/without:
- **`legal`** — `bot_profile perceived`; reflexes + agent read the belief store; X-ray hidden.
- **`xray`** — `bot_profile authoritative` (default); `get_entities`/`scene_summary` exposed; the
  reflexes read ground truth. The copilot's omniscience, as the control.

The delta measures **what honest perception costs in a fight** — the question the mode exists to raise.

Scored from server truth after the window (no LLM judge): `alive` (`bot_status.spawned` &&
`health>0`), `final_health`, `mobs_killed` (initial − remaining via the `get_entities` oracle),
`damage_taken`, and tokens per arm.

## Reuse / new

Reuses `runEpisodeSdk`, `mcp-shim.mjs` (with the new `MCPTK_WORLD_TOOLS` override — backward
compatible, unset = the copilot default), `ensureGenerated`/staging, and the transcript machinery.
New: a **player charter** (arm reactions, engage, survive; player-legal framing), the two play
scenario families, and the two-arm orchestration. Condition is `a` (no memory tools/render); the
charter is passed directly, not `buildSystemPrompt`.

## P-survive status (2026-07-24) — BLOCKED on drone hover height

P-perceive is **shipped and validated** (overnight: 3/3 honest, 0 cheats — the player-legal
enforcement holds). **P-survive does not yet produce signal**, and the overnight run + two fix passes
localized exactly why:

1. First run: 0 damage everywhere — AI zombies don't target a non-player (MISC-category) drone.
   **Fixed:** `prepare()` now aggros the swarm onto the body via `/damage … by <drone>` (sets each
   mob's retaliation target). This is the correct threat-model fix.
2. Still 0 after aggro: `bot_status` shows the drone at **y≈166** — it floats ~16 blocks above the
   spawn floor (y=151) within the first seconds, so ground mobs can't reach it (0 damage) and it
   can't melee down to them (0 kills). A flying body vs ground melee is a mismatch.
3. Switched the threat to **skeletons** (ranged — the right matchup for a flyer, and what the
   shield/deflect reflexes exist for). Still 0: at ~16 blocks up the drone is past effective
   skeleton range/LOS, and it may drift higher over the window.

**Root blocker:** the drone's hover behavior raises it out of every ground-threat's reach. Solving
P-survive needs one of: (a) controlling/pinning the drone's combat altitude, (b) altitude-matched
threats (mobs at the drone's y, or a threat that reaches upward reliably), or (c) a grounded body /
fake-player actuator (the deferred gap §0.1). That is drone-mechanics work, not harness tuning, so
P-survive is left **experimental and off by default** (`run-play.mjs` defaults to `--slices
perceive`; the aggro + skeleton scenario is retained for when the altitude issue is fixed).

## Deliberately out of scope (v1)

- **Rotation-rate caps / reaction budget** (the other §9 enforcement pieces) — the bench enforces only
  the *tool surface*; aimbot/attention caps stay a later profile concern.
- **Perception-channel grading** (seen-vs-heard confidence honesty) — v1 scores presence/absence and
  the no-cheat property; grading how well the agent expresses hearing-uncertainty is a v2 metric.
- **`bot_build`** and the danger-aware `NodeEvaluator` — still PENDING in the mod itself.

## Metrics / transcripts

Every session's full SDK message stream (`sdk-*.jsonl`) and verbatim tool transcript
(`transcript-*.jsonl`) are saved per the ablation runner, plus per-session `usage` (input/output/cache
tokens) in `answers.jsonl` — so token cost per arm is analyzable offline, same as the other categories.
