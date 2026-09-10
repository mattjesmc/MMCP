// Capture-hook probes — OBSERVATION_MEMORY_DESIGN.md §7 step 2 (extractors + hook) and step 3
// (query tools), offline against fixture results copied from the mod's real serializers
// (WorldPerceptionTools/LocateTools, verified 2026-07-27). No server, no model spend.

import { test } from "node:test";
import assert from "node:assert";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// MEMORY_ROOT binds at import time — the env must be set before capture.mjs (→ tools.mjs) loads.
const root = await mkdtemp(join(tmpdir(), "mcobs-cap-"));
process.env.MCPTK_MEMORY_DIR = root;
process.env.MCPTK_EMBED_BACKEND ??= "none";
const { EXTRACTORS, UNCAPTURED_WORLD_READS, captureWorldRead, resetCaptureCache, storeFor } =
  await import("../capture.mjs");
// The three obs tools are DELETED (MEMORY_REDESIGN §3). Their answers now arrive through the reads
// the agent already makes (annotate.test.mjs) and through mem_recall's at/box/ids params — so the
// round-trip is asserted against the surviving surface, not against a deleted one.
const memTools = await import("../tools.mjs");

const DIM = "minecraft:overworld";
const WORLD_UUID = "cap-test-world";

/** Bridge stub: world identity only — capture never needs anything else from the bridge. */
async function fakeBridge(tool) {
  if (tool === "get_world_info") {
    return { ok: true, result: { world_uuid: WORLD_UUID, name: "cap-test", game_tick: 9000 } };
  }
  return { ok: false, error: `unexpected bridge call ${tool}` };
}

const envelope = (tick = 1000) => ({ perception_mode: "spatial", game_tick: tick, dimension: DIM, mechanism: "observe" });

// --- extractor units ------------------------------------------------------------------------------

test("get_blocks_at: reads become cells; -1 (not read) never indexes as a fact", () => {
  const r = {
    ...envelope(), detail: "state",
    palette: ["minecraft:stone", "minecraft:chest[facing=north]"],
    blocks: [[10, 64, 20, 0], [10, 65, 20, 1], [11, 64, 20, -1, -1]],
  };
  const n = EXTRACTORS.get_blocks_at({}, r);
  assert.deepEqual(n.cellValues, [[10, 64, 20, "minecraft:stone"], [10, 65, 20, "minecraft:chest[facing=north]"]]);
  assert.deepEqual(n.area, { cells: [[10, 64, 20], [10, 65, 20]], complete: true });
  assert.equal(n.confirms, true);
});

test("get_surface full: per-column cells with a surface area; completeness from coverage flags", () => {
  const r = {
    ...envelope(), detail: "full", heightmap: "world_surface",
    origin: { x: 100.5, y: 64.0, z: 200.5 }, grid: 2, unloaded: 0, truncated: false,
    palette: ["minecraft:grass_block", "minecraft:emerald_block"],
    blocks: [[100, 64, 200, 0], [101, 70, 200, 1]],
  };
  const n = EXTRACTORS.get_surface({}, r);
  assert.equal(n.cellValues.length, 2);
  assert.deepEqual(n.area, { surface: { origin: [100, 200], grid: 2 }, complete: true });
  const partial = EXTRACTORS.get_surface({}, { ...r, unloaded: 3 });
  assert.equal(partial.area.complete, false, "unloaded columns must not read as a complete survey");
});

test("get_surface summary: anomalies are exact cells; the histogram is a sweep value", () => {
  const r = {
    ...envelope(), detail: "summary", origin: { x: 0.5, z: 0.5 }, grid: 8,
    unloaded: 0, truncated: false, covered_radius: 8, columns: 289,
    palette: [{ block: "minecraft:grass_block", count: 280, aff: "s" }, { block: "minecraft:emerald_block", count: 9, aff: "s" }],
    heights: { min: 63, max: 70, mean: 64.2 },
    anomalies_total: 1, anomalies: [{ x: 5, y: 70, z: 10, block: "minecraft:emerald_block" }],
  };
  const n = EXTRACTORS.get_surface({}, r);
  assert.deepEqual(n.cellValues, [[5, 70, 10, "minecraft:emerald_block"]]);
  assert.deepEqual(n.value.palette, [{ block: "minecraft:grass_block", count: 280 }, { block: "minecraft:emerald_block", count: 9 }]);
  assert.equal(n.confirms, true);
  assert.deepEqual(n.area.cells, [[5, 70, 10]]);
});

test("describe_box summary: aggregate sweep, never per-cell — except a complete all-air box", () => {
  const r = {
    ...envelope(), box: { min: "0,60,0", max: "4,62,4" }, volume: 75, air: 70, unloaded_columns: 0,
    materials: [{ block: "minecraft:emerald_block", count: 5, aff: "s", bbox: "1,60,1 .. 2,61,2" }],
    nonair_bbox: { min: "1,60,1", max: "2,61,2" },
  };
  const n = EXTRACTORS.describe_box({}, r);
  assert.equal(n.confirms, false, "a summary cannot vouch per-cell");
  assert.deepEqual(n.area.box, [[0, 60, 0], [4, 62, 4]]);
  assert.deepEqual(n.value.materials, [{ block: "minecraft:emerald_block", count: 5, bbox: "1,60,1 .. 2,61,2" }]);
  const allAir = EXTRACTORS.describe_box({}, { ...r, air: 75, materials: [] });
  assert.equal(allAir.confirms, true, "air == volume over a complete box IS cell-exact");
  assert.equal(allAir.impliedAir, true);
});

test("describe_box layers: slices decode by their labels; air is implied, never stored per cell", () => {
  const r = {
    ...envelope(), box: { min: "0,60,0", max: "2,61,2" }, volume: 18, air: 14, unloaded_columns: 0,
    materials: [{ block: "minecraft:oak_log", count: 3 }, { block: "minecraft:chest", count: 1 }],
    nonair_bbox: { min: "0,60,0", max: "1,61,1" },
    legend: { a: "minecraft:oak_log", b: "minecraft:chest" },
    layers: {
      60: ["x: 0..2 (left..right)", "z=0|aa.", "z=1|.b.", "z=2|..."],
      61: ["x: 0..2 (left..right)", "z=0|a..", "z=1|...", "z=2|..."],
    },
  };
  const n = EXTRACTORS.describe_box({}, r);
  assert.equal(n.impliedAir, true);
  assert.deepEqual(n.cellValues.sort(), [
    [0, 60, 0, "minecraft:oak_log"], [0, 61, 0, "minecraft:oak_log"],
    [1, 60, 0, "minecraft:oak_log"], [1, 60, 1, "minecraft:chest"],
  ].sort());
  // Partial scan: unloaded columns render like air in the slices — per-cell trust is impossible.
  const partial = EXTRACTORS.describe_box({}, { ...r, unloaded_columns: 2 });
  assert.equal(partial.confirms, false);
  assert.equal(partial.cellValues, undefined);
});

test("locate: search mode stores the result set; identify mode is the point read it delegates to", () => {
  const search = {
    ...envelope(), what: "minecraft:chest", center: { x: 0.5, y: 64, z: 0.5 },
    search: { mechanism: "poi_index", tick: 1000, what: "minecraft:chest", found: 2, radius: 64, negative_is_proof: false, extent: "saved POI sections within 64 blocks of centre" },
    found: [
      { handle: "@a1", kind: "block", id: "minecraft:chest", pos: { x: 5, y: 64, z: 9 } },
      { handle: "@a2", kind: "poi", id: "minecraft:chest", pos: { x: -3, z: 12 } },
    ],
  };
  const n = EXTRACTORS.locate({ radius: 64 }, search);
  assert.equal(n.confirms, false);
  assert.equal(n.value.found.length, 2);
  assert.deepEqual(n.value.found[1].pos, [-3, null, 12], "a y-less hit keeps its y unknown");
  assert.equal(n.value.search.negative_is_proof, false);

  const identify = {
    ...envelope(), direction: "identify",
    palette: ["minecraft:spawner"], blocks: [[7, 30, 7, 0]],
    found: { handle: "@b1", kind: "block", id: "minecraft:spawner", pos: { x: 7, y: 30, z: 7 } },
  };
  const ni = EXTRACTORS.locate({}, identify);
  assert.equal(ni.confirms, true);
  assert.deepEqual(ni.cellValues, [[7, 30, 7, "minecraft:spawner"]]);
});

test("raycast: a block hit is one exact cell; a miss records nothing", () => {
  const hit = { ...envelope(), hit: "block", distance: 4.2, block: { block: "minecraft:stone", aff: "s", pos: { x: 1, y: 2, z: 3 }, face: "up" } };
  const n = EXTRACTORS.raycast({}, hit);
  assert.deepEqual(n.cellValues, [[1, 2, 3, "minecraft:stone"]]);
  assert.equal(EXTRACTORS.raycast({}, { ...envelope(), hit: "miss" }), null);
  assert.equal(EXTRACTORS.raycast({}, { ...envelope(), hit: "unread" }), null);
});

test("raycast_fan: block rays are exact cells; entity/miss/unread rays record nothing", () => {
  // Compact rows [dyaw, dpitch, kind, id, distance, x, y, z] — WorldPerceptionTools.raycastFan,
  // verified against the mod's serializer 2026-07-29.
  const r = {
    ...envelope(), origin: { x: 0.5, y: 65, z: 0.5 }, source: "drone", range: 32,
    center_yaw: 90, center_pitch: 0,
    rays: [
      [-45, 0, "b", "minecraft:stone", 4.2, 1, 64, 3],
      [0, 0, "e", "minecraft:cow", 6.1, 2, 64, 6],
      [22.5, 0, "m"],
      [45, 0, "u", 12.5],
      [10, 0, "b", "minecraft:chest", 8.0, 5, 65, 7],
    ],
    hits: { "minecraft:stone": 1, "minecraft:cow": 1, miss: 1, unread: 1, "minecraft:chest": 1 },
  };
  const n = EXTRACTORS.raycast_fan({}, r);
  assert.deepEqual(n.cellValues, [[1, 64, 3, "minecraft:stone"], [5, 65, 7, "minecraft:chest"]]);
  assert.deepEqual(n.area, { cells: [[1, 64, 3], [5, 65, 7]], complete: true });
  assert.equal(n.confirms, true, "a sightline hit IS a read of that cell");
  // An all-miss fan observed no cell; a drifted shape is skipped LOUDLY rather than stored empty.
  assert.equal(EXTRACTORS.raycast_fan({}, { ...envelope(), rays: [[0, 0, "m"], [1, 0, "u", 3]] }), null);
  assert.equal(EXTRACTORS.raycast_fan({}, { ...envelope() }).skip, "expected rays rows");
});

test("every spatial world read is DECLARED captured or uncaptured — no silent narrowing", () => {
  // The conformance suite's spatial+world-read tier (probes/conformance.test.mjs SPEC), frozen
  // here: a new world read must pick a side the day it ships.
  const worldReads = [
    "scene_summary", "get_surface", "get_blocks_at", "describe_box", "check_path", "check_site",
    "get_region_summary", "resolve_anchor", "get_entities", "raycast", "raycast_fan", "locate",
    "sense_entities", "get_region",
  ];
  for (const t of worldReads) {
    assert.ok(t in EXTRACTORS || t in UNCAPTURED_WORLD_READS, `${t}: neither captured nor declared uncaptured`);
  }
  for (const t of Object.keys(EXTRACTORS)) {
    assert.ok(!(t in UNCAPTURED_WORLD_READS), `${t}: declared both captured and uncaptured`);
  }
});

// --- hook + query tools end-to-end (offline; bridge stub answers get_world_info only) -------------

test("captureWorldRead: records reads, tolerates junk, honors the ablation switch", async () => {
  resetCaptureCache();
  const read = {
    ...envelope(2000), detail: "state",
    palette: ["minecraft:emerald_block"],
    blocks: [[10, 200, 10, 0], [10, 201, 10, 0], [11, 200, 10, 0], [10, 200, 11, 0], [11, 201, 11, 0], [11, 200, 11, 0]],
  };
  const out = await captureWorldRead("get_blocks_at", { blocks: [] }, read, fakeBridge);
  assert.deepEqual(out, { captured: true, cells_new: 6, cells_changed: 0, cells_unchanged: 0 });

  // Non-captured tool, missing envelope, malformed shape, dead bridge: skipped, never thrown.
  assert.equal((await captureWorldRead("send_chat", {}, { ok: true }, fakeBridge)).captured, false);
  assert.equal((await captureWorldRead("get_blocks_at", {}, { detail: "state" }, fakeBridge)).captured, false);
  const drifted = await captureWorldRead("get_blocks_at", {}, { ...envelope(2100), detail: "state" }, fakeBridge);
  assert.equal(drifted.captured, false, "shape drift is skipped (and logged), not stored");
  const deadBridge = async () => { throw new Error("ECONNREFUSED"); };
  // World identity is cached from the successful capture above, so even a dead bridge still records.
  const cached = await captureWorldRead("raycast", {}, { ...envelope(2200), hit: "block", distance: 1, block: { block: "minecraft:dirt", pos: { x: 0, y: 0, z: 0 } } }, deadBridge);
  assert.equal(cached.captured, true);

  process.env.MCPTK_OBS_CAPTURE = "off";
  try {
    const off = await captureWorldRead("get_blocks_at", {}, read, fakeBridge);
    assert.deepEqual(off, { captured: false, reason: "disabled" });
  } finally {
    delete process.env.MCPTK_OBS_CAPTURE;
  }
});

test("mem_recall answers from capture: exact counts and bounds, labelled remembered, with age", async () => {
  // The emerald cluster captured above — mem_seen's box answer, relocated into mem_recall (§3).
  const seen = await memTools.callLocalTool("mem_recall", {
    box: { min: { x: 0, y: 190, z: 0 }, max: { x: 20, y: 210, z: 20 } },
  }, fakeBridge);
  assert.equal(seen.ok, true, seen.error);
  const emerald = seen.result.observed.by_id.find((e) => e.id === "minecraft:emerald_block");
  assert.equal(emerald.count, 6, "the exact cluster size — what prose narration kept losing");
  assert.deepEqual(emerald.bbox, [[10, 200, 10], [11, 201, 11]]);
  assert.match(seen.result.render, /REMEMBERED block values/);
  assert.match(seen.result.render, /ago/, "age rendered from the bridge's current tick");
  assert.match(seen.result.render, /NOT a live read/);

  // A point answer with its history, and an honest unknown for a cell nothing ever read.
  await captureWorldRead("get_blocks_at", {}, {
    ...envelope(8000), detail: "state", palette: ["minecraft:air"], blocks: [[10, 200, 10, 0]],
  }, fakeBridge);
  const point = await memTools.callLocalTool("mem_recall", { at: { x: 10, y: 200, z: 10 } }, fakeBridge);
  assert.equal(point.result.observed.cell.val, "minecraft:air");
  assert.match(point.result.render, /previously minecraft:emerald_block/);
  const never = await memTools.callLocalTool("mem_recall", { at: { x: 999, y: 64, z: 999 } }, fakeBridge);
  assert.match(never.result.render, /never observed/);
  assert.match(never.result.render, /look with a live read/);
});

test("the memory registry is exactly the redesigned 8-tool surface", () => {
  const names = memTools.localTools().map((t) => t.name).sort();
  assert.deepEqual(names, [
    "mem_dismiss", "mem_note", "mem_place", "mem_recall",
    "mem_recent", "mem_task", "mem_write_block",
  ].sort(), "13 → 8: mem_seen/mem_changes/mem_last_seen/mem_locate/mem_verify are gone, mem_read merged");
  for (const gone of ["mem_seen", "mem_changes", "mem_last_seen", "mem_locate", "mem_verify", "mem_read"]) {
    assert.ok(!memTools.isLocalTool(gone), `${gone} must no longer resolve as a local tool`);
  }
  const recall = memTools.localTools().find((t) => t.name === "mem_recall");
  for (const p of ["ids", "at", "box"]) {
    assert.ok(p in recall.inputSchema.properties, `mem_recall must absorb ${p}`);
  }
});

test("locate's unresolvable-`what` fallthrough is scoped to exactly that error class", () => {
  // The two shapes LocateTools.resolveTarget raises when nothing in any registry matches.
  assert.ok(memTools.isUnresolvableWhat("`what` is not a valid id: wheat farm (expected e.g. …)"));
  assert.ok(memTools.isUnresolvableWhat(
    "unknown target 'minecraft:nope' — not a structure, point-of-interest type, entity type, "
    + "biome or block in this world. Prefix it (structure:/poi:/entity:/biome:/block:) to force "
    + "one index, or use query_registry to find the right id."));
  // Real argument errors must keep erroring — swallowing these turns a typo into an empty search.
  // An unknown TAG is one of them: `#…` is registry-shaped by construction, so it is a typo,
  // never a concept the memory could hold (toolkit 0.29.0 resolves real tags, LOCATE_ROUTES B1).
  assert.ok(!memTools.isUnresolvableWhat(
    "unknown tag '#minecraft:nope' — not a structure, point-of-interest, entity, biome or block "
    + "tag in this world."));
  assert.ok(!memTools.isUnresolvableWhat("radius must be positive"));
  assert.ok(!memTools.isUnresolvableWhat("pattern.anchor names unknown node 'a'"));
  assert.ok(!memTools.isUnresolvableWhat(undefined));
});
