// One MCP session under the daemon: a child `index.mjs` and the pump between it and the transport.
//
// THE SHIM IS SPAWNED PER SESSION, NOT FOLDED IN (HOST_DESIGN.md section 3.1, as built). Every layer
// the shim is made of holds its state at module scope - BASE, the served profile and hidden set,
// the memory root and session id, the Blockbench window and presence, the loop file read from cwd -
// so "the shim's layers held once" would have meant refactoring some three thousand lines into
// factories under release 2's contract. A child per session gets the same isolation from the
// operating system for free: its cwd is the project root, its env is the project's, a crash is its
// own, and the stdio probes keep passing because nothing they test moved. What the daemon owns is
// what was fought over: the registry, the session table, where memory lives, and the identity the
// child presents to Blockbench.
//
// The pump is bytes: JSON-RPC lines from the child's stdout go to the transport, messages from the
// transport go to the child's stdin as lines. The daemon READS what passes - the client's name from
// `initialize`, the last tool call, a profile switch - and never rewrites it, with one exception:
// requests the daemon itself puts to the child (a profile change from the cockpit) carry an
// `mmcpd-` id and their answers are consumed here rather than forwarded.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join } from "node:path";

const SHIM = join(dirname(fileURLToPath(import.meta.url)), "..", "index.mjs");
/** How much of a child's stderr the session keeps for `GET /sessions/<id>/log`. */
const LOG_LINES = 200;
/** A daemon-originated request the child never answers is dropped after this. */
const OWN_REQUEST_MS = 60_000;

export class DaemonSession {
  /**
   * @param opts.id          the daemon's session id (also the transport's Mcp-Session-Id)
   * @param opts.project     registry entry {name, root, port, profile}
   * @param opts.profile     the profile the URL named, or null for the shim's default
   * @param opts.memoryRoot  MCPTK_MEMORY_DIR for this child
   * @param opts.blockbench  the pinned Blockbench URL this child should dial (its own instance's proxy)
   * @param opts.log         (line) => void
   * @param opts.send        (message) => Promise - deliver a child message to the client
   * @param opts.onExit      () => void - the child is gone
   */
  constructor(opts) {
    this.id = opts.id;
    this.project = opts.project;
    this.profile = opts.profile ?? opts.project.profile ?? null;
    this.servedProfile = this.profile;
    this.memoryRoot = opts.memoryRoot;
    this.blockbench = opts.blockbench ?? null;
    this.log = opts.log ?? (() => {});
    this.sendToClient = opts.send;
    this.onExit = opts.onExit ?? (() => {});
    this.startedAt = Date.now();
    this.lastSeenAt = this.startedAt;
    this.client = null; // {name, version} from initialize
    this.calls = 0;
    this.lastCall = null; // {tool, at, ms?}
    this.tools = null; // count from the last tools/list answer
    this.child = null;
    this.exited = null; // {code, signal, at}
    this.stderr = [];
    this.streams = 0; // open HTTP requests on this session (a held GET stream counts)
    this.heldStream = false; // did this client ever open the standalone GET stream
    this.closing = false;
    this.pending = []; // messages that arrived before the child was up
    this.own = new Map(); // mmcpd-<n> -> {resolve, reject, timer}
    this.inflight = new Map(); // client request id -> {method, tool, at}
    this.ownSeq = 0;
  }

  /** The row the session table shows. */
  info() {
    return {
      id: this.id,
      project: this.project.name,
      client: this.client,
      profile: this.servedProfile,
      launched_as: this.profile,
      started_at: new Date(this.startedAt).toISOString(),
      last_seen_at: new Date(this.lastSeenAt).toISOString(),
      calls: this.calls,
      last_call: this.lastCall,
      tools: this.tools,
      streams: this.streams,
      pid: this.child?.pid ?? null,
      exited: this.exited,
      memory: this.memoryRoot,
      blockbench: this.blockbench,
    };
  }

  /** Spawn the child. Called on the session's first message, which is `initialize`. */
  start(clientInfo) {
    if (this.child) return;
    this.client = clientInfo ? { name: clientInfo.name ?? null, version: clientInfo.version ?? null } : null;
    const env = { ...process.env };
    // The shim's own contract, spelled in its env: which game, which slice, where memory lives.
    env.MCPTK_URL = `http://127.0.0.1:${this.project.port}`;
    if (this.profile) env.MCPTK_PROFILE = this.profile; else delete env.MCPTK_PROFILE;
    env.MCPTK_MEMORY_DIR = this.memoryRoot;
    if (this.client?.name) env.MCPTK_CLIENT = this.client.name;
    if (this.client?.version) env.MCPTK_CLIENT_VERSION = this.client.version;
    // The attachment check compares the game's directory with the session's own; under the daemon
    // that is the registry's gameDir (the toolkit's own game runs in the workbench root's `run/`),
    // never wherever the daemon happened to start.
    const gameDir = this.project.gameDir ?? "run";
    env.MCPTK_EXPECT_GAMEDIR = isAbsolute(gameDir) ? gameDir : join(this.project.root, gameDir);
    // Blockbench: pinned to this session's own instance (through the daemon's proxy), and the
    // identity it presents there is the daemon's session id - never `mcptk-<ppid>`, which would be
    // the daemon's pid for every child (upstream/blockbench.mjs, MCPTK_BLOCKBENCH_SESSION).
    if (this.blockbench) env.MCPTK_BLOCKBENCH = this.blockbench; else env.MCPTK_BLOCKBENCH = "off";
    env.MCPTK_BLOCKBENCH_SESSION = this.id;
    env.MMCPD_SESSION = this.id;
    // Never inherited: a daemon started from inside some session's shell must not hand its
    // children that session's game identity.
    delete env.MCPTK_SESSION;
    this.child = spawn(process.execPath, [SHIM], {
      cwd: this.project.root,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.log(`spawned shim pid ${this.child.pid} for ${this.project.name} (profile ${this.profile ?? "default"}, client ${this.client?.name ?? "?"})`);
    createInterface({ input: this.child.stdout }).on("line", (line) => this.fromChild(line));
    createInterface({ input: this.child.stderr }).on("line", (line) => {
      this.stderr.push(line);
      if (this.stderr.length > LOG_LINES) this.stderr.shift();
      this.log(`shim: ${line}`);
    });
    this.child.on("error", (e) => this.log(`shim spawn error: ${e.message}`));
    this.child.on("exit", (code, signal) => {
      this.exited = { code, signal, at: new Date().toISOString() };
      this.log(`shim exited (code ${code}, signal ${signal})`);
      for (const p of this.own.values()) { clearTimeout(p.timer); p.reject(new Error("shim exited")); }
      this.own.clear();
      this.onExit();
    });
    this.child.stdin.on("error", (e) => this.log(`shim stdin: ${e.message}`));
    for (const m of this.pending.splice(0)) this.write(m);
  }

  write(message) {
    if (!this.child || this.exited || !this.child.stdin.writable) return false;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
    return true;
  }

  /** A message from the client, via the transport. */
  deliver(message) {
    this.lastSeenAt = Date.now();
    if (message && typeof message === "object") {
      if (message.method === "initialize" && !this.child) this.start(message.params?.clientInfo);
      if (message.method === "tools/call" && message.id !== undefined) {
        const tool = message.params?.name ?? "?";
        this.calls++;
        this.lastCall = { tool, at: new Date().toISOString() };
        this.inflight.set(message.id, { method: message.method, tool, at: Date.now() });
      } else if (message.method === "tools/list" && message.id !== undefined) {
        this.inflight.set(message.id, { method: message.method, at: Date.now() });
      }
    }
    if (!this.child) { this.pending.push(message); return; }
    this.write(message);
  }

  /** A line from the child's stdout. */
  fromChild(line) {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { this.log(`shim stdout (not JSON): ${line.slice(0, 200)}`); return; }
    // The daemon's own request, answered.
    if (typeof message.id === "string" && message.id.startsWith("mmcpd-")) {
      const p = this.own.get(message.id);
      if (p) {
        this.own.delete(message.id);
        clearTimeout(p.timer);
        if (message.error) p.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
        else p.resolve(message.result);
      }
      return;
    }
    if (message.id !== undefined && this.inflight.has(message.id)) {
      const req = this.inflight.get(message.id);
      this.inflight.delete(message.id);
      if (req.method === "tools/list" && Array.isArray(message.result?.tools)) this.tools = message.result.tools.length;
      if (req.method === "tools/call") {
        if (this.lastCall && this.lastCall.tool === req.tool) this.lastCall.ms = Date.now() - req.at;
        if (req.tool === "tool_surface") this.noteSurface(message.result);
      }
    }
    Promise.resolve(this.sendToClient(message)).catch((e) => {
      // The client's request is gone (it closed the POST, or the session), so its answer has nowhere
      // to land. Nothing to do but say so; the child is fine.
      this.log(`could not deliver ${message.method ?? `response ${message.id}`} to the client: ${e.message}`);
    });
  }

  /** Read the served profile off a tool_surface reply the client or the daemon made. */
  noteSurface(result) {
    try {
      const text = result?.content?.find((c) => c.type === "text")?.text;
      const r = text ? JSON.parse(text) : null;
      if (r && typeof r.profile === "string" && !r.error) this.servedProfile = r.profile;
    } catch { /* not the shape we know; the table keeps what it had */ }
  }

  /** A request the DAEMON puts to the child. Resolves with the JSON-RPC result. */
  request(method, params) {
    if (!this.child || this.exited) return Promise.reject(new Error("session has no running shim"));
    const id = `mmcpd-${++this.ownSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.own.delete(id);
        reject(new Error(`${method} unanswered after ${OWN_REQUEST_MS / 1000}s`));
      }, OWN_REQUEST_MS);
      this.own.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  /**
   * The operator changes this session's profile (HOST_DESIGN.md section 9): `tool_surface` applied
   * from outside. The shim does the switch and tells the client to re-read its list; the daemon only
   * asked. The reply is the tool's own report, so the cost of the switch is visible here too.
   */
  async setProfile(profile) {
    const result = await this.request("tools/call", { name: "tool_surface", arguments: { profile } });
    this.noteSurface(result);
    const text = result?.content?.find((c) => c.type === "text")?.text;
    let report = null;
    try { report = text ? JSON.parse(text) : null; } catch { report = { text }; }
    if (result?.isError) throw new Error(report?.error ?? text ?? "tool_surface refused");
    return report;
  }

  /** End the session: the child goes, and its exit runs onExit. */
  close(reason = "closed") {
    if (this.closing) return;
    this.closing = true;
    this.log(`closing (${reason})`);
    if (this.child && !this.exited) {
      try { this.child.stdin.end(); } catch { /* already gone */ }
      // A shim that does not leave when its stdio closes is not one that exists, but the daemon
      // should not have to trust that.
      const c = this.child;
      setTimeout(() => { if (!this.exited) { try { c.kill(); } catch { /* gone */ } } }, 2_000).unref();
    } else if (!this.child) {
      this.onExit();
    }
  }
}
