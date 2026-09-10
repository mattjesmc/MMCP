// Live regression probes for the 2026-07-22 deep-review fixes:
//
//   1. get_events flags an impossible-future cursor (persisted across a JVM restart) as
//      cursor_reset instead of reporting a permanently quiet stream — and a long-poll with such a
//      cursor returns immediately rather than parking until timeout.
//   2. raycast / raycast_fan clamp at unreadable chunks: a ray into virgin terrain reports
//      hit=unread with range_covered (never "miss", never generated terrain, never a multi-second
//      stall), while rays over readable terrain still hit what is there.
//   3. Write tools take `dimension`: set_blocks in the nether round-trips with get_blocks_at
//      {dimension}, stamps the dimension into the edit envelope, and undo restores in the SAME
//      dimension.
//   4. undo_edit restores block-entity NBT through overlapping edits (chest contents come back),
//      and an over-cap place_shape says so via undo_reason instead of a bare null undo_id.
//
// Live probe: needs the dev server up (`gradlew runServer`). Skips itself when the bridge is down.
// Run with `npm run test:live`.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const Y = 200;
// Far from spawn, from each other, and from perception-coverage.test.mjs's coordinates.
// Moved from 2,000,000 (2026-07-22): a region-summary staging accident generated chunks there —
// virgin sites are one-way doors, each probe file must own a unique never-touched coordinate.
const VIRGIN = { x: 2_200_000, z: 2_200_000 };  // never generated, never touched
const NETHER = { x: 5000, z: 5000 };            // nether write target
const CHEST = { x: 2_100_000, z: 2_100_000 };   // overlap-undo scenario (forceloaded)

async function call(tool, args = {}) {
  const res = await fetch(`${BASE}/cmd`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool, args }),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(`${tool} failed: ${JSON.stringify(j.error)}`);
  return j.result;
}
const cmd = (c) => call("run_command", { command: c });

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok)
  .catch(() => false);
if (!bridgeUp) {
  console.log(`\n  [skip] no bridge at ${BASE} — start the dev server to run these probes\n`);
}

describe("review fixes: cursor reset, ray clamping, write dimensions, undo fidelity", { skip: !bridgeUp }, () => {
  test("get_events: an impossible-future cursor is flagged cursor_reset, and re-polling from 0 heals", async (t) => {
    if (!bridgeUp) return t.skip();
    const stale = await call("get_events", { cursor: 1_000_000_000, limit: 10 });
    assert.equal(stale.cursor_reset, true, JSON.stringify(stale));
    assert.equal(stale.returned, 0);
    assert.match(stale.note, /previous game launch/i);

    // The healing path the memory layer takes: re-poll from 0 and events flow again.
    await cmd("say cursor-reset-probe"); // guarantees at least one event exists
    const healed = await call("get_events", { cursor: 0, limit: 200 });
    assert.equal(healed.cursor_reset, undefined);
    assert.ok(healed.returned > 0, "cursor 0 must see this launch's events");

    // A long-poll with a stale cursor must return at once, not park until wait_ms.
    const t0 = performance.now();
    const waited = await call("get_events", { cursor: 1_000_000_000, wait_ms: 8000 });
    const elapsed = performance.now() - t0;
    assert.equal(waited.cursor_reset, true);
    assert.ok(elapsed < 4000, `stale-cursor long-poll should return immediately, took ${elapsed.toFixed(0)}ms`);
  });

  test("raycast into virgin terrain: unread (not miss), fast, and generates nothing", async (t) => {
    if (!bridgeUp) return t.skip();
    const origin = { x: VIRGIN.x, y: Y, z: VIRGIN.z };

    const t0 = performance.now();
    const r = await call("raycast", { origin, yaw: 0, pitch: 0, range: 256 });
    const elapsed = performance.now() - t0;

    assert.equal(r.hit, "unread", JSON.stringify(r));
    assert.equal(r.truncated, true);
    assert.ok(r.range_covered < 256, `covered ${r.range_covered} should fall short of range`);
    assert.match(r.note, /unread, not empty/i);
    // The old path generated ~900ms/chunk across up to 17 chunks; refusing must be fast.
    assert.ok(elapsed < 1500, `virgin raycast should refuse quickly, took ${elapsed.toFixed(0)}ms`);

    // And it must not have created terrain: the same area still reads as never-generated.
    const gb = await call("get_surface", { origin, grid: 1 });
    assert.equal(gb.coverage.state, "none", "the raycast must not have generated chunks");
    assert.ok(gb.coverage.chunks.ungenerated > 0, JSON.stringify(gb.coverage));
  });

  test("raycast_fan into virgin terrain: 'u' rows with covered distance, histogram says unread", async (t) => {
    if (!bridgeUp) return t.skip();
    const origin = { x: VIRGIN.x + 320, y: Y, z: VIRGIN.z };
    const r = await call("raycast_fan", { origin, yaw: 0, pitch: 0, h_fov: 90, steps_h: 5, range: 128 });
    assert.ok((r.hits.unread ?? 0) > 0, `expected unread rays: ${JSON.stringify(r.hits)}`);
    const uRow = r.rays.find((row) => row[2] === "u");
    assert.ok(uRow, `expected a 'u' row: ${JSON.stringify(r.rays)}`);
    assert.equal(typeof uRow[3], "number", "'u' rows carry the distance actually covered");
    assert.match(r.note, /unread, not empty/i);
  });

  test("raycast over readable terrain still hits what is there", async (t) => {
    if (!bridgeUp) return t.skip();
    const { x, z } = CHEST; // reuse the forceloaded band below? no — stage our own small one
    await cmd(`forceload add ${x - 16} ${z - 16} ${x + 16} ${z + 16}`);
    try {
      await call("set_blocks", { blocks: [{ x: x + 5, y: Y, z, block: "minecraft:gold_block" }] });
      const r = await call("raycast", {
        origin: { x, y: Y + 0.5, z: z + 0.5 }, direction: { x: 1, y: 0, z: 0 }, range: 32,
      });
      assert.equal(r.hit, "block", JSON.stringify(r));
      assert.equal(r.block.block, "minecraft:gold_block");
      await call("set_blocks", { blocks: [{ x: x + 5, y: Y, z, block: "minecraft:air" }] });
    } finally {
      await cmd(`forceload remove ${x - 16} ${z - 16} ${x + 16} ${z + 16}`);
    }
  });

  test("set_blocks takes `dimension`: nether write, nether readback, nether undo", async (t) => {
    if (!bridgeUp) return t.skip();
    const { x, z } = NETHER;
    const w = await call("set_blocks", {
      dimension: "minecraft:the_nether",
      blocks: [{ x, y: 100, z, block: "minecraft:gold_block" }],
    });
    assert.equal(w.placed, 1, JSON.stringify(w));
    assert.equal(w.dimension, "minecraft:the_nether", "the edit envelope must stamp the dimension written");
    assert.ok(w.undo_id, "a placed edit is undoable");

    const read = await call("get_blocks_at", {
      dimension: "minecraft:the_nether",
      blocks: [{ x, y: 100, z, expect: "minecraft:gold_block" }],
    });
    assert.equal(read.check.all_matched, true, "the write must land in the dimension asked for");

    // Undo must restore in the SAME dimension (the journal remembers the level, not coordinates).
    const u = await call("undo_edit", { undo_id: w.undo_id });
    assert.equal(u.restored, 1);
    const after = await call("get_blocks_at", {
      dimension: "minecraft:the_nether",
      blocks: [{ x, y: 100, z, expect: "minecraft:gold_block" }],
    });
    assert.equal(after.check.all_matched, false, "undo must have removed the nether block");
  });

  test("undo through overlapping edits restores chest contents, not just the shell", async (t) => {
    if (!bridgeUp) return t.skip();
    const { x, z } = CHEST;
    await cmd(`forceload add ${x - 16} ${z - 16} ${x + 16} ${z + 16}`);
    try {
      // Edit 1: a chest with items. Edit 2: stone over it (snapshots chest + NBT).
      // Edit 3: an EMPTY chest at the same cell — now edit 2's snapshot state equals the current
      // state, the exact overlap where a naive undo restores the shell and loses the items.
      await call("set_blocks", { blocks: [{ x, y: Y, z,
        block: "minecraft:chest[facing=north]{Items:[{Slot:0b,id:\"minecraft:diamond\",count:5}]}" }] });
      const overwrite = await call("set_blocks", { blocks: [{ x, y: Y, z, block: "minecraft:stone" }] });
      assert.ok(overwrite.undo_id);
      await call("set_blocks", { blocks: [{ x, y: Y, z, block: "minecraft:chest[facing=north]" }] });

      const u = await call("undo_edit", { undo_id: overwrite.undo_id });
      assert.equal(u.restored, 1);
      const back = await call("get_blocks_at", { blocks: [{ x, y: Y, z }], detail: "full" });
      assert.match(JSON.stringify(back.nbt), /diamond/,
        `undo must bring the chest's items back, got: ${JSON.stringify(back.nbt)}`);

      await call("set_blocks", { blocks: [{ x, y: Y, z, block: "minecraft:air" }] });
    } finally {
      await cmd(`forceload remove ${x - 16} ${z - 16} ${x + 16} ${z + 16}`);
    }
  });

  test("an over-cap edit says so: undo_id null + undo_reason, never a bare null", async (t) => {
    if (!bridgeUp) return t.skip();
    // 59^3 = 205,379 cells > UNDO_CAP (200,000), placed high above spawn (already-generated
    // chunks, pure air) so the write is cheap and the cleanup is another over-cap air fill.
    const box = { p1: { x: 0, y: 190, z: 0 }, p2: { x: 58, y: 248, z: 58 } };
    const r = await call("place_shape", { shape: "box", block: "minecraft:stone", mode: "solid", ...box });
    try {
      assert.equal(r.placed, 59 * 59 * 59, JSON.stringify({ placed: r.placed, truncated: r.truncated }));
      // Gson drops null members on the wire, so a null undo_id arrives as absent (dry runs always have).
      assert.equal(r.undo_id ?? null, null);
      assert.match(r.undo_reason, /over_cap/, "over-cap must be distinguishable from a dry run");
      assert.equal(r.dimension, "minecraft:overworld", "shape envelope stamps its dimension too");
    } finally {
      await call("place_shape", { shape: "box", block: "minecraft:air", mode: "solid", ...box });
    }
  });
});
