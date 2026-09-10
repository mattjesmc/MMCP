// Dev-workspace local tools — present only when this server runs from the mcmodding checkout
// (guard: tools/rebuild.ps1 exists two levels up). An extracted production copy in a game dir has
// no build tree, so these tools simply don't exist there.
//
// launch_game brings up the dev client/server via tools/rebuild.ps1 (stop → [build] → relaunch →
// wait-for-bridge). The script runs DETACHED and this tool returns immediately: MCP tool-call
// timeouts can't cover the ~4-minute cycle, and the bridge goes down mid-cycle anyway — the caller
// polls `ping` and reads the log file for build errors. rebuild.ps1's production-instance guard
// (refuses to kill env != development, exit 2) is inherited.
//
// THE PORT IS PUSHED DOWN, NOT DISCOVERED. This session's bridge port is frozen at process start
// (bridge-base.mjs) and there is no protocol for changing it; the game has not booted yet and will
// bind whatever it is told. So the immovable end dictates: basePort() -> rebuild.ps1 -Port ->
// -Pport -> -Dmcptoolkit.port, which outranks the target gameDir's config file. Without this,
// `target:"server"` was unwinnable - run-server/config/mcptoolkit.properties binds 25610, the
// launcher polled 25599, and a healthy server timed out unreachable for four minutes. The gameDir's
// own port setting still governs a hand-run `gradlew :runServer`; it just no longer governs us.
//
// TWO LAUNCHERS ON ONE PORT IS NOT A RACE, IT IS ONE SHOOTING THE OTHER'S GAME - rebuild.ps1's
// first act is to force-kill whatever holds the port. This server spawns a fresh supervisor per
// call and every Claude Code session in this checkout runs its own copy of this server, all
// pushing the same basePort() down, so the collision is between PROCESSES that cannot see each
// other. The authoritative fix is therefore rebuild.ps1's per-port lock (exit 3), which is the
// only scope that sees a rival in another session's tree. What this file adds is the in-process
// half: a second launch_game while our own supervisor is still running gets a refusal that names
// the pid and the log instead of a spawn that dies on the lock, and our supervisor is killed if
// this server exits under it - the supervisor ONLY, never its tree, because past its step 3 the
// game is its child and a tree kill would close the world.
//
// WHICH GAME IT LAUNCHES IS NOT WHERE THIS FILE LIVES. REPO_ROOT below is the shim's INSTALL
// location, and every repo in the workspace registers this same shim, so it used to be the same
// answer for all of them - from menagerie's session `launch_game` cycled the toolkit's game. The
// build root is resolved per call from this session's PORT (./project.mjs), because the port is
// already the project constant; an undecidable resolution is refused rather than defaulted.

import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { basePort } from "../bridge-base.mjs";
import { resolveLaunchProject } from "./project.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REBUILD = join(REPO_ROOT, "tools", "rebuild.ps1");
const IS_DEV_CHECKOUT = existsSync(REBUILD);

// The supervisor this server currently has in flight, keyed by port. Cleared on its exit.
const inFlight = new Map();

// Best-effort only: a hard-killed MCP server runs no handler at all, which is precisely why the
// port lock (not this) is the load-bearing guard. Single process, never the tree - see the header.
let reaperInstalled = false;
function installReaper() {
  if (reaperInstalled) return;
  reaperInstalled = true;
  const reap = () => {
    for (const [, entry] of inFlight) {
      try { process.kill(entry.pid); } catch { /* already gone */ }
    }
    inFlight.clear();
  };
  process.on("exit", reap);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    try { process.on(sig, () => { reap(); process.exit(0); }); } catch { /* unsupported signal */ }
  }
}

const TOOLS = IS_DEV_CHECKOUT
  ? [
      {
        name: "launch_game",
        description:
          "Launch (or restart) the DEV Minecraft instance via tools/rebuild.ps1: stops any game on the dev " +
          "port, optionally rebuilds the mod, relaunches gradle runClient/runServer detached, and waits for " +
          "the bridge. THIS SESSION'S OWN PROJECT — the build root is resolved from this session's bridge " +
          "port, and refused rather than guessed if that is undecidable. " +
          "Returns immediately — poll `ping` until it answers (up to ~4 min; a rebuild adds " +
          "build time). ONE CYCLE PER PORT: if another launch is already in flight (this session's or " +
          "another's) this is refused rather than run, because a second cycle's first act would be to " +
          "kill the first one's game — pass \"takeover\" true to kill that supervisor and claim the " +
          "cycle. The script also refuses to stop a production instance. Check the returned log file " +
          "if the bridge never comes up (exit 0=up, 1=bridge timeout - the log then carries the crash " +
          "report and latest.log tail the dead game left, 2=refused production, 3=another " +
          "cycle owns the port, 4=no such build root, other=build failure). \"target\": \"client\" (full UI/asset tools) or " +
          "\"server\" (headless, SERVER-context tools only). \"rebuild\" false skips the gradle build. " +
          "\"ui\" boots the client STRAIGHT INTO the toolkit's authoring world (a flat, empty, weatherless, " +
          "mobless save it creates on first use) with that screen-authoring document open - no world to pick " +
          "and no open_world call; add \"ui_edit\" for the in-game editor. Client only.",
        inputSchema: {
          type: "object",
          properties: {
            target: { type: "string", enum: ["client", "server"] },
            rebuild: { type: "boolean", description: "Rebuild the mod first (default true)." },
            takeover: {
              type: "boolean",
              description:
                "Kill the rebuild supervisor that already owns this port and claim the cycle " +
                "(default false, which refuses instead). Use when a previous launch is stuck.",
            },
            ui: {
              type: "string",
              description:
                "Open this screen-authoring document in the authoring world once the client is up: " +
                "\"<mod>:<screen>\" or a path. Client only.",
            },
            ui_edit: {
              type: "boolean",
              description: "With \"ui\": arm the in-game editor instead of a read-only preview.",
            },
          },
          required: ["target"],
        },
        mechanism: "privileged",
      },
    ]
  : [];

const byName = new Map(TOOLS.map((t) => [t.name, t]));

export function localTools() {
  return TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

export function isLocalTool(name) {
  return byName.has(name);
}

export async function callLocalTool(name, args) {
  const a = args ?? {};
  try {
    switch (name) {
      case "launch_game": {
        const target = a.target;
        if (target !== "client" && target !== "server") {
          return { ok: false, error: "target must be \"client\" or \"server\"" };
        }
        const rebuild = a.rebuild !== false;
        const takeover = a.takeover === true;
        const ui = typeof a.ui === "string" && a.ui.trim() !== "" ? a.ui.trim() : null;
        const uiEdit = a.ui_edit === true;
        // Refused here rather than downstream, for the reason rebuild.ps1 refuses it before its own
        // step 1: everything past this point stops a running game.
        if (ui && target !== "client") {
          return { ok: false, error: "\"ui\" needs target \"client\": a dedicated server has no screens to open" };
        }
        if (uiEdit && !ui) {
          return { ok: false, error: "\"ui_edit\" needs \"ui\": there is no document to open" };
        }
        // The port this session can actually reach. Handed to the launcher so the game it boots
        // binds here rather than wherever its gameDir's config file happens to point.
        const port = basePort();

        // ...and, from that same number, WHICH project's game that is. Resolved per call rather
        // than at import: cwd and the workspace are the session's facts, not the shim's.
        const project = resolveLaunchProject({ port, repoRoot: REPO_ROOT });
        if (!project.ok) {
          return { ok: false, error: `launch_game cannot tell which project to launch: ${project.error}` };
        }

        // Refuse before spawning. rebuild.ps1's lock would catch this anyway (exit 3), but only
        // after a process has been started and only in a log file the caller has to go read; a
        // refusal here names the supervisor and its log in the reply that asked for it.
        const running = inFlight.get(port);
        if (running && !takeover) {
          const ageSec = Math.round((Date.now() - running.startedAt) / 1000);
          return {
            ok: false,
            error:
              `a launch_game cycle is already in flight on port ${port} (pid ${running.pid}, ` +
              `started ${ageSec}s ago, target ${running.target}) — refusing to start a second one, ` +
              `because its first act would be to kill the first cycle's game. Poll \`ping\`, read ` +
              `${running.log}, or call again with "takeover": true to kill that supervisor. ` +
              "`tools/dev-procs.ps1` lists every supervisor, Gradle daemon and dev JVM on this machine.",
          };
        }

        const log = join(tmpdir(), `mcptk-launch-${process.pid}-${Date.now()}.log`);
        // NOT detached: powershell.exe under DETACHED_PROCESS exits 0 without executing anything
        // (its console host needs a console; windowsHide gives it a hidden one). -File keeps
        // Windows argument quoting trivial and makes the script's `exit` codes the process's own.
        // Node-side pipes into a WriteStream — raw-fd inheritance proved unreliable with a hidden
        // console; pipes require this (long-lived) server process to stay up through the cycle,
        // which it does, and the script's total output is far below any pipe-buffer limit anyway.
        const out = createWriteStream(log, { flags: "a" });
        const child = spawn("powershell.exe",
          ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", REBUILD,
           "-Project", project.dir, "-Target", target, "-Port", String(port),
           ...(rebuild ? [] : ["-SkipBuild"]),
           ...(takeover ? ["-Takeover"] : []),
           ...(ui ? ["-Ui", ui] : []),
           ...(uiEdit ? ["-UiEdit"] : [])], {
          cwd: REPO_ROOT,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        inFlight.set(port, { pid: child.pid, log, target, startedAt: Date.now() });
        installReaper();
        child.stdout.pipe(out, { end: false });
        child.stderr.pipe(out, { end: false });
        // 'error' fires async (ENOENT/EPERM after spawn returns); with no listener it is an
        // uncaught exception that kills this whole MCP server — the try/catch around us can't see it.
        child.on("error", (err) => {
          if (inFlight.get(port)?.pid === child.pid) inFlight.delete(port);
          out.write(`\nSPAWN ERROR: ${err.message}\n`);
          out.end();
        });
        child.on("exit", (code) => {
          // Compare pids: a -Takeover call replaces this entry, and the killed supervisor's exit
          // arrives AFTER that, so an unconditional delete would clear its successor's slot.
          if (inFlight.get(port)?.pid === child.pid) inFlight.delete(port);
          out.write(`\nEXIT=${code}\n`);
          out.end();
        });
        return {
          ok: true,
          result: {
            launched: true,
            target,
            rebuild,
            takeover,
            ui,
            uiEdit,
            port,
            project: project.dir,
            projectVia: project.how,
            pid: child.pid,
            log,
            note:
              `launching ${project.dir} (resolved from ${project.how}) on port ${port} - this ` +
              "session's own bridge port, pushed down to the game, so the target's config file " +
              "cannot send it somewhere unreachable. " +
              (ui
                ? `the client will enter the authoring world and open ${ui}${uiEdit ? " in the editor" : ""} by ` +
                  "itself - poll `get_screen`, not just `ping`, until it names InterpretedScreen. "
                : "") +
              "rebuild.ps1 running detached — the bridge goes DOWN during the cycle, then comes back. " +
              "Poll `ping` until it answers (up to ~4 min). If it never does, read the log file: " +
              "exit 0=up, 1=bridge timeout (the log then ends with the header of any crash report the " +
              "game wrote during this launch and the tail of its logs/latest.log - a failed boot's " +
              "reason is there, not in any tool), 2=refused production instance, 3=another rebuild cycle " +
              "already owns this port (retry with takeover:true), 4=no such build root, other=build failure.",
            mechanism: "privileged",
          },
        };
      }
      default:
        return { ok: false, error: `unknown local tool: ${name}` };
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
