// Perception honesty: a read that saw nothing must never look like a read that found nothing.
//
// Reads now pull absent chunks in on demand, so the common remote read simply works. What this file
// guards is the seam around that: what happens when loading is off or its budget is spent.
//
// Before either change, the failure was silent and expensive. get_surface over an unloaded area
// returned an empty palette AND covered_radius == grid — "I surveyed radius 16 and found nothing"
// about an area it never read — while scene_summary narrated a confident sentence built from
// generator defaults. The 2026-07-19 ablation transcripts show agents correctly distrusting that
// output and falling back to 662 `data get block` / `execute if block` commands, none of which can
// report a block id either, so none of them ever got an answer.
//
// Invariants under test:
//   1. absent chunks load    → a remote read with no staging comes back complete, and bills what
//                              it pulled in under coverage.chunks.
//   2. nothing readable      → coverage.state "none", covered_radius -1, and a note forbidding the
//                              absence inference (reachable via load:false).
//   3. everything readable   → coverage.state "complete", covered_radius == grid, no note.
//   4. partly readable       → coverage.state "partial", covered_radius stops at the last ring with
//                              no holes, and re-reading within covered_radius is complete.
//   5. accounting is closed  → read + unloaded + unvisited == requested, always.
//   6. the sentence leads with the caveat, because that is the line an agent reads first.
//
// Live probe: needs the dev server up (`gradlew runServer`). Skips itself when the bridge is down,
// so it never fails a checkout that simply has no game running. Run with `npm run test:live`.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const Y = 200;
// Far from spawn and from each other, so neither block sits in the other's loaded region.
const COLD = { x: 700000, z: 700000 }; // never loaded
const HOT = { x: 800000, z: 800000 };  // force-loaded by the test
const AUTO = { x: 900000, z: 900000 }; // left to on-demand loading, never staged
const POINT = { x: 1000000, z: 1000000 }; // exact-coordinate reads

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

// Probed at module load, not in before(): describe()'s skip option is evaluated when the suite is
// defined, so a hook-assigned flag would still be false and the whole suite would skip silently.
const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok)
  .catch(() => false);
if (!bridgeUp) {
  console.log(`\n  [skip] no bridge at ${BASE} — start the dev server to run these probes\n`);
}

/** read + unloaded + unvisited must equal requested, in every shape, always. */
function assertClosedAccounting(cov, where) {
  assert.equal(
    cov.read + cov.unloaded + cov.unvisited, cov.requested,
    `${where}: coverage accounting does not close: ${JSON.stringify(cov)}`);
}

describe("perception coverage contract", { skip: !bridgeUp }, () => {
  test("existing chunks page in automatically; a remote read of built terrain just works", async (t) => {
    if (!bridgeUp) return t.skip();
    // Nobody is near this coordinate: before on-demand paging this was the 662-command failure
    // case. Stage it once the deliberate way (forceload is privileged and audited), let it fall
    // out of residency, then read it cold with no staging at all.
    const origin = { x: AUTO.x, y: Y, z: AUTO.z };
    // Stage a rectangle wide enough to cover every chunk the grid-1 read touches — the 3x3 column
    // span straddles a chunk boundary, so forceloading the single centre chunk would leave the
    // corners virgin and the read legitimately partial.
    await cmd(`forceload add ${AUTO.x - 24} ${AUTO.z - 24} ${AUTO.x + 24} ${AUTO.z + 24}`);
    await call("set_blocks", { blocks: [{ x: AUTO.x, y: Y, z: AUTO.z, block: "minecraft:gold_block" }] });
    await cmd("save-all flush");
    await cmd(`forceload remove ${AUTO.x - 24} ${AUTO.z - 24} ${AUTO.x + 24} ${AUTO.z + 24}`);

    const gb = await call("get_surface", { origin, grid: 1 });
    assert.equal(gb.coverage.state, "complete", `generated terrain should page in: ${JSON.stringify(gb.coverage)}`);
    assert.equal(gb.columns, 9);
    assertClosedAccounting(gb.coverage, "get_surface/auto");
    // Whatever it cost is billed, never hidden — and it is paging, never generation.
    if (gb.coverage.chunks) {
      assert.equal(gb.coverage.chunks.ungenerated, 0, JSON.stringify(gb.coverage.chunks));
    }

    // scene_summary must page the vantage point in before reading biome/light off it.
    const ss = await call("scene_summary", { origin });
    assert.equal(ss.origin_loaded, true);
    assert.ok(ss.sentence.startsWith("In "), `expected an unqualified sentence: ${ss.sentence}`);

    await call("set_blocks", { blocks: [{ x: AUTO.x, y: Y, z: AUTO.z, block: "minecraft:air" }] });
  });

  test("virgin terrain is reported, never generated", async (t) => {
    if (!bridgeUp) return t.skip();
    // Coordinates no test has ever touched, so the region file has nothing here.
    const origin = { x: 1_500_000, y: Y, z: 1_500_000 };

    const t0 = performance.now();
    const gb = await call("get_surface", { origin, grid: 1 });
    const elapsed = performance.now() - t0;

    assert.equal(gb.coverage.state, "none", JSON.stringify(gb.coverage));
    assert.ok(gb.coverage.chunks.ungenerated > 0,
      `virgin chunks must be reported as ungenerated: ${JSON.stringify(gb.coverage.chunks)}`);
    assert.equal(gb.coverage.chunks.paged_in, 0, "nothing should have been paged in");
    assert.match(gb.coverage.note, /never been generated/i);
    assert.match(gb.coverage.note, /forceload/i, "the note must name the deliberate remedy");
    // Generating one chunk measured ~900ms; refusing must be far quicker than doing it.
    assert.ok(elapsed < 500, `refusing virgin terrain should be fast, took ${elapsed.toFixed(0)}ms`);

    // And it must not have created anything: a second read sees the same emptiness.
    const again = await call("get_surface", { origin, grid: 1 });
    assert.equal(again.coverage.state, "none", "the first read must not have generated terrain");
  });

  test("load:false still reports honestly instead of guessing", async (t) => {
    if (!bridgeUp) return t.skip();
    const origin = { x: COLD.x, y: Y, z: COLD.z };

    const gb = await call("get_surface", { origin, grid: 5, load: false });
    assert.equal(gb.coverage.state, "none");
    assert.equal(gb.columns, 0);
    // The regression that motivated this file: covered_radius used to advance through rings whose
    // columns were all skipped, claiming survey extent over an area that was never looked at.
    assert.equal(gb.covered_radius, -1, "covered_radius must not advance through unread rings");
    assert.match(gb.coverage.note, /not evidence of absence/i);
    assertClosedAccounting(gb.coverage, "get_surface/cold");

    const sb = await call("describe_box", {
      min: { x: COLD.x, y: Y, z: COLD.z }, max: { x: COLD.x + 4, y: Y + 4, z: COLD.z + 4 },
      load: false,
    });
    assert.equal(sb.coverage.state, "none");
    assertClosedAccounting(sb.coverage, "describe_box/cold");

    const ss = await call("scene_summary", { origin, load: false });
    assert.equal(ss.origin_loaded, false);
    // The sentence is the first thing read, so the caveat leads rather than trails.
    assert.ok(ss.sentence.startsWith("[UNOBSERVED"), `sentence must lead with the caveat: ${ss.sentence}`);
  });

  test("loaded area: reports complete, sees real blocks, drops the caveat", async (t) => {
    if (!bridgeUp) return t.skip();
    const origin = { x: HOT.x, y: Y, z: HOT.z };
    // Vanilla caps forceload at 256 chunks per command; this rectangle is 25.
    await cmd(`forceload add ${HOT.x - 32} ${HOT.z - 32} ${HOT.x + 32} ${HOT.z + 32}`);
    try {
      const gb = await call("get_surface", { origin, grid: 5 });
      assert.equal(gb.coverage.state, "complete");
      assert.equal(gb.covered_radius, 5);
      assert.equal(gb.columns, 121);
      assert.equal(gb.coverage.note, undefined, "a complete read carries no caveat");
      assertClosedAccounting(gb.coverage, "get_surface/hot");

      const ss = await call("scene_summary", { origin });
      assert.equal(ss.origin_loaded, true);
      assert.ok(ss.sentence.startsWith("In "), `no caveat expected: ${ss.sentence}`);

      // Coverage is about honesty, not blindness — a loaded read still reports what is there.
      await call("set_blocks", { blocks: [
        { x: HOT.x, y: Y, z: HOT.z, block: "minecraft:gold_block" },
        { x: HOT.x + 1, y: Y, z: HOT.z, block: "minecraft:bookshelf" },
      ]});
      const sb = await call("describe_box", {
        min: { x: HOT.x - 1, y: Y - 1, z: HOT.z - 1 }, max: { x: HOT.x + 3, y: Y + 3, z: HOT.z + 3 },
      });
      assert.equal(sb.coverage.state, "complete");
      const mats = JSON.stringify(sb.materials ?? []);
      assert.match(mats, /gold_block/);
      assert.match(mats, /bookshelf/);

      await call("set_blocks", { blocks: [
        { x: HOT.x, y: Y, z: HOT.z, block: "minecraft:air" },
        { x: HOT.x + 1, y: Y, z: HOT.z, block: "minecraft:air" },
      ]});
    } finally {
      await cmd(`forceload remove ${HOT.x - 32} ${HOT.z - 32} ${HOT.x + 32} ${HOT.z + 32}`);
    }
  });

  test("get_blocks_at reads exact coordinates, including blocks no other tool can see", async (t) => {
    if (!bridgeUp) return t.skip();
    const { x, z } = POINT;
    await cmd(`forceload add ${x - 24} ${z - 24} ${x + 24} ${z + 24}`);
    try {
      // A buried block under a lid: get_surface reports the column TOP, describe_box reports a
      // histogram. Neither can say what sits at this one coordinate — that is the whole gap.
      await call("set_blocks", { blocks: [
        { x, y: Y, z, block: "minecraft:gold_block" },
        { x, y: Y + 1, z, block: "minecraft:stone" },
        { x: x + 1, y: Y, z, block: "minecraft:oak_stairs[facing=east,half=top]" },
        { x: x + 2, y: Y, z, block: "minecraft:chest[facing=north]{Items:[{Slot:0b,id:\"minecraft:diamond\",count:5}]}" },
      ]});

      const r = await call("get_blocks_at", { blocks: [
        { x, y: Y, z },
        { x, y: Y + 1, z },
        { x: x + 1, y: Y, z },
      ]});
      assert.equal(r.coverage.state, "complete");
      // rows are [x,y,z,paletteIndex]; resolve them through the shared palette.
      const at = (i) => r.palette[r.blocks[i][3]];
      assert.equal(at(0), "minecraft:gold_block", "must see the BURIED block, not the column top");
      assert.equal(at(1), "minecraft:stone");
      // Blockstates come back in set_blocks syntax so a read round-trips into a write.
      assert.match(at(2), /^minecraft:oak_stairs\[/);
      assert.match(at(2), /facing=east/);
      assert.match(at(2), /half=top/);

      // Round-trip proof: feed the read string straight back to set_blocks and re-read it.
      await call("set_blocks", { blocks: [{ x: x + 5, y: Y, z, block: at(2) }] });
      const back = await call("get_blocks_at", { blocks: [{ x: x + 5, y: Y, z }] });
      assert.equal(back.palette[back.blocks[0][3]], at(2), "read → write → read must be stable");

      // detail:full surfaces block-entity NBT.
      const withNbt = await call("get_blocks_at", { blocks: [{ x: x + 2, y: Y, z }], detail: "full" });
      assert.match(JSON.stringify(withNbt.nbt), /diamond/, JSON.stringify(withNbt.nbt));
    } finally {
      await cmd(`forceload remove ${x - 24} ${z - 24} ${x + 24} ${z + 24}`);
    }
  });

  test("expect turns N verification probes into one call with a yes/no answer", async (t) => {
    if (!bridgeUp) return t.skip();
    const { x, z } = POINT;
    await cmd(`forceload add ${x - 24} ${z - 24} ${x + 24} ${z + 24}`);
    try {
      await call("set_blocks", { blocks: [
        { x, y: Y, z, block: "minecraft:gold_block" },
        { x: x + 1, y: Y, z, block: "minecraft:oak_stairs[facing=east,half=top]" },
      ]});

      const ok = await call("get_blocks_at", { blocks: [
        { x, y: Y, z, expect: "minecraft:gold_block" },
        // A bare id matches any state; a stated expect requires those properties. Vanilla semantics.
        { x: x + 1, y: Y, z, expect: "minecraft:oak_stairs" },
        { x: x + 1, y: Y, z, expect: "minecraft:oak_stairs[facing=east]" },
      ]});
      assert.equal(ok.check.all_matched, true, JSON.stringify(ok));
      assert.equal(ok.check.matched, 3);
      assert.equal(ok.mismatches, undefined);

      const bad = await call("get_blocks_at", { blocks: [
        { x, y: Y, z, expect: "minecraft:diamond_block" },
        { x: x + 1, y: Y, z, expect: "minecraft:oak_stairs[facing=west]" },
      ]});
      assert.equal(bad.check.all_matched, false);
      assert.equal(bad.check.mismatched, 2);
      // A mismatch says what was actually there — the say-token trick could only say "not it".
      assert.equal(bad.mismatches[0].actual, "minecraft:gold_block");
      assert.match(bad.mismatches[1].actual, /facing=east/);

      // Unreadable must never count as a pass: an unanswered check fails all_matched. The
      // coordinate must be virgin — never loaded, never generated — and a virgin coordinate is
      // OWNED like any other site, more strictly even: generation is permanent, so one file
      // touching it retires it for every file. 1.60M is predicates.test.mjs's.
      const unread = await call("get_blocks_at", {
        blocks: [{ x: 1_650_000, y: Y, z: 1_650_000, expect: "minecraft:stone" }],
        load: false,
      });
      assert.equal(unread.check.all_matched, false, "an unread check is not a passing check");
      assert.equal(unread.check.unreadable, 1);
      assert.equal(unread.blocks[0][3], -1, "unread position must render as -1, never a block");
      assert.equal(unread.blocks[0][4], -1, "unread match must be -1, not 0");
    } finally {
      await cmd(`forceload remove ${x - 24} ${z - 24} ${x + 24} ${z + 24}`);
    }
  });

  test("straddling the loaded edge: partial, with covered_radius honest to the last whole ring", async (t) => {
    if (!bridgeUp) return t.skip();
    const origin = { x: HOT.x, y: Y, z: HOT.z };
    await cmd(`forceload add ${HOT.x} ${HOT.z} ${HOT.x} ${HOT.z}`); // one chunk
    try {
      // load:false pins the residency boundary so the ring arithmetic is deterministic — with
      // loading on, a 97-wide grid spans ~49 chunks and simply completes.
      const gb = await call("get_surface", { origin, grid: 48, load: false });
      assert.equal(gb.coverage.state, "partial");
      assert.ok(gb.columns > 0, "loaded columns are still reported");
      assert.ok(gb.coverage.unloaded > 0, "unloaded columns are counted");
      assert.ok(gb.covered_radius < 48, "covered_radius must stop short of the requested grid");
      assert.ok(gb.covered_radius >= 0, "the loaded centre is still covered");
      assert.equal(gb.coverage.requested, 97 * 97, "requested is the full grid, not just what was visited");
      assertClosedAccounting(gb.coverage, "get_surface/edge");
      // The two shortfalls have different remedies, so the note keeps them apart.
      assert.match(gb.coverage.note, /load:false/i);
      if (gb.coverage.unvisited > 0) assert.match(gb.coverage.note, /response budget/i);

      // The contract that makes covered_radius usable: within it, the read really is whole.
      const inner = await call("get_surface", { origin, grid: gb.covered_radius, load: false });
      assert.equal(inner.coverage.state, "complete",
        `re-reading within covered_radius=${gb.covered_radius} must be complete`);

      // scene_summary samples a fixed 25x25 window; find where that window straddles the edge.
      let edge = null;
      for (let off = 8; off <= 220 && edge === null; off += 4) {
        const p = await call("get_surface",
          { origin: { x: HOT.x + off, y: Y, z: HOT.z }, grid: 12, load: false });
        if (p.coverage.state === "partial") edge = HOT.x + off;
      }
      if (edge === null) {
        t.diagnostic("no partial band for a 25x25 window; skipping the scene_summary edge assertion");
      } else {
        const ss = await call("scene_summary", { origin: { x: edge, y: Y, z: HOT.z }, load: false });
        assert.ok(ss.sentence.startsWith("[PARTIAL"), `expected a PARTIAL lead: ${ss.sentence}`);
      }
    } finally {
      await cmd(`forceload remove ${HOT.x} ${HOT.z}`);
    }
  });
});
