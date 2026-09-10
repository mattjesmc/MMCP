// Task frames (MEMORY_DESIGN.md §Session charter, "tasks.json — per-session goal / working state"):
// every session opens knowing what it is in the middle of. Working state, not history — the durable
// outcome of a finished task belongs in mem_note/mem_write_block, and clearing never touches records.
// Concurrency upgrade: tasks.json holds one frame per session ({v, frames}); the pre-concurrency
// single `current` reads as frame "legacy". Cross-session independence lives in concurrency.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MemoryStore } from "../store.mjs";
import { makeStore, records, WORLD, SESSION } from "./helpers.mjs";

test("task lifecycle: set → renders, update revises state, clear empties the frame", async () => {
  const { root, store } = await makeStore();

  // No task yet: the render says so explicitly (knowing there is no goal is also orientation).
  assert.ok((await store.recent({})).render.includes("[task] none"));

  const { task, replaced } = await store.setTask({
    goal: "build workshop at ravine-west site", state: "clearing the ledge", tick: 5000, session: SESSION,
  });
  assert.equal(replaced, null);
  assert.equal(task.started_tick, 5000);

  const r1 = await store.recent({ session: SESSION });
  // Frames render labeled with their session key and wall-clock updated-age.
  assert.ok(r1.render.includes(`[task ${SESSION}] build workshop at ravine-west site — clearing the ledge (updated `));
  assert.equal(r1.task.goal, "build workshop at ravine-west site");
  assert.equal(r1.frames[SESSION].goal, "build workshop at ravine-west site");
  // Render order: the task line sits between frontier blocks and the verbatim tail.
  assert.ok(r1.render.indexOf("[task ") < r1.render.indexOf("--- recent entries"));

  const updated = await store.updateTask({ state: "walls up; roof pending", tick: 6000, session: SESSION });
  assert.equal(updated.goal, "build workshop at ravine-west site"); // update never rewrites the goal
  assert.equal(updated.started_tick, 5000);
  assert.equal(updated.updated_tick, 6000);
  assert.ok((await store.recent({})).render.includes("walls up; roof pending"));

  const closed = await store.clearTask({ tick: 7000, session: SESSION });
  assert.equal(closed.goal, "build workshop at ravine-west site");
  assert.equal(store.tasks[SESSION], undefined);
  assert.ok((await store.recent({})).render.includes("[task] none"));

  // The frame is NOT memory: no entries/blocks/relations were written by any of the above.
  assert.equal((await records(root, "log.jsonl")).length, 0);
  assert.equal((await records(root, "relations.jsonl")).length, 0);
});

test("task frame survives a cold reopen; replacing a live task returns it", async () => {
  const { root, store } = await makeStore();
  await store.setTask({ goal: "map the river valley", tick: 100, session: SESSION });

  const store2 = await new MemoryStore(root, WORLD).open();
  assert.equal(store2.tasks[SESSION].goal, "map the river valley");
  assert.equal(store2.tasks[SESSION].started_tick, 100);

  // Replacement hands back the old task so it is never silently lost.
  const { replaced } = await store2.setTask({ goal: "flee the raid", tick: 200, session: SESSION });
  assert.equal(replaced.goal, "map the river valley");

  // File shape: {v, frames} keyed by session, in the per-world dir (cross-world isolation comes free).
  const file = JSON.parse(await readFile(join(root, WORLD.world_uuid, "tasks.json"), "utf8"));
  assert.equal(file.v, 1);
  assert.equal(file.frames[SESSION].goal, "flee the raid");

  // Guards: update/clear without a task, set without a goal, ops without a session.
  await store2.clearTask({ session: SESSION });
  await assert.rejects(() => store2.updateTask({ state: "x", session: SESSION }), /no current task/);
  await assert.rejects(() => store2.clearTask({ session: SESSION }), /no current task/);
  await assert.rejects(() => store2.setTask({ goal: "  ", session: SESSION }), /goal/);
  await assert.rejects(() => store2.setTask({ goal: "x" }), /session/);
  await assert.rejects(() => store2.clearTask({}), /session/);
});
