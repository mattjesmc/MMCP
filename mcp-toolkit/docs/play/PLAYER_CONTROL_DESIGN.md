# Player-Control Design — reflexes, combat, equipment, consumables, schematic-build

Status: **mostly implemented** (toolkit 0.14.0). The reactive combat + survival + player-legal-
perception system — the bulk of this doc — is built and live-tested against real mobs; only
profile *enforcement* and a `retreat` policy remain here. Per-slice status with commits is in §10.
Companion to `ARCHITECTURE.md` (authoritative) and `CATEGORY_C_DESIGN.md`.

> **Partly superseded by `BOT_SURFACE_DESIGN.md`**, which promotes the deferred `NodeEvaluator`
> (§6.1) and `bot_build` (§7) to build-now and re-layers `bot_engage` (§4) as a body mode. Each
> affected section carries its own note. This doc records the design for giving the active body a set of
player-shaped combat/utility capabilities — a reflex loadout, movement policies, equipment,
potions/eating, and server-executed schematic building — plus the "player-legal" profile that
constrains them for honest autonomy evaluation.

Everything here lands in the existing `drone/` package and reuses three patterns already
shipped: `Follow`'s tick-watch, `QueueRunner`'s step-bodies, and (from the sibling Village
Jobs mod) `StructurePlacer.missing()`'s incremental staging.

---

## 0. Framing — capabilities now, "legal" later

`ARCHITECTURE.md` is copilot-first, not player-imitation: *"Constraints on the agent are
authorization constraints (what did the user permit), not human-realism constraints (what
could a human body do)."* Human-realism enforcement (rotation-rate caps, FOV/occlusion,
attention limits) is on the deliberate Don't-build-yet list, kept alive only as a **secondary
benchmark profile**.

So this design splits along that seam:

- **Core (build now):** reflexes, movement policies, equipment, consumables, and
  schematic-build are ordinary `embodied` (and one `world_edit`) capabilities with **no
  human-realism caps**. Game-mechanics timing (crossbow load→fire, bow charge, shield raise,
  crit cooldown) is server-executed — that's world-model offload, not a realism cap, and it
  belongs in core.
- **Profile (build last, §9):** "player-legal" is a *mode* layered on top — the same tools run
  against a constrained body with rotation caps, perception-gated triggers, a capped reaction
  budget, and only-legal tools surfaced. Nothing in core is rewritten for it. This matches the
  architecture's requirement that the autonomous profile stay "possible without a rewrite,
  never allowed to drive the architecture."

Build the system first; keep the mode contained and last.

## 0.1 The body caveat (honest, shapes everything)

There is **no player-character actuator today** — no fake `ServerPlayer`. The active body
(`Slot.activeBody()`) is the **drone** (has inventory + hands + selected slot) or a
**possessed goal-mob** (which currently throws `no_hands`). So this whole system is built on
the **drone body first** — which already has the inventory/hotbar/attack machinery. A true
player character with right-click-in-air and container UIs is the same deferred fake-player
gap the architecture already flags; these capabilities transfer to it for free if it ever
lands. Do not block on it.

---

## 1. Layer split

- **Deliberative (agent, request loop):** arms reactions, declares combat loadout intent,
  issues build goals, picks a movement policy. Slow loop.
- **Reactive (server, every tick):** a new `Reflexes` tick-watch and a `Combat` movement
  watch, both shaped like `drone/Follow.java` — *the agent sets intent; code executes it every
  tick with player-visible feedback.* Reflexes and kiting never touch the agent request loop —
  LLM round-trips are orders of magnitude slower than the tick window they'd need.

---

## 2. The arbiter — one base intent + a reflex interrupt layer

### 2.0 What exists today (the implicit arbiter)

`DroneTools.Slot` already holds five control-ish fields — `pendingNav`, `dig`, `possession`,
`follow`, `queue` — and the invariant "only one thing drives the body" is maintained by
**every entry point manually tearing down every rival**: `bot_goto` calls
`QueueRunner.abort` + `Follow.clear` + `failPending`; `bot_run`, `bot_follow`,
`bot_possess`/`release` each hand-list their own teardown set. That's O(n²) and fragile —
adding `bot_engage` and reflexes would mean editing all five existing sites plus every new
one. Centralizing it is the arbiter's first job.

**Primitives vs base intents (the structural split the code already has).** `pendingNav` and
`dig` are *not* base intents — they are shared **primitives**: one tracked navigation (the
`a-N` action, honest completion verdict) or one dig (`m-N`). A manual `bot_goto` owns a
`pendingNav`; a queue `goto` step *also* calls `startNav` and owns a transient `pendingNav`
watched via `onActionDone`; `Follow` uses no `pendingNav` at all (it calls
`getNavigation().moveTo` directly every tick). So the real layering is:

- **Primitives:** a single async action in flight (`pendingNav` / `dig`) with an honest verdict.
- **Base intents:** `goto` (owns one `pendingNav`), `run` (sequences primitives),
  `follow` / `engage` (re-issue raw navigation each tick — self-healing, no `pendingNav`).

The arbiter must respect that split.

### 2.1 Part A — centralize base teardown (`claimBase`, zero behavior change)

Add `Slot.baseKind ∈ {IDLE, GOTO, RUN, FOLLOW, ENGAGE}` and one function:

```
DroneTools.claimBase(slot, kind, reason)   // suspend/abort the current base, install the new
```

Every entry point calls `claimBase` instead of hand-listing rivals;
`possess`/`release`/`despawn` call `claimBase(IDLE, "body_changed")`. Pure refactor — the
reach-goals probe stays green. This is also the **one chokepoint that cancels an in-flight
reflex**, so an explicit agent command always wins over a reaction (agent intent > reflex).
Recommended representation: the `baseKind` tag + the existing typed fields (matches the
concrete `static tick(slot)` idiom of `Follow`/`QueueRunner`; a `BaseController` interface is
a cleaner-OO alternative but a bigger refactor against the grain — revisit if `engage` feels
cramped).

### 2.2 Part B — the reflex interrupt layer

New `Reflexes.java` (concrete, `static tick(slot, body)`, switch-based triggers/responses —
matching `QueueRunner`'s idiom, no interfaces). `Slot` gains `reflexes` (the armed set) and
`active` (the in-flight interrupt, or null). Tick order in `tickWatch`:

```
reflexActive = Reflexes.tick(slot, body)        // owns the body while a reaction is firing
if (!reflexActive) {
    DroneHands.tick(dig)                         // base-owned primitive
    Follow.tick / QueueRunner.tick / Engage.tick // the base intent
    pendingNav completion check                  // base-owned primitive
}
// drone damage/removal events always run
```

`reflexActive == slot.baseSuspended`: while a reaction owns the body, **all base servicing is
skipped, including the `pendingNav` completion check** (critical — see below).

### 2.3 Suspend / resume, and why honesty is free

**suspend** (a reaction fires):
```
body.getNavigation().stop();   // the reflex owns movement now
slot.baseSuspended = true;
```
We do **not** complete or fail the base's in-flight `pendingNav` — we stop the physical nav
and skip its completion check while suspended. The `a-N` action (and any parked `wait:true`
waiter) persists untouched.

**resume** (reaction done):
```
slot.baseSuspended = false;
if (slot.pendingNav != null) renav(slot.pendingNav);  // re-issue moveTo (re-solve shell for reach)
// follow/engage/idle: nothing — they re-path themselves next tick
```

`resume = "re-issue `slot.pendingNav`"` covers manual `goto` **and** a queue's in-flight
`goto` step uniformly, because both track navigation through that same field; the queue never
learns it was interrupted (its primitive just took longer). `follow`/`engage` are
self-healing, so their resume is a no-op.

### 2.4 Pause vs cancel is truth-determined, not a mode

There is **no `on_fire` preempt/abort knob**. The arbiter **always pauses**. What happens on
resume is decided by whether the world still supports the paused step — and the truth is
stated either way, because resume **re-drives the step through the real tool body**:

- world still supports it → it resumes and succeeds. **Pause.**
- the reflex invalidated it → the real body returns its real reason → the queue aborts
  honestly. **Cancel.** Concretely: queued `attack E` and the reflex killed E → `no_target`;
  queued `mine B` and B is gone → `block_changed` / `nothing_to_mine`; `place`/`use` now out
  of reach because the reflex strafed away → `out_of_reach`.

The pause/cancel line is drawn by whether the referent still exists — which only the real tool
body can truthfully answer — not by the agent or the arbiter. This needs *less* code (no mode
field, no abort path); the succeeds-falsely doctrine produces the honest cancel for free.

**"State truth" completeness — causality annotation.** When the reflex is *why* the target
vanished, bare `no_target` under-explains. The queue's `action_failed` carries
`after_reaction:"<id>"` so the agent sees the queue died because a reaction consumed its
target, not because the target was never there.

### 2.5 The decision that keeps suspend/resume to one boolean

Reflex movement responses are **routing-free primitives** — `strafe`/`backstep`/`sidestep` as
direct per-tick movement, not navigation goals. A reaction never grabs `getNavigation()` for
its own pathing; the only shared resource it touches is "stop the base's nav while I act."
(This is the §6.1 deferral paying off — real reflex navigation waits for the danger-aware
`NodeEvaluator`.) So the whole ownership model is the single `baseSuspended` boolean.

### 2.6 Legibility & collisions

- Events: `reaction_fired {id, response_op, preempted:"<baseKind>"}` and `reaction_done {id}`;
  the resumed base emits its own events as normal; an honest cancel carries `after_reaction`.
- Same-tick collisions: evaluate all armed triggers, fire the highest `priority` whose
  `cooldown_ticks` elapsed; losers may fire next tick. **One reflex at a time in v1** (no
  reflex-preempts-reflex — a v2 knob); a `deadlineTicks` cap keeps a stuck response from
  owning the body forever.

---

## 3. Reflex engine — `bot_reactions` (new `Reflexes` tick-watch)

A per-session armed set, evaluated each server tick. Every **trigger** is server-computed
(raycast intersection, range check, health threshold, effect presence, sound event) — zero
model arithmetic. Every **response** reuses an existing tool body (the `QueueRunner` op bodies
`attack`/`use`/`select`/`look`, plus new `strafe`/`eat`/`drink`/`shield`), so events, audit,
and honest verdicts are identical to hand-issued actions.

```
bot_reactions { action: "arm"|"disarm"|"list"|"clear",
  reactions: [{
    id: "deflect-ghast",
    trigger:  { kind: "projectile_incoming", faces_body: true, within: 8 },
    response: { op: "attack", target: "$trigger.projectile" },
    priority: 10,
    cooldown_ticks: 4
  }, {
    id: "panic-eat",
    trigger:  { kind: "health_below", hearts: 6 },
    response: { op: "eat", item: "golden_apple" },
    priority: 20, cooldown_ticks: 20
  }]
}
```

**Trigger kinds** (all server-detected symbolically):
`projectile_incoming` (raycast into body; `faces_body`/FOV field *exists but is unenforced in
core* — the profile hook), `sound_event` (e.g. `ghast_charge` — legal because the client plays
it too), `health_below`, `effect_applied` (poison/wither), `entity_in_range {type, range}`,
`taking_damage`.

**Responses** reuse existing/new tool bodies; movement responses are restricted to
routing-free primitives (`strafe`/`backstep`/`sidestep`) — see §6.

**The cap is NOT in core.** The reaction budget ("choose situationally, limited attention") is
a human-realism/attention limit → it lives in the profile (§9). Core lets you arm what you
want; `bot_status` gains a compact `combat` summary (armed ids, current policy, last-fired) as
the escalation rung, with `bot_reactions{action:"list"}` as the drill-down.

---

## 4. Movement policy — `bot_engage` (new `Combat`, Follow-shaped)

> **SUPERSEDED by `BOT_SURFACE_DESIGN.md` §4.** The station-keeping math and the four policies below
> are unchanged. What changes is the *layer*: `engage` becomes a body **mode** (a toggle on
> `bot_body`) rather than a base intent, so `ENGAGE` leaves `BaseKind` and the body can travel and
> fight at once. Targets come from a threat table instead of one entity id — so a killed target no
> longer ends engagement (and no longer costs an agent turn), and the profile's defend/fight mode
> decides whether combat may claim the base at all.

The "strafe that dodges arrows" is a movement *policy*, not a per-arrow reaction — a
`Follow`-style station-keeping watch with hostility.

```
bot_engage { target: <entity>, policy: "kite"|"strafe"|"close"|"hold", range: 6 }
```

`kite`/`strafe` maintain range while circling — dodging emerges statistically and honestly
(won't dodge every arrow, same as a human strafing). `close` drives into melee range. Reuses
`ReachSolver` for touch-range geometry and vanilla A* for movement. Starts on vanilla
pathfinding; danger-aware routing is the deferred overlay (§6).

---

## 5. Equipment as loadout intent — `bot_equip`

The agent declares *intent*; the server picks slots and drives item-state timing (game
mechanics = world-model offload, not a realism cap → core).

```
bot_equip { armor: {...}, mainhand_pref: ["axe","sword"], offhand: "shield",
            ranged: "crossbow", ammo: "arrow", keep_crossbow_loaded: true }
```

Server responsibilities: equip armor via `setItemSlot(EquipmentSlot,…)` (net-new on
`DroneEntity`); during combat auto-select the hotbar slot (axe vs a shielded target), raise
shield on `projectile_incoming`, drive **crossbow load→fire** and **bow charge** timing. The
agent never micromanages swings or charge ticks. Builds on `bot_select`/`findItemSlot` and
`botAttack`'s wield-copy-swing-writeback (no dupes; durability written back).

---

## 6. Consumables — potions & eating (both, one mechanism)

Consumption is one embodied capability with two entry points:

- **Reflexive:** `health_below → eat`, `effect:poison → drink milk`, `on_engage → drink
  strength` — armed as reactions (§3).
- **Deliberative/manual:** explicit `bot_eat{item}` / `bot_drink{item}` /
  `bot_throw_potion{at}` for the agent to fire directly.

Both call the **same** handler, built on the `bot_use` template (`finishUsingItem` /
`FoodData` / `addEffect` / `MobEffectInstance` — none exist today; clean greenfield). Honest
outcome: didn't-consume → no false success.

---

## 6.1 Danger-aware routing — lighter first, evaluator later

> **SUPERSEDED by `BOT_SURFACE_DESIGN.md` §1.** The deferral below was correct on its own terms
> (routing-free reflex primitives don't need an evaluator), but tunnelling/bridging are now part of
> the mobility profile — a fourth consumer on top of the three counted here — and the evaluator has
> to land *before* the goal loop so that `check_path` and execution share one solver instead of
> disagreeing. Kept for the reasoning; the promotion trigger below is now moot.

- **Now (no new pathfinding):** `check_path` **refuse-and-report** — returns hazards along the
  path ("crosses lava within archer range"); the agent re-plans tactically ("kill the
  skeleton, then walk"). This is the escalation-shaped danger report.
- **Later (one overlay, three consumers):** a custom `NodeEvaluator` / cost overlay serving
  `bot_engage` kiting, reflex `flee` movement, and `check_path`. **Promotion trigger:** the
  first reflex response that needs real navigation — a `flee` that paths to safety will
  otherwise flee *into* the lava it's escaping. Until then, keep reflex movement to
  routing-free primitives (§3); anything that must *navigate somewhere* stays deliberative.

---

## 7. Schematic-build — `bot_build`

> **SUPERSEDED by `BOT_SURFACE_DESIGN.md` §3.** The mechanism below is unchanged and still the
> reference; what changed is the entry point — it becomes `bot_target{action:"build"}` rather than a
> tool of its own, so it inherits the goal loop's repair, ledger, and `may_modify` disclosure.

"Issue a build; server executes it block-by-block; the agent doesn't place each block." The
reference implementation already exists in the sibling Village Jobs mod:
`build/TemplateBlueprint.java` (loads a `StructureTemplate` NBT) + `build/StructurePlacer.java`
(`missing()` re-reads the world, places `BLOCKS_PER_ACTION` per cycle, **resumes where it
stopped**).

```
bot_build { template: "castle_wall", origin: <resolve_anchor result>,
            mode: "embodied" | "world_edit" }
```

- **`world_edit`:** instant; reuse `set_blocks` + `EditJournal` undo; previewable (`dry_run`),
  undoable. Fast.
- **`embodied`:** a `QueueRunner`-style loop — the drone walks (`reach:` goals), reaches,
  `bot_place`s; `StructurePlacer.missing()` lets it resume after interruption. **Honestly
  reports** blocks it couldn't place (`item_missing`, unreachable, `place_rejected`) rather
  than claiming a finished build.

Placement math is server-side: the agent supplies a **relation** via `resolve_anchor` ("north
face, base-aligned") → min-corner origin it copies, never computes. The response **discloses
which mechanism ran** — they're different acts with different failure modes and undo.

---

## 8. Rule compliance (quick map)

- **Escalation:** `bot_status.combat` summary → `bot_reactions{list}` drill-down;
  `check_path` verdict → annotated hazards drill-down.
- **Truthful / succeeds-falsely:** every response runs its real tool body (`item_missing`,
  `unsupported`, `place_rejected`, durability write-back, copy-wield/no-dupe); interrupted
  base intents resume to honest verdicts (§2); `bot_build` reports unplaced blocks.
- **No arithmetic / world-model:** triggers, targeting, reach, crossbow/charge timing, and
  build placement all computed server-side; the agent states thresholds/relations/intent.
- **Mechanism + registration:** all `EMBODIED` except `bot_build`'s `world_edit` variant.
  Each new tool: declare `Mechanism`, register its class in `McpToolkit.java` init, add a
  `conformance.test.mjs` spec entry (CI ratchet fails otherwise), add a `reach-goals.test.mjs`
  -style embodied probe, bump `build.gradle` version (minor for features; also for any
  response-shape change).

---

## 9. Deferred — the player-legal profile

Built last, layered on §1–§7 without touching them. It is the architecture's constrained
benchmark profile (`observer = actuator = a constrained body, perception_mode: visible`):

- **Rotation-rate caps** — no instant aimbot snap.
- **Perception-gated triggers** — enforce `faces_body`/FOV/LOS/darkness so a reaction only
  fires on a signal the player could actually perceive (sound the client plays, or something
  in the view cone). This is where `visible`-mode enforcement finally gets implemented, which
  the core deliberately labels-but-doesn't-enforce.
- **Reaction budget** — cap the armed set so the agent must choose situationally.
- **Legal tool surface** — only player-shaped tools exposed; world-edit `bot_build`, `bot_give`,
  and privileged/world_edit mechanisms hidden.

Litmus test for any behavior admitted to the profile: *name the perceptual signal it reacts
to, name the bodily action it takes, and cap the actuation to human rates.* If you can't name
a legal signal, it's a cheat.

---

## 10. Build order — status

Each slice below was built as: compile → machine probe → headless live test (vs real mobs where
combat) → commit. Version = the toolkit version it shipped in. Probes live in `mcp-server/probes/`.

- 0. **`claimBase` + `baseKind` (§2.1)** — **DONE** `efa0463`. Behavior-preserving; reach-goals 11/11.
- 1. **`Reflexes` + `bot_reactions` (§2.2–2.6)** — **DONE** `ca08755` (0.8.0). `health_below`→`attack`; interrupt loop; preempt-a-goto.
- 2. **`renav` + `after_reaction`** — **DONE** `e057130` (0.8.1). renav-resume of a queue goto; truth-determined cancel (`no_target`/`out_of_reach` + `after_reaction`).
- 3. **Consumables + projectiles** — **DONE** `5b2e443` (0.9.0). `bot_eat`/`bot_drink`; `projectile_incoming` trigger; `deflect`. Tested vs a real arrow + zombie.
- 4. **`bot_equip` + `shield`** — **DONE** `3dff094` (0.10.0). Armor value; shield reflex; `bot_status` combat block.
- 5. **`bot_engage`** — **DONE** `cf332f6` (0.11.0). kite/strafe/close/hold; kites a real provoked zombie out of melee.
  - 5b. **survival** — **DONE** `daaa4ae` (0.11.1). `threats_nearby` + `flee`-to-vantage; survives a provoked 3-zombie swarm. (Postpones slice 6.)
  - 5c. **ranged** — **DONE** `c8b6dc3` (0.14.0). `bot_shoot` + `shoot` reflex; damages a zombie at range.
- 6. **Danger-aware `NodeEvaluator`** — **PROMOTED** to build-now; see `BOT_SURFACE_DESIGN.md` §1. Now build-*aware* as well as danger-aware (place/break/door edges), parameterised by a mobility profile so `check_path` and execution share one solver. Feeds `check_path`, kiting, a navigating `flee`, and the goal loop.
- 7. **`bot_build`** — **PROMOTED**; see `BOT_SURFACE_DESIGN.md` §3. Same `StructurePlacer` mechanism (§7), now reached as `bot_target{action:"build"}`.
- 8. **Player-legal profile (§9)** — **PARTIAL**:
  - 8a. **belief store** `sense_entities` — **DONE** `fb2aba8` (0.12.0). vision (FOV+LOS) / hearing / freeze-when-unperceived / decay; server-computed distance+bearing+hostile+closing + summary rung (no-arithmetic).
  - 8b. **perception mode** `bot_profile` — **DONE** `fc644b3` (0.13.0). In perceived mode the threat triggers + `flee` read the belief store, not ground truth.
  - **enforcement** — **PENDING**: rotation-rate caps (no aimbot), reaction budget, tool-surface filter (hide `get_entities`/world-edit/`bot_give` in legal mode).

Also **PENDING**: a `retreat` engage policy — sustained multi-target flee (the continuous sibling
of the one-shot `flee` reflex), stationing off the threat centroid.
