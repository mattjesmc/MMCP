# Connecting an agent to a running game

**Who this is for.** You run an agent program — Claude Code, Cursor, Codex, an in-house CLI, whatever
— and you want it to drive a Minecraft instance that has the toolkit in it. This is the whole
procedure, and it needs no code and no toolkit configuration.

**This file used to be "Writing an agent-client adapter"**, because the toolkit could also start
agent processes itself: adapters, kits, capabilities, an in-game launcher. That half is archived
(toolkit 0.143.0, `mcmodding-archive`). The game starts nothing now. There is one direction, the one
below, and it is the one that was always called primary.

---

## 0. You may not need an adapter at all

There are two directions, and only one of them needs code.

**Inbound — a session that already exists connects to the game.** Register the toolkit's MCP server
in your own host's configuration and point it at the running bridge. That is the whole procedure. The
session introduces itself over `POST /hello`, gets an id, is attributed on every call, can be routed
player chat, and can call every tool. **No toolkit configuration is involved** — `agent.client` stays
empty, no adapter runs, no workspace is written.

```json
{
  "mcpServers": {
    "mcptoolkit": {
      "command": "node",
      "args": ["<gameDir>/mcptoolkit/mcp-server/index.mjs"],
      "env": {
        "MCPTK_URL": "http://127.0.0.1:25600",
        "MCPTK_MEMORY_DIR": "<gameDir>/mcptoolkit/memory-data",
        "MCPTK_CLIENT": "your-client-id"
      }
    }
  }
}
```

`MCPTK_URL` must name the port the game actually bound (`ping` reports it as `port`; dev defaults to
25599 and production to 25600). The game writes that number into `config/mcptoolkit.properties` on
first boot, so the file is also a place to read it from. **One port per game**: if two games are told
to bind the same one, the second loses the bind, runs with no bridge, and a session dialing that port
answers about the FIRST game without either end noticing — so if you develop more than one mod, give
each project a port. In a Gradle workspace that is one line, `mcmod.port`, in each repo's
`gradle.properties`. `MCPTK_CLIENT` is optional and is how your host names itself at the handshake.

The key (`mcptoolkit` above) becomes the prefix your session sees in front of every tool, so pick it
once and leave it alone — renaming it re-namespaces every call.

**Registering it from in game.** `/mmcp server register <your project directory>` writes exactly the
JSON above, with the port this game actually bound already in it, and it **merges**: your other MCP
servers in that file are left untouched, and so is any entry you keep under a name of your own — that
one is repointed, never renamed. `/mmcp server` lists what is registered where, and whether each
entry still names the port this game is serving. `/mmcp server remove <dir>` takes our key back out
and leaves the rest of the file alone.

---

## Verify it, do not assume

1. `ping` — it answers `pong: true`, and its `port` is the one your registration dials. If `env` says
   `development` you are on a Gradle run; `production` is a launcher install.
2. `session_list` — your session is in it, with the id your calls are attributed to.
3. Any world read (`get_world_info`, `get_surface`) — the tools reach the game, not just the shim.

If `ping` answers but the tool list is nearly empty, the shim is up and the bridge is not: the shim
serves its local tools honestly while the game is down, and re-announces the full list when the game
appears (`ARCHITECTURE.md`, "Where MCP actually lives").
