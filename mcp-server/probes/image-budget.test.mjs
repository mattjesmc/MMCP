// The image budget (LOOP_KIT_DESIGN.md §5.1, step 1's arbiter): a 3840x2131 frame in, at most 512
// on the longest edge out, the content box found on an alpha frame AND on a flat-ground frame,
// MCPTK_SHOT_MAX=0 byte-identical, a cost line on every picture, and `crop` by rectangle and by
// widget scaled through the GUI scale. Also the Blockbench upstream's picture, because that is the
// one ArmorPieces paid for nine sessions running.
//
// No game: the frames are synthesised here and served by a stub bridge; the REAL shim does the
// shrinking. Run: node --test probes/image-budget.test.mjs

import { test } from "node:test";
import assert from "node:assert";
import { encodePng, decodePng } from "../image/png.mjs";
import { apiTokens } from "../image/budget.mjs";
import { startStubBridge, startStubBlockbench, spawnShim, tool, textOf, imageOf } from "./loop-harness.mjs";

const W = 3840, H = 2131;
// A dev client's frame: flat sky, one figure. The figure's box is what the crop must find.
const FIGURE = [1000, 500, 1600, 1500];
function frame({ alpha = false, flat = false } = {}) {
  const data = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    data[i * 4] = 120; data[i * 4 + 1] = 180; data[i * 4 + 2] = 240; data[i * 4 + 3] = alpha ? 0 : 255;
  }
  if (!flat) {
    for (let y = FIGURE[1]; y < FIGURE[3]; y++) for (let x = FIGURE[0]; x < FIGURE[2]; x++) {
      const o = (y * W + x) * 4;
      data[o] = 200; data[o + 1] = 40; data[o + 2] = 40; data[o + 3] = 255;
    }
  }
  return encodePng({ width: W, height: H, data });
}
const FRAMES = { ground: frame(), alpha: frame({ alpha: true }), flat: frame({ flat: true }) };

const MANIFEST = [
  tool("screenshot", "observe", {}, "Capture the client's framebuffer."),
  tool("get_screen", "observe", { detail: { type: "string" } }),
  tool("ping", "observe"),
];
// GUI scale 4: a 960-wide screen on a 3840-wide frame.
const LAYOUT = { screen: { class: "Stub", width: 960, height: 533 },
  widgets: [{ index: 0, x: 100, y: 50, width: 200, height: 20, id: "go", label: "Go" }] };

let which = "ground";
const onCmd = ({ tool: name }) => {
  if (name === "screenshot") {
    return { ok: true, result: { _image: { mimeType: "image/png", base64: FRAMES[which].toString("base64") }, width: W, height: H } };
  }
  if (name === "get_screen") return { ok: true, result: LAYOUT };
  return { ok: true, result: {} };
};

const size = (r) => { const png = imageOf(r); const d = decodePng(png); return { png, w: d.width, h: d.height }; };

// The figures below are pinned at 512 explicitly. The shipped DEFAULT is 384 since 0.124.0 (the
// edge every number in LOOP_KIT_DESIGN.md section 1 was measured at; the falsifier, section 11
// finding 9, priced 512 against it), and the last test here pins that default by itself.
test("the budget over a 4K screenshot: crop to content, resize, price", async (t) => {
  const bridge = await startStubBridge({ manifest: MANIFEST, onCmd });
  const shim = await spawnShim({ env: { MCPTK_URL: bridge.base, MCPTK_PROFILE: "full", MCPTK_SHOT_MAX: "512" } });
  t.after(async () => { shim.kill(); await bridge.close(); });

  // The schema grew the two arguments, and nothing else about the tool moved.
  const listed = (await shim.list()).find((x) => x.name === "screenshot");
  assert.ok(listed.inputSchema.properties.max, "screenshot schema carries `max`");
  assert.ok(listed.inputSchema.properties.crop, "screenshot schema carries `crop`");

  // Flat ground: the figure is 600x1000 of a 3840x2131 frame; with the 4px margin the crop is
  // 608x1008, and 512 on the long edge makes it 309x512.
  which = "ground";
  let r = await shim.call("screenshot");
  let s = size(r);
  assert.deepStrictEqual([s.w, s.h], [309, 512], `content-cropped then resized (got ${s.w}x${s.h})`);
  const line = textOf(r).split("\n").find((l) => l.startsWith("picture "));
  assert.ok(line, `a cost line rides the reply:\n${textOf(r)}`);
  assert.match(line, /^picture 309x512 ~\d+ tok \(was 3840x2131 ~\d+ tok, content was 7% of the frame\); re-sent every turn after this one$/);
  assert.match(line, new RegExp(`~${apiTokens(309, 512)} tok \\(was 3840x2131 ~${apiTokens(W, H)} tok`), "the numbers are the API's own");
  console.log(`  ground frame: ${line}`);
  // The bridge's own numbers survive in the text part beside the picture.
  assert.match(textOf(r), /"width":3840/);

  // Alpha ground: the same box, found through the alpha channel this time.
  which = "alpha";
  s = size(await shim.call("screenshot"));
  assert.deepStrictEqual([s.w, s.h], [309, 512], `alpha bbox (got ${s.w}x${s.h})`);

  // A flat frame has no content box: no crop, only the resize, and the line says nothing about
  // a content fraction because there was none.
  which = "flat";
  r = await shim.call("screenshot");
  s = size(r);
  assert.deepStrictEqual([s.w, s.h], [512, 284], `flat frame resized whole (got ${s.w}x${s.h})`);
  assert.match(textOf(r), /picture 512x284 ~\d+ tok \(was 3840x2131 ~\d+ tok\); re-sent/);

  // Per-call `max`: 0 is the native frame, byte for byte; 128 is smaller still.
  which = "ground";
  r = await shim.call("screenshot", { max: 0 });
  assert.ok(imageOf(r).equals(FRAMES.ground), "max:0 returns the exact bytes the bridge sent");
  assert.match(textOf(r), /picture 3840x2131 ~\d+ tok; re-sent every turn/);
  s = size(await shim.call("screenshot", { max: 128 }));
  assert.deepStrictEqual([s.w, s.h], [77, 128]);
  // ...and neither argument reached the bridge, which would have refused them.
  for (const c of bridge.calls.filter((x) => x.tool === "screenshot")) {
    assert.ok(!("max" in c.args) && !("crop" in c.args), `budget args stripped before the bridge: ${JSON.stringify(c.args)}`);
  }

  // `crop`: a GUI rectangle [100,50,200,20] at scale 4 with the 2px margin is frame [392,192)..[1208,288)
  // = 816x96, resized to 512x60. By widget index and by declared id the same.
  for (const crop of [[100, 50, 200, 20], { widget: 0 }, { id: "go" }]) {
    r = await shim.call("screenshot", { crop });
    s = size(r);
    assert.deepStrictEqual([s.w, s.h], [512, 60], `crop ${JSON.stringify(crop)} (got ${s.w}x${s.h})`);
  }
  // The layout was fetched for the crop (before the frame), not guessed.
  assert.ok(bridge.calls.some((c) => c.tool === "get_screen" && c.args.detail === "layout"), "crop resolved against get_screen layout");
  // A crop that names nothing does not cost the caller the picture.
  r = await shim.call("screenshot", { crop: { widget: 9 } });
  assert.ok(!r.isError);
  assert.match(textOf(r), /crop ignored: no widget #9/);
  s = size(r);
  assert.deepStrictEqual([s.w, s.h], [309, 512], "the full-frame budget still applied");
});

test("MCPTK_SHOT_MAX=0 passes every picture through byte-identical, still priced", async (t) => {
  const bridge = await startStubBridge({ manifest: MANIFEST, onCmd });
  const shim = await spawnShim({ env: { MCPTK_URL: bridge.base, MCPTK_PROFILE: "full", MCPTK_SHOT_MAX: "0" } });
  t.after(async () => { shim.kill(); await bridge.close(); });
  which = "ground";
  const r = await shim.call("screenshot");
  assert.ok(imageOf(r).equals(FRAMES.ground), "bytes untouched");
  assert.match(textOf(r), /picture 3840x2131 ~\d+ tok; re-sent every turn after this one/);
  // The schema still says what the default is, and it is 0 here.
  const listed = (await shim.list()).find((x) => x.name === "screenshot");
  assert.match(listed.inputSchema.properties.max.description, /default 0;/);
});

test("the Blockbench upstream's picture goes through the same budget", async (t) => {
  const bb = await startStubBlockbench({
    tools: [
      { name: "capture_screenshot", description: "The viewport as a picture.", inputSchema: { type: "object", properties: {} }, mechanism: "observe" },
      { name: "get_texture", description: "A texture as a picture.", inputSchema: { type: "object", properties: {} }, mechanism: "observe" },
    ],
    // The viewport is a ground frame with a figure; the "texture" is the alpha frame - a sheet
    // whose figure the content search WOULD find, and must not. The plugin says which is which
    // on the picture itself (`_image.frame`), and that is what the shim reads.
    onCall: (p) => ({ _image: { mimeType: "image/png", base64: (p.name === "get_texture" ? FRAMES.alpha : FRAMES.ground).toString("base64"), frame: p.name !== "get_texture" } }),
  });
  const bridge = await startStubBridge({ manifest: MANIFEST, onCmd });
  const shim = await spawnShim({ env: { MCPTK_URL: bridge.base, MCPTK_PROFILE: "art", MCPTK_BLOCKBENCH: bb.url, MCPTK_SHOT_MAX: "512" } });
  t.after(async () => { shim.kill(); await bridge.close(); await bb.close(); });
  // The watcher learns Blockbench's names on its first poll.
  let tools = [];
  for (let i = 0; i < 40 && !tools.some((x) => x.name === "capture_screenshot"); i++) {
    await new Promise((r) => setTimeout(r, 250));
    tools = await shim.list();
  }
  assert.ok(tools.some((x) => x.name === "capture_screenshot"), `blockbench served; stderr:\n${shim.stderr()}`);
  const r = await shim.call("capture_screenshot");
  const s = size(r);
  assert.deepStrictEqual([s.w, s.h], [309, 512], `upstream picture shrunk (got ${s.w}x${s.h})`);
  assert.match(textOf(r), /picture 309x512 ~\d+ tok \(was 3840x2131/);
  // A texture sheet is an address space (`_image.frame:false`): resized, NEVER cropped to its
  // content. Found live 2026-09-06 - a 16x16 get_texture came back 12x12.
  const tex = await shim.call("get_texture");
  const ts = size(tex);
  assert.deepStrictEqual([ts.w, ts.h], [512, 284], `texture resized only, not cropped (got ${ts.w}x${ts.h})`);
  assert.doesNotMatch(textOf(tex), /content was/, "no content crop on a texture sheet");
});

test("the default budget is 384, the measured edge, and a session that says nothing gets it", async (t) => {
  const bridge = await startStubBridge({ manifest: MANIFEST, onCmd });
  const shim = await spawnShim({ env: { MCPTK_URL: bridge.base, MCPTK_PROFILE: "full" } });
  t.after(async () => { shim.kill(); await bridge.close(); });
  const tools = await shim.list();
  assert.match(tools.find((x) => x.name === "screenshot").inputSchema.properties.max.description, /default 384;/);
  which = "ground";
  const s = size(await shim.call("screenshot"));
  assert.deepStrictEqual([s.w, s.h], [232, 384], `content-cropped then resized to the default (got ${s.w}x${s.h})`);
});

test("the default budget is 384, the measured edge, and a session that says nothing gets it", async (t) => {
  const bridge = await startStubBridge({ manifest: MANIFEST, onCmd });
  const shim = await spawnShim({ env: { MCPTK_URL: bridge.base, MCPTK_PROFILE: "full" } });
  t.after(async () => { shim.kill(); await bridge.close(); });
  const tools = await shim.list();
  assert.match(tools.find((x) => x.name === "screenshot").inputSchema.properties.max.description, /default 384;/);
  which = "ground";
  const s = size(await shim.call("screenshot"));
  assert.deepStrictEqual([s.w, s.h], [232, 384], `content-cropped then resized to the default (got ${s.w}x${s.h})`);
});
