// Live probes for the R-BLOCK recorder additions (world-model/V3_PLAN.md §3, toolkit 0.69.0) —
// the three facts a v3 session has to be able to state about itself:
//
//   R-a  WORLD IDENTITY — the manifest carries world.name + world.seed_sha256 (64 lowercase hex),
//        and NEVER the raw seed. The loader's world_id is "w-" + the first 8 of that hash, and
//        the honest split hangs off it (E2's group key, §5's held-out world). The no-raw-seed rule
//        is not hygiene: a seed regenerates the whole world (DESIGN.md §13.1), which is why the
//        recorder writes a digest instead — it identifies without revealing, and this probe checks
//        the file itself rather than a reply, because the file is what a loader will read.
//   R-b  PURPOSE TAG — wm_session_tag stamps the live session's manifest with one of
//        battery|bench|curriculum|taskgen|survival|human|eval, refuses anything else (the vocabulary
//        rides the refusal), refuses 'adhoc' specially (absence already MEANS adhoc), and a
//        refusal stamps nothing. v2 trained on 62% battery geometry because sessions could not
//        say what they were (EVAL_AUDIT_V2.md §10); this is the fix, so it gets asserted.
//   R-c  PERTURBATION ACTOR — wm_perturb hijacks an ACTIVE navigation for a few ticks under actor
//        'perturb' and then hands the body straight back to the expert. Both halves are asserted:
//        ticks were really driven under that label, and the expert really resumes (a hijack that
//        stranded a body would produce no recovery demonstration at all — the one thing §4.3
//        tier 1 exists to collect).
//
// NOT probed here: that the perturb ROWS reach disk with actor "perturb". The session's gzip
// streams stay open for the whole server run, so the rows are verified by the validator at the
// next server close (tools/validate.mjs) — the same rule the input-frame probe's press rows live
// under. wm_perturb's `last` report is the live proof available.
//
// This file deliberately tags the live session `battery`: under the battery that IS what the
// session is, and it is exactly what battery.ps1 stamps. A probe that stamped anything else would
// write a lie into the corpus record it is testing.
//
// OWNS SITE 1_960_000 (site-map.test.mjs guards uniqueness — probe files run CONCURRENTLY, so a
// shared coordinate silently corrupts another file's world). Live probe: needs the dev server with
// the R-block toolkit; skips loudly when either is missing, and the manifest/purpose cases skip
// again when the server is not recording (wm.record=false — nothing to tag).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const SITE = { x: 1_960_000, z: 1_960_000 };
const Y = 200;
const SESSION = "probe-wm-rblock";
// The perturbation leg: long enough that a 12-tick hijack lands mid-route with room to recover,
// wide enough that a random heading cannot walk the body off the platform's side in that time.
const LEG = 50;
const TARGET = { x: SITE.x + LEG, y: Y, z: SITE.z };

async function callRaw(tool, args = {}) {
  const res = await fetch(`${BASE}/cmd`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-MCPTK-Session": SESSION },
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

const manifest = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => (r.ok ? r.json() : null))
  .catch(() => null);
const bridgeUp = manifest !== null;
// Tool-presence guard on top of the bridge guard: this file lands with the R-block Java, so a
// battery against an older server must skip loudly instead of failing on an unknown tool.
const toolUp = bridgeUp
  && manifest.some((t) => t.name === "wm_session_tag")
  && manifest.some((t) => t.name === "wm_perturb");
if (!bridgeUp) {
  console.log(`\n  [skip] no bridge at ${BASE} — start the dev server to run these probes\n`);
} else if (!toolUp) {
  console.log("\n  [skip] wm_session_tag / wm_perturb not in the manifest — rebuild the toolkit "
    + "(R-block Java side) first\n");
}
const skip = !toolUp;

// Is the recorder ON this run? wm_perturb's status read is the cheapest honest oracle: it needs
// no session, no body and no recorder, and reports `recording` either way.
const recording = skip ? false
  : await call("wm_perturb", { status: true }).then((r) => r.recording === true).catch(() => false);
if (toolUp && !recording) {
  console.log("\n  [skip] the wm recorder is OFF (wm.record=false) — there is no session manifest "
    + "to identify or tag; the perturb case still runs\n");
}
const skipRec = skip || !recording;

async function stageStrip() {
  await cmd(`forceload add ${SITE.x - 16} ${SITE.z - 16} ${SITE.x + LEG + 16} ${SITE.z + 16}`);
  await cmd(`fill ${SITE.x - 4} ${Y - 1} ${SITE.z - 10} ${SITE.x + LEG + 4} ${Y - 1} ${SITE.z + 10} minecraft:stone`);
  await cmd(`fill ${SITE.x - 4} ${Y} ${SITE.z - 10} ${SITE.x + LEG + 4} ${Y + 4} ${SITE.z + 10} minecraft:air`);
}

async function bodyPos() {
  const s = await call("bot_status", {});
  const p = s.pos ?? s.position ?? s.pose;
  return { x: p.x, y: p.y, z: p.z };
}

const flatTo = (p, to) => Math.hypot(to.x - p.x, to.z - p.z);

/** The live session's manifest, read from disk — the artifact a loader actually consumes. */
function readManifest(dir) {
  return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
}

test("R-a: the manifest identifies its world by name + seed HASH, never by seed", { skip: skipRec }, async () => {
  const tag = await call("wm_session_tag", {}); // no purpose = read, stamp nothing
  assert.equal(typeof tag.session_dir, "string");
  const raw = readFileSync(join(tag.session_dir, "manifest.json"), "utf8");
  const m = JSON.parse(raw);

  assert.ok(m.world, `the manifest must carry the R-a world block: ${raw}`);
  assert.equal(typeof m.world.name, "string");
  assert.ok(m.world.name.length > 0, `the level name must be real: ${JSON.stringify(m.world)}`);
  assert.match(m.world.seed_sha256, /^[0-9a-f]{64}$/,
    `seed_sha256 must be a full lowercase sha256: ${JSON.stringify(m.world)}`);

  // The rule the recorder's class note states, checked against the bytes: no field named `seed`
  // anywhere in the file. (`"seed_sha256":` does not match — the key ends before the underscore.)
  assert.ok(!/"seed"\s*:/.test(raw), `a raw seed must never reach disk: ${raw}`);

  // Cross-check that the digest really is OVER THE SEED and not over something convenient:
  // get_world_info's seed_hash is the first 8 BYTES of the same sha256 of the same decimal
  // string, so the manifest's 64-hex must start with it. Neither value reveals the seed.
  const info = await call("get_world_info", {});
  assert.equal(typeof info.seed_hash, "string");
  assert.ok(m.world.seed_sha256.startsWith(info.seed_hash),
    `manifest hash and get_world_info's must agree: ${m.world.seed_sha256} vs ${info.seed_hash}`);

  // What the loader will actually key on (world_id = "w-" + first 8 hex).
  assert.match(`w-${m.world.seed_sha256.slice(0, 8)}`, /^w-[0-9a-f]{8}$/);
});

test("R-b: wm_session_tag stamps a purpose through to the manifest file", { skip: skipRec }, async () => {
  const r = await call("wm_session_tag", { purpose: "battery" });
  assert.equal(r.purpose, "battery");
  assert.equal(r.stamped, true);
  // Straight through to disk, not held until close(): a crashed session is exactly the session
  // whose provenance someone will need.
  assert.equal(readManifest(r.session_dir).purpose, "battery");

  // And the read path reports it without changing anything.
  const read = await call("wm_session_tag", {});
  assert.equal(read.purpose, "battery");
  assert.equal(read.stamped, false);
});

test("R-b: an unknown purpose is refused WITH the vocabulary, and stamps nothing", { skip: skipRec }, async () => {
  const before = await call("wm_session_tag", {});
  assert.equal(before.purpose, "battery", "the stamping case above must have run first");

  const bad = await callRaw("wm_session_tag", { purpose: "training" });
  assert.equal(bad.ok, false, `an unclassifiable tag must be refused: ${JSON.stringify(bad)}`);
  assert.match(JSON.stringify(bad.error), /taskgen/,
    `the refusal must name the vocabulary it wants: ${JSON.stringify(bad.error)}`);

  // 'adhoc' is refused for its own reason: it is what an UNTAGGED session already means, so
  // writing it would be claiming a classification by asserting the default.
  const adhoc = await callRaw("wm_session_tag", { purpose: "adhoc" });
  assert.equal(adhoc.ok, false, `'adhoc' is not applicable: ${JSON.stringify(adhoc)}`);

  const after = await call("wm_session_tag", {});
  assert.equal(after.purpose, "battery", "a refusal must leave the previous tag untouched");
  assert.equal(readManifest(after.session_dir).purpose, "battery");
});

test("R-c: wm_perturb refuses a body with no expert to recover it", { skip }, async () => {
  await stageStrip();
  await call("bot_body", { action: "spawn", type: "player", pos: { x: SITE.x, y: Y, z: SITE.z } });
  try {
    const r = await callRaw("wm_perturb", { ticks: 5 });
    assert.equal(r.ok, false,
      `a standing body has no navigation to hijack: ${JSON.stringify(r)}`);
    assert.match(JSON.stringify(r.error), /not navigating/,
      `the refusal must say WHY (a perturbation with no expert is a random walk): `
      + `${JSON.stringify(r.error)}`);
  } finally {
    await callRaw("bot_body", { action: "despawn" });
  }
});

test("R-c: a hijack drives 'perturb' ticks and hands the body back to the expert", { skip }, async () => {
  await stageStrip();
  await call("bot_body", { action: "spawn", type: "player", pos: { x: SITE.x, y: Y, z: SITE.z } });
  try {
    const goal = await call("bot_goto", { to: TARGET, within: 1.5 }); // no wait — hijack mid-leg
    assert.equal(goal.started, true, `the expert leg must start: ${JSON.stringify(goal)}`);
    await sleep(500); // a few honest expert ticks before the noise

    const armed = await call("wm_perturb", { ticks: 12 });
    assert.equal(armed.armed, true, JSON.stringify(armed));
    assert.equal(armed.actor, "perturb");
    assert.equal(armed.ticks, 12);
    assert.ok(Number.isInteger(armed.expires_tick) && armed.expires_tick > armed.now,
      `the absolute deadline is the expiry that needs nobody: ${JSON.stringify(armed)}`);

    // Poll to the end rather than trusting one sleep — the dev server's tick rate under a
    // concurrent battery is not a wall clock (12 ticks + 40 grace ≈ 2.6s at 20 tps).
    const deadline = Date.now() + 20_000;
    let st = await call("wm_perturb", { status: true });
    while (st.armed && Date.now() < deadline) {
      await sleep(250);
      st = await call("wm_perturb", { status: true });
    }
    assert.equal(st.armed, false, `the hijack must expire on its own: ${JSON.stringify(st)}`);
    assert.ok(st.last, "the tool keeps the last hijack's report — the rows themselves are inside "
      + "an open gzip stream and only the validator sees them");
    assert.equal(st.last.actor, "perturb");
    assert.ok(st.last.ticks_driven > 0,
      `the hijack must actually have driven ticks: ${JSON.stringify(st.last)}`);
    assert.ok(["budget", "deadline"].includes(st.last.ended), JSON.stringify(st.last));
    if (!recording) {
      console.log("  [note] recorder OFF — the hijack drove real ticks but recorded no rows");
    }

    // The hand-back, which is the whole product: with the budget spent the expert steers again
    // and closes the distance it had left. A stranded body would sit exactly where the noise
    // dropped it.
    const before = await bodyPos();
    await sleep(1500);
    const after = await bodyPos();
    assert.ok(flatTo(after, TARGET) < flatTo(before, TARGET) - 0.5,
      `the expert must resume after the hijack: ${flatTo(before, TARGET).toFixed(2)} → `
      + `${flatTo(after, TARGET).toFixed(2)} blocks from target`);
    // Edge care survived the hijack: random heading, not a random death.
    assert.ok(Math.abs(after.y - Y) < 1.5,
      `the body must still be on the platform: y=${after.y.toFixed(2)} vs ${Y}`);
  } finally {
    await callRaw("bot_body", { action: "despawn" });
  }
});

test("cleanup: clear the stage", { skip }, async () => {
  await cmd(`fill ${SITE.x - 4} ${Y - 1} ${SITE.z - 10} ${SITE.x + LEG + 4} ${Y + 4} ${SITE.z + 10} minecraft:air`);
  await cmd(`forceload remove ${SITE.x - 16} ${SITE.z - 16} ${SITE.x + LEG + 16} ${SITE.z + 16}`);
});
