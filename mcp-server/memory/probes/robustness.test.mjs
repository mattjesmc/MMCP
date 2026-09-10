// Durability + gap-surfacing fixes (TODO batch 2026-07-23): mutable JSON files are written
// tmp+rename so a crash mid-write can never leave torn JSON that bricks every later mem_* call;
// a >ring-capacity event burst surfaces as an explicit event_gap candidate instead of vanishing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic } from "../store.mjs";
import { refreshPending } from "../tools.mjs";
import { makeStore, WORLD, SESSION } from "./helpers.mjs";

test("writeJsonAtomic replaces an existing file and leaves no tmp behind", async () => {
  const { root } = await makeStore();
  const path = join(root, "atomic-probe.json");
  await writeJsonAtomic(path, { generation: 1 });
  await writeJsonAtomic(path, { generation: 2 }); // rename must overwrite, also on Windows
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { generation: 2 });
  assert.deepEqual((await readdir(root)).filter((f) => f.endsWith(".tmp")), []);
});

test("mutable files stay parseable and tmp-free through the normal write paths", async () => {
  const { root, store } = await makeStore();
  const dir = join(root, WORLD.world_uuid);
  await store.note({ kind: "obs", text: "durability probe", pos: [0, 64, 0], tick: 10, session: SESSION });
  await store.setTask({ goal: "durability", tick: 11, session: SESSION });
  await store.updatePending(5, [{ event_id: 3, game_tick: 12, rule: "world_edit", summary: "x", t: "2026-07-23T10:00:00Z" }]);
  for (const file of ["meta.json", "tasks.json", "pending.json"]) {
    JSON.parse(await readFile(join(dir, file), "utf8")); // parseable = not torn
  }
  assert.deepEqual((await readdir(dir)).filter((f) => f.endsWith(".tmp")), []);
});

test("a missed burst surfaces as an event_gap pending candidate, once", async () => {
  const { store } = await makeStore();
  await store.updatePending(50, []); // established cursor: not first contact

  // The ring evicted ids 51–204; the poll returns only id 205 with missed=154.
  const poll = {
    ok: true,
    result: {
      cursor: 205, more: false, missed: 154,
      events: [{ id: 205, game_tick: 9000, type: "action_failed", data: { action: "goto", reason: "no path" } }],
    },
  };
  await refreshPending(store, async () => poll);

  const gap = store.pending.find((c) => c.rule === "event_gap");
  assert.ok(gap, "the evicted span must surface as its own candidate");
  assert.equal(gap.event_id, 51);
  assert.equal(gap.game_tick, 9000);
  assert.match(gap.summary, /154 event\(s\) \(ids 51–204\)/);
  assert.ok(store.pending.some((c) => c.rule === "action_outcome"), "returned events still classify normally");

  // The next quiet poll must not mint a second gap (cursor advanced past it; missed is 0 now).
  await refreshPending(store, async () => ({ ok: true, result: { cursor: 205, more: false, missed: 0, events: [] } }));
  assert.equal(store.pending.filter((c) => c.rule === "event_gap").length, 1);

  // It is dismissable by rule like any other candidate.
  assert.equal(await store.dismissPending([], "event_gap"), 1);
});
