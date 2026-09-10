// Live probes for the WALKER body (toolkit 0.17.0, BOT_SURFACE_DESIGN.md §11) — the measurement the
// whole body architecture exists for: everything §10 proved in PREDICTION (check_path) finally runs
// on a body that cannot cheat by flying.
//
//   1. bot_body spawn type:"walker" produces a grounded body (it falls to the floor and stays there);
//      bot_status reports body:"walker".
//   2. check_path (walker, entity-free): a 3-gap course is reachable with work.jumps >= 1 under a
//      PLAIN profile — sprint-jump edges are a movement capability, no opt-in.
//   3. THE TURN THESIS MEASUREMENT: bot_target move across the 3-gap achieves in ONE call, the
//      LEDGER discloses the leap (ledger.jumped), and the body is physically on the far side.
//   4. repairs > 0 for real: a corridor sealed shut, move with may_modify:break — the walker mines
//      its own way through (ledger.mined non-empty) and gets there.
//   5. A closed WOODEN door en route is physically opened (ledger.doors_opened), the walker passes.
//
// Courses are PENS: walls seal every route except the one under test — the first run of these probes
// caught the walker legitimately walking around an open-ended corridor and "achieving" without
// touching the obstacle, which is smart pathfinding but a useless measurement.
//
// Probe-owned site at 3.45M (its own chunks, staged idempotently, forceloaded during the run).
// Needs the dev server up (gradlew runServer). Skips itself when the bridge is down.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const SESSION = "probe-walker";
const X = 3_450_000, Z = 3_450_000, Y = 200;

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

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok)
  .catch(() => false);
if (!bridgeUp) {
  console.log(`\n  [skip] no bridge at ${BASE} — start the dev server to run these probes\n`);
}

// Three PENNED courses (walls + roof or full-height walls, capped ends):
//   GAP pen along x at z=Z:          floor X..X+14, 3-cell gap at X+7..X+9 (2 deep), walled all round.
//   WALL corridor along x at z=Z+10: sealed except a stone plug at X+4 (mine through or nothing).
//   DOOR corridor along x at z=Z+20: sealed except a shut oak door at X+4 (open it or nothing).
const GAP_START = { x: X + 1, y: Y + 1, z: Z };
const GAP_END = { x: X + 13, y: Y + 1, z: Z };
const WALL_START = { x: X + 1, y: Y + 1, z: Z + 10 };
const WALL_END = { x: X + 7, y: Y + 1, z: Z + 10 };
const DOOR_START = { x: X + 1, y: Y + 1, z: Z + 20 };
const DOOR_END = { x: X + 7, y: Y + 1, z: Z + 20 };

describe("walker body: grounded spawn, physical jumps, real repairs, doors", { skip: !bridgeUp }, () => {
  test("stage the courses", async (t) => {
    if (!bridgeUp) return t.skip();
    await cmd(`forceload add ${X - 32} ${Z - 32} ${X + 32} ${Z + 32}`);
    await sleep(1500);
    // Blank slate: air everywhere, then one big floor slab, then build the pens.
    await cmd(`fill ${X - 16} ${Y - 3} ${Z - 8} ${X + 24} ${Y + 8} ${Z + 28} minecraft:air`);
    await cmd(`fill ${X - 16} ${Y} ${Z - 8} ${X + 24} ${Y} ${Z + 28} minecraft:stone`);
    // GAP pen: side walls + end caps 3 high, then the 3-cell gap carved 2 deep across the pen.
    await cmd(`fill ${X - 1} ${Y + 1} ${Z - 2} ${X + 15} ${Y + 3} ${Z - 2} minecraft:stone`);
    await cmd(`fill ${X - 1} ${Y + 1} ${Z + 2} ${X + 15} ${Y + 3} ${Z + 2} minecraft:stone`);
    await cmd(`fill ${X - 1} ${Y + 1} ${Z - 1} ${X - 1} ${Y + 3} ${Z + 1} minecraft:stone`);
    await cmd(`fill ${X + 15} ${Y + 1} ${Z - 1} ${X + 15} ${Y + 3} ${Z + 1} minecraft:stone`);
    await cmd(`fill ${X + 7} ${Y - 2} ${Z - 1} ${X + 9} ${Y} ${Z + 1} minecraft:air`);
    // WALL corridor. Shell is 2 THICK everywhere: bot_target's arrival radius is 2.5 blocks, which
    // pierces a 1-thick wall — the first run "achieved" by standing outside 2.0 blocks from the
    // goal through the wall. Two-thick walls put every outside stand > 2.5 from the goal.
    await cmd(`fill ${X} ${Y + 1} ${Z + 8} ${X + 9} ${Y + 3} ${Z + 9} minecraft:stone`);
    await cmd(`fill ${X} ${Y + 1} ${Z + 11} ${X + 9} ${Y + 3} ${Z + 12} minecraft:stone`);
    await cmd(`fill ${X} ${Y + 3} ${Z + 10} ${X + 9} ${Y + 3} ${Z + 10} minecraft:stone`);
    await cmd(`fill ${X + 8} ${Y + 1} ${Z + 10} ${X + 9} ${Y + 2} ${Z + 10} minecraft:stone`); // 2-thick end cap
    await cmd(`fill ${X + 4} ${Y + 1} ${Z + 10} ${X + 4} ${Y + 2} ${Z + 10} minecraft:stone`); // the plug
    // Interior air on both sides of the plug (idempotent restage: clear leftovers from prior runs).
    await cmd(`fill ${X} ${Y + 1} ${Z + 10} ${X + 3} ${Y + 2} ${Z + 10} minecraft:air`);
    await cmd(`fill ${X + 5} ${Y + 1} ${Z + 10} ${X + 7} ${Y + 2} ${Z + 10} minecraft:air`);
    // DOOR corridor: same 2-thick pen, shut oak door instead of the plug.
    await cmd(`fill ${X} ${Y + 1} ${Z + 18} ${X + 9} ${Y + 3} ${Z + 19} minecraft:stone`);
    await cmd(`fill ${X} ${Y + 1} ${Z + 21} ${X + 9} ${Y + 3} ${Z + 22} minecraft:stone`);
    await cmd(`fill ${X} ${Y + 3} ${Z + 20} ${X + 9} ${Y + 3} ${Z + 20} minecraft:stone`);
    await cmd(`fill ${X + 8} ${Y + 1} ${Z + 20} ${X + 9} ${Y + 2} ${Z + 20} minecraft:stone`);
    await cmd(`fill ${X} ${Y + 1} ${Z + 20} ${X + 7} ${Y + 2} ${Z + 20} minecraft:air`);
    await cmd(`setblock ${X + 4} ${Y + 1} ${Z + 20} minecraft:oak_door[facing=east,half=lower]`);
    await sleep(400);
  });

  test("check_path walker (entity-free): the gap is jumpable under a plain profile", async (t) => {
    if (!bridgeUp) return t.skip();
    const r = await call("check_path", { from: GAP_START, to: GAP_END });
    assert.equal(r.body, "walker");
    assert.equal(r.reachable, true, `expected reachable:true, got ${JSON.stringify(r)}`);
    assert.ok(r.work && r.work.jumps >= 1,
      `expected work.jumps >= 1 (a sprint-jump edge), got ${JSON.stringify(r.work)}`);
    assert.equal(r.work.break_cells ?? 0, 0);
    assert.equal(r.work.place_cells ?? 0, 0);
  });

  test("spawn: the walker is a grounded body and bot_status says so", async (t) => {
    if (!bridgeUp) return t.skip();
    const r = await call("bot_body", { action: "spawn", type: "walker",
      pos: { x: GAP_START.x + 0.5, y: Y + 3, z: GAP_START.z + 0.5 } });
    assert.equal(r.type, "walker");
    await sleep(1500); // spawned 2 above the floor: gravity should bring it down and keep it there
    const s = await call("bot_status", {});
    assert.equal(s.body, "walker");
    assert.ok(Math.abs(s.pos.y - (Y + 1)) < 0.5,
      `walker should stand ON the floor at y=${Y + 1}, is at ${s.pos.y} (flying would hover)`);
  });

  test("TURN THESIS: one bot_target move crosses the 3-gap with a disclosed physical leap", async (t) => {
    if (!bridgeUp) return t.skip();
    const r = await call("bot_target", { action: "move", target: { at: GAP_END }, wait: true });
    assert.equal(r.outcome, "achieved", `expected achieved, got ${JSON.stringify(r)}`);
    assert.ok(r.ledger && Array.isArray(r.ledger.jumped) && r.ledger.jumped.length >= 1,
      `expected ledger.jumped >= 1 (the leap disclosed), got ${JSON.stringify(r.ledger)}`);
    // The proof it walked: it is physically on the far side of the gap (the pen has no way around).
    const s = await call("bot_status", {});
    assert.ok(s.pos.x >= X + 10 - 2.5, `expected body past the gap (x>=${X + 10 - 2.5}), at ${s.pos.x}`);
  });

  test("repairs > 0 for real: mines through the corridor plug under may_modify:break", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "spawn", type: "walker",
      pos: { x: WALL_START.x + 0.5, y: WALL_START.y, z: WALL_START.z + 0.5 } });
    await sleep(800);
    const r = await call("bot_target", { action: "move", target: { at: WALL_END },
      may_modify: "break", wait: true });
    assert.equal(r.outcome, "achieved", `expected achieved through the wall, got ${JSON.stringify(r)}`);
    assert.ok(r.repairs >= 1, `expected repairs >= 1, got ${JSON.stringify(r)}`);
    assert.ok(r.ledger && Array.isArray(r.ledger.mined) && r.ledger.mined.length >= 1,
      `expected ledger.mined >= 1 (the plug), got ${JSON.stringify(r.ledger)}`);
  });

  test("wooden door en route: physically opened and passed (ledger.doors_opened)", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "spawn", type: "walker",
      pos: { x: DOOR_START.x + 0.5, y: DOOR_START.y, z: DOOR_START.z + 0.5 } });
    await sleep(800);
    const r = await call("bot_target", { action: "move", target: { at: DOOR_END }, wait: true });
    assert.equal(r.outcome, "achieved", `expected achieved through the door, got ${JSON.stringify(r)}`);
    assert.ok(r.ledger && Array.isArray(r.ledger.doors_opened) && r.ledger.doors_opened.length >= 1,
      `expected ledger.doors_opened >= 1, got ${JSON.stringify(r.ledger)}`);
    // And the pass is physical: the body ended up beyond the door plane.
    const s = await call("bot_status", {});
    assert.ok(s.pos.x >= X + 5 - 0.5, `expected body past the door (x>=${X + 4.5}), at ${s.pos.x}`);
  });

  test("cleanup", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "despawn" }).catch(() => {});
    await cmd(`forceload remove ${X - 32} ${Z - 32} ${X + 32} ${Z + 32}`);
  });
});
