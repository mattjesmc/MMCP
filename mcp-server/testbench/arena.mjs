// The SEEDED Category A/B arena — replaces the fixed hand-authored layout whose answer key was a
// list of literals (`questions.mjs` truths "minecraft:gold_block" / "east" / "green" / 4 over the
// single arena in `layout.mjs`).
//
// WHY: Category A is the no-tools model-cognition baseline both papers compare models on, and it
// had 14 items, one world, no seed, and no way to resample — so it could not be grown, could not be
// re-drawn if an item leaked, and every "100%" cell rested on n=2. This module makes the arena a
// FUNCTION OF A SEED and derives every truth from the generated geometry, so Category A gains the
// same resampling property Category T already has.
//
// CONTRACT: this module is PURE — no bridge calls, no server, no I/O. It computes an arena spec and
// the answer key; staging and the two live-verified reachability truths (a10/a11) stay in the
// callers, which is why this file can be unit-tested offline (`arena.test.mjs`).
//
// Difficulty knobs (the reasoning-load axis, DIFFICULTY_CEILING.md §2 kind-B). Both are ADDITIVE
// settings — the default (4 towers, full walk) reproduces the shape of the legacy arena, so the
// easy anchor survives alongside the harder variants.
//
//   `towerCount` (WORKING): raises the number of referents that must be held at once AND lowers the
//     guess floor on the which-tower questions from 1/4 to 1/N. Unit-tested across 3..8.
//
//   `walk: "thin"` (NOT YET LOAD-BEARING — do not cite it as a difficulty setting): the intent is to
//     force more integration from fewer vantage points, but every stop except the house is currently
//     marked `keep`, because dropping a stop is only safe if its feature still falls inside some
//     surviving stop's get_surface read — and that radius is a property of the LIVE tool, not of this
//     module. Until it is measured against a staged arena, thinning further would silently make
//     questions unanswerable and score as model failure. The mechanism is wired and tested; sizing it
//     is a follow-up that needs one live observability pass (see arenaNeedles, the existing backstop).

import { ORIGIN, SIZE } from "./layout.mjs";

export { ORIGIN, SIZE };

// --- deterministic PRNG (mulberry32 — same generator tasks.mjs uses, kept local so this module
// stays dependency-free and offline-testable) ---------------------------------------------------
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ri = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1)); // inclusive
const pick = (r, xs) => xs[Math.floor(r() * xs.length)];
const shuffle = (r, xs) => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};

// --- palettes -----------------------------------------------------------------------------------
// Eight distinguishable wools: the tower-count knob can reach 8 before colours run out. Names are
// the answer tokens for the enum/set questions, so they must stay single words (the `set` scorer
// splits on non-letters).
export const WOOLS = [
  { name: "red", block: "minecraft:red_wool" },
  { name: "blue", block: "minecraft:blue_wool" },
  { name: "green", block: "minecraft:green_wool" },
  { name: "yellow", block: "minecraft:yellow_wool" },
  { name: "orange", block: "minecraft:orange_wool" },
  { name: "purple", block: "minecraft:purple_wool" },
  { name: "cyan", block: "minecraft:cyan_wool" },
  { name: "magenta", block: "minecraft:magenta_wool" },
];
export const MAX_TOWERS = WOOLS.length;
// 3, not 2: a12 (egocentric left/right) needs two towers on the SAME side of the channel — facing
// the channel, a tower on the far side reads as "ahead", not left or right — and the split always
// puts at least one tower on each side. With 2 towers there is never a same-side pair, so a
// 2-tower arena is unsatisfiable by construction rather than merely unlucky.
export const MIN_TOWERS = 3;

// The a1 anomaly. All are unmistakable metallic/mineral blocks that read cleanly out of a
// get_surface palette, and none of them occurs naturally on the staged stone floor.
export const ANOMALIES = [
  "minecraft:gold_block", "minecraft:emerald_block", "minecraft:diamond_block",
  "minecraft:copper_block", "minecraft:netherite_block",
];

const PATCH_FIELDS = ["white", "light_gray", "yellow"];
const PATCH_MARKS = ["red", "blue", "black"];
const PATCH_CENTRES = ["cyan", "lime", "magenta"];
export const PATCH_SHAPES = ["diagonal", "row", "column", "cross", "ring"];

// --- geometry -----------------------------------------------------------------------------------
const DIR8 = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
const DIR4 = ["north", "east", "south", "west"];

/** Compass angle in degrees, clockwise from north (-z). +x east, +z south. */
export function angleOf(from, to) {
  return ((Math.atan2(to.x - from.x, -(to.z - from.z)) * 180) / Math.PI + 360) % 360;
}
/**
 * Snap an angle to an n-way compass and report how far it sits from that sector's CENTRE.
 * `dev` is the ambiguity margin: dev near 0 is a clean cardinal, dev near (180/n) is a coin flip
 * between two neighbours. Every generated bearing question asserts a dev bound, so a seed can never
 * ship a question whose "correct" answer is a rounding accident.
 */
export function snap(ang, n) {
  const step = 360 / n;
  const idx = Math.round(ang / step) % n;
  const raw = Math.abs(ang - step * idx);
  return { idx, name: (n === 8 ? DIR8 : DIR4)[idx], dev: Math.min(raw, 360 - raw) };
}
export const dist2d = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

const rect = (xMin, zMin, w, d) => ({ xMin, zMin, xMax: xMin + w - 1, zMax: zMin + d - 1 });
const overlaps = (a, b, m = 0) =>
  !(a.xMax + m < b.xMin || b.xMax + m < a.xMin || a.zMax + m < b.zMin || b.zMax + m < a.zMin);
const centreOf = (rc) => ({ x: Math.floor((rc.xMin + rc.xMax) / 2), z: Math.floor((rc.zMin + rc.zMax) / 2) });

const PAD = 6;      // keep everything clear of the platform rim
const BAND_GAP = 5; // keep features off the channel lip

/**
 * One placement attempt. Returns an arena or null if the seed drew a degenerate configuration
 * (ambiguous bearing, tied nearest-tower, unplaceable feature). `makeArena` retries with a fresh
 * sub-stream, so a rejected draw costs nothing and the result stays deterministic in `seed`.
 */
function attempt(r, opts) {
  const { towerCount } = opts;
  const occupied = [];
  const claim = (rc) => { occupied.push(rc); return rc; };
  const free = (rc, margin) =>
    rc.xMin >= PAD && rc.xMax <= SIZE - 1 - PAD && rc.zMin >= PAD && rc.zMax <= SIZE - 1 - PAD &&
    !occupied.some((o) => overlaps(rc, o, margin));
  /** Rejection-sample a w×d rect inside a z-band. */
  const place = (band, w, d, margin = 3, guard = 600) => {
    for (let i = 0; i < guard; i++) {
      const rc = rect(ri(r, PAD, SIZE - 1 - PAD - w + 1), ri(r, band.zMin, band.zMax - d + 1), w, d);
      if (free(rc, margin)) return claim(rc);
    }
    return null;
  };

  // -- the channel splits the arena; everything else is placed in one of the two bands ----------
  const zMid = ri(r, 58, 82);
  const channel = { zMin: zMid - 1, zMax: zMid + 1, xMin: 1, xMax: SIZE - 2 };
  claim({ xMin: 0, xMax: SIZE - 1, zMin: channel.zMin, zMax: channel.zMax });
  const north = { zMin: PAD, zMax: channel.zMin - BAND_GAP };
  const south = { zMin: channel.zMax + BAND_GAP, zMax: SIZE - 1 - PAD };

  // Seeded liquids. The pool always differs from the channel, so "the lava pool" / "the water pool"
  // names a unique feature no matter which way the channel drew.
  const channelLiquid = pick(r, ["water", "lava"]);
  const poolLiquid = channelLiquid === "water" ? "lava" : "water";

  // -- towers ------------------------------------------------------------------------------------
  // Split across the channel with at least one on each side: a13 (which towers are north) must
  // never be trivially "all" or "none", and a9 needs a north-south pair to draw a line between.
  const nNorth = ri(r, 1, towerCount - 1);
  const colours = shuffle(r, WOOLS).slice(0, towerCount);
  const towers = [];
  for (let i = 0; i < towerCount; i++) {
    const band = i < nNorth ? north : south;
    // Min separation 18 keeps towers individually resolvable in a grid-16 surface read and keeps
    // the nearest-tower questions from turning on a block or two.
    const rc = place(band, 1, 1, 17);
    if (!rc) return null;
    towers.push({ ...colours[i], x: rc.xMin, z: rc.zMin, north: i < nNorth });
  }
  const towerHeight = ri(r, 4, 7);

  // -- features ----------------------------------------------------------------------------------
  const houseBand = pick(r, [north, south]);
  const houseRc = place(houseBand, 7, 7, 4);
  const sealedRc = place(pick(r, [north, south]), 5, 5, 4);
  const penRc = place(pick(r, [north, south]), 21, 21, 4);
  const poolRc = place(pick(r, [north, south]), 6, 6, 4);
  const patchRc = place(pick(r, [north, south]), 9, 9, 4);
  const anomalyRc = place(pick(r, [north, south]), 1, 1, 4);
  if (!houseRc || !sealedRc || !penRc || !poolRc || !patchRc || !anomalyRc) return null;

  const houseHeight = ri(r, 3, 7);
  const house = { ...houseRc, size: 7, height: houseHeight };
  const sealed = { ...sealedRc, size: 5, height: ri(r, 3, 5) };
  const pen = { ...penRc, wallH: 4, gate: pick(r, ["east", "west", "north", "south"]) };
  const pool = { ...poolRc, liquid: poolLiquid };
  const anomaly = { x: anomalyRc.xMin, z: anomalyRc.zMin, block: pick(r, ANOMALIES) };

  // Cat B's patch. The SHAPE is seeded too: b4 asks which pattern the marked blocks form, and with a
  // fixed diagonal that answer was the constant "diagonal" on every seed — a 1-of-5 enum whose truth
  // never moved, so it could be answered without reading the grid at all.
  const patch = {
    ...patchRc, size: 9,
    field: pick(r, PATCH_FIELDS), mark: pick(r, PATCH_MARKS), centre: pick(r, PATCH_CENTRES),
    shape: pick(r, PATCH_SHAPES),
  };
  patch.blockAt = (col, row) => {
    const c = Math.floor(patch.size / 2), n = patch.size;
    if (col === c && row === c) return `minecraft:${patch.centre}_concrete`;
    const marked = {
      diagonal: col === row,
      row: row === c,
      column: col === c,
      cross: col === c || row === c,
      ring: col === 0 || col === n - 1 || row === 0 || row === n - 1,
    }[patch.shape];
    return `minecraft:${marked ? patch.mark : patch.field}_concrete`;
  };

  // -- the bridge, placed to BALANCE a9 by construction ------------------------------------------
  // a9 asks whether the straight line between two towers crosses the channel over open liquid or
  // over the bridge. Left to chance the answer would be "liquid" almost always (a 3-wide bridge in
  // a 138-wide channel). So: draw the pair first, compute where its line crosses the channel, and
  // then place the bridge either ON that crossing (answer: bridge) or deliberately away from it
  // (answer: the channel liquid) — alternating on seed parity, then VERIFIED below rather than
  // assumed.
  const northTowers = towers.filter((t) => t.north);
  const southTowers = towers.filter((t) => !t.north);
  const a9From = pick(r, northTowers);
  const a9To = pick(r, southTowers);
  const t = (zMid - a9From.z) / (a9To.z - a9From.z);
  const crossX = Math.round(a9From.x + t * (a9To.x - a9From.x));
  if (crossX < PAD + 4 || crossX > SIZE - 1 - PAD - 4) return null;
  const wantBridge = opts.seed % 2 === 0;
  let bridgeCentre;
  if (wantBridge) bridgeCentre = crossX;
  else {
    // At least 12 blocks clear of the crossing, so no reasonable reading of the line hits it.
    const lo = PAD + 2, hi = SIZE - 1 - PAD - 2;
    const options = [];
    for (let x = lo; x <= hi; x++) if (Math.abs(x - crossX) >= 12) options.push(x);
    if (!options.length) return null;
    bridgeCentre = pick(r, options);
  }
  const bridge = { xMin: bridgeCentre - 1, xMax: bridgeCentre + 1 };
  const crossesBridge = crossX >= bridge.xMin && crossX <= bridge.xMax;
  if (crossesBridge !== wantBridge) return null; // construction check, not an assumption

  const arena = {
    seed: opts.seed, origin: ORIGIN, size: SIZE, opts,
    channel: { ...channel, liquid: channelLiquid },
    bridge, towers, towerHeight, house, sealed, pen, pool, patch, anomaly,
    a9: { from: a9From, to: a9To, crossX, crossesBridge },
  };
  arena.walk = makeWalk(arena, opts);
  const questions = deriveQuestions(arena, r);
  if (!questions) return null;
  arena.questions = questions;
  return arena;
}

// --- the scripted walk ---------------------------------------------------------------------------
/**
 * Vantage points, derived from the arena so every feature a question asks about is stood next to.
 * `walk: "thin"` drops the stops that are redundant with a nearby one (mergeRadius), raising the
 * integration load: more of the map has to come from fewer, further-apart observations. Thinning
 * can only ever REMOVE a stop whose feature is still within `mergeRadius` of a surviving stop, and
 * the caller's live transcript-integrity check (arenaNeedles) is the backstop that fails loudly if
 * a thinned walk stops being answerable.
 */
export function makeWalk(arena, opts = {}) {
  const y = 1; // stand on the floor (callers add ORIGIN.y)
  const stops = [];
  for (const t of arena.towers) {
    stops.push({ label: `at the ${t.name} wool tower`, x: t.x + 2, y, z: t.z + 2, keep: true });
  }
  const hc = centreOf(arena.house);
  stops.push({ label: "beside the glass house", x: hc.x, y, z: arena.house.zMax + 3 });
  stops.push({ label: "on the stone bridge over the channel", x: arena.bridge.xMin + 1, y, z: arena.channel.zMin + 1, keep: true });
  stops.push({ label: "beside the anomalous block", x: arena.anomaly.x, y, z: arena.anomaly.z + 2, keep: true });
  const pc = centreOf(arena.pool);
  stops.push({ label: `near the ${arena.pool.liquid} pool`, x: pc.x, y, z: arena.pool.zMax + 3, keep: true });
  const nc = centreOf(arena.pen);
  stops.push({ label: "outside the stone-brick pen", x: nc.x, y, z: arena.pen.zMax + 3, keep: true });
  const sc = centreOf(arena.sealed);
  stops.push({ label: "beside the sealed glass box", x: sc.x, y, z: arena.sealed.zMax + 3, keep: true });

  if (opts.walk !== "thin") return stops.map(({ keep, ...s }) => s);
  const mergeRadius = opts.mergeRadius ?? 24;
  const kept = [];
  for (const s of stops) {
    if (!s.keep && kept.some((k) => Math.hypot(k.x - s.x, k.z - s.z) <= mergeRadius)) continue;
    kept.push(s);
  }
  return kept.map(({ keep, ...s }) => s);
}

/** Block ids/tokens that MUST appear in a staged walk transcript for this arena's questions to be
 *  answerable. Replaces run.mjs's hardcoded needle list, which could not follow a seeded arena. */
export function arenaNeedles(arena) {
  return [
    ...arena.towers.map((t) => t.block.replace("minecraft:", "")),
    arena.channel.liquid, arena.pool.liquid,
    arena.anomaly.block.replace("minecraft:", ""),
    "glass", "stone_bricks",
  ];
}

// --- the answer key ------------------------------------------------------------------------------
// Every truth below is COMPUTED from the arena above. Nothing is a literal, so a new seed is a new
// answer key and Category A can be resampled like Category T.
function deriveQuestions(a, r) {
  const names = a.towers.map((t) => t.name);
  const byName = (n) => a.towers.find((t) => t.name === n);
  const side = (z) => (z < a.channel.zMin ? "north" : "south");

  // -- a2: 4-way bearing. Requires an unambiguous cardinal (dev <= 30 of a 45 half-sector).
  const pairs = [];
  for (const from of a.towers) for (const to of a.towers) if (from !== to) pairs.push({ from, to });
  const a2p = pairs.filter((p) => snap(angleOf(p.from, p.to), 4).dev <= 30);
  if (!a2p.length) return null;
  const a2 = pick(r, a2p);
  const a2dir = snap(angleOf(a2.from, a2.to), 4).name;

  // -- a6: 8-way bearing. Tighter bound (dev <= 14 of a 22.5 half-sector) — 8-way sectors are half
  // as wide, so an angle near a boundary would make two answers equally defensible.
  const a6p = pairs.filter((p) => snap(angleOf(p.from, p.to), 8).dev <= 14);
  if (!a6p.length) return null;
  const a6 = pick(r, a6p);
  const a6dir = snap(angleOf(a6.from, a6.to), 8).name;

  // -- a3 / a8: nearest tower to a corner / to the pool. Both demand a CLEAR winner (>= 8 blocks
  // ahead of the runner-up) so a near-tie can never be scored wrong on a defensible answer.
  const nearestTo = (pt, margin = 8) => {
    const sorted = [...a.towers].sort((p, q) => dist2d(p, pt) - dist2d(q, pt));
    if (sorted.length > 1 && dist2d(sorted[1], pt) - dist2d(sorted[0], pt) < margin) return null;
    return sorted[0];
  };
  const cornerName = pick(r, ["northwest", "northeast", "southwest", "southeast"]);
  const corner = {
    x: cornerName.includes("west") ? 0 : SIZE - 1,
    z: cornerName.startsWith("north") ? 0 : SIZE - 1,
  };
  const a3t = nearestTo(corner);
  const a8t = nearestTo(centreOf(a.pool));
  if (!a3t || !a8t) return null;

  // -- a5: straight-line distance between a seeded pair (tolerance 10, as before).
  const a5 = pick(r, pairs);
  const a5d = Math.round(dist2d(a5.from, a5.to));
  if (a5d < 30) return null; // too short to be a meaningful integration question

  // -- a12: egocentric left/right. Standing at a tower FACING THE CHANNEL, is another tower left or
  // right? Facing south (a north tower), left is east (+x); facing north, left is west (-x) —
  // left = up x forward. Requires a clear x-separation so "roughly ahead" is never the honest answer.
  const a12p = pairs.filter((p) => Math.abs(p.to.x - p.from.x) >= 12 && p.from.north === p.to.north);
  if (!a12p.length) return null;
  const a12 = pick(r, a12p);
  const facing = a12.from.north ? "south" : "north";
  const a12ans = a12.from.north
    ? (a12.to.x > a12.from.x ? "left" : "right")
    : (a12.to.x < a12.from.x ? "left" : "right");

  // -- a7: tower top vs glass-house roof, both seeded heights.
  const a7 = a.towerHeight > a.house.height ? "tower" : a.towerHeight < a.house.height ? "roof" : "equal";

  const northNames = a.towers.filter((t) => t.north).map((t) => t.name);
  const anomalySide = side(a.anomaly.z);
  const L = a.channel.liquid;

  // `reasoning_load`, not `difficulty` — see DIFFICULTY_CEILING.md. The old single `difficulty` field
  // conflated two independent things, and the tier x arm split showed it was actually grading
  // tool-dependence rather than how hard the question is to reason about. Category A has no tool
  // arms at all (it is the no-tools baseline), so reasoning_load is the only one of the two that is
  // even defined here.
  const LOAD = {
    a1: "easy", a2: "easy", a3: "easy", a4: "easy",
    a5: "medium", a6: "medium", a7: "medium", a8: "medium", a9: "medium",
    a10: "hard", a11: "hard", a12: "hard", a13: "hard", a14: "hard",
  };
  const qs = [
    // -- easy anchors ------------------------------------------------------------------
    {
      id: "a1", answer_type: "block_id", truth: a.anomaly.block,
      question: `A single unusual metallic block sits on the arena floor ${anomalySide} of the ${L} channel. What is its block id?`,
    },
    {
      id: "a2", answer_type: "enum", options: DIR4, truth: a2dir,
      question: `From the ${a2.from.name} wool tower, in which compass direction is the ${a2.to.name} wool tower?`,
    },
    {
      id: "a3", answer_type: "enum", options: names, truth: a3t.name,
      question: `Which colour wool tower stands nearest the ${cornerName} corner of the arena?`,
    },
    {
      id: "a4", answer_type: "enum", options: ["water", "lava"], truth: L,
      question: "What liquid fills the channel that crosses the whole arena from west to east?",
    },
    // -- medium: cross-observation metric/relational ----------------------------------
    {
      id: "a5", answer_type: "numeric", tolerance: 10, truth: a5d,
      question: `In blocks, what is the straight-line distance between the ${a5.from.name} tower and the ${a5.to.name} tower (ignore height)?`,
    },
    {
      id: "a6", answer_type: "enum", options: DIR8, truth: a6dir,
      question: `From the ${a6.from.name} wool tower, in which of the eight compass directions is the ${a6.to.name} wool tower?`,
    },
    {
      id: "a7", answer_type: "enum", options: ["tower", "roof", "equal"], truth: a7,
      question: `Which reaches higher above the floor: the top of a wool tower (they are all ${a.towerHeight} blocks tall), or the glass house roof? Answer "tower", "roof", or "equal".`,
    },
    {
      id: "a8", answer_type: "enum", options: names, truth: a8t.name,
      question: `Which wool tower is closest to the ${a.pool.liquid} pool?`,
    },
    {
      id: "a9", answer_type: "enum", options: [L, "bridge"], truth: a.a9.crossesBridge ? "bridge" : L,
      question: `Walking the exact straight line from the ${a.a9.from.name} tower to the ${a.a9.to.name} tower, do you cross the channel over open ${L} or over the stone bridge?`,
    },
    // -- hard: reachability, egocentric transform, integration ------------------------
    {
      id: "a10", answer_type: "bool", truth: true, live: "pen",
      question: "Starting beside the stone bridge, can a villager-sized walker reach the centre of the stone-brick pen without breaking any blocks? (The pen walls are solid; think about openings.) Answer yes or no.",
    },
    {
      id: "a11", answer_type: "bool", truth: false, live: "sealed",
      question: "Starting beside the stone bridge, can a villager-sized walker reach the inside of the small sealed glass box without breaking any blocks? Answer yes or no.",
    },
    {
      id: "a12", answer_type: "enum", options: ["left", "right"], truth: a12ans,
      question: `You stand at the base of the ${a12.from.name} tower facing the channel (due ${facing}). Is the ${a12.to.name} tower on your left or your right?`,
    },
    {
      id: "a13", answer_type: "set", options: names, truth: northNames,
      question: `Which wool towers stand on the NORTH side of the ${L} channel? List their colours.`,
    },
    {
      id: "a14", answer_type: "numeric", tolerance: 0, truth: a.towers.length,
      question: "How many wool towers does the arena contain in total?",
    },
  ];
  return qs.map((q) => ({ ...q, reasoning_load: LOAD[q.id] }));
}

// --- entry point ----------------------------------------------------------------------------------
/**
 * Build the arena for `seed`. Deterministic: same (seed, opts) always yields the same arena and the
 * same answer key. Degenerate draws (ambiguous bearings, tied nearest-tower, unplaceable features)
 * are REJECTED and retried on a fresh sub-stream rather than shipped with a shaky truth.
 *
 * @param {number} seed
 * @param {{towerCount?: number, walk?: "full"|"thin", mergeRadius?: number}} [opts]
 */
export function makeArena(seed, opts = {}) {
  const towerCount = opts.towerCount ?? 4;
  if (towerCount < MIN_TOWERS || towerCount > MAX_TOWERS) {
    throw new Error(`towerCount must be ${MIN_TOWERS}..${MAX_TOWERS} (got ${towerCount})`);
  }
  const full = { seed, towerCount, walk: opts.walk ?? "full", mergeRadius: opts.mergeRadius };
  for (let k = 0; k < 200; k++) {
    const a = attempt(rng(seed * 7919 + 13 + k * 104729), full);
    if (a) { a.attempts = k + 1; return a; }
  }
  throw new Error(`makeArena: no valid arena for seed ${seed} (towerCount ${towerCount}) in 200 attempts`);
}
