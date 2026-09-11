# Textures and models

Iterating on how something *looks*, which is the part of modding with the worst feedback loop and the
biggest improvement from a live bridge. Two routes: **push a file** (a PNG you made anywhere) or
**work in Blockbench** with the toolkit's plugins, where pixels go straight from the canvas into the
game without ever passing through a conversation.

Entities have extra machinery on top of this — see [Entities](entities.md). What to *do* with the
picture afterwards is [Rendering and screenshots](rendering-and-screenshots.md).

## On this page

- [How it works](#how-it-works)
  - [The plain route: push a file](#the-plain-route-push-a-file)
  - [The Blockbench route](#the-blockbench-route)
- [Setting up the Blockbench plugins](#setting-up-the-blockbench-plugins)
- [Walkthrough: a block texture, start to finish](#walkthrough-a-block-texture-start-to-finish)
- [Windows, sessions and who owns a project](#windows-sessions-and-who-owns-a-project)
- [Promotion](#promotion)
- [An agent session](#an-agent-session)
- [Things to keep in mind](#things-to-keep-in-mind)
- [Where to go next](#where-to-go-next)

---

## How it works

### The plain route: push a file

If the PNG exists on disk, this is the whole thing:

```
push_asset {path: "assets/mymod/textures/block/lantern.png", file: "C:/art/lantern.png"}
```

Seconds. The file goes into the live resource pack, which sits on top of your mod and vanilla.

**Pass `file`, not `base64`.** `file` is an absolute local path the game reads itself — about a
40-token call. `base64` puts the whole image through the conversation and is for bytes that exist
nowhere on disk. On an art loop that difference is most of your bill.

Batch several pushes with `reload: false` and finish with one `reload_resources`. The reload is the
expensive half; the write is not.

The same door takes models, blockstates, item definitions, `.mcmeta` files, sounds and lang files —
anything under `assets/`.

### The Blockbench route

Three plugins, all desktop-only, all loaded once via **File › Plugins › Load Plugin from File**:

| Plugin | What it is |
|---|---|
| `mcptoolkit_bridge.js` | **The door.** The MCP server's Blockbench upstream — 26 tools for modelling, texturing, painting, inspecting and screenshotting, served into your session |
| `mcptoolkit_sync.js` | **Push assets to the game.** Pixels travel canvas → bridge → game, entirely inside Blockbench |
| `mcptoolkit_entity.js` | **Entity geometry**, which drives the sync plugin rather than reimplementing it |

The point of the bridge plugin is that Blockbench becomes part of the same tool surface: `place_cube`,
`modify_cube`, `element`, `texture`, `paint_faces`, `inspect`, `capture_screenshot` and the rest are
just tools your session can call, alongside the game's.

Every edit is one undo entry and replies with its own readback — face rectangles, envelope gaps — so
you do not have to take a screenshot to find out what happened. `look: true` on an edit returns the
viewport on the same reply.

The `art` profile keeps all of it. See [Tool profiles and cost](tool-profiles-and-cost.md).

## Setting up the Blockbench plugins

**Where the files are** depends on which side of the release you are on. In this workbench they live
in `mcp-toolkit/blockbench/`. From a consumer repository they come out of the jar, into two places:

```
<gameDir>/mcptoolkit/blockbench/      # refreshed every dev boot, beside the extracted MCP server
<repo>/.mcptoolkit/blockbench/        # once, by `gradlew toolkitInit`
```

**Load from the first one.** It is written inside the MCP server extract's own freshness branch,
under the same version stamp, so the plugin beside a server is always that server's plugin. That
pairing matters: the two are one release unit, and a mismatched pair answers wrongly rather than
refusing. The `toolkitInit` copy is write-if-absent, so it is a starting point, not a refresh.

**Then:** Tools › MCP Toolkit Bridge › Start, and **"Always allow"** the one permission it asks for
(`process` — how a plugin reaches Node's `http`).

That permission dialog deserves a warning of its own, because it is the single most confusing failure
in this area. **A Blockbench modal permission prompt freezes the entire renderer.** Until a human
clicks it, every bridge request times out. If the endpoint has gone silent but Blockbench looks idle,
somebody needs to go and look for a dialog. The bridge plugin never opens one by itself, for exactly
this reason.

**Remove any separate `blockbench` MCP server** registered beside the toolkit in `.mcp.json` or
`~/.claude.json`. Two paths to one app means paying two tool prefixes on every turn.

## Walkthrough: a block texture, start to finish

**From a file:**

```
push_asset {path: "assets/mymod/textures/block/lantern.png", file: "C:/art/lantern.png"}
render     {look_at: {x: 10, y: 65, z: 10}, inline: true}
# adjust the PNG, push again, look again
clear_assets {path: "assets/mymod/textures/block/lantern.png",
              promote: "C:/dev/mymod/src/main/resources"}
```

**From Blockbench,** the agent route — asset bytes never enter the conversation:

```js
// inside risky_eval
mcptoolkitPush({project: PROJECT, bridge: GAME,
                namespace: 'mymod', folder: 'textures/block'})
```

`PROJECT` and `GAME` are put in scope for you: the project this call resolved to, and the bridge URL
of the game this session drives. **Always pass them** rather than letting a plugin read the global
`Project` or a port it guessed — a project *name* is refused outright, because resolving a name
reaches a project without the ownership check.

The return is a compact `{ok, pushed, target, paths}` summary, also stored in `mcptoolkitLastPush`.
Note that it **never rejects**: errors come back as `{ok: false, error}`. Check `.ok`; do not wrap it
in try/catch.

Options worth knowing: `only` (a subset of textures by name), `model` / `modelPath` / `modelName`
(compiled model JSON), `extras: [{path, text}]` for blockstates, `.mcmeta` and lang, and `target:
'live' | 'source' | 'both'`.

**Human route:** File › Push to Game, the same code behind a dialog.

**Verify cheaply.** `list_assets` confirms the files landed and is essentially free. Spend one
screenshot per *batch* to judge the art — not one per asset.

## Windows, sessions and who owns a project

If more than one session might touch Blockbench, this is worth two minutes.

Each Blockbench **window's** plugin takes the next free port from 25801 upward, and **one session
works in one window**. `ping` tells you which one you got: `blockbench: {port, window, held,
session}`.

**A window is yours unless the plugin was asked to open it for an agent.** The window you are
personally working in is never claimed, and you set no flag to keep it that way. A session that finds
no agent window of its own asks an existing window to open a new one, pre-claimed for it. An
agent-born window **closes itself** once nothing holds it and nothing is open in it — never the last
one, which would quit the app — so an afternoon of sessions does not leave a row of empty windows.

If you want to hand your own window over, *Let agents use this window* in the plugin menu does it, by
port, so a restart remembers it. The cost is stated: an agent working there still switches the active
tab to its own model.

**Projects are owned too.** A session that makes or opens a project is *bound* to it, and every later
call without an explicit `project` goes there. An edit to a project another live session holds is
refused with `held_by` and the two ways out. **Reads are never refused.** `project op:list` shows
every tab, its holder and the live sessions.

Every call is queued, so two sessions never interleave inside the app.

## Promotion

The live pack is a preview surface, not a home.

**From the game side**, promotion rides on the clear:

```jsonc
clear_assets {path: "assets/mymod/textures/block/lantern.png",
              promote: "C:/dev/mymod/src/main/resources"}
```

Files are copied first, *then* the override is removed. A refused promotion clears nothing.

**From Blockbench**, `target: 'source'` writes straight into `src/main/resources` — no game needed.
But **there is no default destination**, and that is deliberate:

```js
mcptoolkitPushSettings({sourceRoots: {'<project>': 'C:/dev/mymod/src/main/resources'}})
```

A promotion with nowhere to go is refused *by the name of the setting*. `writeToSource` will happily
create an `assets/` tree wherever it is pointed, and a wrong-but-plausible default is exactly how a
file lands in a checkout nobody is looking at.

If you previewed through the live pack and then promoted from Blockbench, **still clear the
override** — otherwise it keeps winning over the file you just wrote.

## An agent session

> **You:** the lantern texture's too dark and the glass panes read as solid.

> **Agent** calls `list_textures` in the Blockbench project, then `texture {op: "read"}` on the
> lantern sheet — which prints the texels as characters rather than as an image.
>
> It can see the actual values without spending a picture on it.

> **Agent** calls `texture {op: "rects", ...}` to lift the glass panes' alpha and brighten the
> body, then `mcptoolkitPush({project: PROJECT, bridge: GAME, namespace: 'mymod', folder:
> 'textures/block'})` inside `risky_eval`.
> → `{ok: true, pushed: 2, target: "live"}`

> **Agent** calls `render {look_at: <the lantern>, inline: true}` — one picture, after the batch, not
> one per texture.

> **You:** good. Ship it.

> **Agent** promotes through the sync plugin's `target: 'source'`, then calls `clear_assets {path:
> ...}` to remove the live override — otherwise the preview would keep winning over the file it just
> wrote — and says the game is now showing the built mod's copy, which reaches the jar on the next
> build.

The habits: **read the sheet as text rather than as an image** when you need values, **one screenshot
per batch**, and **clear the override after promoting** so what you are looking at is what the mod
actually has.

## Things to keep in mind

**Your texture will not change.** A forgotten live-pack override is winning. `list_assets` first.
This is the most common problem in this whole area.

**Pass `file`, not `base64`.** For bytes on disk, it is a 40-token call instead of an image in the
conversation.

**One screenshot per batch, not per asset.** And `list_assets` to confirm the files landed, which is
free.

**A Blockbench permission dialog freezes the whole renderer.** Every bridge call times out until a
human clicks it. Silent endpoint, idle-looking app — go and look for a prompt.

**Load the plugins from `<gameDir>/mcptoolkit/blockbench/`.** The plugin beside the extracted server
is that server's plugin, and the pair is one release unit.

**Do not register a separate `blockbench` MCP server.** Two paths to one app pays two prefixes every
turn.

**Pass `PROJECT` and `GAME` explicitly inside an eval.** A project name is refused; a guessed port
pushes into whatever game happens to be on it.

**`mcptoolkitPush` never rejects.** Check `.ok`. Do not try/catch it.

**`target: 'source'` has no default root and never will.** Set it per project, once.

**Clear the override after promoting from Blockbench.** Otherwise the preview keeps shadowing the
real file.

**After editing a plugin file, reload it in place** rather than restarting Blockbench:
`Plugins.all.find(p => p.id === 'mcptoolkit_sync').reload()` through `risky_eval`.

**The push is one-way.** There is no pull from the game back into Blockbench.

## Where to go next

**In this wiki**

- [The change loop](the-change-loop.md) — push, look, promote, in general.
- [Entities](entities.md) — geometry, the verify battery, and standing it up in the world.
- [Rendering and screenshots](rendering-and-screenshots.md) — judging the result properly.
- [Authoring at scale](authoring-at-scale.md) — when it is ninety textures.
- [Tool profiles and cost](tool-profiles-and-cost.md) — the `art` profile, and what a picture costs.

**Reference**

- `LIVE_MODDING.md` § *Blockbench link* — all three plugins, in full.
- `docs/models/BLOCKBENCH_BRIDGE_DESIGN.md` — the bridge plugin: the 26-tool surface, sessions,
  projects, the queue.
- `docs/models/BLOCKBENCH_ISOLATION_DESIGN.md` — windows, claiming, and why the window is the unit
  of ownership.
- `LIVE_MODDING.md` § *The live packs* and § *Promotion*.
