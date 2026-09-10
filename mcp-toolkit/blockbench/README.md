# Blockbench plugins

Three desktop-only plugins, each loaded once through File > Plugins > Load Plugin from File. Install
and usage: `../LIVE_MODDING.md`, Blockbench link.

**This directory is their site of record, not the only place a consumer finds them.** Since 0.141.0
the three `.js` files are bundled in the mod jar under `blockbench-dist/` and written out beside the
extracted shim — `<gameDir>/mcptoolkit/blockbench/` on every dev boot, `<repo>/.mcptoolkit/blockbench/`
once by `gradlew toolkitInit`. Before that they existed only in this working tree, so a consumer who
resolved the jar from a Maven coordinate had no way to reach the whole Blockbench half (`../TODO.md`
1.10). The harnesses and `fixtures/` stay here: they are not plugins, and the glob that bundles
`*.js` does not match `*.test.mjs`.

- `mcptoolkit_bridge.js` - THE DOOR (0.133.0): a local HTTP bridge the toolkit's MCP shim uses as
  its Blockbench upstream, with session-bound projects, a queue, and an argument-checked 26-tool
  surface (geometry, textures, the painters, pictures, export, eval, animation). Replaces the
  third-party "Blockbench MCP" plugin. Needs one permission (`process`, for Node's `http`), asked
  for by Tools > MCP Toolkit Bridge > Start - never by a dialog the plugin opens itself. Design:
  `../docs/models/BLOCKBENCH_BRIDGE_DESIGN.md`. Tests: `mcptoolkit_bridge.test.mjs`.
- `mcptoolkit_sync.js` - push a project's textures, model and small text assets into the running
  game's live resource pack (`mcptoolkitPush({...})`, or File > Push to Game), or into a mod's
  `src/main/resources` (`target:'source'`, the promotion step). Reached through the bridge's
  `risky_eval`.
- `mcptoolkit_entity.js` - entity geometry and animation to the toolkit's preview entity
  (`mcptoolkitEntity({action:'push'})`, then `stage_entity`), and the geometry check battery a
  loop file runs after every edit. Design: `../docs/models/ENTITY_AUTHORING_DESIGN.md` section 6.
  Tests: `mcptoolkit_entity.test.mjs`.
- `fixtures/` - the `.bbmodel` files the tests and probes use (`fixtures/README.md`).

The shim finds the bridge by scanning up from `http://127.0.0.1:25801`, because each WINDOW's plugin
takes the first free port at or above that and the port is what names the window; a shim claims one
window and works there (`BLOCKBENCH_ISOLATION_DESIGN.md` sections 6.3 and 10). A window is YOURS
unless the plugin was asked to open it for an agent, so the one you are working in is never claimed
and you set no flag to keep it; an agent-born window closes itself when nothing holds it and nothing
is open in it, never the last one. Tools > MCP Toolkit Bridge > Let agents use this window hands
yours over anyway, by port, so a restart remembers it. `ping` names the window a session got. `MCPTK_BLOCKBENCH` overrides: `host:from-to` is a range
to scan, a bare URL pins one window, `off` disables the upstream. The shim serves its tools under the
`art`, `entity`, `standard` and `full` profiles
(`../../mcp-server/index.mjs`, BLOCKBENCH_PROFILES / BLOCKBENCH_KEEP). Do not register a Blockbench
server beside the toolkit in `.mcp.json`: two paths to one app pay two prefixes.
