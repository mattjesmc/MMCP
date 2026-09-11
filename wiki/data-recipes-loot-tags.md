# Recipes, loot and tags

Everything that lives in `data/` — recipes, loot tables, tags, advancements, functions, predicates,
item modifiers — and the three separate questions you have to be able to answer about each one: do
these bytes decode, did the game accept them, and what does the thing actually *do*.

That third question is the one no amount of reading JSON will answer, and it is where `roll_loot`
earns its place. This page also covers the tag trap that has cost more time than any other single
thing in this area.

## On this page

- [How it works](#how-it-works)
  - [Three questions, three tools](#three-questions-three-tools)
- [Walkthrough: a recipe and a loot table](#walkthrough-a-recipe-and-a-loot-table)
- [What does it actually drop?](#what-does-it-actually-drop)
- [Tags, and the empty-list trap](#tags-and-the-empty-list-trap)
- [What does not reload](#what-does-not-reload)
- [An agent session](#an-agent-session)
- [Things to keep in mind](#things-to-keep-in-mind)
- [Where to go next](#where-to-go-next)

---

## How it works

Server data reaches a running game through the toolkit's **live datapack**, a plain folder at
`<world>/datapacks/mcptoolkit_data` that is force-enabled and added last, so it sits on top of your
mod and vanilla.

```
push_data / reload_data / list_data / clear_data
```

Push a file, reload, and the game is holding it seconds later. Push several with `reload: false` and
reload once at the end — the reload is the expensive half, the write is not. If the bytes are already
on disk, pass `file` (an absolute path the game reads itself) rather than `base64`; that is a ~40-token
call instead of a blob through the conversation.

And because the pack is a folder that persists across restarts, the usual warning applies: **an
override keeps winning until you clear it.** When a recipe "will not change" no matter what you do to
your source tree, check `list_data` for something you pushed last week.

### Three questions, three tools

These are genuinely different questions and it is worth keeping them apart, because a pass on one
says nothing about the others.

| Question | Tool | What a pass means |
|---|---|---|
| **Do these bytes decode?** | `push_data {dry_run: true}` | The game's own codec accepts them. Not "it is in the game". |
| **Did the game accept it on load?** | `get_log` | You can see what the game logged — including what it *skipped*. |
| **Is it held right now?** | `query_registry {entry}` | The registry has it. |
| **What does it do?** | `roll_loot` | It rolled the real table, in this game, this many times. |

**The dry run is the cheapest check you have.** `push_data {dry_run: true}` runs your file through
the game's own loader codec and reports whether it decodes, without writing anything. `valid: true`
means "these bytes decode here" — not that anything they *reference* exists.

That distinction is where most confusion lives. A recipe whose ingredient id is misspelled decodes
perfectly and then does not load. The dry run passes, the reload succeeds, and the recipe is not in
the game. Only `get_log` shows you the skip.

## Walkthrough: a recipe and a loot table

**1. Validate before you push.**

```
push_data {path: "data/mymod/recipe/copper_lantern.json", file: "C:/dev/.../copper_lantern.json",
           dry_run: true}
```

**2. Push it for real.**

```
push_data {path: "data/mymod/recipe/copper_lantern.json", file: "C:/dev/.../copper_lantern.json"}
```

**3. Did it load?**

```
query_registry {registry: "recipe", entry: "mymod:copper_lantern"}
```

`registry: "recipe"` reaches the `RecipeManager`, which is not in `registryAccess()` at all — listing
it shows every recipe the server loaded, and `entry` adds the `recipe_type` and the recipe itself.

If it answers `exists: false` after a successful push and reload, go to the log:

```
get_log {logger: "minecraft", level: "all"}
```

That is where the skip line is. Nothing else in the game will tell you.

**4. Same shape for a loot table.**

```
push_data {path: "data/mymod/loot_table/blocks/copper_lantern.json", file: "..."}
query_registry {registry: "loot_table", entry: "mymod:blocks/copper_lantern"}
roll_loot      {table: "mymod:blocks/copper_lantern", count: 1000}
```

## What does it actually drop?

`push_data` checks the bytes, the log checks the load, `query_registry` checks it is held — and none
of them can tell you what the table **produces**. `roll_loot` asks the running game to roll it.

| Ask | Call |
|---|---|
| what does my block drop | `{block: "yourmod:ore"}` |
| …with Fortune III | `{block: "yourmod:ore", tool: "minecraft:diamond_pickaxe[minecraft:enchantments={'minecraft:fortune':3}]"}` |
| is my rare drop rare enough | `{table: "yourmod:chests/vault", count: 2000}` |
| what does this mob drop | `{entity: "yourmod:beast", count: 500, killer: "player"}` |
| what does the block I am looking at drop | `{at: {x, y, z}}` |

**`count` is the point of it.** One roll cannot answer "is this drop rate right". The aggregate
carries, per item, `share` (the fraction of rolls that produced it), `avg` (per roll, counting the
empty ones), `min`/`max`, plus `empty_rolls` and `distinct`. `seed` makes a run reproducible, and its
*first* roll is exactly what the game rolls for that loot-table seed.

Four behaviours worth knowing:

- **An unknown table answers `exists: false` and rolls nothing.** The game's own `getLootTable`
  returns an *empty table* for an id that does not exist, which would otherwise report your typo as
  "drops nothing". Check `exists` before you read the numbers.
- **A table asked in the wrong context is refused by name.** Every table declares its own parameter
  set, so `{table: "minecraft:entities/zombie"}` cannot be rolled from an id alone — the refusal names
  `this_entity` and the `entity` argument that supplies it, rather than handing back an empty roll you
  would read as a broken table. `supplied` and `param_set` are in every successful reply too.
- **It changes nothing, including the world's randomness.** Tables that declare a `random_sequence`
  draw from persistent saved data; this tool always passes its own `RandomSource`, so looking at a
  table never consumes the sequence the world will use later.
- **Why not `/loot`?** It exists and it is blind three ways: results go into an inventory rather than
  back to you, it rolls once, and `run_command` answers `ok: true` for a command that failed.

## Tags, and the empty-list trap

Tags have a failure mode that looks exactly like success, and it is worth its own section.

`Registry.get(TagKey)` returns empty **both** for a tag that loaded and matched nothing, **and** for a
tag whose file never loaded at all. An empty `ids` list alone reads as the first when you are almost
always in the second.

So `query_registry` reports **`tag_exists` separately, and that is the field to read.**

```
query_registry {registry: "item", tag: "c:ores"}          # what is in this tag
query_registry {registry: "block", tags: true, contains: "mineable"}   # what tags exist at all
```

Read `tag_exists` first, then `ids`. If `tag_exists` is false, your tag file did not load — go to
`get_log`. If it is true and `ids` is empty, your tag loaded and genuinely matches nothing, which is
a different bug in a different file.

## What does not reload

Two things in `data/` are not reloadable, and both fail quietly if you do not know:

**Dynamic registries** — a mod's own registered-synced registry. `/reload` reports success and
changes **nothing**: `reloadResources` passes the registries through untouched. You will get a green
message and an unchanged game. **Leave the world and re-enter it.**

**Worldgen** — `/reload` never looks at `worldgen/` at all. A biome, a noise setting or a density
function lands only on a world restart, and even then the ground you are standing on is the old
ground, because it is already on disk. `push_data {dry_run: true}` still validates these, which is
worth doing, and `preview_worldgen` answers "did my change land" without generating anything. See
[Worldgen](worldgen.md).

**One thing that is *not* a trap, despite the folklore:** a datapack folder created after the world
loaded. It was reported that the first `pack.mcmeta` classification sticks and such a pack stays
invisible. Measured on 26.2: it does not — a valid pack dropped into `saves/<world>/datapacks/` is
detected and auto-enabled by the next `/reload`, and so is one whose `pack.mcmeta` was broken and
later fixed. What a release gate wants anyway is a **fresh world with the pack on its first load**,
which is `create_world {datapacks: [<path>]}` on a client.

## An agent session

> **You:** the lantern recipe isn't showing up in the recipe book.

> **Agent** calls `query_registry {registry: "recipe", entry: "mymod:copper_lantern"}`
> → `exists: false`.
>
> So it is not a recipe book problem — the game does not have the recipe at all.

> **Agent** calls `push_data {path: "data/mymod/recipe/copper_lantern.json", file: "...",
> dry_run: true}`
> → `valid: true`. The bytes decode.
>
> Which narrows it: well-formed, and rejected on load. That is a reference, not a syntax error.

> **Agent** calls `get_log {logger: "minecraft", level: "all"}`
> → `Skipping recipe mymod:copper_lantern: unknown item mymod:copper_ingot`

> **Agent:** the ingredient id is `mymod:copper_ingot` and nothing defines it — your ingot is
> registered as `mymod:copper_bar`. The recipe decodes fine, which is why the dry run passed; it just
> points at nothing.

Three calls, and each one eliminated a whole class of cause. The shape to steal: **`query_registry`
to find out whether the game has it, `dry_run` to separate malformed from unresolvable, `get_log` for
the actual reason.** Reading the JSON would not have found this, because the JSON is correct.

## Things to keep in mind

**A green reload is not a loaded file.** Vanilla logs and steps over malformed data and carries on.
This is the single most expensive thing to not know in this area.

**`valid: true` from a dry run means the bytes decode.** It does not mean anything they reference
exists. A misspelled ingredient decodes perfectly.

**Read `tag_exists`, not the empty list.** An empty tag and a tag that never loaded look identical
otherwise.

**Check `exists` before reading loot numbers.** An unknown table rolls nothing rather than refusing,
so a typo reports as "drops nothing".

**Assert shares, not presence.** "The item appeared" passes with your whole system disabled if the
item appears anywhere for any reason. `count` in the thousands with a fixed `seed`, then read
`share`. This is the most common way a green mod test is testing nothing — see
[Mod testing](mod-testing.md).

**`/reload` does nothing for dynamic registries** and never looks at worldgen. Leave the world and
come back for the first; restart for the second.

**An override outlives your session.** `list_data` when something will not change.

**Batch the pushes, reload once.** `reload: false` on each, then one `reload_data`.

**`run_command "/loot"` cannot answer this.** One roll, into an inventory, with `ok: true` reported
for a command that failed.

## Where to go next

**In this wiki**

- [The change loop](the-change-loop.md) — the push/validate/confirm rhythm, and promotion.
- [Blocks and items](blocks-and-items.md) — where the scaffolded loot table and tag come from.
- [Worldgen](worldgen.md) — the part of `data/` that does not reload at all.
- [Debugging](debugging.md) — the log channel in full.
- [Mod testing](mod-testing.md) — turning these checks into a suite that runs on its own.

**Reference**

- `LIVE_MODDING.md` § *The live packs* — pack semantics and the push tools.
- `LIVE_MODDING.md` § *Will it load?* — codec validation on `push_data`.
- `LIVE_MODDING.md` § *Did it actually load?* — the log channel.
- `LIVE_MODDING.md` § *What does it DROP?* — `roll_loot` in full.
- `LIVE_MODDING.md` § *What is registered, and what it turned into* — `query_registry`, including
  `tag_exists` and the recipe manager.
