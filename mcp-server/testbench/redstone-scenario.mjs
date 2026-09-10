// Category Z, redstone/logic puzzle. The agent BUILDS a combinational circuit (world-edit tools, no
// body) whose output lamp must light per a target logic gate's truth table; the harness drives every
// input combination and reads the lamp's `lit` blockstate, scoring against the table (redstone-score,
// unit-tested). This lights the dark world_edit cluster (set_blocks/place_shape) on a task with a
// crisp machine truth — no LLM judge, no human.
//
// Input drive: input i is ON iff a redstone_block sits at IPOS[i]. The harness toggles that with a
// vanilla `setblock` (which triggers neighbor/redstone updates — more reliable than poking a lever's
// blockstate), waits for propagation, and reads OUT's redstone_lamp[lit]. The agent wires FROM the
// cell next to each feed TO the lamp. Reserved cells (feeds + lamp) are re-asserted by the driver
// every combo, so an accidental overwrite can't corrupt the measurement.
//
// LIVE-ITERATION KNOB (isolated, like traverse grounding / combat platform): whether `setblock
// redstone_block` propagates through an agent-built circuit within the wait window is the one thing to
// confirm in-game. --dry runs a MEASUREMENT SELF-CHECK — it powers the lamp directly and confirms
// readLit toggles — so the apparatus is validated before any model is spent.

import { cmd } from "./bridge.mjs";
import { stagePlot, releasePlot, clearBox, FLOOR_Y, WEBASE } from "./plot.mjs";
import { readLit } from "./world-read.mjs";
import { GATES, defaultInputs, enumerateInputs, expectedTable, scoreObserved } from "./redstone-score.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Difficulty gradient: NOT (anchor, one inverter) → OR/AND (direct) → XOR (needs a real gate).
export const GATE_LADDER = ["NOT", "OR", "AND", "XOR"];

// World-edit surface for a bodiless builder. get_blocks_at/describe_box let it inspect its own circuit.
export const REDSTONE_TOOLS = ["set_blocks", "place_blocks", "place_shape", "get_blocks_at", "describe_box", "undo_edit"];

export function makeRedstonePuzzle({ seed, gate }) {
  const gi = Math.max(0, GATE_LADDER.indexOf(gate));
  const cx = WEBASE.x + gi * 100, cz = WEBASE.z + seed * 100;
  const n = defaultInputs(gate);
  const y = FLOOR_Y + 1;
  // Feeds along z on the west side; lamp on the east side, centered.
  const IPOS = Array.from({ length: n }, (_, i) => ({ x: cx - 6, y, z: cz - (n - 1) + i * 2 }));
  const OUT = { x: cx + 6, y, z: cz };
  const table = expectedTable(gate, n);

  const tableText = table.map((r) =>
    `  inputs [${r.inputs.map((b) => (b ? 1 : 0)).join(", ")}] → lamp ${r.out ? "ON" : "off"}`).join("\n");
  const feedText = IPOS.map((p, i) => `  input ${i}: redstone_block appears at (${p.x}, ${p.y}, ${p.z})`).join("\n");

  return {
    name: "z-redstone", seed, gate, n,
    arms: ["build"],
    toolsFor: () => REDSTONE_TOOLS,
    maxTurns: 20,
    plot: null,
    region: { min: { x: cx - 7, y: FLOOR_Y, z: cz - 5 }, max: { x: cx + 7, y: FLOOR_Y + 4, z: cz + 5 } },

    async setup() {
      this.plot = await stagePlot(cx, cz, 12);
      // Pre-place the output lamp so the agent knows exactly where the output is read from.
      await cmd(`setblock ${OUT.x} ${OUT.y} ${OUT.z} minecraft:redstone_lamp`);
      // Start all inputs off (air at the feed cells).
      for (const p of IPOS) await cmd(`setblock ${p.x} ${p.y} ${p.z} minecraft:air`);
    },

    prompt: () =>
      `You are a redstone engineer. Build a combinational circuit so the output lamp lights EXACTLY ` +
      `according to this ${gate} truth table:\n${tableText}\n\n` +
      `Inputs (each is a redstone_block that will be placed or removed by the grader):\n${feedText}\n` +
      `Output lamp: a minecraft:redstone_lamp at (${OUT.x}, ${OUT.y}, ${OUT.z}) — make it light per the table.\n\n` +
      `Build with set_blocks (supports blockstate strings like "minecraft:repeater[facing=east]"), ` +
      `place_shape, and place_blocks; inspect with get_blocks_at/describe_box. Use redstone_wire, ` +
      `redstone_torch (an inverter), repeaters, and solid blocks. The floor is at y=${FLOOR_Y}; build on ` +
      `y=${FLOOR_Y + 1} and above. Do NOT overwrite the feed cells or the lamp. When finished, reply DONE.`,

    /** Drive every input combo, read the lamp, score against the gate table. */
    async score() {
      const combos = enumerateInputs(n);
      const observed = [];
      for (const inputs of combos) {
        for (let i = 0; i < n; i++) {
          await cmd(`setblock ${IPOS[i].x} ${IPOS[i].y} ${IPOS[i].z} minecraft:${inputs[i] ? "redstone_block" : "air"}`);
        }
        await wait(400); // let redstone settle (LIVE knob: widen if propagation is slow)
        observed.push(await readLit(OUT));
      }
      // Reset inputs off.
      for (const p of IPOS) await cmd(`setblock ${p.x} ${p.y} ${p.z} minecraft:air`).catch(() => {});
      const scored = scoreObserved(gate, n, observed);
      return { metrics: { gate, n_in: n, accuracy: scored.accuracy, exact: scored.exact, rows_correct: scored.rows_correct, rows_total: scored.rows_total }, truth: { table, observed }, detail: scored.rows };
    },

    /** --dry apparatus check: power the lamp directly and confirm readLit toggles (no model). */
    async selfCheck() {
      const near = { x: OUT.x - 1, y: OUT.y, z: OUT.z };
      await cmd(`setblock ${near.x} ${near.y} ${near.z} minecraft:redstone_block`);
      await wait(400);
      const on = await readLit(OUT);
      await cmd(`setblock ${near.x} ${near.y} ${near.z} minecraft:air`);
      await wait(400);
      const off = await readLit(OUT);
      return { lamp_reads_on: on === true, lamp_reads_off: off === false, on, off };
    },

    async cleanup() {
      await clearBox(this.region.min, this.region.max);
      await releasePlot(this.plot);
    },
  };
}

export const SCENARIOS = { redstone: makeRedstonePuzzle };
