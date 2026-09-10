// Live probes for bot_profile — reflex triggers reading the belief store (player-legal perception).
//
//   1. perceived mode: a hostile within the trigger radius but NOT perceived (behind, beyond hearing)
//      does NOT fire threats_nearby — the belief store shows zero hostiles.
//   2. perceived mode: once a hostile comes into view (seen), threats_nearby fires.
//   3. authoritative mode: the same unperceived-by-senses hostile DOES fire (ground truth).
//
// Staged at a probe-owned coordinate (3.75M). Own session. Run with `npm run test:live`.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const X = 3_750_000, Z = 3_750_000, Y = 200;
const SESSION = "probe-profile";
const ORIGIN = { x: X, y: Y + 2, z: Z };

async function call(tool, args = {}) {
  const res = await fetch(`${BASE}/cmd`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-MCPTK-Session": SESSION },
    body: JSON.stringify({ tool, args }),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(`${tool} failed: ${JSON.stringify(j.error)}`);
  return j.result;
}
const cmd = (c) => call("run_command", { command: c });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowCursor = async () => (await call("get_events", { limit: 1 })).cursor;
async function waitEvent(type, cursor, timeoutMs, pred = () => true) {
  const deadline = Date.now() + timeoutMs;
  let cur = cursor;
  while (Date.now() < deadline) {
    const r = await call("get_events", { cursor: cur, type, wait_ms: 1500 });
    for (const e of r.events || []) if (e.type === type && pred(e)) return e;
    cur = r.cursor ?? cur;
  }
  return null;
}
const killZombies = () => cmd(`kill @e[type=minecraft:zombie,x=${X - 40},y=${Y - 4},z=${Z - 40},dx=80,dy=40,dz=80]`).catch(() => {});
const WATCH = {
  id: "watch",
  trigger: { kind: "threats_nearby", within: 24, count: 1 },
  response: { op: "attack", nearest: true }, // inert when nothing is in melee reach; we assert the FIRE
  cooldown_ticks: 5,
};

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok).catch(() => false);
if (!bridgeUp) console.log(`\n  [skip] no bridge at ${BASE} — start the dev server\n`);

describe("bot_profile: reflex triggers read perceived threats, not ground truth", { skip: !bridgeUp }, () => {
  test("stage the site", async (t) => {
    if (!bridgeUp) return t.skip();
    await cmd(`forceload add ${X - 40} ${Z - 40} ${X + 40} ${Z + 40}`);
    await sleep(1500);
    await cmd(`fill ${X - 30} ${Y} ${Z - 30} ${X + 30} ${Y} ${Z + 30} minecraft:stone`);
    await cmd(`fill ${X - 30} ${Y + 1} ${Z - 30} ${X + 30} ${Y + 12} ${Z + 30} minecraft:air`);
    await sleep(400);
  });

  test("perceived mode: an unperceived hostile does NOT fire threats_nearby", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "spawn",  pos: ORIGIN });
    await killZombies();
    await call("bot_profile", { perception: "perceived" });
    await call("bot_look", { at: { x: X + 10, y: Y + 2, z: Z } }); // face +X
    // A zombie BEHIND and far (20 blocks: out of FOV, beyond hearing 16) — present but imperceptible.
    await cmd(`summon minecraft:zombie ${X - 20} ${Y + 2} ${Z} {NoAI:1b,NoGravity:1b,PersistenceRequired:1b}`);
    await sleep(1000);
    const seen = await call("sense_entities");
    assert.equal(seen.summary.hostiles, 0, `the far/behind zombie must be unperceived: ${JSON.stringify(seen.summary)}`);

    const c0 = await nowCursor();
    await call("bot_reactions", { action: "arm", reactions: [WATCH] });
    const fired = await waitEvent("reaction_fired", c0, 2500, (e) => e.data.id === "watch");
    assert.equal(fired, null, `threats_nearby must NOT fire on an unperceived threat: ${JSON.stringify(fired?.data)}`);
  });

  test("perceived mode: a hostile that comes into view DOES fire", async (t) => {
    if (!bridgeUp) return t.skip();
    const c0 = await nowCursor();
    await cmd(`summon minecraft:zombie ${X + 5} ${Y + 2} ${Z} {NoAI:1b,NoGravity:1b,PersistenceRequired:1b}`); // in front → seen
    const fired = await waitEvent("reaction_fired", c0, 6000, (e) => e.data.id === "watch");
    assert.ok(fired, "once a hostile is seen, threats_nearby should fire");
    await call("bot_reactions", { action: "clear" });
    await killZombies();
  });

  test("authoritative mode: the unperceived-by-senses hostile still fires (ground truth)", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "spawn",  pos: ORIGIN });
    await killZombies();
    await call("bot_profile", { perception: "authoritative" });
    await call("bot_look", { at: { x: X + 10, y: Y + 2, z: Z } });
    await cmd(`summon minecraft:zombie ${X - 20} ${Y + 2} ${Z} {NoAI:1b,NoGravity:1b,PersistenceRequired:1b}`); // behind, far
    await sleep(600);
    const c0 = await nowCursor();
    await call("bot_reactions", { action: "arm", reactions: [WATCH] });
    const fired = await waitEvent("reaction_fired", c0, 5000, (e) => e.data.id === "watch");
    assert.ok(fired, "in authoritative mode threats_nearby counts ground truth, so it fires");
    await call("bot_reactions", { action: "clear" });
    await killZombies();
  });

  test("cleanup", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_reactions", { action: "clear" }).catch(() => {});
    await call("bot_profile", { perception: "authoritative" }).catch(() => {});
    await call("bot_body", { action: "despawn" }).catch(() => {});
    await killZombies();
    await cmd(`forceload remove ${X - 40} ${Z - 40} ${X + 40} ${Z + 40}`).catch(() => {});
  });
});
