# Structure authoring — what BuilderGPT does, what this toolkit already does, and the one thing to build

Written 2026-08-17 from a user question: *"compare `mk-pmb/minecraft-buildergpt` against current
capabilities in mcp-toolkit and review usability — also for corridor rooms/structures."*

**Verdict up front: there is nothing in BuilderGPT to adopt as code, and one idea in it worth taking
as a shape.** The toolkit is already strictly ahead on every axis that matters, and the gap that
does exist is not a capability gap — it is a **call-count** gap, which on this project's own
measurements is the expensive kind. §4 is the proposal; everything before it is why.

> **AS BUILT + MEASURED — 2026-08-17, toolkit 0.76.0.** §4 is built: `place_shapes` is registered, all
> five design rules hold, and the dry-run trap was solved properly (an overlay of pending writes)
> rather than disclaimed. §6 records what the build changed about the design. §5's three
> non-recommendations stand and nothing in them was built. **§7 is the measurement §4 owed, and it is
> run**: turns fell 3.9× on every seed and the model planned ahead unprompted — but the token bill
> fell far less than the turns did, and the tool's own schema costs 954 tokens on *every* turn of
> *every* session. The engine is right; the description is now the expensive part.

---

## 1. What was actually reviewed, because the link is stale

`mk-pmb/minecraft-buildergpt` is a **fork, last pushed 2024-11-30**, of `CyniaAI/BuilderGPT`
(163★, Apache-2.0). The parent has moved on: last push 2026-02-22, rewritten in **JavaScript**, and
re-described as *"a generative Minecraft structure tool for the Cynia Agents framework."* The fork is
the old Python/tkinter build and is what the following describes; the parent's rewrite was not read,
and if this is revisited it is the parent that should be.

**Read from the fork:** `core.py` (the whole engine, ~230 lines) and `config.yaml` (which is where the
prompts live, so it is the actual design document).

## 2. What it does, exactly

One LLM call. The system prompt asks for:

```json
{"structures":[
  {"block":"minecraft:oak_planks","type":"fill","x":0,"y":0,"z":0,"toX":4,"toY":0,"toZ":4},
  {"block":"minecraft:oak_door[half=lower]","type":"setblock","x":2,"y":0,"z":0}
]}
```

`core.py:text_to_schem` then loops that into `mcschematic` and writes `.schem`, or writes
`setblock` lines into `.mcfunction`. "Advanced mode" is: description → GPT expands it into an
architectural brief → DALL·E renders an image of it → GPT-4-Vision looks at the image → the **same
JSON**. The image is a prompt-enrichment device; nothing ever looks at the built result.

So the whole system is: **an LLM emitting fill/setblock ops into an axis-aligned box, once, blind.**

**Five defects visible without running it**, listed because they are the reusable part:

1. **No feedback loop of any kind.** The model never sees what it built. There is no read-back, no
   re-render, no retry, no diff. Every failure mode is a silent one.
2. **No block-id validation, by default, on purpose.** `GIVE_GPT_BLOCK_ID_LIST: False`, with the
   config's own reason: *"Costs more (+$0.016 per gen)."* A `block_id_list.txt` ships in the repo and
   is opt-in. So invalid ids are the expected case and `mcschematic` is the only thing that notices.
3. **The prompt's coordinate frame is wrong for Minecraft.** *"X denotes width, Y denotes depth, Z
   denotes height"* — in Minecraft Y is height. Both the base and the vision prompt say it. A model
   that obeys the prompt builds the structure lying on its side; a model that ignores it and uses its
   own Minecraft prior builds it upright. Nothing detects which happened.
4. **The shipped example is malformed** — `"minecraft:minecraft:oak_door[half=lower]"`, a doubled
   namespace, inside the few-shot every generation is conditioned on.
5. **No anchor, rotation, palette or site abstraction.** Output is a raw box at origin. Placing it
   somewhere real, facing something, in a world with a different material vocabulary, is entirely the
   user's problem afterwards.

## 3. Against this toolkit

Every column below was checked in `src/main/java/com/mattmc/mcptoolkit/`.

| | BuilderGPT | mcp-toolkit |
|---|---|---|
| write primitives | `setblock`, `fill` (box only) | `set_blocks`, `place_shape` — box / line / cylinder / ellipsoid, `mode` solid \| hollow \| frame \| walls, `thickness`, `axis` |
| write control | none | `replace` mask, `air_only`, `dry_run`, per-`dimension`, `MAX_BLOCKS` ceiling |
| result honesty | none — writes are assumed | returns `placed` / `skipped` / `truncated` / `unchanged` / `rejected`; **only confirmed writes count as placed** |
| undo | none | `undo_edit` + `list_edits`, backed by `EditJournal` |
| read-back | **none** | `get_blocks_at`, `describe_box`, `get_region_summary`, `raycast`, `raycast_fan`, `get_surface` |
| see it | a DALL·E image of the *prompt* | `screenshot`, `screenshot_annotated`, `get_screen`, `get_screen_graph` — of the **actual build** |
| siting | none | `check_site`, `check_layout`, `resolve_anchor`, `anchors` |
| persistence | `.schem` on disk | `save_building` / `import_building` / `list_buildings` / `edit_building` (`villagejobs/build/`) |
| authoring loop | none | `BuildingEditor` (`/vjedit`, `/vjframe`), `EditorWorld` — a fresh void world per session |
| placement | none | `StructurePlacer`, `Rotations`, `SiteCheck`, `TemplateBlueprint`, `CodeBlueprint` |

**The decisive difference is one row.** BuilderGPT's model is blind; the toolkit's model is embodied.
Everything else follows from that — validation, retry, and iteration are all things you can only do if
you can look. This project's whole thesis is that loop, and BuilderGPT is the control experiment for
it: the same LLM, the same block vocabulary, no eyes.

**On usability for corridor rooms specifically it is worse than for a standalone building.**
`rocketeer/CORRIDOR_THIRD_PASS.md` has already decided the shape — *the pure layer owns the envelope,
an authored `.nbt` owns the interior* — and names `villagejobs/build/` as the authoring tool. A
`.schem` from a blind LLM would need format conversion, a palette swap, and socket anchoring, and it
**cannot know the envelope it has to fit**. The `CorridorSocketBlock`-marker-extracted-at-bake-time
trick that pass depends on is precisely the thing an external generator cannot produce.

## 4. The one idea worth taking: batch the shape ops

**What BuilderGPT gets right is that `fill` is the unit, not `setblock`.** The toolkit already agrees —
`place_shape` *is* that primitive. Where BuilderGPT is ahead is that its model emits **an arbitrary
number of fills in one response**, and the toolkit's model emits **one shape per tool call**.

A forty-fill building is forty round trips. That is not a token-per-result problem, it is a
**turn-count** problem, and `TOKEN_PER_TOOL_FINDINGS.md` finding 1 is the reason it matters:

> `weight(call) = result_tokens × (turns the result stays in the context window)`
> … the static prefix is re-read **every turn**: 92% of the bill on short sessions, 50% on long ones.

So each extra turn re-pays the entire system prompt and every tool schema. Forty turns to build one
room pays that forty times, and thirty-nine of those turns carry no new information — the model
already knew all forty shapes when it emitted the first one.

### Proposal — `place_shapes` (plural), one call, N ops

```jsonc
{
  "ops": [
    {"shape":"box","block":"minecraft:deepslate_bricks","p1":{...},"p2":{...},"mode":"walls"},
    {"shape":"cylinder","block":"minecraft:polished_deepslate","center":{...},"radius":3,"height":8},
    {"shape":"box","block":"minecraft:air","p1":{...},"p2":{...}}          // subtractive, and ORDER MATTERS
  ],
  "dimension": "minecraft:overworld",
  "dry_run": false
}
```

**Design rules, each with a failure behind it:**

- **Ops apply in array order and the doc must say so.** Carving air after laying stone is the normal
  way to author a room; a parallel or reordered implementation silently produces a solid block. Order
  is part of the contract, not an implementation detail.
- **One `undo_id` for the whole call.** The batch is the unit a person would want to revert. Reusing
  `EditJournal.recorder` once for the call rather than once per op gets this for free and is also the
  cheaper implementation.
- **`MAX_BLOCKS` is a budget over the CALL, not per op**, and the response says which op the budget
  ran out on. A per-op ceiling with no aggregate is how one call locks the server.
- **Per-op results, not one total.** Return the existing `placed` / `skipped` / `unchanged` /
  `rejected` per op plus the union `region`. A single total cannot answer *"which of my forty fills
  did nothing"*, which is the only question worth asking after a batch.
- **`dry_run` applies to the whole batch** and must simulate the ops **against each other** — an
  op-by-op dry run against the live world reports the wrong counts for anything that overlaps, which
  is most of a building. If that is too expensive to do properly, the honest move is for `dry_run` on
  a batch to report bounds and per-op raw volumes and to **say** it does not model overlap. A number
  that looks like a block count and is not one is worse than no number.
- **It does not replace `place_shape`.** One shape is the common case and a one-op array is a worse
  ergonomics for it. Keep both; `place_shapes` delegates to the same `Op` machinery in
  `ShapeTools.java`.

**Cost:** small. `ShapeTools.placeShape` already builds an `Op`, resolves the state, opens a recorder
and dispatches on `shape` — the batch version is a loop over that with a shared recorder and a shared
budget. The schema is the existing `shapeSchema()` minus `dimension`/`dry_run`, in an array.

**What it is worth measuring afterwards**, because this project does not ship unmeasured claims:
turns-to-build and total `cache_read` for one authored room, batched vs. not. The prediction is that
the win is nearly all in turn count and nearly none in result bytes. If it is not, the model was not
planning ahead, and *that* is the finding.

> **→ MEASURED in §7.** The turn half was right (3.9× fewer, every seed) and the model *did* plan
> ahead. The token half was **wrong**: `cache_read` fell ~45% on the mean and ~0% on the median seed,
> because a batch trades many thin turns for few fat ones. §7 also prices what this section never
> costed — the tool's own schema, 954 tokens on every turn of every session.

## 5. What was explicitly NOT recommended

- **Adopting BuilderGPT's JSON as an interchange format.** It has no palette, no anchor, no rotation
  and no metadata, so it is strictly poorer than `save_building`'s stored form and than a vanilla
  `.nbt`. Its only advantage is being LLM-writable, and `place_shapes` gets that without the format.
- **An image-generation stage.** DALL·E → Vision → JSON is a way to enrich a prompt when you cannot
  see the result. The toolkit can see the result. Spending a diffusion call to hallucinate a reference
  that the builder cannot actually match is strictly worse than one `screenshot` of the real thing.
- **A natural-language "build me a X" tool.** That is a prompt, not a tool. The toolkit's job is to
  give a model hands and eyes; deciding what to build is the model's.

## 6. What building it changed — 2026-08-17, toolkit 0.76.0

`ShapeTools.java` now registers two tools over one engine. All five §4 rules hold as written; what
follows is only what the build learned that the design did not already say.

**The dry-run trap was real, and it fails in *both* directions.** §4 predicted overlapping ops would
be over-counted, so the fix was expected to be a subtraction. Writing the test showed the opposite
error is the more likely one in practice: the *canonical* authoring move is `box stone`, then
`box air` inside it, and an op-by-op dry run against the live world reads that carve as "already air"
and reports **0 placed** for it — silently omitting the entire interior from the preview. Over-count
and under-count in the same two-op batch.

Both come from the same cause, so both take the same fix: `Batch` carries a
`Long2ObjectMap<BlockState>` **overlay** of pending writes, and a dry-run op reads the overlay before
the world. A live run needs none — `level.getBlockState` already reflects every op before it, which
is exactly why the honest preview is the one that reproduces that property. The overlay is bounded by
the block budget, which is what bounds its memory.

**The probe therefore asserts `DRY == LIVE`, not a hand-computed number.** A preview's whole job is to
predict the run. Comparing it against a constant tests the constant; comparing it against the live
call tests the claim. `mcp-server/probes/place-shapes.test.mjs` runs the same three-op batch both ways
and compares per-op counts and the union region.

**A discrepancy older than the batch fell out of the same fix.** A thick `line` revisits its own
cells: the live run buckets the repeats as `unchanged`, and the old single-shape `dry_run` counted
them as `placed`. `place_shape`'s preview has therefore been over-reporting thick lines since it
shipped, and nothing noticed because nothing compared the two numbers. Now they agree — the one
behaviour change to the singular tool.

**Two accepted-and-ignored arguments, closed on the way past.** Neither was in the design; both were
found by asking what the batch does with an argument it has no use for.

- An op carrying the per-call `dry_run` or `dimension` is **refused**, naming the op. Silently
  dropping a per-op `dimension` is a write into the wrong world reported as success.
- `line` **refuses** a `mode`. It never had a fill/shell distinction — it takes `thickness` — and it
  used to accept any mode and ignore it. Shape/mode validity now lives in one table (`MODES`), which
  is also what lets a batch reject a bad mode before it writes anything; the generators' own switches
  are now invariant guards rather than user-facing checks.

**Parse is now separated from execute.** §4 said order is part of the contract but did not say what a
malformed op halfway down the array should do. It refuses the whole call: every op is resolved and
validated into a `Prepared` before anything is written, and the error names the index. The reason is
the order rule itself — later ops carve into what earlier ones laid, so a half-applied batch leaves a
structure whose remaining ops were written against geometry that never appeared. There is no
per-op-error mode, deliberately.

**Two response fields §4 did not ask for.** A call-wide budget means an op can be reached with the
budget already spent, and an op that never ran reports all zeros — indistinguishable from an op that
legitimately changed nothing. So the op the budget ran out inside is marked `partial` and the ones
after it `not_run`, beside the top-level `truncated_at_op`. Without the markers the honest
`truncated` flag would still leave the per-op results ambiguous, which is most of what a batch
response is for.

**Cost, as predicted:** small. The engine is unchanged apart from the counters moving up into `Batch`.
`MAX_OPS` is 256 — past that the response is the cost and the caller wants two calls.

## 7. The measurement — 2026-08-17, haiku, 3 seeds × 2 arms

§4's last paragraph said this project does not ship unmeasured claims. Run:
`mcp-server/testbench/run-shapebatch.mjs`, full report in
`mcp-server/measurements/2026-08-17T11-57-45-shapebatch-haiku/REPORT.md`. Re-derive the arithmetic
from the recorded rows with `--from <dir>` — no bridge, no model, no spend.

**Design of the instrument, because two choices decide the answer.**

- **Not Category W.** wbuild's target is a 5×5×3 cottage: 75 cells, which `set_blocks` already
  batches into one call because `set_blocks` has always taken an array. Running it would have
  measured nothing and produced a null result to explain away. The `place_shape` → `place_shapes`
  gap only exists where a *volume* is the efficient unit, so the subject is a **13×13×6 room, 537
  target cells, 8 shapes minimum, 537 entries if enumerated**.
- **`set_blocks` is in neither arm.** Left in, both arms route around the tool under test and the
  run answers a question about tool *choice* instead. The arms differ by exactly one tool, prompts
  are byte-identical, and the turn cap (60, ~4× the expected median) is the same in both — an
  arm-dependent cap would *be* the measurement.

**Result.**

| | single | batch |
|---|---|---|
| turns (mean / median) | 11.67 / 11 | **3 / 3** |
| Σ cache_read (mean / median) | 52k / 26k | 29k / 26k |
| fidelity, exact builds | 0.9, 2/3 | **1.0, 3/3** |
| turn-1 input (the prefix) | 7,986 | 8,940 |

**1. The turn prediction is confirmed, and it is the robust half.** 3.9× fewer turns, and it held on
every seed (11→4, 14→2, 10→3). Nothing here is ambiguous.

**2. The model planned ahead — decisively, and that was the open question.** Every batch run emitted
the whole structure in ONE call: 12, 11, 11 ops. It never once fell back to one-shape-per-call, and
it needed no coaxing. §4's alternative hypothesis ("if the win is not in turn count, the model was
not planning ahead") is refuted for this model. It also used *more* than the 8-shape minimum — it
laid the walls layer-by-layer rather than reaching for `mode:walls`, which is worth knowing: the ops
array is the affordance it actually used, not the fill modes.

**3. But the token bill fell much less than the turns did, and §4 predicted this wrong.** The doc
said the win would be "nearly all in turn count and nearly none in result bytes". Turns fell 3.9×;
`cache_read` fell 44.6% on the mean — and the **median is 26k → 26k**, with paired per-seed
reductions of 51.9%, 60.2% and **0.4%**. One seed saved nothing at all. The mechanism is now
obvious in hindsight and was not in the design: **the batch trades many thin turns for few fat
ones.** One call carrying 11 ops, and a response carrying 11 per-op results, makes context-per-turn
rise as turn count falls, and the two partly cancel. Turn count is the lever, but it is not the
whole bill. At n=3 the turn claim is solid and the token claim is directional only.

**4. Fidelity went UP, which nothing predicted.** 2/3 → 3/3 exact. The single-arm failure built the
room correctly and then added **234 extra blocks**: it filled two wall layers solid instead of
perimeter-only (121 interior cells × 2 layers, less the 8 pillar cells that were target anyway =
234 exactly). Eight independent calls are eight independent chances to get one wrong; the batch
states the same intent once. Suggestive, not established, at this n — but it points the opposite way
from the usual assumption that batching is the riskier option.

**5. THE COST SIDE, WHICH §4 NEVER COSTED — and it is the finding with teeth.** Carrying
`place_shapes` raised turn-1 input by **954 tokens**: its own schema, ~11.9% of the entire 8k prefix
for a single tool, re-read on **every turn of every session** — including every session that never
builds anything. By TOKEN_PER_TOOL_FINDINGS.md finding 1 that is the expensive kind of cost, and it
is the same argument that motivated the tool, now pointing the other way.

- On the mean saving, a session that builds one room and runs **longer than ~24 turns** has paid
  more in schema tax than that room's batching saved.
- On the **median** seed the saving is 111 tokens — less than the tax costs in a single turn.
- A session that builds nothing pays the tax and collects none of it.

**So the actionable lever is the description, not the engine.** The 954 tokens are verbose *by
choice* — the text spells out array order, the call-wide budget, per-op results and the dry-run
contract, because §6 argued each of those is a thing a caller gets wrong otherwise. That trade is
now priced, and it can be re-priced: halving the description roughly doubles the break-even ceiling,
and it costs no model spend to predict. **That is the next measurement, and it is deliberately not
done here** — trimming the description would invalidate the very number this section reports.

**Limits, stated.** n=3, one model (haiku — the project's benched baseline, not the copilot's Opus).
`set_blocks` excluded by design, so this says nothing about whether a model *chooses* shapes over
enumeration. `cache_read` varies ~5× across seeds for cache hit/miss reasons unrelated to the arms,
which is why the paired per-seed column exists and why the median is printed beside every mean.

## 8. The trim — 2026-08-23, toolkit 0.86.0. §7 was right that the prefix is the lever and wrong about which half.

§7 closed by naming "trim the description" as the owed item, on the reasoning that the 954 tokens
are "verbose by choice" and that **halving the description roughly doubles the break-even ceiling**.
That reasoning was never checked against the manifest entry it was about. Checking it first is what
this section is.

**The entry was reconstructed offline** — `Schemas.java` is ~90 lines of deterministic JSON building,
so `place_shapes`'s published entry can be rebuilt exactly without a running bridge, and the measured
954 calibrates it (3052 chars / 954 tokens = **3.199 chars per token**, for this content). No API key
is needed and no model is called. The split:

| part of the entry | chars | ≈ tokens | share |
|---|---|---|---|
| description | 1113 | 348 | **36.5%** |
| input schema | 1939 | 606 | **63.5%** |
| whole entry | 3052 | 954 | 100% |

**The description was the smaller half.** Halving it saves ~173 tokens — 954 → 781 — which moves the
break-even from 24.5 turns to 29.9. That is **×1.22, not ×2.** The claim §7 made was off by a factor
of nearly two in the direction that flatters the plan, and the reason is that it costed the part it
could see in the source file rather than the part the model actually receives.

**Where the money actually was: `ops.items` repeated `place_shape`'s field descriptions.** Fourteen
fields, each carrying the same prose the singular tool carries three lines above it in the same
manifest — 615 chars, ~192 tokens, paid every turn to say a second time what was already said. That
duplication is safe to remove for a reason worth checking rather than assuming: **the two tools are
never apart.** `index.mjs`'s `OPERATOR` hide-list names both, so a caller that can see `place_shapes`
can always see `place_shape` beside it. The field docs stay in the prefix exactly once, `ops` points
at them in words, and types plus the required/optional split — the machine-checkable half, and cheap
— stay on every field. `Schemas.undescribe` is the seam, with the guardrail in its javadoc: **never
strip a description that nothing else in the manifest carries**, or the saving is a silent capability
loss.

**Both halves, and the prediction, written down before the arbiter runs:**

| | tokens | break-even | vs. today |
|---|---|---|---|
| today (0.76.0) | 954 | 24.5 turns | — |
| description only (what §7 asked for) | 781 | 29.9 turns | ×1.22 |
| **both halves (0.86.0, built)** | **589** | **39.6 turns** | **×1.62** |

`place_shape` itself is untouched: it is the one place the field prose is load-bearing, and it is
also the control — if the re-measure shows the batch arm got worse at authoring, the singular tool's
unchanged schema is what separates "the trim cost fidelity" from "the seed was unlucky".

**Still owed, and it is the same owed item §7 left:** the live re-measure, one `run-shapebatch`
invocation. Predicting a token count from character counts is arithmetic; predicting that a model
authors an 11-op room just as well from a schema with types but no field prose is **a bet**, and this
section is the place it is on the record before the run rather than after.

## 9. Rocketeer's authoring ask, answered — 2026-08-24, toolkit 0.89.0. Two tools asked for, one tool and one argument shape built.

`rocketeer/TOOLKIT_AUTHORING_ASK.md` is a ~250-line brief written from the consuming side, and it is
the best-shaped ask this project has received: it lists what already exists (checked in source, so
nothing is re-proposed), it prices its own request against §7/§8's numbers, and it names the
measurement that would refuse it. It asks for two tools — `capture_structure` and `write_box` — and
for a legend on `describe_box detail:"layers"`, and it puts two decisions to the toolkit:

> **(a)** Is `write_box` worth its prefix tax at all, or is `set_blocks` the honest answer?
> **(b)** Does `capture_structure` belong in `DataTools` or its own class?

### 9.1 (a) The capability yes, the entry no — and the difference is measured

`TOKEN_PER_TOOL_FINDINGS.md` finding 6 was written the day before this section, and its rule is
*"the first question to ask of any new verb: is there an existing tool whose question this already
is?"* — priced at the time on `bot_craft`, where two stations arrived for 98 tokens because they
went into an existing verb rather than a new one. **This is that rule's second application and the
first with the counterfactual actually written out and counted**, which matters because "it would
have cost more as its own tool" is otherwise a story rather than a number.

For a dense little volume of blocks, the tool whose question this already is, is `set_blocks`: it
enumerates cells, it parses full `id[state]{nbt}`, it owns physics/`dry_run`/`dimension`/undo/the
region. The layered grid is not a new question, it is **a second encoding of the same argument** —
so it went in beside `blocks`, parsed to the very same `{x,y,z,block}` entries, one engine below.

Both halves priced offline by finding 5's method (3.199 chars/token, compact serialization, entries
read from a live `/tools` and the "before" side rebuilt from `git show HEAD`):

| entry | before | after | delta |
|---|---|---|---|
| `set_blocks` (grid form added) | 566 | 973 | **+407** |
| `describe_box` (writable legend) | 590 | 640 | +50 |
| `push_data` (the `structure/` fix) | 325 | 381 | +56 |
| `capture_structure` (new entry) | — | 595 | **+595** |
| **whole change** | | | **+1,108 tok/turn** |

**And the counterfactual, written out and counted rather than estimated: the same grid capability as
its own `write_box` entry is 745 tokens.** Inside `set_blocks` it is 407. The merge saves **338
tokens per turn, forever** — 45% of that capability's bill — and every token of the saving is
structural: the name, the mechanism, the wrapper, and second copies of `min`/`physics`/`dry_run`/
`dimension` are what a separate entry pays for and this one does not.

That is the answer to (a): **the ask was right that `write_box` had to justify a prefix tax, and
wrong that the choice was between the tool and `set_blocks`.** The third option — the tool's
capability inside `set_blocks`' entry — is strictly better than either, and it was only visible
because the ask insisted the cost be named.

### 9.2 (b) `DataTools`, and the reason is which half is hard

`capture_structure` lives in `DataTools`. The capture itself is three vanilla calls
(`fillFromWorld` → `save` → `NbtIo.writeCompressed`); the part that has been wrong before is the
**pack** — its root must be normalized (a dedicated server's world path is relative, and normalizing
one side made every legal path "escape the pack root"), it must be created lazily, it must be
force-selected on reload, and `list_data`/`clear_data` must be able to see and remove what lands
there. All of that is `DataTools`' private invariant. A separate class would have to be handed the
pack root, which is exactly the thing that should have one owner.

### 9.3 What shipped

1. **`set_blocks` grid form** — `min` + `legend` + `layers` beside `blocks`. `layers[0]` is the
   bottom course, `rows[0]` is `z=min.z`, character *i* is `x=min.x+i`; a legend symbol may be
   `"keep"`; `'.'` defaults to air and `' '` to keep, so `describe_box`'s own conventions are
   writable as they stand. `layers` also accepts the **y-keyed object** `describe_box` returns, and
   its `"z=20|"` row labels and `"x: 10..14"` ruler paste back verbatim — **checked against `min`,
   not stripped**. Ragged rows refuse and are never padded. Every refusal is whole-call, having
   written nothing. The reply echoes `parsed.size` and `per_symbol`.
2. **`capture_structure`** — world box → `data/<ns>/structure/<path>.nbt` in the live pack, one
   call, returning a path and a census, never the bytes. **Its write half arrived in 0.92.0** as
   `place_structure` (RELEASE_1.md §D3) — this design left the loop half open, and the only route
   back into the world was `run_command "/place template"`, which reports `ok:true` for a command
   that failed. See the note in §9.5.
3. **`describe_box detail:"layers"` glyphs per STATE**, legend in `set_blocks` syntax (defaults
   omitted), plus `legend_overflow` when there are more distinct states than the 62 glyphs — which
   was always possible and never said.
4. **`push_data`'s description** now lists `structure/` as reloadable, which it is:
   `MinecraftServer.reloadResources` calls `structureTemplateManager.onResourceManagerReload`, and
   that clears the template cache.

### 9.4 Three things the ask got wrong about the toolkit, all in the toolkit's favour

- **The legend it asked for already existed** — `detail:"layers"` has returned one since 0.22.0.
  What did not exist was a legend worth writing back: it was keyed by **block id**, so
  `purpur_stairs[facing=west]` and `[facing=east]` drew as the same character. The round trip the
  ask wanted would have silently straightened every stair in the room. The real §3.3 fix was not
  *adding* a legend but *changing what a glyph identifies*.
- **The multi-palette trap cannot fire on a capture.** `fillFromWorld` clears the palette list and
  adds exactly one, so a captured template is single-palette by construction. The trap is real for
  any *loaded* template (which is where rocketeer's `PieceBake` met it), so `palettes` is still
  reported — but **read back out of the tag that was written**, not asserted. If vanilla's invariant
  ever changes, the count says so instead of a consumer finding an empty room.
- **The frame-is-given rule has a sharper edge than "do not infer it".** The ask's reason for
  requiring `min`/`size` is that a guess is invisible. The same argument applies to a box whose
  chunks are not resident: `fillFromWorld` reads air from an absent chunk, and air in a structure
  file is indistinguishable from a room with an open wall. Columns are paged in first (never
  generating terrain) and an unreadable one refuses the capture.

### 9.5 The hazard this walks into, and the falsifier

`PATTERN_SEARCH_DESIGN.md` measured the grid failure mode: *the same wrong cell from
`describe_box detail:layers` character-arithmetic in three independent sessions across two runs.*
The ask answers it by direction — the failure is **extraction**, a model deriving a coordinate out
of a picture, and a write has no extraction step: the model emits the grid and the tool does every
index. Three properties keep it that way, and all three are built: `parsed.size` is echoed, ragged
rows refuse rather than pad, and `per_symbol` lets intent be confirmed by count.

**On the record before the run, as the ask asked:** if a measured authoring run builds a chamber
**offset by one on any axis**, that argument is wrong — the hazard was never confined to extraction
— and the grid form should be withdrawn from `set_blocks`' entry. Nothing else about `set_blocks`
would change, which is what makes the withdrawal cheap enough to actually perform.

### 9.5b The loop closed the other way (0.92.0, RELEASE_1.md §D3)

This design shipped `capture_structure` and stopped there, on the reasonable ground that
`/place template` already put a template back. Two things were wrong with that, and both were found
by building the missing half:

- **`run_command` reports `ok:true` for a command that failed**, so the existing route could not
  answer the most likely question about a placement — *was the template even there*. `§9.6` below
  records `/place template` as the arbiter for the capture, which was fine as a probe assertion (the
  probe reads the blocks afterwards) and is not fine as a user's loop.
- **The toolkit was already telling people the tool existed.** `GoalRunner`'s refusal of
  `bot_target action:"build"` named `place_structure` by name. A refusal pointing at a phantom tool
  costs the reader exactly the call it saved them.

`place_structure` is therefore a new entry rather than a shape on `set_blocks` — Finding 6b's test is
whether two shapes share the engine *below* the parse, and they do not: a template placement is
vanilla's `placeInWorld`, which owns block entities, waterlogging fixup and entity spawning. What it
does share is real: the same `EditJournal`, `undo_id`, `region` and `dry_run` vocabulary.

**A finding worth carrying out of it.** `StructureTemplate.filterBlocks(pos, settings, block)` reads
like *every cell except that block* and is the exact opposite — `Palette.blocks(Block)` filters **to**
it, because its caller is jigsaw code hunting connector blocks. The first draft used it to enumerate
the cells a placement would write and every count came back `0`. The template's real block list is
behind a private field, so reaching it means an access widener (Fabric-only, and this jar also ships
NeoForge) or re-deriving the transform from the saved NBT. The tool computes from the **world**
instead — snapshot the footprint, place, diff — which is why `dry_run` reports `occupied` (what
stands there now, exactly computable) and deliberately does **not** report `changed`.

### 9.6 What is measured and what is not

**Live-green, first run, `probes/authoring.test.mjs` (9 cases, toolkit 0.89.0):** the grid lands at
`min + (character, layer, row)` on every axis; `keep` leaves a cell and stays out of the undo
record; ragged rows / unknown characters / two encodings / a keyed gap all refuse having written
nothing; the dry run's counts equal the live run's; `capture_structure`'s census matches the world
and `/place template` puts the same room back — stair facing and chest included, which is the only
check the blank-structure trap fails.

The load-bearing case is **the fixpoint**: `describe_box detail:"layers"` handed straight back to
`set_blocks` changes nothing (`placed: 0`) and fails nothing (`failed: 0`, `unchanged: 75`). One
test, four contracts — the legend speaks `set_blocks` syntax, block states survive the round trip,
the labels are a checksum rather than noise, and re-stating a correct cell is `unchanged`.

> **The wart the fixpoint found, which is the finding worth keeping.** `set_blocks` reported a cell
> already in the asked-for state as a **failed write** — `setBlock` returns false there, and the
> code called that "placement rejected". Rare when you enumerate cells. The *normal case* when you
> re-state a whole box to change three characters of it: editing a 150-cell room came back as **147
> errors**. The bucket `place_shape` has always had (`unchanged`) was missing from `set_blocks`, and
> nothing noticed for as long as nobody wrote the same block twice. A new encoding of an old tool is
> a load test for the old tool's honesty.

**Not measured: whether a model authors better this way.** §7's instrument (`run-shapebatch.mjs`)
priced the batch against the singular tool at n=3 on haiku; the equivalent here is enumerated
`set_blocks` versus the grid form on one authored room, and it has not been run. Two predictions,
stated now so the run can refute them: turns fall (one call instead of several, as §7 found), and
**fidelity is the number to watch, not cost** — the grid's whole claim is that the tool indexing
beats the model indexing. The 407-token tax says a session that authors nothing pays ~407 tokens a
turn for this, which at §7's arithmetic breaks even against one authored room somewhere north of 25
turns; that is the number the run would settle.
