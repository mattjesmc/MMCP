// CLI: tally the three offline motivator counts (motivators.mjs) per rung x arm over one or more
// Category-T results dirs, no model spend. Reads testbench-results/*/answers.jsonl already on
// disk.
//
//   node testbench/analyze-motivators.mjs                       # every dir under testbench-results/
//   node testbench/analyze-motivators.mjs 2026-07-23*-tasks-*   # glob (* only) over dir names
//   node testbench/analyze-motivators.mjs testbench-results/2026-07-23T07-56-23-tasks-haiku
//   node testbench/analyze-motivators.mjs path/to/answers.jsonl

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { motivatorCounts } from "./motivators.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const resultsRoot = join(here, "..", "testbench-results");

function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/** Resolve the CLI arg (bare glob, a specific results dir, or a direct answers.jsonl path) to a list of dirs each containing an answers.jsonl. */
function resolveDirs(pattern) {
  if (existsSync(pattern)) {
    const st = statSync(pattern);
    if (st.isFile()) return [dirname(pattern)];
    if (st.isDirectory()) {
      if (existsSync(join(pattern, "answers.jsonl"))) return [pattern];
      // A directory that isn't itself a results dir: treat it as a root and take every child that is.
      return readdirSync(pattern)
        .filter((n) => existsSync(join(pattern, n, "answers.jsonl")))
        .map((n) => join(pattern, n));
    }
  }
  if (!existsSync(resultsRoot)) return [];
  const re = globToRegExp(pattern);
  return readdirSync(resultsRoot)
    .filter((n) => re.test(n) && existsSync(join(resultsRoot, n, "answers.jsonl")))
    .map((n) => join(resultsRoot, n));
}

const pattern = process.argv[2] ?? "*";
const dirs = resolveDirs(pattern);
if (!dirs.length) {
  console.error(`no results dirs matched "${pattern}" under ${resultsRoot}`);
  process.exit(1);
}

// tallies keyed by "rung|arm" — one row per (rung, arm) cell across every matched dir.
const tallies = new Map();
for (const dir of dirs) {
  let lines;
  try {
    lines = readFileSync(join(dir, "answers.jsonl"), "utf8").trim().split("\n").filter(Boolean);
  } catch {
    continue;
  }
  for (const line of lines) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // a corrupt line shouldn't crash the whole tally
    }
    const rung = rec.rung ?? "?";
    const arm = rec.arm ?? "?";
    const key = `${rung}|${arm}`;
    if (!tallies.has(key)) {
      tallies.set(key, { rung, arm, n: 0, noTrace: 0, blind: 0, derivable: 0, illegal: 0 });
    }
    const t = tallies.get(key);
    t.n++;
    const m = motivatorCounts(rec);
    if (!m.hasTrace) {
      t.noTrace++; // older run predates the trace field, or an instantiation-error record — report, don't crash
      continue;
    }
    t.blind += m.blind_retry;
    t.derivable += m.derivable_follow_up;
    t.illegal += m.statically_illegal_first;
  }
}

const rows = [...tallies.values()].sort((a, b) => {
  const rd = (typeof a.rung === "number" ? a.rung : Infinity) - (typeof b.rung === "number" ? b.rung : Infinity);
  return rd !== 0 ? rd : String(a.arm).localeCompare(String(b.arm));
});

const out = [];
out.push(`# Motivator tallies — ${dirs.length} results dir(s)`, "");
for (const d of dirs) out.push(`- ${d}`);
out.push("", "| rung | arm | sessions | no-trace (skipped) | blind-retry | derivable-follow-up | statically-illegal-first |");
out.push("|---|---|---|---|---|---|---|");
for (const r of rows) {
  out.push(`| ${r.rung} | ${r.arm} | ${r.n} | ${r.noTrace} | ${r.blind} | ${r.derivable} | ${r.illegal} |`);
}
if (!rows.length) out.push("| (no records found) |", "");
console.log(out.join("\n"));
