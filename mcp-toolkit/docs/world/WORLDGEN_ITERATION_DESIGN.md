# Worldgen iteration — the loop that is "fly ten thousand blocks away"

**What this file is.** The scoping `RELEASE_1.md` §D4 asks for, written 2026-08-27 against the
decompiled 26.2 source rather than against memory. §D4 is the last open §D item and it calls itself
"the hardest item in §D"; this file says why, splits it into three phases that can land separately,
and names what each one can and cannot see.

---

## 1. The loop today, stated exactly

A worldgen modder edits `worldgen/noise_settings/*.json`, `worldgen/biome/*.json`,
`worldgen/density_function/*.json`, a surface rule or a feature list, and then:

1. **`push_data` writes the bytes.** Since 0.100.0 the reply carries `validation` — the game's own
   codec has decoded them, so a typo is caught before anything else happens (§E1).
2. **A reload does nothing.** Worldgen registries are read **once**, into the frozen
   `RegistryAccess` a `ServerLevel` is built from. `/reload` re-reads recipes, loot, advancements,
   tags and functions; it never looks at `worldgen/`. The 0.100.0 build record already carries this
   as the reason the codec pre-flight had to exist at all: *a reload logs nothing about worldgen
   because it never looks.*
3. **So: restart the world.** ~30–60 s, and the agent's bridge session dies with it.
4. **And then the terrain you are standing on is still the old terrain**, because it is already on
   disk. So: fly ten thousand blocks, generate virgin chunks, and look at *different terrain*.

Step 4 is the part that makes the loop bad rather than merely slow. **The iterations are not
comparable.** Two runs of a noise change produce two different landscapes at two different places,
and the modder is left eyeballing whether the second one is "more" of what they wanted. Every real
worldgen workflow outside Minecraft — a shader, a procedural texture, a terrain tool — is built on
*the same view, re-evaluated*. This one has no such view.

There is a second cost §D4 names in passing: **generating a virgin chunk is expensive.**
`ReadSupport` measured it on this project's dev world — ~12–16 ms to page an existing chunk in,
**~900 ms** to generate a virgin one, because taking one chunk to `FULL` drags its neighbours
through the generation pyramid out to `ChunkStatus.MAX_STRUCTURE_DISTANCE` (8). Flying ten thousand
blocks is not a free scroll; it is minutes of generation.

---

## 2. What the running game will actually answer, and what it will not

Three doors, and they are not equally open. Everything below is a public method on a live
`ServerLevel`'s chunk source unless it says otherwise.

### 2.1 Door 1 — ask the generator, generate nothing (open, cheap, partial)

`ServerChunkCache` exposes `getGenerator()`, `randomState()` and `getGeneratorState()`. On the
generator:

- `getBaseHeight(x, z, Heightmap.Types, LevelHeightAccessor, RandomState)`
- `getBaseColumn(x, z, LevelHeightAccessor, RandomState)` → a `NoiseColumn` of `BlockState`
- `getBiomeSource().getNoiseBiome(qx, qy, qz, randomState.sampler())`
- `getSeaLevel()`, `getMinY()`, `getGenDepth()`
- `NoiseBasedChunkGenerator.generatorSettings()` → the `Holder<NoiseGeneratorSettings>`, hence the
  **id** of the noise settings actually in force

These are the same calls vanilla itself uses to place structures and find a spawn point. They run in
**microseconds** and touch no chunk, no ticket and no disk.

**The boundary, and it is the whole reason this is a phase and not the answer.**
`iterateNoiseColumn` is *noise only*: the density-function router and the aquifer, and nothing else.
It runs **before** surface rules (`buildSurface` needs a `WorldGenRegion`), before carvers, before
features and before structures. So this door sees a `density_function` or `noise_settings` edit
instantly and **cannot see** a `surface_rule` edit, a new carver, a moved ore or a changed tree
count at all.

**One thing it can do that a restart cannot: change the seed.**
`RandomState.create(HolderGetter.Provider, ResourceKey<NoiseGeneratorSettings>, long seed)` builds a
whole independent `RandomState` at any seed from the registries already loaded. So "what does seed
12345 look like here" is a **parameter**, not a restart — for the half of worldgen this door sees.

### 2.2 Door 2 — throw chunks away and let the server make them again (hard, complete)

`ChunkMap implements GeneratingChunkMap` and exposes `acquireGeneration`, `releaseGeneration`,
`applyStep` and `scheduleGenerationTask(ChunkStatus, ChunkPos)`; it also *extends*
`SimpleRegionStorage`, so the chunk bytes on disk are reachable from the same object.

This is the only door that sees **all** of worldgen, because it is worldgen. It is also the one that
can corrupt a save, and the sequencing is genuinely nasty:

- **Trap A — unloading writes the chunk back.** `ChunkMap.processUnloads` saves a chunk as it drops
  it. Deleting the region-file entry *before* the unload completes is undone by the unload itself.
  The order has to be: drop tickets → wait for the unload **and its write** → then delete → then
  re-request. That is asynchronous over several ticks, not a call.
- **Trap B — a chunk with a player in it never unloads.** Any player, any forceload ticket, any
  `READ_TICKET` still inside its 100-tick timeout holds the region open. The tool must refuse rather
  than half-work, and it must say which chunk and why.
- **Trap C — the pyramid crosses the boundary.** Regenerating a bounded region regenerates it
  *against neighbours that were generated by the old settings*. Structures spanning the edge, and
  `Blender` at the seam, will produce a boundary artefact. That is not a bug to fix; it is a fact to
  **report**, so a modder does not read a seam as a worldgen defect.
- **Trap D — everything in the region dies.** Blocks a human placed, entities, block entities, the
  contents of a chest. This is the most destructive verb the toolkit would own, more so than
  `set_blocks`, because there is no `undo_edit`-shaped snapshot that fits a whole region.

### 2.3 Door 3 — a fresh world at a seed (moderate, and it is orchestration)

Write a new world directory with a chosen seed and generator settings, stop the server, relaunch.
`launch_game` already owns the restart half. The cost is not technical: **the bridge session dies**,
so the tool cannot report its own result, and whatever the agent was holding is gone. It is a
different *kind* of verb from everything else in the manifest and belongs beside `launch_game`.

---

## 3. The phases

**Phase 1 — `preview_worldgen`. Door 1. Built at toolkit 0.103.0; see §5.**
Ask the loaded generator what it makes, at a point or over a grid, at the live seed or any other,
generating nothing. Instant, safe, and honest about seeing noise and biomes only.

**Phase 2 — `regen_region`. Door 2.** The headline. Not built. §2.2's four traps are the design, and
the arbiter has to be a probe that regenerates a region twice from the same settings and gets the
**same** blocks both times — a regen that is not deterministic is not a regen.

**Phase 3 — a fresh world at a seed. Door 3.** Not built, and lowest priority: it is the restart the
modder already does, with the seed picked for them.

**Why phase 1 first, and it is not only that it is easy.** Phase 2 is destructive and slow. Phase 1
tells you *whether you need it*: if the generator's answer at your feet already differs from the
ground you are standing on, your edit landed and the terrain is stale. If it does not differ, either
the edit did not land or it is a surface/feature edit phase 1 structurally cannot see — and those
two are distinguished by whether the noise-settings id and seed in the reply are the ones you meant.
A blind regen of a region tells you none of that and costs a minute.

---

## 4. The seam it shares with the drone

§D4 notes the interaction and it is worth stating precisely. `ReadSupport.ChunkLoader` will not
generate terrain: a virgin chunk is **reported, not paid for**, and deliberate creation is pushed out
to `run_command`'s `forceload` where it is audited as privileged. Phase 1 keeps that rule exactly —
it generates nothing at all, so it can answer about "terrain" a thousand blocks past the loaded edge
without creating a single chunk. Phase 2 breaks it in the other direction (it *destroys* chunks) and
must be privileged for that reason, never `OBSERVE`.

---

## 5. Build record — phase 1, toolkit 0.103.0 **(2026-08-27)**

### 5.1 What shipped

`preview_worldgen`, `OBSERVE`, `SERVER`, `DEV_ONLY`. `center` {x,z} plus optional `dimension`,
`radius`, `stride`, `seed`, `column`, `compare`, `load`. The reply carries a `generator` block (type,
biome-source class, `possible_biomes`, **noise-settings id**, **seed and seed_source**, sea level,
min_y, height), then either `at` for one column or `samples` + a `summary` (`ReadSupport.groundStats`
over the noise floors, plus a biome histogram) for a grid, then optionally `column` and `compare`,
then a `note` that states the boundary in words on every single reply.

### 5.2 Four things the design got right, and three it did not know

**Right.** Door 1 is as open as §2.1 claimed; the seed override works and does not leak; a grid of a
thousand columns is instant; and the canvas dimensions turned out to be the arbiter for the
non-noise refusal — `minecraft:flat`, in the same server, no mock needed.

**1. `codec()` is `protected`, on both `ChunkGenerator` and `BiomeSource`.** So the *registered id*
of a generator is not reachable from an instance the way a block's or an item's is. The generator has
one public back door — `getTypeNameForDataFixer()`, which looks its own codec up in
`BuiltInRegistries.CHUNK_GENERATOR` — and the biome source has none at all, so that one is reported
by class name. A class name is honest and stable; inventing an id would not be.

**2. The two heightmaps use OPPOSITE conventions, and this was a real bug that shipped past nine
green assertions.** `ChunkGenerator.getBaseHeight` returns the first **free** y (vanilla's heightmap
convention: topmost solid + 1). `ChunkAccess.getHeight` returns `getFirstAvailable() - 1` — the
topmost **solid** block. Subtracting one from the other put a systematic **−1** on every undisturbed
column: `identical: 0` over a 49-column grid at spawn, `delta_min: -2`, p50 of 1. That is *precisely*
the "large or one-directional shift" the reply tells a caller to read as **your generator has
changed** — so the headline feature was reporting every world as stale, in the one direction that
looks like a finding rather than a fault.

Nothing in the probe could see it. The file asserted that `delta` equalled its own operands, that
`compared + unread` accounted for every sample, that the refusals refused — all true, all passing,
all blind. What found it was **reading the numbers instead of the pass count**: a run of `-1`s in a
column of otherwise plausible output. The probe now carries the case that would have caught it
(undisturbed spawn terrain must *agree* with the generator: `identical ≥ compared/4`, `p50 ≤ 1`),
which after the fix reads 43/49 identical and p50 = 0.

**3. The manifest entry priced 2,132 chars / ~666 tok/turn on the honest first draft** — over the
~589-char floor `TOKEN_PER_TOOL_FINDINGS.md` Finding 4 measures a new entry against. Finding 5's trim
was taken *before* the first commit rather than after: the argument prose went (the reply's own
`note` and `how_to_read` carry it better, and those are paid per *call*, not per *turn*), and the
BOUNDARY sentence stayed whole — it is the one clause a caller cannot recover from the reply after
they have already acted on it.

### 5.3 The falsifier that matters

`probes/preview-worldgen.test.mjs` case 1: preview a column five million blocks out, then ask
`get_blocks_at` about the same column and require it to **still** report an ungenerated chunk. Every
other case in the file would pass against a tool that quietly took the chunk to `FULL` — and that
tool would be a very slow, world-mutating read wearing an `OBSERVE` label. It is the only assertion
that can tell the two apart.

A second one worth recording because it needed no assertion at all: the noise column at a virgin
coordinate is `stone` from `min_y` to the surface and then `air`, **with no bedrock**. Bedrock is a
surface rule. The boundary this file spends three paragraphs on is visible in one reply.
