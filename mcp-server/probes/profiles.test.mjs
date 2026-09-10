// Manifest-profile probes (MCPTK_PROFILE) — the tool-bill lever.
//
// The static tool prefix is re-read every turn and measures 50-92% of the bill, so the cheapest
// saving is not shipping a session tools its role never calls. These tests defend the two ways that
// can go wrong silently:
//
//   1. A profile that hides NOTHING (typo'd names, renamed tools) still looks like a profile. Every
//      name a profile hides must exist in the live manifest.
//   2. A profile that hides something load-bearing. The keep-sets below are the measured verdicts:
//      `get_region_summary` (LOO -13) and `check_path` (-6) survive every profile, and `locate` —
//      which absorbed get_blocks_at's job 1:1 in run 18-03-57 — survives every profile too, because
//      hiding the middle-tier reads is only safe while the bottom tier is present.
//   3. (0.107.0, RELEASE_1.md §C) The DEFAULT quietly excluding a tool nobody classified. A
//      keep-list's cheap failure mode is silence, and in the default that silence is invisible to
//      everyone at once — four §D tools shipped and no keep-list inherited any of them. `modding`
//      therefore declares its complement, the shim warns on stderr about any live manifest name in
//      neither half, and the case below turns that warning into a red.
//   4. (0.107.0) A profile whose NAME makes a claim its list does not keep. `inspect` says
//      read-only; the bridge stamps a `mechanism` on every tool in GET /tools, so that claim is
//      checked per name against the live manifest rather than believed.
//
// The three keep-list ROLES (`modding`, `screens`, `inspect`) are arbitrated here because their
// invariants are profile invariants — the default, the complement, the read-only claim. `authoring`,
// `art` and `rocketeer_authoring` keep their own probe files, which price them against captured
// manifests; this file never prices anything, it only ratchets shape.
//
// Run: npm run test:live (needs the dev server).

import { test, before } from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIM = join(HERE, "..", "index.mjs");
const BASE = process.env.MCPTK_URL || "http://127.0.0.1:25599";

/** Start the shim under a profile and ask it for tools/list over stdio.
 *  profile === null runs with MCPTK_PROFILE unset — whatever the shim defaults to. */
function listTools(profile) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, MCPTK_HIDE_TOOLS: "", MCPTK_BLOCKBENCH: "off" };
    if (profile === null) delete env.MCPTK_PROFILE;
    else env.MCPTK_PROFILE = profile;
    const p = spawn(process.execPath, [SHIM], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => { p.kill(); reject(new Error(`timeout (${profile}); stderr: ${err}`)); }, 20_000);
    p.stdout.on("data", (d) => {
      out += d.toString();
      for (const line of out.split("\n")) {
        if (!line.trim().startsWith("{")) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 2 && msg.result?.tools) {
          clearTimeout(timer);
          p.kill();
          resolve({
            names: new Set(msg.result.tools.map((t) => t.name)),
            tools: msg.result.tools, // schema-level assertions (bot_scan's sweep args)
            stderr: err,
          });
        }
      }
    });
    p.stderr.on("data", (d) => { err += d.toString(); });
    p.on("error", reject);
    const send = (o) => p.stdin.write(JSON.stringify(o) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "probe", version: "0" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  });
}

/** Start the shim under a profile and make ONE tools/call. Memory is pointed at a throwaway dir so
 *  behavior probes never read or write the real store. Resolves {isError, text}. */
function callThroughShim(profile, tool, args) {
  return new Promise(async (resolve, reject) => {
    const env = { ...process.env, MCPTK_HIDE_TOOLS: "", MCPTK_BLOCKBENCH: "off", MCPTK_PROFILE: profile,
      MCPTK_MEMORY_DIR: await mkdtemp(join(tmpdir(), "mcptk-profile-probe-")) };
    const p = spawn(process.execPath, [SHIM], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => { p.kill(); reject(new Error(`timeout calling ${tool}; stderr: ${err}`)); }, 30_000);
    p.stdout.on("data", (d) => {
      out += d.toString();
      for (const line of out.split("\n")) {
        if (!line.trim().startsWith("{")) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 2 && msg.result) {
          clearTimeout(timer);
          p.kill();
          resolve({
            isError: msg.result.isError === true,
            text: msg.result.content?.find((c) => c.type === "text")?.text ?? "",
          });
        }
      }
    });
    p.stderr.on("data", (d) => { err += d.toString(); });
    p.on("error", reject);
    const send = (o) => p.stdin.write(JSON.stringify(o) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "probe", version: "0" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } });
  });
}

let full;
// Most of this file only reads tools/list, which needs no world. The two BEHAVIOUR tests below call
// through the shim into the game and need a loaded one — probing a client sitting at the title screen
// otherwise reds with "no server running", which reads as a broken profile rather than a missing
// world. Detected once here and used to skip precisely those, because a red that means "wrong
// environment" is the defect class that cost four false reds on the 0.32.0 locate probes.
let worldUp = false;
let manifest;
let mechanismOf;
before(async () => {
  const res = await fetch(`${BASE}/tools`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
  if (!res?.ok) throw new Error("no bridge — start the dev server first");
  const ping = await fetch(`${BASE}/cmd`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool: "ping", args: {} }),
  }).then((r) => r.json()).catch(() => null);
  worldUp = ping?.result?.serverRunning === true;
  if (!worldUp) {
    console.log("  [note] no world loaded — skipping the two in-game behaviour tests (surface tests still run)");
  }
  full = await listTools("full");
  assert.ok(full.names.size > 40, `full profile served only ${full.names.size} tools`);
  // The RAW bridge manifest, not the shim's tools/list: the shim maps each entry down to
  // {name, description, inputSchema} for MCP, which drops the `mechanism` stamp the read-only
  // claim below is checked against. This is the only place that stamp is reachable from a probe.
  manifest = await fetch(`${BASE}/tools`).then((r) => r.json());
  mechanismOf = new Map(manifest.map((t) => [t.name, t.mechanism]));
});

// A no-op hide is not a profile — but "absent from THIS manifest" is not the same fact as "dead",
// and reading it as one nearly cost the toolkit a legality hide. The six villagejobs names this
// check flagged in 2026-08 are live extension tools (VillageJobsTools.java); they were absent only
// because the attached game hosts no villagejobs, and pruning them to make this test green would
// have unhidden place_blocks under survival. index.mjs exempts both conditionally-present surfaces
// (CLIENT_SURFACE, EXTENSION_SURFACE) for that reason, and what remains here is the real defect
// class: a name nobody registers anywhere.
//
// Every profile is checked and the failures are reported TOGETHER. Asserting inside the loop meant
// the run died on the first bad profile, so the question "how many profiles are wrong" had no
// answer — and survival, which carried one of the six, was never reached.
test("every profile hides only names that exist — a no-op hide is not a profile", async () => {
  const bad = [];
  for (const profile of ["standard", "entity", "play", "survey", "survival"]) {
    const { stderr } = await listTools(profile);
    if (/not in this manifest/.test(stderr)) bad.push(`  ${profile}: ${stderr.trim()}`);
  }
  assert.deepEqual(bad, [],
    `${bad.length} profile(s) hide names the manifest doesn't have:\n${bad.join("\n")}`);
});

test("profiles are strictly nested: survey ⊂ play ⊂ full", async () => {
  const play = (await listTools("play")).names;
  const survey = (await listTools("survey")).names;
  for (const n of play) assert.ok(full.names.has(n), `play serves "${n}" which full does not`);
  for (const n of survey) assert.ok(play.has(n), `survey serves "${n}" which play does not`);
  assert.ok(survey.size < play.size, "survey must be smaller than play");
  assert.ok(play.size < full.names.size, "play must be smaller than full");
});

// `standard` sits OUTSIDE the role chain by design: it keeps the dev surface play drops, and drops
// block reads play keeps. It is full minus the measured-substitutable block reads and the authoring
// surface, nothing else.
test("standard ⊂ full, and the difference is the swapped block reads plus the authoring surface", async () => {
  const standard = (await listTools("standard")).names;
  for (const n of standard) assert.ok(full.names.has(n), `standard serves "${n}" which full does not`);
  const dropped = [...full.names].filter((n) => !standard.has(n)).sort();
  // `stage_entity` joined this list in 0.90.0 and is the one entry here that is NOT a substitution:
  // nothing else answers "put this geometry on a body". It is hidden because an entry is re-read
  // every turn by every session (TOKEN_PER_TOOL_FINDINGS.md finding 1) and a session that is not
  // authoring an entity never calls it — the `entity` profile is how an authoring session gets it.
  assert.deepStrictEqual(dropped, ["describe_box", "get_blocks_at", "get_surface", "stage_entity"],
    `standard must drop exactly the three block reads and the authoring surface, got: ${dropped.join(", ")}`);
  // The reads it keeps that survey drops — entity/sightline substitution is reasoned, not benched.
  for (const t of ["raycast", "raycast_fan", "get_entities"]) {
    assert.ok(standard.has(t), `standard must keep "${t}" until a play/combat bench measures it`);
  }
  assert.ok(standard.has("hotswap_class"), "standard keeps the dev surface — it is the workbench default");
});

// --- the modder default (RELEASE_1.md §C2/§C3) --------------------------------------------------

test("the default profile (MCPTK_PROFILE unset) is modding", async () => {
  // Moved from `standard` at 0.107.0. `standard` was chosen by a NAVIGATION bench and withholds the
  // three block reads on a substitution argument that does not transfer to a session authoring
  // geometry — which is why `menagerie`, naming no profile, silently could not read a block back.
  // Asserted rather than commented because the default is what every unconfigured consumer gets,
  // and nothing else in the tree states it.
  const dflt = (await listTools(null)).names;
  const modding = (await listTools("modding")).names;
  assert.deepStrictEqual([...dflt].sort(), [...modding].sort(),
    "unset MCPTK_PROFILE must serve exactly the modding manifest");
});

test("the default can perform the authoring round trip that named this section", async () => {
  // RELEASE_1.md §C2, and the whole reason the default moved. `describe_box detail:"layers"` ->
  // legend -> `set_blocks` grid (STRUCTURE_AUTHORING_DESIGN.md §9.3): the per-state legend was
  // built to be written back and the default profile could not read it. Both halves, asserted as a
  // pair, so that closing one and losing the other is a red rather than a regression nobody sees.
  const { names } = await listTools(null);
  for (const t of ["describe_box", "get_blocks_at", "get_surface", "set_blocks", "place_shape",
    "capture_structure", "undo_edit"]) {
    assert.ok(names.has(t), `the modder default must serve "${t}"`);
  }
});

test("the default declares its complement — no live tool is silently excluded", async () => {
  // The §C5 mechanism. A keep-list excludes a NEW tool silently and by design; in the default that
  // is invisible to every party at once, which is how query_class, get_perf, roll_loot and
  // preview_worldgen shipped with no keep-list inheriting any of them for weeks. index.mjs warns on
  // stderr when a live manifest name is in neither MODDING_KEEP nor MODDING_EXCLUDED; this turns
  // that warning into a red, so the classification is owed at the moment the tool is added.
  //
  // Note this asserts against the LIVE manifest of whatever game is attached — including extension
  // mods. That is deliberate: a new extension's tools SHOULD demand a line saying whether the modder
  // default carries them. EXTENSION_SURFACE names the six villagejobs verbs already answered.
  const { stderr } = await listTools("modding");
  const line = stderr.split("\n").find((l) => /in neither MODDING_KEEP nor MODDING_EXCLUDED/.test(l));
  assert.equal(line, undefined,
    `the default silently excludes tool(s) nobody classified — add each to MODDING_KEEP or `
    + `MODDING_EXCLUDED in index.mjs:\n  ${line}`);
});

test("the default drops the body, and says how to get it back", async () => {
  // The largest single saving in the profile, and the one behaviour change a workbench copilot
  // feels. Authoring content and driving a drone are different sessions; the body is 28 entries
  // re-read every turn. The refusal must be the widen-able one, never "Unknown tool" — a copilot
  // that reads "unknown" goes hunting a toolkit bug for something that is neither.
  const { names } = await listTools("modding");
  for (const t of ["bot_goto", "bot_mine", "bot_target", "bot_scan", "sense_entities"]) {
    assert.ok(!names.has(t), `the modder default must not carry body verb "${t}"`);
  }
  const r = await callThroughShim("modding", "bot_goto", {});
  assert.equal(r.isError, true);
  assert.match(r.text, /profile_hidden/, `a hidden name must refuse as profile_hidden: ${r.text}`);
  assert.match(r.text, /tool_surface/, "the refusal must name the verb that widens the surface");
});

// --- screens: the UI/screens role (RELEASE_1.md §C3) --------------------------------------------

test("screens is the only profile that KEEPS the client surface", async () => {
  // CLIENT_SURFACE existed only as a hide-set: every role took the client tools away and no role
  // kept them, so the toolkit had a screens capability and no screens session. Conditional on a
  // client being attached — headless, `full` carries none of these and the case is vacuously true,
  // which is honest rather than skipped: the assertion is "screens keeps what full has".
  const screens = (await listTools("screens")).names;
  const clientTools = ["get_screen", "get_screen_graph", "click", "set_text", "send_keys",
    "open_screen", "close_screen", "measure_text", "check_layout"].filter((t) => full.names.has(t));
  for (const t of clientTools) {
    assert.ok(screens.has(t), `screens must serve client tool "${t}"`);
  }
  for (const profile of ["modding", "authoring", "inspect", "play", "survey", "survival"]) {
    const { names } = await listTools(profile);
    for (const t of clientTools) {
      assert.ok(!names.has(t), `profile "${profile}" must hide client tool "${t}"`);
    }
  }
  // It owns the client process, so it owns the door in and the door out.
  for (const t of ["push_asset", "reload_resources", "push_data", "reload_data"]) {
    assert.ok(screens.has(t), `screens must serve "${t}" — a screen is made of assets and data`);
  }
  // ...and it is a SCREENS session, not a world one: no block writes, no body.
  for (const t of ["set_blocks", "place_shape", "run_command", "bot_goto", "describe_box"]) {
    assert.ok(!screens.has(t), `screens must not serve "${t}"`);
  }
});

// --- inspect: the read-only inspector (RELEASE_1.md §C3) ----------------------------------------

test("inspect is read-only, checked against the manifest's own mechanism stamp", async () => {
  // "Read-only" is a CLAIM, and a hand-written read-only list is one careless addition away from
  // being false. Every ToolDef declares a mechanism and the bridge stamps it into GET /tools, so
  // the claim is checked per name rather than believed. This is the case that makes the profile
  // worth having: without it `inspect` is just a smaller `modding` with a promising name.
  const { names } = await listTools("inspect");
  const violations = [...names]
    .filter((n) => mechanismOf.has(n))            // bridge tools only; locals carry no stamp
    .filter((n) => mechanismOf.get(n) !== "observe")
    .map((n) => `${n} (${mechanismOf.get(n)})`);
  assert.deepEqual(violations, [],
    `inspect claims read-only and serves ${violations.length} non-observe tool(s): ${violations.join(", ")}`);
  // The local tools carry no stamp, so they are named here by hand — and the memory WRITERS are the
  // whole point of naming them: mem_note/mem_place/mem_write_block/mem_dismiss/mem_task all write.
  for (const t of ["mem_note", "mem_place", "mem_write_block", "mem_dismiss", "mem_task",
    "launch_game", "tool_surface"]) {
    if (t === "tool_surface") {
      assert.ok(names.has(t), "tool_surface is never hidden by a profile — you cannot strand yourself");
      continue;
    }
    assert.ok(!names.has(t), `inspect must not serve the writing local tool "${t}"`);
  }
  // It must still be able to answer something: an inspector that reads nothing is not a profile.
  for (const t of ["describe_box", "get_blocks_at", "locate", "get_region_summary", "query_registry"]) {
    assert.ok(names.has(t), `inspect must serve read "${t}"`);
  }
});

// --- the experimental marking (RELEASE_1.md §C4) ------------------------------------------------

test("play, survey and survival announce themselves as EXPERIMENTAL on stderr", async () => {
  // Before 0.107.0 `grep -i experimental` over the shim hit exactly one comment about env hides: a
  // research profile looked precisely as blessed as a dev one from inside a session, and the stderr
  // line §C4 says "already announces the profile" did not exist at all — only the route layer
  // announced itself. Asserted on the channel a session's operator actually reads back.
  for (const profile of ["play", "survey", "survival"]) {
    const { stderr } = await listTools(profile);
    assert.match(stderr, new RegExp(`profile: ${profile} \\(experimental\\)`),
      `"${profile}" must name its kind on the start-up line`);
    assert.match(stderr, /EXPERIMENTAL: /,
      `"${profile}" must carry the experimental warning on its own line`);
  }
  for (const profile of ["modding", "authoring", "art", "screens", "inspect"]) {
    const { stderr } = await listTools(profile);
    assert.match(stderr, new RegExp(`profile: ${profile} \\(dev\\)`),
      `"${profile}" is a supported dev role and must say so`);
    assert.doesNotMatch(stderr, /EXPERIMENTAL: /,
      `"${profile}" must not be marked experimental`);
  }
  for (const profile of ["full", "standard", "entity"]) {
    const { stderr } = await listTools(profile);
    assert.match(stderr, new RegExp(`profile: ${profile} \\(bench\\)`),
      `"${profile}" is a bench configuration, not a role`);
  }
});

// --- entity: standard + the authoring surface (ENTITY_AUTHORING_DESIGN.md §5.2) ----------------

test("entity is standard plus exactly the authoring surface", async () => {
  const entity = (await listTools("entity")).names;
  const standard = (await listTools("standard")).names;
  for (const n of entity) assert.ok(full.names.has(n), `entity serves "${n}" which full does not`);
  const added = [...entity].filter((n) => !standard.has(n)).sort();
  assert.deepStrictEqual(added, ["stage_entity"],
    `entity must add exactly the authoring surface to standard, got: ${added.join(", ")}`);
  const removed = [...standard].filter((n) => !entity.has(n));
  assert.deepStrictEqual(removed, [],
    `entity must not take anything away from standard, lost: ${removed.join(", ")}`);
});

test("stage_entity is served by `entity` and `full` and by nothing else", async () => {
  // The whole point of the profile. If any role profile picks the tool up by accident, every
  // session in that role pays its manifest entry on every turn for a verb it never calls — which
  // is the exact cost this profile exists to avoid, arriving silently.
  assert.ok(full.names.has("stage_entity"),
    "full serves every tool — a missing stage_entity means the game is running an older jar");
  assert.ok((await listTools("entity")).names.has("stage_entity"),
    "the entity profile must serve the tool it exists for");
  for (const profile of ["standard", "play", "survey", "survival"]) {
    const { names } = await listTools(profile);
    assert.ok(!names.has("stage_entity"), `profile "${profile}" must hide stage_entity`);
  }
});

test("get_log is a DEV read: served by the dev profiles, hidden from every role profile", async () => {
  // It answers "what did the SERVER PROCESS complain about" — a question a body does not have and
  // a play/survey role never needs. The matching `error` events are withheld from player-legal
  // sessions at the source (EventTools); this is the manifest half of the same rule, so the two
  // cannot drift apart into a tool that is served but answers nothing.
  assert.ok(full.names.has("get_log"),
    "full serves every tool — a missing get_log means the game is running an older jar");
  for (const profile of ["standard", "entity"]) {
    assert.ok((await listTools(profile)).names.has("get_log"),
      `the dev profile "${profile}" must serve get_log — it is the read half of push_data/reload_data`);
  }
  for (const profile of ["play", "survey", "survival"]) {
    const { names } = await listTools(profile);
    assert.ok(!names.has("get_log"), `profile "${profile}" must hide get_log`);
  }
});

test("no profile hides a measured load-bearing tool", async () => {
  // From TOOL_VALUE_LOO.md and TOOL_BILL_PLAN.md §6c. `locate` is on this list because the middle-
  // tier cut is only safe while the bottom tier survives — the first swap attempt scored 0% on
  // point identity precisely because nothing was left that could answer it.
  const MUST_SURVIVE = ["get_region_summary", "check_path", "check_site", "locate", "anchors"];
  for (const profile of ["standard", "entity", "play", "survey"]) {
    const { names } = await listTools(profile);
    for (const t of MUST_SURVIVE) {
      assert.ok(names.has(t), `profile "${profile}" hides load-bearing tool "${t}"`);
    }
  }
});

test("survey drops the middle tier but keeps the only line-of-sight read", async () => {
  const { names } = await listTools("survey");
  for (const t of ["get_surface", "get_blocks_at", "describe_box", "raycast_fan", "get_entities"]) {
    assert.ok(!names.has(t), `survey should hide middle-tier read "${t}"`);
  }
  // Hiding raycast benched neutral, but no rung tests occlusion — it stays as cheap insurance.
  assert.ok(names.has("raycast"), "raycast is the only occlusion-respecting read; survey keeps it");
  // survey drops the embodied surface, and "embodied" means every verb that acts through a body —
  // including the one added after the EMBODIED list was written. bot_container escaped that list
  // for four days and survey served it alone among the body verbs (found by the 2026-08-11 audit).
  for (const t of ["bot_goto", "bot_mine", "bot_container"]) {
    assert.ok(!names.has(t), `survey drops the embodied surface; "${t}" must be hidden`);
  }
});

test("play keeps entity and sightline reads — that substitution is reasoned, not benched", async () => {
  const { names } = await listTools("play");
  for (const t of ["get_entities", "raycast", "raycast_fan"]) {
    assert.ok(names.has(t), `play must keep "${t}" until a play/combat bench measures it`);
  }
  assert.ok(!names.has("hotswap_class"), "play should drop the dev surface");
  // Client tools are copilot/dev surface for every non-workbench role.
  for (const t of ["get_screen", "click", "screenshot", "render"]) {
    if (full.names.has(t)) assert.ok(!names.has(t), `play must hide client tool "${t}"`);
  }
});

// --- survival: the player-legal surface (SURVIVAL_MODE_PLAN.md §3) -------------------------------

test("survival hides the X-ray, operator and dev surfaces — and nothing a player needs", async () => {
  const { names } = await listTools("survival");
  // `session_stop` is survival-ONLY on purpose, and is the one name this profile ADDS rather than
  // hides. It is the sanctioned end of the living loop: the Stop hook blocks a turn-end while the
  // body is alive in a running world, and the model needs a door it is allowed to walk through
  // (the previous door was "write a STOP_OK file", which the survival launch hard-denies — live,
  // session w1-75920 decided correctly to stop, tried Write, was refused, and sat there). There is
  // no living loop under `full`, so there is nothing for it to do there.
  const SURVIVAL_ONLY = new Set(["session_stop"]);
  for (const n of names) {
    if (SURVIVAL_ONLY.has(n)) continue;
    assert.ok(full.names.has(n), `survival serves "${n}" which full does not`);
  }
  for (const t of SURVIVAL_ONLY) {
    assert.ok(names.has(t), `survival must serve its own exit "${t}"`);
  }
  // No world truth, no world edits, no cheats, no dev bench.
  for (const t of ["get_entities", "scene_summary", "get_surface", "get_blocks_at", "describe_box",
    "get_region_summary", "run_command", "set_blocks", "place_blocks", "place_shape", "place_shapes",
    "undo_edit",
    "list_edits", "bot_give", "resolve_anchor", "check_site", "hotswap_class", "launch_game",
    // §5b: the WHOLE raycast family. The fan is the retina's sensor and bot_scan's; the single ray
    // was kept exposed at first and the agent used it to hand-re-implement the sense the profile
    // automates — endless single raycasts once the retina went quiet (second watched run). Looking
    // is automatic (retina) or embodied (bot_scan), never hand-aimed. Hidden ≠ illegal: both remain
    // legal provenance names in the observation store.
    "raycast_fan", "raycast",
    // bot_point is drone beam hardware; a player body has none, so under survival the tool can
    // only ever error (SURVIVAL_SMALL_MODEL_PLAN.md P2).
    "bot_point",
    // The MEASURED DEAD SURFACE trim (2026-08-11, index.mjs SURVIVAL_DEAD): three watched sonnet
    // hours, ~1,300 calls, and these seven were never reached for — at ~1,300 tokens of manifest
    // re-read on EVERY turn. Asserted so the trim cannot silently regrow; each name here is a
    // deliberate cut with its reason recorded next to the constant, not an accident.
    "anchors", "query_registry", "ping", "bot_profile", "bot_look", "bot_select", "bot_run",
    // Authoring surface: a body playing the world does not stage preview models of itself.
    "stage_entity"]) {
    assert.ok(!names.has(t), `survival must hide "${t}"`);
  }
  // The client surface reads/drives the HUMAN's screen (the 2026-07-30 smoke leak: the survival
  // agent's first call was get_screen — the player's own UI). Assert per name that is present in
  // full: on a client instance these are REAL hides, headless they are conditional no-ops.
  for (const t of ["get_screen", "click", "screenshot", "render", "set_text", "open_screen", "get_chat", "quit_game"]) {
    if (full.names.has(t)) assert.ok(!names.has(t), `survival must hide client tool "${t}"`);
  }
  // The legal senses, the body, and memory all survive. bot_scan (§5b) is the deliberate
  // look-around that replaces the hand-called fan, and bot_craft is how a player makes anything.
  // NOTE: `bot_profile` and `query_registry` used to be on this keep-list and were cut by the
  // 2026-08-11 trim — they are asserted HIDDEN above now. bot_profile lost its job when survival
  // locked perception to `perceived` (it could only ever echo); query_registry is reference surface
  // a player navigates without.
  for (const t of ["sense_entities", "bot_scan", "locate", "check_path", "bot_body",
    "bot_target", "bot_reactions", "bot_equip", "bot_eat", "bot_craft", "bot_status",
    "mem_recall", "mem_note", "mem_place", "send_chat"]) {
    assert.ok(names.has(t), `survival must keep "${t}"`);
  }
});

test("survival: locate is described as the memory search it actually is", async () => {
  // P1 (SURVIVAL_SMALL_MODEL_PLAN.md): the shim reroutes locate to the belief store, so serving
  // the bridge's X-ray description (pattern scans, POI occupancy, seed-proof negatives) described
  // a tool this profile refuses to be. The override must land, and the schema must stop
  // advertising the refused machinery.
  const { tools } = await listTools("survival");
  const locate = tools.find((t) => t.name === "locate");
  assert.ok(locate, "survival serves locate");
  assert.match(locate.description, /MEMORY/i, "survival locate must say it searches memory");
  // SURVIVAL_SENSES_DESIGN.md §1 — the diet's contract lines, and only those. The frontier
  // COACHING moved to the miss render (frontierLines), so the description must state the miss
  // CONTRACT (never proof) without re-teaching what the payload teaches at miss time.
  assert.match(locate.description, /never proof/i, "survival locate must state the miss contract");
  assert.match(locate.description, /observed:false/i,
    "survival locate must define observed:false as unknown, not air");
  assert.doesNotMatch(locate.description, /occupancy|biome/i,
    "survival locate must not describe the X-ray machinery it refuses");
  // `pattern` is served since SURVIVAL_SENSES_DESIGN §3 — but as the MEMORY pattern, and the schema
  // must describe that one, not the bridge's X-ray scan.
  const pat = locate.inputSchema?.properties?.pattern;
  assert.ok(pat, "survival locate schema must advertise the memory `pattern`");
  assert.match(pat.description ?? "", /remembered|unknown/i,
    "the pattern schema must describe the memory semantics (unknowns listed, not scanned)");
  // The diet must not regrow, and every argument must be discoverable from the description alone
  // (schema property text is demonstrably skimmed by small models).
  assert.ok(locate.description.length < 600,
    `survival locate description must stay under 600 chars (now ${locate.description.length})`);
  for (const p of Object.keys(locate.inputSchema?.properties ?? {})) {
    assert.ok(locate.description.includes(`\`${p}\``),
      `survival locate description must name \`${p}\` with an example`);
  }
  // The other overrides land too, and only under survival.
  const events = tools.find((t) => t.name === "get_events");
  assert.doesNotMatch(events.description, /audit|session_msg|drone_damaged/i,
    "survival get_events must not describe streams this profile never receives");
  const fullLocate = full.tools.find((t) => t.name === "locate");
  assert.match(fullLocate.description, /pattern/i, "full profile keeps the bridge locate description");
});

test("survival: bot_scan is served and sweeps without a hand-callable fan", async () => {
  // The §5b substitution, asserted as a pair: the fan is gone from the surface AND the verb that
  // replaces it is present with the shape the charter promises (direction/arc/pitch, no block data).
  const { names, tools } = await listTools("survival");
  assert.ok(names.has("bot_scan") && !names.has("raycast_fan") && !names.has("raycast"),
    "survival must serve bot_scan as the ONLY way to look, hiding the whole raycast family");
  const scan = tools.find((t) => t.name === "bot_scan");
  for (const p of ["direction", "arc", "pitch"]) {
    assert.ok(scan.inputSchema?.properties?.[p], `bot_scan must accept \`${p}\``);
  }
  // No body spawned: it must refuse honestly rather than inventing a sweep. The refusal may name the
  // missing BODY (world loaded) or the missing SERVER (probing a client at the title screen) — both
  // are honest, and pinning only the first would couple this to one environment, which is the defect
  // class that produced four false reds on the 0.32.0 probes.
  const r = await callThroughShim("survival", "bot_scan", {});
  if (r.isError) {
    assert.match(r.text, /body|server/i, `bot_scan without a body must say what is missing: ${r.text}`);
  }
});

test("survival: authoritative perception is unreachable", async () => {
  // This used to assert the `legal_profile_locked` refusal. The 2026-08-11 trim moved bot_profile
  // into SURVIVAL_DEAD, so the HIDDEN gate answers first and the verb is not callable at all — a
  // STRONGER guarantee, and the reason this test no longer needs a loaded world (the call never
  // reaches the bridge). The lock itself stays in index.mjs as the second line for the day the
  // verb is un-hidden; what is asserted here is the guarantee that is actually live.
  const r = await callThroughShim("survival", "bot_profile", { perception: "authoritative" });
  assert.equal(r.isError, true, "authoritative perception must be an error under survival");
  assert.match(r.text, /[Uu]nknown tool/,
    `bot_profile must be unreachable under survival, got: ${r.text}`);
});

// The world gate is evaluated INSIDE the body, not as `{ skip: !worldUp }`. node:test starts
// running the root suite while the module is still being evaluated, so an option computed at
// registration reads whatever `worldUp` held before the ASYNC before-hook resolved — always
// `false`, because that hook awaits two fetches and cannot finish during synchronous module
// evaluation. This test therefore never ran once, from the day it was written (verified on node
// v22.17.1: a computed skip behind an async before hook is baked in as true; a sync hook races and
// may not be). That is also why nobody noticed the sibling legal_profile_locked test going stale
// when the 2026-08-11 trim hid bot_profile — a dark test cannot report.
test("survival: locate is answered from memory, never the bridge's X-ray search", async (t) => {
  if (!worldUp) return t.skip("no world loaded — load one to exercise this");
  // A fresh session with an empty store: the legal answer is a frontier-carrying miss that names
  // itself remembered/legal — the bridge search would instead return live matches or a scan stamp.
  const r = await callThroughShim("survival", "locate", { what: "minecraft:chest", near: { x: 0, z: 0 } });
  assert.equal(r.isError, false, `legal locate errored: ${r.text}`);
  const body = JSON.parse(r.text);
  assert.equal(body.legal_profile, true, "the answer must come from the legal memory route");
  assert.equal(body.negative_is_proof, false);
  assert.ok(body.coverage, "a legal miss must carry the frontier");
});

test("an unknown profile fails loudly at startup", async () => {
  await assert.rejects(() => listTools("definitely-not-a-profile"));
});
