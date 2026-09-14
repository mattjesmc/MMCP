// mmcpd step 2 (HOST_DESIGN.md section 15): the disk feed, the change feed and the `edit` event.
//
// NO GAME NEEDED: the game is a FAKE bridge on the project's port - `/hello`, `/heartbeat`, `/cmd`
// - that records every call and answers the shapes the real tools answer. What is asserted is the
// DAEMON'S side of the contract: a file written under a registered root and nothing called lands as
// the right tool call with the right arguments, its row on the feed says `swapped`, the game's
// stream is told through `record_edit`, a session on the project is notified; an identical rewrite
// is ONE `refused` and NO reload (the step's falsifier); a batch of Java files is one compile; a
// compile failure is `not-yet`; a class the JVM never loaded is `pending-rebuild` and the rest of
// the batch still lands; a game that is down leaves the row on the feed with `none`; a port change
// in gradle.properties re-reads the registry. What this cannot see - the texture actually on screen,
// Gradle's compile, the preview re-parsing - is the live check recorded in section 15.2.
//
// Battery chunk b. Run alone: node --test probes/watcher.test.mjs

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createServer as createNet } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { classify, hunk } from "../daemon/watcher.mjs";

const freePort = () => new Promise((resolve, reject) => {
  const s = createNet();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- the fake game --------------------------------------------------------------------------------
function fakeGame(port) {
  const calls = [];
  let events = 0;
  const fake = {
    calls, port, server: null,
    hotswap: (args) => ({ ok: true, result: { redefined: args.classes, count: args.classes.length, unchanged: {}, compiled: [{ task: "compileJava", status: "UP-TO-DATE", ms: 1200 }] } }),
    uiDoc: () => ({ ok: true, result: { refreshed: true, parses: true, mirrored: true, open: "alpha:main" } }),
    of: (tool) => calls.filter((c) => c.tool === tool),
  };
  fake.server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const reply = (o) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
      if (req.url === "/hello") return reply({ ok: true, session: "x9-fake", orientation: "-" });
      if (req.url === "/heartbeat") return reply({ ok: true });
      if (req.url !== "/cmd") { res.writeHead(404); return res.end(); }
      const { tool, args } = JSON.parse(body || "{}");
      calls.push({ tool, args, session: req.headers["x-mcptk-session"] ?? null });
      switch (tool) {
        case "ping": return reply({ ok: true, result: { serverRunning: true, instanceId: "fake-1", env: "client", loader: "fabric", gameDir: "x" } });
        case "push_asset": return reply({ ok: true, result: { written: args.path, bytes: 1, reloaded: false } });
        case "clear_assets": return reply({ ok: true, result: { removed: [args.path], reloaded: false } });
        case "reload_resources": return reply({ ok: true, result: { ok: true, selected: true, problems: [] } });
        case "push_data": return reply({ ok: true, result: { written: args.path, validation: { kind: "recipe", valid: true } } });
        case "reload_data": return reply({ ok: true, result: { ok: true, problems: [] } });
        case "hotswap_class": return reply(fake.hotswap(args));
        case "ui_doc": return reply(fake.uiDoc(args));
        case "record_edit": return reply({ ok: true, result: { event_id: ++events, type: "edit" } });
        default: return reply({ ok: false, error: `fake game has no ${tool}` });
      }
    });
  });
  return new Promise((resolve) => fake.server.listen(port, "127.0.0.1", () => resolve(fake)));
}

// --- the roots ---------------------------------------------------------------------------------------
const home = mkdtempSync(join(tmpdir(), "mmcpd-watch-"));
const roots = { alpha: join(home, "alpha"), beta: join(home, "beta") };
const alphaPort = 25991;
const betaPort = 25992;
for (const [name, root] of Object.entries(roots)) {
  mkdirSync(join(root, "src", "main", "resources", "assets", name, "textures", "block"), { recursive: true });
  mkdirSync(join(root, "src", "main", "java", "com", "x", name), { recursive: true });
  writeFileSync(join(root, "gradle.properties"), `mcmod.port=${name === "alpha" ? alphaPort : betaPort}\n`);
  writeFileSync(join(root, "src", "main", "resources", "fabric.mod.json"), "{}");
  writeFileSync(join(root, "src", "main", "java", "com", "x", name, "Old.java"), "package com.x." + name + ";\npublic class Old {\n  static final int A = 1;\n}\n");
}
process.env.MMCP_HOME = home;

let daemon;
let port;
let base;
let alpha;
const api = async (method, path, body) => {
  const res = await fetch(`${base}${path}`, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};
/**
 * Wait until the feed carries a row for `path` with id > after, let the flush finish, and re-read:
 * the rows asserted on are the ones the feed holds AFTER the flush, never a snapshot taken while
 * the batch was still landing.
 */
async function landed(project, path, after = 0, timeoutMs = 8_000) {
  const t0 = Date.now();
  const read = async () => (await api("GET", `/changes?project=${project}&since=${after}`)).body.events.filter((r) => r.path === path);
  for (;;) {
    if ((await read()).length) { await daemon.watchers.get(project).settled(); return read(); }
    if (Date.now() - t0 > timeoutMs) throw new Error(`no row for ${path} within ${timeoutMs} ms`);
    await sleep(60);
  }
}
const cursor = async () => (await api("GET", "/changes")).body.cursor;

describe("mmcpd disk feed", () => {
  before(async () => {
    port = await freePort();
    process.env.MMCPD_PORT = String(port);
    alpha = await fakeGame(alphaPort);
    const { Daemon } = await import("../daemon.mjs");
    const { loadRegistry, saveRegistry, addProject, scanProject } = await import("../daemon/registry.mjs");
    const reg = loadRegistry();
    for (const root of Object.values(roots)) addProject(reg, scanProject(root));
    saveRegistry(reg);
    daemon = new Daemon({ port, quietMs: 150 });
    await daemon.start();
    base = `http://127.0.0.1:${port}`;
    await sleep(200); // the watchers' first events settle
  });
  after(async () => {
    for (const id of [...daemon.sessions.keys()]) daemon.drop(id, "probe over");
    for (const name of [...daemon.watchers.keys()]) daemon.unwatchProject(name);
    daemon.server?.close();
    clearInterval(daemon.reaper);
    alpha.server.close();
    await sleep(200);
    rmSync(home, { recursive: true, force: true });
  });

  test("the classifier: the table in section 4.2, by path", () => {
    assert.deepEqual(classify("src/main/java/com/x/Foo.java"), { kind: "java", className: "com.x.Foo" });
    assert.deepEqual(classify("src/client/java/com/x/ui/Bar.java"), { kind: "java", className: "com.x.ui.Bar" });
    assert.deepEqual(classify("src/main/resources/assets/m/textures/block/a.png"), { kind: "asset", packPath: "assets/m/textures/block/a.png", namespace: "m" });
    assert.deepEqual(classify("src/main/generated/assets/m/models/block/a.json"), { kind: "asset", packPath: "assets/m/models/block/a.json", namespace: "m" });
    assert.deepEqual(classify("src/main/resources/data/m/recipe/a.json"), { kind: "data", packPath: "data/m/recipe/a.json", namespace: "m" });
    assert.deepEqual(classify("src/main/resources/assets/m/ui/main.ui.json"), { kind: "ui", packPath: "assets/m/ui/main.ui.json", namespace: "m" });
    assert.equal(classify("src/main/resources/assets/m/ui/parts/row.part.json").kind, "asset");
    assert.equal(classify("src/main/resources/fabric.mod.json").kind, "structural");
    assert.equal(classify("src/main/resources/m.mixins.json").kind, "structural");
    assert.deepEqual(classify("gradle.properties"), { kind: "config", what: "registry" });
    assert.equal(classify("src/main/resources/README.md").kind, "other");
    assert.equal(classify("build/classes/x.class").kind, "other");
  });

  test("the hunk: a few lines, the number that changed visible in them", () => {
    const h = hunk("a\nstatic final double SPEED = 0.30;\nc\n", "a\nstatic final double SPEED = 0.25;\nc\n");
    assert.equal(h, "@@ -2,1 +2,1 @@\n- static final double SPEED = 0.30;\n+ static final double SPEED = 0.25;");
    assert.equal(hunk("same\n", "same\n"), "");
    assert.match(hunk(null, "l1\nl2\nl3\nl4\nl5\n"), /^@@ -1,0 \+1,6 @@\n\+ l1\n\+ l2\n\+ l3\n\+ \.\.\. \(3 more added\)$/);
    assert.match(hunk("x\ny\n", null), /^@@ -1,3 \+1,0 @@/);
  });

  test("status and projects show the watchers", async () => {
    const { body } = await api("GET", "/status");
    assert.equal(body.watching, true);
    assert.ok(body.watchers.alpha.files >= 3, JSON.stringify(body.watchers));
    const p = (await api("GET", "/projects")).body.projects.find((x) => x.name === "alpha");
    assert.ok(p.watch && p.watch.files >= 3);
  });

  test("a texture written with nothing called: push_asset + one reload, the row says swapped, the game's stream is told", async () => {
    const after = await cursor();
    const rel = "src/main/resources/assets/alpha/textures/block/stone.png";
    writeFileSync(join(roots.alpha, rel), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    const [row] = await landed("alpha", rel, after);
    assert.equal(row.op, "create");
    assert.equal(row.feed, "disk");
    assert.equal(row.live.act, "push_asset");
    assert.equal(row.live.result, "swapped", JSON.stringify(row.live));
    assert.ok(row.live.ms >= 0);
    assert.match(row.hunk, /new binary, 7 bytes/);
    assert.equal(row.event_id, 1, "record_edit answered with the event id");
    const push = alpha.of("push_asset");
    assert.equal(push.length, 1);
    assert.equal(push[0].args.path, "assets/alpha/textures/block/stone.png");
    assert.equal(push[0].args.file.replace(/\\/g, "/"), join(roots.alpha, rel).replace(/\\/g, "/"));
    assert.equal(push[0].args.reload, false, "batched: the reload is one call for the batch");
    assert.equal(push[0].session, "x9-fake", "the daemon's calls carry the identity the game minted for it");
    assert.equal(alpha.of("reload_resources").length, 1);
    const rec = alpha.of("record_edit");
    assert.equal(rec.length, 1);
    assert.equal(rec[0].args.path, rel);
    assert.equal(rec[0].args.live.result, "swapped");
    assert.equal(rec[0].args.feed, "disk");
  });

  test("FALSIFIER: an identical rewrite is one refused row and no push, no reload", async () => {
    const after = await cursor();
    const rel = "src/main/resources/assets/alpha/textures/block/stone.png";
    const pushes = alpha.of("push_asset").length;
    const reloads = alpha.of("reload_resources").length;
    writeFileSync(join(roots.alpha, rel), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    const rows = await landed("alpha", rel, after);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].live.result, "refused");
    assert.match(rows[0].live.error, /identical/);
    assert.equal(rows[0].hunk, "");
    assert.equal(alpha.of("push_asset").length, pushes, "no push for identical bytes");
    assert.equal(alpha.of("reload_resources").length, reloads, "no reload for identical bytes");
    const rec = alpha.of("record_edit").at(-1);
    assert.equal(rec.args.live.result, "refused", "the refusal is on the record too");
  });

  test("two Java files in one turn: one compile-and-swap for both; the hunk names the number", async () => {
    const after = await cursor();
    const a = "src/main/java/com/x/alpha/Old.java";
    const b = "src/main/java/com/x/alpha/Two.java";
    const swaps = alpha.of("hotswap_class").length;
    writeFileSync(join(roots.alpha, a), "package com.x.alpha;\npublic class Old {\n  static final int A = 2;\n}\n");
    writeFileSync(join(roots.alpha, b), "package com.x.alpha;\npublic class Two {}\n");
    const rows = [...await landed("alpha", a, after), ...await landed("alpha", b, after)];
    assert.equal(rows.length, 2);
    for (const r of rows) assert.equal(r.live.result, "swapped", JSON.stringify(r.live));
    assert.equal(rows[0].live.act, "hotswap");
    assert.equal(rows.find((r) => r.path === a).hunk, "@@ -3,1 +3,1 @@\n-   static final int A = 1;\n+   static final int A = 2;");
    assert.deepEqual(rows[0].live.compiled, ["compileJava UP-TO-DATE 1200ms"]);
    const calls = alpha.of("hotswap_class").slice(swaps);
    assert.equal(calls.length, 1, "one call for the batch");
    assert.deepEqual(calls[0].args, { classes: ["com.x.alpha.Old", "com.x.alpha.Two"], compile: true, reinit: false });
  });

  test("a compile that fails is not-yet; a class the JVM never loaded is pending-rebuild and the rest lands", async () => {
    const a = "src/main/java/com/x/alpha/Old.java";
    const b = "src/main/java/com/x/alpha/Two.java";
    let after = await cursor();
    alpha.hotswap = () => ({ ok: false, error: "compileJava FAILED in C:/x — nothing was redefined, and the first error is Old.java:3: ';' expected" });
    writeFileSync(join(roots.alpha, a), "package com.x.alpha;\npublic class Old {\n  static final int A = 3\n}\n");
    let [row] = await landed("alpha", a, after);
    assert.equal(row.live.result, "not-yet", JSON.stringify(row.live));
    assert.match(row.live.error, /FAILED/);

    after = await cursor();
    const swaps = alpha.of("hotswap_class").length;
    alpha.hotswap = (args) => args.classes.includes("com.x.alpha.Two")
      ? { ok: false, error: "class not loaded: com.x.alpha.Two — there is nothing to redefine" }
      : { ok: true, result: { redefined: args.classes, count: 1, unchanged: {} } };
    writeFileSync(join(roots.alpha, a), "package com.x.alpha;\npublic class Old {\n  static final int A = 4;\n}\n");
    writeFileSync(join(roots.alpha, b), "package com.x.alpha;\npublic class Two { int x; }\n");
    const rows = [...await landed("alpha", a, after), ...await landed("alpha", b, after)];
    assert.equal(rows.find((r) => r.path === b).live.result, "pending-rebuild");
    assert.equal(rows.find((r) => r.path === a).live.result, "swapped", "the loaded class still landed");
    assert.equal(alpha.of("hotswap_class").length - swaps, 2, "one refusal, one retry without the unloaded class");

    after = await cursor();
    alpha.hotswap = () => ({ ok: false, error: "structural change rejected (class redefinition failed: attempted to add a field) — method-body edits only; restart for this one" });
    writeFileSync(join(roots.alpha, a), "package com.x.alpha;\npublic class Old {\n  static final int A = 4;\n  int b;\n}\n");
    [row] = await landed("alpha", a, after);
    assert.equal(row.live.result, "pending-rebuild");

    after = await cursor();
    alpha.hotswap = (args) => ({ ok: true, result: { redefined: args.classes, count: 1, unchanged: { "com.x.alpha.Old": "byte-identical to what this JVM is running right now" } } });
    writeFileSync(join(roots.alpha, a), "package com.x.alpha;\n// a comment\npublic class Old {\n  static final int A = 4;\n  int b;\n}\n");
    [row] = await landed("alpha", a, after);
    assert.equal(row.live.result, "refused", "the source changed, the bytes did not");
    assert.match(row.live.error, /byte-identical/);
  });

  test("a document, a datapack file, a structural file, a deletion", async () => {
    let after = await cursor();
    const ui = "src/main/resources/assets/alpha/ui/main.ui.json";
    mkdirSync(join(roots.alpha, "src/main/resources/assets/alpha/ui"), { recursive: true });
    writeFileSync(join(roots.alpha, ui), '{"width":176}\n');
    let [row] = await landed("alpha", ui, after);
    assert.equal(row.live.act, "ui_doc refresh");
    assert.equal(row.live.result, "swapped");
    const call = alpha.of("ui_doc").at(-1);
    assert.equal(call.args.op, "refresh");
    assert.ok(call.args.ui_file.endsWith("main.ui.json"));

    after = await cursor();
    alpha.uiDoc = () => ({ ok: true, result: { refreshed: false, parses: false, mirrored: true, problems: ["elements[0]: unknown kind 'butto'"] } });
    writeFileSync(join(roots.alpha, ui), '{"width":176,"elements":[{"kind":"butto"}]}\n');
    [row] = await landed("alpha", ui, after);
    assert.equal(row.live.result, "refused");
    assert.match(row.live.error, /butto/);

    after = await cursor();
    const data = "src/main/resources/data/alpha/recipe/thing.json";
    mkdirSync(join(roots.alpha, "src/main/resources/data/alpha/recipe"), { recursive: true });
    writeFileSync(join(roots.alpha, data), "{}");
    [row] = await landed("alpha", data, after);
    assert.equal(row.live.act, "push_data");
    assert.equal(row.live.result, "swapped");
    assert.equal(alpha.of("push_data").at(-1).args.path, "data/alpha/recipe/thing.json");
    assert.equal(alpha.of("reload_data").length, 1);

    after = await cursor();
    writeFileSync(join(roots.alpha, "src/main/resources/fabric.mod.json"), '{"id":"alpha"}');
    [row] = await landed("alpha", "src/main/resources/fabric.mod.json", after);
    assert.equal(row.live.result, "pending-rebuild");

    after = await cursor();
    const clears = alpha.of("clear_assets").length;
    unlinkSync(join(roots.alpha, "src/main/resources/assets/alpha/textures/block/stone.png"));
    [row] = await landed("alpha", "src/main/resources/assets/alpha/textures/block/stone.png", after);
    assert.equal(row.op, "delete");
    assert.equal(row.live.act, "clear_assets");
    assert.equal(row.live.result, "swapped");
    assert.equal(alpha.of("clear_assets").length, clears + 1);
    assert.equal(alpha.of("clear_assets").at(-1).args.path, "assets/alpha/textures/block/stone.png");
  });

  test("the game is down: the row is still on the feed, with none and the reason; SSE delivers it", async () => {
    const after = await cursor();
    const got = [];
    const ctl = new AbortController();
    const stream = await fetch(`${base}/changes?project=beta`, { headers: { Accept: "text/event-stream" }, signal: ctl.signal });
    const reader = stream.body.getReader();
    const pump = (async () => {
      const dec = new TextDecoder();
      let buf = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buf += dec.decode(value, { stream: true });
          for (const line of buf.split("\n")) if (line.startsWith("data: ")) got.push(JSON.parse(line.slice(6)));
          buf = buf.slice(buf.lastIndexOf("\n") + 1);
        }
      } catch { /* aborted */ }
    })();
    const rel = "src/main/resources/assets/beta/textures/block/dirt.png";
    writeFileSync(join(roots.beta, rel), Buffer.from([1, 2, 3]));
    const [row] = await landed("beta", rel, after);
    assert.equal(row.live.act, "push_asset");
    assert.equal(row.live.result, "none");
    assert.match(row.live.error, /down/);
    for (let i = 0; i < 30 && !got.length; i++) await sleep(50);
    assert.equal(got.length, 1, "the SSE subscriber got the row");
    assert.equal(got[0].id, row.id);
    ctl.abort();
    await pump;
    assert.equal(alpha.of("record_edit").filter((c) => c.args.project === "beta").length, 0, "beta's game was never dialed for the record");
  });

  test("a session on the project is told: notifications/resources/updated names the file", async () => {
    const client = new Client({ name: "probe-w", version: "0.0.1" });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp/alpha`));
    const uris = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => { uris.push(n.params.uri); });
    await client.connect(transport);
    await client.listTools(); // opens the standalone stream the notification rides on
    const after = await cursor();
    const rel = "src/main/resources/assets/alpha/lang/en_us.json";
    mkdirSync(join(roots.alpha, "src/main/resources/assets/alpha/lang"), { recursive: true });
    writeFileSync(join(roots.alpha, rel), '{"a":"b"}');
    await landed("alpha", rel, after);
    for (let i = 0; i < 40 && !uris.length; i++) await sleep(50);
    assert.equal(uris.length, 1, "one notification");
    assert.ok(uris[0].startsWith("file:///"), uris[0]);
    assert.ok(uris[0].endsWith("/assets/alpha/lang/en_us.json"), uris[0]);
    await transport.terminateSession();
    await client.close();
  });

  test("gradle.properties: a port change re-reads the registry", async () => {
    const after = await cursor();
    writeFileSync(join(roots.beta, "gradle.properties"), "mcmod.port=25993\n");
    const [row] = await landed("beta", "gradle.properties", after);
    assert.equal(row.live.act, "reload-registry");
    assert.equal(row.live.result, "swapped", JSON.stringify(row.live));
    assert.match(row.live.note, /port 25992 -> 25993/);
    await sleep(100);
    const p = (await api("GET", "/projects")).body.projects.find((x) => x.name === "beta");
    assert.equal(p.port, 25993);
    assert.equal(daemon.watchers.get("beta").game.port, 25993, "the watcher dials the new port");
  });

  test("a project removed is no longer watched", async () => {
    await api("DELETE", "/projects/beta");
    assert.equal(daemon.watchers.has("beta"), false);
    assert.equal((await api("GET", "/changes?project=beta")).status, 404);
  });
});
