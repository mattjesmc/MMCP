# GUI screens

Building a container screen or a menu without fighting widget arithmetic, and driving any screen —
yours, vanilla's, another mod's — from a session.

There are two halves here and it is worth knowing which one you are in. If the toolkit authors your
screen, **layout is a document** (`.ui.json`) that compiles to plain vanilla-API Java, and there is an
in-game editor for it. If the screen is hand-written, vanilla's, or somebody else's, you cannot edit
it live — but you can inspect it, assert its layout and drive it precisely.

## On this page

- [How it works](#how-it-works)
  - [Layout is data, behaviour is code](#layout-is-data-behaviour-is-code)
  - [The editing loop, in game](#the-editing-loop-in-game)
- [Walkthrough: a screen from document to Java](#walkthrough-a-screen-from-document-to-java)
- [Inspecting and driving any screen](#inspecting-and-driving-any-screen)
  - [Read the reply, not the boolean](#read-the-reply-not-the-boolean)
- [Reusing parts](#reusing-parts)
- [What this cannot reach](#what-this-cannot-reach)
- [An agent session](#an-agent-session)
- [Things to keep in mind](#things-to-keep-in-mind)
- [Where to go next](#where-to-go-next)

---

## How it works

### Layout is data, behaviour is code

The original refusal here was sound: code is the single source of truth, so a live tweak to a screen
would evaporate on the next `init()`.

The answer was to move the destination. A screen's layout lives in a **document** —
`assets/<mod>/ui/<screen>.ui.json` — that `init()` re-reads. Three things then consume it:

- **the interpreter** previews it live, in the running game;
- **the emitter** compiles it to plain vanilla-API Java that your mod ships — no runtime dependency
  on the toolkit;
- **`ui_doc` and the in-game editor** edit it, both writing to your source tree.

Behaviour stays code. This is a layout compiler, not a framework.

`ui_doc` is one tool with an `op`: `read`, `lint`, `add`, `set`, `move`, `remove`, `generate`,
`preview`, `attach`, `detach`. **`lint` answers with no client and no world at all**, which makes it
a tier-0 check — see [Mod testing](mod-testing.md). `check_layout` on an open preview is its live
half, and the one that can measure real text.

Gradle-side: `gradlew generateUi` and `gradlew checkUi`.

### The editing loop, in game

- **Ctrl+G** — edit the layout.
- **Ctrl+U** — attach/detach the interpreter over the real screen.
- **Ctrl+S** — save and regenerate.

**Ctrl+U is the interesting one.** With your mod's screen open, `ui_doc op: "attach"` (or Ctrl+U)
puts the interpreter in front of it over the **same live menu** — real slots, real stacks, the
binding values the server actually synced. Detach puts the real screen back. You are editing against
live data rather than a mock.

**Ctrl+S regenerates in process.** An editor save writes the document to your source tree, mirrors it
into the loaded pack, and runs the emitter — inside the game. That last part is not a flourish:
`gradlew` cannot run while the game holds the jar, which is the whole reason the emitter is callable
from in there. The checked-in Java therefore never falls behind the document it came from.

The running game keeps executing the **old** classes until a rebuild, and the status line says so.

## Walkthrough: a screen from document to Java

**1. Start the document.** `ui_doc op: "add"` builds it up, or write the `.ui.json` by hand.

**2. Lint it, with no game running:**

```
ui_doc {op: "lint"}
```

**3. Preview it live:**

```
ui_doc {op: "preview"}
check_layout {}
```

`check_layout` is a deterministic lint over the open preview: offscreen widgets, overlaps, label
overflow. `measure_text` gives you the one number you cannot compute yourself.

**4. Attach it over the real screen** to see it against real slots and synced values: open your
mod's screen in game, then Ctrl+U.

**5. Drag things around** with Ctrl+G until it is right.

**6. Ctrl+S.** The document goes to your source tree and the Java is regenerated.

**7. Rebuild** when you want the game to actually run the new classes.

**A limit that is vanilla's, not the toolkit's:** `Slot.x` is final. A slot you drag moves **in the
document** and not on that screen until you rebuild. The reply's `menu.slot_drift` names every slot
that has already diverged, so you are told rather than confused.

## Inspecting and driving any screen

This half works on every screen — vanilla's, another mod's, your hand-written ones.

**Inspect**

| Tool | What it gives |
|---|---|
| `get_screen` | The widget tree, container slots, and the `status()` record |
| `screenshot_annotated` | Pixels correlated to widget indices; `grid: true` adds a coordinate ruler |
| `measure_text` | The one number an agent cannot compute |
| `check_layout` | Deterministic lint: offscreen, overlap, label overflow |

**Drive**

`click` is a **pointer** verb with four modes, all targeted the same way — by label, by index, or by
raw x/y:

- **press**
- **drag** — `to_label` / `to_index` / `to_x`+`to_y`, plus `steps`
- **scroll** — `scroll` in wheel notches, using vanilla's sign, where positive goes toward the **top**
  of the list
- **hover** — `hover: true` moves the pointer vanilla holds and presses nothing, so the next frames
  render with it there

Hover is how a tooltip gets photographed at all: a programmatic click carries its own coordinates and
never moves the pointer. The hover persists until the next real mouse movement, and `over` names what
it actually ended up on.

Plus `send_keys` (a named key with `modifiers` and `times`, and/or `text` typed as characters),
`set_text`, `open_screen`, `close_screen`, `get_screen_graph`.

Sliders take either route: drag it (`click {label: "FOV", to_x: …}` — its own message carries the
value, so `label_before`/`label_after` is the read-back), or focus it and `send_keys {key: "right"}`.
Tab order is `send_keys {key: "tab"}`, and shift-tab backwards.

### Read the reply, not the boolean

**In both new modes the boolean lies, in opposite directions.** This is worth internalising, because
it produces tests that pass while doing nothing.

**Scrolling.** A scroll area consumes the wheel **at either end** —
`AbstractScrollArea.mouseScrolled` returns true whenever the widget is visible and clamps inside
`setScrollAmount`. So `handled` is exactly as true at the bottom of a list as in the middle. Page on
`scrolled_from` / `scrolled_to` / `at_end`, never on `handled`.

**Focus.** `Screen.keyPressed` returns **false** for Tab and the four arrows *even when focus
actually moved* — it builds a `FocusNavigationEvent`, changes focus, then falls out of the switch. So
read `focus_before` / `focus_after`, which `send_keys` always reports.

## Reusing parts

Frames, wells, slot grids, and the `part` and `repeat` macros keep a document from becoming a wall of
coordinates. `ui_doc read` lists the expansions, so you can see what a macro actually produced.

The parts library ships with the toolkit;
`src/main/resources/assets/mcptoolkit/ui/parts/README.md` is its catalogue.

## What this cannot reach

**A list row.** `AbstractSelectionList` entries are `GuiEventListener`s and not `AbstractWidget`s, so
`get_screen` counts them in `unenumerated_listeners` and cannot name them. On the vanilla world list
that is all eight worlds.

Rows are clickable only by raw x/y, and scrolling one into view does not make it nameable. Use
`get_screen {detail: "layout"}` for the list's geometry, then `click {x, y}` on the row.

This is a stated absence rather than a discovered one: naming rows means deciding whether they share
one index space or get a `rows` block per list, and answering that wrong changes every `index` a
session has already learned.

**A container screen cannot be constructed by tool** — it needs a server-side menu. For those, the
loop is: edit the layout code, `compileJava`, `hotswap_class`, then **re-interact with the block** to
open the screen again. Title-screen-reachable screens can just be `open_screen`ed.

## An agent session

> **You:** the fuel gauge on my furnace screen overlaps the output slot at high fuel.

> **Agent** opens the screen in game and calls `get_screen` → the widget tree, with the slots.
>
> Then `ui_doc {op: "attach"}` to put the interpreter over the live menu, so it is looking at real
> slots and the binding values the server actually synced rather than a mock.

> **Agent** calls `check_layout {}`
> → an overlap between `fuel_gauge` and `slot_output`, with both rectangles.
>
> That is deterministic — no picture needed to establish it.

> **Agent** calls `ui_doc {op: "set", ...}` to move the gauge four pixels left, then `check_layout`
> again → clean. Then `screenshot_annotated {}` once, so you can see it reads correctly as well as
> lints correctly.

> **You:** save it.

> **Agent:** Ctrl+S regenerates the Java in process. Two things to know: the running game keeps
> executing the old classes until a rebuild, and the gauge is a widget so it moved properly — if it
> had been a *slot*, `Slot.x` is final and it would have moved in the document only, with
> `slot_drift` naming it.

The shape: **`check_layout` for the finding, a screenshot for legibility**, the same split as
everywhere else in the toolkit. And the agent named the slot-versus-widget distinction because it
changes whether what you see is what you saved.

## Things to keep in mind

**Layout is a document; behaviour is code.** This is a compiler, not a framework, and the Java it
emits is plain vanilla API with no runtime dependency on the toolkit.

**`Slot.x` is final.** A dragged slot moves in the document and not on the open screen until a
rebuild. `menu.slot_drift` names the ones that have diverged.

**The running game keeps the old classes until you rebuild.** Ctrl+S regenerates the source; it does
not hotswap the screen.

**Never page a list on `handled`.** A scroll area returns true at either end. Read `scrolled_to` /
`at_end`.

**Never test focus on the return value.** Tab and the arrows return false even when focus moved. Read
`focus_before` / `focus_after`.

**Hover is the only way to photograph a tooltip.** A programmatic click never moves the pointer.

**List rows cannot be named.** Raw x/y only, and `unenumerated_listeners` tells you how many the tree
could not name.

**A container screen cannot be opened by tool.** Re-interact with the block after a hotswap.

**`ui_doc lint` needs no game.** Which makes it free, and a tier-0 check.

**The emitter runs in process because Gradle cannot.** The game holds the jar. That is the whole
reason Ctrl+S works the way it does.

## Where to go next

**In this wiki**

- [Rendering and screenshots](rendering-and-screenshots.md) — `screenshot_annotated` and the
  finding/legibility split.
- [The change loop](the-change-loop.md) — hotswap versus rebuild, which decides your screen loop.
- [Mod testing](mod-testing.md) — `ui_doc lint` as tier 0, `check_layout` as tier 3.
- [Tool profiles and cost](tool-profiles-and-cost.md) — the `screens` profile.

**Reference**

- `LIVE_MODDING.md` § *UI iteration loop* — inspecting and driving, in full.
- `docs/screens/SCREEN_AUTHORING_DESIGN.md` §§ 4, 7, 10 — the compiler, the editor, the emitter.
  Sections 17-23 are the slices as built.
- `docs/screens/UI_PARTS_LIBRARY_DESIGN.md` § 7 — the parts library, `part` and `repeat`.
- `src/main/resources/assets/mcptoolkit/ui/parts/README.md` — the catalogue.
