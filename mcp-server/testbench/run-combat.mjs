#!/usr/bin/env node
// Category E, slice E-combat orchestrator — multi-round combat arena (BENCH_EXPANSION.md).
//
//   node testbench/run-combat.mjs [--model haiku] [--seeds 2] [--rounds 4] [--arms legal,xray] [--dry]
//
// Mirrors run-play.mjs (Category P), extended from one-session-per-arm to a WAVE LADDER: per
// seed × arm, spawn ONE body, then for each round r=1..N stage an escalating threat (altitude-matched
// to the hovering drone — the P-survive unblock), run ONE fresh player session, run a survival
// window while the server reflexes/engagement fight, then score from server truth. The body persists
// across rounds (re-geared each round); the ladder STOPS at the first round the body dies in.
// Output matches A/B/C/T/P: testbench-results/<stamp>-combat-<model>/ (manifest + answers.jsonl +
// summary.md); full SDK + tool transcripts saved per round for token analysis.

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
import { TOOLSETS } from "./play-scenario.mjs";
import { makeCombatArena, LADDER } from "./combat-scenario.mjs";
import { bothTok, zeroTok, accTok } from "./tokens.mjs";

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
const MODEL = opt("model", "haiku");
const SEEDS = parseInt(opt("seeds", "2"), 10);
const ROUNDS = Math.min(parseInt(opt("rounds", String(LADDER.length)), 10), LADDER.length);
const ARMS = opt("arms", "legal,xray").split(",");
const DRY = argv.includes("--dry");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIM = join(HERE, "..", "ablation", "mcp-shim.mjs");
const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const cfgModel = process.env.MCPTK_ABLATION_MODEL || (MODEL === "haiku" ? "claude-haiku-4-5-20251001" : MODEL);

// Player charter — identical framing to run-play.mjs (a body with honest senses, not an omniscient
// copilot). The ONLY per-arm difference is the one-line perception clause (fair ablation: perception
// channel, not prompt IQ).
const CHARTER_CORE = `You are an autonomous Minecraft PLAYER controlling your own body — a drone \
actuator with a hotbar, hands, armor slots, and server-run reflexes. You are NOT an omniscient \
copilot.

- Combat & survival are reactive: arm reflexes with bot_reactions (the server runs them every game \
tick — far faster than you could react in this loop), set movement with bot_body action:"engage" (mode fight, policy kite/close) \
(kite/strafe/close/hold a target), equip from your inventory with bot_equip, and use \
bot_shoot/bot_eat/bot_drink. Once your reflexes and engagement are set, the server keeps executing \
them on your behalf — you do not micromanage each swing.
- Be decisive and act. Each wave is harder than the last; survive and clear it.`;
const PERCEPTION = {
  legal: `\n- Perception: sense_entities is your belief store — what your body can actually SEE \
(field of view + line of sight) and HEAR. It is NOT ground truth; things you cannot perceive are \
absent. Never report or act on what you cannot sense.`,
  xray: `\n- Perception: you have authoritative entity awareness — get_entities and scene_summary \
report true positions around you.`,
};
const charter = (arm) => CHARTER_CORE + (arm === "xray" ? PERCEPTION.xray : PERCEPTION.legal);

const ping = await bridge("ping", {});
if (!ping.ok) { console.error(`no bridge — start the 0.14.0 dev server first (${ping.error})`); process.exit(1); }

// Validate the combat tool surfaces against the running manifest (a hidden-but-misnamed tool would
// silently make an arm not the arm we think). E-combat reuses P's survive_legal/survive_xray sets.
const manifest = await fetchManifest();
const known = new Set(manifest.map((t) => t.name));
for (const arm of ARMS) {
  const set = arm === "xray" ? TOOLSETS.survive_xray : TOOLSETS.survive_legal;
  for (const n of set) if (!known.has(n)) throw new Error(`arm ${arm} names unknown tool "${n}" — is the server 0.14.0?`);
}

// Instantiate one scenario per seed (each holds all rounds).
const instances = [];
for (let seed = 1; seed <= SEEDS; seed++) instances.push(makeCombatArena({ seed, rounds: ROUNDS }));
const questionsHash = sha(JSON.stringify(instances.map((s) => ({ name: s.name, seed: s.seed, rounds: s.rounds, arms: ARMS }))));
console.log(`Category E (e-combat) — ${instances.length} seeds × ${ROUNDS} rounds × arms [${ARMS.join(",")}], questions ${questionsHash}`);

/** Run every round of one arm on a single persistent body; stop the ladder at the first death. */
async function runArm(s, arm, outDir) {
  await bridge("bot_body", { action: "despawn" });
  const spawn = await bridge("bot_body", { action: "spawn",  pos: s.dronePos });
  if (!spawn.ok) throw new Error(`bot_body spawn failed: ${spawn.error}`);
  const armRows = [];
  for (let r = 1; r <= s.rounds; r++) {
    const tag = `${s.name}-s${s.seed}-${arm}-r${r}`;
    const pre = await s.prepareRound(arm, r);
    const tools = s.toolsFor(arm);
    const transcriptPath = join(outDir, `transcript-${tag}.jsonl`);
    const out = await runEpisodeSdk({
      model: cfgModel, system: charter(arm), prompt: s.prompt(r), maxTurns: s.maxTurns,
      shimPath: SHIM,
      shimEnv: {
        MCPTK_ABLATION_CONDITION: "a",            // no memory tools / no opening render
        MCPTK_MEMORY_DIR: join(outDir, "nomem"),  // unused (condition a), but the shim expects it set
        MCPTK_WORLD_TOOLS: tools.join(","),        // the player-legal (or x-ray) surface
        MCPTK_ABLATION_TRANSCRIPT: transcriptPath,
      },
      allowedToolNames: tools,
      toolTranscriptPath: transcriptPath,
      sdkLogPath: join(outDir, `sdk-${tag}.jsonl`),
      log: (l) => console.log(`  [${tag}] ${l}`),
    });
    if (s.observeWindowMs) { // let the armed reflexes + engagement play out
      console.log(`  [${tag}] survival window ${s.observeWindowMs}ms …`);
      await wait(s.observeWindowMs);
    }
    const scored = await s.scoreRound(arm, r, pre);
    armRows.push({ out, scored, tag });
    console.log(`  [${tag}] ${JSON.stringify(scored.metrics)} — ${out.turns}t`);
    if (!scored.metrics.alive) { console.log(`  [${tag}] body died — ladder stops at round ${r}`); break; }
    await s.clearRound(); // clear survivors before the next wave
  }
  await bridge("bot_body", { action: "despawn" });
  return armRows;
}

if (DRY) {
  // NOTE: --dry still stages the LIVE arena (spawns a body, builds the platform, summons a wave). Do
  // not run this while the dev server is busy. It scores truth only — no model spend.
  for (const s of instances) {
    console.log(`\n=== ${s.name} seed ${s.seed} (${s.rounds} rounds, arms: ${ARMS.join(",")}) ===`);
    await s.setup();
    const arm = ARMS[0];
    await bridge("bot_body", { action: "despawn" });
    await bridge("bot_body", { action: "spawn",  pos: s.dronePos });
    const pre = await s.prepareRound(arm, 1);
    const scored = await s.scoreRound(arm, 1, pre);
    console.log(`  tools[${arm}]: ${s.toolsFor(arm).join(", ")}`);
    console.log(`  round 1 (${s.roundName(1)}) prepare: ${JSON.stringify(pre)}`);
    console.log(`  round 1 metrics: ${JSON.stringify(scored.metrics)}`);
    await bridge("bot_body", { action: "despawn" });
    await s.cleanup();
  }
  console.log("\n[dry] staged + scored round-1 truth (altitude match visible in body_y/plat_y), no model spend.");
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = join(HERE, "..", "testbench-results", `${stamp}-combat-${MODEL}`);
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
  date: new Date().toISOString(), bench_version: BENCH_VERSION, category: "e", slice: "e-combat", model: MODEL, model_id: cfgModel,
  seeds: SEEDS, rounds: ROUNDS, arms: ARMS, ladder: LADDER.slice(0, ROUNDS).map((r) => r.name),
  tools_hash: toolsHash, routes_hash: routesHash, git_head: execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: HERE }).toString().trim(),
  questions_hash: questionsHash, toolsets: { legal: TOOLSETS.survive_legal, xray: TOOLSETS.survive_xray },
  substrate: "claude-agent-sdk/max-subscription",
}, null, 2), "utf8");

const rows = [];
for (const s of instances) {
  console.log(`\n[${s.name} s${s.seed}] setup`);
  await s.setup();
  for (const arm of ARMS) {
    try {
      const armRows = await runArm(s, arm, outDir);
      for (const { out, scored, tag } of armRows) {
        const rec = {
          scenario: s.name, seed: s.seed, arm, model: MODEL,
          ...scored.metrics, truth: scored.truth,
          turns: out.turns, subtype: out.subtype, capped: out.capped,
          tool_counts: toolCounts(out.transcript),
          tokens_in: out.usage.input_tokens, tokens_out: out.usage.output_tokens,
          cache_read: out.usage.cache_read_input_tokens, cache_write: out.usage.cache_creation_input_tokens,
        };
        rows.push(rec);
        await appendFile(answersPath, JSON.stringify(rec) + "\n", "utf8");
      }
    } catch (e) {
      const rec = { scenario: s.name, seed: s.seed, arm, error: String(e) };
      rows.push(rec);
      await appendFile(answersPath, JSON.stringify(rec) + "\n", "utf8");
      console.log(`  [${s.name}-s${s.seed}-${arm}] ERROR ${e}`);
    }
  }
  await s.cleanup();
}

// --- summary ------------------------------------------------------------------------------------
const lines = [`# Category E — e-combat (multi-round arena) — ${stamp}, model ${MODEL}`, "",
  `${instances.length} seeds × ${ROUNDS} rounds × arms [${ARMS.join(",")}], questions ${questionsHash}`,
  `Ladder: ${LADDER.slice(0, ROUNDS).map((r, i) => `r${i + 1} ${r.name}`).join(" → ")}`, ""];

// Per round × arm table (skill + tokens) — style matches run-play's P-survive table + Category T's
// `tok nc/wc` columns (noCache / withCache, via bothTok).
const good = rows.filter((r) => !r.error);
if (good.length) {
  lines.push("## Per round × arm (skill + tokens)");
  lines.push(`| seed | round | wave | arm | cleared | alive | health | killed/threat | dmg | turns | tok nc/wc |`,
             `|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const r of good) lines.push(
    `| ${r.seed} | ${r.round} | ${r.round_name} | ${r.arm} | ${r.cleared} | ${r.alive} | ${r.final_health} | ` +
    `${r.mobs_killed}/${r.mobs_initial} | ${r.damage_taken} | ${r.turns} | ${bothTok(accTok(zeroTok(), r))} |`);

  // Per-arm totals — rounds cleared + reached, total turns, and total tokens both ways.
  lines.push("", "## Per-arm totals");
  lines.push(`| arm | rounds reached | rounds cleared | deepest round | total turns | total tok nc/wc |`,
             `|---|---|---|---|---|---|`);
  for (const arm of ARMS) {
    const ar = good.filter((r) => r.arm === arm);
    if (!ar.length) continue;
    const acc = ar.reduce((a, r) => accTok(a, r), zeroTok());
    const cleared = ar.filter((r) => r.cleared).length;
    const deepest = Math.max(0, ...ar.filter((r) => r.cleared).map((r) => r.round));
    const totalTurns = ar.reduce((s, r) => s + (r.turns ?? 0), 0);
    lines.push(`| ${arm} | ${ar.length} | ${cleared} | ${deepest} | ${totalTurns} | ${bothTok(acc)} |`);
  }
}
const errs = rows.filter((r) => r.error);
if (errs.length) { lines.push("", "## Errors"); for (const r of errs) lines.push(`- ${r.scenario} s${r.seed} ${r.arm}: ${r.error}`); }
const summary = lines.join("\n") + "\n";
await writeFile(join(outDir, "summary.md"), summary, "utf8");
console.log(`\n${summary}\nresults → ${outDir}`);
