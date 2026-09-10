// interrogation (ABLATION_DESIGN.md §Scenarios 4): E2 is pure Q&A over E1's traversal — the
// highest-purity recall signal and the Track 2 (cloned-corpus) scenario, since E2 never mutates the
// world. Sized so B's tail overflows and C/D hit compaction (the harness asserts the construction
// guarantees rather than assuming them).

import * as stage from "./stage.mjs";
import { extractJson, posMatch, forbiddenCommands, factFunnel } from "../metrics.mjs";

const BASE_X = 104096;
const BASE_Z = 100000;
const WOOL = ["red_wool", "blue_wool", "yellow_wool"];

export function make(variant) {
  const v = ((variant - 1) % 3 + 3) % 3;
  const x0 = BASE_X + v * 1024;
  const z0 = BASE_Z;

  // Eight waypoints; four carry planted facts, four are cobble filler (so E1 generates enough
  // entries that B's tail overflows — sizing rule).
  const waypoints = Array.from({ length: 8 }, (_, i) => [x0 + i * 45, z0 + (i % 2 === 0 ? 0 : 30)]);
  const facts = {
    gold: { wp: 1, count: 3 + v, block: "minecraft:gold_block" },
    wool: { wp: 3, color: WOOL[v], height: 4 + v },
    emerald: { wp: 5, count: 6 - v, block: "minecraft:emerald_block" },
    hay: { wp: 6, count: 2 + v, block: "minecraft:hay_block" },
  };
  const factPos = (f) => [waypoints[f.wp][0], stage.Y + 1, waypoints[f.wp][1]];
  const start = [x0 - 30, stage.Y + 2, z0];

  return {
    name: "interrogation",
    variant,
    params: { x0, z0, waypoints, facts, start },
    dronePos: { x: start[0], y: start[1], z: start[2] },
    forkable: true, // E2 mutates nothing → valid Track 2 target

    async setup() {
      await stage.forceload(x0 - 48, z0 - 32, x0 + 8 * 45 + 16, z0 + 64);
      await stage.lockConditions();
      await stage.platform(start[0], start[2], 2, "minecraft:polished_andesite");
      for (let i = 0; i < waypoints.length; i++) {
        const [x, z] = waypoints[i];
        await stage.platform(x, z, 3, i % 2 ? "minecraft:stone" : "minecraft:cobblestone");
      }
      await stage.cluster(...waypoints[facts.gold.wp], facts.gold.block, facts.gold.count);
      await stage.tower(...waypoints[facts.wool.wp], `minecraft:${facts.wool.color}`, facts.wool.height);
      await stage.cluster(...waypoints[facts.emerald.wp], facts.emerald.block, facts.emerald.count);
      await stage.cluster(...waypoints[facts.hay.wp], facts.hay.block, facts.hay.count);
    },

    episodes: [
      {
        key: "e1",
        maxTurns: 60,
        prompt:
          `Patrol duty: survey the 8 raised waypoint platforms at these coordinates (all y=${stage.Y}):\n` +
          waypoints.map(([x, z], i) => `  W${i + 1}: (${x}, ${stage.Y}, ${z})`).join("\n") +
          `\nVisit each waypoint in order. At each, record what is built there — materials, exact ` +
          `block counts, structure heights, and positions. Empty platforms are worth recording too. ` +
          `Finish with a one-paragraph patrol summary.`,
      },
      {
        key: "e2",
        maxTurns: 20,
        prompt:
          `Debrief on your waypoint patrol — answer from memory (do NOT fly out or re-survey; the ` +
          `drone stays parked). Report exactly this JSON:\n` +
          "```json\n" +
          `{"gold": {"count": n, "pos": [x, y, z]}, "wool": {"color": "…", "height": n, "pos": [x, y, z]},\n` +
          ` "emerald": {"count": n, "pos": [x, y, z]}, "hay": {"count": n, "pos": [x, y, z]}}\n` +
          "```\n" +
          `pos is the waypoint platform where the structure stands (any block of it). If you do not ` +
          `know a value, use null — do not guess silently.`,
      },
    ],

    mutate: null,

    facts: Object.entries(facts).map(([key, f]) => ({
      key,
      pattern: key === "wool" ? `${f.color.replace("_wool", "")}[\\s\\S]{0,80}?wool|wool[\\s\\S]{0,80}?${f.height}` : `${key}|${f.block?.replace("minecraft:", "")}`,
      pos: factPos(f),
    })),

    async assert({ e2, memoryRoot, openingRender, e1 }) {
      const answer = extractJson(e2.finalText);
      const flags = [];
      for (const c of forbiddenCommands(e2.transcript)) flags.push(`forbidden_command:${c}`);
      // "answer from memory" — perception/goto use in E2 is re-surveying, flag it (not forbidden, but it
      // converts a recall test into a perception test).
      const resurvey = e2.transcript.filter((t) => t.type === "tool" && ["get_blocks", "raycast", "scene_summary", "bot_goto"].includes(t.name)).length;
      if (resurvey > 0) flags.push(`resurveyed_in_e2:${resurvey}`);

      const tol = 8; // any block of the platform counts
      const score = {};
      let exact = 0;
      let close = 0;
      const check = (key, gotCount, wantCount, gotPos, wantPos, extra = true) => {
        const p = posMatch(gotPos, wantPos, tol);
        const countExact = gotCount === wantCount && extra;
        const countClose = gotCount != null && Math.abs(gotCount - wantCount) <= 1 && extra;
        score[key] = { count_exact: countExact, count_close: countClose, pos_close: p.close };
        if (countExact && p.close) exact++;
        if (countClose && p.close) close++;
      };
      check("gold", answer?.gold?.count, facts.gold.count, answer?.gold?.pos, factPos(facts.gold));
      check("wool", answer?.wool?.height, facts.wool.height, answer?.wool?.pos, factPos(facts.wool), answer?.wool?.color?.includes(facts.wool.color.replace("_wool", "")));
      check("emerald", answer?.emerald?.count, facts.emerald.count, answer?.emerald?.pos, factPos(facts.emerald));
      check("hay", answer?.hay?.count, facts.hay.count, answer?.hay?.pos, factPos(facts.hay));

      const funnels = [];
      for (const f of this.facts) {
        funnels.push(await factFunnel({
          fact: f, memoryRoot, openingRender,
          e1Transcript: e1?.transcript, e2Transcript: e2.transcript,
          usedCorrectly: !!(score[f.key]?.count_exact && score[f.key]?.pos_close),
        }));
      }
      // Construction guarantees (recorded, not enforced): facts absent from the opening render but
      // present in L0 — the condition under which the D-vs-C contrast is actually exercised.
      const guarantees = {
        all_written: funnels.every((f) => f.written),
        any_in_render: funnels.some((f) => f.in_render),
        compaction_happened: funnels.some((f) => f.compacted),
      };

      return {
        success: exact === 4,
        metrics: { facts_exact: exact, facts_close: close, per_fact: score, funnels },
        guarantees,
        flags,
        answer,
        truth: facts,
      };
    },
  };
}
