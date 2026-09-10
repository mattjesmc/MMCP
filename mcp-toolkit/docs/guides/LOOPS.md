# Loops: authoring many units of one kind, and what it costs

An authoring loop is a session that makes one *unit* — a part, a skin, a screen, a structure — over
and over, each from a brief. The toolkit's one real user so far (ArmorPieces: 91 parts, 14 skins)
ran that loop through a proxy of its own and measured every lever. This document is those levers,
generalised, and the six pieces of the toolkit that give them to the next project for free. The
design and the numbers behind it are in `LOOP_KIT_DESIGN.md`; this is the how-to.

## The arithmetic

A session costs **turns × the context each turn carries**. Output tokens are noise beside it. Two
consequences decide everything below:

1. **The tool that acts on one unit per call sets the price.** Every call re-sends the whole
   conversation. A face-addressed painter took a part from 82 paint calls and $5.08 to 2 calls and
   $2.01; a `stamps` list took a skin from 73 calls to 3.
2. **Pictures are the other half.** A picture costs its area (about `width × height / 750` tokens,
   after the API's own downscale to ~1568 px) and is re-sent on every later turn. Nine skin
   sessions: the looks outweighed every text reply put together, and in the leanest three every
   screenshot came after the last edit and bought nothing.

`tools/loop/analyse.mjs <log.jsonl>` prints both numbers for any session — a `claude -p
--output-format stream-json` log or a Claude Code transcript — and ends with the one line that
matters: which tool was called most, and whether it takes a list.

## The levers, in the order to pull them

### 1. The image budget (on by default, costs nothing)

Every frame the shim hands the model is cropped to its content, then resized to a longest edge
(default 384, the edge every figure in the design record was measured at; `MCPTK_SHOT_MAX` per
session, `0` keeps pictures whole), and priced on the reply:

    picture 232x384 ~119 tok (was 3840x2131 ~1533 tok, content was 7% of the frame); re-sent every turn after this one

That applies to `screenshot`, `render inline:true`, `screenshot_annotated`, the Blockbench
viewport and app captures, and the painters' `look`. A texture sheet (`get_texture`) is resized at
most and never cropped - its pixel (x, y) is what `paint_faces pixels` and `paint_ascii at` name,
and a crop would move every texel you read off it. `screenshot` also takes `max` (per call) and `crop`: a GUI rectangle
`[x, y, w, h]`, or `{"widget": <index>}` / `{"id": "<element id>"}` from `get_screen
detail:"layout"`, scaled to the framebuffer by the GUI scale. A screen check wants the widget, not
the 4K frame.

Give the agent a picture budget in its brief, in numbers ("six pictures"), and the rule: take the
first one where it can still change what you draw, and none after the last edit.

### 2. A check on every reply: the project loop file

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

- **`after`** selects by the `mechanism` the manifest stamps on every bridge tool (`observe`,
  `embodied`, `world_edit`, `privileged`). The toolkit's Blockbench plugin stamps its tools the
  same way: `blockbench_edit` is every Blockbench tool that edits, the painters (`paint_faces`,
  `paint_ascii`) among them - a check written as above fires after them too - and a mixed tool
  (`project`) stamps each reply with what that op was, so `project op:list` fires nothing. `tools` adds names, `not` removes them (`capture_screenshot` and
  `set_camera_angle` are the usual `not`: a look is not an edit, and a checker run per look is a
  checker run for nothing). Read-only calls never trigger a check, and that is derived, not kept by
  hand.
- **`run`** is your checker: any command whose LAST stdout line is JSON,
  `{"text": "...", "problems": N, "notes": N, "full": "..."}`. The shim appends `text` to the
  reply and renders nothing else. The `!`/`-` vocabulary inside it is yours. A checker that cannot
  run is reported on the reply as `[loop] check "part" could not run: …` — loudly, because a check
  nobody executes is not a guard.
- **`stateful`** hands the previous report back as `--previous <file>` (or as `__previous` inside
  an `eval`). That is how "a face that was complete and grew" is a diff and not a memory. The
  history is **per shim**: if your project's own MCP server also edits the unit and runs the same
  checker, each caller has its own previous report, and a face painted through one and grown
  through the other is a regrow nobody reports. A checker with two callers should keep its own
  history (beside the unit it checks) and ignore `--previous`; ArmorPieces' `check_active.py` does.
- **The reply is where the numbers go.** The check's `text` is the seam for "put in the reply what
  the agent would otherwise spend turns researching": a checker that prints, for every cube whose
  net moved, the sheet rectangles of its faces, has told the agent where to paint on the reply
  that placed the cube. ArmorPieces measured that block at 491 tokens over eight replies, and the
  session never opened another piece to place against its neighbours. The whole check block is a
  per-turn cost - 3,353 tokens over 18 replies in the same session - and it still paid: one
  coplanarity line on the first cube pass meant no nudging pass on any bone.
- **`gate`** names tools refused while the last report has `problems > 0`, unless the call carries
  `force: "<why>"` — the shim adds `force` to those tools' schemas, echoes the reason in the reply
  and logs it. The reason is the point: a forced save says out loud what was accepted. A gate can
  only hold a tool **this shim serves**: a tool of your project's own MCP server never passes
  through here, so a gate naming it is nothing, and the shim says so on stderr once the manifest is
  known. Gate that tool in the server that serves it.
- **`eval`** instead of `run` executes JavaScript inside Blockbench through `risky_eval` (the
  toolkit's own plugin since 0.133.0: comments are fine, a rejected Promise is an error on the
  reply, not a wedge). The toolkit's entity verify battery ships the contract:
  `"eval": "mcptoolkitEntity({action:'check', previous: __previous})"` — overlap, coplanarity, UV
  collisions, per-face paint coverage, stray paint, and the face that grew, on every edit.

Which checks belong here: everything arithmetic and invisible in the 3D view. A face lying on a
shell plane; a face with no paint behind it; paint no face samples; a face that grew on a resize; a
colour read as a ramp position; a recipe centre already used. Checks bound the search; the picture
is still the judgement, so the picture has to be cheap enough to afford — that is lever 1.

### 3. The project profile: keep-list, notes, instructions

Same file:

```json
{
  "profile": {
    "base": "art",
    "keep": ["place_cube", "modify_cube", "add_group", "risky_eval", "capture_screenshot", "paint_faces", "ping"],
    "notes": { "place_cube": " In this workspace put the cube in a bone group under `part`. Leave `faces` alone." },
    "instructions": "Blockbench is running with this project's plugin. Model inside the `part` group."
  }
}
```

A session in that workspace launches in the `project` profile (`MCPTK_PROFILE` still wins). `base`
decides which upstreams exist; `keep` is a keep-list — a name that never appears is never served,
a new tool stays hidden until named, and a kept name absent from the manifest is a stderr warning.
Keep only what the loop calls: every kept name is paid on every turn. ArmorPieces' part loop over
the `art` base priced three keep-lists on one session - their old proxy at 46 tools was ~10.4k
tokens a turn, the example loop file the kit first shipped (the `art` base whole: memory tools,
the game bridge, the generic painters, none of which a part author calls) was 53 tools and ~12.5k,
and the same file trimmed to the 29 names the loop uses was 39 tools and ~8.6k. Trimmed, the kit
costs less per turn than the proxy it replaces; as shipped it cost more. `tool_surface` prices any
of them in one call.
`notes` are appended verbatim to the named tools' descriptions, so the model learns the workspace's
rules where it reads the tool; they are a per-turn cost like the entry they ride on, and
`tool_surface` prices them. `instructions` is served as the MCP server's instructions.

### 4. Batch tools

Before adding a tool that acts on one unit per call, ask what its list form is
(`ARCHITECTURE.md`, "price a tool by its arity"). The toolkit ships two generic painters under the
`art` profile:

- `paint_faces {texture, faces: {"<cube>.<face>": colour | grey | [top, bottom] | null}, pixels,
  look}` — whole faces by name, one undo entry; `look:true` returns the viewport picture on the
  same reply, which saves the turn a `capture_screenshot` would cost.
- `paint_ascii {texture, palette, stamps: [{at | cube+face, rows, fill, tile, shift, shade_only,
  palette}]}` — ASCII rows through a palette, space leaves a texel alone, `.` clears it.

### 5. Pin the judgement

When a unit has a part that needs judgement and a part that is labour, give the tool a way to pin
the judgement and the labour drops a model tier. ArmorPieces seeded a skin's silhouette from vanilla
and let the agent only shade (`shade_only: true` on every stamp — paint only where a texel is already
opaque): zero silhouette errors where free-form had five, and a Sonnet session at $0.78 beat Opus at
$2.28–$5.65. The pin is what made the cheaper model *correct*, not just cheaper. Other pins the
toolkit already has: a `.ui.json` layout the emitter honours; a pose the verify sweep holds.

### 5b. A step before the session: `unit.start`

Some units have a part that needs no judgement and must run before any session exists. A block's
registration is the example (`LIVE_MODDING.md`, *Before a game exists*): it is structural, so a
rebuild follows it, and a rebuild inside every unit session is the one cost that breaks
one-session-per-unit. So the block loop's shape is **scaffold N -> rebuild once -> N live sessions
of judgement work through `push_asset` / `reload_resources` -> `clear_assets promote` ->
`checkAssets`**, and the scaffold is the step that runs before the session:

```json
{
  "unit": { "start": ["gradlew", "scaffold", "-Pkind=block", "-Pid=${unit}"] },
  "checks": [{ "name": "assets", "run": ["gradlew", "-q", "checkAssets"] }]
}
```

`run-unit.ps1` runs `unit.start` once, with `${unit}` = the brief's file stem, and prepends its
stdout to the brief: a FILE LIST and the four-call recipe, a few hundred tokens, never the emitted
Java (everything in the brief is re-sent every turn). A non-zero exit is a warning and the session
starts anyway with the output in front - the commonest non-zero is the scaffold refusing to run
twice on a unit being re-attempted, and that line is what the session should read first. A check
with `run` and no `after` runs only after the session, which is where `checkAssets` belongs: the
gate on what the unit left in the tree. This is the seeded pin of `LOOP_KIT_DESIGN.md` section 2
("the strongest cost lever they found") applied to registration boilerplate: pin it, and the
session keeps only the judgement half, at a cheaper model tier.

### 6. One session per unit

Fresh context per unit, the brief in, a `## Lessons` section out, the next brief carries the lessons.
Sequential — two sessions on one editor race on its active tab.

**One session id per process.** The plugin binds a project to a session ID, so two processes
presenting one id are one session with one binding, and every unqualified call of either lands in
it. `MCPTK_SESSION` — and whatever an `.mcp.json` derives it from — must never come from a
variable a child process inherits: `CLAUDE_CODE_SESSION_ID` is copied into every `claude -p`
child, and ArmorPieces' four parallel children on 2026-09-07 were one session to the plugin,
each writing into another's piece (their `docs/measurements/blockbench-plugins.md`; the contended
runs cost 2.4x the clean ones). Set it per child from the launcher, or leave it unset and the
shim uses `shim-<pid>`, which is unique by construction. Since plugin 0.2.0 the shim holds one
connection per process and the plugin releases the binding the instant that connection closes, so
a crashed or finished session frees its tab at once; and when one id does arrive on two
connections, every reply carries `session.note` saying so and the shim's stderr says it once.

- `tools/loop/agent-template.md` — the agent definition's shape: tool allowlist, what a finished
  unit IS, the traps, a budget in calls and pictures, order of work, "do not read the reference doc
  unless a reply sends you there", write Lessons into the brief.
- `tools/loop/run-unit.ps1 -Agent <name> -Brief <file> [-Model …]` — one headless `claude -p`
  session with stream-json to `.mcptoolkit/runs/`, the analyser at the end, and every `run` check
  executed once more outside the session. The brief's file stem is exported as `MCPTK_UNIT` to the
  session and to that last check: a session that finishes properly closes its tab, so a checker
  addressed at "whatever is open" has nothing afterwards and should fall back to the unit that
  variable names. Name brief files after their units.
- `tools/loop/analyse.mjs` — the cost table, and the line. The cost it leads with is the harness's
  own `total_cost_usd` from the log's result line, and its estimate is priced on that line's usage
  totals; a stream-json log's per-message usage does not carry the output and thinking the model
  produced, and an estimate summed from it reads about half the true figure.

## What stays yours

The checkers, the domain's arithmetic, the rig, the project's own tools. The kit gives those a
place to plug in and nothing else: a checker is one script with a JSON line at the end, not a proxy
server. `tools/loop/examples/block-model.loop.json` is the worked example — one session authors one
Minecraft block model, geometry and texture in Blockbench, exported into the mod's resources and
pushed into the running game — and `check-block-model.mjs` beside it is the checker it runs: copy
both into your `<mod>/.mcptoolkit/`, leave `MCPTK_PROFILE` unset, and edit them until they are your
project's rules. Its preamble says why each part is shaped the way it is: the keep-list trimmed to
what the loop calls and priced per turn, the check fired where its subject actually exists (a `run`
check sees the filesystem, so it fires after `export_model` rather than after every edit), and the
gate on `push_asset` rather than on the tool that feeds the check. `probes/loop-examples.test.mjs`
holds it to all of that, which is what the example it replaced never had.

## Measured

The kit's falsifier ran 2026-09-06 (`LOOP_KIT_DESIGN.md` §11): ArmorPieces' next new part,
through the loop file and their nine tools, at the model their published figures were taken at.
33 turns against the proxy's 42, saved first try, both repository checks clean; the levers that
moved it were the batch painter and the check on every reply, not the manifest. Nine findings
came out of the run and this guide reflects the fixes.

## Owed

- **The block loop file.** `unit.start` and `checkAssets` are the two seams a block loop needs,
  and a loop file per rung ships only once a real unit has been measured on it (section 11
  measured that the untuned example would have ADDED 2.1k tokens a turn). Today that is one rung,
  armor pieces. A scaffolded block is trivially re-authorable, which makes it both the kit's first
  falsifier on a second unit kind and the same-brief A/B below.
- A same-brief A/B: the measured run compares a kit session against the published figure for a
  *different* part. The clean experiment is one brief run both ways, on a unit that can be
  authored twice.
- The painters' `look` on a project's own painter: `paint_faces look:true` returns the viewport on
  the same reply and a project painter that does not costs a turn per look. The generic painter
  cannot replace a painter that folds colour to a material ramp, so the pattern moves the other
  way - it is theirs to add, and worth naming here because it is a turn per look.
- **Phases in the loop file.** A part session has two clean halves, modelling then painting, and
  nothing in the second calls `place_cube`, `add_group` or `element`; cache reads were a third of
  a measured piece's cost and the per-turn prefix is most of them. A loop file declaring
  `profile.phases` (named keep-list subsets) that `tool_surface {phase}` switches between would
  drop half the manifest at the boundary. Not built: a switch costs the client a re-read of the
  whole served list, so the saving is (turns left x tokens dropped per turn) minus that, and on the
  measured session the two are the same order of magnitude - `TODO.md` 1.7 has the arithmetic;
  measure before building.
