// get_perf — the tick read (RELEASE_1.md §D7), live.
//
// Three things are held here, and they are the three the tool claims:
//   1. THE NUMBERS ARE OF SOMETHING. mspt comes off vanilla's own 100-tick ring, and the ring is
//      only partly filled on a young server — a mean over the empty half would report a booting
//      server as impossibly fast. `samples` is asserted against the ring's width.
//   2. THE CENSUS IS OF THIS WORLD. A count that does not move when the world moves is a constant
//      with a plausible name, so the ticking-block-entity census is checked by PLACING TICKERS and
//      watching the number, the type list and the hot chunk all follow — then by removing them and
//      watching it all go back. (Hoppers: a chest has no ticker at all, which is exactly the
//      difference between "block entities" and "block entities that cost a tick".)
//   3. THE SUMMARY CANNOT CONTRADICT THE FIELDS BESIDE IT. `runs_normally` is asserted against a
//      REALLY frozen server, which is how the first run caught it agreeing with `frozen:true` —
//      vanilla's own TickRateManager.runsNormally() is a once-per-tick cache and lags the freeze.
//
// GLOBAL RESOURCES, DECLARED (RELEASE_1.md §F2's third finding). This file freezes the server for
// one assertion (`/tick freeze` … `/tick unfreeze`, in a try/finally AND an after() hook) and
// forceloads ~841 chunks. Both are server-wide. It is safe in `battery.ps1`, which runs one file at
// a time; under a concurrent `npm run test:live` a frozen tick is felt by every other file, so this
// file is a sequential-battery citizen by construction.
//
// Site: 4,700,000 (site-map.test.mjs is the register).

import { test, before, after } from "node:test";
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
const cmd = (c) => call("run_command", { command: c });
const ok = (r, what) => {
  assert.equal(r.ok, true, `${what}: ${r.error ?? JSON.stringify(r)}`);
  return r.result;
};

const SITE = { x: 4_700_000, y: 80, z: 4_700_000 };
const HOPPERS = 6;
// One `top` for every census read in this file. Wide enough that an established world's type list
// is not cut at all — but `countOf` below does not TRUST that, because a wide cutoff is still a
// cutoff and the whole point of the 0.109.0 finding is that a reader cannot tell from the list.
const TOP = 50;
const OVERWORLD = "minecraft:overworld";

const overworldOf = (perf) => perf.levels.find((l) => l.dimension === OVERWORLD);

before(async () => {
  const res = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
  if (!res?.ok) throw new Error("no bridge — start the dev server (gradlew runServer) first");
  await cmd(`forceload add ${SITE.x - 16} ${SITE.z - 16} ${SITE.x + 16} ${SITE.z + 16}`);
  const t0 = Date.now();
  for (;;) {
    const r = await call("get_blocks_at", { blocks: [SITE] });
    if (r.ok && r.result.coverage?.state === "complete") break;
    if (Date.now() - t0 > 120_000) throw new Error("site chunks not generated in 120s");
    await new Promise((r2) => setTimeout(r2, 1500));
  }
  await clearSite();
  await settle();
});

after(async () => {
  // Unfreezing here as well as in the test's own finally: a frozen server left behind is not this
  // file's failure, it is every later file's failure, with nothing wrong in them.
  await cmd("tick unfreeze").catch(() => {});
  await clearSite().catch(() => {});
  await cmd(`forceload remove ${SITE.x - 16} ${SITE.z - 16} ${SITE.x + 16} ${SITE.z + 16}`).catch(() => {});
});

/**
 * Wait until the forceloaded region has finished streaming in. THE FIRST RUN NEEDED THIS: the
 * baseline was taken while chunks were still arriving, one of them held a mob spawner, and the
 * total ticker count moved by HOPPERS+1. The census was right and the assumption was wrong — but a
 * count that drifts under the test is not something to assert exactly, so this settles it first and
 * the totals below are still asserted as DELTAS rather than as identities.
 */
async function settle() {
  let prev = -1;
  for (let i = 0; i < 20; i++) {
    const lv = overworldOf(ok(await call("get_perf"), "settle"));
    const now = lv.loaded_chunks * 1000 + lv.block_entity_tickers;
    if (now === prev) return;
    prev = now;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * How many of `id` the block-entity census counts — or a refusal, never a guess.
 *
 * The old form was `types.find(…)?.count ?? 0`, and that `?? 0` is the bug this file shipped: it
 * reads "absent from a top-N list" as "absent from the world". The reply now says how many entries
 * it left out, so absence is only a zero when the list is COMPLETE; when it is not, this throws
 * rather than quietly returning a number that is wrong by however many the cutoff hid.
 */
function countOf(level, id, what) {
  const row = level.block_entity_types.find((t) => t.id === id);
  if (row) return row.count;
  const cut = level.block_entity_types_omitted;
  assert.equal(typeof cut, "number",
    `${what}: the census must declare how much it omitted (get_perf < 0.109.0?)`);
  assert.equal(cut, 0,
    `${what}: ${id} is absent from a TRUNCATED census (${cut} types omitted at top=${TOP}), ` +
    "so its count is unknown, not zero — raise top");
  return 0;
}

async function clearSite() {
  const blocks = [];
  for (let i = 0; i < HOPPERS; i++) {
    blocks.push({ x: SITE.x + i, y: SITE.y, z: SITE.z, block: "minecraft:air" });
  }
  await call("set_blocks", { blocks });
}

test("mspt is measured over the FILLED part of vanilla's ring, not over 100 slots", async () => {
  const r = ok(await call("get_perf"), "get_perf");
  assert.ok(r.mspt.samples > 0, `no tick samples: ${JSON.stringify(r.mspt)}`);
  assert.ok(r.mspt.samples <= 100, `ring is 100 wide, got ${r.mspt.samples}`);
  for (const k of ["mean", "p50", "p95", "max"]) {
    assert.equal(typeof r.mspt[k], "number", `mspt.${k} missing`);
    assert.ok(r.mspt[k] >= 0, `mspt.${k} negative`);
  }
  assert.ok(r.mspt.max >= r.mspt.p95, "max must be >= p95");
  assert.ok(r.mspt.p95 >= r.mspt.p50, "p95 must be >= p50");
});

test("tps is capped at the tick rate — a 1ms tick is not 1000 tps", async () => {
  const r = ok(await call("get_perf"), "get_perf");
  assert.ok(r.tps <= r.tick_rate.target + 0.001, `tps ${r.tps} exceeds target ${r.tick_rate.target}`);
  assert.ok(r.tps > 0, "tps should be positive on a running server");
});

test("a frozen server SAYS the milliseconds mean something else", async () => {
  const before2 = ok(await call("get_perf"), "get_perf");
  assert.equal(before2.tick_rate.runs_normally, true,
    `the server was already not ticking normally: ${JSON.stringify(before2.tick_rate)}`);
  assert.equal(before2.tick_rate.note, undefined, "a normal server needs no note");
  try {
    ok(await cmd("tick freeze"), "tick freeze");
    // Read IMMEDIATELY, in the same tick if possible: vanilla's TickRateManager.runsNormally() is a
    // flag recomputed inside tick(), so a summary built on it still says "normal" here. This is the
    // read that caught it.
    const frozen = ok(await call("get_perf"), "get_perf");
    assert.equal(frozen.tick_rate.frozen, true, "frozen not reported");
    assert.equal(frozen.tick_rate.runs_normally, false, "a frozen server does not run normally");
    assert.match(frozen.tick_rate.note ?? "", /not ticking normally/,
      "a frozen reading must carry the note that reinterprets it");
  } finally {
    ok(await cmd("tick unfreeze"), "tick unfreeze");
  }
  const after2 = ok(await call("get_perf"), "get_perf");
  assert.equal(after2.tick_rate.runs_normally, true, "the server should be normal again");
});

test("the ticking-block-entity census follows the world: place hoppers, watch all three move", async () => {
  await settle();
  // EVERY READ IN THIS FILE USES THE SAME `top`, and a type missing from a truncated list is never
  // read as a zero. This case used to take its baseline at the DEFAULT top (5) and compare against
  // a top:50 read: in an established world the hopper ranked sixth, the old `?? 0` called that
  // "there are no hoppers", and 131 of them already in the world reported as `77 !== 6` — a red in
  // the probe that read as a miscount in the tool. `countOf` refuses the guess instead, and
  // 0.109.0 made the truncation visible in the reply so it can.
  const base = overworldOf(ok(await call("get_perf", { top: TOP }), "baseline"));
  const baseTickers = base.block_entity_tickers;
  const baseHoppers = countOf(base, "minecraft:hopper", "baseline");

  const blocks = [];
  for (let i = 0; i < HOPPERS; i++) {
    blocks.push({ x: SITE.x + i, y: SITE.y, z: SITE.z, block: "minecraft:hopper" });
  }
  ok(await call("set_blocks", { blocks }), "place hoppers");
  await new Promise((r) => setTimeout(r, 400)); // let the tickers register on a tick

  const withThem = overworldOf(ok(await call("get_perf", { top: TOP }), "with hoppers"));
  assert.ok(withThem.block_entity_tickers >= baseTickers + HOPPERS,
    `every hopper is a ticker, so the total must move by at least as many as were placed: ` +
    `${baseTickers} -> ${withThem.block_entity_tickers}`);
  assert.equal(countOf(withThem, "minecraft:hopper", "with hoppers"), baseHoppers + HOPPERS,
    "the type census counts the same hoppers");

  // The census names a PLACE, which is the half a bare count cannot do. `hot_chunks` is TOP-N by
  // ticker count, and on an ESTABLISHED world three hoppers do not rank: the 0.124.0 battery's save
  // carried 1,344 leftover tickers and fifty chunks holding six or more each, so the hopper chunk
  // was legitimately outranked and this case read that as "missing" (RELEASE.md 2.2's class:
  // a probe that only ran on a young world). So the place-half is asserted in the form the tool
  // actually claims: the hopper chunk is listed, OR every listed chunk outranks it and the reply
  // says the list was cut. A chunk with three tickers that is absent from an UNCUT list, or absent
  // while a chunk with fewer tickers is present, is the tool's miscount and still fails here.
  const chunkX = SITE.x >> 4;
  const chunkZ = SITE.z >> 4;
  const hot = withThem.hot_chunks.find((c) => c.chunk_x === chunkX && c.chunk_z === chunkZ);
  if (hot) {
    assert.ok(hot.block_entity_tickers >= HOPPERS, `hot chunk under-counts: ${JSON.stringify(hot)}`);
    assert.equal(hot.x >> 4, chunkX, "block coordinates must be inside the chunk they name");
    assert.equal(hot.z >> 4, chunkZ, "block coordinates must be inside the chunk they name");
  } else {
    assert.ok(withThem.hot_chunks_omitted > 0,
      `the hopper chunk is missing from an UNCUT hot_chunks list: ${JSON.stringify(withThem.hot_chunks)}`);
    // The rank is ENTITIES + TICKERS TOGETHER (PerfTools.hotChunks: "the chunks carrying the most
    // tick load"), so the weakest listed chunk is measured on that sum. The 0.132.0 battery had this
    // line compare tickers alone and go red on a chunk holding 0 tickers and a crowd of entities -
    // a ranking the tool claims, read as a cut by a probe that had only ever seen young worlds.
    const load = (c) => (c.entities ?? 0) + c.block_entity_tickers;
    const weakest = Math.min(...withThem.hot_chunks.map(load));
    assert.ok(weakest >= HOPPERS,
      `a chunk with load ${weakest} (entities + tickers) is listed while the hopper chunk (>= ${HOPPERS}) is not - that is a cut, not a ranking: ${JSON.stringify(withThem.hot_chunks.slice(-3))}`);
    console.log(`# note: established world - ${withThem.hot_chunks_omitted} hot chunks omitted at top:${TOP}, ` +
      `the weakest listed carries load ${weakest}; the hopper chunk (${HOPPERS}) is outranked, not missing`);
  }

  ok(await call("set_blocks", { blocks: blocks.map((b) => ({ ...b, block: "minecraft:air" })) }), "remove");
  await new Promise((r) => setTimeout(r, 400));
  const after3 = overworldOf(ok(await call("get_perf", { top: TOP }), "after removal"));
  assert.equal(countOf(after3, "minecraft:hopper", "after removal"), baseHoppers,
    "a removed hopper stops costing a tick, and the census has to say so");
});

test("a chest is a block entity and NOT a ticker — the census counts tick cost", async () => {
  await settle();

  // THE CONTROL, AND WHY IT IS HERE. The claim is "placing a chest moves nothing", and the old form
  // asserted it as an identity on the world's TOTAL ticker count. On an established world that
  // number drifts on its own — this case went red at `1212 !== 1213`, one ticker FEWER with a chest
  // placed, which is not a direction the chest could even have caused. `settle()` narrows the window
  // and cannot close it: it waits for two equal reads, and a mob spawner three million blocks away
  // is free to disagree a second later.
  //
  // So the boring case is measured instead of assumed: two reads, the same spacing, NOTHING placed
  // between them. If they disagree the world is moving under the test and the identity below is not
  // the tool's claim to answer for; the type census still is, and it is exact either way.
  const base = overworldOf(ok(await call("get_perf", { top: TOP }), "baseline"));
  await new Promise((r) => setTimeout(r, 400));
  const control = overworldOf(ok(await call("get_perf", { top: TOP }), "control"));
  const quiet = control.block_entity_tickers === base.block_entity_tickers;

  ok(await call("set_blocks", { blocks: [{ ...SITE, block: "minecraft:chest" }] }), "place chest");
  await new Promise((r) => setTimeout(r, 400));
  const withChest = overworldOf(ok(await call("get_perf", { top: TOP }), "with chest"));
  if (quiet && withChest.block_entity_tickers === control.block_entity_tickers) {
    // The identity held: the boring case was boring.
  } else if (quiet && withChest.block_entity_tickers < control.block_entity_tickers) {
    // A DROP is a direction a placed chest cannot cause: the world moved under the test between
    // the control read and this one (1344 -> 1343 on the 0.124.0 battery, two equal control reads
    // before it). The chest's own claim is the type census below; say the drift out loud.
    console.log(`# note: world moved between control and read (${control.block_entity_tickers} -> ` +
      `${withChest.block_entity_tickers}, a drop, which a chest cannot cause); the total-count ` +
      "identity is not asserted this run, the type census below still is");
  } else if (quiet) {
    assert.equal(withChest.block_entity_tickers, control.block_entity_tickers,
      "a chest has no server ticker, so it must not appear in a tick-cost census");
  } else {
    // Said out loud rather than skipped silently: a case that stops asserting has to report that it
    // did, or a green run means two different things.
    console.log(`# note: world not quiet (${base.block_entity_tickers} -> ` +
      `${control.block_entity_tickers} with nothing placed); the total-count identity is not ` +
      "asserted this run, the type census below still is");
  }
  // The claim the tool actually makes, and it is drift-proof: `countOf` returns 0 only when the
  // census is COMPLETE, so "chest is absent" cannot be a top-N cutoff in disguise.
  assert.equal(countOf(withChest, "minecraft:chest", "with chest"), 0,
    "a chest is not a ticker, so it must not be named in a tick-cost type census");
  ok(await call("set_blocks", { blocks: [{ ...SITE, block: "minecraft:air" }] }), "remove chest");
});


test("a dimension this server does not have is refused, and the refusal lists the ones it has", async () => {
  const r = await call("get_perf", { dimension: "mymod:not_a_dimension" });
  assert.equal(r.ok, false, "an unknown dimension must not answer with an empty level list");
  assert.match(r.error, /minecraft:overworld/, `the refusal should say what exists: ${r.error}`);
});

test("dimension filters, and the bare name works as well as the id", async () => {
  const full = ok(await call("get_perf"), "all levels");
  assert.ok(full.levels.length >= 1, "a running server has at least one level");
  const one = ok(await call("get_perf", { dimension: OVERWORLD }), "filtered");
  assert.equal(one.levels.length, 1, "a filter that filters nothing is not a filter");
  assert.equal(one.levels[0].dimension, OVERWORLD);
  const bare = ok(await call("get_perf", { dimension: "overworld" }), "bare name");
  assert.equal(bare.levels[0].dimension, OVERWORLD, "the bare name resolves to the vanilla id");
});

test("hooks:true accounts for the instrument itself", async () => {
  const off = ok(await call("get_perf"), "hooks off");
  assert.equal(off.toolkit_hooks, undefined, "the hook dump is opt-in — it is not free to serialise");
  const on = ok(await call("get_perf", { hooks: true }), "hooks on");
  assert.ok(on.toolkit_hooks, "no toolkit_hooks block");
  assert.ok(on.toolkit_hooks.end_server_tick, "the tick hook is the one that costs; it must be there");
  const listeners = Object.values(on.toolkit_hooks.end_server_tick);
  assert.ok(listeners.length > 0, "the toolkit registers tick listeners; none were reported");
  assert.ok(listeners.every((l) => typeof l.calls === "number" && l.calls > 0),
    "a listener that has never been called on a running server is a lie about the hook");
});

test("an argument get_perf does not have is refused, not dropped", async () => {
  const r = await call("get_perf", { ticks: 20 });
  assert.equal(r.ok, false, "unknown argument must be refused (ArgCheck)");
  assert.match(r.error, /ticks/, `the refusal should name the argument: ${r.error}`);
});

test("there is no profile mode, and asking for one is refused rather than ignored", async () => {
  // The first build had `profile_ticks` and it returned an empty tree every time: in 26.2
  // MinecraftServer.TimeProfiler.stop() hands back a ProfileResults whose getTimes() is
  // Collections.emptyList() unconditionally — /debug start…stop measures duration and tick count,
  // not a tree. The mode was cut rather than shipped empty; this case is the fossil, so that a
  // future re-add is a deliberate act and not a silent one.
  const r = await call("get_perf", { profile_ticks: 20 });
  assert.equal(r.ok, false, "profile_ticks is not an argument of this tool");
  assert.match(r.error, /profile_ticks/, `the refusal should name it: ${r.error}`);
});
