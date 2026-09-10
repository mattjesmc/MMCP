// Deep capability + honesty probes for the WALKER body (toolkit 0.17.0, BOT_SURFACE_DESIGN.md §11.7
// follow-up) — everything walker.test.mjs does NOT cover:
//
//   BRIDGING EXECUTED — the last never-run pipeline: a 7-gap (unjumpable) crossed by placing floor,
//     with the three honesty stops around it (plain profile refuses w/ obstruction; place rights but
//     empty inventory stops item_missing; budget exhaustion stops break_budget_spent on the plug pen).
//   MAX-RANGE JUMP — a 4-gap (landing distance 5 = the profile ceiling) leapt physically, both ways
//     (the return crossing runs through plain bot_goto, no goal loop — the facade's own leap).
//   STAIRS — 1-block risers force the driver's step-up jump (MoveControl replacement), then the
//     descent exercises the falling-advance branch.
//   HANDS TRANSFER — give/place/mine/inventory on the walker body (the BotBodyEntity refactor's
//     whole point: possession-style no_hands must NOT apply here).
//   IRON DOOR — honest stop with the control locus (lever) named, on a body that actually walks.
//   POSSESSION INTERPLAY — possess while a walker is spawned, release returns to it.
//   RE-ISSUE GUARD — a second identical move returns already_there, not a fresh achieved.
//
// Courses are PENS with 2-THICK shells (bot_target's 2.5 arrival radius pierces 1-thick walls —
// live-caught) and 4-DEEP trenches under gaps (max fall 3 keeps A* from routing through the pit,
// and an undershot leap strands the body instead of killing it — an honest stop, not a dead probe).
//
// Probe-owned site at 3.46M. Needs the dev server up (gradlew runServer); skips when bridge is down.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const SESSION = "probe-walker-caps";
const X = 3_460_000, Z = 3_460_000, Y = 200;

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
const spawnWalker = async (pos) => {
  const r = await call("bot_body", { action: "spawn", type: "walker", pos });
  await sleep(600);
  return r;
};

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok)
  .catch(() => false);
if (!bridgeUp) {
  console.log(`\n  [skip] no bridge at ${BASE} — start the dev server to run these probes\n`);
}

// Sites, each a penned strip along x (interior z-1..z+1 around its centerline zc):
const GAP4 = Z;        // 4-gap at X+7..X+10 over a 4-deep trench
const BRIDGE = Z + 24; // 7-gap at X+6..X+12 over a 4-deep trench
const STAIRS = Z + 48; // risers at X+3/X+4/X+5, platform top walk level Y+4
const PLUG = Z + 72;   // stone plug at X+4 (2 cells), for budget honesty
const IRON = Z + 96;   // iron door at X+4 + lever, for the control locus

// Builds one 2-thick-shelled pen: interior x X..X+13 (walk level Y+1..Y+3), caps at both ends.
async function pen(zc, height = 3) {
  await cmd(`fill ${X - 2} ${Y + 1} ${zc - 3} ${X + 16} ${Y + height} ${zc - 2} minecraft:stone`);
  await cmd(`fill ${X - 2} ${Y + 1} ${zc + 2} ${X + 16} ${Y + height} ${zc + 3} minecraft:stone`);
  await cmd(`fill ${X - 2} ${Y + 1} ${zc - 1} ${X - 1} ${Y + height} ${zc + 1} minecraft:stone`);
  await cmd(`fill ${X + 15} ${Y + 1} ${zc - 1} ${X + 16} ${Y + height} ${zc + 1} minecraft:stone`);
}

describe("walker capabilities: bridging, max jump, stairs, hands, honesty stops", { skip: !bridgeUp }, () => {
  test("stage the sites", async (t) => {
    if (!bridgeUp) return t.skip();
    await cmd(`forceload add ${X - 32} ${Z - 32} ${X + 32} ${Z + 128}`);
    await sleep(1500);
    // Blank slate + a SOLID 6-deep foundation. Not a 1-thick slab: the first run's trenches were
    // hollow underneath (blank-slate air), so a stranded walker walked off the trench-floor patch
    // and fell 139 blocks into the ocean. Trenches must be carved into solid ground to be pens.
    // SLICED: the one-shot version was 68,880 blocks — over /fill's 32,768 cap — and FAILED
    // SILENTLY on every run. It never mattered until a colliding probe site left debris in the
    // airspace (2026-07-30, the player-body probe's first run) and the un-blanked leftovers put a
    // stone in the 4-gap's jump lane. Slices stay under the cap; a genuinely blank slate again.
    for (let z0 = Z - 8; z0 <= Z + 112; z0 += 40) {
      const z1 = Math.min(z0 + 39, Z + 112);
      await cmd(`fill ${X - 16} ${Y - 5} ${z0} ${X + 24} ${Y + 8} ${z1} minecraft:air`);
    }
    await cmd(`fill ${X - 16} ${Y - 5} ${Z - 8} ${X + 24} ${Y} ${Z + 112} minecraft:stone`);
    // GAP4: pen + 4-cell gap over a 4-deep trench (floor at Y-4, so max-fall-3 can't route through).
    await pen(GAP4);
    await cmd(`fill ${X + 7} ${Y - 3} ${GAP4 - 1} ${X + 10} ${Y} ${GAP4 + 1} minecraft:air`);
    await cmd(`fill ${X + 7} ${Y - 4} ${GAP4 - 1} ${X + 10} ${Y - 4} ${GAP4 + 1} minecraft:stone`);
    // BRIDGE: pen + 7-cell gap (landing distance 8 > jump ceiling 5), same trench treatment.
    await pen(BRIDGE);
    await cmd(`fill ${X + 6} ${Y - 3} ${BRIDGE - 1} ${X + 12} ${Y} ${BRIDGE + 1} minecraft:air`);
    await cmd(`fill ${X + 6} ${Y - 4} ${BRIDGE - 1} ${X + 12} ${Y - 4} ${BRIDGE + 1} minecraft:stone`);
    // STAIRS: pen (tall) + three 1-block risers up to a platform whose walk level is Y+4.
    await pen(STAIRS, 6);
    await cmd(`fill ${X + 3} ${Y + 1} ${STAIRS - 1} ${X + 3} ${Y + 1} ${STAIRS + 1} minecraft:stone`);
    await cmd(`fill ${X + 4} ${Y + 1} ${STAIRS - 1} ${X + 4} ${Y + 2} ${STAIRS + 1} minecraft:stone`);
    await cmd(`fill ${X + 5} ${Y + 1} ${STAIRS - 1} ${X + 5} ${Y + 3} ${STAIRS + 1} minecraft:stone`);
    await cmd(`fill ${X + 6} ${Y + 1} ${STAIRS - 1} ${X + 10} ${Y + 3} ${STAIRS + 1} minecraft:stone`);
    // PLUG: corridor with roof + a 2-cell stone plug at X+4 (interior 1-wide, like walker.test).
    await cmd(`fill ${X} ${Y + 1} ${PLUG - 2} ${X + 9} ${Y + 3} ${PLUG - 1} minecraft:stone`);
    await cmd(`fill ${X} ${Y + 1} ${PLUG + 1} ${X + 9} ${Y + 3} ${PLUG + 2} minecraft:stone`);
    await cmd(`fill ${X} ${Y + 3} ${PLUG} ${X + 9} ${Y + 3} ${PLUG} minecraft:stone`);
    await cmd(`fill ${X + 8} ${Y + 1} ${PLUG} ${X + 9} ${Y + 2} ${PLUG} minecraft:stone`);
    await cmd(`fill ${X} ${Y + 1} ${PLUG} ${X + 3} ${Y + 2} ${PLUG} minecraft:air`);
    await cmd(`fill ${X + 5} ${Y + 1} ${PLUG} ${X + 7} ${Y + 2} ${PLUG} minecraft:air`);
    await cmd(`fill ${X + 4} ${Y + 1} ${PLUG} ${X + 4} ${Y + 2} ${PLUG} minecraft:stone`);
    // IRON: same corridor shape, iron door in the plug cell, lever set INTO the inner wall beside it
    // (within the control locator's radius-3 box; the outer wall row keeps the pen sealed).
    await cmd(`fill ${X} ${Y + 1} ${IRON - 2} ${X + 9} ${Y + 3} ${IRON - 1} minecraft:stone`);
    await cmd(`fill ${X} ${Y + 1} ${IRON + 1} ${X + 9} ${Y + 3} ${IRON + 2} minecraft:stone`);
    await cmd(`fill ${X} ${Y + 3} ${IRON} ${X + 9} ${Y + 3} ${IRON} minecraft:stone`);
    await cmd(`fill ${X + 8} ${Y + 1} ${IRON} ${X + 9} ${Y + 2} ${IRON} minecraft:stone`);
    await cmd(`fill ${X} ${Y + 1} ${IRON} ${X + 7} ${Y + 2} ${IRON} minecraft:air`);
    await cmd(`setblock ${X + 4} ${Y + 1} ${IRON} minecraft:iron_door[facing=east,half=lower]`);
    await cmd(`setblock ${X + 4} ${Y + 2} ${IRON} minecraft:iron_door[facing=east,half=upper]`);
    await cmd(`setblock ${X + 3} ${Y + 2} ${IRON - 1} minecraft:lever[face=wall,facing=south]`);
    await sleep(400);
  });

  // ---- max-range jump, both directions, plus the re-issue guard --------------

  test("4-gap: check_path predicts a jump; bot_target leaps it physically", async (t) => {
    if (!bridgeUp) return t.skip();
    const p = await call("check_path", {
      from: { x: X + 1, y: Y + 1, z: GAP4 }, to: { x: X + 13, y: Y + 1, z: GAP4 } });
    assert.equal(p.reachable, true, JSON.stringify(p));
    assert.ok(p.work?.jumps >= 1, JSON.stringify(p.work));
    await spawnWalker({ x: X + 1.5, y: Y + 1, z: GAP4 + 0.5 });
    const r = await call("bot_target", {
      action: "move", target: { at: { x: X + 13, y: Y + 1, z: GAP4 } }, wait: true });
    assert.equal(r.outcome, "achieved", JSON.stringify(r));
    assert.ok(r.ledger?.jumped?.length >= 1, `leap must be disclosed: ${JSON.stringify(r.ledger)}`);
    const s = await call("bot_status", {});
    assert.ok(s.pos.x >= X + 11 - 2.5, `past the gap, at x=${s.pos.x}`);
  });

  test("re-issuing the same move returns already_there, not a fresh achieved", async (t) => {
    if (!bridgeUp) return t.skip();
    const r = await call("bot_target", {
      action: "move", target: { at: { x: X + 13, y: Y + 1, z: GAP4 } }, wait: true });
    assert.equal(r.outcome, "already_there", JSON.stringify(r));
  });

  test("plain bot_goto leaps back across (the facade jumps without the goal loop)", async (t) => {
    if (!bridgeUp) return t.skip();
    const r = await call("bot_goto", { to: { x: X + 1.5, y: Y + 1, z: GAP4 + 0.5 }, wait: true });
    assert.equal(r.arrived, true, JSON.stringify(r));
    assert.ok(r.traveled >= 8, `should have traveled the strip back, got ${r.traveled}`);
  });

  // ---- hands on the walker (the BotBodyEntity point) --------------------------

  test("hands transfer: give -> inventory -> place -> mine back on the WALKER", async (t) => {
    if (!bridgeUp) return t.skip();
    const gave = await call("bot_give", { item: "minecraft:dirt", count: 32 });
    assert.ok((gave.added ?? gave.count ?? 32) >= 1, JSON.stringify(gave));
    const st = await call("bot_status", { inventory: true });
    assert.ok(JSON.stringify(st.inventory ?? st).includes("dirt"),
      `dirt in walker inventory: ${JSON.stringify(st.inventory ?? st)}`);
    // Place one ahead on the floor strip, then mine it back.
    const at = { x: X + 3, y: Y + 1, z: GAP4 };
    const placed = await call("bot_place", { at, item: "minecraft:dirt" });
    assert.notEqual(placed.ok, false, JSON.stringify(placed));
    const mined = await call("bot_mine", { at, wait: true });
    assert.ok(mined.mined ? String(mined.mined).includes("dirt") : true, JSON.stringify(mined));
  });

  // ---- the bridge pipeline and its honesty ring --------------------------------

  test("7-gap plain: honest refusal — unreachable with a bridgeable-gap obstruction", async (t) => {
    if (!bridgeUp) return t.skip();
    const p = await call("check_path", {
      from: { x: X + 1, y: Y + 1, z: BRIDGE }, to: { x: X + 14, y: Y + 1, z: BRIDGE } });
    assert.equal(p.reachable, false, `7-gap must not be jumpable: ${JSON.stringify(p)}`);
    await spawnWalker({ x: X + 1.5, y: Y + 1, z: BRIDGE + 0.5 });
    const r = await call("bot_target", {
      action: "move", target: { at: { x: X + 14, y: Y + 1, z: BRIDGE } }, wait: true });
    assert.equal(r.outcome, "stopped", JSON.stringify(r));
    assert.ok(r.obstruction, `the stop must name the blocker: ${JSON.stringify(r)}`);
  });

  test("7-gap with place rights but NOTHING to place stops item_missing", async (t) => {
    if (!bridgeUp) return t.skip();
    // Fresh walker = fresh empty inventory (the previous one carried dirt).
    await spawnWalker({ x: X + 1.5, y: Y + 1, z: BRIDGE + 0.5 });
    const r = await call("bot_target", {
      action: "move", target: { at: { x: X + 14, y: Y + 1, z: BRIDGE } },
      may_modify: "place", item: "minecraft:dirt", wait: true });
    assert.equal(r.outcome, "stopped", JSON.stringify(r));
    assert.equal(r.reason, "item_missing", JSON.stringify(r));
  });

  test("BRIDGING EXECUTED: 7-gap crossed by placing floor, disclosed in ledger.placed", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_give", { item: "minecraft:dirt", count: 32 });
    const r = await call("bot_target", {
      action: "move", target: { at: { x: X + 14, y: Y + 1, z: BRIDGE } },
      may_modify: "place", item: "minecraft:dirt", wait: true });
    assert.equal(r.outcome, "achieved", JSON.stringify(r));
    assert.ok(r.ledger?.placed?.length >= 3,
      `bridging must disclose placed cells: ${JSON.stringify(r.ledger)}`);
    const s = await call("bot_status", {});
    assert.ok(s.pos.x >= X + 13 - 2.5, `physically across, at x=${s.pos.x}`);
  });

  // ---- stairs: step-up jumps and the descent -----------------------------------

  test("stairs up: three 1-block risers climbed to the platform", async (t) => {
    if (!bridgeUp) return t.skip();
    await spawnWalker({ x: X + 1.5, y: Y + 1, z: STAIRS + 0.5 });
    const r = await call("bot_target", {
      action: "move", target: { at: { x: X + 8, y: Y + 4, z: STAIRS } }, wait: true });
    assert.equal(r.outcome, "achieved", JSON.stringify(r));
    const s = await call("bot_status", {});
    assert.ok(Math.abs(s.pos.y - (Y + 4)) < 0.6, `on the platform at y=${s.pos.y}`);
  });

  test("stairs down: descends back (falling-advance branch)", async (t) => {
    if (!bridgeUp) return t.skip();
    const r = await call("bot_target", {
      action: "move", target: { at: { x: X + 1, y: Y + 1, z: STAIRS } }, wait: true });
    assert.equal(r.outcome, "achieved", JSON.stringify(r));
    const s = await call("bot_status", {});
    assert.ok(Math.abs(s.pos.y - (Y + 1)) < 0.6, `back on the floor at y=${s.pos.y}`);
  });

  // ---- budget honesty ------------------------------------------------------------

  test("PREDICTION parity (0.24.0): check_path budget 1 vs the 2-cell plug = break_budget_exceeded", async (t) => {
    if (!bridgeUp) return t.skip();
    // Must run BEFORE the execution test below mines the plug. The committed plan needs 2 breaks;
    // budget 1 must answer reachable:false — promising arrival execution would refuse was the
    // review-caught parity gap.
    const r = await call("check_path", {
      from: { x: X + 1, y: Y + 1, z: PLUG }, to: { x: X + 7, y: Y + 1, z: PLUG },
      may_modify: "break", budget: { break: 1 } });
    assert.equal(r.reachable, false, JSON.stringify(r));
    assert.equal(r.reason, "break_budget_exceeded", JSON.stringify(r));
    assert.ok((r.work?.break_cells ?? 0) >= 2,
      `the route's committed plan discloses the work: ${JSON.stringify(r.work)}`);
    // ...and the same route under the default budget is confirmed reachable.
    const ok = await call("check_path", {
      from: { x: X + 1, y: Y + 1, z: PLUG }, to: { x: X + 7, y: Y + 1, z: PLUG },
      may_modify: "break" });
    assert.equal(ok.reachable, true, JSON.stringify(ok));
  });

  test("break budget 1 vs a 2-cell plug: refused UP FRONT with the route's real numbers", async (t) => {
    if (!bridgeUp) return t.skip();
    // The w2 postmortem's budget pre-flight (§5): when the solve can see the whole route, an
    // over-budget goal is refused BEFORE any work is spent — with route_needs — instead of
    // mining one block and dying break_budget_spent halfway in (the old contract this test
    // used to pin; the mid-route stop remains the fallback for routes too deep to pre-solve,
    // pinned by mine-up.test.mjs).
    await spawnWalker({ x: X + 1.5, y: Y + 1, z: PLUG + 0.5 });
    const r = await call("bot_target", {
      action: "move", target: { at: { x: X + 7, y: Y + 1, z: PLUG } },
      may_modify: "break", budget: { break: 1 }, wait: true });
    assert.equal(r.started, false, JSON.stringify(r));
    assert.equal(r.reason, "over_budget", JSON.stringify(r));
    assert.equal(r.route_needs?.breaks, 2, `the real work count: ${JSON.stringify(r.route_needs)}`);
    assert.equal(r.budgets?.break, 1, JSON.stringify(r.budgets));
  });

  test("...and a follow-up with default budget finishes the job (resumable ledger)", async (t) => {
    if (!bridgeUp) return t.skip();
    const r = await call("bot_target", {
      action: "move", target: { at: { x: X + 7, y: Y + 1, z: PLUG } },
      may_modify: "break", wait: true });
    assert.equal(r.outcome, "achieved", JSON.stringify(r));
    assert.ok(r.ledger?.mined?.length >= 1, JSON.stringify(r.ledger));
  });

  // ---- iron door: honest stop, control named --------------------------------------

  test("iron door: honest stop naming the control (lever) to activate", async (t) => {
    if (!bridgeUp) return t.skip();
    await spawnWalker({ x: X + 1.5, y: Y + 1, z: IRON + 0.5 });
    // Seal the west entrance BEHIND the walker: the search frontier must be the door, not some
    // outside wall on a route around (which is what the first run's obstruction honestly named).
    await cmd(`fill ${X - 2} ${Y + 1} ${IRON} ${X - 1} ${Y + 3} ${IRON} minecraft:stone`);
    await sleep(200);
    const r = await call("bot_target", {
      action: "move", target: { at: { x: X + 7, y: Y + 1, z: IRON } }, wait: true });
    assert.equal(r.outcome, "stopped", JSON.stringify(r));
    assert.ok(r.obstruction, JSON.stringify(r));
    assert.match(r.obstruction.path_type ?? "", /IRON/i, JSON.stringify(r.obstruction));
    assert.ok(r.obstruction.control, `the lever should be located: ${JSON.stringify(r.obstruction)}`);
  });

  // ---- possession interplay ----------------------------------------------------------

  test("possess while a walker is spawned; release returns to the walker", async (t) => {
    if (!bridgeUp) return t.skip();
    await cmd(`kill @e[type=minecraft:zombie,x=${X - 16},y=${Y},z=${Z - 8},dx=48,dy=12,dz=128]`).catch(() => {});
    await cmd(`summon minecraft:zombie ${X - 5} ${Y + 1} ${Z + 12} {NoAI:1b,PersistenceRequired:1b}`);
    await sleep(400);
    const near = await call("get_entities", {
      origin: { x: X - 5, y: Y + 1, z: Z + 12 }, radius: 8 }).catch(() => null);
    const list = near?.entities ?? near ?? [];
    const zid = (Array.isArray(list) ? list : []).find((e) =>
      String(e.type ?? "").includes("zombie"))?.id;
    if (zid == null) return t.skip("no zombie id from get_entities");
    const p = await call("bot_body", { action: "possess", target: zid });
    assert.equal(p.possessed, true, JSON.stringify(p));
    let s = await call("bot_status", {});
    assert.equal(s.body, "possessed", JSON.stringify(s));
    const rel = await call("bot_body", { action: "release" });
    assert.equal(rel.released, true, JSON.stringify(rel));
    s = await call("bot_status", {});
    assert.equal(s.body, "walker", `release must return to the walker: ${JSON.stringify(s)}`);
    await cmd(`kill @e[type=minecraft:zombie,x=${X - 16},y=${Y},z=${Z - 8},dx=48,dy=12,dz=128]`).catch(() => {});
  });

  test("cleanup", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "despawn" }).catch(() => {});
    await cmd(`forceload remove ${X - 32} ${Z - 32} ${X + 32} ${Z + 128}`);
  });
});
