// stash-and-retrieve, FIXED-SITE variant (ABLATION_DESIGN.md §Scenarios 1): harness-stocked chests
// at undisclosed locations E1 must discover — isolates memory-assisted retrieval from
// site-selection variance. (The self-sited variant is a full-grid addition, not built yet.)

import * as stage from "./stage.mjs";
import { extractJson, posMatch, targetedAcquisition, forbiddenCommands } from "../metrics.mjs";

const BASE_X = 100000;
const BASE_Z = 100000;
const ITEMS = ["minecraft:iron_ingot", "minecraft:gold_ingot", "minecraft:lapis_lazuli"];
const COUNTS = [12, 7, 21];

export function make(variant) {
  const v = ((variant - 1) % 3 + 3) % 3;
  const x0 = BASE_X + v * 1024;
  const z0 = BASE_Z;
  // Three chest platforms scattered along the corridor; layout rotates with the variant.
  const sites = [
    [x0 + 60, z0 + [0, 25, -20][v]],
    [x0 + 125, z0 + [35, -30, 10][v]],
    [x0 + 185, z0 + [-25, 10, 40][v]],
  ];
  const target = v; // which chest holds the target item
  const chests = sites.map(([x, z], i) => ({
    pos: [x, stage.Y + 1, z],
    item: ITEMS[(i + v) % 3],
    count: COUNTS[(i + v) % 3],
  }));
  const targetChest = chests.find((c) => c.item === ITEMS[target]);
  const start = [x0, stage.Y + 2, z0];

  return {
    name: "stash-fixed",
    variant,
    params: { x0, z0, chests, targetItem: ITEMS[target], start },
    dronePos: { x: start[0], y: start[1], z: start[2] },

    async setup() {
      await stage.forceload(x0 - 16, z0 - 64, x0 + 220, z0 + 64);
      await stage.lockConditions();
      await stage.platform(x0, z0, 3, "minecraft:polished_andesite");
      for (const c of chests) {
        await stage.platform(c.pos[0], c.pos[2], 2);
        await stage.chest(c.pos[0], c.pos[2], c.item, c.count);
      }
    },

    episodes: [
      {
        key: "e1",
        maxTurns: 40,
        prompt:
          `You are on a raised platform corridor at (${start.join(", ")}). Somewhere on the ` +
          `platforms scattered within ~200 blocks east of you (positive x) are three supply ` +
          `chests. Find all three, inspect each one's contents (run_command "data get block x y z" ` +
          `on the chest works), and make sure you'll know later exactly where each item is stored. ` +
          `Finish with a short report of what you found.`,
      },
      {
        key: "e2",
        maxTurns: 30,
        prompt:
          `You are back on the platform corridor at (${start.join(", ")}). One of the supply ` +
          `chests you catalogued holds ${ITEMS[target]}. Fly the drone to that chest, then give ` +
          `your final answer as JSON:\n` +
          "```json\n" +
          `{"target": {"pos": [x, y, z], "item": "…", "count": n}, "chests": [{"pos": [x, y, z], "item": "…", "count": n}, …]}\n` +
          "```",
      },
    ],

    /** All world state persists between episodes; nothing mutates. */
    mutate: null,

    facts: chests.map((c, i) => ({
      key: `chest-${i}`,
      pattern: `${c.item.replace("minecraft:", "")}[\\s\\S]{0,120}?${c.pos[0]}|${c.pos[0]}[\\s\\S]{0,120}?${c.item.replace("minecraft:", "")}`,
      pos: c.pos,
    })),

    async assert({ e2 }) {
      const answer = extractJson(e2.finalText);
      const flags = [];
      for (const cmd of [...forbiddenCommands(e2.transcript)]) flags.push(`forbidden_command:${cmd}`);

      const t = answer?.target ?? {};
      const targetPos = posMatch(t.pos, targetChest.pos, 2);
      const targetOk = targetPos.close && t.item === targetChest.item && Math.abs((t.count ?? -99) - targetChest.count) <= 0;
      let othersOk = 0;
      for (const c of chests) {
        const found = (answer?.chests ?? []).find((a) => posMatch(a?.pos, c.pos, 2).close);
        if (found && found.item === c.item && found.count === c.count) othersOk++;
      }
      // Prefer the position run.mjs captured before despawn; fall back to the transcript's last
      // bot_status result (offline re-scoring path). Never query live — the drone is gone by now.
      let dronePos = e2.final_drone_pos ?? null;
      if (!dronePos) {
        for (const t of e2.transcript.slice().reverse()) {
          if (t.type === "tool" && t.name === "bot_status" && t.result?.ok && t.result.result?.pos) {
            const p = t.result.result.pos;
            dronePos = [p.x, p.y, p.z].map(Math.round);
            break;
          }
        }
      }
      const droneAtTarget = dronePos ? Math.hypot(...dronePos.map((p, i) => p - targetChest.pos[i])) <= 8 : false;

      return {
        success: targetOk && droneAtTarget,
        metrics: {
          target_answer_correct: targetOk,
          target_pos_exact: targetPos.exact,
          chests_fully_correct: othersOk,
          drone_at_target: droneAtTarget,
          acquisition: targetedAcquisition(e2.transcript, targetChest.pos, 12),
        },
        flags,
        answer,
        truth: { target: targetChest, chests },
      };
    },
  };
}
