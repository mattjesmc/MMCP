// The project loop file: `.mcptoolkit/loop.json` beside the workspace's `.mcp.json`, or whatever
// MCPTK_LOOP names. LOOP_KIT_DESIGN.md §5.2 (checks + gate) and §5.3 (the project profile).
//
// WHAT THIS FILE IS FOR. ArmorPieces — the toolkit's one real user — wrote a 1050-line MCP proxy of
// its own in front of Blockbench, and almost all of it was three things the toolkit could not be told:
// which slice of the upstream to serve (with a sentence of the workspace's rules appended to each
// tool's description), a checker to run after every call that edits (its compact report riding the
// reply, so "6/54 faces unpainted" is a line the model reads before it thinks it is done), and a save
// that refuses while problems stand. None of those is about armor. This file is where a project
// declares them, and the shim does the rest.
//
//   {
//     "checks": [{
//       "name": "part",
//       "after": { "mechanism": ["world_edit", "blockbench_edit"], "tools": ["risky_eval"], "not": ["undo"] },
//       "run": ["python", "tools/check_part.py", "--status", "--json", "--brief"],   // or "eval": "<js>"
//       "stateful": true,            // the previous report is handed back (--previous <file> / __previous)
//       "gate": ["export_model"],    // a tool THIS shim serves: refused while problems stand, unless `force`
//       "timeout_ms": 5000,
//       "cwd": "."                   // relative to the loop file's project root
//     }],
//     "profile": {
//       "base": "art",
//       "keep": ["place_cube", "modify_cube", "..."],
//       "notes": { "place_cube": " In an Armor Piece put the cube in a bone group under `part`..." },
//       "instructions": "Blockbench is running with the Armor Pieces plugin..."
//     }
//   }
//
// THE CHECKER CONTRACT. `run` is a command whose LAST stdout line is JSON:
//   { "text": "<compact block for the reply>", "problems": N, "notes": N, "full": "<long form>" }
// The shim appends `text` and renders nothing else — the `!`/`-` vocabulary inside it is the
// checker's own. `problems` is what the gate reads. Everything else in the object is the checker's
// business and rides into the previous-report file for the next run. An `eval` check runs inside
// Blockbench through `risky_eval` and its VALUE is that object.
//
// `after` selects by the MECHANISM the manifest already stamps on every bridge tool (observe /
// embodied / world_edit / privileged), which is how "read-only calls never trigger" is derived rather
// than hand-kept. The Blockbench plugin stamps its own manifest the same way (observe /
// blockbench_edit; since 0.64.0 it is the toolkit's own plugin, BLOCKBENCH_BRIDGE_DESIGN.md), and
// the painters are its tools. `tools` adds names; `not` removes them. There is no `local`
// mechanism to select: a local tool is stamped with the upstream it edits.
//
// `stateful` IS PER SHIM. The previous report lives under the OS temp directory, keyed by this
// process, and is handed to the checker as `--previous <file>`. That is one history per shim
// instance: a project whose OWN server runs the same checker after its own edits gets a second,
// independent history, and a diff across the two ("a face that was complete and grew") compares
// against a state the other server never saw. A checker that runs from more than one place should
// own its history (ArmorPieces' check_active.py keeps it beside the piece's status directory and
// ignores `--previous`); the loop's file is for a checker with exactly one caller.
//
// `gate` names tools THIS SHIM serves. A gate naming a tool of another MCP server (a project's own
// proxy) is nothing: the call never passes through here. index.mjs says so on stderr once the
// manifest is known, because a gate that looks like a guard and is not one is the failure this
// whole file exists to prevent.

import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { spawn } from "node:child_process";

const MECHANISMS = new Set(["observe", "embodied", "world_edit", "privileged", "blockbench_edit"]);

/** Where the loop file is, if anywhere. MCPTK_LOOP wins; else <cwd>/.mcptoolkit/loop.json. */
export function loopPath() {
  const explicit = (process.env.MCPTK_LOOP ?? "").trim();
  if (explicit) return resolve(explicit);
  const conventional = join(process.cwd(), ".mcptoolkit", "loop.json");
  return existsSync(conventional) ? conventional : null;
}

/**
 * Read and validate the loop file. Throws on a malformed one — a project that wrote a loop file
 * meant it, and a check that silently never fires is the failure the whole design is about.
 * Returns null when there is no file.
 */
export function loadLoop(path = loopPath()) {
  if (!path) return null;
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`loop file ${path}: ${e.message}`);
  }
  // The project root: the directory holding `.mcptoolkit/`, or the file's own directory when it was
  // named explicitly from somewhere else. `run` commands and relative `cwd` resolve against it.
  const dir = dirname(path);
  const root = /[\\/]\.mcptoolkit$/.test(dir) ? dirname(dir) : dir;
  const checks = [];
  for (const [i, c] of (raw.checks ?? []).entries()) {
    const where = `loop file ${path}: checks[${i}]`;
    if (!c || typeof c !== "object") throw new Error(`${where} is not an object`);
    const hasRun = Array.isArray(c.run) && c.run.length && c.run.every((s) => typeof s === "string");
    const hasEval = typeof c.eval === "string" && c.eval.trim();
    if (!hasRun && !hasEval) throw new Error(`${where} needs "run" (a command array) or "eval" (JavaScript for Blockbench)`);
    if (hasRun && hasEval) throw new Error(`${where} has both "run" and "eval"; pick one`);
    const after = c.after ?? {};
    const mechanism = [].concat(after.mechanism ?? []);
    for (const m of mechanism) {
      if (m === "local") {
        throw new Error(`${where}.after.mechanism "local" selects nothing: the shim's own tools carry the mechanism `
          + `of the upstream they edit (the painters are "blockbench_edit")`);
      }
      if (!MECHANISMS.has(m)) throw new Error(`${where}.after.mechanism "${m}" is not one of ${[...MECHANISMS].join(", ")}`);
    }
    const tools = [].concat(after.tools ?? []);
    const not = [].concat(after.not ?? []);
    if (!mechanism.length && !tools.length) throw new Error(`${where}.after names no mechanism and no tools, so it would never fire`);
    checks.push({
      name: typeof c.name === "string" && c.name ? c.name : hasRun ? c.run[c.run.length - 1] : `eval-${i}`,
      mechanism: new Set(mechanism),
      tools: new Set(tools),
      not: new Set(not),
      run: hasRun ? c.run : null,
      eval: hasEval ? c.eval : null,
      stateful: c.stateful === true,
      gate: new Set([].concat(c.gate ?? [])),
      timeoutMs: Number.isFinite(c.timeout_ms) ? c.timeout_ms : 5000,
      cwd: typeof c.cwd === "string" ? (isAbsolute(c.cwd) ? c.cwd : resolve(root, c.cwd)) : root,
    });
  }
  let profile = null;
  if (raw.profile !== undefined) {
    const p = raw.profile;
    const where = `loop file ${path}: profile`;
    if (!p || typeof p !== "object") throw new Error(`${where} is not an object`);
    if (p.keep !== undefined && !(Array.isArray(p.keep) && p.keep.every((s) => typeof s === "string"))) {
      throw new Error(`${where}.keep must be an array of tool names`);
    }
    if (p.notes !== undefined && (typeof p.notes !== "object" || Array.isArray(p.notes))) {
      throw new Error(`${where}.notes must be an object of tool name -> sentence`);
    }
    if (p.instructions !== undefined && typeof p.instructions !== "string") {
      throw new Error(`${where}.instructions must be a string`);
    }
    profile = {
      base: typeof p.base === "string" && p.base ? p.base : "modding",
      keep: p.keep ? new Set(p.keep) : null,
      notes: p.notes ?? {},
      instructions: p.instructions ?? null,
    };
  }
  return { path, root, checks, profile };
}

/** Does a check fire after this tool? Name rules beat mechanism rules; `not` beats everything. */
export function fires(check, name, mechanism) {
  if (check.not.has(name)) return false;
  if (check.tools.has(name)) return true;
  return mechanism ? check.mechanism.has(mechanism) : false;
}

function runCommand(argv, { cwd, timeoutMs }) {
  return new Promise((done) => {
    let stdout = "", stderr = "";
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      done({ error: e.message, stdout, stderr });
      return;
    }
    const timer = setTimeout(() => { child.kill(); done({ error: `timed out after ${timeoutMs} ms`, stdout, stderr }); }, timeoutMs);
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (e) => { clearTimeout(timer); done({ error: e.message, stdout, stderr }); });
    child.on("close", (code) => { clearTimeout(timer); done({ code, stdout, stderr }); });
  });
}

/** The last non-empty line of a stream, parsed as JSON; null when it is not JSON. */
function lastJsonLine(text) {
  const line = text.trim().split("\n").filter((l) => l.trim()).pop() ?? "";
  try {
    const v = JSON.parse(line);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

/**
 * The runtime half: runs the checks a call triggers, keeps each check's last report, and answers
 * the gate. One instance per shim.
 *
 * `runEval(code)` is how an `eval` check reaches Blockbench (index.mjs passes callBlockbench's
 * risky_eval); it returns the tool result's text. `log` is stderr.
 */
export class LoopChecks {
  constructor(loop, { runEval = null, log = (s) => process.stderr.write(`${s}\n`) } = {}) {
    this.loop = loop;
    this.runEval = runEval;
    this.log = log;
    this.last = new Map(); // check name -> last report object (or null when it could not run)
    this.stateDir = join(tmpdir(), "mcptk-loop", String(process.pid));
  }

  get checks() { return this.loop?.checks ?? []; }

  /** Every tool some check gates. `force` is added to these tools' schemas (index.mjs). */
  gatedTools() {
    const out = new Set();
    for (const c of this.checks) for (const t of c.gate) out.add(t);
    return out;
  }

  /**
   * The refusal for a gated call, or null when it may proceed. A call carrying `force` proceeds and
   * the reason is what comes back as `forced`, so the reply can say it out loud.
   */
  gate(name, args) {
    const standing = [];
    for (const c of this.checks) {
      if (!c.gate.has(name)) continue;
      const r = this.last.get(c.name);
      const problems = r && typeof r === "object" ? Number(r.problems) || 0 : 0;
      if (problems > 0) standing.push({ check: c.name, problems, text: r.text ?? "" });
    }
    if (!standing.length) return { refused: null, forced: null };
    const force = args?.force;
    if (force === true || (typeof force === "string" && force.trim())) {
      const why = typeof force === "string" ? force.trim() : "(no reason given)";
      this.log(`[mcp-toolkit] loop: "${name}" FORCED past ${standing.map((s) => `${s.problems} problem(s) from check "${s.check}"`).join(", ")}: ${why}`);
      return { refused: null, forced: { why, standing } };
    }
    const lines = [`gated: "${name}" refused - ${standing.map((s) => `${s.problems} problem(s) stand from the last "${s.check}" check`).join("; ")}.`];
    for (const s of standing) if (s.text) lines.push(s.text);
    lines.push(`Fix them, or call again with force:"<why>" and say why each is acceptable.`);
    return { refused: lines.join("\n"), forced: null };
  }

  /**
   * Run every check this call triggers and return the text to append to the reply, or null. Runs
   * only after a SUCCESSFUL call: a refused edit changed nothing, and a check on nothing is noise.
   */
  async after(name, mechanism) {
    const out = [];
    for (const c of this.checks) {
      if (!fires(c, name, mechanism)) continue;
      out.push(await this.runOne(c));
    }
    return out.length ? out.join("\n") : null;
  }

  async runOne(c) {
    const previous = c.stateful ? this.last.get(c.name) ?? null : null;
    let report = null;
    let failure = null;
    if (c.run) {
      const argv = [...c.run];
      if (c.stateful) {
        mkdirSync(this.stateDir, { recursive: true });
        const file = join(this.stateDir, `${c.name.replace(/[^\w.-]/g, "_")}.previous.json`);
        writeFileSync(file, JSON.stringify(previous), "utf8");
        argv.push("--previous", file);
      }
      const r = await runCommand(argv, { cwd: c.cwd, timeoutMs: c.timeoutMs });
      report = lastJsonLine(r.stdout);
      if (!report) {
        const tail = (r.stderr || r.stdout).trim().split("\n").pop() ?? "";
        failure = r.error ?? (tail || `exit ${r.code} with no JSON on its last line`);
      }
    } else {
      if (!this.runEval) {
        failure = "an eval check needs Blockbench, and this profile does not serve it";
      } else {
        // "\/" is "/" in a JSON string literal; kept from the days of the old plugin's comment
        // filter, harmless now, and it keeps an eval check portable to a shim still on that plugin.
        const code = `var __previous = ${JSON.stringify(previous).replace(/\//g, "\\/")};\n${c.eval}`;
        try {
          const text = await this.runEval(code);
          report = lastJsonLine(text);
          if (!report) failure = (text ?? "").trim().split("\n").pop() || "eval returned no JSON";
        } catch (e) {
          failure = e.message;
        }
      }
    }
    // The contract is `text` (a string) and/or `problems` (a number). A last line that parses as
    // JSON but carries neither is something else - the entity plugin's own {ok:false, error}
    // envelope was riding replies as a "report" on the first live run (an outdated plugin without
    // the action), and a gate reading `problems` from it would have found nothing standing.
    if (report && typeof report.text !== "string" && typeof report.problems !== "number") {
      failure = `the last line is JSON but not a check report (no "text"/"problems"): ${JSON.stringify(report).slice(0, 200)}`;
      report = null;
    }
    if (report) {
      this.last.set(c.name, report);
      return typeof report.text === "string" ? report.text : JSON.stringify(report);
    }
    // LOUD. A check nobody executes is not a guard (ArmorPieces shipped three broken checkers in
    // 0.2.0 because nothing ran them), and a check that fails to run must not read as "no problems".
    this.last.set(c.name, null);
    return `[loop] check "${c.name}" could not run: ${failure}`;
  }
}
