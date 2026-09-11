# Rendering and screenshots

Getting a picture out of the game — for judging your own work, for a mod page, for a changelog, or as
the subject of an automated check. Two tools do the work: **`render`** puts a camera anywhere and
shoots out of band, and **`studio`** stages a subject against nothing so the shot is repeatable.

The property that makes all of this more than a convenience is that a frozen studio subject renders
**bit-identically** between two shots. That is what turns "here is a picture" into "here is a test".

## On this page

- [How it works](#how-it-works)
  - [`render` is not a screenshot](#render-is-not-a-screenshot)
  - [`studio` — a subject against nothing](#studio--a-subject-against-nothing)
- [Walkthrough: photograph a block, then a body wearing your armor](#walkthrough-photograph-a-block-then-a-body-wearing-your-armor)
- [Pictures cost money](#pictures-cost-money)
- [Screens and the UI](#screens-and-the-ui)
- [An agent session](#an-agent-session)
- [Things to keep in mind](#things-to-keep-in-mind)
- [Where to go next](#where-to-go-next)

---

## How it works

### `render` is not a screenshot

`render` renders the level **out of band** from a viewpoint you choose and writes a PNG. Nobody is
standing anywhere. The HUD and the held item are excluded by construction rather than cropped out.
The resolution is an argument rather than a property of your window. The lens is fixed at 90° FOV.

```jsonc
render {look_at: {x: 10, y: 65, z: 10}, inline: true}
render {look_at: <a box>, frames: 8}                    // an orbit of 8 stills
render {at: {x: 10.5, y: 66.2, z: 8.0}, yaw: 135, pitch: 20}
render {width: 1024, height: 1024, downscale: 2}        // supersampled
```

**Give it `look_at` and the camera places itself.** It stands off along `yaw`/`pitch` at whatever
distance makes the subject fill the frame, so framing a build is a box rather than trigonometry.
`frames: N` turns that into an orbit of N stills around it.

Three honest refusals rather than a bad frame:

- **a client still loading** — nothing would be extracted into the frame;
- **a camera standing in a chunk this client has not been sent** — which would photograph a hole;
- and it renders the dimension the **client** is in, reported back as `dimension`. To photograph
  another one, put the client there first.

Two fields in the reply worth reading. **`window_minimized: true`** is fine and not a problem — the
render is out of band and never needs the screen. **`settled: false`** means chunk sections were
still compiling and the frame may hold holes. And note what `settled: true` does *not* promise: it is
about this client's renderer only, and says nothing about a block change still travelling from the
server — so a render fired immediately after a write can miss it.

### `studio` — a subject against nothing

`studio` stages a subject in the `mcptoolkit:studio` dimension — **no sky, a white background, flat
full-bright light** — and puts the client in front of it.

Three kinds of subject:

```jsonc
studio {id: "mymod:cottage"}                      // a loaded structure template
studio {look_at: <a box>}                         // a copy of blocks standing in the world
studio {entity: "minecraft:zombie",               // a living subject, still
        equipment: {head: "mymod:copper_helm", chest: "mymod:copper_chest"}}
studio {leave: true}                              // sweep it and put the client back
```

With only `equipment`, the subject defaults to an armor stand. `pose` gives an armor stand its six
rotations; `nbt` takes `/summon`'s SNBT for everything else; `yaw` sets facing (default 135, toward
the camera's stand).

It returns the box the subject stands in — and **only once this client can actually see it**, because
the blocks and the entity have to travel from the server, which no render can wait for. Hand that box
straight to `render {look_at: <box>}`.

**`freeze` is what makes it a test.** Default true with an entity. It freezes the game tick once the
subject has arrived — like `/tick freeze`, mirrored on the client — so animation phase, item-model
animation and the enchantment glint all hold still between two renders. Vanilla's glint runs on the
wall clock, so without this two shots of the same armor differ.

The result: **two renders of a frozen subject are pixel-identical.** Measured at a maximum channel
difference of zero. That is the foundation of golden-image testing — see [Mod testing](mod-testing.md).

Three things to know before you use it. It **moves a real player**, so a human driving that client
will find themselves in the studio until you `leave`. Nothing else clears the subject, and one
session cannot sweep another's. And it is stamped `mechanism: world_edit`, honestly, because it
writes blocks into a dimension and teleports a player — that is why it is a tool rather than an
option on `render`.

The studio dimension exists from a world's **second** start. Client-only.

## Walkthrough: photograph a block, then a body wearing your armor

**A block, in place:**

```
set_blocks {blocks: [{x: 10, y: 65, z: 10, block: "mymod:copper_lantern"}]}
render     {look_at: {x: 10, y: 65, z: 10}, inline: true}
```

**The same block, against nothing, from eight angles:**

```
studio {look_at: {x: 10, y: 65, z: 10}}       // → returns a box
render {look_at: <that box>, frames: 8}
studio {leave: true}
```

**A body wearing your equipment:**

```jsonc
studio {entity: "minecraft:armor_stand",
        equipment: {head: "mymod:copper_helm", chest: "mymod:copper_chest",
                    mainhand: "minecraft:diamond_sword"}}
// → box, and the tick is now frozen
render {look_at: <box>, width: 512, inline: true}
studio {leave: true}                          // unfreezes and puts the client back
```

Equipment is given in **full item syntax**, so components and enchantments work:
`"minecraft:diamond_sword[minecraft:enchantments={'minecraft:sharpness':5}]"`.

Do not forget the `leave`. A frozen tick and a player parked in another dimension are not states to
walk away from.

## Pictures cost money

`render`'s **`inline` defaults to false**, and that default is deliberate: a full-resolution PNG is
the most expensive thing this toolkit can put into a conversation. The normal reply is a path, a
resolution and a byte count.

So the habit worth forming: **render to a path, and only ask for it inline when somebody actually
needs to look at it.** For an authoring loop that shoots dozens of frames, that difference is most of
your bill. The MCP server also enforces an image budget per session; `MCPTK_SHOT_MAX` tunes it. See
[Authoring at scale](authoring-at-scale.md).

`downscale` is the other lever in the opposite direction: render at 1024 and average down by 2 for a
512 image that is much cleaner than a native 512, at the cost of the bigger render.

## Screens and the UI

Rendering the *level* is `render`. Photographing the **interface** is a different question, because
what you usually want is not pixels but structure.

- **`get_screen`** returns the screen's widget tree — what is on it, where, and what it is called.
  That is what you want for asserting a layout, not an image.
- **`screenshot_annotated`** draws the widget boxes and their indices onto a screenshot, which is how
  you find out why a click is landing somewhere unexpected.
- **`check_layout`** asserts geometry directly.

See [GUI screens](gui-screens.md).

## An agent session

> **You:** shoot me a hero image of the copper armor set for the mod page.

> **Agent** calls `studio {entity: "minecraft:armor_stand", equipment: {head: ..., chest: ...,
> legs: ..., feet: ...}}`
> → the box comes back; tick frozen.

> **Agent** calls `render {look_at: <box>, yaw: 135, pitch: 15, width: 1024, downscale: 2}`
> → a path, `settled: true`, no inline image.
>
> Then a second call with `inline: true` at a smaller size, so you can see it here without a
> 1024×1024 PNG going through the conversation.

> **You:** the glint's making it hard to read. Can we lose it?

> **Agent:** the glint is pinned rather than animated because the tick is frozen, so it is at least
> the same in every shot — but it is still drawn. Take the enchantments off the stacks for the hero
> image; the item syntax is per-piece.
>
> It re-stages with unenchanted stacks and re-renders.

> **Agent** finishes with `studio {leave: true}`, which unfreezes the tick and puts the client back
> where it was standing.

Two habits worth copying. It **rendered full-size to disk and small to the conversation**, which is
the whole cost discipline in one move. And it **left the studio** rather than leaving a frozen tick
and a player in another dimension for the next session to find.

## Things to keep in mind

**`inline` defaults to false, and should usually stay there.** Render to a path; ask for pixels only
when someone is going to look.

**Always `studio {leave: true}`.** It sweeps the subject, unfreezes the tick, and puts the client
back. Nothing else does it, and another session cannot do it for you.

**`studio` moves a real player.** If a human is driving that client, they are going to the studio
with you.

**`settled: true` is about this client's renderer.** It says nothing about a block change still in
flight from the server. A render fired straight after a write can miss it — read the world back, or
render twice.

**A minimized window is fine.** The render is out of band. `window_minimized: true` in the reply is
information, not a warning.

**`render` shoots the dimension the client is in.** To photograph another one, move the client first.

**Two frozen renders are pixel-identical.** Which means a difference is real, and a golden-image test
is possible. Do not squander that by setting a loose tolerance — see
[Mod testing](mod-testing.md).

**The studio dimension appears from a world's second start.** A brand new world does not have it yet.

**Any non-vanilla dimension makes a save "experimental".** That is Minecraft's own behaviour, not the
toolkit's, and it is why the studio is a dev convenience rather than something to leave on in a world
you care about.

## Where to go next

**In this wiki**

- [Mod testing](mod-testing.md) — golden frames, and why nothing may bless one automatically.
- [Textures and models](textures-and-models.md) — the iteration loop these pictures serve.
- [Entities](entities.md) — staging a creature to look at it.
- [GUI screens](gui-screens.md) — photographing and asserting an interface.
- [Authoring at scale](authoring-at-scale.md) — the image budget, when there are ninety of them.

**Reference**

- `docs/models/RENDER_SEAM_DESIGN.md` §§ 11-14 — the camera, framing, the orbit, the studio
  dimension, as built.
- `LIVE_MODDING.md` § *A body wearing your equipment, photographed still* — `studio {entity}`.
- `LIVE_MODDING.md` § *UI iteration loop* — `get_screen`, `screenshot_annotated`, `check_layout`.
