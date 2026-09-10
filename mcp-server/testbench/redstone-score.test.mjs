// Unit tests for redstone-score.mjs — validates the logic-gate scoring core with zero server and zero
// model spend. Run: node --test testbench/redstone-score.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { GATES, defaultInputs, enumerateInputs, expectedTable, scoreObserved } from "./redstone-score.mjs";

test("enumerateInputs is ascending binary, LSB = input 0", () => {
  assert.deepEqual(enumerateInputs(2), [
    [false, false], [true, false], [false, true], [true, true],
  ]);
  assert.equal(enumerateInputs(3).length, 8);
});

test("gate functions are correct", () => {
  assert.equal(GATES.AND([true, true]), true);
  assert.equal(GATES.AND([true, false]), false);
  assert.equal(GATES.OR([false, false]), false);
  assert.equal(GATES.XOR([true, true]), false);
  assert.equal(GATES.XOR([true, false]), true);
  assert.equal(GATES.NAND([true, true]), false);
  assert.equal(GATES.NOR([false, false]), true);
  assert.equal(GATES.XNOR([true, true]), true);
  assert.equal(GATES.NOT([true]), false);
  assert.equal(GATES.MAJORITY([true, true, false]), true);
  assert.equal(GATES.MAJORITY([true, false, false]), false);
});

test("defaultInputs: NOT unary, MAJORITY ternary, rest binary", () => {
  assert.equal(defaultInputs("NOT"), 1);
  assert.equal(defaultInputs("MAJORITY"), 3);
  assert.equal(defaultInputs("AND"), 2);
});

test("expectedTable XOR is the classic 4-row table", () => {
  const t = expectedTable("XOR");
  assert.deepEqual(t.map((r) => r.out), [false, true, true, false]);
});

test("expectedTable throws on unknown gate", () => {
  assert.throws(() => expectedTable("FOO"), /unknown gate/);
});

test("scoreObserved: perfect observation → exact, accuracy 1", () => {
  const expected = expectedTable("AND").map((r) => r.out); // [F,F,F,T]
  const s = scoreObserved("AND", 2, expected);
  assert.equal(s.exact, true);
  assert.equal(s.accuracy, 1);
  assert.equal(s.rows_correct, 4);
});

test("scoreObserved: one wrong row → 3/4 accuracy, not exact", () => {
  const obs = [false, false, false, false]; // AND but last row wrong (should be true)
  const s = scoreObserved("AND", 2, obs);
  assert.equal(s.rows_correct, 3);
  assert.equal(s.accuracy, 0.75);
  assert.equal(s.exact, false);
  assert.equal(s.rows[3].expected, true);
  assert.equal(s.rows[3].observed, false);
  assert.equal(s.rows[3].ok, false);
});

test("scoreObserved: null (unread lamp) scores wrong, does not throw", () => {
  const s = scoreObserved("OR", 2, [null, undefined, true, true]);
  assert.equal(s.rows_correct, 2); // rows 2,3 correct; rows 0 (null) + 1 (undefined) wrong
  assert.equal(s.rows[0].observed, null);
  assert.equal(s.rows[0].ok, false);
});

test("scoreObserved: a build that inverted the gate (wired NAND for AND) scores 0", () => {
  const nand = expectedTable("NAND").map((r) => r.out);
  const s = scoreObserved("AND", 2, nand);
  assert.equal(s.rows_correct, 0);
  assert.equal(s.accuracy, 0);
});
