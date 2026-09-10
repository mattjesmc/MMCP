// Live probes for the BODY'S DANGER SENSE (toolkit 0.36.0) — the slice the first watched survival
// session died for. It drowned; neither the model nor the reflex layer reacted, and neither COULD:
// bot_status reported health and food and nothing about air or water, the reflex trigger vocabulary
// had no environmental term, and the player body was outside the vitals watch entirely, so its
// damage and its death emitted nothing at all. The model saw health falling with no cause and
// invented one. These probes assert the sense exists and that each half is honest.
//
//   1. bot_status carries the physical state: air/maxAir, inWater, submerged, onGround, dangers.
//   2. Submerging a body fires body_endangered {cause:"air_low"} ONCE, with seconds_left, and
//      body_safe when it clears — the enter/leave shape, not a per-tick flood.
//   3. body_damaged names its cause (drowning damage was previously silent for a player body).
//   4. The air_below → surface reflex SAVES the body: it rises, body_safe fires, it does not die.
//      This is the one that settles a reasoned claim empirically — the response re-asserts the jump
//      input every tick while PlayerNavigation's idle clears it in the same tick, and only a live
//      run can say whether the body actually rises.
//   5. Unsaved, it drowns — and then body_died carries the cause AND the hazards it was suffering,
//      the corpse is REAPED (a dead ServerPlayer is not removed by vanilla), and the name frees so
//      a respawn works. Before this, bot_status kept answering spawned:true at health 0.
//
// Probe-owned site at 3.51M. Needs the dev server; skips when the bridge is down.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const SESSION = "probe-hazards";
const X = 3_510_000, Z = 3_510_000, Y = 200;
// The pool: deep enough that a body cannot stand with its head clear, so submersion is certain.
const POOL_DEPTH = 5;

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

const nowCursor = async () => (await call("get_events", { limit: 1 })).cursor;

async function waitEvent(type, cursor, timeoutMs, pred = () => true) {
  const deadline = Date.now() + timeoutMs;
  let cur = cursor;
  while (Date.now() < deadline) {
    const r = await call("get_events", { cursor: cur, type, wait_ms: 1500 });
    for (const e of r.events || []) {
      if (e.type === type && pred(e)) return e;
    }
    cur = r.cursor ?? cur;
  }
  return null;
}

/** Count events of `type` since `cursor` — for asserting ONSET-ONLY (no per-tick flood). */
async function countEvents(type, cursor, pred = () => true) {
  const r = await call("get_events", { cursor, type, limit: 500 });
  return (r.events || []).filter((e) => e.type === type && pred(e)).length;
}

/** Sink a fresh player body into the middle of the pool. */
async function bodyInPool() {
  await call("bot_body", { action: "despawn" });
  await call("bot_reactions", { action: "clear" });
  await call("bot_body", { action: "spawn", type: "player", pos: { x: X, y: Y + 1, z: Z } });
  await sleep(2000); // fall in + settle under the surface
}

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok)
  .catch(() => false);
if (!bridgeUp) {
  console.log(`\n  [skip] no bridge at ${BASE} — start the dev server to run these probes\n`);
}

describe("body danger sense: drowning, events, and the surface reflex", { skip: !bridgeUp }, () => {
  test("stage: a deep pool with a dry ledge", async () => {
    await cmd(`forceload add ${X - 32} ${Z - 32} ${X + 32} ${Z + 32}`);
    // 33x33x8 = 8712 cells, well under /fill's 32,768 cap (an unsized fill fails SILENTLY).
    await cmd(`fill ${X - 16} ${Y - POOL_DEPTH - 1} ${Z - 16} ${X + 16} ${Y + 6} ${Z + 16} minecraft:air`);
    await cmd(`fill ${X - 16} ${Y - POOL_DEPTH - 1} ${Z - 16} ${X + 16} ${Y - POOL_DEPTH - 1} ${Z + 16} minecraft:stone`);
    // The pool itself, and a stone rim so the water cannot spread away.
    await cmd(`fill ${X - 6} ${Y - POOL_DEPTH} ${Z - 6} ${X + 6} ${Y} ${Z + 6} minecraft:water`);
    for (const [ax, az, bx, bz] of [
      [X - 7, Z - 7, X + 7, Z - 7], [X - 7, Z + 7, X + 7, Z + 7],
      [X - 7, Z - 7, X - 7, Z + 7], [X + 7, Z - 7, X + 7, Z + 7],
    ]) {
      await cmd(`fill ${ax} ${Y - POOL_DEPTH} ${az} ${bx} ${Y + 1} ${bz} minecraft:stone`);
    }
    // A dry standing ledge outside the pool, for the control reading.
    await cmd(`fill ${X + 10} ${Y} ${Z} ${X + 12} ${Y} ${Z + 2} minecraft:stone`);
    await sleep(1000); // let the water settle to still source blocks
  });

  test("bot_status carries the physical state a drowning body needs", async () => {
    // Control first: on dry land the flags read the other way, so a passing water case below is not
    // just a field that is always true.
    await call("bot_body", { action: "despawn" });
    await call("bot_body", { action: "spawn", type: "player", pos: { x: X + 11, y: Y + 2, z: Z + 1 } });
    await sleep(1500);
    const dry = await call("bot_status", {});
    assert.equal(dry.inWater, false, `dry body: inWater false (${JSON.stringify(dry)})`);
    assert.equal(dry.submerged, false, "dry body: not submerged");
    assert.equal(dry.onGround, true, `dry body stands on the ledge (y=${dry.pos.y})`);
    assert.equal(dry.air, dry.maxAir, `full breath on land: ${dry.air}/${dry.maxAir}`);
    assert.equal(dry.dangers, undefined, "no dangers on dry land — the field is absent, not empty");

    await bodyInPool();
    const wet = await call("bot_status", {});
    assert.equal(wet.inWater, true, `submerged body: inWater true (${JSON.stringify(wet)})`);
    assert.equal(wet.submerged, true, "the EYE is under water — the flag that predicts drowning");
    assert.ok(wet.air < wet.maxAir, `breath is draining: ${wet.air}/${wet.maxAir}`);
  });

  test("body_endangered fires ONCE on onset with seconds_left, and body_safe on clear", async () => {
    const cursor = await nowCursor();
    await bodyInPool();
    const ev = await waitEvent("body_endangered", cursor, 20_000, (e) => e.data?.cause === "air_low");
    assert.ok(ev, "submerging a body must announce air_low");
    assert.equal(ev.data.body, "player");
    assert.ok(Number.isInteger(ev.data.air), `the event says HOW BAD: ${JSON.stringify(ev.data)}`);
    assert.ok(Number.isInteger(ev.data.seconds_left), "…in seconds of breath left");
    assert.match(String(ev.data.remedy), /surface/i, "…and names the remedy");
    // The envelope rides at the EVENT level, not inside `data`: EventLog strips a `game_tick` from
    // data when it equals the event's own (EventLog.java — 40 events were carrying 840 bytes of
    // duplicate clock) and serializes it once per row. This assertion used to read data.game_tick
    // and had been failing ever since that de-duplication landed.
    assert.ok(Number.isInteger(ev.game_tick), "embodied envelope rides along");

    // ONSET ONLY. A per-tick emit would flood the log and drown the signal — assert that several
    // seconds of continued drowning produced exactly one announcement.
    await sleep(3000);
    const n = await countEvents("body_endangered", cursor, (e) => e.data?.cause === "air_low");
    assert.equal(n, 1, `air_low announced once, not per tick (got ${n})`);

    // …and the clear half: lift it out and body_safe must fire.
    const midCursor = await nowCursor();
    const s = await call("bot_status", {});
    await cmd(`tp ${s.name} ${X + 11} ${Y + 1} ${Z + 1}`);
    const safe = await waitEvent("body_safe", midCursor, 15_000, (e) => e.data?.cause === "air_low");
    assert.ok(safe, "leaving the water must announce body_safe — the enter/leave pair");
    assert.equal(safe.data.body, "player");
  });

  test("body_damaged names its cause — drowning damage was previously silent", async () => {
    const cursor = await nowCursor();
    await bodyInPool();
    // Breath is 300 ticks (15s); damage starts after it empties. Give it the full drain plus margin.
    const dmg = await waitEvent("body_damaged", cursor, 30_000, (e) => e.data?.body === "player");
    assert.ok(dmg, "a drowning player body must report damage");
    assert.ok(dmg.data.damage > 0, `damage taken: ${JSON.stringify(dmg.data)}`);
    assert.match(String(dmg.data.cause), /drown/i, `the cause is named, not inferred: ${dmg.data.cause}`);
  });

  test("the air_below → surface reflex SAVES the body (the empirical question)", async () => {
    await call("bot_body", { action: "despawn" });
    await call("bot_reactions", { action: "clear" });
    await call("bot_reactions", {
      action: "arm",
      // ticks 140, BELOW the air_low hazard onset (150): the reflex must fire after the danger
      // announces, or the test's endangered→saved→safe chain never exists to assert. At the old
      // 250 the reflex saved the body at ~240 air — measured live 2026-08-04, head out ~1s after
      // firing — and body_safe correctly never fired because body_endangered never had.
      reactions: [{ id: "dont_drown", trigger: { kind: "air_below", ticks: 140 },
                    response: { op: "surface" }, priority: 100 }],
    });
    const cursor = await nowCursor();
    await call("bot_body", { action: "spawn", type: "player", pos: { x: X, y: Y + 1, z: Z } });

    const fired = await waitEvent("reaction_fired", cursor, 20_000, (e) => e.data?.id === "dont_drown");
    assert.ok(fired, "the reflex must fire while breath is draining");
    assert.equal(fired.data.response_op, "surface");

    // The claim under test: the body actually RISES. Sample until its eye clears water, or fail with
    // the trajectory so a regression says how far it got rather than only that it drowned.
    const ys = [];
    let cleared = false;
    for (let i = 0; i < 40; i++) {
      const s = await call("bot_status", {});
      if (!s.spawned) break;
      ys.push(Number(s.pos.y.toFixed(2)));
      if (s.submerged === false) { cleared = true; break; }
      await sleep(500);
    }
    assert.ok(cleared,
      `the surface reflex must get the head into air — y trajectory was ${JSON.stringify(ys)}. ` +
      `If y never rose, PlayerNavigation's per-tick driver.idle is clearing the jump input before ` +
      `aiStep reads it, and the lift must be applied in the response instead of via setJumping.`);

    const alive = await call("bot_status", {});
    assert.equal(alive.spawned, true, "saved, not drowned");
    assert.ok(alive.health > 0, `alive with health ${alive.health}`);
    const safe = await waitEvent("body_safe", cursor, 10_000, (e) => e.data?.cause === "air_low");
    assert.ok(safe, "surfacing clears the hazard");
  });

  test("unsaved it drowns: body_died carries cause + hazards, and the corpse is REAPED", async () => {
    await call("bot_reactions", { action: "clear" });
    const cursor = await nowCursor();
    await bodyInPool();
    const name = (await call("bot_status", {})).name;

    const died = await waitEvent("body_died", cursor, 60_000, (e) => e.data?.body === "player");
    assert.ok(died, "a drowning body with no reflex must die AND say so");
    assert.match(String(died.data.cause), /drown/i, `death names its cause: ${JSON.stringify(died.data)}`);
    assert.ok(Array.isArray(died.data.hazards) && died.data.hazards.includes("air_low"),
      `death carries what it was suffering: ${JSON.stringify(died.data.hazards)}`);
    assert.ok(died.data.pos, "…and where it happened");

    // The corpse: vanilla does NOT remove a dead player, so without reaping bot_status kept
    // answering spawned:true at health 0 and the offline name stayed taken.
    await sleep(1000);
    const after = await call("bot_status", {});
    assert.equal(after.spawned, false,
      `the corpse is reaped — bot_status must not claim a spawned body at health 0: ${JSON.stringify(after)}`);
    const list = await cmd(`list`);
    assert.ok(!JSON.stringify(list).includes(name),
      `the dead name leaves the player list: ${JSON.stringify(list)}`);

    // And the name frees, so a respawn works — the thing the first session thought was blocked.
    const again = await call("bot_body", { action: "spawn", type: "player", pos: { x: X + 11, y: Y + 2, z: Z + 1 } });
    assert.equal(again.type, "player", `respawn after death works: ${JSON.stringify(again)}`);
    await sleep(1200);
    const back = await call("bot_status", {});
    assert.equal(back.spawned, true);
    assert.ok(back.health > 0, `the new body is alive at ${back.health}`);
  });

  test("cleanup", async () => {
    await call("bot_reactions", { action: "clear" }).catch(() => {});
    await call("bot_body", { action: "despawn" }).catch(() => {});
    await cmd(`kill @e[type=minecraft:item,x=${X},y=${Y},z=${Z},distance=..48]`).catch(() => {});
    await cmd(`forceload remove ${X - 32} ${Z - 32} ${X + 32} ${Z + 32}`);
  });
});
