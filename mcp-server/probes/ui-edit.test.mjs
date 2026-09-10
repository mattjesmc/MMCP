// Screen authoring, slice 4 (mcp-toolkit/docs/screens/SCREEN_AUTHORING_DESIGN.md section 9): the in-game editor,
// driven live by the toolkit's own tools.
//
// The claim under test is section 9's, and it is a strong one: "the toolkit's own click (with its
// drag mode), screenshot_annotated and get_screen can drive the editor itself". So nothing here
// reaches into the editor through a back door - every case presses a real widget by label, drags
// with real mouse events, types into a real EditBox, and reads the result out of get_screen. If the
// editor were not drivable that way, this file could not exist, and a human would be the only
// instrument slice 4 had.
//
// What each case can catch:
//   * the PALETTE is enumerated from the registry, not hand-kept: the palette get_screen reports is
//     compared against open_screen's `kinds.registered`, and every entry is then CLICKED - so a
//     kind whose insert default is missing or invalid turns one case red by name (the unit half is
//     UiEditTest.everyRegisteredKindInsertsCleanly, which runs with no game at all);
//   * a DRAG moves the document, not the widget: the widget's new pixel position and the document's
//     new x are asserted together, and undo puts BOTH back;
//   * SNAP: the same drag with snap on lands on the 18px slot pitch;
//   * a RESIZE handle changes the size the format declares (w/h), and a slot grid resizes in SLOTS;
//   * the INSPECTOR reads the parser's own property table, and a bad value is REFUSED with the
//     parser's sentence while the document on screen stays as it was;
//   * the SAVE TARGET is the source tree, never a build output - asserted without saving into the
//     toolkit's own repo, and then a real save is done on a throwaway copy under the temp dir;
//   * and the one that protects slice 3 from slice 4: with the editor ON, the DECLARED widget tree
//     is unchanged, because the editor's furniture is deliberately undeclared. If that ever fails,
//     the conformance battery starts comparing an editor against a generated screen.
//
// SUBJECTS: the toolkit's own assets/mcptoolkit/ui/example.ui.json (read-only here, for the resource
// path and the save-target rule) and a COPY of it written to the temp dir and opened with `ui_file`,
// which is what every mutating case edits. The repo's example is never written to by this probe.
//
// It drives the screen of whatever client is attached and leaves no screen open. It stages no
// geometry, owns no site, touches no world and reloads nothing.
//
// Live probe: needs the dev game up WITH A CLIENT in a world. Skips itself otherwise.
// Run with `npm run test:live`, or sequentially via `tools/battery.ps1`.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const SESSION = "probe-ui-edit";
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
} else if (!clientPresent) {
  console.log("\n  [skip] bridge is up but headless - the editor is a SCREEN, so it needs a client\n");
} else if (!inWorld) {
  console.log("\n  [skip] the client is not in a world - a ui preview borrows the player's inventory\n");
}

// ---------------------------------------------------------------------------------------------
// Helpers over the screen tools. Everything the editor is asked to do goes through these.

async function screen(detail = "layout") {
  return call("get_screen", { detail });
}
async function editor() {
  const s = await screen();
  assert.ok(s.screen.editor, "the editor is on");
  return s.screen.editor;
}
/** A widget row by document id, from get_screen's tree. */
function byId(s, id) {
  const w = s.widgets.find((x) => x.id === id);
  assert.ok(w, `widget '${id}' is in the tree`);
  return w;
}
/** A chrome widget row by exact label - the editor's buttons name their commands. */
function chrome(s, label) {
  const w = s.widgets.find((x) => x.label === label && !x.id && !x.kind);
  assert.ok(w, `chrome '${label}' is in the tree (labels: ${s.widgets.map((x) => x.label).join("|")})`);
  return w;
}
async function press(label) {
  const s = await screen();
  return call("click", { index: chrome(s, label).index });
}
/** The document text without carriage returns, so the two destinations compare on CONTENT. */
function stripCr(text) {
  return text.split(String.fromCharCode(13)).join("");
}

/** The document as the game has it right now, read back off disk. */
function onDisk(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcptk-uiedit-"));
const copy = path.join(tmp, "probe.ui.json");

describe("screen authoring slice 4: the in-game editor", { skip: !bridgeUp || !clientPresent || !inWorld }, () => {
  let registered;

  before(async () => {
    // The registry, off the running game, and the example document's text - taken through the
    // toolkit rather than off disk so the copy is byte-identical to what the game just parsed.
    //
    // POLLED, on section 19's own advice: get_world_info answers as soon as the LEVEL is up, which
    // is before mc.player exists, and a preview needs the player (it borrows the inventory). The
    // gate above is therefore not sufficient on its own right after a world load.
    let opened;
    for (let i = 0; i < 10; i++) {
      const j = await raw("open_screen", { ui: DOC });
      if (j.ok) { opened = j.result; break; }
      if (!JSON.stringify(j.error).includes("in a world")) throw new Error(JSON.stringify(j.error));
      await new Promise((r) => setTimeout(r, 1000));
    }
    assert.ok(opened, "the client got a player within 10s of the level being up");
    registered = opened.kinds.registered.map((k) => k.name);
    const target = (await screen()).screen;
    assert.equal(target.class, "InterpretedScreen");
    await raw("close_screen", {});
  });

  after(async () => {
    await raw("close_screen", {});
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------------------------

  test("the save target is the SOURCE TREE, never the build output the game is reading", async () => {
    // Two ways to lose the human's work, and this is the one that looks like success: saving into
    // build/resources/main, which the next Gradle build overwrites. Asserted WITHOUT saving.
    const opened = await call("open_screen", { ui: DOC, edit: true });
    assert.ok(opened.editor, "open_screen edit:true reports the editor straight away");
    const e = opened.editor;
    assert.equal(e.on, true);
    assert.equal(e.dirty, false, "nothing has been edited yet");
    assert.ok(e.save_target, `a save target was resolved: ${JSON.stringify(e)}`);
    const slashed = e.save_target.replace(/\\/g, "/");
    assert.ok(
      slashed.includes("/src/main/resources/assets/mcptoolkit/ui/example.ui.json"),
      `the save target is the source tree, got ${e.save_target}`,
    );
    assert.ok(!/\/build\//.test(slashed), `and not a build output: ${e.save_target}`);
    assert.ok(e.save_mirror, "the loaded pack's copy is kept in step, or the preview would re-read stale bytes");
    assert.ok(/\/build\/resources\/main\//.test(e.save_mirror.replace(/\\/g, "/")), e.save_mirror);
    await raw("close_screen", {});
  });

  test("a save writes BOTH destinations, and writing the same bytes leaves the repo clean", async () => {
    // The mirror is the half that cannot be tested on a temp copy: only a document loaded through
    // the RESOURCE MANAGER has two destinations. Saving the example UNCHANGED exercises both writes
    // with nothing to lose - if the source-tree write went to the wrong place, or the mirror write
    // threw, this goes red, and if either wrote different bytes the repo would show a diff.
    const src = exampleSource();
    // BYTES, not text: the first Windows save rewrote every line ending (UiWriter emits LF, a
    // checkout with core.autocrlf=true leaves CRLF), which git status reports as a modified file
    // while git diff prints nothing. A save must leave the file it did not change alone.
    const before = fs.readFileSync(src);
    const opened = await call("open_screen", { ui: DOC, edit: true });
    const mirror = opened.editor.save_mirror;
    const mirrorBefore = fs.readFileSync(mirror);
    await press("save");
    const e = await editor();
    assert.equal(e.message_is_error, false, e.message);
    assert.match(e.message, /mirrored into the loaded pack/, e.message);
    assert.ok(fs.readFileSync(src).equals(before),
      "the source tree is byte-identical, LINE ENDINGS INCLUDED");
    assert.ok(fs.readFileSync(mirror).equals(mirrorBefore),
      "and so is the loaded pack copy, which may legitimately use the other convention");
    assert.equal(stripCr(fs.readFileSync(src, "utf8")),
      stripCr(fs.readFileSync(mirror, "utf8")),
      "both destinations hold the same document");
    await raw("close_screen", {});
  });

  test("the editor's furniture is UNDECLARED, so the conformance battery cannot see it", async () => {
    // This is slice 3's protection. The declared-widget tree is what section 12 compares across the
    // two renderers; if the editor's palette ever became declared, the battery would start
    // comparing an editor against a generated screen and nobody would know why it went red.
    const plain = await call("open_screen", { ui: DOC });
    const before = (await screen()).widgets.filter((w) => w.kind);
    await raw("close_screen", {});
    await call("open_screen", { ui: DOC, edit: true });
    const s = await screen();
    const after = s.widgets.filter((w) => w.kind);
    assert.deepEqual(
      after.map((w) => [w.id, w.kind, w.x, w.y, w.width, w.height]),
      before.map((w) => [w.id, w.kind, w.x, w.y, w.width, w.height]),
      "every declared widget is identical with the editor on",
    );
    const furniture = s.widgets.filter((w) => !w.kind);
    assert.ok(furniture.length >= 22, `the editor DID add its own widgets: ${furniture.length}`);
    assert.equal(plain.detached, true);
    await raw("close_screen", {});
  });

  test("the palette is the registry, and every entry inserts a document the parser accepts", async () => {
    fs.writeFileSync(copy, fs.readFileSync(exampleSource(), "utf8"));
    await call("open_screen", { ui_file: copy, edit: true });
    let e = await editor();
    assert.deepEqual(e.palette, registered, "the palette IS Kind.values(), in registry order");

    // Click every one. A kind whose insert default is missing or invalid fails here by name.
    const failures = [];
    for (const kind of registered) {
      const s = await screen();
      const btn = s.widgets.find((w) => w.label === kind && !w.kind);
      if (!btn) {
        failures.push(`${kind}: no palette button`);
        continue;
      }
      await call("click", { index: btn.index });
      const now = await editor();
      if (now.message_is_error) {
        failures.push(`${kind}: ${now.message}`);
        continue;
      }
      if (now.selected_kind !== kind) {
        failures.push(`${kind}: selected ${now.selected_kind} after adding it`);
      }
    }
    assert.deepEqual(failures, [], "every registered kind inserted and got selected");

    e = await editor();
    assert.equal(e.undo, registered.length, "one undo entry per insert");
    assert.equal(e.dirty, true);
    // And back: undo every insert restores the file byte for byte, which is what makes a snapshot
    // stack an honest undo.
    for (let i = 0; i < registered.length; i++) await press("undo");
    e = await editor();
    assert.equal(e.undo, 0);
    await press("save");
    assert.deepEqual(
      onDisk(copy),
      JSON.parse(fs.readFileSync(exampleSource(), "utf8")),
      "after N inserts and N undos the document is the one we started from",
    );
    await raw("close_screen", {});
  });

  test("a drag moves the DOCUMENT, and undo puts it back", async () => {
    fs.writeFileSync(copy, fs.readFileSync(exampleSource(), "utf8"));
    await call("open_screen", { ui_file: copy, edit: true });
    let s = await screen();
    const before = byId(s, "smelting"); // a well at document (8, 18), 160x40
    const frame = byId(s, "outer");
    assert.equal(before.x - frame.x, 8);

    // Press inside it, away from its handles, and drag +12/+7.
    const fromX = before.x + 40;
    const fromY = before.y + 20;
    const drag = await call("click", { x: fromX, y: fromY, to_x: fromX + 12, to_y: fromY + 7 });
    assert.equal(drag.pressed, true, "the editor took the press");
    assert.equal(drag.dragged, true, "and the drag");

    let e = await editor();
    assert.equal(e.selected_id, "smelting", "the press selected what it grabbed");
    s = await screen();
    const after = byId(s, "smelting");
    assert.equal(after.x, before.x + 12, "the widget moved by the drag");
    assert.equal(after.y, before.y + 7);
    assert.equal(e.dirty, true);
    assert.equal(e.undo, 1, "a whole drag is ONE undo entry, not one per mouse event");

    // The destination is the document, so a save writes exactly that.
    await press("save");
    const saved = onDisk(copy);
    const well = saved.elements.find((x) => x.id === "smelting");
    assert.equal(well.x, 8 + 12, "the file carries the new x");
    assert.equal(well.y, 18 + 7);
    assert.equal(well.w, 160, "a move is not a resize");

    await press("undo");
    s = await screen();
    assert.equal(byId(s, "smelting").x, before.x, "undo moved it back on screen");
    await press("save");
    assert.equal(onDisk(copy).elements.find((x) => x.id === "smelting").x, 8, "and in the file");
    await raw("close_screen", {});
  });

  test("snap: the same drag lands on the 18px slot pitch", async () => {
    fs.writeFileSync(copy, fs.readFileSync(exampleSource(), "utf8"));
    await call("open_screen", { ui_file: copy, edit: true });
    let e = await editor();
    assert.equal(e.snap, 1, "1px by default: the 3px nudge is what this project exists for");
    await press("snap");
    e = await editor();
    assert.equal(e.snap, 18, "and the toggle is the slot grid");

    const s = await screen();
    const well = byId(s, "smelting"); // document (8, 18)
    const fromX = well.x + 40;
    const fromY = well.y + 20;
    // +5 from x=8 is 13, which snaps to 18; +5 from y=18 is 23, which snaps back to 18.
    await call("click", { x: fromX, y: fromY, to_x: fromX + 5, to_y: fromY + 5 });
    await press("save");
    const moved = onDisk(copy).elements.find((x) => x.id === "smelting");
    assert.equal(moved.x % 18, 0, `x snapped to the pitch: ${moved.x}`);
    assert.equal(moved.x, 18);
    assert.equal(moved.y, 18, "and y was already on it, so a 5px drag moved it nowhere");
    await raw("close_screen", {});
  });

  test("a resize handle changes what the format declares - in slots, for a slot grid", async () => {
    fs.writeFileSync(copy, fs.readFileSync(exampleSource(), "utf8"));
    await call("open_screen", { ui_file: copy, edit: true });

    // A bar: w/h in pixels. Select it, then drag its east handle.
    let s = await screen();
    const bar = byId(s, "progress_bar"); // 60x8 at (40, 40)
    await call("click", { x: bar.x + 30, y: bar.y + 4 });
    let e = await editor();
    assert.equal(e.selected_id, "progress_bar");
    assert.equal(e.resizable, true);
    assert.deepEqual(e.selected_rect, [bar.x, bar.y, bar.width, bar.height]);
    const east = { x: bar.x + bar.width, y: bar.y + Math.floor(bar.height / 2) };
    await call("click", { x: east.x, y: east.y, to_x: east.x + 15, to_y: east.y });
    await press("save");
    assert.equal(onDisk(copy).elements.find((x) => x.id === "progress_bar").w, 75, "60 + 15");

    // A PART INSTANCE IS ONE OBJECT (UI_PARTS_LIBRARY_DESIGN.md section 5.2 rule 5). The example's
    // player inventory comes from mcptoolkit:player_inventory, so clicking a hotbar slot selects the
    // INSTANCE, not the slot grid inside it - and the instance has no size of its own, because a
    // macro is an origin and the fragment sizes what it expands to.
    s = await screen();
    const frame = byId(s, "outer");
    await call("click", { x: frame.x + 8 + 8, y: frame.y + 197 + 8 }); // the part's hotbar row
    e = await editor();
    assert.equal(e.selected_id, "inv", "the part instance is what a click grabs, never its expansion");
    assert.equal(e.resizable, false, "a macro is an origin; there is no w to drag");

    // A slot grid HAS no w either: its size is cols * 18, so the drag must round to whole slots. One
    // inserted from the palette is editable (it is this document's), which is the other half of the
    // rule - what the document holds can be dragged, what a part holds cannot.
    await press("slot_grid");
    e = await editor();
    const added = e.selected_id;
    assert.ok(added, "the palette selects what it inserted");
    const [gx, gy, gw, gh] = e.selected_rect;
    // SHRINK, not grow: the palette declares a container exactly big enough for what it inserted, so
    // dragging a 3-slot row wider is refused by the parser ("slots 0..4 exceed container") - which is
    // correct, and is the format saying that a slot index outside its container is not a screen.
    await call("click", { x: gx + gw, y: gy + Math.floor(gh / 2), to_x: gx + gw - 20, to_y: gy + Math.floor(gh / 2) });
    await press("save");
    const grid = onDisk(copy).elements.find((x) => x.id === added);
    assert.equal(grid.cols, 2, "dragging 20px off a 3-slot row leaves 2 slots, not 34 pixels");
    assert.equal(grid.rows, 1);
    assert.equal(grid.w, undefined, "a slot grid still declares no w");
    await raw("close_screen", {});
  });

  test("the inspector edits by the parser's property table, and a bad value is refused BY NAME", async () => {
    fs.writeFileSync(copy, fs.readFileSync(exampleSource(), "utf8"));
    await call("open_screen", { ui_file: copy, edit: true });
    let s = await screen();
    const label = byId(s, "fuel_label");
    await call("click", { x: label.x + 2, y: label.y + 2 });
    let e = await editor();
    assert.equal(e.selected_id, "fuel_label");
    // The rows are the parser's keys for a label, plus its placement and id - and nothing else.
    assert.deepEqual(e.inspector,
      ["id", "x", "y", "color", "h", "mode", "shadow", "text", "tooltip", "visible", "w"],
      "the parser's keys for a label - including the decorations every box and leaf carries");

    // Type a new text and commit it with Enter, the way a human does.
    s = await screen();
    const textRow = s.widgets.find((w) => w.class === "EditBox" && w.label === "text");
    assert.ok(textRow, "there is a box for `text`");
    await call("set_text", { index: textRow.index, text: "Coal" });
    await call("send_keys", { key: "enter" });
    e = await editor();
    assert.equal(e.message_is_error, false, e.message);
    s = await screen();
    assert.equal(byId(s, "fuel_label").label, "Coal", "the screen shows the new text");
    await press("save");
    assert.equal(onDisk(copy).elements.find((x) => x.id === "fuel_label").text, "Coal");

    // Now a value the parser refuses. The document must NOT change, and the editor must say why in
    // the parser's own words - that is the whole benefit of routing an edit through a re-parse.
    s = await screen();
    const modeRow = s.widgets.find((w) => w.class === "EditBox" && w.label === "mode");
    await call("set_text", { index: modeRow.index, text: "diagonal" });
    await call("send_keys", { key: "enter" });
    e = await editor();
    assert.equal(e.message_is_error, true, "a refusal is reported as one");
    assert.match(e.message, /unknown mode/, e.message);
    assert.match(e.message, /plain, wrapped, scrolling, truncated/, "and it lists what IS allowed");
    await press("save");
    assert.equal(onDisk(copy).elements.find((x) => x.id === "fuel_label").mode, undefined,
      "the refused edit reached neither the screen nor the file");
    await raw("close_screen", {});
  });

  test("arrow keys nudge the selection, and Ctrl+S is the save button", async () => {
    fs.writeFileSync(copy, fs.readFileSync(exampleSource(), "utf8"));
    await call("open_screen", { ui_file: copy, edit: true });
    const s = await screen();
    const icon = byId(s, "check"); // (154, 38)
    await call("click", { x: icon.x + 6, y: icon.y + 6 });
    let e = await editor();
    assert.equal(e.selected_id, "check");
    await call("send_keys", { key: "right", times: 3 });
    await call("send_keys", { key: "up" });
    e = await editor();
    assert.equal(e.undo, 4, "one undo entry per nudge, so a 3px overshoot is 3 presses back");
    await call("send_keys", { key: "s", modifiers: ["ctrl"] });
    e = await editor();
    assert.equal(e.dirty, false, "ctrl+s saved");
    const moved = onDisk(copy).elements.find((x) => x.id === "check");
    assert.equal(moved.x, 154 + 3);
    assert.equal(moved.y, 38 - 1);
    // Shift is the coarse step: the slot pitch.
    await call("send_keys", { key: "right", modifiers: ["shift"] });
    await call("send_keys", { key: "s", modifiers: ["ctrl"] });
    assert.equal(onDisk(copy).elements.find((x) => x.id === "check").x, 154 + 3 + 18);
    await raw("close_screen", {});
  });

  test("a delete takes the subtree, and the editor refuses what the format refuses", async () => {
    fs.writeFileSync(copy, fs.readFileSync(exampleSource(), "utf8"));
    await call("open_screen", { ui_file: copy, edit: true });
    let s = await screen();
    // A click always finds the SMALLEST rect under the point, so a container is reached by
    // selecting a child and going up - which is what every layout editor has a "parent" for. Here
    // it is also what makes the case deterministic instead of hunting for a pixel no child covers.
    const launch = byId(s, "launch");
    await call("click", { x: launch.x + 4, y: launch.y + 4 });
    let e = await editor();
    assert.equal(e.selected_id, "launch");
    await press("parent");
    e = await editor();
    assert.equal(e.selected_id, "footer", `expected the row node, got ${e.selected_id}`);
    await press("delete");
    e = await editor();
    assert.equal(e.selected, undefined, "nothing is selected after a delete");
    s = await screen();
    assert.equal(s.widgets.find((w) => w.id === "launch"), undefined, "its children went with it");
    await press("save");
    const saved = onDisk(copy);
    assert.equal(saved.elements.find((x) => x.id === "footer"), undefined);
    assert.ok(saved.actions.includes("launch"), "the ACTION it fired is still declared - a declaration is not an element");

    // And the two placement rules the format has: a spacer at the top level is refused, in the
    // parser's words, with nothing selected to insert into.
    s = await screen();
    const spacer = s.widgets.find((w) => w.label === "spacer" && !w.kind);
    await call("click", { index: spacer.index });
    e = await editor();
    assert.equal(e.message_is_error, true);
    assert.match(e.message, /inside a row, column, grid or stack/, e.message);
    await raw("close_screen", {});
  });

  test("leaving edit mode re-reads the file, and the editor is gone from get_screen", async () => {
    fs.writeFileSync(copy, fs.readFileSync(exampleSource(), "utf8"));
    await call("open_screen", { ui_file: copy, edit: true });
    let s = await screen();
    const before = byId(s, "logo").x;
    await call("click", { x: byId(s, "logo").x + 4, y: byId(s, "logo").y + 4 });
    await call("send_keys", { key: "right", times: 5 });
    s = await screen();
    assert.equal(byId(s, "logo").x, before + 5, "moved, unsaved");
    await press("exit edit");
    s = await screen();
    assert.equal(s.screen.editor, undefined, "no editor object once it is off");
    assert.equal(byId(s, "logo").x, before,
      "and the unsaved move is gone: with the editor off the document is the FILE again");
    await raw("close_screen", {});
  });
});

/** The toolkit's own example document, in the source tree beside this repo. */
function exampleSource() {
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  return path.join(here, "..", "..", "mcp-toolkit", "src", "main", "resources", "assets",
    "mcptoolkit", "ui", "example.ui.json");
}
