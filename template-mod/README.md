# examplemod

A Minecraft 26.2 Fabric mod wired for the [MCP Toolkit](../mcp-toolkit/README.md) from its first
launch: one scaffolded block, the toolkit's dev bridge on the runtime classpath, and MCP
registrations for Claude Code, Cursor, Gemini CLI, VS Code and Codex that all name this
repository's own bridge port.

## From zero

1. JDK 25 and Node 18 or newer.
2. Until the toolkit's static Maven is published: clone `mcmodding`, run `gradlew build` in
   `mcmodding/gradle-conventions` and in `mcmodding/mcp-toolkit` once (both publish to mavenLocal).
3. Copy this directory (or "Use this template" once it is a repository). Rename: `examplemod`
   in `gradle.properties`, `fabric.mod.json`, `settings.gradle`, and the package under
   `src/main/java`. Pick a port in `gradle.properties` no other dev game on your machine uses.
4. `gradlew toolkitInit -Pclients=all` rewrites the registrations for the new port and extracts
   the MCP server into `.mcptoolkit/mcp-server`; run `npm install --omit=dev` there once.
5. `gradlew runClient`. The bridge is on the port `gradle.properties` names; from an agent session
   in this directory, call `ping` first. Off Windows, run the game yourself; everything after
   `ping` is identical.

## What is here

- `src/main/java/com/example/examplemod/ExampleMod.java` calls `RegisterExampleBlock.register()`.
- `RegisterExampleBlock` and the nine asset and data files of `examplemod:example_block` were
  written by `gradlew scaffold -Pkind=block -Pid=example_block`; they are yours since. Its texture
  is a placeholder: push the real one live with `push_asset`, judge it, promote it with
  `clear_assets {promote}`.
- `AGENTS.md` is the session charter (`CLAUDE.md` imports it). `.mcptoolkit/loop.json` runs
  `checkAssets` after editing calls and after a unit session.
- `gradlew check` runs `checkAssets`: dangling references fail, unused assets warn.

Next block: `gradlew scaffold -Pkind=block -Pid=<id>`, add its `register()` call to `ExampleMod`,
one rebuild, then `query_registry`, `set_blocks`, `render`.
