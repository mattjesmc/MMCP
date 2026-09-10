#!/usr/bin/env node
// Offline re-score of completed runs after an assert fix — no model calls. Rebuilds the episode
// objects from the run's own artifacts (transcripts + SDK logs), re-runs the scenario's assert, and
// rewrites result.json plus the matching results.jsonl row (marked rescored).
//   node ablation/rescore.mjs <runDir> [<runDir> …]

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeScenario } from "./scenarios/index.mjs";
import { toolCounts } from "./metrics.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = join(HERE, "..", "ablation-results");

async function jsonl(path) {
  try {
    return (await readFile(path, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

async function episodeFromArtifacts(runDir, key) {
  const transcript = await jsonl(join(runDir, `transcript-${key}.jsonl`));
  if (!transcript) return null;
  const sdk = (await jsonl(join(runDir, `sdk-${key}.jsonl`))) ?? [];
  const resultMsg = sdk.filter((m) => m.type === "result").pop();
  return { transcript, finalText: resultMsg?.result ?? "", final_drone_pos: null };
}

for (const arg of process.argv.slice(2)) {
  const runDir = resolve(arg);
  const row = JSON.parse(await readFile(join(runDir, "result.json"), "utf8"));
  const scenario = makeScenario(row.scenario, row.variant);
  const episodes = {};
  for (const key of Object.keys(row.episodes ?? {})) {
    episodes[key] = await episodeFromArtifacts(runDir, key);
  }
  const e2 = episodes.e2;
  if (!e2) {
    console.log(`${row.run_id}: no e2 transcript — skipped`);
    continue;
  }
  const verdict = await scenario.assert.call(scenario, {
    e1: episodes.e1 ?? null, e2, episodes, checkpoints: row.checkpoints ?? {},
    memoryRoot: join(runDir, "memory"), openingRender: null,
  });
  const before = row.success;
  Object.assign(row, {
    success: verdict.success,
    metrics: verdict.metrics,
    guarantees: verdict.guarantees ?? row.guarantees,
    flags: verdict.flags,
    answer: verdict.answer,
    truth: verdict.truth,
    rescored: new Date().toISOString(),
  });
  await writeFile(join(runDir, "result.json"), JSON.stringify(row, null, 2), "utf8");

  const all = (await jsonl(join(OUT_ROOT, "results.jsonl"))) ?? [];
  const idx = all.findIndex((r) => r.run_id === row.run_id);
  if (idx !== -1) all[idx] = { ...all[idx], ...row, episodes: all[idx].episodes };
  await writeFile(join(OUT_ROOT, "results.jsonl"), all.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  console.log(`${row.run_id}: success ${before} → ${verdict.success} (${JSON.stringify(verdict.metrics.acquisition ?? {})})`);
}
