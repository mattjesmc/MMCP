// Live probes for `bot_tunnel slope:"down"` (W1_42257_FIXES.md F1+F2) — the descending staircase
// that was geometrically unwalkable. A height-2 descending step must also open the LANDING
// column's lip cell (at.above(2)): the head sweeps through it before the body drops, and without
// it the tunnel digs a staircase its own body cannot walk (w1_42257 g-49: descended ONE step, then
// ~23 identical did_not_start walk legs flooded the stream and the goal died with an EMPTY
// verdict). F2: a refused walk leg now ends the tunnel honestly — one retry, then `walk_refused`
// with a diagnostic that names the refused target. An empty terminal verdict is impossible.
//
// Staged at a probe-owned coordinate (4.05M). Own session. Run with `npm run test:live`.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const X = 4_050_000, Z = 4_050_000, Y = 80;
const SESSION = "probe-tunnel-descend";

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
// The dev server accumulates wandering hostiles between battery runs (an overnight zombie slew
// probe_tunnel_des mid-dig, 2026-08-09). The site is probe-owned: any non-player entity standing
// here at stage time is world debris, not fixture. Fake-player bodies are real ServerPlayers, so
// type=!player spares them.
const sweepSite = () =>
  cmd(`kill @e[type=!minecraft:player,x=${X - 30},y=${Y - 24},z=${Z - 30},dx=100,dy=54,dz=60]`)
    .catch(() => {});
// A TRUE now-cursor: drain the unread backlog first. `get_events {limit:1}` returns the cursor
// after the oldest unread event, so with backlog the "window since" would include stale events
// from earlier tests (live-caught: the trench test's own honest walk_refused pair false-failed
// the flood bound of the NEXT run's first test).
async function nowCursor() {
  let cursor;
  for (;;) {
    const r = await call("get_events", cursor ? { cursor, limit: 200 } : { limit: 200 });
    cursor = r.cursor;
    if (!r.more && (r.events || []).length < 200) return cursor;
  }
}

/** Count `action_completed` events with a given outcome since `cursor`. */
async function completions(cursor, outcome) {
  const r = await call("get_events", { cursor, type: "action_completed", limit: 200 });
  return (r.events || []).filter((e) => e.data?.outcome === outcome).length;
}

/** Flat solid ground with open sky: the body stands ON the surface and digs down into it. */
async function stageSurface() {
  await cmd(`fill ${X - 4} ${Y - 20} ${Z - 4} ${X + 40} ${Y} ${Z + 4} minecraft:stone`);
  await cmd(`fill ${X - 4} ${Y + 1} ${Z - 4} ${X + 40} ${Y + 8} ${Z + 4} minecraft:air`);
  await sweepSite();
  await sleep(400);
  await call("bot_body", { action: "spawn", type: "player", pos: { x: X, y: Y + 1, z: Z } });
  await call("bot_reactions", { action: "clear" });
  await call("bot_give", { item: "minecraft:iron_pickaxe", count: 1 });
  await call("bot_select", { item: "minecraft:iron_pickaxe" });
}

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok).catch(() => false);
if (!bridgeUp) console.log(`\n  [skip] no bridge at ${BASE} — start the dev server\n`);

describe("bot_tunnel slope:down — a staircase the digger can walk", { skip: !bridgeUp }, () => {
  test("stage the site", async (t) => {
    if (!bridgeUp) return t.skip();
    await cmd(`forceload add ${X - 32} ${Z - 32} ${X + 64} ${Z + 32}`);
    await sleep(1500);
  });

  test("height 2: the body DESCENDS its own staircase, lips dug", async (t) => {
    if (!bridgeUp) return t.skip();
    await stageSurface();
    const cursor = await nowCursor();
    const r = await call("bot_tunnel", {
      direction: "east", slope: "down", length: 8, height: 2, wait: true,
    });
    assert.equal(r.outcome, "achieved", JSON.stringify(r));

    // The goal completes on HORIZONTAL advance, one tick before the body finishes dropping into
    // the last step — read the feet cell after the body settles, not a mid-fall double.
    await sleep(600);
    const st = await call("bot_status", {});
    assert.ok(Math.floor(st.pos.y) <= Y + 1 - 8,
      `feet reached start−8 (y=${st.pos.y}, started at ${Y + 1})`);
    assert.ok(st.pos.x >= X + 7, `and advanced the full length (x=${st.pos.x}, from ${X})`);

    // The lip cells exist in the WORLD, not just in the ledger. Step s lands at
    // (X+s, Y+1−s); its lip is two above the landing feet — the cell that used to be the
    // previous step's floor-level rock, the one no pre-fix tunnel ever dug.
    const lips = [3, 5, 7].map((s) => ({ x: X + s, y: Y + 3 - s, z: Z, clear: true }));
    const cells = await call("get_blocks_at", { blocks: lips });
    assert.equal(cells.check?.all_matched, true,
      `every landing lip is open: ${JSON.stringify(cells)}`);

    // F2's stream bound: no 2-tick did_not_start flood (g-49 emitted ~23 identical pairs).
    assert.ok((await completions(cursor, "did_not_start")) <= 3,
      "at most 3 did_not_start completions in the whole goal");
  });

  test("height 3: still achieved (the taller column already contains the lip)", async (t) => {
    if (!bridgeUp) return t.skip();
    await stageSurface();
    const r = await call("bot_tunnel", {
      direction: "east", slope: "down", length: 8, height: 3, wait: true,
    });
    assert.equal(r.outcome, "achieved", JSON.stringify(r));
    await sleep(600);
    const st = await call("bot_status", {});
    assert.ok(Math.floor(st.pos.y) <= Y + 1 - 8, `feet reached start−8 (y=${st.pos.y})`);
  });

  test("RESUME: re-running over the already-open stair walks it (the g-50 case)", async (t) => {
    if (!bridgeUp) return t.skip();
    await stageSurface();
    const first = await call("bot_tunnel", {
      direction: "east", slope: "down", length: 8, height: 2, wait: true,
    });
    assert.equal(first.outcome, "achieved", JSON.stringify(first));

    // Body back to the start; the stair below is now open. `want` is re-derived from the body's
    // real position each tick, so the re-run must WALK the stair down — never spin, never end
    // no_progress with an empty verdict.
    await call("bot_body", { action: "spawn", type: "player", pos: { x: X, y: Y + 1, z: Z } });
    await call("bot_reactions", { action: "clear" });
    await call("bot_give", { item: "minecraft:iron_pickaxe", count: 1 });
    await call("bot_select", { item: "minecraft:iron_pickaxe" });
    const cursor = await nowCursor();
    const again = await call("bot_tunnel", {
      direction: "east", slope: "down", length: 8, height: 2, wait: true,
    });
    assert.equal(again.outcome, "achieved", JSON.stringify(again));
    assert.notEqual(again.reason, "walk_refused", "walk_refused never fires on a walkable stair");
    await sleep(600);
    const st = await call("bot_status", {});
    assert.ok(Math.floor(st.pos.y) <= Y + 1 - 8, `the re-run descended too (y=${st.pos.y})`);
    assert.ok((await completions(cursor, "did_not_start")) <= 3,
      "the resume run does not spam did_not_start either");
  });

  test("a genuinely unwalkable corridor ends HONESTLY: named diagnostic, no empty verdict",
      async (t) => {
    if (!bridgeUp) return t.skip();
    // Seal the body in a pocket, pre-open a flat corridor east — then cut a 3-wide, 3-deep
    // trench through its floor. Every corridor cell is air (nothing to dig), so the old code
    // ended with obstructionAt(walkTo)=null: reason and locus both empty. Now the verdict names
    // the refused walk.
    await cmd(`fill ${X - 4} ${Y - 20} ${Z - 4} ${X + 40} ${Y + 20} ${Z + 4} minecraft:stone`);
    await cmd(`fill ${X - 4} ${Y + 21} ${Z - 4} ${X + 40} ${Y + 26} ${Z + 4} minecraft:air`);
    await cmd(`fill ${X} ${Y + 1} ${Z} ${X} ${Y + 2} ${Z} minecraft:air`);
    await cmd(`fill ${X + 1} ${Y + 1} ${Z} ${X + 6} ${Y + 2} ${Z} minecraft:air`);
    await cmd(`fill ${X + 2} ${Y - 2} ${Z} ${X + 4} ${Y} ${Z} minecraft:air`);
    await sweepSite();
    await sleep(400);
    await call("bot_body", { action: "spawn", type: "player", pos: { x: X, y: Y + 1, z: Z } });
    await call("bot_reactions", { action: "clear" });
    await call("bot_give", { item: "minecraft:iron_pickaxe", count: 1 });
    await call("bot_select", { item: "minecraft:iron_pickaxe" });

    const r = await call("bot_tunnel", { direction: "east", length: 6, wait: true });
    assert.equal(r.outcome, "stopped", JSON.stringify(r));
    assert.ok(r.reason, `the stop names a reason: ${JSON.stringify(r)}`);
    assert.ok(r.obstruction,
      `an empty terminal verdict is impossible for tunnels: ${JSON.stringify(r)}`);
    // Either the world offers a real obstruction to blame, or the diagnostic names the walk the
    // follower refused — with its target, so the agent knows WHERE the geometry broke.
    if (r.obstruction.kind === "walk_refused") {
      assert.ok(r.obstruction.to, "the refused walk names its target");
      assert.match(String(r.obstruction.note ?? ""), /no walkable route/);
    }
  });
});
