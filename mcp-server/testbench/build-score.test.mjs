// Unit tests for build-score.mjs — validates the W-schematic/W-repair diff core with zero server and
// zero model spend. Run: node --test testbench/build-score.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { normId, isAir, keyOf, diffBuild, mapFromCells, mapFromPaletteRows } from "./build-score.mjs";

test("normId strips namespace + blockstate, lowercases", () => {
  assert.equal(normId("minecraft:Oak_Planks"), "oak_planks");
  assert.equal(normId("minecraft:oak_stairs[facing=east,half=bottom]"), "oak_stairs");
  assert.equal(normId(null), "");
});

test("isAir recognizes air variants and empties", () => {
  assert.ok(isAir("minecraft:air"));
  assert.ok(isAir("cave_air"));
  assert.ok(isAir(null));
  assert.ok(!isAir("minecraft:stone"));
});

test("keyOf accepts objects and tuples identically", () => {
  assert.equal(keyOf({ x: 1, y: 2, z: 3 }), "1,2,3");
  assert.equal(keyOf([1, 2, 3]), "1,2,3");
});

test("exact match → 100% on every metric", () => {
  const target = { "0,0,0": "minecraft:stone", "1,0,0": "minecraft:oak_planks" };
  const built = { "0,0,0": "stone", "1,0,0": "minecraft:oak_planks" }; // namespace-insensitive
  const d = diffBuild(target, built);
  assert.equal(d.correct, 2);
  assert.equal(d.missing, 0);
  assert.equal(d.extra, 0);
  assert.equal(d.wrong_material, 0);
  assert.equal(d.block_match, 1);
  assert.equal(d.silhouette_iou, 1);
  assert.equal(d.fidelity, 1);
  assert.equal(d.exact, true);
});

test("wrong material: right silhouette, wrong block", () => {
  const target = { "0,0,0": "minecraft:stone" };
  const built = { "0,0,0": "minecraft:cobblestone" };
  const d = diffBuild(target, built);
  assert.equal(d.correct, 0);
  assert.equal(d.wrong_material, 1);
  assert.equal(d.silhouette_iou, 1); // shape is right
  assert.equal(d.block_match, 0);    // material is wrong
  assert.equal(d.fidelity, 0);
  assert.equal(d.exact, false);
});

test("missing block lowers match; blockstate props are ignored for material", () => {
  const target = { "0,0,0": "minecraft:oak_stairs[facing=east]", "1,0,0": "minecraft:oak_stairs[facing=west]" };
  const built = { "0,0,0": "minecraft:oak_stairs[facing=north]" }; // present but rotated, second missing
  const d = diffBuild(target, built);
  assert.equal(d.correct, 1);   // base id matches, props ignored
  assert.equal(d.missing, 1);
  assert.equal(d.block_match, 0.5);
});

test("extra blocks (over-building) penalize fidelity but not block_match", () => {
  const target = { "0,0,0": "minecraft:stone" };
  const built = { "0,0,0": "minecraft:stone", "5,5,5": "minecraft:dirt" };
  const d = diffBuild(target, built);
  assert.equal(d.correct, 1);
  assert.equal(d.extra, 1);
  assert.equal(d.block_match, 1);              // all target cells correct
  assert.equal(d.silhouette_iou, 0.5);         // union has 2, intersection 1
  assert.equal(d.fidelity, 0.5);               // correct(1) / union(2)
  assert.equal(d.exact, false);                // an extra block means not exact
});

test("built air where target wants a block counts as missing, not wrong", () => {
  const target = { "0,0,0": "minecraft:stone", "1,0,0": "minecraft:stone" };
  const built = { "0,0,0": "minecraft:stone", "1,0,0": "minecraft:air" };
  const d = diffBuild(target, built);
  assert.equal(d.missing, 1);
  assert.equal(d.wrong_material, 0);
  assert.equal(d.built_cells, 1); // air is not an occupied built cell
});

test("empty target with empty build is a perfect score (no NaN)", () => {
  const d = diffBuild({}, {});
  assert.equal(d.block_match, 1);
  assert.equal(d.silhouette_iou, 1);
  assert.equal(d.fidelity, 1);
  assert.equal(d.exact, true);
});

test("mapFromCells and mapFromPaletteRows agree", () => {
  const cells = [{ x: 0, y: 0, z: 0, block: "minecraft:stone" }, { x: 1, y: 0, z: 0, block: "minecraft:dirt" }];
  const fromCells = mapFromCells(cells);
  const fromRows = mapFromPaletteRows({ palette: ["minecraft:stone", "minecraft:dirt"], blocks: [[0, 0, 0, 0], [1, 0, 0, 1]] });
  assert.deepEqual(fromCells, fromRows);
  assert.equal(diffBuild(fromCells, fromRows).exact, true);
});
