// Screen authoring, slice 2 (mcp-toolkit/docs/screens/SCREEN_AUTHORING_DESIGN.md sections 7, 8, 12): the emitter,
// live - and the FIRST interpreted-vs-generated comparison.
//
// The subject is the toolkit's own sample: assets/mcptoolkit/ui/example.ui.json, which uses every
// registered kind, compiled by the emitter into ui/sample (UiEmitterTest pins those files to today's
// emitter output, so this is never a comparison against stale Java) and registered like a mod would.
//
// What slice 2 promised, each as a case that can go red:
//   * the generated screen opens through the SERVER's real menu (open_screen ui + generated:true),
//     as the registered ExampleScreen;
//   * GEOMETRY: get_screen on the generated screen and on the interpreted preview produce the same
//     declared-widget tree - id, kind, rect, label, active - and the same slot list (index,
//     container position, item). This is section 12 level 1;
//   * the bindings survive the 16-bit wire: get_screen reads the same values off both menus (the
//     example itself carried an un-wide 42000 until this comparison caught it);
//   * an action rides vanilla's button channel end to end: click Launch on the generated screen and
//     the SERVER menu records "launch";
//   * check_layout finds the generated screen as clean as the interpreted one.
//
// NOT here yet (slice 3): the pixel comparison, the battery enumerated from the registry with its
// falsifier. The geometry half is what this file makes routine.
//
// Needs the client IN A SINGLEPLAYER WORLD: the generated menu opens through the integrated server.
// Puts the player in creative: a spectator's button clicks are dropped server-side (see before()).
// Live probe: skips itself otherwise. Run with `npm run test:live`, or via `tools/battery.ps1`.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const SESSION = "probe-ui-emit";
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll get_screen until the named screen class is up (the generated one opens through a packet). */
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

/** The comparable shape of a declared-widget tree: everything but the window offset. */
function tree(s, origin) {
  return s.widgets
    .filter((w) => w.kind)
    .map((w) => ({
      id: w.id ?? null, kind: w.kind, label: w.label,
      x: w.x - origin.x, y: w.y - origin.y, width: w.width, height: w.height, active: w.active,
    }));
}
function slots(s) {
  return s.menu.slots.map((x) => ({ index: x.index, x: x.x, y: x.y, item: x.item ?? null, count: x.count ?? 0 }));
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
else if (!clientPresent) console.log("\n  [skip] bridge is up but headless - these probes open a SCREEN, so they need a client\n");
else if (!inWorld) console.log("\n  [skip] the client is not in a world - the generated menu opens through the integrated server\n");

describe("screen authoring slice 2: the emitter, interpreted vs generated", { skip: !bridgeUp || !clientPresent || !inWorld }, () => {
  let interpreted;
  let generated;

  before(async () => {
    // Vanilla's handleContainerButtonClick drops a SPECTATOR's button clicks silently while still
    // syncing its data slots - the first live run had the dev player spectating and lost only the
    // action case. A probe about the button channel needs a player the channel accepts.
    await call("run_command", { command: "gamemode creative @a" });
    await call("open_screen", { ui: DOC });
    interpreted = await call("get_screen", { detail: "layout" });
    await raw("close_screen", {});
    await sleep(150);
  });
  after(async () => {
    await raw("close_screen", {});
  });

  test("the generated screen opens through the server as the registered screen class", async () => {
    const r = await call("open_screen", { ui: DOC, generated: true });
    assert.equal(r.opening, "ExampleScreen");
    assert.equal(r.generated, true);
    generated = await settledScreen("ExampleScreen");
    assert.equal(generated.screen.document, DOC, "get_screen names the document behind a generated screen");
    assert.equal(generated.screen.generated, true);
    assert.equal(generated.screen.title, interpreted.screen.title, "the title is the document's on both");
  });

  test("GEOMETRY: the declared-widget tree is identical on both renderers (section 12, level 1)", () => {
    const originOf = (s) => {
      const outer = s.widgets.find((w) => w.id === "outer");
      return { x: outer.x, y: outer.y };
    };
    const a = tree(interpreted, originOf(interpreted));
    const b = tree(generated, originOf(generated));
    assert.ok(a.length > 20, `the example declares many widgets, got ${a.length}`);
    assert.deepEqual(b, a);
  });

  test("the slot list is identical: same indices, same positions, same placeholders", () => {
    assert.equal(generated.menu.class, "ExampleMenu", "the real menu, not a DetachedMenu");
    assert.equal(generated.menu.slot_count, 40,
      "two written out, two from the station_inputs part, and the 36 player slots");
    // The player's own slots hold whatever the player holds on the generated side and a COPY on the
    // interpreted side; compare geometry for all, contents for the declared container only.
    const gs = slots(generated);
    const is = slots(interpreted);
    assert.deepEqual(gs.map(({ index, x, y }) => ({ index, x, y })), is.map(({ index, x, y }) => ({ index, x, y })));
    assert.deepEqual(gs.slice(0, 4), is.slice(0, 4), "the placeholders are the document's on both sides");
    assert.equal(gs[0].item, "minecraft:coal");
  });

  test("bindings survive the 16-bit wire: both menus answer the document's preview values", async () => {
    // fuel 42000 and fuel_max 100000 both exceed a short. The interpreter never crosses the wire, so
    // it cannot show the wrap; the generated menu's values went through ClientboundContainerSetData
    // as shorts and came back through the emitted reassembly. The FIRST live run found the example
    // itself had `fuel` un-wide: 42% on the preview, an empty gauge on the generated screen.
    const s = await call("get_screen", {});
    assert.equal(s.screen.class, "ExampleScreen");
    assert.deepEqual(s.screen.bindings, interpreted.screen.bindings, "same values on both renderers");
    assert.equal(s.screen.bindings.fuel, 42000);
    assert.equal(s.screen.bindings.fuel_max, 100000);
    assert.equal(s.screen.bindings.progress, 130);
  });

  test("an action rides vanilla's button channel: Launch reaches the SERVER menu", async () => {
    const c = await call("click", { label: "Launch" });
    assert.equal(c.clicked, true, JSON.stringify(c));
    let seen;
    for (let i = 0; i < 20 && !seen; i++) {
      await sleep(100);
      const s = await call("get_screen", {});
      if (s.screen.last_action === "launch") seen = s;
    }
    assert.ok(seen, "the server-side ExampleMenu.onLaunch recorded the action");
  });

  test("check_layout reads the generated screen and finds it as clean as the preview", async () => {
    const r = await call("check_layout", {});
    assert.deepEqual(r.problems, [], JSON.stringify(r.problems));
  });
});
