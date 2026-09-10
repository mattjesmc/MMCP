// Unit tests for motivators.mjs against hand-authored synthetic traces — the way to validate the
// three offline motivator counters WITHOUT any model spend. Run: node --test testbench/motivators.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  blindRetryAfterOpaqueFailure,
  derivableFollowUpRead,
  staticallyIllegalFirstAction,
  motivatorCounts,
} from "./motivators.mjs";

const args = (o) => JSON.stringify(o);

// ---- blindRetryAfterOpaqueFailure ---------------------------------------------------------------

test("blind retry: error immediately followed by same tool counts 1", () => {
  const trace = [
    { tool: "check_path", args: args({ from: { x: 0, y: 64, z: 0 }, to: { x: 5, y: 64, z: 5 } }), error: true },
    { tool: "check_path", args: args({ from: { x: 0, y: 64, z: 0 }, to: { x: 5, y: 64, z: 5 } }) },
  ];
  assert.equal(blindRetryAfterOpaqueFailure(trace), 1);
});

test("blind retry: a different tool in between is a diagnostic detour, not blind", () => {
  const trace = [
    { tool: "check_path", args: args({ to: { x: 5, y: 64, z: 5 } }), error: true },
    { tool: "get_blocks", args: args({ origin: { x: 0, y: 64, z: 0 } }) },
    { tool: "check_path", args: args({ to: { x: 5, y: 64, z: 5 } }) },
  ];
  assert.equal(blindRetryAfterOpaqueFailure(trace), 0);
});

test("blind retry: a chain of same-tool errors counts each qualifying adjacent pair", () => {
  const trace = [
    { tool: "raycast", args: args({ range: 32 }), error: true },
    { tool: "raycast", args: args({ range: 32 }), error: true },
    { tool: "raycast", args: args({ range: 32 }) },
  ];
  // i=0: error + same tool at i+1 -> count; i=1: error + same tool at i+2 -> count. Documented
  // behaviour: the heuristic counts qualifying adjacent PAIRS, not distinct failure episodes.
  assert.equal(blindRetryAfterOpaqueFailure(trace), 2);
});

test("blind retry: no errors at all counts 0", () => {
  const trace = [
    { tool: "get_blocks", args: args({}) },
    { tool: "get_blocks", args: args({}) },
  ];
  assert.equal(blindRetryAfterOpaqueFailure(trace), 0);
});

test("blind retry: a trailing error with nothing after it counts 0 (no next call to inspect)", () => {
  const trace = [
    { tool: "get_blocks", args: args({}) },
    { tool: "check_path", args: args({}), error: true },
  ];
  assert.equal(blindRetryAfterOpaqueFailure(trace), 0);
});

test("blind retry: non-array trace is 0, not a throw", () => {
  assert.equal(blindRetryAfterOpaqueFailure(undefined), 0);
  assert.equal(blindRetryAfterOpaqueFailure(null), 0);
});

// ---- derivableFollowUpRead -----------------------------------------------------------------------

test("derivable follow-up: same-family reads sharing a coordinate literal count 1", () => {
  const trace = [
    { tool: "check_site", args: args({ at: { x: 100, z: 200 }, size: { w: 16, d: 16 } }) },
    { tool: "check_site", args: args({ at: { x: 100, z: 200 }, size: { w: 16, d: 16 }, y: 64 }) },
  ];
  assert.equal(derivableFollowUpRead(trace), 1);
});

test("derivable follow-up: different families never count, even with shared literals", () => {
  const trace = [
    { tool: "get_blocks", args: args({ origin: { x: 100, z: 200 } }) },
    { tool: "check_site", args: args({ at: { x: 100, z: 200 } }) },
  ];
  assert.equal(derivableFollowUpRead(trace), 0);
});

test("derivable follow-up: same family but no shared literal does not count", () => {
  const trace = [
    { tool: "check_site", args: args({ at: { x: 1, z: 2 } }) },
    { tool: "check_site", args: args({ at: { x: 999, z: 888 } }) },
  ];
  assert.equal(derivableFollowUpRead(trace), 0);
});

test("derivable follow-up: an error on either side excludes the pair", () => {
  const trace = [
    { tool: "check_site", args: args({ at: { x: 5, z: 5 } }), error: true },
    { tool: "check_site", args: args({ at: { x: 5, z: 5 } }) },
  ];
  assert.equal(derivableFollowUpRead(trace), 0);
});

test("derivable follow-up: truncated (non-JSON) args fall back to numeric scraping", () => {
  const trace = [
    // Simulates agent.mjs's JSON.stringify(...).slice(0, 200) cutting mid-object.
    { tool: "get_blocks", args: '{"origin":{"x":12345,"z":6789},"grid":40,"heightmap":"world_sur' },
    { tool: "get_blocks", args: '{"origin":{"x":12345,"z":6789},"grid":10' },
  ];
  assert.equal(derivableFollowUpRead(trace), 1);
});

// ---- staticallyIllegalFirstAction -----------------------------------------------------------------

test("statically illegal first: first call errored counts 1", () => {
  const trace = [{ tool: "check_fit", args: args({}), error: true }, { tool: "check_fit", args: args({}) }];
  assert.equal(staticallyIllegalFirstAction(trace), 1);
});

test("statically illegal first: first call ok counts 0 even if a later call errors", () => {
  const trace = [{ tool: "check_fit", args: args({}) }, { tool: "check_fit", args: args({}), error: true }];
  assert.equal(staticallyIllegalFirstAction(trace), 0);
});

test("statically illegal first: empty or missing trace counts 0", () => {
  assert.equal(staticallyIllegalFirstAction([]), 0);
  assert.equal(staticallyIllegalFirstAction(undefined), 0);
});

// ---- motivatorCounts (record/trace dispatch + missing-trace handling) ----------------------------

test("motivatorCounts: a full answers.jsonl-shaped record is accepted directly", () => {
  const rec = {
    id: "t1_point.s1", rung: 1, arm: "with",
    trace: [{ tool: "get_blocks_at", args: args({ x: 1, y: 2, z: 3 }) }],
  };
  const m = motivatorCounts(rec);
  assert.equal(m.hasTrace, true);
  assert.equal(m.blind_retry, 0);
  assert.equal(m.derivable_follow_up, 0);
  assert.equal(m.statically_illegal_first, 0);
});

test("motivatorCounts: a bare trace array works the same as record.trace", () => {
  const trace = [{ tool: "check_fit", args: args({}), error: true }];
  assert.deepEqual(motivatorCounts(trace), motivatorCounts({ trace }));
});

test("motivatorCounts: a record missing `trace` (pre-trace run, or an instantiation-error record) reports hasTrace:false, not a crash", () => {
  const oldRecord = { id: "t1_point.s1", rung: 1, arm: "with", correct: true }; // 2026-07-23T06-31-05/07-56-23 shape
  assert.deepEqual(motivatorCounts(oldRecord), { hasTrace: false });
  const errorRecord = { id: "t4_reach.s1", rung: 4, arm: "with", error: "boom" };
  assert.deepEqual(motivatorCounts(errorRecord), { hasTrace: false });
});
