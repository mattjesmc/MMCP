// Bench CONFORMANCE ratchet as a test (FREEZE_PLAN Workstream A1, Gate G1's first criterion).
//
// Offline — no bridge, no model spend. Holds the whole testbench-results/ corpus to the instrument's
// join contract: every scored row classifies to exactly one registry unit, no two units' `match`
// collide on a row, and every unit a manifest selected that produced rows had them scored. A new
// bench that lands rows the registry can't classify — or a scorer that can't score its own unit —
// reddens this the day it ships. See testbench/ratchet.mjs for the engine and the allowlist.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ratchet } from "../testbench/ratchet.mjs";

const r = ratchet(); // all result dirs

test("(a) every scored row joins exactly one unit — no orphans", () => {
  const offenders = r.dirs.filter((d) => d.orphans.length);
  assert.equal(r.totals.orphans, 0,
    `orphan rows the reports would silently drop:\n` +
    offenders.map((d) => `  [${d.dir}] ${d.orphans.map((o) => `${o.id}{${o.keys.join(",")}}`).join("; ")}`).join("\n"));
});

test("(c) no two units' match accept the same row — no collisions", () => {
  assert.equal(r.totals.collisions, 0,
    `colliding unit pairs (double-counted rows):\n  ` +
    [...r.collisionPairs].map(([p, n]) => `[${p}] × ${n}`).join("\n  "));
});

test("(b) every selected unit that produced rows had ≥1 scored (no accessor defect)", () => {
  const bad = r.dirs.filter((d) => d.coverage.unscorable?.length);
  assert.equal(r.totals.bUnscorable, 0,
    `units whose rows their own scorer can't score:\n` +
    bad.map((d) => `  [${d.dir}] ${d.coverage.unscorable.join(", ")}`).join("\n"));
});

test("the corpus ratchets green as a whole", () => {
  assert.ok(r.pass, `ratchet failures:\n  - ${r.failures.join("\n  - ")}`);
  // Sanity: the ratchet actually looked at the corpus (guards against an empty/misrouted results root).
  assert.ok(r.totals.rows > 500, `expected the full corpus, saw only ${r.totals.rows} rows`);
});
