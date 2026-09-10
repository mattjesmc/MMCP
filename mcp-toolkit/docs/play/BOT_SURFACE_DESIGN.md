# Bot-surface design — goal loop, build-aware pathfinding, engage-as-mode

Status: **built, not yet live-verified** (toolkit 0.15.0). Compiles and the jar builds; the migration
across probes/bench is done; the conformance ratchet and the embodied probes still need a game
restart on the new jar, and the turn/token A/B (§7) has not been run. What is deliberately NOT built
is listed in §8. Companion to `ARCHITECTURE.md` (authoritative) and
`PLAYER_CONTROL_DESIGN.md`. This doc **supersedes** two positions in that document: §6.1's
"defer the `NodeEvaluator`" and the §10 PENDING framing of items 6 (danger-aware `NodeEvaluator`)
and 7 (`bot_build`). Both are promoted to build-now, for the reason in §1.

The change has three parts that only make sense together: a **goal loop** that repairs its own
failures instead of surfacing them, a **build-aware pathfinder** parameterised by a mobility
profile, and a **surface consolidation** that pays for the first two in prefix tokens.

---

## 0. Why — the measured argument

> **Token authority: `TOOL_BILL_PLAN.md`.** That doc measures the live manifest and ranks the
> token levers (profiles, the `locate` swap, doctrine-to-charter, description trims). This section
> only states what the bot surface contributes; where the two disagree on a number, TOOL_BILL_PLAN
> wins. §5 below is explicitly constrained by its collapse criterion.

`TOKEN_PER_TOOL_FINDINGS.md` Finding 1: the static tool-schema prefix is **50–92%** of the token
bill, because it is re-read on *every turn of every session*. Two different per-turn numbers are in
play and must not be conflated:

- **Bench arms** (~16 tools exposed): ~4.5k/turn (category P) to ~8.4k/turn (category C).
- **Live headless manifest** (66 tools): **74,797 chars ≈ 18.7k tokens** — so in production a
  saved turn is worth ~18.7k, more than any description you could trim.

The bot surface is **24 tools** carrying **~3.3k tokens** of description text — realistically 5–6k
of real prefix once arg descriptions and JSON scaffolding are counted. Measured per tool
(description text only):

| | | | |
|---|---|---|---|
| `bot_reactions` 444 | `bot_goto` 438 | `bot_run` 263 | `bot_mine` 231 |
| `bot_engage` 166 | `bot_follow` 164 | `bot_place` 154 | `bot_spawn` 142 |
| `bot_use` 136 | `bot_attack` 133 | `bot_equip` 110 | `bot_profile` 105 |
| `bot_eat` 98 | `bot_point` 96 | `bot_drink` 90 | `bot_shoot` 86 |
| `bot_give` 82 | `bot_status` 72 | `bot_select` 46 | `bot_look` 39 |
| `bot_inventory` 37 | `bot_despawn` 33 | `bot_release` 30 | `bot_possess` 146 |

Two forces compound:

1. **Remedial turns are where the turns go.** The happy path is *already* one call — `bot_run`
   collapses goto→look→mine into a single turn. But `QueueRunner` is **abort-on-first-failure with
   no retry**: every `stopped_short`, `out_of_reach`, or `gates{los:false}` kills the queue and
   costs a full agent turn to diagnose and re-issue. At 4.5–8.4k a turn, *all* remaining savings
   live on the failure path. **The prize is server-side repair, not the merge.**
2. **Capability is still being added.** Build-assisted pathing, `bot_build`, richer combat — each
   costs prefix on every turn forever. The consolidation is what buys room for them.

A note on honest accounting: **merging tools moves text, it does not delete it.** `bot_run` gets
away with a tiny schema (`steps:[{op}]`) only because it free-rides on the individual tools'
schemas — *"each takes the same args as its bot_\* tool"*. Unexport those and the documentation cost
lands on the merged tool instead. What genuinely disappears is the per-tool **envelope** (name +
description wrapper + `inputSchema` JSON, ~40–60 tokens each) plus redundant prose. Expect the
~3.3k to land at **~2–2.2k**, not near zero. The consolidation *funds* the new capability; it is
not a saving in itself.

**And discount that further before believing it.** The `locate` swap (`TOOL_BILL_PLAN.md` §6c) cut
17.6% of *tool-schema text* and moved the actual bill by **~5.5%** — because the re-read prefix also
carries the system prompt and task, and cache-read pricing discounts it. A ~1.1k description saving
here is therefore worth low single-digit percent of a session, not "a third of the bot bill". Quote
the measured number, never the manifest headline. **The turn savings (§2, §3, §4.2) are the real
case; the schema savings are a rounding error by comparison.**

---

## 1. Build-aware `NodeEvaluator` + mobility profile

**Build this first.** It is the foundation, and it changes `check_path`'s contract.

### 1.1 Why now, against §6.1's deferral

`check_path` (`PredicateTools.checkPath`) spawns a throwaway probe — `DroneEntities.DRONE` for
`flyer`, a villager for `walker` — and rides *that body's* evaluator. That is deliberate:
`ARCHITECTURE.md` — *"the body's own `NodeEvaluator` decides which members it can occupy… keeps the
solver mode-blind"*.

That property is exactly why the evaluator must land **before** the goal loop, not after. If the
mobility profile drives the evaluator, then prediction (`check_path`) and execution (the goal loop)
run **the same solver with the same flags**, and `check_path` cannot promise a bridge the body
can't build, nor deny one it can. Ship the goal loop first and you spend the interim with two
solvers that disagree — which is the exact class of bug the truthful-reporting doctrine exists to
prevent.

§6.1's original deferral reasoning still holds on its own terms (routing-free reflex primitives
don't need it). What changed is that **tunnelling and bridging are now part of the profile**, which
adds a fourth consumer to the three §6.1 counted — and makes the evaluator the thing everything
else is defined against.

### 1.2 Vanilla already models a mobility profile

`NodeEvaluator` (`vanilla-src/net/minecraft/world/level/pathfinder/NodeEvaluator.java`) carries
protected capability flags:

```java
protected boolean canPassDoors = true;
protected boolean canOpenDoors;
protected boolean canFloat;
protected boolean canWalkOverFences;
```

That *is* a mobility profile, just hardcoded per mob type. `NavProfile` extends a concept vanilla
already has rather than introducing one:

```
NavProfile { canOpenDoors, canBreak, canPlace, blockBudget, breakBudget, maxFall, maxJump }
```

### 1.3 The tractability rule — mutation is an edge, not a state

The naive framing ("search over position × world-mutation") has an unbounded state space. It is not
the right framing. **State stays `(x,y,z)`.** `getNeighbors(Node[], Node)` emits neighbour nodes
that *don't exist yet*, each tagged with the action required to make it exist — place, break, or
open-door — available only when `NavProfile` permits and budget remains. No combinatorial blowup,
and it fits vanilla's `getNeighbors` contract unchanged.

The price is **optimism**: the search assumes bridging material lasts and breaks succeed. That is
reconciled honestly at execution by the ledger (§2.2). This is the succeeds-falsely doctrine doing
structural work, not just shaping a response.

### 1.4 One cost currency: ticks

Place and break edges must be commensurable with movement or A* misbehaves. Use **estimated ticks**
— mining time is already tick-computed (`DroneHands.startMine` returns `eta_ticks`) and movement is
blocks/speed. Euclidean-at-max-speed remains an admissible heuristic (never overestimates), so
vanilla's `PathFinder` needs no changes.

### 1.5 Two gotchas

- **Never write speculative path types into the shared cache.** `PathfindingContext` resolves types
  through `serverLevel.getPathTypeCache()` — that cache belongs to the server and every mob on it.
  "This will be air once I mine it" must stay local to the search.
- **Doors are nearly free, but opening them is not.** `PathType.DOOR_WOOD_CLOSED(-1.0F)` and
  `DOOR_IRON_CLOSED(-1.0F)` are impassable purely by malus; `setPathfindingMalus(DOOR_WOOD_CLOSED,
  0.0f)` plus `canOpenDoors = true` makes them routable — a config line, not an algorithm, and
  exactly what vanilla villagers do. What *is* new: our body is a directly-commanded puppet running
  neither `OpenDoorGoal` nor the brain's `InteractWithDoor`, so the goal loop must `bot_use` the
  door when the next node is a closed one. `DOOR_IRON_CLOSED` stays impassable and is **reported**,
  never silently attempted — it needs a button or lever the body may not be able to find.

---

## 2. Honest reporting — obstruction locus and progress ledger

The reporting scaffolding is ~80% built. `check_path` already returns tri-state `reachable`,
`partial`, `nodes`, `end{x,y,z}`, and `search{budget_used, ceiling, stabilized}` — where
`stabilized` (re-run under a 4× budget, frontier stopped growing) is what keeps "truly unreachable"
and "ran out of search budget" from ever being confused. `QueueRunner.fail` already carries
`{step_index, op, reason, steps_completed}`. Two gaps.

### 2.1 Obstruction locus

`end` says where the path *stopped*. It does not say which block *stopped it*. That is computable
from the frontier: the first neighbour node toward the goal that the evaluator rejected, plus its
`PathType`. The difference:

```
before:  stopped_short, end {120, 64, -31}
after:   stopped_short, end {120, 64, -31}, obstruction {121, 65, -31, DOOR_IRON_CLOSED}
```

The first needs a survey turn to act on. The second does not. That *is* the token argument.

### 2.2 Progress ledger

What the goal loop accomplished before it gave up — so a partial failure is **resumable without a
re-survey turn**:

```
ledger: {
  traveled_to: {x,y,z}, steps_completed: 7,
  mined:   [{at, block}],  bridged: [{at, item}],  doors_opened: [{at}],
  stopped: { reason: "unreachable", obstruction: {x,y,z,path_type} }
}
```

Emitted on `action_failed` and on partial `action_completed`.

---

## 3. `bot_target` — the goal loop

One EMBODIED async tool owning every base intent, with server-side repair.

```
bot_target { action: move | destroy | place | build | attack | follow,
             target: <selector>,
             may_modify: none | break | place | both,
             policy: ..., budget: {blocks, ticks}, wait: bool }
```

### 3.1 The shared selector grammar

Selection is inconsistent today — `bot_attack` takes `target`|`nearest`, `bot_follow` takes
`target`|`player`, `bot_engage` an entity id only, `bot_mine` an `at{x,y,z}`, `bot_point` either.
Each describes its own selector in its own words. One union, described once:

```
{entity: <id>} | {uuid: "..."} | {player: "name"}
| {handle: "village_plains@-104,71,238"} | {anchor: "lookout_tree"}
| {at: {x,y,z}} | {kind: "zombie", nearest: true}   // nearest-in-perception only
```

**Searching is `locate`'s question, not this tool's.** `locate` is two-way as of 0.8.1 — `what`
solves thing→positions, `at` solves positions→thing — it is an index lookup rather than a scan, it
carries the `negative_is_proof` honesty contract, and it returns **handles** plus an anchor ledger
with the explicit instruction *"pass handles around, never retyped coordinates"*. Re-implementing
"find me the nearest oak log" inside `bot_target` would duplicate that machinery **and** its
honesty contract, and would violate the collapse criterion in `TOOL_BILL_PLAN.md` §3 (never merge
tools that answer *different* questions). So: `locate` finds, `bot_target` acts, and the **handle**
is the seam between them.

The one search-shaped case that stays local is `{kind, nearest}` resolved against **what the body
can already perceive** (the `Perception` belief store / entities in range) — that is not a world
search, it is "the thing in front of me", and it is what the threat table (§4.2) is keyed on.

Two wins, neither of them mainly tokens: it removes a `get_entities` round-trip for in-reach
targets, and it lets the **repair loop re-resolve the referent after a failure** without spending an
agent turn.

### 3.2 Segment-and-repair

Full build-aware global search is §1. The loop on top of it is deliberately simpler:

```
run A* to the goal
  → complete?  execute it
  → partial?   take path.getEndNode()
               diagnose one step toward the goal (check_clearance / raycast / get_blocks_at)
               emit ONE local repair (break | bridge | open door)
               re-run A* from there
  → budget exhausted or no repair applies?  stop, report locus + ledger
```

Greedy, and it will dead-end where a global search wouldn't. It also reuses everything already
built and **fails honestly**, which is the point. Reuse the `QueueRunner` op bodies for every action
it performs, so events, audit, and verdicts are identical to hand-issued actions; `ReachSolver.solve`
for touch-shell geometry; `DroneTools.startNav` / `PendingNav` for the tracked navigation primitive.

`action: build` reuses the Village Jobs `build/StructurePlacer.missing()` incremental-staging
pattern (`PLAYER_CONTROL_DESIGN.md` §7): re-read the world, place per cycle, resume after
interruption.

### 3.3 World modification is opt-in and disclosed

A path that places or breaks blocks changes the world **as a side effect of navigating**. "Go to
the village" silently tunnelling through someone's wall is precisely the false success the
architecture forbids. So:

- `may_modify` defaults to `none`;
- a block budget bounds it;
- every modification lands in the ledger.

This creates a failure class that reads oddly at first and is correct: **`item_missing` becomes a
navigation failure reason**, because you cannot bridge without blocks.

---

## 4. `engage` as a body mode, not a base intent

### 4.1 The arbiter gets simpler, not more complex

Today `BaseKind ∈ {IDLE, GOTO, RUN, FOLLOW, ENGAGE}` and engage occupies the single base slot — so
starting a fight **cancels the journey**, and the body can never travel and fight at once.

`engage` becomes a **toggle on `bot_body`**, and `ENGAGE` leaves `BaseKind`. The fighting rides the
reflex interrupt layer, which already suspends and resumes the base intent honestly (§2.3 of
`PLAYER_CONTROL_DESIGN.md`). So `bot_target{action:"destroy"}` with engage on means: mine, fight off
what jumps you, resume mining. `claimBase` **loses** a kind rather than gaining one.

### 4.2 Attack-as-designation → a threat table

`attack` designates a target as hostile; `engage` decides whether anything acts on the designation.
An entity selector designates one mob; a class selector (`{kind:"zombie"}`) is a standing rule.

This also removes a live turn-waster: `Engage.end` currently emits `engage_lost` when the target
dies, so **every killed mob costs an agent turn** to re-issue. With a table, a dead target just
means the watch picks the next — a turn saved per kill, straight off the 4.5–8.4k unit.

### 4.3 "Attacks/defends according to profile" — two modes, two movement rights

- **defend** — reflex-only, routing-free responses per §2.5: `strafe`, `backstep`, `shield`,
  `attack`, all already implemented as `Reflexes` response cases. **Never abandons the base goal**;
  it fights *while* continuing.
- **fight** — claims the base and runs the sustained kite/strafe/close/hold watch until the target
  is down, then hands the base back.

That is the line between "a zombie interrupted my mining" and "I committed to this fight", and it
is the **profile's** call, not a per-call argument. `Engage.java` converts from a base-intent watch
into a combat watch driven by (threat table × mode), keeping its station-point math and
`Follow`-matched repath cadence.

### 4.4 The honesty trap this opens

With engage **off**, `bot_target{action:"attack", target:X}` did nothing but write a table row. It
must not report success:

```json
{"designated": true, "engaged": false,
 "note": "combat mode off — nothing will act on this"}
```

Designation must **not** implicitly enable engagement — that would make a mode change invisible.
Instead `bot_target{action:"attack", target:X, engage:true}` keeps the common case at one call
while leaving the state change explicit.

---

## 5. The surface — hide by profile, collapse only where the criterion allows

### 5.1 The criterion this section must pass

`TOOL_BILL_PLAN.md` §3: **collapse when tools answer the same question at different arity or
resolution; never when they answer different questions.** A genuine routing decision moved into
arguments gets no harness support and is not what models are post-trained on. And its companion
rule: **hiding is free, collapsing is not** — so a tool a given session role doesn't need should be
profiled away (`MCPTK_HIDE_TOOLS`, L1) rather than merged.

Applying that honestly kills part of the original consolidation.

### 5.2 What survives the criterion

**`bot_target` — yes, but not on token grounds.** `goto`, `mine`, `attack` *are* different
questions, so the token argument alone would not license the merge. The licence is semantic: the
**repair loop cannot be decomposed**. "Get to a position where I can touch B, then break B, and fix
whatever goes wrong in between" is one goal with one verdict and one ledger; splitting it back into
`goto` + `mine` is exactly what costs the remedial turn. The merge is a *consequence* of the goal
loop, not a reason for it. If the goal loop were abandoned, `bot_target` should be abandoned too.

**`bot_body` — yes.** `spawn`/`despawn`/`possess`/`release` all answer one question at different
arity: *which body am I driving?* Adding the engage toggle keeps body-mode state in one place.

### 5.3 What does NOT survive — `bot_act` is withdrawn

`select`, `equip`, `use`, `eat`, `drink`, `look`, `point`, `shoot` answer **different questions**.
Merging them behind an `op` discriminator is precisely the routing-into-arguments move the criterion
forbids, and it would buy ~8 envelopes (~400 tokens ≈ low single-digit percent of a real bill, per
§0) at real accuracy risk.

**Instead: profile them (L1).** A survey/perception session needs none of them; a combat session
needs `equip`/`eat`/`drink`; a build session needs `select`/`use`. Hiding is free and reversible,
collapsing is neither.

### 5.4 The unexport question, restated

`bot_mine`/`bot_attack`/`bot_goto` can leave the *manifest* while their **tool bodies stay exactly
where they are** — `QueueRunner` ops and `Reflexes` responses call the bodies, not the schemas. The
arbiter's primitive-vs-base-intent split (`PLAYER_CONTROL_DESIGN.md` §2.1) survives untouched, and
§2.5's requirement that reflex responses stay routing-free primitives holds by construction (a verb
that navigates could never have been a reflex response).

Two things make this cheap to try and cheap to undo:

- **It is a Node-shim manifest transform, not a Java change.** `index.mjs` already rewrites the
  manifest via `MCPTK_HIDE_TOOLS`, so the whole hypothesis is measurable **before any Java is
  written**, as an arm alongside `with`/`swap`.
- **`dark-in-bench ≠ useless-in-production`** (`TOOL_BILL_PLAN.md` L1). The 47-dark figure drives
  *profiles*, never deletions — `world_edit` scored 0/6 dark only because no bench task edits
  anything. So the LOO/coverage data may retire a tool from a *profile*; it may not delete it.

### 5.5 Resulting surface

| tool | mechanism | disposition |
|---|---|---|
| `bot_target` | EMBODIED | absorbs `bot_goto` `bot_mine` `bot_place` `bot_attack` `bot_follow` + engage movement + `build` — licensed by the goal loop |
| `bot_body` | EMBODIED | absorbs `bot_spawn` `bot_despawn` `bot_possess` `bot_release` + **engage toggle** |
| `bot_status` | OBSERVE | absorbs `bot_inventory` (same question, different arity) |
| `bot_profile` | OBSERVE | perception mode + mobility profile + combat mode |
| `bot_reactions` | EMBODIED | unchanged |
| `bot_select` `bot_equip` `bot_use` `bot_eat` `bot_drink` `bot_look` `bot_point` `bot_shoot` | EMBODIED | **kept as separate tools**, profiled per session role |
| `bot_give` | PRIVILEGED | stays alone — precisely *because* it is audited |
| `bot_run` | EMBODIED | ad-hoc escape hatch; retire from a *profile* on bench evidence, do not delete |

### 5.6 MEASURED result (0.15.0) — the schema saving did not materialise

Built and measured, not predicted:

| | tools | description tokens |
|---|---|---|
| before (0.14.0) | 24 | ~3,341 |
| after (0.15.0) | **20** | **~3,556** |

**Description text went UP by ~215 tokens.** Six tools were absorbed (`bot_spawn` 142, `bot_despawn`
33, `bot_possess` 146, `bot_release` 30, `bot_engage` 166, `bot_inventory` 37 = 554 tokens removed),
but their replacements cost more than they saved: `bot_body` 375 + `bot_target` 342 = 717, plus
`bot_status` growing 72 → 124. Netted against ~6 saved schema envelopes (~50 tokens each), the
prefix is roughly **break-even**.

That is the §0 warning arriving on schedule — *merging moves text, it does not delete it* — and it
should be read as a **falsified sub-hypothesis, not a rounding error**: consolidating this surface
does not pay for itself in prefix tokens. `bot_target` and `bot_body` carry genuinely new capability
(the repair loop, `may_modify`, the ledger, the threat table, defend/fight), and new capability
costs description no matter which tool it hangs on.

**So the entire case now rests on turns** (§2, §3, §4.2) — server-side repair, the resumable ledger,
and the killed-enemy round trip — which is where §0 said the real money was. If the failure-path
bench does not show a turn reduction, this work does not pay, and the honest response is to say so
rather than quote the tool count. The remaining prefix lever is **profiles** (L1), which is free and
independent of any of this.

---

## 6. Build order

1. **`NavProfile` + `BuildNodeEvaluator` + `check_path` integration** (§1) — foundation; changes
   `check_path`'s contract.
2. **Obstruction locus + progress ledger** (§2) — pure reporting on top of (1).
3. **`Targets` selector + `GoalRunner` + `bot_target`** (§3) — the goal loop.
4. **engage → mode, `ThreatTable`, `Engage` conversion, `bot_body`** (§4) — removes `BaseKind.ENGAGE`.
5. **Profile + unexport as a shim arm, then the two licensed merges** (§5).

**Sequencing note:** step 5 needs no Java to *test* — `MCPTK_HIDE_TOOLS` in `index.mjs` can run a
bot-profile arm against the existing bench today, independent of steps 1–4. Writing the merged
**schemas** must come last, after the semantics settle, or they get written twice.

Per `PLAYER_CONTROL_DESIGN.md` §8, every step: declare `Mechanism`, register the class in
`McpToolkit.java` init, add the `conformance.test.mjs` spec entry (the CI ratchet fails otherwise),
add a `reach-goals.test.mjs`-style embodied probe, and bump `build.gradle` (minor for features, and
also for any response-shape change).

---

## 7. Verification

- **CI ratchet** — `conformance.test.mjs`: every added/removed tool must be reflected in the spec
  map or the test fails.
- **Existing embodied probes stay green** — `reach-goals`, `reflexes`, `reflexes-flee`,
  `reflexes-engage`, `act-honesty`. Each probe file needs its own `X-MCPTK-Session` (the drone slot
  is per-session and probe files run concurrently).
- **New probes:**
  - build-assisted path — wall a target off; `may_modify:none` reports `unreachable` **with an
    obstruction locus**, `may_modify:break` reaches it and ledgers the mined blocks;
  - door path — a closed wooden door routes and opens; an iron door is reported, not attempted;
  - engage-while-travelling — `bot_target destroy` with engage on, a mob interrupts, mining resumes;
  - designation with engage off returns `engaged:false` and does nothing.
- **Live run** — spawn a body and run a walled-garden scenario, confirming `check_path`'s verdict
  and the actual traversal **agree**. That agreement is the whole point of the shared evaluator.
- **Token/turn A/B — the measurement that justifies the work.** Run the existing testbench task set
  against the old and new surfaces. Use all **four** metrics from `TOOL_BILL_PLAN.md` §4, and the
  fourth is the one that gets forgotten:
  1. accuracy, 2. tokens split prefix/variable (`tool-cacheread-report.mjs`), 3. **turns** — the
  headline metric here, 4. **tool-call coverage** (`coverage-report.mjs`) — did anything go dark.

  The bench needs failure-path tasks to measure the actual thesis: the existing set is mostly
  perception, and remedial turns only appear where an embodied goal *fails* (walled-off target,
  occluded block, closed door). Add those rungs, or the A/B measures the wrong thing.

  Predicted: a measurable drop in remedial turns on failure-path tasks, and a **low single-digit**
  token improvement — not the manifest-headline figure (§0). Metric 4 is the guard against the
  §5.4 hiding arm silently retiring a load-bearing tool.

---

## 8. What is NOT built (0.15.0)

Stated plainly so the next reader does not assume the design equals the code.

- **`bot_target action:"build"`** — refused with an explicit message. It needs the schematic staging
  layer (Village Jobs `StructurePlacer.missing()`); the other four actions (move/destroy/place/attack)
  are live.
- **Build-assisted routing is WALKER-only.** `BuildWalkNodeEvaluator extends WalkNodeEvaluator`; a
  flyer has no gap to bridge and its `FlyNodeEvaluator` is a different solver, so `check_path
  body:"flyer"` ignores `may_modify` rather than pretending. The drone body still reaches goals by
  flying — the repair loop's break/bridge steps are what a walker needs.
- **`bot_profile` did not absorb the mobility or combat profile.** Mobility rights are per-call on
  `bot_target`/`check_path` (`may_modify`, `open_doors`, `budget`); combat mode lives on `bot_body
  action:"engage"`, which is where §4 puts it. The §5.5 table's "bot_profile = perception + mobility
  + combat" row is aspirational, not shipped.
- **The L1 bot profile arm** (hiding tools per session role via `MCPTK_HIDE_TOOLS`) is not run. It is
  independent of everything above and, per §5.6, is now the *only* remaining prefix lever.
- **Nothing here is live-verified.** The running bridge was still on 0.14.0 when this landed, so the
  conformance ratchet reports the old manifest and no embodied probe has exercised the repair loop,
  the ledger, or engage-as-mode against a real world. §7 is the plan for that, and the new probes
  it names are not written yet.

---

## 9. First live A/B (E-traverse, haiku, 1 seed × 3 courses) — the bench worked, the thesis is only partly shown

The whole case rests on turns (§5.6). A `goal` arm (`bot_target move`, server-repair) was added
alongside the existing `predict` arm (`bot_goto` + agent-repair) on the roofed obstacle courses
(flat / gap / doorway).

**First run — the bench caught a real bug.** The goal arm scored **18 turns vs 10**, all of the
gap on one course (1-wide gap: 12 vs 3). Cause: `bot_target move` reported `achieved` at 0.56 blocks
from the goal (inside the 2.5 arrival radius — correct), but the agent read `bot_status`, saw it was
not *exactly* on the goal cell, distrusted "achieved", and re-issued; the body was already in range
so it did not move, and this recurred — **12 turns of thrash**. Fixed: a move now returns
`already_there` with an explicit "do not re-issue" note when the body was already in range, mirroring
`bot_goto`'s long-standing distinction.

**Second run (after the fix):**

| arm | tool | arrived | turns | tokens (with-cache) |
|---|---|---|---|---|
| `goal` | `bot_target move` | 3/3 | **10** | **51k** |
| `predict` | `bot_goto` + agent repair | 3/3 | 11 | 74k |

Per course the goal arm won t1 (3 vs 4) and t3 (3 vs 4) and lost the gap by one (4 vs 3). So with
the verdict fixed it is **turn-neutral and ~30% cheaper in tokens** — the token saving coming from
`bot_target … wait:true` being a single call that returns the outcome, where the bot_goto arm spends
extra calls on `bot_status`/`check_path` to decide it is done.

**Two honest limits on that result:**

1. **n = 1 seed.** Suggestive, not conclusive. Turn deltas of ±1 are within noise.
2. **Repair never fired (`repairs:0` everywhere).** The only body that exists is the hovering drone,
   which flies *over* the floor gap and *through* the doorway at head height. So the goal arm's win
   here is purely the **one-call-vs-many** shape, NOT the server-side repair that is the design's
   headline. The repair thesis is still unproven and needs a **possessed walker body** on the same
   courses with `may_modify` on — the bench stages a walker's course but runs a flyer. That run is
   not yet done.

Net: the consolidation does not pay in prefix tokens (§5.6), but the goal shape already pays in
**per-task tokens** even before repair does anything — and the repair benefit remains to be measured
on a walker.

---

## 10. Pathfinding integration (0.16.0) — the decision moves into the search

The 0.15.0 repair loop was a fair critique target: it was a *greedy reactive patch* beside a real
planner it ignored. `GoalRunner.navigate` drove the body with plain vanilla A*, and on a stop-short
`NavSolver.obstruction()` looked at the single next cell toward the goal and applied a canned fix.
The build-aware `BuildWalkNodeEvaluator` — the thing that actually reasons about break/bridge/door
edges — was wired only into `check_path`. So the smart part and the execution were disconnected, and
the "how do I get through" choice was made by eyeballing one cell, not by cost.

0.16.0 closes that. Three changes, all live-verified:

### 10.1 Sprint-jump is a movement edge (not a bridge)

Vanilla mob pathfinding only steps 1-wide gaps. `BuildWalkNodeEvaluator.getNeighbors` now emits
**jump edges**: from a standing node, a running jump to a landing up to distance 5 (clearing a 3–4
block gap — the real sprint-jump reach), if the span is a genuine gap with clear arc headroom and a
standable landing. Cost is the distance plus a tiny surcharge — **cheaper than any bridge** — so A*
leaps a gap it can leap and only *places* blocks across gaps too wide to clear. Jumps cost no blocks
and apply to every profile (a movement capability, not a build one).

Live (`check_path body:"walker"`, void gaps a vanilla walker cannot cross): gap 2/3/4 →
`reachable:true`, `work.jumps ≥ 1`, `place_cells: 0`; gap 5 → `reachable:false`. Exactly
"sprint-jump covers 3–4 block gaps, bridge only beyond."

### 10.2 The repair decision comes from the plan, not from one cell

`GoalRunner.repair` no longer eyeballs a cell. It **re-solves build-aware** from the body's position
and takes `NavSolver.firstPlannedStep` — the first action the global search calls for along the
cheapest route (jump / open-door / mine / bridge). The vanilla nav still moves the body up to each
obstruction (that stays honest and cheap); the *choice* of what to do there is now the search's,
weighed by cost under the body's rights. Jumps are actuated per body: a flyer flies the arc, a walker
gets a ballistic leap. Every action is ledgered (`jumped`, `doors_opened`, `mined`, `placed`).

`obstruction()` survives only for **reporting** (`check_path`'s "why unreachable"), never for driving
the body.

### 10.3 Iron door → locate its control (first cut)

An iron door is no longer "give up." `NavSolver.obstruction` now searches a small box around it for a
lever / button / pressure plate and reports the control's coordinates in the remedy
(`obstruction.control {x,y,z}`), so the agent (or a future sub-goal) can go activate it. Honest
limit: it is a **proximity heuristic, not a redstone-wiring trace** — it names a plausible control,
not a proven one; the wrong control just leaves the door shut and the goal says so. The automated
navigate-and-press sub-goal is deferred.

Live: an iron door with a wall lever → `reachable:false`, `obstruction.path_type` DOOR_IRON_CLOSED,
`obstruction.control` at the lever, remedy "activate its control (lever) at x,y,z".

### 10.4 Still true

The **flyer caveat** (§9.2) is unchanged and now sharper: all of this is a *walker* capability, and
the only body that exists is the flying drone that sails over gaps and through doorways. §10.1 and the
iron-door locator are proven through `check_path` (no body needed); §10.2's execution — jump
actuation, plan-driven repair firing on a real body — is verified to not regress the flyer but is
**not yet exercised on a walker**, because there is no walker actuator that follows a custom plan.
That possessed-walker traverse remains the measurement that would actually prove the turn thesis.

---

## 11. The body architecture (§11.1–11.6 BUILT in 0.17.0; §11.4's FakeServerPlayer BUILT in 0.27.0 — see §11.8 for what it does and does not yet have)

This section was written as a handoff at the end of the 0.16.0 session and the design was executed
in 0.17.0: the copy set, `NavPhysique`/`NavBody`, the input-frame driver, `WalkerNavigation`,
`WalkerEntity` (spawn `type:"walker"`), and the entity-free `check_path`. §11.7 records what the
live measurement proved and what it caught. §11.4 (FakeServerPlayer) remains the un-built step 2.

### 11.1 Why a new body at all

Everything in §10 (build-aware pathfinding, sprint-jump edges, plan-driven repair, iron-door
locator) is a **walker** capability, and the only body that exists is the flying `DroneEntity`, which
sails over gaps and through doorways so `repairs:0` on every course (§9.2). The planner is proven
through `check_path`; its *execution* has never run on a body that can't cheat by flying. A ground
body is what turns the whole design from "proven in prediction" to "proven in the world," and it is
the measurement that would finally support or kill the turn thesis (§9).

### 11.2 The decision: build the pathfinding stack BODY-AGNOSTIC from the start

Minecraft pathfinding is two separable halves, and only one is `Mob`-coupled:

- **The search** (`PathFinder` + `NodeEvaluator` + `Path`) is nearly body-agnostic already. `PathFinder`
  only touches the entity to pass it to `evaluator.prepare(level, entity)`; the evaluator's
  `getBbWidth`/`getBbHeight`/`getBoundingBox`/`maxUpStep`/`onGround`/`canStandOnFluid` all exist on any
  `LivingEntity`. The *only* genuinely Mob-specific calls are `getPathfindingMalus(type)` (players have
  no malus map) and the `onPathfindingStart/Done` hooks (no-ops for a player). We already drive
  `PathFinder` directly in `NavSolver`, bypassing the body's own navigation — the search is basically
  detached from `Mob` today.
- **The driver** (`GroundPathNavigation`/`PathNavigation`) is the Mob-coupled half: it owns the Mob,
  holds the current `Path`, ticks it, and steers via `mob.getMoveControl()`. A `ServerPlayer` has
  neither. But `GoalRunner.actuateJump` is already a hand-rolled driver for one edge type; generalizing
  it to follow a whole `Path` **is** the custom driver.

**Proposed shape — a `NavBody` interface** implemented by both a Mob body and (later) a FakeServerPlayer:
position, bounding box, eye/step/jump height, a malus lookup, and the movement primitives (apply
velocity / set input / set pose). Then:

- copy `WalkNodeEvaluator` + `PathFinder` from `vanilla-src/` into our package and retype the one
  `Mob` parameter to `NavBody` (mechanical; `BuildWalkNodeEvaluator` already subclasses the evaluator);
- write ONE driver that follows a `Path` against a `NavBody`, delegating steering to whatever the body
  exposes (MoveControl for a Mob, simulated input for a player).

Result: not "Mob pathfinding we later port to the player" but *our* pathfinding, which any `NavBody`
gets. **Capabilities become per-body flags** — a Mob reports `canSneak=false, canElytra=false`; a
player reports `true`.

### 11.3 Step 1 — the Mob-walker (do this first)

`DroneEntity`'s grounded sibling: `extends PathfinderMob`, carries its own inventory (so the
`DroneHands`/`Actuator` machinery transfers unchanged — Possession throws `no_hands` only because a
random world mob has no inventory, not for any deeper reason), empty `registerGoals()`, and
`createNavigation` backed by the new `NavBody` driver + `BuildWalkNodeEvaluator`. Wire it into
`bot_body action:"spawn" {type:"flyer"|"walker"}` and `Slot.activeBody()`; the flyer stays for aerial
recon. **Build its nav on `NavBody` from day one** even though only a Mob implements it at first —
that abstraction tax is exactly what turns the player body from a rewrite into an extension.

Two subtleties from §10 that become real work here:

1. **Execution still interleaves the actions.** Even with build-aware nav producing the `Path`,
   vanilla path-following won't physically walk *through* an unbroken wall or an un-bridged gap — so a
   tick-watch still performs each planned action as the body reaches the work node. That is the
   plan-driven `repair()` already written; it just finally gets a body that moves.
2. **Sprint-jumps still need the impulse.** A vanilla mob's jump control does 1-block hops, not 3-4
   block sprint-jumps, so `actuateJump`'s ballistic launch is what makes the jump edges physical. This
   is the piece most in need of live tuning (overshoot / undershoot is the obvious failure mode).

### 11.4 Step 2 — the FakeServerPlayer (later; inherits the stack)

Its pull is twofold: **authenticity** (a real player break is exactly-vanilla and legibly attributed —
`ServerPlayerGameMode` timing/drops/durability/enchants, container UIs, hunger) and, more importantly,
a **movement vocabulary a Mob structurally cannot express**:

- **sprint-jump** — already an edge; on a real player driven with sprint+jump inputs the 4-block reach
  is authentic engine physics, not a hand-tuned impulse;
- **sneak** — player-only: an edge type (sneak-edges path along ledges the fall-clamp refuses) *plus* a
  pose (`setShiftKeyDown`, real crouch physics);
- **elytra** — player-only and a *different search* (glide physics: momentum, pitch-controlled descent,
  firework boost), most naturally a hybrid ground-nav-to-launch then glide-nav, riding
  `ServerPlayer.startFallFlying`.

By building against `NavBody` in step 1, this becomes "implement `NavBody` + a player-input driver + add
sneak/elytra edges," on top of a search and driver already tested on the walker.

**The genuinely hard, orthogonal part** is making a `ServerPlayer` exist headless: a `Connection` + a
no-op packet listener (the Carpet `EntityPlayerMPFake` trick), correct login/tracking/tick lifecycle,
and `shouldBeSaved=false` so it never persists as an ownerless ghost (the same discipline
`DroneEntity` already uses). None of that is pathfinding — scope it as its own slice.

This matches the architecture's long-standing "fake-player gap": capabilities are built body-first and
transfer to a real player character for free if it ever lands; the player-legal benchmark (§9 of
`PLAYER_CONTROL_DESIGN.md`) is its natural first consumer.

### 11.5 Explicitly out of scope

**Client / direct player control** (driving the *human's own avatar* from the client) is a different
feature — an "assist mode," client-side where the toolkit is server-authoritative. It does not give us
the autonomous walker we need and is kept out of this line of work.

### 11.6 Interface decisions (settled 2026-07-25, still design — no code)

The four open questions were settled by reading what the vanilla classes actually touch, not by
taste. Evidence lives in `vanilla-src/` (NodeEvaluator, WalkNodeEvaluator, PathfindingContext,
MoveControl) and our own call sites.

**1. The surface splits as DATA vs ACTUATION, not evaluator vs driver.** Everything the evaluator
reads off the `Mob` — width, height, position, `onGround`, `maxUpStep`, max fall,
`canStandOnFluid`, `getPathfindingMalus`, `level()` — is a read-only query about the body's shape
and physics; `PathfindingContext` needs only `level()` + `blockPosition()`. So:

- **`NavPhysique`** — pure reads: dimensions, eye/step height, max fall, fluid-standing, malus
  lookup, start position. This is what the search needs, and it needs no live entity: a synthetic
  physique record ("player-shaped: 0.6×1.8, step 0.6") can solve a path. That deletes the
  throwaway probe mob `check_path` spawns and discards today (`PredicateTools`), and it means
  check_path can PREDICT for a player-shaped body before the FakeServerPlayer exists — the §9
  measurement gets its prediction arm early.
- **`NavBody extends NavPhysique`** — the driver's half: movement primitives, capability flags
  (`canSneak`, `canElytra`, max jump gap), live position feedback.

**2. The driver drives INPUTS, uniformly — neither MoveControl delegation nor raw velocity.**
`MoveControl.tick()`'s entire output is `setYRot` + `setSpeed` + `setZza`/`setXxa` +
`jumpControl.jump()` — the same fields a player's client input writes, all consumed by the shared
`LivingEntity.travel()`. MoveControl IS an input-driver; the dichotomy was false. The uniform
driver emits a per-tick input frame `{yaw, forward, strafe, jump, sprint, sneak}` into a small
per-body **input sink** (Mob: setYRot/setSpeed/setZza + jumpFromGround — MoveControl's MOVE_TO
branch, ~30 lines; player: same fields + `setSprinting`/`setShiftKeyDown`). Both bodies get
authentic `travel()` physics; raw-velocity driving would bypass it and was the wrong branch.
*Build-time gotcha:* `Mob.serverAiStep` ticks the mob's own MoveControl, whose WAIT state zeroes
`zza` every tick — the walker must neutralize it (no-op MoveControl, or drive after controls run)
so the driver is the only input writer. Otherwise "walker won't move" will present as a mystery.

**3. Malus: the body OWNS its table; the profile writes into it per-solve.** Today
`NavProfile.applyTo(Mob)` mutates the real mob's persistent malus map — profile state leaks onto
the entity between solves. Instead `NavPhysique.malus(PathType)` is backed by a table the body
implementation owns, seeded from `PathType` defaults, door-rights written into it per solve. Mob
body, player body, and synthetic probe are identical on this axis; "players have no malus map"
stops mattering because nobody's native map is used.

**4. Jump tuning: shared edge model, per-body actuation.** The search-side jump-edge model
(clearance rules, max gap — the body reports its ceiling, the profile may clamp) stays shared in
the evaluator/profile. Actuation is the sink's private business: the player body has ZERO tuned
constants (sprint+jump inputs, authentic ballistics — the point of §11.4); the ballistic-impulse
constants now in `GoalRunner.actuateJump` move into the Mob sink. *Experiment first:*
`setSprinting` is a `LivingEntity` method (sprint speed-attribute modifier), so the Mob walker's
sprint-jump may work as sprint-flag + full-forward + jump with no tuned impulse; keep the
ballistic launch as the deterministic fallback if it can't clear a 4-gap.

**Copy set (minimal):** `NodeEvaluator`, `WalkNodeEvaluator`, `PathFinder`, and a ~20-line
`PathfindingContext` replacement, retyped `Mob` → `NavPhysique`. `Node`, `Path`, `Target`,
`PathType`, `BinaryHeap` are Mob-free — keep vanilla's, so paths stay interchangeable with
vanilla APIs and drift is contained to four copied files.

**Where the driver ticks (decided, held loosely):** a `PathNavigation`-shaped façade on the
walker, wired via `createNavigation` (already §11.3's wiring point), so vanilla goals and
`Mob.getNavigation()` callers compose with it — rather than a bare tick-hook owned by
`GoalRunner`, which nothing vanilla could use. Revisit only if the façade's contract (vanilla
calls `recomputePath`, `stop`, etc. at surprising times) fights the goal loop in practice.

### 11.7 Built and measured (0.17.0, live 2026-07-25)

The walker exists and the §9 turn-thesis measurement finally ran on a body that cannot fly
(`probes/walker.test.mjs`, 7/7; regressions bot-target 12/12, conformance 40/40, reach-goals
11/11, profiles 6/6, predicates 7/7, act-honesty 10/10):

- **One `bot_target move` crosses a penned 3-gap** with a physical sprint-jump, disclosed as
  `ledger.jumped` (driver self-leaps drain into the goal ledger — a leap the body took and did not
  report would be a silent world-interaction).
- **`repairs > 0` for real:** a sealed corridor with a stone plug, `may_modify:break` — the walker
  walks, stalls honestly, mines the plug (`ledger.mined`), arrives.
- **A shut wooden door is physically opened** en route (`ledger.doors_opened`).
- **`check_path` walker is entity-free** (SyntheticPhysique; the villager probe is gone) and now
  models the real walker: a PLAIN check leaps gaps and discloses `work.jumps`. This is a deliberate
  contract change from "absent profile = vanilla villager nav".

Execution bugs the live run caught that prediction never could (all fixed):

1. **`firstPlannedStep` missed off-node work.** BREAK is recorded at the blocked cell (feet OR
   head) and PLACE at the missing floor, but the step scan only looked up each path node's feet
   cell — after the feet block was mined the head's planned break went invisible and the loop
   wandered to the next column until the budget died. The scan now checks feet/above/below.
2. **`OPEN_DOOR` was never planned** — the evaluator routed through rights-opened doors as
   `WALKABLE_DOOR` (pure prediction) and no code path wrote the action, so `GoalRunner`'s door
   branch was dead code and every "doors opened en route" claim rested on check_path alone. Door
   cells the search routes through are now recorded as OPEN_DOOR work, and the goal loop opens
   them the way vanilla `OpenDoorGoal` does (`DoorBlock.setOpen` — a bare-hand block interaction;
   routing it through the item-centric `botUse` stalls on `empty_hand`).
3. **Work-approach arrivals read as goal arrivals.** Walking into reach of a far work cell is
   navigation too, and its `arrived` completion made a `move` goal declare "achieved" while the
   wall it was supposed to mine still stood, merely visible. Approaches are now tagged
   (`Goal.workNav`) and re-enter the repair decision instead of completing the goal.
4. **Probe-course honesty:** `bot_target`'s 2.5-block arrival radius pierces 1-thick walls — the
   walker twice "achieved" from OUTSIDE a pen by standing against the wall. Measurement courses
   need 2-thick shells; noted here because any future "get inside the room" goal semantics will
   hit the same radius.

**Verification round two** (`probes/walker-caps.test.mjs`, 15/15; full battery = all 22 probe
suites green, 194 tests, walker suites idempotent on rerun):

- **Bridging EXECUTED** — the last never-run pipeline: a 7-gap crossed by placing floor
  (`ledger.placed`), ringed by its honesty stops (plain profile → unreachable + bridgeable
  obstruction; place rights with an empty inventory → `item_missing`; break budget 1 vs a 2-cell
  plug → `break_budget_spent` with exactly one mined cell, then a default-budget re-issue finishes
  the job off the resumable ledger). Observed emergent correctness: mid-crossing the solver
  switched from bridging to a JUMP once the remaining gap shrank inside jump range — 3 places + 1
  leap beat 7 places on cost, which is the A* doing its job.
- **Max-range jump (4-gap, landing distance 5 = the ceiling)** leapt both ways — the return
  crossing through plain `bot_goto`, i.e. the façade's own leap with no goal loop. This CAUGHT an
  undershoot: the leap fired the moment the landing became the next waypoint (up to a full cell
  before the edge) and the old 0.14/0.62 launch fell short at max range — the walker dropped into
  the trench, escaped through the course's hollow underdeck, and fell 139 blocks into the ocean.
  Fixed with a trigger gate (walk to within `maxJumpGap + 0.2` of the landing before leaping) and
  a live-tuned launch (0.15/0.68), synced into the possessed-body ballistic branch.
- **Stairs both ways** (the driver's step-up jump replacing MoveControl's, then the
  falling-advance descent), **hands transfer on the walker** (give → status inventory → place →
  mine back; the BotBodyEntity point proven), **iron door** honest stop naming the lever
  (`obstruction.control` — with the course sealed so the door IS the frontier), **possession
  interplay** (possess while a walker is spawned, release returns to it), and the **re-issue
  guard** (`already_there`, not a fresh achieved).
- Honesty word fix: `bot_place`/`bot_use` with a NAMED absent item now say `item_missing` (their
  documented word) instead of collapsing into `empty_hand`.
- Course-building lesson recorded: trenches must be carved into SOLID ground — a 1-thick floating
  slab makes every stranding cascade into the void below, which reads as a mystery `drone_removed`.

Still open, deliberately: the Mob-walker's leap is the hybrid actuation (ballistic launch + held
sprint/forward — deterministic; the pure-inputs experiment of §11.6 (4) is untried); the walker
reuses the drone's ball renderer as an honest placeholder; the possessed-mob bare-ballistic jump
branch remains unexercised by a probe; and §11.4's FakeServerPlayer is untouched — it inherits all
of this by implementing `NavBody` + an input sink, which is exactly what the abstraction tax was
paid for.

### 11.8 Step 2 BUILT — the FakeServerPlayer exists and walks (0.27.0, live 2026-07-26)

§11.4's player body is real: a headless `ServerPlayer` that logs in with nobody behind it, falls,
walks, and sprint-jumps a gap on the engine's own physics. Probe `probes/fake-player.test.mjs` 7/7
live; regressions green on the same server (walker 7/7, walker-caps 16/16, bot-target 13/13,
predicates 8/8, reach-goals 11/11, conformance 34/34).

**The abstraction paid.** The search, `BuildWalkNodeEvaluator`, and `NavDriver` were reused
*unchanged* — the §11.2 bet. What had to be written was the sink, the existence slice, and one
40-line path-follower.

- **Existence (`FakeConnection` + `FakePlayers`).** `Connection`'s netty channel is private and only
  ever assigned by a real pipeline, so the fake subclass overrides exactly what would touch it:
  `setupInbound/OutboundProtocol` (vanilla calls `channel.writeAndFlush` *unconditionally* — an
  instant NPE inside `placeNewPlayer`), all three `send` overloads and `flushChannel` (whose
  not-connected branch parks packets in an unbounded `pendingActions` queue — a slow leak over a long
  bench session), and `isConnected` → true. `disconnect`/`setReadOnly`/`handleDisconnection` are
  already null-safe in vanilla and stay inherited: the smaller the override surface, the less drifts
  on a game update. The connection is deliberately NOT registered with `ServerConnectionListener`, so
  no keep-alive can kick a player that can never answer.
- **The tick pump — the one that would have silently sunk this.** `ServerPlayer.doTick()`, which runs
  *all* of `LivingEntity`'s physics, is called from exactly one place in vanilla:
  `ServerGamePacketListenerImpl.tick()`, i.e. only for registered connections. Unpumped, the body
  hangs in the air forever. `FakePlayerEntity.tick()` pumps it; the probe's decisive rung spawns the
  body 6 blocks up and requires it to land.
- **Why a player at all.** `Player.isEffectiveAi()` and `canSimulateMovement()` are both
  `!level().isClientSide()`, so server-side `aiStep` feeds `travel(xxa, yya, zza)` for a player just
  as for a mob. Writing the input frame therefore yields *authentic* physics, and `launch()` — the
  walker's ballistic shove — becomes a plain `setJumping(true)`. **Zero tuned constants**, as §11.6
  decision 4 promised.
- **Two live-only findings, both about momentum** (neither reachable by reading code):
  1. *A physics leap needs a run-up.* The body walked to the lip and cleared 3.0 blocks of a 3-block
     gap, landing 0.3 short against the far face. `NavDriver.steer` had always driven the approach
     with `sprint=false`; a ballistic body does not care (its launch overwrites velocity) but a real
     sprint-jump adds its boost to *existing* momentum. Now `NavBody.leapNeedsRunUp()` (default
     false → the walker's approach is byte-identical) and `PlayerNavigation` looks 4 nodes ahead for
     a planned landing, because by the time the landing is the current waypoint the leap gate fires
     in the same tick.
  2. *A fixed arc must leave from the lip.* Sprinting alone changed nothing — take-off was still
     ~0.8 blocks early, because the gate fires as soon as the landing is *within* `maxJumpGap`. A
     ballistic body can afford that (its impulse scales with distance); a fixed arc cannot, so every
     early block is range thrown away. `readyToLeap` now holds a run-up body until there is no
     footing ahead — over the void it is about to cross, that IS the take-off edge. Take-off moved
     11.7 → 12.0 and touchdown 14.70 → 15.42, on the apron.
- **Never persisted.** Same doctrine as `BotBodyEntity.shouldBeSaved`. `PlayerDataStorage.save` does
  not consult `shouldBeSaved`, so `saveWithoutId` writes nothing *and* `FakePlayers` deletes the
  `.dat`/`.dat_old` husk that `PlayerList.remove` insists on writing. Verified by re-spawning the
  same name and requiring it to land where commanded at full health.
- **No MCP tool surface, on purpose.** Driven by `/mcptk fakeplayer …` through the existing
  `run_command`. A body that cannot yet act has not earned a manifest slot under the collapse rule,
  and a throwaway tool would have to be un-shipped later.

**§11.8b — THE WIDENING SHIPPED (toolkit 0.34.0, 2026-07-30; SURVIVAL_MODE_PLAN.md drove it).**
The paragraph below is now history: `Slot.activeBody`/`Actuator.body`/`requireBody`/`PendingNav.body`
and the Follow/Engage/Reflexes/Perception/DroneObserver/DroneHands signatures are typed
**`LivingEntity`**, with ONE new seam — `Bodies.nav(LivingEntity)` — because navigation was the only
Mob-rooted dependency (everything else the surface needs already lives on `LivingEntity`/`Entity`).
`bot_body spawn type:"player"` binds a `FakePlayerEntity` to the session (`Slot.player`, offline-name
= sanitized session id, spawn/replace/despawn/reap lifecycle symmetrical with the drone's).
Player-native verb branches (`PlayerVerbs`): `Player.attack` combat, consume against real
`FoodData`/hunger, equip/select/inventory against the REAL 36-slot `Inventory` — which also
auto-collects drops natively (no pickup verb needed; being a player is the mechanism). Honest v1
gates: mine/place/use/shoot refuse through `Actuator.hands()` naming the pending slice;
`bot_target` refuses `player_goals_pending` (`GoalRunner` stays Mob-typed inside — its
walker leap/pillar machinery is untouched). Probes: `player-body.test.mjs` 9/9 live (grounded
spawn + hunger + tab list, PlayerNavigation goto, native pickup, real eating, attack, honesty
gates, clean despawn); regression sweep 73/73 (walker, walker-vert, fake-player, walker-caps 16/16,
reach-goals, reflexes, bot-target, profiles). One latent probe bug found en route: walker-caps'
blank-slate fill exceeded /fill's 32,768 cap and had failed silently on every run ever — fixed
(sliced) after a probe-site collision exposed it as a stone in the 4-gap jump lane.

**What is NOT built, and the structural finding that scopes it** *(historical — see §11.8b)*.
§11.4 predicted step 2 would be
"implement `NavBody` + a player-input driver + sneak/elytra edges". That is true of the *nav stack*
and false of the *control surface*: `DroneTools.Slot.activeBody`, `Actuator.body`, `Possession`,
`GoalRunner`, `Follow`/`QueueRunner`/`Engage` are all typed to **`Mob`**, and a `ServerPlayer` is not
one; `BotBodyEntity` (hands/beam/inventory) is a `PathfinderMob`, which a player cannot extend. So
the player body today has no hands, no goal loop, no possession, and no `bot_*` verbs. Making it a
first-class body is a **`Mob` → `LivingEntity` widening through the control surface** — code the
0.24.0 review round just hardened — and it is its own slice, not a footnote to this one. The same
`Mob` typing is why `PlayerNavigation` exists at all: `PathNavigation`'s constructor takes a `Mob`,
so the player cannot inherit vanilla's path bookkeeping the way `WalkerNavigation` does. Sneak and
elytra edges (§11.4's headline capabilities) are also still unbuilt — `canSneak()` reports true, but
the evaluator plans no sneak edge yet.

---

## 12. Review hardening round (0.24.0) — the new layers get the old layers' disciplines

A two-track adversarial review (control loop + nav stack) found the defects clustered where the
newest code had skipped disciplines every older layer already had. All fixed and live-probed in
0.24.0:

**Containment and lifecycle (the goal loop's missing guards):**

- `GoalRunner.tick`/`onActionDone`/`onActionFailed` are exception-contained like `QueueRunner`
  always was — an act/repair body that throws fails THAT goal honestly instead of escaping into the
  server tick (a possessed body reaching a hands-gated act was a server-killer).
- `bot_target` refuses `destroy`/`place`/`may_modify` on a hands-less possessed body at START
  (`no_hands`), and validates its profile BEFORE `claimBase` — a typo'd `may_modify` no longer
  destroys the running queue/follow/goal (bot_goto's validate-first discipline).
- Every body-lifecycle teardown site (spawn-replace, possess, release, despawn, session reap,
  SERVER_STOPPING) now aborts a running goal — no goal silently continues on a new body, no
  `wait:true` waiter parks to timeout on session death.

**Prediction/execution parity (the build-aware layer's bookkeeping):**

- **The plan is committed to the winning path.** Work is recorded per (parent → child) edge during
  the search and `commitPlan(path)` keeps only the returned path's edges — a BREAK planned by a
  rejected branch at a cell the winning route merely passes (its floor) can no longer drive
  execution into mining the floor from under its own feet. `check_path`'s `work` counts are now the
  chosen route's plan, not a frontier upper bound.
- **Budgets bind prediction.** A zero budget emits no edges of that kind; a committed plan that
  exceeds `budget` makes `check_path` answer `reachable:false` with `break/place_budget_exceeded` —
  matching execution, which stops partway with `break_budget_spent` (partial progress + resumable
  ledger unchanged, deliberately).
- **Jump edges check APEX headroom (y+2)** along take-off, span, and landing — under a 2-high roof
  (the bench's roofed courses!) the body bonks and undershoots, so that jump is no longer planned.
- **Repair-actuated leaps respect the trigger gate.** `actuateJump` beyond `maxJumpGap + 0.2` walks
  toward the landing first (as work approach) instead of launching an undershoot — the trench-fall
  fix now covers the path the fix forgot.

**Honesty:**

- `ledger.jumped` is written at VERIFIED TOUCHDOWN only (driver drain for walker leaps, a tick-watch
  verdict for the possessed ballistic branch) — it was the one ledger entry recorded as a
  prediction, violating the ledger's own contract.
- A `move` goal has ONE completion vocabulary: `achieved` (traveled, with the do-not-reissue note)
  / `already_there`. The un-noted navigated-arrival variant re-invited the §9 thrash.
- A kind-selector `attack` is armable with nothing in range (`standing_rule`, honest note) — "arm
  the defenses before the night raid" used to fail `no_target` exactly when most wanted.
- A cancelled `shield` reflex stops blocking (`stopUsingItem` on cancel, not just natural expiry).
- `Slot.baseSuspended` is DELETED: it was written by two layers and read by none. Body ownership is
  the tick-watch return-value gating, now stated as the contract; `Reflexes.resume` no longer
  re-drives navigation while fight-mode combat holds the body.
- `check_path` disclosures: door-rights default divergence vs `bot_target` is named in both
  descriptions; `max_length` is clamped to 512 (server-thread solve); `bot_point` no longer claims
  to be drone-only (any toolkit body has the beam).
- **A parked `wait:true` call counts as session liveness.** Liveness was refreshed per bridge call,
  so a session whose one call was a 3-minute waited goal went "stale" mid-wait and the reap killed
  its body under it — surfaced by the 0.24.0 teardown fix itself, which turned the old mystery stop
  into an honest `session_ended` the probe battery then caught. The reap now skips a slot while a
  goal/queue/nav waiter is still open.

### 12.1 The walker traverse A/B finally ran (bench 0.9.2, 2026-07-26)

§10.4 named the measurement that would prove the turn thesis on a body that cannot fly; E-traverse
gained a `--body walker` axis (flyer default byte-identical to 0.9.1; walker tube is 3-high inside —
the apex rule §12 makes a jump under a 2-high roof honestly unplannable — with its own course cells).
haiku, 1 seed × 3 courses (flat / 1-wide gap / wall+doorway), arms goal vs predict:

| body | arm | arrived | turns | tokens (with-cache) |
|---|---|---|---|---|
| walker | `bot_target` goal | 3/3 | **9** | **51k** |
| walker | `bot_goto`+check_path | 3/3 | 11 | 81k |
| flyer | `bot_target` goal | 3/3 | **8** | **45k** |
| flyer | `bot_goto`+check_path | 2/3 | 12 | 88k |

- **The walker gap crossing is one call**: `bot_target move` → `achieved`, `ledger.jumped` at the far
  gap edge (verified touchdown), `repairs:0` — the §11.7 probe result reproduced under a real agent.
- **Predict-vs-execute matched 6/6 on the walker** — the shared-solver parity §1.1 promised, now
  measured on a grounded body (flyer 5/6; the miss was the agent stopping 0.3 blocks outside the
  arrival radius and declaring arrival — behavior, not solver).
- Same honest limits as §9: n=1 seed, and the courses are mild (repairs never fired — a
  `may_modify` failure-path rung is still the missing measurement for the repair loop itself).
- Consistent with §9's 0.15.0 flyer numbers (goal 10t/51k vs predict 11t/74k): the goal shape's
  ~2-turn / ~35-45% token advantage replicates across two bodies and survives the 0.24.0 hardening.

### 12.2 E-repair, first run (bench 0.9.3) — the failure-path ladder works, and it found two gaps

The remedial-turn ladder (FREEZE_PLAN F1) ran its five rungs (haiku, 1 seed, goal vs hand):

- **Working as designed:** `plug_break` (both arms 3 turns; the hand arm is competitive on a mild
  break), `door_shut` (goal 2t/11k opens it en route; hand 3t/24k must MINE it — `bot_use` has no
  bare-hand block interaction, a real asymmetry now priced), `budget_resume` (textbook §2.2: stop
  `break_budget_spent` with 2 mined, ONE re-issue finishes off the ledger, 4 turns total, no
  re-survey), `iron_control` after one iteration (modification must be physically off the table —
  the first run's agents just MINED the breakable iron door, the hand arm in 3 turns, the goal arm
  by passing itself `may_modify`; with mine/place tools dropped and rights forbidden, both arms
  stop honestly, reply BLOCKED, and NAME the lever from the obstruction locus).
- **`bridge_gap` failed BOTH arms and exposed two real toolkit gaps:**
  1. **The walker falls off its own in-progress bridge.** It placed 3 correct cells, then the
     approach toward the next work cell walked it off the bridge end into the 4-deep trench
     (`traveled_to y:147`). walker-caps bridged this same geometry — the fall is probabilistic
     (driver steering cutting a corner over an unbridged lane). Needs a probe + driver care near
     missing-floor cells.
  2. **No vertical mobility edges.** From the trench floor, `unreachable` is HONEST (place/break
     edges are same-Y only) — but the body had 60 cobblestone and any player would pillar up.
     Pillar-up (place-below + jump, +1Y) and stair-mine are the missing edge class; until they
     exist, a fallen walker with full pockets is stuck and says so.
  The goal arm then thrashed 20 turns / 226k and **falsely claimed ARRIVED — which the new
  `claimed`/`claim_matches` column (F2) caught on its first outing.** The rung stays in the ladder
  as a known-red capability boundary; it flips green when (1) and (2) land.

**Still open from the review, deliberately:** engage-vs-explicit-command arbitration (a fight-mode
hold re-claims within a tick of `claimBase` — the mode persists by design, but the agent-intent-wins
promise should either extend to it or be documented as not doing so); no `after_combat` attribution
on queue failures (the reflex layer's `after_reaction` courtesy has no combat sibling); per-tick
entity scans don't share one sweep per slot; execution's FOLLOW_RANGE(64)-bounded paths vs
prediction's 256+ ceiling (a long confirmed route burns repairs on nothing being wrong);
cross-dimension individually-designated threats are reaped as gone; possessed-body prediction parity
is unowned (`check_path` cannot model a possessed cat's malus table); and the input frame still
lacks strafe/sneak (§11.6's spec is wider than `NavBody.driveInput` — the FakeServerPlayer will
force the revision).

### 12.3 The vertical edge class + driver edge-care (0.26.0) — bridge_gap's two toolkit gaps

The two capability gaps §12.2's `bridge_gap` rung exposed — the first new work the bench *demanded*
rather than merely measured — are built. Compiles clean; live tuning/verification is the next
session's first task (the dev server was down when this landed, so the timing constants below are
reasoned, not measured — flagged wherever they need a live pass).

- **Driver edge-care (fall #1).** The walker fell off its own in-progress bridge because
  `NavDriver.steer` chased waypoints in a straight line and let momentum carry it over an unbridged
  lane. Now the driver probes `NavBody.footingAt(x,z)` one `EDGE_LOOKAHEAD` (0.7) ahead of itself and
  zeroes forward when nothing solid is within a survivable step-down (`maxFall+1`, aligned to the
  search's own descent limit) — it **holds at the lip** and lets `travel()` friction stop it there.
  The search only ever routes over solid ground, so a void a step ahead is never on the intended
  path; it is a bridge end or a corner the straight-line steer would cut. This is also what *paces
  bridging*: hold at the edge → the goal loop places the next cell → footing ahead goes solid →
  advance. A `SyntheticPhysique` (which never drives) reports footing `true`, so `check_path` is
  untouched. Skipped for a jump waypoint (the leap gate owns that approach). Low regression surface:
  on flat ground / stairs / legal descents footing is always found, so behaviour is byte-identical —
  the hold only fires at a genuine deep edge, exactly where the fall was.
- **The vertical edge class (fall #2 — "stuck with a full inventory").** `BuildWalkNodeEvaluator`
  gains two edges the flat same-Y `planNode` could not express, both gated on `hasFloorBelow` (you
  cannot climb off air):
  - **Pillar-up** (`Action.PILLAR`): drop a block into the body's own feet cell and jump onto it,
    +1Y same column. Needs place rights + a live budget and the two cells above clear (new feet +
    apex; the modest jump keeps the head inside the y+2 cell the search cleared). `GoalRunner` drives
    it as a leap-shaped state machine (`pillarAt`/`pillarPhase`): recentre on the column (a sub-block
    nudge so it lands squarely on the 1×1 block), launch straight up, place at apex once the feet
    clear the cell (a real `bot_place`, disclosed as `ledger.placed`), verify touchdown one block up,
    re-navigate. Priced at 4 block-equivalents so A\* only towers out of a genuine pit. This is the
    place-rights escape the bench's cobblestone-carrying walker needed.
  - **Stair-mine**: step up one block in a horizontal direction by mining the feet/head cells that
    block the ascent, over a solid step to climb onto. Recorded as plain `Action.BREAK` — once
    cleared the ledge is an ordinary driver step-up, so the actuation is entirely reused; the search
    edge is the whole addition. The break-rights sibling of pillar-up.
  Budget/disclosure parity: a pillar-up counts against the **place** budget (`NavSolver.overBudget`
  and `check_path`'s `work.place_cells` both fold `PILLAR` in), so a towering route can never predict
  free and then be refused at execution.
- **`walker-vert.test.mjs`** (probe-owned site 3.47M) covers all three: edge-care through the bridge
  pipeline (crossing a 7-gap must END on the walk level alive, never the trench floor), pillar-up out
  of a 4-deep open pit, stair-mine onto a raised platform, each with its `check_path` prediction
  parity (reachable only with the matching right).

**LIVE PASS DONE (2026-07-26, in the 0.27.0 build — 0.26.0 was never committed separately, so the fix
below folds into it).** `walker-vert.test.mjs` **8/8**, including execution rungs, not just
prediction: the walker tows itself out of the 4-deep pit to the surface goal, cuts a stair-mine step
onto the platform, and crosses the 7-gap bridge ending on the walk level alive. The reasoned timing
constants (`PILLAR_JUMP_VY` 0.42, place clearance 0.02, recentre-and-land) all held on first contact
and needed no tuning. Battery re-green on the same server: walker 7/7, walker-caps 16/16, bot-target
13/13, predicates 8/8, reach-goals 11/11, conformance 34/34 — the new search edges shift no existing
prediction.

**The one real defect the live pass caught: a pillar could only ever be planned ONCE.**
`hasFloorBelow` reads the WORLD, and the world does not contain a block the search has merely planned
to place — so the child of a `PILLAR` edge looked unsupported, the vertical-edge gate refused to fire
again, and towering out of anything deeper than one block was unreachable. `check_path` reported it
honestly (`place_cells: 1`, then `reachable: false` BLOCKED on the pit wall) which is exactly how it
was found; the bug was in the search, never in the actuation — the goal loop's pillar state machine
was correct all along and had simply never been asked for a second rung. Fixed with a
`pillarSupported` cell set: a `PILLAR` edge remembers that its landing rests on the block it places.
Chains stay physically sound by induction — the FIRST pillar of any chain still requires a real
`hasFloorBelow`, so support grounds out on real terrain — and entries left by losing branches are
harmless for the same reason, with `commitPlan` still the only thing that decides what execution
performs and what the budget is charged for.

**§12.2's `bridge_gap` is CLOSED** (E-repair re-run `2026-07-26T18-40-27-repair-haiku`, ratchet
green): the rung flipped green on BOTH arms — arrived, `final_dist` 0.6, alive — where it had been a
KNOWN-RED capability rung. The ladder as a whole: goal 5/5, hand 4/4, every row `claim_matches: true`
(no false ARRIVED this time, unlike its first outing). `bridge_gap` cost the goal arm 2 turns/12k wc
against the hand arm's 3 turns/25k, and the ladder total is the same 13 turns for both arms at
67k vs 105k — the goal loop's saving is tokens per remedial turn, not turn count, on rungs this mild.
`iron_control` remains `arrived: false` BY DESIGN (it is the diagnosis rung; both arms named the
control). This is the first time a capability the bench DEMANDED — rather than merely measured — was
built and then verified by the bench itself.

### 12.4 Swimming + the stall watchdog (0.37.0) — the live hang, and the medium the bodies could not enter

A watched survival session wedged: pathfinding stopped and the agent waited on a completion event
that could never arrive. The diagnosis found two independent defects that compound into exactly that
symptom, plus a whole capability that had never been built.

**The hang was structural, and it was the player body.** A `bot_goto` ends when
`Bodies.nav(body).isDone()` goes true and by no other route — there was no timeout and no progress
test anywhere. Mob bodies inherit vanilla's `doStuckDetection` (via `followThePath`), so they escape.
`PlayerNavigation` had none, and said so in its own javadoc: *"stuck detection … a caller-owned
concern here, since the goal loop already re-solves."* The goal loop cannot re-solve — `GoalRunner.tick`
returns immediately while `goal.waiting != null`, and `waiting` clears only on the completion this
navigation was supposed to emit. The delegation was circular, so nothing owned the invariant.

**What stopped the body was water, via a one-line semantic.** `NavDriver`'s edge-care (§12.3) zeroes
forward input when `footingAt` finds nothing solid within a survivable drop. `footingAt` tests
`isPathfindable(LAND)`, and vanilla's `LiquidBlock.isPathfindable` returns `!lava` — **water is
pathfindable**, so any water column deeper than `maxFall+1` read as *no footing*. The body walked to
the shoreline, froze with forward at zero, and on the player body froze forever.

**And swimming did not exist at any layer.** `NavProfile.applyTo` never set `canFloat`, so
`WalkNodeEvaluator` routed water through `tryFindFirstNonWaterBelow` — planning a walk along the
seabed, which for a body that breathes is a drowning route dressed as a path — and `getStart` dragged
a floating body's start node down to that seabed, leaving waypoint zero unreachable. `getNeighbors`
iterates only `Direction.Plane.HORIZONTAL`, so there were no vertical edges at all. `NavDriver`'s
input frame had no vertical term. Nothing ever set `setSwimming`. Air was *sensed* (`Hazards`,
`air_low`, and the `surface` reflex op) but never *planned*.

The fix is four layers, each independently testable:

- **The watchdog** lives on `DroneTools.PendingNav`, not inside either follower — so a body kind added
  later cannot reintroduce the hang by forgetting to implement it. No progress for `STALL_TICKS`, or
  `NAV_MAX_TICKS` outstanding, cuts the path; because it cuts rather than reports specially, the
  *same* honest verdict machinery runs and a stall is repairable exactly like any stopped-short nav.
  The new outcome words `stalled` and `nav_timeout` exist because "wedged here" and "no route from
  here" call for different remedies, and the note says so — re-issuing the same `bot_goto` is
  precisely the wrong move for the first. `PlayerNavigation` also gained a per-node timeout, so it
  stops claiming to be alive when it is not.
- **Water as a path type.** `NavProfile.canSwim` wires vanilla's `canFloat` (which flips the whole
  amphibious branch), `BuildWalkNodeEvaluator` overrides `getStart` to anchor a swimming body where it
  actually is, and `swimNode` adds the vertical edges. Rising requires the body to already be in
  water, so the only air cell reachable that way is the one above the surface — the breath cell — and
  from there no further ascent exists. That is what keeps a swim edge from becoming flight.
- **The swim driver.** `NavBody.driveSwim` is a separate sink from `driveInput`, so land behaviour
  stays byte-identical. It needs no tuned constants: `LivingEntity.travelInWater` feeds the input
  through `Entity.getInputVector`, which rotates x/z by yaw and **passes y through untouched**, so
  `yya` alone is a complete vertical control. Pitch is aim rather than propulsion there — and still
  load-bearing, because a sprint-swimming player is pulled along its look vector by `Player.travel`
  and because every perception read comes from that eye. `swimmableAt` gives edge-care its second
  clause: a swimmable column is not a lip to freeze at, it is the next medium.
- **Air, split the way breaking and bridging already are.** Encoding breath into A* would mean
  searching over (position × air) — the unbounded state space §1.3's tractability rule exists to
  refuse. So the search *prices* submerged cells against the body's remaining breath (stateless, and
  it biases toward surface routes on its own), and `SwimControl` *enforces* the budget on the live
  body, where the real number is. Crucially it **overrides rather than interrupts**: it swims up,
  breathes, and hands the route back. The pre-existing `surface` reflex aborts whatever the body was
  doing, so under it a long crossing could only ever fail politely; this one completes. An unwinnable
  surfacing (ice overhead) is time-boxed, and a genuine trap is then the watchdog's to report.

`NavProfile.VANILLA` is deliberately kept **non-swimming**: it is the A/B reference the bench's pinned
arms solve against. Live bodies use the new `NavProfile.DEFAULT` (same rights, plus swimming), and
`swim` defaults true on `bot_goto`/`bot_target`/`check_path` with `swim:false` as the land-only
question. Prediction assumes a full lungful — `check_path`'s `from` need not be a live body — which is
disclosed in the tool description rather than hidden, since a half-drowned body will prefer shallower
routes than it predicts.

Verified by `mcp-server/probes/swim.test.mjs`, **7/7 live**: prediction parity across the channel, the
shoreline crossing itself, an underwater goal reached by the vertical edges, a dive-and-surface round
trip that ends alive, and — the regression that matters most — a corridor walled off **mid-flight**,
which must end in `stalled` within seconds. That last one is shaped as a race and asserts by
*returning at all*: "waits forever" has no return value to assert against.

**Two defects only the live run could find**, both invisible to compilation:

1. **A fresh `Node` is `BLOCKED`.** `swimNode` guarded with `if (n.type == PathType.BLOCKED) return
   null`, meaning "don't hand back a cell already known impassable". But `Node.type` *initialises* to
   `BLOCKED`, so every newly created node looked blocked and **every vertical swim edge was
   rejected**. The symptom was maximally misleading: surface swimming worked perfectly (those nodes
   arrive pre-typed from `super.getNeighbors`) while no dive or ascent ever fired — which reads
   exactly like "the search refuses to go down". Every other edge builder here sets `type`
   unconditionally; the guard was the outlier and is gone.
2. **Two stuck detectors raced, and the quieter one won.** `PlayerNavigation`'s node timeout (100
   ticks) fires before the pending-nav watchdog's window (120), calls `stop()`, and by the time the
   watchdog looks the path is merely "done" — so a wedged body was reported as an ordinary
   `stopped_short`, whose advice ("re-issue bot_goto") is precisely wrong for a body that will wedge
   again in the same cell. Fixed by making "I ended because I was stuck" a first-class signal:
   `Bodies.Nav.stalled()`, backed by vanilla's own public `PathNavigation.isStuck()` for Mob bodies
   and `PlayerNavigation.timedOut()` for the player. A useful side effect — the walker's *inherited*
   vanilla stuck detection is now labelled honestly too, which it never was before.

### 12.5 Mined descent (0.38.0) — the other half of the vertical edge class

A live survival session reported that the navigator "tunnels horizontally beautifully but returns
unreachable for any descent — deep mining costs ~2 calls per level by hand."

It was right, and the cause is small: the evaluator had **no downward edge through solid ground**.
§12.3 built the *upward* half — `PILLAR` (place-below and climb) and stair-mine — and stopped there.
Vanilla routes a body *down* through open air (`tryFindFirstGroundNodeBelow`), so descending an
existing shaft always worked and hid the gap; mining downward was simply unrepresented. The only
`y-1` references in `BuildWalkNodeEvaluator` were `hasFloorBelow` and `planNode`'s floor test — both
*tests*, never edges.

Two edges close it, mirroring the two that go up:

- **`digDownNode`** — break the floor underfoot and drop into its cell (the mirror of `pillarNode`).
- **`stairDownNode`** — descend one level and move one across, cutting what blocks the way (the mirror
  of `stairUpNode`). A* tends to prefer it, and its edges chain into a real staircase.

Both record plain `Action.BREAK`, so — exactly as with stair-mine — **no new actuation exists**: the
goal loop mines a cell it already knows how to mine, gravity does the rest, and the next tick
re-navigates from one block lower. This is a search-side change only.

The one thing descent needs that ascent does not is a **safety refusal**. Digging into lava is how
miners die, so `safeToBreach` declines to emit an edge whose cell touches lava on any face. That is
deliberately a refusal and not a cost: a route that kills the body is not a more expensive route.
Water is allowed through — it floods, which is survivable, and with §12.4's swim right it is a medium
the body can leave under its own power. A descent must also land on a real floor (`y-2` solid), or it
is the top of a shaft rather than a step, and the body would drop an unknown distance.

### 12.6 World containers (0.38.0) — why smelting was impossible

The same session: `bot_use` with an item on a furnace returns "no use-on behaviour" — no baked food,
no iron ingots.

`bot_use` calls `ItemStack.useOn`, which is the **item's** behaviour. A furnace answers to the
**block's** interaction, and `bot_use` never invoked it. The codebase already knew this for exactly
one block — `GoalRunner` reaches past `bot_use` to call `DoorBlock.setOpen`, noting that routing doors
through it "was live-caught as a stall" — but it was never generalised. Meanwhile `Container` appeared
in the whole surface only as the body's *own* inventory: there was no world-container access at all.

The fix has two parts, and the split is the interesting bit.

**`bot_use` now falls through to the block.** When the item reports nothing, the block's
`useItemOn`/`useWithoutItem` are tried (player bodies only — both need a real `Player`). That is what
beds, buttons and levers were always waiting for.

**But containers are refused there, on purpose.** A container's block interaction opens a
`MenuProvider` — a screen. A headless body has none, so letting that call through would return
`SUCCESS` from the engine while achieving nothing: a textbook false success, and precisely what the
act-verdict doctrine exists to prevent. Instead `bot_use` fails with `needs_container_tool` and names
the tool that works.

**`bot_container` reaches the `Container` directly** — read, put, take — which is what the screen
would have done anyway, minus the screen. Two design points carry it:

- **Slot routing is the game's rule, never ours.** `put` picks a slot with `Container.canPlaceItem`,
  the same predicate hoppers obey. That is why raw iron lands in a furnace's ingredient slot and coal
  in its fuel slot without this class knowing anything about furnaces —
  `AbstractFurnaceBlockEntity.canPlaceItem` refuses the result slot outright and accepts the fuel slot
  only for real fuel. A future container with its own rules works on the day it is added, and a
  refusal can say *why* ("that is not a fuel") instead of "it wouldn't fit".
- **Nothing here smelts, and it says so.** Loading a furnace and lighting it is the whole of what a
  player does; the furnace then cooks on its own ticks. So `put` reports the furnace's state back
  rather than claiming a result it cannot have produced — `read` distinguishes *loaded and burning*
  from *loaded and dead*, which is the difference between waiting and fetching fuel. `lit` comes from
  the block state's public `LIT` property; the burn/cook counters live behind the block entity's
  `protected dataAccess` (the channel that exists to feed a screen), so a cook-progress percentage is
  **not reported** rather than invented or prised out by reflection. **Reversed in 0.88.0 — see
  §12.7.** The reasoning above was right about reflection and wrong about the consequence: the tool's
  own description had been promising `cook_progress` and `fuel_ticks` to every caller since it
  shipped, so the live choice was never silence-or-invention.

Double chests resolve through `ChestBlock.getContainer`, so both halves read and fill as the one
container a player would see — and a `null` from it means the chest is genuinely blocked, which is
honoured rather than bypassed via the block entity.

Verified by `mcp-server/probes/descent.test.mjs`, **11/11 live**: prediction parity on descent, ONE
call taking a walker ten levels through solid stone (ledger disclosing a mined cell per level), the
lava refusal, the `bot_use` redirect, slot routing, a chest round-trip, and the honesty case — loading
a furnace must never claim a result it has not cooked, followed by a real smelt producing real iron.

**A probe-harness lesson worth keeping.** `run_command` returns `ok: true` even when the *command*
failed — the failure text is only in `output`. Combined with vanilla `/fill`'s hard cap of 32768
blocks per call, the first run of both suites staged **nothing**: bodies spawned over a foundation
that was never built, fell to natural terrain, and produced four confident "navigation failures" that
were really one oversized fill. Both suites now assert on command output, slice large volumes under
the cap, and — the part that generalises — **verify the staging is real before asserting anything
about the code**. A test harness that reports false success is the same defect class the act-verdict
doctrine exists to purge; it just wears a different hat.

### 12.7 What the container tool could reach and could not say (0.88.0)

Three defects, all of the same family and none of them a missing capability: **the body could already
do the thing, and nothing could tell it so.**

**Brewing had been reachable for a year and no word said so.** `containerAt` resolves generically on
`be instanceof Container`, and `BrewingStandBlockEntity extends BaseContainerBlockEntity implements
WorldlyContainer` — therefore a `Container`, therefore reachable by `bot_container` from the day the
tool shipped. `canPlaceItem` even routes it correctly: nether wart to the ingredient slot, bottles to
the three under the arms, blaze powder to the fuel slot. What was missing was the two things that
make a capability usable: the tool's description never named a brewing stand, and there was no state
readout, so *"still water bottles"* and *"brewing right now"* read identically and a body would take
its potions out one tick early.

This is the **mirror image** of the pre-0.35.0 crafting hole (§13.3), and worth naming as its own
shape: there, the verb was missing and the words were fine; here the verb was fine and the words were
missing. The first kind is found the moment somebody tries it. The second kind is never found at all,
because nobody tries what nothing has told them exists. A capability with no name is not a capability.

Brewing now reports `brew_progress` / `brew_ticks_left` / `brew_fuel` / `bottles` / `brewing_with`,
every slot carries its `role`, and *"take everything"* means the three bottles rather than the fuel
that is still working — the same rule that already made a furnace's default take its result slot.

**The counters, and a decision reversed on purpose.** §12.6 declined to report cook progress on the
grounds that the timers sit behind `protected dataAccess`. That reasoning is sound about reflection
and incomplete about the situation: the tool's *description* had been listing `cook_progress` and
`fuel_ticks` since it shipped, three screens below a class doc explaining why they never would be. A
description that lies is worse than either choice, so the real decision was **delete the promise or
keep it** — and `lit` cannot answer the question a body actually has, which is not *"is it burning"*
but ***"should I wait here, and will this fuel outlast this smelt?"***. Kept, read through typed
`@Accessor` mixins (`AbstractFurnaceBlockEntityAccessor`, `BrewingStandBlockEntityAccessor`) — this
toolkit's established, loader-neutral way to reach real server state the API hides, checked at
mixin-apply time so it fails at startup rather than silently at runtime. Read-only by construction:
nothing calls `ContainerData.set`, because hurrying a furnace is the exact false success this whole
tool exists to refuse.

**And the limit of "slot routing is the game's rule".** `canPlaceItem` answers *may this go here*,
which is all a hopper ever needs. `put` is asking *which here did you mean*, and for one item in one
station both slots say yes: a brewing stand's ingredient slot takes anything
`PotionBrewing.isIngredient` accepts, blaze powder is an ingredient (it brews strength), and the fuel
slot takes `#minecraft:brewing_fuel`, which blaze powder also is. Index-order scanning therefore put
every powder in slot 3 — leaving the stand unfuelled **and** unable to take the nether wart that
belonged there. A stand that could never brew, from two calls that both reported success.

The tie is broken toward the **narrower predicate** (one tag beats a family), which is also what a
player does, since you cannot brew at all without fuel; `slot: 3` remains the override and the
description names it at the point a caller meets it. Deliberately *not* generalised into a
"prefer the pickiest slot" rule — predicate breadth is not something a `Container` exposes, and
inventing a measure of it would be our rule wearing the game's clothes. One named tie, in one station,
written down.

Verified live by `descent.test.mjs`, now **17/17**: the two counters exist and *move* between reads
(a hardcoded zero satisfies every other assertion), the three-way slot routing, the brew starting on
its own ticks and saying so, and the default take leaving the fuel alone.

**One probe-harness lesson, in the §12.6 family.** `bot_give minecraft:potion` hands over an
*uncraftable* potion, not a water bottle — since components, water is
`potion[potion_contents={potion:"minecraft:water"}]`, and the bottle slots accept both, so the routing
test passes while nothing can ever brew. Staging that needs components has to go through a command.

---

## 13. Player hands v2 — the `Hands` seam, the goal-loop widening, and `bot_craft` (designed 2026-07-30)

§11.8b left the player body with movement, combat and consumption but honest refusals on
mine/place/use/shoot (`Actuator.hands()` names the pending slice) and on `bot_target`
(`player_goals_pending`). This section is that slice. PlayerVerbs' own v1 comment prescribed the
shape: "v2 unifies the two through a Hands interface."

### 13.1 The `Hands` interface — one contract, two hand kinds

Every hand verb funnels through `Actuator.hands()`, and every caller sits inside `DroneHands` — the
widening is contained. `Actuator.hands()` now returns a `Hands`, implemented by the drone
(`BotBodyEntity`, behaviour byte-identical) and by a player adapter over `FakePlayerEntity`; it
throws only for possessed mobs (the `no_hands` semantics stand). The contract is the used subset,
nothing more: `body()`, `container()` (a vanilla `Container` — `SimpleContainer` and the player
`Inventory` both are one), `selectedSlot()`/`selectedStack()`, `insert(stack) → leftover`,
`playerOrNull()` (what `UseOnContext` and dig timing key on), `digTicks(state, pos)`, and the
visual verbs (`digVisual`/`clearDigVisual`/`attackVisual` — beam for the drone, arm-swing for the
player; the crack overlay is already body-agnostic, keyed by entity id).

What the player's hands do BETTER, by being a player, and why no constant is tuned (§11.6
decision 4's hands half):

- **Dig timing is the engine's.** `digTicks` for the player is
  `ceil(1 / BlockState.getDestroyProgress(player, level, pos))` — tool tier, efficiency, haste,
  mining fatigue, in-water and off-ground penalties all priced by vanilla. The drone keeps its
  `hardness × 10` house rule unchanged. Because the formula reads the player's HELD item, a named
  `item:` on the player selects it into the hand first (real behaviour: you hold what you dig
  with) — the drone's copy-the-tool path is unchanged.
- **`bot_use` sheds its biggest caveat.** `UseOnContext` gets the real player instead of `null`, so
  item behaviours that "require a real player" (the documented `use_unsupported` class) now run.
- **Placement stays deterministic** (the §"bot_place" doctrine: default state or explicit `state`,
  consume only after a confirmed write) — placement was never the body's physics, so nothing
  player-native is gained by simulating clicks.
- **`bot_shoot`** spawns the arrow from the player's eye with the held bow's enchantments riding —
  same code path, the shooter entity is just the player now.
- The async `Dig` is re-keyed from `BotBodyEntity` to the acting body identity, so a replaced or
  despawned body mid-dig fails the dig with the same reasons it does today.

### 13.2 The goal loop widens `Mob → LivingEntity`

`GoalRunner` was the last Mob-typed surface, and its Mob needs reduce to exactly the seams that
already exist: `Bodies.nav(body)` for steering/stop (the §11.8b seam, which `Bodies.Nav` extends
with `drainSelfLeaps()` so the player driver's verified touchdowns feed the ledger like the
walker's), and `NavSolver.solve` — which already takes a `NavPhysique`, an interface
`FakePlayerEntity` implements. Dispatch: Mob bodies keep the `MobPhysique.of` overload; the player
IS its physique. The `needsHands` gate keys on "has hands" (drone or player), not "is the drone".
Two actuation branches stay honest per body: a repair JUMP for the player routes through
navigation-to-landing (the driver's own gated, run-up-holding self-leap takes it from the lip —
bare `setJumping` from repair range would undershoot exactly as §11.8 measured), and PILLAR uses
the generic straight-up impulse plus a real `bot_place` — which the player now has.

### 13.3 `bot_craft` — recipes as a hands verb, gated the game's way

There was NO crafting surface at all (the 2026-07-30 survival run failed planks not through
incapacity but through a missing verb). `bot_craft {item, count?}` lands on the `Hands` seam (both
bodies craft; the player is the survival customer):

- **Recipe resolution is vanilla's.** Iterate `RecipeManager`'s crafting recipes; a candidate must
  (a) assemble to the wanted item and (b) be satisfiable from the body's own container —
  ingredients matched greedily into the recipe's own grid (`ShapedRecipe.getIngredients()` in
  pattern order at its declared width/height, shapeless as a row), verified by
  `recipe.matches(CraftingInput)` before anything is consumed, so the game's own matcher is the
  authority. Consume, `assemble` for the result, honour `getRemainingItems` (buckets), insert with
  overflow spilling at the body's feet, repeat to `count`.
- **The 3×3 gate is a world gate, not a menu.** A recipe wider than the 2×2 pocket grid refuses
  with `needs_crafting_table` unless a crafting table sits within block reach of the eye — the
  same reach every other hand verb enforces. No container UI is simulated; the rule that matters
  (you carry 2×2, tables unlock 3×3, you must be AT the table) is enforced on world truth. The
  refusal names the remedy (place one — the player can, now).
- Failure vocabulary in the family's own words: `unknown_item`, `no_recipe` (nothing craftable
  makes this), `ingredients_missing` (with the closest recipe's shortfall named),
  `needs_crafting_table` — joined in 0.88.0 by `needs_smithing_table` and `needs_stonecutter`, see
  §13.4. Result reports what was consumed, what was produced, and `crafted`/`requested` honestly when
  inventory ran dry mid-batch.

### 13.4 The stations whose grid is not a grid (0.88.0)

`TODO.md` §4.3 said `bot_craft` covered grid recipes only and that *"furnace-tier progression has no
route at all"*. Half of that was already false when it was written — `bot_container` has been the
furnace route since 0.38.0 (§12.6), exposed to the survival profile, and deliberately not a
`bot_craft` verb because loading a furnace is the whole of what a player does. What the entry was
*reaching* for, and never named, is the **menu-only** stations: their menus are code
(`SmithingMenu extends ItemCombinerMenu`, `StonecutterMenu`) with **no block entity behind them**, so
`bot_container` cannot reach them the way it reaches a furnace, and there is no `Container` to enforce
world truth against.

Two of the five are recipes in the same recipe manager, and that is the whole opening. **Smithing and
stonecutting therefore arrive in `bot_craft` itself**, under the shape this surface already chose once
for the same problem: match and assemble with the game's own matcher, and enforce the *world* rule
exactly as the 3×3 gate does — vanilla's own `SmithingMenu.isValidBlock` / `StonecutterMenu.isValidBlock`
predicate (a smithing table, a stonecutter) within block reach of the eye. No menu is simulated, no
screen is driven, and **no new tool is registered**: the token-per-tool work prices a manifest entry as
a per-turn tax on every session that carries it, and *"make me this item"* was already the caller's
question.

- **Smithing** consumes template, base and addition by one each, which is exactly what
  `SmithingMenu.onTake`'s three `shrinkStackInSlot` calls do. **Netherite upgrades had no route at all
  before this** — that is the real gap §4.3 was pointing at.
- **Stonecutting** earns its place on *yield*: one block into two slabs where the grid turns three into
  six, so a body cutting from a limited quarry gets strictly more out of the same stone. The result is
  fixed per recipe, so the wanted item picks which of the many recipes sharing an input is meant.
- **Order matters and is a contract.** The grid runs first; a station reply is returned only when it can
  actually run, or when its refusal is *more* specific than the grid's would have been. A vague
  "you have no netherite ingot" must never bury a precise "place a crafting table".

**Armour trims are deliberately unreachable, and the reason is about the verb rather than the station.**
A trim's result is the *same item id* as its base — a trimmed diamond chestplate is still
`minecraft:diamond_chestplate`. `bot_craft` addresses its goal by item id, so it cannot express "trim
this one" without claiming to have produced something the caller did not ask for, and would silently
eat a smithing template and an ingot to change an id that did not move. The test is behavioural (result
item equals base item), so a modded trim is caught by the same rule. If trims are ever wanted they need
a verb that names the **stack**, not the item.

**What still has no route, stated as a floor rather than a gap**: the anvil, the grindstone, the loom
and the cartography table. Their outputs are not recipes — the combination happens in menu code — so a
verb for them would have to simulate a screen, which is the one thing this surface refuses. Recorded
here so it is not re-proposed as a missing verb.

**The extension seam does not stretch this far, and that is worth knowing before a mod tries.**
`#mcptoolkit:crafting_stations` makes a modded 3×3 bench *findable*; the two new stations are matched by
vanilla block identity, because vanilla's own menu predicate is the authority being borrowed. A modded
smithing table is therefore not findable today. That is a deliberate stopping point, not an oversight:
the tag exists to answer "is this a bench", and there is no equivalent question for a station whose
recipes are keyed by `RecipeType`.

Verified live by `player-hands.test.mjs`, **14/14**: both refusals with everything in hand and no
station (`needs_smithing_table`, and a stonecutter recipe refusing rather than preempting the grid's
better diagnosis), then both routes running with one world fact changed — including the netherite
upgrade consuming all three inputs and landing in the real inventory.
