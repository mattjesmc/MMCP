// Tool-output conformance suite — the consistency contract, mechanically enforced (live).
//
// Sweeps the bridge's /tools manifest and holds every tool to its contract tier:
//   spatial  — full observation envelope (perception_mode, game_tick, dimension, mechanism) plus a
//              well-formed coverage block; over ungenerated space: coverage honestly partial and
//              any verdict field null (never a guess). ARCHITECTURE's honest-envelope rule.
//   observe  — mechanism: "observe" on the result; envelope where the tool is world-anchored.
//   act      — manifest hygiene only (never called here: mutating/embodied/admin).
//   client   — CONDITIONALLY PRESENT (registered only while a game client is attached), so these are
//              exempt from the stale-spec half of the ratchet. Most are manifest hygiene only: they
//              DRIVE the human's screen, capture its pixels, or end the process, and a probe run
//              must do none of those. The read-only ones (`callable: true`) are called and held to
//              the CLIENT observation envelope — see checkClientEnvelope.
//
// The spec table is a RATCHET: a manifest tool without a spec entry fails the suite, so new tools
// must declare their tier the day they ship. `knownGap` marks tools currently out of contract
// (from TODO §Perception): their envelope failures are reported but don't redden the suite, and a
// loud REMOVE-FLAG note fires when they come into contract.
//
// Run: npm run test:live (needs the dev server; stages nothing permanent — one marker block in a
// sandbox strip that is forceloaded for the run and released after).

import { test, before, after } from "node:test";
import assert from "node:assert";

const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";
async function call(tool, args = {}) {
  const res = await fetch(`${BASE}/cmd`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool, args }),
  });
  return res.json();
}
const cmd = (c) => call("run_command", { command: c });

// Generated-and-loaded sandbox for happy-path calls; far-away never-touched square for the
// unread-honesty calls (reads never generate, so it stays ungenerated).
const SB = { x: 3_000_200, y: 200, z: 3_000_200 };
const MARKER = { x: SB.x + 3, y: SB.y, z: SB.z + 3 };
const UNGEN = { x: 3_050_000, y: 100, z: 3_050_000 };

const spec = (tier, o = {}) => ({ tier, ...o });
const SPEC = {
  // --- spatial: full envelope + coverage, honest over unread space -----------------------------
  scene_summary: spec("spatial", {
    // knownGap removed 0.6.0: dimension is the plain envelope string (extras in dimension_info),
    // coverage is top-level, and positional fields (biome/light/seesSky/rainingHere) are explicit
    // nulls over an unloaded vantage point — `biome` doubles as the null-verdict probe.
    args: { origin: SB },
    unloadedArgs: { origin: UNGEN },
    verdict: "biome",
  }),
  get_surface: spec("spatial", { args: { origin: SB }, unloadedArgs: { origin: UNGEN } }),
  get_blocks_at: spec("spatial", {
    args: { blocks: [MARKER] },
    unloadedArgs: { blocks: [UNGEN] },
  }),
  describe_box: spec("spatial", {
    args: { min: SB, max: { x: SB.x + 4, y: SB.y + 2, z: SB.z + 4 } },
    unloadedArgs: { min: UNGEN, max: { x: UNGEN.x + 4, y: UNGEN.y + 2, z: UNGEN.z + 4 } },
  }),
  // 0.22.0 folds: check_fit -> locate at+clear; check_clearance -> check_site's from/to door;
  // find_site -> check_site's near door. The doors' contracts are exercised by predicates.test.mjs
  // and spatial-inversion.test.mjs; check_site's spec below covers the verdict door.
  check_path: spec("spatial", {
    args: { from: { x: SB.x, y: SB.y, z: SB.z }, to: { x: SB.x + 4, y: SB.y, z: SB.z + 4 } },
    unloadedArgs: { from: UNGEN, to: { x: UNGEN.x + 4, y: UNGEN.y, z: UNGEN.z + 4 } },
    verdict: "reachable",
    // `reach` (toolkit 0.5.0) is a SECOND ARGUMENT SHAPE of this tool, not a flag on the first one:
    // it solves the touch shell around a target block instead of a destination to stand on, and
    // answers with `stand` and a `reach` block. It shipped live-verified 16/16 by
    // reach-goals.test.mjs and then sat outside this ratchet entirely — nothing held it to the
    // envelope or to the unread-space honesty rule the `to` shape is held to, and a shape outside
    // the ratchet is one that can regress without reddening anything. The marker block staged in
    // before() is the target; over never-generated space `reachable` must be null here for exactly
    // the reason it must be null there — an unread world cannot be pronounced unreachable.
    variants: [{
      label: "reach",
      args: { from: { x: SB.x, y: SB.y, z: SB.z }, reach: MARKER },
      unloadedArgs: { from: UNGEN, reach: { x: UNGEN.x + 4, y: UNGEN.y, z: UNGEN.z + 4 } },
      verdict: "reachable",
    }],
  }),
  check_site: spec("spatial", {
    args: { at: { x: SB.x, z: SB.z }, size: { w: 8, d: 8 } },
    unloadedArgs: { at: { x: UNGEN.x, z: UNGEN.z }, size: { w: 8, d: 8 } },
  }),
  get_region_summary: spec("spatial", {
    args: { center: { x: SB.x, z: SB.z }, tiles: 1, tile_chunks: 2 },
    unloadedArgs: { center: { x: UNGEN.x, z: UNGEN.z }, tiles: 1, tile_chunks: 2 },
  }),
  resolve_anchor: spec("spatial", {
    args: { to: MARKER, face: "east", size: { w: 2, h: 2, d: 2 } },
    unloadedArgs: { to: UNGEN, face: "east", size: { w: 2, h: 2, d: 2 } },
    verdict: "fits",
  }),
  get_entities: spec("spatial", {
    args: { origin: SB, radius: 16 },
    unloadedArgs: { origin: UNGEN, radius: 16 },
    // Coverage counts CHUNKS (entity data is per-chunk). 0.5.1: absent chunks are STAGED — paged
    // in + a ticks-long wait for the entity inbox — so partial/none now means never-generated
    // terrain, budget, load:false, or data still in flight (UNGEN here exercises never-generated);
    // total is the count-verdict: null over a fully unsearchable radius, never a confident 0.
    // Frozen (loaded-not-ticking) entities carry ticking:false + a frozen rollup — not asserted
    // here yet (needs a staged remote chunk in the fixture).
    verdict: "total",
  }),
  raycast: spec("spatial", {
    args: { origin: SB, direction: { x: 0, y: -1, z: 0 } },
    noCoverage: true, // point read: envelope yes, block-coverage accounting doesn't apply
  }),
  raycast_fan: spec("spatial", {
    args: { origin: SB, direction: { x: 0, y: -1, z: 0 }, h_fov: 30, v_fov: 30, steps_h: 3, steps_v: 3 },
    noCoverage: true,
  }),
  locate: spec("spatial", {
    // Index lookup, not a cell sweep: the envelope applies, column-coverage accounting does not.
    // Its honesty contract is the `search` block (mechanism / extent / negative_is_proof), which
    // locate.test.mjs asserts — including that a structure miss is proof and a POI miss is not.
    args: { what: "minecraft:zombie", near: { x: SB.x, z: SB.z }, radius: 32 },
    noCoverage: true,
  }),

  // --- observe: mechanism tag; envelope where world-anchored -----------------------------------
  ping: spec("observe", { args: {} }),
  get_world_info: spec("observe", { args: {} }),
  get_events: spec("observe", { args: {} }),
  query_registry: spec("observe", { args: {} }),
  list_edits: spec("observe", { args: {} }),
  list_data: spec("observe", { args: {} }),
  // The log ring read. Safe to call from conformance: it reads a process-local buffer and returns
  // whatever is in it, including nothing.
  get_log: spec("observe", { args: {} }),
  // The tick read (0.95.0). Safe to call from conformance in its default shape: it reads counters
  // and vanilla's own tick ring and touches nothing. `profile_ticks` is NOT exercised here — it
  // parks the call for as many ticks as it names and turns on the server's profiler, which is a
  // second caller's business; probes/perf.test.mjs owns that half.
  get_perf: spec("observe", { args: {} }),
  // JVM reflection over one class (0.96.0). Safe to call: it reads the class table of a class the
  // toolkit itself owns, and the lookup does not attach anything.
  query_class: spec("observe", { args: { class: "com.mattmc.mcptoolkit.McpToolkit" } }),
  // Rolling a loot table (0.101.0). Safe to call from conformance, and the call is itself the check
  // that it is: the tool passes its own RandomSource precisely so the LEVEL's persistent loot
  // sequence is never created or advanced, so a roll leaves the save exactly as it found it.
  roll_loot: spec("observe", { args: { block: "minecraft:stone" } }),
  // Asking the loaded generator what it would make (0.103.0). Safe to call, and safer than almost
  // anything else here: it generates nothing at all - no chunk, no ticket, no disk - so a
  // conformance call at a far coordinate leaves the save byte-identical. preview-worldgen.test.mjs
  // owns the falsifier that proves that claim.
  // Its OWN far coordinate, not preview-worldgen.test.mjs's 5,400,000. Nothing is staged at either
  // - this tool generates no chunk - so the two files could not actually collide, but site-map's
  // guard reads every large literal as a site and it is right to: a rule that starts making
  // exceptions for coordinates it judges harmless is a rule that cannot catch the harmful one.
  // Cheaper to hold the rule than to argue with it.
  preview_worldgen: spec("observe", { args: { center: { x: 5_450_000, z: 5_450_000 } } }),
  list_buildings: spec("observe", { args: {}, ext: "villagejobs" }),
  session_list: spec("observe", { args: {} }),
  bot_status: spec("observe", { args: {} }),
  anchors: spec("observe", { args: {} }), // session ledger read; no world envelope by design
  bot_profile: spec("observe", { args: {} }), // reads/sets the reflex perception mode
  sense_entities: spec("observe", { callable: false }), // belief store needs a body to perceive from
  // The §15 referee's predicate probe (phase 3): pure world read, judged in the sandbox strip
  // (forceloaded in before(), so the residency guard is satisfied).
  wm_verdict: spec("observe", { args: { action: "destroy", at: { x: SB.x, y: SB.y, z: SB.z } } }),
  // The §15 obs-gap ring probe (phase 5): a pure read of the session's sighting ring. An eid the
  // ring has never seen answers honestly (sighted:false, last_sighted_tick:null) — no staging.
  // Explicit session: conformance calls carry no bridge session header, and the tool refuses to
  // query a null ring rather than invent one.
  wm_obsgap: spec("observe", { args: { session: "probe:conformance", eid: 1 } }),
  // The review queue read: a file the server owns, not a place in the world, so no envelope. Safe
  // to call from conformance — it reads and returns whatever the queue holds, including nothing.
  review_status: spec("observe", { args: {} }),
  get_region: spec("observe", { callable: false, ext: "villagejobs" }), // happy path needs an editing session

  // --- act/admin: hygiene only, never called from conformance ----------------------------------
  ...Object.fromEntries([
    "send_chat", "run_command",
    "place_shape", "place_shapes", "set_blocks", "undo_edit", "push_data", "reload_data", "clear_data",
    // Reads a box of the world and writes it into the live datapack — PRIVILEGED on the writing half,
    // and never called from here: a conformance run must not leave a structure file behind.
    "capture_structure",
    // Its write half (0.92.0). A WORLD_EDIT that builds a whole structure somewhere; a conformance
    // run must not leave a building standing any more than it may leave a file behind. Exercised by
    // probes/place-structure.test.mjs, which owns a site and undoes what it places.
    "place_structure",
    // Spawns a body into the world (and despawns them again) — an act, and one a conformance run
    // must not perform: a stage left standing is exactly the probe-site contamination the site map
    // exists to prevent, in entity form.
    "stage_entity",
    "bot_body", "bot_target", "bot_tunnel", "bot_goto", "bot_look", "bot_follow", "bot_point",
    "bot_run", "bot_mine", "bot_place", "bot_use", "bot_attack", "bot_shoot", "bot_select",
    "bot_give", "bot_eat", "bot_drink", "bot_equip", "bot_reactions", "bot_craft",
    "bot_container",
    // Swims the body up out of water/lava — a deliberate act on the body, and it CANCELS the base
    // intent underneath it (claimBase), so it is emphatically not an observe read.
    "bot_surface",
    // bot_watch shipped with the block-watch slice without declaring a tier, which is precisely
    // what this ratchet exists to catch — it has been failing since. It arms standing orders on the
    // body's own eyes, so it belongs with the act/admin verbs, not the observe reads.
    "bot_watch",
    "hotswap_class",
    // The §15 task presenter (phase 4): tasks a HUMAN player — nothing to call headless.
    "human_task", "human_task_cancel",
    // Posting a review ask queues commands that later run at console authority when it is staged,
    // which is why it declares PRIVILEGED and is specced act rather than observe — the same rule
    // that put wm_session_tag here despite its read-only shape.
    "review_post",
    // The §3/§4.3 R-block pair (V3_PLAN.md). Both have read-only shapes — wm_session_tag with no
    // `purpose` reports the current tag, wm_perturb {status:true} reports the hijack — but a tier
    // here must match the tool's DECLARED Mechanism, and theirs are PRIVILEGED (it writes the
    // session manifest to disk) and EMBODIED (it drives a body). Specced observe, they failed the
    // envelope check on exactly that mismatch: the read-only shape of a verb does not make the
    // verb an observe read.
    "wm_session_tag", "wm_perturb",
  ].map((n) => [n, spec("act")])),

  // --- extension-mod tools (villagejobs): registered onto the shared registry by ANOTHER mod ----
  // A toolkit-only server (no villagejobs jar — the standard shape once the repo splits, and the
  // shape any third-party extension mod sees) legitimately lacks these, so like the client tier
  // they are exempt from the stale half of the ratchet and skipped when absent. When present they
  // are held to their tiers exactly as before.
  ...Object.fromEntries(["import_building", "edit_building", "save_building", "place_blocks"]
    .map((n) => [n, spec("act", { ext: "villagejobs" })])),

  // --- client tier: CONDITIONALLY PRESENT, declared, never called ------------------------------
  // These 19 register only while a game client is attached (index.mjs CLIENT_SURFACE). Before this
  // block the ratchet had a hole in BOTH directions: run with a client and all 16 came back
  // `unclassified`; add plain entries and every headless run failed `stale` instead (first live run
  // of the 0.29–0.32 probes, LOCATE_ROUTES.md red #5 — "declaration gap, not a behavior change").
  // The tier is the fix: presence is exempt from the stale check, hygiene still applies to whatever
  // the manifest actually carries, and none is CALLED — they read and drive the HUMAN's screen
  // (screenshot/click/set_text) or end the process (quit_game), which a probe run must never do.
  //
  // 0.87.0 splits the block in two. The tier's "never called" rule was doing two jobs: keeping the
  // probe's hands off the human's screen (right, and non-negotiable) and, by accident, keeping the
  // whole client surface out of every contract check there is. That second job is what TODO §1.5
  // meant by "structurally unswept" — the client tools were the one corner where a tool could ship
  // with no envelope and nothing anywhere would notice. Reading the widget tree, the chat ring, the
  // asset list, the nav graph and a font width touches nothing and moves nothing, so those five are
  // now CALLED and held to the client envelope; the eleven that click, type, open, close, capture
  // pixels, push assets or quit stay untouched, because "we could test it" is not a reason to drive
  // someone's game.
  ...Object.fromEntries([
    "screenshot", "click", "set_text", "send_keys", "open_screen", "close_screen",
    "screenshot_annotated", "check_layout",
    "push_asset", "reload_resources", "clear_assets", "quit_game",
    // `render` (0.105.0) is uncallable here for the tier's original reason and not for a new one: it
    // drives the render loop and moves the human's own player for a frame to put the camera where it
    // was asked. It is exercised in full by probes/render-camera.test.mjs, which is deliberately a
    // file somebody chooses to run at a client rather than a line in the sweep.
    "render",
    // `open_world` (0.105.0) likewise: it loads a world, which is the largest thing a call in this
    // suite could do to somebody's running game. render-camera.test.mjs drives it.
    "open_world",
    // `studio` (0.113.0) is the strongest case for the tier's original rule rather than an
    // exception to it: it teleports the human's player into another dimension and stands a
    // structure there. Everything about it is exercised by probes/render-studio.test.mjs, which
    // moves that player deliberately and puts them back.
    "studio",
    // `ui_doc` (0.118.0) is the fourth screen-authoring editor: every op but `read` and `lint`
    // WRITES a document in the developer's own source tree and regenerates Java beside it, and even
    // `preview`/`open` put a screen in front of the human (or load a world to do it). Its own file,
    // probes/ui-tool.test.mjs, drives all eleven ops against a temp copy; the sweep must not.
    "ui_doc",
    // `create_world` (0.130.0, RELEASE_1.md K2) is `open_world`'s reason twice over: it CREATES a
    // save and loads it. probes/create-world.test.mjs drives it, gated behind an environment flag
    // and a client at the title screen, because it leaves the client in the world it made.
    "create_world",
    // `get_tooltip` (0.130.0) reads a stack's tooltip lines with this client's player and level,
    // and refuses at the title screen ("Components not bound yet"); the sweep may run there, so it
    // is declared and left to probes/tooltip.test.mjs, which runs it in a world and asserts that
    // refusal at the title. Both were shipped without a line here and the ratchet caught it in the
    // step-7 battery (sequential-0.63.0.conformance.tap.txt) - which is what the ratchet is for.
    "get_tooltip",
  ].map((n) => [n, spec("client", { callable: false })])),
  get_screen: spec("client", { callable: true, args: {} }),
  get_screen_graph: spec("client", { callable: true, args: {} }),
  get_chat: spec("client", { callable: true, args: { limit: 5 } }),
  list_assets: spec("client", { callable: true, args: {} }),
  measure_text: spec("client", { callable: true, args: { text: "conformance" } }),
};

/** Client-tier names are conditionally present — absent headless by design, not a stale spec. */
const CONDITIONAL = new Set(
  Object.entries(SPEC).filter(([, s]) => s.tier === "client").map(([n]) => n),
);

/** Extension-mod names (spec.ext) — absent whenever the owning mod isn't loaded, not a stale spec. */
const EXTENSION = new Set(
  Object.entries(SPEC).filter(([, s]) => s.ext).map(([n]) => n),
);

// --- shape validators ----------------------------------------------------------------------------
function checkCoverage(cov, label) {
  const errs = [];
  if (!cov || typeof cov !== "object") return [`${label}: coverage missing`];
  for (const k of ["requested", "read", "unloaded", "unvisited"]) {
    if (!Number.isInteger(cov[k])) errs.push(`${label}: coverage.${k} not an integer`);
  }
  if (typeof cov.state !== "string") errs.push(`${label}: coverage.state not a string`);
  if (cov.chunks) {
    for (const k of ["resident", "paged_in", "ungenerated"]) {
      if (!Number.isInteger(cov.chunks[k])) errs.push(`${label}: coverage.chunks.${k} not an integer`);
    }
  }
  return errs;
}

function checkEnvelope(result, { noCoverage = false } = {}, label) {
  const errs = [];
  if (typeof result.perception_mode !== "string") errs.push(`${label}: perception_mode missing`);
  if (!Number.isInteger(result.game_tick)) errs.push(`${label}: game_tick missing/not integer`);
  if (typeof result.dimension !== "string" || !result.dimension.includes(":")) {
    errs.push(`${label}: dimension missing or not namespaced`);
  }
  if (result.mechanism !== "observe") errs.push(`${label}: mechanism !== "observe"`);
  if (!noCoverage) {
    // Region summary accounts coverage per tile as well as top-level; either satisfies the tier
    // as long as SOME well-formed coverage exists.
    errs.push(...checkCoverage(result.coverage, label));
  }
  return errs;
}

/**
 * The CLIENT observation envelope (toolkit 0.87.0, ARCHITECTURE's "non-ladder observe tools" backfill).
 *
 * Deliberately NOT the spatial check. A client read has no coverage — there is no region it swept
 * and could have clipped — and its clock is the CLIENT's level, which on a multiplayer client is not
 * the server's. What it must carry is what makes any observation capturable: what kind of read it
 * was, and when.
 *
 * `game_tick` and `dimension` are allowed to be NULL, and that is the point rather than a loophole:
 * a title screen, a server list, a disconnect screen are all screens these tools legitimately read,
 * and there is no world clock behind them. An explicit null says "no clock here"; an absent key
 * leaves a consumer to guess, and a fabricated 0 would be the silent wrong answer. So the key must
 * be present and either honest-typed or honestly null.
 */
function checkClientEnvelope(result, label) {
  const errs = [];
  if (result.mechanism !== "observe") errs.push(`${label}: mechanism !== "observe"`);
  if (typeof result.perception_mode !== "string") errs.push(`${label}: perception_mode missing`);
  if (!("game_tick" in result)) errs.push(`${label}: game_tick key absent (null is the honest value with no world loaded)`);
  else if (result.game_tick !== null && !Number.isInteger(result.game_tick)) {
    errs.push(`${label}: game_tick is ${JSON.stringify(result.game_tick)} — must be an integer or null`);
  }
  if (!("dimension" in result)) errs.push(`${label}: dimension key absent (null is the honest value with no world loaded)`);
  else if (result.dimension !== null && (typeof result.dimension !== "string" || !result.dimension.includes(":"))) {
    errs.push(`${label}: dimension is ${JSON.stringify(result.dimension)} — must be namespaced or null`);
  }
  return errs;
}

// --- suite ---------------------------------------------------------------------------------------
let manifest;
const gapNotes = [];

before(async () => {
  const res = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
  if (!res?.ok) throw new Error("no bridge — start the dev server (gradlew runServer) first");
  manifest = await res.json();
  // Sandbox: forceload generates; poll until reads see fully generated chunks.
  await cmd(`forceload add ${SB.x - 16} ${SB.z - 16} ${SB.x + 16} ${SB.z + 16}`);
  const t0 = Date.now();
  for (;;) {
    const r = await call("get_blocks_at", { blocks: [MARKER] });
    if (r.ok && r.result.coverage?.state === "complete") break;
    if (Date.now() - t0 > 120_000) throw new Error("sandbox chunks not generated in 120s");
    await new Promise((res2) => setTimeout(res2, 1500));
  }
  const marked = await call("set_blocks", { blocks: [{ ...MARKER, block: "minecraft:gold_block" }] });
  assert.equal(marked.ok, true, `sandbox marker: ${JSON.stringify(marked)}`);
});

after(async () => {
  await call("set_blocks", { blocks: [{ ...MARKER, block: "minecraft:air" }] }).catch(() => {});
  await cmd(`forceload remove ${SB.x - 16} ${SB.z - 16} ${SB.x + 16} ${SB.z + 16}`).catch(() => {});
  for (const n of gapNotes) console.error(n);
});

test("manifest hygiene: names, descriptions, schemas", () => {
  const seen = new Set();
  for (const t of manifest) {
    assert.match(t.name, /^[a-z][a-z0-9_]*$/, `tool name "${t.name}" is not snake_case`);
    assert.ok(!seen.has(t.name), `duplicate tool name "${t.name}"`);
    seen.add(t.name);
    assert.ok(t.description?.trim().length >= 20, `"${t.name}" description missing or too thin`);
    assert.equal(t.inputSchema?.type, "object", `"${t.name}" inputSchema.type must be "object"`);
    for (const req of t.inputSchema?.required ?? []) {
      assert.ok(t.inputSchema.properties?.[req], `"${t.name}" requires "${req}" but doesn't declare it`);
    }
  }
});

test("classification ratchet: every tool has a spec, every spec has a tool", () => {
  const names = new Set(manifest.map((t) => t.name));
  const unclassified = [...names].filter((n) => !SPEC[n]);
  // Client-tier entries are exempt from `stale`: they exist only while a client is attached, so a
  // headless manifest legitimately lacks all 16. Extension-mod entries (spec.ext) are exempt the
  // same way: a toolkit-only server has no villagejobs tools. Every other spec must name a live tool.
  const stale = Object.keys(SPEC).filter((n) => !names.has(n) && !CONDITIONAL.has(n) && !EXTENSION.has(n));
  assert.deepEqual(unclassified, [], `manifest tools without a conformance spec (declare their tier): ${unclassified}`);
  assert.deepEqual(stale, [], `spec entries for tools no longer in the manifest: ${stale}`);
});

test("extension ratchet: spec.ext agrees with the manifest's own source stamps", () => {
  // Two independent statements of the same fact: this file's hand-maintained `ext` flags, and the
  // bridge's `source` stamp (set from the entrypoint container's mod metadata, toolkit 0.41.0).
  // Keeping both and asserting they agree is what makes either trustworthy — a tool that quietly
  // moved between the toolkit and an extension mod fails here instead of drifting.
  for (const tool of manifest) {
    const declared = SPEC[tool.name]?.ext;   // undefined for toolkit-owned
    const stamped = tool.source;             // absent for toolkit-owned
    assert.equal(stamped ?? undefined, declared ?? undefined,
      `"${tool.name}": conformance says owner ${declared ?? "toolkit"}, manifest says ${stamped ?? "toolkit"}`);
  }
});

// A tool with two ARGUMENT SHAPES is a tool with two contracts, and the ratchet is per-tool — so a
// second shape declares itself as a `variants` entry and gets the same two tests under its own
// label. Without this the table can only ever hold whichever shape was written first, which is how
// check_path's `reach` went unswept for as long as it did.
const shapesOf = (name, s) => [
  { ...s, label: name },
  ...(s.variants ?? []).map((v) => ({ ...s, variants: undefined, ...v, label: `${name} (${v.label})` })),
];

for (const [name, base] of Object.entries(SPEC)) {
  if (base.tier === "act" || base.callable === false) continue;

  for (const s of shapesOf(name, base)) {
  test(`${s.label}: envelope conformance (${s.tier})`, async (t) => {
    if (s.ext && !manifest.some((tool) => tool.name === name)) {
      return t.skip(`extension mod "${s.ext}" not loaded`);
    }
    // Client-tier tools exist only while a game client is attached; a headless run legitimately
    // has none of them, which is the same exemption the stale-spec ratchet already grants them.
    if (s.tier === "client" && !manifest.some((tool) => tool.name === name)) {
      return t.skip("no game client attached");
    }
    const r = await call(name, s.args);
    assert.equal(r.ok, true, `${s.label} happy-path call failed: ${JSON.stringify(r.error)}`);
    const errs = s.tier === "spatial"
      ? checkEnvelope(r.result, s, s.label)
      : s.tier === "client"
        ? checkClientEnvelope(r.result, s.label)
        : (r.result.mechanism !== "observe" ? [`${s.label}: mechanism !== "observe"`] : []);
    if (errs.length && s.knownGap) {
      gapNotes.push(`[known gap] ${s.label}: ${errs.length} envelope issue(s) — ${s.knownGap}`);
      return;
    }
    if (!errs.length && s.knownGap) {
      assert.fail(`${s.label} now passes its envelope checks — REMOVE its knownGap flag in conformance.test.mjs`);
    }
    assert.deepEqual(errs, []);
  });

  if (s.tier === "spatial" && s.unloadedArgs) {
    test(`${s.label}: honest over ungenerated space`, async () => {
      const r = await call(name, s.unloadedArgs);
      const errs = [];
      if (!r.ok) {
        // A refusal that NAMES the problem is honest too (fail-fast beats a guessed verdict).
        assert.match(String(r.error), /ungenerated|unloaded|not.*generated|no.*chunk/i,
          `${s.label} errored over ungenerated space without naming why: ${JSON.stringify(r.error)}`);
        return;
      }
      const cov = r.result.coverage;
      if (cov) {
        if (cov.state === "complete") errs.push(`coverage.state "complete" over never-generated chunks`);
        if ((cov.chunks?.ungenerated ?? 0) === 0 && cov.unloaded === 0) {
          errs.push(`neither chunks.ungenerated nor unloaded counted over never-generated space`);
        }
      } else if (!s.knownGap) {
        errs.push(`no coverage block on an ungenerated-space read`);
      }
      if (s.verdict && r.result[s.verdict] !== null) {
        errs.push(`verdict "${s.verdict}" is ${JSON.stringify(r.result[s.verdict])} over unread space — must be null`);
      }
      if (errs.length && s.knownGap) {
        gapNotes.push(`[known gap] ${s.label}: ${errs.join("; ")} — ${s.knownGap}`);
        return;
      }
      assert.deepEqual(errs, [], `${s.label} over ungenerated space: ${JSON.stringify(r.result).slice(0, 400)}`);
    });
  }
  }
}
