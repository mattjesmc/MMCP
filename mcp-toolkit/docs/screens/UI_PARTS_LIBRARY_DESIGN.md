# The parts library — what a real hard screen asked for that the format cannot say

**Subject:** `ArmorPieces` 0.3.0's advanced smithing table — `AdvancedSmithingScreen` (734 lines)
over `AdvancedSmithingMenu` (752 lines). The hardest GUI in any of these repos, built entirely by
hand, finished, and shipped. It is the honest subject slice 7 was looking for, and it is better than
`RocketScreen` because nothing about it was written with this format in mind.

**Companion to** `SCREEN_AUTHORING_DESIGN.md`, whose §4.2 registry (sixteen kinds), §8 contract
(actions on the button channel, bindings on `ContainerData`) and §14 slice list this document
extends. Nothing here contradicts that document; §4.4's rule — *every time the format is tempted to
sprout a new drawing primitive, first ask whether a `region` already covers it* — is applied
throughout, and it kills about half the candidates.

---

## 1. The one-sentence finding

Almost nothing this screen does is a *missing primitive*. Four things are, and they are cheap. What
the format actually cannot say is **"N of these"** and **"this cluster again, configured
differently"** — and those two are the same gap wearing two hats, because a library part used four
times *is* repetition with the parameters written out. So the parts library is not a nice-to-have
sitting beside the missing components; it is the shape the missing components want to arrive in.

---

## 2. The subject, inventoried

Every construct in the screen, and whether the format has words for it.

| # | what the screen does | where | verdict |
|---|---|---|---|
| 1 | four armor display slots on a 20px pitch | `AdvancedSmithingMenu:127` | `slot` ×4 — **works, said four times** |
| 2 | each display slot has its own empty-slot sprite (helmet/chestplate/leggings/boots) | `AdvancedSmithingMenu:78-83, 748` | **MISSING** — `Slot.getNoItemIcon()` has no property |
| 3 | the selected slot *moves*, x 8 → 34, on both sides | `AdvancedSmithingMenu:631-641` | **MISSING**, and the workaround is a finding of its own (§3.5) |
| 4 | template + material input pair, gated by `RecipePropertySet` | `AdvancedSmithingMenu:196-204` | `slot` ×2 + hand-written `mayPlace` — **works** |
| 5 | a hidden synced slot carrying the server's recipe verdict | `AdvancedSmithingMenu:207-221` | `slot` at (-1000,-1000) — works, and is a **pattern worth shipping** (§5) |
| 6 | player inventory block | `addStandardInventorySlots` | vanilla helper; format says `slot_grid` ×2 — **works, written in every screen ever** |
| 7 | Apply / Remove buttons | `AdvancedSmithingScreen:219-225` | `button` — **works** |
| 8 | …whose `active` follows `canApply()` / `canRemove()` | `AdvancedSmithingScreen:307-313` | **MISSING** — no state-driven enable |
| 9 | Remove carries a static tooltip | `AdvancedSmithingScreen:224` | **MISSING** — no kind has a tooltip property |
| 10 | four select buttons: sprite-only, half-scale, u/v off a sheet, hover variant, disabled at half alpha | `AdvancedSmithingScreen:705-736` | **MISSING** on four counts (§3.4) |
| 11 | …whose `visible` follows the selection | `AdvancedSmithingScreen:303-309` | **MISSING** — same gap as #8 |
| 12 | …four of them, action = `BUTTON_SELECT + i` | `AdvancedSmithingMenu:120` | **MISSING** — actions have no arity (§4.2) |
| 13 | the box: a recessed bevel | `AdvancedSmithingScreen:426-455` | `well` — **works** |
| 14 | …with a neck notched out of its left edge, moving with the selection | same | `region` — **correctly the escape hatch** |
| 15 | 0–5 rows, count from the server | `AdvancedSmithingMenu:252-258` | **the deferred `list`** (§4.3) |
| 16 | each row 1–4 icon cells that are *not* slots | `AdvancedSmithingScreen:458-503` | `region` today; wants to be a part (§5) |
| 17 | a cell: selection frame, item icon or hint sprite, half-scale badge item or colour chip | `AdvancedSmithingScreen:550-580` | `region` |
| 18 | selected-row highlight band | `AdvancedSmithingScreen:473-476` | `region` |
| 19 | per-cell hit test → `BUTTON_SELECT_FITTING + row*3 + slot` | `AdvancedSmithingScreen:646-657`, `AdvancedSmithingMenu:363-368` | **MISSING** — the packing is written twice (§4.2) |
| 20 | per-cell multi-line dynamic tooltip | `AdvancedSmithingScreen:594-633` | **MISSING** — same gap as #9 |
| 21 | the armor stand: a render state, real renderer, real layers, in a rect | `AdvancedSmithingScreen:358-359` | **MISSING** — no `entity` kind (§3.1) |
| 22 | drag across the stand to rotate it | `AdvancedSmithingScreen:679-698` | `region` + client state — **correctly the escape hatch** |
| 23 | the empty template slot wears a hint of whatever is selected | `AdvancedSmithingScreen:383-391` | **MISSING** — #2, made dynamic |
| 24 | `containerTick` re-reads because data slots arrive without a slot change | `AdvancedSmithingScreen:259-265` | **should be generated**, it is a footgun, not a decision |
| 25 | the background sheet is *generated from the same layout constants* | `tools/gen_smithing_gui.py:5-7` | **§4.5's argument, arriving from outside** (§3.6) |

Twelve rows say MISSING. They collapse into four primitives and two structures.

---

## 3. Tier A — the primitives that are genuinely missing

### 3.1 `entity` — the single biggest omission

`GuiGraphicsExtractor.entity(renderState, scale, translation, quaternion, overrideRot, x0, y0, x1, y1)`
draws a live entity clipped to a rect. Vanilla uses it in the inventory, the smithing table and every
mob-preview screen; ArmorPieces uses it for the whole right-hand column and it is the reason the
screen exists (`§seeing the set` — a crest judged against the spaulders below it). `RocketScreen`,
slice 7's nominated subject, has one too.

This is not a drawing primitive that a `region` "already covers" in the §4.4 sense. It covers it the
way a blank sheet of paper covers a spreadsheet: the hard part — building a render state, driving the
right renderer, clipping, the two rotations, the drag — is identical in every screen that does it, and
that is the definition of something that belongs in the vocabulary rather than in a hook.

Properties: `w`/`h`, a subject (`player` | `armor_stand` | an entity type id | **a slot**, which is
what ArmorPieces needs — the stand wears what four slots hold), `scale`, `pitch`/`yaw`,
`follow_mouse`, `draggable`. Emitter writes the render-state construction; `region` keeps the cases
nobody predicted.

### 3.2 `tooltip` — a property on every leaf, not a kind

Zero support today: `UiParser.KIND_KEYS` has no `tooltip` on any of the sixteen. Vanilla's own
`AbstractWidget.setTooltip(Tooltip)` makes the static case one line. This screen has four tooltip
sources and three of them are dynamic (built from the hovered cell's contents).

So: `tooltip: <text>` on any `LEAF` for the static case; `tooltip: {"hook": "name"}` for the dynamic
case, which generates `protected List<Component> tooltip_<name>(...)` beside `drawRegion_*`. The
escape hatch already has the right shape — this reuses it rather than inventing.

### 3.3 `enabled` / `visible` — predicates over bindings

§8.2 already carries ints and the base already diffs them. A flag is an int. The whole gap is
syntax:

```json
{"kind": "button", "action": "apply", "enabled": "can_apply"}
{"kind": "button", "action": "select", "visible": {"binding": "selected", "ne": 0}}
```

A bare binding name is `!= 0`; the object form takes one comparator. The generated base emits
`this.applyButton.active = bindingValue("can_apply") != 0;` in the same place `containerTick` already
re-reads (#24). No new channel, no new packet, and it removes the most common reason a hand-written
screen sprouts a `containerTick` override at all.

### 3.4 `sprite` grown up — and the button that is only a sprite

The select button is a bare arrow: no vanilla button face behind it, authored at 2× and drawn at
half scale, `u`/`v` into a 32×32 sheet, a `_highlighted` variant when hovered, and half alpha when
inactive. Today `icon` takes `sprite` + `w`/`h` and nothing else, and `button` always wears vanilla's
face.

`icon` gains `u`/`v`/`sheet_w`/`sheet_h`/`scale`/`color`. `button` gains `face: "vanilla" | "none"`
and `sprite_hovered`. That is four screens' worth of hand-rolled `pose().pushMatrix()/scale(0.5f)`
deleted, and it is the same four lines every time.

### 3.5 The slot that moves — write down the workaround, then decide

Slice 6 recorded that `Slot.x` is `public final` and concluded slot drift is *measured*, not fixed.
ArmorPieces found the way through and documented it in its own comment
(`AdvancedSmithingMenu:626-630`): **a slot's position is final, so moving one means putting another
in its place** — same index, same container, `slots.set(index, replacement)` with `moved.index`
carried over — *and both sides run it*, because a menu whose halves disagree is a menu debugged
later.

That is a real technique this workbench did not have written down. Whether the format should express
a moving slot is a separate question and I would leave it shut for now (it is one screen out of five,
and `region` cannot help because a slot is not drawn by the screen). But the technique belongs in
`SCREEN_AUTHORING_DESIGN.md` §13's traps, and if a second screen ever wants it, the emitter writing
`layOutSlots()` into **both** generated halves is exactly the §4.5 argument again.

### 3.6 The sheet is a third copy of the numbers

§4.5 says the layout numbers exist twice — in the menu and in the screen — and nothing checks that
they match. ArmorPieces has them **three** times, and its Python header says so out loud: *"the
layout constants here are the ones `AdvancedSmithingMenu` and `AdvancedSmithingScreen` read, and
moving a slot means moving a number in both places and running this again."*

The document already knows every well's position. `background: {"generate": true}` — emit the PNG
from the same parse that emits the two Java files — deletes `gen_smithing_gui.py` and the third copy
with it. This is the strongest available argument for the whole project and it was found in the
wild, in a mod written without knowledge of it. It is worth building for that reason alone.

---

## 4. Tier B — the structural gap: the format cannot say "N of these"

### 4.1 Static repetition, and the inconsistency already in the registry

`slot_grid` exists. It is exactly "N slots, on a pitch, indices running from `first`" — repetition,
already registered, for one kind only. Nothing else can repeat. So four armor slots on a 20px pitch
(not 18, so `slot_grid` cannot even do *this*) are four objects, and their four select buttons are
four more, and the eight of them share every number but one.

The generalisation is a **`repeat`** wrapper: `count`, and `$i` substituted into any numeric or
string property of its child subtree. It is a layout-family node, expanded at parse time into
ordinary elements, so the interpreter, the emitter and slice 3's battery never learn it exists.
`slot_grid` then becomes what it should have been — sugar over `repeat` + `slot` — though there is no
reason to remove it.

### 4.2 Actions have no arity, and the packing is written twice

Three of this menu's five actions are parameterised:

```java
BUTTON_SELECT + i                                  // 4 ids
BUTTON_SELECT_ROW + row                            // MAX_ROWS ids
BUTTON_SELECT_FITTING + row * MAX_FITTINGS + slot  // MAX_ROWS * MAX_FITTINGS ids
```

`MAX_FITTINGS = 3` exists for exactly one reason: to make that id arithmetic decodable
(`AdvancedSmithingMenu:114`, and the comment says so). The screen packs
(`AdvancedSmithingScreen:330-334`), the menu unpacks (`AdvancedSmithingMenu:363-368`), and **nothing
checks that the two agree** — the identical defect §4.5 leads with for slot geometry, one channel
over. A stride typo here is a click that lands on the wrong fitting, silently, on the server.

So an action gets an optional arity:

```json
"actions": ["apply", "remove", {"name": "select", "args": [4]},
            {"name": "select_fitting", "args": [5, 3]}]
```

The emitter allocates the id block, writes `press_select_fitting(int row, int slot)` on the client
with the bounds check, writes the decode plus the same bounds check into `clickMenuButton`, and hands
the subclass `protected abstract boolean onSelectFitting(Player, int row, int slot)`. The stride
exists once. This is cheap, it is squarely inside §8.1's "zero packet classes" promise, and it closes
a real silent-failure class.

### 4.3 Dynamic repetition — and ArmorPieces answers open decision 6

Open decision 6 asks what carries a `list` row, and notes the options are a third channel, rows-as-
ints, or "a list is a `region` forever". **This screen answers it, and the answer is none of the
three.**

The rows here are derived on the client from **the `ItemStack` in a slot** — the selected piece's
`DECORATIONS` component — plus three `DataSlot` ints for what is selected. The row model needs no new
transport because *the slot sync already carries arbitrary structured data*, and has since forever.
`AdvancedSmithingMenu:252-283` is the whole model: `rowCount()`, `anchorAt(row)`, `entryAt(row)`,
`fittingsAt(row)` — every one of them a pure function of one stack and one int.

That reframes the deferred kind. A `list` whose **source is a container slot** and whose row count is
a function the subclass supplies is buildable today, on channels §8 already has:

```json
{"kind": "list", "id": "sockets", "source": {"slot": "piece"},
 "rows": {"binding": "row_count"}, "row_h": 20, "selected": "selected_row",
 "row": { ...one element subtree, $row substituted... }}
```

The generated base calls `protected abstract int rowCount()` and `protected abstract void
drawRow_sockets(g, int row, int x, int y, boolean selected)` — the row's *contents* stay
hand-written (they are `DecorationEntry` and `Fitting`, which no format should know about), while the
count, the pitch, the highlight band, the hit test and the click→action packing are generated. That
is the correct half to take, and it is roughly 80 of this screen's 734 lines.

I would still not register `list` on this argument alone — but decision 6 should be updated from
"undecided" to "**a candidate answer exists: the row source is a slot, not a new channel**", with
this screen named as the evidence.

---

## 5. Tier C — the parts library

### 5.1 What it is

A `.part.json` is a document fragment with declared **parameters**. A `part` element instantiates it
with values. That is the whole idea, and the reason it is the right shape here is that everything
above wants to arrive through it: a `repeat` of four select buttons is a part with `count`; a station
input pair is a part with an origin; an entity preview is a part with a subject.

```json
// assets/mcptoolkit/ui/parts/station_inputs.part.json
{ "format": 1,
  "params": [ {"name": "x", "type": "int"}, {"name": "y", "type": "int"},
              {"name": "container", "type": "container"},
              {"name": "hint", "type": "sprite", "default": null} ],
  "elements": [
    {"kind": "slot", "id": "template", "x": "$x",      "y": "$y", "container": "$container", "index": 0, "icon": "$hint"},
    {"kind": "slot", "id": "material", "x": "$x + 18", "y": "$y", "container": "$container", "index": 1}
  ] }
```

```json
// in a screen
{"kind": "part", "part": "mcptoolkit:station_inputs", "id": "inputs",
 "x": 187, "y": 151, "container": "input", "hint": "minecraft:container/slot/smithing_template_armor_trim"}
```

### 5.2 The five rules that keep everything already built intact

These are not decoration; each one is what stops the library from breaking an invariant slice 1–6
rests on.

1. **`part` is one new `Kind`, and it expands at parse time.** `UiParser` resolves the part, checks
   the arguments against `params`, substitutes, and splices ordinary elements into the tree. The
   interpreter's exhaustive switch, the emitter, slice 3's registry-enumerated battery and the
   `kindsUsed()` pin all see a document with no `part` in it. **Nothing downstream learns a new
   word.** The palette gains one button that opens a list of parts — which is what finally makes
   *"the palette IS the library"* (`UiEditor:337`) literally true rather than a description of an
   enum.

2. **Ids are namespaced on expansion.** `<instance_id>.<inner_id>` — `inputs.template`. Otherwise a
   part used twice collides on the parser's uniqueness check, and the second use is a refusal for a
   reason the author cannot see. Generated Java names take the same transform.

3. **A part declares what it references; it never assumes.** Containers, actions and bindings a part
   needs are `params` with those types, supplied by the instance. This keeps `UiParser`'s reference
   post-pass (`Ctx.refs`) working exactly as it does now — references still resolve against the
   *screen's* declarations, because by the time the post-pass runs the part is gone.

4. **A part may contain a `region`, and the hook is exported renamed.** `drawRegion_inputs_gauge`.
   This is the load-bearing one for the user's ask: *"anytime something really special is built,
   components are always built as reusable library parts."* The special half does not have to be
   expressible in the format to be shipped in the library — it ships as a part **plus** a documented
   hook, and the hand-written Java that fills the hook can be vendored beside it. A part is
   therefore a *pair*: a layout fragment and the code that completes it.

5. **The editor edits the instance, never the expansion.** `UiEdit` already works by editing JSON
   text and re-parsing in full (slice 4), so a part instance is naturally one draggable object whose
   inspector shows its `params` — the parser's `propertyKeys` table generalised from "per kind" to
   "per kind, or per part". "Filled in and configured" is exactly the inspector over `params`.
   *Expand into the tree* (unpick a part into its elements, for the case where a part is 90% right)
   is a one-way editor operation, not a format feature.

### 5.3 Versioning, and the one thing to refuse now

Vendoring (open decision 2) already means a generator bug ships N times. A parts library makes that
worse in kind: a part bug ships N times *and* the part's own text is copied into no repository, so
there is nothing to grep. Two mitigations, both cheap:

- the expansion writes a provenance comment into generated Java naming the part and a content hash;
- `ui_doc op:"lint"` reports a part instance whose part file has changed since the last generate.

**Refuse for now:** part inheritance, parts that take parts as parameters, and conditionals inside a
part. All three turn a substitution pass into a language, and a format that needs a language has lost
the argument it opened with (§3: *"the same numbers currently exist twice and nothing checks that
they match"* — not *"you need a template engine"*). If a part needs a conditional, it needs a
`region`, and that is the §4.4 rule doing its job.

### 5.4 The seed library, taken from what is already written twice

Each of these exists, hand-written, in at least two of `mcp-toolkit` / `ArmorPieces` / `rocketeer` /
`villagejobs` / `menagerie`:

| part | params | seen in |
|---|---|---|
| `player_inventory` | `y`, `x=8` | **every container screen ever written** — the single highest-value entry |
| `station_inputs` | `x`, `y`, `container`, `hint` | smithing, furnace, anvil shapes |
| `entity_preview` | `x`,`y`,`w`,`h`, subject, `scale`, `draggable` | ArmorPieces stand, RocketScreen, any mob screen |
| `titled_well` | `x`,`y`,`w`,`h`, `title` | everywhere |
| `selector_column` | `count`, `x`,`y`,`pitch`, `container`, `action`, `icons` | ArmorPieces' four armor slots + arrows, in one line |
| `icon_cell` | `x`,`y`, `item`, `badge`, `selected`, `hint` | ArmorPieces rows ×20; a badge-on-icon appears in three mods |
| `progress_arrow` | `x`,`y`, `binding`, direction | furnace-shaped screens |
| `preview_slot` | `container`, `index` | the hidden synced result slot (#5) — a *pattern*, shipped so nobody re-derives (-1000,-1000) |
| `tab_strip` | `count`, `x`,`y`, `action`, `sprites` | creative-tab shaped screens |

`player_inventory` alone justifies the mechanism. `preview_slot` is the interesting one: it is not a
layout at all, it is a *technique* — an off-screen inactive slot used purely as a sync channel for a
server-computed value — and shipping techniques as parts is most of what "reusable library parts" is
worth.

---

## 6. What this costs, and the order I would build it

| step | content | why here |
|---|---|---|
| A | `tooltip`, `enabled`/`visible`, slot `icon`, `icon` u/v + scale, `button face:none` | four property additions, no new kinds, no new channels; each deletes hand-written lines in a screen that exists |
| B | `entity` kind | one new kind, biggest single win, unblocks slice 7's real subject |
| C | action arity (§4.2) | closes a silent-failure class; small, and the emitter is where the stride belongs |
| D | `part` + `params` + parse-time expansion + the seed library | the user's ask; everything above becomes a library entry rather than a one-off |
| E | `repeat` | trivially cheap **after** D, and arguably subsumed by it — a part with a `count` param covers most cases |
| F | `background: generate` (§3.6) | deletes the third copy of the numbers; strongest demo in the project |
| G | `list`, if §4.3's slot-sourced answer survives contact | only with a real screen as the subject, per decision 6 |

Steps A–C are one slice. D is one slice on its own — it touches the parser, the editor's palette and
inspector, and the lint, and it needs the id-namespacing to be right the first time or every part
written before the fix has to move.

**And the honest note about the conformance battery:** slice 3 enumerates its subjects from
`Kind.values()`, so a part that expands into registered kinds is covered *for free* — but only for
the kinds it uses, not for the expansion being correct. A part needs its own falsifier in slice 3's
style: corrupt one substitution and watch the battery go red. Without it, D ships a substitution pass
nothing checks, which is the shape of defect this project has caught three times by insisting on a
falsifier every time.

---

## 7. As built (2026-09-04, toolkit 0.121.0)

**A through F, in one pass. G is still shut**, on the document's own terms: §6 says register `list`
"only with a real screen as the subject", and there is not one yet.

### 7.1 What the format gained

| § | what | how it landed |
|---|---|---|
| 3.1 | `entity` | a registered `Kind`, `Element.Entity`, and one widget in both renderers (`DeclaredEntity` / `${Mod}Ui.EntityView`). Subjects: `player`, `armor_stand` (wearing the stacks in named slots), or an entity type id created client-side once and never added to a level. `follow_mouse` calls **vanilla's own** `InventoryScreen.extractEntityInInventoryFollowsMouse`; `draggable` turns it |
| 3.2 | `tooltip` | a property on every BOX/LEAF: text, `{"translate": …}`, or `{"hook": "name"}` → `protected List<Component> tooltip_<id>()`. Drawn by the SCREEN, not by `AbstractWidget.setTooltip` — one loop over hover zones, so a dynamic tooltip needs no per-widget machinery and both renderers run the same rule |
| 3.3 | `enabled` / `visible` | `"can_apply"` is `!= 0`; `{"binding": …, "ne": 0}` names one comparator. Compiled into a `List<Runnable>` run from `containerTick` **and once at the end of `init()`** — a screen opened on a hidden button would otherwise show it for a frame. `enabled` is buttons only; everything else is drawn or hidden |
| 3.4 | slot `icon`, `icon` sheets, `button face` | `icon` on a slot becomes `Slot.getNoItemIcon()` (vanilla draws it; neither renderer paints it). An `icon` names ONE source: a GUI-atlas `sprite`, or a `texture` with `u`/`v`/`src_w`/`src_h`/`sheet_w`/`sheet_h`/`color` — which is crop, scale and tint in **one vanilla blit**, replacing the `pushMatrix()/scale(0.5f)` block. `face: "none"` + `sprite_hovered` is the bare arrow: no vanilla face, the hover sprite under the pointer, half alpha when inactive |
| 3.5 | the slot that moves | **still shut**, as the document recommends, and now written down in `SCREEN_AUTHORING_DESIGN.md` §13 |
| 3.6 | the generated sheet | a screen-level `"sheet": {"texture": …}`; the emitter writes the PNG from the document's own frame, panels, wells and slot seats. Its own encoder (`java.util.zip`, 60 lines) rather than `javax.imageio`, because a generated file a build compares byte for byte has to be deterministic |
| 4.1 | `repeat` | `count` + `$i`, a macro (below) |
| 4.2 | action arity | `{"name": "select", "args": [{"name": "index", "size": 3}]}`. The emitter writes the id block, `pressSelect(int index)` **with the bounds check** on the client, and the decode plus the same check in `clickMenuButton`. The stride exists once, in the generated code, from one declaration |
| 5 | `part` | a macro (below), with `.part.json` files, typed `params`, and the seed library |

### 7.2 The one decision the design did not make, and the reason

§5.1's example passes `x`/`y` as **parameters**. As built they are the instance's **origin**: a part
file writes its elements around `(0,0)` and the parser translates them by the instance's `x`/`y`.
The instance JSON in §5.1 is unchanged — only the part file is simpler (`"x": 0` rather than
`"x": "$x"`) — and it buys rule 5 outright: a part instance is one draggable object because it has a
position like everything else, rather than because the editor learned to find a parameter called `x`.

The affine form the design's own example needs (`"$x + 18"`) is still there, and it is what `repeat`
uses for a pitch: `$name`, `$name * K`, `$name + K`, `$name * K + M`. Nothing more. §5.3 refuses
conditionals inside a part on the grounds that "a format that needs a language has lost the argument
it opened with"; an offset-and-stride is what every repetition this document inventoried actually
needs, and stopping there is the same argument.

### 7.3 `part` and `repeat` are ONE thing, and it is not what §5.2 rule 1 said

Rule 1 says a part "expands at parse time" and the document downstream "has no `part` in it". Built
that way, **the first drag in the editor would unpick every part in the document permanently**:
every mutation is a write-out-and-re-parse (slice 4's design), so whatever `UiWriter` emits is what
the file becomes.

So a macro is a **node that keeps both halves**: the instance (its part id, its arguments, its
origin — the only thing `UiWriter` writes) and, beside it, the expansion the parser produced (what
every renderer walks). Two views of the tree fall out, and they are the API:

* `UiDocument.flatten()` / `UiEdit.walkAll` — everything, expansions included. What RENDERS.
* `UiEdit.walk` — stops at a macro. What can be EDITED, and rule 5 exactly: every mutation inside
  an expansion is refused by name, pointing at the part file or the instance's arguments.

Neither renderer draws a macro. The editor draws its bounding box (the union of what it expanded to)
in the same dashed overlay a layout node gets, because a thing you can select must be visible.

### 7.4 Rule 2, and the id it forced

Ids are namespaced on expansion — `inputs.template`, `arrows.2.pick` — so the id pattern had to
learn a dot. It learns it **only inside an expansion**: a hand-written `"id": "a.b"` is still
refused, at the same path, with a sentence naming the reason. And because generated Java turns a dot
into an underscore, the parser now refuses two ids that would become **one Java name** (`a.box` and
`a_box`): the alternative is a compile error in the consumer's tree, which is the worst place to
find one.

### 7.5 The falsifier, and what it caught

§6's honest note asked for one by name. `UiPartsTest.corruptingOnePartFileMovesTheExpansionAndNothingElse`
takes the shipped `station_inputs` part, stops one substitution from happening, and asserts that the
expansion moved by exactly that much, that nothing else moved, and that the provenance hash changed
with it.

Two defects were found by the new cases before any of it ran live, both invisible to every other
check in the project:

1. **A part containing itself was a `StackOverflowError`.** The cycle guard existed as a field and
   was never pushed to.
2. **A `repeat` inside a `part` namespaced its children twice** (`p.r.0.p.row`). The outer pass
   descended into the inner macro's `children`, which is the inner macro's scope — a nested macro's
   template is namespaced by the macro that owns it, and by nobody else.

### 7.6 The provenance, and the drift check

§5.3's two mitigations, both built. Every generated machine file's header lists
`<part> #<hash> as <instance>` for every part the screen was compiled from — an eight-hex-digit
SHA-256 of the part file, **line-ending normalised**, so a Windows checkout and a Linux one stamp the
same digits. `ui_doc op:"lint"` reads that header back off the generated layout and reports any
instance the checked-in Java was compiled from a different version of: no build, no game, and it
answers the one question vendoring makes hard to ask.

§5.3's three refusals stand: no part inheritance, no parts as parameters, no conditionals. What is
allowed is **composition** — a part file may contain a `repeat` or another `part` — because
`selector_column` cannot exist without it, and a cycle is a sentence rather than a crash.

### 7.7 The seed library, as shipped

`assets/mcptoolkit/ui/parts/`: `player_inventory`, `station_inputs`, `titled_well`, `preview_slot`,
`progress_arrow`, `entity_preview`, `selector_column`. Seven of §5.4's nine. Left out: `icon_cell`
(a badge-on-icon is `region` work, not layout) and `tab_strip` (it is `selector_column` with
different sprites, and shipping the same part twice is how a library starts lying).

`selector_column` is the one that proves the mechanism: it is a `part` whose fragment contains a
`repeat` whose children carry `$i` — which is why `$i` is a **reserved name** the outer pass walks
past rather than a variable it refuses.

**The palette's default part is `titled_well`, not `player_inventory`.** The inventory is the
highest-value entry by a distance and it is the wrong default: it places all 36 player slots, so on
the very common screen that already has an inventory the palette's first click would be a refusal
about duplicate indices. A palette entry that inserts an invalid element is a palette entry that
lies (slice 4's rule), and a default has to hold for the common case, not the best one.

### 7.8 Where a part comes from

`PartLibrary`, because three hosts have to find one and none can use another's mechanism: the dev
game (the resource manager — every loaded mod's parts, which is what makes a shared library shared),
the Gradle task (its classpath IS the toolkit jar, so the seed library resolves with no wiring at
all, plus the mod's own source tree), and the unit battery (a map). A document opened by PATH adds
its own resources root in front, so previewing a file in a checkout this game never loaded still
finds the part sitting beside it.

### 7.9 The live run (2026-09-04), and the one thing it found

**74/74 green**, seven probe files, sequential, against a client launched with
`rebuild.ps1 -Ui mcptoolkit:example`. The example document uses every kind in the registry, so
`ui-conform`'s level 1 and level 2 compared the interpreter against the generated screen over all
of it — `entity`, `part`, `repeat`, action arity, the tooltips, the predicates and the generated
sheet included.

**The risk named above did not fire.** `entity` renders through vanilla's picture-in-picture path
and the worry was that an armour stand's render state is less deterministic than it reads; a
pixel-identical comparison of the two renderers says it is deterministic enough, at least for a
stand wearing fixed stacks with `follow_mouse` off.

**What did go red is worth more than the greens.** `ui-world`'s "THE LAUNCHER'S PROMISE" asserted
that the boot latch's document was *the open screen when the probe arrived* — and six probe files
had run first, each opening and closing screens. The claim was true and the evidence was gone. This
is the workbench's own recurring shape (*a probe that only ever ran one way is coupled to it*), and
the fix is not to skip the case: **the latch now keeps a record for the life of the client** —
what it was armed with, what became of it, and, read back off `Minecraft.gui.screen()` the moment
its open returned, *what was actually on screen* — reported as `ui_boot` on `get_screen` (top level,
so it survives "no screen open"). The perishable observation became a durable one, and the case
that used to need to run first now runs anywhere. Recording the screen rather than the call
returning is the load-bearing half: without it the record would attest an intent.

### 7.10 What is owed

* ~~The example's `tooltip_ok()` hook is deliberately **not** implemented in the sample's stub: the
  interpreter shows nothing for a hook, so an implemented one would make the two renderers disagree
  under the pointer. That is the honest state of "the hand-written half is yours", and it means the
  dynamic-tooltip path is only half proved until a screen with a region tooltip is compared.~~
  **Compared 2026-09-06 (toolkit 0.132.0).** What had kept it half proved was not the screen but
  the pointer: both renderers draw a tooltip from the render call's mouse coordinates
  (`Paint.tooltips`), and those come from `MouseHandler.xpos`/`ypos`, which only the GLFW cursor
  callback writes - a programmatic `click` carries its own coordinates in the event and leaves the
  pointer where the human left it, so no probe could ever have a tooltip in frame. `click
  {hover:true}` moves that pointer (a mixin accessor on the two fields, plus `mouseMoved`), and
  `ui-conform` now has the two cases: over `launch` (static text, inactive so the pointer changes
  nothing but the tooltip) something appears beside the button on BOTH renderers and the two
  frames are pixel-identical; over `ok` (the hook) whatever changes stays inside the button's own
  rectangle on the interpreter - no tooltip - and the frames are identical again. Each is measured
  against the un-hovered frame first, so two frames that both forgot the pointer cannot pass. The
  stub's `tooltip_ok()` stays empty for the reason above; the case pins that emptiness on both
  sides.
* §3.5's moving slot, and G's `list`, both still shut and both still with a reason.

---

## 8. The port, measured (2026-09-04)

§1 asked what the format could not say about this screen. With A–F built, the honest way to ask
again is not to re-read the table — it is to **write the document and run it through the parser and
the emitter**, which is what this section reports. The subject is ArmorPieces at its current tree
(0.3.0, now with a skin row the original inventory did not have).

The port document is 88 lines of JSON: 9 containers/actions/bindings declarations and 14 elements.
`ui_doc op:"lint"` says `parses: true`; `ui_doc op:"generate" check:true` emits a layout, a menu
base, two stubs **and the background PNG**, with no problems. So the answer to "would a port be
fully coverable" is: **the layout, the wiring and the art are; four things are not, and one of the
four is a refusal this document already made on purpose.**

### 8.1 What the port covers that §2 said was MISSING

Eight of §2's twelve MISSING rows close, and two of them close better than designed:

* **#21 the stand.** `entity` with `subject: "armor_stand"` reproduces `updateStand()` *including*
  the carved-pumpkin split (`HumanoidArmorLayer.shouldRender` → `headItem` rather than
  `headEquipment`), because the interpreter routes by the stack's own `Equippable` slot rather than
  by declaration order. And the preview substitution — "the selected piece is shown as Apply would
  leave it" — falls out of **equipment order**: list the four display slots and then the verdict
  slot, and the verdict overwrites whichever equipment slot it belongs to, exactly as the
  hand-written loop does. That is 45 lines deleted by a list of five ids.
* **#11/#8 the predicates**, and one thing the design did not notice it had built: inside a
  `repeat`, a binding **name** interpolates. `"enabled": "has_piece_$i"` is legal and lints clean,
  so per-index widget state is one line rather than four. (`"visible": {"binding": "selected",
  "ne": "$i"}` works the same way, which was expected.)
* **#12/#19 the id arithmetic.** `select_fitting` declared as `args: [{row, size: 5}, {slot,
  size: 3}]` generates `pressSelectFitting(int, int)` with the bounds check and the matching decode
  in `clickMenuButton`. The hit test stays hand-written inside the region — but **the packing does
  not**, which was the whole of §4.2's argument, and it survives the rows being a `region`.
* **#2 slot icons, #9 the static tooltip, #24 the `containerTick` footgun, #25 the sheet.** The
  sheet is the headline: `tools/gen_smithing_gui.py` and its "these numbers live in three files"
  header are deleted by one `"sheet"` key.

### 8.2 The four that do not port, and what each would cost

1. **The moving slot (#3), and it is worse than "unsupported".** §3.5 left it shut and that still
   reads right — but the port makes the conflict concrete: the generated sheet **bakes the slot
   seats**, so a slot that moves at runtime shows its item at x=34 over a seat painted at x=8.
   ArmorPieces avoids exactly this by drawing the four seats itself from `slot.x`. So the port must
   either drop the move or opt those four slots out of the sheet. A `"seat": false` on a slot is the
   small honest version; expressing the move itself is still the wrong trade for one screen.
2. **A dynamic empty-slot icon (#23).** `icon` on a slot is a static id, because it becomes
   `Slot.getNoItemIcon()` and vanilla draws it. The template slot wearing *the hint of whatever is
   selected* therefore needs a `region` painted behind the slot. Cheap to live with, and the
   alternative (an icon that varies with a binding) would put a client-side lookup table in the
   menu, which is the wrong side.
3. **`tooltip: {"hook": ...}` cannot see the pointer.** `drawRegion_*` is handed `mx, my`;
   `tooltip_<id>()` is handed nothing. Every dynamic tooltip on this screen is *per hovered cell*,
   so the hook has to go find the mouse itself — inside a region whose draw hook was already given
   it. The signature is the gap, not the mechanism: passing `mx, my` to the tooltip hook is a
   one-line change to the emitter and would close #20 properly.
4. **The bare arrow is not pixel-exact (#10).** `face: "none"` gives no vanilla face, the hover
   sprite and half alpha when inactive — three of four. The fourth is that ArmorPieces takes a
   14×22 **window** out of a 32×32 sprite and draws it at half scale; a bare button blits the whole
   sprite stretched to `w`×`h`. `icon` already has `u`/`v`/`src_w`/`src_h`/`sheet_w`/`sheet_h`, so
   this is those six keys moved onto `button` — the smallest of the four, and the only one whose
   absence changes what a player sees.

### 8.3 One structural gap the parts library has, found by writing an instance

**A screen cannot reference into a part's expansion.** `equipment: ["pv.sync"]` — naming the slot
inside a `preview_slot` instance — is refused: `equipment` entries go through the parser's `name()`,
which has no dot, and the dotted form is legal only *inside* an expansion (§7.4). §5.2 rule 3 covers
references pointing **out** of a part (they become `params`); nothing covers a reference pointing
**in**. So the port writes its verdict slot inline and does not use the seed part — which is a
shame, because `preview_slot` is the entry §5.4 called the most interesting one.

The fix is not to relax the id rule. It is that a part should be able to **export** a name — one
more param type, or a declared `exports` list — so `pv.sync` is spelled by the instance rather than
guessed at by the screen. Left unbuilt and written down, because one screen is not yet an argument.

### 8.4 The shape of the answer

Roughly, of the screen's 734 lines: the constants and the widget wiring become the 88-line document;
`updateStand`, `SelectButton`, `updateWidgets` and the click packing (~180 lines) are deleted
outright; and **the rows — the box, the neck, the cells, the badges, the highlight band, the hit
test and the per-cell tooltip, ~230 lines — stay hand-written in two `region` hooks**, which is
§4.4's rule working rather than failing. Of the menu's 752, the slots, data slots, `quickMoveStack`
and the button decode are generated; the recipe lookup, `assemble` and `remove` stay, and should.

So: **fully coverable, no. Coverable in the half the format claims, yes — and the half it does not
cover is the half it says out loud it will not.** The four gaps in §8.2 are all small, all named,
and three of the four are a property or a signature rather than a mechanism. `list` (step G) would
take about 80 of those 230 lines; the row *contents* would still be a hook, and this port is now the
real screen §6 said that decision needed.
