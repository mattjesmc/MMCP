// Category T orchestrator — the with/without tool ablation (testbench README, "are there wins?").
//
//   node testbench/run-tasks.mjs [--model haiku] [--arms with,without] [--seeds 2] [--reps 2]
//                                [--rungs 1-8] [--dry]
//
// Instantiates the task ladder per seed (live ground truth, staged + wild terrain), then runs
// every instance × arm × rep as a FRESH tool-using session (agent.mjs); the without-arm sees the
// toolkit minus REPRESENTATION_TOOLS via MCPTK_HIDE_TOOLS. Reports accuracy, confident-wrong,
// turns, tool calls and tokens per rung × arm — the deliverable is the two cost/accuracy curves.

import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";

import { bridgeUp, call } from "./bridge.mjs";
import { TEMPLATES, REPRESENTATION_TOOLS, RAW_READ_TOOLS, BASE_HIDDEN, rng, scoreTask, releaseArea } from "./tasks.mjs";
import { loadOf } from "./registry.mjs";
import { routesHashForRun } from "./routes-pin.mjs";
import { resumeDrift, completedCells, parseRows } from "./resume.mjs";
import { getAdapter } from "./adapter.mjs";
import { BENCH_VERSION } from "./version.mjs";
import { extractAnswer, score as quizScore } from "./quiz.mjs";
import { zeroTok, accTok, noCache, withCache, ktok, bothTok } from "./tokens.mjs";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const MODEL = opt("model", "haiku");
const SEEDS = parseInt(opt("seeds", "2"), 10);
const REPS = parseInt(opt("reps", "2"), 10);
// The system under test enters through the adapter seam (adapter.mjs); arms stay surface
// transforms handed to it. Default is the toolkit's own MCP shim — today's only adapter.
const ADAPTER = getAdapter(opt("adapter", "mcp-shim"));
// --rungs accepts a comma list of numbers and ranges, e.g. "1-8", "1-3,10-11", "4,7,10" — so a
// targeted experiment can pick single-target + multi-referent rungs without staging the ones between.
const RUNGS = (() => {
  const s = new Set();
  for (const tok of opt("rungs", "1-8").split(",")) {
    if (tok.includes("-")) { const [a, b] = tok.split("-").map(Number); for (let i = a; i <= b; i++) s.add(i); }
    else if (tok.trim()) s.add(Number(tok));
  }
  return s;
})();
const RUNGS_SORTED = [...RUNGS].sort((a, b) => a - b);
const DRY = args.includes("--dry");
// FREEZE_PLAN B1: `--resume <dir>` reuses an existing result dir instead of stamping a new one and
// SKIPS every (id, arm, rep) cell that already produced a non-error row. answers.jsonl is
// append-only, so the completed set is just read back off disk. Campaign-scale runs need this — a
// killed run currently costs the whole category (it cost Category T twice on 2026-07-26).
const RESUME = opt("resume", null);

// The tools the full-toolkit agent actually reaches for on the T ladder (observed across runs); the
// per-tool ablation only carries signal for these — hiding a tool no task exercises is a no-op.
// Override with `--loo a,b,c`. Everything outside this set is reported as "not exercised by this
// suite" (a task-coverage TODO, not a silent gap).
const LOO_DEFAULT = [
  "get_blocks_at", "describe_box", "check_site", "check_path", "get_region_summary", "get_surface", "check_fit",
];

// --loo [csv]: leave-one-out ablation. Generates a `full` baseline (BASE_HIDDEN only) plus one
// `no-<tool>` arm per candidate, each hiding exactly that tool on top of BASE_HIDDEN. The delta of
// each arm vs `full` is the tool's MARGINAL value given every other tool is present — a tool with a
// cheap substitute reads ~0 (that's the point: it measures whether the tool pulls weight on top of
// the rest, and is the regression baseline for working on that tool). Total value (tool + its
// substitutes) is the `without` group-arm, not this.
const LOO = args.includes("--loo");
const looArg = opt("loo", null); // may be the next flag (bare --loo) or a real csv
const LOO_TOOLS = LOO
  ? (looArg && !looArg.startsWith("--") ? looArg : LOO_DEFAULT.join(",")).split(",").map((s) => s.trim()).filter(Boolean)
  : [];

// An arm = (which tools are hidden) × (how get_surface is encoded). `surface` re-encodes get_surface
// as an ASCII surface map (index.mjs MCPTK_GET_BLOCKS_VIEW); it pairs with either tool set so we can
// ask both "does the compact view hurt the good arm?" (with vs surface) and "does it recover the
// raw-get_surface blowup?" (without vs without-surface).
const ARM_SPEC = LOO
  ? {
      full: { hidden: BASE_HIDDEN, view: "raw" },
      ...Object.fromEntries(LOO_TOOLS.map((t) => [`no-${t}`, { hidden: [...BASE_HIDDEN, t], view: "raw" }])),
    }
  : {
      with: { hidden: BASE_HIDDEN, view: "raw" },
      without: { hidden: [...BASE_HIDDEN, ...REPRESENTATION_TOOLS], view: "raw" },
      surface: { hidden: BASE_HIDDEN, view: "surface" },
      "without-surface": { hidden: [...BASE_HIDDEN, ...REPRESENTATION_TOOLS], view: "surface" },
      // The bill arm (TOOL_BILL_PLAN.md §6): raw reads hidden, representation tools + locate kept.
      // `without` prices the predicates; `swap` prices DELETING the 19% of the manifest the raw
      // reads occupy. Read it per rung — the deliverable is a capability map, not one number.
      swap: { hidden: [...BASE_HIDDEN, ...RAW_READ_TOOLS], view: "raw" },
      // The relational-rung join baseline (PATTERN_SEARCH_DESIGN §Bench): locate (incl. pattern)
      // hidden, raw reads kept — the model does the cross-domain join itself. Pairs with `swap`
      // as the forced-pattern capability arm; `with` is the free-choice discovery arm.
      "no-locate": { hidden: [...BASE_HIDDEN, "locate"], view: "raw" },
    };
const ARMS = LOO ? Object.keys(ARM_SPEC) : opt("arms", "with,without").split(",");
for (const a of ARMS) if (!ARM_SPEC[a]) throw new Error(`unknown arm "${a}" (known: ${Object.keys(ARM_SPEC).join(", ")})`);
const HIDDEN_BY_ARM = Object.fromEntries(ARMS.map((a) => [a, ARM_SPEC[a].hidden]));

if (!(await bridgeUp())) {
  console.error("no bridge — start the dev server (gradlew runServer) first");
  process.exit(1);
}

// Hide-lists must name real tools, or an arm silently isn't the arm we think it is.
const manifest = await fetch(
  (process.env.MCPTK_URL || "http://127.0.0.1:25599") + "/tools",
).then((r) => r.json());
// Shim-local tools are not in the bridge manifest, so they are checked against the local registry
// instead of being blanket-exempted. The old exemption was by NAME (`mem_locate`), which stopped
// being a check the moment that tool was deleted: the `with` arm would simply lose a representation
// tool and every score would still look valid. Same B4 rule, one registry over — can't express, throw.
const known = new Set(manifest.map((t) => t.name));
const localKnown = new Set((await import("../memory/tools.mjs")).localTools().map((t) => t.name));
for (const name of new Set(Object.values(HIDDEN_BY_ARM).flat())) {
  if (!known.has(name) && !localKnown.has(name)) {
    throw new Error(
      `hide-list names unknown tool "${name}" — it is in neither the bridge manifest nor the local ` +
      `memory registry, so hiding it hides NOTHING and the arms are not the arms they claim to be. ` +
      `Check BASE_HIDDEN/REPRESENTATION_TOOLS. (mem_locate was deleted by MEMORY_REDESIGN §3; its ` +
      `job now lives in \`locate\`'s concept fallthrough, which is a bridge tool.)`);
  }
}

console.log("== instantiate tasks ==");
const templates = TEMPLATES.filter((t) => RUNGS.has(t.rung));
const instances = [];
const loadedAreas = [];
for (let seed = 1; seed <= SEEDS; seed++) {
  for (const tpl of templates) {
    const r = rng(seed * 7919 + tpl.rung * 104729);
    process.stdout.write(`  ${tpl.id} seed ${seed} ... `);
    const t = await tpl.gen(seed, r);
    const inst = {
      ...t, id: `${tpl.id}.s${seed}`, rung: tpl.rung,
      // The measured load bands replace the old hand-written `difficulty` (registry.mjs LOAD_BANDS).
      ...loadOf(tpl.id), maxTurns: tpl.maxTurns, seed,
    };
    if (t.forceloaded) {
      const areas = Array.isArray(t.forceloaded[0]) ? t.forceloaded : [t.forceloaded];
      loadedAreas.push(...areas);
    }
    instances.push(inst);
    console.log(`truth ${JSON.stringify(t.truth)}`);
  }
}

const questionsHash = createHash("sha256")
  .update(JSON.stringify(instances.map(({ id, prompt, truth }) => ({ id, prompt, truth }))))
  .digest("hex").slice(0, 12);
console.log(`${instances.length} instances, hash ${questionsHash}`);

if (DRY) {
  for (const area of loadedAreas) await releaseArea(...area);
  console.log("dry run complete — no model spend");
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const resultsRoot = join(here, "..", "testbench-results");
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = RESUME
  ? (/[\\/]/.test(RESUME) ? RESUME : join(resultsRoot, RESUME))
  : join(resultsRoot, `${stamp}-tasks-${MODEL}`);
await mkdir(outDir, { recursive: true });
const answersPath = join(outDir, "answers.jsonl");
if (!RESUME) await writeFile(answersPath, "", "utf8");

const gradle = await readFile(join(here, "..", "..", "mcp-toolkit", "build.gradle"), "utf8");
// tools_hash fingerprints the RUNNING bridge (names+descriptions) — build.gradle's version once
// recorded 0.4.1 while an orphaned 0.4.0 server was still serving the world, which silently
// invalidated a rerun. The hash makes that class of drift visible in the manifest.
const toolsHash = createHash("sha256")
  .update(JSON.stringify(manifest.map((t) => [t.name, t.description])))
  .digest("hex").slice(0, 12);
// The vocabulary axis (ROUTE_LEDGER_DESIGN.md §8). `tools_hash` fingerprints the manifest, which the
// route layer never touches — so without this a run whose routes differ pools silently with one
// whose routes do not. routes-pin.mjs both applies the pin and reports it, so the manifest cannot
// record a mode the run did not execute.
const routesHash = routesHashForRun();

const gitHead = execSync("git rev-parse --short HEAD", { cwd: here }).toString().trim();
const manifestPath = join(outDir, "manifest.json");
const manifestBody = {
  date: new Date().toISOString(),
  category: "t",
  model: MODEL,
  bench_version: BENCH_VERSION,
  adapter: ADAPTER.name,
  tools_hash: toolsHash, routes_hash: routesHash,
  arms: Object.fromEntries(ARMS.map((a) => [a, ARM_SPEC[a]])),
  seeds: SEEDS, reps: REPS, rungs: RUNGS_SORTED,
  toolkit_version: gradle.match(/version = '([^']+)'/)?.[1] ?? "unknown",
  git_head: gitHead,
  questions_hash: questionsHash,
};

// Cells already completed, keyed (id|arm|rep). An ERROR row is not a result — it stays on disk as
// the record it is, but the cell is retried, so a crashed session doesn't become a permanent hole.
const done = new Set();
const priorRows = [];
if (RESUME) {
  let prior;
  try { prior = JSON.parse(await readFile(manifestPath, "utf8")); }
  catch { console.error(`--resume ${outDir}: no readable manifest.json — refusing to resume`); process.exit(2); }
  // Drift is fatal, not a warning: a resumed dir holds rows from two invocations under ONE manifest,
  // and every report treats a dir as homogeneous. Rules + rationale live in resume.mjs (unit-tested).
  const drift = resumeDrift(prior, manifestBody, ["rungs", "arms", "seeds", "reps"]);
  if (drift.length) {
    console.error(`--resume ${outDir}: the run has DRIFTED from the dir being resumed — resuming would pool incomparable rows:\n  ${drift.join("\n  ")}\nStart a fresh run instead.`);
    process.exit(2);
  }
  priorRows.push(...parseRows(await readFile(answersPath, "utf8").catch(() => "")));
  for (const c of completedCells(priorRows, (r) => `${r.id}|${r.arm}|${r.rep}`)) done.add(c);
  // Record the resume without losing the original run's date/git_head.
  prior.resumes = [...(prior.resumes ?? []), { date: manifestBody.date, git_head: gitHead, resumed_cells: done.size }];
  await writeFile(manifestPath, JSON.stringify(prior, null, 2), "utf8");
  console.log(`[resume] ${outDir}\n[resume] ${done.size} cell(s) already complete; ${priorRows.length - done.size} error row(s) will be retried`);
} else {
  await writeFile(manifestPath, JSON.stringify(manifestBody, null, 2), "utf8");
}

// Arms interleave per instance so world/service drift never lands on one arm only.
// Prior rows seed `results` so the summary describes the WHOLE run, not just this leg of it.
const results = [...priorRows];
for (const inst of instances) {
  for (let rep = 1; rep <= REPS; rep++) {
    for (const arm of ARMS) {
      const label = `${inst.id} ${arm} rep${rep}`;
      if (done.has(`${inst.id}|${arm}|${rep}`)) { console.log(`  ${label} ... skip (already done)`); continue; }
      process.stdout.write(`  ${label} ... `);
      try {
        const run = await ADAPTER.run({
          model: MODEL, prompt: inst.prompt, maxTurns: inst.maxTurns,
          surface: { hiddenTools: ARM_SPEC[arm].hidden, view: ARM_SPEC[arm].view },
        });
        const answer = extractAnswer(run.text);
        const s = scoreTask(inst, answer, quizScore);
        const rec = {
          id: inst.id, rung: inst.rung, seed: inst.seed,
          tool_dependence: inst.tool_dependence ?? null, reasoning_load: inst.reasoning_load ?? null,
          arm, rep, question: inst.prompt, truth: inst.truth, answer, ...s,
          turns: run.turns, tool_calls: run.toolCalls, tools: run.toolHistogram,
          trace: run.trace, repeat_calls: run.repeatCalls, error_calls: run.errorCalls,
          hit_turn_cap: run.hitTurnCap, stop_reason: run.stopReason,
          tokens_in: run.usage?.input_tokens ?? null,
          tokens_out: run.usage?.output_tokens ?? null,
          cache_read: run.usage?.cache_read_input_tokens ?? null,
          cache_write: run.usage?.cache_creation_input_tokens ?? null,
          ms: run.ms,
          reply_tail: run.text.slice(-300),
        };
        results.push(rec);
        await appendFile(answersPath, JSON.stringify(rec) + "\n", "utf8");
        console.log(`${s.correct ? "OK " : s.abstained ? "ABSTAIN" : "WRONG"} (${answer ?? "no ANSWER"}) ${run.turns}t/${run.toolCalls}c ${run.ms}ms`);
      } catch (e) {
        const rec = { id: inst.id, rung: inst.rung, arm, rep, error: String(e) };
        results.push(rec);
        await appendFile(answersPath, JSON.stringify(rec) + "\n", "utf8");
        console.log(`ERROR ${e}`);
      }
    }
  }
}

for (const area of loadedAreas) await releaseArea(...area);

// -- summary: the two curves ---------------------------------------------------------------------
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const fmt = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : "-");
const cell = (recs) => {
  const ok = recs.filter((r) => r.correct).length;
  const cw = recs.filter((r) => r.correct === false && !r.abstained && !r.error).length;
  const ab = recs.filter((r) => r.abstained).length;
  const sum = recs.reduce(accTok, zeroTok());
  return {
    n: recs.length, acc: ok / recs.length, cw, ab,
    turns: mean(recs.map((r) => r.turns).filter(Number.isFinite)),
    calls: mean(recs.map((r) => r.tool_calls).filter(Number.isFinite)),
    tokNc: noCache(sum) / recs.length, tokWc: withCache(sum) / recs.length, // per-session means
    caps: recs.filter((r) => r.hit_turn_cap).length,
  };
};

const lines = [`# Category T run ${stamp} — model ${MODEL}, arms ${ARMS.join(" vs ")}`, ""];
lines.push(`${instances.length} instances × ${REPS} reps × ${ARMS.length} arms, questions ${questionsHash}`, "");
lines.push(`| rung | arm | acc | conf-wrong | abstain | turn-caps | mean turns | mean calls | mean tok nc/wc |`);
lines.push(`|---|---|---|---|---|---|---|---|---|`);
for (const rung of RUNGS_SORTED) {
  for (const arm of ARMS) {
    const recs = results.filter((r) => r.rung === rung && r.arm === arm && !r.error);
    if (!recs.length) continue;
    const c = cell(recs);
    lines.push(`| ${rung} | ${arm} | ${(c.acc * 100).toFixed(0)}% (${recs.filter((r) => r.correct).length}/${c.n}) | ${c.cw} | ${c.ab} | ${c.caps} | ${fmt(c.turns)} | ${fmt(c.calls)} | ${ktok(c.tokNc)}/${ktok(c.tokWc)} |`);
  }
}
// -- per-tool marginal value (LOO): each no-<tool> arm vs the full baseline -----------------------
if (LOO) {
  const base = cell(results.filter((r) => r.arm === "full" && !r.error));
  lines.push("", "## Per-tool marginal value — leave-one-out vs full baseline");
  lines.push(`baseline **full**: ${(base.acc * 100).toFixed(0)}% acc, ${ktok(base.tokWc)} tok/session (with-cache). ` +
    `Δacc<0 and Δtok>0 mean the tool was pulling weight; ≈0 means a substitute covered for it.`);
  lines.push("", `| ablated tool | acc | Δacc | tok/session | Δtok | rungs it owns (acc drop) |`);
  lines.push(`|---|---|---|---|---|---|`);
  for (const t of LOO_TOOLS) {
    const arm = `no-${t}`;
    const recs = results.filter((r) => r.arm === arm && !r.error);
    if (!recs.length) { lines.push(`| ${t} | — | — | — | — | (no data) |`); continue; }
    const c = cell(recs);
    // rungs where this arm lost accuracy vs the baseline's per-rung accuracy
    const drops = [];
    for (const rung of RUNGS_SORTED) {
      const br = cell(results.filter((r) => r.rung === rung && r.arm === "full" && !r.error));
      const ar = cell(results.filter((r) => r.rung === rung && r.arm === arm && !r.error));
      if (ar.n && br.n && ar.acc < br.acc - 1e-9) drops.push(`r${rung} ${(br.acc * 100).toFixed(0)}→${(ar.acc * 100).toFixed(0)}%`);
    }
    const dAcc = (c.acc - base.acc) * 100, dTok = c.tokWc - base.tokWc;
    lines.push(`| ${t} | ${(c.acc * 100).toFixed(0)}% | ${dAcc >= 0 ? "+" : ""}${dAcc.toFixed(0)} | ${ktok(c.tokWc)} | ${dTok >= 0 ? "+" : ""}${ktok(dTok)} | ${drops.join(", ") || "—"} |`);
  }
  // Coverage: candidate tools the agent never called in the baseline can't be ablated meaningfully.
  const usedTools = new Set(results.filter((r) => r.arm === "full").flatMap((r) => Object.keys(r.tools || {})));
  const uncovered = LOO_TOOLS.filter((t) => !usedTools.has(t));
  if (uncovered.length) lines.push("", `> not exercised by this suite (Δ is 0 by construction — the baseline never called them): ${uncovered.join(", ")}`);
}

lines.push("", "## Totals per arm (tokens no-cache/with-cache — with-cache is real throughput; cache read dominates)");
for (const arm of ARMS) {
  const recs = results.filter((r) => r.arm === arm && !r.error);
  const c = cell(recs);
  const sum = recs.reduce(accTok, zeroTok());
  const ok = recs.filter((r) => r.correct).length;
  const repeats = recs.reduce((s, r) => s + (r.repeat_calls ?? 0), 0);
  const errored = recs.reduce((s, r) => s + (r.error_calls ?? 0), 0);
  lines.push(`- **${arm}**: ${(c.acc * 100).toFixed(0)}% accuracy, ${c.cw} confident-wrong, ${c.ab} abstained, ${c.caps} turn-caps, ` +
    `tokens ${bothTok(sum)} (${ok ? ktok(withCache(sum) / ok) : "-"}/correct with-cache), ${repeats} repeated calls, ${errored} errored calls`);
}
const errs = results.filter((r) => r.error);
if (errs.length) {
  lines.push("", "## Errors");
  for (const r of errs) lines.push(`- ${r.id} ${r.arm} rep${r.rep}: ${r.error}`);
}
lines.push("", "## Per run");
for (const r of results.filter((r) => !r.error)) {
  lines.push(`- ${r.id} ${r.arm} rep${r.rep}: ${r.correct ? "OK" : r.abstained ? "abstain" : "WRONG"} — got "${r.answer}", truth ${JSON.stringify(r.truth)} (${r.turns}t, ${r.tool_calls} calls${r.hit_turn_cap ? ", TURN CAP" : ""})`);
}
const summary = lines.join("\n") + "\n";
await writeFile(join(outDir, "summary.md"), summary, "utf8");
console.log(`\n${summary}\nresults → ${outDir}`);
