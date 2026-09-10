#!/usr/bin/env node
// One-pass analysis dump over results.jsonl for ABLATION_RESULTS.md: per-scenario condition tables
// with the metrics each pre-registered rule needs, honest-success (resurvey-corrected), resume-build
// checkpoint pressure, and cost aggregates. Mechanical only — verdict prose is written by hand.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const rows = (await readFile(join(HERE, "..", "ablation-results", "results.jsonl"), "utf8"))
  .replace(/^﻿/, "")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l.replace(/^﻿/, "")));

const inTok = (e) => (e?.usage?.input_tokens ?? 0) + (e?.usage?.cache_creation_input_tokens ?? 0) + (e?.usage?.cache_read_input_tokens ?? 0);
const totTok = (r) => Object.values(r.episodes ?? {}).reduce((s, e) => s + inTok(e) + (e.usage?.output_tokens ?? 0), 0);
const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? null;

const byScenario = new Map();
for (const r of rows) {
  const k = r.scenario + (r.fork_from ? "+fork" : "");
  if (!byScenario.has(k)) byScenario.set(k, []);
  byScenario.get(k).push(r);
}

for (const [scen, rs] of [...byScenario.entries()].sort()) {
  console.log(`\n### ${scen} (${rs.length} rows)`);
  for (const cond of ["a", "b", "c", "d"]) {
    const cs = rs.filter((r) => r.condition === cond);
    if (!cs.length) continue;
    const succ = cs.filter((r) => r.success).length;
    const resurveyed = cs.filter((r) => (r.flags ?? []).some((f) => f.startsWith("resurveyed"))).length;
    const honest = cs.filter((r) => r.success && !(r.flags ?? []).some((f) => f.startsWith("resurveyed"))).length;
    const toks = med(cs.map(totTok));
    const bits = [`${cond}: ${succ}/${cs.length} pass`];
    if (resurveyed) bits.push(`honest ${honest}/${cs.length} (resurveyed:${resurveyed})`);
    bits.push(`medTok ${Math.round(toks / 1000)}k`);
    if (cs[0].metrics?.acquisition !== undefined) bits.push(`acq [${cs.map((r) => r.metrics?.acquisition?.calls_before ?? "-").join(",")}]`);
    if (cs[0].metrics?.facts_exact !== undefined) bits.push(`facts [${cs.map((r) => r.metrics.facts_exact).join(",")}]`);
    if (cs[0].metrics?.retrieval_calls) bits.push(`recall/read [${cs.map((r) => `${r.metrics.retrieval_calls.mem_recall}/${r.metrics.retrieval_calls.mem_read}`).join(",")}]`);
    if (cs[0].metrics?.stale_assumptions_total !== undefined) {
      bits.push(`stale [${cs.map((r) => r.metrics.stale_assumptions_total).join(",")}]`, `contradiction [${cs.map((r) => r.metrics.contradiction_recorded ? 1 : 0).join(",")}]`);
    }
    if (cs[0].metrics?.correct_after_e1 !== undefined) {
      bits.push(`e1done [${cs.map((r) => r.metrics.correct_after_e1).join(",")}]`, `delta [${cs.map((r) => r.metrics.e2_delta).join(",")}]`, `specStored [${cs.map((r) => r.metrics.spec_stored ? 1 : 0).join(",")}]`);
    }
    if (cs[0].metrics?.markers_placed !== undefined) bits.push(`placed [${cs.map((r) => r.metrics.markers_placed).join(",")}]`, `reported [${cs.map((r) => r.metrics.reported_exact).join(",")}]`);
    console.log("  " + bits.join("  "));
  }
}

// Rule 6 economics: cost per successful task per condition, pooled over the memory-relevant scenarios.
console.log(`\n### economics (pooled, non-fork rows): total input-side tokens / successes`);
for (const cond of ["a", "b", "c", "d"]) {
  const cs = rows.filter((r) => !r.fork_from && r.condition === cond);
  const total = cs.reduce((s, r) => s + totTok(r), 0);
  const succ = cs.filter((r) => r.success).length;
  console.log(`  ${cond}: ${Math.round(total / 1e6)}M tok, ${succ}/${cs.length} pass, ${succ ? Math.round(total / succ / 1000) + "k/success" : "∞"}`);
}
console.log(`\nresume-build E1-completion check (was there resume pressure?):`);
const rb = rows.filter((r) => r.scenario === "resume-build");
console.log(`  cells with e1 build already complete (10/10): ${rb.filter((r) => r.metrics?.correct_after_e1 === 10).length}/${rb.length}`);
