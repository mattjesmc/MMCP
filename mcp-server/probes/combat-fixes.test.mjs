// Live probes for the F-BLOCK combat/dig honesty fixes (world-model/V3_PLAN.md §2, toolkit
// 0.69.0) — the expert stops cheating. Each case inverts an AUDITED live defect (EVAL_AUDIT_V2.md
// §10) into an assertion:
//
//   1. F1/LOS:     bot_attack on a zombie behind a 1-thick wall → refused `occluded`, the wall is
//                  intact and the zombie unhurt (the audited hit-through-stone kill, inverted).
//   2. F1/facing:  bot_attack on a zombie directly BEHIND the body → {started, action_id,
//                  eta_ticks}, completes via action_completed only after the body has turned; the
//                  final yaw is within epsilon of the target bearing and the hit landed.
//   3. F2/hidden:  bot_mine on the wall-behind-block shape (target hidden from the stand, far
//                  faces exposed) → refused `occluded`, block untouched (the audited through-wall
//                  dig-and-collect, inverted).
//   4. F2/visible: bot_mine on the same block once the wall is gone → digs and clears it.
//   5. F2/peek:    ONE block, ONE pillar, two stands — refused `occluded` from due west (the
//                  pillar seals that line), mined from two cells off-axis where the target's −z
//                  face is plainly in view. The audit found `bot_target destroy` already honest in
//                  this third shape ("side-peekable → legal peek"); the raw path must agree, or
//                  F2 would have bought refusal by breaking legal digs.
//   6. F3/pen:     reflex flee inside a 3-sided pen (walls 4 high, NoAI threat inside) picks an
//                  OPEN heading and re-picks off the back wall instead of grinding into it — the
//                  body escapes through the opening (the audited corner-death, inverted).
//   7. F4/clamp:   fight+kite range 6 with EMPTY HANDS → the reply reports the range clamped into
//                  the melee band (≤ 3.5) — kite-at-6-with-no-weapon is unrequestable now.
//   8. F4/kite:    THE DEATH SCENARIO ITSELF, re-issued. §10 item 3: a full-health walker in
//                  fight/kite(6) versus ONE zombie died in ~170 ticks WITHOUT LANDING A SINGLE
//                  SWING. Same request, live zombie: the body must SURVIVE and must LAND SWINGS.
//                  Both, deliberately — survival alone passes on a bug that runs away forever.
//   9. F5/vantage: a bow fight with a ledge available stations ABOVE the threat (dy > 0) and
//                  climbs to it — the elevation-weighted Vantage candidates, not the flat ring.
//  10. F1/reflex:  the REFLEX swing — the path that audited as hitting through an intact wall, and
//                  one of the two the turn machinery makes fragile (it holds the body across turn
//                  ticks). Refused with the wall up; lands after turning with the wall gone.
//  11. F1/queue:   the bot_run ATTACK STEP — the other fragile path. Refused `occluded` through
//                  the wall, and with the wall gone the queue PARKS on the async swing and
//                  RESUMES (before F1 an attack step was always synchronous, so nothing exercised
//                  QueueRunner's new wait-for-the-turn branch).
//
// Staged hostiles carry NoAI:1b (determinism) + PersistenceRequired:1b (checkDespawn discards
// unpersisted hostiles INSTANTLY when any player is online >128 blocks away — and probe files
// spawn fake players at their own sites; live-caught at 0.68.0). The two fights are ROOFED: the
// site is open sky at y=200, and a zombie that dies of sunburn would forge the evidence.
//
// OWNS SITE 1,950,000 (site-map.test.mjs guards uniqueness). Own session. Run with
// `npm run test:live` or tools/battery.ps1 -Only combat-fixes.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const X = 1_950_000, Z = 1_950_000, Y = 200;
const SESSION = "probe-combat-fixes";
const ORIGIN = { x: X, y: Y + 1, z: Z };
// Every case keeps its own geometry: a real zombie chases, a flee runs, and a fight that drifts
// must never land on another case's staging.
const PX = X + 40, PZ = Z;        // F3's 3-sided pen
const SPX = X, SPZ = Z + 8;       // F2's side-peek pillar (clear of the origin dig shapes)
const KX = X, KZ = Z + 40;        // F4's kite duel
const VX = X + 40, VZ = Z + 40;   // F5's archer ledge
const RX = X + 20, RZ = Z + 20;   // F1's reflex-swing arena (≥20 blocks from every other case)
const QX = X + 20, QZ = Z + 52;   // F1's bot_run attack-step arena
const AX = X - 12, AZ = Z + 50;   // F6's auto-arm arena (inside band 4, 32 blocks off QX/QZ)
// `/fill` caps at 32768 cells (learned the hard way — a silent over-cap leaves half a floor), so
// the arena floor is laid in z-bands rather than one command. Staging and cleanup share them.
const BANDS = [[Z - 16, Z + 4], [Z + 5, Z + 24], [Z + 25, Z + 44], [Z + 45, VZ + 16]];

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
const wrapDeg = (d) => ((d + 180) % 360 + 360) % 360 - 180;

async function zombie(origin = ORIGIN, radius = 32) {
  const r = await call("get_entities", { origin, radius });
  return (r.entities || []).find((e) => e.type === "minecraft:zombie");
}
// The box spans the WHOLE site (every arena): a standing `kind` rule designates any zombie
// within 24 blocks, so a leftover in one arena is a live target in the next test.
//
// SWEEPS EVERY NON-PLAYER, not just zombies. A forceloaded site keeps TICKING, so it keeps
// SPAWNING: found live 2026-08-11 with 21 entities resident here — 4 zombies, 3 skeletons and
// 6 creepers — because this sweep only ever removed the zombies it staged itself. The F4 duel
// then ran as a 1-v-crowd with an archer in it and failed on "the body must survive", which reads
// exactly like a combat regression and is not one. tunnel-descend learned this in 2026-08-09 and
// already sweeps `type=!minecraft:player`; this is the same lesson, arriving late.
//
// (The residents are invisible to a bare `/kill` until the chunks are loaded — vanilla selectors
// only see loaded chunks, while get_entities pages them in, which is why the site can read empty
// from a command and full from a tool. The sweep therefore has to run AFTER the forceload.)
const killZombies = () => cmd(
  `kill @e[type=!minecraft:player,x=${X - 20},y=${Y - 6},z=${Z - 20},dx=100,dy=40,dz=100]`
).catch(() => {});

/** Staging NBT for the two F1-path cases (10, 11): NoAI (determinism) + PersistenceRequired
 *  (checkDespawn discards unpersisted hostiles instantly when a player is online >128 blocks away)
 *  + A HELMET. Those cases assert health EQUALITY across a refusal window, and this site is open
 *  sky at y=200: a sunburning zombie loses health on its own AND spends the swing that follows in
 *  fire i-frames, which reads as a hit that never landed. A non-empty HEAD slot suppresses the
 *  ignition outright (Mob.burnUndead damages the helmet instead of igniting). */
// The HELMET is not decoration and it belongs on EVERY staged hostile in this file, not only on the
// F6 block that introduced it. This site is open sky at y=200: a bare zombie SUNBURNS, and several
// cases here assert an exact health number. F1/LOS ("the zombie must be unhurt") failed on
// 2026-08-13 with 18 !== 19 — the swing was correctly refused through the wall and the daylight took
// the point instead, which is evidence forged against a fix that was working. It passes at night,
// so a long-lived dev server is what exposes it; a probe whose verdict depends on the world clock is
// not a probe. Same reason combat-kit's staging carries one from its first line.
const STAGED = `{NoAI:1b,PersistenceRequired:1b,equipment:{head:{id:"minecraft:iron_helmet",count:1}}}`;

/**
 * The weapon a swing actually LANDED with, whether the reply was the synchronous verdict or the
 * body had to turn first.
 *
 * The F6 cases stage the target straight ahead so the swing is normally synchronous, but "normally"
 * is not "always": any tick of gaze drift between `bot_look` and `bot_attack` — a lingering
 * engagement aiming the head, a target nudged a fraction off the bearing — makes the swing an async
 * act whose reply is `{started, action_id}`. Both are correct behaviour, and asserting on the
 * synchronous shape alone made these three cases pass or fail on which of the two the run happened
 * to get (caught 2026-08-12: they passed only while an earlier case had left combat engaged, i.e.
 * while something else was aiming the body for them). 0.71.0 put `weapon` on the completion event
 * for exactly this reason — a swing that landed after a turn must still say what it hit with — so
 * the probe reads the fact from wherever the run put it.
 */
async function swungWith(r, cursor) {
  if (r.weapon !== undefined && r.weapon !== null) return String(r.weapon);
  if (!r.started) return "";
  const done = await waitEvent("action_completed", cursor, 8000,
    (e) => e.data?.action === "bot_attack" && e.data?.action_id === r.action_id);
  return String(done?.data?.weapon ?? "");
}

/** What the hand holds right now — bot_status carries it inside `inventory`, not at top level. */
async function heldItem() {
  const r = await call("bot_status", { inventory: true });
  return String(r.inventory?.held ?? "");
}

/** The serialized palette for ONE cell — get_blocks_at answers palette+rows, and for a single
 *  queried block the palette naming a block IS that cell's content. */
async function blockAt(x, y, z) {
  const r = await call("get_blocks_at", { blocks: [{ x, y, z }] });
  return JSON.stringify(r.palette ?? r);
}

async function nowCursor() {
  let cursor;
  for (;;) {
    const r = await call("get_events", cursor ? { cursor, limit: 200 } : { limit: 200 });
    cursor = r.cursor;
    if (!r.more && (r.events || []).length < 200) return cursor;
  }
}
async function waitEvent(type, cursor, timeoutMs, pred = () => true) {
  const deadline = Date.now() + timeoutMs;
  let cur = cursor;
  while (Date.now() < deadline) {
    const r = await call("get_events", { cursor: cur, type, wait_ms: 1500 });
    for (const e of r.events || []) if (e.type === type && pred(e)) return e;
    cur = r.cursor ?? cur;
  }
  return null;
}

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok).catch(() => false);
if (!bridgeUp) console.log(`\n  [skip] no bridge at ${BASE} — start the dev server\n`);

describe("combat fixes: attack LOS/facing, occluded dig, flee pen, engage range/vantage", { skip: !bridgeUp }, () => {
  test("stage the site", async (t) => {
    if (!bridgeUp) return t.skip();
    await cmd(`forceload add ${X - 32} ${Z - 32} ${VX + 32} ${VZ + 32}`);
    await sleep(1500);
    for (const [z0, z1] of BANDS) {
      await cmd(`fill ${X - 16} ${Y} ${z0} ${VX + 24} ${Y} ${z1} minecraft:stone`);
      await cmd(`fill ${X - 16} ${Y + 1} ${z0} ${VX + 24} ${Y + 10} ${z1} minecraft:air`);
    }
    await sleep(400);
    await call("bot_reactions", { action: "clear" });
    await killZombies();
  });

  test("F1/LOS: attack through a wall → refused occluded, wall intact, target unhurt", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "spawn", type: "player", pos: ORIGIN });
    await call("bot_give", { item: "minecraft:iron_sword", count: 1 });
    await call("bot_select", { item: "iron_sword" });
    const b = (await call("bot_status")).pos;
    // 1-thick wall in the next +x column; zombie just behind it, INSIDE swing reach (the player
    // body's honest reach is ~3.0 now) so the refusal must come from the LOS gate, not range.
    const wx = Math.floor(b.x) + 1;
    await cmd(`fill ${wx} ${Y + 1} ${Math.floor(b.z) - 2} ${wx} ${Y + 4} ${Math.floor(b.z) + 2} minecraft:stone`);
    await cmd(`summon minecraft:zombie ${wx + 1.5} ${Y + 1} ${b.z} ${STAGED}`);
    await sleep(400);
    const target = await zombie();
    assert.ok(target, "staged zombie present");
    const hpBefore = target.health;
    const r = await call("bot_attack", { target: target.id });
    assert.equal(r.ok, false, `a swing must not land through a wall: ${JSON.stringify(r)}`);
    assert.equal(r.reason, "occluded", JSON.stringify(r));
    await sleep(300);
    const after = await zombie();
    assert.ok(after, "the zombie must still exist (the audited repro KILLED it through the wall)");
    assert.equal(after.health, hpBefore, `the zombie must be unhurt: ${JSON.stringify(after)}`);
    const wall = await blockAt(wx, Y + 2, Math.floor(b.z));
    assert.match(String(wall), /stone/, `the wall must be intact: ${wall}`);
    await killZombies();
    await cmd(`fill ${wx} ${Y + 1} ${Math.floor(b.z) - 2} ${wx} ${Y + 4} ${Math.floor(b.z) + 2} minecraft:air`);
  });

  test("F1/facing: attack behind the back turns first, then lands — async act contract", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "spawn", type: "player", pos: ORIGIN });
    await call("bot_give", { item: "minecraft:iron_sword", count: 1 });
    await call("bot_select", { item: "iron_sword" });
    await call("bot_look", { yaw: 0, pitch: 0 }); // face +z, exactly
    const b = (await call("bot_status")).pos;
    // Directly BEHIND the body (-z of a yaw-0 facing), inside reach, LOS clear.
    await cmd(`summon minecraft:zombie ${b.x} ${Y + 1} ${b.z - 2} ${STAGED}`);
    await sleep(400);
    const target = await zombie();
    assert.ok(target, "staged zombie present");
    const c0 = await nowCursor();
    const r = await call("bot_attack", { target: target.id });
    // The audited defect: this used to land SYNCHRONOUSLY with yaw pointing away. Now it must be
    // a short act — a rate-limited turn, then the swing.
    assert.equal(r.started, true, `a 180° attack must start a turn, not hit instantly: ${JSON.stringify(r)}`);
    assert.ok(r.action_id, JSON.stringify(r));
    assert.ok(r.eta_ticks >= 1, JSON.stringify(r));
    const done = await waitEvent("action_completed", c0, 6000,
      (e) => e.data?.action === "bot_attack" && e.data?.action_id === r.action_id);
    assert.ok(done, "the swing must complete via action_completed after the turn");
    assert.equal(done.data.hit, true, JSON.stringify(done.data));
    // The body ended FACING the target: compare against the TRUE bearing from the body's actual
    // position to the zombie's actual position (vanilla `summon` center-corrects integer coords
    // and a spawned body can stand on a block corner, so a hardcoded 180° would lie by ~18°).
    const st = await call("bot_status");
    const zAfter = await zombie();
    assert.ok(zAfter, "the NoAI punchbag survives one sword hit");
    assert.ok(zAfter.health < 20, `the hit landed: ${JSON.stringify(zAfter)}`);
    const bearing = Math.atan2(zAfter.pos.z - st.pos.z, zAfter.pos.x - st.pos.x) * 180 / Math.PI - 90;
    assert.ok(Math.abs(wrapDeg(st.yaw - bearing)) <= 12,
      `final yaw must be within epsilon of the target bearing ${bearing.toFixed(1)}°, got ${st.yaw}`);
    assert.ok(Math.abs(wrapDeg(st.yaw)) >= 90,
      `the body started at yaw 0 and the target was behind it — it must have genuinely turned, got ${st.yaw}`);
    await killZombies();
  });

  test("F2/hidden: bot_mine on a block hidden behind a wall → refused occluded, block untouched", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "spawn", type: "player", pos: ORIGIN });
    const b = (await call("bot_status")).pos;
    const wx = Math.floor(b.x) + 1; // wall column: 3 wide, 3 high — every ray from the eye meets it
    const tz = Math.floor(b.z);
    await cmd(`fill ${wx} ${Y + 1} ${tz - 1} ${wx} ${Y + 3} ${tz + 1} minecraft:stone`);
    // The target hides directly behind the wall at eye height; its far faces are exposed (nothing
    // beyond it) — the exact audited shape bot_mine dug and collected through intact stone.
    const at = { x: wx + 1, y: Y + 2, z: tz };
    await cmd(`setblock ${at.x} ${at.y} ${at.z} minecraft:oak_planks`);
    await sleep(300);
    const r = await call("bot_mine", { at });
    assert.equal(r.started, false, `a hidden block must refuse the dig: ${JSON.stringify(r)}`);
    assert.equal(r.reason, "occluded", JSON.stringify(r));
    const still = await blockAt(at.x, at.y, at.z);
    assert.match(String(still), /oak_planks/, `the hidden block must be untouched: ${still}`);
  });

  test("F2/visible: the same block with the wall gone still mines normally", async (t) => {
    if (!bridgeUp) return t.skip();
    const b = (await call("bot_status")).pos;
    const wx = Math.floor(b.x) + 1;
    const tz = Math.floor(b.z);
    const at = { x: wx + 1, y: Y + 2, z: tz };
    await cmd(`fill ${wx} ${Y + 1} ${tz - 1} ${wx} ${Y + 3} ${tz + 1} minecraft:air`);
    await sleep(300);
    const r = await call("bot_mine", { at, wait: true });
    // ASSERT THE SUCCESS, NOT THE ABSENCE OF ONE SHAPE OF FAILURE (S14). `!(r.started === false)`
    // is satisfied by any reply that simply isn't a start-refusal — it never checked that a dig
    // happened. With `wait`:true a completed dig answers the action_completed payload itself, so
    // the honest assertion is the block that came out of the ground.
    assert.equal(r.mined, "minecraft:oak_planks",
      `a visible in-reach block must still dig — F2 must refuse the hidden shape WITHOUT costing `
      + `the legal one: ${JSON.stringify(r)}`);
    await sleep(500);
    const now = await blockAt(at.x, at.y, at.z);
    assert.match(String(now), /air/, `the block must be gone after the dig: ${now}`);
  });

  test("F2/peek: the SAME block refuses from due west and mines from the side-peek stand", async (t) => {
    if (!bridgeUp) return t.skip();
    // The third audited shape, and the one F2 could most easily have broken: `bot_target destroy`
    // already conceded `occluded` when enclosed and `unreachable` when walled in, but PEEKED
    // legally when a face was in view — "a real player could do the same" (§10 item 2). A refusal
    // gate that also kills the peek is not honesty, it is a smaller body.
    //
    // Geometry: a 3-tall PILLAR one cell west of the target. From due west, every ray the touch
    // solver casts (nearest-face point, and the −x face centre — the eye sits 0.12 above the
    // target's centre, so no y ray is cast at all) runs the length of the pillar. Two cells off
    // axis in z, the −z face centre ray clears the pillar's corner with ~0.4 blocks to spare and
    // ends inside the target: one visible face, which is all a swing needs.
    await call("bot_body", { action: "spawn", type: "player", pos: { x: SPX, y: Y + 1, z: SPZ } });
    const west = (await call("bot_status")).pos;
    const tx = Math.floor(west.x) + 3, ty = Y + 2, tz = Math.floor(west.z);
    await cmd(`fill ${tx - 1} ${Y + 1} ${tz} ${tx - 1} ${Y + 3} ${tz} minecraft:stone`);
    await cmd(`setblock ${tx} ${ty} ${tz} minecraft:oak_planks`);
    await sleep(300);

    const blind = await call("bot_mine", { at: { x: tx, y: ty, z: tz } });
    assert.equal(blind.started, false,
      `from due west the pillar seals the target — the dig must refuse: ${JSON.stringify(blind)}`);
    assert.equal(blind.reason, "occluded", JSON.stringify(blind));

    // Step aside. Same block, same pillar, same reach — only the STAND changed.
    await call("bot_body", { action: "spawn", type: "player", pos: { x: tx - 2, y: Y + 1, z: tz - 2 } });
    await sleep(300);
    const peek = await call("bot_mine", { at: { x: tx, y: ty, z: tz }, wait: true });
    assert.ok(!(peek.started === false),
      `a face peekable from THIS stand is a legal dig — F2 must not have cost the peek: ${JSON.stringify(peek)}`);
    await sleep(500);
    const now = await blockAt(tx, ty, tz);
    assert.match(String(now), /air/, `the peeked block must be gone: ${now}`);
    await cmd(`fill ${tx - 1} ${Y + 1} ${tz - 1} ${tx} ${Y + 3} ${tz + 1} minecraft:air`);
  });

  test("F3/pen: flee inside a 3-sided pen takes an open heading and escapes", async (t) => {
    if (!bridgeUp) return t.skip();
    // Pen: interior ~7x7, walls 4 high on north (z-), east (x+), south (z+); OPEN to the west.
    await cmd(`fill ${PX - 3} ${Y + 1} ${PZ - 3} ${PX + 3} ${Y + 4} ${PZ - 3} minecraft:stone`); // N
    await cmd(`fill ${PX + 3} ${Y + 1} ${PZ - 3} ${PX + 3} ${Y + 4} ${PZ + 3} minecraft:stone`); // E
    await cmd(`fill ${PX - 3} ${Y + 1} ${PZ + 3} ${PX + 3} ${Y + 4} ${PZ + 3} minecraft:stone`); // S
    // SWEEP FIRST. This test's whole premise is a KNOWN away-vector: the staged zombie sits south,
    // so "away" points north into the wall and the escape must come from a ±90° re-pick. Any other
    // threat within the 8-block trigger silently re-aims that vector, and FLEE_OFFSETS spans only
    // ±90° — so a stray mob west of the body aims "away" EAST, no candidate covers the open west
    // side, and the body wedges in the north-east corner reporting `blocked`. That is exactly the
    // intermittent this test showed on 2026-08-11 (fail/pass/fail), and it is reproducible on
    // demand: a threat placed west wedges the body at (PX+2.7, PZ-1.7) 5 runs out of 5 — the same
    // corner the failing run ended in. The sweep makes the staged zombie the only threat, which is
    // what the assertion has always assumed.
    await killZombies();
    await call("bot_body", { action: "spawn", type: "player", pos: { x: PX + 2, y: Y + 1, z: PZ } });
    // NoAI threat 2 south of the body, inside the pen: "away" points square at the NORTH wall —
    // the audited grind heading. Open directions exist only at ±90° (west, through the opening).
    await cmd(`summon minecraft:zombie ${PX + 2.5} ${Y + 1} ${PZ + 2.5} ${STAGED}`);
    await sleep(400);
    const start = (await call("bot_status")).pos;
    await call("bot_reactions", {
      action: "arm",
      reactions: [{
        id: "flee",
        trigger: { kind: "threats_nearby", within: 8, count: 1 },
        response: { op: "flee", ticks: 60, speed: 0.5 },
        cooldown_ticks: 5,
      }],
    });
    // THE ESCAPE IS THE ASSERTION, AND IT IS POLLED, NOT SAMPLED AFTER A FIXED SLEEP (S14). The
    // first cut read one position after a flat 5s and asked for ≥3 blocks of travel — a number
    // that is comfortable only against the CHEATING flee, which wrote 0.5 blocks/tick straight
    // into Entity.move (~10 blocks/s, ≈2.3× sprint). The flee is an INPUT FRAME now: Reflexes maps
    // `speed` onto input fraction against the ~0.216 b/t walk gait, so 0.5 is simply "full walk",
    // ~4.3 blocks/s — and the re-picks off the north wall, plus the cooldown gaps between legs,
    // eat into any fixed window. A distance-in-5s assertion would therefore be measuring the
    // physics fix, not the heading fix, and would fail spuriously for the right behaviour.
    //
    // So: poll until the body is WEST OF THE PEN MOUTH. That is strictly STRONGER than the old
    // `x < PX-1` (which is still inside the pen — the interior runs to x = PX-2); the N/S walls
    // start at x = PX-3, so x < PX-3 means the body is out. The deadline is ~10× the legal walk
    // time for those ~5 blocks; the old flee never escapes it at any speed, because it ground into
    // the north wall and gave up.
    const t0 = Date.now();
    const escapeBy = t0 + 20000;
    let end = start, escaped = false;
    while (Date.now() < escapeBy) {
      await sleep(300);
      end = (await call("bot_status")).pos;
      if (end.x < PX - 3) {
        escaped = true;
        break;
      }
    }
    const moved = Math.hypot(end.x - start.x, end.z - start.z);
    assert.ok(escaped, `flee must LEAVE the pen by its open west side, not grind the north wall: `
      + `moved ${moved.toFixed(2)} blocks in ${((Date.now() - t0) / 1000).toFixed(1)}s and ended at `
      + `${JSON.stringify(end)} — the mouth is at x ${PX - 3} (start ${JSON.stringify(start)})`);
    await call("bot_reactions", { action: "clear" });
    await killZombies();
    await cmd(`fill ${PX - 3} ${Y + 1} ${PZ - 3} ${PX + 3} ${Y + 4} ${PZ + 3} minecraft:air`);
  });

  test("F3b/dead-end: flee leaves past the threat when that is the ONLY exit", async (t) => {
    if (!bridgeUp) return t.skip();
    // The pen again, threat moved to the OPEN side. "Away" now points EAST, square into the east
    // wall, and every heading within ±90° of it is walled — so the pre-F3b fan had no candidate for
    // the one way out and the body wedged in a corner reporting `blocked`, 5 runs out of 5, until
    // something killed it. That is the audit's "flees into corners" defect, which F3 narrowed and
    // did not close: it fixed grinding when a better heading existed, not the dead end.
    //
    // Two changes make this pass, and the test is deliberately blind to which one carries it:
    // cover-seeking (Vantage.cover — a reachable cell the threat cannot SEE) usually finds the
    // outside of the pen directly, and the widened FLEE_OFFSETS (±135/180, last resorts) let the
    // fan squeeze past the mob when cover does not. Either is a legitimate escape.
    await cmd(`fill ${PX - 3} ${Y + 1} ${PZ - 3} ${PX + 3} ${Y + 4} ${PZ - 3} minecraft:stone`); // N
    await cmd(`fill ${PX + 3} ${Y + 1} ${PZ - 3} ${PX + 3} ${Y + 4} ${PZ + 3} minecraft:stone`); // E
    await cmd(`fill ${PX - 3} ${Y + 1} ${PZ + 3} ${PX + 3} ${Y + 4} ${PZ + 3} minecraft:stone`); // S
    await killZombies();
    await call("bot_body", { action: "spawn", type: "player", pos: { x: PX + 2, y: Y + 1, z: PZ } });
    // NoAI so it never chases: the geometry is the test, not the mob's pathing.
    await cmd(`summon minecraft:zombie ${PX - 1} ${Y + 1} ${PZ} ${STAGED}`);
    await sleep(400);
    await call("bot_reactions", {
      action: "arm",
      reactions: [{
        id: "flee",
        trigger: { kind: "threats_nearby", within: 8, count: 1 },
        response: { op: "flee", ticks: 60, speed: 0.5 },
        cooldown_ticks: 5,
      }],
    });
    const t0 = Date.now();
    let end = null, escaped = false;
    while (Date.now() - t0 < 20000) {
      await sleep(300);
      end = (await call("bot_status")).pos;
      if (end.x < PX - 3) {
        escaped = true;
        break;
      }
    }
    assert.ok(escaped, `flee must find the one exit even though it lies past the threat — wedged at `
      + `${JSON.stringify(end)} after ${((Date.now() - t0) / 1000).toFixed(1)}s (mouth at x ${PX - 3})`);
    await call("bot_reactions", { action: "clear" });
    await killZombies();
    await cmd(`fill ${PX - 3} ${Y + 1} ${PZ - 3} ${PX + 3} ${Y + 4} ${PZ + 3} minecraft:air`);
  });

  test("F4/clamp: fight+kite range 6 with empty hands reports a melee-band range (≤ 3.5)", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "spawn", type: "player", pos: ORIGIN }); // fresh: empty hands
    const r = await call("bot_body", { action: "engage", mode: "fight", policy: "kite", range: 6 });
    assert.ok(typeof r.range === "number" && r.range <= 3.5,
      `an unarmed kite must station inside swing reach — the audited death was kite@6 vs reach 3: ${JSON.stringify(r)}`);
    assert.equal(r.range_clamped, true, `the clamp must be disclosed: ${JSON.stringify(r)}`);
    await call("bot_body", { action: "engage", on: false, clear_targets: true });
  });

  test("F4/kite: the audited kite-vs-zombie duel, inverted — the body survives AND lands swings", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_reactions", { action: "clear" });
    await killZombies();
    // ROOF THE DUEL. The site is open sky at y=200: a daylight zombie burns, and a zombie that
    // dies of sunburn would forge the swing evidence out of fire damage.
    await cmd(`fill ${KX - 12} ${Y + 8} ${KZ - 12} ${KX + 12} ${Y + 8} ${KZ + 12} minecraft:stone`);
    await call("bot_body", { action: "spawn", type: "player", pos: { x: KX, y: Y + 1, z: KZ } });
    await call("bot_give", { item: "minecraft:iron_sword", count: 1 });
    await call("bot_select", { item: "iron_sword" });
    // The `fight` reflex exactly as preset:"survival" arms it — this is the loadout the audited
    // body had, and the one that never got to fire because the station sat outside its reach.
    await call("bot_reactions", {
      action: "arm",
      reactions: [{
        id: "fight",
        trigger: { kind: "threats_nearby", within: 6 },
        response: { op: "attack", nearest: true },
        priority: 30,
        cooldown_ticks: 10,
      }],
    });
    const designated = await call("bot_target", { action: "attack", target: { kind: "zombie" } });
    assert.equal(designated.standing_rule, true, JSON.stringify(designated));
    // THE AUDITED REQUEST, VERBATIM: fight + kite at 6. It used to station the body 6 blocks out
    // with a melee reach of 3 (the standing rule could never fire) and walk, not sprint, so it
    // could not open distance either — 20 → 0 in ~170 ticks. Now the sword clamps the station
    // into swing reach and repositioning sprints.
    const eng = await call("bot_body", { action: "engage", mode: "fight", policy: "kite", range: 6 });
    assert.ok(eng.range <= 3.5, `a sword kite must station inside swing reach: ${JSON.stringify(eng)}`);
    assert.equal(eng.range_clamped, true, JSON.stringify(eng));
    // A fresh player body carries vanilla's 60-tick spawn invulnerability. Spend it BEFORE the
    // zombie exists, or "survived" measures the grace period instead of the fix.
    await sleep(4000);
    const cursor = await nowCursor();
    await cmd(`summon minecraft:zombie ${KX + 6.5} ${Y + 1} ${KZ + 0.5} {PersistenceRequired:1b,equipment:{head:{id:"minecraft:iron_helmet",count:1}}}`);

    let cur = cursor;
    let hits = 0, alive = true, health = null, enemyDown = false;
    // The audited death took ~170 ticks; this window is a comfortable multiple of it, and the loop
    // leaves early the moment the enemy is down (that fight is over, and it was won).
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      await sleep(200); // the poll is three round trips — pace it, the battery shares this server
      // Landed swings are read off the event stream, not off the enemy's health bar: every hit
      // emits action_completed {action:"bot_attack", hit:true}, and health could fall for reasons
      // that are not a swing.
      const ev = await call("get_events", { cursor: cur, type: "action_completed", wait_ms: 400 });
      cur = ev.cursor ?? cur;
      for (const e of ev.events || []) {
        if (e.type === "action_completed" && e.data?.action === "bot_attack" && e.data?.hit === true) {
          hits++;
        }
      }
      const st = await call("bot_status");
      alive = st.spawned === true;
      health = st.health ?? null;
      if (!alive) break; // body_died despawns the body — the audited outcome, verbatim
      if (!(await zombie({ x: KX, y: Y + 1, z: KZ }, 24))) {
        enemyDown = true; // the fight is over and it was won
        break;
      }
    }
    assert.ok(alive, "the body must survive the duel — it died (body_died despawns the body, so "
      + `bot_status answers spawned:false) after landing ${hits} hits`);
    assert.ok(health > 0, `the body must end the duel alive: health ${health}`);
    assert.ok(hits > 0, "the body must LAND SWINGS, not merely survive — a kite that runs away "
      + `forever also survives: ${hits} landed hits, enemy ${enemyDown ? "dead" : "alive"}, `
      + `body health ${health}`);
    await call("bot_reactions", { action: "clear" });
    await call("bot_body", { action: "engage", on: false, clear_targets: true });
    await killZombies();
    await cmd(`fill ${KX - 12} ${Y + 8} ${KZ - 12} ${KX + 12} ${Y + 8} ${KZ + 12} minecraft:air`);
  });

  test("F5/vantage: a bow fight with a ledge available stations ABOVE the threat and takes it", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_reactions", { action: "clear" });
    await killZombies();
    await cmd(`fill ${VX - 12} ${Y + 8} ${VZ - 12} ${VX + 24} ${Y + 8} ${VZ + 12} minecraft:stone`);
    // THE LEDGE: a 4-high plateau east of the threat, walking surface at Y+5 — dy +4 over the
    // zombie's feet, inside Vantage's ±6 column probe and past its dy ≥ 2 preference. Candidate
    // rings are sampled at 3/6/9/12 blocks from the target, so the plateau is built to span the
    // 9-ring, which is where a bow's stand range of 10 wants to be.
    await cmd(`fill ${VX + 7} ${Y + 1} ${VZ - 8} ${VX + 16} ${Y + 4} ${VZ + 8} minecraft:stone`);
    // A walkable stair up the plateau's east face. The body starts at its foot: a chosen stand it
    // could never reach would be a preference, not a fix.
    await cmd(`fill ${VX + 17} ${Y + 1} ${VZ - 2} ${VX + 17} ${Y + 3} ${VZ + 2} minecraft:stone`);
    await cmd(`fill ${VX + 18} ${Y + 1} ${VZ - 2} ${VX + 18} ${Y + 2} ${VZ + 2} minecraft:stone`);
    await cmd(`fill ${VX + 19} ${Y + 1} ${VZ - 2} ${VX + 19} ${Y + 1} ${VZ + 2} minecraft:stone`);
    await call("bot_body", { action: "spawn", type: "player", pos: { x: VX + 20, y: Y + 1, z: VZ } });
    await call("bot_give", { item: "minecraft:bow", count: 1 });
    // ARROWS TOO, since 0.72.0. "Ranged" used to mean "a bow is in the hand"; it now means the
    // body CARRIES a projectile weapon it can FEED (CombatKit.rangedCapable), because a bow with
    // an empty quiver is not a ranged capability — it is a stick that keeps the body at 10 blocks
    // doing nothing, which is a worse death than closing. The case is unchanged in what it tests
    // (an archer stations ABOVE its target); its loadout now expresses the capability it means to
    // stage instead of relying on the old held-item shorthand.
    await call("bot_give", { item: "minecraft:arrow", count: 16 });
    await call("bot_select", { item: "minecraft:bow" });
    await cmd(`summon minecraft:zombie ${VX + 0.5} ${Y + 1} ${VZ + 0.5} ${STAGED}`);
    await sleep(500);
    const threat = await zombie({ x: VX, y: Y + 1, z: VZ }, 32);
    assert.ok(threat, "staged threat present");
    await call("bot_target", { action: "attack", target: { kind: "zombie" } });
    // `range` is stated even though 10 is the bow's default: the slot still remembers the earlier
    // cases' explicit 6, and a stand range of 6 samples only the 3/6 rings — short of the ledge.
    const eng = await call("bot_body", { action: "engage", mode: "fight", policy: "kite", range: 10 });
    assert.equal(eng.range, 10, `a bow keeps the skeleton's distance: ${JSON.stringify(eng)}`);

    // The CHOSEN STAND is observable: fight-mode stationing navigates to it, and bot_status
    // reports the live path's target. Elevation is read off that, not off where the body happens
    // to be standing when the window closes.
    let stand = null, top = -Infinity;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      await sleep(300);
      const st = await call("bot_status");
      if (st.navTarget && (stand === null || st.navTarget.y > stand.y)) {
        stand = st.navTarget;
      }
      top = Math.max(top, st.pos?.y ?? -Infinity); // `pos` only rides a spawned body
      if (stand && stand.y > threat.pos.y && top >= threat.pos.y + 3) {
        break;
      }
    }
    assert.ok(stand, "a ranged fight must path to a stand — no navTarget was ever reported, so "
      + "Engage never issued one (the flat ring would have; a vantage that finds nothing falls "
      + "back to it)");
    assert.ok(stand.y > threat.pos.y,
      `the archer's stand must be ABOVE the threat — the ledge is dy +4 and Vantage scores dy ≥ 2 `
      + `first: stand y ${stand.y}, threat y ${threat.pos.y}`);
    assert.ok(top >= threat.pos.y + 3,
      `the body must actually take the ledge, not merely aim at it — highest y reached ${top}, `
      + `threat at ${threat.pos.y}`);
    await call("bot_body", { action: "engage", on: false, clear_targets: true });
    await killZombies();
    await cmd(`fill ${VX - 12} ${Y + 1} ${VZ - 12} ${VX + 24} ${Y + 8} ${VZ + 12} minecraft:air`);
  });

  test("F1/reflex: the reflex swing takes the same gate — no wall hits, and it TURNS before it lands", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_reactions", { action: "clear" });
    await killZombies();
    // The reflex swing is the path §10 item 1 caught hitting THROUGH a 1-thick stone wall (it
    // picked nearest-in-sphere: Reflexes.java:759 → DroneHands.nearestLiving), and it is also one
    // of the two paths F1's turn machinery makes fragile — the reaction has to HOLD the body for
    // however many ticks the sweep takes and only swing on READY (Reflexes.advance, case "attack").
    // Neither half was probed anywhere, in this file or the reflex files.
    await call("bot_body", { action: "spawn", type: "player", pos: { x: RX, y: Y + 1, z: RZ } });
    await call("bot_look", { yaw: 0, pitch: 0 }); // face +z, exactly
    const b = (await call("bot_status")).pos;
    const wx = Math.floor(b.x) + 1;
    const wallFill = (block) => cmd(`fill ${wx} ${Y + 1} ${Math.floor(b.z) - 2} ${wx} ${Y + 4} `
      + `${Math.floor(b.z) + 2} minecraft:${block}`);
    // Same shape as case 1: the zombie sits INSIDE the player body's honest ~3-block reach, so the
    // only thing that can keep the reflex off it is the sightline.
    await wallFill("stone");
    await cmd(`summon minecraft:zombie ${wx + 1.5} ${Y + 1} ${b.z} ${STAGED}`);
    await sleep(400);
    const walled = await zombie({ x: RX, y: Y + 1, z: RZ }, 16);
    assert.ok(walled, "staged zombie present");

    let c0 = await nowCursor();
    const arm = (id, cooldown) => call("bot_reactions", {
      action: "arm",
      reactions: [{
        id,
        // threats_nearby counts hostiles through walls BY DESIGN (Reflexes.threats is a sphere, not
        // a sightline) — which is precisely why the reflex has to refuse at the swing.
        trigger: { kind: "threats_nearby", within: 6, count: 1 },
        response: { op: "attack", nearest: true },
        cooldown_ticks: cooldown,
      }],
    });
    // A short cooldown here on purpose: `no_target` is NOT a standing failure (Reflexes'
    // STANDING_FAILURES allowlist deliberately excludes it), so the reflex stays armed and keeps
    // re-trying — which is exactly the pressure this half should apply to the wall.
    await arm("reflexwall", 5);
    const refused = await waitEvent("reaction_done", c0, 8000, (e) => e.data?.id === "reflexwall");
    assert.ok(refused, "the reflex must fire on the threat and report a verdict");
    assert.equal(refused.data.ok, false,
      `the reflex must not swing through a wall: ${JSON.stringify(refused.data)}`);
    // `no_target`, not `occluded`: the LOS filter drops the hidden zombie inside nearestLiving, so
    // the reflex never resolves a target to gate at all (F1's reflex nearest-pick fix).
    assert.equal(refused.data.reason, "no_target", JSON.stringify(refused.data));
    await sleep(1000); // let it keep firing — a swing that leaks through would land in this window
    const intact = await zombie({ x: RX, y: Y + 1, z: RZ }, 16);
    assert.ok(intact && intact.health === walled.health,
      `the walled zombie must be untouched by the reflex — the audited repro KILLED one through `
      + `stone: ${JSON.stringify(intact)}`);
    await call("bot_reactions", { action: "clear" });
    await killZombies();
    await wallFill("air");

    // Wall gone, target BEHIND the body: the reaction owns the body across the sweep and swings
    // only once facing (V3_PLAN.md §2 F1 — "the reflex swing waits on the gate too").
    await call("bot_look", { yaw: 0, pitch: 0 });
    await cmd(`summon minecraft:zombie ${b.x} ${Y + 1} ${b.z - 2} ${STAGED}`);
    await sleep(400);
    const behind = await zombie({ x: RX, y: Y + 1, z: RZ }, 16);
    assert.ok(behind, "staged zombie present");
    c0 = await nowCursor();
    await arm("reflexturn", 100); // one swing is the evidence; a long cooldown keeps the read clean
    const landed = await waitEvent("reaction_done", c0, 8000, (e) => e.data?.id === "reflexturn");
    assert.ok(landed, "the reflex must fire and report");
    assert.equal(landed.data.hit, true,
      `the reflex swing must LAND once the body has turned onto the target (a turn that never `
      + `finishes reports facing_timeout, and that is the freeze this case exists to catch): `
      + `${JSON.stringify(landed.data)}`);
    const st = await call("bot_status");
    const zAfter = await zombie({ x: RX, y: Y + 1, z: RZ }, 16);
    assert.ok(zAfter && zAfter.health < behind.health, `the hit landed: ${JSON.stringify(zAfter)}`);
    // Same bearing arithmetic as case 2, and for the same reason: `summon` centre-corrects integer
    // coordinates, so a hardcoded 180° would lie.
    const bearing = Math.atan2(zAfter.pos.z - st.pos.z, zAfter.pos.x - st.pos.x) * 180 / Math.PI - 90;
    assert.ok(Math.abs(wrapDeg(st.yaw - bearing)) <= 12,
      `the reflex must have TURNED the body onto the target before swinging — bearing `
      + `${bearing.toFixed(1)}°, yaw ${st.yaw}`);
    assert.ok(Math.abs(wrapDeg(st.yaw)) >= 90,
      `it started at yaw 0 with the target behind it, so the turn is genuine: yaw ${st.yaw}`);
    await call("bot_reactions", { action: "clear" });
    await killZombies();
  });

  test("F1/queue: a bot_run attack step inherits the gate, and the queue WAITS for the turn", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_reactions", { action: "clear" });
    await killZombies();
    await call("bot_body", { action: "spawn", type: "player", pos: { x: QX, y: Y + 1, z: QZ } });
    await call("bot_look", { yaw: 0, pitch: 0 }); // face +z; the target sits at +x — a real 90° turn
    const b = (await call("bot_status")).pos;
    const wx = Math.floor(b.x) + 1;
    const wallFill = (block) => cmd(`fill ${wx} ${Y + 1} ${Math.floor(b.z) - 2} ${wx} ${Y + 4} `
      + `${Math.floor(b.z) + 2} minecraft:${block}`);
    await wallFill("stone");
    await cmd(`summon minecraft:zombie ${wx + 1.5} ${Y + 1} ${b.z} ${STAGED}`);
    await sleep(400);
    const target = await zombie({ x: QX, y: Y + 1, z: QZ }, 16);
    assert.ok(target, "staged zombie present");

    // (a) The queue inherits the refusal: its attack step calls the same DroneHands.botAttack
    // (QueueRunner.java:157), so a through-wall swing dies as a STEP FAILURE carrying the real
    // reason, not as a hit. `wait`:true hands this call the queue's own final outcome.
    const blocked = await call("bot_run", { steps: [{ op: "attack", target: target.id }], wait: true });
    assert.equal(blocked.reason, "occluded",
      `a queued swing must not land through a wall: ${JSON.stringify(blocked)}`);
    assert.notEqual(blocked.completed, true, JSON.stringify(blocked));
    const unhurt = await zombie({ x: QX, y: Y + 1, z: QZ }, 16);
    assert.ok(unhurt && unhurt.health === target.health,
      `the walled zombie must be unhurt: ${JSON.stringify(unhurt)}`);

    // (b) Wall gone, body still facing +z with the target at +x: the swing needs a turn, so the
    // step is an ASYNC act and the queue must park on it and RESUME (QueueRunner.tick, case
    // "attack"). Before F1 an attack step was always synchronous — nothing anywhere exercised that
    // branch, and a swing that never ticks would hang the whole queue instead of failing.
    await wallFill("air");
    await call("bot_look", { yaw: 0, pitch: 0 });
    await sleep(300);
    const c0 = await nowCursor();
    const ran = await call("bot_run", {
      steps: [{ op: "attack", target: target.id }, { op: "wait", ticks: 2 }],
      wait: true,
    });
    assert.equal(ran.completed, true,
      `the queue must resume past the parked swing and finish its remaining step: `
      + `${JSON.stringify(ran)}`);
    // And it went through the TURN, not the synchronous shortcut: only an async completion carries
    // an action_id (DroneHands.performSwing stamps it for that path alone).
    const done = await waitEvent("action_completed", c0, 6000,
      (e) => e.data?.action === "bot_attack" && e.data?.hit === true
        && typeof e.data?.action_id === "string");
    assert.ok(done, "the queued swing must complete as a turn-then-press act — an action_completed "
      + "{action:'bot_attack', hit:true} carrying an action_id");
    const hurt = await zombie({ x: QX, y: Y + 1, z: QZ }, 16);
    assert.ok(hurt && hurt.health < target.health, `the queued swing must land: ${JSON.stringify(hurt)}`);
    const st = await call("bot_status");
    const bearing = Math.atan2(hurt.pos.z - st.pos.z, hurt.pos.x - st.pos.x) * 180 / Math.PI - 90;
    assert.ok(Math.abs(wrapDeg(st.yaw - bearing)) <= 12,
      `the queued swing must leave the body FACING what it hit — bearing ${bearing.toFixed(1)}°, `
      + `yaw ${st.yaw}`);
    await killZombies();
  });

  // ---- F6: the body arms itself (WeaponGate, toolkit 0.71.0) ---------------------------------
  //
  // THE MEASURED DEFECT, inverted. The dig gate auto-selects the fastest harvesting tool and
  // nothing ever selected back, so a mining body walked into every fight holding a pickaxe: over
  // the whole recorded corpus 123 of 1,798 fight-reflex ticks had a weapon in hand (6.8%), and in
  // the 9h47m session of 2026-08-11 it was 0 of 1,240 while the agent crafted 29 swords it never
  // held. Vanilla prices it at 8 DPS (stone sword) against 3.6 (stone pickaxe).

  test("F6/melee: a pickaxe-in-hand swing arms itself with the best weapon carried", async (t) => {
    if (!bridgeUp) return t.skip();
    // Sweep FIRST: `zombie()` takes the first match in the list, not the nearest, so a leftover
    // from an earlier case would be targeted at some other bearing entirely.
    await killZombies();
    await call("bot_body", { action: "spawn", type: "player", pos: { x: AX, y: Y + 1, z: AZ } });
    await call("bot_give", { item: "minecraft:stone_pickaxe", count: 1 });
    await call("bot_give", { item: "minecraft:stone_sword", count: 1 });
    // The live chain exactly: the hand is on the pickaxe when the fight starts.
    await call("bot_select", { item: "stone_pickaxe" });
    assert.match(await heldItem(), /stone_pickaxe/,
      "staging: the body must start the fight holding the pickaxe");
    const b = (await call("bot_status")).pos;
    await cmd(`summon minecraft:zombie ${b.x} ${Y + 1} ${b.z + 2} ${STAGED}`);
    await call("bot_look", { yaw: 0, pitch: 0 });   // +z: the target is straight ahead, so the
    await sleep(400);                               // swing is SYNCHRONOUS and its reply is the verdict
    const target = await zombie({ x: AX, y: Y + 1, z: AZ }, 16);
    assert.ok(target, "staged zombie present");
    const c0 = await nowCursor();
    const r = await call("bot_attack", { target: target.id });
    assert.match(await swungWith(r, c0), /stone_sword/,
      `the swing must land with the sword, not the mining tool: ${JSON.stringify(r)}`);
    assert.match(String(r.weapon_switched ?? ""), /stone_sword/,
      `the switch must be REPORTED, not silent: ${JSON.stringify(r)}`);
    assert.match(await heldItem(), /stone_sword/,
      "the hand keeps the weapon after the swing — the next swing must not pay the switch again");
    await killZombies();
  });

  test("F6/idempotent: already best-armed → no switch, no cooldown reset", async (t) => {
    if (!bridgeUp) return t.skip();
    await killZombies();
    await call("bot_body", { action: "spawn", type: "player", pos: { x: AX, y: Y + 1, z: AZ } });
    await call("bot_give", { item: "minecraft:stone_sword", count: 1 });
    await call("bot_select", { item: "stone_sword" });
    const b = (await call("bot_status")).pos;
    await cmd(`summon minecraft:zombie ${b.x} ${Y + 1} ${b.z + 2} ${STAGED}`);
    await call("bot_look", { yaw: 0, pitch: 0 });
    await sleep(400);
    const target = await zombie({ x: AX, y: Y + 1, z: AZ }, 16);
    const c0 = await nowCursor();
    const r = await call("bot_attack", { target: target.id });
    // Switching resets the attack-strength ticker (Player.tick), so a gate that re-armed every
    // swing would pin the body at the 0.2 floor of the charge curve forever. `weapon_switched`
    // rides the START reply on both paths, so this half needs no completion lookup.
    assert.equal(r.weapon_switched, undefined,
      `an already-armed hand must not switch: ${JSON.stringify(r)}`);
    assert.match(await swungWith(r, c0), /stone_sword/, JSON.stringify(r));
    await killZombies();
  });

  test("F6/override: an explicit `item` is honoured on a player body (it used to be ignored)", async (t) => {
    if (!bridgeUp) return t.skip();
    await killZombies();
    await call("bot_body", { action: "spawn", type: "player", pos: { x: AX, y: Y + 1, z: AZ } });
    await call("bot_give", { item: "minecraft:stone_sword", count: 1 });
    await call("bot_give", { item: "minecraft:stone_pickaxe", count: 1 });
    await call("bot_select", { item: "stone_sword" });
    const b = (await call("bot_status")).pos;
    await cmd(`summon minecraft:zombie ${b.x} ${Y + 1} ${b.z + 2} ${STAGED}`);
    await call("bot_look", { yaw: 0, pitch: 0 });
    await sleep(400);
    const target = await zombie({ x: AX, y: Y + 1, z: AZ }, 16);
    const c0 = await nowCursor();
    const r = await call("bot_attack", { target: target.id, item: "minecraft:stone_pickaxe" });
    assert.match(await swungWith(r, c0), /stone_pickaxe/,
      `a named item must override the auto-arm, not be silently dropped: ${JSON.stringify(r)}`);
    const missing = await call("bot_attack", { target: target.id, item: "minecraft:netherite_sword" });
    assert.equal(missing.ok, false, JSON.stringify(missing));
    assert.equal(missing.reason, "item_missing", JSON.stringify(missing));
    await killZombies();
  });

  test("F6/ranged: bot_shoot reaches for the carried bow instead of firing a bare arrow", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "spawn", type: "player", pos: { x: AX, y: Y + 1, z: AZ } });
    await call("bot_give", { item: "minecraft:bow", count: 1 });
    await call("bot_give", { item: "minecraft:arrow", count: 8 });
    await call("bot_give", { item: "minecraft:dirt", count: 8 });
    await call("bot_select", { item: "dirt" });
    const b = (await call("bot_status")).pos;
    await cmd(`summon minecraft:zombie ${b.x} ${Y + 1} ${b.z + 10} ${STAGED}`);
    await sleep(400);
    const target = await zombie({ x: AX, y: Y + 1, z: AZ }, 24);
    // `wait` because a shot is a real DRAW since 0.73.0 — the body aims, holds the bow, and vanilla
    // looses it on release, so the ARMING fact rides the start reply and the outcome arrives at the
    // end. The invariant this case pins is unchanged: the hand reaches for the carried bow rather
    // than firing a bare arrow because a dig left dirt selected.
    const r = await call("bot_shoot", { target: target.id, wait: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.match(String(r.weapon ?? ""), /bow/,
      `a carried bow must fire the shot: ${JSON.stringify(r)}`);
    assert.equal(r.mode, "ranged", `a shot is a ranged verdict: ${JSON.stringify(r)}`);
    await killZombies();
  });

  test("cleanup", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_reactions", { action: "clear" }).catch(() => {});
    await call("bot_body", { action: "engage", on: false, clear_targets: true }).catch(() => {});
    await call("bot_body", { action: "despawn" }).catch(() => {});
    await killZombies();
    for (const [z0, z1] of BANDS) {
      await cmd(`fill ${X - 16} ${Y + 1} ${z0} ${VX + 24} ${Y + 10} ${z1} minecraft:air`).catch(() => {});
    }
    await cmd(`forceload remove ${X - 32} ${Z - 32} ${VX + 32} ${VZ + 32}`).catch(() => {});
  });
});
