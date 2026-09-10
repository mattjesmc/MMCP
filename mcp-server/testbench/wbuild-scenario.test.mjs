// Offline unit test for the W-build pure path (target generation + spec rendering + diff), no server
// and no model spend. Run: node --test testbench/wbuild-scenario.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildTarget, renderSpec, deviations } from "./wbuild-scenario.mjs";
import { diffBuild } from "./build-score.mjs";

// Absolute-map helper mirroring the scenario (origin at 0,0,0 for the test).
function absOf(t) {
  const abs = {};
  for (const k of Object.keys(t.rel)) { const [x, y, z] = k.split(",").map(Number); abs[`${x},${y},${z}`] = t.rel[k]; }
  return abs;
}
const regionOf = (t) => ({ min: { x: 0, y: 0, z: 0 }, max: { x: t.W - 1, y: t.H - 1, z: t.D - 1 } });

test("buildTarget is deterministic and non-trivial", () => {
  const a = buildTarget(1), b = buildTarget(1);
  assert.deepEqual(a.rel, b.rel);
  assert.ok(Object.keys(a.rel).length > 30, "structure should have many cells");
  assert.equal(a.W, 5); assert.equal(a.D, 5); assert.equal(a.H, 3);
});

test("seed changes material (oak vs spruce), same shape", () => {
  const s1 = buildTarget(1), s2 = buildTarget(2);
  const occ = (t) => new Set(Object.keys(t.rel)).size;
  assert.equal(occ(s1), occ(s2)); // same silhouette
  const mats1 = new Set(Object.values(s1.rel)), mats2 = new Set(Object.values(s2.rel));
  assert.notDeepEqual([...mats1].sort(), [...mats2].sort()); // different palette
});

test("doorway is a 2-high air gap in the west wall", () => {
  const t = buildTarget(1);
  const doorZ = Math.floor(t.D / 2);
  assert.ok(!(`0,0,${doorZ}` in t.rel), "door bottom should be air");
  assert.ok(!(`0,1,${doorZ}` in t.rel), "door top should be air");
});

test("renderSpec produces H layers and a legend with all materials", () => {
  const t = buildTarget(1);
  const spec = renderSpec(t);
  assert.match(spec, /Legend:/);
  for (const y of [0, 1, 2]) assert.ok(spec.includes(`y = ${y}`), `layer ${y} present`);
  for (const b of new Set(Object.values(t.rel))) assert.ok(spec.includes(b), `${b} in legend`);
});

test("a perfect build scores exact; an empty build scores ~0", () => {
  const t = buildTarget(1);
  // Absolute-map the target the way the scenario does (origin arbitrary here).
  const abs = {};
  for (const k of Object.keys(t.rel)) { const [x, y, z] = k.split(",").map(Number); abs[`${x},${y},${z}`] = t.rel[k]; }
  assert.equal(diffBuild(abs, abs).exact, true);
  const empty = diffBuild(abs, {});
  assert.equal(empty.fidelity, 0);
  assert.equal(empty.missing, Object.keys(abs).length);
});

test("repair deviations are all in-region and detected by the diff", () => {
  const t = buildTarget(1);
  const abs = absOf(t);
  const region = regionOf(t);
  const dev = deviations(abs, region, 1);
  assert.ok(dev.length >= 3, "wrong-material + missing + extra");
  // every deviation cell is inside the capture region
  for (const d of dev) {
    assert.ok(d.x >= region.min.x && d.x <= region.max.x &&
      d.y >= region.min.y && d.y <= region.max.y &&
      d.z >= region.min.z && d.z <= region.max.z, `deviation ${JSON.stringify(d)} in region`);
  }
  // apply the deviations to a copy of the pre-built target and diff → all three classes show up
  const built = { ...abs };
  for (const d of dev) { const k = `${d.x},${d.y},${d.z}`; if (/air$/.test(d.block)) delete built[k]; else built[k] = d.block; }
  const diff = diffBuild(abs, built);
  assert.equal(diff.exact, false);
  assert.ok(diff.wrong_material >= 1, "wrong-material detected");
  assert.ok(diff.missing >= 1, "missing detected");
  assert.ok(diff.extra >= 1, "in-region extra detected");
});

test("a single wrong block drops exact but keeps high block_match", () => {
  const t = buildTarget(1);
  const abs = {};
  for (const k of Object.keys(t.rel)) { const [x, y, z] = k.split(",").map(Number); abs[`${x},${y},${z}`] = t.rel[k]; }
  const built = { ...abs };
  const firstKey = Object.keys(built)[0];
  built[firstKey] = "minecraft:diamond_block"; // one wrong material
  const d = diffBuild(abs, built);
  assert.equal(d.exact, false);
  assert.equal(d.wrong_material, 1);
  assert.ok(d.block_match > 0.9);
});
