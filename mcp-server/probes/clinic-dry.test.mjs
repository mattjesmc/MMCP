// The combat clinic's IMPORT-TIME SMOKE (world-model/COMBAT_CLINIC.md §9.2). Two assertions, no
// bridge, no world, no model spend: `combat-clinic.mjs --dry --panel baseline` exits 0, and it
// prints a non-zero cell count.
//
// WHY THIS FILE EXISTS AT ALL, which is not obvious from what it asserts:
//
// `tools/battery.ps1` runs each probe file with `node --test probes/<f>` and then regex-scrapes its
// TAP output — `if ($output -match '(?m)^# pass (\d+)') { $pass = [int]$Matches[1] }` — with `$pass`
// and `$fail` INITIALISED TO 0 (battery.ps1:92-94). Node prints no `# fail` line at all for a file
// that never got as far as running a test. So a clinic whose driver dies at import time (a renamed
// module, a fixtures directory that moved, a syntax error in a module nobody imports directly)
// contributes `# pass 0 # fail 0`, the battery adds zero to both totals, and the run reports
// GREEN. The whole instrument can be broken and the arbiter says nothing.
//
// The defence is a file that contributes a KNOWN NON-ZERO pass count. §9.2 calls that the receipt:
// read the number in the log, and if `clinic-dry => # pass 0 # fail 0` ever appears, the clinic did
// not run — it did not pass. That is the reading this file buys, and it is the reason the count of
// tests here is small and fixed.
//
// The driver is spawned as a SUBPROCESS rather than imported, deliberately. An import would run in
// this test's process, where a `process.exit` inside the driver kills the runner and an import-time
// throw is caught by node:test and reported as an ordinary assertion failure — both of which hide
// the exact class of breakage the file is here to catch. A subprocess gives us the real exit code.
//
// HARD RULE (§9.2), stated where a future edit would break it: NO clinic file in probes/ may ever
// call `wm_session_tag`. `battery.ps1` stamps the live session `purpose=battery` before running
// anything; a probe stamping `bench` retags it, sets `purpose_conflict`, and leaves a permanent
// black mark on the very manifest it is testing (`wm-rblock.test.mjs:26-28`). `--dry` makes no
// bridge call of any kind, which is what makes running the driver from here legal.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// battery.ps1 pushes into mcp-server/ before spawning node, and `npm run test:live` runs from
// somewhere else again — so the driver is resolved from THIS FILE's location, never from cwd.
const DRIVER = resolve(HERE, "..", "..", "world-model", "tools", "combat-clinic.mjs");

/** Run the driver and hand back everything a failure would need to be diagnosed from the log. */
function runDriver(args) {
  const r = spawnSync(process.execPath, [DRIVER, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    // A driver that ever waits on stdin would hang the battery for its whole timeout and then be
    // reported as a failure with no output. Close it: `--dry` must not be interactive.
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    ...r,
    detail: `\n--- argv: ${args.join(" ")}\n--- stdout ---\n${r.stdout ?? ""}` +
      `\n--- stderr ---\n${r.stderr ?? ""}`,
  };
}

test("the driver is where the probe thinks it is", () => {
  // Separated from the run so the two failures read differently. A missing file makes the two
  // assertions below fail with node's own "Cannot find module", which looks like a clinic bug and
  // is in fact a path bug in THIS file — the same misrouted-root defect the conformance ratchet's
  // sanity floor guards against, arriving through the other door.
  assert.ok(existsSync(DRIVER), `combat-clinic.mjs not found at ${DRIVER} — this probe resolves ` +
    "it from its own location; if the tree moved, fix the path here rather than the driver");
  assert.ok(existsSync(join(dirname(DRIVER), "clinic", "panels.mjs")),
    "clinic/panels.mjs is missing — the driver would exit non-zero for a reason that has nothing " +
    "to do with the panel registry it is being asked about");
});

test("--dry --panel baseline exits 0", () => {
  const r = runDriver(["--dry", "--panel", "baseline"]);
  assert.equal(r.error ?? null, null, `the driver could not be spawned${r.detail}`);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status} (signal ${r.signal})${r.detail}`);
});

test("--dry --panel baseline prints a non-zero cell count", () => {
  const r = runDriver(["--dry", "--panel", "baseline"]);
  const m = /^cells: (\d+)$/m.exec(r.stdout ?? "");
  assert.ok(m, `no machine-readable "cells: <n>" line in the dry output — the driver may have ` +
    `printed a table and no parseable count${r.detail}`);
  const n = Number(m[1]);
  assert.ok(n > 0, `the baseline panel resolved to ${n} cells. A panel that resolves to zero cells ` +
    "is a sitting that measures nothing and exits 0, which is precisely the silent success this " +
    `file exists to refuse${r.detail}`);
});
