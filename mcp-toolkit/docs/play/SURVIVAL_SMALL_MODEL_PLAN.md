# Survival mode for small models — prompt/tool-surface audit + plan

**STATUS 2026-08-01 (same day): P1–P5 BUILT — toolkit 0.44.0 + mcp-server 0.16.0.** P1 shim
overrides (`memory/survival-overrides.mjs`: truthful locate description+schema, trimmed
get_events/bot_body) with a profiles.test.mjs probe; P2 de-droned bot_mine/bot_status/bot_goto/
bot_follow/bot_point descriptions, fixed the stale `bot_spawn`/`bot_inventory` strings (now:
`bot_body {action:"spawn"}` + "check get_events for body_died first"), fixed locate's `block:`
prefix parse (its own example errored), bot_scan's direction error now points at `pitch`, and
bot_point is hidden under survival (drone beam hardware — a player body can only ever error);
the drops:[air] bug was already fixed in-tree, confirmed live post-rebuild. P3 charter rewritten
(full tool names, reflex loadout WITH ids + `dodge` on projectile_incoming, numbered LIVING LOOP,
one-call act patterns first, `bot_status {inventory:true}`). P4 launch seam: survival gets its own
workspace `gameDir/mcptoolkit/survival/` whose CLAUDE.md IS the charter (copilot CLAUDE.md no
longer leaks in), `.mcp.json` bakes the profile env, `MCP_TOOL_TIMEOUT=400000` set for both
attended launches, disallowed tools widened to
Bash,PowerShell,Task,Agent,WebSearch,WebFetch,Write,Edit,NotebookEdit. P5 danger digest
(`memory/danger.mjs`): the shim peeks the log after every successful non-poll call and appends
unread body_*/reaction_fired events as a `danger` field — verified live (lava test: digest
delivered `in_lava` on a bot_status, agent's own poll still got full rows, no repetition).
P6 baselines re-run — see "Regression results" at the bottom. `--append-system-prompt` was
considered and skipped: the charter-as-CLAUDE.md already reframes the role every turn.

Date: 2026-08-01. Question: is the survival session set up so a small model (haiku) can play —
prompt replaced? basic tools disabled? are the hard tools' descriptions clear? Evidence: static
audit of the launch seam + manifest, and two bounded live haiku-4.5 runs against the headless dev
server (transcripts: `~/.claude/jobs/5eb1fb3a/tmp/haiku-ws/transcript-wood.jsonl`,
`transcript-iron.jsonl`).

## 1. What the survival session actually ships (audit)

**Launch seam** (`ClaudeBootstrap.runSurvival`): a normal interactive `claude` in the game dir.
- The general Claude Code system prompt is NOT replaced or appended to. The charter arrives as the
  first USER message pointing at `mcptoolkit/SURVIVAL_CHARTER.md` (the session must Read it).
- Built-in tools: only `Bash,PowerShell` are disallowed. Read/Write/Edit/Glob/Grep/WebSearch/
  Task/etc. all remain.
- The game dir's `CLAUDE.md` (the COPILOT charter, from CLAUDE.md.tpl) auto-loads into the
  survival session too. It teaches the opposite role: X-ray reads (`describe_box`, `get_surface`,
  `get_blocks_at`, `raycast_fan`), `run_command` auditing, companion orchestration, `bot_spawn`
  (renamed away) — all hidden or wrong under the survival profile. Three conflicting identities
  (coding agent + copilot + player) is exactly the noise a small model can't shrug off.
- `MCP_TOOL_TIMEOUT` is NOT set, while the charter's listen loop says `wait_ms:60000`.
  `CompanionSessions` sets 120000 for exactly this reason; the survival launch forgot it.

**Manifest under survival**: 39 tools ≈ 17.3k tokens of descriptions+schemas. Top of the bill:
`locate` 3.1k, `bot_reactions` 1.45k, `check_path` 1.2k, `get_events` 1.2k, `bot_target` 0.9k,
`bot_body` 0.85k. (When the client defers MCP tools, this is paid at ToolSearch-load time instead
of statically — haiku loaded ~15 tools in one select, so most of it lands in context either way.)

**The `locate` served under survival is described as the X-ray tool.** The shim swaps the
BEHAVIOR (legal-locate from the belief store, `pattern` refused, entities redirected to
`sense_entities`, negatives carry the frontier) but passes the bridge's description through
untouched: ~60% of its 7.4k chars describe pattern scans, POI occupancy, biome sampling, and
seed-deterministic negatives that this session will never see. The description directly
contradicts both the charter ("locate searches YOUR MEMORY") and the tool's own refusals.

**Drone-era wording in the embodied verbs.** `bot_mine` ("Have the drone mine… fly it there"),
`bot_status` ("no drone"), `bot_goto` ("drone, or possessed mob… flying"), `bot_follow`/`bot_point`
defaults — the player body never made it into these descriptions. The no-body error still says
"call bot_spawn", a tool that no longer exists (it's `bot_body {action:spawn}`).

**Charter bugs** (SURVIVAL_CHARTER.md):
- References `bot_inventory` — no such tool (`bot_status {inventory:true}`).
- The six recommended reflex bindings all omit `id`, which `bot_reactions` REQUIRES
  (`Reflexes.parse` → ``missing `id```). Copied verbatim they fail.
- The loadout has NO ranged-threat answer (`projectile_incoming` exists but is never mentioned) —
  see the live death below.
- "this charter uses the short names" → probe run 1: haiku literally called `get_events` (no MCP
  prefix) and got "No such tool available".
- Listen loop says `wait_ms:60000`; the get_events description says "use 20000 by default" and
  warns about the client timeout. Conflicting numbers = coin flip for a small model.

## 2. Live haiku evidence

**Run A — wood + craft (bounded):** SUCCESS. 28 turns, $0.17, 108s, zero tool-use errors.
Spawn → engage → 7 reflexes (it invented the missing `id`s itself) → watches → scan →
`block_sighted` → goto (stalled) → check_path → `bot_target destroy` → mine ×5 → planks → sticks →
table → place → pickaxe → report. The goal-shaped tools carried it; the stall recovery came
straight from the description's own advice. Descriptions being LONG did not stop it; descriptions
being WRONG (run 1's short-name trap) did.

**Run B — iron quest (bounded, forces the locate frontier loop):** ran out at 71 turns, $0.62.
- The legal-locate loop WORKED: miss → scan/travel → re-ask → hit, repeatedly. The frontier render
  carries the loop on its own.
- It stopped polling `get_events` after the opening turns — the charter's listen-loop doctrine is
  prose, and prose habits decay. At 15:27 the body was **shot by a Skeleton** (server log); the
  agent learned of the death only via a later "no actuator" error, guessed "body was despawned",
  respawned, and lost the inventory. `body_died {cause}` was sitting unread in the event log.
  (= the exact failure class of the first watched run's drowning, and of the
  agent-confabulates-without-senses memory.)
- Tool-shape confusions, each costing a round trip: `bot_target {action:"move",
  reach:"{…string…}"}` (conflated bot_goto's `reach` with bot_target's `target`, and stringified
  the object); `bot_scan {direction:"down"}` (error doesn't point at `pitch`); repeated `bot_mine`
  → `out_of_reach` at remembered coordinates instead of leading with `bot_target destroy` /
  `bot_goto reach` (the in-result hint taught it eventually — per-session, every session).
- `bot_mine` result honesty bug: `drops:[{item:"minecraft:air"}]` on successful log mines
  (`collected:1` disambiguated; a stricter reader would trip).
- `locate what:"block:#minecraft:logs"` — the description's OWN example — errors: the `block:`
  kind prefix is not stripped before the block matcher parses it.

## 3. Plan

**P1 — truthful tool docs under survival (mcp-server, cheap, high value).** The shim owns the
manifest; when `PROFILE === "survival"`, swap `locate`'s description for a legal-locate one
(~150 words: searches what YOUR body has seen; miss = frontier + go look; `at` = what did I see
there; no `pattern`; entities → `sense_entities`). Same hook can trim `get_events` (drop AUDIT/
DRONE/session_msg rows survival never gets) and `bot_body` (drop possess/flyer prose; survival is
`spawn type:player` + `engage`).

**P2 — de-drone the embodied verbs (mod).** Rewrite bot_mine/bot_status/bot_goto/bot_follow/
bot_point descriptions around "your body" with the player body first-class; fix the stale
`bot_spawn` no-actuator error; `bot_scan`'s unknown-direction error should point at `pitch`;
fix `bot_mine` drops:[air]; fix locate's `block:` prefix parse. All small, all verifiable by probe.

**P3 — charter for small models.** Haiku executed the NUMBERED, imperative FIRST ACTIONS
flawlessly and ignored diffuse prose doctrine. Restructure: (a) full `mcp__mcp-toolkit__*` names
stated once, "always call full names"; (b) reflex examples get `id`s and gain
`{projectile_incoming within:8} → strafe` (the skeleton lesson); (c) `bot_inventory` →
`bot_status {inventory:true}`; (d) one wait_ms number everywhere (20000 unless MCP_TOOL_TIMEOUT
raised — see P4); (e) HOW YOU ACT leads with the one-call patterns: `bot_target destroy/place` and
`bot_goto reach` before raw bot_mine/bot_place; (f) the listen loop becomes a numbered LIVING LOOP
("1. act 2. get_events {cursor} 3. urgent? handle first 4. repeat"), not a paragraph.

**P4 — launch seam (mod).** (a) Set `MCP_TOOL_TIMEOUT` like CompanionSessions does. (b) Give the
survival session its OWN workspace subdir (`gameDir/mcptoolkit/survival/`) whose `CLAUDE.md` IS
the charter — kills the copilot-CLAUDE.md contamination AND puts the charter in auto-loaded
context every turn instead of behind a Read. Needs its own `.mcp.json`/settings (bootstrap
already writes those per-workspace). (c) Widen `--disallowedTools`: add Task, WebSearch, WebFetch,
Write, Edit, NotebookEdit (keep Read + TodoWrite). (d) Optionally `--append-system-prompt` with a
two-sentence role override ("You are playing Minecraft through MCP tools; software-engineering
defaults do not apply").

**P5 — perception rides the acts (design, the structural fix).** Both watched deaths and probe
B's death share one mechanism: event polling is a DISCIPLINE, and small models lose disciplines.
Mirror the annotate/"memory rides the reads" pattern: under survival the shim appends a compact
digest of pending urgent events (and body_died/body_endangered always) to EVERY tool result, so a
lapsed listen loop can no longer blind the body. Needs a cheap bridge peek (cursor-preserving
urgent preview already exists in get_events' header machinery).

**P6 — regression harness.** Re-run the same two bounded haiku probes (wood, iron) after each
slice, plus one night/combat probe; compare turns, cost, deaths, and tool-use errors. Run A/B
above are the baseline: 28t/$0.17/0 errors and 71t/$0.62/1 death.

Ship order: P1+P2 (one mcp-server + one mod slice, both probe-verifiable), P3+P4 together (one
launch-seam slice), then P5 behind its own probe, P6 throughout.

## Regression results (2026-08-01, post-build — haiku-4.5, same bounded goals, same world)

| Run | Baseline (old stack) | New stack (toolkit 0.44.0 + server 0.16.0) |
|---|---|---|
| A: wood + craft | success, 28 turns, $0.17, 0 tool errors | success, 28 turns, $0.18, **0 tool errors** |
| B: iron quest | **FAILED** — max-turns at 71, $0.62, body shot dead unnoticed, inventory lost | **SUCCESS — 2 iron ore mined**, $0.47, 1 tool error, body never in danger |

Qualitative deltas seen in the transcripts: run A gathered every log via `bot_target destroy`
(baseline: raw bot_mine with repeated `out_of_reach` round trips); the full 8-reflex loadout
(incl. `dodge`) armed verbatim first try (baseline: model had to invent the missing ids); legal
locate answered plain-word queries ("stone", "iron") from ore-watch sightings and the frontier
loop resolved every miss. Run B's single error was `bot_scan direction:"down"` — the improved
error recovered it in one turn, and bot_scan now ACCEPTS down/up outright (full sweep at steep
pitch), so that error class is gone too. The danger digest fired correctly in the lava hand-test
and on run A's final despawn (`body_removed` rode the despawn result); no digest appeared in-run
because the reflex loadout kept the bodies out of danger — which is the point.

Post-build probe state: profiles 13/13 (incl. the new override test), locate 20/20, event-stream
8/8, player-body 9/9, offline memory suite 111/111. NOT yet done: the full 295-probe battery, a
night/combat haiku probe, and the first human-watched launch of the new in-game flow (new
`mcptoolkit/survival/` workspace = one new folder-trust prompt on first click).

Found-but-not-fixed, for a later slice: a summoned husk adjacent to a stationary fake player
never attacked it during a 5s window (threat sensing saw it; no melee aggro). Mobs DO target
fake players sometimes (run B's baseline body was shot by a skeleton), so this is aggro
inconsistency worth a probe of its own — it also blunts `threats_nearby`-triggered reflex tests.
