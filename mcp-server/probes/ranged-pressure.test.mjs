// Live probes for RANGED PRESSURE — the gap that killed the watched survival runs.
//
// Two watched sessions, five deaths, three of them skeletons (2026-08-10, sessions w1-84997 and
// w3-86528). The charter's default loadout answers a bow with:
//
//     {id:"fight", trigger:{kind:"threats_nearby", within:6},      response:{op:"attack", nearest:true}}
//     {id:"dodge", trigger:{kind:"projectile_incoming", within:12}, response:{op:"strafe", ticks:14}}
//
// A skeleton engages from ~15 blocks. `fight` never fires (nothing within 6) and `dodge` strafes in
// place, so the DEFAULT loadout has no answer. The obvious repair is to widen `fight`'s radius —
// and this file exists because measuring that repair refuted the reason it was proposed.
//
// MEASURED 2026-08-11, three isolated 30s trials from a 15-block stand-off (body displacement,
// sampled every 5s):
//
//     reflex only     2.0  4.0  7.7  9.6  9.6  9.6      closes, then PLATEAUS
//     engage+reflex   2.0  4.0  7.5  9.3  9.3  9.3      indistinguishable — the reflex is the mover
//     engage only     0.0  9.2 19.2  DEAD               charges, and dies
//
// So `attack` DOES path (reading AttackGate as purely a reach gate was wrong). It closes ~9.6 of
// the 15 blocks and stops ~5 short — outside the F4 melee band — and the duel never resolves:
// the skeleton backs off as the body advances and the pair settle into an equilibrium the body
// cannot win and the reflex will not break. `engage defend` alone closes much harder and gets the
// body killed. Neither is a fix; both are pinned here so a future one is visibly different.
//
// WHY THIS PROBE IS DETERMINISTIC. Waiting for a skeleton to actually loose arrows makes the test
// a coin flip on mob AI and accuracy. The question is not "do arrows hurt" — it is "does any reflex
// response reduce the distance to a ranged attacker". So the arena is flat, line of sight is clear,
// and the measurement is the BODY'S OWN DISPLACEMENT from where it spawned, never the live body-to-
// mob gap: a skeleton walks, so that gap closes on its own and would credit the reflex with a
// closure the mob performed.
//
// Staged hostiles need PersistenceRequired:1b. An unpersisted mob dies INSTANTLY in
// Mob.checkDespawn whenever any player is online beyond the despawn distance, and probe files spawn
// fake players at their own sites — that is what deleted the obs-gap creeper under the battery
// (2026-08-09). NoAI does NOT cover it: checkDespawn is not AI.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const X = 4_200_000, Z = 4_200_000, Y = 100;
const SESSION = "probe-ranged-pressure";
const BODY = { x: X, y: Y + 1, z: Z };
const RANGE = 15;                       // skeleton stand-off: outside `fight`, inside a bow's reach
const SKELETON = { x: X + RANGE, y: Y + 1, z: Z };
// 20s, taken from the measurement above and not from taste: the approach is still climbing at 10s
// (~4 blocks) and only settles by 20s (~9.6). A 6s budget reads the middle of the walk and would
// score the plateau as "barely moved", failing for want of time rather than for cause.
const TICK_BUDGET_MS = 20000;

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

const box = `x=${X - 40},y=${Y - 8},z=${Z - 40},dx=80,dy=32,dz=80`;
// SWEEP EVERY NON-PLAYER, and only ever after the forceload. A forceloaded probe site keeps
// ticking and therefore keeps spawning; sweeping just the mob this file stages leaves the rest to
// pile up until a 1-v-1 test is silently a 1-v-crowd (combat-fixes, 2026-08-11: 21 residents, and
// the F4 duel failed as "the body must survive" — reading exactly like a combat regression it was
// not). Vanilla selectors only see LOADED chunks, so an unforceloaded sweep reports "No entity was
// found" over a site that get_entities — which pages chunks in — reads as full.
const clearMobs = () => cmd(`kill @e[type=!minecraft:player,${box}]`).catch(() => {});

async function skeleton() {
  const r = await call("get_entities", { origin: BODY, radius: 40 });
  return (r.entities || []).find((e) => e.type === "minecraft:skeleton");
}
// Tolerant on purpose: a body being shot at may DIE mid-measurement, and bot_status then refuses
// (no actuator). That is data, not a harness error — the caller decides what a missing body means.
async function bodyPos() {
  try {
    const s = await call("bot_status", {});
    return s.pos ?? null;
  } catch {
    return null;
  }
}
const dist2d = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok).catch(() => false);
if (!bridgeUp) console.log(`\n  [skip] no bridge at ${BASE} — start the dev server\n`);

describe("ranged pressure: can any reflex answer a stand-off attacker?", { skip: !bridgeUp }, () => {
  test("stage a flat arena with clear line of sight", async (t) => {
    if (!bridgeUp) return t.skip();
    await cmd(`forceload add ${X - 48} ${Z - 48} ${X + 48} ${Z + 48}`);
    await sleep(1500);
    await cmd(`fill ${X - 30} ${Y} ${Z - 30} ${X + 30} ${Y} ${Z + 30} minecraft:stone`);
    await cmd(`fill ${X - 30} ${Y + 1} ${Z - 30} ${X + 30} ${Y + 8} ${Z + 30} minecraft:air`);
    await sleep(400);
    await clearMobs();
    await sleep(300);
    // NO global `time set day` / `gamerule doMobSpawning false` here, tempting as it is: probe
    // files run CONCURRENTLY against one world, and a gamerule is world-wide state. Muting spawns
    // to steady THIS arena would silently disarm every other file's hostiles mid-run — the
    // cross-file version of the shared-site bug the site map exists to prevent. The per-test sweep
    // above is the local equivalent and costs nobody else anything.
  });

  test("GAP: `attack` closes on a stand-off attacker but stalls outside melee reach", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "despawn" }).catch(() => {});
    await clearMobs();
    await call("bot_body", { action: "spawn", type: "player", pos: BODY });
    await call("bot_body", { action: "engage", mode: "defend" });
    // A bow-armed, persistent skeleton that will not wander off or de-aggro into nothing.
    await cmd(`summon minecraft:skeleton ${SKELETON.x} ${SKELETON.y} ${SKELETON.z} `
      + `{PersistenceRequired:1b,HandItems:[{id:"minecraft:bow",count:1},{}]}`);
    await sleep(600);

    const sk = await skeleton();
    assert.ok(sk, "a skeleton should be staged at the stand-off range");
    const before = await bodyPos();
    assert.ok(before, "the body should report a position");
    const startDist = dist2d(before, sk.pos ?? SKELETON);
    assert.ok(startDist > 10, `stand-off should start beyond melee reach (was ${startDist.toFixed(1)})`);

    // The widened version of the charter's `fight` rule: if `attack` could close, a 16-block
    // trigger would be the fix and no new response op would be needed.
    await call("bot_reactions", {
      action: "arm",
      reactions: [{ id: "fight_far", trigger: { kind: "threats_nearby", within: 16 },
        response: { op: "attack", nearest: true } }],
    });
    await sleep(TICK_BUDGET_MS);

    const after = await bodyPos();
    // MEASURE THE BODY'S OWN DISPLACEMENT, not the live gap. A skeleton walks: it closes to its
    // preferred stand-off and strafes, so body↔mob distance shrinks even when the BODY never moved,
    // and an assertion on that gap would credit `attack` with a closure the mob performed.
    assert.ok(after, "the body should survive a 15-block stand-off for the tick budget");
    const walked = dist2d(after, BODY);
    const gap = dist2d(after, SKELETON);
    // BOTH HALVES ARE THE FINDING. It closes — so any fix framed as "make attack path" is already
    // done. And it stops short: the gap stays outside the F4 melee band (max 3.5), which is why a
    // watched survival run loses to archers while its reflex is dutifully firing. A real fix moves
    // the SECOND number under 3.5; if that happens this assertion fails and should be inverted.
    // Said out loud on every run, so the next red explains itself: the 0.132.0 battery had this
    // case walk 3.3 of 15.5 on a QUIET host (one game) and pass alone ten minutes later, as the
    // 0.128.0 battery had it walk 0.0 and then pass; no body, combat or navigation class changed
    // between the last green battery and either. Whatever differs is in the world, and these are
    // the world's own answers at the moment of the measurement.
    // 26.2: `time query day` reads the day TIMELINE ("Timeline minecraft:day is at N tick(s)"); `daytime` is gone.
    const daytime = ((await call("run_command", { command: "time query day" })).output ?? []).join(" ");
    const skNow = await skeleton();
    t.diagnostic(`walked ${walked.toFixed(1)}, gap ${gap.toFixed(1)}; ${daytime}; skeleton `
      + `${JSON.stringify(skNow ? { pos: skNow.pos, health: skNow.health, distance: skNow.distance } : null)}; body ${JSON.stringify(after)}`);
    assert.ok(walked > 5,
      `\`attack\` should close on a stand-off attacker (walked ${walked.toFixed(1)} of `
      + `${startDist.toFixed(1)} blocks)`);
    assert.ok(gap > 3.5,
      `\`attack\` reached the melee band (gap ${gap.toFixed(1)}) — the stall is fixed and this `
      + "probe should now assert the fight RESOLVES, not that it stalls");
  });

  test("`flee` DOES move the body away from a stand-off attacker", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "despawn" }).catch(() => {});
    await clearMobs();
    await call("bot_body", { action: "spawn", type: "player", pos: BODY });
    await call("bot_body", { action: "engage", mode: "defend" });
    await cmd(`summon minecraft:skeleton ${SKELETON.x} ${SKELETON.y} ${SKELETON.z} `
      + `{PersistenceRequired:1b,HandItems:[{id:"minecraft:bow",count:1},{}]}`);
    await sleep(600);

    const sk = await skeleton();
    assert.ok(sk, "a skeleton should be staged");
    const before = await bodyPos();
    const startDist = dist2d(before, sk.pos ?? SKELETON);

    await call("bot_reactions", {
      action: "arm",
      reactions: [{ id: "break_los", trigger: { kind: "threats_nearby", within: 16 },
        response: { op: "flee" } }],
    });
    await sleep(TICK_BUDGET_MS);

    const after = await bodyPos();
    assert.ok(after, "the body should survive the flee window");
    // Same measure as the gap test, for a like-for-like comparison: how far did the BODY itself
    // travel, and did it travel AWAY. The charter already tells the model to break line of sight;
    // this asks whether the response vocabulary can do it unattended. An actual occluder is
    // terrain-dependent and this arena deliberately has none, so opening range is the observable.
    const walked = dist2d(after, BODY);
    const endGap = dist2d(after, SKELETON);
    assert.ok(walked > 3 && endGap > startDist,
      `flee should carry the body away from a stand-off attacker: walked ${walked.toFixed(1)} `
      + `blocks, gap ${startDist.toFixed(1)} -> ${endGap.toFixed(1)}`);
  });

  test("cleanup: clear the stage", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_reactions", { action: "clear" }).catch(() => {});
    await call("bot_body", { action: "despawn" }).catch(() => {});
    await clearMobs();

    await cmd("gamerule doMobSpawning true");
    await cmd(`forceload remove ${X - 48} ${Z - 48} ${X + 48} ${Z + 48}`);
  });
});
