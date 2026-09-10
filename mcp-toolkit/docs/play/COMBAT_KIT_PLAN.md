# Combat kit — equipping and using the whole arsenal

Design, written 2026-08-12 at Matthijs's direction, immediately after the 9h47m survival review.
This document is the handoff: it is meant to be executable by a session that has not read the review.

> **STATUS, 2026-08-13 — steps 1–4 of §7 are BUILT and live-green at toolkit 0.74.0.**
> Steps 1–3 are committed (`d0ad897`, toolkit 0.73.0); step 4 (shield mechanics) is the new work.
> §4's design text below is left as it was WRITTEN, deliberately: §9, §10 and §12 record where live
> behaviour corrected it, and a plan silently edited to match what got built teaches nothing. Read
> §7 for what is done, §9–§10 and §12 for what the doing changed, §11 for where to start.

---

## 1. The defect chain this closes

The review measured it end to end and the numbers are the mandate:

- 37 deaths in 9h47m, median 7 minutes apart, 24 of them dropping a full kit.
- 31/37 killers were **legally sighted** 10–25 s before they landed the kill. Perception is not the gap.
- Reflexes fired in 34/37 windows; the fight reflex swung 741 times on a deliberate 0.65 s rhythm.
  The reaction layer is not the gap either.
- The held item at all 37 deaths was a pickaxe, a block, or nothing. Corpus-wide: **123 of 1,798
  recorded combat ticks had a weapon in hand (6.8%)**; in the 9h47m session, **0 of 1,240** — while
  its agent crafted 29 swords it never once held.

`WeaponGate` fixes the mainhand. What is still missing is everything else a player's hands do in a
fight: the offhand (shield, totem), the weapons that are *used* rather than swung (bow, crossbow,
trident), the weapon that wants momentum (spear), and the decision of **which of those to reach for
when the target is far away or cannot be walked to at all**. In the same session, 7 attack goals
died `target_unreachable` against targets the body could see perfectly well — with no bow in the
decision, being unable to *walk* to something is the end of the fight.

## 2. What already exists — do not rebuild it

| piece | where | what it gives you |
|---|---|---|
| `WeaponGate` | `drone/WeaponGate.java` (0.71.0) | best carried melee weapon by the item's own DPS attributes; best carried bow for `bot_shoot`; arms at target resolution so the turn absorbs the cooldown reset |
| `AttackGate` | `drone/AttackGate.java` | reach + LOS + rate-limited facing; **every** swing path funnels through `DroneHands.botAttack` |
| F4 weapon bands | `drone/Engage.java` | melee `[1.0, 3.5]` default 2.5, ranged `[6, 20]` default 10, clamps reported |
| `Vantage` | `drone/Vantage.java` | elevation-weighted stations (F5) and `Vantage.cover` (F3b, sightline negated) |
| reflex ops | `drone/Reflexes.java` | `shield` (raises the offhand, checks `BLOCKS_ATTACKS`), `deflect`, `shoot`, `attack`, `flee` |
| use-hold machinery | `drone/PlayerVerbs.java` `Chew` | `startUsingItem` → tick watch → vanilla completion, with hand swap and swap-back. **This is the model for every draw/charge/raise below.** |
| `bot_equip` | `drone/PlayerVerbs.java` | armor + offhand (mainhand deliberately refused) |

Two known-weak spots to fix rather than extend — **both closed now** (offhand 0.72.0, shot 0.73.0):

- **`bot_shoot` fakes the shot.** It constructs an `Arrow` entity directly and only borrows the held
  bow for enchantments. No draw time, no power curve, no crossbow, no trident. The recorded press
  channel therefore shows a shot with no `use`-hold before it — a frame no human capture will ever
  match, which quietly poisons the ranged half of the phase-5 dataset the same way the pickaxe
  poisoned the melee half.
- **Nothing ever fills the offhand.** The `shield` reflex refuses with *"no shield in the offhand
  (bot_equip {offhand:…})"*, and no path calls it. (Closed in two halves: 0.72.0 gave the SWING an
  offhand policy, and 0.74.0 gave it to the RAISE — until then the reflex still refused, because
  filling the slot at the moment of a swing does not help a body that is being shot at.)

## 3. Verified 26.2 mechanics

Read out of `vanilla-src/` on 2026-08-12; cite these, do not re-guess them.

**Totem of undying** — `LivingEntity.checkTotemDeathProtection` (LivingEntity.java:1379). Any stack
carrying `DataComponents.DEATH_PROTECTION` **in either hand** is consumed on lethal damage; health
is set to 1.0 and the effects apply. Not offhand-specific — but the mainhand is the weapon's, so in
practice the totem is an offhand decision. Bypassed by `BYPASSES_INVULNERABILITY` damage (the void).

**Shield** — `Items.SHIELD` is `equippableUnswappable(OFFHAND)` with
`BlocksAttacks(0.25F, 1.0F, [DamageReduction(90.0F, –, 0.0F, 1.0F)], ItemDamageFunction(3,1,1),
BYPASSES_SHIELD, …)`. Read: **5-tick block delay** before it protects, **90° horizontal arc**, full
reduction inside it, damage taken by the shield itself, disable cooldown scaled ×1.0. Raising is a
normal item *use*; `LivingEntity.getItemBlockingWith()` reads the component, so any modded shield
works without a list.

**Bow** — `BowItem.MAX_DRAW_DURATION = 20` ticks; `getPowerForTime(timeHeld)` is the power curve;
`releaseUsing` fires. A tap fires a limp arrow; the difference between a 5-tick and a 20-tick draw
is the whole skill.

**Crossbow** — `MAX_CHARGE_DURATION = 1.25F` s (25 ticks), `getChargeDuration(stack, user)`
(quick-charge aware), `isCharged(stack)`, `ChargedProjectiles` component. **It stays loaded**: charge
once, carry it, fire instantly later. That maps perfectly onto approach time.

**Trident** — `TridentItem.THROW_THRESHOLD_TIME = 10` ticks minimum hold, `BASE_DAMAGE = 8.0F`,
`PROJECTILE_SHOOT_POWER = 2.5F`, `getUseDuration = 72000` (hold as long as you like). Riptide only
launches `if (player.isInWaterOrRain())`. As a melee weapon it is `ATTACK_DAMAGE +8`,
`ATTACK_SPEED −2.9` — i.e. `WeaponGate` will already rank it top of the melee list, which is correct
and is exactly why throwing it must be a deliberate decision (§4.3, D2).

**Spear (new in 26.2, a full tool-material family)** — `Item.Properties.spear(material,
attackDuration, damageMultiplier, delay, dismountTime, dismountThreshold, knockbackTime,
knockbackThreshold, damageTime, damageThreshold)` builds a `KINETIC_WEAPON` component:
`KineticWeapon(contactCooldownTicks=10, delayTicks=delay×20, dismountConditions=ofAttackerSpeed(...),
knockbackConditions=ofAttackerSpeed(...), damageConditions=ofRelativeSpeed(...),
forwardMovement=0.38F, damageMultiplier, …)`. **A spear is a momentum weapon**: its damage condition
is on *relative* speed, so closing fast — or being charged — is what makes it hurt, and there is a
delay before the thrust lands. Iron spear, for reference: `(IRON, 0.95, 0.95, 0.6, 2.5, 11.0, 6.75,
5.1, 11.25, 4.6)`.

> The exact units of the `Condition` thresholds are **not** assumed by this design. §6 measures the
> real damage-versus-approach-speed curve in the arena; that measurement is a deliverable, and any
> spear behaviour tuned before it exists is folklore.

## 4. Design

### 4.1 One decision site: `CombatKit`

A new `drone/CombatKit.java`, sibling of `WeaponGate` and consulted by the same chokepoint
(`DroneHands.botAttack`) plus `Engage` and the `fight`/`shoot`/`shield` reflex ops. It answers two
questions and nothing else:

```java
record Kit(Mode mode, ItemStack main, ItemStack off, double standRange, String why) {}
enum Mode { MELEE, CHARGE, RANGED, THROW }

static Kit choose(LivingEntity body, Hands hands, Entity target, Reachability reach);
static void equip(Hands hands, Kit kit);      // mainhand via WeaponGate, offhand via §4.2
```

`why` is a short human-readable clause ("target across a gap, bow carried") and it must appear in
every verdict. A body that changes weapon class without saying why is exactly the silent behaviour
this project keeps paying for.

### 4.2 The offhand, and the contention nobody can avoid

**A shield and a totem want the same slot.** Both are real survival value; you cannot have both
(the mainhand belongs to the weapon). Recommendation, to be confirmed as **D1**:

- No shield carried → totem if carried.
- Shield carried, health **> 6.0** (more than one hit from death) → **shield**. It prevents damage;
  the totem only converts a death into 1 HP and is consumed.
- Health **≤ 6.0** and a totem carried → **totem**, swapped in for the rest of the engagement.
- Swap on engagement start and on crossing the threshold, never per tick — an offhand swap is a
  real action and thrashing it is worse than either choice.

The swap rides `bot_equip`'s existing offhand path so armor bookkeeping stays in one place, and is
reported as `offhand_switched` with the reason. Note the sharp edge to test: the shield's **5-tick
block delay** means raising it as the arrow arrives does nothing — the `shield` reflex has to fire on
`projectile_incoming`, not on damage.

### 4.3 Engagement mode — "unreachable or far away enough"

`Reachability` is not a new solver: it is what the attack goal already learns —
`target_unreachable`, `no_floor`, `fluid_ahead`, `cannot_reach_work` — plus the existing
knowledge-masked `check_path` verdict. The decision table:

| condition | mode | notes |
|---|---|---|
| distance ≤ melee band max (3.5) **and** reachable | `MELEE` | today's behaviour; `WeaponGate` picks the item |
| distance ≤ melee band max, reachable, **spear** is the best carried weapon | `CHARGE` | §4.5 — back off, then run in |
| distance in `(3.5, 6]`, reachable | `MELEE` (approach) | do **not** flip to ranged inside the hysteresis band |
| distance > 6, reachable, ranged weapon carried, LOS clear | `RANGED` | keep approaching only if no ranged option |
| **unreachable** at any distance, LOS clear, ranged carried | `RANGED` | this is the case that killed 7 goals |
| unreachable, LOS clear, no bow/crossbow, trident carried, throw allowed | `THROW` | D2 |
| unreachable, no ranged option | *fail as today* | `target_unreachable`, now with `why` naming what was missing |

Hysteresis is deliberate: the band `(3.5, 6]` belongs to melee so a target dancing at 4 blocks cannot
make the body oscillate between drawing a bow and raising a sword. `Engage.station` takes
`standRange` from the chosen mode, so stationing and weapon choice can no longer disagree (F4 already
clamps an explicit range into the held weapon's band; now the *mode* sets the band).

**Crossbow pre-loading falls out of this for free and is the nicest part of the design:** when
`RANGED` is chosen and a crossbow is carried uncharged, charge it *during the approach or the
turn* — the same insight as arming during the turn in 0.71.0. Vanilla lets it stay loaded
indefinitely.

### 4.4 Real use-based actuation: `UseHold`

Generalize `PlayerVerbs.Chew` into `PlayerVerbs.UseHold` — one in-flight held use per slot, ticked
by the same watch, with an explicit release:

```java
UseHold.start(slot, hand, minTicks, releaseWhen)   // startUsingItem + record the use press
UseHold.tick(slot)                                 // vanilla's own use ticks run underneath
UseHold.release(slot, reason)                      // releaseUsingItem → vanilla fires the shot
```

Every ranged act becomes: *arm → aim (AttackGate's rate-limited turn, reused verbatim) → hold →
release*. Concretely:

- **bow**: hold to full draw (`MAX_DRAW_DURATION` 20t) unless the caller asks for a snap shot;
  release fires through vanilla, so power, enchants, and infinity all behave.
- **crossbow**: hold `getChargeDuration` (25t nominal, quick-charge aware) → charged; firing is then
  a single release. Charged state is visible in `bot_status`.
- **trident**: hold ≥ `THROW_THRESHOLD_TIME` (10t) then release; riptide is refused out of water/rain
  by vanilla itself, so no toolkit rule is needed — report the refusal honestly.
- **shield**: hold while the threat persists; the `shield` reflex op keeps its trigger and gains the
  auto-equip from §4.2.

`bot_shoot` keeps its name and its contract shape but becomes a **short async act** exactly like
`bot_attack` did in F1: `{started, action_id, eta_ticks}` while drawing, completing with
`action_completed {hit, weapon, draw_ticks, power}`. The synthesized-`Arrow` path is deleted, not
kept as a fallback — two shooting paths is how the drone and player diverged in the first place.

**Why this matters beyond play**: the use-hold is recorded as `use`-held press rows (already in the
schema since 0.63.0). A drawn bow then looks the same in the dataset whether a human or the expert
drew it, which is the precondition for any of this being training data at all.

### 4.5 Spear kinetics — the manoeuvre, not just the item

A spear rewards closing speed and punishes standing still, which contradicts everything
`Engage.station` does today (station at a fixed range and trade). `CHARGE` mode is therefore a real
movement behaviour: **withdraw to a run-up distance, sprint in, thrust, disengage** — the pattern
sprint-in/back-off that the F4 melee band cannot express.

Build it in the order the measurement allows: first `CHARGE` = "sprint the last N blocks into the
hit" (N from the arena measurement), then judge from the clinic whether the withdraw half earns its
complexity. Do **not** ship a tuned spear rhythm before §6 has measured the damage curve.

### 4.6 What the verdicts must say

Non-negotiable, because the review had to reconstruct all of it from tick envelopes:

- every attack/shoot verdict: `weapon`, `mode`, `why`, and `charge` (already added in 0.71.0);
- ranged completions: `draw_ticks`, `power`, `hit`;
- shield: `blocked` + `blocked_damage` on the damage event, `shield_disabled` when an axe breaks it;
- totem: an event when it is consumed — a body that survived at 1 HP and does not say so is a lie by
  omission, and the agent will read the health and conclude nothing happened;
- offhand changes: `offhand_switched` with the reason;
- `bot_status` gains `offhand` and `crossbow_charged`.

## 5. Tests

**New live probe file `mcp-server/probes/combat-kit.test.mjs`, owning its own site** (site map is
dynamic — pick a free number and add it to `site-map.test.mjs`; 1.73M, 1.76M, 1.85M, 1.87M, 1.95M,
4.2M and 11.3M are taken). Staged hostiles carry `NoAI:1b,PersistenceRequired:1b`; roof anything
whose health equality is asserted (sunburn forges evidence).

| # | case | assertion |
|---|---|---|
| 1 | totem auto-equip | health ≤ 6 with a totem carried → offhand holds it, `offhand_switched` reported |
| 2 | totem saves | lethal damage with totem in offhand → body alive at 1 HP, totem gone, event emitted |
| 3 | shield auto-equip | healthy + shield carried → offhand holds the shield, not the totem |
| 4 | shield blocks | blow from the **front** while blocking → no health lost, `blocked` reported — **DONE 0.74.0**, and the body RAISES ITS OWN SHIELD out of the pack to do it |
| 5 | shield arc | identical blow from **behind** → not blocked (the arc is real) — **DONE 0.74.0** |
| 6 | shield delay | raise as the blow lands (< 5 ticks) → **not** blocked; raised 10 ticks early → blocked — **DONE 0.74.0**, and it is a real measurement: same body, same shield, same direction, ten ticks apart |
| 6b | no shield | nothing carried that blocks → `no_shield`; a shield carried but the body hurt past D1's threshold → `totem_preferred` — **DONE 0.74.0**, not in the first draft |
| 6c | shield disabled | an axe-holding attacker breaks the guard → `shield_disabled`, the status stops claiming to block, and the re-raise refuses — **DONE 0.74.0**, §4.6's line that had no case |
| 7 | bow draw | full draw vs 5-tick snap → higher `power`, measurably faster arrow — **DONE 0.73.0**, and it also pins the LANDING (`shot_landed {hit, damage}`) |
| 8 | bow ammo | no arrows → refusal, no phantom projectile — **DONE 0.73.0**, and `no_weapon` vs `item_missing` are separate refusals |
| E | engagement fires | **DONE 0.73.0**, not in this table's first draft: a fight-mode engagement stationed at bow range must LOOSE ARROWS with no reflex armed. It never did |
| 9 | crossbow load | charge during approach → `crossbow_charged` true, later shot fires with no draw — **DONE 0.75.0**, and `draw_ticks: 0` is the measurement. Plus 9b, not in the first draft: the body winds it BY ITSELF between the shots of a ranged fight |
| 10 | trident throw | unreachable target across a gap → thrown, hit registered — **DONE 0.75.0**, and the throw now also SAYS WHERE IT WENT (`trident_landed {x,y,z}`). Plus 10b: an idle body walks back and picks it up |
| 11 | trident retention | no Loyalty and `allow_throw` unset → **not** thrown (D2), melee still available — **DONE 0.75.0**, but on the DISARM check rather than Loyalty; see §13 for why the axis moved |
| 12 | spear kinetics | standing thrust vs sprinting thrust → sprinting deals strictly more damage |
| 13 | mode: unreachable | target across a 6-wide chasm, bow carried → `RANGED`, not `target_unreachable` |
| 14 | mode: hysteresis | target at 4 blocks, bow + sword carried → stays `MELEE` |
| 15 | mode: no option | unreachable, nothing ranged → still fails, and `why` names the missing capability |

**Invariants that must not regress** (add to the existing files, do not fork them): `combat-fixes`
1–11 and the four F6 cases stay green; `act-honesty`'s gate ordering pin stays green; no refusal text
names a tool the active profile hides.

> **THAT LAST ONE BIT A SECOND TIME on 2026-08-12 and is still not automated.** `dig-lock.test.mjs`
> asserted the `bot_equip` refusal names `bot_select` — the verb the 0.70.0 survival trim hides. The
> message had already been rewritten for exactly that reason and the probe was simply stale, so the
> drift sat in the tree undetected until the owed battery ran. The probe now follows the REMEDY
> ("the body arms itself", `item` on the act) rather than one era's wording, which is the durable
> shape for this class of assertion. The invariant itself wants a STATIC scan, `site-map.test.mjs`
> style — no bridge, fails at authoring time — over the Java refusal strings against `index.mjs`'s
> `SURVIVAL_DEAD`. The work is in the false positives: comments, and `index.mjs` itself, name hidden
> tools legitimately.

**Offline** — **DONE, 0.72.0**: `WEAPON_SUFFIXES` gained `_spear` (26.2 added a full spear
tool-material family, and without the suffix a spear fight reads as an UNARMED one and is filtered
out of the corpus — the exact inverse of what `unarmed_combat` is for), plus a coverage test walking
every material across sword/axe/spear/pickaxe/shovel/hoe and pinning `trident`/`mace`, the
bow/crossbow prefix pair, a modded weapon that follows the naming convention, and one that does not
(conservatively unarmed — stated as a test so the trade-off is a decision, not an accident).

## 6. The arena

A permanent staging ground, not a probe fixture: probes assert, the arena **measures and is watched**.
`world-model/tools/combat-clinic.mjs`, modelled on `human-session.mjs`.

**Site and geometry** — one forceloaded plate at y=200, open sky, sub-arenas ≥ 20 blocks apart so a
fight that drifts cannot contaminate its neighbour:

| sub-arena | shape | what it isolates |
|---|---|---|
| open field | 32×32 flat | ranged duels, kiting, the F4 bands |
| pillar field | 3-high pillars on a 5-block grid | LOS breaking, `Vantage.cover`, shield arcs |
| chasm | 6-wide, 8-deep gap, target on the far side | **unreachable but visible** — modes `RANGED`/`THROW` |
| water channel | 4 deep, 8 wide | riptide, drowned, unreachable-across-water |
| breach corridor | 1-wide corridor into an unlit 8×8 room | the modal death of the 9h47m run |
| pen | 3-sided, 4 high | flee/cover (reuse the `combat-fixes` shape) |
| ledge | +4 platform with a ramp | vantage elevation, spear run-ups |

**Loadouts**: bare · stone sword · iron sword + shield · iron sword + totem · bow + 16 arrows ·
crossbow + arrows · trident (Loyalty I / none) · iron spear · full kit. Difficulty pinned and
**stated in the ledger** — the 9h47m run was `easy`, and a clinic run at `normal` measures a
different game.

**Arms per scenario**: `reflex-only` · `goal-only` · `both` · **human** (you play the identical
staged fight through `human_task`; the presenter, referee and client capture already exist, so your
trace lands in the same schema and becomes the reference line).

**Auto metrics** (from the recorder, joined by action id): survived · time-to-kill · damage taken ·
min/median distance · facing error at swing · **charge fraction per swing** · draw power ·
separation gained after an evasive response · LOS breaks · held item at first swing ·
sighting→first-response latency · blocked hits · totem consumption.

**Rating sheet**: 1–5 per named manoeuvre plus free text, written into the same JSONL row as the auto
metrics, so a "looked wrong" score always has a trace under it. 5 trials per cell.

**Data hygiene**: clinic sessions are staged geometry and must never become training data. The site
sits at |x| ≥ 1M so `build_corpus.py` flags it as synthetic automatically; stamp the session with an
excluded purpose as well (**D4** — `bench` is the honest existing word: the clinic is an instrument).

## 7. Build order

1. ~~**`CombatKit` skeleton + mode decision + `why` plumbed into verdicts.**~~ **DONE, 0.72.0,
   live-green.** Cases 13–15 pass.
2. ~~**Offhand policy (§4.2)** + `bot_status.offhand`.~~ **DONE, 0.72.0, live-green.** Cases 1–3.
3. ~~**`UseHold` (§4.4)** and the rewrite of `bot_shoot` onto it, bow first. Cases 7–8.~~
   **DONE, 0.73.0, live-green.** Cases 7–8 pass, plus a new case E (the engagement looses arrows)
   and a player-body case in `reflexes-ranged`. What §10 records: the drone keeps its own
   actuation because vanilla gives it none, `hit` moved to a `shot_landed` event, and the
   crossbow came along for free. The reflex `shoot` op took the `act.pending` shape as predicted.
4. ~~**Shield mechanics** end to end, including the 5-tick delay and the reflex trigger change. 4–6.~~
   **DONE, 0.74.0, live-green.** Cases 4, 5, 6 pass, plus 6b (the two refusals) and 6c (the axe).
   What §12 records: the raise is its own sibling rather than a `UseHold` rider, the block is
   measured from vanilla's own `applyItemBlocking` through an override on our body classes rather
   than a health delta, a blocked blow gets a `body_damaged` at damage 0, and the survival preset
   gained a `guard` that outranks `dodge` without taking the dodge away from shieldless bodies.
5. ~~**Crossbow + trident.** 9–11.~~ **DONE, 0.75.0, live-green.** Cases 9, 10, 11 pass, plus 9b
   (the automatic wind) and 10b (the errand that actually fetches it). What §13 records: the
   pre-load is a FOURTH sibling and not a `UseHold` rider (the third time that prediction has been
   wrong, and now for a stated reason), D2 was settled by dissolving its premise rather than
   answering it, and the disarm check is what survived of the gate.
6. **Spear**: measure first in the arena, then implement `CHARGE`. 12. **RESHAPED by §14, and no
   longer blocked on a measurement.** The damage law was READ, not measured (`base + floor(v_rel ×
   0.95)` above a hard 4.6 b/s gate), vanilla ships the approach rhythm (`SpearAttack`: engage 10,
   reposition 6–7, stand off 9–11), and a spear is a HOLD rather than a swing — so the work is
   `J1` (the body reports its own speed **at all**), `J2` (a `Thrust` sibling), and then `CHARGE`
   as a port of vanilla's own state machine. What the arena still owes step 6 is the BEHAVIOURAL
   number: the run-up that gets *this* body to threshold and holds it through contact.
7. **Arena** (§6) — **UNDERWAY.** Design is `world-model/COMBAT_CLINIC.md` (nine argued
   departures). Build-order steps 0–2 are built and green: the pure-JS foundation
   (`world-model/tools/clinic/` — geometry, registry, metrics, row/ledger), the driver's `--dry`,
   and two battery-swept offline probes. It is what steps 4–6 are judged by, and it has already
   paid for itself once by finding §14.1 before a line of `CHARGE` was written.
8. Full sequential battery, then the campaign resumes with a body that can actually fight.

## 8. Open decisions

- **D1 — offhand priority. TAKEN as recommended, 0.72.0**, with one addition the recommendation did
  not have: a HYSTERESIS BAND. Shield at or above 7 HP, totem at or below 6, and between the two
  whatever is already held. The band is not decoration — natural regen ticks a body across a bare
  threshold repeatedly, and an offhand swap is a real action, so a single 6.0 cut-off would thrash
  the slot for free. The alternative ("always totem when carried") is still defensible if totems are
  ever treated as run-savers; reversing it is a two-constant change in `CombatKit`.
- **D2 — trident throwing. TAKEN 2026-08-13, and NOT as recommended** — the recommendation was
  "never auto-throw without Loyalty", and the answer instead dissolved the premise that gate rested
  on. The objection was that *a thrown trident is a dropped item and this body loses dropped
  items*; the decision was that **the body stops losing it silently**. A throw now reports where the
  weapon came to rest (`trident_landed {x, y, z}`) and schedules the walk back for it — *scheduled,
  not immediate*, because the geometry that produces a throw is also the geometry most likely to
  have a second enemy in it. With the loss visible and recoverable, Loyalty stops being a licence
  and becomes what it always was: a convenience that skips the errand. `allow_throw` survives with
  its polarity INVERTED — it is `false` to keep the trident, not `true` to spend it — and the one
  automatic restriction left is the **disarm check** (§13.3).
- **D3 — snap shots. TAKEN as recommended, 0.73.0**, with the escape hatch the recommendation
  implied but did not name: every automatic path (the hunt, the reflex, the engagement) draws FULL,
  and `bot_shoot {draw_ticks}` lets a caller ask for less. That is what makes case 7 a measurement
  rather than an assertion about a constant — it fires the same bow twice and compares. Whether the
  automatic paths should ever choose a snap shot is still the arena's question.
- **D4 — clinic session purpose. TAKEN**: `bench` (excluded). No new purpose word.
- **D5 — human baseline data.** OPEN, and still the one the corpus cannot decide for us. Your arena
  fights are excellent phase-5 combat demonstrations but they are recorded on synthetic terrain.
  Excluded with the rest of the clinic, or admitted as a special case?

## 9. What steps 1–2 actually settled (0.72.0, 2026-08-12)

Three things the design above got wrong or left open, corrected against live behaviour:

- **Line of sight is NOT a term in the mode decision**, though §4.3's table listed it twice. Gating
  the mode on the sightline inverts the decision — "I cannot see it, so I will walk into melee" —
  because *where the body stands is what fixes a blocked sightline*. Caught on the F5 archer probe:
  the body started behind the plateau it was meant to climb, read no sightline, chose MELEE, was
  given a melee anchor beside the enemy, walked out from cover, regained the sightline, flipped back
  to RANGED, and was sent back to the ledge — an anchor oscillating every few ticks with the body
  jittering between the two and never climbing. The sightline now belongs to the SHOT: `Vantage`
  requires it *from the candidate stand* (the right place to ask), and the hunt loop checks it at
  the moment it must choose between shooting and conceding, where it is a verdict and not a plan.
- **A row the table was missing**: a pack with NO melee armament is RANGED at every distance. Bare
  hands are 1 damage, so a bow-only body told to fight at melee range walks into the enemy's arms
  carrying the weapon that wanted distance. Note this makes `bot_attack` a special case —
  `CombatKit.forSwing` forces MELEE there, because the caller asked for a blow and a swing site that
  took the RANGED answer literally would arm the bow, club the target with it, and file a verdict
  reading `mode: ranged` for a melee swing.
- **"Ranged" now means carried AND feedable**, not held. A bow with an empty quiver is not a
  capability; it is a stick that keeps the body at 10 blocks doing nothing, which is a worse death
  than closing. `Engage`'s band question asks the same seam, so a body carrying a bow but holding
  the pickaxe the dig gate left it no longer stations inside a zombie's reach.

**D1 taken as recommended** (shield above 7 HP, totem at or below 6) with a hysteresis band between
the two, for the reason the distance band has one: natural regen ticks a body across a bare
threshold repeatedly and an offhand swap is a real action. **D4 taken as recommended** (`bench`).
D2, D3 and D5 are untouched — they belong to steps 5–6.

**One bug worth keeping** (it will recur): `totem_used` first keyed on "health is the 1.0 vanilla
sets" and never fired — the totem grants itself Regeneration II, so by the time any watcher looks
the body reads 2.0. The second cut added "…and a totem was in a hand LAST TICK" and fired only when
the test was slow, because the offhand policy equips INSIDE a tool call: when the blow lands in the
same inter-tick window as the equip, the flag still says what was true before it. **Any per-tick
"what was true last tick" belief is stale for whatever the tool calls change mid-tick.** The
detector now keys on the total carried, which the policy's own swaps cannot move.

## 10. What step 3 actually settled (0.73.0, 2026-08-13)

`bot_shoot` is a **real draw**. The body aims through `AttackGate.aim` (the swing's own rate-limited
turn), hands the act to the ITEM — `ItemStack.use`, which is what a right-click runs — holds through
vanilla's use ticks, and releases. Power, enchantments, Infinity, the choice of ammunition and the
projectile entity are all vanilla's. `PlayerVerbs.UseHold` is the state; `Shots` watches what it
launched. Five corrections to §4.4, all of them things the design could not have known:

1. **The drone keeps its synthesized arrow, and this is not the divergence §4.2 warns about.**
   `BowItem.releaseUsing` opens `if (entity instanceof Player)` and returns false for anything
   else, so a bow **cannot** be fired from a drone: it is not that the toolkit prefers a second path
   there, it is that vanilla offers no first one. Deleting it would have deleted the drone's ranged
   capability outright (and `reflexes-ranged` cases 1–2 with it). The asymmetry is the one
   `performSwing` already has — `PlayerVerbs.attack` for the player, `doHurtTarget` for the drone —
   and the thing the plan actually rules out, a PLAYER body with two ways to shoot, one of them
   skipping the use-hold, is gone.
2. **`hit` is not on the shot's completion; it is `shot_landed`.** A shot is two facts with two
   lifetimes: the body loosed it (the act, done at release) and the world answered (up to five
   seconds later, while the arrow flies). Holding the act open through the flight would deliver
   §4.6's `hit` at the cost of halving the rate of fire — `bot_shoot` answers `busy` while a draw is
   in flight, and the hunt looses on a 20-tick rhythm. **A bow's rate of fire IS the weapon.** So the
   completion carries what LEFT the bow (`power`, `draw_ticks`, `speed`, `arrow_id`) and the landing
   arrives as `shot_landed {hit, damage, flight_ticks}`. Both body families report it, so the drone
   gained honest hit reporting from the same change.
3. **`UseHold` did not absorb `Chew`, though §4.4 asked it to.** Both hold an item through vanilla's
   use ticks, but their completions are opposites: a meal finishes ITSELF (the watch observes
   `isUsingItem` going false and reads the nutrition delta) while a draw ends when WE let go.
   Merging them would have produced one class with a mode flag deciding which half of its own body
   ran. They stay siblings and share the seam that matters — one mainhand, so each refuses the other
   `busy`.
4. **The crossbow came along for free, because the item decides.** `CrossbowItem.use` fires
   instantly when charged and starts winding when not, so a single `bot_shoot` charges and fires
   one; the release-then-`use` pair is three lines. What step 5 still owns is PRE-LOADING during the
   approach. The trident is untouched and D2 is preserved by construction: it is not a
   `ProjectileWeaponItem`, so `CombatKit.rangedSlot` never picks it.
5. **AIM FIRST, THEN DRAW** — and the order is the measurement. Vanilla fires along the shooter's
   look vector, so drawing while still turning would make `draw_ticks` "however long the turn took".
   A draw that reaches full and finds the target off-aim KEEPS HOLDING (vanilla charges nothing for
   it) and tracks, which is what an archer does; only the aim budget expiring gives up.

**A hole step 3 opened the door to closing, and it was not in the plan**: `Engage` stationed a ranged
body at the band — or up on `Vantage`'s ledge — aimed at the enemy every tick, and **never fired**.
The only trigger was the fight reflex's swing, which answers `out_of_reach` at 10 blocks for as long
as the duel lasts, so an engaged archer backed away from its enemy and did nothing. That is
`target_unreachable` wearing different clothes: the arsenal carried, the decision made, no path
pulling the trigger. `Engage.loose` now looses on a 30-tick cadence when the stationed mode is
RANGED. **Player bodies only** — the drone's auto-fire killed its own subject mid-measurement in
`reflexes-engage`'s kite cases (caught live, twice), and every other automatic arming decision here
is player-only for the same reason.

**Two refusal words where there was one**: `no_weapon` (nothing to shoot with) is now distinct from
`item_missing` (nothing to fire), because "you need a bow" and "you need arrows" are different
problems with different fixes and an agent can only act on the one it hears. `WeaponGate.armRanged`
also stopped reaching for the first projectile weapon in the pack and now takes
`CombatKit.rangedSlot`'s FED one — the arming gate was the last place that could still disagree with
the decision that sent it there.

**Sharp edge worth keeping**: "did an arrow leave the bow" has **two witnesses** and needs both. The
world lookup (a projectile owned by this body with `tickCount <= 1`) can miss one that has not
settled into its section; the ammo delta cannot see a shot from a body that draws from nothing
(infinite materials). Reporting a real shot as a failure is the worse error — the goal loop drops
its whole ranged conclusion on one, while the arrow is already in the air.

## 11. Handoff state (2026-08-13, after step 5)

- **Steps 1–4 are COMMITTED** (`d0ad897` toolkit 0.73.0, `d07a56f` toolkit 0.74.0) together with the
  corpus/eligibility work (`fb14cad`) and the profile shim (`8a748a4`, server 0.30.0).
- **Step 5 is toolkit 0.75.0, UNCOMMITTED at the time of writing**: the new `drone/Crossbows.java`
  (the wind, the watch, `crossbow_charged`), the new `drone/Retrieve.java` (the scheduled errand),
  `CombatKit.Mode.THROW` made reachable with `throwSlot` + `keepsAWeapon` (the disarm check),
  `WeaponGate.armSlot` + the melee-excluding `bestMeleeSlot` overload, the trident branches in
  `PlayerVerbs.fullDraw`/`finishShot`, `bot_shoot {allow_throw}`, `bot_body {action:"load"}`,
  `Shots`' thrown-weapon watch (`trident_landed` / `trident_returned` / `trident_lost`), the
  `pickup_*` events, the pre-load hooks in `Engage.loose` and `GoalRunner.shootLeg`, and nine new
  `EventTypes` registrations.
- **Green, live** at 0.75.0: the **full sequential battery — 61 files, 491 assertions, 0 failing**
  (chunk logs `mcp-server/sequential-0.75.0-{a,b,c,d}.log`), on one server lifetime stamped
  `purpose=battery` so the rows are excluded from corpus-v3. Offline: `mcp-server` 178/178.
  `combat-kit` is **22/22** (the 16 of 0.74.0 plus 9, 9b, 10, 10b, 10c, 11). **Run it in chunks** —
  a single `node --test` invocation was SIGKILLed again, the fourth time; `tools/battery.ps1 -Only`
  with a quoted list is the reliable form. Every file that exercises a projectile
  (`combat-fixes`, `combat-kit`, `conformance`, `reflexes-ranged`) is in chunk a, which is what
  makes a chunk-a re-run a sufficient check after a `Shots` change.
- **One failure, and it is the one the 0.74.0 handoff predicted verbatim**: `reach-goals` case 8
  read `did_not_start` at `distance_to_target: 4.643` against a 4.5 reach shell — the hovering
  drone's drift, one shell out, pre-existing and nothing to do with combat. Green alone on re-run
  (`sequential-0.75.0-b2.log`). It has now flaked in two consecutive batteries and is worth fixing
  rather than re-documenting: `TRAVELED_EPSILON` exists for exactly this and the arrival test does
  not use it.
- **Machine**: a headless dev server was up when this session ended and does not outlive it. Start
  your own (`tools/rebuild.ps1 -Target server`) and tag it (`wm_session_tag {purpose:"battery"}`)
  before running probes. Dev-loop notes that still hold:
  - A RUNNING game holds the jar, so `gradlew build` fails with *"Failed to modify jar manifest"*.
    Stop it first, always; `compileJava` is the safe check while a game is up (it produces no jar).
    On this Windows box the task is `:mcp-toolkit:compileJava` from the REPO ROOT — there is no
    `gradlew` inside `mcp-toolkit/`.
  - PowerShell 5.1 renders gradle's deprecation note on stderr as a `NativeCommandError`. A build
    that prints only that line SUCCEEDED.
- **SUPERSEDED BY §14 (2026-08-15).** The paragraph below is kept because its reasoning was right
  and its conclusion was wrong in an instructive way: it deduced that a damage-versus-speed curve
  could not be made deterministic the way steps 4 and 5 were, and therefore that the arena had to
  come first. The arena did come first — and the first thing it did was read the law out of
  `vanilla-src/` instead of measuring it, which is the option this paragraph never considered.
  **Step 6 is no longer blocked on a measurement; it is blocked on `J1`, because the body does not
  report its own speed at all.** See §14.
- ~~**Next: step 6, the spear — and it is blocked on the arena, deliberately.**~~ §4.5's `CHARGE` is a
  movement behaviour whose run-up distance is a NUMBER, and 26.2 prices a spear on
  `KineticWeapon`'s relative-speed conditions whose units this plan explicitly declines to assume
  (§3). Case 12 ("sprinting thrust deals strictly more damage") is a direction, not a curve. Steps
  4 and 5 both shipped without the arena by making their cases deterministic — a mechanism either
  blocks or it does not, either fires with no draw or does not — and that trick does not extend to
  a damage-versus-speed relationship. **Build §6 first.**
- **Open threads carried forward**, none of them blocking:
  - A RANGED hunt still does not REPOSITION for a sightline — it concedes with "the sightline is
    blocked from here". A target atop a pillar hits this: the hunt walks to the pillar's foot, and
    the pillar is then between eye and target. §6's pillar-field sub-arena; `Vantage` has the
    machinery.
  - `shot_landed`'s `hit` is an INFERENCE (the arrow stopped, and the target lost health in the same
    window) because vanilla exposes no "who did this arrow hit". It is named as such in the event and
    it is right in a duel; in a scrum it can credit our arrow for someone else's blow.
  - `Engage.loose` fires on a fixed 30-tick cadence. Whether that is the right rhythm — and whether
    an automatic path should ever snap-shoot (D3) — is an arena question, not a code one.
  - **`Engage` does not raise the shield.** Step 4 gave the raise two callers — the reflex layer and
    the deliberate `bot_body {action:"guard"}` — but a fight-mode engagement closing on a melee
    enemy still never reaches for it. Same shape as the hole step 3 found in `Engage.loose`: the
    arsenal carried, the decision made, and no path pulling the trigger. It wants the arena to say
    WHEN (raising costs the swing rhythm nothing but it does cost the offhand, and blocking through
    an approach is a real tactic that has never been measured here).
  - **`Engage` does not THROW either, and unlike the shield that is probably correct.**
    `Engage.station` reads `CombatKit.rangedCapable`, which does not count tridents, so a
    trident-only body stations in the MELEE band — where the right move is to swing the thing
    (+8 damage, top of `WeaponGate`'s list), not to throw it away. The hunt is the path that meets
    the case a throw is for, and the hunt has it. Worth re-examining only if the arena finds a
    kiting body that wants one thrown opener.
  - The "a reaction that cannot act is not a candidate" rule (§12.5) is applied to `shield` alone.
    Generalizing it to `eat`/`drink`/`shoot` is right and `uncoveredReactions` already computes it,
    but it moves behaviour four probe files pin — a deliberate change with its own battery.
  - The arena (§6) is still unbuilt, and it is now the immediate blocker rather than a parallel
    track (see "Next" above).

## 12. What step 4 actually settled (0.74.0, 2026-08-13)

The shield is real: the body reaches for one, raises it, knows when it starts protecting, says what
it ate, and reports the axe that breaks it. Six corrections to the design above, all of them things
writing the plan could not have known.

1. **`UseHold` did NOT absorb the raise either, and this is the second time that has happened.**
   §4.4 named the shield as `UseHold`'s second rider and §11 repeated it. `UseHold` is a *shot*: it
   aims through `AttackGate`, holds a draw, releases, resolves a projectile, and watches the flight.
   A raise has no target, no aim, no projectile and no release verdict — riding it would have meant
   a target-shaped class with every one of those fields nulled. `Shields.Guard` is a third sibling
   beside `Chew` and `UseHold`, and the pattern is now clear enough to state as a rule: **what these
   three share is vanilla's use ticks, and NOTHING else** — a meal ends itself, a draw ends when we
   let go and produces a projectile, a block ends when the threat or the clock does. One class with
   a mode flag choosing which third of its body ran was the wrong answer both times.

2. **What they DO share is the one thing that mattered: there is ONE `useItem` per entity, not one
   per hand.** `startUsingItem(OFF_HAND)` silently replaces a bow draw and a bow draw silently
   replaces a raised shield. The old reflex re-raised the shield on any tick it found the hand idle,
   so a `shield` reaction and a `bot_shoot` for the same body would have **livelocked** — each
   cancelling the other forever, each reporting nothing wrong. The seam is now explicit in both
   directions and says which: a raise cancels a draw (`shield_raised`), a shot lowers the guard
   (`lowered_to_shoot`), and anything else taking the hand ends the guard as `interrupted`.

3. **A blocked blow cannot be seen from a health delta, and that is the blow that matters most.**
   §4.6 asked for `blocked` "on the damage event" — but vanilla's shield reduction is factor 1.0
   inside the arc, so a fully blocked hit moves **no health at all** and the toolkit's health-poll
   watch could not have seen it even in principle. "Nobody is shooting at me" and "somebody is and
   the shield is holding" read identically. The number now comes from vanilla's own
   `LivingEntity.applyItemBlocking`, **overridden on our two body classes rather than mixed in** —
   they are ours, the method is public, and the super call does all the arc/delay/reduction maths.
   A blocked blow emits `body_damaged` at `damage: 0` with `blocked` + `blocked_damage`, so an agent
   still has exactly one place to learn it is under attack.

4. **The 5-tick delay needed a READING, not just a warning.** `getItemBlockingWith()` returns null
   through `blockDelayTicks`, and a raised-but-not-yet-live shield is indistinguishable from a live
   one on every other reading — so a body that raises into an arrow already at the bowstring learns
   nothing from its own senses about why it still took the hit. `bot_status` reports `blocking` and,
   only while it matters, `block_ready_in`. This is what makes case 6 a measurement rather than a
   restatement of a constant.

5. **A reaction that cannot act must not be a CANDIDATE.** The preset gained `guard` above `dodge` on
   the same `projectile_incoming` trigger (a shield takes ~90% of an arrow inside its arc; a
   sidestep against a tracking skeleton mostly does not). Most bodies carry no shield — and a
   higher-priority reaction that wins the tick, refuses in the same breath and burns its cooldown
   would have **silently taken the dodge away from every one of them**. `pick` now skips a shield
   reaction on a body carrying nothing that blocks. The general rule is right and
   `uncoveredReactions` already computes it, but it is applied to `shield` ALONE on purpose:
   generalizing it to eat/drink/shoot moves behaviour four probe files pin, and that is a change to
   make deliberately with its own battery.

6. **Two refusals, and which one applies is decided by what is CARRIED.** `no_shield` (carry one)
   and `totem_preferred` (you have one, but D1 is holding the totem because one more hit is death)
   are different problems with different fixes. The first cut keyed on what `wantOffhand` returned,
   which is wrong in a way that reads plausibly: a body with a totem and no shield gets the totem
   back for the trivial reason that there was nothing to compare it against, and reporting that as
   "the policy preferred your totem" invents a decision nobody made. `CombatKit.carriesBlocker` is
   the question that actually distinguishes them. The `no_shield` note also names the REMEDY rather
   than `bot_equip` — the verb the survival profile hides, and the drift §5 says has now bitten
   twice.

**On the probes, and a staging decision worth keeping.** §5's table says "skeleton arrow from the
front". A real arrow tests the same vanilla maths and adds a flight time nobody controls, an archer
with its own aim, and a 5-tick window that has to be hit through an HTTP round trip — and case 6 is
a measurement OF THAT WINDOW, so a staging that cannot place a blow inside it cannot measure it at
all. `/damage <name> <n> minecraft:arrow at <x y z>` is the same blow with the two free variables
pinned: `at` becomes the `DamageSource`'s source position, which is the only thing
`applyItemBlocking` reads to compute the arc, and the command lands on the tick it is sent. Two
traps found live: `minecraft:generic` (the word a probe reaches for by habit) has **no source
position at all**, so the angle defaults to π, nothing is ever inside the arc, and every case would
have "proved" the shield does not work; and Minecraft's yaw runs backwards (+X is −90, not 90), so a
probe that writes the literal tests the arc from BEHIND while claiming the front — failing case 4
and PASSING case 5, which reads as a broken shield rather than a broken probe. The arena (§6) is
where a real archer fight gets WATCHED rather than asserted.

**And the sampling lesson the totem case already taught, re-learned:** case 6 failed its first live
run at `16 !== 15.5` — the body had REGENERATED half a heart between the blow and the poll, and the
shield had worked perfectly. Health is monotone-up between blows, so "it lost nothing" is `>=`, and
the exact number belongs to the event, which is emitted on the tick it happened.

## 13. What step 5 actually settled (0.75.0, 2026-08-13)

The body can now pay for a shot before it needs one, and throw a weapon without losing it. Five
corrections, and one of them is a correction to how this plan makes predictions.

1. **The pre-load is a FOURTH sibling, and this is the THIRD time §4.4's prediction has been
   wrong.** §4.4 folded the crossbow into `UseHold` and §11 repeated it. For the SHOT that is
   right — a caller who asked for a bolt wants aim, hold, release, projectile, flight watch. A
   PRE-LOAD wants none of them: it has no target (so nothing to aim at, and nothing to lose when
   the target dies mid-wind), it produces no projectile, and it does not end when we let go — it
   ends when the ITEM says `isCharged`. Riding `UseHold` would have meant a target-shaped class
   with the target, the aim, the release verdict and the flight watch all nulled, which is
   precisely what §12.1 records the shield teaching. `Crossbows.Load` is the fourth sibling beside
   `Chew`, `UseHold` and `Shields.Guard`.

   **The pattern is now stable enough to state as a rule rather than re-derive each time:** these
   four share vanilla's use ticks and NOTHING else, and the useful question for the next one is not
   "which existing class is this like" but *what ends it* — a meal ends itself, a draw ends when we
   release and yields a projectile, a block ends when the threat or the clock does, a wind ends
   when the item's own component appears. Four different terminators is four classes. The trident,
   by that test, really IS a `UseHold` rider (aim, hold, release, projectile) and it went in as one
   without incident — the first of these predictions to survive contact.

2. **`stopUsingItem`, not `releaseUsingItem`, and the difference is invisible until it isn't.**
   `onUseTick` writes `CHARGED_PROJECTILES` the moment the hold crosses `getChargeDuration`, so by
   the time the watch sees a charged crossbow the work is already done and the hand only needs
   letting go. Releasing instead would run `CrossbowItem.releaseUsing` for no reason. The two are
   easy to conflate because for a BOW the release *is* the whole event — and that asymmetry is the
   same one that makes a crossbow pre-loadable and a bow not, which is why `bot_body {action:
   "load"}` refuses a bow with `no_weapon` and a note explaining that a bow *is* a ranged weapon and
   *is* carried and still cannot be wound.

3. **D2 was settled by dissolving its premise, and the disarm check is what survived.** The open
   question assumed a fixed trade: throw and probably lose the trident, or keep it and lose the
   fight. The answer refused the trade — the loss was only unaffordable because it was SILENT.
   `trident_landed {x, y, z}` plus a scheduled errand turns "the body lost its trident" into "the
   body left its trident at 4260009.94, 201.05, 4260000.5", which is a different fact an agent can
   act on. What that does NOT dissolve is the other cost: a trident is `ATTACK_DAMAGE +8`, so
   `WeaponGate` ranks it top of the melee list and an automatic throw is the body giving up its best
   weapon at the moment it has decided it is in a fight. `CombatKit.keepsAWeapon` is the surviving
   gate, and it is deliberately asymmetric — it applies to `choose` (where nobody asked) and NOT to
   `forShot` (where the caller did). Overriding an explicit instruction because the body would be
   left bare-handed is the toolkit second-guessing a judgement it was handed.

4. **"Scheduled, not immediate" is the entire safety property, and the bar for idle had to be
   exhaustive rather than clever.** A throw happens because a target was unreachable, which is the
   geometry with the best odds of a second enemy that is *not* — so a body that walks to a landing
   spot the instant the trident stops moving is walking away from a fight in a straight line with
   its back turned. `Retrieve.idle` therefore lists every in-flight thing the slot models (goal,
   queue, follow, pendingNav, reflex, fight, dig, use, chew, guard, load, swing, possession, and a
   designated threat in range) and then requires 60 further ticks of the same. The errand rides
   `startNav` rather than a `GoalRunner` goal on purpose: a goal would occupy `slot.goal`, and the
   agent's next `bot_target` would answer `busy` because the body had privately decided to fetch a
   trident.

   **The pickup itself is vanilla's and that is not a shortcut.** `AbstractArrow.playerTouch` →
   `tryPickup` puts a landed trident into the inventory of the player who walks over it — the
   pickup area is the bounding box inflated (1.0, 0.5, 1.0), and `Player.aiStep` runs it for a
   `FakePlayerEntity` exactly as for a human. So the errand is a walk and nothing else. Inventing a
   collect verb would have been a second way to acquire an item, diverging from what a real client
   does, in the session whose whole point is that the body's behaviour becomes training data.

5. **A trident is not an arrow, and three of `Shots`' assumptions were arrow-shaped.** All three
   would have shipped as plausible-looking coordinates:
   - `ThrownTrident.onHitEntity` **deflects** rather than being discarded (`ProjectileDeflection.
     REVERSE`, motion ×0.02/0.2/0.02), so the arrow watch's "motion below 1e-4 means it stopped"
     fires while the weapon is still in the air above the target it just hit — and the coordinates
     handed to the agent are a place the trident is not. Settling is now two consecutive ticks of
     not having moved *at all*.
   - A **Loyalty** trident parks in the ground for four ticks before `tick()` turns it for home,
     which is indistinguishable from coming to rest. A loyal trident is therefore never landed by
     the watch: it is expected to vanish (into the owner's inventory, via the same `tryPickup`),
     and only the timeout reports where it lies if it truly never came back.
   - "The projectile is gone" means the OPPOSITE thing for the two. For an arrow it means it struck
     something; for a trident it usually means the body caught it. `trident_returned` and
     `shot_landed` are different events for that reason.

6. **A defect the review caught that no probe would have** — worth recording because it is the
   shape this workstream keeps producing. The thrown-weapon watch was first written as two
   independent `if`s, "settled?" and "expired?", each ending with `it.remove()`. On any tick where a
   weapon settles *and* its watch expires, that is a double `Iterator.remove()` (an
   `IllegalStateException`) plus a duplicated `trident_landed`. It cannot fire in a probe, because a
   probe's trident settles in the first second of a 200-tick watch — it needs a throw off a cliff,
   or into unloaded chunks, which is a survival run. One terminal decision per tick now. The
   general lesson is the one §11 of the 0.74.0 handoff was already circling: **code that only runs
   after a rare act needs its rare branches read, not exercised**, because the exercise will not
   happen until it is expensive.

**On the probes, and one staging fact worth keeping.** Case 10 stages the chasm, so the trident
lands on the far bank — *unreachable*, which is the whole premise of that arena. The errand goes on
the books and the legs still cannot get there, and the case asserts only the notification, because
that is the half which does not depend on any walk succeeding. 10b re-stages the same act on flat
ground to test the walk. Splitting them was not tidiness: a single case on the chasm would have
"passed" a retrieval that never runs, and a single case on flat ground would never have exercised
the geometry that motivates throwing in the first place.

**Case 10c exists because Loyalty was otherwise unrun code.** The plain-trident cases cannot reach
either of the two decisions that branch makes, and both fail silently: a loyal trident sits in the
ground for four ticks before turning for home (so a watch that calls stillness "landed" hands the
agent coordinates for a weapon already on its way back), and its disappearance is a CATCH where an
arrow's is a HIT. Verified live before the case was written, then pinned by it.

**Live-verified by hand as well as by probe**, because a green count is not a measurement:
`crossbow_charged` false → true → false across a wind and a shot, `crossbow_loaded` at
`held_ticks: 25` (vanilla's own `getChargeDuration`), the loaded shot at **`draw_ticks: 0`**, a
throw reporting `mode: "throw"` with no `arrows_left` key, `trident_landed` and `pickup_scheduled`
carrying real coordinates 9.95 blocks out, and — with nothing whatsoever asked of the body from that
point — `pickup_done` followed by the trident back in the pack. And separately for Loyalty:
`trident_returned {loyalty: true, flight_ticks: 20}` with **zero** `trident_landed` and **zero**
`pickup_scheduled`.

## 14. What designing the arena settled (2026-08-15) — and why step 6 changed shape

The arena's own design is `world-model/COMBAT_CLINIC.md`; it implements §6 with nine numbered
departures and is the document a builder follows. What belongs *here* is the part that invalidates
what this plan said about the spear. All of it was read out of `vanilla-src/`, none of it measured
— which is itself the first finding.

**1. THE SPEAR IS A NO-OP ON THE PLAYER BODY, AND NO AMOUNT OF `CHARGE` WOULD HAVE FIXED IT.**
`KineticWeapon.getMotion` is `getKnownSpeed().scale(20.0)`. `Entity.getKnownSpeed` returns a
realized position delta — but **`ServerPlayer` OVERRIDES it** to return `lastKnownClientMovement`
(ServerPlayer.java:2172-2175), written only by `setKnownMovement`, which the server calls when a
real client sends a movement packet. `FakePlayerEntity extends ServerPlayer`, has no client, and
`grep setKnownMovement mcp-toolkit/` returns **nothing**. So the survival body reports a speed of
**zero, forever**, `relativeSpeed` is identically 0, and `ofRelativeSpeed(225, 4.6)` can never pass
from the attacker's side. A spear in the player body's hand does nothing at any approach speed.

This is the fourth time this workstream has found the same shape — `Engage.loose` (stationed,
aimed, never fired), the `shield` reflex (refused for six versions because nothing called
`bot_equip`), `Mode.CHARGE`/`THROW` declared and unreachable — **the arsenal is carried, the
decision is made, and no path pulls the trigger.** It is also exactly what §6 was for: an
uncalibrated clinic would have run its forty trials, measured zero in every bucket, and blamed the
nav. The fix (`J1`, ~12 lines mirroring realized displacement into `setKnownMovement`) has a blast
radius — `getKnownMovement` also extends reach through `ProjectileUtil.getHitEntitiesAlong` and
feeds every `ofAttackerSpeed` condition — so it wants battery chunks a AND d re-read, not assumed.

**2. §3's "the exact units are not assumed by this design" was answerable by reading.**
`lastKnownSpeed = position() − lastKnownPosition` is blocks per TICK; `getMotion` scales by 20; so
every `Condition` threshold is in **blocks per second**. The iron spear's 4.6 gate sits deliberately
between walking (4.317) and sprinting (5.612): *that is the mechanic*, and it was one file read away
the whole time.

**3. The curve is not a curve.** `damage = getAttributeBaseValue(ATTACK_DAMAGE) + floor(relSpeed ×
0.95)` above a hard gate — a step function — and because it reads the **base** attribute, the
spear's own `ATTACK_DAMAGE` modifier is not in the stab path at all. So §6's headline deliverable
stops being a curve fit and becomes a **falsifiable prediction table checked in before the run**,
with the verdict reported as `measured − predicted`. That is cheaper, sharper, and it is the
strongest available defence against this instrument's characteristic failure — measuring whatever
happened and rationalising it.

**4. A spear is a HOLD, and there is no attack verb in it.** `Item.use` on a `KINETIC_WEAPON` stack
calls `startUsingItem` and returns CONSUME (Item.java:201-205); `getUseDuration` is 72000; and every
use tick `ItemStack.onUseTick` routes to `KineticWeapon.damageEntities` (ItemStack.java:1095-1097),
which sweeps whatever is in front and stabs it. **Nothing is swung and nothing is released.**
`bot_attack` is the wrong actuation entirely, and §4.5's "sprint the last N blocks and then thrust"
is the wrong shape — the right one is *hold it down, sprint through, let go*. By §13's rule (ask
WHAT ENDS IT) this is a **FIFTH sibling**: ended by the caller, or by `computeDamageUseDuration`
(`delayTicks 12 + maxDurationTicks 225` = 237). The rule has now predicted correctly twice running.

**5. §4.5's run-up distance N does not have to be invented — vanilla ships the rhythm.**
`SpearApproach(1.0, 10.0F)` / `SpearAttack(1.0, 1.0, 2.0F)` / `SpearRetreat(1.0)` on the piglin, and
the equivalent `SpearUseGoal`: engage at 10 blocks, hold the spear down for
`computeDamageUseDuration`, charge, and on contact (or within `targetInRangeRadius` 2.0) pick an
away-position **6–7** blocks out and go again; stand off **9–11** when the engagement expires.
Those are Mojang's numbers for this weapon and they are a better starting point than one we fit.
**The withdraw half §4.5 wanted to judge from the clinic already has a reference implementation.**

**What is left for the arena to measure is therefore behavioural, and it is still worth measuring:**
what run-up N actually gets *our* body to threshold speed and holds it through contact, given nav,
the 12-tick arming delay, and a 2.0–4.5 strike shell a sprinting body crosses in about nine ticks.
Design §8.4 tabulates the confounders; the sharpest is that crossing `minReach` before the delay
elapses produces no stab at all and reads exactly like "below threshold".

**Two more things the design settled that this plan had wrong:**

- **§6's "auto metrics from the recorder, joined by action id" is unavailable on both halves.**
  `WmRecorder` has no `flush()` anywhere and closes its gz streams at `SERVER_STOPPING`, so a
  mid-run read is a truncated prefix; and the ordinary swing carries **no `action_id`** at all
  (`DroneHands.java:1637-1640` passes null when the body is already facing). An action-id index
  builds a table in which the reflex and goal arms appear never to have swung. The clinic joins on
  **`game_tick`** off the live event tail, and refines by `action_id` where it exists.
- **§6's "|x| ≥ 1M so `build_corpus.py` flags it as synthetic automatically" is right about
  flagging and wrong if read as exclusion.** The check only runs for sessions whose purpose already
  admits them, so for a `bench` session it never executes. **`purpose: "bench"` is the exclusion**
  (`wmloader/corpus.py:35`); the coordinate is a printed flag.

**Status (2026-08-24, toolkit 0.88.0)**: design committed; build-order steps 0–2 (the pure-JS
foundation — geometry, registry, metrics, row/ledger, the CLI's `--dry`, and two battery-swept
offline probes) built and green. **Step 6 is now built and live-green**: `J1` the speed mirror,
`J4` the `bot_status.speed_known`/`speed_delta` pair, and `probes/known-movement.test.mjs` in
battery chunk d. `J1` landed in `FakePlayerEntity.computeSpeed()` rather than at the top of
`tick()` as design §2.3 sketched — vanilla's own site, the same one-tick lag, and it inherits a
discontinuity rule instead of needing one invented. **`J2` (a `Thrust` sibling) is still not
built**, and that is now the load-bearing gap.

Two things the live run corrected in the design, both recorded in §9.4 of the clinic:
`bot_status.speed_delta` **cannot** join C6's four-way 15% agreement (it is the post-friction
residual, measured 2.31 b/s against a realized 4.23 — the ratio is friction), and a 3-D speed
magnitude reads gravity as motion (a standing body reported 1.57 b/s), so both keys are horizontal.

**And a correction to the sentence that used to end this paragraph.** It said steps 0–5 need no Java
and still produce a real spear threshold, which is true and was read as "so start there". Step 5
needs no Java **and needs a human at a client holding the spear** — design §8.2 says so plainly,
because a spear is a hold and `J2` does not exist. *No Java* and *from a keyboard* are different
questions, and this plan asked the first while the reader needed the second. The target-half
reasoning stands untouched: `minSpeed` is 0 for the damage condition, so a stationary attacker
passes it trivially and `relativeSpeed` becomes the target's own closing speed — and a mob target is
not a `ServerPlayer`, so its speed reading was always real.
