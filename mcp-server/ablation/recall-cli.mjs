#!/usr/bin/env node
// Run mem_recall probes against a memory dir OFFLINE and score hits properly: a probe hits if any
// returned record matches the pattern directly OR is a block whose LINKED ENTRIES match (blocks
// generalize by design — the fact lives in the L0 entries they cover). Child process of
// micro-embed.mjs; backend fixed by MCPTK_EMBED_BACKEND at import time.
//   env: MCPTK_MEMORY_DIR (required), MCPTK_EMBED_BACKEND (none | unset for default)
//   argv[2]: JSON [{key, query, pattern}]

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { callLocalTool } from "../memory/tools.mjs";

const probes = JSON.parse(process.argv[2]);
const noBridge = async () => { throw new Error("offline"); };
const ROOT = process.env.MCPTK_MEMORY_DIR;

// Entry id → text, from the world's log.jsonl (first world dir in the memory root).
const dirs = (await readdir(ROOT, { withFileTypes: true })).filter((d) => d.isDirectory() && d.name !== "index");
const worldDir = dirs.length ? join(ROOT, dirs[0].name) : null;
const entryText = new Map();
if (worldDir) {
  try {
    for (const line of (await readFile(join(worldDir, "log.jsonl"), "utf8")).split("\n").filter(Boolean)) {
      const rec = JSON.parse(line);
      entryText.set(rec.id, rec.text);
    }
  } catch { /* empty corpus */ }
}

const out = [];
for (const probe of probes) {
  const re = new RegExp(probe.pattern, "i");
  const r = await callLocalTool("mem_recall", { query: probe.query, budget_tokens: 1500 }, noBridge);
  if (!r.ok) {
    out.push({ key: probe.key, query: probe.query, ok: false, error: r.error });
    continue;
  }
  let hit = false;
  let via = null;
  for (const x of r.result.results) {
    if (re.test(`${x.text ?? ""} ${x.prose ?? ""} ${x.outcome ?? ""}`)) {
      hit = true; via = x.links ? "block-prose" : "entry"; break;
    }
    for (const id of x.links?.entries ?? []) {
      if (re.test(entryText.get(id) ?? "")) { hit = true; via = "block-links"; break; }
    }
    if (hit) break;
  }
  const top = r.result.results[0] ?? null;
  out.push({
    key: probe.key, query: probe.query, ok: true, hit, via,
    results_n: r.result.results.length,
    top_channel: top?.channel ?? null,
    top_score: top?.score ?? null,
  });
}
process.stdout.write(JSON.stringify(out));
