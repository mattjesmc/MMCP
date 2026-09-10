# Entity Authoring — the toolkit's layer

Status: **PHASES 1, 2 AND 3 BUILT.** Phase 1 (toolkit 0.90.0, mcp-server 0.35.0) — the preview
entity, the one interpreter, the renderer, `stage_entity` and the `entity` profile. Phase 2
(`blockbench/mcptoolkit_entity.js` 0.1.0, `mcptoolkit_sync.js` 0.3.0) — the exporter, the check
battery and promotion. Phase 3 (2026-08-26, docs + the boundary move) — `LIVE_MODDING.md`'s entity
loop, `EXTENDING.md`'s editor conventions, and `menagerie_divisions.js` gone home to the menagerie
checkout; §7.3 records what it decided. §7.2's last owed arm — the one Blockbench click — was
made on 2026-08-26 and is recorded there, so nothing in phases 1-3 is owed. Phase 4 (animation)
is still design. Amendments each build made are marked **(0.90.0)**, **(plugin 0.1.0)** and
**(phase 3)** in place rather than rewritten over.
Companion docs: `LIVE_MODDING.md` (the push loop this rides), `EXTENDING.md` (the seam mods build
editors on), menagerie `ROADMAP.md` §45 (the editor whose rules this generalises — read its four
rules first; they are imported here as constraints, not re-argued).

## 1. What this is, and what it is not

The toolkit already authors **blocks, textures, models, datapacks and resource packs** live against
a running game. Entities are the missing kind: today the only entity editor in the workspace is
menagerie's divisions panel, and the only entity art pipeline is per-session scratch scripting
(the corridor mobs, the butterflies, the ghast, the narwhal — every campaign rebuilt the same
transport, the same overlap tests, the same preview loop).

This design gives the toolkit a **standalone entity editor**: author geometry and textures in
Blockbench, see them on a live entity in the running game seconds later, verify them mechanically,
and promote the result into a consumer mod's `src/main/resources`. Mod-specific editors (menagerie's
divisions and — later — its part authoring) build on top through the existing extension seam and the
conventions in §8.

What it is **not**:

- **Not a runtime part framework for consumer mods.** Menagerie keeps its renderer, its
  `StructureKey`, its `AuthoredSets` codec and its invariants. The toolkit's runtime model code
  exists for exactly one entity type: the toolkit's own preview entity. A consumer mod that wants
  data-driven models at runtime writes its own loader against its own rules; the plugin converts
  the interchange format into that mod's format at promotion time (§6.3).
- **Not a way to register entity types for other mods.** The registry freezes after bootstrap
  (verified in menagerie `ROADMAP.md` §18: `BuiltInRegistries.java` — datapacks cannot add types).
  Consumer mods register their own types in their own init; the preview entity is the toolkit's,
  full stop.
- **Not a second mesh implementation.** Menagerie §45.2 rule 4 ("one generator implementation,
  ever") imports directly: exactly one piece of code turns geometry data into `ModelPart`s — the
  Java loader in §4. The Blockbench plugin converts *file formats* (bbmodel → interchange JSON);
  it never interprets geometry into meshes, computes derived facts, or renders previews of its own.
  What the author judges is the game's own rendering.
- **Not a generic form engine.** The divisions panel is a *predicate form* editor and this is a
  *geometry* editor; they share transport idioms, not a UI. Generalising a form language from one
  instance is the corridor-third-pass mistake (a split refused by measurement). If a second
  predicate-style editor ever appears, extract the form engine then.

## 2. The loop (the whole product, in one paragraph)

    author geometry + texture in Blockbench
        → one headless push (bbmodel → interchange JSON + PNGs → mcptoolkitPush extras → live pack)
        → `stage_entity` spawns/refreshes a preview entity wearing that model in the running game
        → the author (human or agent, via screenshot) judges the game's own rendering
        → `verify` runs the mechanical checks (overlap, coplanarity, pose sweep) plugin-side
        → promotion writes the interchange JSON + PNGs into the consumer mod's resources

Every arrow except `stage_entity` and the verify kit already exists and is live-verified
(`push_asset`/`reload_resources`/`mcptoolkit_live` pack, `mcptoolkitPush` with `extras` and
`target:'source'` — see `LIVE_MODDING.md`).

## 3. The preview entity — `mcptoolkit:preview`

One new entity type, registered exactly the way the drone and walker already are. The whole
checklist is solved plumbing; it is listed so nothing is forgotten, not because any of it is open:

1. **Type**: added in `DroneEntities.registerTypes()` (bootstrap freeze window, idempotent,
   both loaders — `BuiltInRegistriesMixin`). `MobCategory.MISC`, default `.sized(1.0F, 1.0F)`.
2. **Class**: extends `PathfinderMob` (like `BotBodyEntity`), **no goals, no gravity opinion, no
   AI**. It stands where staged and turns when told. `shouldBeSaved() → false` and
   `setPersistenceRequired()` in the ctor — never persisted, which also forecloses the
   registered-type-with-no-renderer save landmine on any server the jar later leaves.
3. **Attributes**: lazy supplier via `ToolkitAttributes` (max health, nothing exotic).
4. **Lang key**: `entity.mcptoolkit.preview` in `en_us.json` + the `BootstrapMixin` filter list.
5. **Renderer**: registered in `McpToolkitClient.init()` — both loader shims already route there.
6. **Synched data** (the server never sees geometry, §4.3):
   - `DATA_MODEL_ID` (string) — which interchange asset this instance wears
     (`assets/mcptoolkit/preview/<id>.json` in the live pack).
   - `DATA_SIZE` (vec/two floats) — hitbox width/height, from `stage_entity` args;
     `getDimensions` override + `refreshDimensions()` on change.
   - `DATA_SPIN` (byte) — 0 = hold yaw, 1 = slow turntable (the cheapest "walk around it"
     substitute an agent has).
   - `DATA_CLIP` (string) + `DATA_CLIP_TIME` (float) — which animation clip plays, and −1 for
     "loop from stage time" vs. ≥0 for "freeze at this second" (§9). **Deferred to phase 4 as
     built** (0.90.0): nothing writes them until `format: 2` exists, and a synched field with no
     writer is dead weight on every preview packet in the meantime.

Many instances of the one type may coexist, each wearing a different model — a contact sheet is a
grid of stages, not a special mode.

## 4. Geometry: the interchange format and its one interpreter

### 4.1 The format

`assets/mcptoolkit/preview/<id>.json` — a flat cube-part tree, deliberately the shape both
Blockbench and vanilla `PartDefinition` can express without loss:

```json
{
  "format": 1,
  "texture": { "width": 64, "height": 64, "asset": "mcptoolkit:textures/preview/<id>.png" },
  "parts": [
    { "name": "body", "parent": null,
      "pivot": [0.0, 20.0, 0.0], "rotation": [0.0, 0.0, 0.0],
      "cubes": [ { "origin": [-4.0, -4.0, -6.0], "size": [8, 8, 12],
                   "uv": [20, 0], "inflate": 0.0, "mirror": false } ] },
    { "name": "head", "parent": "body", "pivot": [0.0, 2.0, -6.0], "rotation": [0, 0, 0],
      "cubes": [ { "origin": [-3.0, -3.0, -6.0], "size": [6, 6, 6], "uv": [0, 0] } ] }
  ]
}
```

Decisions, each priced:

- **Vanilla model space, not Blockbench space.** Pivots/origins in vanilla entity-model pixels
  (y down, part posed at y=24 = feet). The *plugin* does the flip on export, because Blockbench's
  own `modded_entity` codec already does and because menagerie's `CensusTool.bbmodel()` documents
  every trap of the inverse trip (`CensusTool.java` ~:419-462: ×16 px-per-block on pivots,
  `y' = 24 − y` negating only x/z rotation, Euler XYZ out vs ZYX composition). The Java loader
  then maps fields 1:1 onto `PartDefinition.addOrReplaceChild` — no arithmetic in the loader means
  no second implementation of the flip to drift.

  **The flip is NOT the one CensusTool documents, and this section named the wrong arbiter**
  (plugin 0.1.0). Read out of Blockbench 5.1's own `Codecs.modded_entity.compile`, the rule is
  `x *= -1; y *= -1; if (no parent) y += 24` on pivots and `(-rx, -ry, +rz)` on rotations —
  **x is negated too**, because vanilla renders entity models through `LivingEntityRenderer`'s
  `scale(-1, -1, 1)`: two negations, not one. CensusTool flips only y because it targets the
  `free` format, which is a different destination; following it here would mirror every model
  left-for-right, and every entity source in this workspace is symmetric enough to hide it.
  It stays the checklist for the ×16 trap and the y flip; it is not the authority on x.

  **And the Euler order needs no conversion at all**, which is the opposite of what §4.1's own
  "Euler XYZ out vs ZYX composition" note implies. Vanilla composes `Quaternionf.rotationZYX`
  (`ModelPart.java:169`) and Blockbench composes a `THREE.Euler` whose order is
  `Format.euler_order`, **which defaults to `ZYX`** — the same order. The flip `diag(-1, -1, 1)`
  is a 180° turn about Z, a *proper* rotation, so conjugating by it rewrites
  `Rz(c)Ry(b)Rx(a)` as `Rz(c)Ry(−b)Rx(−a)`: term by term, order intact. "Negate x and y, keep z"
  is therefore exact for three-axis rotations and not merely for the single-axis case every real
  subject in this workspace happens to use. The harness proves it with a `[17, −23, 41]` bone.
- **Rotations are RADIANS**, the unit `PartPose.offsetAndRotation` takes — decided when the loader
  was built (0.90.0) and recorded here because it is exactly the sort of thing that drifts silently
  between an exporter and an importer. It follows from the bullet above rather than contradicting
  §9.1: geometry is stored in VANILLA space so the loader does no arithmetic, and animation
  keyframes are stored as AUTHORED (degrees) because vanilla's own `KeyframeAnimations` is the thing
  that converts them. Two different rules because the conversion happens in two different places,
  and in both cases the toolkit rides an existing implementation instead of writing a second one.
- **Box UV only in v1** (`uv` = offset pair). It is what Blockbench's box_uv projects, what every
  entity in this workspace uses, and what keeps the format flat. Per-face UV is a `format: 2`
  concern, additive.
- **Flat part list with `parent` by name**, not a nested tree — same shape as menagerie's
  `AuthoredSets.PART_CODEC` (name/parent/dims/origin/pivot/rotation), which is deliberate: the
  promotion converter for menagerie phase 2 becomes a projection, not a restructuring.
- **The texture is referenced, not embedded.** It travels through the same push as any other asset.

### 4.2 The loader — the one interpreter

`client/PreviewModels.java`:

- Reads the JSON off the **resource manager** (the live pack is just a pack; a promoted copy baked
  into a mod jar would load identically — the format IS the file format, §45.2 rule 1).
- Builds `MeshDefinition` → `PartDefinition` tree → bakes a root `ModelPart`, wrapped in a trivial
  `PreviewModel extends EntityModel<PreviewRenderState>`.
- Caches `modelId → (generation, model)`. **Invalidation is a static generation counter bumped by
  `AssetTools`** whenever a `push_asset`/`clear_assets` touches `assets/mcptoolkit/preview/` —
  `push_asset` runs on the client thread already, so this is one line and no mixin, and a push with
  `reload:true` repaints both texture and geometry in the same reload.
- Malformed geometry loads as the **error model** (a magenta/black unit cube) and the parse error
  is surfaced on `stage_entity`'s next result — never a client crash, never a silent old model.

### 4.3 The renderer

`client/PreviewRenderer extends MobRenderer<PreviewEntity, PreviewRenderState, PreviewModel>`.
Per-entity model selection uses the menagerie-proven mechanism: `LivingEntityRenderer.model` is
`protected`, non-final, and read only inside `submit`, and submission is deferred per-node — so the
renderer looks up the entity's model id in `PreviewModels` and points the field at the cached model
before delegating. All vanilla submit logic (render type, layers, outline) is inherited.

The **server** never parses geometry. It knows the model id string and the hitbox size, both from
`stage_entity` args, both synched. This is why the hitbox is an argument (the plugin computes the
geometry bounds and passes it) rather than derived server-side.

## 5. The bridge surface: one tool, one profile

### 5.1 `stage_entity` — the only new manifest entry

Priced per the place-shapes lesson: the schema is the bigger half of a manifest entry's bill, so
this is **one tool with an `op` field**, not a family:

- `op:"stage"` — `{model, pos?|relative?, size?:[w,h], yaw?, spin?, scale?, tag?, replace?:true,
  clip?, clip_time?}` (the last two are the animation surface — §9).
  Default replaces the previous stage with the same `tag` (the divisions panel's re-roll idiom);
  `replace:false` accumulates (contact sheets).
- `op:"clear"` — `{tag?}` despawns staged previews (all, or one tag). Forceload-aware: previews
  are never persisted, but sweep anyway (probe-site-contamination rule).
- `op:"list"` — what is staged where, with model ids and the last geometry parse error if any.

`ExecutionContext.SERVER`, `Mechanism.PRIVILEGED`, registered as a builtin in the same pass as the
other tool classes. Result of `stage` echoes the client-side parse status (ok / error-model) so a
headless agent learns about bad geometry without a screenshot.

Estimated manifest entry ≤ ~450 tokens (three ops sharing one field table; measure at build time
per the standing rule: price the ENTRY, then re-measure live). **Measured 606 tokens** (0.90.0,
live `/tools`) — 35% over, and every token of the overrun is in the SCHEMA, which did not exist
when the estimate was made. The three-tool alternative, written out and counted, is 802. Both
numbers and what they mean for estimating: TOKEN_PER_TOOL_FINDINGS.md finding 7.

### 5.2 The `entity` profile

Profiles are Node-side deny-lists (`mcp-server/index.mjs` `PROFILES`), and extensions cannot
declare membership — so this is wired exactly like the existing sets:

```js
const ENTITY_SURFACE = ["stage_entity"];
const PROFILES = {
  full:     [],
  standard: [...SWAPPED_BLOCK_READS, ...ENTITY_SURFACE],   // hidden by default
  entity:   [...SWAPPED_BLOCK_READS],                      // standard + entity surface
  play:     [...DEV_ONLY, ...CLIENT_SURFACE, ...ENTITY_SURFACE],
  survey:   [...],   // + ENTITY_SURFACE
  survival: [...],   // + ENTITY_SURFACE
};
```

`MCPTK_PROFILE=entity` in the consuming `.mcp.json` unlocks it; `full` shows everything as ever
(the user's own ruling: that is the ALL profile's problem). Probes to extend are enumerated in
`probes/profiles.test.mjs` (profile list, nesting, keep-set).

**Built without the no-op-hide exemption** (0.90.0). This section asked for `ENTITY_SURFACE` to be
exempted the way `CLIENT_SURFACE` is; it is not, because the two are not alike. Client tools are
*conditionally present* — registered only while a game client is attached — so hiding one headless
is an expected no-op. `stage_entity` is a SERVER tool and is in every manifest the bridge serves, so
an exemption would suppress a warning that can only ever mean something real: that the name has been
renamed, or that the game is running a jar that predates it. The warning is left armed.

## 6. The Blockbench plugin — `mcptoolkit_entity.js` **(BUILT, plugin 0.1.0)**

Third plugin in `mcp-toolkit/blockbench/`, same idioms as its neighbours (never-reject headless
API, `globalThis.mcptoolkitEntity(opts)` + `...Last` mirror, settings in localStorage, bridge at
`127.0.0.1:25599/cmd`). The idioms stay deliberately duplicated per file, as the existing two
already decide — a require()-shared library across Blockbench plugin load contexts is its own
project and not this one.

### 6.1 `action:'push'` — the one-call loop

Converts the active project to interchange JSON (the y-flip/scale/Euler conversion, cribbed from
the `modded_entity` codec with `CensusTool.bbmodel()`'s documented traps as the checklist),
computes the geometry bounds, then drives the existing machinery: `mcptoolkitPush` with the JSON as
an `extras` entry + the project textures, followed by `stage_entity {op:"stage", model, size}` over
the bridge. Options: `{model, project, pos, spin, target:'live'|'source'|'both', sourceRoot,
stage:true}`. One call, bytes never in the transcript.

### 6.2 `action:'verify'` — the geometry checks get a permanent home

The corridor-era knowledge, currently living in dead session scratch scripts, becomes a shipped
check battery run plugin-side (it needs only the project's cubes — no game):

- **Separating-axis overlap** over ALL unordered part pairs in ALL listed poses (never only the
  reported pair — the spider's fang survived a fix round that way).
- **Shared-face-plane detector** that knows which axes each rotation actually protects (a yaw
  leaves y-faces coplanar; SAT alone scores that pair 0.000 and clean).
- Deliberate 1px anti-z-fight sinking encoded as a **named tolerance**, not a blanket skip.
- Output: worst-first table, full table on every re-run (fixing one coplanarity routinely creates
  another).
- **UV audit**: pairwise uv_offset footprint overlap (auto-UV gives every cube `[0,0]`), plus the
  opaque-pixel-count == face-area-arithmetic check that proves paint landed.

`action:'verify'` returns the table; the panel shows it. A vision impression is never a finding —
the checks are the findings, the screenshot is legibility only.

### 6.3 Promotion

`target:'source'` writes the interchange JSON + PNGs into the consumer mod's resources via the
existing `writeToSource` route (plugin-side `fs`, per-project `sourceRoot` setting — the current
hardcoded default must become a setting when this lands). **Done in both plugins** (plugin 0.1.0):
`mcptoolkit_sync.js` 0.3.0 drops the literal `<workbench>/mcmodding/src/main/resources` for a
localStorage `{sourceRoot, sourceRoots{project: path}}` reachable as `mcptoolkitPushSettings(patch)`,
and a promotion with nowhere to go is **refused by the name of the setting** rather than defaulted —
`writeToSource` creates an `assets/` tree wherever it is pointed, so a wrong-but-plausible default
is how a file lands in a checkout nobody is looking at. What the consumer does with the file is
the consumer's business: load it at runtime with its own loader, convert it (menagerie phase 2
projects it onto `AuthoredSets`' codec), or treat it as the source of truth a codegen step reads.
Generating Java model classes is explicitly out of scope for v1 and recorded here so it is a
decision, not an omission.

## 7. Build order

| Phase | Contents | Arbiter |
|---|---|---|
| 1 — Java **(BUILT 0.90.0)** | `PreviewEntity` + registration checklist §3; `PreviewModels` loader + error model; `PreviewRenderer`; `stage_entity`; generation bump in `AssetTools`; `entity` profile in `index.mjs` | new `probes/entity-preview.test.mjs` (stage/clear/list, parse-error surfacing, size sync) + `profiles.test.mjs` extensions + conformance manifest count |
| 2 — Plugin **(BUILT, plugin 0.1.0)** | `mcptoolkit_entity.js` push/verify/promote; conversion checklist from `CensusTool.bbmodel()` | `blockbench/mcptoolkit_entity.test.mjs` (à la `menagerie_divisions.test.mjs`): round-trip a known bbmodel → JSON → assert byte-stable, verify-battery fixtures with a planted overlap, a planted coplanarity, a planted UV collision |
| 3 — Boundary **(BUILT 2026-08-26)** | `LIVE_MODDING.md` + `EXTENDING.md` sections; `menagerie_divisions.js` relocates to the menagerie repo (it is menagerie's editor; §45.4 parked it here only because it was free); its `.test.mjs` goes with it | menagerie battery still green from its side |
| 4 — Animation **(BUILT 2026-08-26)** | `format: 2` (§9): loader parses/bakes clips with the error surface; `stage_entity` clip args; plugin exports the timeline + verify samples animated poses. Three open decisions settled in §9.6, two of them against this document's own lean | probe: stage with a clip, scrub via `clip_time`, unknown-bone clip surfaces as error not crash; verify fixtures with a planted mid-keyframe overlap |

Live verification is sequential on one world, as always. Phase 1 alone is already useful (agents
can stage any pushed geometry); phase 2 is where the human loop closes.

### 7.1 What phase 2's arbiter turned out to be, and what it caught (plugin 0.1.0)

The planned arbiter — "round-trip a known bbmodel, assert byte-stable" — is **half a harness**, for
the reason `menagerie_divisions.test.mjs` §4b states outright: byte-stability proves the exporter is
deterministic, never that its numbers are right, and a golden file only ever agrees with whatever
the exporter did the day it was written. So the harness's real assertion is **geometric**, and it
uses two walkers written inside the test rather than anything the plugin exposes: one walks the
`.bbmodel` by Blockbench's rules, the other walks the emitted interchange by *vanilla's*
(`ModelPart.java:167-169`), and every cube's eight corners must line up under
`(x, y, z) → (−x, 24 − y, z)`. One assertion covering the pivot subtraction, both sign flips, the
ground offset, the rotation conjugation and the Euler order — and unsatisfiable by copying the
exporter, because neither walker knows it exists.

Three things it found, in the order they hurt:

1. **The vocabulary gap is real here too, and it is worse than next door's.** Of the seventeen
   `.bbmodel` sources in this workspace, **not one uses cube rotation, cube inflate, or mirrored
   UV** — so the rotation-subgroup synthesis, the most intricate thing in the exporter, has no real
   subject at all. Section 3 of the harness is the fixture that does, deliberately asymmetric in
   every dimension so a wrong sign cannot hide behind a symmetry.
2. **Seven of the seventeen are entity models; eight are block models.** A `java_block` project is
   authored inside a 0..16 block, not standing on the ground line, so it converts *plausibly and
   wrongly*. The exporter warns; the harness asserts the partition rather than demanding all
   seventeen convert.
3. **A bug in the check battery that only the touching case could show.** Tracking penetration
   depth as "the smallest strictly-negative separation" reports two boxes that touch EXACTLY as
   deeply interpenetrating — the touching axis contributes zero, is skipped, and some other axis's
   overlap becomes the answer. Two boxes stacked face-to-face are the commonest contact in a boxy
   model and the case this battery exists to be right about. The fix is to derive depth from the
   single running maximum: the axis of greatest separation is the axis of least overlap.

That third one also moved a decision: the shared-plane detector now runs on **every** pair rather
than only on the ones SAT calls clean. Two boxes resting flush are neither separated nor
overlapping, so deciding whether to look for a shared plane from SAT's verdict is exactly how that
pair goes unreported — which is the corridor lesson restated, at one level of indirection.

### 7.2 Phase 2's live verification (COMPLETE 2026-08-26)

The loader half is **verified live** (dev client, one world, sequential): `corridor_spider` and
`space_narwhal` converted from their real `.bbmodel` sources, pushed with `push_asset`, staged, and
`stage_entity` answered `parse: "ok"` for both — upright, standing on the ground line, symmetric,
recognisable. Deliberately broken geometry (a part naming a parent not defined above it) came back
`parse: "error"` carrying the loader's own sentence, so the plugin never has to guess.

**The Blockbench arm is now verified too (2026-08-26).** `mcptoolkitEntity({action: 'push', model:
'narwhal', project: 'space_narwhal'})`, driven through the Blockbench MCP bridge's `risky_eval`
against `blockbench_sources/space_narwhal.bbmodel` open in a real tab, answered
`{ok: true, parse: "ok"}`: 7 cubes, 2 files pushed (geometry + PNG), preview entity staged and
rendering in the dev client — upright, on the ground line, tusk forward, eye where it belongs,
recognisable side-on and head-on. `verify` ran on the same live project. Both grips the owed click
existed to test are therefore exercised: `Codecs.project.compile({raw: true})` on the push path and
`Texture.all` on the verify path.

Three things that click was worth, none of them the transport:

1. **`pixelsOf()` had never run.** The harness supplies `pixels` synthetically (test 6d), so the
   paint *arithmetic* was covered while the function that goes and gets the pixels — find the
   texture in `Texture.all`, read its canvas — had no coverage at all, in either direction. It
   works, and on its first real subject it returned `painted: 2004, opaque: 2108`: 104 opaque
   pixels on `space_narwhal.png` that no face's UV claims. Which is a fact about that texture, not
   a fault in the plugin, but it is the kind of fact only this arm can produce.
2. **The real subject took the ungrouped path.** `space_narwhal.bbmodel` has seven cubes and *no
   groups*, so the export came back `parts: 1` — everything under the synthetic `bb_main` root.
   The one real model §7.3 vendored as a travelling fixture happens not to exercise the outliner
   hierarchy at all, which is worth knowing before phase 4 leans on it.
3. **`risky_eval` needs a project open before it will evaluate anything.** With no tab open it
   fails with `Cannot read properties of undefined (reading 'finishEdit')` — the MCP plugin wraps
   every eval in an undo edit, and an undo edit needs a `Project`. An agent driving this loop from
   cold opens or creates a project first; `create_project` then `loadModelFile({content, path,
   name})` does it without touching a file dialog, which matters because a modal dialog in
   Blockbench wedges the MCP server until someone clicks it.

### 7.3 What phase 3 decided, and the check its audit found dark (phase 3)

The move itself was uneventful: `menagerie_divisions.js` and its harness now live in
`menagerie/blockbench/`, both of the harness's absolute paths are derived from the file's own
location instead of written out, and it is green from menagerie's side. The two standing questions
phase 2 left are the record here.

**1. One real `.bbmodel` travels with the harness.** `mcptoolkit_entity.test.mjs` reads its real
subjects from `../../blockbench_sources` — a *sibling* of mcp-toolkit, not a part of it — so on the
checkout `RELEASE_1.md` describes, section 2's arbiter would simply have gone missing. The fix is
one vendored model in `blockbench/fixtures/` (`space_narwhal.bbmodel`, deliberately one of the two
§7.2 stood the loader up against live), and a corpus resolved widest-first: an explicit argument,
then the sibling corpus, then the fixture. **The run prints which corpus it got**, because "7
subjects" and "1 subject" are different amounts of evidence and a reader is entitled to know which
they are holding. Verified both ways, plus a third: the harness copied into a directory with no
sibling corpus runs green and says so.

Copying more of the corpus was considered and refused. A second entity model is more of the same
evidence; what the narrow corpus actually loses is the *block-model partition*, and the answer to
that is a fixture, not a bigger pile of real files.

**2. And the partition arm had a dark check inside it.** Auditing what the narrow corpus would cost
turned up something the wide one was already hiding: `a box-UV block model converts but is warned
about` sits behind `if (boxUvBlock)`, and **all eight** of this workspace's block models are
per-face UV — so they are refused before the warning can be reached and that arm has never run,
against any subject, since it was written. The ground-line warning is §7.1 finding 2's whole point,
and it was covered by an intention. Section 5 now plants the fixture (`doc()` gained a `format`
argument), and section 2 *prints* whether the corpus had a subject for it rather than skipping in
silence. Which is finding 3's lesson at one more level of indirection: **deciding whether to look
from a condition the data never satisfies is how a check reports nothing forever.**

The docs are the phase's actual deliverable, and §8's four seams ship as conventions in
`EXTENDING.md` — including §7.1's coordinate-flip finding, stated where an editor author will meet
it rather than buried in a design record: the arbiter is Blockbench's own `modded_entity` codec,
x is negated as well as y, and the Euler order needs no conversion.

## 8. What mod editors get to stand on (the extension story)

A mod building its own editor — menagerie today, anything later — rides four proven seams, and the
docs (not new code) are the deliverable here. **WRITTEN (phase 3)**: `EXTENDING.md` gained
*Building an editor on the toolkit* — these four seams, the conventions below, and §7.1's
coordinate-flip finding stated where an editor author meets it rather than buried in a design
record. `LIVE_MODDING.md` gained the entity loop and *Editors that live with their mod*.

1. **Tools**: the `ToolRegistrar` entrypoint (`EXTENDING.md`) for anything needing a manifest
   presence — knowing its tools land in every profile, so bridge-`run_command`-driven Brigadier
   commands (menagerie's choice) remain the zero-manifest-cost default.
2. **Assets**: `push_asset`/`mcptoolkitPush`/the live pack, unchanged.
3. **Preview**: `stage_entity` for raw geometry; the mod's own stage commands for anything its
   runtime generates (a menagerie creature is decoded by menagerie, never re-modelled here).
4. **The manifest conventions**, proven by the divisions panel (`menagerie/blockbench/` since
   phase 3) and stated in `EXTENDING.md` as
   conventions rather than shipped as a framework: vocabulary is *generated* by the mod
   (a gradle task writing a vocab JSON + a classpath argfile), the panel holds no model of the mod,
   derived facts are *measured* through the mod's own CLI/codec/commands, the datapack format is
   the file format, and headless APIs never reject.

Menagerie's plugin phase 2 (part authoring, §45.4's parked wave-5 item) then becomes: author parts
with the toolkit's editor, verify with §6.2, and promote through a menagerie-side projection onto
`AuthoredSets` — no new mesh code on either side.

## 9. Animation authoring — `format: 2`

Blockbench's animation timeline and vanilla 26.2's keyframe system are the same shape, and that is
what makes this an additive format revision rather than a project:

- Vanilla: `AnimationDefinition(lengthInSeconds, looping, Map<boneName, List<AnimationChannel>>)`,
  `AnimationChannel(target, Keyframe...)` with targets POSITION/ROTATION/SCALE and interpolations
  LINEAR/CATMULLROM, `Keyframe(timestamp, preTarget, postTarget, interpolation)` — the pre/post
  split is how a step/hold is expressed. All public records (`vanilla-src
  net/minecraft/client/animation/*.java`) — buildable straight from parsed JSON, no builder
  codegen needed.
- Blockbench: per-bone animators with rotation/position/scale channels and
  linear/catmullrom/step keyframes. The plugin export is a projection, same as geometry.

### 9.1 Format

`format: 2` adds one top-level key to the interchange JSON:

```json
"animations": {
  "idle":   { "length": 2.0, "loop": true,
              "bones": { "head": [ { "target": "rotation",
                          "keyframes": [ { "t": 0.0, "post": [0, 0, 0], "interp": "catmullrom" },
                                         { "t": 1.0, "post": [0, 15, 0], "interp": "catmullrom" } ] } ] } }
}
```

**(SUPERSEDED by §9.6 decision 1 — values are stored in vanilla's FINAL units and the loader does
no arithmetic. The paragraph is kept because the reasoning it was rejected for is the point.)**
Keyframe values are stored as **authored** (Blockbench's units), and the loader applies the same
per-target conversions vanilla's own definitions route through `KeyframeAnimations`
(`vanilla-src .../animation/KeyframeAnimations.java`): position negates y, rotation converts
degrees→radians (`degreeVec`), scale stores `scale − 1` because the targets apply *offsets*
(`ModelPart::offsetPos/offsetRotation/offsetScale`). `pre` optional, defaulting to `post` — exactly
the two `Keyframe` constructors, and 26.2's `Keyframe` really is the 4-arg record plus a 3-arg
convenience overload, so that part of the format is confirmed.

**(2026-08-26, settled before the build — and the flagged unknown had the trap in it.)** The
paragraph above describes only *vanilla's half* of the conversion, and the sentence it replaced
("Blockbench's position-channel unit must be verified at build time; do not assume") was right to
be suspicious. The arbiter is the same one §7.1 found for geometry — Blockbench's own
`modded_entity` codec, whose *animation* template (`Codecs.modded_entity.animation_templates`,
`mojang`) emits `new Keyframe(t, KeyframeAnimations.posVec(x, y, z), interp)` and feeds it values
it has **already pre-negated** in `AnimationCodec("modded_entity").compileFile`:

    position:  x *= -1                 (y, z pass through)
    rotation:  x *= -1;  y *= -1       (z passes through)
    scale:     unchanged

Compose that with `posVec(x,y,z) = (x, -y, z)` and `degreeVec` (radians, no sign change), and the
net authored-to-vanilla rule falls out:

| channel | authored in Blockbench | what `ModelPart::offset*` finally gets |
|---|---|---|
| position | `(x, y, z)` px | `(-x, -y, z)` px |
| rotation | `(rx, ry, rz)` deg | `(-rx, -ry, rz)` rad |
| scale | `(sx, sy, sz)` | `(sx-1, sy-1, sz-1)` |

So **position is the same two-negation flip as the geometry**, not the single y-flip that "position
negates y" reads as, and **rotation is the same rule as a part's rest pose** — one coordinate
convention across the whole format, which is the reassuring answer. The trap is that vanilla's
`posVec` does half the flip and Blockbench's exporter does the other half, so a loader written from
`KeyframeAnimations.java` alone implements exactly half and **mirrors every animation's x
translation**. That is §7.1's CensusTool trap a second time, in a second place, and invisible on
symmetric subjects for the same reason.

**The pre/post split is real in vanilla and the arbiter never uses it.** Blockbench's exporter has
no notion of `preTarget`: for a keyframe with a second data point it emits a twin keyframe at
`t + 0.001`, and for `step` interpolation it emits one at `next.t - 0.001`. So §9.1's format is
strictly *more expressive* than the thing it converts from, and phase 4 owed a decision it should
not make casually: project the twin-keyframe idiom into `pre`/`post` (tidier, but the plugin is
then interpreting, which §1 forbids), or copy the arbiter's twin keyframes verbatim (uglier,
matches "converts file formats, never interprets"). The §1 rule argues for copying.

**(SETTLED 2026-08-26 — and §1 argues the other way, see §9.6 decision 2. The twin keyframe is the
codec working around its own TEXT TEMPLATE, which cannot spell `preTarget`; copying it would invent
the number 0.001 and lose which keyframes were authored. `pre`/`post` is the field-for-field copy,
and it is the only one of the two that expresses `step` exactly.)**

### 9.2 The one interpreter, again

`PreviewModels` parses `animations` into `AnimationDefinition`s and bakes them against the model's
own root (`definition.bake(root)`). Bake validates bone names and **throws on an unknown bone** —
that throw is caught into the same error surface as bad geometry (§4.2): error model + the message
on `stage_entity`'s parse status, never a render crash. The renderer drives the baked
`KeyframeAnimation` from the synched clip fields: looping play from an `AnimationState` started at
stage time, or a frozen `apply((long)(clip_time * 1000), 1.0)` for scrubbing. `stage` gains `clip`
and `clip_time`; re-staging with a different `clip_time` is how an agent steps through a clip
without a timeline UI.

A **walk driver** (`applyWalk` off real locomotion) is deliberately out: the preview entity does
not locomote. A walk cycle is judged as a looping clip in place — which is also how vanilla's own
keyframed walkers author theirs.

### 9.3 Verification at animated poses  **(REVERSED by §9.6 decision 3)**

> The section below proposes posing the samples with Blockbench's own evaluator. Phase 4 reversed
> it: the plugin samples by VANILLA's rules, because the game is the authority on the pose being
> judged and because a Blockbench-dependent arm is one the harness can never cover. The two
> evaluators genuinely disagree — §9.6 names where.


The standing rule from the corridor work: intermediate animation keyframes are untested geometry.
`action:'verify'` therefore samples every clip at each authored keyframe timestamp **plus
midpoints between adjacent keyframes**, and runs the full SAT + shared-plane table at every
sample. Posing for these samples uses **Blockbench's own timeline evaluator** (scrub, read
effective bone transforms) — the plugin never implements CATMULLROM itself, so there is no second
interpolation math to drift from either side's.

### 9.4 Promotion

Clips promote inside the same interchange file. A consumer has two honest options, stated in the
panel: parse the format at runtime into the same public records (the mapping is 1:1; a consumer's
loader is small and its own), or a later plugin-side codegen step that emits an
`AnimationDefinition.Builder` chain as Java text for mods that want zero runtime parsing. Codegen
is v2, recorded here as a decision.

### 9.4a The corpus problem, which is total this time

§7.1's finding 1 was that no `.bbmodel` in this workspace uses cube rotation, inflate or mirrored
UV. For animation it is not a gap but a vacuum: **all seventeen sources carry zero animations**, so
phase 4's exporter has no real subject whatsoever and the first fixture must be *authored*, not
found. Worse, the model phase 3 vendored as the travelling arbiter -- `space_narwhal` -- has **no
groups at all** (seven cubes at the outliner root, which is why §7.2's click reported `parts: 1`),
so it cannot host a bone animation even in principle. Of the seven entity sources only
`corridor_spider` has real depth (23 cubes, 20 groups, 3 levels); `space_ghast` and `space_narwhal`
have no bones, and the rest are 3-8 groups at depth 1-2. Phase 4 needs a hand-authored animated
fixture that travels with the harness, built on a bone hierarchy rather than retro-fitted onto the
narwhal.

**(DONE 2026-08-26.** `blockbench/fixtures/animated_rig.bbmodel` — authored in a live Blockbench and
saved through `Codecs.project.compile()`, so it is genuinely Blockbench's own output and therefore
arbitrates the FILE SHAPE as well as the conversion. Three bones at depth 3, deliberately
asymmetric, and it carries the whole vocabulary in one clip: linear, catmullrom, `step`, a
two-data-point keyframe, and all three channels. Its geometry is arranged so that **the rest pose is
clear and a mid-swing pose is not** — the arm passes through the torso between two clean keyframes,
which is §9.3's entire premise made into a subject that fails when the sampler is wrong.)

### 9.5 Phasing

Animation is **phase 4** — it needs phases 1–2 (geometry loop) landed first, and the format is
designed so shipping v1 with `format: 1` files loses nothing: a format-1 file is a format-2 file
with no `animations` key.

### 9.6 What phase 4 settled, and what it found (BUILT 2026-08-26, toolkit 0.92.0 / plugin 0.2.0)

Phase 4 arrived owing three decisions §9 had deliberately left open. All three went to the arbiter
rather than to taste, and **two of them came back against this document's own lean.**

**1. Keyframe values are stored in VANILLA's final units, not as authored.** §9.1 proposed storing
Blockbench's numbers and converting in the loader through `KeyframeAnimations`. That is half a
conversion: those helpers do only vanilla's half of the flip (`posVec` negates y), while negating x
on position and x,y on rotation belongs to Blockbench's exporter. A loader written from
`KeyframeAnimations.java` alone implements exactly half and **mirrors every animation's x
translation** — the §7.1 trap in a second place. §4.1 had already answered this for geometry ("every
trap lives here, once; the loader does no arithmetic at all") and the same answer is right here. The
plugin does the whole conversion; `PreviewModels` constructs `new Keyframe(t, pre, post, interp)`
with no arithmetic whatsoever, and the harness — which can walk the plugin and cannot walk the
loader — is where the flip is arbitrated.

**2. `pre`/`post`, not the arbiter's twin keyframes — and §1 argues FOR this, not against.** §9.1
read the "converts file formats, never interprets" rule as an argument for copying Blockbench's
`t + 0.001` twin. Reading both sides inverts it:

- Blockbench's document has the two-value concept natively (`kf.data_points[1]`), and so does
  vanilla (`Keyframe(t, preTarget, postTarget, interp)`). dp[0]→`pre`, dp[1]→`post` is a
  field-for-field copy.
- The twin keyframe is the codec working around **its own text template**: the `mojang` template
  only has `new Keyframe(%(time), vec, %(interpolation))` and literally cannot say `preTarget`. We
  are not writing Java text, so we do not inherit the limit.
- Copying twins would **invent the number 0.001**, which is nowhere in the document, and would lose
  which keyframes were authored. That is the interpretation.
- The semantics are identical either way: Blockbench's `Keyframe.getLerp` leaves on data point 1 and
  arrives on data point 0; vanilla's LINEAR reads `keyframes[prev].postTarget()` →
  `keyframes[next].preTarget()`. Same rule, different spelling.

**`step` is the case that decides it.** Vanilla has no step interpolation, and pre/post expresses
one *exactly* where the twin only approximates it: writing the held value into the next keyframe's
`pre` and forcing that segment LINEAR makes vanilla lerp held→held, a flat segment with the jump
landing on the keyframe. The codec's `next.t - 0.001` twin instead ramps across the final
millisecond. The one residue, recorded rather than hidden: at *exactly* the next keyframe's
timestamp vanilla still reads `pre`, so it shows the held value at that single instant. One point of
a continuous function against a whole interval of ramp.

Note the constraint that forces the "force LINEAR" half: **CATMULLROM ignores `preTarget`
completely** (it reads `postTarget` for all four control points), so a `pre` on a smooth keyframe is
silently dropped by vanilla. Blockbench agrees — its step branch is checked *before* its catmullrom
branch, so a step beats a smooth neighbour there too.

**3. §9.3 is REVERSED: the plugin samples poses itself, by vanilla's rules.** §9.3 wanted
Blockbench's own timeline evaluator to pose the samples, "so no second catmullrom exists". Reading
both evaluators inverts the argument twice over.

*It picks the wrong authority.* The pose that matters is the one **the game** renders — that is what
an author judges, and where a mid-clip collision would actually be a collision. Measured against
that, Blockbench's evaluator IS the second implementation, and a demonstrably divergent one (see
below). Sampling through it would check poses the game never takes.

*And it would be permanently dark.* `mcptoolkit_entity.test.mjs` exists because the exporter is a
pure function of a document, testable with no Blockbench at all — the discipline §7.3 protected with
a travelling fixture. An arm needing a live Blockbench is an arm the harness cannot cover, and §7.2
already caught one of those pretending to be covered. So the sampler is vanilla's
`KeyframeAnimation.Entry.apply` transcribed, and the harness arbitrates it with a **second,
independent transcription** plus fixtures whose expected penetration depth is computed from first
principles — never a golden number.

#### The two places the timeline and the game genuinely disagree

Found by reading both evaluators, and **warned about rather than silently repaired**, because the
whole premise of the loop is that the game is the judge. Blockbench's own codec has both mismatches
too, so this is not a defect in either tool — it is a fact modders inherit.

1. **Mixed interpolation shifts by one keyframe.** Blockbench smooths a segment when *either* end is
   catmullrom (`before.interpolation === catmullrom || after.interpolation === catmullrom`); vanilla
   asks only the segment's LATER keyframe (`nextFrame.interpolation()`). So a catmullrom→linear
   segment is a curve in the timeline and a straight line in the game.
2. **The loop seam.** Blockbench WRAPS the catmullrom control points around a looping clip
   (`before_plus = sorted.at(-2)`); vanilla CLAMPS them (`Math.max(0, prev - 1)`). A loop is
   therefore smoother at the seam in the timeline than in the game.

#### The one thing the animated check cannot measure exactly

`verify` walks oriented boxes. A part's own scale stays an oriented box (it is applied inside the
part's own frame, after its own rotation), but **an ancestor's non-uniform scale reaching a rotated
descendant is a shear**, and a sheared box is not an oriented box at all. That exact condition is
detected and named in the report rather than approximated silently; every other case is exact.

Two smaller decisions worth their line: the animated arm reports **overlap only** — a pair sharing a
plane for one frame of an arc is not a z-fight worth an author's attention, and one that shares it
for the whole clip already shows in the rest table — and it reports the **deepest sample per pair
per clip**, because a limb swinging through a torso overlaps at every sample around the crossing and
twelve rows describing one collision is the "full table nobody reads" failure in a new dimension.

#### The manifest bill, per §10's standing rule

`stage_entity` gained `clip` and `clip_time`. **Measured on the live `/tools`, not estimated:
2,285 chars ≈ 714 tokens/turn**, up from 606 — **+108/turn**. The split is the shape Finding 7
predicts: description +168 chars, **schema +177**, so the schema is again the bigger half of an
addition that reads like a description change. Still zero for `standard`, `play`, `survey` and
`survival`, which do not carry the tool at all.

**And the measurement had a trap in it worth more than the number.** A first read of
`JSON.stringify(entry)` gave 2,377 chars / 743 tokens, which would have been recorded as +137 —
27% above the truth. Finding 7's "whole entry" is **description + schema** (769 + 1,171 = 1,940,
exactly), and `JSON.stringify` adds the `name`/`description`/`inputSchema` wrapper on top. Two
measurements of "the entry" that differ by a 92-char envelope are not comparable, and the delta
between them is meaningless. **State the boundary of an entry before quoting a delta against an
older one** — the older number cannot be re-derived later, so an incompatible definition silently
poisons the series.

## 10. Traps carried in from the record

- A registered entity type with no client renderer is a client crash that persists in the save —
  the preview entity ships type+renderer in one jar and is never persisted, but any future split of
  those must re-check this.
- `/reload` does not reload synced dynamic registries; the live *resource* pack path used here
  reloads fine, but the moment a consumer's promotion target is a dynamic registry (menagerie's
  `AuthoredSets`), the world must be re-entered — say so in the panel, as the divisions plugin does.
- A rejected Promise through `risky_eval` wedges Blockbench's MCP server: every headless action
  resolves `{ok:false,...}`.
- Fresh geometry vs. stale texture (or vice versa) in one reload: push both, reload once
  (`reload:false` per file + one `reload_resources`) — the sync plugin already does this; keep it.
- The manifest entry is a per-turn tax: measure `stage_entity`'s real entry size after build and
  record it in `TOKEN_PER_TOOL_FINDINGS.md`. **(DONE twice — Finding 7 at 0.90.0 (606 tok) and
  Finding 7b at 0.93.0 (714). 7b adds the rule the second measurement needed: state the BOUNDARY of
  what you measured next to the number, because a delta between two different definitions of "the
  entry" is meaningless and cannot be spotted from inside the table.)**
