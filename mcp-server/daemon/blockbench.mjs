// Blockbench under the daemon: AN INSTANCE PER SESSION, not a window in a shared pool.
//
// HOST_DESIGN.md section 11 as written pooled windows of one Blockbench by daemon session id, which
// is the plugin's whole section 11-13 (scan, claim, dock, handoff, birth, idle recycle) with a new
// key. Built instead: `Blockbench.exe --userData ~/.mmcp/bb/<session>`. The flag is in the shipped
// build, and Electron's single-instance lock lives IN that directory, so each launch is a separate
// process with its own settings, plugin registrations, recent files and lock. There is nothing to
// claim, scan, dock or recycle: the instance is the session's, the daemon started it and the daemon
// ends it. The plugin's owned mode (mcptoolkit_bridge.js, MCPTK_BLOCKBENCH_PORT/OWNER) makes it bind
// the port it was handed and accept claims from that owner alone.
//
// Two facts shape the plumbing:
//
//   THE INSTANCE IS SPAWNED ON FIRST TOUCH, and the shim is pointed at a PROXY the daemon holds from
//   the session's first moment. The shim only dials Blockbench under a profile that serves it (and a
//   `tool_surface art` switch can make that any moment), so the session's env carries a bare URL the
//   shim can pin, the daemon owns the socket behind it, and no 300 MB Electron starts for a `modding`
//   session that never models. The proxy is also where the daemon sees every Blockbench call, which
//   is the wire the undo-stack feed (section 4.1, step 8) will read.
//
//   THE PLUGIN REGISTRATION LIVES IN CHROMIUM'S LOCAL STORAGE, not in a file the daemon could write
//   (`installed_plugins` is a StateMemory key), and the plugin's `process` permission is in
//   `plugin_permissions.json`. A fresh userData therefore has no door. Each session's directory is
//   seeded from a TEMPLATE, itself copied once from the person's own Blockbench profile
//   (%APPDATA%/Blockbench) - which has the plugin installed by absolute path and the permission
//   granted. `mmcpd bb-template` re-seeds it after the person changes something worth carrying.

import { spawn, execFile } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** What of a Blockbench profile carries the plugin registration, permission and store plugins. */
const TEMPLATE_PARTS = ["Local Storage", "plugin_permissions.json", "plugins", "launch_settings.json"];
/** Files Chromium holds open or that name a running process; never copied. */
const SKIP = new Set(["LOCK", "lockfile"]);
/** How long a fresh instance may take to answer /hello. Cold Electron on a laptop: 5-15 s. */
const BOOT_MS = 60_000;
const HELLO_MS = 800;

export function defaultExe() {
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Programs", "Blockbench", "Blockbench.exe");
  }
  if (process.platform === "darwin") return "/Applications/Blockbench.app/Contents/MacOS/Blockbench";
  return "blockbench";
}

export function defaultProfileDir() {
  if (process.platform === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Blockbench");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Blockbench");
  return join(homedir(), ".config", "Blockbench");
}

/** Copy a tree, tolerating files that will not read (Chromium keeps some open); returns counts. */
function copyTree(src, dst, counts = { files: 0, skipped: 0 }) {
  const st = statSync(src);
  if (st.isDirectory()) {
    mkdirSync(dst, { recursive: true });
    for (const name of readdirSync(src)) {
      if (SKIP.has(name)) continue;
      copyTree(join(src, name), join(dst, name), counts);
    }
  } else {
    try { copyFileSync(src, dst); counts.files++; } catch { counts.skipped++; }
  }
  return counts;
}

/** A free TCP port, by asking the OS for one and giving it back. Racy in theory, fine on localhost. */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function hello(port, timeoutMs = HELLO_MS) {
  return fetch(`http://127.0.0.1:${port}/hello`, { signal: AbortSignal.timeout(timeoutMs) })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class BlockbenchPool {
  /**
   * @param opts.home  MMCP_HOME
   * @param opts.exe   Blockbench executable (registry `blockbench.exe`, else the installed default)
   * @param opts.log   (line) => void
   */
  constructor({ home, exe, profileDir, log }) {
    this.home = join(home, "bb");
    this.template = join(this.home, "template");
    this.exe = exe || defaultExe();
    this.profileDir = profileDir || defaultProfileDir();
    this.log = log ?? (() => {});
    this.instances = new Map(); // session id -> Instance
  }

  /** Seed (or re-seed) the template from the person's own profile. */
  ensureTemplate({ refresh = false } = {}) {
    if (existsSync(join(this.template, "Local Storage")) && !refresh) return { seeded: false, template: this.template };
    if (!existsSync(this.profileDir)) {
      throw new Error(`no Blockbench profile at ${this.profileDir} to seed from - open Blockbench once, install `
        + "the MCP Toolkit Bridge plugin from file and grant it `process`, then `mmcpd bb-template`");
    }
    if (refresh) rmSync(this.template, { recursive: true, force: true });
    mkdirSync(this.template, { recursive: true });
    const counts = { files: 0, skipped: 0 };
    for (const part of TEMPLATE_PARTS) {
      const src = join(this.profileDir, part);
      if (existsSync(src)) copyTree(src, join(this.template, part), counts);
    }
    this.log(`blockbench template seeded from ${this.profileDir}: ${counts.files} file(s)${counts.skipped ? `, ${counts.skipped} unreadable (open in Blockbench)` : ""}`);
    return { seeded: true, template: this.template, ...counts };
  }

  /**
   * The proxy for a session: listening at once on an ephemeral port, spawning the instance on the
   * first request. Returns the bare URL the session's shim pins.
   */
  async proxyFor(sessionId, { project } = {}) {
    if (this.instances.has(sessionId)) return this.instances.get(sessionId).url;
    const inst = new Instance(this, sessionId, project);
    await inst.listen();
    this.instances.set(sessionId, inst);
    return inst.url;
  }

  get(sessionId) { return this.instances.get(sessionId) ?? null; }

  list() {
    return [...this.instances.values()].map((i) => i.info());
  }

  /**
   * The session is over. A CLEAN instance goes with it; one holding UNSAVED work is left running
   * and reported as orphaned - a person can still save from it, and killing it would lose the one
   * thing the session made that nobody else has. `force` kills either way.
   */
  async release(sessionId, { force = false, reason = "session closed" } = {}) {
    const inst = this.instances.get(sessionId);
    if (!inst) return { released: false };
    const r = await inst.release({ force, reason });
    if (r.killed || !inst.pid) this.instances.delete(sessionId);
    return r;
  }

  async releaseAll({ force = false, reason = "daemon stopping" } = {}) {
    const out = [];
    for (const id of [...this.instances.keys()]) out.push({ session: id, ...(await this.release(id, { force, reason })) });
    return out;
  }
}

class Instance {
  constructor(pool, sessionId, project) {
    this.pool = pool;
    this.session = sessionId;
    this.project = project ?? null;
    this.userData = join(pool.home, sessionId);
    this.proxy = null;
    this.proxyPort = null;
    this.port = null; // the instance's own port
    this.child = null;
    this.pid = null;
    this.booting = null; // promise while the instance comes up
    this.state = "idle"; // idle | booting | up | down | orphaned
    this.error = null;
    this.startedAt = null;
    this.orphanedAt = null;
    this.calls = 0;
    this.lastCall = null;
  }

  get url() { return `http://127.0.0.1:${this.proxyPort}`; }

  info() {
    return {
      session: this.session, project: this.project, state: this.state, proxy_port: this.proxyPort,
      port: this.port, pid: this.pid, user_data: this.userData, url: this.url, error: this.error,
      started_at: this.startedAt ? new Date(this.startedAt).toISOString() : null,
      orphaned_at: this.orphanedAt ? new Date(this.orphanedAt).toISOString() : null,
      calls: this.calls, last_call: this.lastCall,
    };
  }

  listen() {
    return new Promise((resolve, reject) => {
      this.proxy = createServer((req, res) => this.handle(req, res));
      this.proxy.once("error", reject);
      this.proxy.listen(0, "127.0.0.1", () => {
        this.proxyPort = this.proxy.address().port;
        resolve();
      });
    });
  }

  /** Spawn if needed and wait until /hello answers. */
  ready() {
    if (this.state === "up" && this.pid) return Promise.resolve();
    if (this.booting) return this.booting;
    this.booting = this.boot().finally(() => { this.booting = null; });
    return this.booting;
  }

  async boot() {
    const { pool } = this;
    this.state = "booting";
    this.error = null;
    if (!existsSync(pool.exe)) {
      this.state = "down";
      this.error = `Blockbench executable not found at ${pool.exe} (registry \`blockbench.exe\` names another)`;
      throw new Error(this.error);
    }
    pool.ensureTemplate();
    if (!existsSync(join(this.userData, "Local Storage"))) copyTree(pool.template, this.userData);
    this.port = await freePort();
    const env = { ...process.env, MCPTK_BLOCKBENCH_PORT: String(this.port), MCPTK_BLOCKBENCH_OWNER: this.session };
    delete env.MCPTK_SESSION;
    this.child = spawn(pool.exe, ["--userData", this.userData], { env, stdio: "ignore", detached: false });
    this.pid = this.child.pid ?? null;
    this.startedAt = Date.now();
    pool.log(`blockbench instance for ${this.session}: pid ${this.pid}, port ${this.port}, userData ${this.userData}`);
    this.child.on("exit", (code, signal) => {
      pool.log(`blockbench instance for ${this.session} exited (code ${code}, signal ${signal})`);
      this.state = "down";
      this.pid = null;
      this.child = null;
    });
    const until = Date.now() + BOOT_MS;
    while (Date.now() < until) {
      if (this.state === "down") throw new Error("Blockbench exited while starting");
      const h = await hello(this.port);
      if (h?.ok) {
        if (!h.owned) {
          // A plugin without owned mode (an older file in the template) bound the port it was
          // handed only by luck of its own scan; say so once, and serve anyway.
          pool.log(`blockbench instance for ${this.session}: plugin ${h.plugin_version ?? "?"} answered without owned mode`);
        }
        this.state = "up";
        pool.log(`blockbench instance for ${this.session} up in ${Math.round((Date.now() - this.startedAt) / 1000)}s (plugin ${h.plugin_version ?? "?"}, window ${h.window ?? "?"})`);
        return;
      }
      await sleep(500);
    }
    this.error = `Blockbench did not answer on ${this.port} within ${BOOT_MS / 1000}s - is the plugin installed and started in the template profile?`;
    throw new Error(this.error);
  }

  async handle(req, res) {
    this.calls++;
    this.lastCall = { method: req.method, path: req.url, at: new Date().toISOString() };
    try {
      await this.ready();
    } catch (e) {
      const body = JSON.stringify({ ok: false, error: e.message, state: this.state });
      res.writeHead(503, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    const up = httpRequest({
      host: "127.0.0.1", port: this.port, method: req.method, path: req.url,
      headers: { ...req.headers, host: `127.0.0.1:${this.port}` },
    });
    up.on("response", (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
      r.on("close", () => { if (!res.writableEnded) res.end(); });
    });
    up.on("error", (e) => {
      if (res.headersSent) { res.destroy(); return; }
      const body = JSON.stringify({ ok: false, error: `blockbench instance: ${e.message}` });
      res.writeHead(502, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
      res.end(body);
    });
    // The presence socket (GET /presence) never ends on its own and the plugin releases the
    // session's binding the moment it closes - so the shim's close must reach the instance. The
    // client going away is the RESPONSE closing unfinished: a GET's request stream closes the moment
    // its empty body has been read, long before any answer, and hanging this on `req` killed every
    // proxied call as a hang-up (measured 2026-09-14, the first live session).
    res.on("close", () => { if (!res.writableFinished && !up.destroyed) up.destroy(); });
    req.pipe(up);
  }

  async dirty() {
    if (this.state !== "up") return 0;
    const h = await hello(this.port, 2_000);
    return typeof h?.dirty === "number" ? h.dirty : 0;
  }

  release(opts) {
    // One release at a time: drop() and stop() can both ask within the same second.
    if (!this.releasing) this.releasing = this.doRelease(opts).finally(() => { this.releasing = null; });
    return this.releasing;
  }

  async doRelease({ force, reason }) {
    if (this.proxy) { this.proxy.close(); this.proxy = null; }
    if (!this.pid) {
      rmSync(this.userData, { recursive: true, force: true });
      return { released: true, killed: false, orphaned: false };
    }
    const dirty = force ? 0 : await this.dirty();
    if (dirty > 0) {
      this.state = "orphaned";
      this.orphanedAt = Date.now();
      this.pool.log(`blockbench instance for ${this.session} kept: ${dirty} unsaved project(s) (${reason}) - save or close it by hand, or DELETE /blockbench/${this.session}?force=1`);
      return { released: true, killed: false, orphaned: true, dirty };
    }
    await this.kill();
    // The directory goes once the process has let go of it; a dir still held is left for the
    // next seed of the same session id to overwrite, which never happens - ids are minted fresh.
    try { rmSync(this.userData, { recursive: true, force: true }); } catch { /* still held */ }
    return { released: true, killed: true, orphaned: false };
  }

  /** Kill the instance and wait (bounded) for it to be gone. */
  kill() {
    if (!this.pid || !this.child) return Promise.resolve();
    const pid = this.pid;
    const child = this.child;
    this.pool.log(`blockbench instance for ${this.session}: killing pid ${pid}`);
    const gone = new Promise((resolve) => {
      const t = setTimeout(resolve, 5_000);
      child.once("exit", () => { clearTimeout(t); setTimeout(resolve, 200); });
    });
    if (process.platform === "win32") {
      // Electron is a tree (main, gpu, renderers); kill() reaches only the root.
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => {});
    } else {
      try { child.kill("SIGTERM"); } catch { /* gone */ }
    }
    this.state = "down";
    return gone;
  }
}
