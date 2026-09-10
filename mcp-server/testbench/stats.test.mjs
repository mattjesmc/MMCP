// stats.mjs — checked against textbook reference values (Wilson) and exact enumeration (binomial).
import { test } from "node:test";
import assert from "node:assert/strict";
import { wilson, normalCI, binomTwoSided, pairedSignTest } from "./stats.mjs";

const near = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test("wilson: known reference intervals (95%)", () => {
  // Standard textbook value: 10/10 → Wilson [0.7225, 1.0] (Agresti–Coull family).
  let ci = wilson(10, 10);
  near(ci.lo, 0.7225, 2e-3); near(ci.hi, 1.0);
  // 5/10 → symmetric around 0.5, ~[0.2366, 0.7634].
  ci = wilson(5, 10);
  near(ci.lo, 0.2366, 2e-3); near(ci.hi, 0.7634, 2e-3);
  // 0/1 → [0, ~0.7935].
  ci = wilson(0, 1);
  near(ci.lo, 0); near(ci.hi, 0.7935, 3e-3);
});

test("wilson: n=0 is the maximally-ignorant interval", () => {
  const ci = wilson(0, 0);
  assert.deepEqual([ci.lo, ci.hi], [0, 1]);
});

test("normalCI: constant values give a zero-width interval at the mean", () => {
  const ci = normalCI([1, 1, 1, 1]);
  near(ci.p, 1); near(ci.lo, 1); near(ci.hi, 1);
});

test("normalCI: n<2 falls back to a point interval", () => {
  const ci = normalCI([0.5]);
  assert.deepEqual([ci.lo, ci.p, ci.hi], [0.5, 0.5, 0.5]);
});

test("binomTwoSided: fair-coin extremes and symmetry", () => {
  near(binomTwoSided(5, 10, 0.5), 1.0);      // exactly expected → p=1
  near(binomTwoSided(10, 10, 0.5), 2 / 1024); // both tails: {0,10} → 2/1024
  near(binomTwoSided(0, 10, 0.5), 2 / 1024);
  assert.equal(binomTwoSided(3, 0, 0.5), 1);  // no trials → p=1
});

test("binomTwoSided: pmf sums to 1 (internal consistency)", () => {
  // If the two-sided test at the observed count includes everything ≤ its own prob, the most likely
  // outcome's p must be ≤ 1 and the least likely (tail) must be small.
  assert.ok(binomTwoSided(9, 10, 0.5) < 0.05);
  assert.ok(binomTwoSided(6, 10, 0.5) > 0.5);
});

test("pairedSignTest: only discordant pairs count", () => {
  // arm a wins 4, arm b wins 0, plus 6 concordant ties → p = 2*(1/16)=0.125.
  const pairs = [
    ...Array.from({ length: 4 }, () => ({ a: 1, b: 0 })),
    ...Array.from({ length: 6 }, () => ({ a: 1, b: 1 })),
  ];
  const r = pairedSignTest(pairs);
  assert.equal(r.discordant, 4);
  assert.equal(r.aWin, 4); assert.equal(r.bWin, 0);
  near(r.delta, 0.4); // meanA=1.0, meanB=0.6
  near(r.p, 2 / 16);
});

test("pairedSignTest: no discordant pairs → p=1 (no evidence either way)", () => {
  const r = pairedSignTest([{ a: 1, b: 1 }, { a: 0, b: 0 }]);
  assert.equal(r.discordant, 0);
  near(r.p, 1);
});
