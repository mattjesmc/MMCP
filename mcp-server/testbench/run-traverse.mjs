#!/usr/bin/env node
// Category E, slice E-traverse orchestrator — in-body obstacle course (BENCH_EXPANSION.md).
//
//   node testbench/run-traverse.mjs [--model haiku] [--seeds 2] [--tiers 5] [--arms predict,blind] [--dry]
//
// Mirrors run-combat.mjs, but each (seed, course-tier) is INDEPENDENT (no wave ladder / death-stop):
// per seed × tier, stage the roofed corridor once, then for each arm spawn a fresh body at START, run
// ONE player session to navigate to GOAL, let the final goto settle, and score from server truth.
// Ablation subject is check_path (predict arm has it, blind arm does not) — the Category-T LOO
// question asked of a MOVING body. Output matches A/B/C/T/P/E-combat:
// testbench-results/<stamp>-traverse-<model>/ (manifest + answers.jsonl + summary.md); full SDK + tool
// transcripts saved per session for token analysis.

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
import { makeTraverseCourse, COURSES, TRAVERSE_TOOLS } from "./traverse-scenario.mjs";
import { bothTok, zeroTok, accTok } from "./tokens.mjs";

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
const MODEL = opt("model", "haiku");
const SEEDS = parseInt(opt("seeds", "2"), 10);
const TIERS = Math.min(parseInt(opt("tiers", String(COURSES.length)), 10), COURSES.length);
const ARMS = opt("arms", "predict,blind").split(",");
// 0.9.2: which body traverses — "flyer" (default, byte-identical to 0.9.1 runs) or "walker" (the
// grounded body; taller tube, own course cells; the §10.4 measurement the flyer could not give).
const BODY = opt("body", "flyer");
if (BODY !== "flyer" && BODY !== "walker") { console.error(`--body must be flyer|walker`); process.exit(1); }
const DRY = argv.includes("--dry");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIM = join(HERE, "..", "ablation", "mcp-shim.mjs");
const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const cfgModel = process.env.MCPTK_ABLATION_MODEL || (MODEL === "haiku" ? "claude-haiku-4-5-20251001" : MODEL);

// Player charter — same "a body with honest senses, not an omniscient copilot" framing as
// run-play/run-combat. The ONLY per-arm difference is the check_path clause (fair ablation: one tool,
// not prompt IQ). Traverse is terrain, not entities, so there is no legal-vs-xray perception split.
const CHARTER_CORE = `You are an autonomous Minecraft PLAYER controlling your own body — a drone \
actuator that moves through the world. You are NOT an omniscient copilot; you perceive and act only \
through your tools.

- Movement is server-run: bot_goto pathfinds and moves your body toward a target and reports how it \
ended (outcome arrived / already_there / stopped_short, with distance_to_target). bot_run executes a \
sequence of waypoint steps. Read bot_status for your current position and health.
- Be decisive. If a move stops short of an obstacle, diagnose where you are and continue — do not \
give up after one call.`;
const PERCEPTION = {
  predict: `\n- You have check_path: give it your current position and a target and it reports whether \
a body can reach it (and where a path stops). Use it to plan or diagnose a route before moving.`,
  blind: `\n- You do NOT have a path oracle. Infer traversability from what bot_goto reports and what \
bot_status/get_surface show, and adapt.`,
  goal: `\n- You do NOT call bot_goto directly. Instead you have bot_target: state the GOAL \
({action:"move", target:{at:{x,y,z}}}) and the server navigates AND repairs its own obstacles — it \
re-paths, opens doors, and reports what it did in a ledger. One call should usually suffice; read \
bot_status only if it reports it stopped.`,
};
const CHARTER_GOAL = `You are an autonomous Minecraft PLAYER controlling your own body. You perceive \
and act only through your tools.

- bot_target moves your body toward a goal and handles obstacles server-side, returning an outcome \
(achieved / stopped) and a ledger of what it did. Read bot_status for position/health.
- Be decisive: issue the goal, and only intervene if bot_target reports it stopped.`;
const charter = (arm) =>
  arm === "goal" ? CHARTER_GOAL
  : CHARTER_CORE + (arm === "blind" ? PERCEPTION.blind : PERCEPTION.predict);

const ping = await bridge("ping", {});
if (!ping.ok) { console.error(`no bridge — start the 0.14.0 dev server first (${ping.error})`); process.exit(1); }

// F7 (bench 0.9.3): server load, sampled around every episode — a slow row must be attributable
// to the server, not the agent. Null when `tick query`/parse fails (disclosed, never faked).
async function mspt() {
  try {
    const r = await bridge("run_command", { command: "tick query" });
    const m = /([\d.]+)\s*ms/i.exec((r.result?.output ?? []).join(" "));
    return m ? parseFloat(m[1]) : null;
  } catch { return null; }
}

// Validate the traverse tool surfaces against the running manifest (a hidden-but-misnamed tool would
// silently make an arm not the arm we think — the E-combat lesson).
const manifest = await fetchManifest();
const known = new Set(manifest.map((t) => t.name));
for (const arm of ARMS) {
  const set = TRAVERSE_TOOLS[arm] ?? TRAVERSE_TOOLS.predict;
  for (const n of set) if (!known.has(n)) throw new Error(`arm ${arm} names unknown tool "${n}" — is the server ≥0.15.0?`);
}

// One instance per (seed, tier).
const instances = [];
for (let seed = 1; seed <= SEEDS; seed++) for (let tier = 0; tier < TIERS; tier++) instances.push(makeTraverseCourse({ seed, tier, body: BODY }));
const questionsHash = sha(JSON.stringify(instances.map((s) => ({ name: s.name, seed: s.seed, tier: s.tier, body: BODY, arms: ARMS }))));
console.log(`Category E (e-traverse) — ${SEEDS} seeds × ${TIERS} courses × body ${BODY} × arms [${ARMS.join(",")}], questions ${questionsHash}`);

/** Spawn a fresh body at START, run one navigation session for `arm`, settle, and score. */
async function runArm(s, arm, outDir) {
  await bridge("bot_body", { action: "despawn" });
  const spawn = await bridge("bot_body", { action: "spawn", type: BODY, pos: s.dronePos });
  if (!spawn.ok) throw new Error(`bot_body spawn failed: ${spawn.error}`);
  await wait(500); // let the body settle at START before the session reads its position
  const tag = `${s.name}-s${s.seed}-t${s.tier + 1}-${arm}`;
  const tools = s.toolsFor(arm);
  const transcriptPath = join(outDir, `transcript-${tag}.jsonl`);
  const msptBefore = await mspt();
  const out = await runEpisodeSdk({
    model: cfgModel, system: charter(arm), prompt: s.prompt(arm), maxTurns: s.maxTurns,
    shimPath: SHIM,
    shimEnv: {
      MCPTK_ABLATION_CONDITION: "a",            // no memory tools / no opening render
      MCPTK_MEMORY_DIR: join(outDir, "nomem"),  // unused (condition a), but the shim expects it set
      MCPTK_WORLD_TOOLS: tools.join(","),        // the traverse (predict or blind) surface
      MCPTK_ABLATION_TRANSCRIPT: transcriptPath,
    },
    allowedToolNames: tools,
    toolTranscriptPath: transcriptPath,
    sdkLogPath: join(outDir, `sdk-${tag}.jsonl`),
    log: (l) => console.log(`  [${tag}] ${l}`),
  });
  if (s.observeWindowMs) await wait(s.observeWindowMs);
  const msptAfter = await mspt();
  const scored = await s.score(arm);
  // F2 (bench 0.9.3): the agent's ARRIVED claim scored beside server truth — the flyer §12.1
  // "mismatch" was an agent declaring arrival 2.8 blocks short; that is an honesty signal about
  // the AGENT and must not smear predict-vs-execute (a solver-validity number).
  scored.metrics.claimed = /\bARRIVED\b/i.test(out.finalText ?? "") ? "arrived" : "none";
  scored.metrics.claim_matches = scored.metrics.claimed === "arrived" ? scored.metrics.arrived === true : null;
  scored.metrics.mspt_before = msptBefore;
  scored.metrics.mspt_after = msptAfter;
  console.log(`  [${tag}] ${JSON.stringify(scored.metrics)} — ${out.turns}t`);
  await bridge("bot_body", { action: "despawn" });
  return { out, scored, tag };
}

if (DRY) {
  // --dry still stages the LIVE course (spawns a body, builds the tube + obstacles) and scores truth
  // only — no model spend. The point is to VERIFY grounding (body_y ~ AY+1, not the ~16-block hover)
  // and the check_path reachable invariant BEFORE spending a model. Do not run while the dev server
  // is busy.
  for (const s of instances) {
    console.log(`\n=== ${s.name} seed ${s.seed} tier ${s.tier + 1} (${s.course_name}) ===`);
    await s.setup();
    const arm = ARMS[0];
    await bridge("bot_body", { action: "despawn" });
    await bridge("bot_body", { action: "spawn", type: BODY, pos: s.dronePos });
    await wait(800);
    const scored = await s.score(arm);
    console.log(`  tools[${arm}]: ${s.toolsFor(arm).join(", ")}`);
    console.log(`  start→goal: ${JSON.stringify(s.dronePos)} → ${JSON.stringify(s.goal)}`);
    console.log(`  truth: ${JSON.stringify(scored.truth)}`);
    console.log(`  metrics (no model — body_y shows if grounding held): ${JSON.stringify(scored.metrics)}`);
    await bridge("bot_body", { action: "despawn" });
    await s.cleanup();
  }
  console.log("\n[dry] staged + scored truth. Check body_y ≈ floor_y+1 (grounded) and predict_reachable:true; " +
    "if body_y is ~16 above floor, the roof did not cap the flyer — tune grounding before spending a model.");
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = join(HERE, "..", "testbench-results",
  `${stamp}-traverse-${MODEL}${BODY === "flyer" ? "" : `-${BODY}`}`);
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
  date: new Date().toISOString(), bench_version: BENCH_VERSION, category: "e", slice: "e-traverse", model: MODEL, model_id: cfgModel,
  body: BODY, seeds: SEEDS, tiers: TIERS, arms: ARMS, courses: COURSES.slice(0, TIERS).map((c) => c.name),
  tools_hash: toolsHash, routes_hash: routesHash, git_head: execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: HERE }).toString().trim(),
  questions_hash: questionsHash, toolsets: { predict: TRAVERSE_TOOLS.predict, blind: TRAVERSE_TOOLS.blind },
  substrate: "claude-agent-sdk/max-subscription",
}, null, 2), "utf8");

const rows = [];
for (const s of instances) {
  console.log(`\n[${s.name} s${s.seed} t${s.tier + 1}] setup (${s.course_name})`);
  await s.setup();
  for (const arm of ARMS) {
    try {
      const { out, scored, tag } = await runArm(s, arm, outDir);
      const rec = {
        scenario: s.name, seed: s.seed, tier: s.tier + 1, course: s.course_name, arm, model: MODEL,
        ...scored.metrics, truth: scored.truth,
        turns: out.turns, subtype: out.subtype, capped: out.capped,
        tool_counts: toolCounts(out.transcript),
        tokens_in: out.usage.input_tokens, tokens_out: out.usage.output_tokens,
        cache_read: out.usage.cache_read_input_tokens, cache_write: out.usage.cache_creation_input_tokens,
      };
      rows.push(rec);
      await appendFile(answersPath, JSON.stringify(rec) + "\n", "utf8");
    } catch (e) {
      const rec = { scenario: s.name, seed: s.seed, tier: s.tier + 1, arm, error: String(e) };
      rows.push(rec);
      await appendFile(answersPath, JSON.stringify(rec) + "\n", "utf8");
      console.log(`  [${s.name}-s${s.seed}-t${s.tier + 1}-${arm}] ERROR ${e}`);
    }
  }
  await s.cleanup();
}

// --- summary ------------------------------------------------------------------------------------
const lines = [`# Category E — e-traverse (in-body obstacle course) — ${stamp}, model ${MODEL}`, "",
  `${SEEDS} seeds × ${TIERS} courses × arms [${ARMS.join(",")}], questions ${questionsHash}`,
  `Ladder: ${COURSES.slice(0, TIERS).map((c, i) => `t${i + 1} ${c.name}`).join(" → ")}`, ""];

const good = rows.filter((r) => !r.error);
if (good.length) {
  lines.push("## Per course × arm (skill + cost + predict-vs-execute)");
  lines.push(`| seed | tier | course | arm | arrived | claimed | dist | health_lost | body_y | predict | matched | turns | mspt b/a | tok nc/wc |`,
             `|---|---|---|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const r of good) lines.push(
    `| ${r.seed} | ${r.tier} | ${r.course} | ${r.arm} | ${r.arrived} | ${r.claimed ?? "-"} | ${r.final_dist} | ${r.health_lost} | ` +
    `${r.body_y} | ${r.predict_reachable} | ${r.predict_matched} | ${r.turns} | ` +
    `${r.mspt_before ?? "?"}/${r.mspt_after ?? "?"} | ${bothTok(accTok(zeroTok(), r))} |`);

  lines.push("", "## Per-arm totals (is check_path a win for a moving body?)");
  lines.push(`| arm | courses | arrived | mean dist | total turns | total tok nc/wc |`,
             `|---|---|---|---|---|---|`);
  for (const arm of ARMS) {
    const ar = good.filter((r) => r.arm === arm);
    if (!ar.length) continue;
    const acc = ar.reduce((a, r) => accTok(a, r), zeroTok());
    const arrived = ar.filter((r) => r.arrived).length;
    const meanDist = r1Mean(ar.map((r) => (Number.isFinite(r.final_dist) ? r.final_dist : 0)));
    const totalTurns = ar.reduce((s, r) => s + (r.turns ?? 0), 0);
    lines.push(`| ${arm} | ${ar.length} | ${arrived} | ${meanDist} | ${totalTurns} | ${bothTok(acc)} |`);
  }

  // Predict-vs-execute validity — the signal Category T cannot produce.
  const withPredict = good.filter((r) => r.predict_reachable != null);
  const matched = withPredict.filter((r) => r.predict_matched).length;
  lines.push("", "## Predict-vs-execute (check_path verdict vs real arrival)",
    `check_path had a verdict on ${withPredict.length} sessions; it matched the body's actual outcome ` +
    `on ${matched}/${withPredict.length}. Mismatches are the finding: a course the predicate called ` +
    `reachable that no body could follow (or vice versa).`);
  const mism = withPredict.filter((r) => !r.predict_matched);
  if (mism.length) for (const r of mism) lines.push(
    `- MISMATCH: seed ${r.seed} ${r.course} (${r.arm}) — predict_reachable=${r.predict_reachable}, arrived=${r.arrived}, dist=${r.final_dist}`);
}
const errs = rows.filter((r) => r.error);
if (errs.length) { lines.push("", "## Errors"); for (const r of errs) lines.push(`- ${r.scenario} s${r.seed} t${r.tier} ${r.arm}: ${r.error}`); }
const summary = lines.join("\n") + "\n";
await writeFile(join(outDir, "summary.md"), summary, "utf8");
console.log(`\n${summary}\nresults → ${outDir}`);

function r1Mean(xs) { return xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null; }
