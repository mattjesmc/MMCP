// Live probes for the reflex↔base-intent interrupt (PLAYER_CONTROL_DESIGN.md §2.3–2.4, slice 2).
//
//   1. renav resume: a reaction repeatedly preempts a bot_run goto step, and the flight still
//      completes — proving the paused queue-goto is re-driven, not abandoned (without renav the
//      first mid-flight suspend would strand it forever).
//   2. Truth-determined cancel — no_target: a reaction kills the mob a queued attack step targets;
//      the step fails no_target, stamped after_reaction (the reaction is why the target is gone,
//      not that it was never there).
//   3. Truth-determined cancel — out_of_reach: a backstep reaction moves the body off a queued
//      mine target; the step fails out_of_reach, stamped after_reaction.
//
// Staged at a probe-owned coordinate (3.56M). Forceloaded during the run; own session.
// Moved off 3.45M, which walker.test.mjs already owned: the battery runs probe files
// CONCURRENTLY, so a shared site means two files stage on top of each other's world.
// Live probe: needs the dev server up (`gradlew runServer`). Skips itself when the bridge is down.
// Run with `npm run test:live`.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const X = 3_560_000, Z = 3_560_000, Y = 200;
const SESSION = "probe-reflexes-2";
const ORIGIN = { x: X, y: Y + 2, z: Z };

async function callRaw(tool, args = {}) {
  const res = await fetch(`${BASE}/cmd`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-MCPTK-Session": SESSION },
    body: JSON.stringify({ tool, args }),
  });
  return res.json();
}
async function call(tool, args = {}) {
  const j = await callRaw(tool, args);
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
    for (const e of r.events || []) {
      if (e.type === type && pred(e)) return e;
    }
    cur = r.cursor ?? cur;
  }
  return null;
}

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok)
  .catch(() => false);
if (!bridgeUp) {
  console.log(`\n  [skip] no bridge at ${BASE} — start the dev server to run these probes\n`);
}

describe("reflex interrupt: renav resume + truth-determined cancel with after_reaction", { skip: !bridgeUp }, () => {
  test("stage the site", async (t) => {
    if (!bridgeUp) return t.skip();
    await cmd(`forceload add ${X - 32} ${Z - 32} ${X + 32} ${Z + 32}`);
    await sleep(1500);
    await cmd(`fill ${X - 20} ${Y} ${Z - 20} ${X + 20} ${Y} ${Z + 20} minecraft:stone`);
    await cmd(`fill ${X - 20} ${Y + 1} ${Z - 20} ${X + 20} ${Y + 12} ${Z + 20} minecraft:air`);
    await sleep(400);
    await call("bot_reactions", { action: "clear" });
  });

  test("renav: a reaction preempts a bot_run goto step, which still completes", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "spawn",  pos: ORIGIN });
    // A gentle strafe that fires periodically — perpendicular drift the goto's renav keeps correcting.
    await call("bot_reactions", {
      action: "arm",
      reactions: [{
        id: "jitter",
        trigger: { kind: "health_below", hearts: 1000 },
        response: { op: "strafe", ticks: 3, speed: 0.3 },
        cooldown_ticks: 15,
      }],
    });
    const c0 = await nowCursor();
    // wait:true parks until the whole queue completes/fails; a bare goto step across the platform.
    const r = await call("bot_run", { steps: [{ op: "goto", to: { x: X + 8, y: Y + 2, z: Z } }], wait: true });
    assert.equal(r.action, "bot_run", JSON.stringify(r));
    assert.equal(r.completed, true, `goto step should resume and complete despite interrupts: ${JSON.stringify(r)}`);
    // And it really was interrupted while the queue (RUN) was the base intent.
    const anyRun = await call("get_events", { cursor: c0, type: "reaction_fired" });
    assert.ok((anyRun.events || []).some((e) => e.data.preempted === "run"),
      `expected a reaction_fired{preempted:run} during the queue: ${JSON.stringify(anyRun.events?.map((e) => e.data))}`);
    await call("bot_reactions", { action: "clear" });
  });

  // after_reaction stamps only when the reaction fires WHILE the queue is running (RUN) — the honest
  // meaning of "the queue died because of what a reaction did". So these tests hold the queue in RUN
  // with a leading `wait` step, then arm the reaction, so its fire lands during the queue, not before.
  test("no_target: a reaction kills the queued attack's target → after_reaction", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "spawn",  pos: ORIGIN });
    await cmd(`summon minecraft:sheep ${X + 1} ${Y + 2} ${Z} {Health:1f,NoAI:1b,NoGravity:1b}`);
    await sleep(500);

    const c0 = await nowCursor();
    // Queue runs (RUN) but sits on a wait; arm the killer so it fires DURING the queue and kills the sheep.
    const q = await call("bot_run", { steps: [{ op: "wait", ticks: 30 }, { op: "attack", nearest: true }] });
    await call("bot_reactions", {
      action: "arm",
      reactions: [{
        id: "killer",
        trigger: { kind: "health_below", hearts: 1000 },
        response: { op: "attack", nearest: true },
        cooldown_ticks: 40,
      }],
    });
    const fail = await waitEvent("action_failed", c0, 10000,
      (e) => e.data.action_id === q.action_id && e.data.op === "attack");
    assert.ok(fail, "expected the queued attack step to fail");
    assert.equal(fail.data.reason, "no_target", JSON.stringify(fail.data));
    assert.equal(fail.data.after_reaction, "killer",
      `failure should name the reaction that consumed the target: ${JSON.stringify(fail.data)}`);
    await call("bot_reactions", { action: "clear" });
  });

  test("out_of_reach: a backstep reaction moves off the queued mine target → after_reaction", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "spawn",  pos: ORIGIN });
    const B = { x: X + 1, y: Y + 1, z: Z };
    await cmd(`setblock ${B.x} ${B.y} ${B.z} minecraft:stone`);
    await call("bot_look", { at: { x: B.x + 0.5, y: B.y + 0.5, z: B.z + 0.5 } }); // face B so backstep departs it
    await sleep(200);

    const c0 = await nowCursor();
    const q = await call("bot_run", { steps: [{ op: "wait", ticks: 30 }, { op: "mine", at: B }] });
    await call("bot_reactions", {
      action: "arm",
      reactions: [{
        id: "flee",
        trigger: { kind: "health_below", hearts: 1000 },
        response: { op: "backstep", ticks: 20, speed: 0.5 },
        cooldown_ticks: 9999,
      }],
    });
    const fail = await waitEvent("action_failed", c0, 12000,
      (e) => e.data.action_id === q.action_id && e.data.op === "mine");
    assert.ok(fail, "expected the queued mine step to fail");
    assert.equal(fail.data.reason, "out_of_reach", JSON.stringify(fail.data));
    assert.equal(fail.data.after_reaction, "flee",
      `failure should name the reaction that moved the body: ${JSON.stringify(fail.data)}`);
    await call("bot_reactions", { action: "clear" });
  });

  test("cleanup", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_reactions", { action: "clear" }).catch(() => {});
    await call("bot_body", { action: "despawn" }).catch(() => {});
    await cmd(`kill @e[type=minecraft:sheep,x=${X - 4},y=${Y},z=${Z - 4},dx=8,dy=6,dz=8]`).catch(() => {});
    await cmd(`forceload remove ${X - 32} ${Z - 32} ${X + 32} ${Z + 32}`).catch(() => {});
  });
});
