#!/usr/bin/env node
// Category C orchestrator — the memory recall depth fixture (CATEGORY_C_DESIGN.md).
//
//   node testbench/run-memory.mjs [--model haiku] [--arch full,no-recall] [--seeds 1] [--dry]
//                                 [--no-setup] [--budget 500]
//
// Phases per seed: setup → explore (3 fresh sessions BUILD the corpus under the full toolset) →
// freeze + mutate the depot chest → quiz (per arch arm: clone the frozen corpus, one fresh
// no-re-survey session answers the gradient, scored mechanically). Output matches Categories A/B/T:
// testbench-results/<stamp>-mem-<model>/ with manifest.json + answers.jsonl + summary.md.
//
// Reuse map (imports, never copies): the fresh-session SDK runner, the condition-filtered MCP shim,
// the staging vocabulary, the pipeline funnel, corpus freeze/clone, and the charter — all from
// ablation/. The arch axis maps onto the ablation's own validated conditions: full = d,
// no-recall = c (d minus mem_recall exactly). Explore always runs under d.

import { createHash } from "node:crypto";
import { BENCH_VERSION } from "./version.mjs";
import { routesHashForRun } from "./routes-pin.mjs";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile, appendFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CONDITIONS, AGENT_WORLD_TOOLS } from "../ablation/conditions.mjs";
import { buildSystemPrompt, buildOpeningMessage, assertPromptNesting, assertPromptPairs } from "../ablation/charter.mjs";
import { bridge, fetchManifest, cmd } from "../ablation/bridge.mjs";
import { runEpisodeSdk } from "../ablation/runner-sdk.mjs";
import { cloneMemoryDir } from "../ablation/clone.mjs";
import { toolCounts, factFunnel } from "../ablation/metrics.mjs";
import { zeroTok, accTok, tokFields, noCache, withCache, ktok, bothTok } from "./tokens.mjs";
import { formatCompactionNag } from "../memory/store.mjs";
import * as stage from "../ablation/scenarios/stage.mjs";
import { makeMemScenario, CHANGE_RUNG_VERSION, EXPLORE_PROMPT_VERSION } from "./mem-scenario.mjs";
import { resumeDrift, completedCells, parseRows, corpusOnDisk } from "./resume.mjs";

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
const MODEL = opt("model", "haiku");
const ARCH = opt("arch", "full").split(",");      // full | no-recall (or both)
// The WORKFLOW axis (orthogonal to arch, which ablates the recall tool): recall = answer from
// memory alone; revisit = memory locates, the world is re-read before answering; change = what
// changed here since the last visit. Default is `recall` alone, so an unflagged run — including the
// full bench — is byte-identical to before.
const WORKFLOWS = ["recall", "revisit", "change"];
// FREEZE_PLAN B1 — see resume.mjs. A C cell is (seed, arm); a seed's corpus is reused from disk.
const RESUME = opt("resume", null);
const workflowsRaw = opt("workflow", "recall").split(",");
for (const w of workflowsRaw) if (!WORKFLOWS.includes(w)) { console.error(`--workflow must be ${WORKFLOWS.join("|")} (got ${w})`); process.exit(2); }
// `change` MUTATES the probe platforms, and the recall/revisit truths are construction truths about
// the un-mutated world — so change always runs LAST within a seed and every other arm has already
// answered by the time the world moves. Ordering here, once, is what keeps the truths order-free.
const WORKFLOW = WORKFLOWS.filter((w) => workflowsRaw.includes(w));
const HAS_CHANGE = WORKFLOW.includes("change");
const SEEDS = parseInt(opt("seeds", "1"), 10);
const RENDER_BUDGET = parseInt(opt("budget", "500"), 10);
const TAIL_BUDGET = parseInt(opt("tail", "250"), 10);
const DRY = argv.includes("--dry");
const SETUP = !argv.includes("--no-setup");

// `forceload remove` caps at 256 chunks/command exactly like `add`, so a whole region rect
// (~300 chunks) removed in one command silently no-ops and leaks the forceload. Strip it the same
// way ensureGenerated adds it (32-block z-strips → ≤ width×2 chunks per command).
async function releaseRect([minX, minZ, maxX, maxZ]) {
  for (let z = minZ; z <= maxZ; z += 32) {
    await cmd(`forceload remove ${minX} ${z} ${maxX} ${Math.min(z + 31, maxZ)}`);
  }
}

// `capture` = full + the captured-observation query surface (OBSERVATION_MEMORY_DESIGN §6 arm).
// Its control is `full`: same corpus, same explore pass, capture simply invisible to an arm that
// cannot query it — so run `--arch full,capture` to get the paired comparison in one dir.
// `capture-forced` has the SAME tools as `capture` and a steered prompt. Both are reported, per the
// PATTERN_SEARCH precedent: capture-vs-capture-forced prices DISCOVERY (the free-choice arm ignored
// the surface entirely in the first smoke), capture-forced-vs-full prices the REPRESENTATION.
//
// CYCLE 2 (MEMORY_REDESIGN §8): the redesigned 8-tool surface, in two annotate ON/OFF pairs.
// `annotate` vs `annotate-off` prices the appendix against the same tools and the same prompt bytes
// (the arms differ in MCPTK_OBS_ANNOTATE and NOTHING else). `worldonly-ann` vs `worldonly` isolates
// the REPRESENTATION: neither has any authored-memory tool, so the appendix is the only way a prior
// can reach the agent at all, and `worldonly`'s score IS the guessing floor — measured, not assumed.
const ARCH_CONDITION = {
  full: "d", "no-recall": "c", capture: "e", "capture-forced": "f",
  annotate: "g", "annotate-off": "h", "worldonly-ann": "i", worldonly: "j",
  legal: "k",
};
for (const a of ARCH) if (!ARCH_CONDITION[a]) throw new Error(`unknown --arch "${a}" (${Object.keys(ARCH_CONDITION).join(" | ")})`);
// Capture must be on during EXPLORE — that is when observations happen — so it is a property of the
// RUN, not of one arm. Turning it on costs an arm that cannot query it nothing it can perceive.
// All four cycle-2 arms capture: h/j must prove the APPENDIX is the variable, not the corpus, so
// they build byte-identical observation stores and simply never have them pushed.
const CYCLE2 = new Set(["annotate", "annotate-off", "worldonly-ann", "worldonly"]);
// The legal arm (MEMORY_REDESIGN §12.5) also captures — its quiz-session raycasts/scans feed the
// store its own locate answers from; without capture the arm's locate is blind by construction.
const CAPTURE = ARCH.some((a) => a.startsWith("capture") || CYCLE2.has(a) || a === "legal");
// The appendix is per-ARM, not per-run: it is the one variable inside each pair. The legal arm is
// production-shaped (survival ships annotate on), and it is not anyone's off-pair.
const ANNOTATE_ARCHES = new Set(["annotate", "worldonly-ann", "legal"]);
const annotateFor = (arch) => (ANNOTATE_ARCHES.has(arch) ? "on" : "off");

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIM = join(HERE, "..", "ablation", "mcp-shim.mjs");
const RENDER_CLI = join(HERE, "..", "ablation", "render-cli.mjs");
const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const cfgModel = process.env.MCPTK_ABLATION_MODEL || (MODEL === "haiku" ? "claude-haiku-4-5-20251001" : MODEL);

const ping = await bridge("ping", {});
if (!ping.ok) { console.error(`no bridge — start the dev server (gradlew runServer) first (${ping.error})`); process.exit(1); }

/**
 * Session-open render for the memory dir passed in (child render-cli process, so it sees the shim's
 * writes). Condition c/d both get the full telescope render + compaction nags; a === false never
 * reaches here (this fixture always runs c/d).
 */
function openingRender(memDir) {
  const out = execFileSync(process.execPath, [RENDER_CLI], {
    env: { ...process.env, MCPTK_MEMORY_DIR: memDir, MCPTK_RENDER_BUDGET: String(RENDER_BUDGET) },
    encoding: "utf8",
  });
  const r = JSON.parse(out);
  if (!r.ok) return { render: null, nags: [] };
  const nags = [];
  const nag = formatCompactionNag(r.result.compactionDue);
  if (nag) nags.push(nag);
  return { render: r.result.render, nags };
}

/**
 * Run one fresh session against `memDir` under `conditionKey`, spawning the drone at `dronePos`.
 *
 * Retries ONCE on a no-tools instrument failure (session-guards `toolSurfaceFailure`). A session that
 * never received its tool surface made no tool calls, so it wrote nothing and a retry is side-effect
 * free — and the one occurrence so far was transient (the identical startup reconnected fine). If the
 * retry fails too, the typed result is returned rather than thrown, and the CALLER decides: an
 * explore session must abort the seed (a corpus built with no tools is empty and every arm quizzing
 * it would score a fiction), a quiz session records a censored row.
 */
// Forwards OPTS, not a hand-listed field set. It used to destructure and re-pass each field by name,
// which silently dropped anything the list did not mention — `annotate` was added to runOneSession
// and never arrived, so every cycle-2 session ran with the appendix OFF and the arm under test was
// byte-identical to its own control. Spreading is the fix; the assertion below is the guard.
async function runSession(opts) {
  for (let attempt = 1; ; attempt++) {
    const out = await runOneSession(opts);
    if (!out.instrument_failure || attempt >= 2) return out;
    console.log(`  [${opts.tag}] instrument failure (${out.instrument_failure}) — retrying once; nothing was written`);
  }
}

async function runOneSession({ conditionKey, memDir, dronePos, prompt, maxTurns, transcriptPath, sdkLogPath, tag, annotate }) {
  // NO DEFAULT. A default here is what turned a dropped argument into a silently disabled mechanism:
  // the run still completed, still scored, and reported the intervention as having no effect.
  // The one thing an arm's defining variable must never do is fall back to a value.
  if (annotate !== "on" && annotate !== "off") {
    throw new Error(
      `runOneSession(${tag}): annotate must be explicitly "on" or "off", got ${JSON.stringify(annotate)} — ` +
      `it is the ONE variable separating the cycle-2 arms, and defaulting it would make an arm ` +
      `byte-identical to its own control while still producing a number.`);
  }
  await bridge("bot_body", { action: "despawn" });
  const spawn = await bridge("bot_body", { action: "spawn",  pos: dronePos });
  if (!spawn.ok) throw new Error(`bot_body spawn failed: ${spawn.error}`);
  // The session-open render is PART OF THE CONDITION, not a property of the fixture. This used to be
  // unconditional with a comment saying openingRender:false "never reaches here (this fixture always
  // runs c/d)" — true until cycle 2 added arms i/j, which have NO memory tools and must have no
  // memory surface at ALL. Rendering their corpus into the opening message would have handed the
  // world-only arms the authored memory they exist to be measured without, and prediction 2 (i vs j)
  // would have been measuring nothing.
  const { render, nags } = CONDITIONS[conditionKey].openingRender
    ? openingRender(memDir)
    : { render: null, nags: [] };
  const out = await runEpisodeSdk({
    model: cfgModel,
    system: buildSystemPrompt(conditionKey),
    prompt: buildOpeningMessage(render, nags, prompt),
    maxTurns,
    shimPath: SHIM,
    shimEnv: {
      MCPTK_ABLATION_CONDITION: conditionKey,
      MCPTK_MEMORY_DIR: memDir,
      MCPTK_TAIL_BUDGET: String(TAIL_BUDGET),
      MCPTK_ABLATION_TRANSCRIPT: transcriptPath,
      // Opt-in per run; the shim defaults capture OFF so unflagged runs stay byte-identical.
      MCPTK_OBS_CAPTURE: CAPTURE ? "on" : "off",
      // The push channel (on-read appendix + session-open digest). Explicit on EVERY session, never
      // inherited: a leaked "on" from the environment would silently annotate a control arm.
      MCPTK_OBS_ANNOTATE: annotate,
    },
    allowedToolNames: [
      ...CONDITIONS[conditionKey].memTools,
      ...(CONDITIONS[conditionKey].worldTools ?? AGENT_WORLD_TOOLS),
    ],
    toolTranscriptPath: transcriptPath,
    sdkLogPath,
    log: (l) => console.log(`  [${tag}] ${l}`),
  });
  out.opening_render = render;
  return out;
}

// --- instantiate --------------------------------------------------------------------------------
// The lattice must stay nested (c ⊂ d ⊂ e ⊂ f) or an arm difference is not attributable to its one
// added layer. The cycle-2 pairs must be byte-IDENTICAL for the same reason, one axis over. Both
// asserted before any model spend, so a bad edit costs nothing.
assertPromptNesting();
assertPromptPairs();

// ONE explore pass builds the corpus every arm then quizzes, so its condition must be a property of
// the RUN. Cycle-2 runs explore under `g` (the redesigned surface) because c–f are non-runnable
// after the consolidation; that is the comparability boundary §8 names against the 0.9.7 corpus.
// Explore is annotated whenever the run is a cycle-2 run: the appendix is on in production, and one
// shared explore pass keeps every arm's corpus identical either way.
// The LEGAL arm explores under `g` too, and deliberately so (MEMORY_REDESIGN §12.5): the corpus is
// built with X-ray reads, so the legal quiz's provenance-filtered `locate` structurally CANNOT
// re-survey it. That asymmetry IS the instrument fix — memory becomes the only path to a correct
// answer — not a leak to patch. A legal-only run therefore shares the identical corpus every other
// cycle-2 arm quizzes, which is what keeps it comparable to `full`.
const CYCLE2_RUN = ARCH.some((a) => CYCLE2.has(a) || a === "legal");
const EXPLORE_CONDITION = CYCLE2_RUN ? "g" : "d";
const EXPLORE_ANNOTATE = CYCLE2_RUN ? "on" : "off";

const scenarios = Array.from({ length: SEEDS }, (_, i) => makeMemScenario(i + 1));
// Hashed over the questions the SELECTED workflows actually ask, deduped by id. A recall-only run
// yields exactly the six-question array it always did, so its hash — and every comparison keyed to
// it — is unchanged.
const questionsHash = sha(JSON.stringify(scenarios.map((s) => {
  const qs = new Map();
  for (const w of WORKFLOW) for (const q of s.questionsFor(w)) qs.set(q.id, { id: q.id, truth: q.truth });
  return { seed: s.seed, qs: [...qs.values()] };
})));
console.log(`Category C — ${SEEDS} seed(s), arch ${ARCH.join("+")}, workflow ${WORKFLOW.join("+")}, questions ${questionsHash}`);

if (DRY) {
  for (const s of scenarios) {
    if (SETUP) { console.log(`[setup] mem-depth seed ${s.seed} …`); await s.setup(); }
    console.log(`\n=== seed ${s.seed} ===`);
    for (const ep of s.exploreEpisodes) console.log(`\n[dry] --- ${ep.key} (maxTurns ${ep.maxTurns}) ---\n${ep.prompt}`);
    console.log(`\n[dry] --- mutate ---  chest ${s.params.oldItem}×${s.params.oldCount} → ${s.params.newItem}×${s.params.newCount}, moved to ${JSON.stringify(s.params.chestNew)}`);
    for (const w of WORKFLOW) {
      if (w === "change") {
        console.log(`\n[dry] --- mutate-facts (before the change quiz) ---`);
        for (const p of s.probes) console.log(`  ${p.label} @ ${JSON.stringify(p.pos)}  ${p.kind}: ${JSON.stringify(p.before)} → ${JSON.stringify(p.after)}`);
      }
      const ep = s.quizEpisodeFor(w);
      console.log(`\n[dry] --- quiz ${w} (maxTurns ${ep.maxTurns}) ---\n${ep.prompt}`);
      console.log(`\n[dry] truths (${w}): ${JSON.stringify(Object.fromEntries(s.questionsFor(w).map((q) => [q.id, q.truth])))}`);
    }
    for (const rect of s.forceloaded ?? []) await releaseRect(rect);
  }
  console.log("\n[dry] stage built + released; no model spend.");
  process.exit(0);
}

// --- run ----------------------------------------------------------------------------------------
const manifest = await fetchManifest();
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const resultsRoot = join(HERE, "..", "testbench-results");
const outDir = RESUME
  ? (/[\\/]/.test(RESUME) ? RESUME : join(resultsRoot, RESUME))
  : join(resultsRoot, `${stamp}-mem-${MODEL}`);
await mkdir(outDir, { recursive: true });
const answersPath = join(outDir, "answers.jsonl");
if (!RESUME) await writeFile(answersPath, "", "utf8");

const gradle = await readFile(join(HERE, "..", "..", "mcp-toolkit", "build.gradle"), "utf8").catch(() => "");
const toolsHash = sha(JSON.stringify(manifest.map((t) => [t.name, t.description])));
// The vocabulary axis (ROUTE_LEDGER_DESIGN.md §8). `tools_hash` fingerprints the manifest, which the
// route layer never touches — so without this a run whose routes differ pools silently with one
// whose routes do not. routes-pin.mjs both applies the pin and reports it, so the manifest cannot
// record a mode the run did not execute.
const routesHash = routesHashForRun();

const gitHead = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: HERE }).toString().trim();
const manifestPath = join(outDir, "manifest.json");
const manifestBody = {
  date: new Date().toISOString(), bench_version: BENCH_VERSION, category: "c", model: MODEL, arch: ARCH, workflow: WORKFLOW,
  arch_condition: ARCH_CONDITION, seeds: SEEDS, render_budget: RENDER_BUDGET, tail_budget: TAIL_BUDGET,
  ...(WORKFLOW.includes("change") ? { change_rung_version: CHANGE_RUNG_VERSION } : {}),
  explore_prompt_version: EXPLORE_PROMPT_VERSION,
  annotate_arms: Object.fromEntries(ARCH.map((a) => [a, annotateFor(a)])),
  explore_condition: EXPLORE_CONDITION,
  tools_hash: toolsHash, routes_hash: routesHash,
  toolkit_version: gradle.match(/version = '([^']+)'/)?.[1] ?? "unknown",
  git_head: gitHead,
  questions_hash: questionsHash, substrate: "claude-agent-sdk/max-subscription", model_id: cfgModel,
};

// FREEZE_PLAN B1 for Category C. A C cell is (seed, arm); the corpus is built ONCE per seed and
// shared by every arm, which is what makes the arms comparable — so resume must NOT rebuild it for a
// partially-done seed. Instead, a seed whose memory dir survives on disk reuses that corpus and only
// the missing arms are quizzed; a seed with every arm done is skipped whole (setup + 3 explore
// sessions + mutate, the expensive part). Explore transcripts are re-read from disk so the per-fact
// funnel's `observed` stage stays truthful across a resume instead of silently reading false.
const done = new Set();
const priorRows = [];
if (RESUME) {
  let prior;
  try { prior = JSON.parse(await readFile(manifestPath, "utf8")); }
  catch { console.error(`--resume ${outDir}: no readable manifest.json — refusing to resume`); process.exit(2); }
  const drift = resumeDrift(prior, manifestBody, ["arch", "workflow", "seeds", "render_budget", "tail_budget"]);
  if (drift.length) {
    console.error(`--resume ${outDir}: the run has DRIFTED from the dir being resumed — resuming would pool incomparable rows:\n  ${drift.join("\n  ")}\nStart a fresh run instead.`);
    process.exit(2);
  }
  priorRows.push(...parseRows(await readFile(answersPath, "utf8").catch(() => "")));
  for (const c of completedCells(priorRows, (r) => `${r.seed}|${r.arm ?? r.arch}`)) done.add(c);
  // The change rung mutates the world irreversibly for a seed. Once a seed has answered a change
  // arm, its probe platforms no longer hold the state the recall/revisit truths describe, so a
  // resumed recall arm on that seed would be graded against a world that has moved. Refuse — the
  // remedy is a fresh run of that seed, not a row scored against stale truth.
  const changedSeeds = new Set(priorRows.filter((r) => r.workflow === "change" && !r.error).map((r) => r.seed));
  const stranded = [...changedSeeds].filter((seed) =>
    WORKFLOW.some((w) => w !== "change") &&
    ARCH.some((a) => WORKFLOW.some((w) => w !== "change" && !done.has(`${seed}|${w === "recall" ? a : `${a}+${w}`}`))));
  if (stranded.length) {
    console.error(
      `--resume ${outDir}: seed(s) ${stranded.join(", ")} already ran a \`change\` arm, which mutated their probe ` +
      `platforms — the recall/revisit truths describe the world BEFORE that mutation, so the missing arms cannot ` +
      `be resumed here. Run those arms in a fresh dir.`);
    process.exit(2);
  }
  prior.resumes = [...(prior.resumes ?? []), { date: manifestBody.date, git_head: gitHead, resumed_cells: done.size }];
  await writeFile(manifestPath, JSON.stringify(prior, null, 2), "utf8");
  console.log(`[resume] ${outDir}\n[resume] ${done.size} cell(s) already complete`);
} else {
  await writeFile(manifestPath, JSON.stringify(manifestBody, null, 2), "utf8");
}

/** Every (arm) cell this invocation would run for a seed. */
const cellsFor = (seed) => ARCH.flatMap((a) => WORKFLOW.map((w) => `${seed}|${w === "recall" ? a : `${a}+${w}`}`));

const rows = [...priorRows];
for (const s of scenarios) {
  const seedDir = join(outDir, `seed${s.seed}`);
  // A seed with every arm already answered costs nothing to skip — this is the expensive branch
  // (setup + 3 explore sessions + mutate), so it is where resume actually pays.
  if (cellsFor(s.seed).every((c) => done.has(c))) { console.log(`\n[resume] seed ${s.seed}: all arms complete, skipping`); continue; }
  await mkdir(seedDir, { recursive: true });

  const memDir = join(seedDir, "memory");
  // Reuse a surviving corpus rather than rebuilding it. The arms are only comparable because they
  // share ONE frozen corpus, so rebuilding for a half-done seed would pool arms across two different
  // corpora — the same class of hazard the manifest drift check exists to prevent.
  const corpusExists = RESUME && corpusOnDisk(memDir);
  if (SETUP && !corpusExists) { console.log(`\n[setup] mem-depth seed ${s.seed} …`); await s.setup(); }

  // -- explore: build the corpus under the full toolset, shared memory dir ------------------------
  const exploreTranscripts = [];
  const exploreTok = zeroTok(); // the corpus-building cost — dominated by perception cache reads
  if (corpusExists) {
    // Re-read the persisted explore transcripts so the funnel's `observed` stage stays truthful; an
    // empty transcript would report observed:false for every fact and misattribute the failure.
    for (const ep of s.exploreEpisodes) {
      exploreTranscripts.push(...parseRows(await readFile(join(seedDir, `transcript-${ep.key}.jsonl`), "utf8").catch(() => "")));
    }
    console.log(`\n[resume] seed ${s.seed}: reusing the on-disk corpus (${exploreTranscripts.length} explore transcript rows); explore + mutate skipped`);
  } else {
  for (const ep of s.exploreEpisodes) {
    console.log(`\n[seed ${s.seed}] explore ${ep.key} (build corpus)`);
    const out = await runSession({
      conditionKey: EXPLORE_CONDITION, memDir, dronePos: ep.dronePos, prompt: ep.prompt, maxTurns: ep.maxTurns,
      transcriptPath: join(seedDir, `transcript-${ep.key}.jsonl`), sdkLogPath: join(seedDir, `sdk-${ep.key}.jsonl`),
      tag: ep.key, annotate: EXPLORE_ANNOTATE,
    });
    // A corpus built by a session that never received its tool surface is EMPTY, and every arm
    // quizzing it would score a fiction at full model cost. runSession already retried once; a
    // second failure is a broken instrument, not a result.
    if (out.instrument_failure) {
      throw new Error(
        `seed ${s.seed} explore ${ep.key}: ${out.instrument_failure} (twice). The corpus would be empty and ` +
        `every arm would quiz nothing — refusing to continue. Check the MCP shim starts (node ${SHIM}), ` +
        `then re-run with --resume ${outDir}.`);
    }
    exploreTranscripts.push(...out.transcript);
    accTok(exploreTok, out.usage);
    console.log(`  ${ep.key} done (${out.subtype}): ${out.turns}t, ${out.usage.input_tokens}in/${out.usage.output_tokens}out, tools ${JSON.stringify(toolCounts(out.transcript).byName)}`);
  }
  }

  // -- freeze + mutate ----------------------------------------------------------------------------
  // On a resumed seed the chest was already moved by the original run and the corpus is frozen
  // against that state; re-mutating is idempotent (setblock air / setblock chest / item replace) but
  // skipping it keeps the resumed leg from touching the world at all.
  await bridge("bot_body", { action: "despawn" });
  if (!corpusExists) {
    console.log(`[seed ${s.seed}] mutate depot chest`);
    await s.mutate();
  }

  // -- quiz: one arm per (workflow, arch), each over an identical frozen clone of the corpus -------
  // WORKFLOW is ordered so `change` runs last: it mutates the probe platforms, and the recall/revisit
  // truths describe the world BEFORE that mutation. Looping workflow-outer is what makes that
  // ordering binding — an arch-outer loop would interleave a change arm ahead of a revisit arm.
  let factsMutated = false;
  for (const workflow of WORKFLOW) for (const arch of ARCH) {
    const conditionKey = ARCH_CONDITION[arch];
    // Arm label: plain arch for the default workflow (old dirs and old rows keep their identity),
    // arch+workflow once a second workflow is in play.
    const arm = workflow === "recall" ? arch : `${arch}+${workflow}`;
    if (done.has(`${s.seed}|${arm}`)) { console.log(`\n[resume] seed ${s.seed} arm ${arm}: already complete, skipping`); continue; }
    // The change rung's world mutation — once per seed, after every non-change arm has answered.
    if (workflow === "change" && !factsMutated) {
      console.log(`[seed ${s.seed}] mutate probe platforms (change rung)`);
      await s.mutateFacts();
      factsMutated = true;
    }
    const ep = s.quizEpisodeFor(workflow);
    const armDir = join(seedDir, `quiz-${arm}`);
    await cloneMemoryDir(seedDir, armDir); // clones seedDir/memory → armDir/memory
    const armMem = join(armDir, "memory");
    console.log(`\n[seed ${s.seed}] quiz arch=${arch} workflow=${workflow} (condition ${conditionKey})`);
    const q = await runSession({
      conditionKey, memDir: armMem, dronePos: ep.dronePos, prompt: ep.prompt,
      maxTurns: ep.maxTurns, transcriptPath: join(seedDir, `transcript-quiz-${arm}.jsonl`),
      sdkLogPath: join(seedDir, `sdk-quiz-${arm}.jsonl`), tag: `quiz-${arm}`,
      annotate: annotateFor(arch),
    });
    const scored = s.scoreFor(workflow)(q.finalText, q.transcript);
    const qOfFact = s.questionOfFact(workflow);

    // Demotion guarantee: were the quizzed facts actually OUT of the render (the whole point)?
    const funnels = [];
    for (const f of s.facts) {
      // Join through the scenario's fact→question map for THIS workflow; null (not false) whenever
      // no question is 1:1 with the fact, so "not asked" never reads as "retrieved and then misused".
      // The map is workflow-specific — the change rung's ids are probe ids, a different key space
      // again, and indexing per_question with the recall ids would make the column constant-false.
      const qid = qOfFact[f.key] ?? null;
      funnels.push(await factFunnel({
        fact: f, memoryRoot: armMem, openingRender: q.opening_render,
        e1Transcript: exploreTranscripts, e2Transcript: q.transcript,
        usedCorrectly: qid && scored.per_question[qid] ? !!scored.per_question[qid].exact : null,
      }));
    }
    const guarantees = {
      blocks_total: funnels[0]?.blocks_total ?? 0,
      multi_block: (funnels[0]?.blocks_total ?? 0) >= 2,
      demoted_facts_out_of_render: funnels.filter((f) => !f.in_render).length,
      tracked_facts: funnels.length,
    };

    const nQuestions = s.questionsFor(workflow).length;
    const rec = {
      seed: s.seed, arch, workflow, arm, condition: conditionKey, model: MODEL,
      correct: scored.correct, confident_wrong: scored.confident_wrong, abstained: scored.abstained,
      total_questions: nQuestions, by_tier: scored.by_tier,
      per_question: scored.per_question, staleness: scored.staleness,
      retrieval_calls: scored.retrieval_calls, flags: scored.flags,
      // §8 prediction 1's headline number. The row is assembled by explicit field PICKING, not by
      // spreading `scored` — so a metric the scorer computes but nobody lists here is silently
      // dropped, and the report reads the absence as a measured zero ("the appendix never fired")
      // rather than as an instrument gap. That is the difference between reporting a build defect
      // and having one.
      remembered_served: scored.remembered_served ?? null,
      ...(scored.change_detail ? { change_detail: scored.change_detail, probe_scores: scored.probe_scores } : {}),
      guarantees, funnels,
      // `stop_reason` is lifted to the TOP of the row as well as nested under `quiz`: bench-report's
      // censoring reads the row it is handed, and for C that is a per-question subrow expanded from
      // here. A censored quiz (stall, runaway, or a no-tools instrument failure) is still recorded in
      // full — the answer it gave is evidence about the failure — but it is never scored.
      stop_reason: q.stop_reason, censored: q.censored,
      ...(q.instrument_failure ? { instrument_failure: q.instrument_failure } : {}),
      quiz: { turns: q.turns, subtype: q.subtype, capped: q.capped, stop_reason: q.stop_reason, usage: q.usage, tool_counts: toolCounts(q.transcript) },
      explore_tokens: { ...exploreTok }, // shared corpus-build cost (same for both arms of this seed)
      answer: scored.answer, truth: scored.truth,
    };
    rows.push(rec);
    await appendFile(answersPath, JSON.stringify(rec) + "\n", "utf8");
    const censorNote = q.censored ? `  ⚠ CENSORED (${q.stop_reason}) — recorded, NOT scored` : "";
    console.log(`  quiz-${arm}: ${scored.correct}/${nQuestions} correct, ${scored.confident_wrong} conf-wrong, ${scored.abstained} abstain; ` +
      `recall/read/obs ${scored.retrieval_calls.mem_recall}/${scored.retrieval_calls.mem_read}/${scored.retrieval_calls.obs_tools ?? 0}; ` +
      `blocks ${guarantees.blocks_total}, ${guarantees.demoted_facts_out_of_render}/${guarantees.tracked_facts} facts out-of-render${censorNote}`);
    // The push channel, reported PER ARM as it happens. The first cycle-2 smoke ran to completion
    // with the appendix disabled in every arm and nothing in the log said so — it took a transcript
    // recount afterwards to notice. An arm whose defining variable is "on" and which served zero
    // annotations is either a plumbing break or a genuine null, and the difference must be visible
    // while the run is still cheap to stop.
    if (CYCLE2.has(arch) || arch === "legal") {
      const rs = scored.remembered_served ?? { total: 0, delta: 0 };
      const want = annotateFor(arch) === "on";
      console.log(`    annotate=${annotateFor(arch)}: ${rs.total} appendix(es) served (${rs.delta} delta)` +
        (want && rs.total === 0 ? "  ⚠ ZERO on an annotate-ON arm — check MCPTK_OBS_ANNOTATE reached the shim" : "") +
        (!want && rs.total > 0 ? "  ⚠ NON-ZERO on an annotate-OFF arm — the pair is not an on/off pair" : ""));
    }
    // The legal arm's own plumbing check: X-ray must be UNREACHABLE at the tool level (§12.5's
    // "no prompt can bind a tool capability"). A single X-ray call means the surface leaked and the
    // arm measured nothing — loud while the run is still cheap to stop.
    if (arch === "legal") {
      const counts = toolCounts(q.transcript);
      const leaked = ["scene_summary", "get_entities", "get_surface", "get_blocks_at", "describe_box",
        "run_command", "raycast_fan"].filter((t) => (counts[t] ?? 0) > 0);
      console.log(`    legal surface: ${counts.bot_scan ?? 0} scan(s), ${counts.locate ?? 0} locate(s), ` +
        `${counts.raycast ?? 0} raycast(s)` +
        (leaked.length ? `  ⚠ X-RAY LEAKED: ${leaked.join(", ")} — the arm is not legal, do not score it` : ""));
    }
  }

  for (const rect of s.forceloaded ?? []) await releaseRect(rect);
}

// --- summary ------------------------------------------------------------------------------------
const fmt = (x, d = 0) => (Number.isFinite(x) ? x.toFixed(d) : "-");
const quizAcc = (r) => tokFields(r.quiz?.usage ?? {}); // {i,o,cr,cw} for the quiz session
const lines = [`# Category C (memory) — ${stamp}, model ${MODEL}`, "",
  `${SEEDS} seed(s) × arch [${ARCH.join(", ")}] × workflow [${WORKFLOW.join(", ")}], questions ${questionsHash}`, "",
  `| seed | arm | correct | conf-wrong | abstain | recall/read/obs | blocks | out-of-render | stale-assume | quiz tok nc/wc |`,
  `|---|---|---|---|---|---|---|---|---|---|`];
for (const r of rows) {
  // A censored row's score is not a measurement — say so in the cell rather than printing a number
  // that reads like one.
  const score = r.censored ? `CENSORED (${r.stop_reason})` : `${r.correct}/${r.total_questions}`;
  lines.push(`| ${r.seed} | ${r.arm ?? r.arch} | ${score} | ${r.confident_wrong} | ${r.abstained} | ` +
    `${r.retrieval_calls.mem_recall}/${r.retrieval_calls.mem_read}/${r.retrieval_calls.obs_tools ?? 0} | ${r.guarantees.blocks_total} | ` +
    `${r.guarantees.demoted_facts_out_of_render}/${r.guarantees.tracked_facts} | ${r.staleness.stale_assumption ? "1" : "0"} | ${bothTok(quizAcc(r))} |`);
}
// The corpus-build cost is the bulk of Category C and is shared by both arms — report it once per seed.
lines.push("", "## Corpus-build (explore) cost — tokens no-cache/with-cache (perception cache reads dominate)");
for (let seed = 1; seed <= SEEDS; seed++) {
  const r = rows.find((x) => x.seed === seed && x.explore_tokens);
  if (r) lines.push(`- seed ${seed} explore (3 sessions): ${bothTok(r.explore_tokens)}`);
}
lines.push("", "## By difficulty tier (correct / n, pooled across seeds & arms)");
const tiers = {};
for (const r of rows) for (const [t, v] of Object.entries(r.by_tier)) { tiers[t] ??= { n: 0, c: 0 }; tiers[t].n += v.n; tiers[t].c += v.correct; }
for (const [t, v] of Object.entries(tiers)) lines.push(`- **${t}**: ${v.c}/${v.n} (${fmt((v.c / v.n) * 100)}%)`);
if (ARCH.length > 1) {
  // Every non-`full` arch is paired against `full` WITHIN a workflow. Pairing on arch alone silently
  // matched the first row of that arch across workflows once a second workflow existed — comparing a
  // recall arm to a revisit arm and calling the difference architecture.
  lines.push("", "## Architecture paired comparison (same frozen corpus, within workflow)");
  for (const workflow of WORKFLOW) {
    for (const arch of ARCH.filter((a) => a !== "full")) {
      for (let seed = 1; seed <= SEEDS; seed++) {
        const at = (a) => rows.find((r) => r.seed === seed && r.arch === a && (r.workflow ?? "recall") === workflow);
        const base = at("full"), other = at(arch);
        if (!base || !other || base.censored || other.censored) continue;
        lines.push(`- [${workflow}] seed ${seed}: full ${base.correct}/${base.total_questions} @ ${bothTok(quizAcc(base))} ` +
          `(recall×${base.retrieval_calls.mem_recall}, obs×${base.retrieval_calls.obs_tools ?? 0}) vs ` +
          `${arch} ${other.correct}/${other.total_questions} @ ${bothTok(quizAcc(other))} ` +
          `(recall×${other.retrieval_calls.mem_recall}, obs×${other.retrieval_calls.obs_tools ?? 0}) — ` +
          `acc Δ ${other.correct - base.correct}, quiz tok Δ nc ${ktok(noCache(quizAcc(other)) - noCache(quizAcc(base)))} / ` +
          `wc ${ktok(withCache(quizAcc(other)) - withCache(quizAcc(base)))}`);
      }
    }
  }
}
if (HAS_CHANGE) {
  // The change rung split three ways, because the three carry different evidence: `now` is a live
  // read both arms can do (a floor here indicts the episode, not memory), `was` needs a recorded
  // prior and is the actual measurement, and the flag is only meaningful when the prior is.
  lines.push("", "## Change rung — per probe (flag / prior / live-read)",
    `| seed | arm | probe | kind | flag | was | now | obs calls |`, `|---|---|---|---|---|---|---|---|`);
  const mark = (b) => (b ? "✓" : "·");
  for (const r of rows.filter((x) => x.workflow === "change" && x.change_detail)) {
    for (const [label, d] of Object.entries(r.change_detail)) {
      lines.push(`| ${r.seed} | ${r.arm} | ${label} | ${d.kind} | ${mark(d.flag_ok)} | ${mark(d.was_ok)} | ${mark(d.now_ok)} | ` +
        `${r.retrieval_calls.obs_tools ?? 0} |`);
    }
  }
  lines.push("", `_A probe scores correct only when the flag AND the prior are right: a correct verdict from a ` +
    `wrong prior is a coin flip, not change detection. \`chg_same\` is the false-positive guard — without it, ` +
    `"everything changed" scores 3/4._`);
}
if (CAPTURE) {
  const capRows = rows.filter((r) => r.arch?.startsWith("capture") && !r.censored);
  const used = capRows.filter((r) => (r.retrieval_calls.obs_tools ?? 0) > 0).length;
  lines.push("", "## Captured-surface uptake (free-choice vs forced)",
    `- ${used}/${capRows.length} capture arm(s) called an obs tool at least once.`,
    ...ARCH.filter((a) => a.startsWith("capture")).map((a) => {
      const rs = capRows.filter((r) => r.arch === a);
      const n = rs.reduce((t, r) => t + (r.retrieval_calls.obs_tools ?? 0), 0);
      return `- **${a}** (condition ${ARCH_CONDITION[a]}): ${n} obs-tool call(s) across ${rs.length} arm(s)`;
    }),
    `- Zero uptake on \`capture\` is a RESULT, not a bug: it prices discovery, which is what the`,
    `  \`capture-forced\` arm exists to separate from the representation.`);
}
const summary = lines.join("\n") + "\n";
await writeFile(join(outDir, "summary.md"), summary, "utf8");
console.log(`\n${summary}\nresults → ${outDir}`);
