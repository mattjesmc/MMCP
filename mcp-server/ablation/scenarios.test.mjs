// Pure-logic tests for the full-grid scenarios: construction invariants and assert scoring against
// synthetic episode data. (Stage building and live behavior are covered by --dry runs.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeScenario, SCENARIOS } from "./scenarios/index.mjs";

test("every scenario builds for variants 1-3 with distinct, well-separated stages", () => {
  for (const name of Object.keys(SCENARIOS)) {
    const xs = [1, 2, 3].map((v) => makeScenario(name, v).params.x0 ?? makeScenario(name, v).params.chests?.[0].pos[0]);
    assert.equal(new Set(xs).size, 3, `${name}: variants must not share a stage`);
  }
});

test("interrogation-multi: facts span all three strips and episodes are e1a/e1b/e1c/e2", () => {
  const s = makeScenario("interrogation-multi", 1);
  assert.deepEqual(s.episodes.map((e) => e.key), ["e1a", "e1b", "e1c", "e2"]);
  const stripsUsed = new Set(Object.values(s.params.facts).map((f) => f.strip));
  assert.deepEqual([...stripsUsed].sort(), [0, 1, 2], "facts must span all strips");
  assert.ok(s.forkable, "E2 mutates nothing — must be a Track 2 target");
});

test("resume-build: spec is non-inferable (4 distinct materials, asymmetric heights)", () => {
  for (const v of [1, 2, 3]) {
    const s = makeScenario("resume-build", v);
    const mats = new Set(s.params.pillars.map((p) => p.material));
    assert.equal(mats.size, 4, "each pillar a distinct material");
    const heights = s.params.pillars.map((p) => p.height);
    assert.ok(new Set(heights).size > 1, "heights must vary");
    assert.equal(s.params.spec_cells, heights.reduce((a, b) => a + b, 0));
  }
  // Variants rotate materials: NE differs across variants.
  const ne = [1, 2, 3].map((v) => makeScenario("resume-build", v).params.pillars[0].material);
  assert.equal(new Set(ne).size, 3);
});

test("resume-build assert: delta-from-own-endpoint scoring", async () => {
  const s = makeScenario("resume-build", 1);
  const verdict = await s.assert.call(s, {
    e2: { transcript: [], finalText: "", final_drone_pos: null },
    checkpoints: {
      e1: { correct: 4, wrong: 0, total: 10 },
      e2: { correct: 10, wrong: 0, total: 10 },
    },
    memoryRoot: "Z:/nonexistent",
  });
  assert.equal(verdict.success, true);
  assert.equal(verdict.metrics.e2_delta, 6);
  assert.equal(verdict.metrics.e2_completion_of_remaining, 1);

  const partial = await s.assert.call(s, {
    e2: { transcript: [], finalText: "", final_drone_pos: null },
    checkpoints: {
      e1: { correct: 4, wrong: 0, total: 10 },
      e2: { correct: 7, wrong: 1, total: 10 },
    },
    memoryRoot: "Z:/nonexistent",
  });
  assert.equal(partial.success, false, "wrong-material blocks fail the build");
  assert.equal(partial.metrics.e2_completion_of_remaining, 0.5);
});

test("stash-self: variants rotate the retrieval target", () => {
  const targets = [1, 2, 3].map((v) => makeScenario("stash-self", v).params.target);
  assert.equal(new Set(targets).size, 3);
});
