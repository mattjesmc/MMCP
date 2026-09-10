// preview_worldgen — asking the loaded generator what it makes, generating nothing.
// WORLDGEN_ITERATION_DESIGN.md phase 1 / RELEASE_1.md §D4.
//
// The four claims, and each one has a falsifier here rather than a confirmation:
//
//   1. IT GENERATES NOTHING. The strongest claim and the easiest to break, so it is checked in the
//      only way that can break it: preview a column five million blocks out, then ask the WORLD
//      about the same column and require it to still report an ungenerated chunk. A tool that
//      quietly took a chunk to FULL would pass every other test in this file.
//   2. THE NUMBERS ARE OF THIS GENERATOR. A constant with a plausible name passes "is it an
//      integer". So: the same call twice must be byte-identical (it is a pure function), and a
//      DIFFERENT seed must move the terrain. Determinism without seed-sensitivity is a cache;
//      seed-sensitivity without determinism is noise. Both, together, is a generator.
//   3. IT REFUSES WHERE IT CANNOT ANSWER. The canvas dimensions (0.102.0) are `minecraft:flat`,
//      which has no NoiseGeneratorSettings and no seed dependence at all — so `seed` there must
//      refuse BY NAME rather than sample the live seed and answer a different question. A real
//      non-noise generator in the same server is a better arbiter than a mock.
//   4. THE BOUNDARY IS IN THE REPLY. Every reply says NOISE ONLY in words, and the compare block
//      reports a distribution rather than a stale/fresh verdict. A test that only checked the
//      numbers would let the honesty regress silently.
//
// GLOBAL RESOURCES: none. This file forceloads nothing, freezes nothing and reloads nothing; the
// one case that needs generated terrain reads the world around spawn, which every world has.
// No site — it writes no blocks anywhere.

import { test, before } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
async function call(tool, args = {}) {
  const res = await fetch(`${BASE}/cmd`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool, args }),
  });
  return res.json();
}
const ok = (r, what) => {
  assert.equal(r.ok, true, `${what}: ${r.error ?? JSON.stringify(r)}`);
  return r.result;
};

// Far enough out that nothing this workbench has ever done reaches it, and far from every site the
// site map registers. Nothing here is ever generated — that is the point of the case that uses it.
const VIRGIN = { x: 5_400_000, z: 5_400_000 };

before(async () => {
  const res = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
  if (!res?.ok) throw new Error("no bridge — start the dev server (gradlew runServer) first");
});

test("it answers about ground that does not exist, and does not create it", async () => {
  const before1 = ok(await call("get_blocks_at", { blocks: [{ ...VIRGIN, y: 64 }] }),
    "world read before");
  assert.notEqual(before1.coverage?.state, "complete",
    "VIRGIN is already generated in this world — pick a further coordinate, the case is void");

  const p = ok(await call("preview_worldgen", { center: VIRGIN }), "preview");
  assert.ok(Number.isInteger(p.at.noise_floor), "no noise_floor");
  assert.ok(p.at.noise_floor > p.generator.min_y,
    `noise_floor ${p.at.noise_floor} is the world floor — that is what an unanswered column looks `
    + `like, not terrain`);
  assert.match(p.at.biome, /^[a-z0-9_.-]+:[a-z0-9_./-]+$/, `biome ${p.at.biome} is not an id`);

  // THE FALSIFIER. If the preview took the chunk to FULL, this comes back complete.
  const after1 = ok(await call("get_blocks_at", { blocks: [{ ...VIRGIN, y: 64 }] }),
    "world read after");
  assert.notEqual(after1.coverage?.state, "complete",
    "preview_worldgen GENERATED the chunk it was asked about — it must never create terrain");
});

test("the same call twice is byte-identical — it is a pure function of loaded registries", async () => {
  const args = { center: VIRGIN, radius: 64, stride: 32 };
  const a = ok(await call("preview_worldgen", args), "first");
  const b = ok(await call("preview_worldgen", args), "second");
  assert.deepEqual(b.samples, a.samples, "two identical calls disagreed");
  assert.equal(b.generator.seed, a.generator.seed);
});

test("a different seed is a different world, with no restart", async () => {
  const args = { center: VIRGIN, radius: 128, stride: 32 };
  const live = ok(await call("preview_worldgen", args), "live seed");
  const other = ok(await call("preview_worldgen", { ...args, seed: 1234567 }), "seed 1234567");

  assert.equal(live.generator.seed_source, "world");
  assert.equal(other.generator.seed_source, "override");
  assert.equal(other.generator.seed, 1234567);
  assert.equal(other.generator.world_seed, live.generator.seed,
    "an override must still report the world's own seed, or the reply cannot be compared to a later one");

  const heights = (r) => r.samples.map((s) => s.noise_floor);
  const differing = heights(live).filter((h, i) => h !== heights(other)[i]).length;
  assert.ok(differing > heights(live).length / 2,
    `only ${differing}/${heights(live).length} columns moved when the seed changed — the seed `
    + `argument is not reaching the noise router`);

  // ...and the override must not stick. A cached RandomState leaking into the next call would make
  // every later reply wrong in a way nothing else here would catch.
  const again = ok(await call("preview_worldgen", args), "live seed again");
  assert.deepEqual(again.samples, live.samples, "the seed override leaked into the next call");
});

test("a flat generator refuses `seed` by name instead of answering a different question", async () => {
  const canvas = { center: { x: 0, z: 0 }, dimension: "mcptoolkit:workshop" };
  const plain = await call("preview_worldgen", canvas);
  if (!plain.ok && /no loaded dimension/.test(plain.error ?? "")) {
    // The canvas needs one restart on a world that has never seen it (0.102.0). Say which, rather
    // than skip silently.
    assert.fail("mcptoolkit:workshop is not loaded — restart this world once so the canvas installs");
  }
  const flat = ok(plain, "flat preview");
  assert.equal(flat.generator.type, "minecraft:flat");
  assert.equal(flat.generator.noise_settings, undefined,
    "a flat generator has no noise settings; reporting one would be an invention");

  const refused = await call("preview_worldgen", { ...canvas, seed: 42 });
  assert.equal(refused.ok, false, "`seed` on a flat generator was accepted");
  assert.match(refused.error, /noise generator/,
    `refusal does not say why: ${refused.error}`);
  assert.match(refused.error, /minecraft:flat/,
    `refusal does not name what this dimension actually has: ${refused.error}`);
});

test("compare reports a distribution over real chunks, and never invents an unread one", async () => {
  // The spawn region: the one place every world of every shape has generated chunks, and this
  // file forceloads nothing to get them.
  const r = ok(await call("preview_worldgen", {
    center: { x: 0, z: 0 }, radius: 48, stride: 16, compare: true,
  }), "compare at spawn");

  assert.ok(r.compare, "no compare block");
  assert.equal(r.compare.requested, r.samples.length);
  assert.equal(r.compare.compared + r.compare.unread, r.compare.requested,
    "compared + unread must account for every sample, or coverage is being faked");
  for (const s of r.samples) {
    if (s.world_floor === "unread") {
      assert.equal(s.delta, undefined, "an unread column reported a delta");
    } else {
      assert.equal(s.delta, s.world_floor - s.noise_floor, "delta does not match its own operands");
    }
  }
  // A distribution needs a sample. On a VIRGIN server the spawn region may hold one generated
  // column (compared:1), and "at least a quarter match" over one column is a coin toss on whether
  // that column was disturbed - red at n=1 on a fresh server, green on an established world
  // (RELEASE_1.md F2). The falsifier below is a claim about a POPULATION, so it needs one; with
  // fewer than four compared columns the case says so and stops rather than pronouncing.
  if (r.compare.compared < 4) {
    console.log(`  [compare] only ${r.compare.compared} column(s) generated at spawn - too few for `
      + "the distribution assertions (virgin world?); the accounting above still held");
    return;
  }
  // THE OFF-BY-ONE FALSIFIER, and it is the case that earned its place: getBaseHeight returns the
  // first FREE y and ChunkAccess.getHeight returns the topmost SOLID one, so subtracting them
  // straight put a systematic -1 on every untouched column - identical:0 over this exact grid on
  // the first live run, which is precisely the "one-directional shift" the reply tells a caller to
  // read as "your generator changed". Undisturbed terrain around spawn must AGREE.
  assert.ok(r.compare.identical >= r.compare.compared / 4,
    `only ${r.compare.identical}/${r.compare.compared} columns match the generator exactly `
    + `(deltas ${r.compare.delta_min}..${r.compare.delta_max}) - the two heightmap conventions are `
    + `off by one again, and every world would read as stale`);
  assert.ok(r.compare.abs_delta_p50 <= 1,
    `median |delta| is ${r.compare.abs_delta_p50} on untouched spawn terrain`);

  assert.match(r.compare.how_to_read, /surface rules/,
    "compare must say what the two heightmaps do not share — a bare number here is a verdict");
  assert.equal(r.compare.stale, undefined, "compare must not hand back a boolean verdict");
});

test("the noise column is run-length encoded and covers the world height", async () => {
  const r = ok(await call("preview_worldgen", { center: VIRGIN, column: true }), "column");
  assert.ok(Array.isArray(r.column.runs) && r.column.runs.length > 0, "no runs");
  for (const run of r.column.runs) {
    assert.ok(run.height > 0, "a zero-height run is not a run");
    assert.match(run.block, /^[a-z0-9_.-]+:[a-z0-9_./-]+$/, `${run.block} is not a block id`);
  }
  if (!r.column.truncated_at_runs) {
    const covered = r.column.runs.reduce((n, run) => n + run.height, 0);
    assert.ok(covered <= r.generator.height,
      `runs cover ${covered} blocks in a ${r.generator.height}-high world`);
    // Adjacent runs must not repeat a block id — that would mean the encoding is not encoding.
    for (let i = 1; i < r.column.runs.length; i++) {
      assert.notEqual(r.column.runs[i].block, r.column.runs[i - 1].block,
        "two adjacent runs carry the same block — the run-length encoding is a no-op");
    }
  }
});

test("an over-cap grid refuses with the arithmetic, rather than silently shrinking", async () => {
  const r = await call("preview_worldgen", { center: VIRGIN, radius: 4096, stride: 1 });
  assert.equal(r.ok, false, "an 8193x8193 grid was accepted");
  assert.match(r.error, /cap/, `refusal does not name the cap: ${r.error}`);
  assert.match(r.error, /stride/, `refusal does not say what to change: ${r.error}`);
});

test("every reply carries the noise-only boundary in words", async () => {
  const r = ok(await call("preview_worldgen", { center: VIRGIN }), "preview");
  assert.match(r.note, /NOISE ONLY/, "the boundary is not in the reply");
  assert.match(r.note, /surface rules/, "the reply does not say what it cannot see");
  assert.ok(r.at.noise_floor !== undefined && r.at.terrain === undefined,
    "the field is called noise_floor, never terrain — the word is the honesty");
});

test("an unknown dimension refuses and says what there is", async () => {
  const r = await call("preview_worldgen", { center: VIRGIN, dimension: "mcptoolkit:nowhere" });
  assert.equal(r.ok, false);
  assert.match(r.error, /minecraft:overworld/,
    `refusal does not list what the server has: ${r.error}`);
});
