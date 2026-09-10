# Companion redesign — human-launched sessions, chat routing, IW-as-orchestrator

Handoff spec. Supersedes the wake-per-request model in `../archive/TOKEN_EFFICIENCY_PLAN.md §6` and
the authority rails in `../archive/COMPANION_DESIGN.md` (both archived for history).

> **STATUS: IMPLEMENTED 2026-07-21** (together with the session-concurrency substrate). See
> "Implementation record" at the bottom for the decisions taken on the open questions and what
> still needs a live-game verification pass.

## The inversion (why every change below hangs together)

The current design: the **mod** spawns companions, and **player chat is the trigger** (`ChatTools`
`CHAT_MESSAGE` → `CompanionSessions.onChat`). The rails — cooldown, `--max-turns`, hourly cap,
one-at-a-time — exist *because* that trigger is untrusted, unattended, and fires on arbitrary player
input.

The new design: the **human at the keyboard** is the only launcher (the Claude button menu). Chat is
no longer a spawn signal; it is a **routable input** delivered to a session the human designates.
Because nothing auto-spawns anymore, the containment rails lose their justification and are removed.
The companion becomes a **persistent headless agent** instead of an ephemeral bounded one.

Two roles, made explicit:

- **Interactive Workbench (IW)** — visible terminal, interactive `claude`, human-facing. Cheap
  control surface / orchestrator. Launched via `ClaudeBootstrap` (already visible; uses `cmd /c
  start`). Unbounded, governed only by workspace `.claude/settings.json`.
- **Companion** — **headless** (no visible console), non-interactive `claude -p`, persistent.
  Does the token-heavy in-world work. Launched via `CompanionSessions`.

## Requested changes

### 1. Disable auto-spawn on chat
- `ChatTools.java:68` — remove the `CompanionSessions.onChat(senderName, text)` call as a *spawn*
  trigger. Chat must no longer wake a session. (The `CHAT_MESSAGE` listener still logs the event to
  the event stream — that stays; it's how a bound session reads chat via `get_events`.)
- `CompanionSessions.onChat` (`:80-92`) and the `"claude"` / `"claude stop"` chat-keyword handling
  go away in their current form. `"claude stop"`-by-chat may be kept as a kill path if you want
  players to be able to halt a running session, but it must not be a spawn path.

### 2. Companion: remove cooldown and turn budget
In `CompanionSessions.java`:
- **Cooldown**: drop `cooldownSeconds` from `Config`, the gate at `:114-116`, the status string at
  `:203-205`, and `companion.cooldown_seconds` parsing at `:260`.
- **Turn budget**: drop `maxTurns` — remove `--max-turns` from the launch script (`:152`), the
  `companion.max_turns` parse (`:259`), and the "budget: N turns — work briskly" framing in the
  prompt (`:137-144`). The prompt should reframe the companion as a persistent worker, not a
  one-request throwaway (delete the "do NOT keep a standing listen loop… the game wakes a new
  session" tail at `:142-144`).
- `BridgeConfig.java:30-34` — remove/adjust the `companion.max_turns` and
  `companion.cooldown_seconds` template comments.

### 3. Claude button menu: launch-type choice + chat routing
In `ClaudeMenuScreen.java` (currently: one "Launch Claude session" button → always IW, plus the
bypass checkbox):
- **Launch type**: user picks **Interactive Workbench** or **Companion**.
  - IW → `ClaudeBootstrap.run(client)` (visible, interactive — unchanged).
  - Companion → `CompanionSessions` spawn (headless — see §4).
- **Chat responder selection**: a control listing currently-live sessions; the human picks which one
  receives chat, or **None**. `None` **is** the new `/claude mute` (see §5).
- Keep the bypass checkbox and the gold `[bypass]` button tag (`ClaudeButton.java:30-33`).

### 4. Companion must be genuinely headless
IW stays visible (`ClaudeBootstrap` uses `cmd /c start` → new console — keep). The companion must
have **no visible console**. Note: Java `ProcessBuilder` has no `windowsHide` (unlike Node `spawn`
`{windowsHide:true}` used in `mcp-server/local/dev.mjs`). The current companion launch
(`CompanionSessions.java:156-160`) is a bare `powershell -File` with discarded stdio, which still
gets a new console window under `javaw` (production). To force headless, wrap the launch (e.g.
`cmd /c start "" /b powershell …`, or a `conhost`-less strategy) and verify no window appears in a
**production** (`javaw`) run, not just a dev `runClient`. Output continues to go to the per-session
`.log` file, so nothing is lost by hiding the window.

## New machinery this requires: a session registry

Neither role is tracked today — `ClaudeBootstrap` fires-and-forgets its terminal, and
`CompanionSessions` holds a single static `active` field. The menu's "pick which session responds to
chat" needs an enumerable set of live sessions. Introduce a **session registry** (likely promote
`CompanionSessions` into it, or a new `Sessions` holder):

- Each entry: stable id/label, type (`IW` | `COMPANION`), `Process`, alive state, spawn time, and a
  `chatResponder` flag (at most one true).
- IW launches register too (so they can be the chat responder — important for the next step).
- The menu lists entries and sets the responder; the event/chat delivery path consults it.
- `stop`/kill targets an entry by id. Server-stop still kills all (keep the `SERVER_STOPPING` hook at
  `:69-74`).

This registry is the substrate for the next step (below), so design its identity model with that in
mind.

## Decisions to confirm with Matthijs (beyond the literal ask)

1. **One-at-a-time & hourly cap.** Not named for removal, but the singleton (`active != null` →
   refuse, `:110-112`) and `max_sessions_per_hour` (`:120-122`) both block having *multiple*
   companions — which the sub-agent step (below) requires. Recommend: drop the singleton, keep the
   hourly cap only if you still want a runaway backstop now that launches are human-driven (probably
   drop it too).
2. **Chat delivery mechanism.** With a persistent companion, does the bound session run a standing
   `get_events {type:"chat", wait_ms}` loop (re-introduces the standing-listen token cost §6 killed),
   or does the mod push chat only to the responder? The persistent-worker model tolerates the standing
   loop; the orchestrator model (next step) may prefer the IW holding the loop and delegating.
3. **`/claude` commands** (`ChatTools`): `wake` no longer makes sense as a chat-spawn; `status`
   should list registry entries; `stop` needs a target; `mute`/`unmute` map to setting the chat
   responder to None. Redefine or remove.
4. **Mute persistence.** Is "responder = None" transient (in-memory) or persisted like the bypass
   toggle (`companion.permission_mode` in `mcptoolkit.properties`)?

## The next step this sets up: IW spawns companion sub-agents

With human-launched sessions, a registry with identities, and unbounded headless companions, the IW
becomes an **orchestrator**: its interactive loop (cheap, human-facing) spawns and directs one or
more headless companions that do the token-heavy world interaction (`place_blocks`, pathing,
perception sweeps, edits). Chat can route to the IW, which delegates; or directly to a companion.
Implication for this pass: build the registry and the companion spawn path so an **agent** (the IW),
not only the menu, can create/label/stop companions — i.e. expose spawn/stop/list as tools or a
documented invocation the IW can call, with the same headless + bypass-aware authority handling the
menu uses. Don't build the orchestration yet, but don't foreclose it.

## Implementation record (2026-07-21)

All four requested changes plus the session-concurrency substrate are in. Key files:
`Sessions.java` (new registry), `BridgeServer.java` (`/hello`, `X-MCPTK-Session` header →
per-request `ToolContext.sessionId()`, session-stamped audit), `CompanionSessions.java`
(rewritten: persistent headless spawns via wscript+`.vbs`, no rails, orphan reaping,
`companion_spawn`/`companion_stop`/`session_list` tools), `ChatTools.java` (chat no longer
spawns; `/claude responder <id|none>`; "claude stop" kept as process-level kill of all
companions), `EventLog`/`EventTools` (chat routing enforcement), `DroneTools`/`DroneHands`
(drone command lease per session), `ClaudeMenuScreen` (launch-type choice + chat routing
picker), `ClaudeBootstrap` (workbench registers + carries `MCPTK_SESSION`), plus the Node shim
(hello/header) and memory store (cross-process lock, disk-synced id allocation, per-session
task frames) in `mcp-server/`.

Decisions on the spec's open questions:

1. **One-at-a-time & hourly cap: both removed.** Multiple concurrent companions are required
   by the orchestrator step; launches are human- or orchestrator-driven now.
2. **Chat delivery: pull, with mod-enforced routing.** The bound responder reads chat via
   `get_events` long-polls (60s); the mod filters chat events away from every other session,
   and an explicit `type:"chat"` request from a non-responder fails fast instead of silently
   starving. No push channel was added.
3. **`/claude` commands**: `wake` removed; `status` lists the registry; `stop` kills all
   companions; `responder <id|none>` sets/clears routing; `mute`/`unmute` unchanged as the
   hard switch.
4. **Mute persistence**: the menu's "None (muted)" maps to the existing persisted marker-file
   mute. The responder *binding* itself is in-memory (ids die with sessions/restarts anyway);
   an unbound, unmuted state means all sessions hear (legacy broadcast). A newly launched
   workbench/companion auto-binds as responder only when nothing live is bound and chat is
   not muted.

Additional substrate beyond the literal spec: session-attributed audit events,
orphan-companion reaping at mod init (persisted pid file — unbounded headless orphans must
not survive a game crash), companion artifact pruning (7 days), per-session memory task
frames with a multi-frame render.

### Second pass (same day): per-session drones + inter-session conversation

- **Per-session drones** (supersedes the interim single-drone lease): each session gets its own
  `DroneTools.Slot` (drone, flight, dig, `DroneObserver` instance) keyed by session id
  (anonymous callers share the legacy `anon` slot). `bot_spawn` replaces only the caller's own
  drone; `drone: true` perception origins resolve to the caller's drone; drone events
  (action feedback, damage, removal, enter/leave radius, nearest threat) are **targeted** at
  the owning session in the event log (`EventLog` entries carry an optional `to`). A drone is
  **session-bound**: a periodic server-tick sweep destroys it (inventory dropped,
  `drone_removed reason:session_ended` broadcast) once its owner is no longer live.
- **Heartbeat liveness**: the shim POSTs `/heartbeat` every 30s with its session header;
  registry staleness for process-less sessions dropped from 30 min to 3 min, so disconnects
  (closed workbench terminal, killed external session) reap bound resources within minutes.
- **Inter-session conversation**: `session_send {to, message}` (PRIVILEGED, audited, 2000-char
  cap) emits a targeted `session_msg` event with `from`/`from_label`; recipients see it in
  their `get_events` stream and reply the same way. `get_events` `type` now accepts a
  comma-separated list (`"chat,session_msg"` is the canonical companion listen-loop filter);
  a request for ONLY chat by a non-responder still fails fast, but a multi-type request
  degrades silently to the other types. Companion and workbench prompts + the charter teach
  the ask/answer flow; `companion_spawn`'s description points at it.

Needs a live verification pass (not yet run against a game): headless-ness of the wscript
launch under production `javaw` (spec §4's explicit ask), the CycleButton initial-value
behavior in the menu, and an end-to-end exercise of two sessions with their own drones
conversing over session_send while chat is routed.
