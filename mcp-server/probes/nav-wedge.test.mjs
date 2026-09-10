// Live probes for the 2026-08-02 wedge fixes (toolkit 0.45.0) — a survival body glitched in place
// for ~6.5 minutes at one cell, and every layer was working as coded. Five fixes, each probed here:
//
//   1. FOLLOWED PATHS NEVER ASSUME REPAIRS — startNav handed the goal's may_modify:break to the
//      player body's SOLVE, so paths routed through solid stone and the follower marched into the
//      wall until the node timeout, 101 ticks per leg. The follower solves without build rights
//      (NavProfile.withoutBuildRights) — and since 0.55.0 (W1_42257 F3) a rights-carrying
//      bot_goto DELEGATES to the move goal, which performs each break itself: the wall is mined
//      through, never wall-humped.
//   2. REPAIR STAGNATION GUARD — the goal loop re-decided the same dead end 25 times (a node
//      timeout each) before repair_budget_spent. Now three fruitless same-cell rounds end the goal
//      with `no_progress` and the obstruction.
//   3. TOUCH MULTI-RAY — ReachSolver.touch aimed ONE ray at the nearest box point; from an eye
//      above a feet-level neighbor that point sits in the top edge region and the ray grazes the
//      head-level block in front (live: los:false at range 1.08 to a block the body stared at).
//      Face-center fallback rays fix adjacency: standing beside the pair counts as touching.
//   4. YAW BOUNDED — the wedged body's unwrapped yaw reached -545,604 degrees (visible spinning).
//      rotlerp now wraps and near-zero waypoints hold the heading.
//   5. PLACE SELF-ENTOMBMENT — bot_place had no entity-obstruction gate and the bot placed a
//      crafting table into its own head cell (inWall damage every tick). Vanilla's isUnobstructed
//      gate now refuses with entity_in_the_way.
//
// Probe-owned site at 3.61M (site-map.test.mjs enforces exclusivity; the battery runs files
// CONCURRENTLY). Embodied: carries its own X-MCPTK-Session. Needs the dev server up.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const SESSION = "probe-nav-wedge";
const X = 3_610_000, Z = 3_610_000, Y = 200;

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
// run_command returns ok:true even when the COMMAND failed — the failure is only in `output`.
const CMD_FAILED = /Too many blocks|not loaded|Unknown command|Incorrect argument|Expected |No entity|cannot be/i;
async function cmd(c) {
  const r = await call("run_command", { command: c });
  const out = (r.output ?? []).join(" ");
  if (CMD_FAILED.test(out)) throw new Error(`staging command failed: ${c}\n  -> ${out}`);
  return r;
}
/** Vanilla /fill caps at 32768 blocks per call; stage big volumes as slices that stay under it. */
const FILL_LIMIT = 32768;
async function fill(x1, y1, z1, x2, y2, z2, block) {
  const [xa, xb] = [Math.min(x1, x2), Math.max(x1, x2)];
  const [ya, yb] = [Math.min(y1, y2), Math.max(y1, y2)];
  const [za, zb] = [Math.min(z1, z2), Math.max(z1, z2)];
  const h = yb - ya + 1;
  const xStep = Math.max(1, Math.floor(Math.sqrt(FILL_LIMIT / h)));
  for (let x = xa; x <= xb; x += xStep) {
    const xe = Math.min(xb, x + xStep - 1);
    const zStep = Math.max(1, Math.floor(FILL_LIMIT / ((xe - x + 1) * h)));
    for (let z = za; z <= zb; z += zStep) {
      await cmd(`fill ${x} ${ya} ${z} ${xe} ${yb} ${Math.min(zb, z + zStep - 1)} ${block}`);
    }
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function spawnPlayer(pos) {
  await call("bot_body", { action: "despawn" }).catch(() => {});
  const r = await call("bot_body", { action: "spawn", type: "player", pos });
  await sleep(700);
  return r;
}

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok)
  .catch(() => false);
if (!bridgeUp) {
  console.log(`\n  [skip] no bridge at ${BASE} — start the dev server to run these probes\n`);
}

// Sub-sites (Z offsets — one geometry per scenario, no reuse across tests).
const POCKET = Z;       // the live wedge: a 1x2 pocket in solid rock, destroy target far overhead
const TOUCH = Z + 24;   // the adjacency pair: feet-level target under a head-level occluder
const PLACE = Z + 48;   // open floor for the self-entombment refusal
const WALL = Z + 72;    // a walled courtyard for the no_path refusal

describe("nav wedge fixes: honest refusals instead of in-place grinding", { skip: !bridgeUp }, () => {
  test("stage the sites", { timeout: 60_000 }, async (t) => {
    if (!bridgeUp) return t.skip();
    await cmd(`forceload add ${X - 32} ${Z - 32} ${X + 32} ${Z + 96}`);
    await sleep(3000);
    await fill(X - 16, Y + 1, Z - 8, X + 16, Y + 12, Z + 88, "minecraft:air");
    await fill(X - 16, Y, Z - 8, X + 16, Y, Z + 88, "minecraft:stone");

    // POCKET: the live geometry — a 1x2 air pocket buried in a solid stone mass, target overhead.
    await fill(X - 6, Y + 1, POCKET - 6, X + 6, Y + 10, POCKET + 6, "minecraft:stone");
    await cmd(`fill ${X} ${Y + 1} ${POCKET} ${X} ${Y + 2} ${POCKET} minecraft:air`);
    await cmd(`setblock ${X} ${Y + 8} ${POCKET} minecraft:redstone_ore`);

    // TOUCH: a free-standing two-block pillar; the body will stand due east of it. The feet-level
    // target's nearest box point from a standing eye is its top-east edge — the graze geometry.
    await cmd(`setblock ${X - 1} ${Y + 1} ${TOUCH} minecraft:redstone_ore`);
    await cmd(`setblock ${X - 1} ${Y + 2} ${TOUCH} minecraft:stone`);

    // WALL: a courtyard the body cannot walk out of — 3-high walls around a 5x5 floor.
    await cmd(`fill ${X - 3} ${Y + 1} ${WALL - 3} ${X + 3} ${Y + 3} ${WALL + 3} minecraft:stone`);
    await cmd(`fill ${X - 2} ${Y + 1} ${WALL - 2} ${X + 2} ${Y + 3} ${WALL + 2} minecraft:air`);
    await sleep(500);

    // Staging must be REAL before anything is asserted.
    const probe = await call("get_blocks_at", { blocks: [
      { x: X, y: Y + 8, z: POCKET, expect: "minecraft:redstone_ore" },
      { x: X, y: Y + 1, z: POCKET, expect: "minecraft:air" },
      { x: X - 1, y: Y + 2, z: TOUCH, expect: "minecraft:stone" },
    ] });
    assert.ok(probe.blocks.every((b) => b[4] === 1),
      `the sites were not staged as designed: ${JSON.stringify(probe)}`);
  });

  test("wedge geometry: the goal resolves fast and honestly, never a 25-round grind", { timeout: 90_000 }, async (t) => {
    if (!bridgeUp) return t.skip();
    await spawnPlayer({ x: X + 0.5, y: Y + 1, z: POCKET + 0.5 });
    await call("bot_give", { item: "minecraft:iron_pickaxe", count: 1 });
    await call("bot_select", { item: "minecraft:iron_pickaxe" });

    const started = Date.now();
    const r = await call("bot_target", {
      action: "destroy", target: { at: { x: X, y: Y + 8, z: POCKET } },
      may_modify: "break", wait: true,
    });
    const elapsed = Date.now() - started;

    // Any HONEST resolution is acceptable — achieved (it mined its way up), unreachable, occluded,
    // no_progress, a spent break budget. What the live wedge produced, and this guards against, is
    // minutes of in-place node timeouts ending in repair_budget_spent.
    assert.ok(elapsed < 75_000,
      `the goal ground for ${elapsed}ms — the wedge signature (was ~128s per goal live)`);
    assert.notEqual(r.reason, "repair_budget_spent",
      `25-round repair grind is the regression this probe exists for: ${JSON.stringify(r)}`);
    // FRUITLESS rounds are the wedge signature, not rounds as such. `repairs` counts every round,
    // including the ones that mined a block — and since 0.46.0 a goal with break rights is allowed
    // to keep working as long as it is making progress (productive rounds no longer spend the
    // confusion budget, which is what lets a deliberate descent finish instead of conceding
    // two-thirds down). So measure what this probe is actually about: rounds that achieved nothing.
    // A body grinding in place still fails this; a body mining its way up honestly does not.
    const worked = r.ledger?.mined?.length ?? 0;
    assert.ok((r.repairs ?? 0) - worked <= 12,
      `unproductive repair rounds should stay far below the budget once stagnation fails fast `
      + `(${r.repairs} rounds, ${worked} of them mined): ${JSON.stringify(r)}`);

    // Yaw stays bounded (fix 4) — the live body accumulated -545,604 degrees while wedged.
    const s = await call("bot_status");
    assert.ok(Math.abs(s.yaw) <= 180.5, `yaw must stay wrapped, got ${s.yaw}`);
  });

  test("adjacency touch: standing beside a corner-grazed block counts as touching", { timeout: 30_000 }, async (t) => {
    if (!bridgeUp) return t.skip();
    await spawnPlayer({ x: X + 0.5, y: Y + 1, z: TOUCH + 0.5 });
    const r = await call("bot_goto", {
      reach: { x: X - 1, y: Y + 1, z: TOUCH }, wait: true,
    });
    // The single nearest-point ray read this as los:false (grazing the head-level stone) and sent
    // the body walking to a farther stand — or wedged it. Multi-ray: it is already touching.
    assert.equal(r.arrived, true, JSON.stringify(r));
    assert.equal(r.outcome, "already_there",
      `an adjacent block must be touchable from where the body stands: ${JSON.stringify(r)}`);
  });

  test("bot_place refuses to entomb the placing body (entity_in_the_way)", { timeout: 30_000 }, async (t) => {
    if (!bridgeUp) return t.skip();
    // CLEAR THE SITE FIRST. This test's last assertion is that a FREE cell still places, and a mob
    // that wandered in makes "free" false — live 2026-08-05 a spider was standing in it and the
    // refusal was correct (`blocked_by: minecraft:spider, self:false`, which is how it was
    // diagnosed in one read). `@e[distance]` is relative to the command source at world spawn, so
    // the volume form is the only one that reaches a site three million blocks out.
    await cmd(`kill @e[type=!minecraft:player,x=${X - 20},y=${Y - 10},z=${PLACE - 20},dx=40,dy=20,dz=40]`)
      .catch(() => {});
    await spawnPlayer({ x: X + 0.5, y: Y + 1, z: PLACE + 0.5 });
    await call("bot_give", { item: "minecraft:crafting_table", count: 4 });
    await call("bot_select", { item: "minecraft:crafting_table" });

    // Head cell and feet cell: both intersect the body — vanilla refuses, so must we.
    for (const y of [Y + 2, Y + 1]) {
      const r = await call("bot_place", { at: { x: X, y, z: PLACE } });
      assert.equal(r.ok, false, `placing into the body's own cell must refuse: ${JSON.stringify(r)}`);
      assert.equal(r.reason, "entity_in_the_way", JSON.stringify(r));
    }
    // The gate must not over-refuse: a free neighbor cell places fine.
    const ok = await call("bot_place", { at: { x: X + 2, y: Y + 1, z: PLACE } });
    assert.equal(ok.ok, true, `a free cell must still place: ${JSON.stringify(ok)}`);
  });

  test("bot_goto may_modify:break through a wall RUNS AS a move goal — follows never assume repairs", { timeout: 90_000 }, async (t) => {
    if (!bridgeUp) return t.skip();
    await spawnPlayer({ x: X + 0.5, y: Y + 1, z: WALL + 0.5 });
    await call("bot_give", { item: "minecraft:iron_pickaxe", count: 1 });
    await call("bot_select", { item: "minecraft:iron_pickaxe" });
    const r = await call("bot_goto", {
      to: { x: X + 8, y: Y + 1, z: WALL }, may_modify: "break", wait: true,
    }).catch((e) => ({ error: String(e) }));

    // CONTRACT CHANGED BY W1_42257_FIXES F3 (0.55.0). The 0.45.0 fix made the FOLLOWER solve
    // without build rights (that invariant stands — no leg ever marches into planned-but-unbroken
    // stone), which left `bot_goto may_modify` a silent no-op: reply echoed a budget, check_path
    // said reachable, the walk went nowhere. Now rights-carrying bot_goto DELEGATES to the move
    // goal, so the wall is MINED THROUGH by the machinery that performs each break itself — the
    // outcome is a bot_target completion, and what must never come back is the wall-humping stall.
    assert.equal(r.action, "bot_target", `build-assisted goto is a goal: ${JSON.stringify(r)}`);
    assert.notEqual(r.outcome, "stalled",
      `a followed path assumed un-performed breaks (the wedge): ${JSON.stringify(r)}`);
    assert.ok(["achieved", "already_there"].includes(r.outcome),
      `break rights + a 1-thick wall = arrival, honestly worked for: ${JSON.stringify(r)}`);
    assert.ok((r.ledger?.mined ?? []).length > 0,
      `the breaks are disclosed in the ledger: ${JSON.stringify(r.ledger)}`);
    await call("bot_body", { action: "despawn" }).catch(() => {});
  });
});
