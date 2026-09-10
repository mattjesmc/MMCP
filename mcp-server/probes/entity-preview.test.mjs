// Live probes for `stage_entity` — the entity editor's phase-1 arbiter
// (mcp-toolkit/docs/models/ENTITY_AUTHORING_DESIGN.md §7, phase 1).
//
// The tool is small; what it has to be is HONEST, because everything downstream of it is judged by
// eye. Four claims, each with its own way of being quietly wrong:
//
//   1. A STAGE IS A SLOT. Re-staging the same `tag` replaces what was there; `replace:false`
//      accumulates. Get that backwards and an author editing one model in a loop ends up with a
//      pile of ghosts standing inside each other, and the screenshot they judge is of the pile.
//   2. THE SIZE ARGUMENT IS A REAL HITBOX, not an echo. The reply can quote back whatever it was
//      handed; the only proof is a sense that the hitbox answers — so it is checked with `raycast`,
//      which hits an entity only where the entity actually is.
//   3. A STAGE STANDS STILL. No AI, no gravity, no push. A preview that drifts is a subject that
//      moved between the push and the look, and a contact-sheet grid that collapses.
//   4. `parse` IS THE CLIENT'S VERDICT, not the server's optimism. Broken geometry must come back
//      as parse:"error" WITH the message, or a headless author learns about it only by noticing a
//      magenta cube in a screenshot — which is exactly the workflow this tool exists to replace.
//      On a headless server there is nothing in the JVM that reads geometry, and the honest answer
//      is "no_client" — asserted as such rather than skipped, because a probe that only ever ran
//      one way is coupled to it.
//
// Staged at this file's own site (4.50M) and swept in `after`: previews are never persisted, but a
// forceloaded site keeps ticking, so a leftover stage is probe contamination like any other.
// Live probe: needs the dev game up. Skips itself when the bridge is down.
// Run with `npm run test:live`, or sequentially via `tools/battery.ps1`.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const X = 4_500_000, Z = 4_500_000, Y = 200; // this probe file's own site (site-map.test.mjs)

const SESSION = "probe-entity-preview";
async function raw(tool, args = {}) {
  const res = await fetch(`${BASE}/cmd`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-MCPTK-Session": SESSION },
    body: JSON.stringify({ tool, args }),
  });
  return res.json();
}
async function call(tool, args = {}) {
  const j = await raw(tool, args);
  if (!j.ok) throw new Error(`${tool} failed: ${JSON.stringify(j.error)}`);
  return j.result;
}
/** The error text of a call that must be refused (throws if it succeeded instead). */
async function refused(tool, args) {
  const j = await raw(tool, args);
  assert.equal(j.ok, false, `${tool} should have been refused, got ${JSON.stringify(j.result)}`);
  return JSON.stringify(j.error);
}
const cmd = (c) => call("run_command", { command: c });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const stage = (args) => call("stage_entity", { op: "stage", ...args });
const clear = (args = {}) => call("stage_entity", { op: "clear", ...args });
const list = () => call("stage_entity", { op: "list" });
/** Only this file's stages — the world may hold somebody else's, and a count is not a filter. */
const mine = async () => (await list()).staged.filter((s) => (s.tag ?? "").startsWith(SESSION));

const b64 = (o) => Buffer.from(JSON.stringify(o), "utf8").toString("base64");
/** A geometry file that loads: one part, one cube, vanilla model space (y down, feet at 24). */
const GOOD_GEOMETRY = {
  format: 1,
  texture: { width: 64, height: 64, asset: "mcptoolkit:textures/entity/drone.png" },
  parts: [
    { name: "body", parent: null, pivot: [0, 24, 0], rotation: [0, 0, 0],
      cubes: [{ origin: [-4, -16, -4], size: [8, 16, 8], uv: [20, 0], inflate: 0, mirror: false }] },
    { name: "head", parent: "body", pivot: [0, -16, 0],
      cubes: [{ origin: [-3, -6, -3], size: [6, 6, 6], uv: [0, 0] }] },
  ],
};
/** The same geometry with a clip on it — format 2. One bone, one channel, two keyframes, and the
 *  values are already in vanilla's units because the plugin does the whole conversion (§9.2). */
const CLIP_GEOMETRY = {
  ...GOOD_GEOMETRY,
  format: 2,
  animations: {
    wave: {
      length: 1, loop: true,
      bones: {
        head: [{
          target: "rotation",
          keyframes: [
            { t: 0, post: [0, 0, 0], interp: "linear" },
            { t: 0.5, post: [0, 0.5236, 0], interp: "linear" },
            { t: 1, post: [0, 0, 0], interp: "linear" },
          ],
        }],
      },
    },
  },
};
/** A clip that animates a bone the model does not have — the one failure `bake` throws on. */
const BAD_CLIP_GEOMETRY = {
  ...GOOD_GEOMETRY,
  format: 2,
  animations: {
    broken: {
      length: 1, loop: false,
      bones: { no_such_bone: [{ target: "position",
        keyframes: [{ t: 0, post: [0, 0, 0], interp: "linear" }] }] },
    },
  },
};
const OK_ID = "probe_entity_preview_ok";
const BAD_ID = "probe_entity_preview_bad";
const CLIP_ID = "probe_entity_preview_clip";
const BAD_CLIP_ID = "probe_entity_preview_badclip";
const ASSET = (id) => `assets/mcptoolkit/preview/${id}.json`;

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok)
  .catch(() => false);
if (!bridgeUp) {
  console.log(`\n  [skip] no bridge at ${BASE} — start the dev game to run these probes\n`);
}
// Whether a CLIENT is attached decides what `parse` can honestly say, and whether push_asset exists
// at all. Both arms are asserted; neither is skipped.
let clientPresent = false;
if (bridgeUp) {
  clientPresent = (await raw("ping", {})).result?.clientPresent === true;
}

describe("stage_entity: a stage is a slot, its size is a real hitbox, and `parse` is the client's",
  { skip: !bridgeUp }, () => {
  before(async () => {
    if (!bridgeUp) return;
    await cmd(`forceload add ${X - 16} ${Z - 16} ${X + 16} ${Z + 16}`);
    await sleep(1500); // forceload marks async
    // Clear air around the stage: the raycast tests must hit the preview or nothing, never a hill.
    await cmd(`fill ${X - 8} ${Y - 2} ${Z - 8} ${X + 8} ${Y + 8} ${Z + 8} minecraft:air`);
    await sleep(500);
    if (clientPresent) {
      await call("push_asset", { path: ASSET(OK_ID), base64: b64(GOOD_GEOMETRY), reload: false });
      // Deliberately broken: `parts` is the one field with no sane fallback, and a model with none
      // renders nothing — which is indistinguishable from a model that never loaded.
      await call("push_asset", { path: ASSET(BAD_ID), base64: b64({ format: 1, parts: [] }),
        reload: false });
      await call("push_asset", { path: ASSET(CLIP_ID), base64: b64(CLIP_GEOMETRY), reload: false });
      await call("push_asset", { path: ASSET(BAD_CLIP_ID), base64: b64(BAD_CLIP_GEOMETRY) });
      await sleep(1500); // the reload is a client resource reload
    }
  });

  after(async () => {
    if (!bridgeUp) return;
    await clear().catch(() => {});
    if (clientPresent) {
      for (const id of [OK_ID, BAD_ID, CLIP_ID, BAD_CLIP_ID]) {
        await raw("clear_assets", { path: ASSET(id), reload: false });
      }
      await raw("reload_resources", {});
    }
    await cmd(`fill ${X - 8} ${Y - 2} ${Z - 8} ${X + 8} ${Y + 8} ${Z + 8} minecraft:air`);
    await cmd(`forceload remove ${X - 16} ${Z - 16} ${X + 16} ${Z + 16}`);
  });

  // --- 1. a stage is a slot -------------------------------------------------------------------

  test("stage puts one preview where it was told, and list reports it", async (t) => {
    if (!bridgeUp) return t.skip();
    const tag = `${SESSION}-slot`;
    const r = await stage({ model: OK_ID, tag, pos: { x: X, y: Y, z: Z }, size: [1, 2] });
    assert.equal(r.tag, tag, JSON.stringify(r));
    assert.equal(r.model, OK_ID, JSON.stringify(r));
    assert.equal(r.pos.x, X, JSON.stringify(r.pos));
    assert.equal(r.pos.y, Y, JSON.stringify(r.pos));
    assert.equal(r.pos.z, Z, JSON.stringify(r.pos));
    assert.deepEqual(r.size, [1, 2], JSON.stringify(r.size));
    assert.ok(typeof r.id === "number" && r.uuid, "a stage must name the entity it made");
    assert.equal(r.dimension, "minecraft:overworld");
    await sleep(200);
    const staged = (await mine()).filter((s) => s.tag === tag);
    assert.equal(staged.length, 1, `list must report the one stage: ${JSON.stringify(staged)}`);
    assert.equal(staged[0].uuid, r.uuid, "list must report the entity stage just made");
    await clear({ tag });
  });

  test("re-staging a tag REPLACES; replace:false accumulates a contact sheet", async (t) => {
    if (!bridgeUp) return t.skip();
    const tag = `${SESSION}-reroll`;
    const first = await stage({ model: OK_ID, tag, pos: { x: X, y: Y, z: Z } });
    const second = await stage({ model: OK_ID, tag, pos: { x: X, y: Y, z: Z } });
    assert.equal(second.replaced, 1, "the second stage must say it replaced the first");
    assert.notEqual(second.uuid, first.uuid, "a replacement is a new body, not the old one renamed");
    await sleep(200);
    let staged = (await mine()).filter((s) => s.tag === tag);
    assert.equal(staged.length, 1, `re-staging must leave ONE preview: ${JSON.stringify(staged)}`);

    // ...and the contact sheet: same tag, accumulating on purpose.
    const third = await stage({ model: OK_ID, tag, pos: { x: X + 2, y: Y, z: Z }, replace: false });
    assert.equal(third.replaced, 0, "replace:false must replace nothing");
    await sleep(200);
    staged = (await mine()).filter((s) => s.tag === tag);
    assert.equal(staged.length, 2, `replace:false must accumulate: ${JSON.stringify(staged)}`);
    await clear({ tag });
  });

  test("clear takes one tag or everything, and reports how many it took", async (t) => {
    if (!bridgeUp) return t.skip();
    const keep = `${SESSION}-keep`;
    const drop = `${SESSION}-drop`;
    await stage({ model: OK_ID, tag: keep, pos: { x: X, y: Y, z: Z } });
    await stage({ model: OK_ID, tag: drop, pos: { x: X + 2, y: Y, z: Z } });
    await sleep(200);
    const cleared = await clear({ tag: drop });
    assert.equal(cleared.cleared, 1, JSON.stringify(cleared));
    await sleep(200);
    const left = await mine();
    assert.deepEqual(left.map((s) => s.tag), [keep], `only ${drop} should be gone: ${JSON.stringify(left)}`);
    const all = await clear();
    assert.ok(all.cleared >= 1, "an untagged clear takes everything staged");
    await sleep(200);
    assert.equal((await mine()).length, 0, "nothing of this probe's may survive an untagged clear");
  });

  // --- 2. the size argument is a real hitbox ---------------------------------------------------

  test("`size` is the hitbox, not an echo — a ray hits the tall stage and misses the short one", async (t) => {
    if (!bridgeUp) return t.skip();
    const tag = `${SESSION}-size`;
    // A ray along -x at head height for a 3-block stage. Whether it connects is decided by the
    // entity's bounding box, which is the one thing an echoed argument cannot fake.
    const ray = { origin: { x: X + 6, y: Y + 2.5, z: Z + 0.5 }, direction: { x: -1, y: 0, z: 0 } };

    await stage({ model: OK_ID, tag, pos: { x: X, y: Y, z: Z + 0.5 }, size: [2, 3] });
    await sleep(300);
    const tall = await call("raycast", ray);
    assert.equal(tall.hit, "entity", `a 3-block stage must be hit at y+2.5: ${JSON.stringify(tall)}`);
    assert.equal(tall.entity?.type, "mcptoolkit:preview", JSON.stringify(tall.entity));

    // Same position, same ray, one block tall: the ray must now pass straight over it.
    await stage({ model: OK_ID, tag, pos: { x: X, y: Y, z: Z + 0.5 }, size: [1, 1] });
    await sleep(300);
    const short = await call("raycast", ray);
    assert.notEqual(short.hit, "entity",
      `a 1-block stage must NOT be hit at y+2.5: ${JSON.stringify(short)}`);
    await clear({ tag });
  });

  // --- 3. a stage stands still ------------------------------------------------------------------

  test("a preview does not fall, drift, or take damage — it stands where it was staged", async (t) => {
    if (!bridgeUp) return t.skip();
    const tag = `${SESSION}-still`;
    // Staged in mid-air over the cleared pocket: gravity is the failure this catches, and a stage
    // on the floor could not tell a body that fell from one that never moved.
    const at = { x: X + 4.5, y: Y + 5, z: Z + 4.5 };
    const staged = await stage({ model: OK_ID, tag, pos: at });
    await sleep(1500); // ~30 ticks: a falling body is 11 blocks down by now
    const [after] = (await mine()).filter((s) => s.tag === tag);
    assert.ok(after, "the stage must still exist");
    assert.equal(after.uuid, staged.uuid);
    assert.equal(after.pos.y, at.y, `a stage must not fall: ${JSON.stringify(after.pos)}`);
    assert.equal(after.pos.x, at.x, `a stage must not drift: ${JSON.stringify(after.pos)}`);
    assert.equal(after.pos.z, at.z, `a stage must not drift: ${JSON.stringify(after.pos)}`);
    await clear({ tag });
  });

  test("spin and yaw are recorded on the stage", async (t) => {
    if (!bridgeUp) return t.skip();
    const tag = `${SESSION}-spin`;
    const r = await stage({ model: OK_ID, tag, pos: { x: X, y: Y, z: Z }, yaw: 90, spin: true });
    assert.equal(r.spin, true, JSON.stringify(r));
    assert.ok(Math.abs(r.yaw - 90) < 0.01, `yaw must be what was asked: ${r.yaw}`);
    await clear({ tag });
  });

  // --- 4. parse is the client's verdict ---------------------------------------------------------

  test("`parse` reports the CLIENT's reading of the geometry, or says there is no client", async (t) => {
    if (!bridgeUp) return t.skip();
    const tag = `${SESSION}-parse`;
    const ok = await stage({ model: OK_ID, tag, pos: { x: X, y: Y, z: Z } });
    if (!clientPresent) {
      // Headless: nothing in this JVM reads geometry, and saying "ok" would be a claim the server
      // is in no position to make. This arm is asserted, not skipped — see the header.
      assert.equal(ok.parse, "no_client", JSON.stringify(ok));
      assert.equal(ok.parse_error, undefined, "no_client has no parse error to report");
      await clear({ tag });
      return;
    }
    assert.equal(ok.parse, "ok", `pushed geometry must parse: ${JSON.stringify(ok)}`);
    assert.equal(ok.parse_error, undefined, "a clean parse carries no error");

    // Broken geometry: the error model on screen, and the REASON in the reply.
    const bad = await stage({ model: BAD_ID, tag, pos: { x: X, y: Y, z: Z } });
    assert.equal(bad.parse, "error", `empty parts must not read as ok: ${JSON.stringify(bad)}`);
    assert.match(bad.parse_error ?? "", /parts/i,
      `the parse error must name what is wrong: ${bad.parse_error}`);

    // A model that was never pushed at all is the same class of answer, and the message has to say
    // where the file was looked for — "it did not load" is not actionable on its own.
    const missing = await stage({ model: "probe_entity_preview_absent", tag, pos: { x: X, y: Y, z: Z } });
    assert.equal(missing.parse, "error", JSON.stringify(missing));
    assert.match(missing.parse_error ?? "", /preview\/probe_entity_preview_absent/,
      `the message must name the path it looked at: ${missing.parse_error}`);

    // And list carries the same verdict as stage did — an author who staged five and walks away
    // must be able to ask which of them is broken.
    await sleep(200);
    const [row] = (await mine()).filter((s) => s.tag === tag);
    assert.equal(row.parse, "error", JSON.stringify(row));
    await clear({ tag });
  });

  // --- 5. clips (§9) --------------------------------------------------------------------------

  test("a format-2 model reports its clips, and `clip` / `clip_time` ride the stage", async (t) => {
    if (!bridgeUp) return t.skip();
    const tag = `${SESSION}-clip`;
    const played = await stage({ model: CLIP_ID, tag, pos: { x: X, y: Y, z: Z }, clip: "wave" });
    assert.equal(played.clip, "wave", JSON.stringify(played));
    // `clip_time` is absent when the clip is PLAYING — a stage that reported a frozen time it is
    // not holding would read as a still when it is a loop.
    assert.equal(played.clip_time, undefined, JSON.stringify(played));

    const frozen = await stage({ model: CLIP_ID, tag, pos: { x: X, y: Y, z: Z },
      clip: "wave", clip_time: 0.25 });
    assert.equal(frozen.clip_time, 0.25, JSON.stringify(frozen));

    if (!clientPresent) {
      // The server never reads geometry (§4.3), so the clip NAMES are the client's to know. On a
      // headless server the honest answer is to list none — asserted, not skipped, because a probe
      // that only ever ran one way is coupled to it.
      assert.equal(played.clips, undefined, JSON.stringify(played));
      assert.equal(played.clip_error, undefined,
        "with no client to ask, a clip name cannot be called wrong");
      await clear({ tag });
      return;
    }
    assert.deepEqual(played.clips, ["wave"], JSON.stringify(played));
    assert.equal(played.parse, "ok", JSON.stringify(played));

    // A misspelt clip is the commonest way to stage a statue and not know why, so it is named as
    // an error WITH the list — while the body still stands, in the rest pose, rather than vanishing.
    const wrong = await stage({ model: CLIP_ID, tag, pos: { x: X, y: Y, z: Z }, clip: "waev" });
    assert.equal(wrong.parse, "ok", "a bad clip name is not bad GEOMETRY");
    assert.match(wrong.clip_error ?? "", /waev/, JSON.stringify(wrong));
    assert.match(wrong.clip_error ?? "", /wave/, "it must say what IS there");
    await clear({ tag });
  });

  test("a clip naming a bone the model does not have is an ERROR, not a render crash", async (t) => {
    if (!bridgeUp) return t.skip();
    const tag = `${SESSION}-badclip`;
    const bad = await stage({ model: BAD_CLIP_ID, tag, pos: { x: X, y: Y, z: Z }, clip: "broken" });
    if (!clientPresent) {
      assert.equal(bad.parse, "no_client", JSON.stringify(bad));
      await clear({ tag });
      return;
    }
    // `AnimationDefinition.bake` throws on an unknown bone. Caught at LOAD time it is the magenta
    // error model plus a message; uncaught it would be an exception thrown mid-frame, every frame,
    // which is the client crash §10 exists to keep out of this tool.
    assert.equal(bad.parse, "error", JSON.stringify(bad));
    assert.match(bad.parse_error ?? "", /broken/, "the message must name the CLIP");
    assert.match(bad.parse_error ?? "", /no_such_bone/, "and the bone that is missing");

    // The game is still answering, which is the actual claim being made here.
    const pong = await call("ping", {});
    assert.equal(pong.clientPresent, true, "the client survived the bad clip");
    await clear({ tag });
  });

  test("a format-1 file still loads, so shipping format 2 loses nothing (§9.5)", async (t) => {
    if (!bridgeUp || !clientPresent) return t.skip();
    const tag = `${SESSION}-fmt1`;
    // OK_ID is written as `format: 1` at the top of this file and never re-exported.
    const one = await stage({ model: OK_ID, tag, pos: { x: X, y: Y, z: Z } });
    assert.equal(one.parse, "ok", JSON.stringify(one));
    assert.equal(one.clips, undefined, "a format-1 model carries no clips");
    await clear({ tag });
  });

  // --- refusals -----------------------------------------------------------------------------

  test("the arguments it does not have are refusals, not shrugs", async (t) => {
    if (!bridgeUp) return t.skip();
    assert.match(await refused("stage_entity", { op: "reroll" }), /unknown `op`|stage \| clear \| list/);
    assert.match(await refused("stage_entity", {}), /op/);
    assert.match(await refused("stage_entity", { op: "stage" }), /model/);
    assert.match(await refused("stage_entity", { op: "stage", model: OK_ID, size: [2] }), /size/);
    assert.match(await refused("stage_entity", { op: "stage", model: OK_ID, size: [0, 2] }), /size/);
    // `clip_time` is seconds INTO a clip: without one it has nothing to be a time into, and a
    // negative one collides with the sentinel that means "play" (PreviewEntity.PLAY).
    assert.match(await refused("stage_entity",
      { op: "stage", model: CLIP_ID, clip_time: 0.5 }), /clip/);
    assert.match(await refused("stage_entity",
      { op: "stage", model: CLIP_ID, clip: "wave", clip_time: -1 }), /negative|clip_time/);
    // ArgCheck's job, asserted here because this tool's `op` is the surface's odd one out: every
    // other family verb calls it `action`, so a caller reaching for that name must be told.
    assert.match(await refused("stage_entity", { op: "list", action: "list" }), /action/);
  });
});
