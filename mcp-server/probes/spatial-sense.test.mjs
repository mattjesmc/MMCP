// Live probes for the SPATIAL SENSE + RESPAWN fixes (W2_POSTMORTEM_FIXES.md §4/§6):
//
//   1. bot_status carries sees_sky/light/enclosed — a sealed body KNOWS it is sealed (w2-79881
//      inferred "underground" from time_of_day events; nothing ever said "enclosed in rock") —
//      and a roofed-but-not-sealed body is told its ways out (`open_directions`).
//   2. respawn anchors on the death site (near:"death") and reports spawn_quality.
//   3. a respawn into a hostile ring either clears 8 blocks or says spawned_unsafe — never the
//      silent nearest-to-anchor cell that put w2-79881 back in the kill zone twice.
//
// Staged at a probe-owned coordinate (3.86M). Own session. Run with `npm run test:live`.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const X = 3_860_000, Z = 3_860_000, Y = 150;
const SESSION = "probe-spatial-sense";
const FAKE_NAME = "probe_spatial_se"; // the session id squeezed into [A-Za-z0-9_], max 16
const PLATFORM = { x: X, y: Y + 1, z: Z };
// The sealed chamber: a 1x2 air pocket inside a solid stone shell, well under the platform.
const CHAMBER = { x: X + 12, y: Y + 1, z: Z + 12 };
// The vented chamber: same shell, but a head-height tunnel out the NORTH face — the body is
// roofed (sees_sky:false), not sealed, and the one way out must be named.
const VENT = { x: X + 12, y: Y + 1, z: Z - 12 };

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
const killSkeletons = () => cmd(`kill @e[type=minecraft:skeleton,x=${X - 40},y=${Y - 6},z=${Z - 40},dx=80,dy=30,dz=80]`).catch(() => {});

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok).catch(() => false);
if (!bridgeUp) console.log(`\n  [skip] no bridge at ${BASE} — start the dev server\n`);

describe("spatial sense + respawn anchoring", { skip: !bridgeUp }, () => {
  test("stage the site", async (t) => {
    if (!bridgeUp) return t.skip();
    await cmd(`forceload add ${X - 32} ${Z - 32} ${X + 32} ${Z + 32}`);
    await sleep(1500);
    // Open platform.
    await cmd(`fill ${X - 20} ${Y} ${Z - 20} ${X + 20} ${Y} ${Z + 20} minecraft:stone`);
    await cmd(`fill ${X - 20} ${Y + 1} ${Z - 20} ${X + 20} ${Y + 20} ${Z + 20} minecraft:air`);
    // Sealed chamber: solid shell with a 1x2 pocket.
    await cmd(`fill ${CHAMBER.x - 3} ${Y} ${CHAMBER.z - 3} ${CHAMBER.x + 3} ${Y + 5} ${CHAMBER.z + 3} minecraft:stone`);
    await cmd(`fill ${CHAMBER.x} ${CHAMBER.y} ${CHAMBER.z} ${CHAMBER.x} ${CHAMBER.y + 1} ${CHAMBER.z} minecraft:air`);
    // Vented chamber: the same shell with a head-height tunnel punched through the north face.
    await cmd(`fill ${VENT.x - 3} ${Y} ${VENT.z - 3} ${VENT.x + 3} ${Y + 5} ${VENT.z + 3} minecraft:stone`);
    await cmd(`fill ${VENT.x} ${VENT.y} ${VENT.z} ${VENT.x} ${VENT.y + 1} ${VENT.z} minecraft:air`);
    await cmd(`fill ${VENT.x} ${VENT.y + 1} ${VENT.z - 3} ${VENT.x} ${VENT.y + 1} ${VENT.z - 1} minecraft:air`);
    await sleep(400);
    await call("bot_reactions", { action: "clear" });
    await killSkeletons();
  });

  test("a sealed body reads enclosed:true, sees_sky:false; an open one does not", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "spawn", type: "player", pos: CHAMBER });
    const sealed = await call("bot_status", {});
    assert.equal(sealed.sees_sky, false, JSON.stringify({ sees_sky: sealed.sees_sky }));
    assert.equal(sealed.enclosed, true, "six probes all end in rock — the body must know");
    assert.equal(sealed.light.sky, 0, "no skylight inside the shell");

    await call("bot_body", { action: "spawn", type: "player", pos: PLATFORM });
    const open = await call("bot_status", {});
    assert.equal(open.sees_sky, true, JSON.stringify({ sees_sky: open.sees_sky }));
    assert.equal(open.enclosed, undefined, "enclosed is emitted only when true");
    assert.equal(open.open_directions, undefined,
      "under open sky the open list is noise — the field is conditional on being roofed");
  });

  test("a roofed body with one way out is told which way: open_directions", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "spawn", type: "player", pos: VENT });
    const vented = await call("bot_status", {});
    assert.equal(vented.sees_sky, false, JSON.stringify({ sees_sky: vented.sees_sky }));
    assert.equal(vented.enclosed, undefined, "a vented chamber is not sealed");
    assert.deepEqual(vented.open_directions, ["N"],
      `the north vent is the one way out: ${JSON.stringify(vented.open_directions)}`);
  });

  test("near:'death' respawns at the death site with spawn_quality disclosed", async (t) => {
    if (!bridgeUp) return t.skip();
    await killSkeletons();
    await call("bot_body", { action: "spawn", type: "player", pos: PLATFORM });
    // A FRESH spawn is invulnerable for ~60 ticks (vanilla spawn protection) and /damage answers
    // "Target is invulnerable" — through run_command's ok:true — so wait the window out (found
    // live 2026-08-05 when a new earlier test made this spawn a real one instead of a no-op).
    await sleep(3500);
    // `damage`, not `kill`: /kill on a fake player is swallowed by its connection stub (verified
    // live 2026-08-04 — "Killed" output, health still 20); real damage goes through hurtServer.
    // And `minecraft:generic`, not `generic_kill`: the fake player answers the latter with "Target
    // is invulnerable to the given damage type" (live 2026-08-05) — and run_command reports ok:true
    // with the refusal in `output`, so the probe sailed past it and failed later, somewhere else.
    await cmd(`damage ${FAKE_NAME} 1000 minecraft:generic`);
    await sleep(1200); // tickWatch detects the death, records the site, reaps the corpse
    const r = await call("bot_body", { action: "spawn", type: "player", near: "death" });
    const dx = r.pos.x - PLATFORM.x, dz = r.pos.z - PLATFORM.z;
    assert.ok(Math.hypot(dx, dz) <= 26,
      `the respawn anchors on the DEATH SITE, not a distant player: ${JSON.stringify(r.pos)}`);
    assert.equal(r.spawn_quality?.anchor, "death_site", JSON.stringify(r.spawn_quality));
  });

  test("a respawn into a hostile ring clears 8 blocks OR says spawned_unsafe — never silently adjacent", async (t) => {
    if (!bridgeUp) return t.skip();
    await call("bot_body", { action: "spawn", type: "player", pos: PLATFORM });
    // Fresh-spawn invulnerability window — see the note in the previous test.
    await sleep(3500);
    // `damage`, not `kill`: /kill on a fake player is swallowed by its connection stub (verified
    // live 2026-08-04 — "Killed" output, health still 20); real damage goes through hurtServer.
    // And `minecraft:generic`, not `generic_kill`: the fake player answers the latter with "Target
    // is invulnerable to the given damage type" (live 2026-08-05) — and run_command reports ok:true
    // with the refusal in `output`, so the probe sailed past it and failed later, somewhere else.
    await cmd(`damage ${FAKE_NAME} 1000 minecraft:generic`);
    await sleep(1200);
    // A tight ring of pinned skeletons around the death site (helmets: no daylight burn).
    const skel = (sx, sz) => cmd(`summon minecraft:skeleton ${sx} ${Y + 1} ${sz} `
      + `{NoAI:1b,PersistenceRequired:1b,ArmorItems:[{},{},{},{id:"minecraft:iron_helmet",count:1}]}`);
    await skel(X + 4, Z);
    await skel(X - 4, Z);
    await skel(X, Z + 4);
    await skel(X, Z - 4);
    await sleep(400);
    const r = await call("bot_body", { action: "spawn", type: "player", near: "death" });
    const clearance = r.spawn_quality?.hostile_clearance;
    if (r.spawned_unsafe === true) {
      assert.ok(true, "contested everywhere and SAID so");
    } else {
      assert.ok(clearance === undefined || clearance >= 8,
        `placed ${clearance} blocks from a hostile with no spawned_unsafe flag — the w2-79881 `
        + `silent kill-zone respawn: ${JSON.stringify(r.spawn_quality)}`);
    }
    await killSkeletons();
  });
});
