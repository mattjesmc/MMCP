#!/usr/bin/env node
// Queue item 2 — recall re-measure under tier-2 pressure (ARCHITECTURE.md §Post-ablation queue).
//
// The step-7 grid measured mem_recall (D) vs manual mem_read drilling (C) on 3-block corpora, where
// the session render still showed everything and there was nothing to retrieve *from*. Item 1 made
// the render honestly budgeted, so the question can finally be asked in the regime it was designed
// for: a soak-scale corpus where the coarse layer is elided and both compaction levels are nagging.
//
// Design: every cell forks the standing soak corpus (14 blocks / 46 entries / 23 places) with
// --corpus-only, so the agent carries a large retrieval load but none of the donor's working state,
// then runs the normal interrogation-multi episodes on top of it.
//   arm 1  C x3 variants  — drill manually with mem_read
//   arm 2  D x3 variants  — same, with mem_recall available throughout
//   arm 3  D-fork x3      — Track 2: fork each finished C run and re-run E2 only, so the corpus is
//                           byte-identical and the ONLY difference is the toolset (the clean test)
// 9 cells, sequential (one drone, one world). Touch ablation/STOP.item2 to halt between cells.
//   node ablation/item2-recall.mjs [--variants 1,2,3] [--dry]

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, appendFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const pexec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const RUN = join(HERE, "run.mjs");
const outArg = process.argv.indexOf("--out");
const OUT = outArg === -1
  ? join(HERE, "..", "ablation-results", "item2-recall")
  : join(HERE, "..", "ablation-results", process.argv[outArg + 1]);
const SOAK = join(HERE, "..", "companion-results", "soak-2026-07-19T19-02-29");
const STOP = join(HERE, "STOP.item2");

const argv = process.argv.slice(2);
const optOf = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1].split(","); };
const VARIANTS = optOf("variants", ["1", "2", "3"]);
const DRY = argv.includes("--dry");

await mkdir(OUT, { recursive: true });
const log = async (m) => {
  const line = `[${new Date().toISOString()}] ${m}`;
  console.log(line);
  await appendFile(join(OUT, "driver.log"), line + "\n", "utf8");
};

const stopped = async () => { try { await access(STOP); return true; } catch { return false; } };

const cells = [];
async function cell(label, cliArgs) {
  if (await stopped()) { await log(`STOP file present — halting before ${label}`); return null; }
  const started = Date.now();
  await log(`===== ${label} =====`);
  try {
    const { stdout } = await pexec(process.execPath, [RUN, ...cliArgs, ...(DRY ? ["--dry"] : [])],
      { maxBuffer: 64 * 1024 * 1024 });
    const runId = /\[done\] (\S+)/.exec(stdout)?.[1] ?? /Run dir: (.+)$/m.exec(stdout)?.[1] ?? null;
    const ok = /\[assert\] success=true/.test(stdout);
    const min = +((Date.now() - started) / 60000).toFixed(1);
    await log(`${label}: success=${ok} runId=${runId} (${min} min)`);
    cells.push({ label, ok, runId, min });
    return runId;
  } catch (e) {
    await log(`CELL FAILED ${label}: ${(e.message ?? "").split("\n")[0]}`);
    cells.push({ label, ok: false, runId: null, min: +((Date.now() - started) / 60000).toFixed(1) });
    return null;
  }
}

const base = (cond, v) => [
  "--scenario", "interrogation-multi", "--condition", cond, "--variant", v,
  "--fork-from", SOAK, "--corpus-only", "--out", OUT,
];

// Arms 1 and 2: full episode sets over the soak-scale corpus.
const cRuns = {};
for (const v of VARIANTS) cRuns[v] = await cell(`C v${v} (soak-forked)`, base("c", v));
for (const v of VARIANTS) await cell(`D v${v} (soak-forked)`, base("d", v));

// Arm 3: Track 2 — identical corpus, toolset is the only variable.
for (const v of VARIANTS) {
  if (!cRuns[v]) { await log(`skip D-fork v${v}: C v${v} produced no run dir`); continue; }
  // [done] reports a bare runId; the --dry fallback reports an absolute path. Accept either.
  const donor = isAbsolute(cRuns[v]) ? cRuns[v] : join(OUT, cRuns[v]);
  await cell(`D-fork v${v} (from C v${v})`, [
    "--scenario", "interrogation-multi", "--condition", "d", "--variant", v,
    "--fork-from", donor, "--episode", "e2", "--no-setup", "--out", OUT,
  ]);
}

const done = cells.filter((c) => c.ok).length;
await log(`\n==== item 2 complete: ${done}/${cells.length} cells succeeded, ` +
  `${cells.reduce((a, c) => a + c.min, 0).toFixed(0)} min total ====`);
for (const c of cells) await log(`  ${c.ok ? "ok  " : "FAIL"} ${c.label}`);
await log(`results: ${join(OUT, "results.jsonl")}`);
