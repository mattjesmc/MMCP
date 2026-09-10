// Spatial-inversion probes (toolkit 0.7.0; 0.22.0: find_site folded into check_site near-door) — site search / resolve_anchor / region connectivity /
// affordance + bearing carrying. The inversion theme: the model states a relation or a footprint,
// the SERVER does the coordinate arithmetic (RESEARCH_WORLD_REPRESENTATION.md: model spatial
// arithmetic is the documented failure mode, not perception).
//
// Fixture: a flat stone platform far from every other probe sandbox, forceloaded for the run.
// A 4-wide water trench splits it mid-test for the connectivity assertions (stride 2 ⇒ a 4-wide
// trench always wets sampled columns). Everything is reverted after.
//
// Run: npm run test:live (needs the dev server).

import { test, before, after } from "node:test";
import assert from "node:assert";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
async function call(tool, args = {}) {
  const res = await fetch(`${BASE}/cmd`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool, args }),
  });
  return res.json();
}
const cmd = (c) => call("run_command", { command: c });

// Chunk-aligned center so the region-summary extent is predictable: with tiles:1, tile_chunks:2
// the surveyed square is 32×32 starting one chunk below the center's chunk.
const CX = 3_002_000; // 3_002_000 >> 4 << 4 === 3_002_000 (divisible by 16)
const CZ = 3_002_000;
const REGION_MIN_X = ((CX >> 4) - 1) << 4;
const REGION_MIN_Z = ((CZ >> 4) - 1) << 4;
const PLAT_Y = 300; // above any natural terrain (peaks top out ~y 296), below build limit
const PLAT_MIN = { x: REGION_MIN_X - 4, z: REGION_MIN_Z - 4 };
const PLAT_MAX = { x: REGION_MIN_X + 35, z: REGION_MIN_Z + 35 };
// Trench: 4 wide in x, full z extent of the platform, splitting the region into west/east.
const TRENCH_X0 = REGION_MIN_X + 14;
const undoIds = [];

before(async () => {
  const res = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
  if (!res?.ok) throw new Error("no bridge — start the dev server first");
  await cmd(`forceload add ${PLAT_MIN.x} ${PLAT_MIN.z} ${PLAT_MAX.x} ${PLAT_MAX.z}`);
  const t0 = Date.now();
  for (;;) {
    const r = await call("get_blocks_at", { blocks: [{ x: CX, y: PLAT_Y, z: CZ }] });
    if (r.ok && r.result.coverage?.state === "complete") break;
    if (Date.now() - t0 > 120_000) throw new Error("fixture chunks not generated in 120s");
    await new Promise((r2) => setTimeout(r2, 1500));
  }
  const plat = await call("place_shape", {
    shape: "box", block: "minecraft:stone", mode: "solid",
    p1: { x: PLAT_MIN.x, y: PLAT_Y, z: PLAT_MIN.z },
    p2: { x: PLAT_MAX.x, y: PLAT_Y, z: PLAT_MAX.z },
  });
  assert.equal(plat.ok, true, `platform: ${JSON.stringify(plat)}`);
  if (plat.result.undo_id) undoIds.push(plat.result.undo_id);
  // Clear anything above the platform so heightmaps see the slab as the surface.
  const clear = await call("place_shape", {
    shape: "box", block: "minecraft:air", mode: "solid",
    p1: { x: PLAT_MIN.x, y: PLAT_Y + 1, z: PLAT_MIN.z },
    p2: { x: PLAT_MAX.x, y: PLAT_Y + 12, z: PLAT_MAX.z },
  });
  assert.equal(clear.ok, true);
  if (clear.result.undo_id) undoIds.push(clear.result.undo_id);
});

after(async () => {
  for (const id of undoIds.reverse()) {
    await call("undo_edit", { undo_id: id }).catch(() => {});
  }
  await cmd(`kill @e[type=minecraft:armor_stand,x=${CX},y=${PLAT_Y},z=${CZ},distance=..64]`).catch(() => {});
  await cmd(`forceload remove ${PLAT_MIN.x} ${PLAT_MIN.z} ${PLAT_MAX.x} ${PLAT_MAX.z}`).catch(() => {});
});

// --- resolve_anchor: pure relation→coordinate arithmetic (deterministic, no world reads) --------

test("resolve_anchor: east face, gap, center align", async () => {
  const r = await call("resolve_anchor", {
    to: { min: { x: 100, y: 64, z: 100 }, max: { x: 104, y: 66, z: 104 } },
    face: "east", gap: 2, size: { w: 3, h: 2, d: 3 }, check: false,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.result.origin, { x: 107, y: 64, z: 101 });
  assert.deepEqual(r.result.box.max, { x: 109, y: 65, z: 103 });
  assert.equal(r.result.coverage.state, "complete"); // vacuous: nothing world-dependent asked
});

test("resolve_anchor: north face touches, min align", async () => {
  const r = await call("resolve_anchor", {
    to: { min: { x: 100, y: 64, z: 100 }, max: { x: 104, y: 66, z: 104 } },
    face: "north", size: { w: 2, h: 2, d: 2 }, align: "min", check: false,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.result.origin, { x: 100, y: 64, z: 98 });
});

test("resolve_anchor: up face, max align", async () => {
  const r = await call("resolve_anchor", {
    to: { min: { x: 100, y: 64, z: 100 }, max: { x: 104, y: 66, z: 104 } },
    face: "up", size: { w: 2, h: 1, d: 2 }, align: "max", check: false,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.result.origin, { x: 103, y: 67, z: 103 });
});

test("resolve_anchor: on_ground drops to the platform, check verifies fit", async () => {
  const r = await call("resolve_anchor", {
    to: { x: CX, y: PLAT_Y, z: CZ }, face: "east", gap: 1,
    size: { w: 2, h: 2, d: 2 }, on_ground: true,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.result.origin.y, PLAT_Y + 1, "base should sit on the platform");
  assert.equal(r.result.fits, true, `air above the platform should fit: ${JSON.stringify(r.result)}`);
});

// --- find_site: search-shaped inverse of check_fit/check_site ----------------------------------

test("find_site: flat platform yields zero-work, fit-verified candidates", async () => {
  const r = await call("check_site", {
    near: { x: CX, z: CZ }, radius: 8, size: { w: 3, h: 3, d: 3 }, stride: 2,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  const cands = r.result.candidates;
  assert.ok(Array.isArray(cands) && cands.length > 0, `expected candidates: ${JSON.stringify(r.result)}`);
  const best = cands[0];
  assert.equal(best.cut + best.fill, 0, "flat platform: zero terrain work");
  assert.equal(best.pos.y, PLAT_Y + 1, "candidate base sits on the platform");
  assert.equal(best.fits, true, "top candidate must pass the real volume check");
  assert.equal(r.result.coverage.state, "complete");
});

// --- affordances: palette-aligned flags, O(palette) not O(cells) -------------------------------

test("get_blocks_at: affordances align with the palette", async () => {
  const r = await call("get_blocks_at", {
    blocks: [
      { x: CX, y: PLAT_Y, z: CZ },     // stone
      { x: CX, y: PLAT_Y + 1, z: CZ }, // air
    ],
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  const { palette, affordances } = r.result;
  assert.equal(palette.length, affordances.length, "affordances must align with palette");
  const stoneIdx = palette.findIndex((p) => p.startsWith("minecraft:stone"));
  const airIdx = palette.findIndex((p) => p.startsWith("minecraft:air"));
  assert.ok(stoneIdx >= 0 && airIdx >= 0, JSON.stringify(palette));
  assert.equal(affordances[stoneIdx], "solid,tool");
  assert.equal(affordances[airIdx], "air");
});

// --- bearing/dy: relations carried in-payload --------------------------------------------------

test("get_entities: rows carry bearing and dy from the origin", async () => {
  const sr = await cmd(`summon minecraft:armor_stand ${CX} ${PLAT_Y + 1} ${CZ - 10}`);
  assert.equal(sr.ok, true, JSON.stringify(sr));
  const r = await call("get_entities", {
    origin: { x: CX, y: PLAT_Y + 1, z: CZ }, radius: 16, type: "minecraft:armor_stand",
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.result.entities.length >= 1, "armor stand not seen");
  const row = r.result.entities[0];
  assert.equal(row.bearing, "N", `−z from origin must read N: ${JSON.stringify(row)}`);
  assert.ok(Number.isInteger(row.dy), "dy must be an integer");
  await cmd(`kill @e[type=minecraft:armor_stand,x=${CX},y=${PLAT_Y + 1},z=${CZ - 10},distance=..2]`);
});

// --- region connectivity: topology computed tool-side ------------------------------------------

test("connectivity: same side connected, across a water trench provably not", async () => {
  // Trench AFTER the find_site test so the flat-platform assertions stay clean.
  const trench = await call("place_shape", {
    shape: "box", block: "minecraft:water", mode: "solid",
    p1: { x: TRENCH_X0, y: PLAT_Y, z: PLAT_MIN.z },
    p2: { x: TRENCH_X0 + 3, y: PLAT_Y, z: PLAT_MAX.z },
  });
  assert.equal(trench.ok, true, JSON.stringify(trench));
  if (trench.result.undo_id) undoIds.push(trench.result.undo_id);

  const west = { x: TRENCH_X0 - 6, z: CZ };
  const east = { x: TRENCH_X0 + 10, z: CZ };
  const east2 = { x: TRENCH_X0 + 14, z: CZ };

  const split = await call("get_region_summary", {
    center: { x: CX, z: CZ }, tiles: 1, tile_chunks: 2,
    points: [west, east],
  });
  assert.equal(split.ok, true, JSON.stringify(split));
  const conn = split.result.connectivity;
  assert.ok(conn, "connectivity block missing (points should imply it)");
  assert.equal(conn.connected, false,
    `across the trench must be provably separate: ${JSON.stringify(conn)}`);
  assert.ok(conn.water_cells > 0, "trench must register as water cells");
  assert.ok(conn.components_total >= 2, "trench must split the platform");
  // Tiles carry which components touch them.
  assert.ok(split.result.tiles.some((t) => Array.isArray(t.walk_components)),
    "tiles should carry walk_components");

  const same = await call("get_region_summary", {
    center: { x: CX, z: CZ }, tiles: 1, tile_chunks: 2,
    points: [east, east2],
  });
  assert.equal(same.ok, true);
  assert.equal(same.result.connectivity.connected, true,
    `same side must share a component: ${JSON.stringify(same.result.connectivity)}`);
});
