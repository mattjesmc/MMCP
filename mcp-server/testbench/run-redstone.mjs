#!/usr/bin/env node
// Category Z (redstone/logic puzzle) orchestrator. Per seed × gate: stage a plot, run ONE bodiless
// world-edit session to build the circuit, then drive every input combo and score the lamp against
// the gate truth table (redstone-score, unit-tested). No ablation arm — this is a capability bench
// (can the model build working combinational redstone), compared across models like A/B.
//
//   node testbench/run-redstone.mjs --dry                 # stage + APPARATUS self-check (no model spend)
//   node testbench/run-redstone.mjs --model haiku         # full build+grade
//   node testbench/run-redstone.mjs --model sonnet --seeds 2 --gates OR,AND,XOR

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
import { makeRedstonePuzzle, GATE_LADDER, REDSTONE_TOOLS } from "./redstone-scenario.mjs";
import { bothTok, zeroTok, accTok } from "./tokens.mjs";

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
const MODEL = opt("model", "haiku");
const SEEDS = parseInt(opt("seeds", "1"), 10);
const GATES_ARG = opt("gates", GATE_LADDER.join(","));
const GATES = GATES_ARG.split(",").filter((g) => GATE_LADDER.includes(g));
const DRY = argv.includes("--dry");

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIM = join(HERE, "..", "ablation", "mcp-shim.mjs");
const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const cfgModel = process.env.MCPTK_ABLATION_MODEL || (MODEL === "haiku" ? "claude-haiku-4-5-20251001" : MODEL);

const CHARTER = `You are an expert Minecraft redstone engineer working through a world-edit interface \
(no body). You place blocks directly with set_blocks/place_shape/place_blocks and inspect your work \
with get_blocks_at/describe_box. Build correct, compact combinational logic. Think about signal strength, \
inverters (redstone_torch), and repeaters. Verify your circuit's wiring before finishing.`;

const ping = await bridge("ping", {});
if (!ping.ok) { console.error(`no bridge — start the dev server first (${ping.error})`); process.exit(1); }
const manifest = await fetchManifest();
const known = new Set(manifest.map((t) => t.name));
for (const n of REDSTONE_TOOLS) if (!known.has(n)) throw new Error(`unknown tool "${n}" — is the world-edit surface present?`);

const instances = [];
for (let seed = 1; seed <= SEEDS; seed++) for (const gate of GATES) instances.push(makeRedstonePuzzle({ seed, gate }));
const questionsHash = sha(JSON.stringify(instances.map((s) => ({ seed: s.seed, gate: s.gate }))));
console.log(`Category Z (redstone) — ${SEEDS} seeds × gates [${GATES.join(",")}], questions ${questionsHash}`);

if (DRY) {
  for (const s of instances) {
    console.log(`\n=== ${s.gate} seed ${s.seed} ===`);
    await s.setup();
    const chk = await s.selfCheck();
    console.log(`  apparatus self-check: ${JSON.stringify(chk)}`);
    console.log(`  tools: ${s.toolsFor().join(", ")}`);
    await s.cleanup();
  }
  console.log(`\n[dry] staged + ran the lamp measurement self-check (lamp_reads_on/off must both be true). ` +
    `No model spend. If the lamp does not toggle, the driver/reader needs live tuning before a real run.`);
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = join(HERE, "..", "testbench-results", `${stamp}-redstone-${MODEL}`);
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
  date: new Date().toISOString(), bench_version: BENCH_VERSION, category: "z", slice: "redstone", model: MODEL, model_id: cfgModel,
  seeds: SEEDS, gates: GATES, git_head: execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: HERE }).toString().trim(),
  questions_hash: questionsHash, tools: REDSTONE_TOOLS, tools_hash: toolsHash, routes_hash: routesHash, substrate: "claude-agent-sdk/max-subscription",
}, null, 2), "utf8");

const rows = [];
for (const s of instances) {
  console.log(`\n[${s.gate} s${s.seed}] setup`);
  await s.setup();
  const tag = `${s.name}-s${s.seed}-${s.gate}`;
  try {
    const tools = s.toolsFor();
    const transcriptPath = join(outDir, `transcript-${tag}.jsonl`);
    const out = await runEpisodeSdk({
      model: cfgModel, system: CHARTER, prompt: s.prompt(), maxTurns: s.maxTurns,
      shimPath: SHIM,
      shimEnv: {
        MCPTK_ABLATION_CONDITION: "a", MCPTK_MEMORY_DIR: join(outDir, "nomem"),
        MCPTK_WORLD_TOOLS: tools.join(","), MCPTK_ABLATION_TRANSCRIPT: transcriptPath,
      },
      allowedToolNames: tools, toolTranscriptPath: transcriptPath,
      sdkLogPath: join(outDir, `sdk-${tag}.jsonl`), log: (l) => console.log(`  [${tag}] ${l}`),
    });
    const scored = await s.score();
    const rec = {
      scenario: s.name, seed: s.seed, gate: s.gate, model: MODEL, ...scored.metrics, truth: scored.truth,
      turns: out.turns, subtype: out.subtype, capped: out.capped, tool_counts: toolCounts(out.transcript),
      tokens_in: out.usage.input_tokens, tokens_out: out.usage.output_tokens,
      cache_read: out.usage.cache_read_input_tokens, cache_write: out.usage.cache_creation_input_tokens,
    };
    rows.push(rec);
    await appendFile(answersPath, JSON.stringify(rec) + "\n", "utf8");
    console.log(`  [${tag}] ${JSON.stringify(scored.metrics)} — ${out.turns}t`);
  } catch (e) {
    const rec = { scenario: s.name, seed: s.seed, gate: s.gate, error: String(e) };
    rows.push(rec);
    await appendFile(answersPath, JSON.stringify(rec) + "\n", "utf8");
    console.log(`  [${tag}] ERROR ${e}`);
  }
  await s.cleanup();
}

const good = rows.filter((r) => !r.error);
const lines = [`# Category Z — redstone/logic — ${stamp}, model ${MODEL}`, "",
  `${SEEDS} seeds × gates [${GATES.join(",")}], questions ${questionsHash}`, ""];
if (good.length) {
  lines.push("## Per puzzle", `| seed | gate | inputs | rows correct | accuracy | exact | turns | tok nc/wc |`,
             `|---|---|---|---|---|---|---|---|`);
  for (const r of good) lines.push(
    `| ${r.seed} | ${r.gate} | ${r.n_in} | ${r.rows_correct}/${r.rows_total} | ${r.accuracy} | ${r.exact} | ${r.turns} | ${bothTok(accTok(zeroTok(), r))} |`);
  const solved = good.filter((r) => r.exact).length;
  const acc = accTok(good.reduce((a, r) => accTok(a, r), zeroTok()), {});
  lines.push("", `## Totals`, `Fully-correct circuits: **${solved}/${good.length}**. Total tokens ${bothTok(acc)}.`);
}
const errs = rows.filter((r) => r.error);
if (errs.length) { lines.push("", "## Errors"); for (const r of errs) lines.push(`- ${r.gate} s${r.seed}: ${r.error}`); }
const summary = lines.join("\n") + "\n";
await writeFile(join(outDir, "summary.md"), summary, "utf8");
console.log(`\n${summary}\nresults → ${outDir}`);
