# Servers and production

Three situations where the toolkit is not a Gradle dev client on your own machine: a **dedicated
server** (no render thread, so a third of the tools are simply absent), a **production install** (a
real launcher game with the jar in `mods/`), and **NeoForge**.

The theme: the tool surface changes, and it changes *honestly* — a tool that cannot work in a context
is absent from the manifest rather than present and failing. Knowing which is which up front is the
difference between writing a headless suite from a table and discovering it by trying.

## On this page

- [Which tools answer without a client](#which-tools-answer-without-a-client)
- [Driving a dedicated server](#driving-a-dedicated-server)
  - [Is this the build I just made?](#is-this-the-build-i-just-made)
- [Attaching to a production game](#attaching-to-a-production-game)
  - [The four things that differ](#the-four-things-that-differ)
- [NeoForge](#neoforge)
- [Walkthrough: a headless check against a dedicated server](#walkthrough-a-headless-check-against-a-dedicated-server)
- [An agent session](#an-agent-session)
- [Things to keep in mind](#things-to-keep-in-mind)
- [Where to go next](#where-to-go-next)

---

## Which tools answer without a client

Every tool declares an **execution context**, served as the manifest's `context` column:

| Context | Answers on | Roughly |
|---|---|---|
| `server` | A loaded world, on either process | The bulk of the surface |
| `any` | The bridge alone — before a world exists, and on a dedicated server | `ping`, the log, the launcher |
| `client` | A game client. **Never present headless** | Rendering, screens, the studio |

Mechanically: `server` tools run on the server thread and refuse with `no server running` until a
world is loaded — on a dedicated server that is from boot, on a client once a world is open. `any`
tools run inline on the bridge's own thread with no world needed. `client` tools run on the render
thread, and **a dedicated server never registers them**, so they are absent from its manifest rather
than present and refusing.

`docs/platform/HEADLESS.md` is that table, generated from a live manifest — write your headless suite
against it rather than discovering it by trying. `ping` reports `clientPresent` and `serverRunning`
for the live answer; the table is the promise.

## Driving a dedicated server

A dedicated server with the bridge is the right target for anything that does not need pixels:
registries, recipes, loot rates, commands, data loading, a real player's inventory.

It boots in about a minute and then answers in milliseconds, so the cost of a headless suite is the
boot, not the checks. Give your runner an `--attach` flag for when a server is already up and you are
*writing* checks — but have the suite itself always start its own, because the point of a gate is
that it needs nothing to be true of the machine beforehand.

**A player is required for more than you would think.** Half of a typical mod's commands refuse a
console source: they are about a *wearer*, a hand, an inventory. The toolkit can spawn a real headless
player body, which is what those checks need.

For a fresh world with your pack on its **first** load — which is what a release gate actually wants —
put the pack in `world/datapacks/<pack>` before the first boot and name its id in
`server.properties`'s `initial-enabled-packs`. Not `push_data`: that pack is the toolkit's own, for
files the game should pick up on a reload.

### Is this the build I just made?

**This is the single highest-value line in anything automated**, so it gets its own section.

A second game cannot bind the bridge port — and the bridge answers from the **older JVM without
saying so**. That is a green run against code that is not loaded, and nothing about it looks wrong.

`ping.build` is the guard. It carries:

- **`mods[].origins[].mtime`** — to compare against the jar you just built;
- **`mods_hash`** — against the load you expect;
- **`stale: true`** — meaning the code on disk is newer than the JVM. That is precisely the shape of
  "a second `runClient` could not bind the port and every call answered from the old one".

Read it before trusting an instance. Refuse the run otherwise.

## Attaching to a production game

The toolkit runs in a normal launcher install: jar in `mods/`, bridge on **25600** by default
(`config/mcptoolkit.properties` disables it, `-Dmcptoolkit.port` overrides either mode). The player
launches the game normally — **nothing in the game starts an agent**.

The bootstrap extracts a slim copy of the MCP server from the jar into
`<gameDir>/mcptoolkit/mcp-server` (npm installs only the MCP SDK) and writes `.mcp.json` and
`.claude/settings.json`. Those are **reconciled** — rewritten when they name a different bridge port
than the running instance — while `CLAUDE.md` is **write-if-absent**, so your charter edits survive.
Re-extraction is gated on the mod version stamp (`.extracted-version`; delete it to force).

Around **thirty tools** — perception, the drone, building, UI — resolve against whatever game answers
and are correct either way. The workspace-coupled ones are not, so **check `ping` first**: it reports
`env` (`development` | `production`), the absolute `gameDir`, and a per-launch `instanceId`. If that
id changes mid-session, the game restarted; re-orient before acting.

### The four things that differ

**`rebuild.ps1` refuses to run.** It would force-kill the real game and replace it with a dev
instance. `-Force` overrides, for deliberately doing exactly that.

**`hotswap_class` needs an explicit `file` or `dir`.** Jar-loaded classes make the classpath default
refuse **loudly** — otherwise it would re-read the already-loaded bytes and "succeed" while changing
nothing. Self-attach also needs `-Djdk.attach.allowAttachSelf=true` on the launcher profile.

**Namespaces differ, and this one is genuinely dangerous.** A `push_asset` or `push_data` to a
namespace the attached game does not load **succeeds and does nothing**. And the log channel *does not
catch it* — the game never scans that directory, so there is nothing to log: `problems` will be empty
and `ok` true.

What catches it is asking what the game is **holding**: `query_registry {registry: "recipe", entry:
"…"}`, or the matching `entry` on whatever registry your file feeds.

**Set `MCPTK_MEMORY_DIR`.** The `mem_*` default root sits inside the MCP server checkout — fine for
dev, wrong for a play install. Give production sessions their own root in the registration. Note the
offline fallback too: with the game down, memory identity comes from `last_world.json`, which is *the
last world any session attached to under that root*. The header names the world; check it is the one
you meant.

## NeoForge

One jar carries both loaders — Fabric and NeoForge, dev and production. There is no separate build
and no separate artifact.

The rule that matters when you are debugging a loader question: **production is what the flag says**,
and **never detect a loader by trying to load a class**. That approach produces confident wrong
answers.

`docs/platform/CROSS_LOADER_DESIGN.md` §§ 12-16 is the record, including the boot matrix each cell was
proven against.

## Walkthrough: a headless check against a dedicated server

**1. Write the suite against the context table.** `docs/platform/HEADLESS.md` says which tools are
available. Anything `client` is not an option here.

**2. Guard the instance:**

```python
ping = bridge.call("ping", {})
assert not ping["build"].get("stale"), "the JVM is older than the code on disk"
assert ping["build"]["mods_hash"] == expected, "this is not the build under test"
```

**3. Start the server yourself.** One boot for the whole suite.

**4. Ask your questions.** `query_registry`, `roll_loot`, `push_data {dry_run}`, `run_command` plus a
read to confirm, `get_log` for anything that loaded-and-skipped.

**5. Spawn a player** for anything about a wearer, a hand or an inventory.

**6. Clean up in a `finally`.** Every scenario that writes, clears. The next one runs in the same
world.

See [Mod testing](mod-testing.md) for the tier model this fits into.

## An agent session

> **You:** run the headless checks against the new build.

> **Agent** calls `ping`
> → `{ env: "development", serverRunning: true, clientPresent: false,
> build: { stale: true, mods_hash: "…" } }`
>
> **Agent:** stopping here. `stale: true` means the code on disk is newer than the JVM that is
> answering — a second launch could not bind the port, so every call would come from the old game.
> Running the suite now would go green against code you did not build.

> **You:** kill it and start again.

> **Agent** runs `tools/dev-procs.ps1` to see what holds the port, reaps it, starts a fresh server,
> and re-checks `ping.build` → `stale: false`, hash matching.
>
> Then it runs the suite: `query_registry`, `roll_loot` at 5,000 rolls with a fixed seed,
> `push_data {dry_run}` over each new data file.

> **Agent:** eleven checks, ten pass. The failing one is a loot share of 0.4% against an expected
> 1–8%, and `get_log` shows the modifier being skipped — an unregistered condition type. Same cause
> as last week's, different condition.

The whole point of the exchange is the first turn. **It refused to run a green suite against the wrong
JVM**, which is the failure this page exists to prevent, and it is invisible without `ping.build`.

## Things to keep in mind

**`ping.build` before you trust anything.** `stale: true` means the JVM is older than the code. A
second game cannot bind the port and the old one answers silently.

**A `client` tool is absent, not failing, on a dedicated server.** If your suite expects it to refuse,
it will instead not be there.

**In production, a push to an unloaded namespace succeeds and does nothing** — and the log cannot
catch it, because there is nothing to log. Confirm with `query_registry {entry}`.

**`rebuild.ps1` refuses against production.** It would kill the real game. `-Force` only if you mean
exactly that.

**`hotswap_class` needs `file`/`dir` in production.** Jar-loaded classes make the default refuse
loudly rather than silently succeed while changing nothing.

**Set `MCPTK_MEMORY_DIR` for play installs.** The default lives in the dev checkout.

**Check `instanceId`.** If it changes mid-session, the game restarted.

**A player is needed for more than you expect.** Many commands refuse a console source.

**A release gate wants a fresh world with the pack on its first load** — `initial-enabled-packs` on a
server, `create_world {datapacks: […]}` on a client.

**Never detect a loader by loading a class.** Production is what the flag says.

**Boot once, ask many times.** The cost of a headless tier is the boot.

## Where to go next

**In this wiki**

- [Mod testing](mod-testing.md) — the tier model, and the stale-instance guard in context.
- [Debugging](debugging.md) — the log channel and crash reading, which work the same headless.
- [How it works](how-it-works.md) — execution contexts and the two modes.
- [Extending the toolkit](extending-the-toolkit.md) — picking a context for your own tools.

**Reference**

- `docs/platform/HEADLESS.md` — the generated context table.
- `LIVE_MODDING.md` § *Driving a dedicated server* and § *Attaching to a normal (production) game*.
- `LIVE_MODDING.md` § *Two working modes* — the dev/production table.
- `docs/platform/CROSS_LOADER_DESIGN.md` §§ 12-16 — one jar, two loaders, as proven.
