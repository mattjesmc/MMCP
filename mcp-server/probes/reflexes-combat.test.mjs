// Live probes for slice 3 — consumables + projectile reactions, exercised against REAL entities
// (a live arrow/fireball projectile and a real zombie), not just passive fixtures.
//
//   1. bot_eat: eating a golden apple applies its status effects to the body (Regeneration + Absorption).
//   2. projectile_incoming + deflect: a real arrow closing on the body fires the trigger; the deflect
//      response reverses it so it is no longer incoming.
//   3. attack reaction vs a real zombie: an armed attack-nearest reaction damages a live hostile mob.
//
// Staged at a probe-owned coordinate (3.59M). Forceloaded during the run; own session.
// Moved off 3.50M, which player-hands.test.mjs already owned: the battery runs probe files
// CONCURRENTLY, and this file's arena fill + live zombie were landing on that file's player body.
// Live probe: needs the dev server up. Run with `npm run test:live`.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const X = 3_590_000, Z = 3_590_000, Y = 200;
const SESSION = "probe-reflexes-3";
const ORIGIN = { x: X, y: Y + 2, z: Z };

async function callRaw(tool, args = {}) {
  const res = await fetch(`${BASE}/cmd`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-MCPTK-Session": SESSION },
    body: JSON.stringify({ tool, args }),
  });
  return res.json();
}
async function call(tool, args = {}) {
  const j = await callRaw(tool, args);
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
const entitiesOfType = async (type) => {
  const r = await call("get_entities", { origin: ORIGIN, radius: 24 });
  return (r.entities || []).filter((e) => e.type === type);
};

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok)
  .catch(() => false);
if (!bridgeUp) console.log(`\n  [skip] no bridge at ${BASE} — start the dev server\n`);

describe("reflexes combat: consumables + projectile reactions vs real entities", { skip: !bridgeUp }, () => {
  test("stage the site", async (t) => {
    if (!bridgeUp) return t.skip();
    await cmd(`forceload add ${X - 32} ${Z - 32} ${X + 32} ${Z + 32}`);
    await sleep(1500);
    await cmd(`fill ${X - 20} ${Y} ${Z - 20} ${X + 20} ${Y} ${Z + 20} minecraft:stone`);
    await cmd(`fill ${X - 20} ${Y + 1} ${Z - 20} ${X + 20} ${Y + 12} ${Z + 20} minecraft:air`);
    await sleep(400);
    await call("bot_reactions", { action: "clear" });
  });

  test("bot_eat: a golden apple applies Regeneration + Absorption to the body", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "spawn",  pos: ORIGIN });
    await call("bot_give", { item: "minecraft:golden_apple", count: 1 });
    const r = await call("bot_eat", { item: "minecraft:golden_apple" });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(r.effect_count > 0, `eating should apply effects: ${JSON.stringify(r)}`);
    assert.ok((r.effects || []).some((e) => e.includes("regeneration")),
      `golden apple grants regeneration: ${JSON.stringify(r.effects)}`);
    assert.ok(r.absorption > 0, `golden apple grants absorption hearts: ${JSON.stringify(r)}`);
    await call("bot_reactions", { action: "clear" });
  });

  test("projectile_incoming + deflect: a real arrow closing on the body is reversed", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "spawn",  pos: ORIGIN });
    await call("bot_reactions", {
      action: "arm",
      reactions: [{
        id: "deflect",
        trigger: { kind: "projectile_incoming", within: 8 },
        response: { op: "deflect" },
        cooldown_ticks: 5,
      }],
    });
    const c0 = await nowCursor();
    // A real arrow entity drifting toward the drone (−X), slow enough to observe.
    await cmd(`summon minecraft:arrow ${X + 5} ${Y + 2} ${Z} {Motion:[-0.3d,0.0d,0.0d]}`);
    const fired = await waitEvent("reaction_fired", c0, 6000, (e) => e.data.id === "deflect");
    assert.ok(fired, "projectile_incoming should fire on the arrow");
    assert.equal(fired.data.response_op, "deflect", JSON.stringify(fired.data));
    const done = await waitEvent("reaction_done", fired.id - 1, 4000, (e) => e.data.id === "deflect");
    assert.ok(done, "expected reaction_done for deflect");
    assert.equal(done.data.ok, true, `deflect should act on the projectile: ${JSON.stringify(done.data)}`);
    // After the reverse, any surviving arrow is no longer closing on the body (moving +X, away).
    const arrows = await entitiesOfType("minecraft:arrow");
    for (const arr of arrows) {
      if (arr.velocity) assert.ok(arr.velocity.x >= 0, `deflected arrow should move away (+X): ${JSON.stringify(arr.velocity)}`);
    }
    await call("bot_reactions", { action: "clear" });
    await cmd(`kill @e[type=minecraft:arrow,x=${X - 20},y=${Y},z=${Z - 20},dx=40,dy=14,dz=40]`).catch(() => {});
  });

  test("attack reaction damages a real zombie", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "spawn",  pos: ORIGIN });
    await cmd(`summon minecraft:zombie ${X + 1} ${Y + 2} ${Z} {NoAI:1b,NoGravity:1b,PersistenceRequired:1b}`);
    await sleep(500);
    const before = (await entitiesOfType("minecraft:zombie"))[0];
    assert.ok(before, "a zombie should be present");
    await call("bot_reactions", {
      action: "arm",
      reactions: [{
        id: "smite",
        trigger: { kind: "health_below", hearts: 1000 },
        response: { op: "attack", nearest: true },
        cooldown_ticks: 8,
      }],
    });
    // Let the reaction land several hits.
    await sleep(3000);
    const after = (await entitiesOfType("minecraft:zombie"))[0];
    // Either the zombie took damage, or it was killed outright (both prove real-mob hits landed).
    const killed = !after;
    assert.ok(killed || after.health < before.health,
      `zombie should be damaged by the attack reaction: before=${before.health} after=${after?.health}`);
    await call("bot_reactions", { action: "clear" });
    await cmd(`kill @e[type=minecraft:zombie,x=${X - 4},y=${Y},z=${Z - 4},dx=8,dy=6,dz=8]`).catch(() => {});
  });

  test("cleanup", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_reactions", { action: "clear" }).catch(() => {});
    await call("bot_body", { action: "despawn" }).catch(() => {});
    await cmd(`forceload remove ${X - 32} ${Z - 32} ${X + 32} ${Z + 32}`).catch(() => {});
  });
});
