# Worldgen

The one tier of Minecraft modding with **no reload at all**. `/reload` never looks at `worldgen/`, so
a biome, a noise setting or a density function lands only on a world restart — and then the ground
you are standing on is still the old ground, because it is already on disk.

This page is about the tool that makes iterating on noise bearable, `preview_worldgen`, and about
being honest with yourself regarding what it can and cannot see. That limit is real and it is not a
footnote: **it sees noise, and nothing after noise.**

## On this page

- [Why this is the hard one](#why-this-is-the-hard-one)
- [How it works](#how-it-works)
  - [What it can see, and what it cannot](#what-it-can-see-and-what-it-cannot)
- [Walkthrough: change a density function and see it](#walkthrough-change-a-density-function-and-see-it)
- [Comparing seeds without rebuilding a world](#comparing-seeds-without-rebuilding-a-world)
- [Is the terrain I am standing on stale?](#is-the-terrain-i-am-standing-on-stale)
- [An agent session](#an-agent-session)
- [Things to keep in mind](#things-to-keep-in-mind)
- [Where to go next](#where-to-go-next)

---

## Why this is the hard one

The loop everybody ends up in: edit the noise settings, restart the world, fly ten thousand blocks
out to find ungenerated chunks, look at what came out, form an opinion.

That is slow, and worse, **it is not comparable**. Every iteration is a different landscape in a
different place. You cannot tell whether your change made the terrain better or whether you simply
flew somewhere else.

`preview_worldgen` asks the loaded generator directly, at a coordinate, and **generates nothing** —
no chunk, no ticket, nothing on disk, microseconds. Same coordinate every time, so two runs are
actually comparable.

## How it works

| Ask | Call |
|---|---|
| did my restart actually load my settings | `{center: {x, z}}` → read `generator.noise_settings` and `generator.seed` |
| what shape is the ground over there | `{center: {x, z}, radius: 512, stride: 32}` |
| what is under my feet, layer by layer | `{center: {x, z}, column: true}` |
| what would seed 12345 look like here | `{center: {x, z}, radius: 256, seed: 12345}` |
| is the terrain I am standing on stale | `{center: {x, z}, radius: 64, compare: true}` |
| is my biome even reachable | any call → `generator.possible_biomes` |

The first row is worth doing every single time you restart for a worldgen change, before you look at
anything else. `generator.noise_settings` tells you whether the game actually picked up your edit. A
restart that silently loaded the old settings looks exactly like a change that did nothing.

### What it can see, and what it cannot

This is the whole thing, so read it once properly.

`getBaseHeight` and `getBaseColumn` run the density-function router and the aquifer, **and stop**.
Surface rules, carvers, features and structures all come later, in a `WorldGenRegion` that only real
generation has.

So:

| Edit | Visible here? |
|---|---|
| `noise_settings` | **Yes**, instantly |
| `density_function` | **Yes**, instantly |
| `surface_rule` — what the top blocks actually are | **No** |
| a new carver — caves, ravines | **No** |
| a moved ore, a changed tree count, any feature | **No** |
| a structure | **No** |

Every field in the reply is named `noise_*` for exactly that reason. If you are tuning surface rules
or feature placement, this tool cannot help you and will happily show you an unchanged answer that
you might read as "my change did nothing".

The other side of "it never creates world" is that it will cheerfully describe ground a million
blocks out — and it cannot show you the finished article. That needs the chunks actually generated,
and **the tool for that does not exist**. Regenerating a region is destructive (it deletes chunks
under a live server) and was descoped from release 1 with the traps written down rather than half
built. For real terrain today: walk to ungenerated chunks, or make a new world from the title screen.

## Walkthrough: change a density function and see it

**1. Validate the file before you restart.** Worldgen does not reload, but the codec still answers:

```
push_data {path: "data/mymod/worldgen/density_function/ridges.json", file: "...", dry_run: true}
```

`valid: true` means the game's own codec decodes it. That is worth having before you spend a restart
on it — a malformed density function otherwise costs you a full world boot to discover.

**2. Take a reading of the current terrain, so you have a before.**

```
preview_worldgen {center: {x: 0, z: 0}, radius: 512, stride: 32}
```

**3. Restart the world.** There is no route around this.

**4. Confirm the settings actually loaded.**

```
preview_worldgen {center: {x: 0, z: 0}}
```

Read `generator.noise_settings` and `generator.seed`. If they are not what you expect, stop — nothing
downstream of this means anything.

**5. Take the same reading again** and compare it with your before. Same centre, same radius, same
stride, so the two are genuinely comparable.

**6. Look at a column** where the grid says something interesting:

```
preview_worldgen {center: {x: 120, z: -64}, column: true}
```

## Comparing seeds without rebuilding a world

```
preview_worldgen {center: {x, z}, radius: 256, seed: 12345}
```

**`seed` is the thing a restart cannot do.** A whole independent `RandomState` is built at any seed
from registries already in memory, so comparing seeds is an argument rather than a world rebuild.
That turns "is this terrain good, or did I get a good seed" from a day of work into two calls.

Noise generators only — a flat generator has no noise to reseed, and refuses by name rather than
returning something meaningless.

## Is the terrain I am standing on stale?

```
preview_worldgen {center: {x, z}, radius: 64, compare: true}
```

`compare` is **a distribution, not a verdict**, and reading it as a verdict will mislead you.

The world's `OCEAN_FLOOR` heightmap and the generator's `OCEAN_FLOOR_WG` share a predicate exactly —
but the world's has had surface rules, carvers, features and every hand-placed block applied to it
since it was written. A tree raises it by six.

So: a few blocks of scatter across the grid is **just terrain**. What means "the generator changed
since these chunks were written" is a **large or one-directional** shift across the whole grid. Look
at the shape of the difference, not at whether there is one.

## An agent session

> **You:** I've widened the ridge density function. Did it do anything?

> **Agent** calls `preview_worldgen {center: {x: 0, z: 0}}`
> → `generator.noise_settings: "mymod:amplified_ridges"`, `generator.seed: 8891234`.
>
> The right settings are loaded, so the restart picked the change up.

> **Agent** calls `preview_worldgen {center: {x: 0, z: 0}, radius: 512, stride: 32}` and compares the
> grid with the reading from before the restart.
> → peak heights up by 20–30 across the northern half, roughly flat in the south.

> **You:** the ridges are bare rock though, I wanted grass on them.

> **Agent:** that is a surface rule, and this tool cannot see surface rules — it stops after the
> density router and the aquifer. The height change is real and confirmed; what the top block *is*
> comes later in generation and has to be looked at in a real world.
>
> It offers to check the rule file decodes (`push_data {dry_run: true}`) and to make a fresh world to
> look at, since the chunks here are already written.

The valuable turn there is the last one. The agent **did not pretend the tool answered a question it
cannot**, and it separated the part it had confirmed — the heights moved — from the part it had not.
That distinction is the whole reason the reply fields are named `noise_*`.

## Things to keep in mind

**Noise only.** Surface rules, carvers, features and structures are invisible here. If your edit is
one of those, an unchanged answer means nothing at all.

**`/reload` never looks at `worldgen/`.** There is no fast route. Restart the world.

**Restarting does not change the ground under you.** Existing chunks are on disk and stay as they
were. Walk out, or make a new world.

**Check `generator.noise_settings` after every restart.** A restart that silently loaded the old
settings looks identical to a change that did nothing.

**Same centre, same radius, same stride, or you are not comparing.** The whole value of this tool
over flying around is that two readings are at the same place.

**`compare` is a distribution.** A few blocks of scatter is terrain having had features applied to
it. Read the shape and direction of the shift, not its existence.

**`seed` is noise generators only.** A flat generator refuses by name.

**It never creates world**, which is both the point and the limit. It will describe ground a million
blocks out that nothing has ever generated.

**Validate with `dry_run` even though you cannot reload.** It costs one call and can save a whole
world boot.

## Where to go next

**In this wiki**

- [Recipes, loot and tags](data-recipes-loot-tags.md) — the rest of `data/`, most of which *does*
  reload.
- [The change loop](the-change-loop.md) — where worldgen sits in the routing table.
- [Structures and building](structures-and-building.md) — building on the terrain rather than
  generating it.
- [Mod testing](mod-testing.md) — a fresh world per run, which is what a worldgen check needs.

**Reference**

- `LIVE_MODDING.md` § *What will the WORLDGEN make?* — the tool in full.
- `docs/world/WORLDGEN_ITERATION_DESIGN.md` — phase 1 as built, and §2.2 for the four traps that
  keep region regeneration out of release 1.
- `LIVE_MODDING.md` § *Not in release 1* — the stated absence, and the route that exists today.
