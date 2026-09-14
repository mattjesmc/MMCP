// The disk feed (HOST_DESIGN.md section 4.1, section 4.2, section 12): a watcher on every registered
// root, a classifier, and the acts that land a change in the running game with no agent in the
// loop.
//
// The disk feed is in the DAEMON, not the cockpit, so an agent working alone in a repo gets every
// write landed in the game without calling a tool - and the change feed records it either way.
// `fs.watch` recursive (native on Windows and macOS, Node 20+ on Linux), no dependency. A path that
// changes is held until it has been quiet for QUIET_MS, and a BATCH flushes only when every pending
// path is quiet: an agent writing four files in one turn is one compile, not four, and a texture
// export that writes the PNG in two passes is one push.
//
// The classifier is a table (section 4.2), and the acts are the toolkit's own tools called over
// the bridge: `push_asset` + `reload_resources`, `push_data` + `reload_data`, `ui_doc refresh`,
// `hotswap_class {compile:true}`. What this module adds on top of "call the tool" is the honesty
// the design asked for: a rewrite whose bytes did not change is REFUSED here, before any game is
// dialed (the falsifier in section 15 step 2: one `refused`, no reload); a Java file that does not
// compile is `not-yet`, because a disk write is often the middle of an edit; a class the JVM does
// not hold, or a structural change, is `pending-rebuild`. Every row goes to the change feed, and to
// the game's event stream as `edit` (`record_edit`) when there is a game to tell.

import { existsSync, readFileSync, readdirSync, statSync, watch } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, resolve } from "node:path";

export const QUIET_MS = 500;
/** Text is kept for the hunk; a file over this is hashed only. */
const TEXT_CAP = 256 * 1024;
const TEXT_EXT = new Set(["java", "json", "mcmeta", "txt", "md", "properties", "lang", "gradle", "kts",
  "toml", "yml", "yaml", "cfg", "accesswidener", "vsh", "fsh", "glsl", "mjs", "js", "csv", "snbt"]);
/** Editor and tool droppings: never an edit. */
const TEMP = /(~|\.swp|\.swx|\.tmp|\.orig|\.bak|\.partial|\.crswap)$|(^|\/)(\.#|#|\.~lock\.|\._)/;
/** Files at the root the daemon cares about; everything else at the root is not watched. */
const ROOT_FILES = new Set(["gradle.properties", "AGENTS.md", "CLAUDE.md"]);
/** A change to one of these is a restart, and nothing here can land it. */
const STRUCTURAL = /(^|\/)(fabric\.mod\.json|neoforge\.mods\.toml|[^/]+\.mixins\.json|[^/]+\.accesswidener)$/;
const HUNK_LINES = 3;

// --- the classifier ---------------------------------------------------------------------------------

/**
 * What a root-relative path (forward slashes) is, and which act lands it.
 *   java   {className}                 hotswap_class {compile:true}
 *   asset  {packPath, namespace}       push_asset + reload_resources
 *   data   {packPath, namespace}       push_data + reload_data (needs a world)
 *   ui     {packPath, namespace}       ui_doc refresh (mirror + re-parse in the preview)
 *   config {what}                      the daemon's own reload (registry) or the feed alone
 *   structural                         nothing lands it: pending-rebuild
 *   other                              no act; the edit is still in the feed
 */
export function classify(rel) {
  let m;
  if ((m = /^src\/[^/]+\/java\/(.+)\.java$/.exec(rel))) return { kind: "java", className: m[1].replace(/\//g, ".") };
  if ((m = /^src\/[^/]+\/(?:resources|generated)\/(assets\/([^/]+)\/(.+))$/.exec(rel))) {
    const [, packPath, namespace, inner] = m;
    if (/^ui\/.+\.ui\.json$/.test(inner)) return { kind: "ui", packPath, namespace };
    return { kind: "asset", packPath, namespace };
  }
  if ((m = /^src\/[^/]+\/(?:resources|generated)\/(data\/([^/]+)\/.+)$/.exec(rel))) return { kind: "data", packPath: m[1], namespace: m[2] };
  if (STRUCTURAL.test(rel)) return { kind: "structural" };
  if (rel === "gradle.properties") return { kind: "config", what: "registry" };
  if (rel === ".mcptoolkit/loop.json") return { kind: "config", what: "loop" };
  if (rel === "AGENTS.md" || rel === "CLAUDE.md") return { kind: "config", what: "instructions" };
  return { kind: "other" };
}

// --- the hunk ---------------------------------------------------------------------------------------

const isText = (rel) => TEXT_EXT.has(rel.slice(rel.lastIndexOf(".") + 1).toLowerCase());

/** A few lines of unified-diff summary between two texts: enough to know WHAT changed. */
export function hunk(before, after) {
  if (before == null && after == null) return "";
  const a = before == null ? [] : before.split(/\r?\n/);
  const b = after == null ? [] : after.split(/\r?\n/);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let q = 0;
  while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
  const removed = a.slice(p, a.length - q);
  const added = b.slice(p, b.length - q);
  if (!removed.length && !added.length) return "";
  const lines = [`@@ -${p + 1},${removed.length} +${p + 1},${added.length} @@`];
  for (const l of removed.slice(0, HUNK_LINES)) lines.push(`- ${l}`);
  if (removed.length > HUNK_LINES) lines.push(`- ... (${removed.length - HUNK_LINES} more removed)`);
  for (const l of added.slice(0, HUNK_LINES)) lines.push(`+ ${l}`);
  if (added.length > HUNK_LINES) lines.push(`+ ... (${added.length - HUNK_LINES} more added)`);
  return lines.join("\n");
}

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex").slice(0, 16);

// --- the watcher ------------------------------------------------------------------------------------

export class ProjectWatcher {
  /**
   * @param opts.project   registry entry {name, root, port, ...}
   * @param opts.game      GameLink to the project's game
   * @param opts.feed      ChangeFeed
   * @param opts.log       (line) => void
   * @param opts.onEvent   (row) => void - after each row is on the feed (the daemon notifies sessions)
   * @param opts.onConfig  (what) => Promise<{changed, note?}> - the daemon reloads its own state
   * @param opts.quietMs   the quiet period per path
   */
  constructor({ project, game, feed, log = () => {}, onEvent = () => {}, onConfig = async () => ({ changed: false }), quietMs = QUIET_MS }) {
    this.project = project;
    this.root = resolve(project.root);
    this.game = game;
    this.feed = feed;
    this.log = log;
    this.onEvent = onEvent;
    this.onConfig = onConfig;
    this.quietMs = quietMs;
    this.known = new Map(); // rel -> {hash, text|null, bytes}
    this.pending = new Map(); // rel -> last touch ms
    this.timer = null;
    this.chain = Promise.resolve();
    this.watchers = [];
    this.flushes = 0;
    this.lastFlushAt = null;
    this.stopped = false;
  }

  rel(abs) {
    return relative(this.root, abs).replace(/\\/g, "/");
  }

  /** Walk src/ and the root files so a first change can be told from a rewrite. */
  seed() {
    const walk = (dir) => {
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const abs = join(dir, e.name);
        if (e.isDirectory()) walk(abs);
        else if (e.isFile()) this.remember(this.rel(abs), abs);
      }
    };
    walk(join(this.root, "src"));
    for (const name of ROOT_FILES) if (existsSync(join(this.root, name))) this.remember(name, join(this.root, name));
    if (existsSync(join(this.root, ".mcptoolkit", "loop.json"))) this.remember(".mcptoolkit/loop.json", join(this.root, ".mcptoolkit", "loop.json"));
  }

  remember(rel, abs) {
    try {
      const bytes = readFileSync(abs);
      this.known.set(rel, { hash: sha(bytes), text: isText(rel) && bytes.length <= TEXT_CAP ? bytes.toString("utf8") : null, bytes: bytes.length });
    } catch { /* vanished between listing and reading */ }
  }

  start() {
    this.seed();
    const src = join(this.root, "src");
    const add = (dir, opts, prefix) => {
      if (!existsSync(dir)) return;
      try {
        const w = watch(dir, opts, (_type, filename) => {
          if (!filename) return;
          const rel = `${prefix}${String(filename).replace(/\\/g, "/")}`;
          this.touch(rel);
        });
        w.on("error", (e) => this.log(`watch ${dir}: ${e.message}`));
        this.watchers.push(w);
      } catch (e) {
        this.log(`cannot watch ${dir}: ${e.message}`);
      }
    };
    add(src, { recursive: true, persistent: false }, "src/");
    add(this.root, { persistent: false }, "");
    add(join(this.root, ".mcptoolkit"), { persistent: false }, ".mcptoolkit/");
    this.log(`watching ${this.project.name}: ${this.known.size} files under ${this.root}`);
  }

  stop() {
    this.stopped = true;
    for (const w of this.watchers) { try { w.close(); } catch { /* gone */ } }
    this.watchers = [];
    clearTimeout(this.timer);
    this.game.close();
  }

  info() {
    return { files: this.known.size, pending: this.pending.size, flushes: this.flushes, last_flush_at: this.lastFlushAt };
  }

  /** A path changed (any event): hold it until quiet. */
  touch(rel) {
    if (this.stopped) return;
    if (TEMP.test(rel)) return;
    if (!rel.startsWith("src/") && !ROOT_FILES.has(rel) && rel !== ".mcptoolkit/loop.json") return;
    this.pending.set(rel, Date.now());
    this.schedule(this.quietMs);
  }

  schedule(ms) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.check(), ms);
    this.timer.unref();
  }

  check() {
    if (this.pending.size === 0) return;
    // The batch waits for the LAST touch to go quiet, so a multi-file write is one flush.
    const wait = this.quietMs - (Date.now() - Math.max(...this.pending.values()));
    if (wait > 0) { this.schedule(wait); return; }
    const batch = [...this.pending.keys()];
    this.pending.clear();
    this.chain = this.chain.then(() => this.flush(batch)).catch((e) => this.log(`flush failed: ${e.message}`));
  }

  /** Every pending flush has run. For probes. */
  settled() {
    return this.chain;
  }

  // --- one batch --------------------------------------------------------------------------------------

  async flush(rels) {
    this.flushes++;
    this.lastFlushAt = new Date().toISOString();
    const rows = [];
    for (const rel of rels.sort()) {
      const abs = join(this.root, rel);
      const was = this.known.get(rel) ?? null;
      let st = null;
      try { st = statSync(abs); } catch { st = null; }
      if (st?.isDirectory()) continue;
      if (!st) {
        if (!was) continue; // never seen, and gone: a temp file's lifetime
        this.known.delete(rel);
        rows.push({ rel, abs, op: "delete", cls: classify(rel), hunk: was.text != null ? hunk(was.text, null) : `deleted (${was.bytes} bytes)`, identical: false });
        continue;
      }
      let bytes;
      try { bytes = readFileSync(abs); } catch { continue; }
      const hash = sha(bytes);
      const text = isText(rel) && bytes.length <= TEXT_CAP ? bytes.toString("utf8") : null;
      const identical = was != null && was.hash === hash;
      this.known.set(rel, { hash, text, bytes: bytes.length });
      const h = text != null ? (was?.text != null ? hunk(was.text, text) : hunk(null, text)) : (was ? `binary, ${was.bytes} -> ${bytes.length} bytes` : `new binary, ${bytes.length} bytes`);
      rows.push({ rel, abs, op: was ? "write" : "create", cls: classify(rel), hunk: identical ? "" : h, identical });
    }
    if (!rows.length) return;

    // Identical rewrites are refused HERE - no game is dialed for them, which is the falsifier.
    for (const r of rows) {
      if (r.identical) r.live = { act: actFor(r.cls), result: "refused", error: "identical: the bytes on disk did not change" };
    }
    const live = rows.filter((r) => !r.identical);
    const acts = live.filter((r) => ["java", "asset", "data", "ui"].includes(r.cls.kind));
    for (const r of live) {
      if (r.cls.kind === "structural") r.live = { act: "none", result: "pending-rebuild", error: `${r.rel} is read at load: a rebuild lands it` };
      else if (r.cls.kind === "other") r.live = { act: "none", result: "none" };
      else if (r.cls.kind === "java" && r.op === "delete") r.live = { act: "none", result: "pending-rebuild", error: "a deleted class stays loaded until a rebuild" };
    }
    for (const r of live.filter((x) => x.cls.kind === "config")) r.live = await this.config(r);

    let state = { state: "down", info: null };
    if (acts.length) {
      state = await this.game.ping();
      if (state.state === "down") {
        for (const r of acts) r.live = { act: actFor(r.cls), result: "none", error: `game on :${this.game.port} is down; a launch or rebuild lands it` };
      } else {
        await this.assets(acts.filter((r) => r.cls.kind === "asset"));
        await this.data(acts.filter((r) => r.cls.kind === "data"), state);
        await this.ui(acts.filter((r) => r.cls.kind === "ui"), state);
        await this.java(acts.filter((r) => r.cls.kind === "java" && r.op !== "delete"));
      }
    }

    // On the record: the game's stream first, when there is a game to tell, so the row the feed
    // emits already carries the game's event id - a row mutated after it went out on SSE is a row
    // two readers disagree about (the first run of watcher.test.mjs in a battery caught exactly
    // that: the feed had the row, `event_id` arrived a moment later).
    const gameUp = state.state !== "down" || (acts.length === 0 && (await this.game.ping()).state !== "down");
    for (const r of rows) {
      const event = {
        project: this.project.name, path: r.rel, op: r.op, by: { kind: "unknown" }, feed: "disk",
        hunk: r.hunk, live: r.live ?? { act: "none", result: "none" },
      };
      if (gameUp) {
        try {
          const env = await this.game.call("record_edit", { project: event.project, path: event.path, feed: "disk", op: event.op, by: event.by, hunk: event.hunk, live: event.live }, { timeoutMs: 10_000 });
          if (env?.ok) event.event_id = env.result?.event_id ?? null;
          else this.log(`record_edit refused: ${env?.error ?? "?"}`);
        } catch (e) {
          this.log(`record_edit: ${e.message}`);
        }
      }
      const row = this.feed.emit(event);
      this.log(`${r.op} ${r.rel}: ${row.live.act} ${row.live.result}${row.live.ms != null ? ` ${row.live.ms}ms` : ""}${row.live.error ? ` - ${String(row.live.error).slice(0, 160)}` : ""}`);
      try { this.onEvent(row); } catch (e) { this.log(`onEvent: ${e.message}`); }
    }
  }

  async config(r) {
    const t0 = Date.now();
    try {
      const out = await this.onConfig(r.cls.what, r);
      return { act: `reload-${r.cls.what}`, result: out?.changed ? "swapped" : "none", ms: Date.now() - t0, ...(out?.note ? { note: out.note } : {}), ...(out?.error ? { error: out.error } : {}) };
    } catch (e) {
      return { act: `reload-${r.cls.what}`, result: "refused", ms: Date.now() - t0, error: e.message };
    }
  }

  /** Verdict from a bridge envelope for a per-file push: the tool's own error is the row's. */
  async one(tool, args, r, act) {
    const t0 = Date.now();
    try {
      const env = await this.game.call(tool, args);
      const ms = Date.now() - t0;
      if (env?.ok) return { act, result: "swapped", ms, reply: env.result };
      return { act, result: "refused", ms, error: env?.error ?? "refused" };
    } catch (e) {
      return { act, result: "refused", ms: Date.now() - t0, error: e.message };
    }
  }

  async assets(rows) {
    if (!rows.length) return;
    for (const r of rows) {
      r.live = r.op === "delete"
        ? await this.one("clear_assets", { path: r.cls.packPath, reload: false }, r, "clear_assets")
        : await this.one("push_asset", { path: r.cls.packPath, file: r.abs, reload: false }, r, "push_asset");
    }
    await this.reload("reload_resources", rows);
  }

  async data(rows, state) {
    if (!rows.length) return;
    if (state.state !== "world") {
      for (const r of rows) r.live = { act: r.op === "delete" ? "clear_data" : "push_data", result: "none", error: "no world is loaded: the live datapack is the world's, and push_data needs a server" };
      return;
    }
    for (const r of rows) {
      r.live = r.op === "delete"
        ? await this.one("clear_data", { path: r.cls.packPath, reload: false }, r, "clear_data")
        : await this.one("push_data", { path: r.cls.packPath, file: r.abs, reload: false }, r, "push_data");
      const v = r.live.reply?.validation;
      if (v && v.valid === false) { r.live.result = "refused"; r.live.error = `${v.kind ?? "data"} ${v.id ?? ""}: ${v.error ?? "invalid"}`.trim(); }
    }
    await this.reload("reload_data", rows);
  }

  /** One reload for the batch; its problems land on every row that was pushed, its failure too. */
  async reload(tool, rows) {
    const pushed = rows.filter((r) => r.live.result === "swapped");
    if (!pushed.length) { for (const r of rows) delete r.live.reply; return; }
    const t0 = Date.now();
    let env;
    try { env = await this.game.call(tool, {}); } catch (e) { env = { ok: false, error: e.message }; }
    const ms = Date.now() - t0;
    for (const r of rows) {
      delete r.live.reply;
      if (r.live.result !== "swapped") continue;
      r.live.ms += ms;
      if (!env?.ok) { r.live.result = "refused"; r.live.error = `${tool}: ${env?.error ?? "failed"}`; continue; }
      const problems = env.result?.problems;
      if (Array.isArray(problems) && problems.length) {
        // The reload succeeded and logged-and-skipped something; the row says so, because a push
        // that "reloaded" with the asset not on screen is the trap the tool's own text warns of.
        const mine = problems.filter((p) => typeof p === "string" && p.includes(r.rel.slice(r.rel.lastIndexOf("/") + 1)));
        r.live.problems = (mine.length ? mine : problems).slice(0, 5);
      }
      if (tool === "reload_resources" && env.result?.selected === false) { r.live.result = "refused"; r.live.error = "the live pack is not selected after the reload"; }
    }
  }

  async ui(rows, state) {
    for (const r of rows) {
      if (r.op === "delete") { r.live = { act: "none", result: "none", error: "a deleted document is not previewed" }; continue; }
      const v = await this.one("ui_doc", { op: "refresh", ui_file: r.abs }, r, "ui_doc refresh");
      const reply = v.reply ?? {};
      delete v.reply;
      if (v.result === "swapped") {
        if (reply.parses === false) { v.result = "refused"; v.error = `does not parse: ${JSON.stringify(reply.problems ?? []).slice(0, 400)}`; }
        else if (!reply.refreshed) { v.result = "none"; v.note = `mirrored${reply.mirrored ? "" : " (nothing to mirror)"}; no preview is showing it (open: ${reply.open ?? "?"})`; }
        else if (reply.load_error) { v.result = "refused"; v.error = reply.load_error; }
      }
      r.live = v;
    }
  }

  /** The batch as ONE compile-and-swap; a class the JVM never loaded is dropped and retried once. */
  async java(rows) {
    if (!rows.length) return;
    let batch = rows;
    for (let attempt = 0; attempt < 2 && batch.length; attempt++) {
      const t0 = Date.now();
      let env;
      try {
        env = await this.game.call("hotswap_class", { classes: batch.map((r) => r.cls.className), compile: true, reinit: false });
      } catch (e) {
        env = { ok: false, error: e.message };
      }
      const ms = Date.now() - t0;
      if (env?.ok) {
        const unchanged = env.result?.unchanged ?? {};
        for (const r of batch) {
          r.live = unchanged[r.cls.className]
            ? { act: "hotswap", result: "refused", ms, error: `${unchanged[r.cls.className]} (the source changed, the bytes did not)` }
            : { act: "hotswap", result: "swapped", ms };
          const compiled = env.result?.compiled;
          if (Array.isArray(compiled) && compiled.length) r.live.compiled = compiled.map((c) => `${c.task} ${c.status ?? ""} ${c.ms}ms`.trim());
        }
        return;
      }
      const error = String(env?.error ?? "refused");
      const notLoaded = [...error.matchAll(/class not loaded: (\S+)/g)].map((m) => m[1].replace(/[^\w.$]+$/, ""));
      if (notLoaded.length && attempt === 0) {
        for (const r of batch.filter((x) => notLoaded.includes(x.cls.className))) {
          r.live = { act: "hotswap", result: "pending-rebuild", ms, error: "this class is not loaded in the running game: a new class lands on the next rebuild" };
        }
        batch = batch.filter((x) => !notLoaded.includes(x.cls.className));
        continue;
      }
      const result = /nothing to redefine/.test(error) ? "refused"
        : /FAILED in|compil/i.test(error) ? "not-yet"
        : /structural change|DECLINED the re-apply|restart for this|needs a restart|cannot gain one/i.test(error) ? "pending-rebuild"
        : "refused";
      for (const r of batch) r.live = { act: "hotswap", result, ms, error: error.slice(0, 600) };
      return;
    }
  }
}

function actFor(cls) {
  switch (cls.kind) {
    case "java": return "hotswap";
    case "asset": return "push_asset";
    case "data": return "push_data";
    case "ui": return "ui_doc refresh";
    case "config": return `reload-${cls.what}`;
    default: return "none";
  }
}
