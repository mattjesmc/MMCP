#!/usr/bin/env node
// Full-grid driver (ABLATION_DESIGN §Full-grid readiness): runs every cell SEQUENTIALLY (one drone,
// one world), continues past individual failures, then runs Track 2 forks (interrogation-multi
// C→D per variant). Each cell is a run.mjs child process; this driver only orchestrates.
//   node ablation/grid.mjs [--scenarios a,b,...] [--variants 1,2,3] [--conditions a,b,c,d]

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pexec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const RUN = join(HERE, "run.mjs");
const OUT_ROOT = join(HERE, "..", "ablation-results");

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : args[i + 1].split(",");
};
const SCENARIOS = opt("scenarios", ["stash-fixed", "stash-self", "interrogation-multi", "stale-fact", "resume-build"]);
const VARIANTS = opt("variants", ["1", "2", "3"]);
const CONDITIONS = opt("conditions", ["a", "b", "c", "d"]);

const t0 = Date.now();
const summary = [];

async function runCell(cliArgs, label) {
  const started = Date.now();
  process.stdout.write(`\n===== ${label} (${new Date().toISOString()}) =====\n`);
  try {
    const { stdout } = await pexec(process.execPath, [RUN, ...cliArgs], { maxBuffer: 64 * 1024 * 1024 });
    const tail = stdout.trim().split("\n").filter((l) => /^\[(assert|done|e\d\w*\] done)/.test(l) || l.startsWith("[assert]") || l.startsWith("[done]"));
    for (const l of tail) console.log(l);
    const ok = /\[assert\] success=true/.test(stdout);
    summary.push({ label, ran: true, success: ok, min: +((Date.now() - started) / 60000).toFixed(1) });
  } catch (e) {
    console.error(`CELL FAILED: ${label}: ${(e.message ?? "").split("\n")[0]}`);
    summary.push({ label, ran: false, success: null, min: +((Date.now() - started) / 60000).toFixed(1) });
  }
}

for (const scenario of SCENARIOS) {
  for (const variant of VARIANTS) {
    for (const condition of CONDITIONS) {
      await runCell(
        ["--scenario", scenario, "--condition", condition, "--variant", variant],
        `${scenario} v${variant} ${condition}`,
      );
    }
  }
}

// Track 2: fork D (e2 only) from each completed interrogation-multi C run.
if (SCENARIOS.includes("interrogation-multi") && CONDITIONS.includes("c") && CONDITIONS.includes("d")) {
  let rows = [];
  try {
    rows = (await readFile(join(OUT_ROOT, "results.jsonl"), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch { /* none */ }
  for (const variant of VARIANTS) {
    const cRun = rows.filter((r) => r.scenario === "interrogation-multi" && r.condition === "c" && String(r.variant) === variant && !r.fork_from).pop();
    if (!cRun) {
      console.log(`\nno completed C run for interrogation-multi v${variant} — fork skipped`);
      continue;
    }
    await runCell(
      ["--scenario", "interrogation-multi", "--condition", "d", "--variant", variant,
        "--fork-from", join(OUT_ROOT, cRun.run_id), "--episode", "e2", "--no-setup"],
      `interrogation-multi v${variant} d-fork(of ${cRun.run_id})`,
    );
  }
}

console.log(`\n===== GRID COMPLETE in ${((Date.now() - t0) / 3600000).toFixed(2)} h =====`);
for (const s of summary) {
  console.log(`${s.ran ? (s.success ? "PASS" : "fail") : "ERROR"}  ${s.label}  (${s.min}m)`);
}
const ran = summary.filter((s) => s.ran).length;
console.log(`${ran}/${summary.length} cells ran; ${summary.filter((s) => s.success).length} passed their assert`);
