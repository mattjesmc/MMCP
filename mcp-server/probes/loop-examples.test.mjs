// The SHIPPED loop examples, resolved against the live manifest and actually executed.
//
// WHY THIS FILE EXISTS (TODO.md 1.8). `tools/loop/examples/armorpieces.loop.json` shipped from
// 0.122.0 to 0.139.0 naming thirteen tools of a plugin that had been replaced, missing the ten that
// replaced them, silently re-adding the one tool `art` excludes on purpose, and pointing its `run`
// at a script that existed in nobody's tree. Every pin in this directory was green throughout:
// blockbench-surface.test.mjs pins BLOCKBENCH_KEEP against the plugin's captured manifest and
// reaches nothing under tools/loop/examples/, so the one file a modder COPIES was the only part of
// the surface nothing checked. A generic example rots exactly the same way the next time the
// plugin's tool list moves, so the example is checked the way the profile is:
//
//   1. Every example loads, and every script its `run` names ships beside it.
//   2. Its keep-list IS the served set, against both pinned manifests - no ghost names (loud on
//      stderr but nothing fails), no tool it meant to keep and misspelt (silent), and none of the
//      deliberate exclusions put back.
//   3. Its gate names a tool this shim serves, so it is a guard and not a line in a file.
//   4. The checker it ships runs, answers the contract, and its problems reach the gate: an
//      exported model with a problem in it REFUSES push_asset, and stops refusing when it is fixed.
//
// No game, no Blockbench: both upstreams are the pinned captures. Run:
//   node --test probes/loop-examples.test.mjs

import { test } from "node:test";
import assert from "node:assert";
import { readdirSync, readFileSync, writeFileSync, copyFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { deflateSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { startStubBridge, startStubBlockbench, spawnShim, HERE } from "./loop-harness.mjs";
import { loadLoop } from "../loop/loop.mjs";

const EXAMPLES = join(HERE, "..", "..", "mcp-toolkit", "tools", "loop", "examples");
const MANIFEST = JSON.parse(readFileSync(join(HERE, "fixtures", "manifest-2026-09-06.json"), "utf8"));
const BB_TOOLS = JSON.parse(readFileSync(join(HERE, "fixtures", "blockbench-bridge-2026-09-07.json"), "utf8"));

const examples = readdirSync(EXAMPLES).filter((f) => f.endsWith(".loop.json")).sort();
const shipped = new Set(readdirSync(EXAMPLES));
// A `run` argument that names a SCRIPT - what `tools/check_active.py` was. Directory arguments
// (`--assets src/main/resources/assets`) name a place in the modder's tree, not in ours, and are
// deliberately not checked here; the checker itself is what reports one that is not there.
const isScript = (s) => /\.(mjs|cjs|js|py|ps1|sh)$/.test(s);

/** A valid PNG of `w` x `h` transparent pixels, so the checker's IHDR read has something real. */
function png(w, h) {
  const chunk = (type, data) => {
    const b = Buffer.alloc(8 + data.length + 4);
    b.writeUInt32BE(data.length, 0);
    b.write(type, 4);
    data.copy(b, 8);
    b.writeUInt32BE(0, 8 + data.length); // CRC: nothing here verifies it
    return b;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.alloc((w * 4 + 1) * h))), chunk("IEND", Buffer.alloc(0)),
  ]);
}

const GOOD_MODEL = {
  textures: { all: "mymod:block/crate", particle: "#all" },
  elements: [{
    name: "body", from: [0, 0, 0], to: [16, 16, 16],
    faces: Object.fromEntries(["north", "south", "east", "west", "up", "down"].map((f) => [f, { texture: "#all" }])),
  }],
};
// One problem, and one an author can actually fix from Blockbench: 34 is past Minecraft's 32.
const BAD_MODEL = JSON.parse(JSON.stringify(GOOD_MODEL));
BAD_MODEL.elements[0].to = [16, 34, 16];

/** A workspace with an example copied in as a modder would copy it, plus a mod's resource tree. */
function workspace(exampleFile, model) {
  const root = mkdtempSync(join(tmpdir(), "mcptk-loop-examples-"));
  mkdirSync(join(root, ".mcptoolkit"));
  copyFileSync(join(EXAMPLES, exampleFile), join(root, ".mcptoolkit", "loop.json"));
  for (const f of shipped) if (f.endsWith(".mjs")) copyFileSync(join(EXAMPLES, f), join(root, ".mcptoolkit", f));
  const assets = join(root, "src", "main", "resources", "assets", "mymod");
  mkdirSync(join(assets, "models", "block"), { recursive: true });
  mkdirSync(join(assets, "textures", "block"), { recursive: true });
  writeFileSync(join(assets, "textures", "block", "crate.png"), png(16, 16));
  if (model) writeFileSync(join(assets, "models", "block", "crate.json"), JSON.stringify(model, null, 2));
  return { root, model: join(assets, "models", "block", "crate.json") };
}

test("every shipped example loads, and every script its `run` names ships beside it", () => {
  assert.ok(examples.length, `no *.loop.json under ${EXAMPLES}`);
  for (const file of examples) {
    const loop = loadLoop(join(EXAMPLES, file)); // throws on a malformed file
    assert.ok(loop, file);
    for (const c of loop.checks) {
      if (!c.run) continue;
      const named = c.run.filter(isScript);
      assert.ok(named.length, `${file}: check "${c.name}" runs ${c.run[0]} with no script; a modder cannot copy that`);
      for (const arg of named) {
        assert.ok(shipped.has(basename(arg)),
          `${file}: check "${c.name}" runs "${arg}", and ${basename(arg)} does not ship in ${EXAMPLES} - `
          + `a modder who copies the loop file copies a check that cannot run (this is exactly what `
          + `tools/check_active.py was)`);
      }
    }
    console.log(`  ${file}: ${loop.checks.length} check(s), ${loop.profile?.keep?.size ?? 0} kept, `
      + `${Object.keys(loop.profile?.notes ?? {}).length} note(s)`);
  }
});

test("the example's checker answers the contract: ok, problems, and nothing exported yet", () => {
  const script = join(EXAMPLES, "check-block-model.mjs");
  const run = (root, args) => {
    const out = execFileSync(process.execPath, [script, "--assets", "src/main/resources/assets", "--json", ...args],
      { cwd: root, encoding: "utf8" });
    const last = out.trim().split("\n").filter((l) => l.trim()).pop();
    const report = JSON.parse(last);
    assert.strictEqual(typeof report.text, "string", `the last line must carry "text": ${last}`);
    assert.strictEqual(typeof report.problems, "number", `the last line must carry "problems": ${last}`);
    return report;
  };

  const ok = run(workspace("block-model.loop.json", GOOD_MODEL).root, ["--unit", "crate"]);
  assert.strictEqual(ok.problems, 0, ok.text);
  assert.match(ok.text, /crate: 1 element\(s\), 6 face\(s\), 1 sheet\(s\) - ok/);

  const bad = run(workspace("block-model.loop.json", BAD_MODEL).root, ["--unit", "crate"]);
  assert.strictEqual(bad.problems, 1, bad.text);
  assert.match(bad.text, /to\.y 34 is outside Minecraft's -16\.\.32/, bad.text);

  // Nothing exported yet is a NOTE, not a problem: before the first export there is nothing to
  // judge, and a problem here would gate the push over an empty directory.
  const none = run(workspace("block-model.loop.json", null).root, ["--unit", "crate"]);
  assert.strictEqual(none.problems, 0, none.text);
  assert.strictEqual(none.notes, 1, none.text);
  assert.match(none.text, /not exported yet/);

  // The checker pointed at a tree with no assets in it is LOUD rather than clean - the failure it
  // must never present as "nothing wrong".
  const lost = JSON.parse(execFileSync(process.execPath, [script, "--assets", "nope/nowhere", "--json"],
    { cwd: workspace("block-model.loop.json", GOOD_MODEL).root, encoding: "utf8" }).trim().split("\n").pop());
  assert.strictEqual(lost.problems, 1, lost.text);
  assert.match(lost.text, /cannot see the assets/);
});

for (const file of examples) {
  test(`${file}: its keep-list is the served set and its gate names a tool this shim serves`, async (t) => {
    const loop = loadLoop(join(EXAMPLES, file));
    const { root } = workspace(file, GOOD_MODEL);
    const bridge = await startStubBridge({ manifest: MANIFEST });
    const bb = await startStubBlockbench({ tools: BB_TOOLS, onCall: () => ({}) });
    const shim = await spawnShim({ cwd: root, env: { MCPTK_URL: bridge.base, MCPTK_BLOCKBENCH: bb.url } });
    t.after(async () => { shim.kill(); await bridge.close(); await bb.close(); });

    let tools = [];
    for (let i = 0; i < 40 && tools.length <= 1; i++) {
      await new Promise((r) => setTimeout(r, 250));
      tools = await shim.list();
    }
    const served = tools.map((x) => x.name).sort();
    // EXACTLY the keep-list plus the way back out. A name with nothing behind it drops out of this
    // list (the loud half of the failure); a REAL tool the example forgot never appears in the
    // keep-list at all, which is the silent half - so the comparison is an equality, both ways.
    const expected = [...loop.profile.keep, "tool_surface"].sort();
    assert.deepStrictEqual(served, expected,
      `served but not kept: ${served.filter((n) => !expected.includes(n)).join(", ") || "-"}\n`
      + `kept but not served: ${expected.filter((n) => !served.includes(n)).join(", ") || "-"}\n`
      + `stderr:\n${shim.stderr()}`);
    assert.doesNotMatch(shim.stderr(), /profile\.keep: \d+ name\(s\) not in this manifest/,
      `a kept name resolves to nothing:\n${shim.stderr()}`);

    // `art` drops trigger_action on purpose and profile.keep is ABSOLUTE, so an example that lists
    // it puts it back for everyone who copies the file.
    if (loop.profile.base === "art") {
      assert.ok(!served.includes("trigger_action"),
        "an art-based example must not re-add trigger_action (driving the UI blind is a fallback, not a pipeline)");
    }

    // A gate on a name this shim does not serve gates nothing; index.mjs says so on stderr, and an
    // EXAMPLE with one in it teaches the mistake.
    for (const c of loop.checks) {
      for (const gated of c.gate) {
        assert.ok(served.includes(gated),
          `check "${c.name}" gates "${gated}", which this profile does not serve, so the gate is a line in a file`);
      }
    }
    assert.doesNotMatch(shim.stderr(), /gate: \d+ name\(s\) this session does not serve/, shim.stderr());
  });
}

test("block-model.loop.json end to end: the check fires on export, and its problems refuse the push", async (t) => {
  const { root, model } = workspace("block-model.loop.json", BAD_MODEL);
  const bridge = await startStubBridge({ manifest: MANIFEST });
  const bb = await startStubBlockbench({ tools: BB_TOOLS, onCall: () => ({ codec: "java_block", written: model, bytes: 1 }) });
  const shim = await spawnShim({ cwd: root, env: { MCPTK_URL: bridge.base, MCPTK_BLOCKBENCH: bb.url } });
  t.after(async () => { shim.kill(); await bridge.close(); await bb.close(); });

  let tools = [];
  for (let i = 0; i < 40 && !tools.some((x) => x.name === "export_model"); i++) {
    await new Promise((r) => setTimeout(r, 250));
    tools = await shim.list();
  }
  const text = (r) => r.content.map((c) => c.text ?? "").join("\n");

  // Nothing has been checked yet, so nothing stands: the gate is not a blanket refusal.
  assert.ok(!(await shim.call("push_asset", { path: "x", data: "" })).isError, "no check has run; nothing to stand on");

  // The check fires after export_model - a tool whose OWN mechanism is `observe`, so this is the
  // `after.tools` half of the selector doing the work - and its block rides the reply.
  const exported = await shim.call("export_model", { codec: "java_block", path: model });
  assert.match(text(exported), /! crate: 1 problem\(s\)/, text(exported));
  assert.match(text(exported), /to\.y 34 is outside Minecraft's -16\.\.32/, text(exported));

  // ...and that problem is what refuses the push. This is the whole point of the file.
  const refused = await shim.call("push_asset", { path: "x", data: "" });
  assert.ok(refused.isError, text(refused));
  assert.match(text(refused), /gated: "push_asset" refused - 1 problem\(s\) stand from the last "block" check/, text(refused));
  // The escape hatch is a reason, said out loud.
  const forced = await shim.call("push_asset", { path: "x", data: "", force: "probe" });
  assert.ok(!forced.isError, text(forced));
  assert.match(text(forced), /forced past 1 problem\(s\) from "block": probe/, text(forced));

  // Fix it in the model and export again: the check clears, says what it was, and the push passes.
  writeFileSync(model, JSON.stringify(GOOD_MODEL, null, 2));
  const again = await shim.call("export_model", { codec: "java_block", path: model });
  assert.match(text(again), /- crate: 1 element\(s\), 6 face\(s\), 1 sheet\(s\) - ok \(was 1\)/, text(again));
  assert.ok(!(await shim.call("push_asset", { path: "x", data: "" })).isError, "a clean check clears the gate");
});
