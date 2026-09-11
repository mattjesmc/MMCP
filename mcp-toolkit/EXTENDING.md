# Extending the MCP Toolkit

How another mod ships its own MCP tools, and how modded content teaches the toolkit's classifiers
about itself. For the reasoning behind these seams see `EXTENSION_DESIGN.md`; for the vocabulary they
sit inside (perception modes, mechanisms, sensor vs actuator seams) see `ARCHITECTURE.md`.

Requires toolkit **0.41.0+**; the loader-neutral declaration in step 2, and NeoForge support, require
**0.83.0+**.

## Quickstart

**1. Depend on the toolkit.** It resolves from your local maven repo; `./gradlew build` in this
project publishes it there, so there is no separate publish step to remember (a bare
`./gradlew publishToMavenLocal` works too). This project is its own build root - it is not a
subproject of any mod, and nothing should depend on it by project path.

```groovy
repositories {
    // This group ONLY. An unfiltered mavenLocal() lets a stale locally-installed copy of any
    // dependency shadow the real one, which is a quiet way to build against the wrong thing.
    mavenLocal { content { includeGroup 'com.mattmc.mcptoolkit' } }
}
dependencies {
    compileOnly "com.mattmc.mcptoolkit:mcp-toolkit:${project.mcptoolkit_version}"
}
```

Keep the version in `gradle.properties` as `mcptoolkit_version`, never inline in the coordinate —
upgrading is then one number in one place. Do **not** depend on this project's `build/libs/` by
path: that couples you to another project's build output, so a `clean` over there breaks you here,
and it stops working the moment the toolkit moves to its own checkout.

`compileOnly`, not `implementation`: your mod must run fine without the toolkit installed. The
exception is a **workspace sibling** that wants the bridge live in its own `runClient` — there,
`implementation` is correct, because it also puts the toolkit mod on the dev runtime classpath so
the loader picks it up. `menagerie` and `rocketeer` in this workspace both do that.

**Degrading when it is absent.** Gradle has no "resolve only if present", so an optional dependency
has to be probed for before it is declared. The pattern both sibling mods use:

```groovy
def toolkitVersion = project.mcptoolkit_version
def m2Root = file(System.getProperty('maven.repo.local') ?: "${System.getProperty('user.home')}/.m2/repository")
def toolkitDir = new File(m2Root, 'com/mattmc/mcptoolkit/mcp-toolkit')
def toolkitAvailable = new File(toolkitDir, "${toolkitVersion}/mcp-toolkit-${toolkitVersion}.jar").exists()
```

...then guard both the dependency and (if you have one) the source-set exclusion on
`toolkitAvailable`. Make the miss **loud** — `logger.warn`, naming the version you wanted and the
versions actually installed. A silent skip means a forgotten publish shows up as a mod that quietly
lost a feature rather than as an error.

**2. Declare your extension.** One resource file, named after the interface, on every loader:

```
src/main/resources/META-INF/services/com.mattmc.mcptoolkit.McpToolkitEntrypoint
```
```
com.example.mymod.mcp.MyModTools
```

One implementation class per line; `#` starts a comment. This is `ServiceLoader`'s file and grammar,
but the toolkit reads it itself rather than calling `ServiceLoader` — see *Why not `ServiceLoader`*
below. On Fabric, keep declaring the toolkit optional so your mod still runs without it:

```json
"suggests": { "mcptoolkit": "*" }
```

and on NeoForge, the `neoforge.mods.toml` equivalent:

```toml
[[dependencies.mymod]]
modId = "mcptoolkit"
type = "optional"
```

Nothing else. The service file needs no module or `usesServices` declaration, because no
`ServiceLoader` lookup happens.

**Fabric's `entrypoints` block still works** and is what shipped from 0.41.0 to 0.82.0:

```json
"entrypoints": { "mcptoolkit": ["com.example.mymod.mcp.MyModTools"] }
```

It has no NeoForge analogue, so a mod that wants to work on both loaders declares the service file.
**A jar that declares both is discovered once, through the service file** — which is the shape that
lets one jar keep working on toolkit 0.82.0 and earlier (it only reads the entrypoint) while using
the new path on 0.83.0+, with no double registration in between.

**3. Write the class.**

```java
public final class MyModTools implements McpToolkitEntrypoint {
    @Override
    public void registerTools(ToolRegistrar registrar) {
        registrar.register(ToolDef.of(
            "mymod_reactor_status",
            "Report the state of the reactor at (x,y,z): fuel, temperature, and whether it is "
                + "running. Returns {fuel, temperature_c, running}.",
            Schemas.object("pos", Schemas.vec3i()),
            ExecutionContext.SERVER,
            Mechanism.OBSERVE,
            (ctx, args) -> readReactor(ctx.serverOrThrow(), args)));
    }
}
```

That's the whole integration. Your tool appears in `GET /tools` and is callable by any connected MCP
session; no Node-side change is needed, and every profile shows it (profiles hide named tools, they
don't allow-list).

**Worked example:** `VillageJobsTools.java` (`src/main/java/com/mattmc/villagejobs/mcp/`) in the
sibling villagejobs checkout (`../../villagejobs`, the toolkit's first customer) — six real tools
across three mechanisms.

### Why a declaration rather than calling `McpTools.register` yourself

Your class is loaded only when the toolkit asks for it — discovery reads the service file and loads
nothing. If the toolkit isn't installed, your class is never touched, so you need no `isModLoaded`
guard and cannot crash a toolkit-less game by accidentally referencing a toolkit class. The corollary
is a rule: **never reference your entrypoint class from your own init path.** That reference is
exactly what would load it — and crash — in a game without the toolkit.

### Why not `ServiceLoader`

Because of what one broken mod would cost the others. `ServiceLoader` resolves each provider inside
`hasNext()` and throws `ServiceConfigurationError` out of the iterator, so a single mod built against
a different toolkit version would abort the whole iteration and every *later* extension would lose its
tools. Reading the file by hand means the scan touches no class at all; the class name is resolved
inside the same per-mod `try` that already contains a throwing `registerTools`, so a failure costs
exactly the mod that caused it.

That is also why your `modId` is never something you declare: it is read off *where the file was
found*, so it cannot disagree with the mod that shipped it.

## The contract

Registering a tool is a promise about how it behaves. These are binding.

**Declare the real `Mechanism`.** `OBSERVE` reads and mutates nothing. `EMBODIED` is a body
performing a game-mediated act that can fail on the game's own terms. `WORLD_EDIT` is a direct server
edit. `PRIVILEGED` is authority beyond world blocks — commands, disk writes, reloads. It is stamped
into the manifest and every dispatch result, so a session can reason about what kind of act it just
authorized. An untagged world-edit masquerading as a read is the specific bug the field exists to
prevent.

**Pick the right `ExecutionContext`.** `SERVER` runs on the server thread and requires a loaded world;
`CLIENT` runs on the render thread and never exists on a dedicated server; `ANY` runs on the HTTP
thread and must not touch game state. The bridge marshals for you and reports a clean error when the
loop isn't available.

**Async handlers must not block the target thread.** Use `ToolDef.async` when a result can only be
produced later (a render frame, an action that completes over ticks) and complete the future then.
Blocking the game thread waiting for the game thread deadlocks the game.

**Report what actually happened.** A tool that returns success because it *issued* an action, rather
than because the action *worked*, is the failure class this toolkit spent a whole release removing
(`ARCHITECTURE.md`, "Act verdicts are verified"). Verify the effect and return an honest reason when
it didn't happen. Say "unknown" rather than guessing — a confident wrong answer is worse than no
answer.

**You are the schema authority.** Your `inputSchema` is forwarded to the client verbatim. Write the
description for a reader who cannot see your code: what it does, what it returns, and what the
failure reasons mean.

**Your tool is served on both doors, and you do not have to do anything for that.** A registered tool
appears in the `/tools` manifest the Node server proxies AND in the `tools/list` of the game's own
MCP server (`docs/platform/IN_JAR_MCP_DESIGN.md`), which dispatches through the same
`BridgeServer.execute` chokepoint. The one thing to know: the in-jar server's `observe` surface is
computed from the `Mechanism` you declared, so a read you tag `WORLD_EDIT` out of caution is a read
that a read-only session cannot call. Declare the real one.

**Register definitions, not resolved objects.** `registerTools` runs during the toolkit's init: other
mods' registries may not be populated and no world is loaded. Resolve blocks, items and levels inside
the handler, when it is called.

## Naming

The tool namespace is flat and shared with the builtins and every other extension. **Prefix your tool
names with your mod id** (`mymod_reactor_status`). A name that is already taken is skipped — not
thrown — and recorded as a registration failure for your mod.

(Village Jobs' six tools predate this convention and keep their unprefixed names.)

## Modded data recognition

Anything keyed by **identity** already works: the toolkit reads the live registries, so `query_registry`
lists your blocks, items, entities, biomes and POIs, and `locate` resolves your ids and `#tags` against
the structure/POI/entity/biome/block indexes. Since 0.92.0 the same tool reads one entry back —
`query_registry {registry:'block', entry:'yourmod:thing'}` returns the blockstate properties, the
default state and **the tags your datapack put it in**, and `{registry:'recipe', entry:'yourmod:…'}`
answers whether your recipe survived its codec. That is the check for a tag join below actually
taking effect, rather than assuming it did. Most affordances are read off the `BlockState` itself
(`solid`, `pass`, `repl`, `tool`, `unbreakable`), and hostility comes from `MobCategory` — all correct
for modded content with no work from you.

Two things the game does not expose behaviorally are tag-driven, so join these if they apply:

| Tag | What it changes |
|---|---|
| `#mcptoolkit:contact_hazards` | Your block reads as `hazard` in every perception payload, and the walker's pathfinder prices it as damaging so routes avoid it. |
| `#mcptoolkit:crafting_stations` | `bot_craft` will look for your block as a 3×3 crafting station. (This makes it *findable*; a station with a bespoke menu may still refuse to be driven.) |

**The tag covers the 3×3 bench only, and that is a stopping point rather than an oversight.** Since
0.88.0 `bot_craft` also runs **smithing** and **stonecutting** recipes, but it finds those stations by
vanilla block identity (`Blocks.SMITHING_TABLE` / `Blocks.STONECUTTER`), because the rule being
borrowed is vanilla's own `SmithingMenu.isValidBlock` / `StonecutterMenu.isValidBlock`. A modded
smithing table is therefore **not** findable today. The tag answers "is this a bench", and there is no
equivalent question for a station whose recipes are keyed by `RecipeType` — if you need this, say so
and it becomes a second tag rather than a guess.

Add `data/<yourmod>/tags/block/...` entries as usual — or, for a quick experiment, push one live with
`push_data` and `reload_data`. Read the reload's `ok` / `problems`, not `reloaded`: a malformed tag
*does* fail the reload and is reported, but a malformed recipe or loot table is logged and stepped
over by vanilla, and the reload then succeeds with your file not loaded (see LIVE_MODDING.md, *Did
it actually load?*).

These tags **add to** a built-in vanilla floor rather than defining it, so the toolkit's classification
of vanilla blocks never depends on a datapack loading. Note that a mod's own `data/` directory is only
loaded as a datapack when `fabric-resource-loader` (part of fabric-api) is present; the toolkit itself
is loader-only, which is exactly why the vanilla floor lives in Java.

Items that block attacks (shields) are detected by the `BLOCKS_ATTACKS` data component, so a modded
shield works with no tag at all.

## Asking a human to look at something

Requires toolkit **0.77.0+**.

Your mod's design documents end their records saying nobody has looked at the thing yet. The toolkit
has a queue for exactly that: an agent (or you) posts an ask, a person walks it with `/mmcp review next`,
and the verdict comes back where the next session will find it — `review_status`, or
`<server dir>/review/answers.md`.

**Declare your subjects from your own enums**, in your `mcptoolkit` entrypoint, so the list cannot
drift from the code:

```java
Review.declare("mymod", () -> Stream.of(Reactor.values())
    .map(r -> Review.ask("reactor/" + r.id(),
            "Does the " + r.id() + " reactor read as running?",       // the question
            "the core glow and the exhaust plume, from 10 blocks back", // where to look
            "no plume, or a glow that does not pulse")                  // what WRONG looks like
        .withSetup("mymod stage reactor " + r.id()))
    .toList());
```

The supplier runs on **every server start**, on the server thread, with the world loaded. Existing
answers survive; descriptions refresh; a subject you stop declaring stops being asked (unless it
carries a verdict, which is kept as history). A supplier that throws costs only its own mod's
subjects.

Four things are worth knowing before you write asks:

**`failure` is required and the constructor throws without it.** An ask that cannot fail collects a
nod rather than a judgement. If you cannot say what wrong looks like, you do not yet have a question
worth a person's time.

**Staging is server commands, nothing else.** That is what lets the walk live in the toolkit instead
of in your mod: a command crosses the mod boundary, a Java callback cannot. Expose one `stage`
command of your own and name it in `withSetup(...)`. The commands run at the reviewer's own
permission level, so the queue file is as trusted as the console — it is written by whoever already
has the console, so this grants nothing new, but it should never be a surprise.

**What your stage command PRINTS is kept.** The last line each setup command prints becomes the
ask's staging note and rides the verdict into the file. Print the thing that makes the subject
reproducible — the seed you drew, the coordinates you built at — and a rejection three weeks later
can be stood in front of again.

**`withCheck("<command>")` means no human is spent.** If a command can decide the question (`execute
if block …`), give it one: the ask closes itself as `checked` at server start, and a person is never
sent to confirm what the world already says. It is filed as `checked` rather than `ok` because those
are different facts, and it re-opens by itself if the world stops satisfying it.

Everything else — the file, the walk, the per-player cursor, the on-screen card, the verdicts, the
`review_post`/`review_status` tools — is the toolkit's. Your mod supplies the two things only it
knows: what the subjects are, and one command that stages one.

## Contributing a kit or an agent-client adapter

Requires toolkit **0.104.0+**.

Two more seams hang off `McpToolkitEntrypoint` as `default` methods, so an extension that implements
the interface as a lambda keeps compiling and linking across the version that added them:

```java
public final class MyModTools implements McpToolkitEntrypoint {
    @Override public void registerTools(ToolRegistrar registrar) { /* ... */ }

    /** Launchable bundles: a workspace, a tool profile, the files that orient an agent. */
    @Override public void registerKits(KitRegistrar registrar) {
        registrar.add(Kit.builder("my-kit", "mymod")
            .label("My Kit")
            .description("What a human sees on the launch button's tooltip.")
            .workspace("mymod/sessions")
            .profile("play")
            .mode(LaunchMode.ATTENDED)
            .file(KitFile.of("mymod/kits/CONTEXT.md", "CONTEXT.md",
                FileRole.PROJECT_CONTEXT, WritePolicy.reconciled()))
            .prompt("You are ...")
            .requires(Capability.SERVER_REGISTRATION)
            .prefers(Capability.PROJECT_CONTEXT_FILE)
            .build());
    }

    /** Adapters for agent clients the toolkit does not bundle. */
    @Override public void registerAgentClients(AgentClientRegistrar registrar) {
        registrar.add(new MyAgentClient());
    }
}
```

Bundled templates named by a `KitFile` are resolved against **your** mod's jar, so the resource path
is a path inside your own resources. A kit id or client id already taken is refused and recorded
against your mod (visible in `ping`) rather than allowed to shadow anyone else's, and a throw from
either method is contained exactly like a throw from `registerTools`.

**The one rule that matters: `requires` is a promise about the human's client, not about yours.** A
kit that requires a capability the configured client does not declare is refused *by name*, before
anything is written. A kit that merely `prefers` it launches with those pieces skipped and says so.
Requiring nothing you do not truly need is what keeps your kit usable on somebody else's setup;
requiring something you do need is what stops it launching into a session that quietly does not work.

Registering an agent client does **not** select it — `agent.client` in
`config/mcptoolkit.properties` does. The full adapter guide, including the verification to run, is
`docs/guides/ADAPTER.md`; the design record is `AGENT_CLIENT_ADAPTER_DESIGN.md`.

## Running an authoring loop on the toolkit

Requires toolkit **0.122.0+**. A project that authors many units of one kind — parts, skins,
screens, structures — declares its loop in `.mcptoolkit/loop.json` beside its `.mcp.json`: a checker
that runs after every editing call and rides the reply, a save gate, and a keep-list profile with
sentences appended to the tools' descriptions. Nothing in the project is a proxy server; the
checker is one script with a JSON line at the end. The how-to, the cost arithmetic, and the levers
in the order to pull them are `docs/guides/LOOPS.md`; the design record is `LOOP_KIT_DESIGN.md`;
`tools/loop/` holds the agent-definition template, the one-session-per-unit runner and the cost
analyser.

## Building an editor on the toolkit

Requires toolkit **0.90.0+**.

A mod that authors content — creatures, machines, dungeon rooms — eventually wants an editor: a
loop tighter than "rebuild and go look". You do not have to build that loop. Four seams already
carry it, and none of them is new toolkit code you have to wait for:

1. **Tools** — the `McpToolkitEntrypoint` above, for anything that needs a manifest presence. Price
   it first: a tool entry is a per-turn tax on every session that loads the toolkit, and it lands in
   *every* profile. Menagerie's editor registers **no tools at all** — it drives its own Brigadier
   commands through `run_command`, which is the zero-manifest-cost default and the right reach
   unless an agent genuinely needs to call the thing by name.
2. **Assets** — `push_asset` / `mcptoolkitPush` / the live pack, unchanged. Bytes travel
   Blockbench → bridge → game without passing through a transcript.
3. **Preview** — `stage_entity` for raw geometry (the toolkit's own preview entity wears whatever
   you push, `LIVE_MODDING.md`), and *your own stage command* for anything your runtime generates.
   A menagerie creature is decoded by menagerie; the toolkit never re-models it, because a second
   implementation of a mesh is the one that drifts.
4. **The review queue** — the section above. An editor's output is exactly the kind of thing that
   ends a design document unlooked-at.

### The conventions, which are conventions and not a framework

Proven by two editors: menagerie's divisions panel (`menagerie/blockbench/` — the worked example)
and the toolkit's own entity plugin. They are written down rather than shipped, because
generalising a form language out of one instance is how you get a framework the second editor does
not fit.

- **The mod generates the vocabulary; the panel hardcodes none.** Menagerie's `./gradlew blockbench`
  writes a vocab JSON from its own enums and codecs, and every dropdown in the panel comes from it.
  A panel holding its own model of the mod goes stale silently — and the check that keeps it honest
  asserts *the seam*, not the values, so the catalog growing is not a red test.
- **Derived facts are MEASURED through the mod, never re-derived in the editor.** Ask the mod's own
  CLI, codec or command what a thing is. Two implementations of one derivation is one
  implementation and one bug with a schedule.
- **Never make Gradle a tool's inner loop.** `./gradlew <anything that compiles>` writes
  `build/classes`, and a dev client has `build/classes` on its classpath — an editor probing through
  Gradle would recompile under the running game on every keystroke, and that failure does not look
  like a build problem when it finally lands. Emit a Java `@argfile` once (a task that writes
  `-cp "…"`) and run `java @file MainClass …` directly: ~0.8 s, no daemon, nothing written into
  `build/classes`.
- **The datapack format IS the file format.** What the editor writes is the file the game loads — no
  export step, no second schema. Its trap comes attached: a datapack-backed **dynamic registry**
  does not reload on `/reload` (`MinecraftServer.reloadResources` passes `this.registries` through
  untouched), so the panel must say *leave and re-enter the world* rather than report a reload that
  changed nothing.
- **Headless APIs never reject.** Resolve `{ok: false, error}`. Under the third-party Blockbench
  MCP plugin a rejected Promise returned through `risky_eval` was an unhandled rejection inside its
  HTTP server and wedged every later call; the toolkit's own bridge plugin (0.133.0) turns a
  rejection into an error reply, but an API that resolves its failures is still the one whose
  result a caller can read without a try/catch, and the rule stands.
- **Mirror the last result into a global** (`mcptoolkitEntityLast`, `menagerieDivisionsLast`). When
  a Promise result does not make it back across the bridge, that global is the difference between a
  re-run and a mystery.

### If your editor converts geometry: the flip, and who the arbiter is

Blockbench and vanilla do not share a coordinate space, and the conversion is small enough to look
obvious while being wrong in exactly one way. The rule, read out of **Blockbench's own
`modded_entity` codec** (`Codecs.modded_entity.compile`, plain text inside `resources/app.asar` in
any Blockbench install):

- **Pivots**: `x *= -1; y *= -1`, then `y += 24` for a root bone only.
- **Rotations**: `(-rx, -ry, +rz)`, and **radians** on the vanilla side (`PartPose.offsetAndRotation`).
- **Euler order needs no conversion at all**: vanilla composes `Quaternionf.rotationZYX`
  (`ModelPart.java:169`) and Blockbench composes a `THREE.Euler` whose `Format.euler_order` defaults
  to `ZYX` — the same order.

Two negations, not one, because vanilla renders entity models through `LivingEntityRenderer`'s
`scale(-1, -1, 1)`. **Flipping only y mirrors every model left-for-right**, and a symmetric subject
hides it completely — which is why the arbiter matters more than the rule. The arbiter is the codec:
not a design doc, and not another tool's converter. Menagerie's `CensusTool.bbmodel()` flips only y
and is *correct*, because it targets Blockbench's `free` format — a different destination. Following
it here would be following a right answer to a different question.

"Negate x and y, keep z" is also exact for **three-axis** rotations, not merely the single-axis case
real models happen to use: `diag(-1, -1, 1)` is a 180° turn about Z, a *proper* rotation, so
conjugating by it rewrites `Rz(c)Ry(b)Rx(a)` as `Rz(c)Ry(-b)Rx(-a)` — term by term, order intact.

**Check it with two independent walkers, not a golden file.** Byte-stability proves an exporter is
deterministic and says nothing about whether its numbers are right; a golden file only ever agrees
with whatever the exporter did the day it was written, which trains its readers to edit numbers.
`blockbench/mcptoolkit_entity.test.mjs` walks the `.bbmodel` by Blockbench's rules and the emitted
JSON by *vanilla's*, and asserts that every cube's eight corners line up under
`(x, y, z) → (-x, 24 - y, z)`: one assertion covering the pivot subtraction, both sign flips, the
ground offset, the rotation conjugation and the Euler order at once — and unsatisfiable by copying
the exporter, because neither walker knows the exporter exists.

Two findings from that harness which any second one will meet:

- **A corpus covers only the vocabulary it happens to use.** Not one of the fifteen `.bbmodel`
  sources this workspace's own harness reads uses cube rotation, cube inflate or mirrored UV, so
  the most intricate limb of
  the conversion had no real subject at all and needed a fixture that is deliberately asymmetric in
  every dimension — a wrong sign cannot hide behind a symmetry it does not have.
- **A `java_block` project converts plausibly and wrongly**, because it is authored inside a 0..16
  block rather than standing on the entity ground line. Warn on the format rather than demanding
  every project convert.

## Testing your extension

`ping` is the diagnostic: its `extensions` array lists each extension mod, the tools it registered,
and any failures (a throw, or a name collision). If your tool is missing from the manifest, look
there first — that is where a silently-skipped registration is recorded.

**`get_log` is the second diagnostic** (0.91.0), and it needs nothing from you: the toolkit attaches
an appender to the root logger at its own mod init, so **whatever your mod logs is already in it** —
`get_log {logger: "yourmod", level: "all"}` reads your own SLF4J calls back out of a running game
without a file tail. `logger` is a substring match on the logger's name, which is your mod id if you
used `LoggerFactory.getLogger(MOD_ID)` and the class FQN if you used `LogUtils.getLogger()`.

Three boundaries, so you know what you are looking at:

- **It sees whatever the game's own root logger admits.** In a Loom dev run that includes **DEBUG**
  (measured on a quiet dedicated-server boot: 82 DEBUG, 28 INFO, 4 WARN), so your `logger.debug` is
  readable live. A production install configured at INFO passes no DEBUG to anyone, this tool
  included — it reads the same stream the file does, it does not widen it.
- **`level` defaults to `warn`** and DEBUG only appears under `level: "all"`.
- **Capture starts at mod init**, so a failure during mod resolution or mixin apply is in
  `logs/latest.log` and not here. Anything your mod logs at ERROR also arrives as an `error` event
  in `get_events`, deduped and rate-limited.

Manifest entries from an extension carry `"source": "<your mod id>"`; toolkit-owned tools carry no
`source` key.

For probes, `mcp-server/probes/extension.test.mjs` is the pattern: hit the bridge's `/cmd` directly
with an `X-MCPTK-Session` header, and skip cleanly when the bridge is down. If you contribute tools
to this repo's probe suite, add a `conformance.test.mjs` spec with `ext: "<your mod id>"` so the
ratchet skips it when your mod isn't loaded instead of calling it stale.
