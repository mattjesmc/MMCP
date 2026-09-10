#!/usr/bin/env node
// Persistence-weighted per-tool cache_read attribution over a bench result dir.
//
//   node testbench/tool-cacheread-report.mjs <results-dir> [<results-dir> ...]
//
// WHY this refines tool-token-report.mjs: with-cache throughput is ~98% cache_read, and
// cache_read = (context size) × (turns). A tool RESULT does not cost its bytes once — it is
// re-read on EVERY subsequent turn it stays in the context window. So a 5 KB result emitted on
// turn 2 of a 27-turn session is read ~25×; the same result on the last turn costs ~1×. The true
// driver of the bill is therefore:
//
//     weight(call) = result_tokens × (turns the result stayed in the context window)
//
// This script computes that per tool, two ways depending on what a dir recorded:
//
//   PRECISE  (C/P dirs — have sdk-*.jsonl + transcript-*.jsonl):
//     Parse the sdk log into API-call turns (assistant groups split by user/tool-result rows).
//     A result requested at turn t is cache-read by turns t+1..T → weight = T - t. Exact result
//     bytes come from the time-aligned transcript. Also sums the MEASURED per-turn cache_read so
//     the model can be validated against reality.
//
//   MODELLED (T dirs — only answers.jsonl .trace: ordered tool calls + result_chars + turns):
//     No per-turn log, so persistence is modelled from trace order × turn count. Call i of n in a
//     session of `turns` turns is emitted ~fraction (i+0.5)/n through → remaining reads ≈
//     turns × (1 - (i+0.5)/n). weight = result_tokens × that.
//
// Token proxy: result_bytes / 4 (consistent across tools; not exact tokenization).

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const jl = (p) => readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const ktok = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : Math.round(n / 1000) + "k");
const strip = (n) => String(n || "").replace(/^mcp__[a-z0-9_]+__/, "");
const B2T = (b) => b / 4; // bytes -> ~tokens proxy

// ---- PRECISE: parse one sdk log into ordered turns -------------------------------------------
// A "turn" = a maximal run of assistant messages not interrupted by a user (tool-result) message.
// Returns { turns: [{tools:[names], cache_read, cache_creation, input, output}], T }.
function parseSdkTurns(sdkPath) {
  const rows = jl(sdkPath);
  const turns = [];
  let cur = null; // {tools, usage}
  const flush = () => { if (cur && (cur.tools.length || cur.usage)) turns.push(cur); cur = null; };
  for (const r of rows) {
    if (r.type === "assistant" && r.message) {
      if (!cur) cur = { tools: [], usage: null };
      const blocks = r.message.content || [];
      for (const b of blocks) if (b.type === "tool_use") cur.tools.push(strip(b.name));
      if (r.message.usage) cur.usage = r.message.usage;
    } else if (r.type === "user") {
      flush(); // tool results arrived -> boundary; next assistant is a new API call
    }
    // system / rate_limit_event rows are ignored (they don't split turns)
  }
  flush();
  return { turns, T: turns.length };
}

// Ordered exact result bytes from a transcript, one entry per tool call in call order.
function transcriptCalls(tpath) {
  return jl(tpath).filter((r) => r.name).map((r) => ({ tool: strip(r.name), bytes: JSON.stringify(r.result ?? "").length }));
}

// Attribute one PRECISE session. Mutates acc[tool] = {calls, bytes, wtok, naiveTok}.
// Returns { measuredCR, modelledCR } for validation.
function attributePrecise(sdkPath, tpath, acc) {
  const { turns, T } = parseSdkTurns(sdkPath);
  const tcalls = transcriptCalls(tpath);
  // Flatten sdk tool calls with their turn index (1-based).
  const sdkCalls = [];
  turns.forEach((tn, i) => tn.tools.forEach((tool) => sdkCalls.push({ tool, turn: i + 1 })));
  // Zip sdk order <-> transcript order (both are strict call order). Match by index; guard names.
  const n = Math.min(sdkCalls.length, tcalls.length);
  for (let i = 0; i < n; i++) {
    const turn = sdkCalls[i].turn;
    const tool = tcalls[i].tool; // trust transcript's name+bytes
    const remaining = T - turn;  // # subsequent API calls that re-read this result
    const tok = B2T(tcalls[i].bytes);
    const e = (acc[tool] ??= { calls: 0, bytes: 0, wtok: 0, naiveTok: 0 });
    e.calls++; e.bytes += tcalls[i].bytes; e.naiveTok += tok; e.wtok += tok * remaining;
  }
  const crSeq = turns.map((t) => t.usage?.cache_read_input_tokens || 0);
  const measuredCR = crSeq.reduce((s, c) => s + c, 0);
  // Measured prefix vs variable: cache_read each turn = fixed prefix (system+tool schemas) + the
  // context accumulated so far. The first NON-ZERO read is the bare prefix (nothing accumulated
  // yet); prefix cost = that × T, variable (tool results + assistant reasoning re-read) = the rest.
  const prefix = crSeq.find((c) => c > 0) || 0;
  const prefixCR = prefix * T;
  return { measuredCR, prefixCR, T, matched: n, sdkN: sdkCalls.length, trN: tcalls.length };
}

// Attribute one MODELLED (T) question record.
function attributeModelled(rec, acc) {
  const trace = (rec.trace || []).filter((e) => e.tool);
  const nn = trace.length;
  const turns = rec.turns || nn || 1;
  trace.forEach((e, i) => {
    const frac = (i + 0.5) / nn;            // position through the session
    const remaining = turns * (1 - frac);   // modelled # subsequent turns that re-read this result
    const tok = B2T(e.result_chars || 0);
    const tool = strip(e.tool);
    const en = (acc[tool] ??= { calls: 0, bytes: 0, wtok: 0, naiveTok: 0 });
    en.calls++; en.bytes += e.result_chars || 0; en.naiveTok += tok; en.wtok += tok * remaining;
  });
}

// ---- driver ----------------------------------------------------------------------------------
function findPairs(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { findPairs(p, out); continue; }
    const m = /^transcript-(.*)\.jsonl$/.exec(name);
    if (m) {
      const sdk = join(dir, `sdk-${m[1]}.jsonl`);
      if (existsSync(sdk)) out.push({ sdk, tr: p });
    }
  }
  return out;
}

function report(dir) {
  const acc = {};
  const pairs = findPairs(dir);
  let mode, measuredCR = 0, prefixCR = 0, sessions = 0, dropped = 0;
  if (pairs.length) {
    mode = "precise";
    for (const { sdk, tr } of pairs) {
      const r = attributePrecise(sdk, tr, acc);
      measuredCR += r.measuredCR; prefixCR += r.prefixCR; sessions++;
      dropped += Math.abs(r.sdkN - r.trN);
    }
  } else {
    mode = "modelled";
    // answers.jsonl trace (T)
    const ap = join(dir, "answers.jsonl");
    if (existsSync(ap)) for (const rec of jl(ap)) { if ((rec.trace || []).length) { attributeModelled(rec, acc); sessions++; measuredCR += rec.cache_read || 0; } }
  }

  const rows = Object.entries(acc).map(([tool, v]) => ({ tool, ...v })).sort((a, b) => b.wtok - a.wtok);
  const totW = rows.reduce((s, r) => s + r.wtok, 0) || 1;
  const totN = rows.reduce((s, r) => s + r.naiveTok, 0) || 1;

  const label = dir.split(/[\\/]/).filter(Boolean).pop();
  console.log(`\n# ${label} — persistence-weighted cache_read attribution (${mode}, ${sessions} sessions)`);
  console.log(`| tool | calls | mean B | flat ~tok | flat % | weighted ~tok·turns | weighted % |`);
  console.log(`|---|---|---|---|---|---|---|`);
  for (const r of rows) {
    const mean = Math.round(r.bytes / r.calls);
    console.log(`| ${r.tool} | ${r.calls} | ${mean} | ${ktok(r.naiveTok)} | ${((r.naiveTok / totN) * 100).toFixed(1)}% | ${ktok(r.wtok)} | ${((r.wtok / totW) * 100).toFixed(1)}% |`);
  }
  console.log(`(flat Σ ≈ ${ktok(totN)} tok of results; weighted Σ ≈ ${ktok(totW)} tok·turns of context re-reads)`);
  if (mode === "precise") {
    const varCR = measuredCR - prefixCR;
    console.log(`(measured Σ cache_read = ${ktok(measuredCR)} tok = static prefix ${ktok(prefixCR)} (${(prefixCR / measuredCR * 100).toFixed(0)}%, ` +
      `system+tool-schemas re-read every turn) + variable ${ktok(varCR)} (${(varCR / measuredCR * 100).toFixed(0)}%, tool results + assistant reasoning). ` +
      `weighted-Σ ${ktok(totW)} is the tool-result slice of the variable part.)`);
  } else {
    console.log(`(measured Σ cache_read from answers = ${ktok(measuredCR)} tok; no per-turn log to split prefix/variable — weighted-Σ ${ktok(totW)} is the modelled tool-result slice.)`);
  }
  return { label, rows, totW, mode, measuredCR };
}

const dirs = process.argv.slice(2);
if (!dirs.length) { console.error("usage: tool-cacheread-report.mjs <results-dir> [...]"); process.exit(1); }
const results = dirs.map(report);

// ---- projected saving from abstracting get_blocks (5243 B raw -> 813 B shim view) -------------
const RAW = 5243, ABST = 813; // raw get_blocks mean (T) vs shim asciiSurfaceView mean (C)
console.log(`\n## Projected saving — serve abstracted get_blocks (raw ${RAW}B -> asciiSurfaceView ${ABST}B)`);
console.log(`Saving applies only where get_blocks is served RAW (mean ≳ ${ABST}B). Denominator is measured Σ cache_read (the real bill), not just the tool-result slice.`);
console.log(`| category | get_blocks weighted ~tok·turns | saving if abstracted | as % of category's measured cache_read |`);
console.log(`|---|---|---|---|`);
for (const { label, rows, measuredCR } of results) {
  const gb = rows.find((r) => r.tool === "get_blocks");
  if (!gb) { console.log(`| ${label} | (no get_blocks) | — | — |`); continue; }
  const meanB = gb.bytes / gb.calls;
  if (meanB < ABST * 1.5) { // already abstracted — no saving on the shrink
    console.log(`| ${label} | ${ktok(gb.wtok)} | already abstracted (mean ${Math.round(meanB)}B) | — |`);
    continue;
  }
  const shrink = ABST / meanB;
  const saving = gb.wtok * (1 - shrink);
  console.log(`| ${label} | ${ktok(gb.wtok)} | ${ktok(saving)} (×${(1 - shrink).toFixed(2)}) | ${((saving / measuredCR) * 100).toFixed(1)}% |`);
}
