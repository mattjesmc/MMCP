// The §15 referee-equivalence probe (HUMAN_RIG_PLAN.md phase 3, toolkit 0.66.0): the SAME intent
// judged by the expert goal driver (bot_target) and by the human referee's predicates (wm_verdict)
// must land on the SAME verdict semantics. VerdictPredicates was extracted from GoalRunner by
// mirroring, not by refactoring the live-verified driver — this probe is what keeps the two from
// drifting apart and silently forking the training labels.
//
// Pinned here, per verb:
//   destroy — worked path both say "achieved"; the empty-cell path both say "already_clear"
//             (the succeeds-falsely guard: complete, but SAY nothing was mined).
//   place   — worked path both say "achieved"; an occupied cell both refuse "stopped"/"obstructed".
//   move    — vocabulary parity (achieved / already_there), plus the DOCUMENTED deliberate
//             divergence: the referee's ε is 0.25 (stand ON the highlighted cell) where the bot's
//             MOVE_WITHIN is 2.5 — a pos the bot would complete at must NOT satisfy the referee.
//   shape   — the referee payload carries the shared verdict contract (action_id, action, goal,
//             outcome, game_tick, dimension); its `action` is "human_task", the bot's is
//             "bot_target", and repairs/ledger stay bot-only by design.
//
// NOT probed headless: the live sweep closing a real human task (needs a connected human — the
// supervised smoke), and timeout_ticks (only reachable through a presented task).
//
// OWNS SITE 1,760,000 (site-map.test.mjs). Live probe: needs the dev server; skips when down.

import { test } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const SITE = { x: 1760000, z: 1760000 };
const Y = 200;

const SESSION = await fetch(`${BASE}/hello`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ label: "verdict-equivalence-probe" }),
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

async function call(tool, args = {}) {
  const j = await callRaw(tool, args);
  if (!j.ok) throw new Error(`${tool} failed: ${JSON.stringify(j.error)}`);
  return j.result;
}
const cmd = (c) => call("run_command", { command: c });

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok)
  .catch(() => false);
if (!bridgeUp) {
  console.log(`\n  [skip] no bridge at ${BASE} — start the dev server to run these probes\n`);
}

async function stageStrip() {
  await cmd(`forceload add ${SITE.x - 16} ${SITE.z - 16} ${SITE.x + 32} ${SITE.z + 16}`);
  await cmd(`fill ${SITE.x - 4} ${Y - 1} ${SITE.z - 6} ${SITE.x + 24} ${Y - 1} ${SITE.z + 6} minecraft:stone`);
  await cmd(`fill ${SITE.x - 4} ${Y} ${SITE.z - 6} ${SITE.x + 24} ${Y + 3} ${SITE.z + 6} minecraft:air`);
}

const at = (dx) => ({ x: SITE.x + dx, y: Y, z: SITE.z });

/** The shared verdict contract both emitters must carry (bot adds repairs/ledger on top). */
function assertVerdictShape(v, label) {
  for (const k of ["action_id", "action", "goal", "outcome", "game_tick", "dimension"]) {
    assert.ok(v[k] !== undefined && v[k] !== null, `${label} verdict must carry ${k}: ${JSON.stringify(v)}`);
  }
}

async function withBody(fn) {
  await call("bot_body", { action: "spawn", type: "player", pos: at(0) });
  try {
    return await fn();
  } finally {
    await callRaw("bot_body", { action: "despawn" });
  }
}

test("destroy parity: worked path is 'achieved' on both judges", { skip: !bridgeUp }, async () => {
  await stageStrip();
  // Dirt digs bare-handed — stone would refuse `wrong_tool` (the tier gate) and test nothing here.
  const cell = at(3);
  await cmd(`setblock ${cell.x} ${cell.y} ${cell.z} minecraft:dirt`);

  const before = await call("wm_verdict", { action: "destroy", at: cell });
  assert.equal(before.holds, false, `a solid cell is not cleared: ${JSON.stringify(before)}`);
  assert.equal(before.tick_verdict, null, "no verdict while the predicate is unsatisfied");
  assert.equal(before.accept_verdict, null, "a solid cell presents as real work at accept");

  const expert = await withBody(() =>
    call("bot_target", { action: "destroy", target: { at: cell }, wait: true }));
  assert.equal(expert.outcome, "achieved", `the expert dig must work: ${JSON.stringify(expert)}`);
  assertVerdictShape(expert, "expert");

  const after = await call("wm_verdict", { action: "destroy", at: cell });
  assert.equal(after.holds, true, `the referee must see the cleared cell: ${JSON.stringify(after)}`);
  assertVerdictShape(after.tick_verdict, "referee");
  assert.equal(after.tick_verdict.outcome, expert.outcome,
    "the same worked destroy must close with the same outcome word on both judges");
  assert.equal(after.tick_verdict.goal, "destroy");
  assert.equal(after.tick_verdict.action, "human_task", "the referee names its own surface");
});

test("destroy parity: an already-empty cell is 'already_clear' on both judges", { skip: !bridgeUp }, async () => {
  await stageStrip();
  const cell = at(5); // staged air

  const expert = await withBody(() =>
    call("bot_target", { action: "destroy", target: { at: cell }, wait: true }));
  assert.equal(expert.outcome, "already_clear", JSON.stringify(expert));
  assert.match(expert.note ?? "", /no block|nothing was mined/i,
    "the bot side warns the coordinate-guesser");

  const ref = await call("wm_verdict", { action: "destroy", at: cell });
  assert.equal(ref.holds, true);
  assert.ok(ref.accept_verdict, `accept must close instantly on an empty cell: ${JSON.stringify(ref)}`);
  assert.equal(ref.accept_verdict.outcome, expert.outcome,
    "already_clear is ONE word, whichever judge says it");
  assert.match(ref.accept_verdict.note ?? "", /no block|nothing was mined/i,
    "the referee warns the coordinate-guesser with the same honesty");
});

test("place parity: worked path 'achieved', occupied cell 'stopped'/'obstructed' on both", { skip: !bridgeUp }, async () => {
  await stageStrip();
  const empty = at(7);   // staged air
  const solid = at(9);
  await cmd(`setblock ${solid.x} ${solid.y} ${solid.z} minecraft:stone`);

  const { worked, blocked } = await withBody(async () => {
    await call("bot_give", { item: "minecraft:dirt", count: 4 });
    const worked = await call("bot_target",
      { action: "place", target: { at: empty }, item: "minecraft:dirt", wait: true });
    const blocked = await call("bot_target",
      { action: "place", target: { at: solid }, item: "minecraft:dirt", wait: true });
    return { worked, blocked };
  });

  assert.equal(worked.outcome, "achieved", JSON.stringify(worked));
  const refWorked = await call("wm_verdict", { action: "place", at: empty });
  assert.equal(refWorked.holds, true, "the placed block satisfies the referee");
  assert.equal(refWorked.tick_verdict.outcome, worked.outcome);

  assert.equal(blocked.outcome, "stopped", JSON.stringify(blocked));
  assert.equal(blocked.reason, "obstructed", JSON.stringify(blocked));
  const refBlocked = await call("wm_verdict", { action: "place", at: solid });
  assert.ok(refBlocked.accept_verdict, "an occupied cell refuses at accept");
  assert.equal(refBlocked.accept_verdict.outcome, blocked.outcome,
    "both judges stop rather than claim placement");
  assert.equal(refBlocked.accept_verdict.reason, blocked.reason,
    "obstructed is ONE reason, whichever judge says it");

  await cmd(`setblock ${empty.x} ${empty.y} ${empty.z} minecraft:air`);
  await cmd(`setblock ${solid.x} ${solid.y} ${solid.z} minecraft:air`);
});

test("move parity: vocabulary matches; the referee's ε is deliberately tighter", { skip: !bridgeUp }, async () => {
  await stageStrip();
  const goal = at(15);

  const { traveled, already } = await withBody(async () => {
    const traveled = await call("bot_target",
      { action: "move", target: { at: goal }, wait: true });
    const already = await call("bot_target",
      { action: "move", target: { at: goal }, wait: true });
    return { traveled, already };
  });
  assert.equal(traveled.outcome, "achieved", JSON.stringify(traveled));
  assert.equal(already.outcome, "already_there", JSON.stringify(already));

  // Referee, same vocabulary: standing ON the cell is already_there at accept / achieved on tick.
  const onCell = { x: goal.x + 0.5, y: goal.y, z: goal.z + 0.5 };
  const refOn = await call("wm_verdict", { action: "move", at: goal, pos: onCell });
  assert.equal(refOn.holds, true, JSON.stringify(refOn));
  assert.equal(refOn.tick_verdict.outcome, "achieved");
  assert.equal(refOn.accept_verdict.outcome, "already_there",
    "the accept-time word matches the bot's re-issue word");

  // ε slack: a fifth of a block outside the cell still counts...
  const nearEdge = { x: goal.x - 0.2, y: goal.y, z: goal.z + 0.5 };
  assert.equal((await call("wm_verdict", { action: "move", at: goal, pos: nearEdge })).holds, true,
    "0.2 outside the cell is within the referee's 0.25 boundary slack");

  // ...but the bot's 2.5-block MOVE_WITHIN must NOT satisfy the referee — the deliberate,
  // documented divergence (the human is asked to stand on the highlighted block, not near it).
  const botClose = { x: goal.x + 2.5, y: goal.y, z: goal.z + 0.5 };
  const refFar = await call("wm_verdict", { action: "move", at: goal, pos: botClose });
  assert.equal(refFar.holds, false,
    "a pos the bot would complete at (2 blocks off) must not satisfy the human referee");
  assert.equal(refFar.accept_verdict, null);

  await cmd(`forceload remove ${SITE.x - 16} ${SITE.z - 16} ${SITE.x + 32} ${SITE.z + 16}`);
});

test("wm_verdict refuses to page terrain in (residency guard)", { skip: !bridgeUp }, async () => {
  // Far never-generated square (the conformance UNGEN convention, own coords): an observe tool
  // must refuse, not load-or-generate — the raycast lesson, held here too.
  const j = await callRaw("wm_verdict", {
    action: "destroy", at: { x: 3_060_000, y: 100, z: 3_060_000 },
  });
  assert.equal(j.ok, false);
  assert.match(j.error ?? "", /not resident|forceload/i, JSON.stringify(j));
});
