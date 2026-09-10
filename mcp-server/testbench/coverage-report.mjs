#!/usr/bin/env node
// Tool COVERAGE map for the testbench: which of the toolkit's tools does the bench actually
// exercise, and which are dark? Answers "what can we not yet argue about?" — the complement of the
// per-tool ablation (run-tasks.mjs --loo, which argues about the tools a category DOES exercise).
//
//   node testbench/coverage-report.mjs            # scan all testbench-results/*
//   node testbench/coverage-report.mjs <dir ...>  # scan specific result dirs
//
// Universe = the live bridge manifest (grouped by its own `mechanism` taxonomy) + the local tools
// (index.mjs registry — memory + launch). Usage = every tool name seen in any transcript row or in
// any answers.jsonl trace/histogram, tagged by the category of the top-level result dir it came from
// (T=tasks, C=mem, P=play, AB=spatial/serialization). A tool is:
//   TESTED       — exercised by >=1 category (and, if it went through --loo, has a marginal-value #);
//   AVAILABLE    — offered to a category but never called (a substitute covered for it, or no task
//                  needs it) — present but not usefully discriminated;
//   DARK         — no category offers a task that could call it — a coverage gap.
// The DARK set, grouped by mechanism, is the raw material for proposing new bench categories.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = join(fileURLToPath(import.meta.url), "..");
const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const strip = (n) => String(n || "").replace(/^mcp__[a-z0-9_]+__/, "");
const jl = (p) => readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

// ---- universe: bridge manifest (mechanism) + local tools -------------------------------------
async function universe() {
  const u = new Map(); // name -> mechanism
  try {
    const manifest = await fetch(`${BASE}/tools`).then((r) => r.json());
    for (const t of manifest) u.set(t.name, t.mechanism || "?");
  } catch (e) {
    console.error(`! bridge unreachable at ${BASE} (${e.message}) — universe limited to local tools`);
  }
  try {
    const reg = await import(pathToFileURL(join(here, "..", "local", "registry.mjs")).href);
    for (const t of reg.localTools?.() ?? []) u.set(t.name, "local");
  } catch (e) { console.error(`! local registry not loaded (${e.message})`); }
  return u;
}

// ---- usage: category -> Set(tool), and tool -> {cat -> calls} ---------------------------------
function categoryOf(dirname) {
  if (/tasks/.test(dirname)) return "T";
  if (/mem/.test(dirname)) return "C";
  if (/play/.test(dirname)) return "P";
  return "AB";
}

function scanDir(dir, cat, usage) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { scanDir(p, cat, usage); continue; }
    const bump = (tool) => { const t = strip(tool); if (!t) return; (usage[t] ??= {}); usage[t][cat] = (usage[t][cat] ?? 0) + 1; };
    if (/^transcript-.*\.jsonl$/.test(name)) { for (const row of jl(p)) if (row.name) bump(row.name); }
    else if (name === "answers.jsonl") {
      for (const rec of jl(p)) {
        for (const e of rec.trace ?? []) if (e.tool) bump(e.tool);
        for (const [t, n] of Object.entries(rec.tools ?? {})) { const s = strip(t); (usage[s] ??= {}); usage[s][cat] = (usage[s][cat] ?? 0) + (n || 0); }
      }
    }
  }
}

const dirs = process.argv.slice(2);
const roots = dirs.length ? dirs : readdirSync(join(here, "..", "testbench-results")).map((d) => join(here, "..", "testbench-results", d)).filter((p) => statSync(p).isDirectory());

const usage = {};
for (const root of roots) scanDir(root, categoryOf(root.split(/[\\/]/).pop()), usage);

const U = await universe();
// Union of the known universe and anything actually seen in results (a used tool absent from the
// live manifest — e.g. a renamed/removed tool — must not vanish from the map).
const allTools = new Set([...U.keys(), ...Object.keys(usage)]);
const rows = [...allTools].map((tool) => {
  const mech = U.get(tool) ?? "unknown";
  const use = usage[tool] ?? {};
  const cats = Object.keys(use).filter((c) => use[c] > 0);
  const calls = Object.values(use).reduce((a, b) => a + b, 0);
  return { tool, mech, cats, calls };
});

// ---- report ----------------------------------------------------------------------------------
const MECH_ORDER = ["observe", "embodied", "world_edit", "privileged", "local", "unknown", "?"];
const byMech = (m) => rows.filter((r) => r.mech === m).sort((a, b) => b.calls - a.calls);

console.log(`# Tool coverage — ${U.size} tools across ${roots.length} result dirs\n`);
console.log(`| mechanism | tested | dark | tools tested |`);
console.log(`|---|---|---|---|`);
for (const m of MECH_ORDER) {
  const rs = rows.filter((r) => r.mech === m);
  if (!rs.length) continue;
  const tested = rs.filter((r) => r.calls > 0);
  console.log(`| ${m} | ${tested.length}/${rs.length} | ${rs.length - tested.length} | ${tested.map((r) => r.tool).join(", ") || "—"} |`);
}

console.log(`\n## DARK — no bench task can call these (grouped by mechanism)\n`);
for (const m of MECH_ORDER) {
  const dark = byMech(m).filter((r) => r.calls === 0);
  if (!dark.length) continue;
  console.log(`- **${m}** (${dark.length}): ${dark.map((r) => r.tool).join(", ")}`);
}

console.log(`\n## Full map\n`);
console.log(`| tool | mechanism | categories | calls |`);
console.log(`|---|---|---|---|`);
for (const m of MECH_ORDER) for (const r of byMech(m)) {
  console.log(`| ${r.tool} | ${r.mech} | ${r.cats.join("+") || "—"} | ${r.calls || ""} |`);
}
