// `rocketeer_authoring` — the first keep-profile that serves an EXTENSION mod's tools, checked in
// the two places it can go wrong.
//
// WHY IT NEEDS ITS OWN PROBE, and it is not "one more profile". Every hide-list in index.mjs is
// checked by a warning: a hidden name that matches nothing in the manifest is reported, with
// CLIENT_SURFACE and EXTENSION_SURFACE exempted so a conditionally-absent tool is not read as dead
// (0.98.0, where reading absent as dead nearly pruned six live villagejobs verbs). A KEEP-list has
// no such check and cannot have one — a keep-list must work against a game that does not host the
// extension, so an absent name has to be silently unserved. Which means a TYPO in one of the four
// names this profile adds costs the session `rk_piece_check` and says nothing at all.
//
// So the typo is caught HERE, and against the authority: the tool names are grepped out of
// rocketeer's own RocketeerTools.java, which is where they are registered. Not against a captured
// manifest — the capture is of mcp-toolkit's own standalone game, which hosts no rocketeer, and
// asserting membership against a manifest that structurally cannot contain them would be a probe
// that passes by looking somewhere the answer is not.
//
// WHAT IS NOT PROVED HERE: that a live rocketeer game actually manifests these four. That needs the
// game, and belongs to a live measurement (rocketeer-authoring/bin/price-profile.mjs against a
// running bridge). This file proves the profile ASKS for the right names and drops the right ones.
//
// Run: node --test probes/rocketeer-authoring.test.mjs

import { test } from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIM = join(HERE, "..", "index.mjs");
const CAPTURE = "manifest-2026-08-26.json";
const MANIFEST = JSON.parse(readFileSync(join(HERE, "fixtures", CAPTURE), "utf8"));

// The mod that registers the rk_* tools. Absent on a machine without the checkout, in which case the
// name cross-check skips rather than fails — a missing sibling repo is not a defect in this profile.
// The default is the sibling checkout beside the workbench (../../rocketeer from this file's repo
// root); MCPTK_ROCKETEER names it anywhere else, which is the only way this file leaves one machine.
const ROCKETEER_TOOLS = process.env.MCPTK_ROCKETEER
  ?? join(HERE, "..", "..", "..", "rocketeer", "src", "main", "java", "com", "mattmc", "rocketeer", "mcp", "RocketeerTools.java");

const ADDED = ["rk_piece_frame", "rk_piece_check", "rk_piece_declare", "check_path"];

async function stubBridge() {
  const http = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(req.url === "/tools" ? JSON.stringify(MANIFEST) : "{}");
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  return { base: `http://127.0.0.1:${http.address().port}`, close: () => new Promise((r) => http.close(r)) };
}

/** One shim process, driven to a tools/list under `profile`. */
async function serve(t, base, profile) {
  const child = spawn(process.execPath, [SHIM], {
    env: { ...process.env, MCPTK_URL: base, MCPTK_PROFILE: profile, MCPTK_HIDE_TOOLS: "", MCPTK_BLOCKBENCH: "off" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  const inbox = [];
  let buf = "", stderr = "";
  child.stdout.on("data", (d) => {
    buf += d.toString();
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const l of lines) {
      if (!l.trim().startsWith("{")) continue;
      try { inbox.push(JSON.parse(l)); } catch { /* partial or foreign line */ }
    }
  });
  child.stderr.on("data", (d) => { stderr += d.toString(); });
  const wait = (pred, what, ms = 20_000) => new Promise((resolve, reject) => {
    const started = Date.now();
    const iv = setInterval(() => {
      const hit = inbox.find(pred);
      if (hit) { clearInterval(iv); resolve(hit); return; }
      if (Date.now() - started > ms) {
        clearInterval(iv);
        reject(new Error(`timed out waiting for ${what} under "${profile}"; stderr:\n${stderr}`));
      }
    }, 40).unref();
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "probe", version: "0" } } })}\n`);
  await wait((m) => m.id === 1, "initialize");
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
  return (await wait((m) => m.id === 2, "tools/list")).result.tools;
}

test("rocketeer_authoring is authoring plus exactly the four tools that judge a piece", async (t) => {
  const bridge = await stubBridge();
  t.after(async () => { await bridge.close(); });

  const std = await serve(t, bridge.base, "standard");
  const auth = await serve(t, bridge.base, "authoring");
  const rk = await serve(t, bridge.base, "rocketeer_authoring");

  const price = (tools) => JSON.stringify(tools).length;
  const names = (tools) => new Set(tools.map((x) => x.name));
  const [A, R] = [names(auth), names(rk)];

  console.log(`\n  capture ${CAPTURE} — ${MANIFEST.length} bridge tools, no rocketeer in it`);
  console.log("                          tools     chars   ~tokens");
  for (const [label, list] of [["standard", std], ["authoring", auth], ["rocketeer_authoring", rk]]) {
    console.log(`    ${label.padEnd(22)}${String(list.length).padStart(6)}`
      + `${String(price(list)).padStart(10)}${String(Math.round(price(list) / 4)).padStart(10)}`);
  }
  const cut = (price(std) - price(rk)) / price(std);
  console.log(`    -> ${(100 * cut).toFixed(1)}% off the standard list, `
    + `${price(rk) - price(auth)} chars above authoring\n`);

  // SUPERSET, and the delta is exactly what the profile claims. Not ">= authoring" — equality on the
  // difference, so a name quietly added to one list and not the other is a failure rather than a
  // widening nobody notices.
  for (const kept of A) assert.ok(R.has(kept), `rocketeer_authoring dropped "${kept}", which authoring keeps`);
  const extra = [...R].filter((x) => !A.has(x)).sort();
  const expected = ADDED.filter((x) => MANIFEST.some((m) => m.name === x)).sort();
  assert.deepStrictEqual(extra, expected,
    "the difference from `authoring` must be exactly the names this profile adds that this capture has");

  // check_path is the one added name the capture DOES contain, so it is the one whose serving can be
  // proved without a game — and it is the tool the profile most needs, because the bake's lane flood
  // cannot see a climb and check_path is the only thing in the manifest that can.
  assert.ok(!A.has("check_path"), "fixture check: authoring must not serve check_path, or this proves nothing");
  assert.ok(R.has("check_path"), "rocketeer_authoring must serve check_path");

  // The way back out survives the narrowing, exactly as it must for `authoring`.
  assert.ok(R.has("tool_surface"), "a session must always be able to widen again");

  // The expensive general surface stays gone: a bigger keep-list is still a keep-list.
  for (const gone of ["locate", "get_events", "bot_body", "sense_entities"]) {
    if (!MANIFEST.some((m) => m.name === gone)) continue;
    assert.ok(!R.has(gone), `rocketeer_authoring must not serve "${gone}"`);
  }
  assert.ok(cut >= 0.6,
    `rocketeer_authoring cut only ${(100 * cut).toFixed(1)}% of the served list. If the point of a `
    + "narrowed profile has been eaten by additions, say so here rather than in a batch's bill.");
});

test("the rk_* names are the ones rocketeer actually registers", (t) => {
  if (!existsSync(ROCKETEER_TOOLS)) {
    t.skip(`${ROCKETEER_TOOLS} not on this machine — the cross-check needs the sibling checkout`);
    return;
  }
  const src = readFileSync(ROCKETEER_TOOLS, "utf8");
  const registered = [...src.matchAll(/"(rk_[a-z_]+)"/g)].map((m) => m[1]);
  assert.ok(registered.length > 0, "found no rk_* tool name in RocketeerTools.java — has it moved?");
  for (const name of ADDED.filter((x) => x.startsWith("rk_"))) {
    assert.ok(registered.includes(name),
      `rocketeer_authoring keeps "${name}", which RocketeerTools.java does not register. `
      + "A keep-list never warns about a name nothing serves, so this typo would cost the session "
      + `that tool in silence. Registered: ${[...new Set(registered)].join(", ")}`);
  }
  console.log(`\n  cross-checked against RocketeerTools.java: ${[...new Set(registered)].join(", ")}\n`);
});
