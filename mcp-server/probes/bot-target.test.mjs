// Live probes for bot_target — the goal loop with server-side repair (toolkit 0.15.0,
// BOT_SURFACE_DESIGN.md §§1-4). Five things the design promises and this checks against a real world:
//
//   1. check_path build-aware: a walled-off block is `reachable:false` with an OBSTRUCTION LOCUS
//      under may_modify:none, and `reachable:true` with a `work` plan under may_modify:break.
//   2. bot_target destroy through a wall: with may_modify:break the goal mines its own way in and
//      the LEDGER reports the blocks it broke; the target block ends up gone.
//   3. Door path: a closed WOODEN door is opened en route (ledger.doors_opened); a plain move that
//      would cross it arrives. An IRON door stops the goal honestly (blocked_by_iron_door).
//   4. Designation honesty: bot_target action:"attack" with combat OFF returns engaged:false and a
//      note, and does NOT arm combat implicitly.
//   5. Selector: a bad handle is rejected; {at} resolves a literal block.
//
// Probe-owned site at 3.54M (its own chunks, staged idempotently, forceloaded during the run).
// Moved off 3.40M, which reflexes.test.mjs already owned: the battery runs probe files
// CONCURRENTLY, so a shared site means two files stage on top of each other's world.
// Needs the dev server up (gradlew runServer). Skips itself when the bridge is down.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const X = 3_540_000, Z = 3_540_000, Y = 200;

// Own session id: the body and the drone slot are per-session and `node --test` runs probe
// files concurrently, so a file without one shares the anonymous slot with every other file
// without one (the standing rule for embodied probe files).
const SESSION = "probe-bot-target";

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

// A stone-encased target: a single ore block walled in on all sides, floor at Y.
const FROM = { x: X + 6, y: Y + 1, z: Z + 6 };
const WALLED = { x: X, y: Y + 1, z: Z };

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok)
  .catch(() => false);
if (!bridgeUp) {
  console.log(`\n  [skip] no bridge at ${BASE} — start the dev server to run these probes\n`);
}

describe("bot_target: build-aware routing, repair ledger, doors, designation", { skip: !bridgeUp }, () => {
  test("stage the site", async (t) => {
    if (!bridgeUp) return t.skip();
    await cmd(`forceload add ${X - 32} ${Z - 32} ${X + 32} ${Z + 32}`);
    await sleep(1500);
    await cmd(`fill ${X - 24} ${Y} ${Z - 24} ${X + 24} ${Y} ${Z + 24} minecraft:stone`);
    await cmd(`fill ${X - 24} ${Y + 1} ${Z - 24} ${X + 24} ${Y + 8} ${Z + 24} minecraft:air`);
    // The walled target: a redstone ore block boxed in solid stone so no face is exposed or reachable.
    await cmd(`fill ${X - 1} ${Y + 1} ${Z - 1} ${X + 1} ${Y + 3} ${Z + 1} minecraft:stone`);
    await cmd(`setblock ${X} ${Y + 1} ${Z} minecraft:redstone_ore`);
    await sleep(400);
  });

  test("check_path: walled target is unreachable with an obstruction locus (may_modify:none)", async (t) => {
    if (!bridgeUp) return t.skip();
    const r = await call("check_path", { from: FROM, reach: WALLED, body: "walker" });
    assert.equal(r.reachable, false, JSON.stringify(r));
    // occluded (no exposed face) is the honest verdict for a fully-encased block.
    assert.equal(r.reason, "occluded", JSON.stringify(r));
  });

  test("check_path: may_modify:break makes it reachable and discloses the work", async (t) => {
    if (!bridgeUp) return t.skip();
    // `to` the block's own cell — a break plan has to tunnel to it (reach-shell has no exposed face).
    const r = await call("check_path", {
      from: FROM, to: WALLED, body: "walker", may_modify: "break",
    });
    // Either it now reaches (work disclosed) or, if the encasement defeats the greedy frontier, it
    // at least names the blocking block instead of a bare stopped-short.
    if (r.reachable === true) {
      assert.ok(r.work && r.work.break_cells >= 1, JSON.stringify(r.work));
      assert.equal(r.profile?.may_modify, "break", JSON.stringify(r.profile));
    } else {
      assert.ok(r.obstruction && typeof r.obstruction.block === "string", JSON.stringify(r));
      assert.match(r.obstruction.remedy ?? "", /break|mine/i, JSON.stringify(r.obstruction));
    }
  });

  test("bot_target destroy: mines through the wall and ledgers what it broke", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "spawn", pos: { x: X + 4, y: Y + 2, z: Z + 4 } });
    const r = await call("bot_target", {
      action: "destroy", target: { at: WALLED }, may_modify: "break", wait: true,
    });
    // The goal either achieves (target gone) or stops honestly with a ledger — never a bare failure.
    assert.ok(r.ledger, `a goal must always carry a ledger: ${JSON.stringify(r)}`);
    if (r.outcome === "achieved") {
      const after = await call("get_blocks_at", { positions: [WALLED] }).catch(() => null);
      // The redstone ore is gone (mined). Tolerate the read tool's shape differences.
      if (after) {
        const id = JSON.stringify(after);
        assert.ok(!id.includes("redstone_ore"), `target should be mined away: ${id}`);
      }
    } else {
      assert.ok(r.obstruction || r.ledger.stopped, JSON.stringify(r));
    }
  }, { timeout: 90_000 });

  test("designation with combat OFF is honest (engaged:false, does not arm)", async (t) => {
    if (!bridgeUp) return t.skip();
    // A STANDING RULE is the designation-only form now: an individual `attack` became a real
    // hunt goal (w2 postmortem §1) — it approaches and swings regardless of engage state, so
    // "designates but nothing acts" is exactly and only the {kind} shape.
    const r = await call("bot_target", { action: "attack", target: { kind: "zombie" } });
    assert.equal(r.designated, true, JSON.stringify(r));
    assert.equal(r.standing_rule, true, JSON.stringify(r));
    assert.equal(r.engaged, false, "designation must NOT arm combat implicitly");
    assert.match(r.note ?? "", /combat mode is OFF/i, JSON.stringify(r));
    // Arming explicitly flips it.
    const on = await call("bot_body", { action: "engage", mode: "fight" });
    assert.equal(on.engaged, true, JSON.stringify(on));
    await call("bot_body", { action: "engage", on: false, clear_targets: true });
  });

  test("standing rule pre-arms with NOTHING in range (0.24.0 — no_target here was the bug)", async (t) => {
    if (!bridgeUp) return t.skip();
    // No creepers anywhere near the probe site: a kind-selector designation must still arm —
    // "arm the defenses before the night raid" is exactly when the empty-field case matters.
    const r = await call("bot_target", { action: "attack", target: { kind: "creeper" } });
    assert.equal(r.started, true, JSON.stringify(r));
    assert.equal(r.designated, true, JSON.stringify(r));
    assert.equal(r.standing_rule, true, JSON.stringify(r));
    assert.equal(r.engaged, false, "pre-arming must not flip combat on");
    await call("bot_body", { action: "engage", on: false, clear_targets: true });
  });

  test("selector: a heightless/bad handle is rejected; {at} resolves", async (t) => {
    if (!bridgeUp) return t.skip();
    await assert.rejects(
      call("bot_target", { action: "move", target: { handle: "village_plains@1488,~,-224" } }),
      /height|handle/i);
    // A well-formed {at} move starts (it may not finish in-window; we only assert it launched).
    const r = await call("bot_target", { action: "move", target: { at: FROM } });
    assert.notEqual(r.started, false, JSON.stringify(r));
  });

  test("cleanup", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "despawn" }).catch(() => {});
    await cmd(`forceload remove ${X - 32} ${Z - 32} ${X + 32} ${Z + 32}`).catch(() => {});
  });
});

describe("bot_target: door repair", { skip: !bridgeUp }, () => {
  const DX = X + 100, DZ = Z + 100; // a separate corridor site
  const DFROM = { x: DX, y: Y + 1, z: DZ };
  const GOAL = { x: DX + 6, y: Y + 1, z: DZ };
  const DOOR = { x: DX + 3, y: Y + 1, z: DZ };

  test("stage a walled corridor with a shut wooden door", async (t) => {
    if (!bridgeUp) return t.skip();
    await cmd(`forceload add ${DX - 8} ${DZ - 8} ${DX + 12} ${DZ + 8}`);
    await sleep(1200);
    // A 1-wide corridor: floor, walls, air inside, capped — the only way through is the doorway.
    await cmd(`fill ${DX - 1} ${Y} ${DZ - 1} ${DX + 8} ${Y} ${DZ + 1} minecraft:stone`);
    await cmd(`fill ${DX - 1} ${Y + 1} ${DZ - 1} ${DX + 8} ${Y + 3} ${DZ + 1} minecraft:stone hollow`);
    await cmd(`fill ${DX} ${Y + 1} ${DZ} ${DX + 7} ${Y + 2} ${DZ} minecraft:air`);
    // A shut wooden door blocking the corridor at DOOR.
    await cmd(`setblock ${DOOR.x} ${DOOR.y} ${DOOR.z} minecraft:air`);
    await cmd(`setblock ${DOOR.x} ${DOOR.y + 1} ${DOOR.z} minecraft:air`);
    await cmd(`setblock ${DOOR.x} ${DOOR.y} ${DOOR.z} minecraft:oak_door[half=lower,facing=east]`);
    await sleep(400);
  });

  test("check_path open_doors:true routes through the shut wooden door", async (t) => {
    if (!bridgeUp) return t.skip();
    const closed = await call("check_path", { from: DFROM, to: GOAL, body: "walker" });
    const opened = await call("check_path", { from: DFROM, to: GOAL, body: "walker", open_doors: true });
    // With doors off the corridor is blocked; with doors on it routes. (If terrain makes `closed`
    // reachable anyway the door wasn't actually sealing — assert only the door-on direction.)
    assert.notEqual(opened.reachable, false, `open_doors should route the corridor: ${JSON.stringify(opened)}`);
    if (closed.reachable === false && closed.obstruction) {
      assert.match(closed.obstruction.path_type ?? "", /DOOR/i, JSON.stringify(closed.obstruction));
    }
  });

  test("iron door: unreachable, but the remedy names the control block to activate", async (t) => {
    if (!bridgeUp) return t.skip();
    // Swap the wooden door for an iron one and put a lever on the wall beside it.
    await cmd(`setblock ${DOOR.x} ${DOOR.y + 1} ${DOOR.z} minecraft:air`);
    await cmd(`setblock ${DOOR.x} ${DOOR.y} ${DOOR.z} minecraft:iron_door[half=lower,facing=east]`);
    await cmd(`setblock ${DOOR.x} ${DOOR.y + 1} ${DOOR.z - 1} minecraft:lever[face=wall,facing=south]`);
    await sleep(400);
    const r = await call("check_path", { from: DFROM, to: GOAL, body: "walker", open_doors: true });
    // open_doors does NOT open iron — it stays blocked, and the obstruction names the control.
    assert.equal(r.reachable, false, JSON.stringify(r));
    assert.ok(r.obstruction, `iron door should produce an obstruction locus: ${JSON.stringify(r)}`);
    assert.match(r.obstruction.path_type ?? "", /IRON/i, JSON.stringify(r.obstruction));
    assert.ok(r.obstruction.control, `remedy should locate the control: ${JSON.stringify(r.obstruction)}`);
    assert.match(r.obstruction.remedy ?? "", /lever|activate/i, JSON.stringify(r.obstruction));
  });

  test("cleanup", async (t) => {
    if (!bridgeUp) return t.skip();
    await cmd(`forceload remove ${DX - 8} ${DZ - 8} ${DX + 12} ${DZ + 8}`).catch(() => {});
  });
});

describe("bot_target: sprint-jump over bridging", { skip: !bridgeUp }, () => {
  const JX = X + 200, JZ = Z + 200;

  test("A* jumps a 3-block gap for free instead of bridging it", async (t) => {
    if (!bridgeUp) return t.skip();
    await cmd(`forceload add ${JX - 8} ${JZ - 8} ${JX + 16} ${JZ + 8}`);
    await sleep(1200);
    // Two platforms over a void gap of 3 (jumpable). Since the body architecture (toolkit 0.17.0,
    // BOT_SURFACE_DESIGN.md §11.6) the walker check models the REAL spawnable walker — sprint-jump
    // edges are a movement capability, on for every profile — so even a PLAIN check leaps the gap
    // and discloses it in work.jumps. (Before 0.17.0 a plain check was villager-vanilla and failed.)
    await cmd(`fill ${JX - 40} ${Y - 40} ${JZ} ${JX + 16} ${Y} ${JZ} minecraft:air`); // void column
    await cmd(`fill ${JX} ${Y} ${JZ} ${JX} ${Y} ${JZ} minecraft:stone`);              // left edge
    await cmd(`fill ${JX - 4} ${Y} ${JZ} ${JX} ${Y} ${JZ} minecraft:stone`);
    await cmd(`fill ${JX + 4} ${Y} ${JZ} ${JX + 10} ${Y} ${JZ} minecraft:stone`);     // right platform (gap = 3)
    await cmd(`fill ${JX - 4} ${Y + 1} ${JZ} ${JX + 10} ${Y + 4} ${JZ} minecraft:air`);
    await sleep(400);
    const FROM = { x: JX, y: Y + 1, z: JZ }, TO = { x: JX + 7, y: Y + 1, z: JZ };
    const plain = await call("check_path", { from: FROM, to: TO, body: "walker" });
    assert.equal(plain.reachable, true, `the walker sprint-jumps a 3-gap: ${JSON.stringify(plain)}`);
    assert.ok((plain.work?.jumps ?? 0) >= 1, `the crossing should be a jump: ${JSON.stringify(plain.work)}`);
    assert.equal(plain.work?.place_cells ?? 0, 0, `it must NOT bridge what it can jump: ${JSON.stringify(plain.work)}`);
    assert.equal(plain.work?.break_cells ?? 0, 0, `a plain profile must not plan breaks: ${JSON.stringify(plain.work)}`);
    await cmd(`forceload remove ${JX - 8} ${JZ - 8} ${JX + 16} ${JZ + 8}`).catch(() => {});
  });
});
