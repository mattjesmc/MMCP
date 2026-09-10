// Probe 8 — tier-2 pressure (MEMORY_DESIGN.md §Rev-3 pending). Scripted, no LLM judge.
// The soak-measured defect: with 14 L1 frontier blocks the coarse layer rendered 2367 tokens at a
// 900-token budget and nothing ever nagged L1→L2, so the telescope grew linearly forever.
// This probe pins the two halves of the fix — the block section is budgeted, and pressure at the
// block layer is both reported and *actionable* — plus the property that matters most: acting on
// the nag converges instead of oscillating.

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeStore, obs } from "./helpers.mjs";

const BUDGET = 900;
const tokens = (s) => Math.ceil(s.length / 4);

/** The block section is every line between the header and the [task] line. */
function blockSection(render) {
  const lines = render.split("\n");
  const end = lines.findIndex((l) => l.startsWith("[task]"));
  return lines.slice(1, end === -1 ? lines.length : end);
}

/** Build one L1 block out of two positioned entries, at a distinct tick/place. */
async function makeL1(store, i) {
  const base = 1000 * (i + 1);
  const a = await obs(store, `Outpost ${i} shell raised at (${100 + i * 32},71,${200 + i * 8}).`, [100 + i * 32, 71, 200 + i * 8], base);
  const b = await obs(store, `Outpost ${i} torch route linked west, 14 torches placed.`, [100 + i * 32, 71, 208 + i * 8], base + 200);
  return store.writeBlock({
    links: { entries: [a.id, b.id] },
    activity: "build",
    outcome: `Outpost ${i} completed and lit, linked to the east chain at (${100 + i * 32},71,${200 + i * 8}).`,
    prose: `Raised the outpost shell, then lit and linked it westward along the chain.`,
    pois: [],
  });
}

test("probe 8: the coarse layer is budgeted and L1→L2 pressure is reported", async () => {
  const { store } = await makeStore();
  for (let i = 0; i < 14; i++) await makeL1(store, i);

  const r = await store.recent({ budgetTokens: BUDGET });
  const section = blockSection(r.render);

  // Half 1 — the section fits its share of the budget instead of growing with history.
  assert.ok(tokens(section.join("\n")) <= BUDGET / 4,
    `block section must fit budget/4 (${BUDGET / 4}), got ${tokens(section.join("\n"))}`);

  // Elision is explicit, never silent: the dropped blocks are counted and remain addressable.
  const elision = section.find((l) => l.startsWith("[… "));
  assert.ok(elision, "elided blocks must be announced, not silently dropped");
  assert.match(elision, /older frontier block\(s\) elided/);
  assert.match(elision, /mem_re(call|ad)/, "the elision line must say how to get the blocks back");

  // Half 2 — the L1→L2 nag fires, names at least two blocks, and does not touch the tail rule.
  assert.ok(r.compactionDue, "14 frontier blocks over budget must produce a compaction_due");
  assert.ok(r.compactionDue.blocks.length >= 2,
    "an L1→L2 nomination compresses nothing with fewer than two children");
  assert.ok(Array.isArray(r.compactionDue.entries), "entries[] stays present so consumers can read .length");

  // The nomination must be *eligible*: handing it straight back to mem_write_block has to succeed,
  // or the nag would be an instruction the agent cannot follow.
  const l2 = await store.writeBlock({
    links: { blocks: r.compactionDue.blocks },
    activity: "build",
    outcome: "Early outpost chain established along the plateau.",
    prose: "Raised and lit the first run of outposts, linking them west along the chain.",
    pois: [],
  });
  assert.equal(l2.level, 2, "compacting L1 blocks must yield an L2 block");
});

test("probe 8: acting on the block nag converges", async () => {
  const { store } = await makeStore();
  for (let i = 0; i < 14; i++) await makeL1(store, i);

  // Follow the nag the way a charter-abiding agent would, and require it to terminate.
  let rounds = 0;
  let due = (await store.recent({ budgetTokens: BUDGET })).compactionDue;
  while (due?.blocks?.length) {
    assert.ok(++rounds <= 10, "the block nag must converge, not oscillate");
    await store.writeBlock({
      links: { blocks: due.blocks },
      activity: "build",
      outcome: `Outpost chain consolidated (round ${rounds}).`,
      prose: "Consolidated an earlier stretch of outpost work into a coarser summary.",
      pois: [],
    });
    due = (await store.recent({ budgetTokens: BUDGET })).compactionDue;
  }
  assert.ok(rounds > 0, "the 14-block corpus must have nagged at least once");

  // Converged state: the coarse layer fits, and nothing was lost — the survivors reach the leaves.
  const r = await store.recent({ budgetTokens: BUDGET });
  assert.ok(tokens(blockSection(r.render).join("\n")) <= BUDGET / 4);
  assert.equal(blockSection(r.render).some((l) => l.startsWith("[… ")), false,
    "after converging, the frontier should fit without elision");
});

test("probe 8: a small corpus is left alone", async () => {
  const { store } = await makeStore();
  await makeL1(store, 0);
  await makeL1(store, 1);

  const r = await store.recent({ budgetTokens: 4000 });
  assert.equal(blockSection(r.render).some((l) => l.startsWith("[… ")), false,
    "two blocks under a 4000 budget must render in full");
  assert.equal(r.compactionDue?.blocks?.length ?? 0, 0,
    "pressure must come from the budget, not from block count");
});
