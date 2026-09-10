// THE MOVEMENT MIRROR — J1 (COMBAT_CLINIC.md §2.3 / build-order step 6, COMBAT_KIT_PLAN.md §14).
//
// `Entity.getKnownSpeed()` returns a realized position delta, but `ServerPlayer` OVERRIDES it to
// return `lastKnownClientMovement` — written only by `setKnownMovement`, which the server calls when
// a real client's movement packet arrives. `FakePlayerEntity` has no client, so before J1 the
// survival body reported a speed of ZERO, FOREVER, while walking at 4.2 b/s. Everything in the game
// that asks how fast an attacker is going was reading that zero:
//
//   * `KineticWeapon.getMotion` = `getKnownSpeed().scale(20)` — a spear in the body's hand could
//     never pass `ofRelativeSpeed(225, 4.6)` at ANY approach speed. That is what made combat-kit
//     step 6 unbuildable rather than merely unbuilt.
//   * `ProjectileUtil.getHitEntitiesAlong` extends attack range by `knownMovement · look` — the
//     body never got the reach a moving player gets.
//   * `Projectile.shootFromRotation` adds the shooter's motion to the arrow — the body's arrows
//     inherited nothing, so a shot fired while running went where a standing shot would.
//   * `Player.isSweepAttack` compares `knownMovement` against `getSpeed() × 2.5` — reading zero, a
//     grounded full-strength sword blow ALWAYS swept.
//
// So this is a sensing repair, not a combat feature, and the failure it fixes was invisible from
// every direction: nothing threw, nothing logged, and every probe passed.
//
// WHAT THIS FILE CHECKS, and why it is shaped as a DIVERGENCE test. The trap the clinic names
// (§10 step 12) is a probe that validates a reading against a second copy of its own formula, so the
// witness here is measured OUTSIDE the game: consecutive `bot_status` positions over wall time. That
// is independent of `getKnownSpeed` in both code path and clock, and it is what makes a passing
// number mean something. It also settles the unit question by itself, since blocks-per-TICK and
// blocks-per-SECOND differ by exactly the factor 20 every `KineticWeapon.Condition` assumes.
//
// TWO THINGS MEASURED HERE THAT THE DESIGN GOT WRONG, recorded because the next reader will
// otherwise re-derive them:
//
//   1. `speed_delta` (= `getDeltaMovement`) CANNOT agree with `speed_known` within C6's 15%, and
//      demanding that it does would void every spear cell for the wrong reason. `getDeltaMovement`
//      is read AFTER `LivingEntity.travel` multiplies by friction, so on ordinary ground it is the
//      post-friction RESIDUAL: measured 2.31 b/s horizontal against a realized 4.23. The ratio is
//      the friction constant (0.6 × 0.91 = 0.546), not an error, and this file asserts the
//      relationship rather than an agreement.
//   2. Both readings are HORIZONTAL. A 3-D magnitude reported `speed_delta: 1.57` for a body
//      standing perfectly still on stone — 0.0784 b/tick, vanilla's gravity term, which a grounded
//      entity carries forever. Vanilla asks the same question the same way
//      (`Entity.hasMovedHorizontallyRecently`).
//
// A THIRD, about staging: a body spawns AIRBORNE and `PathNavigation.canUpdatePath` refuses a path
// while it is, so a `bot_goto` issued in the same breath as the spawn comes back
// `reachable:false, nodes:0` — while `check_path` on the same pair answers `reachable:true` with 11
// nodes, because the predictor is not standing anywhere. Hence the settle in `sampleWhileWalking`.
//
// NOT checked here: the four consequences listed at the top. Each belongs to the file that already
// owns its subject (reach and projectiles are chunk a, sweep is combat-fixes), which is why J1's
// landing asks for a chunk a AND d re-read rather than for more assertions in this one file.
//
// OWNS SITE 4,350,000 (site-map.test.mjs). Live probe: needs the dev server; skips when down.

import { test } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const SITE = { x: 4350000, z: 4350000 };
const Y = 200;

const SESSION = await fetch(`${BASE}/hello`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ label: "known-movement-probe" }),
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

// 20 blocks, not 40: a walker's path search would not reach further here, and the leg only has to
// be long enough to hold a steady gait across several samples.
const FAR = 20;
const STRIP = [SITE.x - 16, SITE.z - 16, SITE.x + FAR + 24, SITE.z + 16];

async function stageStrip() {
  await cmd(`forceload add ${STRIP[0]} ${STRIP[1]} ${STRIP[2]} ${STRIP[3]}`);
  await cmd(`fill ${SITE.x - 4} ${Y - 1} ${SITE.z - 6} ${SITE.x + FAR + 8} ${Y - 1} ${SITE.z + 6} minecraft:stone`);
  await cmd(`fill ${SITE.x - 4} ${Y} ${SITE.z - 6} ${SITE.x + FAR + 8} ${Y + 3} ${SITE.z + 6} minecraft:air`);
}

/** Spawn, LET IT LAND (see the header), then walk and poll. */
async function sampleWhileWalking(type) {
  await stageStrip();
  await call("bot_body", { action: "spawn", type, pos: { x: SITE.x, y: Y, z: SITE.z } });
  await sleep(1200);
  try {
    const started = await call("bot_goto", {
      to: { x: SITE.x + FAR, y: Y, z: SITE.z }, within: 1.5, speed: 1.0, wait: false,
    });
    assert.equal(started.started, true,
      `the ${type} must actually set off — a refused walk measures nothing: ${JSON.stringify(started)}`);
    const samples = [];
    let prev = null;
    for (let i = 0; i < 16 && samples.length < 10; i++) {
      await sleep(300);
      const t = Date.now();
      const s = await call("bot_status", {});
      if (prev && typeof s.speed_known === "number" && typeof s.speed_delta === "number") {
        const dt = (t - prev.t) / 1000;
        const moved = Math.hypot(s.pos.x - prev.pos.x, s.pos.z - prev.pos.z);
        samples.push({ known: s.speed_known, delta: s.speed_delta, pose: moved / dt });
      }
      prev = { t, pos: s.pos };
      if (s.navigating === false && samples.length > 0) break;
    }
    return samples;
  } finally {
    await callRaw("bot_body", { action: "despawn" });
  }
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

test("a standing body reports no speed pair at all", { skip: !bridgeUp }, async () => {
  await stageStrip();
  await call("bot_body", { action: "spawn", type: "player", pos: { x: SITE.x, y: Y, z: SITE.z } });
  try {
    await sleep(1500); // land, and let the spawn's own drop fall out of the mirror
    const s = await call("bot_status", {});
    assert.equal(s.onGround, true, `the body must have landed before this means anything: ${JSON.stringify(s.pos)}`);
    // The pair is omitted below SPEED_EPSILON_BPS — the file's idiom for a reading whose mere
    // presence is the fact. A standing body that reports a speed is either a mirror stuck on a
    // stale value or a 3-D magnitude reading gravity as motion (which is what it did first).
    assert.ok(s.speed_known === undefined && s.speed_delta === undefined,
      `a settled body is not moving: ${JSON.stringify({ k: s.speed_known, d: s.speed_delta })}`);
  } finally {
    await callRaw("bot_body", { action: "despawn" });
  }
});

test("C6: speed_known matches displacement measured OUTSIDE the game", { skip: !bridgeUp }, async () => {
  const samples = await sampleWhileWalking("player");
  assert.ok(samples.length >= 4,
    `the body must walk and report while it does — got ${samples.length} sample(s). ZERO samples ` +
    `with a moving body is J1 missing: getKnownSpeed reads 0 and the epsilon gate omits the pair.`);
  const known = median(samples.map((s) => s.known));
  const pose = median(samples.map((s) => s.pose));
  // A walking player is ~4.317 b/s. The gate is well under it so a slow tick rate cannot fail this,
  // and well over zero so the pre-J1 body cannot pass it.
  assert.ok(known > 2.0,
    `the mirror must report real motion, not the client's silence: speed_known=${known} b/s ` +
    `(0 means ServerPlayer.lastKnownClientMovement is still what is being read)`);
  // THE DIVERGENCE TEST. `pose` comes from consecutive positions over the wall clock — a different
  // code path and a different clock — so this is the one assertion here that a second copy of the
  // same formula could not pass. 30% absorbs the tick rate under a concurrent battery; a unit error
  // would be off by a factor of 20, not by a third.
  assert.ok(Math.abs(known - pose) <= 0.3 * Math.max(known, pose),
    `speed_known must equal the displacement anyone can measure from outside: ` +
    `known=${known} b/s vs pose-derived=${pose.toFixed(2)} b/s`);
});

test("speed_delta is the post-friction residual, and says so by being smaller", { skip: !bridgeUp }, async () => {
  const samples = await sampleWhileWalking("player");
  assert.ok(samples.length >= 4, `need samples: ${samples.length}`);
  const known = median(samples.map((s) => s.known));
  const delta = median(samples.map((s) => s.delta));
  assert.ok(delta > 0.5, `a walking body has a real delta too: ${delta} b/s`);
  // MEASURED 2.31 against 4.23, i.e. 0.546 — exactly LivingEntity.travel's ground friction
  // (0.6 × 0.91). This is not an agreement check and must not be turned into one: the two keys
  // answer different questions, and a build where they matched would mean one of them had stopped
  // being what it claims.
  const ratio = delta / known;
  assert.ok(ratio > 0.3 && ratio < 0.9,
    `getDeltaMovement is what is LEFT after friction, not what was realized: ` +
    `delta=${delta} known=${known} ratio=${ratio.toFixed(2)} (expected ≈0.55 on ground)`);
});

test("a mob body's mirror needs no mirror — the override was the player's alone", { skip: !bridgeUp }, async () => {
  const samples = await sampleWhileWalking("walker");
  assert.ok(samples.length >= 3, `the walker must report while walking: ${samples.length} sample(s)`);
  const known = median(samples.map((s) => s.known));
  const pose = median(samples.map((s) => s.pose));
  assert.ok(known > 1.0, `a walking mob has a real known speed with no mirror at all: ${known} b/s`);
  assert.ok(Math.abs(known - pose) <= 0.3 * Math.max(known, pose),
    `a Mob never had the ServerPlayer override, so this agreed before J1 and must still: ` +
    `known=${known} pose-derived=${pose.toFixed(2)} b/s`);
  await cmd(`forceload remove ${STRIP[0]} ${STRIP[1]} ${STRIP[2]} ${STRIP[3]}`);
});
