# Structures and building

Putting blocks in the world at scale, and getting them back out again as something you can ship. Four
tools carry this: `set_blocks` for exact cells, `place_shape` / `place_shapes` for geometry,
`capture_structure` and `place_structure` for saving a build as a vanilla `.nbt`, and `undo_edit` for
when it goes wrong.

Everything here is `mechanism: world_edit` — a direct server edit. Instant, mass-effect, previewable
and **undoable**, which is the property that makes it safe to be bold. Building the same thing with a
bot body is a different act with different consequences and lives on a different page.

## On this page

- [How it works](#how-it-works)
  - [Two ways to say which cells](#two-ways-to-say-which-cells)
  - [Shapes](#shapes)
  - [Dry runs, and why a batch preview is not obvious](#dry-runs-and-why-a-batch-preview-is-not-obvious)
  - [Undo](#undo)
- [Walkthrough: build a room, capture it, place it back](#walkthrough-build-a-room-capture-it-place-it-back)
- [The read/write round trip](#the-readwrite-round-trip)
- [An agent session](#an-agent-session)
- [Things to keep in mind](#things-to-keep-in-mind)
- [Where to go next](#where-to-go-next)

---

## How it works

### Two ways to say which cells

`set_blocks` is the structured equivalent of running many `/setblock` commands, and it takes cells in
either of two forms — one engine behind both.

**`blocks`** — scattered exact positions, `{x, y, z, block}` each, where `block` is the ordinary
vanilla block string: an id, an optional `[state]`, an optional `{nbt}`.

```jsonc
set_blocks {blocks: [
  {x: 10, y: 65, z: 10, block: "minecraft:oak_stairs[facing=east,half=top]"},
  {x: 11, y: 65, z: 10, block: "minecraft:chest[facing=north]{Items:[{Slot:0b,id:\"minecraft:diamond\",count:5}]}"}
]}
```

**`min` + `legend` + `layers`** — a dense little volume drawn as text. You never index anything; the
tool turns every character into a coordinate. `layers[0]` is the bottom course, `rows[0]` is the
lowest z, character *i* is `min.x + i`. `legend` maps one character to one block string or to
`"keep"`; `.` defaults to air and a space to keep.

```jsonc
set_blocks {
  min: {x: 10, y: 65, z: 10},
  legend: {"#": "minecraft:stone_bricks", "o": "minecraft:glass"},
  layers: [["###", "#o#", "###"]]
}
```

Pass both forms in one call and it refuses, having written nothing — they would fight over the same
cells.

The grid form has a guard rail worth knowing about: a ragged row, an unknown character or a label
that disagrees with `min` **refuses the whole call having written nothing**, and the reply echoes
`parsed` (the size it read) and `per_symbol` (counts per character), so you confirm the grid by
count rather than by squinting at it.

**Physics is off by default.** Neighbour updates are suppressed, so no water or gravity cascade
mid-build. Pass `physics: true` for normal updates when you actually want them.

**Coordinates are absolute, and the write goes to `dimension`** — default overworld. Pass the
dimension you read from, so a read/write round trip lands in the same world. The reply stamps the
dimension actually written.

### Shapes

`place_shape` draws geometry rather than cells: **box, line, cylinder, ellipsoid**, with `mode` of
`solid` | `hollow` | `frame` | `walls`, plus `thickness` and `axis`. It is the right tool whenever
you would otherwise be computing coordinates.

`place_shapes` (plural) takes an array of those ops in **one call, one transaction**. The batch is
the unit a person reverts, so an N-op call files **one** journal entry and returns **one** `undo_id`.
The block ceiling is a budget over the *call* rather than per op, and the reply carries
`truncated_at_op` plus per-op `partial` / `not_run`, because with a call-wide budget an op can be
reached with the budget already spent — and all-zero counters would otherwise mean two different
things.

Ops apply in array order and **each one reads what the ones before it left**, which is what makes the
canonical authoring move work: fill a shell, then carve air inside it.

A malformed op refuses the whole call, naming its index. Parse is separated from execute deliberately:
a half-applied batch leaves a structure whose remaining ops were written against geometry that never
appeared.

### Dry runs, and why a batch preview is not obvious

`dry_run: true` validates and reports the region and counts without changing anything. The `undo_id`
comes back null, which is how you tell a preview from a real edit.

For a **batch**, the preview carries an overlay of pending writes so the simulated ops see each
other. Without it every op would read the untouched world — and then the fill-then-carve move
previews the carve as "already air, 0 placed", while a second solid op over the same cells previews
those cells twice. Same cause, opposite errors.

Which is also why the toolkit's own probe for this asserts that **the preview equals the live run**
rather than comparing against a hand-computed constant. If you write checks over your own builds,
steal that: a preview is only useful if it is the same answer.

### Undo

Undo is a shared bounded journal — 32 edits. Each edit snapshots the prior block **state and
block-entity NBT** and restores bit-identically through vanilla `BlockInput`, so undoing over a chest
brings its items back.

```
undo_edit {undo_id}      # defaults to the latest; undoes out of order too
list_edits {}
```

Two bounds stated rather than hidden. An edit over the cap (200,000 cells) **applies and says so** —
`undo_reason: over_cap` beside a null `undo_id`, which is distinguishable from a dry run. And the
journal clears at server stop: an edit is only restorable into the level it was recorded against.

If an undo throws part way through, the unrestored remainder is re-filed under the same id and the
reply says so, rather than destroying the only record of a half-undone region.

## Walkthrough: build a room, capture it, place it back

**1. Rough the shell in with a shape.**

```jsonc
place_shapes {ops: [
  {shape: "box", min: {x: 0, y: 64, z: 0}, max: {x: 9, y: 69, z: 9},
   block: "minecraft:stone_bricks", mode: "hollow"},
  {shape: "box", min: {x: 1, y: 65, z: 1}, max: {x: 8, y: 68, z: 8},
   block: "minecraft:air", mode: "solid"}
], dry_run: true}
```

Read the counts. Then run it for real and keep the `undo_id`.

**2. Detail it** with `set_blocks`, in grid form for anything dense.

**3. Capture it.**

```
capture_structure {min: {x: 0, y: 64, z: 0}, size: {x: 10, y: 6, z: 10}, id: "mymod:rooms/library"}
```

That writes `data/mymod/structure/rooms/library.nbt` inside the live datapack — a vanilla `.nbt`,
nothing proprietary.

**4. Put it back somewhere else.**

```
place_structure {id: "mymod:rooms/library", at: {x: 100, y: 64, z: 100}, rotation: "clockwise_90"}
undo_edit {undo_id}      # if it landed wrong
```

Rotation accepts `90` / `180` / `270` as aliases for the vanilla names, and the reply always echoes
the canonical one.

**5. Promote it** into your mod when it is right — `clear_data {path: "data/mymod", promote: "..."}`.
See [The change loop](the-change-loop.md).

Why `place_structure` rather than `run_command "/place template …"`: that command route **cannot tell
you the template was not found**, because `run_command` reports `ok: true` for a command that failed —
and a missing template is the most likely thing to go wrong. It also has no undo and no dry run.

Here, a missing template is a refusal that names it and points at `query_registry {registry:
"structure_template"}` for what *is* loaded. A template pushed into the live pack needs a
`reload_data` before the game can see it.

## The read/write round trip

`describe_box {detail: "layers"}` returns the world as the same text grid `set_blocks` accepts — and
its output **pastes back verbatim**. Its `y` keys, its `z=20|` row labels and its `x: 10..14` ruler
are all *checked* against the `min` you pass, so a paste that has drifted refuses instead of writing
in the wrong place.

That round trip is the thing to reach for when you want to copy a piece of the world, change three
blocks, and put it back. Read it, edit the text, write it.

`query_registry {registry: "block", entry: "..."}` closes the same loop for a single block: it hands
back `default_state` **in `set_blocks` syntax**, so a read feeds a write without you composing a
state string by hand.

## An agent session

> **You:** build me a 10×10 library room at spawn, hollow, with a doorway on the south side.

> **Agent** calls `place_shapes` with three ops — shell, interior carve, doorway — and `dry_run:
> true`.
> → `1,304` placed, region reported, `undo_id: null`, and no `truncated_at_op`.
>
> It reports the counts before doing anything.

> **You:** go.

> **Agent** runs the same call without `dry_run` → `mechanism: world_edit`, `undo_id: "a41f"`, and
> the counts match the preview exactly.
>
> Then `render {look_at: <the region the reply returned>, inline: true}`.

> **You:** the doorway's on the wrong wall.

> **Agent** calls `undo_edit {undo_id: "a41f"}` → restored, including the two chests that were
> standing where the shell went, with their items.
>
> One undo, because the whole batch was one transaction.

> **Agent** re-runs with the doorway op moved, then `capture_structure {id: "mymod:rooms/library"}`
> so the version you approved is saved rather than existing only in that spot in that world.

The pattern: **preview, run, look, undo, redo** — and the batch being one transaction is what makes
the undo a single call rather than an unpicking exercise. Note also that the agent captured the
approved version instead of leaving it in the world, which is the difference between a build and an
asset.

## Things to keep in mind

**A batch is one undo.** One `undo_id` for the whole call. That is the point of it — the batch is the
unit a person reverts.

**Over 200,000 cells there is no undo.** The edit applies and says so, with `undo_reason: over_cap`.
Check before you commit to something enormous.

**The journal is 32 edits and clears at server stop.** It is a working undo, not a history.

**Undo restores blocks; it cannot un-spawn a mob.** `place_structure` has `entities: false` by
default for exactly this reason, and if you turn it on the reply carries an `undo_note` saying so
rather than leaving you to discover it.

**An unloaded destination refuses the whole placement.** Reads never generate terrain, so a placement
into never-generated space would be a half-built structure reported as a whole one.

**Physics is off unless you ask.** Which is usually what you want mid-build, and occasionally is not
— sand and water will sit there unnaturally until something updates them.

**Pass the dimension you read from.** Default is overworld. A round trip that reads the Nether and
writes without saying so lands in the wrong world, and the reply stamps which one it used.

**`run_command "/place template"` cannot report a missing template.** `ok: true` for a command that
failed. Use `place_structure`.

**A pushed template needs a `reload_data`** before the game can see it.

**A batch preview needs the overlay to be right.** If you write your own preview logic over these,
remember that ops read each other — and assert the preview against the live run rather than a
constant.

## Where to go next

**In this wiki**

- [The change loop](the-change-loop.md) — promoting a captured structure into your mod.
- [Blocks and items](blocks-and-items.md) — `query_registry`'s `default_state`, which feeds these
  writes.
- [Rendering and screenshots](rendering-and-screenshots.md) — looking at what you built.
- [Authoring at scale](authoring-at-scale.md) — when it is ninety rooms rather than one.
- [Worldgen](worldgen.md) — the terrain these sit on.

**Reference**

- `LIVE_MODDING.md` § *Structures* — capture, place, undo.
- `docs/world/STRUCTURE_AUTHORING_DESIGN.md` §§ 4, 6, 9 — `place_shapes`, the batch transaction,
  the measurement behind it.
- `ARCHITECTURE.md` § *Transactional world edits* — the envelope, the journal, and its bounds.
