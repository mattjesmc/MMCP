# Extension Design — third-party tools & modded-data recognition

Status: **BUILT and SHIPPED.** `Extensions.java` is the seam, `EXTENDING.md` is the guide written
from it, and `CROSS_LOADER_DESIGN.md` §13 carried it onto NeoForge (via `fabric.mod.json`
entrypoints, a mechanism NeoForge does not itself have) and §16 proved it runs in **production** on
both loaders. This document is kept for the reasoning; `EXTENDING.md` is the current authority on
how to use it. (Header corrected 2026-08-23 — it still read "DESIGNED, not built" long after the
seam was load-bearing.) Companion to ARCHITECTURE.md (which stays the authority on
perception/mechanism vocabulary; this doc only adds the extension seam and the data-driven
classification seam).

Two goals, one release:

1. **A mod can ship MCP tools for itself** with one class and one `fabric.mod.json` line,
   without a hard dependency on the toolkit and without guard boilerplate.
2. **The toolkit's classifiers recognize modded content** — not just modded *ids* (that
   already works) but modded *behavior*: hazard blocks, shields, path danger.

## 1. What already holds (investigated 2026-07-31, 0.40.0)

The identity layer is dynamic end to end; none of this needs building:

- `McpTools.register(ToolDef)` is public and villagejobs uses it (`VillageJobsTools`).
  Registration is order-independent (plain map, manifest served lazily at `GET /tools`).
- The Node server fetches the manifest fresh per list; profiles are **hide-lists, not
  allowlists** (`index.mjs`), so extension tools survive every profile unchanged.
- `query_registry` walks `server.registryAccess()` — modded registries and entries appear,
  including dynamic ones (biomes, structures).
- `locate` resolves bare ids and `#tags` against the live structure → POI → entity → biome →
  block registries; modded biomes route through the climate sampler; modded POIs are locatable.
- `Affordances` derives `solid/pass/repl/tool/unbreakable` from `BlockState` behavior —
  correct for modded blocks by construction. `hostile` targeting is `MobCategory`-based.
- Conformance probes already model an extension tier (`spec.ext`, skipped when the owning mod
  is absent).

The gaps are exactly four hardcoded vanilla tables (§3) and the ergonomics/distribution of
the registration seam (§2).

## 2. Design A — the extension seam

### 2.1 Custom entrypoint `"mcptoolkit"`

> **Superseded as the primary declaration by 0.83.0** — an extension now names its class in
> `META-INF/services/com.mattmc.mcptoolkit.McpToolkitEntrypoint`, because NeoForge has no entrypoint
> mechanism. The Fabric entrypoint is still read for jars that ship no service file, so nothing below
> stopped working; see `CROSS_LOADER_DESIGN.md` §13 and `EXTENDING.md`. Everything else in this
> document — the registrar, containment, the collision rule — is unchanged.

A fabric-**loader** feature (no fabric-api — preserves the 0.39.0 loader-only stance). New
API types:

```java
public interface McpToolkitEntrypoint {
    /** Called once, during the toolkit's own init, before the bridge starts serving. */
    void registerTools(ToolRegistrar registrar);
}

public interface ToolRegistrar {
    void register(ToolDef def);
}
```

Extension mods declare it:

```json
"entrypoints": { "mcptoolkit": ["com.example.mymod.mcp.MyModTools"] },
"suggests":    { "mcptoolkit": "*" }
```

**Why this shape.** The class named in a custom entrypoint is instantiated only when the
toolkit calls `getEntrypointContainers("mcptoolkit", ...)`. Toolkit absent → class never
loads → no `NoClassDefFoundError`, no `isModLoaded` guard, no reflection. This deletes the
fragile pattern villagejobs currently needs (one accidental class reference from the guarded
side = crash for users without the toolkit).

**Why a registrar parameter instead of the static `McpTools.register`.** The entrypoint
container knows the providing mod's id; the registrar closure stamps it into each `ToolDef`
as provenance (§2.3). Ambient "current provider" state would work too but explicit beats
ambient, and the interface is where we'd grow capabilities later (e.g. per-mod config)
without breaking signatures. `McpTools.register` stays public and unchanged — it is the
in-process path the builtins use and the compat path for direct callers.

### 2.2 Invocation, containment, duplicates

In `McpToolkit.onInitialize()`, after the builtin `*.register()` calls and **before**
`BridgeServer.init()`:

```java
for (var c : FabricLoader.getInstance().getEntrypointContainers("mcptoolkit", McpToolkitEntrypoint.class)) {
    String modid = c.getProvider().getMetadata().getId();
    try {
        c.getEntrypoint().registerTools(def -> McpTools.registerExtension(modid, def));
    } catch (Throwable t) {
        LOGGER.error("mcptoolkit extension '{}' failed to register", modid, t);
        Extensions.recordFailure(modid, t);
    }
}
```

- **One broken extension must not kill the toolkit** (or the game): per-container
  try/catch, log, record, continue. The builtins keep their current fail-fast behavior — a
  builtin duplicate is a dev bug and should throw.
- **Duplicate names from an extension** do not throw either: `registerExtension` records the
  collision as a failure for that mod and skips the tool. First registrant wins (builtins
  register first, so a builtin name can never be shadowed).
- Ordering: entrypoints are invoked in loader discovery order; with the collision rule above,
  order only matters for mods that collide with each other, which the naming convention
  (§2.4) makes a bug on their side.

### 2.3 Provenance: `source` in ToolDef, manifest, and `ping`

`ToolDef` gains a nullable `source` component (mod id). Only `registerExtension` sets it;
`of`/`async`/direct `register` leave it null (= toolkit-owned). The manifest emits
`"source": "<modid>"` only when non-null — the Node server forwards manifests verbatim, so
this needs **zero Node changes** and is invisible to profiles.

`ping` gains an `extensions` array: `[{mod, tools: [...], failures: [...]}]`. That is the
one place a session (or a probe) can ask "which extension mods are live, and did any fail to
register?" — registration failures are otherwise a log line nobody reads.

Payoff beyond diagnostics: the conformance probe's hardcoded extension name list
(`EXTENSION` set in `conformance.test.mjs`) can be replaced by / asserted against the
manifest's own `source` stamps, and a future per-mod hide (`MCPTK_HIDE_MODS`) becomes a
one-line filter — but that stays on the don't-build list (§6) until someone needs it.

### 2.4 Naming convention

Tool names are a flat namespace. Convention for extensions: **prefix with the mod id or an
unambiguous abbreviation of it** (`vj_survey_trees`, not `survey_trees`). Documented in
EXTENDING.md, not enforced — enforcement would break villagejobs' six grandfathered
unprefixed names (`list_buildings` …), which keep their names (probes and muscle memory
depend on them; they predate the convention).

### 2.5 Villagejobs migrates (reference implementation)

`VillageJobsTools` becomes the `"mcptoolkit"` entrypoint (implements `McpToolkitEntrypoint`,
`register()` renamed to `registerTools(registrar)` with `McpTools.register` swapped for
`registrar.register`). The `isModLoaded` guard and the comment explaining it are deleted
from `VillageJobs.onInitialize`. Net: villagejobs is the living quickstart EXTENDING.md
points at, and its tools gain `source: "villagejobs"` in the manifest.

## 3. Design B — modded-data recognition (the four hardcoded tables)

Principle: **classify by behavior where the game exposes behavior; classify by tag where it
doesn't.** Tags are the idiomatic Minecraft extension seam — a modder (or even a datapack
author, zero Java) joins a tag; the toolkit ships vanilla parity as defaults.

### 3.1 `#mcptoolkit:contact_hazards` (block tag)

The one real correctness hole: `Affordances.HAZARDS` is `Set.of(FIRE, SOUL_FIRE, CACTUS,
MAGMA_BLOCK, SWEET_BERRY_BUSH, WITHER_ROSE, POWDER_SNOW)`. A modded thorn bush reads as
harmless — a **silent perception falsehood**, the failure class the succeeds-falsely purge
(0.6.0) exists to kill.

- New `McpToolkitTags` holding `TagKey<Block> CONTACT_HAZARDS =
  TagKey.create(Registries.BLOCK, Identifier.of("mcptoolkit", "contact_hazards"))`.
- Ship `data/mcptoolkit/tags/block/contact_hazards.json` with **exactly the current seven
  blocks** — parity first, so no probe baseline moves. (Candidates like lit campfires are a
  separate, later decision.)
- `Affordances.flags`: `HAZARDS.contains(state.getBlock())` → `state.is(CONTACT_HAZARDS)`.
  `BlockState.is(TagKey)` is a holder-set lookup — same cost class, no level needed. Delete
  the constant. The javadoc vocabulary gains: "hazard — damages on contact
  (`#mcptoolkit:contact_hazards`; fluids via the fluid state)".
- Tags are per-world data: flags are only computed from observed states of a loaded world,
  so tag load order is a non-issue; `reload_data` picks up datapack changes live.

### 3.2 Nav: the walker avoids tagged hazards

`nav/WalkNodeEvaluator` (vanilla-copied) gives danger maluses to a closed list (cactus,
berry bush, powder snow, honey, …). Modded hazards get walked straight through — the body
takes damage the planner never priced.

In the malus classification, extend the cactus/berry-bush branch: a state in
`CONTACT_HAZARDS` that no earlier vanilla branch claimed classifies as the same
damage-other path type. Vanilla blocks are unaffected (the earlier branches already caught
them — behavior is bit-identical for vanilla, which keeps the walker probes green); modded
tag members become avoid-unless-necessary, matching vanilla's own treatment of cactus.

### 3.3 Shield: behavior, not id

`Reflexes` recognizes a shield by `id.equals("minecraft:shield")`. Vanilla 26.2's own
predicate is the `BLOCKS_ATTACKS` data component (`LivingEntity.getItemBlockingWith()` —
verified in vanilla-src). Replace the string check with
`stack.has(DataComponents.BLOCKS_ATTACKS)`. Modded shields carry the component by
construction; no tag needed — this is a behavior-exposed case.

### 3.4 `#mcptoolkit:crafting_stations` (block tag, minor)

`Crafting` finds a bench via `is(Blocks.CRAFTING_TABLE)`. Same seam, one-member default
tag. Low value until a modded-station user exists, but it costs three lines while we're in
the file, and it documents the pattern. (Modded stations with their own menus won't
necessarily *work* via `bot_craft` — the tag only fixes *finding*; the doc says so.)

**0.88.0 note.** `bot_craft` grew two more stations (smithing, stonecutting — BOT_SURFACE_DESIGN.md
§13.4) and they are **not** tag-driven: they match `Blocks.SMITHING_TABLE`/`Blocks.STONECUTTER`
directly, because the world rule being borrowed is vanilla's own menu predicate. That is a deliberate
limit on this seam, recorded so the asymmetry is a decision rather than a thing nobody noticed: the
bench tag answers "does this offer a 3×3 grid", and a station keyed by `RecipeType` has no
equivalent question to tag. A modded smithing table wants its own tag when a user for one exists.

**Explicitly not tag-ified:** solid/pass/replaceable/tool/unbreakable (behavior-derived),
hostility (`MobCategory`), fluids (`FluidTags`, which modded fluids join), threat rules
(already take any namespaced id). Memory-side concept search is lexical over observations —
no vanilla table exists there.

## 4. Design C — API surface & distribution

**Now: doc-declared API, whole-jar publishing.** The API is these eight names and nothing
else: `McpTools`, `ToolDef`, `ToolContext`, `Schemas`, `Mechanism`, `ExecutionContext`,
`McpToolkitEntrypoint`, `ToolRegistrar` (+ `McpToolkitTags` as a data contract). Everything
else is internal and may change without notice. EXTENDING.md states this; additive changes
bump minor, breaking changes bump major.

Physical `mcp-toolkit-api` Gradle module: **deferred to the repo split** (already planned in
BENCH_EXTERNALIZATION). A separate loom subproject today buys purity and costs real build
complexity while every consumer is in-workspace. `maven-publish` already targets mavenLocal;
a public repo (GitHub Packages or a Pages maven) is a distribution step for when an external
consumer actually exists.

## 5. EXTENDING.md (new, modder-facing)

Outline — the contract distilled, quickstart-first:

1. **Quickstart**: fabric.mod.json entrypoint + suggests, one `McpToolkitEntrypoint` class,
   `./gradlew publishToMavenLocal` + `modCompileOnly` dependency. Villagejobs linked as the
   live example.
2. **The contract** (what ARCHITECTURE.md binds you to): declare your real `Mechanism` — an
   untagged world-edit masquerading as a read is the bug the field exists to prevent; pick
   the right `ExecutionContext`; async handlers must not block the target thread; **act
   verdicts are verified** — report what actually happened, never assume success; the
   toolkit is the schema authority (your `inputSchema` is forwarded verbatim).
3. **Naming**: modid prefix; collisions are skipped and reported in `ping.extensions`.
4. **Modded data**: you get id recognition for free (registries/tags); join
   `#mcptoolkit:contact_hazards` / `#mcptoolkit:crafting_stations` for behavior recognition.
5. **Testing**: `ping` shows your registration (and failures); the probe suite's extension
   tier as the pattern for your own probes.

## 6. Don't-build list (with reasons)

- **`MCPTK_HIDE_MODS` / per-mod profiles** — no consumer; `source` stamping makes it a
  one-liner later. Build on demand.
- **Physical api module before the repo split** — build complexity without an external
  consumer (§4).
- **Declarative JSON tool definitions** (tools without Java handlers) — a tool *is* its
  handler; schema-only registration would produce manifest entries that can't act.
- **Tool unregistration / hot re-registration** — the registry is init-time by design; dev
  iteration already has `hotswap_class`.
- **Enforcing the name prefix** — breaks villagejobs' grandfathered names for zero live
  benefit.

## 7. Plan

Single toolkit release **0.41.0** (+ villagejobs mod change + docs). mcp-server untouched
(no version bump — verify no Node change sneaks in). Phases are commit-sized; live probes
batch into one dev-server pass at the end, per the standing restart-gated pattern.

**Phase 1 — seam (Java, ~half day)**
1. `ToolDef`: add nullable `source` (touch `of`/`async`/`withTimeout` only; grep confirms no
   direct positional constructions elsewhere).
2. `McpToolkitEntrypoint` + `ToolRegistrar` + `McpTools.registerExtension` (collision-skip +
   `Extensions` failure record).
3. Entrypoint invocation in `McpToolkit.onInitialize` (after builtins, before
   `BridgeServer.init()`), per-container containment.
4. Manifest: emit `source` when present. `ping`: add `extensions`.
5. Migrate villagejobs to the entrypoint; delete the guard.

**Phase 2 — modded-data recognition (Java + data, ~half day)**
6. `McpToolkitTags` + `contact_hazards.json` (parity seven) + `crafting_stations.json`.
7. `Affordances` → tag check; javadoc vocabulary update.
8. `WalkNodeEvaluator` → tag branch as §3.2.
9. `Reflexes` shield → `BLOCKS_ATTACKS` component check.

**Phase 3 — probes (headless-runnable parts first)**
10. `probes/extension.test.mjs`: manifest `source` stamps on the six villagejobs tools;
    `ping.extensions` lists villagejobs with no failures; toolkit-only manifests carry no
    `source` (ties into the conformance extension tier).
11. Conformance: assert `spec.ext` ⇔ manifest `source` agreement (keep the spec map as the
    independent expectation; the stamp verifies it).
12. Hazard-tag end-to-end: probe pushes a tiny datapack (`push_data`/`reload_data`) adding
    e.g. `minecraft:cobweb` to `contact_hazards`, asserts the palette affordance flips to
    `hazard`, and a walker corridor lined with it paths around (hazards.test.mjs pattern).
    This is the proof the seam is truly data-driven, not recompiled-vanilla.
13. Shield: probe equips a shield and asserts the reflex recognizes it (existing
    reflexes-equip pattern); modded-shield case is covered by the component check being the
    same code path.

**Phase 4 — docs + release**
14. EXTENDING.md per §5; ARCHITECTURE.md gets a short "Extending" pointer section (it has
    none today); TODO.md don't-build entries from §6.
15. Bump 0.41.0 with the version-comment line; full battery + new probes in the next live
    dev-server pass (sequentially — cold-server concurrency flake is known); commit.

**Risks / checks while building**
- 26.2 datapack layout is `data/<ns>/tags/block/` (confirmed against villagejobs' own tree
  and `Registries.tagsDirPath`).
- The walker probes must stay bit-green after §3.2 — if any vanilla block classifies
  differently, the branch is wired too early in the evaluator.
- Entrypoint invocation happens during the toolkit's init; extension mods whose *own* init
  hasn't run yet must not rely on their registries being populated inside `registerTools` —
  EXTENDING.md warns: register tool *definitions* only, resolve game objects at call time
  (the builtins already follow this discipline).
