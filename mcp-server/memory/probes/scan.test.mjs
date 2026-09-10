// Unit tests for bot_scan's sweep geometry (SURVIVAL_MODE_PLAN.md §5b) — offline, no bridge.
//
// The scan's honesty rests on two properties the arithmetic must guarantee: the fans TILE the
// requested arc (no unscanned wedge inside what the caller asked for), and a full sweep costs
// several real look steps rather than collapsing into one instant omniscan — a 360° fan would be a
// slow X-ray, which is exactly what §5b removed from the surface.

import { test } from "node:test";
import assert from "node:assert/strict";
import { sweepYaws, accumulateVisible, accumulateItems, SCAN_TOOL } from "../scan.mjs";
import { AMBIENT_FAN_ARGS, SCAN_FAN_ARGS } from "../ambient.mjs";

const FOV = SCAN_FAN_ARGS.h_fov;

test("a narrow arc is one fan, centred where asked", () => {
  assert.deepEqual(sweepYaws(0, 30), [0]);
  assert.deepEqual(sweepYaws(180, FOV), [180]);
});

test("a full sweep is several real look steps, never one instant omniscan", () => {
  const yaws = sweepYaws(0, 360);
  assert.ok(yaws.length >= 3, `a 360 sweep must cost multiple looks, got ${yaws.length}`);
  assert.ok(yaws.length <= 4, `…and stay bounded (the fan is ${FOV}° wide), got ${yaws.length}`);
  assert.equal(new Set(yaws).size, yaws.length, "no duplicate facings — each look must buy coverage");
});

test("the fans TILE the arc: no unscanned wedge inside what was asked for", () => {
  for (const arc of [120, 180, 240, 360]) {
    const yaws = sweepYaws(0, arc);
    const sorted = [...yaws].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i] - sorted[i - 1];
      assert.ok(gap <= FOV + 1e-6,
        `arc ${arc}: a ${gap.toFixed(1)}° step between fans exceeds the ${FOV}° field — that wedge is never seen`);
    }
    // The swept span reaches the arc's edges (each fan sees FOV/2 to either side of its centre).
    const span = sorted[sorted.length - 1] - sorted[0] + FOV;
    assert.ok(span >= Math.min(360, arc) - 1e-6,
      `arc ${arc}: swept span ${span.toFixed(1)}° falls short of the requested arc`);
  }
});

test("the arc is clamped to a full turn — you cannot ask to see more than everything", () => {
  assert.deepEqual(sweepYaws(0, 100_000), sweepYaws(0, 360));
  assert.deepEqual(sweepYaws(0, -5), sweepYaws(0, 1));
});

test("the tool declares the sweep controls the charter promises, and returns no block positions", () => {
  for (const p of ["direction", "arc", "pitch"]) {
    assert.ok(SCAN_TOOL.inputSchema.properties[p], `bot_scan must accept \`${p}\``);
  }
  // The description is what the model reads: it must say memory is where the positions go, or the
  // agent will expect blocks in context and re-scan when it doesn't get them — and it must promise
  // the `visible` tally, or the agent won't know looking around answers "what is this place".
  assert.match(SCAN_TOOL.description, /memory/i);
  assert.match(SCAN_TOOL.description, /360/);
  assert.match(SCAN_TOOL.description, /visible/);
});

// --- the visible-materials tally (w2-56123: "what is this place made of") ------------------------

const B = (id, x, y, z) => [0, 0, "b", id, 5, x, y, z];

test("visible tallies DISTINCT positions per id — overlapping fans cannot inflate the count", () => {
  const seen = new Map();
  accumulateVisible(seen, { rays: [B("minecraft:stone", 1, 2, 3), B("minecraft:stone", 1, 2, 4)] });
  // A second fan in the same sweep hits one of the same blocks again, plus a new kind.
  accumulateVisible(seen, { rays: [B("minecraft:stone", 1, 2, 3), B("minecraft:oak_log", 9, 2, 3)] });
  assert.equal(seen.get("minecraft:stone").size, 2, "the re-hit block must not count twice");
  assert.equal(seen.get("minecraft:oak_log").size, 1);
});

test("visible counts only block hits — entities, misses, and unread rays carry no material", () => {
  const seen = new Map();
  accumulateVisible(seen, {
    rays: [
      [0, 0, "e", "minecraft:zombie", 4, 1, 2, 3], // entities have their own organ
      [10, 0, "m"], // a clean miss
      [20, 0, "u", 12.5], // unread is unknown, not a material
      B("minecraft:grass_block", 5, 64, 5),
    ],
  });
  assert.deepEqual([...seen.keys()], ["minecraft:grass_block"]);
});

test("visible survives a malformed fan result without inventing blocks", () => {
  const seen = new Map();
  accumulateVisible(seen, null);
  accumulateVisible(seen, { rays: "not-an-array" });
  accumulateVisible(seen, { rays: [["b"], null, [0, 0, "b", "minecraft:stone", 5]] }); // short b row
  assert.equal(seen.size, 0);
});

test("the two ray budgets are split by caller, and the cone they share is the same shape", () => {
  // PERCEPTION_NAV_FIXES §1.4. The scan is DENSE because it is a deliberate act that already spends
  // ~1.2s turning the head; the ambient retina stays sparse because it fires every 2s forever. What
  // must NOT diverge is the cone: scan.mjs tiles its sweep with the fan's own h_fov (the test above
  // depends on it) and both channels capture into one store, so a differently-shaped scan cone would
  // silently corrupt the coverage arithmetic rather than fail.
  assert.equal(SCAN_FAN_ARGS.h_fov, AMBIENT_FAN_ARGS.h_fov, "scan and ambient must sweep the same horizontal cone");
  assert.equal(SCAN_FAN_ARGS.v_fov, AMBIENT_FAN_ARGS.v_fov, "…and the same vertical cone");
  assert.equal(SCAN_FAN_ARGS.load, false, "a deliberate look is still eyes, not a chunk loader");

  // A CENTRE RAY, on both channels. A fan spreads its rays evenly across the cone, so an EVEN step
  // count leaves the centre line — the bearing a walking body cares about most — with no ray on it.
  // Measured against one 3-wide trunk due north: 32x32 saw it at 12/24/36/48/60 blocks and MISSED it
  // at 72/84/96; 31x31 saw all eight. The 45-ray retina beat the 1024-ray scan on that test purely
  // because 9 and 5 are odd. This is the kind of thing that reads as "the vision is broken" and is
  // one bit of parity.
  for (const [name, args] of [["scan", SCAN_FAN_ARGS], ["ambient", AMBIENT_FAN_ARGS]]) {
    assert.equal(args.steps_h % 2, 1, `${name} steps_h must be ODD or nothing looks straight ahead`);
    assert.equal(args.steps_v % 2, 1, `${name} steps_v must be ODD or nothing looks at the horizon`);
  }

  // REACH. At r=32 that same experiment found 2 of 8 trees; the human watching could see all of
  // them. Reach is the cheap axis (cells per ray), so there is no reason to be near-sighted.
  assert.ok(SCAN_FAN_ARGS.range >= 64, `a deliberate look must reach past ${SCAN_FAN_ARGS.range} blocks`);
  assert.ok(AMBIENT_FAN_ARGS.range >= 64, `the retina must reach past ${AMBIENT_FAN_ARGS.range} blocks`);

  const scanRays = SCAN_FAN_ARGS.steps_h * SCAN_FAN_ARGS.steps_v;
  const ambientRays = AMBIENT_FAN_ARGS.steps_h * AMBIENT_FAN_ARGS.steps_v;
  assert.ok(scanRays > ambientRays * 4, `a deliberate scan must be substantially denser than the retina (${scanRays} vs ${ambientRays})`);
  assert.ok(scanRays <= 1024, `FAN_MAX_RAYS is 1024 in the toolkit; ${scanRays} would be REFUSED at the bridge`);

  // The aliasing bound that motivated the change: adjacent rays must land closer together at range
  // than a tree is wide, or trees fall between them — which is why 28 taiga scans saw zero logs.
  const stepDeg = SCAN_FAN_ARGS.h_fov / (SCAN_FAN_ARGS.steps_h - 1);
  const spacingAt32 = 2 * 32 * Math.sin((stepDeg * Math.PI) / 360);
  assert.ok(spacingAt32 < 5, `rays ${spacingAt32.toFixed(1)} blocks apart at range 32 can miss a 5-wide canopy`);
});

test("dropped items are reported by name, count and bearing — not thrown away", () => {
  // A human watching a survival run: "the scan is still missing dropped items around the model."
  // Entity rows were dropped here on the reasoning that entities belong to sense_entities — right
  // for mobs, wrong for loot, since the stacks under the body are usually its OWN drops. A body that
  // cannot see what it just mined re-mines it.
  const fan = {
    range: 32,
    rays: [
      [0, 10, "b", "minecraft:stone", 6, 1, 64, 2],                          // blocks still work
      [-5, 12, "e", "minecraft:item", 3.8, 500, 100, 496, "minecraft:oak_log", 3],
      [4, 14, "e", "minecraft:item", 5.7, 500, 100, 494, "minecraft:cobblestone", 7],
      [6, 15, "e", "minecraft:item", 9.1, 501, 100, 491, "minecraft:oak_log", 2],
      [9, 16, "e", "minecraft:zombie", 7.0, 502, 100, 493],                  // mobs are NOT loot
    ],
  };
  const items = new Map();
  accumulateItems(items, fan, 180);
  assert.equal(items.size, 2, `only the two item kinds: ${[...items.keys()]}`);
  assert.ok(!items.has("minecraft:zombie"), "a mob is not loot — sense_entities owns those");

  const logs = items.get("minecraft:oak_log");
  assert.equal(logs.count, 5, "stacks of the same item sum (3 + 2)");
  assert.equal(logs.nearest, 3.8, "…and the nearest one is what the body should walk to");
  assert.equal(logs.bearing, "N", "bearing is absolute (look yaw 180 + ray offset), not ray-relative");

  // Overlapping fans in a 360 sweep must not count one stack twice.
  accumulateItems(items, fan, 180);
  assert.equal(items.get("minecraft:oak_log").count, 5, "same positions re-seen must not inflate the tally");

  // And the block tally is unchanged by any of this.
  const seen = new Map();
  accumulateVisible(seen, fan);
  assert.deepEqual([...seen.keys()], ["minecraft:stone"], "entity rows must never enter the materials tally");
});
