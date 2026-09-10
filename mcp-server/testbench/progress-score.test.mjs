// Unit tests for progress-score.mjs — validates the milestone/checkpoint aggregation core with zero
// server and zero model spend. Run: node --test testbench/progress-score.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { sequentialProgress, costPerMilestone } from "./progress-score.mjs";

test("all done → completed_all, deepest = total", () => {
  const p = sequentialProgress([{ key: "a", done: true }, { key: "b", done: true }]);
  assert.equal(p.deepest, 2);
  assert.equal(p.completed_all, true);
  assert.equal(p.stalled_at, null);
  assert.equal(p.skipped, 0);
});

test("stall at first gap: deepest counts only the consecutive prefix", () => {
  const p = sequentialProgress([{ key: "a", done: true }, { key: "b", done: false }, { key: "c", done: true }]);
  assert.equal(p.done, 2);       // two are done
  assert.equal(p.deepest, 1);    // but only 'a' is earned progress
  assert.equal(p.stalled_at, 1);
  assert.equal(p.stalled_key, "b");
  assert.equal(p.skipped, 1);    // 'c' was done out of order
  assert.equal(p.completed_all, false);
});

test("nothing done → deepest 0, stalled at first", () => {
  const p = sequentialProgress([{ key: "a", done: false }, { key: "b", done: false }]);
  assert.equal(p.deepest, 0);
  assert.equal(p.stalled_at, 0);
  assert.equal(p.stalled_key, "a");
});

test("empty ladder is vacuously complete", () => {
  const p = sequentialProgress([]);
  assert.equal(p.completed_all, true);
  assert.equal(p.deepest, 0);
  assert.equal(p.stalled_at, null);
});

test("costPerMilestone uses earned deepest, not lucky skips", () => {
  const steps = [
    { key: "a", done: true, tokens: 100, turns: 2 },
    { key: "b", done: false, tokens: 300, turns: 6 },
    { key: "c", done: true, tokens: 50, turns: 1 },
  ];
  const c = costPerMilestone(steps);
  assert.equal(c.deepest, 1);
  assert.equal(c.tokens_total, 450);
  assert.equal(c.turns_total, 9);
  assert.equal(c.tokens_per_milestone, 450); // 450 / deepest(1)
  assert.equal(c.turns_per_milestone, 9);
});

test("costPerMilestone: zero progress → null per-milestone (no divide-by-zero)", () => {
  const c = costPerMilestone([{ key: "a", done: false, tokens: 200, turns: 4 }]);
  assert.equal(c.deepest, 0);
  assert.equal(c.tokens_per_milestone, null);
  assert.equal(c.turns_per_milestone, null);
});
