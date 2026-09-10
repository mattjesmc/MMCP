// Probe 3 — cross-world isolation + rollback detection (MEMORY_DESIGN.md §Evaluation). Two worlds,
// interleaved sessions, zero leakage in either direction; and a world tick regressing below memory's
// horizon must be detected as a rollback/backup restore.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../store.mjs";
import { SESSION } from "./helpers.mjs";

test("probe 3: worlds are separate lives; rollback is detected", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcmem-iso-"));
  const a = await new MemoryStore(root, { world_uuid: "world-a", name: "alpha" }).open();
  const b = await new MemoryStore(root, { world_uuid: "world-b", name: "beta" }).open();

  // Interleaved writes to both worlds.
  await a.note({ kind: "obs", text: "World-A secret vault at (1,2,3).", pos: [1, 2, 3], tick: 1000, session: SESSION });
  await b.note({ kind: "obs", text: "World-B lava lake at (9,9,9).", pos: [9, 9, 9], tick: 500, session: SESSION });
  await a.place({ category: "storage", pos: [1, 2, 3], name: "vault", tick: 1100 });
  await b.note({ kind: "note", text: "Nothing else notable near spawn.", tick: 600, session: SESSION });

  // Zero leakage, both directions — recall, recent render, and id spaces.
  const aRecall = await a.recall({ query: "lava lake" });
  assert.equal(aRecall.results.length, 0, "world A must not see world B's records");
  const bRecall = await b.recall({ query: "secret vault" });
  assert.equal(bRecall.results.length, 0, "world B must not see world A's records");
  assert.ok(!(await b.recent({})).render.includes("vault"));
  assert.ok(!(await a.recent({})).render.includes("lava"));
  assert.equal(a.entries.size, 1);
  assert.equal(b.entries.size, 2);

  // Cold reopen keeps them separate (files live under distinct world dirs).
  const a2 = await new MemoryStore(root, { world_uuid: "world-a", name: "alpha" }).open();
  assert.equal(a2.entries.size, 1);
  assert.ok([...a2.entries.values()][0].text.includes("secret vault"));

  // Rollback detection: memory's horizon is tick 1100; a world clock behind it means restore/rollback.
  assert.equal(a2.maxSeenTick, 1100);
  assert.ok(a2.rollbackDetected(900), "tick below the horizon must flag a rollback");
  assert.ok(!a2.rollbackDetected(1100), "the horizon itself is not a rollback");
  assert.ok(!a2.rollbackDetected(5000), "normal forward time is not a rollback");
  assert.ok(!a2.rollbackDetected(null), "offline (no tick) must not false-positive");
});
