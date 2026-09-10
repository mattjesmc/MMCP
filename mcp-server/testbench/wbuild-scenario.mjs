// Category W — world-edit building, AUTO-scored (no human, no LLM judge). The agent builds with the
// world_edit tools (set_blocks/place_shape/place_blocks, no body); the harness captures the plot and
// diffs it against a code-defined target structure (build-score, unit-tested). Two modes:
//   W-schematic — build from a layer-by-layer spec on an empty plot.
//   W-repair    — a copy of the target is pre-built with deliberate deviations; fix it to match.
// Both score with the same diff (block_match / silhouette_iou / fidelity), so this is the auto-scored
// floor BENCH_EXPANSION.md calls for; the human-rated W-describe/W-picture variants build on this.
//
// The target is deterministic code data (never staged as "truth" in the world), rendered to the agent
// as glyph y-slices with a legend — identical convention to describe_box detail:layers, so the model reads
// what it would read back from its own build.

import { cmd } from "./bridge.mjs";
import { stagePlot, releasePlot, clearBox, FLOOR_Y, WEBASE } from "./plot.mjs";
import { captureRegion } from "./world-read.mjs";
import { diffBuild, keyOf, normId } from "./build-score.mjs";

// --- deterministic target generator -------------------------------------------------------------
// A small cottage-like hollow structure: stone floor interior, oak_log corners, oak_plank walls,
// cobblestone flat roof, a 2-high doorway in the west wall. Varies size/material a little by seed.
// Exported (additive) for offline unit testing of the pure target/spec/deviation path.
export function buildTarget(seed) {
  const W = 5, D = 5, H = 3;
  const wall = seed % 2 === 0 ? "minecraft:oak_planks" : "minecraft:spruce_planks";
  const corner = seed % 2 === 0 ? "minecraft:oak_log" : "minecraft:spruce_log";
  const rel = {}; // "x,y,z" (0-indexed, y 0=bottom) → block id
  const doorZ = Math.floor(D / 2);
  for (let x = 0; x < W; x++) for (let z = 0; z < D; z++) for (let y = 0; y < H; y++) {
    const edge = x === 0 || x === W - 1 || z === 0 || z === D - 1;
    const isCorner = (x === 0 || x === W - 1) && (z === 0 || z === D - 1);
    let block = null;
    if (y === H - 1) block = "minecraft:cobblestone";            // flat roof over the whole footprint
    else if (y === 0 && !edge) block = "minecraft:stone";         // interior floor
    else if (isCorner) block = corner;                            // corner posts
    else if (edge) block = wall;                                  // walls
    // interior above floor stays air (null)
    if (x === 0 && z === doorZ && (y === 0 || y === 1)) block = null; // doorway in the west wall
    if (block) rel[`${x},${y},${z}`] = block;
  }
  return { rel, W, D, H };
}

/** Absolute target block map at origin (ox, FLOOR_Y+1, oz). */
function toAbsolute(rel, ox, oz) {
  const abs = {};
  for (const k of Object.keys(rel)) {
    const [x, y, z] = k.split(",").map(Number);
    abs[keyOf({ x: ox + x, y: FLOOR_Y + 1 + y, z: oz + z })] = rel[k];
  }
  return abs;
}

/** Render the target as glyph y-slices + legend (describe_box layers convention). */
export function renderSpec({ rel, W, D, H }) {
  const legend = new Map();
  const glyphs = "ABCDEFGH";
  for (const b of new Set(Object.values(rel))) if (!legend.has(b)) legend.set(b, glyphs[legend.size]);
  const lines = [`Legend: ${[...legend].map(([b, g]) => `${g}=${b}`).join(", ")} ('.' = air/empty)`];
  for (let y = 0; y < H; y++) {
    lines.push(`\ny = ${y} (${y === 0 ? "bottom/floor level" : y === H - 1 ? "top/roof" : "wall level " + y}):`);
    for (let z = 0; z < D; z++) {
      let row = "";
      for (let x = 0; x < W; x++) { const b = rel[`${x},${y},${z}`]; row += b ? legend.get(b) : "."; }
      lines.push("  " + row);
    }
  }
  lines.push(`\nAxes: x = col (0..${W - 1}, west→east), z = row (0..${D - 1}, north→south), y = layer (0 bottom → ${H - 1} top).`);
  return lines.join("\n");
}

export const WBUILD_TOOLS = ["set_blocks", "place_blocks", "place_shape", "get_blocks_at", "describe_box", "undo_edit"];

export function makeWBuild({ seed, mode }) {
  const t = buildTarget(seed);
  const cx = WEBASE.x + 4000 + seed * 100, cz = WEBASE.z + 4000 + (mode === "repair" ? 60 : 0);
  const ox = cx - Math.floor(t.W / 2), oz = cz - Math.floor(t.D / 2);
  const target = toAbsolute(t.rel, ox, oz);
  const region = { min: { x: ox, y: FLOOR_Y + 1, z: oz }, max: { x: ox + t.W - 1, y: FLOOR_Y + t.H, z: oz + t.D - 1 } };
  const spec = renderSpec(t);

  return {
    name: "w-build", seed, mode,
    arms: [mode],
    toolsFor: () => WBUILD_TOOLS,
    maxTurns: mode === "repair" ? 18 : 24,
    plot: null,
    region,

    async setup() {
      this.plot = await stagePlot(cx, cz, 14);
      await clearBox(region.min, region.max);
      if (mode === "repair") {
        // Pre-build the target, then inject deterministic deviations the agent must fix.
        for (const k of Object.keys(target)) { const [x, y, z] = k.split(",").map(Number); await cmd(`setblock ${x} ${y} ${z} ${target[k]}`); }
        const dev = deviations(target, region, seed);
        for (const d of dev) await cmd(`setblock ${d.x} ${d.y} ${d.z} ${d.block}`);
        this._deviations = dev.length;
      }
    },

    prompt: () => {
      const origin = `The build area's north-west-bottom corner is (${ox}, ${FLOOR_Y + 1}, ${oz}); ` +
        `place the layer-0 cell (x=0,z=0) there, +x east, +z south, +y up.`;
      if (mode === "repair")
        return `A structure was built to the spec below but contains a few MISTAKES (wrong blocks, ` +
          `missing blocks, or extra blocks). Inspect it (get_blocks_at/describe_box) and FIX it so it ` +
          `matches the spec exactly. ${origin}\n\nSPEC:\n${spec}\n\nReply DONE when it matches.`;
      return `Build the structure below exactly, on the empty plot, using the world-edit tools. ` +
        `${origin}\n\nSPEC:\n${spec}\n\nReply DONE when finished.`;
    },

    async score() {
      const cap = await captureRegion(region.min, region.max);
      const d = diffBuild(target, cap.map);
      return {
        metrics: {
          mode, block_match: d.block_match, silhouette_iou: d.silhouette_iou, fidelity: d.fidelity,
          exact: d.exact, correct: d.correct, target_cells: d.target_cells,
          wrong_material: d.wrong_material, missing: d.missing, extra: d.extra,
          region_unread: cap.unread, injected_deviations: this._deviations ?? 0,
        },
        truth: { region, target_cells: d.target_cells },
      };
    },

    async cleanup() {
      await clearBox(region.min, region.max);
      await releasePlot(this.plot);
    },
  };
}

/** Deterministic deviation set for repair mode: a wrong-material swap, a deletion, and an extra block.
 *  The extra is placed in an IN-REGION cell that the target leaves empty (so the capture detects it as
 *  an over-build) — never above the region where it would go unread. */
export function deviations(target, region, seed) {
  const keys = Object.keys(target).sort(); // stable order
  if (!keys.length) return [];
  const pick = (i) => keys[(seed * 7 + i * 13) % keys.length];
  const parse = (k) => { const [x, y, z] = k.split(",").map(Number); return { x, y, z }; };
  const swapK = pick(0), delK = pick(1);
  const swapTo = normId(target[swapK]) === "cobblestone" ? "minecraft:mossy_cobblestone" : "minecraft:cobblestone";
  // First in-region cell the target leaves empty (deterministic scan order), offset by seed.
  const empties = [];
  for (let x = region.min.x; x <= region.max.x; x++)
    for (let y = region.min.y; y <= region.max.y; y++)
      for (let z = region.min.z; z <= region.max.z; z++)
        if (!(`${x},${y},${z}` in target)) empties.push({ x, y, z });
  const dev = [
    { ...parse(swapK), block: swapTo },          // wrong material
    { ...parse(delK), block: "minecraft:air" },   // missing block
  ];
  if (empties.length) dev.push({ ...empties[(seed * 5) % empties.length], block: "minecraft:dirt" }); // in-region over-build
  return dev;
}

export const SCENARIOS = { wbuild: makeWBuild };
