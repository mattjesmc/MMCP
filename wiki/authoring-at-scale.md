# Authoring at scale

When it is ninety parts rather than one. A session that makes one *unit* — a part, a skin, a screen,
a room — over and over from a brief has a cost structure that a one-off session does not, and the
levers that matter are not the ones people reach for first.

Everything here comes from a project that actually did it: ArmorPieces, 91 parts and 14 skins, which
ran the loop through a proxy of its own and measured every lever before the toolkit generalised them.
The numbers on this page are that project's, not estimates.

## On this page

- [The arithmetic](#the-arithmetic)
- [The levers, in the order to pull them](#the-levers-in-the-order-to-pull-them)
  - [1. The image budget](#1-the-image-budget)
  - [2. A check on every reply](#2-a-check-on-every-reply)
  - [3. A profile that fits the unit](#3-a-profile-that-fits-the-unit)
  - [4. Batch tools](#4-batch-tools)
  - [5. Pinned judgement](#5-pinned-judgement)
  - [6. One session per unit](#6-one-session-per-unit)
- [Walkthrough: setting up a loop](#walkthrough-setting-up-a-loop)
- [Measuring it](#measuring-it)
- [An agent session](#an-agent-session)
- [Things to keep in mind](#things-to-keep-in-mind)
- [Where to go next](#where-to-go-next)

---

## The arithmetic

A session costs **turns × the context each turn carries**. Output tokens are noise beside that.

Two consequences decide everything else:

**1. The tool that acts on one unit per call sets the price.** Every call re-sends the whole
conversation. A face-addressed painter took a part from **82 paint calls and $5.08 to 2 calls and
$2.01**. A `stamps` list took a skin from 73 calls to 3. If your loop calls one tool forty times, that
tool is your bill — not the model, not the prompt.

**2. Pictures are the other half.** A picture costs roughly `width × height / 750` tokens after the
API's own downscale, and it is **re-sent on every later turn**. Across nine skin sessions the images
outweighed every text reply put together — and in the leanest three, every screenshot came *after the
last edit* and bought nothing at all.

## The levers, in the order to pull them

### 1. The image budget

**On by default, costs nothing.** Every frame the MCP server hands the model is cropped to its content
and resized to a longest edge (default 384), then priced on the reply:

```
picture 232x384 ~119 tok (was 3840x2131 ~1533 tok, content was 7% of the frame);
re-sent every turn after this one
```

That applies to `screenshot`, `render {inline: true}`, `screenshot_annotated`, the Blockbench viewport
and app captures, and the painters' `look`. `MCPTK_SHOT_MAX` tunes it per session; `0` keeps pictures
whole.

**A texture sheet (`get_texture`) is resized at most and never cropped** — its pixel (x, y) is what
`paint_faces pixels` and `paint_ascii at` name, and a crop would move every texel you read off it.

`screenshot` also takes a `crop`: a GUI rectangle, or `{"widget": <index>}` / `{"id": "<element
id>"}` from `get_screen {detail: "layout"}`. **A screen check wants the widget, not the 4K frame.**

The lever you control: **give the agent a picture budget in its brief, in numbers** ("six pictures"),
with the rule — take the first one where it can still change what you draw, and none after the last
edit.

### 2. A check on every reply

Put `.mcptoolkit/loop.json` beside your `.mcp.json`:

```json
{
  "checks": [{
    "name": "part",
    "after": { "mechanism": ["world_edit", "blockbench_edit"], "tools": ["risky_eval"] },
    "run": ["python", "tools/check_part.py", "--status", "--json", "--brief"],
    "stateful": true,
    "gate": ["export_model"],
    "timeout_ms": 5000
  }]
}
```

**`after` selects by mechanism, not by tool name.** The manifest stamps every bridge tool
(`observe`, `embodied`, `world_edit`, `privileged`), and the Blockbench plugin stamps its own the
same way — `blockbench_edit` is every Blockbench tool that edits, painters included. A mixed tool
like `project` stamps each reply with what that op actually was, so `project op:list` fires nothing.
`tools` adds names, `not` removes them. **Read-only calls never trigger a check**, and that is derived
rather than maintained by hand.

Selecting on mechanism is the whole point: a name list goes stale the moment the tool surface changes.

**`run`** is any command whose last stdout line is JSON: `{"text", "problems", "notes", "full"}`. The
server appends `text` to the reply. A checker that cannot run is reported **loudly** on the reply —
`[loop] check "part" could not run: …` — because a check nobody executes is not a guard.

**`stateful`** hands the previous report back as `--previous <file>`, which is how "a face that was
complete and grew" becomes a diff rather than a memory. One caution: the history is **per server
process**. If your project's own MCP server also edits the unit and runs the same checker, each caller
has its own previous report, and a face painted through one and grown through the other is a regrow
nobody reports. A checker with two callers should keep its own history beside the unit and ignore
`--previous`.

**`gate`** names tools refused while the last report has `problems > 0`.

**The reply is where the numbers go.** This is the subtle one. The check's `text` is the seam for
putting into the reply what the agent would otherwise spend *turns* researching. A checker that
prints, for every cube whose net moved, the sheet rectangles of its faces has told the agent where to
paint — on the same reply that placed the cube. ArmorPieces measured that block at 491 tokens over
eight replies, and the session never opened another piece to place against its neighbours. The whole
check block cost 3,353 tokens over 18 replies in that session and still paid for itself: one
coplanarity line on the first cube pass meant no nudging pass on any bone.

### 3. A profile that fits the unit

Every tool name is paid on every turn. A loop file carries a `profile` block — a `base` plus a
`keep` list — so a part-authoring session serves eighteen tools instead of ninety.

It also carries `notes`: per-tool prose appended to that tool's description, which is where
unit-specific rules belong ("in an Armor Piece, leave `uv_offset` alone; box UV is laid out on every
resize"). And `instructions`, the paragraph the session starts with.

**Price the keep-list honestly.** ArmorPieces re-cut theirs on evidence and found **eleven of nineteen
served names were never called once** across four sessions — about 2.5k tokens of prefix on every
turn, 49% of that manifest. But they removed only four, and wrote down why the other seven stayed:
some are the *rework* tools, only called when something goes wrong; one is a health metric whose call
count reveals a loss of trust in the tools. **An unused tool is not automatically a removable one** —
but you should know which is which, and that means measuring rather than guessing.

### 4. Batch tools

Go back to lever 1: the tool called most sets the price. If it takes one thing per call, find the one
that takes a list.

`place_shapes` over `place_shape`. `paint_faces` and `paint_ascii` over per-pixel writes. `set_blocks`
with `layers` over scattered `blocks`. `capture_screenshot {views}` composing a contact sheet over an
angle-and-a-capture each.

### 5. Pinned judgement

The expensive kind of context is not the manifest — it is what a session *reads*. ArmorPieces measured
one sibling brief at **48% of everything a session carried**.

The fix is a distilled lessons document rather than a pile of previous briefs: what was learned,
stated once, rather than examples the model has to re-derive from.

### 6. One session per unit

A fresh session per unit keeps the context from growing across units. `tools/loop/run-unit.ps1` in the
toolkit is the runner; the brief is the input, and the check is the arbiter.

## Walkthrough: setting up a loop

**1. Write the checker first.** One program, one unit, JSON on the last line. You will use it three
ways: the loop gate, a tier-0 check over everything, and by hand while building one. See
[Mod testing](mod-testing.md).

**2. Add `.mcptoolkit/loop.json`** with that checker under `checks`, selected by mechanism.

**3. Cut the profile.** Start from the closest base (`art` for models, `modding` for blocks and data),
keep what the unit needs, and write `notes` for the traps specific to your unit.

**4. Write the brief**, with a picture budget in numbers and the rule about when to spend them.

**5. Run one unit by hand** and read the transcript. Which tool was called most? Does it take a list?

**6. Measure it** before scaling to ninety.

## Measuring it

```
node tools/loop/analyse.mjs <log.jsonl>
```

It works on a `claude -p --output-format stream-json` log or a Claude Code transcript, prints the turn
and picture costs, and ends with the line that matters: **which tool was called most, and whether it
takes a list.**

Two traps in reading these numbers, both learned the hard way:

- **Per-message `usage` in a stream-json log has no output or thinking tokens.** Read the *result*
  line.
- **A headless `claude -p` grants no tools by default.** A run that looks suspiciously cheap may have
  done nothing.

## An agent session

The loop's own session is short and repetitive by design. What is worth showing is the turn where the
check does its job:

> **Agent** calls `place_cube` for the horn bone's four cubes — in one call, because the reply's face
> rectangles are what it needs to paint next.
> → the placement reply, and appended to it:
>
> ```
> [part] 4 cubes, 2 problems
> ! horn_l/horn_r coplanar at x=3.5 (shared face, z 2..6)
> ! stray paint: 34 texels outside current face rects
> ```

> **Agent** fixes the coplanarity with `element {op: "set", origin: ...}` and clears the stray texels
> with `texture {op: "rects", c: null}` — which reports how many it cleared.
>
> Neither of those needed a screenshot, and neither needed a turn spent asking where the faces are:
> the check put the rectangles in the reply.

> **Agent** spends its **first** picture here, with the geometry settled and the paint still
> changeable.

The whole discipline in one exchange: **the check rides the reply**, so a mistake is caught on the
turn it is made; the **finding is text**, so it costs nothing; and the picture is spent while it can
still change the outcome.

## Things to keep in mind

**The tool called most is your bill.** Find the batch version of it before optimising anything else.

**A picture is re-sent on every later turn.** It is not a one-off cost. Take the first one where it
can still change what you draw, and none after the last edit.

**Select checks by mechanism, not by tool name.** Name lists go stale; mechanism does not.

**A checker that cannot run must be loud.** A silent check is worse than no check, because you will
trust it.

**`stateful` history is per server process.** Two callers, two histories, and a regrow nobody
reports. A checker with two callers keeps its own.

**Put research in the reply.** The check's `text` is where you pay tokens once to save turns.

**An unused tool is not automatically removable.** Some are rework insurance; some are health metrics.
Know which, and write down why each one stays.

**What a session *reads* is usually the bigger half.** One brief measured at 48% of everything a
session carried. Distil lessons; do not accumulate examples.

**Read the result line, not per-message usage.** Output and thinking tokens are not in the latter.

**A headless run with no tools granted looks cheap because it did nothing.**

**Do not content-crop a texture sheet.** Its pixel coordinates are what the painters name.

**`risky_eval` refuses `//`, `/*` and `console.`** — a trap worth knowing before you write an eval
that silently will not run.

## Where to go next

**In this wiki**

- [Mod testing](mod-testing.md) — the checker, and the three ways one pays for itself.
- [Tool profiles and cost](tool-profiles-and-cost.md) — what a manifest entry costs per turn.
- [Textures and models](textures-and-models.md) — the Blockbench half most loops run on.
- [Rendering and screenshots](rendering-and-screenshots.md) — the image budget in practice.

**Reference**

- `docs/guides/LOOPS.md` — the how-to, with all six levers and the numbers.
- `docs/loops/LOOP_KIT_DESIGN.md` — the design, what ArmorPieces measured, and §11 where the kit was
  falsified by the next part it met.
- `tools/loop/` — the agent template, `run-unit.ps1`, `analyse.mjs`.
- `docs/platform/TOOL_BILL_PLAN.md` § 4 — the per-profile bills.
