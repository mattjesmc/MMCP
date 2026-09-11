# Debugging

Why it crashed, why it never came up, why the game loaded your file and did nothing with it, why that
mixin might not have applied, and where the server's 50 milliseconds are going.

The theme running through this page: **Minecraft fails quietly.** Data loaders are forgiving by
design — a malformed recipe is logged and stepped over, and the reload reports success. Most of
debugging a mod is finding the place where the game already told you what was wrong.

## On this page

- [The log channel](#the-log-channel)
  - [Read `problems`, not `reloaded`](#read-problems-not-reloaded)
  - [Your own log lines](#your-own-log-lines)
- [Crashes](#crashes)
  - [A boot that never reaches the bridge](#a-boot-that-never-reaches-the-bridge)
- [What a class actually is](#what-a-class-actually-is)
- [Is it slow?](#is-it-slow)
- [Walkthrough: a recipe that will not load](#walkthrough-a-recipe-that-will-not-load)
- [An agent session](#an-agent-session)
- [Things to keep in mind](#things-to-keep-in-mind)
- [Where to go next](#where-to-go-next)

---

## The log channel

The toolkit attaches an appender to the root logger at its own mod init, and everything after that is
readable from a session with no file tail.

| Tool | What it answers |
|---|---|
| `reload_data` / `reload_resources` | `ok` plus **`problems`** — the WARN-or-worse lines logged *during that reload*, each with `level`, `logger`, `thread`, `message`, `thrown`. Any push with `reload: true` carries the same. |
| `get_log {since, level, contains, logger, limit}` | The log after the fact. `level` defaults to `warn`. |
| `error` events in `get_events` | ERROR and FATAL also arrive as events, so a session watching the stream hears about a broken pack without polling. |
| `get_log {crash: "latest" \| n \| file}` | The previous game's crash report. |
| `ping.last_crash` | Present when a report is newer than the previous boot. |

WARN and above live in a ring that INFO chatter **cannot evict**, so a warning stays findable long
after the INFO around it has rolled away. `since` is a strictly-after cursor, and a cursor the ring
has rolled past returns `gap` rather than quietly handing you a short page.

`error` events are deduped per logger+message over 10 seconds and capped per window — `repeats` and
`flood_suppressed` say how many lines an event stood for, and `get_log` still holds every individual
one.

### Read `problems`, not `reloaded`

This is the single most valuable habit on this page.

`reloaded: true` means the reload ran. It says **nothing** about your file. Vanilla's
`SimpleJsonResourceReloadListener` logs a file that fails its codec at ERROR and then steps over it;
the reload completes normally. The same is true on the client — a model naming a missing texture is
logged and skipped, and `reload_resources` comes back clean.

So read `problems`. `ok: false` means the game logged something during your reload — usually yours,
occasionally not, which is why every line names its logger instead of the answer being reduced to a
boolean.

**Two limits, stated:**

- **Not everything wrong is logged.** A push to a namespace the game does not load is silent, because
  the game never scans it. So is a recipe that parses fine and simply is not the recipe you meant.
  This channel catches **rejection**, not **disagreement**.
- **Capture starts at mod init.** The loader's own phase — mod resolution, mixin apply — is in
  `logs/latest.log` and not in the ring.

### Your own log lines

`get_log {logger: "yourmod", level: "all"}` reads your own SLF4J calls back out of a running game.
You get this for free — the appender is on the root logger, so whatever your mod logs is already
there.

`logger` is a substring match on the logger's name: your mod id if you used
`LoggerFactory.getLogger(MOD_ID)`, the class FQN if you used `LogUtils.getLogger()`.

**`level: "all"` includes DEBUG in a dev run, and it is mostly Mixin and Netty.** Measured on a quiet
dedicated-server boot: 82 DEBUG, 28 INFO, 4 WARN out of 114 lines. That is why the rings are split
and why `warn` is the default — the all-levels ring turns over fast, the problems ring does not. It
is also why filtering by *your own logger* is the useful shape when you are debugging one mod.

`get_log` is a dev tool: hidden from the player-legal profiles, because a body perceives the world,
not the server's stderr.

## Crashes

`get_log {crash: "latest"}` reads the previous game's crash report — the one line the in-JVM ring can
never hold, because the ring dies with the JVM. Vanilla wrote it to `<gameDir>/crash-reports/`; this
reads it properly.

You get the title, exception, thread, the head trace's top frames and each cause's, and — the useful
part — **every frame attributed to the mod whose jar loaded its class**. The class resolves to its
code source, the code source to a mod through the loader's mod list, identically on Fabric and
NeoForge. `suspect` is the first frame that is somebody's mod. The loader's own "Suspected Mods"
section comes along as a secondary field when it wrote one.

A frame no loaded jar provides is reported as **`unresolved`, not guessed**. That is what a report
from another project's game looks like, and it is also what the very class a `NoClassDefFoundError`
is about looks like.

`ping.last_crash {at, path, title}` is present when a report is newer than the previous boot, so a
session that starts after a crash **learns about it without asking**.

### A boot that never reaches the bridge

A bad mixin or a missing dependency dies before `ping` exists. There is no tool to ask, and that is
not a gap that can be closed.

What you have instead: `launch_game`'s log on an exit-1 launch ends with the header of any crash
report the game wrote during that launch, plus the tail of its `logs/latest.log`. That is where the
reason is. Once a game is up again, `get_log {crash}` reads the same report properly.

## What a class actually is

```
query_class {class: "net.minecraft.server.MinecraftServer"}
```

Reflection over the **loaded** class — the one thing a decompiled tree and an IDE cannot do. They
answer from source, and source says what a `@Mixin` *intends*.

It returns the post-transform method table and field types, the superclass and interface chain, the
class loader, **the file on disk the class was loaded from**, the mixins with merged methods in it,
and a `hotswap` precheck.

Four facts that bite:

- **Mixin detection is by `@MixinMerged`, and that marker rides on methods.** An injector leaves a
  handler method behind and is visible. A mixin that only adds an interface, or only widens access,
  leaves no method and **cannot be seen this way**. `mixins.detection` names the mechanism, so an
  empty `applied` reads as "no merged methods" rather than as "no mixins".
- **`contains` is how you use it on a Minecraft class.** `MinecraftServer` has 275 declared methods
  and 101 fields; the full table is not something to read. Counts are always exact and `truncated`
  says how many were left out — filter, do not page.
- **The lookup itself is reported.** With an instrumentation agent attached (any `hotswap_class` in
  the session attaches one) the loaded-class list is the authority, and a class not in it is reported
  `loaded: false` — a real answer, since a class loads only when something touches it. Without the
  agent it falls back to `Class.forName(name, false, …)`, which *loads* a class that was not loaded;
  `lookup: "class_forname"` plus a `lookup_note` say so rather than pretending the read was free.
- **It is not for static questions.** What a class's *source* says is `vanilla-src/` and grep. This is
  for what the JVM ended up with.

The `hotswap` block is also the precheck before `hotswap_class`: `classpath_default` says whether the
default byte source will find fresh bytes, and `safe` says whether the class may be redefined at all
(false for a mixin target or a Minecraft class). Same verdict, one call earlier.

## Is it slow?

```
get_perf {}
get_perf {hooks: true, top: 20}
```

Two resolutions in one call. **`mspt`** — mean, p50, p95, max over vanilla's own last-100-tick ring,
plus derived `tps` and `tick_rate`. **`levels[]`** — per dimension: loaded and force-loaded chunks,
pending chunk tasks, block and fluid ticks, entity and *ticking* block-entity counts, the commonest
types of each, and `hot_chunks` with coordinates you can teleport to.

Facts that bite, and several of these will otherwise cost you a wrong conclusion:

- **Read `tick_rate.runs_normally` first.** `/tick freeze`, `/tick sprint` and a non-20 tickrate each
  make every millisecond mean something different, and all three are one command away in a dev world.
  A reading taken under any of them carries a `note`.
- **A ticking block entity is not the same as a block entity.** A chest has no server ticker and never
  appears here; a hopper always does. This is a census of tick cost, not of inventory.
- **The ranked lists are top-N and say how much they left out.** `top` defaults to 5, and each list
  carries an `*_omitted` count. This matters the moment you compare two readings: a type absent from a
  truncated list has an **unknown** count, not a zero — and in an established world the type you are
  hunting is routinely ranked sixth. Raise `top` before reading an absence, and use the same `top` for
  both readings or you are comparing two different questions.
- **`hooks: true`** adds the toolkit's own per-listener tick cost since boot, for ruling out the
  instrument before blaming the mod.
- **Let a region settle.** A chunk streaming in mid-measurement brings its block entities with it —
  the first probe run found a mob spawner arriving eight seconds after a `forceload add`.
- **Settling is not the same as quiet.** An established world's ticker total drifts on its own; a
  spawner three million blocks away is under no obligation to agree with your test. Do not assert an
  *identity* on a world-wide count across an edit. Assert the delta you caused, scope the claim to the
  type census, or measure the drift first with two readings and nothing between them.

**There is no profile mode, and that is not an oversight.** In 26.2 `/debug start`…`/debug stop`
measures duration and tick count only — `TimeProfiler.stop()` returns results whose `getTimes` is
unconditionally empty, so a tool built on it would report an empty tree. The real tree is behind
`startRecordingMetrics`, which writes a whole debug-report directory to disk and blocks the server
thread doing it: a privileged act, not an observe read. And even that would not name the expensive
block entity *type*, because vanilla ticks the whole block-entity list inside one section. The census
is what answers "which".

## Walkthrough: a recipe that will not load

The four questions, in the order that eliminates the most per call.

**1. Does the game have it?**

```
query_registry {registry: "recipe", entry: "mymod:copper_lantern"}
```

`exists: false` — so this is not a recipe-book problem.

**2. Do the bytes decode?**

```
push_data {path: "data/mymod/recipe/copper_lantern.json", file: "...", dry_run: true}
```

`valid: true` — well-formed, and rejected on load. That means a **reference**, not syntax.

**3. What did the game say?**

```
get_log {logger: "minecraft", level: "all"}
```

There is the skip line, naming what it could not resolve.

**4. If nothing is in the log,** check you are pushing into a namespace the game actually loads —
that failure is silent, because the game never scans it.

## An agent session

> **You:** the game crashed when I placed the lantern.

> **Agent** calls `ping`
> → `last_crash: {at: "...", title: "Ticking block entity", path: "crash-reports/..."}`
>
> It knew there had been a crash without being told.

> **Agent** calls `get_log {crash: "latest"}`
> → the exception, and `suspect: "mymod"` — the first frame belonging to somebody's mod is
> `CopperLanternBlockEntity.tick`, attributed to your jar.

> **Agent:** it is your block entity's tick, dereferencing a null level on the first tick after
> placement.
>
> Then it calls `query_class {class: "com.example.mymod.CopperLanternBlockEntity"}`
> → `hotswap: {classpath_default: true, safe: true}`.
>
> So this is fixable without a restart: it is a method body.

> **Agent** fixes the guard, runs `gradlew compileJava`, calls `hotswap_class`, then places another
> lantern and reads `get_log {logger: "mymod", level: "all"}` to confirm the tick is running clean.

The chain: **`ping` volunteered the crash**, the report **attributed the frame to a mod** rather than
leaving you to read a stack trace, and `query_class` **decided the fix route before attempting it**.

## Things to keep in mind

**A green reload is not a loaded file.** Read `problems`, not `reloaded`. This is the most expensive
thing on this page to not know.

**The log catches rejection, not disagreement.** A recipe that parses and is simply wrong is silent.
So is a push to a namespace the game does not scan.

**Capture starts at mod init.** Mod resolution and mixin apply are in `logs/latest.log`.

**A boot that dies before the bridge has no tool to ask.** Read `launch_game`'s exit-1 log tail.

**An empty `mixins.applied` is not "no mixins".** Detection rides on merged *methods*; an interface-
only or accessor-only mixin is invisible to it, and `mixins.detection` says so.

**`query_class` is about the loaded class, not the source.** For what the source says, grep
`vanilla-src/`.

**Read `runs_normally` before reading any timing.** A frozen or sprinting tick makes every number
mean something else.

**A type missing from a top-N list has an unknown count, not zero.** Raise `top` before concluding an
absence, and use the same `top` on both sides of a comparison.

**Do not assert identity on world-wide counts.** The world drifts on its own. Assert the delta you
caused.

**Filter the log by your own logger.** `level: "all"` in a dev run is mostly Mixin and Netty.

## Where to go next

**In this wiki**

- [The change loop](the-change-loop.md) — hotswap versus rebuild, and the routing `query_class`
  informs.
- [Recipes, loot and tags](data-recipes-loot-tags.md) — the three questions about a data file.
- [Mod testing](mod-testing.md) — turning these reads into checks that run without you.
- [Troubleshooting](troubleshooting.md) — symptom-first list of the usual suspects.

**Reference**

- `LIVE_MODDING.md` § *Did it actually load?* — the log channel, the rings, the crash reader.
- `LIVE_MODDING.md` § *What a class ACTUALLY is* — `query_class` in full.
- `LIVE_MODDING.md` § *Is it slow, and what is it?* — `get_perf`, and why there is no profile mode.
- `LIVE_MODDING.md` § *Will it load?* — codec validation before the write.
