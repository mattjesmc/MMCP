// Live probes for the two authoring seams added in toolkit 0.89.0 — the answer to rocketeer's
// TOOLKIT_AUTHORING_ASK.md, built as ONE new tool and one new argument shape rather than two tools
// (TOKEN_PER_TOOL_FINDINGS.md finding 6: the cheapest new capability is one that needs no new entry).
//
//   1. `set_blocks` grid form — `min` + `legend` + `layers`, dense text where the TOOL does every
//      index. The claim it rests on is that the measured grid hazard (PATTERN_SEARCH_DESIGN.md: the
//      same wrong cell from describe_box layers character-arithmetic in three independent sessions)
//      is an EXTRACTION failure, and this direction has no extraction step. That claim is only worth
//      anything if the tool's own arithmetic is right, which is what these tests are.
//   2. `capture_structure` — a world box becomes a vanilla structure .nbt inside the live datapack.
//      The arbiter is not "a file appeared": it is `/place template` putting the same blocks back.
//      A multi-palette template writes "palettes" and no "palette", and a single-palette reader then
//      resolves every block to AIR — a completely blank structure that passes every size check. So
//      the test places the capture and reads the blocks, which is the only check that trap fails.
//
// The load-bearing assertion of the whole file is THE FIXPOINT: describe_box detail:"layers" handed
// straight back to set_blocks changes nothing and fails nothing. That is one test for four separate
// contracts — the legend speaks set_blocks syntax, block STATES survive the round trip (a wall of
// stairs is not four identical glyphs), the row labels are a checksum rather than noise, and
// re-stating a cell that is already correct is `unchanged` and not an error. Before this version the
// last of those was reported as a failed write, so editing three characters of a 150-cell room came
// back as 147 errors.
//
// Staged at a probe-owned coordinate (4.40M). Forceloaded during the run, released after.
// Live probe: needs the dev server up (`gradlew runServer`). Skips itself when the bridge is down.
// Run with `npm run test:live`, or sequentially via `tools/battery.ps1`.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const X = 4_400_000, Z = 4_400_000, Y = 200; // this probe file's own site (site-map.test.mjs)
// Never-generated space, for the one refusal that cannot be staged inside a loaded site: a capture
// whose columns cannot be read would record AIR for them, and air is indistinguishable in the file
// from a room with an open wall.
const UNGEN = 20_000_000;

const SESSION = "probe-authoring";
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

/** True when every listed {x,y,z,expect} matches. */
async function blocksAre(blocks) {
  const r = await call("get_blocks_at", { blocks });
  return r.check.all_matched;
}

// Sub-sites, one per test, so a failure localises and no test cleans up under another.
const GRID = { x: X, z: Z };
const KEEP = { x: X + 20, z: Z };
const REFUSE = { x: X + 40, z: Z };
const CAPTURE = { x: X + 60, z: Z };
const PLACED = { x: X + 60, z: Z + 20 }; // where the captured structure is put back
// The wiped box. FOUND 2026-08-26 while building place-structure.test.mjs, which copied this line
// and inherited the bug: the old box was 88x14x33 = 40,656 blocks, and /fill CAPS AT 32,768 and
// refuses past it — while run_command reports ok:true for a command that failed. So the wipe in
// `before` and `after` had never run, and this file passed only because every test fully overwrites
// its own site. Sized to the sites it actually has, and CHECKED below rather than trusted.
const WIPE = `${X - 2} ${Y - 1} ${Z - 2} ${X + 66} ${Y + 4} ${Z + 26}`; // 69 * 6 * 29 = 12,006

// The subject: a 5x3x5 chamber whose interior carries ONE oriented block. The stair is the point —
// an id-keyed legend drew it as the same character as any other purpur block, so a round trip
// through the read view silently straightened every stair in the room.
const LEGEND = {
  "#": "minecraft:deepslate_bricks",
  "<": "minecraft:purpur_stairs[facing=west,half=bottom]",
};
const FLOOR = ["#####", "#####", "#####", "#####", "#####"];
const WALLS = ["#####", "#...#", "#..<#", "#...#", "#####"];
const CHAMBER = [FLOOR, WALLS, FLOOR];
const CELLS = 75;      // 5 * 3 * 5
const SOLID = 67;      // 66 '#' + 1 '<'
const HOLLOW = 8;      // '.' cells, which land on the air that is already there

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok)
  .catch(() => false);
if (!bridgeUp) {
  console.log(`\n  [skip] no bridge at ${BASE} — start the dev server to run these probes\n`);
}

describe("authoring: a grid the tool indexes, and a world box that becomes a structure file",
  { skip: !bridgeUp }, () => {
  before(async () => {
    if (!bridgeUp) return;
    await cmd(`forceload add ${X - 16} ${Z - 16} ${X + 80} ${Z + 40}`);
    await sleep(1500); // forceload marks async
    await cmd(`fill ${WIPE} minecraft:air`);
    await sleep(500);
    const clean = await call("get_blocks_at", {
      blocks: [GRID, KEEP, REFUSE, CAPTURE, PLACED].map((p) => ({
        x: p.x, y: Y, z: p.z, expect: "minecraft:air",
      })),
    });
    assert.equal(clean.check.all_matched, true,
      `the site wipe did not take (see WIPE): ${JSON.stringify(clean.check)}`);
  });

  after(async () => {
    if (!bridgeUp) return;
    await cmd(`fill ${WIPE} minecraft:air`);
    await cmd(`forceload remove ${X - 16} ${Z - 16} ${X + 80} ${Z + 40}`);
    await call("clear_data", { path: "data/mcptk/structure/probe/chamber.nbt" }).catch(() => {});
  });

  // --- 1. the grid: what it read, what it wrote, and where -------------------------------------

  test("layers build the chamber, and the reply says what geometry it READ", async (t) => {
    if (!bridgeUp) return t.skip();
    const { x, z } = GRID;
    const r = await call("set_blocks", {
      min: { x, y: Y, z }, legend: LEGEND, layers: CHAMBER,
    });
    // The caller stated this size implicitly, in whitespace. The echo is the whole mitigation.
    assert.deepEqual(r.parsed.size, { x: 5, y: 3, z: 5 }, JSON.stringify(r.parsed));
    assert.equal(r.parsed.cells, CELLS, JSON.stringify(r.parsed));
    assert.deepEqual(r.per_symbol, { "#": 66, ".": 8, "<": 1 }, JSON.stringify(r.per_symbol));
    assert.equal(r.placed, SOLID, JSON.stringify(r));
    // The '.' cells asked for air over air: unchanged, NOT failed.
    assert.equal(r.unchanged, HOLLOW, JSON.stringify(r));
    assert.equal(r.failed, 0, JSON.stringify(r));

    // And the world agrees about every axis, INCLUDING the one character that carries a state.
    // layers[0] is the bottom course, rows[0] is z=min.z, character i is x=min.x+i.
    assert.ok(await blocksAre([
      { x, y: Y, z, expect: "minecraft:deepslate_bricks" },                       // floor corner
      { x: x + 1, y: Y + 1, z: z + 1, expect: "minecraft:air" },                  // hollow
      { x: x + 3, y: Y + 1, z: z + 2, expect: "minecraft:purpur_stairs[facing=west]" },
      { x: x + 4, y: Y + 2, z: z + 4, expect: "minecraft:deepslate_bricks" },     // far top corner
    ]), "the grid must land at min + (character index, layer index, row index)");
    // Nothing outside the frame.
    assert.ok(await blocksAre([{ x: x + 5, y: Y, z, expect: "minecraft:air" }]),
      "a 5-wide row must not write a sixth column");
    assert.ok(r.undo_id, JSON.stringify(r));
  });

  test("THE FIXPOINT: describe_box layers handed straight back changes nothing and fails nothing",
    async (t) => {
    if (!bridgeUp) return t.skip();
    const { x, z } = GRID;
    const seen = await call("describe_box", {
      min: { x, y: Y, z }, max: { x: x + 4, y: Y + 2, z: z + 4 }, detail: "layers",
    });
    // The legend is per STATE and in set_blocks syntax, so the stair survives being drawn.
    const values = Object.values(seen.legend);
    assert.ok(values.includes("minecraft:deepslate_bricks"), JSON.stringify(seen.legend));
    assert.ok(values.includes("minecraft:purpur_stairs[facing=west]"),
      `the layers legend must carry the STATE, not just the block id: ${JSON.stringify(seen.legend)}`);

    // Verbatim: the y-keyed object, the "z=N|" row labels and the "x: A..B" ruler all as returned.
    const back = await call("set_blocks", {
      min: { x, y: Y, z }, legend: seen.legend, layers: seen.layers,
    });
    assert.deepEqual(back.parsed.size, { x: 5, y: 3, z: 5 }, JSON.stringify(back.parsed));
    assert.equal(back.placed, 0, `a read written straight back must change nothing: ${JSON.stringify(back)}`);
    assert.equal(back.failed, 0, `re-stating a correct cell is not an error: ${JSON.stringify(back)}`);
    assert.equal(back.unchanged, CELLS, JSON.stringify(back));
    // Nothing changed, so there is nothing to undo — and the edit journal must not claim otherwise.
    assert.equal(back.undo_id, null, JSON.stringify(back));
  });

  test("the labels are a CHECKSUM: the same rows at the wrong min refuse", async (t) => {
    if (!bridgeUp) return t.skip();
    const { x, z } = GRID;
    const seen = await call("describe_box", {
      min: { x, y: Y, z }, max: { x: x + 4, y: Y + 2, z: z + 4 }, detail: "layers",
    });
    const shiftedZ = await refused("set_blocks",
      { min: { x, y: Y, z: z + 1 }, legend: seen.legend, layers: seen.layers });
    assert.match(shiftedZ, /labelled z=/, `the refusal must name the disagreement: ${shiftedZ}`);
    const shiftedX = await refused("set_blocks",
      { min: { x: x + 1, y: Y, z }, legend: seen.legend, layers: seen.layers });
    assert.match(shiftedX, /ruler/, `the x ruler must be checked too: ${shiftedX}`);
    const shiftedY = await refused("set_blocks",
      { min: { x, y: Y + 1, z }, legend: seen.legend, layers: seen.layers });
    assert.match(shiftedY, /lowest key/, `y-keyed layers must agree with min.y: ${shiftedY}`);
    // The chamber test 1 built still stands: none of the three refusals wrote anything.
    assert.ok(await blocksAre([{ x, y: Y, z, expect: "minecraft:deepslate_bricks" }]),
      "a refused grid must not have written");
    await cmd(`fill ${x} ${Y} ${z} ${x + 4} ${Y + 2} ${z + 4} minecraft:air`);
  });

  // --- 2. keep: the symbol that makes the form composable with what is already there ------------

  test("a `keep` cell is not written, not counted placed, and left exactly as it was", async (t) => {
    if (!bridgeUp) return t.skip();
    const { x, z } = KEEP;
    await call("set_blocks", { blocks: [
      { x: x + 1, y: Y, z: z + 1, block: "minecraft:gold_block" },
      { x: x + 2, y: Y, z: z + 1, block: "minecraft:gold_block" },
    ] });
    const r = await call("set_blocks", {
      min: { x, y: Y, z },
      legend: { "#": "minecraft:stone", "-": "keep" },
      layers: [["###", "#--", "###"]],
    });
    assert.equal(r.parsed.cells, 9, JSON.stringify(r.parsed));
    assert.equal(r.kept, 2, JSON.stringify(r));
    assert.deepEqual(r.per_symbol, { "#": 7, "-": 2 }, JSON.stringify(r.per_symbol));
    assert.equal(r.placed, 7, JSON.stringify(r));
    assert.ok(await blocksAre([
      { x: x + 1, y: Y, z: z + 1, expect: "minecraft:gold_block" },
      { x: x + 2, y: Y, z: z + 1, expect: "minecraft:gold_block" },
      { x, y: Y, z, expect: "minecraft:stone" },
    ]), "keep must leave the gold and stone must land everywhere else");
    await call("undo_edit", { undo_id: r.undo_id });
    // The undo restores the seven stone cells; the two gold cells were never in the record at all.
    assert.ok(await blocksAre([{ x: x + 1, y: Y, z: z + 1, expect: "minecraft:gold_block" }]),
      "undoing a grid must not touch a kept cell");
  });

  // --- 3. refusals: whole-call, having written nothing ------------------------------------------

  test("ragged rows, unknown characters and two encodings all refuse before writing", async (t) => {
    if (!bridgeUp) return t.skip();
    const { x, z } = REFUSE;
    const marker = { x, y: Y, z, block: "minecraft:gold_block" };
    await call("set_blocks", { blocks: [marker] });

    const ragged = await refused("set_blocks", {
      min: { x, y: Y, z }, legend: { "#": "minecraft:stone" },
      layers: [["###", "##", "###"]],
    });
    assert.match(ragged, /ragged|characters, expected/, `name the row that is wrong: ${ragged}`);

    const unknown = await refused("set_blocks", {
      min: { x, y: Y, z }, legend: { "#": "minecraft:stone" },
      layers: [["###", "#Q#", "###"]],
    });
    assert.match(unknown, /legend entry for 'Q'/, `name the character: ${unknown}`);

    const both = await refused("set_blocks", {
      blocks: [marker], min: { x, y: Y, z }, legend: { "#": "minecraft:stone" }, layers: [["#"]],
    });
    assert.match(both, /EITHER/, `two encodings is a contradiction, not a merge: ${both}`);

    const neither = await refused("set_blocks", {});
    assert.match(neither, /blocks|layers/, neither);

    const typo = await refused("set_blocks", {
      min: { x, y: Y, z }, legend: { "#": "minecraft:stone", "%": "minecraft:not_a_block" },
      layers: [["###", "#%#", "###"]],
    });
    // Not eight per-entry errors and one bad cell: a legend that does not parse refuses the CALL.
    assert.match(typo, /legend '%'/, `a bad legend value must name the symbol: ${typo}`);

    const gap = await refused("set_blocks", {
      min: { x, y: Y, z }, legend: { "#": "minecraft:stone" },
      layers: { [String(Y)]: ["#"], [String(Y + 2)]: ["#"] },
    });
    assert.match(gap, /skips y=/, `a hole in the keys is not a hole in the box: ${gap}`);

    // Every one of the five wrote nothing: the marker is untouched and its neighbours are still air.
    assert.ok(await blocksAre([
      { x, y: Y, z, expect: "minecraft:gold_block" },
      { x: x + 1, y: Y, z, expect: "minecraft:air" },
      { x: x + 2, y: Y, z, expect: "minecraft:air" },
    ]), "a refused grid must leave the site exactly as it was");
    await cmd(`setblock ${x} ${Y} ${z} minecraft:air`);
  });

  test("a dry-run grid reports the same counts it would write, and writes nothing", async (t) => {
    if (!bridgeUp) return t.skip();
    const { x, z } = REFUSE;
    const args = { min: { x: x + 8, y: Y, z }, legend: LEGEND, layers: CHAMBER };
    const dry = await call("set_blocks", { ...args, dry_run: true });
    assert.equal(dry.placed, SOLID, JSON.stringify(dry));
    assert.equal(dry.unchanged, HOLLOW, JSON.stringify(dry));
    assert.equal(dry.undo_id, null, JSON.stringify(dry));
    assert.ok(await blocksAre([{ x: x + 8, y: Y, z, expect: "minecraft:air" }]),
      "a dry run must not write");
    const live = await call("set_blocks", args);
    assert.equal(live.placed, dry.placed, `preview and reality must agree: ${dry.placed} vs ${live.placed}`);
    assert.equal(live.unchanged, dry.unchanged, JSON.stringify(live));
    await call("undo_edit", { undo_id: live.undo_id });
  });

  // --- 4. capture_structure ---------------------------------------------------------------------

  test("a world box becomes a structure file, and /place puts the same blocks back", async (t) => {
    if (!bridgeUp) return t.skip();
    const { x, z } = CAPTURE;
    await call("set_blocks", { min: { x, y: Y, z }, legend: LEGEND, layers: CHAMBER });
    // A block entity, so the census has something to count that a bare palette would drop.
    await call("set_blocks", { blocks: [{
      x: x + 1, y: Y + 1, z: z + 3,
      block: 'minecraft:chest[facing=north]{Items:[{Slot:0b,id:"minecraft:diamond",count:5}]}',
    }] });

    const cap = await call("capture_structure", {
      min: { x, y: Y, z }, size: { x: 5, y: 3, z: 5 }, id: "mcptk:probe/chamber",
    });
    assert.equal(cap.path, "data/mcptk/structure/probe/chamber.nbt", JSON.stringify(cap));
    assert.ok(cap.bytes > 0, JSON.stringify(cap));
    assert.deepEqual(cap.size, { x: 5, y: 3, z: 5 }, JSON.stringify(cap));
    // THE TRAP, reported rather than assumed: >1 palette writes "palettes" and no "palette", and a
    // single-palette reader then bakes a blank structure that passes every size check.
    assert.equal(cap.palettes, 1, JSON.stringify(cap));
    assert.ok(cap.palette_size >= 3, JSON.stringify(cap));
    assert.equal(cap.blocks, SOLID + 1, JSON.stringify(cap)); // the chamber plus the chest
    assert.equal(cap.air, HOLLOW - 1, JSON.stringify(cap));   // the chest took one hollow cell
    assert.equal(cap.block_entities, 1, JSON.stringify(cap));
    assert.equal(cap.entities, 0, JSON.stringify(cap));
    assert.equal(cap.reloaded, true, JSON.stringify(cap));
    assert.ok(!cap.base64 && !cap.nbt, `the bytes must never ride in the reply: ${JSON.stringify(cap)}`);

    const listed = await call("list_data");
    assert.ok(listed.entries.some((e) => e.path === cap.path),
      `the capture must be in the live pack: ${JSON.stringify(listed.entries)}`);

    // The arbiter. run_command reports ok on a command the game refused, so the verdict is the
    // WORLD: place the capture somewhere else and read what landed.
    await cmd(`place template mcptk:probe/chamber ${PLACED.x} ${Y} ${PLACED.z}`);
    await sleep(300);
    assert.ok(await blocksAre([
      { x: PLACED.x, y: Y, z: PLACED.z, expect: "minecraft:deepslate_bricks" },
      { x: PLACED.x + 3, y: Y + 1, z: PLACED.z + 2, expect: "minecraft:purpur_stairs[facing=west]" },
      { x: PLACED.x + 1, y: Y + 1, z: PLACED.z + 1, expect: "minecraft:air" },
      { x: PLACED.x + 1, y: Y + 1, z: PLACED.z + 3, expect: "minecraft:chest[facing=north]" },
    ]), "the placed capture must be the same room, stair facing and all — not a blank box");

    await call("clear_data", { path: cap.path });
    const gone = await call("list_data");
    assert.ok(!gone.entries.some((e) => e.path === cap.path), "clear_data must remove it again");
  });

  test("a capture whose columns cannot be read refuses instead of recording air", async (t) => {
    if (!bridgeUp) return t.skip();
    const err = await refused("capture_structure", {
      min: { x: UNGEN, y: 64, z: UNGEN }, size: { x: 4, y: 4, z: 4 }, id: "mcptk:probe/unread",
    });
    assert.match(err, /could not be read|AIR/, `the refusal must say what it would have lied about: ${err}`);
    const listed = await call("list_data");
    assert.ok(!listed.entries.some((e) => e.path.includes("probe/unread")),
      "a refused capture must not leave a file");
  });

  test("capture_structure refuses a frame it was not given", async (t) => {
    if (!bridgeUp) return t.skip();
    const { x, z } = CAPTURE;
    const noSize = await refused("capture_structure",
      { min: { x, y: Y, z }, id: "mcptk:probe/nope" });
    assert.match(noSize, /size/, noSize);
    const zero = await refused("capture_structure",
      { min: { x, y: Y, z }, size: { x: 0, y: 3, z: 5 }, id: "mcptk:probe/nope" });
    assert.match(zero, /at least 1/, zero);
    const huge = await refused("capture_structure",
      { min: { x, y: Y, z }, size: { x: 200, y: 200, z: 200 }, id: "mcptk:probe/nope" });
    assert.match(huge, /cap/, huge);
  });
});
