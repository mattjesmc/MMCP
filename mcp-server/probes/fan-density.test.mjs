// Live probe for the retina's SAMPLING DENSITY — PERCEPTION_NAV_FIXES.md §1.4, batch 1.
//
// Eleven survival sessions never once saw a `*_log` in a spruce taiga (0 of 28 scans). The reason
// was not occlusion and not the search: the fan was capped at FAN_MAX_RAYS = 64, so a 120° cone was
// sampled at 15° steps, and at 15° adjacent rays are 8.4 blocks apart at range 32. A tree is
// narrower than the gap between the rays looking for it, so whole trees fell through the grid — a
// 5-wide canopy subtends 8.9° against a 15° grid, ≈35% hit probability. The bot was not
// misinterpreting what it saw; it was sampling a scene at 65 scattered dots and reasoning about the
// dots.
//
// What this defends, and what would have caught it: FOUR three-wide pillars at 24 blocks, spread
// across the cone, must ALL be seen in one fan. Each subtends 7.2°, so at the scan grid's 3.87°
// step every pillar is struck by construction, while at the old 15° step they are found by luck.
// The probe also pins the cap itself — the dense call is 1024 rays and would have been REFUSED
// outright ("exceeds the cap of 64 rays") before this batch.
//
// Staged at a probe-owned coordinate (3.96M), in the air at y=200 so natural terrain cannot
// occlude the sightlines or move the answer between runs. Own session. `npm run test:live`.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const X = 3_960_000, Z = 3_960_000, Y = 200;
const SESSION = "probe-fan-density";

// The body looks north (yaw 180 = −Z), so the pillars stand at −Z, spread across its cone.
const DZ = 24;
const PILLAR_X = [-9, -3, 3, 9];
const PILLAR_H = 4;

// The two budgets, mirrored from mcp-server/memory/ambient.mjs. Stated as literals on purpose: this
// probe defends the GEOMETRY those numbers buy, so importing them would let a future edit move the
// constants and the assertion together and call it green.
const CONE = { h_fov: 120, v_fov: 60, range: 32, load: false };
const SCAN_GRID = { steps_h: 31, steps_v: 31 };     // 961 rays — a deliberate look, ODD so one ray looks dead ahead
const AMBIENT_GRID = { steps_h: 9, steps_v: 5 };    // 45 rays — the every-2s retina

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

let bridgeUp = true;
try {
  await call("ping");
} catch {
  bridgeUp = false;
}

/** Which pillars a fan's rays actually struck, by the x-offset that identifies each one. */
function pillarsSeen(fan) {
  const hit = new Set();
  for (const row of fan.rays ?? []) {
    // Block rows are [dYaw, dPitch, "b", id, dist, x, y, z].
    if (row[2] !== "b" || !String(row[3]).endsWith("oak_log")) continue;
    const dx = row[5] - X;
    for (const px of PILLAR_X) {
      if (Math.abs(dx - px) <= 1) hit.add(px);
    }
  }
  return hit;
}

describe("fan density (0.53.0): a tree cannot fall between the rays looking for it", { skip: !bridgeUp }, () => {
  test("stage four pillars across the cone", async (t) => {
    if (!bridgeUp) return t.skip();
    await cmd(`forceload add ${X - 48} ${Z - 48} ${X + 48} ${Z + 48}`);
    await sleep(3000);
    // A clean air box with one platform to stand on: no natural terrain in any sightline.
    await cmd(`fill ${X - 32} ${Y - 2} ${Z - 40} ${X + 32} ${Y + 12} ${Z + 8} minecraft:air`);
    await cmd(`fill ${X - 3} ${Y - 1} ${Z - 3} ${X + 3} ${Y - 1} ${Z + 3} minecraft:stone`);
    for (const px of PILLAR_X) {
      await cmd(`fill ${X + px - 1} ${Y} ${Z - DZ - 1} ${X + px + 1} ${Y + PILLAR_H} ${Z - DZ + 1} minecraft:oak_log`);
    }
    // No item entities or mobs in the cone — a sheep in front of a pillar would eat the ray.
    await call("run_command", {
      command: `execute positioned ${X} ${Y} ${Z} run kill @e[type=!player,distance=..60]`,
    });
    await call("bot_body", { action: "despawn" }).catch(() => {});
    const spawned = await call("bot_body", { action: "spawn", type: "player", pos: { x: X, y: Y, z: Z } });
    assert.ok(spawned, "the body must spawn on the platform");
    await sleep(3500);
  });

  test("the scan grid sees every pillar; the old 15° grid could not", async (t) => {
    if (!bridgeUp) return t.skip();
    const dense = await call("raycast_fan", { drone: true, yaw: 180, pitch: 0, ...CONE, ...SCAN_GRID });

    assert.equal(dense.rays_cast, 961,
      "a deliberate scan casts 961 rays (31x31, ODD so one ray looks dead ahead) — before this batch "
      + "FAN_MAX_RAYS was 64 and a call this dense was REFUSED outright");

    const seen = pillarsSeen(dense);
    assert.deepEqual([...seen].sort((a, b) => a - b), PILLAR_X,
      `every pillar subtends 7.2° against a 3.87° grid, so all four must be struck — saw ${[...seen]}`);

    // The measurement that decides what later batches can afford (§1.4). Reported, and bounded only
    // loosely: this asserts the fan is not pathological, not that a particular machine is fast.
    assert.ok(typeof dense.ms === "number", "a fan must report what it cost");
    assert.ok(dense.ms < 50, `1024 rays took ${dense.ms}ms — that is a whole server tick, something regressed`);
    console.log(`      # 1024 rays: ${dense.ms}ms, pillars seen ${seen.size}/4`);
  });

  test("the ambient retina stays cheap — its density is a separate budget", async (t) => {
    if (!bridgeUp) return t.skip();
    const sparse = await call("raycast_fan", { drone: true, yaw: 180, pitch: 0, ...CONE, ...AMBIENT_GRID });
    assert.equal(sparse.rays_cast, 45, "the retina keeps its 45 rays — it fires every 2s and must not tax the tick");
    assert.ok(sparse.ms < 5, `the ambient fan cost ${sparse.ms}ms; it runs every 2 seconds forever`);

    // The aliasing itself, shown rather than asserted: at 15° steps this grid finds the pillars by
    // luck. It is allowed to find all four — the claim under test is that the DENSE grid does not
    // depend on luck — so this is reported, never failed on.
    console.log(`      # 45 rays: ${sparse.ms}ms, pillars seen ${pillarsSeen(sparse).size}/4`);
  });

  test("one entity query per fan, not one per ray: a crowd does not multiply the cost", async (t) => {
    if (!bridgeUp) return t.skip();
    // The hoist (§1.4 fix 1). Un-hoisted, every ray ran its own getEntities over the whole cone, so
    // this staging measured 6.4ms mean / 12ms worst against 3.8 / 4.8 hoisted at 1024 rays. The
    // bound here is deliberately loose — it defends the ORDER (a crowd is not a multiplier), which
    // is the property that regresses if someone moves the query back inside the loop.
    const before = await call("raycast_fan", { drone: true, yaw: 180, pitch: 0, ...CONE, ...SCAN_GRID });
    for (let i = 0; i < 40; i++) {
      const ang = (i / 40) * Math.PI * 2;
      const px = Math.round(X + Math.cos(ang) * (5 + (i % 5) * 3));
      const pz = Math.round(Z - 6 + Math.sin(ang) * (5 + (i % 5) * 3));
      await cmd(`summon minecraft:sheep ${px} ${Y} ${pz} {NoAI:1b,PersistenceRequired:1b}`);
    }
    await sleep(1200);
    const after = await call("raycast_fan", { drone: true, yaw: 180, pitch: 0, ...CONE, ...SCAN_GRID });
    console.log(`      # 1024 rays: ${before.ms}ms empty -> ${after.ms}ms with 40 mobs in the cone`);
    assert.ok(after.ms < before.ms + 25,
      `a crowd added ${(after.ms - before.ms).toFixed(2)}ms to one fan — the entity query is back inside the ray loop`);

    await call("run_command", {
      command: `execute positioned ${X} ${Y} ${Z} run kill @e[type=!player,distance=..60]`,
    });
  });

  test("teardown: leave the site as it was found", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "despawn" }).catch(() => {});
    await call("run_command", {
      command: `execute positioned ${X} ${Y} ${Z} run kill @e[type=!player,distance=..60]`,
    });
    await cmd(`forceload remove ${X - 48} ${Z - 48} ${X + 48} ${Z + 48}`);
  });
});
