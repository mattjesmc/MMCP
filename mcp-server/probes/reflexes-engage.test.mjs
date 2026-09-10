// Live probes for combat movement vs a real zombie. Engagement is now a body MODE
// (bot_body action:"engage") driven by the threat table (bot_target action:"attack"),
// not a base intent bound to one entity — see BOT_SURFACE_DESIGN.md §4.
//
//   1. kite station-keeping: engaging a stationary mob at range 6 backs the body off to ~6 blocks.
//   2. kite a REAL provoked zombie: after provoking it (bot_attack → it chases the drone), kiting
//      keeps the body out of melee — the min distance over the window stays up, and the body moves.
//   3. bot_status reflects the engage (policy/range); stop ends it.
//
// Staged at a probe-owned coordinate (3.6M). Own session. Run with `npm run test:live`.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const X = 3_600_000, Z = 3_600_000, Y = 200;
const SESSION = "probe-reflexes-5";
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
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

async function dronePos() { return (await call("bot_status")).pos; }
async function zombie() {
  const r = await call("get_entities", { origin: ORIGIN, radius: 24 });
  return (r.entities || []).find((e) => e.type === "minecraft:zombie");
}

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok).catch(() => false);
if (!bridgeUp) console.log(`\n  [skip] no bridge at ${BASE} — start the dev server\n`);

describe("engage mode: kite a real zombie", { skip: !bridgeUp }, () => {
  test("stage the site", async (t) => {
    if (!bridgeUp) return t.skip();
    await cmd(`forceload add ${X - 48} ${Z - 48} ${X + 48} ${Z + 48}`);
    await sleep(1500);
    await cmd(`fill ${X - 30} ${Y} ${Z - 30} ${X + 30} ${Y} ${Z + 30} minecraft:stone`);
    await cmd(`fill ${X - 30} ${Y + 1} ${Z - 30} ${X + 30} ${Y + 12} ${Z + 30} minecraft:air`);
    await sleep(400);
    await call("bot_reactions", { action: "clear" });
  });

  test("kite: engaging a stationary mob backs off to ~range", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "spawn",  pos: ORIGIN });
    // F4 (0.69.0): the stand range follows the weapon — kite at 6 needs a ranged one (band
    // [6, 20]); empty hands would clamp to the melee band and this test is about stationing at
    // distance, so the body fights like an archer.
    //
    // ARROWS TOO, since 0.72.0. "Ranged" no longer means "a bow is in the hand" but "the body
    // CARRIES a projectile weapon it can FEED" (CombatKit.rangedCapable) — a bow with an empty
    // quiver is not a capability, it is a stick that holds the body at 6 blocks doing nothing
    // while a zombie closes, which is a worse death than closing yourself. The case is unchanged
    // in what it tests; its loadout now stages an archer that could actually loose an arrow.
    await call("bot_give", { item: "minecraft:bow", count: 1 });
    await call("bot_give", { item: "minecraft:arrow", count: 16 });
    await call("bot_select", { item: "minecraft:bow" });
    await cmd(`kill @e[type=minecraft:zombie,x=${X - 30},y=${Y},z=${Z - 30},dx=60,dy=14,dz=60]`).catch(() => {});
    await cmd(`summon minecraft:zombie ${X + 2} ${Y + 1} ${Z} {NoAI:1b,PersistenceRequired:1b}`);
    await sleep(500);
    // A STANDING RULE ({kind}) is the designation-only form now — an individual `attack` became a
    // real hunt goal (w2 postmortem §1) and would fight Engage for the body in this test.
    const d0 = await call("bot_target", { action: "attack", target: { kind: "zombie" } });
    assert.equal(d0.designated, true, JSON.stringify(d0));
    assert.equal(d0.standing_rule, true, JSON.stringify(d0));
    assert.equal(d0.engaged, false, "designation alone must NOT arm combat");
    assert.match(d0.note ?? "", /combat mode is OFF/i, JSON.stringify(d0));
    const r = await call("bot_body", { action: "engage", mode: "fight", policy: "kite", range: 6 });
    assert.equal(r.engaged, true, JSON.stringify(r));
    const st = await call("bot_status");
    assert.equal(st.engage?.policy, "kite", JSON.stringify(st.engage));
    await sleep(4000); // let it fly out to the ring
    const d = dist(await dronePos(), (await zombie()).pos);
    assert.ok(d >= 4.5 && d <= 9, `kite should settle near range 6, got ${d.toFixed(2)}`);
    await call("bot_body", { action: "engage", on: false, clear_targets: true });
    await cmd(`kill @e[type=minecraft:zombie,x=${X - 30},y=${Y},z=${Z - 30},dx=60,dy=14,dz=60]`).catch(() => {});
  });

  test("kite a REAL provoked zombie keeps it out of melee", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "spawn",  pos: ORIGIN });
    // F4: kiting at distance is the RANGED weapon's fight now, and since 0.72.0 "ranged" means
    // carried AND feedable — arrows included (see the previous test).
    await call("bot_give", { item: "minecraft:bow", count: 1 });
    await call("bot_give", { item: "minecraft:arrow", count: 16 });
    await call("bot_select", { item: "minecraft:bow" });
    await cmd(`summon minecraft:zombie ${X + 3} ${Y + 1} ${Z} {PersistenceRequired:1b}`);
    await sleep(600);
    const z = await zombie();
    assert.ok(z, "a zombie should be present");
    // Provoke: hit it so its HurtByTargetGoal makes it chase the drone. F1: the swing may need a
    // facing turn first (wait:true rides it to the outcome; a miss is fine — provocation only).
    await call("bot_attack", { target: z.id, wait: true }).catch(() => {});
    // `engage: true` used to ride along here and is not a bot_target argument — it was silently
    // dropped, and the call below is what actually engaged. Caught by the 0.46.0 argument gate, in
    // the test suite of the tool the gate was written for. (Standing rule, not an individual: an
    // individual attack is a HUNT goal now, and this test is about Engage's kiting, not the hunt.)
    await call("bot_target", { action: "attack", target: { kind: "zombie" } });
    await call("bot_body", { action: "engage", mode: "fight", policy: "kite", range: 6 });

    let minD = Infinity;
    const start = await dronePos();
    let moved = 0;
    for (let i = 0; i < 8; i++) {
      await sleep(500);
      const dp = await dronePos();
      const zz = await zombie();
      if (!zz) break; // died somehow — fine
      minD = Math.min(minD, dist(dp, zz.pos));
      moved = Math.max(moved, dist(dp, start));
    }
    assert.ok(minD >= 2.5, `kiting should keep the zombie out of melee, min distance was ${minD.toFixed(2)}`);
    assert.ok(moved > 2, `the drone should have actively kited (moved), moved ${moved.toFixed(2)}`);
    await call("bot_body", { action: "engage", on: false, clear_targets: true });
    await cmd(`kill @e[type=minecraft:zombie,x=${X - 30},y=${Y},z=${Z - 30},dx=60,dy=14,dz=60]`).catch(() => {});
  });

  test("cleanup", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "engage", on: false, clear_targets: true }).catch(() => {});
    await call("bot_body", { action: "despawn" }).catch(() => {});
    await cmd(`forceload remove ${X - 48} ${Z - 48} ${X + 48} ${Z + 48}`).catch(() => {});
  });
});
