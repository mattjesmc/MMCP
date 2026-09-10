// stash-and-retrieve, SELF-SITED variant (ABLATION_DESIGN §Scenarios 1): the agent chooses its own
// cache sites and places marker blocks there — the full product loop including site selection and
// self-authored memory. (Marker blocks, not chests: the mod has no bot-side chest deposit; the
// memory question — "can you return to a place YOU chose?" — is identical.) Truth is read from the
// world by the harness, not from the agent's claims.

import * as stage from "./stage.mjs";
import { bridge } from "../bridge.mjs";
import { extractJson, posMatch, targetedAcquisition, forbiddenCommands, dist } from "../metrics.mjs";

const BASE_X = 120480;
const BASE_Z = 100000;
const MARKERS = ["minecraft:gold_block", "minecraft:emerald_block", "minecraft:lapis_block"];

export function make(variant) {
  const v = ((variant - 1) % 3 + 3) % 3;
  const x0 = BASE_X + v * 1024;
  const z0 = BASE_Z;
  const stripLen = 220;
  const target = MARKERS[v]; // which marker E2 must return to
  const start = [x0, stage.Y + 2, z0];

  return {
    name: "stash-self",
    variant,
    params: { x0, z0, stripLen, target, start },
    dronePos: { x: start[0], y: start[1], z: start[2] },

    async setup() {
      await stage.forceload(x0 - 16, z0 - 16, x0 + stripLen + 16, z0 + 16);
      await stage.lockConditions();
      // One long walkway strip; clear the air above so previous markers vanish.
      await stage.clear(x0 - 8, stage.Y, z0 - 8, x0 + stripLen + 8, stage.Y + 6, z0 + 8);
      await bridge("run_command", { command: `fill ${x0} ${stage.Y} ${z0 - 2} ${x0 + stripLen} ${stage.Y} ${z0 + 2} minecraft:smooth_stone` });
    },

    episodes: [
      {
        key: "e1",
        maxTurns: 30,
        prepare: async (bridge) => {
          for (const m of MARKERS) await bridge("bot_give", { item: m, count: 1 });
        },
        prompt:
          `Cache-siting duty. You are at the west end of a long stone strip running east (positive ` +
          `x, about ${220} blocks). Your drone carries three marker blocks: gold, emerald, lapis. ` +
          `Choose three distinct cache sites of your own along the strip, at least 60 blocks apart, ` +
          `and place one marker at each (bot_place on top of the strip). The sites are yours to ` +
          `pick — what matters is that you can find each one again later, exactly.`,
      },
      {
        key: "e2",
        maxTurns: 25,
        prompt:
          `Retrieval: fly the drone to YOUR ${target.replace("minecraft:", "").replace("_block", "")} ` +
          `cache marker and hold position there. Then report all three cache sites as JSON:\n` +
          "```json\n" +
          `{"gold": [x, y, z], "emerald": [x, y, z], "lapis": [x, y, z]}\n` +
          "```",
      },
    ],

    mutate: null,
    facts: [],

    /** Ground truth = where the markers actually are, scanned from the world. */
    async findMarkers() {
      const found = {};
      for (let seg = 0; seg <= Math.ceil(stripLen / 80); seg++) {
        const r = await bridge("get_blocks", {
          origin: { x: x0 + seg * 80 + 40, y: stage.Y, z: z0 },
          grid: 48, heightmap: "motion_blocking",
        });
        if (!r.ok) continue;
        for (const b of r.result.blocks ?? []) {
          if (MARKERS.includes(b.block)) found[b.block] = [b.x, b.y, b.z];
        }
      }
      return found;
    },

    async assert({ e2 }) {
      const answer = extractJson(e2.finalText);
      const flags = [];
      for (const c of forbiddenCommands(e2.transcript)) flags.push(`forbidden_command:${c}`);

      const actual = await this.findMarkers();
      const placedAll = MARKERS.every((m) => actual[m]);
      if (!placedAll) flags.push(`markers_missing:${MARKERS.filter((m) => !actual[m]).join(",")}`);

      // Spacing compliance (metric, not success): min pairwise distance of actual sites.
      const sites = Object.values(actual);
      let minSpacing = null;
      for (let i = 0; i < sites.length; i++) {
        for (let j = i + 1; j < sites.length; j++) {
          const d = dist(sites[i], sites[j]);
          minSpacing = minSpacing === null ? d : Math.min(minSpacing, d);
        }
      }

      let reportedExact = 0;
      for (const m of MARKERS) {
        const key = m.replace("minecraft:", "").replace("_block", "");
        if (actual[m] && posMatch(answer?.[key], actual[m], 1).close) reportedExact++;
      }
      const targetPos = actual[target] ?? null;
      const droneAt = e2.final_drone_pos && targetPos
        ? dist(e2.final_drone_pos, targetPos) <= 8
        : false;

      return {
        success: placedAll && droneAt && reportedExact === 3,
        metrics: {
          markers_placed: Object.keys(actual).length,
          min_spacing: minSpacing === null ? null : Math.round(minSpacing),
          spacing_ok: minSpacing !== null && minSpacing >= 60,
          reported_exact: reportedExact,
          drone_at_target: droneAt,
          acquisition: targetPos ? targetedAcquisition(e2.transcript, targetPos, 12) : null,
        },
        flags,
        answer,
        truth: { actual, target },
      };
    },
  };
}
