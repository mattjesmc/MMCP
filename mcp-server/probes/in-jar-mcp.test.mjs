// Live probes for THE GAME'S OWN MCP SERVER (toolkit 0.146.0, mcp/McpEndpoint,
// docs/platform/IN_JAR_MCP_DESIGN.md) — the door in the jar, at `<bridge>/mcp`.
//
// THIS FILE DOES NOT USE THE SHIM, and that is the point of it. Every other probe here drives
// `/cmd`, which is the door the Node server speaks to; nothing in the suite touched `/mcp`, so a
// regression in the newer door would have gone all the way to a release without a red anywhere.
// The calls below are plain `fetch` at the MCP endpoint, shaped the way a client shapes them.
//
// What it guards, in the order the design record makes the claims:
//
//   1. The handshake a client judges the server on before it asks for anything: initialize, the
//      session header, the negotiated version, `tools.listChanged:false`.
//   2. THE URL IS THE SURFACE (section 4) — `/mcp`, `/mcp/observe` and `/mcp/modding` serve
//      different lists out of one port, `observe` is computed from the mechanism stamp, and a
//      surface that does not exist is a 404 that names the ones that do.
//   3. ONE DISPATCH CHOKEPOINT (section 3) — a call through this door gets the argument gate, the
//      mechanism stamp and an AUDIT RECORD ATTRIBUTED TO THE SESSION THE DOOR MINTED. That last one
//      is the claim worth the most: it is what says the newer door cannot be a way to act
//      unrecorded.
//   4. The transport rules that have no equivalent on `/cmd`: 405 for the stream this server does
//      not open, 404 for a session that has gone, 202 for a body that was only notifications, and
//      the loopback-origin refusal.
//
// Site: `run_command say …` and reads. Nothing is staged, nothing is placed, so this file cannot
// collide with another probe's site. Needs the dev server; skips when the bridge is down.
// Run with `npm run test:live`.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const MCP = `${BASE}/mcp`;

let id = 0;

/** One JSON-RPC request at `path`, with the session header when there is one. */
async function rpc(path, method, params = {}, session = null, extraHeaders = {}) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...extraHeaders,
  };
  if (session) headers["Mcp-Session-Id"] = session;
  const res = await fetch(path, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = res.status === 202 ? null : await res.json();
  return { status: res.status, session: res.headers.get("mcp-session-id"), body };
}

/** A fresh MCP session on `path`, as a client opens one. */
async function open(path = MCP) {
  const r = await rpc(path, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "probe-in-jar-mcp", version: "1" },
  });
  assert.equal(r.status, 200, `initialize at ${path}: ${JSON.stringify(r.body)}`);
  assert.ok(r.session, "initialize must hand back an Mcp-Session-Id");
  return { id: r.session, result: r.body.result };
}

/** The text part of a tools/call result, parsed when it is JSON. */
function payload(callResult) {
  const parts = callResult.content ?? [];
  const text = parts.filter((p) => p.type === "text").at(-1)?.text ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok)
  .catch(() => false);
const mcpUp = bridgeUp
  && await fetch(MCP, { method: "POST", headers: { "Content-Type": "application/json" },
    body: '{"jsonrpc":"2.0","id":0,"method":"ping"}', signal: AbortSignal.timeout(2000) })
    .then((r) => r.ok)
    .catch(() => false);
if (!bridgeUp) {
  console.log(`\n  [skip] no bridge at ${BASE} — start the dev server to run these probes\n`);
} else if (!mcpUp) {
  console.log(`\n  [skip] the bridge at ${BASE} serves no /mcp — older toolkit, or mcp.enabled=false\n`);
}

describe("in-jar MCP: the handshake", { skip: !mcpUp }, () => {
  test("initialize negotiates, identifies the build, and promises no notifications", async () => {
    const { result } = await open();
    assert.equal(result.protocolVersion, "2025-06-18");
    assert.equal(result.serverInfo.name, "mcp-toolkit");
    assert.match(result.serverInfo.version, /^\d+\.\d+\.\d+/,
      `serverInfo.version should be the toolkit version: ${JSON.stringify(result.serverInfo)}`);
    assert.equal(result.capabilities.tools.listChanged, false,
      "the registry is filled at mod init; declaring listChanged would promise a notification that "
      + "is never sent, and a client would wire a refresh that never fires");
    assert.ok(result.instructions?.includes("RUNNING Minecraft game"),
      "a session meets the charter paragraph before its first call");
  });

  test("ping is answered, and an unknown method is -32601 rather than a hang", async () => {
    const s = await open();
    assert.deepEqual((await rpc(MCP, "ping", {}, s.id)).body.result, {});
    const r = await rpc(MCP, "resources/list", {}, s.id);
    assert.equal(r.body.error.code, -32601, JSON.stringify(r.body));
  });
});

describe("in-jar MCP: the URL is the surface", { skip: !mcpUp }, () => {
  test("one port serves three lists, and observe is exactly the reads", async () => {
    const lists = {};
    for (const name of ["", "/observe", "/modding"]) {
      const path = MCP + name;
      const s = await open(path);
      const r = await rpc(path, "tools/list", {}, s.id);
      lists[name || "/full"] = r.body.result.tools;
    }
    assert.ok(lists["/full"].length > 0, "the full surface serves the registry");
    assert.ok(lists["/observe"].length < lists["/full"].length,
      `observe must be narrower than full: ${lists["/observe"].length} vs ${lists["/full"].length}`);
    assert.ok(lists["/modding"].length < lists["/full"].length);

    // `observe` is COMPUTED from the mechanism stamp, so the manifest can falsify it directly
    // rather than the probe re-stating a list. This is the check a keep-list cannot have.
    const manifest = await fetch(`${BASE}/tools`).then((r) => r.json());
    const reads = new Set(manifest.filter((t) => t.mechanism === "observe").map((t) => t.name));
    const served = new Set(lists["/observe"].map((t) => t.name));
    assert.deepEqual([...served].filter((n) => !reads.has(n)), [],
      "observe served something the registry does not call a read");
    assert.deepEqual([...reads].filter((n) => !served.has(n)), [],
      "observe withheld a read the registry has");
  });

  test("a tool the surface hides is a readable refusal, not a protocol error", async () => {
    const s = await open(`${MCP}/observe`);
    const r = await rpc(`${MCP}/observe`, "tools/call",
      { name: "set_blocks", arguments: {} }, s.id);
    assert.equal(r.status, 200);
    assert.equal(r.body.error, undefined, "a refusal the model must READ cannot be a JSON-RPC error");
    assert.equal(r.body.result.isError, true);
    assert.match(payload(r.body.result), /not served by the "observe" surface/);
  });

  test("a surface that does not exist names the ones that do", async () => {
    const res = await fetch(`${MCP}/not-a-surface`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(res.status, 404);
    const message = (await res.json()).error.message;
    assert.match(message, /full/);
    assert.match(message, /observe/);
  });

  test("a live session cannot be moved to another surface", async () => {
    const s = await open(MCP);
    const r = await rpc(`${MCP}/observe`, "tools/list", {}, s.id);
    assert.equal(r.status, 400, "one session id cannot mean two surfaces");
  });
});

describe("in-jar MCP: the same dispatch chokepoint as /cmd", { skip: !mcpUp }, () => {
  test("a call reaches the live game and carries its mechanism stamp", async () => {
    const s = await open();
    const r = await rpc(MCP, "tools/call", { name: "ping", arguments: {} }, s.id);
    const ping = payload(r.body.result);
    assert.equal(r.body.result.isError, false);
    assert.equal(ping.pong, true, JSON.stringify(ping));
    assert.equal(ping.mechanism, "observe", "every reply declares the authority class of the act");
    assert.ok(ping.port, "this is the running instance answering, not a mock");
  });

  test("the argument gate refuses through this door too, with the same message", async () => {
    const s = await open();
    const r = await rpc(MCP, "tools/call",
      { name: "locate", arguments: { what: "minecraft:stone", center: { x: 0, y: 64, z: 0 } } }, s.id);
    assert.equal(r.body.result.isError, true, JSON.stringify(r.body.result));
    const text = payload(r.body.result);
    assert.match(text, /no argument `center`/);
    assert.match(text, /was NOT run/,
      "the gate must refuse BEFORE the call runs, on either door");
  });

  test("a privileged act is AUDITED, attributed to the session this door minted", async () => {
    const s = await open();
    const marker = `in-jar-mcp probe ${Date.now()}`;
    const act = await rpc(MCP, "tools/call",
      { name: "run_command", arguments: { command: `say ${marker}` } }, s.id);
    assert.equal(act.body.result.isError, false, JSON.stringify(act.body.result));
    assert.equal(payload(act.body.result).mechanism, "privileged");

    const events = await rpc(MCP, "tools/call",
      { name: "get_events", arguments: { type: "audit", limit: 40 } }, s.id);
    const rows = payload(events.body.result).events ?? [];
    const mine = rows.filter((e) => e.data?.tool === "run_command"
      && JSON.stringify(e.data?.args ?? {}).includes(marker));
    assert.equal(mine.length, 1, `the act should appear once in the audit: ${rows.length} row(s) read`);
    assert.ok(mine[0].data.session,
      "an MCP client's act must be attributable — an unattributed privileged call through the "
      + "newer door is exactly what the shared chokepoint exists to prevent");
  });
});

describe("in-jar MCP: the transport rules", { skip: !mcpUp }, () => {
  test("GET is 405 — the stream this server does not open", async () => {
    const res = await fetch(MCP, { headers: { Accept: "text/event-stream" } });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "POST, DELETE");
  });

  test("a notification alone is 202 with no body", async () => {
    const s = await open();
    const res = await fetch(MCP, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Mcp-Session-Id": s.id },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    assert.equal(res.status, 202);
    assert.equal(await res.text(), "");
  });

  test("DELETE ends the session and the next call is a 404 the client recovers from", async () => {
    const s = await open();
    const gone = await fetch(MCP, { method: "DELETE", headers: { "Mcp-Session-Id": s.id } });
    assert.equal(gone.status, 200);
    assert.equal((await rpc(MCP, "tools/list", {}, s.id)).status, 404,
      "404 is the spec's own answer: it tells the client to start a new session");
  });

  test("a page on the internet cannot drive somebody's game", async () => {
    const res = await fetch(MCP, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    assert.equal(res.status, 403, "the DNS-rebinding rule, and the origin is what a page cannot forge");
  });

  test("an unsupported protocol version is refused with the ones we speak", async () => {
    const r = await rpc(MCP, "ping", {}, null, { "MCP-Protocol-Version": "1999-01-01" });
    assert.equal(r.status, 400);
    assert.match(r.body.error.message, /2025-06-18/);
  });
});
