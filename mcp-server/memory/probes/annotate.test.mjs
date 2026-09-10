// Annotate probes — MEMORY_REDESIGN.md §2.2, offline, against fixture results copied from the mod's
// real serializers. Pin the contract the whole cycle rests on: the delta arrives on the read the
// agent was already making, it arrives exactly once, it never touches the live payload's own
// fields, and it is silent when memory agrees with what the tool just returned.

import { test } from "node:test";
import assert from "node:assert";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// MEMORY_ROOT binds at import time — the env must be set before annotate.mjs (→ tools.mjs) loads.
const root = await mkdtemp(join(tmpdir(), "mcobs-ann-"));
process.env.MCPTK_MEMORY_DIR = root;
process.env.MCPTK_EMBED_BACKEND ??= "none";
const { processWorldRead, attachRemembered, UNANNOTATED_CASES, ANNOTATED_TOOLS } =
  await import("../annotate.mjs");
const { EXTRACTORS, resetCaptureCache, storeFor } = await import("../capture.mjs");

const DIM = "minecraft:overworld";
const WORLD_UUID = "ann-test-world";

async function fakeBridge(tool) {
  if (tool === "get_world_info") {
    return { ok: true, result: { world_uuid: WORLD_UUID, name: "ann-test", game_tick: 9000 } };
  }
  return { ok: false, error: `unexpected bridge call ${tool}` };
}

const envelope = (tick) => ({ perception_mode: "spatial", game_tick: tick, dimension: DIM, mechanism: "observe" });

/** A get_blocks_at result over one cell. */
function blocksAt(tick, cells, palette) {
  return {
    ...envelope(tick), detail: "state", palette,
    blocks: cells.map(([x, y, z, pi]) => [x, y, z, pi]),
  };
}

test("the appendix is silent on first sight and on agreement, and fires exactly once on a change", async () => {
  resetCaptureCache();
  const at = (tick, pi, pal) => blocksAt(tick, [[10, 64, 20, pi]], pal);

  // 1. First sight: the agent has no prior here. Announcing "CHANGED" would fabricate a history.
  const first = await processWorldRead("get_blocks_at", {}, at(1000, 0, ["minecraft:chest"]), fakeBridge);
  assert.equal(first.remembered, null, "first sight is not a change");
  assert.equal(first.capture.captured, true, "capture runs regardless — annotate is the second job, not a gate");

  // 2. Agreement: the read matches memory. No news costs no bytes.
  const same = await processWorldRead("get_blocks_at", {}, at(2000, 0, ["minecraft:chest"]), fakeBridge);
  assert.equal(same.remembered, null);

  // 3. The change arrives UNBIDDEN, on the read the agent was already making.
  const changed = await processWorldRead("get_blocks_at", {}, at(3000, 0, ["minecraft:air"]), fakeBridge);
  assert.match(changed.remembered, /CHANGED since you last looked/);
  assert.match(changed.remembered, /minecraft:chest/, "the prior value");
  assert.match(changed.remembered, /now minecraft:air/);
  assert.match(changed.remembered, /@tick 2000/, "the prior is tick-stamped");
  assert.match(changed.remembered, /NOT a live read/, "the remembered section is always labelled");
  assert.deepEqual(changed.remembered_kinds, ["delta"]);

  // 4. Told once. A re-read of the same cell says nothing — the disclosure cleared it.
  const again = await processWorldRead("get_blocks_at", {}, at(4000, 0, ["minecraft:air"]), fakeBridge);
  assert.equal(again.remembered, null, "a told change is never re-told");
});

test("a complete scan's silence about a remembered block is reported as a vanish", async () => {
  resetCaptureCache();
  const store = await storeFor(WORLD_UUID);
  await store.record({
    tool: "get_blocks_at", tick: 1000, dim: DIM, session: "s-probe", confirms: true,
    area: { cells: [[3, 201, 3]], complete: true },
    cellValues: [[3, 201, 3, "minecraft:white_wool"]],
  });
  // describe_box layers over the platform — the wool is simply not in the slices any more.
  const scan = {
    ...envelope(5000), box: { min: "0,200,0", max: "5,202,5" }, volume: 108, air: 108,
    unloaded_columns: 0, materials: [],
    legend: {}, layers: {
      200: ["x: 0..5 (left..right)", "z=0|......", "z=1|......", "z=2|......", "z=3|......", "z=4|......", "z=5|......"],
      201: ["x: 0..5 (left..right)", "z=0|......", "z=1|......", "z=2|......", "z=3|......", "z=4|......", "z=5|......"],
      202: ["x: 0..5 (left..right)", "z=0|......", "z=1|......", "z=2|......", "z=3|......", "z=4|......", "z=5|......"],
    },
  };
  const ann = await processWorldRead("describe_box", {}, scan, fakeBridge);
  assert.match(ann.remembered, /\(3,201,3\)/);
  assert.match(ann.remembered, /minecraft:white_wool/);
  assert.match(ann.remembered, /GONE/, "a disappearance has no live evidence — silence must not hide it");
});

test("an appearance out of scanned-empty space carries its implied-air prior", async () => {
  resetCaptureCache();
  const store = await storeFor(WORLD_UUID);
  await store.record({
    tool: "describe_box", tick: 1000, dim: DIM, session: "s-probe", confirms: true, impliedAir: true,
    area: { box: [[20, 200, 20], [28, 202, 28] ], complete: true }, cellValues: [],
  });
  const ann = await processWorldRead("get_blocks_at", {},
    blocksAt(6000, [[24, 201, 24, 0]], ["minecraft:sponge"]), fakeBridge);
  assert.match(ann.remembered, /CHANGED since you last looked/);
  assert.match(ann.remembered, /implied by your complete scan/);
  assert.match(ann.remembered, /now minecraft:sponge/);
});

test("unread (-1) rows are filled from memory, labelled NOT live; the live payload keeps its -1", async () => {
  resetCaptureCache();
  const store = await storeFor(WORLD_UUID);
  await store.record({
    tool: "get_blocks_at", tick: 500, dim: DIM, session: "s-probe", confirms: true,
    area: { cells: [[40, 64, 40]], complete: true },
    cellValues: [[40, 64, 40, "minecraft:gold_block"]],
  });
  const result = {
    ...envelope(7000), detail: "state", palette: ["minecraft:stone"],
    blocks: [[41, 64, 40, 0], [40, 64, 40, -1]],
  };
  const ann = await processWorldRead("get_blocks_at", {}, result, fakeBridge);
  assert.match(ann.remembered, /remembered \(NOT live\): \(40,64,40\) minecraft:gold_block/);
  assert.deepEqual(ann.remembered_kinds, ["fill"]);
  attachRemembered(result, ann);
  assert.deepEqual(result.blocks[1], [41, 64, 40, 0].slice(0, 0).concat([40, 64, 40, -1]),
    "the -1 not-read convention is untouched — remembered content is NEVER blended into the live rows");
  assert.equal(result.remembered_served, true);

  // A -1 row memory knows nothing about stays silent: the -1 already says "unread", and
  // "nothing in memory either" is text reserved for searches, where absence is the answer.
  const blank = await processWorldRead("get_blocks_at", {}, {
    ...envelope(7100), detail: "state", palette: [], blocks: [[900, 64, 900, -1]],
  }, fakeBridge);
  assert.equal(blank.remembered, null);
});

test("locate search: remembered sites when the live sweep is empty, never merged into `found`", async () => {
  resetCaptureCache();
  const store = await storeFor(WORLD_UUID);
  await store.record({
    tool: "get_blocks_at", tick: 800, dim: DIM, session: "s-probe", confirms: true,
    area: { cells: [[120, 64, -40]], complete: true },
    cellValues: [[120, 64, -40, "minecraft:chest"]],
  });
  const empty = {
    ...envelope(8000), what: "minecraft:chest", center: { x: 0.5, y: 64, z: 0.5 }, found: [],
    search: { mechanism: "poi_index", found: 0, radius: 64, negative_is_proof: false },
  };
  const ann = await processWorldRead("locate", { radius: 64 }, empty, fakeBridge);
  assert.match(ann.remembered, /no live matches; remembered sites/);
  assert.match(ann.remembered, /walk there and look/, "no handles for remembered hits — §5.1");
  assert.match(ann.remembered, /120,64,-40/);
  assert.deepEqual(ann.remembered_kinds, ["search"]);
  attachRemembered(empty, ann);
  assert.deepEqual(empty.found, [], "`found` is a LIVE result set and must stay untouched");

  // Absent from memory too: one truthful sentence, and it does not claim absence from the world.
  const nothing = await processWorldRead("locate", { radius: 64 }, {
    ...envelope(8100), what: "minecraft:beacon", center: { x: 0.5, y: 64, z: 0.5 }, found: [],
    search: { mechanism: "poi_index", found: 0, radius: 64, negative_is_proof: false },
  }, fakeBridge);
  assert.match(nothing.remembered, /nothing in memory either/);
  assert.match(nothing.remembered, /not proven absent from the world/);
});

test("MCPTK_OBS_ANNOTATE=off: capture still runs, the appendix does not — the h/j arm", async () => {
  resetCaptureCache();
  await processWorldRead("get_blocks_at", {}, blocksAt(1000, [[60, 64, 60, 0]], ["minecraft:chest"]), fakeBridge);
  process.env.MCPTK_OBS_ANNOTATE = "off";
  try {
    const result = blocksAt(2000, [[60, 64, 60, 0]], ["minecraft:air"]);
    const ann = await processWorldRead("get_blocks_at", {}, result, fakeBridge);
    assert.equal(ann.remembered, null, "no appendix");
    assert.equal(ann.capture.captured, true, "capture is governed by its OWN flag — the arms differ in the appendix alone");
    attachRemembered(result, ann);
    assert.equal(result.remembered_served, undefined, "an unannotated result gains no fields at all");
  } finally {
    delete process.env.MCPTK_OBS_ANNOTATE;
  }
});

test("a store failure degrades to the plain result plus a LOUD line — never a broken tool call", async () => {
  resetCaptureCache();
  const store = await storeFor(WORLD_UUID);
  const realDelta = store.deltaView.bind(store);
  store.deltaView = async () => { throw new Error("injected store failure"); };
  const errs = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => { errs.push(String(s)); return true; };
  try {
    const result = blocksAt(3000, [[70, 64, 70, 0]], ["minecraft:stone"]);
    const ann = await processWorldRead("get_blocks_at", {}, result, fakeBridge);
    assert.equal(ann.remembered, null);
    assert.equal(ann.capture.captured, true, "the failure is contained to the appendix");
    attachRemembered(result, ann);
    assert.equal(result.palette[0], "minecraft:stone", "the live payload is untouched");
  } finally {
    process.stderr.write = write;
    store.deltaView = realDelta;
  }
  assert.ok(errs.some((e) => /\[annotate\].*injected store failure/.test(e)),
    "silence here would read downstream as 'memory had nothing to say' — a different claim entirely");
});

test("the digest surfaces changes no read would have shown, once, then clears itself", async () => {
  resetCaptureCache();
  const memTools = await import("../tools.mjs");
  const store = await storeFor(WORLD_UUID);
  await store.record({
    tool: "get_blocks_at", tick: 1000, dim: DIM, session: "s-probe", confirms: true,
    area: { cells: [[80, 201, 80]], complete: true },
    cellValues: [[80, 201, 80, "minecraft:white_wool"]],
  });
  // A change nobody's read carried into a context window — the case the on-read delta cannot cover,
  // because the agent has no reason to look at this cell again.
  await store.record({
    tool: "get_blocks_at", tick: 4000, dim: DIM, session: "s-other", confirms: true,
    channel: "ambient", area: { cells: [[80, 201, 80]], complete: true },
    cellValues: [[80, 201, 80, "minecraft:air"]],
  });

  const first = await memTools.callLocalTool("mem_recent", {}, fakeBridge);
  assert.match(first.result.render, /while you were away/);
  assert.match(first.result.render, /minecraft:white_wool/, "the prior");
  assert.match(first.result.render, /now minecraft:air/);
  assert.equal(first.result.unseen_changes.total, 1);
  assert.match(first.result.render.split("\n")[0], /^## Memory @ tick/, "the header line stays first");

  const second = await memTools.callLocalTool("mem_recent", {}, fakeBridge);
  assert.doesNotMatch(second.result.render, /while you were away/, "rendering IS the disclosure — told once");
  assert.equal(second.result.unseen_changes, undefined);
});

test("MCPTK_OBS_ANNOTATE=off silences the digest too — the flag governs the whole push channel", async () => {
  resetCaptureCache();
  const memTools = await import("../tools.mjs");
  const store = await storeFor(WORLD_UUID);
  await store.record({
    tool: "get_blocks_at", tick: 1000, dim: DIM, session: "s-probe", confirms: true,
    area: { cells: [[85, 201, 85]], complete: true }, cellValues: [[85, 201, 85, "minecraft:gold_block"]],
  });
  await store.record({
    tool: "get_blocks_at", tick: 4000, dim: DIM, session: "s-other", confirms: true, channel: "ambient",
    area: { cells: [[85, 201, 85]], complete: true }, cellValues: [[85, 201, 85, "minecraft:air"]],
  });
  process.env.MCPTK_OBS_ANNOTATE = "off";
  try {
    const off = await memTools.callLocalTool("mem_recent", {}, fakeBridge);
    assert.doesNotMatch(off.result.render, /while you were away/);
  } finally {
    delete process.env.MCPTK_OBS_ANNOTATE;
  }
  // Still pending once the channel is back on: silencing is not the same as disclosing.
  const on = await memTools.callLocalTool("mem_recent", {}, fakeBridge);
  assert.match(on.result.render, /while you were away/);
});

test("every captured read declares its annotate coverage — the anti-silent-narrowing ledger", () => {
  for (const tool of Object.keys(EXTRACTORS)) {
    const declaredPartial = Object.keys(UNANNOTATED_CASES).some((k) => k.startsWith(`${tool}:`));
    assert.ok(ANNOTATED_TOOLS.has(tool) || declaredPartial,
      `${tool}: captured but neither annotated nor declared in UNANNOTATED_CASES`);
  }
  for (const key of Object.keys(UNANNOTATED_CASES)) {
    const tool = key.split(":")[0];
    assert.ok(tool in EXTRACTORS, `${key}: names a tool that is not captured at all`);
    assert.ok(UNANNOTATED_CASES[key].length > 40, `${key}: a deferral needs its reason, not just a name`);
  }
});
