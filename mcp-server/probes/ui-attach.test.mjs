// Screen authoring, slice 6 (mcp-toolkit/docs/screens/SCREEN_AUTHORING_DESIGN.md sections 6.1 and 7.1): the
// ATTACHED preview, and regenerate-on-save.
//
// Attached means the interpreter is swapped in front of a real screen and wraps the SAME LIVE MENU
// INSTANCE - so the slots hold the running game's stacks, the bindings are what the server synced,
// and a button press rides vanilla's button channel to that menu's container id. Everything the
// detached preview could only imitate.
//
// What slice 6 promised, each as a case that can go red:
//   * attach wraps the container screen that is open, and takes its document from that screen when
//     the screen is a document's generated one;
//   * the interpreter over the live menu draws the SAME declared tree and the SAME slots as the
//     compiled screen - level 1 of section 12, now with one menu instead of two;
//   * the bindings are read off a menu that implements NO toolkit interface, through the duck-typed
//     `int bindingValue(String)` (open decision 8), and they are the same numbers;
//   * an action reaches the SERVER from the interpreted screen (the branch that existed since slice
//     1 and had never once run);
//   * detach puts the SAME screen instance back, and the menu still works afterwards - which is the
//     whole safety claim of section 6.1, asserted in both directions;
//   * ctrl+U does the same swap from the keyboard, which is the seam a human actually uses;
//   * a document whose geometry has moved shows the move for everything the interpreter draws and
//     CANNOT show it for a slot (vanilla's Slot.x is final), and says exactly which slots differ;
//   * a save in the in-game editor runs the emitter IN PROCESS (gradlew cannot run while this game
//     holds the jar - that is why section 7.1's first caller is mandatory), and the `gen` toggle
//     turns that off with the consequence named.
//
// SUBJECTS: the toolkit's own assets/mcptoolkit/ui/example.ui.json is READ ONLY here. The drift and
// editor cases work on a COPY inside a temp checkout, which is also what lets regenerate-on-save be
// exercised without writing a line of Java into any repository.
//
// Needs the client IN A SINGLEPLAYER WORLD (the generated menu opens through the integrated server)
// and puts the player in creative (a spectator's button clicks are dropped server-side). Live probe:
// skips itself otherwise. Run with `npm run test:live`, or via `tools/battery.ps1`.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const SESSION = "probe-ui-attach";
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForScreen(cls, ms = 5000) {
  const until = Date.now() + ms;
  let last;
  while (Date.now() < until) {
    last = await call("get_screen", { detail: "layout" });
    if (last.screen?.class === cls) return last;
    await sleep(100);
  }
  throw new Error(`screen ${cls} did not open; last: ${JSON.stringify(last?.screen)}`);
}
/**
 * The SERVER's record of the last action the sample menu received - `server_action` on either
 * renderer, and never `last_action`, which on an interpreted screen is what the client fired and is
 * set before the packet leaves. Waiting on the wrong one is a round trip that never gets checked.
 */
async function waitForServerAction(what, ms = 3000) {
  const until = Date.now() + ms;
  let last;
  while (Date.now() < until) {
    last = (await call("get_screen", {})).screen;
    if (last.server_action === what) return last;
    await sleep(100);
  }
  throw new Error(`the server never recorded '${what}'; last: ${JSON.stringify(last)}`);
}

/** The comparable shape of a declared-widget tree: everything but the window offset. */
function tree(s, origin) {
  return s.widgets
    .filter((w) => w.kind)
    .map((w) => ({
      id: w.id ?? null, kind: w.kind, label: w.label,
      x: w.x - origin.x, y: w.y - origin.y, width: w.width, height: w.height, active: w.active,
    }));
}
function originOf(s) {
  const outer = s.widgets.find((w) => w.id === "outer");
  assert.ok(outer, "the example's outermost layout node is the frame every comparison is relative to");
  return { x: outer.x, y: outer.y };
}
function slots(s) {
  return s.menu.slots.map((x) => ({ index: x.index, x: x.x, y: x.y, item: x.item ?? null, count: x.count ?? 0 }));
}
function widget(s, id) {
  const w = s.widgets.find((x) => x.id === id);
  assert.ok(w, `no declared widget '${id}': ${s.widgets.map((x) => x.id).join(",")}`);
  return w;
}
/** A chrome (undeclared) widget of the editor, by its label. */
function chrome(s, label) {
  const w = s.widgets.find((x) => x.label === label && !x.id && !x.kind);
  assert.ok(w, `no editor chrome labelled '${label}'`);
  return w;
}


/**
 * The tree, once the SERVER'S DATA SLOTS HAVE ARRIVED.
 *
 * <p>Found live (parts library, 2026-09-04). A generated screen's `visible`/`enabled` predicates read
 * a client-side `synced[]` that starts at zero: the first `ClientboundContainerSetDataPacket` lands
 * later, and `AbstractContainerMenu.setData` does NOT notify listeners on the client, so nothing
 * announces its arrival. Both renderers now re-evaluate every predicate PER FRAME (rather than per
 * tick, which was a 50ms window in which the two disagreed) - but `get_screen` reads the widget tree
 * directly and can land between the packet and the next frame. So a comparison across the wire waits
 * for the tree to STOP MOVING, which is what any two-renderer comparison over a sync has to do; the
 * detached interpreter needs no wire at all and is right from its first frame.
 */
async function settledScreen(cls, ms = 4000) {
  const until = Date.now() + ms;
  let last;
  let previous = null;
  while (Date.now() < until) {
    const now = await call("get_screen", { detail: "layout" });
    if (now.screen?.class === cls && Object.values(now.screen.bindings ?? {}).some((v) => v !== 0)) {
      const shape = JSON.stringify(now.widgets.map((w) => [w.id, w.x, w.y, w.width, w.height, w.active, w.visible]));
      if (shape === previous) return now;
      previous = shape;
      last = now;
    }
    await sleep(100);
  }
  return last;
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
if (!bridgeUp) console.log(`\n  [skip] no bridge at ${BASE} - start the dev game to run these probes\n`);
else if (!clientPresent) console.log("\n  [skip] bridge is up but headless - attaching wraps a SCREEN\n");
else if (!inWorld) console.log("\n  [skip] the client is not in a world - the generated menu opens through the integrated server\n");

// A temp checkout, for the two cases that must not touch a repository: the drifted document and the
// editor save that regenerates Java.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcptk-uiattach-"));
const MOD = "probeattach";
const PKG = "com.example.probeattach";
const uiDir = path.join(tmp, "src", "main", "resources", "assets", MOD, "ui");
const COPY = path.join(uiDir, "wired.ui.json");

describe("screen authoring slice 6: the attached preview", { skip: !bridgeUp || !clientPresent || !inWorld }, () => {
  let generated;
  let attached;

  before(async () => {
    fs.mkdirSync(uiDir, { recursive: true });
    fs.mkdirSync(path.join(tmp, "src", "main", "java"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "build.gradle"), "// a probe's project\n");
    fs.writeFileSync(path.join(tmp, "gradle.properties"), `mcmod.ui.package=${PKG}\n`);
    const read = await call("ui_doc", { op: "read", ui: DOC });
    fs.writeFileSync(COPY, JSON.stringify(read.json, null, 2));
    // Vanilla drops a SPECTATOR's button clicks server-side while still syncing data slots, so a
    // probe about the button channel needs a player the channel accepts (slice 2's finding).
    await call("run_command", { command: "gamemode creative @a" });
    await raw("close_screen", {});
    await sleep(150);
  });

  after(async () => {
    await raw("ui_doc", { op: "detach" });
    await raw("close_screen", {});
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("attach refuses when there is no menu to wrap, and names what is open", async () => {
    const err = await refused("ui_doc", { op: "attach" });
    assert.match(err, /nothing to attach to/, err);
  });

  test("attach wraps the open generated screen, taking the document FROM it", async () => {
    await call("open_screen", { ui: DOC, generated: true });
    generated = await settledScreen("ExampleScreen");

    const r = await call("ui_doc", { op: "attach" });
    assert.equal(r.attached, true);
    assert.equal(r.opened, "InterpretedScreen");
    assert.equal(r.wrapped, "ExampleScreen", "the screen put aside is the generated one");
    assert.equal(r.document, DOC, "a generated screen knows which document it is");
    assert.equal(r.document_derived_from, "ExampleScreen");
    assert.equal(r.menu.class, "ExampleMenu", "the LIVE menu, not a synthetic one");
    assert.equal(r.menu.bindings_read_by, "shape",
      "a generated menu implements no toolkit interface: it is read by the duck-typed method (decision 8)");
    assert.equal(r.menu.slots_moved, 0, `this menu WAS compiled from this document: ${JSON.stringify(r.menu.slot_drift)}`);
    assert.equal(r.menu.slot_drift, undefined);

    attached = await call("get_screen", { detail: "layout" });
    assert.equal(attached.screen.class, "InterpretedScreen");
    assert.equal(attached.screen.detached, false, "this preview is over a real menu");
    assert.equal(attached.screen.wrapped, "ExampleScreen");
    // The identity claim, checked rather than told: the same container id on the wire, before and
    // after the swap. A screen that had opened its own menu would carry another one.
    assert.equal(attached.menu.container_id, generated.menu.container_id);
    assert.equal(attached.screen.attached.container_id, generated.menu.container_id);
    assert.equal(attached.menu.class, "ExampleMenu");
  });

  test("the interpreter over the live menu draws the compiled screen's tree, widget for widget", () => {
    assert.deepEqual(tree(attached, originOf(attached)), tree(generated, originOf(generated)),
      "attached, the two renderers have one menu and one document between them - any difference is the renderer");
  });

  test("the slots are that menu's own: same indices, same positions, same stacks", () => {
    assert.deepEqual(slots(attached), slots(generated),
      "a detached preview would show PLACEHOLDERS here; attached it is the running game's inventory");
    assert.ok(slots(attached).length >= 38, "the example declares two container slots plus the player's");
  });

  test("the bindings are the live ones, read through a method and not an interface", async () => {
    assert.deepEqual(attached.screen.bindings, generated.screen.bindings,
      "the same menu answering the same names - through UiBindings.bind's SHAPE arm");
    assert.equal(attached.screen.attached.bindings_read_by, "shape");
    assert.deepEqual(attached.screen.attached.bindings, attached.screen.bindings);
    assert.equal(attached.screen.bindings.fuel, 42000, "the wide binding, reassembled from two shorts");
    assert.equal(attached.screen.attached.bindings_problem, undefined);
  });

  test("a press on the INTERPRETED screen reaches the server's menu", async () => {
    // The branch that has existed since slice 1 and had never run: attached, onAction sends
    // ServerboundContainerButtonClickPacket on the live container id. Detached it goes nowhere, and
    // a menu the server does not know drops it ("Ignoring click in mismatching container").
    // Two presses, because the server's record is a static that outlives a probe run: the FIRST puts
    // it in a known state and the second is therefore a provable transition, whatever ran before.
    await call("click", { index: widget(attached, "launch").index });
    await waitForServerAction("launch");
    await call("click", { index: widget(attached, "ok").index }); // the example's second button, action `cancel`
    const s = await waitForServerAction("cancel");
    assert.equal(s.server_action, "cancel", "the SERVER-side menu recorded it");
    assert.equal(s.last_action, "cancel", "and the interpreter recorded what it fired");
  });

  test("detach puts the SAME screen back, and the menu still works", async () => {
    const r = await call("ui_doc", { op: "detach" });
    assert.equal(r.detached, true);
    assert.equal(r.opened, "ExampleScreen");
    const back = await call("get_screen", { detail: "layout" });
    assert.equal(back.screen.class, "ExampleScreen");
    assert.equal(back.screen.generated, true);
    assert.deepEqual(slots(back), slots(generated), "the menu came through both swaps intact");
    assert.equal(back.menu.container_id, generated.menu.container_id, "the same menu, not a reopened one");
    // The claim of section 6.1 is that a swap never closes the menu. The proof is not that the
    // screen came back - it is that the channel still carries.
    // 'cancel' is what the case above left on the server, so this is a transition and not a
    // leftover: the menu is still receiving after being swapped out and back.
    await call("click", { index: widget(back, "launch").index });
    const s = await waitForServerAction("launch");
    assert.equal(s.server_action, "launch");
  });

  test("ctrl+U is the human's half of the same swap, both ways", async () => {
    // The seam section 6.1 is actually about: stand in front of the real screen and press a key. It
    // rides a mixin at Screen.keyPressed HEAD, which a container screen reaches through its own
    // super call - a hook that silently does not fire is exactly what a tool-driven battery would
    // never notice, so the key is pressed here as a key.
    assert.equal((await call("get_screen", {})).screen.class, "ExampleScreen");
    await call("send_keys", { key: "u", modifiers: ["ctrl"] });
    const on = (await call("get_screen", {})).screen;
    assert.equal(on.class, "InterpretedScreen");
    assert.equal(on.detached, false, "the key attached over the live menu, not a detached preview");
    assert.equal(on.wrapped, "ExampleScreen");
    await call("send_keys", { key: "u", modifiers: ["ctrl"] });
    assert.equal((await call("get_screen", {})).screen.class, "ExampleScreen", "and the same key goes back");
  });

  test("a moved element follows the document; a moved SLOT cannot, and is named", async () => {
    // The one honest limit of attached mode: Slot.x is final in 26.2, so the slots belong to the
    // menu the mod compiled. Move a label AND a slot in a copy of the document, attach that copy
    // over the same live menu, and exactly one of the two moves.
    const read = await call("ui_doc", { op: "read", ui_file: COPY });
    await call("ui_doc", { op: "move", ui_file: COPY, id: "fuel_label", dx: 5, dy: 0 });
    await call("ui_doc", { op: "move", ui_file: COPY, id: "output_slot", dx: 0, dy: 4 });
    assert.ok(read.json, "the copy came through the tool, so it is canonical");

    const r = await call("ui_doc", { op: "attach", ui_file: COPY });
    assert.equal(r.attached, true);
    assert.equal(r.document_derived_from, undefined, "the document was NAMED, not derived");
    assert.equal(r.menu.slots_moved, 1);
    assert.equal(r.menu.slot_drift.length, 1);
    assert.match(r.menu.slot_drift[0], /'output_slot'/);
    assert.match(r.menu.slot_drift[0], /110,40/, `the document's new position: ${r.menu.slot_drift[0]}`);
    assert.match(r.menu.slot_drift[0], /110,36/, `the live menu's old one: ${r.menu.slot_drift[0]}`);

    const now = await call("get_screen", { detail: "layout" });
    const before = widget(generated, "fuel_label");
    assert.equal(widget(now, "fuel_label").x - before.x, 5, "the label moved: the interpreter draws it");
    assert.deepEqual(slots(now), slots(generated), "the slots did not: they are the live menu's");
    await call("ui_doc", { op: "detach" });
  });

  test("attaching over a DETACHED preview is refused, and so is detaching nothing", async () => {
    await call("close_screen", {});
    await sleep(150);
    assert.match(await refused("ui_doc", { op: "detach" }), /nothing to detach/);
    await call("ui_doc", { op: "preview", ui_file: COPY });
    const err = await refused("ui_doc", { op: "attach" });
    assert.match(err, /DETACHED preview/, err);
    assert.match(await refused("ui_doc", { op: "detach" }), /synthetic/);
    await call("close_screen", {});
  });

  // ---- regenerate-on-save (section 7.1's mandatory in-process caller) ------

  test("a save in the editor runs the emitter in process, and writes the Java", async () => {
    const emitted = path.join(tmp, "src", "main", "java", ...PKG.split("."), "client", "WiredLayout.java");
    assert.equal(fs.existsSync(emitted), false, "nothing has generated this document yet");

    const opened = await call("ui_doc", { op: "preview", ui_file: COPY, edit: true });
    assert.equal(opened.editor.regenerate, true, "a save regenerates unless the human turns it off");
    // Dirty it the way a human does - through the editor's own palette.
    let s = await call("get_screen", { detail: "layout" });
    await call("click", { index: chrome(s, "panel").index });
    assert.equal((await call("get_screen", {})).screen.editor.dirty, true);

    s = await call("get_screen", { detail: "layout" });
    await call("click", { index: chrome(s, "save").index });
    const ed = (await call("get_screen", {})).screen.editor;
    assert.equal(ed.dirty, false);
    assert.match(ed.generated, /rewrote \d+ generated file/, `the save regenerated: ${JSON.stringify(ed)}`);
    assert.match(ed.generated, /OLD classes/, "and said the running game is behind until a rebuild");
    assert.equal(fs.existsSync(emitted), true, `${emitted} was generated by the SAVE, with no gradlew`);
    assert.match(fs.readFileSync(emitted, "utf8"), /class WiredLayout/);
  });

  test("the gen toggle turns it off, and says what goes stale", async () => {
    let s = await call("get_screen", { detail: "layout" });
    await call("click", { index: chrome(s, "gen").index });
    let ed = (await call("get_screen", {})).screen.editor;
    assert.equal(ed.regenerate, false);
    assert.match(ed.message, /stale/, `turning it off names the consequence: ${ed.message}`);

    s = await call("get_screen", { detail: "layout" });
    await call("click", { index: chrome(s, "panel").index });
    s = await call("get_screen", { detail: "layout" });
    await call("click", { index: chrome(s, "save").index });
    ed = (await call("get_screen", {})).screen.editor;
    assert.equal(ed.dirty, false, "the document was still saved");
    assert.equal(ed.generated, undefined, "and nothing was generated");
    // The document on disk moved on; the generated Java did not, which `generate check` can see.
    assert.equal((await call("ui_doc", { op: "generate", ui_file: COPY, check: true })).drift, true,
      "that is what 'stale' means, and checkUi is what would catch it in a build");
    await call("close_screen", {});
  });
});
