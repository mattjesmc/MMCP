# Screen authoring — a GUI compiler, an in-game editor, and no runtime dependency

Written 2026-09-03. **Supersedes the premise of `UI_KIT_DESIGN.md`** (archived 2026-09-06; see `docs/archive/README.md`), which designed a runtime
component library and costed it at three sessions. That document's *measurements* (§1) survive and
are quoted here; its *thesis* does not. The change came from one sentence of the user's:

> *"If our tools and editor can build a fully custom visual GUI for any purpose easily... It just
> needs to publish the files to integrate into the game and can even generate java for some
> functional slots. LLM's finetune the code and user does the exact layout finetuning in the dev
> client. In this case we can enable developers to ship fully fledged UI's easily without any lib
> dependency in game."*

**STATUS: SLICES 1-6 BUILT 2026-09-03 (toolkit 0.114.0-0.119.0), plus THE AUTHORING WORLD
(0.120.0) — §17-§22 record each slice as built, what its first live run found, and what it wrote
down for the next; §23 is the authoring world, which is not a slice.** The document, the emitter, the
conformance battery, the in-game editor, `ui_doc` and the attached preview all exist, and the dev
client now boots straight into an empty world with a document open. Slice 7 (migrate a real screen)
is postponed at the user's request.
`ui-kit/`'s `Palette` and `Paint` relocated into the toolkit in slice 1 (§16); its `QuickMove` and
`EntityMenus` were absorbed by slice 2's emitter.

---

## 0. The premise that moved, stated plainly

`UI_KIT_DESIGN.md` §9 decision 1 asked *"is more UI actually coming?"* and answered it against the
villagejobs mayor-dashboard epic. That was the wrong customer. The customer is not a mod's roadmap;
it is **any modder writing any screen**, and — because the output is generated source rather than a
linked library — the payback does not require a second consumer to exist first.

Three consequences follow immediately, and they are what makes this a different project:

| | library design (superseded) | compiler design (this document) |
|---|---|---|
| ships to players | a jar, a required dependency | **nothing** — plain vanilla-API Java in the mod |
| cross-loader cost | a multi-loader jar with an abstraction inside it, at runtime, forever | **zero at runtime** — the generator prints the right dialect |
| the human's 3px nudge | impossible (source is Java, needs a recompile) | the point of the whole thing |
| `LIVE_MODDING.md:631` "code is the single source of truth" | policy, upheld | **reopened and replaced** — see §1 |

## 1. Thesis

**Layout is data. Behavior is code. The document is the single source of truth for layout, and it
compiles to dependency-free Java.**

That sentence answers the standing refusal in `LIVE_MODDING.md:631` — *"code is the single source of
truth for screens — the tools are for feedback and driving, not for live-editing layout (a live tweak
would evaporate on the next `init()` and diverge from source)"* — on its own terms rather than by
exception. **A live tweak evaporates because the destination is the running screen.** Make the
destination the document, have `init()` re-read it, and the objection is gone.

This is the third time this workbench has resolved a refusal that way. The asset round-trip refused
live mob hot-swap and replaced it with **liveness is a property of the destination**; the entity
authoring design shipped on the same principle. The pattern is now load-bearing enough to name.

Four things then edit one document, and none of them are possible without it:

1. **The library** renders it in the dev client (the *interpreter*).
2. **The compiler** turns it into Java the mod ships (the *emitter*).
3. **The visual editor** mutates it with drag handles, in-game, where the human already is.
4. **The MCP tools** mutate it headlessly, and `get_screen` / `check_layout` finally *see* our own
   screens — because widgets are declared instead of computed inside a `render()` call.

## 2. What it is not

- **Not a runtime library.** Nothing is on the player's classpath. A mod using this has no entry in
  its Modrinth dependency list. This is the single biggest differentiator from the prior art (§3).
- **Not a rendering language.** The document expresses the 90% — panels, slots, labels, bars,
  buttons, lists, nine-slice. Anything exotic (a gauge with a rotating needle) is a hand-written
  `render()` override into a **declared `region`** (§4.4). Letting the format grow to cover arbitrary
  drawing is how this becomes a ten-session tar pit; the escape hatch is what stops it.
- **Not a behavior generator.** What a button *does* and what a bar's number *means* stay
  hand-written. The generator emits the plumbing that carries them.
- **Not a replacement for the toolkit's existing UI tools.** It is the thing that makes them work on
  our own screens instead of only on vanilla's.
- **Not cross-loader at runtime.** See §11 — it is cross-loader at *emit* time, which is strictly
  better and costs the player nothing.

## 3. Prior art, and what is actually being paid

**`ui-lib` (daqem, Modrinth)** — the closest existing thing, and the user's reference point. Fabric +
Forge + NeoForge, client-side, MC 1.20.1 through 26.2. It ships: nine-slice buttons, four text
variants (normal/multiline/scrolling/truncated), normal and nine-slice textures, decorated and
undecorated item display, status icons, scrollable areas. Code-driven. **No format, no editor, no
tooling** — and therefore nothing an editor could edit.

The advance is not more components. It is that ui-lib has no document, and a required-dependency
relationship with every mod that uses it.

**The measured tax, from `UI_KIT_DESIGN.md` §1** (five screens, four menus, three mods, swept
2026-09-02):

| | measured |
|---|---|
| UI source across three mods | ~1,960 lines |
| hand-computed layout constants | **78** `private static final int` — 31 in `CatalogScreen` alone |
| the `panel()`/`well()` bevel helper | written **4 times** |
| real `quickMoveStack` implementations | 2, independently, **each wrong differently** |
| client-side entity resolution for a menu factory | solved **twice, differently** |
| uses of `net.minecraft.client.gui.layouts` | **zero** |

**One of those findings has to be re-derived under the new thesis, and it flips.** §1's headline was
that twelve layout classes sit unused in the jar, and that adopting them is most of the win. That was
load-bearing for a *library*, where a human writes layout in code and needs an arithmetic engine.
Under a *compiler* the human drags and the editor writes numbers — **a drag-authored layout does not
need an arithmetic engine, it needs a canvas.** The layouts package keeps its place only for
**reflow**: content whose size is not known at author time. The honest argument for it is
localization — a button hand-placed at `x=40 w=60` breaks in German, and that is exactly why vanilla's
own screens use `GridLayout`/`LinearLayout`. So: **absolute is the base, layout nodes are opt-in for
reflow** (§4.3).

## 4. The document

One file per screen, `src/main/resources/assets/<mod>/ui/<screen>.ui.json`.

**Why in `resources/` rather than a non-shipping directory:** the dev interpreter gets it through the
resource manager, which means `/reload` is the reload loop for free. It ships as a few KB the runtime
never reads — harmless, and it leaves the door open for a modder who *wants* to interpret at runtime.

### 4.1 Screen level

Title and its label position; the inventory label position; `imageWidth`/`imageHeight`; textureless
by default (all five surveyed screens draw textureless, on the stated ground that vanilla ships no
background art at these widths — the kit keeps that default and leaves a seam rather than deciding
the art question).

### 4.2 Element kinds, v1

Deliberately the ui-lib set plus what containers need, plus the escape hatch:

| kind | notes |
|---|---|
| `panel` / `well` / `frame` | nine-slice backgrounds; the helper written four times |
| `label` | `plain` / `wrapped` / `scrolling` / `truncated` — ui-lib's four variants |
| `slot` / `slot_grid` | **the only element that generates into both sides** (§4.5) |
| `button` | text or sprite; bound to an **action** (§8.1) |
| `bar` | horizontal/vertical; bound to a **binding** (§8.2) |
| `item` | static item display, decorated or undecorated |
| `icon` | a GUI-atlas `sprite`, or a `texture` window (`u`/`v`/`src_w`/`src_h`/`sheet_w`/`sheet_h`/`color`) - crop, scale and tint in one vanilla blit |
| `entity` | a live entity in a rect (the parts library, §3.1): `player`, `armor_stand` wearing named slots, or an entity type id; `scale`/`pitch`/`yaw`/`follow_mouse`/`draggable` |
| ~~`list`~~ | **DEFERRED, not registered (slice 1, 2026-09-03).** "Rows over a binding" has no transport: §8's bindings are `ContainerData` ints, and a row is not an int. Registering a kind whose data source is undecided would commit the palette, the battery and both emitters to a placeholder. Until the row transport is designed (a decision for the slice that needs it, with §15.3's "rows get their own vocabulary" already answered), a list is a `region` — which is what every existing list in the three mods already is. |
| `region` | **the escape hatch**: a named empty rect the behavior subclass draws into |
| `row`/`column`/`grid`/`stack`/`spacer` | layout nodes over `LinearLayout`/`GridLayout`/`FrameLayout`/`SpacerElement`; their vocabulary is exactly vanilla's `LayoutSettings` (`padding`, `align`) plus `spacing`, nothing invented |
| `part` / `repeat` | **macros** (the parts library, §4.1 and §5): the document keeps the instance and the parser keeps the expansion beside it, so every renderer walks ordinary elements. Absolute-only at the top level, for the reason a slot is: a group of absolutely placed elements has no single measure a layout could arrange |

**The registry is `ui/doc/Kind.java`** — nineteen kinds. The interpreter dispatches on the sealed
`Element` hierarchy with an exhaustive `switch`, so a kind added to the enum without a rendering is
a compile error, and `UiDocumentTest` pins that the shipped example uses every kind. The parser
also carries a **property table per kind** (`UiParser.propertyKeys`) and refuses unknown keys by
name — a misspelled key that is silently ignored is a property that does nothing, and the editor's
inspector reads the same table.

### 4.2.1 The format as built (v1)

```
{ "format": 1, "title": <text>, "width": 176, "height": 166,
  "title_pos": [8, 6],                 // optional; vanilla's default
  "inventory_label": [8, 72] | false,  // optional; default [8, height-94]; false hides it
  "background": "mod:textures/gui/x.png", // optional; the §4.1 seam. Absent = textureless frame
  "sheet":      {"texture": "mod:textures/gui/x.png"},  // optional; the emitter PAINTS this PNG from
                                                        // the document's own boxes and slots
  "containers": [{"name": "input", "size": 3}],   // `player` (36 slots) is implicit and reserved
  "actions":    ["launch",                         // a plain action: one id (§8.1)
                 {"name": "select", "args": [{"name": "index", "size": 4}]}],  // …and one with an
                                                        // ARITY: a BLOCK of ids, row-major
  "bindings":   [{"name": "progress", "max": 200 | "other_binding", "wide": false, "preview": 130}],
  "elements":   [ ... ] }
```

`<text>` is a string (literal) or `{"translate": "key"}`. Every element has `kind`, optional `id`
(`[a-z][a-z0-9_]*`, unique, a Java identifier in generated code), and either `x`/`y` (top level)
or, inside a layout node, `offset: [dx, dy]`, `padding: n | [l,t,r,b]`, `align: [ax, ay]`, and for a
grid child `row`/`col`/`row_span`/`col_span`. Per kind: boxes take `w`/`h`; `label` takes `text`,
`mode`, `w`/`h` (0 = natural), `color` (`#AARRGGBB`), `shadow`; `slot` takes `container`, `index`,
`placeholder`; `slot_grid` takes `cols`, `rows`, `container`, `first`, `placeholder`; `button`
takes `w`, `h` (default 20), `text`, `action`, `sprite`; `bar` takes `w`, `h`, `binding`,
`orientation`, `fill`, `track`; `item` takes `item`, `count`, `decorated`; `icon` takes `w`, `h`,
`sprite`; `region` takes `w`, `h` and MUST have an id; layout nodes take `spacing` and `children`;
`spacer` takes `w`/`h`; `entity` takes `w`, `h`, `subject`, `equipment`, `scale`, `pitch`, `yaw`,
`follow_mouse`, `draggable`; a `part` takes `part` plus whatever its part file declares as `params`;
a `repeat` takes `count` and `children`. Every BOX and LEAF may also carry `tooltip` (text,
`{"translate": …}` or `{"hook": "name"}`) and `visible` (a binding name, or
`{"binding": …, "<cmp>": n}`); a `button` may carry `enabled` too, and `args` when its action has an
arity. A macro's `x`/`y` is an ORIGIN and defaults to 0: its fragment is written around `(0,0)` and
translated there, which is what makes a fragment reusable. Colours and every default are written canonically by `UiWriter` (defaults
omitted, `[x, y]` on one line), and the shipped `assets/mcptoolkit/ui/example.ui.json` is pinned to
that form by its test — so an editor save is a minimal diff.

### 4.3 Positioning

Absolute by default. Layout nodes opt-in, for reflow only. A node inside a layout may still carry an
explicit `offset` — because the human dragging something 3px is the literal use case this project
exists for, and a format that cannot express the result of a drag has failed at its one job. The
editor prefers editing layout parameters (padding, spacing, alignment) when the node is inside a
layout and falls back to an offset **with a visible marker**, so an offset is always legible as an
override rather than as an accident.

**A slot is never inside a layout node — the parser refuses it.** Slot geometry is §4.5's shared
secret: the menu needs it on the server, where no screen and no font exist, and a layout computes
positions at `init()` on the client only. So a slot in a layout would have one position on one
side. Absolute-only for slots is what keeps "the same numbers on both sides" true by construction.

**Layout nodes are themselves nameable.** After arrangement the interpreter adds an inactive
widget over each node's bounds (top-level and nested), so `get_screen` names a `row` by id and the
editor has something to grab. The first live run named only the top-level node; the nested ones
were invisible, and the probe caught it.

### 4.4 `region` — why the escape hatch is a feature

A `region` declares a named rectangle and nothing else. The generator emits a `protected void
drawRegion_<name>(GuiGraphics, int mouseX, int mouseY, float partialTick)` hook with an empty default
into the machine-owned base, and the behavior subclass overrides it. Custom art gets a *place* instead
of forcing the format to grow. Every time the format is tempted to sprout a new drawing primitive,
the first question is whether a `region` already covers it.

### 4.5 Slot geometry is the shared secret

A container screen's slot positions must agree between two files on two sides: the menu calls
`addSlot(new Slot(container, i, x, y))` — common code a dedicated server loads — and the screen paints
the 18×18 wells behind them — client code. **Today every mod duplicates those numbers by hand across
both files.** The document declares them once; the emitter writes `addSlot` calls into the menu and
well-painting into the screen. A human dragging a slot in the editor moves both.

This is the clearest single argument for the document, and it is worth leading with when explaining
the project to anyone: *the same numbers currently exist twice in every modded GUI and nothing checks
that they match.*

## 5. Four editors, one document

```
                    ui/<screen>.ui.json
                            |
      +---------+-----------+-----------+-------------+
      |         |                       |             |
  interpreter  emitter            in-game editor   MCP tool
  (dev only)   (Fabric first)     (drag handles)   (headless)
      |         |
   dev client  <Screen>Layout.java  ->  shipped mod, no deps
```

The interpreter and the emitter **share one model object**, parsed once from the document. That
sharing is not an implementation convenience; it is the thing that makes §12's conformance check
meaningful rather than a comparison of two independent readings of a file.

## 6. Dev interprets, publish compiles

**The library still exists. It just never ships.**

If the artifact in the dev client were the generated Java, a layout tweak would mean
recompile-and-relaunch — far too slow to be the human seam this is for. So:

- **In dev**, the toolkit renders the document with an interpreter. Drag, release, see it. No build.
- **At publish**, the emitter compiles the document to Java. The mod ships that and nothing else.

The interpreter rides in **mcp-toolkit**, which is already loaded in every dev client in this
workbench (that is what the per-project bridge port bought). So the target mod has no dependency at
dev time either.

### 6.1 Two preview fidelities, one code path

`InterpretedScreen extends AbstractContainerScreen<AbstractContainerMenu>` in the toolkit, taking
`(document, menu)`:

- **Detached** — the menu is synthetic, built from the document's own slot declarations and filled
  with placeholder stacks. Works with no mod running and for a screen that does not exist yet. This
  is where authoring happens.
- **Attached** — the human opens the *real* screen in the dev game and the toolkit swaps the client
  screen for an interpreted one **wrapping the same live menu instance**. Real slots, real stacks,
  real synced data, and still live-draggable.

**What attached mode can and cannot do (slice 6, measured).** It moves every label, button, gauge,
icon and layout node, because the interpreter draws those from the document on each `init()`. It
cannot move a **slot**: `Slot.x`/`Slot.y` are **final** in 26.2
(`vanilla-src/net/minecraft/world/inventory/Slot.java:14-15`) and the slots belong to the menu the
mod's compiled code built. So a slot drag edits the document correctly - the next generate + rebuild
applies it - while the screen keeps the old position. `SlotPlan.compare` measures that divergence,
the screen draws the count under the panel, and `get_screen` names each slot with both positions.
The only wrong thing to do with it was leave it invisible.

**Attached mode is safe, and I checked rather than assumed.** Swapping the client screen calls
`removed()` on the old one, and `AbstractContainerScreen.removed()`
(`vanilla-src/net/minecraft/client/gui/screens/inventory/AbstractContainerScreen.java:525`) forwards
to `menu.removed(player)`, whose entire body is guarded by `if (player instanceof ServerPlayer)`
(`AbstractContainerMenu.java:585`). On the client the player is a `LocalPlayer`, so it is a **no-op**.
The close packet is sent only from `onClose()` → `player.closeContainer()` (`:579`), which a screen
swap does not call. **The menu survives the swap.**

## 7. The shape of generated code

The hard problem this design creates is generated-vs-hand-edited: LLMs finetune the code, the human
finetunes the layout, and a regeneration must not eat either.

**The resolution is the boring one, and it is correct: a machine-owned base class and a hand-written
subclass.** Layout regenerates freely underneath behavior that is never generated.

**Protected regions, marker comments, and "edit below this line" are all rejected.** The moment a hand
edit is allowed *inside* generated output, regeneration becomes lossy, and the human round trip — the
entire point — dies with it.

Emitted per screen:

| file | owner | contents |
|---|---|---|
| `<Screen>Layout.java` | **machine** | widget construction, geometry, painting, `drawRegion_*` hooks |
| `<Screen>MenuBase.java` | **machine** | `addSlot` calls, `quickMoveStack`, data slots, action dispatch |
| `<Screen>Screen.java` | **human** | extends the layout; `render` overrides, tooltips, region drawing |
| `<Screen>Menu.java` | **human** | extends the base; what actions do, what bindings read |
| `<Mod>Ui.java` | **machine**, once per mod | the vendored paint primitives AND the five declared widgets (label, decor, button, icon, item) - slice 2 folded `<Mod>Paint` into this one file, because the widgets are needed for parity too (§12 reads id/kind off them) and two vendored files per mod is one more than needed |

`<Mod>Ui.java` is the deliberate vendoring: the emitter *inlines* the primitives that a library
would have exported, so each mod carries its own ~150 lines and depends on nobody. The cost is stated
plainly in §15.

**`quickMoveStack` is emitted, not hand-written, and that is where the §3 finding cashes out.** It is
written once, to vanilla's `AbstractFurnaceMenu` algorithm, with the slot ranges filled in from the
document — so nobody writes it wrong a third time. (For the record on the two existing copies:
re-verified against `AbstractContainerMenu.java:635`, `moveItemStackTo` sets `anythingChanged` only on
paths where the source stack strictly shrinks, so `doClick`'s `while` loop at `:425` always
terminates. The "client re-sends the click forever" claim in `UI_KIT_DESIGN.md` is **false** and is
withdrawn. What survives: `RocketMenu.java:161` returns `EMPTY` after a *successful* backpack-to-hotbar
move and jumps over its own `setByPlayer`/`setChanged` block — a real bug, one line — and both copies
drop `slot.onTake`, which is inert today because every slot in both menus is a plain `Slot`, and a
trap for the first payout slot.)

### 7.1 Where the emitter runs, and the constraint that falls out of it

**Three callers, one emitter, each for a different moment:**

| caller | when | why it exists |
|---|---|---|
| **in-process, from the editor's save** | game up, human dragging | **mandatory** — see below |
| **`ui_doc op:"generate"`** (§10) | game up, agent editing | ~free: an op on a tool the design already has, not a new manifest entry |
| **a Gradle task** | game down, and every build | the **staleness guarantee** — nothing else stops shipping a layout that no longer matches its document |

**The in-process caller is not a preference, it is forced.** You cannot run `gradlew` while the dev
game holds the jar — that is the standing rule this workbench already paid for, and the reason
`tools/rebuild.ps1` exists. If the editor's save had to shell out to Gradle, the drag-save-see loop
would be dead on arrival. So the emitter must be callable from inside the running game, and that
decides the architecture rather than the interface.

**No separate CLI. The bash path *is* the Gradle task.** A third caller with its own entry point is a
third thing to keep in sync for no gain.

**THE CONSTRAINT: the emitter and the shared model must not import Minecraft.** They read JSON and
write Java text; only the *interpreter* (§6) touches Minecraft classes. If the Gradle task cannot call
the same emitter the game calls, the project grows a second emitter — two truths — which is exactly
the drift §12 exists to catch, reintroduced one level below where the check looks. This constraint is
cheap to honour if it is honoured from the first line of slice 2, and expensive to retrofit.

**Generated files are checked into the mod's repo.** The Gradle task regenerates and fails the build
on drift, but the mod compiles with the plugin absent. That keeps the no-dependency promise honest all
the way out: a modder who later drops this tooling entirely still has readable, working Java. The
Gradle task is a convenience for projects inside this workbench, **not a build-time dependency
smuggled back in**.

## 8. The client/server contract

The document declares **actions** and **bindings**. Both sides fall out of them, and **neither needs
a custom packet** — this is the part that makes the whole thing cheap, and every mechanism below was
verified in 26.2 source rather than recalled.

### 8.1 Actions ride vanilla's button channel

`MultiPlayerGameMode.java:488` sends `ServerboundContainerButtonClickPacket`;
`ServerGamePacketListenerImpl.java:1979` hands it to
`AbstractContainerMenu.clickMenuButton(player, buttonId)` (`AbstractContainerMenu.java:301`).

A declared action becomes an int id (`ACTION_LAUNCH`), a generated `switch` in the base's
`clickMenuButton`, and a `protected abstract boolean onLaunch(Player)` the subclass implements. The
client side is one generated `press(int)` that calls `gameMode.handleInventoryButtonClick`. **Zero packet classes, zero
registration, zero loader-specific networking.**

### 8.2 Bindings ride `ContainerData`

`ContainerData` is `get(int)` / `set(int,int)` / `getCount()`. The base implements it over abstract
getters and registers it with `addDataSlots`, so vanilla's own diffing in `broadcastChanges` does the
sync. The client emits the arithmetic: a bar's filled width is `value * w / max`, guarded against a
zero denominator.

**TRAP, verified — `ContainerData` values are 16-bit on the wire.**
`ClientboundContainerSetDataPacket` reads and writes both the id and the value with
`readShort()`/`writeShort()`
(`vanilla-src/net/minecraft/network/protocol/game/ClientboundContainerSetDataPacket.java:25,31`).
A value outside -32768..32767 **silently wraps**. Energy in FE, fuel in mB, and tick counters on long
processes all exceed that. The document must therefore let a binding declare `wide: true`, and the
emitter must split it across two data slots (high/low 16 bits) and reassemble on the client. This is
the single most common bug in hand-written modded GUIs and the generator can make it structurally
impossible.

### 8.3 What stays hand-written

What `launch` *does*. What supplies `progress`. That is the LLM's half, and it is small and
interesting rather than large and mechanical — which is the correct division of labor and the reason
the token bill moves.

## 9. The in-game editor

**In-game, and the use case is what decides it — not the availability of a seam.**

The moment being optimized is: you are standing in the world with the screen open and something is
3px off. An editor that makes you alt-tab to a browser or to Blockbench to fix 3px has already lost
to just telling the model to move it — which is the token cost this exists to stop paying.

**Blockbench is the wrong host, and this is worth writing down because the seam is seductive.** The
plugin exists, `mcptoolkitPush(opts)` is zero-token, the `art` profile is carved out, and two
round-trips already ship through it. But what made Blockbench right for models and textures is that
**Blockbench is already the tool for that document type.** It is not a 2D layout tool: its canvas is a
3D viewport and its 2D surfaces are UV and paint. A layout is not a `.bbmodel`. We would write an HTML
canvas app anyway and then fight Electron's project model to host it — and the record here is that
Blockbench's codec in `app.asar` has overruled a design three times. Taking the seam here would be
copying the seam instead of the reason.

The user's third option — *"a custom framework with prebuilt support for rendering GUIs like
Minecraft"* — **is not a third host. It is the interpreter.** It only reads as a separate option
while the editor is imagined outside the game.

The editor is: drag and resize handles, snap to 1px and to the 18px slot grid, a palette, a property
inspector, undo/redo, and save. Fidelity is free because it *is* the renderer, and the toolkit's own
`click` (with its drag mode), `screenshot_annotated` and `get_screen` can drive the editor itself.

**The palette enumerates from the element registry**, never from a hand-kept list — the menagerie
review lesson (71 subjects enumerated from the enums so they cannot go stale). A kind that is not in
the palette is not in the library, by construction.

**The editor is also the arbiter screen that did not exist.** `UI_KIT_DESIGN.md` §8 wanted a genuinely
needed new screen built twice to measure the kit, and said a toy would flatter it. The editor is real,
non-trivial, and the kit's first serious consumer.

## 10. MCP surface

**One tool, ops dispatched on an `op` field** — the `studio` precedent. Not one entry per verb: the
workbench's own measurement is that a new manifest entry floors at ~589 tokens and that the *schema*
is the bigger half of the bill, so a verb-per-tool surface would invert the exercise.

`ui_doc` with `read` / `add` / `move` / `set` / `remove` / `generate` / `preview` / `lint`.

Most of the MCP win is **existing tools that start working**: `get_screen` can name a declared widget
and a list row by label, and `check_layout` can lint a document without the game even running.
`UI_KIT_DESIGN.md` §8's cheap arbiter — *`check_layout` must return a non-empty problem list for a
deliberately broken layout, and `get_screen` must name a list row by label* — is the acceptance test,
and it needs no mod's roadmap to be honest.

**BUILT 2026-09-03 — see §21.** The lint half turned out to be a class of its own
(`ui/doc/UiLint`), because the line worth drawing is not "geometry, but for documents": it is
between what the parser *refuses* and what it *accepts and should not have*.

## 11. Cross-loader — Fabric first, NeoForge designed-for

**A container GUI is one of the most vanilla-pure surfaces in modding.** `AbstractContainerMenu`,
`Slot`, `ContainerData`, `MenuType`, `AbstractContainerScreen`, `GuiGraphics`, the `layouts` package,
`player.openMenu(MenuProvider)` and the entire button channel are vanilla on both loaders. That is the
menu, the slots, `quickMoveStack`, the sync, the screen, the painting and the actions — identical
bytes.

The divergence set is small, and it was enumerated against the real jars (NeoForge **26.2.0.64** from
the Gradle cache; fabric-api as `ui-kit` slice 1 already uses it):

| | Fabric | NeoForge 26.2.0.64 |
|---|---|---|
| menu type registration | `Registry.register(BuiltInRegistries.MENU, ...)` | deferred register |
| client screen registration | `MenuScreens.register` from `ClientModInitializer` | `RegisterMenuScreensEvent.register(MenuType, ScreenConstructor)` |
| **extra data at open** | data rides the **provider**: `ExtendedScreenHandlerFactory<D>.getScreenOpeningData(ServerPlayer)`, open stays vanilla `player.openMenu(this)`; type is `ExtendedMenuType(factory, StreamCodec)` | data rides the **call site**: `IPlayerExtension.openMenu(MenuProvider, Consumer<RegistryFriendlyByteBuf>)`; type is `IMenuTypeExtension.create(IContainerFactory)` with a **raw buf, no codec** |
| custom payloads (avoidable) | `PayloadTypeRegistry` + `ClientPlayNetworking` | `PayloadRegistrar` via `RegisterPayloadHandlersEvent` |

**Row three is the only real one, and it is not a find-and-replace: the producer of the data moves** —
an interface method on your provider versus a lambda at the open site. A generator handles that
trivially; a human retrofitting it does not, which is precisely why it is worth generating.

**So the default emits nothing but vanilla.** If a document declares no open payload, output is 100%
loader-neutral except the two registration lines. Extended data is opt-in and the generator should
**price it out loud at generate time**: on Fabric it costs a **fabric-api** dependency
(`net.fabricmc.fabric.api.menu.v1.ExtendedMenuType`) — the exact thing the no-dependency thesis exists
to avoid — while on NeoForge it is in the loader itself. Telling the modder that at generate time is
better than letting them find it on their Modrinth page.

Target is a setting: `fabric` | `neoforge` | `both`. **`both` is not a compromise output** — it is the
neutral core plus two thin adapters, which is exactly the `common/` + `fabric/` + `neoforge/` layout a
multiloader project already has. The generator's output shape matches the project shape the modder is
already in.

**Sequencing: Fabric emitter first, loader boundary in the model from day one.** Retrofitting a loader
split into a generator that assumed one loader is expensive; adding a second emitter to a generator
that already separates neutral core from adapter is cheap. The NeoForge emitter can only be *run*
where this workbench already runs NeoForge — `spike-neoforge/`, since the toolkit's NeoForge dev loop
deliberately lives outside the project (`mcp-toolkit/build.gradle:1988`).

## 12. Conformance — the arbiter, and the spine of the project

**Two renderers, one truth.** The dev client shows the interpreted document; players see the generated
Java. If those ever disagree, the editor is lying about the only thing it exists to show.

This workbench has already paid for that lesson at the `place_shapes` preview: **a preview nobody
compares against the live run drifts silently.** The rule there was *assert DRY == LIVE*. Here it is
**assert INTERPRETED == GENERATED**, and it is not a nicety — it is the check that makes the design
sound.

Two levels, both with instruments that already exist:

1. **Geometry** — `get_screen` on the interpreted screen and on the generated screen must produce
   identical widget trees (kind, id, rect, label, binding). Cheap, deterministic, runs headless.
2. **Pixels** — a screenshot of each, compared. Catches paint differences geometry cannot see.

**The conformance battery enumerates from the element registry**, so a new element kind cannot be
added without a conformance case — the same enumerate-from-the-enums discipline as §9's palette, and
this is where it is genuinely load-bearing.

**And the falsifier, because a check whose failure mode is "delete a case to go green" needs one:** a
deliberately corrupted emitter must make the battery red. If it does not, the battery is measuring
nothing.

## 13. Verified facts and traps

Everything below was read out of the decompiled 26.2 source or the real jars during this design pass,
not recalled.

| fact | where |
|---|---|
| button channel is vanilla end to end | `MultiPlayerGameMode.java:488` -> `ServerGamePacketListenerImpl.java:1979` -> `AbstractContainerMenu.java:301` |
| **`ContainerData` is 16-bit on the wire** — values wrap silently | `ClientboundContainerSetDataPacket.java:25,31` |
| screen swap preserves the menu — `menu.removed` is server-only | `AbstractContainerScreen.java:525` -> `AbstractContainerMenu.java:585` |
| close packet only from `onClose()`, not from a swap | `AbstractContainerScreen.java:579` |
| `moveItemStackTo` returns true only when the source strictly shrinks | `AbstractContainerMenu.java:635-694` |
| `doClick` QUICK_MOVE loops `quickMoveStack` while the slot holds the same item | `AbstractContainerMenu.java:423-427` |
| ~~`MenuScreens.register` is public~~ **FALSE - private, like `MenuType`'s constructor.** "Verified 2026-07-16, villagejobs" verified against a mod with fabric-api, i.e. against the widened jar. Same fix, same pricing (four access-widener lines for a loader-only Fabric mod) | slice 2's third build (2026-09-03) |
| **`MenuType`'s constructor, its nested `MenuSupplier`, `MenuScreens.register` and its `ScreenConstructor` are PRIVATE in vanilla** - `vanilla-src/` shows them public because that tree is decompiled from the fabric-api-WIDENED jar (the constructor's javadoc even says "Access widened by fabric-transitive-access-wideners-v1"). Every mod here has fabric-api so nobody noticed; the toolkit (no fabric-api) hit it on slice 2's first two builds. Opened in `mcptoolkit.accesswidener` + the AT twin; the emitter's report prices the four lines for a loader-only mod | `MenuType.java:56,73`, `MenuScreens.java:62,116`, first builds of slice 2 (2026-09-03) |
| **a spectator's button clicks are dropped on the server** - `handleContainerButtonClick` gates on `!isSpectator()` before `clickMenuButton`, and nothing tells the client. Data slots still sync, so a screen can look fully alive with a dead button channel. The dev player in this workbench's sandbox worlds is often a spectator | `ServerGamePacketListenerImpl.java:1975`, slice 2's first live run |
| **the example document itself carried the 16-bit trap**: `fuel` previewed 42000 without `wide`. The interpreter never crosses the wire, so it showed 42%; the generated screen's gauge came up EMPTY beside it, which is the whole case for the two-renderer comparison. The parser now refuses an un-wide binding whose preview or literal max exceeds a short, or whose max is a wide binding | `UiParser` bindings lint, slice 2's first live run |
| a generated screen cannot implement a toolkit interface, so `get_screen` reads its widgets DUCK-TYPED: `uiId()`/`uiKind()` returning `String`, through `UiDeclared.of` | `ui/interp/UiDeclared.java` (slice 2) |
| **`Slot.x` and `Slot.y` are FINAL** - a menu's slot geometry is fixed when the menu is built, so an attached preview can redraw everything EXCEPT a slot. It is what turned slice 6's slot story from "move it" into "measure and say it" | `Slot.java:14-15` (slice 6) |
| **…and the way through it, found in the wild:** a slot's position is final, so MOVING one means putting ANOTHER slot in its place - same index, same container, `slots.set(index, replacement)` with `moved.index` carried over - **and both sides must run it**, because a menu whose halves disagree is a menu debugged later. The format deliberately does not say this yet (one screen out of five, and `region` cannot help: a slot is not drawn by the screen); if a second screen wants it, the emitter writing `layOutSlots()` into BOTH generated halves is §4.5's argument again | `ArmorPieces AdvancedSmithingMenu:626-641`, UI_PARTS_LIBRARY_DESIGN.md §3.5 |
| **`Slot.getNoItemIcon()` is drawn by VANILLA**, not by either renderer: `AbstractContainerScreen` blits it for an empty active slot before it draws anything. So a document's `icon` on a slot is a property of the MENU (a `Slot` subclass), which is why it generates into the menu base rather than the layout | `AbstractContainerScreen.java:227-231` (parts library) |
| **`AbstractWidget.extractRenderState` gates on `visible` ONLY** - an inactive widget still refreshes its tooltip and still draws. That is what lets decoration carry a tooltip, and what makes `visible` the right knob for "not there" while `active` stays "not clickable" | `AbstractWidget.java:58-69` (parts library) |
| **`GuiGraphicsExtractor.blit(pipeline, texture, x, y, u, v, w, h, srcW, srcH, sheetW, sheetH, color)` scales** - destination and source rectangles are separate arguments - while the sprite-atlas `blitSprite` window overload does NOT (it scissors). Half-scale off a sheet is therefore one call with `texture`, and impossible with `sprite` | `GuiGraphicsExtractor.java:359-386,437-471` (parts library) |
| **`InventoryScreen.extractEntityInInventoryFollowsMouse` is public static** - the inventory's look-at-the-pointer behaviour is reusable verbatim, and reimplementing it is how two screens come to breathe at different rates | `InventoryScreen.java:103-138` (parts library) |
| **`AbstractContainerScreen.keyPressed` calls `super.keyPressed(event)` FIRST**, before vanilla's inventory-key close - which is what lets a chord injected at `Screen.keyPressed` HEAD be seen on a container screen at all. (The chord is ctrl+U, not ctrl+E, for slice 4's reason: `KeyMapping.matches` ignores modifiers) | `AbstractContainerScreen.java:123-129` (slice 6) |
| a client `ChatComponent` is reached as `mc.gui.hud.getChat().addClientSystemMessage(...)`; `LocalPlayer` has no `displayClientMessage` | `Gui.java:72,1246`, `ChatComponent.java:249` (slice 6) |
| NeoForge menu APIs exist at 26.2.0.64 | `IMenuTypeExtension`, `IContainerFactory`, `RegisterMenuScreensEvent`, `IPlayerExtension.openMenu(provider, Consumer<buf>)` |
| the entity-menu open race | `ui-kit/.../EntityMenus.java` — the open packet can arrive **before the entity has synced**, so `level().getEntity(id)` legitimately returns null and the menu must tolerate a null subject |
| **text colour and shadow are per CALL in 26.2, not per widget** — `GuiGraphicsExtractor.text(font, text, x, y, color, dropShadow)`; `ActiveTextCollector.Parameters` carries pose/opacity/scissor only, and a widget's colour rides the `Component`'s `Style`. No vanilla string widget draws a container label (`0xFF404040`, no shadow), which is why `label` is its own widget | `GuiGraphicsExtractor.java:255-276,1265-1283`, `ActiveTextCollector.java:190` (slice 1) |
| `Button` is abstract; `Button.Plain` is the concrete face with a protected constructor. `ImageWidget.Sprite` is **private** (only `ImageWidget.sprite()` hands one out) | `Button.java:14,121-138`, `ImageWidget.java` (slice 1) |
| `Inventory` is built over a `Player` (`Inventory(Player, EntityEquipment)`) and `AbstractContainerScreen`'s constructor reads `inventory.getDisplayName()` — a container screen cannot exist at the title screen, so a detached preview needs a world | `Inventory.java:61`, `AbstractContainerScreen.java:64-66` (slice 1) |
| a click in a menu the server does not know is dropped on BOTH sides: `MultiPlayerGameMode.handleContainerInput` warns "Ignoring click in mismatching container" when the id is not `player.containerMenu`'s, and `handleContainerClick` checks the same id server-side | `MultiPlayerGameMode.java:449-452`, `ServerGamePacketListenerImpl.java:1908` (slice 1) |
| `imageWidth`/`imageHeight` are **final** on `AbstractContainerScreen`, so a document whose size changed needs a reopen, not a rebuild | `AbstractContainerScreen.java:38-39` |
| 26.2's background hook is `extractBackground` (super, then draw); `extractLabels` runs AFTER the widgets and BEFORE the slot items with the pose translated to the panel origin — the one moment a slot well is over every panel and under every item | `AbstractContainerScreen.java:97-113,191`, `ContainerScreen.java:24` |
| `GridLayout.addChild(child, row, col, rows, cols, settings)`; `LinearLayout.newCellSettings()` / `FrameLayout.newChildLayoutSettings()`; `Layout.visitWidgets` walks nested layouts | `GridLayout.java:110`, `Layout.java:13` |
| `check_layout`'s `label_overflow` rule assumed padded buttons: a widget whose message IS its text (natural-width label, vanilla `AbstractStringWidget`) is exactly as wide as its string and was flagged on every one. Text widgets are now exempt; decor widgets carry an EMPTY message and their id through `UiDeclared` | `UiDesignTools.java` (slice 1, first live run) |
| **`AbstractWidget.alpha` reaches a button's sprite and nothing in its tree**: `extractDefaultSprite` blits with `ARGB.white(this.alpha)`, while id, kind, rect, label and `active` are untouched. That is what makes a paint-only corruption constructible, and so what lets the battery prove level 2 is load-bearing | `AbstractButton.java:54`, `AbstractWidget.java:189` (slice 3) |
| **the `scrolling` label is the one animated element**: `LabelWidget` copies vanilla's `defaultScrollingHelper` on `Util.getMillis`, so two frames taken seconds apart differ inside its box and nowhere else in the panel. The pixel comparison masks it from the document, not from a list | `LabelWidget.java` (slice 3) |
| **`open_world` can park on `BackupConfirmScreen`** ("Worlds using Experimental Settings are not supported") for a save that carries the toolkit's dimensions, and reports "the load has STARTED" either way; and **`get_world_info` answers before `mc.player` exists**, so a preview asked for in that window is refused with "needs the client in a world" | slice 3's relaunches (2026-09-03) |

**The entity-menu race deserves emphasis** because it is the exact failure a generator prevents: two
mods in this workbench derived entity resolution independently and got two different answers, and only
one of them survives the race. That invariant is loader-independent, and the emitter should write it
out **as code with the comment attached**, rather than hoping the next modder re-derives it.

## 14. Slices

| # | content | notes |
|---|---|---|
| 1 | **Document + model + interpreter**, detached preview, element kinds v1 | **DONE 2026-09-03, 0.114.0** (§17). Model Minecraft-free and pinned so by test; `list` deferred, not registered |
| 2 | **Fabric emitter** + base/subclass split + `<Mod>Ui` vendoring | **DONE 2026-09-03, 0.115.0** (§18). Minecraft-free and pinned so; `UiGenerate` is the Gradle caller (toolkit `generateUi`, plugin `generateUi`/`checkUi`); the toolkit ships its own generated screen and the first interpreted-vs-generated geometry comparison runs live |
| 3 | **Conformance battery** (§12), enumerated from the registry, with its falsifier | **DONE 2026-09-03, 0.116.0** (§19). Pixels off the framebuffer, the registry read off the running game and looped, a standing falsifier in two shapes (`open_screen falsify`), and the emitter-level falsifier run by hand: a one-pixel emitter corruption turned 4 of 7 cases red |
| 4 | **In-game editor** — handles, snap, palette, inspector, undo, save | **DONE 2026-09-03, 0.117.0** (§20). A mode of the interpreter, not a screen; every mutation is a JSON edit plus a full re-parse (`ui/doc/UiEdit`, which slice 5 inherits); the palette is `Kind.values()` and an insert declares what it references; save has TWO destinations; the furniture is undeclared so slice 3's battery cannot see it |
| 5 | **MCP `ui_doc`** + `get_screen`/`check_layout` over documents | **DONE 2026-09-03, 0.118.0** (§21). One tool, ops on `op`, measured at ~904 tok/turn against ~4.7k for a verb-per-tool surface; a shell over `UiEdit` and `UiSaveTarget` plus three new things — a lint that reports the legal-but-wrong and DECLARES its blind spot, an emitter whose arguments are derived from the document's own path, and a refusal while the in-game editor holds unsaved edits |
| 6 | **Attached preview** + regenerate-on-save | **DONE 2026-09-03, 0.119.0** (§22). The interpreter over a real screen's LIVE menu, `ui_doc op:"attach"`/`"detach"` and ctrl+U; open decision 8 answered by shape; `Slot.x` is FINAL, so a slot cannot move attached and the drift is measured instead; the editor's Ctrl+S now runs the emitter in process |
| 7 | **Migrate one real screen end to end** — `RocketMenu`/`RocketScreen` | slots, a fuel bar, an entity subject, a known bug: the honest subject |
| — | **The authoring world** — a save that is nothing, and two doors into it | **DONE 2026-09-03, 0.120.0** (§23). Not a slice: the user asked for it instead of 7. A vanilla superflat save (`mcptk-ui`) the toolkit creates itself, `ui_doc op:"open"` and `launch_game {ui:...}`; no new manifest entry |
| — | NeoForge emitter | after 7, in `spike-neoforge/` |

**Honest scope: this is six to ten sessions, not the three the superseded document costed.** The
document format, the emitter, the editor and the conformance battery are each comparable in size to
the entire library that was originally scoped.

### 14.1 After slice 6: the parts library

`UI_PARTS_LIBRARY_DESIGN.md` is the companion document, written from the hardest hand-built screen in
this workspace (`ArmorPieces`' advanced smithing table). Its steps A-F are built (toolkit 0.121.0);
its §7 is the as-built record. What that added to THIS document's format:

* four new properties on existing kinds - `tooltip`, `visible`/`enabled`, a slot's `icon`, and the
  `icon`/`button` sheet-and-face properties;
* two new kinds - `entity`, and the two macros `part` / `repeat`;
* an ARITY on a declared action, so one declaration generates both halves of the id packing;
* a screen-level `sheet`, which the emitter paints from the document's own boxes.

Slice 7 (migrate a real screen) is still open, and it now has a much larger vocabulary to migrate
into - which was the point of doing the parts library first.

## 15. Open decisions

1. ~~**Does the editor ship to players, or is it dev-only?**~~ **ANSWERED 2026-09-03: dev-only.** It
   rides in the toolkit, which is a dev tool, and it may therefore assume the source tree exists and
   write straight into it — which is what §6 assumes throughout.
2. **Vendoring cost, accepted or mitigated?** Generated code is copied into every mod, so a generator
   bug ships N times and cannot be hot-fixed centrally — the fix is regenerate-and-release. For a mod
   author shipping to players that is the right trade, but it means the **generator's own test suite
   is doing work a library's would have done once**. Accepted, and it is why §12 is the spine.
3. **Does a `list` row join the widget index space?** `RELEASE_1.md` §D6 arriving from the other side.
   **Answer: no — rows get their own vocabulary.** The prior lean ("acceptable, these are our own
   screens") only covers kit screens, but the gap that raised the question was found on *vanilla's*
   world-select list (`RELEASE_1.md:727`), where we do not own the indices and `get_screen`'s index
   space is a standing promise to anything driving the title screen. One vocabulary must serve both; a
   separate `rows` list keyed by label serves both, folding rows into the index space serves neither.
4. **Texture or no texture?** Unchanged from the superseded document: textureless default, seam left
   open, art question not decided by the kit.
5. ~~**Where does the emitter run?**~~ **ANSWERED 2026-09-03 — see §7.1.** Three callers, one emitter:
   in-process from the editor's save (mandatory), `ui_doc op:"generate"` (game up), and a Gradle task
   (game down, and the staleness guarantee). No separate CLI — the bash path *is* the Gradle task.
6. **`list` — what carries a row?** Raised by slice 1 and deliberately NOT answered there (§4.2):
   §8's two channels carry ints and button ids, and a row is neither. The options were a third
   channel (a custom payload — the thing §8 is proud of not needing), rows that are ints (indices
   into a client-known table), or "a list is a `region`" forever. **A CANDIDATE ANSWER EXISTS, and it
   is none of the three: the row source is a SLOT.** `ArmorPieces`' advanced smithing table derives
   its 0–5 rows on the client from the `ItemStack` in one slot (its `DECORATIONS` component) plus
   three `DataSlot` ints for what is selected — because *the slot sync already carries arbitrary
   structured data, and has since forever*. `UI_PARTS_LIBRARY_DESIGN.md` §4.3 works it through with
   that screen as the evidence: the count, the pitch, the highlight band, the hit test and the
   click→action packing generate; the row's CONTENTS stay hand-written, because they are the mod's
   own types and no format should know them. Still **not registered**: §4.3's own conclusion is that
   one screen is not enough, and the arity work (§4.2) that a list needs is now built, so the next
   real subject can decide it cheaply.
7. **Does the interpreter mark a `region`?** **ANSWERED in slice 1: no — and slice 4 built the
   overlay that answer promised** (a dashed magenta rectangle in the editor only; a layout node gets
   the same treatment in orange, and an explicit `offset` gets a red marker at the position the
   layout would have used). The generated screen's
   default hook draws nothing, and §12 compares pixels, so the interpreter draws nothing too. The
   rectangle is an *editor overlay* (slice 4), the same way handles are. `get_screen` and
   `screenshot_annotated` already show it as an inactive widget.
8. ~~**How does the interpreter read bindings off a live menu (§6.1 attached)?**~~ **ANSWERED in
   slice 6.** Slice 1 put the seam in: `ui.interp.UiBindings` (`bindingValue(name)`), implemented by
   `DetachedMenu` over preview values. Slice 2 corrected the second half: the emitted
   `<Screen>MenuBase` cannot implement a toolkit interface (it depends on nothing), so it carries the
   same *method* (`public int bindingValue(String)`) without the interface. **Slice 6 built the
   adapter**: `UiBindings.bind(menu)` reads the interface, then the shape, reflectively, at dev time
   only - and reports **which of the two answered**, because "every gauge reads zero" and "nothing
   answered" are indistinguishable on screen. `UiTools`' own copy of that reflection is gone: one
   adapter, two readers.
9. **Reload policy.** Slice 1: `init()` re-reads the source (window resize or reopen), and a
   document that fails to parse keeps the last good tree on screen with the problems printed over
   it. `/reload` refreshes the resource pack, so `/reload` + reopen shows an edited file; a live
   watcher is the editor's (slice 4), not the interpreter's.

## 16. What happens to `ui-kit/` slice 1

**It relocates and changes role. It does not die and it is not wasted.**

`Palette`, `Paint` (`panel`/`well`/`screenFrame`/`bar`/`barVertical`/`slots`), `QuickMove` and
`EntityMenus` were built as a published artifact (`com.mattmc.mcui:mcui:0.1.0`, mavenLocal) for
consumers to link against. Under this design they become:

- the **interpreter's** rendering primitives, inside mcp-toolkit;
- the **emitter's** templates — the exact source that gets inlined into each mod's `<Mod>Paint.java`;
- `QuickMove` -> the emitted `quickMoveStack`;
- `EntityMenus` -> the emitted entity-resolution factory, with its null-tolerance contract preserved
  as a comment (§13).

**Consequences to act on:** the `com.mattmc.mcui:mcui` publication is no longer needed, and neither is
the `com.mattmc.gradle` 0.4.0 group addition that existed only to let consumers resolve it. Whether to
commit slice 1 as-is first (so the relocation has a history) or to move it before committing is a
judgment call for whoever starts slice 1 of *this* document.

**What slice 2 did (2026-09-03):** finished it. `QuickMove` became the emitted `quickMoveStack`
(vanilla's furnace algorithm over `SlotPlan`'s three ranges, `onTake` included, with a
`quickMoveIntoContainers` hook for the filtered insert rocketeer needs); `EntityMenus` and
`EntityMenuHost` moved verbatim to `resources/mcptoolkit/ui/templates/*.java.txt` for slice 7, since
the document has no `subject` field yet; `ui-kit/` is deleted, the `mcui` publication with it, and
the convention plugin's `includeGroup 'com.mattmc.mcui'` is gone (plugin 0.5.0).

**What slice 1 did (2026-09-03):** copied, not moved. `Palette` is now `ui/Palette.java` (no
Minecraft, because the model reads its default label colour from it) and `Paint` is
`ui/interp/Paint.java`, both with the ui-kit provenance in their headers. `ui-kit/` itself was left
untouched and uncommitted: `QuickMove` and `EntityMenus` are slice 2's templates and move when slice
2 reads them, and the directory can be deleted then. The `mcui` publication and the convention
plugin's group addition are still in place and still unneeded — remove them with slice 2.

Also still owed and unrelated to the relocation: **`RocketMenu.java:161`** (§7) is a real one-line bug
in shipped code. Fix it in place; it should not wait for slice 7.

## 17. Slice 1 as built

**Where.** `mcp-toolkit/src/main/java/com/mattmc/mcptoolkit/ui/`:

| | |
|---|---|
| `doc/Kind` | the registry (§4.2): 16 kinds, families, the two placement rules |
| `doc/Element` | the sealed model: `Box`, `Label`, `Slot`, `SlotGrid`, `Button`, `Bar`, `Item`, `Icon`, `Region`, `Layout`, `Spacer`; `Placement.Absolute` / `Placement.Cell` |
| `doc/UiDocument` | the screen: title, size, label positions, background seam, containers, actions, bindings, elements |
| `doc/UiParser` | JSON → model, collecting EVERY problem with a path; also the lint (unknown keys, references, slot overlap, placement mode) |
| `doc/UiWriter` | model → canonical JSON, own printer (`[x, y]` inline) |
| `doc/Text`, `doc/Colors`, `doc/UiParseException`, `Palette` | value types |
| `interp/InterpretedScreen` | §6.1's screen; `init()` re-reads; `extractBackground` frame/texture; `extractLabels` paints wells then labels; local slot clicks when detached |
| `interp/DetachedMenu` | the synthetic menu: containers from the document, `player` a COPY, placeholders, `UiBindings` over previews, one data slot per binding (two if `wide`), a container id no server has |
| `interp/WidgetBuilder` | element → widget, exhaustive; layouts arranged then handed over; offsets applied after; node widgets over every layout's bounds |
| `interp/LabelWidget`, `DecorWidget`, `DeclaredWidgets` | the widgets, all `UiDeclared` |
| `interp/UiSource`, `UiPreview`, `Paint` | resource / file sources; the opener; the primitives |
| `assets/mcptoolkit/ui/example.ui.json` | the living reference: every kind, canonical form, pinned by test |
| `src/test/.../UiDocumentTest` | 17 cases: every kind covered, round trip identical, canonical fixed point, the lints, and **the model's sources contain no `net.minecraft` import** |
| `mcp-server/probes/ui-doc.test.mjs` | 8 live cases: opens the example, every declared element is a nameable widget, slots are the menu's with placeholders, geometry (absolute, arranged, nudged), a press records its action, `check_layout` clean, refusals by name |

**Tool surface — no new manifest entry.** `open_screen` gained `ui` (resource id) and `ui_file`
(path); `get_screen` gained `id`/`kind` on any `UiDeclared` widget and `document` / `detached` /
`document_problem` / `last_action` on an interpreted screen. `check_layout` stopped flagging text
widgets for being as wide as their text. The `ui_doc` tool is slice 5, as scoped.

**First live run, three findings — all caught by the probe, none by the unit tests:**

1. Nested layout nodes (`column`, `stack`, `grid` inside the `row`) were not widgets — only the
   top-level node was. `get_screen` could not name them. Fixed: every arranged layout leaves a node
   widget.
2. Every decor widget carried its id as its *message*, so `check_layout` reported "label overflow"
   on each bar, icon and region (an id is wider than an 8px gauge). Fixed: empty message, id via
   `UiDeclared`. The rule itself was also wrong for vanilla's string widgets and is now scoped.
3. The example's wrapped text was three lines at 140px, not the two I had assumed, and ran into
   the row under it. A measurement the interpreter got right and the author got wrong — which is
   the case for the interpreter.

**Owed from here.** `LIVE_MODDING.md:631` still states the refusal §1 replaces and should point
here (left alone in this pass because that file carries unrelated uncommitted edits). ~~The
`mcui` publication and the convention plugin's 0.4.0 group line go with slice 2.~~ Done in slice 2.

## 18. Slice 2 as built

**Where.** `mcp-toolkit/src/main/java/com/mattmc/mcptoolkit/ui/emit/` - imports no Minecraft, and
`UiDocumentTest.modelAndEmitterImportNoMinecraft` now reads this package too. The proof that the
constraint is real rather than stated: the toolkit's own sample was generated by compiling
`ui/Palette`, `ui/doc/*` and `ui/emit/*` with plain `javac` and Gson on the classpath and running
`UiGenerate` from that - no Gradle, no Loom, no game.

| | |
|---|---|
| `emit/UiEmitter` | the compiler: `emit(UiDocument, EmitRequest) -> Emission`; exhaustive over the sealed `Element`, so an unemitted kind is a compile error (the interpreter's rule, for the other renderer) |
| `emit/EmitRequest`, `Target`, `GeneratedFile`, `Emission` | mod id + package + file stem + loader dialect; the five files with side (common/client) and owner (machine/stub); the notes |
| `emit/UiGenerate` | the Gradle-task caller: every `*.ui.json` in a directory into a source tree; `--check` reports drift and a missing stub without writing |
| `emit/JavaNames`, `JavaWriter` | document names to Java names (keywords get a trailing underscore; every element local is prefixed `w_`/`l_` so it can never shadow a lambda parameter); the indenting writer |
| `resources/mcptoolkit/ui/templates/ModUi.java.txt` | the vendored `<Mod>Ui`: `Declared` (duck-typed `uiId()`/`uiKind()`), `Label`, `Decor`, `PressButton`, `Icon`, `ItemView`, `Paint`, `fraction`, `stack`. **`UiEmitterTest` compares its bodies to the interpreter's `Paint`, `LabelWidget`, `DecorWidget`, `DeclaredWidgets` body for body**, with `Palette` constants substituted from the class itself |
| `doc/SlotPlan` | the one function both sides add slots from: declared containers in document order, then backpack 9..35, then hotbar 0..8 - vanilla's order whatever the document listed, so the emitted `quickMoveStack` has three contiguous ranges and an index means the same on both sides. `DetachedMenu` switched to it |
| `ui/sample/` | the toolkit's own generated screen: `menu/ExampleMenuBase` + `client/ExampleLayout` + `client/McptoolkitUi` (machine, pinned to today's emitter output by test), `menu/ExampleMenu` + `client/ExampleScreen` (the stubs, then hand-edited: the menu answers every binding from the document's `preview` and fills its container from the placeholders, so both renderers start from one state), `UiSamples` / `client/UiSamplesClient` (the two registration lines, through the same pre-freeze window as the body entity types) |
| `ui/GeneratedScreens` | which documents have a generated counterpart in this JVM: `open_screen {ui, generated:true}` opens the real menu through the integrated server; `get_screen` names the document behind a generated screen class and reports the last server-side action |
| toolkit `generateUi`, plugin `generateUi` + `checkUi` (`com.mattmc.mcmod` 0.5.0) | `mcmod.ui.package=` opts a mod in; `checkUi` runs under `check` and fails the build on drift or a missing stub; JavaExec on the mod's toolchain with the toolkit jar + Gson as the whole classpath |
| `src/test/.../UiEmitterTest` | 10 cases: the checked-in sample is today's output, generated code imports only vanilla + fabric-loader + itself, NeoForge refused by name, every declared element lands on its side, the wide split and its masked reassembly, `SlotPlan`'s order, Java-safe names, vendored bodies == interpreter bodies (paint, label, button, decor), and the generator's file discipline (stub kept, machine rewritten, `--check` reports) |
| `mcp-server/probes/ui-emit.test.mjs` | 6 live cases, chunk b, all green on 2026-09-03: the generated screen opens as `ExampleScreen`; **the declared-widget trees are `deepEqual`** across both renderers (id, kind, label, rect relative to the frame, active); the slot lists match with the placeholders; **`get_screen`'s `bindings` are identical on both** (42000 and 100000 through two 16-bit halves each); `click Launch` reaches the server-side menu's `onLaunch`; `check_layout` is clean on the generated screen too (its text-widget exemption now reads the declared kind) |

**The generated shape, as decided while building it (the design said "abstract getters"; these are
the names):** a binding `fuel_max` becomes `protected abstract int supplyFuelMax()` (the server's
half, §8.3), `public final int fuelMax()` (live on the server, synced on the client; wide values
reassembled as `(hi << 16) | (lo & 0xFFFF)` because `readShort` sign-extends), and a name in
`bindingValue(String)`. An action `launch` becomes `ACTION_LAUNCH`, `protected abstract boolean
onLaunch(Player)`, and the client's `press(ACTION_LAUNCH)`. A slot passes through `protected Slot
createSlot(String element, Container, int index, int x, int y)` so a filter (`mayPlace`) is an
override that keeps the geometry. A region `gauge` becomes `protected void drawRegion_gauge(g, x, y,
w, h, mouseX, mouseY, partialTick)` with the rectangle already resolved to window coordinates - the
design's signature lacked the rect, and a hook that makes you recompute where you are is a hook
nobody uses. The layout keeps `declaredWidgets()` / `widget(id)` rather than a field per element,
so an element id can never collide with a field of the human's subclass.

**The one finding of the first builds, three times over:** `MenuType`'s constructor, its
`MenuSupplier`, `MenuScreens.register` and its `ScreenConstructor` are all private (§13). Every mod
in this workbench has fabric-api, whose transitive access wideners open them, and `vanilla-src/` is
decompiled from that widened jar - so the design pass, which "verified against source", verified
against a source that was already lying, and §13's "MenuScreens.register is public" row was wrong
for the same reason. The toolkit opens all four in its own access widener now (AT twins for
NeoForge), and the emitter's report tells a loader-only mod the four lines to add. **The lesson
generalises: `vanilla-src/` answers "what does the API look like with fabric-api", not "what is
private" - for access questions, javac against the toolkit is the arbiter.**

**Two findings of the first live run, both invisible to every unit test:**

1. **The example document had the 16-bit trap.** `fuel` previews 42000 and was not `wide`. The
   preview showed a 42% gauge; the generated screen showed an empty one, because `writeShort`
   wrapped 42000 to -23536 and the emitted clamp did the rest. The screenshot pair caught it before
   any assertion did - test 4 had claimed to "pin the gauge at 42%" and checked nothing. Now:
   `get_screen` reports `bindings` on both renderers (the interpreter's `UiBindings`, the generated
   menu's `bindingValue` by shape), the probe compares them, and the parser refuses the document
   shape that caused it. A lint the interpreter could never have motivated on its own.
2. **A spectator's button clicks vanish.** The action case failed with the client provably sending
   (`press 0 on client menu 1`) and the server provably never dispatching. The gate is vanilla's
   `!isSpectator()`, and the sandbox world's player was one. Data slots sync regardless, so the
   screen looked alive. The probe now puts the player in creative first.

**Owed from here.** Slice 3: pixels, the falsifier, and the enumeration as a check. The consumer-side
proof (a real mod's `gradlew generateUi` + compile, with fabric-api present) is still to be run - the
toolkit's own sample compiles without fabric-api, which is the harder case, but not the same case.

## 19. Slice 3 as built

**Where.** `mcp-server/probes/ui-conform.test.mjs` (chunk b) is the battery; `client/UiFalsifier`
is the standing falsifier; `open_screen` grew `falsify` and, on a preview, a `kinds` reply;
`get_screen` reports `falsified`. Nothing in the emitter or the model changed - the spine is a check
over what slices 1 and 2 built, which is what §12 said it would be.

| | |
|---|---|
| the registry, live | `open_screen {ui}` answers `kinds: {registered: [{name, family}], used: [..]}` - `Kind.values()` off the running JVM beside the document's own kinds. The probe's first case asserts `used == registered`: the unit test's "the example covers every kind" claim, now made by the game that renders it |
| level 1, enumerated | the probe loops `registered` and dispatches on `family`: box / leaf / layout compare the declared widgets of that kind (id, kind, label, rect relative to the frame, active) across both renderers; slot compares the menu's slot geometry; spacer asserts the document places one inside a compared layout node, because a spacer has no widget of its own and its whole effect is where its siblings land. A family with no arm is a failure by name, so a future `Family` cannot arrive without a comparison. Every differing kind is collected and named, not just the first |
| level 2, pixels | `screenshot` on each renderer, decoded probe-side (a 60-line PNG reader over `node:zlib`; the probes depend on nothing, and this one still does), cropped to the `outer` frame's rectangle times the GUI scale (derived from framebuffer width over `screen.width`, asserted integral), compared RGB for RGB. Zero differing pixels is the assertion, with the count, the bounding box and the two frames dumped to the temp dir on failure. The one animated element - a `scrolling` label breathes on `Util.getMillis` - is masked, and the mask is enumerated from the DOCUMENT (every element with `mode: "scrolling"`, located by id on the screen), not hand-kept; the mask must stay under 5% of the panel. And because a comparison of two blanks is also zero, the case asserts the crop is a rendered screen first: at least 32 colours sampled, the container grey among them |
| the standing falsifier | `open_screen {ui, generated:true, falsify:"geometry"\|"paint"}` arms `UiFalsifier`; a `SCREEN_AFTER_INIT` listener consumes it on the first registered generated screen: the first declared button 1px right, or its alpha halved. `get_screen` reports `falsified {mode, widget, effect}` so a red run names its cause; a plain generated open disarms it; `falsify` without `generated`, or an unknown mode, is refused. Two cases: geometry must be caught by BOTH levels (it is: the tree differs in exactly `launch.x`, and 2684 px differ in a 102x40 box - the button plus its shift), and paint must leave the tree IDENTICAL and be caught by level 2 ALONE (it is: 4000 px, exactly the 100x40 button). The second is the case for having a level 2 at all, written down |
| the emitter-level falsifier | run by hand, once, the way §12 asked: `UiEmitter`'s button line emitted `w + 1`, `gradlew generateUi` rewrote the sample (the pin test therefore GREEN - it guards staleness, not correctness), rebuild, relaunch. **4 of 7 red**: level 1 named `panel` first and would now name every kind after the buttons (the row reflowed, so everything to their right moved 2px), level 2 counted 2830 px, and both standing-falsifier cases failed too because their baseline had moved. Revert, regenerate - `git status` on `ui/sample` empty, so the restored emitter reproduces the committed files byte for byte - rebuild, 7/7. Its unit half is `UiEmitterTest.aOnePixelChangeInTheDocumentReachesTheLayoutFileAndNothingElse`: a document one pixel different changes the machine `Layout` file and no other, so the file the pin protects is the file the comparison reads |

**Two things the run found that are not about screens, both in the harness:**

1. **`open_world` can park on vanilla's `BackupConfirmScreen`** ("Worlds using Experimental Settings
   are not supported") when the save carries the toolkit's dimensions, and the tool's reply says
   "the load has STARTED" either way. Two world-open attempts in a row were spent at that screen
   before `get_screen` was asked. A relaunch script that opens a world should click "I Know What I'm
   Doing!" when that class appears - the chained run here does.
2. **`get_world_info` answers before the player exists.** `ui-doc` run first after a world load was
   refused with "a ui preview needs the client to be in a world" while `get_world_info` was already
   `ok`: the level is up before `mc.player` is. A rerun a few seconds later was 8/8. Probes gate on
   `get_world_info`; a probe that needs the player should also poll for one.

Also seen once: `DirectoryLock.create` refused the save ("another process has locked a portion of
the file") for a minute or two after `rebuild.ps1` had reported the previous game stopped - the
old JVM releases `session.lock` on exit, not on `quit_game`'s reply.

**The consumer-side proof, run (2026-09-03, after the commit above).** villagejobs - a real
fabric-api mod, this workspace's root - with the example document copied in as
`assets/villagejobs/ui/probe.ui.json`, plugin 0.5.x, `-Pmcmod.ui.package=com.mattmc.villagejobs
-Pmcptoolkit_version=0.116.0`: `generateUi` wrote five files (`menu/ProbeMenuBase`, `menu/ProbeMenu`
stub, `client/ProbeLayout`, `client/ProbeScreen` stub, `client/VillagejobsUi`), `compileJava` exit 0
with the stubs UNTOUCHED (the classes are in `build/classes`), `checkUi` exit 0. Every trace was
then removed; nothing of it is committed to that mod. **It found two plugin bugs on its first run,
which is the pattern of every item in this workbench:**

1. **The plugin's default toolkit is 0.85.0, which has no emitter.** `generateUi` launched
   `UiGenerate` against it and died with a bare `ClassNotFoundException`. Plugin 0.5.1 reads the
   jar for `ui/emit/UiGenerate.class` at configuration time and answers with a sentence naming the
   version to set; and when screen authoring is opted in but unusable, `generateUi`/`checkUi` now
   EXIST and fail with that sentence, instead of "task not found".
2. **`toolkitStatus` crashed on `ext.uiAvailable`**: inside `doLast`, `ext` is the task's extra
   properties, not the project's - the trap the plugin's own header describes, one screen down.
   `project.ext.uiAvailable`.

**Owed from here.** Nothing from slices 1-3. Slice 4 (the in-game editor) is next in §14; the
battery it will be judged by now exists.

## 20. Slice 4 as built

**Where.** `mcp-toolkit/src/main/java/com/mattmc/mcptoolkit/ui/`:

| | |
|---|---|
| `doc/UiEdit` | **the mutation engine, and the decision the slice turns on: an edit is a JSON edit followed by a FULL RE-PARSE.** `set` / `setScreen` / `dragBy` / `moveTo` / `clearOffset` / `resize` / `add` / `remove`, each `UiDocument -> UiDocument`, each validating nothing itself: it writes the document with `UiWriter`, changes one key, and hands it back to `UiParser`. Minecraft-free (it sits in `doc/`, so the existing import test covers it), which is what lets slice 5's `ui_doc` be a thin shell over it. Paths are **the parser's paths** (`elements[3].children[1]`), so a refusal points at what is selected |
| `edit/UiEditor` | the editor: selection, hit test, handles, snap, palette, inspector, undo/redo, save, the overlay, and `report()` for `get_screen` |
| `edit/UiChrome` | the furniture: one flat `Btn` (vanilla's is 20px tall and a 16-entry palette cannot afford that) plus `outline`/`dashed`/`handle`/`clip`. **Nothing here is `UiDeclared`** |
| `edit/UiSaveTarget` | where a save goes, and the refusal when the only copy is a build output |
| `interp/InterpretedScreen` | `enterEdit`/`leaveEdit`/`adopt`, `rectsByPath()`, the four input overrides, and `reload()` now yields to the editor |
| `interp/WidgetBuilder` | records a **rectangle per element PATH** alongside the by-id widget map |
| `src/test/.../UiEditTest` | 15 cases, no game: paths, the two placement modes of a drag, resize per kind, `set` through the parser (unknown key, broken reference, slot-index clash, wrong placement key), the typed-value rule, **every registered kind inserts cleanly**, what an insert declares, the grid cell, remove-and-reindex, and the two file-level promises (an edit is a one-line diff; an edited document is a fixed point of the writer) |
| `mcp-server/probes/ui-edit.test.mjs` | 11 live cases, chunk b, all green |

**Four decisions worth keeping.**

1. **An edit is a JSON edit plus a re-parse.** The alternative — a per-kind setter — would have been a
   second property table and a second set of rules, i.e. the drift §12 exists to catch, one level
   below where the check looks. What the re-parse buys, in cases that are now green: a slot dragged
   onto another slot's index is refused ("declared twice"), a bar's binding renamed to nothing is
   refused ("undeclared binding"), `x` typed on a layout child is refused as the silent no-op it
   would be, and a misspelled key is refused **with the list of keys that are allowed there**. None
   of those would have occurred to a setter, and all of them are one sentence the human would have
   got from the file anyway. The cost is a parse per commit on a few KB.
2. **The palette is `Kind.values()`, and an entry that cannot insert a valid document is a lie.** So
   an insert *declares what it references*: a button brings an action, a bar a binding **with a max**
   (a bar over a max-less binding cannot fill, and the parser says so), a slot the free container
   indices it needs, and a fresh container when nothing declared has room. An inserted layout gets
   one child, because an empty one arranges to 0x0 and is invisible and unselectable — a dead end for
   the human who just added it. The **placement rules are not re-implemented**: a spacer inserted at
   the top level simply produces the parser's refusal.
3. **A save has two destinations, because there are two ways to lose the work.** Write into
   `build/resources/main` and the next Gradle build overwrites it while the editor says "saved". Write
   only into `src/main/resources` and the *running* game re-reads the stale pack copy on the next
   `init()` — which is §1's own objection ("a live tweak evaporates on the next `init()`") reappearing
   one level below where §1 answered it. So: the source tree is the truth, the loaded pack is
   mirrored, both are named in the reply, and a document whose only copy is a build output is
   **refused rather than written**. Verified by hand end to end: nudge, Ctrl+S, both files carry
   `x: 157`, then *leave edit mode* — which re-reads through the resource manager — and the element
   stays where it was put. That last step is the only proof the mirror is real.
4. **The furniture is undeclared, and that is slice 3's protection.** Every editor widget is a real
   `AbstractWidget` (so `click`, `set_text` and `get_screen` drive the editor, which is how the probe
   exists at all) and none of them is `UiDeclared` — so the battery's declared-widget comparison
   cannot see the editor. A probe case asserts the declared tree is **identical** with the editor on.

**Two falsifiers, both run.**

- **The palette's enumeration.** One kind removed from `UiEdit.properties`' insert defaults: **2 of 15
  unit cases red**, both naming `no insert default for kind PANEL`. Restored, 15/15.
- **The undeclared furniture.** `UiChrome.Btn` given the duck-typed `uiId()`/`uiKind()` pair that
  `UiDeclared.of` reads reflectively — the realistic corruption, since that is the shape a generated
  `<Mod>Ui` widget carries. Rebuild, relaunch: **9 of 11 live cases red**, the guard case naming the
  declared-tree difference and the rest failing because the probe could no longer tell furniture from
  document. Restored, 11/11.

**What the first live run found — and it was not the probe that found it.** All 11 cases were green on
the first run, which in this workbench is a warning rather than a result. A screenshot of the editor
showed four defects the probe is structurally blind to, because a widget tree carries a label but not
whether the label FITS: the toolbar read `sn.. 1px`, `dele..`, `pare..`, `exit e..`; the inspector's
key column clipped `orienta..`; and every value box showed the **tail** of its value (`ogress_bar"`
for `"progress_bar"`), because `EditBox.setValue` leaves the cursor at the end. All four are fixed
(measured widths, a wider key column, `moveCursorToStart`), and the fifth is now said out loud rather
than fixed: at a large GUI scale the chrome has nowhere to go but on top of the panel, so the status
line says so and names the setting. **The lesson generalises: a probe over a widget tree cannot see
layout, so an editor needs one screenshot read by something with eyes.**

**And the defect the screenshot did not show either, which took a `git status` to see.** The first
real save on Windows reported success and left the file **byte-identical in content and different in
every line**: `UiWriter` emits LF, a checkout with `core.autocrlf=true` leaves CRLF in the working
tree, and writing LF over it makes `git status` report a modified file while `git diff` prints
**nothing** - the most confusing shape a diff can have, and the exact opposite of the canonical-form
promise ("an editor save is a minimal diff"). A save now writes **the line endings the file already
uses**, per destination, and the probe compares BYTES rather than text so a regression cannot pass as
equal. Worth generalising: a tool that rewrites a file a human has checked out must preserve the
convention it found, and the check for that is `git status` after the save, not the file's content.

**One unexplained red, recorded rather than dismissed.** The run immediately after the
falsifier-removal relaunch reported 1 failure of 11; its text was not captured, and seven subsequent
runs — including two first-runs after a cold launch and a deliberate reproduction attempt — were
11/11. The most plausible class of cause is §19's own finding (`get_world_info` answers before
`mc.player` exists), so the probe's gate now **polls the preview open** until the player is there
instead of trusting the level. The habit worth keeping: capture the first run's output, because a
red that only happens once still has a reason.

**Also in this slice.** The interpreter **stops re-reading the file while the editor is on** — the
editor owns the document, or a window resize would discard unsaved work; a drag is **one undo entry**
(every frame is computed from the document the press started from, so a drag can neither accumulate
rounding nor flood the stack); the selection is **re-resolved after every edit** by id, because an
insert or a delete renumbers every sibling after it and a held path silently comes to mean a different
element; a click picks the **smallest rectangle** under it and a `parent` button walks up, which is
what makes selecting a container deterministic; Escape with unsaved edits **arms once and says so**
rather than discarding them; `Ctrl+G` toggles the editor and is checked **before everything else**,
because `KeyMapping.matches` ignores modifiers and therefore *any* chord containing the inventory key
closes a container screen. Tool surface: `open_screen` gained `edit`, `get_screen` reports `editor` —
**no new manifest entry**.

**Owed from here.** Nothing from slices 1-4. Slice 6 owes the attached preview and
regenerate-on-save (§7.1's in-process emitter caller, which the editor's save does NOT yet invoke -
`ui_doc op:"generate"` is now that caller, but Ctrl+S still does not reach it).

## 21. Slice 5 as built

**`ui_doc`, the fourth editor** — built, live-green and falsified twice, toolkit 0.118.0 /
mcp-server 0.54.0. One tool, ops on an `op` field: `read` / `lint` / `add` / `set` / `move` /
`remove` / `generate` / `preview`, exactly §10's list.

**The slice's own measurement, and it is the argument for the shape.** The entry costs **~904
tok/turn** (description ~508, schema ~396) on a 96-tool / ~47.4k manifest. Eight entries at the
measured ~589 floor would have been ~4.7k, so the `op` dispatch saves roughly **3.8k tokens on every
turn** — the `studio` precedent, now with a number of its own.

**It implements almost nothing, and that is the whole slice.** Every mutation is `UiEdit`'s (slice
4's engine, unchanged); where the file goes is `UiSaveTarget`'s (slice 4's two destinations,
**moved `ui/edit/` → `ui/` and de-client-ified**, so one rule has one implementation and two
writers); a refusal is `UiParser`'s. The only genuinely new code is the lint, the project
derivation, and the JSON shaping.

**Three decisions.**

1. **No session, so every mutation writes the file at once** — git is the undo. That is what makes
   the four editors of §5 composable: the file is the shared state. **The one conflict that follows
   is handled by name**: while the in-game editor is open it owns the document (it stops re-reading
   the file), so a write underneath it dies on the next Ctrl+S. A mutation is refused while an editor
   holds the **same resolved file** with unsaved edits — resolved, not as-addressed, so an editor
   that opened `mcptoolkit:example` and a call naming that path are the same document — and **only**
   then; a clean editor has nothing to lose and is no obstacle. The live falsifier for this is below.
2. **Lint is what parses fine and is still wrong** (`ui/doc/UiLint`, Minecraft-free). The parser
   refuses the *invalid*; the lint reports the legal-but-broken: an element off the panel, two
   clickables on the same pixels, a container with slots nothing places (**a shift-click can put an
   item where nothing draws it** — the nastiest one, and invisible to every other instrument), a
   declared action no button fires, an empty layout node, a title off the panel. Nothing here
   re-implements a parser rule, and a note is advice with a `code`, never a refusal.
   **Its blind spot is declared rather than hidden**: a layout node's children are arranged at
   `init()` time and a plain label's *width* is the font's, so both are counted into `unchecked`
   with the reason and with where the answer is — `check_layout` on a live preview, which is §10's
   other half. On the shipped example that is 0 notes and **16 unchecked**, and a lint that quietly
   reported "clean" over those 16 would be lying about the reference document.
3. **The emitter's arguments are derived, not typed** (`ui/emit/UiProject`). A document at
   `src/main/resources/assets/<mod>/ui/<screen>.ui.json` already states the mod, the documents
   directory and the project; the fifth argument, the root package, is read from **the same
   `gradle.properties` key the convention plugin reads** (`mcmod.ui.package`). So an in-session
   generate and a build's `generateUi` cannot put the code in different places, because one place
   says — and a hand-typed package that disagreed would have generated a second copy of every class
   into a package nothing registers. This repo therefore declares that key too, and its own
   `generateUi` now reads it instead of hard-coding it. `check:true` is `checkUi`'s staleness
   guarantee with no build, asked of the running game about the repository it was built from.

**Where it registers, and why that is not the client.** `ui_doc` is **common**, on
`ExecutionContext.ANY`: reading, linting, editing and generating are files and the model, and a
dedicated server can do all four. It declares `PRIVILEGED` — disk writes in the developer's own
source tree, and a code generator. Its one client-side op holds a seam `UiTools` fills, so `preview`
on a headless game refuses by name instead of failing obscurely. Profiles: kept in `screens` **and in
the `modding` default**, where it is the only screen tool and `preview` is the only door left to a
preview (`open_screen` is excluded there).

**Falsifiers, both run.**

- *Unit.* Disabling the unreachable-slots check turned **2 of 8** `UiLintTest` cases red, the
  enumeration one naming `UNREACHABLE_SLOTS` by name.
- *Live.* Making `unsavedHold` always answer "nothing is held" turned **exactly 1 of 19** probe
  cases red — the conflict case, and nothing else, which is what says the guard is load-bearing and
  not merely along for the ride.

**The case the first green run did not have.** All 19 passed the first time, which slice 4 recorded
as a warning rather than a result — and it was one: every mutation in the battery addressed the
document by `ui_file`, which has **no pack copy**, so the *two-destination* write — slice 4's own
trap, and the reason `UiSaveTarget` exists — had never once run through this tool. The added case
edits `mcptoolkit:example` by resource id, asserts the `build/` mirror agrees, reopens the preview
and reads the moved widget back off `get_screen`, then restores both files byte for byte. That is
the loop this slice closes, and without it the battery was green over the half that could not fail.

**Checks.** Unit 57/57, was 44 (`UiLintTest` 8, `UiProjectTest` 5 new); probe `ui-tool.test.mjs` 19/19; the
neighbouring UI probes re-run green after the `UiSaveTarget` move (`ui-doc` 8, `ui-edit` 11,
`ui-emit` 6, `ui-conform` 7, `ui-input` 15) and so did `profiles` 22, `tool-surface` 3,
`tool-list-changed` 1.

**Also in this slice.** `LIVE_MODDING.md`'s UI section no longer states the refusal §1 replaces; it
names the document loop and scopes the old advice to screens that are not documents.

## 22. Slice 6 as built

**The attached preview, and regenerate-on-save** - built, live-green (12/12), falsified twice,
toolkit 0.119.0. No mcp-server version bump: nothing under `mcp-server/` changed but a probe.

**Attached** means the interpreter is swapped in front of a real screen and wraps **the same live
menu instance**. Real slots holding the running game's stacks, the bindings the server actually
synced, and a button press that rides vanilla's button channel to that menu's container id - the
branch `InterpretedScreen.onAction` has carried since slice 1 and which **had never once run**.

| | |
|---|---|
| `interp/UiAttach` | the swap, both directions, plus the human's chord. `attach(source)` wraps whatever container screen is open; a null document is **derived** from the open screen when that screen is a document's registered generated one. `detach()` puts the ORIGINAL SCREEN INSTANCE back |
| `interp/UiBindings.bind` | open decision 8: interface, then the duck-typed `int bindingValue(String)`, and it reports WHICH answered (`INTERFACE` / `SHAPE` / `NONE`). Minecraft-free, pinned so by a test that reads its own source |
| `doc/SlotPlan.compare` | the document's slots against a live menu's rectangles: count mismatch, per-slot positions, capped at six named and the rest counted. Minecraft-free, so it is falsifiable with the game down |
| `interp/InterpretedScreen` | `wrap`/`wrapped()`, the binding source, the drift measured at every `init()`, the drift line drawn under the panel, and an action toast that says *"sent to the server on menu N"* attached instead of *"nothing to send it to"* |
| `edit/UiEditor` | **regenerate-on-save**, a `gen` toggle, and a status line reworked around what has no widget |
| `hooks/HookEvent.fireHandled` + `ClientHooks.SCREEN_KEY_PRESSED` + `ScreenMixin` | a CONSUMING hook at `Screen.keyPressed` HEAD - the toolkit's first. A throwing listener counts as "not handled", because a broken listener must not swallow input |
| `ui/UiDocTools` | ops `attach` and `detach`: **no new manifest entry, no new schema key** (both ride `ui`/`ui_file`/`edit`), ~40 tokens of description |
| `client/UiTools` | the client half; `get_screen` reports `attached {class, container_id, slots, bindings_read_by, bindings, document_slots, slots_moved, slot_drift}` on an attached preview, and `menu.container_id` on EVERY container screen |
| `src/test/.../UiAttachModelTest` | 10 cases, no game (suite 57 -> 67): the adapter's three shapes plus a throwing menu and a wrong-typed `bindingValue`, the drift function's four, and the Minecraft-free pin |
| `mcp-server/probes/ui-attach.test.mjs` | 12 live cases, chunk b |

**Four decisions.**

1. **The swap keeps the menu, and detach puts the SAME OBJECT back.** Not a freshly constructed
   screen of the same class - the same instance, over the same menu, which is the cheapest possible
   proof that nothing was disturbed. The probe checks the identity rather than taking it: the
   container id on the wire is equal before the swap, during it, and after, and a press still
   reaches the server afterwards. (`get_screen` now reports `menu.container_id` on every container
   screen, which is what made that checkable at all.)
2. **The report says WHICH shape answered the bindings.** A menu with no `bindingValue` reads zero
   for every binding, and a screen full of empty gauges looks exactly like a screen whose values are
   zero. So `bindings_read_by` is `interface` / `shape` / `none`, and `none` on a document that
   declares bindings comes with the sentence saying nothing answered.
3. **A slot cannot move attached, so the divergence is measured and drawn.** `Slot.x` is final
   (§13). The alternative - refusing a slot drag while attached - would have refused a perfectly
   legal edit for a reason that has nothing to do with the document; the alternative to *that* -
   silence - is a human dragging a slot that never moves. The screen says how many differ, the
   reply names each with both positions, and the fix is the same one the whole design already has:
   generate, rebuild, reopen.
4. **A save regenerates, and a failed generate never undoes the save.** §7.1's first caller is
   mandatory rather than preferred: `gradlew` cannot run while this game holds the jar, so the
   emitter had to be callable in-process, and a drag that did not regenerate would leave the
   repository holding two versions of one screen with `checkUi` failing the next build. The two ways
   it can decline are different things and are said differently: a project that never opted in
   (`mcmod.ui.package` absent) is one quiet sentence, an emitter that threw is red. The `gen` toggle
   turns it off and names what goes stale.

**Falsifiers, both run.**

- *Unit.* Disabling the SHAPE arm of `UiBindings.bind`: **2 of 10** red, both naming it -
  `aGeneratedMenuAnswersByShape` and `aThrowingMenuStillDraws`.
- *Live.* Making `attach` wrap a **synthetic** `DetachedMenu` instead of the live one - the realistic
  corruption, since it is a swap that looks right and keeps nothing: **8 of 12** red. The four that
  stayed green are the four that do not touch a live menu (the two refusals and the two
  regenerate-on-save cases), which is the shape a targeted falsifier should have.

**What the first run found, and it was the probe that was wrong.** Two of eleven cases failed, and
both were about the same confusion: **`last_action` on an interpreted screen is what the CLIENT
fired**, set the instant the button is pressed, while the server's record is another field entirely.
The helper accepted either, so it returned before the packet had left, and the assertion after it
failed against a value from a previous run. Fixed in two places rather than one: the probe waits on
`server_action` only, and **`get_screen` now reports `server_action` on a generated screen too** -
the same fact under the same name on both renderers, because one vocabulary is what let the helper
be written correctly at all. The case also presses **twice**: the server's record is a static that
outlives a probe run, so the first press puts it in a known state and the second is a provable
transition.

**And what a screenshot found, twice, which no probe could.** Slice 4's lesson was that a widget tree
carries a label but not whether it FITS, and this slice walked into it from both sides. First: adding
`gen` to the toolbar pushed the status line's key hints off the right edge (`ctrl+s sa..`), so the
hints moved to the second line - which is idle most of the time - and the first line now carries only
what has no widget: which document, which file, and (attached) which menu. Then `snap`, `undo` and
`redo` moved onto their own buttons as badges, since state that has a widget belongs on it. Second,
one screenshot later: `undo` at 38px wide rendered **`und.. 0`** - the badge takes its width out of
the label's room, which is slice 4's own truncation defect, reintroduced by the fix for the first
one. 44px, and a comment saying why.

**Owed from here.** Nothing from slices 1-6. Slice 7 is the migration of a real screen
(`RocketMenu`/`RocketScreen`), which is where attached mode stops being a demonstration: open the
mod's real screen in its dev game, ctrl+U, drag, Ctrl+S, rebuild.

## 23. The authoring world — a save whose job is to be nothing

**BUILT 2026-09-03 at toolkit 0.120.0 / mcp-server 0.55.0.** Not slice 7 — the user postponed that
one and asked this instead:

> *"Part I noticed is everytime the toolkit launched a client to edit the ui. Would a command to open
> minecraft directly into an empty dimension with the selected screen not help."*

### 23.1 What the old loop cost, measured

A preview needs the client to be IN A WORLD, and that is vanilla's requirement rather than ours
(`ui/interp/UiPreview`: `AbstractContainerScreen` is built over an `Inventory`, and an `Inventory` is
built over a `Player`). Until now the only world on offer was the accumulated dev instance. From
`run/logs/latest.log`, the last cold start before this section was written:

| | |
|---|---|
| JVM start → bridge answering | 12 s |
| → title screen | ~18 s |
| `open_world "New World"` → playable | **+13 s** (`Loading 1044 persistent chunks`, `Time elapsed: 12443 ms`) |
| the save being loaded | **835 MB** |
| the gradle build, when the mod changed | the ~4 min that dominates everything |

**The build is not what this section attacks, and saying so is the honest part.** What it removes is
13 seconds, 835 MB of I/O and two or three tool calls per cycle — and three things that cost more
than the seconds:

- **Nothing behind the panel was deterministic.** A container screen draws the live world behind it,
  so the backdrop of a §12 pixel comparison was the time of day, the weather, and whatever walked
  past. Both sides of that comparison saw the same mess, so it never went red — luck, not design.
- **The recorder was writing.** `wm.record=true` in the dev config means an hour of nudging a button
  3px writes an hour of trajectory rows into the world-model corpus (`[[world-model-project]]`
  already records battery geometry reaching 62% of v2's training steps). Turned off in the dev
  config as part of this work, at the user's direction.
- **It was somebody else's world.** Probe sites are forceloaded in it, a concurrent probe's screen
  closes this one (`ui-conform`'s own header says so), and `tools/battery.ps1:221` *waits* for a
  world it never loads — a human click or an agent call, every cold cycle.

### 23.2 A save, not a dimension — and a vanilla one

The toolkit already ships two empty dimensions (`canvas/Canvas`: `studio` and `workshop`), so the
user's "empty dimension" almost existed. It is the wrong tool here, and the reason is **where the
cost is**: a dimension lives inside a save, so entering it still pays that save's load, still ticks
its overworld, and still shares its file with everyone else. The cost being attacked is at the
LAUNCH, so the answer has to be a different save.

And the save's overworld must be a **vanilla superflat**, not a toolkit dimension type. `Canvas`'
javadoc records why, and it is the loader-only rule biting from a new direction: a mod's `data/` is
not read as a datapack without fabric-api, so the toolkit's dimensions reach a world by being written
into *that world's* datapack — which cannot exist before the world does. A fresh save whose overworld
named `mcptoolkit:workshop` would fail at the moment it was created. Vanilla's `the_void` biome (no
spawns, no features) over one layer of `smooth_stone` needs no datapack at all: `void`, floor at y=0,
so there is nothing to prepare and nothing to load.

`UiWorld` holds all of it — `LEVEL_ID = "mcptk-ui"`, the `LevelSettings` (creative, peaceful, locked,
commands on), `WorldOptions(0, no structures, no bonus chest)`, and the generator. **The game rules
are re-applied on every start rather than written once**, because `LevelSettings` in 26.2 carries
none, so they cannot be part of creation — and doing it every start is `Canvas.install`'s argument
again: the toolkit made this world and nothing else edits it, so re-asserting is bookkeeping, and it
self-heals a world someone left with the sun moving.

### 23.3 Two doors, one path behind them

- **Warm** — `ui_doc op:"open"`. At the title screen it creates the world if missing, loads it, and
  opens the document when the player arrives. **In a world it previews THERE and stays there**, and
  says which world that was: a load started from inside a world is a disconnect nobody asked for,
  which is exactly why `LifecycleTools.openWorld` refuses that case. This door never disconnects
  anybody; it reports where it landed instead.
- **Cold** — `launch_game {target:"client", ui:"<doc>", ui_edit:true}` → `rebuild.ps1 -Ui/-UiEdit`
  → `-PuiDoc`/`-PuiEdit` → `-Dmcptoolkit.ui.open`/`.edit`. One command from a stopped game to a
  screen on screen. The refusal for `ui` with `target:"server"` fires in *both* the shim and the
  script **before** anything is stopped: everything downstream of that line kills a running game, so
  an argument error must cost a second, not somebody's world.

**Why a latch and not `--quickPlaySingleplayer`.** Vanilla's launch argument can only open a save
that already EXISTS, so the first run of the cold door would need creation code anyway — and then
there would be two paths into one world, one of which runs exactly once. `LifecycleTools` already
named quickPlay as the road not taken for the warm case; this is the same answer for the cold one.

**The two things the latch waits for, neither of them obvious** (`UiWorldClient`):

1. **Not "the title screen is up."** During startup the loading overlay sits over an already-set
   `TitleScreen`, so a world load fired on the first tick that sees one races the resource reload.
   The latch also waits for `gui.overlay() == null`.
2. **Not "the player exists."** `mc.player` is non-null while `ReceivingLevelScreen` is still up, and
   that screen is dismissed by the packet listener with `setScreen(null)` — which would close the
   preview we had just opened. So the latch waits for *no screen at all*, then ten more ticks.

### 23.4 What was refused

**Making the preview work at the title screen with no world.** It is the tempting version of the
user's question and it costs the arbiter: `AbstractContainerScreen` dereferences `minecraft.player`
unguarded at `:544` and `:580`, and `Inventory` requires a `Player`, so it needs a fake player or
overrides — and every override is a divergence from the exact vanilla path §12's pixel comparison
exists to measure. ~14 seconds, paid for with the thing that makes the comparison mean anything.

### 23.5 Surface cost

**No new manifest entry.** `open` is an op on `ui_doc` riding the existing `ui`/`ui_file`/`edit`
keys (§10's measurement: an entry floors at ~589 tok/turn and the schema is the bigger half), plus
two properties on `launch_game`, which is a dev-checkout-only local tool.

### 23.6 The honest limit of the probe

`probes/ui-world.test.mjs` **cannot test the entering half.** There is no tool that leaves a world for
the title screen, so the title-screen branch of both doors is exercised by RUNNING one — which is how
the probe gets into the authoring world at all. Its first group runs in any world (it is about the
door, not where it leads); its second is skipped outside the authoring world and strict inside it,
and its first case asserts **the launcher's promise**: the document was already open when the probe
arrived, opened by nothing in the file. The world's own claims are checked the way they can go wrong
— the floor and the void by `get_blocks_at`, every rule by `gamerule`, and the clock by reading it
twice a second apart, which is the one property a still image cannot show.


### 23.7 What the live runs found — three defects and a case that could not fail

**The cold door worked on its first run** (the client booted, created the world, opened the document,
nobody clicked anything) and the probe was 10/10 — which in this project is a warning, not a result.
Falsifying the two load-bearing cases is what produced everything below.

**1. The warm door reported an act it had not performed.** Called on a client that was still starting
up, `createWorldOpenFlows` started a load that the rest of startup then discarded — and the reply had
already said *"the world load has STARTED"*. It now **refuses when not ready** (`ready()`: no loading
overlay, no level, title screen up) rather than queueing. A door that lies about what it did is worse
than one that says "not yet", and the refusal names the screen it saw.

**2. Every toolkit world is EXPERIMENTAL, and that is the `BackupConfirmScreen` trap, finally named.**
The second open of the world parked on the backup dialog. The cause is not this world: **any
dimension whose key is not overworld/nether/end makes the whole level-stem registry experimental**
(`WorldDimensions.checkStability` → `isVanillaLike`), `WorldOpenFlows` asks for a backup on every
later open, and `canvas/Canvas` writes two such dimensions into **every world the toolkit starts**.
That is the long-standing harness trap ("`open_world` parks on BackupConfirmScreen") with a cause
attached. Fixed in two places: `Canvas` skips *and removes* its files in the authoring world (which
has nothing to gain from them), so that world heals on its next load; and the latch clicks
**skip and join** while a load it started is in flight, because a door that promised a world must not
leave a modal sitting on it. The skip was then exercised deliberately by putting a custom dimension
back — a mechanism seen only failing is not verified.

**3. The click fired every tick the dialog lingered.** The dialog outlives its button by a tick or
two, so the latch clicked twice: two loads against one `LevelStorageAccess`, and the client died with
`IllegalStateException: Lock is no longer valid` while starting the integrated server. One confirm
per load.

**And a probe case that could not fail.** "The clock is frozen" compared two readings of
`time query daytime` — which **does not exist in 26.2** (the clock is a timeline; the query is
`time query time`) — and `run_command` answers `ok:true` on a command that never parsed, so the case
was comparing two identical brigadier error strings and passing. Its falsifier (turn `advance_time`
back on; the case must go red) is what exposed it. The helper now throws on a parse marker, and with
the right instrument the case goes red under exactly that falsifier.

**Verified 2026-09-03 on port 25611:** cold door (boot → world created → document open, and again
through the backup dialog into an existing world), warm door (refusal while starting, then title
screen → existing world → dialog auto-skipped → document open in the editor), `ui-world` 10/10, and
`ui-doc` 8, `ui-tool` 19, `ui-edit` 11, `ui-emit` 6, `ui-input` 15, `ui-attach` 12, `ui-conform` 7,
`tool-surface` 3, `profiles` 22 all re-run green **in the new world** — including the pixel battery,
which makes the authoring world a probe host as well as an editing one.
