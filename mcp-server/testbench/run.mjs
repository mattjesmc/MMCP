#!/usr/bin/env node
// Testbench orchestrator (REPRESENTATION_DESIGN §5, TODO.md §Testbench) — slice A+B.
//
//   node testbench/run.mjs [--model haiku] [--cat a,b] [--seeds 1,2,3] [--towers 4]
//                          [--walk full|thin] [--formats json_coords,palette_rows,ascii_grid]
//                          [--limit N] [--dry]
//
// For each SEED: stages that seed's arena, records the scripted walk, derives questions with
// live-verified ground truth, then quizzes a FRESH no-tools session per question, machine-scores,
// and writes testbench-results/<stamp>/{manifest.json, answers.jsonl, summary.md}. --dry stops
// after question generation (harness check without model spend).
//
// SEEDS: Category A used to be a single fixed arena with a hand-written answer key, so it could not
// be resampled and every cell rested on n=2 over one memorizable world. The arena is now generated
// (arena.mjs) and `--seeds` is the sample size. Seeds are staged and quizzed one at a time because
// they all occupy the same origin — each seed's arena OVERWRITES the previous one, so its transcript
// and live-verified truths must be captured before the next seed is staged.

import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { BENCH_VERSION } from "./version.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";

import { bridgeUp } from "./bridge.mjs";
import { makeArena, arenaNeedles } from "./arena.mjs";
import { stageArena } from "./stage.mjs";
import { observeWalk, renderObservations } from "./observe.mjs";
import { generateCatA } from "./questions.mjs";
import { generateCatB, FORMATS, patchData } from "./formats.mjs";
import { askOne, extractAnswer, score } from "./quiz.mjs";
import { zeroTok, accTok, bothTok } from "./tokens.mjs";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const MODEL = opt("model", "haiku");
const CATS = opt("cat", "a,b").split(",");
const SEEDS = opt("seeds", "1,2").split(",").map((s) => parseInt(s.trim(), 10));
const TOWERS = parseInt(opt("towers", "4"), 10);
const WALK = opt("walk", "full");
const FORMAT_NAMES = opt("formats", "json_coords,palette_rows,ascii_grid").split(",");
const LIMIT = parseInt(opt("limit", "999"), 10);
const DRY = args.includes("--dry");

if (SEEDS.some((s) => !Number.isFinite(s))) {
  console.error(`--seeds must be integers, got "${opt("seeds", "")}"`);
  process.exit(2);
}
if (!(await bridgeUp())) {
  console.error("no bridge — start the dev server (gradlew runServer) first");
  process.exit(1);
}

// -- stage + observe + generate, one seed at a time ----------------------------------------------
const prepared = [];
for (const seed of SEEDS) {
  const arena = makeArena(seed, { towerCount: TOWERS, walk: WALK });
  console.log(`== seed ${seed}: stage ==`);
  await stageArena(arena);
  console.log(`== seed ${seed}: observe ==`);
  const observations = await observeWalk(arena);
  const walkContext = renderObservations(observations);
  console.log(`  walk transcript: ${walkContext.length} chars, ${arena.walk.length} stops`);

  // Transcript integrity: every feature a question asks about must actually be OBSERVABLE in the
  // walk. The first haiku run failed this silently — the arena sat under a tree canopy, the
  // heightmap showed leaves, and "how many towers" was unanswerable. The needle list is DERIVED from
  // the arena now (a hardcoded list cannot follow a seeded arena's colours and liquids).
  for (const needle of arenaNeedles(arena)) {
    if (!walkContext.includes(needle)) {
      throw new Error(`bench invariant (seed ${seed}): "${needle}" never appears in the walk ` +
        "transcript — the arena is not cleanly observable (canopy/terrain contamination?)");
    }
  }

  console.log(`== seed ${seed}: questions ==`);
  const catA = CATS.includes("a") ? (await generateCatA(arena)).slice(0, LIMIT) : [];
  const catB = CATS.includes("b") ? generateCatB(arena).slice(0, LIMIT) : [];
  console.log(`  cat A: ${catA.length}, cat B: ${catB.length} × ${FORMAT_NAMES.length} formats`);
  prepared.push({ seed, arena, walkContext, catA, catB });
}

const here = dirname(fileURLToPath(import.meta.url));
const questionsHash = createHash("sha256")
  .update(JSON.stringify(prepared.map((p) => ({ seed: p.seed, catA: p.catA, catB: p.catB }))))
  .update(JSON.stringify({ formats: FORMAT_NAMES }))
  .digest("hex").slice(0, 12);

if (DRY) {
  console.log(`dry run complete — ${prepared.length} seed(s), questions_hash ${questionsHash}, no model spend`);
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = join(here, "..", "testbench-results", `${stamp}-${MODEL}`);
await mkdir(outDir, { recursive: true });
const answersPath = join(outDir, "answers.jsonl");
await writeFile(answersPath, "", "utf8");

const gradle = await readFile(join(here, "..", "..", "mcp-toolkit", "build.gradle"), "utf8");
const manifest = {
  date: new Date().toISOString(), bench_version: BENCH_VERSION,
  model: MODEL,
  toolkit_version: gradle.match(/version = '([^']+)'/)?.[1] ?? "unknown",
  git_head: execSync("git rev-parse --short HEAD", { cwd: here }).toString().trim(),
  categories: CATS,
  seeds: SEEDS,
  towers: TOWERS,
  walk: WALK,
  formats: FORMAT_NAMES,
  questions_hash: questionsHash,
  walk_context_chars: prepared.map((p) => p.walkContext.length),
};
await writeFile(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

const results = [];
async function runOne(cat, format, context, q, seed) {
  const label = `s${seed} ${q.id}${format ? `/${format}` : ""}`;
  process.stdout.write(`  ${label} ... `);
  try {
    const { text, usage, ms } = await askOne({ model: MODEL, context, question: q.question });
    const answer = extractAnswer(text);
    const s = score(q, answer);
    const rec = {
      cat, format: format ?? null, id: q.id, seed, reasoning_load: q.reasoning_load ?? null,
      question: q.question, truth: q.truth, answer, ...s,
      tokens_in: usage?.input_tokens ?? null, tokens_out: usage?.output_tokens ?? null,
      cache_read: usage?.cache_read_input_tokens ?? null, cache_write: usage?.cache_creation_input_tokens ?? null, ms,
      reply_tail: text.slice(-300),
    };
    results.push(rec);
    await appendFile(answersPath, JSON.stringify(rec) + "\n", "utf8");
    console.log(`${s.correct ? "OK " : s.abstained ? "ABSTAIN" : "WRONG"} (${answer ?? "no ANSWER line"}) ${ms}ms`);
  } catch (e) {
    const rec = { cat, format: format ?? null, id: q.id, seed, reasoning_load: q.reasoning_load ?? null, error: String(e) };
    results.push(rec);
    await appendFile(answersPath, JSON.stringify(rec) + "\n", "utf8");
    console.log(`ERROR ${e}`);
  }
}

for (const p of prepared) {
  if (p.catA.length) {
    console.log(`== quiz cat A seed ${p.seed} (${MODEL}) ==`);
    for (const q of p.catA) await runOne("a", null, p.walkContext, q, p.seed);
  }
  if (p.catB.length) {
    const cells = patchData(p.arena);
    for (const f of FORMAT_NAMES) {
      console.log(`== quiz cat B / ${f} seed ${p.seed} (${MODEL}) ==`);
      const context = FORMATS[f](cells, p.arena);
      for (const q of p.catB) await runOne("b", f, context, q, p.seed);
    }
  }
}

// -- summary -----------------------------------------------------------------------------------
const by = (recs, key) => {
  const m = new Map();
  for (const r of recs) {
    const k = key(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
};
const acc = (recs) => {
  const ok = recs.filter((r) => r.correct).length;
  const wrong = recs.filter((r) => r.correct === false && !r.abstained).length;
  const abstained = recs.filter((r) => r.abstained).length;
  return `${ok}/${recs.length} correct, ${wrong} confident-wrong, ${abstained} abstained`;
};

const lines = [`# Testbench run ${stamp} — model ${MODEL}`, ""];
lines.push(`toolkit ${manifest.toolkit_version} @ ${manifest.git_head}, questions ${questionsHash}`);
lines.push(`seeds ${SEEDS.join(",")}, towers ${TOWERS}, walk ${WALK}`, "");
const aRecs = results.filter((r) => r.cat === "a" && !r.error);
if (aRecs.length) {
  lines.push(`## Category A — spatial cognition: ${acc(aRecs)}`);
  for (const [d, recs] of by(aRecs, (r) => r.reasoning_load)) lines.push(`- reasoning_load ${d}: ${acc(recs)}`);
  for (const [s, recs] of by(aRecs, (r) => r.seed)) lines.push(`- seed ${s}: ${acc(recs)}`);
  lines.push(`- tokens (no-cache/with-cache): ${bothTok(aRecs.reduce(accTok, zeroTok()))}`, "");
}
const bRecs = results.filter((r) => r.cat === "b" && !r.error);
if (bRecs.length) {
  lines.push(`## Category B — serialization formats: ${acc(bRecs)}`);
  for (const [f, recs] of by(bRecs, (r) => r.format)) {
    lines.push(`- ${f}: ${acc(recs)} — tokens ${bothTok(recs.reduce(accTok, zeroTok()))} (no-cache/with-cache)`);
  }
  lines.push("");
}
lines.push("## Per question");
for (const r of results) {
  lines.push(r.error
    ? `- s${r.seed} ${r.id}${r.format ? `/${r.format}` : ""}: ERROR ${r.error}`
    : `- s${r.seed} ${r.id}${r.format ? `/${r.format}` : ""} [${r.reasoning_load ?? "-"}]: ${r.correct ? "OK" : r.abstained ? "abstain" : "WRONG"} — got "${r.answer}", truth ${JSON.stringify(r.truth)}`);
}
const summary = lines.join("\n") + "\n";
await writeFile(join(outDir, "summary.md"), summary, "utf8");
console.log(`\n${summary}\nresults → ${outDir}`);
