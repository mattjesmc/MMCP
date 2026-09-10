// Screen authoring, slice 1 (mcp-toolkit/docs/screens/SCREEN_AUTHORING_DESIGN.md sections 4-6): the detached
// interpreter, live.
//
// What slice 1 promised, each as a case that can go red:
//   * a hand-written .ui.json opens as a detached preview (open_screen ui:"mcptoolkit:example");
//   * get_screen NAMES its declared widgets - every non-slot element with an id is a widget row
//     carrying that id and kind, which is the point of section 1's fourth editor;
//   * the slots are the menu's (section 4.5): 2 declared + 36 player, with the placeholders in them;
//   * geometry is the document's - a button at (8, 94) sits at frame + (8, 94); a layout child's
//     offset lands where the document says; a button press is recorded as its declared action;
//   * a document with an unregistered kind is refused BY NAME with the registry, and a missing one
//     with its resource path.
//
// This is NOT the conformance battery (slice 3): nothing here compares the interpreter against
// generated Java, because no Java is generated yet. It pins the interpreter's half so slice 3 has a
// fixed side to compare against.
//
// SUBJECT: the toolkit's own assets/mcptoolkit/ui/example.ui.json, which UiDocumentTest already
// proves uses every registered kind - so "renders every kind" is the unit test's claim and
// "every declared one is a nameable widget" is this file's.
//
// Drives the screen of whatever client is attached (opens and closes a preview, presses one button
// that goes nowhere), so it lives outside conformance's client tier like ui-input.test.mjs. Needs the
// client IN A WORLD: the preview borrows the player's inventory for its `player` container.
//
// Live probe: needs the dev game up WITH A CLIENT in a world. Skips itself otherwise.
// Run with `npm run test:live`, or sequentially via `tools/battery.ps1`.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const SESSION = "probe-ui-doc";
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
  // get_world_info answers only once a level is loaded; that is the preview's precondition.
  if (clientPresent) inWorld = (await raw("get_world_info", {})).ok === true;
}
if (!bridgeUp) {
  console.log(`\n  [skip] no bridge at ${BASE} - start the dev game to run these probes\n`);
} else if (!clientPresent) {
  console.log("\n  [skip] bridge is up but headless - these probes open a SCREEN, so they need a client\n");
} else if (!inWorld) {
  console.log("\n  [skip] the client is not in a world - a ui preview borrows the player's inventory (open_world first)\n");
}

describe("screen authoring slice 1: the detached interpreter", { skip: !bridgeUp || !clientPresent || !inWorld }, () => {
  let opened;
  let byId;

  before(async () => {
    opened = await call("open_screen", { ui: DOC });
  });
  after(async () => {
    await raw("close_screen", {});
  });

  test("a hand-written document opens as a detached preview", () => {
    assert.equal(opened.opened, "InterpretedScreen");
    assert.equal(opened.document, DOC);
    assert.equal(opened.detached, true);
    assert.equal(opened.slots, 4 + 36,
      "two declared slots, two more from the station_inputs part, and the 36 player slots");
    assert.ok(opened.declared.length > 10, `declared: ${opened.declared}`);
  });

  test("get_screen names every declared non-slot element by id and kind", async () => {
    const s = await call("get_screen", { detail: "layout" });
    assert.equal(s.screen.class, "InterpretedScreen");
    assert.equal(s.screen.document, DOC);
    assert.equal(s.screen.detached, true);
    assert.equal(s.screen.document_problem, undefined, "the shipped example parses");
    byId = new Map(s.widgets.filter((w) => w.id).map((w) => [w.id, w]));
    const missing = [];
    for (const decl of opened.declared) {
      const [kind, id] = decl.split(":");
      if (kind === "slot" || kind === "slot_grid") continue; // the menu's, by design
      if (kind === "part" || kind === "repeat") continue;    // expanded at parse time; no widget
      const w = byId.get(id);
      if (!w) missing.push(decl);
      else assert.equal(w.kind, kind, `${id} is a ${kind}`);
    }
    assert.deepEqual(missing, [], "every declared widget is in the tree");
    // The two things a caller drives by: a button by label, a region by id.
    assert.equal(byId.get("launch").label, "Launch");
    assert.equal(byId.get("launch").class, "DeclaredButton");
    assert.equal(byId.get("gauge").kind, "region");
    assert.equal(byId.get("gauge").active, false, "a region takes no clicks");
    assert.equal(byId.get("footer").kind, "row", "a layout node is a nameable (inactive) widget");
  });

  test("the slots are the menu's, with the placeholders in them", async () => {
    const s = await call("get_screen", { detail: "layout" });
    assert.equal(s.menu.class, "DetachedMenu");
    assert.equal(s.menu.slot_count, 40);
    const items = new Map(s.menu.slots.filter((x) => x.item).map((x) => [x.index, x]));
    assert.equal(items.get(0)?.item, "minecraft:coal");
    assert.equal(items.get(0)?.count, 12);
    assert.equal(items.get(1)?.item, undefined,
      "output_slot declares an empty-slot ICON rather than a placeholder, so it is empty");
    // Slot geometry is the document's: fuel_slot at (14, 36), output_slot at (110, 36).
    const fuel = s.menu.slots.find((x) => x.index === 0);
    assert.equal(fuel.x, 14);
    assert.equal(fuel.y, 36);
  });

  test("geometry is the document's: absolute, layout-arranged, and nudged", async () => {
    const frame = byId.get("outer");
    const launch = byId.get("launch");
    assert.equal(launch.x, frame.x + 8, "the row starts at document x=8");
    assert.equal(launch.y, frame.y + 94, "the row starts at document y=94");
    assert.equal(launch.width, 50);
    assert.equal(launch.height, 20, "a button's default height is vanilla's 20");
    const ok = byId.get("ok");
    assert.equal(ok.x, launch.x + 50 + 4, "row spacing 4 between siblings");
    const noteA = byId.get("note_a");
    const noteB = byId.get("note_b");
    assert.equal(noteB.x, noteA.x + 2, "offset [2, 0] moves the child two pixels right of its column");
    assert.equal(noteB.y, noteA.y + 9 + 1, "column spacing 1 under a 9px line");
    const footer = byId.get("footer");
    assert.ok(footer.x <= launch.x && footer.x + footer.width >= ok.x + ok.width, "the row node spans its children");
    const blurb = byId.get("blurb");
    assert.equal(blurb.width, 140, "a wrapped label keeps its declared width");
    assert.ok(blurb.height >= 18 && blurb.height % 9 === 0,
      `a wrapped label is a whole number of 9px lines and more than one of them, got ${blurb.height}`);
    assert.ok(blurb.y + blurb.height <= byId.get("ticker").y, "and the example leaves room under it");
  });

  test("a button press is recorded as its declared action", async () => {
    const c = await call("click", { label: "Launch" });
    assert.equal(c.clicked, true, JSON.stringify(c));
    const s = await call("get_screen", {});
    assert.equal(s.screen.last_action, "launch");
  });

  test("check_layout reads the interpreted screen and finds the example clean", async () => {
    const r = await call("check_layout", {});
    assert.deepEqual(r.problems, [], JSON.stringify(r.problems));
  });

  test("an unregistered kind is refused by name with the registry", async () => {
    const path = fileURLToPath(new URL("./fixtures/ui-bad-kind.ui.json", import.meta.url));
    const err = await refused("open_screen", { ui_file: path });
    assert.match(err, /unknown kind 'gauge'/);
    assert.match(err, /registered kinds/);
    assert.match(err, /slot_grid/);
    assert.match(err, /region/);
    const s = await call("get_screen", {});
    assert.equal(s.screen.class, "InterpretedScreen", "the refusal left the previous preview open");
  });

  test("a missing document is refused with its resource path", async () => {
    const err = await refused("open_screen", { ui: "mcptoolkit:no_such_screen" });
    assert.match(err, /assets\/mcptoolkit\/ui\/no_such_screen\.ui\.json/);
  });
});
