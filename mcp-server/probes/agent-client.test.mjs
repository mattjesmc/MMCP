// Live probes for the INBOUND PATH: an external agent dials this bridge and the toolkit serves it.
//
// This file exists to test the configuration RELEASE_1.md §F3 calls the release's primary supported
// path and says has never been tested: bridge up, MCP server registered by hand, dev profile, and
// the toolkit's whole surface reachable with no agent client involved. Half of §A5's claim about
// that path was wrong — inbound registration has worked since `POST /hello` shipped — so what is
// asserted here is the half that is real and the half that is new:
//
//   1. A SESSION SELF-DECLARES AT HELLO and lands as EXTERNAL with its client identity recorded.
//      Identity, not plumbing, was what inbound lacked.
//   2. THE HELLO REPLY CARRIES THE ORIENTATION POINTER — the fix for the one real gap in §A4. The
//      memory render was already a tool (`mem_recent` returns it); what a fresh session on any host
//      lacked was a reason to CALL it, and hello is the only moment the toolkit speaks first.
//   3. THE BRIDGE IS WHAT SERVES. Every dev tool answers with no agent client configured at all,
//      which is now the only way anyone runs this.
//
// SEVEN CASES WERE REMOVED AT 0.144.0, and the reason is worth keeping. They asserted the OUTBOUND
// half — `ping.agent`, the no-client state as a supported STATE, "no adapter code path was taken",
// the two bundled adapters' differing capabilities, and three kit cases — and 0.143.0 archived the
// launcher those describe. They went red in the 0.144.0 whole battery (6/7) as a probe outliving its
// subject, not as a regression: there is no `agent` seam in `ping` to report any more, so the
// question "is the no-client state a state?" no longer has two sides. The file's premise survives
// the cut intact and arguably purer — the toolkit is not an accessory of one of them BECAUSE the
// only path left is the one an external agent dials. `CHANGELOG.md` 0.143.0 lists what was archived.
//
// No site: nothing is staged, no block is touched, nothing global is reloaded. Needs the dev server;
// skips when the bridge is down. Battery chunk b. Run with `npm run test:live`.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { BASE } from "../bridge-base.mjs";
import { localTools, isLocalTool, callLocalTool } from "../memory/tools.mjs";

const SESSION = "probe-agent-client";

// The shim's own bridge caller shape, for the `mem_*` tools that are served here rather than by the
// mod (see the memory-render case below for why that distinction had to be discovered). THE SHAPE
// IS THE ENVELOPE: index.mjs's callTool returns the bridge's `{ok, result | error}` as it came, and
// memory/tools.mjs reads `data.ok` / `data.result` off it. This helper used to unwrap to `result`,
// which made `resolveWorld` fall through to the on-disk world cache on every call - and the case
// passed for as long as that cache happened to hold a uuid (it held the AUTHORING world's on
// 2026-09-06, so the render was of the wrong world's memory and then refused). Mirror the shim.
async function callBridge(tool, args = {}) {
  const res = await fetch(`${BASE}/cmd`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-MCPTK-Session": SESSION },
    body: JSON.stringify({ tool, args }),
  });
  return res.json();
}

async function call(tool, args = {}) {
  const res = await fetch(`${BASE}/cmd`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-MCPTK-Session": SESSION },
    body: JSON.stringify({ tool, args }),
  });
  return res.json();
}

async function hello(body) {
  const res = await fetch(`${BASE}/hello`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

const bridgeUp = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok)
  .catch(() => false);
if (!bridgeUp) {
  console.log(`\n  [skip] no bridge at ${BASE} — start the dev server to run these probes\n`);
}

describe("agent client: the toolkit is not an accessory of one of them", { skip: !bridgeUp }, () => {
  test("every dev tool is reachable anyway — the bridge is what serves, not the launcher", async () => {
    const tools = await fetch(`${BASE}/tools`).then((r) => r.json());
    const list = Array.isArray(tools) ? tools : tools.tools ?? [];
    const names = new Set(list.map((t) => t.name));
    for (const want of ["ping", "get_world_info", "set_blocks", "query_registry", "push_data",
                        "capture_structure", "session_list"]) {
      assert.ok(names.has(want), `${want} is in the manifest with no agent client configured`);
    }
    const world = await call("get_world_info");
    assert.equal(world.ok, true, `and they answer: ${JSON.stringify(world)}`);
  });

  test("the memory render is an ordinary tool call, on any host", async () => {
    // §A4 proposed making this "reachable as a tool call" as if it were not one. It already is — and
    // building this probe found WHICH LAYER it is a tool of: `mem_*` are served by the Node shim
    // (memory/tools.mjs), not by the mod, so they are absent from the bridge's own manifest and a
    // POST /cmd for one answers "unknown tool". That is not a gap. Every MCP host sees them in the
    // manifest the shim serves, which is the manifest an agent actually reads; the SessionStart hook
    // that shows the render on one client is a 55-line shell around this same call.
    assert.ok(isLocalTool("mem_recent"), "mem_recent is a tool the shim serves");
    const declared = localTools().find((t) => t.name === "mem_recent");
    assert.ok(declared, `…and it is in the shim's declared tool list: ${localTools().length} tools`);

    const r = await callLocalTool("mem_recent", {}, callBridge);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(typeof r.result.render, "string",
      `it returns the render as a field — no second delivery path is needed: ${JSON.stringify(r)}`);
  });

  // ---- inbound: hello, identity, orientation ---------------------------------------------------

  test("a session self-declares at hello and lands as EXTERNAL with its client recorded", async () => {
    const { status, data } = await hello({
      label: "probe-inbound", client: "probe-harness", client_version: "1.2.3",
    });
    assert.equal(status, 200);
    assert.equal(data.ok, true, JSON.stringify(data));
    assert.match(data.session, /^x\d+-\d+$/, `EXTERNAL ids carry the x prefix: ${data.session}`);

    // The identity has to be visible to the game, not merely accepted: a declaration nobody can read
    // back is the same as no declaration.
    const listed = await fetch(`${BASE}/cmd`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-MCPTK-Session": data.session },
      body: JSON.stringify({ tool: "session_list", args: {} }),
    }).then((r) => r.json());
    assert.equal(listed.ok, true, JSON.stringify(listed));
    const me = listed.result.sessions.find((s) => s.session === data.session);
    assert.ok(me, `the declared session is live and listed: ${JSON.stringify(listed.result.sessions)}`);
    assert.equal(me.kind, "external");
    assert.equal(me.client, "probe-harness", "the client identity is recorded and readable");
    assert.equal(me.client_version, "1.2.3");
  });

  test("the hello reply carries the orientation pointer, naming tool calls only", async () => {
    const { data } = await hello({ label: "probe-orientation", client: "probe-harness" });
    assert.equal(typeof data.orientation, "string", "hello answers with an orientation pointer");
    assert.match(data.orientation, /mem_recent/,
      `it names the memory render, which is the gap it closes: ${data.orientation}`);
    assert.match(data.orientation, /ping/, "…and how to identify the instance");
    // Everything it points at must be an ordinary tool, or the pointer is advice one client can
    // follow and the rest cannot — which is the bug, not the fix. The set to resolve against is the
    // UNION of both layers: the bridge serves the game tools, the shim serves `mem_*`, and what an
    // agent reads is ONE merged manifest. Checking only the bridge's half is what first made this
    // case red, and the distinction is real rather than a probe detail — the orientation is advice
    // to the MCP client, so its vocabulary is the client's, not the bridge's.
    const tools = await fetch(`${BASE}/tools`).then((r) => r.json());
    const names = new Set((Array.isArray(tools) ? tools : tools.tools ?? []).map((t) => t.name));
    localTools().forEach((t) => names.add(t.name));
    for (const named of data.orientation.match(/\b[a-z_]+_[a-z_]+\b/g) ?? []) {
      if (names.has(named)) continue;
      assert.fail(`orientation names "${named}", a tool in neither layer's manifest`);
    }
  });

  test("a session that declares nothing is still registered — declaration is optional", async () => {
    const { data } = await hello({ label: "probe-anonymous" });
    assert.equal(data.ok, true, JSON.stringify(data));
    assert.ok(data.session, "identity is best-effort; a host that says nothing still gets an id");
  });

  test("a malformed hello body does not break the handshake", async () => {
    const res = await fetch(`${BASE}/hello`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json at all",
    });
    assert.equal(res.status, 200, "a bad body registers under the default label rather than failing");
    const data = await res.json();
    assert.equal(data.ok, true, JSON.stringify(data));
  });

});
