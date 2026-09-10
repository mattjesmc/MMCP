// The post-call check hook and the gate (LOOP_KIT_DESIGN.md §5.2, step 2's arbiter), with a fake
// checker: fires after `world_edit`, not after `observe`; appends the checker's last line; hands the
// previous report back as `--previous <file>` on the second call; a gated tool is refused while
// problems stand and passes with `force`, which never reaches the bridge.
//
// No game: a stub bridge, a temp workspace with a loop file, and the REAL shim. Run:
//   node --test probes/loop-hook.test.mjs

import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStubBridge, startStubBlockbench, spawnShim, tool, textOf, HERE } from "./loop-harness.mjs";

const MANIFEST = [
  tool("set_blocks", "world_edit", { blocks: { type: "array" } }),
  tool("describe_box", "observe"),
  tool("capture_structure", "privileged", { name: { type: "string" } }),
  tool("ping", "observe"),
  // A tool that declares `force` ITSELF: the gate passes the argument through to this one.
  tool("own_force", "privileged", { force: { type: "boolean" } }),
];

/** A workspace: .mcptoolkit/loop.json, a checker whose verdict a state file controls, a call log. */
function workspace() {
  const root = mkdtempSync(join(tmpdir(), "mcptk-loop-"));
  mkdirSync(join(root, ".mcptoolkit"));
  mkdirSync(join(root, "tools"));
  writeFileSync(join(root, "tools", "state.json"), JSON.stringify({ problems: 0, notes: 1 }));
  writeFileSync(join(root, "tools", "check.mjs"), `
import { readFileSync, appendFileSync } from "node:fs";
const state = JSON.parse(readFileSync(new URL("./state.json", import.meta.url), "utf8"));
appendFileSync(new URL("./calls.log", import.meta.url), JSON.stringify(process.argv.slice(2)) + "\\n");
console.log("chatter the checker prints first");
const p = state.problems;
const text = p ? "  ! " + p + " problem(s) stand\\n  " + p + " problem(s) need a decision" : "  ok: nothing needs a decision";
console.log(JSON.stringify({ text, problems: p, notes: state.notes, full: "FULL " + text, seq: state.seq ?? 0 }));
`);
  writeFileSync(join(root, ".mcptoolkit", "loop.json"), JSON.stringify({
    checks: [{
      name: "part",
      after: { mechanism: ["world_edit"], tools: ["ping"] },
      run: [process.execPath, "tools/check.mjs", "--status", "--json", "--brief"],
      stateful: true,
      gate: ["capture_structure", "own_force"],
      timeout_ms: 8000,
    }],
  }, null, 2));
  return {
    root,
    setState: (s) => writeFileSync(join(root, "tools", "state.json"), JSON.stringify(s)),
    calls: () => (existsSync(join(root, "tools", "calls.log"))
      ? readFileSync(join(root, "tools", "calls.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []),
  };
}

test("checks fire by mechanism, ride the reply, and carry the previous report", async (t) => {
  const ws = workspace();
  const bridge = await startStubBridge({ manifest: MANIFEST });
  const shim = await spawnShim({ cwd: ws.root, env: { MCPTK_URL: bridge.base, MCPTK_PROFILE: "full" } });
  t.after(async () => { shim.kill(); await bridge.close(); });
  await shim.list(); // the manifest build is what stamps the mechanisms
  assert.match(shim.stderr(), /loop file: .*loop\.json — 1 check\(s\)/);

  // observe: no check.
  let r = await shim.call("describe_box");
  assert.strictEqual(textOf(r), "{}", `no check after an observe:\n${textOf(r)}`);
  assert.strictEqual(ws.calls().length, 0);

  // world_edit: the checker ran, and ONLY its last line rode the reply.
  r = await shim.call("set_blocks", { blocks: [] });
  assert.ok(!r.isError, textOf(r));
  assert.match(textOf(r), /\n  ok: nothing needs a decision$/, `the check's text appended:\n${textOf(r)}`);
  assert.ok(!/chatter/.test(textOf(r)), "only the last line is the contract; the chatter stays out");
  let calls = ws.calls();
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0].slice(0, 3), ["--status", "--json", "--brief"]);
  assert.strictEqual(calls[0][3], "--previous", "stateful: the previous-report path is passed");
  assert.deepStrictEqual(JSON.parse(readFileSync(calls[0][4], "utf8")), null, "first run: no previous report");

  // A name rule (`tools: ["ping"]`) fires on an observe tool too.
  r = await shim.call("ping");
  assert.match(textOf(r), /ok: nothing needs a decision/);
  calls = ws.calls();
  const prev = JSON.parse(readFileSync(calls[1][4], "utf8"));
  assert.strictEqual(prev.problems, 0, "second run: the FIRST report is the previous");
  assert.strictEqual(prev.full, "FULL   ok: nothing needs a decision");
});

test("the gate: refused while problems stand, forced with a reason, force never forwarded", async (t) => {
  const ws = workspace();
  const bridge = await startStubBridge({ manifest: MANIFEST });
  const shim = await spawnShim({ cwd: ws.root, env: { MCPTK_URL: bridge.base, MCPTK_PROFILE: "full" } });
  t.after(async () => { shim.kill(); await bridge.close(); });
  const tools = await shim.list();
  // Gated tools grew `force`; ungated ones did not; the one that had its own kept it.
  assert.strictEqual(tools.find((x) => x.name === "capture_structure").inputSchema.properties.force.type, "string");
  assert.ok(!tools.find((x) => x.name === "set_blocks").inputSchema.properties.force);
  assert.strictEqual(tools.find((x) => x.name === "own_force").inputSchema.properties.force.type, "boolean");

  // Nothing stands yet: the gate is open.
  let r = await shim.call("capture_structure", { name: "a" });
  assert.ok(!r.isError);

  // Two problems stand after the next edit.
  ws.setState({ problems: 2, notes: 0 });
  r = await shim.call("set_blocks", { blocks: [] });
  assert.match(textOf(r), /! 2 problem\(s\) stand/);
  r = await shim.call("capture_structure", { name: "a" });
  assert.ok(r.isError, "refused");
  assert.match(textOf(r), /^gated: "capture_structure" refused - 2 problem\(s\) stand from the last "part" check\./);
  assert.match(textOf(r), /call again with force:"<why>"/);
  assert.ok(!bridge.calls.some((c) => c.tool === "capture_structure" && c.args.name === "a" && bridge.calls.indexOf(c) > 1),
    "the refused call never reached the bridge");
  const before = bridge.calls.length;

  // Forced: proceeds, the reason is echoed, and `force` is stripped before the bridge.
  r = await shim.call("capture_structure", { name: "b", force: "the two problems are a deliberate mirror pair" });
  assert.ok(!r.isError, textOf(r));
  assert.match(textOf(r), /forced past 2 problem\(s\) from "part": the two problems are a deliberate mirror pair/);
  const forwarded = bridge.calls.slice(before).find((c) => c.tool === "capture_structure");
  assert.deepStrictEqual(forwarded.args, { name: "b" }, "force stripped for a tool that never declared it");
  assert.match(shim.stderr(), /FORCED past 2 problem\(s\) from check "part": the two problems are a deliberate mirror pair/);

  // A tool with its OWN `force` gets it passed through.
  r = await shim.call("own_force", { force: true });
  assert.ok(!r.isError);
  assert.deepStrictEqual(bridge.calls.at(-1).args, { force: true });

  // Problems fixed: the gate opens again on the next check.
  ws.setState({ problems: 0, notes: 0 });
  await shim.call("set_blocks", { blocks: [] });
  r = await shim.call("capture_structure", { name: "c" });
  assert.ok(!r.isError, "open again");
});

test("the shim's own painters fire a `blockbench_edit` check, as the documented shape expects", async (t) => {
  // ArmorPieces' falsifier (LOOP_KIT_DESIGN.md section 11, finding 3): the example loop file
  // selected `after: {mechanism: ["blockbench_edit"]}` and the painters, stamped `local`, ran
  // unchecked. The toolkit's own live test had hidden it by naming both painters in `after.tools`.
  const ws = workspace();
  writeFileSync(join(ws.root, ".mcptoolkit", "loop.json"), JSON.stringify({
    checks: [{
      name: "part",
      after: { mechanism: ["blockbench_edit"] },
      run: [process.execPath, "tools/check.mjs", "--json", "--brief"],
    }],
  }));
  const bbTools = JSON.parse(readFileSync(join(HERE, "fixtures", "blockbench-bridge-2026-09-07.json"), "utf8"));
  const bb = await startStubBlockbench({ tools: bbTools, onCall: () => ({}) });
  const bridge = await startStubBridge({ manifest: MANIFEST });
  const shim = await spawnShim({ cwd: ws.root, env: { MCPTK_URL: bridge.base, MCPTK_PROFILE: "art", MCPTK_BLOCKBENCH: bb.url } });
  t.after(async () => { shim.kill(); await bridge.close(); await bb.close(); });
  let tools = [];
  for (let i = 0; i < 40 && !tools.some((x) => x.name === "place_cube"); i++) {
    await new Promise((r) => setTimeout(r, 250));
    tools = await shim.list();
  }
  assert.ok(tools.some((x) => x.name === "paint_faces"), `art serves the painters; stderr:\n${shim.stderr()}`);

  // A Blockbench read-only tool: no check.
  let r = await shim.call("get_project_info");
  assert.ok(!/needs a decision/.test(textOf(r)), `no check after a Blockbench observe:\n${textOf(r)}`);
  assert.strictEqual(ws.calls().length, 0);
  // A Blockbench edit: the check.
  r = await shim.call("place_cube", { name: "c", from: [0, 0, 0], to: [1, 1, 1] });
  assert.match(textOf(r), /ok: nothing needs a decision$/, `after place_cube:\n${textOf(r)}`);
  assert.strictEqual(ws.calls().length, 1);
  // The shim's own painter: THE SAME CHECK, by the same mechanism rule, with nothing named.
  r = await shim.call("paint_faces", { faces: { "c.north": "#ff0000" } });
  assert.ok(!r.isError, textOf(r));
  assert.match(textOf(r), /ok: nothing needs a decision$/, `after paint_faces:\n${textOf(r)}`);
  assert.strictEqual(ws.calls().length, 2, "paint_faces fired the blockbench_edit check");
  r = await shim.call("paint_ascii", { stamps: [{ at: [0, 0], rows: ["#"] }], palette: { "#": "#ffffff" } });
  assert.ok(!r.isError, textOf(r));
  assert.strictEqual(ws.calls().length, 3, "paint_ascii fired it too");
});

test("a gate naming a tool this session does not serve is loud; `local` is not a mechanism", async (t) => {
  // Finding 4 of the same falsifier: the example gated `armorpieces_save`, a tool of the project's
  // OWN proxy, and nothing warned - a gate that looks like a guard and is nothing.
  const ws = workspace();
  writeFileSync(join(ws.root, ".mcptoolkit", "loop.json"), JSON.stringify({
    checks: [{
      name: "part",
      after: { mechanism: ["world_edit"] },
      run: [process.execPath, "tools/check.mjs"],
      gate: ["capture_structure", "armorpieces_save"],
    }],
  }));
  const bridge = await startStubBridge({ manifest: MANIFEST });
  const shim = await spawnShim({ cwd: ws.root, env: { MCPTK_URL: bridge.base, MCPTK_PROFILE: "full" } });
  t.after(async () => { shim.kill(); await bridge.close(); });
  await shim.list();
  await shim.waitStderr(/loop file check "part"\.gate: 1 name\(s\) this session does not serve, so the gate does nothing for them: armorpieces_save - a tool of another MCP server cannot be gated here/);
  // The served name is still gated: its schema grew `force`.
  const tools = await shim.list();
  assert.strictEqual(tools.find((x) => x.name === "capture_structure").inputSchema.properties.force.type, "string");

  // `local` selects nothing now that local tools carry the upstream's mechanism: refused at load.
  writeFileSync(join(ws.root, ".mcptoolkit", "loop.json"), JSON.stringify({
    checks: [{ name: "p", after: { mechanism: ["local"] }, run: [process.execPath, "tools/check.mjs"] }],
  }));
  const { code, stderr } = await spawnShim({ cwd: ws.root, env: { MCPTK_URL: bridge.base }, expectExit: true });
  assert.notStrictEqual(code, 0);
  assert.match(stderr(), /checks\[0\]\.after\.mechanism "local" selects nothing: .*the painters are "blockbench_edit"/);
});

test("the shim's own painters fire a `blockbench_edit` check, as the documented shape expects", async (t) => {
  // ArmorPieces' falsifier (LOOP_KIT_DESIGN.md section 11, finding 3): the example loop file
  // selected `after: {mechanism: ["blockbench_edit"]}` and the painters, stamped `local`, ran
  // unchecked. The toolkit's own live test had hidden it by naming both painters in `after.tools`.
  const ws = workspace();
  writeFileSync(join(ws.root, ".mcptoolkit", "loop.json"), JSON.stringify({
    checks: [{
      name: "part",
      after: { mechanism: ["blockbench_edit"] },
      run: [process.execPath, "tools/check.mjs", "--json", "--brief"],
    }],
  }));
  const bbTools = JSON.parse(readFileSync(join(HERE, "fixtures", "blockbench-bridge-2026-09-07.json"), "utf8"));
  const bb = await startStubBlockbench({ tools: bbTools, onCall: () => ({}) });
  const bridge = await startStubBridge({ manifest: MANIFEST });
  const shim = await spawnShim({ cwd: ws.root, env: { MCPTK_URL: bridge.base, MCPTK_PROFILE: "art", MCPTK_BLOCKBENCH: bb.url } });
  t.after(async () => { shim.kill(); await bridge.close(); await bb.close(); });
  let tools = [];
  for (let i = 0; i < 40 && !tools.some((x) => x.name === "place_cube"); i++) {
    await new Promise((r) => setTimeout(r, 250));
    tools = await shim.list();
  }
  assert.ok(tools.some((x) => x.name === "paint_faces"), `art serves the painters; stderr:\n${shim.stderr()}`);

  // A Blockbench read-only tool: no check.
  let r = await shim.call("get_project_info");
  assert.ok(!/needs a decision/.test(textOf(r)), `no check after a Blockbench observe:\n${textOf(r)}`);
  assert.strictEqual(ws.calls().length, 0);
  // A Blockbench edit: the check.
  r = await shim.call("place_cube", { elements: [{ name: "c", from: [0, 0, 0], to: [1, 1, 1] }] });
  assert.match(textOf(r), /ok: nothing needs a decision$/, `after place_cube:\n${textOf(r)}`);
  assert.strictEqual(ws.calls().length, 1);
  // The shim's own painter: THE SAME CHECK, by the same mechanism rule, with nothing named.
  r = await shim.call("paint_faces", { faces: { "c.north": "#ff0000" } });
  assert.ok(!r.isError, textOf(r));
  assert.match(textOf(r), /ok: nothing needs a decision$/, `after paint_faces:\n${textOf(r)}`);
  assert.strictEqual(ws.calls().length, 2, "paint_faces fired the blockbench_edit check");
  r = await shim.call("paint_ascii", { stamps: [{ at: [0, 0], rows: ["#"] }], palette: { "#": "#ffffff" } });
  assert.ok(!r.isError, textOf(r));
  assert.strictEqual(ws.calls().length, 3, "paint_ascii fired it too");
});

test("a gate naming a tool this session does not serve is loud; `local` is not a mechanism", async (t) => {
  // Finding 4 of the same falsifier: the example gated `armorpieces_save`, a tool of the project's
  // OWN proxy, and nothing warned - a gate that looks like a guard and is nothing.
  const ws = workspace();
  writeFileSync(join(ws.root, ".mcptoolkit", "loop.json"), JSON.stringify({
    checks: [{
      name: "part",
      after: { mechanism: ["world_edit"] },
      run: [process.execPath, "tools/check.mjs"],
      gate: ["capture_structure", "armorpieces_save"],
    }],
  }));
  const bridge = await startStubBridge({ manifest: MANIFEST });
  const shim = await spawnShim({ cwd: ws.root, env: { MCPTK_URL: bridge.base, MCPTK_PROFILE: "full" } });
  t.after(async () => { shim.kill(); await bridge.close(); });
  await shim.list();
  await shim.waitStderr(/loop file check "part"\.gate: 1 name\(s\) this session does not serve, so the gate does nothing for them: armorpieces_save - a tool of another MCP server cannot be gated here/);
  // The served name is still gated: its schema grew `force`.
  const tools = await shim.list();
  assert.strictEqual(tools.find((x) => x.name === "capture_structure").inputSchema.properties.force.type, "string");

  // `local` selects nothing now that local tools carry the upstream's mechanism: refused at load.
  writeFileSync(join(ws.root, ".mcptoolkit", "loop.json"), JSON.stringify({
    checks: [{ name: "p", after: { mechanism: ["local"] }, run: [process.execPath, "tools/check.mjs"] }],
  }));
  const { code, stderr } = await spawnShim({ cwd: ws.root, env: { MCPTK_URL: bridge.base }, expectExit: true });
  assert.notStrictEqual(code, 0);
  assert.match(stderr(), /checks\[0\]\.after\.mechanism "local" selects nothing: .*the painters are "blockbench_edit"/);
});

test("a checker that cannot run is loud, not silent", async (t) => {
  const ws = workspace();
  // Break the checker: it exits without JSON.
  writeFileSync(join(ws.root, "tools", "check.mjs"), `console.error("boom: no such sheet"); process.exit(3);`);
  const bridge = await startStubBridge({ manifest: MANIFEST });
  const shim = await spawnShim({ cwd: ws.root, env: { MCPTK_URL: bridge.base, MCPTK_PROFILE: "full" } });
  t.after(async () => { shim.kill(); await bridge.close(); });
  await shim.list();
  const r = await shim.call("set_blocks", { blocks: [] });
  assert.ok(!r.isError, "the edit itself succeeded");
  assert.match(textOf(r), /\[loop\] check "part" could not run: boom: no such sheet/);
  // ...and a gate behind a check that could not run does not pretend the problems are gone,
  // but does not refuse on nothing either: no report, no standing problems.
  const g = await shim.call("capture_structure", { name: "x" });
  assert.ok(!g.isError);
  // A last line that IS JSON but is not the contract (no text, no problems) is a failure too: the
  // first live run rode an outdated plugin's {ok:false,error} envelope onto every reply as if it
  // were a report.
  writeFileSync(join(ws.root, "tools", "check.mjs"), `console.log(JSON.stringify({ ok: false, error: "unknown action" }));`);
  const r2 = await shim.call("set_blocks", { blocks: [] });
  assert.match(textOf(r2), /\[loop\] check "part" could not run: the last line is JSON but not a check report/);
});

test("an eval check reaches the plugin's risky_eval with its comment intact, and its value is the report", async (t) => {
  // Until 0.64.0 an eval containing "//" was refused at load, because the third-party plugin's
  // eval refused it before running a byte. The toolkit's own plugin takes comments, so the check
  // must simply run - and what it runs is the code AS WRITTEN, __previous prepended.
  const ws = workspace();
  writeFileSync(join(ws.root, ".mcptoolkit", "loop.json"), JSON.stringify({
    checks: [{ name: "e", after: { mechanism: ["blockbench_edit"] }, eval: "mcptoolkitEntity({action:'check'}) // the check", stateful: true }],
  }));
  const bbTools = JSON.parse(readFileSync(join(HERE, "fixtures", "blockbench-bridge-2026-09-07.json"), "utf8"));
  const bb = await startStubBlockbench({
    tools: bbTools,
    onCall: (p) => (p.name === "risky_eval" ? { value: { text: "eval says: 2 faces unpainted", problems: 2 } } : {}),
  });
  const bridge = await startStubBridge({ manifest: MANIFEST });
  const shim = await spawnShim({ cwd: ws.root, env: { MCPTK_URL: bridge.base, MCPTK_PROFILE: "art", MCPTK_BLOCKBENCH: bb.url } });
  t.after(async () => { shim.kill(); await bridge.close(); await bb.close(); });
  let tools = [];
  for (let i = 0; i < 40 && !tools.some((x) => x.name === "place_cube"); i++) {
    await new Promise((r) => setTimeout(r, 250));
    tools = await shim.list();
  }
  const r = await shim.call("place_cube", { elements: [{ from: [0, 0, 0], to: [1, 1, 1] }] });
  assert.match(textOf(r), /eval says: 2 faces unpainted/, `the eval's value rode the reply:\n${textOf(r)}`);
  const ev = bb.calls.find((c) => c.name === "risky_eval");
  assert.ok(ev, "the check ran through the plugin's risky_eval");
  assert.match(ev.arguments.code, /^var __previous = null;\nmcptoolkitEntity\(\{action:'check'\}\) \/\/ the check$/, ev.arguments.code);
});

test("a malformed loop file refuses to start the shim", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "mcptk-loop-bad-"));
  mkdirSync(join(root, ".mcptoolkit"));
  writeFileSync(join(root, ".mcptoolkit", "loop.json"), JSON.stringify({ checks: [{ after: { mechanism: ["world_edit"] } }] }));
  const bridge = await startStubBridge({ manifest: MANIFEST });
  t.after(async () => { await bridge.close(); });
  const { code, stderr } = await spawnShim({ cwd: root, env: { MCPTK_URL: bridge.base }, expectExit: true });
  assert.notStrictEqual(code, 0);
  assert.match(stderr(), /loop file .*checks\[0\] needs "run"/);
});


// unit.start (RELEASE_1.md section J5): a command run BEFORE the session by tools/loop/unit-start.mjs,
// its output leading the brief. Tested on the script itself - the runner around it is PowerShell and
// a live `claude -p` - and on the shim, which must tolerate the key it does not read.
test("unit.start runs once before the session with ${unit} substituted; the shim ignores the key", async (t) => {
  const { spawnSync } = await import("node:child_process");
  const UNIT_START = join(HERE, "..", "..", "mcp-toolkit", "tools", "loop", "unit-start.mjs");
  assert.ok(existsSync(UNIT_START), `expected the runner at ${UNIT_START}`);
  const ws = workspace();
  const loop = JSON.parse(readFileSync(join(ws.root, ".mcptoolkit", "loop.json"), "utf8"));
  loop.unit = { start: [process.execPath, "-e", "console.log('scaffolded ' + process.argv[1] + ' in ' + process.env.MCPTK_UNIT)", "${unit}"] };
  writeFileSync(join(ws.root, ".mcptoolkit", "loop.json"), JSON.stringify(loop, null, 2));

  const r = spawnSync(process.execPath, [UNIT_START, ws.root, "beast_head"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^## Unit start: /, "a heading names the command, so the brief says where the lines came from");
  assert.match(r.stdout, /scaffolded beast_head in beast_head/, "the argument and the environment both carry the unit");

  // A failing start is reported and its exit code passed through - the runner warns and continues.
  loop.unit = { start: [process.execPath, "-e", "console.log('already scaffolded'); process.exit(1)"] };
  writeFileSync(join(ws.root, ".mcptoolkit", "loop.json"), JSON.stringify(loop, null, 2));
  const f = spawnSync(process.execPath, [UNIT_START, ws.root, "beast_head"], { encoding: "utf8" });
  assert.equal(f.status, 1);
  assert.match(f.stdout, /already scaffolded/, "the output still reaches the brief");
  assert.match(f.stderr, /exit 1/);

  // No unit block: nothing printed, exit 0.
  delete loop.unit;
  writeFileSync(join(ws.root, ".mcptoolkit", "loop.json"), JSON.stringify(loop, null, 2));
  const n = spawnSync(process.execPath, [UNIT_START, ws.root, "beast_head"], { encoding: "utf8" });
  assert.equal(n.status, 0);
  assert.equal(n.stdout, "");

  // The shim reads checks and profile; a loop file carrying `unit` must load like one without it.
  loop.unit = { start: ["gradlew", "scaffold", "-Pkind=block", "-Pid=${unit}"] };
  writeFileSync(join(ws.root, ".mcptoolkit", "loop.json"), JSON.stringify(loop, null, 2));
  const bridge = await startStubBridge({ manifest: MANIFEST });
  const shim = await spawnShim({ cwd: ws.root, env: { MCPTK_URL: bridge.base, MCPTK_PROFILE: "full" } });
  t.after(() => { shim.kill(); bridge.close(); });
  const names = (await shim.list()).map((x) => x.name);
  assert.ok(names.includes("set_blocks"), `the shim came up with its tools: ${names}`);
  assert.ok(!/unit/i.test(shim.stderr()), `the shim did not complain about the key: ${shim.stderr()}`);
});
