// Screen authoring, slice 5 (mcp-toolkit/docs/screens/SCREEN_AUTHORING_DESIGN.md section 10): `ui_doc`, the
// FOURTH EDITOR, live.
//
// What slice 5 promised, each as a case that can go red:
//   * read names the document's SOURCE file (not the pack copy in build/, which is the trap slice 4
//     found from the other side) and hands back an addressable path for every element;
//   * lint reports what parses fine and is still wrong, and DECLARES what it could not check -
//     the shipped example is clean AND has an unchecked count with a reason;
//   * lint answers about a document that does not parse instead of refusing to speak;
//   * a refused edit writes NOTHING: the file is byte-identical after a refusal;
//   * an insert declares what it references, a value is read leniently, a layout child moves by
//     writing the offset override, and a delete renumbers its siblings;
//   * generate DERIVES its arguments from where the document sits and from the same
//     gradle.properties key `gradlew generateUi` reads - proved on a temp project the game has
//     never heard of, and then as drift after one pixel changes;
//   * generate check on the toolkit's own example finds no drift, which is checkUi's staleness
//     guarantee answered with no build;
//   * preview opens the document in the client, and edit:true arms the in-game editor;
//   * a mutation is REFUSED while that editor holds the same file with unsaved edits, and goes
//     through again once it has saved.
//
// SUBJECTS: the toolkit's own assets/mcptoolkit/ui/example.ui.json is READ ONLY here - it is the
// conformance battery's reference document and slice 3 compares it pixel for pixel, so nothing in
// this file edits it. Every mutation runs against a COPY in a temp directory laid out like a mod's
// checkout, which is also what lets `generate` be exercised end to end without writing into any
// repository.
//
// Live probe: needs the dev game up. Most cases need no client at all (that is the point of the
// tool); the preview and editor cases skip themselves without one.
// Run with `npm run test:live`, or sequentially via `tools/battery.ps1`.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const SESSION = "probe-ui-tool";
const DOC = "mcptoolkit:example";

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

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok)
  .catch(() => false);
let clientPresent = false;
let inWorld = false;
if (bridgeUp) {
  const ping = (await raw("ping", {})).result;
  clientPresent = ping?.clientPresent === true;
  if (clientPresent) inWorld = (await raw("get_world_info", {})).ok === true;
}
if (!bridgeUp) {
  console.log(`\n  [skip] no bridge at ${BASE} - start the dev game to run these probes\n`);
}

// ---------------------------------------------------------------------------------------------
// A temp checkout: the shape UiProject derives everything from.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcptk-uitool-"));
const MOD = "probeui";
const PKG = "com.example.probeui";
const uiDir = path.join(tmp, "src", "main", "resources", "assets", MOD, "ui");
const COPY = path.join(uiDir, "thing.ui.json");

function readCopy() {
  return JSON.parse(fs.readFileSync(COPY, "utf8"));
}
/** Every element's path, from a read - the index is the addressing surface. */
function paths(readResult) {
  return readResult.elements.map((line) => line.split(" ")[0]);
}
function pathOf(readResult, id) {
  const row = readResult.elements.find((line) => line.endsWith(`'${id}'`));
  assert.ok(row, `'${id}' is in the index: ${readResult.elements.join(" | ")}`);
  return row.split(" ")[0];
}

describe("screen authoring slice 5: ui_doc", { skip: !bridgeUp }, () => {
  before(async () => {
    fs.mkdirSync(uiDir, { recursive: true });
    fs.mkdirSync(path.join(tmp, "src", "main", "java"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "build.gradle"), "// a probe's project\n");
    fs.writeFileSync(path.join(tmp, "gradle.properties"), `mcmod.ui.package=${PKG}\n`);
    // The subject, taken THROUGH the tool rather than off disk, so the copy is what the toolkit
    // itself just parsed and canonicalised.
    const read = await call("ui_doc", { op: "read", ui: DOC });
    fs.writeFileSync(COPY, JSON.stringify(read.json, null, 2));
  });

  after(async () => {
    if (clientPresent) await raw("close_screen", {});
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // ---- read ---------------------------------------------------------------

  test("read names the SOURCE file, not the pack copy the game is reading", async () => {
    const r = await call("ui_doc", { op: "read", ui: DOC });
    const file = r.file.split("\\").join("/");
    assert.match(file, /src\/main\/resources\/assets\/mcptoolkit\/ui\/example\.ui\.json$/,
      `read must resolve to the truth, not to a build output: ${r.file}`);
    assert.ok(!/\/build\//.test(file), `the source tree is the truth: ${r.file}`);
    // ...and the pack copy is named too, because that is the one the running game has.
    assert.ok(r.mirror, "the loaded pack's copy is reported so a caller knows the game is behind");
    assert.match(r.mirror.split("\\").join("/"), /\/build\//);
  });

  test("read hands back an addressable path for every element, layout children included", async () => {
    const r = await call("ui_doc", { op: "read", ui: DOC });
    const all = paths(r);
    assert.ok(all.includes("elements[0]"), all.join(" "));
    const nested = all.filter((p) => p.includes(".children["));
    assert.ok(nested.length >= 10, `layout children are addressable too: ${all.join(" ")}`);
    // The index is what `path` takes, and an id is the other way in.
    assert.equal(pathOf(r, "launch").includes(".children["), true);
    assert.equal(r.screen.width, 256);
    assert.ok(Array.isArray(r.kinds) && r.kinds.includes("slot_grid"));
  });

  // ---- lint ---------------------------------------------------------------

  test("the shipped example lints clean - and says what it could NOT look at", async () => {
    const r = await call("ui_doc", { op: "lint", ui: DOC });
    assert.equal(r.parses, true);
    assert.deepEqual(r.notes, [], `the conformance battery's own subject must lint clean: ${JSON.stringify(r.notes)}`);
    // A clean verdict over nothing would be worthless. The example is mostly layout nodes, whose
    // children have no position until a client arranges them, and the answer for those is named.
    assert.ok(r.unchecked > 0, "the example has layout children");
    assert.match(r.unchecked_why, /check_layout/);
  });

  test("lint names a real problem, at the parser's own path", async () => {
    // Push a slot off the right edge of the panel. It parses - a document may put an element
    // anywhere - and it is a screen with a slot the player cannot see.
    const before = await call("ui_doc", { op: "read", ui_file: COPY });
    const p = pathOf(before, "fuel_slot");
    await call("ui_doc", { op: "move", ui_file: COPY, path: p, x: 250, y: 36 });
    const r = await call("ui_doc", { op: "lint", ui_file: COPY });
    const note = r.notes.find((n) => n.code === "outside_panel");
    assert.ok(note, `outside_panel should fire: ${JSON.stringify(r.notes)}`);
    assert.equal(note.at, p, "a note is at the path the caller addressed");
    assert.match(note.problem, /256x222/);
    assert.ok(r.codes.includes("unreachable_slots"), "the code vocabulary is declared");
    await call("ui_doc", { op: "move", ui_file: COPY, path: p, x: 14, y: 36 });
    assert.deepEqual((await call("ui_doc", { op: "lint", ui_file: COPY })).notes, []);
  });

  test("lint answers about a document that does not parse, instead of refusing to speak", async () => {
    const broken = path.join(tmp, "broken.ui.json");
    fs.writeFileSync(broken, '{"format":1,"title":"t","width":176,"height":166,"elements":['
      + '{"kind":"bar","id":"b","x":8,"y":8,"w":60,"h":8,"binding":"nope"}]}');
    const r = await call("ui_doc", { op: "lint", ui_file: broken });
    assert.equal(r.parses, false);
    assert.ok(r.problems.some((p) => p.includes("undeclared binding")),
      `the parse problems are the answer: ${JSON.stringify(r.problems)}`);
    // ...and every other op DOES refuse it, because they would be acting on it.
    assert.match(await refused("ui_doc", { op: "read", ui_file: broken }), /undeclared binding/);
  });

  // ---- mutations ----------------------------------------------------------

  test("a refused edit writes NOTHING", async () => {
    const bytesBefore = fs.readFileSync(COPY);
    const read = await call("ui_doc", { op: "read", ui_file: COPY });
    const err = await refused("ui_doc", {
      op: "set", ui_file: COPY, path: pathOf(read, "progress_bar"), key: "binding", value: "nope",
    });
    assert.match(err, /undeclared binding/, err);
    assert.match(err, /NOT written/, err);
    assert.deepEqual(fs.readFileSync(COPY), bytesBefore, "the file must be byte-identical after a refusal");
  });

  test("an insert declares what it references", async () => {
    const before = readCopy();
    const r = await call("ui_doc", { op: "add", ui_file: COPY, kind: "button", x: 8, y: 8 });
    assert.ok(r.added, "the reply says where it landed");
    assert.equal(r.element.kind, "button");
    const after = readCopy();
    assert.equal(after.actions.length, before.actions.length + 1,
      "a button with no action would not parse, so the insert declared one");
    assert.ok(after.actions.includes(r.element.action));
    // ...and the document still parses, which is the only claim that matters: it was WRITTEN.
    assert.equal((await call("ui_doc", { op: "lint", ui_file: COPY })).parses, true);
    await call("ui_doc", { op: "remove", ui_file: COPY, path: r.added });
    await call("ui_doc", { op: "set", ui_file: COPY, key: "actions", value: JSON.stringify(before.actions) });
    assert.deepEqual(readCopy().actions, before.actions);
  });

  test("a value is read leniently, and the reply shows what was actually written", async () => {
    const read = await call("ui_doc", { op: "read", ui_file: COPY });
    const p = pathOf(read, "progress_bar");
    const r = await call("ui_doc", { op: "set", ui_file: COPY, path: p, key: "w", value: "64" });
    assert.equal(r.element.w, 64, "the string \"64\" became the NUMBER 64");
    assert.equal(typeof r.element.w, "number");
    const text = await call("ui_doc", { op: "set", ui_file: COPY, path: pathOf(read, "fuel_label"), key: "text", value: "Fuel level" });
    assert.equal(text.element.text, "Fuel level", "a bare sentence stays a string, quotes and all not required");
    await call("ui_doc", { op: "set", ui_file: COPY, path: p, key: "w", value: 60 });
    await call("ui_doc", { op: "set", ui_file: COPY, path: pathOf(read, "fuel_label"), key: "text", value: "Fuel" });
  });

  test("a layout child moves by writing the offset override, not an x/y", async () => {
    const read = await call("ui_doc", { op: "read", ui_file: COPY });
    const p = pathOf(read, "note_b");
    const r = await call("ui_doc", { op: "move", ui_file: COPY, path: p, dx: 3, dy: 1 });
    assert.deepEqual(r.element.offset, [5, 1], "the example already offsets note_b by [2, 0]");
    assert.equal(r.element.x, undefined, "a layout places its children; an x here would be a silent no-op");
    assert.match(r.note, /offset/);
    // The same move at the top level writes the position itself.
    const top = await call("ui_doc", { op: "move", ui_file: COPY, id: "logo", dx: 1, dy: 0 });
    assert.equal(top.element.x, 135);
    await call("ui_doc", { op: "move", ui_file: COPY, path: p, dx: -3, dy: -1 });
    await call("ui_doc", { op: "move", ui_file: COPY, id: "logo", dx: -1, dy: 0 });
  });

  test("a delete takes the subtree, and says the siblings renumbered", async () => {
    const before = await call("ui_doc", { op: "read", ui_file: COPY });
    const p = pathOf(before, "notes"); // a column with two labels in it
    const r = await call("ui_doc", { op: "remove", ui_file: COPY, path: p });
    assert.match(r.removed, /column 'notes'/);
    assert.match(r.note, /renumber|moved up/);
    const after = await call("ui_doc", { op: "read", ui_file: COPY });
    assert.equal(after.elements.length, before.elements.length - 3, "the column and both its labels");
    assert.ok(!after.elements.some((line) => line.endsWith("'note_a'")));
    // Put it back, so the rest of the file works on the document it expects.
    fs.writeFileSync(COPY, JSON.stringify((await call("ui_doc", { op: "read", ui: DOC })).json, null, 2));
  });

  test("an element is addressable by id as well as by path, and a bad address says so", async () => {
    const r = await call("ui_doc", { op: "read", ui_file: COPY });
    const byPath = await call("ui_doc", { op: "move", ui_file: COPY, path: pathOf(r, "logo"), dx: 0, dy: 0 });
    const byId = await call("ui_doc", { op: "move", ui_file: COPY, id: "logo", dx: 0, dy: 0 });
    assert.deepEqual(byPath.element, byId.element);
    assert.match(await refused("ui_doc", { op: "move", ui_file: COPY, id: "nosuch", dx: 1 }), /no element with id/);
    assert.match(await refused("ui_doc", { op: "move", ui_file: COPY, path: "elements[999]", dx: 1 }), /no element at/);
    assert.match(await refused("ui_doc", { op: "move", ui_file: COPY, path: "elements[0].kids[0]", dx: 1 }), /not an element path/);
  });

  // ---- generate -----------------------------------------------------------

  test("generate derives its arguments from where the document sits, and from gradle.properties", async () => {
    const r = await call("ui_doc", { op: "generate", ui_file: COPY });
    assert.equal(r.mod, MOD, "the mod is the directory under assets");
    assert.equal(r.package, PKG, "the package is the key `gradlew generateUi` reads");
    assert.deepEqual(r.problems, undefined);
    const written = Object.keys(r.files).map((f) => f.split("\\").join("/"));
    assert.ok(written.some((f) => f.includes(`${PKG.split(".").join("/")}/menu/ThingMenuBase.java`)),
      `the machine files land in the declared package: ${written.join(" | ")}`);
    assert.ok(fs.existsSync(path.join(tmp, "src/main/java", ...PKG.split("."), "client", "ThingLayout.java")));
  });

  test("generate check is checkUi's staleness guarantee, without a build", async () => {
    assert.equal((await call("ui_doc", { op: "generate", ui_file: COPY, check: true })).drift, false,
      "nothing has changed since the generate above");
    await call("ui_doc", { op: "move", ui_file: COPY, id: "logo", dx: 1, dy: 0 });
    const stale = await call("ui_doc", { op: "generate", ui_file: COPY, check: true });
    assert.equal(stale.drift, true, "one pixel in the document makes the checked-in code stale");
    assert.equal(stale.checked_only, true);
    assert.ok(Object.values(stale.files).includes("stale"));
    await call("ui_doc", { op: "move", ui_file: COPY, id: "logo", dx: -1, dy: 0 });
    assert.equal((await call("ui_doc", { op: "generate", ui_file: COPY, check: true })).drift, false);
  });

  test("the toolkit's own generated screen is not stale", async () => {
    // The same question the build answers, asked of the running game about the repository it was
    // built from - and non-destructively, since `check` writes nothing.
    const r = await call("ui_doc", { op: "generate", ui: DOC, check: true });
    assert.equal(r.package, "com.mattmc.mcptoolkit.ui.sample");
    assert.equal(r.drift, false,
      `ui/sample is out of date with example.ui.json - run gradlew generateUi: ${JSON.stringify(r.files)}`);
  });

  test("a project that never opted in is refused by the key it would set", async () => {
    const orphan = path.join(tmp, "orphan", "src", "main", "resources", "assets", "orphanmod", "ui");
    fs.mkdirSync(orphan, { recursive: true });
    fs.mkdirSync(path.join(tmp, "orphan", "src", "main", "java"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "orphan", "build.gradle"), "// no ui package here\n");
    const doc = path.join(orphan, "thing.ui.json");
    fs.writeFileSync(doc, JSON.stringify({ format: 1, title: "t", width: 176, height: 166, elements: [] }));
    assert.match(await refused("ui_doc", { op: "generate", ui_file: doc }), /mcmod\.ui\.package/);
  });

  // ---- preview, and the one conflict --------------------------------------

  test("preview opens the document in the client, and edit:true arms the editor", { skip: !clientPresent }, async () => {
    // Polled, on slice 3's advice: get_world_info answers as soon as the LEVEL is up, which is
    // before mc.player exists, and a preview borrows the player's inventory.
    let opened;
    for (let i = 0; i < 10; i++) {
      const j = await raw("ui_doc", { op: "preview", ui_file: COPY });
      if (j.ok) { opened = j.result; break; }
      if (!JSON.stringify(j.error).includes("in a world")) throw new Error(JSON.stringify(j.error));
      await new Promise((r) => setTimeout(r, 1000));
    }
    assert.ok(opened, "the client got a player within 10s of the level being up");
    assert.equal(opened.opened, "InterpretedScreen");
    assert.equal(opened.file.split("\\").join("/"), COPY.split("\\").join("/"),
      "the reply names the file, so a preview and an edit are provably the same document");
    assert.equal((await call("get_screen", {})).screen.class, "InterpretedScreen");

    const edit = await call("ui_doc", { op: "preview", ui_file: COPY, edit: true });
    assert.ok(edit.editor, "edit:true arms the in-game editor");
    assert.equal((await call("get_screen", {})).screen.editor.dirty, false);
  });

  test("a mutation is refused while the editor holds the same file with unsaved edits", { skip: !clientPresent }, async () => {
    // The editor is open on COPY from the case above. Dirty it through its own palette, the way a
    // human would, and then try to write underneath it.
    const s = await call("get_screen", { detail: "layout" });
    const panel = s.widgets.find((w) => w.label === "panel" && !w.id && !w.kind);
    assert.ok(panel, "the palette's `panel` entry is a chrome widget");
    await call("click", { index: panel.index });
    assert.equal((await call("get_screen", {})).screen.editor.dirty, true);

    const err = await refused("ui_doc", { op: "move", ui_file: COPY, id: "logo", dx: 1, dy: 0 });
    assert.match(err, /unsaved edits/, err);
    assert.match(err, /Ctrl\+S/, err);

    // Save in the editor, and the same call goes through - the refusal is about the CONFLICT, not
    // about the editor being open.
    const save = (await call("get_screen", { detail: "layout" })).widgets
      .find((w) => w.label === "save" && !w.id && !w.kind);
    assert.ok(save, "the editor's save button");
    await call("click", { index: save.index });
    assert.equal((await call("get_screen", {})).screen.editor.dirty, false);
    const ok = await call("ui_doc", { op: "move", ui_file: COPY, id: "logo", dx: 1, dy: 0 });
    assert.ok(ok.saved);
    await call("close_screen", {});
  });

  // ---- the two destinations, and the loop they exist to close ------------

  test("a write by resource id lands in BOTH destinations, and the running game sees it", { skip: !clientPresent }, async () => {
    // The only case that mutates a document addressed as <mod>:<screen>, and the only one that can
    // see the mirror at all - every mutation above went through `ui_file`, which has no pack copy.
    // This is the trap slice 4 found, asserted from the tool's side: save only into the source tree
    // and the RUNNING game keeps re-reading the stale pack copy, so the edit never appears.
    const read = await call("ui_doc", { op: "read", ui: DOC });
    const source = read.file;
    const mirror = read.mirror;
    const originalSource = fs.readFileSync(source);
    const originalMirror = fs.readFileSync(mirror);
    try {
      const moved = await call("ui_doc", { op: "move", ui: DOC, id: "logo", dx: 5, dy: 0 });
      assert.equal(moved.element.x, 139);
      assert.match(moved.saved, /mirrored into the loaded pack/);
      assert.ok(JSON.parse(fs.readFileSync(mirror, "utf8")).elements.some((e) => e.id === "logo" && e.x === 139),
        "the pack copy the game reads must agree with the source tree, or the edit is invisible");

      // ...which is the whole point: reopen the preview and the change is ON SCREEN.
      await call("ui_doc", { op: "preview", ui: DOC });
      const logo = (await call("get_screen", { detail: "layout" })).widgets.find((w) => w.id === "logo");
      assert.ok(logo, "the document's `logo` is a declared widget");
      const panelLeft = logo.x - 139;
      await call("ui_doc", { op: "move", ui: DOC, id: "logo", dx: -5, dy: 0 });
      await call("ui_doc", { op: "preview", ui: DOC });
      const back = (await call("get_screen", { detail: "layout" })).widgets.find((w) => w.id === "logo");
      assert.equal(back.x, panelLeft + 134, "and moving it back moves it back, through the same two files");
    } finally {
      // Byte-for-byte, both of them: this is the ONE case that touches the repository's own
      // reference document, and slice 3 compares it pixel for pixel.
      fs.writeFileSync(source, originalSource);
      fs.writeFileSync(mirror, originalMirror);
    }
    assert.deepEqual(fs.readFileSync(source), originalSource);
    assert.deepEqual(fs.readFileSync(mirror), originalMirror);
  });

  test("without a document, and with an unknown op, it says which", async () => {
    assert.match(await refused("ui_doc", { op: "read" }), /name ONE document/);
    assert.match(await refused("ui_doc", { op: "read", ui: DOC, ui_file: COPY }), /name ONE document/);
    assert.match(await refused("ui_doc", { op: "frobnicate", ui: DOC }), /unknown op/);
    assert.match(await refused("ui_doc", { ui: DOC }), /'op' is required/);
  });
});
