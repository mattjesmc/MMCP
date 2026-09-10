// Live probes for the survival increment — threats_nearby trigger + flee-to-vantage response.
// Reproduces the death the operator watched (drone overwhelmed by 3 zombies) and shows the fix.
//
//   1. flee mechanics: surrounded by a cluster, the flee response moves the body OFF the threat
//      centroid and (as a flyer) gains altitude — distance to the swarm grows and y rises.
//   2. survival: dropped into a real 3-zombie swarm and provoked, a threats_nearby→flee loadout
//      keeps the drone alive by breaking to an aerial vantage the ground mobs can't follow. The
//      swarm is provoked BEFORE the reflex is armed, one awaited swing at a time, and every hit is
//      asserted — see the note on that test.
//
// Staged at a probe-owned coordinate (3.65M). Own session. Run with `npm run test:live`.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const X = 3_650_000, Z = 3_650_000, Y = 200;
const SESSION = "probe-reflexes-6";
const ORIGIN = { x: X, y: Y + 2, z: Z };

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
const nowCursor = async () => (await call("get_events", { limit: 1 })).cursor;
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
async function zombies() {
  const r = await call("get_entities", { origin: ORIGIN, radius: 24 });
  return (r.entities || []).filter((e) => e.type === "minecraft:zombie");
}
function centroid(zs) {
  if (!zs.length) return null;
  const s = zs.reduce((a, e) => ({ x: a.x + e.pos.x, y: a.y + e.pos.y, z: a.z + e.pos.z }), { x: 0, y: 0, z: 0 });
  return { x: s.x / zs.length, y: s.y / zs.length, z: s.z / zs.length };
}
const hdist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const killZombies = () => cmd(`kill @e[type=minecraft:zombie,x=${X - 30},y=${Y - 4},z=${Z - 30},dx=60,dy=30,dz=60]`).catch(() => {});

/**
 * Land ONE real swing on ONE named zombie — the provocation the swarm test's premise rests on.
 *
 * bot_attack is no longer fire-and-forget (V3_PLAN.md §2 F1): a swing that needs a facing turn
 * returns {started, action_id, eta_ticks} and completes via events, and the NEWEST attack
 * SUPERSEDES the in-flight one ("the newest deliberate attack wins", DroneHands.botAttack). So the
 * swing is awaited with `wait`:true — the call returns the landing — and each zombie is provoked
 * in turn instead of three calls racing each other into one supersede chain (S9).
 *
 * The retry exists because these zombies have AI: an un-provoked one strolls, and a body that
 * strolled past the drone's 4-block entity reach answers out_of_reach. The drone flies, so it
 * closes on the target and swings again — a provocation that quietly gave up here is exactly the
 * silent-weakening this helper was written to end.
 */
// BOUNDED ON PURPOSE. Provocation runs with the flee reaction still disarmed (see the staging
// comment), so every second spent retrying here is a second the swarm beats an undefended 20 HP
// drone — and the test asserts health > 40% afterwards. A landing swing needs at most two turn
// ticks from a stationary body under the F1 gate, so a whole second is already generous; three
// zombies × 8 s of retries was 24 s of unanswered beating and would have failed the very
// assertion it precedes.
async function provoke(id) {
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    const r = await call("bot_attack", { target: id, wait: true }).catch(() => null);
    if (r && r.hit === true) {
      return true;
    }
    const z = (await zombies()).find((e) => e.id === id);
    if (!z) {
      return false; // gone: nothing left to provoke, and the caller should hear about it
    }
    await call("bot_goto", { to: { x: z.pos.x, y: z.pos.y + 2, z: z.pos.z }, wait: true })
      .catch(() => {});
  }
  return false;
}

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok).catch(() => false);
if (!bridgeUp) console.log(`\n  [skip] no bridge at ${BASE} — start the dev server\n`);

describe("survival: threats_nearby + flee-to-vantage vs a 3-zombie swarm", { skip: !bridgeUp }, () => {
  test("stage the site", async (t) => {
    if (!bridgeUp) return t.skip();
    await cmd(`forceload add ${X - 32} ${Z - 32} ${X + 32} ${Z + 32}`);
    await sleep(1500);
    await cmd(`fill ${X - 20} ${Y} ${Z - 20} ${X + 20} ${Y} ${Z + 20} minecraft:stone`);
    await cmd(`fill ${X - 20} ${Y + 1} ${Z - 20} ${X + 20} ${Y + 20} ${Z + 20} minecraft:air`);
    await sleep(400);
    await call("bot_reactions", { action: "clear" });
  });

  test("flee: breaks off the swarm centroid and gains altitude", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "spawn",  pos: ORIGIN });
    await killZombies();
    // A cluster around the drone.
    for (const [dx, dz] of [[-1, 0], [1, 0], [0, 1]]) {
      await cmd(`summon minecraft:zombie ${X + dx} ${Y + 2} ${Z + dz} {NoAI:1b,NoGravity:1b,PersistenceRequired:1b}`);
    }
    await sleep(500);
    const startPos = (await call("bot_status")).pos;
    const c0 = await nowCursor();
    await call("bot_reactions", {
      action: "arm",
      reactions: [{
        id: "flee",
        trigger: { kind: "threats_nearby", within: 8, count: 2 },
        response: { op: "flee", ticks: 20, speed: 0.6 },
        cooldown_ticks: 5,
      }],
    });
    const fired = await waitEvent("reaction_fired", c0, 5000, (e) => e.data.id === "flee");
    assert.ok(fired, "threats_nearby should fire the flee reaction when surrounded");
    await sleep(2500); // let the flee(s) carry it up and out
    const endPos = (await call("bot_status")).pos;
    const cen = centroid(await zombies());
    assert.ok(endPos.y - startPos.y >= 4, `flee should gain altitude, y ${startPos.y}→${endPos.y}`);
    if (cen) {
      assert.ok(hdist(endPos, cen) > hdist(startPos, cen) + 1,
        `flee should increase horizontal distance from the swarm (${hdist(startPos, cen).toFixed(1)}→${hdist(endPos, cen).toFixed(1)})`);
    }
    await call("bot_reactions", { action: "clear" });
    await killZombies();
  });

  test("survival: dropped into a provoked 3-zombie swarm, the drone lives by fleeing", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "spawn",  pos: ORIGIN });
    await call("bot_reactions", { action: "clear" });
    await killZombies();
    // THE HELMETS ARE LOAD-BEARING. This site is open sky at y=200, and a burning zombie takes a
    // fire tick every second — vanilla i-frames then REFUSE the next equal-or-smaller hit, so the
    // bare-handed swing that is supposed to provoke this swarm would land as hit:false about half
    // the time and the test would go back to measuring nothing. A non-empty HEAD slot suppresses
    // the ignition outright (Mob.burnUndead damages the helmet instead).
    //
    // A ring at TWO blocks rather than in contact. Provocation now precedes arming (below), so a
    // cluster spawned touching the drone spends that second beating it before the flee exists —
    // which would measure the drone's health bar, not the reflex. Two is the balance: `summon`
    // centre-corrects integers, so the swing distance is ~2.7 blocks (comfortably inside the
    // drone's 4-block entity reach, unlike a 3-ring's 3.7 with no room for a stroll), each zombie
    // still has ~1.5 blocks to walk before it can land a hit, and `within`:8 still sees all three.
    for (const [dx, dz] of [[-2, 0], [2, 0], [0, 2]]) {
      await cmd(`summon minecraft:zombie ${X + dx} ${Y + 1} ${Z + dz} `
        + `{PersistenceRequired:1b,equipment:{head:{id:"minecraft:iron_helmet",count:1}}}`);
    }
    await sleep(600);

    // PROVOKE FIRST, THEN ARM (S9). This loop used to be three back-to-back `bot_attack` calls
    // with the flee reaction ALREADY armed, and both halves of that stopped working under the F1
    // gate: each call now returns {started:true} and supersedes the previous one (so at most ONE
    // zombie was ever provoked), and an armed reflex owns the body, so the swing may never get its
    // turn ticks at all. The test kept PASSING regardless — its trigger is proximity, not anger —
    // i.e. it silently tested something weaker than its own premise. Now every swing is awaited to
    // its landing and ASSERTED, and the reflex is armed only once the swarm is genuinely hostile.
    const staged = await zombies();
    assert.equal(staged.length, 3, `three zombies must be staged: ${JSON.stringify(staged)}`);
    for (const z of staged) {
      assert.ok(await provoke(z.id),
        `every zombie must be hit — their revenge AI is what makes this a swarm ATTACK rather `
        + `than three idle mobs standing nearby (zombie ${z.id})`);
    }

    await call("bot_reactions", {
      action: "arm",
      reactions: [{
        id: "flee",
        trigger: { kind: "threats_nearby", within: 8, count: 2 },
        response: { op: "flee", ticks: 20, speed: 0.6 },
        priority: 20,
        cooldown_ticks: 6,
      }],
    });

    await sleep(6000);
    const st = await call("bot_status");
    assert.equal(st.spawned, true, "the drone should still be alive after the swarm");
    assert.ok(st.health > st.maxHealth * 0.4,
      `the drone should survive comfortably by fleeing, health ${st.health}/${st.maxHealth}`);
    assert.ok(st.pos.y - ORIGIN.y >= 4, `it should have escaped to an aerial vantage, y=${st.pos.y}`);
    await call("bot_reactions", { action: "clear" });
    await killZombies();
  });

  test("cleanup", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_reactions", { action: "clear" }).catch(() => {});
    await call("bot_body", { action: "despawn" }).catch(() => {});
    await killZombies();
    await cmd(`forceload remove ${X - 32} ${Z - 32} ${X + 32} ${Z + 32}`).catch(() => {});
  });
});
