# Survival Mode — the legal profile becomes runnable, watchable play

Date: 2026-07-30. Status at end of day — **the mode is LIVE end to end**:
- mcp-server **0.11.1**: `survival` profile + perceived lock + client-surface hides, legal locate
  with frontier negatives + seen-fraction ledger, ambient autofan. Offline suites 97+22+133; live
  `profiles.test.mjs` 11/11 on a client instance.
- toolkit **0.33.0**: in-game **Launch Survival Player** (visible terminal, env by ProcessBuilder,
  bundled charter, `--disallowedTools Bash,PowerShell`), `ServerExtract.ensureFresh` before every
  spawn, walker player-render + `WalkerThreat` + nameplates + `/mcptk body [tp]`.
- toolkit **0.34.0**: **the §11.8 widening (BOT_SURFACE §11.8b)** — `bot_body spawn type:"player"`
  is the survival body; `player-body.test.mjs` 9/9, regression sweep 73/73.
- Slice 1 REVISED to mod-side (§4 — embodied results carry no tick envelope). Still open: player
  hands v2 + player goal loop, proprioception, vantage goal (§7), and the human-watched smoke. Companion to `PLAYER_CONTROL_DESIGN.md` (§9 profile design, §10 status),
`CATEGORY_P_DESIGN.md` (the bench that enforced legality per-session), `MEMORY_REDESIGN.md` §12
(the legal locate / cycle-4 design this plan pulls forward), and `TOOL_BILL_PLAN.md` §4 (the
profile mechanism).

## 0. Goal and the one-sentence test

A human starts the dev client, a Claude session starts with `MCPTK_PROFILE=survival`, a walker
body spawns beside the player, and the agent **plays survival legally while the human watches**:
it perceives through its senses (belief store + sightlines + its own memory), navigates real
terrain, fights, eats, and answers "where is X?" only from what it has actually seen.

**Litmus (from PLAYER_CONTROL_DESIGN §9):** for any capability on this surface, name the
perceptual signal it reacts to and the bodily action it takes. If you can't name a legal signal,
it's a cheat and it's off the surface.

## 1. What already exists (verified 2026-07-30)

- The capability stack: reflexes, engage, equip, consumables, shoot, `sense_entities`
  (FOV+LOS+hearing belief store, 0.12.0), `bot_profile perceived` (0.13.0), walker body with
  vertical edges + bridging (0.27.0). All live-probed.
- The tool-surface enforcement exists **only in the bench** (`play-scenario.mjs` TOOLSETS via
  `MCPTK_WORLD_TOOLS`); no server profile ships it (`PROFILES` = full/standard/play/survey).
- Deliberate-read capture is built (cycle 2, mcp-server 0.10.x): `raycast`/`raycast_fan` (and the
  X-ray reads) feed the observation store; the annotate appendix rides results. The `channel:
  deliberate|ambient` field is reserved in the store design (§2.3) — **nothing writes ambient yet**.
- `locate` already falls through to memory for unresolvable `what` (MEMORY_REDESIGN §3); the
  provenance-filtered legal route (§12) is designed, pre-registered, unbuilt.

## 2. What this plan deliberately does NOT include

- **Rotation-rate caps and the reaction budget** (§9's other enforcement pieces) — benchmark
  honesty, not needed to play or watch. Unchanged PENDING.
- ~~**Crafting / smelting / container UIs** — no such capability exists anywhere in the toolkit
  (verified); survival v1 is *combat/exploration survival with operator-provided gear*, not
  tree-punching progression. Own future design.~~ **ALL OF IT SHIPPED, and this line outlived its
  truth by a year — do not read the exclusion list as current.** `bot_craft` landed in 0.35.0
  (BOT_SURFACE §13.3), `bot_container` in 0.38.0 (§12.6: furnaces, chests, hoppers — smelting works,
  and it is not a verb because loading a furnace is the whole of what a player does), and 0.88.0
  added smithing + stonecutting to `bot_craft` (§13.4) and a real readout for brewing, which had been
  reachable through `bot_container` the whole time with nothing naming it. What remains excluded is
  narrower and deliberate: the **menu-only** stations whose outputs are not recipes (anvil,
  grindstone, loom, cartography), because a verb for those would have to simulate a screen. No
  container UI is simulated anywhere; every gate is world truth.
- **Legal `check_path`.** The nav solver reads the true world; a fully legal path predictor would
  plan over observed cells only. v1 KEEPS `check_path` and names the edge in this doc — the body
  has walked enough of the world that prediction-over-truth is mostly indistinguishable, and
  hiding it would push the agent into blind trial navigation. Flagged, not hidden. Revisit when
  the observation store can back the solver.
- **FakeServerPlayer as the body.** ~~It walks (0.27.0) but has no hands/goal loop~~ **SHIPPED
  v1 (toolkit 0.34.0, same day — BOT_SURFACE §11.8b): the widening landed and `bot_body spawn
  type:"player"` is the survival body.** Real tab-list player, hunted natively by hostiles,
  real hunger + inventory (auto-collects drops), `Player.attack` combat, real eating, walks and
  sprint-jumps on `PlayerNavigation`. Still honest v1 gates: mine/place/use/shoot and `bot_target`
  goals refuse with named pending-slice reasons — the charter says to fall back to the walker for
  mining tasks until player hands land.

## 3. Slice 0 — the `survival` profile (mcp-server)

`PROFILES.survival` in `index.mjs`. Composition (from full):

- hide `DEV_ONLY` (as `play` does);
- hide the operator/world-edit surface: `run_command`, `set_blocks`, `place_blocks`,
  `place_shape`, `undo_edit`, `list_edits`, `bot_give`, `resolve_anchor`, `check_site`;
- hide the X-ray reads: `get_entities`, `scene_summary`, `get_surface`, `get_blocks_at`,
  `describe_box`, `get_region_summary`.

Kept (the legal surface): `ping`, `get_world_info`, `query_registry` (game-rule knowledge is
model knowledge — a player knows recipes; legality governs *instance* knowledge),
`send_chat` + `get_events` (chat/events the client also renders — flagged: events carrying
non-perceivable world changes are an edge to audit), `locate` (**legal-routed**, slice 3),
`raycast`, `raycast_fan`, `check_path` (flagged §2), `sense_entities`, all `bot_*`, all `mem_*`
(the agent's own notebook is legal — §12.2's authored-record caveat noted there).

**Perceived mode is forced, not requested.** Under `MCPTK_PROFILE=survival` the shim (a) rejects
`bot_profile {perception:"authoritative"}` locally (`legal_profile_locked`), and (b) after every
successful `bot_body {action:"spawn"|"possess"}` fires `bot_profile perceived` at the bridge
(loud on failure). The profile is then legal by construction, not by charter goodwill.

Probe: `profiles.test.mjs` gains survival assertions (hides only real names; keeps the legal
keep-list; hides every X-ray name; `standard`'s exact-three-names assertion untouched; bench
pinning in `testbench/agent.mjs` untouched). Version: mcp-server minor bump.

## 4. Slice 1 — proprioception: traversal is observation

A player knows the corridor they walked through. The body's own passage becomes legal knowledge:
cells traversed are confirmed air (feet+head), cells stood on are confirmed solid.

**REVISED after a live check (2026-07-30): this is MOD work, not Node work.** Embodied results
(`bot_status` and friends) carry **no `game_tick`/`dimension` envelope**, and the capture contract
is explicit: an untick-stampable read is not capturable ("a world read without its envelope cannot
be honestly dated/placed"). Resolving the tick with an extra bridge call per capture is the exact
traffic-doubling capture.mjs was designed to avoid. There is also a value problem: Node only knows
the body's *position*, not what the occupied cells contain (a swimming body's feet cell is water,
not air) — recording air would index unknown as fact.

So proprioception ships mod-side with the slice-4 rebuild: (a) embodied verdicts gain the standard
tick/dimension envelope (cheap, and independently useful), and (b) nav completions carry the
traversed node list with the driver's own footing knowledge — real ids, honest ticks. The
`proprioception` tool name is already reserved in `LEGAL_OBSERVATION_TOOLS`. Until it lands, the
ambient autofan (§5) is the coverage source — the fan's downward rays see the floor the body
walks over, which covers most of what traversal would.

**Concrete design (2026-07-30, building now):**

- *Mod:* an `EmbodiedEnvelope.stamp(result, body)` helper (the read-side `addEnvelope`'s embodied
  twin: `game_tick` + `dimension` from the body's own level) applied to embodied verdicts —
  `bot_status`, `bot_look`, `bot_goto` start + completion, `bot_target` verdicts, and the hand
  verbs' sync results and `action_completed`/`action_failed` payloads. The grounded navigations
  (walker + player — a flyer's feet read nothing) record a **traversal trail** as the path
  advances: per reached node `[x, y, z, feet_id, head_id, ground_id]`, read at traversal time
  (a swimming body's feet honestly record water, never assumed air). Nav completions and goal
  verdicts carry it as `traversed`, capped at the path ceiling.
- *Node:* `captureProprioception(result)` in `capture.mjs` — a direct store write (tool
  `"proprioception"`, the reserved provenance name; the record's cells are the trail's feet/head
  cells with their real ids plus the ground cells), envelope-gated exactly like every capture.
  Hooked wherever a `traversed` payload can surface: the tool result itself (`wait:true` verdicts)
  and `get_events` results (polled completions) — both in index.mjs and the ablation shim, so the
  legal bench arm (§12.5) sees the same physiology. One honest limit, documented: the record is
  stamped at the completion tick, so cell freshness is overstated by at most the nav's own
  duration.

## 5. Slice 2 — ambient autofan (`MCPTK_OBS_AMBIENT`, name reserved by §2.5)

The legal profile's retina (§12.4), pulled forward as designed: **a sensor writing without
anyone reading the result.**

- Shim-side v1, zero mod changes: while the session has recent embodied activity (any `bot_*`
  call in the last N s — no polling an idle session), a timer fires `raycast_fan` from the body's
  eye every ~2 s as a **forward cone** (respects facing; a 360° sweep is a slow X-ray and will
  collide with future rotation caps).
- The result is captured to the store with `channel:"ambient"` and **never enters the model's
  context**. `observations.mjs` starts writing the reserved channel field; the §2.3 comparand
  rule stands: last-*deliberate* remains the delta comparand, ambient enriches
  ("ambient scan saw it gone ~40m ago").
- Off by default everywhere; `on` in the survival runbook. Bench arms unaffected (they pin their
  env; ambient stays off unless an arm asks).

Tests: fake-timer unit tests for the trigger window + channel labelling; a live probe that walks
the walker past a pillar and asserts the pillar's cells appear in the store without any
deliberate read.

**§5c — SMOKE 5: the retina was blind, and the agent hand-rolled the sense (fixed, mcp-server
0.13.0).** The second watched run could not find logs, the fan "was not being done continuously and
nothing was built up", and the agent fell back to endless single `raycast` calls. Three causes:

1. **The activity window was gated on `bot_*` calls only** (`noteEmbodied`). `lastActiveAt` starts at
   0, so the retina fired for 30s after the body spawned and then went silent for the rest of the
   session — because `raycast`, `locate` and `mem_*` did not refresh it. The agent's fallback
   (hand-rolled rays) did not refresh it either, so **the blindness reinforced itself**. Now ANY
   successful call refreshes the window: the guardrail that matters is "an ABANDONED session must
   not poll the bridge forever", and any tool call disproves abandonment. The retina had NO tests of
   its own — `memory/probes/ambient.test.mjs` now covers the window arithmetic, including the
   perception-only session as an explicit regression.
2. **`raycast` was still exposed** (§5b hid only the fan, keeping the single ray as "the focused
   look"). That was the wrong call: with the retina quiet, a hand-aimable ray is how an agent
   re-implements the sense the profile exists to automate, one call at a time. The WHOLE family is
   hidden now — looking is automatic (retina) or embodied (`bot_scan`). Both remain legal provenance
   names. The legal bench arm drops it too, for parity.
3. **`locate what:"logs"` could not match `oak_log`.** The matcher compared one needle, so the plural
   and the tag form (`#minecraft:logs`) both missed a store that held them — a false negative wearing
   an honest negative's words, which is the one thing this profile must never produce. Queries now
   contribute several needles (bare, un-namespaced, un-tagged, de-pluralized incl. -ies/-ves).

**§5b — the fan stops being a tool; `bot_scan` is the deliberate look (designed 2026-07-30).**
With the retina live, a hand-called `raycast_fan` under `survival` is redundant at best and a
fan-spam X-ray at worst — so the survival profile now HIDES `raycast_fan` (it remains the retina's
internal sensor and a legal provenance name; hidden ≠ illegal). What replaces the deliberate call
is embodied: **`bot_scan {direction?, arc?, pitch?}`** — a local (Node) tool, shared with the
ablation shim via `memory/scan.mjs`, that turns the BODY (real `bot_look` steps, watchable in
game), fires the retina's own fan args at each facing, captures every fan **deliberate** (a
commanded look moves the last-deliberate comparand; the annotate appendix rides the scan like any
read), and returns ONLY the summary — coverage before/after from `legalCoverage`, sectors swept,
plus the appendix. No block data enters context; memory rides the reads. A 360° arc is 4 fan
steps at 90° — deliberately paced by real look calls, not an instant omniscan. `locate`'s
frontier/miss guidance (legal-locate.mjs) retargets from "go look (raycast_fan)" to "scan
(`bot_scan`), or travel, then re-ask" — with a direction, straight from `least_explored`.

## 6. Slice 3 — legal locate + frontier-carrying negatives (MEMORY_REDESIGN §12, v1)

Under `survival`, `locate` never runs the bridge's X-ray search. It answers from the observation
store through a **provenance filter**: `LEGAL_OBSERVATION_TOOLS` = sightline reads (`raycast`,
`raycast_fan` deliberate + ambient) + proprioception + the agent's authored places/notes. A
copilot session's `describe_box` cells sit in the same store, labelled, invisible here (§12.2).

**The negative must carry the frontier.** §12.2: the legal locate can never prove absence.
So "not found" returns, instead of silence: seen-coverage within the query radius (fraction of
columns/cells with any legal observation) and the **nearest unobserved region toward the query**
— a direction + distance the agent can turn into a look-or-travel plan. That is the entire
occlusion answer at the query layer; the behavioral half is slice 4 and the body's existing
rights (walk around, or `may_modify: break` through).

Store additions: provenance-filtered cell/point queries + a coarse coverage/frontier query
(chunk-section granularity is enough for v1 — the frontier is a navigation hint, not geometry).
Tests: store-level (no bridge) + a shim-level probe asserting a survival-profile `locate` (a)
finds only legally-seen things, (b) returns frontier hints on a miss, (c) the same query under
`full` still X-rays. Ships in the SAME mcp-server release as slice 0 — the profile must never
exist with a leaking or dead `locate`.

## 7. Slice 4 — the vantage/explore goal (mod-side, after first watchable session)

`bot_target` gains a `vantage` goal: given a target region (or a frontier hint from slice 3),
the solver finds a reachable cell with LOS into the region, navigates there, faces it, and
verdicts honestly (`los_achieved` / `no_vantage_reachable`). Reuses the walker search +
`ReachSolver`-style LOS checks. With slices 2+3 the loop closes: locate miss → frontier hint →
vantage goal → ambient fan fills the store → re-ask locate.

Deliberately LAST: the agent can hand-roll goto+look+fan today; build after the smoke session
proves the loop is worth one intent. Toolkit version bump, conformance spec, live probe.

**Concrete design (2026-07-30, building now):** `bot_target action:"vantage"` with a block-ish
target (`at`/`handle`). The solver samples candidate stand columns on rings around the target
point out to a `range` (default 24): a candidate needs standable footing (solid below, two clear
cells) and **eye-to-target LOS** (a collider `clip` from the candidate's eye height). Candidates
are tried nearest-the-body first through `Bodies.nav.moveToStands` — the same reach-goal shape
`bot_goto reach:` uses. On arrival the body faces the target and the LOS is re-verified LIVE
(arrival is not the verdict; seeing is): `outcome:"achieved"` with `los:true`, or the loop tries
the next candidates, conceding `no_vantage_reachable` with the standard obstruction locus. With
§5b the loop closes as one legible cycle in the transcript: locate miss → frontier direction →
`vantage`/`bot_scan` → retina fills the store → re-ask.

## 8. Slice 5 — charter + runbook + smoke

- **Charter:** BUILT — `SURVIVAL_CHARTER.md` (player, not copilot; reflexes/engage; belief-store
  perception; the frontier loop: "a locate miss gives you the frontier — go look").
- **Runbook — REVISED 2026-07-30 after the first smoke attempt: the launch is IN-GAME.** The
  hand-typed env launch failed silently (PowerShell `set X=Y&` sets nothing → the session ran the
  default profile: X-ray locate answered, `get_screen` visible, drone body). Three fixes shipped
  (toolkit 0.33.0, mcp-server 0.11.1):
  1. **Client-context tools hidden** from `play`/`survey`/`survival` (`CLIENT_SURFACE` in
     index.mjs) — `get_screen` reads the HUMAN's screen; conditional-presence warning suppressed
     for exactly that set; probes extended (11/11 live on a client).
  2. **`Launch Survival Player`** in the in-game Claude menu → `ClaudeBootstrap.runSurvival()`:
     an ATTENDED session — a VISIBLE PowerShell window running interactive `claude` (revised same
     day: the headless variant was first built on the companion path, which (a) was gated on
     `companion.enabled=false` and silently spawned nothing, and (b) hid the tool calls, which are
     the whole point of a watch-session). `MCPTK_PROFILE=survival` + `MCPTK_OBS_AMBIENT=on` set by
     ProcessBuilder (unloseable); the charter is written to `mcptoolkit/SURVIVAL_CHARTER.md` in the
     game dir every launch (machine-owned, evolves with the mod) and the terminal prompt points at
     it (the inline prompt slot cannot carry markdown safely). Registers as an attended session
     (kind workbench, label "survival") — routable in the Chat picker; closing the window stops it.
  3. **`ServerExtract.ensureFresh`** — spawns refresh the workspace's extracted mcp-server first
     (the run-dir copy was at 0.2.0, months stale — it would have silently lacked the profile
     even with the env right); shared with the workbench bootstrap; dist bundle now includes
     `ablation/view.mjs` (index.mjs imports it — a fresh extract used to be un-runnable).
  Watching: press Esc → Claude → **Launch Survival Player**; optionally set the Chat picker to the
  survival session. Starter gear is an operator act (drop items at the walker). **Open question
  for the smoke:** whether the walker auto-picks-up dropped items — resolve live and record here.

  **Watchability fixes (same day, after smoke 3 — "still a drone / not targeted / can't
  tp/spectate", all one root: the body is not a Player-class entity):** the walker now renders as
  a player (`WalkerRenderer`, vanilla player geometry + default skin — it had been reusing the
  drone-ball renderer); every Monster gets a line-of-sight `NearestAttackableTargetGoal` for
  walkers at load (`WalkerThreat` — verified: an unarmed night-spawned probe walker was hunted
  dead in under two minutes); bodies spawn nameplated with their session id; and `/mcptk body`
  lists bodies / `/mcptk body tp [session]` teleports the watcher to one. These are interim: the
  REAL fix is the FakeServerPlayer widening (§2 last bullet), now explicitly the next mod slice.
- **Smoke:** survive-the-night with at least one legal-locate miss→frontier→look cycle observed
  in the transcript, and mem_recent's "while you were away" fed by ambient sightings.

## 9. Order, sizing, versions

| # | Slice | Side | Size | Ships as |
|---|---|---|---|---|
| 0 | survival profile + perceived forcing | mcp-server | S | **0.11.0 BUILT** |
| 3 | legal locate + frontier | mcp-server | M | **0.11.0 BUILT** |
| 2 | ambient autofan | mcp-server | M | **0.11.0 BUILT** |
| 5 | charter + runbook | docs | S | **BUILT**; smoke pending the human |
| 1 | proprioception + embodied tick envelope | mod | M | toolkit 0.33.0 (with slice 4) |
| 4 | vantage goal | mod | M | toolkit 0.33.0 |

Doctrine per slice: probe before commit; loud failure over silent narrowing; bench baselines
pinned `full` are untouched; every hidden name must exist (profiles.test.mjs); version bump per
release touching mcp-server or the mod.
