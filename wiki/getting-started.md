# Getting started

From nothing to a running game with a live bridge into it, and an agent that can see it. Three ways
in, depending on whether you are starting a mod, adding this to one you already have, or working on
the toolkit itself. Budget about fifteen minutes if your JDK is already right.

This page gets you to a working `ping`. What to *do* once you are there is
[The change loop](the-change-loop.md); why any of it works the way it does is
[How it works](how-it-works.md).

## On this page

- [Before you start](#before-you-start)
- [Path 1: a new mod](#path-1-a-new-mod)
- [Path 2: a mod you already have](#path-2-a-mod-you-already-have)
- [Path 3: the toolkit itself](#path-3-the-toolkit-itself)
- [Your first ping](#your-first-ping)
- [Walkthrough: a block, from nothing to standing in front of it](#walkthrough-a-block-from-nothing-to-standing-in-front-of-it)
- [An agent session](#an-agent-session)
- [Things to keep in mind](#things-to-keep-in-mind)
- [Where to go next](#where-to-go-next)

---

## Before you start

Two prerequisites, and they are the only two:

- **JDK 25**
- **Node 18 or newer** — the MCP server is a Node process. If you are not using an agent at all, you
  still want Node for the tools that live on that side.

In the game, the jar needs **Fabric Loader 0.19.3+** (or NeoForge) and nothing else. **fabric-api is
not a dependency** — `fabric.mod.json` declares only the loader, Minecraft and Java. It does not mind
fabric-api being present either, which is the situation every consumer mod is in: the two take
different doors into the registries and both are exercised.

**Where the jar comes from.** Release 1 is served from a static Maven repository — a `maven` branch
of the MMCP repository, published through GitHub Pages — plus a GitHub Release of the jar for a
production `mods/` folder. If that branch is not reachable for you yet, both the toolkit and its
Gradle convention plugin resolve from your local Maven: run `gradlew build` once in `mcp-toolkit/`
and once in `gradle-conventions/` from a clone of the repository, and both land in `mavenLocal`.

**A note for people not on Windows.** Everything on this page works except two things that spawn the
game through PowerShell: the `launch_game` tool and `tools/rebuild.ps1`. Run `gradlew runClient`
yourself instead. Everything after `ping` is identical.

## Path 1: a new mod

Copy `template-mod/`. It is a minimal Minecraft 26.2 Fabric mod with one scaffolded block, the
convention plugin applied, and MCP registrations already written for Claude Code, Cursor, Gemini CLI,
VS Code and Codex.

1. Copy the directory (or use it as a GitHub template).
2. Rename `examplemod` in four places: `gradle.properties`, `fabric.mod.json`, `settings.gradle`, and
   the package under `src/main/java`.
3. **Pick a port** in `gradle.properties` (`mcmod.port`) that no other dev game on your machine uses.
   This matters more than it looks — see [the port is a name](#the-port-is-a-name-not-a-setting)
   below.
4. ```
   gradlew toolkitInit -Pclients=all
   ```
   This rewrites the client registrations for your new port, writes `AGENTS.md` (the session charter)
   and `.mcptoolkit/loop.json`, and extracts the MCP server out of the jar into
   `.mcptoolkit/mcp-server`. Run `npm install --omit=dev` in there once.
5. ```
   gradlew runClient
   ```

That is it. The bridge is on your port and on automatically.

## Path 2: a mod you already have

Three edits and one command.

**In `build.gradle`**, after Fabric Loom:

```groovy
id 'com.mattmc.mcmod' version '0.7.0'
```

The `pluginManagement` block in `template-mod/settings.gradle` shows where that resolves from — copy
it across.

**In `gradle.properties`**, set `mcmod.port` to a port no other dev game on the machine uses.

**Then:**

```
gradlew toolkitInit -Pclients=all     # registrations, AGENTS.md, .mcptoolkit/, the MCP server
gradlew runClient                     # the bridge is on your port
```

`toolkitInit` is written to be safe to run against an existing repository: it **writes each file once
and never rewrites yours**. A registration that names the wrong port is corrected, and the correction
is reported rather than done silently. If you want to see what it would do without it doing anything,
`-Ptoolkit.check` reports instead of writing.

The plugin also gives your repository two tasks worth knowing about immediately:

- **`gradlew scaffold`** — writes a block or an item into your source tree, once. Used in the
  walkthrough below.
- **`gradlew checkAssets`** — wired under `check`. Walks your resources tree and fails on dangling
  references, warns on unused assets. Free, needs no game. See [Mod testing](mod-testing.md).

It writes the three Blockbench plugins into `.mcptoolkit/blockbench/` as well; see
[Textures and models](textures-and-models.md) for which to load.

## Path 3: the toolkit itself

If you are working on the toolkit rather than with it:

```
cd mcp-toolkit && ./gradlew runClient      # its own dev client, bridge 25599
```

`mcp-server/` is the MCP server every repository in the workbench registers by absolute path. After a
structural Java change run `tools/rebuild.ps1`. **Never run `gradlew build` or `:jar` while the game
is running** — the game holds the jar open, and the failure is confusing rather than obvious.

## Your first ping

Whatever your path, the first call in any session is `ping`, and it is worth reading rather than
skimming. It tells you:

- **whether a game is there at all**, and whether a world is loaded (`serverRunning`) and a client is
  present (`clientPresent`) — the two facts that decide which tools can answer;
- **which build is answering** (`build`) — the single most valuable field, because a stale JVM will
  answer happily from code you replaced twenty minutes ago;
- **whether the last game crashed** (`last_crash`), so a session that starts after a crash starts
  knowing about it;
- **which tool profile this session has**, so you know what you are allowed to see;
- **which extension mods registered tools**, and any that failed to.

If `ping` cannot reach anything, the bridge is not up: check that the game is actually running, and
that the port your registration names is the port `gradle.properties` declares. `gradlew
toolkitStatus` prints the port the repository believes in.

## Walkthrough: a block, from nothing to standing in front of it

The shortest path that touches every part of the system.

**1. Scaffold it.**

```
gradlew scaffold -Pkind=block -Pid=copper_lantern
```

That writes a `RegisterCopperLantern` class and the nine asset and data files a block needs —
blockstate, block model, item model, texture, loot table, lang entry, and so on. They are yours from
that moment; the scaffolder never touches them again.

**2. Register it.** Add the `register()` call to your mod's initialiser. This is a structural Java
change — a new class — so it needs a restart, not a hotswap. One `rebuild.ps1` (or stop the game,
`gradlew runClient`).

**3. Check it actually registered.**

```
query_registry {registry: "block", entry: "yourmod:copper_lantern"}
```

An id that never registered answers `exists: false` — so you find that out in one call instead of by
flying around looking for a block. A registered one hands back its blockstate `properties` and its
`default_state` **in `set_blocks` syntax**, which you use in the next step.

**4. Put one in front of you.**

```
set_blocks {blocks: [{x: 10, y: 65, z: 10, block: "yourmod:copper_lantern"}]}
```

`block` is the ordinary vanilla block string — an id, an optional `[state]`, optional `{nbt}` — so
`"minecraft:oak_stairs[facing=east,half=top]"` is a legal value here. The reply carries an `undo_id`.

**5. Look at it.**

```
render {look_at: {x: 10, y: 65, z: 10}, inline: true}
```

`render` is not a screenshot: nothing is standing anywhere, the HUD and held item are excluded by
construction, and the resolution is an argument. Give it `look_at` and the camera places itself far
enough back for the subject to fill the frame. `inline` defaults to **false** — the reply is a path
rather than the image, because a full-resolution PNG is the most expensive thing this toolkit can put
in a conversation. Ask for it inline when you actually need to see it.

**6. The texture is a placeholder, so now iterate.** This is the part that changes how modding feels.
Do *not* rebuild. Push the real texture into the live resource pack:

```
push_asset {path: "assets/yourmod/textures/block/copper_lantern.png", file: "C:/art/lantern.png"}
```

Seconds, not a restart. Look again, adjust, push again. When it is right, promote it into your source
tree:

```
clear_assets {path: "assets/yourmod/textures/block/copper_lantern.png",
              promote: "C:/dev/yourmod/src/main/resources"}
```

The promotion copies the file into your resources and *then* removes the override — in that order,
deliberately, because a promotion that deleted first and then failed to copy is the only outcome
worse than not promoting.

That loop — push, look, adjust, promote — is the whole daily rhythm. [The change
loop](the-change-loop.md) covers the other routes.

## An agent session

Setup is the one part of this where an agent is genuinely just a convenience; the value starts at the
turn after. What a first session actually looks like:

> **You:** I've just run `toolkitInit`. Get the game up and add a copper lantern block.

> **Agent** calls `ping` → nothing answers. It runs `launch_game {target: "client"}`, which spawns a
> rebuild cycle detached, then polls `ping` until the bridge answers.
> → `{ env: "development", build: "yourmod 0.1.0", serverRunning: false, clientPresent: true }`
>
> A client is up but no world is loaded, so the server-side tools would refuse. It says so and waits
> for you to open a world, or opens one.

> **Agent** runs `gradlew scaffold -Pkind=block -Pid=copper_lantern`, adds the `register()` call, and
> tells you this needs a restart rather than a hotswap — a new class cannot be redefined into a
> running JVM.

> **Agent** after the rebuild calls `query_registry {registry: "block", entry: "yourmod:copper_lantern"}`
> → registered. Then `set_blocks` and `render`, and hands you the picture.
>
> The lantern is there and untextured, which is what a placeholder looks like and not a bug.

The pattern worth noticing: it **confirmed the registration with a read** before believing the block
existed, and it **named the route** (restart, not hotswap) instead of trying the cheap one and
reporting a confusing failure.

## Things to keep in mind

### The port is a name, not a setting

Your `mcmod.port` identifies your project. Two dev games on one port do not both work — the second
cannot bind, and **the bridge answers from the older JVM without saying so**, which means an agent
happily inspecting a game that is not the one you just built. Pick a port per repository, write it
down in `gradle.properties`, and let `toolkitInit` propagate it everywhere.

### The bridge has no lock

It binds `127.0.0.1` only, and it is on automatically in dev runs. Any process on your machine can
drive your game through it. There is no permission system behind it, deliberately — the alternative
is a permission system you would turn off, which is worse than a stated one. Do not run a dev game
with the bridge on a machine you share with people you do not trust.

### `toolkitInit` will not overwrite your files

It writes once. If you have already hand-edited an `AGENTS.md` or a registration, it leaves them
alone — except for a port that disagrees with your `gradle.properties`, which it corrects and tells
you about. `-Ptoolkit.check` shows you the plan first.

### Never build while the game is running

The game holds the jar. `gradlew build` or `:jar` against a running dev game fails in a way that
looks like something else entirely. Use `tools/rebuild.ps1` for structural changes and
`hotswap_class` for method bodies.

### The MCP server is a file in the jar, not a process in the game

It gets extracted to your project (or your game directory) and your agent client spawns it. That is
why `npm install --omit=dev` is a step, and why the server can answer honestly — with local tools
only — while the game is down. See [How it works](how-it-works.md).

### A production install is a different mode

Everything above is *dev*. Attaching to a normal launcher game is supported and works differently
enough to have its own page: [Servers and production](servers-and-production.md).

## Where to go next

**In this wiki**

- [How it works](how-it-works.md) — the bridge, the shim, mechanism, profiles. Read this second.
- [The change loop](the-change-loop.md) — what you changed decides how it gets into the game.
- [Blocks and items](blocks-and-items.md) — the walkthrough above, properly.
- [Mod testing](mod-testing.md) — `checkAssets` is already wired; this is what to build on it.
- [Troubleshooting](troubleshooting.md) — when `ping` answers nothing, or answers wrong.

**Reference**

- `mcp-toolkit/README.md` — install in full, and the task table that routes to exact sections.
- `template-mod/README.md` — the five steps, from the template's own point of view.
- `EXTENDING.md` § *Quickstart* — applying the convention plugin to an existing build.
- `LIVE_MODDING.md` § *Before a game exists* — `scaffold` and `checkAssets` in detail.
