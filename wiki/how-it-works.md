# How it works

What is actually running when an agent modifies your game, and the handful of ideas that make its
answers trustworthy. Four things to understand: the **bridge** in the game, the **shim** outside it,
the **mechanism** stamp on every reply, and the **profile** that decides what a session can see.

Read this once and most of the rest of the wiki stops needing explanation. It is about ten minutes.

## On this page

- [The shape: two processes, one door](#the-shape-two-processes-one-door)
- [Why the split is that way](#why-the-split-is-that-way)
- [Mechanism](#mechanism)
- [Coverage: reads that admit what they missed](#coverage-reads-that-admit-what-they-missed)
- [Profiles: what a session can see, and why it is not everything](#profiles-what-a-session-can-see-and-why-it-is-not-everything)
- [Sessions](#sessions)
- [Dev and production](#dev-and-production)
- [Walkthrough: follow one call all the way down](#walkthrough-follow-one-call-all-the-way-down)
- [An agent session](#an-agent-session)
- [Things to keep in mind](#things-to-keep-in-mind)
- [Where to go next](#where-to-go-next)

---

## The shape: two processes, one door

**The game does not speak MCP.** This is the first thing to know, and it is easy to assume otherwise
because the mod ships the MCP server inside its own jar.

There are two halves:

| | **In the game (the mod)** | **In the Node shim (`mcp-server/`)** |
|---|---|---|
| **Protocol** | A private HTTP+JSON API on localhost. `/tools` is the manifest, `/cmd` executes, plus `/hello`, `/heartbeat`, `/activity` | **MCP** — stdio JSON-RPC: `tools/list`, `tools/call`, `notifications/tools/list_changed` |
| **Tools** | Every tool that touches the game: its schema, implementation, permission and mechanism stamp. Extension mods register here too | Tools that never touch the game — per-world memory (`mem_*`), the loop kit, `launch_game` |
| **Surface** | Serves one list to anyone who dials the port | Slices it per session, by profile |
| **Also** | — | The memory layer, Blockbench merged in as a second upstream, the image budget, your loop file |

Your agent program never talks to the game. It spawns `node .../mcp-server/index.mjs`, speaks MCP to
*that*, and the shim turns each call into an HTTP request into the JVM.

The mod carries the MCP server **as a file** (`mcp-server-dist` inside the jar, extracted at boot)
but never as a process.

## Why the split is that way

An MCP client spawns its servers when the client starts — which is routinely when Minecraft is not
running. The game cannot be a stdio child of a program that outlives it. So something has to exist
to be spawned and held onto.

That something is not a baked-in tool list. The shim always fetches `/tools` fresh. While the game is
down it serves **local tools only, honestly** — it does not pretend the game tools exist and fail
later. It polls (every 3 seconds while down, 15 while up) and fires `listChanged` the moment a game
appears, so your session's tool list fills in by itself when you launch the game mid-conversation.

The rest of what lives shim-side is there because it is **per-session policy**: which slice of the
surface you get, what memory this agent has, what a screenshot costs. None of that is the game's
business, and a second session on the same game can have different answers.

One consequence worth stating because people ask: **the bridge port cannot itself be an MCP endpoint
that carries a profile.** The port serves the whole manifest over a private API; the profile belongs
to the shim process a session starts. Making the port an MCP endpoint would mean putting an MCP
server in the JVM and moving profile slicing into Java with it, and the shim-side layers — memory,
Blockbench, local tools — would not come along.

## Mechanism

This is the idea that does the most work in the whole system, and it is one field.

**Every tool declares how it acts, and every reply is stamped with it.**

| Mechanism | What it means | Examples |
|---|---|---|
| `observe` | It read the game. Nothing changed. | `describe_box`, `get_screen`, `query_registry`, `get_log`, `roll_loot` |
| `world_edit` | A direct server edit. Instant, mass-effect, previewable, **undoable**. | `set_blocks`, `place_shapes`, `place_structure` |
| `embodied` | A body did it. Respects reach. **Can fail physically.** | `bot_goto`, `bot_mine`, `bot_place`, `bot_craft` |
| `privileged` | Arbitrary authority. Audited on every call. | `run_command`, `hotswap_class`, `push_asset`, `push_data`, `capture_structure` |
| `local` | Never touched the game at all. | `mem_*`, the loop kit |

The point is that these are **never conflated**. "Clear these trees" done by a bot mining them and
done by `set_blocks` are different acts, with different failure modes, different permissions and
different consequences — so the response says which happened, and carries `undo_id` where one
exists.

What this buys you in practice: **an agent's report of what it did is checkable rather than a
story.** `observe` is a read you can believe. The three acting mechanisms are claims you confirm by
reading the world back. And the discipline behind them is that **a success claim is computed from
the operation's observed outcome, never from intent** — where the outcome cannot be known, the reply
says so instead of asserting.

The corollary you will meet within a day: **`run_command` answers `ok: true` for a command that
parsed.** Minecraft's command system does not report much more than that. It is `privileged`, not
`observe`, and it is telling you to go and look.

## Coverage: reads that admit what they missed

The reads have a matching honesty rule. A reply carries `coverage`, and a `coverage.state` that is
anything other than `complete` means the answer is **partial, and says why** — the box was clipped,
the chunks were not loaded, the budget ran out.

A partial answer that admits it is useful. A partial answer that looks complete is how an agent
confidently tells you a cave is a surface. Whenever you read a reply, read its coverage.

## Profiles: what a session can see, and why it is not everything

Every tool name in your manifest is paid for **on every single turn** of a session — the schema sits
in the context window whether you call it or not. On a forty-turn authoring session, a manifest you
never use is a real bill.

So a session sees a slice, chosen by `MCPTK_PROFILE`:

- **Supported developer roles** — `modding` (**the default**: author blocks, data, structures and
  assets against a running game and read them back), `authoring` (the block half of it), `art`
  (models, spanning the Blockbench upstream), `screens` (the client's own widgets), `inspect`
  (read-only — every tool it serves is `mechanism: observe`, *checked* against the manifest rather
  than promised).
- **Bench configurations, not roles** — `full`, `standard`, `entity`. These exist for measurement.
  `standard` was the default until 0.107.0 and its shape was chosen by a *navigation* benchmark,
  which is why it withholds three block reads an authoring session needs.
- **Experimental research roles** — `play`, `survey`, `survival`. They ship and they work. They are
  not part of the supported developer surface, and each says so on stderr at startup, in `ping` and
  in `tool_surface`.

A tool the profile hides **refuses with `profile_hidden` and names the call that widens it**. It is a
curtain, not a wall: `tool_surface` narrows or widens a session live. Full detail and the per-profile
bills are in [Tool profiles and cost](tool-profiles-and-cost.md).

## Sessions

Every session that dials the bridge registers itself over `POST /hello`, and `session_list` is the
roll call. More than one can be attached to one game at a time.

That matters in two directions. It is how you run a second agent on the same world without them
tripping over each other's tool surfaces — each shim process holds its own profile and its own
memory. And it is why some tools take ownership of a subject: the Blockbench bridge binds a project
to a session so another session's edit to it is refused, because two agents editing one model is not
a merge conflict, it is a lost afternoon.

## Dev and production

Two modes, and `ping` tells you which one you are in (`env`).

**Dev** is a Gradle checkout. Bridge on your declared `mcmod.port` (25599 for the toolkit's own),
on automatically. The `launch_game` local tool can start and restart the game for you. Memory lives
in the repository.

**Production** is a normal launcher install with the jar in `mods/`. Bridge on 25600 by default
(`config/mcptoolkit.properties` disables it; `-Dmcptoolkit.port` overrides either mode). The player
launches the game normally — nothing in the game starts an agent. Memory is pinned to the game
directory.

The bootstrap extracts a slim copy of the Node server into `<gameDir>/mcptoolkit/mcp-server` and
writes `.mcp.json` for you. Re-extraction is gated on the mod version stamp. See [Servers and
production](servers-and-production.md).

## Walkthrough: follow one call all the way down

Worth doing once, because after this the failure modes are obvious rather than mysterious.

**You ask for a block read.** Your agent client sends MCP `tools/call` over stdio to the shim
process it spawned.

**The shim checks its slice.** Is `get_blocks_at` in this session's profile? If not, it refuses with
`profile_hidden` and names the `tool_surface` call that would widen it — the game is never
contacted.

**The shim makes an HTTP request** to `POST /cmd` on `127.0.0.1:<your port>`, stamping the
`X-MCPTK-Session` header so the game knows which session is asking.

**The bridge dispatches by execution context.** `get_blocks_at` is a `server` tool, so it runs on the
server thread — and refuses with `no server running` if no world is loaded. (`any` tools run inline
on the bridge's own thread and answer before a world exists; `client` tools run on the render thread
and are simply *absent* from a dedicated server's manifest.)

**The tool reads, and the envelope is built** — the mechanism stamp, the coverage block, the
dimension actually read.

**Back up through the shim**, which may add its own layers on the way — the remembered appendix from
memory, the image budget if the reply carries a picture — and out to your agent as an MCP result.

Now the failure modes read themselves. *Nothing answers at all* → the bridge is down or you are on
the wrong port. *`profile_hidden`* → the shim stopped it, widen the surface. *`no server running`* →
game up, no world. *A tool that is not in your list on a dedicated server* → it is a `client` tool
and never registered.

## An agent session

The mechanism discipline is most visible when an agent has to correct itself. An abridged session:

> **You:** clear the trees in front of the workshop.

> **Agent** calls `describe_box` over the region.
> → `mechanism: observe`, and `coverage.state: "partial"` — the box reaches into chunks that are not
> loaded.
>
> It says so rather than proceeding: the far half of that region is not readable from here.

> **You:** just do the loaded part.

> **Agent** calls `set_blocks {..., dry_run: true}`
> → 1,847 cells, region reported back, `undo_id: null`.
>
> Then the real call → `mechanism: world_edit`, `undo_id: "e7c1"`, block counts per type.

> **Agent:** cleared 1,847 blocks. That was a direct server edit, not a bot mining them — no items
> dropped and nothing was consumed. `undo_edit {undo_id: "e7c1"}` puts it all back, including any
> block entities.

Three things there are the system rather than the anecdote. The read **refused to overstate its
coverage**. The edit was **previewed with `dry_run` before it happened**, which costs nothing and
changes nothing. And the agent **named the mechanism in its report**, because "cleared the trees" by
`world_edit` and by `bot_mine` leave genuinely different worlds behind — one drops saplings, the
other does not.

## Things to keep in mind

**`ok: true` from `run_command` means it parsed.** Not that it worked. Read the world back if it
matters.

**Read `coverage` before believing a read.** Anything other than `complete` is a partial answer, and
it tells you why.

**The manifest is the truth about tools.** Every table in every document — this wiki very much
included — is a summary of what the running bridge actually serves. `ping` first; `tool_surface` for
the live list.

**A stale JVM answers happily.** A second game cannot bind the port, and the bridge answers from the
*older* process without volunteering that fact. `ping`'s `build` is how you catch it, and it belongs
at the top of anything automated.

**The shim is honest when the game is down.** It serves local tools only rather than pretending. If
your tool list looks short, check whether a game is actually running — and know that it will fill in
by itself when one appears.

**Omniscience is a feature; unlabelled omniscience is a bug.** The toolkit deliberately gives an
agent superhuman access to your game — that is the point of a copilot. What it will not do is let
that access go unlabelled, which is what the mechanism stamp and the coverage block are for. The
constraints in the system are about *authorisation* (what did you permit), not about *realism* (what
could a human body do).

**There is no list of live divergence from the built jar.** Hotswaps and live-pack overrides
accumulate in a running game and nothing enumerates how far it has drifted from your source. If you
have lost track, restart — that is the honest answer and it is cheap.

## Where to go next

**In this wiki**

- [The change loop](the-change-loop.md) — the everyday application of all of this.
- [Tool profiles and cost](tool-profiles-and-cost.md) — profiles in full, and what a session costs.
- [Mod testing](mod-testing.md) — where mechanism, coverage and `ping.build` earn their keep.
- [Servers and production](servers-and-production.md) — the two modes, headless, NeoForge.
- [Glossary](glossary.md) — every term on this page, defined once.

**Reference**

- `ARCHITECTURE.md` § *Where MCP actually lives* — the split, with the reasoning.
- `ARCHITECTURE.md` § *Action: mechanisms, never conflated* — the mechanism table and the
  transactional envelope.
- `ARCHITECTURE.md` § *Perception* — coverage, the tri-state doctrine, and what the reads promise.
- `mcp-server/README.md` § `MCPTK_PROFILE` — the profile set and the environment.
- `docs/platform/HEADLESS.md` — execution contexts, generated from the live manifest.
