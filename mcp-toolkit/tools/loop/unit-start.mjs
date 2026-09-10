// `unit.start` - a command run BEFORE a unit's session, whose output is prepended to the brief
// (RELEASE_1.md section J5). Usage: node unit-start.mjs <cwd> <unit>
//
// The block loop's shape is scaffold -> rebuild once -> N sessions of judgement work, and the
// scaffold is the step that runs before any session exists; this is where it plugs in. The
// command's stdout is what the session reads first: a FILE LIST and the four-call recipe, a few
// hundred tokens, never the emitted Java - everything in the brief is re-sent every turn
// (LOOP_KIT_DESIGN.md section 11.1), so the output should be a pointer, not a payload.
//
// `${unit}` in any argument is the brief's file stem (MCPTK_UNIT), which is also in the child's
// environment. The command runs in <cwd> with no shell, so quote nothing. A non-zero exit is
// reported on stderr and passed through as this script's own exit code; run-unit.ps1 WARNS and
// still starts the session with the output prepended, because the commonest non-zero is a
// scaffold refusing to run twice on a unit that is being re-attempted, and that message is exactly
// what the session should read.
//
// No `unit` block, or no `start` in it: prints nothing, exits 0 - the loop file is not required to
// have one, and a loop file with neither is the loop that existed before this key did.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [cwd, unit] = process.argv.slice(2);
if (!cwd || !unit) {
  console.error("usage: node unit-start.mjs <cwd> <unit>");
  process.exit(2);
}
const loopFile = process.env.MCPTK_LOOP || join(cwd, ".mcptoolkit", "loop.json");
if (!existsSync(loopFile)) process.exit(0);
let loop;
try {
  loop = JSON.parse(readFileSync(loopFile, "utf8"));
} catch (e) {
  console.error(`[unit-start] ${loopFile} is not JSON: ${e.message}`);
  process.exit(2);
}
const start = loop?.unit?.start;
if (!start) process.exit(0);
if (!Array.isArray(start) || start.length === 0 || !start.every((s) => typeof s === "string")) {
  console.error(`[unit-start] unit.start must be a non-empty array of strings in ${loopFile}`);
  process.exit(2);
}
const argv = start.map((s) => s.replaceAll("${unit}", unit));
const startCwd = loop.unit.cwd ? join(cwd, loop.unit.cwd) : cwd;
const r = spawnSync(argv[0], argv.slice(1), {
  cwd: startCwd,
  env: { ...process.env, MCPTK_UNIT: unit },
  encoding: "utf8",
  shell: false,
  timeout: Number(loop.unit.timeout_ms) > 0 ? Number(loop.unit.timeout_ms) : 10 * 60 * 1000,
});
if (r.error) {
  console.error(`[unit-start] could not run ${argv.join(" ")}: ${r.error.message}`);
  process.exit(2);
}
process.stdout.write(`## Unit start: ${argv.join(" ")}\n\n${(r.stdout ?? "").trimEnd()}\n`);
if (r.status !== 0) {
  process.stderr.write(`[unit-start] exit ${r.status}: ${(r.stderr ?? "").trimEnd()}\n`);
  process.exit(r.status ?? 1);
}
