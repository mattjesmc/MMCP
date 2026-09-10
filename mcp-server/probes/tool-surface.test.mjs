// A session must be able to narrow itself to its job, live.
//
// The static tool prefix is 50-92% of a session's bill (TOKEN_PER_TOOL_FINDINGS.md Finding 1), and
// until 0.98.0 made the tool list changeable mid-session the only lever was MCPTK_PROFILE in
// `.mcp.json` — a choice made before the session exists, which is before anyone knows what the job
// is. `tool_surface` moves that choice to the moment the job arrives.
//
// What must hold, and what this file defends:
//   1. the verb is served, and reports the surface it is on;
//   2. a switch actually narrows what is served AND what is callable;
//   3. the client is told immediately — a deliberate switch is not a flap and does not wait out the
//      notification floor;
//   4. a tool the switch dropped refuses with `profile_hidden`, not "Unknown tool" — the client
//      holds a stale list for a moment and the caller must not go hunting a toolkit bug;
//   5. the verb SURVIVES its own narrowing, so an agent cannot strand itself;
//   6. MCPTK_HIDE_TOOLS survives a switch — it is the bench's with/without arm, and a session that
//      re-profiled itself back into its own removed condition would report the wrong arm;
//   7. under `survival` the verb is ABSENT, because there the profile is a legality contract rather
//      than a preference (SURVIVAL_MODE_PLAN.md §3).
//
// Needs no game: a stub bridge on an ephemeral port supplies the manifest. The harness below is
// deliberately a copy of tool-list-changed.test.mjs's rather than a shared import — probes in this
// directory stand alone, so one can be run, edited or deleted without disturbing another.
//
// Run: node --test probes/tool-surface.test.mjs

import { test } from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIM = join(HERE, "..", "index.mjs");

// Real names on purpose: `set_blocks` is in the authoring keep-set and `locate` is the most expensive
// entry in the manifest and not in it, so the narrowing under test is the real one.
const KEPT = "set_blocks";
const DROPPED = "locate";

function toolDef(name) {
  return {
    name,
    description: `stub tool ${name}`,
    mechanism: "read",
    inputSchema: { type: "object", properties: {} },
  };
}

async function startStubBridge() {
  let manifest = [KEPT, DROPPED, "describe_box", "get_events"].map(toolDef);
  const http = createServer((req, res) => {
    if (req.url === "/tools" && manifest) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(manifest));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  return {
    base: `http://127.0.0.1:${http.address().port}`,
    serve: (names) => { manifest = names && names.map(toolDef); },
    close: () => new Promise((r) => http.close(r)),
  };
}

function startShim(base, env, onMessage) {
  const child = spawn(process.execPath, [SHIM], {
    env: { ...process.env, MCPTK_URL: base, MCPTK_HIDE_TOOLS: "", MCPTK_BLOCKBENCH: "off", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d.toString();
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim().startsWith("{")) continue;
      try { onMessage(JSON.parse(line)); } catch { /* partial/foreign line */ }
    }
  });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d.toString(); });
  return {
    send: (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`),
    stderr: () => stderr,
    kill: () => child.kill(),
  };
}

/** An initialized shim plus the few verbs these tests need against it. */
async function connect(t, env = {}) {
  const bridge = await startStubBridge();
  const inbox = [];
  const waiters = [];
  const shim = startShim(bridge.base, env, (msg) => {
    inbox.push(msg);
    for (const w of [...waiters]) {
      if (!w.match(msg)) continue;
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(msg);
    }
  });
  t.after(async () => { shim.kill(); await bridge.close(); });

  const expect = (match, what, ms = 20_000) =>
    new Promise((resolve, reject) => {
      const hit = inbox.find(match);
      if (hit) return resolve(hit);
      const w = { match, resolve };
      waiters.push(w);
      setTimeout(() => {
        if (!waiters.includes(w)) return;
        waiters.splice(waiters.indexOf(w), 1);
        reject(new Error(`timed out waiting for ${what}; stderr:\n${shim.stderr()}`));
      }, ms).unref();
    });

  let id = 100;
  const rpc = async (method, params, what = method) => {
    const mine = ++id;
    shim.send({ jsonrpc: "2.0", id: mine, method, params });
    const r = await expect((m) => m.id === mine, what);
    if (r.error) throw new Error(`${method} failed: ${JSON.stringify(r.error)}`);
    return r.result;
  };

  shim.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "probe", version: "0" },
    },
  });
  await expect((m) => m.id === 1, "initialize");
  shim.send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const list = async () => new Set((await rpc("tools/list", {})).tools.map((x) => x.name));
  const call = async (name, args) => {
    const r = await rpc("tools/call", { name, arguments: args ?? {} }, `call ${name}`);
    return { isError: r.isError === true, text: r.content?.[0]?.text ?? "" };
  };
  return { bridge, shim, inbox, expect, list, call };
}

const NOTIFY = (m) => m.method === "notifications/tools/list_changed";

test("tool_surface narrows the session to its job, and cannot strand it", async (t) => {
  const s = await connect(t, { MCPTK_PROFILE: "full" });

  // (1) The verb is served, and reports the surface it is standing on.
  const before = await s.list();
  assert.ok(before.has("tool_surface"), "tool_surface must be served");
  assert.ok(before.has(DROPPED), `${DROPPED} is served under full`);

  const report = JSON.parse((await s.call("tool_surface")).text);
  assert.strictEqual(report.profile, "full");
  // `available` became a TABLE at 0.107.0 (RELEASE_1.md §C4): a caller reading bare names had to
  // already know the answer to use it, and nothing told it that three of the names are research
  // surface. One row per profile — name, kind, role — from the same PROFILE_META the start-up
  // stderr line and `ping` read, so there is no second copy to go stale.
  const offered = new Map(report.available.map((a) => [a.profile, a]));
  assert.ok(offered.has("authoring"), "authoring must be offered");
  assert.ok(!offered.has("survival"), "survival is a launch contract, not a destination");
  assert.strictEqual(offered.get("authoring").kind, "dev", "authoring is a supported dev role");
  assert.ok(offered.get("authoring").role, "every offered profile says what it is FOR");
  assert.strictEqual(offered.get("survey").experimental, true,
    "a research profile must be marked experimental where a session can see it");
  assert.strictEqual(offered.get("modding").kind, "dev");
  assert.ok(!("experimental" in offered.get("modding")),
    "a supported role must not be marked experimental");
  assert.ok(report.chars > 0 && report.tools === before.size, "the report must price the real list");

  // (2)+(3) The switch narrows the served list, and says so immediately. A deliberate switch is not
  // a flap: it must NOT sit behind the 30s notification floor.
  const seenBefore = s.inbox.filter(NOTIFY).length;
  const res = JSON.parse((await s.call("tool_surface", { profile: "authoring" })).text);
  assert.strictEqual(res.profile, "authoring");
  assert.strictEqual(res.was, "full");
  assert.ok(res.chars < res.was_chars, "authoring must be cheaper than full");
  assert.ok(res.saves_per_turn_tokens > 0, "the result must price what the switch saves");
  assert.ok(res.dropped.includes(DROPPED), `${DROPPED} must be reported as dropped`);
  assert.strictEqual(res.notified, "sent", "a deliberate switch notifies at once, floor or no floor");
  await s.expect(NOTIFY, "tools/list_changed after the switch", 5_000);
  assert.ok(s.inbox.filter(NOTIFY).length > seenBefore, "the client must be told to re-read");

  // (2 cont.) and the narrowing is real in BOTH directions — listed and callable.
  const after = await s.list();
  assert.ok(!after.has(DROPPED), `${DROPPED} must be gone from the served list`);
  assert.ok(after.has(KEPT), `${KEPT} is authoring surface and must stay`);
  assert.ok(after.size < before.size, "the list must actually be smaller");

  // (4) A stale client calling a dropped tool must learn WHY, not meet "Unknown tool".
  const refused = await s.call(DROPPED);
  assert.ok(refused.isError, "a dropped tool must refuse");
  assert.match(refused.text, /profile_hidden/, "the refusal must name the cause, not read as a bug");
  assert.match(refused.text, /tool_surface/, "the refusal must name the way out");

  // (5) The escape hatch survives its own narrowing.
  assert.ok(after.has("tool_surface"), "tool_surface must never be hidden by a profile");
  const back = JSON.parse((await s.call("tool_surface", { profile: "full" })).text);
  assert.strictEqual(back.profile, "full");
  assert.ok((await s.list()).has(DROPPED), "widening must restore the surface");
});

test("a profile switch cannot undo the operator's ablation hides", async (t) => {
  // MCPTK_HIDE_TOOLS is the bench's with/without arm. A session that could re-profile itself back
  // into surface its experimental condition removed would silently report the wrong arm.
  const s = await connect(t, { MCPTK_PROFILE: "full", MCPTK_HIDE_TOOLS: KEPT });
  assert.ok(!(await s.list()).has(KEPT), "the env hide applies at launch");
  await s.call("tool_surface", { profile: "authoring" });
  assert.ok(!(await s.list()).has(KEPT), `${KEPT} is authoring surface, but the env hide outranks it`);
  const refused = await s.call(KEPT);
  assert.match(refused.text, /Unknown tool/, "an env-hidden tool stays unknown, not merely unserved");
});

test("under survival the verb is absent, not refused", async (t) => {
  // The survival profile is the legality contract the session was launched under, not a preference.
  // A body that could re-profile itself would be choosing its own legality, so the verb never exists.
  const s = await connect(t, { MCPTK_PROFILE: "survival" });
  assert.ok(!(await s.list()).has("tool_surface"), "survival must not be offered the switch");
  const refused = await s.call("tool_surface", { profile: "full" });
  assert.ok(refused.isError, "and calling it anyway must fail");
  assert.match(refused.text, /Unknown tool/, "absent, not profile_hidden — it does not exist here");
});
