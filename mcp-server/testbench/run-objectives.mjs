#!/usr/bin/env node
// Embodied-objective orchestrator — E-survive-build, the milestone ladder, and the dungeon capstone
// (objective-scenario.mjs). Per seed × family: spawn a body, run ONE embodied session, let the world
// settle, then evaluate objectives from server truth. survive is scored by build-score (silhouette
// coverage); ladder/dungeon by progress-score (deepest consecutive milestone + tokens/milestone).
//
//   node testbench/run-objectives.mjs --dry --family ladder            # stage + baseline truth, no model
//   node testbench/run-objectives.mjs --model haiku --family survive
//   node testbench/run-objectives.mjs --model haiku --family ladder,dungeon --seeds 1

import { createHash } from "node:crypto";
import { BENCH_VERSION } from "./version.mjs";
import { routesHashForRun } from "./routes-pin.mjs";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { bridge, fetchManifest } from "../ablation/bridge.mjs";
import { runEpisodeSdk } from "../ablation/runner-sdk.mjs";
import { toolCounts } from "../ablation/metrics.mjs";
import { FAMILIES, EMBODIED_TOOLS } from "./objective-scenario.mjs";
import { sequentialProgress, costPerMilestone } from "./progress-score.mjs";
import { bothTok, zeroTok, accTok } from "./tokens.mjs";

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
const MODEL = opt("model", "haiku");
const SEEDS = parseInt(opt("seeds", "1"), 10);
const FAMS = opt("family", "survive,ladder,dungeon").split(",").filter((f) => FAMILIES[f]);
const DRY = argv.includes("--dry");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIM = join(HERE, "..", "ablation", "mcp-shim.mjs");
const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const cfgModel = process.env.MCPTK_ABLATION_MODEL || (MODEL === "haiku" ? "claude-haiku-4-5-20251001" : MODEL);

const CHARTER = `You are an autonomous Minecraft PLAYER controlling your own body — a drone actuator \
with a hotbar, hands, and server-run reflexes. You are NOT an omniscient copilot; you perceive through \
your senses (sense_entities/scene_summary) and act with bot_goto/bot_mine/bot_place/bot_use/bot_attack. \
Move within reach before acting (block reach is ~4.5 blocks from your body). Work through multi-step \
objectives methodically, checking bot_status (inventory:true) to confirm each step before moving on.`;

const isLadder = (fam) => fam === "ladder" || fam === "dungeon";

const ping = await bridge("ping", {});
if (!ping.ok) { console.error(`no bridge — start the dev server first (${ping.error})`); process.exit(1); }
const manifest = await fetchManifest();
const known = new Set(manifest.map((t) => t.name));
for (const n of EMBODIED_TOOLS) if (!known.has(n)) throw new Error(`unknown tool "${n}" — is the embodied surface present?`);

const instances = [];
for (const fam of FAMS) for (let seed = 1; seed <= SEEDS; seed++) instances.push({ fam, s: FAMILIES[fam](seed) });
const questionsHash = sha(JSON.stringify(instances.map(({ fam, s }) => ({ fam, seed: s.seed }))));
console.log(`Embodied objectives — families [${FAMS.join(",")}] × ${SEEDS} seeds, questions ${questionsHash}`);

/** Aggregate a family's raw score into a uniform metrics object. */
function aggregate(fam, raw, out) {
  if (isLadder(fam)) {
    const steps = raw.results.map((r) => ({ key: r.key, done: r.done, tokens: 0, turns: 0 }));
    // attribute total tokens/turns to the whole ladder (per-step attribution needs interleaved scoring)
    const p = sequentialProgress(steps);
    const cost = costPerMilestone(steps.map((st, i) => ({ ...st, tokens: i === 0 ? (out?.usage?.output_tokens ?? 0) : 0, turns: i === 0 ? (out?.turns ?? 0) : 0 })));
    return {
      metrics: {
        total: p.total, deepest: p.deepest, done: p.done, completed_all: p.completed_all,
        stalled_key: p.stalled_key, skipped: p.skipped,
        objectives: raw.results.map((r) => `${r.key}:${r.done ? "✓" : "✗"}`).join(" "),
        tokens_per_milestone: cost.tokens_per_milestone,
      },
      truth: { results: raw.results },
    };
  }
  return raw; // survive already returns {metrics, truth}
}

if (DRY) {
  for (const { fam, s } of instances) {
    console.log(`\n=== ${fam} seed ${s.seed} ===`);
    await s.setup();
    await bridge("bot_body", { action: "despawn" });
    await bridge("bot_body", { action: "spawn",  pos: s.dronePos });
    if (s.prepare) await s.prepare();
    const raw = await s.score();
    const agg = aggregate(fam, raw, null);
    console.log(`  tools: ${s.toolsFor().length} embodied`);
    console.log(`  baseline objective truth (no agent action): ${JSON.stringify(agg.metrics)}`);
    await bridge("bot_body", { action: "despawn" });
    await s.cleanup();
  }
  console.log(`\n[dry] staged + evaluated baseline objective truth (all objectives should read false/0 — ` +
    `nothing acted yet). Embodiment (reach/pathing) is the live knob; scoring cores are unit-tested. No model spend.`);
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = join(HERE, "..", "testbench-results", `${stamp}-objectives-${MODEL}`);
await mkdir(join(outDir, "nomem"), { recursive: true });
const answersPath = join(outDir, "answers.jsonl");
await writeFile(answersPath, "", "utf8");
const toolsHash = sha(JSON.stringify(manifest.map((t) => [t.name, t.description])));
// The vocabulary axis (ROUTE_LEDGER_DESIGN.md §8). `tools_hash` fingerprints the manifest, which the
// route layer never touches — so without this a run whose routes differ pools silently with one
// whose routes do not. routes-pin.mjs both applies the pin and reports it, so the manifest cannot
// record a mode the run did not execute.
const routesHash = routesHashForRun();

await writeFile(join(outDir, "manifest.json"), JSON.stringify({
  date: new Date().toISOString(), bench_version: BENCH_VERSION, category: "e", slice: "objectives", families: FAMS, model: MODEL, model_id: cfgModel,
  seeds: SEEDS, git_head: execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: HERE }).toString().trim(),
  questions_hash: questionsHash, tools: EMBODIED_TOOLS, tools_hash: toolsHash, routes_hash: routesHash, substrate: "claude-agent-sdk/max-subscription",
}, null, 2), "utf8");

const rows = [];
for (const { fam, s } of instances) {
  console.log(`\n[${fam} s${s.seed}] setup`);
  await s.setup();
  const tag = `${s.name}-s${s.seed}`;
  try {
    await bridge("bot_body", { action: "despawn" });
    const spawn = await bridge("bot_body", { action: "spawn",  pos: s.dronePos });
    if (!spawn.ok) throw new Error(`bot_body spawn failed: ${spawn.error}`);
    if (s.prepare) await s.prepare();
    const tools = s.toolsFor();
    const transcriptPath = join(outDir, `transcript-${tag}.jsonl`);
    // Transient milestones (inventory holdings, body-in-region) must be observed WHILE they hold —
    // pollLatch latches each step the first time it is seen done (see objective-scenario.mjs).
    const latchTimer = s.pollLatch ? setInterval(() => { s.pollLatch().catch(() => {}); }, 3000) : null;
    let out;
    try {
      out = await runEpisodeSdk({
        model: cfgModel, system: CHARTER, prompt: s.prompt(), maxTurns: s.maxTurns,
        shimPath: SHIM,
        shimEnv: {
          MCPTK_ABLATION_CONDITION: "a", MCPTK_MEMORY_DIR: join(outDir, "nomem"),
          MCPTK_WORLD_TOOLS: tools.join(","), MCPTK_ABLATION_TRANSCRIPT: transcriptPath,
        },
        allowedToolNames: tools, toolTranscriptPath: transcriptPath,
        sdkLogPath: join(outDir, `sdk-${tag}.jsonl`), log: (l) => console.log(`  [${tag}] ${l}`),
      });
      if (s.observeWindowMs) await wait(s.observeWindowMs);
    } finally {
      if (latchTimer) clearInterval(latchTimer);
    }
    if (s.pollLatch) await s.pollLatch().catch(() => {}); // one final sweep before scoring
    const raw = await s.score();
    const agg = aggregate(fam, raw, out);
    const rec = {
      family: fam, scenario: s.name, seed: s.seed, model: MODEL, ...agg.metrics, truth: agg.truth,
      turns: out.turns, subtype: out.subtype, capped: out.capped, tool_counts: toolCounts(out.transcript),
      tokens_in: out.usage.input_tokens, tokens_out: out.usage.output_tokens,
      cache_read: out.usage.cache_read_input_tokens, cache_write: out.usage.cache_creation_input_tokens,
    };
    rows.push(rec);
    await appendFile(answersPath, JSON.stringify(rec) + "\n", "utf8");
    console.log(`  [${tag}] ${JSON.stringify(agg.metrics)} — ${out.turns}t`);
    await bridge("bot_body", { action: "despawn" });
  } catch (e) {
    const rec = { family: fam, scenario: s.name, seed: s.seed, error: String(e) };
    rows.push(rec);
    await appendFile(answersPath, JSON.stringify(rec) + "\n", "utf8");
    console.log(`  [${tag}] ERROR ${e}`);
  }
  await s.cleanup();
}

const good = rows.filter((r) => !r.error);
const lines = [`# Embodied objectives — ${stamp}, model ${MODEL}`, "",
  `families [${FAMS.join(",")}] × ${SEEDS} seeds, questions ${questionsHash}`, ""];
const ladderRows = good.filter((r) => r.deepest != null);
if (ladderRows.length) {
  lines.push("## Milestone/dungeon progress", `| family | seed | deepest/total | completed | stalled at | objectives | tok/milestone | turns | tok nc/wc |`,
             `|---|---|---|---|---|---|---|---|---|`);
  for (const r of ladderRows) lines.push(
    `| ${r.family} | ${r.seed} | ${r.deepest}/${r.total} | ${r.completed_all} | ${r.stalled_key ?? "—"} | ${r.objectives} | ${r.tokens_per_milestone ?? "—"} | ${r.turns} | ${bothTok(accTok(zeroTok(), r))} |`);
}
const surviveRows = good.filter((r) => r.bridged != null);
if (surviveRows.length) {
  lines.push("", "## E-survive-build", `| seed | bridged | coverage | filled/goal | still holding | turns | tok nc/wc |`,
             `|---|---|---|---|---|---|---|`);
  for (const r of surviveRows) lines.push(
    `| ${r.seed} | ${r.bridged} | ${r.coverage} | ${r.filled}/${r.goal_cells} | ${r.still_holding} | ${r.turns} | ${bothTok(accTok(zeroTok(), r))} |`);
}
const errs = rows.filter((r) => r.error);
if (errs.length) { lines.push("", "## Errors"); for (const r of errs) lines.push(`- ${r.family} s${r.seed}: ${r.error}`); }
const summary = lines.join("\n") + "\n";
await writeFile(join(outDir, "summary.md"), summary, "utf8");
console.log(`\n${summary}\nresults → ${outDir}`);
