// Probe for WHICH PROJECT `launch_game` LAUNCHES (RELEASE_1.md §B0 step 3).
//
// The failure being closed: local/dev.mjs derived its build root from where the SHIM IS INSTALLED,
// and every repo in this workspace registers the same mcmodding/mcp-server/index.mjs — so from
// menagerie's session `launch_game` sat in the manifest looking like it belonged there and cycled
// THE TOOLKIT's game. rebuild.ps1 could not have been told otherwise: -Project was an enum of two
// values dev.mjs never passed.
//
// The resolution reads the PORT, because §B0 already made the port the project constant. That is
// what this probe pins: not "it returns a directory" but WHICH directory, and — the half that
// matters — that an undecidable answer is a REFUSAL rather than a plausible default. Case 5 is the
// load-bearing one; without a tree where two roots claim one port, every other case here is green
// against a rule that could equally be "pick the first".
//
// Two arbiters on purpose. The synthetic trees own the rules (they can hold shapes this workspace
// does not, and they do not drift when a sibling checkout is renamed); the real workspace owns the
// regression (case 9 fails if the actual menagerie session ever resolves to the toolkit again).
//
// Pure: no bridge, no game, no world write. Battery chunk a.

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveLaunchProject, declaredPort, sessionRoot } from "../local/project.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOME = dirname(REPO_ROOT);

const scratch = mkdtempSync(join(tmpdir(), "mcptk-project-"));
after(() => { try { rmSync(scratch, { recursive: true, force: true }); } catch { /* windows lock */ } });

/**
 * A Gradle root on disk. `port` null declares no mcmod.port, i.e. it takes the dev default — which
 * is the state mcp-toolkit itself is in, and the state that makes ambiguity possible.
 * `loom` false makes a root that is NOT a game (gradle-conventions is exactly this).
 */
function makeRoot(dir, { port = null, loom = true, wrapper = true } = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.gradle"), `rootProject.name = 'x'\n`);
  writeFileSync(join(dir, "build.gradle"),
    loom ? "plugins { id 'net.fabricmc.fabric-loom' version '1.17-SNAPSHOT' }\n"
         : "plugins { id 'groovy-gradle-plugin' }\n");
  if (wrapper) writeFileSync(join(dir, "gradlew.bat"), "@echo off\n");
  if (port !== null) writeFileSync(join(dir, "gradle.properties"), `mcmod.port=${port}\n`);
  return dir;
}

// ws/                 (the "home" the shim's checkout sits in)
//   hub/              25599 by omission — stands in for mcp-toolkit's checkout, and is `repoRoot`
//     tools/          a non-root subdirectory, so the walk-up has something to walk
//     plugin/         a Gradle root that is NOT Loom — must never be a candidate
//     nested/         25599 by omission too: the hub family is ambiguous on the default port
//   alpha/            25801
//   beta/             25802
//   twin/             25802 as well — the workspace-wide ambiguity, deliberately outside hub
const ws = join(scratch, "ws");
const hub = makeRoot(join(ws, "hub"), { port: null });
const hubTools = join(hub, "tools");
mkdirSync(hubTools, { recursive: true });
const plugin = makeRoot(join(hub, "plugin"), { port: null, loom: false });
const nested = makeRoot(join(hub, "nested"), { port: null });
const alpha = makeRoot(join(ws, "alpha"), { port: 25801 });
const beta = makeRoot(join(ws, "beta"), { port: 25802 });
const twin = makeRoot(join(ws, "twin"), { port: 25802 });

const R = (port, cwd, env = {}) => resolveLaunchProject({ port, cwd, repoRoot: hub, env });

describe("launch_game project resolution", { concurrency: 1 }, () => {
  test("1. a session in its own repo gets its own repo", () => {
    const r = R(25801, alpha);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.dir, alpha);
  });

  test("2. and NOT the shim's checkout — the regression this closes", () => {
    const r = R(25801, alpha);
    assert.notEqual(r.dir, hub);
  });

  test("3. a nested root is a separate game from the root that contains it", () => {
    // The hub family holds two roots on the default port; cwd is inside hub, so tier 1 is ambiguous
    // and the tiebreak (inside repoRoot) has to choose. Both are inside it, so this must REFUSE —
    // the shape mcmodding would have if villagejobs had never declared 25640.
    const r = R(25599, hubTools);
    assert.equal(r.ok, false, `expected a refusal, got ${r.dir}`);
    assert.match(r.error, /undecidable/);
    assert.ok(r.error.includes(hub) && r.error.includes(nested), r.error);
  });

  test("4. declaring a port is what separates them", () => {
    writeFileSync(join(nested, "gradle.properties"), "mcmod.port=25803\n");
    try {
      assert.equal(declaredPort(nested), 25803);
      assert.equal(R(25599, hubTools).dir, hub, "the undeclared root now owns the default alone");
      assert.equal(R(25803, hubTools).dir, nested);
    } finally {
      writeFileSync(join(nested, "gradle.properties"), "");
    }
  });

  test("5. two roots on one port is REFUSED, not guessed — the falsifier", () => {
    const r = R(25802, join(ws, "nowhere"));
    assert.equal(r.ok, false, `expected a refusal, got ${r.dir}`);
    assert.ok(r.error.includes(beta) && r.error.includes(twin), r.error);
  });

  test("6. a refusal names the fix and every candidate's port", () => {
    const r = R(25802, join(ws, "nowhere"));
    assert.match(r.error, /mcmod\.port/);
    assert.match(r.error, /MCPTK_URL/);
    assert.match(r.error, /MCPTK_PROJECT_DIR/);
    for (const [dir, port] of [[alpha, 25801], [beta, 25802], [twin, 25802]]) {
      assert.ok(r.error.includes(dir), `candidate ${dir} not listed`);
      assert.ok(r.candidates.some((c) => c.dir === dir && c.port === port), `${dir} not reported as ${port}`);
    }
  });

  test("7. a port nobody declares is refused too", () => {
    const r = R(25899, alpha);
    assert.equal(r.ok, false);
    assert.match(r.error, /no project in this workspace declares bridge port 25899/);
  });

  test("8. a Gradle root that is not a game is never a candidate", () => {
    // `plugin` sits inside hub and declares no port, so it would be a THIRD claimant on 25599 if
    // "has a settings.gradle" were the test. gradle-conventions is exactly this shape.
    const r = R(25599, hubTools);
    assert.ok(!r.error.includes(plugin), `a non-Loom root was offered as a candidate:\n${r.error}`);
  });

  test("9. a wrapper-less root is not launchable either", () => {
    const bare = makeRoot(join(ws, "bare"), { port: 25804, wrapper: false });
    const r = R(25804, join(ws, "nowhere"));
    assert.equal(r.ok, false, `expected a refusal, got ${r.dir}`);
    assert.ok(!r.error.includes(bare), `a root with no gradlew was offered:\n${r.error}`);
    rmSync(bare, { recursive: true, force: true });
  });

  test("10. MCPTK_PROJECT_DIR ends the search, and a bad one is refused", () => {
    assert.equal(R(25801, alpha, { MCPTK_PROJECT_DIR: beta }).dir, beta);
    const bad = R(25801, alpha, { MCPTK_PROJECT_DIR: join(ws, "nowhere") });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /not a Gradle root/);
  });

  test("11. cwd outside any checkout falls back to the shim's own — the old behaviour, demoted", () => {
    // Tier 1 finds nothing, tier 2 is ambiguous on the default port, and the tiebreak picks the
    // candidate inside repoRoot. Two are, so this refuses; with one it resolves.
    rmSync(nested, { recursive: true, force: true });
    const r = R(25599, join(ws, "nowhere"));
    assert.equal(r.ok, true, r.error);
    assert.equal(r.dir, hub);
    makeRoot(nested, { port: null });
  });
});

describe("launch_game resolution against the real workspace", { concurrency: 1 }, () => {
  const live = (port, cwd) => resolveLaunchProject({ port, cwd, repoRoot: REPO_ROOT, env: {} });

  test("12. this checkout's default port is the toolkit, not the mod at its top level", () => {
    const r = live(25599, REPO_ROOT);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.dir, join(REPO_ROOT, "mcp-toolkit"));
  });

  test("13. the workbench root is not a game: a session there resolves to the toolkit", () => {
    // Until 2026-09-06 the root was villagejobs' build on 25640; that mod is a sibling checkout now
    // (case 14) and the root is a bare settings.gradle, so the walk-up lands on it and the one
    // launchable root inside it is the answer.
    const r = live(declaredPort(REPO_ROOT), REPO_ROOT);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.dir, join(REPO_ROOT, "mcp-toolkit"));
  });

  test("14. a sibling checkout's session gets its own game", (t) => {
    // The concrete regression. Skipped rather than failed when a sibling is not checked out here —
    // the rule is pinned by the synthetic cases above; this one pins the actual workspace.
    let checked = 0;
    for (const name of ["menagerie", "rocketeer", "nijntje", "villagejobs"]) {
      const repo = join(HOME, name);
      if (!existsSync(join(repo, "settings.gradle"))) continue;
      const port = declaredPort(repo);
      assert.notEqual(port, 25599, `${name} declares no mcmod.port — it would collide with the toolkit`);
      const r = live(port, repo);
      assert.equal(r.ok, true, r.error);
      assert.equal(r.dir, repo, `a ${name} session resolves to ${r.dir}`);
      checked++;
    }
    if (checked === 0) t.skip("no sibling checkout beside this one");
  });

  test("15. the walk-up finds the checkout from a subdirectory of it", () => {
    assert.equal(sessionRoot(join(REPO_ROOT, "mcp-server", "probes")), REPO_ROOT);
  });
});
