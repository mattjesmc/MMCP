// The manifest's `context` column against the shim's hand list, offline (RELEASE_1.md section K1).
//
// Every ToolDef declares SERVER, CLIENT or ANY, and since toolkit 0.129.0 GET /tools serves it as
// `context`. The shim's CLIENT_SURFACE is a HAND list the profiles are built from at module load,
// so the column cannot be its source; it is its falsifier. This file is that falsifier's own test,
// on a stub bridge: a consistent manifest says nothing, a client-context tool the list does not
// name is said on stderr, and so is a listed name the bridge says answers headless. The fourth
// claim is the price: `context` is consumed and NOT forwarded to the MCP client.
//
// Offline: no game. Run with `node --test probes/context-column.test.mjs` (it is also in the live
// battery, where it needs nothing live).

import { test } from "node:test";
import assert from "node:assert/strict";
import { startStubBridge, spawnShim, tool } from "./loop-harness.mjs";

const withContext = (t, context) => ({ ...t, context });

// A manifest shaped like a small real one: one of each context, get_screen where the hand list
// has it. `full` profile so nothing is hidden and every name reaches tools/list.
const BASE_MANIFEST = [
  withContext(tool("ping", "observe"), "any"),
  withContext(tool("get_world_info", "observe"), "server"),
  withContext(tool("get_screen", "observe"), "client"),
  withContext(tool("render", "observe"), "client"),
];

async function serve(manifest) {
  const bridge = await startStubBridge({ manifest });
  const shim = await spawnShim({ env: { MCPTK_URL: bridge.base, MCPTK_PROFILE: "full" } });
  const tools = await shim.list();
  // The fetch has happened by now; give stderr a beat to flush before reading it.
  await new Promise((r) => setTimeout(r, 150));
  const stderr = shim.stderr();
  shim.kill();
  await bridge.close();
  return { tools, stderr };
}

test("a consistent column says nothing, and is not forwarded", async () => {
  const { tools, stderr } = await serve(BASE_MANIFEST);
  assert.doesNotMatch(stderr, /context column/, stderr);
  for (const t of tools) {
    assert.equal("context" in t, false, `${t.name} must not carry context to the MCP client`);
  }
  assert.ok(tools.some((t) => t.name === "get_screen"), "full profile serves the client tool");
});

test("a client-context tool the hand list does not name is said once", async () => {
  const { stderr } = await serve([
    ...BASE_MANIFEST,
    withContext(tool("brand_new_client_tool", "observe"), "client"),
  ]);
  assert.match(stderr, /context column: 1 client-context tool\(s\) not in CLIENT_SURFACE.*brand_new_client_tool/);
  assert.doesNotMatch(stderr, /says answer without a client/);
});

test("a hand-listed name the bridge says answers headless is said", async () => {
  const { stderr } = await serve([
    ...BASE_MANIFEST.filter((t) => t.name !== "render"),
    withContext(tool("render", "observe"), "server"),
  ]);
  assert.match(stderr, /context column: 1 CLIENT_SURFACE name\(s\) the bridge says answer without a client: render/);
  assert.doesNotMatch(stderr, /not in CLIENT_SURFACE/);
});

test("a manifest with no column (an older bridge) says nothing", async () => {
  const { stderr } = await serve(BASE_MANIFEST.map(({ context, ...t }) => t));
  assert.doesNotMatch(stderr, /context column/, stderr);
});
