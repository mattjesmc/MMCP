#!/usr/bin/env node
// THE `place_shapes` MEASUREMENT — one authored room, batched vs. not.
//
// Owed by mcp-toolkit/docs/world/STRUCTURE_AUTHORING_DESIGN.md §4's last paragraph. Two arms differing by
// EXACTLY ONE TOOL, same seeds, byte-identical prompts, identical turn cap. Reports both halves of
// the ledger:
//
//   THE BENEFIT — turns and Σ cache_read to build the room. By TOKEN_PER_TOOL_FINDINGS.md finding 1
//   the static prefix is re-read every turn, so turns are the lever and this is where a win must
//   show up. It also reports ops-per-call, which is the direct answer to "did the model plan ahead"
//   — the doc's own alternative hypothesis.
//
//   THE COST — place_shapes adds its own schema to the always-loaded prefix, paid on every turn of
//   every session INCLUDING the ones that never call it. That is finding 1 turned against the new
//   tool, and it is why the report prints a break-even: how many shapes a build must have before
//   the batch pays for the prefix it costs everyone.
//
// Not a registered bench unit (registry.mjs untouched) and writes to mcp-server/measurements/, not
// testbench-results/ — it must not pool with the frozen bench corpus.
//
//   node testbench/run-shapebatch.mjs --dry                        # target + spec + arms, no model
//   node testbench/run-shapebatch.mjs --model haiku --seeds 3
//   node testbench/run-shapebatch.mjs --arms batch --seeds 1

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile, appendFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { bridge, fetchManifest } from "../ablation/bridge.mjs";
import { runEpisodeSdk } from "../ablation/runner-sdk.mjs";
import { toolCounts } from "../ablation/metrics.mjs";
import { makeRoom, ARM_TOOLS, CHARTER, SHAPES_MINIMUM, targetSummary, roomTarget, renderSpec }
  from "./shapebatch-scenario.mjs";
import { renderReport } from "./shapebatch-report.mjs";
import { ktok } from "./tokens.mjs";

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const MODEL = opt("model", "haiku");
const SEEDS = parseInt(opt("seeds", "3"), 10);
const ARMS = opt("arms", "single,batch").split(",");
const DRY = argv.includes("--dry");
const FROM = opt("from", null); // re-report a finished run: no bridge, no model, no spend

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIM = join(HERE, "..", "ablation", "mcp-shim.mjs");
const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const cfgModel = process.env.MCPTK_ABLATION_MODEL || (MODEL === "haiku" ? "claude-haiku-4-5-20251001" : MODEL);

for (const a of ARMS) if (!ARM_TOOLS[a]) throw new Error(`unknown arm "${a}" (single|batch)`);

/** Split rows into usable and censored. A capped/errored row is failure at maximum cost — it is
 *  listed, never averaged, or the circuit breaker would set the answer. */
function partition(all) {
  return { rows: all.filter((r) => !r.error && !r.capped), censored: all.filter((r) => r.error || r.capped) };
}

async function reportFrom(dir) {
  const all = (await readFile(join(dir, "rows.jsonl"), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const man = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
  const { rows, censored } = partition(all);
  const out = renderReport({
    rows, censored,
    meta: {
      stamp: man.date, model: man.model, model_id: man.model_id, git_head: man.git_head,
      seeds: man.seeds, questions_hash: man.questions_hash, shapes_minimum: man.shapes_minimum,
      target_cells: man.target_cells ?? targetSummary(1).cells, max_turns: man.max_turns ?? 60,
    },
  });
  await writeFile(join(dir, "REPORT.md"), out, "utf8");
  console.log(out);
  console.log(`written: ${join(dir, "REPORT.md")}`);
}

if (FROM) { await reportFrom(FROM); process.exit(0); }

if (DRY) {
  const { rel, pal } = roomTarget(1);
  console.log(`target: ${Object.keys(rel).length} cells, minimum ${SHAPES_MINIMUM} shapes`);
  console.log(`palette: ${JSON.stringify(pal)}`);
  for (const s of [1, 2, 3]) console.log(`  seed ${s}: ${JSON.stringify(targetSummary(s))}`);
  console.log(`\narms:`);
  for (const a of Object.keys(ARM_TOOLS)) console.log(`  ${a}: ${ARM_TOOLS[a].join(", ")}`);
  console.log(`\nspec as the model sees it (seed 1, origin 0/0):\n${renderSpec(roomTarget(1), 0, 0)}`);
  console.log(`\n[dry] no model spend, no bridge needed.`);
  process.exit(0);
}

const ping = await bridge("ping", {});
if (!ping.ok) { console.error(`no bridge — start the dev server first (${ping.error})`); process.exit(1); }
const manifest = await fetchManifest();
const known = new Set(manifest.map((t) => t.name));
for (const a of ARMS) for (const n of ARM_TOOLS[a]) {
  if (!known.has(n)) throw new Error(`arm "${a}" needs tool "${n}" and the manifest has no such tool ` +
    `— rebuild the mod (place_shapes ships in toolkit 0.76.0)`);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = join(HERE, "..", "measurements", `${stamp}-shapebatch-${MODEL}`);
await mkdir(join(outDir, "nomem"), { recursive: true });
const rowsPath = join(outDir, "rows.jsonl");
await writeFile(rowsPath, "", "utf8");

const instances = [];
for (let seed = 1; seed <= SEEDS; seed++) for (const arm of ARMS) instances.push(makeRoom({ seed, arm }));
const questionsHash = sha(JSON.stringify(instances.map((s) => ({ seed: s.seed, arm: s.arm }))));

await writeFile(join(outDir, "manifest.json"), JSON.stringify({
  date: new Date().toISOString(), kind: "measurement", subject: "place_shapes",
  owed_by: "mcp-toolkit/docs/world/STRUCTURE_AUTHORING_DESIGN.md §4", model: MODEL, model_id: cfgModel,
  seeds: SEEDS, arms: ARMS, arm_tools: ARM_TOOLS, shapes_minimum: SHAPES_MINIMUM,
  target_cells: targetSummary(1).cells, max_turns: instances[0].maxTurns,
  questions_hash: questionsHash,
  git_head: execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: HERE }).toString().trim(),
  note: "NOT a bench rung — deliberately outside testbench-results/ and registry.mjs so it cannot " +
    "pool with the frozen bench corpus.",
}, null, 2), "utf8");

console.log(`place_shapes measurement — ${SEEDS} seeds x arms [${ARMS.join(",")}], model ${MODEL}`);
console.log(`room: ${targetSummary(1).cells} cells, minimum ${SHAPES_MINIMUM} shapes, questions ${questionsHash}`);

/**
 * Per-turn input accounting from the sdk log. TURN-1 TOTAL INPUT is the honest prefix probe here:
 * it is system prompt + every tool schema + the task prompt, with nothing accumulated yet. The
 * prompt is byte-identical across arms and the surfaces differ by one tool, so the turn-1 delta
 * between arms IS place_shapes' schema cost. (Finding 1's "first non-zero cache_read" is the same
 * idea, but it reads 0 on a cold turn 1 and then over-counts on turn 2, which has accumulation in
 * it; summing the three input fields avoids caring whether the prefix was read or written.)
 */
async function turnUsage(sdkPath) {
  const lines = (await readFile(sdkPath, "utf8")).split("\n").filter(Boolean);
  const turns = [];
  for (const l of lines) {
    let m; try { m = JSON.parse(l); } catch { continue; }
    if (m.type !== "assistant") continue;
    const u = m.message?.usage ?? {};
    turns.push({
      in: u.input_tokens ?? 0, out: u.output_tokens ?? 0,
      cr: u.cache_read_input_tokens ?? 0, cw: u.cache_creation_input_tokens ?? 0,
    });
  }
  const first = turns[0];
  return {
    turn1_input: first ? first.in + first.cr + first.cw : null,
    per_turn_read_mean: turns.length
      ? Math.round(turns.reduce((a, t) => a + t.cr, 0) / turns.length) : null,
    observed_turns: turns.length,
  };
}

/** Ops per place_shapes call — the "did it plan ahead" evidence, read from the tool transcript. */
async function shapeCallShape(transcriptPath) {
  let raw = "";
  try { raw = await readFile(transcriptPath, "utf8"); } catch { return { batch_calls: [], single_calls: 0 }; }
  const batch = [], singles = [];
  for (const l of raw.split("\n").filter(Boolean)) {
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (e.type !== "tool") continue;
    if (e.name === "place_shapes") batch.push(Array.isArray(e.input?.ops) ? e.input.ops.length : 0);
    if (e.name === "place_shape") singles.push(1);
  }
  return { batch_calls: batch, single_calls: singles.length };
}

const rows = [];
for (const s of instances) {
  const tag = `s${s.seed}-${s.arm}`;
  console.log(`\n[${tag}] setup (${s.tools.length} tools: ${s.tools.join(",")})`);
  await s.setup();
  try {
    const transcriptPath = join(outDir, `transcript-${tag}.jsonl`);
    const sdkPath = join(outDir, `sdk-${tag}.jsonl`);
    const out = await runEpisodeSdk({
      model: cfgModel, system: CHARTER, prompt: s.prompt(), maxTurns: s.maxTurns,
      shimPath: SHIM,
      shimEnv: {
        MCPTK_ABLATION_CONDITION: "a", MCPTK_MEMORY_DIR: join(outDir, "nomem"),
        MCPTK_WORLD_TOOLS: s.tools.join(","), MCPTK_ABLATION_TRANSCRIPT: transcriptPath,
      },
      allowedToolNames: s.tools, toolTranscriptPath: transcriptPath,
      sdkLogPath: sdkPath, log: (l) => console.log(`  [${tag}] ${l}`),
    });
    const scored = await s.score();
    const usage = await turnUsage(sdkPath);
    const shapes = await shapeCallShape(transcriptPath);
    const rec = {
      seed: s.seed, arm: s.arm, model: MODEL, ...scored.metrics, truth: scored.truth,
      turns: out.turns, subtype: out.subtype, capped: out.capped,
      tool_counts: toolCounts(out.transcript),
      tokens_in: out.usage.input_tokens, tokens_out: out.usage.output_tokens,
      cache_read: out.usage.cache_read_input_tokens, cache_write: out.usage.cache_creation_input_tokens,
      ...usage, ...shapes,
    };
    rows.push(rec);
    await appendFile(rowsPath, JSON.stringify(rec) + "\n", "utf8");
    console.log(`  [${tag}] ${out.turns}t fidelity ${scored.metrics.fidelity} ` +
      `cache_read ${ktok(rec.cache_read)} ops/call ${JSON.stringify(shapes.batch_calls)}` +
      (out.capped ? "  *** CENSORED (hit the circuit breaker)" : ""));
  } catch (e) {
    const rec = { seed: s.seed, arm: s.arm, error: String(e) };
    rows.push(rec);
    await appendFile(rowsPath, JSON.stringify(rec) + "\n", "utf8");
    console.log(`  [${tag}] ERROR ${e}`);
  }
  await s.cleanup();
}

// ---- report -------------------------------------------------------------------------------------
// All summary arithmetic lives in the pure core (shapebatch-report.mjs), so it can be re-derived
// from a finished rows.jsonl with `--from <dir>` and argued with, instead of only ever existing as
// whatever this run happened to print. Censored rows are listed, never averaged.
await reportFrom(outDir);
