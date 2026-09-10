// Probe 4 — demoted-detail retrieval (MEMORY_DESIGN.md §Evaluation). The regression test for
// revision-2 issue 1 (reachable ≠ retrievable): a fact whose specifics were generalized away by
// compaction must still be discoverable through the lexical channel, and must render WITH its
// covering block's gloss (an orphaned fact without episode context is not a usable memory).
// Fails by construction on block-only semantic indexing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeStore, obs } from "./helpers.mjs";

test("probe 4: demoted detail stays discoverable", async () => {
  const { store } = await makeStore();

  const detail = await obs(store,
    "Stored 12 iron ingots in the lower barrel beneath the workshop stairs (-138,64,306).",
    [-138, 64, 306], 5000);
  const filler = await obs(store,
    "Smelting batch finished at the furnace bank.",
    [-140, 64, 308], 5200);

  // Compacted prose deliberately omits "12", "barrel", "stairs", and generalizes "ingots" away.
  const block = await store.writeBlock({
    links: { entries: [detail.id, filler.id] },
    activity: "build",
    outcome: "Established an iron supply at the workshop.",
    prose: "Continued workshop construction and established an iron supply.",
    pois: [],
  });

  const { results, render } = await store.recall({ query: "12 iron ingots" });

  const hit = results.find((r) => r.id === detail.id);
  assert.ok(hit, "the demoted L0 entry itself must be retrieved, not just its covering block");
  assert.deepEqual(hit.pos, [-138, 64, 306]);
  assert.ok(render.includes("12 iron ingots"), "verbatim fact must appear in the render");
  assert.ok(render.includes(block.outcome), "the covering block's gloss must accompany the raw hit");
});
