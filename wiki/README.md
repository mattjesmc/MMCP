# The MMCP Wiki

**Modding Minecraft with an agent at the keyboard.** MMCP is one mod jar that opens a small HTTP
bridge inside your running game and registers tools on it, plus an MCP server that hands those tools
to whatever agent you use. The short version of what that buys you: **you stop restarting the game.**
A texture, a recipe, a loot table, a model, a whole GUI screen — you change it and it is in the world
you are standing in, a second later, and the agent can look at the result and tell you whether it
worked.

This wiki is written **for you, the person**. It explains what each kind of modding work looks like
when an agent is doing it with you: what the machinery actually does under the hood, a walkthrough
you can follow start to finish, an example of how a session with an agent really goes, and the traps
that cost us time so they don't cost you any.

---

## On this page

- [Who this is for](#who-this-is-for)
- [If you have ten minutes](#if-you-have-ten-minutes)
- [The map](#the-map)
- [Five things worth knowing first](#five-things-worth-knowing-first)
- [This wiki and the other documentation](#this-wiki-and-the-other-documentation)

---

## Who this is for

Minecraft modders. You know what a `blockstate` file is, you have run `gradlew runClient`, you have
sat there waiting ninety seconds to find out that a texture is four pixels off. You do not need to
know anything about MCP, agents, or how any of this is implemented — the pages explain what they
need as they go.

You do **not** need to use an agent to get value out of the toolkit. Half of what is here — live
asset pushes, structure capture, worldgen previews, the GUI compiler — is useful from a plain
session with a person typing. The agent pages are marked as such.

## If you have ten minutes

1. **[Getting started](getting-started.md)** — install, and get to your first `ping`. Fifteen
   minutes if your JDK is already right.
2. **[How it works](how-it-works.md)** — the bridge, the tools, and the one idea (*mechanism*) that
   makes agent output trustworthy.
3. **[The change loop](the-change-loop.md)** — the daily rhythm: what you changed decides how it
   gets into the game, and only one of the three routes costs you a restart.

That is the whole foundation. Everything else is one subject at a time.

## The map

### Start here

| Page | Read it when |
|---|---|
| [Getting started](getting-started.md) | You have a mod, or want one, and nothing set up yet. |
| [How it works](how-it-works.md) | You want the mental model before you trust it with your source tree. |
| [The change loop](the-change-loop.md) | You are ready to change something and see it. |

### Making things

| Page | Read it when |
|---|---|
| [Blocks and items](blocks-and-items.md) | Starting new content from nothing, and seeing it in the world. |
| [Textures and models](textures-and-models.md) | Iterating on how something *looks*, including live pushes and Blockbench. |
| [Entities](entities.md) | You have geometry and want a creature standing in front of you. |
| [Recipes, loot and tags](data-recipes-loot-tags.md) | Anything that lives in `data/` — and finding out what a table actually drops. |
| [GUI screens](gui-screens.md) | Building a container screen or a menu without fighting widget maths. |
| [Structures and building](structures-and-building.md) | Building in-world, capturing it, and placing it back. |
| [Worldgen](worldgen.md) | Tuning noise and wanting to know if the change landed. |
| [Rendering and screenshots](rendering-and-screenshots.md) | You need a picture — for judgement, for a mod page, for a changelog. |

### Working on a mod

| Page | Read it when |
|---|---|
| [Mod testing](mod-testing.md) | Everything you verified by hand once and never again. **Start here if you have shipped a mod before.** |
| [Debugging](debugging.md) | It crashed, it did not load, it is slow, or that mixin might not have applied. |
| [Authoring at scale](authoring-at-scale.md) | You have ninety of something to make, not one. |
| [Extending the toolkit](extending-the-toolkit.md) | You want tools of your own, or the toolkit to understand your mod's data. |
| [Servers and production](servers-and-production.md) | Dedicated servers, headless suites, NeoForge, or a real launcher install. |

### Reference

| Page | Read it when |
|---|---|
| [Tool profiles and cost](tool-profiles-and-cost.md) | Your sessions feel expensive, or a tool refuses with `profile_hidden`. |
| [Glossary](glossary.md) | A word in here means something specific and you want to check which. |
| [Troubleshooting](troubleshooting.md) | Something is wrong and you want the list of usual suspects. |

## Five things worth knowing first

These come up on every page, so they are said once here.

**1. The bridge is a local door with no lock.** It binds `127.0.0.1` and nothing else, and it is on
automatically in Gradle dev runs. Any process on your machine can drive your game through it. That is
the trust model — there is no permission system behind it, deliberately, because the alternative is a
permission system you would turn off. Do not run a dev game with the bridge on a machine you share
with people you do not trust.

**2. Every answer says how it was obtained.** Each reply carries a `mechanism`. `observe` means the
tool *read* the game and you can believe it. `world_edit`, `embodied` and `privileged` mean it
*acted* — by three different routes, with three different failure modes — and the honest thing to do
after an act is read the world back. `local` means it never touched the game at all. This one field
is why an agent's report of what it did is checkable instead of a story. See
[How it works](how-it-works.md#mechanism).

**3. `ok: true` is not always "it worked".** `run_command` answers `ok: true` for a command that
*parsed*. Minecraft's command system does not report much else. If it matters, read the world
afterwards — which is what mechanism is telling you to do.

**4. The manifest is the truth about tools.** Every table in every document, this wiki included, is a
summary of what the running bridge actually serves. `ping` first; `tool_surface` for the live list.

**5. Your session sees a slice, not everything.** Profiles keep the tool list small because every
tool name is paid for on every single turn. The default is `modding`. A tool the profile hides
refuses with `profile_hidden` and tells you the call that widens it — it is a curtain, not a wall.
See [Tool profiles and cost](tool-profiles-and-cost.md).

## This wiki and the other documentation

There are three bodies of text in this repository and they have different jobs.

- **This wiki** is for humans, organised by *what you are trying to do*. It teaches shape and
  intent, and it links out for exact detail.
- **The three manuals** — `mcp-toolkit/LIVE_MODDING.md` (workflow), `mcp-toolkit/EXTENDING.md`
  (the API for your own tools), `mcp-toolkit/ARCHITECTURE.md` (vocabulary and decisions) — are the
  reference. They are dense on purpose: they are what an agent reads. When a wiki page needs an
  exact parameter or an exact table, it sends you there rather than copying it, because a copy
  goes stale and a link does not.
- **`mcp-toolkit/docs/`** is design records: why a thing is shaped the way it is, what was measured,
  what was tried and abandoned. Read these when you disagree with a decision — the reasoning is
  written down, including the parts that did not work.

Documents cite each other by bare filename with a section number (`LOOP_KIT_DESIGN.md`, section 5).
Every record name is unique across the tree, so search by name, not by path.

**Contributing a page:** [STYLE.md](STYLE.md) has the skeleton every page here follows and why each
part of it exists.
