// Keyboard, scroll and drag for the UI loop — RELEASE_1.md §D6's arbiter, live.
//
// Before this the screen surface was `click` and `set_text`, so a screen with a tab order, a
// scrolling list or a slider was half-drivable: you could press its buttons and you could not reach
// anything the wheel, a drag or the keyboard owns. `click` grows a drag and a wheel (the same target
// resolution, the same occlusion check, the same events); `send_keys` is the keyboard.
//
// Every case here asks something the boolean return value CANNOT answer, because in both new
// mechanisms the boolean lies in a different direction:
//
//   * A SCROLL AREA CONSUMES THE WHEEL AT EITHER END. `AbstractScrollArea.mouseScrolled` returns
//     true whenever the widget is visible and clamps inside `setScrollAmount`, so `handled:true`
//     is exactly as true at the bottom of a list as in the middle. A caller paging off `handled`
//     alone never stops. That is why the reply carries scrolled_from/scrolled_to.
//   * `Screen.keyPressed` RETURNS FALSE FOR TAB AND THE ARROWS EVEN WHEN FOCUS MOVED. It builds a
//     FocusNavigationEvent, changes focus, and falls out of the switch to `return false`
//     (Screen.java:122-153). So `handled:false` reads as nothing-happened for precisely the keys
//     this tool exists to send. That is why the reply carries focus_before/focus_after.
//
// SUBJECT: `DebugOptionsScreen`, chosen because it is the one vanilla screen that has all three
// shapes AND a no-arg constructor `open_screen` can reach — ~46 registered debug entries (an
// OptionList that overflows any window), a search EditBox with a responder, and a footer of plain
// buttons for the tab order. Nothing here CLICKS one of its toggles, so no debug setting changes.
//
// It stages no geometry, owns no site and touches no world: every act is on the client's own screen.
// It does drive the screen of whatever client is attached, which is why it lives outside
// conformance's client tier (that tier's rule is "declared, never called", and it is right) and
// wants a DEV client rather than a game someone is playing.
//
// Live probe: needs the dev game up WITH A CLIENT. Skips itself when either is missing.
// Run with `npm run test:live`, or sequentially via `tools/battery.ps1`.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const SESSION = "probe-ui-input";
const SCREEN = "net.minecraft.client.gui.screens.debug.DebugOptionsScreen";

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
/** The refusal text of a call that must fail. */
async function refused(tool, args) {
  const j = await raw(tool, args);
  assert.equal(j.ok, false, `${tool} ${JSON.stringify(args)} should have been refused: ${JSON.stringify(j.result)}`);
  return JSON.stringify(j.error);
}

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok)
  .catch(() => false);
let clientPresent = false;
if (bridgeUp) clientPresent = (await raw("ping", {})).result?.clientPresent === true;
if (!bridgeUp) {
  console.log(`\n  [skip] no bridge at ${BASE} — start the dev game to run these probes\n`);
} else if (!clientPresent) {
  console.log("\n  [skip] bridge is up but headless — these probes drive a SCREEN, so they need a client\n");
}

/** Re-open the subject screen if something (an escape case) closed it. */
async function ensureScreen() {
  const now = await call("get_screen", {});
  if (now.screen?.class !== "DebugOptionsScreen") await call("open_screen", { className: SCREEN });
  return call("get_screen", { detail: "layout" });
}
/** The first widget whose simple class name matches, with its geometry. */
function widget(screen, cls) {
  const w = screen.widgets.find((x) => x.class === cls);
  assert.ok(w, `no ${cls} on ${screen.screen.class}; widgets: ${screen.widgets.map((x) => x.class).join(", ")}`);
  return w;
}

describe("click grows a wheel and a drag; send_keys is the keyboard", { skip: !bridgeUp || !clientPresent }, () => {
  let list; // the OptionList's index + geometry
  let box;  // the search EditBox's index + geometry

  before(async () => {
    await call("open_screen", { className: SCREEN });
    const s = await call("get_screen", { detail: "layout" });
    list = widget(s, "OptionList");
    box = widget(s, "EditBox");
  });

  after(async () => {
    // Leave the client where it was found, near enough: this screen has no parent, so closing it
    // returns to the world or the title screen.
    const now = await call("get_screen", {}).catch(() => null);
    if (now?.screen?.class === "DebugOptionsScreen") await call("close_screen", {});
  });

  test("the subject really is a scroll area with somewhere to go", async () => {
    // If this fails, every scroll case below is measuring the wrong thing — a list that cannot
    // scroll reports at_top and at_end together and both clamp assertions pass vacuously.
    const r = await call("click", { index: list.index, scroll: 0 });
    assert.equal(r.scroll_area, true, JSON.stringify(r));
    assert.ok(r.max_scroll > 0, `the debug entry list does not overflow this window (max_scroll=${r.max_scroll})`);
  });

  test("a wheel notch moves the list, and the reply says how far", async () => {
    await call("click", { index: list.index, scroll: 99 }); // clamp to the top first
    const r = await call("click", { index: list.index, scroll: -3 });
    assert.equal(r.handled, true, JSON.stringify(r));
    assert.equal(r.scroll_area, true);
    assert.equal(r.scrolled_from, 0, JSON.stringify(r));
    assert.ok(r.scrolled_to > 0, `the list did not move: ${JSON.stringify(r)}`);
    assert.equal(r.at_top, false);
  });

  test("at the top the wheel is STILL consumed, and the reply is what says the list did not move",
    async () => {
    await call("click", { index: list.index, scroll: 99 });
    const r = await call("click", { index: list.index, scroll: 5 });
    // The whole point: handled and moved are different facts, and only one of them is in the return
    // value of vanilla's own method.
    assert.equal(r.handled, true, `a scroll area consumes the wheel at the top too: ${JSON.stringify(r)}`);
    assert.equal(r.scrolled_from, r.scrolled_to, JSON.stringify(r));
    assert.equal(r.at_top, true);
    assert.match(r.note, /already at the top/);
  });

  test("and the same at the end", async () => {
    await call("click", { index: list.index, scroll: -999 });
    const r = await call("click", { index: list.index, scroll: -5 });
    assert.equal(r.handled, true, JSON.stringify(r));
    assert.equal(r.scrolled_from, r.scrolled_to, JSON.stringify(r));
    assert.equal(r.at_end, true);
    assert.match(r.note, /already at the end/);
    await call("click", { index: list.index, scroll: 999 }); // back to the top for later cases
  });

  test("a wheel over something that is not a scroll area says so instead of guessing", async () => {
    const r = await call("click", { label: "Done", scroll: -3 });
    assert.equal(r.scroll_area, false, JSON.stringify(r));
    assert.equal(r.scrolled_from, null);
    assert.equal(r.scrolled_to, null);
    assert.match(r.note, /AbstractScrollArea|no scrollable widget/);
  });

  test("a wheel and a drag destination in one call is refused, not silently half-done", async () => {
    const err = await refused("click", { index: list.index, scroll: -1, to_x: 10, to_y: 10 });
    assert.match(err, /not both/);
  });

  test("send_keys with neither key nor text is refused", async () => {
    const err = await refused("send_keys", {});
    assert.match(err, /'key' and\/or 'text'/);
  });

  test("an unknown key name is refused BY NAME, with the spelling that would have worked", async () => {
    const err = await refused("send_keys", { key: "pgdn" });
    assert.match(err, /unknown key 'pgdn'/);
    assert.match(err, /page\.down/);
  });

  test("typed text reaches the focused edit box, character by character", async () => {
    await call("click", { index: box.index });
    const r = await call("send_keys", { text: "chunk" });
    assert.equal(r.typed.chars_sent, 5, JSON.stringify(r));
    assert.equal(r.typed.chars_consumed, 5, JSON.stringify(r));
    assert.equal(r.focus_before.class, "EditBox", JSON.stringify(r.focus_before));
    assert.equal(r.box_value_after, "chunk", JSON.stringify(r));
    assert.equal(r.screen_changed, false);
  });

  test("a drag across the box selects its text — which one backspace then proves", async () => {
    // The observable a drag needs and the reply cannot give generically. If the drag were a no-op
    // the cursor would still sit after "chunk" and one backspace would leave "chun"; it leaves ""
    // only if the press, the moves and the release all landed on the box as a selection gesture.
    const y = box.y + Math.floor(box.height / 2);
    const d = await call("click", { x: box.x + box.width - 3, y, to_x: box.x + 3, to_y: y, steps: 6 });
    assert.equal(d.pressed, true, JSON.stringify(d));
    assert.equal(d.dragged, true, JSON.stringify(d));
    assert.equal(d.steps, 6);

    const b = await call("send_keys", { key: "backspace" });
    assert.equal(b.box_value_before, "chunk", JSON.stringify(b));
    assert.equal(b.box_value_after, "", `one backspace deleted one character, so the drag selected nothing: ${JSON.stringify(b)}`);
  });

  test("a drag whose opening press lands on nothing reports a no-op instead of a success", async () => {
    // Vanilla forwards mouseDragged only while isDragging, which only a consumed press sets. A drag
    // from empty space is therefore GUARANTEED inert, and saying "dragged" would be the lie.
    const d = await call("click", { x: 1, y: 1, to_x: 60, to_y: 60 });
    assert.equal(d.pressed, false, JSON.stringify(d));
    assert.equal(d.dragged, false, JSON.stringify(d));
    assert.match(d.note, /never entered drag mode/);
  });

  test("Tab moves focus even though the screen answers handled:false — which is why focus is reported",
    async () => {
    await call("click", { index: box.index });
    const r = await call("send_keys", { key: "tab" });
    assert.equal(r.focus_before.class, "EditBox", JSON.stringify(r.focus_before));
    assert.equal(r.pressed.key, "key.keyboard.tab");
    assert.equal(r.pressed.presses.length, 1);
    // Both halves of the finding, asserted together so a future vanilla change breaks the right one.
    assert.equal(r.pressed.presses[0].handled, false,
      `Screen.keyPressed used to return false for Tab; if this is now true the note in UiTools.sendKeys is stale: ${JSON.stringify(r)}`);
    assert.notEqual(r.focus_after?.class, "EditBox",
      `focus did not move off the edit box: ${JSON.stringify(r.focus_after)}`);
  });

  test("typing at a widget that is not a text field is refused honestly, not counted as sent",
    async () => {
    // Focus is off the edit box from the Tab above.
    const r = await call("send_keys", { text: "x" });
    assert.equal(r.typed.chars_sent, 1, JSON.stringify(r));
    assert.equal(r.typed.chars_consumed, 0, JSON.stringify(r));
    assert.ok(r.typed.note, `a refusal with no reason is the shrug this tool exists to avoid: ${JSON.stringify(r)}`);
  });

  test("modifiers ride the EVENT, so ctrl+a selects and one backspace clears the box", async () => {
    // 26.2 reads modifiers off InputWithModifiers rather than the real keyboard, which is what makes
    // a synthetic ctrl+a possible at all. Same proof as the drag: the box empties in one backspace.
    await ensureScreen();
    await call("click", { index: box.index });
    await call("send_keys", { text: "biome" });
    const sel = await call("send_keys", { key: "a", modifiers: ["ctrl"] });
    assert.equal(sel.pressed.modifiers, 2, JSON.stringify(sel.pressed));
    const b = await call("send_keys", { key: "backspace" });
    assert.equal(b.box_value_before, "biome", JSON.stringify(b));
    assert.equal(b.box_value_after, "", `ctrl+a did not select the line: ${JSON.stringify(b)}`);
  });

  test("Escape closes the screen, and a repeat stops there rather than typing into what appeared",
    async () => {
    await ensureScreen();
    const r = await call("send_keys", { key: "escape", times: 3 });
    assert.equal(r.screen_was, "DebugOptionsScreen");
    assert.equal(r.screen_changed, true, JSON.stringify(r));
    assert.notEqual(r.now_open, "DebugOptionsScreen");
    assert.equal(r.pressed.presses.length, 1, `the remaining presses went somewhere: ${JSON.stringify(r)}`);
    assert.equal(r.pressed.presses[0].closed_or_replaced, true, JSON.stringify(r));
    assert.equal(r.stopped_early, true, JSON.stringify(r));
  });
});
