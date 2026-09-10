// Probe for THE COMMAND ROOT (RELEASE_1.md §B2): every `/mmcp` subtree answers, and the three roots
// it replaced are GONE.
//
// WHAT WAS COLLAPSED. `/claude`, `/mcptk` and `/review`, registered from five files for no reason
// beyond the order they were built in, are one tree under `/mmcp` (`CommandRoot`). The rename is
// free exactly once - before the first person outside this machine has typed one - which is the
// whole argument for doing it now rather than after a tag.
//
// TWO CLAIMS, AND THE SECOND IS THE ONE THAT COULD ROT. That each subtree answers is the easy half.
// The half worth a probe is that the OLD roots do not: Brigadier keeps whatever is registered, so a
// half-done rename leaves both alive and everything looks fine from the inside, while the docs, the
// review card and the muscle memory quietly disagree about which one is real. Case 2 is red the
// moment any file goes back to registering its own root.
//
// HOW AN UNKNOWN COMMAND IS SEEN. `run_command` answers ok:true for a command that merely PARSED -
// and for one that did not, because Brigadier's failure is chat output, not an exception. So every
// assertion here reads the OUTPUT TEXT. A dispatcher that never heard of a root says "Unknown or
// incomplete command".
//
// AND THE FALSIFIER CASE 2 NEEDS CANNOT BE THAT MESSAGE. This file was written at 0.141.0 with a
// third case asserting that a REAL subtree missing its argument (`mmcp server register`) says
// something OTHER than "Unknown or incomplete command" - so that case 2 could not pass over a root
// that had been deleted outright. Its first live run (0.143.0, 2026-09-10) showed the premise is
// simply wrong: Brigadier says "Unknown or incomplete command" for BOTH, and the only difference is
// where the `<--[HERE]` pointer lands. So the falsifier is a ROUND TRIP instead - register a
// throwaway directory, see it named back, remove it again. That exercises the argument branch AND
// the inbound path itself, which since 0.143.0 is the only way an agent reaches a game at all.
//
// No site: every command below either reports or refuses. Nothing is staged, no block is touched,
// no session is stopped (`/mmcp session` LISTS; `stop` is not called). Needs the dev server; skips
// when the bridge is down. Battery chunk b.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { BASE } from "../bridge-base.mjs";
import { mkdir, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SESSION = "probe-mmcp-commands";

async function call(tool, args = {}) {
  const res = await fetch(`${BASE}/cmd`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-MCPTK-Session": SESSION },
    body: JSON.stringify({ tool, args }),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(j.error ?? "bridge call failed");
  return j.result;
}

/** Run a server command and return its captured output as one string. */
async function run(command) {
  const r = await call("run_command", { command });
  return (r.output ?? []).join("\n");
}

/** Brigadier's answer when the dispatcher has no such node at all. */
const UNKNOWN = /Unknown or incomplete command/i;

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok)
  .catch(() => false);
if (!bridgeUp) {
  console.log(`\n  [skip] no bridge at ${BASE} — start the dev server to run these probes\n`);
}

// Every subtree the collapse promises, with a form that REPORTS rather than acts, and a fragment of
// the answer only that subtree can produce. A subtree that answered with the wrong thing - the risk
// when six trees merge into one root - fails on the fragment, not on the absence.
const SUBTREES = [
  ["mmcp", /chat is (live|MUTED)/i],
  ["mmcp chat status", /chat is (live|MUTED)/i],
  ["mmcp session", /session|none/i],
  ["mmcp server", /bridge:/i],
  ["mmcp review status", /ask|queue|nothing|open/i],
  ["mmcp body", /body|no session bodies/i],
  ["mmcp canvas", /open|nothing/i],
];

describe("MMCP: one command root", { skip: !bridgeUp }, () => {
  test("every subtree answers, and answers as itself", async () => {
    for (const [command, shape] of SUBTREES) {
      const said = await run(command);
      assert.doesNotMatch(said, UNKNOWN, `/${command} is not registered`);
      assert.match(said, shape, `/${command} answered, but not like itself: ${said}`);
    }
  });

  test("the three roots it replaced are gone, not aliased", async () => {
    for (const command of ["claude status", "claude mute", "mcptk mcp", "mcptk body", "review status"]) {
      const said = await run(command);
      assert.match(said, UNKNOWN, `/${command} still answers - the rename is half done: ${said}`);
    }
  });

  test("the argument branch is real: a directory registers, is listed, and comes back out", async () => {
    // The falsifier case 2 rests on. A root that had been deleted outright cannot do this, and
    // neither can a `server` node that lost its `register` child - which is the half a rename breaks.
    const { gameDir } = await call("ping");
    const dir = join(gameDir, "mcptoolkit", "probe-register");
    await mkdir(dir, { recursive: true });
    try {
      const registered = await run(`mmcp server register ${dir}`);
      assert.doesNotMatch(registered, UNKNOWN, `server register read as unregistered: ${registered}`);
      assert.match(registered, /registered|already current/i,
        `register did not say what it did: ${registered}`);
      assert.ok(existsSync(join(dir, ".mcp.json")), "register wrote no .mcp.json into the directory");

      const listed = await run("mmcp server");
      assert.match(listed, /probe-register/i, `the registration is not in /mmcp server: ${listed}`);

      const removed = await run(`mmcp server remove ${dir}`);
      assert.match(removed, /removed|nothing to remove/i, `remove did not say what it did: ${removed}`);
      const entry = existsSync(join(dir, ".mcp.json"))
        ? JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"))
        : {};
      assert.deepEqual(Object.keys(entry.mcpServers ?? {}), [],
        "remove left our entry behind in the file it wrote");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the root is answerable, and the gate sits on the subtrees", async () => {
    // run_command runs at full server permissions, so this cannot show a plain player being refused.
    // What it does pin is that the root carries no `requires` of its own that a later registration
    // would have silently inherited or overridden (CommandRoot: Brigadier merges children, never
    // predicates, so the FIRST registration's requirement would have won).
    const said = await run("mmcp");
    assert.doesNotMatch(said, UNKNOWN, "the bare root does not execute");
    assert.ok(said.trim().length > 0, "the bare root answered with nothing");
  });
});
