// mem_locate: concept in, locations out — the reverse of mem_recall's center+radius filter
// (REPRESENTATION_DESIGN.md §3). Plus the two recall fixes that gated it: the structured results
// cap and the tick_range place fallback. Invariants:
//
//   1. a unique concept returns its cluster: centroid/spread over the evidence, places with
//      verification state surfaced.
//   2. two "farms" in different regions are two clusters; different DIMENSIONS are never merged
//      into one centroid (a nether farm and an overworld farm are two answers).
//   3. an absent concept says absent — found:false, no nearest-match guessing.
//   4. matches without positions cannot locate and say so.
//   5. notes alone can answer when no place was promoted (evidence-only cluster).
//   6. the render respects budget_tokens.
//   7. recall: structured-only results are capped (the render was budgeted, the payload was not);
//      tick_range no longer silently excludes places (discovered_tick is their timestamp).

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeStore, obs } from "./helpers.mjs";

test("unique concept: one cluster, centroid over evidence, staleness surfaced", async () => {
  const { store } = await makeStore();
  const farm = await store.place({ category: "farm", pos: [100, 64, 100], name: "wheat farm", tick: 1000 });
  await obs(store, "harvested 40 wheat at the wheat farm", [104, 64, 96], 1100);
  await store.place({ category: "village", pos: [140, 64, 80], name: "oak village", tick: 900 });

  const r = await store.locate({ concept: "wheat farm" });
  assert.equal(r.found, true);
  assert.equal(r.clusters.length, 1, JSON.stringify(r.clusters));
  const c = r.clusters[0];
  assert.equal(c.places.length, 1);
  assert.equal(c.places[0].id, farm.id);
  assert.equal(c.places[0].verification, null);
  assert.equal(c.evidence.entries, 1);
  // Centroid of (100,64,100) and (104,64,96) = (102,64,98); spread ≈ 2.83 → 3.
  assert.deepEqual(c.centroid, [102, 64, 98]);
  assert.ok(c.spread >= 2 && c.spread <= 3, `spread ${c.spread}`);
  assert.match(r.render, /not verified since recorded/);
  assert.match(r.render, /re-read them in the world before relying/, "unverified places must still trigger the re-check recommendation — mem_verify the TOOL is gone, the signal is not");

  await store.verify({ targetType: "place", targetId: farm.id, result: "confirmed", tick: 2000 });
  const fresh = await store.locate({ concept: "wheat farm" });
  assert.equal(fresh.clusters[0].places[0].verification.result, "confirmed");
  assert.doesNotMatch(fresh.render, /before relying on them/);
});

test("multi-cluster: regions split, dimensions never merge", async () => {
  const { store } = await makeStore();
  await store.place({ category: "farm", pos: [100, 64, 100], name: "north farm", tick: 1000 });
  await store.place({ category: "farm", pos: [10000, 64, 10000], name: "far farm", tick: 1100 });
  await store.place({ category: "farm", pos: [120, 64, 90], name: "gold farm", tick: 1200, dim: "minecraft:the_nether" });

  const r = await store.locate({ concept: "farm" });
  assert.equal(r.found, true);
  assert.equal(r.clusters.length, 3, `regions and dims must not merge: ${JSON.stringify(r.clusters.map((c) => [c.dim, c.region]))}`);
  const dims = new Set(r.clusters.map((c) => c.dim));
  assert.ok(dims.has("minecraft:the_nether"));
  // No cluster averages across 9900 blocks: every centroid sits near its own members.
  for (const c of r.clusters) assert.ok(c.spread < 100, `cluster ${c.region} spread ${c.spread}`);
});

test("absent concept says absent; positionless matches say unlocatable", async () => {
  const { store } = await makeStore();
  await store.place({ category: "farm", pos: [100, 64, 100], name: "wheat farm", tick: 1000 });
  const r = await store.locate({ concept: "stronghold" });
  assert.equal(r.found, false);
  assert.equal(r.clusters.length, 0);
  assert.match(r.render, /absent/i);

  await store.note({ kind: "note", text: "should find a stronghold eventually", pos: null, tick: 1100, session: "s-probe" });
  const r2 = await store.locate({ concept: "stronghold" });
  assert.equal(r2.found, false);
  assert.match(r2.render, /no.*position|carry no position/i);
});

test("notes alone locate when no place was promoted", async () => {
  const { store } = await makeStore();
  await obs(store, "big lava lake here", [500, 40, -200], 1000);
  await obs(store, "lava lake edge, watch the drop", [510, 40, -190], 1010);
  const r = await store.locate({ concept: "lava lake" });
  assert.equal(r.found, true);
  assert.equal(r.clusters.length, 1);
  assert.equal(r.clusters[0].places.length, 0);
  assert.equal(r.clusters[0].evidence.entries, 2);
  assert.deepEqual(r.clusters[0].centroid, [505, 40, -195]);
});

test("render respects budget_tokens", async () => {
  const { store } = await makeStore();
  for (let i = 0; i < 12; i++) {
    await store.place({
      category: "farm", pos: [i * 3000, 64, 0], name: `farm number ${i}`, tick: 1000 + i,
    });
  }
  const r = await store.locate({ concept: "farm", budgetTokens: 60 });
  assert.equal(r.found, true);
  assert.match(r.render, /omitted for budget/);
  assert.equal(r.clusters.length, 12, "structured clusters stay complete; only the render trims");
});

test("recall: structured-only results are capped, and the cap is announced", async () => {
  const { store } = await makeStore();
  for (let i = 0; i < 120; i++) {
    await obs(store, `marker ${i}`, [i, 64, 0], 1000 + i);
  }
  const r = await store.recall({});
  assert.equal(r.results.length, 100, "structured-only recall must not return the whole store");
  assert.equal(r.results_truncated, 20);
  assert.match(r.render, /capped at 100 of 120/);

  const q = await store.recall({ query: "marker 5" });
  assert.ok(q.results.length <= 100);
});

test("recall: tick_range includes places via discovered_tick", async () => {
  const { store } = await makeStore();
  await store.place({ category: "village", pos: [0, 64, 0], name: "early village", tick: 1000 });
  await store.place({ category: "village", pos: [900, 64, 0], name: "late village", tick: 9000 });
  const r = await store.recall({ tickRange: [500, 2000] });
  const names = r.results.filter((x) => x.category).map((x) => x.name);
  assert.deepEqual(names, ["early village"], `places must respect tick_range via discovered_tick: ${JSON.stringify(names)}`);
});
