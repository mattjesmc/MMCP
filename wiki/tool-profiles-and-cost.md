# Tool profiles and cost

Why your session does not see every tool, how to widen it when you need one, and where the money
actually goes in a long session — which is almost never where people first look.

The short version: **every tool name is paid for on every turn**, whether you call it or not. The
schema sits in the context window and the whole conversation is re-sent on every call. A manifest you
never use is a real, recurring bill.

## On this page

- [What the bill actually is](#what-the-bill-actually-is)
- [Profiles](#profiles)
  - [The set](#the-set)
  - [`profile_hidden` and widening](#profile_hidden-and-widening)
- [Walkthrough: fitting a profile to a session](#walkthrough-fitting-a-profile-to-a-session)
- [Pictures](#pictures)
- [Where the money usually is](#where-the-money-usually-is)
- [An agent session](#an-agent-session)
- [Things to keep in mind](#things-to-keep-in-mind)
- [Where to go next](#where-to-go-next)

---

## What the bill actually is

A session costs **turns × the context each turn carries**. Output tokens are noise beside that.

The context each turn carries has a fixed part — the tool manifest, the system prompt, your charter —
and a variable part that grows: replies, pictures, files read. The fixed part is paid every single
turn, so a tool nobody calls on a forty-turn session is paid forty times.

That is the entire justification for profiles. It is not about safety and it is not about hiding
complexity; it is arithmetic.

## Profiles

`MCPTK_PROFILE` picks which slice of the manifest a session sees. It is set in your `.mcp.json`
registration, or changed live.

### The set

Which group a name belongs to is the first thing to know about it.

**Supported developer roles**

| Profile | For |
|---|---|
| `modding` | **The default.** Author blocks, data, structures and assets against a running game, and read them back |
| `authoring` | The block half of `modding` |
| `art` | Models and textures, spanning the Blockbench upstream |
| `screens` | The client's own widgets |
| `inspect` | Read-only. Every tool it serves is `mechanism: observe` — **checked against the manifest, not promised** |
| `entity` | Adds `stage_entity` and the entity authoring surface |

**Bench configurations, not roles**

`full`, `standard`, `entity`. These exist for measurement. `standard` was the default until 0.107.0,
and its shape was chosen by a *navigation* benchmark — which is why it withholds three block reads an
authoring session needs. If you are benchmarking, pin one explicitly.

**Experimental research roles**

`play`, `survey`, `survival`. They ship and they work. They are **not part of the supported developer
surface**, and each says so — on stderr at startup, in `ping`'s `profile` block, and in
`tool_surface`'s report. `survival` is the player-legal surface: X-ray reads, world edits and the dev
tools hidden, `locate` answered from the session's own observations rather than from the server.

`inspect` deserves a note. "Read-only" is verified against the manifest's mechanism stamps rather than
asserted by a human keeping a list — a profile that hid a name the manifest lacks, or served a
non-`observe` tool, fails the toolkit's own suite.

### `profile_hidden` and widening

A tool the current profile does not serve refuses with **`profile_hidden`**, and the refusal **names
the call that widens it**. It is a curtain, not a wall.

```
tool_surface {profile: "art"}          # switch wholesale
tool_surface {profile: "entity"}       # e.g. to reach stage_entity
```

`tool_surface` narrows or widens a session live. `ping`'s `profile` block says where you currently
stand.

The tool list your client sees updates itself: the MCP server fires `listChanged`, so you do not need
to restart a session to change surface.

## Walkthrough: fitting a profile to a session

**1. Start from the nearest role.** `modding` for blocks and data, `art` for models, `screens` for
GUI work.

**2. Notice what refuses.** A `profile_hidden` refusal names the widening call — so the first time you
hit one, you know exactly what this session actually needs.

**3. For a repeating loop, cut a keep-list.** `.mcptoolkit/loop.json` takes a `profile` block with a
`base` and a `keep` array, so a part-authoring session serves eighteen tools instead of ninety. It
also takes `notes` — per-tool prose appended to that tool's description, which is where unit-specific
rules belong.

**4. Price it honestly, and measure rather than guess.** ArmorPieces re-cut their keep-list on
evidence and found **eleven of nineteen served names had never been called once** across four
sessions — about 2.5k tokens of prefix per turn, 49% of that manifest.

They removed **four**. The others stayed, with the reasons written down: several are *rework* tools,
only called when something goes wrong; one is a health metric whose call count reveals a loss of trust
in the tools, and removing it would hide that.

**An unused tool is not automatically a removable one.** But you should know which is which.

## Pictures

The other half of a long session's bill, and the one that surprises people: **a picture is re-sent on
every later turn.** It is not a one-off cost.

The MCP server's image budget is on by default and costs nothing. Every frame is cropped to its
content, resized to a longest edge (default 384), and **priced on the reply**:

```
picture 232x384 ~119 tok (was 3840x2131 ~1533 tok, content was 7% of the frame);
re-sent every turn after this one
```

`MCPTK_SHOT_MAX` tunes it per session; `0` keeps pictures whole.

Two things follow. **`render`'s `inline` defaults to false** — the normal reply is a path, and you ask
for pixels only when someone will look at them. And **a texture sheet is resized at most, never
cropped**, because its pixel coordinates are what the painters name.

## Where the money usually is

Ranked by what has actually been measured:

**1. The tool called most, if it takes one thing per call.** A face-addressed painter took a part from
82 calls and $5.08 to 2 calls and $2.01. Find the batch version before optimising anything else.

**2. What the session *reads*.** One sibling brief measured at **48% of everything a session carried**.
Distilled lessons beat accumulated examples.

**3. Pictures**, especially ones taken after the last edit — which in three measured sessions bought
nothing at all.

**4. The manifest.** Real, and worth cutting, but usually smaller than the three above. A well-cut
keep-list came to 534 tokens per turn: about 10% of the manifest, roughly a third of a cent per unit.

The lesson from that ordering: cutting the manifest first feels productive and is usually the smallest
of the four.

## An agent session

> **You:** why is this session so expensive? It's only placing cubes.

> **Agent** calls `tool_surface {}` → 26 Blockbench tools plus the game surface.
>
> Then it points at the transcript rather than the manifest: fourteen `capture_screenshot` calls, one
> after each edit, each re-sent on every subsequent turn.

> **Agent:** the manifest is about 5k tokens a turn and worth trimming eventually. The pictures are
> the bill here — fourteen of them, and the last four came after the final edit, so they could not
> have changed anything.
>
> Two changes: take one contact sheet per batch with `capture_screenshot {views}` instead of a
> capture per angle, and give the session a picture budget in numbers.

> **You:** trim the manifest too.

> **Agent:** worth measuring before cutting. Of the 26, this loop has called eight. But `undo`,
> `get_undo_stack`, `texture` and `inspect` are the rework tools — they only get called when something
> goes wrong, and this run had no rework. Cutting them makes the *next* bad run worse.
>
> It proposes cutting the four that are superseded or have never been called in any run, and writing
> down why the rest stay.

The two habits: **look at the transcript before the manifest**, and **do not confuse "unused in this
run" with "removable"**.

## Things to keep in mind

**Every tool name is paid every turn.** Whether or not it is called.

**`profile_hidden` names the call that widens it.** You never have to go looking.

**The default is `modding`.** `standard` is a bench configuration whose shape came from a navigation
benchmark, and it withholds block reads an authoring session needs.

**`play`, `survey` and `survival` are experimental** and say so in three places. They are not the
supported developer surface.

**`inspect` being read-only is checked, not promised** — against the manifest's own mechanism stamps.

**A picture is re-sent on every later turn.** Take the first where it can still change the outcome,
and none after the last edit.

**`inline` defaults to false on `render`.** Keep it that way unless someone is looking.

**Do not content-crop a texture sheet.** Its coordinates are what the painters name.

**An unused tool is not automatically removable.** Rework tools and health metrics look unused in a
clean run, which is exactly when you are tempted to cut them.

**Measure before cutting.** `tools/loop/analyse.mjs` prints the turn and picture costs of a session
and names the most-called tool.

**Do not register two servers for one app.** A separate `blockbench` MCP server beside the toolkit
pays two prefixes on every turn.

## Where to go next

**In this wiki**

- [Authoring at scale](authoring-at-scale.md) — the six levers, in the order to pull them.
- [How it works](how-it-works.md) — where profiles live, and why the port cannot carry one.
- [Rendering and screenshots](rendering-and-screenshots.md) — the image budget in practice.
- [Entities](entities.md) — a concrete case of a hidden tool and how to widen for it.

**Reference**

- `mcp-server/README.md` § `MCPTK_PROFILE` — the profile set and the environment variables.
- `docs/platform/TOOL_BILL_PLAN.md` § 4 — the bill, the levers ranked, and the per-profile prices
  (dated, and honest about it).
- `docs/platform/TOKEN_PER_TOOL_FINDINGS.md` — what a single manifest entry costs.
- `docs/guides/LOOPS.md` — the loop file's `profile` block, `keep` and `notes`.
