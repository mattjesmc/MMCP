// The camera — RENDER_SEAM_DESIGN.md phase 1, and the phase-2 arbiter that has been owed since
// toolkit 0.102.0 shipped the canvas without an instrument that could look at it.
//
// §11.4's "still owed" list opened with one word: A PIXEL. The studio's JSON validates against the
// game's own codec and its dimension loads, and that is ALL that was ever proved — "skybox:none plus
// a white visual/fog_color produces a uniformly white frame" was an inference from
// LevelRenderer.java:203 that nobody had ever looked at. These cases are what turns it into a fact,
// and they decode the PNG rather than trusting the tool's own account of it.
//
// FOUR ARBITERS, and the fourth is the one that keeps the other three honest:
//
//   (a) A FRAME COMES OUT, AND IT IS NOT THE WINDOW. The PNG decodes, its IHDR carries the size that
//       was ASKED FOR, two different requests give two different sizes, and neither equals the
//       window the human is looking at. That is what "out of band" means operationally: the
//       resolution is an argument, not a property of somebody's monitor.
//   (b) THE STUDIO IS THE COLOUR IT DECLARES. Render the empty studio and assert every sampled pixel
//       is the `visual/fog_color` READ OUT OF studio.json — never a constant typed here, which is
//       the place-shapes lesson (a preview nobody compares against the live run drifts silently) and
//       §7's own instruction for this exact check.
//   (c) THE FALSIFIER FOR (b), WITHOUT WHICH IT IS WORTHLESS. A uniform-colour assertion is the
//       "delete the restriction to go green" shape §8 trap 2 names: a frame that is uniformly white
//       because the level never rendered passes it, and so does a stale one, and so does a widened
//       tolerance. So: put a wall of black concrete in front of the same camera and assert the
//       CENTRE pixel is no longer the background while the CORNERS still are. Uniform-white can only
//       survive both if the camera really is photographing the studio.
//   (d) THE RESTORE PATH, EXERCISED RATHER THAN ASSUMED. `render` resizes the window, moves the
//       player and mutates their rotation, and puts all of it back in a `finally`. A restore path
//       with no falsifier is one that will silently stop working, so this drives a render THROUGH a
//       throw — vanilla's own divisibility guard, which lands after the mutation on purpose (see
//       RenderTools' class comment) — and then asserts the NEXT render finds the window and the
//       player exactly where the one before it did. `restored` is read back off the live objects
//       after the finally, so a restore that ran and did not take is caught too.
//
// SITE: the studio at x=-4096, z=-4096. Deliberately NEGATIVE, because canvas slots are allocated at
// `(slot % row) * 512` from the origin and are therefore all non-negative — trap 12 (two sessions at
// one origin is the probe-site collision again) applies to the canvas as much as to the overworld,
// and the cheapest way to own a site nobody allocates is to stand outside the allocator's range.
//
// Live probe: needs the dev game up WITH A CLIENT (`gradlew runClient`) — the camera drives the
// render loop, so there is nothing to do headless. The studio half additionally needs the canvas
// dimensions, which a world that has never had this toolkit in it only gets on its SECOND start.
// Run with `npm run test:live`, or sequentially via `tools/battery.ps1`.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { readFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { available as windowAvailable, gameWindow } from "./fixtures/game-window.mjs";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const SESSION = "probe-render-camera";

const STUDIO = "mcptoolkit:studio";
// The site, and the camera that looks at it. The wall stands 8 blocks in front of a camera facing
// south (yaw 0 is +Z), so the centre of the frame is wall and the edges are open studio.
const SX = -4096, SY = 80, SZ = -4096;
const EYE = { x: SX + 0.5, y: SY + 20, z: SZ + 0.5 }; // 20 above the player, so a skipped restore shows
const WALL_Z = SZ + 8;

const HERE = dirname(fileURLToPath(import.meta.url));
const RESOURCES = join(HERE, "..", "..", "mcp-toolkit", "src", "main", "resources");

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
async function refused(tool, args) {
  const j = await raw(tool, args);
  assert.equal(j.ok, false, `${tool} ${JSON.stringify(args)} should have been refused: ${JSON.stringify(j.result)}`);
  return JSON.stringify(j.error);
}
const cmd = async (c) => (await call("run_command", { command: c })).output.join("\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- a PNG decoder, because the arbiter for a picture is its pixels -------------------------
//
// Node ships zlib and nothing else, and the alternative to fifty lines here is to ask the tool that
// wrote the file what is in it — which is the tool grading its own homework. It handles exactly what
// NativeImage writes (8-bit, non-interlaced, colour type 2 or 6) and ASSERTS that rather than
// assuming it, so a format change is a loud failure instead of a wrong colour.

function decodePng(path) {
  const buf = readFileSync(path);
  assert.deepEqual([...buf.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${path} is not a PNG`);
  let width = 0, height = 0, depth = 0, colour = 0, interlace = 0;
  const idat = [];
  for (let off = 8; off + 8 <= buf.length; ) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colour = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len;
  }
  assert.equal(depth, 8, `only 8-bit PNGs are decoded here; ${path} is ${depth}-bit`);
  assert.equal(interlace, 0, `only non-interlaced PNGs are decoded here (${path})`);
  assert.ok(colour === 2 || colour === 6, `unexpected PNG colour type ${colour} in ${path}`);
  const channels = colour === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const outLine = pixels.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? outLine[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) {
        assert.fail(`unknown PNG filter ${filter} on row ${y} of ${path}`);
      }
      outLine[i] = v & 0xff;
    }
    prev = outLine;
  }
  const at = (x, y) => {
    const i = y * stride + x * channels;
    return [pixels[i], pixels[i + 1], pixels[i + 2]];
  };
  return { width, height, at };
}

/** Chebyshev distance between two RGB triples — the honest way to say "this colour, near enough". */
const dist = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));

/** The colour the DIMENSION FILE declares, parsed from the shipped bytes. Never a constant here. */
function declaredFog() {
  const json = JSON.parse(readFileSync(join(RESOURCES, "data/mcptoolkit/dimension_type/studio.json"), "utf8"));
  const hex = json.attributes["visual/fog_color"];
  assert.match(hex, /^#[0-9a-fA-F]{6}$/, `studio.json's visual/fog_color is not a hex colour: ${hex}`);
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

// ---- liveness ---------------------------------------------------------------

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok)
  .catch(() => false);
let clientPresent = false;
if (bridgeUp) clientPresent = (await raw("ping", {})).result?.clientPresent === true;
if (!bridgeUp) {
  console.log(`\n  [skip] no bridge at ${BASE} — start the dev game to run these probes\n`);
} else if (!clientPresent) {
  console.log("\n  [skip] bridge is up but headless — the camera IS the render loop, so it needs a client\n");
}

const written = [];
/** Render, remember the file so `after` can sweep it, and hand back the reply. */
async function render(args) {
  const r = await call("render", args);
  written.push(r.path);
  return r;
}

describe("the camera renders out of band, and the frame is a fact", { skip: !bridgeUp || !clientPresent }, () => {
  after(() => {
    for (const p of written) {
      try {
        unlinkSync(p);
      } catch {
        /* the probe's own litter; a file that is already gone is fine */
      }
    }
  });

  test("a frame comes out, it decodes, and its size is the one that was ASKED for", async () => {
    const r = await render({ width: 256, height: 256 });
    assert.equal(r.width, 256, JSON.stringify(r));
    assert.equal(r.height, 256);
    assert.ok(r.bytes > 0, `an empty file is not a frame: ${JSON.stringify(r)}`);
    const png = decodePng(r.path);
    // The reply and the FILE are two different claims. Only the second one is the picture.
    assert.equal(png.width, 256, "the PNG on disk disagrees with the reply about its own width");
    assert.equal(png.height, 256);
  });

  test("the resolution is an argument, not the window", async () => {
    const a = await render({ width: 256, height: 256 });
    const b = await render({ width: 320, height: 192 });
    const pngB = decodePng(b.path);
    assert.equal(pngB.width, 320, JSON.stringify(b));
    assert.equal(pngB.height, 192);
    // The whole claim of "out of band" in one assertion: two frames of the same scene, two sizes,
    // and neither of them is the size of the window the human is looking at.
    const w = b.restored.window;
    assert.notDeepEqual([a.width, a.height], [b.width, b.height]);
    assert.ok(w.width !== 320 || w.height !== 192,
      `the window happens to BE 320x192, so this case proves nothing: ${JSON.stringify(w)}`);
    assert.ok(w.width !== 256 || w.height !== 256, `the window happens to BE 256x256: ${JSON.stringify(w)}`);
  });

  test("downscale supersamples: rendered large, written small", async () => {
    const r = await render({ width: 512, height: 512, downscale: 2 });
    assert.equal(r.width, 256, `downscale 2 of a 512 render is a 256 image: ${JSON.stringify(r)}`);
    assert.equal(r.height, 256);
    assert.deepEqual(r.rendered, { width: 512, height: 512 });
    assert.equal(r.downscale, 2);
    assert.equal(decodePng(r.path).width, 256);
  });

  test("a size that does not divide by downscale is refused, and it says which", async () => {
    const err = await refused("render", { width: 257, height: 512, downscale: 2 });
    assert.match(err, /divide/, `the refusal must name the divisibility: ${err}`);
  });

  test("the window survives a render that THREW — the finally is a path, not a hope", async () => {
    // The refusal above lands after the window has been resized and the level rendered (deliberately:
    // it is the only argument-reachable throw that does). If the finally did not run, the window is
    // still 257x512 now, and the NEXT render — which saves what it finds on entry and restores that —
    // reports the corrupted size back. This is the only way to see it from outside.
    const before = await render({ width: 256, height: 256 });
    await refused("render", { width: 257, height: 512, downscale: 2 });
    const after = await render({ width: 256, height: 256 });
    assert.deepEqual(after.restored.window, before.restored.window,
      "a render that threw left the window resized — the finally did not restore it");
  });
});

// ---- the studio: the phase-2 arbiter, owed since 0.102.0 --------------------

let canvas = false;
if (bridgeUp && clientPresent) {
  try {
    await call("get_blocks_at", { blocks: [{ x: 0, y: 64, z: 0 }], dimension: STUDIO });
    canvas = true;
  } catch {
    canvas = false;
  }
}
if (bridgeUp && clientPresent && !canvas) {
  console.log("\n  [skip] the studio dimension is not in this world — it arrives on the NEXT world start\n");
}

describe("the studio is the colour it declares, and a subject in it is not", { skip: !canvas }, () => {
  const fog = declaredFog();
  let empty;
  let home = null; // where the human was standing before this file moved them

  before(async () => {
    // Stand the client in the studio at the site. The camera can only photograph chunks this client
    // has been sent, so the player has to BE here — that is the refusal `render` gives otherwise, and
    // satisfying it is part of the setup rather than something to work around.
    //
    // By NAME, out of `list`, rather than by selector: @p and @e are scoped to the executing
    // dimension, and `execute in <studio>` makes that a dimension with nobody in it yet — the
    // selector matches nothing and the whole setup silently does not happen.
    const who = (await cmd("list")).match(/online:\s*(.+)$/m);
    assert.ok(who, "could not read a player name out of /list — is anybody actually connected?");
    const name = who[1].split(",")[0].trim();
    // WHERE THEY WERE, before moving them. See the after() below: this is not politeness.
    const pos = (await cmd(`data get entity ${name} Pos`)).match(/\[([-\d.d]+), ([-\d.d]+), ([-\d.d]+)\]/);
    const dim = (await cmd(`data get entity ${name} Dimension`)).match(/"([^"]+)"/);
    if (pos && dim) {
      home = { name, dimension: dim[1], x: parseFloat(pos[1]), y: parseFloat(pos[2]), z: parseFloat(pos[3]) };
    }
    await cmd(`execute in ${STUDIO} run tp ${name} ${SX + 0.5} ${SY} ${SZ + 0.5} 0 0`);
    await sleep(1500); // chunks over the wire, and the section compiler behind them
  });

  after(async () => {
    await wall(".").catch(() => {});
    // PUT THE HUMAN BACK IN THEIR OWN DIMENSION, and this is the whole reason `home` exists.
    // [[probe-site-ownership]] is about two files sharing COORDINATES; this is the same class one
    // level up. Reads that are not given a `dimension` answer about the dimension the player is
    // standing in, so a file that leaves them in the studio silently redirects every later probe's
    // reads into an empty flat void — where `locate` reports `unreadable`, `check_site` reports
    // nothing, and a hoe tills no dirt. That cost a whole battery run (predicates and player-hands
    // red, in files this one cannot otherwise touch) before the cause was found, and the failures
    // named a dimension nobody had asked about.
    if (home) {
      await cmd(`execute in ${home.dimension} run tp ${home.name} ${home.x} ${home.y} ${home.z}`)
        .catch(() => {});
    }
  });

  /** The 13x13 wall in front of the camera, as one symbol. `.` is air, which is how it comes down. */
  const wall = (symbol) => call("set_blocks", {
    min: { x: SX - 6, y: SY + 14, z: WALL_Z },
    legend: { a: "minecraft:black_concrete" },
    layers: Array.from({ length: 13 }, () => [symbol.repeat(13)]),
    dimension: STUDIO,
  });

  test("an empty studio renders as the fog colour its dimension file declares", async () => {
    empty = await render({ at: EYE, yaw: 0, pitch: 0, width: 256, height: 256 });
    assert.equal(empty.dimension, STUDIO, `photographed the wrong level: ${JSON.stringify(empty)}`);
    assert.equal(empty.settled, true, `the sections were still compiling: ${JSON.stringify(empty)}`);
    // `settled` must have cost more than one clear reading of the compile queue, because one clear
    // reading is a lie: compileSections dispatches compileAsync at the END of LevelRenderer.render,
    // so the pass that discovers a changed section leaves the queue empty behind it and a loop that
    // believed it would exit having drawn nothing new. Measured 2026-08-28 at `passes:2` returning a
    // white frame while an 11-block cube stood in front of the camera. Four is the floor now.
    assert.ok(empty.passes >= 4,
      `a settled render took only ${empty.passes} passes — the settle loop is trusting a single `
      + "empty read of a queue that is empty before the work is scheduled");
    const png = decodePng(empty.path);
    // Sample a grid rather than a handful of points: a sky pass that ran, a void gradient, or a
    // horizon disc are all LOCAL failures, and three corners would miss every one of them.
    const off = [];
    for (let y = 4; y < png.height; y += 16) {
      for (let x = 4; x < png.width; x += 16) {
        const px = png.at(x, y);
        if (dist(px, fog) > 6) off.push(`${x},${y}=${px.join()}`);
      }
    }
    assert.equal(off.length, 0,
      `the empty studio is not uniformly ${fog.join()} (studio.json's visual/fog_color). Off: ${off.slice(0, 8).join(" ")}`);
  });

  test("the camera lands where it was asked, not where the player stands", async () => {
    // camera_at is read back off the Camera after the placement, so this is the eye-height correction
    // being checked rather than an argument being echoed. A camera that quietly sat on the player's
    // head would be 20 blocks low here and every framing decision built on it would be wrong.
    assert.ok(empty, "the empty-studio case must run first");
    assert.ok(Math.abs(empty.camera_at.x - EYE.x) < 0.01, JSON.stringify(empty.camera_at));
    assert.ok(Math.abs(empty.camera_at.y - EYE.y) < 0.01,
      `the camera is not at the eye it was given: ${JSON.stringify(empty.camera_at)} vs ${JSON.stringify(EYE)}`);
    assert.ok(Math.abs(empty.camera_at.z - EYE.z) < 0.01, JSON.stringify(empty.camera_at));
  });

  test("A SUBJECT IN FRONT OF IT IS NOT — the falsifier for the case above", async () => {
    // Without this, "uniformly white" is passed by a frame that never rendered the level at all, by a
    // stale frame, and by any tolerance somebody widens to make a red build go green.
    await wall("a");
    await sleep(1000); // the client has to be told about the wall before it can photograph it
    const r = await render({ at: EYE, yaw: 0, pitch: 0, width: 256, height: 256 });
    const png = decodePng(r.path);
    const centre = png.at(128, 128);
    assert.ok(dist(centre, fog) > 40,
      `the wall did not appear: the centre pixel is still ${centre.join()}, the background colour. `
      + "Either nothing was rendered or the frame is a stale one.");
    // ...and the corners must STILL be the background, or the frame changed for some reason that has
    // nothing to do with the wall (a fog change, a screen effect, a tone map) and proves nothing.
    for (const [x, y] of [[2, 2], [253, 2], [2, 253], [253, 253]]) {
      assert.ok(dist(png.at(x, y), fog) <= 6,
        `corner ${x},${y} is ${png.at(x, y).join()}, not the studio background — the whole frame moved`);
    }
  });

  test("A MINIMIZED WINDOW RENDERS THE SAME WALL - trap 7 of the design record, corrected", { skip: !windowAvailable || !gameWindow("state").found }, async () => {
    // Until 0.134.0 `render` refused an iconified window ("Minecraft gates rendering on that"),
    // and one hand on the taskbar cost the 2026-09-07 battery 21 red cases. The gate at
    // Minecraft.java:1243 is around acquiring the window SURFACE; this pass draws into the main
    // render target and never touches the surface. So: the real window minimized, the same wall
    // shot as above, the same arbiter - centre not background, corners background - and the reply
    // saying so. A stale frame would also pass the pixel half, which is why the case above ran
    // first with the wall already up: the frame this one takes cannot be the empty studio's.
    // The window goes back in a finally; restoring activates it, and this is the one place in the
    // battery that does it.
    let r;
    const was = gameWindow("minimize");
    try {
      assert.equal(was.iconic, true, "the window did not minimize; nothing below measures anything");
      r = await render({ at: EYE, yaw: 0, pitch: 0, width: 256, height: 256 });
    } finally {
      const back = gameWindow("restore");
      assert.equal(back.iconic, false, "the window did not come back; the files after this one need it");
    }
    assert.equal(r.window_minimized, true, `the reply must say the window was minimized: ${JSON.stringify(r)}`);
    assert.equal(r.settled, true, `iconified, the sections still settle: ${JSON.stringify(r)}`);
    const png = decodePng(r.path);
    const centre = png.at(128, 128);
    assert.ok(dist(centre, fog) > 40, `minimized, the wall did not appear: centre ${centre.join()}`);
    for (const [x, y] of [[2, 2], [253, 2], [2, 253], [253, 253]]) {
      assert.ok(dist(png.at(x, y), fog) <= 6, `minimized, corner ${x},${y} is ${png.at(x, y).join()}`);
    }
    // And with the window up, the flag is absent rather than false: it is a note, not a field.
    const up = await render({ at: EYE, yaw: 0, pitch: 0, width: 128, height: 128 });
    assert.equal(up.window_minimized, undefined, JSON.stringify(up));
  });

  test("the player is put back where they were standing", async () => {
    // The other half of (d): `at` moved the LOCAL PLAYER to place the camera (renderLevel has no
    // camera without one), 20 blocks above where the human is standing. Two renders in a row must
    // report the same standing position, or the first one kept them.
    const a = await render({ at: EYE, yaw: 0, pitch: 0, width: 128, height: 128 });
    const b = await render({ at: EYE, yaw: 0, pitch: 0, width: 128, height: 128 });
    assert.deepEqual(b.restored.player, a.restored.player,
      "the first render left the player at the camera — the finally did not put them back");
    assert.ok(Math.abs(a.restored.player.y - SY) < 0.6,
      `the player is not on the platform any more: ${JSON.stringify(a.restored.player)}`);
  });

  // ---- phase 3: framing and orbit -------------------------------------------
  //
  // §7's arbiter, verbatim: "a subject of known bounds framed automatically; assert the rendered
  // subject's bounding box in pixels sits inside the frame with margin, at several `distance` values
  // and AT MORE THAN ONE SUBJECT SIZE. Framing that is right for one size and wrong for others is the
  // obvious failure and one size cannot catch it."
  //
  // The studio is what makes this measurable at all: the background is one declared colour, so "which
  // pixels are the subject" is a threshold rather than a guess, and the subject's bounding box in
  // pixels is a fact read off the file. Three things are asserted about it, and the second is the one
  // that would catch a plausible-but-wrong framing formula:
  //
  //   MARGIN — nothing touches an edge. A subject with its head cut off is the failure that matters.
  //   SIZE INVARIANCE — a 3-block cube and an 11-block cube must come back the SAME SIZE ON SCREEN.
  //     This is not a tolerance dressed up as a check: the camera stands at centre + k·r·û for a k
  //     that depends only on the frame's aspect, so the two shots are geometrically SIMILAR and their
  //     silhouettes are identical up to pixel quantisation. Any framing rule with an additive term in
  //     it — "stand back radius + 10", "clamp to 16 blocks" — breaks this and passes everything else.
  //   FILL — the subject is a large fraction of the frame. Without it, "inside the frame with margin"
  //     is passed most convincingly by a camera parked in the next chunk, and the margin assertion
  //     alone would have congratulated it.
  //
  // The reported `distance` is checked only for RELATIONS — it scales linearly with the subject's
  // radius, and a narrower frame stands further back. Re-implementing the formula here would be the
  // test grading its own homework against a constant copied out of the thing it is testing.
  describe("look_at frames the subject, and frames:N orbits it", () => {
    // Well above the wall above, so a stray corner of black concrete cannot be counted as subject.
    const CUBE = { x: SX - 5, y: SY + 40, z: SZ - 5 };
    const BIG = 11;
    /** An n-cube of `symbol` growing from CUBE's corner; `.` is air, which is how it comes down. */
    const cube = (n, symbol) => call("set_blocks", {
      min: CUBE,
      legend: { a: "minecraft:black_concrete" },
      layers: Array.from({ length: n }, () => Array.from({ length: n }, () => symbol.repeat(n))),
      dimension: STUDIO,
    });
    const boxOf = (n) => ({ min: CUBE, max: { x: CUBE.x + n - 1, y: CUBE.y + n - 1, z: CUBE.z + n - 1 } });
    /** The world-space centre of an n-cube — inclusive block box, so it spans min..max+1. */
    const centreOf = (n) => ({ x: CUBE.x + n / 2, y: CUBE.y + n / 2, z: CUBE.z + n / 2 });
    const radiusOf = (n) => 0.5 * Math.sqrt(3 * n * n);

    /**
     * The subject's bounding box in pixels: everything that is not the declared background. The
     * whole reason the studio exists is that this is a threshold and not a segmentation problem.
     */
    function subjectBox(png) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, pixels = 0;
      for (let y = 0; y < png.height; y++) {
        for (let x = 0; x < png.width; x++) {
          if (dist(png.at(x, y), fog) > 40) {
            pixels++;
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
        }
      }
      if (pixels === 0) return null;
      return { x0, y0, x1, y1, pixels, w: x1 - x0 + 1, h: y1 - y0 + 1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
    }

    /** Everything a framed shot must be true of, in one place, so each case says only what is new. */
    function assertFramed(png, box, label) {
      assert.ok(box, `${label}: nothing but background in the frame — the subject was not photographed`);
      assert.ok(box.x0 >= 3 && box.y0 >= 3 && box.x1 <= png.width - 4 && box.y1 <= png.height - 4,
        `${label}: the subject touches the edge, so it is cut off: ${JSON.stringify(box)} in ${png.width}x${png.height}`);
      const fill = Math.max(box.w / png.width, box.h / png.height);
      assert.ok(fill > 0.4 && fill < 0.95,
        `${label}: the subject fills ${fill.toFixed(2)} of the frame — inside it, but not FRAMED by it`);
      assert.ok(Math.abs(box.cx - png.width / 2) < png.width * 0.1
        && Math.abs(box.cy - png.height / 2) < png.height * 0.1,
        `${label}: the subject is off centre at ${box.cx},${box.cy} in ${png.width}x${png.height}`);
      return fill;
    }

    /**
     * Wait until the CLIENT can actually see the subject, and fail loudly if it never can.
     *
     * `settled:true` does NOT mean "the world you just wrote is in the picture" — it means the
     * section compiler has nothing queued. Measured 2026-08-28: an 11-cube written by `set_blocks`
     * renders as an empty white frame with `settled:true, passes:2` for the first ~900ms, then
     * appears all at once. The block updates are still travelling from the server, and no camera can
     * see that. So the wait is a SETUP step with its own failure, never a sleep long enough to hope.
     *
     * It watches through a plain phase-1 shot — an explicit `at` due south of the subject, level,
     * aimed by hand — so a framing bug cannot be mistaken for a slow client or the other way round.
     */
    async function awaitVisible(n, label) {
      const c = centreOf(n);
      const watch = { at: { x: c.x, y: c.y, z: c.z + 12 }, yaw: 180, pitch: 0, width: 128, height: 128 };
      for (let i = 0; i < 20; i++) {
        const r = await render(watch);
        const png = decodePng(r.path);
        let dark = 0;
        for (let y = 0; y < png.height; y += 2) {
          for (let x = 0; x < png.width; x += 2) {
            if (dist(png.at(x, y), fog) > 40) dark++;
          }
        }
        if (dark > 50) return;
        await sleep(300);
      }
      assert.fail(`${label}: six seconds after set_blocks the client still shows nothing at the `
        + "subject, watched from a hand-aimed camera 12 blocks south of it. The blocks never arrived.");
    }

    before(async () => {
      // The falsifier wall from the case above is still standing and sits inside this camera's cone.
      await wall(".");
      await sleep(300);
    });
    after(async () => {
      await cube(BIG, ".").catch(() => {});
    });

    let small;
    let big;

    test("a subject of KNOWN BOUNDS is framed with margin, and the frame is where the camera went", async () => {
      await cube(BIG, "a");
      await awaitVisible(BIG, "11-cube");
      big = await render({ look_at: boxOf(BIG), width: 256, height: 256 });
      assert.equal(big.settled, true, `the sections were still compiling: ${JSON.stringify(big)}`);
      assert.ok(big.distance > 0, `a framed shot reports the distance it chose: ${JSON.stringify(big)}`);
      // The camera placed ITSELF: `at` was never given, and camera_at is read off the Camera. So this
      // is the placement being measured, not an argument echoed back.
      const c = centreOf(BIG);
      const away = Math.hypot(big.camera_at.x - c.x, big.camera_at.y - c.y, big.camera_at.z - c.z);
      assert.ok(Math.abs(away - big.distance) < 0.05,
        `the camera is ${away.toFixed(2)} from the subject centre but reports ${big.distance}`);
      assertFramed(decodePng(big.path), subjectBox(decodePng(big.path)), "11-cube");
    });

    test("AND SO IS A SUBJECT FOUR TIMES SMALLER — the same size on screen", async () => {
      // The case §7 asked for and the one a single size cannot give you. Both shots are the same
      // geometry scaled, so their silhouettes must agree to within pixel quantisation; a framing rule
      // with any additive term survives every other assertion in this file and dies here.
      await cube(BIG, ".");
      await cube(3, "a");
      await awaitVisible(3, "3-cube");
      small = await render({ look_at: boxOf(3), width: 256, height: 256 });
      const pngS = decodePng(small.path);
      const boxS = subjectBox(pngS);
      const fillS = assertFramed(pngS, boxS, "3-cube");
      const pngB = decodePng(big.path);
      const fillB = assertFramed(pngB, subjectBox(pngB), "11-cube");
      assert.ok(Math.abs(fillS - fillB) / fillB < 0.1,
        `the same shape at two sizes came out ${(fillS * 100).toFixed(0)}% and ${(fillB * 100).toFixed(0)}% `
        + "of the frame — the framing is not scale-free, so it is right for one subject size and wrong for others");
      // ...and the distance it chose is the same multiple of the subject's own radius. Constant-free:
      // no number out of RenderTools is repeated here, only the claim that d is proportional to r.
      const ratio = (big.distance / radiusOf(BIG)) / (small.distance / radiusOf(3));
      assert.ok(Math.abs(ratio - 1) < 0.01,
        `distance is not proportional to the subject's radius: ${big.distance}/${radiusOf(BIG).toFixed(3)} `
        + `vs ${small.distance}/${radiusOf(3).toFixed(3)}`);
    });

    test("distance is the caller's when they give one, and further back is smaller", async () => {
      const seen = [];
      for (const d of [6, 12, 24]) {
        const r = await render({ look_at: boxOf(3), distance: d, width: 256, height: 256 });
        assert.equal(r.distance, d, `asked for distance ${d}, got ${JSON.stringify(r.distance)}`);
        const box = subjectBox(decodePng(r.path));
        assert.ok(box, `nothing in frame at distance ${d}`);
        seen.push({ d, w: box.w });
      }
      assert.ok(seen[0].w > seen[1].w && seen[1].w > seen[2].w,
        `the subject did not shrink as the camera went back: ${JSON.stringify(seen)}`);
      // Doubling the distance halves the subject, near enough — the check that says the number moved
      // the CAMERA rather than something else that happens to shrink things.
      const halving = seen[0].w / seen[1].w;
      assert.ok(halving > 1.6 && halving < 2.4,
        `6 -> 12 blocks changed the subject by ${halving.toFixed(2)}x, which is not a doubling of distance`);
    });

    test("the aspect ratio that decides the framing is the RENDER's, not the window's", async () => {
      // A tall narrow frame crops horizontally at atan(w/h) instead of 45 degrees, so the camera has
      // to stand further back for the same subject. If the framing read the window instead, this
      // number would not move at all — and the picture would be the one with the edges cut off.
      const tall = await render({ look_at: boxOf(3), width: 128, height: 256 });
      assert.ok(tall.distance > small.distance + 0.5,
        `a 128x256 frame chose ${tall.distance} and a 256x256 frame chose ${small.distance} — the `
        + "narrower frame did not stand further back, so the aspect is not reaching the framing");
      const png = decodePng(tall.path);
      assert.equal(png.width, 128);
      assertFramed(png, subjectBox(png), "3-cube in 128x256");
    });

    test("`at` with `look_at` aims a camera you placed yourself", async () => {
      const c = centreOf(3);
      const eye = { x: c.x + 6, y: c.y + 8, z: c.z + 6 };
      const r = await render({ at: eye, look_at: boxOf(3), width: 256, height: 256 });
      // Minecraft's convention, computed here from the two points and nowhere near RenderTools:
      // yaw 0 is +Z and turns toward -X, pitch is positive downward.
      const d = { x: c.x - eye.x, y: c.y - eye.y, z: c.z - eye.z };
      const len = Math.hypot(d.x, d.y, d.z);
      assert.ok(Math.abs(r.yaw - (Math.atan2(-d.x, d.z) * 180) / Math.PI) < 0.01, `yaw ${r.yaw}`);
      assert.ok(Math.abs(r.pitch - (-Math.asin(d.y / len) * 180) / Math.PI) < 0.01, `pitch ${r.pitch}`);
      assert.ok(Math.abs(r.camera_at.x - eye.x) < 0.01 && Math.abs(r.camera_at.y - eye.y) < 0.01,
        `the camera did not stay where it was put: ${JSON.stringify(r.camera_at)}`);
      const png = decodePng(r.path);
      const box = subjectBox(png);
      assert.ok(box, "the derived aim missed the subject entirely");
      assert.ok(Math.abs(box.cx - 128) < 20 && Math.abs(box.cy - 128) < 20,
        `the derived aim is off centre at ${box.cx},${box.cy}`);
    });

    test("frames:4 is an ORBIT — four vantage points, one subject, all of them framed", async () => {
      const r = await render({ look_at: boxOf(3), frames: 4, width: 192, height: 192,
        out: "mcptoolkit/renders/probe-orbit.png" });
      assert.equal(r.count, 4, JSON.stringify(r));
      assert.equal(r.frames.length, 4);
      // Numbered rather than four writes of one file — the failure would be a caller who asks for
      // four frames, gets one, and cannot tell which of the four survived.
      for (let i = 0; i < 4; i++) {
        assert.match(r.frames[i].path, new RegExp(`probe-orbit-${i}\\.png$`), r.frames[i].path);
        r.frames.slice(i + 1).forEach((f) => assert.notEqual(f.path, r.frames[i].path));
      }
      const c = centreOf(3);
      const yaws = r.frames.map((f) => f.yaw).sort((a, b) => a - b);
      assert.deepEqual(yaws.map((y) => Math.round(y)), [-135, -45, 45, 135],
        `four frames must be 90 degrees apart: ${JSON.stringify(r.frames.map((f) => f.yaw))}`);
      for (const f of r.frames) {
        // Every camera the same distance from the subject: that is what makes it an orbit rather
        // than four shots that happen to face the same way.
        const away = Math.hypot(f.camera_at.x - c.x, f.camera_at.y - c.y, f.camera_at.z - c.z);
        assert.ok(Math.abs(away - f.distance) < 0.05, `frame at yaw ${f.yaw} is ${away} out`);
        const png = decodePng(f.path);
        assertFramed(png, subjectBox(png), `orbit frame yaw ${f.yaw}`);
        written.push(f.path);
      }
      // Four DIFFERENT places, not one place four times.
      const places = new Set(r.frames.map((f) => `${f.camera_at.x},${f.camera_at.z}`));
      assert.equal(places.size, 4, `the orbit did not move: ${[...places].join(" ")}`);
    });

    test("the refusals: every argument that would be a second answer to a settled question", async () => {
      const noSubject = await refused("render", { distance: 10 });
      assert.match(noSubject, /look_at/, noSubject);
      const noCentre = await refused("render", { frames: 4 });
      assert.match(noCentre, /look_at/, noCentre);
      // `at` decides where the camera stands and `look_at` then decides only where it points, so a
      // yaw here is a third opinion about a question two arguments have already answered.
      const overDetermined = await refused("render", { at: EYE, look_at: boxOf(3), yaw: 0 });
      assert.match(overDetermined, /settled|second answer/, overDetermined);
      const tooMany = await refused("render", { look_at: boxOf(3), frames: 99 });
      assert.match(tooMany, /between 1 and 16/, tooMany);
      // One reply envelope carries one image part; an orbit asking for inline is a shape error and
      // not merely an expensive request, which is why it is refused rather than trimmed.
      const inlineOrbit = await refused("render", { look_at: boxOf(3), frames: 2, inline: true });
      assert.match(inlineOrbit, /ONE image/, inlineOrbit);
    });
  });
});
