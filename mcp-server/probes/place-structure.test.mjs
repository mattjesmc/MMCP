// Live probes for `place_structure` (RELEASE_1.md §D3) — the write half of `capture_structure`.
//
// WHY IT HAD TO EXIST is sharper than "the capability was missing". `GoalRunner`'s refusal of
// `bot_target action:"build"` told the caller to use `place_structure` instead, and no such tool
// existed anywhere in the repo. A refusal that points at a phantom tool costs the reader exactly the
// call it saved them, so the first test here is that the name in that message resolves.
//
// THE COMPARISON IS `run_command "/place template …"`, and it is not a close one:
//
//   * that route reports ok:true for a command that FAILED (a recorded trap of run_command), so it
//     cannot tell you the template was not found — the single most likely thing to go wrong;
//   * it has no undo, so a misplaced building is cleaned up by hand;
//   * it has no dry run, so "will this land where I think" costs a real placement to answer.
//
// THE LOAD-BEARING ASSERTION IS DRY == LIVE. `place_shapes` learned it the expensive way (see the
// place-shapes batch notes): a preview nobody compares against the live run drifts silently, and the
// remedy is never to assert the preview against a constant. So the dry run's `cells`, `occupied`,
// `size` and `region` are captured and then required to equal the live run's, field for field. What
// the dry run does NOT report is `changed` — the template's own cell list is behind a private field,
// so the count is taken by diffing the footprint after the write, and a number this tool cannot
// compute without writing is not a number it may guess. That absence is asserted too.
//
// THE SECOND IS THE UNDO ROUND TRIP: capture a chamber, wipe it, place it back, undo, and require
// the site to be air again — with the chest's ITEMS surviving the place, which is what makes this a
// structure placement rather than a block fill.
//
// Staged at a probe-owned coordinate (4.60M), forceloaded during the run and released after; the
// never-generated square at 4.65M is for the one refusal that cannot be staged inside a loaded site.
// It also writes ONE structure file into the live datapack and clears it in `after`.
//
// Live probe: needs the dev server up (`gradlew runServer`). Skips itself when the bridge is down.
// Run with `npm run test:live`, or sequentially via `tools/battery.ps1`.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const X = 4_600_000, Z = 4_600_000, Y = 200; // this probe file's own site (site-map.test.mjs)
const UNGEN = 4_650_000;                     // never generated, same file, for the unloaded refusal

const SESSION = "probe-place-structure";
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
  assert.equal(j.ok, false, `${tool} should have been refused, got ${JSON.stringify(j.result)}`);
  return JSON.stringify(j.error);
}
const cmd = (c) => call("run_command", { command: c });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TEMPLATE = "mcptk:probe/place_probe";
const TEMPLATE_FILE = "data/mcptk/structure/probe/place_probe.nbt";

// Sub-sites, one per concern, so a failure localises and no test cleans up under another — and,
// just as important, so no test inherits a site another test left built: a placement onto its own
// output is `changed: 0`, which is correct behaviour and useless as a subject.
const SRC = { x: X, z: Z };              // where the chamber is built and captured from
const DST = { x: X + 10, z: Z };         // where it is placed back
const UNDO = { x: X + 20, z: Z };        // the undo round trip
const AGAIN = { x: X + 30, z: Z };       // placed twice, to exercise the `unchanged` bucket
const ROT = { x: X + 40, z: Z };         // the rotated placement
const DRY = { x: X + 50, z: Z };         // dry-run only: nothing may ever be written here
// The wiped box, kept DELIBERATELY SMALL. /fill caps at 32,768 blocks and refuses past it — and
// run_command reports ok:true for a command that failed, so an oversized wipe here is a silent
// no-op that hands every test below a site full of the last run's building. That is exactly how
// this file failed on its first run (88x14x33 = 40,656), and it is the same trap `place_structure`
// exists to close, met in the probe's own setup.
const WIPE = `${X - 2} ${Y - 1} ${Z - 2} ${X + 56} ${Y + 4} ${Z + 6}`; // 59 * 6 * 9 = 3,186

// The subject: a 3x2x4 box carrying an ORIENTED block and a BLOCK ENTITY WITH CONTENTS. Both are
// what separate a structure placement from a block fill — a stair that comes back straightened or a
// chest that comes back empty is a template that "placed" and lost half of itself.
const LEGEND = {
  "#": "minecraft:deepslate_bricks",
  "<": "minecraft:purpur_stairs[facing=west,half=bottom]",
  "C": 'minecraft:chest[facing=north]{Items:[{Slot:0b,id:"minecraft:diamond",count:5}]}',
};
const LAYERS = [
  ["###", "###", "###", "###"],
  ["#<#", "#C#", "#.#", "###"],
];
const SIZE = { x: 3, y: 2, z: 4 };
const CELLS = 24; // 3 * 2 * 4

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok)
  .catch(() => false);
if (!bridgeUp) {
  console.log(`\n  [skip] no bridge at ${BASE} — start the dev server to run these probes\n`);
}

describe("place_structure: a template goes back into the world, and says what it did",
  { skip: !bridgeUp }, () => {
  before(async () => {
    if (!bridgeUp) return;
    await cmd(`forceload add ${X - 16} ${Z - 16} ${X + 64} ${Z + 16}`);
    await sleep(1500); // forceload marks async
    await cmd(`fill ${WIPE} minecraft:air`);
    await sleep(500);

    // The wipe is CHECKED, not trusted. See WIPE above: a /fill over the cap fails and reports
    // success, and every assertion in this file would then be about last run's leftovers.
    const clean = await call("get_blocks_at", {
      blocks: [SRC, DST, UNDO, AGAIN, ROT, DRY].map((p) => ({
        x: p.x, y: Y, z: p.z, expect: "minecraft:air",
      })),
    });
    assert.equal(clean.check.all_matched, true,
      `the site wipe did not take — /fill caps at 32,768 blocks and reports success anyway: `
      + JSON.stringify(clean.check));

    // Build the chamber and capture it. Everything below is about putting THIS file back.
    await call("set_blocks", { min: { x: SRC.x, y: Y, z: SRC.z }, legend: LEGEND, layers: LAYERS });
    const cap = await call("capture_structure", {
      min: { x: SRC.x, y: Y, z: SRC.z }, size: SIZE, id: TEMPLATE,
    });
    assert.equal(cap.palettes, 1, `a multi-palette template resolves to air: ${JSON.stringify(cap)}`);
    assert.equal(cap.block_entities, 1, `the chest must be in the capture: ${JSON.stringify(cap)}`);
  });

  after(async () => {
    if (!bridgeUp) return;
    await cmd(`fill ${WIPE} minecraft:air`);
    await cmd(`forceload remove ${X - 16} ${Z - 16} ${X + 64} ${Z + 16}`);
    await raw("clear_data", { path: TEMPLATE_FILE });
  });

  // --- the phantom -----------------------------------------------------------------------------

  test("the tool GoalRunner's refusal names actually exists", async () => {
    // The whole reason §D3 was not optional. `bot_target action:"build"` told callers to use
    // `place_structure`, and until 0.92.0 there was nothing on the other end of that sentence.
    const r = await fetch(`${BASE}/tools`).then((x) => x.json());
    const tools = r.tools ?? r;
    assert.ok(tools.some((t) => t.name === "place_structure"),
      "place_structure is named in a user-facing error and must be in the manifest");
  });

  test("a template that is not loaded is a REFUSAL that names it", async () => {
    // The single most likely thing to go wrong, and the thing `/place template` through run_command
    // cannot report — it answers ok:true either way.
    const err = await refused("place_structure",
      { id: "mcptk:no/such/template", at: { x: DST.x, y: Y, z: DST.z } });
    assert.match(err, /no loaded structure template/, err);
    assert.match(err, /query_registry/, `the refusal must say how to find what IS loaded: ${err}`);
  });

  // --- dry run vs live -------------------------------------------------------------------------

  test("DRY == LIVE: the preview is the live run's first half, not a second implementation", async () => {
    const at = { x: DST.x, y: Y, z: DST.z };
    const dry = await call("place_structure", { id: TEMPLATE, at, dry_run: true });
    assert.equal(dry.dry_run, true);
    assert.equal(dry.undo_id, null, "a dry run has nothing to undo");
    assert.equal(dry.cells, CELLS, JSON.stringify(dry));
    assert.deepEqual(dry.size, SIZE, JSON.stringify(dry.size));
    // The site was wiped in `before`, so nothing stands where this would build.
    assert.equal(dry.occupied, 0, JSON.stringify(dry));
    assert.equal(dry.changed, undefined,
      "a dry run must not report a `changed` it can only get by writing");

    // ...and the dry run really changed nothing.
    const still = await call("get_blocks_at", {
      blocks: [{ x: at.x, y: at.y, z: at.z, expect: "minecraft:air" }],
    });
    assert.equal(still.check.all_matched, true, "a dry run must not touch the world");

    const live = await call("place_structure", { id: TEMPLATE, at });
    assert.equal(live.dry_run, false);
    for (const field of ["cells", "occupied"]) {
      assert.equal(live[field], dry[field],
        `${field}: dry said ${dry[field]}, live said ${live[field]} — a preview that drifts is worse `
        + "than no preview");
    }
    assert.deepEqual(live.size, dry.size);
    assert.deepEqual(live.region, dry.region, "the footprint must not depend on whether it was real");
    // 24 footprint cells, of which the one '.' cell asks for air over air.
    assert.equal(live.changed, CELLS - 1, JSON.stringify(live));
    assert.equal(live.unchanged, 1, JSON.stringify(live));
    assert.equal(live.block_entities, 1, `the chest must be standing: ${JSON.stringify(live)}`);
    assert.equal(live.entities_placed, 0, "this template holds no entities");
    assert.ok(live.undo_id, "a live placement must be undoable");
  });

  test("what landed is the template, oriented block and chest CONTENTS included", async () => {
    // A structure placement that loses the stair's facing or the chest's items has "placed" and
    // dropped half of itself; a block fill would do exactly that.
    const r = await call("get_blocks_at", {
      blocks: [
        { x: DST.x, y: Y, z: DST.z, expect: "minecraft:deepslate_bricks" },
        { x: DST.x + 1, y: Y + 1, z: DST.z, expect: "minecraft:purpur_stairs[facing=west,half=bottom]" },
        {
          x: DST.x + 1, y: Y + 1, z: DST.z + 1,
          expect: 'minecraft:chest[facing=north]{Items:[{Slot:0b,id:"minecraft:diamond",count:5}]}',
        },
        { x: DST.x + 1, y: Y + 1, z: DST.z + 2, expect: "minecraft:air" },
      ],
    });
    assert.equal(r.check.all_matched, true,
      `the placement lost something: ${JSON.stringify(r.check.mismatches ?? r.check)}`);
  });

  test("undo_edit reverts the whole placement — which /place cannot do at all", async () => {
    const at = { x: UNDO.x, y: Y, z: UNDO.z };
    // Its own site: a placement onto an identical building changes nothing, which would make this
    // test pass while proving nothing.
    const live = await call("place_structure", { id: TEMPLATE, at });
    assert.equal(live.changed, CELLS - 1, `nothing to undo: ${JSON.stringify(live)}`);
    const undone = await call("undo_edit", { undo_id: live.undo_id });
    assert.ok(undone, JSON.stringify(undone));
    const r = await call("get_blocks_at", {
      blocks: [
        { x: at.x, y: Y, z: at.z, expect: "minecraft:air" },
        { x: at.x + 1, y: Y + 1, z: at.z + 1, expect: "minecraft:air" },
      ],
    });
    assert.equal(r.check.all_matched, true,
      `undo left the placement standing: ${JSON.stringify(r.check.mismatches ?? r.check)}`);
  });

  test("re-placing onto itself is `unchanged`, not a failure", async () => {
    // The bucket set_blocks and place_shape both have. Nudging a piece means re-placing it, and
    // before those tools had this bucket a correct re-write read back as a wall of errors.
    const at = { x: AGAIN.x, y: Y, z: AGAIN.z };
    const first = await call("place_structure", { id: TEMPLATE, at });
    const again = await call("place_structure", { id: TEMPLATE, at });
    assert.equal(again.changed, 0, `nothing differed the second time: ${JSON.stringify(again)}`);
    assert.equal(again.unchanged, CELLS, JSON.stringify(again));
    // Nothing changed, so there is nothing to undo and the id is null rather than a phantom entry.
    assert.equal(again.undo_id, null, JSON.stringify(again));
    assert.equal(again.occupied, CELLS - 1,
      `the second run sees what the first built: ${JSON.stringify(again)}`);
    await raw("undo_edit", { undo_id: first.undo_id });
  });

  // --- rotation --------------------------------------------------------------------------------

  test("rotation swaps the footprint's x and z, and is echoed back", async () => {
    const at = { x: ROT.x, y: Y, z: ROT.z };
    const r = await call("place_structure", { id: TEMPLATE, at, rotation: "clockwise_90" });
    assert.equal(r.rotation, "clockwise_90");
    assert.equal(r.mirror, "none");
    // 3x2x4 turned a quarter turn is 4x2x3. A tool that echoed the argument without applying it
    // would pass every other assertion in this file.
    assert.deepEqual(r.size, { x: SIZE.z, y: SIZE.y, z: SIZE.x }, JSON.stringify(r.size));
    assert.equal(r.region.size.x, SIZE.z, JSON.stringify(r.region));
    assert.equal(r.region.size.z, SIZE.x, JSON.stringify(r.region));
    assert.equal(r.cells, CELLS, "a rotation moves cells, it does not lose them");
    await raw("undo_edit", { undo_id: r.undo_id });
  });

  test("`90` and `clockwise_90` are the same rotation, and a bad one is refused by name", async () => {
    const at = { x: ROT.x, y: Y, z: ROT.z };
    const a = await call("place_structure", { id: TEMPLATE, at, rotation: "90", dry_run: true });
    const b = await call("place_structure", { id: TEMPLATE, at, rotation: "clockwise_90", dry_run: true });
    assert.deepEqual(a.region, b.region);
    assert.equal(a.rotation, "clockwise_90", "the reply names the canonical rotation, not the alias");
    const err = await refused("place_structure", { id: TEMPLATE, at, rotation: "sideways" });
    assert.match(err, /unknown `rotation`/, err);
  });

  // --- the refusals ----------------------------------------------------------------------------

  test("an unloaded destination refuses rather than placing half a building", async () => {
    // Never-generated space: reads never generate terrain, so the footprint cannot be paged in and
    // the honest answer is nothing-was-placed. The failure this replaces is a structure whose far
    // half is missing and whose reply said it was placed.
    const err = await refused("place_structure",
      { id: TEMPLATE, at: { x: UNGEN, y: Y, z: UNGEN } });
    assert.match(err, /could not be read/, err);
    assert.match(err, /nothing was placed/, err);
  });

  test("an argument the tool does not have is refused, from the schema", async () => {
    // ArgCheck's gate, confirmed on the new entry rather than assumed: a `pos` that silently did
    // nothing would place the structure at a default and read back as agreement.
    const err = await refused("place_structure",
      { id: TEMPLATE, pos: { x: DST.x, y: Y, z: DST.z } });
    assert.match(err, /pos/, err);
  });

  test("a missing `at` is refused, not defaulted to the origin", async () => {
    const err = await refused("place_structure", { id: TEMPLATE });
    assert.match(err, /at/, err);
  });

  // --- the site that must stay empty -------------------------------------------------------------

  test("nothing was ever written at the dry-run-only site", async () => {
    // The check that makes every dry_run above mean something: if any of them had written, this is
    // where it would show, because no test in this file places here on purpose.
    const dry = await call("place_structure", {
      id: TEMPLATE, at: { x: DRY.x, y: Y, z: DRY.z }, dry_run: true,
    });
    assert.equal(dry.occupied, 0, "the dry-run site must still be empty for this to mean anything");
    const r = await call("get_blocks_at", {
      blocks: [
        { x: DRY.x, y: Y, z: DRY.z, expect: "minecraft:air" },
        { x: DRY.x + 1, y: Y + 1, z: DRY.z + 1, expect: "minecraft:air" },
      ],
    });
    assert.equal(r.check.all_matched, true, JSON.stringify(r.check.mismatches ?? r.check));
  });
});
