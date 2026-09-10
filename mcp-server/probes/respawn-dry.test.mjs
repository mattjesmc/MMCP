// Live probes for SPAWN/RESPAWN SAFETY in water — PERCEPTION_NAV_FIXES.md §5.
//
// `a87c11eb` 13:17:30: respawn placed the body at (60.75, 61, 7.3) inside a flooded cave —
// `submerged:true`, inventory empty, air draining — and it drowned without ever moving. The spawn
// safety predicate had refused LAVA in the feet/head/floor cells since it was written, and never
// water, so "safe" meant "not burning" and said nothing about breathing.
//
// The rule under test is deliberately narrow: the HEAD cell must not be water. Feet in shallow water
// is wading — ordinary at any shoreline, survivable, and refusing it would change what an explicit
// `pos` means for a caller who knows exactly where they want to stand. Head under water is drowning,
// and nobody ever wants to start there.
//
// Staged at a probe-owned coordinate (4.0M). Own session. `npm run test:live`.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const X = 4_000_000, Z = 4_000_000, Y = 200;
const SESSION = "probe-respawn-dry";

async function call(tool, args = {}) {
  const res = await fetch(`${BASE}/cmd`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-MCPTK-Session": SESSION },
    body: JSON.stringify({ tool, args }),
  });
  return res.json();
}
async function must(tool, args = {}) {
  const j = await call(tool, args);
  if (!j.ok) throw new Error(`${tool} failed: ${JSON.stringify(j.error)}`);
  return j.result;
}
const cmd = (c) => must("run_command", { command: c });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** /fill that fails loudly: run_command answers ok:true for rejected commands, and /fill caps at 32768. */
async function fill(spec) {
  const r = await cmd(`fill ${spec}`);
  const out = (r.output ?? []).join(" ");
  if (!out || /Too many blocks|not loaded|Invalid|Expected|Unknown|Incorrect/i.test(out)) {
    throw new Error(`staging fill did NOT run: "fill ${spec}" -> ${out || "(no output)"}`);
  }
  return r;
}

let bridgeUp = true;
try {
  await must("ping");
} catch {
  bridgeUp = false;
}

const submerged = async () => {
  const st = await must("bot_status");
  return { pos: st.pos, inWater: st.inWater === true, air: st.air ?? 300 };
};

describe("spawn safety (§5): a body must not start underwater", { skip: !bridgeUp }, () => {
  test("stage a flooded pocket with dry ground above it", async (t) => {
    if (!bridgeUp) return t.skip();
    await cmd(`forceload add ${X - 32} ${Z - 32} ${X + 32} ${Z + 32}`);
    await sleep(3000);
    for (let y = Y - 12; y <= Y + 8; y += 6) {
      await fill(`${X - 12} ${y} ${Z - 12} ${X + 12} ${Math.min(y + 5, Y + 8)} ${Z + 12} minecraft:air`);
    }
    // A lit flooded chamber (glowstone so it cannot freeze), with a dry stone shelf well above it.
    await fill(`${X - 6} ${Y - 10} ${Z - 6} ${X + 6} ${Y - 3} ${Z + 6} minecraft:glowstone`);
    await fill(`${X - 5} ${Y - 9} ${Z - 5} ${X + 5} ${Y - 4} ${Z + 5} minecraft:water`);
    await fill(`${X - 6} ${Y - 1} ${Z - 6} ${X + 6} ${Y - 1} ${Z + 6} minecraft:stone`);
    const pocket = await must("get_blocks_at", { blocks: [{ x: X, y: Y - 6, z: Z }] });
    assert.ok(/water/.test(JSON.stringify(pocket.palette ?? [])),
      `the pocket must be WATER: ${JSON.stringify(pocket.palette)}`);
    await call("bot_body", { action: "despawn" });
  });

  test("an explicit spawn INTO the flooded pocket is refused, and names a dry alternative", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "despawn" });
    const r = await call("bot_body", { action: "spawn", type: "player", pos: { x: X, y: Y - 7, z: Z } });
    assert.equal(r.ok, false,
      `spawning with the head underwater must be REFUSED, not silently accepted: ${JSON.stringify(r).slice(0, 300)}`);
    assert.ok(/water/i.test(String(r.error)),
      `the refusal must say WHY — "out of lava" alone is what let this through: ${String(r.error).slice(0, 300)}`);

    // A stated position is never silently moved, so the refusal names the nearest cell that works.
    // That cell must itself be dry, or the fix has only moved the drowning.
    // Match the SUGGESTION, not the first coordinate triple in the message — the refusal opens by
    // echoing the cell it rejected, and matching that made this test grade the pocket it just
    // refused and "fail" a working fix.
    const alt = String(r.error).match(/works is\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)/);
    assert.ok(alt, `the refusal must name a workable cell: ${String(r.error).slice(0, 300)}`);
    const at = { x: Number(alt[1]), y: Number(alt[2]), z: Number(alt[3]) };
    const head = await must("get_blocks_at", { blocks: [{ x: at.x, y: at.y + 1, z: at.z }] });
    assert.ok(!/water/.test(JSON.stringify(head.palette ?? [])),
      `the suggested cell ${JSON.stringify(at)} is itself submerged: ${JSON.stringify(head.palette)}`);

    const ok = await call("bot_body", { action: "spawn", type: "player", pos: at });
    assert.equal(ok.ok, true, `the named alternative must actually work: ${JSON.stringify(ok).slice(0, 200)}`);
    await sleep(3000);
    const st = await submerged();
    assert.equal(st.inWater, false, `the body spawned wet at ${JSON.stringify(st.pos)}`);
  }, { timeout: 90_000 });

  test("wading is still allowed — the rule is head-under, not feet-wet", async (t) => {
    if (!bridgeUp) return t.skip();
    // One block of water on the dry shelf: feet wet, head in air. Refusing this would refuse a large
    // share of legitimate shoreline spawns, so the narrowness of the rule is itself under test.
    await fill(`${X + 3} ${Y} ${Z + 3} ${X + 3} ${Y} ${Z + 3} minecraft:water`);
    await sleep(500);
    await call("bot_body", { action: "despawn" });
    const r = await call("bot_body", { action: "spawn", type: "player", pos: { x: X + 3, y: Y, z: Z + 3 } });
    assert.equal(r.ok, true,
      `feet in one block of water is wading, not drowning, and must still spawn: ${JSON.stringify(r).slice(0, 250)}`);
    await fill(`${X + 3} ${Y} ${Z + 3} ${X + 3} ${Y} ${Z + 3} minecraft:air`);
  }, { timeout: 90_000 });

  test("a death over water respawns dry", async (t) => {
    if (!bridgeUp) return t.skip();
    // The real §5 shape: the body dies near the flooded chamber, and the death anchor is what the
    // respawn prefers. It must not hand the body back underwater.
    await call("bot_body", { action: "despawn" });
    const spawned = await call("bot_body", { action: "spawn", type: "player", pos: { x: X, y: Y, z: Z } });
    assert.equal(spawned.ok, true, `stage spawn: ${JSON.stringify(spawned).slice(0, 200)}`);
    await sleep(3500);
    const name = spawned.result?.name ?? "anon";
    // DIE INSIDE THE FLOODED CHAMBER, which is the whole point — a death on the dry shelf leaves a
    // dry anchor and this test would pass without the fix. a87c11eb died in a flooded cave and was
    // handed straight back into it.
    await cmd(`tp ${name} ${X} ${Y - 7} ${Z}`);
    await sleep(1200);
    const drowningSpot = await must("get_blocks_at", { blocks: [{ x: X, y: Y - 6, z: Z }] });
    assert.ok(/water/.test(JSON.stringify(drowningSpot.palette ?? [])),
      `the body must actually be in water when it dies, or the anchor is dry and this proves nothing: `
      + JSON.stringify(drowningSpot.palette));
    // /kill does not kill fake players; damage does.
    await cmd(`damage ${name} 1000 minecraft:generic`);
    await sleep(1500);

    // Ask for the DEATH ANCHOR explicitly. A bare posless respawn falls through to a player anchor,
    // and a headless server has no player — which is a property of the test rig, not of the fix.
    const again = await call("bot_body", { action: "spawn", type: "player", near: "death" });
    assert.equal(again.ok, true, `respawn after death must work: ${JSON.stringify(again).slice(0, 250)}`);
    await sleep(3000);
    const st = await submerged();
    assert.equal(st.inWater, false,
      `respawned submerged at ${JSON.stringify(st.pos)} with air ${st.air} — this is the drowning `
      + "that killed a87c11eb before it could move");
  }, { timeout: 120_000 });

  test("teardown: leave the site as it was found", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "despawn" });
    for (let y = Y - 12; y <= Y + 8; y += 6) {
      await fill(`${X - 12} ${y} ${Z - 12} ${X + 12} ${Math.min(y + 5, Y + 8)} ${Z + 12} minecraft:air`);
    }
    await cmd(`forceload remove ${X - 32} ${Z - 32} ${X + 32} ${Z + 32}`);
  });
});
