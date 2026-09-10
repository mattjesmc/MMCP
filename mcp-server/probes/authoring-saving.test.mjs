// What `tool_surface {profile:"authoring"}` actually removes — proved, not asserted.
//
// The claim this defends is the reason the tool exists: the static tool prefix is 50-92% of a
// session's bill (TOKEN_PER_TOOL_FINDINGS.md Finding 1), and narrowing the served list to the job is
// the largest lever the shim has. A claim that size should not live only in a changelog.
//
// WHAT THIS PROBE IS, AND WHAT IT IS NOT. It drives the REAL shim against a PINNED CAPTURE of a real
// manifest — fixtures/manifest-2026-09-06.json, 96 tools, taken live from a dev CLIENT in a world on
// 2026-09-06 (toolkit 0.124.0); before it, manifest-2026-08-28.json (94 tools).
// So it proves the MECHANISM: this keep-list, against that manifest, produces this reduction, and it
// will keep proving it with no game running. It does NOT track the live figure, and must not be read
// as doing so — the live manifest grows tools the capture has never heard of. When the recorded
// number needs to be current, re-measure against a live bridge and re-capture; this file only
// guarantees that the mechanism has not quietly stopped working in between.
//
// That distinction is the whole reason the file says which capture it holds. A pinned number that
// silently becomes the live number's stand-in is the same staleness failure this afternoon produced
// three times over, wearing a test's clothes.
//
// THE NUMBER'S SITE OF RECORD IS THE KEEP_PROFILES COMMENT IN index.mjs. It is not repeated here, on
// purpose: a figure maintained in three places is maintained in one and stale in two. What this file
// asserts is shape and a floor — exact membership, and a reduction that cannot quietly collapse —
// and it PRINTS the exact figures so a human updating the record has them without re-deriving.
//
// Run: node --test probes/authoring-saving.test.mjs

import { test } from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { localTools } from "../local/registry.mjs";

// Every shim spawned here sets MCPTK_BLOCKBENCH="off": the Blockbench upstream is part of the
// `standard` surface now, and a probe about the BRIDGE manifest must not measure a different list
// depending on whether Blockbench happened to be open on the machine running it.
const HERE = dirname(fileURLToPath(import.meta.url));
const SHIM = join(HERE, "..", "index.mjs");
const CAPTURE = "manifest-2026-09-06.json";
const MANIFEST = JSON.parse(readFileSync(join(HERE, "fixtures", CAPTURE), "utf8"));

// The floor, not the figure. A description edit moves the exact character count by a few hundred and
// must not fail a probe; the keep-list quietly regrowing until the profile saves nothing must.
const MIN_REDUCTION = 0.65;

async function startStubBridge() {
  const http = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(req.url === "/tools" ? JSON.stringify(MANIFEST) : "{}");
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  return {
    base: `http://127.0.0.1:${http.address().port}`,
    close: () => new Promise((r) => http.close(r)),
  };
}

test(`authoring narrows a real captured manifest (${CAPTURE})`, async (t) => {
  const bridge = await startStubBridge();
  const child = spawn(process.execPath, [SHIM], {
    env: { ...process.env, MCPTK_URL: bridge.base, MCPTK_PROFILE: "standard", MCPTK_HIDE_TOOLS: "", MCPTK_BLOCKBENCH: "off" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(async () => { child.kill(); await bridge.close(); });

  const inbox = [];
  let buf = "";
  let stderr = "";
  child.stdout.on("data", (d) => {
    buf += d.toString();
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const l of lines) {
      if (!l.trim().startsWith("{")) continue;
      try { inbox.push(JSON.parse(l)); } catch { /* partial/foreign line */ }
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
        reject(new Error(`timed out waiting for ${what}; stderr:\n${stderr}`));
      }
    }, 40).unref();
  });

  let id = 0;
  const rpc = async (method, params) => {
    const mine = ++id;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: mine, method, params })}\n`);
    const r = await wait((m) => m.id === mine, method);
    if (r.error) throw new Error(`${method}: ${JSON.stringify(r.error)}`);
    return r.result;
  };

  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0", id: ++id, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "probe", version: "0" } },
  })}\n`);
  await wait((m) => m.id === 1, "initialize");
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  const price = (tools) => JSON.stringify(tools).length;
  const std = (await rpc("tools/list", {})).tools;
  const switched = JSON.parse(
    (await rpc("tools/call", { name: "tool_surface", arguments: { profile: "authoring" } }))
      .content[0].text);
  const auth = (await rpc("tools/list", {})).tools;

  const reduction = (price(std) - price(auth)) / price(std);
  console.log(`\n  capture ${CAPTURE} — ${MANIFEST.length} bridge tools`);
  console.log("                  tools     chars   ~tokens");
  for (const [label, list] of [["standard", std], ["authoring", auth]]) {
    console.log(`    ${label.padEnd(10)}${String(list.length).padStart(6)}`
      + `${String(price(list)).padStart(10)}${String(Math.round(price(list) / 4)).padStart(10)}`);
  }
  console.log(`    saved     ${String(std.length - auth.length).padStart(6)}`
    + `${String(price(std) - price(auth)).padStart(10)}`
    + `${String(Math.round((price(std) - price(auth)) / 4)).padStart(10)}`
    + `   (${(100 * reduction).toFixed(1)}%)\n`);

  // MEMBERSHIP, derived rather than hardcoded. The expected set is "every name the keep-list asks for
  // that this environment actually has" — the capture's tools plus this checkout's local tools — so a
  // machine without a dev checkout (no launch_game) is a different count, not a failure. Hardcoding
  // 32 here would couple the probe to one environment, which is how probes in this repo have lied
  // before.
  const available = new Set([...MANIFEST.map((x) => x.name), ...localTools().map((x) => x.name)]);
  const served = new Set(auth.map((x) => x.name));
  assert.ok(served.has("tool_surface"), "the way back out must survive the narrowing");
  for (const name of served) {
    if (name === "tool_surface") continue;
    assert.ok(available.has(name), `authoring served "${name}", which is in no manifest`);
  }

  // The expensive surface is what it is meant to drop: `locate` and `get_events` are the two largest
  // entries in the manifest and neither is authoring surface.
  for (const gone of ["locate", "get_events", "bot_body", "check_path", "sense_entities"]) {
    if (!available.has(gone)) continue; // absent from this capture is not a failure
    assert.ok(!served.has(gone), `authoring must not serve "${gone}"`);
  }
  // ...and the surface it exists to keep is intact.
  for (const kept of ["set_blocks", "capture_structure", "push_data", "describe_box", "undo_edit"]) {
    assert.ok(served.has(kept), `authoring must serve "${kept}"`);
  }

  // THE FLOOR. Not the figure — see the header.
  assert.ok(reduction >= MIN_REDUCTION,
    `authoring cut only ${(100 * reduction).toFixed(1)}% of the served list `
    + `(floor ${(100 * MIN_REDUCTION).toFixed(0)}%). The keep-list has grown, or the profile stopped `
    + `applying. Re-read the KEEP_PROFILES comment in index.mjs — it holds the recorded figure.`);

  // The tool's own arithmetic must agree with what the client can see, or its result is decoration.
  assert.strictEqual(switched.tools, auth.length, "tool_surface must report the list it actually serves");
  assert.strictEqual(switched.was_tools, std.length, "tool_surface must report the list it replaced");
  assert.ok(switched.saves_per_turn_tokens > 0, "a switch that saves nothing is not a switch");
});
