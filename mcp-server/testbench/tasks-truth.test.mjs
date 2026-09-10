// Offline invariants for the Category T answer keys that can be computed without a server.
//
// The t9 suite exists because of a specific defect: the rung's terrain was built so that EVERY
// candidate anchor had identical terrain work, which made the "minimum over all anchors" a constant
// and reduced the truth to 3 x (y_max - y_min) — both of which the prompt states. The rung meant to
// price find_site's search was solvable by arithmetic on the prompt text, with no world read at all.
// (Confirmed against the shipped corpus: seed 1 jump 5 -> truth 15, seed 2 jump 3 -> truth 9.)
//
// These tests are the guard that the leak stays closed: they assert the answer is NOT derivable from
// the stated y-range, that a real argmin exists, and that the tie-freeness the original design
// depended on survives the change.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  rng, t9Profile, t9OddBuckets, t9HeightAt, t9MinWork, t9EveryWindowHasStrictMode,
} from "./tasks.mjs";

const MIN_DX = 4, MAX_DX = 19, W = 3, D = 3;
const SEEDS = Array.from({ length: 80 }, (_, i) => i + 1);
const profiles = SEEDS.map((s) => t9Profile(rng(s), { span: 24, minDx: MIN_DX, maxDx: MAX_DX }));
const maxAmp = (amp) => Math.max(...t9OddBuckets(MIN_DX, MAX_DX).map((b) => amp[b]));
const minAmp = (amp) => Math.min(...t9OddBuckets(MIN_DX, MAX_DX).map((b) => amp[b]));

test("t9: profile is deterministic in the seed", () => {
  for (const s of [1, 5, 41]) {
    assert.deepEqual(
      t9Profile(rng(s), { span: 24, minDx: MIN_DX, maxDx: MAX_DX }),
      t9Profile(rng(s), { span: 24, minDx: MIN_DX, maxDx: MAX_DX }),
    );
  }
});

test("t9: even buckets sit at 0, odd buckets are raised", () => {
  for (const amp of profiles) {
    for (let b = 0; b < amp.length; b++) {
      if (b % 2 === 0) assert.equal(amp[b], 0, `bucket ${b} should be flat`);
      else assert.ok(amp[b] >= 2 && amp[b] <= 8, `bucket ${b} amplitude out of range: ${amp[b]}`);
    }
  }
});

test("t9: every 3-wide window sees exactly 2 heights with a strict majority", () => {
  // This is the property that makes the answer key independent of map iteration order — the reason
  // the original design used width-2 buckets at all. Changing the amplitudes must not break it.
  for (const [i, amp] of profiles.entries()) {
    assert.ok(t9EveryWindowHasStrictMode(amp, MIN_DX, MAX_DX, W, D), `seed ${i + 1}: tied modal height`);
    for (let ax = MIN_DX; ax + W - 1 <= MAX_DX; ax++) {
      const hs = new Set();
      for (let dx = ax; dx < ax + W; dx++) hs.add(t9HeightAt(amp, dx));
      assert.equal(hs.size, 2, `seed ${i + 1} anchor ${ax}: saw ${hs.size} distinct heights`);
    }
  }
});

test("t9: the answer is NOT derivable from the stated y-range (the leak)", () => {
  // The prompt states the terrain runs y .. y + maxAmp. If min work equalled D x maxAmp, the answer
  // would fall straight out of the prompt again.
  for (const [i, amp] of profiles.entries()) {
    const work = t9MinWork(amp, MIN_DX, MAX_DX, W, D);
    assert.ok(work < D * maxAmp(amp),
      `seed ${i + 1}: min work ${work} equals the prompt-derivable ${D * maxAmp(amp)}`);
    // And it is exactly D x the SMALLEST reachable amplitude — which only a terrain read reveals.
    assert.equal(work, D * minAmp(amp), `seed ${i + 1}: min work is not D x minAmp`);
  }
});

test("t9: a real argmin exists — anchors genuinely differ", () => {
  for (const [i, amp] of profiles.entries()) {
    const works = [];
    for (let ax = MIN_DX; ax + W - 1 <= MAX_DX; ax++) {
      works.push(t9MinWork(amp, ax, ax + W - 1, W, D)); // single-anchor work
    }
    assert.ok(new Set(works).size >= 2,
      `seed ${i + 1}: every anchor has identical work (${works[0]}) — no search left`);
  }
});

test("t9: the answer moves across seeds and is never trivially zero", () => {
  const truths = profiles.map((amp) => t9MinWork(amp, MIN_DX, MAX_DX, W, D));
  for (const [i, t] of truths.entries()) assert.ok(t > 0, `seed ${i + 1}: trivial zero answer`);
  assert.ok(new Set(truths).size >= 4, `answer only takes ${new Set(truths).size} values over 80 seeds`);
  // The old rung's answers were 3 x jump for jump in 2..6 — i.e. a multiple of 3 that the prompt
  // gave away. The new answers must not correlate with the stated range.
  const pairs = profiles.map((amp, i) => [maxAmp(amp), truths[i]]);
  const sameAsMax = pairs.filter(([mx, t]) => t === D * mx).length;
  assert.equal(sameAsMax, 0, `${sameAsMax} seeds still leak the answer through the y-range`);
});

test("t9: minAmp is strictly below maxAmp on every seed", () => {
  // t9Profile forces this; without it the minimum collapses back to a constant.
  for (const [i, amp] of profiles.entries()) {
    assert.ok(minAmp(amp) < maxAmp(amp), `seed ${i + 1}: amplitudes are uniform (${minAmp(amp)})`);
  }
});
