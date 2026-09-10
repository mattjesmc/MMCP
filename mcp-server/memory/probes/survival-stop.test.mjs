// The survival session's one legitimate exit (local/survival.mjs).
//
// What this defends: a session that correctly decides to stop must be ABLE to. The Stop hook blocks
// turn-endings and honours only a `.claude/STOP_OK` file; its block message used to tell the model
// to write that file with the Write tool, which the launcher hard-denies
// (`--disallowedTools …,Write,…`). Live, 2026-08-02: w1-75920's body died, the model decided to
// end, tried the sanctioned exit, was refused, and hung until a human interrupted it.
//
// So the two properties below are the whole point:
//   1. The verb exists ONLY under the survival profile — the tool bill taxes every other role for a
//      description it can never use.
//   2. It actually writes the file the hook watches, at the path the hook computes.

import { test } from "node:test";
import assert from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cwd0 = process.cwd();

/** The module reads MCPTK_PROFILE at load, so each profile needs its own module instance. */
async function loadWith(profile) {
  const prev = process.env.MCPTK_PROFILE;
  if (profile === undefined) delete process.env.MCPTK_PROFILE;
  else process.env.MCPTK_PROFILE = profile;
  // Cache-bust: ESM caches by specifier, and both profiles must be observable in one run.
  const mod = await import(`../../local/survival.mjs?p=${profile ?? "none"}`);
  if (prev === undefined) delete process.env.MCPTK_PROFILE;
  else process.env.MCPTK_PROFILE = prev;
  return mod;
}

test("session_stop exists only under the survival profile", async () => {
  for (const profile of [undefined, "standard", "full", "play", "survey"]) {
    const m = await loadWith(profile);
    assert.deepEqual(m.localTools(), [], `profile ${profile} must not be billed for it`);
    assert.equal(m.isLocalTool("session_stop"), false);
  }
  const s = await loadWith("survival");
  const tools = s.localTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "session_stop");
  assert.ok(s.isLocalTool("session_stop"));
  // The description has to steer away from the failure that motivated it: w1 declared "respawn
  // refused" having never called bot_body once.
  assert.match(tools[0].description, /do not assume/i);
  assert.match(tools[0].description, /bot_body/);
});

test("it writes the file the Stop hook watches, with the account in it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcsurv-"));
  process.chdir(dir);
  process.env.MCPTK_SESSION = "w9-00001";
  try {
    const s = await loadWith("survival");
    const r = await s.callLocalTool("session_stop", { reason: "body dead, respawn refused twice" });
    assert.equal(r.ok, true);
    assert.equal(r.result.stopped, true);
    // The hook computes join(<workspace>/.claude/hooks, "..", "STOP_OK").
    const body = await readFile(join(dir, ".claude", "STOP_OK"), "utf8");
    assert.match(body, /body dead, respawn refused twice/);
    assert.match(body, /w9-00001/, "the human reading a bad run needs to know which session ended");
    assert.match(r.result.note, /END YOUR TURN NOW/);
    // The relauncher's signal. STOP_OK is consumed by the hook one-shot, so it cannot also be what
    // tells run-loop.ps1 not to wake the player back up — that needs a file which SURVIVES.
    const last = JSON.parse(await readFile(join(dir, ".claude", "LAST_STOP.json"), "utf8"));
    assert.equal(last.session, "w9-00001");
    assert.match(last.reason, /body dead, respawn refused twice/);
    assert.ok(last.stopped_at, "a human reading the run afterwards needs the timestamp");
  } finally {
    process.chdir(cwd0);
    delete process.env.MCPTK_SESSION;
    await rm(dir, { recursive: true, force: true });
  }
});

test("a stop with no reason is refused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcsurv-"));
  process.chdir(dir);
  try {
    const s = await loadWith("survival");
    for (const args of [undefined, {}, { reason: "  " }]) {
      const r = await s.callLocalTool("session_stop", args);
      assert.equal(r.ok, false, `refused for ${JSON.stringify(args)}`);
      assert.match(r.error, /reason` is required/);
    }
    await assert.rejects(readFile(join(dir, ".claude", "STOP_OK"), "utf8"), /ENOENT/,
      "a refused stop must not leave the signal behind — the next turn would exit on it");
    await assert.rejects(readFile(join(dir, ".claude", "LAST_STOP.json"), "utf8"), /ENOENT/,
      "nor the relauncher's signal — the wrapper would refuse to wake the player ever again");
  } finally {
    process.chdir(cwd0);
    await rm(dir, { recursive: true, force: true });
  }
});
