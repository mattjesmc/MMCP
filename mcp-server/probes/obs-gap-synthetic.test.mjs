// The §15 obs-gap synthetic probe (HUMAN_RIG_PLAN.md phase 5, verification item 6): the creeper
// behind the wall. DESIGN.md §15.3 names the trap — the human sees pixels, the dataset sees fans —
// and the mitigation is a flag, not a guess: an entity engaged that NO fan under the session has
// sighted in the last 40 ticks is `obs_gap`. This probe drives the ring through its dev seam
// (`wm_obsgap`) with staged geometry where the truth is known by construction:
//
//   unsighted — a fan aimed square at an opaque wall must NOT vouch for the creeper behind it
//               (occlusion already keeps the pick out of the fan; the ring must agree);
//   sighted   — a fan with clear line of sight marks the entity, last_sighted_tick ~ now;
//   expiry    — the window is 40 ticks INCLUSIVE and then over: the same eid, unfanned, goes back
//               to unsighted with no fan cast in between;
//   isolation — one session's fans never vouch for another's (the ring is per-session, exactly
//               like the seen-set: a probe's looking is not the human's looking).
//
// NOT probed headless: the press-row `obs_gap:true` flag and the episodes/manifest rate — those
// need a connected human naming a target (the supervised smoke owns them).
//
// OWNS SITE 1,870,000 (site-map.test.mjs). Live probe: needs the dev server WITH the phase-5
// toolkit (wm_obsgap in the manifest); skips when either is missing. Creeper disposal is a
// position-anchored `damage`, never /kill — the house rule.

import { test } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const SITE = { x: 1870000, z: 1870000 };
const Y = 200;
const WINDOW = 40; // ticks — HUMAN_RIG_PLAN "start N=40"; the tool reports it back

const SESSION = await fetch(`${BASE}/hello`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ label: "obs-gap-synthetic-probe" }),
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
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const manifest = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => (r.ok ? r.json() : null))
  .catch(() => null);
const bridgeUp = manifest !== null;
// Tool-presence guard on top of the bridge guard: this file lands with the Node half of phase 5,
// so a battery against a pre-phase-5 server must skip loudly, not fail on an unknown tool.
const toolUp = bridgeUp && manifest.some((t) => t.name === "wm_obsgap");
if (!bridgeUp) {
  console.log(`\n  [skip] no bridge at ${BASE} — start the dev server to run these probes\n`);
} else if (!toolUp) {
  console.log("\n  [skip] wm_obsgap not in the manifest — rebuild the toolkit (phase 5 Java side) first\n");
}
const skip = !toolUp;

// THE PREMISE, READ (RELEASE.md 2.2). The sighting note is written from inside the recorder's fan
// tick (Wm.tickEntity -> WmGait -> WmObsGap.note), so with wm.record=false NO fan marks an entity
// sighted, by construction, and the three sighting cases pinned a recorder that this game's config
// had turned off on 2026-09-03 - 4/2 red for three days with nothing to say why. `ping.wm.recording`
// (toolkit 0.125.0) is that premise; an older toolkit has no block and the arm runs as before.
const pingWm = skip ? null : await fetch(`${BASE}/cmd`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ tool: "ping", args: {} }), signal: AbortSignal.timeout(3000),
}).then((r) => r.json()).then((j) => j.result?.wm ?? null).catch(() => null);
const recorderOff = pingWm !== null && pingWm.recording === false;
if (recorderOff) {
  console.log("\n  [premise] the world-model recorder is OFF (ping.wm.recording=false): no fan marks a "
    + "sighting, so the sighted/expiry/isolation cases skip by name; the refusal cases still run\n");
}

// Geometry, truth by construction: flat platform; a 5-wide × 4-tall stone wall one block thick
// athwart the +x sightline; the creeper (1.7 tall — entirely below the wall top) on the far side.
// NEAR_EYE looks +x into the wall face (±15° at 3.5 blocks stays well inside the wall's ±2.5
// lateral / 4-up extent, and the downward rays meet the wall before the floor). FAR_EYE stands
// beyond the creeper looking back — nothing between eye and hitbox.
const WALL_X = SITE.x + 4;
const CREEPER = { x: SITE.x + 8.5, y: Y, z: SITE.z + 0.5 };
const NEAR_EYE = { x: SITE.x + 0.5, y: Y + 1.62, z: SITE.z + 0.5 };
const FAR_EYE = { x: SITE.x + 12.5, y: Y + 1.62, z: SITE.z + 0.5 };

async function stage() {
  await cmd(`forceload add ${SITE.x - 16} ${SITE.z - 16} ${SITE.x + 32} ${SITE.z + 16}`);
  await cmd(`fill ${SITE.x - 6} ${Y - 1} ${SITE.z - 6} ${SITE.x + 16} ${Y - 1} ${SITE.z + 6} minecraft:stone`);
  await cmd(`fill ${SITE.x - 6} ${Y} ${SITE.z - 6} ${SITE.x + 16} ${Y + 8} ${SITE.z + 6} minecraft:air`);
  await cmd(`fill ${WALL_X} ${Y} ${SITE.z - 2} ${WALL_X} ${Y + 3} ${SITE.z + 2} minecraft:stone`);
}

/** Fan whose CENTER ray runs eye→at exactly; odd grid so that center ray exists (fan-density's
 *  lesson: EVEN grids have no centre ray — 385 probes missed it). */
function fanAt(eye, at, fov = 60, steps = 7) {
  const d = { x: at.x - eye.x, y: at.y - eye.y, z: at.z - eye.z };
  return call("raycast_fan", {
    origin: eye, direction: d, h_fov: fov, v_fov: fov, steps_h: steps, steps_v: steps, range: 24,
  });
}

let eid = null; // resolved once at staging, used by every later test

test("staging: wall + NoAI creeper, resolved via type+near (never trust run_command's ok)", { skip }, async () => {
  await stage();
  // PersistenceRequired is load-bearing, not hygiene: Mob.checkDespawn discards an unpersisted
  // hostile INSTANTLY when any player is online farther than the despawn distance — and other
  // probe files spawn fake players at their own sites, so under the concurrent battery (or after
  // a leaked body) an unpersisted creeper dies before the first fan. Live-caught at 0.68.0.
  await cmd(`summon minecraft:creeper ${CREEPER.x} ${CREEPER.y} ${CREEPER.z} `
    + `{NoAI:1b,PersistenceRequired:1b}`);
  // run_command reports ok:true on failed commands — the resolution below is the existence proof.
  const r = await call("wm_obsgap", {
    type: "minecraft:creeper", near: [Math.floor(CREEPER.x), Y, Math.floor(CREEPER.z)],
  });
  assert.ok(Number.isInteger(r.eid), `type+near must resolve the summoned creeper: ${JSON.stringify(r)}`);
  assert.equal(r.window, WINDOW, "the tool reports the window it judges by");
  assert.equal(r.sighted, false, "no fan has been cast under this session — a fresh ring vouches for nothing");
  assert.equal(r.last_sighted_tick, null);
  eid = r.eid;
});

test("unsighted: a fan swallowed by the wall does not vouch for the creeper behind it", { skip }, async () => {
  assert.ok(eid !== null, "staging must have resolved the creeper");
  // Narrow cone (±15°) square into the wall face — occlusion keeps every ray on the near side.
  const fan = await fanAt(NEAR_EYE, { x: WALL_X + 0.5, y: Y + 1.62, z: SITE.z + 0.5 }, 30, 5);
  assert.equal(fan.hits["minecraft:creeper"] ?? 0, 0,
    `the wall must occlude the creeper from this fan: ${JSON.stringify(fan.hits)}`);
  const r = await call("wm_obsgap", { eid });
  assert.equal(r.sighted, false,
    `a fan that never saw the entity must not mark it sighted: ${JSON.stringify(r)}`);
});

test("sighted: a clear-line fan marks the creeper, last_sighted_tick rides now", { skip: recorderOff ? "recorder off: no fan marks a sighting" : skip }, async () => {
  assert.ok(eid !== null, "staging must have resolved the creeper");
  const fan = await fanAt(FAR_EYE, { x: CREEPER.x, y: Y + 0.85, z: CREEPER.z });
  assert.ok((fan.hits["minecraft:creeper"] ?? 0) >= 1,
    `the clear-line fan must actually pick the creeper: ${JSON.stringify(fan.hits)}`);
  const r = await call("wm_obsgap", { eid });
  assert.equal(r.sighted, true, JSON.stringify(r));
  assert.ok(Number.isInteger(r.last_sighted_tick), JSON.stringify(r));
  assert.ok(r.now - r.last_sighted_tick <= 5,
    `the sighting must be ticks old, not seconds: now=${r.now} last=${r.last_sighted_tick}`);
});

test(`expiry: the sighting ages out past ${WINDOW} ticks with no fan in between`, { skip: recorderOff ? "recorder off: no fan marks a sighting" : skip }, async () => {
  assert.ok(eid !== null, "staging must have resolved the creeper");
  // 40 ticks is ~2s at 20 tps; poll against a deadline rather than trusting one sleep — the dev
  // server's tick rate under a battery is not a wall clock.
  const deadline = Date.now() + 15_000;
  let r = await call("wm_obsgap", { eid });
  while (r.sighted && Date.now() < deadline) {
    await sleep(300);
    r = await call("wm_obsgap", { eid });
  }
  assert.equal(r.sighted, false, `still sighted after 15s (~300 ticks): ${JSON.stringify(r)}`);
  if (r.last_sighted_tick !== null) {
    assert.ok(r.now - r.last_sighted_tick > WINDOW,
      `sighted:false must MEAN the window elapsed: now=${r.now} last=${r.last_sighted_tick}`);
  }
});

test("isolation: one session's fans never vouch for another's ring", { skip: recorderOff ? "recorder off: no fan marks a sighting" : skip }, async () => {
  assert.ok(eid !== null, "staging must have resolved the creeper");
  const fan = await fanAt(FAR_EYE, { x: CREEPER.x, y: Y + 0.85, z: CREEPER.z });
  assert.ok((fan.hits["minecraft:creeper"] ?? 0) >= 1, "the refresher fan must see the creeper");
  const own = await call("wm_obsgap", { eid });
  assert.equal(own.sighted, true, "the caster's own ring holds the fresh sighting");
  const other = await call("wm_obsgap", { session: "probe:other-session", eid });
  assert.equal(other.sighted, false,
    `a session that cast no fan has seen nothing: ${JSON.stringify(other)}`);
});

test("cleanup: dispose the creeper (damage, never /kill) and clear the stage", { skip }, async () => {
  await callRaw("run_command", {
    command: `execute positioned ${CREEPER.x} ${CREEPER.y} ${CREEPER.z} run `
      + `damage @e[type=minecraft:creeper,distance=..16] 1000 minecraft:generic`,
  });
  await cmd(`fill ${SITE.x - 6} ${Y - 1} ${SITE.z - 6} ${SITE.x + 16} ${Y + 8} ${SITE.z + 6} minecraft:air`);
  await cmd(`forceload remove ${SITE.x - 16} ${SITE.z - 16} ${SITE.x + 32} ${SITE.z + 16}`);
});
