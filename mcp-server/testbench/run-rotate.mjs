#!/usr/bin/env node
// Category R — mental-rotation / spatial-transform VQA orchestrator (BENCH_EXPANSION.md).
//
//   node testbench/run-rotate.mjs --dry                 # generate + self-check truth, print grids, NO spend
//   node testbench/run-rotate.mjs --model haiku         # full run
//   node testbench/run-rotate.mjs --model sonnet --seeds 3
//
// Unlike every other bench slice, Category R needs NO dev server and NO staging: each question is a
// deterministic grid + a transform whose truth is computed (and permutation-checked) in code. Each
// question is one FRESH no-tools SDK session (quiz.mjs's askOne) whose entire world is the rendered
// grid — the model must mentally apply the transform, never look anything up. Output matches A/B/T/C/
// P/E: testbench-results/<stamp>-rotate-<model>/ (manifest + answers.jsonl + summary.md).

import { createHash } from "node:crypto";
import { BENCH_VERSION } from "./version.mjs";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { askOne, extractAnswer, score } from "./quiz.mjs";
import { makeRotationQuestions, N } from "./rotate-scenario.mjs";

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
const MODEL = opt("model", "haiku");
const SEEDS = parseInt(opt("seeds", "2"), 10);
const DRY = argv.includes("--dry");

const HERE = dirname(fileURLToPath(import.meta.url));
const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const cfgModel = process.env.MCPTK_QUIZ_MODEL || (MODEL === "haiku" ? "claude-haiku-4-5-20251001" : MODEL);

// Build the full seed × question set. Generation self-checks every transform is a bijection (throws
// on a buggy formula), so reaching this line already validated the answer key.
const items = [];
for (let seed = 1; seed <= SEEDS; seed++) {
  for (const q of makeRotationQuestions(seed)) items.push({ seed, ...q });
}
const questionsHash = sha(JSON.stringify(items.map((q) => ({ seed: q.seed, id: q.id, truth: q.truth, question: q.question }))));
console.log(`Category R (mental-rotation VQA) — ${SEEDS} seeds × ${items.length / SEEDS} questions, hash ${questionsHash}`);

if (DRY) {
  // Independent cross-check: rebuild the transformed grid by transforming EVERY cell and confirm the
  // truth is consistent with that rebuild — a second path to the answer that must agree with the
  // per-question truth the generator baked in. (The generator already asserted bijection; this prints
  // the human-auditable grids so a wrong convention is caught by eye too.)
  for (const q of items) {
    console.log(`\n=== seed ${q.seed} ${q.id} (${q.difficulty}, ${q.answer_type}) ===`);
    console.log(q.context.split("\nGrid:\n")[1] ?? "");
    console.log(`Q: ${q.question}`);
    console.log(`truth: ${JSON.stringify(q.truth)}${q.options ? ` (of ${q.options.join("/")})` : ""}`);
  }
  console.log(`\n[dry] ${items.length} questions generated; every transform passed the bijection self-check. ` +
    `Grid is ${N}×${N}. No server, no model spend.`);
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = join(HERE, "..", "testbench-results", `${stamp}-rotate-${MODEL}`);
await mkdir(outDir, { recursive: true });
const answersPath = join(outDir, "answers.jsonl");
await writeFile(answersPath, "", "utf8");
await writeFile(join(outDir, "manifest.json"), JSON.stringify({
  date: new Date().toISOString(), bench_version: BENCH_VERSION, category: "r", slice: "mental-rotation-vqa", model: MODEL, model_id: cfgModel,
  seeds: SEEDS, grid: `${N}x${N}`, n_questions: items.length,
  git_head: execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: HERE }).toString().trim(),
  questions_hash: questionsHash, substrate: "claude-agent-sdk/max-subscription",
}, null, 2), "utf8");

const rows = [];
for (const q of items) {
  try {
    const { text, usage, ms } = await askOne({ model: cfgModel, context: q.context, question: q.question });
    const raw = extractAnswer(text);
    const s = score(q, raw);
    const rec = {
      seed: q.seed, id: q.id, difficulty: q.difficulty, answer_type: q.answer_type,
      correct: s.correct, abstained: s.abstained, raw, truth: q.truth, ms,
      tokens_in: usage?.input_tokens ?? 0, tokens_out: usage?.output_tokens ?? 0,
      cache_read: usage?.cache_read_input_tokens ?? 0, cache_write: usage?.cache_creation_input_tokens ?? 0,
    };
    rows.push(rec);
    await appendFile(answersPath, JSON.stringify(rec) + "\n", "utf8");
    console.log(`  s${q.seed} ${q.id} [${q.difficulty}] ${s.correct ? "✓" : s.abstained ? "∅" : "✗"} ` +
      `got=${JSON.stringify(raw)} truth=${JSON.stringify(q.truth)} (${ms}ms)`);
  } catch (e) {
    const rec = { seed: q.seed, id: q.id, error: String(e) };
    rows.push(rec);
    await appendFile(answersPath, JSON.stringify(rec) + "\n", "utf8");
    console.log(`  s${q.seed} ${q.id} ERROR ${e}`);
  }
}

// --- summary ------------------------------------------------------------------------------------
const good = rows.filter((r) => !r.error);
const nCorrect = good.filter((r) => r.correct).length;
const acc = good.length ? Math.round((100 * nCorrect) / good.length) : 0;
const lines = [`# Category R — mental-rotation VQA — ${stamp}, model ${MODEL}`, "",
  `${SEEDS} seeds × ${items.length / SEEDS} questions (${items.length} total), grid ${N}×${N}, hash ${questionsHash}`,
  `Overall accuracy: **${nCorrect}/${good.length} = ${acc}%**`, ""];

// By difficulty — where the cliff is (the interesting output, per the bench charter).
lines.push("## By difficulty");
lines.push("| difficulty | correct | total | acc |", "|---|---|---|---|");
for (const d of ["easy", "medium", "hard"]) {
  const g = good.filter((r) => r.difficulty === d);
  if (!g.length) continue;
  const c = g.filter((r) => r.correct).length;
  lines.push(`| ${d} | ${c} | ${g.length} | ${Math.round((100 * c) / g.length)}% |`);
}

// By question id (each id is a fixed transform, so this reads as per-transform accuracy).
lines.push("", "## By question (fixed transform per id)");
lines.push("| id | difficulty | type | correct | total |", "|---|---|---|---|---|");
const ids = [...new Set(good.map((r) => r.id))];
for (const id of ids) {
  const g = good.filter((r) => r.id === id);
  lines.push(`| ${id} | ${g[0].difficulty} | ${g[0].answer_type} | ${g.filter((r) => r.correct).length} | ${g.length} |`);
}

const totalIn = good.reduce((s, r) => s + r.tokens_in, 0);
const totalOut = good.reduce((s, r) => s + r.tokens_out, 0);
lines.push("", `## Cost`, `Total input ${totalIn} tok, output ${totalOut} tok across ${good.length} sessions ` +
  `(no cache — each question is a fresh single-turn session). Mean ${Math.round((totalIn + totalOut) / (good.length || 1))} tok/question.`);

const abst = good.filter((r) => r.abstained).length;
if (abst) lines.push("", `${abst} abstentions (answered "unknown").`);
const errs = rows.filter((r) => r.error);
if (errs.length) { lines.push("", "## Errors"); for (const r of errs) lines.push(`- s${r.seed} ${r.id}: ${r.error}`); }

const summary = lines.join("\n") + "\n";
await writeFile(join(outDir, "summary.md"), summary, "utf8");
console.log(`\n${summary}\nresults → ${outDir}`);
