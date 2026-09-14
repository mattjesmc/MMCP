#!/usr/bin/env node
// mmcpd - the daemon that hosts the bridge (HOST_DESIGN.md section 3).
//
// One long-lived process per machine, bound to 127.0.0.1:25500, and the thing every modding
// session connects to: `http://127.0.0.1:25500/mcp/<project>?profile=<p>` is a streamable-HTTP MCP
// door, so an agent client's registration collapses to a URL and nothing is spawned by the client.
// The daemon owns what used to be fought over - the project registry (which game is which), the
// session table, where each project's memory lives, and the Blockbench each session works in - and
// the stdio shim (`index.mjs`) stays exactly as released for machines and clients without it.
//
// WHAT IT IS MADE OF, and where the design was corrected by the code (section 3.1 said "the shim's
// layers held once"):
//
//   daemon/session.mjs    - a session is a CHILD `index.mjs` with the project's env and cwd, pumped
//                           to and from the transport as JSON-RPC lines. The shim's layers are
//                           module singletons; a child per session isolates them for free.
//   daemon/blockbench.mjs - an INSTANCE of Blockbench per session (`--userData`), spawned on first
//                           touch behind a per-session proxy the daemon holds. No window pool.
//   daemon/registry.mjs   - ~/.mmcp/registry.json, the projects and their ports.
//   daemon/watcher.mjs    - the DISK FEED (section 4, step 2): a watcher per registered root that
//                           classifies each change and lands it in the running game - push_asset,
//                           push_data, ui_doc refresh, hotswap_class {compile:true} - with no agent
//                           in the loop; daemon/game.mjs is its line to the game.
//   daemon/feed.mjs       - the change feed every edit lands on: `GET /changes` (SSE or JSON), and
//                           the same row goes to the game's event stream as `edit` (record_edit).
//   daemon/supervisor.mjs - the RUN cycles (section 3.6, section 8): `POST /projects/<n>/run|stop`
//                           spawns the workbench's tools/rebuild.ps1 the way launch_game does and
//                           keeps its output here, phase and all, tailable on `GET /projects/<n>/log`.
//   daemon/ui/            - the COCKPIT (section 6), as pages the daemon itself serves at `/ui/`:
//                           the cockpit is a client of these routes like every agent is, and a
//                           browser is the one shell every machine has. The VS Code extension, when
//                           there is one, hosts the same pages in webviews and adds the buffer feed.
//
// Every route is Origin-checked the way both game doors are (BRIDGE_AUDIT.md section 1): a page in
// a browser is not a caller. Everything the cockpit will show comes from these routes and nothing it
// does bypasses them; the same routes are the CLI's (`mmcpd status|sessions|projects|...`).

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { open as openFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  MMCP_HOME, REGISTRY_PATH, DAEMON_DEFAULT_PORT, loadRegistry, saveRegistry, scanProject, addProject,
  removeProject, findProject,
} from "./daemon/registry.mjs";
import { DaemonSession } from "./daemon/session.mjs";
import { BlockbenchPool } from "./daemon/blockbench.mjs";
import { GameLink, gameState } from "./daemon/game.mjs";
import { ChangeFeed } from "./daemon/feed.mjs";
import { ProjectWatcher } from "./daemon/watcher.mjs";
import { Supervisor } from "./daemon/supervisor.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const VERSION = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8")).version;
/** The cockpit's files. Served as they are on disk, so an edit to a page is a reload away. */
const UI_DIR = join(HERE, "daemon", "ui");
const UI_TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json" };
/** A session nobody holds a stream on and nobody has spoken to for this long is closed. */
const IDLE_MS = 10 * 60_000;
/**
 * A client that ONCE held the standalone GET stream and now holds nothing for this long is gone:
 * the SDK client's `close()` sends no DELETE (measured, probes/daemon.test.mjs), so the stream
 * dropping is the only word a vanished client leaves. A client that never held one is polling and
 * gets the long idle above instead - a slow turn is not an absence.
 */
const ORPHAN_MS = 90_000;
const REAP_MS = 30_000;

// --- logging ------------------------------------------------------------------------------------
const LOG_PATH = join(MMCP_HOME, "mmcpd.log");
function log(line) {
  const stamped = `${new Date().toISOString()} ${line}`;
  process.stderr.write(`${stamped}\n`);
  try { mkdirSync(MMCP_HOME, { recursive: true }); appendFileSync(LOG_PATH, `${stamped}\n`); } catch { /* the log is a courtesy */ }
}

// --- the origin check -----------------------------------------------------------------------------
// The rule both game doors apply (BridgeOrigin): a request that names an Origin is a browser
// speaking for a page, and only a loopback page may speak here. No Origin is a program, and trusted
// as the loopback bind trusts it. The Host header is checked too: a DNS name resolving to 127.0.0.1
// is the rebinding trick, and the daemon answers to its own address only.
function isLoopbackHost(hostname) {
  const h = String(hostname ?? "").replace(/^\[|\]$/g, "").toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "0:0:0:0:0:0:0:1";
}
function refused(req, res) {
  const origin = req.headers.origin;
  if (origin) {
    let ok = false;
    try { ok = isLoopbackHost(new URL(origin).hostname); } catch { ok = false; }
    if (!ok) { json(res, 403, { ok: false, error: `origin ${origin} refused: this daemon answers loopback pages only` }); return true; }
  }
  const host = req.headers.host;
  if (host) {
    let ok = false;
    try { ok = isLoopbackHost(new URL(`http://${host}`).hostname); } catch { ok = false; }
    if (!ok) { json(res, 421, { ok: false, error: `host ${host} is not this daemon's address` }); return true; }
  }
  return false;
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) return resolve({});
      try { resolve(JSON.parse(text)); } catch (e) { reject(new Error(`body is not JSON: ${e.message}`)); }
    });
    req.on("error", reject);
  });
}

/** The last `want` lines of a file, read from its end - a latest.log can be tens of MB. */
async function tailFile(file, want) {
  let fh;
  try { fh = await openFile(file, "r"); } catch (e) { return { exists: false, lines: [], error: e.code === "ENOENT" ? "no such file" : e.message }; }
  try {
    const { size, mtime } = await fh.stat();
    const span = Math.min(size, 512 * 1024);
    const buf = Buffer.alloc(span);
    await fh.read(buf, 0, span, size - span);
    const lines = buf.toString("utf8").split(/\r?\n/);
    if (span < size) lines.shift(); // the first line is a fragment
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    return { exists: true, size, modified_at: mtime.toISOString(), lines: lines.slice(-want) };
  } finally { await fh.close(); }
}

// --- the daemon -----------------------------------------------------------------------------------
class Daemon {
  constructor({ port, idleMs = IDLE_MS, orphanMs = ORPHAN_MS, watch = null, quietMs = undefined }) {
    this.port = port;
    this.idleMs = idleMs;
    this.orphanMs = orphanMs;
    this.registry = loadRegistry();
    this.sessions = new Map(); // id -> {session, transport}
    this.startedAt = Date.now();
    this.blockbench = new BlockbenchPool({ home: MMCP_HOME, exe: this.registry.blockbench?.exe, log });
    this.feed = new ChangeFeed();
    this.supervisor = new Supervisor({ home: MMCP_HOME, log: (line) => log(`[run] ${line}`) });
    this.watchers = new Map(); // project name -> ProjectWatcher
    // The disk feed is on unless told otherwise: MMCPD_WATCH=0 in the environment, or
    // `daemon.watch: false` in the registry, for a machine where the daemon must only serve doors.
    this.watching = watch ?? !(process.env.MMCPD_WATCH === "0" || this.registry.daemon?.watch === false);
    this.quietMs = quietMs;
    this.server = null;
    this.stopping = false;
  }

  // --- the disk feed ------------------------------------------------------------------------------

  watchProject(project) {
    if (!this.watching) return null;
    this.unwatchProject(project.name);
    const game = new GameLink({ port: project.port, label: `mmcpd:${project.name}`, log: (line) => log(`[watch ${project.name}] ${line}`) });
    const w = new ProjectWatcher({
      project, game, feed: this.feed, quietMs: this.quietMs,
      log: (line) => log(`[watch ${project.name}] ${line}`),
      onEvent: (row) => this.notifyEdit(row),
      onConfig: (what, r) => this.reloadConfig(project.name, what, r),
    });
    try {
      w.start();
      this.watchers.set(project.name, w);
      return w;
    } catch (e) {
      log(`[watch ${project.name}] not started: ${e.message}`);
      return null;
    }
  }

  unwatchProject(name) {
    const w = this.watchers.get(name);
    if (!w) return;
    w.stop();
    this.watchers.delete(name);
  }

  /**
   * Every session on the project hears of the edit (section 4.5): `notifications/resources/updated`
   * on its stream, naming the file. Delivered on the standalone GET stream a client holds; a client
   * holding none is polling and reads the row from `get_events` instead - the transport drops what
   * it cannot deliver, which is the right thing for a notification.
   */
  notifyEdit(row) {
    const root = findProject(this.registry, row.project)?.root ?? "";
    const uri = `file:///${join(root, row.path).replace(/\\/g, "/").replace(/^\/+/, "")}`;
    for (const { session, transport } of this.sessions.values()) {
      if (session.project.name !== row.project) continue;
      transport.send({ jsonrpc: "2.0", method: "notifications/resources/updated", params: { uri } })
        .catch((e) => log(`[${session.id}] resources/updated: ${e.message}`));
    }
  }

  /** A config file under a registered root changed: the daemon's own reload for it. */
  async reloadConfig(name, what, r) {
    const project = findProject(this.registry, name);
    if (!project) return { changed: false, note: "project no longer registered" };
    if (what === "registry") {
      const fresh = scanProject(project.root, { name: project.name, profile: project.profile });
      const changed = ["port", "loader", "mc", "gameDir"].filter((k) => fresh[k] !== project[k]);
      if (!changed.length) return { changed: false, note: "gradle.properties changed nothing the registry reads (mcmod.port, minecraft_version)" };
      addProject(this.registry, fresh);
      saveRegistry(this.registry);
      const entry = findProject(this.registry, name);
      const said = changed.map((k) => `${k} ${project[k]} -> ${fresh[k]}`).join(", ");
      log(`project ${name} re-read from gradle.properties: ${said}`);
      // The watcher dials the port; a new port is a new game. Restarted after this flush lands.
      if (changed.includes("port")) setTimeout(() => this.watchProject(entry), 0);
      return { changed: true, note: `registry: ${said}` };
    }
    // The loop file and the instructions are read by each session's shim from its cwd on its own
    // schedule; the daemon has nothing to reload, and the row on the feed is the whole point.
    return { changed: false, note: `${r.rel} is read by sessions themselves; on the feed only` };
  }

  memoryRoot(project) {
    return join(MMCP_HOME, "memory", project.name);
  }

  newSessionId() {
    return `mmcp-${randomBytes(4).toString("hex")}`;
  }

  // The MCP door. One transport per session; the transport mints the id and the daemon keys its
  // table by it. A request that carries no session id must be an `initialize`; everything else is
  // looked up. The transport does the protocol's bookkeeping (streams, response routing); the
  // daemon only moves messages between it and the child.
  async handleMcp(req, res, projectName, url) {
    const project = findProject(this.registry, projectName);
    if (!project) {
      json(res, 404, { ok: false, error: `no project "${projectName}" - registered: ${this.registry.projects.map((p) => p.name).join(", ") || "none"}; mmcpd add <root>` });
      return;
    }
    const sid = req.headers["mcp-session-id"];
    if (sid) {
      const entry = this.sessions.get(String(sid));
      if (!entry) { json(res, 404, { ok: false, error: "session not found (the daemon may have restarted) - initialize again" }); return; }
      if (entry.session.project.name !== project.name) { json(res, 400, { ok: false, error: `session ${sid} belongs to project ${entry.session.project.name}` }); return; }
      await this.track(entry.session, req, res, () => entry.transport.handleRequest(req, res));
      return;
    }
    if (req.method !== "POST") {
      json(res, 400, { ok: false, error: "no Mcp-Session-Id: open a session with an initialize POST first" });
      return;
    }
    const profileArg = url.searchParams.get("profile");
    const id = this.newSessionId();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => id });
    const bb = await this.blockbench.proxyFor(id, { project: project.name });
    const session = new DaemonSession({
      id, project, profile: profileArg || null, memoryRoot: this.memoryRoot(project), blockbench: bb,
      log: (line) => log(`[${id}] ${line}`),
      send: (message) => transport.send(message),
      onExit: () => this.drop(id, "shim exited"),
    });
    const entry = { session, transport };
    this.sessions.set(id, entry);
    transport.onmessage = (message) => session.deliver(message);
    transport.onclose = () => this.drop(id, "transport closed");
    transport.onerror = (e) => log(`[${id}] transport: ${e.message}`);
    await transport.start();
    log(`[${id}] session opened on ${project.name}${profileArg ? ` (profile ${profileArg})` : ""} from ${req.socket.remoteAddress}`);
    await this.track(session, req, res, () => transport.handleRequest(req, res));
    // A first POST that was not an `initialize` got the transport's 400 and initialized nothing:
    // no child was spawned, and the entry would only sit in the table until the reaper.
    if (transport.sessionId === undefined) this.drop(id, "first request was not initialize");
  }

  /** Count the HTTP requests open on a session, so idleness can be judged. */
  async track(session, req, res, run) {
    session.streams++;
    session.lastSeenAt = Date.now();
    if (req.method === "GET") session.heldStream = true;
    res.on("close", () => { session.streams = Math.max(0, session.streams - 1); session.lastSeenAt = Date.now(); });
    try {
      await run();
    } catch (e) {
      log(`[${session.id}] request failed: ${e.message}`);
      if (!res.headersSent) json(res, 500, { ok: false, error: e.message });
    }
  }

  /** The session is over, from whichever side said so first. */
  drop(id, reason) {
    const entry = this.sessions.get(id);
    if (!entry) return;
    this.sessions.delete(id);
    log(`[${id}] session ended (${reason})`);
    entry.session.close(reason);
    entry.transport.close().catch(() => {});
    this.blockbench.release(id, { reason }).catch((e) => log(`[${id}] blockbench release: ${e.message}`));
  }

  reap() {
    const now = Date.now();
    for (const [id, { session }] of this.sessions) {
      const idle = now - session.lastSeenAt;
      if (session.streams === 0 && session.heldStream && idle > this.orphanMs) this.drop(id, `client gone: its stream closed ${Math.round(idle / 1000)}s ago and nothing followed`);
      else if (session.streams === 0 && idle > this.idleMs) this.drop(id, `idle ${Math.round(idle / 60_000)} min with no stream held`);
      if (session.exited && now - Date.parse(session.exited.at) > 5_000) this.drop(id, "shim gone");
    }
  }

  async projectsWithState() {
    return Promise.all(this.registry.projects.map(async (p) => {
      const pinged = await gameState(p.port);
      const sessions = [...this.sessions.values()].filter((e) => e.session.project.name === p.name).map((e) => e.session.id);
      const run = this.supervisor.current(p.name);
      // `building` is the daemon's word, not the game's: a cycle in flight and no game answering.
      const state = pinged.state === "down" && run?.kind === "run" ? "building" : pinged.state;
      const { info } = pinged;
      return {
        ...p, state, sessions,
        run: run ? run.info() : null,
        last_run: run ? null : (this.supervisor.latest(p.name)?.info() ?? null),
        url: `http://127.0.0.1:${this.port}/mcp/${p.name}`,
        watch: this.watchers.get(p.name)?.info() ?? null,
        game: info ? { env: info.env ?? null, loader: info.loader ?? null, gameDir: info.gameDir ?? null, instance: info.instanceId ?? null, client: info.clientPresent ?? null } : null,
      };
    }));
  }

  // --- routes -----------------------------------------------------------------------------------
  async route(req, res) {
    if (refused(req, res)) return;
    const url = new URL(req.url, `http://127.0.0.1:${this.port}`);
    const parts = url.pathname.split("/").filter(Boolean);
    const [head, a, b] = parts;
    try {
      if (head === "mcp" && a && parts.length === 2) return await this.handleMcp(req, res, decodeURIComponent(a), url);
      if (!head && req.method === "GET") { res.writeHead(302, { Location: "/ui/" }); return res.end(); }
      if (head === "ui" && req.method === "GET") return this.serveUi(res, parts.slice(1));
      if (head === "status" && req.method === "GET") {
        return json(res, 200, {
          ok: true, daemon: "mmcpd", version: VERSION, pid: process.pid, port: this.port,
          uptime_s: Math.round((Date.now() - this.startedAt) / 1000), home: MMCP_HOME, registry: REGISTRY_PATH,
          sessions: this.sessions.size, projects: this.registry.projects.length, blockbench: this.blockbench.list().length,
          watching: this.watching, watchers: Object.fromEntries([...this.watchers].map(([n, w]) => [n, w.info()])),
          changes: this.feed.cursor,
          runs: [...this.supervisor.inFlight.values()].map((r) => r.info()),
          supervisor: { script: this.supervisor.script, available: this.supervisor.available },
          ui: `http://127.0.0.1:${this.port}/ui/`,
        });
      }
      if (head === "stop" && req.method === "POST") {
        json(res, 200, { ok: true, stopping: true, sessions: this.sessions.size });
        setTimeout(() => this.stop("POST /stop"), 50);
        return;
      }
      if (head === "projects" && !a) {
        if (req.method === "GET") return json(res, 200, { ok: true, projects: await this.projectsWithState() });
        if (req.method === "POST") {
          const body = await readBody(req);
          if (!body.root) return json(res, 400, { ok: false, error: "body needs {root, name?, profile?}" });
          const entry = addProject(this.registry, scanProject(body.root, { name: body.name, profile: body.profile }));
          saveRegistry(this.registry);
          log(`project registered: ${entry.name} -> ${entry.root} (port ${entry.port})`);
          this.watchProject(findProject(this.registry, entry.name));
          return json(res, 200, { ok: true, project: { ...entry, url: `http://127.0.0.1:${this.port}/mcp/${entry.name}` } });
        }
      }
      if (head === "projects" && a && !b && req.method === "DELETE") {
        const gone = removeProject(this.registry, decodeURIComponent(a));
        if (gone) { saveRegistry(this.registry); this.unwatchProject(decodeURIComponent(a)); }
        return json(res, gone ? 200 : 404, { ok: gone, removed: gone ? a : null });
      }
      if (head === "projects" && a && b) {
        const project = findProject(this.registry, decodeURIComponent(a));
        if (!project) return json(res, 404, { ok: false, error: `no project ${a}` });
        // --- the supervisor (section 3.6): one cycle per port, its output kept here -----------
        if ((b === "run" || b === "stop") && req.method === "POST") {
          const body = await readBody(req);
          const opts = {
            target: body.target ?? "client", rebuild: body.rebuild !== false, takeover: body.takeover === true,
            ui: typeof body.ui === "string" && body.ui.trim() ? body.ui.trim() : null, uiEdit: body.ui_edit === true,
            fabricApi: body.fabricapi === true,
          };
          let run;
          try { run = b === "run" ? this.supervisor.run(project, opts) : this.supervisor.stop(project, opts); }
          catch (e) { return json(res, 409, { ok: false, error: e.message }); }
          return json(res, 200, {
            ok: true, run: run.info(),
            note: `${b === "run" ? "cycle" : "stop"} started; the bridge on :${project.port} goes DOWN during it. GET /projects/${project.name}/log follows it (SSE with Accept: text/event-stream); GET /projects shows state and phase.`,
          });
        }
        if (b === "runs" && req.method === "GET") return json(res, 200, { ok: true, project: project.name, script: this.supervisor.script, available: this.supervisor.available, runs: this.supervisor.runsFor(project.name) });
        if (b === "log" && req.method === "GET") {
          const id = url.searchParams.get("run");
          const run = id ? this.supervisor.find(project.name, id) : (this.supervisor.current(project.name) ?? this.supervisor.latest(project.name));
          if (!run) return json(res, 404, { ok: false, error: id ? `no run ${id} on ${project.name}` : `no run on ${project.name} yet - POST /projects/${project.name}/run` });
          if (String(req.headers.accept ?? "").includes("text/event-stream")) return run.subscribe(res);
          return json(res, 200, { ok: true, run: run.info(), lines: run.lines });
        }
        // The game's own latest.log, from the registry's gameDir: the loader's phase and the mod's
        // errors live there before any tool exists, and after the game is gone.
        if (b === "latest" && req.method === "GET") {
          const file = join(project.gameDir, "logs", "latest.log");
          const want = Math.min(Number(url.searchParams.get("lines")) || 200, 2000);
          return json(res, 200, { ok: true, project: project.name, file, ...(await tailFile(file, want)) });
        }
      }
      if (head === "sessions" && !a && req.method === "GET") {
        return json(res, 200, { ok: true, sessions: [...this.sessions.values()].map((e) => e.session.info()) });
      }
      if (head === "sessions" && a) {
        const entry = this.sessions.get(a);
        if (!entry) return json(res, 404, { ok: false, error: `no session ${a}` });
        if (!b && req.method === "GET") return json(res, 200, { ok: true, session: entry.session.info() });
        if (!b && req.method === "DELETE") { this.drop(a, "DELETE /sessions"); return json(res, 200, { ok: true, closed: a }); }
        if (b === "log" && req.method === "GET") return json(res, 200, { ok: true, lines: entry.session.stderr });
        if (b === "profile" && req.method === "POST") {
          const body = await readBody(req);
          if (!body.profile) return json(res, 400, { ok: false, error: "body needs {profile}" });
          const report = await entry.session.setProfile(String(body.profile));
          return json(res, 200, { ok: true, session: a, report });
        }
      }
      if (head === "changes" && !a && req.method === "GET") {
        const project = url.searchParams.get("project");
        if (project && !findProject(this.registry, project)) return json(res, 404, { ok: false, error: `no project ${project}` });
        const sinceArg = url.searchParams.get("since") ?? req.headers["last-event-id"];
        const since = sinceArg != null && sinceArg !== "" ? Number(sinceArg) : null;
        if (String(req.headers.accept ?? "").includes("text/event-stream")) return this.feed.subscribe(res, { project, since });
        const limit = Number(url.searchParams.get("limit")) || 100;
        return json(res, 200, { ok: true, cursor: this.feed.cursor, events: this.feed.since(since, { project, limit }) });
      }
      if (head === "memory" && a && !b && req.method === "GET") {
        const project = findProject(this.registry, decodeURIComponent(a));
        if (!project) return json(res, 404, { ok: false, error: `no project ${a}` });
        const root = this.memoryRoot(project);
        const worlds = existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [];
        return json(res, 200, { ok: true, project: project.name, root, worlds });
      }
      if (head === "blockbench" && !a && req.method === "GET") {
        return json(res, 200, { ok: true, exe: this.blockbench.exe, template: this.blockbench.template, instances: this.blockbench.list() });
      }
      if (head === "blockbench" && a === "template" && req.method === "POST") {
        return json(res, 200, { ok: true, ...this.blockbench.ensureTemplate({ refresh: true }) });
      }
      if (head === "blockbench" && a && !b && req.method === "DELETE") {
        const r = await this.blockbench.release(a, { force: url.searchParams.get("force") === "1", reason: "DELETE /blockbench" });
        return json(res, r.released ? 200 : 404, { ok: r.released, ...r });
      }
      json(res, 404, { ok: false, error: `no route ${req.method} ${url.pathname}` });
    } catch (e) {
      log(`${req.method} ${url.pathname}: ${e.message}`);
      if (!res.headersSent) json(res, 500, { ok: false, error: e.message });
    }
  }

  /** `/ui/<file>`: the cockpit's own files, from daemon/ui/, nothing outside it. */
  serveUi(res, rest) {
    const rel = rest.length ? rest.map(decodeURIComponent).join("/") : "index.html";
    const file = normalize(join(UI_DIR, rel));
    if (!file.startsWith(UI_DIR + sep) || rel.includes("..")) return json(res, 404, { ok: false, error: "no such page" });
    const type = UI_TYPES[extname(file).toLowerCase()];
    if (!type || !existsSync(file) || !statSync(file).isFile()) return json(res, 404, { ok: false, error: `no such page /ui/${rel}` });
    const body = readFileSync(file);
    res.writeHead(200, { "Content-Type": type, "Content-Length": body.length, "Cache-Control": "no-cache" });
    res.end(body);
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => { this.route(req, res); });
      // Streams stay open for as long as the client holds them.
      this.server.requestTimeout = 0;
      this.server.headersTimeout = 60_000;
      this.server.keepAliveTimeout = 65_000;
      this.server.once("error", (e) => {
        if (e.code === "EADDRINUSE") reject(new Error(`port ${this.port} is taken - an mmcpd is already running (mmcpd status), or something else has it`));
        else reject(e);
      });
      this.server.listen(this.port, "127.0.0.1", () => {
        this.reaper = setInterval(() => this.reap(), REAP_MS);
        this.reaper.unref();
        log(`mmcpd ${VERSION} listening on http://127.0.0.1:${this.port} (pid ${process.pid}, ${this.registry.projects.length} project(s), home ${MMCP_HOME})`);
        for (const p of this.registry.projects) log(`  ${p.name}: ${p.root} -> game :${p.port} -> http://127.0.0.1:${this.port}/mcp/${p.name}`);
        log(`cockpit at http://127.0.0.1:${this.port}/ui/${this.supervisor.available ? "" : " (no tools/rebuild.ps1 beside this dist: run and stop are refused)"}`);
        if (this.watching) for (const p of this.registry.projects) this.watchProject(p);
        else log("disk feed OFF (MMCPD_WATCH=0 or registry daemon.watch=false)");
        resolve();
      });
    });
  }

  async stop(reason) {
    if (this.stopping) return;
    this.stopping = true;
    log(`stopping (${reason}): ${this.sessions.size} session(s)`);
    clearInterval(this.reaper);
    for (const name of [...this.watchers.keys()]) this.unwatchProject(name);
    for (const id of [...this.sessions.keys()]) this.drop(id, reason);
    // A run in flight loses its supervisor, not its game: past the relaunch the game is the
    // supervisor's child and a plain kill leaves children alone. The port lock drops with it.
    this.supervisor.killAll();
    // drop() releases each session's instance on its own; this catches instances without a session
    // (orphans, and any whose release is still in flight) and waits for the processes to leave.
    await this.blockbench.releaseAll({ reason });
    this.server?.close();
    // Shim children get a moment to leave on their own before the process does.
    setTimeout(() => process.exit(0), 1_500).unref();
  }
}

// --- the CLI --------------------------------------------------------------------------------------
function usage() {
  return `mmcpd - the daemon that hosts the MMCP bridge

  mmcpd [serve]                       run in the foreground (default)
  mmcpd status                        is one running, and what it holds
  mmcpd stop                          ask the running daemon to stop
  mmcpd add <root> [--name n] [--profile p]   register a project (reads mcmod.port from its gradle.properties)
  mmcpd remove <name>
  mmcpd projects                      registered projects and each game's state
  mmcpd sessions                      the session table
  mmcpd kick <session>                close a session
  mmcpd profile <session> <profile>   switch a session's tool profile (it re-reads its tool list)
  mmcpd blockbench                    the Blockbench instances
  mmcpd bb-template                   re-seed the Blockbench userData template from your profile
  mmcpd url <name>                    the URL to register in an agent client
  mmcpd run <name> [--target client|server] [--no-rebuild] [--takeover] [--ui doc] [--fabricapi]
                                      cycle the project's dev game (stop, build, relaunch, wait) and follow it
  mmcpd stop-game <name>              stop the project's dev game (graceful, then force)
  mmcpd runs <name>                   the runs the daemon remembers for the project
  mmcpd log <name> [--run id] [--follow]
                                      a run's output; --follow streams it until the cycle ends
  mmcpd ui                            print the cockpit's URL (a browser page the daemon serves)
  mmcpd changes [--project p] [--since id] [--follow]
                                      the change feed: every edit under a registered root and what
                                      became of it in the game; --follow streams (SSE) until Ctrl-C

  MMCP_HOME (default ~/.mmcp) holds registry.json, memory/<project>/, bb/<session>/, mmcpd.log.
  MMCPD_PORT overrides the port (default ${DAEMON_DEFAULT_PORT}). MMCPD_WATCH=0 turns the disk feed off.`;
}

async function api(port, method, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000),
  }).catch((e) => { throw new Error(`no mmcpd on 127.0.0.1:${port} (${e.cause?.code ?? e.message})`); });
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok || data.ok === false) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

/** The events of an SSE response, one {event, data} at a time. */
async function* sseEvents(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    let at;
    while ((at = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, at);
      buf = buf.slice(at + 2);
      const event = chunk.split("\n").find((l) => l.startsWith("event: "))?.slice(7) ?? "message";
      const data = chunk.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
      if (data) yield { event, data };
    }
  }
}

function flag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(argv) {
  const port = Number(process.env.MMCPD_PORT) || loadRegistry().daemon?.port || DAEMON_DEFAULT_PORT;
  const [cmd = "serve", ...rest] = argv;
  const print = (o) => process.stdout.write(`${JSON.stringify(o, null, 2)}\n`);
  switch (cmd) {
    case "serve": {
      const d = new Daemon({ port });
      await d.start();
      for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
        try { process.on(sig, () => d.stop(sig)); } catch { /* not on this platform */ }
      }
      return;
    }
    case "status": return print(await api(port, "GET", "/status"));
    case "stop": return print(await api(port, "POST", "/stop"));
    case "projects": return print(await api(port, "GET", "/projects"));
    case "sessions": return print(await api(port, "GET", "/sessions"));
    case "blockbench": return print(await api(port, "GET", "/blockbench"));
    case "bb-template": return print(await api(port, "POST", "/blockbench/template"));
    case "kick": {
      if (!rest[0]) throw new Error("mmcpd kick <session>");
      return print(await api(port, "DELETE", `/sessions/${rest[0]}`));
    }
    case "profile": {
      if (!rest[0] || !rest[1]) throw new Error("mmcpd profile <session> <profile>");
      return print(await api(port, "POST", `/sessions/${rest[0]}/profile`, { profile: rest[1] }));
    }
    case "add": {
      const root = rest.find((x) => !x.startsWith("--") && rest[rest.indexOf(x) - 1]?.startsWith("--") !== true);
      if (!root) throw new Error("mmcpd add <root> [--name n] [--profile p]");
      const body = { root: resolve(root), name: flag(rest, "--name"), profile: flag(rest, "--profile") };
      // Registering works without a running daemon too: the registry is a file, and the daemon
      // re-reads nothing - so tell the person which happened.
      try {
        return print(await api(port, "POST", "/projects", body));
      } catch (e) {
        if (!/no mmcpd/.test(e.message)) throw e;
        const reg = loadRegistry();
        const entry = addProject(reg, scanProject(body.root, { name: body.name, profile: body.profile }));
        saveRegistry(reg);
        return print({ ok: true, project: { ...entry, url: `http://127.0.0.1:${port}/mcp/${entry.name}` }, note: "written to the registry; no daemon was running" });
      }
    }
    case "remove": {
      if (!rest[0]) throw new Error("mmcpd remove <name>");
      try {
        return print(await api(port, "DELETE", `/projects/${rest[0]}`));
      } catch (e) {
        if (!/no mmcpd/.test(e.message)) throw e;
        const reg = loadRegistry();
        const gone = removeProject(reg, rest[0]);
        if (gone) saveRegistry(reg);
        return print({ ok: gone, removed: gone ? rest[0] : null, note: "no daemon was running" });
      }
    }
    case "changes": {
      const q = new URLSearchParams();
      if (flag(rest, "--project")) q.set("project", flag(rest, "--project"));
      if (flag(rest, "--since")) q.set("since", flag(rest, "--since"));
      const path = `/changes${q.size ? `?${q}` : ""}`;
      if (!rest.includes("--follow")) return print(await api(port, "GET", path));
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { Accept: "text/event-stream" } })
        .catch((e) => { throw new Error(`no mmcpd on 127.0.0.1:${port} (${e.cause?.code ?? e.message})`); });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let at;
        while ((at = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, at);
          buf = buf.slice(at + 2);
          const data = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (!data) continue;
          const row = JSON.parse(data.slice(6));
          process.stdout.write(`${row.at} ${row.project} ${row.op} ${row.path}: ${row.live.act} ${row.live.result}${row.live.ms != null ? ` ${row.live.ms}ms` : ""}${row.live.error ? ` - ${row.live.error}` : ""}\n`);
        }
      }
    }
    case "ui": {
      process.stdout.write(`http://127.0.0.1:${port}/ui/\n`);
      return;
    }
    case "runs": {
      if (!rest[0]) throw new Error("mmcpd runs <name>");
      return print(await api(port, "GET", `/projects/${rest[0]}/runs`));
    }
    case "stop-game": {
      if (!rest[0]) throw new Error("mmcpd stop-game <name>");
      return print(await api(port, "POST", `/projects/${rest[0]}/stop`, { takeover: rest.includes("--takeover") }));
    }
    case "run": case "log": {
      if (!rest[0]) throw new Error(`mmcpd ${cmd} <name> ...`);
      const name = rest[0];
      let path = `/projects/${name}/log`;
      if (cmd === "run") {
        const body = {
          target: flag(rest, "--target") ?? "client", rebuild: !rest.includes("--no-rebuild"), takeover: rest.includes("--takeover"),
          ui: flag(rest, "--ui"), ui_edit: rest.includes("--ui-edit"), fabricapi: rest.includes("--fabricapi"),
        };
        const started = await api(port, "POST", `/projects/${name}/run`, body);
        process.stdout.write(`${started.run.id}: ${started.run.kind} ${name} :${started.run.port} ${started.run.target}${started.run.rebuild ? " (rebuild)" : ""} -> ${started.run.log}\n`);
        path += `?run=${started.run.id}`;
      } else {
        if (flag(rest, "--run")) path += `?run=${flag(rest, "--run")}`;
        if (!rest.includes("--follow")) return print(await api(port, "GET", path));
      }
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { Accept: "text/event-stream" } })
        .catch((e) => { throw new Error(`no mmcpd on 127.0.0.1:${port} (${e.cause?.code ?? e.message})`); });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      for await (const ev of sseEvents(res)) {
        if (ev.event === "line") process.stdout.write(`${JSON.parse(ev.data)}\n`);
        else if (ev.event === "exit") { const r = JSON.parse(ev.data); process.stdout.write(`-- ${r.outcome} (exit ${r.exit}) after ${Math.round(r.elapsed_ms / 1000)}s\n`); process.exitCode = r.exit === 0 ? 0 : 1; }
      }
      return;
    }
    case "url": {
      const reg = loadRegistry();
      const p = rest[0] ? findProject(reg, rest[0]) : null;
      if (!p) throw new Error(`mmcpd url <name> - registered: ${reg.projects.map((x) => x.name).join(", ") || "none"}`);
      process.stdout.write(`http://127.0.0.1:${port}/mcp/${p.name}\n`);
      return;
    }
    case "help": case "--help": case "-h":
      process.stdout.write(`${usage()}\n`);
      return;
    default:
      throw new Error(`unknown command "${cmd}"\n\n${usage()}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`mmcpd: ${e.message}\n`);
    process.exit(1);
  });
}

export { Daemon };
