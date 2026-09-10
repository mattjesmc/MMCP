#!/usr/bin/env node
// Unified bench constructor — build a run from FULL / CATEGORY / DISCIPLINE / ABLATION and execute
// it through the existing per-category entrypoints (which keep their own CLIs; this composes them).
// The registry (registry.mjs) is the single source of truth for what exists and how to select it.
//
//   node testbench/run-bench.mjs --list                          # resolved plan, no execution
//   node testbench/run-bench.mjs --dry                           # FULL bench, staging self-checks only
//   node testbench/run-bench.mjs --model haiku                   # FULL bench, full arms (no ablation)
//   node testbench/run-bench.mjs --cat T,Z --model haiku         # two categories
//   node testbench/run-bench.mjs --discipline causal,relational  # every unit where these are load-bearing
//   node testbench/run-bench.mjs --unit t4_reach,z_gate_xor      # cherry-picked units
//   node testbench/run-bench.mjs --cat T --ablation std          # paired toolset arms (with/without etc.)
//   node testbench/run-bench.mjs --cat T --ablation loo          # per-tool leave-one-out (T only)
//
// Axes compose as AND. Ablation modes: none (full/best arm — the "complete benchmark" reading),
// std (each harness's paired arms), loo (where the runner supports it). Results land in the same
// testbench-results/<stamp>-<cat>-<model>/ dirs as always; bench-report.mjs pivots them back along
// these same axes.

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { selectUnits, planRunners, RUNNERS } from "./registry.mjs";
import { DISCIPLINES } from "./disciplines.mjs";

const here = join(fileURLToPath(import.meta.url), "..");
const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
const list = (name) => { const v = opt(name, null); return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : null; };

const MODEL = opt("model", "haiku");
const SEEDS = opt("seeds", null);
const ABLATION = opt("ablation", "none"); // none | std | loo
const DRY = argv.includes("--dry");
const LIST = argv.includes("--list");

const units = selectUnits({
  cats: list("cat"),
  disciplines: list("discipline"),
  ids: list("unit"),
  anyDiscipline: argv.includes("--any-discipline"),
});
if (!units.length) { console.error("selection matched no units (see registry.mjs)"); process.exit(1); }
if (!["none", "std", "loo"].includes(ABLATION)) { console.error(`unknown --ablation ${ABLATION}`); process.exit(1); }

const plans = planRunners(units, { ablation: ABLATION });

// run.mjs is the one entrypoint without --seeds; everything else takes the shared passthroughs.
const passthrough = (runner) => [
  "--model", MODEL,
  ...(SEEDS && runner !== "run.mjs" ? ["--seeds", SEEDS] : []),
  ...(DRY ? ["--dry"] : []),
];

console.log(`# bench plan — ${units.length} units, ${plans.length} runners, ablation=${ABLATION}${DRY ? ", DRY" : ""}\n`);
for (const p of plans) {
  console.log(`## node testbench/${p.runner} ${[...p.args, ...passthrough(p.runner)].join(" ")}`);
  for (const u of p.units) {
    const d = u.disciplines.join("+") + (u.also.length ? ` (~${u.also.join("+")})` : "");
    console.log(`   - ${u.id.padEnd(16)} [${u.cat}] ${d.padEnd(38)} ${u.status === "pending" ? "⚠ live-pending" : ""}`);
  }
}
const pendingLoo = ABLATION === "loo" && plans.some((p) => !RUNNERS[p.runner].loo);
if (pendingLoo) console.log(`\n! --ablation loo only applies to runners that support it; others run their full arm.`);
if (LIST) process.exit(0);

// Execute sequentially — every harness (except rotate) shares the one dev server and the drone slot.
const results = [];
for (const p of plans) {
  const args = [join(here, p.runner), ...p.args, ...passthrough(p.runner)];
  console.log(`\n=== ${p.runner} ===`);
  const r = spawnSync(process.execPath, args, { stdio: "inherit", cwd: join(here, "..") });
  results.push({ runner: p.runner, code: r.status ?? -1 });
}
console.log(`\n# bench done`);
for (const r of results) console.log(`  ${r.code === 0 ? "ok " : "FAIL"} ${r.runner}${r.code !== 0 ? ` (exit ${r.code})` : ""}`);
process.exit(results.some((r) => r.code !== 0) ? 1 : 0);
