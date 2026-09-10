// The `place_shapes` MEASUREMENT — one authored room, built with and without the batch op.
// Owed by mcp-toolkit/docs/world/STRUCTURE_AUTHORING_DESIGN.md §4's last paragraph: "turns-to-build and total
// cache_read for one authored room, batched vs. not. The prediction is that the win is nearly all in
// turn count and nearly none in result bytes. If it is not, the model was not planning ahead, and
// THAT is the finding."
//
// This is an INSTRUMENT, not a bench rung: it measures a tool's cost/benefit, not a capability. It
// is deliberately NOT in registry.mjs and writes outside testbench-results/, so it cannot pool with
// the frozen bench corpus (BENCH_VERSION) or drift anyone's tools_hash.
//
// WHY NOT REUSE CATEGORY W. wbuild's target is a 5x5x3 cottage — 75 cells, which `set_blocks`
// already batches into ONE call, because set_blocks has always taken an array. Running it would
// measure nothing about place_shapes and would produce a null result that needed explaining away.
// The place_shape -> place_shapes gap only exists where a VOLUME is the efficient unit: a structure
// big enough that per-coordinate enumeration is impractical. Hence a 13x13x6 room, 537 target cells,
// whose natural authoring is 8 shapes and whose enumeration is 537 entries.
//
// THE SPEC IS PROSE + DIMENSIONS, not glyph y-slices. Category W renders slices because a model
// reads back what describe_box shows; here slices would be a ~90-line prompt re-read on every turn,
// which would swamp the tool-prefix difference the measurement is trying to see. Both arms get the
// byte-identical prompt, so this is a fairness choice as much as a size one.

import { cmd } from "./bridge.mjs";
import { stagePlot, releasePlot, clearBox, FLOOR_Y, WEBASE } from "./plot.mjs";
import { captureRegion } from "./world-read.mjs";
import { diffBuild, keyOf } from "./build-score.mjs";

const W = 13, D = 13, H = 6;          // room-local extent; y 0 = floor, y H-1 = ceiling
const DOOR_X0 = 5, DOOR_X1 = 7;       // 3-wide doorway in the north wall (z = 0)
const DOOR_Y0 = 1, DOOR_Y1 = 3;       // 3-high
const PILLARS = [[1, 1], [1, 11], [11, 1], [11, 11]]; // inside corners

/**
 * The room, as deterministic code data. Materials vary by seed so three seeds are not one question
 * asked three times, but the GEOMETRY is fixed — the shape count is the independent variable and it
 * must not move between seeds.
 */
export function roomTarget(seed) {
  const pal = [
    { floor: "minecraft:polished_deepslate", wall: "minecraft:deepslate_bricks",
      roof: "minecraft:deepslate_tiles", pillar: "minecraft:chiseled_deepslate" },
    { floor: "minecraft:smooth_stone", wall: "minecraft:stone_bricks",
      roof: "minecraft:cobblestone", pillar: "minecraft:chiseled_stone_bricks" },
    { floor: "minecraft:polished_andesite", wall: "minecraft:bricks",
      roof: "minecraft:smooth_sandstone", pillar: "minecraft:quartz_pillar" },
  ][(seed - 1) % 3];

  const rel = {};
  for (let x = 0; x < W; x++) for (let z = 0; z < D; z++) {
    rel[`${x},0,${z}`] = pal.floor;                       // floor: whole footprint
    rel[`${x},${H - 1},${z}`] = pal.roof;                 // ceiling: whole footprint
    const edge = x === 0 || x === W - 1 || z === 0 || z === D - 1;
    if (edge) for (let y = 1; y <= H - 2; y++) rel[`${x},${y},${z}`] = pal.wall;
  }
  for (const [px, pz] of PILLARS) {
    for (let y = 1; y <= H - 2; y++) rel[`${px},${y},${pz}`] = pal.pillar;
  }
  // The doorway is carved LAST, exactly as an author would: it deletes wall that already exists.
  for (let x = DOOR_X0; x <= DOOR_X1; x++) for (let y = DOOR_Y0; y <= DOOR_Y1; y++) {
    delete rel[`${x},${y},0`];
  }
  return { rel, pal };
}

/**
 * The minimum number of `place_shape` ops this room takes if the model plans ahead. It is the
 * denominator of the whole measurement — the batch's predicted win is (SHAPES - 1) turns — so it is
 * declared here rather than left as folklore, and the report prints it beside the observed counts.
 * floor + walls + ceiling + 4 pillars + doorway carve.
 */
export const SHAPES_MINIMUM = 3 + PILLARS.length + 1; // 8

/** Room-local map → absolute, with room y=0 sitting on FLOOR_Y+1. */
function toAbsolute(rel, ox, oz) {
  const abs = {};
  for (const k of Object.keys(rel)) {
    const [x, y, z] = k.split(",").map(Number);
    abs[keyOf({ x: ox + x, y: FLOOR_Y + 1 + y, z: oz + z })] = rel[k];
  }
  return abs;
}

export function renderSpec({ pal }, ox, oz) {
  return [
    `ORIGIN: the room's north-west-bottom cell (x=0, z=0, y=0) is at (${ox}, ${FLOOR_Y + 1}, ${oz}).`,
    `Axes: +x east (x = 0..${W - 1}), +z south (z = 0..${D - 1}), +y up (y = 0..${H - 1}).`,
    `All coordinates below are room-local; convert them to absolute with the origin above.`,
    ``,
    `  y=0        FLOOR — the full ${W}x${D} footprint, ${pal.floor}`,
    `  y=1..${H - 2}     WALLS — the ${W}x${D} PERIMETER only, ${pal.wall} (the interior stays air)`,
    `  y=${H - 1}        CEILING — the full ${W}x${D} footprint, ${pal.roof}`,
    `  pillars    ${pal.pillar} at the four inside corners (x,z) = ` +
      PILLARS.map(([a, b]) => `(${a},${b})`).join(", ") + `, each spanning y=1..${H - 2}`,
    `  doorway    a ${DOOR_X1 - DOOR_X0 + 1}-wide x ${DOOR_Y1 - DOOR_Y0 + 1}-high opening (AIR) in the ` +
      `north wall: z=0, x=${DOOR_X0}..${DOOR_X1}, y=${DOOR_Y0}..${DOOR_Y1}`,
    ``,
    `Everything else inside the room is air.`,
  ].join("\n");
}

/**
 * The two arms. They differ by EXACTLY ONE TOOL — which is what makes the per-turn prefix delta
 * measured from the sdk logs attributable to place_shapes' own schema, and not to anything else.
 * `set_blocks` is in NEITHER arm on purpose: it is already batched, so leaving it in would let both
 * arms route around the tool under test and the measurement would answer a different question
 * (tool CHOICE) than the one owed. Stated as a limitation in the report.
 */
export const ARM_TOOLS = {
  single: ["place_shape", "get_blocks_at", "describe_box", "undo_edit"],
  batch: ["place_shape", "place_shapes", "get_blocks_at", "describe_box", "undo_edit"],
};

export function makeRoom({ seed, arm }) {
  const t = roomTarget(seed);
  // Own quadrant, clear of wbuild (+4000), diagnose (+1000/+5000) and redstone (+0). Arms are
  // separated in z so a leftover from one arm can never be scored as the other's build.
  const cx = WEBASE.x + 8000 + seed * 100;
  const cz = WEBASE.z + 8000 + (arm === "batch" ? 60 : 0);
  const ox = cx - Math.floor(W / 2), oz = cz - Math.floor(D / 2);
  const target = toAbsolute(t.rel, ox, oz);
  const region = {
    min: { x: ox, y: FLOOR_Y + 1, z: oz },
    max: { x: ox + W - 1, y: FLOOR_Y + H, z: oz + D - 1 },
  };

  return {
    name: "shapebatch", seed, arm,
    tools: ARM_TOOLS[arm],
    // A CIRCUIT BREAKER, NOT A BUDGET, and IDENTICAL ACROSS ARMS — an arm-dependent cap would BE
    // the measurement. The single arm's median is expected ~10-15 turns, so 60 is ~4x it; a row
    // that hits it is reported CENSORED rather than as a number.
    maxTurns: 60,
    plot: null,
    region,
    shapesMinimum: SHAPES_MINIMUM,

    async setup() {
      this.plot = await stagePlot(cx, cz, 16);
      await clearBox(region.min, region.max);
    },

    prompt: () =>
      `Build the room specified below on the empty plot, using the world-edit shape tools.\n\n` +
      `${renderSpec(t, ox, oz)}\n\nReply DONE when finished.`,

    async score() {
      const cap = await captureRegion(region.min, region.max);
      const d = diffBuild(target, cap.map);
      return {
        metrics: {
          arm, block_match: d.block_match, silhouette_iou: d.silhouette_iou, fidelity: d.fidelity,
          exact: d.exact, correct: d.correct, target_cells: d.target_cells,
          wrong_material: d.wrong_material, missing: d.missing, extra: d.extra,
          region_unread: cap.unread,
        },
        truth: { region, target_cells: d.target_cells, shapes_minimum: SHAPES_MINIMUM },
      };
    },

    async cleanup() {
      await clearBox(region.min, region.max);
      await releasePlot(this.plot);
    },
  };
}

/** Offline sanity: the target the arms are scored against, without a server. */
export function targetSummary(seed) {
  const { rel } = roomTarget(seed);
  return { cells: Object.keys(rel).length, shapes_minimum: SHAPES_MINIMUM };
}

export const CHARTER =
  `You are an expert Minecraft builder working through a world-edit interface (no body). ` +
  `Build with the shape tools; inspect with get_blocks_at/describe_box. Match the spec exactly — ` +
  `the right block at the right coordinate. Verify against the spec before finishing.`;
