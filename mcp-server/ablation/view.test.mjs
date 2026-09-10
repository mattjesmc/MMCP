// The abstracted perception view must make exactly the thing the pilot agents missed — a small gap
// in a structure line over background terrain — visually obvious, at a fraction of the raw size.

import { test } from "node:test";
import assert from "node:assert/strict";
import { asciiSurfaceView } from "./view.mjs";

function walkwayScene() {
  // Terrain (water y62) everywhere; a plank walkway at y200 along z=0, x 0..30, broken at x 14-16.
  const blocks = [];
  for (let x = -5; x <= 35; x++) {
    for (let z = -3; z <= 3; z++) {
      const onWalk = z === 0 && x >= 0 && x <= 30 && !(x >= 14 && x <= 16);
      blocks.push(onWalk ? { x, y: 200, z, block: "minecraft:oak_planks" } : { x, y: 62, z, block: "minecraft:water" });
    }
  }
  return { origin: { x: 15, z: 0 }, grid: 20, heightmap: "world_surface", columns: blocks.length, blocks };
}

test("gap in a structure line renders as a visible hole", () => {
  const v = asciiSurfaceView(walkwayScene());
  const walkRow = v.view.split("\n").find((l) => l.startsWith("z0 "));
  // The walkway row: planks char runs, then 3 background chars, then planks again.
  assert.match(walkRow, /#{5,}\.{3}#{5,}/, `expected a 3-cell hole in the plank line, got: ${walkRow}`);
  assert.ok(v.view.includes("#=oak_planks y200"), "legend names the structure block and height");
  assert.ok(v.view.includes(".=water y62"), "legend names the background");
  assert.equal(v.blocks, undefined, "raw column list is not passed through");
});

test("view is dramatically smaller than the raw result", () => {
  const raw = walkwayScene();
  const v = asciiSurfaceView(raw);
  const rawLen = JSON.stringify(raw).length;
  const viewLen = JSON.stringify(v).length;
  assert.ok(viewLen < rawLen / 5, `view ${viewLen} chars should be <20% of raw ${rawLen}`);
});

test("empty scan degrades gracefully", () => {
  const v = asciiSurfaceView({ origin: { x: 0, z: 0 }, blocks: [] });
  assert.ok(v.view.includes("no columns"));
});

// Regression: the live bridge (toolkit 0.14.0) returns palette-indexed tuple columns, not object
// columns. The renderer previously assumed objects and crashed on `b.block.replace` (Category C
// recorded the crash envelopes). It must decode the palette form and produce the same map.
test("palette-indexed bridge columns render (not crash)", () => {
  const blocks = [];
  for (let x = -5; x <= 35; x++) {
    for (let z = -3; z <= 3; z++) {
      const onWalk = z === 0 && x >= 0 && x <= 30 && !(x >= 14 && x <= 16);
      blocks.push(onWalk ? [x, 200, z, 1] : [x, 62, z, 0]); // palette idx 0=water, 1=oak_planks
    }
  }
  const v = asciiSurfaceView({
    origin: { x: 15, z: 0 }, grid: 20, heightmap: "world_surface",
    columns: blocks.length, palette: ["minecraft:water", "minecraft:oak_planks"], blocks,
  });
  const walkRow = v.view.split("\n").find((l) => l.startsWith("z0 "));
  assert.match(walkRow, /#{5,}\.{3}#{5,}/, `expected a 3-cell hole in the plank line, got: ${walkRow}`);
  assert.ok(v.view.includes("#=oak_planks y200"), "legend decodes palette idx -> block id");
  assert.ok(v.view.includes(".=water y62"), "legend names the background");
  assert.equal(v.blocks, undefined, "raw column list is not passed through");
});

test("completeness metadata survives the re-encode", () => {
  const v = asciiSurfaceView({
    origin: { x: 0, z: 0 }, grid: 2, palette: ["minecraft:stone"],
    blocks: [[0, 64, 0, 0]], coverage: { state: "partial" }, unloaded: 3, truncated: true,
  });
  assert.equal(v.unloaded, 3, "unloaded count preserved (agent must know the read was incomplete)");
  assert.equal(v.truncated, true, "truncated flag preserved");
  assert.deepEqual(v.coverage, { state: "partial" }, "coverage preserved");
});
