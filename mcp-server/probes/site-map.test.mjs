// The one invariant every other probe file assumes and none of them can check alone: A PROBE FILE
// OWNS ITS SITE. `node --test probes/*.test.mjs` runs the files CONCURRENTLY, so two files sharing a
// coordinate stage on top of each other — one file's `fill … air` deletes the block another is
// mid-dig on, one file's zombie hunts another file's player body. The damage is a race, so it
// surfaces as a DIFFERENT assertion failing each run, in the victim file, with nothing wrong in it.
//
// That has now cost three debugging sessions (player-body on walker-caps' courses; player-hands'
// dig-timing test, blamed on a nav change that had not touched the reach path). This test is the
// cheap check that ends the class: it is static — no bridge, no dev server, no world — and it fails
// loudly at authoring time instead of quietly at 3am in a 33-file battery.
//
// Heuristic, stated plainly: any integer >= 1e6 in a probe file is a site coordinate. That holds
// because probe sites live in the millions and nothing else in these files is that large; site
// coordinates named in PROSE are written "3.48M", which this does not match. If a future probe
// needs a large non-coordinate literal, exempt it here rather than loosening the rule.
//
// The scan covers probes/*.test.mjs AND world-model/tools/**/*.mjs — see "THE RESERVATION HALF"
// below for why the second tree is folded in as a single owner rather than file by file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SELF = "site-map.test.mjs";

// The probe directory is not the only thing that stages geometry in this world. `world-model/tools/`
// holds two drivers that claim sites of their own — the combat clinic's 6,000,000 (clinic/site.mjs)
// and curriculum.mjs's 1,850,000 — and until this scan existed both were reserved by nothing but a
// comment in a design document. A probe author looking for a free coordinate reads THIS file to
// find out what is taken, so a site this file cannot see is a site it will happily hand out twice.
const TOOLS = resolve(HERE, "..", "..", "world-model", "tools");

// Vanilla's world border: `WorldBorder.java:23` MAX_CENTER_COORDINATE = 2.9999984E7, and
// `:37` absoluteMaxSize = 29999984. A literal past it cannot be a block coordinate, so it cannot be
// a site — which is the exemption the tools scan needs and the probe scan does not. Those files are
// not probe files: spear-plan.mjs carries IEEE-754 tails (0.9199999999999999), taskgen.mjs carries
// 2^32, and the ≥1e6 digit-run heuristic reads the digits of both as coordinates.
const WORLD_BORDER = 29_999_984;

// THE EXEMPTIONS, NAMED ONE AT A TIME. The header's rule is that a large literal in a probe file is
// a site, and it says what to do when one is not: exempt it HERE rather than loosen the heuristic.
// This is that list, and its shape is deliberate — file AND value, never a bare value — so an
// exemption covers the one literal somebody looked at and cannot silently spread to a real
// coordinate that happens to share its digits.
//
// `loot-roll` was the first: `random value 1..1000000` is a range for vanilla's RNG command, and it
// collided with perception-coverage's genuine 1,000,000 site. Two files, and only one of them was
// ever in that world.
const EXEMPT = [
  { file: "loot-roll.test.mjs", value: 1_000_000,
    why: "`random value 1..1000000` — the RNG command's range, not a place" },
];

/** Every integer >= 1e6 written in `src`, underscore separators allowed, minus `file`'s exemptions. */
function sitesIn(src, file) {
  const exempt = new Set(EXEMPT.filter((e) => e.file === file).map((e) => e.value));
  const found = new Set();
  for (const m of src.matchAll(/\b\d[\d_]{5,}\b/g)) {
    const n = Number(m[0].replaceAll("_", ""));
    if (Number.isFinite(n) && n >= 1e6 && !exempt.has(n)) found.add(n);
  }
  return found;
}

// THE EXEMPTION LIST'S OWN FALSIFIER. This guard's failure mode is the cheap one: a red goes green
// by adding a line to EXEMPT, and nothing above would ever notice that the line stopped describing
// anything. So every exemption must still find its literal in its file — a stale entry is a hole
// that silently reserves nothing, and it is DELETED rather than carried.
test("every site exemption still describes a literal that is really there", () => {
  for (const e of EXEMPT) {
    const path = join(HERE, e.file);
    assert.ok(existsSync(path), `exemption names ${e.file}, which no longer exists — delete it`);
    const src = readFileSync(path, "utf8");
    const digits = String(e.value);
    const present = [...src.matchAll(/\b\d[\d_]{5,}\b/g)]
      .some((m) => m[0].replaceAll("_", "") === digits);
    assert.ok(present, `${e.file} no longer contains ${e.value.toLocaleString("en-US")} ` +
      `(${e.why}) — the exemption reserves nothing now, so delete it`);
  }
});

/** Every `.mjs` under `dir`, recursively. */
function mjsUnder(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) mjsUnder(p, out);
    else if (e.name.endsWith(".mjs")) out.push(p);
  }
  return out;
}

test("no two probe files stage on the same site, and world-model/tools' sites are reserved", () => {
  const files = readdirSync(HERE).filter((f) => f.endsWith(".test.mjs") && f !== SELF);
  assert.ok(files.length > 1, `the probe directory should hold probe files (found ${files.length})`);

  const owners = new Map(); // coordinate -> [file, …]
  for (const f of files) {
    for (const site of sitesIn(readFileSync(join(HERE, f), "utf8"), f)) {
      owners.set(site, [...(owners.get(site) ?? []), f]);
    }
  }

  // THE RESERVATION HALF. `world-model/tools/**` is folded in as ONE owner, not one per file, and
  // that difference is the whole design (COMBAT_CLINIC.md D-9). Probe files run CONCURRENTLY and so
  // must not share a coordinate with each other; the clinic's modules are one instrument and share
  // 6,000,000 deliberately — site.mjs declares it, arena.test.mjs and metrics.test.mjs assert
  // against it. Collapsing them means a coordinate is reported shared only when a PROBE file also
  // claims it, which is the collision that actually costs a night of debugging.
  assert.ok(existsSync(TOOLS), `world-model/tools not found at ${TOOLS} — this scan resolves it ` +
    "from the probe directory, and a path that misses reserves NOTHING while still passing");
  const OWNER = "world-model/tools/** (the clinic + curriculum: one instrument, one owner)";
  const toolsFiles = new Map(); // coordinate -> [tools-relative path, …], for the failure message
  for (const p of mjsUnder(TOOLS)) {
    for (const site of sitesIn(readFileSync(p, "utf8"), relative(TOOLS, p))) {
      if (site > WORLD_BORDER) continue;                       // not a coordinate; see the header
      const held = owners.get(site) ?? [];
      if (!held.includes(OWNER)) owners.set(site, [...held, OWNER]);
      toolsFiles.set(site, [...(toolsFiles.get(site) ?? []), relative(TOOLS, p).replace(/\\/g, "/")]);
    }
  }

  const shared = [...owners.entries()].filter(([, fs]) => fs.length > 1);
  assert.deepEqual(shared, [], shared.length === 0 ? "" :
    "these coordinates are claimed by more than one owner, and the battery runs files " +
    "concurrently — give each file its own site:\n" +
    shared.map(([site, fs]) => {
      const inTools = toolsFiles.get(site);
      return `  ${site.toLocaleString("en-US")} — ${fs.join(", ")}` +
        (inTools ? `\n      (in tools: ${[...new Set(inTools)].join(", ")})` : "");
    }).join("\n"));
});
