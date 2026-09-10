#!/usr/bin/env node
// Category Z, slice Z-diagnose orchestrator. Per seed × kind: the HARNESS stages a code-known
// circuit (diagnose-scenario.mjs), a READ-ONLY session inspects it and answers one question, and
// the answer is scored mechanically against a truth the harness live-verified by real intervention
// at setup (drive inputs / repair the fault / remove the wire, assert, restore). The read direction
// of z-redstone: causal + counterfactual + relational READING, not building.
//
//   node testbench/run-diagnose.mjs --dry                  # stage + intervention self-checks, no model
//   node testbench/run-diagnose.mjs --model haiku --seeds 2
//   node testbench/run-diagnose.mjs --model haiku --kinds fault,whatif

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
import { makeDiagnosePuzzle, DIAGNOSE_KINDS, DIAGNOSE_TOOLS } from "./diagnose-scenario.mjs";
import { extractAnswer, score as quizScore } from "./quiz.mjs";
import { bothTok, zeroTok, accTok } from "./tokens.mjs";

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
const MODEL = opt("model", "haiku");
const SEEDS = parseInt(opt("seeds", "1"), 10);
const KINDS = opt("kinds", DIAGNOSE_KINDS.join(",")).split(",").filter((k) => DIAGNOSE_KINDS.includes(k));
const DRY = argv.includes("--dry");

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIM = join(HERE, "..", "ablation", "mcp-shim.mjs");
const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const cfgModel = process.env.MCPTK_ABLATION_MODEL || (MODEL === "haiku" ? "claude-haiku-4-5-20251001" : MODEL);

const CHARTER = `You are an expert Minecraft redstone engineer called in to DIAGNOSE an existing \
circuit. You have READ-ONLY tools (get_blocks_at/describe_box/get_surface) — you cannot change anything. \
Read the actual wiring cell by cell; base your answer only on what the world contains, and reason \
about vanilla redstone semantics (wire connectivity, signal falloff, what powers what). Finish with \
one line: ANSWER: <your answer>.`;

const ping = await bridge("ping", {});
if (!ping.ok) { console.error(`no bridge — start the dev server first (${ping.error})`); process.exit(1); }
const manifest = await fetchManifest();
const known = new Set(manifest.map((t) => t.name));
for (const n of DIAGNOSE_TOOLS) if (!known.has(n)) throw new Error(`unknown tool "${n}" — read surface missing?`);

const instances = [];
for (let seed = 1; seed <= SEEDS; seed++) for (const kind of KINDS) instances.push(makeDiagnosePuzzle({ seed, kind }));
const questionsHash = sha(JSON.stringify(instances.map((s) => ({ seed: s.seed, kind: s.kind }))));
console.log(`Category Z (diagnose) — ${SEEDS} seeds × kinds [${KINDS.join(",")}], questions ${questionsHash}`);

if (DRY) {
  for (const s of instances) {
    console.log(`\n=== ${s.kind} seed ${s.seed} (truth ${JSON.stringify(s.truth)}) ===`);
    await s.setup();
    const chk = await s.selfCheck(); // throws if the staged truth does not survive live intervention
    console.log(`  intervention self-check: ${JSON.stringify(chk)}`);
    await s.cleanup();
  }
  console.log(`\n[dry] every truth verified by live intervention (drive/repair/remove + restore). No model spend.`);
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = join(HERE, "..", "testbench-results", `${stamp}-diagnose-${MODEL}`);
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
  date: new Date().toISOString(), bench_version: BENCH_VERSION, category: "z", slice: "diagnose", model: MODEL, model_id: cfgModel,
  seeds: SEEDS, kinds: KINDS, git_head: execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: HERE }).toString().trim(),
  questions_hash: questionsHash, tools: DIAGNOSE_TOOLS, tools_hash: toolsHash, routes_hash: routesHash, substrate: "claude-agent-sdk/max-subscription",
}, null, 2), "utf8");

const rows = [];
for (const s of instances) {
  console.log(`\n[${s.kind} s${s.seed}] setup + self-check`);
  await s.setup();
  const tag = `${s.name}-s${s.seed}-${s.kind}`;
  try {
    await s.selfCheck(); // the answer key must survive live intervention BEFORE the model runs
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
    const answer = extractAnswer(out.finalText ?? "");
    const sc = quizScore({ answer_type: s.answer_type, options: s.options, truth: s.truth }, answer);
    const rec = {
      scenario: s.name, seed: s.seed, kind: s.kind, model: MODEL,
      truth: s.truth, answer, ...sc,
      turns: out.turns, subtype: out.subtype, capped: out.capped, tool_counts: toolCounts(out.transcript),
      tokens_in: out.usage.input_tokens, tokens_out: out.usage.output_tokens,
      cache_read: out.usage.cache_read_input_tokens, cache_write: out.usage.cache_creation_input_tokens,
      reply_tail: (out.finalText ?? "").slice(-200),
    };
    rows.push(rec);
    await appendFile(answersPath, JSON.stringify(rec) + "\n", "utf8");
    console.log(`  [${tag}] ${sc.correct ? "OK" : sc.abstained ? "ABSTAIN" : "WRONG"} (${answer ?? "no ANSWER"}) — ${out.turns}t`);
  } catch (e) {
    const rec = { scenario: s.name, seed: s.seed, kind: s.kind, error: String(e) };
    rows.push(rec);
    await appendFile(answersPath, JSON.stringify(rec) + "\n", "utf8");
    console.log(`  [${tag}] ERROR ${e}`);
  }
  await s.cleanup();
}

const good = rows.filter((r) => !r.error);
const lines = [`# Category Z — diagnose (read) — ${stamp}, model ${MODEL}`, "",
  `${SEEDS} seeds × kinds [${KINDS.join(",")}], questions ${questionsHash}`, ""];
if (good.length) {
  lines.push("## Per puzzle", `| seed | kind | truth | answer | verdict | turns | tok nc/wc |`, `|---|---|---|---|---|---|---|`);
  for (const r of good) lines.push(
    `| ${r.seed} | ${r.kind} | ${r.truth} | ${r.answer ?? "—"} | ${r.correct ? "OK" : r.abstained ? "abstain" : "WRONG"} | ${r.turns} | ${bothTok(accTok(zeroTok(), r))} |`);
  const ok = good.filter((r) => r.correct).length;
  const acc = accTok(good.reduce((a, r) => accTok(a, r), zeroTok()), {});
  lines.push("", `## Totals`, `Correct: **${ok}/${good.length}**. Total tokens ${bothTok(acc)}.`);
}
const errs = rows.filter((r) => r.error);
if (errs.length) { lines.push("", "## Errors"); for (const r of errs) lines.push(`- ${r.kind} s${r.seed}: ${r.error}`); }
const summary = lines.join("\n") + "\n";
await writeFile(join(outDir, "summary.md"), summary, "utf8");
console.log(`\n${summary}\nresults → ${outDir}`);
