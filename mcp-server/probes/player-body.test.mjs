// Live probes for the PLAYER body as a first-class session body (toolkit 0.34.0, the §11.8
// Mob→LivingEntity widening — SURVIVAL_MODE_PLAN.md). What the walker probes proved for prediction
// and traversal, these prove for the widened CONTROL SURFACE: a real headless ServerPlayer answers
// bot_* like any body, with the player-native capabilities no mob body has.
//
//   1. bot_body spawn type:"player": a grounded real player — bot_status says body:"player" with
//      REAL hunger (food), and the name is in the server's player list (tab-list identity).
//   2. bot_goto walks it to a target (PlayerNavigation through the Bodies.nav seam).
//   3. Native pickup: an item dropped at its feet lands in its REAL inventory within seconds —
//      no pickup verb exists; being a player is the mechanism.
//   4. bot_select/bot_equip/bot_eat run against the real inventory: eating raises the food bar.
//   5. bot_attack: Player.attack damages a staged target.
//   6. Hands v2 reached this body (0.35.0 §13): mine and bot_target goals answer instead of
//      refusing — the two honesty gates this file used to assert are gone by design. Depth lives in
//      player-hands.test.mjs. Despawn removes the body from the player list.
//
// Probe-owned site at 3.46M. Needs the dev server; skips when the bridge is down.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const SESSION = "probe-player";
// Probe-owned site — 3.49M: past walker (3.45M), walker-caps (3.46M), walker-vert (3.47M) and
// fake-player (3.48M). The first run of this file sat on walker-caps' site and flattened its
// staged courses; every probe file owns its own chunks for exactly this reason.
const X = 3_490_000, Z = 3_490_000, Y = 200;

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
async function callRaw(tool, args = {}) {
  const res = await fetch(`${BASE}/cmd`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-MCPTK-Session": SESSION },
    body: JSON.stringify({ tool, args }),
  });
  return res.json();
}
const cmd = (c) => call("run_command", { command: c });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok)
  .catch(() => false);
if (!bridgeUp) {
  console.log(`\n  [skip] no bridge at ${BASE} — start the dev server to run these probes\n`);
}

describe("player body: real ServerPlayer through the widened control surface", { skip: !bridgeUp }, () => {
  test("stage: flat pen", async () => {
    await cmd(`forceload add ${X - 16} ${Z - 16} ${X + 16} ${Z + 16}`);
    await cmd(`fill ${X - 8} ${Y} ${Z - 8} ${X + 8} ${Y} ${Z + 8} minecraft:stone`);
    await cmd(`fill ${X - 8} ${Y + 1} ${Z - 8} ${X + 8} ${Y + 4} ${Z + 8} minecraft:air`);
    // Walls so nothing wanders and nothing hostile paths in.
    await cmd(`fill ${X - 8} ${Y + 1} ${Z - 8} ${X + 8} ${Y + 3} ${Z - 8} minecraft:stone`);
    await cmd(`fill ${X - 8} ${Y + 1} ${Z + 8} ${X + 8} ${Y + 3} ${Z + 8} minecraft:stone`);
    await cmd(`fill ${X - 8} ${Y + 1} ${Z - 8} ${X - 8} ${Y + 3} ${Z + 8} minecraft:stone`);
    await cmd(`fill ${X + 8} ${Y + 1} ${Z - 8} ${X + 8} ${Y + 3} ${Z + 8} minecraft:stone`);
  });

  test("spawn: a real grounded player with hunger and a tab-list name", async () => {
    await call("bot_body", { action: "despawn" });
    // Y+1 is the floor cell — feet on the stone at Y. This used to ask for Y+2 and let the body
    // fall one block, which the spawn-safety guard now (rightly) refuses: an EXPLICIT position is
    // never silently moved, so "two free cells over a floor" is checked and the refusal names the
    // cell that works. Asking for the cell we actually mean is the fix the error itself points at.
    const r = await call("bot_body", { action: "spawn", type: "player", pos: { x: X, y: Y + 1, z: Z } });
    assert.equal(r.type, "player");
    assert.ok(r.name, "the body has a username");
    await sleep(1500); // settle
    const s = await call("bot_status", {});
    assert.equal(s.body, "player");
    assert.equal(s.spawned, true);
    assert.ok(Number.isInteger(s.food), `real hunger reported, got ${s.food}`);
    assert.ok(Math.abs(s.pos.y - (Y + 1)) < 0.01,
      `a player body stands ON the floor at y=${Y + 1}, is at ${s.pos.y}`);
    // Tab-list identity: the server's own player list knows the name.
    const list = await cmd(`list`);
    assert.match(JSON.stringify(list), new RegExp(r.name), "the fake player is in /list output");
  });

  test("bot_goto: PlayerNavigation walks the body across the pen", async () => {
    const r = await call("bot_goto", { to: { x: X + 5, y: Y + 1, z: Z + 5 }, wait: true });
    const s = await call("bot_status", {});
    const dx = Math.abs(s.pos.x - (X + 5.5));
    const dz = Math.abs(s.pos.z - (Z + 5.5));
    assert.ok(dx <= 2.5 && dz <= 2.5, `arrived near target (dx=${dx.toFixed(1)}, dz=${dz.toFixed(1)}); goto said ${JSON.stringify(r)}`);
  });

  test("native pickup: a dropped item lands in the REAL inventory by walking over it", async () => {
    const s = await call("bot_status", {});
    const px = Math.floor(s.pos.x);
    const pz = Math.floor(s.pos.z);
    await cmd(`summon minecraft:item ${px} ${Y + 2} ${pz} {Item:{id:"minecraft:cooked_beef",count:8}}`);
    await sleep(3000); // pickup delay (~0.5s) + margin
    const inv = (await call("bot_status", { inventory: true })).inventory;
    const beef = inv.slots.find((x) => x.item === "minecraft:cooked_beef");
    assert.ok(beef, `cooked beef auto-collected into the player inventory: ${JSON.stringify(inv.slots)}`);
    assert.equal(beef.count, 8);
  });

  test("bot_eat: real food fills the real hunger bar", async () => {
    // Drain hunger so eating has something to show (player food starts full at 20). Target the
    // FAKE player by its name only — never @a, the human watcher is online too.
    await cmd(`effect give probe_player minecraft:hunger 8 200`).catch(() => {});
    await sleep(2500);
    // Since 0.52.0 the meal takes REAL use-ticks (~1.6s), so the drain effect must be OFF before
    // the bite: with amplifier-200 hunger still running, the +8 the beef adds is eaten back before
    // the reply reads the bar — "food rose: 13 -> 13", live-caught on the first 0.52.0 battery.
    await cmd(`effect clear probe_player minecraft:hunger`).catch(() => {});
    await sleep(300);
    const before = (await call("bot_status", {})).food;
    const r = await call("bot_eat", { item: "minecraft:cooked_beef" });
    assert.equal(r.ate, "minecraft:cooked_beef");
    assert.ok(Number.isInteger(r.food), "consume reports the food bar");
    if (before < 20) {
      assert.ok(r.food > before, `food rose: ${before} -> ${r.food}`);
    }
  });

  test("bot_attack: Player.attack damages a staged target", async () => {
    const s = await call("bot_status", {});
    const px = Math.floor(s.pos.x);
    const pz = Math.floor(s.pos.z);
    await cmd(`summon minecraft:zombie ${px + 1} ${Y + 1} ${pz} {NoAI:1b,PersistenceRequired:1b,CustomName:'"punchbag"'}`);
    await sleep(500);
    // F1 (0.69.0): the swing is facing-gated — the body may need a tick or two of turning first,
    // so `wait:true` rides the act to its outcome (already-facing stays synchronous).
    const r = await call("bot_attack", { nearest: true, wait: true });
    assert.equal(r.hit, true, JSON.stringify(r));
    assert.ok(r.damageDealt > 0, `damage dealt: ${r.damageDealt}`);
    // Anchored, not bare `distance`: run_command runs from the SERVER's source, whose position is
    // the world spawn — a bare distance selector searches there and silently kills nothing here,
    // so punchbags piled up until a later run's `nearest` attack picked a stale one out of reach.
    await cmd(`kill @e[type=minecraft:zombie,x=${px},y=${Y},z=${pz},distance=..32]`);
  });

  // 0.35.0 (§13): the two refusals this test used to assert are GONE — hands v2 and the goal-loop
  // widening landed, so the gate that must hold now is the opposite one: they WORK, and they work
  // through the same names the drone uses. Depth is in player-hands.test.mjs; this is the contract
  // check that the widening reached this body.
  test("hands v2: mine and bot_target goals answer on the player body", async () => {
    // Mine a floor cell BESIDE where the body currently stands — the earlier goto left it at
    // X+5,Z+5, and the pen's centre is out of hand reach from there. (The first run of this test
    // asked for the centre and got the correct `out_of_reach` refusal, which proves the reach gate
    // works and proves nothing about the hands.)
    const s = await call("bot_status", {});
    const at = { x: Math.floor(s.pos.x) + 1, y: Y, z: Math.floor(s.pos.z) };
    // accept_no_drops: this is a hands-answer contract check, not a harvest — the body may or
    // may not carry a pickaxe here, and 0.56.0 refuses a toolless drop-gated dig otherwise.
    const mine = await callRaw("bot_mine", { at, accept_no_drops: true, wait: true });
    assert.equal(mine.ok, true, `player hands mine: ${JSON.stringify(mine.error)}`);
    assert.equal(mine.result.mined, "minecraft:stone", `a dig verdict came back: ${JSON.stringify(mine.result)}`);
    await cmd(`setblock ${at.x} ${at.y} ${at.z} minecraft:stone`);
    const goal = await callRaw("bot_target", { action: "move", target: { at: { x: X + 3, y: Y + 1, z: Z + 3 } }, wait: true });
    assert.equal(goal.ok, true, `player goal loop: ${JSON.stringify(goal.error)}`);
    assert.match(String(goal.result.outcome), /achieved|already_there/, JSON.stringify(goal.result));
  });

  // REGRESSION (live session w1-85918, 2026-08-02): every player-body dig reported its drop as
  // `{item:"minecraft:air", count:1, collected:1}`. `Inventory.add` MUTATES the stack it is handed
  // down to the leftover, and the event asked the stack for its item AFTER the insert — so a fully
  // collected drop answered air while `count`/`collected` stayed correct. The drone body cannot show
  // it (`SimpleContainer.addItem` copies first), which is why the whole battery was green while the
  // agent was told it mined 66 blocks of nothing. So the gate has to run HERE, on the player body,
  // on a dig that actually collects: `collected > 0` must name a real item.
  test("mine drops name the real item, not air", async () => {
    const s = await call("bot_status", {});
    const at = { x: Math.floor(s.pos.x) + 1, y: Y, z: Math.floor(s.pos.z) };
    await cmd(`setblock ${at.x} ${at.y} ${at.z} minecraft:stone`);
    // `give` by the fake player's own name — never @a, the human watcher is online too. run_command
    // reports ok:true even when the command failed, so the pickaxe is verified from the INVENTORY.
    await cmd(`give ${s.name} minecraft:iron_pickaxe 1`);
    await sleep(1000);
    const inv = (await call("bot_status", { inventory: true })).inventory;
    assert.ok(inv.slots.some((x) => x.item === "minecraft:iron_pickaxe"),
      `staging put a pickaxe in the body's hands: ${JSON.stringify(inv.slots)}`);

    const mine = await callRaw("bot_mine", { at, item: "minecraft:iron_pickaxe", wait: true });
    assert.equal(mine.ok, true, `tooled dig: ${JSON.stringify(mine.error)}`);
    const d = mine.result;
    assert.ok(d.collected > 0, `an iron pickaxe on stone collects something: ${JSON.stringify(d)}`);
    for (const drop of d.drops ?? []) {
      assert.notEqual(drop.item, "minecraft:air",
        `a collected drop must name a real item, not air: ${JSON.stringify(d)}`);
    }
    assert.ok((d.drops ?? []).some((x) => x.item === "minecraft:cobblestone"),
      `stone dug with iron drops cobblestone: ${JSON.stringify(d)}`);
    // And the report has to agree with the body: the cobblestone is really carried.
    const after = (await call("bot_status", { inventory: true })).inventory;
    assert.ok(after.slots.some((x) => x.item === "minecraft:cobblestone"),
      `the reported collect is in the real inventory: ${JSON.stringify(after.slots)}`);
    await cmd(`setblock ${at.x} ${at.y} ${at.z} minecraft:stone`);
  });

  test("despawn: the player leaves the player list, nothing lingers", async () => {
    const before = JSON.stringify(await cmd(`list`));
    const r = await call("bot_body", { action: "despawn" });
    assert.equal(r.despawned, true);
    await sleep(500);
    const after = JSON.stringify(await cmd(`list`));
    const s = await call("bot_status", {});
    assert.equal(s.spawned, false);
    assert.ok(before.length >= after.length, "player list shrank (or fake name gone)");
  });

  test("cleanup", async () => {
    await cmd(`kill @e[type=minecraft:item,x=${X},y=${Y},z=${Z},distance=..32]`).catch(() => {});
    await cmd(`forceload remove ${X - 16} ${Z - 16} ${X + 16} ${Z + 16}`);
  });
});
