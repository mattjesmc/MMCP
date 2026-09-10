// Shared scaffolding for the loop-kit probes (image-budget, loop-hook, loop-profile): a stub
// bridge, a stub Blockbench, and a spawned REAL shim spoken to over stdio. Lifted from
// authoring-saving.test.mjs and blockbench-surface.test.mjs so three files do not carry three
// copies of one JSON-RPC pump.
//
// These probes need NO GAME. They prove mechanisms against fixtures, which is the whole point of
// running them under `node --test probes/<name>.test.mjs` on any machine.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const HERE = dirname(fileURLToPath(import.meta.url));
// MCPTK_PROBE_SHIM points these probes at another copy of the shim (a staged or extracted one);
// it must sit beside a `local/`, `image/`, `loop/`, `upstream/` of its own, as the dist does.
export const SHIM = process.env.MCPTK_PROBE_SHIM || join(HERE, "..", "index.mjs");

/** A ToolDef as the bridge's GET /tools carries it. */
export const tool = (name, mechanism, properties = {}, description = `${name} (stub)`) => ({
  name, description, mechanism,
  inputSchema: { type: "object", properties },
});

/**
 * A stub game bridge: GET /tools serves `manifest`; POST /cmd hands the parsed {tool,args} to
 * `onCmd` and answers whatever it returns (default {ok:true,result:{}}). Every /cmd is recorded.
 */
export async function startStubBridge({ manifest, onCmd = () => ({ ok: true, result: {} }) }) {
  const calls = [];
  const http = createServer(async (req, res) => {
    if (req.url === "/tools") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(manifest));
      return;
    }
    let body = "";
    for await (const d of req) body += d;
    if (req.url === "/cmd") {
      const call = JSON.parse(body || "{}");
      calls.push(call);
      const answer = await onCmd(call);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(answer));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  return {
    base: `http://127.0.0.1:${http.address().port}`,
    calls,
    close: () => new Promise((r) => http.close(r)),
  };
}

/**
 * A stub of the toolkit's Blockbench plugin (mcptoolkit_bridge.js): the BRIDGE shape - GET /tools
 * serves `tools` (each may carry `mechanism`), POST /cmd hands {name, arguments, session, headers}
 * to `onCall` and answers what it returns as the envelope. A return without `ok` is wrapped as
 * `{ok:true, result}`, so a test can answer `{}` or `{_image: ...}` and nothing more. Records
 * every call, and every GET /presence (plugin 0.2.0: the never-ending response the shim holds for
 * its life) as `{session, client, closed}` - `closed` flips when the shim's socket goes. `port`
 * pins the port (a restart test needs the same one twice).
 *
 * `window` is what makes it a step-2 window: with a name it carries the window block on /hello and
 * answers POST /claim and POST /window the way the plugin does (one holder at a time, a window that
 * is not an agent's refusing, a claim that a live session keeps); WITHOUT one it is a plugin from
 * before step 2 - no window block, and both routes 404 - which is a shape the shim still has to work
 * with, and the default here so that a probe gets it unless it asks for windows.
 *
 * `person` is a window somebody is sitting in, which since plugin 0.7.0 is what a window is unless
 * it was opened FOR an agent, and `allowAgents` is that person handing it over anyway. `legacy`
 * answers with 0.6.0's fields instead - `reserved` and no `agent` - which is the shape a consumer's
 * stale extraction still serves and the shim must still read the old way.
 *
 * `onOpenWindow` stands in for `BarItems.new_window.click()`: called with the asking session, it is
 * what a window that can make another has. Without one, POST /window refuses exactly as a Blockbench
 * with no such action does. `claimedBy` pre-loads a claim, which is how a probe gets "every window
 * is already somebody's" without spawning that somebody.
 */
export async function startStubBlockbench({ tools, onCall = () => ({}), port = 0, window = null, person = false, allowAgents = false, legacy = false, claimedBy = null, onOpenWindow = null, onDockWindow = null, dock = false, app = "blockbench" }) {
  const calls = [];
  // THE MCP DOCK (BLOCKBENCH_ISOLATION_DESIGN.md section 11): a window that answers `role: "dock"`
  // and hands windows out on `POST /dock/window`. `onDockWindow` returns the port it gives, so a
  // probe can make the dock reuse a window it already has, stand a new one up, or fail to.
  const dockAsks = [];
  const presence = [];
  const open = new Set();
  const claims = [];
  const opens = [];
  let toolsRequests = 0;
  let holder = claimedBy;
  const holderBlock = () => (holder ? { session: holder.session, client: holder.client ?? null, connected: holder.connected !== false, seen_s_ago: 0 } : null);
  const takeable = !person || allowAgents;
  const windowBlock = () => {
    if (!window) return {};
    const common = { window, port: http.address().port, base_port: http.address().port, span: 16, claimed_by: holderBlock() };
    // 0.6.0 said only `reserved`, and a shim reading that field is the compatibility path the flip
    // has to keep working; 0.7.0 says who the window is FOR and derives `reserved` from it.
    if (legacy) return { ...common, reserved: !takeable };
    if (dock) return { ...common, agent: false, allow_agents: false, reserved: true, role: "dock" };
    return { ...common, agent: !person, allow_agents: !!allowAgents, reserved: !takeable, role: person ? "person" : "agent" };
  };
  const http = createServer(async (req, res) => {
    const url = (req.url || "/").split("?")[0];
    if (req.method === "GET" && url === "/presence") {
      const entry = { session: req.headers["x-mcptk-session"] ?? null, client: req.headers["x-mcptk-client"] ?? null, closed: false };
      presence.push(entry);
      open.add(res);
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.write(JSON.stringify({ ok: true, session: entry.session, connections: presence.filter((p) => p.session === entry.session && !p.closed).length, project: null }) + "\n");
      req.socket.on("close", () => { entry.closed = true; open.delete(res); });
      return;
    }
    if (req.method === "GET" && url === "/tools") {
      // Counted, because "how many times did this session ask for the manifest" is the difference
      // between a lazy first list and a fetch per call.
      toolsRequests++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(tools));
      return;
    }
    if (req.method === "GET" && (url === "/hello" || url === "/")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      // `app` is settable so a probe can put a STRANGER in the scan range - some other localhost
      // service that answers JSON on /hello. Scanning sixteen ports is sixteen chances to find one,
      // and everything below /hello would work on it, which is the whole reason the shim checks.
      res.end(JSON.stringify({ ok: true, app, plugin: "mcptoolkit_bridge (stub)", tools: tools.length, ...windowBlock() }));
      return;
    }
    let body = "";
    for await (const d of req) body += d;
    if (req.method === "POST" && url === "/dock/window") {
      if (!dock) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "this window is not the MCP Dock" }));
        return;
      }
      const msg = JSON.parse(body || "{}");
      const sess = typeof msg.session === "string" ? { id: msg.session } : (msg.session ?? {});
      dockAsks.push(sess);
      const given = onDockWindow ? await onDockWindow(sess) : null;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(given === null || given === undefined
        ? { ok: false, error: "a window was opened but never registered with the dock within 20s" }
        : { ok: true, port: given.port ?? given, window: given.window ?? null, made: true }));
      return;
    }
    if (req.method === "POST" && (url === "/claim" || url === "/window")) {
      // A plugin from before step 2 has neither route, and 404 is what the shim reads as "there is
      // nothing to claim here" - a window to use, not one to skip.
      if (!window) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: `no route POST ${url}` }));
        return;
      }
      const msg = JSON.parse(body || "{}");
      const sess = typeof msg.session === "string" ? { id: msg.session } : (msg.session ?? {});
      if (url === "/window") {
        opens.push(sess);
        const answer = onOpenWindow
          ? { ok: true, opened: true, requested_by: sess.id, autostart: true, ...windowBlock() }
          : { ok: false, error: "this Blockbench has no new_window action (not the desktop app?)", ...windowBlock() };
        if (onOpenWindow) await onOpenWindow(sess);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(answer));
        return;
      }
      claims.push(sess);
      let answer;
      if (msg.release) {
        const was = holder?.session === sess.id;
        if (was) holder = null;
        answer = { ok: true, released: was, ...windowBlock() };
      } else if (!takeable && holder?.session !== sess.id) {
        answer = { ok: false, error: "not an agent window: this one belongs to the person at the keyboard", ...windowBlock() };
      } else if (holder && holder.session !== sess.id) {
        answer = { ok: false, error: `claimed_by: session ${holder.session} holds this window, connected`, ...windowBlock() };
      } else {
        const rejoined = holder?.session === sess.id;
        holder = { session: sess.id, client: sess.client ?? null };
        answer = { ok: true, claimed: true, rejoined, ...windowBlock() };
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(answer));
      return;
    }
    if (req.method === "POST" && url === "/cmd") {
      const msg = JSON.parse(body || "{}");
      const params = { name: msg.tool, arguments: msg.args ?? {}, session: msg.session ?? null, headers: req.headers };
      calls.push(params);
      let answer = await onCall(params);
      if (!answer || typeof answer !== "object" || !("ok" in answer)) answer = { ok: true, result: answer ?? {} };
      if (answer.ok && !answer.mechanism) answer.mechanism = tools.find((t) => t.name === msg.tool)?.mechanism;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(answer));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: `no route ${req.method} ${url}` }));
  });
  http.listen(port, "127.0.0.1");
  await once(http, "listening");
  return {
    url: `http://127.0.0.1:${http.address().port}`,
    port: http.address().port,
    window,
    calls,
    presence,
    claims,
    opens,
    dockAsks,
    get tools_requests() { return toolsRequests; },
    holder: () => holder,
    close: () => { for (const r of open) r.destroy(); return new Promise((r) => http.close(r)); },
  };
}

/**
 * Spawn the real shim and speak MCP to it. Returns `rpc(method, params)`, the initialize result,
 * `stderr()` so far, and `waitStderr(re)`. `expectExit` returns the exit code and stderr instead
 * (for the malformed-file case).
 */
export async function spawnShim({ env = {}, cwd = process.cwd(), expectExit = false } = {}) {
  // The machine's own MCPTK_* must not leak into a probe (a workspace .mcp.json pins a profile,
  // a port, a loop file); a probe env entry set to "" means "unset", not "empty name".
  const merged = { ...process.env, MCPTK_HIDE_TOOLS: "", MCPTK_BLOCKBENCH: "off", MCPTK_PROFILE: "", MCPTK_LOOP: "",
    MCPTK_SHOT_MAX: "", MCPTK_URL: "", ...env };
  for (const k of Object.keys(merged)) if (merged[k] === "" && k !== "MCPTK_HIDE_TOOLS") delete merged[k];
  const child = spawn(process.execPath, [SHIM], { cwd, env: merged, stdio: ["pipe", "pipe", "pipe"] });
  const inbox = [];
  let buf = "";
  let stderr = "";
  child.stdout.on("data", (d) => {
    buf += d.toString();
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const l of lines) {
      if (!l.trim().startsWith("{")) continue;
      try { inbox.push(JSON.parse(l)); } catch { /* foreign line */ }
    }
  });
  child.stderr.on("data", (d) => { stderr += d.toString(); });
  if (expectExit) {
    const [code] = await once(child, "exit");
    return { code, stderr: () => stderr };
  }
  const wait = (pred, what, ms = 20_000) => new Promise((resolve, reject) => {
    const started = Date.now();
    const iv = setInterval(() => {
      const hit = inbox.find(pred);
      if (hit) { clearInterval(iv); resolve(hit); return; }
      if (child.exitCode !== null) { clearInterval(iv); reject(new Error(`shim exited ${child.exitCode} before ${what}; stderr:\n${stderr}`)); return; }
      if (Date.now() - started > ms) { clearInterval(iv); reject(new Error(`timed out waiting for ${what}; stderr:\n${stderr}`)); }
    }, 25).unref();
  });
  let id = 0;
  const rpc = async (method, params) => {
    const mine = ++id;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: mine, method, params })}\n`);
    const r = await wait((m) => m.id === mine, method);
    if (r.error) throw new Error(`${method}: ${JSON.stringify(r.error)}`);
    return r.result;
  };
  const initResult = await rpc("initialize", {
    protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "probe", version: "0" },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const waitStderr = (re, ms = 10_000) => new Promise((resolve, reject) => {
    const started = Date.now();
    const iv = setInterval(() => {
      if (re.test(stderr)) { clearInterval(iv); resolve(stderr); return; }
      if (Date.now() - started > ms) { clearInterval(iv); reject(new Error(`stderr never matched ${re}:\n${stderr}`)); }
    }, 25).unref();
  });
  return {
    rpc, initResult, waitStderr,
    stderr: () => stderr,
    call: async (name, args) => rpc("tools/call", { name, arguments: args ?? {} }),
    list: async () => (await rpc("tools/list", {})).tools,
    kill: () => child.kill(),
  };
}

/** The text parts of an MCP result, joined. */
export const textOf = (r) => (r.content ?? []).filter((p) => p.type === "text").map((p) => p.text).join("\n");
/** The first image part's bytes, or null. */
export const imageOf = (r) => {
  const p = (r.content ?? []).find((x) => x.type === "image");
  return p ? Buffer.from(p.data, "base64") : null;
};
