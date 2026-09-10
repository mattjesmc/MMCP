// Probe 5 — partial verification (MEMORY_DESIGN.md §Evaluation). One episode holds several
// independent facts; re-verifying one must NOT refresh the others. Freshness attaches to the
// smallest stable subject, never the block. This is the regression test for revision-2 issue 2.

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeStore, records, obs, SESSION } from "./helpers.mjs";

test("probe 5: verifying one fact leaves its episode-mates stale", async () => {
  const { root, store } = await makeStore();

  const village = await store.place({ category: "village", pos: [-120, 64, 300], name: "oak village", tick: 1000 });
  const chest = await store.place({ category: "storage", pos: [-138, 64, 306], name: "workshop chest", tick: 1200 });
  const bridge = await store.place({ category: "structure", pos: [-180, 66, 320], name: "river bridge", tick: 1400 });

  const entries = [];
  entries.push(await obs(store, "Oak village intact, golem present.", [-120, 64, 300], 1000, { refs: { places: [village.id] } }));
  entries.push(await obs(store, "Workshop chest stocked with tools.", [-138, 64, 306], 1200, { refs: { places: [chest.id] } }));
  entries.push(await obs(store, "River bridge half-built, three planks short.", [-180, 66, 320], 1400, { refs: { places: [bridge.id] } }));

  await store.writeBlock({
    links: { entries: entries.map((e) => e.id) },
    activity: "exploration",
    outcome: "Toured the settlement and its worksites.",
    prose: "Checked the village, the workshop stores, and the unfinished bridge.",
    pois: [village.id, chest.id, bridge.id],
  });

  // Much later: revisit the village only.
  await store.verify({ targetType: "place", targetId: village.id, result: "confirmed", tick: 94000 });

  // The verification relation is per-subject in the files — no block-level freshness anywhere.
  const rels = (await records(root, "relations.jsonl")).filter((r) => r.kind === "verification");
  assert.equal(rels.length, 1);
  assert.equal(rels[0].target_id, village.id);
  const blocks = await records(root, "blocks.jsonl");
  assert.ok(blocks.every((b) => !("last_verified_tick" in b)), "blocks must not carry freshness");

  // Recall over the area: village fresh, chest and bridge explicitly stale. The place RECORD carries
  // the freshness; records that merely reference a place (entries) must not inherit it.
  const { results } = await store.recall({ center: [-150, 64, 310], radius: 128 });
  const byId = (id) => results.find((r) => r.id === id);

  const v = byId(village.id);
  assert.ok(v, "village place record must be in the recall results");
  assert.equal(v.verification?.result, "confirmed");
  assert.equal(v.verification?.tick, 94000);

  const referencingEntry = results.find((r) => (r.refs?.places ?? []).includes(village.id));
  assert.ok(referencingEntry, "the entry referencing the village must also surface");
  assert.equal(referencingEntry.verification ?? null, null,
    "verification is per-subject: a record referencing the place must not inherit the place's freshness");

  for (const [label, id] of [["chest", chest.id], ["bridge", bridge.id]]) {
    const r = byId(id);
    assert.ok(r, `${label} place record must be in the recall results`);
    assert.equal(r.verification ?? null, null, `${label} must NOT inherit the village's verification`);
  }
});
