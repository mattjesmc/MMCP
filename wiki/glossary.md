# Glossary

Words that mean something specific here. Where a term is doing real work, the entry says *why* it is
defined that way rather than just what it is — because in most cases the definition is the design
decision.

## On this page

- [The shape of the system](#the-shape-of-the-system)
- [Honesty vocabulary](#honesty-vocabulary)
- [Content and change](#content-and-change)
- [Sessions and cost](#sessions-and-cost)
- [Authoring](#authoring)
- [Testing](#testing)
- [Words used carefully](#words-used-carefully)

---

## The shape of the system

**Bridge** — the private HTTP+JSON API the mod opens inside the running game, on `127.0.0.1` and
nothing else. `/tools` is the manifest, `/cmd` executes. It is not MCP and the game does not speak
MCP.

**Shim** (also *the MCP server*, `mcp-server/`) — the Node process that speaks MCP to your agent
client and HTTP to the bridge. It holds everything that is per-session policy: profiles, memory, the
image budget, the loop file, and the Blockbench upstream. Your agent never talks to the game
directly.

**Manifest** — what the bridge serves at `GET /tools`: every tool, its schema, its mechanism and its
execution context. **The manifest is the truth about tools**; every table in every document, this
wiki included, is a summary of it.

**Port** — a per-project constant that *names* the project. Two dev games on one port do not both
work: the second cannot bind, and the bridge answers from the older JVM without saying so.

**Session** — one agent conversation attached to a game. Registers itself over `POST /hello`;
`session_list` is the roll call. Several can share a game, each with its own profile and memory.

**Execution context** — where a tool runs, declared per tool. `server` (server thread, needs a loaded
world), `client` (render thread, **never present on a dedicated server**), `any` (the bridge's own
thread, no world needed).

**Dev / production** — dev is a Gradle checkout with the bridge on your declared port and
`launch_game` available; production is a normal launcher install with the jar in `mods/`, bridge on
25600. `ping`'s `env` says which.

## Honesty vocabulary

These four are the load-bearing ideas. If you only learn four terms, learn these.

**Mechanism** — how a tool acts, stamped on every reply.

| | |
|---|---|
| `observe` | Read the game. Nothing changed. Believable as-is |
| `world_edit` | Direct server edit. Instant, mass-effect, previewable, undoable |
| `embodied` | A body did it. Respects reach. **Can fail physically** |
| `privileged` | Arbitrary authority. Audited every call |
| `local` | Never touched the game |

They are **never conflated**: clearing trees by bot-mining and by `set_blocks` are different acts with
different failure modes and consequences, so the reply says which happened. This is what makes an
agent's report checkable instead of a story.

**Coverage** — every read carries one. A `coverage.state` other than `complete` means the answer is
**partial and says why** — clipped box, unloaded chunks, budget spent. A partial answer that admits it
is useful; one that looks complete is how you get told a cave is the surface.

**Act verdict** — a success claim is **computed from the operation's observed outcome, never from
intent**. Where the outcome cannot be known, the reply says so rather than asserting. Silent
wrong-success is treated as worse than failing opaquely.

**Stale** — `ping.build.stale: true` means the code on disk is newer than the JVM answering you. The
shape of "a second launch could not bind the port, and every call came from the old game".

## Content and change

**Live pack** — a toolkit-managed override folder, one for client assets
(`resourcepacks/mcptoolkit_live`) and one for server data (`<world>/datapacks/mcptoolkit_data`), both
sitting on top of your mod and vanilla. Plain folders: they **persist across restarts** and keep
winning until cleared.

**Promotion** — moving a file from a live pack into your mod's source tree. It rides on the *clear*
(`clear_assets {promote}`) because the step people forget is the clear, and an override left behind
keeps beating the file you just wrote. Copy first, delete second, always.

**Hotswap** — redefining a loaded class's method bodies in the running JVM. Mod classes only; no
added or removed fields, methods or classes. A mixin-transformed or Minecraft class redefined this way
**silently loses its load-time transforms**.

**Structural** — any change a hotswap cannot carry: a new class, field, method, registration, or a
changed constructor call. Block settings like light level count, because they are set at
construction. Structural means a rebuild.

**Dry run** — validate and report without changing anything. On a write, the `undo_id` comes back null,
which is how you tell a preview from a real edit. On `push_data`, it runs your file through the game's
own codec.

**Undo journal** — a shared bounded journal (32 edits) of world edits. Snapshots block state **and
block-entity NBT**, so undoing over a chest brings its items back. Over 200,000 cells an edit applies
with no undo and says so. Clears at server stop.

## Sessions and cost

**Profile** — the slice of the manifest a session sees, because **every tool name is paid for on every
turn**. Default `modding`. A hidden tool refuses with `profile_hidden` and names the `tool_surface`
call that widens it — a curtain, not a wall.

**Keep-list** — a hand-cut profile in `.mcptoolkit/loop.json`: a `base` plus the tools this loop
actually needs, plus `notes` (per-tool prose appended to that tool's description).

**Image budget** — the shim crops each frame to its content, resizes it to a longest edge (default
384) and prices it on the reply. On by default. A picture is **re-sent on every later turn**, so it is
a recurring cost, not a one-off. `MCPTK_SHOT_MAX` tunes it.

**Prefix** — the fixed part of a turn's context: manifest, system prompt, charter. Paid every turn.

## Authoring

**Unit** — one thing a loop makes: a part, a skin, a screen, a room. The loop is one session per unit,
each from a brief.

**Loop file** — `.mcptoolkit/loop.json`. Holds `checks` (a command run after editing calls) and
`profile` (base, keep-list, notes, instructions).

**Gate** (loop file) — tools refused while the last check reported problems.

**Brief** — the input to a unit session: what to make, and the rules for making it, including a
picture budget in numbers.

**Document** (screens) — a `.ui.json` layout that `init()` re-reads, previewed by the interpreter,
compiled to plain vanilla-API Java by the emitter. **Layout is data; behaviour is code.**

**Studio** — a dimension with no sky, a white background and flat full-bright light, where a subject
is staged so `render` can photograph it against nothing. With `freeze`, two renders are
**pixel-identical**.

**Staging** (entities) — pushing geometry into the live pack and standing a **preview entity** wearing
it. The preview entity is the toolkit's own; this does **not** register an entity type for your mod,
and never will — the registry freezes at bootstrap.

## Testing

**Tier** — checks grouped by **what they need to run**: 0 the tree, 1 the JVM, 2 a dedicated server,
3 a client. That is what decides whether a check can run at all on a given machine.

**Scenario** — a tier-2 check: a few bridge calls and what their answers have to say.

**Golden** — a frame **a person has looked at** and said is right. Nothing may write one
automatically; a scene with no golden reports `new` and fails, rather than passing. Blessing a frame
nobody looked at turns visual regression into a machine asserting your mod still draws whatever it
drew the day it broke.

**Bless** — the explicit human act of accepting a frame as a golden.

**Falsifier** — a case that must *fail*, paired with a check whose assertion is a restriction. Without
one, the cheapest way to make the check green is to delete the restriction.

**Review queue** — the queue for claims only a person can settle. `review_post` files an ask,
`review_status` reads answers, `/mmcp review` walks a person through it. **An ask with no failure mode
is refused**, and a verdict **gates nothing** — a subjective judgement that could fail a build turns
an opinion into a merge conflict.

**Checked** (vs `ok`) — a review ask can carry a `check` command whose success closes it as `checked`,
never `ok`, because "the world satisfies this" and "a person looked and was happy" are different
facts.

## Words used carefully

**"It worked"** — from `run_command`, `ok: true` means the command **parsed**. Nothing more.

**"It loaded"** — a successful reload means the reload ran. Vanilla logs a malformed file and steps
over it, so read `problems`, not `reloaded`.

**"It decodes"** — `push_data {dry_run}`'s `valid: true` means these bytes decode here. Not that
anything they reference exists.

**"The tag is empty"** — read `tag_exists`. An empty list means both "loaded, matched nothing" and
"never loaded", and you are nearly always in the second.

**"It exists"** — an unknown loot table rolls **nothing** rather than refusing, because the game's own
`getLootTable` returns an empty table for an unknown id. Check `exists` before reading the numbers.

**"Omniscience"** — the toolkit deliberately gives an agent superhuman access to your game. That is
the point of a copilot. **Unlabelled** omniscience is the bug — hence mechanism and coverage.

**"Not in release 1"** — a stated absence, listed with the route that exists today. A modder meeting a
stated absence trusts the rest of the page; one discovering an unstated absence does not.

## Where to go next

- [How it works](how-it-works.md) — the honesty vocabulary, in context.
- [The change loop](the-change-loop.md) — live packs, hotswap, structural, promotion.
- [Mod testing](mod-testing.md) — tiers, scenarios, goldens, falsifiers.
- [Tool profiles and cost](tool-profiles-and-cost.md) — profiles, keep-lists, the image budget.
- `ARCHITECTURE.md` — the full vocabulary and the decisions behind it.
