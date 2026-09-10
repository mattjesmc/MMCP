#!/usr/bin/env node
// Category P orchestrator — true-play / player-legal bench (CATEGORY_P_DESIGN.md).
//
//   node testbench/run-play.mjs [--model haiku] [--slices perceive,survive] [--seeds 2] [--dry]
//
// Per slice × seed × arm: stage the arena, spawn+prepare the drone, run ONE fresh player session
// through the shim with the arm's player-legal (or x-ray) tool surface, then score from server
// truth (no LLM judge). P-survive additionally runs a fixed post-session survival window while the
// server reflexes/engagement keep fighting. Output matches A/B/C/T:
// testbench-results/<stamp>-play-<model>/ (manifest + answers.jsonl + summary.md); full SDK +
// tool transcripts saved per session for token analysis.

import { createHash } from "node:crypto";
import { BENCH_VERSION } from "./version.mjs";
import { routesHashForRun } from "./routes-pin.mjs";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CONDITIONS } from "../ablation/conditions.mjs";
import { bridge, fetchManifest } from "../ablation/bridge.mjs";
import { runEpisodeSdk } from "../ablation/runner-sdk.mjs";
import { toolCounts } from "../ablation/metrics.mjs";
import { SCENARIOS, TOOLSETS } from "./play-scenario.mjs";
import { bothTok } from "./tokens.mjs";

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
const MODEL = opt("model", "haiku");
// Default to the WORKING slice. P-survive is present but experimental — blocked on the drone's
// hover height (it floats ~16 blocks up after spawn, out of any ground threat's reach), so it
// produces all-zero signal until that's solved. Opt in explicitly with --slices perceive,survive.
const SLICES = opt("slices", "perceive").split(",");
const SEEDS = parseInt(opt("seeds", "2"), 10);
const DRY = argv.includes("--dry");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIM = join(HERE, "..", "ablation", "mcp-shim.mjs");
const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const cfgModel = process.env.MCPTK_ABLATION_MODEL || (MODEL === "haiku" ? "claude-haiku-4-5-20251001" : MODEL);

// Player charter — a body with honest senses, not an omniscient copilot. The ONLY per-arm
// difference is the one-line perception clause (fair ablation: perception channel, not prompt IQ).
const CHARTER_CORE = `You are an autonomous Minecraft PLAYER controlling your own body — a drone \
actuator with a hotbar, hands, armor slots, and server-run reflexes. You are NOT an omniscient \
copilot.

- Combat & survival are reactive: arm reflexes with bot_reactions (the server runs them every game \
tick — far faster than you could react in this loop), set movement with bot_body action:"engage" (mode fight, policy kite/close) \
(kite/strafe/close/hold a target), equip from your inventory with bot_equip, and use \
bot_shoot/bot_eat/bot_drink. Once your reflexes and engagement are set, the server keeps executing \
them on your behalf — you do not micromanage each swing.
- Be decisive and act; when the task asks for JSON, your final message must contain exactly one \
\`\`\`json block.`;
const PERCEPTION = {
  legal: `\n- Perception: sense_entities is your belief store — what your body can actually SEE \
(field of view + line of sight) and HEAR. It is NOT ground truth; things you cannot perceive are \
absent. Never report or act on what you cannot sense.`,
  xray: `\n- Perception: you have authoritative entity awareness — get_entities and scene_summary \
report true positions around you.`,
};
const charter = (arm) => CHARTER_CORE + (arm === "xray" ? PERCEPTION.xray : PERCEPTION.legal);

const ping = await bridge("ping", {});
if (!ping.ok) { console.error(`no bridge — start the 0.14.0 dev server first (${ping.error})`); process.exit(1); }

// Validate the play tool surfaces against the running manifest (a hidden-but-misnamed tool would
// silently make an arm not the arm we think).
const manifest = await fetchManifest();
const known = new Set(manifest.map((t) => t.name));
for (const [k, list] of Object.entries(TOOLSETS)) {
  for (const n of list) if (!known.has(n)) throw new Error(`toolset ${k} names unknown tool "${n}" — is the server 0.14.0?`);
}

// Instantiate.
const instances = [];
for (const slice of SLICES) {
  const make = SCENARIOS[slice];
  if (!make) throw new Error(`unknown slice "${slice}" (perceive | survive)`);
  for (let seed = 1; seed <= SEEDS; seed++) instances.push(make(seed));
}
const questionsHash = sha(JSON.stringify(instances.map((s) => ({ name: s.name, seed: s.seed, arms: s.arms }))));
console.log(`Category P — ${instances.length} scenarios (${SLICES.join("+")}), seeds ${SEEDS}, questions ${questionsHash}`);

async function runArm(s, arm, outDir, tag) {
  await bridge("bot_body", { action: "despawn" });
  const spawn = await bridge("bot_body", { action: "spawn",  pos: s.dronePos });
  if (!spawn.ok) throw new Error(`bot_body spawn failed: ${spawn.error}`);
  if (s.prepare) await s.prepare(arm);
  const tools = s.toolsFor(arm);
  const transcriptPath = join(outDir, `transcript-${tag}.jsonl`);
  const out = await runEpisodeSdk({
    model: cfgModel, system: charter(arm), prompt: s.prompt, maxTurns: s.maxTurns,
    shimPath: SHIM,
    shimEnv: {
      MCPTK_ABLATION_CONDITION: "a",           // no memory tools / no opening render
      MCPTK_MEMORY_DIR: join(outDir, "nomem"), // unused (condition a), but the shim expects it set
      MCPTK_WORLD_TOOLS: tools.join(","),       // the player-legal (or x-ray) surface
      MCPTK_ABLATION_TRANSCRIPT: transcriptPath,
    },
    allowedToolNames: tools,
    toolTranscriptPath: transcriptPath,
    sdkLogPath: join(outDir, `sdk-${tag}.jsonl`),
    log: (l) => console.log(`  [${tag}] ${l}`),
  });
  if (s.observeWindowMs) { // survive: let the armed reflexes + engagement play out
    console.log(`  [${tag}] survival window ${s.observeWindowMs}ms …`);
    await wait(s.observeWindowMs);
  }
  const scored = await s.score(arm, out);
  await bridge("bot_body", { action: "despawn" });
  return { out, scored };
}

if (DRY) {
  for (const s of instances) {
    console.log(`\n=== ${s.name} seed ${s.seed} (arms: ${s.arms.join(",")}) ===`);
    await s.setup();
    await bridge("bot_body", { action: "despawn" });
    await bridge("bot_body", { action: "spawn",  pos: s.dronePos });
    if (s.prepare) await s.prepare(s.arms[0]);
    const scored = await s.score(s.arms[0], { finalText: "" });
    console.log(`  tools[${s.arms[0]}]: ${s.toolsFor(s.arms[0]).join(", ")}`);
    console.log(`  guarantee/metrics: ${JSON.stringify(scored.guarantee ?? scored.metrics)}`);
    await bridge("bot_body", { action: "despawn" });
    await s.cleanup();
  }
  console.log("\n[dry] staged + scored truth, no model spend.");
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = join(HERE, "..", "testbench-results", `${stamp}-play-${MODEL}`);
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
  date: new Date().toISOString(), bench_version: BENCH_VERSION, category: "p", model: MODEL, model_id: cfgModel, slices: SLICES, seeds: SEEDS,
  tools_hash: toolsHash, routes_hash: routesHash, git_head: execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: HERE }).toString().trim(),
  questions_hash: questionsHash, toolsets: TOOLSETS, substrate: "claude-agent-sdk/max-subscription",
}, null, 2), "utf8");

const rows = [];
for (const s of instances) {
  console.log(`\n[${s.name} s${s.seed}] setup`);
  await s.setup();
  for (const arm of s.arms) {
    const tag = `${s.name}-s${s.seed}-${arm}`;
    console.log(`[${tag}] run`);
    try {
      const { out, scored } = await runArm(s, arm, outDir, tag);
      const rec = {
        scenario: s.name, seed: s.seed, arm, model: MODEL,
        ...scored.metrics, guarantee: scored.guarantee ?? null, truth: scored.truth,
        turns: out.turns, subtype: out.subtype, capped: out.capped,
        tool_counts: toolCounts(out.transcript),
        tokens_in: out.usage.input_tokens, tokens_out: out.usage.output_tokens,
        cache_read: out.usage.cache_read_input_tokens, cache_write: out.usage.cache_creation_input_tokens,
        answer: scored.answer ?? null,
      };
      rows.push(rec);
      await appendFile(answersPath, JSON.stringify(rec) + "\n", "utf8");
      console.log(`  [${tag}] ${JSON.stringify(scored.metrics)} — ${out.turns}t, ${rec.tokens_in}in/${rec.tokens_out}out`);
    } catch (e) {
      const rec = { scenario: s.name, seed: s.seed, arm, error: String(e) };
      rows.push(rec);
      await appendFile(answersPath, JSON.stringify(rec) + "\n", "utf8");
      console.log(`  [${tag}] ERROR ${e}`);
    }
  }
  await s.cleanup();
}

// --- summary ------------------------------------------------------------------------------------
const lines = [`# Category P (true-play) — ${stamp}, model ${MODEL}`, "",
  `${instances.length} scenarios × arms, questions ${questionsHash}`, ""];
const perc = rows.filter((r) => r.scenario === "p-perceive" && !r.error);
if (perc.length) {
  lines.push("## P-perceive — perception honesty (legal)");
  lines.push(`- honest: ${perc.filter((r) => r.honest).length}/${perc.length}; ` +
    `cheats (reported unperceived mob): ${perc.filter((r) => r.no_cheat === false).length}`);
  for (const r of perc) lines.push(`  - seed ${r.seed}: honest=${r.honest} seen_correct=${r.seen_correct} no_cheat=${r.no_cheat} ` +
    `(reported ${r.reported}, believed ${r.believed_hostiles}, oracle ${r.oracle_hostiles}); guarantee ${JSON.stringify(r.guarantee)}; tok ${bothTok(r)} (nc/wc)`);
}
const surv = rows.filter((r) => r.scenario === "p-survive" && !r.error);
if (surv.length) {
  lines.push("", "## P-survive — combat competence (legal vs xray)");
  lines.push(`| seed | arm | alive | health | killed/threat | dmg | turns | tok nc/wc |`, `|---|---|---|---|---|---|---|---|`);
  for (const r of surv) lines.push(`| ${r.seed} | ${r.arm} | ${r.alive} | ${r.final_health} | ${r.mobs_killed}/${r.mobs_initial} | ${r.damage_taken} | ${r.turns} | ${bothTok(r)} |`);
}
const errs = rows.filter((r) => r.error);
if (errs.length) { lines.push("", "## Errors"); for (const r of errs) lines.push(`- ${r.scenario} s${r.seed} ${r.arm}: ${r.error}`); }
const summary = lines.join("\n") + "\n";
await writeFile(join(outDir, "summary.md"), summary, "utf8");
console.log(`\n${summary}\nresults → ${outDir}`);
