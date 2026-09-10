// Live probes for the ATTACK APPROACH over terrain (W1_42257_FIXES.md F6, findings R8/Episode D).
// A human watched g-43's chicken hunt run straight at the bird: pressing into a 1-up ledge without
// jumping, pressing into a tree, and wading chest-deep through a pond until the drown net fired
// INSIDE the goal. The confirmed fix: hunts default DRY (swim:false) — a target across water ends
// `target_unreachable` naming the fluid, and swim:true is an informed opt-in. The ledge/tree cases
// carry the new instrument: `stalled_legs` on the attack verdict counts approach legs that ended
// wedged (the follower's node timeout — 5 seconds of wall-pressing per leg). H1/H2 driver changes
// are GATED on what this probe shows.
//
// Staged at a probe-owned coordinate (4.15M). Own session. Run with `npm run test:live`.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const X = 4_150_000, Z = 4_150_000, Y = 90;
const SESSION = "probe-attack-terrain";
const ORIGIN = { x: X, y: Y + 1, z: Z };

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
// the OLDEST unread event, so a window opened on it would include stale events from earlier tests
// (a staging entombment's body_endangered must not read as the hunt getting wet).
async function nowCursor() {
  let cursor;
  for (;;) {
    const r = await call("get_events", cursor ? { cursor, limit: 200 } : { limit: 200 });
    cursor = r.cursor;
    if (!r.more && (r.events || []).length < 200) return cursor;
  }
}

async function chicken() {
  const r = await call("get_entities", { origin: ORIGIN, radius: 32 });
  return (r.entities || []).find((e) => e.type === "minecraft:chicken");
}
const killChickens = () => cmd(`kill @e[type=minecraft:chicken,x=${X - 40},y=${Y - 8},z=${Z - 40},dx=80,dy=30,dz=80]`).catch(() => {});

/** Flat penned arena: stone floor (thick — the pond dug into it must keep a solid BOTTOM, or
 *  the "pond" is a curtain of water over a void and no footing test can pass), low walls so
 *  nothing wanders, everything above open. */
async function stageArena() {
  await killChickens();
  await cmd(`fill ${X - 12} ${Y - 4} ${Z - 12} ${X + 16} ${Y} ${Z + 12} minecraft:stone`);
  await cmd(`fill ${X - 12} ${Y + 1} ${Z - 12} ${X + 16} ${Y + 8} ${Z + 12} minecraft:air`);
  await sleep(400);
  await call("bot_body", { action: "spawn", type: "player", pos: ORIGIN });
  await call("bot_reactions", { action: "clear" });
  await call("bot_give", { item: "minecraft:iron_sword", count: 1 });
  await call("bot_select", { item: "iron_sword" });
}

async function hunt(extra = {}) {
  const target = await chicken();
  assert.ok(target, "staged chicken present");
  return call("bot_target", {
    action: "attack", target: { entity: target.id },
    attack_timeout_ticks: 600, wait: true, ...extra,
  });
}

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok).catch(() => false);
if (!bridgeUp) console.log(`\n  [skip] no bridge at ${BASE} — start the dev server\n`);

describe("attack over terrain: ledge, trees, and the dry-hunt default", { skip: !bridgeUp }, () => {
  test("stage the site", async (t) => {
    if (!bridgeUp) return t.skip();
    await cmd(`forceload add ${X - 32} ${Z - 32} ${X + 32} ${Z + 32}`);
    await sleep(1500);
  });

  test("LEDGE: a diagonal 1-up step is climbed, not pressed into (H1's shape)", async (t) => {
    if (!bridgeUp) return t.skip();
    await stageArena();
    // The east half is one block higher; the target sits diagonally up-and-over, so the approach
    // must take a step-up on a diagonal — exactly where the jump gate's flat-distance test
    // (flatSq < max(1.0, bbWidth)) can fail to fire while the body grinds the ledge face.
    await cmd(`fill ${X + 5} ${Y + 1} ${Z - 12} ${X + 16} ${Y + 1} ${Z + 12} minecraft:stone`);
    await cmd(`summon minecraft:chicken ${X + 10} ${Y + 2} ${Z + 5} {NoAI:1b,PersistenceRequired:1b}`);
    await sleep(500);
    const r = await hunt();
    assert.equal(r.outcome, "achieved", `the hunt crosses the ledge: ${JSON.stringify(r)}`);
    assert.equal(r.stalled_legs, 0,
      `no approach leg may die in a node timeout against the ledge face: ${JSON.stringify(r)}`);
    await killChickens();
  });

  test("TREE LINE: trunks with gaps are routed through, not pressed against (H2's shape)", async (t) => {
    if (!bridgeUp) return t.skip();
    await stageArena();
    // A line of 2-high trunks across the approach, 1-wide gaps between them: a fresh partial
    // path per target drift used to end each leg at the obstacle face nearest the bird.
    for (let z = -11; z <= 11; z += 2) {
      await cmd(`fill ${X + 6} ${Y + 1} ${Z + z} ${X + 6} ${Y + 2} ${Z + z} minecraft:oak_log`);
    }
    await cmd(`summon minecraft:chicken ${X + 11} ${Y + 1} ${Z + 3} {NoAI:1b,PersistenceRequired:1b}`);
    await sleep(500);
    const r = await hunt();
    assert.equal(r.outcome, "achieved", `the hunt threads the gaps: ${JSON.stringify(r)}`);
    assert.equal(r.stalled_legs, 0,
      `no leg may end wedged against a trunk: ${JSON.stringify(r)}`);
    await killChickens();
  });

  test("POND, default profile: the hunt stays DRY and concedes target_unreachable naming water",
      async (t) => {
    if (!bridgeUp) return t.skip();
    await stageArena();
    // A penned corridor with a 6-wide, 2-deep pond across it — no dry route exists, and 6 is
    // past the sprint-jump gap (5), or the hunt legitimately JUMPS the water and stays dry
    // (live-caught on the first run: a 3-wide pond was cleared in one leap, achieved, dry — the
    // right behavior, the wrong fixture). g-43 waded this and tripped the drown net mid-goal;
    // the dry default must concede instead, with the fluid vocabulary, and the drown net must
    // have NOTHING to do.
    await cmd(`fill ${X - 4} ${Y + 2} ${Z - 4} ${X + 14} ${Y + 4} ${Z - 4} minecraft:stone`);
    await cmd(`fill ${X - 4} ${Y + 2} ${Z + 4} ${X + 14} ${Y + 4} ${Z + 4} minecraft:stone`);
    await cmd(`fill ${X - 4} ${Y + 2} ${Z - 4} ${X - 4} ${Y + 4} ${Z + 4} minecraft:stone`);
    await cmd(`fill ${X + 14} ${Y + 2} ${Z - 4} ${X + 14} ${Y + 4} ${Z + 4} minecraft:stone`);
    await cmd(`fill ${X + 5} ${Y - 1} ${Z - 3} ${X + 10} ${Y} ${Z + 3} minecraft:water`);
    await cmd(`summon minecraft:chicken ${X + 12} ${Y + 1} ${Z} {NoAI:1b,PersistenceRequired:1b}`);
    await sleep(500);
    const cursor = await nowCursor();
    const r = await hunt();
    assert.equal(r.outcome, "stopped", JSON.stringify(r));
    assert.equal(r.reason, "target_unreachable",
      `a dry hunt concedes the wet route: ${JSON.stringify(r)}`);
    assert.match(JSON.stringify(r.obstruction ?? {}), /water/,
      `and the concession names the fluid: ${JSON.stringify(r.obstruction)}`);
    const ev = await call("get_events", { cursor, type: "body_endangered", limit: 50 });
    assert.ok(!(ev.events || []).some((e) => e.data?.cause === "air_low"),
      "the drown net never had to fire — that is the whole point of the dry default");
    await killChickens();
  });

  test("POND, swim:true: the informed opt-in wades in and finishes the hunt", async (t) => {
    if (!bridgeUp) return t.skip();
    // Same pond as above (still staged); the explicit right restores the old behavior.
    await call("bot_body", { action: "spawn", type: "player", pos: ORIGIN });
    await call("bot_give", { item: "minecraft:iron_sword", count: 1 });
    await call("bot_select", { item: "iron_sword" });
    await cmd(`summon minecraft:chicken ${X + 12} ${Y + 1} ${Z} {NoAI:1b,PersistenceRequired:1b}`);
    await sleep(500);
    const r = await hunt({ swim: true });
    assert.equal(r.outcome, "achieved",
      `swim:true crosses the pond and lands the kill: ${JSON.stringify(r)}`);
    await killChickens();
  });
});
