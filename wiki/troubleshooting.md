# Troubleshooting

Symptom first, cause second. Find what you are seeing, not what you think is wrong — that ordering is
deliberate, because the most expensive problems here look like something else entirely.

If your symptom is not listed, the three general-purpose diagnostics are **`ping`** (is this even the
game I think it is), **`get_log`** (what did the game actually say), and **`query_registry`** (what is
the game actually holding).

## On this page

- [Nothing answers](#nothing-answers)
- [It answers, but it is the wrong game](#it-answers-but-it-is-the-wrong-game)
- [A tool is missing or refuses](#a-tool-is-missing-or-refuses)
- [My change does not appear](#my-change-does-not-appear)
- [It said it worked and it did not](#it-said-it-worked-and-it-did-not)
- [Blockbench](#blockbench)
- [Builds and the game](#builds-and-the-game)
- [Tests and checks](#tests-and-checks)
- [It is slow, or it is expensive](#it-is-slow-or-it-is-expensive)
- [Where to go next](#where-to-go-next)

---

## Nothing answers

**`ping` reaches nothing at all.**

- The game is not running. Start it.
- The port your registration names is not the port your `gradle.properties` declares. `gradlew
  toolkitStatus` prints what the repository believes in.
- The bridge is disabled — in production it is `config/mcptoolkit.properties`; `-Dmcptoolkit.port`
  overrides in either mode.

**The tool list is short and only has memory and loop tools in it.**

That is the MCP server being honest while the game is down. It serves local tools only rather than
pretending the game tools exist and failing later. It polls (3 s down, 15 s up) and fires
`listChanged` when a game appears, so **the list fills in by itself** — you do not need to restart the
session.

**The game died before the bridge existed.**

A bad mixin or a missing dependency dies before `ping` exists, and no tool can be asked. `launch_game`'s
log on an exit-1 launch ends with the header of any crash report written during that launch plus the
tail of `logs/latest.log` — that is where the reason is. Once a game is up again, `get_log {crash:
"latest"}` reads the report properly.

**Everything times out but the game looks fine.** If Blockbench is involved, see
[Blockbench](#blockbench) — a modal permission prompt freezes the whole renderer.

## It answers, but it is the wrong game

**This is the highest-value section on the page.** A second game cannot bind the bridge port, and the
bridge **answers from the older JVM without saying so**.

Symptom: everything works, everything is green, and none of your changes are in it.

```
ping → build: { stale: true, ... }
```

`stale: true` means the code on disk is newer than the JVM that is answering. Also compare
`mods[].origins[].mtime` against the jar you just built, and `mods_hash` against the load you expect.

`tools/dev-procs.ps1` lists cycle locks, bridge ports, rebuild supervisors, Gradle daemons and dev
JVMs, and can reap them, scoped to your checkout.

**Put a `ping.build` check at the top of anything automated.** A suite that runs against a stale JVM
is worse than no suite.

**In production**, check `instanceId` too: if it changes mid-session, the game restarted and your
session's assumptions are stale.

## A tool is missing or refuses

| What you see | What it means |
|---|---|
| `profile_hidden` | Your profile does not serve it. The refusal **names the `tool_surface` call that widens it** |
| `no server running` | A `server` tool with no world loaded. Open one |
| Absent from the manifest entirely, on a dedicated server | A `client` tool. Never registered headless — see `docs/platform/HEADLESS.md` |
| Your own extension's tool is missing | `ping`'s `extensions` array records the throw or the name collision. Names are flat and shared; prefix with your mod id |

## My change does not appear

**A texture or model will not change no matter what you do.**

Almost always a forgotten live-pack override still winning over your source tree. `list_assets` /
`list_data` first. Overrides are plain folders that survive restarts and stay force-selected.

**A recipe, loot table or tag does not load, and the reload said it was fine.**

Vanilla logs a malformed file and **steps over it**; the reload completes and reports success. Read
`problems`, not `reloaded`. Then:

```
query_registry {registry: "recipe", entry: "mymod:thing"}     # does the game have it?
push_data {..., dry_run: true}                                # do the bytes decode?
get_log {logger: "minecraft", level: "all"}                   # what did it say?
```

If the dry run passes and it still did not load, the file is well-formed and **references something
that is not there** — an ingredient id, a result id.

**A tag looks empty.**

Read **`tag_exists`**, not the empty `ids` list. `Registry.get(TagKey)` is empty both for a tag that
loaded and matched nothing and for a tag whose file never loaded, and you are nearly always in the
second case.

**A datapack dynamic registry does not update.**

`/reload` reports success and changes nothing — `reloadResources` passes registries through untouched.
**Leave the world and re-enter it.**

**Worldgen does not change.**

`/reload` never looks at `worldgen/`. Restart the world — and note the ground you are standing on is
already on disk and stays as it was. Use `preview_worldgen` to confirm the settings loaded, and
remember it sees **noise only**: surface rules, carvers and features are invisible to it.

**In production, a push succeeded and nothing happened.**

A push to a namespace the attached game does not load succeeds and does nothing, and the log **cannot
catch it** — the game never scans that directory, so `problems` is empty and `ok` is true. Confirm
with `query_registry {entry}`.

**I promoted it and now the game shows the old thing.**

Expected. The override is gone, so what you see from here on is what the **built** mod has; your
promoted file reaches the game on the next build. The reply says so.

**I promoted it and the game still shows the preview.**

The reverse: you promoted from Blockbench with `target: 'source'` but did not clear the live override,
which keeps winning.

## It said it worked and it did not

**`run_command` returned `ok: true`.** That means the command **parsed**. Minecraft's command system
does not report much else. Read the world back — `query_registry`, `get_blocks_at`, `roll_loot`,
whatever suits.

**`/place template` said fine and placed nothing.** Same cause. Use `place_structure`, which refuses a
missing template by name and points at `query_registry {registry: "structure_template"}`.

**A hotswap succeeded and the behaviour is unchanged.**

- It was a Minecraft or mixin-transformed class: redefining one from compiled sources **silently loses
  its load-time transforms**. `query_class`'s `hotswap.safe` says so before you try.
- In production, jar-loaded classes need an explicit `file`/`dir` — the classpath default refuses
  loudly rather than re-reading already-loaded bytes and "succeeding".
- You changed something structural. A new field or method is a rebuild.

**A scroll or a Tab keypress reported success and nothing moved.**

Both booleans lie, in opposite directions. A scroll area returns `handled: true` at either end — read
`scrolled_to` / `at_end`. `Screen.keyPressed` returns **false** for Tab and the arrows even when focus
moved — read `focus_before` / `focus_after`.

**A read looks wrong or incomplete.** Check `coverage.state`. Anything other than `complete` is a
partial answer, and it says why.

## Blockbench

**Everything times out and Blockbench looks idle.**

A **modal permission prompt freezes the entire renderer.** Until a human clicks it, every bridge
request times out. Go and look for a dialog. The bridge plugin never opens one by itself, for exactly
this reason.

**An edit is refused with `held_by`.**

Another live session holds that project. Either work on your own, or `project op:select {project,
take: true}`. Reads are never refused.

**A push went to the wrong game, or nowhere.**

Pass `bridge` explicitly. Inside `risky_eval` that is `GAME`; outside one, the Push to Game dialog has
a **Game bridge** field remembered per project. A push with nowhere to go is refused by name.

**A promotion is refused.**

`target: 'source'` has **no default root**, deliberately. Set `sourceRoots` per project.

**A project name was refused.**

Pass the project **object** (`PROJECT` inside an eval). Resolving a name reaches a project without the
ownership check.

**`risky_eval` refuses my code.** It rejects `//`, `/*` and `console.`.

**Windows keep appearing / I cannot tell which is mine.** `ping` reports `blockbench: {port, window,
held, session}`. A window is yours unless the plugin was asked to open it for an agent; agent-born
windows close themselves when nothing holds them.

## Builds and the game

**`gradlew build` fails in a confusing way.** The game is running and holding the jar. Never build or
`:jar` while a dev game is up — `tools/rebuild.ps1` for structural changes, `hotswap_class` for method
bodies.

**`rebuild.ps1` exits 3.** Another cycle owns that port. That is the guard against a rebuild shooting
another rebuild's game. `-Takeover` overrides; `dev-procs.ps1` shows who owns what.

**`rebuild.ps1` refuses entirely.** You are pointed at a production instance; it would kill the real
game. `-Force` only if that is genuinely what you want.

**`scaffold` refuses.** It runs once per id and never regenerates. Delete what it wrote if you want it
again.

**`toolkitInit` did not update my file.** By design — it writes each file once and never rewrites
yours. The exception is a registration naming the wrong port, which it corrects and reports.
`-Ptoolkit.check` shows the plan without writing.

## Tests and checks

**Green suite, unloaded code.** See [It answers, but it is the wrong game](#it-answers-but-it-is-the-wrong-game).

**A check passes with the feature switched off.** You asserted presence, not a rate. Roll thousands of
times with a fixed seed and assert `share`.

**A loot check reports "drops nothing".** Check `exists` — the game's own `getLootTable` returns an
*empty table* for an unknown id, so a typo looks like a broken table.

**A golden frame test passes when the thing stopped drawing.** A percentage-of-image tolerance loose
enough to absorb antialiasing will absorb a small decoration entirely. Use a pixel **count**, and a
low one.

**A frame reports `new`.** Nobody has looked at it. That is not a pass and not a failure — open it and
`--bless` it deliberately. Nothing should ever write a golden on its own.

**A suite is flaky when run concurrently.** Run it sequentially. Two games cannot share a port, and a
check that rewrites files gets read mid-write.

**Two perf readings disagree and nothing changed.** The world drifts on its own. A type missing from a
top-N list has an **unknown** count, not zero — raise `top`, use the same `top` both sides, and assert
the delta you caused rather than a world-wide identity. And read `tick_rate.runs_normally` first:
`/tick freeze` or `/tick sprint` makes every millisecond mean something else.

## It is slow, or it is expensive

**The session costs a lot.** Look at the transcript before the manifest. In order: the tool called
most (does it take a list?), what the session *reads* (one brief measured at 48% of everything
carried), pictures (re-sent every later turn), then the manifest.

**Pictures dominate.** `render`'s `inline` defaults to false — keep it that way unless someone is
looking. The image budget crops and resizes and prices each frame on the reply; `MCPTK_SHOT_MAX` tunes
it.

**The game is slow.** `get_perf {hooks: true}` — `hooks` adds the toolkit's own tick cost, for ruling
out the instrument before blaming the mod.

## Where to go next

- [Debugging](debugging.md) — the log channel, crashes, `query_class`, `get_perf`, properly.
- [The change loop](the-change-loop.md) — the routing table, and why a change did not land.
- [How it works](how-it-works.md) — mechanism, coverage, profiles: most refusals make sense once
  these do.
- [Mod testing](mod-testing.md) — the guards that stop these from reaching you silently.
- [Glossary](glossary.md) — any term above that is not doing what you expect.
