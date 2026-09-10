// Spatial predicates: the toolkit answers geometry, the model stops doing coordinate arithmetic.
//
// check_fit / check_clearance / check_path / check_site (REPRESENTATION_DESIGN.md §1). Staged
// terrain via set_blocks at coordinates far from anything else; every stage is forceloaded within
// the ≤256-chunks-per-command budget and undone/removed after. Invariants under test:
//
//   1. fit         → clear volume fits; one block in the footprint flips the verdict and is named;
//                    clearance shell catches obstructions outside the bare footprint; template form
//                    resolves a real size; oversized volume fails fast (too_large, not truncation).
//   2. clearance   → open corridor clear; a wall across it reports the first obstruction; the
//                    profile height finds low ceilings a 1-block walk would miss.
//   3. path        → a walled pit is reachable:false for a walker but reachable:true for a flyer
//                    (the body argument is real, not a label); an open walk is reachable with
//                    nodes; a sealed target is partial with the end stopping short.
//   4. site        → hand-built two-level terrace yields exactly computable min/max/mean/stddev
//                    and cut/fill; water columns counted; flat ground hints flat.
//   5. honesty     → any predicate over never-generated terrain returns a null verdict with
//                    coverage.state none/partial and the forceload remedy named — a verdict is
//                    never issued over unread space.
//
// Live probe: needs the dev server (`gradlew runServer`). Skips itself when the bridge is down.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const Y = 200;
// Far from spawn, from the perception-coverage sites, and from each other.
const FIT = { x: 1100000, z: 1100000 };
const CORRIDOR = { x: 1200000, z: 1200000 };
const PATHS = { x: 1300000, z: 1300000 };
const SITE = { x: 1400000, z: 1400000 };
const VIRGIN = { x: 1600000, z: 1600000 }; // never loaded, never generated

async function call(tool, args = {}) {
  const res = await fetch(`${BASE}/cmd`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool, args }),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(`${tool} failed: ${JSON.stringify(j.error)}`);
  return j.result;
}
const cmd = (c) => call("run_command", { command: c });

async function callRaw(tool, args = {}) {
  const res = await fetch(`${BASE}/cmd`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool, args }),
  });
  return res.json();
}

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok)
  .catch(() => false);
if (!bridgeUp) {
  console.log(`\n  [skip] no bridge at ${BASE} — start the dev server to run these probes\n`);
}

/** Stage a site: forceload its chunks, run fn, then unload again. */
async function staged(at, radius, fn) {
  await cmd(`forceload add ${at.x - radius} ${at.z - radius} ${at.x + radius} ${at.z + radius}`);
  try {
    return await fn();
  } finally {
    await cmd(`forceload remove ${at.x - radius} ${at.z - radius} ${at.x + radius} ${at.z + radius}`);
  }
}

/** Idempotency: clear a box before use — leftovers from a prior (or failed) run must not leak in. */
const clearBox = (x1, y1, z1, x2, y2, z2) =>
  cmd(`fill ${x1} ${y1} ${z1} ${x2} ${y2} ${z2} minecraft:air`);

/** A flat floor of `block` centred at (at.x, y-1, at.z), half-width r. */
function floor(at, y, r, block) {
  const blocks = [];
  for (let x = at.x - r; x <= at.x + r; x++)
    for (let z = at.z - r; z <= at.z + r; z++)
      blocks.push({ x, y, z, block });
  return call("set_blocks", { blocks });
}

function assertClosedAccounting(cov, where) {
  assert.equal(
    cov.read + cov.unloaded + cov.unvisited, cov.requested,
    `${where}: coverage accounting does not close: ${JSON.stringify(cov)}`);
}

/** Every predicate response rides the shared observe contract. */
function assertEnvelope(r, where) {
  assert.equal(r.perception_mode, "spatial", `${where}: perception_mode`);
  assert.equal(typeof r.game_tick, "number", `${where}: game_tick`);
  assert.equal(r.dimension, "minecraft:overworld", `${where}: dimension`);
  assert.ok(r.coverage, `${where}: coverage missing`);
  assertClosedAccounting(r.coverage, where);
}

// Fit via locate at+clear — the 0.22.0 fold: a batch of `clear` checks over a box's cells IS the
// fit verdict (check.all_matched), with mismatches as the conflict list. The old shell
// conveniences (margin/above) are just more cells; the 64³ cap became locate's 64-position batch
// cap (split calls or use describe_box for bigger volumes).
const boxCells = (at, size, extra = {}) => {
  const cells = [];
  for (let dx = 0; dx < size.w; dx++) {
    for (let dy = 0; dy < size.h; dy++) {
      for (let dz = 0; dz < size.d; dz++) {
        cells.push({ x: at.x + dx, y: at.y + dy, z: at.z + dz, clear: true, ...extra });
      }
    }
  }
  return cells;
};

describe("fit via locate at+clear (check_fit fold-in)", { skip: !bridgeUp }, () => {
  test("clear volume fits; one obstruction flips the verdict and is named", async () => {
    await staged(FIT, 20, async () => {
      const at = { x: FIT.x, y: Y, z: FIT.z };
      await clearBox(FIT.x - 2, Y, FIT.z - 2, FIT.x + 10, Y + 6, FIT.z + 12);
      const size = { w: 4, h: 3, d: 4 }; // 48 cells — inside the 64-position batch cap
      const clear = await call("locate", { at: boxCells(at, size) });
      assert.equal(clear.check.all_matched, true, JSON.stringify(clear.check));
      assert.equal(clear.check.mismatched, 0);
      assert.equal(clear.coverage.state, "complete");
      assert.equal(clear.check.expected, 48);

      // One block inside the box: all_matched flips and the mismatch names what stands there.
      const obstruction = { x: FIT.x + 2, y: Y + 1, z: FIT.z + 3, block: "minecraft:stone" };
      await call("set_blocks", { blocks: [obstruction] });
      const blocked = await call("locate", { at: boxCells(at, size) });
      assert.equal(blocked.check.all_matched, false);
      assert.equal(blocked.check.mismatched, 1);
      assert.equal(blocked.mismatches[0].x, obstruction.x);
      assert.equal(blocked.mismatches[0].actual, "minecraft:stone");
      assert.match(blocked.mismatches[0].expected, /clear/i);
      await call("set_blocks", { blocks: [{ ...obstruction, block: "minecraft:air" }] });
    });
  });

  test("replaceable growth is clear (the SiteCheck predicate), and clear+expect is refused", async () => {
    await staged(FIT, 20, async () => {
      const at = { x: FIT.x + 20, y: Y, z: FIT.z + 20 };
      await clearBox(at.x - 1, Y, at.z - 1, at.x + 5, Y + 4, at.z + 5);
      await call("set_blocks", { blocks: [
        { x: at.x + 1, y: at.y, z: at.z + 1, block: "minecraft:short_grass" },
        { x: at.x + 2, y: at.y, z: at.z + 2, block: "minecraft:water" },
      ] });
      const r = await call("locate", { at: boxCells(at, { w: 4, h: 3, d: 4 }) });
      assert.equal(r.check.all_matched, true,
        `grass/water are replaceable, not conflicts: ${JSON.stringify(r.mismatches)}`);
      const both = await callRaw("locate", { at: [{ x: at.x, y: at.y, z: at.z, clear: true, expect: "minecraft:air" }] });
      assert.equal(both.ok, false, "clear and expect are different predicates — never both");
      assert.match(String(both.error), /not both/i);
      await call("set_blocks", { blocks: [
        { x: at.x + 1, y: at.y, z: at.z + 1, block: "minecraft:air" },
        { x: at.x + 2, y: at.y, z: at.z + 2, block: "minecraft:air" },
      ] });
    });
  });
});

describe("corridor via check_site from/to (check_clearance fold-in)", { skip: !bridgeUp }, () => {
  test("open corridor is clear; a wall names the first obstruction; height matters", async () => {
    await staged(CORRIDOR, 20, async () => {
      const from = { x: CORRIDOR.x, y: Y, z: CORRIDOR.z };
      const to = { x: CORRIDOR.x + 12, y: Y, z: CORRIDOR.z };
      await clearBox(CORRIDOR.x - 1, Y, CORRIDOR.z - 2, CORRIDOR.x + 13, Y + 3, CORRIDOR.z + 2);
      const open = await call("check_site", { from, to, profile: { w: 1, h: 2 } });
      assertEnvelope(open, "corridor/open");
      assert.equal(open.clear, true, JSON.stringify(open));
      assert.equal(open.obstruction_count, 0);

      // Wall across the corridor at x+6, full height of the profile.
      await call("set_blocks", { blocks: [
        { x: CORRIDOR.x + 6, y: Y, z: CORRIDOR.z, block: "minecraft:stone" },
        { x: CORRIDOR.x + 6, y: Y + 1, z: CORRIDOR.z, block: "minecraft:stone" },
      ] });
      const walled = await call("check_site", { from, to, profile: { w: 1, h: 2 } });
      assert.equal(walled.clear, false);
      assert.equal(walled.obstruction_count, 2);
      assert.equal(walled.first_obstruction.x, CORRIDOR.x + 6);
      assert.equal(walled.first_obstruction.block, "minecraft:stone");

      // A lintel only at head height: a 1-tall profile squeezes under, a 2-tall does not.
      await call("set_blocks", { blocks: [
        { x: CORRIDOR.x + 6, y: Y, z: CORRIDOR.z, block: "minecraft:air" },
      ] });
      const under = await call("check_site", { from, to, profile: { w: 1, h: 1 } });
      assert.equal(under.clear, true, "1-tall profile passes under the lintel");
      const bonk = await call("check_site", { from, to, profile: { w: 1, h: 2 } });
      assert.equal(bonk.clear, false, "2-tall profile hits the lintel");

      await call("set_blocks", { blocks: [
        { x: CORRIDOR.x + 6, y: Y + 1, z: CORRIDOR.z, block: "minecraft:air" },
      ] });
    });
  });

  test("box door: exact clearing count in one call (the t3 gap, 0.25.0)", async () => {
    await staged(CORRIDOR, 20, async () => {
      const b = { x: CORRIDOR.x, y: Y + 4, z: CORRIDOR.z };
      await clearBox(b.x - 1, b.y, b.z - 1, b.x + 5, b.y + 4, b.z + 5);
      await call("set_blocks", { blocks: [
        { x: b.x + 1, y: b.y + 1, z: b.z + 1, block: "minecraft:stone" },
        { x: b.x + 2, y: b.y + 2, z: b.z + 3, block: "minecraft:stone" },
        { x: b.x + 3, y: b.y, z: b.z + 2, block: "minecraft:short_grass" }, // replaceable = clear
      ] });
      const r = await call("check_site", {
        box: { min: b, max: { x: b.x + 4, y: b.y + 3, z: b.z + 4 } },
      });
      assert.equal(r.obstruction_count, 2, `grass is clear, stones are not: ${JSON.stringify(r.obstructions)}`);
      assert.equal(r.clear, false);
      assert.equal(r.obstructions.length, 2);
      assert.ok(r.region.min && r.region.max, "the box door echoes its region");
      assert.equal(r.coverage.state, "complete");
      // Partial read: never an exact count — null with a lower bound.
      const unread = await call("check_site", {
        box: { min: { x: VIRGIN.x, y: Y, z: VIRGIN.z }, max: { x: VIRGIN.x + 3, y: Y + 2, z: VIRGIN.z + 3 } },
      });
      assert.equal(unread.obstruction_count, null, "a partial count sold as exact is the confident-falsehood class");
      assert.equal(unread.clear, null);
      assert.equal(typeof unread.obstruction_count_lower_bound, "number");
      await call("set_blocks", { blocks: [
        { x: b.x + 1, y: b.y + 1, z: b.z + 1, block: "minecraft:air" },
        { x: b.x + 2, y: b.y + 2, z: b.z + 3, block: "minecraft:air" },
        { x: b.x + 3, y: b.y, z: b.z + 2, block: "minecraft:air" },
      ] });
    });
  });

  test("exactly one door per call", async () => {
    const none = await callRaw("check_site", { profile: { w: 1, h: 2 } });
    assert.equal(none.ok, false);
    assert.match(String(none.error), /exactly one door/i);
    const two = await callRaw("check_site", {
      at: { x: CORRIDOR.x, z: CORRIDOR.z },
      from: { x: CORRIDOR.x, y: Y, z: CORRIDOR.z },
      to: { x: CORRIDOR.x + 4, y: Y, z: CORRIDOR.z },
    });
    assert.equal(two.ok, false);
    assert.match(String(two.error), /exactly one door/i);
  });
});

describe("check_path", { skip: !bridgeUp }, () => {
  test("walker vs flyer: a walled pit divides the bodies; open ground walks", async () => {
    await staged(PATHS, 24, async () => {
      // A stone platform to walk on; the air above cleared of any prior run's wall.
      await floor(PATHS, Y - 1, 12, "minecraft:stone");
      await clearBox(PATHS.x - 12, Y, PATHS.z - 12, PATHS.x + 12, Y + 6, PATHS.z + 12);
      const from = { x: PATHS.x - 8, y: Y, z: PATHS.z };
      const to = { x: PATHS.x + 8, y: Y, z: PATHS.z };

      const walk = await call("check_path", { from, to });
      assertEnvelope(walk, "path/open");
      assert.equal(walk.reachable, true, JSON.stringify(walk));
      assert.equal(walk.body, "walker");
      assert.ok(walk.nodes > 0);

      // Wall the target in: a 5-high ring of stone around it (roof left open).
      const wall = [];
      for (let dy = 0; dy < 5; dy++)
        for (let dx = -2; dx <= 2; dx++)
          for (let dz = -2; dz <= 2; dz++)
            if (Math.abs(dx) === 2 || Math.abs(dz) === 2)
              wall.push({ x: to.x + dx, y: Y + dy, z: to.z + dz, block: "minecraft:stone" });
      await call("set_blocks", { blocks: wall });

      const walled = await call("check_path", { from, to });
      assert.equal(walled.reachable, false, `walker must not path over a 5-high wall: ${JSON.stringify(walled)}`);

      const flown = await call("check_path", { from, to, body: "flyer" });
      assert.equal(flown.reachable, true, `flyer goes over the open roof: ${JSON.stringify(flown)}`);
      assert.equal(flown.body, "flyer");

      // Budget-capped: the search hits the caller's ceiling while still expanding. Since 0.4.1
      // that is an honest NULL verdict with the remedy named — a truncated search must never
      // claim unreachability (the testbench t4 with-arm was misled by exactly that false).
      const capped = await call("check_path", { from, to: { x: PATHS.x + 20, y: Y, z: PATHS.z }, max_length: 8 });
      assert.equal(capped.reachable, null, `capped-while-expanding must be null: ${JSON.stringify(capped)}`);
      assert.match(capped.note ?? "", /max_length/, "the null verdict must name the remedy");
      assert.equal(capped.search?.stabilized, false);

      // And the detour class that motivated the fix: a target whose straight-line distance is
      // tiny but whose real path is ~4x longer (walk around the pit ring) now escalates to TRUE
      // instead of trusting the first truncated search.
      const detour = await call("check_path", { from: { x: to.x + 4, y: Y, z: to.z }, to: { x: to.x - 4, y: Y, z: to.z + 4 } });
      assert.equal(detour.reachable, true, `detour around the ring must escalate to reachable: ${JSON.stringify(detour)}`);
    });
  });
});

describe("check_site", { skip: !bridgeUp }, () => {
  test("terrace stats are exactly the hand-computed numbers; water counted", async () => {
    await staged(SITE, 20, async () => {
      // 4x4 site: west half stone at Y-1 (ground y = Y-1), east half raised one (ground y = Y).
      // Column grid x in [0..3]: x<2 low, x>=2 high → 8 low + 8 high.
      const blocks = [];
      for (let dx = 0; dx < 4; dx++)
        for (let dz = 0; dz < 4; dz++) {
          blocks.push({ x: SITE.x + dx, y: Y - 1, z: SITE.z + dz, block: "minecraft:stone" });
          if (dx >= 2) blocks.push({ x: SITE.x + dx, y: Y, z: SITE.z + dz, block: "minecraft:dirt" });
        }
      await call("set_blocks", { blocks });

      const r = await call("check_site", { at: { x: SITE.x, z: SITE.z }, size: { w: 4, d: 4 } });
      assertEnvelope(r, "site/terrace");
      assert.equal(r.coverage.state, "complete");
      assert.equal(r.ground_y.min, Y - 1);
      assert.equal(r.ground_y.max, Y);
      assert.equal(r.ground_y.mean, Y - 0.5);
      assert.equal(r.ground_y.stddev, 0.5);
      // target_y omitted → modal ground height; both heights tie at 8 columns each — accept either,
      // but cut/fill must be consistent with whichever won.
      if (r.target_y === Y - 1) {
        assert.equal(r.cut, 8, "8 high columns 1 above target");
        assert.equal(r.fill, 0);
      } else {
        assert.equal(r.target_y, Y);
        assert.equal(r.cut, 0);
        assert.equal(r.fill, 8, "8 low columns 1 below target");
      }
      // Explicit target: y = Y+1 → every column below: fill = 8*2 + 8*1 = 24, cut 0.
      const raised = await call("check_site", { at: { x: SITE.x, z: SITE.z }, size: { w: 4, d: 4 }, y: Y + 1 });
      assert.equal(raised.cut, 0);
      assert.equal(raised.fill, 24);
      assert.equal(raised.flat_enough_hint, true, "stddev 0.5 is within the 1.0 flat threshold");

      const surfaceTotal = Object.values(r.surface).reduce((s, n) => s + n, 0);
      assert.equal(surfaceTotal, 16, `surface histogram covers every column: ${JSON.stringify(r.surface)}`);
      assert.equal(r.surface["minecraft:dirt"], 8);
      assert.equal(r.surface["minecraft:stone"], 8);

      // Flat + water: flood a flat 3x3 next door with water on top.
      const wat = { x: SITE.x + 10, z: SITE.z + 10 };
      const wblocks = [];
      for (let dx = 0; dx < 3; dx++)
        for (let dz = 0; dz < 3; dz++) {
          wblocks.push({ x: wat.x + dx, y: Y - 1, z: wat.z + dz, block: "minecraft:stone" });
          wblocks.push({ x: wat.x + dx, y: Y, z: wat.z + dz, block: "minecraft:water" });
        }
      await call("set_blocks", { blocks: wblocks });
      const wet = await call("check_site", { at: { x: wat.x, z: wat.z }, size: { w: 3, d: 3 } });
      assert.equal(wet.fluids.water_columns, 9, JSON.stringify(wet.fluids));
      assert.equal(wet.flat_enough_hint, true, `flat water sheet: ${JSON.stringify(wet.ground_y)}`);
    });
  });
});

describe("predicates never issue a verdict over unread space", { skip: !bridgeUp }, () => {
  test("virgin terrain: null verdicts, honest coverage, forceload named", async () => {
    const at = { x: VIRGIN.x, y: Y, z: VIRGIN.z };

    // Fit fold-in: an unreadable cell can never count as a clear pass (-1 in the match slot).
    const fit = await call("locate", { at: [{ x: at.x, y: at.y, z: at.z, clear: true }], load: false });
    assert.equal(fit.blocks[0][3], -1, "unread is -1, never a palette guess");
    assert.equal(fit.check.all_matched, false, "an unreadable position is not a pass");
    assert.notEqual(fit.coverage.state, "complete");

    const clr = await call("check_site", { from: at, to: { ...at, x: at.x + 10 }, profile: { w: 1, h: 2 } });
    assert.equal(clr.clear, null);
    assert.equal(clr.coverage.state, "none");

    const pth = await call("check_path", { from: at, to: { ...at, x: at.x + 10 } });
    assert.equal(pth.reachable, null, `pathfinding over virgin chunks must refuse: ${JSON.stringify(pth)}`);
    assert.notEqual(pth.coverage.state, "complete");

    const site = await call("check_site", { at: { x: VIRGIN.x, z: VIRGIN.z }, size: { w: 4, d: 4 } });
    assert.equal(site.coverage.state, "none");
    assert.equal(site.ground_y, undefined, "no stats fabricated over unread columns");
    assert.equal(site.flat_enough_hint, undefined);
  });
});
