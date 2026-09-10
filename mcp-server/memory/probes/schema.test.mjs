// Freezes the record shapes of MEMORY_DESIGN.md rev 2. Green from day one; a failure here means the
// schema changed — which requires a SCHEMA_VERSION bump and a migration story, not a test edit.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SCHEMA_VERSION,
  chunkOf,
  regionOf,
  entryId,
  blockId,
  validateEntry,
  validateBlock,
  validateRelation,
  validatePlace,
} from "../schema.mjs";

const ENTRY = {
  v: SCHEMA_VERSION,
  id: "e-000123",
  session: "s-20260719a",
  t: "2026-07-19T14:03:22Z",
  tick: 81234,
  kind: "obs",
  dim: "minecraft:overworld",
  pos: [-120, 64, 300],
  chunk: [-8, 18],
  region: "r.-1.0",
  text: "Village well at (-120,64,300); four farms east of it.",
  refs: { events: [411, 412], places: ["p-oak-village"] },
};

const BLOCK = {
  v: SCHEMA_VERSION,
  id: "b-000007",
  level: 1,
  tick_range: [80100, 86400],
  time_range: ["2026-07-19T13:40:00Z", "2026-07-19T15:10:00Z"],
  dim: "minecraft:overworld",
  regions: ["r.-1.0"],
  bounds: [[-160, 60, 240], [-80, 80, 340]],
  activity: "exploration",
  pois: ["p-oak-village"],
  tallies: { mined: 64, derived_from: "linked audit events" },
  outcome: "Mapped oak village; no base site chosen yet.",
  prose: "Explored the river valley west of spawn.",
  links: { entries: ["e-000100", "e-000123"], blocks: [] },
  created_tick: 86400,
  last_activity_tick: 86400,
};

test("spatial derivation mirrors Minecraft chunk/region math", () => {
  assert.deepEqual(chunkOf([-120, 64, 300]), [-8, 18]);
  assert.equal(regionOf([-120, 64, 300]), "r.-1.0");
  assert.deepEqual(chunkOf([0, 0, 0]), [0, 0]);
  assert.equal(regionOf([0, 0, 0]), "r.0.0");
  assert.equal(regionOf([-1, 0, -1]), "r.-1.-1");
  assert.equal(entryId(123), "e-000123");
  assert.equal(blockId(7), "b-000007");
});

test("valid records pass", () => {
  assert.deepEqual(validateEntry(ENTRY), []);
  assert.deepEqual(validateBlock(BLOCK), []);
  assert.deepEqual(
    validateRelation({ v: 1, kind: "compaction", t: ENTRY.t, tick: 86400, block: "b-000007", entries: ["e-000123"] }),
    []);
  assert.deepEqual(
    validateRelation({ v: 1, kind: "verification", t: ENTRY.t, target_type: "place", target_id: "p-oak-village", result: "confirmed", tick: 94000 }),
    []);
  assert.deepEqual(
    validatePlace({ v: 1, id: "p-oak-village", category: "village", dim: "minecraft:overworld", pos: [-120, 64, 300], discovered_tick: 81234 }),
    []);
});

test("offline degradation: tick may be null, never undefined-garbage", () => {
  assert.deepEqual(validateEntry({ ...ENTRY, tick: null }), []);
  assert.notDeepEqual(validateEntry({ ...ENTRY, tick: "81234" }), []);
});

test("placeless note: pos null drops chunk/region requirements", () => {
  assert.deepEqual(validateEntry({ ...ENTRY, pos: null, chunk: null, region: null }), []);
});

test("derived spatial fields must match pos", () => {
  assert.notDeepEqual(validateEntry({ ...ENTRY, region: "r.0.0" }), []);
  assert.notDeepEqual(validateEntry({ ...ENTRY, chunk: [0, 0] }), []);
});

test("blocks are immutable history: no last_verified field family, required provenance", () => {
  assert.notDeepEqual(validateBlock({ ...BLOCK, tallies: { mined: 64 } }), [], "tallies without derived_from must fail");
  assert.notDeepEqual(validateBlock({ ...BLOCK, outcome: "" }), []);
  assert.notDeepEqual(validateBlock({ ...BLOCK, bounds: [[0, 90, 0], [10, 60, 10]] }), [], "min>max bounds must fail");
});

test("level discipline: L1 links entries, L2+ links blocks, never both", () => {
  assert.notDeepEqual(validateBlock({ ...BLOCK, links: { entries: [], blocks: [] } }), []);
  assert.notDeepEqual(validateBlock({ ...BLOCK, links: { entries: ["e-000001"], blocks: ["b-000001"] } }), []);
  assert.deepEqual(
    validateBlock({ ...BLOCK, level: 2, links: { entries: [], blocks: ["b-000001", "b-000002"] } }),
    []);
});

test("verification targets the smallest stable subject — places and entries, never blocks", () => {
  const rel = { v: 1, kind: "verification", t: ENTRY.t, target_id: "b-000007", result: "confirmed", tick: 1 };
  assert.notDeepEqual(validateRelation({ ...rel, target_type: "block" }), []);
});

test("schema version is enforced on every record type", () => {
  for (const [rec, fn] of [[ENTRY, validateEntry], [BLOCK, validateBlock]]) {
    assert.notDeepEqual(fn({ ...rec, v: 999 }), []);
    assert.notDeepEqual(fn({ ...rec, v: undefined }), []);
  }
});
