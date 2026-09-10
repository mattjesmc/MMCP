// Live probes for the ATTACK GOAL (W2_POSTMORTEM_FIXES.md §1) — `bot_target action:"attack"` is a
// real goal now: it approaches, swings on rhythm, and COMPLETES (w2-79881's attack designated a
// table row, orphaned its waiter, and the body stood still being shot for the full tool timeout).
//
//   1. hunt: an individual attack closes to reach, swings, and returns achieved with the kill.
//   2. honest concession: an unreachable target completes target_unreachable/gave_up — never hangs.
//   3. standing rule: a {kind} attack arms and returns immediately (it is an arm, not an act).
//   4. engage honesty: policy/range are refused in defend mode (dead knobs are not echoed).
//
// Staged at a probe-owned coordinate (3.82M). Own session. Run with `npm run test:live`.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const X = 3_820_000, Z = 3_820_000, Y = 200;
const SESSION = "probe-attack-goal";
const ORIGIN = { x: X, y: Y + 1, z: Z };

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
// The zombie STAGED here, not any zombie: the site is a platform in a survival save, and a natural
// spawn inside the 32-block radius is what made case 2 red once at 0.128.0 and once at 0.132.0 (a
// full-health zombie 17.8 blocks SW, found by a `find` that took the first of the type while the
// staged one was already dead - `sequential-0.63.0.attack-goal.tap.txt`). Scoped by where it was
// summoned, and by id once it has one.
async function zombie(at = { x: X + 7, z: Z }) {
  const r = await call("get_entities", { origin: ORIGIN, radius: 32 });
  return (r.entities || []).filter((e) => e.type === "minecraft:zombie")
    .find((e) => Math.abs(e.pos.x - (at.x + 0.5)) < 2 && Math.abs(e.pos.z - (at.z + 0.5)) < 2);
}
async function alive(id) {
  const r = await call("get_entities", { origin: ORIGIN, radius: 32 });
  return (r.entities || []).find((e) => e.id === id);
}
const killZombies = () => cmd(`kill @e[type=minecraft:zombie,x=${X - 40},y=${Y - 6},z=${Z - 40},dx=80,dy=30,dz=80]`).catch(() => {});

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok).catch(() => false);
if (!bridgeUp) console.log(`\n  [skip] no bridge at ${BASE} — start the dev server\n`);

describe("attack goal: hunt, concede, standing rule, engage honesty", { skip: !bridgeUp }, () => {
  test("stage the site", async (t) => {
    if (!bridgeUp) return t.skip();
    await cmd(`forceload add ${X - 32} ${Z - 32} ${X + 32} ${Z + 32}`);
    await sleep(1500);
    await cmd(`fill ${X - 24} ${Y} ${Z - 24} ${X + 24} ${Y} ${Z + 24} minecraft:stone`);
    await cmd(`fill ${X - 24} ${Y + 1} ${Z - 24} ${X + 24} ${Y + 8} ${Z + 24} minecraft:air`);
    await sleep(400);
    await call("bot_reactions", { action: "clear" });
    await killZombies();
  });

  test("an individual attack hunts: approach + swings + achieved on the kill", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "spawn", type: "player", pos: ORIGIN });
    await call("bot_give", { item: "minecraft:iron_sword", count: 1 });
    await call("bot_select", { item: "iron_sword" });
    await cmd(`summon minecraft:zombie ${X + 7} ${Y + 1} ${Z} {NoAI:1b,PersistenceRequired:1b}`);
    await sleep(500);
    const target = await zombie();
    assert.ok(target, "staged zombie present");
    const r = await call("bot_target",
      { action: "attack", target: { entity: target.id }, wait: true });
    assert.equal(r.outcome, "achieved", `the hunt should end with the kill: ${JSON.stringify(r)}`);
    assert.ok(r.hits >= 1, `swings landed: ${JSON.stringify(r)}`);
    assert.equal(await alive(target.id), undefined, "the staged zombie is dead");
  });

  test("an unreachable target CONCEDES within its own timeout — never the tool timeout", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "spawn", type: "player", pos: ORIGIN });
    // Seal a zombie in obsidian 10 blocks out: visible target, no route, no modify rights.
    const bx = X + 10;
    await cmd(`fill ${bx - 1} ${Y + 1} ${Z - 1} ${bx + 1} ${Y + 3} ${Z + 1} minecraft:obsidian`);
    await cmd(`fill ${bx} ${Y + 1} ${Z} ${bx} ${Y + 2} ${Z} minecraft:air`);
    await cmd(`summon minecraft:zombie ${bx} ${Y + 1} ${Z} {NoAI:1b,PersistenceRequired:1b}`);
    await sleep(500);
    const target = await zombie({ x: bx, z: Z });
    const started = Date.now();
    const r = await call("bot_target", { action: "attack", target: { entity: target.id },
      attack_timeout_ticks: 200, wait: true });
    const took = Date.now() - started;
    assert.equal(r.outcome, "stopped", JSON.stringify(r));
    assert.ok(["target_unreachable", "gave_up"].includes(r.reason),
      `an honest concession, not a hang: ${JSON.stringify(r)}`);
    assert.ok(took < 60_000, `returned in ${took}ms — the w2-79881 wedge ran the full 360s`);
    await killZombies();
    await cmd(`fill ${bx - 1} ${Y + 1} ${Z - 1} ${bx + 1} ${Y + 3} ${Z + 1} minecraft:air`);
  });

  test("a {kind} attack is a standing rule: arms and returns at once, waiter completed", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "spawn", type: "player", pos: ORIGIN });
    const started = Date.now();
    const r = await call("bot_target", { action: "attack", target: { kind: "zombie" }, wait: true });
    assert.equal(r.standing_rule, true, JSON.stringify(r));
    assert.ok(Date.now() - started < 5_000, "an arm returns immediately even with wait:true");
    await call("bot_body", { action: "engage", clear_targets: true });
  });

  test("defend mode REFUSES policy/range (fight-mode knobs, dead in defend)", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "spawn", type: "player", pos: ORIGIN });
    await assert.rejects(
      call("bot_body", { action: "engage", mode: "defend", policy: "kite" }),
      /fight-mode knob/,
      "policy in defend mode must be refused, not echoed");
    await assert.rejects(
      call("bot_body", { action: "engage", mode: "defend", range: 6 }),
      /fight-mode knob/,
      "range in defend mode must be refused, not echoed");
    // F4 (0.69.0): the old kite_note ("will NEVER land a swing") is retired — the dead band is
    // now UNREQUESTABLE. An explicit range clamps into the HELD weapon's band (empty hands =
    // melee [1, 3.5]) and the reply discloses the clamp instead of warning about a range it
    // would then obediently use.
    const fight = await call("bot_body", { action: "engage", mode: "fight", policy: "kite", range: 6 });
    assert.ok(typeof fight.range === "number" && fight.range <= 3.5,
      `unarmed kite@6 must clamp into swing reach: ${JSON.stringify(fight)}`);
    assert.equal(fight.range_clamped, true, `the clamp must be disclosed: ${JSON.stringify(fight)}`);
    await call("bot_body", { action: "engage", on: false });
  });
});
