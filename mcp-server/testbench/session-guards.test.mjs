import { test } from "node:test";
import assert from "node:assert/strict";
import { makeStallGuard, runawayBound, RUNAWAY_TURNS, STALL_STREAK } from "./session-guards.mjs";

test("runawayBound never drops below the caller's advisory or the runaway floor", () => {
  assert.equal(runawayBound(8), RUNAWAY_TURNS);        // low advisory → floor wins
  assert.equal(runawayBound(500), 500);                // high advisory preserved
  assert.equal(runawayBound(undefined), RUNAWAY_TURNS);
  assert.equal(runawayBound(0), RUNAWAY_TURNS);
});

test("a new distinct call every turn never stalls", () => {
  const g = makeStallGuard();
  for (let i = 0; i < 50; i++) {
    const { stalled } = g.observe([`get_surface|{"n":${i}}`]);
    assert.equal(stalled, false);
  }
});

test("repeating the SAME call stalls after exactly STALL_STREAK no-progress turns", () => {
  const g = makeStallGuard();
  g.observe([`describe_box|{"a":1}`]); // first sight: progress (a new call), streak resets to 0
  for (let i = 1; i < STALL_STREAK; i++) assert.equal(g.observe([`describe_box|{"a":1}`]).stalled, false);
  assert.equal(g.observe([`describe_box|{"a":1}`]).stalled, true); // the STALL_STREAK-th repeat
});

test("a fresh call resets the no-progress streak", () => {
  const g = makeStallGuard({ streak: 3 });
  g.observe([`x|{}`]);
  g.observe([`x|{}`]); g.observe([`x|{}`]); // 2 repeats, not yet stalled
  assert.equal(g.observe([`y|{}`]).stalled, false); // new call → reset
  assert.equal(g.observe([`x|{}`]).stalled, false); // x seen before but streak restarted
});

test("turns with no tool calls (thinking / answering) reset and never stall", () => {
  const g = makeStallGuard({ streak: 2 });
  g.observe([`x|{}`]); g.observe([`x|{}`]); // 1 repeat
  assert.equal(g.observe([]).stalled, false); // pure-text turn resets
  assert.equal(g.observe([`x|{}`]).stalled, false);
});
