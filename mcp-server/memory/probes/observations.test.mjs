// Observation store probes — OBSERVATION_MEMORY_DESIGN.md §7 step 1, offline, synthetic streams.
// Pin the §3 contract: cell-keyed supersession, change history only where values differed,
// storage scaling with change (unchanged re-observation appends no cells), implied air over
// complete box scans, freshness derived from covering reads, and honest unknowns everywhere.

import { test } from "node:test";
import assert from "node:assert";
import { mkdtemp, readFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObservationStore, OBS_FILE, HIST_CAP, baseId, validateObservation, AIR } from "../observations.mjs";

const WORLD = "obs-world-0000";
const DIM = "minecraft:overworld";
const SESSION = "s-probe";

async function makeStore() {
  const root = await mkdtemp(join(tmpdir(), "mcobs-"));
  const store = new ObservationStore(root, WORLD);
  await store.open();
  return { root, store };
}

async function fileLines(root) {
  try {
    const text = await readFile(join(root, WORLD, OBS_FILE), "utf8");
    return text.split("\n").filter(Boolean);
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}

/** A get_blocks_at-shaped observation over explicit cells. */
function pointRead(cells, tick, extra = {}) {
  return {
    tool: "get_blocks_at",
    tick,
    dim: DIM,
    session: SESSION,
    confirms: true,
    area: { cells: cells.map(([x, y, z]) => [x, y, z]), complete: true },
    cellValues: cells,
    ...extra,
  };
}

test("validation rejects undated and unplaced observations", () => {
  assert.ok(validateObservation({}).length > 0);
  assert.ok(validateObservation(pointRead([[1, 2, 3, "minecraft:stone"]], null)).some((v) => v.startsWith("tick")));
  const noDim = { ...pointRead([[1, 2, 3, "minecraft:stone"]], 10), dim: "overworld" };
  assert.ok(validateObservation(noDim).some((v) => v.startsWith("dim")));
  const twoAreas = { ...pointRead([], 10), area: { cells: [], box: [[0, 0, 0], [1, 1, 1]], complete: true } };
  assert.ok(validateObservation(twoAreas).some((v) => v.startsWith("area")));
  assert.equal(validateObservation(pointRead([[1, 2, 3, "minecraft:stone"]], 10)).length, 0);
});

test("baseId strips state and nbt, keeps the id", () => {
  assert.equal(baseId("minecraft:chest[facing=north]"), "minecraft:chest");
  assert.equal(baseId("minecraft:chest{items:[]}"), "minecraft:chest");
  assert.equal(baseId("minecraft:stone"), "minecraft:stone");
});

test("first observation stores the value; queries return it with tick and provenance", async () => {
  const { store } = await makeStore();
  const counts = await store.record(pointRead([[10, 64, 20, "minecraft:emerald_block"]], 1000));
  assert.deepEqual(counts, { cells_new: 1, cells_changed: 0, cells_unchanged: 0 });
  const seen = await store.seenAt({ pos: [10, 64, 20], dim: DIM });
  assert.equal(seen.observed, true);
  assert.equal(seen.cell.val, "minecraft:emerald_block");
  assert.equal(seen.cell.tick, 1000);
  assert.equal(seen.cell.tool, "get_blocks_at");
  // Honest unknown: a cell no read ever covered says so.
  const unseen = await store.seenAt({ pos: [999, 64, 999], dim: DIM });
  assert.equal(unseen.observed, false);
  assert.equal(unseen.cell, null);
});

test("re-observing an unchanged cell appends no cell data but extends freshness", async () => {
  const { root, store } = await makeStore();
  await store.record(pointRead([[10, 64, 20, "minecraft:stone"]], 1000));
  await store.record(pointRead([[10, 64, 20, "minecraft:stone"]], 5000));
  const lines = await fileLines(root);
  assert.equal(lines.length, 2);
  const second = JSON.parse(lines[1]);
  assert.equal(second.cells, undefined, "unchanged re-observation must not re-store the cell");
  const seen = await store.seenAt({ pos: [10, 64, 20], dim: DIM });
  assert.equal(seen.cell.tick, 1000, "value's first-seen tick is preserved");
  assert.equal(seen.cell.last_confirmed_tick, 5000, "covering read extends freshness");
});

test("a changed value supersedes as current and retains the old value as history", async () => {
  const { store } = await makeStore();
  await store.record(pointRead([[10, 64, 20, "minecraft:emerald_block"]], 1000));
  await store.record(pointRead([[10, 64, 20, "minecraft:air"]], 8000));
  const seen = await store.seenAt({ pos: [10, 64, 20], dim: DIM });
  assert.equal(seen.cell.val, "minecraft:air");
  assert.equal(seen.cell.tick, 8000);
  assert.equal(seen.cell.previous.length, 1);
  assert.equal(seen.cell.previous[0].val, "minecraft:emerald_block");
  assert.equal(seen.cell.previous[0].tick, 1000);
});

test("deltaView: change fires, refinement and agreement stay silent, first sight is not a change", async () => {
  const { store } = await makeStore();
  await store.record(pointRead([
    [0, 64, 0, "minecraft:dirt"],
    [1, 64, 0, "minecraft:chest"],
    [2, 64, 0, "minecraft:stone"],
  ], 1000));
  // The read the agent is ABOUT to be served: dirt→gold (change), chest→chest[facing] (same id,
  // a cross-tool detail refinement — never a world change), stone unchanged, one never-seen cell.
  const d = await store.deltaView({
    dim: DIM,
    cells: [
      [0, 64, 0, "minecraft:gold_block"],
      [1, 64, 0, "minecraft:chest[facing=north]"],
      [2, 64, 0, "minecraft:stone"],
      [3, 64, 0, "minecraft:oak_log"],
    ],
  });
  const byPos = new Map(d.map((e) => [e.pos.join(","), e]));
  assert.equal(byPos.get("0,64,0").was.val, "minecraft:dirt");
  assert.equal(byPos.get("0,64,0").was.tick, 1000);
  assert.equal(byPos.get("0,64,0").live_val, "minecraft:gold_block");
  assert.ok(!byPos.has("1,64,0"), "a same-id refinement must never masquerade as a world change");
  assert.ok(!byPos.has("2,64,0"), "agreement is silent — no news costs no bytes");
  assert.equal(byPos.get("3,64,0").was, null, "first sight: reported as new-to-you, NOT as a change");
});

test("deltaView is silent once its delta has been disclosed, and after the read supersedes", async () => {
  const { store } = await makeStore();
  await store.record(pointRead([[10, 64, 20, "minecraft:chest"]], 1000));
  const first = await store.deltaView({ dim: DIM, cells: [[10, 64, 20, "minecraft:air"]] });
  assert.equal(first.length, 1, "the change is served exactly once");
  // Annotate's own sequence: serve the delta, record the read, persist the disclosure.
  await store.record(pointRead([[10, 64, 20, "minecraft:air"]], 2000));
  await store.recordDisclosure({ tick: 2000, dim: DIM, session: SESSION, cells: [[10, 64, 20]] });
  const second = await store.deltaView({ dim: DIM, cells: [[10, 64, 20, "minecraft:air"]] });
  assert.deepEqual(second, [], "a told change is not re-told");
});

test("deltaView fires on a cross-session supersession, before the second session's read lands", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcobs-"));
  const a = await new ObservationStore(root, WORLD).open();
  const b = await new ObservationStore(root, WORLD).open();
  await a.record(pointRead([[4, 70, 4, "minecraft:chest"]], 1000));
  // b never saw a's write. Its own read is about to report air — the delta must be computed against
  // a's observation (one agent, one memory: §2.3's per-agent disclosure), not against nothing.
  const d = await b.deltaView({ dim: DIM, cells: [[4, 70, 4, "minecraft:air"]] });
  assert.equal(d.length, 1);
  assert.equal(d[0].was.val, "minecraft:chest");
});

test("channel: an ambient write supersedes without eating the delta, and dates it", async () => {
  const { store } = await makeStore();
  await store.record(pointRead([[7, 65, 7, "minecraft:chest"]], 1000));
  // A sensor writes without anyone reading the result (cycle 4's retina; nothing writes this today).
  await store.record({ ...pointRead([[7, 65, 7, "minecraft:air"]], 4000), channel: "ambient" });
  const d = await store.deltaView({ dim: DIM, cells: [[7, 65, 7, "minecraft:air"]] });
  assert.equal(d.length, 1, "the agent still has not looked — the ambient write must not eat its delta");
  assert.equal(d[0].was.val, "minecraft:chest", "comparand is last-DELIBERATE, not the store's tick");
  assert.equal(d[0].was.tick, 1000);
  assert.equal(d[0].ambient_seen.val, "minecraft:air");
  assert.equal(d[0].ambient_seen.tick, 4000, "strictly better than deliberate-only: the change is dated");
});

test("deltaView: a complete scan's silence about a remembered block is a VANISH, not an absence", async () => {
  const { store } = await makeStore();
  await store.record(pointRead([[5, 201, 5, "minecraft:white_wool"]], 1000));
  // A complete box scan that no longer reports the wool. Nothing in the live payload mentions it —
  // this is the one change with no live evidence whatsoever.
  const d = await store.deltaView({
    dim: DIM,
    cells: [[6, 201, 6, "minecraft:stone"]],
    impliedAirBox: [[0, 199, 0], [9, 203, 9]],
  });
  const vanished = d.find((e) => e.pos.join(",") === "5,201,5");
  assert.equal(vanished.was.val, "minecraft:white_wool");
  assert.equal(vanished.live_val, AIR);
  assert.equal(vanished.vanished, true);
});

test("deltaView: implied air is a real prior — appearing out of scanned-empty space is a change", async () => {
  const { store } = await makeStore();
  // A complete scan of an empty platform: the agent looked and saw nothing there.
  await store.record({
    tool: "describe_box",
    tick: 1000,
    dim: DIM,
    session: SESSION,
    confirms: true,
    impliedAir: true,
    area: { box: [[0, 200, 0], [8, 202, 8]], complete: true },
    cellValues: [],
  });
  const d = await store.deltaView({ dim: DIM, cells: [[4, 201, 4, "minecraft:sponge"]] });
  assert.equal(d.length, 1);
  assert.equal(d[0].was.val, AIR);
  assert.equal(d[0].was.implied, true, "'I scanned this space and it was empty' is a prior, not a blank");
  assert.equal(d[0].was.tick, 1000);
  // A cell OUTSIDE that scan has no prior at all and must stay first-sight.
  const outside = await store.deltaView({ dim: DIM, cells: [[50, 201, 50, "minecraft:sponge"]] });
  assert.equal(outside[0].was, null);
});

test("unseenChanges: an undisclosed supersession enters the ledger; disclosing it clears it", async () => {
  const { store } = await makeStore();
  await store.record(pointRead([[1, 64, 1, "minecraft:chest"]], 1000));
  assert.equal((await store.unseenChanges()).total, 0, "nothing is untold yet");
  // A change detected without being served (ambient sensor / an annotate-off session / a delta list
  // truncated past its render cap): the store knows, the agent does not.
  await store.record({ ...pointRead([[1, 64, 1, "minecraft:air"]], 5000), channel: "ambient" });
  const led = await store.unseenChanges();
  assert.equal(led.total, 1);
  assert.equal(led.entries[0].was.val, "minecraft:chest");
  assert.equal(led.entries[0].now.val, "minecraft:air");
  assert.equal(led.entries[0].now.channel, "ambient");
  // Rendering the digest IS the disclosure — and it is what clears the entry.
  await store.recordDisclosure({ tick: 6000, dim: DIM, session: SESSION, cells: [[1, 64, 1]] });
  assert.equal((await store.unseenChanges()).total, 0, "a told change leaves the ledger");
});

test("a deliberate read of a changed cell never enters the ledger — it discloses itself", async () => {
  const { store } = await makeStore();
  await store.record(pointRead([[2, 64, 2, "minecraft:chest"]], 1000));
  await store.record(pointRead([[2, 64, 2, "minecraft:air"]], 3000));
  assert.equal((await store.unseenChanges()).total, 0);
});

test("disclosure records move last-deliberate and NOTHING else — never freshness", async () => {
  const { store } = await makeStore();
  await store.record(pointRead([[3, 64, 3, "minecraft:stone"]], 1000));
  await store.recordDisclosure({ tick: 9000, dim: DIM, session: SESSION, cells: [[3, 64, 3]] });
  const seen = await store.seenAt({ pos: [3, 64, 3], dim: DIM });
  assert.equal(seen.cell.last_confirmed_tick, 1000, "being told a value re-confirms nothing about the world");
  assert.equal((await store.stats()).records, 2, "the disclosure persists — it must survive a restart");
});

test("disclosure survives a cold reopen, so a told change stays told across processes", async () => {
  const { root, store } = await makeStore();
  await store.record(pointRead([[8, 64, 8, "minecraft:chest"]], 1000));
  await store.record({ ...pointRead([[8, 64, 8, "minecraft:air"]], 2000), channel: "ambient" });
  await store.recordDisclosure({ tick: 2500, dim: DIM, session: SESSION, cells: [[8, 64, 8]] });
  const reopened = await new ObservationStore(root, WORLD).open();
  assert.equal((await reopened.unseenChanges()).total, 0, "disclosure is derivable from the file alone");
});

test("history is bounded: the oldest values drop and older-than-retained answers say approx", async () => {
  const { store } = await makeStore();
  await store.record(pointRead([[0, 64, 0, "minecraft:stone"]], 100));
  // HIST_CAP + 3 further changes, each superseding the last.
  for (let i = 1; i <= HIST_CAP + 3; i++) {
    await store.record({ ...pointRead([[0, 64, 0, `minecraft:block_${i}`]], 100 + i * 100), channel: "ambient" });
  }
  const led = await store.unseenChanges();
  assert.equal(led.total, 1);
  // The prior at tick 100 fell off the retained window: answered with the oldest kept value, FLAGGED.
  assert.equal(led.entries[0].was.approx, true);
  assert.ok(led.entries[0].was.val.startsWith("minecraft:block_"), "degraded to the oldest retained value");
  const seen = await store.seenAt({ pos: [0, 64, 0], dim: DIM });
  assert.equal(seen.cell.previous.length, HIST_CAP, "bounded, per §4");
});

test("records default to the deliberate channel and pre-channel lines read as deliberate", async () => {
  const { root, store } = await makeStore();
  await store.record(pointRead([[9, 64, 9, "minecraft:stone"]], 1000));
  const rec = JSON.parse((await fileLines(root))[0]);
  assert.equal(rec.channel, undefined, "the default is written by omission — old lines stay valid");
  assert.equal((await store.unseenChanges()).total, 0);
  assert.ok(validateObservation({ ...pointRead([], 1), channel: "sideways" }).some((v) => v.startsWith("channel")));
  assert.equal(validateObservation({ ...pointRead([], 1), channel: "ambient" }).length, 0);
});

test("implied air: a complete box scan turns unreported known cells into explicit air changes", async () => {
  const { store } = await makeStore();
  await store.record(pointRead([[5, 60, 5, "minecraft:emerald_block"]], 1000));
  // A complete layers-style scan of the surrounding box that no longer reports the emerald block.
  const counts = await store.record({
    tool: "describe_box",
    tick: 4000,
    dim: DIM,
    session: SESSION,
    confirms: true,
    impliedAir: true,
    area: { box: [[0, 58, 0], [8, 62, 8]], complete: true },
    cellValues: [[2, 60, 2, "minecraft:oak_log"]],
  });
  assert.equal(counts.cells_changed, 1, "the vanished emerald block is an explicit change to air");
  const seen = await store.seenAt({ pos: [5, 60, 5], dim: DIM });
  assert.equal(seen.cell.val, AIR);
  assert.equal(seen.cell.previous[0].val, "minecraft:emerald_block");
  // An unindexed cell inside the complete scan answers as implied air, dated by the scan.
  const implied = await store.seenAt({ pos: [7, 61, 7], dim: DIM });
  assert.equal(implied.observed, true);
  assert.equal(implied.cell.val, AIR);
  assert.equal(implied.cell.implied, true);
  assert.equal(implied.cell.tick, 4000);
  // Outside the scanned box stays honestly unknown.
  const outside = await store.seenAt({ pos: [50, 60, 50], dim: DIM });
  assert.equal(outside.observed, false);
});

test("box query tallies exact per-id counts and bounds — the count/where answer", async () => {
  const { store } = await makeStore();
  await store.record(pointRead([
    [10, 200, 10, "minecraft:emerald_block"],
    [10, 201, 10, "minecraft:emerald_block"],
    [11, 200, 10, "minecraft:emerald_block"],
    [10, 200, 11, "minecraft:emerald_block"],
    [11, 201, 11, "minecraft:emerald_block"],
    [11, 200, 11, "minecraft:emerald_block"],
    [12, 200, 12, "minecraft:stone"],
  ], 2000));
  const r = await store.seenAt({ box: [[0, 190, 0], [20, 210, 20]], dim: DIM });
  const emerald = r.by_id.find((e) => e.id === "minecraft:emerald_block");
  assert.equal(emerald.count, 6, "the exact cluster size — what prose narration kept losing");
  assert.deepEqual(emerald.bbox, [[10, 200, 10], [11, 201, 11]]);
  assert.equal(r.by_id.find((e) => e.id === "minecraft:stone").count, 1);
});

test("surface reads confirm only cells that are still the top of their column", async () => {
  const { store } = await makeStore();
  const surfaceRead = (cells, tick) => ({
    tool: "get_surface",
    tick,
    dim: DIM,
    session: SESSION,
    confirms: true,
    area: { surface: { origin: [0, 0], grid: 4 }, complete: true },
    cellValues: cells,
  });
  await store.record(surfaceRead([[1, 64, 1, "minecraft:grass_block"]], 1000));
  // Terrain rises: the column's top moves to y=70. The old top must not gain freshness from
  // later surface sweeps — it is no longer what a heightmap read looks at.
  await store.record(surfaceRead([[1, 70, 1, "minecraft:gold_block"]], 2000));
  await store.record(surfaceRead([], 6000)); // unchanged re-survey of the same square
  const oldTop = await store.seenAt({ pos: [1, 64, 1], dim: DIM });
  assert.equal(oldTop.cell.last_confirmed_tick, 1000, "stale non-top cell must not be refreshed");
  const newTop = await store.seenAt({ pos: [1, 70, 1], dim: DIM });
  assert.equal(newTop.cell.last_confirmed_tick, 6000, "current top is refreshed by the re-survey");
});

test("aggregate sweeps never confirm cells but return as context and answer lastSeen", async () => {
  const { store } = await makeStore();
  await store.record(pointRead([[3, 60, 3, "minecraft:chest"]], 1000));
  // A describe_box SUMMARY over the area — aggregate only, must not extend cell freshness.
  await store.record({
    tool: "describe_box",
    tick: 5000,
    dim: DIM,
    session: SESSION,
    confirms: false,
    area: { box: [[0, 58, 0], [8, 62, 8]], complete: true },
    value: {
      volume: 405, air: 399, unloaded_columns: 0,
      materials: [{ block: "minecraft:chest", count: 1, bbox: "3,60,3 .. 3,60,3" }],
    },
  });
  const seen = await store.seenAt({ pos: [3, 60, 3], dim: DIM });
  assert.equal(seen.cell.last_confirmed_tick, 1000, "a summary cannot vouch per-cell");
  assert.equal(seen.sweeps.length, 1);
  assert.equal(seen.sweeps[0].tool, "describe_box");
  assert.equal(seen.sweeps[0].tick, 5000);
  const last = await store.lastSeen({ what: "chest" });
  assert.equal(last.found, true);
  assert.equal(last.clusters[0].count, 1);
  const sighting = last.sightings.find((s) => s.source === "describe_box");
  assert.equal(sighting.count, 1);
});

test("lastSeen matches locate result sets and clusters cells per dimension", async () => {
  const { store } = await makeStore();
  await store.record({
    tool: "locate",
    tick: 3000,
    dim: DIM,
    session: SESSION,
    confirms: false,
    area: { near: { center: [0, 0], radius: 64 }, complete: false },
    value: {
      what: "minecraft:chest",
      found: [
        { kind: "block", id: "minecraft:chest", pos: [5, 64, 9] },
        { kind: "block", id: "minecraft:trapped_chest", pos: [-3, null, 12] },
      ],
      search: { mechanism: "poi_index", found: 2, negative_is_proof: false },
    },
  });
  await store.record({ ...pointRead([[100, 40, 100, "minecraft:chest[facing=east]"]], 4000), dim: "minecraft:the_nether" });
  const r = await store.lastSeen({ what: "chest" });
  assert.equal(r.found, true);
  assert.equal(r.sightings.filter((s) => s.source === "locate").length, 2, "both chest variants match");
  assert.equal(r.clusters.length, 1);
  assert.equal(r.clusters[0].dim, "minecraft:the_nether");
  // Dimension filter never merges dimensions.
  const overworldOnly = await store.lastSeen({ what: "chest", dim: DIM });
  assert.equal(overworldOnly.clusters.length, 0);
  assert.equal(overworldOnly.sightings.length, 2);
  // An id nothing ever recorded is absent-from-memory, stated as such.
  const nothing = await store.lastSeen({ what: "beacon" });
  assert.equal(nothing.found, false);
});

test("two stores over one dir merge each other's appends before computing deltas", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcobs-"));
  const a = await new ObservationStore(root, WORLD).open();
  const b = await new ObservationStore(root, WORLD).open();
  await a.record(pointRead([[1, 1, 1, "minecraft:stone"]], 1000));
  // b never saw a's write; a same-value record must still be a no-op delta after resync.
  const counts = await b.record(pointRead([[1, 1, 1, "minecraft:stone"]], 2000));
  assert.deepEqual(counts, { cells_new: 0, cells_changed: 0, cells_unchanged: 1 });
  const seenByB = await b.seenAt({ pos: [1, 1, 1], dim: DIM });
  assert.equal(seenByB.cell.tick, 1000, "b adopted a's earlier record");
  assert.equal(seenByB.cell.last_confirmed_tick, 2000);
  const seenByA = await a.seenAt({ pos: [1, 1, 1], dim: DIM });
  assert.equal(seenByA.cell.last_confirmed_tick, 2000, "a sees b's confirmation on refresh");
});

test("a torn tail line is skipped, not fatal, and the next append starts a fresh line", async () => {
  const { root, store } = await makeStore();
  await store.record(pointRead([[1, 1, 1, "minecraft:stone"]], 1000));
  await appendFile(join(root, WORLD, OBS_FILE), '{"v":1,"tool":"get_blo', "utf8"); // crashed writer
  const reopened = await new ObservationStore(root, WORLD).open();
  const seen = await reopened.seenAt({ pos: [1, 1, 1], dim: DIM });
  assert.equal(seen.cell.val, "minecraft:stone");
  await reopened.record(pointRead([[2, 2, 2, "minecraft:dirt"]], 2000));
  const again = await new ObservationStore(root, WORLD).open();
  assert.equal((await again.seenAt({ pos: [2, 2, 2], dim: DIM })).cell.val, "minecraft:dirt");
  assert.equal((await again.stats()).records, 2, "torn line stays skipped; both real records load");
});

test("record rejects malformed observations instead of persisting them", async () => {
  const { root, store } = await makeStore();
  await assert.rejects(
    () => store.record({ tool: "get_blocks_at", dim: DIM, session: SESSION, area: { cells: [], complete: true } }),
    /tick/);
  assert.equal((await fileLines(root)).length, 0, "nothing persisted");
});
