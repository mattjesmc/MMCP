# Blockbench bridge: the toolkit's own Blockbench plugin

**Status: designed and built 2026-09-07 (toolkit 0.133.0 / shim 0.64.0 / plugin `mcptoolkit_bridge.js`
0.1.0). Section 10 is the build record; section 11 what the live arm still owes.** Replaces the
third-party "Blockbench MCP" plugin (jasonjgardner, 1.6.1) as the shim's Blockbench upstream. The
two existing plugins (`mcptoolkit_sync.js`, `mcptoolkit_entity.js`) are still reached through
`risky_eval`; they were unchanged until 0.140.0, which gave them the B0 treatment they had missed -
an explicit `bridge` and a project object, no hardcoded 25599, no name resolved without an ownership
check (section 9, `TODO.md` 1.9).

## 1. Why: what the third-party plugin cost, in the record

The project did not outgrow Blockbench. It outgrew the plugin standing between the shim and
Blockbench. The evidence, all of it already written down elsewhere:

- **It cannot be extended.** ArmorPieces wrote a 1050-line proxy for that reason
  (LOOP_KIT_DESIGN.md section 7). The shim's own painters were LOCAL tools composing a `risky_eval`
  string because there was nowhere else to put them (section 5.4 as built).
- **`risky_eval` was the whole pipeline.** Of the 94 tools, `art` kept 20; of those, the real work
  (whole-canvas painting, `mcptoolkitPush`, `mcptoolkitEntity`, both painters, every loop `eval`
  check) went through the one eval tool. The other 93 were a transport we paid 18.2k tokens a turn
  for until the adapter cut it (TOOL_BILL_PLAN.md section 7).
- **The eval refused code containing `//`, `/*` or `console.`**, and a rejected Promise inside it
  wedged its HTTP server until Blockbench restarted. Four different files carry workarounds for the
  first (`loop.mjs` refuses such an `eval` at load; `__previous` is serialised with `/` escaped;
  every painter comment lives outside the template; base64 goes URL-safe).
- **Every tool acted on the ACTIVE TAB.** Parallel painters needed a lock directory
  (blockbench-mcp-setup memory), the loop kit runs one headless session per part sequentially
  because "Blockbench's active tab races" (LOOP_KIT_DESIGN.md section 11), and an agent's texture
  regularly landed in a human's tab.
- **The first filesystem write popped a modal** that made every request time out until a human
  clicked, which read exactly like a dead server.

## 2. What stays with Blockbench, and the rule

Blockbench remains the editor, the viewport and the arbiter. The plugin never interprets geometry
into meshes and never reimplements a codec: `Codecs.project.compile`, `modded_entity`,
`java_block`, the Undo system, the texture canvas and the preview renderer are Blockbench's, and
the plugin calls them (menagerie ROADMAP section 45.2 rule 4, imported by ENTITY_AUTHORING_DESIGN.md
section 1: one mesh implementation, ever). What the plugin owns is the DOOR: transport, sessions,
the tool surface, argument checking, readbacks and the reply envelope.

## 3. Transport: bridge-shaped, not MCP

The plugin hosts plain HTTP on `127.0.0.1`, at the first free port at or above 25801 (section 15: the
port a window wins is that window's name), and speaks the shape the GAME BRIDGE already speaks, so the
shim's adapter is a copy of something it has, not a second protocol:

| Route | Answer |
|---|---|
| `GET /hello` | `{app, version, plugin, plugin_version, projects, sessions}` plus the window block: `{window, port, base_port, span, reserved, claimed_by}` |
| `GET /tools` | `[{name, description, inputSchema, mechanism}]` - stamped, like the bridge's manifest |
| `POST /cmd` `{tool, args, session:{id, client, profile}}` | `{ok:true, result, mechanism}` or `{ok:false, error}` |
| `POST /claim` `{session, release?}` | `{ok:true, claimed, rejoined}` or `{ok:false, error}` - one session owns a window (section 15) |
| `POST /window` `{session}` | `{ok:true, opened, autostart}` or `{ok:false, error}` - only the plugin can make a window |

No MCP session ids, no SSE, no initialize handshake; a Blockbench restart is a server that went
away and came back, which the shim's tool-list watcher already handles for the game bridge. A
result carrying `_image {mimeType, base64, frame}` becomes an image content block in the shim, as
bridge results already do; `frame:true` is the picture saying "crop me to my content" (a viewport)
and its absence says "I am an address space" (a texture sheet) - the decision the shim used to keep
in a hand list (`CONTENT_CROP`) now travels with the picture.

**How a plugin gets `http` at all.** Blockbench 5's plugin sandbox (`getModule` in app.asar) allows
`path`/`crypto`/`buffer`/... freely and gates `fs`, `process`, `net`, `child_process`, ... behind a
one-time permission dialog ("Always allow for this plugin" persists to `plugin_permissions.json`).
`http` is on neither list. Blockbench 5.1.6 runs Node 24 (Electron 40), and a plugin holding the
`process` grant gets the real module through `process.getBuiltinModule('http')`. So the plugin
needs ONE grant, `process`, asked for once by a human click. File reads and writes go through
Blockbench's own `Blockbench.read` / `Blockbench.writeFile`, which are app code and need no plugin
grant - so `fs` is never requested. **The plugin never asks with a modal by itself**: `onload` asks
with `show_permission_dialog:false`, and when the grant is absent it idles and puts the ask in the
menu (Tools > MCP Toolkit Bridge > Start), because the synchronous dialog blocks the whole renderer
and every other session using Blockbench with it.

The port is a plugin setting (Tools > MCP Toolkit Bridge > Settings, stored in localStorage) and
since plugin 0.5.0 it is the BASE of a scan, sixteen wide, because the port is what names a window.
The shim reads `MCPTK_BLOCKBENCH` in three forms: unset is the default range, `host:from-to` is a
range to discover over, a bare URL PINS one window exactly, and `off` disables the upstream. The port
still flows from the end that cannot move: Blockbench is a desktop app with a stored setting, the shim
is a process started per session.

## 4. Sessions and projects: the thing the old plugin could not do

Blockbench has one `Project` global, one renderer and one active texture; no plugin makes two
sessions edit concurrently. What a plugin CAN do is take the race out of the agents' hands:

- **Every call is queued.** One promise chain; a call runs alone, and the tab it needs is selected
  before it runs (`ModelProject.select()`), never switched back afterwards (the next call switches
  if it must). Reads and edits alike.
- **Every call may name its `project`** (name or uuid). A session that made or opened a project is
  BOUND to it (`project op:new/open/select`); a call without `project` goes to the bound project,
  and only a session with no binding acts on whatever tab is active - and its reply says
  `project.bound:false` with the sentence that fixes it. Binding is explicit or by creation, never
  by "the tab that happened to be open when I first called".
- **A bound project is HELD.** An EDIT to a project bound to another LIVE session is refused with
  `held_by` (session, client, and how it is known to be alive: `connected`, or seen N seconds ago)
  and the two ways out: work in your own project, or `project op:select {project, take:true}`.
  Reads are never refused. The lock-directory ritual of 2026-08-14 becomes a refusal with the fix
  in it.
- **A session lives exactly as long as its connection** (plugin 0.2.0 / shim 0.65.0, 2026-09-07).
  The shim opens one `GET /presence` per process and holds it for its life: a never-ending
  response, a newline every 30 s, the socket unref'd so it never keeps a shim alive past its
  stdio, reopened after a `/tools` poll whenever none is open. The plugin ties the session to that
  socket; when the socket closes, the binding and the session record go with it, at once. The
  two-minute hold timer remains for a client that never opens one (curl by hand). Before this the
  binding expired on the timer alone, and ArmorPieces' measurement (section 12) found the cost: a
  `claude -p` child that had EXITED held its piece "seen 15s ago" and refused the human's cleanup
  call. `project op:list` shows every holder with `connected` and every session's `connections`.
- **One id on two connections is said, on every reply.** Two processes presenting one session id
  (an inherited `MCPTK_SESSION`) are one session with one binding, and every unqualified call of
  either lands in it. The plugin cannot tell them apart; it can say so: `session {id, connections,
  note}` rides every reply while the condition holds, and the note names the one thing a caller can
  do - name `project` on every call. The shim writes the same sentence to stderr off the presence
  first line. Every reply rather than the first, because each of the processes must see it.
- **`risky_eval` binds `PROJECT`.** The resolved project is a local in the code's scope, in all
  three shapes (a parameter of the function shapes, a `const` in the script shape's own lexical
  environment). A plugin API reached through eval reads Blockbench's global `Project`; the tab is
  selected before the code runs so the two agree at the start, but only a local lets the code
  ASSERT which project it writes (`api.save(PROJECT)`), and a wrong resolution then fails instead
  of writing silently.
- **Undo is per project already** (`ModelProject.undo`); nothing to add.

What this does NOT give: parallelism inside one Blockbench. Two sessions painting two projects
still take turns, and a slow `capture_screenshot` in one is a wait in the other. The escape is a
second Blockbench process (section 9, open) or authoring against the FILE with Blockbench only for
looking (the ops-JSON texture path already renders byte-identically with PIL and in Blockbench).

## 5. The surface

26 tools, every one stamped `observe` or `blockbench_edit` in the manifest, every one accepting
`project`, every edit ONE undo entry named after the tool and answering with a READBACK (what the
model would otherwise spend a turn reading). Families are one tool with `op` (the `ui_doc` lesson:
~900 tokens for one entry against ~4.7k for six).

| Tool | Mechanism | What it does | Was (1.6.1) |
|---|---|---|---|
| `get_project_info` | observe | orientation: format, sizes, counts, textures, bounds, binding | same name |
| `project` | mixed, reply-stamped | `list` / `info` / `new` / `open` / `save` / `close` / `select` / `set` | `create_project` + nothing (open/save/close/select did not exist) |
| `list_outline` | observe | the tree; `detail:"boxes"` adds from/to, `"faces"` adds face rects; `group` scopes; duplicate names reported | same, thinner |
| `find_elements_by_criteria` | observe | regex / substring / type / parent / size filter | same name |
| `get_selection` | observe | selected elements and texture | same |
| `inspect` | observe | `bounds` / `faces` / `envelope` (neighbours on the same bone, gaps per axis) / `overlaps` (AABB pairs) / `uv` (face rects that collide or leave the sheet) | did not exist (ArmorPieces' envelope table; the entity plugin's check is still the full battery) |
| `place_cube` | edit | a BATCH of cubes into a group with a texture and a UV mode; replies with each cube's face rects and its envelope | same, richer reply |
| `modify_cube` | edit | one or many (`ids`), partial fields, readback | same |
| `add_group` | edit | a bone with pivot and rotation under a parent; optional `children` moved in | same |
| `element` | edit | `remove` / `rename` / `duplicate` / `reparent` / `set` / `select` / `show` / `hide`, one or many | `remove_element`, `rename_element`, `duplicate_element` |
| `create_texture` | edit | with a size that APPLIES (1.6.1 always made 16x16), a fill or a PNG path, and `assign` | same name |
| `apply_texture` | edit | to elements or a group, all faces or named ones | same |
| `list_textures` | observe | name, size, opaque pixel count, how many cubes use it | same |
| `get_texture` | observe | the sheet as an IMAGE (not cropped) plus size and opaque count; `region` | same |
| `texture` | edit | `read` (a region or a face as ASCII rows through an auto palette - the reading half of `paint_ascii`) / `rects` (the ops-JSON: fill and clear rectangles) / `resize` / `recolor` / `flip` / `load` / `write` / `rename` / `remove` | brushes, fills, gradients (many round trips each) |
| `paint_faces` | edit | as before, now native | shim-local |
| `paint_ascii` | edit | as before, now native | shim-local |
| `capture_screenshot` | observe | the viewport; `angle` (a preset or position/target), `fit` frames the model, `views` composes several presets into ONE contact sheet | same name; `set_camera_angle` + N captures |
| `set_camera_angle` | observe | a preset or position/target/projection; `fit` | same |
| `export_model` | observe | a codec's output, returned or written to `path` | same |
| `undo` / `redo` | edit | N steps, readback of the stack | same |
| `get_undo_stack` | observe | the last entries | same |
| `risky_eval` | edit | JavaScript in Blockbench; comments and `console.` allowed; a Promise is awaited and a rejection is an error reply, never a wedge | same name, no filter |
| `trigger_action` | edit | a BarItems action by id | same |
| `animation` | edit | `list` / `create` / `remove` / `select` / `keyframes` / `time` | `create_animation`, `manage_keyframes`, ... |

Deliberately absent, as in the `art` keep-list: armatures, vertex weights, PBR materials, mesh
tools, brushes, `emulate_clicks`, `fill_dialog`. Minecraft Java's cuboid models cannot express the
first three; the rest are round trips a batch tool replaces.

**Migration for a loop file keep-list** (ArmorPieces' is the only real one):
`remove_element`/`rename_element`/`duplicate_element` -> `element`; `paint_with_brush`,
`paint_fill_tool`, `draw_shape_tool`, `gradient_tool`, `eraser_tool`, `color_picker_tool`,
`texture_selection`, `paint_settings`, `activate_texture` -> `texture` (and the two painters);
`save_checkpoint` -> `project op:save`. Every other kept name survives. A kept name the manifest
lacks is already a stderr warning at start-up.

## 6. Disciplines carried over from the toolkit

- **ArgCheck.** Every schema is `additionalProperties:false`; an undeclared argument, a wrong type
  or a value outside an enum is refused BY NAME with the declared list, before anything runs.
- **Mechanism on the manifest AND on the reply.** The loop hook selects on the manifest's stamp;
  a mixed tool (`project`) stamps each REPLY with what that op was, and the shim prefers the reply's
  stamp when it carries one. `BLOCKBENCH_READ_ONLY`, the hand-kept list, is gone.
- **Never reject.** Every handler's throw becomes `{ok:false, error}`; the HTTP server never sees
  an unhandled rejection.
- **Put the numbers in the reply.** `place_cube` answers with face rectangles and the envelope of
  neighbours; `modify_cube` with the resized rectangles; `create_texture` with the size that was
  actually made; `texture op:read` with a legend.
- **Price by arity.** Batches everywhere a loop calls a tool per unit.
- **A picture that is an address space is never cropped** (LOOP_KIT_DESIGN.md section 11 finding
  3c) - `_image.frame` carries that per picture.
- **`look:true`** on every edit returns the viewport on the same reply (a turn saved per look).

## 7. Loop kit coupling

Nothing a loop file says changes: `after.mechanism: ["blockbench_edit"]` selects the same tools
(now from the manifest stamp), `tools: ["risky_eval"]` still names the eval, `eval` checks still
run through `risky_eval` and their value is still the report. Two things get simpler: the shim no
longer refuses an `eval` containing `//` (the filter that forced it is gone), and the painters are
manifest entries like any other, so the "a local tool carries the mechanism of the upstream it
edits" rule has no local Blockbench tool left to apply to.

## 8. Install

1. Blockbench: File > Plugins > Load Plugin from File > `mcp-toolkit/blockbench/mcptoolkit_bridge.js`.
2. Tools > MCP Toolkit Bridge > Start; allow `process` ("Always allow for this plugin"). Once.
3. The shim finds it at `http://127.0.0.1:25801` with nothing configured. `claude mcp remove
   blockbench` if a peer registration of the old plugin is still in `~/.claude.json`; the old plugin
   may stay loaded (it binds port 3000, this binds 25801) until nothing needs it.

## 9. Open

- ~~**Two Blockbench processes.**~~ Answered and enlarged by `BLOCKBENCH_ISOLATION_DESIGN.md`
  (2026-09-07). A second *window* already gives a fresh JS realm with its own scene and its own
  copy of every editor global, which is the isolation a second process was wanted for; a second
  *process* needs `--userData` (the flag this build parses; the single-instance lock otherwise
  redirects the launch into window #1) and is only needed for the shared-persistence hazards.
  The blocker either way is ours: the port is fixed and read from storage every window shares, so
  a second window's bridge fails to listen and says so only in `status()`.
- ~~**`animation op:keyframes`** has no live subject yet~~ Live on the fixture rig 2026-09-07 (section
  10, last row): the target animation must be SELECTED first, since Blockbench's `createKeyframe`
  ends with `Animation.selected.setLength()`.
- ~~**A call before the client's first `tools/list`.**~~ **FIXED 0.140.0.** The shim learns the
  plugin's names when it BUILDS the manifest; a `tools/call` naming one before that fell past the
  Blockbench branch, was forwarded to the GAME bridge, and was refused there as "unknown tool" - a
  sentence about the wrong process entirely. It was recorded and not fixed because fetching the
  manifest on an unknown name reads as a guess at the caller; the answer is that the trigger is
  narrower than "unknown". The shim lists lazily only while it has NO Blockbench manifest at all
  (`hasBlockbenchManifest()`), which is the one state in which an unknown name has no list to be a
  typo against; once the watcher has answered once - within `WATCH_DOWN_MS` of the session's start -
  nothing here fires again, and a name that is really unknown goes to the game exactly as before.
  One fetch in flight, no oftener than the watcher's own cadence, and Blockbench being shut costs a
  refused connection. `blockbench-surface.test.mjs` claim 6 is the falsifier: a call with no
  `tools/list` before it reaches Blockbench, never the game bridge, and the second call needs no
  second list.
- The entity plugin's `check` battery stays the loop-file `eval`; `inspect` is the cheap generic
  slice (AABB, unrotated) and says which cubes it did not check.
- **The two older plugins are unmigrated in two ways, and both are release-blocking** (`TODO.md`
  1.9, `BLOCKBENCH_ISOLATION_DESIGN.md` section 6.5). They hardcode `http://127.0.0.1:25599/cmd`
  (`mcptoolkit_sync.js:42`, `mcptoolkit_entity.js:97`) with no override in either settings store, so
  since B0 gave every project its own port they aim at the toolkit's own dev game from any consumer
  repo - refused, or worse, accepted. And they resolve a project by NAME and select it, so they are
  the one route into a project that never passes the `held_by` check. The fix for both is to inject:
  `GAME` beside `PROJECT` in `risky_eval`, the game URL riding the shim's `POST /claim`, and an
  explicit `bridge` + project object taken by each plugin, with no hardcoded fallback surviving.
  **SHIPPED 0.140.0** (plugin 0.6.0 / sync 0.4.0 / entity 0.3.0 / shim 0.68.0), with one deviation
  worth naming: the URL rides the shim's SESSION BLOCK, which the claim carries and so does every
  `/cmd`. That is a superset of "riding the claim" and it is why - a claim that 404s against a
  plugin from before step 2, one refused because another session holds the window, or a shared
  window where no claim happens at all must still deliver the URL. `session()` keeps it on the
  record beside the binding; a session nobody told gets `null`, and a plugin handed null refuses.
- **The shipped loop example still names this plugin's predecessor** (`TODO.md` 1.8):
  `tools/loop/examples/armorpieces.loop.json` keeps thirteen names from the migration table in
  section 5 above and misses ten that exist, `project` among them. The pin that keeps
  `BLOCKBENCH_KEEP` honest (`blockbench-surface.test.mjs`) does not reach `tools/loop/examples/`,
  which is how the example rotted through the migration unnoticed. **CLOSED 0.140.0**: that file
  left the repository for a generic `block-model.loop.json`, and `probes/loop-examples.test.mjs`
  now resolves every shipped example's keep-list, gates and `run` scripts against the live
  manifest - the reach the surface pin never had.

## 10. As built (2026-09-07, toolkit 0.133.0 / shim 0.64.0 / plugin 0.1.1)

Every section above exists as designed; the deviations and the numbers:

| Piece | Built as | Deviation, or what building it found |
|---|---|---|
| Plugin | `blockbench/mcptoolkit_bridge.js` (~1,000 lines): settings in localStorage (port, autostart, `hold_ms`), sessions, a promise-chain queue, `checkArgs`, 26 tools, the http server, four menu actions. `globalThis.mcptoolkitBridge = {start, stop, status, manifest, call, settings, sessions}` so the harness and an eval can drive the tool layer without the transport. | `onload` asks for `process` with `show_permission_dialog:false` and idles when refused; Start prompts. Files go through `Blockbench.read`/`writeFile`; `fs` is never requested. |
| Transport | `GET /hello`, `GET /tools`, `POST /cmd`, `X-MCPTK-Session/Client/Profile` headers touch the session registry on every request (the shim's 15 s poll is the heartbeat). | As designed. 0.2.0 adds `GET /presence` (section 4): the heartbeat is now a held socket, the poll only a touch. |
| Sessions | bound on `new`/`open`/`select`; unbound acts on the active tab and says so once; edits on a held project refused with `held_by` + the fix; `take:true`; reads never refused; a hold expires with the session (`hold_ms`). | As designed at 0.1.1. 0.2.0: a hold expires with the CONNECTION; `hold_ms` only for a client without one; a shared id is stamped on every reply. Section 12 is why. |
| Surface | 26 tools; every schema `additionalProperties:false`; every edit one undo entry with a readback; `look:true` on any tool. | `get_project_info` kept beside `project op:info` (a keep-list compatibility name, ~0 cost when not kept). `animation op:keyframes` is built from the asar's `createKeyframe` and has NO live subject. |
| Face rectangles | `uvSize(tex)`: the texture's own UV size when the format has `per_texture_uv_size`, else the project's. | **Found live**: ArmorPieces' format keeps per-texture UV sizes; scaling a 64x64 skin by the 64x32 project doubled every v and reported 42 faces "outside". The old shim painters had the same arithmetic and never met a sheet whose UV size differed from the project's. |
| Shim | `upstream/blockbench.mjs` rewritten (bridge shape, `SESSION_ID`, `setBlockbenchProfile`); `index.mjs`: `BLOCKBENCH_KEEP` renamed, painters removed, `BLOCKBENCH_PICTURES` take `max`, `finishReply` takes the reply's `mechanism` and the picture's `frame`; `local/paint.mjs` deleted; `loop.mjs` no longer refuses an eval with a comment. | `CONTENT_CROP` names only game tools now; a Blockbench picture decides for itself. |
| Harness | `blockbench/mcptoolkit_bridge.test.mjs`: a Blockbench-shaped stub world (projects that swap globals on `select()`, a canvas over a `Uint8ClampedArray` that encodes real PNGs, an `Image` that decodes them), **212 checks** at 0.140.0, the real `http` module on an ephemeral port; pins `probes/fixtures/blockbench-bridge-2026-09-07.json`. | The vm must NOT be handed the host's `Function`: `risky_eval`'s `new Function` then closes over the wrong globals (two false reds on the first run). |
| Probes | `blockbench-surface.test.mjs` rewritten (3 tests); `loop-harness.mjs` stub is bridge-shaped; `loop-hook`, `loop-profile`, `image-budget` moved to the new fixture; the "comment refused at load" test became "the comment reaches the eval and the value is the report". | Measured over the stubs: standard 122 tools / ~46.1k tok of which Blockbench 26 / ~5.9k; `art` 41 / ~10.4k of which Blockbench 25 / ~5.8k. The old upstream was 94 / ~18.2k, cut to 20 / ~6.0k. |
| Live, read-only | The plugin loaded into the running Blockbench 5.1.6 (13 ArmorPieces tabs, two other sessions live) through `new Plugin(id).loadFromFile({path}, false)` from the old plugin's eval - no dialog - and every read tool exercised on the active tab through `mcptoolkitBridge.call`: `get_project_info`, `list_outline`, `inspect` x5, `list_textures` (opaque counts), `texture op:read` (a head face as 8 rows with a 7-entry legend), `get_texture`, `capture_screenshot` (1020x946) and a 4-view contact sheet (512x540, camera restored), `export_model list`, `get_undo_stack` (the real history), `risky_eval`, `project op:list` (13 projects), `get_selection`, a refused id with its hint, an undeclared argument refused by name. | No edit and no tab switch was made on the human's open work; section 11 owes those. |
| Live arm (plugin 0.1.1) | Section 11's list, run the same day from a second session once the click had been made: two fresh `art` shims (0.64.0, spawned by the probes' harness against the real game bridge and the real Blockbench) plus one that never listed, 56 steps: scratch project, `add_group`, `place_cube` x2 with readback, `modify_cube`, `inspect` x4, both painters, `texture` read/rects/resize, contact sheet, `undo`/`redo` past both ends, `element` duplicate/remove, `export_model`, `project op:save`, the unbound note, `held_by` both ways and `take:true` back, four eval shapes, `mcptoolkitEntity({action:'status'})`, the rig's keyframes and their undo, `op:close` of everything made. The plugin reloaded itself from disk through its own `risky_eval` (no dialog: the persisted grant, which is also autostart's proof). | **Seven faults the 116-check harness was green on**, all fixed and re-run: (1) undoing `place_cube` DETACHED its cubes to root - Blockbench snapshots aspect arrays at `finishEdit`, so `undoEdit` now hands the aspects to the edit and created cubes/textures/animations/keyframes are pushed in (`animation` had no entry at all); (2) `keyframes` null-dereferenced `Animation.selected`; (3) a north capture showed ONE cube of two - Blockbench displays `java_block` with the scene at (-8, 0, -8) and entities where their bones put them; `fit` frames the meshes' world bounds (`THREE.Box3.setFromObject(Project.model_3d)`), the ortho zoom comes from the camera's own `right`/`top` (it was 2.3x too tight), a locked preset's zoom is applied, `scene_offset` is reported; (4) a multi-statement eval without `return` answered null - the completion value is back via indirect eval, with an `AsyncFunction` for `return`/`await` bodies; (5) `undo` on an empty stack said `undone:1` - it reports what moved and `asked`; (6) `duplicate` ignored `name`, and Blockbench's own rename bumps a trailing digit into a collision - `name` honoured, a shared name is a `note`; (7) a string `session` on POST /cmd read as anonymous. Plus: a transparent `create_texture` warns, a missing group names `add_group`. Lesson, again: a stub cannot fail the way the app fails; the harness now records aspect sizes per entry, the rest is live-only. |

## 11. Owed (the live arm behind one click)

**DONE 2026-09-07** except the last two bullets: the grant was made, and section 10's last row is
the run (56 steps, seven live-only faults, fixed the same day). Still owed:

- ~~The `process` grant; the scratch-project sequence; two sessions; `mcptoolkitEntity`; keyframes
  on the fixture rig~~ - run. Not run: the loop kit's `eval` check on a real edit (it is the shim's
  hook over the same `risky_eval`, covered by `loop-hook.test.mjs` over the bridge-shaped stub).
- **ArmorPieces**: its extracted shim (`run/mcptoolkit/mcp-server`) still speaks the old MCP
  handshake to port 3000, and its `.mcp.json` still registers `blockbench` as a peer through
  `tools/mcp/server.mjs`. Moving it = toolkit 0.133.0 in mavenLocal, the version bump in its
  `build.gradle` (the comment there says the two move together), a boot to re-extract, and the peer
  registration out. Until then the old plugin stays loaded on port 3000; both coexist.
- Two Blockbench processes with `--user-data-dir` (section 9).
- The 0.2.0 plugin loaded into the running Blockbench (the running one is 0.1.1; a piece was in
  flight when 0.2.0 was written, and a reload mid-piece would have dropped its binding). Reload =
  `mcptoolkitBridge` gone, `new Plugin(id).loadFromFile({path}, false)` from an eval, as section 10.

## 12. Measured by a consumer (ArmorPieces, 2026-09-07)

ArmorPieces archived every headless part session it had run (69 transcripts) and classified each
by the tool names it called, so the two plugins could be compared like for like: pack pieces, the
same brief shape, Sonnet 5, one session per piece. Their record is
`docs/measurements/blockbench-plugins.md` in that repository; the table that matters:

| | min | turns | bridge calls | out | cache read | $/piece |
|---|---|---|---|---|---|---|
| old plugin, alone (n=5) | 8.9 | 70 | 28 | 82k | 4.3M | $5.14 |
| this plugin, alone (n=2) | 5.2 | 60 | 31 | 95k | 3.4M | **$2.19** |
| this plugin, contended (n=2) | 14.3 | 123 | 59 | 159k | 13.7M | $5.15 |

57% cheaper and 42% faster with Blockbench to itself; contention erased all of it. The contention
was not the plugin's: their `.mcp.json` derived `MCPTK_SESSION` from `CLAUDE_CODE_SESSION_ID`,
which every `claude -p` child inherits, so four parallel children were one session with one
binding and the plugin sent every unqualified call to it, as designed. The tool mix shows the
damage in one row - `risky_eval` per piece: 0.0 in the clean runs of BOTH eras, 11.5 contended,
with their own painter dropping to 0.0. The escape hatch is reached for exactly when the tools stop
being trustworthy, which makes the eval count a health metric worth keeping.

Their six asks, and what became of each (toolkit 0.135.0):

1. `PROJECT` in `risky_eval`'s scope - built (section 4).
2. A binding dies with its connection, not on a timer - built (`GET /presence`, section 4).
3. One id from two connections is said - built (`session.note` on every reply, plus stderr).
4. `inspect` was called zero times in either era - its description now says the one case it beats
   the edit reply (after a rework, for the cubes you did not just touch); still kept in `art`.
5. Phase-narrowed keep-lists (modelling, then painting) - NOT built; TODO.md 1.7 has the design
   and the arithmetic, which says measure the saving against the re-read a switch costs first.
6. `capture_screenshot {views}` promoted to the recommended look; their rising check count is
   theirs to read; ArgCheck's refusal by name kept as is.

Their own two fixes, both worth copying by any consumer: the session id comes from a variable the
launcher sets per child and nothing inherits, and their eval helper names its project on every
call and refuses a reply about a different piece - which holds even where two sessions do share an
id.

## 13. Plugin 0.3.0 (2026-09-08, toolkit 0.137.0): three replies made true

Three places where a reply described work the plugin had not done. Grouped here because the failure
mode is one thing, and it is the expensive one: section 12's measurement established that an agent
reaches for `risky_eval` exactly when the tools stop being trustworthy, so a reply that lies costs
more than a tool that refuses.

- **`project op:new {bind:false}`.** `op:new` bound unconditionally - right for a piece, wrong for a
  scratch. A consumer that makes a throwaway from an error path came out bound to a project it meant
  to discard, and every unqualified call then resolved there BY BINDING, which outlives the scratch
  stopping being the active tab. `bind:false` creates and makes active without binding; the reply
  names the project the session kept, or says that the fallback now resolves to the throwaway on the
  active tab. `BLOCKBENCH_ISOLATION_DESIGN.md` section 7 has the measurement that found it.
- **`element op:select` with several names.** `n.select()` with no event is
  `unselectAllElements([this])` and then mark, so a loop kept only the last name while the reply
  claimed all of them. It now clears once and uses the app's add-to-the-selection path per node
  (`multiSelect` for a group, `markAsSelected` for an element), then `updateSelection()`.
- **`texture op:remove` was two undo entries.** `Texture.remove(no_update)` wraps itself in an undo
  entry unless told not to; the bare call nested a second one inside ours. `t.remove(true)`, with
  the refresh it skips covered by `Canvas.updateAll()` (no `element_aspects` = every face and UV
  rebuilt) plus an explicit clear of the UV panel's own reference to the removed texture.

**Both of the last two survived 143 green checks**, because the harness stubs were kinder than
Blockbench: the stub `select()` pushed onto the selection without clearing, and the stub
`Texture.remove()` did no undo bookkeeping. They were found by reading the vendored 5.1.6 source.
The fix went into the stubs first - make them behave like the app, watch the old implementations go
red, then fix the plugin - which is the only order that leaves a falsifier behind. A stub that is
easier than the thing it stands for does not test the thing it stands for.

## 14. Plugin 0.4.0 (2026-09-08, toolkit 0.138.0): what a second window breaks

Two fixes that only matter once a second session exists - built ahead of step 2 rather than inside
it, because each bites the moment step 2 succeeds. `BLOCKBENCH_ISOLATION_DESIGN.md` sections 6.3 and
8 carry the measurements behind both.

- **The active-tab fallback no longer answers with a project another live session holds.** A session
  with no binding has nothing to resolve and falls through to the active tab; in the A/B's contended
  arm one asked about its own project and got 23 cubes and the bones of another session's piece.
  `resolveProject` refuses at that one point with the same `held_by` block a held edit returns, and a
  hint with all three ways out (make your own, list the tabs, name theirs deliberately). A NAMED
  project is still read freely - section 4's "reads are never refused" is about a caller who says
  which project they mean, and the fallback is a guess, not a request.
- **Closing a window no longer wipes every window's crash recovery.** Ten lines at `onload`: a
  quitting flag from `window.onbeforeunload`, and a `removeAllBackups` that drops only
  `ModelProject.all`'s uuids while it is set; the original still runs off the quit path, so the start
  screen's Discard button keeps working, and `onunload` restores both. The hook choice is forced by
  the app: `closeBlockbenchWindow` is module-scoped and unpatchable, `before_closing` fires after the
  wipe, and `window.AutoBackup` is the very object every internal caller holds.

Harness 160 checks; reverting either fix turns it red.

## 15. Plugin 0.5.0 (2026-09-08, toolkit 0.139.0 / shim 0.67.0): a window each

Step 2 of `BLOCKBENCH_ISOLATION_DESIGN.md`, whose sections 6.3 and 9 are the design and the
measurement that decided it. Here is only what the two files now do.

**The port is the window's name.** `start()` walks up from the base port and listens on the first free
one, and `boundPort` - not the setting - is what `/hello`, the status box and the URL report. That
also fixes a plain bug: a second window used to load a second copy of the plugin, fail its listen with
EADDRINUSE into a field nobody reads, and serve nothing at all. `WINDOW_ID` is minted per plugin load
and is the other half of the name: it changes when the plugin restarts, which is how a shim tells "my
window came back" from "somebody else answers on my port now".

**`POST /claim`, and what a claim is not.** One session holds a window at a time; the claim dies with
the session exactly as a project binding does, because it is keyed on the same session record and the
same presence socket. It is NOT enforced on `/cmd`: the claim steers DISCOVERY, so that two shims land
in two windows instead of racing for one active tab. What refuses a call is still `held_by`, per
project, unchanged - the point of a window each is to stop needing it.

**`POST /window`, and why it has to be here.** A shim cannot make itself a window: relaunching the exe
with the same `--userData` forwards to the running instance and exits 0 (measured, isolation record
section 8). Only `BarItems.new_window.click()` makes one, so the route exists for a shim that finds no
free window, and it answers with `autostart` because a window that will not start its bridge is a
window the caller would scan for and never find.

**Reserve this window** (a menu action) keeps a window out of the pool: never claimed, never taken as
the shim's sharing fallback. In memory, not in settings, because settings are one store every window
reads at boot and writes back whole - a persisted flag would reserve them all. A reserved window still
answers a pinned shim and a human's curl; reserving stops discovery, not service.

**The shim's half** is `resolveWindow`: rejoin the window carrying this session's id, else claim the
first that is free, else ask for another and claim what appears, else share an unreserved one and say
so on stderr, else - only when every window is RESERVED - serve no Blockbench surface and say why. The
reconcile is what keeps that decision honest over a long session: while the presence connection is
open the window cannot have changed, so it costs nothing; when presence is down, one `/hello` decides
between a re-claim and a rescan.

Harness 192 checks and the shim probe 8 tests, with three falsifiers run: making the scan not walk
turns section 13 red, having the shim use a window without claiming it fails "two shims take a window
each", and letting the sharing fallback ignore a reservation fails "a window reserved for the person
at the keyboard is never taken". **What no stub reaches** is the second REALM: that `new_window` really
does load a second copy of this plugin which autostarts and wins the next port. The harness stands in
for only what a scanning shim SEES of it - another port answering /hello, unclaimed, under a different
name - and says so. That is the live arm, `TODO.md` 3.4.

**What a review added before the live arm** (CHANGELOG 0.139.0 has all nine). In the plugin: a
generation counter, because the listen is asynchronous and a `stop()` during the walk had nothing to
cancel - the pending callback landed afterwards and left a door open on a port that had just been
given up; and `reserved_port` in settings, so a reservation survives a restart. The stored form is a
PORT and not a flag for the reason section 5 gives - one shared store, read at boot and written back
whole, so a stored `reserved: true` would reserve every window at once, while a port number can only
be true of the window that won it. In the shim: one in-flight discovery (asking for a window takes
seconds, and a call arriving mid-ask would have asked for a second one), `app: "blockbench"` required
of anything answering in the range, the presence socket re-anchored when the window changes, and an
empty scan not repeated at the watcher's three-second cadence.

**And the consumer's half, which is not optional.** A session is two processes, and the second one -
ArmorPieces' `tools/mcp/server.mjs` - was pinned to 25801 while this one scanned. That is not a
smaller version of the problem but the whole of it: the process that authors the piece would have
gone on calling into whichever window won the base port, which for the second session on a machine is
the FIRST session's window. It now runs the same ladder, and needs no channel to the shim to agree
with it: same id from the parent pid, same port order, and a claim from an id that already holds a
window is a rejoin. Anything else that talks to the plugin directly needs the same treatment - the
arbiter in `check_kit.mjs` did.

---

## 16. Plugin 0.7.0 (2026-09-09, toolkit 0.142.0 / shim 0.69.0): whose window, and how one ends

`BLOCKBENCH_ISOLATION_DESIGN.md` section 10 is the design and the reasoning; here is what the two
files do. It came out of the first live run of step 2, which found three things wrong at once and
one of them fatal to the point of the step: **windows were never cleaned up.**

**A window is the person's unless it was opened for an agent.** 0.5.0 made every unclaimed window
takeable and gave a person `Reserve this window` to opt out of that, which is a flag you find out
about by losing your tab. The default is inverted now. `agentBorn` is set only on a window the plugin
was ASKED to open, `claimable()` is `agentBorn || allowAgents`, and a claim on anything else is
refused by name. `reserved` survives on `/hello` as a DERIVED field, `!claimable()`, so that a shim
from before 0.7.0 - which read it as "yours to take" - goes on leaving a person's window alone; the
shim reads `agent` where it is offered and falls back to `reserved` where it is not.

**The handoff, which is also a pre-claim.** Nothing reaches a new renderer directly:
`ipcMain.on('new-window')` takes no argument we control. So `POST /window` leaves `{session, at}` in
its own localStorage key and the next window to WIN A PORT consumes it - at the end of the port walk,
not at `onload`, because the port is what a shim comes looking for. Consumed and not read, so two
asks make two agent windows and a window opened by hand while no ask is outstanding stays the
person's. The entry carries the asker's id, so the window is claimed for them before it serves its
first request: the port a new window wins is not knowable to the asker, which has to go and scan for
it, and that gap was a window another session's scan could take. An ask whose `new_window` throws
takes its entry back.

**A window claim is not a project binding.** `claimHolder()` now wants `connected(s)`, not `alive(s)`.
A binding earns the two-minute hold because unsaved work is behind it; a claim has nothing behind it.
The only grace is `CLAIM_GRACE_MS` (30s), which covers the gap between winning a window and the
shim's first tool-list poll - that poll is what opens presence - and which is what lets a pre-claim
hold. Without the distinction, a session that died in that gap left its window looking taken for two
minutes, so the next session opened another rather than reusing it.

**And an agent-born window closes itself.** `POST /window` had no counterpart, so nothing anywhere
closed a window and an afternoon of sessions left a row of them at ~220 MB each. The predicate is
four things: agent-born, no live claim, zero open projects, and `EMPTY_GRACE_MS` (60s) since it went
empty, in which a shim whose presence dropped can rejoin. `project op:close` emptying a window arms
the clock rather than deciding it - a session that closes one piece and opens the next has not
finished, and the CLAIM is the lease. Requiring zero projects is what keeps this compatible with
isolation section 6.2: a dropped socket is not consent to destroy work, and a window with nothing
open has no work to destroy.

Two refusals matter as much as the predicate. **Never the last window**, because closing it quits
Blockbench, and a renderer's only way to count windows is to ask the range over http the way a shim
does - a window whose bridge is stopped answers nothing and reads as absent, so the error this makes
is always "stay open". And **never through `closeBlockbenchWindow`**, which is module-scoped after
esbuild and unreachable anyway (isolation section 8): `Blockbench.addFlag('allow_closing')` plus
`window.close()` skips the unsaved-work dialog, and skipping that function is the safer half of the
bargain, because it is the one that wipes EVERY window's crash-recovery backups. An automatic close
cannot destroy another window's entry even where the 0.4.0 guard is absent. The port is given back
first, so a shim scanning in the same second finds a shut door rather than a dying one.

**Which window is whose, from outside and from inside.** Until now the only place that fact existed
was `/hello`. The TITLE carries `[<session> <client>] ` (or `[agent] `) in front of whatever
Blockbench last wrote, so a taskbar full of windows is readable without focusing them; the old prefix
comes off by being REMEMBERED rather than by matching a shape, so a project called `[wip] dragon`
keeps its own brackets. Blockbench writes the title from `setProjectTitle`, module-scoped like
`closeBlockbenchWindow`, so this is a `MutationObserver` on the `<title>` node - watching the node
needs no access to whoever wrote it. A PANEL says the rest: which kind of window this is, who holds
it, the port and window id, the bound project and tab count, the countdown when it is emptying, and
the last twelve calls with their cost. Plain DOM appended to `Panel.node`, every line `textContent`,
because session ids and project names are strings somebody else chose.

**The menu action is inverted with the default**: `Let agents use this window` hands over the one you
are sitting in, stored as `shared_port` for the reason `reserved_port` was stored as a port - one
settings store, read at boot and written back whole, so a stored flag would hand over every window at
once. Taking it back drops the claim with it. What it does NOT do is co-authoring: an agent in a
donated window still steals the active tab whenever it reads its own model, because one project is
live at a time (isolation section 4). Working BESIDE a person is `connect`, a separate route, and it
is not built.

**The shim's half** is `agentWindow(h)`: `agent === true || allow_agents === true`, falling back to
`!reserved` for a plugin that sends neither. That one predicate steers claiming, the choice of who to
ask for a new window, and what may be shared - so the sharing fallback, which used to walk into
whichever window was unreserved, is now only ever a window somebody decided to share.

Harness 233 checks (28 new) and the shim probe 13 tests (2 new), including a plugin-from-before-the-
flip window still being read the old way. **What no stub reaches** is unchanged and is still the live
arm: the second REALM, and now also `window.close()` actually removing a window.
