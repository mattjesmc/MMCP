// Live probes for VERTICAL MOBILITY (W2_POSTMORTEM_FIXES.md §5) — the mine-up edges: a body sealed
// under solid rock can now ASCEND with may_modify:"both" (w2-79881's body was one-way-trapped 80
// blocks down; the evaluator had no edge that breaks upward). Plus the honesty around it: the
// budget pre-flight refuses an over-budget route with the real numbers, and a pillar with no
// blocks in the pack fails no_blocks_to_place instead of the terrain-shaped `not_placeable`.
//
// Staged at a probe-owned coordinate (3.84M). Own session. Run with `npm run test:live`.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const X = 3_840_000, Z = 3_840_000, Y = 120;
const SESSION = "probe-mine-up";
// The pocket: a 1x2 air cell at the center bottom of a solid stone cube. The cube is tall on
// purpose: a ~21-level ascent needs ~20 breaks AND ~20 places, safely past the default budget of
// 16 — the over_budget test's whole premise (an 11-level cube fit inside the default and the
// pre-flight rightly let it through on the first live run).
const POCKET = { x: X, y: Y + 1, z: Z };
const CUBE_TOP = Y + 22;

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

// Half-width of the cube. 16, not 6: at 6 the cube was NARROWER THAN THE ASCENT IS TALL, so the
// cheapest route to a cell 22 blocks up was to mine SIDEWAYS through 7 blocks of wall and out into
// open terrain — where the body promptly stalled in a cherry tree and the test reported
// "the ascent is broken" about a fixture that never required an ascent (live 2026-08-05). Verified
// the same day: with no sideways escape the identical goal returns achieved, y 121 → 141. A probe
// that can be satisfied by walking around the thing under test is not testing it.
// 33x33x23 = 25047 blocks, under /fill's 32768 cap — which fails SILENTLY when exceeded.
const HALF = 16;

async function stagePocketedCube() {
  await cmd(`fill ${X - HALF} ${Y} ${Z - HALF} ${X + HALF} ${CUBE_TOP} ${Z + HALF} minecraft:stone`);
  await cmd(`fill ${X - HALF} ${CUBE_TOP + 1} ${Z - HALF} ${X + HALF} ${CUBE_TOP + 8} ${Z + HALF} minecraft:air`);
  // The pocket the body starts sealed inside — feet + head air, everything else rock.
  await cmd(`fill ${X} ${Y + 1} ${Z} ${X} ${Y + 2} ${Z} minecraft:air`);
  await sleep(400);
}

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok).catch(() => false);
if (!bridgeUp) console.log(`\n  [skip] no bridge at ${BASE} — start the dev server\n`);

describe("mine-up: ascent through solid rock, budget pre-flight, fill honesty", { skip: !bridgeUp }, () => {
  test("stage the site", async (t) => {
    if (!bridgeUp) return t.skip();
    await cmd(`forceload add ${X - 32} ${Z - 32} ${X + 32} ${Z + 32}`);
    await sleep(1500);
    await call("bot_reactions", { action: "clear" });
  });

  test("a sealed body ASCENDS to the surface with may_modify:both + a raised budget", async (t) => {
    if (!bridgeUp) return t.skip();
    await stagePocketedCube();
    await call("bot_body", { action: "spawn", type: "player", pos: POCKET });
    await call("bot_give", { item: "minecraft:iron_pickaxe", count: 1 });
    await call("bot_give", { item: "minecraft:cobblestone", count: 64 });
    await call("bot_select", { item: "iron_pickaxe" });
    const r = await call("bot_target", {
      action: "move", target: { at: { x: X, y: CUBE_TOP + 1, z: Z } },
      may_modify: "both", budget: { break: 96, place: 96 }, wait: true,
    });
    assert.ok(["achieved", "already_there"].includes(r.outcome),
      `the w2-79881 trap: this used to be unreachable/pillar_blocked — ${JSON.stringify(r)}`);
    const s = await call("bot_status", {});
    assert.ok(s.pos.y >= CUBE_TOP - 1,
      `the body actually rose (${s.pos.y} vs cube top ${CUBE_TOP})`);
    assert.ok((r.ledger?.mined ?? []).length > 0, "the ascent mined its way up — disclosed");
  });

  test("an over-budget route stops WITH the numbers — up front or at the spend, never silently", async (t) => {
    if (!bridgeUp) return t.skip();
    await stagePocketedCube();
    await call("bot_body", { action: "spawn", type: "player", pos: POCKET });
    await call("bot_give", { item: "minecraft:iron_pickaxe", count: 1 });
    await call("bot_give", { item: "minecraft:cobblestone", count: 64 });
    const r = await call("bot_target", {
      action: "move", target: { at: { x: X, y: CUBE_TOP + 1, z: Z } },
      may_modify: "both", wait: true, // default budgets: 16/16 vs a ~21-level ascent
    });
    // The honest contract has two shapes. When the global solve can SEE the route, the pre-flight
    // refuses up front (`over_budget` + route_needs). Deep modify-heavy routes exhaust the
    // solver's node budget before the plan shows its true size (measured live on this very cube),
    // so there the stop comes mid-route as *_budget_spent — with the resumption note and the
    // ledger of work already done. Both are the fix; what must NEVER happen again is w2-79881's
    // shape: a start that promised nothing about budgets and a stop that named no remedy.
    if (r.started === false) {
      assert.equal(r.reason, "over_budget", JSON.stringify(r));
      assert.ok(r.route_needs && (r.route_needs.breaks > 16 || r.route_needs.places > 16),
        `the refusal carries the real work count: ${JSON.stringify(r.route_needs)}`);
      assert.ok(r.budgets, "and the budgets it exceeds");
    } else {
      assert.equal(r.outcome, "stopped", JSON.stringify(r));
      assert.match(r.reason, /^(break|place)_budget_spent$/, JSON.stringify(r));
      assert.match(r.note ?? "", /re-issue.*larger.*budget|budget.*max 256/i,
        `the mid-route stop must carry the remedy: ${JSON.stringify(r.note)}`);
      assert.ok((r.ledger?.mined ?? []).length > 0, "and the ledger of work already done");
    }
  });

  test("a pillar with an empty pack fails no_blocks_to_place — not `not_placeable`", async (t) => {
    if (!bridgeUp) return t.skip();
    // An obsidian tube: breaks cost past MAX_BREAK_COST, so the only way up is pillaring —
    // which needs blocks this body does not carry.
    const tx = X + 16;
    await cmd(`fill ${tx - 1} ${Y} ${Z - 1} ${tx + 1} ${Y + 6} ${Z + 1} minecraft:obsidian`);
    await cmd(`fill ${tx} ${Y + 1} ${Z} ${tx} ${Y + 6} ${Z} minecraft:air`);
    await sleep(300);
    await call("bot_body", { action: "spawn", type: "player", pos: { x: tx, y: Y + 1, z: Z } });
    const r = await call("bot_target", {
      action: "move", target: { at: { x: tx, y: Y + 7, z: Z } },
      may_modify: "both", budget: { break: 32, place: 32 }, wait: true,
    });
    if (r.started === false) {
      // Acceptable alternative: the pre-flight solve may already see no route (unbreakable walls,
      // nothing to place) — but it must never say `not_placeable`.
      assert.notEqual(r.reason, "not_placeable", JSON.stringify(r));
    } else {
      assert.equal(r.outcome, "stopped", JSON.stringify(r));
      assert.equal(r.reason, "no_blocks_to_place",
        `the old lie was terrain-shaped \`not_placeable\` while holding a pickaxe: ${JSON.stringify(r)}`);
    }
    await cmd(`fill ${tx - 1} ${Y} ${Z - 1} ${tx + 1} ${Y + 6} ${Z + 1} minecraft:air`);
  });
});
