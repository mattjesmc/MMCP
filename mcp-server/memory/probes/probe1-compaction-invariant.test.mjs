// Probe 1 — compaction invariant (MEMORY_DESIGN.md §Evaluation). Scripted, no LLM judge.
// After compaction: every compacted entry lies within its block's bounds; every entry belongs to at
// most one compaction relation; already-compacted records are ineligible for a second block; a cold
// rebuild from the JSONL files yields the same derived state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../store.mjs";
import { validateBlock, validateRelation } from "../schema.mjs";
import { makeStore, records, obs, WORLD } from "./helpers.mjs";

test("probe 1: compaction invariant", async () => {
  const { root, store } = await makeStore();

  const e1 = await obs(store, "Village well at (-120,64,300).", [-120, 64, 300], 1000);
  const e2 = await obs(store, "Ravine mouth at (-210,58,290).", [-210, 58, 290], 1400);
  const e3 = await obs(store, "Camped on the hill at (-150,72,310).", [-150, 72, 310], 2000);
  const later = await obs(store, "Unrelated: back at spawn (0,64,0).", [0, 64, 0], 9000);

  const block = await store.writeBlock({
    links: { entries: [e1.id, e2.id, e3.id] },
    activity: "exploration",
    outcome: "Scouted the west valley.",
    prose: "Explored westward from the village to the ravine and camped on the hill.",
    pois: [],
  });

  // The persisted block is schema-valid and its DERIVED header covers the linked entries.
  assert.deepEqual(validateBlock(block), []);
  for (const e of [e1, e2, e3]) {
    for (let axis = 0; axis < 3; axis++) {
      assert.ok(block.bounds[0][axis] <= e.pos[axis] && e.pos[axis] <= block.bounds[1][axis],
        `entry ${e.id} axis ${axis} outside derived bounds`);
    }
    assert.ok(block.tick_range[0] <= e.tick && e.tick <= block.tick_range[1]);
  }
  assert.ok(!(block.tick_range[0] <= later.tick && later.tick <= block.tick_range[1]) || true,
    "unlinked entries place no constraint on the range");

  // Files: block + exactly one compaction relation naming exactly the linked entries.
  const rels = (await records(root, "relations.jsonl")).filter((r) => r.kind === "compaction");
  assert.equal(rels.length, 1);
  assert.deepEqual(validateRelation(rels[0]), []);
  assert.equal(rels[0].block, block.id);
  assert.deepEqual([...rels[0].entries].sort(), [e1.id, e2.id, e3.id].sort());

  // Every entry is in at most one compaction: recompacting any of them must be rejected.
  await assert.rejects(
    store.writeBlock({
      links: { entries: [e1.id, later.id] },
      activity: "exploration",
      outcome: "x",
      prose: "x",
      pois: [],
    }),
    /compacted|frontier|eligib/i,
    "an already-compacted entry must be ineligible for a second block");

  // Records are immutable: the log file still holds the original entries, unmodified.
  const logged = await records(root, "log.jsonl");
  assert.deepEqual(logged.find((r) => r.id === e1.id), e1, "compaction must not rewrite log records");

  // Cold rebuild: a fresh store over the same files derives the same state.
  const store2 = new MemoryStore(root, WORLD);
  await store2.open();
  const a = await store.read({ ids: [block.id, e1.id, later.id] });
  const b = await store2.read({ ids: [block.id, e1.id, later.id] });
  assert.deepEqual(b, a, "derived state must survive a cold rebuild from the JSONL files");
});
