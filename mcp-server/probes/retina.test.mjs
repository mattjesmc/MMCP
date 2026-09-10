// Live probes for the RETINA's occlusion model — PERCEPTION_NAV_FIXES.md §1.1–1.3, batch 2.
//
// The fan used to ask vanilla one question — `clip(… Block.OUTLINE, Fluid.NONE …)` — and use the
// answer as both "what did I see" and "where does my view end". Those are different questions, and
// conflating them is the single root cause behind most of the human's report ("walking into water,
// getting stuck in water, can't find trees, vision lacks handling of opaque leaves"). Three defects
// fell out of the one line, and each gets a test here:
//
//   §1.1 water and lava were INVISIBLE (Fluid.NONE passes through and reports the lake bottom), so
//        the body read walkable sand under six feet of water and walked in. 0 of 62 scans ever saw
//        water — including one taken while submerged in an ocean.
//   §1.2 leaves were OPAQUE (under OUTLINE a leaf is a full cube), so every tree was a hollow shell
//        with an invisible trunk. 0 of 28 scans in a spruce taiga ever saw a log.
//   §1.3 clutter was a WALL (a grass tuft is a full OUTLINE hit), so 23.3% of hits landed on
//        walk-through blocks and 40.1% of sector horizons died under 2 blocks — the bot was told it
//        was enclosed while standing in an open field.
//
// Each test stages the exact scene the sessions were in and asserts the thing they could not do.
// Staged at a probe-owned coordinate (3.97M) in the air at y=200, so natural terrain cannot occlude
// a sightline or move an answer between runs. Own session. `npm run test:live`.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const X = 3_970_000, Z = 3_970_000, Y = 200;
const SESSION = "probe-retina";

const CONE = { h_fov: 120, v_fov: 60, range: 32, load: false, steps_h: 32, steps_v: 32 };

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

/**
 * `/fill` that actually verifies it filled. Two traps stack here and cost this file three debugging
 * rounds: `run_command` answers ok:true for a command the GAME rejected, and `/fill` refuses any box
 * over 32768 blocks. A clear box of 81x21x49 = 83,349 therefore did nothing, silently, so every run
 * staged on top of the previous run's leftovers and the retina was blamed for geometry that was
 * never removed. Staging that cannot fail loudly is staging you cannot trust.
 */
async function fill(spec) {
  const r = await cmd(`fill ${spec}`);
  const out = (r.output ?? []).join(" ");
  // "No blocks were filled" is SUCCESS — a region that is already air fills to nothing. What must
  // never pass silently is the cap ("Too many blocks in the specified area"), unloaded chunks, or a
  // syntax rejection, all of which the game reports while run_command still answers ok:true.
  if (!out || /Too many blocks|not loaded|Invalid|Expected|Unknown|Incorrect/i.test(out)) {
    throw new Error(`staging fill did NOT run: "fill ${spec}" -> ${out || "(no output)"}`);
  }
  return r;
}

/** Clear the site in slabs, because one box big enough to hold it would exceed /fill's 32768 cap. */
async function clearSite() {
  for (let y = Y - 8; y <= Y + 8; y += 8) {
    await fill(`${X - 28} ${y} ${Z - 22} ${X + 24} ${Math.min(y + 7, Y + 8)} ${Z + 14} minecraft:air`);
  }
}

let bridgeUp = true;
try {
  await call("ping");
} catch {
  bridgeUp = false;
}

/** Every block id a fan's rows carry, mapped to the distinct positions it was seen at. */
function seenBlocks(fan) {
  const by = new Map();
  for (const row of fan.rays ?? []) {
    if (!Array.isArray(row) || row.length < 8 || row[2] !== "b") continue;
    const id = String(row[3]).replace("minecraft:", "");
    if (!by.has(id)) by.set(id, new Set());
    by.get(id).add(`${row[5]},${row[6]},${row[7]}`);
  }
  return by;
}

/** The distance each ray's view actually ENDED at — the horizon it reports, per §1.3. */
function horizons(fan) {
  // A ray contributes several rows now (what it passed through, then what stopped it). The horizon
  // is the farthest of them: pass-through cells are always nearer than the wall behind them.
  const far = new Map();
  for (const row of fan.rays ?? []) {
    if (!Array.isArray(row) || row.length < 3) continue;
    const key = `${row[0]},${row[1]}`;
    const d = row[2] === "m" ? (fan.range ?? 32)
      : row[2] === "u" ? Number(row[3])
      : Number(row[4]);
    if (!Number.isFinite(d)) continue;
    if (!far.has(key) || far.get(key) < d) far.set(key, d);
  }
  return [...far.values()];
}

const scan = (yaw, pitch = 0) => call("raycast_fan", { drone: true, yaw, pitch, ...CONE });

describe("the retina (0.53.0): seen is not the same question as occluding", { skip: !bridgeUp }, () => {
  test("stage the scenes", async (t) => {
    if (!bridgeUp) return t.skip();
    await cmd(`forceload add ${X - 48} ${Z - 48} ${X + 48} ${Z + 48}`);
    await sleep(3000);
    await clearSite();
    await fill(`${X - 4} ${Y - 1} ${Z - 4} ${X + 4} ${Y - 1} ${Z + 4} minecraft:stone`);

    // NORTH (yaw 180): a contained pool with a SAND bottom. Sand is the tell — under Fluid.NONE the
    // rays reported exactly this sand and called it walkable ground.
    // A solid CLAY mass with a water pocket carved into it, so the pool has a bottom on every side
    // the rays can reach. Two staging traps already caught here, both of which read exactly like a
    // retina defect: `fill … hollow` lays a floor of its OWN material and buried the bottom; and the
    // first bottom material was SAND, which is gravity-affected — built floating in a cleared air
    // box it collapsed on the first tick and the water flooded the whole cavity, so the fan honestly
    // reported a pool with no bottom. Use a block that neither falls nor flows.
    // Sunk BELOW eye level, with no rim standing above the water. A basin whose lip reached eye
    // height is opaque clay across the whole sightline, so the water behind it is correctly never
    // seen — a third staging trap that reads as "water is still invisible".
    await fill(`${X - 5} ${Y - 7} ${Z - 19} ${X + 5} ${Y - 1} ${Z - 9} minecraft:clay`);
    await fill(`${X - 4} ${Y - 4} ${Z - 18} ${X + 4} ${Y - 1} ${Z - 10} minecraft:water`);

    // EAST (yaw -90): an oak with a full leaf shell around a trunk — the taiga scene.
    await fill(`${X + 18} ${Y} ${Z} ${X + 18} ${Y + 5} ${Z} minecraft:oak_log`);
    await fill(`${X + 16} ${Y + 3} ${Z - 2} ${X + 20} ${Y + 6} ${Z + 2} minecraft:oak_leaves replace minecraft:air`);

    // WEST (yaw 90): clutter at the body's feet, a real wall 25 blocks out. The 40.1%-of-horizons
    // defect in one scene — the grass was reported as the end of the sightline.
    await fill(`${X - 2} ${Y} ${Z - 2} ${X - 2} ${Y} ${Z + 2} minecraft:short_grass`);
    await cmd(`setblock ${X - 3} ${Y} ${Z} minecraft:snow`);
    await fill(`${X - 25} ${Y - 1} ${Z - 6} ${X - 25} ${Y + 6} ${Z + 6} minecraft:stone`);

    await call("run_command", {
      command: `execute positioned ${X} ${Y} ${Z} run kill @e[type=!player,distance=..60]`,
    });
    await call("bot_body", { action: "despawn" }).catch(() => {});
    await call("bot_body", { action: "spawn", type: "player", pos: { x: X, y: Y, z: Z } });
    await sleep(3500);
  });

  test("§1.1 water is SEEN — and the bottom behind it is still reported", async (t) => {
    if (!bridgeUp) return t.skip();
    const seen = seenBlocks(await scan(180));

    assert.ok(seen.has("water"),
      `water must appear in what the rays saw — it appeared in 0 of 62 survival scans. Saw: ${[...seen.keys()]}`);
    // The reason the old code passed through fluids was that the bottom is real information. It
    // still is: recording water must not cost us the bottom, or this trades one blindness for
    // another. The precise claim is see-THROUGH, so assert it precisely: some column must have been
    // seen as water at one height and as pool bottom lower down. A ray that stopped at the surface
    // could never produce that pair.
    assert.ok(seen.has("clay"),
      `the pool bottom must still be reported behind the water. Saw: ${[...seen.keys()]}`);
    // Seeing-through is a claim about PROVENANCE, so read the provenance rather than reconstructing
    // it from coordinates. Rows carry a trailing "wf" when the cell was seen across a fluid. (Two
    // position-based versions of this assertion were wrong before this one: rays enter at a shallow
    // angle and travel many blocks sideways per block of depth, so they never reach the floor under
    // the water cell they crossed — they exit through the far wall instead.)
    const fan = await scan(180);
    const acrossWater = (fan.rays ?? []).filter((r) => r[2] === "b" && r[8] === "wf");
    assert.ok(acrossWater.length > 0,
      "no cell was reported as seen ACROSS water — the rays are stopping at the surface, and the "
      + "navigation side has no way to know a 'walkable' cell is under six feet of water");
    assert.ok(acrossWater.some((r) => String(r[3]).endsWith("clay")),
      `the pool's own bottom/walls must be among what was seen through the water. Across-water: `
      + `${[...new Set(acrossWater.map((r) => String(r[3]).replace("minecraft:", "")))]}`);
  });

  test("§1.2 a leaf canopy does not hide the trunk inside it", async (t) => {
    if (!bridgeUp) return t.skip();
    const seen = seenBlocks(await scan(-90));

    assert.ok(seen.has("oak_leaves"), `the canopy itself must still be seen. Saw: ${[...seen.keys()]}`);
    assert.ok(seen.has("oak_log"),
      `the trunk INSIDE the canopy must be seen — 28 taiga scans never saw one, and a session wrote `
      + `"spruce tree exhausted" 20s before a ray found a log at distance 1. Saw: ${[...seen.keys()]}`);
  });

  test("§1.3 clutter is seen but is not a wall", async (t) => {
    if (!bridgeUp) return t.skip();
    const fan = await scan(90);
    const seen = seenBlocks(fan);

    assert.ok(seen.has("short_grass"), "grass must still be RECORDED — the fix is not 'ignore clutter'");
    assert.ok(seen.has("stone"),
      `the wall behind the grass must be seen; before the fix the grass WAS the reported hit. Saw: ${[...seen.keys()]}`);

    // The horizon claim, which is what open_directions and the "sealed in rock" render read. With a
    // grass tuft 2 blocks away and a wall at 25, the old model reported a 2-block horizon for most
    // of this cone: 40.1% of all sector horizons died under 2 blocks across eleven sessions.
    const hs = horizons(fan);
    const stunted = hs.filter((d) => d < 2).length;
    assert.ok(stunted / hs.length < 0.1,
      `${stunted}/${hs.length} sightlines ended under 2 blocks in an open field — clutter is still walling the view`);
    const median = hs.sort((a, b) => a - b)[Math.floor(hs.length / 2)];
    assert.ok(median > 8, `median horizon ${median} in a cone whose only real obstacle is 25 blocks out`);
  });

  test("§1.3 the opacity budget still stops a ray — see-through is not X-ray", async (t) => {
    if (!bridgeUp) return t.skip();
    // A thick leaf mass must NOT be transparent, or the retina becomes an X-ray and the legal
    // profile's whole "you only know what you have seen" contract is void. Six metres of solid
    // leaves, with a marker block behind it that must stay unseen.
    await fill(`${X - 6} ${Y} ${Z + 4} ${X + 6} ${Y + 4} ${Z + 9} minecraft:oak_leaves`);
    await fill(`${X - 6} ${Y} ${Z + 11} ${X + 6} ${Y + 4} ${Z + 11} minecraft:gold_block`);
    await sleep(400);

    const seen = seenBlocks(await scan(0));
    assert.ok(seen.has("oak_leaves"), "the leaf mass itself is seen");
    assert.ok(!seen.has("gold_block"),
      "six blocks of solid leaves must exhaust the opacity budget — seeing through them would make "
      + "the retina an X-ray and void the legal profile's provenance contract");
  });

  test("teardown: leave the site as it was found", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "despawn" }).catch(() => {});
    await call("run_command", {
      command: `execute positioned ${X} ${Y} ${Z} run kill @e[type=!player,distance=..60]`,
    });
    await clearSite();
    await cmd(`forceload remove ${X - 48} ${Z - 48} ${X + 48} ${Z + 48}`);
  });
});
