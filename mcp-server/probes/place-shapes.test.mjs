// Live probes for `place_shapes` — the batched shape op (toolkit 0.76.0,
// mcp-toolkit/docs/world/STRUCTURE_AUTHORING_DESIGN.md §4).
//
// The tool exists to collapse turns, not to add capability: a forty-fill room used to cost forty
// calls, and by TOKEN_PER_TOOL_FINDINGS.md finding 1 every one of those turns re-pays the whole
// static tool prefix. So the interesting assertions here are not "does it place blocks" — the
// engine underneath is the same `place_shape` engine — they are the five contract rules, each of
// which has a specific way of being wrong:
//
//   1. ORDER. Ops apply in array order and each sees what the ones before it left. A parallel or
//      reordered implementation turns "shell, then carve the inside out" into a solid block.
//   2. ONE UNDO. The batch files ONE edit under tool `place_shapes`; one undo_edit reverts all of
//      it. Per-op ids would make reverting a room an N-call chore.
//   3. THE BUDGET IS THE CALL'S. 500,000 blocks total, not per op — and when it runs out the
//      response names the op it ran out inside, marks that op `partial` and the rest `not_run`.
//      All-zero counters on an op that never ran are indistinguishable from an op that legitimately
//      changed nothing, which is why the markers exist.
//   4. DRY RUN MODELS OVERLAP. This is the trap the design doc flagged before implementation. A
//      dry run writes nothing, so without an overlay each op reads the untouched world: an air
//      carve into what an earlier op filled reads as "already air" and reports 0, and a second
//      solid op over the same cells reports them a second time. The test is therefore not a
//      hand-computed number — it is DRY == LIVE for the same batch, per op.
//   5. NO HALF-APPLY. Every op is parsed before anything is written, so one bad block id refuses
//      the whole call and the site is untouched. A batch that died mid-way would leave a structure
//      whose remaining ops were written against geometry that never appeared.
//
// Plus the argument tightenings that came with it: an op may not carry the per-call `dry_run` /
// `dimension`, and `line` no longer accepts-and-ignores a `mode`.
//
// Staged at a probe-owned coordinate (4.30M). Forceloaded during the run, released after.
// Live probe: needs the dev server up (`gradlew runServer`). Skips itself when the bridge is down.
// Run with `npm run test:live`, or sequentially via `tools/battery.ps1`.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const X = 4_300_000, Z = 4_300_000, Y = 200; // this probe file's own site (site-map.test.mjs)

// Own session identity: probe files run CONCURRENTLY, and `undo_edit` with no id defaults to the
// CALLER's latest edit — an anonymous probe would undo whatever another file just wrote.
const SESSION = "probe-place-shapes";
async function raw(tool, args = {}) {
  const res = await fetch(`${BASE}/cmd`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-MCPTK-Session": SESSION },
    body: JSON.stringify({ tool, args }),
  });
  return res.json();
}
async function call(tool, args = {}) {
  const j = await raw(tool, args);
  if (!j.ok) throw new Error(`${tool} failed: ${JSON.stringify(j.error)}`);
  return j.result;
}
/** The error text of a call that must be refused (throws if it succeeded instead). */
async function refused(tool, args) {
  const j = await raw(tool, args);
  assert.equal(j.ok, false, `${tool} should have been refused, got ${JSON.stringify(j.result)}`);
  return JSON.stringify(j.error);
}
const cmd = (c) => call("run_command", { command: c });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** True when every listed {x,y,z,expect} matches. */
async function blocksAre(blocks) {
  const r = await call("get_blocks_at", { blocks });
  return r.check.all_matched;
}

// Sub-sites, one per test, so a failure localises and no test cleans up under another. All on one
// horizontal plane at Y; the budget test is a dry run only and lives far below, at Y_BUDGET.
const ORDER = { x: X, z: Z };
const OVERLAP = { x: X + 20, z: Z };
const HALF = { x: X + 40, z: Z };
const UNDO = { x: X + 60, z: Z };
const Y_BUDGET = 100;

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok)
  .catch(() => false);
if (!bridgeUp) {
  console.log(`\n  [skip] no bridge at ${BASE} — start the dev server to run these probes\n`);
}

describe("place_shapes: order, one undo, a call-wide budget, and a dry run that models overlap",
  { skip: !bridgeUp }, () => {
  before(async () => {
    if (!bridgeUp) return;
    // The budget test dry-runs an 80x80 column, so the forceload has to cover X-40..X+79.
    await cmd(`forceload add ${X - 48} ${Z - 48} ${X + 88} ${Z + 48}`);
    await sleep(1500); // forceload marks async
    // A clean air pocket at the working plane, and again down at the budget plane, so counts are
    // about the ops rather than about whatever the terrain happened to be.
    await cmd(`fill ${X - 8} ${Y - 1} ${Z - 8} ${X + 79} ${Y + 20} ${Z + 20} minecraft:air`);
    await sleep(500);
  });

  after(async () => {
    if (!bridgeUp) return;
    await cmd(`fill ${X - 8} ${Y - 1} ${Z - 8} ${X + 79} ${Y + 20} ${Z + 20} minecraft:air`);
    await cmd(`forceload remove ${X - 48} ${Z - 48} ${X + 88} ${Z + 48}`);
  });

  // --- 1. order -------------------------------------------------------------------------------

  test("ops apply in ARRAY ORDER: shell then air carve leaves a hollow room", async (t) => {
    if (!bridgeUp) return t.skip();
    const { x, z } = ORDER;
    const r = await call("place_shapes", {
      ops: [
        { shape: "box", block: "minecraft:deepslate_bricks", mode: "solid",
          p1: { x, y: Y, z }, p2: { x: x + 6, y: Y + 6, z: z + 6 } },
        { shape: "box", block: "minecraft:air", mode: "solid",
          p1: { x: x + 1, y: Y + 1, z: z + 1 }, p2: { x: x + 5, y: Y + 5, z: z + 5 } },
      ],
    });
    assert.equal(r.ops_count, 2, JSON.stringify(r));
    assert.equal(r.ops.length, 2, JSON.stringify(r));
    // 7^3 laid, 5^3 carved back out — both ops did real work, which is the whole point: op 1 could
    // only place air over cells op 0 had just filled.
    assert.equal(r.ops[0].placed, 343, JSON.stringify(r.ops[0]));
    assert.equal(r.ops[1].placed, 125, JSON.stringify(r.ops[1]));
    assert.equal(r.placed, 468, JSON.stringify(r));
    // And the world agrees: shell present, middle hollow.
    assert.ok(await blocksAre([
      { x, y: Y, z, expect: "minecraft:deepslate_bricks" },
      { x: x + 3, y: Y + 3, z: z + 3, expect: "minecraft:air" },
      { x: x + 3, y: Y + 6, z: z + 3, expect: "minecraft:deepslate_bricks" },
    ]), "the shell must stand and the interior must be air");

    // The union region covers both ops, not just the last one.
    assert.deepEqual(r.region.min, { x, y: Y, z }, JSON.stringify(r.region));
    assert.deepEqual(r.region.max, { x: x + 6, y: Y + 6, z: z + 6 }, JSON.stringify(r.region));

    // --- 2. one undo for the whole batch ---
    assert.ok(r.undo_id, `a batch must be undoable as one edit: ${JSON.stringify(r)}`);
    const edits = await call("list_edits");
    const mine = edits.edits.find((e) => e.undo_id === r.undo_id);
    assert.ok(mine, `the batch must be listed: ${JSON.stringify(edits)}`);
    assert.equal(mine.tool, "place_shapes", JSON.stringify(mine));
    // 468 confirmed writes, one journal entry — not 2, and not 343.
    assert.equal(mine.changed, 468, JSON.stringify(mine));

    const undone = await call("undo_edit", { undo_id: r.undo_id });
    assert.equal(undone.restored, 468, JSON.stringify(undone));
    assert.ok(await blocksAre([
      { x, y: Y, z, expect: "minecraft:air" },
      { x: x + 3, y: Y + 6, z: z + 3, expect: "minecraft:air" },
    ]), "one undo_edit must revert the whole batch, both ops");
  });

  test("REVERSED, the same two ops leave a solid block — order is the contract, not a detail",
    async (t) => {
      if (!bridgeUp) return t.skip();
      const { x, z } = ORDER;
      const r = await call("place_shapes", {
        ops: [
          { shape: "box", block: "minecraft:air", mode: "solid",
            p1: { x: x + 1, y: Y + 1, z: z + 1 }, p2: { x: x + 5, y: Y + 5, z: z + 5 } },
          { shape: "box", block: "minecraft:deepslate_bricks", mode: "solid",
            p1: { x, y: Y, z }, p2: { x: x + 6, y: Y + 6, z: z + 6 } },
        ],
      });
      // The carve ran first over air and changed nothing; the shell then filled everything.
      assert.equal(r.ops[0].placed, 0, JSON.stringify(r.ops[0]));
      assert.equal(r.ops[0].unchanged, 125, JSON.stringify(r.ops[0]));
      assert.equal(r.ops[1].placed, 343, JSON.stringify(r.ops[1]));
      assert.ok(await blocksAre([{ x: x + 3, y: Y + 3, z: z + 3, expect: "minecraft:deepslate_bricks" }]),
        "reversed, the interior must be SOLID — which is what an order-blind implementation would build");
      await call("undo_edit", { undo_id: r.undo_id });
    });

  // --- 4. the dry run models overlap ----------------------------------------------------------

  test("dry_run simulates the ops AGAINST EACH OTHER: every count equals the live run's", async (t) => {
    if (!bridgeUp) return t.skip();
    const { x, z } = OVERLAP;
    // Three ops chosen so a no-overlay dry run is wrong in BOTH directions:
    //   op1 overlaps op0 with the SAME block  -> unoverlaid it double-counts those cells as placed
    //   op2 carves air inside op0's fill      -> unoverlaid it reads "already air" and reports 0
    const ops = [
      { shape: "box", block: "minecraft:stone", mode: "solid",
        p1: { x, y: Y, z }, p2: { x: x + 5, y: Y + 5, z: z + 5 } },
      { shape: "box", block: "minecraft:stone", mode: "solid",
        p1: { x: x + 3, y: Y, z }, p2: { x: x + 8, y: Y + 5, z: z + 5 } },
      { shape: "box", block: "minecraft:air", mode: "solid",
        p1: { x: x + 1, y: Y + 1, z: z + 1 }, p2: { x: x + 4, y: Y + 4, z: z + 4 } },
    ];

    const dry = await call("place_shapes", { ops, dry_run: true });
    assert.equal(dry.dryRun, true, JSON.stringify(dry));
    assert.equal(dry.undo_id, null, "a dry run must not file an edit");
    assert.ok(dry.dry_run_note, "a preview must say what it does and does not model");
    // Nothing was written.
    assert.ok(await blocksAre([{ x, y: Y, z, expect: "minecraft:air" }]),
      "dry_run must change nothing");

    const live = await call("place_shapes", { ops });

    // THE ASSERTION. Not a hand-computed number — the preview's job is to predict the live run.
    assert.equal(dry.placed, live.placed,
      `dry_run must predict the live placed count: ${dry.placed} vs ${live.placed}`);
    assert.deepEqual(
      dry.ops.map((o) => [o.op, o.placed, o.unchanged ?? 0, o.skipped ?? 0]),
      live.ops.map((o) => [o.op, o.placed, o.unchanged ?? 0, o.skipped ?? 0]),
      `per-op counts must match:\ndry  ${JSON.stringify(dry.ops)}\nlive ${JSON.stringify(live.ops)}`);
    assert.deepEqual(dry.region, live.region, "and so must the predicted region");

    // The two directions the overlay fixes, pinned so a regression to world-reads is legible and
    // not just an equality that broke somewhere:
    //   op1's 3x6x6=108 cells overlapping op0 are already stone -> unchanged, NOT placed again.
    assert.equal(live.ops[1].unchanged, 108, JSON.stringify(live.ops[1]));
    assert.equal(live.ops[1].placed, 108, JSON.stringify(live.ops[1]));
    //   op2 carves 4^3=64 cells of stone op0 laid -> all 64 are real changes.
    assert.equal(live.ops[2].placed, 64, JSON.stringify(live.ops[2]));

    await call("undo_edit", { undo_id: live.undo_id });
    assert.ok(await blocksAre([{ x, y: Y, z, expect: "minecraft:air" }]), "undo must clean the site");
  });

  // --- 3. the budget belongs to the call ------------------------------------------------------

  test("MAX_BLOCKS is a budget over the CALL: it truncates INSIDE an op and names which", async (t) => {
    if (!bridgeUp) return t.skip();
    // Dry run on purpose: the assertion is about the shared counter, and writing half a million
    // blocks to prove it would risk the dispatch timeout and file a 500k-cell undo record.
    // Two disjoint 80x80x40 = 256,000-cell boxes: the first fits, the second runs out at 244,000.
    const col = (y0) => ({
      shape: "box", block: "minecraft:glass", mode: "solid",
      p1: { x: X - 40, y: y0, z: Z - 40 }, p2: { x: X + 39, y: y0 + 39, z: Z + 39 },
    });
    const r = await call("place_shapes", {
      dry_run: true,
      ops: [col(Y_BUDGET), col(Y_BUDGET + 40), col(Y_BUDGET + 80)],
    });
    assert.equal(r.truncated, true, JSON.stringify({ ...r, ops: r.ops }));
    assert.equal(r.placed, 500_000, "the ceiling is the CALL's, so the total stops exactly there");
    assert.equal(r.truncated_at_op, 1, JSON.stringify(r.ops));
    assert.equal(r.ops[0].placed, 256_000, JSON.stringify(r.ops[0]));
    assert.equal(r.ops[1].placed, 244_000, JSON.stringify(r.ops[1]));
    assert.equal(r.ops[1].partial, true, "the op the budget ran out inside must say so");
    // The distinction the markers exist for: op 2's all-zero counters mean "never ran", not
    // "changed nothing".
    assert.equal(r.ops[2].placed, 0, JSON.stringify(r.ops[2]));
    assert.equal(r.ops[2].not_run, true, JSON.stringify(r.ops[2]));
    assert.equal(r.ops[1].not_run, undefined, "the partial op DID run — it must not be marked not_run");
  });

  // --- 5. no half-apply ------------------------------------------------------------------------

  test("one malformed op refuses the WHOLE call, having written nothing", async (t) => {
    if (!bridgeUp) return t.skip();
    const { x, z } = HALF;
    const err = await refused("place_shapes", {
      ops: [
        { shape: "box", block: "minecraft:stone", mode: "solid",
          p1: { x, y: Y, z }, p2: { x: x + 3, y: Y + 3, z: z + 3 } },
        { shape: "box", block: "minecraft:not_a_real_block", mode: "solid",
          p1: { x, y: Y, z }, p2: { x: x + 3, y: Y + 3, z: z + 3 } },
      ],
    });
    assert.match(err, /ops\[1\]/, `the error must name the offending op: ${err}`);
    assert.match(err, /nothing was placed/, `and say the batch did not half-apply: ${err}`);
    // The valid op 0 must NOT have run.
    assert.ok(await blocksAre([{ x, y: Y, z, expect: "minecraft:air" }]),
      "a refused batch must leave the site untouched");
  });

  test("a geometry error is caught at parse time too, and names its op", async (t) => {
    if (!bridgeUp) return t.skip();
    const { x, z } = HALF;
    const err = await refused("place_shapes", {
      ops: [
        { shape: "box", block: "minecraft:stone", p1: { x, y: Y, z }, p2: { x, y: Y, z } },
        { shape: "cylinder", block: "minecraft:stone", center: { x, y: Y, z }, radius: 2 }, // no height
      ],
    });
    assert.match(err, /ops\[1\]/, err);
    assert.match(err, /height/, err);
    assert.ok(await blocksAre([{ x, y: Y, z, expect: "minecraft:air" }]),
      "nothing may be written when a later op fails to parse");
  });

  // --- argument hygiene ------------------------------------------------------------------------

  test("an op may not carry the per-call dry_run or dimension", async (t) => {
    if (!bridgeUp) return t.skip();
    const { x, z } = HALF;
    const base = { shape: "box", block: "minecraft:stone", p1: { x, y: Y, z }, p2: { x, y: Y, z } };
    for (const key of ["dry_run", "dimension"]) {
      const err = await refused("place_shapes", { ops: [{ ...base, [key]: key === "dry_run" ? true : "minecraft:overworld" }] });
      assert.match(err, new RegExp(`per-CALL`), `${key}: ${err}`);
    }
    // Refusing it is the point: a per-op dimension silently dropped is a write in the wrong world.
    assert.ok(await blocksAre([{ x, y: Y, z, expect: "minecraft:air" }]), "nothing written");
  });

  test("an empty or oversized ops array is refused, never quietly a no-op", async (t) => {
    if (!bridgeUp) return t.skip();
    assert.match(await refused("place_shapes", { ops: [] }), /empty/);
    assert.match(await refused("place_shapes", {}), /ops/);
    const one = { shape: "box", block: "minecraft:stone",
      p1: { x: X + 79, y: Y, z: Z }, p2: { x: X + 79, y: Y, z: Z } };
    assert.match(await refused("place_shapes", { ops: Array(257).fill(one) }), /too many ops/);
  });

  test("`line` refuses a mode instead of accepting and ignoring it", async (t) => {
    if (!bridgeUp) return t.skip();
    const { x, z } = HALF;
    const err = await refused("place_shape", {
      shape: "line", block: "minecraft:stone", mode: "hollow",
      p1: { x, y: Y, z }, p2: { x: x + 4, y: Y, z },
    });
    assert.match(err, /thickness/, `the refusal must point at the right knob: ${err}`);
  });

  // --- the singular tool is not replaced -------------------------------------------------------

  test("place_shape still takes one shape, and its dry run now agrees with its live run", async (t) => {
    if (!bridgeUp) return t.skip();
    const { x, z } = UNDO;
    // A THICK DIAGONAL LINE revisits its own cells, so this is the self-overlap case: the live run
    // buckets the repeats as `unchanged`, and before the overlay the preview counted them placed.
    const args = { shape: "line", block: "minecraft:copper_block", thickness: 3,
      p1: { x, y: Y + 1, z }, p2: { x: x + 8, y: Y + 5, z: z + 8 } };
    const dry = await call("place_shape", { ...args, dry_run: true });
    const live = await call("place_shape", args);
    assert.equal(dry.placed, live.placed,
      `a self-overlapping shape's preview must match its live count: ${dry.placed} vs ${live.placed}`);
    assert.ok(live.unchanged > 0, `the thick line must revisit cells: ${JSON.stringify(live)}`);
    assert.ok(live.undo_id, JSON.stringify(live));
    await call("undo_edit", { undo_id: live.undo_id });
  });
});
