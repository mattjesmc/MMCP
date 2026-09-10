// Event-cursor lifecycle across game restarts and concurrent sessions.
//
// The mod's event ids are an in-memory counter that restarts at 1 every JVM launch, while
// pending.json persists its cursor forever with an advance-only merge. Two defects lived in that
// seam (2026-07-22 review):
//   1. After a restart the stored cursor exceeds every live id, get_events returns "nothing new"
//      forever, and the pending surface dies silently. resetEventCursor is the one sanctioned
//      backwards move, taken when the bridge reports cursor_reset.
//   2. A slower concurrent session's updatePending could re-add a candidate another session had
//      already classified and dismissed — the cursor already on disk IS the tombstone, so incoming
//      candidates at or below it must be dropped.

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeStore } from "./helpers.mjs";
import { MemoryStore } from "../store.mjs";

const cand = (id, summary = `event ${id}`) => ({
  event_id: id, game_tick: id * 100, rule: "world_edit", summary, t: "2026-07-22T12:00:00Z",
});

test("resetEventCursor: the sanctioned backwards move survives the advance-only merge", async () => {
  const { root, store } = await makeStore();
  await store.updatePending(8341, []); // cursor from a long-running previous launch
  assert.equal(store.eventCursor, 8341);

  // Ordinary updatePending must NOT move it backwards (that guarantee stays).
  await store.updatePending(12, []);
  assert.equal(store.eventCursor, 8341);

  // The reset does, and it persists: a cold rebuild reads the reset cursor back.
  await store.resetEventCursor(0);
  assert.equal(store.eventCursor, 0);
  const store2 = await new MemoryStore(root, store.worldInfo).open();
  assert.equal(store2.eventCursor, 0);

  // After the reset, this launch's small ids classify normally again.
  await store2.updatePending(30, [cand(5)]);
  assert.deepEqual(store2.pending.map((c) => c.event_id), [5]);
  assert.equal(store2.eventCursor, 30);
});

test("updatePending: candidates at or below the on-disk cursor stay dead (no resurrection)", async () => {
  const { root, store } = await makeStore();

  // Session B classified events up to 120, the agent dismissed candidate 110.
  await store.updatePending(120, [cand(110)]);
  assert.equal(await store.dismissPending([110]), 1);

  // Session A raced the same batch from cursor 100 and lands its merge late: same candidate,
  // cursor no further than what disk already has. The dismissal must stick.
  const late = await new MemoryStore(root, store.worldInfo).open();
  await late.updatePending(120, [cand(110)]);
  assert.deepEqual(late.pending, [], "a dismissed candidate must not be resurrected by a late merge");

  // Genuinely new work is unaffected: ids beyond the disk cursor still enqueue.
  await late.updatePending(140, [cand(130)]);
  assert.deepEqual(late.pending.map((c) => c.event_id), [130]);
});
