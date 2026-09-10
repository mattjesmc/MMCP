// The tool list must stay current WITHOUT restarting the client.
//
// tools/list is a snapshot and the client takes exactly one, at connect. In this workspace the game
// routinely boots after the session does (`launch_game` exists for that), so the snapshot said
// "local tools only" and the bridge's tools were invisible until Claude itself was restarted. The
// fix is two things that only work together, and this probe defends both:
//
//   1. the server DECLARES `capabilities.tools.listChanged` — Claude Code registers its refresh
//      handler only if that flag is present, so without it the notification is never even listened
//      for, and
//   2. the watcher NOTICES the manifest changing and sends notifications/tools/list_changed.
//
// It needs no game: it stands up a stub bridge on an ephemeral port whose /tools answer this file
// controls, which is the only way to make the down -> up transition happen on demand.
//
// Run: node --test probes/tool-list-changed.test.mjs

import { test } from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIM = join(HERE, "..", "index.mjs");

/** A tool entry shaped like the mod's manifest rows. */
function toolDef(name) {
  return {
    name,
    description: `stub tool ${name}`,
    mechanism: "read",
    inputSchema: { type: "object", properties: {} },
  };
}

/** A stub bridge whose manifest is swappable; `manifest = null` answers as if the game were down. */
async function startStubBridge() {
  let manifest = null;
  const http = createServer((req, res) => {
    if (req.url === "/tools" && manifest) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(manifest));
      return;
    }
    // /hello, /heartbeat and a down-game /tools: the shim must tolerate all three.
    res.writeHead(manifest ? 200 : 503, { "Content-Type": "application/json" });
    res.end(manifest ? "{}" : `{"error":"game down"}`);
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  return {
    base: `http://127.0.0.1:${http.address().port}`,
    serve: (names) => { manifest = names && names.map(toolDef); },
    close: () => new Promise((r) => http.close(r)),
  };
}

/** Drive the shim over stdio: JSON-RPC in, one callback per parsed message out. */
function startShim(base, onMessage) {
  const child = spawn(process.execPath, [SHIM], {
    env: { ...process.env, MCPTK_URL: base, MCPTK_PROFILE: "full", MCPTK_HIDE_TOOLS: "", MCPTK_BLOCKBENCH: "off" },
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

test("the client is told when the game's tools appear", async (t) => {
  const bridge = await startStubBridge();
  bridge.serve(null); // the game is not up yet — exactly the situation that produced the bug

  const inbox = [];
  const waiters = [];
  const shim = startShim(bridge.base, (msg) => {
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

  shim.send({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "probe", version: "0" },
    },
  });
  const init = await expect((m) => m.id === 1, "initialize");

  // (1) Without this flag Claude Code never registers a tools/list_changed handler, so everything
  // below would be a notification shouted into a room with nobody in it.
  assert.strictEqual(
    init.result.capabilities?.tools?.listChanged, true,
    "server must declare tools.listChanged or the client will not listen for the refresh",
  );

  shim.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  shim.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const first = await expect((m) => m.id === 2, "the first tools/list");
  const firstNames = new Set(first.result.tools.map((tt) => tt.name));
  assert.ok(!firstNames.has("stub_alpha"), "the stub bridge is down; its tools must not be listed");
  assert.ok(firstNames.size > 0, "local tools stay available while the bridge is down");

  // (2) The game boots. Nothing else happens — no new client, no restart, no tool call.
  bridge.serve(["stub_alpha", "stub_beta"]);
  await expect((m) => m.method === "notifications/tools/list_changed", "the list_changed notification");

  shim.send({ jsonrpc: "2.0", id: 3, method: "tools/list" });
  const second = await expect((m) => m.id === 3, "the refreshed tools/list");
  const secondNames = new Set(second.result.tools.map((tt) => tt.name));
  assert.ok(secondNames.has("stub_alpha"), "the re-read list must carry the game's tools");
  assert.ok(secondNames.has("stub_beta"));

  // One change is one notification: a client that re-read is in sync, and the watcher must go quiet
  // rather than re-announce the same list on every poll.
  const before = inbox.filter((m) => m.method === "notifications/tools/list_changed").length;
  await new Promise((r) => setTimeout(r, 8_000));
  const after = inbox.filter((m) => m.method === "notifications/tools/list_changed").length;
  assert.strictEqual(after, before, "an unchanged manifest must not keep notifying");

  // ...and the game going away is a change too, or the session would go on advertising tools that
  // are no longer there. But NOT INSTANTLY. A notification the client honours rewrites the tool
  // block at the front of the prompt: it costs a full re-read of the served list (~39.4k tokens live) plus the
  // prompt cache from that point on. One boot is worth that; a surface that flaps is not, so a
  // change arriving inside NOTIFY_FLOOR_MS is HELD — and then still delivered, because holding it
  // forever would be the original bug wearing a different hat.
  const notes = () => inbox.filter((m) => m.method === "notifications/tools/list_changed").length;
  const heldFrom = notes();
  bridge.serve(null);
  await new Promise((r) => setTimeout(r, 12_000));
  assert.strictEqual(notes(), heldFrom, "a change inside the floor must be held, not sent");

  const deadline = Date.now() + 45_000;
  while (notes() === heldFrom && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
  assert.ok(notes() > heldFrom, `the held notification must land once the floor lifts; stderr:\n${shim.stderr()}`);

  shim.send({ jsonrpc: "2.0", id: 4, method: "tools/list" });
  const third = await expect((m) => m.id === 4, "the tools/list after the game went away");
  assert.ok(
    !third.result.tools.some((tt) => tt.name === "stub_alpha"),
    "the re-read list must have dropped the tools of a game that is gone",
  );
});
