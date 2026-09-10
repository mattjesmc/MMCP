// Semantic channel (build-order step 5): conceptual retrieval over frontier blocks — a query with NO
// lexical overlap must still find the right episode, and must rank it above an unrelated one.
// Opts into the real embedding backend; skips (never fails) when it is unavailable, since the
// channel is an additional capability — its absence degrades recall, it does not break it.

process.env.MCPTK_EMBED_BACKEND = "transformers";

import { test } from "node:test";
import assert from "node:assert/strict";
import { available } from "../embeddings.mjs";
import { makeStore, obs } from "./helpers.mjs";

test("semantic recall: concept query finds the episode without shared words", { timeout: 120000 }, async (t) => {
  if (!(await available())) {
    t.skip("embedding backend unavailable — semantic channel absent by design");
    return;
  }
  const { store } = await makeStore();

  const farm = [];
  farm.push(await obs(store, "Tilled soil and planted wheat rows by the river.", [10, 64, 10], 1000));
  farm.push(await obs(store, "Harvested wheat and baked bread in the furnace.", [12, 64, 12], 2000));
  await store.writeBlock({
    links: { entries: farm.map((e) => e.id) },
    activity: "farming",
    outcome: "Wheat farm producing; bread stocked.",
    prose: "Set up a wheat farm by the river and baked the first bread.",
    pois: [],
  });

  const mine = [];
  mine.push(await obs(store, "Dug a staircase shaft down to y=12.", [-50, 30, -50], 3000));
  mine.push(await obs(store, "Struck a redstone vein; collected 20 dust.", [-52, 12, -52], 4000));
  await store.writeBlock({
    links: { entries: mine.map((e) => e.id) },
    activity: "mining",
    outcome: "Shaft to y=12; 20 redstone collected.",
    prose: "Mined a staircase shaft and extracted redstone.",
    pois: [],
  });

  // "food supply" shares no token with the farm records — only the semantic channel can find it.
  const { results } = await store.recall({ query: "food supply" });
  const semantic = results.filter((r) => r.channel === "semantic");
  const farmBlock = semantic.find((r) => r.activity === "farming");
  assert.ok(farmBlock, "the farming episode must surface for a food-concept query");
  const mineBlock = semantic.find((r) => r.activity === "mining");
  if (mineBlock) {
    assert.ok(farmBlock.score > mineBlock.score, "the food episode must outrank the mining episode");
  }
});
