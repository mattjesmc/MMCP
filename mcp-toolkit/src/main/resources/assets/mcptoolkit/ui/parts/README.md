# The seed parts library

`UI_PARTS_LIBRARY_DESIGN.md` §5.4. Each of these existed, hand-written, in at least two of
`mcp-toolkit` / `ArmorPieces` / `rocketeer` / `villagejobs` / `menagerie` before it was a part.

A part is instantiated from any document, in any mod:

```json
{"kind": "part", "id": "inv", "part": "mcptoolkit:player_inventory", "x": 8, "y": 84}
```

The `x`/`y` is the instance's **origin**: a part file writes its elements around `(0,0)` and the
parser translates them there. That is what makes a fragment reusable, and it is why a part instance
is one draggable object in the editor.

| part | params | what it is |
|---|---|---|
| `player_inventory` | `gap` (58) | the 3×9 backpack and the hotbar. Written in every container screen ever |
| `station_inputs` | `container`, `first` (0), `gap` (18), `hint` (none) | the template+material pair a smithing, furnace or anvil screen has |
| `titled_well` | `w`, `h`, `title` | a recessed box with a caption. The palette's default part, because it declares nothing and so collides with nothing |
| `preview_slot` | `container`, `index` | **a technique, not a layout**: an off-screen slot (−1000, −1000) used purely as a sync channel for a server-computed value. Shipped so nobody re-derives the coordinates |
| `progress_arrow` | `binding`, `w` (24), `h` (8), `orientation` | the furnace-shaped gauge |
| `entity_preview` | `subject` (`player`), `w`, `h`, `scale`, `pitch`, `yaw`, `draggable` | a well with a live entity in it |
| `selector_column` | `count`, `container`, `action`, `pitch`, `first`, `gap`, `sprite`, `sprite_hovered` | N slots on a pitch, each with a bare-sprite select button pressing `action` with its index. **The one that proves the mechanism**: a part whose fragment contains a `repeat` |

`selector_column` needs the screen to declare its action with a matching arity:

```json
"actions": [{"name": "select", "args": [{"name": "index", "size": 4}]}]
```

Two of §5.4's nine are deliberately absent. `icon_cell` (a badge on an icon) is `region` work rather
than layout — §4.4's rule, applied. `tab_strip` is `selector_column` with different sprites, and
shipping the same part twice is how a library starts lying.

## Writing one

```json
{
  "format": 1,
  "params": [
    {"name": "container", "type": "container"},
    {"name": "hint", "type": "sprite", "default": null}
  ],
  "elements": [ ... ]
}
```

* A param with no `"default"` is **required**. `"default": null` means optional-and-absent: the key
  it substitutes into is removed rather than set to null.
* `type` is one of `int`, `number`, `bool`, `string`, `name`, `container`, `action`, `binding`,
  `sprite`, `item`, `texture`, `text`, `color`, `any`. A part **declares what it references and
  never assumes** (§5.2 rule 3); the reference then resolves against the *screen's* declarations,
  because by the time the parser's post-pass runs the part is gone.
* `$name` substitutes: exactly `"$name"` yields the argument's own JSON (any type); an affine form
  (`"$n * 2 + 3"`, `"$n - 1"`) yields a number; anything else interpolates, with `$$` for a literal
  dollar.
* `$i` is **reserved**: it belongs to a `repeat` inside the fragment and is bound one pass later, so
  an outer expansion walks past it. Any other unknown name is a problem where it is written.
* Ids are namespaced on expansion — `inv.backpack`, `row.2.pick` — so a part used twice does not
  collide. A hand-written dot in an id is still refused.
* Refused, and staying refused (§5.3): part inheritance, parts as parameters, and conditionals. A
  part that needs a conditional needs a `region`.
