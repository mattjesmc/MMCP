// mmcpd, step 1 of HOST_DESIGN.md section 15: two agent sessions on two projects through ONE daemon,
// each with its own profile and its own memory; kill one and the other is untouched; the operator
// can switch a session's profile from outside and the client is told to re-read its list.
//
// NO GAME NEEDED. The two projects are throwaway roots naming ports nothing listens on, so each
// session's shim serves local tools only - which is exactly the shim's honest behaviour with the
// bridge down, and everything asserted here is about the DAEMON: the door, the table, the isolation,
// the profile per session, the memory root per project. No Blockbench is spawned either: the
// profiles used never dial it, and the instance is spawned on first touch only. What this cannot
// see - a session's shim actually reaching a game, an owned Blockbench instance coming up - is the
// live check recorded in HOST_DESIGN.md section 15.1.
//
// Battery chunk b. Run alone: node --test probes/daemon.test.mjs

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

const freePort = () => new Promise((resolve, reject) => {
  const s = createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

const home = mkdtempSync(join(tmpdir(), "mmcpd-probe-"));
const roots = { alpha: join(home, "alpha"), beta: join(home, "beta") };
for (const [name, root] of Object.entries(roots)) {
  mkdirSync(join(root, "src", "main", "resources"), { recursive: true });
  writeFileSync(join(root, "gradle.properties"), `mcmod.port=${name === "alpha" ? 25997 : 25998}\n`);
  writeFileSync(join(root, "src", "main", "resources", "fabric.mod.json"), "{}");
}
process.env.MMCP_HOME = home;

let daemon;
let port;
let base;
const api = async (method, path, body) => {
  const res = await fetch(`${base}${path}`, {
    method, headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

async function connect(project, { profile, name = "probe" } = {}) {
  const url = new URL(`${base}/mcp/${project}${profile ? `?profile=${profile}` : ""}`);
  const client = new Client({ name, version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(url);
  await client.connect(transport);
  return { client, transport, sid: transport.sessionId };
}

const surface = async (client) => {
  const r = await client.callTool({ name: "tool_surface", arguments: {} });
  return JSON.parse(r.content.find((c) => c.type === "text").text);
};

describe("mmcpd", () => {
  before(async () => {
    port = await freePort();
    process.env.MMCPD_PORT = String(port);
    const { Daemon } = await import("../daemon.mjs");
    const { loadRegistry, saveRegistry, addProject, scanProject } = await import("../daemon/registry.mjs");
    const reg = loadRegistry();
    for (const root of Object.values(roots)) addProject(reg, scanProject(root));
    saveRegistry(reg);
    // Reaper thresholds shrunk so the "client gone" rule can be watched here; reap() is called by hand.
    daemon = new Daemon({ port, orphanMs: 300, idleMs: 60_000 });
    await daemon.start();
    base = `http://127.0.0.1:${port}`;
  });
  after(async () => {
    for (const id of [...daemon.sessions.keys()]) daemon.drop(id, "probe over");
    daemon.server?.close();
    clearInterval(daemon.reaper);
    await new Promise((r) => setTimeout(r, 300));
    rmSync(home, { recursive: true, force: true });
  });

  test("status names the daemon and both registered projects", async () => {
    const { status, body } = await api("GET", "/status");
    assert.equal(status, 200);
    assert.equal(body.daemon, "mmcpd");
    assert.equal(body.projects, 2);
    const projects = (await api("GET", "/projects")).body.projects;
    assert.deepEqual(projects.map((p) => p.name).sort(), ["alpha", "beta"]);
    assert.equal(projects.find((p) => p.name === "alpha").port, 25997);
    assert.equal(projects.find((p) => p.name === "alpha").state, "down");
    assert.equal(projects.find((p) => p.name === "alpha").url, `${base}/mcp/alpha`);
  });

  test("a page's Origin is refused, a program's absence of one is not", async () => {
    const res = await fetch(`${base}/status`, { headers: { Origin: "http://evil.example" } });
    assert.equal(res.status, 403);
    const ok = await fetch(`${base}/status`, { headers: { Origin: "http://localhost:3000" } });
    assert.equal(ok.status, 200);
  });

  test("an unknown project is a 404 that names the registered ones", async () => {
    const res = await fetch(`${base}/mcp/nope`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: "{}" });
    assert.equal(res.status, 404);
    assert.match((await res.json()).error, /alpha, beta/);
  });

  test("two sessions on two projects: each sees its own profile, memory and client; killing one leaves the other", async () => {
    const a = await connect("alpha", { profile: "inspect", name: "probe-a" });
    const b = await connect("beta", { name: "probe-b" });
    assert.ok(a.sid && b.sid && a.sid !== b.sid, "two distinct daemon session ids");
    assert.match(a.sid, /^mmcp-[0-9a-f]{8}$/);

    // Each child serves its own slice: `inspect` is a keep-list, `modding` is the shim's default.
    const toolsA = (await a.client.listTools()).tools.map((t) => t.name);
    const toolsB = (await b.client.listTools()).tools.map((t) => t.name);
    assert.ok(toolsA.includes("tool_surface") && toolsB.includes("tool_surface"));
    assert.ok(toolsB.includes("launch_game"), "modding keeps launch_game (a local tool, served with the bridge down)");
    assert.ok(!toolsA.includes("launch_game"), "inspect does not keep launch_game");
    assert.equal((await surface(a.client)).profile, "inspect");
    assert.equal((await surface(b.client)).profile, "modding");

    // The table: two rows, distinct projects, memory roots per project, the client's declared name.
    const rows = (await api("GET", "/sessions")).body.sessions;
    assert.equal(rows.length, 2);
    const rowA = rows.find((r) => r.id === a.sid);
    const rowB = rows.find((r) => r.id === b.sid);
    assert.equal(rowA.project, "alpha");
    assert.equal(rowB.project, "beta");
    assert.equal(rowA.profile, "inspect");
    assert.equal(rowB.profile, "modding");
    assert.equal(rowA.client.name, "probe-a");
    assert.equal(rowB.client.name, "probe-b");
    assert.equal(rowA.memory, join(home, "memory", "alpha"));
    assert.equal(rowB.memory, join(home, "memory", "beta"));
    assert.notEqual(rowA.memory, rowB.memory);
    assert.ok(rowA.pid && rowB.pid && rowA.pid !== rowB.pid, "one shim process per session");
    assert.equal(rowA.last_call.tool, "tool_surface");
    assert.ok(rowA.streams >= 1, "the client's GET stream is held");
    // Each child was told which Blockbench is its own, and it is not the other's.
    assert.match(rowA.blockbench, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.notEqual(rowA.blockbench, rowB.blockbench);
    assert.equal((await api("GET", "/blockbench")).body.instances.length, 2, "a proxy per session, no instance spawned");
    assert.ok((await api("GET", "/blockbench")).body.instances.every((i) => i.pid === null && i.state === "idle"));

    // Kill A from outside. B keeps answering; A's client finds its session gone.
    const killed = await api("DELETE", `/sessions/${a.sid}`);
    assert.equal(killed.status, 200);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal((await api("GET", "/sessions")).body.sessions.length, 1);
    assert.equal((await surface(b.client)).profile, "modding");
    await assert.rejects(surface(a.client), /404|not found|session/i);
    assert.equal((await api("GET", "/blockbench")).body.instances.length, 1, "A's proxy went with A");
    await b.transport.terminateSession();
    await b.client.close();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await api("GET", "/sessions")).body.sessions.length, 0);
  });

  test("the operator switches a session's profile; the client is told to re-read and the report says what it cost", async () => {
    const c = await connect("alpha", { name: "probe-c" });
    let notified = 0;
    c.client.setNotificationHandler(ToolListChangedNotificationSchema, () => { notified++; });
    await c.client.listTools(); // the shim announces changes only to a client that has listed
    assert.equal((await surface(c.client)).profile, "modding");
    const sw = await api("POST", `/sessions/${c.sid}/profile`, { profile: "authoring" });
    assert.equal(sw.status, 200, JSON.stringify(sw.body));
    assert.equal(sw.body.report.profile, "authoring");
    assert.equal(sw.body.report.was, "modding");
    assert.ok(Array.isArray(sw.body.report.dropped));
    assert.equal((await surface(c.client)).profile, "authoring");
    const row = (await api("GET", `/sessions/${c.sid}`)).body.session;
    assert.equal(row.profile, "authoring");
    assert.equal(row.launched_as, null, "the URL named no profile; the switch is a served fact, not a launch one");
    for (let i = 0; i < 20 && !notified; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(notified, 1, "one tools/list_changed reached the client through the daemon's standalone stream");
    const bad = await api("POST", `/sessions/${c.sid}/profile`, { profile: "survival" });
    assert.equal(bad.status, 500);
    assert.match(bad.body.error, /unknown profile "survival"/);
    // Ending: `close()` sends no DELETE (the SDK client just drops its streams), so the session
    // stays until the daemon notices the stream is gone and nothing followed; `terminateSession()`
    // is the DELETE and ends it at once.
    await c.client.close();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await api("GET", "/sessions")).body.sessions.length, 1, "close() alone leaves the session (no DELETE)");
    daemon.reap();
    assert.equal((await api("GET", "/sessions")).body.sessions.length, 1, "...and 200 ms is not yet 'gone'");
    await new Promise((r) => setTimeout(r, 400));
    daemon.reap();
    assert.equal((await api("GET", "/sessions")).body.sessions.length, 0, "a client whose stream closed and stayed closed is gone");
    const e = await connect("alpha", { name: "probe-e" });
    await e.client.listTools();
    await e.transport.terminateSession();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await api("GET", "/sessions")).body.sessions.length, 0, "a client's DELETE ends its session at once");
    await e.client.close();
  });

  test("a session's log carries the shim's own stderr", async () => {
    const d = await connect("beta", { name: "probe-d" });
    await d.client.listTools();
    for (let i = 0; i < 20; i++) {
      const lines = (await api("GET", `/sessions/${d.sid}/log`)).body.lines;
      if (lines.some((l) => /profile: modding/.test(l))) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const lines = (await api("GET", `/sessions/${d.sid}/log`)).body.lines;
    assert.ok(lines.some((l) => /profile: modding/.test(l)), lines.join("\n"));
    assert.ok(lines.some((l) => /bridge unreachable/.test(l)), "the shim says the game is down, as it always has");
    await d.transport.terminateSession();
    await d.client.close();
  });

  test("the memory route names the per-project root", async () => {
    const { status, body } = await api("GET", "/memory/alpha");
    assert.equal(status, 200);
    assert.equal(body.root, join(home, "memory", "alpha"));
    assert.ok(existsSync(home));
  });
});
