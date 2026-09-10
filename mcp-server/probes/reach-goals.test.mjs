// Live probes for reach goals (toolkit 0.5.0) — the first embodied probe file (spawns a drone).
//
//   1. check_path `reach`: true+stand on an open chest; `occluded` on an entombed one (no verdict
//      corruption from corner-graze rays or eye-inside-target phantoms); walker-vs-flyer mode
//      contrast on a pillar-top chest (walker no_path_to_reach_position, flyer reachable).
//   2. bot_goto `reach`: arrives with gates {range:true, los:true} AND the hands actually work at
//      the landing (the center-anchor contract: a stand the solver accepts is a stand the hands
//      accept); entombed target refused `occluded` at start; a satisfied goal completes as
//      already_there without moving the body.
//   3. bot_run: a {op:goto, reach} step feeding a mine step; out_of_reach hand refusals carry the
//      bot_goto-reach remedy note.
//
// Staged at a probe-owned coordinate (3.3M — chunks ARE generated here by this file; staging is
// idempotent, chests are re-placed each run). Forceloaded during the run: the drone unloads with
// its chunk on a playerless server otherwise.
//
// Live probe: needs the dev server up (`gradlew runServer`). Skips itself when the bridge is down.
// Run with `npm run test:live`.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const X = 3_300_000, Z = 3_300_000, Y = 200; // this probe file's own site
// Every embodied probe file carries its OWN session id. The drone slot and the body are per-session
// and `node --test` runs files concurrently, so a file that sends no id shares the anonymous slot
// with every other file that sends none — which is how another file's flight came to be flying THIS
// file's goal out from under it.
const SESSION = "probe-reach-goals";

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

const FROM = { x: X + 4, y: Y + 1, z: Z + 4 };
const CHEST_OPEN = { x: X, y: Y + 1, z: Z };
const CHEST_TOMB = { x: X + 12, y: Y + 2, z: Z };
const CHEST_PILLAR = { x: X - 12, y: Y + 9, z: Z };

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok)
  .catch(() => false);
if (!bridgeUp) {
  console.log(`\n  [skip] no bridge at ${BASE} — start the dev server to run these probes\n`);
}

describe("reach goals: touch-shell solving, gates, mode contrast, hands contract", { skip: !bridgeUp }, () => {
  test("stage the site", async (t) => {
    if (!bridgeUp) return t.skip();
    await cmd(`forceload add ${X - 32} ${Z - 32} ${X + 32} ${Z + 32}`);
    await sleep(1500); // forceload marks async
    await cmd(`fill ${X - 20} ${Y} ${Z - 20} ${X + 20} ${Y} ${Z + 20} minecraft:stone`);
    await cmd(`fill ${X - 20} ${Y + 1} ${Z - 20} ${X + 20} ${Y + 12} ${Z + 20} minecraft:air`);
    await cmd(`setblock ${X} ${Y + 1} ${Z} minecraft:chest`);
    // Entombed chest: hollow shell, solid interior, chest swapped into the middle.
    await cmd(`fill ${X + 10} ${Y + 1} ${Z - 2} ${X + 14} ${Y + 5} ${Z + 2} minecraft:stone hollow`);
    await cmd(`fill ${X + 11} ${Y + 1} ${Z - 1} ${X + 13} ${Y + 3} ${Z + 1} minecraft:stone`);
    await cmd(`setblock ${X + 12} ${Y + 2} ${Z} minecraft:chest`);
    // Pillar-top chest: LOS only from mid-air, so walkers can't reach any stand.
    await cmd(`fill ${X - 12} ${Y + 1} ${Z} ${X - 12} ${Y + 8} ${Z} minecraft:stone`);
    await cmd(`setblock ${X - 12} ${Y + 9} ${Z} minecraft:chest`);
    await sleep(500);
  });

  test("check_path reach: open chest → true with a stand", async (t) => {
    if (!bridgeUp) return t.skip();
    const r = await call("check_path", { from: FROM, reach: CHEST_OPEN, body: "walker" });
    assert.equal(r.reachable, true, JSON.stringify(r));
    assert.equal(typeof r.stand?.x, "number", JSON.stringify(r));
    assert.ok(r.reach.visible > 0, JSON.stringify(r.reach));
  });

  test("check_path reach: entombed chest → false, reason occluded", async (t) => {
    if (!bridgeUp) return t.skip();
    const r = await call("check_path", { from: FROM, reach: CHEST_TOMB, body: "walker" });
    assert.equal(r.reachable, false, JSON.stringify(r));
    assert.equal(r.reason, "occluded", JSON.stringify(r));
  });

  test("check_path reach: pillar top splits by mode — walker no_path, flyer true", async (t) => {
    if (!bridgeUp) return t.skip();
    const walk = await call("check_path", { from: FROM, reach: CHEST_PILLAR, body: "walker" });
    assert.equal(walk.reachable, false, JSON.stringify(walk));
    assert.equal(walk.reason, "no_path_to_reach_position", JSON.stringify(walk));
    const fly = await call("check_path", { from: FROM, reach: CHEST_PILLAR, body: "flyer" });
    assert.equal(fly.reachable, true, JSON.stringify(fly));
  });

  test("check_path: to+reach together is rejected", async (t) => {
    if (!bridgeUp) return t.skip();
    await assert.rejects(
      call("check_path", { from: FROM, to: CHEST_OPEN, reach: CHEST_OPEN }),
      /not both/);
  });

  test("bot_goto reach: arrives with green gates and WORKING hands", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "spawn",  pos: { x: X + 8, y: Y + 3, z: Z + 8 } });
    const flight = await call("bot_goto", { reach: CHEST_OPEN, wait: true });
    assert.equal(flight.outcome, "arrived", JSON.stringify(flight));
    assert.equal(flight.gates?.range, true, JSON.stringify(flight));
    assert.equal(flight.gates?.los, true, JSON.stringify(flight));
    // The whole contract: a reach arrival must be a position the hands accept.
    const mine = await call("bot_mine", { at: CHEST_OPEN, wait: true });
    assert.notEqual(mine.started, false, JSON.stringify(mine));
  });

  test("bot_goto reach: entombed target refused occluded at start", async (t) => {
    if (!bridgeUp) return t.skip();
    const r = await call("bot_goto", { reach: CHEST_TOMB });
    assert.equal(r.started, false, JSON.stringify(r));
    assert.equal(r.reason, "occluded", JSON.stringify(r));
  });

  // This test used to assume its own premise: that a goal satisfied by the first flight is STILL
  // satisfied when the second call lands. It is not free. A reach arrival on the pillar chest is a
  // hover, the body's eye drifts while it holds station, and a drift past the 4.5 touch radius makes
  // `stopped_short` the HONEST answer — so the probe failed on its premise rather than on its
  // subject, and only under the concurrent load that made the gap between the two calls longer.
  //
  // The premise is re-established rather than the assertion loosened: each attempt re-flies the goal
  // and asks again immediately, and `already_there` still has to turn up. A toolkit that never
  // answers it fails all four attempts; a body that merely drifted gets another go, and the answers
  // it gave instead are reported so a real regression cannot hide behind "it drifted".
  test("bot_goto reach: satisfied goal completes already_there without moving", async (t) => {
    if (!bridgeUp) return t.skip();
    const drifted = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      const first = await call("bot_goto", { reach: CHEST_PILLAR, wait: true });
      assert.ok(first.arrived === true || first.outcome === "already_there",
        JSON.stringify(first));
      const again = await call("bot_goto", { reach: CHEST_PILLAR, wait: true });
      if (again.outcome === "already_there") return;
      drifted.push(JSON.stringify(again.outcome ?? again.reason ?? again));
    }
    assert.fail(`already_there never returned for a goal just arrived at, in 4 attempts; `
      + `answers were: ${drifted.join(", ")}`);
  });

  test("bot_run: goto(reach) step feeds a mine step", async (t) => {
    if (!bridgeUp) return t.skip();
    const run = await call("bot_run", {
      steps: [
        { op: "goto", reach: CHEST_PILLAR },
        { op: "mine", at: CHEST_PILLAR },
      ],
      wait: true,
    });
    assert.ok(run.completed === true || run.steps_completed === 2, JSON.stringify(run));
  });

  test("hand out_of_reach refusal names the reach remedy", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_goto", { to: { x: X + 18, y: Y + 6, z: Z + 18 }, wait: true });
    await cmd(`setblock ${X} ${Y + 1} ${Z} minecraft:chest`); // re-place (mined earlier)
    const far = await call("bot_mine", { at: CHEST_OPEN });
    assert.equal(far.started, false, JSON.stringify(far));
    assert.equal(far.reason, "out_of_reach", JSON.stringify(far));
    assert.match(far.note ?? "", /bot_goto reach/, JSON.stringify(far));
  });

  test("cleanup", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "despawn" }).catch(() => {});
    await cmd(`forceload remove ${X - 32} ${Z - 32} ${X + 32} ${Z + 32}`).catch(() => {});
  });
});
