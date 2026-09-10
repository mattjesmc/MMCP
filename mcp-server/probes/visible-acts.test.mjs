// The video-watchability batch (toolkit 0.52.0): acts must physically READ on screen — and stay
// honest while doing it. What this file pins:
//
//   REAL DROPS — a player-body dig spawns actual item entities that the body's own vanilla pickup
//     vacuums during a settle phase; the completion event still reports collected>=1 with the real
//     item id (counts from an inventory delta, not an assumed insert), and it arrives LATER than
//     the old teleport-into-pack path (the settle is visible time).
//   WRONG-TIER REGRESSION — a bare-hand stone dig still breaks-and-collects-nothing through the
//     instant path (no drops -> no settle), shape unchanged.
//   SWEEP — bot_look {sweep_ticks} turns smoothly: the call parks, returns swept:true and the
//     final yaw, and takes real time (a snap returns in one tick).
//   CONTAINER CEREMONY — put/take on a chest is now a ~1s ticked act (face, REAL openMenu -> lid +
//     sounds, transfer, close) whose reply shape is unchanged: moved, still_carried, container
//     echo. A refusal (out of reach) stays instant.
//   BENCH CRAFT CEREMONY — with a crafting table in reach, bot_craft works at the bench (~0.75s)
//     before the result lands; produced/consumed unchanged.
//   REAL EATING — bot_eat runs vanilla use-ticks (~1.6s): the reply completes after the swallow,
//     ate/food fields unchanged.
//
// Probe-owned site at 3.94M (site-map.test.mjs enforces exclusivity; the battery runs files
// CONCURRENTLY). Needs the dev server up; skips otherwise.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const SESSION = "probe-vacts";
const X = 3_940_000, Z = 3_940_000, Y = 200;

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
const CMD_FAILED = /Too many blocks|not loaded|Unknown command|Incorrect argument|Expected |No entity|cannot be|No targets/i;
async function cmd(c) {
  const r = await call("run_command", { command: c });
  const out = (r.output ?? []).join(" ");
  if (CMD_FAILED.test(out)) {
    throw new Error(`staging command failed: ${c}\n  -> ${out}`);
  }
  return r;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok)
  .catch(() => false);
if (!bridgeUp) {
  console.log(`\n  [skip] no bridge at ${BASE} — start the dev server to run these probes\n`);
}

// One standing point, every fixture within hand reach (~4.5 of the eye at Y+2.62):
const BODY = { x: X + 0.5, y: Y + 1, z: Z + 0.5 };
const DIRT = { x: X + 2, y: Y + 2, z: Z };        // real-drops dig
const STONE = { x: X - 2, y: Y + 2, z: Z };       // wrong-tier regression
const PLANK_A = { x: X + 2, y: Y + 2, z: Z + 2 }; // craft ingredients
const PLANK_B = { x: X + 2, y: Y + 2, z: Z - 2 };
const CHEST = { x: X, y: Y + 2, z: Z + 3 };
const BENCH = { x: X, y: Y + 2, z: Z - 3 };

describe("visible acts (0.52.0): real drops, sweeps, ceremonies, real eating", { skip: !bridgeUp }, () => {
  test("stage the site + spawn the body", async (t) => {
    if (!bridgeUp) return t.skip();
    await cmd(`forceload add ${X - 32} ${Z - 32} ${X + 32} ${Z + 32}`);
    await sleep(3000);
    await cmd(`fill ${X - 12} ${Y - 4} ${Z - 12} ${X + 12} ${Y + 8} ${Z + 12} minecraft:air`);
    await cmd(`fill ${X - 12} ${Y - 4} ${Z - 12} ${X + 12} ${Y} ${Z + 12} minecraft:stone`);
    await cmd(`setblock ${DIRT.x} ${DIRT.y} ${DIRT.z} minecraft:dirt`);
    await cmd(`setblock ${STONE.x} ${STONE.y} ${STONE.z} minecraft:stone`);
    await cmd(`setblock ${PLANK_A.x} ${PLANK_A.y} ${PLANK_A.z} minecraft:oak_planks`);
    await cmd(`setblock ${PLANK_B.x} ${PLANK_B.y} ${PLANK_B.z} minecraft:oak_planks`);
    // AIR FIRST. `setblock` onto an identical block is a no-op, so re-staging a chest that already
    // exists keeps its CONTENTS — and this file's container test asserts `take.moved === 1`, which
    // only holds when the chest starts empty. Any failure between the put and the take (the 599ms
    // timing flake did exactly this) leaves a dirt behind, and from then on the chest ratchets
    // 1 -> 2 -> 3 and the test fails deterministically on every future run, in a way that looks
    // like a container defect and is not. Live-caught 2026-08-06.
    await cmd(`setblock ${CHEST.x} ${CHEST.y} ${CHEST.z} minecraft:air`);
    await cmd(`setblock ${CHEST.x} ${CHEST.y} ${CHEST.z} minecraft:chest`);
    await cmd(`setblock ${BENCH.x} ${BENCH.y} ${BENCH.z} minecraft:crafting_table`);
    await call("bot_body", { action: "despawn" }).catch(() => {});
    // …AND the loose drops. This body is a real ServerPlayer that auto-collects, so a dirt left on
    // the ground by an earlier run is vacuumed up the moment it spawns — the pack then starts with
    // 2 dirt and `put.moved` is 2, not 1. Three strays were sitting here on 2026-08-06. Staging
    // resets BLOCKS; the site's dynamic state (container contents, dropped items) has to be reset
    // too or a single mid-test failure poisons every run that follows.
    // Not cmd(): an empty selector answers "No entity was found", which cmd() reads as a failure.
    await call("run_command", {
      command: `execute positioned ${X} ${Y + 1} ${Z} run kill @e[type=item,distance=..20]`,
    });
    const r = await call("bot_body", { action: "spawn", type: "player", pos: BODY });
    assert.ok(r.spawned ?? r.ok ?? true, `spawn: ${JSON.stringify(r)}`);
    await sleep(800);
  });

  test("bot_look sweep_ticks parks, turns, and reports swept:true", async (t) => {
    if (!bridgeUp) return t.skip();
    const before = await call("bot_look", { yaw: 0, pitch: 0 }); // snap to a known heading
    assert.equal(Math.round(before.yaw), 0);
    const t0 = Date.now();
    const r = await call("bot_look", { yaw: 120, pitch: 10, sweep_ticks: 10 });
    const elapsed = Date.now() - t0;
    assert.equal(r.swept, true, `sweep preempted: ${JSON.stringify(r)}`);
    assert.ok(Math.abs(r.yaw - 120) < 5, `final yaw ${r.yaw} != 120`);
    // 10 ticks = 500ms of turning; a snap returns in <50ms. Lower bound only (tick jitter).
    assert.ok(elapsed >= 300, `sweep returned in ${elapsed}ms — that is a snap, not a sweep`);
  });

  test("dig collects REAL drops through the settle phase, honestly counted", async (t) => {
    if (!bridgeUp) return t.skip();
    const t0 = Date.now();
    const r = await call("bot_mine", { at: DIRT, wait: true });
    const elapsed = Date.now() - t0;
    assert.equal(r.mined, "minecraft:dirt", JSON.stringify(r));
    assert.equal(r.collected, 1, `collected ${r.collected} — the settle must end in the pack`);
    assert.equal(r.drops?.[0]?.item, "minecraft:dirt");
    assert.equal(r.drops?.[0]?.collected, 1);
    // Bare-hand dirt is ~15 ticks; the settle (pop + vacuum) adds real visible time on top.
    assert.ok(elapsed >= 700, `dig+settle took ${elapsed}ms — drops teleported, no settle ran`);
  });

  test("wrong-tier dig is refused; waived, it breaks-and-collects-nothing instantly (no settle, no lie)", async (t) => {
    if (!bridgeUp) return t.skip();
    // 0.56.0: bare hands on a drop-gated block with no correct tool carried no longer digs — the
    // survival body refuses to waste the block unless the caller waives the drops.
    const refused = await call("bot_mine", { at: STONE });
    assert.equal(refused.started, false, JSON.stringify(refused));
    assert.equal(refused.reason, "wrong_tool", JSON.stringify(refused));
    const r = await call("bot_mine", { at: STONE, accept_no_drops: true, wait: true });
    assert.equal(r.mined, "minecraft:stone", JSON.stringify(r));
    assert.equal(r.collected, 0, "bare hands must not harvest stone (tier gate)");
    assert.equal(r.drops_expected, false);
  });

  test("container put/take is a ~0.6s ceremony with an unchanged reply shape", async (t) => {
    if (!bridgeUp) return t.skip();
    // The dirt from the settle test is in the pack. Put it in the chest…
    const t0 = Date.now();
    const put = await call("bot_container", { at: CHEST, action: "put", item: "minecraft:dirt" });
    const putMs = Date.now() - t0;
    assert.equal(put.ok, true, JSON.stringify(put));
    assert.equal(put.moved, 1);
    assert.equal(put.still_carried, 0);
    assert.ok(put.container?.slots?.some((s) => s.item === "minecraft:dirt"),
      "the chest echo must show the dirt");
    // Containers.java passes 12 ticks = 600ms EXACTLY, so `>= 600` is a coin flip on rounding —
    // it failed at 599ms in three of three full batteries and passed every time the file ran
    // alone (2026-08-06). The question this asks is "did a ceremony run, or did the act teleport
    // in zero ticks"; a snap returns in <50ms, so 400 answers it with room to spare. The bench
    // craft next door has always had that margin (15 ticks = 750ms, asserted >= 500) and has
    // never flaked. Bound the CLAIM, not the exact designed duration.
    assert.ok(putMs >= 400, `put took ${putMs}ms — the ceremony (face/open/close) did not run`);
    // …and take it back.
    const take = await call("bot_container", { at: CHEST, action: "take", item: "minecraft:dirt" });
    assert.equal(take.ok, true, JSON.stringify(take));
    assert.equal(take.moved, 1);
  });

  test("bench craft works AT the bench (~0.75s) with produced/consumed unchanged", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_mine", { at: PLANK_A, wait: true });
    await call("bot_mine", { at: PLANK_B, wait: true });
    const t0 = Date.now();
    const r = await call("bot_craft", { item: "minecraft:stick", count: 4 });
    const elapsed = Date.now() - t0;
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.produced, 4);
    assert.ok(r.consumed?.some((c) => c.item === "minecraft:oak_planks" && c.count === 2),
      `consumed: ${JSON.stringify(r.consumed)}`);
    assert.ok(elapsed >= 500, `craft took ${elapsed}ms — the bench ceremony did not run`);
  });

  test("eating runs the REAL ~1.6s use-ticks and reports the swallow", async (t) => {
    if (!bridgeUp) return t.skip();
    await cmd(`give probe_vacts minecraft:bread 1`);
    await sleep(300);
    const t0 = Date.now();
    const r = await call("bot_eat", { item: "minecraft:bread" });
    const elapsed = Date.now() - t0;
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.ate, "minecraft:bread");
    assert.ok(typeof r.food === "number");
    // 32 use-ticks = 1600ms. Lower bound generously below that for tick jitter.
    assert.ok(elapsed >= 1200, `eat took ${elapsed}ms — that is the instant apply, not a meal`);
  });

  test("cleanup", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "despawn" }).catch(() => {});
    await cmd(`forceload remove ${X - 32} ${Z - 32} ${X + 32} ${Z + 32}`);
  });
});
