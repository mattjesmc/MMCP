// Live probes for bot_tunnel (W2_56123_FIXES.md §10-11) — the corridor verb, and the staircase
// that is a body's route home. Session w2-56123 spent 347 bot_mine + 187 bot_target calls
// hand-cranking tunnels, and then ended stranded at y=16 because ascending 50 blocks through stone
// has no goal-shaped form: `pillar_blocked` 28 times, `no_progress` 30, and no route out.
//
// Staged at a probe-owned coordinate (3.90M). Own session. Run with `npm run test:live`.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const X = 3_900_000, Z = 3_900_000, Y = 80;
const SESSION = "probe-tunnel";

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

/** A solid stone block with a 1x2 pocket at its west face — the body starts sealed in rock. */
async function stageMassif(topY) {
  await cmd(`fill ${X - 4} ${Y - 2} ${Z - 4} ${X + 40} ${topY} ${Z + 4} minecraft:stone`);
  await cmd(`fill ${X - 4} ${topY + 1} ${Z - 4} ${X + 40} ${topY + 6} ${Z + 4} minecraft:air`);
  await cmd(`fill ${X} ${Y + 1} ${Z} ${X} ${Y + 2} ${Z} minecraft:air`);
  await sleep(400);
  await call("bot_body", { action: "spawn", type: "player", pos: { x: X, y: Y + 1, z: Z } });
  await call("bot_reactions", { action: "clear" });
  await call("bot_give", { item: "minecraft:iron_pickaxe", count: 1 });
  await call("bot_select", { item: "minecraft:iron_pickaxe" });
}

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok).catch(() => false);
if (!bridgeUp) console.log(`\n  [skip] no bridge at ${BASE} — start the dev server\n`);

describe("bot_tunnel: corridors, staircases home, and honest stops", { skip: !bridgeUp }, () => {
  test("stage the site", async (t) => {
    if (!bridgeUp) return t.skip();
    await cmd(`forceload add ${X - 32} ${Z - 32} ${X + 64} ${Z + 32}`);
    await sleep(1500);
  });

  test("ONE call digs a corridor and walks it", async (t) => {
    if (!bridgeUp) return t.skip();
    await stageMassif(Y + 20);
    const r = await call("bot_tunnel", { direction: "east", length: 8, height: 2, wait: true });
    assert.equal(r.outcome, "achieved", JSON.stringify(r));

    const st = await call("bot_status", {});
    assert.ok(st.pos.x >= X + 7, `the body walked its own tunnel (x=${st.pos.x}, from ${X})`);
    // The corridor exists in the world, not just in the reply. `clear` asks the question directly:
    // every cell of the passage must be open.
    const cells = await call("get_blocks_at", {
      blocks: [
        { x: X + 3, y: Y + 1, z: Z, clear: true }, { x: X + 3, y: Y + 2, z: Z, clear: true },
        { x: X + 7, y: Y + 1, z: Z, clear: true }, { x: X + 7, y: Y + 2, z: Z, clear: true },
      ],
    });
    assert.equal(cells.check?.all_matched, true,
      `every corridor cell is open: ${JSON.stringify(cells)}`);
    assert.ok((r.ledger?.mined ?? []).length >= 8,
      `the ledger names every cell mined — that is what makes a partial tunnel resumable`);
  });

  test("THE ROUTE HOME: a staircase climbs out of a sealed shaft to open sky", async (t) => {
    if (!bridgeUp) return t.skip();
    const topY = Y + 24;
    await stageMassif(topY);
    const r = await call("bot_tunnel", {
      direction: "east", slope: "up", length: 40, until_sky: true, wait: true,
    });
    assert.equal(r.outcome, "achieved", `the ascent that pillaring could not do: ${JSON.stringify(r)}`);
    const st = await call("bot_status", {});
    // Feet stand IN the top layer's own cell — the staircase mined it — with the head and the sky
    // above. That is out: from here the body can walk away, which is the whole point.
    assert.ok(st.pos.y >= topY, `the body climbed to the top (y=${st.pos.y} vs top ${topY})`);
    assert.ok(st.sees_sky !== false, `and it is under open sky: ${JSON.stringify(st.sees_sky)}`);
    assert.ok(st.pos.y - (Y + 1) >= 20, `it really is a 20+ block ascent (from y=${Y + 1})`);
  });

  test("a tunnel that reaches water STOPS and says so — it never digs the fluid", async (t) => {
    if (!bridgeUp) return t.skip();
    await stageMassif(Y + 20);
    // Water four blocks along the dig line, at head height so the corridor must meet it.
    await cmd(`setblock ${X + 4} ${Y + 2} ${Z} minecraft:water`);
    await sleep(400);
    const r = await call("bot_tunnel", { direction: "east", length: 12, wait: true });
    assert.equal(r.outcome, "stopped", JSON.stringify(r));
    assert.equal(r.reason, "fluid_ahead");
    assert.ok((r.ledger?.mined ?? []).length > 0,
      "the work already done is still disclosed — the tunnel resumes, it does not restart");
  });

  test("`direction: up` is refused with the verb that actually climbs", async (t) => {
    if (!bridgeUp) return t.skip();
    const res = await fetch(`${BASE}/cmd`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-MCPTK-Session": SESSION },
      body: JSON.stringify({ tool: "bot_tunnel", args: { direction: "up", length: 4 } }),
    });
    const j = await res.json();
    assert.equal(j.ok, false);
    assert.match(String(j.error), /slope/, `it points at the staircase: ${j.error}`);
  });
});
