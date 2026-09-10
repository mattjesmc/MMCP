// Live probes for the COMBAT KIT (mcp-toolkit/docs/play/COMBAT_KIT_PLAN.md), toolkit 0.72.0 — the two
// halves 0.71.0's WeaponGate could not reach: the OFFHAND, which no path had ever filled, and the
// fight the body cannot WALK to.
//
// The mandate is measured, from the 9h47m survival run of 2026-08-11: 37 deaths, and SEVEN attack
// goals died `target_unreachable` against targets the body could see perfectly well — with no bow
// in the decision, being unable to put the feet next to something was the end of the fight. The
// `shield` reflex has meanwhile always refused with "no shield in the offhand", because nothing
// ever put one there.
//
// Cases here are the plan's §5 table. The numbering is the plan's, so gaps are honest: 12 belongs
// to step 6 (the spear) and is NOT YET BUILT — and it cannot be, until §6's arena has MEASURED the
// damage-versus-approach-speed curve a kinetic weapon is priced on.
//
//   9. crossbow load  — a crossbow is wound in advance and STAYS wound (vanilla keeps the
//                       ChargedProjectiles component on the stack), so the shot costs no draw at
//                       all: draw_ticks 0. 9b is the half that matters in a real fight — the body
//                       winds it BY ITSELF between shots, paying the 25 ticks out of time it was
//                       spending walking to its station anyway.
//  10. trident throw  — a hunt that cannot WALK to its target throws the trident it carries. The
//                       weapon leaves the hand, so where it comes to rest is REPORTED
//                       (trident_landed {x,y,z}) — that notification is what settled D2, by
//                       dissolving the "a thrown trident is silently lost" premise the open
//                       question rested on. 10b walks the other half: an idle body goes back and
//                       picks it up, which is vanilla's own playerTouch and not a collect verb.
//                       10c is the Loyalty branch, which would otherwise be unrun code: it comes
//                       home by itself, so it must NOT be reported as having landed anywhere (it
//                       sits in the ground four ticks before turning back, which looks exactly like
//                       resting) and its disappearance is a CATCH, not a hit.
//  11. trident retain — the disarm check: a body whose trident is its ONLY weapon does not throw
//                       it automatically, and the refusal names the decision rather than the
//                       symptom. An explicit bot_shoot still throws (the caller has made that
//                       judgement); allow_throw:false refuses in the other direction.
//
//   7. bow draw        — the shot is a REAL draw (toolkit 0.73.0): a full draw reports vanilla's
//                        own top-of-curve power and a measurably faster arrow than a 5-tick snap,
//                        and the arrow's LANDING arrives as shot_landed {hit, damage}. The old
//                        path synthesized an Arrow entity outright — no draw, no power curve, and
//                        a recorded press channel showing a shot with no `use`-hold before it.
//   8. bow ammo        — a bow with an empty quiver refuses `item_missing` and looses NO phantom
//                        arrow; a body carrying nothing ranged refuses `no_weapon` instead,
//                        because "you need arrows" and "you need a bow" are different problems.
//
//   4. shield blocks   — a healthy body RAISES ITS OWN SHIELD out of the pack (this op has refused
//                        "no shield in the offhand" since 0.14.0 because nothing ever put one
//                        there) and a blow from the front costs it no health at all — reported as
//                        body_damaged {damage:0, blocked, blocked_damage}, because a blow blocked
//                        whole moves no health and a health-delta watch cannot see it.
//   5. shield arc      — the identical blow from BEHIND is not blocked. Without this, case 4 would
//                        pass just as well against a shield that blocks everything from anywhere.
//   6. shield delay    — the sharp edge: vanilla's 5-tick block delay means a shield raised as the
//                        blow lands protects NOTHING. Same body, same shield, same direction, ten
//                        ticks apart: the first is taken, the second is blocked.
//
//   1. totem auto-equip  — health ≤ 6 with a totem carried → the offhand holds it, and the swing
//                          verdict + event report `offhand_switched`.
//   2. totem saves       — lethal damage with that totem in the offhand → the body is ALIVE at 1
//                          health, the totem is gone, and `totem_used` says so. A body that
//                          survived at 1 HP and does not say so is a lie by omission.
//   3. shield beats totem— healthy + BOTH carried → the offhand takes the shield, not the totem.
//                          It prevents damage; a totem only converts a death and is consumed.
//  13. mode: unreachable — a target across a chasm the legs cannot cross, bow + arrows carried →
//                          the hunt switches to RANGED and KILLS it, instead of dying
//                          `target_unreachable`. This is the inverted defect.
//  14. mode: hysteresis  — target at ~4 blocks with bow AND sword carried → stays MELEE. The band
//                          (3.5, 6] belongs to melee so a target dancing at 4 cannot make the body
//                          flip between drawing a bow and raising a sword.
//  15. mode: no option   — the same unreachable pillar with NOTHING ranged carried → still fails
//                          `target_unreachable`, and `why` names the MISSING CAPABILITY rather
//                          than the symptom. An agent that reads "target_unreachable" looks for a
//                          path bug; one that reads "no bow or crossbow carried" looks for a bow.
//
// Cases 13 and 15 use the plan's CHASM, and the first draft's pillar is worth recording as a
// negative result: a target atop a 1×1 column is unreachable and visible from a distance, but the
// hunt walks to the column's foot before it concludes anything, and from the foot the column is
// between the eye and the target. The body reported "unreachable, and the sightline is blocked
// too" — honest, and a different case. A horizontal gap keeps the sightline clean at the exact
// spot where the legs run out of options, which is the geometry §4.3 is about.
//
// Staged hostiles carry NoAI:1b (determinism) + PersistenceRequired:1b (checkDespawn discards
// unpersisted hostiles INSTANTLY when any player is online >128 blocks away — and probe files
// spawn fake players at their own sites) + a HELMET: this site is open sky at y=200 and every case
// below reads a health number, so a sunburning zombie would forge the evidence.
//
// OWNS SITE 4,250,000 (site-map.test.mjs guards uniqueness). Own session. Run with
// `npm run test:live` or tools/battery.ps1 -Only combat-kit.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const X = 4_250_000, Z = 4_250_000, Y = 200;
const SESSION = "probe-combat-kit";
// Sub-arenas ≥ 20 blocks apart, so a fight that drifts cannot contaminate its neighbour.
const OX = X, OZ = Z;              // offhand policy (1, 2, 3)
const PX = X + 40, PZ = Z;         // the unreachable pillar (13, 15)
const HX = X, HZ = Z + 40;         // hysteresis (14)
const RX = X, RZ = Z + 80;         // the archery range (7, 8) — its own floor, laid per case
// `/fill` caps at 32768 cells, so the floor is laid in z-bands rather than one command.
const BANDS = [[Z - 16, Z + 12], [Z + 13, Z + 56]];

const STAGED = `{NoAI:1b,PersistenceRequired:1b,equipment:{head:{id:"minecraft:iron_helmet",count:1}}}`;
/** CombatKit.TOTEM_HEALTH — at or below this the offhand policy prefers the totem to the shield. */
const CombatKitTotemMax = 6;

async function call(tool, args = {}) {
  const res = await fetch(`${BASE}/cmd`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-MCPTK-Session": SESSION },
    body: JSON.stringify({ tool, args }),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(`${tool} failed: ${JSON.stringify(j.error)}`);
  return j.result;
}
const cmd = (c) => call("run_command", { command: c });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Sweeps EVERY non-player: a forceloaded site keeps ticking, so it keeps SPAWNING, and a leftover
// creeper turns a staged duel into a crowd fight that reads exactly like a combat regression
// (combat-fixes learned this live on 2026-08-11). Must run AFTER the forceload — vanilla selectors
// only see loaded chunks.
const sweep = () => cmd(
  `kill @e[type=!minecraft:player,x=${X - 20},y=${Y - 6},z=${Z - 20},dx=90,dy=40,dz=130]`
).catch(() => {});

/**
 * The staged zombie NEAREST `origin` — nearest, not merely the first match, because a forceloaded
 * site keeps ticking and therefore keeps SPAWNING. Taking `.find()` hands the case whichever
 * zombie the entity list happened to order first, and a wild spawn 20 blocks away is a target the
 * body can simply walk to: case 13 then passes its hunt against the wrong enemy and never reaches
 * the decision it exists to test (caught live 2026-08-12, and the same lesson combat-fixes' F6
 * cases learned the same day).
 */
async function zombieNear(origin, radius = 24) {
  const r = await call("get_entities", { origin, radius });
  const d2 = (e) => (e.pos.x - origin.x) ** 2 + (e.pos.y - origin.y) ** 2 + (e.pos.z - origin.z) ** 2;
  return (r.entities || [])
    .filter((e) => e.type === "minecraft:zombie")
    .sort((a, b) => d2(a) - d2(b))[0];
}

/** The live body's own name — `/damage` needs a selector and fake players are not @p. */
async function bodyName() {
  const r = await call("bot_status");
  return String(r.name ?? "");
}

async function nowCursor() {
  let cursor;
  for (;;) {
    const r = await call("get_events", cursor ? { cursor, limit: 200 } : { limit: 200 });
    cursor = r.cursor;
    if (!r.more && (r.events || []).length < 200) return cursor;
  }
}
async function waitEvent(type, cursor, timeoutMs, pred = () => true) {
  const deadline = Date.now() + timeoutMs;
  let cur = cursor;
  while (Date.now() < deadline) {
    const r = await call("get_events", { cursor: cur, type, wait_ms: 1500 });
    for (const e of r.events || []) if (e.type === type && pred(e)) return e;
    cur = r.cursor ?? cur;
  }
  return null;
}

/**
 * Spawn a fresh player body and wait out its damage invulnerability. A fresh fake player ignores
 * damage for ~60 ticks (learned live, survival-surroundings-sense), and cases 1–2 open by hurting
 * the body on purpose — without this wait the `/damage` silently does nothing and the case reads
 * as "the policy never fired".
 */
async function freshBody(pos) {
  await call("bot_body", { action: "spawn", type: "player", pos });
  await sleep(4000);
  return bodyName();
}

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok).catch(() => false);
if (!bridgeUp) console.log(`\n  [skip] no bridge at ${BASE} — start the dev server\n`);

describe("combat kit: offhand policy, totem, engagement mode", { skip: !bridgeUp }, () => {
  test("stage the site", async (t) => {
    if (!bridgeUp) return t.skip();
    await cmd(`forceload add ${X - 24} ${Z - 24} ${PX + 24} ${RZ + 12}`);
    await sleep(1500);
    for (const [z0, z1] of BANDS) {
      await cmd(`fill ${X - 16} ${Y} ${z0} ${PX + 16} ${Y} ${z1} minecraft:stone`);
      await cmd(`fill ${X - 16} ${Y + 1} ${z0} ${PX + 16} ${Y + 12} ${z1} minecraft:air`);
    }
    await sleep(400);
    await call("bot_reactions", { action: "clear" });
    await sweep();
  });

  // ---- 1, 3: the offhand policy (COMBAT_KIT_PLAN.md §4.2, D1) --------------

  test("3/shield: healthy with BOTH a shield and a totem carried → the offhand takes the shield",
    async (t) => {
      if (!bridgeUp) return t.skip();
      await sweep();
      await freshBody({ x: OX, y: Y + 1, z: OZ });
      await call("bot_give", { item: "minecraft:stone_sword", count: 1 });
      await call("bot_give", { item: "minecraft:shield", count: 1 });
      await call("bot_give", { item: "minecraft:totem_of_undying", count: 1 });
      await cmd(`summon minecraft:zombie ${OX + 2.5} ${Y + 1} ${OZ + 0.5} ${STAGED}`);
      await sleep(600);
      const z = await zombieNear({ x: OX, y: Y + 1, z: OZ });
      assert.ok(z, "staged zombie present");

      // The swing is the chokepoint every fight path funnels through, so it is where the body
      // arms itself — both hands.
      const r = await call("bot_attack", { target: z.id });
      const st = await call("bot_status");
      assert.match(String(st.offhand ?? ""), /shield/,
        `a healthy body prefers the shield — it PREVENTS damage, while a totem only converts a `
        + `death and is spent doing it: ${JSON.stringify({ attack: r, offhand: st.offhand })}`);
      assert.match(String(r.offhand_switched ?? ""), /shield/,
        `the swing verdict must disclose the slot it changed: ${JSON.stringify(r)}`);
      assert.ok(typeof r.why === "string" && r.why.length > 0,
        `every attack verdict carries why (§4.6): ${JSON.stringify(r)}`);
      assert.equal(r.mode, "melee", `a swing in reach is a melee decision: ${JSON.stringify(r)}`);
    });

  test("1/totem: at or below 6 health with a totem carried → the offhand switches to the totem",
    async (t) => {
      if (!bridgeUp) return t.skip();
      // Continues from case 3: same body, shield in the offhand, totem in the pack. Hurt it past
      // the threshold and the NEXT swing must re-decide the slot.
      const name = await bodyName();
      assert.ok(name, "the body from the previous case is still up");
      const before = await call("bot_status");
      assert.match(String(before.offhand ?? ""), /shield/, "precondition: the shield is up");

      const cur = await nowCursor();
      await cmd(`damage ${name} 15 minecraft:generic`);
      await sleep(500);
      const hurt = await call("bot_status");
      assert.ok(hurt.health <= 6,
        `staging must actually take the body under the totem threshold (health ${hurt.health}) — `
        + `a fresh fake player is damage-invulnerable for ~60 ticks`);

      const z = await zombieNear({ x: OX, y: Y + 1, z: OZ });
      assert.ok(z, "the staged zombie is still present");
      const r = await call("bot_attack", { target: z.id });
      const st = await call("bot_status");
      assert.match(String(st.offhand ?? ""), /totem/,
        `one more hit is death: at ≤ 6 health the totem outranks the shield — a 90° arc is not a `
        + `promise. ${JSON.stringify({ health: hurt.health, attack: r, offhand: st.offhand })}`);
      assert.match(String(r.offhand_switched ?? ""), /totem/, JSON.stringify(r));
      const ev = await waitEvent("offhand_switched", cur, 4000,
        (e) => /totem/.test(String(e.data?.item ?? "")));
      assert.ok(ev, "an offhand change is a real action and must reach the event stream, not only "
        + "the reply of whoever happened to ask");
    });

  test("2/totem saves: lethal damage with the totem up → alive at 1 health, and totem_used says so",
    async (t) => {
      if (!bridgeUp) return t.skip();
      const name = await bodyName();
      const before = await call("bot_status", { inventory: true });
      assert.match(String(before.offhand ?? ""), /totem/, "precondition: the totem is up");
      assert.ok(before.health <= CombatKitTotemMax,
        `precondition: the body must still be under the totem threshold when the blow lands — `
        + `natural regeneration runs between cases (health ${before.health})`);

      const cur = await nowCursor();
      await cmd(`damage ${name} 1000 minecraft:generic`);
      await sleep(800);

      const st = await call("bot_status", { inventory: true });
      // `health > 0` ALONE IS NOT EVIDENCE OF A RESCUE: a body that actually died is replaced by a
      // fresh one at full health with an empty offhand, which passes both of the checks below for
      // exactly the wrong reason. So the death is ruled out explicitly.
      const died = await waitEvent("body_died", cur, 500);
      assert.ok(!died, `the body DIED — the totem did not convert it: ${JSON.stringify(died?.data)}`);
      assert.ok(st.health > 0,
        `the totem must have converted the death — the body is gone: ${JSON.stringify(st)}`);
      assert.ok(!/totem/.test(String(st.offhand ?? "")),
        `the totem is CONSUMED, not merely held: offhand is ${JSON.stringify(st.offhand)}`);

      // The EVENT is the instrument for "it survived at 1 health", not this sample. Vanilla sets
      // health to exactly 1.0 and then the body's own saturation regen starts lifting it
      // immediately: a poll 800ms later legitimately reads 2.67, and asserting on that number
      // would be testing the sampling delay rather than the rescue. The watch that emits
      // totem_used runs in the tick where it happened and carries the health it saw.
      const ev = await waitEvent("totem_used", cur, 5000);
      if (!ev) {
        // Carry the evidence rather than just the claim: which events DID arrive is the whole
        // diagnosis, and re-running a live probe to find out costs minutes.
        const all = await call("get_events", { cursor: cur, limit: 80 });
        assert.fail("a body that survived at 1 HP and does not say so is a lie by omission — the "
          + "agent reads `health: 1`, concludes it took a bad hit, and keeps fighting the thing "
          + "that just killed it with no totem left. Stream since the blow: "
          + JSON.stringify((all.events ?? []).map((e) => e.type))
          + `  before=${JSON.stringify(before.health)}/${JSON.stringify(before.offhand)}`
          + `/${JSON.stringify(before.inventory?.slots)}`
          + `  after=${JSON.stringify(st.health)}/${JSON.stringify(st.offhand)}`
          + `/${JSON.stringify(st.inventory?.slots)}`);
      }
      // Vanilla sets health to exactly 1.0 and hands the body Regeneration II in the same breath,
      // so by the time ANY watcher looks it already reads ~2 (measured live: 2.0 on the emitting
      // tick, 2.67 by the next poll). The claim worth pinning is that this was a near-death
      // rescue, not the instant unobservable to us.
      assert.ok(Number(ev.data?.health) <= 4,
        `the rescue leaves the body at death's door: ${JSON.stringify(ev.data)}`);
      assert.equal(Number(ev.data?.totems_left), 0,
        `the last totem is spent — the agent must know it has no second one: `
        + `${JSON.stringify(ev.data)}`);
    });

  // ---- 13, 15: engagement mode (COMBAT_KIT_PLAN.md §4.3) -------------------

  /**
   * The chasm arena: a 7-wide, 11-deep trench cut clean across the floor's whole z-extent, with
   * the target on the far side at the same level. Rebuilt per case so neither inherits the other's
   * leftovers.
   *
   * A TRENCH AND NOT A PILLAR, learned by trying the pillar first: a target on a 1×1 column IS
   * unreachable and visible from a distance, but the hunt walks to the column's foot before it
   * concludes anything — and from the foot, the column itself is between the eye and the target.
   * The body then honestly reported "unreachable, and the sightline is blocked too", which is a
   * different (real) case and not this one. A horizontal gap keeps the sightline clean at the exact
   * spot the legs give up, which is the geometry §4.3 is about.
   *
   * 11 deep so the navigator's own fall-damage avoidance keeps the body out of it, and spanning
   * the full staged z-range so there is no way around.
   */
  async function stageChasm() {
    await sweep();
    for (const [z0, z1] of BANDS) {
      await cmd(`fill ${PX - 3} ${Y - 10} ${z0} ${PX + 3} ${Y} ${z1} minecraft:air`);
    }
    await cmd(`summon minecraft:zombie ${PX + 6.5} ${Y + 1} ${PZ + 0.5} ${STAGED}`);
    await sleep(700);
    const z = await zombieNear({ x: PX + 6, y: Y + 1, z: PZ }, 20);
    assert.ok(z, "staged zombie present across the chasm");
    // And it is OURS, on the far bank. A wild spawn on the body's own side is walkable-to, so the
    // hunt would resolve by closing on it and the case would pass without ever making the decision
    // it exists to test.
    assert.ok(z.pos.x > PX + 3,
      `the hunted zombie must be the staged one ACROSS the chasm, not a wild spawn on this side: `
      + `${JSON.stringify(z.pos)}`);
    return z;
  }

  test("13/unreachable: a target the legs cannot reach, bow carried → the hunt SHOOTS it",
    async (t) => {
      if (!bridgeUp) return t.skip();
      const z = await stageChasm();
      // 12 blocks apart across the trench, both at floor level: no path exists (the gap is 7 wide
      // and 11 deep, with may_modify none), and the sightline straight across it is perfectly
      // clear at the very spot where the legs run out of options.
      await freshBody({ x: PX - 6, y: Y + 1, z: PZ });
      await call("bot_give", { item: "minecraft:bow", count: 1 });
      await call("bot_give", { item: "minecraft:arrow", count: 32 });

      const cur = await nowCursor();
      const g = await call("bot_target", { action: "attack", target: { entity: z.id } });
      assert.equal(g.started, true, JSON.stringify(g));

      const switched = await waitEvent("attack_mode_changed", cur, 30000,
        (e) => e.data?.mode === "ranged");
      assert.ok(switched, "the hunt must notice it cannot WALK there and reach for the bow — this "
        + "is the case that killed 7 goals in the 9h47m run, every one of them against a target "
        + "the body could see");
      assert.ok(typeof switched.data?.why === "string" && switched.data.why.length > 0,
        `the switch must say why: ${JSON.stringify(switched)}`);

      // ...and it must actually WIN. A mode change that shoots nothing down is a nicer-sounding
      // failure, not a fix.
      const done = await waitEvent("action_completed", cur, 60000,
        (e) => e.data?.action_id === g.action_id);
      assert.ok(done, "the ranged hunt never completed — it should kill the target from where it "
        + "stands (32 arrows staged against a 20 HP zombie)");
      assert.equal(done.data?.outcome, "achieved", JSON.stringify(done));
      assert.ok(Number(done.data?.shots) > 0, `shots must be reported: ${JSON.stringify(done)}`);
    });

  test("15/no option: the same unreachable target with nothing ranged → still fails, and why names "
    + "the missing capability", async (t) => {
      if (!bridgeUp) return t.skip();
      const z = await stageChasm();
      await freshBody({ x: PX - 6, y: Y + 1, z: PZ });
      await call("bot_give", { item: "minecraft:stone_sword", count: 1 });

      const cur = await nowCursor();
      const g = await call("bot_target", { action: "attack", target: { entity: z.id } });
      assert.equal(g.started, true, JSON.stringify(g));

      const failed = await waitEvent("action_failed", cur, 45000,
        (e) => e.data?.action_id === g.action_id);
      assert.ok(failed, "a target that genuinely cannot be fought must still concede");
      assert.equal(failed.data?.reason, "target_unreachable", JSON.stringify(failed));
      assert.match(String(failed.data?.why ?? ""), /bow|crossbow|fire/i,
        `the verdict must name what was MISSING, not just what went wrong — "target_unreachable" `
        + `alone sent the 2026-08-11 agent looking for a path bug seven times when what it needed `
        + `was a bow: ${JSON.stringify(failed.data)}`);
    });

  // ---- 14: the hysteresis band --------------------------------------------

  test("14/hysteresis: a target at ~4 blocks with bow AND sword carried stays MELEE", async (t) => {
    if (!bridgeUp) return t.skip();
    await sweep();
    await freshBody({ x: HX, y: Y + 1, z: HZ });
    await call("bot_give", { item: "minecraft:stone_sword", count: 1 });
    await call("bot_give", { item: "minecraft:bow", count: 1 });
    await call("bot_give", { item: "minecraft:arrow", count: 16 });
    await cmd(`summon minecraft:zombie ${HX + 4.5} ${Y + 1} ${HZ + 0.5} ${STAGED}`);
    await sleep(700);
    const z = await zombieNear({ x: HX, y: Y + 1, z: HZ });
    assert.ok(z, "staged zombie present");

    // 4 blocks is inside the dead band (3.5, 6]: past swing reach, short of the ranged floor.
    // Engage is the caller that reads it, because it is the one that decides where to STAND.
    await call("bot_target", { action: "attack", target: { kind: "zombie" } });
    const eng = await call("bot_body", { action: "engage", mode: "fight", policy: "kite" });
    await sleep(2500);

    const st = await call("bot_status", { inventory: true });
    assert.match(String(st.inventory?.held ?? ""), /sword/,
      `inside the band the body closes and swings — flipping to a bow at 4 blocks would cost a `
      + `hotbar swap and reset the attack-strength ticker on every oscillation: `
      + `${JSON.stringify({ engage: eng, held: st.inventory?.held })}`);
    const r = await call("bot_attack", { nearest: true });
    assert.equal(r.mode ?? "melee", "melee", JSON.stringify(r));
    await call("bot_body", { action: "engage", on: false });
  });

  // ---- 7, 8: the real draw (COMBAT_KIT_PLAN.md §4.4, step 3) ---------------

  /**
   * The archery range: a narrow strip of floor with the shooter at one end. Its own arena, 40
   * blocks clear of the hysteresis pen, because an arrow that misses keeps travelling and a stray
   * one landing in another case's fight is exactly the contamination the spacing rule exists for.
   *
   * Laid per case rather than in `stage the site` so it also gets swept per case: the range is the
   * one arena where a wild spawn is not merely noise but a second target the `nearest` scan could
   * legitimately prefer.
   */
  async function stageRange(distance) {
    await sweep();
    await cmd(`fill ${RX - 4} ${Y} ${RZ - 6} ${RX + 26} ${Y} ${RZ + 6} minecraft:stone`);
    await cmd(`fill ${RX - 4} ${Y + 1} ${RZ - 6} ${RX + 26} ${Y + 6} ${RZ + 6} minecraft:air`);
    await sleep(300);
    await cmd(`summon minecraft:zombie ${RX + distance + 0.5} ${Y + 1} ${RZ + 0.5} ${STAGED}`);
    await sleep(700);
    const z = await zombieNear({ x: RX + distance, y: Y + 1, z: RZ }, 20);
    assert.ok(z, "staged zombie present on the range");
    return z;
  }

  test("7/draw: the shot is a REAL draw — full draw beats a snap shot in power and speed, and the "
    + "arrow lands", async (t) => {
      if (!bridgeUp) return t.skip();
      const z = await stageRange(10);
      await freshBody({ x: RX, y: Y + 1, z: RZ });
      await call("bot_give", { item: "minecraft:bow", count: 1 });
      await call("bot_give", { item: "minecraft:arrow", count: 32 });
      // The dig gate's parting gift, and the reason WeaponGate exists: the hand is holding
      // something else entirely when the fight starts. The shot must arm itself.
      await call("bot_give", { item: "minecraft:stone_pickaxe", count: 1 });
      await call("bot_select", { item: "stone_pickaxe" });

      const cur = await nowCursor();
      const full = await call("bot_shoot", { target: z.id, wait: true });
      assert.equal(full.ok, true, JSON.stringify(full));
      assert.match(String(full.weapon ?? ""), /bow/,
        `the body arms itself with the bow it carries: ${JSON.stringify(full)}`);
      assert.equal(full.draw_ticks, 20,
        `a full draw is vanilla's own 20 ticks — a tap fires a limp arrow, and the difference `
        + `between the two IS the skill: ${JSON.stringify(full)}`);
      assert.equal(full.power, 1, `20 ticks is the top of the power curve: ${JSON.stringify(full)}`);

      const snap = await call("bot_shoot", { target: z.id, draw_ticks: 5, wait: true });
      assert.equal(snap.ok, true, JSON.stringify(snap));
      assert.ok(snap.power < full.power,
        `a 5-tick snap must be measurably weaker than a full draw — if both report the same power `
        + `the draw is decoration and vanilla never saw it: ${JSON.stringify({ full, snap })}`);
      assert.ok(snap.speed < full.speed,
        `and slower in the air, because vanilla launches at power × 3: ${JSON.stringify({ full, snap })}`);

      // The DRAW is the act; whether the arrow connects is a later fact about a projectile still in
      // the air, and it arrives on its own event (Shots).
      const landed = await waitEvent("shot_landed", cur, 15000, (e) => e.data?.hit === true);
      assert.ok(landed, "a body that cannot tell a hit from a miss cannot learn to aim — one of "
        + "these arrows hit a NoAI zombie 10 blocks away and shot_landed must say so");
      assert.ok(Number(landed.data?.damage) > 0, JSON.stringify(landed.data));
      await sweep();
    });

  test("8/ammo: a bow with an empty quiver refuses and looses NO phantom arrow; nothing ranged at "
    + "all is a different refusal", async (t) => {
      if (!bridgeUp) return t.skip();
      const z = await stageRange(10);
      await freshBody({ x: RX, y: Y + 1, z: RZ });
      await call("bot_give", { item: "minecraft:bow", count: 1 });

      const empty = await call("bot_shoot", { target: z.id, wait: true });
      assert.equal(empty.ok, false, `a bow with no arrows is not a capability: ${JSON.stringify(empty)}`);
      assert.equal(empty.reason, "item_missing", JSON.stringify(empty));
      assert.match(String(empty.note ?? ""), /fire|arrow/i,
        `the refusal must name which HALF is missing: ${JSON.stringify(empty)}`);
      // The old path synthesized an Arrow entity and only borrowed the bow for its enchantments —
      // it would happily have fired one here, from an empty quiver.
      const ents = await call("get_entities", { origin: { x: RX, y: Y + 1, z: RZ }, radius: 24 });
      assert.equal((ents.entities || []).filter((e) => /arrow/.test(e.type)).length, 0,
        `no phantom projectile: ${JSON.stringify((ents.entities || []).map((e) => e.type))}`);

      // Same site, a body carrying no ranged weapon at all. "You need arrows" and "you need a bow"
      // are different problems with different fixes, and an agent can only act on the one it hears.
      await freshBody({ x: RX, y: Y + 1, z: RZ });
      await call("bot_give", { item: "minecraft:stone_sword", count: 1 });
      const bare = await call("bot_shoot", { target: z.id, wait: true });
      assert.equal(bare.ok, false, JSON.stringify(bare));
      assert.equal(bare.reason, "no_weapon", JSON.stringify(bare));
      assert.match(String(bare.note ?? ""), /bow|crossbow/i, JSON.stringify(bare));
      await sweep();
    });

  // ---- 4, 5, 6: shield mechanics (COMBAT_KIT_PLAN.md §4.4/§4.6, step 4) ----

  /**
   * The shield arena, and WHY IT IS NOT AN ARCHER.
   *
   * The plan's table says "skeleton arrow from the front". A real arrow tests the same vanilla
   * maths these cases test — and adds a flight time nobody controls, an archer with its own aim,
   * and a 5-tick window that has to be hit through an HTTP round trip. Case 6 is a measurement OF
   * THAT WINDOW, so a staging that cannot place a blow inside it cannot measure it at all.
   *
   * `/damage <name> <n> minecraft:arrow at <x y z>` is the same blow with the two free variables
   * pinned: `at` becomes the DamageSource's source position, which is the only thing
   * LivingEntity.applyItemBlocking reads to compute the arc (it takes the horizontal angle between
   * that position and getYHeadRot()), and the command lands on the tick it is sent. Everything
   * under test — the 90° arc, the block delay, the reduction, our reporting of all three — runs
   * exactly as it does for an arrow. The real archer's job is the arena (§6), where a fight is
   * WATCHED rather than asserted.
   */
  const SX = X + 40, SZ = Z + 80;   // shield range: its own arena, 40 clear of the archery strip

  async function stageShield() {
    await sweep();
    await cmd(`fill ${SX - 6} ${Y} ${SZ - 6} ${SX + 6} ${Y} ${SZ + 6} minecraft:stone`);
    await cmd(`fill ${SX - 6} ${Y + 1} ${SZ - 6} ${SX + 6} ${Y + 6} ${SZ + 6} minecraft:air`);
    await sleep(300);
    const name = await freshBody({ x: SX, y: Y + 1, z: SZ });
    await call("bot_give", { item: "minecraft:shield", count: 1 });
    // FACE +X, so "in front" and "behind" are coordinates and not guesses. The arc is measured off
    // the HEAD rotation (applyItemBlocking takes the horizontal angle between the source position
    // and calculateViewVector(0, getYHeadRot)), and bot_look writes yaw, head and body together.
    // `at` rather than a literal yaw ON PURPOSE: Minecraft's yaw runs backwards (+X is -90, not
    // 90), and a probe that gets the sign wrong tests the arc from behind while claiming the front
    // — it would fail case 4 and PASS case 5, which reads as a broken shield rather than a broken
    // probe.
    await call("bot_look", { at: { x: SX + 8, y: Y + 2, z: SZ } });
    await sleep(300);
    const facing = await call("bot_status");
    assert.ok(facing.pos.x !== undefined, "the body is up");
    return name;
  }

  /** Damage from a world position, i.e. with a real arc to resolve. `minecraft:arrow` rather than
   *  `generic` because generic is what a probe reaches for by habit and it has NO source position
   *  at all — the angle then defaults to π, nothing is ever inside the arc, and every case would
   *  "prove" the shield does not work. */
  const hitFrom = (name, amount, x, z) =>
    cmd(`damage ${name} ${amount} minecraft:arrow at ${x} ${Y + 2} ${z}`);

  test("4/shield blocks: a healthy body raises its own shield, and a blow from the FRONT costs it "
    + "no health", async (t) => {
      if (!bridgeUp) return t.skip();
      const name = await stageShield();

      // Nothing was equipped by hand: the raise fills the offhand from the pack, which is the half
      // of this that has never worked. The `shield` reflex has refused "no shield in the offhand"
      // since 0.14.0 because no path ever called bot_equip.
      const up = await call("bot_body", { action: "guard", ticks: 100 });
      assert.equal(up.ok, true, `the body must arm its own offhand: ${JSON.stringify(up)}`);
      assert.match(String(up.blocking ?? ""), /shield/, JSON.stringify(up));
      assert.equal(up.block_ready_in, 5,
        `vanilla's own block delay is 0.25s, and it is the whole reason this reflex binds to `
        + `projectile_incoming rather than to damage: ${JSON.stringify(up)}`);

      const raised = await call("bot_status");
      assert.match(String(raised.offhand ?? ""), /shield/,
        `the shield moved from the pack to the hand: ${JSON.stringify(raised)}`);

      await sleep(600);   // well past the 5-tick delay — case 6 is where that window is measured
      const live = await call("bot_status");
      assert.match(String(live.blocking ?? ""), /shield/,
        `a raised shield is a state the agent can READ, not one it has to remember: `
        + `${JSON.stringify(live)}`);
      assert.equal(live.block_ready_in, undefined,
        `past the delay the shield is simply live, and the key disappears: ${JSON.stringify(live)}`);

      const cur = await nowCursor();
      const before = live.health;
      await hitFrom(name, 6, SX + 8, SZ);   // dead ahead of a body looking +x
      await sleep(700);

      const after = await call("bot_status");
      // `>=`, NOT `===`. Health is a MONOTONE-UP quantity between blows here — a fed body
      // regenerates, and asserting equality tests the sampling delay rather than the block (it
      // caught case 6 live at 15.5 → 16.0). "It lost nothing" is the whole claim, and the event
      // below carries the exact number the shield ate.
      assert.ok(after.health >= before,
        `a full block costs NO health — vanilla's shield reduction is factor 1.0 inside the arc: `
        + `${JSON.stringify({ before, after: after.health })}`);
      // ...and the body must SAY so. This is the event that could not exist before: a blow blocked
      // whole moves no health, so a health-delta watch cannot see it even in principle, and "nobody
      // is shooting at me" read identically to "somebody is and the shield is holding".
      const ev = await waitEvent("body_damaged", cur, 5000, (e) => e.data?.blocked === true);
      assert.ok(ev, "a blocked blow is still a blow and must reach the stream — an agent that only "
        + "hears about damage it TOOK cannot tell an attack from silence");
      assert.equal(Number(ev.data?.damage), 0, JSON.stringify(ev.data));
      assert.ok(Number(ev.data?.blocked_damage) > 0,
        `and it must say how much the shield ate: ${JSON.stringify(ev.data)}`);
    });

  test("5/shield arc: the same blow from BEHIND is not blocked — the 90° arc is real", async (t) => {
    if (!bridgeUp) return t.skip();
    const name = await stageShield();
    const up = await call("bot_body", { action: "guard", ticks: 100 });
    assert.equal(up.ok, true, JSON.stringify(up));
    await sleep(600);

    const before = (await call("bot_status")).health;
    const cur = await nowCursor();
    await hitFrom(name, 6, SX - 8, SZ);   // behind a body looking +x
    await sleep(700);

    const after = await call("bot_status");
    assert.ok(after.health < before,
      `a shield does not cover your back — if this blow was blocked the arc is not being resolved `
      + `at all, and case 4 would pass for the wrong reason: `
      + `${JSON.stringify({ before, after: after.health })}`);
    const ev = await waitEvent("body_damaged", cur, 5000);
    assert.ok(ev, "the hit must be reported");
    assert.ok(!ev.data?.blocked,
      `and it must NOT claim a block: ${JSON.stringify(ev.data)}`);
  });

  test("6/shield delay: raised as the blow lands it blocks nothing; raised 10 ticks early it "
    + "blocks", async (t) => {
      if (!bridgeUp) return t.skip();
      const name = await stageShield();

      // THE SHARP EDGE, measured. Items.SHIELD carries block_delay_seconds 0.25, and
      // LivingEntity.getItemBlockingWith() returns null until that many ticks have elapsed — so a
      // shield raised as the arrow arrives does exactly nothing. The two halves are fired back to
      // back against the same body so the ONLY difference between them is the wait.
      const up = await call("bot_body", { action: "guard", ticks: 200 });
      assert.equal(up.ok, true, JSON.stringify(up));
      const beforeEarly = (await call("bot_status")).health;
      const cur = await nowCursor();
      // No sleep: the raise and the blow are consecutive calls, inside the 5-tick delay.
      await hitFrom(name, 6, SX + 8, SZ);
      await sleep(700);
      const hurt = (await call("bot_status")).health;
      assert.ok(hurt < beforeEarly,
        `a shield raised into the blow protects NOTHING (5-tick block delay) — if this one blocked, `
        + `either the raise is not going through vanilla's use ticks or the probe lost the race: `
        + `${JSON.stringify({ before: beforeEarly, after: hurt })}`);
      const missed = await waitEvent("body_damaged", cur, 5000);
      assert.ok(missed && !missed.data?.blocked, JSON.stringify(missed?.data));

      // Same shield, same hold, same direction — 10 ticks later.
      await sleep(500);
      const live = await call("bot_status");
      assert.match(String(live.blocking ?? ""), /shield/,
        `the hold outlives the blow it failed to block: ${JSON.stringify(live)}`);
      const beforeLate = live.health;
      const cur2 = await nowCursor();
      await hitFrom(name, 6, SX + 8, SZ);
      await sleep(700);
      const kept = (await call("bot_status")).health;
      // `>=` for the reason case 4 states: this half runs on a HURT body, so regeneration is live
      // and an equality here measures the sampling delay. Live: 15.5 → 16.0, a "failure" in which
      // the shield had worked perfectly.
      assert.ok(kept >= beforeLate,
        `the identical blow, against the identical shield, ten ticks later: THIS one is blocked. `
        + `The only variable is the delay, which is why the reflex binds to projectile_incoming `
        + `and never to damage: ${JSON.stringify({ before: beforeLate, after: kept })}`);
      const blocked = await waitEvent("body_damaged", cur2, 5000, (e) => e.data?.blocked === true);
      assert.ok(blocked, "and the block must be reported");
      assert.equal(Number(blocked.data?.damage), 0,
        `nothing got through the second time: ${JSON.stringify(blocked.data)}`);
      await call("bot_body", { action: "guard", on: false });
      await sweep();
    });

  test("6c/axe: an axe knocks the guard aside — shield_disabled, and the shield refuses to rise "
    + "until its cooldown clears", async (t) => {
      if (!bridgeUp) return t.skip();
      const name = await stageShield();
      // An AXE is the counter, and it is the attacker's weapon that decides:
      // LivingEntity.getSecondsToDisableBlocking reads the WEAPON component of the stack in the
      // attacker's hand, so the blow has to come `by` a real entity holding one — a bare
      // `minecraft:player_attack at <pos>` blocks fine and disables nothing.
      await cmd(`summon minecraft:zombie ${SX + 3.5} ${Y + 1} ${SZ + 0.5} `
        + `{NoAI:1b,PersistenceRequired:1b,equipment:{head:{id:"minecraft:iron_helmet",count:1},`
        + `mainhand:{id:"minecraft:iron_axe",count:1}}}`);
      await sleep(700);
      const up = await call("bot_body", { action: "guard", ticks: 200 });
      assert.equal(up.ok, true, JSON.stringify(up));
      await sleep(600);   // past the block delay: this blow IS blocked, and breaks the guard doing it

      const cur = await nowCursor();
      const sel = `@e[type=minecraft:zombie,limit=1,sort=nearest,x=${SX},y=${Y},z=${SZ},distance=..8]`;
      await cmd(`damage ${name} 4 minecraft:player_attack by ${sel}`);
      await sleep(900);

      const ev = await waitEvent("shield_disabled", cur, 6000);
      assert.ok(ev, "a guard knocked aside is the body standing where it chose to stand BECAUSE it "
        + "was covered, and no longer being covered — silence here is the worst kind");
      const st = await call("bot_status");
      assert.equal(st.blocking, undefined,
        `vanilla lowers the shield as it disables it — a status still claiming to block would be `
        + `the lie this event exists to prevent: ${JSON.stringify(st)}`);
      // And the refusal to re-raise: raising into the cooldown does nothing at all, so answering
      // ok:true would leave the body holding a decoration.
      const again = await call("bot_body", { action: "guard" });
      assert.equal(again.ok, false, JSON.stringify(again));
      assert.equal(again.reason, "shield_disabled", JSON.stringify(again));
      await sweep();
    });

  test("6b/no shield: a body carrying nothing that blocks refuses, and names the fix rather than "
    + "a tool it cannot see", async (t) => {
      if (!bridgeUp) return t.skip();
      await sweep();
      await freshBody({ x: SX, y: Y + 1, z: SZ });
      await call("bot_give", { item: "minecraft:stone_sword", count: 1 });
      const r = await call("bot_body", { action: "guard" });
      assert.equal(r.ok, false, JSON.stringify(r));
      assert.equal(r.reason, "no_shield", JSON.stringify(r));
      // The invariant that has now bitten twice (COMBAT_KIT_PLAN.md §5): a refusal must not send
      // the reader to a verb the active profile hides. This one describes the REMEDY instead.
      assert.ok(!/bot_equip|bot_select/.test(String(r.note ?? "")),
        `refusals must not name hidden verbs: ${JSON.stringify(r)}`);

      // A totem and NO shield is still `no_shield`. The policy hands back the totem here for the
      // trivial reason that there was nothing to compare it against, and reporting that as "the
      // policy preferred your totem" would invent a decision nobody made.
      await call("bot_give", { item: "minecraft:totem_of_undying", count: 1 });
      const t2 = await call("bot_body", { action: "guard" });
      assert.equal(t2.ok, false, JSON.stringify(t2));
      assert.equal(t2.reason, "no_shield",
        `a totem is not a shield — it converts a death, it does not prevent damage: `
        + `${JSON.stringify(t2)}`);

      // BOTH carried, and hurt past the threshold: NOW there is a decision, D1 has taken it, and
      // the refusal names it. This is the one place the offhand policy's cost is visible — a body
      // at 4 health cannot block, by choice, and an agent told only "no_shield" would go looking
      // for a shield it is already carrying.
      const name = await bodyName();
      await call("bot_give", { item: "minecraft:shield", count: 1 });
      await cmd(`damage ${name} 16 minecraft:generic`);
      await sleep(500);
      const hurt = await call("bot_status");
      assert.ok(hurt.health <= CombatKitTotemMax,
        `staging must take the body under the totem threshold: ${JSON.stringify(hurt)}`);
      const t3 = await call("bot_body", { action: "guard" });
      assert.equal(t3.ok, false, JSON.stringify(t3));
      assert.equal(t3.reason, "totem_preferred", JSON.stringify(t3));
      assert.match(String(t3.note ?? ""), /totem/i, JSON.stringify(t3));
      await sweep();
    });

  test("E/engage: a fight-mode engagement at bow range LOOSES ARROWS by itself", async (t) => {
    if (!bridgeUp) return t.skip();
    // Not one of the plan's numbered cases: a hole step 3 opened the door to closing. Engage
    // stations a ranged body out at the band (or up on a vantage) and aims at the enemy every
    // tick — and until 0.73.0 nothing there ever fired, because the only trigger was the fight
    // REFLEX's swing, which answers `out_of_reach` at 10 blocks for as long as the duel lasts. The
    // body backed away from its enemy and did nothing. NO REFLEXES ARE ARMED here, deliberately:
    // that is what makes the engagement itself the thing under test.
    const z = await stageRange(11);
    await freshBody({ x: RX, y: Y + 1, z: RZ });
    await call("bot_reactions", { action: "clear" });
    await call("bot_give", { item: "minecraft:bow", count: 1 });
    await call("bot_give", { item: "minecraft:arrow", count: 32 });
    const before = z.health;

    await call("bot_target", { action: "attack", target: { entity: z.id } });
    await call("bot_body", { action: "engage", mode: "fight", policy: "hold" });
    await sleep(20000);
    const now = await zombieNear({ x: RX + 11, y: Y + 1, z: RZ }, 20);
    await call("bot_body", { action: "engage", on: false, clear_targets: true });
    assert.ok(!now || now.health < before,
      `an engaged archer must SHOOT: before=${before} after=${now?.health}. A body that carries the `
      + `arsenal, decides to use it, and never pulls the trigger is target_unreachable wearing `
      + `different clothes`);
    await sweep();
  });

  // ---- 9, 10, 11: the crossbow and the trident (step 5) --------------------

  test("9/crossbow: a crossbow is WOUND in advance and stays wound — the shot then costs no draw",
    async (t) => {
      if (!bridgeUp) return t.skip();
      const z = await stageRange(10);
      await freshBody({ x: RX, y: Y + 1, z: RZ });
      await call("bot_give", { item: "minecraft:crossbow", count: 1 });
      await call("bot_give", { item: "minecraft:arrow", count: 16 });
      // Holding something else entirely, as always: the load must arm itself out of the pack.
      await call("bot_give", { item: "minecraft:stone_pickaxe", count: 1 });
      await call("bot_select", { item: "stone_pickaxe" });

      // A carried-but-empty crossbow reads as false, not as absent. The key's PRESENCE is the fact
      // "a crossbow is carried"; its value is the fact "there is a free shot in it" — and a body
      // that cannot tell those apart cannot decide whether it may open a fight at range.
      const cold = await call("bot_status");
      assert.equal(cold.crossbow_charged, false,
        `an unwound crossbow must report false, not vanish: ${JSON.stringify(cold)}`);

      const cur = await nowCursor();
      const load = await call("bot_body", { action: "load" });
      assert.equal(load.ok, true, JSON.stringify(load));
      assert.match(String(load.loading ?? ""), /crossbow/, JSON.stringify(load));
      // Vanilla's own schedule (CrossbowItem.getChargeDuration = 1.25s), quoted rather than
      // asserted as a constant: Quick Charge moves it, and a probe that pinned 25 would be pinning
      // the absence of an enchantment.
      assert.ok(load.charge_ticks >= 20 && load.charge_ticks <= 30,
        `~25 ticks at 1.25s: ${JSON.stringify(load)}`);
      assert.match(String(load.weapon_switched ?? ""), /crossbow/,
        `the body arms itself for the wind, out of a hand holding a pickaxe: ${JSON.stringify(load)}`);

      const done = await waitEvent("crossbow_loaded", cur, 8000);
      assert.ok(done, "the wind must finish and say so — a load nobody hears about is a load the "
        + "agent will pay for twice");
      const warm = await call("bot_status");
      assert.equal(warm.crossbow_charged, true, JSON.stringify(warm));

      // THE WHOLE POINT: the bolt leaves with no draw at all. This is what makes pre-loading a
      // behaviour rather than a decoration — 25 ticks paid out of time nothing was waiting on.
      const shot = await call("bot_shoot", { target: z.id, wait: true });
      assert.equal(shot.ok, true, JSON.stringify(shot));
      assert.match(String(shot.weapon ?? ""), /crossbow/, JSON.stringify(shot));
      assert.equal(shot.draw_ticks, 0,
        `a loaded crossbow fires on the spot — a nonzero draw here means the charge was thrown `
        + `away and re-paid at exactly the moment it could least be afforded: ${JSON.stringify(shot)}`);

      const spent = await call("bot_status");
      assert.equal(spent.crossbow_charged, false,
        `firing spends the charge: ${JSON.stringify(spent)}`);

      // And the refusal worth telling apart from the rest. A BOW cannot be pre-loaded at all — its
      // draw is spent at the shot — and answering "no_weapon" for a body visibly holding a bow
      // would be baffling without the note that says why.
      await freshBody({ x: RX, y: Y + 1, z: RZ });
      await call("bot_give", { item: "minecraft:bow", count: 1 });
      await call("bot_give", { item: "minecraft:arrow", count: 8 });
      const nope = await call("bot_body", { action: "load" });
      assert.equal(nope.ok, false, JSON.stringify(nope));
      assert.equal(nope.reason, "no_weapon", JSON.stringify(nope));
      assert.match(String(nope.note ?? ""), /bow cannot be pre-loaded/i,
        `the refusal must explain itself — a bow IS a ranged weapon and IS carried: `
        + `${JSON.stringify(nope)}`);
      await sweep();
    });

  test("9b/crossbow: a ranged fight winds it BY ITSELF between shots", async (t) => {
    if (!bridgeUp) return t.skip();
    // The automatic half, and the one §4.3 actually promises: the 25 ticks are paid out of the
    // shot rhythm, which is also the time the body spends walking to its station. Nobody calls
    // `load` here.
    const z = await stageRange(11);
    await freshBody({ x: RX, y: Y + 1, z: RZ });
    await call("bot_reactions", { action: "clear" });
    await call("bot_give", { item: "minecraft:crossbow", count: 1 });
    await call("bot_give", { item: "minecraft:arrow", count: 32 });

    const cur = await nowCursor();
    await call("bot_target", { action: "attack", target: { entity: z.id } });
    await call("bot_body", { action: "engage", mode: "fight", policy: "hold" });
    const wound = await waitEvent("crossbow_loaded", cur, 25000);
    await call("bot_body", { action: "engage", on: false, clear_targets: true });
    assert.ok(wound, "an engaged body with a crossbow must wind it between shots — the cooldown "
      + "covers a full draw and the legs are walking to a station, so those ticks are free");
    assert.match(String(wound.data?.why ?? ""), /between shots/i, JSON.stringify(wound));
    await sweep();
  });

  test("10/trident: an unreachable target is answered by a THROW, and the body says where the "
    + "trident came to rest", async (t) => {
      if (!bridgeUp) return t.skip();
      const z = await stageChasm();
      await freshBody({ x: PX - 6, y: Y + 1, z: PZ });
      // A SECOND WEAPON, deliberately: the disarm check (D2) refuses an automatic throw from a body
      // whose trident is its only weapon, and case 11 is that half. Here the trade is affordable.
      await call("bot_give", { item: "minecraft:stone_sword", count: 1 });
      await call("bot_give", { item: "minecraft:trident", count: 1 });

      const cur = await nowCursor();
      const g = await call("bot_target", { action: "attack", target: { entity: z.id } });
      assert.equal(g.started, true, JSON.stringify(g));

      // The hunt reaches the same conclusion for a trident as for a bow — the arsenal can reach
      // what the legs cannot — and says which arsenal.
      const switched = await waitEvent("attack_mode_changed", cur, 40000,
        (e) => e.data?.mode === "throw");
      assert.ok(switched, "a hunt that cannot walk to its target and carries a trident must THROW "
        + "it rather than dying target_unreachable");
      assert.match(String(switched.data?.why ?? ""), /trident/i, JSON.stringify(switched));

      // It really leaves the hand — a projectile, and the world answers for it.
      const landed = await waitEvent("shot_landed", cur, 30000);
      assert.ok(landed, `the throw must resolve: ${JSON.stringify(landed)}`);

      // D2'S ANSWER, and the reason a throw is allowed at all: a trident that is never mentioned
      // again is an item the body LOST; one whose resting place is named is an item the body left
      // somewhere. These coordinates are the difference.
      const rest = await waitEvent("trident_landed", cur, 30000);
      assert.ok(rest, "a thrown trident that comes to rest unannounced is exactly the silent loss "
        + "D2 was open about");
      for (const k of ["x", "y", "z"]) {
        assert.equal(typeof rest.data?.[k], "number",
          `trident_landed must carry ${k}: ${JSON.stringify(rest.data)}`);
      }
      assert.equal(rest.data?.loyalty, false,
        `a plain trident has no Loyalty and does not come home: ${JSON.stringify(rest.data)}`);

      const errand = await waitEvent("pickup_scheduled", cur, 10000);
      assert.ok(errand, "the pickup is SCHEDULED, not immediate — but it is scheduled");
      assert.equal(typeof errand.data?.x, "number", JSON.stringify(errand.data));
      // It landed on the FAR bank, which is the whole premise of this arena: the errand may be on
      // the books, but the legs still cannot get there. What matters is that the agent was TOLD
      // where — the half that does not depend on any walk succeeding. 10b walks the other half.
    });

  test("10b/trident: the body walks back for it once it has nothing else to do", async (t) => {
    if (!bridgeUp) return t.skip();
    // Flat ground this time, so the landing spot is somewhere the legs CAN reach — case 10 proves
    // the notification, this proves the errand. The pickup itself is vanilla's:
    // AbstractArrow.playerTouch puts a landed trident into the walker's inventory, so the errand is
    // a plain walk and there is no collect verb to diverge from what a real client does.
    const z = await stageRange(9);
    await freshBody({ x: RX, y: Y + 1, z: RZ });
    await call("bot_reactions", { action: "clear" });
    await call("bot_give", { item: "minecraft:stone_sword", count: 1 });
    await call("bot_give", { item: "minecraft:trident", count: 1 });

    const cur = await nowCursor();
    const thrown = await call("bot_shoot", { target: z.id, wait: true });
    assert.equal(thrown.ok, true, JSON.stringify(thrown));
    assert.equal(thrown.mode, "throw", JSON.stringify(thrown));
    assert.match(String(thrown.weapon ?? ""), /trident/, JSON.stringify(thrown));
    // The weapon LEFT: not an arrow count. Reporting `arrows_left: 0` for a good throw would read
    // as an empty quiver the body does not have.
    assert.equal(thrown.arrows_left, undefined,
      `a thrown weapon is not ammunition: ${JSON.stringify(thrown)}`);

    const gone = await call("bot_status", { inventory: true });
    assert.ok(!JSON.stringify(gone.inventory ?? {}).includes("trident"),
      `the trident is in the air, not the pack: ${JSON.stringify(gone.inventory)}`);

    // Nothing is asked of the body from here. The errand waits out Retrieve.SETTLE_TICKS of
    // genuine idleness (3s) and then walks; the whole point of "scheduled, not immediate" is that
    // it does NOT happen while there is a fight on.
    const got = await waitEvent("pickup_done", cur, 45000);
    assert.ok(got, "an idle body must go back for the weapon it threw — that is the half of D2 "
      + "that makes throwing a plain trident an affordable decision at all");
    assert.match(String(got.data?.item ?? ""), /trident/, JSON.stringify(got));

    const back = await call("bot_status", { inventory: true });
    assert.ok(JSON.stringify(back.inventory ?? {}).includes("trident"),
      `the event is not the fact — the trident must actually be in the pack again: `
      + `${JSON.stringify(back.inventory)}`);
    await sweep();
  });

  test("10c/trident: a LOYALTY trident flies home by itself — no landing, no errand", async (t) => {
    if (!bridgeUp) return t.skip();
    // The branch that would otherwise be unrun code, and it decides two things a plain trident's
    // case cannot reach. (1) A loyal trident sits IN THE GROUND for four ticks before
    // ThrownTrident.tick turns it for home — indistinguishable from coming to rest, so a watch that
    // called that "landed" would hand the agent coordinates for a weapon already on its way back.
    // (2) When it vanishes it was CAUGHT, not absorbed by something it struck: for an arrow "the
    // projectile is gone" means it hit, and for a trident it usually means the body has it again.
    const z = await stageRange(12);
    await freshBody({ x: RX, y: Y + 1, z: RZ });
    await call("bot_reactions", { action: "clear" });
    await call("bot_give", { item: "minecraft:stone_sword", count: 1 });
    // bot_give cannot enchant, so the trident is given plain, HELD, and enchanted in place —
    // /enchant acts on the mainhand, which is what makes the select load-bearing rather than tidy.
    const name = await bodyName();
    await call("bot_give", { item: "minecraft:trident", count: 1 });
    await call("bot_select", { item: "trident" });
    await cmd(`enchant ${name} minecraft:loyalty 3`);
    await sleep(600);

    const cur = await nowCursor();
    const thrown = await call("bot_shoot", { target: z.id, wait: true });
    assert.equal(thrown.ok, true, JSON.stringify(thrown));
    assert.equal(thrown.mode, "throw", JSON.stringify(thrown));

    const home = await waitEvent("trident_returned", cur, 20000);
    assert.ok(home, "Loyalty must be reported as a RETURN — a body that cannot tell 'my trident "
      + "came back' from 'my trident is gone' will re-arm for a fight it is already equipped for");
    assert.equal(home.data?.loyalty, true, JSON.stringify(home.data));

    // ...and NEITHER of the plain trident's two events fires. This is the half that catches the
    // four-tick ground pause being misread as a landing.
    const strayLanding = await call("get_events", { cursor: cur, type: "trident_landed", limit: 50 });
    assert.equal((strayLanding.events || []).length, 0,
      `a returning trident never "landed" anywhere: ${JSON.stringify(strayLanding.events)}`);
    const strayErrand = await call("get_events", { cursor: cur, type: "pickup_scheduled", limit: 50 });
    assert.equal((strayErrand.events || []).length, 0,
      `and there is nothing to fetch — an errand here would walk the body to a weapon it is `
      + `already carrying: ${JSON.stringify(strayErrand.events)}`);

    const back = await call("bot_status", { inventory: true });
    assert.ok(JSON.stringify(back.inventory ?? {}).includes("trident"),
      `vanilla's tryPickup puts it straight in the pack: ${JSON.stringify(back.inventory)}`);
    await sweep();
  });

  test("11/trident: the body will NOT throw away its only weapon, and says so", async (t) => {
    if (!bridgeUp) return t.skip();
    // The disarm check (D2). A trident is ATTACK_DAMAGE +8, so WeaponGate ranks it top of the melee
    // list — an automatic throw is therefore the body giving up its BEST weapon at the moment it
    // has decided it is in a fight, and "unreachable target" is the geometry with the best odds of
    // a second enemy that is not unreachable at all.
    const z = await stageChasm();
    await freshBody({ x: PX - 6, y: Y + 1, z: PZ });
    await call("bot_give", { item: "minecraft:trident", count: 1 });   // and NOTHING else

    const cur = await nowCursor();
    const g = await call("bot_target", { action: "attack", target: { entity: z.id } });
    assert.equal(g.started, true, JSON.stringify(g));

    const failed = await waitEvent("action_failed", cur, 45000,
      (e) => e.data?.action_id === g.action_id);
    assert.ok(failed, "the hunt must concede rather than disarm itself");
    assert.equal(failed.data?.reason, "target_unreachable", JSON.stringify(failed));
    assert.match(String(failed.data?.why ?? ""), /only weapon|bare-handed/i,
      `the refusal must name the DECISION, not the symptom: the capability is visibly in the pack, `
      + `so an agent told only "target_unreachable" would conclude the throw is unimplemented: `
      + `${JSON.stringify(failed.data)}`);
    const still = await call("bot_status", { inventory: true });
    assert.ok(JSON.stringify(still.inventory ?? {}).includes("trident"),
      `and the trident is still carried: ${JSON.stringify(still.inventory)}`);

    // ...but an EXPLICIT throw is honoured. The check guards a decision nobody made; a caller who
    // asked for the throw has already made this judgement, and overriding them would be the
    // toolkit second-guessing an instruction.
    const mine = await call("bot_shoot", { target: z.id, wait: true });
    assert.equal(mine.ok, true, JSON.stringify(mine));
    assert.equal(mine.mode, "throw", JSON.stringify(mine));

    // And the brake in the other direction: allow_throw:false keeps it in the hand, with a refusal
    // that is neither "no bow" nor "no arrows" — the body is fully capable and was told not to.
    await freshBody({ x: PX - 6, y: Y + 1, z: PZ });
    await call("bot_give", { item: "minecraft:trident", count: 1 });
    const kept = await call("bot_shoot", { target: z.id, allow_throw: false, wait: true });
    assert.equal(kept.ok, false, JSON.stringify(kept));
    assert.equal(kept.reason, "throw_not_allowed", JSON.stringify(kept));
    await sweep();
  });

  test("clean up the site", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "engage", on: false }).catch(() => {});
    await call("bot_reactions", { action: "clear" }).catch(() => {});
    await sweep();
    for (const [z0, z1] of BANDS) {
      await cmd(`fill ${X - 16} ${Y} ${z0} ${PX + 16} ${Y + 12} ${z1} minecraft:air`);
    }
    await cmd(`fill ${RX - 4} ${Y} ${RZ - 6} ${RX + 26} ${Y + 6} ${RZ + 6} minecraft:air`);
    await cmd(`fill ${SX - 6} ${Y} ${SZ - 6} ${SX + 6} ${Y + 6} ${SZ + 6} minecraft:air`);
    await cmd(`forceload remove ${X - 24} ${Z - 24} ${PX + 24} ${RZ + 12}`);
  });
});
