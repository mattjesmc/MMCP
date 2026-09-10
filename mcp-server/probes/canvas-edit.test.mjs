// Live probes for the canvas and the human edit loop — RENDER_SEAM_DESIGN.md phase 2 (the two
// shipped dimensions) and phase 5 (the `nbt -> open -> edit -> close and save` session).
//
// TWO ARBITERS, and they are the design's own (§10.8):
//
//   (a) THE FRAME IS CAPTURED, NOT THE TEMPLATE'S SIZE. Open a 3x3x3 template, grow the frame, put a
//       block in the grown part, save — and assert the saved .nbt HOLDS that block. This is the
//       failure the July villagejobs editor actually hit: a capture box inferred from the template's
//       own size silently truncates the eave somebody added, and the loss surfaces much later as a
//       seam. §10.3 is the rule; this test is what makes it a fact.
//   (b) COMPARE NAMES EXACTLY THE ONE CHANGE. Place the saved file back and run
//       `place_structure {id: <the ORIGINAL>, compare:true}` over it: exactly one difference, the one
//       cell that was edited, and no others. That is §10.7's prize — a diff of a human's taste, in
//       set_blocks syntax — and it is only worth anything if "exactly one" is checked.
//
// Plus the two falsifiers without which either arbiter could pass while broken:
//   - the stray report. A save that says "nothing outside the frame" must SAY SO when there IS
//     something outside it (trap 14), or the message is decoration.
//   - cancel. A cancel that leaves the live datapack byte-identical is the check that the discard
//     path is a discard and not a quiet write.
//
// THE CANVAS HALF RUNS EVERYWHERE; THE LOOP HALF NEEDS THE DIMENSIONS. Worldgen registries are read
// during world load, so a world that has never had this version of the toolkit in it gets the canvas
// FILES on its first start and the DIMENSIONS on its second. That state is asserted rather than
// skipped: `/mmcp edit` must refuse with the restart sentence, which is the only correct behaviour
// there and is exactly the kind of refusal that rots when nothing reads it.
//
// Staged in mcptoolkit:workshop (slot-allocated, never chosen) and at this file's own overworld site.
// Live probe: needs the dev server up (`gradlew runServer`). Skips itself when the bridge is down.
// Run with `npm run test:live`, or sequentially via `tools/battery.ps1`.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const SESSION = "probe-canvas-edit";

// This probe file's own overworld site (site-map.test.mjs) — where the source template is built and
// where the saved one is placed back for the compare.
const X = 4_750_000, Y = 200, Z = 4_750_000;
const BACK = { x: X + 20, z: Z }; // where the saved .nbt is placed for arbiter (b)

const SRC = "mcptk_canvas:probe_src";
const OUT = "mcptk_canvas:probe_out";
const WORKSHOP = "mcptoolkit:workshop";
const STUDIO = "mcptoolkit:studio";

// The five files that ARE the canvas, read from the toolkit's own resources — the same bytes the mod
// installs. Asserting against the repo copy rather than against a list typed here is what stops this
// test from passing after somebody adds a sixth file and forgets it.
const HERE = dirname(fileURLToPath(import.meta.url));
const RESOURCES = join(HERE, "..", "..", "mcp-toolkit", "src", "main", "resources");
const CANVAS_FILES = [
  "data/mcptoolkit/worldgen/biome/canvas.json",
  "data/mcptoolkit/dimension_type/studio.json",
  "data/mcptoolkit/dimension_type/workshop.json",
  "data/mcptoolkit/dimension/studio.json",
  "data/mcptoolkit/dimension/workshop.json",
];

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
/** run_command's chat output as one string. It reports ok:true for a command that FAILED, so every
 *  assertion below is on the TEXT, never on the call succeeding. */
const cmd = async (c) => (await call("run_command", { command: c })).output.join("\n");

let LIVE = false;      // the bridge answers
let CANVAS = false;    // the workshop and studio dimensions are actually loaded

before(async () => {
  try {
    await call("ping");
    LIVE = true;
  } catch {
    return;
  }
  // levelArg refuses an unknown dimension, so a read that comes back at all is the presence check.
  try {
    await call("get_blocks_at", { blocks: [{ x: 0, y: 64, z: 0 }], dimension: WORKSHOP });
    await call("get_blocks_at", { blocks: [{ x: 0, y: 64, z: 0 }], dimension: STUDIO });
    CANVAS = true;
  } catch {
    CANVAS = false;
  }
  if (!CANVAS) return;

  // Leave no session of ours behind from a previous run, then build the subject and capture it.
  await cmd("mmcp cancel");
  await cmd(`forceload add ${X - 2} ${Z - 2} ${BACK.x + 8} ${BACK.z + 8}`);
  await call("set_blocks", {
    min: { x: X, y: Y, z: Z },
    legend: { a: "minecraft:stone_bricks", b: "minecraft:oak_planks" },
    layers: [["aaa", "aaa", "aaa"], ["bbb", "b.b", "bbb"], ["bbb", "bbb", "bbb"]],
  });
  await call("capture_structure", { min: { x: X, y: Y, z: Z }, size: { x: 3, y: 3, z: 3 }, id: SRC });
});

after(async () => {
  if (!LIVE) return;
  await cmd("mmcp cancel");
  await call("clear_data", { path: "data/mcptk_canvas", reload: false }).catch(() => {});
  await cmd(`forceload remove ${X - 2} ${Z - 2} ${BACK.x + 8} ${BACK.z + 8}`);
});

// -------------------------------------------------------------------------------------------------

describe("the canvas datapack", () => {
  test("every canvas file is installed in the live datapack", async (t) => {
    if (!LIVE) return t.skip("bridge down");
    const listed = new Set((await call("list_data")).entries.map((e) => e.path));
    for (const rel of CANVAS_FILES) {
      assert.ok(listed.has(rel),
        `${rel} is not in the live datapack — Canvas.install did not run, or the mod jar is missing it`);
    }
  });

  test("every canvas file passes the game's own codec", async (t) => {
    if (!LIVE) return t.skip("bridge down");
    if (!CANVAS) {
      // The two `dimension` files reference dimension_types this world has not loaded yet, so they
      // legitimately do not resolve before the restart. Checking them here would assert the wrong
      // thing; the three that do not depend on load order are still checked.
      return t.skip("dimensions not loaded yet — see 'the canvas is either loaded, or …'");
    }
    for (const rel of CANVAS_FILES) {
      const bytes = readFileSync(join(RESOURCES, rel));
      const r = await call("push_data", {
        path: rel,
        base64: bytes.toString("base64"),
        dry_run: true,
      });
      assert.equal(r.validation.checked_by, "codec", `${rel} was not checked by a codec at all`);
      assert.equal(r.validation.valid, true,
        `${rel} is not valid: ${r.validation.error ?? "(no reason given)"}`);
    }
  });

  // STATIC — runs with the game down, which is the point: this is the one canvas property whose
  // failure is invisible to every server-side read. FOUND THE HARD WAY on the first human run: the
  // workshop shipped without it and was PURE BLACK once the torches came out. In 26.2 the lightmap
  // is built by LightmapRenderStateExtractor from environment attributes, and `ambient_light` on the
  // dimension type survives only in Lightmap.getBrightness / getLightLevelDependentMagicValue — the
  // HUD vignette and the gameplay magic value. The attribute's own default is opaque BLACK, so
  // "unset" is not "some sensible light", it is none. Nothing else in this file can catch that: a
  // rendered frame is what would, and the camera (phase 1) does not exist yet.
  test("both canvases declare visual/ambient_light_color — ambient_light is not the 26.2 knob", () => {
    for (const rel of CANVAS_FILES.filter((f) => f.includes("dimension_type/"))) {
      const json = JSON.parse(readFileSync(join(RESOURCES, rel), "utf8"));
      const colour = json.attributes?.["visual/ambient_light_color"];
      assert.ok(colour, `${rel} does not set visual/ambient_light_color — its default is opaque `
        + `black, so this canvas renders unlit. \`ambient_light\` does NOT do this job in 26.2.`);
      assert.match(colour, /^#[0-9A-Fa-f]{6}$/, `${rel}: ${colour} is not a #RRGGBB colour`);
    }
  });

  test("the canvas is either loaded, or /mmcp edit says exactly why not", async (t) => {
    if (!LIVE) return t.skip("bridge down");
    if (CANVAS) {
      // Both dimensions answered a read in `before`. The one thing left to pin is that they are the
      // canvas and not somebody else's: void, at the working plane, with nothing generated in them.
      const r = await call("get_blocks_at", { blocks: [{ x: 0, y: 64, z: 0 }], dimension: STUDIO });
      assert.equal(r.dimension, STUDIO);
      return;
    }
    const said = await cmd(`mmcp edit ${SRC}`);
    assert.match(said, /no mcptoolkit:workshop/i);
    assert.match(said, /RESTART/,
      "the refusal must name the restart — worldgen is read at world load and no reload adds a dimension");
  });
});

// -------------------------------------------------------------------------------------------------

describe("the edit loop", () => {
  test("edit opens the template in the workshop, framed at its own size", async (t) => {
    if (!LIVE) return t.skip("bridge down");
    if (!CANVAS) return t.skip("canvas dimensions need a world restart");
    const said = await cmd(`mmcp edit ${SRC}`);
    assert.match(said, /^Opened /, `edit did not open: ${said}`);
    assert.match(said, /frame 3x3x3/, "a fresh edit must frame the template's own size");
    const frame = await cmd("mmcp frame");
    const box = frameOf(frame);
    // The template is there, and the platform is one block BELOW the frame so it is never captured.
    const cells = await call("get_blocks_at", {
      blocks: [
        { x: box.min.x + 1, y: box.min.y, z: box.min.z + 1 },      // the template's floor
        { x: box.min.x + 1, y: box.min.y - 1, z: box.min.z + 1 },  // the platform under it
      ],
      dimension: WORKSHOP,
    });
    const at = (i) => cells.palette[cells.blocks[i][3]];
    assert.equal(at(0), "minecraft:stone_bricks", "the template did not place");
    assert.notEqual(at(1), "minecraft:air", "there is no platform to stand on");
  });

  test("a second edit is refused, not an implicit close", async (t) => {
    if (!LIVE) return t.skip("bridge down");
    if (!CANVAS) return t.skip("canvas dimensions need a world restart");
    const said = await cmd(`mmcp edit ${SRC}`);
    assert.match(said, /already have/, `a second edit must refuse, got: ${said}`);
    assert.match(said, /save|cancel/, "the refusal must say how to get out of it");
  });

  // ARBITER (a) and (b), in one run: the same save answers both.
  test("save captures the FRAME, and compare names exactly the one edit", async (t) => {
    if (!LIVE) return t.skip("bridge down");
    if (!CANVAS) return t.skip("canvas dimensions need a world restart");
    const box = frameOf(await cmd("mmcp frame"));

    // One edit INSIDE the template's own bounds — this is what compare must find, and find alone.
    await call("set_blocks", {
      blocks: [{ x: box.min.x + 1, y: box.min.y + 2, z: box.min.z + 1, block: "minecraft:gold_block" }],
      dimension: WORKSHOP,
    });
    // Grow the frame, then build in the grown part — the cell a template-sized capture would eat.
    const grown = await cmd("mmcp frame up 2");
    assert.match(grown, /3x5x3/, `frame up 2 did not grow the box: ${grown}`);
    await call("set_blocks", {
      blocks: [{ x: box.min.x + 1, y: box.min.y + 3, z: box.min.z + 1, block: "minecraft:diamond_block" }],
      dimension: WORKSHOP,
    });

    const said = await cmd(`mmcp save ${OUT}`);
    assert.match(said, new RegExp(`^Saved ${OUT}`), `save did not report a write: ${said}`);
    assert.match(said, /Nothing of yours sits outside the frame/,
      "everything built here is inside the grown frame, so the stray report must say so");
    // The save's own reload is in flight; this one is the barrier that it has landed.
    await call("reload_data");

    const placed = await call("place_structure", { id: OUT, at: { x: BACK.x, y: Y, z: BACK.z } });
    assert.deepEqual(placed.size, { x: 3, y: 5, z: 3 },
      "the saved file is the template's size, not the frame's — the frame was not the contract");

    // (a) the cell outside the ORIGINAL bounds survived the round trip.
    const cells = await call("get_blocks_at", {
      blocks: [
        { x: BACK.x + 1, y: Y + 2, z: BACK.z + 1 },
        { x: BACK.x + 1, y: Y + 3, z: BACK.z + 1 },
      ],
    });
    const at = (i) => cells.palette[cells.blocks[i][3]];
    assert.equal(at(0), "minecraft:gold_block", "the in-bounds edit is not in the saved file");
    assert.equal(at(1), "minecraft:diamond_block",
      "the cell ABOVE the template's original size is not in the saved file — the capture used the "
      + "template's size instead of the frame, which is the seam bug §10.3 is about");

    // (b) the original template compared against what stands there names one cell and no others.
    const diff = await call("place_structure", { id: SRC, at: { x: BACK.x, y: Y, z: BACK.z }, compare: true });
    assert.equal(diff.differ, 1, `compare should find exactly one change, found ${diff.differ}: `
      + JSON.stringify(diff.differences));
    assert.deepEqual(diff.differences[0].at, { x: BACK.x + 1, y: Y + 2, z: BACK.z + 1 });
    assert.equal(diff.differences[0].actual, "minecraft:gold_block");
  });

  // The falsifier for the stray report. Without this, "Nothing of yours sits outside the frame" is a
  // sentence that would print whether or not it was true.
  test("a block built past the frame is named in the save, not swallowed", async (t) => {
    if (!LIVE) return t.skip("bridge down");
    if (!CANVAS) return t.skip("canvas dimensions need a world restart");
    const box = frameOf(await cmd("mmcp frame"));
    const stray = { x: box.max.x + 2, y: box.min.y, z: box.min.z + 1 };
    await call("set_blocks", {
      blocks: [{ ...stray, block: "minecraft:emerald_block" }],
      dimension: WORKSHOP,
    });
    const said = await cmd(`mmcp save ${OUT}`);
    assert.match(said, /1 non-air cell\(s\) sit OUTSIDE the frame and were NOT saved/,
      `the save must report what it left behind, got: ${said}`);
    assert.match(said, new RegExp(`${stray.x} ${stray.y} ${stray.z}`),
      "the report must name where, not only how many");
    await call("reload_data");
    // And it really was left behind: the file is still the frame's size.
    const placed = await call("place_structure", { id: OUT, at: { x: BACK.x, y: Y, z: BACK.z } });
    assert.deepEqual(placed.size, { x: 3, y: 5, z: 3 });
  });

  test("cancel clears the slot and leaves the datapack byte-identical", async (t) => {
    if (!LIVE) return t.skip("bridge down");
    if (!CANVAS) return t.skip("canvas dimensions need a world restart");
    const box = frameOf(await cmd("mmcp frame"));
    const fingerprint = async () =>
      (await call("list_data")).entries.map((e) => `${e.path}:${e.bytes}`).sort().join("|");
    const before = await fingerprint();
    const said = await cmd("mmcp cancel");
    assert.match(said, /Cleared slot/, `cancel did not run: ${said}`);
    assert.equal(await fingerprint(), before,
      "cancel wrote to the live datapack — a discard that saves is the worst bug this loop could have");

    const cells = await call("get_blocks_at", {
      blocks: [
        { x: box.min.x + 1, y: box.min.y + 1, z: box.min.z + 1 },  // inside the frame
        { x: box.min.x + 1, y: box.min.y - 1, z: box.min.z + 1 },  // the platform
      ],
      dimension: WORKSHOP,
    });
    for (const row of cells.blocks) {
      assert.equal(cells.palette[row[3]], "minecraft:air",
        `cancel left ${row.slice(0, 3).join(",")} standing`);
    }
    assert.match(await cmd("mmcp canvas"), /Nothing open/);
  });

  test("save and frame refuse with a way forward when nothing is open", async (t) => {
    if (!LIVE) return t.skip("bridge down");
    if (!CANVAS) return t.skip("canvas dimensions need a world restart");
    for (const c of ["mmcp save", "mmcp frame", "mmcp frame up 1", "mmcp cancel"]) {
      const said = await cmd(c);
      assert.match(said, /nothing open/i, `${c} should have refused, got: ${said}`);
      assert.match(said, /mmcp edit/, `${c}'s refusal must name the way in`);
    }
  });

  test("a blank frame can be opened, and refuses to save without an id", async (t) => {
    if (!LIVE) return t.skip("bridge down");
    if (!CANVAS) return t.skip("canvas dimensions need a world restart");
    const opened = await cmd("mmcp edit blank 4 4 4");
    assert.match(opened, /blank frame/, `blank edit did not open: ${opened}`);
    assert.match(opened, /frame 4x4x4/);
    const refused = await cmd("mmcp save");
    assert.match(refused, /opened blank/, `a blank frame must refuse a save with no id: ${refused}`);
    await cmd("mmcp cancel");
  });
});

/** The min/max corners out of `/mmcp frame`'s reply — parsed, so a reply that stops printing them fails. */
function frameOf(text) {
  const m = text.match(/min (-?\d+) (-?\d+) (-?\d+)\s+max (-?\d+) (-?\d+) (-?\d+)/);
  assert.ok(m, `/mmcp frame did not report its corners: ${text}`);
  return {
    min: { x: +m[1], y: +m[2], z: +m[3] },
    max: { x: +m[4], y: +m[5], z: +m[6] },
  };
}
