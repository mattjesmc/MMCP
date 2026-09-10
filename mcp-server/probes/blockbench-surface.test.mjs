// Blockbench behind the shim: is it there, is it scoped, does it still work?
//
// Since 0.64.0 the upstream is the toolkit's OWN plugin (mcp-toolkit/blockbench/mcptoolkit_bridge.js,
// BLOCKBENCH_BRIDGE_DESIGN.md), speaking the game bridge's shape. The claims, none of which should
// live only in a changelog:
//   1. SCOPE. The plugin's tools are served under the workbench profiles and are ABSENT — not
//      merely hidden — under a body profile, which is the thing a peer MCP registration could never
//      do. `art` keeps a slice of them (everything but the blind UI escape hatch).
//   2. ROUTING. A Blockbench name reaches the plugin WITH THIS SESSION'S IDENTITY (that is what lets
//      the plugin bind a session to a project), and a picture comes back as image content whose
//      `frame` flag decides whether the budget may crop it.
//   3. MECHANISM. The manifest's stamps reach the loop hook, and a reply's own stamp wins over the
//      manifest's for a mixed tool (`project op:list` is a read though `project` is an edit).
//   4. RECOVERY. Blockbench going away and coming back on the same port does not strand the shim:
//      the down call says so, the next one after the restart works, no shim restart.
//   5. PRESENCE. The shim holds ONE GET /presence connection per process, under its session id,
//      and that connection dies with the process - which is what lets the plugin release a binding
//      the instant its session is gone instead of on a timer (BLOCKBENCH_BRIDGE_DESIGN.md section 4,
//      ArmorPieces' measurement of 2026-09-07).
//   6. NO MANIFEST YET IS NOT A TYPO. A Blockbench name called before this session has ever built
//      a tool list reaches Blockbench, instead of being forwarded to the GAME bridge and refused
//      there as an unknown tool - a sentence that names the wrong process entirely.
//   7. A WINDOW OF ITS OWN. Two shims in one port range take two windows, not one tab
//      (BLOCKBENCH_ISOLATION_DESIGN.md section 6.3, step 2): each claims the window it discovered
//      and every call it makes lands there. A shim that finds every window taken ASKS one for
//      another and claims the port that appears - it cannot make a window itself. Where no window
//      can be had it falls back to sharing and says so; a window the person at the keyboard
//      RESERVED is never taken, not even then.
//
// Two stubs, no game and no Blockbench: fixtures/manifest-2026-08-26.json (90 bridge tools, live
// capture) and fixtures/blockbench-bridge-2026-09-07.json (the plugin's 26-tool manifest, pinned by
// its own harness, which refuses to pass when the pin drifts from the plugin). So this proves the
// MECHANISM against pinned captures and deliberately does not track live figures.
//
// Run: node --test probes/blockbench-surface.test.mjs

import { test } from "node:test";
import assert from "node:assert";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStubBridge, startStubBlockbench, spawnShim, textOf, HERE } from "./loop-harness.mjs";
import { localTools } from "../local/registry.mjs";

const BRIDGE_CAPTURE = "manifest-2026-08-26.json";
const BB_CAPTURE = "blockbench-bridge-2026-09-07.json";
const MANIFEST = JSON.parse(readFileSync(join(HERE, "fixtures", BRIDGE_CAPTURE), "utf8"));
const BB_TOOLS = JSON.parse(readFileSync(join(HERE, "fixtures", BB_CAPTURE), "utf8"));
const BB_NAMES = new Set(BB_TOOLS.map((t) => t.name));

// A 1x1 PNG. The point is that it arrives as an IMAGE block, not that it is a picture of anything.
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const price = (tools) => JSON.stringify(tools).length;

async function serving(shim, name, tries = 40) {
  let tools = [];
  for (let i = 0; i < tries && !tools.some((x) => x.name === name); i++) {
    await new Promise((r) => setTimeout(r, 250));
    tools = await shim.list();
  }
  return tools;
}
/**
 * Discovery no longer TAKES a window. `peekBase` (upstream/blockbench.mjs) reads the manifest from
 * whatever answers and claims nothing; a window is allocated on the first CALL, because that is the
 * first moment a session has asked Blockbench to do anything. Reported 2026-09-10: four live
 * sessions and a Blockbench that started meant four windows instantly, and a window a person closed
 * was re-demanded on the owning session's next poll - so a person could not close one at all.
 *
 * A probe about OWNERSHIP therefore has to make a call. A tool list proves nothing about windows now.
 */
async function working(shim, name) {
  const tools = await serving(shim, name);
  await shim.call("get_project_info", {}).catch(() => {});
  return tools;
}


test(`the plugin's surface merges, scopes to art, and routes with identity (${BB_CAPTURE})`, async (t) => {
  const bridge = await startStubBridge({ manifest: MANIFEST });
  const bb = await startStubBlockbench({
    tools: BB_TOOLS,
    onCall: (p) => (p.name === "capture_screenshot"
      ? { _image: { mimeType: "image/png", base64: PIXEL, frame: true }, width: 1, height: 1 }
      : p.name === "get_texture" ? { _image: { mimeType: "image/png", base64: PIXEL, frame: false }, size: [1, 1] }
        : p.name === "project" ? { ok: true, result: { projects: [] }, mechanism: "observe" }
          : bb.refuse ? (() => { const r = bb.refuse; bb.refuse = null; return r; })() : { echoed: p.arguments }),
  });
  const shim = await spawnShim({ env: { MCPTK_URL: bridge.base, MCPTK_BLOCKBENCH: bb.url, MCPTK_PROFILE: "standard", MCPTK_CLIENT: "probe-client" } });
  t.after(async () => { shim.kill(); await bridge.close(); await bb.close(); });

  // 1. MERGED, and unprefixed. The capture's names must arrive verbatim.
  const std = await serving(shim, "place_cube");
  const stdNames = new Set(std.map((x) => x.name));
  for (const n of ["place_cube", "risky_eval", "export_model", "project", "paint_faces", "trigger_action"]) {
    assert.ok(stdNames.has(n), `standard must serve blockbench's "${n}"; stderr:\n${shim.stderr()}`);
  }
  // ...and nothing was shadowed: the bridge capture keeps every one of its own names.
  for (const b of MANIFEST) {
    assert.ok(stdNames.has(b.name) || !BB_NAMES.has(b.name), `blockbench shadowed the bridge tool "${b.name}"`);
  }
  const bbServed = std.filter((x) => BB_NAMES.has(x.name));
  assert.strictEqual(bbServed.length, BB_TOOLS.length, "standard serves the whole blockbench surface");
  // The picture tools grew the budget's `max` (the shim's argument, stripped before the plugin).
  assert.strictEqual(std.find((x) => x.name === "capture_screenshot").inputSchema.properties.max?.type, "integer");
  assert.strictEqual(std.find((x) => x.name === "get_texture").inputSchema.properties.max?.type, "integer");
  assert.ok(!std.find((x) => x.name === "place_cube").inputSchema.properties.max, "only pictures take max");

  // 2. SCOPED. `art` keeps the slice index.mjs asks for: everything but the blind UI escape hatch.
  await shim.call("tool_surface", { profile: "art" });
  const art = await shim.list();
  const artNames = new Set(art.map((x) => x.name));
  const artBB = art.filter((x) => BB_NAMES.has(x.name));
  console.log(`\n  captures: ${BRIDGE_CAPTURE} (${MANIFEST.length} bridge) + ${BB_CAPTURE} (${BB_TOOLS.length} blockbench)`);
  console.log("                     tools     chars   ~tokens");
  for (const [label, list] of [["standard", std], ["  of it bb", bbServed], ["art", art], ["  of it bb", artBB]]) {
    console.log(`    ${label.padEnd(13)}${String(list.length).padStart(6)}${String(price(list)).padStart(10)}${String(Math.round(price(list) / 4)).padStart(10)}`);
  }
  for (const kept of ["place_cube", "risky_eval", "export_model", "capture_screenshot", "project", "texture", "paint_faces", "inspect"]) {
    assert.ok(artNames.has(kept), `art must serve "${kept}"`);
  }
  assert.ok(!artNames.has("trigger_action"), "art must not serve trigger_action (driving the UI blind is a fallback, not a pipeline)");
  assert.strictEqual(artBB.length, BB_TOOLS.length - 1, "art keeps every plugin tool but one");
  // A keep-list serves only what something offers; a typo in BLOCKBENCH_KEEP is otherwise invisible.
  const offered = new Set([...MANIFEST.map((x) => x.name), ...BB_TOOLS.map((x) => x.name), ...localTools().map((x) => x.name), "tool_surface"]);
  for (const n of artNames) assert.ok(offered.has(n), `art served "${n}", which neither upstream offers`);
  assert.ok(artNames.has("tool_surface"), "the way back out must survive the narrowing");

  // 3. ROUTED, with identity. The plugin binds sessions to projects, so every call must carry
  //    who is calling - in the body and on the header both.
  const echoed = await shim.call("place_cube", { elements: [{ from: [0, 0, 0], to: [1, 1, 1] }] });
  const last = bb.calls.at(-1);
  assert.strictEqual(last.name, "place_cube");
  assert.deepStrictEqual(last.arguments, { elements: [{ from: [0, 0, 0], to: [1, 1, 1] }] }, "arguments pass through");
  // And that identity is the PARENT's process id, not the shim's own. Two MCP servers of one
  // session (ArmorPieces runs this shim beside its own Blockbench proxy) must present ONE id, or
  // every guard the plugin has turns them against each other; the parent is the only thing both
  // of them see. This probe IS that parent, so the exact number is checkable - and a fallback
  // that went back to the shim's own pid would fail right here.
  assert.strictEqual(last.session?.id, `mcptk-${process.pid}`,
    `the session block names this shim's PARENT: ${JSON.stringify(last.session)}`);
  assert.strictEqual(last.session.client, "probe-client");
  assert.strictEqual(last.session.profile, "art", "the served profile rides along");
  // ...and WHICH GAME this session drives (TODO.md 1.9). The shim is the only component that knows
  // both ends: the plugin cannot work the port out, and the two older plugins reached through
  // `risky_eval` carried a hardcoded 25599 for want of anyone telling them. The plugin keeps this
  // on the session record and hands it to an eval as `GAME`.
  assert.strictEqual(last.session.game, bridge.base,
    `the session block names the game this shim drives: ${JSON.stringify(last.session)}`);
  assert.strictEqual(last.headers["x-mcptk-session"], last.session.id, "and the header agrees with the body");
  assert.match(textOf(echoed), /"echoed"/, "the result is rendered as JSON text");

  // 3b. A picture is an image part; its frame flag reached the budget (a 1x1 stays 1x1 either way,
  //     so the flag is asserted on the cost line's vocabulary: a frame may say "content", a sheet never).
  const shot = await shim.call("capture_screenshot", { angle: "north", max: 64 });
  assert.strictEqual(shot.content?.[0]?.type, "image", "a screenshot must arrive as image content, not a stringified envelope");
  assert.strictEqual(shot.content[0].data, PIXEL, "the image bytes must be untouched");
  assert.deepStrictEqual(bb.calls.at(-1).arguments, { angle: "north" }, "`max` is the shim's and comes off before the plugin");
  const sheet = await shim.call("get_texture", {});
  assert.strictEqual(sheet.content?.[0]?.type, "image");
  assert.doesNotMatch(textOf(sheet), /content was/, "a texture sheet is never content-cropped");

  // 3c. STALE NAMES REFUSE, and refuse HERE. `art` drops trigger_action; a client still holding
  //     the pre-switch list can name it, and the answer must be this session's own `profile_hidden`
  //     — not a silent forward to the game bridge, which fails too and looks the same from outside.
  const callsBefore = bb.calls.length;
  const stale = await shim.call("trigger_action", { id: "select_all" });
  assert.ok(stale.isError, "a blockbench tool `art` dropped must refuse");
  assert.match(textOf(stale), /profile_hidden/, "the refusal must name the profile, not read as an unknown tool");
  assert.strictEqual(bb.calls.length, callsBefore, "a refused call must not reach blockbench");

  // 3d. An error from the plugin is an error reply carrying its sentence AND its hint.
  bb.refuse = { ok: false, error: "no cube named \"x\"", hint: "list_outline shows what exists" };
  const bad = await shim.call("modify_cube", { id: "x", to: [1, 1, 1] });
  assert.ok(bad.isError, "ok:false from the plugin is an error reply");
  assert.match(textOf(bad), /no cube named "x"\. list_outline shows what exists/, textOf(bad));
});

test("the manifest's mechanism stamps reach the loop hook, and a reply's own stamp wins", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "bb-surface-"));
  mkdirSync(join(root, ".mcptoolkit"), { recursive: true });
  writeFileSync(join(root, "check.mjs"), `console.log(JSON.stringify({ text: "checked", problems: 0 }));`);
  writeFileSync(join(root, ".mcptoolkit", "loop.json"), JSON.stringify({
    checks: [{ name: "part", after: { mechanism: ["blockbench_edit"] }, run: [process.execPath, "check.mjs"] }],
  }));
  const bridge = await startStubBridge({ manifest: MANIFEST });
  const bb = await startStubBlockbench({
    tools: BB_TOOLS,
    // `project` is stamped blockbench_edit on the manifest; op:list answers with observe on the reply.
    onCall: (p) => (p.name === "project" && p.arguments.op === "list" ? { ok: true, result: { projects: [] }, mechanism: "observe" } : {}),
  });
  const shim = await spawnShim({ cwd: root, env: { MCPTK_URL: bridge.base, MCPTK_BLOCKBENCH: bb.url, MCPTK_PROFILE: "art" } });
  t.after(async () => { shim.kill(); await bridge.close(); await bb.close(); });
  await serving(shim, "place_cube");
  let r = await shim.call("get_project_info", {});
  assert.doesNotMatch(textOf(r), /checked/, "an observe tool fires no check");
  r = await shim.call("place_cube", { elements: [{ from: [0, 0, 0], to: [1, 1, 1] }] });
  assert.match(textOf(r), /checked/, `an edit fires the check:\n${textOf(r)}`);
  r = await shim.call("paint_faces", { faces: { "c.north": "#ff0000" } });
  assert.match(textOf(r), /checked/, "the painters are plugin edits now and fire it too");
  r = await shim.call("project", { op: "new", name: "x" });
  assert.match(textOf(r), /checked/, "project op:new is an edit (manifest stamp)");
  r = await shim.call("project", { op: "list" });
  assert.doesNotMatch(textOf(r), /checked/, "project op:list answered observe on the reply, so no check");
});

test("the shim holds a presence connection under its session id, and it dies with the shim", async (t) => {
  const bridge = await startStubBridge({ manifest: MANIFEST });
  const bb = await startStubBlockbench({ tools: BB_TOOLS });
  const shim = await spawnShim({ env: { MCPTK_URL: bridge.base, MCPTK_BLOCKBENCH: bb.url, MCPTK_PROFILE: "art", MCPTK_SESSION: "probe-presence", MCPTK_CLIENT: "probe-client" } });
  t.after(async () => { shim.kill(); await bridge.close(); await bb.close(); });
  // PRESENCE FOLLOWS THE WINDOW, and since a window is taken on the first CALL rather than at
  // discovery, so is the socket. That is the point of it: presence registers this session IN A
  // WINDOW, so a session that has been given none has nothing to register - and a socket opened at
  // discovery would land in whichever window happens to sit on the first port of the range.
  await serving(shim, "place_cube");
  await new Promise((r) => setTimeout(r, 400));
  assert.strictEqual(bb.presence.length, 0, `no window, no presence: reading a tool list registers nothing; stderr:\n${shim.stderr()}`);
  await shim.call("get_project_info", {});
  for (let i = 0; i < 40 && !bb.presence.length; i++) await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(bb.presence.length, 1, `one presence connection once this session is working in a window; stderr:\n${shim.stderr()}`);
  assert.strictEqual(bb.presence[0].session, "probe-presence", "under this shim's session id");
  assert.strictEqual(bb.presence[0].client, "probe-client", "and its declared client");
  // A second list does not open a second one: one per process, for the life of the process.
  await shim.list();
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(bb.presence.length, 1, "still one after another list");
  assert.strictEqual(bb.presence[0].closed, false, "and it is still open");
  shim.kill();
  for (let i = 0; i < 50 && !bb.presence[0].closed; i++) await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(bb.presence[0].closed, true, "the connection closed when the shim died");
});

/**
 * `n` stub windows on contiguous ports, and the range string a shim scans to find them. Contiguous
 * because that is what the plugin produces: each window takes the first free port at or above the
 * base, so a range is what a machine with several windows actually looks like.
 */
async function windows(specs) {
  for (let tries = 0; tries < 30; tries++) {
    const base = 36000 + Math.floor(Math.random() * 20000);
    const made = [];
    try {
      for (let i = 0; i < specs.length; i++) {
        made.push(await startStubBlockbench({ tools: BB_TOOLS, port: base + i, ...specs[i] }));
      }
      return {
        base,
        list: made,
        range: `127.0.0.1:${base}-${base + Math.max(specs.length, 2) - 1}`,
        close: async () => { for (const w of made) await w.close().catch(() => {}); },
      };
    } catch { for (const w of made) await w.close().catch(() => {}); }
  }
  throw new Error("no run of free ports for the stub windows");
}
const presenced = async (w, session, tries = 60) => {
  for (let i = 0; i < tries && !w.presence.some((x) => x.session === session && !x.closed); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return w.presence.some((x) => x.session === session && !x.closed);
};
const held = async (w, session, tries = 60) => {
  for (let i = 0; i < tries && w.holder()?.session !== session; i++) await new Promise((r) => setTimeout(r, 100));
  return w.holder();
};

test("two shims in one range take a window each, and each one's calls land in its own", async (t) => {
  const bridge = await startStubBridge({ manifest: MANIFEST });
  const ws = await windows([
    { window: "win-a", onCall: () => ({ landed: "a" }) },
    { window: "win-b", onCall: () => ({ landed: "b" }) },
  ]);
  const [a, b] = ws.list;
  // Cleanup is registered as each thing is made, never after the next assertion: a stub server
  // still listening, or a shim still running, keeps the runner's event loop alive, so a check that
  // fails before its `t.after` HANGS the run instead of reporting the failure.
  t.after(async () => { await bridge.close(); await ws.close(); });
  const one = await spawnShim({ env: { MCPTK_URL: bridge.base, MCPTK_BLOCKBENCH: ws.range, MCPTK_PROFILE: "art", MCPTK_SESSION: "probe-w1", MCPTK_CLIENT: "shim-one" } });
  t.after(() => one.kill());
  await working(one, "place_cube");
  assert.deepStrictEqual((await held(a, "probe-w1"))?.session, "probe-w1", `the first shim claims the first window; stderr:\n${one.stderr()}`);
  assert.strictEqual(b.holder(), null, "and leaves the second window alone");

  const two = await spawnShim({ env: { MCPTK_URL: bridge.base, MCPTK_BLOCKBENCH: ws.range, MCPTK_PROFILE: "art", MCPTK_SESSION: "probe-w2", MCPTK_CLIENT: "shim-two" } });
  t.after(() => two.kill());
  await working(two, "place_cube");
  assert.strictEqual((await held(b, "probe-w2"))?.session, "probe-w2", `the second shim takes the next window, not the first shim's; stderr:\n${two.stderr()}`);
  assert.strictEqual(a.holder()?.session, "probe-w1", "and the first keeps what it claimed");

  // The claim is not paperwork: the calls follow it. This is the whole of step 2 - two sessions
  // working at once in two active tabs, where before they queued for one.
  assert.match(textOf(await one.call("get_project_info", {})), /"landed":"a"/);
  assert.match(textOf(await two.call("get_project_info", {})), /"landed":"b"/);
  assert.strictEqual(a.calls.at(-1).session.id, "probe-w1", "and each call carries the session that claimed the window");
  assert.strictEqual(b.calls.at(-1).session.id, "probe-w2");
  assert.ok(await presenced(a, "probe-w1"), "presence is held in the claimed window, not in whichever answered first");
  assert.ok(await presenced(b, "probe-w2"));
});

test("with every window taken the shim asks for another, and claims the port that appears", async (t) => {
  const bridge = await startStubBridge({ manifest: MANIFEST });
  // One window, and somebody else already has it. A shim cannot make a window (relaunching the exe
  // with the same --userData forwards and exits 0, isolation record section 8), so the only way out
  // is to ask this one - and then find, and claim, what appears in the range.
  let opened = null;
  const ws = await windows([{
    window: "win-a",
    claimedBy: { session: "someone-else", client: "their-shim" },
    onCall: () => ({ landed: "a" }),
    onOpenWindow: async () => {
      if (opened) return;
      // A window opens where the next free port is - the one above the window that made it, which
      // is exactly where a scanning shim looks for it.
      opened = await startStubBlockbench({ tools: BB_TOOLS, port: ws.base + 1, window: "win-new", onCall: () => ({ landed: "new" }) });
    },
  }]);
  const a = ws.list[0];
  t.after(async () => { await bridge.close(); await ws.close(); await opened?.close().catch(() => {}); });
  const shim = await spawnShim({ env: { MCPTK_URL: bridge.base, MCPTK_BLOCKBENCH: ws.range, MCPTK_PROFILE: "art", MCPTK_SESSION: "probe-ask" } });
  t.after(() => shim.kill());
  await working(shim, "place_cube");
  assert.deepStrictEqual(a.opens.map((x) => x.id), ["probe-ask"], `it asked the window it could not have for another; stderr:\n${shim.stderr()}`);
  assert.ok(opened, "and a window appeared");
  assert.strictEqual((await held(opened, "probe-ask"))?.session, "probe-ask", "and the shim claimed it: " + shim.stderr());
  assert.strictEqual(a.holder()?.session, "someone-else", "the window it could not have is still theirs");
  assert.match(textOf(await shim.call("get_project_info", {})), /"landed":"new"/, "and its calls land in the window it opened");
  assert.strictEqual(a.calls.length, 0, "never in the one it was refused");
});

// THE FLIP (BLOCKBENCH_ISOLATION_DESIGN.md section 10). A window is the person's unless it was
// opened FOR an agent, so the window somebody is working in is never a candidate and they set no
// flag to keep it. Before this, protecting your own window was an opt-in you found out about by
// losing your tab.
// THE DOCK (BLOCKBENCH_ISOLATION_DESIGN.md section 11). When one is open it is the front door, and
// it beats `POST /window` at the same job in two ways this pins: it REUSES an empty agent window
// instead of making a seventh, and it answers with the PORT - so this session needs no second scan
// and cannot lose the window it paid for to somebody else's scan arriving in that gap.
test("with a dock in the range the shim asks IT, and lands in the window it names", async (t) => {
  const bridge = await startStubBridge({ manifest: MANIFEST });
  let given = null;
  const ws = await windows([
    { window: "win-dock", dock: true, onCall: () => ({ landed: "dock" }), onDockWindow: async () => {
      given = given ?? await startStubBlockbench({ tools: BB_TOOLS, port: ws.base + 1, window: "win-given", onCall: () => ({ landed: "given" }) });
      return { port: ws.base + 1, window: "win-given" };
    } },
  ]);
  const dock = ws.list[0];
  t.after(async () => { await bridge.close(); await ws.close(); await given?.close().catch(() => {}); });
  const shim = await spawnShim({ env: { MCPTK_URL: bridge.base, MCPTK_BLOCKBENCH: ws.range, MCPTK_PROFILE: "art", MCPTK_SESSION: "probe-dock" } });
  t.after(() => shim.kill());
  await working(shim, "place_cube");
  assert.deepStrictEqual(dock.dockAsks.map((x) => x.id), ["probe-dock"], "it asked the dock; stderr: " + shim.stderr());
  assert.deepStrictEqual(dock.opens, [], "and never fell through to the 0.7.0 route");
  assert.strictEqual((await held(given, "probe-dock"))?.session, "probe-dock", "it claimed what the dock named: " + shim.stderr());
  assert.match(textOf(await shim.call("get_project_info", {})), /"landed":"given"/, "and its calls land there");
  assert.strictEqual(dock.calls.length, 0, "never in the dock itself");
});

// A dock that cannot help must not strand a session that could have used the old path. Both
// directions or neither, the same bargain the rest of this file is written to.
test("a dock that cannot give a window falls through to the 0.7.0 route rather than stranding", async (t) => {
  const bridge = await startStubBridge({ manifest: MANIFEST });
  let opened = null;
  const ws = await windows([
    { window: "win-dock", dock: true, onDockWindow: async () => null, onCall: () => ({ landed: "dock" }) },
    { window: "win-a", claimedBy: { session: "someone-else", client: "theirs" }, onCall: () => ({ landed: "a" }),
      onOpenWindow: async () => { opened = opened ?? await startStubBlockbench({ tools: BB_TOOLS, port: ws.base + 2, window: "win-new", onCall: () => ({ landed: "new" }) }); } },
  ]);
  const [dock, a] = ws.list;
  t.after(async () => { await bridge.close(); await ws.close(); await opened?.close().catch(() => {}); });
  const shim = await spawnShim({ env: { MCPTK_URL: bridge.base, MCPTK_BLOCKBENCH: `127.0.0.1:${ws.base}-${ws.base + 2}`, MCPTK_PROFILE: "art", MCPTK_SESSION: "probe-dockfail" } });
  t.after(() => shim.kill());
  await working(shim, "place_cube");
  assert.strictEqual(dock.dockAsks.length, 1, "it asked the dock first; stderr: " + shim.stderr());
  assert.deepStrictEqual(a.opens.map((x) => x.id), ["probe-dockfail"], "and then took the old path");
  assert.match(textOf(await shim.call("get_project_info", {})), /"landed":"new"/, "landing in the window that appeared");
  assert.strictEqual(dock.calls.length, 0, "and never working in the dock");
});

test("the window a person is working in is never taken, and they set no flag to keep it", async (t) => {
  const bridge = await startStubBridge({ manifest: MANIFEST });
  const ws = await windows([{ window: "win-mine", person: true, onCall: () => ({ landed: "mine" }) }]);
  const a = ws.list[0];
  t.after(async () => { await bridge.close(); await ws.close(); });
  const shim = await spawnShim({ env: { MCPTK_URL: bridge.base, MCPTK_BLOCKBENCH: ws.range, MCPTK_PROFILE: "art", MCPTK_SESSION: "probe-res" } });
  t.after(() => shim.kill());
  // The surface APPEARS now, and that is not a regression: a manifest is a property of the plugin
  // and not of a window, so reading it claims nothing (`peekBase`). The protection moved to where the
  // ownership decision itself moved - the first CALL - and it is the same refusal it always was.
  await serving(shim, "place_cube");
  assert.strictEqual(a.holder(), null, "reading the tool list took nothing");
  const out = textOf(await shim.call("get_project_info", {}));
  assert.match(out, /is available to agent sessions/, `the call is refused rather than walking into the person's window: ${out}`);
  assert.strictEqual(a.holder(), null, "and nothing claimed it");
  assert.strictEqual(a.calls.length, 0, "and nothing was called in it");
});

test("a window the person HANDS OVER is claimable, and it is the only person's window that is", async (t) => {
  const bridge = await startStubBridge({ manifest: MANIFEST });
  const ws = await windows([
    { window: "win-mine", person: true, onCall: () => ({ landed: "mine" }) },
    { window: "win-given", person: true, allowAgents: true, onCall: () => ({ landed: "given" }) },
  ]);
  const [mine, given] = ws.list;
  t.after(async () => { await bridge.close(); await ws.close(); });
  const shim = await spawnShim({ env: { MCPTK_URL: bridge.base, MCPTK_BLOCKBENCH: ws.range, MCPTK_PROFILE: "art", MCPTK_SESSION: "probe-given" } });
  t.after(() => shim.kill());
  await working(shim, "place_cube");
  assert.strictEqual((await held(given, "probe-given"))?.session, "probe-given", `it took the one on offer; stderr:\n${shim.stderr()}`);
  assert.strictEqual(mine.holder(), null, "and walked past the one that was not");
  assert.match(textOf(await shim.call("get_project_info", {})), /"landed":"given"/);
  assert.strictEqual(mine.calls.length, 0, "nothing was called in the person's own window");
});

test("a plugin from before the flip sends no `agent` field, and is read the old way", async (t) => {
  const bridge = await startStubBridge({ manifest: MANIFEST });
  // A consumer's stale extraction serves 0.6.0's window block. There, `reserved` is the only signal
  // there is, and it is the one that plugin's own claim route enforces anyway.
  const ws = await windows([{ window: "win-old", legacy: true, onCall: () => ({ landed: "old" }) }]);
  const a = ws.list[0];
  t.after(async () => { await bridge.close(); await ws.close(); });
  const shim = await spawnShim({ env: { MCPTK_URL: bridge.base, MCPTK_BLOCKBENCH: ws.range, MCPTK_PROFILE: "art", MCPTK_SESSION: "probe-old" } });
  t.after(() => shim.kill());
  await working(shim, "place_cube");
  assert.strictEqual((await held(a, "probe-old"))?.session, "probe-old", `an unreserved 0.6.0 window is still claimed; stderr:\n${shim.stderr()}`);
  assert.match(textOf(await shim.call("get_project_info", {})), /"landed":"old"/);
});

test("a window that cannot be had and cannot make another is SHARED, and the shim says so", async (t) => {
  const bridge = await startStubBridge({ manifest: MANIFEST });
  // Held by another session, and no new_window action to ask (POST /window refuses).
  // Sharing is the old behaviour and it still works - `held_by` is what guards an edit, and step 2
  // exists to stop NEEDING it, not to replace it with serving nothing.
  const ws = await windows([{ window: "win-a", claimedBy: { session: "someone-else" }, onCall: () => ({ landed: "shared" }) }]);
  t.after(async () => { await bridge.close(); await ws.close(); });
  const shim = await spawnShim({ env: { MCPTK_URL: bridge.base, MCPTK_BLOCKBENCH: ws.range, MCPTK_PROFILE: "art", MCPTK_SESSION: "probe-share" } });
  t.after(() => shim.kill());
  await working(shim, "place_cube");
  await shim.waitStderr(/sharing port \d+ with session someone-else/);
  assert.match(textOf(await shim.call("get_project_info", {})), /"landed":"shared"/, "and it works, shared");
});

test("Blockbench going away and coming back does not strand the shim", async (t) => {
  const bridge = await startStubBridge({ manifest: MANIFEST });
  let bb = await startStubBlockbench({ tools: BB_TOOLS, onCall: () => ({ up: 1 }) });
  const port = bb.port;
  const shim = await spawnShim({ env: { MCPTK_URL: bridge.base, MCPTK_BLOCKBENCH: bb.url, MCPTK_PROFILE: "art" } });
  t.after(async () => { shim.kill(); await bridge.close(); await bb.close().catch(() => {}); });
  await working(shim, "place_cube");
  let r = await shim.call("get_project_info", {});
  assert.match(textOf(r), /"up":1/);
  await bb.close();
  r = await shim.call("get_project_info", {});
  assert.ok(r.isError, "a call while Blockbench is down is an error");
  assert.match(textOf(r), /unreachable|Tools > MCP Toolkit Bridge > Start/, `and it says what to do:\n${textOf(r)}`);
  bb = await startStubBlockbench({ tools: BB_TOOLS, onCall: () => ({ up: 2 }), port });
  r = await shim.call("get_project_info", {});
  assert.match(textOf(r), /"up":2/, `after a restart on the same port the next call works, no shim restart:\n${textOf(r)}`);
});

test("two processes of ONE session converge on one window, and never take two", async (t) => {
  const bridge = await startStubBridge({ manifest: MANIFEST });
  const ws = await windows([
    { window: "win-a", onCall: () => ({ landed: "a" }) },
    { window: "win-b", onCall: () => ({ landed: "b" }) },
  ]);
  const [a, b] = ws.list;
  t.after(async () => { await bridge.close(); await ws.close(); });
  // A session is TWO processes - this shim and, in a consumer repo, that repo's own Blockbench
  // proxy - both computing the same id from the parent pid (design section 6.1) and both
  // discovering on their own, with no channel between them. This is the other half of the test
  // above: there, two IDS take two windows; here, one id across two processes takes ONE. What makes
  // it true is that the range is walked in port order and a claim from an id that already holds a
  // window is a rejoin, so the second process is handed the first one's window even when its scan
  // was too early to see the claim. Taking two would be worse than the sharing this replaced: a
  // session cannot work in two realms, and the second window is then denied to a session with none.
  const env = { MCPTK_URL: bridge.base, MCPTK_BLOCKBENCH: ws.range, MCPTK_PROFILE: "art", MCPTK_SESSION: "probe-pair" };
  const one = await spawnShim({ env: { ...env, MCPTK_CLIENT: "shim" } });
  t.after(() => one.kill());
  const two = await spawnShim({ env: { ...env, MCPTK_CLIENT: "proxy" } });
  t.after(() => two.kill());
  await working(one, "place_cube");
  await working(two, "place_cube");
  assert.deepStrictEqual((await held(a, "probe-pair"))?.session, "probe-pair",
    `the session holds the lowest window; stderr:\n${one.stderr()}\n---\n${two.stderr()}`);
  assert.strictEqual(b.holder(), null, "and the other window is left for another SESSION, not held twice by this one");
  assert.match(textOf(await one.call("get_project_info", {})), /"landed":"a"/, "the first process works there");
  assert.match(textOf(await two.call("get_project_info", {})), /"landed":"a"/, "and so does the second - one session, one window");
  assert.strictEqual(b.calls.length, 0, "nothing of this session ever landed in the other window");
});

// THE REPORT OF 2026-09-10, and the reason discovery stopped taking a window. Two halves, both of
// them things a person said out loud: "I just started blockbench and 4 session windows instantly
// opened", and "closing the windows still reopens them, still no control".
//
// The cause of both was one line: the tool-list WATCHER called `resolveWindow`, which claims or
// CREATES. So every live session demanded a window the moment it noticed Blockbench, whether or not
// anyone would ever use it - and a window a person closed was re-demanded on the owning session's
// next poll, which made closing one impossible. The windows were never leaking; they were being
// asked for, by sessions with no work for them.
test("an idle session takes no window, and one a person closes is not demanded back", async (t) => {
  const bridge = await startStubBridge({ manifest: MANIFEST });
  const ws = await windows([
    { window: "win-a", onCall: () => ({ landed: "a" }), onOpenWindow: async () => {} },
    { window: "win-b", onCall: () => ({ landed: "b" }), onOpenWindow: async () => {} },
  ]);
  const [a, b] = ws.list;
  t.after(async () => { await bridge.close(); await ws.close(); });
  const shim = await spawnShim({ env: { MCPTK_URL: bridge.base, MCPTK_BLOCKBENCH: ws.range, MCPTK_PROFILE: "art", MCPTK_SESSION: "probe-idle" } });
  t.after(() => shim.kill());
  // The surface appears - a manifest is a property of the plugin, not of a window - and several
  // watcher polls go by. An idle session must still own nothing anywhere.
  await serving(shim, "place_cube");
  await shim.list();
  await new Promise((r) => setTimeout(r, 900));
  assert.strictEqual(a.holder(), null, `an idle session claims no window; stderr:\n${shim.stderr()}`);
  assert.strictEqual(b.holder(), null, "not the second one either");
  assert.deepStrictEqual([...a.opens, ...b.opens], [], "and asks for none to be made");
  assert.deepStrictEqual([a.presence.length, b.presence.length], [0, 0], "and registers in neither");

  // Working takes one, which is the whole point: the cost is paid when there is something to do.
  assert.match(textOf(await shim.call("get_project_info", {})), /"landed":"a"/);
  assert.strictEqual((await held(a, "probe-idle"))?.session, "probe-idle", "the first CALL takes a window");

  // Now the person closes it. The session goes back to idle and must not take another, or ask for
  // one - that loop is exactly what "no control" meant.
  await a.close();
  await new Promise((r) => setTimeout(r, 1500));
  await shim.list();
  await new Promise((r) => setTimeout(r, 600));
  assert.strictEqual(b.holder(), null, `a window a person closed is not replaced under them; stderr:\n${shim.stderr()}`);
  assert.strictEqual(b.opens.length, 0, "and no new one is asked for");
  assert.strictEqual(b.calls.length, 0, "and nothing of this session moved into the survivor");
});

test("a stranger in the scan range is not mistaken for a Blockbench window", async (t) => {
  const bridge = await startStubBridge({ manifest: MANIFEST });
  // Some other localhost service that answers JSON on /hello, and would answer /tools and /cmd too.
  // A single configured URL never asked strangers; a sixteen-port scan does, and the fallbacks end
  // in SHARING whatever answered - which would send every call of this session to it, silently.
  const ws = await windows([{ app: "not-blockbench", onCall: () => ({ landed: "stranger" }) }]);
  const stranger = ws.list[0];
  t.after(async () => { await bridge.close(); await ws.close(); });
  const shim = await spawnShim({ env: { MCPTK_URL: bridge.base, MCPTK_BLOCKBENCH: ws.range, MCPTK_PROFILE: "art", MCPTK_SESSION: "probe-stranger" } });
  t.after(() => shim.kill());
  await shim.list();
  await shim.waitStderr(/no Blockbench window answered/);
  const tools = await shim.list();
  assert.ok(!tools.some((x) => x.name === "place_cube"), "no Blockbench surface, rather than a surface served by a stranger");
  assert.strictEqual(stranger.calls.length, 0, "and nothing was ever called on it");
});

// Claim 6. The shim learns the plugin's names when it BUILDS a manifest - from a `tools/list` or
// from the watcher - and classifies a call by what it learned. Before either has happened it knows
// no Blockbench names at all, and the name fell through to the game bridge, whose refusal is about a
// game that never had the tool. Every real client lists before it calls, so this is a race and not a
// regime; it is also exactly the shape a harness (this one, once) and a client resuming from a
// stored list arrive in.
test("a call before this session's first tools/list reaches Blockbench, not the game", async (t) => {
  const bridge = await startStubBridge({ manifest: MANIFEST });
  const bb = await startStubBlockbench({ tools: BB_TOOLS, onCall: (p) => ({ echoed: p.arguments }) });
  const shim = await spawnShim({ env: { MCPTK_URL: bridge.base, MCPTK_BLOCKBENCH: bb.url, MCPTK_PROFILE: "art" } });
  t.after(async () => { shim.kill(); await bridge.close(); await bb.close(); });

  // NO tools/list, deliberately, and immediately: the watcher would learn the names within
  // WATCH_DOWN_MS and close the window this test is about.
  const r = await shim.call("list_outline", {});
  assert.ok(!r.isError, `a blockbench name must not fail before the first list; got: ${textOf(r)}`);
  assert.match(textOf(r), /"echoed"/, "the plugin answered it");
  assert.strictEqual(bb.calls.at(-1)?.name, "list_outline", "it reached blockbench");
  assert.ok(!bridge.calls.some((c) => c.tool === "list_outline"),
    "and never the game bridge, whose 'unknown tool' would name the wrong process");
  // The lazy list is a LIST, so the session is now classified for good: the next call needs no
  // second fetch, and a name that is really unknown still goes to the game as it always did.
  const toolsAsked = bb.tools_requests;
  await shim.call("get_selection", {});
  assert.strictEqual(bb.tools_requests, toolsAsked, "one lazy list, not one per call");
  const game = await shim.call("get_log", {});
  assert.ok(bridge.calls.some((c) => c.tool === "get_log"), `a game tool still reaches the game: ${textOf(game)}`);
});
