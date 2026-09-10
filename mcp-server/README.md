# MCP Toolkit — MCP server

Lets any MCP client drive the running game through the **MCP Toolkit** bridge. The tool list is
not fixed here: it is whatever the toolkit and the loaded mods have registered (the toolkit itself,
plus anything a mod adds through `McpToolkitEntrypoint`). What the tools are for, and which
document to read for a given task, is `../mcp-toolkit/README.md`.

## How it fits together

```
Claude ──MCP (stdio)──▶ this Node server ──HTTP──▶ mcptoolkit mod bridge (BridgeServer.java) ──▶ game thread
```

This process speaks the MCP protocol and forwards mod tools verbatim: it fetches the tool manifest
from the bridge's `GET /tools` endpoint and forwards each call to `POST /cmd` as JSON. The mod runs
each tool on the loop it needs (server thread, client thread, or inline) and returns the result.

One tool group is **local to this process**: the `mem_*` agent-memory tools (`memory/`, design in
`../mcp-toolkit/docs/memory/MEMORY_DESIGN.md`). They are merged in front of the proxied manifest, store per-world
memory under `memory-data/`, use the bridge only to stamp game ticks and world identity, and keep
working (wall-clock only) when the game is down.

## Prerequisites

1. **Run the game with the bridge enabled.** It's on automatically in a dev environment (`runClient` /
   `runServer`) on port **25599**. In a normal client, enable it with a JVM arg:
   `-Dmcptoolkit.port=25599`. The bridge binds to `127.0.0.1` only.
2. The bridge starts **at game launch** — `ping` and client-side tools work at the title screen. Tools
   that touch the world (most Village Jobs tools) still need a world loaded and return a clean
   `no server running` error otherwise.
3. Node.js ≥ 18.

## Install

```
cd mcp-server
npm install
```

## Register with Claude Code

```
claude mcp add mcp-toolkit -- node <abs path to this checkout>/mcp-server/index.mjs
```

To point at a non-default port/host, set `MCPTK_URL` (base URL, no path):

```
claude mcp add mcp-toolkit -e MCPTK_URL=http://127.0.0.1:25599 -- node <abs path to this checkout>/mcp-server/index.mjs
```

The legacy `VJ_MCP_URL` (which pointed at the old `/cmd` endpoint) is still honored — its `/cmd` suffix
is stripped automatically.

`MCPTK_MEMORY_DIR` sets the root for the per-world `mem_*` memory stores. Unset, it defaults to
`memory-data/` inside this checkout — fine for dev; a play/production registration should pin its own
directory (see `../mcp-toolkit/LIVE_MODDING.md` § production attach).

`MCPTK_PROFILE` picks which slice of the manifest the session sees. The set is authored from roles,
and which group a name is in is the first thing to know (index.mjs carries the full table):

- **supported dev roles** — `modding` (**the default**: author blocks, data, structures and assets
  against a running game and read them back), `authoring` (the block half of it), `art` (models,
  spanning the Blockbench upstream), `screens` (the client's own widgets), `inspect` (read-only —
  every tool it serves is `mechanism:observe`, checked against the manifest, not promised),
  `rocketeer_authoring`.
- **bench configurations, not roles** — `full`, `standard`, `entity`. `standard` was the default
  until 0.107.0; its shape was chosen by a *navigation* bench, which is why it withholds the three
  block reads an authoring session needs. Bench arms pin `full` explicitly.
- **experimental research roles** — `play`, `survey`, `survival`. They ship and they work; they are
  not part of the supported developer surface, and each says so on stderr at start-up, in `ping`'s
  `profile` block and in `tool_surface`'s report.

A session can narrow or widen itself live with `tool_surface`; a name the current profile does not
serve refuses with `profile_hidden` and names the verb that widens. Rationale and per-profile bills
in `../mcp-toolkit/docs/platform/TOOL_BILL_PLAN.md` §4. `survival` is the player-legal surface (`../mcp-toolkit/docs/play/SURVIVAL_MODE_PLAN.md`): X-ray reads,
world edits and the dev bench hidden, `locate` answered from the session's own observations with
frontier hints on a miss, `bot_profile` locked to perceived. `MCPTK_OBS_AMBIENT=on` additionally arms
the ambient retina — a forward-cone `raycast_fan` auto-fires while the body is active and is captured
to observation memory without ever entering the model's context (`MCPTK_OBS_AMBIENT_MS` interval,
default 2000).

Two modes (full table in `../mcp-toolkit/LIVE_MODDING.md` §Two working modes): **dev** = this
checkout, bridge 25599, `launch_game` local tool available; **production** = the in-game Claude
button extracts a slim copy of this server (index.mjs + memory/ + local/, SDK dep only) into the
game dir and registers it against port 25600 — nothing needs this checkout there.

`ablation/` and `companion/` are **research archive** (step-7 ablation + step-8 soak harnesses):
kept for re-measures, never bundled into the production extract, and not used by the chat-companion
mode (which is a plain Claude Code session).

## Tools

The exact set is dynamic — **`GET /tools` on the bridge is the truth** (~71 tools, counted on a
live dev manifest 2026-08-26; client-context tools appear only when the game client is running, and
the MCP client's view refreshes on reconnect). By group:

| Group | Tools (abridged) |
|-------|------------------|
| World perception | `get_region_summary`, `scene_summary`, `get_blocks`, `get_entities`, `raycast`, `get_world_info`, `query_registry` — the last of which also answers about ONE entry (`entry`: its tags, block properties, item components, or the entry's own JSON as the game decoded it), lists a tag's members (`tag`) or a registry's tags (`tags`), and reaches the loaded RECIPES, which is how you check that a pushed recipe parsed |
| Spatial predicates (derived geometry — use these instead of coordinate arithmetic) | `check_fit`, `check_clearance`, `check_path` (walker\|flyer), `check_site` |
| Drone | `bot_spawn`/`bot_despawn`/`bot_select`/`bot_status`, `bot_goto`, `bot_look`, hands (`bot_mine`/`bot_place`/`bot_use`/`bot_attack`/`bot_inventory`/`bot_give`) |
| World edits (transactional) | `place_shape`, `set_blocks`, `place_blocks`, `undo_edit`, `list_edits` |
| Structures | `capture_structure` (a world box → a vanilla `.nbt` in the live datapack) and `place_structure` (back again, with rotation/mirror, a dry run, and an `undo_id`). Unlike `run_command "/place template"`, a template that is not loaded is a refusal rather than `ok:true`. Dev profiles only. |
| Events & game control | `get_events`, `run_command`, `get_chat` |
| The game's own log | `get_log` — what the game LOGGED AND SKIPPED (vanilla steps over a malformed recipe or model, so a reload can succeed with nothing loaded); ERROR/FATAL also arrive as `error` events. Dev profiles only. |
| Building pipeline (Village Jobs) | `list_buildings`, `import_building`, `edit_building`, `save_building`, `get_region` (`check_path` moved to the toolkit's spatial predicates 2026-07-22) |
| UI inspect / drive / design | `get_screen`, `screenshot`, `screenshot_annotated`, `click` (press / drag / scroll), `send_keys`, `set_text`, `open_screen`, `close_screen`, `get_screen_graph`, `measure_text`, `check_layout` |
| Live patching | `hotswap_class`, `push_asset`/`reload_resources`/`list_assets`/`clear_assets`, `push_data`/`reload_data`/`list_data`/`clear_data` (both pushes take `file` as well as `base64`; both reloads report `ok` + `problems`) — workflow in `../mcp-toolkit/LIVE_MODDING.md` |
| Agent memory (local to this process) | `mem_note`, `mem_recall`, `mem_recent`, `mem_write_block`, `mem_place`, `mem_task`, `mem_dismiss` — plus the `remembered` appendix world reads carry when memory disagrees with the live result (`MEMORY_REDESIGN.md` §2.2) |
| Misc | `ping`, `quit_game` |

## Adding a tool (from any mod)

Register onto the shared `McpTools` registry during your mod's init — no change to this Node server is
needed; it appears in `GET /tools` automatically:

```java
McpTools.register(ToolDef.of(
    "my_tool",
    "What it does.",
    Schemas.object("name", Schemas.str()),
    ExecutionContext.SERVER,           // or CLIENT / ANY
    (ctx, args) -> {
        JsonObject r = new JsonObject();
        // ... run on the server thread; ctx.serverOrThrow() gives the MinecraftServer ...
        return r;
    }));
```

For an image result, put `{mimeType, base64}` under a `_image` key and this server turns it into MCP
image content; use `ToolDef.async(...)` if the result can't be produced synchronously on the target
thread (e.g. a screenshot needing a later render frame).

## Notes / current limits

- Coordinates for `place_blocks` and `check_path` are **absolute** world positions. `get_region` returns
  the design origin plus block coordinates **relative** to it — add them to get absolute positions.
- Headless edits (import/edit via MCP) place the building at a fixed editor origin over spawn
  (`0, 128, 0` in the overworld), on a stone platform.
- Development/authoring tool only; the bridge is off by default outside a dev environment and never binds
  off `127.0.0.1`.


## The loop kit (0.56.0)

Three things a session gets with no manifest cost, and one file a project writes:

- **Image budget.** Every frame this server hands the model is cropped to its content, resized to
  a longest edge (`MCPTK_SHOT_MAX`, default 512, `0` keeps pictures whole) and priced on the reply
  (`picture 309x512 ~211 tok (was 3840x2131 ~1533 tok …); re-sent every turn after this one`).
  `screenshot` takes `max` and `crop` (`[x,y,w,h]` GUI px, or `{widget}`/`{id}` from
  `get_screen detail:"layout"`). A texture sheet (`get_texture`) is resized at most, never cropped:
  its pixels are the addresses the next paint call names. `image/budget.mjs`.
- **`.mcptoolkit/loop.json`** (or `MCPTK_LOOP=<file>`): post-call checks selected by the mechanism
  the manifest stamps (`observe`/`embodied`/`world_edit`/`privileged`, plus `blockbench_edit` for
  the upstream), each a command whose last stdout line is `{text, problems, notes, full}` or an
  `eval` run inside Blockbench; a `gate` of tools refused while problems stand unless
  `force:"<why>"`; and a `profile` (`base`, `keep`, `notes`, `instructions`) the session launches
  in as `project`. `loop/loop.mjs`; probes `probes/loop-hook.test.mjs`, `probes/loop-profile.test.mjs`.
- **Blockbench** through the toolkit's own plugin (`upstream/blockbench.mjs` <->
  `../mcp-toolkit/blockbench/mcptoolkit_bridge.js`, port 25801): session-bound projects, a queue,
  26 argument-checked tools including the batch painters `paint_faces` / `paint_ascii`, served under
  `art`, `entity`, `standard`, `full`.

The design and the numbers: `../mcp-toolkit/docs/loops/LOOP_KIT_DESIGN.md`; the how-to:
`../mcp-toolkit/docs/guides/LOOPS.md`.
