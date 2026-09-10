#!/usr/bin/env node
// Embedding micro-ablation (ABLATION_DESIGN, decision rule 4): over the SAME cloned corpus, compare
// D-exact (MCPTK_EMBED_BACKEND=none → structured+lexical only) vs D-hybrid (+semantic). Two query
// classes per planted fact: EXACT (verbatim item words — both backends should hit) and CONCEPT
// (paraphrase with zero lexical overlap with the notes — only the semantic channel can hit).
// Fully offline: local embeddings, no agent, no bridge, no API usage.
//   node ablation/micro-embed.mjs   (auto-discovers interrogation-multi C runs in ablation-results)

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pexec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = join(HERE, "..", "ablation-results");

// Fact → {exact query, concept paraphrase (no shared words with typical notes), match pattern}
const PROBES = [
  { key: "gold", exact: "gold blocks count", concept: "precious yellow metal treasure", pattern: /gold/i },
  { key: "emerald", exact: "emerald blocks", concept: "green gemstone riches", pattern: /emerald/i },
  { key: "hay", exact: "hay bales", concept: "farm animal fodder", pattern: /hay/i },
  { key: "bookshelf", exact: "bookshelf tower height", concept: "library reading furniture", pattern: /bookshel/i },
  { key: "wool", exact: "wool tower", concept: "dyed sheep fleece", pattern: /wool/i },
];

// DECOYS (added 2026-07-20, queue item 3): questions with no answer anywhere in a Minecraft survey
// corpus. Correct behaviour is to return NOTHING. Without this arm the rule is recall-only, and a
// backend that returns every block scores a perfect concept sweep — which is exactly what bge-small
// did on the first run (15/15 concept hits, n=3 every time, and "tax return filing deadline" scoring
// 0.43 against a waypoint-patrol block). A retrieval channel that cannot say "no" is not retrieval.
const DECOYS = [
  "tax return filing deadline",
  "how to bake sourdough bread",
  "symptoms of vitamin D deficiency",
  "JavaScript promise error handling",
  "flight delay compensation policy",
  "medieval French cathedral architecture",
];

async function runBackend(memDir, backend, probeList) {
  const env = { ...process.env, MCPTK_MEMORY_DIR: memDir };
  if (backend === "none") env.MCPTK_EMBED_BACKEND = "none";
  else delete env.MCPTK_EMBED_BACKEND;
  const { stdout } = await pexec(process.execPath, [join(HERE, "recall-cli.mjs"), JSON.stringify(probeList)], {
    env, maxBuffer: 32 * 1024 * 1024, timeout: 300000,
  });
  return JSON.parse(stdout);
}

const dirs = (await readdir(OUT_ROOT, { withFileTypes: true }))
  .filter((d) => d.isDirectory() && /^interrogation-multi-v\d-c-/.test(d.name))
  .map((d) => d.name)
  .sort();
if (!dirs.length) {
  console.error("no interrogation-multi C runs found");
  process.exit(1);
}

const tally = {
  exact: { "d-exact": 0, "d-hybrid": 0, total: 0 },
  concept: { "d-exact": 0, "d-hybrid": 0, total: 0 },
  decoy: { "d-exact": 0, "d-hybrid": 0, total: 0 }, // counts FALSE POSITIVES: lower is better
};
const detail = [];

for (const runName of dirs) {
  const variant = +/-v(\d)-/.exec(runName)[1];
  const scratch = await mkdtemp(join(tmpdir(), "microembed-"));
  await cp(join(OUT_ROOT, runName, "memory"), scratch, { recursive: true });

  const probeList = [
    ...PROBES.flatMap((p) => [
      { key: p.key, cls: "exact", query: p.exact, pattern: p.pattern.source },
      { key: p.key, cls: "concept", query: p.concept, pattern: p.pattern.source },
    ]),
    // Scored on results_n, not the pattern: any result at all is a false positive.
    ...DECOYS.map((q, i) => ({ key: `decoy${i}`, cls: "decoy", query: q, pattern: "(?!)" })),
  ];
  for (const [label, backend] of [["d-exact", "none"], ["d-hybrid", "default"]]) {
    const res = await runBackend(scratch, backend, probeList);
    for (const probe of probeList) {
      const row = res.find((r) => r.key === probe.key && r.query === probe.query);
      if (label === "d-exact") tally[probe.cls].total++; // count each (corpus, probe, class) once
      // Decoys score on "did anything come back at all"; the others on whether the fact was found.
      const scored = probe.cls === "decoy" ? (row?.results_n ?? 0) > 0 : !!row?.hit;
      if (scored) tally[probe.cls][label]++;
      detail.push({
        variant, backend: label, class: probe.cls, key: probe.key,
        hit: !!row?.hit, via: row?.via ?? null, results_n: row?.results_n ?? 0,
        top_channel: row?.top_channel ?? null, top_score: row?.top_score ?? null,
      });
    }
  }
  await rm(scratch, { recursive: true, force: true });
  console.log(`${runName}: done`);
}

console.log(`\n=== micro-ablation (rule 4): same corpora, backend is the only variable ===`);
for (const cls of ["exact", "concept"]) {
  console.log(`${cls.padEnd(8)} queries: d-exact ${tally[cls]["d-exact"]}/${tally[cls].total} hit, d-hybrid ${tally[cls]["d-hybrid"]}/${tally[cls].total} hit`);
}
console.log(`${"decoy".padEnd(8)} queries: d-exact ${tally.decoy["d-exact"]}/${tally.decoy.total} FALSE POSITIVE, d-hybrid ${tally.decoy["d-hybrid"]}/${tally.decoy.total} FALSE POSITIVE (lower is better)`);
console.log(`\nper-probe detail (concept class):`);
for (const d of detail.filter((d) => d.class === "concept")) {
  console.log(`  v${d.variant} ${d.backend.padEnd(8)} ${d.key.padEnd(10)} hit=${d.hit}${d.via ? ` via=${d.via}` : ""} n=${d.results_n}${d.top_channel ? ` top=${d.top_channel}@${typeof d.top_score === "number" ? d.top_score.toFixed(2) : d.top_score}` : ""}`);
}
// The decoy arm is a veto, not a tiebreak: recall bought by answering everything is not recall.
// Half the decoys coming back is the return-everything degenerate case.
console.log(`\nRule 4 verdict: PASS iff d-hybrid > d-exact on concept AND d-hybrid >= d-exact on exact`);
console.log(`                AND d-hybrid admits < half the decoys (a channel that cannot say "no" is not retrieval).`);
const recallOk = tally.concept["d-hybrid"] > tally.concept["d-exact"] && tally.exact["d-hybrid"] >= tally.exact["d-exact"];
const precisionOk = tally.decoy["d-hybrid"] * 2 < tally.decoy.total;
const pass = recallOk && precisionOk;
console.log(`Rule 4: ${pass ? "PASS" : "FAIL"}${recallOk && !precisionOk ? " — recall arm passed, DECOY arm vetoed" : ""}`);
