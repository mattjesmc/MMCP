// Probe 2 — exact recall (MEMORY_DESIGN.md §Evaluation). Plant facts with coordinates, force
// compaction, ask for each fact: the exact planted record must come back, coordinates intact.
// The token cost of each correct recall is the ablation number phase C is judged against.

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeStore, obs } from "./helpers.mjs";

const FACTS = [
  { text: "Diamond chest buried at (-88,12,415) under the gravel patch.", pos: [-88, 12, 415], ask: "diamond chest" },
  { text: "Nether portal lit at (200,70,-30) on the basalt ridge.", pos: [200, 70, -30], ask: "nether portal" },
  { text: "Skeleton spawner found at (-140,22,290), not yet lit.", pos: [-140, 22, 290], ask: "skeleton spawner" },
];

test("probe 2: exact recall after compaction", async () => {
  const { store } = await makeStore();

  const planted = [];
  let tick = 1000;
  for (const f of FACTS) {
    planted.push(await obs(store, f.text, f.pos, (tick += 500)));
  }

  await store.writeBlock({
    links: { entries: planted.map((e) => e.id) },
    activity: "exploration",
    outcome: "Prospecting sweep of the west quadrant.",
    prose: "Swept the west quadrant marking underground finds.",
    pois: [],
  });

  for (let i = 0; i < FACTS.length; i++) {
    const { results, render } = await store.recall({ query: FACTS[i].ask });
    const hit = results.find((r) => r.id === planted[i].id);
    assert.ok(hit, `recall("${FACTS[i].ask}") must surface entry ${planted[i].id}`);
    assert.deepEqual(hit.pos, FACTS[i].pos, "coordinates must survive verbatim");
    assert.ok(render.includes(FACTS[i].text), "render must include the verbatim planted fact");
  }
});
