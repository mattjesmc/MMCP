# Extending the toolkit

Registering **your own tools** on the bridge, so an agent working on your mod can ask your mod's own
questions — and teaching the toolkit about your modded content so the built-in tools handle it
correctly.

Two separate things, and most mods only need the second. Modded data recognition is largely free:
anything keyed by identity already works, and two tags cover the rest. Custom tools are for when your
mod has a question no generic tool can ask.

## On this page

- [Do you actually need a tool?](#do-you-actually-need-a-tool)
- [Modded data recognition](#modded-data-recognition)
- [Registering your own tools](#registering-your-own-tools)
  - [The contract](#the-contract)
  - [Naming](#naming)
- [Walkthrough: one tool, end to end](#walkthrough-one-tool-end-to-end)
- [Asking a human to look at something](#asking-a-human-to-look-at-something)
- [Building an editor on the toolkit](#building-an-editor-on-the-toolkit)
- [Testing your extension](#testing-your-extension)
- [An agent session](#an-agent-session)
- [Things to keep in mind](#things-to-keep-in-mind)
- [Where to go next](#where-to-go-next)

---

## Do you actually need a tool?

Start with **`run_command`**. Your mod almost certainly has commands, they cross the mod boundary
already, and a command costs nothing in the manifest.

A tool entry is paid for **on every turn of every session**, whether or not it is ever called — the
schema sits in the context window. So the order to work in is: `run_command` first, a tool entry
last, and only when the question is asked often enough to earn its rent.

Good reasons for a real tool: the answer is structured and a command would return prose; the call
needs a schema an agent can read; it is something a session does dozens of times per unit.

## Modded data recognition

**Anything keyed by identity already works.** The toolkit reads the live registries, so
`query_registry` lists your blocks, items, entities, biomes and POIs, and `locate` resolves your ids
and `#tags` against the structure, POI, entity, biome and block indexes.

`query_registry {registry: "block", entry: "yourmod:thing"}` returns the blockstate properties, the
default state, and **the tags your datapack put it in** — which is how you check that a tag join
actually took effect rather than assuming it did.

Most affordances are read off the `BlockState` itself (`solid`, `pass`, `repl`, `tool`,
`unbreakable`), and hostility comes from `MobCategory`. All correct for modded content with no work
from you. Items that block attacks are detected by the `BLOCKS_ATTACKS` data component, so a modded
shield needs no tag at all.

**Two things the game does not expose behaviourally**, so join these if they apply:

| Tag | What it changes |
|---|---|
| `#mcptoolkit:contact_hazards` | Your block reads as `hazard` in every perception payload, and the pathfinder prices it as damaging so routes avoid it |
| `#mcptoolkit:crafting_stations` | `bot_craft` will look for your block as a 3×3 crafting station |

**The crafting tag covers the 3×3 bench only, and that is a stopping point rather than an oversight.**
`bot_craft` also runs smithing and stonecutting recipes, but finds those stations by vanilla block
identity, because the rule being borrowed is vanilla's own `isValidBlock`. A modded smithing table is
therefore **not** findable today. If you need that, it becomes a second tag rather than a guess — say
so.

These tags **add to** a built-in vanilla floor rather than defining it, so the toolkit's
classification of vanilla blocks never depends on a datapack loading.

One thing worth knowing: a mod's own `data/` directory is loaded as a datapack only when
`fabric-resource-loader` (part of fabric-api) is present. The toolkit itself is loader-only, which is
exactly why its vanilla floor lives in Java rather than in a datapack.

## Registering your own tools

**1. Depend on the toolkit**, `compileOnly`:

```groovy
repositories {
    // This group ONLY. An unfiltered mavenLocal() lets a stale local copy of any dependency
    // shadow the real one, which is a quiet way to build against the wrong thing.
    mavenLocal { content { includeGroup 'com.mattmc.mcptoolkit' } }
}
dependencies {
    compileOnly "com.mattmc.mcptoolkit:mcp-toolkit:${project.mcptoolkit_version}"
}
```

Keep the version in `gradle.properties` as `mcptoolkit_version`, never inline — upgrading is then one
number in one place. **Do not depend on the toolkit's `build/libs/` by path**: that couples you to
another project's build output.

`compileOnly`, not `implementation`, because **your mod must run fine without the toolkit
installed**. The exception is a workspace sibling that wants the bridge live in its own `runClient`,
where `implementation` also puts the toolkit on the dev runtime classpath.

Since Gradle has no "resolve only if present", an optional dependency has to be *probed for* before it
is declared — check for the jar in the local repository and guard both the dependency and any
source-set exclusion on the result. **Make the miss loud** (`logger.warn`, naming the version you
wanted and the versions actually installed): a silent skip turns a forgotten publish into a mod that
quietly lost a feature rather than into an error.

**2. Declare your extension.** One resource file:

```
src/main/resources/META-INF/services/com.mattmc.mcptoolkit.McpToolkitEntrypoint
```
```
com.example.mymod.mcp.MyModTools
```

That is `ServiceLoader`'s file and grammar, but the toolkit reads it itself rather than calling
`ServiceLoader` — so it needs no module or `usesServices` declaration.

Keep the toolkit optional in your metadata: `"suggests": {"mcptoolkit": "*"}` on Fabric, a
`type = "optional"` dependency on NeoForge.

### The contract

Registering a tool is a promise about how it behaves. These are binding.

**Declare the real `Mechanism`.** `OBSERVE` reads and mutates nothing. `EMBODIED` is a body performing
a game-mediated act that can fail on the game's own terms. `WORLD_EDIT` is a direct server edit.
`PRIVILEGED` is authority beyond world blocks — commands, disk writes, reloads. It is stamped into
the manifest and every result, so a session can reason about what it just authorised. **An untagged
world-edit masquerading as a read is the specific bug this field exists to prevent.**

**Pick the right `ExecutionContext`.** `SERVER` runs on the server thread and requires a loaded world.
`CLIENT` runs on the render thread and never exists on a dedicated server. `ANY` runs on the HTTP
thread and **must not touch game state**. The bridge marshals for you and reports a clean error when
the loop is not available.

**Async handlers must not block the target thread.** Use `ToolDef.async` when a result can only be
produced later — a render frame, an action completing over ticks — and complete the future then.
Blocking the game thread waiting for the game thread deadlocks the game.

**Report what actually happened.** A tool that returns success because it *issued* an action rather
than because the action *worked* is the failure class this toolkit spent an entire release removing.
Verify the effect, return an honest reason when it did not happen, and **say "unknown" rather than
guessing** — a confident wrong answer is worse than no answer.

**You are the schema authority.** Your `inputSchema` is forwarded to the client verbatim. Write the
description for a reader who cannot see your code: what it does, what it returns, and what the failure
reasons mean.

**Register definitions, not resolved objects.** `registerTools` runs during the toolkit's init: other
mods' registries may not be populated and no world is loaded. Resolve blocks, items and levels *inside
the handler*, when it is called.

### Naming

The tool namespace is flat and shared with the builtins and every other extension. **Prefix your tool
names with your mod id** — `mymod_reactor_status`. A name already taken is skipped, not thrown, and
recorded as a registration failure for your mod.

## Walkthrough: one tool, end to end

1. **Add the `compileOnly` dependency** and the probe that makes it optional.
2. **Write the service file** naming your entrypoint class.
3. **Implement `registerTools`**, declaring mechanism and context honestly, resolving nothing at
   registration time.
4. **Rebuild** — a registration is structural.
5. **Check it landed:** `ping`'s `extensions` array lists each extension mod, the tools it registered,
   and any failures (a throw, or a name collision). **If your tool is missing from the manifest, look
   there first** — that is where a silently-skipped registration is recorded.
6. **Call it.** Manifest entries from an extension carry `"source": "<your mod id>"`; toolkit-owned
   tools carry no `source` key.

## Asking a human to look at something

Some claims only a person can settle. `review_post` files an ask, `review_status` reads answers from
any later session, and `/mmcp review` in game walks a person through the queue.

Your mod can also **declare** its subjects from its own enums, so the list cannot drift from the code.
Staging is **a list of server commands and nothing else** — that is what lets the toolkit own the walk
while your mod owns the content, and it means the queue file is as trusted as the console.

Two rules that shape how you write an ask. **An ask with no failure mode is refused**, in the record's
constructor: a step that cannot fail collects a nod instead of a judgement. And **a machine-answerable
ask never reaches a human** — an ask can carry a `check` command whose success closes it as `checked`,
never as `ok`, because "the world satisfies this" and "a person looked and was happy" are different
facts.

A verdict **gates nothing**, deliberately. See [Mod testing](mod-testing.md).

## Building an editor on the toolkit

If you are building an authoring tool for your mod's content, four conventions come from the one that
was actually built and then moved out of this repository:

- **The mod generates the vocabulary and the panel hardcodes none.** Otherwise your editor and your
  mod disagree the first time you add a category.
- **Derived facts are measured through the mod**, not re-derived in the editor. Two implementations
  drift.
- **Gradle is never a tool's inner loop.** It is far too slow, and it cannot run while the game holds
  the jar anyway.
- **The datapack format is the file format.** Do not invent an intermediate one.
- **Headless APIs never reject** — return `{ok: false, error}` so a caller needs no try/catch.

## Testing your extension

`ping` is the first diagnostic — its `extensions` array is where a silently-skipped registration is
recorded.

**`get_log` is the second, and it needs nothing from you.** The toolkit attaches an appender to the
root logger at its own mod init, so whatever your mod logs is already in it: `get_log {logger:
"yourmod", level: "all"}` reads your own SLF4J calls back out of a running game with no file tail.
`logger` is a substring match on the logger's name.

For probes, `mcp-server/probes/extension.test.mjs` is the pattern: hit the bridge's `/cmd` directly
with an `X-MCPTK-Session` header, and skip cleanly when the bridge is down. See
[Mod testing](mod-testing.md).

## An agent session

> **You:** add a tool that reports my reactor's state.

> **Agent:** before writing one — does the reactor have a command? A tool entry is paid on every turn
> of every session whether it is called or not, and `run_command` costs nothing.

> **You:** there's `/reactor status` but it prints prose.

> **Agent:** then a tool earns its place, because the answer wants structure. Writing it as `OBSERVE`
> and `SERVER`: it reads state and needs a loaded world.
>
> It writes the entrypoint, the service file and the `compileOnly` dependency with the availability
> probe, and rebuilds — a registration is structural.

> **Agent** calls `ping`
> → `extensions: [{mod: "mymod", tools: ["mymod_reactor_status"], failures: []}]`
>
> Registered cleanly. If it had collided with an existing name it would have been skipped and recorded
> here rather than thrown.

> **Agent** calls `mymod_reactor_status {}` → the structured state, stamped `mechanism: observe` and
> `source: "mymod"`.

The two habits: **it pushed back on building a tool at all** until the cost was justified, and it
**confirmed the registration through `ping`'s extensions array** rather than assuming a successful
build meant a registered tool.

## Things to keep in mind

**`run_command` first, a tool entry last.** Every manifest entry is rent paid every turn.

**Declare the real mechanism.** An untagged world edit that looks like a read is exactly the bug the
field exists to prevent.

**Resolve nothing at registration time.** Registries may not be populated and no world is loaded.

**Prefix your tool names with your mod id.** A collision is skipped silently and recorded in `ping`.

**`compileOnly`, and probe for it.** Your mod must run without the toolkit — and make the miss loud.

**Never depend on `build/libs/` by path.**

**Filter `mavenLocal()` to the toolkit's group.** An unfiltered one lets a stale local copy of
anything shadow the real dependency.

**Say "unknown" rather than guessing.** A confident wrong answer is the worst possible reply.

**An `ANY` tool must not touch game state.** It runs on the HTTP thread.

**Never block the game thread waiting for the game thread.**

**An ask with no failure mode is refused.** By design, in the constructor.

**A modded smithing table is not findable by `bot_craft` today.** The tag covers the 3×3 bench only.

## Where to go next

**In this wiki**

- [Mod testing](mod-testing.md) — probes, the review queue, and `ping`'s extensions array.
- [Tool profiles and cost](tool-profiles-and-cost.md) — what an entry costs per turn.
- [How it works](how-it-works.md) — mechanism and execution context, in context.
- [Servers and production](servers-and-production.md) — where a `CLIENT` tool simply is not there.

**Reference**

- `EXTENDING.md` — the whole thing: Quickstart, The contract, Naming, Modded data recognition,
  Asking a human, Building an editor, Testing your extension.
- `docs/platform/EXTENSION_DESIGN.md` — the seam's design.
- `ARCHITECTURE.md` § *The review layer* — the reasoning behind the human queue.
- `ARCHITECTURE.md` § *Action: mechanisms, never conflated*.
