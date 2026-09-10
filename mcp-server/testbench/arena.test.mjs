// arena.mjs — offline invariants for the seeded Category A arena. No bridge, no server: every
// assertion here is pure geometry over the generated spec, which is the point of splitting the
// generator out of stage.mjs/questions.mjs.
//
// The suite exists to protect three properties the OLD fixed arena could not have:
//   1. the answer key VARIES with the seed (it used to be a list of literals — resampling was
//      impossible, so every Category A cell rested on n=2 over one memorizable world),
//   2. no seed ships an ambiguous or tied truth (bearings near a sector boundary, nearest-tower
//      near-ties) — a resampled bench must never score a defensible answer wrong,
//   3. the difficulty knobs actually move the thing they claim to move.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  makeArena, makeWalk, arenaNeedles, snap, angleOf, dist2d, WOOLS, MIN_TOWERS, MAX_TOWERS, SIZE,
  ANOMALIES, PATCH_SHAPES,
} from "./arena.mjs";
import { generateCatB, patchData } from "./formats.mjs";
import { score } from "./quiz.mjs";

const SEEDS = Array.from({ length: 60 }, (_, i) => i + 1);
const arenas = SEEDS.map((s) => makeArena(s));
const q = (a, id) => a.questions.find((x) => x.id === id);

test("deterministic in (seed, opts)", () => {
  for (const s of [1, 7, 42]) {
    assert.equal(JSON.stringify(makeArena(s)), JSON.stringify(makeArena(s)));
    assert.notEqual(JSON.stringify(makeArena(s)), JSON.stringify(makeArena(s + 1)));
    // opts are part of the identity — a 6-tower arena is not the 4-tower one with two added.
    assert.notEqual(JSON.stringify(makeArena(s)), JSON.stringify(makeArena(s, { towerCount: 6 })));
  }
});

test("every feature sits inside the platform and off the channel", () => {
  for (const a of arenas) {
    const inside = (rc) =>
      rc.xMin >= 0 && rc.xMax <= SIZE - 1 && rc.zMin >= 0 && rc.zMax <= SIZE - 1;
    for (const rc of [a.house, a.sealed, a.pen, a.pool, a.patch]) {
      assert.ok(inside(rc), `seed ${a.seed}: feature out of bounds ${JSON.stringify(rc)}`);
      const clearsChannel = rc.zMax < a.channel.zMin || rc.zMin > a.channel.zMax;
      assert.ok(clearsChannel, `seed ${a.seed}: feature overlaps the channel`);
    }
    for (const t of a.towers) {
      assert.ok(t.x >= 0 && t.x <= SIZE - 1 && t.z >= 0 && t.z <= SIZE - 1);
      assert.ok(t.z < a.channel.zMin || t.z > a.channel.zMax, `seed ${a.seed}: tower in the channel`);
    }
    assert.ok(a.bridge.xMin >= 0 && a.bridge.xMax <= SIZE - 1);
  }
});

test("features never overlap each other", () => {
  const hit = (p, r) => !(p.xMax < r.xMin || r.xMax < p.xMin || p.zMax < r.zMin || r.zMax < p.zMin);
  for (const a of arenas) {
    const rcs = [a.house, a.sealed, a.pen, a.pool, a.patch,
      { xMin: a.anomaly.x, xMax: a.anomaly.x, zMin: a.anomaly.z, zMax: a.anomaly.z }];
    for (let i = 0; i < rcs.length; i++) {
      for (let j = i + 1; j < rcs.length; j++) {
        assert.ok(!hit(rcs[i], rcs[j]), `seed ${a.seed}: features ${i}/${j} overlap`);
      }
    }
    for (const t of a.towers) {
      const tr = { xMin: t.x, xMax: t.x, zMin: t.z, zMax: t.z };
      for (const rc of rcs) assert.ok(!hit(tr, rc), `seed ${a.seed}: tower ${t.name} inside a feature`);
    }
  }
});

test("towers: unique colours, both sides of the channel, resolvably separated", () => {
  for (const a of arenas) {
    assert.equal(a.towers.length, 4);
    assert.equal(new Set(a.towers.map((t) => t.name)).size, a.towers.length);
    const n = a.towers.filter((t) => t.north).length;
    assert.ok(n >= 1 && n <= a.towers.length - 1, `seed ${a.seed}: channel split is degenerate (${n})`);
    for (const t of a.towers) assert.equal(t.north, t.z < a.channel.zMin);
    for (let i = 0; i < a.towers.length; i++) {
      for (let j = i + 1; j < a.towers.length; j++) {
        // Chebyshev separation is what the 17-block placement margin enforces.
        const d = Math.max(Math.abs(a.towers[i].x - a.towers[j].x), Math.abs(a.towers[i].z - a.towers[j].z));
        assert.ok(d >= 17, `seed ${a.seed}: towers ${i}/${j} only ${d} apart`);
      }
    }
  }
});

test("no seed ships an ambiguous bearing", () => {
  for (const a of arenas) {
    const q2 = q(a, "a2"), q6 = q(a, "a6");
    // Re-derive from the arena rather than trusting the recorded truth.
    const named = (s) => a.towers.find((t) => s.includes(`${t.name} wool tower`));
    const m2 = [...q2.question.matchAll(/the (\w+) wool tower/g)].map((m) => m[1]);
    const m6 = [...q6.question.matchAll(/the (\w+) wool tower/g)].map((m) => m[1]);
    const f2 = a.towers.find((t) => t.name === m2[0]), t2 = a.towers.find((t) => t.name === m2[1]);
    const f6 = a.towers.find((t) => t.name === m6[0]), t6 = a.towers.find((t) => t.name === m6[1]);
    const s2 = snap(angleOf(f2, t2), 4), s6 = snap(angleOf(f6, t6), 8);
    assert.equal(s2.name, q2.truth, `seed ${a.seed}: a2 truth disagrees with geometry`);
    assert.equal(s6.name, q6.truth, `seed ${a.seed}: a6 truth disagrees with geometry`);
    assert.ok(s2.dev <= 30, `seed ${a.seed}: a2 bearing ambiguous (dev ${s2.dev})`);
    assert.ok(s6.dev <= 14, `seed ${a.seed}: a6 bearing ambiguous (dev ${s6.dev})`);
    assert.ok(named(q2.question) && named(q6.question));
  }
});

test("nearest-tower questions have a clear winner (no near-ties)", () => {
  for (const a of arenas) {
    const check = (id, pt) => {
      const sorted = [...a.towers].sort((p, r) => dist2d(p, pt) - dist2d(r, pt));
      assert.equal(sorted[0].name, q(a, id).truth, `seed ${a.seed}: ${id} truth is not the nearest tower`);
      assert.ok(dist2d(sorted[1], pt) - dist2d(sorted[0], pt) >= 8,
        `seed ${a.seed}: ${id} is a near-tie`);
    };
    const cornerName = /nearest the (\w+) corner/.exec(q(a, "a3").question)[1];
    check("a3", {
      x: cornerName.includes("west") ? 0 : SIZE - 1,
      z: cornerName.startsWith("north") ? 0 : SIZE - 1,
    });
    check("a8", {
      x: Math.floor((a.pool.xMin + a.pool.xMax) / 2),
      z: Math.floor((a.pool.zMin + a.pool.zMax) / 2),
    });
  }
});

test("a9 is balanced by construction and its truth matches the geometry", () => {
  const outcomes = new Set();
  for (const a of arenas) {
    const { from, to, crossX, crossesBridge } = a.a9;
    const zMid = a.channel.zMin + 1;
    const t = (zMid - from.z) / (to.z - from.z);
    assert.equal(crossX, Math.round(from.x + t * (to.x - from.x)), `seed ${a.seed}: crossX wrong`);
    assert.equal(crossesBridge, crossX >= a.bridge.xMin && crossX <= a.bridge.xMax);
    assert.equal(q(a, "a9").truth, crossesBridge ? "bridge" : a.channel.liquid);
    assert.notEqual(from.north, to.north, `seed ${a.seed}: a9 pair does not cross the channel`);
    outcomes.add(crossesBridge);
    // The "away from the bridge" arm must be unmistakably away, not one block off the lip.
    if (!crossesBridge) {
      const d = Math.min(Math.abs(crossX - a.bridge.xMin), Math.abs(crossX - a.bridge.xMax));
      assert.ok(d >= 11, `seed ${a.seed}: a9 "open liquid" crossing only ${d} from the bridge`);
    }
  }
  assert.equal(outcomes.size, 2, "a9 must produce BOTH outcomes across seeds (guess floor)");
});

test("a12 left/right matches the facing transform", () => {
  for (const a of arenas) {
    const qq = q(a, "a12");
    const [fromName, toName] = [...qq.question.matchAll(/the (\w+) tower/g)].map((m) => m[1]);
    const facing = /due (\w+)\)/.exec(qq.question)[1];
    const from = a.towers.find((t) => t.name === fromName);
    const to = a.towers.find((t) => t.name === toName);
    assert.equal(facing, from.north ? "south" : "north");
    // Facing south (+z), left = up x forward = +x (east). Facing north, left = -x (west).
    const expect = facing === "south"
      ? (to.x > from.x ? "left" : "right")
      : (to.x < from.x ? "left" : "right");
    assert.equal(qq.truth, expect, `seed ${a.seed}: a12 truth disagrees with the transform`);
    assert.ok(Math.abs(to.x - from.x) >= 12, `seed ${a.seed}: a12 towers too close in x`);
  }
});

test("a13/a14 agree with the tower set", () => {
  for (const a of arenas) {
    const north = a.towers.filter((t) => t.north).map((t) => t.name);
    assert.deepEqual([...q(a, "a13").truth].sort(), [...north].sort());
    assert.ok(q(a, "a13").truth.length > 0 && q(a, "a13").truth.length < a.towers.length);
    assert.equal(q(a, "a14").truth, a.towers.length);
  }
});

test("a7 compares the two seeded heights", () => {
  for (const a of arenas) {
    const want = a.towerHeight > a.house.height ? "tower" : a.towerHeight < a.house.height ? "roof" : "equal";
    assert.equal(q(a, "a7").truth, want);
    assert.ok(q(a, "a7").question.includes(`${a.towerHeight} blocks tall`));
  }
});

test("a5 distance is the real distance and never trivially short", () => {
  for (const a of arenas) {
    const [f, t] = [...q(a, "a5").question.matchAll(/the (\w+) tower/g)].map((m) => m[1]);
    const from = a.towers.find((x) => x.name === f), to = a.towers.find((x) => x.name === t);
    assert.equal(q(a, "a5").truth, Math.round(dist2d(from, to)));
    assert.ok(q(a, "a5").truth >= 30);
  }
});

// --- the property the old arena could not have -----------------------------------------------
test("the answer key VARIES with the seed (resampling actually resamples)", () => {
  const spread = (id) => new Set(arenas.map((a) => JSON.stringify(q(a, id).truth))).size;
  // Every question whose answer domain is bigger than a coin must move across 60 seeds.
  for (const id of ["a1", "a2", "a3", "a5", "a6", "a8", "a13"]) {
    assert.ok(spread(id) >= 3, `${id} only takes ${spread(id)} distinct truth(s) across 60 seeds`);
  }
  // The binary/small-domain ones must at least cover their domain (a12 is left/right by definition).
  for (const id of ["a4", "a7", "a9", "a12"]) {
    assert.ok(spread(id) >= 2, `${id} is constant across 60 seeds`);
  }
  // And no single answer may dominate a4 (the 50% floor question) — construction, not luck.
  const a4 = arenas.map((a) => q(a, "a4").truth);
  const water = a4.filter((v) => v === "water").length;
  assert.ok(water > 10 && water < 50, `a4 is lopsided: ${water}/60 water`);
});

test("anomaly block is drawn from the pool and moves", () => {
  const seen = new Set(arenas.map((a) => a.anomaly.block));
  assert.ok(seen.size >= 3, `anomaly only took ${seen.size} values`);
  for (const b of seen) assert.ok(ANOMALIES.includes(b));
});

// --- difficulty knobs ---------------------------------------------------------------------------
test("towerCount knob scales referents and lowers the guess floor", () => {
  for (let n = MIN_TOWERS; n <= MAX_TOWERS; n++) {
    const a = makeArena(3, { towerCount: n });
    assert.equal(a.towers.length, n);
    assert.equal(q(a, "a14").truth, n);
    // a3/a8 are pick-one-of-N: the floor is 1/N, so the knob is doing real work.
    assert.equal(q(a, "a3").options.length, n);
    assert.equal(new Set(a.towers.map((t) => t.name)).size, n);
  }
  // 2 towers is unsatisfiable by construction (a12 needs a same-side pair) — reject loudly rather
  // than burn 200 attempts and fail with a confusing "no valid arena".
  assert.throws(() => makeArena(1, { towerCount: MIN_TOWERS - 1 }), /towerCount/);
  assert.throws(() => makeArena(1, { towerCount: MAX_TOWERS + 1 }), /towerCount/);
  assert.ok(WOOLS.length >= MAX_TOWERS);
});

test("every towerCount is generatable across many seeds (no silent rejection cliff)", () => {
  for (let n = MIN_TOWERS; n <= MAX_TOWERS; n++) {
    for (const s of SEEDS.slice(0, 25)) {
      const a = makeArena(s, { towerCount: n });
      assert.equal(a.towers.length, n, `seed ${s} towerCount ${n}`);
    }
  }
});

test("thin walk is a subset of the full walk and keeps every load-bearing stop", () => {
  for (const a of arenas.slice(0, 20)) {
    const full = makeWalk(a, { walk: "full" });
    const thin = makeWalk(a, { walk: "thin" });
    assert.ok(thin.length <= full.length);
    const labels = new Set(full.map((s) => s.label));
    for (const s of thin) assert.ok(labels.has(s.label), "thin introduced a stop full does not have");
    // The stops that make a1/a9/a10/a11 answerable are never thinned away.
    for (const needle of ["bridge", "anomalous", "pen", "sealed"]) {
      assert.ok(thin.some((s) => s.label.includes(needle)), `thin dropped the ${needle} stop`);
    }
    for (const t of a.towers) {
      assert.ok(thin.some((s) => s.label.includes(t.name)), `thin dropped the ${t.name} tower stop`);
    }
  }
});

test("walk visits every tower and stands on the bridge", () => {
  for (const a of arenas) {
    for (const t of a.towers) {
      assert.ok(a.walk.some((s) => s.label.includes(t.name)), `seed ${a.seed}: no stop at ${t.name}`);
    }
    const onBridge = a.walk.find((s) => s.label.includes("bridge"));
    assert.ok(onBridge.x >= a.bridge.xMin && onBridge.x <= a.bridge.xMax,
      `seed ${a.seed}: bridge stop is not on the bridge`);
  }
});

test("arenaNeedles cover every feature a question depends on", () => {
  for (const a of arenas.slice(0, 20)) {
    const n = arenaNeedles(a);
    for (const t of a.towers) assert.ok(n.includes(t.block.replace("minecraft:", "")));
    assert.ok(n.includes(a.channel.liquid));
    assert.ok(n.includes(a.pool.liquid));
    assert.ok(n.includes(a.anomaly.block.replace("minecraft:", "")));
    assert.ok(n.includes("glass") && n.includes("stone_bricks"));
  }
});

test("Cat B patch is seeded and self-consistent", () => {
  const fields = new Set(), centres = new Set(), shapes = new Set();
  for (const a of arenas) {
    const p = a.patch, c = Math.floor(p.size / 2);
    fields.add(p.field); centres.add(p.centre); shapes.add(p.shape);
    assert.ok(PATCH_SHAPES.includes(p.shape));
    // The centre always overrides the shape.
    assert.equal(p.blockAt(c, c), `minecraft:${p.centre}_concrete`);
    assert.notEqual(p.field, p.mark);
    // Every cell is one of exactly three colours.
    for (let row = 0; row < p.size; row++) {
      for (let col = 0; col < p.size; col++) {
        assert.ok([`minecraft:${p.field}_concrete`, `minecraft:${p.mark}_concrete`,
          `minecraft:${p.centre}_concrete`].includes(p.blockAt(col, row)));
      }
    }
    // Spot-check each shape's defining cell against its own definition.
    const mark = `minecraft:${p.mark}_concrete`;
    if (p.shape === "diagonal") assert.equal(p.blockAt(2, 2), mark);
    if (p.shape === "row") assert.equal(p.blockAt(1, c), mark);
    if (p.shape === "column") assert.equal(p.blockAt(c, 1), mark);
    if (p.shape === "cross") { assert.equal(p.blockAt(c, 1), mark); assert.equal(p.blockAt(1, c), mark); }
    if (p.shape === "ring") { assert.equal(p.blockAt(0, 3), mark); assert.equal(p.blockAt(3, 3), `minecraft:${p.field}_concrete`); }
  }
  assert.ok(fields.size >= 2 && centres.size >= 2, "patch colours must vary with the seed");
  // b4 asks which pattern the marks form. With a fixed diagonal that answer was constant on every
  // seed — answerable without reading the grid at all.
  assert.ok(shapes.size >= 3, `patch shape only took ${shapes.size} values across 60 seeds`);
});

test("Cat B truths are counted from the actual grid", () => {
  const shapes = new Set();
  for (const a of arenas) {
    const qs = generateCatB(a);
    const get = (id) => qs.find((x) => x.id === id);
    const cells = patchData(a);
    const p = a.patch, c = Math.floor(p.size / 2);
    shapes.add(get("b4").truth);
    assert.equal(cells.length, p.size * p.size);
    // mark + field + the single centre cell must account for the whole square.
    assert.equal(get("b3").truth + get("b5").truth + 1, p.size * p.size,
      `seed ${a.seed}: counts do not tile the square`);
    assert.equal(get("b4").truth, p.shape);
    assert.deepEqual(get("b6").truth, [c, c]);
    assert.equal(get("b2").truth, `minecraft:${p.centre}_concrete`);
    // b1 probes a marked, non-centre cell and its truth is that cell's real block.
    const m = /col (\d+), row (\d+)/.exec(get("b1").question);
    assert.equal(get("b1").truth, p.blockAt(+m[1], +m[2]));
    assert.notEqual(get("b1").truth, get("b2").truth);
    for (const qq of qs) {
      const s = score(qq, qq.answer_type === "pair" ? qq.truth.join(" ") : String(qq.truth));
      assert.ok(s.correct, `seed ${a.seed} ${qq.id}: scorer rejected its own truth`);
    }
  }
  assert.ok(shapes.size >= 3, "b4's answer must move across seeds");
});

test("every question carries a reasoning_load", () => {
  for (const a of arenas.slice(0, 10)) {
    for (const qq of a.questions) {
      assert.ok(["easy", "medium", "hard"].includes(qq.reasoning_load), `${qq.id} has no reasoning_load`);
    }
  }
});

// --- scorer compatibility -------------------------------------------------------------------
test("quiz.score accepts the true answer for every generated question", () => {
  for (const a of arenas.slice(0, 20)) {
    for (const qq of a.questions) {
      if (qq.answer_type === "set") continue; // covered by the skipped test below
      const truthText = qq.answer_type === "bool" ? (qq.truth ? "yes" : "no") : String(qq.truth);
      const s = score(qq, truthText);
      assert.ok(s.correct, `seed ${a.seed} ${qq.id}: scorer rejected its own truth "${truthText}"`);
    }
  }
});

// Regression: quiz.mjs's `set` scorer used to hardcode ["red","blue","green","yellow"], so a13
// mis-scored the moment tower colours were seeded from the wider 8-wool palette.
test("quiz.score handles a13 over the seeded colour palette", () => {
  for (const a of arenas.slice(0, 20)) {
    const qq = q(a, "a13");
    assert.ok(score(qq, qq.truth.join(", ")).correct, `seed ${a.seed}: a13 scorer rejected its own truth`);
    // An over-broad answer (every colour) must NOT score when the truth is a strict subset.
    if (qq.truth.length < a.towers.length) {
      const all = a.towers.map((t) => t.name).join(", ");
      assert.ok(!score(qq, all).correct, `seed ${a.seed}: a13 accepted "all towers" as the north set`);
    }
    // A missing member must not score either.
    if (qq.truth.length > 1) {
      assert.ok(!score(qq, qq.truth.slice(1).join(", ")).correct, `seed ${a.seed}: a13 accepted a partial set`);
    }
  }
});
