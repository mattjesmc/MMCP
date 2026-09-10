// Probe 6 — contradiction (MEMORY_DESIGN.md §Evaluation). An outdated belief must remain reachable
// as what-was-believed, render clearly as contradicted, and never be presented as current. History
// is not rewritten: the old record stands; the verification relation dates the change.

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeStore, records, obs } from "./helpers.mjs";

test("probe 6: contradicted belief renders as history, not as current state", async () => {
  const { root, store } = await makeStore();

  const old = await obs(store, "River bridge at (-180,66,320) is unfinished — three planks short.", [-180, 66, 320], 2000);

  // Later visit: the bridge is done. New observation + explicit contradiction of the old entry.
  const now = await obs(store, "River bridge at (-180,66,320) completed and walkable.", [-180, 66, 320], 90000);
  await store.verify({ targetType: "entry", targetId: old.id, result: "contradicted", tick: 90000, note: "bridge is finished now" });

  const { results, render } = await store.recall({ query: "bridge" });

  // Both beliefs are reachable.
  const oldHit = results.find((r) => r.id === old.id);
  const nowHit = results.find((r) => r.id === now.id);
  assert.ok(oldHit, "the outdated belief must remain reachable");
  assert.ok(nowHit, "the current observation must be retrieved");

  // The old belief is explicitly marked contradicted — in the structured result and in the render.
  assert.equal(oldHit.verification?.result, "contradicted");
  assert.equal(oldHit.verification?.tick, 90000);
  assert.equal(nowHit.verification ?? null, null, "the current observation carries no stale marker");
  const oldLine = render.split("\n").find((l) => l.includes(old.id));
  assert.ok(oldLine.includes("contradicted"), "render must mark the outdated line as contradicted");
  const nowLine = render.split("\n").find((l) => l.includes(now.id));
  assert.ok(!nowLine.includes("contradicted"), "the current line must not be marked contradicted");

  // History is append-only: the contradicted entry was not rewritten.
  const logged = await records(root, "log.jsonl");
  assert.deepEqual(logged.find((r) => r.id === old.id), old, "contradiction must not rewrite the old record");
});
