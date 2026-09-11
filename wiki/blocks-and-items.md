# Blocks and items

The most common thing anybody adds to Minecraft, and the shortest path through the whole system:
scaffold it, register it, confirm the game actually holds it, put one in front of you, and iterate on
how it looks without restarting.

This page covers `scaffold` (what it writes and what stays yours), the registration check that saves
the most time, giving a block behaviour, and the offline check that catches a broken reference before
a game ever loads. Textures get their own page — [Textures and models](textures-and-models.md) — and
so does anything alive: a creature is a different question with its own door.

## On this page

- [How it works](#how-it-works)
  - [What `scaffold` writes, and what stays yours](#what-scaffold-writes-and-what-stays-yours)
- [Walkthrough: a copper lantern](#walkthrough-a-copper-lantern)
- [Giving it behaviour](#giving-it-behaviour)
- [Checking your tree before the game sees it](#checking-your-tree-before-the-game-sees-it)
- [An agent session](#an-agent-session)
- [Things to keep in mind](#things-to-keep-in-mind)
- [Where to go next](#where-to-go-next)

---

## How it works

A block in modern Minecraft is one Java registration and about nine files, most of which exist only
to point at each other: a blockstate naming a model, a model naming a texture, an item definition
naming an item model, a loot table so it drops itself, a tag so the right tool mines it, a lang key
so it has a name. Every one of those is a place a typo produces silence rather than an error.

The toolkit attacks that from two directions. **Before a game exists**, `scaffold` writes the whole
set consistently and `checkAssets` verifies the references resolve. **Once a game is running**,
`query_registry` tells you what it actually holds and `push_asset` lets you iterate on the look
without a restart.

### What `scaffold` writes, and what stays yours

```
gradlew scaffold -Pkind=block -Pid=copper_lantern [-Pbehaviour] [-Pscaffold.name="Copper Lantern"]
```

It is a Gradle task, not a tool — it runs from the toolkit jar in a separate JVM with no Minecraft on
the classpath, so it works before you have ever launched anything.

It writes, in your own idiom: a `RegisterCopperLantern` class in `<root>.registry` (the `Identifier`,
the `ResourceKey`s, `Registry.register` for both the block and its `BlockItem`), a `CopperLanternBlock`
class **only if `-Pbehaviour` asks for one**, the blockstate, the two models, the item definition, a
placeholder texture, the lang key, the loot table, and the `mineable/pickaxe` tag entry. The mod id
and root package come from your `fabric.mod.json`.

**It runs once and never regenerates.** A file that already exists is left exactly as it is, a second
run on the same id is refused, and the two files it *merges* into — the lang file and the tag — keep
every byte they had. There is no machine-owned region, no "do not edit below this line": ownership is
yours from the first write. That is the whole difference between this and an editor that owns your
source tree.

What it deliberately leaves for you, and tells you about in its output:

- **the `register()` call** in your mod initialiser — because that is your file and your ordering;
- **the creative tab line**, which it leaves as a comment, because the tab hook belongs to the loader
  rather than to the toolkit;
- **the real texture**, since what it wrote is a placeholder.

`-Pkind` is `block` or `item`, and only those two.

## Walkthrough: a copper lantern

**1. Scaffold.**

```
gradlew scaffold -Pkind=block -Pid=copper_lantern -Pscaffold.name="Copper Lantern"
```

Read the file list it prints. It ends with the next few calls verbatim, which is worth following the
first time.

**2. Add the `register()` call** to your initialiser.

**3. Restart.** A registration is structural — `hotswap_class` will refuse it, correctly. One
`tools/rebuild.ps1`, or `launch_game {target: "client"}` from a session.

**4. Confirm the game holds it.** This is the step people skip and should not:

```
query_registry {registry: "block", entry: "yourmod:copper_lantern"}
```

An id that never registered answers `exists: false`. A registered one hands back its blockstate
`properties` — every legal value, per property — and its `default_state` **written in `set_blocks`
syntax**, so the read round-trips straight into a write.

**5. Place one.**

```
set_blocks {blocks: [{x: 10, y: 65, z: 10, block: "yourmod:copper_lantern"}]}
```

**6. Look at it.**

```
render {look_at: {x: 10, y: 65, z: 10}, inline: true}
```

**7. Does it drop itself?**

```
roll_loot {block: "yourmod:copper_lantern"}
```

The scaffolded loot table drops the block. Once you change it, this is how you check — and with
`count`, how you check a *rate*. See [Recipes, loot and tags](data-recipes-loot-tags.md).

**8. Iterate on the texture without restarting.** `push_asset`, look, adjust, and `clear_assets
{promote}` when it is right. That loop is [The change loop](the-change-loop.md).

## Giving it behaviour

`-Pbehaviour` writes a `<Id>Block` class extending the vanilla one, wired into the registration for
you. From there it is ordinary Fabric modding — and this is where the live loop changes how it feels:

**A method body is a hotswap.** Change what `useWithoutItem` does, `gradlew compileJava`,
`hotswap_class`, and it is live in the running game in seconds. You can iterate on behaviour the way
you iterate on a texture.

**Anything structural is a restart.** A new field, a new method, a changed constructor call, a new
block property — all of it. Light level, hardness, sound group and friction are set at construction,
so changing them is a rebuild, not a swap.

**Check before you swap:** `query_class {class: "com.example.mymod.CopperLanternBlock"}` reports
whether that class may be redefined at all, one call before `hotswap_class` would find out. It is
also the tool that answers "did my mixin actually apply", because it reflects over the *loaded*
class rather than reading your source.

While you are iterating, `get_log {logger: "yourmod", level: "all"}` reads your own log lines back out
of the running game — the toolkit attaches an appender at its own mod init, so anything you log is
already in it, with no file tail.

## Checking your tree before the game sees it

```
gradlew checkAssets            # also runs under `check`
```

It finds, from the files alone, exactly the class of bug that otherwise shows up as the game loading
your file and silently skipping it: a blockstate naming a model that is not there, a model naming a
missing texture, an item definition naming a missing model, a loot table or tag naming an id nothing
defines, a block with no lang key.

Three buckets, and the split is deliberate:

- **dangling** — fails the build. A reference that goes nowhere is a bug.
- **unused** — warns. A texture no model names might be work in progress, and a warning that fails
  the build makes every feature branch red.
- **unchecked** — counted, never silently passed. `minecraft:` references resolve against the Loom
  merged jar when the plugin can find one; when it cannot, they are *counted* rather than assumed
  fine. Another mod's namespace is always counted.

The relationship to the live tools in one line: **`get_log` finds what the game loaded and skipped;
`checkAssets` finds the same class of thing before a game exists.** Same layout, two loaders.

Its last output line is a JSON object (`text`, `problems`, `notes`), which is exactly what a loop
file's `checks[].run` consumes — so the same check can run automatically after every editing call.
See [Mod testing](mod-testing.md).

## An agent session

> **You:** add a copper lantern block, light level 12, drops itself.

> **Agent** runs `gradlew scaffold -Pkind=block -Pid=copper_lantern -Pbehaviour`, reads the file
> list, adds the `register()` call to your initialiser and sets the light level on the block
> settings.
>
> It says up front that this needs a restart rather than a hotswap, because a new class and a
> registration are both structural.

> **Agent** calls `launch_game {target: "client"}`, polls `ping` until the bridge answers, and
> checks the build stamp is the new one.

> **Agent** calls `query_registry {registry: "block", entry: "yourmod:copper_lantern"}`
> → `exists: true`, and the reply carries `properties` and a `default_state`.
>
> Then `set_blocks` using that `default_state` verbatim, and `render {look_at: ..., inline: true}`.

> **Agent:** it is placed and lit. The texture is the scaffolded placeholder — the magenta-and-black
> one. Do you want to push a real texture now, or leave it?

> **You:** what's it actually dropping?

> **Agent** calls `roll_loot {block: "yourmod:copper_lantern", count: 100}`
> → `share: 1.0` for the block itself. It drops itself, every time.

The thing to notice is that **nothing was believed without a read**. The registration was confirmed
rather than assumed, the placement used the game's own `default_state` string rather than one the
agent composed, and the drop was rolled rather than reasoned about from the loot JSON.

## Things to keep in mind

**A registration is structural.** `hotswap_class` will refuse it, and that refusal is correct. New
class, new field, new registration, changed constructor arguments — all restarts.

**Block settings are set at construction.** Light level, hardness, sound, friction. Changing one is a
rebuild even though it looks like a one-character edit.

**Confirm with `query_registry` before hunting in the world.** An `exists: false` in one call beats
ten minutes of flying around. And an unknown *registry* still refuses — that is a typo in the
question, not an answer.

**`scaffold` refuses a second run on the same id.** By design. It never regenerates and never
overwrites; if you want it to write again, delete what it wrote.

**Your texture will not change.** Almost always a forgotten live-pack override still winning over
your source tree. `list_assets` first. See [The change loop](the-change-loop.md).

**A green reload is not a loaded file.** Vanilla logs and steps over malformed JSON. `get_log` is the
only place that fact exists.

**`checkAssets` warnings are not failures, on purpose.** If unused assets failed the build, every
work-in-progress branch would be red and people would stop running it.

**A creature is not a block with legs.** Entities have their own route, through Blockbench and
`stage_entity` — `scaffold` will not help you. See [Entities](entities.md).

## Where to go next

**In this wiki**

- [The change loop](the-change-loop.md) — the push/promote rhythm the texture step belongs to.
- [Textures and models](textures-and-models.md) — making it look right.
- [Recipes, loot and tags](data-recipes-loot-tags.md) — crafting it, dropping it, tagging it.
- [Debugging](debugging.md) — `query_class`, `get_log`, and why a mixin might not have applied.
- [Mod testing](mod-testing.md) — turning `checkAssets` into the first tier of a real gate.

**Reference**

- `LIVE_MODDING.md` § *Before a game exists* — `scaffold` and `checkAssets` in full.
- `LIVE_MODDING.md` § *What is registered, and what it turned into* — everything `query_registry`
  answers.
- `LIVE_MODDING.md` § *hotswap_class* and § *What a class ACTUALLY is* — the swap limits and the
  precheck.
