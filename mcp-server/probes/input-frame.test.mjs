// The Phase-3 widened input frame (world-model DESIGN.md §9, toolkit 0.61.0) — live checks for
// the three actuation changes:
//
//   1. ANALOG FORWARD — the player sink no longer thresholds zza to 0/1: a bot_goto at
//      speed 0.4 must actually take longer than at 1.0 (before 0.61.0 both walked full speed,
//      and the recorder wrote requested speeds the physics refused to run).
//   2. HONEST BACKSTEP — the reflex dodge is an input frame, not Entity.move: 10 ticks of
//      backstep displace ~walk-gait distance (≲3.5 blocks), not the old 0.5 b/t velocity write
//      (5 blocks — ~2.3× sprint, physics no client could produce).
//   3. STRAFE MAPPING — side:left must move the body to the LEFT of its facing (+xxa is
//      strafe-left in the vanilla input frame; this pins the sign against a live engine).
//
// The second slice (toolkit 0.63.0) added two live-checkable authors:
//
//   4. GAZE AUTHOR — NavDriver drives look PITCH at the waypoint while walking ("watch your
//      feet", DESIGN.md §13.2): after a flat leg the body's pitch is decidedly downward, not
//      the stale horizon every pre-0.63.0 walk held.
//   5. SNEAK CREEP — the edge-care hold on a sneak-capable body creeps to the lip crouched
//      instead of freezing short: a goto onto a pit-edge cell arrives AND does not fall
//      (vanilla's sneak-clip is the safety the zeroed-forward hold used to be).
//
// Button `press` rows (use/attack/hotbar) are recorder-only — not observable live while the
// session gz is open; they get verified from the stream at the next server close, the way
// slice 1's rows were.
//
// OWNS SITE 1,730,000 (site-map.test.mjs). Live probe: needs the dev server; skips when down.

import { test } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const SITE = { x: 1730000, z: 1730000 };
const Y = 200;

const SESSION = await fetch(`${BASE}/hello`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ label: "input-frame-probe" }),
  signal: AbortSignal.timeout(3000),
}).then((r) => r.json()).then((j) => j.session ?? null).catch(() => null);

async function callRaw(tool, args = {}) {
  const res = await fetch(`${BASE}/cmd`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(SESSION ? { "X-MCPTK-Session": SESSION } : {}),
    },
    body: JSON.stringify({ tool, args }),
  });
  return res.json();
}

async function call(tool, args = {}) {
  const j = await callRaw(tool, args);
  if (!j.ok) throw new Error(`${tool} failed: ${JSON.stringify(j.error)}`);
  return j.result;
}
const cmd = (c) => call("run_command", { command: c });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok)
  .catch(() => false);
if (!bridgeUp) {
  console.log(`\n  [skip] no bridge at ${BASE} — start the dev server to run these probes\n`);
}

async function stageStrip() {
  await cmd(`forceload add ${SITE.x - 16} ${SITE.z - 16} ${SITE.x + 40} ${SITE.z + 16}`);
  await cmd(`fill ${SITE.x - 4} ${Y - 1} ${SITE.z - 6} ${SITE.x + 30} ${Y - 1} ${SITE.z + 6} minecraft:stone`);
  await cmd(`fill ${SITE.x - 4} ${Y} ${SITE.z - 6} ${SITE.x + 30} ${Y + 3} ${SITE.z + 6} minecraft:air`);
}

async function bodyPos() {
  const s = await call("bot_status", {});
  const p = s.pos ?? s.position ?? s.pose;
  return { x: p.x, y: p.y, z: p.z, yaw: s.yaw ?? p.yaw ?? 0 };
}

/** Facing + left unit vectors from a yaw (MC: facing = (-sin, cos), left = facing rotated -90°). */
function frameOf(yawDeg) {
  const r = (yawDeg * Math.PI) / 180;
  const f = { x: -Math.sin(r), z: Math.cos(r) };
  return { f, left: { x: f.z, z: -f.x } };
}

test("analog forward: goto at speed 0.4 is genuinely slower than 1.0", { skip: !bridgeUp }, async () => {
  await stageStrip();
  const runLeg = async (speed) => {
    await call("bot_body", { action: "spawn", type: "player", pos: { x: SITE.x, y: Y, z: SITE.z } });
    try {
      const t0 = Date.now();
      const walk = await call("bot_goto", {
        to: { x: SITE.x + 20, y: Y, z: SITE.z }, within: 1.5, speed, wait: true,
      });
      const landed = ["arrived", "already_there"].includes(walk.outcome)
        || (walk.traveled > 15 && walk.distance_to_target < 3);
      assert.ok(landed, `the ${speed} leg must cross the strip: ${JSON.stringify(walk)}`);
      return Date.now() - t0;
    } finally {
      await callRaw("bot_body", { action: "despawn" });
    }
  };
  const fast = await runLeg(1.0);
  const slow = await runLeg(0.4);
  // Input scales the gait ~linearly (single-axis input passes the square-stretch unchanged), so
  // 0.4 should take ~2.5× the wall time; ≥1.4× is the flake-proof line that still catches the
  // old thresholded sink, where both legs walk identically.
  assert.ok(slow > fast * 1.4,
    `speed 0.4 must be slower than 1.0: fast=${fast}ms slow=${slow}ms`);
});

async function dodgeOnce(reactionId, response) {
  // A gold block 2 ahead trips block_near (within 3); the long explicit cooldown keeps the
  // reaction from re-firing while we measure a single burst.
  await call("bot_reactions", {
    action: "arm",
    reactions: [{
      id: reactionId,
      trigger: { kind: "block_near", block: "minecraft:gold_block", within: 3 },
      response,
      priority: 50,
      cooldown_ticks: 400,
    }],
  });
  const start = await bodyPos();
  await cmd(`setblock ${SITE.x} ${Y} ${SITE.z + 2} minecraft:gold_block`);
  await sleep(2500); // fire + 10 ticks of legs + slack
  const end = await bodyPos();
  await cmd(`setblock ${SITE.x} ${Y} ${SITE.z + 2} minecraft:air`);
  return { start, end, dx: end.x - start.x, dz: end.z - start.z };
}

test("backstep dodges at walk gait, not the old velocity write", { skip: !bridgeUp }, async () => {
  await stageStrip();
  await call("bot_body", { action: "spawn", type: "player", pos: { x: SITE.x, y: Y, z: SITE.z } });
  try {
    const { start, dx, dz } = await dodgeOnce("wm-backstep", { op: "backstep", ticks: 10 });
    const { f } = frameOf(start.yaw);
    const back = -(dx * f.x + dz * f.z); // displacement opposite the facing
    assert.ok(back > 0.8, `the backstep must actually move the body: back=${back.toFixed(2)}`);
    assert.ok(back < 3.5,
      `10 ticks of honest walking is ≲2.2 blocks + slide — ${back.toFixed(2)} means the old ` +
      `0.5 b/t Entity.move bypass is back`);
  } finally {
    await callRaw("bot_reactions", { action: "disarm", id: "wm-backstep" });
    await callRaw("bot_body", { action: "despawn" });
  }
});

test("gaze author: a walking body watches its feet (pitch driven downward)", { skip: !bridgeUp }, async () => {
  await stageStrip();
  await call("bot_body", { action: "spawn", type: "player", pos: { x: SITE.x, y: Y, z: SITE.z } });
  try {
    // Zero the look first so a stale downward pitch from an earlier test cannot false-pass.
    await call("bot_look", { yaw: 0, pitch: 0 });
    const walk = await call("bot_goto", {
      to: { x: SITE.x + 20, y: Y, z: SITE.z }, within: 1.5, wait: true,
    });
    assert.ok(["arrived", "already_there"].includes(walk.outcome), JSON.stringify(walk));
    const s = await call("bot_status", {});
    const pitch = s.pitch ?? s.pose?.pitch;
    assert.ok(typeof pitch === "number", `bot_status reports pitch: ${JSON.stringify(s)}`);
    // On a flat leg the waypoint sits ~1.6 blocks under the eye a couple of blocks ahead —
    // the held gaze after arrival is decidedly downward. Pre-0.63.0 walking never wrote pitch.
    assert.ok(pitch > 5,
      `a walking body looks at its footing, not the horizon: pitch=${pitch.toFixed(1)}°`);
  } finally {
    await callRaw("bot_body", { action: "despawn" });
  }
});

test("sneak creep: a goto onto a pit-lip cell arrives crouch-safe, no fall", { skip: !bridgeUp }, async () => {
  await stageStrip();
  // A 12-deep pit past x+11: the lip cell x+10 is the last footing, the drop is unsurvivable
  // territory for footingAt, so the edge-care fires on the final approach.
  await cmd(`fill ${SITE.x + 11} ${Y - 12} ${SITE.z - 6} ${SITE.x + 30} ${Y - 1} ${SITE.z + 6} minecraft:air`);
  await call("bot_body", { action: "spawn", type: "player", pos: { x: SITE.x, y: Y, z: SITE.z } });
  try {
    const walk = await call("bot_goto", {
      to: { x: SITE.x + 10, y: Y, z: SITE.z }, within: 0.5, wait: true,
    });
    assert.ok(["arrived", "already_there"].includes(walk.outcome),
      `the lip-cell target is reachable — the creep must not strand the approach: ${JSON.stringify(walk)}`);
    const p = await bodyPos();
    assert.ok(Math.abs(p.y - Y) < 0.5,
      `the body stayed ON the lip (sneak-clip did its job): y=${p.y.toFixed(2)} vs ${Y}`);
    assert.ok(p.x > SITE.x + 9.4 && p.x < SITE.x + 11.0,
      `settled in the lip cell, not short of it or over it: x=${(p.x - SITE.x).toFixed(2)}+site`);
  } finally {
    await callRaw("bot_body", { action: "despawn" });
    await cmd(`fill ${SITE.x + 11} ${Y - 12} ${SITE.z - 6} ${SITE.x + 30} ${Y - 2} ${SITE.z + 6} minecraft:stone`);
    await cmd(`fill ${SITE.x + 11} ${Y - 1} ${SITE.z - 6} ${SITE.x + 30} ${Y - 1} ${SITE.z + 6} minecraft:stone`);
  }
});

test("strafe side:left moves left of facing (+xxa is strafe-left)", { skip: !bridgeUp }, async () => {
  await stageStrip();
  await call("bot_body", { action: "spawn", type: "player", pos: { x: SITE.x, y: Y, z: SITE.z } });
  try {
    const { start, dx, dz } = await dodgeOnce("wm-strafe",
      { op: "strafe", ticks: 10, side: "left" });
    const { f, left } = frameOf(start.yaw);
    const lateral = dx * left.x + dz * left.z;
    const along = Math.abs(dx * f.x + dz * f.z);
    assert.ok(lateral > 0.8,
      `side:left must displace along the body's left: lateral=${lateral.toFixed(2)} ` +
      `(negative = the xxa sign is flipped)`);
    assert.ok(lateral < 3.5,
      `10 ticks of honest strafing is ≲2.2 blocks + slide — ${lateral.toFixed(2)} is the ` +
      `legacy velocity write (this bound is what caught the drone-body false pass)`);
    assert.ok(along < 1.2,
      `a strafe moves sideways, not forward: along-facing drift ${along.toFixed(2)}`);
  } finally {
    await callRaw("bot_reactions", { action: "disarm", id: "wm-strafe" });
    await callRaw("bot_body", { action: "despawn" });
    await cmd(`forceload remove ${SITE.x - 16} ${SITE.z - 16} ${SITE.x + 40} ${SITE.z + 16}`);
  }
});
