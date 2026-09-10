// Live probes for the PIT ESCAPE (W1_42257_FIXES.md F5, findings R5) — the hole episode: the body
// dug itself 6 blocks down, and every verb that should have brought it back up either mined stairs
// it could not walk (g-13), silently stripped its build rights (bot_goto may_modify, R2/F3), or
// blamed a cell the goal had every right to mine. ~4 minutes and ~50 calls to escape a hole.
//
// The fixture is the postmortem's ask verbatim: a 1×1 pit, depth 5, a body holding dirt and a
// pickaxe. Escape must be ONE call. Also asserts the F3 instrument agreement (check_path predicts
// what bot_goto may_modify attempts) and F2's generalized stream bound (no did_not_start floods).
//
// Staged at a probe-owned coordinate (4.10M). Own session. Run with `npm run test:live`.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const X = 4_100_000, Z = 4_100_000, Y = 80;
const SESSION = "probe-pit-escape";
const HALF = 8; // wide enough that no sideways mine-out is cheaper than the 5-block ascent
const SURFACE = { x: X + 3, y: Y + 1, z: Z };

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
// A TRUE now-cursor: drain the unread backlog first — `get_events {limit:1}`'s cursor sits after
// the OLDEST unread event, so a window opened on it would include stale events from earlier tests.
async function nowCursor() {
  let cursor;
  for (;;) {
    const r = await call("get_events", cursor ? { cursor, limit: 200 } : { limit: 200 });
    cursor = r.cursor;
    if (!r.more && (r.events || []).length < 200) return cursor;
  }
}

async function didNotStarts(cursor) {
  const r = await call("get_events", { cursor, type: "action_completed", limit: 200 });
  return (r.events || []).filter((e) => e.data?.outcome === "did_not_start").length;
}

/** The pit: solid stone slab, one 1×1 shaft 5 deep, the body at its floor with tools. */
async function stagePit() {
  await cmd(`fill ${X - HALF} ${Y - 8} ${Z - HALF} ${X + HALF} ${Y} ${Z + HALF} minecraft:stone`);
  await cmd(`fill ${X - HALF} ${Y + 1} ${Z - HALF} ${X + HALF} ${Y + 8} ${Z + HALF} minecraft:air`);
  await cmd(`fill ${X} ${Y - 4} ${Z} ${X} ${Y} ${Z} minecraft:air`);
  await sleep(400);
  await call("bot_body", { action: "spawn", type: "player", pos: { x: X, y: Y - 4, z: Z } });
  await call("bot_reactions", { action: "clear" });
  await call("bot_give", { item: "minecraft:stone_pickaxe", count: 1 });
  await call("bot_give", { item: "minecraft:dirt", count: 8 });
  await call("bot_select", { item: "stone_pickaxe" });
}

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok).catch(() => false);
if (!bridgeUp) console.log(`\n  [skip] no bridge at ${BASE} — start the dev server\n`);

describe("pit escape: one call out of a hole, instruments agreeing", { skip: !bridgeUp }, () => {
  test("stage the site", async (t) => {
    if (!bridgeUp) return t.skip();
    await cmd(`forceload add ${X - 32} ${Z - 32} ${X + 32} ${Z + 32}`);
    await sleep(1500);
  });

  test("may_modify:both — the body pillars/mines OUT in one goal", async (t) => {
    if (!bridgeUp) return t.skip();
    await stagePit();
    const cursor = await nowCursor();
    const r = await call("bot_target", {
      action: "move", target: { at: SURFACE },
      may_modify: "both", budget: { break: 32, place: 32 }, wait: true,
    });
    assert.ok(["achieved", "already_there"].includes(r.outcome),
      `escape is ONE call, not four minutes: ${JSON.stringify(r)}`);
    const s = await call("bot_status", {});
    assert.ok(s.pos.y >= Y + 1, `the body actually surfaced (y=${s.pos.y}, pit floor ${Y - 4})`);
    assert.ok((await didNotStarts(cursor)) <= 3,
      "no did_not_start flood while escaping (F2's bound, generalized)");
  });

  test("may_modify:break only — the stair-mine the body can FOLLOW (the g-13 shape)", async (t) => {
    if (!bridgeUp) return t.skip();
    await stagePit();
    const cursor = await nowCursor();
    const r = await call("bot_target", {
      action: "move", target: { at: SURFACE },
      may_modify: "break", budget: { break: 32 }, wait: true,
    });
    assert.ok(["achieved", "already_there"].includes(r.outcome),
      `g-13 mined 5 stair cells the body never followed; now it must arrive: ${JSON.stringify(r)}`);
    const s = await call("bot_status", {});
    assert.ok(s.pos.y >= Y + 1, `surfaced by mining alone (y=${s.pos.y})`);
    assert.ok((r.ledger?.mined ?? []).length > 0, "and the ascent is disclosed in the ledger");
    assert.ok((await didNotStarts(cursor)) <= 3, "no did_not_start flood");
  });

  test("bot_goto may_modify:break AGREES with check_path — and arrives (F3)", async (t) => {
    if (!bridgeUp) return t.skip();
    await stagePit();
    // The three-instrument contradiction from the hole episode: check_path said reachable:true,
    // bot_goto echoed break_budget:16 and moved nothing, the advisory said "allow may_modify"
    // on a call that had it. Now bot_goto with rights RUNS AS a move goal, so check_path's
    // break-route prediction is exactly what the call attempts.
    const cp = await call("check_path", { to: SURFACE, may_modify: "break" });
    assert.equal(cp.reachable, true,
      `the break-route exists from the pit floor: ${JSON.stringify(cp)}`);
    const cursor = await nowCursor();
    const r = await call("bot_goto", { to: SURFACE, may_modify: "break", wait: true });
    assert.ok(["achieved", "already_there"].includes(r.outcome),
      `what check_path promised, bot_goto delivers: ${JSON.stringify(r)}`);
    const s = await call("bot_status", {});
    assert.ok(s.pos.y >= Y + 1, `surfaced (y=${s.pos.y})`);
    assert.ok((await didNotStarts(cursor)) <= 3, "no did_not_start flood");
  });

  test("bot_goto reach + may_modify is refused WITH the pointer (never a silent strip)", async (t) => {
    if (!bridgeUp) return t.skip();
    const r = await call("bot_goto", {
      reach: { x: X + 3, y: Y, z: Z }, may_modify: "break",
    });
    assert.equal(r.started, false, JSON.stringify(r));
    assert.equal(r.reason, "reach_with_rights_is_a_goal", JSON.stringify(r));
    assert.match(r.note ?? "", /bot_target/, "the refusal names the verb that IS this ask");
  });
});
