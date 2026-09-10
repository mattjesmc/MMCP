// Live probe for WHICH GAME A SESSION IS ATTACHED TO (RELEASE_1.md §B0 step 2).
//
// The failure being closed: every project's dev game took BridgeConfig's dev default (25599)
// because nothing declared a port, so the second game to boot lost the bind, retried silently for
// 90 seconds, gave up with one WARN — and its session, dialing the same 25599, drove the FIRST
// game and reported success on every call. `ping.gameDir` had the answer all along and nobody was
// asking. So the shim asks, once, at the handshake, and says what it found on stderr.
//
// This spawns the REAL shim over stdio rather than re-implementing its handshake: the thing under
// test is a side effect on a stream a re-implementation would not have. Case 2 is the load-bearing
// one — without a run where the warning actually FIRES, cases 1 and 3 are equally green against a
// check that can never fire at all.
//
// No site, no world write, no reload: it calls `ping` and reads stderr. Needs any dev game on
// MCPTK_URL/BASE; skips when the bridge is down. Battery chunk b.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE } from "../bridge-base.mjs";

const SHIM = join(dirname(fileURLToPath(import.meta.url)), "..", "index.mjs");
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

let bridgeUp = false;
let gameDir = null;

before(async () => {
  try {
    const res = await fetch(`${BASE}/cmd`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "ping", args: {} }),
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json();
    bridgeUp = data?.ok === true;
    gameDir = data?.result?.gameDir ?? null;
  } catch {
    bridgeUp = false;
  }
});

/**
 * Drive the shim through one tool call and return everything it wrote to stderr. The handshake is
 * LAZY — it fires on the first /cmd, not at startup — so a probe that only initializes sees nothing.
 */
function runShim(env, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SHIM], {
      cwd,
      env: { ...process.env, MCPTK_URL: BASE, MCPTK_SESSION: "", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (b) => { err += b.toString(); });
    child.stdout.on("data", () => {});
    child.on("error", reject);

    const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "probe", version: "0" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ping", arguments: {} } });

    // The banner is written after the call's own reply, so give it a beat before reading stderr.
    setTimeout(() => {
      child.kill();
      resolve(err);
    }, 6000);
  });
}

describe("attachment identity", { concurrency: 1 }, () => {
  test("the shim names the game it reached", async (t) => {
    if (!bridgeUp) return t.skip("bridge down");
    const err = await runShim({}, REPO_ROOT);
    assert.match(err, /\[mcp-toolkit\] attached to /, `no banner in stderr:\n${err}`);
    assert.ok(err.includes(BASE), `banner does not name the bridge:\n${err}`);
    if (gameDir) {
      assert.ok(err.includes(gameDir), `banner does not name the game dir ${gameDir}:\n${err}`);
    }
  });

  test("a game outside the session's tree is CALLED OUT — the falsifier", async (t) => {
    if (!bridgeUp) return t.skip("bridge down");
    // An expectation the live game cannot satisfy, so the warning must fire. Without this case the
    // other two pass against a check wired to nothing.
    const err = await runShim({ MCPTK_EXPECT_GAMEDIR: join(REPO_ROOT, "no-such-project") }, REPO_ROOT);
    assert.match(err, /WARNING: that game is OUTSIDE/, `warning never fired:\n${err}`);
    assert.match(err, /mcmod\.port/, "the warning must name the fix, not just the fault");
  });

  test('MCPTK_EXPECT_GAMEDIR="any" turns the check off and keeps the banner', async (t) => {
    if (!bridgeUp) return t.skip("bridge down");
    const err = await runShim({ MCPTK_EXPECT_GAMEDIR: "any" }, REPO_ROOT);
    assert.match(err, /\[mcp-toolkit\] attached to /, `banner lost:\n${err}`);
    assert.doesNotMatch(err, /WARNING: that game is OUTSIDE/, `warning fired under "any":\n${err}`);
  });

  test("a session standing in its own tree gets no warning", async (t) => {
    if (!bridgeUp) return t.skip("bridge down");
    if (!gameDir) return t.skip("game did not report a gameDir");
    const err = await runShim({}, REPO_ROOT);
    assert.doesNotMatch(err, /WARNING: that game is OUTSIDE/,
      `the live game at ${gameDir} is under ${REPO_ROOT}, so nothing should warn:\n${err}`);
  });
});
