// Live probes for ranged combat — bot_shoot and the shoot reflex response, vs a real zombie at range.
//
//   1. bot_shoot: fires an arrow at a distant zombie (no reach limit) and damages it; consumes an arrow.
//   2. shoot reflex: threats_nearby→shoot fires at the nearest hostile and whittles it down.
//   3. the same reflex on a PLAYER body, where the shot is a real multi-tick DRAW and the reaction
//      has to hold the body through it (toolkit 0.73.0).
//
// Cases 1 and 2 run on the DRONE, and deliberately stay there: BowItem.releaseUsing begins
// `if (entity instanceof Player)`, so a bow cannot be fired from a drone at all and its shot is a
// launched arrow — the same body asymmetry the dig gate and WeaponGate have.
//
// Staged at a probe-owned coordinate (3.8M). Own session. Run with `npm run test:live`.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const X = 3_800_000, Z = 3_800_000, Y = 200;
const SESSION = "probe-ranged";
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
async function zombie() {
  const r = await call("get_entities", { origin: ORIGIN, radius: 24 });
  return (r.entities || []).find((e) => e.type === "minecraft:zombie");
}
const killZombies = () => cmd(`kill @e[type=minecraft:zombie,x=${X - 30},y=${Y - 4},z=${Z - 30},dx=60,dy=20,dz=60]`).catch(() => {});
// Idempotency, the entity arity: repeated runs litter the site with dropped arrows (every body
// despawn drops its inventory; every kill drops the zombie's), and get_entities pages at 50
// nearest — enough litter and the zombie falls off the page, so zombie() reads undefined. Caught
// live 2026-08-08 after three same-day runs. Same doctrine as clearBox, for entities.
const killLitter = () => cmd(`kill @e[type=minecraft:item,x=${X - 30},y=${Y - 4},z=${Z - 30},dx=60,dy=20,dz=60]`).catch(() => {});

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok).catch(() => false);
if (!bridgeUp) console.log(`\n  [skip] no bridge at ${BASE} — start the dev server\n`);

describe("ranged: bot_shoot + shoot reflex vs a real zombie", { skip: !bridgeUp }, () => {
  test("stage the site", async (t) => {
    if (!bridgeUp) return t.skip();
    await cmd(`forceload add ${X - 32} ${Z - 32} ${X + 32} ${Z + 32}`);
    await sleep(1500);
    await cmd(`fill ${X - 20} ${Y} ${Z - 20} ${X + 20} ${Y} ${Z + 20} minecraft:stone`);
    await cmd(`fill ${X - 20} ${Y + 1} ${Z - 20} ${X + 20} ${Y + 12} ${Z + 20} minecraft:air`);
    await sleep(400);
    await killLitter();
    await call("bot_reactions", { action: "clear" });
  });

  test("bot_shoot damages a zombie at range and consumes an arrow", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "spawn",  pos: ORIGIN });
    await killZombies();
    await call("bot_give", { item: "minecraft:arrow", count: 16 });
    await cmd(`summon minecraft:zombie ${X + 8} ${Y + 1} ${Z} {NoAI:1b,PersistenceRequired:1b}`);
    await sleep(500);
    const before = (await zombie()).health;
    const shot = await call("bot_shoot", { target: (await zombie()).id });
    assert.equal(shot.ok, true, JSON.stringify(shot));
    assert.ok(Number.isInteger(shot.arrow_id), `should report the arrow entity: ${JSON.stringify(shot)}`);
    assert.equal(shot.arrows_left, 15, `one arrow consumed: ${JSON.stringify(shot)}`);
    // A couple more to be sure at least one connects through the small spread.
    await call("bot_shoot", { target: (await zombie()).id }).catch(() => {});
    await call("bot_shoot", { target: (await zombie()).id }).catch(() => {});
    await sleep(1200);
    const z = await zombie();
    assert.ok(!z || z.health < before, `the zombie should take arrow damage: before=${before} after=${z?.health}`);
    await killZombies();
  });

  test("shoot reflex: threats_nearby→shoot whittles the nearest hostile", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "spawn",  pos: ORIGIN });
    await killZombies();
    await call("bot_give", { item: "minecraft:arrow", count: 32 });
    await call("bot_reactions", {
      action: "arm",
      reactions: [{
        id: "snipe",
        trigger: { kind: "threats_nearby", within: 16, count: 1 },
        response: { op: "shoot", nearest: true },
        cooldown_ticks: 10,
      }],
    });
    await cmd(`summon minecraft:zombie ${X + 8} ${Y + 1} ${Z} {NoAI:1b,PersistenceRequired:1b}`);
    const before = (await zombie()).health;
    await sleep(6000); // let the reflex loose several arrows
    const z = await zombie();
    const killed = !z;
    assert.ok(killed || z.health < before - 2,
      `the shoot reflex should damage the zombie over time: before=${before} after=${z?.health}`);
    await call("bot_reactions", { action: "clear" });
    await killZombies();
  });

  test("shoot reflex on a PLAYER body: the reaction holds the body through a real draw", async (t) => {
    if (!bridgeUp) return t.skip();
    // The drone's shot is instant; a player's is a DRAW (toolkit 0.73.0), so the reflex op had to
    // grow the pending/ticksLeft shape `eat`/`drink` already have. Without it the reaction reports
    // "done" on the tick the body STARTED aiming, hands the body back, and whatever claims it next
    // cancels the draw the reflex had just announced — a reflex that fires 20 times a second and
    // never looses an arrow. This case is the difference, and the drone case above cannot see it.
    await call("bot_reactions", { action: "clear" });
    await killZombies();
    await killLitter();
    await call("bot_body", { action: "spawn", type: "player", pos: ORIGIN });
    await call("bot_give", { item: "minecraft:bow", count: 1 });
    await call("bot_give", { item: "minecraft:arrow", count: 32 });
    await call("bot_reactions", {
      action: "arm",
      reactions: [{
        id: "snipe",
        trigger: { kind: "threats_nearby", within: 16, count: 1 },
        response: { op: "shoot", nearest: true },
        cooldown_ticks: 10,
      }],
    });
    await cmd(`summon minecraft:zombie ${X + 8} ${Y + 1} ${Z} {NoAI:1b,PersistenceRequired:1b}`);
    await sleep(600);
    const before = (await zombie())?.health;
    assert.ok(before, "staged zombie present");
    await sleep(9000); // several aim+draw+release cycles at ~1.5s each
    const z = await zombie();
    assert.ok(!z || z.health < before,
      `the shoot reflex must actually loose arrows from a player body: before=${before} `
      + `after=${z?.health}`);
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
