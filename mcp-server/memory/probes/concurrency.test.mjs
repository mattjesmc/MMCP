// Cross-process safety: every Claude session runs its own shim process, each with a MemoryStore over
// the SAME per-world dir. Two instances over one dir simulate that here. The invariants: no duplicate
// ids across writers, no lost updates in the mutable files (tasks.json / pending.json), reads that see
// what other writers wrote, and per-session task frames that cannot clobber each other.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MemoryStore } from "../store.mjs";
import { makeStore, records, WORLD, SESSION } from "./helpers.mjs";

const S1 = "s-alpha";
const S2 = "s-beta";

test("two instances over one dir never allocate the same entry/block id", async () => {
  const { root, store: a } = await makeStore();
  const b = await new MemoryStore(root, WORLD).open();

  // Interleaved writers: each allocates ids without seeing the other's in-process index.
  await a.note({ kind: "obs", text: "a first", pos: [0, 64, 0], tick: 10, session: S1 });
  await b.note({ kind: "obs", text: "b first", pos: [1, 64, 0], tick: 11, session: S2 });
  await a.note({ kind: "obs", text: "a second", pos: [2, 64, 0], tick: 12, session: S1 });
  // Parallel writers: the lock serializes the resync-allocate-append cycle.
  await Promise.all([
    b.note({ kind: "obs", text: "b parallel", pos: [3, 64, 0], tick: 13, session: S2 }),
    a.note({ kind: "obs", text: "a parallel", pos: [4, 64, 0], tick: 14, session: S1 }),
  ]);

  const log = await records(root, "log.jsonl");
  assert.equal(log.length, 5);
  assert.equal(new Set(log.map((r) => r.id)).size, 5, `duplicate ids in ${log.map((r) => r.id)}`);

  // Each instance sees the other's entries by its next locked pass (any write or read refreshes).
  await a.read({ ids: [] });
  await b.read({ ids: [] });
  assert.equal(a.entries.size, 5);
  assert.equal(b.entries.size, 5);
  assert.ok((await b.recall({ query: "second" })).results.some((r) => r.text === "a second"));

  // Block ids share the scheme: both instances compact without colliding.
  const ids = [...a.entries.keys()].sort();
  const ba = await a.writeBlock({
    links: { entries: ids.slice(0, 2) },
    activity: "survey", outcome: "west pair noted", prose: "Two observations west.",
  });
  const bb = await b.writeBlock({
    links: { entries: ids.slice(2, 4) },
    activity: "survey", outcome: "east pair noted", prose: "Two observations east.",
  });
  assert.notEqual(ba.id, bb.id);
  const blocks = await records(root, "blocks.jsonl");
  assert.equal(new Set(blocks.map((r) => r.id)).size, blocks.length);
});

test("task frames: per-session independence, both rendered, stale frames tagged", async () => {
  const { root, store: a } = await makeStore();
  const b = await new MemoryStore(root, WORLD).open();

  await a.setTask({ goal: "mine the ravine", state: "at y=12", tick: 100, session: S1 });
  await b.setTask({ goal: "roof the barn", tick: 200, session: S2 });

  // Neither write clobbered the other (tasks.json is read-modify-write under the lock).
  const file = JSON.parse(await readFile(join(root, WORLD.world_uuid, "tasks.json"), "utf8"));
  assert.equal(file.frames[S1].goal, "mine the ravine");
  assert.equal(file.frames[S2].goal, "roof the barn");

  // The render shows ALL live frames, each labeled with its session key.
  const r = await a.recent({ session: S1 });
  assert.ok(r.render.includes(`[task ${S1}] mine the ravine — at y=12 (updated `));
  assert.ok(r.render.includes(`[task ${S2}] roof the barn (updated `));
  assert.equal(r.task.goal, "mine the ravine"); // own frame, not the other session's
  assert.equal((await b.recent({ session: S2 })).task.goal, "roof the barn");

  // update/clear operate on the caller's own frame only.
  await a.updateTask({ state: "branch two", session: S1 });
  await b.clearTask({ session: S2 });
  const after = JSON.parse(await readFile(join(root, WORLD.world_uuid, "tasks.json"), "utf8"));
  assert.equal(after.frames[S1].state, "branch two");
  assert.equal(after.frames[S2], undefined);

  // A frame not updated for >24h renders with the stale tag; fresh frames stay untagged.
  const old = new Date(Date.now() - 72 * 3600_000).toISOString();
  after.frames["s-ghost"] = { v: 1, goal: "abandoned goal", state: null, session: "s-ghost", started_t: old, started_tick: 1, updated_t: old, updated_tick: 1 };
  await writeFile(join(root, WORLD.world_uuid, "tasks.json"), JSON.stringify(after), "utf8");
  const r2 = await a.recent({});
  assert.ok(r2.render.includes(`[task s-ghost] abandoned goal (updated 3d ago) (stale — clear or update)`));
  const s1Line = r2.render.split("\n").find((l) => l.startsWith(`[task ${S1}]`));
  assert.ok(s1Line && !s1Line.includes("stale"), "fresh frames are not tagged stale");
});

test("legacy migration: {current} reads as frame 'legacy'; first set adopts it as the replaced task", async () => {
  const { root } = await makeStore();
  const dir = join(root, WORLD.world_uuid);
  const legacyTask = {
    v: 1, goal: "pre-upgrade goal", state: "old state", session: "s-old",
    started_t: "2026-07-01T00:00:00Z", started_tick: 1, updated_t: "2026-07-01T00:00:00Z", updated_tick: 1,
  };
  await writeFile(join(dir, "tasks.json"), JSON.stringify({ v: 1, current: legacyTask }), "utf8");

  // Reads handle the old shape: the frame renders under the "legacy" key.
  const reopened = await new MemoryStore(root, WORLD).open();
  assert.equal(reopened.tasks.legacy.goal, "pre-upgrade goal");
  assert.ok((await reopened.recent({})).render.includes("[task legacy] pre-upgrade goal — old state"));

  // update falls back to the legacy frame (a live pre-upgrade goal is not stranded)…
  const upd = await reopened.updateTask({ state: "still going", session: SESSION });
  assert.equal(upd.goal, "pre-upgrade goal");

  // …and the first set displaces it: returned as `replaced` (never silently lost), file migrated to frames-only.
  const { replaced } = await reopened.setTask({ goal: "post-upgrade goal", tick: 50, session: SESSION });
  assert.equal(replaced.goal, "pre-upgrade goal");
  const file = JSON.parse(await readFile(join(dir, "tasks.json"), "utf8"));
  assert.equal(file.current, undefined);
  assert.equal(file.frames.legacy, undefined);
  assert.equal(file.frames[SESSION].goal, "post-upgrade goal");
});

test("pending: cursor merges advance-only; acks and dismissals from one process stick in the other", async () => {
  const { root, store: a } = await makeStore();
  const b = await new MemoryStore(root, WORLD).open();

  await a.updatePending(10, [
    { event_id: 1, game_tick: 100, rule: "world_edit", summary: "edit one", t: "2026-07-21T10:00:00Z" },
    { event_id: 2, game_tick: 101, rule: "action_outcome", summary: "goto FAILED", t: "2026-07-21T10:00:01Z" },
  ]);

  // b (opened before a's update) raced the same classification from a stale cursor. Its merge must
  // not regress the cursor, and its stale candidates (ids at or below the cursor already on disk)
  // are DROPPED, not unioned: classification is deterministic, so the process that advanced the
  // cursor already contributed them — and re-adding would resurrect any the agent dismissed in the
  // gap (the cursor is the tombstone; the queue has none of its own).
  await b.updatePending(5, [{ event_id: 3, game_tick: 102, rule: "drone_lost", summary: "drone died", t: "2026-07-21T10:00:02Z" }]);
  assert.equal(b.eventCursor, 10, "cursor is advance-only — 5 must not regress it");
  assert.deepEqual(b.pending.map((c) => c.event_id).sort(), [1, 2], "stale candidate 3 must not union in");

  // Fresh work beyond the disk cursor still enqueues from either process.
  await b.updatePending(12, [{ event_id: 11, game_tick: 103, rule: "drone_lost", summary: "drone died", t: "2026-07-21T10:00:03Z" }]);
  assert.deepEqual(b.pending.map((c) => c.event_id).sort((x, y) => x - y), [1, 2, 11]);

  // a dismisses in its process; b's next locked pass adopts the dismissal (no resurrection).
  assert.equal(await a.dismissPending([], "action_outcome"), 1);
  assert.equal(await b.dismissPending([11]), 1);
  const p = JSON.parse(await readFile(join(root, WORLD.world_uuid, "pending.json"), "utf8"));
  assert.deepEqual(p.candidates.map((c) => c.event_id), [1]);
  assert.equal(p.cursor, 12);

  // An ack written by b is visible to a's read path.
  await b.note({ kind: "outcome", text: "edit one described", pos: [0, 64, 0], tick: 103, session: S2, refs: { events: [1] } });
  assert.deepEqual((await a.recent({})).pending, []);
});

test("stale lock is broken; a held lock fails loudly after the wait cap", async () => {
  const { root, store } = await makeStore();
  const lockDir = join(root, WORLD.world_uuid, "lock");

  // A crashed process's lock (mtime older than 30s) must not wedge the store forever.
  await mkdir(lockDir);
  const old = (Date.now() - 60_000) / 1000;
  await utimes(lockDir, old, old);
  const rec = await store.note({ kind: "note", text: "wrote through a stale lock", tick: 1, session: SESSION });
  assert.ok(rec.id);

  // A live (fresh) lock makes writers spin, then throw an actionable error — never hang or corrupt.
  await mkdir(lockDir);
  const t0 = Date.now();
  await assert.rejects(
    () => store.note({ kind: "note", text: "blocked", tick: 2, session: SESSION }),
    /memory lock busy/);
  assert.ok(Date.now() - t0 >= 1500, "waited for the cap before giving up");
  await rm(lockDir, { recursive: true, force: true });
});
