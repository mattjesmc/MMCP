# Loop kit: what ArmorPieces taught the toolkit, and what to build from it

Written 2026-09-05 from the ArmorPieces record (`<workbench>/ArmorPieces`: `tools/mcp/`,
`tools/check_part.py`, `tools/check_skin.py`, `tools/shrink_shot.py`, `.claude/agents/*.md`, the
Lessons sections of 67 briefs under `docs/plans/briefs/`, and that project's own memory). Status:
**BUILT 2026-09-05, toolkit 0.122.0 / shim 0.56.0** — §5.1–5.6 as described in §8 below, proven
offline (24 probes + the entity harness). **TESTED LIVE 2026-09-06, toolkit 0.123.0 / shim 0.57.0**
— §9 items 1-6 and 8 pass after the fixes recorded in §10. **FALSIFIED 2026-09-06, toolkit 0.124.0
/ shim 0.58.0** — §9 item 7 ran, by ArmorPieces, on their next new part: the kit passes, the
example file it shipped would not have, and §11 records the run, the nine findings and which side
fixed each. The how-to for a consumer is `docs/guides/LOOPS.md`.

ArmorPieces is the toolkit's one real user so far, and it barely used the toolkit. It authored 91
parts, 14 skins and 2 cloths through a **proxy of its own** in front of Blockbench's MCP plugin, and
touched the game bridge only for gallery shots. Everything it optimised, it optimised outside our
framework. The question this document answers is which of those optimisations were about *armor*
and which were about *any authoring loop*, and what the toolkit has to grow so the next project gets
the second kind for free.

## 1. What they measured

The numbers below are theirs, from headless `claude -p --agent … --output-format stream-json` runs
and a scratch analyser over the jsonl.

| What | Before | After | The change |
|---|---|---|---|
| A part (Spire → Antennae) | 144 turns, $5.08, 82 paint calls | 42 turns, $2.01, 2 paint calls | one face-addressed batch painter |
| A skin (plate → mail → gambeson) | 148 turns, $5.65, 73 paint calls | 38-49 turns, $1.74-2.28, 3 calls | a `stamps` list on the painter |
| A skin, silhouette pinned, Sonnet | Opus $2.28-5.65 free-form | Sonnet ~$0.78, zero silhouette errors | the outline seeded from vanilla; the agent only shades |
| One Blockbench look | 1020×946, ~1290 tok, 28% figure | 221×384, ~113 tok, 100% figure | crop to content, THEN resize |
| Cache-read tokens per session | plate: 148 turns × ~62k = 9.2M | gambeson: 38 turns × ~41k = 1.55M | fewer turns; output tokens were noise |

Three conclusions they drew, each of which generalises past armor:

1. **A session costs turns × the context each turn carries.** Output tokens are noise. So a tool
   that acts on ONE unit per call sets the session's price, because every call re-sends the whole
   conversation. The toolkit already learned this once (`place_shapes`, [[place-shapes-batch]]);
   ArmorPieces learned it twice more, on two painters.
2. **Pictures are the other half.** An image is billed by area and re-sent on every later turn. In
   their nine skin sessions 5-15 looks outweighed every text reply put together, and in the three
   leanest sessions *every screenshot came after the last paint call* and bought nothing. Their
   agent briefs now carry a picture budget (six for a skin) and the rule "take the first one where it
   can still change what you draw".
3. **A check on every reply is worth more than a check on demand.** The proxy runs the project's
   checker (~250 ms) after every non-read-only call and appends a compact block. The face that landed
   on the helmet shell is reported by the call that put it there, and "6/54 faces unpainted" is a line
   the model reads before it thinks it is done. Save refuses while problems stand unless `force` and a
   reason. The same principle the toolkit wrote for entities ("verify is the finding; the screenshot is
   legibility only", `ENTITY_AUTHORING_DESIGN.md` §6.2) — but ours runs on demand, plugin-side, and
   nothing appends it to a reply.

## 2. The loop, taken apart

What their proxy (`tools/mcp/server.mjs`, 1050 lines) and agent definitions actually consist of.
Each row says whether the piece is armor-specific or generic, because that is the whole sorting job.

| Piece | What it does | Armor-specific? |
|---|---|---|
| Keep-list profile | 29 of Blockbench's 94 tools plus the project's own; `full` for debugging the bridge | The LIST is; the mechanism is not. Our `art` profile keeps a different slice. |
| Description NOTES | Sentences appended to upstream tool descriptions ("In an Armor Piece put the cube in a bone group under `part`… leave `faces` alone…") so the model learns the workspace's rules where it reads the tool, not in a doc it may not open | The sentences are; the seam is not. |
| `instructions` | One paragraph served as the MCP server's instructions | Same. |
| READ_ONLY set | A hand-kept list of upstream tools after which no check runs | We already stamp every bridge tool with a `Mechanism`; Blockbench's upstream we could stamp from the captured manifest. |
| Post-call check | After any other call whose `meta.seq` changed: run `check_part.py --status --json --brief`, append `header + text` | The checker is; the hook, the `!`/`-` vocabulary, the `--json --brief` contract and the save gate are not. |
| Stateful diff | "! repaint: faces that were complete and grew" comes from comparing consecutive reports | Generic: the hook hands the checker the previous report. |
| Reply enrichment | `open`/`new` list the envelopes of every neighbour on the bone in BOTH frames; every cube add/resize reprints its face rectangles; `open_skin` appends the contrast rule | The content is; "put in the reply the numbers the agent would otherwise spend turns researching" is a rule. Antennae: "the envelope table replaced all neighbour research". |
| Batch painters | `armorpieces_paint {sheet, faces: {"cube.face": grey \| #hex \| [top,bottom] \| null}, pixels}`; `armorpieces_skin_paint {stamps:[{region, face, rows\|fill\|tile, shift}]}` — ASCII rows, `.` clear, space = leave alone, one undo entry | Half. Face-addressed painting is generic to every box-UV model; ASCII stamps by region/face are generic to any texture with named rectangles. The ramp semantics are theirs. |
| Picture shrink | Every image part through the proxy: crop to content (alpha bbox, else diff from corner colour), then resize to 384 longest edge, `ARMORPIECES_SHOT_MAX=0` to disable | Entirely generic. **The shim passes images through untouched** (`index.mjs` ~1420: "keeps `capture_screenshot`'s IMAGE content an image"), and our `screenshot` returns the native framebuffer. |
| Look-as-side-effect | `set_camera_angle` returns its own screenshot; `armorpieces_skin_material` returns its own screenshot — "step 5 is three calls, not six" | Generic rule: a tool that returns the picture the next call would ask for saves a turn. |
| Agent definition | `.claude/agents/part-author.md`: tool allowlist, what a finished unit IS, the traps, budget stated as "two or three paint calls and six pictures", order of work, "do not read authoring.md", write Lessons into the brief | The body is; the SHAPE is the template. |
| One session per unit | Fresh headless session per part, sequential (Blockbench's active tab races), brief in, Lessons out, lessons compound in the next brief | Generic for any repetitive authoring. Already in memory as [[one-session-per-part]]. |
| Seeded pin | `skin_sheets.py --seed <skin> --from netherite` + `shade_only:true` on every stamp: the silhouette is fixed, the agent only shades. Five skins, 971 texels each, byte-identical outline | The seed is; the principle — pin the part that needs judgement and a cheaper model does the rest — is the strongest cost lever they found. |
| Two-frame composite | `shoot_table.py`: one frame with the menu closed, one open; lift the screen's rectangle 1:1 from the open frame (GUI scale = `frame.width // get_screen(layout).width`) onto the undimmed world | Generic to any container-screen picture. |
| Cost analyser | `scratchpad/analyse.py <jsonl>`: turns, context per turn, cache-read total, pictures, calls per tool | Generic and **lost** — it lived in a scratchpad and is gone. |
| Tool rot | Nothing ran `tools/`; three checkers shipped broken in 0.2.0 | Generic: a check nobody executes is not a guard. |

## 3. What a VLM look misses, and what arithmetic catches

The user's own framing, and worth listing because it decides what belongs in a checker rather
than in a screenshot. Every one of these was invisible in the 3D view and found by a script:

- a face lying exactly on a shell plane (z-fights in game, looks fine in the editor);
- a plane shared with another part that can be worn at the same time;
- a face with NO paint behind it (renders as a hole), and its subtler twin: a face that was fully
  painted and then **grew** on resize — the check said ok because its test only fired on a wholly
  empty face; fixed by per-face coverage and the stateful "grew" diff;
- paint no face samples (work that will never be seen);
- colour on a sheet whose value is read as a ramp position;
- a static or mask pixel outside the master's silhouette;
- texels hidden by an outer shell ("leg: 48 painted texels hidden by boot, rows 6..8");
- a greyscale drawn inside a narrow band — reads in the editor, bakes flat on iron;
- a recipe centre already used by another template (two recipes, one grid, one unobtainable).

And the converse, which is the honest boundary: a boot drawn 96 texels above vanilla's line was
"legal, unremarked, and the sort of thing only a human look catches". Checks bound the search; the
picture is still the judgement, so the picture has to be cheap enough to afford.

The toolkit's entity `verify` (`blockbench/mcptoolkit_entity.js`) already has the first two, an UV
footprint audit and the opaque-count-vs-face-area proof. It lacks per-face coverage, "paint outside
every face", the grew-after-resize diff, and shell occlusion — the four that are still generic to
any box-UV model.

## 4. What the toolkit has, and the gaps

| Need | Toolkit today | Gap |
|---|---|---|
| Profile | Keep-list profiles, `tool_surface`, Blockbench gated per profile, `MCPTK_PROFILE` / `MCPTK_HIDE_TOOLS` | No PROJECT-defined keep-list; no description notes; no instructions paragraph. A project wanting a different Blockbench slice writes its own proxy — which is exactly what happened. |
| Check after edit | Entity `verify` on demand; `ui_doc lint` as an op | No post-call hook. No way for a project to say "after any edit, run this, append that". |
| Image cost | `render` defaults to a path (`inline:false`) and takes width/height/downscale — the right shape | `screenshot` returns the native framebuffer inline (a 3840×2131 dev window); Blockbench `capture_screenshot`/`set_camera_angle` images pass through untouched; no crop, no resize, no cost line. |
| Batch tools | `place_shapes`, `set_blocks`; the rule is known | The `art` arm re-exports Blockbench's per-stroke painters. No face-addressed or ASCII-stamp painter. |
| Agent/loop scaffolding | Agent-client adapter launches attended/headless; the survival charter + `run-loop.ps1` | Nothing for "one session per unit": no agent-definition template, no unit runner, no stream-json analyser. |
| Docs for consumers | `EXTENDING.md` (register Java tools), `LIVE_MODDING.md`, `docs/guides/ADAPTER.md` | Nothing says how to set a loop up, or what it costs, or which of the levers above to pull first. |

## 5. Proposal: the loop kit

Six pieces. The first three are shim features that cost **zero manifest entries** (the static
prefix is the per-turn tax, [[token-per-tool-handoff]]), so they are free to every profile. Ordered
by leverage over cost.

### 5.1 Image budget in the shim (smallest change, largest generic saving)

Every image part the shim returns — `screenshot`, `screenshot_annotated`, `render inline:true`,
and any Blockbench upstream image — goes through one step: crop to content, then resize to a
longest edge. Default 512; a knob per session (`MCPTK_SHOT_MAX`, `0` keeps them whole) and per
call (`max` on `screenshot`). Content crop as `shrink_shot.py` does it: the alpha bbox when there
is alpha and it is under 90% of the frame, else the bbox of pixels that differ from the corner
colour by more than a threshold. Done in Node with a pure-JS PNG codec (no native `sharp`; the
shim must keep starting from a fresh extract, [[bridge-port-direction]]'s whitelist lesson).

Append a cost line to the text part: `picture 221x384 ~113 tok (was 3840x2131); re-sent every turn
after this one`. The model can plan a budget only if it can see the price, and the brief's "six
pictures" rule needs a number to count.

Add `crop` to `screenshot`: a GUI-pixel rectangle, or a widget index / slot from `get_screen
layout`, scaled by `frame.width // screen.width`. That is the two-frame trick's cheap half — a
screen check wants the widget, not the 4K frame — and it is one argument on an existing tool.

Note the API's own downscale: anything over roughly 1568 px on the long edge is shrunk server-side,
so a 4K frame costs ~1.6k tokens rather than 11k. It is still ten times a cropped figure, and it is
still paid on every later turn.

### 5.2 Post-call checks: a project hook, mechanism-gated

A project file the shim reads, `.mcptoolkit/loop.json` beside `.mcp.json` (or `MCPTK_LOOP` naming
it):

```json
{
  "checks": [
    {
      "after": { "mechanism": ["world_edit", "asset_write"], "tools": ["place_cube", "modify_cube", "risky_eval"] },
      "run": ["python", "tools/check_part.py", "--status", "--json", "--brief"],
      "gate": ["armorpieces_save"],
      "timeout_ms": 5000
    }
  ]
}
```

- `after` selects by the mechanism the manifest already stamps, plus names for an upstream that
  has no stamps (Blockbench). Read-only calls never trigger — that is the READ_ONLY set, derived
  rather than hand-kept.
- `run` is a command whose last stdout line is JSON: `{ "text": "...", "problems": N, "notes": N,
  "full": "..." }`. The shim appends `text` to the reply and renders nothing else; the `!`/`-`
  vocabulary is the checker's, documented as the contract.
- The shim passes the previous report's path as `--previous <file>` when the checker declares
  `"stateful": true`, which is how "faces that were complete and grew" is a diff and not a memory.
- `gate`: tools that are refused while the last report has problems, unless the call carries
  `force` — the shim adds `force` to their schema and passes it through. This is the one place the
  hook edits a schema, and only for the named tools.
- A `run` can also be a Blockbench eval (`"eval": "mcptoolkitEntity({action:'verify'})"`), which is
  how the entity verify battery becomes per-edit under `art` without a second implementation.

### 5.3 Project profile: keep-list, notes, instructions

Same file:

```json
{
  "profile": {
    "base": "art",
    "keep": ["place_cube", "modify_cube", "add_group", "..."],
    "notes": { "place_cube": " In an Armor Piece put the cube in a bone group under `part`…" },
    "instructions": "Blockbench is running with the Armor Pieces plugin…"
  }
}
```

`keep` is a keep-list and declares its complement the way every profile here does (the price of a
keep-list is that a new tool stays hidden until named; that is the trade). `notes` are appended to
descriptions verbatim — a note is a per-turn cost too, so the `tool_surface` report prices them.
`instructions` is served as the MCP server's instructions. `tool_surface` with no arguments reports
the project profile like any other.

This is the whole reason ArmorPieces wrote a proxy: the Blockbench plugin cannot be extended and
the toolkit could not be told what to serve. With 5.2 and 5.3 the 1050-line `server.mjs` reduces to
its nine `armorpieces_*` tools — and those could be a `tools` entry in the same file naming a
script the shim spawns, but that is a second design and not this one.

### 5.4 Generic verify additions and batch painters (under `art` only)

In `mcptoolkit_entity.js` `verify`: per-face paint coverage (painted / area, "painted in part" as a
note), paint outside every face's rectangle, and shell occlusion where a rig declares nested
boxes. With 5.2 these ride on every edit.

Two painters, generic to box-UV models and textures with named rectangles, registered in the
toolkit's Blockbench plugin and served under `art` (two manifest entries, paid only there):

- `paint_faces {texture, faces: {"<cube>.<face>": value}, pixels}` where value is a colour, a
  `[top, bottom]` pair shaded row by row, or null — one undo entry.
- `paint_ascii {texture, at | region/face, rows, fill, tile, shift, palette}` — rows of characters
  through a palette map, space leaves a texel alone; `stamps:[…]` for a whole sheet in one call.

The design rule, written where tools are added (`ARCHITECTURE.md`): **price a tool by its arity**.
A tool that acts on one unit per call sets the session's price; the manifest entry is the other
tax, and the two are traded against each other, not ignored.

### 5.5 Unit-session scaffolding: template, runner, analyser

Shipped under `mcp-toolkit/tools/loop/` and documented in `docs/guides/LOOPS.md`:

- `agent-template.md` — the `part-author.md` shape with the armor taken out: tool allowlist, "what a
  finished unit is", the traps section, a budget stated in **calls and pictures**, order of work,
  "do not read the reference doc unless a reply sends you there", write Lessons into the brief.
- `run-unit.ps1 <agent> <brief> [-Model]` — headless `claude -p --agent … --output-format
  stream-json` with the watch-the-jsonl pattern (the background wrapper gets killed from outside
  the session; the child survives; `grep -a` because base64 images make the log "binary"), the
  post-checks the project names in `loop.json`, and the pause rule on API 5xx ([[pause-on-api-errors]]).
- `analyse.mjs <jsonl>` — turns, context per turn, cache-read total, pictures and their sizes, calls
  per tool, and the one line that matters: which tool was called most and whether it takes a list.
  This is the scratch script ArmorPieces lost, made durable.

### 5.6 The pin, as a documented pattern

Not a tool. In `LOOPS.md`: when a unit has a part that needs judgement and a part that is labour,
give the tool a way to **pin the judgement** (a seeded silhouette with `shade_only`; a `.ui.json`
layout the emitter honours; a pose the verify sweep holds), and the labour drops a model tier.
Their number: Sonnet at $0.78 against Opus at $2.28-5.65, with zero silhouette errors where free-form
had five. The pin is what made the cheaper model *correct*, not just cheaper.

## 6. What is theirs and stays theirs

The checkers (`trace_geometry`, `check_part`, `check_skin`), the ramp arithmetic, the rig, the
nine `armorpieces_*` tools, the anchor tables, the recipe-collision rule. The kit gives those a
place to plug in and nothing else. A project still writes its own checker, because the checks are
where the domain lives — the kit's promise is that the checker is one script with a JSON line at the
end, not a proxy server.

## 7. Order of work and arbiters

| Step | Builds | Arbiter |
|---|---|---|
| 1 | 5.1 image budget + `crop` on `screenshot` + cost line | probe: a 3840×2131 fixture in, ≤512 longest edge out, content bbox correct on alpha and on flat-ground frames; `MCPTK_SHOT_MAX=0` byte-identical; cost line present |
| 2 | 5.2 hook + gate | probe with a fake checker script: fires after `world_edit`, not after `observe`; appends the last line; `--previous` passed on the second call; gated tool refused then passed with `force` |
| 3 | 5.3 project profile | `profiles.test.mjs` extension: keep-list honoured, notes appended and priced, `tool_surface` reports it; conformance count unchanged for sessions without a loop file |
| 4 | 5.5 template + runner + analyser | analyser over one of ArmorPieces' surviving jsonl logs reproduces their published turn/cost figures |
| 5 | 5.4 verify additions + painters | `mcptoolkit_entity.test.mjs` fixtures: a planted half-painted face, planted stray paint; painter round-trip |
| 6 | 5.6 + `LOOPS.md` | ArmorPieces' proxy re-expressed as a `loop.json` and its nine tools, measured against one of their briefs at the same model |

Step 6 is the falsifier for the whole design: if their loop cannot be set up from the kit in an
afternoon with the same cost per part, the kit has missed something, and their record says what.

## 8. As built (2026-09-05, toolkit 0.122.0 / shim 0.56.0)

Every §5 piece exists. Where the build deviates from §5 it says so here; the changelog entry in
`build.gradle` is the per-file record and `docs/guides/LOOPS.md` is the how-to.

| § | Built as | Deviation from the design |
|---|---|---|
| 5.1 | `mcp-server/image/png.mjs` (codec on zlib), `image/budget.mjs` (`contentBox`, `resize`, `apiTokens`, `budgetContent`); `MCPTK_SHOT_MAX` default 512; `screenshot {max, crop}`; every `_image` reply and every Blockbench picture through `finishReply` in `index.mjs` | Default longest edge 512 as designed (ArmorPieces used 384). The cost line reports the API's OWN price — a 4K frame is ~1533 tok after the API's downscale, not 11k — so "was" is what would actually have been paid. Interlaced PNGs pass through untouched with the reason on the line. |
| 5.2 | `mcp-server/loop/loop.mjs`: `loadLoop`, `fires`, `LoopChecks.after/gate`; Blockbench stamped `observe`/`blockbench_edit` from `upstream/blockbench.mjs BLOCKBENCH_READ_ONLY` | `after.mechanism` gained the value `blockbench_edit` (the design named upstream tools one by one); `after.not` subtracts names. `force` is a STRING (the reason) and is stripped before any upstream that did not declare it, because ArgCheck refuses undeclared arguments. A check that cannot run is reported on the reply, not swallowed. A malformed file refuses to start the shim. |
| 5.3 | `profile: {base, keep, notes, instructions}`; profile name `project`, the launch default when the file declares one; `effectiveProfile()`; kept-name typo warning; `tool_surface` prices notes | `base` also decides the Blockbench gate when there is a keep-list. Notes apply to every profile the session serves, not only `project` — they are the workspace's sentences. |
| 5.4 | `mcptoolkit_entity.js`: `faceRects`, per-face `faces[]`, findings `unpainted` / `stray` / `regrown`, note `partial`; `check` action = the §5.2 contract; `local/paint.mjs` `paint_faces` + `paint_ascii` (with `look`, `shade_only`) served under `art` and project keep-lists | Shell occlusion NOT built: no rig declares nested boxes yet. `previous` is explicit (`opts.previous`), never the plugin's `lastReport` — the implicit form made the harness order-dependent. Painters are LOCAL shim tools composing one `risky_eval`, not plugin registrations: the Blockbench MCP plugin cannot be extended. |
| 5.5 | `mcp-toolkit/tools/loop/agent-template.md`, `run-unit.ps1`, `analyse.mjs` | The analyser reads Claude Code transcripts as well as stream-json. Its "THE LINE" skips harness tools (Bash/Read/Write…). |
| 5.6 | `docs/guides/LOOPS.md` §5; `ARCHITECTURE.md` "price a tool by its ARITY"; `tools/loop/examples/block-model.loop.json` + `check-block-model.mjs` | AS SHIPPED IN 0.122.0 the example was `armorpieces.loop.json`, and its `run` pointed at a one-line wrapper (`tools/check_active.py`) that existed in nobody's tree: their checker takes the piece DIRECTORY from a meta.json the plugin writes. Replaced 2026-09-08 (0.140.0, `TODO.md` 1.8) by a generic block-model example that ships its own checker, and `probes/loop-examples.test.mjs` now resolves every shipped example's keep-list, gate and `run` script against the live manifest. |

Found on the way: `upstream/blockbench.mjs` had never been in the `mcp-server-dist` include
whitelist, so every fresh extract since 0.108.0 would have died at import time. Fixed with the new
`image/` and `loop/` directories.

Offline arbiters, all green on 2026-09-05: `probes/image-budget.test.mjs` (3), `probes/loop-hook.test.mjs`
(4), `probes/loop-profile.test.mjs` (4), `probes/paint-code.test.mjs` (4), the existing offline
profile probes (9), and `blockbench/mcptoolkit_entity.test.mjs` (ALL OK, sections 6d′/6d″ new).

## 9. Testing session: what is owed, in order

Nothing below has run against a live game or a live Blockbench. Each item names the arbiter.

1. **Rebuild and extract.** `tools/rebuild.ps1` (never `gradlew build` with a dev game up). Then a
   fresh extract of the dist must START — the whitelist fix is the claim: `node <extract>/mcp-server/index.mjs`
   with no game up prints the profile line and `bridge unreachable`, not an import error.
2. **The budget on a real frame.** Dev client in a world: `screenshot` → the picture is ≤512 on its
   long edge and the reply carries `picture WxH ~N tok (was 3840x2131 …)`. `screenshot {max:0}`
   → the native frame. `screenshot {crop:{widget:0}}` on the title screen → a picture of the first
   button with a 2px GUI margin. Then `render {inline:true}` and, with Blockbench open under `art`,
   `capture_screenshot` — both shrunk. Failure mode to look for: a dark-themed Blockbench viewport
   whose corner colour is not the ground (the crop would be wrong, not missing).
3. **The painters against real Blockbench.** `art` profile, a box-UV project open: `paint_faces
   {faces:{"<cube>.north":"#ff0000"}, look:true}` → the face is red in the viewport picture that comes
   back on the same reply, and ONE ctrl+Z undoes it. Then `paint_ascii` with `shade_only:true` over an
   already-painted face → only opaque texels change. The unverified surface is `texture.edit(cb,
   {use_cache:true})` and `Undo.initEdit({textures, bitmap:true})` (see `local/paint.mjs code()`);
   if either name is wrong the reply says `Error executing code: …` and the fix is in that one
   function.
4. **The entity check as a per-edit hook.** A `.mcptoolkit/loop.json` in `mcmodding/` (or any
   workspace) with `{"checks":[{"name":"entity","after":{"mechanism":["blockbench_edit"]},"eval":"mcptoolkitEntity({action:'check', previous: __previous})","stateful":true}]}`,
   Blockbench open with `mcptoolkit_entity.js` installed and a model loaded: every `place_cube` /
   `modify_cube` reply ends with `verify <model>: … problem(s)` or `ok`. Resize a fully painted
   cube → the NEXT reply says `! regrown …`. That is the finding this whole kit exists to make.
5. **The gate.** Add `"gate":["risky_eval"]` to that check, leave a problem standing, call
   `risky_eval` → `gated: "risky_eval" refused …`; call again with `force:"testing"` → proceeds,
   reply ends with `forced past …`.
6. **The project profile in a real workspace.** Copy `tools/loop/examples/armorpieces.loop.json` to
   `ArmorPieces/.mcptoolkit/loop.json`, write their `tools/check_active.py` (read meta.json, exec
   `check_part.py --status <dir> --json --brief`), unset `MCPTK_PROFILE`, start a session: stderr
   says `profile: project (dev)`, the tool list is their 43 names, `place_cube`'s description ends
   with their note, and `tool_surface` reports `loop.notes: 3`. This needs the rebuilt jar extracted
   into `ArmorPieces/run/mcptoolkit/` — their `.mcp.json` runs the shim from there.
   *(2026-09-08, 0.140.0: that file has left the repository — `TODO.md` 1.8. Re-running this step
   today means copying `tools/loop/examples/block-model.loop.json` and `check-block-model.mjs` into
   any mod workspace's `.mcptoolkit/`; §10's record of what the ArmorPieces copy did stands as
   written.)*
7. **The falsifier (§7 step 6).** With 6 in place, `tools/loop/run-unit.ps1 -Agent part-author
   -Brief <one of their finished briefs>` at the model that brief was run at, and
   `analyse.mjs` over the log against their published figure for that part (§1). If the kit cannot
   match it, their record says which lever is missing. This is the only measurement in the design and
   it has not been taken.
8. **`run-unit.ps1` itself** has never executed end to end; step 7 is its first run. Watch for the
   stdin handoff of the brief and the stream-json tail on a base64-heavy log.

## 10. Tested (2026-09-06, toolkit 0.123.0 / shim 0.57.0)

Every §9 item ran against the live dev client (MC 26.2, 1920x1057 window) and the live Blockbench
5.1.6 with the MCP plugin 1.6.1, driven by a scratch stdio driver on `probes/loop-harness.mjs`
(`spawnShim` against the real bridge and the real Blockbench). Results, in §9's order:

| § | Result | What it found |
|---|---|---|
| 1 | PASS | Fresh extract of the 0.122.0 jar starts: profile line, then `bridge unreachable` on a dead port. The 0.85.0-era extract in ArmorPieces had ONLY `index.mjs` at top level. |
| 2 | PASS | `screenshot` 1920x1057 → 512x282, `~1533 → ~193 tok`; `max:0` native; `crop:{widget:N}` gives the widget with its 2 GUI-px margin; `render inline` 1024x768 → 512x384; Blockbench `capture_screenshot` 1020x946 → 512x475. The dark-viewport corner case did not arise (light theme); a `paint_faces look` on the test model cropped to 1-5% of the frame. |
| 3 | PASS after two fixes | (a) The plugin's `risky_eval` REFUSES code containing `//`, `/*` or `console.` - two comment lines inside the template died on the first call. (b) `texture.edit(cb, {no_undo, use_cache})` is Blockbench's brush-stroke branch: it refreshes the material but not `texture.source`, so the viewport showed the paint and `get_texture` (= `getDataURL()` = `source`) returned the pre-paint sheet. Dropped `use_cache`; `Painter.edit` then calls `updateChangesAfterEdit`. After both: face red on the `look` picture, ONE `undo` named `paint_faces` restores it (canvas back to 0 opaque), `get_texture` agrees with the canvas, `paint_ascii shade_only` over a 4x4 face painted 1 and skipped 3. (c) The budget cropped the 16x16 `get_texture` sheet to 12x12: a texture is an ADDRESS SPACE, so `CONTENT_CROP` in index.mjs now names the frames that may be cropped (screenshot, render, screenshot_annotated, the Blockbench captures, the painters' look) and everything else is resized at most. |
| 4 | PASS | With `{"checks":[{"after":{"mechanism":["blockbench_edit"],"tools":["paint_faces","paint_ascii"]},"eval":"mcptoolkitEntity({action:'check', previous: __previous})","stateful":true}]}`: every `paint_faces`/`modify_cube`/`place_cube` reply ends with `verify <model>: … problem(s)`; growing a fully painted cube put `! regrown bb_main/body.north 24/32 px … was complete and GREW` on THAT reply and `- partial` on the next. Found on the way: Blockbench had the entity plugin loaded from before `check` existed and its `{"ok":false,"error":"unknown action"}` envelope rode every reply AS A REPORT - loop.mjs now treats a JSON last line without `text`/`problems` as "could not run". Also: `__previous` is now serialised with `/` escaped and an `eval` containing a comment is refused at load, both for the same filter as 3(a). |
| 5 | PASS | `gate:["risky_eval"]`: first call passes (no report yet), after a check with 4 problems `gated: "risky_eval" refused - 4 problem(s) stand …`, with `force:"testing"` it runs and the reply ends `forced past 4 problem(s) from "entity": testing`. |
| 6 | PASS | ArmorPieces with the example loop file and `tools/check_active.py` (written: reads the plugin's `current.json` → `meta.json`, dispatches `check_part.py`/`check_skin.py --status <dir>`, swallows `--previous`): stderr `profile: project (dev) … base art, 43 kept, 3 description note(s)`, 44 names served, `place_cube` ends with their note, `tool_surface` reports `loop.notes: 3, notes_approx_tokens: 203`. Their extract at `run/mcptoolkit/mcp-server` was refreshed from the 0.122.0 jar (old copy kept as `mcp-server.pre-0.122.0`). |
| 7 | DEFERRED | All 55 part briefs are shipped parts; a run re-authors one in their live, dirty tree (91 parts, uncommitted work). Decided 2026-09-06: the measurement is taken when ArmorPieces' NEXT new part is written - a fresh brief through `part-author-kit`, compared with §1 - rather than re-authoring a shipped one. Ready: `.claude/agents/part-author-kit.md` (their part-author with the 43 names on `mcp__mcptoolkit__` and the nine `armorpieces_*` on the proxy). Caveat: their proxy under `authoring` still serves the Blockbench tools too, so a fair prefix needs a proxy profile that serves only the nine. |
| 8 | PASS after three fixes | First run on a read-only smoke brief (Haiku, $0.03): stdin handoff and the stream-json tail worked, and (a) every MCP call was refused - a headless session grants nothing; the agent's `tools:` line is now passed as `--allowedTools`. (b) The pause rule's bare `5\d\d` matched digits in a message id and paused on that refusal; named error types only now. (c) stream-json writes one `assistant` line PER CONTENT BLOCK with the same message id and usage, so runner and analyser counted 12 turns for 6 calls and summed usage twice; both count ids now. Second run: 3 calls, 4 turns, harness and analyser agree. |

Offline after the fixes: image-budget 4, loop-hook 6, loop-profile 4, paint-code 5, profiles 9 (39
green), entity harness ALL OK. The analyser's earlier figures over ArmorPieces' transcripts were
inflated by (8c) and the memory's "checked on their transcripts" should be read as "runs on them".

## 11. Falsified (2026-09-06, ArmorPieces' beast_head; toolkit 0.124.0 / shim 0.58.0)

§9 item 7, run by ArmorPieces on their side: their next new part (`beast_head`, a pauldrons part
with four bones in a rotated chain, a gemstone mask, and a brief that constrained its width),
authored through `part-author-kit` at `claude-opus-5` — the loop file serving the Blockbench slice,
their proxy under a `kit` profile serving only the nine `armorpieces_*` tools. Their report is the
"Loop Kit Falsifier" artifact; the session log is
`ArmorPieces/.mcptoolkit/runs/part-author-kit-beast_head-20260906-113202.jsonl`, and the numbers
below are from `analyse.mjs` over it after the fix in finding 8. Their arbiter:
`node tools/mcp/check_kit.mjs`, 18 assertions green; pricing from `tools/mcp/price_profile.mjs`.

**The verdict: the kit passes, and the example file it shipped would have failed it.**

| Part | Path | Turns | Paint calls | Harness cost | Wall | Saved |
|---|---|---|---|---|---|---|
| Spire | proxy, before the batch painter | 144 | 82 | $5.08 | 10 min | after a repaint pass |
| Antennae | proxy + `armorpieces_paint` | 42 | 2 | $2.01 | 4.5 min | first try |
| Beast Head | kit split | 33 | 3 | $3.70 | 12 min | first try, no force |

Read honestly: Beast Head is the harder unit and its 33 turns include four Bash turns for the
repository checks and the turn that wrote the brief's Lessons. The turn count is the comparable
number and it is better; the dollar figure is not like-for-like, and $1.33 of it is output and
thinking (53,325 tokens, 44,549 of them thinking) that the analyser could not see until finding 8.
The brief's constraint was met: the shipped Beast Head spanned 23.60 across the figure, wider than
every other part on the socket; this one spans 20.00 - narrower than spaulders - while reaching 1.3
further forward, because "a rotated bone reaching forward costs nothing on the socket's width
budget".

### 11.1 Where a turn's tokens go

| Component | Tokens | Where it lands |
|---|---|---|
| Turn 1, everything | 25,170 | harness prompt + built-in tools + agent + brief + both MCP manifests |
| — the two MCP servers | 8,630 | ~34% of turn 1, ~11% of the session mean |
| Check blocks appended to replies | 3,353 | 18 replies, avg 186 - permanent, re-sent every turn after |
| — of which the sheet-layout block | 491 | 8 replies; this replaced the neighbour-research turns |
| All tool results, text | 15,806 | the conversation body |
| 5 pictures, as sent | 910 | ~12,740 re-sent across the turns after them |
| Session total context | 2,620,387 | 33 turns, mean 79,406 |

Two conclusions this document had not stated. The manifest is a third of the opening turn and a
tenth of an average one: worth trimming, not the story. And a check on every reply is not free -
3,353 tokens of check block stay in the conversation for the session - and it still pays (one
COPLANAR line on the first cube pass meant no nudging pass on any of four bones), but "worth more
than a check on demand" deserves that number beside it.

### 11.2 The prefix, three ways (tokens on every turn)

| Keep-list | Tools | Tokens |
|---|---|---|
| The proxy's `authoring` profile alone | 46 | 10,373 |
| The kit as shipped: proxy `kit` + the 0.122.0 example loop file | 53 | 12,499 |
| The kit as tuned: trimmed keep-list, all 13 notes | 39 | 8,630 |

The kit as shipped would have ADDED ~2.1k tokens to every turn; tuned, it takes ~1.7k off. In
money that swing is about nine cents over a 33-turn session at cache-read rates: the manifest is
the lever easiest to measure and among the least valuable to pull. The levers that moved this
session were the batch painter (82 paint calls → 3) and the check that made a second modelling
pass unnecessary.

### 11.3 The nine findings, and who fixed what

| # | Where | Finding | Fixed |
|---|---|---|---|
| 1 | example loop file | Kept the `art` base whole: seven `mem_*`, five game-bridge tools and the two generic painters in a session that never starts a game - ~3.7k tokens a turn for tools no part author calls; `render` alone 1,020. | Theirs, in their loop file; the example here is now their tuned file. |
| 2 | example loop file | Ten of the proxy's thirteen description notes were dropped - the trap notes (the ghost cube an undo leaves, the fill that floods the sheet, the group rename that dies in the undo snapshot). A note is a per-turn cost; a trap is a session. All thirteen: 203 tokens. | Theirs; the example carries all thirteen. |
| 3 | `index.mjs`, `local/paint.mjs` | The shim's own painters never fired the shim's own check: a local tool was stamped `local`, so `after: {mechanism: ["blockbench_edit"]}` - the documented shape - skipped `paint_faces` and `paint_ascii`. §10's live test had hidden it by naming both in `after.tools`. | **Toolkit 0.124.0**: a local tool carries the mechanism of the upstream it edits; `local` is refused at load; `loop-hook.test.mjs` fires the check after both painters with nothing named. |
| 4 | `loop/loop.mjs` gate | A gate naming a tool the shim does not serve (`armorpieces_save`, the proxy's) is silently inert - a guard that is a line in a file. | **Toolkit 0.124.0**: stderr once the manifest is known, same shape as the keep-list typo warning; their loop file drops the entry and says why. |
| 5 | `stateful` | Two histories over one unit: each shim gets its own previous report, and a project whose own server runs the same checker gets a second - paint through the proxy, grow through the shim, and the regrow diff compares against a state where the face was never painted. Proved live. | Theirs: `check_active.py` owns one history beside the piece's status directory and ignores `--previous`. **Toolkit**: documented in `loop.mjs` and LOOPS.md - a checker with two callers owns its history. |
| 6 | §2 "reply enrichment" | Named as a rule, given no seam; the proxy printed the face rectangles of every cube whose net moved. | Theirs, inside the checker's `text` (491 tokens over 8 replies; no neighbour research all session). **Toolkit**: LOOPS.md now says the check's `text` IS the seam. |
| 7 | `run-unit.ps1` | The after-the-fact check cannot pass for an active-unit checker: a well-behaved session closes its tab last, so "whatever is open" is nothing. The run ended on a warning that was an artefact of finishing correctly. | **Toolkit 0.124.0**: `MCPTK_UNIT` (the brief's stem) in the session's and the last check's environment; a run check that reads editor state falls back to it. |
| 8 | `analyse.mjs` | The cost line read about half the true cost ($1.95 vs $3.70): stream-json's per-message usage carries 179 output tokens over 33 turns; the result line's `usage` says 53,325. | **Toolkit 0.124.0**: the harness's `total_cost_usd` leads; the estimate is priced on the result line's totals, with 1-hour cache writes at 2x - it now matches the harness to the cent on this log; a per-message output count implausible for the turn count is flagged. |
| 9 | `image/budget.mjs` | The default picture budget (512) was looser than the measured one (384): ~324 tokens a look on a Blockbench viewport instead of ~182, paid again on every later turn. | **Toolkit 0.124.0**: default 384; the probe pins 512 explicitly where it prices it and pins the default by itself. |

### 11.4 What the kit got right

- The image budget, priced on the reply: 1020×946 (~1,287 tok) becomes 384×356 (~182 tok) and
  the reply says so; the analyser's picture table is what makes a brief's "six pictures"
  enforceable. Their Lessons: three of the five looks were wasted.
- Failing loudly: a check that cannot run is reported on the reply, which is what surfaced
  finding 7 within a second of the session ending.
- `after.not`: excluding the two look tools is one line and a checker run saved per look.
- The wrong-game warning: `MCPTK_URL` 25599 was bound by another project's dev game and the shim
  said so; trimming the game tools out of the keep-list makes it moot.

### 11.5 Still owed

- A same-brief A/B (LOOPS.md, Owed): this compares a kit run against a published figure for a
  different part.
- `look` on `armorpieces_paint` - theirs; the generic painter cannot replace a painter that folds
  colour to a material ramp.
- Their side is uncommitted (as is their 0.4.0); the toolkit's fixes reach them through a rebuilt
  jar extracted into `ArmorPieces/run/mcptoolkit/`, which has not been done for 0.124.0.

## 12. 2026-09-07: the painters moved into the toolkit's own Blockbench plugin (0.133.0)

Section 5.4's "registered in the toolkit's Blockbench plugin" is finally literal. `local/paint.mjs`
composed a `risky_eval` string because the third-party plugin could not be extended; that plugin is
replaced by `blockbench/mcptoolkit_bridge.js` (BLOCKBENCH_BRIDGE_DESIGN.md), `paint_faces` and
`paint_ascii` are its tools with the same arguments and the same reports, and the three findings
this design carried about it close by construction: finding 3 (a local tool's mechanism) has no
local Blockbench tool left to apply to, the comment filter that forced `__previous` to escape its
slashes is gone, and the active-tab race behind "one session per unit, sequential" (section 11.1)
is a queue with session-bound projects. `probes/paint-code.test.mjs` went with the local painters;
the arithmetic is asserted in the plugin's own harness. The example loop file in `tools/loop/
examples/` is left as ArmorPieces tuned it on 2026-09-06; its brush-tool names map onto the
plugin's `texture` tool by the table in the design's section 5.

**Corrected 2026-09-08: leaving it was a mistake, and it is now `TODO.md` 1.8.** "Maps onto by the
table" is a thing a READER can do and the shim cannot: `profile.keep` is the served set outright
(`keep.has(name)`, `index.mjs:1194`), so the thirteen old names resolve to nothing and the ten tools
that replaced them - `texture`, `element`, `paint_faces`, `paint_ascii`, `inspect`, `create_texture`,
`apply_texture`, `export_model`, `animation`, and `project` - are simply not served to anyone who
copies the file. The dead names warn on stderr (`index.mjs:1466`); the missing ones are silent
(`index.mjs:1490` is that same lesson, learned once already for the default profile). It also
re-adds `trigger_action`, which `art` excludes on purpose. The entry above was a note about another
repository's file, which is why it never became work - an example a modder copies is OUR file
whoever tuned it.

**SHIPPED 0.140.0.** `armorpieces.loop.json` left the repository; `tools/loop/examples/
block-model.loop.json` and its checker `check-block-model.mjs` replace it, and
`probes/loop-examples.test.mjs` resolves every shipped example's keep-list, gates and `run` scripts
against the live manifest. `TODO.md` 1.8 records what is built and what is still owed (nobody has
run the new example against a live Blockbench yet).

**Decided the same day: a generic example replaces it, and this one is dropped rather than migrated
or kept as a case study.** ArmorPieces is a separate project; MMCP ships its own generic Minecraft
examples. Section 5.6's row and step 6 of section 9 both name the old file and want the new one -
and 5.6 already records the other half of why it was a bad file to hand a modder: its `run` points
at a `tools/check_active.py` that exists in nobody's tree, so the checks never ran either.
