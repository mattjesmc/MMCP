#!/usr/bin/env node
// MCP server for the MCP Toolkit bridge.
//
// This process speaks the MCP protocol to the client (Claude) over stdio and forwards each tool call as
// JSON to the mod's in-game HTTP bridge (the `mcptoolkit` mod). The tool list is NOT hardcoded here: it
// is fetched from the bridge's `GET /tools` manifest, so any mod that registers tools onto the toolkit
// shows up automatically without touching this file.
//
// The mod must be running with the bridge enabled (dev environment, or -Dmcptoolkit.port=<port>).
// Bridge base URL defaults to http://127.0.0.1:25599; override with MCPTK_URL. The legacy VJ_MCP_URL
// (which pointed at the old /cmd endpoint) is still honored for compatibility.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { basename, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { localTools, isLocalTool, callLocalTool } from "./local/registry.mjs";
import {
  BLOCKBENCH_URL, fetchBlockbenchTools, isBlockbenchTool, hasBlockbenchManifest, dropBlockbenchNames,
  callBlockbench, blockbenchMechanism, setBlockbenchProfile, blockbenchWhere, blockbenchWindowNote,
  blockbenchWindow, blockbenchSession,
} from "./upstream/blockbench.mjs";
// The loop kit (LOOP_KIT_DESIGN.md §5): the image budget every picture goes through, and the
// project's loop file — post-call checks, a save gate, and a project profile with notes.
import { budgetContent, SHOT_MAX } from "./image/budget.mjs";
import { loadLoop, LoopChecks } from "./loop/loop.mjs";
import { isUnresolvableWhat, locateFromMemory } from "./memory/tools.mjs";
import { processWorldRead, attachRemembered } from "./memory/annotate.mjs";
import { captureActOutcome, captureProprioception } from "./memory/capture.mjs";

/**
 * The traversal trail has been captured — now take it OUT of what the model sees.
 *
 * MEASURED (live survival session, 2026-08-01): `traversed` was 15% of a 40-event page, rows like
 * [-745,63,-347,"minecraft:air","minecraft:air","minecraft:stone"], one per cell walked. And the
 * model was never its audience: `captureProprioception` above is the consumer, indexing it into the
 * observation store so that walking somewhere counts as having looked at it. It is a sensor writing
 * for the memory layer — exactly what the ambient retina is, and the retina is deliberately never
 * served into context (memory/ambient.mjs §2.3). This one was, by accident of riding the same
 * payload as the nav verdict.
 *
 * Replaced by a COUNT, never deleted silently: the agent is told the trail existed and where it
 * went, so "my walking is remembered" stays a legible fact rather than an invisible one.
 */
function consumeTrail(payload) {
  const cells = payload.traversed.length;
  delete payload.traversed;
  payload.traversed_cells = cells;
  payload.traversed_note = "the cells you walked went to memory, not to this reply — ask locate";
}
import { legalLocate } from "./memory/legal-locate.mjs";
import { recordOutcome } from "./memory/route-ledger.mjs";
import { tryRoute } from "./memory/route-exec.mjs";
import { routesMode } from "./memory/routes.mjs";
import { startAmbient } from "./memory/ambient.mjs";
import { asciiSurfaceView } from "./ablation/view.mjs";
import { SURVIVAL_OVERRIDES } from "./memory/survival-overrides.mjs";
import { noteDelivered, dangerDigest } from "./memory/danger.mjs";

// Resolved in bridge-base.mjs, not here: local/dev.mjs needs the same answer to tell a game it
// launches which port to bind, and a rule spelled out in two files is spelled out in one and stale
// in the other.
import { BASE } from "./bridge-base.mjs";

// --- the project loop file (LOOP_KIT_DESIGN.md §5.2/§5.3) ---------------------------------------
// Read ONCE, before the profile is chosen, because it can choose the profile: a workspace whose
// loop file declares a `profile` gets that as its default the way MCPTK_PROFILE would. A malformed
// file THROWS here rather than being skipped — a project that wrote one meant it, and a check that
// silently never fires is the exact failure the file exists to prevent.
const LOOP = loadLoop();
if (LOOP) {
  process.stderr.write(`[mcp-toolkit] loop file: ${LOOP.path} — ${LOOP.checks.length} check(s)`
    + `${LOOP.profile ? `, project profile (base ${LOOP.profile.base}`
      + `${LOOP.profile.keep ? `, ${LOOP.profile.keep.size} kept` : ""}`
      + `, ${Object.keys(LOOP.profile.notes).length} note(s))` : ""}\n`);
}

// --- ablation feature flags -----------------------------------------------------------------------
// MCPTK_HIDE_TOOLS: comma-separated tool names this session must behave as if they don't exist —
// hidden from tools/list (bridge-proxied AND local) and rejected on call, so a model that knows a
// name from prior context still can't use it. This is the testbench's with/without-arm switch
// (testbench/run-tasks.mjs); it is not a permission mechanism.
const HIDDEN = new Set(
  (process.env.MCPTK_HIDE_TOOLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

// The operator's hides, kept apart from the profile's. `tool_surface` REBUILDS the hidden set on a
// live switch, and MCPTK_HIDE_TOOLS is the bench's with/without arm (testbench/run-tasks.mjs) — a
// session that re-profiled itself back into surface its experimental condition removed would report
// the wrong arm, silently. These win over everything, including the never-hide rule below.
const ENV_HIDDEN = new Set(HIDDEN);

// MCPTK_PROFILE: which slice of the manifest this session sees. The static tool prefix is re-read
// EVERY turn and measures 50-92% of the bill (TOKEN_PER_TOOL_FINDINGS.md Finding 1), so the single
// cheapest lever is not shipping a session tools its role never calls. Composes with (adds to)
// MCPTK_HIDE_TOOLS. Rationale, prices and the evidence per profile: TOOL_BILL_PLAN.md.
//
// THE SET IS AUTHORED FROM ROLES, and the roles are grouped here because which group a profile is
// in is the thing a reader needs first (RELEASE_1.md §C1):
//
//   SUPPORTED DEV ROLES — the release surface. Keep-lists, every one of them: a keep-list cannot
//     drift the way a hide-list does (a renamed tool simply stops being kept) and it fails toward
//     TOO LITTLE surface, which is visible to the agent and one `tool_surface` call from being
//     fixed, where too much surface is invisible and nothing reports it.
//       modding (DEFAULT) — the modder attached to a running game: author blocks, data, structures
//                      and assets against it, read them back, hot-swap, look at the result. This is
//                      the profile an unconfigured session gets, and the only one that DECLARES ITS
//                      COMPLEMENT (see MODDING_EXCLUDED) — a default whose exclusions are silent is
//                      a default nobody can audit.
//       authoring    — the block-authoring slice of it: build, read back, capture to a datapack.
//       art          — model authoring, spanning the Blockbench upstream and the thin arm that
//                      gets the result into the running game.
//       screens      — the UI/screens session: drive and read the client's own widgets, push and
//                      reload the assets behind them. The only profile that KEEPS the client
//                      surface; everywhere else it is hidden (see CLIENT_SURFACE).
//       inspect      — the read-only inspector. Every tool it serves is `mechanism: "observe"`,
//                      which is a claim the manifest itself carries and probes/profiles.test.mjs
//                      checks per name rather than trusting this list.
//       rocketeer_authoring — `authoring` plus one extension mod's verdict verbs.
//
//   THE BENCH LADDER — hide-lists, measured, and NOT roles. They exist so bench arms stay
//     comparable across releases; `standard` in particular was chosen by a NAVIGATION bench and is
//     the reason it withholds the block reads an authoring session needs. It stopped being the
//     default at 0.107.0 (RELEASE_1.md §C2) and stays exactly as benched.
//       full         — everything; the pre-0.28.0 default. Bench baselines pin this explicitly
//                      (testbench/agent.mjs) so arms stay comparable across the flip.
//       standard     — the locate surface, below.
//       entity       — `standard` plus the entity-authoring surface.
//
//   EXPERIMENTAL RESEARCH ROLES — `play`, `survey`, `survival`. Shipped, real, and NOT part of the
//     supported developer surface: they exist to run experiments about embodied agents, they carry
//     owed live runs, and their shape is decided by bench results rather than by a modder's job.
//     Marked in the software and not only in conversation (RELEASE_1.md §C4): EXPERIMENTAL below,
//     in PROFILE_META, on the start-up stderr line, in `ping`'s `profile` block and in
//     `tool_surface`'s report. `survival` is additionally a LEGALITY CONTRACT, not a filter — see
//     CAN_SWITCH_PROFILE.
//
//   standard         — the locate surface (TOOL_BILL_PLAN.md §4b, adopted 2026-07-29): the block
//                      reads whose jobs the bottom tier absorbed at measured parity are not shipped
//                      (§6c: two-way `locate` for point identity, `get_region_summary` for
//                      aggregates, `check_site` for volume predicates). Entity and sightline reads
//                      stay — that substitution is reasoned, not benched (no rung exercises
//                      occlusion or entity queries) — as does the full dev/embodied surface.
//   play  (EXPERIMENTAL) — dev/admin surface removed. Entity and sightline reads KEPT: the swap arm
//                      measured terrain/geometry rungs only, so substituting `locate what:hostile`
//                      for get_entities is reasoned, not benched, and a companion does that work.
//   survey (EXPERIMENTAL) — the measured-neutral configuration: also drops the embodied/combat surface
//                      and the middle-tier raw reads (97% vs 97%, ~5% cheaper, 1:1 locate-for-
//                      get_blocks_at substitution confirmed in the call log, run 18-03-57).
//                      `raycast` is deliberately KEPT: hiding it benched neutral, but no rung tests
//                      occlusion and it is the only line-of-sight read in the toolkit.
//   entity           — `standard` plus the entity-authoring surface (ENTITY_AUTHORING_DESIGN.md
//                      §5.2). stage_entity is hidden EVERYWHERE ELSE, this profile included in
//                      `full`: it is an authoring verb, and a session that is not authoring an
//                      entity pays its manifest entry every turn for a tool it will never call.
//                      `MCPTK_PROFILE=entity` in the authoring workspace's .mcp.json turns it on.
//   survival (EXPERIMENTAL) — the player-legal surface (SURVIVAL_MODE_PLAN.md §3; PLAYER_CONTROL_DESIGN
//                      §9's tool-surface enforcement, finally server-side): dev surface, the
//                      operator/world-edit tools, and every X-ray read hidden. What remains
//                      perceives like a player: sense_entities, the raycast pair, memory, and the
//                      embodied bot_* verbs. `locate` stays but is answered from provenance-
//                      filtered observations, never the bridge's X-ray search; `bot_profile` is
//                      locked to perceived; `check_path` is a flagged legality edge (plan §2).
// The world-model research surface: the toolkit-side half of a project that is its own repository
// (RELEASE_1.md §F9, and `com.mattmc.mcptoolkit.wm`'s package-info). ONE site of record, because
// these six have to be absent from more than one list and a name repeated per list is a name that
// drifts out of one of them.
//
// They are withheld from every dev profile and every experimental one. `full` and `standard` keep
// them and that is deliberate: those two are bench arms pinned by measurement (ablation/conditions),
// and moving an arm to tidy a manifest invalidates the ladder every tool-bill number was measured
// on. `entity` keeps them too, and that one is a CONSEQUENCE rather than a choice: profiles.test.mjs
// pins `entity` as "standard plus exactly the authoring surface, taking nothing away", so anything
// standard carries it carries. Taking these six out of it was tried and the probe refused it, which
// is the invariant doing its job. The entity-authoring workspace therefore still meets this surface;
// closing that properly means giving it a keep-list profile of its own rather than defining it as a
// delta on a frozen bench arm (RELEASE_1.md §F9 records it as the one residual).
//
//   human_task / human_task_cancel — the §15 task presenter: tasks a HUMAN player. Operator surface;
//     an agent that is itself the embodied player must never be able to command the human. The
//     LLM-driven-execution mode runs it from a full/standard strategist session, not from `survival`.
//   wm_verdict — the referee's predicate probe (phase 3): evaluates would-be verdicts against the
//     live world. Dev/probe surface only; an agent asking "would this count as done" must do it
//     embodied.
//   wm_obsgap — the obs-gap ring probe (phase 5): the recorder-quality metric's headless seam,
//     never a sense.
//   wm_session_tag / wm_perturb — the R-block's two dev tools (V3_PLAN.md §3 R-b, §4.3 tier 1).
//     Both are DRIVER surface and both are self-harm in the hands of the body being recorded.
//     `wm_session_tag` stamps the running session's corpus purpose: an embodied agent tagging its
//     own run `battery` silently deletes that run from training (battery sessions are excluded
//     outright), and `eval` poisons the held-out set the whole §5 test protocol rests on — the
//     DRIVER tags the session once at start-up (battery.ps1, taskgen.mjs, human-session.mjs, the
//     survival launcher), never the subject. `wm_perturb` hijacks a navigating body's own inputs;
//     a body that can request its own perturbation is authoring the recovery demonstration it
//     exists to be caught by. Hiding them is also a token win on the budgeted survival manifest,
//     but the admission integrity is the reason.
const WM_RESEARCH = ["human_task", "human_task_cancel", "wm_verdict", "wm_obsgap",
  "wm_session_tag", "wm_perturb"];
const DEV_ONLY = [
  "hotswap_class", "push_data", "reload_data", "clear_data", "list_data", "launch_game", "open_world",
  // create_world (0.130.0) is open_world's sibling for the same reason: making a save on somebody's
  // client is a dev act.
  "create_world",
  // The game's own log. A DEV read, not a sense: it answers "what did the SERVER PROCESS complain
  // about", which is a question no body has and no play/survey role needs. The legality filter in
  // EventTools already withholds the matching `error` events from a player-legal session, so this
  // is the manifest half of the same rule.
  "get_log",
  // Where the tick is going (0.95.0). Same line, same reason: it answers "what is this SERVER
  // PROCESS spending its 50 ms on", which is a modder's question about an implementation, not a
  // sense any body has. Its profile mode is vanilla's /debug profiler, which is admin surface in
  // vanilla too.
  "get_perf",
  // Rolling a loot table to see what comes out (0.101.0). A modder's question about DATA THEY ARE
  // AUTHORING, and an oracle in a play session: given a container's own lootTableSeed it reports the
  // exact contents of a chest nobody has opened, which is X-ray by a different door. Dev surface on
  // both counts, and it rides beside push_data/query_registry, which are the two calls before it.
  "roll_loot",
  // Asking the LOADED chunk generator what it would make, generating nothing (0.103.0,
  // WORLDGEN_ITERATION_DESIGN.md phase 1). Dev surface on roll_loot's exact reasoning: it is an
  // ORACLE. It reports the shape of ground that has never been generated - what is over the
  // horizon, and past the far side of it - which is X-ray by a third door, and inside a perception
  // tool it would ride into every play, survey and survival turn.
  "preview_worldgen",
  // Reflection over the RUNNING JVM's class table (0.96.0). A modder's question about an
  // implementation - which mixins merged, what the post-transform table looks like - and one no
  // body has. Rides beside hotswap_class, which it prechecks.
  "query_class",
  // Writes a structure .nbt into the live world datapack: the same authority as push_data, arriving
  // by a different door (the payload is the world instead of the caller's bytes).
  "capture_structure",
  // ...and its write half (0.92.0). Same reason, same side of the line: putting authored datapack
  // content into the world is a modder's verb, not a player's, and a body has no business with it.
  "place_structure",
  "import_building", "edit_building", "save_building", "list_buildings", "get_region",
  // companion_spawn, companion_stop and session_send were archived with the launcher (toolkit
  // 0.143.0); session_list survives and stays hidden here for the reason the others were - a
  // body playing the game has no business reading the operator's session table.
  "session_list",
  // The review layer (mcp-toolkit review/): posting an ask queues COMMANDS that later run at the
  // console's own authority, and reading the queue is reading what a human was asked to judge —
  // operator surface on both counts. An agent that is itself the embodied player must never be
  // able to task the person whose world it is playing in, which is the same rule human_task rides.
  "review_post", "review_status",
  ...WM_RESEARCH,
];
// Middle-tier reads: resolution views that answer no question on their own. `locate` (two-way)
// covers point identity, `get_region_summary` covers the aggregate. See TOOL_BILL_PLAN.md §6c.
// The block-read subset has a MEASURED 1:1 substitute and is what `standard` withholds; the
// entity/sightline pair rides only in `survey`, whose role provably never queries entities.
const SWAPPED_BLOCK_READS = ["get_surface", "get_blocks_at", "describe_box"];
const MIDDLE_TIER_READS = [...SWAPPED_BLOCK_READS, "raycast_fan", "get_entities"];
// Client-context tools — present in the manifest ONLY when a game client is attached. They read and
// drive the HUMAN's screen (get_screen literally returns the player's UI), so they are copilot/dev
// surface: hidden from every non-workbench role. Conditionally present, so hiding them headless is
// an expected no-op — the unknown-hide warning skips exactly this set.
const CLIENT_SURFACE = [
  "get_chat", "screenshot", "get_screen", "click", "set_text", "send_keys", "open_screen",
  "close_screen", "get_screen_graph", "screenshot_annotated", "measure_text", "check_layout",
  "push_asset", "reload_resources", "list_assets", "clear_assets", "quit_game",
  // `render` (0.105.0) is client-only for the reason every name above is: it drives the render loop.
  // It is NOT `screenshot` with arguments — nobody is standing anywhere, the HUD is excluded by
  // construction, and the resolution is a number the caller chose. RENDER_SEAM_DESIGN.md phase 1.
  "render",
  // `studio` (0.113.0) is client-only because the thing it does is move THIS CLIENT: the camera
  // photographs the level Minecraft.level is, so a shot in the studio is a trip there and back.
  // RENDER_SEAM_DESIGN.md §6, and §14 on why it is not an op on `render`.
  "studio",
  // `open_world` (0.105.0) is client-only AND dev-only, and it is in both lists for two different
  // reasons: here because only a client has a title screen to open a world FROM, and in DEV_ONLY
  // because loading a world out from under whoever is playing is not a thing any other role does.
  "open_world",
  // `create_world` (0.130.0): a title screen to create FROM, like open_world; `get_tooltip`
  // (0.130.0): the lines are rendered by THIS client's tooltip pipeline, with its player and level.
  "create_world", "get_tooltip",
];
// The manifest's `context` column (toolkit 0.129.0, RELEASE_1.md section K1) is the REGISTRY's own
// statement of which tools need a client: every ToolDef declares SERVER, CLIENT or ANY, and the
// bridge serves it lower-cased beside `mechanism`. CLIENT_SURFACE above is a hand list, and it has
// to stay one: the profiles are built from it at module load, before any manifest exists. So the
// column cannot be the list's source - it is the list's FALSIFIER. A tool the bridge marks client
// that the list does not name would be served to every headless role; a name here the bridge says
// answers headless would be hidden from them for nothing. Either is said once on stderr, the way an
// unknown hide is. A manifest with no column at all is an older bridge and says nothing. The column
// is consumed here and NOT forwarded (see `all` below): zero manifest cost, which is the K1 price.
// docs/platform/HEADLESS.md is the same column as a document (tools/headless-doc.mjs writes it);
// probes/context-column.test.mjs is this check offline, probes/headless-surface.test.mjs live.
let contextChecked = false;
function checkContextColumn(tools) {
  if (contextChecked || !tools.some((t) => typeof t.context === "string")) return;
  contextChecked = true;
  const hand = new Set(CLIENT_SURFACE);
  const unlisted = tools.filter((t) => t.context === "client" && !hand.has(t.name)).map((t) => t.name);
  const misfiled = tools.filter((t) => hand.has(t.name) && t.context !== "client").map((t) => t.name);
  if (unlisted.length) {
    process.stderr.write(`[mcp-toolkit] context column: ${unlisted.length} client-context tool(s) not in `
      + `CLIENT_SURFACE, served to headless roles: ${unlisted.join(", ")}\n`);
  }
  if (misfiled.length) {
    process.stderr.write(`[mcp-toolkit] context column: ${misfiled.length} CLIENT_SURFACE name(s) the bridge `
      + `says answer without a client: ${misfiled.join(", ")}\n`);
  }
}
// Extension-owned tools — present ONLY when the mod that registers them is attached (ToolDef.source
// stamps them; probes/extension.test.mjs asserts these exact six as villagejobs'). The hide-lists
// above name them because their AUTHORITY is dev/operator wherever they exist — import_building and
// friends edit the world's building NBTs, and place_blocks is a world write, which is why survival
// carries it in OPERATOR. Conditionally present for the same reason CLIENT_SURFACE is, so an absent
// one is the expected mod-not-loaded case rather than a typo'd hide.
//
// This set exists because the check that flags a no-op hide once concluded these six were DEAD and
// nearly had them pruned (2026-08-26). They were not: the attached game was mcp-toolkit's own, which
// hosts no villagejobs. Cutting them would have removed a legality hide — survival would have served
// place_blocks — to make a probe green. Absent from a manifest is not the same fact as gone.
const EXTENSION_SURFACE = [
  "import_building", "edit_building", "save_building", "list_buildings", "get_region", "place_blocks",
];
const EMBODIED = [
  "bot_body", "bot_target", "bot_tunnel", "bot_goto", "bot_look", "bot_follow", "bot_run", "bot_point",
  "bot_mine", "bot_place", "bot_use", "bot_attack", "bot_shoot", "bot_select", "bot_give",
  "bot_equip", "bot_eat", "bot_drink", "bot_reactions", "bot_craft", "bot_scan", "bot_surface",
  "bot_profile", "sense_entities", "bot_watch",
  // Added late (0.50.0) and missed by this list until the 2026-08-11 profile audit, so `survey` —
  // the profile whose whole point is dropping the embodied surface — was serving exactly one body
  // verb. It reaches into a container WITH THE BODY'S HANDS (conformance.test.mjs tiers it `act`
  // for that reason), so it belongs here. This changes the `survey` manifest by one tool versus
  // pre-0.70.1 runs; the bench is unaffected, because testbench/objective-scenario.mjs pins its own
  // EMBODIED_TOOLS list and hashes it into every result.
  "bot_container",
];
// The entity-authoring surface (ENTITY_AUTHORING_DESIGN.md §5.2). ONE tool, and it is hidden by
// default everywhere — including `standard`, the workbench default, which keeps the whole dev
// surface otherwise. That is the Finding 6 rule applied at the profile layer rather than the
// description layer: an entry is re-read every turn by every session that carries it, and staging a
// preview model is not something a session does incidentally. The `entity` profile is standard with
// this surface added back, which is the only profile that serves it besides `full`.
const ENTITY_SURFACE = ["stage_entity"];
// The survival profile's two extra hide-sets. OPERATOR is the copilot's editing/cheat surface — a
// player has no /give and no world edits. XRAY_READS is every read that answers from world truth
// rather than a body-anchored sightline; `raycast`/`raycast_fan` are the legal reads and stay.
const OPERATOR = [
  "run_command", "set_blocks", "place_blocks", "place_shape", "place_shapes", "undo_edit", "list_edits",
  "bot_give", "resolve_anchor", "check_site",
];
const XRAY_READS = [...SWAPPED_BLOCK_READS, "get_entities", "scene_summary", "get_region_summary"];
// MEASURED DEAD SURFACE (2026-08-11). Three watched sonnet hours — ~1,300 tool calls across four
// transcripts — used 23 of the 40 tools this profile exposes. These are the ones the charter never
// teaches and the body never reached for, at ~1,300 tokens of manifest re-read on EVERY turn:
//   anchors, query_registry — operator/reference surface; a player navigates by memory and sight.
//   ping                    — the shim reports the bridge; a player has no use for a health check.
//   bot_profile             — locked to `perceived` under survival, so it can only ever echo.
//   bot_look, bot_select    — looking is `bot_scan` or ambient; the hand auto-switches to the
//                             fastest harvesting tool (wrong-tool gate), so neither verb has a job.
//   bot_run                 — the batched queue is real, but the survival charter teaches goal-
//                             shaped `bot_target` instead and never mentions it. Unteachable
//                             surface is pure bill.
// DELIBERATELY NOT CUT, though equally dark in those hours:
//   bot_eat, bot_drink, bot_attack, bot_shoot, bot_equip — unused BECAUSE reflexes cover them, and
//     the same three hours proved a reflex can fire and fail (drown/no_surface_reachable, 13x, in a
//     sealed pocket). Cutting the manual path would leave nothing to fall back to.
//   bot_follow — kept at the owner's direction: tailing a player or another agent's body is a
//     capability class of its own, not a pathing helper. See its description for the legal way to
//     name a target under this profile (sense_entities, not get_entities).
//   mem_recent, mem_write_block, mem_dismiss — the memory protocol's hygiene verbs; the session-open
//     render asks for them by name (`compaction_due`, `[pending]`), and a woken session did use
//     mem_dismiss.
const SURVIVAL_DEAD = ["anchors", "query_registry", "ping", "bot_profile", "bot_look", "bot_select",
  "bot_run"];
const PROFILES = {
  full: [],
  standard: [...SWAPPED_BLOCK_READS, ...ENTITY_SURFACE],
  // standard + the authoring surface. Deliberately NOT a superset chain member: `entity` is a job,
  // not a rung on the role ladder play/survey/survival walk down.
  entity: SWAPPED_BLOCK_READS,
  play: [...DEV_ONLY, ...CLIENT_SURFACE, ...ENTITY_SURFACE],
  survey: [...DEV_ONLY, ...CLIENT_SURFACE, ...MIDDLE_TIER_READS, ...EMBODIED, ...ENTITY_SURFACE],
  // The WHOLE raycast family is hidden under survival (SURVIVAL_MODE_PLAN §5b): the ambient retina
  // fires the fan continuously and `bot_scan` sweeps it deliberately, so looking is automatic or
  // embodied — never a hand-aimed ray. Both stay LEGAL provenance names in the store (hidden ≠
  // illegal). `raycast` was kept exposed at first and that was a mistake: with the retina blinded by
  // the activity-window bug, the agent fell back to endless single raycasts, which is the manual
  // re-implementation of the sense the profile exists to automate (second watched run).
  // bot_point is drone beam hardware — the survival player body has none, so the tool can only
  // ever error there (haiku probe audit, SURVIVAL_SMALL_MODEL_PLAN.md P2).
  survival: [...DEV_ONLY, ...CLIENT_SURFACE, ...OPERATOR, ...XRAY_READS, "raycast_fan", "raycast",
    "bot_point", ...SURVIVAL_DEAD, ...ENTITY_SURFACE],
};
// KEEP-list profiles, and the difference from a hide-list is the whole point. Every hide-list above
// DRIFTS: the world moves underneath it, a mod stops loading, a tool is renamed, and the list goes on
// naming something that is not there — which is how six live villagejobs verbs were nearly pruned as
// dead (0.98.0). A keep-list cannot drift that way. An absent name is simply absent, and a NEW tool is
// excluded by default instead of silently inherited by a role that never asked for it.
//
// It fails in the SAFE direction, which is the reason to prefer it here: too little surface is
// visible to the agent and one call widens it, where too much surface is invisible and nothing
// reports it. The cost is that a genuinely useful new tool stays hidden until someone adds it, and
// that is the trade taken deliberately.
//
// `authoring`: build blocks, read them back, capture the result into a live datapack, look at it,
// undo. RE-MEASURED LIVE 2026-08-28 (RELEASE_1.md §C6) against a 94-tool manifest from a dev CLIENT:
// `full` is 104 tools / 179,503 chars / ~44.9k tok, `standard` is 100 / 169,279 / ~42.3k, and
// `authoring` is 34 / 51,379 / ~12.8k — a 70% cut off `standard`, ~29.5k tokens off EVERY turn. That
// is the single largest token lever the shim has (see [[token-per-tool]]: the static prefix is 50-92%
// of a session's bill, and until the tool list could change mid-session that lever was harness-level
// and out of reach).
//
// RE-MEASURED 2026-09-06 (RELEASE.md 2.3, toolkit 0.124.0) against probes/fixtures/
// manifest-2026-09-06.json, a 96-tool capture from a dev CLIENT in a world - the first capture that
// holds `studio`, `ui_doc`, the paint tools and the project profile: `full` is 106 tools / 190,178
// chars / ~47.5k tok, `standard` 102 / 179,954 / ~45.0k, the DEFAULT `modding` 54 / 107,025 / ~26.8k,
// `authoring` 35 / 54,811 / ~13.7k (69.5% off `standard`, ~31.3k tokens off every turn; ~13.1k off
// `modding`), `screens` 39 / ~13.4k, `art` 19 / ~6.4k, `inspect` 29 / ~19.1k. Two tools and ~2.3k
// tokens on `full` since the 08-28 figures below, which stand as written.
//
// The 72%/~11.1k figures this comment carried until 0.107.0 were taken on 2026-08-26 against a
// 90-tool manifest, before `roll_loot`, `preview_worldgen`, `render` and `open_world` existed. They
// were not wrong; they were priced against a smaller toolkit, which is the failure mode a measured
// number has and a mechanism does not. That is why the probe pins the MECHANISM and this comment
// carries the date.//
// ONE CAVEAT ON THIS CAPTURE, stated because a measured number's failure mode is its context. It was
// taken from a tree carrying ANOTHER SESSION'S uncommitted RENDER_SEAM_DESIGN phase 3, which grows
// `render`'s schema (look_at / distance / frames). `render`'s whole manifest entry is 3,973 chars,
// so every profile that serves it - full, standard, entity, modding, authoring, art, screens,
// inspect - is high by at most that entry's growth, a few hundred characters. Nothing here turns on
// it, and re-capturing on a tree that is not mid-flight is a one-command fix when it matters.
//
// NOTE THE BASELINE. `authoring` is quoted against `standard` because that is what it has always
// been quoted against and the comparison must stay readable across releases — but `standard` stopped
// being the DEFAULT at 0.107.0. From the default a session actually runs (`modding`, 52 tools /
// 98,523 chars / ~24.6k tok), switching to `authoring` saves ~11.8k tokens/turn rather than ~29.5k,
// because 17.7k of the old saving is now simply not being paid in the first place.
//
// THIS COMMENT IS THAT NUMBER'S SITE OF RECORD. It is cited from the changelog and from
// probes/authoring-saving.test.mjs and repeated in neither, because a figure maintained in three
// places is maintained in one and stale in two — which is exactly how it went wrong below.
//
// REPRODUCIBLE WITHOUT A GAME: probes/authoring-saving.test.mjs drives this shim against
// probes/fixtures/manifest-2026-08-26.json, the live 90-tool capture these figures were taken from,
// and prints them. That probe pins the MECHANISM — this keep-list, that capture, this reduction —
// and deliberately does not track the live manifest, which grows tools the capture never saw. When
// this number must be current again, re-measure live and re-capture; the probe only guarantees the
// mechanism has not quietly stopped working in between.
//
// 72, not the 80 quoted while this was a sketch: the sketch was priced off a leaner keep-list than
// the one that shipped, which keeps the memory verbs, get_surface, get_region_summary and get_log.
// The 80 was corrected in the tool DESCRIPTION and missed HERE, twice, by two readers — and the same
// afternoon produced two more stale copies of two other figures. A measured number lives in more
// places than the one you are speaking from, so when it moves, grep for it; better, give it one home
// and cite that, which holds whether or not anyone remembers to grep.
const AUTHORING_KEEP = [
  // write
  "set_blocks", "place_shape", "place_shapes", "place_structure", "run_command", "undo_edit",
  "list_edits",
  // read back
  "describe_box", "get_blocks_at", "get_surface", "get_region_summary", "resolve_anchor", "anchors",
  // make it datapack content
  "capture_structure", "push_data", "reload_data", "list_data", "clear_data",
  // see it, and know where "it" is
  "screenshot", "screenshot_annotated", "get_world_info", "ping", "launch_game", "get_log",
  // RECONCILED with §D's additions 2026-08-28 (RELEASE_1.md §C5). A keep-list excludes a new tool
  // SILENTLY and by design, so nothing had inherited anything added since 0.99.0 and the profile was
  // quietly a year behind the toolkit. Decided per name, and most of the answers were no:
  //   render, open_world (0.105.0) — YES, and they join the "see it" arm rather than extending it.
  //     `render` is a free camera: the one read that can look at a build from outside the player's
  //     own head, which is the whole question an authoring session asks. `open_world` is how a
  //     client that `launch_game` just started gets INTO the world the rest of this list edits —
  //     without it the profile can start a game it cannot then use.
  //   query_class, get_perf (0.95.0/0.96.0) — no. They answer questions about the JVM and the tick
  //     budget: a modder's questions, but not THIS role's, which is geometry and datapack content.
  //     They are served by `modding` and by `inspect`.
  //   roll_loot (0.101.0) — no, for the same reason and one more: a loot table is a different
  //     afternoon from a build, and `authoring`'s 72% cut is the thing it exists to be.
  //   preview_worldgen (0.103.0) — no. It answers what the generator WOULD make somewhere nobody
  //     has been; an authoring session is placing blocks at a place it has already chosen.
  "render", "open_world",
  //   studio (0.113.0) — YES, and it is the same decision one step further: a piece this role
  //     captured into an .nbt has nowhere to stand, and `studio` is what stands it up against a
  //     white background so `render` can look at it. It is kept OUT of `inspect` for the reason
  //     StudioTools names — it writes blocks and moves a player, and `inspect`'s read-only claim is
  //     checked per name against the manifest's mechanism.
  "studio",
  // the memory protocol — an authoring session records what it authored
  "mem_note", "mem_recall", "mem_recent", "mem_write_block", "mem_dismiss", "mem_place", "mem_task",
];
// --- the Blockbench surface (upstream/blockbench.mjs) ---------------------------------------------
// A SECOND UPSTREAM, not a local surface, served since 0.64.0 by the toolkit's OWN plugin
// (mcp-toolkit/blockbench/mcptoolkit_bridge.js; BLOCKBENCH_BRIDGE_DESIGN.md): 26 tools, every one
// stamped with a mechanism on the manifest, captured at probes/fixtures/blockbench-bridge-2026-09-07.json.
// Which profiles serve it is decided HERE, because that is the thing a peer registration could
// never do.
//
// The rule is the one CLIENT_SURFACE and EXTENSION_SURFACE already follow: conditionally present,
// and absent from every role that has no business with it. A Blockbench name is served only under a
// profile named below - everywhere else the whole upstream is neither fetched nor routed, so a
// survival body cannot reach a modelling app even by knowing a name from prior context.
//
//   standard/full/entity - the workbench roles. `entity` especially: staging an entity preview and
//                          authoring its model are the same afternoon.
//   art                  - the KEEP-list slice below.
//   play/survey/survival - nothing. A body does not open a modelling app.
//   authoring/rocketeer_authoring - nothing. Those are BLOCK-authoring surfaces (set_blocks,
//                          capture_structure); a mesh editor would undo the 72% they exist to save.
//   modding              - nothing, and this is a DELIBERATE break from `standard`, the default it
//                          replaced. `art` is what a modelling session is for, and it is one
//                          `tool_surface` call away. The gate is per-upstream, so under `modding`
//                          Blockbench is not fetched, not routed and not polled at all.
//   screens/inspect      - nothing. A UI session drives the game's widgets, not another app's; a
//                          read-only inspector must not hold an editor.
const BLOCKBENCH_PROFILES = new Set(["full", "standard", "entity", "art"]);
// `project` answers as its BASE here even when it has a keep-list: which upstreams exist is the
// base's decision, which names are kept is the keep-list's. (PROJECT_BASE is declared below, after
// the keep-lists; this is only ever called at build time, long after both exist.)
const servesBlockbench = (profile) => BLOCKBENCH_PROFILES.has(profile === "project" ? PROJECT_BASE : profile);

// The slice `art` keeps. The plugin's surface was DESIGNED as the art slice (the third-party
// plugin's 94 tools, of which `art` kept 20 and the pipeline used one, are what it replaced), so
// the keep-list is nearly the whole manifest; still a keep-list, so a tool the plugin grows stays
// out of `art` until someone asks for it here. Deliberately NOT kept: `trigger_action`, which
// drives the app's UI blind (a fallback, not a pipeline). probes/blockbench-surface.test.mjs
// pins the mechanism against the capture.
const BLOCKBENCH_KEEP = [
  // where am I, what is loaded, which project is mine
  "get_project_info", "project", "list_outline", "find_elements_by_criteria", "get_selection", "inspect",
  // geometry
  "place_cube", "modify_cube", "add_group", "element",
  // texture, and the painters that used to be shim-local (LOOP_KIT_DESIGN.md section 5.4)
  "create_texture", "apply_texture", "list_textures", "get_texture", "texture", "paint_faces", "paint_ascii",
  // the eval the older plugins' globals are reached through (mcptoolkitPush, mcptoolkitEntity)
  "risky_eval",
  // read the numbers back out rather than transcribing them by hand
  "export_model",
  // look at it - legibility only, never geometry
  "set_camera_angle", "capture_screenshot",
  // a way back from a bad edit
  "undo", "redo", "get_undo_stack",
  // animation (experimental, see the plugin)
  "animation",
];
// --- the modder default (RELEASE_1.md SS C2/C3) --------------------------------------------------
// THE QUESTION C2 ASKED WAS NOT "add the block reads back to `standard`". It was: is `standard` the
// modder default at all? It is not, and never was one on purpose. `standard` is a BENCH artifact -
// its shape was chosen by a navigation bench (TOOL_BILL_PLAN.md §4b), which is why it withholds
// `describe_box`/`get_blocks_at`/`get_surface`: those reads had a measured 1:1 substitute for a rung
// that WALKS. An authoring session does not walk, it reads back geometry it just wrote, and the
// substitution argument does not transfer. So `standard` retires to the ladder it was benched on,
// and the default becomes this - authored from the role in RELEASE_1.md §0, which is the whole
// specification of what this release supports:
//
//     "a modder attaches an agent to a running game and authors blocks, models, entities, data,
//      structures and screens against it"
//
// The hole closes as a CONSEQUENCE rather than as a patch: `menagerie/.mcp.json` names no profile,
// so it ran `standard` and silently could not read a block back; it now runs this, which can.
// (`rocketeer/.mcp.json` pins `full` to work around the same hole and can drop the pin - that is a
// change in another repo and is not made from here.)
//
// A KEEP-LIST, like every supported dev role. The cost of a keep-list is that a genuinely useful new
// tool stays hidden until someone adds it, and in the DEFAULT that cost lands on everyone who never
// chose a profile - the one place a silent exclusion is invisible to every party at once. So this is
// the profile that pays it back: see MODDING_EXCLUDED.
//
// MEASURED LIVE 2026-08-28 against a 94-tool manifest from a dev client, and THIS COMMENT IS THAT
// NUMBER'S SITE OF RECORD: `modding` is 52 tools / 98,523 chars / ~24.6k tok against `standard`'s
// 100 / 169,279 / ~42.3k. So moving the default saves ~17.7k tokens on EVERY TURN of every session
// that never chose a profile, while ADDING the three block reads §C2 is about. The saving is not a
// cleverness; it is almost entirely the 28 embodied bot_* verbs, which a session authoring content
// does not use and which a session that wants them gets back with one `tool_surface` call.
const MODDING_KEEP = [
  // orient: which game is this, what has it been saying, and say something back
  "ping", "get_world_info", "get_events", "get_log", "send_chat",
  // the dev loop - code, and the two questions you ask about a running one
  "hotswap_class", "query_class", "get_perf", "launch_game", "open_world", "create_world",
  // what a stack SAYS - the one UI line a mod writes that a modder could not read back (0.130.0)
  "get_tooltip",
  // data: push it, reload it, see what is loaded, and roll/preview the two kinds you cannot read
  // back by looking
  "push_data", "reload_data", "list_data", "clear_data", "capture_structure", "place_structure",
  "roll_loot", "preview_worldgen", "query_registry",
  // write the world
  "set_blocks", "place_shape", "place_shapes", "run_command", "undo_edit", "list_edits",
  // ...and read it back. This is the line §C2 is about: all three block reads are here.
  "describe_box", "get_blocks_at", "get_surface", "get_region_summary", "scene_summary",
  "locate", "resolve_anchor", "anchors", "check_site",
  // `check_path` is a READ about a build, not a navigation verb, and it is the one tool in the
  // manifest that can see a staircase that bakes clean and is unclimbable by anything that
  // pathfinds (the measured trap recorded under rocketeer_authoring below). It is also on
  // probes/profiles.test.mjs's load-bearing list.
  "check_path",
  // author a SCREEN. `ui_doc` is the one screen tool a modding session keeps, and it is kept for the
  // reason the rest of the client surface is excluded: it is not the client's widgets, it is the
  // document on disk and the emitter over it, and it answers with no client at all. Its one
  // client-side op (preview) is also the only door to a preview left in this profile, open_screen
  // being excluded below.
  "ui_doc",
  // look at it, and hot-reload the assets you are looking at
  "screenshot", "render", "push_asset", "reload_resources", "list_assets",
  // ...including a structure that is only a file: `studio` stands it in the white room and moves
  // this client in front of it, which is the one thing `render` cannot do for itself.
  "studio",
  // the memory protocol - a modding session records what it authored
  "mem_note", "mem_recall", "mem_recent", "mem_write_block", "mem_dismiss", "mem_place", "mem_task",
  // who else is on this bridge right now. The delegation tools that used to sit here
  // (companion_spawn, companion_stop, session_send) went with the launcher in toolkit 0.143.0:
  // the game starts no sessions any more, so there is nothing to spawn, stop or talk to.
  "session_list",
];
// THE DECLARED COMPLEMENT, and it is the mechanism this section owes rather than a list of notes.
//
// The asymmetry recorded under rocketeer_authoring cuts both ways: a HIDE-list that names a tool
// nothing serves gets a loud stderr warning, and a KEEP-list gets no check at all - a name that
// never appears is simply never served, silently. That is the desired behaviour for a narrow slice
// like `art`, whose exclusions ARE the profile. It is not desired for the default, where §C5's whole
// finding is that four tools shipped and no keep-list inherited any of them, invisibly, for weeks.
//
// So `modding` declares its complement: every name in the LIVE manifest must be either kept above or
// excluded here, and a name in neither is a loud warning at start-up (buildToolList, beside the
// unknown-hide warning it is the mirror of) and a red probe. A new tool therefore cannot enter the
// default silently OR be omitted from it silently - the author must write one line saying which.
// Only the default carries this obligation; the narrow roles keep the cheap failure mode.
const MODDING_EXCLUDED = [
  // The body. Twenty-eight verbs and the largest single saving here: authoring content and driving a
  // drone are different sessions, and a modder who wants one is one `tool_surface` call away.
  ...EMBODIED, "bot_scan", "bot_status", "bot_point",
  // Reads that only a body has a question for: what is around IT, and what can IT see.
  "get_entities", "raycast", "raycast_fan",
  // Entity preview. Hidden by default EVERYWHERE (see ENTITY_SURFACE) - `entity` and `art` are how
  // an authoring session gets it, and this default is not a substitute for either.
  "stage_entity",
  // The client's own widgets. `screens` keeps them; a modder who is not authoring a UI pays ~13
  // entries per turn for a screen they are not looking at. The client tools that ARE kept above
  // (screenshot, render, push_asset/reload_resources/list_assets) are the "look at what I made" arm.
  "get_chat", "get_screen", "get_screen_graph", "screenshot_annotated", "click", "set_text",
  "send_keys", "open_screen", "close_screen", "measure_text", "check_layout", "clear_assets",
  "quit_game",
  // Operator surface: tasking a human, and queueing commands that later run at the console's own
  // authority. Neither is a thing a modding session does incidentally; both are served by `full`.
  "human_task", "human_task_cancel", "review_post", "review_status",
  // World-model DRIVER surface (V3_PLAN.md). A research harness's tools, not a modder's.
  "wm_verdict", "wm_obsgap", "wm_session_tag", "wm_perturb",
  // Survival's own exit, served only there (local/survival.mjs).
  "session_stop",
  // Extension-owned, and excluded on the same rule the toolkit's own tools are: an extension's verbs
  // belong to a role its own workspace names (rocketeer_authoring is the worked example). Listed so
  // the villagejobs game does not warn - and so that when a NEW extension's tool warns, that is
  // news rather than noise.
  ...EXTENSION_SURFACE,
];

// --- the UI/screens session (RELEASE_1.md §C3) ---------------------------------------------------
// The gap the re-check named: CLIENT_SURFACE existed only as a HIDE-set - every role took the client
// tools away and no role kept them, so the toolkit had a screens capability and no screens session.
// This is that session: drive and read the client's widgets, push the assets and data behind them,
// reload, look again.
//
// It is the ONLY profile that keeps the client surface, which is what makes the hide in every other
// profile a statement rather than an accident. Note it also keeps `quit_game` and `open_world`: this
// role owns the client process, so ending and re-entering a world is part of its loop rather than
// somebody else's emergency.
const SCREENS_KEEP = [
  // read the screen
  "get_screen", "get_screen_graph", "screenshot", "screenshot_annotated", "measure_text",
  "check_layout", "get_chat", "get_tooltip",
  // author the DOCUMENT behind a generated screen, and compile it - the other half of a UI session,
  // and the half that works with no world loaded (SCREEN_AUTHORING_DESIGN.md section 10)
  "ui_doc",
  // drive it
  "click", "set_text", "send_keys", "open_screen", "close_screen",
  // the free camera - a screen is not the only thing a UI session looks at
  "render",
  // the assets and data a screen is made of
  "push_asset", "reload_resources", "list_assets", "clear_assets",
  "push_data", "reload_data", "list_data", "clear_data",
  // the client process itself, and the code behind the widget
  "launch_game", "open_world", "create_world", "quit_game", "hotswap_class",
  // orient
  "ping", "get_world_info", "get_events", "get_log", "send_chat",
  // the memory protocol
  "mem_note", "mem_recall", "mem_recent", "mem_write_block", "mem_dismiss", "mem_place", "mem_task",
];

// --- the read-only inspector (RELEASE_1.md §C3) --------------------------------------------------
// The other unnamed role. A session that answers questions about a world it must not change: a
// reviewer, a bug reporter, a second pair of eyes on someone else's game.
//
// "Read-only" is a CLAIM, and the manifest carries the evidence for it: every ToolDef declares a
// `mechanism` (observe / embodied / world_edit / privileged) and the bridge stamps it into
// GET /tools. So this list is checked per name against the live manifest rather than believed -
// probes/profiles.test.mjs asserts every bridge tool `inspect` serves is `observe`. That is why the
// memory WRITERS are absent while mem_recall/mem_recent are present, and why `launch_game` is not
// here: starting a game is privileged even though nothing in the world changes.
//
// The check is what makes this profile worth having rather than a smaller `modding`. A hand-written
// read-only list is one careless addition away from being false, and false is exactly the property
// the role is chosen for.
const INSPECT_KEEP = [
  // orient
  "ping", "get_world_info", "get_events", "get_log",
  // the world, every resolution
  "scene_summary", "describe_box", "get_blocks_at", "get_surface", "get_region_summary",
  "locate", "anchors", "resolve_anchor", "check_site", "check_path", "get_entities",
  "raycast", "raycast_fan",
  // what is loaded, what it would do, and where the tick goes
  "query_registry", "query_class", "get_perf", "list_data", "list_edits", "roll_loot",
  "preview_worldgen",
  // look
  "screenshot", "render",
  // memory, READS only - mem_note/mem_place/mem_write_block/mem_dismiss/mem_task all write
  "mem_recall", "mem_recent",
];

const KEEP_PROFILES = {
  modding: new Set(MODDING_KEEP),
  screens: new Set(SCREENS_KEEP),
  inspect: new Set(INSPECT_KEEP),
  authoring: new Set(AUTHORING_KEEP),
  // `art`: authoring a MODEL, not a build. The first profile whose surface spans two upstreams —
  // Blockbench for the geometry and pixels, and the toolkit's own thin arm for getting the result
  // into the running game and looking at it there (push_asset/reload_resources/stage_entity).
  // Everything else the toolkit offers — the world, the body, the events — is off.
  art: new Set([
    ...BLOCKBENCH_KEEP,
    // into the game, and seen there. `render` joined in the same §C5 reconciliation as above and on
    // the same argument, which is stronger here than anywhere: a staged model is a thing you look at
    // from a chosen angle, and `screenshot` can only ever shoot from wherever the player is standing.
    // Nothing else from §D is kept — a model-authoring session has no use for the tick budget, the
    // JVM class table, a loot roll or the chunk generator.
    "push_asset", "reload_resources", "list_assets", "stage_entity", "screenshot", "render", "get_log",
    "launch_game", "ping",
    // the memory protocol — an art session records what it authored, same as an authoring one
    "mem_note", "mem_recall", "mem_recent", "mem_write_block", "mem_dismiss", "mem_place", "mem_task",
  ]),
  // `rocketeer_authoring`: the FIRST profile that keeps an EXTENSION mod's tools, and the case that
  // shows what a keep-list costs. `authoring` is 32 names and every one of them is this toolkit's
  // own, so an extension's verbs are excluded by default — which is the keep-list failing in the
  // safe direction exactly as intended, and is ALSO why `authoring` is unusable for the job it
  // sounds like it was made for. rocketeer's room-authoring loop judges a piece with
  // rk_piece_frame / rk_piece_check / rk_piece_declare and walks it with check_path; without those
  // four, `authoring` is a build-and-capture surface with no verdict in it, and every finding of the
  // 2026-08-26 authoring trial came from exactly those four calls.
  //
  // check_path earns a 4,785-char entry (~1.2k tok/turn, the largest here) on one measured trap:
  // rk_piece_check's lane flood walks columns at ly 1–2, while vanilla's node evaluator treats a
  // stair as a full-block step needing two clear courses over the source node. A staircase therefore
  // bakes with ZERO refusals and is unclimbable by anything that pathfinds, while a human walks it
  // fine. Nothing else in the manifest can see that.
  //
  // query_registry is deliberately NOT here. It is a reference read, its entry is ~2.4k chars, and
  // the trial's agents never reached for it; it stays available over the bridge from a script, which
  // is where a session should be doing bulk lookups anyway.
  //
  // Naming an extension's tools from this file is a small coupling and it is the honest one: the
  // profile is a statement about a ROLE, roles are per-workspace, and rocketeer's workspace
  // (../rocketeer-authoring/.mcp.json) is what selects it.
  //
  // NOTE THE ASYMMETRY, because it cuts the other way from 0.98.0's near-miss: a hide-list that
  // names a tool nothing serves gets the loud "hidden name(s) not in this manifest" warning, with
  // CLIENT_SURFACE and EXTENSION_SURFACE exempted so a conditionally-absent name is not read as
  // dead. A KEEP-list gets no such check at all — a name that never appears is simply never served,
  // silently. Here that is the desired behaviour (this profile must still work against a game with
  // no rocketeer in it), but it means a TYPO in one of these four is invisible: the session just
  // quietly has no rk_piece_check. probes/rocketeer-authoring.test.mjs is what makes that loud.
  rocketeer_authoring: new Set([
    ...AUTHORING_KEEP,
    "rk_piece_frame", "rk_piece_check", "rk_piece_declare",
    "check_path",
  ]),
};

// --- the PROJECT profile (LOOP_KIT_DESIGN.md §5.3) -----------------------------------------------
// A profile the WORKSPACE declares, in its loop file, rather than one this file authors. This is
// the whole reason ArmorPieces wrote a proxy: the Blockbench plugin cannot be extended and the
// toolkit could not be told which slice to serve or what to say about it. Now it can:
//
//   "profile": { "base": "art", "keep": [...], "notes": {...}, "instructions": "..." }
//
// `base` decides what the name cannot: whether the Blockbench upstream is served at all (a
// per-upstream gate, see BLOCKBENCH_PROFILES) and, when there is no `keep`, the whole served set.
// `keep` is a keep-list like every supported dev role, and it declares its complement the way they
// do: a name that never appears is never served, and a NEW tool stays hidden until named. That is
// the trade every keep-list here takes on purpose; the typo failure mode gets the stderr warning in
// buildToolList (a kept name absent from the live manifest), which the narrow built-in slices do
// not get, because a project author has no probe file to make it loud.
//
// `notes` are sentences appended VERBATIM to the named tools' descriptions - the model learns the
// workspace's rules where it reads the tool, not in a document it may not open. A note is a
// per-turn cost like the entry it rides on, so `tool_surface` prices them. `instructions` is served
// as this MCP server's instructions.
const PROJECT_BASE = LOOP?.profile?.base ?? null;
if (LOOP?.profile) {
  if (!(PROJECT_BASE in PROFILES) && !(PROJECT_BASE in KEEP_PROFILES)) {
    throw new Error(`loop file ${LOOP.path}: profile.base "${PROJECT_BASE}" is not a profile (known: `
      + `${[...Object.keys(PROFILES), ...Object.keys(KEEP_PROFILES)].join(", ")})`);
  }
  // null = "exactly the base": the entry exists so `project` is a known, switchable name, and
  // effectiveProfile() below resolves it to the base for every membership question.
  KEEP_PROFILES.project = LOOP.profile.keep ? new Set(LOOP.profile.keep) : null;
}
/** The profile whose membership rules answer for `name`: `project` without a keep-list IS its base. */
const effectiveProfile = (name) => (name === "project" && !KEEP_PROFILES.project ? PROJECT_BASE : name);

// What each profile IS, in one line, plus the two facts a session needs about it before it trusts
// what it is holding. This table is the single site of record for the experimental marking
// (RELEASE_1.md §C4): the start-up stderr line, `ping`'s `profile` block and `tool_surface`'s report
// all read it, so the label cannot be true in one of the three and stale in the other two - which is
// exactly how the 72%/80% figures went stale in two places at once.
//
//   kind: "dev"          - a supported developer role. This is the release surface.
//         "bench"        - a measured configuration kept so bench arms stay comparable. Not a role.
//         "experimental" - shipped, real, and not part of the supported surface.
//
// Before this table, `grep -i experimental` over the whole shim hit exactly one comment about env
// hides, and a research profile looked precisely as blessed as a dev one from inside a session.
const PROFILE_META = {
  modding: { kind: "dev", role: "the modder default: author blocks, data, structures and assets against a running game, and read them back" },
  authoring: { kind: "dev", role: "block authoring: build, read back, capture to a datapack, undo" },
  art: { kind: "dev", role: "model authoring: Blockbench geometry and textures, pushed into the running game" },
  screens: { kind: "dev", role: "the UI/screens session: drive and read the client's widgets and the assets behind them" },
  inspect: { kind: "dev", role: "the read-only inspector: every tool it serves is mechanism:observe" },
  rocketeer_authoring: { kind: "dev", role: "block authoring plus the rocketeer mod's piece-verdict verbs" },
  full: { kind: "bench", role: "everything; the bench baseline arms pin this explicitly" },
  standard: { kind: "bench", role: "the locate surface, chosen by a navigation bench (TOOL_BILL_PLAN.md 4b)" },
  entity: { kind: "bench", role: "standard plus the entity-authoring surface" },
  play: { kind: "experimental", role: "an embodied companion in someone else's game; dev/admin surface removed" },
  survey: { kind: "experimental", role: "the measured-neutral configuration: no body, no middle-tier raw reads" },
  survival: { kind: "experimental", role: "the player-legal surface; a LAUNCH CONTRACT, not a filter" },
  ...(LOOP?.profile ? {
    project: {
      kind: "dev",
      role: `this workspace's own profile (${LOOP.path}): base ${LOOP.profile.base}`
        + `${LOOP.profile.keep ? `, ${LOOP.profile.keep.size} kept` : ", the base's whole surface"}`
        + `, ${Object.keys(LOOP.profile.notes).length} description note(s)`,
    },
  } : {}),
};
const isExperimental = (name) => PROFILE_META[name]?.kind === "experimental";

// The profile this session was LAUNCHED in. Legality is a launch property, never a running choice:
// every `PROFILE === "survival"` gate below is bound to this, so a switch cannot reach one.
//
// THE DEFAULT MOVED FROM `standard` TO `modding` AT 0.107.0 (RELEASE_1.md §C2). `standard` was never
// authored as a modder's surface - it is what a NAVIGATION bench measured - and the default is what
// every session that never chose runs, `menagerie` included. See MODDING_KEEP.
//
// ...AND A WORKSPACE WITH A LOOP FILE THAT DECLARES A PROFILE LAUNCHES IN IT. MCPTK_PROFILE still
// wins when set: the env var is the operator's word, the loop file is the project's.
const PROFILE = (process.env.MCPTK_PROFILE ?? (LOOP?.profile ? "project" : "modding")).trim();
if (!(PROFILE in PROFILES) && !(PROFILE in KEEP_PROFILES)) {
  throw new Error(`unknown MCPTK_PROFILE "${PROFILE}" (known: `
    + `${[...Object.keys(PROFILES), ...Object.keys(KEEP_PROFILES)].join(", ")})`);
}
// ...and the profile it is SERVING right now, which `tool_surface` may change.
let servedProfile = PROFILE;

/** Rebuild the hidden set for a profile. The operator's env hides always survive it. */
function applyProfile(name) {
  servedProfile = name;
  setBlockbenchProfile(name);
  HIDDEN.clear();
  for (const t of ENV_HIDDEN) HIDDEN.add(t);
  // A project profile WITH a keep-list takes no hides from its base: the keep-list is the whole
  // statement, and a base hide that shadowed a kept name would make the file lie.
  for (const t of PROFILES[effectiveProfile(name)] ?? []) HIDDEN.add(t);
}
applyProfile(PROFILE);

// Say which profile this is, on the one channel a session's operator actually reads back afterwards.
// RELEASE_1.md §C4 called this "the stderr line that already announces the profile"; it did not
// exist - only the route layer announced itself, and a session's tool surface, the single largest
// thing about it, was identifiable only by counting the manifest. An experimental profile says so
// on its own line: a label that shares a line with something else is a label that gets skimmed.
{
  const meta = PROFILE_META[PROFILE];
  process.stderr.write(`[mcp-toolkit] profile: ${PROFILE}`
    + `${meta ? ` (${meta.kind}) - ${meta.role}` : ""}\n`);
  if (isExperimental(PROFILE)) {
    process.stderr.write(`[mcp-toolkit] EXPERIMENTAL: "${PROFILE}" is a research profile, not part `
      + `of the supported developer surface. It ships and it works; its shape is decided by bench `
      + `results and it carries owed live runs. The supported dev profiles are: `
      + `${Object.keys(PROFILE_META).filter((n) => PROFILE_META[n].kind === "dev").join(", ")}.\n`);
  }
}

// Switching is unavailable under `survival` — not refused, ABSENT. The survival profile is not a
// manifest filter, it is the legality contract the session was launched under (SURVIVAL_MODE_PLAN
// §3), and a body that could re-profile itself would be choosing its own legality. The same reason
// `wm_session_tag` is withheld from the subject: a run that can label its own conditions cannot be
// evidence about them. So the verb is never served there and the question never arises.
const CAN_SWITCH_PROFILE = PROFILE !== "survival";
let warnedUnknownHidden = false;
// ...and its keep-list mirror, for the default profile's declared complement (buildToolList).
let warnedUndeclared = false;

// MCPTK_ROUTES (memory/routes.mjs) changes what `locate` can answer without changing the manifest,
// so it is announced on stderr the way the profile is: a session whose vocabulary differs from the
// default must be identifiable from the log alone, and `tools_hash` cannot see this one.
if (routesMode() !== "learn") {
  process.stderr.write(`[mcp-toolkit] route layer: ${routesMode()}\n`);
}

// MCPTK_GET_BLOCKS_VIEW: how get_surface results are encoded before they reach the model.
//   raw (default) — the bridge's native palette-indexed columns, unchanged.
//   surface       — re-encode as a compact ASCII surface map + counting legend (ablation/view.mjs).
//                   Forces detail:full upstream so there is always per-column data to map; a single
//                   get_surface result then reads as shape (structure/gaps) at a fraction of the raw
//                   per-column JSON, which every later turn re-reads (the token driver — see
//                   TOKEN_PER_TOOL_FINDINGS.md). A serialization change, gated on a Category-T
//                   raw-vs-surface accuracy bench (ARCHITECTURE.md decision "Opaque/numeric block
//                   palettes"): this flag is the mechanism that runs that bench.
const GET_BLOCKS_VIEW = (process.env.MCPTK_GET_BLOCKS_VIEW ?? "raw").trim();

// --- session identity (multi-session bridge) ------------------------------------------------------
// Concurrent sessions each run their own copy of this shim against one bridge; every /cmd carries
// `X-MCPTK-Session` so the bridge can attribute calls. Mod-spawned sessions arrive with
// MCPTK_SESSION; external ones introduce themselves via POST /hello — lazily on the first /cmd,
// never at startup — and cache the minted id for the process lifetime. Identity is best-effort: a
// bridge that is down, or an older mod without /hello, must never break tool forwarding; a failed
// hello is simply retried on a later call.

// Every bridge fetch carries a timeout: a fully-down game fails fast on its own (ECONNREFUSED),
// but a HUNG game — accepted TCP connection, blocked server thread, long world load — would
// otherwise park the MCP call forever. /cmd's budget must out-wait the bridge's own per-tool
// dispatch caps (up to 360s for waitable embodied tools): it exists to catch a hung bridge, not
// to race healthy long calls.
const QUICK_TIMEOUT_MS = 5_000; // hello/heartbeat: identity is best-effort
const MANIFEST_TIMEOUT_MS = 10_000;
const CMD_TIMEOUT_MS = 390_000;

let sessionId = process.env.MCPTK_SESSION || null;
let helloInFlight = null;

// WHICH CLIENT is on the other end of this stdio pipe. Self-declared at hello, because the bridge
// has no way to see past the shim: until 0.104.0 the handshake carried only a label, so a session
// list could not tell a hand-run host from a mod-launched one and no capability could be reasoned
// about. MCPTK_CLIENT is the explicit answer; the sniff below is a courtesy for the one client that
// announces itself in the environment, and "unknown" is a perfectly good answer that costs nothing.
function declaredClient() {
  const explicit = (process.env.MCPTK_CLIENT ?? "").trim();
  if (explicit) return explicit;
  if (process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT) return "claude-code";
  return "unknown";
}

// The orientation pointer the bridge sends back — what a fresh session should call to know where it
// is. Logged to stderr (the host's own log) rather than injected into a tool result: a first result
// is an answer to a question somebody asked, and quietly appending advice to it is how a tool starts
// lying about what it returned. Hosts that surface server stderr show it; the rest lose nothing,
// because every pointer in it is an ordinary tool the manifest already advertises.
async function ensureSession() {
  if (sessionId) return;
  helloInFlight ??= (async () => {
    const res = await fetch(`${BASE}/hello`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        label: basename(process.cwd()),
        kind: "external",
        client: declaredClient(),
        client_version: (process.env.MCPTK_CLIENT_VERSION ?? "").trim() || undefined,
      }),
      signal: AbortSignal.timeout(QUICK_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`POST /hello returned HTTP ${res.status}`);
    const data = await res.json();
    if (data.ok && data.session) sessionId = data.session;
    if (data.orientation) {
      console.error(`[mcp-toolkit] session ${sessionId ?? "?"} — ${data.orientation}`);
    }
    // After the id exists, so the ping is attributed to this session like every other call.
    announceAttachment().catch(() => {});
  })()
    .catch(() => {}) // stay anonymous this call; the next /cmd retries
    .finally(() => { helloInFlight = null; });
  await helloInFlight;
}

// WHICH GAME did we actually reach — announced once, on stderr, at the first handshake.
//
// The failure this exists for: every project's dev game used to take BridgeConfig's dev default
// (25599) because nothing declared a port, so the SECOND game to boot lost the bind, retried for 90
// seconds, gave up with one WARN, and its session — dialing the same 25599 — connected to the FIRST
// game and worked perfectly against the wrong world. Nothing on either end ever said so, though
// `ping.gameDir` had the answer the whole time. A wrong answer that looks right is the expensive
// kind, and the fix is one line of stderr per session.
//
// Read through `ping` rather than a new field on the hello reply on purpose: `gameDir`/`env`/
// `loader`/`instanceId` have been in ping since long before this, so the check works against every
// toolkit already deployed in the workspace — including the version rocketeer pins. A hello reply
// field would have worked only against games built after it.
//
// The expectation is the SESSION'S OWN DIRECTORY, because that is what a host already gives us and
// what a modder already believes: the .mcp.json in this repo should reach the game this repo builds.
// MCPTK_EXPECT_GAMEDIR overrides it for the legitimate exceptions (a survival workspace elsewhere, a
// probe server in a sibling tree); "any" turns the check off. It WARNS and never refuses — a
// deliberate cross-tree attachment is a real workflow, and refusing it would break more than it saves.
const EXPECT_GAMEDIR = (process.env.MCPTK_EXPECT_GAMEDIR ?? "").trim();

function isInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !/^[A-Za-z]:/.test(rel));
}

async function announceAttachment() {
  let info;
  try {
    const res = await fetch(`${BASE}/cmd`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...sessionHeaders() },
      body: JSON.stringify({ tool: "ping", args: {} }),
      signal: AbortSignal.timeout(QUICK_TIMEOUT_MS),
    });
    const data = await res.json();
    info = data?.result;
  } catch {
    return; // best-effort, exactly like the handshake it follows
  }
  if (!info || typeof info !== "object") return;
  const gameDir = typeof info.gameDir === "string" ? info.gameDir : null;
  console.error(
    `[mcp-toolkit] attached to ${BASE} — ${info.env ?? "?"} ${info.loader ?? "?"} game at ` +
      `${gameDir ?? "an unreported directory"} (instance ${info.instanceId ?? "?"})`,
  );
  if (!gameDir || EXPECT_GAMEDIR === "any") return;
  const expected = EXPECT_GAMEDIR || process.cwd();
  if (isInside(expected, gameDir)) return;
  console.error(
    `[mcp-toolkit] WARNING: that game is OUTSIDE ${expected}. ${BASE} is whatever game bound that ` +
      "port, not necessarily the one this project builds — if two dev games raced for it, the " +
      "loser is running with no bridge at all and you are driving the winner. Give this repo a " +
      "port of its own (mcmod.port in gradle.properties + MCPTK_URL in .mcp.json), or set " +
      "MCPTK_EXPECT_GAMEDIR (\"any\" silences this) if the attachment is deliberate.",
  );
}

// Every call also declares the session's PROFILE. Profiles are defined here (PROFILES above) and
// enforced here by hiding tools, but one rule cannot be: the event stream lives in the mod, and a
// player-legal session must not be served `audit` records — the server's own ledger of world edits
// some other session made, complete with coordinates and block ids, for a body that perceived none
// of it. So the mod is told the role and applies it at the source, exactly like chat routing.
// Trust is unchanged: the shim declares its own profile, and the bridge stays localhost-trusted.
function sessionHeaders() {
  return {
    ...(sessionId ? { "X-MCPTK-Session": sessionId } : {}),
    "X-MCPTK-Profile": servedProfile,
  };
}

// Heartbeat: registry liveness for idle-but-open sessions. The bridge reaps session-bound
// resources (drones, chat-responder binding) when a session goes unseen for ~3 minutes, so an open
// session that merely isn't calling tools must keep announcing itself. Fire-and-forget every 30s
// once an id exists; unref'd so it never keeps this process alive. Best-effort like the rest of
// identity — a down bridge or an older mod without /heartbeat is silently tolerated.
const HEARTBEAT_MS = 30_000;
setInterval(() => {
  if (!sessionId) return;
  fetch(`${BASE}/heartbeat`, {
    method: "POST",
    headers: sessionHeaders(),
    signal: AbortSignal.timeout(QUICK_TIMEOUT_MS),
  }).catch(() => {});
}, HEARTBEAT_MS).unref();

/** Fetch the tool manifest from the bridge. Throws on network/HTTP/parse failure. */
async function fetchManifest() {
  const res = await fetch(`${BASE}/tools`, {
    method: "GET",
    headers: sessionHeaders(),
    signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GET /tools returned HTTP ${res.status}${body ? `: ${body.slice(0, 300)}` : ""}`);
  }
  try {
    return await res.json();
  } catch (e) {
    throw new Error(`GET /tools returned a non-JSON body (${e.message})`);
  }
}

/** Forward a tool call to the bridge and return the parsed `{ok, result|error}` envelope. */
async function callTool(tool, args) {
  await ensureSession(); // lazy identity — never throws
  let res;
  try {
    res = await fetch(`${BASE}/cmd`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...sessionHeaders() },
      body: JSON.stringify({ tool, args: args ?? {} }),
      signal: AbortSignal.timeout(CMD_TIMEOUT_MS),
    });
  } catch (e) {
    if (e.name === "TimeoutError" || e.name === "AbortError") {
      throw new Error(
        `The MCP toolkit bridge at ${BASE} accepted the call but gave no answer within ${CMD_TIMEOUT_MS / 1000}s — the game looks hung (blocked server thread, long world load?).`,
      );
    }
    throw new Error(
      `Cannot reach the MCP toolkit bridge at ${BASE}. Is the game running with the bridge enabled? (${e.message})`,
    );
  }
  if (!res.ok) {
    // The body may carry the bridge's actual complaint (structured {error}, a proxy page) —
    // reducing it to a bare status code throws that diagnosis away.
    const body = await res.text().catch(() => "");
    throw new Error(`Bridge at ${BASE} returned HTTP ${res.status} for ${tool}${body ? `: ${body.slice(0, 300)}` : ""}`);
  }
  try {
    return await res.json();
  } catch (e) {
    throw new Error(`Bridge at ${BASE} returned a non-JSON body for ${tool} (${e.message})`);
  }
}

// The ambient retina (memory/ambient.mjs): flag-gated; noteEmbodied is pinged on every successful
// bot_* call so the fan only fires while the session is actually playing.
const ambient = startAmbient(callTool);

// --- world label for the route ledger -------------------------------------------------------------
// The ledger is cross-session and cross-world, so every row says which world it came from. Resolved
// LAZILY (one bridge call, on the first recorded outcome — never at startup, which would make a
// down bridge cost every session a timeout) and refreshed for free whenever a get_world_info result
// passes through the shim. A null world is fine and honest: an unattributed row still counts.
let ledgerWorld = null;
let worldResolved = false;
async function currentWorld() {
  if (worldResolved) return ledgerWorld;
  worldResolved = true;
  try {
    const { resolveWorld } = await import("./memory/tools.mjs");
    ledgerWorld = (await resolveWorld(callTool)).world_uuid ?? null;
  } catch {
    ledgerWorld = null; // no world identity yet (fresh install, bridge down) — record anyway
  }
  return ledgerWorld;
}

// --- tool_surface: the session narrows itself to its job ------------------------------------------
// ONE tool, not an argument on an existing one, and that is a deliberate exception to the rule this
// repo has paid for twice (write_box folded into set_blocks, 745 -> 407 tok/turn; query_registry's
// `entry`/`tag` at +181 against ~2,356 for four tools). The rule says a new entry is a per-turn tax
// that a new capability must out-earn. This one out-earns it on its first call: the entry is a few
// hundred tokens and the switch it performs removes ~28.5k (MEASURED: 96 tools/158,489 chars ->
// 32/44,373, a 72% cut; the 80% quoted while this was a sketch was priced off a leaner keep-list
// than the one that shipped). It also must be findable WITHOUT already
// knowing which host tool hides it, and un-hideable by any profile — an argument on a tool a profile
// can hide is a door that locks from the inside.
const SURFACE_TOOL_NAME = "tool_surface";
const SURFACE_TOOL = {
  name: SURFACE_TOOL_NAME,
  description:
    "Narrow or widen THIS session's own tool list, live. No arguments: report the current profile, "
    + "what it costs, and what else is available. With \"profile\": switch to it — the client re-reads "
    + "its tool list, so the surface matches the job. \"authoring\" is the block-authoring surface "
    + "(write blocks, read them back, capture to a datapack, screenshot, undo) at roughly 70% less "
    + "than the default; \"art\" is the model-authoring one (Blockbench geometry and textures, plus "
    + "pushing the result into the running game); \"screens\" drives and reads the game client's own "
    + "widgets; \"inspect\" is read-only (every tool it serves is mechanism:observe). The report "
    + "says what each available profile is for and marks the experimental research ones. "
    + "A switch is NOT free: it rewrites the tool block and invalidates the prompt "
    + "cache, and the result tells you exactly what it cost. Switch once when you learn the job — "
    + "never to browse. Tools a switch hides refuse with `profile_hidden` until you widen again; "
    + "this tool is never hidden, so you cannot strand yourself.",
  inputSchema: {
    type: "object",
    properties: {
      profile: {
        type: "string",
        description: "Profile to switch to. Omit to report the current one without changing anything.",
      },
    },
  },
};

/** What the client pays to re-read a list: its serialization, which is what lands in the prompt. */
const priceOf = (tools) => JSON.stringify(tools).length;

/**
 * Is this name served right now? Three rules in precedence order: the operator's ablation hides win
 * over everything; the switch verb can never be hidden by a PROFILE (an agent must always be able to
 * widen back); then the active profile, whether it hides by list or keeps by set.
 */
function isServed(name) {
  if (ENV_HIDDEN.has(name)) return false;
  if (name === SURFACE_TOOL_NAME) return CAN_SWITCH_PROFILE;
  // The Blockbench upstream is gated by profile as a WHOLE before any per-name rule: under a profile
  // that does not serve it, its names are not hidden-but-known, they are not this session's surface
  // at all. This is also the CALL gate — the same reason `tool_surface` had to be unlisted AND
  // uncallable under survival: a name a client still holds from a stale list must not route.
  if (isBlockbenchTool(name) && !servesBlockbench(servedProfile)) return false;
  if (HIDDEN.has(name)) return false;
  const keep = KEEP_PROFILES[effectiveProfile(servedProfile)];
  return keep ? keep.has(name) : true;
}

// --- the loop kit's runtime state --------------------------------------------------------------
// What every served tool's `mechanism` is, from the last manifest build: the bridge stamps its own
// (observe/embodied/world_edit/privileged) and so does the Blockbench plugin (observe /
// blockbench_edit) since 0.64.0 - the adapter's hand-kept read-only list is gone, and the shim's
// own Blockbench painters with it (they are plugin tools now). A MIXED tool (`project`) stamps
// each REPLY as well, and finishReply prefers the reply's stamp. This is what a loop check's
// `after.mechanism` selects on, so "read-only calls never trigger" is derived from the manifest
// rather than hand-kept.
const MECHANISM = new Map();
// Tools whose OWN schema declares `force` — the gate passes it through to those and strips it from
// every other, because ArgCheck refuses an argument a ToolDef never declared and Blockbench's
// schemas are additionalProperties:false.
const DECLARES_FORCE = new Set();
const loopChecks = new LoopChecks(LOOP, {
  // An `eval` check runs inside Blockbench through the same risky_eval the art profile paints with.
  // The plugin answers JSON.stringify(value) as text, which is what the contract parses.
  // The plugin answers {ok, result: {value}}; the contract parses the value's JSON.
  runEval: async (code) => {
    const env = await callBlockbench("risky_eval", { code });
    return JSON.stringify(env?.result?.value ?? null);
  },
});
const GATED = loopChecks.gatedTools();
const FORCE_SCHEMA = {
  type: "string",
  description: "Proceed although the last check left problems standing. Say WHY each is acceptable; "
    + "the reason is logged and echoed in the reply. Omit it to be refused while problems stand.",
};
const SCREENSHOT_EXTRAS = {
  max: {
    type: "integer",
    description: `Longest edge in pixels after the image budget (default ${SHOT_MAX}; 0 returns the `
      + "native frame). Every picture is re-sent on every later turn, so a smaller one is cheaper for "
      + "the rest of the session, not just this reply.",
  },
  crop: {
    description: "Crop BEFORE shrinking: [x, y, w, h] in GUI pixels, or {\"widget\": <index>} / "
      + "{\"id\": \"<element id>\"} naming a widget from get_screen detail:\"layout\", scaled to the "
      + "framebuffer by the GUI scale. \"margin\" (GUI px, default 2) may ride in the object form. A "
      + "screen check wants the widget, not the whole frame.",
  },
};
let warnedProjectKeep = false;
let warnedGate = false;
const BLOCKBENCH_PICTURES = new Set(["capture_screenshot", "get_texture"]);

/**
 * The manifest entry the client sees, given the one the upstream gave us: `screenshot` grows the
 * budget's two arguments, a gated tool grows `force`, and a tool the project wrote a note for gets
 * the sentence appended to its description. Returns the same object when nothing applies; clones
 * the schema before the first change so no upstream object is mutated.
 */
function decorate(t) {
  let d = t;
  const own = () => {
    if (d === t) d = { ...t, inputSchema: structuredClone(t.inputSchema ?? { type: "object", properties: {} }) };
    d.inputSchema.properties ??= {};
    return d;
  };
  if (t.name === "screenshot") Object.assign(own().inputSchema.properties, SCREENSHOT_EXTRAS);
  // The Blockbench pictures take the budget's `max` too (a contact sheet wants 768 or more to
  // stay legible); it comes off before the plugin sees the call, since its ArgCheck refuses it.
  if (BLOCKBENCH_PICTURES.has(t.name) && isBlockbenchTool(t.name)) own().inputSchema.properties.max = SCREENSHOT_EXTRAS.max;
  if (GATED.has(t.name) && !t.inputSchema?.properties?.force) own().inputSchema.properties.force = FORCE_SCHEMA;
  const note = LOOP?.profile?.notes?.[t.name];
  if (typeof note === "string" && note) d = { ...d, description: `${d.description ?? ""}${note}` };
  return d;
}

/**
 * The frame-pixel rectangle a `screenshot {crop}` names, from a get_screen layout taken for the
 * purpose. GUI pixels scale to the framebuffer by the GUI scale, which is frame.width / screen.width
 * and always an integer in vanilla. Returns { rect } or { note } — a crop that cannot be resolved
 * must not cost the caller the screenshot they asked for.
 */
function resolveCrop(cropArg, layout, frame) {
  const screen = layout?.screen;
  if (!screen || typeof screen.width !== "number") return { note: "crop ignored: no screen is open to crop against" };
  const scale = Math.max(1, Math.floor(frame.width / screen.width));
  let gui = null;
  let margin = 2;
  if (Array.isArray(cropArg) && cropArg.length === 4 && cropArg.every((n) => Number.isFinite(n))) {
    gui = cropArg;
  } else if (cropArg && typeof cropArg === "object") {
    if (Number.isFinite(cropArg.margin)) margin = cropArg.margin;
    const widgets = layout.widgets ?? [];
    const w = cropArg.widget !== undefined ? widgets[cropArg.widget]
      : cropArg.id !== undefined ? widgets.find((x) => x.id === cropArg.id) : null;
    if (!w) return { note: `crop ignored: no widget ${cropArg.widget !== undefined ? `#${cropArg.widget}` : `id "${cropArg.id}"`} on this screen (${widgets.length} widgets)` };
    if (typeof w.x !== "number") return { note: "crop ignored: get_screen gave no geometry for that widget" };
    gui = [w.x, w.y, w.width, w.height];
  } else {
    return { note: "crop ignored: expected [x, y, w, h] or {widget}/{id}" };
  }
  const [x, y, w, h] = gui;
  return { rect: [(x - margin) * scale, (y - margin) * scale, (x + w + margin) * scale, (y + h + margin) * scale], scale };
}

// Pictures the budget may crop to their content: FRAMES, where the figure's place in the view
// carries nothing. Everything else that comes back as a picture is an address space - a texture
// sheet hands back the pixels whose (x, y) the next paint call names - and the first live run
// (2026-09-06) cropped a 16x16 sheet to 12x12. Those are resized at most (the cost line's "was
// WxH" keeps the scale readable), never cropped. An allow-list on purpose for the game's tools; a
// Blockbench picture says so ITSELF (`_image.frame`, BLOCKBENCH_BRIDGE_DESIGN.md section 3), so a
// new picture-returning plugin tool is safe by default and pays a little more.
const CONTENT_CROP = new Set([
  "screenshot", "render", "screenshot_annotated",
]);

/**
 * What every reply passes through on its way out: the image budget over its pictures, then the
 * loop checks the call triggered (successful calls only), then the note that a gate was forced.
 */
async function finishReply(name, reply, { max, rect, notes = [], forced = null, mechanism = null, frame = false } = {}) {
  let content = budgetContent(reply.content, { max, rect, findContent: CONTENT_CROP.has(name) || frame === true });
  const extra = [...notes];
  if (!reply.isError) {
    const stamped = mechanism ?? MECHANISM.get(name) ?? (isBlockbenchTool(name) ? blockbenchMechanism(name) : null);
    const check = await loopChecks.after(name, stamped);
    if (check) extra.push(check);
  }
  if (forced) extra.push(`forced past ${forced.standing.map((s) => `${s.problems} problem(s) from "${s.check}"`).join(", ")}: ${forced.why}`);
  if (extra.length) content = [...content, { type: "text", text: extra.join("\n") }];
  return { ...reply, content };
}

const DEFAULT_INSTRUCTIONS =
  "This MCP server is a bridge into a RUNNING Minecraft game. Nothing here is a mock: an act changes "
  + "the live world, and hotswap_class, push_data and push_asset change the running game. Call ping "
  + "first; it says whether a game and a world are present and which tool profile this session has. "
  + "Every reply carries `mechanism`: observe is a read you can believe, embodied and privileged are "
  + "acts you confirm with a read afterwards, local never touched the game. A read with "
  + "coverage.state other than complete is partial and says why. run_command answers ok:true for a "
  + "command that parsed, not one that did what you meant. A tool the profile hides refuses with "
  + "profile_hidden and names the tool_surface call that widens it.";

const server = new Server(
  { name: "mcp-toolkit", version: "0.1.0" },
  // `listChanged: true` is load-bearing, not decoration. A client registers its
  // notifications/tools/list_changed handler ONLY if the server declared this capability — Claude
  // Code 2.1.246 gates that registration on exactly `capabilities.tools.listChanged` and otherwise
  // never wires the refresh at all. Declaring `{ tools: {} }` therefore meant the snapshot the client
  // took at connect was the tool list it kept for the whole session. The watcher below is the other
  // half; this line is what makes anyone listen to it.
  {
    capabilities: { tools: { listChanged: true } },
    // The project's paragraph, served as this server's instructions (LOOP_KIT_DESIGN.md §5.3) -
    // and when the project supplies none, the toolkit's own (RELEASE_1.md §G): the one paragraph a
    // session with no charter at all still meets. docs/guides/SESSION_CHARTER.md is its site of
    // record; the text here is that file's first block, verbatim.
    instructions: LOOP?.profile?.instructions ?? DEFAULT_INSTRUCTIONS,
  },
);

// Bridge reachability is reported on TRANSITIONS only. The watcher below polls while the game is
// down, and a per-poll "bridge unreachable" line would bury the session's real stderr under a
// message whose news value expired after the first one.
let lastBridgeUp = null;
// Same transitions-only rule for the second upstream: Blockbench is closed most of the time, and a
// line per poll saying so would bury everything else on stderr.
let lastBlockbenchUp = null;
let warnedBlockbenchClash = false;
// The lazy first list (the call handler): one fetch in flight, and never faster than the watcher
// that would have done it anyway.
let firstBlockbenchList = null;
let lastLazyListAt = 0;

/**
 * The tool list this session serves: the local (non-proxied) tools, then the live bridge manifest,
 * profile- and hide-filtered. Never throws — a bridge that is down yields the local tools alone,
 * which is the honest answer, and `bridgeUp` says which of the two happened.
 */
async function buildToolList() {
  // Always fetch fresh — a stale manifest would advertise tools the attached game doesn't have
  // (e.g. consumer-mod tools after switching instances). Bridge down = local tools only, honestly.
  let tools;
  let bridgeUp = true;
  try {
    tools = await fetchManifest();
  } catch (e) {
    bridgeUp = false;
    if (lastBridgeUp !== false) {
      process.stderr.write(`[mcp-toolkit] bridge unreachable (${e.message}) — serving local tools only\n`);
    }
    tools = [];
  }
  if (bridgeUp && lastBridgeUp === false) {
    process.stderr.write(`[mcp-toolkit] bridge back up — ${tools.length} tool(s) in the manifest\n`);
  }
  lastBridgeUp = bridgeUp;
  checkContextColumn(tools);
  // The second upstream. Fetched only under a profile that serves it — a survival session must not
  // even poll a modelling app — and a failure is the ordinary "Blockbench isn't open" case, reported
  // on TRANSITIONS for the same reason the bridge is. Names once learned are KEPT across a switch
  // away (see dropBlockbenchNames): that is what lets a stale call be refused as `profile_hidden`
  // rather than forwarded to the game bridge as an unknown tool.
  let bbTools = [];
  if (BLOCKBENCH_URL && servesBlockbench(servedProfile)) {
    try {
      bbTools = await fetchBlockbenchTools();
      if (lastBlockbenchUp === false) {
        // WHICH WINDOW, not just "up": with a window per session that is the fact a second session
        // makes interesting, and the plugin's status box cannot answer it (one window, from inside).
        const w = blockbenchWindowNote();
        process.stderr.write(`[mcp-toolkit] blockbench up — ${bbTools.length} tool(s)`
          + `${w ? `, window ${w}` : ""}\n`);
      }
      lastBlockbenchUp = true;
    } catch (e) {
      if (lastBlockbenchUp !== false) {
        // Where it LOOKED: the range while no window has been resolved (a window's plugin takes the
        // first free port at or above the base), the one window once one has.
        process.stderr.write(`[mcp-toolkit] blockbench unreachable at ${blockbenchWhere()} `
          + `(${e.message}) — serving without it\n`);
      }
      lastBlockbenchUp = false;
    }
  }
  // Local agent-memory tools are merged in front of the proxied manifest; they stay available even
  // when the bridge is down (memory must be readable offline).
  const all = [
    // Absent, not merely hidden, under survival: see CAN_SWITCH_PROFILE.
    ...(CAN_SWITCH_PROFILE ? [SURFACE_TOOL] : []),
    ...localTools(),
    ...tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  ];
  // Blockbench LAST, and a colliding name loses. Zero of its 94 names collide with the captured
  // 90-tool bridge manifest today, which is why they pass through unprefixed at all — but a mod is
  // free to register `undo` or `create_project` onto the bridge tomorrow, and silently shadowing a
  // game tool with a modelling app's is the kind of thing that gets diagnosed as a haunted bridge.
  // Drop and say so; the game owns its names.
  if (bbTools.length) {
    const taken = new Set(all.map((t) => t.name));
    const clashes = bbTools.filter((t) => taken.has(t.name)).map((t) => t.name);
    if (clashes.length && !warnedBlockbenchClash) {
      warnedBlockbenchClash = true;
      process.stderr.write(`[mcp-toolkit] blockbench name(s) already taken by this session — `
        + `not served: ${clashes.join(", ")}\n`);
    }
    all.push(...bbTools.filter((t) => !taken.has(t.name)));
  }
  // Survival serves TRUTHFUL descriptions (SURVIVAL_SMALL_MODEL_PLAN.md P1): the shim reroutes
  // `locate` to the belief store, so the bridge's X-ray description would describe a different
  // tool than the one this profile answers with. Applied to the merged list, keyed by name.
  if (PROFILE === "survival") {
    for (const t of all) {
      const o = SURVIVAL_OVERRIDES[t.name];
      if (o?.description) t.description = o.description;
      if (o?.inputSchema) t.inputSchema = o.inputSchema;
    }
  }
  // The loop kit's view of the manifest: every tool's mechanism (for the check hook), which tools
  // declare `force` themselves (for the gate), and the entries as the client will see them —
  // screenshot's budget arguments, `force` on gated tools, the project's description notes.
  MECHANISM.clear();
  for (const t of tools) if (typeof t.mechanism === "string") MECHANISM.set(t.name, t.mechanism);
  for (const t of bbTools) MECHANISM.set(t.name, blockbenchMechanism(t.name));
  DECLARES_FORCE.clear();
  for (const t of all) if (t.inputSchema?.properties?.force) DECLARES_FORCE.add(t.name);
  for (let i = 0; i < all.length; i++) all[i] = decorate(all[i]);
  // A project keep-list gets the loud typo check the built-in narrow slices deliberately do not:
  // a project author has no probe file to make a misspelt name visible, and a kept name that is
  // simply never served is the keep-list's silent failure mode. Once, against the live manifest,
  // and only once the bridge has answered (an empty manifest would flag everything).
  if (!warnedProjectKeep && tools.length && KEEP_PROFILES.project) {
    warnedProjectKeep = true;
    const known = new Set(all.map((t) => t.name));
    const missing = [...KEEP_PROFILES.project].filter((n) => !known.has(n));
    if (missing.length) {
      process.stderr.write(`[mcp-toolkit] loop file profile.keep: ${missing.length} name(s) not in `
        + `this manifest, so never served: ${missing.join(", ")}`
        + `${BLOCKBENCH_URL && servesBlockbench("project") && !bbTools.length ? " (Blockbench is not up; its names appear when it is)" : " - a typo, or a tool this game does not have"}\n`);
    }
  }
  // A GATE NAMING A TOOL THIS SHIM DOES NOT SERVE GATES NOTHING, and until 0.124.0 nothing said so.
  // The shipped example loop file gated `armorpieces_save`, which lives in ArmorPieces' own proxy:
  // the call never passes through here, so the "guard" was a line in a file (LOOP_KIT_DESIGN.md
  // section 11, finding 4). Same shape as the keep-list warning above - once, against the live
  // manifest, and with the Blockbench caveat, since a gate on a Blockbench name is only checkable
  // once Blockbench has answered.
  if (!warnedGate && tools.length && LOOP?.checks.length) {
    warnedGate = true;
    const known = new Set(all.map((t) => t.name));
    for (const c of LOOP.checks) {
      const missing = [...c.gate].filter((n) => !known.has(n));
      if (!missing.length) continue;
      process.stderr.write(`[mcp-toolkit] loop file check "${c.name}".gate: ${missing.length} name(s) this session does `
        + `not serve, so the gate does nothing for them: ${missing.join(", ")}`
        + `${BLOCKBENCH_URL && servesBlockbench(servedProfile) && !bbTools.length ? " (Blockbench is not up; its names appear when it is)"
          : " - a tool of another MCP server cannot be gated here; gate it there, or drop the entry"}\n`);
    }
  }
  // THE KEEP-LIST'S MIRROR OF THE WARNING BELOW, and the one thing §C5 actually owed. A hide-list
  // that names a missing tool is loud; a keep-list that MISSES a present one is silent, which is how
  // `query_class`, `get_perf`, `roll_loot` and `preview_worldgen` all shipped without any keep-list
  // profile inheriting any of them and nothing said so for weeks. Only the DEFAULT carries the
  // obligation to declare its complement - a narrow slice like `art` is defined by what it leaves
  // out - so this checks `modding` alone, and it checks against the LIVE manifest rather than a
  // list, because the failure being caught is precisely a tool that exists and nobody classified.
  if (!warnedUndeclared && tools.length && servedProfile === "modding") {
    warnedUndeclared = true;
    const declared = new Set([...MODDING_KEEP, ...MODDING_EXCLUDED, SURFACE_TOOL_NAME]);
    const undeclared = all.map((t) => t.name).filter((n) => !declared.has(n));
    if (undeclared.length) {
      process.stderr.write(`[mcp-toolkit] profile "modding": ${undeclared.length} tool(s) in neither `
        + `MODDING_KEEP nor MODDING_EXCLUDED, so the default silently excludes them: `
        + `${undeclared.join(", ")} — classify each in index.mjs\n`);
    }
  }
  // A hide-name that matches nothing silently isn't hiding anything — the profile then isn't the
  // profile we think it is, which is the same failure the bench runner guards against. Warn once,
  // never throw: a mod without a consumer tool must not break tool serving.
  if (!warnedUnknownHidden && tools.length) {
    warnedUnknownHidden = true;
    const known = new Set(all.map((t) => t.name));
    // Conditionally-present names must not trip the loud warning: CLIENT_SURFACE is absent when no
    // game client is attached, EXTENSION_SURFACE when the mod that owns it isn't loaded. In both
    // cases an absent name is the expected shape, not a typo'd hide.
    const conditional = new Set([...CLIENT_SURFACE, ...EXTENSION_SURFACE]);
    const unknown = [...HIDDEN].filter((n) => !known.has(n) && !conditional.has(n));
    if (unknown.length) {
      process.stderr.write(`[mcp-toolkit] profile "${servedProfile}": ${unknown.length} hidden name(s) `
        + `not in this manifest (no-ops): ${unknown.join(", ")}\n`);
    }
  }
  return { tools: all.filter((t) => isServed(t.name)), bridgeUp };
}

// --- keeping the client's tool list current -------------------------------------------------------
// tools/list is a SNAPSHOT, and the client takes exactly one — at connect. In this workspace the
// game routinely boots AFTER the session does (`launch_game` is a local tool for precisely that
// reason), so the snapshot the client kept said "local tools only" and the ~65 bridge tools stayed
// invisible until Claude itself was restarted with a game already running. The protocol's answer is
// notifications/tools/list_changed, and the capability declared above is what makes a client listen
// for it.
//
// Two signatures, not one. `servedSig` is what the client actually HOLDS (only a real tools/list
// answer sets it); `notifiedSig` is what we last announced. Announcing only when a fresh list differs
// from BOTH means one change produces one notification even against a client that ignores it — the
// failure mode degrades to silence, never to a notification every poll.
let servedSig = null;
let notifiedSig = null;

function signature(tools) {
  return createHash("sha1").update(JSON.stringify(tools)).digest("hex");
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const { tools } = await buildToolList();
  servedSig = signature(tools);
  notifiedSig = null; // the client is in sync again; the next real change gets its own notification
  return { tools };
});

// Cadence is asymmetric on purpose. While the bridge is DOWN the poll is a localhost ECONNREFUSED
// (free) and the thing being waited for is a game boot a human is sitting through, so look often.
// While it is UP the poll parses a manifest, and the transitions left — the game quitting, a client
// attaching its screen tools — tolerate a lazier eye.
const WATCH_DOWN_MS = 3_000;
const WATCH_UP_MS = 15_000;
// A notification a client HONOURS is not free: it rewrites the tool block at the very front of the
// prompt, so the client re-reads the whole SERVED list — the thing it holds, which is NOT the bridge
// manifest (the session adds its local tools and subtracts what the profile hides) — and the prompt
// cache is invalid from that point on. Order of magnitude: ~40k tokens.
// THE EXACT FIGURE IS DELIBERATELY NOT REPEATED HERE. It lives at KEEP_PROFILES, which is the one
// site of record for what a served list costs, because that is where it is load-bearing; this
// comment only needs the magnitude to justify a floor. A number that must be maintained in three
// places is maintained in one and stale in two — which is exactly how "roughly 80%" survived in two
// copies after being corrected in a third (see there). WHEN A MEASURED NUMBER MOVES, GREP FOR IT;
// better still, give it one home and cite it from everywhere else. A game boot
// is worth that price exactly once. A tool that FLAPS (a conditional surface toggling as a client
// attaches and detaches) would charge it over and over, so notifications have a floor, set above
// WATCH_UP_MS so no flap can outrun it.
const NOTIFY_FLOOR_MS = 30_000;
let lastNotifiedAt = 0;

/**
 * Tell the client its tool list moved. ONE place stamps lastNotifiedAt, because two would let the
 * floor be evaded by whichever path forgot.
 *
 * The floor belongs to the CALLER, not to notification. The watcher detects INVOLUNTARY change — a
 * game booting, a client attaching its screen surface — and cannot tell a real change from a flap, so
 * it pays the floor. A deliberate switch is not detection at all: the caller already knows, and asked.
 * It still stamps the clock, though. The ~39.4k was just spent, so a game boot two seconds later can
 * wait out the floor like any other — otherwise switch-then-boot is two full re-reads back to back,
 * which is the thing the floor exists to prevent, arrived at from the other side.
 */
async function notifyToolList(tools, { force = false, why = "tool list changed" } = {}) {
  // servedSig === null means the client has never asked: it holds nothing, so nothing can be stale,
  // and firing before the transport is up would only throw.
  if (servedSig === null) return "no-client";
  const sig = signature(tools);
  if (!force && (sig === servedSig || sig === notifiedSig)) return "unchanged";
  if (!force && lastNotifiedAt !== 0 && Date.now() - lastNotifiedAt < NOTIFY_FLOOR_MS) {
    // Deliberately NOT recording notifiedSig: the next poll re-decides against the live list, so a
    // flap that settles back to what the client already holds ends up costing nothing, and one that
    // sticks still lands as soon as the floor lifts.
    process.stderr.write(`[mcp-toolkit] tool list changed again within ${NOTIFY_FLOOR_MS / 1000}s`
      + ` — holding the notification (a re-read costs the whole served list)
`);
    return "held";
  }
  notifiedSig = sig;
  lastNotifiedAt = Date.now();
  try {
    await server.sendToolListChanged();
    process.stderr.write(`[mcp-toolkit] ${why} (${tools.length} tools`
      + `${force ? ", deliberate" : ""}) — told the client to re-read it
`);
    return "sent";
  } catch (e) {
    // A transport that has gone away. Nothing to tell, and nothing worth dying over.
    process.stderr.write(`[mcp-toolkit] tools/list_changed notification failed: ${e.message}
`);
    return "failed";
  }
}

async function watchToolList() {
  let up = false;
  try {
    const { tools, bridgeUp } = await buildToolList();
    up = bridgeUp;
    await notifyToolList(tools, { why: `tool list changed (bridge ${bridgeUp ? "up" : "down"})` });
  } catch { /* buildToolList swallows its own failures; this is belt and braces */ }
  setTimeout(watchToolList, up ? WATCH_UP_MS : WATCH_DOWN_MS).unref();
}

/**
 * `tool_surface`. Reports on no argument; switches on `profile`. Returns the PRICE either way — the
 * tool that costs the manifest is the one place a caller will actually read what it cost, and a
 * caller flipping profiles to browse should be able to see itself doing it.
 */
async function callSurfaceTool(args) {
  const available = [...Object.keys(PROFILES), ...Object.keys(KEEP_PROFILES)]
    .filter((p) => p !== "survival"); // a launch contract, never a destination — see CAN_SWITCH_PROFILE
  // The names alone were not an answer to "what else is available": a caller reading
  // `["full","standard","entity","play","survey","modding",...]` has to already know the answer to
  // use it, and nothing told it that three of those are research surface. One line each, from the
  // same PROFILE_META the start-up line and `ping` read, so there is no second copy to go stale.
  const describe = (n) => ({
    profile: n,
    kind: PROFILE_META[n]?.kind ?? "unknown",
    role: PROFILE_META[n]?.role ?? null,
    ...(isExperimental(n) ? { experimental: true } : {}),
  });
  const before = (await buildToolList()).tools;
  const target = args?.profile;
  if (target === undefined || target === null || target === "") {
    return {
      ...describe(servedProfile),
      tools: before.length,
      chars: priceOf(before),
      approx_tokens: Math.round(priceOf(before) / 4),
      available: available.map(describe),
      // The loop file's contribution, priced: a description note rides the manifest every turn like
      // the entry it is appended to, so a project that writes forty sentences should see the bill.
      ...(LOOP ? {
        loop: {
          file: LOOP.path,
          checks: LOOP.checks.map((c) => ({ name: c.name, after: [...c.mechanism, ...c.tools], gate: [...c.gate] })),
          ...(LOOP.profile ? (() => {
            const served = new Set(before.map((t) => t.name));
            const notes = Object.entries(LOOP.profile.notes).filter(([n]) => served.has(n));
            const chars = notes.reduce((s, [, v]) => s + String(v).length, 0);
            return { notes: notes.length, notes_chars: chars, notes_approx_tokens: Math.round(chars / 4),
              instructions_chars: (LOOP.profile.instructions ?? "").length };
          })() : {}),
        },
      } : {}),
      note: "pass `profile` to switch; the client re-reads the whole list, so switch once when you "
        + "learn the job, not to browse",
    };
  }
  if (typeof target !== "string" || !available.includes(target)) {
    return { error: `unknown profile "${target}" (available: ${available.join(", ")})`,
      available: available.map(describe) };
  }
  if (target === servedProfile) {
    return { profile: servedProfile, tools: before.length, chars: priceOf(before), unchanged: true };
  }
  const from = servedProfile;
  applyProfile(target);
  const after = (await buildToolList()).tools;
  const notified = await notifyToolList(after, { force: true, why: `profile ${from} -> ${target}` });
  const served = new Set(after.map((t) => t.name));
  return {
    ...describe(servedProfile),
    was: from,
    tools: after.length,
    was_tools: before.length,
    chars: priceOf(after),
    was_chars: priceOf(before),
    // What this switch COST to perform, beside what it saves per turn from here on. Both, because
    // one call's price and every later turn's saving are different numbers and only one is recurring.
    reread_cost_tokens: Math.round(priceOf(after) / 4),
    saves_per_turn_tokens: Math.round((priceOf(before) - priceOf(after)) / 4),
    dropped: before.map((t) => t.name).filter((n) => !served.has(n)),
    notified,
  };
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (!isServed(req.params.name)) {
    // A live switch narrows the surface IMMEDIATELY, but the client holds its old tool list until it
    // re-reads — so a call that was legal when that list was taken can land after the narrowing.
    // "Unknown tool" would send the caller hunting a toolkit bug for something that is neither
    // unknown nor a bug; say what happened and what fixes it. Under survival the old wording stays:
    // there the hidden set is an ablation/legality boundary rather than a choice, and naming what
    // sits behind it teaches surface the profile exists to not teach.
    const text = CAN_SWITCH_PROFILE && !ENV_HIDDEN.has(req.params.name)
      ? `profile_hidden: "${req.params.name}" is not served by the current tool profile `
        + `("${servedProfile}"). Your tool list is stale — re-read it, or call ${SURFACE_TOOL_NAME} `
        + `to widen the surface.`
      : `Unknown tool: ${req.params.name}`;
    return { content: [{ type: "text", text }], isError: true };
  }
  // The save gate (LOOP_KIT_DESIGN.md §5.2): a tool the loop file gates is refused while the last
  // check left problems standing, unless the call says `force:"<why>"`. Decided BEFORE routing so
  // it holds for every upstream alike, and `force` is stripped here for every tool that did not
  // declare it itself — the argument is the shim's, and the bridge's ArgCheck would refuse it.
  const verdict = loopChecks.gate(req.params.name, req.params.arguments);
  if (verdict.refused) {
    return { content: [{ type: "text", text: verdict.refused }], isError: true };
  }
  if (req.params.arguments && "force" in req.params.arguments && !DECLARES_FORCE.has(req.params.name)) {
    const { force: _force, ...rest } = req.params.arguments;
    req.params.arguments = rest;
  }
  if (req.params.name === SURFACE_TOOL_NAME) {
    if (!CAN_SWITCH_PROFILE) {
      return { content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }], isError: true };
    }
    // Handled entirely in the shim: the profile IS shim state, and the bridge has no opinion about
    // which slice of its manifest a session chose to carry.
    const r = await callSurfaceTool(req.params.arguments);
    return {
      content: [{ type: "text", text: JSON.stringify(r) }],
      isError: r.error !== undefined,
    };
  }
  // A CALL BEFORE THIS SESSION'S FIRST LIST (BLOCKBENCH_BRIDGE_DESIGN.md section 9). The shim learns
  // the plugin's names when it BUILDS the manifest, so until that has happened once a Blockbench
  // name is not `isBlockbenchTool`: it falls past the branch below, is forwarded to the GAME bridge,
  // and is refused there as an unknown tool - which sends the caller hunting a Blockbench fault in
  // the wrong process. Every real client lists first (the probes' harness did not, once) and the
  // watcher closes the gap within WATCH_DOWN_MS, so this is a race and not a regime; the fix is one
  // lazy list, and the trigger is narrow enough not to be a guess at the caller: only while this
  // session has NO Blockbench manifest at all, which is the one state where an unknown name has no
  // list to be a typo against. One fetch in flight, never oftener than the watcher's own cadence,
  // and Blockbench being shut is the ordinary answer rather than an error - it costs a refused
  // connection and the name goes on to the game exactly as before.
  if (BLOCKBENCH_URL && servesBlockbench(servedProfile) && !hasBlockbenchManifest()
      && !MECHANISM.has(req.params.name) && !isLocalTool(req.params.name)
      && Date.now() - lastLazyListAt >= WATCH_DOWN_MS) {
    if (!firstBlockbenchList) {
      lastLazyListAt = Date.now();
      firstBlockbenchList = fetchBlockbenchTools()
        .catch(() => [])
        .finally(() => { firstBlockbenchList = null; });
    }
    await firstBlockbenchList;
  }
  // The Blockbench upstream. Answered here, before any of the bridge machinery below: none of it
  // applies to a modelling app. There is no world to capture into the observation store, no
  // ambient retina to keep awake, no danger digest, and no route ledger - that ledger exists to
  // catch "this word means nothing to me" on `locate`, and a mesh tool has no such failure. The
  // plugin answers the bridge's envelope {ok, result, mechanism}; a `_image` on the result becomes
  // an image part (its `frame` flag decides whether the budget may crop it), the reply's own
  // mechanism stamp drives the loop hook, and the budget's `max` comes off here.
  if (isBlockbenchTool(req.params.name)) {
    let max;
    if (BLOCKBENCH_PICTURES.has(req.params.name) && req.params.arguments && "max" in req.params.arguments) {
      ({ max, ...req.params.arguments } = req.params.arguments);
    }
    try {
      const env = await callBlockbench(req.params.name, req.params.arguments);
      const result = env.result ?? {};
      let content;
      let frame = false;
      if (result && typeof result === "object" && result._image) {
        const { _image, ...rest } = result;
        frame = _image.frame === true;
        content = [{ type: "image", data: _image.base64, mimeType: _image.mimeType ?? "image/png" }];
        if (Object.keys(rest).length) content.push({ type: "text", text: JSON.stringify(rest) });
      } else {
        content = [{ type: "text", text: JSON.stringify(result) }];
      }
      return await finishReply(req.params.name, { content }, { max, forced: verdict.forced, mechanism: env.mechanism, frame });
    } catch (e) {
      return { content: [{ type: "text", text: e.message }], isError: true };
    }
  }
  // Survival is legal by construction, not by charter goodwill (SURVIVAL_MODE_PLAN.md §3):
  // authoritative perception cannot be requested, and every new body starts perceived (below).
  //
  // SECOND LINE since the 2026-08-11 trim: `bot_profile` is now in SURVIVAL_DEAD, so the HIDDEN
  // gate above answers "Unknown tool" first and this branch is unreachable through MCP. Kept
  // deliberately — the day anyone un-hides the verb (it is dark surface, not illegal surface) the
  // legality lock must already be here rather than needing to be remembered. Note the enforcement
  // that actually runs now is the spawn-time one below: it reaches bot_profile via callTool, the
  // raw bridge helper, which does not consult HIDDEN — so hiding the verb did not disarm it.
  if (PROFILE === "survival" && req.params.name === "bot_profile"
      && req.params.arguments?.perception === "authoritative") {
    return {
      content: [{ type: "text", text: "legal_profile_locked: the survival profile perceives through the belief store; authoritative (X-ray) perception is not available in this session" }],
      isError: true,
    };
  }
  // Surface-view mode renders get_surface as a compact map, but leaves an ESCALATION path: an
  // explicit detail:"full" is honored as raw per-column data. The map is lossy in one axis —
  // per-column exact Y is aggregated to a per-block band + listed outliers (the map advertises this)
  // — so a task needing exact adjacent heights (reachability, per-tile variance) can ask for full
  // and get certainty back. The default/summary path force-fetches full to *build* the map (its
  // legend still carries the histogram that summary mode would give).
  // The image budget's two arguments on `screenshot` (LOOP_KIT_DESIGN.md §5.1) are the SHIM's: they
  // come off before the bridge sees the call, and a `crop` naming a widget is resolved against a
  // layout taken now, before the frame, so the widget and the pixels are the same screen.
  let shot = null;
  if (req.params.name === "screenshot" && req.params.arguments
      && ("max" in req.params.arguments || "crop" in req.params.arguments)) {
    const { max, crop: cropArg, ...rest } = req.params.arguments;
    req.params.arguments = rest;
    shot = { max: Number.isFinite(max) ? Math.max(0, Math.floor(max)) : undefined, crop: cropArg, layout: null };
    if (cropArg !== undefined) {
      try {
        const l = await callTool("get_screen", { detail: "layout" });
        shot.layout = l.ok ? l.result : null;
      } catch { shot.layout = null; }
    }
  }
  const askedFull = req.params.arguments?.detail === "full";
  const surface = GET_BLOCKS_VIEW === "surface" && req.params.name === "get_surface" && !askedFull;
  const callArgs = surface
    ? { ...(req.params.arguments ?? {}), detail: "full" }
    : req.params.arguments;
  // Survival routes `locate` to memory (SURVIVAL_MODE_PLAN.md §6): the X-ray search never runs,
  // answers come from the provenance-filtered observation store, and a miss carries the frontier.
  const legalLocal = PROFILE === "survival" && req.params.name === "locate";
  let data;
  const startedAt = Date.now();
  try {
    data = legalLocal
      ? await legalLocate(callArgs, callTool)
      : isLocalTool(req.params.name)
        ? await callLocalTool(req.params.name, callArgs, callTool)
        : await callTool(req.params.name, callArgs);
  } catch (e) {
    // Transport-level failures are recorded too, and classify as `environment` — pooling them with
    // the design signal is how a dead dev server would read as a wave of model confusion.
    await recordOutcome({
      tool: req.params.name, args: callArgs, ok: false, error: e.message,
      session: sessionId, world: await currentWorld(), profile: servedProfile, ms: Date.now() - startedAt,
    });
    return { content: [{ type: "text", text: e.message }], isError: true };
  }
  // Record what the TOOL answered, before the fallthroughs below rewrite it. This ordering is the
  // whole point of the ledger: the unresolvable-`what` fallthrough turns the single most informative
  // failure the toolkit has ("this word means nothing to me") into a plausible answer from memory,
  // so recording after it would erase exactly the signal the route layer is built from
  // (ROUTE_LEDGER_DESIGN.md §2).
  await recordOutcome({
    tool: req.params.name, args: callArgs, ok: data.ok, error: data.error, result: data.result,
    session: sessionId, world: await currentWorld(), profile: servedProfile, ms: Date.now() - startedAt,
  });
  if (req.params.name === "get_world_info" && data.ok && data.result?.world_uuid) {
    ledgerWorld = data.result.world_uuid; // free refresh; a world switch must not mislabel rows
  }
  // `ping` answers "what is this bridge"; the profile is the half of that answer the bridge cannot
  // give. It is SHIM state - the bridge only ever sees it as an X-MCPTK-Profile header on whatever
  // request happens to be in flight - so it is attached here, on the one call whose entire job is
  // orientation, and it costs nothing per turn because it is a RESULT rather than a manifest entry.
  //
  // RELEASE_1.md §C4 wanted this specifically so an EXPERIMENTAL profile is visible from inside a
  // session. `experimental` is stated as a field and not left to be inferred from the name: a
  // session that has to recognise "survey" as research surface has already failed to.
  if (req.params.name === "ping" && data.ok && data.result && typeof data.result === "object") {
    const meta = PROFILE_META[servedProfile];
    data.result.profile = {
      name: servedProfile,
      kind: meta?.kind ?? "unknown",
      role: meta?.role ?? null,
      experimental: isExperimental(servedProfile),
      // A switch that happened is a fact about this session that nothing else reports: the profile
      // it was LAUNCHED under is the one its workspace configured, and its legality gates are bound
      // to that one (see CAN_SWITCH_PROFILE), not to whatever it is serving now.
      launched_as: PROFILE,
      switchable: CAN_SWITCH_PROFILE,
    };
    // And WHICH BLOCKBENCH WINDOW, for the same reason and on the same call. With a window per
    // session (BLOCKBENCH_ISOLATION_DESIGN.md §6.3) the interesting question is no longer "is
    // Blockbench up" but "is this session working in a window of its own" - and `shared:true` is
    // the answer that changes what a session should do: name `project` on every call, because the
    // active tab belongs to somebody else. Only when the surface is actually served: a profile
    // without it must not grow a field about a door it cannot open.
    const bb = servesBlockbench(servedProfile) ? blockbenchWindow() : null;
    if (bb) {
      data.result.blockbench = {
        port: bb.port, window: bb.window,
        held: bb.shared ? "shared" : bb.pinned ? "pinned" : bb.claimed ? "this session" : "unclaimed",
        session: blockbenchSession().id,
      };
    }
  }
  // A `what` that resolves against no registry no longer dead-ends. Two fallthroughs, in this order:
  //   1. ROUTE — the concept has a stored definition ("tree" → #minecraft:logs), so run it as a real
  //      search of the world, disclosing the interpretation (ROUTE_LEDGER_DESIGN §4).
  //   2. MEMORY — no route: answer from authored places/notes/blocks plus captured sightings
  //      (MEMORY_REDESIGN §3).
  // The order is not arbitrary. A route answers "where is a tree" — a class of block, live. Memory
  // answers "where is the wheat farm" — a place, remembered. A place has no route and never will,
  // which is why the memory fallthrough keeps the last word rather than the first.
  if (!data.ok && req.params.name === "locate" && isUnresolvableWhat(data.error)) {
    const routed = await tryRoute(req.params.arguments, callTool,
      { session: sessionId, world: ledgerWorld, profile: servedProfile });
    data = routed ?? await locateFromMemory(req.params.arguments?.what, callTool).catch(() => data);
  }
  if (!data.ok) {
    return { content: [{ type: "text", text: data.error || "bridge error" }], isError: true };
  }
  // ANY successful call keeps the ambient retina looking. Not just `bot_*`: gating on the embodied
  // verbs meant a session that PERCEIVED rather than moved went blind 30s after its spawn, and then
  // fell back to hand-rolled raycasts — which did not refresh the window either, so the blindness
  // fed itself (live-caught, second watched run). The guardrail that matters is "an ABANDONED
  // session must not poll the bridge forever", and any tool call disproves abandonment.
  ambient.noteActivity();
  // Danger rides the acts (SURVIVAL_SMALL_MODEL_PLAN.md P5): under survival, peek the event log
  // after every successful non-poll call and append any UNREAD danger to this result. Event
  // polling as a discipline is how bodies have died — the digest makes the pain arrive with
  // whatever the agent was doing instead. Each event is digested once; the agent's own get_events
  // still delivers the full rows.
  let danger = null;
  if (PROFILE === "survival") {
    if (req.params.name === "get_events") {
      noteDelivered(req.params.arguments, data.result);
    } else {
      danger = await dangerDigest(callTool);
    }
  }
  // Proprioception (SURVIVAL_MODE_PLAN §4): nav verdicts carry the body's traversal trail
  // (`traversed` rows + the embodied envelope) — capture it as the reserved legal provenance
  // "proprioception", whether it arrives on a waited verdict or a polled get_events row.
  if (data.result && typeof data.result === "object") {
    if (Array.isArray(data.result.traversed)) {
      await captureProprioception(data.result, callTool);
      consumeTrail(data.result);
    } else if (req.params.name === "get_events" && Array.isArray(data.result.events)) {
      for (const ev of data.result.events) {
        if (ev?.data && Array.isArray(ev.data.traversed)) {
          await captureProprioception(ev.data, callTool);
          consumeTrail(ev.data);
        }
      }
    }
    // Act capture (w2 postmortem): the body's own verified mines/places update the seen store —
    // provenance "act" — whether the verdict arrived on this call or as a polled completion row.
    // Same both-paths shape as proprioception above, for the same reason: wait:false outcomes
    // only ever surface through get_events.
    if (data.result.mined || data.result.placed || data.result.ledger) {
      await captureActOutcome(data.result, callTool);
    } else if (req.params.name === "get_events" && Array.isArray(data.result.events)) {
      for (const ev of data.result.events) {
        if (ev?.data && (ev.data.mined || ev.data.placed || ev.data.ledger)) {
          await captureActOutcome(ev.data, callTool);
        }
      }
    }
  }
  // Survival: a body that just came up is put in perceived mode BEFORE the agent can act through
  // it. Await (not fire-and-forget) so no tool call can slip between spawn and the lock; a failure
  // is loud — a survival body running authoritative perception is the silent-cheat failure mode.
  if (PROFILE === "survival" && req.params.name === "bot_body"
      && ["spawn", "possess"].includes(req.params.arguments?.action)) {
    try {
      const p = await callTool("bot_profile", { perception: "perceived" });
      if (!p.ok) process.stderr.write(`[mcp-toolkit] survival: bot_profile perceived REFUSED after ${req.params.arguments.action}: ${p.error}\n`);
    } catch (e) {
      process.stderr.write(`[mcp-toolkit] survival: bot_profile perceived FAILED after ${req.params.arguments.action}: ${e.message}\n`);
    }
  }
  // Capture + annotate (OBSERVATION_MEMORY_DESIGN §7.2, MEMORY_REDESIGN §2.2): record what this
  // world read returned, mechanically, before any view re-encoding — the store holds the tool's own
  // values, not a view — and append a labelled `remembered` section when memory has something this
  // live result does not. processWorldRead never throws and ignores non-captured tools; the .catch
  // is belt-and-braces so neither half can break a tool result.
  let annotation = null;
  if (!isLocalTool(req.params.name) && !legalLocal) {
    // legalLocal answers ARE memory — capturing or annotating them would be memory riding memory.
    annotation = await processWorldRead(req.params.name, callArgs, data.result, callTool).catch(() => null);
    attachRemembered(data.result, annotation);
  }
  // Re-encode oversized raw get_surface as a compact surface map when the flag is on. Guarded so a
  // renderer failure can never break the tool — worst case the model gets the raw result.
  let result = data.result;
  if (surface && result && typeof result === "object") {
    try { result = asciiSurfaceView(result); } catch { /* fall back to raw */ }
    // The view builds a fresh object from the raw fields, so the appendix has to be re-attached or
    // the one tool with a view transform would silently lose its memory annotation.
    attachRemembered(result, annotation);
  }
  // Tools that produce an image put it under `_image` ({mimeType, base64}); surface it as image content
  // plus a text part carrying the rest of the result.
  if (danger && result && typeof result === "object") {
    result.danger = danger;
  }
  if (result && typeof result === "object" && result._image) {
    const { _image, ...rest } = result;
    const content = [{ type: "image", data: _image.base64, mimeType: _image.mimeType }];
    if (Object.keys(rest).length > 0) {
      // Compact on purpose: pretty-printing inflates every result ~25-40% in tokens, and every
      // result is re-read by every subsequent model call for the life of the session.
      content.push({ type: "text", text: JSON.stringify(rest) });
    }
    // The budget (finishReply) shrinks the picture and prices it. A `crop` resolves here, where
    // the frame's own size is finally known: the GUI scale is frame.width over screen.width.
    let rect = null;
    const notes = [];
    if (shot?.crop !== undefined) {
      const frame = { width: rest.width, height: rest.height };
      if (!Number.isFinite(frame.width)) {
        notes.push("crop ignored: the screenshot reply carried no frame size");
      } else {
        const c = resolveCrop(shot.crop, shot.layout, frame);
        if (c.rect) rect = c.rect; else notes.push(c.note);
      }
    }
    return finishReply(req.params.name, { content }, { max: shot?.max, rect, notes, forced: verdict.forced });
  }
  return finishReply(req.params.name, { content: [{ type: "text", text: JSON.stringify(result) }] },
    { forced: verdict.forced });
});

await server.connect(new StdioServerTransport());
setTimeout(watchToolList, WATCH_DOWN_MS).unref();
