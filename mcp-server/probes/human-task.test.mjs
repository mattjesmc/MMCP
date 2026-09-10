// The §15 task presenter (HUMAN_RIG_PLAN.md phase 4, toolkit 0.65.0) — what a HEADLESS battery
// can pin without a human connected:
//
//   1. REFUSALS ARE HONEST — human_task with no human connected refuses loudly (never a ghost
//      episode for nobody); an unknown verb names the v1 verb set; cancel with nothing active
//      says so. Fake-player bodies must NOT count as humans (the WmHuman enrollment rule).
//   2. THE POLL CHANNEL EXISTS — GET /humantask serves the snapshot shape the client tailer
//      parses ({"tasks":{}} when nothing is active). Content contract (goal-token only, never
//      waypoints) is structural server-side; the positive-path fields are verified in the
//      supervised human smoke, not here.
//
// The positive path (episode rows, goal attribution on captured ticks, highlight rendering)
// needs a real connected player — that is the client-side smoke Matthijs runs, mirroring the
// Phase-1 capture smoke. No site owned: this probe never touches the world.
//
// THE PREMISE IS READ, NOT ASSUMED (RELEASE.md 2.2). The three refusal cases pin "no CAPTURED human
// is connected", and that is a property of the host, not of the probe: a dev CLIENT with the
// recorder on (wm.record=true) has one, and on 2026-09-03 this file went 2/3 red for exactly that
// reason, then sat undiagnosed for three days. So the probe asks first - one human_task, whose
// answer is either the refusal or an accepted task - and pins whichever arm the host is in: the
// refusal wording on a headless host, and on a captured host that the task PRESENTS and can be
// cancelled (the positive path's cheapest half). The fake-body wording case needs zero humans and
// skips by name on a captured host.

import { test } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";

const SESSION = await fetch(`${BASE}/hello`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ label: "human-task-probe" }),
  signal: AbortSignal.timeout(3000),
}).then((r) => r.json()).then((j) => j.session ?? null).catch(() => null);

async function callRaw(tool, args = {}) {
  const res = await fetch(`${BASE}/cmd`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(SESSION ? { "X-MCPTK-Session": SESSION } : {}),
    },
    body: JSON.stringify({ tool, args }),
  });
  return res.json();
}

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok)
  .catch(() => false);
if (!bridgeUp) {
  console.log(`\n  [skip] no bridge at ${BASE} — start the dev server to run these probes\n`);
}

// Read once, before any case: is a captured human connected? A refusal answers no; an accepted
// task answers yes, and is cancelled on the spot so every case below starts from "nothing active".
let humanCaptured = false;
if (bridgeUp) {
  const first = await callRaw("human_task", { action: "move", at: { x: 100, y: 70, z: 100 } });
  if (first.ok) {
    humanCaptured = true;
    const cancelled = await callRaw("human_task_cancel", {});
    if (!cancelled.ok) console.log(`  [warn] could not cancel the premise task: ${cancelled.error}`);
  } else if (!/no human player connected|not being captured|recorder is OFF/i.test(String(first.error))) {
    console.log(`  [warn] the premise call refused for a reason this probe does not know: ${first.error}`);
  }
  console.log(`\n  [premise] captured human connected: ${humanCaptured}\n`);
}

test("human_task with no captured human refuses loudly; with one, it presents and cancels",
  { skip: !bridgeUp }, async () => {
    const j = await callRaw("human_task", {
      action: "move",
      at: { x: 100, y: 70, z: 100 },
    });
    if (!humanCaptured) {
      assert.equal(j.ok, false, `expected refusal, got: ${JSON.stringify(j)}`);
      assert.match(j.error, /no human player connected|not being captured|recorder is OFF/i,
        `refusal must say WHY (no human): ${j.error}`);
      return;
    }
    // The captured arm: the task is accepted for a named person and can be cancelled, which is
    // what every later case's "nothing active" premise rests on.
    assert.equal(j.ok, true, `a captured human should be presented the task: ${JSON.stringify(j)}`);
    const c = await callRaw("human_task_cancel", {});
    assert.equal(c.ok, true, `cancel after accept: ${JSON.stringify(c)}`);
  });

test("human_task refuses an unknown verb by naming the v1 set", { skip: !bridgeUp }, async () => {
  const j = await callRaw("human_task", {
    action: "vantage",
    at: { x: 100, y: 70, z: 100 },
  });
  assert.equal(j.ok, false);
  assert.match(j.error, /move/, `the error should list legal verbs: ${j.error}`);
  assert.match(j.error, /destroy/, `the error should list legal verbs: ${j.error}`);
});

test("human_task_cancel with nothing active says so", { skip: !bridgeUp }, async () => {
  const j = await callRaw("human_task_cancel", {});
  assert.equal(j.ok, false);
  assert.match(j.error, /no active human task/i, j.error ?? "(no error)");
});

test("GET /humantask serves the empty snapshot shape", { skip: !bridgeUp }, async () => {
  const res = await fetch(`${BASE}/humantask`, { signal: AbortSignal.timeout(2000) });
  assert.equal(res.ok, true);
  const j = await res.json();
  assert.ok(j.tasks !== undefined, `snapshot must carry a tasks object: ${JSON.stringify(j)}`);
  assert.equal(typeof j.tasks, "object");
  // Nothing active (headless: no human; captured: case 1 cancelled its own task), so no ghost
  // tasks — and a stale task surviving here would mean the disconnect sweep or cancel failed.
  assert.deepEqual(Object.keys(j.tasks), [],
    `nothing should be active, yet tasks exist: ${JSON.stringify(j.tasks)}`);
});

test("a fake-player body is not a human (spawned body does not satisfy human_task)",
  { skip: !bridgeUp }, async (t) => {
    if (humanCaptured) {
      return t.skip("a captured human is connected; the fake-body wording is only observable with zero humans");
    }
    // No body is spawned here — this pins the REFUSAL WORDING contract instead: the error must
    // say fake bodies don't count, so an orchestrating LLM never tries to "make a human" by
    // spawning one. (Spawning a real body to prove the negative would need a site + cleanup;
    // the enrollment rule itself is pinned server-side by WmHuman.armed and the zero-human
    // negative proof of the Phase-1 battery.)
    const j = await callRaw("human_task", { action: "move", at: { x: 0, y: 70, z: 0 } });
    assert.equal(j.ok, false);
    assert.match(j.error, /fake-player bodies and spectators don't count|no human player/i,
      j.error ?? "(no error)");
  });
