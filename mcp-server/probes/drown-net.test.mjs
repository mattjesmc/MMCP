// Live probes for the DROWN NET — PERCEPTION_NAV_FIXES.md §2.2.
//
// Two sessions drowned. `a87c11eb` 13:17:42 sat at one position across six status polls over 60s
// while air fell 300 → 145 and a goal reported `started:true` that never moved and never completed.
// The first watched session drowned the same way, and its transcript showed NO `reaction_fired` for
// `air_below` at all.
//
// The machinery to survive that already exists: Reflexes has a `surface` op (hold jump — the only
// way a player ascends in fluid — with an entry check on the column overhead so a sealed pocket
// answers `no_surface_reachable` instead of holding jump into stone), and the survival preset arms
// it as `drown` on `air_below` at 150 ticks. Reflexes.tick also runs BEFORE GoalRunner.tick and is
// not gated by goals, so "a goal owned the body" does not explain the silence either.
//
// So this probe exists to find out which is true: does the net fire and rescue, or does it not?
// Everything downstream (an explicit surfacing verb, a repeat-guard on goals that route through
// water) depends on that answer, and building on top of a net that does not fire would be building
// the wrong half.
//
// Staged at a probe-owned coordinate (3.99M). Own session. `npm run test:live`.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const X = 3_990_000, Z = 3_990_000, Y = 200;
const SESSION = "probe-drown-net";
/** Vanilla air is 300 ticks; the preset's trigger is air_below 150. */
const TRIGGER_AIR = 150;

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

/** /fill that fails loudly — run_command answers ok:true for commands the game rejected, and
 *  /fill silently refuses boxes over 32768 blocks. */
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
  await call("ping");
} catch {
  bridgeUp = false;
}

/** Drain this session's event backlog so a later window cannot read an earlier test's rows. */
async function drainEvents() {
  for (let i = 0; i < 30; i++) {
    const r = await call("get_events", { limit: 200 });
    if (!r.more) return;
  }
}

/**
 * Put the body in the water the way a real body gets there — by MOVING into it.
 *
 * Spawning straight into a submerged cell is refused since §5 (a body must not START underwater),
 * and that refusal is correct — it is the fix that stops a respawn handing the body back into a
 * flooded cave. So spawn on the dry rim and teleport down, which is also closer to what actually
 * happened in the sessions this file is about.
 */
async function submergeAt(x, y, z) {
  await call("bot_body", { action: "despawn" });
  // NOTE this file's call() throws on failure and returns j.result — there is no `.ok` to check.
  const spawned = await call("bot_body", { action: "spawn", type: "player", pos: { x: X + 4, y: Y, z: Z + 4 } });
  assert.ok(spawned.name, `dry rim spawn: ${JSON.stringify(spawned).slice(0, 220)}`);
  await sleep(3500);
  await cmd(`tp ${spawned.name} ${x} ${y} ${z}`);
  await sleep(1200);
  return spawned.name;
}

async function stagePool() {
  await cmd(`forceload add ${X - 32} ${Z - 32} ${X + 32} ${Z + 32}`);
  await sleep(3000);
  for (let y = Y - 12; y <= Y + 6; y += 6) {
    await fill(`${X - 12} ${y} ${Z - 12} ${X + 12} ${Math.min(y + 5, Y + 6)} ${Z + 12} minecraft:air`);
  }
  // A lit shaft of water 8 deep with open sky above it. GLOWSTONE walls, not stone: an unlit pool
  // in a cold biome freezes, and this probe would then be measuring a body standing on ice.
  await fill(`${X - 4} ${Y - 10} ${Z - 4} ${X + 4} ${Y - 1} ${Z + 4} minecraft:glowstone`);
  await fill(`${X - 3} ${Y - 9} ${Z - 3} ${X + 3} ${Y - 1} ${Z + 3} minecraft:water`);
  const pool = await call("get_blocks_at", { blocks: [{ x: X, y: Y - 5, z: Z }, { x: X, y: Y - 2, z: Z }] });
  const palette = JSON.stringify(pool.palette ?? []);
  assert.ok(/water/.test(palette) && !/ice/.test(palette), `the shaft must be WATER: ${palette}`);
}

describe("the drown net (§2.2): does the body save itself?", { skip: !bridgeUp }, () => {
  test("stage a lit water shaft with open sky above", async (t) => {
    if (!bridgeUp) return t.skip();
    await stagePool();
    await call("bot_body", { action: "despawn" }).catch(() => {});
  });

  test("armed with the survival preset, a submerged body surfaces before it drowns", async (t) => {
    if (!bridgeUp) return t.skip();
    await submergeAt(X, Y - 8, Z);
    await call("bot_reactions", { action: "arm", preset: "survival" });
    await drainEvents();

    // Hold it under: teleport back down each poll so it cannot simply float out before the trigger.
    let minAir = 300;
    let fired = null;
    let surfaced = false;
    let recovered = 0;
    for (let i = 0; i < 40; i++) {
      const st = await call("bot_status");
      const air = st.air ?? st.air_supply ?? 300;
      minAir = Math.min(minAir, air);
      // RECOVERING AIR is the honest end state, not `inWater:false` — vanilla refills breath only
      // once the head is clear, and a body treading at the surface still reports inWater.
      if (minAir < TRIGGER_AIR && air > minAir + 40) recovered = air;
      if (recovered || (!st.inWater && minAir < TRIGGER_AIR)) surfaced = true;
      const ev = await call("get_events", { limit: 100 });
      for (const e of ev.events ?? []) {
        if (e.type === "reaction_fired" && JSON.stringify(e).includes("drown")) fired = e;
      }
      if (fired && surfaced) break;
      await sleep(500);
    }
    console.log(`      # min air ${minAir}, drown fired: ${fired ? "yes" : "NO"}, air recovered to ${recovered || "-"}`);
    assert.ok(minAir < TRIGGER_AIR,
      `the body must actually get low on air for this to test anything (min ${minAir})`);
    assert.ok(fired,
      `air fell to ${minAir}, past the preset's air_below ${TRIGGER_AIR}, and the drown reaction `
      + "never fired — the safety net that is supposed to keep the body alive is not running");
    assert.ok(surfaced,
      `the drown reaction fired at air ${minAir} and the body never reached air — a net that reports `
      + "a rescue it did not perform is worse than no net at all");
  }, { timeout: 120_000 });

  test("a sealed pocket is refused honestly, not held-jump-into-stone", async (t) => {
    if (!bridgeUp) return t.skip();
    // The flooded shaft with a solid ceiling — where a mining body actually drowns. Holding jump
    // for five seconds is not a rescue; the op must say the column is solid and name the remedy.
    await fill(`${X - 3} ${Y} ${Z - 3} ${X + 3} ${Y} ${Z + 3} minecraft:glowstone`);
    await submergeAt(X, Y - 8, Z);
    await call("bot_reactions", { action: "arm", preset: "survival" });
    await drainEvents();

    let verdict = null;
    for (let i = 0; i < 40; i++) {
      const ev = await call("get_events", { limit: 100 });
      for (const e of ev.events ?? []) {
        const s = JSON.stringify(e);
        if (e.type === "reaction_done" && s.includes("surface")) verdict = e;
      }
      if (verdict) break;
      await sleep(500);
    }
    console.log(`      # sealed-pocket verdict: ${JSON.stringify(verdict).slice(0, 220)}`);
    assert.ok(verdict, "a submerged body under a solid ceiling must produce a surface verdict, not silence");
    assert.ok(/no_surface_reachable|still_submerged/.test(JSON.stringify(verdict)),
      `a sealed pocket must be reported as such, and never as a successful rescue: ${JSON.stringify(verdict)}`);
    await fill(`${X - 3} ${Y} ${Z - 3} ${X + 3} ${Y} ${Z + 3} minecraft:air`);
  }, { timeout: 120_000 });

  test("bot_surface: the agent can ASK, and the answer is honest in every case", async (t) => {
    if (!bridgeUp) return t.skip();
    await stagePool();
    await submergeAt(X, Y - 8, Z);
    // Disarm the reflexes: this test is about the DELIBERATE verb, and a drown reaction racing it
    // would make the result unattributable.
    await call("bot_reactions", { action: "clear" }).catch(() => {});
    await drainEvents();

    const started = await call("bot_surface", {});
    assert.equal(started.ok, true, `submerged, bot_surface must start: ${JSON.stringify(started)}`);
    assert.ok(started.started, `…and report that it is swimming: ${JSON.stringify(started)}`);
    assert.equal(started.fluid, "water");

    let done = null;
    for (let i = 0; i < 30 && !done; i++) {
      await sleep(500);
      const ev = await call("get_events", { limit: 100 });
      for (const e of ev.events ?? []) {
        if (e.type === "reaction_done" && JSON.stringify(e).includes("bot_surface")) done = e;
      }
    }
    console.log(`      # bot_surface verdict: ${JSON.stringify(done).slice(0, 200)}`);
    assert.ok(done, "the verb must produce a verdict, not silence");
    assert.ok(JSON.stringify(done).includes('"ok":true'),
      `the body had open sky above it and must have surfaced: ${JSON.stringify(done)}`);

    // Asking again once clear must NOT read back as a second rescue.
    const again = await call("bot_surface", {});
    assert.equal(again.ok, true);
    assert.equal(again.reason, "already_clear",
      `a body already in air must say so, or ten calls read back as ten rescues: ${JSON.stringify(again)}`);
    assert.equal(again.moved, false);
  }, { timeout: 120_000 });

  test("teardown: leave the site as it was found", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "despawn" }).catch(() => {});
    for (let y = Y - 12; y <= Y + 6; y += 6) {
      await fill(`${X - 12} ${y} ${Z - 12} ${X + 12} ${Math.min(y + 5, Y + 6)} ${Z + 12} minecraft:air`);
    }
    await cmd(`forceload remove ${X - 32} ${Z - 32} ${X + 32} ${Z + 32}`);
  });
});
