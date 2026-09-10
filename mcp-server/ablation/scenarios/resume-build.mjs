// resume-build (ABLATION_DESIGN §Scenarios 2): the spec is given ONCE in E1; E1 is turn-capped
// mid-build BY DESIGN; E2 says only "continue where you left off". Scored as E2's delta toward the
// spec from this run's own E1 endpoint (paired within run — rev 2 rejected canonical-restore).
// The spec is four corner pillars with per-corner materials and heights — half the structure does
// not imply the rest, so finishing E2 requires the spec, not inference.

import * as stage from "./stage.mjs";
import { cmd } from "../bridge.mjs";
import { forbiddenCommands, toolCalls } from "../metrics.mjs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const BASE_X = 116384;
const BASE_Z = 100000;
const MATERIALS = ["minecraft:copper_block", "minecraft:iron_block", "minecraft:gold_block", "minecraft:lapis_block"];

export function make(variant) {
  const v = ((variant - 1) % 3 + 3) % 3;
  const x0 = BASE_X + v * 1024;
  const z0 = BASE_Z;
  const mat = (i) => MATERIALS[(i + v) % 4];

  // Four pillars on a 9×9 platform; heights vary per corner (10 blocks total).
  const pillars = [
    { name: "NE", x: x0 + 3, z: z0 - 3, material: mat(0), height: 3 },
    { name: "NW", x: x0 - 3, z: z0 - 3, material: mat(1), height: 2 },
    { name: "SE", x: x0 + 3, z: z0 + 3, material: mat(2), height: 2 },
    { name: "SW", x: x0 - 3, z: z0 + 3, material: mat(3), height: 3 },
  ];
  const specCells = pillars.flatMap((p) =>
    Array.from({ length: p.height }, (_, i) => ({ x: p.x, y: stage.Y + 1 + i, z: p.z, block: p.material })));
  const start = [x0, stage.Y + 2, z0];

  const specText = pillars
    .map((p) => `  ${p.name} pillar at (${p.x}, ${p.z}): ${p.material}, ${p.height} blocks tall (y ${stage.Y + 1}..${stage.Y + p.height})`)
    .join("\n");

  return {
    name: "resume-build",
    variant,
    params: { x0, z0, pillars, start, spec_cells: specCells.length },
    dronePos: { x: start[0], y: start[1], z: start[2] },

    async setup() {
      await stage.forceload(x0 - 16, z0 - 16, x0 + 16, z0 + 16);
      await stage.lockConditions();
      await stage.platform(x0, z0, 4, "minecraft:smooth_stone");
      // Idempotent: clear any pillar remnants from a previous run.
      for (const p of pillars) await stage.clear(p.x, stage.Y + 1, p.z, p.x, stage.Y + 4, p.z);
    },

    episodes: [
      {
        key: "e1",
        maxTurns: 12, // capped mid-build BY DESIGN
        prepare: async (bridge) => {
          for (const m of MATERIALS) await bridge("bot_give", { item: m, count: 6 });
        },
        prompt:
          `Construction order — this specification is given ONCE, it will not be repeated:\n${specText}\n` +
          `Your drone carries all materials. Build the four pillars with bot_place (fly within ` +
          `reach first; bot_select or the item parameter picks the block). Sessions are short — ` +
          `you may well not finish this one, so make sure you can pick the work up later.`,
      },
      {
        key: "e2",
        maxTurns: 30,
        prepare: async (bridge) => {
          for (const m of MATERIALS) await bridge("bot_give", { item: m, count: 6 });
        },
        prompt: `Back on site. Continue where you left off and finish the job.`,
      },
    ],

    mutate: null,

    /** Snapshot spec compliance at each episode boundary via `execute if block` (mechanical, harness-side). */
    async checkpoint() {
      const cells = [];
      for (const c of specCells) {
        const filled = await cmd(`execute if block ${c.x} ${c.y} ${c.z} ${c.block}`);
        const ok = (filled.output ?? []).some((l) => /passed/i.test(l));
        let occupied = ok;
        if (!ok) {
          const air = await cmd(`execute if block ${c.x} ${c.y} ${c.z} minecraft:air`);
          occupied = !(air.output ?? []).some((l) => /passed/i.test(l));
        }
        cells.push({ ...c, correct: ok, wrong_block: !ok && occupied });
      }
      return {
        correct: cells.filter((c) => c.correct).length,
        wrong: cells.filter((c) => c.wrong_block).length,
        total: cells.length,
        cells: cells.map((c) => `${c.x},${c.y},${c.z}:${c.correct ? "ok" : c.wrong_block ? "WRONG" : "empty"}`),
      };
    },

    facts: [],

    async assert({ e2, checkpoints, memoryRoot }) {
      const flags = [];
      for (const c of forbiddenCommands(e2.transcript)) flags.push(`forbidden_command:${c}`);
      const after1 = checkpoints?.e1 ?? { correct: 0, wrong: 0, total: specCells.length };
      const after2 = checkpoints?.e2 ?? { correct: 0, wrong: 0, total: specCells.length };
      const remaining = after1.total - after1.correct;
      const delta = after2.correct - after1.correct;

      // Was the spec actually stored? (Formation vs resume failure — rev 2 diagnostic.)
      let specStored = false;
      try {
        const worldDirs = (await readdir(memoryRoot, { withFileTypes: true })).filter((d) => d.isDirectory() && d.name !== "index");
        for (const d of worldDirs) {
          let corpus = "";
          for (const f of ["log.jsonl", "blocks.jsonl", "tasks.json"]) {
            corpus += await readFile(join(memoryRoot, d.name, f), "utf8").catch(() => "");
          }
          const mentioned = pillars.filter((p) => corpus.includes(p.material.replace("minecraft:", "")) && corpus.includes(String(p.x))).length;
          if (mentioned >= 3) specStored = true;
        }
      } catch { /* condition a has no memory dir */ }

      return {
        success: after2.correct === after2.total && after2.wrong === 0,
        metrics: {
          correct_after_e1: after1.correct,
          correct_after_e2: after2.correct,
          wrong_after_e2: after2.wrong,
          e2_delta: delta,
          e2_completion_of_remaining: remaining > 0 ? +(delta / remaining).toFixed(2) : 1,
          spec_stored: specStored,
          e2_place_calls: toolCalls(e2.transcript).filter((c) => c.name === "bot_place").length,
        },
        flags,
        answer: null,
        truth: { pillars, spec_cells: specCells.length },
      };
    },
  };
}
