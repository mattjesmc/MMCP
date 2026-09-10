// Vertical-mobility + edge-care probes for the WALKER body (toolkit 0.26.0, BOT_SURFACE_DESIGN.md
// §12.2) — the two toolkit gaps E-repair's bridge_gap rung exposed and left KNOWN-RED:
//
//   EDGE CARE — the driver holds at an unsupported lip instead of coasting off its own in-progress
//     bridge into the trench. Exercised through the bridge pipeline: crossing a 7-gap by placing
//     floor must END on the walk level ALIVE, never on the trench floor (the probabilistic fall the
//     driver edge-guard removes). NavDriver.footingAt + WalkerEntity.footingAt.
//   PILLAR-UP — a walker on the FLOOR of a 4-deep pit with cobblestone + place rights towers OUT:
//     place-below + jump, one block per rung, until it reaches the surface and walks to the goal.
//     The recovery that makes a fallen walker with a full inventory no longer honestly stuck.
//   STAIR-MINE — a walker with break rights cuts a step up through a solid blocker to reach a raised
//     platform (the break-rights sibling of pillar-up; actuation reuses BREAK + the driver step-up).
//   PREDICTION PARITY — check_path predicts each vertical route reachable ONLY with the matching
//     right (place for the pit, break for the step), and unreachable plain — the shared-solver
//     contract §1.1, now on the vertical edge class.
//
// Courses are penned strips with 2-thick shells and a SOLID foundation (a stranded walker must land
// on stone, never fall through hollow ground into the ocean — the walker-caps course lesson). The
// pit is deliberately OPEN above: pillar-up needs sky.
//
// Probe-owned site at 3.47M, clear of walker-caps (3.46M). Needs the dev server up; skips otherwise.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const SESSION = "probe-walker-vert";
const X = 3_470_000, Z = 3_470_000, Y = 200;

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
const spawnWalker = async (pos) => {
  const r = await call("bot_body", { action: "spawn", type: "walker", pos });
  await sleep(600);
  return r;
};

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok)
  .catch(() => false);
if (!bridgeUp) {
  console.log(`\n  [skip] no bridge at ${BASE} — start the dev server to run these probes\n`);
}

// Sites (centerlines along z):
const BRIDGE = Z;       // 7-gap over a 4-deep trench, for the edge-guard-through-bridging test
const PIT = Z + 24;     // 4-deep open pit, walker on the floor, for pillar-up
const STEP = Z + 48;    // solid 2-tall blocker + raised platform, for stair-mine

// A 2-thick-shelled pen: interior x X..X+13 (walk level Y+1..Y+height), caps at both ends.
async function pen(zc, height = 3) {
  await cmd(`fill ${X - 2} ${Y + 1} ${zc - 3} ${X + 16} ${Y + height} ${zc - 2} minecraft:stone`);
  await cmd(`fill ${X - 2} ${Y + 1} ${zc + 2} ${X + 16} ${Y + height} ${zc + 3} minecraft:stone`);
  await cmd(`fill ${X - 2} ${Y + 1} ${zc - 1} ${X - 1} ${Y + height} ${zc + 1} minecraft:stone`);
  await cmd(`fill ${X + 15} ${Y + 1} ${zc - 1} ${X + 16} ${Y + height} ${zc + 1} minecraft:stone`);
}

describe("walker vertical mobility: edge-care, pillar-up, stair-mine", { skip: !bridgeUp }, () => {
  test("stage the sites", async (t) => {
    if (!bridgeUp) return t.skip();
    await cmd(`forceload add ${X - 32} ${Z - 32} ${X + 32} ${Z + 96}`);
    await sleep(1500);
    // Blank slate + a SOLID 6-deep foundation (top at Y, walk level Y+1). Never a floating slab.
    await cmd(`fill ${X - 16} ${Y - 6} ${Z - 8} ${X + 24} ${Y + 8} ${Z + 80} minecraft:air`);
    await cmd(`fill ${X - 16} ${Y - 6} ${Z - 8} ${X + 24} ${Y} ${Z + 80} minecraft:stone`);

    // BRIDGE: pen + 7-cell gap (landing distance 8 > jump ceiling 5) over a 4-deep trench.
    await pen(BRIDGE);
    await cmd(`fill ${X + 6} ${Y - 3} ${BRIDGE - 1} ${X + 12} ${Y} ${BRIDGE + 1} minecraft:air`);
    await cmd(`fill ${X + 6} ${Y - 4} ${BRIDGE - 1} ${X + 12} ${Y - 4} ${BRIDGE + 1} minecraft:stone`);

    // PIT: an OPEN 3-wide box carved into the foundation, floor at Y-4 (feet Y-3 = 4 below the
    // surface walk level Y+1). Walls are the un-carved foundation on all four sides; the surface east
    // of the pit runs to the goal. No roof — pillar-up needs open sky.
    await cmd(`fill ${X - 2} ${Y + 1} ${PIT - 3} ${X + 16} ${Y + 3} ${PIT - 2} minecraft:stone`);
    await cmd(`fill ${X - 2} ${Y + 1} ${PIT + 2} ${X + 16} ${Y + 3} ${PIT + 3} minecraft:stone`);
    await cmd(`fill ${X + 2} ${Y - 3} ${PIT - 1} ${X + 4} ${Y + 4} ${PIT + 1} minecraft:air`);
    // Roof only the SURFACE run east of the pit (so the walker crosses to the goal in a corridor),
    // leaving the pit column itself open above.
    await cmd(`fill ${X + 5} ${Y + 4} ${PIT - 1} ${X + 10} ${Y + 4} ${PIT + 1} minecraft:stone`);

    // STEP: a raised platform (floor Y+1, top Y+2) reached over a solid 2-tall blocker at X+5 whose
    // upper cell must be MINED to step through — plain walk cannot ascend it. Tall pen for headroom.
    await pen(STEP, 6);
    await cmd(`fill ${X + 5} ${Y + 1} ${STEP - 1} ${X + 8} ${Y + 1} ${STEP + 1} minecraft:stone`);
    await cmd(`fill ${X + 5} ${Y + 2} ${STEP - 1} ${X + 5} ${Y + 2} ${STEP + 1} minecraft:stone`);
    await sleep(400);
  });

  // ---- edge care (through the bridge pipeline) --------------------------------

  test("7-gap plain: unreachable with a bridgeable-gap obstruction", async (t) => {
    if (!bridgeUp) return t.skip();
    const p = await call("check_path", {
      from: { x: X + 1, y: Y + 1, z: BRIDGE }, to: { x: X + 14, y: Y + 1, z: BRIDGE } });
    assert.equal(p.reachable, false, `7-gap must not be jumpable: ${JSON.stringify(p)}`);
  });

  test("EDGE CARE: bridging a 7-gap ends on the walk level ALIVE, never in the trench", async (t) => {
    if (!bridgeUp) return t.skip();
    await spawnWalker({ x: X + 1.5, y: Y + 1, z: BRIDGE + 0.5 });
    await call("bot_give", { item: "minecraft:cobblestone", count: 64 });
    const r = await call("bot_target", {
      action: "move", target: { at: { x: X + 14, y: Y + 1, z: BRIDGE } },
      may_modify: "place", item: "minecraft:cobblestone", wait: true });
    assert.equal(r.outcome, "achieved", JSON.stringify(r));
    assert.ok(r.ledger?.placed?.length >= 3,
      `bridging must disclose placed cells: ${JSON.stringify(r.ledger)}`);
    const s = await call("bot_status", {});
    assert.ok((s.health ?? 0) > 0, `must be alive (not fallen + hurt): ${JSON.stringify(s)}`);
    assert.ok(Math.abs(s.pos.y - (Y + 1)) < 0.6,
      `must END on the walk level, not the trench floor: y=${s.pos.y}`);
    assert.ok(s.pos.x >= X + 13 - 2.5, `physically across, at x=${s.pos.x}`);
  });

  // ---- pillar-up: the trench-escape -------------------------------------------

  test("PREDICTION: the pit floor is unreachable plain, reachable with place (pillar-up)", async (t) => {
    if (!bridgeUp) return t.skip();
    const from = { x: X + 3, y: Y - 3, z: PIT };
    const to = { x: X + 7, y: Y + 1, z: PIT };
    const plain = await call("check_path", { from, to, body: "walker", max_length: 512 });
    assert.equal(plain.reachable, false, `sheer pit must be unclimbable plain: ${JSON.stringify(plain)}`);
    const armed = await call("check_path",
      { from, to, body: "walker", max_length: 512, may_modify: "place" });
    assert.equal(armed.reachable, true, `pillar-up must reach the surface: ${JSON.stringify(armed)}`);
    assert.ok((armed.work?.place_cells ?? 0) >= 3,
      `the committed plan discloses the pillar places: ${JSON.stringify(armed.work)}`);
  });

  test("PILLAR-UP: a walker on the pit floor towers out to the surface goal", async (t) => {
    if (!bridgeUp) return t.skip();
    await spawnWalker({ x: X + 3.5, y: Y - 3, z: PIT + 0.5 });
    await call("bot_give", { item: "minecraft:cobblestone", count: 64 });
    const r = await call("bot_target", {
      action: "move", target: { at: { x: X + 7, y: Y + 1, z: PIT } },
      may_modify: "place", item: "minecraft:cobblestone", wait: true });
    assert.equal(r.outcome, "achieved", JSON.stringify(r));
    assert.ok(r.ledger?.placed?.length >= 3,
      `pillaring must disclose the placed rungs: ${JSON.stringify(r.ledger)}`);
    const s = await call("bot_status", {});
    assert.ok((s.health ?? 0) > 0, `alive on the surface: ${JSON.stringify(s)}`);
    assert.ok(s.pos.y >= Y + 1 - 0.6, `climbed OUT of the pit, at y=${s.pos.y}`);
    assert.ok(s.pos.x >= X + 7 - 2.5, `reached the surface goal, at x=${s.pos.x}`);
  });

  // ---- stair-mine: cut a step up through solid --------------------------------

  test("PREDICTION: the platform is unreachable plain, reachable with break (stair-mine)", async (t) => {
    if (!bridgeUp) return t.skip();
    const from = { x: X + 1, y: Y + 1, z: STEP };
    const to = { x: X + 8, y: Y + 2, z: STEP };
    const plain = await call("check_path", { from, to, body: "walker", max_length: 512 });
    assert.equal(plain.reachable, false, `solid blocker must stop a plain walk: ${JSON.stringify(plain)}`);
    const armed = await call("check_path",
      { from, to, body: "walker", max_length: 512, may_modify: "break" });
    assert.equal(armed.reachable, true, `stair-mine must reach the platform: ${JSON.stringify(armed)}`);
    assert.ok((armed.work?.break_cells ?? 0) >= 1,
      `the committed plan discloses the mined step: ${JSON.stringify(armed.work)}`);
  });

  test("STAIR-MINE: a walker cuts a step up onto the raised platform", async (t) => {
    if (!bridgeUp) return t.skip();
    await spawnWalker({ x: X + 1.5, y: Y + 1, z: STEP + 0.5 });
    const r = await call("bot_target", {
      action: "move", target: { at: { x: X + 8, y: Y + 2, z: STEP } },
      may_modify: "break", wait: true });
    assert.equal(r.outcome, "achieved", JSON.stringify(r));
    assert.ok(r.ledger?.mined?.length >= 1,
      `stair-mine must disclose the mined step: ${JSON.stringify(r.ledger)}`);
    const s = await call("bot_status", {});
    assert.ok(s.pos.y >= Y + 2 - 0.6, `on the platform, one level up, at y=${s.pos.y}`);
    assert.ok(s.pos.x >= X + 8 - 2.5, `reached the platform goal, at x=${s.pos.x}`);
  });

  test("cleanup", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "despawn" }).catch(() => {});
    await cmd(`forceload remove ${X - 32} ${Z - 32} ${X + 32} ${Z + 96}`);
  });
});
