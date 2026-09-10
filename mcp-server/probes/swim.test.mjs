// Swimming navigation + the stall watchdog (toolkit 0.37.0, BOT_SURFACE_DESIGN.md §12.4) — the two
// halves of the live hang a watched session hit: a body that froze at a shoreline, and a navigation
// that could then never end.
//
//   STALL WATCHDOG — the regression that matters most. A navigation whose route is walled off MID
//     FLIGHT must end with outcome `stalled` and a real distance, within seconds. Before this the
//     player body had no stuck detection at all and the goal loop it delegated to was itself blocked
//     waiting for the completion, so the verdict never came and the agent waited forever. The test is
//     shaped as a RACE (start the move, then drop a wall across the corridor) because that is the
//     honest way to produce a path the body genuinely cannot follow.
//   SHORELINE — the freeze itself. NavDriver's edge-care reads footing via isPathfindable, and
//     LiquidBlock.isPathfindable returns !lava — so deep water read as "no footing" and forward input
//     was zeroed at the water's edge. A player body must now cross a channel and climb out the far
//     side. NavBody.swimmableAt.
//   DIVE — an UNDERWATER goal, reached by the vertical swim edges the walking search has no way to
//     express (BuildWalkNodeEvaluator.swimNode). Arriving at the bottom of a pool is the whole test.
//   AIR — a dive to the floor of a deep pool and back out must end ALIVE. SwimControl's surfacing
//     override breathes mid-route instead of aborting the goal the way the `surface` reflex does.
//   PREDICTION PARITY — check_path with swim:true reaches across water and swim:false does not: the
//     §1.1 shared-solver contract extended onto the swim capability.
//
// Courses are penned strips with 2-thick shells over a SOLID foundation (the walker-caps lesson: a
// stranded body must land on stone, never fall through into the ocean). Water is filled directly over
// the carved foundation, so every pool is contained by un-carved stone on all four sides.
//
// Probe-owned site at 3.57M. Moved off 3.48M, which fake-player.test.mjs already owned: the
// battery runs probe files CONCURRENTLY, so a shared site means two files stage on top of each
// other's world. Needs the dev server up; skips otherwise.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const SESSION = "probe-swim";
const X = 3_570_000, Z = 3_570_000, Y = 200;

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
// run_command returns ok:true even when the COMMAND failed — the failure is only in `output`. A
// probe that ignores that stages nothing, runs anyway, and blames the code: the first run of this
// suite reported four navigation failures that were really one oversized /fill. Staging asserts.
const CMD_FAILED = /Too many blocks|not loaded|Unknown command|Incorrect argument|Expected |No entity|cannot be/i;
async function cmd(c) {
  const r = await call("run_command", { command: c });
  const out = (r.output ?? []).join(" ");
  if (CMD_FAILED.test(out)) {
    throw new Error(`staging command failed: ${c}\n  -> ${out}`);
  }
  return r;
}

/** Vanilla /fill caps at 32768 blocks per call; stage big volumes as slices that stay under it. */
const FILL_LIMIT = 32768;
async function fill(x1, y1, z1, x2, y2, z2, block) {
  const [xa, xb] = [Math.min(x1, x2), Math.max(x1, x2)];
  const [ya, yb] = [Math.min(y1, y2), Math.max(y1, y2)];
  const [za, zb] = [Math.min(z1, z2), Math.max(z1, z2)];
  const h = yb - ya + 1;
  const xStep = Math.max(1, Math.floor(Math.sqrt(FILL_LIMIT / h)));
  for (let x = xa; x <= xb; x += xStep) {
    const xe = Math.min(xb, x + xStep - 1);
    const zStep = Math.max(1, Math.floor(FILL_LIMIT / ((xe - x + 1) * h)));
    for (let z = za; z <= zb; z += zStep) {
      await cmd(`fill ${x} ${ya} ${z} ${xe} ${yb} ${Math.min(zb, z + zStep - 1)} ${block}`);
    }
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const spawnPlayer = async (pos) => {
  await call("bot_body", { action: "despawn" }).catch(() => {});
  const r = await call("bot_body", { action: "spawn", type: "player", pos });
  await sleep(800);
  return r;
};

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok)
  .catch(() => false);
if (!bridgeUp) {
  console.log(`\n  [skip] no bridge at ${BASE} — start the dev server to run these probes\n`);
}

// Sites (centerlines along z):
const CHANNEL = Z;        // 8-wide water channel, walk in / swim / climb out
const POOL = Z + 24;      // 9-deep pool for the dive + air round trip
const CORRIDOR = Z + 48;  // dry corridor, walled mid-flight, for the stall watchdog

// A 2-thick-shelled pen: interior x X..X+15, walk level Y+1..Y+height, caps at both ends.
async function pen(zc, height = 4) {
  await fill(X - 2, Y + 1, zc - 3, X + 18, Y + height, zc - 2, "minecraft:stone");
  await fill(X - 2, Y + 1, zc + 2, X + 18, Y + height, zc + 3, "minecraft:stone");
  await fill(X - 2, Y + 1, zc - 1, X - 1, Y + height, zc + 1, "minecraft:stone");
  await fill(X + 17, Y + 1, zc - 1, X + 18, Y + height, zc + 1, "minecraft:stone");
}

describe("swimming navigation + the stall watchdog", { skip: !bridgeUp }, () => {
  test("stage the sites", async (t) => {
    if (!bridgeUp) return t.skip();
    await cmd(`forceload add ${X - 32} ${Z - 32} ${X + 40} ${Z + 96}`);
    await sleep(3000);
    // Blank slate + a SOLID 12-deep foundation (top at Y, walk level Y+1).
    await fill(X - 16, Y - 12, Z - 8, X + 28, Y + 10, Z + 80, "minecraft:air");
    await fill(X - 16, Y - 12, Z - 8, X + 28, Y, Z + 80, "minecraft:stone");

    // CHANNEL: an 8-wide, 5-deep water channel cut into the foundation. The water's TOP cell is the
    // walk level itself, so both shores are flat step-in/step-out transitions — the plainest possible
    // shoreline, which is exactly the one that used to freeze. Deliberate consequence: sources at
    // walk level SPILL a thin flowing sheet over both shores (open floor beside them) — assertions
    // about staying dry must therefore test `submerged`, not `inWater` (verified 2026-08-02: filling
    // the water one lower keeps the shores dry but breaks the crossing itself).
    await pen(CHANNEL);
    await fill(X + 5, Y - 3, CHANNEL - 1, X + 12, Y + 1, CHANNEL + 1, "minecraft:water");

    // POOL: a 9-deep open pool (floor Y-8, feet cell Y-7) with the surface at the walk level. Open
    // above — a body that needs to breathe must be able to reach air.
    await pen(POOL, 5);
    await fill(X + 3, Y - 8, POOL - 1, X + 13, Y + 1, POOL + 1, "minecraft:water");

    // CORRIDOR: a plain dry run, roofed, for the stall race. Nothing special about it — the wall
    // arrives at test time.
    await pen(CORRIDOR);
    await fill(X - 2, Y + 4, CORRIDOR - 1, X + 18, Y + 4, CORRIDOR + 1, "minecraft:stone");
    await sleep(600);

    // The staging must be REAL before anything is asserted about navigation: a body spawned over a
    // foundation that was never built just falls to bedrock and every later failure is a lie about
    // the code. Verify the floor exists.
    const probe = await call("get_blocks_at", { blocks: [
      { x: X + 1, y: Y, z: CHANNEL },        // foundation under the near shore
      { x: X + 8, y: Y - 5, z: POOL },       // water deep in the pool
    ] });
    assert.ok(JSON.stringify(probe.palette).includes("stone"),
      `the foundation was not staged — every later assertion would be meaningless: ${JSON.stringify(probe)}`);
    assert.ok(JSON.stringify(probe.palette).includes("water"),
      `the pool was not staged: ${JSON.stringify(probe)}`);
  });

  // ---- prediction parity ------------------------------------------------------

  test("PREDICTION: the channel is crossable with swim, not without", async (t) => {
    if (!bridgeUp) return t.skip();
    const from = { x: X + 1, y: Y + 1, z: CHANNEL };
    const to = { x: X + 15, y: Y + 1, z: CHANNEL };
    const dry = await call("check_path", { from, to, body: "walker", max_length: 512, swim: false });
    assert.equal(dry.reachable, false,
      `a land-only route must not cross open water: ${JSON.stringify(dry)}`);
    const wet = await call("check_path", { from, to, body: "walker", max_length: 512, swim: true });
    assert.equal(wet.reachable, true, `swimming must cross the channel: ${JSON.stringify(wet)}`);
  });

  // ---- the shoreline freeze ---------------------------------------------------

  test("SHORELINE: a player body swims the channel and climbs out the far side", async (t) => {
    if (!bridgeUp) return t.skip();
    await spawnPlayer({ x: X + 1.5, y: Y + 1, z: CHANNEL + 0.5 });
    const r = await call("bot_goto", {
      to: { x: X + 15, y: Y + 1, z: CHANNEL }, wait: true });
    assert.equal(r.outcome, "arrived",
      `must cross, not freeze at the water's edge: ${JSON.stringify(r)}`);
    const s = await call("bot_status", {});
    assert.ok((s.health ?? 0) > 0, `must be alive, not drowned: ${JSON.stringify(s)}`);
    assert.ok(s.pos.x >= X + 13,
      `must be PHYSICALLY across the channel, at x=${s.pos.x} (shore is x=${X + 13})`);
    assert.ok(Math.abs(s.pos.y - (Y + 1)) < 1.2,
      `must have climbed OUT onto the walk level, at y=${s.pos.y}`);
  });

  // ---- the swim RIGHT is honoured by the body, not only by the planner --------

  // The regression that killed a watched survival session (2026-08-01). `swim:false` reached the
  // SEARCH and nothing else: `Bodies.PlayerNav` hardcoded NavProfile.DEFAULT, so the walking
  // navigation always planned with the swim right, and `NavDriver` asked `body.canSwim()` — the
  // body's INTRINSIC ability, hardcoded true — instead of the navigation's grant. A "reach the
  // shore on land" goal therefore planned a water route, swam it, dove, and drowned the body.
  // check_path already covered the planner (PREDICTION above); this covers the body.
  test("SWIM RIGHT: swim:false refuses the crossing instead of swimming it anyway", async (t) => {
    if (!bridgeUp) return t.skip();
    await spawnPlayer({ x: X + 1.5, y: Y + 1, z: CHANNEL + 0.5 });
    const r = await call("bot_goto", {
      to: { x: X + 15, y: Y + 1, z: CHANNEL }, swim: false, wait: true });

    // Whatever it reports, the one unacceptable outcome is arriving — that means it swam.
    assert.notEqual(r.outcome, "arrived",
      `swim:false must NOT cross open water: ${JSON.stringify(r)}`);
    // …and the rights it ran under are echoed, so the caller can see they were applied at all.
    assert.equal(r.profile?.swim, false,
      `the verdict must echo the swim right it ran with: ${JSON.stringify(r.profile)}`);

    const s = await call("bot_status", {});
    assert.ok((s.health ?? 0) > 0, `must be alive: ${JSON.stringify(s)}`);
    assert.ok(s.pos.x < X + 6,
      `must still be on the NEAR shore, not in or past the channel (x=${s.pos.x}, water starts x=${X + 5})`);
    // `submerged`, not `inWater`: the flat shoreline's spill sheet (see staging) wets the lip the
    // body correctly holds at. The drowning regression this guards is the body ENTERING the water
    // column — swimming or diving — which is exactly what submerged detects and position confirms.
    assert.equal(s.submerged ?? false, false,
      `a land-only route must never submerge the body: ${JSON.stringify(s)}`);
  });

  test("SWIM RIGHT: the same goal WITH swim still crosses (the fix is not a blanket refusal)", async (t) => {
    if (!bridgeUp) return t.skip();
    await spawnPlayer({ x: X + 1.5, y: Y + 1, z: CHANNEL + 0.5 });
    const r = await call("bot_goto", {
      to: { x: X + 15, y: Y + 1, z: CHANNEL }, swim: true, wait: true });
    assert.equal(r.outcome, "arrived", `swim:true must still cross: ${JSON.stringify(r)}`);
    assert.equal(r.profile?.swim, true, "…and echo the right it used");
  });

  // ---- vertical swim edges ----------------------------------------------------

  test("DIVE: an underwater goal at the pool floor is reached", async (t) => {
    if (!bridgeUp) return t.skip();
    await spawnPlayer({ x: X + 1.5, y: Y + 1, z: POOL + 0.5 });
    const r = await call("bot_target", {
      action: "move", target: { at: { x: X + 8, y: Y - 7, z: POOL } }, wait: true });
    assert.ok(r.outcome === "achieved" || r.outcome === "already_there",
      `the dive goal must be achieved: ${JSON.stringify(r)}`);
    const s = await call("bot_status", {});
    assert.ok(s.pos.y <= Y - 5,
      `must actually be DOWN at the pool floor, at y=${s.pos.y} (floor feet cell ${Y - 7})`);
    assert.ok((s.health ?? 0) > 0, `alive at depth: ${JSON.stringify(s)}`);
  });

  test("AIR: surfacing from the pool floor ends alive, not drowned", async (t) => {
    if (!bridgeUp) return t.skip();
    // The body is at the pool floor from the dive above. Send it back to the far shore: the route out
    // is a long submerged leg, so SwimControl has to breathe mid-route rather than let the goal die.
    const r = await call("bot_goto", { to: { x: X + 15, y: Y + 1, z: POOL }, wait: true });
    const s = await call("bot_status", {});
    assert.ok((s.health ?? 0) > 0,
      `must survive the ascent — drowning here means air management never fired: ${JSON.stringify(s)}`);
    assert.equal(r.outcome, "arrived", `must reach the far shore: ${JSON.stringify(r)}`);
    assert.ok(s.pos.y >= Y, `must have surfaced and climbed out, at y=${s.pos.y}`);
  });

  // ---- the stall watchdog -----------------------------------------------------

  test("STALL: a route walled off mid-flight ENDS, and says it was wedged", async (t) => {
    if (!bridgeUp) return t.skip();
    await spawnPlayer({ x: X + 1.5, y: Y + 1, z: CORRIDOR + 0.5 });
    // Start the move, then wall the corridor while the body is walking it. The path was valid when
    // solved and is unfollowable a second later — the exact shape of the live hang.
    const moving = call("bot_goto", { to: { x: X + 15, y: Y + 1, z: CORRIDOR }, wait: true });
    await sleep(700);
    await cmd(`fill ${X + 8} ${Y + 1} ${CORRIDOR - 1} ${X + 8} ${Y + 3} ${CORRIDOR + 1} minecraft:stone`);

    // The whole point: this RESOLVES. A hang fails the test by timing out here rather than by
    // asserting anything — which is the honest shape, because "waits forever" has no return value.
    const r = await Promise.race([
      moving,
      sleep(30_000).then(() => { throw new Error("bot_goto never returned — the stall watchdog did not fire"); }),
    ]);
    assert.equal(r.arrived, false, `walled off, so it cannot have arrived: ${JSON.stringify(r)}`);
    assert.equal(r.outcome, "stalled",
      `a body wedged against a new wall is STALLED, not merely stopped_short: ${JSON.stringify(r)}`);
    assert.ok(typeof r.stalled_after_ticks === "number",
      `the verdict must say how long it hung on: ${JSON.stringify(r)}`);
    // 0.45.0: the follower detects the impassable node the tick it becomes next and NAMES it —
    // `blocked_on` carries the wall cell so the remedy is targeted, not "somewhere behind you".
    // (Before, the body shoved the wall until the node timeout and the note could only say
    // "wedged".) Either form must still warn that re-issuing changes nothing.
    if (r.blocked_on) {
      assert.equal(r.blocked_on.x, X + 8,
        `blocked_on must name the wall that was dropped: ${JSON.stringify(r.blocked_on)}`);
      assert.match(r.blocked_on.block ?? "", /stone/, JSON.stringify(r.blocked_on));
    }
    assert.ok(/wedged|re-issu/i.test(r.note ?? ""),
      `the note must warn against re-issuing the same call: ${JSON.stringify(r.note)}`);
  });

  test("cleanup", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "despawn" }).catch(() => {});
    await cmd(`forceload remove ${X - 32} ${Z - 32} ${X + 40} ${Z + 96}`);
  });
});
