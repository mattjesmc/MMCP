# Cross-loader mcp-toolkit — investigation

**Status: STAGES 0, 1, 2 AND 3 DONE, 2026-08-22.** The unified jar exists, **the toolkit runs on
NeoForge** — dedicated server and client, out of the same artifact that runs on Fabric (§12) — and
**another mod's tools now reach it on both loaders** (§13). Stage 0 answered the registration question
(§11); Stage 1 built the seam (§10); Stage 3 replaced the one contract that could not cross (§13).
**The payload gap §12 named is closed** (§14, 0.84.0): human input capture works on NeoForge.
Stage 4 (consumer story) is open.

Question: after 0.79.0/0.80.0 made the toolkit run with *and* without fabric-api, what stands between
it and running on NeoForge and Forge too — ideally out of **one package**?

Answer up front: **much less than you would expect, and the 0.79.0 work is why.** The port surface is
15 files out of 173. The hooks layer that replaced fabric-api is already the cross-loader abstraction;
it just doesn't know it yet.

---

## 1. The measurement

```
173 Java files, 51,169 lines
 39 files import net.fabricmc.*        (23%)
 24 of those import ONLY @Environment/EnvType — a side marker, no behaviour
 15 files touch the actual loader API  (8.7%)
 18 mixins, ALL targeting vanilla classes — ZERO target a Fabric class
  2 accessWidener entries
```

The entire behavioural coupling, by call site:

| Fabric API | Sites | Loader-neutral need |
|---|---|---|
| `FabricLoader.getConfigDir()` | 8 | `configDir()` |
| `FabricLoader.getGameDir()` | 6 | `gameDir()` |
| `FabricLoader.getModContainer(id)` | 4 | `modVersion(id)`, `modRoots(id)`, `findModResource(id, path)` |
| `FabricLoader.isDevelopmentEnvironment()` | 3 | `isDevelopment()` |
| `FabricLoader.getEnvironmentType()` | 1 | `isDedicatedServer()` |
| `FabricLoader.getEntrypointContainers(...)` | 1 | **the extension seam — the one hard case** |
| `implements ModInitializer` / `ClientModInitializer` | 2 | loader-specific entrypoint shims |
| `@Environment(EnvType.CLIENT)` | 27 classes | drop, or own no-op annotation |

Six methods and an entrypoint mechanism. That is the whole of it.

The 15 files: `BridgeConfig`, `BridgeServer`, `BuiltinTools`, `ChatTools`, `CompanionSessions`,
`Extensions`, `LaunchPrefs`, `McpToolkit`, `ServerExtract`, `client/ClaudeBootstrap`,
`client/McpToolkitClient`, `client/ObsSupervisor`, `hooks/client/ToolkitResourcePack`, `wm/WmConfig`,
`wm/WmRecorder`.

## 2. What Minecraft 26.x hands us for free

**26.1 shipped the first unobfuscated Minecraft**, with parameter names, and Mojang stopped publishing
obfuscation maps. `gradle-conventions` already records the consequence for Fabric: *"Minecraft 26.1+
ships unobfuscated: no `mappings` dependency at all, and no remapping, so plain `implementation`
rather than the old `modImplementation`."*

The same sentence is the cross-loader unlock, and it is worth stating plainly:

> **A class file compiled against vanilla 26.2 is byte-for-byte valid on Fabric, NeoForge and Forge.**

Historically that was false, and the falseness *was* the multiloader tax — Yarn vs SRG vs Mojmap,
`remapJar`, mixin **refmaps**, Architectury's remapping machinery. All of it existed to reconcile
names that no longer differ. A mixin config that names `Lnet/minecraft/server/MinecraftServer;` means
the same thing to every loader now, so `mcptoolkit.mixins.json` is portable **as-is, unmodified** —
and the refmap that would normally have to be regenerated per loader is simply not needed.

This is the difference between "port the toolkit" and "rewrite the toolkit". It is a port.

## 3. What 0.79.0 already bought

The fabric-api removal was the expensive half of this job, done for a different reason:

- **`HookEvent` + `ServerHooks` + `ClientHooks` are the platform-neutral event layer.** They were
  built as a fabric-api replacement; they are equally a NeoForge-event replacement. Nothing that
  subscribes to them knows or cares which loader fires them.
- **All 18 mixins target vanilla.** `BuiltInRegistries`, `Commands`, `DefaultAttributes`,
  `MinecraftServer`, `Mob`, `PlayerList`, `ServerGamePacketListenerImpl`, `ServerLevel$EntityCallbacks`,
  `ServerPlayerGameMode`, `ServerboundCustomPayloadPacket`, `ChatListener`, `Hud`, `LayerDefinitions`,
  `Minecraft` ×2, `MouseHandler`, `Screen` ×2. Every one transplants unchanged.
- **`DefaultAttributesMixin` already replaces `FabricDefaultAttributeRegistry`**, so NeoForge's
  `EntityAttributeCreationEvent` is not needed either.
- **`ToolkitResourcePack` already registers the mod's own assets from vanilla primitives**
  (`PathPackResources` + a `RepositorySource`), which is `fabric-resource-loader-v0`'s job done by hand.
- **`DroneEntities` already has the two-doors-and-idempotent pattern** (`registerTypes()` guarded by
  `registered()`, called from both a bootstrap mixin and the entrypoint, working whichever fires
  first). Adding a third door is the shape it was already built for.

0.80.0 is the cautionary note: *the toolkit ran without fabric-api but no longer ran WITH it*, because
fabric-registry-sync moves the freeze past mod init and the mixin applied to a method never called.
Two loaders means the same class of failure again, in a wider matrix.

## 4. Recommended shape: one jar, dual metadata, one platform seam

"Full cross compatibility in the same package" is achievable literally — one artifact, not a
fabric-jar and a neoforge-jar. The mechanics:

```
mcp-toolkit-0.81.0.jar
├── com/mattmc/mcptoolkit/**              common — vanilla + mixin only, no loader import
├── com/mattmc/mcptoolkit/platform/
│   ├── LoaderPlatform.java               the six-method interface, probe-resolved (see §10.1)
│   ├── FabricPlatform.java               fabric-loader only
│   └── NeoForgePlatform.java             neoforge only
├── com/mattmc/mcptoolkit/fabric/FabricEntry.java          implements ModInitializer
├── com/mattmc/mcptoolkit/fabric/FabricClientEntry.java    implements ClientModInitializer
├── com/mattmc/mcptoolkit/neoforge/NeoForgeEntry.java      @Mod("mcptoolkit")
├── fabric.mod.json                       Fabric reads this, NeoForge ignores it
├── META-INF/neoforge.mods.toml           NeoForge reads this, Fabric ignores it
├── mcptoolkit.mixins.json                BOTH loaders read this, unmodified
├── mcptoolkit.accesswidener              Fabric (2 lines)
└── META-INF/accesstransformer.cfg        NeoForge, same 2 members
```

Each loader discovers mods by its own metadata file and ignores the other's; NeoForge declares mixins
as `[[mixins]] config="mcptoolkit.mixins.json"` and ATs as `[[accessTransformers]]`.

**Why the platform resolves itself rather than being set by each entrypoint:** it must already be
resolved when the *bootstrap mixin* runs, which is before any entrypoint exists. This document
originally proposed `ServiceLoader` for that; building it showed why that cannot work here — see
§10, item 1.

### The two entrypoint classes must be split

Not cosmetic — this is a hard runtime constraint. `McpToolkit` holds `MOD_ID` and `LOGGER` and is
referenced by **41 files**; `McpToolkitClient` holds `DRONE_LAYER`, referenced by `DroneRenderer`. If
either keeps `implements ModInitializer`, loading it on NeoForge throws `NoClassDefFoundError` and
takes the whole toolkit with it. The interface moves to a thin shim; the constants stay put.

That split has a second payoff on NeoForge, where the lifecycle differs: types must register in
`RegisterEvent`, and the rest of init in `FMLCommonSetupEvent`. `McpToolkit.onInitialize()` is
currently one linear block that opens with `DroneEntities.bootstrap()` — the shim is where that gets
resequenced, and common code stays a single ordered `init()` call.

### The access widener is two lines

```
accessible method net/minecraft/client/renderer/entity/EntityRenderers register (...)V
accessible method net/minecraft/world/item/context/UseOnContext <init> (...)V
```

Both are trivially expressible as a NeoForge AT. This is a non-problem, and worth saying because on
most mods it is the ugliest part of the port.

## 5. The four things that are actually hard

Ranked by risk, not by size.

### 5.1 Registration timing — where the third door is ✅ RESOLVED, see §11

This was the single biggest unknown in the document and could not be settled from documentation. It
has now been settled by running it: **both doors are open on NeoForge, and a type registered through
the mixin door reaches a joining client with a matching numeric network id.** §11 has the evidence.
The rest of this section is the original reasoning, kept because it is what the spike was designed
against.

`BuiltInRegistriesMixin` slips `registerTypes()` in at the `freeze()` call inside
`BuiltInRegistries.bootStrap()`. NeoForge unfreezes and re-freezes registries around mod loading, and
the docs describe `DeferredRegister`/`RegisterEvent` without saying what happens to the vanilla
bootstrap path. NeoForge's `RegisterEvent` *is* a supported open door, exactly as fabric-registry-sync
is, and the existing idempotent `registerTypes()` absorbs a third caller by construction. The
second-order risk was that types registered outside NeoForge's ownership tracking would be missing
from registry sync to a connecting client — invisible on singleplayer, fatal on a dedicated server.

### 5.2 The extension seam — the one contract that breaks ✅ RESOLVED, see §13

**Resolved by 0.83.0, and two of the conclusions below are wrong.** `ServiceLoader` is not the
replacement — its *file* is, read by hand — so no `modId()` method was needed and no second guard
was needed either. §13 has the reasoning; the rest of this section is what it was designed against.

`Extensions.discover()` calls `FabricLoader.getEntrypointContainers("mcptoolkit", ...)`. NeoForge has
no analogue. `ServiceLoader` is the loader-neutral replacement, but it changes what extension mods
must declare, and `EXTENDING.md` documents a specific reason for the current design:

> *"A custom entrypoint's class is loaded only when the toolkit asks the loader for it. If the toolkit
> is absent, that class is never touched… do not reference your entrypoint class from your own init path."*

`ServiceLoader` preserves that property — a service class is instantiated only when the service is
requested — so the *reason* survives. What changes is the declaration site (`META-INF/services/…`
instead of a `fabric.mod.json` entrypoint key) and, importantly, the per-mod attribution: Fabric hands
back an `EntrypointContainer` that knows which mod provided it, which is what feeds `ping`'s
`extensions` array and its "which mod's tool is missing" diagnosis. `ServiceLoader` does not. That
attribution has to be recovered — cheapest is a `modId()` method on `McpToolkitEntrypoint` itself.

One caveat carried over from building Stage 1: `ServiceLoader` aborts its whole iteration with a
`ServiceConfigurationError` when any one provider class fails to load, which is the same containment
problem the platform probe was written to avoid — and containment is the entire point of this
subsystem. Stage 3 should read the service files with the same per-candidate guard, not with a bare
`ServiceLoader.load(...)` loop.

Blast radius is small in practice: **menagerie is the only consumer that declares the entrypoint.**
Rocketeer only `suggests` the toolkit. So this is a one-mod migration, and the dual-discovery path
(read both the Fabric entrypoint *and* the service file) can keep it working through the transition.

> **Wrong, found 2026-08-22 after Stage 3 shipped: villagejobs declares it too** —
> `"mcptoolkit": ["com.mattmc.villagejobs.mcp.VillageJobsTools"]`, six tools, in the workspace root
> repo. It was unmigrated and still worked (the entrypoint path is still read), so nothing was
> broken; but the count above was taken from the separate checkouts and missed the mod living in the
> same tree as this document. It is also the better arbiter for the legacy path than menagerie, which
> registers no tools at all — and that is what it was used for: **migrated 2026-08-22, and the two
> runs either side of its service file are the last two rows in §13's cell table.**

### 5.3 Client assets — a fix that becomes a double-registration

`MinecraftPackRepositoryMixin` `@ModifyArg`s the toolkit's `assets/` into the client's
`PackRepository`. NeoForge already exposes mod resources to the client automatically. Left as-is, that
is either a duplicate pack entry or a hard failure, and — per `ToolkitResourcePack`'s own class note —
**a headless server can never catch it.** Only a real NeoForge *client* boot shows it, exactly the way
the magenta checkerboard surfaced in 0.79.0. So: gate the mixin on the platform, and make the NeoForge
client boot a mandatory arbiter, not an optional one.

### 5.4 The build — Loom and ModDevGradle in one root

The two plugins both want to provide Minecraft and both want to own run tasks. Options:

- **(a) No NeoForge plugin at all.** Because 26.x is unobfuscated, the `neoforge` source set can
  compile against a bare `compileOnly "net.neoforged:neoforge:26.2.0.x"` from the NeoForged maven,
  with Loom continuing to provide vanilla. Cheapest by far, and enough to *produce* the unified jar.
  Cost: no `runClient` for NeoForge from this root — verification means dropping the jar into a real
  NeoForge instance.
- **(b) A `neoforge/` subproject on ModDevGradle** whose output is folded into the root's jar. Gets
  real NeoForge run configs and therefore a real dev loop; costs a build-graph split and a
  `tools/rebuild.ps1` that grows a `-Loader` parameter.

Recommend **(a) first** — it makes the jar and proves the loading story with the least machinery —
and (b) only once NeoForge is a surface being actively developed rather than verified.

Note `tools/rebuild.ps1` currently hardcodes the toolkit's own Loom `:runClient`/`:runServer` as the
dev loop. Under (a) the NeoForge loop is manual; that is an accepted cost, not an oversight.

## 6. Forge: defer

Forge 65.1.1 exists for 26.2, so it is technically reachable. But it is a third dialect of metadata,
event bus and lifecycle, for an ecosystem that has largely moved to NeoForge, in service of a
**development tool the user runs on their own machines** — the toolkit is not a content mod shipped to
players who might be on any loader.

Recommendation: **build the platform seam so Forge is a `ForgePlatform` + a `mods.toml` + an entry
shim, and then don't write them until something needs them.** If the seam is right, Forge is
later a day's work; if the seam is wrong, no amount of Forge-specific effort helps.

## 7. Staged plan

**Stage 0 — the spike. DONE, see §11.** All three answers were "yes".

**Stage 1 — the platform seam, Fabric only. DONE, 0.81.0.** See §10.

**Stage 2 — the unified jar. DONE, see §12.** Build option (a), as recommended.

**Stage 3 — dual extension discovery. DONE, 0.83.0.** See §13. The service *file* went in beside the
Fabric entrypoint; `ServiceLoader` itself did not, and attribution never had to be "restored" because
reading the file per mod means it is never lost.

**Stage 4 — consumer story.** `gradle-conventions` currently declares the toolkit as a plain
`implementation` on a Loom classpath. A NeoForge consumer needs the equivalent, and the convention
plugin is Fabric-shaped throughout. Out of scope until a consumer mod actually wants NeoForge.

## 8. The verification problem, stated plainly

**The toolkit has no Java unit tests** — `src/` contains only `main`. Its arbiter has always been a
live boot plus `ping`. Cross-loader multiplies that matrix:

| | Fabric | Fabric + fabric-api | NeoForge |
|---|---|---|---|
| dedicated server | required | required | required |
| client | required | required | **required — §5.3 is client-only-visible** |

Six boots. 0.80.0 exists because one of the first four was skipped once. `ping` is the right probe —
it already reports `env`, `gameDir`, and the `extensions` array — and it should grow a `loader` field
in Stage 1 so a boot report says which world it came from without inference.

## 9. What this comes to

- The toolkit is **~99% loader-neutral already** and does not know it.
- **Unobfuscated 26.x removes the historical multiloader tax entirely** — one class file, three loaders,
  one mixin config, no refmaps, no Architectury.
- One jar with dual metadata is a real option, not a stretch. "Same package" is achievable literally.
- **Stage 1 is worth doing whether or not NeoForge ever ships**: it turns a hidden 15-file dependency
  into a named six-method interface, and that is a better toolkit either way.
- The one thing that can invalidate the plan is §5.1, and it is one afternoon's spike to settle.


---

## 10. Stage 1, as built (0.81.0)

`platform/LoaderPlatform` (six methods + `extensions()`; `loadedMods()` joined in 0.126.0 for crash attribution), `platform/FabricPlatform`,
`platform/Platform` (the resolver and static re-exports). All 15 files migrated; `FabricLoader` and
`ModInitializer` now appear **only** under `platform/` and `fabric/`.

**Three things changed from the plan, each for a reason found while building:**

1. **A probe, not `ServiceLoader`.** ⚠️ **The mechanism described here is WRONG and 0.82.0 replaced
   it — see §12.** The conclusion (a probe) survived; the reason given for it did not. Left standing
   rather than rewritten, because the correction is the more useful artifact. *As written in 0.81.0:*
   the unified jar will carry one platform per loader, and each
   hard-references classes that exist on only that loader — so all but one *must* fail to load on any
   given boot. That is the normal case, not an error. `ServiceLoader` resolves each provider eagerly
   inside `hasNext()` and throws `ServiceConfigurationError` from the iterator, so one
   absent-by-design implementation can abort iteration before the right one is reached. `Platform`
   probes an explicit candidate list instead, with the `try` around the `Class.forName`. Twenty
   lines, and the failure mode is structurally impossible. `install()` remains for a loader that
   wants to skip the probe, but nothing uses it: several mixins can reach the platform before any
   entrypoint runs, so resolution must not depend on entrypoint ordering, and giving Fabric an easier
   second path would only mask probe bugs on the one loader where they are cheapest to find.

2. **`Extension` carries a `Supplier`, not an instance.** Building it eagerly in `extensions()` would
   have moved extension *construction* out of `Extensions.discover()`'s try block, so a mod with a
   throwing constructor would have taken every later extension down with it. The supplier also keeps
   the promise `EXTENDING.md` makes — an extension class is loaded only when the toolkit asks.

3. **`@Environment` stayed.** 27 classes carry it; it is annotation-only, and the JVM silently ignores
   annotations whose type cannot be resolved, so it is inert rather than fatal on another loader.
   Touching 27 files for no behaviour change is pure risk. Revisit in Stage 2 if a real NeoForge boot
   disagrees.

**Also landed, because the boot matrix needed it:**

- `-Pport=<n>` on `runClient`/`runServer`. A boot matrix has to run beside a live game, and
  `run/config/mcptoolkit.properties` is a file a human maintains, not a scratch pad.
- **A bug the matrix found on its first client quit.** Every dev-client shutdown since 0.79.0 wrote a
  crash report for a clean exit — 61 of them in `run/crash-reports/`. Removing fabric-api took
  `ClientLifecycleEvents.CLIENT_STOPPING` with it and nothing re-homed it, so nothing ever called
  `BridgeServer.stop()` on a client; `sun.net.httpserver`'s dispatcher is non-daemon, the JVM could
  not exit, and Minecraft's shutdown watchdog fired. `ClientHooks.CLIENT_STOPPING`
  (`Minecraft.close()` HEAD) now closes the bridge. This is worth noting as a pattern, not just a
  fix: **the fabric-api removal was verified by what still worked, and a hook whose only symptom is a
  process that fails to exit is invisible to that test.** There may be others; the hooks layer has
  never been audited against the fabric-api event list it replaced.

### Boot matrix — four Fabric cells, all green

**These cells are boot-depth, and reading them as coverage is a mistake made once (2026-09-08).**
Every whole probe battery has run on the no-fabric-api arm only — `tools/rebuild.ps1` never passes
`-Pfabricapi`, so the flag below has never carried more than a boot and a `ping`. `RELEASE.md` 2.7
owes one whole battery on the other arm before the tag.

| | no fabric-api | with fabric-api |
|---|---|---|
| dedicated server | `ping` → `loader: "fabric"`, types registered, `mcp-server-dist` extracted | same, green |
| client | `Reloading ResourceManager: mcptoolkit, vanilla` | `…: mcptoolkit, vanilla, fabric-api, …` — own pack registered alongside `fabric-resource-loader-v0` |

The server cells exercise `loaderName`, `gameDir`, `configDir`, `isDevelopment`, `isDedicatedServer`,
`modVersion` and `findModResource` (the extract reads `mcp-server-dist` out of the jar and stamps the
version). The client cells exercise `modRoots` — the pack appearing by name in the resource-manager
line is the positive proof, not merely the absence of the "no assets/ root found" warn.

Client quit after the fix: **exit 0, no new crash report.**

### The one method with no coverage

`extensions()`. Every boot reported `extensions: []` because no extension mod was present, and
**menagerie is the only consumer that declares the entrypoint** (rocketeer merely `suggests` the
toolkit). Checking it means pointing menagerie at 0.81.0, which today means bumping
`mcptoolkit_version` in `gradle-conventions/` — the workspace default for all five roots. That is a
decision, not a detail, so it is left open rather than taken quietly.

0.81.0 is published to mavenLocal; consumers still pin 0.80.0 via the convention plugin, so nothing
downstream moved.


---

## 11. Stage 0, as run — the NeoForge answer

Built at `mcmodding/spike-neoforge/` (throwaway; delete the directory and nothing else changes).
NeoForge **26.2.0.64**, ModDevGradle **2.0.144**, Java 25. Two entity types, one per door, built
inside their own methods rather than in static initializers so the timing is explicit and one door's
failure cannot poison the other.

### The three questions, answered

**1. Is the `bootStrap()` freeze door open on NeoForge? YES.**

```
[main] [spike] DOOR 1: bootStrap() injection FIRED - the freeze call was reached
[main] [spike] DOOR 1 (bootStrap mixin): REGISTERED spike:mixin_door
[modloading-worker-0] REPORT mod-constructor (dist=DEDICATED_SERVER) :: mixin_door=rawId=158 event_door=ABSENT entity_types=159
```

NeoForge calls `BuiltInRegistries.bootStrap()` on vanilla's own schedule and does **not** redirect it
the way fabric-registry-sync does. So NeoForge behaves like Fabric **without** fabric-api here: the
type is already in by the time the `@Mod` constructor runs.

**2. Does `RegisterEvent` also work? YES.** The registry is reopened for mod registration, so the
second door is open too — NeoForge is the one loader where *both* windows are available in one run.

```
[modloading-sync-worker] DOOR 2: RegisterEvent for ENTITY_TYPE fired
[modloading-sync-worker] REPORT after RegisterEvent :: mixin_door=rawId=158 event_door=rawId=159 entity_types=160
```

**3. Does the mixin-door type survive registry sync? YES, with identical numeric ids.**

| | `spike:mixin_door` | `spike:event_door` |
|---|---|---|
| dedicated server, at `ServerStartedEvent` | `rawId=158` | `rawId=159` |
| client, after joining that server | `rawId=158` | `rawId=159` |

The connection was accepted (`Dev logged in with entity id 1`) and the ids match on both sides.

**Raw ids, not just presence, is the point.** "The client joined" only proves the handshake did not
reject; entity spawn packets carry the *numeric* id, so two sides that disagree on it exchange
packets that mean different things — silent corruption, not a failed connection. Presence alone
cannot see that.

### Two things the spike found on the way

**The check lied on its first run.** `idOf()` used `getValue(id) == null` to mean absent, and reported
`event_door=present(rawId=100)` before it had been registered. `BuiltInRegistries.ENTITY_TYPE` is a
**defaulted** registry — `getValue(missing)` returns `minecraft:pig`, never null — so the "ABSENT"
branch could never fire. Fixed by asking `containsKey` first. Same lesson as the data-layer work: *a
check whose subject degrades gracefully measures the degradation unless it asks the question that
cannot degrade.*

**`Missing translations: entity.spike.mixin_door`** — logged as an ERROR by vanilla's `Bootstrap`
validation, and **only for the mixin-door type**. Registering during `bootStrap()` puts the type in
before vanilla checks that every entity type has a lang key; the `RegisterEvent` type registers after
that check and slips past it. Consequence for the toolkit: `mcptoolkit:drone` and `mcptoolkit:walker`
want `en_us.json` entries, or the error line is accepted as known noise. Cosmetic — but it is exactly
the kind of line that reads as a real failure in a six-cell boot matrix.

### Incidental confirmations of §2

- `mcptoolkit.mixins.json`'s format is portable **verbatim**. The spike's config is the same shape,
  declared via `[[mixins]] config="spike.mixins.json"` in `neoforge.mods.toml`, and applied with **no
  refmap and no edits**. NeoForge even runs `net.fabricmc:sponge-mixin` as its Mixin implementation.
- Zero mixin warnings or apply failures.
- Every vanilla API name compiled unchanged from the Fabric side on the first attempt — `Identifier`,
  `ValueInput`/`ValueOutput`, `SynchedEntityData.Builder`, `EntityType.Builder`, `MobCategory`. That
  is the unobfuscated-Minecraft claim holding in practice rather than in principle.

### What this changes for Stage 2

`DroneEntities` needs **no new door** — the mixin it already has fires on NeoForge, and the
`bootstrap()` fallback stays as the belt-and-braces path it already is. Registration is off the risk
list; the remaining Stage 2 work is what §5.2-5.4 said it was (extension seam, the double-registering
pack mixin, the build).

One caveat stated honestly: the spike ran the same mod on both ends, which is the toolkit's actual
deployment. It does **not** show that a client *without* the toolkit can join a server with it — but
that was never the question, since the toolkit's entity types have to exist on both sides regardless.


---

## 12. Stage 2, as built (0.82.0) — one jar, two loaders, both booting

`src/main/` stays loader-neutral. `src/neoforge/` is a second source set holding the two classes that
name NeoForge — `NeoForgePlatform` and `NeoForgeEntry` (+ a client shim) — mirroring the two that
name Fabric. Both compile against Loom's Minecraft, and both land in the same jar:

```
mcp-toolkit-0.82.0.jar
  com/mattmc/mcptoolkit/**                  loader-neutral
  com/mattmc/mcptoolkit/fabric/*            2 classes
  com/mattmc/mcptoolkit/neoforge/*          2 classes
  com/mattmc/mcptoolkit/platform/{Fabric,NeoForge}Platform
  fabric.mod.json          META-INF/neoforge.mods.toml
  mcptoolkit.accesswidener META-INF/accesstransformer.cfg
  mcptoolkit.mixins.json                    ONE file, read by both
```

Build option **(a)** as recommended: `compileOnly` against the FML coordinates, no ModDevGradle in
this root. It works because 26.x is unobfuscated — the vanilla classes Loom puts on the compile
classpath are the ones NeoForge runs. The NeoForge dev loop lives in `spike-neoforge/`, which loads
this jar from its `run/*/mods/`.

### The boot matrix, now six cells

| | Fabric, no fabric-api | Fabric + fabric-api | NeoForge |
|---|---|---|---|
| dedicated server | green | green | green — `loader: "neoforge"`, 67 tools, `get_world_info` answers |
| client | green — own pack registered | green | green — `mod/mcptoolkit` present **once** |

The NeoForge client also **joined the NeoForge dedicated server**, and the spike's own ids shifted
158/159 → 160/161 with both sides agreeing: the toolkit's drone and walker crossed registry sync too,
not just the spike's synthetic types.

### The premise §10 was built on was wrong

**`FabricPlatform` loaded fine on NeoForge.** The probe picked it, constructed it, and the boot died
later inside `CompanionSessions` asking it for the game directory.

0.81.0's reasoning — stated confidently here, in the commit message, and in the class javadoc — was
that an implementation hard-referencing an absent loader class "throws `NoClassDefFoundError` by
construction". It does not. `FabricPlatform` names `FabricLoader` **only inside method bodies**:
never a supertype, a field, or a method signature. The JVM does not resolve those at class-load time,
so the class loads perfectly well on the wrong loader. An import and a constant-pool entry are not
linkage.

The fix is to stop inferring and start asking. Each candidate now names a **marker class** — the
loader API class its implementation actually calls — and the probe resolves the marker first
(`Class.forName(marker, false, cl)`, no initialization, presence is the whole question):

```
net.fabricmc.loader.api.FabricLoader   -> FabricPlatform
net.neoforged.fml.loading.FMLPaths     -> NeoForgePlatform
```

If the marker resolves, every call the implementation makes will resolve too — the two facts are the
same fact, rather than two that have to be kept in step. And if the marker is present but the
implementation will not construct, that is now a loud throw rather than a fall-through to some other
loader's platform.

Worth keeping the shape of the error, not just the fix: **the wrong design still passed every test
that existed.** All four Fabric cells were green with it, because on Fabric the first candidate
happens to be the right one. Only a boot on the second loader could distinguish "picks the right
platform" from "picks the first platform".

(The `ServiceLoader` objection in §10 was also wrong in its reasoning — it would not have thrown
`ServiceConfigurationError`, because both implementations load. It is still not the answer, for the
simpler reason that it has no way to ask which provider is correct.)

### Two more differences found by booting

**`modRoots` was returning paths you cannot resolve against.** Fabric hands back roots; NeoForge's
`JarContents.getContentRoots()` hands back the mod JAR FILE, because its own resource API is
stream-based and never needs a `Path`. So `root.resolve("mcp-server-dist")` produced
`.../mcp-toolkit.jar/mcp-server-dist`, and the first NeoForge boot logged "mcp-server-dist missing
from mod resources". `NeoForgePlatform` now opens a zip filesystem per mod jar (cached, process
lifetime) and returns its root — normalising in the platform, not at the call site, because a raw jar
path that silently resolves to nothing is a trap the next caller would re-spring.

**NeoForge validates payload direction above vanilla.** `HumanCapture` sends a serverbound custom
payload every client tick; the toolkit registers its codec by `@ModifyArg` into
`ServerboundCustomPayloadPacket.<clinit>`, which is vanilla's own modding seam and enough on a bare
loader. NeoForge refuses anything not registered through its `RegisterPayloadHandlersEvent`:
`"Payload mcptoolkit:human_frame may not be sent to the server!"`, thrown 20×/second and contained by
`HookEvent` — the containment worked, but a contained failure at tick rate is a log nobody can read.

**Named here, fixed in §14 (0.84.0).** For one release `LoaderPlatform.canSendCustomPayloads()` was
false on NeoForge and `HumanCapture` stood down with one startup line. The fix was indeed its own
change — and the collision it was expected to bring turned out to be in a different place than this
paragraph guessed. See §14.

### Two new platform questions

The interface is now eight members, and the two additions are both "must I do this work", not "tell
me a fact":

- **`needsOwnAssetPack()`** — NeoForge already exposes a mod's assets, so
  `MinecraftPackRepositoryMixin` must contribute nothing there or the same files register twice. The
  mixin still applies everywhere; it just returns the argument untouched. Verified from both sides:
  `mod/mcptoolkit` appears exactly once on NeoForge, and Fabric still shows
  `Reloading ResourceManager: mcptoolkit, vanilla`.
- **`canSendCustomPayloads()`** — above.

### A trap worth its own line

`§` is Minecraft's formatting-code prefix. The stand-down warning originally said
`CROSS_LOADER_DESIGN.md §12` and printed as `CROSS_LOADER_DESIGN.md 2)` — the logger ate `§1` as a
colour code. **Never put a section sign in a log message**; the source encoding is fine and the file
is innocent.

### Still open

- ~~**The payload gap** above.~~ Closed by §14.
- **Stage 4, the consumer story.** `gradle-conventions` is Fabric-shaped throughout.
- `@Environment` stayed on 27 classes and a real NeoForge boot did not disagree, client included.

(Stage 3, listed here when §12 was written, is now §13.)


---

## 13. Stage 3, as built (0.83.0) — another mod's tools, on both loaders

An extension mod now declares itself in
`META-INF/services/com.mattmc.mcptoolkit.McpToolkitEntrypoint` — one file, both loaders, one line per
implementation class. Fabric's `entrypoints` block still works and is what a jar built against
0.41.0–0.82.0 has. **A jar declaring both is discovered once, through the service file**, which is
what lets one jar run on an old toolkit and a new one during the transition; the alternative is not
silent (the second pass collides on every tool name and lands in `ping` as a failure list) but "not
silent" is a long way from "correct".

The whole of it is `platform/ServiceExtensions` — the file name, `ServiceLoader`'s comment/blank-line
grammar, and lazy construction — plus roughly ten lines per platform to walk that loader's own list
of mods.

### `ServiceLoader` is the file, not the mechanism

§5.2 named the containment objection and §12 confirmed it survived the platform-probe correction: a
third-party class genuinely can fail to load, and that must cost only its own tools. `ServiceLoader`
resolves each provider inside `hasNext()` and throws `ServiceConfigurationError` out of the iterator,
so one mod built against another toolkit version would take every *later* extension down with it.

What the build found is that the guard §5.2 asked for is not needed either, because **the scan can
load no class at all.** It reads text; the class name rides in the `Extension`'s supplier and is
resolved by `Class.forName` inside the per-mod `try` that `Extensions.discover()` has had since
0.41.0. So a `LinkageError` is contained by the containment that was already there, rather than by a
second mechanism that would have to be kept in step with it. Two other things fall out: attribution
comes from *where the file was found* (so a modder never declares their own mod id and cannot get it
wrong — the `modId()` method §5.2 proposed is unnecessary), and NeoForge's module-level
`uses`/`provides` declarations never enter into it, because no real service lookup happens.

### The two platform halves

**Fabric** walks `getAllMods()` and `ModContainer.findPath`, then appends any `entrypoints`
declarations from mods that did *not* ship a service file.

**NeoForge** walks `ModList.getModFiles()` and reads through `JarContents.containsFile` /
`readFile` — deliberately *not* through `modRoots()`, which mounts a zip filesystem per mod jar
(§12). That normalisation is right for `findModResource`, which asks about one mod; this asks about
every loaded mod, and on a large instance it would mean a mounted filesystem and a held file handle
per jar to read one text file out of two of them.

Attribution there is by mod FILE rather than by mod: one NeoForge file may declare several mods, and
the file's service declaration belongs to the file. The first declared mod id names it — attributing
it to each mod in the file would register the same tools once per mod and collide with itself.

### The cells

`extensions()` had never run at all — every boot in §10 and §12 reported `extensions: []` because no
extension mod was loaded. Four cells at 0.83.0, all green — plus two more from the villagejobs
migration below, which is where the legacy path first carried a real tool:

| cell | how | result |
|---|---|---|
| Fabric, service file (+ entrypoint) | menagerie, `runServer -Pmcptoolkit_version=0.83.0` | `[MCP Toolkit] mod 'menagerie' declares both … using the service file`, then `1 extension mod(s) registered tools: [menagerie]`; `ping` → one entry, no failures; 69 review asks declared |
| Fabric, entrypoint only | same, service file moved aside | same registration, no "declares both" line — the pre-0.83.0 path still works |
| Fabric, entrypoint only, **real tools** | villagejobs, `runServer "-Pmcptoolkit_version=0.83.0"`, before its migration | `1 extension mod(s) registered tools: [villagejobs]`; six tools in `GET /tools` with `"source": "villagejobs"`, and `list_buildings` answers |
| Fabric, both, **real tools** | the same repo once the service file was added | the "declares both" line, the same six tools, `ping` → one entry with no failures, and `GET /tools` still 73 — discovered once, not twice |
| NeoForge, service file | `spike-neoforge` made an extension mod | `1 extension mod(s) registered tools: [spike]`; `spike_toolkit_probe` in `GET /tools` with `"source": "spike"`, and it answers |
| NeoForge, containment | an unloadable class listed *ahead* of the good one | `tools: [spike_toolkit_probe]` **and** `failures: [IllegalStateException …]` — the bad line cost only itself |

The containment cell is the one worth keeping: it is the claim the design rests on, and until it ran
it was an argument. `spike-neoforge`'s service file keeps the bad line commented out with a note, so
re-running it is uncommenting one line.

### The legacy path only became an arbiter once villagejobs ran it (2026-08-22)

Both Fabric cells above were run with menagerie, which declares review subjects and **registers zero
tools**. So "the pre-0.83.0 path still works" meant *discovery* still works — an extension was found
and constructed. That a TOOL reaches the manifest through it was untested, and §5.2's correction
names why the arbiter was there all along: villagejobs declares the entrypoint with six tools, in
this very repo.

Migrating it is one file — `src/main/resources/META-INF/services/…`, the same four lines menagerie
has — and running it either side of that file is the two rows added above. Nothing else changed:
`fabric.mod.json` keeps its `mcptoolkit` entrypoint, because a jar declaring both is exactly the
transition shape this seam was built for, and the "declares both" line in the log is the proof it is
taken once.

Worth naming: `GET /tools` returned **73 tools in both runs**. A double registration would not have
been quiet — the second pass collides on every name and lands in `ping`'s `failures` — but the count
is the cheaper check, and it is the one that would also catch a *miss*.

No client cell. The client is a mandatory arbiter for §5.3 because a resource pack registers once per
client and a headless server cannot see it; extension discovery runs the same code on both sides of
the same loader, so a server cell answers it.

### Testing a version bump does not require deciding one

§10 left `extensions()` unverified because checking it "means bumping `mcptoolkit_version` in
`gradle-conventions/` — the workspace default for all five roots. That is a decision, not a detail."
It is not needed: the convention plugin reads that key with `findProperty`, so
`./gradlew runServer "-Pmcptoolkit_version=0.83.0"` overrides it for one run of one repo, and the
workspace default stays where it is. (Quote it — PowerShell splits `-Pkey=0.83.0` at the dot and
Gradle then reports `Task '.83.0' not found`, the same trap as `-PjoinServer=127.0.0.1:25565`.)

Nor did menagerie need a pin: a service file is a plain resource, so the jar declares it while still
compiling and running against 0.80.0, which ignores it. **Whether the workspace default moves to
0.83.0 is still an open decision, and nothing here depends on it.**

### Traps found on the way

- **`tools/rebuild.ps1` builds whatever project the SHELL's cwd is in**, not the one `-Project`
  names. It invokes `mcp-toolkit/gradlew.bat` by path, but Gradle takes its project directory from
  the working directory, so running it from the workspace root built villagejobs and reported
  `BUILD SUCCESSFUL` — with `:compileJava UP-TO-DATE` as the only sign anything was wrong. `-Project`
  is honoured for the *relaunch*, which passes `-WorkingDirectory`, and for nothing else.
- **A project-level `repositories {}` block silently replaces the ones ModDevGradle declares in
  settings**, and the build then fails on `neoform-runtime`, which looks nothing like the cause. The
  `mavenLocal` filter belongs in `settings.gradle`'s `dependencyResolutionManagement`.
- `*/` inside a javadoc comment ends the comment. `run/*/mods/` does not survive being written down.

---

## 14. The payload gap, closed (0.84.0) — human input capture on NeoForge

`HumanCapture` sends one `HumanFramePayload` per client tick while connected to a local server. The
toolkit registers its codec by `@ModifyArg` into `ServerboundCustomPayloadPacket.<clinit>` — vanilla's
own modding seam. On Fabric that is the whole mechanism. On NeoForge it was necessary and not
sufficient, and the difference is worth stating precisely, because "NeoForge validates payload
direction" (how §12 put it) is not quite what the code does:

> `NetworkRegistry.checkPacket` refuses to send any custom payload whose id is neither `minecraft:`
> nor a **negotiated channel**, and channels are negotiated only for payloads declared through
> `RegisterPayloadHandlersEvent`.

So the frame was encodable and decodable and still refused at the send, once per client tick. The fix
is `NeoForgePayloads` — one class in `src/neoforge/`, one `registrar.playToServer(...)`.

### The collision was not where §12 expected it

§12 said the two registrations "would collide if both ran". They do not. Vanilla's known-types map is
consulted **first** and NeoForge's registry is the *fallback* (`CustomPacketPayload.codec` →
`findCodec` → `fallback.create`), so with both in place the codec that actually runs is still the
mixin's, and NeoForge's is dead weight that costs nothing. The mixin therefore keeps applying on both
loaders — one mixin config, one jar.

**What genuinely must not run twice is the DELIVERY.** NeoForge calls the registrar's handler for
every modded payload, and the toolkit's own `@Inject` into `handleCustomPayload` was already the
delivery on Fabric. Both would have recorded the same frame twice, and a duplicated input frame is
not a crash — it is a quietly wrong demonstration, the worst failure mode this subsystem has.

The gate is `LoaderPlatform.dispatchesCustomPayloads()`: false on Fabric, true on NeoForge, checked
at the top of the injection. Phrased as *who dispatches*, not *which loader*, so a loader that grows
native dispatch later changes one boolean. It is a runtime check rather than a per-loader mixin
config on purpose — a second config is a second thing to keep in step with this one, for a branch
that costs a field read per custom payload.

### The cell

NeoForge dedicated server + NeoForge client joining it over TCP (`spike-neoforge`, `wm.record=true`
on the server), the same topology that found the bug. ~80 seconds of an idle joined player:

```
"human": { "move_rows": 834, "client_move_rows": 814, "fallback_ticks": 7,
           "disagree_ticks": 0, "payload_gaps": 2, "payload_dups": 0, "payload_dropped": 14 }
```

Read it as four separate answers:

- **`client_move_rows: 814` of 834** — the frame arrives, is consumed, and upgrades the tick's row to
  `src:"client"`. On 0.83.0 this number is 0 and the client log carries one refusal per tick; here
  the refusal appears zero times.
- **`disagree_ticks: 0`** — every consumed frame's key booleans matched the server's own
  `lastClientInput`. The §15 cross-check passes on NeoForge, so the frames are not merely arriving,
  they are arriving *about the right tick*.
- **`payload_dups: 0`** — the double-delivery guard works. Two deliveries of one frame would show up
  here as a `d <= 0` tick delta, counted rather than dropped, which is why this number is the direct
  arbiter for `dispatchesCustomPayloads()` and not an incidental statistic.
- **`fallback_ticks: 7`, `payload_dropped: 14`, `skew {1: 794, 2: 2, 3: 18}`** — the join and the
  first chunk loads, where the client's tick rate is not yet steady. These are the numbers that mean
  nothing without a baseline, so the baseline was run: see below.

### The Fabric baseline, same topology

Every previous Fabric run of this rig was an **integrated server** — a memory connection — so none of
them could say whether the NeoForge numbers above are good. `runClient` therefore gained the
`-PjoinServer=<host:port>` switch the NeoForge spike already had, and the cell was re-run as Fabric
server + Fabric client over TCP, ~40 seconds idle:

| | move rows | `src:"client"` | fallback | disagree | gaps | dups | dropped | skew |
|---|---|---|---|---|---|---|---|---|
| Fabric | 812 | **789** (97.2%) | 7 | 0 | 2 | 1 | 16 | {1: 766, 2: 19, 3: 4} |
| NeoForge | 834 | **814** (97.6%) | 7 | 0 | 2 | 0 | 14 | {1: 794, 2: 2, 3: 18} |

The two loaders are indistinguishable on every number that matters, and the gap/drop/fallback counts
are the rig's own behaviour over a real socket rather than anything NeoForge does.

One thing the baseline corrects: **Fabric's `payload_dups: 1` shows a stray dup is background noise**,
so `dups: 0` on NeoForge is not by itself the proof that the delivery gate holds — the proof is its
ORDER OF MAGNITUDE. A second delivery path would have duplicated *every* frame, ~800 of them, not one.

This run doubles as the regression cell for the gate itself: `dispatchesCustomPayloads()` is false on
Fabric, and 789 client rows say the injection still delivers there.

Two incidental costs of running it: the dev `run-server/` had `online-mode=true`, which an offline dev
client cannot join (it connects and is dropped instantly, with the reason only in the client's 401 on
`/player/certificates`) — now `false`, matching the spike's server. And `run-server/config/mcptoolkit.properties`
did not exist; it now does, with `wm.record=false` and a line saying to flip it for this cell — a dev
server that records every boot fills `world-model/data/raw` with idle sessions.

### Notes

- `MainThreadPayloadHandler` (what `PayloadRegistrar` wraps a handler in by default) calls
  `enqueueWork`, which is the connection's own main-thread queue in packet order — the same ordering
  the Fabric path gets from its explicit `server.execute` hop. The §15 claim that the frame is
  consumed *after* the same client tick's input packets survives the loader change, and
  `disagree_ticks: 0` is what that looks like when it holds.
- A modded payload that reaches a NeoForge server with **no** registration is not ignored: it
  disconnects the client (`"Received a modded payload … with no registration"`). So on NeoForge there
  was never a middle state where the codec alone would have half-worked.
- The channel version passed to `registrar(...)` is `"1"` — the WIRE format's version, not the
  toolkit's. It moves when `HumanFramePayload`'s layout does.

---

## 15. The hooks audit, and the workspace catches up (0.85.0)

Two owed items, closed. One found nothing and is worth writing down for that reason; the other found
a bug whose arbiter is not the loader anyone would have reached for.

### 15.1 The hooks layer audits clean — and could never have found the bug it was owed for

The audit owed since 0.79.0 was "check the hooks layer against the fabric-api event list it
replaced". The removal commit is `61ac158`, and its diff drops exactly 14 fabric-api facilities,
17 distinct members. Every one has a live replacement:

| fabric-api | replacement |
|---|---|
| `ServerLifecycleEvents.SERVER_STARTED` / `STOPPING` / `STOPPED` | `ServerHooks.*` |
| `ServerTickEvents.END_SERVER_TICK` | `ServerHooks.END_SERVER_TICK` |
| `ServerEntityEvents.ENTITY_LOAD` | `ServerHooks.ENTITY_LOAD` |
| `ServerMessageEvents.CHAT_MESSAGE` | `ServerHooks.CHAT_MESSAGE` |
| `CommandRegistrationCallback.EVENT` | `ServerHooks.COMMAND_REGISTRATION` |
| `ClientTickEvents.END_CLIENT_TICK` | `ClientHooks.END_CLIENT_TICK` |
| `ClientReceiveMessageEvents.CHAT` / `.GAME` | `ClientHooks.CHAT_RECEIVED` / `GAME_RECEIVED` |
| `ClientPlayConnectionEvents.DISCONNECT` | `ClientHooks.DISCONNECT` |
| `ScreenEvents.AFTER_INIT` | `ClientHooks.SCREEN_AFTER_INIT` |
| `ScreenMouseEvents.afterMouseClick` | `ClientHooks.SCREEN_MOUSE_CLICKED` |
| `Screens.getWidgets` | `ToolkitScreens.widgets` / `addWidget` |
| `EntityRendererRegistry.register` | vanilla `EntityRenderers.register` (already public static) |
| `ModelLayerRegistry.registerModelLayer` | `ToolkitModelLayers` |
| `FabricDefaultAttributeRegistry.register` | `ToolkitAttributes` |

Two divergences from fabric semantics, both deliberate and both already documented at the site:
`ToolkitScreens.widgets` is a snapshot rather than fabric's live proxy list (all four callers are
read-only), and `SCREEN_MOUSE_CLICKED` fires *before* the screen's own handler rather than after,
because a handler may navigate away and rebuild the widget list.

Supporting checks: 18 hooks, each with a firer **and** at least one registrant — no dead hooks, none
unfired. `mcptoolkit.mixins.json` is `"required": true` with `defaultRequire: 1`, so an injection
point that moved crashes at load; "silently failed to apply" is not in the failure set. Every
toolkit-created thread sets `setDaemon(true)`; the sole non-daemon is `sun.net.httpserver`'s
dispatcher, reached by `BridgeServer.stop` from `SERVER_STOPPED` (gated on `isDedicatedServer`, so a
client's bridge survives quit-to-title), from `CLIENT_STOPPING`, and from a JVM shutdown hook on the
`System.exit` crash path. Vanilla's ordering cooperates: `Main` then `exitWorldAndClose()` disconnects
the level (halting the integrated server, firing `SERVER_STOPPING`/`STOPPED`) and only then, in
`finally`, calls `close()` and so `CLIENT_STOPPING`, so `WmRecorder` closes before the bridge does and
`ClientShutdownWatchdog` starts after both.

**The result that matters is a correction to the premise.** `CLIENT_STOPPING` was never a missed
port. `ClientLifecycleEvents` appears nowhere in this repo's history before `9bd9732` — the commit
that *added* the hook. The toolkit never used fabric's `CLIENT_STOPPING` because until 0.79.0 it had
no client of its own to stop. So this audit, run at any point, could not have found that bug.

The generator is not "which event did we forget to port". It is **the toolkit entering an environment
it has not been in before**, and each entry has produced its own gap: its own client (0.79.0) gave the
missing asset pack and the missing shutdown; a NeoForge client (0.84.0) gave the payload gap; and
15.2 below is the third. Auditing against the old list is finished and paid nothing. The remaining
risk is entirely in front of the environments not yet booted.

### 15.2 The bodies get names, and Fabric could not have told us

`mcptoolkit:drone` and `mcptoolkit:walker` drew `Missing translations` at ERROR on every boot, the
toolkit's own and every consumer's. The obvious fix does not work, and it is worth knowing why:

> `Language.DEFAULT_INSTANCE` is built by `loadDefault()`, which reads exactly one file —
> `/assets/minecraft/lang/en_us.json`, from the game's own jar, through a single-resource
> `Language.class.getResourceAsStream`. No mod's `assets/` is on that path and none can be: a mod
> that *won* that lookup would REPLACE vanilla's whole map rather than add to it.

So the map `Bootstrap.getMissingTranslations` checks against is structurally blind to modded strings.
Shipping `assets/mcptoolkit/lang/en_us.json` is still the right fix for everything a player sees —
`ToolkitResourcePack` mounts it on Fabric and NeoForge exposes it itself — but it cannot silence that
check.

It only bites this mod because of *when* the toolkit registers. An ordinary mod's entity types come
from an entrypoint, which runs after `Bootstrap.validate()`, so the validator never sees them.
`BuiltInRegistriesMixin` registers the bodies during vanilla's own bootstrap — the thing that makes
the toolkit loader-only — which puts them in the registry while the validator is still to come.
`BootstrapMixin` closes the loop by removing, at `getMissingTranslations` RETURN, the keys the shipped
file genuinely provides. Keys are read from that file rather than listed a second time, so the two
cannot drift, and it **narrows** the check rather than disabling it: an entity type with no string
still reports.

#### The arbiter is NeoForge, and that is a new fact about the boot matrix

`Bootstrap.validate()` wraps the whole translation check in `if (SharedConstants.IS_RUNNING_IN_IDE)`.
That flag is **false under Loom and true under ModDevGradle/FML.** The Fabric dev server proves it
from a second direction: `Util` logs `No data fixer registered for mcptoolkit:drone` and then
*rethrows* when `IS_RUNNING_IN_IDE` — and the Fabric server logs both lines and still reaches
`Done (0.402s)`, so the flag is false there. A Fabric boot of this fix is therefore vacuous: it shows
zero `Missing translations` lines whether or not the mixin does anything.

**Generalised: the two loaders in the matrix are not interchangeable as arbiters for anything vanilla
gates on `IS_RUNNING_IN_IDE`.** Fabric cells silently skip those paths.

The NeoForge dedicated server, before and after, with the spike's own entity type as a control that
was not asked for and is the reason the cell means anything:

| | 0.84.0 | 0.85.0 |
|---|---|---|
| `entity.mcptoolkit.drone` | ERROR | — |
| `entity.mcptoolkit.walker` | ERROR | — |
| `entity.spike.mixin_door` | ERROR | **ERROR (still)** |

Three lines became one. The surviving line is the proof the check still runs and still catches an
untranslated modded entity type; a fix that disabled the check would have taken it too. That one line
is now the entire ERROR output of the NeoForge server boot.

### 15.3 The workspace default moves to 0.85.0

`gradle-conventions` had sat at `0.80.0` for five toolkit releases while `mavenLocal` reached 0.85.0.
Nothing was blocked — any repo can pass `-Pmcptoolkit_version=...` for one run — but **menagerie's and
villagejobs' committed service files were inert**, because the extension seam they declare is only
read by 0.83.0+. The seam that had been built was not the seam that ran.

Measured before moving it: villagejobs, menagerie and nijntje all `compileJava` clean against the new
default, and `toolkitStatus` reports `0.85.0` in each. What the bump turns on, on a villagejobs dev
server with no `-P` at all:

```
[MCP Toolkit] mod 'villagejobs' declares both a fabric.mod.json entrypoint and
              META-INF/services/... - using the service file, which is the cross-loader one.
[MCP Toolkit] 1 extension mod(s) registered tools: [villagejobs]
```

`Done (15.320s)`, zero ERROR lines, and `ping` reports
`extensions:[{mod:"villagejobs", tools:[6], failures:[]}]` against 73 tools total.

**Outstanding:** rocketeer was not compiled as the fourth cell — another session held that checkout
throughout, and two Gradle runs on one `build/` dir die with `EOFException`. It takes the new default
on its next build. It declares no extension (`"mcptoolkit": "*"` in its `fabric.mod.json` is a
`depends`, not an entrypoint), so its exposure is the jar version alone.

### 15.4 The names, seen — on both clients

0.85.0 shipped with one honest gap: the ERROR silencing was arbitrated on a NeoForge dedicated
server, but no CLIENT had booted at 0.85.0 on either loader, so the thing the lang file is actually
*for* had never been looked at. Same shape as the 0.79.0 magenta-checkerboard bug — assets in the
jar, invisible until a real client renders them. Both clients have now been booted and photographed.

| | Fabric (Loom, toolkit's own `runClient`, bridge 25599) | NeoForge (spike-neoforge `runClient`, bridge 25613) |
|---|---|---|
| `Missing translations` at boot | none — the check does not run | exactly one: `entity.spike.mixin_door` |
| `No data fixer registered for mcptoolkit:drone` | ERROR, and does **not** rethrow | — |
| nameplate over a summoned body | **Drone** / **Walker** | **Drone** / **Walker** |
| body textures | correct (no checkerboard) | correct (no checkerboard) |
| `quit_game` | clean exit, no crash report | clean exit, no crash report |

The Fabric column is the `IS_RUNNING_IN_IDE` fact from §15.2 seen from the client side: the check
never runs there, and `Util`'s data-fixer complaint logs without rethrowing, which is what a *false*
flag looks like. The NeoForge column is the server result reproduced on a client, control line and
all.

**The framing needed a correction, and the correction is where the string is actually read.** A
toolkit-spawned body never shows its type name: `bot_body` gives every body a custom nameplate — the
owning session's handle — and `getDisplayName()` prefers that. What a player reads instead is
command feedback (`Summoned new Drone`, `Killed Drone`), death messages, and a nameplate only when
`CustomNameVisible` is set with no custom name, since `Entity.shouldShowName()` is just
`isCustomNameVisible()` and `getNameTag` falls back to the type name. That last case is how the
screenshots were taken:

```
/execute at @p run summon mcptoolkit:drone  ^-1.2 ^0.4 ^4 {CustomNameVisible:true}
/execute at @p run summon mcptoolkit:walker ^1.2 ^-0.6 ^4 {CustomNameVisible:true}
```

The control rode along in the same output. On the NeoForge client, three summons in one batch:

```
Summoned new Drone
Summoned new Walker
Summoned new entity.spike.mixin_door
```

— a translated modded type and an untranslated one, side by side, rendered by the same client. On
Fabric the same thing was done with `tellraw`: `entity.mcptoolkit.drone` → `Drone`,
`entity.mcptoolkit.walker` → `Walker`, `entity.mcptoolkit.nosuchbody` → the raw key. The client is
not defaulting; it is looking the strings up and finding two of them.

**What that control cost, which is a fact about the spike and not about the toolkit.** Summoning
`spike:mixin_door` crashes the NeoForge client instantly:

```
NullPointerException: Cannot invoke "EntityRenderer.shouldRender(...)" because "renderer" is null
  at EntityRenderDispatcher.shouldRender(EntityRenderDispatcher.java:129)
  at LevelExtractor.extractVisibleEntities(LevelExtractor.java:241)
```

`SpikeEntity` is documented "Never spawned — only its TYPE is under test", and the spike registers
no renderer for it, so nothing was wrong until something asked to draw one. The trap is what happens
next: the entity is SAVED, so the world crashes on every subsequent join and the only way back in is
to delete the save. `mcptoolkit:drone` and `mcptoolkit:walker` render fine on NeoForge — that is the
screenshot — so `McpToolkitClient.init()` off `FMLClientSetupEvent` is early enough for
`EntityRenderers.register`. **A registered entity type with no renderer is a client crash, not a
missing model**; the spike is one summon away from being unusable, and §15.6 should say so if it is
kept.

Free cell along the way: `quit_game` on the NeoForge client exits cleanly — FML Loader closes,
`BUILD SUCCESSFUL`, no crash report written. The 0.81.0 shutdown fix (`ClientHooks.CLIENT_STOPPING`
stopping the bridge, so the non-daemon HTTP dispatcher cannot hold the JVM up) holds on the second
loader.

**Still outstanding from §15.3:** rocketeer's compile cell. Its checkout was being written to by
another session minute-by-minute while this one ran, and two Gradle runs on one `build/` dir die
with `EOFException`, so it was not run rather than run badly. One correction to §15.3's note: the
toolkit is in rocketeer's `suggests` block, not `depends` — weaker still. It has no
`mcptoolkit_version` pin, so the convention plugin's new default is what it will take.

### 15.5 rocketeer's cell, run — and the way to run it was to stop asking for the checkout

The fourth cell of the §15.3 version bump, and the last purely mechanical thing owed. It stayed
unrun for a session because the answer to "is that checkout idle?" kept being no: another session
committed to `<workbench>/rocketeer` three minutes before this one looked, and had been
editing continuously for the hour before that.

**Waiting for it was never the move.** The cell does not need that checkout — it needs *a* rocketeer
tree at a known commit, and `git worktree` gives one with its own `build/`, which is also the
documented way around the `EOFException` two Gradle runs on one build dir produce. Worktree at
`HEAD` (`989014e`), in the scratchpad, removed afterwards:

```
> Task :compileJava
Note: Some input files use or override a deprecated API.
> Task :toolkitStatus
mcp-toolkit dev bridge: 0.85.0 (<home>\.m2\...\mcp-toolkit-0.85.0.jar)
BUILD SUCCESSFUL in 19s
```

Clean, 0.85.0, 19 seconds — the Gradle and Loom caches are user-global, so a fresh worktree pays
almost nothing. **The isolation cost less than the coordination would have.** That closes §15.3: all
four consumer repos (villagejobs, menagerie, nijntje, rocketeer) compile against the new default.

One line of the run is not a failure and should not be read as one:

```
menagerie NOT found at ...\scratchpad\menagerie\build\libs\menagerie-0.1.0.jar
```

That is rocketeer's *second* optional dependency, looked up by sibling path — and the sibling of a
worktree is the scratchpad, not the workspace. The toolkit half of `toolkitStatus` resolves from
`mavenLocal`, which is path-independent, so the cell's actual subject was unaffected.

Confirmed while there, since §15.4 had already corrected §15.3 once: rocketeer's `fabric.mod.json`
carries `"mcptoolkit": "*"` in **`suggests`**, has no `META-INF/services/` directory, and declares
no toolkit entrypoint. Its exposure to the toolkit is the jar version and nothing else.

### 15.6 The spike is kept — and the way to notice that is what it is the only arbiter for

`spike-neoforge` said "throwaway" and "delete this whole directory when done; nothing else depends
on it" in three places. Both halves were true when written and the second one is still literally
true — it is in no `settings.gradle` but its own, and nothing links against it. **That is precisely
what makes deleting it cheap and wrong.** Its build-time blast radius is zero; its *measurement*
blast radius is everything the toolkit knows about NeoForge:

| what it is the only arbiter for | what a Fabric cell does instead |
|---|---|
| the extension seam on NeoForge (§13) | passes — via `fabric.mod.json` entrypoints, a mechanism NeoForge does not have |
| the payload seam on NeoForge (§14) | passes — the collision §14 found is not reachable on Fabric |
| the `Bootstrap` translation check (§15.2) | **passes without running it** — `IS_RUNNING_IN_IDE` is false under Loom |
| any NeoForge client at all (§15.4) | nothing |

The bottom two rows are the load-bearing ones, and they are the same shape as §15.1's finding about
where these gaps come from: a Fabric run does not merely fail to check them, it comes back green
having skipped them silently. Deleting the spike would not lose coverage visibly; it would convert
four measured facts into four assumptions with no cell able to contradict them.

**Kept, then**, and the cost accepted: a second build root, ModDevGradle, a hand-managed jar in
`run/*/mods/`. `README.md` and `settings.gradle` now say so, and its `compileOnly` toolkit default
moved `0.83.0` → `0.85.0` so it tracks the workspace like the consumer repos do.

**The landmine is defused rather than documented.** §15.4 ended by asking for a comment here saying
that `SpikeEntity` is registered with no renderer and that summoning one crashes the client and
poisons the save. A comment was the wrong instrument: the fix is four lines and vanilla ships the
class for it. `SpikeClient` now registers `NoopRenderer` for both doors off `FMLClientSetupEvent` —
the same event and the same `EntityRenderers.register` call `McpToolkitClient.init()` uses on this
loader — fetching each type through a new `SpikeEntities.typeOrNull`, which asks `containsKey`
first, so a door that did **not** open (the outcome the spike exists to detect) is skipped rather
than silently turned into a pig.

The cell that proves it is the crash reproduced, on a NeoForge client at 0.85.0:

```
[spike] renderer registered for spike:mixin_door (NoopRenderer)
[spike] renderer registered for spike:event_door (NoopRenderer)
Summoned new entity.spike.mixin_door
Summoned new entity.spike.event_door
Summoned new Drone
```

All three in view at once, the world ticking past it, `crash-reports/` empty, and `quit_game` a
clean exit. **The screenshot is also the §15.4 translation control, taken a second time and
stronger**: two untranslated modded types showing their raw keys as nameplates beside a translated
one showing `Drone`, all rendered by one client. The client is looking the strings up and finding
one of the three.

Deleted on the way, having served: the two 11:47/11:48 crash reports from §15.4.

## 16. Production, on both loaders — the first boot outside a dev launcher

Every boot in §§10–15 was a Gradle run. Four sites branch on `Platform.isDevelopment()` and all four
had only ever taken the dev arm:

| site | dev arm | production arm |
|---|---|---|
| `BridgeConfig.load` | port 25599, no config file written | port **25600**, and a default `mcptoolkit.properties` is **created** |
| `BuiltinTools` ping | `env: "development"` | `env: "production"` |
| `ServerExtract.ensureFresh` | re-extract every boot, from a build directory | extract once per version, **from inside the mod jar**, then `npm install` |
| `WmConfig.load` | `<gameDir>/../world-model/data` | `<gameDir>/mcptoolkit-wm` |

§15.1 named the generator of every gap this investigation found: **the toolkit entering an
environment it has not booted in.** Production is such an environment, and by that reasoning it was
the largest one left. Three real servers, none of them a Gradle task:

| | NeoForge 26.2.0.64 | Fabric, no fabric-api | Fabric + fabric-api + villagejobs |
|---|---|---|---|
| boot | `Done (0.588s)` | `Done (0.450s)` | `Done (0.296s)` |
| bridge | 25600 | 25600 | 25600 |
| default config written | yes | yes | — (already present) |
| ping | `production` / `neoforge` | `production` / `fabric` | `production` / `fabric` |
| `mcp-server` extracted | yes, + `npm install` | yes, + `npm install` | yes |
| `mcptoolkit-wm` | **yes**, with `wm.record=true` | not run | not run |
| extension seam | `[spike]`, tool callable | none installed | `[villagejobs]`, 6 tools |
| `Missing translations` | none | none | none |
| `No data fixer registered` | none | 2, no rethrow | **none** |
| `stop` | clean, exit 0 | clean, exit 0 | clean, exit 0 |

All four branch sites are correct, and none of them had been executed before today.

### The one thing production changed, and it is about vanilla

`Bootstrap.validate()`:

```java
if (SharedConstants.IS_RUNNING_IN_IDE) {
    getMissingTranslations(Language.DEFAULT_INSTANCE).forEach(key -> LOGGER.error("Missing translations: {}", key));
    Commands.validate();
}
```

**The translation check never runs in production, on any loader.** The `ERROR` §15.2 silenced is a
development-environment diagnostic, and the flag is false under Loom (§15.2) and false in both
productions — so the *only* environment in this whole workspace where that check runs at all is a
NeoForge dev run. That re-scopes §15.2 rather than retracting it: `assets/mcptoolkit/lang/en_us.json`
still does the player-facing work (nameplates, command feedback, death messages, §15.4), and
`BootstrapMixin` is a dev-console fix that is worth exactly what a clean dev console is worth. It
was arbitrated on the one loader where it can be arbitrated, which is the whole reason §15.6 keeps
the spike.

### What production actually exercised that dev never had

`ServerExtract` is the interesting one. In dev it copies from a build directory every boot; in
production it walks `Platform.findModResource` into a **real jar** — the cached zip filesystem §12
built for NeoForge and Fabric's `ModContainer.findPath` — writes `.extracted-version`, and then runs
`npm install` against a `mcp-server-dist/` that ships `index.mjs` and `package.json` and no
`node_modules`. All three servers came back with 91 packages installed and
`@modelcontextprotocol` present. That path had never run anywhere.

Two smaller confirmations rode along:

- **The fabric-api door switch is visible in production**, in the log and by its absence. Without
  fabric-api the toolkit registers its bodies through the `bootStrap()` freeze and vanilla logs `No
  data fixer registered for mcptoolkit:drone` twice; with fabric-api the freeze moves, the toolkit
  takes the other door, and the pair does not appear. Same jar, same server, two runs.
- **The bridge's shutdown holds outside a launcher.** `SERVER_STOPPED` (gated on
  `isDedicatedServer`) stops the non-daemon HTTP dispatcher; all three servers exited 0 with no
  process left behind. §15.1 audited that path; production is the first place it mattered without a
  Gradle daemon to paper over it.

One trap for anything that reads a production server's output as a byte stream: the console stream
is **cp1252** while `logs/latest.log` is UTF-8. An em-dash in a toolkit log message is `M-bM-^@M-^T`
in the file and the single byte `0x97` on stdout. Nothing is broken — a cp1252 console renders it
correctly — but a tailer that assumes UTF-8 sees a replacement character. Same family as "never put
`§` in a MC log message".

**`get_log` (0.91.0) sidesteps this entirely, and that is worth knowing before anyone builds a
tailer.** It reads the `LogEvent`'s own message object inside the JVM and never touches a byte
stream, so the console codepage cannot reach it. The trap above applies to something reading the
process's stdout from outside; the in-game log channel is not that.

### Where these live, and what is still not covered

Both installs are gitignored and kept, because re-running them is now a `java @args` away and the
next version bump will want them:

- `spike-neoforge/run/prod-server/` — 165 MB. `java @user_jvm_args.txt @libraries/net/neoforged/neoforge/26.2.0.64/win_args.txt nogui`
- `run/prod-fabric/` — 154 MB. `java -jar fabric-server-launch.jar nogui`

Both carry `mods/mcp-toolkit-0.85.0.jar` by hand, exactly like the dev `run/*/mods/` copies, and
both need refreshing when the toolkit version moves.

Still uncovered, and now the whole of it: **Forge** (a third dialect, still deliberately deferred —
the seam is built, don't write the dialect), and a **production client** on either loader. The
production client is the smaller gap than it looks: §15.4 booted both dev clients, and the four
branch sites above are server-side, but no client has ever read a production `mcptoolkit.properties`
or extracted from a jar.

## 17. The production client — and the launcher turned out not to be needed

§16 left one environment: a client outside a Gradle launcher. The obvious cell was to drop
`mcp-toolkit-0.85.0.jar` into `%APPDATA%\.minecraft\mods` and press Play. That cell was rejected for
two reasons, and rejecting it is most of what this section is worth:

- it needs a **human at the launcher GUI** for every repeat, and
- that folder is the **user's real game** (it holds `mcp-toolkit-0.2.0.jar`, 83 releases stale,
  alongside iris/sodium/villagejobs), so the cell would have written a test jar into it.

**Production is what the flag says, not what the launcher says.** `IS_RUNNING_IN_IDE` and
`FabricLoader.isDevelopmentEnvironment()` are false for *any* launch that is not Loom's — including
one assembled by hand. The launcher's only irreplaceable contribution is the *install*
(`versions/fabric-loader-0.19.3-26.2/`, `libraries/`, `assets/`), and that is already on disk.
`tools/prod-client.py` reads the version JSON the launcher installed, evaluates its rule lists for
windows/x64, and writes a `java @argfile` that launches the same client into a **throwaway game
dir**:

```
python tools/prod-client.py --game-dir run/prod-client
java -Xmx3G @client_args.txt        # add -Dmcptoolkit.wm.record=true for the wm arm
```

Libraries, assets and the vanilla jar stay shared from `.minecraft`; only `mods/`, `config/`,
`saves/`, `logs/` and the toolkit's own output live in `run/prod-client/`. The session is offline
(`--accessToken 0`), so the log carries two authlib `401`s (`/player/attributes`,
`/player/certificates`) — that is the offline session, not a fault, and it is the same 401 §15.4
named as the only diagnosis of a dev client refused by an online-mode server.

### Two boots, and the branch sites on the client side

| site | production client | how |
|---|---|---|
| `BridgeConfig.load` | **25600**, and `config/mcptoolkit.properties` **written** where none existed | first boot into an empty game dir |
| `BuiltinTools` ping | `env: "production"`, `loader: "fabric"`, `clientPresent: true`, `gameDir` = the throwaway | `POST /cmd {"tool":"ping"}` |
| `WmConfig.load` | **`<gameDir>/mcptoolkit-wm`**, not `../world-model/data` | second boot, `-Dmcptoolkit.wm.record=true` |
| `ServerExtract.ensureFresh` | **not reached — see below** | |

The wm arm did more than create a directory: `raw/20260823-133024/` came back with 788 `ticks`,
788 `actions` and 185 `frames` rows plus `registry-26.2.json`, written by the **integrated** server
of a production client.

### The one arm a client cannot take by itself

`ServerExtract` has three call sites: a dedicated server's `SERVER_STARTED`, `ClaudeBootstrap`
(the in-game **Claude → Launch Workbench** button) and `CompanionSessions.spawnWith`. A client has
only the last two, and **both of them go on to launch a real `claude` CLI session** — the extract
sits between the preflight and the launch with no exit in between (`companion_spawn` refuses
earlier still, on `companion.enabled=false` and on the workspace having no `.mcp.json`). So the
production-client extract cannot be driven from the bridge without spawning an agent on the user's
account, and it is left uncovered on purpose rather than faked with a stubbed `claude` on `PATH`.

What that costs is small and worth stating exactly: the code under it is
`Platform.findModResource` → `ModContainer.findPath` → the cached jar `ZipFS`, which is the *same
FabricPlatform method* §16 ran in production on the Fabric server, from a different thread. The
one client-specific input to it — `Platform.gameDir()` — is confirmed correct by the ping and by
the config file landing in the throwaway dir. A human pressing the workbench button in this game
dir would close it in one click.

### What only a client could have shown

- **The asset pack loads from a production jar.** `Reloading ResourceManager: mcptoolkit, vanilla`,
  and the names resolve: `/summon mcptoolkit:drone` answers `Summoned new Drone`, and a `tellraw`
  of the two selectors beside the two raw keys prints `Drone | bot | Drone | Walker`. This is
  §15.2's player-facing half in the environment §16 proved vanilla's own translation check never
  runs in — the lang file is doing its work with nothing left to complain if it were missing.
- **Both body types render.** `bot_body` spawn of a flyer and a walker, plus a raw `/summon` of a
  drone, with no crash: the §15.4 landmine (a registered entity type with no renderer) is absent
  for the toolkit's own types in production, and the walker's `bot` nameplate is on screen.
- **The fabric-api door switch is visible on a client too**, by the same absence as §16: no
  fabric-api in this game dir, so `No data fixer registered for mcptoolkit:drone` / `:walker` twice
  at bootstrap and the bodies register through the freeze anyway.
- **`quit_game` is clean outside Gradle.** Both boots exited **0**, and `run/prod-client/` has no
  `crash-reports/` directory at all — the 0.79.0 shutdown fix (memory: the dev client that hung the
  JVM and wrote a fake crash report) holding with no Gradle daemon underneath it.

### Traps

- A world-select **list row is not a widget**: click `Singleplayer`, then click the row at GUI
  `(150, 68)` by coordinate, then `Play Selected World` by label (§15.4's recipe, re-used verbatim).
  With no worlds present, `Singleplayer` goes straight to `CreateWorldScreen`, and cycling
  `Game Mode` through **Hardcore** silently forces `Difficulty: Hard` and `Allow Commands: OFF` —
  cycle once more to Creative and re-check the labels rather than the clicks.
- `java`'s `@argfile` reads `\` as an escape, so every Windows path in it must be quoted **and**
  backslash-doubled. `prod-client.py` does this; hand-editing one does not.
- Fabric's library list duplicates vanilla's `asm-*` at different versions. First entry wins and the
  loader's list must come first, or Knot loads against the older ASM.

### Where this leaves the matrix

`run/prod-client/` is gitignored, ~1 MB (everything else is shared with `.minecraft`), and
reproducible from `tools/prod-client.py` in seconds — it does not need keeping the way the two
165/154 MB server installs do, but its `mods/mcp-toolkit-0.85.0.jar` is a **fifth** hand-managed jar
copy for the refresh checklist.

Still uncovered, and now genuinely the whole of it: **Forge** (a third dialect, deliberately
deferred — the seam is built, don't write the dialect); ~~the **client extract arm** above, which
is one human click~~ — **RUN AND GREEN 2026-09-10 at 0.145.0, and it took no click. This sentence
was stale from 0.124.0 (`e6085b6`, 2026-09-06), which gave the client its own `ServerExtract` at
init: from then on a production BOOT was the arm, and the "one human click" here kept the task
open for twenty-one versions (`RELEASE.md` 2.3, `TODO.md` §3.2)** — and `dispatchesCustomPayloads()`, still a two-value question answered by two
loaders. Every `Platform.isDevelopment()` branch site has now taken both arms, on a server and on a
client.
