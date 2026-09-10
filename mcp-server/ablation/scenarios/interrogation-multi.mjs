// interrogation-multi (full grid; ABLATION_DESIGN pilot finding): three patrol episodes over three
// separate strips build a MULTI-BLOCK memory corpus before the debrief — the regime where knowing
// WHICH block covers a fact is no longer readable off the session render, so mem_recall (D) can
// actually differentiate from manual mem_read drilling (C). Rule 3's discriminator. E2 mutates
// nothing → valid Track 2 fork target.

import * as stage from "./stage.mjs";
import { extractJson, posMatch, forbiddenCommands, factFunnel, toolCalls } from "../metrics.mjs";

const BASE_X = 112288;
const BASE_Z = 100000;
const WOOL = ["red_wool", "blue_wool", "yellow_wool"];

export function make(variant) {
  const v = ((variant - 1) % 3 + 3) % 3;
  const x0 = BASE_X + v * 1024;
  const z0 = BASE_Z;

  // Three strips of 4 waypoints each, well separated in z; two planted facts per strip.
  const strip = (sz) => Array.from({ length: 4 }, (_, i) => [x0 + i * 45, sz + (i % 2 === 0 ? 0 : 25)]);
  const strips = [strip(z0), strip(z0 + 140), strip(z0 + 280)];
  const facts = {
    gold: { strip: 0, wp: 1, count: 3 + v, block: "minecraft:gold_block", kind: "cluster" },
    wool: { strip: 0, wp: 3, color: WOOL[v], height: 4 + v, kind: "tower" },
    emerald: { strip: 1, wp: 0, count: 6 - v, block: "minecraft:emerald_block", kind: "cluster" },
    hay: { strip: 1, wp: 2, count: 2 + v, block: "minecraft:hay_block", kind: "cluster" },
    bookshelf: { strip: 2, wp: 1, height: 3 + v, block: "minecraft:bookshelf", kind: "tower" },
    copper: { strip: 2, wp: 3, count: 4 + v, block: "minecraft:copper_block", kind: "cluster" },
  };
  const factPos = (f) => [strips[f.strip][f.wp][0], stage.Y + 1, strips[f.strip][f.wp][1]];
  const start = [x0 - 30, stage.Y + 2, z0];

  const patrolPrompt = (n, wps) =>
    `Patrol duty, sector ${n} of 3: survey the 4 raised waypoint platforms (all y=${stage.Y}):\n` +
    wps.map(([x, z], i) => `  S${n}-W${i + 1}: (${x}, ${stage.Y}, ${z})`).join("\n") +
    `\nVisit each in order; record what is built there — materials, exact counts, heights, ` +
    `positions. Empty platforms count too. Finish with a one-line sector summary.`;

  return {
    name: "interrogation-multi",
    variant,
    params: { x0, z0, strips, facts, start },
    dronePos: { x: start[0], y: start[1], z: start[2] },
    forkable: true,

    async setup() {
      await stage.forceload(x0 - 48, z0 - 32, x0 + 4 * 45 + 16, z0 + 320);
      await stage.lockConditions();
      await stage.platform(start[0], start[2], 2, "minecraft:polished_andesite");
      for (const wps of strips) {
        for (let i = 0; i < wps.length; i++) {
          await stage.platform(wps[i][0], wps[i][1], 3, i % 2 ? "minecraft:stone" : "minecraft:cobblestone");
        }
      }
      for (const f of Object.values(facts)) {
        const [x, z] = strips[f.strip][f.wp];
        if (f.kind === "tower") await stage.tower(x, z, f.color ? `minecraft:${f.color}` : f.block, f.height);
        else await stage.cluster(x, z, f.block, f.count);
      }
    },

    episodes: [
      { key: "e1a", maxTurns: 35, prompt: patrolPrompt(1, strips[0]) },
      { key: "e1b", maxTurns: 35, prompt: patrolPrompt(2, strips[1]) },
      { key: "e1c", maxTurns: 35, prompt: patrolPrompt(3, strips[2]) },
      {
        key: "e2",
        maxTurns: 20,
        prompt:
          `Debrief across all three patrol sectors — answer from memory (do NOT fly out or ` +
          `re-survey; the drone stays parked). Report exactly this JSON:\n` +
          "```json\n" +
          `{"gold": {"count": n, "pos": [x, y, z]}, "emerald": {"count": n, "pos": [x, y, z]},\n` +
          ` "bookshelf": {"height": n, "pos": [x, y, z]}, "hay": {"count": n, "pos": [x, y, z]}}\n` +
          "```\n" +
          `pos is the waypoint platform where the structure stands (any block of it). Use null for ` +
          `anything you do not know — do not guess silently.`,
      },
    ],

    mutate: null,

    facts: Object.entries(facts).map(([key, f]) => ({
      key,
      pattern: f.color ? `${f.color.replace("_wool", "")}[\\s\\S]{0,80}?wool` : `${key}|${f.block.replace("minecraft:", "")}`,
      pos: factPos(f),
    })),

    async assert({ e2, episodes, memoryRoot, openingRender }) {
      const answer = extractJson(e2.finalText);
      const flags = [];
      for (const c of forbiddenCommands(e2.transcript)) flags.push(`forbidden_command:${c}`);
      const resurvey = toolCalls(e2.transcript).filter((c) => ["get_blocks", "raycast", "scene_summary", "bot_goto"].includes(c.name)).length;
      if (resurvey > 0) flags.push(`resurveyed_in_e2:${resurvey}`);

      const tol = 8;
      const asked = ["gold", "emerald", "bookshelf", "hay"];
      const score = {};
      let exact = 0;
      for (const key of asked) {
        const f = facts[key];
        const got = answer?.[key] ?? {};
        const val = f.kind === "tower" ? got.height : got.count;
        const want = f.kind === "tower" ? f.height : f.count;
        const p = posMatch(got.pos, factPos(f), tol);
        score[key] = { value_exact: val === want, pos_close: p.close };
        if (val === want && p.close) exact++;
      }

      // The union of all patrol transcripts backs the funnel's "observed" stage.
      const e1Union = ["e1a", "e1b", "e1c"].flatMap((k) => episodes?.[k]?.transcript ?? []);
      const funnels = [];
      for (const f of this.facts.filter((f) => asked.includes(f.key))) {
        funnels.push(await factFunnel({
          fact: f, memoryRoot, openingRender,
          e1Transcript: e1Union, e2Transcript: e2.transcript,
          usedCorrectly: !!(score[f.key]?.value_exact && score[f.key]?.pos_close),
        }));
      }
      const recallCalls = toolCalls(e2.transcript).filter((c) => c.name === "mem_recall").length;
      const readCalls = toolCalls(e2.transcript).filter((c) => c.name === "mem_read").length;
      const guarantees = {
        all_written: funnels.every((f) => f.written),
        multi_block: (funnels[0]?.blocks_total ?? 0) >= 2, // the whole point of this construction
        compaction_happened: funnels.some((f) => f.compacted),
      };

      return {
        success: exact === 4,
        metrics: {
          facts_exact: exact, per_fact: score, funnels,
          retrieval_calls: { mem_recall: recallCalls, mem_read: readCalls },
        },
        guarantees,
        flags,
        answer,
        truth: Object.fromEntries(asked.map((k) => [k, facts[k]])),
      };
    },
  };
}
