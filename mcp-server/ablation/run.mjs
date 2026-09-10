#!/usr/bin/env node
// One ablation run: --scenario <name> --condition <a|b|c|d> --variant <n>
//   [--episode e1|e2] [--fork-from <runDir>] [--corpus-only] [--dry] [--out <dir>] [--no-setup]
//
// A run = all episodes of one (scenario, variant, condition) cell against a persistent per-run
// memory dir, with a fresh conversation per episode (the context reset IS the treatment).
// --fork-from clones another run's memory dir first (Track 2: identical corpus, different toolset).
// --dry does everything except invoke the agent: stage setup, prompts, tool lists — free smoke test.
//
// Substrate: Claude Agent SDK on the Max subscription (runner-sdk.mjs) — the agent's tools come
// from the ablation MCP shim; this process never dispatches agent tool calls itself.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CONDITIONS, AGENT_WORLD_TOOLS, tailOnlyRecent } from "./conditions.mjs";
import { buildSystemPrompt, buildOpeningMessage } from "./charter.mjs";
import { bridge, fetchManifest } from "./bridge.mjs";
import { runEpisodeSdk } from "./runner-sdk.mjs";
import { cloneMemoryDir } from "./clone.mjs";
import { makeScenario } from "./scenarios/index.mjs";
import { toolCounts } from "./metrics.mjs";
import { formatCompactionNag } from "../memory/store.mjs";

// --- args -----------------------------------------------------------------------------------------

function parseArgs(argv) {
  const a = { episodes: null, dry: false, setup: true };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--scenario") a.scenario = argv[++i];
    else if (k === "--condition") a.condition = argv[++i];
    else if (k === "--variant") a.variant = parseInt(argv[++i], 10);
    else if (k === "--episode") a.episodes = argv[++i].split(",");
    else if (k === "--fork-from") a.forkFrom = resolve(argv[++i]);
    else if (k === "--corpus-only") a.corpusOnly = true;
    else if (k === "--out") a.out = resolve(argv[++i]);
    else if (k === "--dry") a.dry = true;
    else if (k === "--no-setup") a.setup = false;
    else throw new Error(`unknown arg ${k}`);
  }
  if (!a.scenario || !a.condition || !a.variant) {
    throw new Error("required: --scenario <name> --condition <a|b|c|d> --variant <n>");
  }
  if (!CONDITIONS[a.condition]) throw new Error(`condition must be a|b|c|d, got ${a.condition}`);
  return a;
}

function gitHead(dir) {
  try { return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); }
  catch { return null; }
}

const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

// --- main -----------------------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = args.out ?? join(HERE, "..", "ablation-results");

// Budgets retuned after pilot run 1 (interrogation-v1-b-2026-07-19T13-08-17): 8 patrol notes ≈ 300
// tokens fit whole inside the old 600-token tail — nothing aged out, B answered from the render, and
// C/D would never hit compaction_due (trigger: tail > budget/2). The sizing rule requires overflow;
// these constants put a realistic long-history squeeze on the same E1 workload.
const cfg = {
  model: process.env.MCPTK_ABLATION_MODEL || "claude-sonnet-5",
  renderBudget: 500,   // c/d opening render — compaction_due fires when the tail exceeds 250
  tailBudget: 250,     // condition b's visible tail (~5 notes) — older notes fall off, banner says so
};

const condition = CONDITIONS[args.condition];
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const runId = `${args.scenario}-v${args.variant}-${args.condition}${args.forkFrom ? "-fork" : ""}-${stamp}`;
const runDir = join(OUT_ROOT, runId);
await mkdir(runDir, { recursive: true });

if (args.forkFrom) {
  await cloneMemoryDir(args.forkFrom, runDir);
  // --corpus-only: keep the RECORDS (log/blocks/places/relations = the retrieval load under test)
  // but drop the donor's working state. Without this, forking the soak corpus hands the agent a
  // task frame reading "scout for a 13th outpost site" plus a stale pending queue — and the charter
  // tells it to CONTINUE the frame, so it fights the scenario prompt and the run measures goal
  // confusion instead of recall. Deleting both files reproduces a fresh run's state exactly
  // (store.open() treats them as absent → no frame, no candidates).
  if (args.corpusOnly) {
    const memRoot = join(runDir, "memory");
    for (const world of await readdir(memRoot)) {
      for (const f of ["tasks.json", "pending.json"]) {
        await rm(join(memRoot, world, f), { force: true });
      }
    }
    console.log(`[fork] corpus-only: dropped donor task frame + pending queue`);
  }
}

const memoryRoot = join(runDir, "memory");
process.env.MCPTK_MEMORY_DIR = memoryRoot; // for render-cli children and the --dry tool listing

const ping = await bridge("ping", {});
if (!ping.ok) throw new Error(`bridge unreachable — is the headless server up? (${ping.error})`);

const scenario = makeScenario(args.scenario, args.variant);
if (args.forkFrom && !scenario.forkable) {
  throw new Error(`scenario ${scenario.name} is not forkable — Track 2 is restricted to non-mutating-E2 scenarios`);
}
if (args.setup) {
  console.log(`[setup] staging ${scenario.name} v${args.variant} …`);
  await scenario.setup();
}

const allowedToolNames = [...condition.memTools, ...AGENT_WORLD_TOOLS];

/**
 * Session-open render (the SessionStart-hook analog). Runs render-cli in a CHILD process so each
 * episode sees the memory files as the shim left them — this process never opens the store itself.
 */
function openingRender() {
  if (!condition.openingRender) return { render: null, nags: [] };
  const out = execFileSync(process.execPath, [join(HERE, "render-cli.mjs")], {
    env: { ...process.env, MCPTK_RENDER_BUDGET: String(cfg.renderBudget) },
    encoding: "utf8",
  });
  const r = JSON.parse(out);
  if (!r.ok) return { render: null, nags: [] };
  if (condition.tailOnly) return { render: tailOnlyRecent(r.result, cfg.tailBudget).render, nags: [] };
  const nags = [];
  const nag = formatCompactionNag(r.result.compactionDue);
  if (nag) nags.push(nag);
  return { render: r.result.render, nags };
}

const system = buildSystemPrompt(condition.key);
const frozen = {
  run_id: runId,
  scenario: scenario.name,
  variant: args.variant,
  condition: condition.key,
  fork_from: args.forkFrom ?? null,
  substrate: "claude-agent-sdk/max-subscription",
  model: cfg.model,
  render_budget: cfg.renderBudget,
  tail_budget: cfg.tailBudget,
  system_prompt_sha: sha(system),
  tools_sha: sha(JSON.stringify([...allowedToolNames].sort())),
  mcmodding_commit: gitHead(join(HERE, "..", "..")),
  params: scenario.params,
  started: new Date().toISOString(),
};
await writeFile(join(runDir, "run.json"), JSON.stringify(frozen, null, 2), "utf8");

const wanted = args.episodes ?? scenario.episodes.map((e) => e.key);
const results = { episodes: {}, opening_renders: {}, checkpoints: {} };

if (args.dry) {
  const manifest = await fetchManifest();
  const { localTools } = await import("../memory/tools.mjs");
  const memSet = new Set(condition.memTools);
  const names = [
    ...localTools().filter((t) => memSet.has(t.name)).map((t) => t.name),
    ...manifest.filter((t) => AGENT_WORLD_TOOLS.includes(t.name)).map((t) => t.name),
  ];
  const { render } = openingRender();
  console.log(`\n[dry] run ${runId} (substrate: agent-sdk/max)`);
  console.log(`[dry] shim tools (${names.length}): ${names.join(", ")}`);
  console.log(`[dry] allowedTools: ${allowedToolNames.map((n) => `mcp__ablation__${n}`).slice(0, 3).join(", ")}, … (${allowedToolNames.length})`);
  console.log(`[dry] system prompt (${system.length} chars, sha ${frozen.system_prompt_sha})`);
  console.log(`[dry] opening render:\n${render ?? "(none — condition a)"}`);
  for (const ep of scenario.episodes) {
    if (!wanted.includes(ep.key)) continue;
    console.log(`\n[dry] --- ${ep.key} prompt (maxTurns ${ep.maxTurns}) ---\n${ep.prompt}`);
  }
  console.log(`\n[dry] stage built; agent not invoked. Run dir: ${runDir}`);
  process.exit(0);
}

let mutated = false;
for (const ep of scenario.episodes) {
  if (!wanted.includes(ep.key)) {
    // Honor ordering side effects: mutation happens after e1 even when only e2 runs (fork runs).
    if (ep.key === "e1" && scenario.mutate && !mutated && wanted.includes("e2")) {
      console.log("[mutate] applying between-episode world mutation (e1 skipped in this run)");
      await scenario.mutate();
      mutated = true;
    }
    continue;
  }
  console.log(`\n[${ep.key}] fresh agent session, condition ${condition.key}, maxTurns ${ep.maxTurns}`);
  await bridge("bot_body", { action: "despawn" });
  const spawn = await bridge("bot_body", { action: "spawn",  pos: scenario.dronePos });
  if (!spawn.ok) throw new Error(`bot_body spawn failed: ${spawn.error}`);
  if (ep.prepare) await ep.prepare(bridge); // e.g. seed the drone's inventory (harness-side, privileged)

  const { render, nags } = openingRender();
  results.opening_renders[ep.key] = render;
  const prompt = buildOpeningMessage(render, nags, ep.prompt);

  const out = await runEpisodeSdk({
    model: cfg.model,
    system,
    prompt,
    maxTurns: ep.maxTurns,
    shimPath: join(HERE, "mcp-shim.mjs"),
    shimEnv: {
      MCPTK_ABLATION_CONDITION: condition.key,
      MCPTK_MEMORY_DIR: memoryRoot,
      MCPTK_TAIL_BUDGET: String(cfg.tailBudget),
      MCPTK_ABLATION_TRANSCRIPT: join(runDir, `transcript-${ep.key}.jsonl`),
    },
    allowedToolNames,
    toolTranscriptPath: join(runDir, `transcript-${ep.key}.jsonl`),
    sdkLogPath: join(runDir, `sdk-${ep.key}.jsonl`),
    log: (l) => console.log(`[${ep.key}] ${l}`),
  });
  // Final drone position must be captured BEFORE the despawn below — asserts need it.
  const finalStatus = await bridge("bot_status", {});
  out.final_drone_pos = finalStatus.ok && finalStatus.result?.pos
    ? [finalStatus.result.pos.x, finalStatus.result.pos.y, finalStatus.result.pos.z].map(Math.round)
    : null;
  results.episodes[ep.key] = out;
  console.log(`[${ep.key}] done (${out.subtype}): ${out.turns} turns${out.capped ? " (CAPPED)" : ""}, ` +
    `${out.usage.input_tokens} in / ${out.usage.output_tokens} out, tools: ${JSON.stringify(toolCounts(out.transcript).byName)}`);

  // World-state snapshot at the episode boundary (e.g. build progress) — before any mutation.
  if (scenario.checkpoint) {
    results.checkpoints[ep.key] = await scenario.checkpoint(ep.key);
    console.log(`[${ep.key}] checkpoint: ${JSON.stringify(results.checkpoints[ep.key]).slice(0, 200)}`);
  }

  if (ep.key === "e1" && scenario.mutate && !mutated) {
    await bridge("bot_body", { action: "despawn" }); // no observer while the harness mutates
    console.log("[mutate] applying between-episode world mutation");
    await scenario.mutate();
    mutated = true;
  }
}
await bridge("bot_body", { action: "despawn" });

// --- assert + persist -----------------------------------------------------------------------------

const e2 = results.episodes.e2;
let verdict = null;
if (e2) {
  verdict = await scenario.assert.call(scenario, {
    e1: results.episodes.e1 ?? null,
    e2,
    episodes: results.episodes,
    checkpoints: results.checkpoints,
    memoryRoot,
    openingRender: results.opening_renders.e2 ?? null,
  });
  console.log(`\n[assert] success=${verdict.success} flags=${JSON.stringify(verdict.flags)}`);
}

const row = {
  ...frozen,
  finished: new Date().toISOString(),
  checkpoints: results.checkpoints,
  episodes: Object.fromEntries(Object.entries(results.episodes).map(([k, v]) => [k, {
    turns: v.turns, subtype: v.subtype, capped: v.capped, usage: v.usage,
    total_cost_usd: v.total_cost_usd, tool_counts: toolCounts(v.transcript),
  }])),
  success: verdict?.success ?? null,
  metrics: verdict?.metrics ?? null,
  guarantees: verdict?.guarantees ?? null,
  flags: verdict?.flags ?? [],
  answer: verdict?.answer ?? null,
  truth: verdict?.truth ?? null,
};
await writeFile(join(runDir, "result.json"), JSON.stringify(row, null, 2), "utf8");
await appendFile(join(OUT_ROOT, "results.jsonl"), JSON.stringify(row) + "\n", "utf8");
console.log(`\n[done] ${runId} → ${join(OUT_ROOT, "results.jsonl")}`);
