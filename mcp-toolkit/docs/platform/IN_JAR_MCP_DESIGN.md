# The game's own MCP server — a second front door, in the jar

**Status: BUILT AND RUN LIVE 2026-09-11, toolkit 0.146.0.** Offline-green (77 unit tests, including a
full initialize/list/call/delete over a real socket, and two clients on one game), **driven against a
running dev server** (§9), and **green inside the whole 109-file battery** (`probes/in-jar-mcp.test.mjs`,
14/0; `RELEASE.md` §2.10). The Node shim, the private `/tools` + `/cmd` API and everything above them are **unchanged and
remain the supported path**; this is supplementary.

> `POST http://127.0.0.1:<bridge port>/mcp` speaks MCP. No Node, no `npm install`, no extracted
> copy of anything, no process to spawn. Point a client at the URL and it is talking to this game.

---

## 1. What this is, and the sentence in ARCHITECTURE.md it answers

ARCHITECTURE.md, under *"Where MCP actually lives (the split, stated plainly)"*, opens: **"The game
does not speak MCP."** That was true of every version up to this one. The port served a private
HTTP+JSON API and the Node server in `mcp-server/` turned MCP into calls against it.

The same section ends with the consequence, written down long before anything was built for it:

> **The consequence, when someone asks for a port that carries a profile.** It cannot, today: the
> port serves the whole manifest over a private API, and the profile belongs to the shim process a
> session starts. Making the port itself an MCP endpoint with a fixed tool surface means putting an
> MCP server in the JVM and moving profile slicing into Java with it — a new front door, not a
> rewrite, and the shim-only layers above (memory, Blockbench, local tools) do not come along.

**This is that front door, built exactly as that paragraph describes it** — including the last
clause, which is a limitation and not an oversight (§2).

## 2. The two doors, and why both stay

| | **Node shim** (`mcp-server/`, unchanged) | **In-jar** (`mcp/`, new) |
|---|---|---|
| How a client gets it | spawns `node …/index.mjs` (stdio) | dials a URL (Streamable HTTP) |
| Needs | Node ≥18, an extracted + `npm install`ed copy | nothing |
| When the game is down | **still there** — serves its local tools honestly, polls, fires `listChanged` when the game appears | there is nothing to connect to |
| Tool list | bridge manifest **+ local tools** + Blockbench, sliced by `MCPTK_PROFILE` | this game's registry, sliced by the URL |
| Memory (`mem_*`), `bot_scan`, `launch_game`, `tool_surface` | yes | **no** |
| Blockbench upstream | yes | **no** |
| Image budget, loop-file gate, route ledger, observation capture | yes | **no** |
| Can change surface mid-session | `tool_surface` | no — reconnect |

**The shim cannot be replaced by this and was never going to be.** An MCP client spawns its servers
when the *client* starts, which is routinely when Minecraft is not running, and the game cannot be a
stdio child of a program that outlives it. Something has to exist to be spawned and held. That
argument is in ARCHITECTURE.md and it is still the whole answer.

**What the new door is for**, in the order the value actually lands:

1. **Nothing to install.** The single largest barrier to somebody else using this toolkit was a Node
   runtime and an extraction step. A client that can dial an HTTP URL is now set up.
2. **A version skew that cannot happen.** `ServerExtract` keeps `<gameDir>/mcptoolkit/mcp-server`
   fresh, and the 2026-08-10 finding was a deployed 0.63.0 shim against a 0.69.0 game, leaking six
   dev tools into a restricted profile for weeks. On this door the tools *are* the running game's
   registry; there is no second copy to drift.
3. **A port that carries a surface.** `/mcp/observe` is a thing a client can be configured with and
   a human can read out loud. See §4.
4. **One dispatch chokepoint, still.** §3.

## 3. What it reuses: `BridgeServer.execute`

The handler does **not** re-implement dispatch. `handleCmd` was split so that everything after
"which tool, which arguments" lives in `BridgeServer.execute(tool, args, session, profile)`, and both
doors enter there:

- `ArgCheck.validate` — an argument a tool does not have is a refusal
- the `wm` intent record, written *before* dispatch
- the loop hop for `SERVER`/`CLIENT` context, the per-tool timeout, and the started-late disclosure
- the `mechanism` stamp, the embodied envelope, the body-state rider, the client observation envelope
- **the audit record** for `world_edit`/`privileged`, success and failure alike
- the oversize tripwire

That list is the reason the split happened first and the endpoint second. A world edit that arrives
unaudited because it came through the newer door is precisely the failure a second implementation
would have produced, and it would have produced it silently.

The one deliberate difference: the MCP door passes **its surface name** where the shim passes its
profile. Both land in `ToolContext.profile()`, which is what stream-level legality rules read — so a
surface named `survival` would be treated as player-legal by `EventTools`, the same as a shim session
launched in that profile.

## 4. The URL is the surface

`/mcp` serves the configured default; `/mcp/<name>` serves that one. Nothing is negotiated and
nothing is switchable mid-session: the client dialled an address, and the address is the answer to
what it is holding. (A request that arrives on a *different* path carrying a live session's id is
refused with a 400 rather than quietly served — one id cannot mean two surfaces.)

Three built-ins, and **only one of them is a list**:

| surface | how membership is decided |
|---|---|
| `full` | everything the registry holds. The default. |
| `observe` | **computed** from the `Mechanism` stamp every tool already carries. A read that ships tomorrow is in it; an edit that ships tomorrow is not. Nothing to maintain. |
| `modding` | an allow-list, **seeded** from the shim's `MODDING_KEEP` (shim 0.73.0, 2026-09-11), minus the shim's own tools. |

**The seed is documented as a seed and the two are independent from that date on.** They are not
synchronized and nothing checks them against each other. That is deliberate: the shim's profile is
per-session policy for a process a session starts, this one is a path on a port, and pretending they
are one thing would mean either a build-time generator (Node at build time, for a Minecraft mod) or a
drift check with nothing to check against. A keep-list's failure mode is silent in both places, and
it is the same trade `art`, `screens` and `inspect` already take shim-side.

**A project declares its own** in `config/mcptoolkit-surfaces.json` — `base`, `keep`, `hide`,
`instructions`, `description` — which is what makes the seed not load-bearing. A declared surface
**intersects** its base's keep-list rather than replacing it: "base `modding`, keep these four" must
never be a way to obtain a tool `modding` does not serve.

## 5. The protocol, and what is not implemented

Streamable HTTP (the `2025-06-18` revision; `2025-11-25`, `2025-03-26` and `2024-11-05` are accepted
if a client asks for one by name). `initialize`, `notifications/initialized`, `ping`, `tools/list`,
`tools/call`. Everything else is a clean `-32601`, which every client is required to tolerate.

Decisions worth the ink:

- **`tools.listChanged` is declared FALSE**, and that is honesty rather than caution. The registry is
  filled during mod init — builtins, then extension mods, then the bridge binds — and nothing adds a
  tool to a running game. The shim declares it *true* because the shim's list genuinely changes (the
  game it proxies comes and goes). This server **is** the game: if it can answer at all, its list is
  final. `GET /mcp` therefore answers **405** rather than opening an SSE stream that would never
  carry anything, which the spec explicitly allows.
- **A failed tool call is a RESULT (`isError: true`), never a JSON-RPC error.** The refusal is the
  answer, and the model is the one that has to act on it; a protocol error is swallowed by the client
  before the model ever sees it. Same for a tool the surface hides and a tool that does not exist —
  both name what happened and what would fix it.
- **Cancellation is accepted and ignored.** `notifications/cancelled` cannot be honoured: the handler
  is on a game loop, and stopping it half-way is how a world edit lands in pieces. The client stops
  waiting, the game finishes the act, and the audit log records it either way.
- **Out-of-order calls are served.** A POST with no session id that is not `initialize` is minted a
  session and answered. It is out of order by the spec and it is exactly what a person with `curl`
  does; refusing a well-formed `tools/list` to teach a lesson about handshakes helps nobody on a
  localhost door into a dev tool.
- **Batches are answered** (an array in, an array out) for clients older than `2025-06-18`.
- **`Origin` must be loopback or absent.** Non-browser clients send none; a browser sends one it
  cannot forge. Without the check, any page the human happens to have open could POST to this port and
  drive their game. A `file://` origin and `http://127.0.0.1.evil.example` are both refused.

## 6. Two session ideas, kept apart

The `Mcp-Session-Id` is the transport's. The toolkit's own session (`Sessions`, an `x…` id) is what
the audit log attributes acts to and what the drone lease arbitrates on. One MCP connection mints one
toolkit session at `initialize`, declares the client's name and version onto it, and `DELETE` aborts
it. An idle connection is reaped after 30 minutes, because a client that exits without a DELETE
otherwise leaves a session the reapers still believe in.

This is what lets every session-bound resource in the toolkit work for an MCP client without a single
one of them knowing MCP exists.

## 7. What a model is told

`instructions` at `initialize` is the `SESSION_CHARTER.md` opening paragraph — the same one the shim
serves — **minus its last sentence**, which names a `tool_surface` tool that does not exist here, plus
one sentence naming the surface the URL chose and saying the list will not change while it is
connected. A declared surface may supply its own paragraph instead.

## 8. Configuration

```properties
# config/mcptoolkit.properties
mcp.enabled=true     # -Dmcptoolkit.mcp=false also turns it off
mcp.surface=full     # what /mcp alone serves
```

On with the bridge by default: same port, same authority, same localhost binding — a different
protocol, not a different exposure. `config/mcptoolkit-surfaces.json` is written with its own
documentation on first run. `/mmcp mcp` in game prints the URL, the surfaces with **live tool
counts**, and the `claude mcp add --transport http …` line.

That count is worth one more sentence: it is the only check a keep-list gets. A typo in a declared
surface shows up here as a number one short of what the author expected.

## 9. As built

| | |
|---|---|
| `mcp/McpEndpoint.java` | the transport: routing, origin, sessions, status codes |
| `mcp/McpProtocol.java` | MCP itself — **no Minecraft imports**, which is what makes the handshake testable offline |
| `mcp/McpSurface.java`, `mcp/Surfaces.java` | what a surface is; the built-ins and the config file |
| `mcp/McpContent.java` | dispatch envelope → `content` parts (`_image` → an image part) |
| `mcp/McpConn.java` | one connection, and the live table |
| `mcp/McpReport.java` | what `/mmcp mcp` SAYS — no Minecraft in it, so the counts are testable |
| `mcp/McpCommands.java` | `/mmcp mcp`: the colour of each line, and the call that sends it |
| `BridgeServer` | `execute()` extracted; `/mcp` context; the boot log line |
| `BridgeConfig` | `mcp.enabled`, `mcp.surface`, and `mcpEnabledWith` (the gate, with the JVM arg that overrules it); the file now reads on the `-Dmcptoolkit.port` path too |
| `McpTools.all()` | the registry, for a surface that decides on the `Mechanism` |

**Offline-green, 77 tests.** `McpTransportTest` runs a real `HttpServer` and a real `HttpClient`
through initialize → notification (202) → list → call → DELETE → 404, plus the surface URL, the
foreign origin, the bad version header, the batch and the parse error — and **two clients at once**,
which is the ordinary case rather than the exotic one (a modding session in one repo and a survival
session in another dial the same port all day) and the one where everything that could collide is
static: two transport ids, two surfaces, two toolkit sessions, and a DELETE that takes exactly its
own. The anonymous caller is pinned there too: a sessionless POST is served and its dispatch carries
no toolkit session at all.

**Four things the first pass left to a live look are now asked as questions.** `McpConn`'s 30-minute
reap runs against a stated clock rather than a wall clock nobody will wait out — a connection aged
past the window is gone, one inside it survives, and a request keeps a connection alive however old
it was, because on this door the lookup every request makes IS the liveness signal. `Surfaces.install`
writes its documented default into a `@TempDir`, and the file it writes is then **read back through
this parser**, which is the only way that text can be wrong and somebody find out before their second
boot. `BridgeConfig` has a test at last: `Platform.install` is the seam the class's own note said it
did not have, and a stub answering two of the loader interface's thirteen questions is enough to ask
what a pre-0.146.0 file inherits, what `mcp.enabled=false` does to the bridge (nothing), and whether
the commented default file states what `load()` then reads out of it. And `/mmcp mcp`'s text moved
into `McpReport`, where the per-surface count — **the only check a keep-list ever gets** — is asserted
against a registry, including the failure it exists to catch: a declared surface with `set_block` in
it prints one tool short and nothing anywhere else ever mentions the typo.

### Live, against `gradlew runServer` on port 25610, 2026-09-11

The boot line, then the whole conversation over HTTP into a real game:

- `initialize` → `2025-06-18`, `serverInfo.version 0.146.0`, `Mcp-Session-Id` header, the
  instructions paragraph with the surface sentence appended.
- `tools/list`: **73** tools at `/mcp`, **31** at `/mcp/observe`, **35** at `/mcp/modding` — headless,
  so the client-context tools are absent from all three, which is why `modding`'s 35 is below its
  list length and is the honest number.
- `tools/call ping` → the live instance: `serverRunning:true`, `build.mods_hash`, the real game dir.
- `tools/call set_blocks` with invented arguments → **`ArgCheck` refused it through the new door**,
  with the same "the call was NOT run" message `/cmd` gives. That is the §3 claim, live.
- `tools/call run_command` → `mechanism:"privileged"` on the result, and `get_events {type:"audit"}`
  came back carrying `"session":"x1-88551"` — **the audit trail attributes an MCP client's act to the
  toolkit session the door minted for it**, which is the §6 claim, live.
- `set_blocks` on `/mcp/observe` → the surface refusal, naming the surface and `/mcp/full`.
- `GET` → 405, `/mcp/nope` → 404, `DELETE` → 200, and the same session afterwards → 404.
- `/mmcp mcp` (through `run_command`) printed the URL, the `claude mcp add` line and the three
  surfaces with their live counts.
- The server was **stopped through this door** (`run_command stop`), which is as end-to-end as the
  privileged path gets.

**One thing the live run found and changed the code for.** `/mmcp mcp` reported "5 client(s)
connected" after five probing `curl`s: every sessionless POST was minting a toolkit session. It no
longer does — an anonymous caller stays anonymous (the audit field's absence has always been able to
say so), and only `initialize` mints. A stray request must not leave an entry the session reapers
then believe in.

### The probe, and the gap it was closing

Every one of the suite's 110 probe files drives `/cmd`. **Until `probes/in-jar-mcp.test.mjs`, a
regression in this door had nothing red to land on** — it would have reached a release with a fully
green battery, because the battery could not see it. That file is now chunk `b` in
`tools/battery.ps1` (declared the day it was written, rather than after the unlisted-probe WARN had
to name it a fourth time), and it runs the four claims this record makes, live and without the shim:
the handshake, the URL-is-the-surface trio, the shared chokepoint (argument gate + mechanism stamp +
**an audit row carrying the minted session**), and the transport rules. **14/14 green, 2026-09-11.**

`observe`'s check is worth naming: the probe reads `GET /tools` and asserts the served list equals
exactly the manifest's `mechanism == "observe"` entries, in both directions. A computed surface can
be falsified against the registry; a keep-list can only be compared to a copy of itself.

The old door was re-checked after its dispatch path was split: `arg-check`, `event-stream`,
`attach-identity`, `headless-surface`, `context-column` (28/28) and `conformance` (44 pass, 6 skipped
for want of a client) — all green.

**And the full battery HAS now been re-run** (`RELEASE.md` §2.10, 2026-09-11): **109 files, 916 pass /
1 fail**, one part, 29 minutes, on the same save and the same loader-only arm as the 0.145.0 release
battery. `in-jar-mcp` ran **14/0** inside it, which is the first time this door has been covered by
the thing that gates a release. Compared verdict by verdict against that run, **107 of the 108 shared
files are identical**; the two differences are this file (new) and `render-camera`, whose "the player
is put back where they were standing" case went 16/1 and was **17/0 alone** ten minutes later — its
restore assertion passed, nothing in this version touches rendering, and §2.10 records what is known
and that it is undiagnosed.

**Not covered by anything but a live look, stated so nobody has to discover it**: the `mcp.enabled`
gate's other half — that `BridgeServer.start` does not create the `/mcp` context when the door is off
— which needs a bind and a boot to observe; and the COLOUR of each `/mmcp mcp` line, which is all
that is left in `McpCommands` now the text has moved out of it.

**Still owed, and it is a small one**: the handshake of a real *client* (`claude mcp add --transport
http`) rather than `curl` shaped like one. Every rule it checks is covered above or in
`McpTransportTest`, but a client is the only thing that can prove a client.
