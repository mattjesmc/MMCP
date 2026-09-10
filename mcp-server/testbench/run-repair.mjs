#!/usr/bin/env node
// Category E, slice E-repair orchestrator — the failure-path ladder (FREEZE_PLAN F1).
//
//   node testbench/run-repair.mjs [--model haiku] [--seeds 1] [--rungs plug_break,door_shut]
//                                 [--arms goal,hand] [--dry]
//
// Mirrors run-traverse.mjs. Each (seed, rung) stages a corridor whose cheapest route REQUIRES
// work; the goal arm repairs server-side (bot_target + rights), the hand arm repairs by hand
// (check_path + bot_goto + bot_mine/bot_place) — the remedial-turn A/B the goal loop exists for.
// New instrument columns (F2/F7, also added to run-traverse): `claimed` (the agent's final
// ARRIVED/BLOCKED claim vs server truth) and `mspt_before`/`mspt_after` (server load — a slow row
// must be attributable to the server, not the agent).

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
import { makeRepairRung, RUNGS, REPAIR_TOOLS } from "./repair-scenario.mjs";
import { bothTok, zeroTok, accTok } from "./tokens.mjs";

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
const MODEL = opt("model", "haiku");
const SEEDS = parseInt(opt("seeds", "1"), 10);
const RUNG_KEYS = opt("rungs", RUNGS.map((r) => r.key).join(",")).split(",");
const ARMS = opt("arms", "goal,hand").split(",");
const DRY = argv.includes("--dry");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIM = join(HERE, "..", "ablation", "mcp-shim.mjs");
const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const cfgModel = process.env.MCPTK_ABLATION_MODEL || (MODEL === "haiku" ? "claude-haiku-4-5-20251001" : MODEL);

// Player charters — same body-not-copilot framing as E-traverse; the arm difference is who repairs.
const charter = (arm) => arm === "goal"
  ? `You are an autonomous Minecraft PLAYER controlling a grounded walker body. You perceive and ` +
    `act only through your tools.\n\n- bot_target moves your body toward a goal and REPAIRS ` +
    `obstacles server-side within the rights you pass (may_modify/budget), returning an outcome ` +
    `(achieved / stopped) with a ledger of what it actually did and, on a stop, WHICH block ` +
    `stopped it (obstruction, sometimes with the location of a control that would clear it). ` +
    `Read bot_status for position/health.\n- Be decisive: issue the goal with the rights the ` +
    `task permits; only intervene when it reports a stop, and then act on the stop's own words.`
  : `You are an autonomous Minecraft PLAYER controlling a grounded walker body. You perceive and ` +
    `act only through your tools.\n\n- bot_goto pathfinds and moves your body; when it stops ` +
    `short, diagnose (check_path reports whether a route exists and WHICH block stops it) and ` +
    `repair BY HAND: bot_mine breaks a block (walk into reach first with bot_goto reach), ` +
    `bot_place places one from your inventory. Read bot_status for position/health.\n- Be ` +
    `decisive; do not give up after one stopped call.`;

const ping = await bridge("ping", {});
if (!ping.ok) { console.error(`no bridge — start the dev server first (${ping.error})`); process.exit(1); }

const manifest = await fetchManifest();
const known = new Set(manifest.map((t) => t.name));
for (const arm of ARMS) {
  const set = REPAIR_TOOLS[arm];
  if (!set) throw new Error(`unknown arm ${arm} (goal|hand)`);
  for (const n of set) if (!known.has(n)) throw new Error(`arm ${arm} names unknown tool "${n}"`);
}

// F7: server load, sampled around every episode. `tick query` output carries the average mspt;
// parse the first "<n> ms" figure, null if the command or the parse fails (disclosed, not faked).
async function mspt() {
  try {
    const r = await bridge("run_command", { command: "tick query" });
    const text = (r.result?.output ?? []).join(" ");
    const m = /([\d.]+)\s*ms/i.exec(text);
    return m ? parseFloat(m[1]) : null;
  } catch { return null; }
}

const instances = [];
for (let seed = 1; seed <= SEEDS; seed++) {
  for (let rung = 0; rung < RUNGS.length; rung++) {
    if (RUNG_KEYS.includes(RUNGS[rung].key)) instances.push(makeRepairRung({ seed, rung }));
  }
}
const questionsHash = sha(JSON.stringify(instances.map((s) => ({ name: s.name, seed: s.seed, rung: s.rung, arms: ARMS }))));
console.log(`Category E (e-repair) — ${SEEDS} seeds × rungs [${RUNG_KEYS.join(",")}] × arms [${ARMS.join(",")}], questions ${questionsHash}`);

/** Spawn a fresh walker at START (staging its inventory if the rung needs one), run, settle, score. */
async function runArm(s, arm, outDir) {
  await bridge("bot_body", { action: "despawn" });
  const spawn = await bridge("bot_body", { action: "spawn", type: "walker", pos: s.dronePos });
  if (!spawn.ok) throw new Error(`bot_body spawn failed: ${spawn.error}`);
  await wait(500);
  if (s.give) {
    const gave = await bridge("bot_give", { item: s.give, count: 64 });
    if (!gave.ok) throw new Error(`bot_give ${s.give} failed: ${gave.error}`);
  }
  const tag = `${s.name}-s${s.seed}-r${s.rung + 1}-${arm}`;
  const tools = s.toolsFor(arm);
  const transcriptPath = join(outDir, `transcript-${tag}.jsonl`);
  const msptBefore = await mspt();
  const out = await runEpisodeSdk({
    model: cfgModel, system: charter(arm), prompt: s.prompt(arm), maxTurns: s.maxTurns,
    shimPath: SHIM,
    shimEnv: {
      MCPTK_ABLATION_CONDITION: "a",
      MCPTK_MEMORY_DIR: join(outDir, "nomem"),
      MCPTK_WORLD_TOOLS: tools.join(","),
      MCPTK_ABLATION_TRANSCRIPT: transcriptPath,
    },
    allowedToolNames: tools,
    toolTranscriptPath: transcriptPath,
    sdkLogPath: join(outDir, `sdk-${tag}.jsonl`),
    log: (l) => console.log(`  [${tag}] ${l}`),
  });
  if (s.observeWindowMs) await wait(s.observeWindowMs);
  const msptAfter = await mspt();
  const scored = await s.score(arm, out.finalText ?? "");
  // F2: the agent's own claim, scored beside server truth — a wrong claim is an honesty signal,
  // and keeps predict-vs-execute clean of agent-behavior noise.
  scored.metrics.claimed = /\bARRIVED\b/i.test(out.finalText ?? "") ? "arrived"
    : /\bBLOCKED\b/i.test(out.finalText ?? "") ? "blocked" : "none";
  scored.metrics.claim_matches = scored.metrics.claimed === "arrived"
    ? scored.metrics.arrived === true
    : scored.metrics.claimed === "blocked" ? scored.metrics.arrived === false : null;
  scored.metrics.mspt_before = msptBefore;
  scored.metrics.mspt_after = msptAfter;
  console.log(`  [${tag}] ${JSON.stringify(scored.metrics)} — ${out.turns}t`);
  await bridge("bot_body", { action: "despawn" });
  return { out, scored, tag };
}

if (DRY) {
  for (const s of instances) {
    console.log(`\n=== ${s.name} seed ${s.seed} rung ${s.rung + 1} (${s.rung_key}) ===`);
    await s.setup();
    await bridge("bot_body", { action: "despawn" });
    await bridge("bot_body", { action: "spawn", type: "walker", pos: s.dronePos });
    await wait(800);
    const scored = await s.score(s.arms[0], "");
    console.log(`  arms: ${s.arms.join(", ")}  give: ${s.give ?? "-"}`);
    console.log(`  start→goal: ${JSON.stringify(s.dronePos)} → ${JSON.stringify(s.goal)}`);
    console.log(`  truth: ${JSON.stringify(scored.truth)}`);
    console.log(`  metrics: ${JSON.stringify(scored.metrics)}`);
    await bridge("bot_body", { action: "despawn" });
    await s.cleanup();
  }
  console.log("\n[dry] staged + invariants held (work-required, rights-solvable, control located).");
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = join(HERE, "..", "testbench-results", `${stamp}-repair-${MODEL}`);
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
  date: new Date().toISOString(), bench_version: BENCH_VERSION, category: "e", slice: "e-repair",
  model: MODEL, model_id: cfgModel, body: "walker",
  seeds: SEEDS, rungs: RUNG_KEYS, arms: ARMS,
  tools_hash: toolsHash, routes_hash: routesHash, git_head: execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: HERE }).toString().trim(),
  questions_hash: questionsHash, toolsets: REPAIR_TOOLS,
  substrate: "claude-agent-sdk/max-subscription",
}, null, 2), "utf8");

const rows = [];
for (const s of instances) {
  console.log(`\n[${s.name} s${s.seed} r${s.rung + 1}] setup (${s.rung_key})`);
  await s.setup();
  for (const arm of ARMS.filter((a) => s.arms.includes(a))) {
    try {
      const { out, scored, tag } = await runArm(s, arm, outDir);
      const rec = {
        scenario: s.name, seed: s.seed, rung: s.rung + 1, course: s.rung_key, arm, model: MODEL,
        ...scored.metrics, truth: scored.truth,
        turns: out.turns, subtype: out.subtype, capped: out.capped,
        tool_counts: toolCounts(out.transcript),
        tokens_in: out.usage.input_tokens, tokens_out: out.usage.output_tokens,
        cache_read: out.usage.cache_read_input_tokens, cache_write: out.usage.cache_creation_input_tokens,
      };
      rows.push(rec);
      await appendFile(answersPath, JSON.stringify(rec) + "\n", "utf8");
    } catch (e) {
      const rec = { scenario: s.name, seed: s.seed, rung: s.rung + 1, course: s.rung_key, arm, error: String(e) };
      rows.push(rec);
      await appendFile(answersPath, JSON.stringify(rec) + "\n", "utf8");
      console.log(`  [${s.name}-s${s.seed}-r${s.rung + 1}-${arm}] ERROR ${e}`);
    }
  }
  await s.cleanup();
}

// --- summary ------------------------------------------------------------------------------------
const lines = [`# Category E — e-repair (failure-path ladder) — ${stamp}, model ${MODEL}`, "",
  `${SEEDS} seeds × rungs [${RUNG_KEYS.join(",")}] × arms [${ARMS.join(",")}], questions ${questionsHash}`, ""];

const good = rows.filter((r) => !r.error);
if (good.length) {
  lines.push("## Per rung × arm");
  lines.push(`| seed | rung | arm | arrived | dist | named_control | claimed | claim_ok | turns | mspt b/a | tok nc/wc |`,
             `|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const r of good) lines.push(
    `| ${r.seed} | ${r.course} | ${r.arm} | ${r.arrived} | ${r.final_dist} | ${r.named_control ?? "-"} | ` +
    `${r.claimed} | ${r.claim_matches ?? "-"} | ${r.turns} | ${r.mspt_before ?? "?"}/${r.mspt_after ?? "?"} | ` +
    `${bothTok(accTok(zeroTok(), r))} |`);

  lines.push("", "## Per-arm totals (the remedial-turn A/B)");
  lines.push(`| arm | rungs | succeeded | total turns | total tok nc/wc |`, `|---|---|---|---|---|`);
  for (const arm of ARMS) {
    const ar = good.filter((r) => r.arm === arm);
    if (!ar.length) continue;
    const acc = ar.reduce((a, r) => accTok(a, r), zeroTok());
    const ok = ar.filter((r) => (r.named_control != null ? r.named_control : r.arrived)).length;
    lines.push(`| ${arm} | ${ar.length} | ${ok} | ${ar.reduce((a, r) => a + (r.turns ?? 0), 0)} | ${bothTok(acc)} |`);
  }
}
const errs = rows.filter((r) => r.error);
if (errs.length) {
  lines.push("", "## Errors");
  for (const r of errs) lines.push(`- s${r.seed} ${r.course} ${r.arm}: ${r.error}`);
}
const summary = lines.join("\n") + "\n";
await writeFile(join(outDir, "summary.md"), summary, "utf8");
console.log("\n" + summary);
console.log(`results → ${outDir}`);
