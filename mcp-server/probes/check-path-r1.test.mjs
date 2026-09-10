// check_path R1+R2 — the survival-profile legality lines (mcp-toolkit/docs/play/CHECK_PATH_AUDIT.md).
//
// R1 (applied 2026-08-08): `load:true` REFUSED under survival (F4), and the default load path
// forced off — refusing only the literal while the default silently paged would be a refusal in
// name only.
//
// R2 (applied 2026-08-08): the survival solve is KNOWLEDGE-MASKED — it runs over the session's
// seen-set (fed at the Sightlines tap: fan/ray walks incl. air, gait fans, body traversal), where
// unknown ≠ blocked. Verdicts become honestly tri-state over knowledge:
//   true  — a route exists entirely through OBSERVED cells;
//   null + knowledge_frontier — the search (or the target itself) ran out of observed terrain:
//           "your knowledge ends here; go look" — the explore hint that replaces the old leak;
//   false — sealed within known terrain (not staged here: a fully-known enclosure needs
//           knowledge-complete coverage this probe's narrow walked tube cannot honestly build —
//           the touched-empty branch is covered by the sealed-pen case of predicates.test.mjs
//           geometry under the unmasked solver).
// Provenance stamp is now `held_knowledge` — the R1-era `privileged_solver` stamp retired with
// the privileged solve itself.
//
// The probe runs under a FRESH session minted via /hello: knowledge is per-session and survives
// for the session's lifetime, so an anonymous probe would inherit its own previous run's walks
// (live-caught: the second run found 1,743 cells already known and "unseen" was false). A minted
// session starts knowing nothing, and the server reaps it — seen-set included — when the probe
// stops calling.
//
// OWNS SITE 1,710,000 (site-map.test.mjs). Live probe: needs the dev server; skips when down.

import { test } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const SITE = { x: 1710000, z: 1710000 };
const Y = 200; // floor at Y-1, feet cells at Y

const SESSION = await fetch(`${BASE}/hello`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ label: "check-path-r1-probe" }),
  signal: AbortSignal.timeout(3000),
}).then((r) => r.json()).then((j) => j.session ?? null).catch(() => null);

async function callRaw(tool, args = {}, profile = null) {
  const res = await fetch(`${BASE}/cmd`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(SESSION ? { "X-MCPTK-Session": SESSION } : {}),
      ...(profile ? { "X-MCPTK-Profile": profile } : {}),
    },
    body: JSON.stringify({ tool, args }),
  });
  return res.json();
}

async function call(tool, args = {}, profile = null) {
  const j = await callRaw(tool, args, profile);
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

const FROM = { x: SITE.x, y: Y, z: SITE.z };
const TO = { x: SITE.x + 6, y: Y, z: SITE.z };
const WALK_END = { x: SITE.x + 8, y: Y, z: SITE.z };
// Lateral target for the mid-route frontier case: seeded by a single vertical ray, so the TARGET
// is observed while everything between the strip and it is not.
const LATERAL = { x: SITE.x + 3, y: Y, z: SITE.z + 10 };

test("R1: survival refuses load:true (F4)", { skip: !bridgeUp }, async () => {
  const j = await callRaw("check_path", { from: FROM, to: TO, load: true }, "survival");
  assert.equal(j.ok, false, `expected a refusal, got: ${JSON.stringify(j)}`);
  assert.match(String(j.error), /load_refused/,
    "the refusal must name itself load_refused so the remedy is legible");
});

test("R2: unseen target → null + knowledge_frontier; privileged profiles unchanged", { skip: !bridgeUp }, async () => {
  await cmd(`forceload add ${SITE.x - 16} ${SITE.z - 16} ${SITE.x + 16} ${SITE.z + 16}`);
  await cmd(`fill ${SITE.x - 2} ${Y - 1} ${SITE.z - 2} ${SITE.x + 8} ${Y - 1} ${SITE.z + 2} minecraft:stone`);
  await cmd(`fill ${SITE.x - 2} ${Y} ${SITE.z - 2} ${SITE.x + 8} ${Y + 3} ${SITE.z + 2} minecraft:air`);

  // Nothing has ever LOOKED at this site: the survival verdict must not even say "unreachable" —
  // a claim about a never-observed cell is not derivable from held knowledge.
  const survival = await call("check_path", { from: FROM, to: TO }, "survival");
  assert.equal(survival.reachable, null, JSON.stringify(survival));
  assert.deepEqual(survival.knowledge_frontier, { x: TO.x, y: TO.y, z: TO.z },
    "an unseen target IS the frontier: go look at it");
  assert.equal(survival.provenance, "held_knowledge");
  assert.ok(String(survival.provenance_note ?? "").includes("OBSERVED"));

  // The unmasked profiles keep the privileged solve, unstamped.
  const dev = await call("check_path", { from: FROM, to: TO });
  assert.equal(dev.reachable, true, JSON.stringify(dev));
  assert.equal(dev.provenance, undefined, "non-survival answers are unstamped");
});

test("R2: walked terrain answers true; ray-seeded target gives a mid-route frontier", { skip: !bridgeUp }, async (t) => {
  try {
    // Walk the strip: the body's feet/head/floor feed the seen-set every tick, so the corridor
    // becomes held knowledge end to end.
    await call("bot_body", { action: "spawn", pos: { x: FROM.x, y: Y, z: FROM.z } });
    const walk = await call("bot_goto", { to: WALK_END, within: 1.5, wait: true });
    // What this test needs is the TRAVERSAL (the walked cells feed the seen-set), not a pretty
    // landing — a lingering body from a not-yet-reaped previous probe session can shove the
    // spawn a few centimetres and turn `arrived` into a near-miss stopped_short (live-caught on
    // back-to-back runs). Walked-the-strip is the honest precondition.
    const landed = ["arrived", "already_there"].includes(walk.outcome)
      || (walk.traveled > 6 && walk.distance_to_target < 2.5);
    assert.ok(landed, `the staging walk must traverse the strip: ${JSON.stringify(walk)}`);

    // THE TARGET IS WHERE THE BODY WENT, not where the strip's centre line says it should have.
    // With the world-model recorder ON, the gait fans widen a walk into the whole corridor and
    // TO (six blocks straight ahead) is known either way; with it OFF (this dev config since
    // 2026-09-03, RELEASE.md 2.2) a body knows only the three cells it stands in each tick, and a
    // walker that drifts one lane sideways at x+2 leaves the centre line unseen from there - which
    // read as red twice at 0.124.0/0.125.0 (frontier at TO, then at x+2). The claim is "walked
    // cells are held knowledge", so the route asked about is the one the body walked: from the
    // spawn to the cell it landed in. `ping.wm.recording` (0.125.0) says which regime this is.
    // ...clamped to the strip: `within: 1.5` lets the body stop a step PAST WALK_END with its feet
    // still on x+8 and its centre over x+9, where there is no floor (live: the whole 0.125.0 run
    // landed at x+9 and asked about a cell off the platform). The last strip cell is walked either way.
    const pos = (await call("bot_status")).pos;
    const LANDED = { x: Math.min(Math.floor(pos.x), WALK_END.x), y: Y,
                     z: Math.max(SITE.z - 2, Math.min(SITE.z + 2, Math.floor(pos.z))) };
    const known = await call("check_path", { from: FROM, to: LANDED }, "survival");
    assert.equal(known.reachable, true,
      `a route through walked cells answers from held knowledge (to ${JSON.stringify(LANDED)}): ${JSON.stringify(known)}`);
    assert.equal(known.provenance, "held_knowledge");

    // Seed ONLY the lateral target with a vertical ray: target observed, approach not.
    await call("raycast", {
      origin: { x: LATERAL.x + 0.5, y: Y + 40, z: LATERAL.z + 0.5 },
      direction: { x: 0, y: -1, z: 0 },
      range: 45,
    });
    const frontier = await call("check_path", { from: FROM, to: LATERAL }, "survival");
    assert.equal(frontier.reachable, null,
      `a seen target behind unseen terrain is null, not false/true: ${JSON.stringify(frontier)}`);
    assert.ok(frontier.knowledge_frontier,
      `the null verdict carries the go-look pointer: ${JSON.stringify(frontier)}`);
    const kf = frontier.knowledge_frontier;
    assert.ok(Math.abs(kf.x - SITE.x - 4) < 16 && Math.abs(kf.z - SITE.z - 5) < 16,
      `the frontier lies between the walked strip and the target: ${JSON.stringify(kf)}`);
  } finally {
    await callRaw("bot_body", { action: "despawn" });
    await cmd(`forceload remove ${SITE.x - 16} ${SITE.z - 16} ${SITE.x + 16} ${SITE.z + 16}`);
  }
});
