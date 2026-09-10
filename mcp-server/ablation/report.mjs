#!/usr/bin/env node
// Aggregate ablation-results/results.jsonl into the pre-registered comparisons
// (ABLATION_DESIGN.md §Decision rules). Per-variant rows verbatim — at this n the honest claim is
// "consistent direction", never significance.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] ?? join(HERE, "..", "ablation-results", "results.jsonl");

const rows = (await readFile(file, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
if (!rows.length) {
  console.log("no results yet");
  process.exit(0);
}

// The Agent SDK reports most input under the cache fields — count all input-side tokens.
const tok = (r) => Object.values(r.episodes ?? {}).reduce((s, e) =>
  s + (e.usage?.input_tokens ?? 0) + (e.usage?.cache_creation_input_tokens ?? 0) +
  (e.usage?.cache_read_input_tokens ?? 0) + (e.usage?.output_tokens ?? 0), 0);
const outTok = (r) => Object.values(r.episodes ?? {}).reduce((s, e) => s + (e.usage?.output_tokens ?? 0), 0);
const perception = (r) => Object.values(r.episodes ?? {}).reduce((s, e) => s + (e.tool_counts?.perception ?? 0), 0);

const key = (r) => `${r.scenario}${r.fork_from ? "+fork" : ""}`;
const groups = new Map();
for (const r of rows) {
  const k = key(r);
  if (!groups.has(k)) groups.set(k, new Map());
  const byCond = groups.get(k);
  if (!byCond.has(r.condition)) byCond.set(r.condition, []);
  byCond.get(r.condition).push(r);
}

for (const [scenario, byCond] of groups) {
  console.log(`\n=== ${scenario} ===`);
  console.log("cond  n  success  tokens(med)  out-tok(med)  perception  cost/success(tok)  capped  flags");
  for (const cond of ["a", "b", "c", "d"]) {
    const rs = byCond.get(cond);
    if (!rs) continue;
    const succ = rs.filter((r) => r.success === true).length;
    const toks = rs.map(tok).sort((a, b) => a - b);
    const med = toks[Math.floor(toks.length / 2)];
    const outs = rs.map(outTok).sort((a, b) => a - b);
    const total = toks.reduce((a, b) => a + b, 0);
    const costPerSuccess = succ > 0 ? Math.round(total / succ) : Infinity; // failures stay economically visible
    const capped = rs.filter((r) => Object.values(r.episodes).some((e) => e.capped)).length;
    const flags = rs.flatMap((r) => r.flags ?? []).length;
    console.log(
      `${cond}     ${rs.length}  ${succ}/${rs.length}      ${med}       ${outs[Math.floor(outs.length / 2)]}         ` +
      `${Math.round(rs.reduce((s, r) => s + perception(r), 0) / rs.length)}          ${costPerSuccess === Infinity ? "∞" : costPerSuccess}            ${capped}       ${flags}`,
    );
  }
  // Per-variant rows (paired comparisons happen within a variant).
  console.log("  per-variant:");
  for (const cond of ["a", "b", "c", "d"]) {
    for (const r of byCond.get(cond) ?? []) {
      console.log(`    v${r.variant} ${cond}: success=${r.success} tokens=${tok(r)} ` +
        `${r.metrics?.facts_exact !== undefined ? `facts=${r.metrics.facts_exact}/4 ` : ""}` +
        `${r.metrics?.stale_assumptions_total !== undefined ? `stale=${r.metrics.stale_assumptions_total} verify=${JSON.stringify(r.metrics.verification_attempt)} ` : ""}` +
        `${r.metrics?.acquisition ? `acq=${r.metrics.acquisition.calls_before} ` : ""}` +
        `${(r.flags ?? []).length ? `flags=${JSON.stringify(r.flags)}` : ""}`);
    }
  }
}
console.log("\nDecision rules live in ABLATION_DESIGN.md — read the numbers against them verbatim.");
