# Companion mode — build-order step 8 (draft rev 1)

> **ARCHIVED — SUPERSEDED 2026-07-21 by `../COMPANION_REDESIGN.md`.** The shim/SDK supervisor
> loop and the authorization rails designed here (cooldown, turn budget, session caps, STOP file,
> tool allowlist) were deliberately removed: sessions are now human-launched (or IW-spawned),
> persistent, and headless, so the containment rails lost their justification. Kept as the
> historical record the redesign and ABLATION_RESULTS.md cite. Do not implement from this doc.

Design pass for MEMORY_DESIGN.md's step 8: the copilot as a persistent inhabitant rather than a
workbench session. Drafted 2026-07-19 alongside the overnight soak (`mcp-server/companion/soak.mjs`),
which is this design's living prototype: everything in §Authorization exists there as a working
rail, enforced harness-side. Status: DRAFT — review with soak data in hand before building the
product surface.

## What companion mode is

The game (or a supervisor process) runs the loop, not Claude Code. A session = one Agent-SDK (or
API) conversation with the charter as system prompt; continuity lives ONLY in per-world memory
(mem_* against the world's memory dir — same files the workbench mounts). The workbench and the
companion are two mounts of one memory; either can pick up where the other left off.

Two lifecycles:
- **Session-loop companion** (the soak shape, buildable now): a supervisor spawns bounded sessions
  back-to-back; each opens with the memory render, works, hands off via the task frame. Simple,
  crash-isolated, and each boundary exercises resume — this is the deliberate first shape.
- **Resident companion** (later): one long-lived conversation with context compaction; session
  boundaries only on restart. Needs the Agent SDK's compaction to be trustworthy with the memory
  protocol (open question below).

## Authorization (the part step 8 forces)

The workbench had Claude Code's call-level consent; headless mode deletes that layer, so authority
must move into the harness. Three tiers, all prototyped in the soak:

1. **Tool-surface constraints** (existence): the companion's manifest simply excludes what it may
   never do — world-edit/authoring tools, bot_spawn (the supervisor owns the body), hotswap/dev
   tools. The mcp-shim IS this mechanism: a condition-keyed allowlist server. Product form: a
   `companion` profile next to the ablation's a–d.
2. **Argument-level constraints** (shape): tools it may use, but bounded — run_command restricted to
   a read-only verb allowlist (data get, execute if); world interaction confined to an authorized
   region (reject bot_goto/bot_place targets outside it); rate caps per session. Today these are
   charter rules audited post-hoc (forbidden-command detector, region check over transcripts); the
   step-8 build moves them INTO the shim dispatch as hard rejections with explanatory errors —
   the model may be told no, never trusted to not-ask.
3. **Autonomy windows** (time/budget): the supervisor grants bounded sessions — maxTurns, cooldowns,
   session caps, a STOP file (kill switch), and usage budget. The principal sets the window; the
   agent cannot extend it. Soak values: 45 turns/session, 150s cooldown, 36-session cap.

Audit surface: the shim's verbatim tool transcript per session + the mod's audit log + memory
itself (append-only) — three independent records; the morning report (`soak-report.mjs`) is the
first reader over them (violations, tool mix, task-frame trajectory).

## In-game I/O (not yet built)

`/copilot` chat command (mod-side): player chat → a queued user message for the next/current
session; agent replies → chat. The event stream already carries most world context; chat needs a
new event type + a bridge send-chat tool (small mod change, needs a rebuild cycle — schedule with
the principal present). Until then the companion is mute-but-observable (logs + world effects).

## Soak outcome (36/36 sessions, 2026-07-19→20)

The product loop works at endurance scale: **12 named outposts designed, built, connected and
maintained across 36 context resets**, task frame coherent to the last session ("scout 13th site;
check resupply first"), 0 errored sessions, 57M input-side tokens. Memory under load: 46 entries,
14 L1 blocks, 14 places, 3 verifications; discipline: 5 violations total, all benign `forceload`
in session 1, none after — the post-hoc audit works, and forceload becomes a shim-rejected verb in
the step-8 build. Three structural findings, each a design requirement:

1. **The telescope lacks tier-2 pressure.** No L2 blocks ever formed and nothing nags for them;
   worse, the render's frontier-block list is UNBUDGETED — at 14 blocks the "900-token" render was
   actually 2367 tokens and grows linearly. Fix: block-tier compaction pressure (L1→L2 nag) + a
   budgeted block section. Interlocking consequence: offline probes show recall currently returns
   nothing beyond the (bloated) render — once the render is properly budgeted, mem_recall's regime
   finally exists. **Do not delete the recall layer (ABLATION_RESULTS simplification candidate)
   before re-measuring under tier-2 pressure.**
2. **Fixed respawn taxes a growing world.** The drone respawns at base each session, so travel to
   the network's frontier eats an increasing share of each window (the s17–27 productivity dip:
   ~50-call sessions burned on goto/status/raycast toward distant natural-terrain sites, zero
   placements; recovered when work returned nearer). Fix: supervisor spawns at the task frame's
   declared work site, or the drone persists across sessions.
3. **Autonomy windows must be visible** (below).

## Soak finding (2026-07-19, live): autonomy windows must be VISIBLE

By session ~20 of the overnight soak, sessions began exhausting their 45-turn window mid-work with
no hand-off written (s22–24: turn-capped, 1–3 mem calls, task frame stale at "Session 20") — the
charter's "wrap up ~5 turns before your cap" is unfollowable because the agent cannot see its
remaining turns. Requirement for step 8: the harness must surface the window — a turn/budget
countdown injected into tool results (or a system reminder) as the cap approaches, so wrap-up
discipline is mechanically possible. Corollary: cap sizing must scale with corpus/graph size —
fixed 45 turns was ample for session 1 and starved session 24.

## Open questions for the review pass

- Resident lifecycle: does harness compaction (Claude Code auto-compact) coexist with the memory
  protocol, or does it shadow-memory the render? (The soak sidesteps this: fresh sessions.)
- Argument constraints: where is the line between shim-enforced and charter-requested? Shim rules
  are safety; charter rules are discipline — the soak's violation counts tell us which charter
  rules must be promoted to shim rules.
- Session cadence: fixed cooldown vs event-driven wake (pending events, player presence).
- Memory dir authority: companion and workbench share one dir — concurrent access is unguarded
  (single-writer assumption). Needs a lock or a serialization story before both run at once.

## Provenance

Rev 1 drafted 2026-07-19 during the ablation-night session; soak rails double as the authorization
prototype. Revise after the soak report and the principal's review.
