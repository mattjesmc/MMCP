// The project profile (LOOP_KIT_DESIGN.md §5.3, step 3's arbiter): a loop file's `profile` becomes
// the session's default, its keep-list is honoured, its notes are appended and priced, its
// instructions are served, `tool_surface` reports it, and a kept name the manifest lacks is loud.
// Sessions without a loop file are untouched: that is what every other profile probe in this
// directory keeps proving, and the last test here pins the one comparison directly.
//
// No game. Run: node --test probes/loop-profile.test.mjs

import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStubBridge, startStubBlockbench, spawnShim, tool, HERE } from "./loop-harness.mjs";

const MANIFEST = JSON.parse(readFileSync(join(HERE, "fixtures", "manifest-2026-09-06.json"), "utf8"));
const BB_TOOLS = JSON.parse(readFileSync(join(HERE, "fixtures", "blockbench-bridge-2026-09-07.json"), "utf8"));

function workspace(profile) {
  const root = mkdtempSync(join(tmpdir(), "mcptk-loop-profile-"));
  mkdirSync(join(root, ".mcptoolkit"));
  writeFileSync(join(root, ".mcptoolkit", "loop.json"), JSON.stringify({ profile }, null, 2));
  return root;
}

const KEEP = ["place_cube", "modify_cube", "get_project_info", "capture_screenshot", "ping", "screenshot", "push_asset", "mem_note", "plaec_cube"];
const NOTE = " In this workspace put the cube in a bone group under `part`.";

test("a project keep-list over the art base: kept, noted, priced, announced", async (t) => {
  const root = workspace({ base: "art", keep: KEEP, notes: { place_cube: NOTE, set_blocks: " never served, so never priced" },
    instructions: "Blockbench is running with this project's plugin. Model inside `part`." });
  const bb = await startStubBlockbench({ tools: BB_TOOLS, onCall: () => ({}) });
  const bridge = await startStubBridge({ manifest: MANIFEST });
  const shim = await spawnShim({ cwd: root, env: { MCPTK_URL: bridge.base, MCPTK_BLOCKBENCH: bb.url } });
  t.after(async () => { shim.kill(); await bridge.close(); await bb.close(); });

  // Launched in it, by the file alone (no MCPTK_PROFILE in the env).
  assert.match(shim.stderr(), /profile: project \(dev\) - this workspace's own profile/);
  assert.strictEqual(shim.initResult.instructions, "Blockbench is running with this project's plugin. Model inside `part`.");

  let tools = [];
  for (let i = 0; i < 40 && !tools.some((x) => x.name === "place_cube"); i++) {
    await new Promise((r) => setTimeout(r, 250));
    tools = await shim.list();
  }
  const names = tools.map((x) => x.name).sort();
  // Exactly the keep-list's names that exist, plus the way back out. `plaec_cube` is the typo.
  const expected = KEEP.filter((n) => n !== "plaec_cube").concat("tool_surface").sort();
  assert.deepStrictEqual(names, expected, `served: ${names.join(", ")}`);
  // The note landed on the one tool, verbatim, at the end of its own description.
  const pc = tools.find((x) => x.name === "place_cube");
  assert.ok(pc.description.endsWith(NOTE), pc.description);
  assert.ok(!tools.find((x) => x.name === "modify_cube").description.includes("bone group"), "no note leaks onto a neighbour");
  // The typo is loud.
  await shim.waitStderr(/profile\.keep: 1 name\(s\) not in this manifest, so never served: plaec_cube/);

  // tool_surface reports the project profile and prices what the file added.
  const report = JSON.parse((await shim.call("tool_surface")).content[0].text);
  assert.strictEqual(report.profile, "project");
  assert.strictEqual(report.kind, "dev");
  assert.match(report.role, /base art, 9 kept, 2 description note\(s\)/);
  assert.strictEqual(report.tools, expected.length);
  assert.strictEqual(report.loop.notes, 1, "only the note on a SERVED tool is priced");
  assert.strictEqual(report.loop.notes_chars, NOTE.length);
  assert.ok(report.loop.instructions_chars > 0);
  assert.ok(report.available.some((p) => p.profile === "project"), "listed beside the built-in profiles");
  console.log(`  project profile: ${report.tools} tools, ${report.chars} chars, note ${report.loop.notes_chars} chars`);

  // `ping` says which profile the session was launched under.
  const ping = JSON.parse((await shim.call("ping")).content[0].text);
  assert.strictEqual(ping.profile.launched_as, "project");

  // A tool the keep-list left out refuses with the profile's name, and widening is one call away.
  const hidden = await shim.call("set_blocks", { blocks: [] });
  assert.ok(hidden.isError);
  assert.match(hidden.content[0].text, /profile_hidden: "set_blocks" is not served by the current tool profile \("project"\)/);
  const sw = JSON.parse((await shim.call("tool_surface", { profile: "art" })).content[0].text);
  assert.strictEqual(sw.profile, "art");
  assert.strictEqual(sw.was, "project");
  // ...and back.
  const back = JSON.parse((await shim.call("tool_surface", { profile: "project" })).content[0].text);
  assert.strictEqual(back.profile, "project");
  assert.strictEqual(back.tools, expected.length);
});

test("a project profile with no keep-list IS its base, notes included", async (t) => {
  const root = workspace({ base: "modding", notes: { set_blocks: " Build inside the studio only." } });
  const bridge = await startStubBridge({ manifest: MANIFEST });
  const project = await spawnShim({ cwd: root, env: { MCPTK_URL: bridge.base } });
  const modding = await spawnShim({ env: { MCPTK_URL: bridge.base, MCPTK_PROFILE: "modding" } });
  t.after(async () => { project.kill(); modding.kill(); await bridge.close(); });
  const a = (await project.list()).map((x) => x.name).sort();
  const b = (await modding.list()).map((x) => x.name).sort();
  assert.deepStrictEqual(a, b, "same surface as the base");
  const sb = (await project.list()).find((x) => x.name === "set_blocks");
  assert.ok(sb.description.endsWith(" Build inside the studio only."));
  const plain = (await modding.list()).find((x) => x.name === "set_blocks");
  assert.ok(!plain.description.endsWith(" Build inside the studio only."), "a session without the file gets no note");
});

test("MCPTK_PROFILE outranks the loop file's profile", async (t) => {
  const root = workspace({ base: "art", keep: ["ping"] });
  const bridge = await startStubBridge({ manifest: MANIFEST });
  const shim = await spawnShim({ cwd: root, env: { MCPTK_URL: bridge.base, MCPTK_PROFILE: "inspect" } });
  t.after(async () => { shim.kill(); await bridge.close(); });
  assert.match(shim.stderr(), /profile: inspect/);
  const names = (await shim.list()).map((x) => x.name);
  assert.ok(names.includes("describe_box") && !names.includes("set_blocks"));
  // ...and `project` is still one switch away.
  const sw = JSON.parse((await shim.call("tool_surface", { profile: "project" })).content[0].text);
  assert.strictEqual(sw.profile, "project");
  assert.deepStrictEqual((await shim.list()).map((x) => x.name).sort(), ["ping", "tool_surface"]);
});

test("an unknown base refuses to start", async (t) => {
  const root = workspace({ base: "armor" });
  const bridge = await startStubBridge({ manifest: MANIFEST });
  t.after(async () => { await bridge.close(); });
  const { code, stderr } = await spawnShim({ cwd: root, env: { MCPTK_URL: bridge.base }, expectExit: true });
  assert.notStrictEqual(code, 0);
  assert.match(stderr(), /profile\.base "armor" is not a profile/);
});
