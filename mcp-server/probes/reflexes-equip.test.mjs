// Live probes for slice 4 — equipment + the shield reflex response.
//
//   1. bot_equip: equipping diamond armor from inventory raises the body's armor value; a weapon and
//      shield move into the hand slots.
//   2. shield reflex: a projectile_incoming→shield reaction fires against a real arrow and raises the
//      off-hand shield (ok:true).
//
// Staged at a probe-owned coordinate (3.55M). Own session. Run with `npm run test:live`.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const X = 3_550_000, Z = 3_550_000, Y = 200;
const SESSION = "probe-reflexes-4";
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

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok).catch(() => false);
if (!bridgeUp) console.log(`\n  [skip] no bridge at ${BASE} — start the dev server\n`);

describe("reflexes equipment: bot_equip + shield response", { skip: !bridgeUp }, () => {
  test("stage the site", async (t) => {
    if (!bridgeUp) return t.skip();
    await cmd(`forceload add ${X - 32} ${Z - 32} ${X + 32} ${Z + 32}`);
    await sleep(1500);
    await cmd(`fill ${X - 20} ${Y} ${Z - 20} ${X + 20} ${Y} ${Z + 20} minecraft:stone`);
    await cmd(`fill ${X - 20} ${Y + 1} ${Z - 20} ${X + 20} ${Y + 12} ${Z + 20} minecraft:air`);
    await sleep(400);
    await call("bot_reactions", { action: "clear" });
  });

  test("bot_equip: diamond armor raises armor value; hands take weapon + shield", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "spawn",  pos: ORIGIN });
    for (const it of ["diamond_helmet", "diamond_chestplate", "diamond_leggings", "diamond_boots",
                      "diamond_sword", "shield"]) {
      await call("bot_give", { item: `minecraft:${it}`, count: 1 });
    }
    const r = await call("bot_equip", {
      head: "minecraft:diamond_helmet", chest: "minecraft:diamond_chestplate",
      legs: "minecraft:diamond_leggings", feet: "minecraft:diamond_boots",
      mainhand: "minecraft:diamond_sword", offhand: "minecraft:shield",
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(!r.item_missing, `everything should have been in inventory: ${JSON.stringify(r.item_missing)}`);
    assert.equal(r.equipped.offhand, "minecraft:shield", JSON.stringify(r.equipped));
    // Equipment attribute modifiers settle on the next tick — read the value from bot_status.
    await sleep(300);
    const st = await call("bot_status");
    assert.ok(st.armor > 0, `equipped diamond armor should raise the body's armor value: ${JSON.stringify(st)}`);
    await call("bot_reactions", { action: "clear" });
  });

  test("shield reflex: projectile_incoming raises the off-hand shield", async (t) => {
    if (!bridgeUp) return t.skip();
    // Drone still wears the shield from the previous test.
    await call("bot_reactions", {
      action: "arm",
      reactions: [{
        id: "block",
        trigger: { kind: "projectile_incoming", within: 8 },
        response: { op: "shield", ticks: 15 },
        cooldown_ticks: 5,
      }],
    });
    const c0 = await nowCursor();
    await cmd(`summon minecraft:arrow ${X + 5} ${Y + 2} ${Z} {Motion:[-0.3d,0.0d,0.0d]}`);
    const fired = await waitEvent("reaction_fired", c0, 6000, (e) => e.data.id === "block");
    assert.ok(fired, "projectile_incoming should fire the shield reaction");
    assert.equal(fired.data.response_op, "shield", JSON.stringify(fired.data));
    const done = await waitEvent("reaction_done", fired.id - 1, 4000, (e) => e.data.id === "block");
    assert.ok(done, "expected reaction_done for the shield hold");
    assert.equal(done.data.ok, true, `the shield should have been raised (drone wears one): ${JSON.stringify(done.data)}`);
    await call("bot_reactions", { action: "clear" });
    await cmd(`kill @e[type=minecraft:arrow,x=${X - 20},y=${Y},z=${Z - 20},dx=40,dy=14,dz=40]`).catch(() => {});
  });

  test("cleanup", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_reactions", { action: "clear" }).catch(() => {});
    await call("bot_body", { action: "despawn" }).catch(() => {});
    await cmd(`forceload remove ${X - 32} ${Z - 32} ${X + 32} ${Z + 32}`).catch(() => {});
  });
});
