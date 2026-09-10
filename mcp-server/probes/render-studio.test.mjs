// The studio — RENDER_SEAM_DESIGN.md §6's `op:"canvas"`, the last unbuilt line of that design,
// shipped as the `studio` tool (see StudioTools on why it is its own entry and not an op on
// `render`: the camera is `mechanism:observe` and sits in the read-only `inspect` profile, and
// staging writes blocks and moves a player).
//
// The claim under test, in one sentence: A SUBJECT THAT STANDS IN NO WORLD CAN BE PHOTOGRAPHED
// AGAINST NOTHING, AND THE CLIENT COMES HOME AFTERWARDS. Four arbiters, and the last two are the
// ones that keep the first two honest:
//
//   (a) THE BACKGROUND IS THE STUDIO'S, WHICH IS THE WHOLE POINT. The staged shot's border ring is
//       the `visual/fog_color` studio.json DECLARES — read out of the shipped file, never typed here
//       (the place-shapes lesson) — while the subject sits framed in the middle of it.
//   (b) ITS FALSIFIER: THE SAME SUBJECT, PHOTOGRAPHED WHERE IT STOOD. Uniform-background is a
//       property a broken frame has for free (a render that never ran, a stale one, a widened
//       tolerance). So the same box is shot in the overworld first, and its ring must NOT be the
//       studio's colour. One picture without the other proves nothing.
//   (c) THE TEMPLATE EXISTS IN NO WORLD. The source blocks are DELETED between the capture and the
//       stage, so the thing photographed cannot be the thing that was standing there — the studio
//       had to build it. This is what separates "the camera found something" from "the stage worked".
//   (d) THE CLIENT COMES HOME. `studio` teleports a real player into a flat white void; a probe that
//       once left the player in the studio cost a whole battery run, because every later read
//       defaults to the dimension the player is standing in. So: the player is asserted to BE in the
//       studio while staged (or the trip never happened) and asserted back at their own coordinates
//       after `leave` — including the case that breaks a naive implementation, staging TWICE without
//       leaving in between, where a re-remembered home would record the studio as somewhere to
//       return to and the restore would run, report success, and put nobody anywhere.
//
// AND THE WAIT IS ASSERTED BY OMISSION. There is no sleep between `studio` and the `render` that
// follows it — deliberately. §13.3 measured a written subject taking 700-900ms to reach the client,
// during which the same camera returns `settled:true` over an empty white frame. If the stage did
// not wait for this client's OWN copy of the blocks, arbiter (a) photographs an empty studio and
// fails. That is the only assertion this file has about the wait, and it is the real one.
//
// SITE: 9,300,000 in the overworld (site-map.test.mjs) at y=200, high above the terrain so the
// subject stands in open air; the studio half is at whatever slot the stage allocates, which is the
// point of allocating it. Like canvas-edit.test.mjs, this file MOVES THE HUMAN'S PLAYER — run it
// sequentially (tools/battery.ps1), not concurrently with the other files that do.
//
// Live probe: needs the dev game up WITH A CLIENT (`gradlew runClient`) — the camera is the render
// loop — plus the canvas dimensions, which a world that has never had this toolkit in it only gets
// on its SECOND start. Run with `npm run test:live`, or sequentially via `tools/battery.ps1`.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { readFileSync, unlinkSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const SESSION = "probe-render-studio";

const STUDIO = "mcptoolkit:studio";
const PIECE = "mcptk_studio:probe_piece";

// This file's own overworld site, well above the ground so the subject stands in open air and the
// capture reads five clean layers rather than a hillside.
const X = 9_300_000, Y = 200, Z = 9_300_000;
const N = 5; // the subject is an N-cube, so its census is N^3 and its box is min..min+N-1
const BOX = { min: { x: X, y: Y, z: Z }, max: { x: X + N - 1, y: Y + N - 1, z: Z + N - 1 } };
const MARK = { x: X, y: Y + N - 1, z: Z }; // the one white cell, so a copy that fills is caught

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
  assert.equal(j.ok, false,
    `${tool} ${JSON.stringify(args)} should have been refused: ${JSON.stringify(j.result)}`);
  return JSON.stringify(j.error);
}
const cmd = async (c) => (await call("run_command", { command: c })).output.join("\n");

// ---- a PNG decoder, because the arbiter for a picture is its pixels -------------------------
// The same forty lines render-camera.test.mjs carries, and for the same reason: the alternative is
// asking the tool that wrote the file what is in it, which is the tool grading its own homework.

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

const dist = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));

/** The colour the DIMENSION FILE declares, parsed from the shipped bytes. Never a constant here. */
function declaredFog() {
  const json = JSON.parse(
    readFileSync(join(RESOURCES, "data/mcptoolkit/dimension_type/studio.json"), "utf8"));
  const hex = json.attributes["visual/fog_color"];
  assert.match(hex, /^#[0-9a-fA-F]{6}$/, `studio.json's visual/fog_color is not a hex colour: ${hex}`);
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

/**
 * How much of the frame's BORDER is the given colour. The border rather than the corners: a subject
 * is in the middle by construction here, so the ring is background wherever the shot was taken, and
 * a fraction says "this is a studio shot" or "this is not" without depending on which pixel.
 */
function ringFraction(png, colour) {
  let seen = 0, hit = 0;
  const edge = 2;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const onRing = x < edge || y < edge || x >= png.width - edge || y >= png.height - edge;
      if (!onRing) continue;
      seen++;
      if (dist(png.at(x, y), colour) <= 6) hit++;
    }
  }
  return hit / seen;
}

/** The subject's bounding box in pixels: everything that is not the background colour. */
function subjectBox(png, background) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, pixels = 0;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      if (dist(png.at(x, y), background) > 40) {
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

// ---- liveness ---------------------------------------------------------------

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok)
  .catch(() => false);
let clientPresent = false;
let canvas = false;
if (bridgeUp) {
  clientPresent = (await raw("ping", {})).result?.clientPresent === true;
  if (clientPresent) {
    canvas = (await raw("get_blocks_at", { blocks: [{ x: 0, y: 64, z: 0 }], dimension: STUDIO })).ok;
  }
}
if (!bridgeUp) {
  console.log(`\n  [skip] no bridge at ${BASE} — start the dev game to run these probes\n`);
} else if (!clientPresent) {
  console.log("\n  [skip] bridge is up but headless — the studio moves a CLIENT and the camera IS the render loop\n");
} else if (!canvas) {
  console.log("\n  [skip] the studio dimension is not in this world — it arrives on the NEXT world start\n");
}

const written = [];
async function render(args) {
  const r = await call("render", args);
  written.push(r.path);
  return r;
}

/** The N-cube, as one call. `.` is air, which is how it comes down again. */
const cube = (symbol) => call("set_blocks", {
  min: BOX.min,
  legend: { a: "minecraft:black_concrete", w: "minecraft:white_concrete" },
  // Layers run bottom-up; the top layer carries the one white cell, so a "copy" that fills the box
  // with a single block is caught by a block read rather than by a pixel.
  layers: Array.from({ length: N }, (_, y) =>
    Array.from({ length: N }, (_, z) =>
      Array.from({ length: N }, (_, x) =>
        symbol === "." ? "." : (y === N - 1 && z === 0 && x === 0 ? "w" : "a")).join(""))),
  dimension: "minecraft:overworld",
});

describe("a subject that stands in no world, photographed against nothing", { skip: !canvas }, () => {
  const fog = declaredFog();
  let home = null;
  let name = null;

  /** Where the player is, out of the server's own mouth — the only reading that settles (d). */
  async function whereIsThePlayer() {
    const pos = (await cmd(`data get entity ${name} Pos`)).match(/\[([-\d.d]+), ([-\d.d]+), ([-\d.d]+)\]/);
    const dim = (await cmd(`data get entity ${name} Dimension`)).match(/"([^"]+)"/);
    assert.ok(pos && dim, "could not read the player's position back out of the server");
    return { dimension: dim[1], x: parseFloat(pos[1]), y: parseFloat(pos[2]), z: parseFloat(pos[3]) };
  }

  before(async () => {
    const who = (await cmd("list")).match(/online:\s*(.+)$/m);
    assert.ok(who, "could not read a player name out of /list — is anybody actually connected?");
    name = who[1].split(",")[0].trim();
    home = await whereIsThePlayer();
    // The subject has to be in chunks this client has been sent, both to be captured and to be
    // photographed where it stands. So the player goes to the site — and comes back in after().
    await cmd(`execute in minecraft:overworld run tp ${name} ${X - 12} ${Y + 6} ${Z - 12} 135 30`);
    await new Promise((r) => setTimeout(r, 1500)); // chunks over the wire at 9.3M from spawn
    await cube("a");
  });

  after(async () => {
    // Best effort, in the order that matters: put the studio back, then the world, then the human.
    await call("studio", { leave: true }).catch(() => {});
    await cube(".").catch(() => {});
    if (home) {
      await cmd(`execute in ${home.dimension} run tp ${name} ${home.x} ${home.y} ${home.z}`)
        .catch(() => {});
    }
    for (const p of written) {
      try {
        unlinkSync(p);
      } catch {
        /* the probe's own litter; a file that is already gone is fine */
      }
    }
  });

  test("FALSIFIER: photographed where it stands, the background is the world", async () => {
    // THE WAIT, BY HAND — and it is worth reading beside the staged case below, which has none.
    // The cube was written by `set_blocks` a moment ago and the client is 900ms behind the server
    // (§13.3, measured); the camera cannot see that and answers `settled:true` over the terrain
    // that is still there. So this shot polls until the subject actually arrives, and FAILS if it
    // never does. The staged shot needs none of this because the stage does it — which is most of
    // the reason `studio` is a tool at all. The first live run of this file failed exactly here,
    // with a centre pixel of 179,163,159: the ground, photographed through a cube that had not
    // landed yet.
    let r = null;
    for (let i = 0; i < 20; i++) {
      r = await render({ look_at: BOX, pitch: 60, width: 256, height: 256 });
      const px = decodePng(r.path).at(128, 128);
      if (px[0] + px[1] + px[2] < 200) break;
      r = null;
      await new Promise((s) => setTimeout(s, 300));
    }
    assert.ok(r, "six seconds after set_blocks the client still shows terrain where the subject is: "
      + "the blocks never arrived, and nothing below can be compared against this");
    assert.equal(r.dimension, "minecraft:overworld", JSON.stringify(r));
    const png = decodePng(r.path);
    const ring = ringFraction(png, fog);
    assert.ok(ring < 0.5,
      `the overworld frame's border is ${(ring * 100).toFixed(0)}% the studio's own background `
      + `colour (${fog.join()}), so the studio case below would prove nothing`);
    // ...and it IS the subject in the middle of it: black concrete under daylight is far darker
    // than any sky, grass or stone that could be behind it, so one centre pixel settles it. (The
    // loop above already required this; asserted again here so the case reads as what it claims.)
    const centre = png.at(png.width / 2, png.height / 2);
    assert.ok(centre[0] + centre[1] + centre[2] < 200,
      `the centre of the in-place frame is ${centre.join()}, which is not the black cube it was `
      + "framed on — nothing was photographed, and the studio case would be comparing two empties");
  });

  test("a template that stands in NO world is staged, and the camera finds it", async () => {
    await call("capture_structure", {
      min: BOX.min, size: { x: N, y: N, z: N }, id: PIECE,
      dimension: "minecraft:overworld", reload: true,
    });
    // (c): the source is DELETED. From here the only copy of this shape in the game is an .nbt, so a
    // picture of it is a picture of something the studio built.
    await cube(".");
    const gone = await call("get_blocks_at", { blocks: [BOX.min], dimension: "minecraft:overworld" });
    assert.equal(gone.palette[gone.blocks[0][3]], "minecraft:air", "the source blocks are still there");

    const staged = await call("studio", { id: PIECE });
    assert.equal(staged.dimension, STUDIO, JSON.stringify(staged));
    assert.equal(staged.blocks, N * N * N, `the census disagrees with the subject: ${JSON.stringify(staged)}`);
    assert.deepEqual(
      { x: staged.look_at.max.x - staged.look_at.min.x, y: staged.look_at.max.y - staged.look_at.min.y,
        z: staged.look_at.max.z - staged.look_at.min.z },
      { x: N - 1, y: N - 1, z: N - 1 },
      `the staged box is not the subject's size: ${JSON.stringify(staged.look_at)}`);

    // NO SLEEP. See the header: this is the whole assertion about the wait.
    const shot = await render({ look_at: staged.look_at, width: 256, height: 256 });
    assert.equal(shot.dimension, STUDIO, `photographed the wrong level: ${JSON.stringify(shot)}`);
    const png = decodePng(shot.path);
    const ring = ringFraction(png, fog);
    if (!(ring > 0.98)) {
      // KEEP THE EVIDENCE. This assertion went red once at 0.119.0 and once at 0.125.0 (border 0%
      // white, dimension reported as the studio, green on the very next run), and both times the
      // frame had been unlinked by after() before anyone could look at it. A failing frame is
      // renamed out of the litter list and named here, so the third time has a picture.
      const kept = shot.path.replace(/\.png$/, "-FAILED-ring.png");
      try { renameSync(shot.path, kept); written.splice(written.indexOf(shot.path), 1); } catch { /* keep going */ }
      const centre = png.at(png.width / 2, png.height / 2);
      const corner = png.at(1, 1);
      assert.fail(`the staged frame's border is only ${(ring * 100).toFixed(0)}% the ${fog.join()} that `
        + "studio.json declares — the subject was not photographed against the studio "
        + `(corner ${corner.slice(0, 3).join()}, centre ${centre.slice(0, 3).join()}, settled=${shot.settled}; frame kept at ${kept})`);
    }
    const box = subjectBox(png, fog);
    if (!box) {
      // Same evidence rule as the border: an EMPTY studio frame (all fog, no subject) is the other
      // face of the same intermittent red (rerun6 at 0.125.0 saw this one with the border green).
      const kept = shot.path.replace(/\.png$/, "-FAILED-empty.png");
      try { renameSync(shot.path, kept); written.splice(written.indexOf(shot.path), 1); } catch { /* keep going */ }
      assert.fail("the staged frame is empty: the subject never reached this client, or never stood "
        + `(settled=${shot.settled}, waited_ms=${staged.waited_ms}, frame kept at ${kept}; staged=${JSON.stringify(staged)})`);
    }
    assert.ok(box.x0 >= 3 && box.y0 >= 3 && box.x1 <= png.width - 4 && box.y1 <= png.height - 4,
      `the staged subject is cut off by the frame: ${JSON.stringify(box)}`);
    const fill = Math.max(box.w / png.width, box.h / png.height);
    assert.ok(fill > 0.4 && fill < 0.95,
      `the staged subject fills ${fill.toFixed(2)} of the frame — in it, but not FRAMED by it`);
  });

  test("the client really went: it is standing in the studio while the subject is", async () => {
    const at = await whereIsThePlayer();
    assert.equal(at.dimension, STUDIO,
      `the client is in ${at.dimension}, so the frame above was taken somewhere nobody moved to`);
  });

  test("staging AGAIN does not lose the way home", async () => {
    // The failure this exists for: a second stage that re-reads the player's position records the
    // STUDIO as home, and the restore then runs, reports success, and returns nobody anywhere.
    const again = await call("studio", { id: PIECE });
    assert.equal(again.dimension, STUDIO);
    assert.match(again.next, /leave/, `the reply must say how to get out: ${JSON.stringify(again)}`);
    assert.match(again.next, new RegExp(home.dimension.replace(/[.:]/g, "\\$&")),
      `the way out must name where it will put the client back, not the studio: ${again.next}`);
  });

  test("leave sweeps the subject and brings the client home", async () => {
    const staged = await call("studio", { id: PIECE });
    const left = await call("studio", { leave: true });
    assert.equal(left.cleared, true, JSON.stringify(left));
    assert.equal(left.returned.dimension, home.dimension, JSON.stringify(left));

    const at = await whereIsThePlayer();
    assert.equal(at.dimension, home.dimension, "the client was not brought home");
    // Where it was put down at the site, within a block — the fall it takes between the teleport and
    // the read is the only thing allowed to move it.
    assert.ok(Math.abs(at.x - (X - 12)) < 1.5 && Math.abs(at.z - (Z - 12)) < 1.5,
      `the client came back to ${at.x},${at.z}, not the site it left from`);

    const cells = await call("get_blocks_at", {
      blocks: [staged.look_at.min, staged.look_at.max, { x: staged.client_at.x, y: staged.client_at.y - 1, z: staged.client_at.z }],
      dimension: STUDIO,
    });
    for (const row of cells.blocks) {
      assert.equal(cells.palette[row[3]], "minecraft:air",
        `leave left ${row.slice(0, 3).join(",")} standing in the studio — including the pad it lays `
        + "for whoever it moves");
    }
    assert.equal((await call("studio", { leave: true })).cleared, false,
      "a second leave claims to have swept something that was already gone");
  });

  test("a live box is COPIED into the studio — the original stays where it is", async () => {
    await cube("a");
    await new Promise((r) => setTimeout(r, 400));
    const staged = await call("studio", { look_at: BOX });
    assert.equal(staged.blocks, N * N * N, JSON.stringify(staged));
    assert.match(staged.from, /minecraft:overworld/, `the reply must say where the copy came from: ${staged.from}`);

    // The copy is faithful: the marked cell is white in the copy, at the same offset. A stage that
    // filled the box with one block passes every pixel assertion in this file and dies here.
    const offset = { x: MARK.x - BOX.min.x, y: MARK.y - BOX.min.y, z: MARK.z - BOX.min.z };
    const copied = await call("get_blocks_at", {
      blocks: [
        { x: staged.look_at.min.x + offset.x, y: staged.look_at.min.y + offset.y, z: staged.look_at.min.z + offset.z },
        staged.look_at.min,
      ],
      dimension: STUDIO,
    });
    assert.equal(copied.palette[copied.blocks[0][3]], "minecraft:white_concrete",
      "the marked cell did not survive the copy — the stage is not a copy of the subject");
    assert.equal(copied.palette[copied.blocks[1][3]], "minecraft:black_concrete");

    // ...and the original is untouched. "Copied, not moved" is a claim the description makes.
    const source = await call("get_blocks_at", { blocks: [MARK, BOX.min], dimension: "minecraft:overworld" });
    assert.equal(source.palette[source.blocks[0][3]], "minecraft:white_concrete",
      "staging a live box moved it instead of copying it");
    await call("studio", { leave: true });
  });

  test("the refusals: a subject that is one subject, and a leave that is only a leave", async () => {
    const none = await refused("studio", {});
    assert.match(none, /id|look_at/, none);
    const both = await refused("studio", { id: PIECE, look_at: BOX });
    assert.match(both, /ONE subject|two different subjects/, both);
    const leaveAndStage = await refused("studio", { id: PIECE, leave: true });
    assert.match(leaveAndStage, /Leave first|thrown away/, leaveAndStage);
    const unknown = await refused("studio", { id: "mcptk_studio:no_such_piece" });
    assert.match(unknown, /no loaded structure template/, unknown);
    // And the camera did not quietly grow a staging argument: `render` refuses `id` outright, which
    // is the arg-check chokepoint doing the work rather than a check written twice.
    const notTheCamera = await refused("render", { id: PIECE });
    assert.match(notTheCamera, /id/, notTheCamera);
  });
});
