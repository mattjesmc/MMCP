// Screen authoring, slice 3 (mcp-toolkit/docs/screens/SCREEN_AUTHORING_DESIGN.md section 12): THE CONFORMANCE
// BATTERY - assert INTERPRETED == GENERATED, enumerated from the element registry, with its falsifier.
//
// Two renderers, one truth: the dev client shows the interpreted document, players see the generated
// Java. ui-emit.test.mjs (slice 2) compares the two whole. This file is the spine the design asked
// for, written as checks that can each go red by name:
//   * the REGISTRY is read off the running game (open_screen's `kinds.registered`), and the compared
//     document uses every kind in it - so a kind added to Kind.java without an element in the example
//     fails here, live, not only in the unit test that pins the same claim;
//   * GEOMETRY, per kind: for every registered kind, the widgets of that kind (or the slots, for the
//     slot family) are identical on both renderers - level 1, and the failure names the kind;
//     a MACRO (`part`, `repeat`) draws nothing of its own, so its case asserts that the document
//     uses one and that what it EXPANDED to is among the widgets compared above - which is the
//     honest half of "a part that expands into registered kinds is covered for free"
//     (UI_PARTS_LIBRARY_DESIGN.md section 6);
//   * PIXELS: a screenshot of each, cropped to the panel, is identical - level 2, which catches paint
//     differences geometry cannot see. The one animated element (a `scrolling` label breathes on
//     Util.getMillis) is masked, and the mask is enumerated from the document, not hand-kept;
//   * the FALSIFIER, twice: open the generated screen deliberately corrupted (open_screen `falsify`)
//     and the comparison MUST go red. "geometry" (a button 1px right) must be caught by level 1 AND
//     level 2; "paint" (the button's alpha halved) leaves the widget tree IDENTICAL and must be caught
//     by level 2 alone - the proof that the pixel level is load-bearing rather than decorative;
//   * a plain generated open disarms the falsifier, and `falsify` without `generated` is refused.
//
// The emitter-level falsifier - corrupt UiEmitter itself, regenerate, rebuild, watch this file go
// red - is a rebuild cycle, so it is run by hand and recorded in the design's section 19;
// UiEmitterTest.aOnePixelChangeInTheDocumentReachesTheLayoutFileAndNothingElse is its unit half.
//
// Needs the client IN A SINGLEPLAYER WORLD with a visible window (the framebuffer is the instrument).
// Puts the player in creative (a spectator's clicks are dropped; see ui-emit). Live probe: skips
// itself otherwise. Run with `npm run test:live`, or via `tools/battery.ps1` (chunk b) - SEQUENTIALLY:
// a concurrent probe that opens a screen closes this one.

import { test, describe, before, after } from "node:test";
import { available as windowAvailable, gameWindow } from "./fixtures/game-window.mjs";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const SESSION = "probe-ui-conform";
const DOC = "mcptoolkit:example";
const DOC_FILE = fileURLToPath(new URL("../../mcp-toolkit/src/main/resources/assets/mcptoolkit/ui/example.ui.json", import.meta.url));

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

/**
 * The tree, once it has STOPPED MOVING.
 *
 * <p>Found live (parts library, 2026-09-04). A `visible`/`enabled` predicate reads a synced int, and
 * on the client `synced[]` starts at zero: the first `ClientboundContainerSetDataPacket` lands later
 * and `AbstractContainerMenu.setData` notifies no listeners on the client, so nothing announces its
 * arrival. Both renderers re-evaluate every predicate per FRAME - but `get_screen` reads the widget
 * tree directly and can land between the packet and the next frame. A comparison of two renderers
 * across a wire therefore waits for the tree to settle; the detached interpreter needs no wire and is
 * right from its first frame, which is exactly why the two disagreed.
 */
async function waitForScreen(cls, ms = 5000) {
  const until = Date.now() + ms;
  let last;
  let previous = null;
  while (Date.now() < until) {
    const now = await call("get_screen", { detail: "layout" });
    if (now.screen?.class === cls) {
      last = now;
      const shape = JSON.stringify(now.widgets.map((w) => [w.id, w.x, w.y, w.width, w.height, w.active, w.visible]));
      if (shape === previous) return now;
      previous = shape;
    }
    await sleep(100);
  }
  if (last) return last;
  throw new Error(`screen ${cls} did not open; last: ${JSON.stringify(last?.screen)}`);
}

// ---- the comparable shapes ---------------------------------------------------------------------

function originOf(s) {
  const outer = s.widgets.find((w) => w.id === "outer");
  assert.ok(outer, "the example's frame is the widget 'outer'");
  return { x: outer.x, y: outer.y, width: outer.width, height: outer.height };
}
/** Declared widgets of one kind, window offset removed. */
function ofKind(s, kind, origin) {
  return s.widgets
    .filter((w) => w.kind === kind)
    .map((w) => ({
      id: w.id ?? null, kind: w.kind, label: w.label,
      x: w.x - origin.x, y: w.y - origin.y, width: w.width, height: w.height, active: w.active,
    }));
}
function allDeclared(s, origin) {
  return s.widgets.filter((w) => w.kind).map((w) => ofKind(s, w.kind, origin).find((x) => x.id === (w.id ?? null)));
}
function slotGeometry(s) {
  return s.menu.slots.map((x) => ({ index: x.index, x: x.x, y: x.y }));
}

// ---- a PNG decoder, enough for what NativeImage.writeToFile emits ------------------------------
// 8-bit RGB/RGBA, non-interlaced, the five scanline filters. Kept here so the probe depends on the
// same nothing every other probe depends on.

function decodePng(bytes) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) assert.equal(bytes[i], sig[i], "PNG signature");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8;
  let width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (pos < bytes.length) {
    const len = dv.getUint32(pos);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = dv.getUint32(pos + 8); height = dv.getUint32(pos + 12);
      depth = bytes[pos + 16]; colorType = bytes[pos + 17]; interlace = bytes[pos + 20];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  assert.equal(depth, 8, "8-bit PNG");
  assert.equal(interlace, 0, "non-interlaced PNG");
  const channels = { 2: 3, 6: 4, 0: 1, 4: 2 }[colorType];
  assert.ok(channels, `colour type ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(height * stride);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let x = line[i];
      switch (filter) {
        case 0: break;
        case 1: x += a; break;
        case 2: x += b; break;
        case 3: x += (a + b) >> 1; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          x += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default: throw new Error(`PNG filter ${filter}`);
      }
      cur[i] = x & 0xff;
    }
    out.set(cur, y * stride);
    prev = cur;
  }
  return { width, height, channels, data: out };
}

/** Count RGB-differing pixels inside `rect` (pixels), skipping `masks`; report the bounding box. */
function diffPixels(a, b, rect, masks) {
  assert.equal(a.width, b.width, "same framebuffer width");
  assert.equal(a.height, b.height, "same framebuffer height");
  const inMask = (x, y) => masks.some((m) => x >= m.x && x < m.x + m.w && y >= m.y && y < m.y + m.h);
  let count = 0;
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      if (inMask(x, y)) continue;
      const ia = (y * a.width + x) * a.channels;
      const ib = (y * b.width + x) * b.channels;
      if (a.data[ia] !== b.data[ib] || a.data[ia + 1] !== b.data[ib + 1] || a.data[ia + 2] !== b.data[ib + 2]) {
        count++;
        if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y;
      }
    }
  }
  return { count, bbox: count ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null };
}

/** The whole picture of one renderer: its tree, its screenshot, and the scale between them. */
async function capture(cls) {
  const s = await waitForScreen(cls);
  const shot = await call("screenshot", {});
  const png = decodePng(Buffer.from(shot._image.base64, "base64"));
  const scale = Math.round(png.width / s.screen.width);
  assert.ok(scale >= 1 && Math.abs(png.width / s.screen.width - scale) < 0.02,
    `the framebuffer is an integer multiple of the GUI: ${png.width}px over ${s.screen.width} scaled`);
  return { s, png, scale, base64: shot._image.base64 };
}
const px = (r, scale) => ({ x: r.x * scale, y: r.y * scale, w: (r.width ?? r.w) * scale, h: (r.height ?? r.h) * scale });

function dump(tag, ...caps) {
  const paths = caps.map((c, i) => {
    const p = join(tmpdir(), `mcptk-ui-conform-${tag}-${i}.png`);
    writeFileSync(p, Buffer.from(c.base64, "base64"));
    return p;
  });
  return paths.join(" , ");
}

// ---- preconditions ---------------------------------------------------------------------------

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
else if (!clientPresent) console.log("\n  [skip] bridge is up but headless - the conformance battery photographs a SCREEN, so it needs a client\n");
else if (!inWorld) console.log("\n  [skip] the client is not in a world - the generated menu opens through the integrated server\n");

describe("screen authoring slice 3: the conformance battery", { skip: !bridgeUp || !clientPresent || !inWorld }, () => {
  let registry;      // open_screen's kinds.registered, off the running game
  let used;          // kinds.used, the example's
  let interp;        // capture() of the interpreted preview
  let gen;           // capture() of the generated screen
  let panel;         // the panel rect in GUI coords, from the interpreted origin
  let masks;         // animated rects in GUI coords, from the DOCUMENT

  before(async () => {
    await call("run_command", { command: "gamemode creative @a" });
    const opened = await call("open_screen", { ui: DOC });
    registry = opened.kinds.registered;
    used = opened.kinds.used;
    interp = await capture("InterpretedScreen");
    panel = originOf(interp.s);
    // The mask is what the document says animates, not what a human noticed: every `scrolling`
    // label, located by id on the screen. A new animated kind would need a line here, and this is
    // the line.
    const doc = JSON.parse(readFileSync(DOC_FILE, "utf8"));
    const animated = [];
    const walk = (els) => els.forEach((e) => { if (e.mode === "scrolling") animated.push(e.id); if (e.children) walk(e.children); });
    walk(doc.elements);
    masks = animated.map((id) => {
      const w = interp.s.widgets.find((x) => x.id === id);
      assert.ok(w, `animated element ${id} is a widget`);
      return { id, x: w.x, y: w.y, w: w.width, h: w.height };
    });
    await raw("close_screen", {});
    await sleep(150);
  });
  after(async () => {
    await raw("close_screen", {});
  });

  test("the registry is read off the running game, and the compared document uses all of it", () => {
    assert.ok(Array.isArray(registry) && registry.length >= 16, `a registry of kinds: ${JSON.stringify(registry)}`);
    for (const k of registry) assert.ok(k.name && k.family, `kind ${JSON.stringify(k)} has a name and a family`);
    const names = registry.map((k) => k.name).sort();
    assert.deepEqual([...used].sort(), names,
      "every registered kind has an element in the example - a kind without one has no conformance case");
  });

  test("the generated screen opens, and both renderers show the same panel at the same place", async () => {
    await call("open_screen", { ui: DOC, generated: true });
    gen = await capture("ExampleScreen");
    assert.equal(gen.s.screen.generated, true);
    assert.equal(gen.s.screen.falsified, undefined, "nothing is corrupted on a plain open");
    assert.deepEqual(originOf(gen.s), panel, "same window, same size, same panel origin");
    assert.equal(gen.scale, interp.scale);
  });

  test("GEOMETRY, enumerated: every registered kind is identical on both renderers (level 1)", () => {
    const io = originOf(interp.s);
    const go = originOf(gen.s);
    const misses = [];
    const differing = [];   // every kind that differs, not just the first: a red run names them all
    let firstDiff;
    const same = (k, a, b) => {
      try {
        assert.deepEqual(b, a);
      } catch (e) {
        differing.push(k.name);
        firstDiff ??= `${k.name} (${k.family}): ${e.message}`;
      }
    };
    for (const k of registry) {
      switch (k.family) {
        case "box":
        case "leaf":
        case "layout": {
          const a = ofKind(interp.s, k.name, io);
          const b = ofKind(gen.s, k.name, go);
          if (a.length === 0) misses.push(`${k.name}: no interpreted widget`);
          same(k, a, b);
          break;
        }
        case "slot": {
          // A slot is not a widget; it is the menu's. Compared as geometry here (contents in ui-emit).
          const a = slotGeometry(interp.s);
          const b = slotGeometry(gen.s);
          if (a.length === 0) misses.push(`${k.name}: no slots`);
          same(k, a, b);
          break;
        }
        case "macro": {
          // A part and a repeat are expanded at parse time: neither renderer has a widget for them,
          // so there is nothing to compare directly. What CAN be asserted is that the document
          // exercises one and that its expansion reached both trees - the ids a macro produces are
          // namespaced (<instance>.<inner>), so their presence is proof the substitution ran on
          // both sides and produced the same names.
          assert.ok(used.includes(k.name), `the example uses a ${k.name}`);
          const namespaced = (s) => s.widgets.filter((w) => w.id && w.id.includes(".")).map((w) => w.id).sort();
          const ai = namespaced(interp.s);
          const bi = namespaced(gen.s);
          if (ai.length === 0) misses.push(`${k.name}: nothing expanded`);
          same(k, ai, bi);
          break;
        }
        case "spacer": {
          // A spacer has no widget of its own; its whole effect is where its layout siblings land,
          // and those are compared under their own kinds. What this case can assert is that the
          // document exercises one inside a layout that is itself compared.
          assert.ok(used.includes(k.name), "the example places a spacer");
          assert.ok(ofKind(interp.s, "row", io).length > 0, "inside a compared layout node");
          break;
        }
        default:
          misses.push(`${k.name}: family ${k.family} has no comparison here - add one`);
      }
    }
    assert.deepEqual(misses, [], "every kind has a case, and every case has a subject");
    assert.deepEqual(differing, [], `kinds that differ between renderers: ${differing.join(", ")}; first: ${firstDiff}`);
    assert.deepEqual(allDeclared(gen.s, go), allDeclared(interp.s, io), "and the whole tree, for good measure");
  });

  test("PIXELS: the panel is identical on both renderers, animated elements masked (level 2)", (t) => {
    const rect = px(panel, interp.scale);
    const m = masks.map((r) => px(r, interp.scale));
    assert.ok(rect.w > 100 && rect.h > 100, `a panel worth comparing: ${JSON.stringify(rect)}`);
    // The boring case must be boring for a reason: a comparison of two blank crops is also zero.
    // The crop has to contain a screen - many colours, and the container grey among them.
    const colours = new Set();
    for (let y = rect.y; y < rect.y + rect.h; y += 3) {
      for (let x = rect.x; x < rect.x + rect.w; x += 3) {
        const i = (y * interp.png.width + x) * interp.png.channels;
        colours.add((interp.png.data[i] << 16) | (interp.png.data[i + 1] << 8) | interp.png.data[i + 2]);
      }
    }
    assert.ok(colours.size >= 32, `the interpreted crop is a rendered screen, not a blank: ${colours.size} colours`);
    assert.ok(colours.has(0xC6C6C6), "vanilla's container grey is in it");
    const d = diffPixels(interp.png, gen.png, rect, m);
    t.diagnostic(`scale ${interp.scale}, framebuffer ${interp.png.width}x${interp.png.height}, panel ${JSON.stringify(rect)},`
      + ` ${colours.size} colours sampled, masks ${JSON.stringify(m)}, differing ${d.count}`);
    assert.equal(d.count, 0,
      `${d.count} differing pixel(s) in the panel, bbox ${JSON.stringify(d.bbox)} (px; panel at ${JSON.stringify(rect)},`
      + ` masked ${JSON.stringify(masks.map((x) => x.id))}); frames: ${dump("pixels", interp, gen)}`);
    // The mask is not hiding the comparison: it is a sliver of the panel.
    const masked = m.reduce((n, r) => n + r.w * r.h, 0);
    assert.ok(masked < rect.w * rect.h * 0.05, `the mask covers ${masked} of ${rect.w * rect.h} pixels`);
  });

  // ---- the tooltip half (UI_PARTS_LIBRARY_DESIGN.md 3.2, 7.10) --------------------------------
  // A tooltip is drawn by the SCREEN from the render call's mouse coordinates, on both renderers
  // (Paint.tooltips), so it can only be compared with the pointer over a zone - which is what
  // `click {hover:true}` moves (nothing else in the toolkit could; a programmatic click carries its
  // own coordinates). The example has one zone of each kind. `launch` carries STATIC text and is
  // inactive (`enabled: progress`, and progress is 0), so the pointer changes nothing but the
  // tooltip; `ok` carries a HOOK, which the interpreter cannot evaluate and the sample's stub
  // answers with nothing, so the renderers must agree on drawing NO tooltip while the button's own
  // hover face may still change. Each is measured against the un-hovered frame first: a comparison
  // of two frames that both forgot the pointer would otherwise pass for the wrong reason.
  const park = async () => { await call("click", { x: 0, y: 0, hover: true }); await sleep(150); };
  async function hoveredPair(id) {
    const at = (s) => {
      const w = s.widgets.find((x) => x.id === id);
      assert.ok(w, `${id} is a widget on ${s.screen.class}`);
      return { x: w.x + w.width / 2, y: w.y + w.height / 2, rect: { x: w.x, y: w.y, w: w.width, h: w.height } };
    };
    await raw("close_screen", {});
    await sleep(150);
    await call("open_screen", { ui: DOC });
    await park();
    const i = await capture("InterpretedScreen");
    const ip = at(i.s);
    const moved = await call("click", { x: ip.x, y: ip.y, hover: true });
    assert.equal(moved.hovered, true, `hover replied: ${JSON.stringify(moved)}`);
    await sleep(150);
    const ih = await capture("InterpretedScreen");
    await raw("close_screen", {});
    await sleep(150);
    await call("open_screen", { ui: DOC, generated: true });
    await park();
    const g = await capture("ExampleScreen");
    const gp = at(g.s);
    assert.deepEqual([gp.x, gp.y], [ip.x, ip.y], `${id} sits at the same point on both renderers`);
    await call("click", { x: gp.x, y: gp.y, hover: true });
    await sleep(150);
    const gh = await capture("ExampleScreen");
    return { i, ih, g, gh, rect: ip.rect };
  }
  const inside = (bbox, r) => bbox.x >= r.x && bbox.y >= r.y
    && bbox.x + bbox.w <= r.x + r.w && bbox.y + bbox.h <= r.y + r.h;

  test("TOOLTIP static: with the pointer over `launch` a tooltip appears, and identically on both renderers", async (t) => {
    const { i, ih, g, gh, rect } = await hoveredPair("launch");
    const scale = i.scale;
    const p = px(panel, scale);
    const m = masks.map((r) => px(r, scale));
    const button = px(rect, scale);
    // The pointer did something on the interpreter: pixels changed, and not only inside the
    // button (an inactive button has no hover face, so what changed is the tooltip beside it).
    const shown = diffPixels(i.png, ih.png, p, m);
    t.diagnostic(`launch at ${JSON.stringify(button)}, tooltip diff ${shown.count} px, bbox ${JSON.stringify(shown.bbox)}`);
    assert.ok(shown.count > 50, `hovering launch drew something on the interpreter: ${shown.count} px; frames: ${dump("tip-interp", i, ih)}`);
    assert.ok(!inside(shown.bbox, button), `what appeared is beside the button, not a hover face: bbox ${JSON.stringify(shown.bbox)} inside ${JSON.stringify(button)}`);
    assert.ok(shown.count < p.w * p.h * 0.1, `a tooltip is small: ${shown.count} of ${p.w * p.h}`);
    // And the generated screen drew the same thing at the same place.
    const drawn = diffPixels(g.png, gh.png, p, m);
    assert.ok(drawn.count > 50, `hovering launch drew something on the generated screen too: ${drawn.count} px; frames: ${dump("tip-gen", g, gh)}`);
    const d = diffPixels(ih.png, gh.png, p, m);
    assert.equal(d.count, 0, `${d.count} differing pixel(s) with the pointer over launch, bbox ${JSON.stringify(d.bbox)}; frames: ${dump("tip", ih, gh)}`);
  });

  test("TOOLTIP hook: with the pointer over `ok` neither renderer draws one, and they agree", async (t) => {
    const { i, ih, gh, rect } = await hoveredPair("ok");
    const scale = i.scale;
    const p = px(panel, scale);
    const m = masks.map((r) => px(r, scale));
    const button = px(rect, scale);
    // Whatever the pointer changed stays within the button (its hover face); a tooltip would
    // have spilled out beside it.
    const changed = diffPixels(i.png, ih.png, p, m);
    t.diagnostic(`ok at ${JSON.stringify(button)}, hover diff ${changed.count} px, bbox ${JSON.stringify(changed.bbox)}`);
    assert.ok(changed.count === 0 || inside(changed.bbox, button),
      `the hook draws nothing beside the button on the interpreter: bbox ${JSON.stringify(changed.bbox)} vs ${JSON.stringify(button)}; frames: ${dump("hook-interp", i, ih)}`);
    const d = diffPixels(ih.png, gh.png, p, m);
    assert.equal(d.count, 0, `${d.count} differing pixel(s) with the pointer over ok, bbox ${JSON.stringify(d.bbox)}; frames: ${dump("hook", ih, gh)}`);
    // Leave the pointer where the cases below expect nothing under it.
    await park();
  });

  // The 2026-09-07 battery's one REAL minimized-window red (RELEASE.md 2.6): with the window
  // iconic GLFW reports it 0x0, MouseHandler.getScaledXPos divides by that, and every screen
  // renders with its pointer at infinity - so the tooltip under a hover never appeared while
  // `render` and `screenshot` went on working. ScreenSpaceMixin falls back to the framebuffer
  // size in exactly that case. This minimizes the real window ONCE, hovers, captures, and puts the
  // window back in a finally: restoring activates it, which is a flick on the human's screen, and
  // the whole point of the fix is that the tools never need to do that themselves.
  test("TOOLTIP minimized: with the window iconic the pointer still lands and the tooltip still draws",
    { skip: !windowAvailable || !gameWindow("state").found }, async (t) => {
    await raw("close_screen", {});
    await sleep(150);
    await call("open_screen", { ui: DOC });
    await park();
    const i = await capture("InterpretedScreen");
    const w = i.s.widgets.find((x) => x.id === "launch");
    assert.ok(w, "launch is a widget on the interpreter");
    const button = px({ x: w.x, y: w.y, w: w.width, h: w.height }, i.scale);
    let ih;
    const was = gameWindow("minimize");
    try {
      assert.equal(was.iconic, true, "the window did not minimize; nothing below measures anything");
      const moved = await call("click", { x: w.x + w.width / 2, y: w.y + w.height / 2, hover: true });
      assert.equal(moved.hovered, true, JSON.stringify(moved));
      await sleep(300); // iconified, the client renders at 10 fps
      ih = await capture("InterpretedScreen");
    } finally {
      const back = gameWindow("restore");
      assert.equal(back.iconic, false, "the window did not come back; the cases after this one need it");
    }
    const shown = diffPixels(i.png, ih.png, px(panel, i.scale), masks.map((r) => px(r, i.scale)));
    t.diagnostic(`minimized: tooltip diff ${shown.count} px, bbox ${JSON.stringify(shown.bbox)}`);
    assert.ok(shown.count > 50, `hovering launch on an iconified window drew nothing: ${shown.count} px; frames: ${dump("tip-min", i, ih)}`);
    assert.ok(!inside(shown.bbox, button), `what appeared is beside the button: bbox ${JSON.stringify(shown.bbox)} inside ${JSON.stringify(button)}`);
    await park();
  });

  test("FALSIFIER geometry: a button moved 1px is caught by level 1 AND level 2", async (t) => {
    await raw("close_screen", {});
    await sleep(150);
    const r = await call("open_screen", { ui: DOC, generated: true, falsify: "geometry" });
    assert.equal(r.falsify, "geometry");
    const bad = await capture("ExampleScreen");
    assert.equal(bad.s.screen.falsified?.mode, "geometry", "get_screen says the screen is corrupted");
    assert.equal(bad.s.screen.falsified?.widget, "launch");
    const io = originOf(interp.s);
    const bo = originOf(bad.s);
    const a = ofKind(interp.s, "button", io);
    const b = ofKind(bad.s, "button", bo);
    assert.notDeepEqual(b, a, "level 1 sees the corruption");
    const launchA = a.find((w) => w.id === "launch");
    const launchB = b.find((w) => w.id === "launch");
    assert.equal(launchB.x, launchA.x + 1, "and it is exactly the one pixel");
    assert.deepEqual(b.filter((w) => w.id !== "launch"), a.filter((w) => w.id !== "launch"), "nothing else moved");
    const d = diffPixels(interp.png, bad.png, px(panel, interp.scale), masks.map((x) => px(x, interp.scale)));
    t.diagnostic(`geometry falsifier: launch x ${launchA.x} -> ${launchB.x}, differing ${d.count} px, bbox ${JSON.stringify(d.bbox)}`);
    assert.ok(d.count > 0, "level 2 sees it too");
  });

  test("FALSIFIER paint: alpha halved leaves the tree IDENTICAL and is caught by level 2 alone", async (t) => {
    await raw("close_screen", {});
    await sleep(150);
    await call("open_screen", { ui: DOC, generated: true, falsify: "paint" });
    const bad = await capture("ExampleScreen");
    assert.equal(bad.s.screen.falsified?.mode, "paint");
    const io = originOf(interp.s);
    const bo = originOf(bad.s);
    assert.deepEqual(allDeclared(bad.s, bo), allDeclared(interp.s, io),
      "level 1 is blind to a paint-only corruption BY CONSTRUCTION - this is why level 2 exists");
    const scale = interp.scale;
    const d = diffPixels(interp.png, bad.png, px(panel, scale), masks.map((x) => px(x, scale)));
    t.diagnostic(`paint falsifier: differing ${d.count} px, bbox ${JSON.stringify(d.bbox)}`);
    assert.ok(d.count > 0, `level 2 catches it; frames: ${d.count ? "" : dump("paint", interp, bad)}`);
    // And the difference is WHERE the corruption is: inside the falsified button's rectangle.
    const launch = bad.s.widgets.find((w) => w.id === "launch");
    const box = px(launch, scale);
    assert.ok(d.bbox.x >= box.x && d.bbox.y >= box.y && d.bbox.x + d.bbox.w <= box.x + box.w && d.bbox.y + d.bbox.h <= box.y + box.h,
      `the diff ${JSON.stringify(d.bbox)} lies inside the button ${JSON.stringify(box)}`);
  });

  test("a plain generated open disarms the falsifier; falsify without generated is refused", async () => {
    await raw("close_screen", {});
    await sleep(150);
    await call("open_screen", { ui: DOC, generated: true });
    const clean = await waitForScreen("ExampleScreen");
    assert.equal(clean.screen.falsified, undefined, "no corruption carried over");
    const j = await raw("open_screen", { ui: DOC, falsify: "paint" });
    assert.equal(j.ok, false, "falsify corrupts the GENERATED screen only");
    const k = await raw("open_screen", { ui: DOC, generated: true, falsify: "sideways" });
    assert.equal(k.ok, false, "an unknown falsification is refused by name");
  });
});
