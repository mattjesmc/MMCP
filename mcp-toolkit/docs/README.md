# Design records, by subject

These are histories, not manuals. The manuals are one level up: `../LIVE_MODDING.md` (workflow),
`../EXTENDING.md` (API), `../ARCHITECTURE.md` (vocabulary and decisions), and `../README.md` maps
each task to the section to read. Every record opens with a status line and ends with its
"as built" or "tested" sections; read those before the thesis.

## guides/ - how-tos written for an outside modder
- `LOOPS.md` - authoring many units of one kind: the cost arithmetic and the six levers in order (image budget, loop file, project profile, batch tools, pinned judgement, one session per unit).
- `ADAPTER.md` - connecting an agent program to a running game: the registration, and how to verify it. Was "writing an agent-client adapter" until 0.143.0 archived that half.
- `SESSION_CHARTER.md` - what an agent session in a MOD repository should know before its first tool call, pasteable into that repository's `CLAUDE.md`; its first paragraph is what the MCP server serves as `instructions` by default.

## screens/ - GUI screens as documents
- `SCREEN_AUTHORING_DESIGN.md` - the compiler: `.ui.json` document, interpreter preview, in-game editor, emitted Java. Sections 17-23 are slices 1-6 as built and the authoring world. The authority behind `ui_doc`.
- `UI_PARTS_LIBRARY_DESIGN.md` - the missing primitives, the `part` and `repeat` macros, the parts library; section 7 as built (0.121.0).

## models/ - Blockbench, entities, rendering
- `BLOCKBENCH_BRIDGE_DESIGN.md` - the toolkit's own Blockbench plugin (now 0.5.0): why the third-party one was replaced, the bridge-shaped transport, session-bound projects and the queue, the 26-tool surface and its migration table; section 10 as built, 12 what a consumer measured, 13 the three replies made true (0.137.0), 14 what a second window breaks (0.138.0), 15 a window each (0.139.0).
- `BLOCKBENCH_ISOLATION_DESIGN.md` - what "one session's work is its own" can mean: the tab already owns undo and camera, one project can be live at a time so a shared window cannot be made safe, the window is the smallest real boundary. Identity from the parent process id, then a window per session. **Steps 1 and 2 are both BUILT - 0.136.0 (identity, confirmed live) and 0.139.0 (per-window ports and window claiming, section 6.3, offline-green and LIVE-UNRUN)**; section 9 is the A/B that decided step 2 (concurrency bought negative wall clock), section 8 the measured resource and backup work, neither of which argues for step 3. **The live arm, including the A/B re-run that would pay for it, is `TODO.md` 3.4.** **Section 11 is the MCP DOCK (0.144.0 / plugin 0.8.0, built and RUN LIVE)**: a live scan found six windows serving with nothing open in any of them and no death condition that could fire, which is what a window governing itself out of its own memory costs. The window stays the unit of ownership and stops being the unit of government - one dedicated window owns the roster, hands windows out, arbitrates every close, and is never claimed and never closes itself. 11.4 is the ceiling that shapes it: the plugin sandbox allows no `electron`, so every cross-window act is a request the target window serves for itself.
- `ENTITY_AUTHORING_DESIGN.md` - from Blockbench geometry to a preview entity standing in the game; the `mcptoolkit_entity.js` plugin; animation (`format: 2`).
- `RENDER_SEAM_DESIGN.md` - the camera, framing and orbit, the studio dimension, the `render` and `studio` tools; sections 11-14 as built (0.102.0 to 0.113.0).

## world/ - blocks, structures, worldgen
- `STRUCTURE_AUTHORING_DESIGN.md` - `place_shapes` batching, its measurement, the manifest trim, rocketeer's authoring ask (sections 4-9).
- `WORLDGEN_ITERATION_DESIGN.md` - `preview_worldgen`; phase 1 built (0.103.0), phases 2-3 not.

## loops/ - authoring at scale
- `LOOP_KIT_DESIGN.md` - what ArmorPieces measured, the loop taken apart, the kit (loop file, gate, profile, image budget, batch painters); sections 8-11 as built, tested live and falsified by ArmorPieces' next part (0.122.0 to 0.124.0). The how-to is `guides/LOOPS.md`.

## platform/ - loaders, the extension seam, agent clients, profiles, sessions
- `IN_JAR_MCP_DESIGN.md` - **the game's own MCP server** (0.146.0): `POST http://127.0.0.1:<port>/mcp`, in the jar, with no Node and nothing to install. Why the shim stays anyway, what does not come through the new door, and the one thing only it can do - a URL that names its tool surface.
- `CROSS_LOADER_DESIGN.md` - one jar for Fabric and NeoForge, dev and production; sections 12-16 as proven.
- `HEADLESS.md` - GENERATED (`tools/headless-doc.mjs`): every tool's execution context, the table a dedicated-server suite is written against (0.129.0).
- `EXTENSION_DESIGN.md` - the third-party tools and modded-data seam that `../EXTENDING.md` documents.
- `AGENT_CLIENT_ADAPTER_DESIGN.md` - the toolkit stops being a Claude Code accessory (RELEASE_1 section A). **HISTORY**: what it designed - adapters, kits, capabilities, the in-game launcher - was archived in 0.143.0, and the record is kept for why it was built and what its removal cost.
- `COMPANION_REDESIGN.md` - sessions, chat routing, the workbench as orchestrator (implemented 2026-07-21).
- `TOOL_BILL_PLAN.md`, `TOKEN_PER_TOOL_FINDINGS.md` - what a manifest entry costs per turn, and the profiles that came out of measuring it.

## memory/ - per-world agent memory (implemented in `../../mcp-server/memory/`)
- `MEMORY_DESIGN.md` - authored memory: the `mem_*` tools, the store, embeddings (phases A and B).
- `OBSERVATION_MEMORY_DESIGN.md` - captured observations, not authored.
- `MEMORY_REDESIGN.md` - memory rides the reads: the `remembered` appendix.
- `ROUTE_LEDGER_DESIGN.md` - recording what `locate` could not answer.

## perception/ - what the world reads return
- `RESEARCH_WORLD_REPRESENTATION.md` - the survey the representation was judged against.
- `REPRESENTATION_DESIGN.md` - the representation upgrades, executed.
- `PATTERN_SEARCH_DESIGN.md`, `SURFACE_MERGE_DESIGN.md`, `LOCATE_ROUTES.md` - `locate`: the relational rung, the merged door, the route audit.

## play/ - an agent with a body (experimental profiles `play`, `survey`, `survival`)
- `BOT_SURFACE_DESIGN.md` - goal loop, build-aware pathfinding, engage as a mode: the `bot_*` surface.
- `PLAYER_CONTROL_DESIGN.md` - reflexes, combat, equipment, consumables.
- `COMBAT_KIT_PLAN.md` - the whole arsenal; steps 1-5 built.
- `SURVIVAL_MODE_PLAN.md`, `SURVIVAL_SENSES_DESIGN.md`, `SURVIVAL_SMALL_MODEL_PLAN.md`, `SURVIVAL_CHARTER.md` - the player-legal profile and its prompt. The charter the software used to ship is in `mcmodding-archive` since 0.143.0: it was kit payload, and the kits went with the launcher.
- `CHECK_PATH_AUDIT.md` - legality of `check_path` under survival.

## bench/ - measurement and the papers
- `PAPER_BENCH.md` (paper A, the instrument), `PAPER_TOOLKIT.md` (paper B, the design), `FREEZE_PLAN.md` - the papers and the road to v1.0.0.
- `DISCIPLINE_INDEX.md`, `CATEGORY_C_DESIGN.md`, `CATEGORY_P_DESIGN.md`, `DIFFICULTY_CEILING.md`, `BENCH_EXPANSION.md`, `BENCH_EXTERNALIZATION.md` - the bench's shape. The runner is `../../mcp-server/testbench/`.
- `ABLATION_DESIGN.md`, `ABLATION_RESULTS.md` - does memory earn its complexity (the 2026-07-19 grid).
- `TOOL_VALUE_LOO.md` - per-tool leave-one-out value.

## archive/ - superseded, kept because code and records cite the rationale
- `COMPANION_DESIGN.md` - the step-8 companion draft; superseded by `platform/COMPANION_REDESIGN.md`.
- `TODO_SHIPPED.md` - the shipped sections of `../TODO.md`, split out 2026-08-23; a record, not a plan. **In the workbench archive since release 1**, with `../TODO.md` and `../RELEASE_1.md`; a stub at each path explains where it went, because this tree cites their section numbers in 125 places.
- `TOKEN_EFFICIENCY_PLAN.md` - the completed 2026-07-20 token pass; live parts are in `../ARCHITECTURE.md`.
- `archive/README.md` says what replaced each, and lists the records that LEFT this repository on 2026-09-06 (handoffs, superseded and descoped designs, plan/status files, the play postmortems) and where they are.
