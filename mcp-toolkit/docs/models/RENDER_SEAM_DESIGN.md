# The render seam — giving the headless build tool an eye

Status: **EVERY PHASE IS BUILT AND LIVE-GREEN. This design is finished** (toolkit 0.113.0,
2026-08-31). Phases 2 and 5 landed at 0.102.0 (§11), phases 1 and 4 at 0.105.0 (§12), phase 3 at
0.108.0 (§13), and §6's last line — put the subject in the studio and photograph it there — at
0.113.0 as the **`studio` tool** (§14), which is where §6 turned out to be wrong about *which entry*
it belongs on. Read §12.2 first if you are using anything above as a specification: the vanilla
panorama recipe this whole design was built on is incomplete in 26.2, and incomplete in a way vanilla
itself can never notice. §9's central unverified claim — `skybox:"none"` plus a white
`visual/fog_color` gives a uniformly white frame — **is a fact measured off a decoded PNG**, with a
black wall in front of the same camera as its falsifier. Nothing in this document is owed except the
two judgement calls §14.6 names.

The original status line, kept because everything below §11 was written under it:

> **DESIGN ONLY. NOTHING BUILT.** Investigated 2026-08-26 against toolkit 0.101.0 /
> mcp-server 0.44.0 and the decompiled MC 26.2 source in `vanilla-src/`. Every vanilla claim below
> carries a `file:line` and was read, not remembered; every claim about this repo was checked against
> the tool table (91 registered names) rather than against a doc. What is NOT verified is marked as
> such in §9. **§10 is a second pass** (same day): the seam is a hand for a human as well as an eye
> for an agent, which settles one open decision and changes three others — amendments are marked
> **(§10)** in place rather than rewritten over.

Companion docs: `STRUCTURE_AUTHORING_DESIGN.md` (the build half this is the eye for),
`ENTITY_AUTHORING_DESIGN.md` (`stage_entity` is the pattern this generalises — read §5.1 first),
`LIVE_MODDING.md` (the push loop), `RELEASE_1.md` §D4 (worldgen iteration, which this touches and
does not solve).

## 1. What this is, and what it is not

The toolkit builds headlessly. `set_blocks`, `place_shape`, `place_shapes`, `place_structure`,
`capture_structure`, `push_data` — an agent can author a building, save it as datapack content and
verify cell-by-cell that what stands there is what the file says, **without anything ever having
looked at it**. That is the deliberate design and it is not in question.

What is missing is the other half of authoring. A structure that passes `place_structure
{compare:true}` with `match` on every cell can still have a roofline that does not read as a roof,
a material palette that goes muddy at distance, a doorway whose proportion is wrong, or a silhouette
that disappears against its own terrain. **None of those are facts about blocks. They are facts
about how the thing looks**, and the only instrument that answers them is a rendered image.

This design gives the toolkit a **camera**: put a viewpoint anywhere, at any orientation, at a
chosen resolution, render the level out of band, and hand the result back as a file — optionally
against a blank white canvas that strips out everything that is not the subject.

**(§10)** It also gives the toolkit a **hand for a human**: the same canvas is a place to open a
`.nbt`, edit it by hand with the game itself as the editor, and close and save it back. §10 is that
loop; it was written second, it changes three decisions above, and it can be built *before* the
camera. The camera and the hand share the canvas, the frame and the save path, which is what makes
§10.7 possible.

What it is **not**:

- **Not a verification instrument, and it must not be described as one.** `place_structure`'s
  `compare` and `stage_entity`'s `parse` exist so that *facts* are answered by structured reads. A
  picture is not how you learn a template failed to load. §5 draws this line properly — it is
  narrower than an earlier draft of this investigation claimed.
- **Not a screenshot tool.** `screenshot` already exists and captures the live window from wherever
  a human happens to be standing. This is the opposite: nobody is standing anywhere, and the frame
  is an argument.
- **Not worldgen iteration** (`RELEASE_1.md` §D4). It can *look at* a chunk; it cannot regenerate
  one, reset a region, or spin a world at a seed. It makes §D4's loop cheaper to inspect and leaves
  §D4 open.
- **Not a video or animation surface.** One frame per call. `stage_entity`'s `clip_time` already
  covers "freeze a pose and look at it"; an orbit is N frames, not a movie.

## 2. The loop, in one paragraph

Build something headlessly, anywhere. Ask for a look: give a subject (a region, a structure id, a
position) and a viewpoint (a direction, or an orbit). The toolkit stages a camera, renders the level
out of band at whatever resolution you asked for, writes a PNG to disk and returns the path. If you
asked for a canvas, the subject is placed first into `mcptoolkit:canvas` — a flat void dimension
with no sky, white fog and flat full-bright lighting — so what comes back is the building and
nothing else. The path goes to the session, to a subagent, or into a `review` ask for a human. Fix,
re-place, look again.

## 3. What exists, and the four gaps

**Exists, and is more than expected.** The `authoring` profile (`mcp-server/index.mjs:299`) already
groups write → read-back → datapack-content → *"see it, and know where 'it' is"*, and that last
group is `screenshot`, `screenshot_annotated`, `get_world_info`, `ping`, `launch_game`, `get_log`.
The build side is complete. `stage_entity` (`preview/PreviewTools.java`) is the precedent for staging
a subject so the game's own renderer is the judge.

**The gaps.** All four were established by enumerating every registered tool name, not by reading
docs:

1. **No camera.** `screenshot` (`client/UiTools.java:152`) grabs `mc.gameRenderer.mainRenderTarget()`
   — whatever is on the window. `grep -rn "setCameraEntity\|CameraType\|freeCamera" src/main/java`
   returns **zero hits**. Framing is entirely a property of where a human left the client.
2. **No way into a world.** `launch_game` boots the client and `tools/rebuild.ps1` gates on `ping`,
   which a client answers **at the title screen** (that weaker gate is deliberate and documented in
   the script). Getting into a world is a human click. `build.gradle:1483` already has
   `-PjoinServer` → `--quickPlayMultiplayer`; the singleplayer twin does not exist.
3. **No canvas.** Nothing neutral to look at a subject against.
4. **No file out.** `screenshot` writes a temp PNG, base64s it and **deletes the file**
   (`client/UiTools.java:157-166`). The pixels can only ever land in the conversation: a subagent
   cannot be handed them, a review ask cannot carry them, and every look is a full-resolution tax on
   the transcript.

## 4. The mechanisms

### 4.1 The out-of-band render — Mojang already wrote it

> **CORRECTION (§12.2, 2026-08-28): this recipe is INCOMPLETE and copying it gives a black world.**
> `GameRenderer.render` does two more things between `extract` and `renderLevel` — it writes
> `globalSettingsUniform` (which carries the camera position chunk sections are drawn relative to) and
> uploads the lightmap. The panorama omits both and gets away with it only because it shoots from the
> player's own head. Read §12.2 before using anything below as a specification.

`Minecraft.grabPanoramixScreenshot` (`vanilla-src/net/minecraft/client/Minecraft.java:2700`) is the
recipe, in vanilla, through public methods:

    save window size, player xRot/yRot/xRotO/yRotO
    gameRenderer.setRenderBlockOutline(false)
    camera.enablePanoramicMode()
    window.setWidth/setHeight(N); target.resize(N, N)
      per view: set yRot/xRot AND yRotO/xRotO   (so nothing interpolates)
                gameRenderer.update(DeltaTracker.ONE)
                gameRenderer.extract(DeltaTracker.ONE, true)
                gameRenderer.renderLevel(DeltaTracker.ONE)
                Screenshot.grab(folder, name, target, downscale, cb)
    finally: restore everything

All four render entry points are public: `update` (`GameRenderer.java:372`), `extract` (`:379`),
`renderLevel` (`:524`), `setRenderBlockOutline` (`:196`).

Two consequences fall out for free, and both are worth stating because they remove work that looks
necessary:

- **The HUD is excluded by construction.** `renderLevel` renders the level only; the HUD is drawn in
  `render()` from `guiRenderState`. There is nothing to hide — which is fortunate, because 26.2 has
  no `options.hideGui` field at all (`grep -rn hideGui vanilla-src` finds only a
  `ScreenEffectRenderer` parameter). An out-of-band render is clean by default.
- **Resolution is an argument, and so is the token bill.**
  `Screenshot.takeScreenshot(target, downscaleFactor, callback)` already exists
  (`Screenshot.java:79`). Render large, downscale on the way out, and the cost of a look is a number
  the caller chose rather than a property of the human's monitor.

For a viewpoint that is not the player's head, `Minecraft.setCameraEntity(Entity)` is public
(`Minecraft.java:2623`) and `Camera` takes its position and rotation straight off that entity's view
angles (`Camera.java:258-262`). Either route works; the panorama recipe drives the player directly
because that is what vanilla had to hand.

**What this costs.** It resizes the real window and mutates the real player's rotation. Every field
must be restored in a `finally`, and a throw mid-render leaves the game visibly wrong — a state the
tool must be able to report rather than leave for the human to discover.

### 4.2 The blank canvas is two JSON fields

This is the find of the investigation, and it is a 26.2 fact that did not hold in earlier versions.

`DimensionType` is now a record carrying **`skybox`** — a three-value enum `none | overworld | end`
(`world/level/dimension/DimensionType.java:140`, codec at `:98`) — and an
**`EnvironmentAttributeMap`** of data-driven visuals: `visual/fog_color`, `visual/sky_color`,
`visual/fog_end_distance`, `visual/sun_angle`, `visual/star_brightness`, `visual/sky_light_color`
and more (`world/attribute/EnvironmentAttributes.java`).

And the join between them, at `client/renderer/LevelRenderer.java:203`: the frame graph's clear pass
clears the main render target **to the fog colour**. The sky pass is then skipped entirely when
`skybox == NONE` (`:207`, `:328`).

So:

- `skybox: "none"` — no sun, no moon, no stars, no sky disc, no dark void disc.
- `attributes: { "visual/fog_color": <white> }` — the background *is* that white.
- `"visual/fog_end_distance"` pushed far out — the subject keeps its true colours instead of fading
  into the background.
- `ambient_light: 1.0`, `has_skylight: false` — flat, shadowless, full-bright studio lighting with no
  day/night and no weather (`Level.canHaveWeather()` at `Level.java:940` requires skylight).

**A dimension, not a world.** `MinecraftServer.createLevels()` iterates the datapack-loaded
`LEVEL_STEM` registry and builds a `ServerLevel` for every entry
(`server/MinecraftServer.java:427,469`). A `data/mcptoolkit/dimension/canvas.json` shipped in the
mod's own `src/main/resources` therefore becomes a real level **in every world the toolkit loads
into, existing saves included** — and `place_structure` already takes a `dimension` argument. The
canvas needs no new world, no world creation, and no restart beyond the one the mod already needs.

**It cannot be pushed.** `push_data`'s own description says it: worldgen data is read at world load
and does not hot-reload. The canvas ships in the mod. `push_data {dry_run:true}` can still *validate*
a candidate dimension_type against the game's own codec without a restart (0.100.0), which is how you
iterate on the JSON without paying four minutes per typo.

### 4.3 Opening into a world

`WorldOpenFlows.openWorld(String levelId, Runnable onCancel)` is public
(`client/gui/screens/worldselection/WorldOpenFlows.java:302`), reached through
`Minecraft.createWorldOpenFlows()` (`Minecraft.java:1966`). A client sitting at the title screen with
the bridge live can therefore be told to open a world **over the bridge** — which is strictly better
than a launch argument, because it works on a client that is already running and does not require a
relaunch cycle to change worlds.

The launch-argument route exists too and is three lines: `Main.java:91` accepts
`--quickPlaySingleplayer`, and `build.gradle:1477-1483` already does exactly this shape for
`-PjoinServer` → `--quickPlayMultiplayer`. Build both; they answer different questions ("get into a
world now" vs "boot straight into one").

### 4.4 The way out is a file

`push_asset`'s description already states the principle in the other direction — *"prefer this for
files already on disk; it keeps the bytes out of the conversation."* The mirror is a **file output**:
write the PNG, return the path, and return the image inline only when the caller asks for it.

This is not only a token argument, though the token argument is real (a full-resolution PNG is the
single most expensive thing this toolkit can put in a transcript). It is what makes the other two
destinations possible at all:

- **A subagent** can be handed a path and asked "does this read as a cathedral"; it cannot be handed
  a base64 blob out of the parent's transcript.
- **A review ask** stages a scenario by running setup commands (`review/ReviewWalk.java`) and files a
  human's verdict. An ask can carry a path. It cannot carry an image.

## 5. Taste is the point, and the record does not argue against it

An earlier draft of this investigation claimed a tension with the repo's philosophy and cited two
lines to support it. Both citations were about something narrower, and the tension was invented.

What the record actually refuses is **pixels as an oracle for facts**:

- `place_structure`'s `compare` exists because "did what got built match the file" is *"the one thing
  screenshots cannot tell you"* (`StructureTools.java:91`). That is a claim about a cell-by-cell
  diff, not about looking.
- `stage_entity`'s `parse` exists so broken geometry is a structured verdict rather than *"noticing a
  magenta cube in a screenshot"* (`preview/PreviewTools.java:60`,
  `probes/entity-preview.test.mjs:17`). That is a claim about error reporting, not about looking.

Neither says anything about **"does this look nice"** — and neither could, because there is no
structured read anywhere in this toolkit that answers it. Every entity-authoring loop the repo has
ever run ends with a human or an agent looking at the thing; `stage_entity` was built so that the
looking would happen against the *game's own renderer* rather than against a Blockbench preview. The
whole point of that tool is that the final judgement is visual. So is this one's.

The line is therefore: **a rendered image is the right instrument for judgement of appearance and the
wrong instrument for determination of fact.** The tool's description should say what it is for
(proportion, silhouette, palette, how the light falls, whether it reads at distance) and point at
`compare` for the other question — not as a warning, but as routing.

## 6. The bridge surface: one tool entry

The manifest tax rules apply hard here (`TOKEN_PER_TOOL_FINDINGS.md` findings 4-6, the `place_shapes`
lesson, and §D2's measured result that a second question about an existing argument list is far
cheaper than a new line). Four tools — camera, canvas, open-world, orbit — would be four entries
re-read on every turn of every session that carries them. This is **one entry with one field table**,
the `stage_entity` shape:

    render
      op:        view | orbit | canvas | clear
      at:        camera position, OR
      look_at:   a position/region/anchor the camera frames automatically
      yaw,pitch: explicit orientation (mutually exclusive with look_at)
      distance:  for look_at / orbit
      frames:    orbit only — N shots around the subject
      dimension: default the subject's own
      width, height, downscale: the resolution and the bill
      out:       a path to write; omit for the toolkit's own scratch dir
      inline:    return the image in the reply too (default FALSE)

- `op:"canvas"` places the subject into `mcptoolkit:canvas` first (through the `place_structure`
  machinery that already exists) and renders it there. `op:"clear"` empties the canvas.
  > **CORRECTION (§14, 2026-08-31): these two are NOT ops on `render`, and the reason is a rule this
  > section did not weigh.** `render` is `mechanism:"observe"` and it is on the `inspect` profile's
  > keep-list — the read-only role whose claim is *checked per name against the live manifest's
  > mechanism*. Staging writes blocks and teleports a player. Hung off an observe-tagged entry, the
  > read-only inspector could edit the world with every check in the repo still green. They ship as
  > the `studio` tool (`world_edit`), which is this section's own reasoning for `open_world` applied
  > to the case it got wrong — and it costs less than it looks: because the picture stays `render`'s
  > job, the new entry is three fields (483 tok/turn, measured) rather than a second copy of the
  > camera's field table.
- `op:"orbit"` is the contact sheet — N frames around one subject, the same idea as `stage_entity`'s
  `spin`, resolved into stills instead of a turntable.
- **`inline` defaults to false.** The reply is a path, a resolution and a byte count. That is the
  0.100.0 / §D2 discipline applied to the most expensive payload in the toolkit.
- **(§10)** The human loop adds `op` values to this same entry — `edit`, `save`, `cancel` — rather
  than a second manifest line. They share this field table (`at`, `dimension`, the subject), and a
  second question about an existing argument list is the cheap kind (§D2, Finding 12). §10.6.

Opening a world is a **separate, tiny entry** (`open_world`) rather than a fifth `op`, because it is
not a rendering verb, it is reachable when there is no world at all, and it belongs beside
`launch_game` in the dev-only set — not in `authoring`.

Profile placement: `render` into `authoring` and a new `render` profile; `open_world` into the
`DEV_ONLY` list beside `launch_game`. Both hidden everywhere else. **The manifest bill is not
measured yet** — see §9.

## 7. Build order

Each phase has an arbiter that can fail, per the standing rule that a phase whose only product is a
screenshot is a phase that may as well not exist.

**Phase 1 — the out-of-band render.** `render` with `at`/`yaw`/`pitch`/`width`/`height`/`downscale`,
writing a file. No canvas, no orbit, no `look_at`.
*Arbiter:* a probe that renders the same fixed scene twice at different resolutions and asserts the
PNGs decode, differ in dimensions, and are **not** the window's size — plus a render whose `finally`
is forced to run (throw injected) followed by an assertion that window size and player rotation came
back. A restore path with no falsifier is a restore path that will silently stop working.

**Phase 2 — the canvas.** Ship `mcptoolkit:canvas` (dimension + dimension_type + biome) in the mod's
resources; add `op:"canvas"`. **BUILT — the dimensions at 0.102.0 (§11), the staging at 0.113.0 as
the `studio` tool rather than an `op` (§14.2).**
*Arbiter:* a probe that renders an empty canvas and asserts the frame is **uniformly the configured
colour** within tolerance. This is the check that catches every trap in §8.5-8.7 at once: a biome
overriding the fog, void darkening near `minY`, a stray sky pass. Assert against the colour the
dimension file *declares*, never against a constant baked into the test — the `place_shapes` lesson
about a preview nobody compares against the live run.

**Phase 3 — framing and orbit.** `look_at`, `distance`, `frames`. **BUILT at 0.108.0 — §13. The
arbiter below is what found the `settled` defect in phase 1 (§13.3).**
*Arbiter:* a subject of known bounds framed automatically; assert the rendered subject's bounding box
in pixels sits inside the frame with margin, at several `distance` values and **at more than one
subject size**. Framing that is right for one size and wrong for others is the obvious failure and
one size cannot catch it.

**Phase 4 — `open_world`, and the `-PopenWorld` launch twin.**
*Arbiter:* from a title-screen client, `open_world`, then `ping` reporting a loaded level, then a
`render` that succeeds — the whole cold path with no human click in it, which is the actual claim.

## 8. Traps

Carried in from the record:

1. **Never `gradlew build` while the dev game runs** — the jar lock. Use `tools/rebuild.ps1`.
2. **A check whose failure mode is "delete the restriction to go green" needs a falsifier every
   time.** Phase 2's uniform-colour assertion is exactly that shape — a tolerance widened until it
   passes is a test that has stopped testing.
3. **A probe that only ever ran one way is coupled to it.** `render` must have a defined answer on a
   dedicated server (no client, no framebuffer) and it must be *asserted*, not skipped — the same
   rule `stage_entity`'s `no_client` follows.
4. **Price the whole entry, not the description.** The schema was the bigger half last time.

Found in this investigation:

5. **Biome attributes layer over the dimension's.** `EnvironmentAttributeSystem.addBiomeLayer`
   (`world/attribute/EnvironmentAttributeSystem.java:73`) installs a positional layer for every
   attribute *any loaded biome* provides, applied on top of the dimension's constant layer. A canvas
   using `minecraft:plains` gets plains' fog colour. **The canvas needs its own biome**, and it should
   set the visual attributes explicitly rather than relying on inheritance-by-absence.
6. **Void darkness eats the white, and the amount depends on the generator.** `computeFogColor`
   darkens toward black within `voidDarknessOnsetRange` of `minY` — which is **1.0 when the level is
   flat and 32.0 when it is not** (`client/multiplayer/ClientLevel.java:1269`,
   `client/renderer/fog/FogRenderer.java:110`). A flat canvas generator makes this a non-issue; a
   noise-generator void canvas fades grey for 32 blocks and the cause is invisible from the picture.
   `isFlat` also moves the horizon to `minY` (`ClientLevel.java:1265`), suppressing the dark disc.
7. **A minimized window DOES render — this trap was wrong, and it cost a battery 21 reds.**
   Written as: `Minecraft.java:1243` gates the whole render on `!surfaceIsInvalid &&
   !window.isMinimized()`, so minimized silently yields a stale frame, which must be a refusal.
   Measured 2026-09-07 (toolkit 0.134.0): the gate wraps only the ACQUIRE of the window surface
   (and the present that follows); update, extract and `GameRenderer.render` still run every
   frame, throttled to 10 fps by `FramerateLimitTracker` while iconified, and the out-of-band
   pass here never touches the surface at all — it draws into the main render target and copies
   the pixels out of it. With the window iconic, `render` at a new heading came out at the new
   heading, and `screenshot` moved when a screen was opened. The refusal is gone; the reply says
   `window_minimized:true`. What an iconified window DOES lose is the POINTER: GLFW reports the
   window 0x0, `Window.onResize` stores it (`Window.java:311`), and
   `MouseHandler.getScaledXPos` divides by it (`MouseHandler.java:335`), so every screen renders
   with its mouse at infinity and no hover face or tooltip appears — which is the one red in that
   battery that was real (ui-conform's TOOLTIP-static, 0 px). `ScreenSpaceMixin` falls back to
   the framebuffer size, which the window keeps, in exactly the zero case; `ScreenSpace` is the
   record.
8. **`renderLevel` dereferences `minecraft.player`** (`GameRenderer.java:527`, and the portal/nausea
   reads at `:543`). There is no rendering without a local player, whatever the camera entity is.
9. **The worldgen registries cannot be pushed** (`push_data`'s own documented limitation), so canvas
   iteration is a restart loop unless `dry_run` validation is used first.
10. **A probe file owns the player's DIMENSION, not only its site.** Reads given no `dimension`
    answer about the dimension the player is standing in, so a file that moves the human and does not
    move them back redirects every later probe's reads into whatever it left them in. Found at
    0.105.0 (§12.7): `predicates` and `player-hands` went red in a battery over a teleport in a file
    they share nothing with. `site-map.test.mjs` compares coordinates and cannot see this.
11. **Quote `-Pkey=value` in PowerShell** — an unquoted `-PopenWorld=New World` splits, and so does
    anything containing a dot.

## 9. Open decisions and unverified claims

Decisions, both genuinely open:

- ~~**Does `mcptoolkit:canvas` ship in the mod for everyone, or is it generated per workspace?**~~
  **SETTLED by §10: shipped, and there are two of them** (`studio` and `workshop`, §10.5). A
  human-facing feature cannot be absent at the moment someone reaches for it, and the alternative the
  earlier villagejobs design used — delete and recreate a save per session — is the one thing this
  loop must never do (§10.4). The per-world cost of two idle `ServerLevel`s is still worth measuring,
  but it is now a tuning question, not a design fork.
- **Does `render` belong in the `authoring` keep-list?** It is the point of the profile, and it is
  also the most expensive entry that list would carry. Decide against a measured number, not a
  feeling.

Unverified — do not repeat these as facts until a live run says so:

- ~~**The manifest bill of `render` and `open_world`.** Estimated, not measured.~~ **`render`
  MEASURED at 0.108.0: 4,287 chars / ~1,071 tok per turn, the schema more than twice the
  description (§13.4). `open_world` is still estimated.**
- ~~**That `skybox:"none"` plus a white `visual/fog_color` produces a uniformly white frame.**~~
  **VERIFIED 2026-08-28** (§12.4): the empty studio decodes as `#FFFFFF` on every sampled pixel, and a
  black wall in front of the same camera is the falsifier that stops "uniformly white" from being
  passed by a frame that never rendered.
- ~~**That a mod-shipped dimension appears in an existing save.**~~ **VERIFIED**, in its harder form,
  twice: §11.2 by the world datapack road, and again at 0.105.0 when `New World` — which had never had
  the canvas in it — gained the files on one start and the dimensions on the next.
- **Render cost and cadence.** Partly measured at 0.105.0: 12–90 ms for a 256²–384² frame from a
  camera near the player, 356 ms for a 60-block jump that spent all seventeen settle passes. What is
  still unmeasured is the effect on a running session's tick, and the cost at 4096².
- **(§10) The gizmo push seam.** `CuboidGizmo` and the collector's `setAlwaysOnTop`/`persistForMillis`
  /`fadeOut` are read and public; which entry point a mod uses to push one per tick
  (`LevelRenderer.addMainThreadGizmos(List)` at `:987`, or the per-tick collector behind
  `Minecraft.getPerTickGizmos()` at `:2901`) was **not** pinned down. Pick it at build time; the
  frame's existence does not depend on which.
- **(§10) That villagejobs' editor generalises cleanly.** Its slices were verified in July against
  that mod's own store and catalog. Nothing here re-ran them, and "the loop is proven" is a claim
  about *that* implementation, not about the port.

## 10. The human loop — `nbt → open → edit → close and save` **(added 2026-08-26, second pass)**

Everything above frames the seam as an eye for an agent. It is also, and possibly more importantly,
**a hand for a human**: take a structure `.nbt`, open it in a live world, edit it by hand with the
actual game as the editor, then close and save it back to `.nbt`. That reframes the canvas from a
*backdrop* into a *workplace*, and three decisions above change because of it — marked **(§10)**
where they occur.

### 10.1 This was already built once, in the wrong place

The workspace has a live-verified implementation of this exact loop, and it is not in the toolkit.
`src/main/java/com/mattmc/villagejobs/build/` — `BuildingEditor.java`, `BuildingStore.java`,
`StructurePlacer.java` — plus `villagejobs/mcp/` were built 2026-07-18 and **slices 1, 2 and 4 were
verified end-to-end**: import a vanilla house → edit → save writes a real `.nbt` on disk, over both
`/vjimport`, `/vjedit`, `/vjsave` commands and an MCP bridge. Slice 3 (a title-screen browser opening
a managed void world) is built compile-only.

Two things follow, and they point in opposite directions:

- **The loop is proven.** It is not speculative; a human has round-tripped a building through it.
- **It is welded to the wrong host.** It writes to `<gamedir>/villagejobs/buildings/*.nbt`, folds
  results into that mod's `Catalog` under `USER_STYLE = "user"`, and lives in a **paused content
  mod**. Nothing outside villagejobs can use it, and the workbench split
  ([[workbench-split]]) exists precisely to stop general capability living inside one mod.

So §10 is not "build an editor". It is **generalise a proven editor onto tools the toolkit already
has**, and the honest measure of the work is how little is left over.

### 10.2 What already exists, and the three things that do not

| The loop's step | What answers it today |
| --- | --- |
| open — put the `.nbt` in the world | `place_structure` — and *better* than the original: `dry_run`, `undo_id`, and `compare` |
| the world to open it in | §4.2's canvas **dimension** (see §10.4 — this is a correction to the earlier design) |
| get a human into it | §4.3 `open_world` / `WorldOpenFlows`, plus a command |
| close and save | `capture_structure` — vanilla `fillFromWorld`, written into the live datapack, reloadable |
| where the `.nbt` lives | `push_data` / `list_data` / `clear_data`, with codec validation (0.100.0) |
| what changed | `place_structure {compare:true}` against the original |
| a human's verdict on it | the review layer (`review/ReviewWalk.java`) |

**Missing, and this is the whole build:**

1. **The session binding.** `capture_structure` requires `min` + `size` explicitly — *"both are
   required and neither is inferred — a piece captured one block off draws with a seam and nothing
   says so"* (`DataTools.java`, `capture_structure`). That is exactly right and must not change. What
   is missing is a **session that remembers them**, so a human's "save" is one word instead of six
   coordinates.
2. **A visible frame.** The bounds must be *seen* while editing or the human builds outside them.
3. **A human-facing surface.** A human does not call an MCP tool.

### 10.3 The one settled design point imported verbatim: the frame IS the contract

The earlier design settled this the hard way and wrote it down: *"Export bounds must be explicit —
use a visible, resizable build frame … else free edits clip on re-export."*

The failure mode is specific and quiet. If the capture box is inferred from the *template's own size*,
then the moment a human adds an eave, a chimney or a step one block outside it, the save silently
truncates and the loss shows up later as a seam. So: **the session's frame is the contract, the frame
is resizable, and `capture_structure` captures the frame — never the template's size.** The toolkit
tool already refuses to infer; the session must not undo that by inferring on its behalf.

**And the frame is now nearly free, which it was not in July.** MC 26.2 ships a first-class gizmo
system: `net.minecraft.gizmos.CuboidGizmo` is a record over an `AABB` with fill, stroke, stroke width
and **coloured corner strokes** (`gizmos/CuboidGizmo.java`) — i.e. a box that also tells you which way
X, Y and Z run, which is exactly what an author standing inside it needs. Collectors carry
`setAlwaysOnTop()`, `persistForMillis(int)` and `fadeOut()` (`gizmos/SimpleGizmoCollector.java:49-62`).
The earlier design's "Structure Block save-corner semantics or own markers" is superseded by a record
construction and a per-tick push.

### 10.4 A dimension beats a throwaway world — a correction to the earlier design

The July design opened each session by **deleting and recreating a save**:
`LevelStorageSource.createAccess(id).deleteLevel()`, then `createFreshLevel` with a void generator.
That was the right call with the tools available then. It is the wrong call now, and the canvas
being a **dimension** (§4.2) is strictly better on five counts:

- **No save churn and no delete.** Nothing destroys a directory to start work. A delete that runs at
  the wrong moment is the worst bug this loop could have.
- **No world-load wait**, and the human's real world stays open.
- **Several sessions coexist** at different origins in the same canvas.
- **The agent and the human are in the same place at the same time.** This is the actual prize.
  An agent can rough a structure in headlessly while a human walks around it; neither has to wait for
  the other to close a world.
- **It dissolves the earlier design's open question.** That design could not list vanilla structures
  to import "because the title screen has no server/registry". Once a world is open there *is* a
  registry, and `query_registry {registry:"structure_template"}` already lists every loaded template.
  The question was an artefact of opening the browser from the title screen.

### 10.5 Studio and workshop — the canvas needs two, and the human's is not white **(§10 changes §4.2)**

The white, skyless, shadowless, full-bright canvas of §4.2 is correct for photographing a subject and
**actively hostile to building in by hand**: no horizon to orient by, no shadows to read depth from,
no sun to tell you which way you are facing, and a fatiguing full-bright field to stare into for an
hour.

Because `EnvironmentAttributeMap` and `skybox` are properties of the **dimension type** — static data
read at world load, not runtime state — this cannot be a toggle. It is **two shipped dimensions**,
which is two more JSON files and no more code:

- **`mcptoolkit:studio`** — §4.2 exactly. `skybox: none`, white fog, `fog_end_distance` far,
  `ambient_light: 1.0`. For the camera.
- **`mcptoolkit:workshop`** — the place a human works. Flat void (so §8.6's void darkening stays at
  1.0), a neutral mid-grey background rather than white, a **fixed sun angle** via
  `visual/sun_angle` with `has_fixed_time` so shadows are stable and readable but never move, and
  enough ambient light that nothing is unreadably dark.

A session opens in `workshop`; `render` can place the same frame into `studio` for a shot. The frame
is the contract in both, so the round trip is unaffected by which one you are standing in.

### 10.6 The human's surface is commands, and it must be the same object

A human does not call `place_structure`. The toolkit already has the pattern for this and it is
`ReviewCommands` / `ReviewTools`, both thin over `ReviewWalk` *"so an ask answered in-game and an ask
read back over MCP can never disagree about what happened"* (`review/ReviewWalk.java`).

Same rule here. One `EditSession` object; a command surface and a tool surface both thin over it:

    /mcptk edit <structure id>      open it in the workshop, frame it, put me on the platform
    /mcptk frame <±dx ±dy ±dz>      resize the frame (it is visible the whole time)
    /mcptk save [id]                capture the frame -> .nbt (default: the id it was opened as)
    /mcptk cancel                   discard and clear
    /mcptk canvas list|clear        what is open, and put it away

The MCP side is **not a new manifest entry**. It is `op` values on §6's `render` entry — `edit`,
`save`, `cancel` — because they share that entry's field table (`at`, `dimension`, the subject) and a
second question about an existing argument list is the cheap kind (§D2, Finding 12). `open_world`
stays separate for the reason §6 already gives.

### 10.7 What this buys that nobody has today

Because both halves write through the same tools, the loop composes into something neither half
has alone:

> An agent roughs a structure in headlessly. A human walks into the workshop and fixes the
> proportions by hand. `save` writes one `.nbt`. Then `place_structure {compare:true}` against the
> original reports **exactly what the human changed**, cell by cell, in `set_blocks` syntax.

That is a *diff of a human's taste* — the thing an agent cannot derive and has never been able to
read back. It is also the honest answer to §5: the human supplies the judgement of appearance, and
`compare` turns it into a fact an agent can act on. The two instruments are not in competition; this
is the seam where one becomes the other.

### 10.8 Build order addition

**Phase 5 — the edit session.** `EditSession` (id, origin, frame, dirty flag), the `CuboidGizmo`
frame, the `/mcptk edit|frame|save|cancel` commands, the `render` ops, and `mcptoolkit:workshop`.
Depends on phase 2 (the canvas) and nothing else — **it does not need phases 1, 3 or 4**, so it can
be built before them if the human loop is worth more than the camera.

*Arbiter:* a probe that places a known template, mutates one cell **outside** the template's original
size, saves, and asserts (a) the saved `.nbt` contains the outside cell — the frame was captured, not
the template size, which is §10.3's whole point and the failure the earlier design hit — and (b)
`place_structure {compare:true}` against the original reports exactly that one difference and no
others. Plus a cancel that leaves the datapack byte-identical.

### 10.9 Traps specific to the human loop

11. **Do not auto-save on shutdown.** The earlier design exported on `SERVER_STOPPING`. That is a
    silent data path in both directions: a crash loses the edit with no message, and an accidental
    quit *overwrites a good file* with a half-finished one. Save is explicit; closing with a dirty
    frame is a refusal that says so.
12. **Two sessions at one origin is the probe-site collision again** ([[probe-site-ownership]], where
    concurrent files sharing a site produced a "dig timing" mystery that was not about digging).
    The canvas is shared, so origins must be **allocated**, not chosen by whoever asks.
13. **A human will place item frames, armour stands and paintings.** `capture_structure` defaults
    `entities:false` and `place_structure` cannot undo entities. The session must say which it is
    doing rather than quietly dropping a human's hour of work.
14. **Editing in creative means the human can fly out of the frame and keep building.** The frame is
    visible for exactly this reason; the save reply should report how many non-air cells sit
    *outside* the frame, so "I built past the box" is something the tool says rather than something
    the seam says later.

## 11. What was built — phases 2 and 5, toolkit 0.102.0 **(2026-08-27)**

Built in the order §10.8 said was possible: **the hand before the eye.** The canvas exists and the
human loop runs on it; nothing of the camera exists. What follows is the record of what shipped and,
more usefully, the five places where building it proved the design above wrong.

### 11.1 What shipped

| Piece | Where |
| --- | --- |
| `mcptoolkit:workshop`, `mcptoolkit:studio`, the canvas biome | `src/main/resources/data/mcptoolkit/{dimension,dimension_type,worldgen/biome}/` |
| Installing them where fabric-api is not | `canvas/Canvas.java` |
| The session: id, slot, origin, frame | `canvas/EditSession.java` |
| The visible frame | `canvas/CanvasFrame.java` |
| `/mcptk edit·frame·save·cancel·canvas` | `canvas/CanvasCommands.java` |
| The arbiter | `mcp-server/probes/canvas-edit.test.mjs` — 10 cases, live-green, 0 skipped |

`DataTools` grew three public delegates (`packRoot`, `ensurePack`, `captureBox`, `reloadPacks`) and
nothing else changed. **`save` is `capture_structure`**, called with the frame the session remembered
— not a second implementation of `fillFromWorld`.

### 11.2 The five corrections

**1. A mod-shipped dimension does not load here, and §4.2's central claim was conditional.** "A
`data/mcptoolkit/dimension/canvas.json` shipped in the mod's own `src/main/resources` therefore
becomes a real level in every world the toolkit loads into" is true on NeoForge and on a Fabric game
that happens to have fabric-api — and **false in this toolkit's own dev game**, which is loader-only
by policy. `McpToolkitTags` already records that rule for tags and answers it with a Java floor. *A
dimension has no Java floor.* The fix is a second road for the same bytes: `Canvas.install` writes
them into the live world datapack on every server start, where vanilla's own
`configurePackRepository` discovers and auto-selects them. **This turned out to be the stronger
result**: the design's unverified claim "a mod-shipped dimension appears in an existing save" is now
verified in its harder form — the dimensions appeared in this workspace's existing `run-server` world
with no fabric-api present at all. It costs one restart the first time, because worldgen registries
are read before the server exists, and `Canvas.absentMessage` is the refusal that says so.

**2. §8.6's answer to void darkness does not work.** "A flat canvas generator makes this a
non-issue" is wrong: `ServerLevel.isFlat()` returns `server.getWorldData().isFlatWorld()`, which reads
the **save's** `SpecialWorldProperty` (`PrimaryLevelData.java:276`) — a property of how the *world*
was created, not of the dimension's generator. A canvas inside a normal save is never flat by that
test however its chunks are made, so `voidDarknessOnsetRange` is 32.0 and the horizon is at y=63.
Both are cleared by one number instead of a rule: `min_y: -64` with the working plane at **y=64**.

**3. §8.5's answer to biome attributes is backwards, and the right one is simpler.**
`addBiomeLayer` installs a positional layer for every attribute *any loaded biome provides*, and at a
position it applies **that biome's** modifier over the dimension's constant layer. A biome that
provides nothing therefore falls straight through. So the canvas biome ships `"attributes": {}` and
sets no visual attributes at all — the opposite of "set them explicitly rather than relying on
inheritance-by-absence", and correct because absence is not inheritance here, it is a null entry.

**4. §9's open gizmo question, closed — with a caveat it did not anticipate.** The seam is
`Gizmos.addGizmo` (via `Gizmos.cuboid`) called from a server tick, and the collector window is
already open around it: `IntegratedServer.processPacketsAndTick` wraps `super` in
`Gizmos.withCollector`, and `LevelExtractor.extractGizmos` pulls the drained list into the next
frame. **But only on an integrated server.** `MinecraftServer` has no collector, so `addGizmo` throws
there, and `extractGizmos` reads only `Minecraft.getInstance()` and `getSingleplayerServer()` — a
gizmo pushed from a dedicated server could not reach a client even if one could be made. That is the
defined dedicated-server answer trap 3 asks for rather than a skipped case: `CanvasFrame.available()`
reports it, and every reply prints the frame's corners regardless. **The frame is an aid; the SESSION
is the contract, and the contract holds headlessly.**

**5. A command cannot both reload and answer.** `capture_structure` with `reload:true` returns a
future that completes a tick later, and by then a command's feedback collector has stopped listening:
the first `/mcptk save` wrote the file correctly and `run_command` reported an **empty output**. The
write is taken synchronously (`reload:false`) and answered synchronously; the reload follows and is
reported when it lands. This is a general fact about the command surface, not about this loop.

### 11.3 What §6 said about the bridge surface, and what was done instead

§6 puts `edit`/`save`/`cancel` on `render`'s `op` field. `render` does not exist, so a tool entry now
would have to be reshaped the moment it did — and `FakePlayerCommand` already wrote the rule that
applies: a server command is reachable from a probe through `run_command` at **zero manifest cost**,
which is what a capability under verification should cost. So phase 5 shipped with **no MCP entry at
all**. When `render` lands, its ops call the same methods the commands do, the `ReviewWalk`
arrangement — one object, two surfaces, and no way for them to disagree.

One design item was dropped rather than deferred: **`/mcptk canvas clear`**. "Put it away" over a
*shared* canvas means one person's command wiping another's frame, which is the same destructive
shape as the auto-save trap 11 forbids. Each session ends its own with `cancel`.

### 11.4 Still owed

- ~~**The camera.** Phases 1, 3, 4. Nothing of it is built.~~ **Phases 1 and 4 shipped at 0.105.0 —
  §12; phase 3 at 0.108.0 — §13. The camera is finished.**
- ~~**A pixel.**~~ **Taken.** The studio has been photographed and phase 2's uniform-colour arbiter
  exists and passes (§12.4). Everything below this line was written while the sentence "the studio
  has never been photographed" was true, and it was the only remaining test — as §11.5 had already
  found out the hard way.
- **The frame drawn in front of a human.** — **answered by §11.5, and it found two bugs.**
- **The workshop's own look.** A fixed 45° sun and mid-grey fog are a judgement about what is
  comfortable to build in for an hour, made without building in it for an hour. It is two JSON
  numbers to change. (The light is no longer one of them — see §11.5.)

### 11.5 The first human run — toolkit 0.102.1 **(2026-08-27)**

Somebody stood in the workshop. Two defects, and the thing worth carrying is that **neither was
reachable by anything this repo can check**: both are properties of a *rendered frame*, and the
camera — the instrument that would have caught them — is the half that is not built. §11.4's "nobody
has stood in the workshop" was not a footnote; it was the only remaining test.

**1. `ambient_light` is not the 26.2 light knob, and the default is BLACK.** The workshop was pure
black — silhouettes, nothing else — until torches went down. In 26.2 the lightmap is built by
`LightmapRenderStateExtractor` from *environment attributes*: `block_light_tint`, `sky_light_factor`,
`sky_light_color`, `ambient_light_color`. `DimensionType.ambientLight()` survives in exactly two
places, `Lightmap.getBrightness` and `LevelReader.getLightLevelDependentMagicValue` — the HUD
vignette and the gameplay magic value — and in neither does it light the world. So the dimension's
`ambient_light: 0.55` was doing nothing, and `visual/ambient_light_color`, whose own default is
**opaque black** (`-16777216`), was unset. *Unset is not "some sensible light"; it is none.*

The workshop now sets `#B4B4B4`. Vanilla's values are `0A0A0A` (overworld), `302821` (nether),
`3F473F` (end) — those are **night floors**, a dark tint under a skylight that does the real work.
The workshop has `has_skylight: false` by choice (§10.5: no night, no weather), so this attribute
*is* the light, and it is set an order of magnitude brighter for that reason. That is the trade the
no-skylight decision actually bought: no night, no weather, **and no shadows**.

`studio.json` already set `#FFFFFF` and was right — by accident. Its comment credited
`ambient_light: 1.0`; the comment is now corrected, since a right value with a wrong explanation is
the next session's bug.

**2. A gizmo carries no dimension.** The frame was drawn over the overworld as well — a white box
hanging above the spawn hills. `LevelExtractor` drains the collector into whatever level the *viewer*
is standing in; `CanvasFrame` pushed every open session's box unfiltered. There is no viewer to ask
on the server side, so the stand-in is the only one available: draw a session's frame only while
somebody is present in the level it belongs to. On an integrated server — by §11.2's third
correction, the only place a gizmo reaches a screen at all — that player *is* the viewer.

**The check that could exist, and does.** `canvas-edit.test.mjs` gains a **static** case: both
canvases must declare `visual/ambient_light_color`, asserted by reading the shipped JSON with the
game down. It cannot see a black room — only the camera can — but it can see the one input whose
absence guarantees one. That is the shape available whenever the real arbiter is a pixel: check the
*input the pixel cannot be right without*, and say in the test why the real check is missing.

## 12. What was built — the camera, phases 1 and 4, toolkit 0.105.0 **(2026-08-28)**

`render` and `open_world` exist, and the studio has been looked at. Nine live cases, zero skipped.
The useful part of this section is not the list of files; it is §12.2, where a recipe carried through
two passes of this design as settled fact turned out to be broken.

### 12.1 What shipped

| Piece | Where |
| --- | --- |
| The camera | `client/RenderTools.java` — one tool, `render` |
| The private frame resources vanilla does not expose | `mixin/client/GameRendererAccessor.java` |
| The cold path into a world | `client/LifecycleTools.java` — `open_world`, beside `quit_game` |
| The arbiter | `mcp-server/probes/render-camera.test.mjs` — 9 cases, live-green, 0 skipped |

Surface: `render` and `open_world` join `CLIENT_SURFACE`; `open_world` also joins `DEV_ONLY`. Both
are client-tier `callable:false` in the conformance ratchet, and both are asserted *hidden* from
`play` and `survival` — a camera and a world-loader are not things a body playing the world has.

### 12.2 The panorama recipe is incomplete, and vanilla cannot see it

§4.1 quotes `Minecraft.grabPanoramixScreenshot` and calls it "the recipe, in vanilla, through public
methods". It is a recipe for a **black world**. `GameRenderer.render` does two things between
`extract` and `renderLevel` that the panorama does not, both on private fields:

1. **`globalSettingsUniform.update(...)`** (`GameRenderer.java:411`) — a uniform buffer carrying,
   among other things, the camera's **integer position**. Chunk sections are drawn relative to it.
2. **`lightmap.render(gameRenderState.lightmapRenderState)`** (`:423`) — `extract` only *fills* the
   `LightmapRenderState`; this is the upload to the GPU texture every block face samples.

**The panorama gets away with omitting both because it only ever shoots from the player's own head.**
At that one camera position the stale uniform is already correct, and the lightmap texture left by
the last real frame is already the right one. Move the camera and the first omission draws the entire
world offset by however far you moved: this camera rose 44 blocks and the frame came back **black
with hard geometric edges** — which reads exactly like a lighting failure, was diagnosed as one, and
was in fact a photograph taken from inside the ground. The lightmap upload, added first on that wrong
diagnosis, is kept because it is genuinely required for the case this seam exists for: **a render in
a dimension the last real frame was not in**, the studio being a dimension whose entire point is its
light.

The general shape, and it is the one worth carrying: **a vanilla code path that only ever runs in one
configuration is only correct in that configuration.** `grabPanoramixScreenshot` sits behind
`SharedConstants.DEBUG_PANORAMA_SCREENSHOT` and is called from exactly one place with exactly one
camera. Copying it is not the same as copying something that works. This is
[[probe-environment-coupling]] pointed at Mojang's code instead of at ours.

### 12.3 Four smaller corrections

**1. Placement is measured, not modelled.** `Camera.alignWithEntity` adds an eye height it lerps
privately and converges geometrically, so `at.y - player.getEyeHeight()` is a guess. The camera is
aimed once, asked where it actually landed, and moved by the residual. `camera_at` in the reply is
read back off the `Camera` — so the probe's "the camera lands where it was asked" case is checking a
measurement, not an echo of its own argument.

**2. The `finally` has a falsifier, and it cost nothing.** §7 asked for "a render whose `finally` is
forced to run (throw injected)". A test-only argument would have to be declared in the schema, which
`ArgCheck` requires and the manifest bill charges for. Instead the divisibility check is left where
vanilla throws it — **inside** the try, after the window resize, the player move and the render. So
`render {width:257, downscale:2}` is a real mid-flight throw reachable from a probe at no schema cost
at all, and the message the caller gets is rephrased on the way out and says more than an early
refusal would have.

**3. `restored` is snapshotted in the `finally`, not read in the callback.** The screenshot callback
fires a frame or two later (`RenderSystem.queueFencedTask`), by which time the human may have walked.
Reading the restored state there would report something else entirely.

**4. `settled` is not decoration.** A camera that jumps looks at sections nobody has built; uploads
happen *inside* `LevelRenderer.render`, so the way to make progress is to render again, not to wait.
Sixteen passes then one more, and the reply says whether it converged. A 60-block jump measured
`passes:17, settled:false` — the honest answer, and the caller's to act on.

### 12.4 The arbiter decodes the PNG

`render-camera.test.mjs` carries ~50 lines of PNG decoder (inflate plus the five row filters) rather
than asking the tool what is in the file it just wrote. It asserts the IHDR size is the size that was
*asked for* and is not the window's; that the empty studio is uniformly `visual/fog_color` **read out
of `studio.json`** across a sampled grid; and — the case without which the previous one is worthless
— that a wall of black concrete in front of the same camera turns the centre pixel into something
else while the corners stay the background. A frame that never rendered, a stale frame, and a
tolerance somebody widened all pass "uniformly white"; none of them passes both.

Its site is the studio at **x=-4096, z=-4096**, deliberately negative: canvas slots are allocated at
`(slot % row) * 512` from the origin and are therefore all non-negative, so the cheapest way to own a
site nobody allocates (trap 12) is to stand outside the allocator's range.

### 12.5 `open_world` closed phase 4, and made the rest possible

Phase 4 was not a nice-to-have that happened to be small. `launch_game` leaves a client at the title
screen, and until this existed **every CLIENT-context probe needed a human click, or a chain of
`click` calls through the world-selection list**. Its arbiter is §7's, run for real: title-screen
client → `open_world` → `get_world_info` answering → a `render` that succeeds, with nobody touching
the mouse. It returns as soon as the load has *started* and says so in the reply, because a world
load takes many seconds and can still fail on its own screen; claiming otherwise would be the
succeeds-falsely shape with a 15-second dispatch timeout attached.

It also re-verified §11.2's first correction from the other end: `New World` had never had the canvas
in it, gained the **files** on one start and the **dimensions** on the next, exactly as
`Canvas.absentMessage` says.

### 12.6 Still owed

- ~~**Phase 3 — framing and orbit.** `look_at`, `distance`, `frames`. Unbuilt.~~ **SHIPPED at
  0.108.0 — §13.** §7's arbiter exists and passes: a subject of known bounds, framed, at two sizes.
- ~~**`op:"canvas"`.** §6's "put the subject in the studio and photograph it there" is still two calls
  and a `place_structure` by hand. **This is now the only unbuilt line in this document.**~~
  **BUILT at 0.113.0 — §14 — as the `studio` tool rather than as an `op`, because §6's own
  manifest-tax argument loses to the mechanism doctrine: `render` is `observe` and is on the
  read-only `inspect` profile's keep-list.**
- ~~**The manifest bill of `render` and `open_world`.** Still estimated, still not measured.~~
  **`render` MEASURED at 0.108.0 — §13.4.** `open_world` is still estimated; §9's keep-list question
  now has a number to be decided against.

### 12.7 Two red herrings, and the one that was real

Both are worth writing down, because each cost real time and each has a general shape.

**The world that closed itself, twice, was an orphaned build script — not `render`.** A world would be
open and working, two renders would land, and a beat later the log said "Saving and pausing game",
then a clean logout with no exception; the next `open_world` would load recipes and advancements and
bounce back to the title through its own `onCancel`. It read exactly like a camera corrupting the
client. It was a `tools/rebuild.ps1` left running in the background from earlier in the same session,
whose very first step is *stop whatever game is on this port* — it was politely quitting the game out
from under the work. **A launcher script is a process, and a process you started and stopped watching
is still running.** When a symptom looks like "the thing I just built breaks the game", check first
whether something else in the session is still holding the game's hand.

**The probe that left the human in another dimension was real, and it reddened two files it never
touches.** `render-camera` teleports the player into the studio — it has to, because the camera can
only photograph chunks the client has been sent — and the first version never brought them back.
Reads that are given no `dimension` answer about the dimension the player is standing in. So the next
battery had `predicates` reporting `unreadable:48` at a site that reads perfectly, and `player-hands`
watching a hoe fail to till dirt, in two files that share no coordinate with this one. **This is
[[probe-site-ownership]] one level up: a file owns its site, and it also owns the player's
DIMENSION.** `site-map.test.mjs` cannot see this class — it compares coordinates — so the fix is the
`after` hook that puts the human back where `before` found them, and the comment there says why.

*(For the record: the `site-map` red in the battery at 0.105.0 is neither of these and is not this
work's. Two coordinate collisions, both already in HEAD — `conformance`/`preview-worldgen` genuinely
sharing 5,400,000, and `loot-roll`'s `random value 1..1000000`, which is a range and not a site at
all. The file's own header prescribes the fix for the second: exempt it, do not loosen the rule.)*


## 13. What was built — framing and orbit, phase 3, toolkit 0.108.0 **(2026-08-28)**

`look_at`, `distance` and `frames`. Framing a build is now a box rather than trigonometry, and the
five phases are done except `op:"canvas"`. Sixteen live cases, zero skipped.

**The useful part of this section is §13.3**, where the check §7 asked for went red for a reason that
had nothing to do with framing, and turned out to be a defect in phase 1 that had shipped three days
earlier and been called *settled*.

### 13.1 What shipped

| Piece | Where |
| --- | --- |
| Framing and orbit | `client/RenderTools.java` — `plan()`, `subject()`, `autoDistance()`, `direction()` |
| The arbiter | `mcp-server/probes/render-camera.test.mjs` — 9 cases → **16**, live-green, 0 skipped |

No new tool entry, no new profile, no surface change: three fields on the entry that already exists,
which is §6's own instruction and the only reason this cost what it cost (§13.4).

### 13.2 §6 was wrong about `yaw`/`pitch`, and the correction is what makes it one contract

§6 lists `yaw,pitch` as "explicit orientation (**mutually exclusive with look_at**)". They are not,
and seeing why is the whole design:

**A camera standing at `centre − dir(yaw,pitch)·d` and looking along `dir` HAS exactly the yaw and
pitch it was given.** So `yaw`/`pitch` mean the camera's orientation in every case, and `look_at`
decides only *where it stands so that orientation hits the subject*. Nothing is overloaded, nothing
changes meaning depending on which other field is present, and an orbit is that same placement walked
round the circle — which is why `frames` needed no new machinery at all.

There is exactly one genuinely over-determined combination, and it is the one §6 was reaching for:
**`at` + `look_at` + an aim.** With both endpoints given, the aim is derived from one to the other, so
a yaw would be a third opinion. That is refused by name, and so are `distance` and `frames` in the
same position.

**`frames` is the orbit; there is no `op`.** §6 sketched `op: view|orbit|canvas|clear`. An enum whose
value is derivable from a field that must be present anyway is a second question about a settled
fact, and the manifest charges per turn for the asking. `op` remains the right shape for `canvas` and
`clear`, which are not derivable from anything — it can arrive with them.

**The subject box is BLOCK coordinates, inclusive at both ends** — `min..max`, the same box
`set_blocks`, `describe_box` and `capture_structure` take, with `max` optional for a one-block
subject. The world box is `min .. max+1`, and that conversion lives on one line with a comment,
because §10.3's lesson is that *a piece captured one block off draws with a seam and nothing says so*.

**The arithmetic, and why it is a fact about the tool rather than about somebody's options file.**
`Camera.calculateFov` returns a hard `90.0F` in panoramic mode (`Camera.java:222`) and
`Projection.getMatrix` hands it to JOML as **`fovy` — VERTICAL** (`Projection.java:73`). So the half
angles are 45° vertically and `atan(width/height)` horizontally, and the smaller one crops. A subject
is framed by its **bounding sphere**: its angular radius is `asin(r/d)`, so requiring
`tan(asin(r/d)) = FILL·tan(θ)` solves to `d = r·√(1+t²)/t` with `t = FILL·tan(θ)`. The sphere encloses
the box, so a long thin subject seen end-on is over-framed and nothing is ever under-framed — a
generous margin and a subject with its head cut off are not the same kind of wrong.

### 13.3 The check went red, and the bug was in phase 1 — `settled` was answering the wrong question

§7's arbiter is *"a subject of known bounds framed automatically… at more than one subject size"*. Its
first two cases came back with **an empty white frame** — and the cases after them, same cube, same
camera direction, found it perfectly. That reads exactly like a framing bug in the code just written.
It was not. It was this, from 0.105.0:

> `settled` asked `LevelRenderer.hasRenderedAllSections()` — which is
> `sectionRenderDispatcher.isQueueEmpty()` (`LevelRenderer.java:885`) — **once**.

**An empty compile queue means three different things and they are indistinguishable from here:** the
work is done, the work has **not been scheduled yet**, or the work has been taken off the queue by a
worker thread and is being built right now. `LevelRenderer.render` calls `compileSections` at its very
**end** (`:255`), after the frame, and that method calls `compileAsync` (`:631`) — so on the pass that
first sees a changed section, the queue is read *after* the hand-off and reads clear. The loop exited
on pass one having drawn nothing new.

Measured, and this is the sentence: **`passes:2, settled:true`, and a uniformly white frame with an
eleven-block black cube standing fifteen blocks in front of the camera.** The fix is three
*consecutive* clear readings ten milliseconds apart; the same shot then comes back correct at
`passes:4`, and the probe asserts `passes >= 4` on any settled render so the single-read version
cannot come back unnoticed.

**Two general shapes, and the second is the one to carry:**

1. **A loop whose exit condition is evaluated on the pass that discovers the work will exit before
   doing it.** §12.3 point 4 already said "`settled` is not decoration" and had the *other* end of
   this right — one more pass after settling, because the pass that discovers a section is not the
   pass that draws it. The same sentence applied to the loop's entry would have found this.
2. **`settled:true` is a fact about this client's renderer and nothing else.** A block written on the
   server 700–900 ms ago (measured, dev singleplayer) may simply not have arrived, and no amount of
   rendering makes it come sooner. That is now said in the tool description, because from inside the
   camera *an empty studio and an empty studio that is about to have a house in it are the same
   picture* — the caller is the only one who can know which they asked for. The probe answers it with
   a setup step that has its own failure (`awaitVisible`, watching through a hand-aimed phase-1 shot
   so that a framing bug and a slow client cannot be mistaken for one another) rather than a longer
   sleep: **a sleep long enough to hope is not a wait.**

### 13.4 The bill, measured at last

§9 has carried "the manifest bill of `render` — estimated, not measured" since 0.105.0. Read off the
live manifest at 0.108.0:

| | chars | ~tokens/turn |
| --- | --- | --- |
| `render`, whole entry | 4,287 | 1,071 |
| — its description | 1,319 | 329 |
| — its schema | 2,852 | 713 |
| — **phase 3's three fields** | **1,214** | **303** |
| the whole manifest (94 entries) | 177,212 | 44,303 |

**The schema is more than twice the description**, which is `TOKEN_PER_TOOL_FINDINGS.md` findings 4–6
holding again and the `place_shapes` lesson exactly: *price the whole entry, and the schema is the
bigger half.* Most of phase 3's 303 is structural — two nested `vec3i` is what a box costs — and it
bought the removal of a framing calculation the caller would otherwise redo every time, with the orbit
thrown in for nothing. §9's remaining question (does `render` belong in the `authoring` keep-list) now
has the number it asked to be decided against: **a bit over a thousand tokens a turn, every turn, for
every session that carries it.**

### 13.5 The two-size case is the one that cannot be faked

Worth stating on its own, because it is why §7 asked for it and why it is cheap:

The camera stands at `centre + k·r·û` for a `k` that depends **only on the frame's aspect**. So a
3-block cube and an 11-block cube photographed this way are geometrically **similar** — their
silhouettes are identical up to pixel quantisation, and the probe asserts their screen fill agrees
within 10%. **Any framing rule with an additive term in it** — "stand back `radius + 10`", "clamp to
16 blocks", "never closer than a chunk" — **passes margin, passes fill, passes centring, and dies
here.** The same argument gives a second constant-free assertion for free: the reported `distance`
must be the same multiple of the subject's own radius at both sizes, which checks the formula without
copying a single number out of the thing being tested.

## 14. What was built — the studio, and the op that could not live on the camera, toolkit 0.113.0 **(2026-08-31)**

§6's last line: *put the subject in the studio and photograph it there*. It is built, it is
live-green, and **the design is finished**. The useful part of this section is §14.2, where the
manifest-tax argument this whole surface was shaped by lost to a rule §6 never weighed, and §14.5,
where the probe's own falsifier failed for exactly the reason the tool exists.

### 14.1 What shipped

| Piece | Where |
| --- | --- |
| The stage: slot, subject, census, witnesses, the pad, the sweep | `canvas/CanvasStage.java` |
| The tool: the trip there, the wait, the trip back | `client/StudioTools.java` |
| Profile placement | `mcp-server/index.mjs` — `CLIENT_SURFACE`, `modding`, `authoring`; **not** `inspect` |
| The arbiter | `mcp-server/probes/render-studio.test.mjs` — 7 cases, live-green, 0 skipped |

The surface is three fields and one new name:

    studio {id:"mymod:cottage"}      stage a loaded template, and put THIS CLIENT in front of it
    studio {look_at:{min,max}}       stage a copy of blocks standing in the dimension the client is in
    studio {leave:true}              sweep this session's subject and put the client back

and then the camera that already existed: `render {look_at:<the box it returned>}`, `frames:N` to
orbit it. **The staging half takes no pictures.** That is why phase 3's framing, orbit, resolution and
output arguments all work on a staged subject without a line about any of them being written here.

### 14.2 §6 was wrong about which entry this belongs on, and the rule that overruled it

§6 puts `canvas`/`clear` on `render`'s `op` field, on the measured argument that a second question
about an existing argument list is far cheaper than a new manifest line. That argument is right about
tokens, and it loses:

**`render` is `mechanism:"observe"`, and `inspect` is a keep-list checked against the mechanism.**
The read-only inspector — "a session that answers questions about a world it must not change" — is
not a hand-written promise: `probes/profiles.test.mjs` asserts every bridge tool it serves declares
`observe`, and `render` is on its list. Staging writes blocks into a dimension and teleports a
player. Hang that off `render` and the failure is silent in every direction at once: the manifest
goes on saying `observe`, the profile probe goes on passing, the audit ledger — gated on
`world_edit`/`privileged` at the dispatch chokepoint — never records the edit, and a read-only
session can change the world. **A restriction deleted by an addition nobody would see**, which is §8
trap 2 wearing a different hat.

So the camera stays a read and the stage is a `world_edit` beside it. This is not a defeat for §6's
principle; it is §6's own reasoning for `open_world` ("not a rendering verb… it belongs beside
`launch_game`") applied to the case §6 got wrong. And the entry is cheap for the reason the split
makes possible: **because the picture stays `render`'s job, `studio` needs three fields instead of a
second copy of the camera's ten** — 483 tok/turn against `render`'s 1,038, both measured in §14.6.

**And this settles §10.6's other three the same way, before anybody builds them.** §11.3 left
`edit`/`save`/`cancel` as commands with the note that "when `render` lands, its ops call the same
methods the commands do". They cannot be `render` ops either, for the identical reason: opening a
template into the workshop places blocks, and saving one writes a file — `world_edit` and
`privileged`. If they ever want a bridge surface it is beside this one, not inside the camera.

### 14.3 Three things a caller cannot do with `place_structure` and `render`, and they are the tool

`place_structure` can already put a template into `mcptoolkit:studio`; `render` can already frame a
box. Everything that goes wrong is in between them.

1. **The camera photographs the level the CLIENT is in.** `renderLevel` draws `Minecraft.level`; no
   `dimension` argument can move it. A shot in the studio is therefore a real player's round trip —
   and the return leg is not politeness. A probe that once left the player in the studio cost a whole
   battery run, because every read that is not given a dimension answers about the one somebody is
   standing in, and the failures named a dimension nobody had asked about.
2. **Knowing when the client can see it.** §13.3 is the record: `settled:true` is a fact about this
   client's renderer and says nothing about blocks still travelling from the server, measured at
   700-900 ms. The stage waits on the client's OWN copy of cells it picked one per chunk column — a
   column being the unit a chunk packet carries — and fails loudly if they never arrive.
3. **Coordinates nobody chose.** The slot is allocated, so two sessions photographing at the same
   moment cannot stand their subjects in the same place. `[[probe-site-ownership]]`, one level up.

**A stage stays until it is swept**, one region per calling session, cleared before that session
reuses it. Sweeping it in the `finally` that returns the player was the obvious alternative and is
wrong twice: the picture becomes unreproducible, and nobody can walk into the studio and look at the
thing that was photographed — which §5 says is the whole point of taking one. `leave` clears the
CALLER's stage and nobody else's, the rule §11.3 already settled for `/mcptk cancel`.

### 14.4 The studio has no floor, and that only matters once somebody has to stand in it

This design treats the studio as a place for a camera, which needs no ground. The client does. A
player teleported into a void dimension falls at terminal velocity — about 78 blocks a second — and
takes void damage below `min_y - 64`; a stage that waited its full fifteen seconds would be a stage
that hurt somebody.

The fix is one block: a 3x3 pad of `minecraft:barrier` under the spot the client is put down, outside
the subject's box. `BarrierBlock.getRenderShape` returns `RenderShape.INVISIBLE`
(`BarrierBlock.java:51`), so it is the one block in the game that is *a floor to stand on and nothing
to look at* — it cannot appear in the photograph however the camera is framed. It sits inside the
cleared region and is swept with it, and the probe asserts exactly that: a `leave` that leaves the
pad standing is a `leave` that left something.

### 14.5 The first live run: the FALSIFIER failed, for the reason the tool exists

Seven cases, six green on the first run. The one that failed was not the staging path — it was the
falsifier, the control shot that photographs the same subject where it stands so that "the staged
frame's border is the studio's declared colour" means something. Its centre pixel came back
**179,163,159**: sandstone. The camera had photographed the ground *through* a five-block cube that
`set_blocks` had written a moment earlier and this client had not yet been told about.

That is §13.3 again, and finding it here is the cleanest statement of what this tool is for:

> The probe takes two pictures of the same subject. The staged one needs **no sleep and no poll** —
> it renders immediately after `studio` returns, and that omission is the file's only assertion about
> the wait, because a stage that did not wait would photograph an empty white room. The in-place one
> needs a hand-rolled poll with its own failure, written out in the test, because nothing else was
> going to do it. **The difference between those two cases is the tool.**

### 14.6 The bill, and §9's last open question closed

Read off the live manifest at 0.113.0 (95 entries, 172,497 chars, ~43,124 tok/turn):

| | chars | ~tokens/turn |
| --- | --- | --- |
| `render`, whole entry | 4,151 | 1,038 |
| `studio`, whole entry | 1,932 | 483 |
| — its description | 844 | 211 |
| — its schema | 1,014 | 254 |
| `open_world`, whole entry (§12.6's owed measurement) | 759 | 190 |

`open_world` was the last estimated number in this document, and it is **190 tok/turn** — §6 called
it "a separate, tiny entry", which turns out to have been exact.

**§9's question — does `render` earn its place in the `authoring` keep-list — has its numbers now.**
Priced against each profile that carries it (toolkit entries only):

| profile | tools | ~tok/turn | `render`'s share |
| --- | --- | --- | --- |
| `modding` (the default) | 44 | 22,961 | 4.5% |
| `authoring` | 26 | 11,032 | **9.4%** |
| `inspect` | 26 | 18,068 | 5.7% |
| `screens` | 29 | 9,016 | 11.5% |

**Keep it, everywhere it is.** A tenth of an authoring session's manifest is a real price, and what
it buys is the only read in the toolkit that can look at a build *from outside the player's own
head* — `screenshot` can only ever shoot from where somebody is standing. That was §C5's argument
when `render` was added to these lists; it now has a number under it rather than a judgement. A
session that disagrees is one `tool_surface` call from a smaller surface, which is the mechanism this
repo built so that a keep-list decision would not have to be final.

`studio` adds 483 to `modding` (2.1%) and to `authoring` (4.4%), and nothing anywhere else.

### 14.7 What is left, and none of it is code

Nothing in this design is unbuilt. Two judgement calls stay open, both carried down from §11.4:

- **The workshop's own look.** A fixed 45° sun and mid-grey fog are a decision about what is
  comfortable to build in for an hour, made without building in it for an hour. Two JSON numbers.
- **The studio's white.** The same question for the camera's room — and now answerable the easy way,
  by staging a subject and looking at it. A pure white background flatters a dark build and hides a
  pale one, and this is the first version of this document in which that sentence can be tested in
  one call.
