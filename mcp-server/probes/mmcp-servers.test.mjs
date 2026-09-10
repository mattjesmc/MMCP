// Probe for THE MMCP REGISTRATION SURFACE (RELEASE_1.md §B1): `/mmcp server list|register|remove`,
// and underneath it the merge that stopped `registerServer` from deleting other people's MCP servers.
//
// THE DEFECT THIS PINS. Both bundled adapters built a fresh root object holding one entry and wrote
// it over whatever was in the workspace's .mcp.json. In this workspace rocketeer/.mcp.json and
// nijntje/.mcp.json each hold the toolkit's entry AND a `blockbench` one, and `companion.workspace`
// is a documented, principal-supplied directory — so a launch pointed at such a repo silently
// deleted a server the human depends on. Case 1 is the falsifier: revert McpServersFile to a
// whole-file write and it, case 4 and case 7 all go red. Everything else here would stay green,
// which is exactly why it is written first.
//
// WHY THIS DRIVES A COMMAND. The menu is a client screen no headless probe can open. `/mmcp server`
// is the same code path behind it (Registrations + McpServersFile) and reaches a probe through
// `run_command` at zero manifest cost — the rule FakePlayerCommand wrote down. The human pass on the
// screen itself is queued through the review layer, where an owed human test belongs.
//
// THE ASSERTION IS THE FILE, not the command's reply. A command that says "registered" and wrote
// nothing, or wrote the wrong thing, is precisely the failure being closed; every case here reads
// the JSON back off disk and one (case 3) compares bytes.
//
// No site: nothing is staged, no block is touched, nothing global is reloaded — it writes only in
// its own temp directory. Needs the dev server; skips when the bridge is down. Battery chunk b.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE } from "../bridge-base.mjs";

const SESSION = "probe-mmcp-servers";

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

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok)
  .catch(() => false);
if (!bridgeUp) {
  console.log(`\n  [skip] no bridge at ${BASE} — start the dev server to run these probes\n`);
}

const scratch = bridgeUp ? mkdtempSync(join(tmpdir(), "mcptk-mmcp-")) : null;
after(() => { try { rmSync(scratch, { recursive: true, force: true }); } catch { /* windows lock */ } });

/** The game's own facts: where it is, what it bound, and the server every registration must name. */
let gameDir;
let port;
let serverIndex;

/** A workspace directory holding `servers` under mcpServers, plus a top-level key we do not own. */
function makeWorkspace(name, servers) {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".mcp.json"), JSON.stringify({
    $comment: "a top-level field the toolkit knows nothing about",
    mcpServers: servers,
  }, null, 2));
  return dir;
}

const BLOCKBENCH = { command: "node", args: ["C:/tools/blockbench-mcp/index.mjs"], env: { PORT: "8080" } };

function read(dir) {
  return JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
}

describe("MMCP: a registration is one key in someone else's file", { skip: !bridgeUp }, () => {
  before(async () => {
    const ping = await call("ping");
    gameDir = ping.gameDir;
    port = ping.port;
    serverIndex = `${gameDir.replace(/\\/g, "/")}/mcptoolkit/mcp-server/index.mjs`;
    assert.ok(port > 0, "this game bound no port — no registration it writes could be correct");
  });

  // ---- 1. THE FALSIFIER -------------------------------------------------------------------------
  test("register KEEPS every other server in the file", async () => {
    const dir = makeWorkspace("keeps-others", { blockbench: BLOCKBENCH });
    const out = await run(`mmcp server register ${dir}`);
    assert.match(out, /registered in/, `unexpected reply: ${out}`);

    const after = read(dir);
    assert.deepEqual(after.mcpServers.blockbench, BLOCKBENCH,
      "the blockbench registration was changed or deleted — this is the whole defect");
    assert.equal(after.$comment, "a top-level field the toolkit knows nothing about",
      "an unknown top-level field was dropped");
    assert.ok(after.mcpServers.mcptoolkit, "our own entry was not written");
  });

  // ---- 2. and what it wrote is usable ------------------------------------------------------------
  test("the entry names THIS game: its port, its extracted server", async () => {
    const dir = makeWorkspace("names-this-game", {});
    await run(`mmcp server register ${dir}`);
    const entry = read(dir).mcpServers.mcptoolkit;
    assert.equal(entry.command, "node");
    assert.equal(entry.args.at(-1), serverIndex,
      "the registration points at another game's extract");
    assert.equal(entry.env.MCPTK_URL, `http://127.0.0.1:${port}`,
      "the registration dials a port this game is not serving — the wrong-game class §B0 closed");
    assert.ok(entry.env.MCPTK_MEMORY_DIR, "no memory dir in the registration");
  });

  // ---- 3. idempotence is decided by the RESULT ---------------------------------------------------
  test("registering twice changes nothing and says so", async () => {
    const dir = makeWorkspace("idempotent", { blockbench: BLOCKBENCH });
    await run(`mmcp server register ${dir}`);
    const first = readFileSync(join(dir, ".mcp.json"), "utf8");
    const out = await run(`mmcp server register ${dir}`);
    const second = readFileSync(join(dir, ".mcp.json"), "utf8");
    assert.equal(second, first, "the second registration rewrote a file that was already current");
    assert.match(out, /already current/, `unexpected reply: ${out}`);
  });

  // ---- 4. our own old key is normalized; a human's key is not renamed ----------------------------
  test("an entry we wrote under the old name becomes ONE entry, not two", async () => {
    const dir = makeWorkspace("old-name", {
      "mcp-toolkit": { command: "node", args: [serverIndex], env: { MCPTK_URL: "http://127.0.0.1:1" } },
      blockbench: BLOCKBENCH,
    });
    await run(`mmcp server register ${dir}`);
    const servers = read(dir).mcpServers;
    assert.ok(servers.mcptoolkit, "not written under the canonical name");
    assert.equal(servers["mcp-toolkit"], undefined,
      "the old key survived beside the new one — a session would load the toolkit twice");
    assert.deepEqual(servers.blockbench, BLOCKBENCH, "the other server was disturbed");
  });

  test("a key the HUMAN chose is kept, because the key is the tool prefix", async () => {
    const dir = makeWorkspace("human-key", {
      game: { command: "node", args: [serverIndex], env: { MCPTK_URL: "http://127.0.0.1:1" } },
    });
    await run(`mmcp server register ${dir}`);
    const servers = read(dir).mcpServers;
    assert.ok(servers.game, "the human's key was renamed — every mcp__game__* tool call would break");
    assert.equal(servers.mcptoolkit, undefined, "a second entry was added beside the human's");
    assert.equal(servers.game.env.MCPTK_URL, `http://127.0.0.1:${port}`,
      "the human's entry was left stale instead of repointed");
  });

  // ---- 5. the list is the state, not a guess ----------------------------------------------------
  test("list reports the registered directory as current, with the others counted", async () => {
    const dir = makeWorkspace("listed", { blockbench: BLOCKBENCH });
    await run(`mmcp server register ${dir}`);
    const out = await run("mmcp server");
    const line = out.split("\n").find((l) => l.includes(dir));
    assert.ok(line, `the registered directory is not in the list:\n${out}`);
    assert.match(line, /^current/, `expected it to read as current: ${line}`);
    assert.match(line, /\+1 other server/, `the other server was not counted: ${line}`);
    assert.match(out, new RegExp(`bridge: http://127\\.0\\.0\\.1:${port}`),
      "the list does not say which bridge these registrations are measured against");
  });

  // ---- 6. remove takes ours and only ours -------------------------------------------------------
  test("remove drops our key and leaves the file and its other servers", async () => {
    const dir = makeWorkspace("removable", { blockbench: BLOCKBENCH });
    await run(`mmcp server register ${dir}`);
    const out = await run(`mmcp server remove ${dir}`);
    assert.match(out, /removed this game/, `unexpected reply: ${out}`);
    assert.ok(existsSync(join(dir, ".mcp.json")), "the file itself was deleted");
    const after = read(dir);
    assert.equal(after.mcpServers.mcptoolkit, undefined, "our entry is still there");
    assert.deepEqual(after.mcpServers.blockbench, BLOCKBENCH, "the other server went with it");
    assert.equal(after.$comment, "a top-level field the toolkit knows nothing about");
  });

  // ---- 7. refusals ------------------------------------------------------------------------------
  test("a relative path is refused, not resolved against the game's working directory", async () => {
    const out = await run("mmcp server register some/relative/dir");
    assert.match(out, /refused/, `expected a refusal: ${out}`);
    assert.match(out, /absolute/, "the refusal does not say what to do instead");
  });

  test("a directory that does not exist is refused", async () => {
    const dir = join(scratch, "not-there");
    const out = await run(`mmcp server register ${dir}`);
    assert.match(out, /refused/, `expected a refusal: ${out}`);
    assert.ok(!existsSync(dir), "the refusal created the directory anyway");
  });

  // ---- 8. a file we cannot parse is never thrown away -------------------------------------------
  test("invalid JSON is refused rather than replaced", async () => {
    const dir = join(scratch, "broken");
    mkdirSync(dir, { recursive: true });
    const before = '{ "mcpServers": { "blockbench": }  <- a human mid-edit\n';
    writeFileSync(join(dir, ".mcp.json"), before);
    const out = await run(`mmcp server register ${dir}`);
    assert.match(out, /failed/, `expected a refusal: ${out}`);
    assert.equal(readFileSync(join(dir, ".mcp.json"), "utf8"), before,
      "a file that could not be parsed was overwritten — the one thing this class must never do");
  });
});
