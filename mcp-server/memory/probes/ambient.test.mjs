// Unit tests for the ambient retina's ACTIVITY WINDOW (SURVIVAL_MODE_PLAN.md §5) — offline, fake clock.
//
// These exist because the retina shipped with NO tests and a blinding bug: the window was refreshed
// only by `bot_*` calls, so a session that PERCEIVED rather than moved (raycast, locate, mem_*) had
// a retina that ran for 30s after its spawn and then went silent for the rest of the session. It
// was caught live on the second watched run — "the fan is not being done continuously and nothing is
// built up" — and the agent's fallback (hand-rolled single raycasts) did not refresh the window
// either, so the blindness reinforced itself. The window is the whole reason the store fills, so its
// arithmetic is asserted rather than assumed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ambientTick, ACTIVITY_WINDOW_MS, AMBIENT_FAN_ARGS } from "../ambient.mjs";

/** A bridge stub that records the calls it received and returns a plausible fan result. */
function stubBridge(ok = true) {
  const calls = [];
  return {
    calls,
    fn: async (tool, args) => {
      calls.push({ tool, args });
      return ok
        ? { ok: true, result: { game_tick: 100, dimension: "minecraft:overworld", rays: [] } }
        : { ok: false, error: "no body" };
    },
  };
}

const freshState = (lastActiveAt = 0) => ({ lastActiveAt, busy: false, loggedNoBody: false });
/** Epoch-scale, because the never-active case relies on `now` being far from lastActiveAt = 0.
 *  A toy clock (now = 10_000) makes epoch zero look one second ago and the test asserts nothing. */
const NOW = 1_700_000_000_000;

test("a never-active session does NOT poll the bridge", async () => {
  // lastActiveAt starts at 0, so a session that has made no call must not fire — the guardrail
  // against an abandoned session polling forever.
  const b = stubBridge();
  const r = await ambientTick(freshState(0), b.fn, NOW);
  assert.equal(r.fired, false);
  assert.equal(r.reason, "idle");
  assert.equal(b.calls.length, 0, "no bridge traffic from an inactive session");
});

test("inside the window the retina fires and casts the retina's own fan args", async () => {
  const b = stubBridge();
  const now = NOW;
  const r = await ambientTick(freshState(now - 1000), b.fn, now);
  assert.equal(r.fired, true, `should fire 1s after activity: ${JSON.stringify(r)}`);
  const fan = b.calls.find((c) => c.tool === "raycast_fan");
  assert.ok(fan, `the retina casts a fan: ${JSON.stringify(b.calls)}`);
  // load:false is load-bearing — a player's eyes do not generate terrain.
  assert.equal(fan.args.load, false, "the retina never loads chunks");
  assert.equal(fan.args.drone, true, "cast from the body's own eye");
  assert.equal(fan.args.h_fov, AMBIENT_FAN_ARGS.h_fov);
});

test("the window EXPIRES — an abandoned session stops looking", async () => {
  const b = stubBridge();
  const now = NOW;
  const r = await ambientTick(freshState(now - ACTIVITY_WINDOW_MS - 1), b.fn, now);
  assert.equal(r.fired, false);
  assert.equal(r.reason, "idle");
  assert.equal(b.calls.length, 0);
});

test("the boundary is inclusive: exactly at the window edge it still looks", async () => {
  const b = stubBridge();
  const now = NOW;
  const r = await ambientTick(freshState(now - ACTIVITY_WINDOW_MS), b.fn, now);
  assert.equal(r.fired, true, "at the edge the session is still active, not idle");
});

test("REGRESSION: a perceiving session keeps its retina — any call refreshes the window", async () => {
  // The exact shape of the live failure. A session spawns a body, then spends minutes on
  // perception and memory calls without moving. Under the old rule (only `bot_*` refreshes) the
  // retina died 30s after the spawn; under the current rule every call keeps it alive, so the
  // observation store keeps filling and `locate` has something to answer from.
  const b = stubBridge();
  const state = freshState(0);
  let clock = NOW;
  const noteActivity = () => { state.lastActiveAt = clock; };

  noteActivity();                       // bot_body spawn
  const perceiving = ["raycast", "locate", "mem_recall", "locate", "mem_note", "locate"];
  let fired = 0;
  for (const _tool of perceiving) {
    clock += 20_000;                    // 20s of thinking between calls — inside the window each time
    noteActivity();                     // ANY successful call refreshes
    const r = await ambientTick(state, b.fn, clock);
    if (r.fired) fired++;
  }
  assert.equal(fired, perceiving.length,
    `the retina must survive a perception-only session (fired ${fired}/${perceiving.length})`);

  // …and it still dies if the session genuinely stops calling anything.
  clock += ACTIVITY_WINDOW_MS + 1;
  const after = await ambientTick(state, b.fn, clock);
  assert.equal(after.fired, false, "an abandoned session still stops polling");
});

test("a bodiless session pauses honestly and logs once, never per tick", async () => {
  const b = stubBridge(false); // fan refuses: no body
  const state = freshState(NOW);
  const first = await ambientTick(state, b.fn, NOW);
  assert.equal(first.fired, false);
  assert.match(String(first.reason), /no body/i);
  assert.equal(state.loggedNoBody, true, "the outage is latched so it logs once, not every 2s");
  const second = await ambientTick(state, b.fn, NOW);
  assert.equal(second.fired, false, "still paused");
});

test("a tick in flight is never doubled up", async () => {
  const b = stubBridge();
  const state = freshState(NOW);
  state.busy = true;
  const r = await ambientTick(state, b.fn, NOW);
  assert.equal(r.fired, false);
  assert.equal(r.reason, "busy");
  assert.equal(b.calls.length, 0, "one fan in flight at a time");
});
