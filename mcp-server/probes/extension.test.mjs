// Live probes for the EXTENSION SEAM and MODDED-DATA RECOGNITION (toolkit 0.41.0,
// EXTENSION_DESIGN.md). Two questions, one file:
//
//   A. Can another mod contribute tools, and is that visible?
//      1. Every villagejobs tool in the manifest carries source:"villagejobs"; every toolkit tool
//         carries no `source` at all (absent, not null — a toolkit-only manifest must stay
//         byte-identical to what pre-0.41.0 served).
//      2. ping.extensions lists the mod, its tools, and an EMPTY failures array. A registration that
//         silently half-worked is the failure mode this exists to catch: before it, a tool that lost
//         a name collision just wasn't there, with nothing to ask.
//      3. The two views agree — the set of source-stamped manifest names equals the set ping reports.
//
//   B. Do the classifiers recognize content they were not compiled against?
//      4. The vanilla floor still holds: magma_block reads `hazard` with no datapack in play.
//      5. THE REAL TEST — push a datapack joining a block vanilla does NOT consider dangerous
//         (cobweb) to #mcptoolkit:contact_hazards, and the affordance flips to `hazard` live. This is
//         the proof the seam is data-driven rather than a recompiled list: nothing about cobweb is
//         known to the toolkit's Java.
//      6. The same tag prices NAVIGATION: a corridor floored with the newly-hazardous block is
//         avoided by check_path when a clear detour exists. Perception and pathing read one seam.
//      7. Clearing the datapack restores the original classification — so the probe leaves no trace
//         and the "it's live data" claim is symmetric.
//
// Probe-owned site at 3.53M so it cannot collide with the other probe files' worlds.
// Needs the dev server; skips when the bridge is down.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
const SESSION = "probe-extension";
const X = 3_530_000, Z = 3_530_000, Y = 100;

// The tag entry the probe adds and then removes. Cobweb is chosen because vanilla does NOT treat it
// as contact damage (it is a movement impediment), so a `hazard` flag on it can ONLY have come from
// the tag — no vanilla code path produces it.
const TAG_PATH = "data/mcptoolkit/tags/block/contact_hazards.json";
const TEST_HAZARD = "minecraft:cobweb";

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
const cmd = (c) => call("run_command", { command: c });
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

/** The affordance string for one cell, via get_blocks_at's palette-level flags. Rows are [x,y,z,idx]. */
async function affAt(x, y, z) {
  const r = await call("get_blocks_at", { blocks: [{ x, y, z }] });
  const idx = r.blocks[0][3];
  assert.notEqual(idx, -1, `(${x},${y},${z}) could not be read`);
  return r.affordances[idx];
}

let manifest = null;
let bridgeUp = false;

before(async () => {
  try {
    const res = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(4000) });
    manifest = await res.json();
    bridgeUp = Array.isArray(manifest) && manifest.length > 0;
  } catch {
    bridgeUp = false;
  }
});

describe("A. the extension seam", () => {
  test("manifest: extension tools carry `source`, toolkit tools carry none", (t) => {
    if (!bridgeUp) return t.skip("bridge down");
    const stamped = manifest.filter((tool) => tool.source !== undefined);
    const vj = manifest.filter((tool) => tool.source === "villagejobs");

    // A toolkit-only server (no villagejobs jar — what a third-party extension author runs) is a
    // legitimate shape, so an empty stamp set is a skip, not a failure.
    if (vj.length === 0) {
      assert.deepEqual(stamped, [], "tools are source-stamped but none belong to villagejobs");
      return t.skip("villagejobs not loaded — no extension tools to check");
    }

    // The known six. Named explicitly: a silently-shrinking set would otherwise pass.
    const names = vj.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      "edit_building", "get_region", "import_building", "list_buildings", "place_blocks",
      "save_building",
    ], "villagejobs' source-stamped tools are not the expected six");

    // Absent, not null/empty — the manifest a toolkit-only bridge serves must be unchanged.
    for (const tool of manifest) {
      if (tool.source === undefined) continue;
      assert.equal(typeof tool.source, "string");
      assert.ok(tool.source.length > 0, `${tool.name}: empty source stamp`);
    }
    for (const builtin of ["ping", "locate", "bot_status", "get_blocks_at"]) {
      const tool = manifest.find((x) => x.name === builtin);
      assert.ok(tool, `builtin ${builtin} missing from manifest`);
      assert.ok(!("source" in tool), `builtin ${builtin} must not carry a source stamp`);
    }
  });

  test("ping.extensions reports the mod, its tools, and no failures", async (t) => {
    if (!bridgeUp) return t.skip("bridge down");
    const r = await call("ping");
    assert.ok(Array.isArray(r.extensions), "ping.extensions missing");

    const vj = r.extensions.find((e) => e.mod === "villagejobs");
    if (!vj) {
      return t.skip("villagejobs not loaded");
    }
    // The whole point of surfacing failures: a collision or a throw must be ASKABLE, not just logged.
    assert.deepEqual(vj.failures, [], `villagejobs reported registration failures: ${vj.failures}`);
    assert.equal(vj.tools.length, 6, `expected 6 villagejobs tools, got ${vj.tools}`);
    assert.ok(vj.tools.includes("list_buildings"));
  });

  test("the manifest and ping agree about who owns what", async (t) => {
    if (!bridgeUp) return t.skip("bridge down");
    const r = await call("ping");
    const fromPing = new Set(r.extensions.flatMap((e) => e.tools));
    const fromManifest = new Set(
      manifest.filter((tool) => tool.source !== undefined).map((tool) => tool.name),
    );
    assert.deepEqual([...fromPing].sort(), [...fromManifest].sort(),
      "ping.extensions and the manifest's source stamps disagree");
  });
});

describe("B. modded-data recognition", () => {
  before(async () => {
    if (!bridgeUp) return;
    await cmd(`forceload add ${X} ${Z}`);
    // A clean slab to read from, then one vanilla-floor hazard and one tag-subject block.
    await cmd(`fill ${X - 2} ${Y - 1} ${Z - 2} ${X + 6} ${Y - 1} ${Z + 2} minecraft:stone`);
    await cmd(`fill ${X - 2} ${Y} ${Z - 2} ${X + 6} ${Y + 2} ${Z + 2} minecraft:air`);
    // Fixtures sit at Z+2, clear of the nav test's lane (Z and Z-1) — an earlier cut put them ON the
    // lane, so the nav test's fill silently replaced the fixture the hazard test asserted on.
    // magma_block, not cactus, for the vanilla-floor fixture: a cactus /setblock onto stone survives
    // exactly until the next block update and then pops off, which read as "the tag push un-hazarded
    // vanilla" — a fixture decaying mid-file, not a behavior change.
    await cmd(`setblock ${X} ${Y} ${Z + 2} minecraft:magma_block`);
    await cmd(`setblock ${X + 2} ${Y} ${Z + 2} ${TEST_HAZARD}`);
  });

  after(async () => {
    if (!bridgeUp) return;
    // Always drop the pushed tag, even if an assertion failed mid-file — a leaked datapack entry
    // would make every LATER probe run see a hazardous cobweb.
    await raw("clear_data", { path: TAG_PATH });
    await raw("run_command", { command: `forceload remove ${X} ${Z}` });
  });

  test("vanilla floor holds with no datapack: magma is a hazard", async (t) => {
    if (!bridgeUp) return t.skip("bridge down");
    const aff = await affAt(X, Y, Z + 2);
    assert.match(aff, /hazard/, `magma_block should carry the hazard flag, got "${aff}"`);
  });

  test("a tag-joined block becomes a hazard live — the seam is data, not a recompiled list", async (t) => {
    if (!bridgeUp) return t.skip("bridge down");

    const before_ = await affAt(X + 2, Y, Z + 2);
    assert.doesNotMatch(before_, /hazard/,
      `cobweb should NOT be a hazard before the tag is pushed, got "${before_}"`);

    // replace:false — the tag ADDS to whatever the floor and any other pack contribute.
    await call("push_data", {
      path: TAG_PATH,
      base64: b64(JSON.stringify({ replace: false, values: [TEST_HAZARD] })),
      reload: true,
    });

    const after_ = await affAt(X + 2, Y, Z + 2);
    assert.match(after_, /hazard/,
      `cobweb should read as a hazard once tagged, got "${after_}" — the tag did not reach Affordances`);

    // And the floor is untouched by the push (replace:false really is additive).
    assert.match(await affAt(X, Y, Z + 2), /hazard/, "the vanilla floor block lost its hazard flag after the tag push");
  });

  test("the same tag prices navigation: the walker routes around it", async (t) => {
    if (!bridgeUp) return t.skip("bridge down");

    // A straight lane of the test block from (X..X+4, Z), with a clear parallel lane one step north.
    // check_path reports a route's NODE COUNT, not the node list, so the tag's effect is measured as
    // the difference between the same query with and without the tag: identical geometry, one
    // variable. A detour around the lane necessarily costs more nodes than walking straight down it.
    await cmd(`fill ${X} ${Y} ${Z} ${X + 4} ${Y} ${Z} ${TEST_HAZARD}`);
    await cmd(`fill ${X} ${Y} ${Z - 1} ${X + 4} ${Y} ${Z - 1} minecraft:air`);
    const ask = () => call("check_path", {
      from: { x: X - 1, y: Y, z: Z },
      to: { x: X + 5, y: Y, z: Z },
      body: "walker",
    });

    // Untagged first: the straight line through the lane is available and cheapest.
    await call("clear_data", { path: TAG_PATH });
    const plain = await ask();
    assert.equal(plain.reachable, true, "the lane should be walkable before the block is tagged");

    await call("push_data", {
      path: TAG_PATH,
      base64: b64(JSON.stringify({ replace: false, values: [TEST_HAZARD] })),
      reload: true,
    });
    const tagged = await ask();
    assert.equal(tagged.reachable, true, "the clear parallel lane should keep the goal reachable");
    assert.ok(tagged.nodes > plain.nodes,
      `route did not lengthen once the lane was tagged hazardous (${plain.nodes} -> ${tagged.nodes} nodes) `
      + "— the tag did not reach the node evaluator");
  });

  test("clearing the datapack restores the original classification", async (t) => {
    if (!bridgeUp) return t.skip("bridge down");
    await cmd(`setblock ${X + 2} ${Y} ${Z + 2} ${TEST_HAZARD}`);
    await call("clear_data", { path: TAG_PATH });
    const aff = await affAt(X + 2, Y, Z + 2);
    assert.doesNotMatch(aff, /hazard/,
      `cobweb should stop being a hazard once the tag is removed, got "${aff}"`);
  });
});
