// bot_scan's overhead classifier — the render that told a forest it was in a cave.
//
// PERCEPTION_NAV_FIXES.md §4.1 is the authority. `sees_sky` is `level.canSeeSky()`, whose
// MOTION_BLOCKING heightmap counts leaves AND water as blocking, so a forest floor, a kelp bed and
// a real cavern all arrive here as `sees_sky:false` and the render has to tell them apart from the
// materials alone. It used to answer all three with "a cave or cavity worth following".
//
// Every case below is a real tally: the first two are transcribed from §4.1 verbatim (they are the
// scans that were actually mis-rendered in the 2026-08-05 sessions), the rest are the boundaries
// those two imply. Offline and pure — no world, no bridge, no game — which is the point: this is
// the file whose absence let the canopy bug ship and the water bug outlive its own fix.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyOverhead } from "../scan.mjs";

const tally = (o) => Object.entries(o).map(([k, v]) => [`minecraft:${k}`, v]);
const at = (kinds, extra = {}) => classifyOverhead({ kinds, seesSky: false, ...extra });

// §4.1's first worked example, verbatim. Foliage fraction is 27/70 = 0.386 — it fails the
// leaf-dominant gate, which is exactly why counting only foliage was not enough.
const FOREST_FLOOR = tally({ grass_block: 31, oak_leaves: 20, leaf_litter: 12, dark_oak_log: 7 });
// §4.1's second, verbatim. No foliage at all; the roof is water.
const SEABED = tally({ kelp_plant: 24, sand: 19, seagrass: 9 });
// A real cavern: everything in sight is rock, and the cave voice must survive.
const CAVERN = tally({ stone: 44, deepslate: 18, andesite: 9, gravel: 6, dirt: 4 });

test("§4.1 case 1: a forest floor is not a cave", () => {
  const { state, note } = at(FOREST_FLOOR);
  assert.equal(state, "surface");
  assert.match(note, /NOT UNDERGROUND/);
});

test("§4.1 case 2: a seabed is not a cave", () => {
  const { state, note } = at(SEABED);
  assert.equal(state, "water");
  assert.match(note, /NOT UNDERGROUND/);
});

test("the cave voice survives over actual rock", () => {
  assert.deepEqual(at(CAVERN), { state: "solid", note: null });
});

test("a leaf-dominant roof still reads as canopy, wording unchanged (w3-86528)", () => {
  // The jungle sweep that caused the 2026-08-10 fix: leaves 122 / jungle_leaves 45 / vine 42.
  // Spelled with real ids — the transcript (and scan.mjs's comment) quote the render, which strips
  // the namespace, and there is no `minecraft:leaves`: every leaf block is `<wood>_leaves`.
  const { state, note } = at(tally({ jungle_leaves: 122, oak_leaves: 45, vine: 42 }));
  assert.equal(state, "canopy");
  assert.match(note, /UNDER A CANOPY, NOT UNDERGROUND/);
  assert.match(note, /dig DOWN/);
});

test("the submerged flag classifies water even when the tally cannot", () => {
  // Eye in water inside a flooded stone shaft: every visible block is rock.
  assert.equal(at(CAVERN, { submerged: true }).state, "water");
});

test("water is read from the tally when bot_status never said submerged", () => {
  // Standing on the seabed with the eye in an air pocket — the flag is false and honest.
  assert.equal(at(SEABED, { submerged: false }).state, "water");
});

test("sees_sky short-circuits everything", () => {
  assert.deepEqual(classifyOverhead({ kinds: CAVERN, seesSky: true }), { state: "open_sky", note: null });
});

// The lush cave that finally walked the review card `scan-overhead-voice` (probe-0143, 2026-09-10).
// A real tally, as the render named it: the body stood at 303,38,-184 with sky light 0 and
// fifty-three blocks of stone and andesite between its head and the surface, and was told it was
// ON THE SURFACE. Lush caves grow short_grass, tall_grass and moss_carpet, so a list of blocks that
// "cannot be underground" containing those three vetoed the cave voice inside a cave.
const LUSH_CAVE = tally({
  stone: 453, moss_block: 146, short_grass: 59, moss_carpet: 37, granite: 25, tall_grass: 22,
});
// The forest floor the same walk read at -41.5,94,73.5 — sky light 12, leaves overhead. The arm
// that catches the lush cave must not cost this one its line: it is the case the arm exists for.
const FOREST_FLOOR_LIVE = tally({
  grass_block: 292, leaf_litter: 140, oak_leaves: 137, short_grass: 93, birch_leaves: 37, oak_log: 15,
});

test("a lush cave is a CAVE: its grass and moss carpet do not veto the cave voice", () => {
  // The expensive direction, measured in a world instead of argued from a tally. 118 of these 742
  // positions are lush-cave vegetation; the surface arm used to fire on them at 15.9%.
  assert.deepEqual(at(LUSH_CAVE), { state: "solid", note: null });
});

test("the surface arm still fires on the forest floor that was read the same day", () => {
  const { state, note } = at(FOREST_FLOOR_LIVE);
  assert.equal(state, "surface");
  assert.match(note, /NOT UNDERGROUND/);
});

test("underground dirt and gravel do NOT count as surface", () => {
  // The expensive direction of this error: a body wrongly told it is outside stops looking for the
  // cavern it is standing in. dirt/sand/gravel/clay/stone are deliberately out of SURFACE_ONLY.
  assert.equal(at(tally({ stone: 30, dirt: 12, gravel: 10, sand: 8, clay: 4 })).state, "solid");
});

test("one stray grass block does not veto a cavern", () => {
  // A single surface block visible up a shaft is not evidence the body is outside: the floor
  // requires both 4 distinct positions AND a tenth of the tally.
  assert.equal(at(tally({ stone: 80, deepslate: 30, grass_block: 3 })).state, "solid");
  assert.equal(at(tally({ stone: 200, grass_block: 5 })).state, "solid"); // 5/205 = 2.4%, under 10%
});

test("an empty tally is not evidence of anything", () => {
  assert.deepEqual(at([]), { state: "solid", note: null });
  assert.deepEqual(classifyOverhead({}), { state: "solid", note: null });
});

test("every non-solid state says NOT UNDERGROUND in those words", () => {
  // The render unshifts this line above the sector voices, and a small model read the old tally
  // backwards. The phrase is the fix; assert it cannot be edited away one arm at a time.
  for (const kinds of [FOREST_FLOOR, SEABED, tally({ jungle_leaves: 122, vine: 42 })]) {
    assert.match(at(kinds).note, /NOT UNDERGROUND/, JSON.stringify(kinds));
  }
});
