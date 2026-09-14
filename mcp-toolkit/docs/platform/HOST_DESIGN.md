# The host: a daemon that owns the bridge, and a cockpit a human edits in

**Status: DESIGNED 2026-09-13; STEP 1 BUILT 2026-09-14 (toolkit 0.155.0 / shim 0.77.0 / bridge
plugin 0.13.0) - `mmcpd` core, with two corrections to this design recorded in §3.1 and §11 and the
check in §15.1; STEP 2 BUILT AND CHECKED LIVE the same day (toolkit 0.156.0 / shim 0.78.0) - the
disk feed, the change feed and the `edit` event, as-built notes in §4.1, §4.2, §4.5 and the record
in §15.2; STEP 5 IN ITS FIRST FORM BUILT AND CHECKED LIVE 2026-09-14 (toolkit 0.157.0 / shim
0.79.0), taken ahead of steps 3 and 4 - the supervisor of §3.6 and the cockpit of §6 as pages the
daemon serves at `/ui/`, as-built notes in §3.6, §6 and the record in §15.5.** This is the plan
for the program that sits around
the workbench: creates projects, runs and rebuilds games, shows the running game with a live
readout, hosts the MCP bridge that every modding session connects to, browses and edits assets
with Blockbench beside it, and manages ports, sessions and profiles. Section 4 is the part that
was nearly brushed over and must not be: a human is the cheapest editor in this system when
their edit costs them nothing to land, so **co-editing is a contract, not a panel**, and it
picks up an edit while it is being typed, not when it is saved. Section 15 is the build order;
each step names the check that says it worked.

Read `ARCHITECTURE.md` ("where MCP actually lives") and `IN_JAR_MCP_DESIGN.md` first: this
design finishes the thought both of them start - the URL is the surface - for the shim door.

## 1. What is on the ground

Everything the host needs already exists as a script, a tool, or a plugin. The host is where
they stop being separate things a person or an agent has to know the order of.

| Need | What exists today | Where |
|---|---|---|
| The MCP server | the Node shim, stdio, one process per client session | `mcp-server/index.mjs` |
| The game's own MCP door | `POST /mcp` in the jar, profile in the URL | `IN_JAR_MCP_DESIGN.md` |
| Rebuild cycle | stop, build, relaunch, wait for `ping`; one cycle per port (file-handle lock) | `tools/rebuild.ps1`, `launch_game` |
| A cycle that outlives its caller | by-hand supervisor harness | `tools/launch-supervise.mjs` |
| Process hygiene | supervisors, daemons, dev JVMs, port locks; reap | `tools/dev-procs.ps1` |
| Production client | launcher-less command from an installed version | `tools/prod-client.py` |
| Hotswap with the compile inside | `hotswap_class {compile:true}`, Gradle `compileJava` derived from the classes root; identical bytes refused; `reinit` for live objects | `HOTSWAP_CEILING.md` §3-§7, `GradleCompile.java` |
| New project | template + `toolkitInit -Pclients=all` + per-repo port in `gradle.properties` | `template-mod/README.md` |
| New element | `gradlew scaffold -Pkind=block -Pid=…` | `Scaffold.java` |
| Live assets | `push_asset`, `clear_assets {promote}`, `reload_resources`; the round-trip design and its 359-model test | `body/asset-roundtrip` (0.95-era, 546 files diverged - the design carries, not the branch) |
| Live data | `push_data`, `reload_data` | |
| Live screens | `.ui.json` re-parsed on every mutation; the in-game editor | `SCREEN_AUTHORING_DESIGN.md` slice 4 |
| Blockbench | our plugin on :25801, a window per session, the dock, start screen, idle recycle | `BLOCKBENCH_ISOLATION_DESIGN.md` §11-13 |
| Readout feeds | `GET /activity`, `get_events`, `get_perf`, `get_log`, `get_chat`, `screenshot`, `render` | `BridgeServer.java` |
| Human inbox | the review layer's owed-human-test queue, `/humantask` | `review/` (0.77.0) |
| World undo | `list_edits`, `undo_edit` | |
| Profiles | keep-lists, `tool_surface`, `listChanged` on change | `TOOL_BILL_PLAN.md` |
| Memory | `mem_*`, per-shim `memory-data/` | `MEMORY_DESIGN.md` |

## 2. The shape

```
 Claude Code / Cursor / Codex / Copilot ──── MCP over streamable HTTP ────┐
 (one URL per project+profile; nothing spawned)                           │
                                                                          ▼
 ┌─ cockpit (VS Code extension, later a Theia build) ──┐        ┌─── mmcpd (daemon) ─────────────────┐
 │ Projects · Run · Game view + readout · Sessions      │◄──────►│ session table · port registry       │
 │ Assets · change feed · human inbox · editor          │  HTTP  │ liveness watcher (buffer/undo/disk) │
 │ buffer feed (didChange) ──────────────────────────────►        │ supervisor (games, Blockbench)      │
 └──────────────────────────────────────────────────────┘        │ memory · profiles · local tools     │
                                                                  └──────┬──────────────┬──────────────┘
                                                            /cmd /tools /frames /events │              │ :25801
                                                                         ▼              ▼
                                                        dev/prod game(s), one per port    Blockbench windows
```

Three decisions carry the shape:

1. **The bridge host is a daemon, not the IDE.** Closing an editor must not kill every session's
   server, and one process must own the things that are fought over today: the port registry,
   the Blockbench window pool, memory, the session table. `mmcpd` is the shim's layers as one
   long-lived process with an HTTP MCP transport instead of stdio.
2. **The cockpit is a client of the daemon, and so is every agent.** Every act the cockpit offers
   is a daemon call an agent could make; "tokenless" is a consequence, not a feature. Same rule
   as `BridgeServer.execute` serving both doors.
3. **The editor is not ours to write.** The cockpit is a VS Code extension first (Node, like the
   shim; webviews; the Java/Gradle/debug/git extensions are free; the Claude Code extension
   already puts agent diffs in the human's buffer). It runs unchanged in an Eclipse Theia build
   later if a program of our own is wanted (§13).

## 3. mmcpd

### 3.1 What it is

`mcp-server/daemon.mjs`, a second entry point beside `index.mjs`, sharing `bridge-base.mjs`, the
local tool layers, memory and the Blockbench upstream. The stdio shim stays, unchanged and
supported (release 2's contract); the daemon is the shim's layers held once instead of per
session.

> **As built (0.77.0): a CHILD SHIM PER SESSION, not the layers held once.** Every layer the shim is
> made of keeps its state at module scope - `BASE`, the served profile and hidden set, the memory
> root and session id (`memory/tools.mjs`), the Blockbench window and presence
> (`upstream/blockbench.mjs`), the loop file read from `cwd` - so holding them once meant refactoring
> some three thousand lines into factories under a released contract. Instead `daemon/session.mjs`
> spawns `index.mjs` per MCP session with the project's env and cwd (`MCPTK_URL` from the registry,
> `MCPTK_PROFILE` from the URL, `MCPTK_MEMORY_DIR=~/.mmcp/memory/<project>`, `MCPTK_CLIENT` from
> `initialize`, `MCPTK_EXPECT_GAMEDIR` from the registry's `gameDir`) and pumps JSON-RPC lines
> between the child's stdio and the `StreamableHTTPServerTransport`. What the daemon owns is what
> was fought over: the registry, the session table, where memory lives, the identity each child
> presents to Blockbench (`MCPTK_BLOCKBENCH_SESSION`, the daemon's own id - `mcptk-<ppid>` would be
> the daemon's pid for every child) and the Blockbench each session works in (§11). A session costs
> a node process, as it does today; folding a layer in later changes nothing a client or the cockpit
> sees. The daemon's own requests to a child (a profile switch from the operator) carry `mmcpd-` ids
> and are consumed in the pump, never forwarded.

Single instance per machine, port `25500` by default, bound to `127.0.0.1`, `Origin`-checked like
both game doors (`BRIDGE_AUDIT.md` §1). A file-handle lock in the same style as `rebuild.ps1`'s
per-port lock keeps it single. Started by a login task (Windows Task Scheduler) or by the cockpit
if absent; `mmcpd start|stop|status` as a CLI.

### 3.2 The MCP transport

Streamable HTTP (`@modelcontextprotocol/sdk` `StreamableHTTPServerTransport`), one MCP session per
connection, session id issued by the transport.

```
http://127.0.0.1:25500/mcp/<project>                 default profile (the project's loop file's, else `modding`)
http://127.0.0.1:25500/mcp/<project>?profile=entity  a profile, exactly as the in-jar door names one
```

`<project>` is a registry name (§3.3). The daemon resolves it to a bridge port and dials that
game; the session sees local tools honestly while the game is down and `listChanged` fires when
it appears - the shim's existing behaviour, per session. A session's profile can be changed from
the cockpit; that is `tool_surface` applied by the operator, and it fires `listChanged` too.

Registration in every agent client collapses to a URL: `claude mcp add --transport http mmcp
http://127.0.0.1:25500/mcp/rocketeer`. `toolkitInit` writes these instead of node commands once
the daemon exists; the node-command form stays for machines without it.

### 3.3 The registry

`~/.mmcp/registry.json`, the one place that knows which game is which:

```json
{ "projects": [
  { "name": "rocketeer", "root": "C:/dev/rocketeer", "port": 25642,
    "loader": "fabric", "mc": "26.2", "gameDir": "run", "profile": "modding" } ],
  "blockbench": { "port": 25801 } }
```

Populated by scanning `gradle.properties` of registered roots (the port is already the project
constant that names the project - `RELEASE_1.md` B0) and by *create project*. Live state is not
in the file: `GET /projects` adds `state: down|building|up|world` from `ping` and the supervisor.

### 3.4 Sessions

`GET /sessions` - every connected MCP session: id, client name (from `initialize`), project,
profile, tools in surface, last call and when, image spend, memory scope. `POST
/sessions/<id>/profile`, `DELETE /sessions/<id>`. Owned by the daemon, so the inherited
`MCPTK_SESSION` erasure and the "which shim owns this Blockbench window" fights end: the window
pool is keyed by daemon session id.

As built: ids are `mmcp-<8 hex>`; the row carries the served profile and the one the URL named,
the client's declared name and version, calls and the last one, the shim's pid, the memory root,
the Blockbench URL, and how many HTTP streams the client holds. `GET /sessions/<id>/log` is the
child's stderr (last 200 lines). A session ENDS on the client's `DELETE`, on the child exiting, or
by the reaper: a client that once held the standalone GET stream and holds nothing for 90 s is gone
(the SDK client's `close()` sends no `DELETE` - measured), a client that never held one gets ten
idle minutes. Image spend is not counted yet.

### 3.5 Memory

Moves to the daemon: `~/.mmcp/memory/<project>/` instead of per-shim `memory-data/`. Same
`mem_*` tools, one store per project, readable and editable as a tree in the cockpit (§10). A
human correcting a wrong memory in place is the cheapest correction there is.

### 3.6 The supervisor

`launch-supervise.mjs` promoted: the daemon owns rebuild cycles (`rebuild.ps1` semantics kept -
one cycle per port, `-Takeover` explicit), dev client/server launches, the production client
(`prod-client.py`'s command), and Blockbench windows. `POST /projects/<name>/run {target:
client|server|prod, rebuild: bool}`, `POST /projects/<name>/stop`, `GET /projects/<name>/log`
(tail, SSE). Reaping is `dev-procs.ps1`'s logic, scoped to the registry.

> **As built (0.79.0, `daemon/supervisor.mjs`).** `POST /projects/<n>/run {target: client|server,
> rebuild, takeover, ui, ui_edit, fabricapi}` and `POST /projects/<n>/stop` spawn the WORKBENCH's
> `tools/rebuild.ps1` exactly as `launch_game` does (`-Project <root> -Target -Port`, a stop is
> `-SkipBuild -NoRelaunch`) and keep its output in the daemon: the run's lines, the PHASE read off
> the script's own `[rebuild]` lines, the exit code in the script's words, the log file under
> `~/.mmcp/runs/`. `GET /projects/<n>/log` is JSON or an SSE tail (`run`, `line`..., `exit`);
> `GET /projects/<n>/runs` the history (20); `GET /projects/<n>/latest` the game's `latest.log`
> tail from the registry's `gameDir`; `GET /projects` gains `state: building` (a cycle in flight,
> no game answering), `run` and `last_run`. One cycle per port in-process (409 naming the first
> run; `takeover` passes `-Takeover` down) on top of the script's file-handle lock, which is still
> the guard that sees a rival in another process. The daemon leaving kills its supervisors - each
> ONLY, never its tree, because past the relaunch the game is the supervisor's child. `prod` (the
> `prod-client.py` arm) and `rebuild` as a separate verb are not built: rebuild is `run` with
> `rebuild:true`. A daemon run from an extracted dist has no script and refuses a run with the
> reason (`MMCPD_REBUILD` names one); every other route works. Live: the toolkit's client was `up`
> in 48 s through the route, stopped in 6 s. Found: a Gradle build fires an `fs.watch` event for
> every resource it READS (libuv asks Windows for last-access changes too) - 34 `refused: identical`
> rows on the feed and no game call, the falsifier doing its job.

### 3.7 Routes, complete

| Route | For |
|---|---|
| `POST /mcp/<project>` | the MCP door (§3.2) |
| `GET /projects`, `POST /projects` (create, §7), `POST /projects/<n>/scaffold` | registry |
| `POST /projects/<n>/run`, `/stop`, `/rebuild`, `GET /projects/<n>/log` | supervisor |
| `GET /sessions`, `POST /sessions/<id>/profile`, `DELETE /sessions/<id>` | session table |
| `POST /edit/open`, `/edit/change`, `/edit/close` | the buffer feed (§4.2) |
| `GET /changes` (SSE) | the change feed: every edit, by whom, liveness result (§4.5) |
| `GET /inbox` | human tasks from the review layer, across projects |
| `GET /assets/<n>` (index), `GET /assets/<n>/preview?path=` | asset browser (§10) |
| `GET /memory/<n>`, `PUT /memory/<n>/<id>` | memory tree |
| `GET /blockbench/windows`, `POST /blockbench/open {project, path}` | window pool |
| `GET /projects/<n>/frames`, `/projects/<n>/events` | proxies to the game's `/frames` and `/events` (§5) so the cockpit dials one host |

Everything the cockpit shows comes from these; nothing the cockpit does bypasses them.

## 4. The co-editing contract

The claim: a human should be able to edit everything an agent can, with the same liveness, and
each side should always know what the other did. Five rules, then the mechanics.

1. **The content is the document; every editor is a view of it.** An open buffer is the freshest
   form, the file on disk the durable one. No editor - the human's text editor, the agent's
   `Edit`, Blockbench, the in-game screen editor, the properties panel - holds a private truth.
   Screen authoring slice 4 proved the pattern (every mutation is a JSON edit plus a re-parse);
   it generalises.
2. **Liveness follows the edit, not the save.** The daemon classifies each change and lands it in
   the running game with no agent in the loop. The human types; the frame in the game view
   moves.
3. **Both sides always know.** Every edit, human or agent, is an event both can read within the
   same turn: the change feed for the human, `get_events` and `notifications/resources/updated`
   for the agent.
4. **Every agent edit is undoable in the human's own tool.** World edits via `undo_edit`;
   Blockbench edits through Blockbench's undo stack (Ctrl-Z reverts a session's cube move);
   files through git and the change feed's per-hunk revert.
5. **Handoff is cheap both ways.** Human → session: select code, a texture, a frame region, an
   asset, "send to session". Session → human: the review layer's owed tasks are the human's
   inbox, each with its render attached and a button that opens the thing to fix.

### 4.1 Three feeds into one classifier

Pickup has to be as fast as the editor that made the edit, so there are three feeds, and which
one an edit arrives on only decides its latency:

| Feed | Source | Latency | Carries |
|---|---|---|---|
| **buffer** | the cockpit's `onDidChangeTextDocument`, debounced 300 ms, sent as `POST /edit/change {project, path, text, version}`; also the pixel editor and the properties panel, debounced 100 ms | keystroke | text and image buffers the human has open |
| **undo-stack** | Blockbench's `finish_edit` in our plugin - every undo entry is a push; the in-game screen editor's mutations | one edit | models, animations, `.ui.json` |
| **disk** | the daemon's own watcher (chokidar) on every registered root, 500 ms quiet period | ~1 s | the agent's writes, external tools (Aseprite), git checkouts |

The buffer feed is the same thing an LSP server gets (`didOpen/didChange/didClose`), for the same
reason: a language server that only saw saves would be useless. The daemon keeps an overlay -
buffer over disk - per open path, and every liveness act reads the overlay. Disk convergence is
separate and cheap: the cockpit sets `files.autoSave: afterDelay, 300` for registered roots, so
an agent's `Read` (which reads disk) is at most 300 ms behind the human's buffer.

The disk feed is in the daemon, not the cockpit, on purpose: an agent-only session with no
cockpit open still gets liveness on every write. The agent may still call `hotswap_class` /
`push_asset` itself (a batch, a `reinit`); the watcher swapping the same bytes a moment later is
refused as identical (`HOTSWAP_CEILING.md` §4), so the two never double-apply.

> **As built (step 2, `daemon/watcher.mjs`).** `fs.watch` recursive over `<root>/src` plus the
> root's `gradle.properties`, `AGENTS.md`, `CLAUDE.md` and `.mcptoolkit/loop.json` - no chokidar,
> no dependency. The quiet period is per path and the BATCH flushes only when every pending path is
> quiet, so an agent's four-file turn is one compile and a two-pass PNG export is one push. The
> watcher seeds a content hash (and the text, for the hunk) of every file under `src/` at start:
> that is what makes an identical rewrite decidable without dialing the game, and it also means a
> file that changed WHILE THE DAEMON WAS DOWN is not landed by it - a launch or rebuild does that.
> The seed is a synchronous walk (rocketeer's 1818 files took 3 s) and the daemon does not answer
> until it is done. The disk feed cannot say who wrote: its rows carry `by: {kind: "unknown"}`;
> the buffer feed (step 3) and the undo feed (step 8) are the ones that can.

### 4.2 The classifier

| Change | Act | Live in | On refusal |
|---|---|---|---|
| `.java` (buffer) | in-JVM compile of the buffer text against the running classpath, then swap (§4.3) | < 1 s warm | half-typed code: nothing, silently, until the buffer compiles; structural: "rebuild pending" badge, one-click rebuild, no nag |
| `.java` (disk, agent) | same, after the quiet period; a batch of files waits until the set compiles | ~2 s | as above |
| texture, model, sound, lang, font | `push_asset` from the overlay + `reload_resources` (the round-trip design; its "liveness is a property of the destination") | ~1 s | the asset's own error in the change feed |
| recipe, loot, tag, worldgen, advancement | `push_data` + `reload_data` | ~1 s | the datapack's error |
| `.ui.json` | re-parse in the preview client | one frame | the parse error, at the element |
| Blockbench project | push model + textures on each undo entry, via the plugin (`mcptoolkit_sync.js`) | ~1 s | in the window's presence line and the feed |
| `gradle.properties`, `.mcptoolkit/loop.json`, `AGENTS.md`, profiles | the daemon reloads registry/profile; sessions get `listChanged` where it applies | immediate | validation error in the feed |
| anything else | no act; the edit is still in the feed | - | - |

Java's gate is the cockpit's diagnostics: the buffer is sent for compile only when jdtls reports
zero errors on it, so a game JVM never compiles a storm of half-lines. Without a cockpit (agent
writes) the daemon compiles after the quiet period and treats a failure as "not yet".

> **As built (step 2).** The Java row of the batch is ONE `hotswap_class {classes, compile:true,
> reinit:false}`; a class the JVM never loaded (`class not loaded`) is marked `pending-rebuild`,
> dropped, and the rest of the batch retried once, so a new file does not block the edit beside it.
> The `.ui.json` row is `ui_doc {op: "refresh"}`, an op added for this: it MIRRORS the source file
> into the loaded pack's copy first (a document addressed as `<mod>:<screen>` is read through the
> resource manager, which in a dev run is `build/resources/main` - `UiSaveTarget`'s trap 2), then
> rebuilds the preview showing it, if one is and its editor is off; the reply is the parse verdict
> either way. `fabric.mod.json`, `*.mixins.json`, `*.accesswidener` and a deleted `.java` are
> `pending-rebuild` with no act. `gradle.properties` re-reads the registry entry (and re-points the
> watcher when the port moved). A deleted asset or data file is `clear_assets` / `clear_data`. The
> result vocabulary gained `none`: no act applies, or the game is down - the row is still on the
> feed, which is the point of a feed the daemon owns.

### 4.3 Compiling from a buffer

`hotswap_class {compile:true}` today runs Gradle `compileJava` (`GradleCompile.java`): right for
a batch, seconds warm and minutes cold, and it reads disk. Keystroke liveness needs a second
path: **`hotswap_class {source: <text>, path: <src path>}`** compiles the text in the game JVM
with `javax.tools` against the classpath the game is actually running (which is the property
`GradleCompile` had to derive - here it cannot be wrong), swaps, and reports as the ledger does
today. Checks before building it: the dev game runs on a JDK (the compiler is present; a
production JRE is not, so that door falls back to Gradle); loom's dev classpath is named-mapped
so mixin sources compile without the refmap processor - confirm; a class whose swap needs
`reinit` is still the agent's call, the watcher passes `reinit:false`.

Latency budget, keystroke to frame: 300 ms debounce + ~300-600 ms warm in-JVM javac of one file
+ the swap + one frame. Under a second, which is what "the frame moves while I type" needs.

### 4.4 Conflicts

Two writers on one file will collide. **The open dirty buffer wins.** Auto-save keeps buffers
clean within 300 ms, so the window is small; inside it the agent's `Edit` fails modified-since-
read (Claude Code's existing behaviour), re-reads, retries - and the human's hunk is already in
the event stream, so the retry is informed rather than blind. Blockbench serialises both writers
on the window's undo stack; the world serialises on the server thread. No merge algorithm; both
parties read one ledger.

### 4.5 The event

One shape on the change feed (SSE, for the cockpit) and in `get_events` (type `edit`, for the
agent), plus `notifications/resources/updated` to every session on the project:

```json
{ "type": "edit", "project": "rocketeer", "path": "src/main/java/.../Rocket.java",
  "by": { "kind": "human" | "session", "id": "…" }, "feed": "buffer|undo|disk",
  "hunk": "@@ -41 +41 @@ -  static final double SPEED = 0.30; +  static final double SPEED = 0.25;",
  "live": { "act": "hotswap", "result": "swapped" | "refused" | "pending-rebuild" | "not-yet", "ms": 640 } }
```

`hunk` is a diff summary capped at a few lines - enough that an agent reading its events knows
the number changed without re-reading the file.

> **As built (step 2).** The row gains `op: create|write|delete`, and `live.result` gains `none`.
> The daemon's copy is `daemon/feed.mjs` (a ring of 500, `GET /changes` as JSON with `since` and
> `project`, or SSE with `Accept: text/event-stream` and `Last-Event-ID` replay; `mmcpd changes
> --follow`). The game's copy is written through a new privileged tool, **`record_edit`**, which
> is the only way into the stream from outside and fixes the shape - the feed and result
> vocabularies are checked, the hunk is capped at 2000 characters, and the row is stamped with the
> caller's session so a row that was not the daemon's is visible as such (`EventTools`, type
> `edit` in `EventTypes`, group BUILD). Every daemon session on the project also gets
> `notifications/resources/updated {uri: file:///...}` on its standalone stream; a client holding
> none is polling and reads `get_events` instead.

## 5. The game view and the readout

Window embedding is out: impossible from a web shell, fragile from a native one. The game view
is a **frame stream** from the bridge, which composes with a fact already established: a
minimized client still renders (`minimized-window-renders`), so the game stays minimized where
`rebuild.ps1` puts it and the cockpit shows it.

- **`GET /frames?w=640&h=360&fps=10`** on the bridge: MJPEG. On the render thread after the frame,
  read the main framebuffer every `60/fps` frames, downscale, hand the bytes to a worker for JPEG.
  One client at a time per game; a second connection replaces the first. Cost to measure: the
  read-back at 640x360 should be well under a millisecond a frame; encoding is off-thread.
- **`GET /events?since=`** as SSE beside `get_events`, so the readout tails rather than polls.
- The readout beside the frame: `/activity` (what the session is doing), the event tail, `perf`,
  chat, `get_log` errors, the session table's current call, and the change feed.
- **Click-through**: a click on the frame is a `pick` - a new tool: ray from the camera through
  that pixel, returns block or entity, its registry id, and the asset paths behind it (blockstate,
  model, textures, the Java class that registered it where the scaffold ledger knows). The
  cockpit opens them. A click on a screen preview does the same via `ui_doc` for the widget. This
  is what turns the view from a monitor into the index of everything editable.
- Full-resolution `screenshot` on demand. **Input passthrough (click-to-look, keys) is not in the
  first cut**; the human plays in the real window.

## 6. The cockpit

A VS Code extension, `mmcp-cockpit`, in `mcmodding/cockpit/`. Node, so it imports the daemon's
client module directly.

| Piece | VS Code surface |
|---|---|
| Projects (registry, state, create, scaffold) | tree view in an `MMCP` view container |
| Run (dev client/server, prod, rebuild, hotswap, attach debugger) | tree + commands + status bar item per project |
| Game view | webview editor tab per game (`<img>` on `/frames`, click → `pick`) |
| Readout | webview in the panel area, SSE tails |
| Sessions | tree view; profile change from the context menu |
| Assets | tree view with preview webview; "open in Blockbench"; push/promote |
| Change feed + inbox | tree views; per-hunk revert; inbox cards open their subject |
| Buffer feed | `onDidChangeTextDocument` for registered roots → `/edit/change` |
| Liveness status | decoration on the editor tab: live / rebuild pending / refused |
| Settings it sets | `files.autoSave` afterDelay 300 for registered roots |
| MCP for Copilot | `McpServerDefinitionProvider` publishing each project's daemon URL |
| Java, Gradle, debug, git | vscode-java, vscode-java-debug, vscode-gradle - not ours |
| Agent sessions | the Claude Code extension, connected to the daemon by URL; "send to session" uses its selection channel and extends it to assets and frames |

The Claude Code extension already shows agent diffs in the human's buffer; that is the baseline
the contract builds on, not something to replace.

> **As built (0.79.0): THE BROWSER FORM FIRST - `mcp-server/daemon/ui/`, served by the daemon at
> `http://127.0.0.1:25500/ui/`.** No VS Code exists on the machine this was built on, so an
> extension nobody could open was not a check; and half the table above is webviews, which are the
> same HTML in an `<iframe>`-shaped host. So the cockpit's pages are the daemon's own static files
> (one page, three files, no framework, an edit is a reload away), and the extension, when there is
> one, hosts them in tabs and adds the three rows only an editor can supply: the buffer feed, the
> liveness decoration, `McpServerDefinitionProvider`. What the page has: **Projects** (state pill
> `down|building|up|world`, the MCP URL to copy, sessions, the disk feed's counters, the game's
> identity), **Run** per project (Launch = no build; Rebuild & launch; Stop; target; takeover;
> fabric-api; a `-Ui` document; the phase and the output tailed over SSE; `latest.log`),
> **Sessions** (profile switch from a select, kick, the shim's stderr), **Change feed** (SSE, the
> hunk a click away, `refused`/`none` hidden by default), **Blockbench** (instances, kill, re-seed).
> Not yet: the game view and readout (step 4's `/frames` and `/events`), the inbox, assets, memory
> as a tree, create project. The page holds no truth: everything shown is a route and every button
> is a POST to one. `tools/cockpit-shot.mjs` lets an agent look at a tab (headless Edge over CDP;
> plain `--screenshot` cuts the page's fetches short and shows an empty cockpit - measured).

## 7. Projects

*Create project* is `template-mod/README.md` steps 3-4 with the hands taken out: copy the
template, rename `examplemod` (id, package, `settings.gradle`, `fabric.mod.json`), allocate the
next free port from the registry, write `gradle.properties`, `gradlew toolkitInit -Pclients=all`,
`npm install --omit=dev` in `.mcptoolkit/mcp-server` (kept for machines without the daemon),
register, open in the cockpit. Inputs: name, id, package, loader, MC version. Tokenless.

*Scaffold* is `gradlew scaffold -Pkind=… -Pid=…` plus the `register()` call, then a rebuild
pending badge, since a new class is structural.

## 8. Run

Targets per project: `client` (dev, `runClient`), `server` (dev, headless), `prod` (the
`prod-client.py` command with `-Dmcptoolkit.port`). `rebuild` is the full cycle; `hotswap` the
swap of what is dirty; `attach` starts vscode-java-debug against the dev JVM's debug port (loom's
`--debug-jvm`). The JVM flags the hotswap tiers need (`-Dmixin.hotSwap=true`,
`-XX:+AllowEnhancedClassRedefinition` on JBR) are a checkbox per target, not knowledge.

## 9. Sessions and profiles

The session tree is §3.4. Profiles are the shim's keep-lists, unchanged; the cockpit shows the
surface a session has and lets the operator widen or narrow it (the `tool_surface` hides are
the operator's, kept apart from the profile's - `index.mjs` already draws that line). A project's
default profile is its loop file's, editable as a field. Kicking a session closes its transport;
its Blockbench window returns to the pool.

## 10. Assets

The daemon indexes `src/main/resources` per project: kind (texture, model, blockstate, sound,
lang, data), references (from `checkAssets`'s dangling/unused analysis, already in the build),
and the game-side id where `query_registry` maps one. Previews: textures inline; models and
entities via `render`/`studio` against the running game, cached by content hash; screens via the
preview client. Actions: open (text editor, pixel editor, properties panel, Blockbench), push,
promote (`clear_assets {promote}`), reveal in game (`pick` in reverse where the id is placeable).

Small edits made small:
- **Properties panel** for JSON: a form generated from the schema (registry-derived for data,
  `ui_doc`'s for screens), nudge arrows on numbers, swatches on colours; writes the file, lands
  through the buffer feed.
- **Pixel editor** in a webview for the one-pixel case; Blockbench for real painting.
- **Java constants**: the text editor and §4.3. No forms over Java.
- **Memory tree**: the agent's notes, editable.

## 11. Blockbench

External process, pooled and owned by the daemon: the plugin's window model (`BLOCKBENCH_ISOLATION_DESIGN.md` §11-13) keyed by daemon session id instead of `mcptk-<ppid>`. The cockpit's
"open in Blockbench" is `POST /blockbench/open` → a pooled window loads the file. Agent edits go
through the plugin inside Blockbench's `Undo.initEdit/finishEdit` so the human's Ctrl-Z reverts
them, and the plugin's presence line names the session that made each. Every finished edit -
human's or agent's - is an undo-stack event that pushes (§4.1). The web build of Blockbench in an
iframe was considered and rejected: it loses the file-loaded plugin and localhost sockets.

> **As built (0.77.0 / plugin 0.13.0): AN INSTANCE PER SESSION, no window pool.** The owner's
> correction: "spawn an isolated app for each session - no window hassle at all." The shipped
> Blockbench takes `--userData <dir>`, and Electron's single-instance lock lives in that directory,
> so `Blockbench.exe --userData ~/.mmcp/bb/<session>` is a separate process with its own settings,
> plugin registrations, recent files and lock. Nothing is scanned, claimed, docked, handed off or
> recycled: the daemon started it, the daemon ends it. Mechanics (`daemon/blockbench.mjs`):
>
> - The shim is pointed at a PROXY the daemon holds from the session's first moment (a bare
>   `MCPTK_BLOCKBENCH=http://127.0.0.1:<ephemeral>`, the shim's existing pinned mode); the instance
>   is spawned on the proxy's FIRST REQUEST, so a `modding` session that never models never pays
>   for an Electron, and a `tool_surface art` switch mid-session works. The proxy is also where the
>   daemon sees every Blockbench call - the wire step 8's undo-stack feed will read.
> - The plugin's OWNED MODE: `MCPTK_BLOCKBENCH_PORT` and `MCPTK_BLOCKBENCH_OWNER` in the instance's
>   environment (read through the `process` grant it already holds). It binds exactly that port,
>   never looks for a dock, beats or sweeps, accepts a claim from the owner alone, and says
>   `owned: {owner, port}` and `role: "owned"` on `GET /hello`. Without the two variables the plugin
>   is unchanged, so the person's own Blockbench behaves as before.
> - The plugin registration is in Chromium's Local Storage and its permission in
>   `plugin_permissions.json`, so a fresh userData has no door: each session's directory is seeded
>   from `~/.mmcp/bb/template`, itself copied once from `%APPDATA%/Blockbench` (`mmcpd bb-template`
>   re-seeds). Measured: a seeded instance answers `/hello` in 6-8 s cold.
> - Ending: a clean instance is killed (`taskkill /T`) and its directory removed; one holding
>   UNSAVED projects is left running and listed as `orphaned` - a person can still save from it;
>   `DELETE /blockbench/<session>?force=1` kills it anyway. `GET /blockbench` lists instances.
>
> The web-build variant (the daemon hosting Blockbench's browser build at `/bb/<session>/` with the
> plugin injected) is the same idea with the plugin's transport inverted - a browser cannot
> `http.listen`, so it would dial a WebSocket to the daemon - and a headless renderer for
> agent-only sessions. Its payoff is Blockbench as a cockpit tab; it is the §13-era upgrade.

## 12. The daemon owns liveness even with no cockpit

Worth saying twice: the disk watcher lives in `mmcpd`. An agent working alone in a repo gets
every write landed in the game without calling a tool, and the change feed records it. The
cockpit adds the keystroke feed and the human's views; it is not required for the contract.

## 13. The Theia path

If a program of our own is wanted - branded, with first-class widgets where a webview hurts -
`theia build` an Electron distribution that bundles `mmcp-cockpit` unchanged (Theia runs VS Code
extensions from Open VSX; vscode-java, java-debug, gradle, git all work there) and add native
widgets only for what the webview did badly. Theia's `@theia/ai-*` has an MCP client, so agent
sessions can run inside the cockpit against the daemon. Nothing from the extension is discarded
at the upgrade; that is the argument for starting with the extension.

## 14. Bases considered

| Candidate | Why not the base |
|---|---|
| IntelliJ plugin | best Java tooling and JBR's redefinition, but the host would be JVM/Swing/JCEF while the bridge layers are Node; a plugin in someone else's shell for good; a custom IDE distribution is Android-Studio-scale |
| MCreator (GPL, Swing) | closest feature list (workspaces, gradle, run, texture makers, Blockbench import) but built around visual mod elements generating code; a monolith to fight |
| Prism Launcher | production launching only; reuse later as the prod arm (an instance with `-Dmcptoolkit.port`) instead of `prod-client.py` |
| Own Electron/Tauri + Monaco | rebuilds jdtls/DAP/Gradle wiring that exists as extensions; that is Theia, prebuilt |
| Blockbench as shell | an asset editor, not an IDE |
| Zed, Lapce | no custom panels in their extension models |
| **VS Code extension → Theia** | chosen; §2 and §13 |

## 15. Build order

Each step is one release with its check; nothing below depends on a step above it being
polished, only present.

1. **`mmcpd` core** - `daemon.mjs`: streamable HTTP transport, registry, session table, memory
   moved. *Check:* two Claude Code sessions on two projects through one daemon, each seeing its
   own profile and memory; kill one, the other is untouched; the shim's stdio probes still pass.
   **BUILT 2026-09-14** (`mcp-server/daemon.mjs`, `daemon/{registry,session,blockbench}.mjs`,
   `blockbench-profiles.mjs`; CLI `node mcp-server/daemon.mjs serve|status|stop|add|remove|
   projects|sessions|kick|profile|blockbench|bb-template|url`). *Checked:* `probes/daemon.test.mjs`
   (7/7, no game): two SDK clients on two registered roots through one daemon - `inspect` and
   `modding` each served their own slice, two shim pids, memory roots `~/.mmcp/memory/<project>`,
   a Blockbench proxy each; `DELETE /sessions/<a>` left `b` answering and `a`'s client 404ing; a
   `POST /sessions/<id>/profile authoring` from outside switched the child, ONE `tools/list_changed`
   reached the client through the daemon's standalone stream, and the reply priced the switch; a
   page's `Origin` is refused. Live the same day: an `art` session on `mcp-toolkit` spawned an
   owned Blockbench instance on its first list, served 34 tools after 7 s, answered
   `get_project_info` through the proxy, and the instance died and its directory went with the
   `DELETE`; a `modding` session's `launch_game` resolved the project from the child's cwd and
   brought the toolkit's dev client up in 41 s with the daemon's `GET /projects` reading
   `down → up`, `ping` through the session answering with `profile: modding` and 53 tools. The
   shim's offline suites (`npm test` 191, fixture probes 29) pass unchanged; the live
   `profiles.test.mjs` passes against that client. Found on the way: a GET's request stream closes
   before its answer, so a proxy that hangs its upstream-abort on `req` kills every call (it hangs
   on the response now); the toolkit's own game runs in the workbench root's `run/`, so the
   attachment check needs the registry's absolute `gameDir`, not the root. Not yet: image spend
   per session, `create project`, a login task (`mmcpd serve` from a terminal for now),
   `toolkitInit` writing the URL registration.
2. **Liveness watcher (disk feed) + change feed + `edit` event** - chokidar over registered
   roots, the classifier for assets/data/screens; Java through the existing Gradle compile.
   *Check:* an agent writes a texture with `Write` and calls nothing; the game shows it; the
   `edit` event names the file and `swapped`. *Falsifier:* an identical rewrite produces one
   `refused` and no reload.
   **BUILT AND CHECKED LIVE 2026-09-14** (`daemon/watcher.mjs`, `daemon/feed.mjs`,
   `daemon/game.mjs`; toolkit 0.156.0 adds `record_edit` and `ui_doc refresh`). *Checked, no game*
   (`probes/watcher.test.mjs`, 12/12, a fake bridge on the project's port): a texture written and
   nothing called becomes `push_asset {path, file, reload:false}` + one `reload_resources`, the row
   says `swapped`, `record_edit` carries the same row, a session on the project receives ONE
   `notifications/resources/updated` naming the file; the FALSIFIER - the same bytes rewritten -
   is one `refused` row, no push and no reload; two Java files in one turn are one `hotswap_class
   {classes:[a,b], compile:true}`; a failed compile is `not-yet`, an unloaded class is
   `pending-rebuild` while the loaded one beside it lands, a structural rejection is
   `pending-rebuild`, unchanged bytes after a comment edit are `refused`; a document is `ui_doc
   refresh` and a parse failure is its refusal; data is `push_data` + `reload_data`;
   `fabric.mod.json` is `pending-rebuild`; a deletion is `clear_assets`; a project whose game is
   down keeps its row with `none` and the reason, and SSE delivers it; a port change in
   `gradle.properties` re-reads the registry and re-points the watcher. *Live, the toolkit's own
   dev client at 0.156.0:* a magenta `assets/minecraft/textures/gui/title/minecraft.png` written
   into `src/main/resources` with nothing called was on the title screen 5.4 s later (0.5 s quiet +
   a 4.9 s resource reload: the reload IS the latency for assets), the feed row said `push_asset
   swapped 4885ms`, `get_events {type: "edit"}` served the same row as event 6 stamped with the
   daemon's session `x1-71640` (label `mmcpd:mcp-toolkit` in `session_list`); the same bytes
   rewritten produced one `refused` row and `latest.log` still counted ONE reload after boot; a
   line added to `BuiltinTools`' ping lambda with `Edit` was `hotswap swapped 25097ms` (Gradle
   `compileJava` cold, 24.8 s of it) and `ping` answered the new field, the revert `swapped
   5716ms` warm and the field was gone, the tree clean; deleting the PNG was `clear_assets
   swapped 3841ms` and the logo was back. Not seen live: the preview re-parse with a document OPEN
   (`ui_doc refresh` answered `mirrored:true, refreshed:false, open: TitleScreen` from the title
   screen, which is its no-preview answer; the rebuild path is the one a window resize runs).
3. **Buffer feed + in-JVM compile** - `/edit/*`, the overlay, `hotswap_class {source}`. *Check:*
   a constant retyped in VS Code, no save, is live in under a second; a half-typed line produces
   nothing; a new field produces `pending-rebuild` once, not per keystroke.
4. **Frames + events SSE + `pick`** - the bridge's `/frames`, `/events`, the `pick` tool.
   *Check:* frame cost measured at 640x360x10 against `get_perf`; a click on a placed block
   returns its id and files.
5. **Cockpit v1** - Projects, Run, Sessions, Game view, Readout, change feed, inbox, liveness
   decorations, auto-save setting, `McpServerDefinitionProvider`. *Check:* the whole loop from a
   cold machine - open cockpit, daemon starts, run client, type a change, see it - with no tool
   called by hand.
   **FIRST FORM BUILT AND CHECKED LIVE 2026-09-14, ahead of 3 and 4** (toolkit 0.157.0 / shim
   0.79.0; `daemon/supervisor.mjs`, `daemon/ui/`, the run routes; §3.6 and §6 as-built notes).
   Present: Projects, Run, Sessions, change feed, Blockbench, as pages the daemon serves in a
   browser. Waiting on their steps: the game view and readout (4), the buffer feed and the
   liveness decoration (3 and an editor), the inbox, assets, memory, create project (6, 7).
   *Checked, no game* (`probes/supervisor.test.mjs`, 7/7, a fake `rebuild.ps1`): the pages served
   and nothing outside them, a foreign origin refused; a run's arguments, phases, verdict and log
   file; `building` while in flight and `last_run` after; the SSE tail ending in `exit` and a
   finished run replaying; the 409 for a second cycle and `-Takeover` passed down; stop, failed
   build, bridge timeout named; the `latest.log` tail; the refusal without a script. *Live:* the
   toolkit's client through **Rebuild & launch** was `up` in 48 s, the page showed `building` with
   the phase then `up` with the game's identity; a texture written under `src/` with the game up
   was `push_asset swapped 4392ms` on the feed tab; **Stop** was `stopped` in 6 s; the history held
   both. The check as written - open cockpit, run client, TYPE a change, see it - is two-thirds
   met: the typed half is step 3's.
6. **Create project + scaffold** through the daemon. *Check:* a new project from the cockpit
   answers `ping` on a fresh port and its Claude Code registration is a URL.
7. **Assets** - index, previews, Blockbench open through the pool, push/promote; the properties
   panel; the pixel editor. *Check:* the 359-model round trip from the asset branch, rerun
   against the daemon's watcher.
8. **Blockbench undo-stack feed** and agent edits in the undo stack. *Check:* Ctrl-Z in the
   window reverts a session's edit and the feed shows both.
9. **Theia distribution** - only when the shell's limits actually bite.

## 16. Open questions

- Input passthrough on the game view: view-only in the first cut; decide after §15.5 whether
  click-to-look is wanted or the real window is always at hand.
- Whether the in-jar door should also learn `/frames` and `/events`, or only the dev bridge.
  Production sessions would want the readout; nothing else in this design touches production.
- Mixin sources through `javax.tools` (§4.3) - to confirm before step 3 is designed in detail.
- Daemon lifetime on machines with no login task: started by the cockpit is enough for the
  cockpit, but a Claude Code session started before any cockpit needs the daemon up first. The
  registration could name a launcher command as a fallback (`mmcpd serve --if-absent` then
  connect), which the streamable transport does not do by itself.
- A daemon session's identity at the GAME is still the id `/hello` mints for its child, not the
  daemon's `mmcp-<id>`: `Sessions.touch` adopts an unknown id as "adopted" with no client
  declaration, so presetting `MCPTK_SESSION` would cost the hello. A `/hello {session}` that
  accepts a proposed id would make one id name the session at the game, at Blockbench and in the
  daemon's table.
- An orphaned Blockbench instance (unsaved work, session gone) cannot be adopted by the project's
  next session; the plugin takes claims from its owner alone. A `POST /owner` on the plugin, or a
  daemon-side re-key, when it is wanted.
- The disk feed's Java latency is Gradle's: 5-25 s per batch against the 300-600 ms the design
  budgets for a keystroke. Step 3's in-JVM compile (`hotswap_class {source}`) is what closes that,
  and the watcher should take the same path for a single changed file once it exists; a batch
  that spans files stays Gradle's.
- An asset's latency is the resource reload (4.9 s on the toolkit's client at the title screen,
  the whole pack set re-read). A reload scoped to the pushed paths would make a texture edit
  sub-second; vanilla has no such reload, so it is a toolkit-side question.
- The watcher lands a source-tree asset as a LIVE-PACK OVERRIDE (`run/resourcepacks/mcptoolkit_live`),
  which persists across restarts and shadows the built copy of the same path. Today that is
  harmless (the two agree after the next build) until the source changes while no daemon runs -
  then the override is stale and wins. The watcher could drop its own overrides on a successful
  rebuild, or `list_assets` could say which are the watcher's.
- The disk feed cannot attribute (`by: {kind: "unknown"}`). A daemon session whose last call was a
  local file tool is a guess, not a fact; the buffer feed is the attribution.
- A Gradle build makes the disk feed fire once per resource file it reads (Windows reports
  last-access changes and libuv subscribes to them): every row is `refused: identical` and no game
  is dialed, but a build is thirty rows of noise on the feed. The page hides them; the watcher
  could instead fold a batch of only-identical events into one line.
- The cockpit page and the daemon's MCP door share one origin, so a page from another origin is
  refused by the same check that guards the door (`BRIDGE_AUDIT.md` §1); the page is loopback only
  and nothing on it is authenticated beyond that, which is the daemon's own posture.
- Steps 3 and 4 are now what the page is waiting for: the game view tab is an `<img>` on
  `/projects/<n>/frames` once the bridge has it; the buffer feed needs an editor, so it comes with
  the extension form (a Monaco tab in the page would bring no jdtls and is not planned).
