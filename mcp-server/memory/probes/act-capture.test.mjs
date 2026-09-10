// Act-capture probes — W2_POSTMORTEM_FIXES.md §6: the body's own verified mines/places ride into
// the seen store under the reserved legal provenance "act", so `locate` stops advertising blocks
// the body itself already chopped (the stale-logs loop of session w2-79881). Offline against
// fixture payloads copied from the mod's real verdict shapes (DroneHands/GoalRunner ledger,
// verified 2026-08-04). Also the bot_scan horizons unit — the underground voice.

import { test } from "node:test";
import assert from "node:assert";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// MEMORY_ROOT binds at import time — the env must be set before capture.mjs loads.
const root = await mkdtemp(join(tmpdir(), "mcobs-act-"));
process.env.MCPTK_MEMORY_DIR = root;
process.env.MCPTK_EMBED_BACKEND ??= "none";
const { captureActOutcome, captureWorldRead, storeFor } = await import("../capture.mjs");
const { accumulateHorizons, botScan } = await import("../scan.mjs");

const DIM = "minecraft:overworld";
const WORLD_UUID = "act-test-world";

async function fakeBridge(tool) {
  if (tool === "get_world_info") {
    return { ok: true, result: { world_uuid: WORLD_UUID, name: "act-test", game_tick: 9000 } };
  }
  return { ok: false, error: `unexpected bridge call ${tool}` };
}

const envelope = (tick) => ({ game_tick: tick, dimension: DIM });

function legalValueAt(cells, x, y, z) {
  const c = cells.find((e) => e.pos[0] === x && e.pos[1] === y && e.pos[2] === z);
  return c ? { val: c.val, tool: c.tool } : null;
}

test("a mined block becomes air in the legal view — locate stops advertising chopped logs", async () => {
  // The body SAW a log (a fan hit), then MINED it. Before act capture, only a second look could
  // update the store, so the log kept answering locate searches after it was in the inventory.
  const fanHit = {
    ...envelope(1000), range: 32,
    rays: [[0, 0, "b", "minecraft:dark_oak_log", 3.2, -305, 71, -10]],
    hits: { "minecraft:dark_oak_log": 1 },
  };
  const cap = await captureWorldRead("raycast_fan", {}, fanHit, fakeBridge);
  assert.equal(cap.captured, true);
  const store = await storeFor(WORLD_UUID);
  let cells = await store.legalCells({ dim: DIM });
  assert.deepEqual(legalValueAt(cells, -305, 71, -10),
    { val: "minecraft:dark_oak_log", tool: "raycast_fan" });

  const mine = await captureActOutcome({
    ...envelope(1100), action_id: "m-4", action: "bot_mine",
    mined: "minecraft:dark_oak_log", pos: { x: -305, y: 71, z: -10 },
    collected: 1, drops: [{ item: "minecraft:dark_oak_log", count: 1, collected: 1 }],
  }, fakeBridge);
  assert.equal(mine.captured, true);
  cells = await store.legalCells({ dim: DIM });
  assert.deepEqual(legalValueAt(cells, -305, 71, -10), { val: "minecraft:air", tool: "act" });
});

test("a placed block becomes that block; a goal ledger updates every row it lists", async () => {
  const place = await captureActOutcome({
    ...envelope(1200), action: "bot_place",
    placed: "minecraft:cobblestone", pos: { x: -267, y: -9, z: 3 },
  }, fakeBridge);
  assert.equal(place.captured, true);

  const ledger = await captureActOutcome({
    ...envelope(1300), action_id: "g-12", action: "bot_target",
    ledger: {
      steps_completed: 1,
      mined: [{ x: -303, y: 65, z: -8, block: "minecraft:stone" },
              { x: -303, y: 66, z: -9, block: "minecraft:grass_block" }],
      // "held" is not an item id — a legacy row that must not index as the block "held".
      placed: [{ x: -262, y: -11, z: 6, item: "minecraft:cobblestone" },
               { x: -262, y: -11, z: 7, item: "held" }],
    },
  }, fakeBridge);
  assert.equal(ledger.captured, true);

  const store = await storeFor(WORLD_UUID);
  const cells = await store.legalCells({ dim: DIM });
  assert.deepEqual(legalValueAt(cells, -267, -9, 3), { val: "minecraft:cobblestone", tool: "act" });
  assert.deepEqual(legalValueAt(cells, -303, 65, -8), { val: "minecraft:air", tool: "act" });
  assert.deepEqual(legalValueAt(cells, -303, 66, -9), { val: "minecraft:air", tool: "act" });
  assert.deepEqual(legalValueAt(cells, -262, -11, 6), { val: "minecraft:cobblestone", tool: "act" });
  assert.equal(legalValueAt(cells, -262, -11, 7), null, "a 'held' placement has no known id — not indexed");
});

test("an envelope-less payload is refused, never guessed", async () => {
  const r = await captureActOutcome({ action: "bot_mine", mined: "minecraft:stone",
    pos: { x: 0, y: 0, z: 0 } }, fakeBridge);
  assert.equal(r.captured, false);
  assert.equal(r.reason, "no envelope");
});

test("a payload with nothing acted on captures nothing", async () => {
  const r = await captureActOutcome({ ...envelope(1400), action: "bot_goto", arrived: true }, fakeBridge);
  assert.deepEqual(r, { captured: false, reason: "no acts" });
});

// --- bot_scan horizons: the underground voice ------------------------------------------------------

test("horizons: block hits bound a sector; a miss opens it to the fan's whole range", () => {
  const horizons = {};
  // Looking north (yaw 180): a wall 2.1 blocks ahead, one ray missing entirely (open corridor).
  accumulateHorizons(horizons, {
    range: 32,
    rays: [
      [-10, 0, "b", "minecraft:stone", 2.1, 0, 64, -2],
      [0, 0, "m"],
      [10, 0, "b", "minecraft:stone", 1.8, 1, 64, -2],
    ],
  }, 180);
  assert.equal(horizons.N, 32, "the miss is the longest open sightline north");

  // A sealed tunnel: every ray dies within 3 blocks in every direction it was pointed.
  const sealed = {};
  for (const yaw of [0, 90, 180, 270]) {
    accumulateHorizons(sealed, {
      range: 32,
      rays: [[0, 0, "b", "minecraft:deepslate", 1.4, 0, 0, 0]],
    }, yaw);
  }
  assert.ok(Object.values(sealed).every((d) => d <= 3), "sealed in rock reads as short horizons everywhere");
});

test("horizons: entity hits and unread rays count as open-at-least-that-far", () => {
  const horizons = {};
  accumulateHorizons(horizons, {
    range: 32,
    rays: [
      [0, 0, "e", "minecraft:creeper", 14.5, -278, -6, -2], // seen THROUGH 14.5 blocks of open space
      [45, 0, "u", 6.0], // unread past 6 — open at least that far, never more claimed
    ],
  }, 90); // looking west; +45 lands in NW
  assert.equal(horizons.W, 14.5);
  assert.equal(horizons.NW, 6.0);
});

// --- bot_scan end-to-end offline: the visible-materials tally reaches the reply --------------------

/** A bridge whose fan always sees `rays` — enough of the world for a whole botScan round trip. */
function scanBridge(rays) {
  let tick = 5000;
  return async (tool) => {
    if (tool === "get_world_info") {
      return { ok: true, result: { world_uuid: WORLD_UUID, name: "act-test", game_tick: ++tick } };
    }
    if (tool === "bot_status") {
      return { ok: true, result: { spawned: true, pos: { x: 5000.5, y: 64, z: 5000.5 },
        dimension: DIM, yaw: 0, sees_sky: false } };
    }
    if (tool === "bot_look") return { ok: true, result: {} };
    if (tool === "raycast_fan") return { ok: true, result: { ...envelope(++tick), range: 32, rays } };
    return { ok: false, error: `unexpected bridge call ${tool}` };
  };
}

test("bot_scan reports what the sightlines hit — distinct blocks, deduped across the sweep's fans", async () => {
  // Every fan in the 360° sweep sees the SAME three blocks — the tally must not quadruple them.
  const r = await botScan({}, scanBridge([
    [0, 0, "b", "minecraft:stone", 1.2, 5001, 64, 5000],
    [15, 0, "b", "minecraft:stone", 1.1, 5000, 64, 5001],
    [-15, 5, "b", "minecraft:oak_log", 2.0, 5002, 65, 5000],
    [30, 0, "m"],
  ]));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.result.visible, { "minecraft:stone": 2, "minecraft:oak_log": 1 },
    "distinct positions per id, most-seen first");
  assert.equal(r.result.visible_other_kinds, undefined, "nothing was truncated, so no count");
  assert.match(r.result.render, /your sightlines hit: stone ×2, oak_log ×1/,
    "the render names materials with the namespace stripped, most-seen first");
});

test("bot_scan caps the tally at 6 kinds and SAYS how many more it saw", async () => {
  const ids = ["stone", "dirt", "gravel", "andesite", "granite", "diorite", "tuff", "clay"];
  const r = await botScan({}, scanBridge(
    ids.map((id, i) => [i, 0, "b", `minecraft:${id}`, 2.0, 5100 + i, 64, 5100]),
  ));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(Object.keys(r.result.visible).length, 6);
  assert.equal(r.result.visible_other_kinds, 2, "truncation is stated, never silent");
  assert.match(r.result.render, /\(\+2 more kinds\)/);
});

test("bot_scan with nothing in sight stays silent — no visible field, no empty tally line", async () => {
  const r = await botScan({}, scanBridge([[0, 0, "m"], [15, 0, "m"]]));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.result.visible, undefined);
  assert.ok(!/sightlines hit/.test(r.result.render), "no news costs no bytes");
});
