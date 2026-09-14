// The supervisor (HOST_DESIGN.md section 3.6, section 8): the daemon owns the run cycles.
//
// A "run" is one `tools/rebuild.ps1` cycle - take the port lock, stop the game on the port, build
// unless told not to, relaunch `:runClient` / `:runServer` on that port, wait for the bridge - and a
// "stop" is the same script told to relaunch nothing. The script already carries every rule that
// was learned the hard way (one cycle per port as a FILE-HANDLE lock, never stop a production
// instance, the crash report and latest.log tail when the bridge never comes up), so the daemon
// spawns it exactly as `launch_game` (local/dev.mjs) does and adds what a long-lived process can:
// the run's output is kept HERE, line by line, tailable over SSE while the cycle runs, with the
// phase the script is in read off its own `[rebuild]` lines - not a temp file the caller has to go
// and find. Runs are remembered per project (the last twenty), so "what happened to the launch I
// started ten minutes ago" is a GET, not a search of %TEMP%.
//
// The same in-process guard as dev.mjs: a second run on a port while the daemon's own supervisor
// for it is still alive is REFUSED (its first act would be to kill the first one's game), and
// `takeover` hands the script its -Takeover, which kills the holder - the supervisor only, never its
// tree, since past step 3 the game is that supervisor's child. The port lock in the script is the
// guard that sees a rival in ANOTHER process (a hand-run rebuild.ps1, a stdio shim's launch_game);
// this one only sees the daemon's own.
//
// The script lives in the WORKBENCH checkout (`../tools/rebuild.ps1` from mcp-server/). A daemon
// run from an extracted dist has no such file and says so on the first run request rather than at
// start: every other route works without it. MMCPD_REBUILD names another script (the probes hand
// in a fake that prints the phase lines and exits with a chosen code).

import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/** Where the workbench's script is when the daemon runs from a checkout. */
export const DEFAULT_SCRIPT = join(HERE, "..", "..", "tools", "rebuild.ps1");
const KEEP_RUNS = 20;
const KEEP_LINES = 2000;

/** What rebuild.ps1's exit codes mean, in the words its own header uses. */
export function outcomeOf(code, kind) {
  if (code === 0) return kind === "stop" ? "stopped" : "up";
  if (code === 1) return "bridge timeout";
  if (code === 2) return "refused: production instance";
  if (code === 3) return "refused: another cycle owns the port";
  if (code === 4) return "refused: no such build root";
  if (code == null) return "killed";
  return `build failed (exit ${code})`;
}

/** The phase a `[rebuild]` line announces, or null when the line is not one. */
export function phaseOf(line) {
  if (!line.includes("[rebuild]")) return null;
  if (/holding the port-\d+ cycle lock/.test(line)) return "locked";
  if (/asking the game to quit|force-killing|bridge unresponsive/.test(line)) return "stopping";
  if (/game stopped|no running game detected/.test(line)) return "stopped";
  if (/building .* gradlew build/.test(line)) return "building";
  if (/build OK/.test(line)) return "built";
  if (/build FAILED/.test(line)) return "build-failed";
  if (/launching .*\(detached\)/.test(line)) return "launching";
  if (/timed out waiting/.test(line)) return "timeout"; // before "waiting": it contains that phrase
  if (/waiting for the bridge/.test(line)) return "waiting";
  if (/bridge is up/.test(line)) return "up";
  if (/another rebuild cycle already owns/.test(line)) return "refused";
  if (/PRODUCTION instance/.test(line)) return "refused";
  return null;
}

let nextRunId = 1;

class Run {
  constructor({ project, kind, target, opts, file }) {
    this.id = `run-${nextRunId++}`;
    this.project = project.name;
    this.port = project.port;
    this.root = project.root;
    this.kind = kind; // run | stop
    this.target = target;
    this.rebuild = kind === "run" && opts.rebuild !== false;
    this.takeover = opts.takeover === true;
    this.ui = opts.ui ?? null;
    this.uiEdit = opts.uiEdit === true;
    this.fabricApi = opts.fabricApi === true;
    this.file = file;
    this.pid = null;
    this.startedAt = Date.now();
    this.endedAt = null;
    this.exit = undefined; // undefined while running; null when killed by signal
    this.phase = "starting";
    this.lines = [];
    this.dropped = 0;
    this.subscribers = new Set(); // SSE responses
    this.error = null;
  }

  get running() { return this.endedAt === null; }

  info() {
    return {
      id: this.id, project: this.project, port: this.port, kind: this.kind, target: this.target,
      rebuild: this.rebuild, takeover: this.takeover, ui: this.ui, ui_edit: this.uiEdit, fabricapi: this.fabricApi,
      pid: this.pid, running: this.running, phase: this.phase,
      started_at: new Date(this.startedAt).toISOString(),
      ended_at: this.endedAt ? new Date(this.endedAt).toISOString() : null,
      elapsed_ms: (this.endedAt ?? Date.now()) - this.startedAt,
      exit: this.running ? undefined : this.exit,
      outcome: this.running ? null : outcomeOf(this.exit, this.kind),
      lines: this.lines.length + this.dropped, log: this.file, error: this.error,
    };
  }

  push(line) {
    // A `Write-Error` line is wrapped by the PowerShell host at its console width (80 columns on
    // the hidden console the script gets), with the script's path in front of it - so "[rebuild]
    // timed out waiting for the bridge" can arrive as two lines cut anywhere, inside the word
    // "[rebuild]" included (measured: a long script path puts the wrap there). The wrap inserts a
    // newline and loses nothing, so a continuation line is matched glued to the line before it.
    const p = phaseOf(line) ?? (this.last && !line.includes("[rebuild]") ? phaseOf(`${this.last}${line}`) : null);
    if (p) this.phase = p;
    this.last = line;
    this.lines.push(line);
    if (this.lines.length > KEEP_LINES) { this.lines.shift(); this.dropped++; }
    this.send("line", line);
  }

  send(event, data) {
    for (const res of this.subscribers) {
      try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* closing */ }
    }
  }

  end(code) {
    if (this.endedAt !== null) return;
    this.endedAt = Date.now();
    this.exit = code;
    if (this.phase !== "up" && this.phase !== "refused" && this.phase !== "timeout" && this.phase !== "build-failed") {
      this.phase = code === 0 ? (this.kind === "stop" ? "stopped" : "up") : "failed";
    }
    this.send("exit", this.info());
    for (const res of this.subscribers) { try { res.end(); } catch { /* gone */ } }
    this.subscribers.clear();
  }

  /** Hold an SSE response: the lines so far, then each new one, then `exit`. */
  subscribe(res) {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write(`event: run\ndata: ${JSON.stringify(this.info())}\n\n`);
    for (const line of this.lines) res.write(`event: line\ndata: ${JSON.stringify(line)}\n\n`);
    if (!this.running) { res.write(`event: exit\ndata: ${JSON.stringify(this.info())}\n\n`); res.end(); return; }
    this.subscribers.add(res);
    const keep = setInterval(() => { try { res.write(": keep-alive\n\n"); } catch { /* closing */ } }, 25_000);
    keep.unref();
    res.on("close", () => { this.subscribers.delete(res); clearInterval(keep); });
  }
}

export class Supervisor {
  /**
   * @param opts.home    MMCP_HOME; run logs go to <home>/runs/
   * @param opts.script  the rebuild script (default: the workbench's tools/rebuild.ps1)
   * @param opts.log     (line) => void
   */
  constructor({ home, script = process.env.MMCPD_REBUILD || DEFAULT_SCRIPT, log = () => {} }) {
    this.home = home;
    this.script = script;
    this.log = log;
    this.runs = new Map(); // project name -> Run[] (newest last)
    this.inFlight = new Map(); // port -> Run
    this.reaperInstalled = false;
  }

  get available() { return existsSync(this.script); }

  runsFor(name) { return (this.runs.get(name) ?? []).map((r) => r.info()); }
  current(name) { return (this.runs.get(name) ?? []).find((r) => r.running) ?? null; }
  latest(name) { const list = this.runs.get(name) ?? []; return list[list.length - 1] ?? null; }
  find(name, id) { return (this.runs.get(name) ?? []).find((r) => r.id === id) ?? null; }

  /**
   * Start a cycle. Refuses (throws) when the script is absent, the arguments do not fit, or the
   * daemon's own supervisor is still alive on the port and `takeover` was not asked for.
   */
  start(project, { kind = "run", target = "client", rebuild = true, takeover = false, ui = null, uiEdit = false, fabricApi = false } = {}) {
    if (!this.available) {
      throw new Error(`no rebuild script at ${this.script}: the daemon is not running from a workbench checkout `
        + "(an extracted dist has no tools/); set MMCPD_REBUILD to one, or launch the game by hand");
    }
    if (kind !== "run" && kind !== "stop") throw new Error(`kind must be run or stop, not ${kind}`);
    if (target !== "client" && target !== "server") throw new Error("target must be \"client\" or \"server\"");
    if (ui && target !== "client") throw new Error("\"ui\" needs target \"client\": a dedicated server has no screens to open");
    if (uiEdit && !ui) throw new Error("\"ui_edit\" needs \"ui\": there is no document to open");
    const busy = this.inFlight.get(project.port);
    if (busy && !takeover) {
      throw new Error(`a ${busy.kind} is already in flight on port ${project.port} (${busy.id}, ${busy.phase}, `
        + `${Math.round((Date.now() - busy.startedAt) / 1000)}s ago, ${busy.project}) - a second cycle's first act `
        + "would be to kill the first one's game; wait for it, or pass takeover:true to kill that supervisor");
    }
    mkdirSync(join(this.home, "runs"), { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = join(this.home, "runs", `${project.name}-${stamp}-${kind}.log`);
    const run = new Run({ project, kind, target, opts: { rebuild, takeover, ui, uiEdit, fabricApi }, file });
    const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", this.script,
      "-Project", project.root, "-Target", target, "-Port", String(project.port)];
    if (kind === "stop") args.push("-SkipBuild", "-NoRelaunch");
    else if (!run.rebuild) args.push("-SkipBuild");
    if (takeover) args.push("-Takeover");
    if (fabricApi) args.push("-FabricApi");
    if (ui) args.push("-Ui", ui);
    if (uiEdit) args.push("-UiEdit");

    // NOT detached, pipes into this process: the same shape as launch_game's spawn and for the same
    // reasons (powershell under DETACHED_PROCESS exits without running; a hidden console is fine).
    // The daemon is the long-lived parent the pipes need.
    const out = createWriteStream(file, { flags: "a" });
    out.write(`# mmcpd ${kind} ${project.name} :${project.port} ${target}${run.rebuild ? " rebuild" : ""}${takeover ? " takeover" : ""} at ${new Date(run.startedAt).toISOString()}\n# powershell ${args.join(" ")}\n`);
    let child;
    try {
      child = spawn("powershell.exe", args, { cwd: dirname(this.script), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      out.end(`SPAWN ERROR: ${e.message}\n`);
      throw new Error(`could not spawn powershell: ${e.message}`);
    }
    run.pid = child.pid ?? null;
    const list = this.runs.get(project.name) ?? [];
    list.push(run);
    while (list.length > KEEP_RUNS && !list[0].running) list.shift();
    this.runs.set(project.name, list);
    this.inFlight.set(project.port, run);
    this.installReaper();
    this.log(`${run.id}: ${kind} ${project.name} :${project.port} ${target}${run.rebuild ? " (rebuild)" : ""}${takeover ? " (takeover)" : ""} pid ${run.pid} -> ${file}`);

    // Lines, kept whole across chunk boundaries - per stream, so a stdout fragment is never glued
    // to a stderr line that happened to arrive between its two halves.
    const partial = { out: "", err: "" };
    const feed = (which) => (chunk) => {
      out.write(chunk);
      partial[which] += chunk.toString("utf8");
      let at;
      while ((at = partial[which].indexOf("\n")) >= 0) {
        const line = partial[which].slice(0, at).replace(/\r$/, "");
        partial[which] = partial[which].slice(at + 1);
        if (line.trim()) run.push(line);
      }
    };
    child.stdout.on("data", feed("out"));
    child.stderr.on("data", feed("err"));
    const finish = (code, why) => {
      if (this.inFlight.get(project.port)?.id === run.id) this.inFlight.delete(project.port);
      for (const which of ["out", "err"]) if (partial[which].trim()) { run.push(partial[which].replace(/\r$/, "")); partial[which] = ""; }
      if (why) { run.error = why; run.push(`SPAWN ERROR: ${why}`); }
      out.end(`\nEXIT=${code}\n`);
      run.end(code);
      this.log(`${run.id}: ${run.kind} ${project.name} ended - ${outcomeOf(code, run.kind)} after ${Math.round((Date.now() - run.startedAt) / 1000)}s`);
    };
    child.on("error", (err) => finish(null, err.message));
    child.on("exit", (code) => finish(code));
    return run;
  }

  run(project, opts = {}) { return this.start(project, { ...opts, kind: "run" }); }
  stop(project, opts = {}) { return this.start(project, { ...opts, kind: "stop", target: opts.target ?? "client", rebuild: false }); }

  /** The daemon is leaving: its supervisors go with it (each ONLY, never its tree). */
  killAll() {
    for (const run of this.inFlight.values()) {
      if (run.pid) { try { process.kill(run.pid); } catch { /* gone */ } }
    }
    this.inFlight.clear();
  }

  installReaper() {
    if (this.reaperInstalled) return;
    this.reaperInstalled = true;
    process.on("exit", () => this.killAll());
  }
}
