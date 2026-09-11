# Entities

From geometry in Blockbench to a creature standing in front of you in the running game, in one call —
and, importantly, with the client's own verdict on whether the geometry actually loaded, rather than
a screenshot you have to squint at.

This page covers the entity plugin's loop, the offline check battery that is better evidence than any
picture, and the two limits that surprise people: the preview entity is the toolkit's own and does
**not** register a type for your mod, and staging is hidden outside a few profiles.

`scaffold` does not help here — a creature is a different question with its own door. Blocks and
items are [Blocks and items](blocks-and-items.md).

## On this page

- [How it works](#how-it-works)
  - [The one-call loop](#the-one-call-loop)
  - [The other actions](#the-other-actions)
- [Verify is the finding; the screenshot is legibility](#verify-is-the-finding-the-screenshot-is-legibility)
- [Walkthrough: a spider, from model to standing](#walkthrough-a-spider-from-model-to-standing)
- [Promotion, and what happens after](#promotion-and-what-happens-after)
- [An agent session](#an-agent-session)
- [Things to keep in mind](#things-to-keep-in-mind)
- [Where to go next](#where-to-go-next)

---

## How it works

`mcptoolkit_entity.js` sits on top of `mcptoolkit_sync.js` — it needs that plugin loaded beside it,
and drives its transport rather than reimplementing one. If it is missing, it says so by name.

Load both via File › Plugins › Load Plugin from File, from
`<gameDir>/mcptoolkit/blockbench/`. Panel: Tools › MCP Toolkit Entity. Headless, it is
`mcptoolkitEntity(opts)`, with the last result mirrored into `mcptoolkitEntityLast`. Like the sync
plugin, **it never rejects** — check `.ok`.

### The one-call loop

```js
mcptoolkitEntity({action: 'push', model: 'spider', project: PROJECT, bridge: GAME})
```

That converts the active project into the interchange JSON, pushes the JSON and the texture into the
live pack, and stages a preview entity wearing it.

What comes back is a summary **plus the client's own verdict on the geometry** — `parse: "ok"`, or
`parse: "error"` carrying the loader's own sentence. That is the part that matters: a broken export
is *read* rather than guessed at from a picture of nothing.

`PROJECT` and `GAME` are the same contract as the sync plugin. Pass the project **object**, not a
name, and pass the bridge explicitly — there is no default game, and a push with nowhere to go is
refused by name rather than dialled at a guess.

### The other actions

| Call | For |
|---|---|
| `{action: 'status', bridge}` | Is the sync plugin loaded, is a game there and at which bridge, what is staged |
| `{action: 'convert', model, file?}` | The JSON only, no game needed. `file:` converts a `.bbmodel` off disk without opening it |
| `{action: 'verify'}` | The check battery. No game needed |
| `{action: 'stage' \| 'clear' \| 'list', bridge}` | Drive `stage_entity` directly: re-stage what is pushed, despawn, or ask what is out there |
| `{action: 'promote', namespace: 'yourmod'}` | Write the JSON and PNG into a mod's `src/main/resources` |

## Verify is the finding; the screenshot is legibility

This is the most useful idea on the page.

```js
mcptoolkitEntity({action: 'verify'})
```

The battery runs **SAT overlap over every part pair**, checks shared-face planes, treats the
deliberate 1px sink as a *named tolerance* rather than noise, and audits the UVs. It needs no game
and costs no tokens.

A vision impression of a model is **not evidence** about overlap or coplanarity. You cannot see a
0.5-pixel intersection in a 512-pixel render, and you certainly cannot see it from an angle that
happens to hide it. The battery can. So: run verify for findings, take a screenshot for legibility —
to see whether the thing reads as a spider — and do not confuse the two jobs.

The same principle drives the `parse` field on a push: the client's loader either accepted the
geometry or it did not, and that is a sentence rather than an impression.

## Walkthrough: a spider, from model to standing

**1. Model it** in Blockbench, as usual. The bridge plugin's tools (`place_cube`, `add_group`,
`element`, `inspect`) are available to a session if you are working with an agent — see
[Textures and models](textures-and-models.md).

**2. Check the geometry** before involving a game at all:

```js
mcptoolkitEntity({action: 'verify'})
```

**3. Unlock staging.** `stage_entity` is hidden in the default profile — in every profile except
`entity`, `art` and `full`. Either set `MCPTK_PROFILE=entity` in the consuming `.mcp.json`, or do it
live:

```
tool_surface {profile: "entity"}
```

**4. Push and stage, one call:**

```js
mcptoolkitEntity({action: 'push', model: 'spider', project: PROJECT, bridge: GAME})
// → {ok: true, parse: "ok", staged: true, ...}
```

**5. Look at it.** For a considered picture, put it in the studio:

```
studio {entity: <the preview type>}    // returns a box, freezes the tick
render {look_at: <box>, frames: 6}
studio {leave: true}
```

See [Rendering and screenshots](rendering-and-screenshots.md).

**6. Iterate.** Edit in Blockbench, push again. The staging is replaced.

**7. Clear up:** `{action: 'clear', bridge}` despawns it.

## Promotion, and what happens after

```js
mcptoolkitEntity({action: 'promote', namespace: 'yourmod', sourceRoot: '…'})
// equivalently {action: 'push', target: 'source'}
```

**There is no default `sourceRoot`.** A promotion with nowhere to go is refused by the name of the
setting, because `writeToSource` will create an `assets/` tree wherever it is pointed, and that is
exactly how a file lands in a checkout nobody is looking at. Set it once, per project:

```js
mcptoolkitEntity({action: 'settings',
                  set: {sourceRoots: {spider: 'C:/dev/mymod/src/main/resources'}}})
```

**What happens after the promotion is your business, and the toolkit generates no Java.** Load the
file at runtime with your own loader, project it onto your own codec, or treat it as the source a
codegen step reads. The toolkit's job ends at a correct file in your resources.

## An agent session

> **You:** push the spider and let me see it.

> **Agent** calls `mcptoolkitEntity({action: 'verify'})` first.
> → two findings: the left rear leg overlaps the abdomen by 1.2px, and one face's UV is off-sheet.
>
> It reports them before pushing, because both are cheaper to fix in the model than to diagnose from
> a render.

> **You:** the overlap's fine, it's inside the body. Fix the UV.

> **Agent** fixes the UV through the bridge plugin, re-runs verify → UV clean, overlap still reported
> and now understood.
>
> Then `mcptoolkitEntity({action: 'push', model: 'spider', project: PROJECT, bridge: GAME})`
> → `{ok: true, parse: "ok"}`.
>
> The client's loader accepted the geometry — that is a fact, not an inference from the picture.

> **Agent** calls `studio {entity: ...}`, `render {look_at: <box>, frames: 4}`, `studio {leave:
> true}`, and hands over four angles.

> **You:** ship it.

> **Agent:** promoting writes the JSON and PNG into your resources. Worth saying: this never
> registered an entity type for your mod — the preview is the toolkit's own, and the registry freezes
> at bootstrap. Wiring your own `EntityType` is ordinary Fabric work and needs a rebuild.

Two things there are the pattern. **Verify ran before the push**, because the cheap offline check
finds what a render cannot. And the agent **stated the limit at the point it mattered** rather than
letting you discover later that nothing was registered.

## Things to keep in mind

**The preview entity is the toolkit's own.** One type, no AI, never persisted. Staging does **not**
register an entity type for your mod, and it never will — the registry freezes at bootstrap. Your own
`EntityType` is normal Fabric work, and it is a rebuild.

**Staging requires the `mcptoolkit` namespace.** `PreviewModels` reads `assets/mcptoolkit/preview/`
and nowhere else. A push into your own namespace is a *promotion*, not a preview, and it is reported
as pushed-but-not-staged rather than staged-invisibly.

**`stage_entity` is hidden in most profiles.** `entity`, `art` and `full` have it. It is an authoring
verb, and a session that is not authoring an entity should not pay for it every turn.

**Verify is the evidence.** SAT overlap over every part pair, shared-face planes, the UV audit — no
game, no tokens. A screenshot is for legibility, never for geometry.

**`parse: "error"` carries the loader's own sentence.** Read it. It is the client telling you exactly
what it could not load.

**The sync plugin must be loaded beside this one.** It drives that plugin's transport rather than
having its own.

**Pass the project object and the bridge.** A name is refused; a guessed port dials whatever game is
there.

**It never rejects.** `{ok: false, error}` is how failures come back.

**No default `sourceRoot`, deliberately.**

**The coordinate flip happens in the plugin, on export**, so the Java loader does no arithmetic and
there is no second implementation to drift. If you are writing that conversion somewhere else,
`EXTENDING.md` carries the rule and its arbiter — Blockbench's own codec.

**A texture with an illegal asset name is refused with the rename to make**, rather than pushed to
land beside the file the JSON references.

## Where to go next

**In this wiki**

- [Textures and models](textures-and-models.md) — the plugins, windows, sessions, promotion.
- [Rendering and screenshots](rendering-and-screenshots.md) — `studio` and `render` for a considered
  look.
- [Tool profiles and cost](tool-profiles-and-cost.md) — why `stage_entity` is hidden, and how to
  widen.
- [Blocks and items](blocks-and-items.md) — the other kind of content, with its own scaffolder.
- [Mod testing](mod-testing.md) — turning verify into a check that runs on its own.

**Reference**

- `LIVE_MODDING.md` § *Blockbench link* → `mcptoolkit_entity.js` — the loop and every action.
- `docs/models/ENTITY_AUTHORING_DESIGN.md` § 2 — geometry to a standing preview; animation
  (`format: 2`).
- `EXTENDING.md` — the coordinate rule and its arbiter, if you are writing the conversion elsewhere.
