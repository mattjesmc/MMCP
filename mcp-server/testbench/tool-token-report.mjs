#!/usr/bin/env node
// Per-tool token attribution over a bench result dir.
//
//   node testbench/tool-token-report.mjs <results-dir> [<results-dir> ...]
//
// WHY per-tool matters: with-cache throughput is dominated by cache_read = (context size) ×
// (turns), and context size grows with every tool RESULT the model keeps in view. So the tools
// whose results are largest — and re-read on every later turn — are what actually drive the token
// bill. This ranks tools by total result bytes (≈ tokens/4), the context-bloat attribution.
//
// Sources, best available per dir:
//   transcript-*.jsonl  (C/P — the shim's verbatim {name,input,result} rows): exact result bytes.
//   answers.jsonl .trace (T — {tool, result_chars}): result_chars per call.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const jl = (p) => readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const ktok = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : Math.round(n / 1000) + "k");

/** Collect {tool -> {calls, bytes}} from every transcript-*.jsonl + answers.jsonl trace under dir (recursive). */
function collect(dir, acc = {}) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { collect(p, acc); continue; }
    if (/^transcript-.*\.jsonl$/.test(name)) {
      for (const row of jl(p)) {
        if (row.type !== "tool" && !row.name) continue;
        const t = row.name; if (!t) continue;
        const bytes = JSON.stringify(row.result ?? "").length;
        (acc[t] ??= { calls: 0, bytes: 0 }); acc[t].calls++; acc[t].bytes += bytes;
      }
    } else if (name === "answers.jsonl") {
      for (const rec of jl(p)) for (const e of rec.trace ?? []) {
        if (!e.tool) continue;
        (acc[e.tool] ??= { calls: 0, bytes: 0 }); acc[e.tool].calls++; acc[e.tool].bytes += e.result_chars ?? 0;
      }
    }
  }
  return acc;
}

const dirs = process.argv.slice(2);
if (!dirs.length) { console.error("usage: tool-token-report.mjs <results-dir> [...]"); process.exit(1); }

for (const dir of dirs) {
  const acc = collect(dir);
  const rows = Object.entries(acc).map(([tool, v]) => ({ tool, ...v, mean: Math.round(v.bytes / v.calls) }))
    .sort((a, b) => b.bytes - a.bytes);
  const total = rows.reduce((s, r) => s + r.bytes, 0) || 1;
  console.log(`\n# ${dir.split(/[\\/]/).filter(Boolean).pop()} — per-tool result bytes (≈ context-bloat / token driver)`);
  console.log(`| tool | calls | total bytes | ~tokens | mean bytes | % of result bytes |`);
  console.log(`|---|---|---|---|---|---|`);
  for (const r of rows) {
    console.log(`| ${r.tool} | ${r.calls} | ${r.bytes} | ${ktok(r.bytes / 4)} | ${r.mean} | ${((r.bytes / total) * 100).toFixed(1)}% |`);
  }
  console.log(`(total result bytes ${ktok(total)}, ≈ ${ktok(total / 4)} tokens carried through context)`);
}
