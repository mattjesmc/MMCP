# Token-efficiency plan — smarter tooling for the companion loop

> **ARCHIVED — completed plan; §6 later reversed.** Sections 1–5 and 7 shipped and remain live
> (their current description is `../ARCHITECTURE.md`). §6's wake-per-request companion model was
> superseded 2026-07-21 by `../COMPANION_REDESIGN.md` (human-launched persistent sessions; the
> cooldown/max-turns/hourly-cap rails were removed from the code). Historical record only.

> **STATUS: IMPLEMENTED 2026-07-20** (all seven sections; live-tested against the dev server on the
> Soak Plateau outposts — long-poll 20s verified, scan_box/raycast_fan surveyed a real outpost in
> 3 calls / <7KB total, supersede hygiene verified, wake→session→send_chat→exit loop verified with
> rails, 211 of 219 pending backlog swept via bulk dismiss). Known pre-existing issue, NOT from this
> work: non-ASCII in send_chat (em dashes) arrives double-encoded somewhere in the claude→MCP stdio
> pipeline on Windows — visible in the 2026-07-20 17:37 transcript too. Workaround: keep chat ASCII.

Drafted 2026-07-20 from the token audit of the first live companion session
(`3f0da270…jsonl`, 17:37–18:02): 76 API calls, 202k cache-write / 4.38M cache-read /
35k output tokens (~$9–10 API-equivalent), context 36k → 103k in 25 minutes.
Three structural sinks: idle polling re-reads the whole context (~$11–28/hr while
doing nothing), one cache-invalidation incident caused 50% of all cache writes,
and perception outputs are verbose enough to trigger it.

Six fixes, ordered by leverage-per-effort. §1–§4 are code changes in this repo;
§5–§6 are workflow/supervisor changes that this repo's docs anchor.

---

## 1. Compact JSON at the proxy (trivial, everything benefits)

`mcp-server/index.mjs` serializes every tool result with
`JSON.stringify(result, null, 2)`. Pretty-printing inflates every result ~25–40%
(indentation + newlines are tokens), and every inflated result is then re-read by
every subsequent API call for the life of the session.

**Change:** `JSON.stringify(result)` — compact, both call sites (the `rest` of an
image result, and the plain result path).

**Effort:** one line. **Impact:** ~30% off all bridge tool results, compounding.

## 2. Cheap idle listening — extend the long-poll chain

Each `get_events` poll turn costs a full cache read of the entire context
regardless of how long the server waited (observed: ~4.6 polls/min at
`wait_ms:10000`, i.e. ~$11/hr of reads at 40k context, ~$28/hr at 100k — and the
context only grows). Fewer, longer polls are strictly better: same latency for a
message that arrives mid-wait, linearly fewer reads while quiet.

The cap chain today: `EventTools.MAX_WAIT_MS = 10_000` < bridge
`COMMAND_TIMEOUT_SECONDS = 15` < MCP client tool timeout (Claude Code default
~30s, configurable via `MCP_TOOL_TIMEOUT`; Node `fetch` in index.mjs has no
timeout of its own).

**Changes:**
- `ToolDef`: optional per-tool dispatch timeout (default stays 15s).
  `get_events` declares e.g. 70s.
- `EventTools.MAX_WAIT_MS` → 60_000, but the *effective* default cap stays 25s
  unless the caller passes more (25s fits under an unmodified Claude Code MCP
  timeout; the tool description documents that `wait_ms > 25000` requires
  raising `MCP_TOOL_TIMEOUT` in the client env).
- `BridgeServer` HTTP pool: 4 fixed threads → cached daemon pool (or 8). A 60s
  parked poller must not starve concurrent tool calls (the pool comment already
  flags this for 10s parks).
- Update the standing-listen guidance in CLAUDE.md / COMPANION_DESIGN.md to
  `wait_ms: 25000` (or 60000 with the env bump).

**Impact:** idle read volume −60% at 25s, −78% at 60s. Combined with §5, idle
cost approaches zero (the supervisor polls for free; sessions only exist while
working).

## 3. Output budgets — keep every result under the history-mutation threshold

The 17:52 incident: two consecutive calls re-wrote 47.5k + 53.3k tokens of cache
(reads collapsed to exactly the 30,335-token tools+system prefix, twice). Cause
consistent with the harness swapping oversized tool results out of history for
persisted-file references — a mid-history byte change invalidates everything
after it. That one incident was ~50% of the session's total cache-write cost.

Rule: **no bridge tool response may exceed ~8KB serialized** — comfortably under
the harness persistence threshold, so history is never mutated retroactively.

**Changes:**
- `get_blocks`: the default response is up to 1089 `{x,y,z,block}` objects
  (~60KB pretty-printed — a guaranteed incident). Add `detail: "summary" |
  "full"`, default **summary**: origin, covered_radius, palette histogram
  (block → count), height min/max/mean, plus only *anomalous* columns (blocks
  not in the top-N palette — the "there's a structure here" signal). `full`
  keeps today's shape but with a palette + indexed columns encoding
  (`palette: [ids], columns: [[x,y,z,paletteIdx],…]`) and a hard 8KB truncation
  with `truncated: true` + `covered_radius` (the honesty contract already
  exists).
- `get_entities`: drop `uuid` and `velocity`/`speed` from the default row
  (opt-in via `detail: "full"`); they're rarely load-bearing and cost ~40% of
  each entity object.
- `BridgeServer.handleCmd`: belt-and-braces guard — if a serialized result
  exceeds 8KB, log a warning naming the tool (so oversized tools get fixed at
  source rather than discovered in a token audit).

**Impact:** eliminates the cache-rebuild failure mode (~100k cache-write tokens
in one 25-min session); shrinks scan results 5–10×.

## 4. Composite scans — one round trip instead of a raycast fan

The house survey took 37 single raycasts plus get_blocks/get_region calls. Every
round trip costs a full-context API call *and* leaves a tool_use/result pair in
history forever. The perception ladder is missing a rung between "surface
heightmap" and "one ray".

**New tools (WorldPerceptionTools):**
- `scan_box` — read a bounded volume (`min`/`max`, cap ~32×32×32) and return a
  *description*, not the blocks: material histogram, bounding box of non-air,
  per-material bounding boxes for the top materials, detected openings (air
  columns in shell faces), y-profile (blocks per layer). Purpose-built for
  "match this house's footprint and materials". `detail: "full"` returns
  palette+RLE layers within the 8KB budget for when exact geometry matters.
- `raycast_fan` — N rays from one origin (yaw/pitch ranges + step, or explicit
  direction list; cap 64 rays). Result: compact per-ray hits
  `[dYaw, dPitch, blockId, dist]` with consecutive same-block hits run-length
  merged. One call replaces the 5–15-ray bursts the session used for
  verification passes.

**Impact:** the transcript's ~20 scan-related round trips become ~4; the
build-verify workflow (scan → plan → build → verify) fits in 4 calls total.

## 5. Event hygiene — stop manufacturing pending spam

219 pending candidates accumulated, headed by runs of
`bot_goto a-55x FAILED: superseded`. Two compounding causes:

1. **Source:** `DroneTools.gotoTool` fails the outstanding flight with
   `action_failed reason=superseded` every time a new goto replaces it — which
   is *normal control flow* when tailing a moving player (the companion re-issues
   goto continuously). A supersede is not a failure.
2. **Classifier:** `tools.mjs classifyEvent` promotes **every**
   `action_completed`/`action_failed` to a pending-memory candidate.

Every candidate costs render lines at session start and nags until acknowledged;
the backlog also makes `[pending]` useless as a signal.

**Changes:**
- `DroneTools.failPending("superseded")` → emit type `action_superseded`
  (still on the event log — auditability keeps everything), reserving
  `action_failed` for real failures (`no_path`, `drone_despawned`, …).
- `classifyEvent`: ignore `action_superseded`; for `action_completed`, only
  classify non-arrivals (`arrived: false`) — a completed goto that arrived is
  routine, the *outcome the agent narrates* is the memory, not the mechanics.
  Keep `action_failed` classification.
- `mem_dismiss`: accept `{rule: "action_outcome"}` (bulk-by-rule) alongside
  `event_ids`, so a backlog sweep is one call.
- One-time cleanup: next companion session dismisses the current 219 (single
  bulk call once the above lands; until then `mem_dismiss` with the id list).

**Impact:** the SessionStart render (currently 15.5KB) stops carrying a
permanent nag section; every future session bootstraps cleaner; `[pending]`
becomes signal again.

## 6. Wake-per-request sessions, spawned by the mod (answers COMPANION_DESIGN's cadence question)

Prompt caching is prefix-based and shared across sessions with identical
tools+system, so a fresh session re-reads the ~30k bootstrap prefix at cache-read
rates — while a long-lived session's per-turn read grows without bound
(36k → 103k in 25 min observed). Short sessions keep every turn near the floor;
memory (task frame + mem_recall) already carries continuity across resets — that
is exactly what the soak validated (36 resets, coherent to the last session).

**The trigger lives in the mod, not a Node supervisor.** The mod *is* the chat
event source — a wake trigger there needs no polling anywhere (an external
supervisor would long-poll the bridge to learn about events the mod itself
emitted). The control surface already exists in-game (`/claude mute` is
mod-enforced), and `ClaudeBootstrap` already proves the mod can preflight,
generate the workspace, and launch `claude` via ProcessBuilder. A separate Node
supervisor (the soak shape) remains right for *autonomous* runs with no
game-side trigger; chat wake is not that.

**Shape** (new `CompanionSessions` beside `ClaudeBootstrap`, server-side):
- **Trigger:** a chat message addressed to claude, with no companion session
  active → spawn one bounded headless session:
  `claude -p "<charter pointer + mem_recent render + the message>"
  --max-turns N` in the bootstrapped workspace (reusing ClaudeBootstrap's
  preflight/workspace machinery). The session drains any further chat via its
  own short `get_events` loop, acts, replies via `send_chat`, writes memory,
  exits.
- **Command family**, extending `/claude`: `wake` (manual spawn), `stop` (kill
  the active session — the chat "claude stop" path enforced at the process
  level), `status` (active/cooldown/session count), `mute`/`unmute` (existing;
  mute also blocks spawning).
- **Rails, mod-enforced at the spawn point:** one session at a time, cooldown,
  max sessions/hour, kill on world unload. Knobs in
  `config/mcptoolkit.properties` so policy tuning needs no rebuild. This puts
  COMPANION_DESIGN's autonomy-window rails in the same layer that already owns
  mute.
- **Cache economics:** keep the session bootstrap prefix byte-stable (same
  CLAUDE.md, same tool manifest); the per-wake variable content (render +
  message) rides after the prefix in the `-p` prompt.
- **ClaudeBootstrap's `companionPrompt`** is retired from the button flow (it
  currently hardwires the expensive standing loop — "wait_ms 10000 in a
  continuous loop, do not stop"); the button reverts to opening an interactive
  workbench session, and companion duty moves to the wake trigger.
- Dev-session ergonomics stay as today (Monitor wake pattern in CLAUDE.md).

**Impact:** idle cost → literally zero (no poller of any kind); active turns run
at ~30–40k context instead of 100k+; no compaction pressure; resolves the
"fixed cooldown vs event-driven wake" open question in COMPANION_DESIGN.md with
"event-driven, enforced by the mod".

## 7. Surveyor subagent — heavy perception in disposable context

Even with §3–§4, a large survey (new region, big build audit) produces data the
main session only needs conclusions from. Fan it out:

- Define `.claude/agents/surveyor.md` in the workspace: allowed tools =
  perception + memory reads only (scene_summary, get_blocks, get_entities,
  raycast, scan_box, raycast_fan, mem_recall), cheap model tier, instructed to
  return ≤150 words + key coordinates and to `mem_note` durable findings itself
  (memory is shared state — the summary and the memory entry both survive; the
  raw scan JSON dies with the subagent's context).
- Charter guidance (CLAUDE.md): "surveys of more than ~4 perception calls go to
  the surveyor; the companion session works from its summary."

**Impact:** main-session context stays flat during survey-heavy work; raw scan
tokens are paid once in a context that is thrown away.

---

## Order of work

| # | Change | Where | Size |
|---|--------|-------|------|
| 1 | Compact JSON serialization | `mcp-server/index.mjs` | 1 line |
| 2 | `action_superseded` + classifier rules + bulk dismiss | `DroneTools.java`, `memory/tools.mjs`, `memory/store.mjs` | S |
| 3 | Long-poll extension (per-tool timeout, pool, caps) | `ToolDef.java`, `BridgeServer.java`, `EventTools.java` | S |
| 4 | `get_blocks` summary default, `get_entities` trim, 8KB guard | `WorldPerceptionTools.java`, `BridgeServer.java` | M |
| 5 | `scan_box` + `raycast_fan` | `WorldPerceptionTools.java` | M |
| 6 | In-mod wake trigger + `/claude wake|stop|status` + rails | `CompanionSessions.java` (new), `ClaudeBootstrap.java`, `BridgeConfig.java` | M |
| 7 | Surveyor subagent + charter/doc updates | `mcmodel/.claude/agents/`, CLAUDE.md, COMPANION_DESIGN.md | S |

Expected combined effect on a session like the audited one: idle cost ~0,
cache-write halved (no rebuild incident), scan traffic ~5× smaller, active-turn
context flat near the bootstrap floor instead of growing past 100k.

Verification: rerun the same companion scenario (follow player, scan, build,
verify) and re-audit the transcript with the dedup-by-message-id method; targets
— zero cache-read collapses below the prefix size, no tool result > 8KB, < 10
perception round trips for the house workflow, idle window ≤ 1 poll/min.
