// stale-fact (ABLATION_DESIGN.md §Scenarios 3): the harness mutates the world between episodes;
// E2 measures whether remembered state is verified before being relied on. Traveling to the old
// location to LOOK is rational use of memory — never an error. Mutations run via privileged
// run_command with no drone spawned (no pending-candidate leak); raw get_events polling in E2 is
// detected and flagged, not prevented.

import * as stage from "./stage.mjs";
import { cmd } from "../bridge.mjs";
import {
  extractJson, posMatch, forbiddenCommands, polledRawEvents, perceivedNear, dataReadNear, toolCalls,
} from "../metrics.mjs";

const BASE_X = 108192;
const BASE_Z = 100000;
const ITEMS = ["minecraft:iron_ingot", "minecraft:copper_ingot", "minecraft:coal"];

export function make(variant) {
  const v = ((variant - 1) % 3 + 3) % 3;
  const x0 = BASE_X + v * 1024;
  const z0 = BASE_Z;

  const depot = [x0 + 80, z0];                       // depot platform center
  const chestOld = [depot[0] - 1, stage.Y + 1, depot[1] - 1];
  const chestNew = [depot[0] + [18, 22, 20][v], stage.Y + 1, depot[1] + [14, -12, 16][v]];
  const item = ITEMS[v];
  const count = [9, 14, 30][v];
  const bridgeZ = z0 + 40;                            // walkway between two side platforms
  const bridgeX = [x0 + 40, x0 + 100];
  const bridgeMid = [Math.round((bridgeX[0] + bridgeX[1]) / 2), stage.Y, bridgeZ];
  const start = [x0, stage.Y + 2, z0];

  return {
    name: "stale-fact",
    variant,
    params: { x0, z0, depot, chestOld, chestNew, item, count, bridgeMid, start },
    dronePos: { x: start[0], y: start[1], z: start[2] },

    async setup() {
      await stage.forceload(x0 - 16, z0 - 32, x0 + 140, z0 + 80);
      await stage.lockConditions();
      await stage.platform(start[0], start[2], 2, "minecraft:polished_andesite");
      await stage.platform(depot[0], depot[1], 4, "minecraft:stone_bricks");
      // Ensure the new-chest site starts empty and the old chest exists and is stocked.
      await stage.clear(chestNew[0] - 1, stage.Y, chestNew[2] - 1, chestNew[0] + 1, stage.Y + 3, chestNew[2] + 1);
      await stage.platform(chestNew[0], chestNew[2], 1);
      await stage.chest(chestOld[0], chestOld[2], item, count);
      // The "bridge": two anchor platforms joined by a plank walkway.
      await stage.platform(bridgeX[0], bridgeZ, 2);
      await stage.platform(bridgeX[1], bridgeZ, 2);
      await stage.walkway(bridgeX[0], bridgeX[1], bridgeZ);
    },

    episodes: [
      {
        key: "e1",
        maxTurns: 30,
        prompt:
          `Inspect the depot area east of your start platform at (${start.join(", ")}): there is a ` +
          `depot platform around (${depot[0]}, ${stage.Y}, ${depot[1]}) with a supply chest, and a ` +
          `plank walkway bridge near z=${bridgeZ} connecting two platforms. Record the chest's exact ` +
          `position and contents (run_command "data get block x y z") and the bridge's state. ` +
          `Finish with a short status report.`,
      },
      {
        key: "e2",
        maxTurns: 30,
        prompt:
          `Status check on the depot area. Report the CURRENT state as JSON:\n` +
          "```json\n" +
          `{"chest": {"pos": [x, y, z], "item": "…", "count": n}, "bridge_intact": true|false}\n` +
          "```\n" +
          `Your report must reflect what is true right now, not what was true last time. If ` +
          `something is not where or how you remember it, track down its current state (the depot ` +
          `area is small) before reporting.`,
      },
    ],

    /** Between episodes, with no drone spawned: move + restock the chest, break the bridge middle. */
    async mutate() {
      await cmd(`setblock ${chestOld[0]} ${chestOld[1]} ${chestOld[2]} minecraft:air`);
      await cmd(`setblock ${chestNew[0]} ${chestNew[1]} ${chestNew[2]} minecraft:chest`);
      await cmd(`item replace block ${chestNew[0]} ${chestNew[1]} ${chestNew[2]} container.0 with ${item} ${count}`);
      await cmd(`fill ${bridgeMid[0] - 1} ${stage.Y} ${bridgeZ} ${bridgeMid[0] + 1} ${stage.Y} ${bridgeZ + 1} minecraft:air`);
    },

    facts: [
      { key: "chest", pattern: `${item.replace("minecraft:", "")}|chest[\\s\\S]{0,80}?${chestOld[0]}`, pos: chestOld },
      { key: "bridge", pattern: "bridge|walkway|plank", pos: bridgeMid },
    ],

    async assert({ e2 }) {
      const answer = extractJson(e2.finalText);
      const flags = [];
      for (const c of forbiddenCommands(e2.transcript)) flags.push(`forbidden_command:${c}`);
      if (polledRawEvents(e2.transcript)) flags.push("possible_leak:polled_raw_events");

      // Verification attempts: re-observation of the chest sites / bridge before the final answer.
      const verifiedChestSite =
        perceivedNear(e2.transcript, chestOld, 24) || dataReadNear(e2.transcript, chestOld, 6) ||
        perceivedNear(e2.transcript, chestNew, 24) || dataReadNear(e2.transcript, chestNew, 6);
      const verifiedBridge = perceivedNear(e2.transcript, bridgeMid, 40) ||
        toolCalls(e2.transcript).some((c) => c.name === "raycast");

      const chestPosNew = posMatch(answer?.chest?.pos, chestNew, 3);
      const chestPosOld = posMatch(answer?.chest?.pos, chestOld, 3);
      const chestCorrect = chestPosNew.close && answer?.chest?.item === item && answer?.chest?.count === count;
      const bridgeCorrect = answer?.bridge_intact === false;

      // Rev-2 taxonomy: stale_assumption = reported remembered state as current without re-observing
      // the subject; verification_attempt is GOOD regardless of the answer.
      const staleChest = chestPosOld.close && !verifiedChestSite;
      const staleBridge = answer?.bridge_intact === true && !verifiedBridge;
      const memVerifies = toolCalls(e2.transcript).filter((c) => c.name === "mem_verify");
      const contradictionRecorded = memVerifies.some((c) => c.input?.result === "contradicted");

      return {
        success: chestCorrect && bridgeCorrect,
        metrics: {
          chest_correct: chestCorrect,
          bridge_correct: bridgeCorrect,
          verification_attempt: { chest: verifiedChestSite, bridge: verifiedBridge },
          stale_assumption: { chest: staleChest, bridge: staleBridge },
          stale_assumptions_total: (staleChest ? 1 : 0) + (staleBridge ? 1 : 0),
          contradiction_recorded: contradictionRecorded,
        },
        flags,
        answer,
        truth: { chest: { pos: chestNew, item, count }, bridge_intact: false },
      };
    },
  };
}
