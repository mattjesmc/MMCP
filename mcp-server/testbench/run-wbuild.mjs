#!/usr/bin/env node
// Category W (world-edit building) orchestrator — auto-scored via build-score diff. Per seed × mode
// (schematic | repair): stage a plot, run ONE bodiless world-edit session, capture the region, and
// diff it against the code-defined target. No human, no LLM judge — the auto-scored floor.
//
//   node testbench/run-wbuild.mjs --dry                       # stage + show target + diff an EMPTY plot (0 build) — no model
//   node testbench/run-wbuild.mjs --model haiku               # both modes
//   node testbench/run-wbuild.mjs --model sonnet --modes schematic --seeds 2

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
import { makeWBuild, WBUILD_TOOLS } from "./wbuild-scenario.mjs";
import { bothTok, zeroTok, accTok } from "./tokens.mjs";

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
const MODEL = opt("model", "haiku");
const SEEDS = parseInt(opt("seeds", "1"), 10);
const MODES = opt("modes", "schematic,repair").split(",");
const DRY = argv.includes("--dry");

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIM = join(HERE, "..", "ablation", "mcp-shim.mjs");
const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const cfgModel = process.env.MCPTK_ABLATION_MODEL || (MODEL === "haiku" ? "claude-haiku-4-5-20251001" : MODEL);

const CHARTER = `You are an expert Minecraft builder working through a world-edit interface (no body). \
Place blocks precisely with set_blocks (supports blockstate strings), place_shape, and place_blocks; \
inspect with get_blocks_at/describe_box. Match the given spec exactly — right block at right coordinate. \
Verify against the spec before finishing.`;

const ping = await bridge("ping", {});
if (!ping.ok) { console.error(`no bridge — start the dev server first (${ping.error})`); process.exit(1); }
const manifest = await fetchManifest();
const known = new Set(manifest.map((t) => t.name));
for (const n of WBUILD_TOOLS) if (!known.has(n)) throw new Error(`unknown tool "${n}" — is the world-edit surface present?`);

const instances = [];
for (let seed = 1; seed <= SEEDS; seed++) for (const mode of MODES) instances.push(makeWBuild({ seed, mode }));
const questionsHash = sha(JSON.stringify(instances.map((s) => ({ seed: s.seed, mode: s.mode }))));
console.log(`Category W (world-edit build) — ${SEEDS} seeds × modes [${MODES.join(",")}], questions ${questionsHash}`);

if (DRY) {
  for (const s of instances) {
    console.log(`\n=== ${s.mode} seed ${s.seed} ===`);
    await s.setup();
    const scored = await s.score(); // schematic: an empty plot → ~0; repair: the pre-built-with-deviations state
    console.log(`  region ${JSON.stringify(s.region.min)}..${JSON.stringify(s.region.max)}`);
    console.log(`  baseline diff (no agent build): ${JSON.stringify(scored.metrics)}`);
    await s.cleanup();
  }
  console.log(`\n[dry] staged + captured baseline. schematic baseline should be ~0 fidelity (empty), ` +
    `repair baseline should be high but < 1 (pre-built with injected_deviations). No model spend.`);
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = join(HERE, "..", "testbench-results", `${stamp}-wbuild-${MODEL}`);
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
  date: new Date().toISOString(), bench_version: BENCH_VERSION, category: "w", slice: "world-edit-build", model: MODEL, model_id: cfgModel,
  seeds: SEEDS, modes: MODES, git_head: execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: HERE }).toString().trim(),
  questions_hash: questionsHash, tools: WBUILD_TOOLS, tools_hash: toolsHash, routes_hash: routesHash, substrate: "claude-agent-sdk/max-subscription",
}, null, 2), "utf8");

const rows = [];
for (const s of instances) {
  console.log(`\n[${s.mode} s${s.seed}] setup`);
  await s.setup();
  const tag = `${s.name}-s${s.seed}-${s.mode}`;
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
      scenario: s.name, seed: s.seed, mode: s.mode, model: MODEL, ...scored.metrics, truth: scored.truth,
      turns: out.turns, subtype: out.subtype, capped: out.capped, tool_counts: toolCounts(out.transcript),
      tokens_in: out.usage.input_tokens, tokens_out: out.usage.output_tokens,
      cache_read: out.usage.cache_read_input_tokens, cache_write: out.usage.cache_creation_input_tokens,
    };
    rows.push(rec);
    await appendFile(answersPath, JSON.stringify(rec) + "\n", "utf8");
    console.log(`  [${tag}] ${JSON.stringify(scored.metrics)} — ${out.turns}t`);
  } catch (e) {
    const rec = { scenario: s.name, seed: s.seed, mode: s.mode, error: String(e) };
    rows.push(rec);
    await appendFile(answersPath, JSON.stringify(rec) + "\n", "utf8");
    console.log(`  [${tag}] ERROR ${e}`);
  }
  await s.cleanup();
}

const good = rows.filter((r) => !r.error);
const lines = [`# Category W — world-edit build — ${stamp}, model ${MODEL}`, "",
  `${SEEDS} seeds × modes [${MODES.join(",")}], questions ${questionsHash}`, ""];
if (good.length) {
  lines.push("## Per build", `| seed | mode | block_match | silhouette | fidelity | exact | correct/target | wrong/miss/extra | turns | tok nc/wc |`,
             `|---|---|---|---|---|---|---|---|---|---|`);
  for (const r of good) lines.push(
    `| ${r.seed} | ${r.mode} | ${r.block_match} | ${r.silhouette_iou} | ${r.fidelity} | ${r.exact} | ` +
    `${r.correct}/${r.target_cells} | ${r.wrong_material}/${r.missing}/${r.extra} | ${r.turns} | ${bothTok(accTok(zeroTok(), r))} |`);
  lines.push("", "## Per-mode means");
  lines.push(`| mode | builds | mean fidelity | exact | total tok nc/wc |`, `|---|---|---|---|---|`);
  for (const mode of MODES) {
    const mr = good.filter((r) => r.mode === mode);
    if (!mr.length) continue;
    const mean = Math.round((mr.reduce((a, r) => a + r.fidelity, 0) / mr.length) * 1000) / 1000;
    const acc = mr.reduce((a, r) => accTok(a, r), zeroTok());
    lines.push(`| ${mode} | ${mr.length} | ${mean} | ${mr.filter((r) => r.exact).length} | ${bothTok(acc)} |`);
  }
}
const errs = rows.filter((r) => r.error);
if (errs.length) { lines.push("", "## Errors"); for (const r of errs) lines.push(`- ${r.mode} s${r.seed}: ${r.error}`); }
const summary = lines.join("\n") + "\n";
await writeFile(join(outDir, "summary.md"), summary, "utf8");
console.log(`\n${summary}\nresults → ${outDir}`);
