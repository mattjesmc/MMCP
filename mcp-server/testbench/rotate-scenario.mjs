// Category R — mental-rotation / spatial-transform VQA (the MineAnyBuild "spatial reasoning"
// dimension, adapted to this bench's discipline). BENCH_EXPANSION notes rotation-as-VQA as the
// cheapest add: NO world staging, NO dev server, NO live iteration — the truth is computed in code
// and cross-checked against an independent grid rebuild before a single model token is spent.
//
// The task: the model is shown an N×N top-down grid with marked cells, told to mentally apply a named
// rigid transform (rotate 90/180/270° clockwise, mirror across an axis, or a compose of two), and
// asked where a marker lands / which corner it's in / how many markers fall on a line. It never sees
// the transformed grid — it must compute it. Pure spatial reasoning, no lookup.
//
// Reuse (imported, not duplicated): askOne / extractAnswer / score from quiz.mjs — the same fresh
// no-tools SDK session + machine scorer Categories A/B use. What's NEW here is the deterministic grid
// generator, the transform algebra (with a permutation self-check), and the question builders. This
// module has NO top-level side effects and touches nothing in the running bench.

// --- deterministic PRNG (mulberry32) — inlined so this module has zero bench imports beyond quiz ---
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ri = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1)); // inclusive

export const N = 5; // grid is N×N; center index is (N-1)/2 = 2 for N=5

// --- transform algebra --------------------------------------------------------------------------
// Each transform maps a cell (c,r) — col = x-index (0..N-1, left→right), row = z-index (0..N-1,
// printed top line = row 0) — to its image under a rigid transform of the whole grid. Derived and
// spot-checked against "rotate the paper" intuition:
//   rot90cw : top-left → top-right   ⇒ (c,r) → (N-1-r, c)
//   rot180  : (c,r) → (N-1-c, N-1-r)
//   rot270cw: (c,r) → (r, N-1-c)      (= 90° counter-clockwise)
//   mirrorH : flip left↔right across the vertical axis ⇒ (c,r) → (N-1-c, r)
//   mirrorV : flip top↔bottom across the horizontal axis ⇒ (c,r) → (c, N-1-r)
export const TRANSFORMS = {
  rot90cw:  { label: "rotate the entire grid 90° clockwise",              fn: (c, r) => [N - 1 - r, c] },
  rot180:   { label: "rotate the entire grid 180°",                       fn: (c, r) => [N - 1 - c, N - 1 - r] },
  rot270cw: { label: "rotate the entire grid 270° clockwise (i.e. 90° counter-clockwise)", fn: (c, r) => [r, N - 1 - c] },
  mirrorH:  { label: "mirror the entire grid left-to-right (across the vertical center line)", fn: (c, r) => [N - 1 - c, r] },
  mirrorV:  { label: "mirror the entire grid top-to-bottom (across the horizontal center line)", fn: (c, r) => [c, N - 1 - r] },
};

/** Compose two transforms: apply `first`, then `second`. Label reads in application order. */
function compose(firstKey, secondKey) {
  const a = TRANSFORMS[firstKey], b = TRANSFORMS[secondKey];
  return { label: `${a.label}, and THEN ${b.label}`, fn: (c, r) => b.fn(...a.fn(c, r)) };
}

/** A transform must be a bijection over the N×N cells (a rigid transform is). Throws otherwise — the
 *  answer-key self-check that co-validates the truth before any model is spent. */
function assertPermutation(fn, where) {
  const seen = new Set();
  for (let c = 0; c < N; c++) for (let r = 0; r < N; r++) {
    const [nc, nr] = fn(c, r);
    if (nc < 0 || nc >= N || nr < 0 || nr >= N) throw new Error(`${where}: (${c},${r})→(${nc},${nr}) out of bounds`);
    const key = `${nc},${nr}`;
    if (seen.has(key)) throw new Error(`${where}: not a bijection — (${nc},${nr}) hit twice`);
    seen.add(key);
  }
  if (seen.size !== N * N) throw new Error(`${where}: image covers ${seen.size}/${N * N} cells`);
}

// --- rendering ----------------------------------------------------------------------------------
const cornerOf = (c, r) => {
  const mid = (N - 1) / 2;
  const ns = r < mid ? "north" : r > mid ? "south" : null;
  const ew = c < mid ? "west" : c > mid ? "east" : null;
  return ns && ew ? ns + ew : null; // strictly-corner cells only (the generator guarantees this)
};

/** ASCII grid, row 0 printed first, char position in a line = col. '#' = marker, '.' = empty. */
function renderGrid(markers, mark = "#") {
  const set = new Set(markers.map(([c, r]) => `${c},${r}`));
  const lines = [];
  for (let r = 0; r < N; r++) {
    let line = "";
    for (let c = 0; c < N; c++) line += set.has(`${c},${r}`) ? mark : ".";
    lines.push(line);
  }
  return lines.join("\n");
}

const PREAMBLE =
  `Below is a top-down ${N}×${N} grid of cells, viewed from above with north at the top. Each line is ` +
  `one row; the top line is row 0 and rows increase southward (downward). Within a line, the leftmost ` +
  `character is col 0 and cols increase eastward (rightward). '#' marks a filled cell, '.' is empty. ` +
  `Cols and rows are 0-indexed (0..${N - 1}).`;

// --- question builders --------------------------------------------------------------------------
// Every truth is computed by the transform `fn` AND the whole map is asserted a bijection first, so a
// buggy formula throws at generation, never silently mis-scores.

/** pair: where does the single marker land after the transform? (the core mental-rotation task) */
function qMarkerLands(id, difficulty, tf, r) {
  assertPermutation(tf.fn, `${id}/${tf.label}`);
  // one marker, not on a center line (so it also has a well-defined corner)
  const c0 = pick(r, [0, 1, N - 2, N - 1]), r0 = pick(r, [0, 1, N - 2, N - 1]);
  const [c1, r1] = tf.fn(c0, r0);
  return {
    id, difficulty, answer_type: "pair", truth: [c1, r1],
    context: `${PREAMBLE}\n\nGrid:\n${renderGrid([[c0, r0]])}`,
    question: `The grid has one '#'. If you ${tf.label}, at which (col, row) does that '#' end up? ` +
      `Answer as two numbers "col, row".`,
  };
}

/** enum(corner): which corner does the marker occupy after the transform? */
function qMarkerCorner(id, difficulty, tf, r) {
  assertPermutation(tf.fn, `${id}/${tf.label}`);
  const c0 = pick(r, [0, 1, N - 2, N - 1]), r0 = pick(r, [0, 1, N - 2, N - 1]);
  const [c1, r1] = tf.fn(c0, r0);
  const truth = cornerOf(c1, r1);
  return {
    id, difficulty, answer_type: "enum",
    options: ["northeast", "southeast", "southwest", "northwest"], truth,
    context: `${PREAMBLE}\n\nGrid:\n${renderGrid([[c0, r0]])}`,
    question: `The grid has one '#'. If you ${tf.label}, which corner of the grid does that '#' end up ` +
      `in? Answer with exactly one word: northeast, southeast, southwest, or northwest.`,
  };
}

/** numeric: how many markers fall on the top row (row 0) after the transform? (mapping awareness) */
function qLineCount(id, difficulty, tf, r) {
  assertPermutation(tf.fn, `${id}/${tf.label}`);
  const k = ri(r, 3, 5);
  const cells = new Set();
  while (cells.size < k) cells.add(`${ri(r, 0, N - 1)},${ri(r, 0, N - 1)}`);
  const markers = [...cells].map((s) => s.split(",").map(Number));
  const truth = markers.filter(([c, rr]) => tf.fn(c, rr)[1] === 0).length;
  return {
    id, difficulty, answer_type: "numeric", tolerance: 0, truth,
    context: `${PREAMBLE}\n\nGrid:\n${renderGrid(markers)}`,
    question: `If you ${tf.label}, how many '#' cells end up on the top row (row 0)? Answer with a single number.`,
  };
}

function pick(r, xs) { return xs[Math.floor(r() * xs.length)]; }

// --- the question set (a difficulty gradient over transform complexity) --------------------------
export function makeRotationQuestions(seed) {
  const r = rng(seed * 2654435761 >>> 0 || (seed + 1));
  return [
    // easy: single quarter/half turn, direct marker landing
    qMarkerLands("r1", "easy", TRANSFORMS.rot90cw, r),
    qMarkerLands("r2", "easy", TRANSFORMS.rot180, r),
    // medium: the less-intuitive turns + mirrors
    qMarkerCorner("r3", "medium", TRANSFORMS.rot270cw, r),
    qMarkerLands("r4", "medium", TRANSFORMS.mirrorH, r),
    qMarkerCorner("r5", "medium", TRANSFORMS.mirrorV, r),
    // hard: composed transform + mapping-awareness count
    qMarkerLands("r6", "hard", compose("rot90cw", "mirrorH"), r),
    qLineCount("r7", "hard", TRANSFORMS.rot90cw, r),
    qLineCount("r8", "hard", compose("rot90cw", "rot90cw"), r), // = rot180 via double-quarter-turn
  ];
}

export const SCENARIOS = { rotate: makeRotationQuestions };
