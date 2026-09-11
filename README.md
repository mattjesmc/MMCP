# MMCP

**An MCP toolkit for Minecraft.** One mod jar (Fabric and NeoForge, dev and production) opens a
localhost HTTP bridge into a running game and registers tools on it; an MCP server fronts that bridge
for any MCP client. An agent then authors blocks, data, models, entities, structures, screens and
worldgen against a game that is actually running, and reads back what it did.

**If you are a person, start at [`wiki/`](wiki/README.md)** - one page per kind of modding work,
each with an overview, a walkthrough, an example agent session and the traps that cost us the time.
**If you are an agent, start at [`mcp-toolkit/README.md`](mcp-toolkit/README.md)**, which maps each
task to the one document to read. [`mcp-toolkit/RELEASE.md`](mcp-toolkit/RELEASE.md) is the release ledger: what
ships, what has been verified on the code that ships, and what is still open - and where a claim
rests on a test log, it names the log.

This is **release 2**: toolkit 0.146.0, MCP server 0.73.0, convention plugin 0.7.0, Minecraft 26.2.
**The game now speaks MCP itself.** `POST http://127.0.0.1:<port>/mcp` is an MCP server hosted in the
mod jar - no Node, nothing to install, nothing to spawn: point any client that speaks MCP over HTTP
straight at that URL, and `/mcp/<surface>` chooses which slice of the tools it gets. Type `/mmcp mcp`
in game and it prints the address and the line that registers it. The Node server is unchanged and
remains the fuller path, because it is there whether or not the game is
(`mcp-toolkit/docs/platform/IN_JAR_MCP_DESIGN.md` has the table).

The whole probe battery was re-run at this version on 2026-09-11 - 109 files, 916 pass / 1 fail, the
one red green on an isolated rerun - and **107 of the 108 files it shares with release 1's battery
scored identically**, which is the evidence that this version changed nothing it did not mean to
(`RELEASE.md` 2.10; 2.8 and 2.9 are release 1's two loader arms, 108 files, 903/0 and 901/8).

## License, in short

Read [`LICENSE`](LICENSE); it is written to be read. The summary:

- **Free for non-commercial use**, with nobody to ask - playing, learning, teaching, research, hobby
  modding, and building things you give away.
- **Anything you author with it is entirely yours.** No condition on your mods, assets, data or
  worlds, and no claim on them.
- **Commercial use needs permission first** - by or for a business, in anything sold or offered for
  payment, in paid work or a paid service. A door, not a wall: say what you want to do and ask,
  before you start rather than after.
- **Do not redistribute the jar or the server.** Not to a mod site, a mirror, a modpack or a
  registry. Link people here instead, so that what they download is what was actually released, at
  the version it claims to be. A modified version that adds real new capability you may pass on,
  named so it is not mistaken for this one and under these same terms.

If you are unsure which side of a line you are on, that is a question and not a verdict - ask.

## Two other things worth knowing before you start

**It is a snapshot, not a history.** The development workbench is a private repository whose history
carries work that is not part of this release; what you see here is its tree at the release version,
committed once. There is no commit log to read behind these files.

**Windows only, and no permission system.** The bridge binds `127.0.0.1` and any local process that
can reach the port can drive the game. That is the trust model; there is nothing behind it.

**Not an official Minecraft product. Not approved by or associated with Mojang.**

---

# The workbench this was cut from

This directory is a WORKBENCH, not a monorepo: several independent Gradle build roots that share
one convention plugin and one local Maven repository. The product is the **MCP Toolkit**;
everything else here builds it, tests it, or was its first customer.

**If you are a person, start at [`wiki/`](wiki/README.md)** — one page per kind of modding work,
each with an overview, a walkthrough, an example agent session and the traps.
**If you are an agent, start at `mcp-toolkit/README.md`** — it maps each task to the one document or
section to read.

## What is here

| Directory | What it is | Entry point |
|---|---|---|
| `mcp-toolkit/` | The product: one mod jar (Fabric and NeoForge, dev and production) that opens a localhost bridge into the running game and registers tools on it, so an agent can author blocks, data, models, entities, structures and screens against a live game. Its own build root. | `mcp-toolkit/README.md` |
| `mcp-server/` | The MCP server (Node) that fronts that bridge for any MCP client: proxies the tool manifest, adds profiles, per-world memory, the image budget and the loop kit. | `mcp-server/README.md` |
| `gradle-conventions/` | The `com.mattmc.mcmod` Gradle plugin every mod in the workspace applies: pins Minecraft, loader, Fabric API and toolkit versions, wires the optional bridge into `runClient`, adds `generateUi`, `checkUi`, `toolkitStatus`, `modpageBuild`. | comment block at the top of `src/main/groovy/com.mattmc.mcmod.gradle` |
| `tools/` | Workbench scripts: the rebuild cycle, the process reaper, the live probe battery, vanilla-source extraction, the production-client launcher. | `tools/README.md` |
| `wiki/` | The human-facing manual: one page per kind of modding work (blocks, textures, entities, data, screens, structures, worldgen, testing, debugging, scale, extending, servers), each with an overview and index, a walkthrough, an example agent session and the traps. It links into the three manuals rather than restating them. | `wiki/README.md` |
| `spike-neoforge/` | The workspace's only NeoForge build, kept as the one place four cross-loader facts can be checked. In no `settings.gradle` but its own. | `spike-neoforge/README.md` |
| `world-model/` (untracked) | A separate research repository (its own git), nested here and ignored by this one. Compiled into the toolkit but off by default and not part of the developer release. | `world-model/DESIGN.md` |
| `vanilla-src/` (untracked) | Decompiled Minecraft, produced by `tools/extract-vanilla-src.ps1` so vanilla source can be grepped. Grep it; never guess an API shape. | - |
| `run/`, `run-server*/` (untracked) | Game working directories: the dev client's, and one cell per dev server. | - |

## How a mod repository uses this workbench

Sibling checkouts (rocketeer, menagerie, nijntje, villagejobs, ...) are separate repositories.
Village Jobs was the toolkit's first customer and lived at this root until 2026-09-06; its history
before that date is this repository's. Each sibling:

1. applies `id 'com.mattmc.mcmod'` after Fabric Loom and resolves the plugin and the toolkit from
   mavenLocal - `./gradlew build` in `mcp-toolkit/` and in `gradle-conventions/` publishes them
   (`mcp-toolkit/EXTENDING.md`, Quickstart);
2. carries a `.mcp.json` that runs `mcp-server/index.mjs` with `MCPTK_URL` pointing at ITS bridge
   port. The port is a per-project constant that names the project (`mcp-toolkit/RELEASE_1.md`
   section B0); `./gradlew toolkitStatus` prints it;
3. optionally carries `.mcptoolkit/loop.json` and `.claude/agents/*.md` for authoring loops
   (`mcp-toolkit/docs/guides/LOOPS.md`).

## Rules that bite

- Never run `gradlew build` or `:jar` while a dev game is running: the game holds the jar. Use
  `tools/rebuild.ps1` for structural changes and `hotswap_class` for method bodies. The full
  decision table is the first section of `mcp-toolkit/LIVE_MODDING.md`.
- One dev game per bridge port. A second `rebuild.ps1` on the same port exits 3 instead of killing
  the first game's cycle; `tools/dev-procs.ps1` shows who owns what.
- Live probes (`mcp-server/probes/`) run against ONE world and each file owns distinct sites. The
  arbiter is `tools/battery.ps1` (sequential); `npm run test:live` is a concurrent load test.
- Documents cite each other by bare filename (`LOOP_KIT_DESIGN.md`, section 5). Every UPPER_CASE
  record name is unique across the tree, so find a cited document by name, not by the directory the
  citation was written in. The index is `mcp-toolkit/docs/README.md`.
