// The supervisor and the cockpit's routes (HOST_DESIGN.md sections 3.6, 6, 8): a run is one
// rebuild.ps1 cycle the daemon spawns, keeps the output of line by line, reads the phase off, and
// serves - as JSON, and as SSE while it runs; one cycle per port; the cockpit pages are served.
//
// NO GAME, NO GRADLE. MMCPD_REBUILD points the daemon at a FAKE rebuild.ps1 that prints the real
// script's `[rebuild]` lines with a delay between them and exits with the code its arguments ask
// for, so what is asserted is the daemon's half: the spawn, the argument line, the phase machine,
// the refusal of a second cycle, the SSE tail, the run history. What the real script does with a
// game is rebuild.ps1's own record and the live check in section 15.
//
// Battery chunk b. Run alone: node --test probes/supervisor.test.mjs

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

const freePort = () => new Promise((resolve, reject) => {
  const s = createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

const home = mkdtempSync(join(tmpdir(), "mmcpd-sup-"));
const root = join(home, "gamma");
mkdirSync(join(root, "src", "main", "resources"), { recursive: true });
mkdirSync(join(root, "run", "logs"), { recursive: true });
writeFileSync(join(root, "gradle.properties"), "mcmod.port=25996\n");
writeFileSync(join(root, "src", "main", "resources", "fabric.mod.json"), "{}");
writeFileSync(join(root, "run", "logs", "latest.log"), Array.from({ length: 300 }, (_, i) => `[line ${i + 1}] something the loader said`).join("\n") + "\n");

// The fake: rebuild.ps1's own phase lines, one every 150 ms, and the exit code the -Target
// smuggles in through the -Ui argument (the real script's -Ui is a document name; here it is the
// code to exit with, so a probe can ask for a failure without a second script).
const fake = join(home, "fake-rebuild.ps1");
writeFileSync(fake, `param([string]$Project, [string]$Target, [int]$Port, [switch]$SkipBuild, [switch]$NoRelaunch, [switch]$Takeover, [switch]$Force, [switch]$FabricApi, [string]$Ui, [switch]$UiEdit)
$code = 0
if ($Ui -match '^exit(\\d+)$') { $code = [int]$Matches[1] }
Write-Host "[rebuild] args: project=$Project target=$Target port=$Port skipbuild=$SkipBuild norelaunch=$NoRelaunch takeover=$Takeover fabricapi=$FabricApi ui=$Ui"
Write-Host "[rebuild] holding the port-$Port cycle lock (pid $PID)."
Start-Sleep -Milliseconds 150
Write-Host "[rebuild] no running game detected."
if ($NoRelaunch) { Write-Host "[rebuild] -NoRelaunch set; done."; exit 0 }
if (-not $SkipBuild) {
  Write-Host "[rebuild] building gamma ($Project, gradlew build)..."
  Start-Sleep -Milliseconds 150
  if ($code -eq 7) { Write-Error "[rebuild] build FAILED (exit 7) - not relaunching." -ErrorAction Continue; exit 7 }
  Write-Host "[rebuild] build OK."
}
Write-Host "[rebuild] launching gamma :runClient (detached)..."
Start-Sleep -Milliseconds 150
Write-Host "[rebuild] waiting for the bridge on port $Port (up to ~4 min)..."
Start-Sleep -Milliseconds 300
if ($code -eq 1) { Write-Error "[rebuild] timed out waiting for the bridge. Check the game window / Gradle output." -ErrorAction Continue; exit 1 }
Write-Host "[rebuild] bridge is up. Tools are live."
exit $code
`);

process.env.MMCP_HOME = home;
process.env.MMCPD_REBUILD = fake;
process.env.MMCPD_WATCH = "0";

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function untilDone(name, id, ms = 15_000) {
  const t0 = Date.now();
  for (;;) {
    const { body } = await api("GET", `/projects/${name}/log?run=${id}`);
    if (!body.run.running) return body;
    if (Date.now() - t0 > ms) throw new Error(`run ${id} still running after ${ms}ms: ${JSON.stringify(body.run)}`);
    await sleep(100);
  }
}
async function* sse(path) {
  const res = await fetch(`${base}${path}`, { headers: { Accept: "text/event-stream" } });
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    let at;
    while ((at = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, at);
      buf = buf.slice(at + 2);
      const event = chunk.split("\n").find((l) => l.startsWith("event: "))?.slice(7);
      const data = chunk.split("\n").find((l) => l.startsWith("data: "))?.slice(6);
      if (event && data) yield { event, data: JSON.parse(data) };
    }
  }
}

describe("mmcpd supervisor + cockpit", () => {
  before(async () => {
    port = await freePort();
    process.env.MMCPD_PORT = String(port);
    const { Daemon } = await import("../daemon.mjs");
    const { loadRegistry, saveRegistry, addProject, scanProject } = await import("../daemon/registry.mjs");
    const reg = loadRegistry();
    addProject(reg, scanProject(root));
    saveRegistry(reg);
    daemon = new Daemon({ port });
    await daemon.start();
    base = `http://127.0.0.1:${port}`;
  });
  after(async () => {
    daemon.supervisor.killAll();
    daemon.server?.close();
    await sleep(200);
    rmSync(home, { recursive: true, force: true });
  });

  test("the cockpit is served at /ui/ and / redirects to it; nothing outside daemon/ui is", async () => {
    const page = await fetch(`${base}/ui/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /text\/html/);
    const html = await page.text();
    assert.match(html, /<title>MMCP cockpit<\/title>/);
    assert.match(html, /cockpit\.js/);
    const js = await fetch(`${base}/ui/cockpit.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type"), /javascript/);
    const rootRes = await fetch(`${base}/`, { redirect: "manual" });
    assert.equal(rootRes.status, 302);
    assert.equal(rootRes.headers.get("location"), "/ui/");
    for (const bad of ["/ui/../daemon.mjs", "/ui/%2e%2e/package.json", "/ui/nope.html"]) {
      const r = await fetch(`${base}${bad}`);
      assert.equal(r.status, 404, bad);
    }
    // A page from another origin is refused, as every daemon route is.
    const foreign = await fetch(`${base}/ui/`, { headers: { Origin: "http://evil.example" } });
    assert.equal(foreign.status, 403);
    const { body: status } = await api("GET", "/status");
    assert.equal(status.ui, `${base}/ui/`);
    assert.equal(status.supervisor.available, true);
    assert.equal(status.supervisor.script, fake);
  });

  test("a run is spawned with the script's arguments, its phases are read off its lines, and it ends `up`", async () => {
    const { status, body } = await api("POST", "/projects/gamma/run", { target: "client", rebuild: true });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.run.kind, "run");
    assert.equal(body.run.running, true);
    assert.equal(body.run.port, 25996);
    assert.ok(body.run.pid > 0, "a pid");
    assert.match(body.note, /goes DOWN/);
    const id = body.run.id;

    // While it runs, the project says `building` and carries the run, with the phase the script's
    // last line announced (PowerShell takes a moment to start: wait for its first line, not a
    // fixed sleep).
    let gamma;
    for (let i = 0; i < 100; i++) {
      const { body: projects } = await api("GET", "/projects");
      gamma = projects.projects.find((p) => p.name === "gamma");
      if (gamma.run && gamma.run.phase !== "starting") break;
      await sleep(100);
    }
    assert.equal(gamma.state, "building");
    assert.equal(gamma.run?.id, id);
    assert.ok(["locked", "stopped", "building", "built", "launching", "waiting"].includes(gamma.run.phase), gamma.run.phase);

    const done = await untilDone("gamma", id);
    assert.equal(done.run.exit, 0);
    assert.equal(done.run.outcome, "up");
    assert.equal(done.run.phase, "up");
    assert.equal(done.run.running, false);
    const args = done.lines.find((l) => l.includes("[rebuild] args:"));
    assert.ok(args, "the script's argument line");
    assert.match(args, /target=client/);
    assert.match(args, /port=25996/);
    assert.match(args, /skipbuild=False/);
    assert.match(args, /norelaunch=False/);
    assert.match(args, new RegExp(`project=${root.replace(/[\\/]/g, "[\\\\/]").replace(/\./g, "\\.")}`, "i"));
    assert.ok(done.lines.some((l) => l.includes("bridge is up")));
    // The log file on disk carries the same lines and the exit.
    assert.ok(existsSync(done.run.log), "log file");
    const file = readFileSync(done.run.log, "utf8");
    assert.match(file, /bridge is up/);
    assert.match(file, /EXIT=0/);

    // Nothing in flight now: the project shows down and remembers the run.
    const { body: after } = await api("GET", "/projects");
    const g2 = after.projects.find((p) => p.name === "gamma");
    assert.equal(g2.state, "down");
    assert.equal(g2.run, null);
    assert.equal(g2.last_run?.id, id);
    assert.equal(g2.last_run.outcome, "up");
  });

  test("SSE tails a run: the lines as they come, then `exit` with the verdict, then the stream ends", async () => {
    const { body } = await api("POST", "/projects/gamma/run", { rebuild: false });
    const id = body.run.id;
    const seen = [];
    let exit = null;
    for await (const ev of sse(`/projects/gamma/log?run=${id}`)) {
      if (ev.event === "line") seen.push(ev.data);
      if (ev.event === "exit") exit = ev.data;
    }
    assert.ok(exit, "the stream ended with exit");
    assert.equal(exit.exit, 0);
    assert.equal(exit.outcome, "up");
    assert.ok(seen.some((l) => /skipbuild=True/.test(l)), "rebuild:false is -SkipBuild");
    assert.ok(!seen.some((l) => /gradlew build/.test(l)), "no build phase");
    assert.ok(seen.some((l) => /bridge is up/.test(l)));
    // A finished run replays and ends at once.
    const replay = [];
    for await (const ev of sse(`/projects/gamma/log?run=${id}`)) replay.push(ev.event);
    assert.equal(replay[0], "run");
    assert.equal(replay[replay.length - 1], "exit");
    assert.equal(replay.filter((e) => e === "line").length, seen.length);
  });

  test("one cycle per port: a second run while the first is alive is refused with the first one named; takeover is passed down", async () => {
    const { body: first } = await api("POST", "/projects/gamma/run", { rebuild: true });
    const { status, body } = await api("POST", "/projects/gamma/run", { rebuild: true });
    assert.equal(status, 409);
    assert.match(body.error, new RegExp(first.run.id));
    assert.match(body.error, /kill the first one's game/);
    const { status: s2, body: taken } = await api("POST", "/projects/gamma/run", { rebuild: false, takeover: true });
    assert.equal(s2, 200, JSON.stringify(taken));
    const done = await untilDone("gamma", taken.run.id);
    assert.ok(done.lines.some((l) => /takeover=True/.test(l)), "-Takeover reached the script");
    await untilDone("gamma", first.run.id);
  });

  test("a stop is the script told to relaunch nothing; a failed build and a bridge timeout are named as such", async () => {
    const { body: stop } = await api("POST", "/projects/gamma/stop", {});
    assert.equal(stop.run.kind, "stop");
    const stopped = await untilDone("gamma", stop.run.id);
    assert.equal(stopped.run.outcome, "stopped");
    assert.equal(stopped.run.phase, "stopped");
    assert.ok(stopped.lines.some((l) => /norelaunch=True/.test(l) && /skipbuild=True/.test(l)));

    const { body: failed } = await api("POST", "/projects/gamma/run", { ui: "exit7" });
    const f = await untilDone("gamma", failed.run.id);
    assert.equal(f.run.exit, 7);
    assert.equal(f.run.phase, "build-failed");
    assert.equal(f.run.outcome, "build failed (exit 7)");

    const { body: timeout } = await api("POST", "/projects/gamma/run", { ui: "exit1", rebuild: false });
    const t = await untilDone("gamma", timeout.run.id);
    assert.equal(t.run.exit, 1);
    assert.equal(t.run.phase, "timeout", JSON.stringify(t.lines));
    assert.equal(t.run.outcome, "bridge timeout");

    // The refusals the daemon makes before spawning.
    const { status: s1, body: b1 } = await api("POST", "/projects/gamma/run", { target: "server", ui: "x" });
    assert.equal(s1, 409);
    assert.match(b1.error, /needs target "client"/);
    const { status: s2 } = await api("POST", "/projects/nope/run", {});
    assert.equal(s2, 404);

    const { body: runs } = await api("GET", "/projects/gamma/runs");
    assert.ok(runs.runs.length >= 6, `history: ${runs.runs.length}`);
    assert.ok(runs.runs.every((r) => !r.running));
    assert.deepEqual(runs.runs.slice(-2).map((r) => r.outcome), ["build failed (exit 7)", "bridge timeout"]);
  });

  test("the game's latest.log is tailed from the registry's gameDir, last lines only", async () => {
    const { body } = await api("GET", "/projects/gamma/latest?lines=5");
    assert.equal(body.exists, true);
    assert.equal(body.lines.length, 5);
    assert.equal(body.lines[4], "[line 300] something the loader said");
    assert.match(body.file, /gamma[\\/]run[\\/]logs[\\/]latest\.log$/);
    const { body: none } = await api("GET", "/projects/gamma/latest?lines=5&x=1");
    assert.equal(none.exists, true);
  });

  test("without a script every other route works and a run says why it cannot", async () => {
    const was = daemon.supervisor.script;
    daemon.supervisor.script = join(home, "absent.ps1");
    try {
      const { status, body } = await api("POST", "/projects/gamma/run", {});
      assert.equal(status, 409);
      assert.match(body.error, /no rebuild script/);
      const { body: status2 } = await api("GET", "/status");
      assert.equal(status2.supervisor.available, false);
      const { status: s } = await api("GET", "/projects");
      assert.equal(s, 200);
    } finally {
      daemon.supervisor.script = was;
    }
  });
});
