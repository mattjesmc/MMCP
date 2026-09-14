# The change loop

The everyday rhythm of modding with a live bridge. **What you changed decides how it reaches the
game**, and only one of the routes costs you a restart. Getting this right is the difference between
a ninety-second wait per iteration and a two-second one.

Since 0.156.0 there is a route above all of them where you call nothing at all: you save the file
and it is in the game. That is the first section, because if you are running the daemon it changes
what the rest of this page is *for* — it stops being a set of instructions and becomes the map of
what is happening on your behalf.

This page covers the routes, how to confirm a change actually landed (harder than it sounds), and
how to move a change from the live preview into your source tree when it is right. It does not cover
what to *do* with each kind of content — those are the [Making things](README.md#making-things)
pages.

## On this page

- [The shortest route: write the file](#the-shortest-route-write-the-file)
- [The decision table](#the-decision-table)
- [How it works: three different mechanisms](#how-it-works-three-different-mechanisms)
  - [Live packs — assets and data](#live-packs--assets-and-data)
  - [Hotswap — Java method bodies](#hotswap--java-method-bodies)
  - [Rebuild — everything structural](#rebuild--everything-structural)
- [Did it actually load?](#did-it-actually-load)
- [Promotion: from preview to source](#promotion-from-preview-to-source)
- [Walkthrough: one texture, one recipe, one method](#walkthrough-one-texture-one-recipe-one-method)
- [An agent session](#an-agent-session)
- [Things to keep in mind](#things-to-keep-in-mind)
- [Where to go next](#where-to-go-next)

---

## The shortest route: write the file

With `mmcpd` running and your project added to it ([Getting
started](getting-started.md#optional-one-daemon-for-every-project)), the daemon watches your
project's `src/` and lands every change in the running game itself. You save a texture in your
image editor; about five seconds later it is on the block you are looking at. Nobody called
`push_asset`. An agent working in your repository gets the same thing from an ordinary file
write — it does not need to know the routing table at all.

**What it does with each kind of file** is exactly the decision table below, applied for you:

| You saved | It calls |
|---|---|
| A texture, model, blockstate, sound or lang file under `resources/assets/` | `push_asset`, then **one** `reload_resources` for everything that went quiet together |
| A `.ui.json` screen document | `ui_doc refresh` — the op that mirrors your source file into the loaded pack and re-parses it |
| Anything under `resources/data/` | `push_data`, then one `reload_data` (a world has to be loaded) |
| A `.java` file | **one** `hotswap_class {compile: true}` for the whole batch — one compile, not one per file |
| A deletion | `clear_assets` / `clear_data`, so the built copy comes back |

**Every change gets a row, and the row is the honest part.** `node mcp-server/daemon.mjs changes
--follow` tails it; inside a session, `get_events {type: "edit"}` reads the same rows out of the
game's own event stream, which is how a second session learns about an edit nobody told it about.
The row says what became of your file:

- **`swapped`** — it landed.
- **`refused`** — nothing was done, deliberately. The commonest case is *identical bytes*: a save
  that changed nothing, a formatter re-writing a file, an editor's autosave. That is decided from a
  content hash **before the game is dialed**, so a no-op save costs no reload and no flicker.
- **`not-yet`** — a `.java` file that does not compile yet. Normal while you are mid-edit. The
  next save that compiles lands it.
- **`pending-rebuild`** — real, and structural. A class the JVM never loaded, a new field or
  method, `fabric.mod.json`, a `*.mixins.json`. **This is the row that means run `rebuild.ps1`
  now**, and
  it is the one worth watching for, because nothing else tells you.
- **`none`** — the game is down, or that file does not land anywhere. The row is still kept.

Three limits, said plainly.

**It does not make any route do more than it could.** A hotswap through the feed is the same
hotswap: bodies only, and the bytes are new while the objects are old. If your swap lands and the
screen in front of you does not change, that is still the re-entry problem below, and fixing it is
still a tool call (`hotswap_class {reinit: true}`) — a file save has no way to ask for it.

**It cannot tell who edited the file.** A write on disk carries no author, so every row from this
feed is attributed `unknown`. The feeds that will know — your editor's buffer, your undo stack —
are designed and not built.

**It is one more process to have running.** Nothing supervises `mmcpd` yet. If saves are not
landing, check it is up (`daemon.mjs status`) before suspecting anything else. `MMCPD_WATCH=0`
turns the watching off while leaving the daemon serving.

**If you are not running the daemon, nothing below changes.** The rest of this page is the manual
route, and it is still the route — the daemon is a convenience over it, not a replacement for it.

## The decision table

Find what you changed. This is the short form; `LIVE_MODDING.md` opens with the full one, including
the cases this leaves out.

| You changed | Route | Latency |
|---|---|---|
| A **client asset** — texture, model, blockstate, sound, lang | `push_asset` → live resource pack | seconds |
| **Server data** — recipe, loot table, tag, advancement, function, predicate | `push_data` → live world datapack | seconds |
| A Java **method body** | `hotswap_class {compile: true}` — compiles and swaps in one call | seconds |
| A Java **mixin body** — what an existing `@Inject` or `@Redirect` does | `hotswap_class {compile: true}` on the **mixin** class, never its target | seconds |
| Java **structure** — a new class, field, tool or registration | `tools/rebuild.ps1` | minutes, full restart |
| A **Blockbench project** (model + textures) | push from Blockbench | seconds |
| A **datapack dynamic registry** (a mod's own registered-synced registry) | edit, then **leave and re-enter the world** | world reload |
| **Worldgen** noise | not reloadable — world restart. `preview_worldgen` answers without generating anything | — |

Two of those rows are traps in disguise.

**The dynamic registry row.** `/reload` reports success and changes **nothing** —
`reloadResources` passes the registries through untouched. You will get a green message and an
unchanged game. Leave the world and come back.

**The worldgen row.** Worldgen registries are not reloadable at all. `push_data` still *validates*
them, which is worth doing, but the change reaches terrain on a world restart.

## How it works: three different mechanisms

The three fast routes are genuinely different machinery, and knowing which one you are on tells you
what its limits will be.

### Live packs — assets and data

Two toolkit-managed override packs, same design on both sides:

| | Client assets | Server data |
|---|---|---|
| Tools | `push_asset` / `reload_resources` / `list_assets` / `clear_assets` | `push_data` / `reload_data` / `list_data` / `clear_data` |
| Lives at | `<game dir>/resourcepacks/mcptoolkit_live` | `<world>/datapacks/mcptoolkit_data` |
| Priority | force-selected on reload, **top** — beats your mod and vanilla | force-enabled, added last (top) |

These are plain folders on disk. Which leads directly to the thing that costs people hours:

**Overrides persist.** They survive restarts and stay force-selected. A pushed asset shadows your
mod's bundled one **until you clear it**. So when an asset "won't change" no matter what you do to
your source tree, the first thing to check is `list_assets` / `list_data` for a forgotten override
from last week.

Two mechanical notes that make the loop cheap:

- **Batch the writes, reload once.** Pass `reload: false` on each push, then a single
  `reload_resources` / `reload_data` at the end. The reload is the expensive step; the write is not.
- **If the bytes are already on disk, pass `file`, not `base64`.** Both push tools take `file` — an
  absolute local path the game reads itself. That is a ~40-token call instead of a whole image
  through the conversation, which on an art loop is most of your bill. Use `base64` only for bytes
  that exist nowhere on disk.

`push_data` also has a **dry run**: `{dry_run: true}` runs your file through the game's own codec and
tells you whether it decodes, without pushing anything. That is the cheapest possible check on a
datapack file, and it is the only way to validate worldgen at all.

### Hotswap — Java method bodies

`hotswap_class` redefines a loaded class in the running JVM. One call is the whole route:

```
hotswap_class {class: "com.example.mymod.LanternBlock", compile: true}
```

`compile: true` runs the Gradle compile first, in the project that class's bytes come from. It is not
a shortcut around typing `gradlew compileJava` in another window — it removes a failure that version
cannot see. The loaded class states where it was loaded from; that directory states the project and
the task (`build/classes/java/main` is built by `compileJava`, `build/classes/java/client` by
`compileClientJava`); the swap then reads its bytes from the place that compiler just wrote them. A
compile aimed at one project and a swap aimed at another — each reporting success, together changing
nothing — is not expressible, because there is one path and both halves are derived from it. A failed
compile **is** the reply, with javac's own file, line and column, and nothing is redefined.

Only compile tasks ever run this way. `jar` and `build` are the ones that deadlock against a running
game; that route is `tools/rebuild.ps1`.

The limits are the JVM's, not the toolkit's:

- **No added or removed fields, methods or classes.** Bodies only. Anything structural is a rebuild.
- **Batch multi-class edits**: `{classes: ["a.b.C", "a.b.D"], compile: true}` redefines atomically in
  one JVM operation, so no tick observes a half-applied change.
- Two launch flags, both set by the convention plugin on the client and server runs:
  `-Djdk.attach.allowAttachSelf=true`, without which the tool cannot attach at all, and
  `-Dmixin.hotSwap=true` for the mixin route below. Neither can be added to a game already running.

**Mixins swap — the mixin class, never its target.** A mixin *target* redefined from compiled sources
loses its load-time transforms, so the tool refuses it and names the mixin to swap instead. The mixin
itself works: Mixin ships its own hot-swap agent, the toolkit arms it, and redefining the mixin makes
Mixin re-apply it to its targets. Changing what an existing injector *does* lands; adding an
`@Inject` adds a method to the target and is structural. A remapped Minecraft class stays off limits
for the reason it always was.

**The bytes are new, the objects are old.** This is the part that costs people an afternoon. A
redefine replaces bytecode; it does not rebuild what the old bytecode already built and it does not
re-run a static initialiser. A screen keeps the widgets its old `init()` made, a mob keeps the goal
list its old `registerGoals()` made, a registry keeps the block built at registration — and every one
of those swaps reports the same success. **A swap is visible only where the code runs again.** Every
reply carries a `reentry` block saying, per class, what is still holding old state and what would
make the code run again, and `reinit: true` performs the two re-entries nothing else reaches: it
rebuilds the current screen's widgets, and re-runs `registerGoals()` on every loaded instance of a
swapped mob. `reinit` is an act on the live world — re-registering goals clears any goal that was
added from outside `registerGoals()`.

**Bytes identical to what is already running are refused**, rather than reported as a redefine. That
refusal is the forgotten compile, caught. When you passed `compile: true` it means something else and
says so: the compile ran, so the edit is not in the source tree that project compiles.

**`{status: true}` lists what this JVM is running that its jar is not** — every class swapped in this
session, when, from where, and the digest now installed. A restart resets all of it, and nothing else
does; a rebuilt jar on disk does not change what is already loaded.

**Ask before you swap.** `query_class` prechecks it: its `hotswap` block says whether the classpath
default will find fresh bytes for that class, and whether the class may be redefined at all — the
same verdict `hotswap_class` would reach, one call earlier and without the audit entry.

`query_class` is worth knowing about for its own sake. It is reflection over the **loaded** class,
which is the one thing a decompiled tree and an IDE cannot do: they answer from source, and source
says what a `@Mixin` *intends*. It returns the post-transform method table, the class loader, the
file on disk the class was actually loaded from, and the mixins with merged methods in it. When you
are asking "did that mixin apply", this is the tool, not the source.

### Rebuild — everything structural

New class, new field, new registration, new tool: full restart.

```
tools/rebuild.ps1
```

It closes the running dev game, rebuilds, relaunches and waits for the bridge to answer. `-Project`
picks a build root if you are not in the toolkit's own. The `launch_game` tool wraps it for an agent.

**One cycle per port.** A second `rebuild.ps1` on the same port exits 3 rather than killing the first
one's game; `-Takeover` overrides. This exists because a rebuild shooting another rebuild's game is
a bad afternoon.

And the rule underneath all of it: **never run `gradlew build` or `:jar` while a dev game is
running.** The game holds the jar open and the failure does not look like what it is.

If something is running that nobody started, `tools/dev-procs.ps1` lists cycle locks, bridge ports,
rebuild supervisors, Gradle daemons and dev JVMs, and can reap them, scoped to your checkout.

## Did it actually load?

This is the section that saves the most time, so it gets its own heading.

**A reload that succeeds is not a file that loaded.** Vanilla logs a malformed recipe, model or
modifier and **steps over it**. The reload completes, reports success, and your change is not in the
game. Nothing about the success message distinguishes "loaded fine" from "loaded nothing".

There are three different questions here and three different tools:

| Question | Tool | What a pass means |
|---|---|---|
| Do these bytes decode? | `push_data {dry_run: true}` | The game's own codec accepts them. Not "it is in the game". |
| Did the game accept it on load? | `get_log` | You see what the game logged, including what it skipped. |
| Is it actually held now? | `query_registry` | The registry has it. |

`get_log` is the one people do not know exists. The toolkit attaches an appender to the root logger
at its own mod init, so **whatever your mod logs is already in it** — `get_log {logger: "yourmod",
level: "all"}` reads your own SLF4J calls back out of a running game with no file tail. Three
boundaries on it: it sees whatever the game's root logger admits (in a dev run that includes DEBUG),
`level` defaults to `warn` so DEBUG needs `level: "all"`, and capture starts at mod init — a failure
during mod resolution or mixin apply is in `logs/latest.log` and not here.

And for the specific question "what does this table actually drop", `roll_loot` rolls it in the
running game thousands of times and reports per-item shares. See [Recipes, loot and
tags](data-recipes-loot-tags.md).

## Promotion: from preview to source

**The live packs are a preview surface, not a home.** When something is right, promote it — and the
promotion rides on the clear:

```jsonc
clear_assets {path: "assets/mymod/textures/block/foo.png",
              promote: "C:/dev/mymod/src/main/resources"}

clear_data   {path: "data/mymod",              // a directory takes the whole namespace
              promote: "C:/dev/mymod/src/main/resources"}
```

Each file is copied into that root at the same pack-relative path, and **then** the override is
deleted and the game reloaded.

Why promotion is an argument of `clear_*` rather than a verb of its own: the step people forget is
the clear. An override left behind keeps winning over the source-tree copy, which is the classic way
to spend an hour debugging a texture that changed long ago. Riding the copy on the clear makes the
forgettable step the one you cannot skip.

Four things about it:

- **There is no default destination and none is ever created.** A missing directory, or one that does
  not look like a resources root, is refused. A wrong-but-plausible default is how a file lands in a
  checkout nobody is looking at.
- **A refused promotion clears nothing.** Every file is copied before any file is deleted. A
  promotion that removed the override and then failed to write the copy is the only outcome worse
  than not promoting.
- **`promote` requires a `path`.** Promoting the whole pack would put every namespace in it —
  vanilla's own overrides included — into one mod's source tree.
- **`unchanged: true` on a promoted file** means your source tree already had exactly those bytes:
  you promoted this before, and you have been editing a copy of it ever since.

One thing that surprises people: **after promoting, the game does not show the promoted file.** The
override is gone, so what is on screen from here on is what the *built* mod has. Your change reaches
the game on the next build. The reply says so.

## Walkthrough: one texture, one recipe, one method

Three changes, three routes, in one sitting.

**A texture.** Push it, look, adjust, promote.

```
push_asset {path: "assets/mymod/textures/block/lantern.png", file: "C:/art/lantern.png"}
render {}
# not right — edit the PNG, push again, look again
clear_assets {path: "assets/mymod/textures/block/lantern.png", promote: "C:/dev/mymod/src/main/resources"}
```

**A recipe.** Validate before you push, then confirm it loaded.

```
push_data {path: "data/mymod/recipe/lantern.json", file: "...", dry_run: true}   # does it decode?
push_data {path: "data/mymod/recipe/lantern.json", file: "..."}                  # for real
get_log {logger: "minecraft", level: "all"}                                      # did it skip it?
```

If the dry run passes and the log shows a skip anyway, the file is well-formed but references
something that is not there — an ingredient id, a result id — which is exactly the case where a green
reload and an absent recipe look identical from the game.

**A method body.**

```
query_class {class: "com.example.mymod.LanternBlock"}                    # hotswap.safe?
hotswap_class {class: "com.example.mymod.LanternBlock", compile: true}   # compile, then swap
# call the method again — a swap only shows where the code runs
```

If `query_class` says `safe: false`, stop — that is a mixin target or a Minecraft class. Swap the
mixin instead, or rebuild.

If the swap lands and the game looks unchanged, read the `reentry` block in the reply before touching
the code again. It is usually right: nothing has run the new bytes yet.

## An agent session

The routing decision is the thing an agent should be making for you, every time, without being asked.

> **You:** the lantern's light level should be 12, not 7, and the texture is too dark.

> **Agent:** two changes, two routes. Light level is a block property set at construction, so it is
> structural — that needs a rebuild. The texture is a live push.
>
> Doing the texture first while the game is up.

> **Agent** calls `push_asset {path: "...lantern.png", file: "..."}` then `render {}`.
> → the picture comes back.

> **You:** better. Keep it.

> **Agent** calls `clear_assets {path: "...", promote: "C:/dev/mymod/src/main/resources"}`
> → `promoted: 1`, override cleared.
>
> Then it edits the light level in Java, and runs `tools/rebuild.ps1` — one restart covering both
> changes rather than one each.

> **Agent** after the bridge answers: `ping` → new build stamp. Then `query_registry` to confirm the
> block is still registered, `set_blocks`, `render`.
>
> Light level reads 12 in-world; the promoted texture is now coming from the jar rather than the
> override, which is the real test of the promotion.

Two things there are worth stealing. It **batched the restart** — the texture was promoted first so
one rebuild carried both changes. And the final read tested the promotion *properly*: with the
override cleared, a texture that still looks right is one that genuinely made it into the source
tree.

## Things to keep in mind

**You saved the file and nothing happened.** If you are relying on the disk feed, check the daemon
is running before anything else — `node mcp-server/daemon.mjs status`. If it is running, read the
row: `node mcp-server/daemon.mjs changes` (or `get_events {type: "edit"}`) says what it decided,
and `refused` on a save you thought you changed means the bytes are identical to what is already
there.

**The daemon says `pending-rebuild` and you keep editing.** That row is not a warning, it is the
answer: nothing you write into that file will land until you rebuild. New class, new field, new
method, `fabric.mod.json`, a mixins config — all structural, all `rebuild.ps1`.

**Your asset will not change no matter what you do.** Check `list_assets` for a forgotten override
first. It is almost always this.

**A reload succeeded and nothing loaded.** Vanilla logs and steps over malformed data. `get_log` is
the only place that fact exists.

**`/reload` does nothing for dynamic registries.** It reports success and passes the registries
through untouched. Leave the world and come back.

**A hotswapped mixin target is silently wrong.** Redefining a mixin-transformed or Minecraft class
from compiled sources loses its load-time transforms. The tool refuses it and names the mixin to swap
instead; `query_class` tells you one call earlier.

**The swap said `redefined: 1` and the game did not change.** The bytes are new and the objects are
old. Nothing has run the new code yet — read the `reentry` block, and use `reinit: true` for a screen
that is already open or a mob that is already loaded.

**You have lost track of how far the running game has drifted.** `hotswap_class {status: true}` lists
every class this JVM has been swapped away from its jar, with times and digests. (Until 0.152.0 the
honest answer here was "restart"; the process was holding the fact all along.)

**Never `gradlew build` while the game runs.** The game holds the jar.

**One rebuild cycle per port.** A second one exits 3 rather than shooting the first one's game.
`dev-procs.ps1` shows who owns what.

**Pass `file`, not `base64`, for bytes that exist on disk.** On an art loop this is most of your
cost.

**Batch the pushes, reload once.** The reload is the expensive half.

**Promote before you rebuild, not after.** Otherwise the override is still winning over the file you
just baked into the jar, and you will conclude the build did not work.

## Where to go next

**In this wiki**

- [Debugging](debugging.md) — the log channel, crashes, `query_class`, `get_perf`, in full.
- [Textures and models](textures-and-models.md) — the asset loop, properly, including Blockbench.
- [Recipes, loot and tags](data-recipes-loot-tags.md) — the data half, and `roll_loot`.
- [Mod testing](mod-testing.md) — turning "I checked it once" into something that runs.
- [Troubleshooting](troubleshooting.md) — symptom-first list of the usual suspects.

**Reference**

- `LIVE_MODDING.md` § *The disk feed* — the classifier in full, the result vocabulary, and what the
  feed cannot attribute.
- `LIVE_MODDING.md` § *Decision table* — the full table, including the rows this page omits, and a
  stated list of what release 1 does **not** do.
- `LIVE_MODDING.md` § *The live packs* — pack semantics in detail.
- `LIVE_MODDING.md` § *Did it actually load?* — the log channel.
- `LIVE_MODDING.md` § *Promotion* — promotion, with its refusal rules.
- `LIVE_MODDING.md` § *hotswap_class* and § *What a class ACTUALLY is* — the JVM limits and
  `query_class`.
- `tools/README.md` — `rebuild.ps1` and `dev-procs.ps1`.
