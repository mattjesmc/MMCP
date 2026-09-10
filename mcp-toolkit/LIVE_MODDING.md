# Live modding — the change-to-game loop

Operating manual for getting a change into the running game without (or with the minimum) restart.
ARCHITECTURE.md owns vocabulary and decisions; this doc owns the workflow. The tool manifest
(`GET /tools` on the bridge) is the truth about what's registered — doc tables are summaries.

## Decision table

What you changed decides the tier:

| You changed | Route | Latency | Hard limits |
|---|---|---|---|
| Java **method body** (mod class) | `gradlew compileJava` → `hotswap_class` | seconds | JVM redefine: no added/removed fields, methods, or classes |
| **Nothing — you want to know what the JVM actually has** (did that mixin apply? which jar is this class from?) | `query_class` | instant | reflection over the loaded class; a mixin that adds only an interface leaves no trace it can see |
| Java **structure** (new tool, class, field, registration) | `./tools/rebuild.ps1` from the repo root | minutes | full restart; stops the running game; **one cycle per port** — a second one exits 3 rather than killing the first one's game (`-Takeover` overrides) |
| **Nothing — something is running that nobody started** (a world that closed itself, a machine carrying idle JVMs) | `./tools/dev-procs.ps1` | instant | read-only unless asked; lists cycle locks, bridge ports, rebuild supervisors, Gradle daemons and dev JVMs. `-Reap`/`-Games`/`-StopDaemons` clean up, scoped to THIS checkout |
| **Client asset** (texture, model, blockstate, sound, lang) | `push_asset` → live resource pack | seconds | client must be running |
| **Server data** (recipe, loot table, tag, advancement, function, predicate, item modifier) | `push_data` → live world datapack | seconds | worldgen registries are **not** reloadable — world restart, though `push_data` still *checks* them |
| **Nothing — you want to DRIVE a screen** (press, drag a slider, scroll a list, tab, type) | `click` (press / drag / scroll) and `send_keys` | instant | client must be running; list ROWS are reachable only by raw x/y — `get_screen` cannot name them |
| **Nothing — you want to know whether a datapack file WOULD load** (before you push it, or at all for worldgen) | `push_data {dry_run: true}` | instant | the game's own codec; `valid:true` is "these bytes decode here", not "it is in the game" |
| **Nothing — you want to know what a loot table actually DROPS** (and how often) | `roll_loot` | instant | it rolls the table the server is holding, so push and reload first; `count` aggregates a distribution |
| **Nothing — you want to know what the WORLDGEN would make here** (did my noise change land? what is at seed N?) | `preview_worldgen` | instant | **noise only** — before surface rules, carvers, features and structures; generates nothing, so it cannot show you terrain that does not exist |
| **Blockbench project** (textures + model) | `mcptoolkitPush(...)` via `risky_eval`, or File > Push to Game | seconds | see Blockbench link below |
| **Blockbench ENTITY project** (geometry + texture you want to stand and look at) | `mcptoolkitEntity({action:'push'})` → `stage_entity` | seconds | client running; the preview entity is the toolkit's own — this does not register a type for your mod |
| **Datapack DYNAMIC REGISTRY** (a mod's own registered-synced registry) | edit the file, then **leave and re-enter the world** | world reload | `/reload` reports success and changes NOTHING — `reloadResources` passes `this.registries` through untouched (`MinecraftServer.java:1518-1563`) |

### Not in release 1

Each of these was on the work list (`RELEASE_1.md` sections D and E) and has no code behind it.
They are listed so a modder meets a stated absence rather than a discovered one; the second column
is the route that exists today. Descoped 2026-09-06 (`RELEASE.md` section 4).

| You want | Route today | Why it is absent |
|---|---|---|
| **Regenerate a region, or a fresh world at a seed** (worldgen iteration phases 2-3) | `preview_worldgen` answers "did my push land" and "what does seed N make here" without generating anything; for real terrain, walk to ungenerated chunks or create a new world from the title screen | phase 2 is destructive - it deletes chunks under a live server - and `WORLDGEN_ITERATION_DESIGN.md` 2.2 names four traps before it is safe |
| **Click a LIST ROW by name** (a row inside a scrollable list named by `get_screen`, targetable by `click`) | `get_screen {detail:"layout"}` for the list's geometry, then `click {x, y}` on the row; `unenumerated_listeners` in the reply is the count of children the tree could not name | the enumeration question (one index space, or a `rows` block per list) is unanswered, and answering it wrong changes every `index` a session has already learned |
| **Run a mod's DATAGEN from the running game** | the codec half exists: `push_data {dry_run:true}` validates against the game's own loaders. Datagen itself is `./gradlew runDatagen` in the mod repo; `generateUi` (`EXTENDING.md`) shows the shape of a Gradle task a consumer wires themselves | a Gradle invocation, not a game question - the game has nothing to add to it |
| **A GAMETEST seam** (the toolkit driving a mod's own in-game tests) | the toolkit IS a harness: a probe file against the bridge, as `mcp-server/probes/` does for the toolkit itself | this is a seam for a mod's own tests, not a framework in the toolkit, and no consumer has asked for the seam |
| **Fire a SOUND or a PARTICLE** to check registration and placement | `run_command` with `/playsound` and `/particle`; `query_registry {registry:"sound_event"}` says whether it registered | the cheapest of these to build, and the command route already answers the registration question; built when a consumer asks |
| **A SECOND CLIENT / multiplayer** desync checks | two dev games on two ports (`rebuild.ps1 -Port`, `launch_game`), each with its own session; nothing crosses between them | the don't-build list forbids cross-JVM code and asset channels, and a second-client tool would become one |
| **Read a STACK in the world** - the components or NBT an item entity or container slot carries | `bot_container` reads containers with the body's hands; `roll_loot` reports a table's output `components`; `run_command` with `/data get` for an exact block entity | the in-world read was never built; the two halves above cover the loot and container cases |
| **ADVANCEMENT progress** (which criteria a player has met) | `run_command` with `/advancement grant|revoke` sets state; whether the advancement LOADED is the log channel's question (`push_data {reload:true}` problems, `get_log`) - advancements are not in a registry `query_registry` can see; progress itself is the save's `players/advancements/<uuid>.json`, read from disk | the loot half of the item shipped as `roll_loot`; the advancement half had no consumer |

## hotswap_class

- Compile first: `gradlew compileJava` (cwd = repo root). The tool's default byte source reads each
  class's own classpath entry, which yields the fresh bytes when the class was loaded from a classes
  directory (dev runs). Jar-loaded classes need an explicit `file` or `dir`.
- **Batch for multi-class edits**: `{"classes": ["a.b.C", "a.b.D"]}` redefines atomically in one
  JVM operation — no tick observes a half-applied change. `class` (singular) still works for one.
- Requires `-Djdk.attach.allowAttachSelf=true` on the game JVM — set on **both** the loom `client`
  and `server` runs in the root `build.gradle`.
- **Mod classes only.** A mixin-transformed or remapped Minecraft class redefined from compiled
  sources silently loses its load-time transforms.
- Privileged → every call (including failures) lands in the audit/event log. A restart resets all
  swaps; there is no tool that lists live divergence from the built jar — if you've lost track,
  restart.
- **Ask before you swap: `query_class` prechecks it** (0.96.0). Its `hotswap` block says whether the
  classpath default will work on that class (`classpath_default`) and whether the class is one that
  may be redefined at all (`safe` — false for a mixin target or a Minecraft class), which is the
  same verdict this tool reaches, one call earlier.

## What a class ACTUALLY is — `query_class` (0.96.0)

Reflection over the loaded class, which is the one thing a decompiled tree and an IDE cannot do:
they answer from source, and source says what a `@Mixin` *intends*. Returns the post-transform
method table and field types, the superclass/interface chain, the class loader, **the file on disk
the class was loaded from**, the mixins with merged methods in it, and the `hotswap` precheck.

```jsonc
query_class {"class": "net.minecraft.server.MinecraftServer"}
// → mixins.applied: [{mixin: "com.mattmc.mcptoolkit.mixin.MinecraftServerMixin",
//                     methods: ["handler$zze000$mcptoolkit$endServerTick", …]}]
//   source: "file:/…/loom-cache/…/minecraft-merged-….jar"
//   hotswap: {classpath_default: false, safe: false, safety_note: "…"}
```

Facts that bite:

- **Mixin detection is by `@MixinMerged`, and that marker rides on METHODS.** An injector leaves a
  handler method behind and is visible; a mixin that only adds an interface, or only widens access,
  leaves no method and cannot be seen this way. `mixins.detection` names the mechanism so an empty
  `applied` reads as "no merged methods", not as "no mixins".
- **`contains` is how you use it on a Minecraft class.** `MinecraftServer` has 275 declared methods
  and 101 fields; the full table is not something to read. The counts are always exact and
  `truncated` says how many were left out — filter, don't page.
- **The lookup itself is reported.** With an instrumentation agent attached (a `hotswap_class` in
  this session attaches one) the loaded-class list is the authority and a class that is not in it is
  reported as `loaded: false` — a real answer, since a class loads only when something touches it.
  Without the agent the tool falls back to `Class.forName(name, false, …)`, which *loads* a class
  that was not loaded (without initialising it); `lookup: "class_forname"` plus a `lookup_note` say
  so rather than pretending the read was free.
- **It is not for static questions.** What a class's source says is `vanilla-src/` and Grep
  (`tools/extract-vanilla-src.ps1`); this is for what the JVM ended up with.

## The live packs (assets and data)

Two toolkit-managed override packs, same design:

| | Client assets | Server data |
|---|---|---|
| Tools | `push_asset` / `reload_resources` / `list_assets` / `clear_assets` | `push_data` / `reload_data` / `list_data` / `clear_data` |
| Location | `<game dir>/resourcepacks/mcptoolkit_live` | `<world>/datapacks/mcptoolkit_data` |
| Priority | force-selected on reload, **top** — overrides mod and vanilla | force-enabled on reload, added last (top) |

Semantics that bite if unknown:

- **Overrides persist.** The packs are plain folders on disk; they survive restarts and stay
  force-selected. A pushed asset shadows the mod's bundled one *until you clear it* — if an asset
  "won't change" when you edit mod sources, check `list_assets`/`list_data` for a forgotten
  override first.
- **Batching**: pass `reload: false` on each push/clear, then one `reload_resources`/`reload_data`
  at the end. Reload is the expensive step, not the write.
- **Bytes already on disk? Pass `file`, not `base64`.** Both `push_asset` and `push_data` (0.91.0)
  accept `file` — an absolute local path the game reads — as an alternative to `base64`, a
  ~40-token call instead of a blob through the transcript. Use `base64` only for bytes that exist
  nowhere on disk. Neither and it is refused, rather than writing an empty file.
- **A reload that succeeds is not a file that loaded.** See below; this is the one that costs hours.
- `clear_assets`/`clear_data` with a `path` removes one override; with no path they empty the whole
  pack — either way the underlying mod/vanilla content is restored on the reload.
- **A third-party pack in the save.** A consumer reported (ArmorPieces, 2026-09) that a pack
  folder created AFTER the world loaded stays invisible to `/reload` and `datapack enable` because
  the first `pack.mcmeta` classification sticks. MEASURED at 0.130.0 (`create-world.test.mjs`, last
  case): on 26.2 it does not - a valid pack dropped into `saves/<world>/datapacks/` is detected and
  auto-enabled as a world pack by the next `/reload`, and so is one whose first `pack.mcmeta` was
  broken and later fixed. So a pack can go in at any time; what a release gate wants anyway is a
  FRESH world with the pack on its first load, which is `create_world {datapacks:[<path>]}` on a
  client and, on a dedicated server, `world/datapacks/<pack>` before the first boot plus its id in
  `server.properties` `initial-enabled-packs` (this repository's `run-server/server.properties`
  does that for `mcptoolkit`). Not `push_data`: that pack is the toolkit's, for files the game
  should pick up on reload.

## Did it actually load? — the log channel (0.91.0)

**Vanilla's data loaders are forgiving by design, and that used to be invisible.** A recipe or loot
table that fails its codec is logged at ERROR by `SimpleJsonResourceReloadListener` and then *stepped
over*; the reload completes normally. So the honest reading of an old `reload_data` reply was "the
reload ran", and nothing more — `reloaded: true` said nothing about your file. The same holds on the
client: a model naming a missing texture is logged and skipped, and `reload_resources` came back
clean.

The fix is not a validator *of your own invention*. The game already validated the file, in the only
place that can; what was missing was reading what it said. (0.100.0 goes one step earlier and asks
the game's own codec **before** the write — see *Will it load?* below. Same principle, same
authority, one step sooner.)

| | |
|---|---|
| `reload_data` / `reload_resources` | now return **`ok`** plus **`problems`** — the WARN-or-worse lines logged *during that reload*, each with `level`, `logger`, `thread`, `message`, `thrown`. Any push with `reload:true` carries the same fields. |
| `get_log {since, level, contains, logger, limit}` | the log after the fact. `level` defaults to `warn`; WARN and above live in a ring INFO chatter cannot evict, so a warning stays findable long after the INFO around it has rolled. `since` is a strictly-after cursor; a cursor the ring has rolled past returns `gap` rather than a short page. |
| `error` events | ERROR and FATAL also land in `get_events` as `error`, so a session watching the stream hears about a broken pack without polling. Deduped per logger+message (10s) and capped per window — `repeats` / `flood_suppressed` say how many an event stood for, and `get_log` still holds every individual line. |
| `get_log {crash: "latest" \| n \| file}` | **the crash, read by the next game** (0.126.0). The ring lives in the JVM that dies, so the previous game's death is the one line it can never hold; vanilla wrote it to `<gameDir>/crash-reports/`. Returns the title, exception, thread, the head trace's top frames and each cause's, every frame **attributed to the mod whose jar loaded its class** (the class resolves to its code source, the code source to a mod through the loader's mod list - identical on Fabric and NeoForge), `suspect` = the first frame that is somebody's mod, and the loader's own "Suspected Mods" section as a secondary field when it wrote one. A frame no loaded jar provides is `unresolved`, not guessed: that is what a report from another project's game, or the very class a `NoClassDefFoundError` is about, looks like. |
| `ping.last_crash {at, path, title}` | present when a report is newer than the previous boot (a stamp beside `mcptoolkit.properties`), so a session learns a crash happened without asking. |

Reading it:

- **Read `problems`, not `reloaded`.** `ok:false` means the game logged something during your
  reload — usually yours, occasionally not. Every line names its logger, which is what makes that
  distinction possible instead of reducing the answer to a boolean.
- **Not everything wrong is logged.** A push to a namespace the game doesn't load is silent because
  the game never scans it (see *Namespaces differ* below); so is a recipe that parses fine and just
  isn't the recipe you meant. This channel catches *rejection*, not *disagreement*.
- **Capture starts at mod init.** The loader's own phase — mod resolution, mixin apply — is in
  `logs/latest.log` and not in the ring.
- **A boot that never reaches the bridge has no tool to ask.** A bad mixin or a missing dependency
  dies before `ping` exists; `launch_game`'s log (exit 1) then ends with the header of any crash
  report the game wrote during that launch and the tail of its `logs/latest.log`, which is where
  the reason is. Once a game is up again, `get_log {crash}` reads the same report properly.
- **`level: "all"` includes DEBUG in a dev run, and it is mostly Mixin and Netty.** Measured on a
  quiet dedicated-server boot: 82 DEBUG, 28 INFO, 4 WARN of 114 lines. That is why the rings are
  split and why `warn` is the default — the all-levels ring turns over fast, the problems ring does
  not. It is also why `get_log {logger: "yourmod", level: "all"}` is the useful shape when you are
  debugging one mod: your own `logger.debug` calls are in there, live, with no file tail.
- `get_log` is a dev tool: served by `full`/`standard`/`entity`, hidden from `play`/`survey`/
  `survival`, and `error` events are withheld from player-legal sessions the same way `audit` is.
  A body perceives the world, not the server's stderr.

> **It found a bug in the toolkit on its first live run**, which is the argument for building an
> observation channel in one line. Both live packs' `pack.mcmeta` declared only `pack_format`, and
> MC 26.2's `PackFormat` requires `min_format`/`max_format` above `lastPreMinorVersion` (**81** for
> server data, **64** for client resources) — so *every reload the toolkit had ever done* logged
> "Error reading pack metadata, attempting fallback type" and fell back to a codec reporting the
> pack as `Integer.MAX_VALUE`. It kept working, which is why it survived unseen. Both writers now
> emit all three fields and **repair** an existing file: the packs persist in the game/world folder,
> so write-if-missing would never have reached a checkout that already had one.

## Will it load? — codec validation on `push_data` (0.100.0)

The section above reads what the game said *after* a reload. This one asks the same authority
*before* the write. Every `push_data` reply now carries a **`validation`** block:

```json
"validation": { "kind": "recipe", "id": "mymod:cut_planks", "checked_by": "codec",
                "valid": false, "error": "..." }
```

`dry_run: true` runs the check and writes nothing — the pre-flight shape, and it works on a `file:`
path just as well as on `base64`, so a file sitting in your source tree can be checked without ever
entering the pack.

**It is not a second opinion, it is the same opinion earlier.** The check is the loader's own codec,
pulled out of the running game: `RegistryDataLoader`'s three lists for the datapack registries,
`LootDataType` for predicate/item_modifier/loot_table, `Recipe.CODEC`, `Advancement.CODEC`,
`TagFile.CODEC` for tags, and `CommandFunction.fromLines` with the server's own dispatcher for
`.mcfunction`. An id from a mod that is not loaded fails here exactly as it would fail there. Live
check: a recipe naming a nonexistent item comes back with the byte-identical string the reload logs
one step later.

**Three things it catches that a reload cannot.**

| | |
|---|---|
| **Worldgen** | Biomes, features, noise settings, dimension types are read **once at world load**. A reload logs nothing about them because it never looks. The only previous way to learn a biome JSON was malformed was to restart the world. |
| **A batched push** | `reload:false` exists so several files land together — and it is the mode a typo survives longest in, because there is no reload to report from. |
| **A directory nothing scans** | No loader, no scan, no log, no content. `kind: null` says so by name. |

That third one was in this toolkit's own tool description: `push_data`'s example path read
`data/minecraft/tags/**blocks**/mineable/pickaxe.json`. Tag directories have been **singular** since
1.21 — `Registries.tagsDirPath` is `"tags/" + <registry key path>`, and `Registries.BLOCK` is
`block`. The first thing the new resolution was pointed at was the tool's own documented example,
and it came back `kind: null`.

**Reading it:**

- **`checked_by` names the mechanism** — `codec`, `command_dispatcher`, `nbt`, or `none`. A reply
  with `checked_by: "none"` has **no `valid` field at all**: an unchecked file must not read as a
  pass. Same rule as `query_registry`'s `tag_exists` and `query_class`'s `mixins.detection`.
- **A tag's members are resolved, not just its syntax.** `TagFile.CODEC` accepts any well-formed id,
  so a typo'd member passes the codec and then vanishes — `TagLoader` logs and *drops* it at bind
  time, leaving a tag silently one element short. `unknown_ids` lists them. `required: false`
  members are the author's declared intent and are not reported; a `#other:tag` member is not
  resolved, because its own file may legitimately be later in the same batch.
- **It reports; it does not refuse.** A batch pushes siblings in an order where one legitimately
  cannot resolve the other yet, so a refusal would make that order illegal. A bad file is written
  *and said to be bad*. Use `dry_run` when you do not want the write.
- **`valid: true` is not "it loaded".** It means these bytes decode, in this game, with these
  registries. A duplicate id, an unselected pack, or a worldgen registry that is only read at world
  load all still apply.

## Structures: capture, place, undo (0.92.0)

`capture_structure` saves a box of the live world as a vanilla `.nbt` inside the live datapack;
**`place_structure` puts one back.** Until 0.92.0 the only route back was
`run_command "/place template …"`, which is worth spelling out because it is the trap this closes:
**`run_command` reports `ok:true` for a command that failed**, so that route could not tell you the
template was not found — the most likely thing to go wrong. It also has no undo and no dry run.

```
capture_structure {min, size, id:'mymod:rooms/library'}   →  data/mymod/structure/rooms/library.nbt
place_structure   {id:'mymod:rooms/library', at, rotation:'clockwise_90'}
undo_edit         {undo_id}
```

- **A missing template is a refusal that names it**, and points at
  `query_registry {registry:'structure_template'}` for what *is* loaded. A template pushed into the
  live pack needs a `reload_data` before the game can see it.
- **`undo_id` works**, because the footprint is snapshotted before the write — block entities
  included, so a chest that was overwritten comes back with its items. Over `EditJournal`'s 200,000-
  cell bound the placement still applies and `undo_id` is null, which is the journal's own documented
  limit rather than a new one.
- **`entities` defaults to false.** Undo restores blocks; it cannot un-spawn a mob. Place them and
  the reply carries an `undo_note` saying so, rather than leaving you to find out.
- **`dry_run` reports the footprint and `occupied`** — what is standing where you are about to build
  — and deliberately **not** `changed`. The template's own cell list is behind a private field, so
  the change count is taken by diffing the footprint after the write; a number the tool cannot
  compute without writing is not a number it may guess.
- **An unloaded destination refuses the whole call.** Reads never generate terrain, so a placement
  into never-generated space would be a half-built structure reported as a whole one.
- Rotation aliases: `90` / `180` / `270` are accepted for the vanilla names, and the reply always
  echoes the canonical one.

## What is registered, and what it turned into — `query_registry` (0.92.0)

The log channel above answers *did my file get rejected*. This answers the other half: **what is the
running game actually holding**. Same tool as the id listing it has always been — the four questions
below are that question asked about one thing instead of all of them, so none of them costs a new
manifest entry (+181 tokens/turn for all four, measured; four separate tools would have been ~2,000).

| ask | call |
|---|---|
| what tags is this in, what properties does it have | `{registry:'block', entry:'minecraft:oak_stairs'}` |
| what is in `#c:ores` | `{registry:'item', tag:'c:ores'}` |
| what tags does this registry even have | `{registry:'block', tags:true, contains:'mineable'}` |
| did my recipe load | `{registry:'recipe', entry:'yourmod:thing'}` |
| did my loot table load | `{registry:'loot_table', entry:'yourmod:chests/thing'}` |

- **`entry` answers about one id** and reports whatever that registry can say: a block's blockstate
  `properties` (every legal value, per property) and its `default_state` *in `set_blocks` syntax*, so
  a read round-trips into a write; an item's `max_stack_size` and default `components`; an entity
  type's size and `category`. For a **datapack** registry — biome, configured/placed feature,
  structure, dimension type, trim material — it hands back the entry's `json` **as the game decoded
  it**, rendered by `RegistryDataLoader`'s own element codec, i.e. the one that read your file. For
  anything else it names the implementing `class`, so the answer is never empty.
- **An unregistered id answers `exists:false`.** That is the question, not a malformed call — an
  unknown *registry* still refuses, because that is a typo in the question itself.
- **`tag_exists` is reported separately, and it is the field to read.** `Registry.get(TagKey)` is
  empty both for a tag that loaded and matched nothing and for a tag whose file never loaded; an
  empty `ids` list alone would read as the first when you are nearly always in the second.
- **`registry:'recipe'`** reaches the `RecipeManager`, which is not in `registryAccess()` at all.
  Listing it shows every recipe the server loaded; `entry` adds `recipe_type` and the recipe as the
  game re-encodes it. **`recipe_type` is not the `type:` in your file**: a file's `type` is dispatched
  on `RECIPE_SERIALIZER` (`minecraft:crafting_shapeless`), while `recipe_type` is the `RecipeType` —
  which station crafts it (`minecraft:crafting`). Both are in the reply; `json.type` is the one your
  file wrote.
- **This is the tool that closes the silent-namespace hole.** A `push_data` into a namespace the game
  does not load succeeds, logs nothing, and loads nothing (see *Namespaces differ*). `reload_data`
  cannot catch it. Asking `query_registry {registry:'recipe', entry:'…'}` can.
- A codec dump over 20,000 characters is reported by **size** (`json_omitted`, `json_chars`) rather
  than truncated — a half a JSON reads as data and parses as nothing.
- An argument the call's mode cannot use is **refused**, not dropped: `contains` beside `entry`,
  `tag` beside `tags:true`, either beside a pseudo-registry. Same rule as `ArgCheck`, one level down.
- **`loot_table`, `predicate` and `item_modifier` are reachable too** (0.101.0), and until then they
  were not: `MinecraftServer.registries` is the world stem's layers, whose `RELOADABLE` layer is
  *empty*, so `registryAccess()` misses all three and `query_registry {registry:'loot_table'}` refused.
  They live on `reloadableRegistries()`. Everything above works on them unchanged — listing, `tag`,
  `tags:true`, and `entry` with the JSON as `LootDataType`'s own codec decoded it. Vanilla ships **no**
  predicates or item modifiers of its own, so an empty listing there is the truth, not a fault.

## What does it DROP? — `roll_loot` (0.101.0)

`push_data` checks the bytes, the log channel checks the load, `query_registry` checks it is held —
and none of them can tell you what the table *produces*. This one asks the running game to roll it.

| ask | call |
|---|---|
| what does my block drop | `{block:'yourmod:ore'}` |
| …with Fortune III | `{block:'yourmod:ore', tool:"minecraft:diamond_pickaxe[minecraft:enchantments={'minecraft:fortune':3}]"}` |
| is my rare drop rare enough | `{table:'yourmod:chests/vault', count:2000}` |
| what does this mob drop | `{entity:'yourmod:beast', count:500, killer:'player'}` |
| what does the block I am looking at drop | `{at:{x,y,z}}` |

- **`count` is the point.** One roll cannot answer "is this drop rate right". The aggregate carries
  per item `share` (fraction of rolls producing it), `avg` (per roll, counting the empty ones),
  `min`/`max`, plus `empty_rolls` and `distinct`. `seed` makes a run reproducible, and its **first**
  roll is exactly what the game rolls for that loot-table seed.
- **A table asked in the wrong context is refused by name.** Every table declares its own parameter
  set, so `{table:'minecraft:entities/zombie'}` cannot be rolled from an id alone — the refusal names
  `this_entity` and the `entity` argument that supplies it, instead of handing back an empty roll you
  would read as a broken table. `supplied` and `param_set` are in every successful reply too.
- **An unknown table answers `exists:false` and rolls nothing.** The game's own
  `getLootTable` returns an EMPTY table for an id that does not exist, which would report your typo as
  "drops nothing".
- **It changes nothing, including the world's randomness.** Loot tables that declare a
  `random_sequence` draw from persistent saved data; this tool always passes its own `RandomSource`, so
  looking at a table never consumes the sequence the world will use later.
- **Why not `/loot`.** It exists, and it is blind three ways: its results go into an inventory rather
  than back to you, it rolls once, and `run_command` answers `ok:true` for a command that failed.

## What will the WORLDGEN make? — `preview_worldgen` (0.103.0)

Worldgen is the one tier with no reload at all. `/reload` never looks at `worldgen/`, so a biome, a
noise setting or a density function lands only on a **world restart** — and then the ground you are
standing on is still the old ground, because it is already on disk. The loop that produces is *fly
ten thousand blocks and look at somewhere else*, which is slow and, worse, **not comparable**: every
iteration is a different landscape in a different place.

This asks the loaded generator directly, at a coordinate, and **generates nothing** — no chunk, no
ticket, no disk, microseconds.

| ask | call |
|---|---|
| did my restart actually load my settings | `{center:{x,z}}` → read `generator.noise_settings` and `generator.seed` |
| what shape is the ground over there | `{center:{x,z}, radius:512, stride:32}` |
| what is under my feet, layer by layer | `{center:{x,z}, column:true}` |
| what would seed 12345 look like here | `{center:{x,z}, radius:256, seed:12345}` |
| is the terrain I am standing on stale | `{center:{x,z}, radius:64, compare:true}` |
| is my biome even reachable | any call → `generator.possible_biomes` |

- **NOISE ONLY, and this is not a footnote.** `getBaseHeight`/`getBaseColumn` run the density-function
  router and the aquifer and stop. Surface rules, carvers, features and structures all come later, in
  a `WorldGenRegion` that only real generation has. So a `noise_settings` or `density_function` edit
  shows up here instantly and a `surface_rule` edit, a new carver, a moved ore or a changed tree count
  **cannot be seen from here at all**. Every field is named `noise_*` for that reason.
- **`seed` is the thing a restart cannot do.** A whole independent `RandomState` is built at any seed
  from registries already in memory, so comparing seeds is an argument rather than a world rebuild.
  Noise generators only: a flat generator has no noise to reseed and refuses by name.
- **`compare` is a distribution, not a verdict.** The world's `OCEAN_FLOOR` and the generator's
  `OCEAN_FLOOR_WG` share a predicate exactly — but the world's has had surface rules, carvers,
  features and every hand-placed block applied since, and a tree raises it by six. Read a **large or
  one-directional** shift across the grid as "the generator changed since these chunks were written".
  A few blocks of scatter is just terrain.
- **It never creates world.** Which is also its limit: it will happily describe ground a million
  blocks out, and it cannot show you the finished article. That needs the chunks regenerated, and
  that tool does not exist yet (`WORLDGEN_ITERATION_DESIGN.md` phase 2).

## Before a game exists: `scaffold` and `checkAssets` (0.127.0)

Two Gradle tasks in the convention plugin, neither a tool, both running from the toolkit jar in a
separate JVM with no Minecraft on the classpath (the same shape as `generateUi`):

```
gradlew scaffold -Pkind=block|item -Pid=<id> [-Pbehaviour] [-Pscaffold.name="Display Name"]
gradlew checkAssets                                   # also under `check`
```

**`scaffold`** writes a block or an item into YOUR source tree in the sibling mods' own idiom - a
`Register<Id>` class in `<root>.registry` (the `Identifier`, the `ResourceKey`s,
`Registry.register` for the block and its `BlockItem`), a `<Id>Block` class only when
`-Pbehaviour` asks, the blockstate, the two models, the item definition, a placeholder texture,
the lang key, the loot table and the `mineable/pickaxe` tag entry. The mod id and root package
come from `fabric.mod.json` (the display name is `-Pscaffold.name`, a namespaced key, because
Gradle's Project answers `name` and `displayName` itself). **It runs once and never regenerates**: a file that exists is left
exactly as it is, a second run on the same id is refused, and the two files it merges into (lang,
the tag) keep every byte they had. There is no machine-owned code because there is no document
for it to track - ownership is yours from the first write, which is the whole difference from an
editor that owns your source. Its output is a file list, what is still yours (the `register()`
call in your initializer, the creative-tab line - a comment, because the tab hook is the loader's
- and the real texture), and the next four calls verbatim: `launch_game` (a registration is
structural; `hotswap_class` refuses it, one rebuild), `query_registry entry`, `set_blocks` or
`give`, `render`, `get_log`. Kinds are `block` and `item` only: a creature is a different question
with its own door (Blockbench + `stage_entity`).

**`checkAssets`** finds, from the files alone, the class of bug the table above finds after the
game has loaded and skipped the file: a blockstate naming a model that is not there, a model
naming a missing texture, an item definition naming a missing model, a loot table or tag naming an
id nothing defines, a block with no lang key. Three buckets, and the split is the honesty rule:
**dangling** fails the build, **unused** (a block or item texture no model names, a model nothing
names) warns - a warning is never a failure, or every work-in-progress branch would be red - and
**unchecked** is counted: `minecraft:` references resolve against the Loom merged jar when the
plugin finds one under `.gradle/loom-cache`, and are counted, never silently passed, when it does
not; another mod's namespace is always counted. The last line of its output is a JSON object
(`text`, `problems`, `notes`), which is what a loop file's `checks[].run` reads.

**The relationship, in one line:** `get_log` and the reload `problems` find what the game LOADED
AND SKIPPED; `checkAssets` finds the same class before a game exists. Both loaders, one layout.

## Promotion: live pack → mod source (0.95.0)

The live packs are a preview surface, not a home. When an asset or data file is right, promote it —
**one call, on the clear**:

```jsonc
clear_assets {"path": "assets/mymod/textures/block/foo.png",
              "promote": "C:/dev/mymod/src/main/resources"}
clear_data   {"path": "data/mymod",                       // a directory takes the whole namespace
              "promote": "C:/dev/mymod/src/main/resources"}
```

Each file is COPIED into that root at the same pack-relative path, and then — and only then — the
override is deleted and the game reloaded. The next `rebuild.ps1` bakes it into the jar.

**Why the promotion is an argument of `clear_*` rather than a `promote_asset` verb of its own.** The
step people forget is the clear: an override left behind keeps winning over the source-tree copy,
which is the classic way to spend an hour "debugging" a texture that changed long ago. Riding the
copy on the clear makes the forgettable step the one you cannot skip — and costs no new manifest
entry (`TOKEN_PER_TOOL_FINDINGS.md` finding 6).

Facts that bite:

- **There is no default destination, and none is ever created.** A missing directory, or one that
  does not look like a resources root (no `fabric.mod.json`, `META-INF/`, `assets/` or `data/`), is
  **refused**. `writeToSource` in the Blockbench plugin refuses for the same reason: a
  wrong-but-plausible default is how a file lands in a checkout nobody is looking at.
- **A refused promotion clears nothing.** Every file is copied before any file is deleted, because a
  promotion that has already removed the override and then failed to write the copy is the only
  outcome worse than not promoting at all.
- **`promote` requires `path`.** Promoting the whole pack would put every namespace in it —
  vanilla's own overrides included — into one mod's source tree.
- **`unchanged: true` on a promoted file** means the source tree already had those exact bytes: you
  promoted this before and have been editing a copy of it since.
- **The game does not show the promoted file yet.** The override is gone, so what is on screen from
  here on is what the BUILT mod has; the promotion reaches the game on the next build. The reply
  says so.

For assets authored in Blockbench there is a second door with the same rules —
`mcptoolkitPush({target:'source'})` writes straight into `src/main/resources` (skip the copy, but
still clear the live override if you previewed through it).

## Is it slow, and what is it? — `get_perf` (0.95.0)

`get_perf` answers where the server's 50 ms is going, at two resolutions in one call:

- **`mspt`** — mean/p50/p95/max over vanilla's own last-100-tick ring, plus the derived `tps` (capped
  at the tick rate: a 1 ms tick is a server running at 20 and sleeping, not one running at 1000) and
  `tick_rate`.
- **`levels[]`** — per dimension: loaded and force-loaded chunks, pending chunk tasks, block/fluid
  ticks, entity and TICKING block-entity counts, the commonest types of each, and `hot_chunks` —
  the chunks holding the most of them, with block coordinates you can teleport to.

Facts that bite:

- **Read `tick_rate.runs_normally` first.** `/tick freeze`, `/tick sprint` and a non-20 tickrate each
  make every millisecond mean something else, and all three are one command away in a dev world. A
  reading taken in any of them carries a `note` saying so. (That field is computed from the state,
  not from vanilla's `TickRateManager.runsNormally()`, which is a once-per-tick cache and answers
  "normal" for up to a tick after a freeze.)
- **A ticking block entity is not the same as a block entity.** A chest has no server ticker at all
  and never appears here; a hopper always does. The census is of tick cost, not of inventory.
- **There is no profile mode, and it is not an oversight.** In 26.2 `/debug start` … `/debug stop`
  measures DURATION and TICK COUNT only — `MinecraftServer.TimeProfiler.stop()` returns results whose
  `getTimes` is unconditionally empty — so a tool built on it reports an empty tree. The real tree is
  behind `startRecordingMetrics`, which writes a whole debug report directory to disk and blocks the
  server thread doing it: a PRIVILEGED act, not an observe read, and RELEASE_1 §D7 carries it as the
  follow-on. Note that even that would not name the expensive block entity TYPE: vanilla pushes a
  profiler section per entity type but ticks the whole block-entity list inside one `blockEntities`
  section. The census is what answers "which".
- **The three ranked lists are top-N, and they say how much they left out** (0.109.0). `top`
  defaults to **5**, and `entity_types`, `block_entity_types` and `hot_chunks` each carry an
  `*_omitted` count beside them. This matters the moment you compare two readings: a type absent
  from a truncated list has an UNKNOWN count, not a zero, and in an established world the type you
  are hunting is routinely ranked sixth. Raise `top` before you read an absence — and use the same
  `top` for both readings, or the comparison is between two different questions.
- **`hooks: true`** adds the toolkit's own per-listener tick cost since boot, for ruling out the
  instrument before blaming the mod.
- **The forceloaded region is part of the reading.** `loaded_chunks` counts what the server is
  holding, and a chunk streaming in mid-measurement brings its block entities with it — the first
  probe run found a mob spawner arriving eight seconds after a `forceload add`. Let a region settle
  before comparing two readings.
- **…and settling is not the same as quiet.** Waiting for two equal readings narrows the window; it
  does not close it. An established world's ticker total drifts on its own — a spawner three million
  blocks away is under no obligation to agree with your test — so do not assert an IDENTITY on a
  world-wide count across an edit. Assert the delta you caused, scope the claim to the type census,
  or measure the drift first with two readings and nothing between them. `probes/perf.test.mjs`
  does the last of those, and reports out loud on the run where the control says the world moved.

## Blockbench link

Three plugins: `mcptoolkit_bridge.js` (the door: the shim's Blockbench upstream since 0.133.0),
`mcptoolkit_sync.js` (assets) and `mcptoolkit_entity.js` (entity geometry, which drives the second).
All are desktop-only, all are loaded once via File > Plugins > Load Plugin from File, and the two
older ones expose a headless global an agent reaches through the bridge's `risky_eval` without
pushing bytes through a transcript. A mod's own editor belongs in that mod's checkout — see
*Editors that live with their mod* below.

**Where the files are, and it depends on which side of the release you are on.** In this workbench
they are `mcp-toolkit/blockbench/`, which is their site of record. **From a consumer repository
they come out of the jar** (0.141.0; before that they shipped in no jar at all, `TODO.md` 1.10):
the toolkit writes them into

```
<gameDir>/mcptoolkit/blockbench/      # every dev boot, beside the extracted shim (ServerExtract)
<repo>/.mcptoolkit/blockbench/        # once, by `gradlew toolkitInit` (ToolkitInit)
```

Load them from whichever of those your repository has. The first is the one to trust: it is written
inside the shim extract's own freshness branch, under the shim's `.extracted-version` stamp, so the
plugin beside a shim is always that shim's plugin — which matters because the pair is one release
unit and a mismatched pair answers wrongly instead of refusing. The `toolkitInit` copy is
write-if-absent like everything else that task writes, so it is a starting point, not a refresh.

### `mcptoolkit_bridge.js` — the door (plugin 0.7.0; `docs/models/BLOCKBENCH_BRIDGE_DESIGN.md`)

- Replaces the third-party "Blockbench MCP" plugin. Load it, then Tools > MCP Toolkit Bridge >
  Start and "Always allow" the one permission it asks for (`process`, which is how a plugin reaches
  Node's `http`). It never opens that dialog by itself: a permission dialog freezes the whole
  renderer until a human clicks, for every session using Blockbench. The shim finds it at
  the first window it can claim at or above `http://127.0.0.1:25801` with nothing configured - each
  Blockbench WINDOW's plugin takes the next free port in that range and one session works in one
  window. **A window is YOURS unless the plugin was asked to open it for an agent**, so the one you
  are working in is never claimed and you set no flag to keep it; a session that finds no agent
  window of its own asks an existing window for a new one, and that window is pre-claimed for it. An
  agent-born window CLOSES ITSELF once nothing holds it and nothing is open in it (never the last
  one, which would quit the app), so an afternoon of sessions leaves no row of empty windows.
  `Let agents use this window` in the plugin's menu hands yours over anyway - by port, so a restart
  remembers it - at the cost the design names: an agent working there still switches the active tab
  to its own model. Its title and its panel say which session holds a window and what that session
  has been calling. (`MCPTK_BLOCKBENCH` overrides - `host:from-to` a range, a bare URL
  one window, `off` nothing; the first port to scan is in Tools > MCP Toolkit Bridge > Settings.)
  `ping` says which window this session got: `blockbench: {port, window, held, session}`. Remove any `blockbench` server registered beside the
  toolkit in `.mcp.json` / `~/.claude.json`: two paths to one app pay two prefixes.
- **Sessions and projects.** Every call is queued, so two sessions never interleave inside the app.
  A session that makes or opens a project (`project op:new` / `op:open` / `op:select`) is BOUND
  to it and every later call without `project` goes there; a call may always name `project`. An
  unbound session acts on the active tab and its first reply says so. An edit on a project another
  live session holds is refused with `held_by` and the two ways out (your own project, or
  `project op:select {project, take:true}`); reads are never refused. `project op:list` shows
  every tab, its holder, and the live sessions.
- **The surface** (26 tools; the `art` profile keeps all but `trigger_action`): `get_project_info`,
  `project`, `list_outline`, `find_elements_by_criteria`, `get_selection`, `inspect` (bounds, face
  rectangles, the envelope of neighbours on a bone, AABB overlaps, UV collisions), `place_cube`,
  `modify_cube`, `add_group`, `element`, `create_texture`, `apply_texture`, `list_textures`,
  `get_texture`, `texture` (ASCII read, rects, resize, recolor, flip, load, write), `paint_faces`,
  `paint_ascii`, `capture_screenshot` (`fit`, `views` for a contact sheet), `set_camera_angle`,
  `export_model`, `undo`, `redo`, `get_undo_stack`, `risky_eval`, `trigger_action`, `animation`.
  Every schema refuses an undeclared argument by name; every edit is one undo entry and replies
  with its readback (face rectangles, envelope gaps); `look:true` on an edit returns the viewport
  on the same reply. `risky_eval` takes comments and awaits a Promise; a rejection is an error
  reply. It puts two locals in scope: `PROJECT`, the project this call resolved to, and `GAME`,
  the bridge URL of the game this session drives. The older plugins' globals are reached through it
  and BOTH take them: `mcptoolkitPush({project: PROJECT, bridge: GAME})`,
  `mcptoolkitEntity({action, project: PROJECT, bridge: GAME})` — hand them over rather than letting
  a plugin read the global `Project` or a port it guessed.
- **Pictures.** `capture_screenshot` and `get_texture` take the shim's `max`; a viewport is
  cropped to its content by the budget, a texture sheet is only ever resized (the picture itself
  says which it is). `fit:true` frames the model as DISPLAYED (Blockbench moves a `java_block`
  scene by (-8, 0, -8); an entity's cubes sit where their bones put them), and `position` /
  `target` are in that displayed space, the presets' own; the camera reply carries
  `scene_offset` when it is not zero.

### `mcptoolkit_sync.js` — push assets to the game

- Plugin: `mcp-toolkit/blockbench/mcptoolkit_sync.js` (v0.4.0). Load once in Blockbench via
  File > Plugins > Load Plugin from File. Needs the game client running with the bridge up on the
  port `bridge` names, except for `target: 'source'`.
- **`bridge` is required and has no default (0.4.0, `TODO.md` 1.9).** Until then this plugin carried
  a hardcoded `http://127.0.0.1:25599/cmd`, and since B0 the port is a project constant that NAMES
  the project (25640 villagejobs, 25641 menagerie, 25642 rocketeer, 25643 nijntje, 25599 the
  toolkit's own) — so from a consumer repo it pushed at 25599 whatever game the session was
  driving: refused if nothing was there, and accepted silently if the toolkit's dev game was up.
  Now the shim tells the plugin which game this session drives (it rides the session block on every
  call), the bridge plugin keeps it on the session record, and `risky_eval` hands it to your code as
  `GAME`. **Inside an eval, pass it:** `mcptoolkitPush({project: PROJECT, bridge: GAME})`. Outside
  one — the File > Push to Game dialog, or a plugin driven by hand — there is now an override where
  there was none: the dialog has a **Game bridge** field that remembers what you type, per project,
  and `mcptoolkitPushSettings({bridges: {'<project>': 'http://127.0.0.1:25640'}})` sets it headless.
  A push with nowhere to go is refused by name. Same treatment for `mcptoolkit_entity.js` and its
  `stage_entity` calls.
- **Agent route (preferred — asset bytes never enter the transcript):** the plugin exposes
  `mcptoolkitPush(opts)` globally; call it from `risky_eval`:

  ```js
  mcptoolkitPush({project: PROJECT, bridge: GAME, namespace:'villagejobs', folder:'textures/block'})
  ```

  Pixels travel canvas → bridge → game entirely inside Blockbench; the return value is a compact
  `{ok, pushed, target, paths}` summary, also stored in `mcptoolkitLastPush` for a follow-up eval
  if the Promise result isn't delivered. Options: `only` (subset of textures by name),
  `project` (the project OBJECT — `PROJECT` inside an eval, always pass it; a project NAME is
  refused since 0.4.0, because resolving a name reaches a project without the bridge's ownership
  check and this was one of the two routes the session binding could not protect),
  `bridge` (the game, above), `model`/`modelPath`/`modelName`
  (compiled model JSON), `extras: [{path, text}]` (blockstates, `.mcmeta`, lang — any small text
  asset), `target: 'live' | 'source' | 'both'` (`source` writes into a mod's
  `src/main/resources` via `fs` — the promotion step, no game needed).
- **`target:'source'` has no default destination** (0.3.0). The root is a per-project setting —
  `mcptoolkitPushSettings({sourceRoots: {'<project>': 'C:/…/src/main/resources'}})`, with
  `sourceRoot` as the fallback — and a promotion with nowhere to go is refused by the name of the
  setting rather than defaulted. `writeToSource` creates an `assets/` tree wherever it is pointed,
  which is exactly how a file lands in a checkout nobody is looking at.
- **Human route:** File > Push to Game — same `doPush` behind a dialog (all textures + optional
  model JSON).
- Everything is batched with a single reload at the end. Still one-way (no pull from game into
  Blockbench).
- **Verify cheaply:** `list_assets` confirms files landed (text, ~free). Spend one `screenshot`
  per batch to judge the art — not one per asset.
- **Gotchas:** (1) A Blockbench *modal permission prompt* (a plugin's first `fs` write, a new
  capability) freezes the renderer: until the human grants it, **every** bridge request times out.
  If the endpoint goes silent but Blockbench is idle, ask the human to look for the prompt. The
  bridge plugin itself never opens one; this plugin's `fs` grant is already recorded on this
  machine. (2) `mcptoolkitPush` never rejects — errors resolve as `{ok:false, error}`. Keep it that
  way; check `.ok`, don't try/catch (the bridge's `risky_eval` would report a rejection as an error
  reply, but a caller reading `.ok` needs no try/catch at all).
- After editing the plugin file, reload it in place:
  `Plugins.all.find(p => p.id === 'mcptoolkit_sync').reload()` via `risky_eval`.

### `mcptoolkit_entity.js` — author an entity, judge it in the running game

- Plugin: `mcp-toolkit/blockbench/mcptoolkit_entity.js` (v0.3.0). Loaded the same way, and it needs
  **`mcptoolkit_sync.js` loaded beside it** — it drives that plugin's `mcptoolkitPush` rather than
  re-implementing the transport, and names it if it is missing. Panel: Tools > MCP Toolkit Entity.
  Headless: `mcptoolkitEntity(opts)`, last result mirrored into `mcptoolkitEntityLast`, never
  rejects.
- **`project` and `bridge` are the same contract as the sync plugin's (0.3.0, `TODO.md` 1.9):** the
  project OBJECT rather than a name, and a game URL with no default — its four `stage_entity` calls
  used to dial the hardcoded 25599 too. The panel grew a **Game bridge** field beside its Source
  root, remembered per project, and `{action:'settings', set:{bridges:{...}}}` sets it headless.
- The whole loop is one call:

  ```js
  mcptoolkitEntity({action:'push', model:'spider', project: PROJECT, bridge: GAME})
  ```

  It converts the active project into the interchange JSON, pushes JSON + texture into the live
  pack, and stages a preview entity wearing it. What comes back is a summary **plus the client's own
  verdict on the geometry** — `parse: "ok"`, or `parse: "error"` carrying the loader's sentence — so
  a broken export is read rather than guessed at from a screenshot. No bytes in the transcript.

| call | for |
|---|---|
| `{action:'status', bridge}` | is the sync plugin loaded, is a game there (and at which bridge), what is staged |
| `{action:'convert', model, file?}` | the JSON only, no game needed; `file:` converts a `.bbmodel` off disk without opening it |
| `{action:'verify'}` | the check battery — SAT overlap over **every** part pair, shared-face planes, the deliberate 1px sink as a named tolerance, and a UV audit. No game needed |
| `{action:'stage'\|'clear'\|'list', bridge}` | drive `stage_entity` directly: re-stage what is already pushed, despawn, or ask what is out there |
| `{action:'promote', namespace:'yourmod'}` | write the JSON + PNG into a mod's `src/main/resources` (below) |

Facts that bite:

- **Staging requires the `mcptoolkit` namespace.** `PreviewModels` reads `assets/mcptoolkit/preview/`
  and nowhere else, so a push into a consumer's namespace is a *promotion*, not a preview — reported
  as pushed-but-not-staged rather than staged-invisibly.
- **`stage_entity` is hidden in the default profile** — in every profile, in fact, except `entity`,
  `art` and `full`. It is an authoring verb, and a session that is not authoring an entity pays its
  manifest entry every turn for a tool it never calls. `MCPTK_PROFILE=entity` in the consuming
  `.mcp.json` unlocks it, `tool_surface profile:"entity"` does it live, and `full` shows everything.
- **The plugin does the whole coordinate flip on export**, so the Java loader does no arithmetic and
  there is no second implementation to drift. If you are writing that conversion anywhere else,
  `EXTENDING.md` carries the rule *and its arbiter* — Blockbench's own codec, which is not the tool
  in this workspace you would reach for first.
- **A texture whose Blockbench name is not a legal asset name is refused with the rename to make**,
  rather than pushed to land beside the file the JSON references.
- **The preview entity is the toolkit's own** — one type, no AI, never persisted. This does not
  register an entity type for your mod, and it never will: the registry freezes at bootstrap.
- **Verify is the finding; the screenshot is legibility only.** A vision impression of a model is
  not evidence about overlap or coplanarity, and the battery costs no game and no tokens.

Promotion: `{action:'promote', namespace:'yourmod', sourceRoot:'…'}` (equivalently
`{action:'push', target:'source'}`) writes through the sync plugin's `writeToSource`. **There is no
default `sourceRoot`** — a promotion with nowhere to go is refused *by the name of the setting*,
because `writeToSource` will happily create an `assets/` tree wherever it is pointed and a
wrong-but-plausible default is how a file lands in a checkout nobody is looking at. Set it once,
per project:

```js
mcptoolkitEntity({action:'settings', set:{sourceRoots:{spider:'C:/…/rocketeer/src/main/resources'}}})
```

What a consumer does with the promoted file is the consumer's business — load it at runtime with its
own loader, project it onto its own codec, or treat it as the source a codegen step reads. The
toolkit generates no Java.

**Harness:** `cd mcp-toolkit/blockbench && node mcptoolkit_entity.test.mjs` covers the headless half
(the Dialog and the menu entry are the part a harness cannot reach). It converts every real
`.bbmodel` in `blockbench_sources/` and checks the geometry against two independent walkers; on a
checkout without that sibling directory it falls back to the one model in `blockbench/fixtures/` and
says so, so the arbiter travels with the plugin. After editing either plugin file, reload it in
place: `Plugins.all.find(p => p.id === 'mcptoolkit_entity').reload()` via `risky_eval`.

### Editors that live with their mod

`menagerie_divisions.js` used to be documented here. As of 2026-08-26 it lives in the menagerie
checkout — `menagerie/blockbench/`, with its harness — because it is menagerie's editor: it reads
menagerie's generated vocabulary, runs menagerie's `CensusTool` and drives menagerie's commands. It
was parked in this repo only because this is where the Blockbench knowledge was, and that is not a
reason for a file to live in another project.

What it proved is general and outlived the move. `EXTENDING.md` ("Building an editor on the
toolkit") states it as conventions: the mod generates the vocabulary and the panel hardcodes none;
derived facts are measured through the mod rather than re-derived in the editor; Gradle is never a
tool's inner loop; the datapack format is the file format; headless APIs never reject.

One rule from it is not editor-specific and stays in the decision table above: **`/reload` does not
reload a datapack-backed dynamic registry** — it reports success and changes nothing. Leaving and
re-entering the world is what loads a new catalog.

## Two working modes

| | Dev | Production (play) |
|---|---|---|
| Port | **25599** for the toolkit's own dev game, automatic in gradle runs; every other repo declares its own `mcmod.port` (25640 villagejobs, 25641 menagerie, 25642 rocketeer, 25643 nijntje), and the Blockbench plugins are TOLD which one rather than assuming (`GAME`, above) | **25600**, on by default (`config/mcptoolkit.properties` disables; `-Dmcptoolkit.port` overrides both modes) |
| Workspace | `mcmodel` / `mcmodding`, hand-configured | your own project directory, registered with `/mmcp server register <dir>` |
| Session start | your agent program, in the workspace | your agent program, in the directory you registered. **The game starts nothing**: 0.143.0 archived the in-game launcher, so both columns are you starting your own session |
| Instance launch | `launch_game` local tool (dev checkouts only): runs rebuild.ps1 detached — `{target: client\|server, rebuild?, takeover?}`, then poll `ping`. Refused while another cycle owns the port | player launches the game normally |
| Memory root | repo `mcp-server/memory-data/` | `<gameDir>/mcptoolkit/memory-data` (pinned in the generated `.mcp.json`) |
| Identity | `ping` → `env:"development"` | `ping` → `env:"production"` |
| Sessions | every session that dials the bridge registers itself over `POST /hello`; `session_list` is the roll call | the same. Chat routing is `/mmcp chat responder <id\|none>`; there are no launch types any more, because there is no launcher |

The bootstrap extracts a slim copy of the Node MCP server from the mod jar into
`<gameDir>/mcptoolkit/mcp-server` (npm installs `@modelcontextprotocol/sdk` only) and writes
`.mcp.json` / `.claude/settings.json` (**reconciled** — rewritten when they name a different bridge
port than the running instance) plus `CLAUDE.md` (**write-if-absent** — your charter edits survive).
Re-extraction is gated on the mod version stamp (`.extracted-version`; delete it to force).
Prerequisites: Node ≥ 18, npm, and the `claude` CLI on PATH (distinct toasts name whichever is
missing).

**Chat**: player chat lands in `get_events` as `chat` events, delivered only to the bound
**responder** session (set in the MMCP screen or `/mmcp session responder <id|none>`; unbound + unmuted
broadcasts to all). `wait_ms` (≤60s) long-polls — `"chat,session_msg"` is the canonical companion
listen filter; a chat-only request from a non-responder fails fast. `send_chat` speaks as
`[MMCP] …` (hard 256-char reject, own output never echoed back). **Disable, both sides**:
"claude stop" in chat kills all companions (process-level); `/mmcp chat mute` is the mod-enforced
hard switch — chat events stop at the source AND `send_chat` errors, persisted across restarts
(`config/mcptoolkit.chat-muted`); `/mmcp chat unmute` restores. `/mmcp session` lists live sessions.

## What a stack SAYS - `get_tooltip` (0.130.0)

The one UI line a mod writes that nothing could read back. `get_tooltip {item:"<id>[components]"}`
(the `/give` form; components included) or `{slot:N}` (a container slot index as `get_screen`
reports it, on the open screen) answers the lines `ItemStack.getTooltipLines` would render, as
plain strings, with THIS client's player and level - so a mod's tooltip hook runs as it would under
the mouse. `advanced:true` adds the F3+H lines. Client-only, and only IN A WORLD: at the title screen item
components are not bound yet and no stack can be made from any id, so the call refuses and names
the door. `create_world` (0.130.0) is the cold path to one: a fresh, seeded world
from the title screen - flat presets by id, gamemode, difficulty, cheats, datapacks at creation,
game rules on the server's first start - the way a suite gets today's world rather than yesterday's.

## A body wearing your equipment, photographed still - `studio {entity}` (0.131.0)

Everything an equipment mod draws is a render layer over a body. `studio {equipment:{head:"...",
chest:"...", mainhand:"..."}}` stands an armor stand (or `entity:"<type>"` - a zombie, your own
mob) on the studio's invisible floor wearing stacks in full item syntax, still: no AI, no gravity,
facing the camera's stand. The reply names the entity and the box; `render {look_at:<box>}`
photographs it, `frames:N` orbits it, `leave` sweeps it. **`freeze` (default with an entity)**
freezes the game tick once the subject has arrived - /tick freeze, mirrored by the client - so
animation phase and item-model animation hold, and `render` pins the enchantment glint (which is
on the wall clock in vanilla) while the tick is frozen. Two renders of a frozen subject are
pixel-identical; that is what makes a golden-image diff mean something. `pose` is an armor stand's
six rotations, `nbt` is /summon's SNBT for everything else. Client-only, and the studio dimension
exists from a world's SECOND start.

## Driving a dedicated server - which tools answer headless

`docs/platform/HEADLESS.md` (0.129.0) is the table: every tool's execution context, generated from
the bridge's own manifest column (`context` on `GET /tools`). `server` tools need a loaded world,
`any` tools only the bridge, `client` tools are never registered on a dedicated server - absent
from its manifest, not present and refusing. A suite writes its headless tier against that file;
`ping.clientPresent` is the live answer. And `ping.build` is what a suite reads BEFORE trusting an
instance: `mods[].origins[].mtime` against the jar it just built, `mods_hash` against the load it
expects, `stale:true` meaning the code on disk is newer than the JVM (a rebuild the running game
never saw - the shape of "a second runClient could not bind the port and every call answered from
the old one").

## Attaching to a normal (production) game

Most tools (~30: perception, drone, build, UI) resolve against whatever
game answers and are correct either way. The workspace-coupled ones are not, so **check `ping` first**:
it reports `env` (`development` | `production`), the absolute `gameDir`, and a per-launch
`instanceId` (if it changes mid-session, the game restarted — re-orient before acting).

Against a production instance:

- **`rebuild.ps1` refuses to run** (it would force-kill the real game and replace it with a dev
  instance). `-Force` overrides, only for deliberately doing exactly that.
- **`hotswap_class` needs explicit `file`/`dir`** — jar-loaded classes make the classpath default
  refuse loudly (it would otherwise re-read the already-loaded bytes and "succeed" changing
  nothing). Self-attach also needs `-Djdk.attach.allowAttachSelf=true` on the launcher profile.
- **Namespaces differ.** A `push_asset`/`push_data` to a namespace the attached game doesn't load
  succeeds and does nothing. **The log channel does not catch this one** — the game never scans the
  directory, so there is nothing to log; `problems` will be empty and `ok` true. What catches it is
  asking what the game is HOLDING: `query_registry {registry:'recipe', entry:'…'}` (0.92.0), or the
  matching `entry` on whatever registry your file feeds.
- **Set `MCPTK_MEMORY_DIR`.** The `mem_*` default root sits inside the mcp-server checkout
  (`mcp-server/memory-data/`, gitignored) — fine for dev, wrong for a play install. Give play
  sessions their own root via the env var in the MCP registration. Also note the offline fallback:
  with the game down, memory identity comes from `last_world.json` = *the last world any session
  attached to under that root* — the render header names the world; check it's the one you mean.

## UI iteration loop

**Superseded for screens the toolkit authors** (`SCREEN_AUTHORING_DESIGN.md`). The refusal below —
code is the single source of truth, and a live tweak would evaporate on the next `init()` — was
answered by making the destination a **document** (`assets/<mod>/ui/<screen>.ui.json`) that `init()`
re-reads: the interpreter previews it, the emitter compiles it to plain vanilla-API Java the mod
ships, and `ui_doc` / the in-game editor (`Ctrl+G`) edit it, both writing the source tree. Everything
below still applies to every screen that is NOT a document — vanilla's, another mod's, and any of
your own hand-written ones.

- Author a document: `ui_doc` (`read` / `lint` / `add` / `set` / `move` / `remove` / `generate` /
  `preview` / `attach` / `detach`), and `open_screen {ui, edit:true}` for the in-game editor. `lint`
  answers with no client and no world; `check_layout` on an open preview is its live half, and the one
  that can measure text.
- **Edit the REAL screen while it is open**: with your mod's screen up, `ui_doc op:"attach"` (or
  **Ctrl+U**, which is the same swap from the keyboard) puts the interpreter in front of it over the
  **same live menu** — real slots, real stacks, the binding values the server actually synced — and
  `detach`/Ctrl+U puts the screen back. Ctrl+G edits from there. One limit, and it is vanilla's:
  `Slot.x` is final, so a slot you drag moves in the document and **not on that screen** until you
  rebuild; the reply's `menu.slot_drift` names every slot that has already diverged.
- **Ctrl+S regenerates.** An editor save writes the document to the source tree, mirrors it into the
  loaded pack, and then runs the emitter in process, so the checked-in Java never falls behind the
  document it came from (`gradlew` cannot run while the game holds the jar — that is the whole reason
  the emitter is callable from inside the game). The running game keeps executing the OLD classes
  until a rebuild, and the status line says so. The `gen` button turns it off.
- Inspect: `get_screen` (widget tree + container slots + `status()` record), `screenshot_annotated`
  (pixels correlated to widget indices; `grid: true` for a coordinate ruler), `measure_text`
  (the one number an agent can't compute), `check_layout` (deterministic lint: offscreen, overlap,
  label overflow).
- Drive: `click` — a **pointer** verb with four modes, all targeted the same way (label / index /
  raw x,y): press, **drag** (`to_label` / `to_index` / `to_x`+`to_y`, plus `steps`), **scroll**
  (`scroll`, wheel notches, vanilla's sign — positive goes toward the TOP of the list), and
  **hover** (`hover: true`: the pointer vanilla holds is moved there and nothing is pressed, so the
  next frames render with it there — hover faces, and the tooltip zones a screen draws off the
  pointer; it stays until the next real mouse movement, and `over` names what it actually sits
  on). Hover is how a tooltip gets photographed at all: a programmatic click carries its own
  coordinates and never moves the pointer. Plus
  `send_keys` (the **keyboard**: a named key with `modifiers` and `times`, and/or `text` typed as
  characters), `set_text`, `open_screen`, `close_screen`, `get_screen_graph`.
- **Read the reply, not the boolean — in both new modes the boolean lies, in opposite directions.**
  A scroll area consumes the wheel *at either end* (`AbstractScrollArea.mouseScrolled` returns true
  whenever the widget is visible and clamps inside `setScrollAmount`), so page a list on
  `scrolled_from`/`scrolled_to`/`at_end`, never on `handled` — `handled` is exactly as true at the
  bottom. And `Screen.keyPressed` returns **false** for Tab and the four arrows *even when focus
  moved* (it builds a FocusNavigationEvent, changes focus, then falls out of the switch), so read
  `focus_before`/`focus_after`, which `send_keys` always reports.
- Sliders and tab order: a slider takes either — drag it (`click {label:"FOV", to_x: …}`; its own
  message carries the value, so `label_before`/`label_after` is the read-back) or focus it and
  `send_keys {key:"right"}`. Tab order is `send_keys {key:"tab"}`, `{key:"tab", modifiers:["shift"]}`
  backwards.
- **What this still cannot reach: a list ROW.** `AbstractSelectionList` entries are `GuiEventListener`s
  and not `AbstractWidget`s, so `get_screen` counts them in `unenumerated_listeners` and cannot name
  them — on the vanilla world list that is all eight worlds. Rows are clickable only by raw x/y, and
  scrolling one into view does not make it nameable. (RELEASE_1 §D6.)
- Loop for title-screen-reachable screens: edit layout code → `compileJava` → `hotswap_class` →
  `open_screen` → `check_layout`. Container screens can't be constructed by tool (they need a
  server-side menu): re-interact with the block after the hotswap instead.
