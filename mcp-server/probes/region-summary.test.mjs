// get_region_summary: the perception rung above scene_summary (REPRESENTATION_DESIGN.md §2).
// Aggregates must be REAL numbers over a staged, hand-computable region, and unread space must
// stay unread — a tile the loader cannot supply reports state:"unread" with no statistics.
//
// Invariants under test:
//   1. a staged flat stone tile yields exactly its numbers: height min=max=Y, stddev 0, all-stone
//      surface histogram, no fluids, complete coverage, an unqualified sentence.
//   2. semantic labels: a placed bell registers a minecraft:meeting POI; a /place'd village
//      structure start is named by id in the covering tile; summoned animals are counted.
//   3. a grid straddling generated and virgin terrain is PARTIAL: virgin tiles say "unread" with
//      no stats, the sentence leads with the caveat, chunk accounting closes.
//   4. an all-virgin region is [UNOBSERVED] with coverage none.
//   5. oversized requests fail fast (too_large), never silently shrink.
//   6. wall-clock per call is measured and logged — this number decides the §2 cache question
//      (research open question 2): derived-on-demand stays cacheless while calls are cheap.
//
// Live probe: needs the dev server (`gradlew runServer`). Skips itself when the bridge is down.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const FLAT = { x: 1700000, z: 1700000 };   // 1-chunk staged tile, chunk-aligned below
const TOWN = { x: 1800000, z: 1800000 };   // village structure + bell + cows
const VIRGIN = { x: 1900000, z: 1900000 }; // never touched

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

async function callRaw(tool, args = {}) {
  const res = await fetch(`${BASE}/cmd`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool, args }),
  });
  return res.json();
}

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok)
  .catch(() => false);
if (!bridgeUp) {
  console.log(`\n  [skip] no bridge at ${BASE} — start the dev server to run these probes\n`);
}

async function staged(at, radius, fn) {
  await cmd(`forceload add ${at.x - radius} ${at.z - radius} ${at.x + radius} ${at.z + radius}`);
  try {
    return await fn();
  } finally {
    await cmd(`forceload remove ${at.x - radius} ${at.z - radius} ${at.x + radius} ${at.z + radius}`);
  }
}

/** Time a summary call; the numbers feed the derived-on-demand-vs-cache decision. */
async function timedSummary(args) {
  const t0 = performance.now();
  const r = await call("get_region_summary", args);
  const ms = performance.now() - t0;
  const chunks = r.coverage.requested;
  console.log(`    [timing] get_region_summary ${chunks} chunks (${r.coverage.read} read): ${ms.toFixed(0)}ms`);
  return { r, ms };
}

describe("get_region_summary", { skip: !bridgeUp }, () => {
  // Chunk-align the staged tile: the grid is chunk-aligned, so the flat floor must be too.
  const chunkX = (FLAT.x >> 4) << 4;
  const chunkZ = (FLAT.z >> 4) << 4;
  const Y = 150;

  test("staged flat tile: exact height/surface/fluids numbers, complete coverage", async () => {
    await staged(FLAT, 20, async () => {
      await cmd(`fill ${chunkX} ${Y} ${chunkZ} ${chunkX + 15} ${Y} ${chunkZ + 15} minecraft:stone`);
      await cmd(`fill ${chunkX} ${Y + 1} ${chunkZ} ${chunkX + 15} ${Y + 40} ${chunkZ + 15} minecraft:air`);

      const { r, ms } = await timedSummary({
        center: { x: chunkX + 8, z: chunkZ + 8 }, tiles: 1, tile_chunks: 1,
      });
      assert.equal(r.perception_mode, "spatial");
      assert.equal(r.coverage.state, "complete");
      assert.equal(r.coverage.requested, 1, "1×1 tile of 1 chunk = 1 chunk");
      assert.equal(r.tiles.length, 1);
      const t = r.tiles[0];
      assert.equal(t.state, "complete");
      assert.equal(t.height.min, Y, JSON.stringify(t.height));
      assert.equal(t.height.max, Y);
      assert.equal(t.height.stddev, 0);
      assert.deepEqual(t.surface, { "minecraft:stone": 16 }, "16 sampled columns at stride 4, all stone");
      assert.deepEqual(t.fluids, { water: 0, lava: 0 });
      assert.deepEqual(t.structures, []);
      assert.ok(!r.sentence.includes("PARTIAL"), r.sentence);
      assert.match(r.sentence, /ground y 150–150/);
      assert.ok(ms < 10000, `a 1-chunk summary should be far under 10s, took ${ms.toFixed(0)}ms`);
    });
  });

  test("semantic labels: bell POI and summoned cows counted", async () => {
    await staged(TOWN, 56, async () => {
      const cx = (TOWN.x >> 4) << 4;
      const cz = (TOWN.z >> 4) << 4;
      // A meeting POI: the bell block registers it on placement (set_blocks pages the chunk in).
      await call("set_blocks", { blocks: [{ x: cx + 4, y: 120, z: cz + 4, block: "minecraft:bell" }] });
      // Live entities need actually-loaded chunks, and forceload only MARKS them (loading is
      // async, found live) — retry the summon until the area is really loaded.
      let summoned = "";
      for (let i = 0; i < 20 && !/Summoned/.test(summoned); i++) {
        summoned = JSON.stringify((await cmd(`summon minecraft:cow ${cx + 8} 130 ${cz + 8}`)).output);
        if (!/Summoned/.test(summoned)) await new Promise((res) => setTimeout(res, 500));
      }
      assert.match(summoned, /Summoned/, `summon kept failing: ${summoned}`);
      await cmd(`summon minecraft:cow ${cx + 9} 130 ${cz + 8}`);

      const { r } = await timedSummary({ center: { x: cx + 8, z: cz + 8 }, tiles: 3, tile_chunks: 2 });
      const complete = r.tiles.filter((t) => t.state !== "unread");
      assert.ok(complete.length > 0);
      const pois = complete.reduce((s, t) => s + t.poi_count, 0);
      assert.ok(pois >= 1, `bell must register a POI: ${pois}`);
      const kinds = complete.flatMap((t) => Object.keys(t.poi_kinds ?? {}));
      assert.ok(kinds.includes("minecraft:meeting"), `bell is a meeting POI: ${JSON.stringify(kinds)}`);
      // entities is tri-state since 0.6.0: null over a tile with no entity-searchable chunk and
      // nothing found (unknown ≠ zero) — sum over the tiles that carry counts.
      const passive = complete.reduce((s, t) => s + (t.entities?.passive ?? 0), 0);
      assert.ok(passive >= 2, `two summoned cows must be counted: ${passive}`);

      await cmd(`kill @e[type=minecraft:cow,x=${cx},z=${cz},dx=48,dy=384,dz=48]`);
      await call("set_blocks", { blocks: [{ x: cx + 4, y: 120, z: cz + 4, block: "minecraft:air" }] });
    });
  });

  test("natural structure starts are named by id", async () => {
    // /place structure does NOT register a StructureStart in 26.2 (verified via bytecode: it only
    // calls placeInChunk), so staging one is impossible — instead ask /locate for the nearest
    // REAL structure (StructureCheck answers over ungenerated chunks), generate its chunks via
    // forceload, and the rollup must name it. World-agnostic: coordinates come from locate.
    const loc = await cmd(
      `execute positioned ${TOWN.x} 100 ${TOWN.z} run locate structure minecraft:ruined_portal`);
    const m = JSON.stringify(loc.output).match(/\[(-?\d+), ~, (-?\d+)\]/);
    assert.ok(m, `locate must answer: ${JSON.stringify(loc.output)}`);
    const sx = parseInt(m[1], 10);
    const sz = parseInt(m[2], 10);
    await staged({ x: sx, z: sz }, 24, async () => {
      const { r } = await timedSummary({ center: { x: sx, z: sz }, tiles: 1, tile_chunks: 3 });
      const structures = new Set(r.tiles.flatMap((t) => t.structures ?? []));
      assert.ok(structures.has("minecraft:ruined_portal"),
        `the located portal start must be named: ${JSON.stringify([...structures])}`);
      assert.match(r.sentence, /ruined_portal/);
    });
  });

  test("straddling grid is partial: unread tiles carry no stats, sentence leads with caveat", async () => {
    // Deliberately off-centre staging: generate ONLY the west third of a 6×6-chunk grid. Chunk
    // generation spills a ~1-chunk ring past a forceload (found live), so the east tiles sit ≥3
    // chunks from the staged square and stay virgin. This dev world is OLD — no fixed coordinate
    // can be assumed virgin (2.0M and 2.1M both turned out generated) — so verify virginity of
    // the east side first and walk candidates until one passes.
    // 2026-07-23: the 2.3M band burned out (every candidate's center chunk column turned up
    // generated — old runs walked the same formula), so the walk starts in a fresh band and
    // tries more candidates. The check covers the candidate's own column too, not just east:
    // the summary grid spans gc-3..gc+2, so ANY generated chunk near center poisons the fixture.
    // 2026-08-05: the 2.9M band burned out the same way, for the same reason — this test GENERATES
    // the terrain it then needs to be virgin, so every band it walks is spent for good. Moved to
    // 5.1M with a wider stride; expect to move it again eventually. (The alternative — a fresh
    // world per run — costs more than the move.)
    // 2026-08-10: and again — all 24 of the 5.1M candidates were spent (five days of batteries,
    // one candidate burned per run once the earlier ones are generated), so the walk failed with
    // "no virgin candidate site found". Moved to 11.3M with a stride ~3× wider, which buys more
    // headroom per candidate than a denser walk in a burnt band would. The decay is structural to
    // a test that must consume virgin terrain, so treat a future recurrence as maintenance rather
    // than as a regression: check THIS assertion's history before suspecting the perception code.
    let P = null;
    for (let i = 0; i < 24 && !P; i++) {
      const cand = { x: 11_300_000 + i * 370_000, z: 12_700_000 + i * 253_000 };
      const eastX = ((cand.x >> 4) + 2) << 4;
      const gb = await call("get_surface", { origin: { x: eastX, y: 200, z: cand.z }, grid: 24 });
      if (gb.coverage.state === "none") P = cand;
    }
    assert.ok(P, "no virgin candidate site found in 24 tries");
    const gc = P.x >> 4;
    const gcz = P.z >> 4;
    // Grid: tiles 3 × tile_chunks 2 → chunks [gc-3 .. gc+2] × [gcz-3 .. gcz+2]. West two columns only:
    const westMin = (gc - 3) << 4;
    const westMax = ((gc - 2) << 4) + 15;
    const zMin = (gcz - 3) << 4;
    const zMax = ((gcz + 2) << 4) + 15;
    await cmd(`forceload add ${westMin} ${zMin} ${westMax} ${zMax}`);
    try {
      const { r } = await timedSummary({ center: { x: P.x, z: P.z }, tiles: 3, tile_chunks: 2 });
      assert.equal(r.coverage.state, "partial", JSON.stringify(r.coverage));
      assert.ok(r.sentence.startsWith("[PARTIAL"), `caveat must lead: ${r.sentence}`);
      const unread = r.tiles.filter((t) => t.state === "unread");
      assert.ok(unread.length >= 3, `the east tile column must be virgin: ${JSON.stringify(r.tiles.map((t) => t.state))}`);
      for (const t of unread) {
        assert.equal(t.height, undefined, `unread tiles carry no stats: ${JSON.stringify(t)}`);
        assert.equal(t.surface, undefined);
        assert.equal(t.chunks.read, 0);
      }
      const readTiles = r.tiles.filter((t) => t.state === "complete");
      assert.ok(readTiles.length >= 3, "the west tile column must be readable");
      assert.equal(
        r.coverage.read + r.coverage.unloaded, r.coverage.requested,
        `chunk accounting must close: ${JSON.stringify(r.coverage)}`);
    } finally {
      await cmd(`forceload remove ${westMin} ${zMin} ${westMax} ${zMax}`);
    }
  });

  test("all-virgin region: [UNOBSERVED], coverage none, nothing synthesized", async () => {
    const { r } = await timedSummary({ center: { x: VIRGIN.x, z: VIRGIN.z } });
    assert.equal(r.coverage.state, "none");
    assert.match(r.sentence, /UNOBSERVED/);
    assert.ok(r.tiles.every((t) => t.state === "unread"));
  });

  test("oversized request fails fast, never shrinks", async () => {
    const over = await callRaw("get_region_summary", {
      center: { x: 0, z: 0 }, tiles: 5, tile_chunks: 4,
    });
    assert.equal(over.ok, false, "400 chunks over the 256 cap must be an error");
    assert.match(JSON.stringify(over.error), /too_large/);
  });
});
