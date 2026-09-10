# Findings — token usage per tool (persistence-weighted cache_read attribution)

Date: 2026-07-24. **This file is the surviving record** — the handoff that set the task up is
deleted with the rest of them, and its content was the plan, not the result. Tooling:
`mcp-server/testbench/tool-cacheread-report.mjs` (persistence-weighted; this doc's numbers) and the
prior `tool-token-report.mjs` (flat result bytes). Run over the overnight haiku dirs
(`…18-34-03-tasks` = T, `…18-08-29-mem` = C, `…18-02-22-play` = P).

## The metric

With-cache throughput is ~98% cache_read, and cache_read each turn = (everything in the context
window that turn). A tool RESULT is therefore not paid once — it is re-read on **every subsequent
turn** it stays in context. So the real driver is:

    weight(call) = result_tokens × (turns the result stays in the context window)

Computed precisely for C/P (per-turn `usage` in `sdk-*.jsonl`, result bytes time-aligned from
`transcript-*.jsonl`) and modelled for T (only `answers.jsonl` `.trace`: order × turn count).

## Finding 1 — the bill is mostly the STATIC PREFIX, not tool results

Measured decomposition of Σ cache_read (`cache_read = fixed prefix × turns + accumulated context`;
prefix = first non-zero per-turn read, i.e. system prompt + all tool schemas, nothing accumulated):

| category | sessions | Σ cache_read | static prefix (re-read every turn) | variable (tool results + reasoning) |
|---|---|---|---|---|
| P (play, ~7 turns) | 9 | 310k | **92%** (285k) | 8% |
| C (mem, ~38 turns) | 10 | 6.36M | **50%** (3.21M) | 50% |
| T (tasks) | 63 | 6.16M | no per-turn log¹ | — |

¹ T's `agent.mjs` saves no sdk log — add one (per the handoff) to split T too.

**The prefix share scales inversely with session length.** Short sessions are almost entirely
prefix (the system prompt + ~16 tool JSON schemas, re-read every turn); long sessions accumulate
enough tool output that the two halves converge. The single biggest structural lever on the token
bill is therefore **the size of the always-loaded tool-schema prefix** — it is paid on *every turn
of every session*, and no per-result tightening touches it. This is exactly what a deferred / lazy
tool-loading scheme (ToolSearch-style: only surface schemas when needed) would attack. It's a
harness lever more than a toolkit one, but it dominates.

## Finding 2 — within the variable part, one tool dominates each category

Persistence-weighted (`~tok·turns`), top tools:

**T (tasks):** `get_blocks` **84.0%** of the tool-result bill (up from 81.3% flat — it's big *and*
emitted early, so it's re-read the most). Everything else is single digits (`get_blocks_at` 6.4%,
`scan_box` 5.9%, `get_region_summary` 2.8% — the last *drops* from 7.5% flat: few calls, late).

**C (mem):** memory reads dominate — `mem_recall` **29.3%** (up from 21.6% flat), `mem_read` 11.2%,
`mem_recent` 8.2% → memory ≈ **49%** of C's tool-result bill; `get_blocks` 14.1% (its mean 813 B is
*not* a real abstracted view — see Finding 3's correction), perception (`raycast`+`bot_goto`+
`scene_summary`) ≈ 25%.

**P (play):** `sense_entities` 35.8%, then small bot_* status tools — but P's variable part is only
8% of its bill, so this barely matters.

## Finding 3 — `get_blocks` is the top per-tool lever; the "6× abstracted view" was an artifact

T's `get_blocks` is **raw** (mean 5243 B/call; the agent explicitly chose `detail:full` on 46 of 93
calls at ~6.9 KB each — the expensive ones). It is 84% of T's tool-result bill and worth ~857k
tok·turns; a real shrink of it is the biggest actionable per-tool lever, capped by Finding 1 at
~12% of T's whole cache_read bill.

**Correction to the handoff.** The claim that C's `get_blocks` was "abstracted to 813 B via
`asciiSurfaceView`, a 6× shrink" does **not** hold. Inspecting C's recorded results:
`asciiSurfaceView` was **stale** — written against an old `{x,y,z,block}` column shape, while the
0.14.0 bridge emits palette-indexed tuples `[[x,y,z,idx],…]`+`palette[]`. So in C, `detail:full`
calls **crashed** in the view (`Cannot read properties of undefined (reading 'replace')`, 78 B
envelopes — 12 of 37 calls, 32%) and `detail:summary` calls **passed through untransformed**
(~1166 B). The 813 B mean was error envelopes + passthroughs, never a validated surface map. The
"6×" number is withdrawn.

**Fixed + being measured (this session).** `asciiSurfaceView` now decodes the palette-indexed shape
and preserves completeness metadata (`ablation/view.mjs`, regression tests added). Against live
`detail:full` output it renders a real map. Raw shrink measured on scenes so far is **~2–3.5×**
(scene-dependent: it scales with block-type variety and area, not the withdrawn 6×) — biggest vs the
`detail:full` calls the agent actually makes. The production path is wired behind
`MCPTK_GET_BLOCKS_VIEW=surface` in `index.mjs` (forces `detail:full` upstream, then renders the
map), and a **Category-T raw-vs-surface bench** is running to settle whether it preserves task
accuracy — the measurement ARCHITECTURE.md:689 gates the change on. **Results in the section below.**

## Finding 4 — a tool's ENTRY is a per-turn tax, and adding one is now priced (2026-08-17)

> **Read Finding 5 with this one.** This section was written as "a tool's DESCRIPTION is a per-turn
> tax" and its closing rule says "verbose descriptions are a real design choice". The 954 is
> correct and measured; attributing it to the description is not. Finding 5 splits the bill and the
> description turns out to be the smaller part of it.

Findings 1–3 all measured what the toolkit *emits*. Finding 1 named the static prefix as "the single
biggest structural lever" and this doc's own net still says "the real levers are unchanged: the static
prefix" — but nothing here had ever priced **one tool's contribution to that prefix**. Shipping
`place_shapes` (toolkit 0.76.0) gave the clean opportunity, because its measurement ran two arms whose
prompts were byte-identical and whose tool surfaces differed by **exactly one tool**.

Full write-up: `STRUCTURE_AUTHORING_DESIGN.md` §7. Instrument and raw rows:
`mcp-server/testbench/run-shapebatch.mjs`, `mcp-server/measurements/`.

**The number: 954 tokens.** Carrying `place_shapes` raised turn-1 total input from 7,986 to 8,940 —
**~11.9% of the entire prefix for a single tool**, re-read on every turn of every session, *including
every session that never calls it*. Its description is verbose by choice (it spells out array order,
the call-wide budget, per-op results, the dry-run contract), and that choice now has a price tag.

**The break-even, which is a ceiling and not a floor.** Against the ~23k `cache_read` that batching
saved on one room, the tax pays for itself only while the session stays under **~24 turns**; on the
median seed the saving was 111 tokens, *less than the tax costs in a single turn*. A session that
builds nothing pays and collects nothing. So the standing rule this implies:

> **Price a new tool's prefix cost, not just its benefit.** A tool earns its schema only in the
> sessions that call it, and pays for it in all of them. Verbose descriptions are a real design
> choice with a measurable per-turn cost — 3 tool schemas at this size is another whole `get_blocks`
> call's worth of tokens, on every turn, forever.

**A second, transferable result: batching does not save what the turn count suggests.** Turns fell
3.9× and `cache_read` fell only ~45% on the mean (and ~0% on the median seed). A batch trades many
thin turns for few fat ones — one call carrying 11 ops and a response carrying 11 per-op results
raises context-per-turn as turn count falls, and the two partly cancel. Expect this for any batching
tool: `weight(call) = result_tokens × turns-in-context` cuts both ways, and shrinking the second
factor inflates the first.

**A method correction to "The metric" above.** That section computes the prefix as the *first non-zero
per-turn `cache_read`*. That reads **0** on a cold turn 1 (the prefix was a cache *write*, not a read)
and then **over-counts** on turn 2, which already carries turn 1's output and tool result. When two
arms share a byte-identical prompt, the honest prefix probe is the **turn-1 total input**
(`input_tokens + cache_read + cache_creation` on the first assistant message) — it is the whole
context before anything accumulates, and it does not care whether the prefix was read or written.
Also: `cache_read` varied ~5× across seeds for cache hit/miss reasons unrelated to the arms, so report
**medians beside means and a paired per-seed table** — at n=3 a mean can be carried entirely by one row.

## Finding 5 — the description was the SMALLER half; schemas duplicated across sibling tools are the waste (2026-08-23)

Finding 4 priced one tool's prefix contribution at 954 tokens and concluded the lever was the
description. That conclusion was never checked against the entry it was about — it costed the part
that is visible in the source file. Checking it first is this finding.

**Method, and it costs nothing.** `Schemas.java` is ~90 lines of deterministic JSON building, so a
tool's published manifest entry can be rebuilt exactly offline, with no bridge running and no API
key. Finding 4's measured 954 calibrates it: 3052 chars / 954 tokens = **3.199 chars per token** for
this content. From there any edit is priced by re-serializing.

| part of `place_shapes`'s entry | chars | ≈ tokens | share |
|---|---|---|---|
| description | 1113 | 348 | **36.5%** |
| input schema | 1939 | 606 | **63.5%** |
| whole entry | 3052 | 954 | 100% |

**So halving the description is worth ~173 tokens — ×1.22 on the break-even, not the ×2 Finding 4
implied.** The error is in the flattering direction, which is the reason to write the method down: a
plausible cost story about a number nobody decomposed.

**Where the money actually was.** `place_shapes.ops.items` repeated, field for field, the fourteen
field descriptions that `place_shape` already carries — in the same manifest, three lines above it.
615 chars, ~192 tokens, paid on every turn to say a second time what was already said. Removing them
is safe only because the two tools are **never apart**: `index.mjs`'s `OPERATOR` hide-list names both,
so a caller that can see one can always see the other. Both halves together: **954 → 589 (−38%),
break-even 24.5 → 39.6 turns (×1.62)** — built in toolkit 0.86.0, live re-measure still owed.

> **The rule Finding 4 should have stated.** Price the whole ENTRY, and look for the same words
> twice. A description is paid once per turn; a description **duplicated across sibling tools** is
> paid twice per turn, forever, and buys nothing the first copy did not. `Schemas.undescribe` is the
> seam for removing the second copy, with the guardrail in its javadoc: never strip a description
> that nothing else in the manifest carries — that is not a saving, it is a silent capability loss.

**The generalization worth checking next**, and it is free: `vec3i()` alone is ~110 chars each and
`place_shape` carries four of them. Any tool family sharing an argument shape is paying for that
shape once per tool. Nobody has swept the manifest for it.

## Finding 6 — the cheapest new capability is one that needs no new entry; and not all growth is waste (2026-08-24)

Finding 5 left a rule — *price the whole ENTRY, and look for the same words twice* — and 0.88.0 is
the first change to be priced by it **before** the words were called waste. Three entries grew, all
measured offline by Finding 5's method at 3.199 chars/token:

| entry | chars | ≈ tokens | what it bought |
|---|---|---|---|
| `bot_craft` | 719 → 1033 | 225 → 323 (**+98**) | smithing + stonecutting; netherite upgrades had no route at all |
| `bot_container` | 1174 → 1604 | 367 → 501 (**+134**) | brewing named at last, real furnace/brew progress, the `slot:3` override |
| `bot_status` | 973 → 1037 | 304 → 324 (**+20**) | `speed_known`/`speed_delta` |
| **total** | 2866 → 3674 | 896 → 1148 (**+252**) | paid every turn, by every session carrying these three |

**The `bot_craft` row is the finding.** Two stations that previously had no route arrived for **98
tokens per turn** because they went into an existing verb instead of a new one. Finding 4 priced a
*new* entry at 954 (589 after the 0.86.0 trim), so the alternative — a `bot_smith` tool — would have
cost roughly **six times as much for the same capability**, before anyone wrote a line of it. That is
now the first question to ask of any new verb: *is there an existing tool whose question this already
is?* "Make me this item" already covered smithing; it just did not know it.

**The `bot_container` row is where the rule gets interesting, because most of its +134 is NOT waste.**
Two candidate trims, and only one of them survives contact with this session's other finding:

- **Safely trimmable, and it is the smaller half.** `TO SMELT` and `TO BREW` each end by saying the
  station runs on its own ticks and that the tool never claims otherwise. Same words twice, ~20–25
  tokens, exactly Finding 5's rule. Merge them.
- **NOT trimmable, though it looks like the bigger prize.** The description enumerates the reply's
  own field names (`lit`, `cook_progress`, `fuel_ticks`, `brew_progress`, …), which the reply already
  labels — the same shape as the duplication Finding 5 removed, one level over. Deleting them would
  save ~60 tokens a turn and would be a mistake, because 0.88.0's other headline is that
  **`bot_container` could reach a brewing stand for a year and nobody found it, precisely because no
  word in the manifest said so.** A field name in a description is not a second copy of the reply; it
  is the only channel by which a caller learns the capability exists *before* deciding to call. The
  duplication rule applies to words repeated across entries a caller sees together, not to the
  advertisement of a capability the caller cannot otherwise discover.

> **The corollary Finding 5 needs.** Before trimming a description, ask what the words are FOR. Words
> that repeat something else in the same manifest are waste. Words that are the only place a
> capability is named are the discovery channel, and cutting them is not a saving — it is the silent
> capability loss `Schemas.undescribe`'s guardrail already warns about, arriving through the front
> door instead.

**Owed:** the two-clause merge above (~20–25 tokens), and a live re-measure of the 0.86.0
`place_shapes` trim, which is still owed from Finding 5.

### Finding 6b — the rule's second application, with the counterfactual actually counted (2026-08-24, 0.89.0)

Finding 6 ends by naming the question to ask of any new verb. **0.89.0 is the first change decided by
it, and the first where the road not taken was written out and priced instead of assumed.**

Rocketeer asked for two tools (`rocketeer/TOOLKIT_AUTHORING_ASK.md`): `capture_structure`, and a
`write_box` that turns layered text into blocks. It priced its own request against Findings 4/5 and
put the decision to the toolkit: *is `write_box` worth its prefix tax, or is `set_blocks` the honest
answer?* Asked that way the answer looks binary. It is not — **the question "which cells do I set"
is already `set_blocks`', and a grid is a second ENCODING of its `blocks` array, not a second verb.**

| | tokens/turn |
|---|---|
| the grid form inside `set_blocks` (built) | **+407** |
| the same capability as its own `write_box` entry (written out, counted, not built) | **745** |
| saving | **338/turn, forever** |

Everything in that 338 is structural — a name, a mechanism, a schema wrapper, and second copies of
`min` / `physics` / `dry_run` / `dimension` — none of which teaches a caller anything the first copy
did not. The whole 0.89.0 change is **+1,108 tok/turn** (`set_blocks` +407, `capture_structure` +595
as a genuinely new entry, `describe_box` +50, `push_data` +56), measured by Finding 5's method
against a live `/tools` with the "before" side rebuilt from `git show HEAD`.

> **The sharpening.** Finding 6 asked *"is there an existing tool whose question this already is?"*
> and answered it for a capability (`bot_craft` and smithing). The harder and commoner case is a new
> **argument shape** for a question already asked — where the instinct is a new tool, because the
> input looks nothing like the old one. `set_blocks` takes a picture and an array of cells, and both
> parse to the same entries a line below. **Ask what the tool's QUESTION is, not what its arguments
> look like.**

Two guardrails this case needed, both worth carrying:

- **A second argument shape is a second contract** — `conformance.test.mjs` says so in as many words
  and has a `variants` mechanism for it. It is only cheaper than a second tool when the two shapes
  share the engine *below* the parse. Here they share everything: physics, `dry_run`, the undo
  record, per-entry errors, the region. A second shape that shared only the name would be two tools
  wearing one entry, and would deserve the second entry it was avoiding.
- **The old shape gets load-tested by the new one.** `set_blocks` reported a cell already in the
  asked-for state as a *failed write*, which is nearly harmless when you enumerate cells and absurd
  when you re-state a box to change three characters of it (147 "errors" for a 150-cell room). The
  bucket existed on `place_shape` and had been missing here for as long as nobody wrote the same
  block twice.


## Finding 7 — an entry estimated before its schema exists is a guess about 60% of the bill; and the profile is the bigger lever than the words (2026-08-26, 0.90.0)

`stage_entity` (ENTITY_AUTHORING_DESIGN.md §5.1) is the first entry to be **estimated in a design
doc, then measured against that estimate**. The design priced it at "≤ ~450 tokens (three ops
sharing one field table; measure at build time per the standing rule)".

**The number: 606 tokens** (1,940 chars, live `/tools`, Finding 5's method at 3.199 chars/token).

| part of `stage_entity`'s entry | chars | ≈ tokens | share |
|---|---|---|---|
| description | 769 | 240 | 39.6% |
| input schema | 1171 | 366 | **60.4%** |
| whole entry | 1940 | **606** | 100% |

**35% over the estimate, and the overrun is in the schema.** The description came in about where a
design doc can see it; the ten-field table did not, because when the estimate was written the fields
existed as a prose list (`{model, pos?, size?, yaw?, spin?, scale?, tag?, replace?}`) and not as
schema objects with per-field descriptions. Finding 5's lesson was *decompose the entry before
blaming the description*; this is its forward-looking half: **an entry estimated before the schema is
written is an estimate of the smaller half.** The cheap fix is to write the schema first — it is
deterministic JSON and costs nothing to serialize — and price that.

**The road not taken, counted the way 6b counts them.** The op-field decision was made on Finding
6's rule before any of this was built. Written out as three standalone tools (`stage_entity`,
`clear_stages`, `list_stages`), each carrying the words a caller who sees only that tool would need:

| | chars | tokens/turn |
|---|---|---|
| one entry with `op` (built) | 1,940 | **606** |
| the same capability as three entries (written out, counted, not built) | 2,565 | **802** |
| saving | | **196/turn, forever** |

All of it structural — two more names, two more mechanism/schema wrappers, a second and third copy
of `tag`, and a re-statement of what `parse` means in each tool that reports it.

**But the profile is the bigger lever, and it is a different kind of lever.** 606 tokens/turn is
what the entry costs a session *that carries it*, and `stage_entity` is the first toolkit tool to
ship hidden from `standard` — the workbench default, which keeps the whole dev surface otherwise. It
is served by `entity` and `full` only. So the per-turn tax on every session that is not authoring an
entity is **zero**, and the 196 saved above is only ever paid by sessions that asked for the tool.

> **The question after Finding 6's question.** Finding 6 asks *"is there an existing tool whose
> question this already is?"* When the answer is genuinely no — nothing else in the manifest puts
> authored geometry on a body — the next question is not "how short can the words be" but **"who has
> to carry it?"**. A profile line is worth more than any amount of editing, because it takes the
> entry to zero for the sessions that were never going to call it. Editing can win back tens of
> tokens; not shipping it wins back all 606.

**Two duplications identified and deliberately NOT cut** (~26 tokens together), recorded so the
decision is on the record rather than an oversight: `model`'s field description repeats the
`assets/mcptoolkit/preview/` locator the description already gives, and `replace`'s repeats the
description's replace-vs-accumulate clause. Both are Finding 5 duplications by the letter. They stay
because of Finding 6's corollary and the paragraph above: a caller who skims to the schema needs the
locator to make a call at all, and the tax is now paid only by sessions that are actively authoring,
where 26 tokens buys less than one avoided failed call.

**Calibration, and one owed item half-closed.** The same live `/tools` puts `place_shapes` at 1,829
chars / 572 tokens against the 0.86.0 trim's predicted 1,884 / 589 — the offline method reproduces
on a live manifest to within 3%, and `bot_craft`'s 1,033 description chars are exactly Finding 6's.
What that does NOT close is Finding 5's actual owed item: the API-level re-measure (turn-1
`input_tokens + cache_read + cache_creation`, the way Finding 4 got its 954). Serialized size is the
model of the bill; the bill itself is still unmeasured since the trim.


### Finding 7b — the second measurement of the same entry, and the boundary you have to state first (2026-08-26, 0.93.0)

`stage_entity` gained two fields in phase 4 (`clip`, `clip_time`, ENTITY_AUTHORING_DESIGN.md §9).
Re-measured on the live `/tools` by Finding 5's method:

| | chars | ≈ tokens |
|---|---|---|
| description | 937 | 293 |
| input schema | 1,348 | 421 |
| whole entry (desc + schema) | 2,285 | **714** |
| | | **+108/turn vs 0.90.0** |

**Finding 7 holds on a second subject, and holds in the direction that matters.** Description +168
chars, schema +177 — the schema is *again* the larger half, on a change whose visible part was two
sentences of prose. Two fields with one line of description each cost as much as three sentences.

**But the load-bearing part of this entry is the trap in the MEASUREMENT.** The first read used
`JSON.stringify(entry).length` and got 2,377 chars / **743 tokens**, which would have been written
down as **+137** — 27% high. Finding 7's "whole entry" is *description + schema* (769 + 1,171 =
1,940, exactly — the sum, with no envelope). `JSON.stringify` adds the `name` / `description` /
`inputSchema` wrapper and its escaping, about 92 chars, and that envelope was present at 0.90.0 too
and simply not counted.

Neither definition is wrong. What is wrong is a delta between two of them. And the failure is
one-way and permanent: the 606 was recorded as a number, not as a procedure, so it cannot be
re-derived from a later manifest — an incompatible second measurement silently poisons the series
and there is no way to notice from inside the table.

> **The rule this adds to Finding 5's method: state the BOUNDARY of the thing you measured, in the
> table, next to the number.** "Whole entry = description + schema, no envelope" is nine words and
> it is what makes the next measurement comparable. A figure with no stated boundary is a figure
> that can only be compared with itself.

The caught-it mechanism is worth naming too, because it was not care: the estimate written from the
char-level diff *before* the game was up said ≈721/+114, and the live read said 743/+137. **The two
disagreed, and the disagreement is what exposed the definitional gap** — an estimate is not only a
worse number, it is a control on the measurement. Estimate first anyway.

## Finding 8 — Finding 7's lesson applied prospectively, and the trim that Finding 5 predicts (2026-08-26, 0.91.0)

`get_log` (RELEASE_1.md §D1) is the first entry written *after* Finding 7, and it was priced twice:
once as drafted, once after a deliberate Finding-5 pass over it. Same method — live `/tools`, 3.199
chars/token.

| | chars | tokens/turn |
|---|---|---|
| first draft | 1,672 | **523** |
| after the duplication pass (shipped) | 1,384 | **433** |
| saving | | **90/turn** (−17%) |

**What came out was exactly the shape Finding 5 names, and nothing else.** The draft's description
enumerated the level values, said `since` was strictly-after, and explained what `contains` and
`logger` match — while the schema said all four things again, one line below, in the fields' own
descriptions. Nothing unique was cut: the enumeration stayed in the schema (it is the *argument's*
contract, and a caller who skims to the schema must be able to call the tool), and the prose kept
the facts no field can carry — that a reload can succeed with nothing loaded, that WARN lives in its
own ring, that capture starts at mod init. **90 tokens for one editing pass over an entry that was
already written carefully**, which is the honest size of what editing wins.

**And the bigger lever was again the profile, exactly as Finding 7 predicts.** `get_log` is
`DEV_ONLY`, so `play` / `survey` / `survival` pay **zero** — the same structure `stage_entity`
established, reached this time by a rule rather than by a judgement call. The 433 is paid only by
sessions whose job is authoring content against a running game, which is the population that would
otherwise be reading `logs/latest.log` by hand.

**The estimate-vs-measurement discipline, one step further.** Finding 7's fix was "write the schema
first — it is deterministic JSON and costs nothing to serialize." That is what happened here: the
schema existed before the price was quoted, and the *description* is what the trim touched. The
split was 1,067 chars description / 527 schema in the draft — the description was the larger half
this time, which is not a contradiction of Finding 5 but its point: **decompose the entry, then cut
the half that is actually big.** A rule that always blames the same half is not a measurement.

## Finding 9 — four capabilities for the price of an argument list, and the counterfactual is the whole argument (2026-08-26, 0.92.0)

RELEASE_1.md §D2 asked for four things `query_registry` could not do: what tags an entry is in, what
is inside a tag, what blockstate properties/components/size an entry has, and whether a pushed recipe
LOADED. The instinct is four tools — they have four different inputs and four different outputs.
**They are one question** (*what is registered*) asked about one thing instead of all of them, which
is Finding 6b's sharpening applied without argument.

| | chars | tokens/turn |
|---|---|---|
| `query_registry` before | 1,192 | 373 |
| `query_registry` after (shipped) | 1,773 | **554** |
| **the four capabilities** | **+581** | **+181** |

Measured the standing way: live `/tools`, Finding 5's 3.199 chars/token, "before" rebuilt from
`git show HEAD`. The counterfactual, priced at Finding 4's post-trim floor of ~589 for a new entry:
**four tools ≈ 2,356 tokens/turn.** The merge is not 20% cheaper, it is **an order of magnitude**
— which is what happens when the structural half of an entry (name, mechanism, schema wrapper, the
`registry`/`contains`/`namespace`/`limit` block re-stated four times) is paid once instead of four
times. The split of what shipped: description 1,017 chars / schema 677.

**The trim was again Finding 5's shape, and this time the duplication was WITHIN the entry rather
than across siblings.** The draft's prose spelled out `tag`, `tags` and `entry` and the schema then
spelled the same three out again a line below; 174 chars came out (2,036 → 1,773, −54 tokens/turn)
by leaving the per-argument sentence to the schema and keeping in the prose only what no field can
carry — that a missing tag is reported as `tag_exists:false` rather than as an empty one.

**The rule this adds.** Findings 6/6b ask *is there an existing tool whose question this already
is?* This is the case where the answer is yes **four times over**, and the saving compounds: a
shared filter block is re-stated once per tool avoided, not once per feature. So the question is
worth asking of a BATCH of asks together, not one at a time — asked separately, each of §D2's four
items looks like a small new tool, and only the batch shows what they had in common.

## Finding 10 — merge by the STEP as well as by the question; and the description/schema split is a property of the schema's shape (2026-08-26, 0.95.0 / 0.96.0)

Three entries priced in one batch (RELEASE_1.md §D7, §D9, §D5). Measured the standing way: live
`/tools`, Finding 5's 3.199 chars/token, "before" reconstructed from the entry with this release's
additions removed.

| what shipped | chars | tokens/turn |
|---|---|---|
| `get_perf` (new entry) | 1,174 | **367** |
| `query_class` (new entry) | 1,222 | **382** (439 before the trim) |
| `promote` on `clear_data` (argument) | 547 → 1,091 | **+170** (+184 before the trim) |

**The new rule, from §D9.** Findings 6/6b/9 ask *is there an existing tool whose QUESTION this
already is?* Promotion — copy a live-pack file into a mod's source tree — is not `clear_data`'s
question by any reading. It is `clear_data`'s **step**: `LIVE_MODDING.md` has always documented
promotion as copy-then-clear, and the clear is the half people forget, which is the hour §D9 exists
to save. Riding the copy on the clear costs **+170 tokens/turn instead of ~589 per new entry**
(~1,000 saved across the asset and data pack), and buys something a `promote_data` tool could not:
the forgettable step becomes the one you cannot skip, because the copy happens *because* you asked
for the delete. **So the question to ask of a new capability is two questions — whose question is
this, and whose STEP is this — and the second one can pay in behaviour as well as in tokens.**

**The counter-case, from §D7, and it is Finding 7's lever rather than Finding 6's.** `get_perf` sits
next to `get_world_info`: same execution context, same trivial engine (a loop over
`server.getAllLevels()`), and a `perf: true` mode would have saved the ~60-token structural half of
an entry. It was still taken as a **new entry**, because `get_world_info` is served in EVERY profile
— including the budgeted survival one — while `get_perf` is `DEV_ONLY`. Folding in would have taxed
every play/survey/survival turn for a read only a modder makes; splitting out means the 367 tokens
are paid by dev sessions and nobody else. **When the merge target is cheap and universal and the new
capability is expensive and narrow, the profile layer decides, not the question.** That is Finding
7's headline reaching the merge decision itself.

**A refinement to Finding 5, from the same three measurements.** Finding 5 found the description was
the *smaller* half (`place_shape`: description 36.5%, schema the rest) and concluded the waste was in
duplicated schema prose. Here it is the other way round — `get_perf` 707 description / 392 schema,
`query_class` 620 / 526 — and the reason is not discipline but SHAPE: those two take three or four
scalar arguments, while `place_shapes` carried a nested `ops.items` block that re-stated a sibling's
whole field list. **The split is a function of how nested the schema is, so "trim the schema" is not
the lesson; "look for the same words twice" is** — which is what both trims here actually were.
`query_class` lost 183 chars (−57 tokens/turn) by dropping two sentences the REPLY already carries at
the moment they matter (`loaded:false` explains itself in its own note), and `clear_data` lost 44
chars where the description restated the `promote` argument's own doc. A manifest sentence that only
repeats what the caller will read in the result is paid every turn and read once.

## Finding 11 — the fold is decided one ARGUMENT at a time, and a name the tool has outgrown is cheaper than a second entry (2026-08-26, 0.97.0)

RELEASE_1.md §D6 shipped three capabilities — a wheel, a drag, and the keyboard — and the interesting
part is that the *same batch* answered Finding 6's question differently for each one. Measured the
standing way: live `/tools`, Finding 5's 3.199 chars/token, "before" reconstructed from the entry with
this release's additions removed.

| what shipped | chars | tokens/turn |
|---|---|---|
| drag + wheel, folded into `click` | 965 → 1,885 | **+288** (+335 before the trim) |
| `send_keys` (new entry) | 1,419 | **444** |
| batch | — | **+731**, paid only where the client surface is served |

**Three arguments, three different answers, and the engine test is what separated them.**
Finding 6b asks whether two argument shapes share the engine *below the parse*.

* A **drag** is a click that moves before it releases. Vanilla's own `MouseHandler` runs
  press → move → release, and `ContainerEventHandler.mouseDragged` forwards a drag ONLY while
  `isDragging()`, which nothing but a consumed `mouseClicked` sets. So a drag is literally `click`'s
  engine plus motion, and it needs `click`'s target resolution and `click`'s occlusion check to aim
  either end. Folded — this is Finding 6b's test passing outright.
* A **wheel** shares `click`'s target resolution and *not* its engine (`mouseScrolled` takes no
  button, no press and no release). Folded anyway, and the reason is arithmetic rather than kinship:
  a new entry's floor is ~589 tokens/turn (Finding 4) and adding the wheel to an entry that already
  resolves a target cost far less than that. What it spends instead is a NAME: a tool called `click`
  now also scrolls. **A name the tool has outgrown is the cheapest thing in the entry** — the
  description is re-read every turn and carries the truth, while the name is a hook. `set_blocks`'
  grid form and `query_registry`'s `recipe` pseudo-registry already spent the same coin.
* The **keyboard** shares neither: no pointer, no coordinates, no target, and its own vocabulary of
  key names and modifiers. Its own entry, and the 444 tokens are the honest price of a capability
  that has nothing to ride on.

**So Finding 6's question is asked per ARGUMENT, not per feature.** "Keyboard, scroll and drag" reads
like one item in the work list and is three merge decisions, two of which go the same way for
different reasons. A batch answered as a unit would have got at least one of them wrong: three
separate tools would have cost roughly 589 × 3 against the 731 actually spent, and folding the
keyboard in as well would have produced a grab-bag whose description has to teach four unrelated
argument sets before the caller can use any of them.

**Finding 5's shape rule, confirmed from the other side.** `click`'s schema is now the bigger half
(805 description / 1,001 schema) and `send_keys`' is the smaller (704 / 634) — and the difference is
again SHAPE, not discipline: `click` carries twelve flat scalars, seven of them new, each needing one
line of its own, while `send_keys` carries four. The trim pass took 151 chars (−47 tokens/turn) and
every one of them was the same words twice: the description explained what a "label" match is when
the `label` argument's own doc already did, spelled out the two ways a point can be blocked when the
REPLY's note spells them out at the moment it matters, and taught how a scrollbar integrates a drag
delta in an argument doc for `steps`. **Look for the same words twice** — the rule from Finding 10 —
found all three without any judgement about which half was to blame.

## Finding 12 — the cheapest fold of all is a second QUESTION about the same argument list (2026-08-26, 0.100.0)

Findings 6b, 9, 10 and 11 all weigh one capability's argument shape against another's. §E1's codec
validation is a case none of them describes, and it is the cheapest shape there is: **it has no
arguments of its own at all.** "Would this file load?" takes the same `path` and the same bytes that
`push_data` already receives, and asks a second question of them. There is nothing to merge, because
there was never a second argument list.

Measured the standing way: live `/tools`, Finding 5's 3.199 chars/token, "before" reconstructed from
the entry with this release's additions removed.

| | chars | tokens/turn |
|---|---|---|
| `push_data` before | 1,657 | 518 |
| `push_data` after | 2,128 | 665 |
| **delta** | **+471** | **+147** |
| counterfactual: a `validate_data` entry | — | ~589 floor (Finding 4), *plus* re-documenting `path`/`base64`/`file` |

So the fold is roughly a **4× saving** against the floor, and the counterfactual is worse than the
floor says: a separate validator would have had to re-teach the same three argument doors —
`path`, `base64`, `file` — that `push_data` already spends 
its schema on, which is exactly the ~1,500-char re-documentation the `compare` argument avoided in
0.99.0 and the ~2,356 four-tool counterfactual Finding 9 priced.

**Of the +471, only 99 chars are schema** — one boolean, `dry_run`. The rest is description, and
that inverts Finding 7's usual split for a reason worth stating: **a second question about an
existing argument list is nearly all prose by construction.** There is no new shape to declare, so
there is nothing for the schema to carry; what has to be paid for is the reader knowing the answer
exists and what it means. Finding 5's trim rule still applies to that prose and was applied (the
`validation` block's field names are listed once, in the description, and the reply's own `note`
carries the per-case explanation rather than the manifest) — but the *ratio* is a property of the
fold's kind, not of discipline.

**The rule to carry: before asking whether two verbs share an engine, ask whether the second one is
a verb at all.** A capability with no arguments of its own is not a tool that might merge; it is a
field on an existing reply, and pricing it as a candidate tool overstates it by ~4×.

## Finding 13 — the fold question has a THIRD answer, and it is the authority (2026-08-26, 0.101.0)

Findings 6/6b/9/10/11/12 all decide a fold on *cost*: is this the same question, the same argument
list, the same engine below the parse? §E6's `roll_loot` is the first case where the cheap answer and
the right answer disagree, and the tiebreaker is neither of those things.

The cheap route was real. `query_registry` already reaches the loot tables (this release taught it
the reloadable layer, for **zero manifest tokens** — they are registry ids, which its description
already tells a caller to pass), so a `roll:{count,seed,luck,tool}` block on that entry would have
been perhaps ~300 tokens against a new entry's ~589 floor. Finding 6b's engine test does refuse it —
a registry read and a `LootContext` simulation share nothing below the parse — but that test is about
whether the merge *works*, and a determined author can always make one work.

**What settles it is that the two questions have different authority.** Rolling a table with a
container's own `lootTableSeed` reports the contents of a chest nobody has opened. `query_registry` is
`OBSERVE` and rides in every profile including `survival`; `roll_loot` is `DEV_ONLY` precisely because
it is an oracle. Folding would have carried an X-ray into every profile that reads a registry, and
**profiles are per-tool** — the hide list has no way to name half an entry.

| | tokens/turn |
|---|---|
| `roll_loot` as its own entry, first draft | 745 (2,382 chars) |
| …after the Finding 5 trim (shipped) | **651** (2,081 chars) |
| the same capability folded into `query_registry` | ~300, *and legal in `survival`* |
| `query_registry`'s reloadable-layer reach | **0** (1,767 chars before and after) |

> **The rule.** Ask the fold question in three parts, in this order: is it the same QUESTION
> (Finding 6), does it share the ENGINE below the parse (6b) — and does it carry the same AUTHORITY?
> A capability whose mechanism is more privileged than its host's cannot be folded at any price,
> because the manifest is where privilege is enforced.

**The trim is Finding 5's, unremarkably and for the fourth time.** 745 → 651 is one deletion: the four
subject glosses were written out in the description and again in the schema. The schema keeps them
(it is what a caller reads while filling arguments) and the description keeps only what a schema
cannot say — that exactly one subject is named, and what the reply's numbers mean.

## Finding 14 — Finding 13's authority test, applied a second time and against a *cheaper* fold (2026-08-27, 0.103.0)

Finding 13 produced a three-part fold question — same QUESTION, same ENGINE, same AUTHORITY — and
§D4's `preview_worldgen` is the first entry decided by it prospectively rather than after the fact.

The fold on offer was cheaper than `roll_loot`'s. `get_region_summary` and `check_site` already take
a `center` and a span and already return ground statistics and a biome histogram; a
`source:"generator"` flag on either would have added **one word to an existing schema** — the
Finding 12 shape, where the capability has almost no arguments of its own. Parts one and two are
genuinely arguable: "what is the ground like around here" *is* close to the same question, and a
heightmap read and a `getBaseHeight` call are close enough below the parse that a caller would not
notice the seam.

**Part three refuses it outright, and for a reason with no counter-argument.** A generator sample
describes ground that **has never been generated** — the far side of the horizon, at any coordinate,
for free. That is an oracle of exactly `roll_loot`'s kind, and `get_region_summary` is a perception
tool served in `play`, `survey` and `survival`. Folding it in would have put an X-ray into the
budgeted survival profile, and profiles are per-tool: the hide list cannot name half an entry.

| | tokens/turn |
|---|---|
| `preview_worldgen` as its own entry, first draft | ~666 (2,132 chars: 877 description, 1,174 schema) |
| …after the Finding 5 trim (shipped) | **~507** (1,621 chars: 616 description) |
| the same capability folded onto `get_region_summary` | a handful, *and legal in `survival`* |

**The trim, and the one rule it produced.** 2,132 → 1,621 is 511 chars, and every one of them came
out of *argument prose*, not out of the boundary. The generator sample is a partial answer — noise
only, before surface rules and carvers — and that clause stayed whole in the description while six
argument glosses were cut to a line each.

> **The rule.** When a tool's reply already carries an explanation, that explanation belongs in the
> reply and not in the description: a reply is paid **per call**, a description **per turn**. The
> exception, and it is the only one: a caveat the caller needs *before deciding to call* — a boundary
> on what the answer means — cannot be moved into the reply, because by the time they read it they
> have already spent the call and, worse, may already have acted. `preview_worldgen` keeps its
> `note` and its `how_to_read` in the reply and its BOUNDARY sentence in the description, and that
> split is the rule stated concretely.

## Recommendation (a decision, not yet taken — see the gate)

1. **Prefix first (biggest lever, harness-level).** Lazy/deferred tool-schema loading. Out of scope
   for the toolkit repo but worth flagging: it's paid every turn and is 50–92% of the bill.

2. **Budget `get_blocks`, don't reformat it (safe, do now).** The server already *warns* at
   >8192 B. Add a hard **result-size budget** (cap/paginate the raw column list) so a single call
   can't dump 5 KB+. A budget keeps the `id[state]` serialization unchanged, so it is **not** gated
   by the ARCHITECTURE.md:689 corollary — it only bounds volume. Also steer agents toward the cheap
   abstracted predicates the toolkit already ships (`check_site` 516 B, `check_path` 430 B,
   `scan_box` 1052 B, `get_region_summary`): the without-arm is expensive precisely because the
   agent falls back to hammering raw `get_blocks`.

3. **`get_blocks view:"surface"` mode — built, and benched to clear the gate (this session).**
   Implemented Node-side in `index.mjs` (no mod change needed — the shim owns result formatting)
   behind `MCPTK_GET_BLOCKS_VIEW=surface`: forces `detail:full` upstream, then renders the (now
   fixed) `asciiSurfaceView` map. It *is* a serialization-format switch, which ARCHITECTURE.md:689
   gates on "a local Category-B bench measurement first" — so this flag defaults off (`raw`) and the
   Category-T raw-vs-surface run below is that measurement. Adopt as default only if task accuracy
   holds. This also subsumes item 2: forcing the compact map on every `get_blocks` *is* the budget —
   it caps the oversized `detail:full` reads without truncating.

## Bench results — raw vs surface (Category T, haiku, 16 instances × 2 reps × 4 arms, 2026-07-24)

Run `testbench-results/2026-07-24T02-15-57-tasks-haiku`. All four arms in one session (drift-free).

| arm (tools × view) | accuracy | tokens wc (total) | get_blocks calls | mean B/call | turn-caps |
|---|---|---|---|---|---|
| **with** (all tools, raw) | 97% (31/32) | 2.67M | 3 | 5542 | 0 |
| **surface** (all tools, surface) | **100% (32/32)** | 2.61M | 1 | 1734 | 0 |
| **without** (repr. hidden, raw) | 78% (25/32) | 3.34M | 94 | 5181 | 2 |
| **without-surface** (repr. hidden, surface) | 74% (23/31) | 3.48M | 99 | 2036 | 3 |

Three things this settles:

1. **Surface is safe on the production config — but the win is ~2%, not ~12%.** With all tools
   present (the real regime), accuracy held/improved (97 → 100%) and tokens dropped ~2%. But the
   agent barely *uses* get_blocks when it has the predicates — **3 calls across 32 sessions**. So
   shrinking get_blocks ~3× (5542 → 1734 B/call) barely moves the bill. The view fix also means
   get_blocks **never errors** now (0 vs the crashes Category C hit).

2. **The "get_blocks = 84% of T's bill" was the crippled arm, not production.** That weight came
   almost entirely from the **without** arm, which hammers get_blocks **94×** because its predicates
   are hidden. Production (tools available) calls it ~3×. The persistence-weighted 11.7% projection
   was effectively "saving on the ablation arm"; the real production lever from abstracting
   get_blocks is ~2%.

3. **A cheaper get_blocks does NOT substitute for the representation tools.** `without-surface` made
   each get_blocks 2.5× smaller but gained **nothing**: tokens 3.48M vs 3.34M and accuracy 74% vs
   78% — both **within noise** (1–2 sessions on n≈31). Per-rung, the two arms fail the *same* hard
   tasks with the *same* answers (r7 water 0/4 both; r8 flattest near-misses both; r4 reach same
   wrong `yes`), and r5 heights stays 4/4 under surface (min/max recover from the legend bands). So
   the honest reading is narrow: cheaper raw data neither helped nor clearly hurt the crippled arm —
   it just isn't a substitute for an answer-shaped derived fact. The 12–33-turn thrash is present in
   *both* `without*` arms and absent from `with`/`surface` (4–7 turns) — it tracks *missing
   predicates*, not the map format. (Earlier drafts attributed the without-surface degradation to the
   map's lossiness; that causal claim is not supported by the data and is withdrawn.)

### What surface actually drops, and the escalation that makes it lossless-on-demand

The map compresses exactly one axis: a **non-outlier column's exact y** is only known to its block's
legend band (a `#` cell at `y72..74` could be 72, 73, or 74). Everything else is preserved — block
id per cell, per-block y-band and counts, exact coords of outlier columns, and coverage metadata.
That compression is real and would bite tasks needing exact adjacent heights (reachability, per-tile
flatness variance) *if the map were the only source*.

It isn't. The raw per-column data still lives at the bridge, so the loss is a serialization choice,
not data loss. The mode now keeps an **escalation path**: an explicit `get_blocks detail:"full"`
returns raw per-column data even in surface mode, and the map's last line advertises it
(`for exact per-column y call get_blocks detail:"full"`). So the shape is *cheap map by default,
exact-on-demand* — the agent pays map-price for the overview and full-price only where a task needs
per-column certainty. (This also matches why the `surface` arm never suffered: with predicates it
answered heights/reachability from `get_region_summary`/`check_path` and rarely touched the map at
all.)

**Verdict.** The ARCHITECTURE.md:689 gate is now satisfied with data — surface preserves task
accuracy (+3 pts on the tools-available arm), so the format switch is *permissible*. But it's a
low-urgency ~2% optimization in the real config, whose main merit is that it fixes a latent
get_blocks crash and caps oversized `detail:full` reads. The genuine token levers remain, in order:
(1) the static tool-schema **prefix** (Finding 1, 50–92% of the bill), and (2) keeping the agent on
the **representation predicates** — which this run re-validates as both the accuracy and the token
win. Recommend: land the `asciiSurfaceView` fix + tests regardless (it's a bug); adopt
`MCPTK_GET_BLOCKS_VIEW=surface` as default only as a minor, safe cleanup, not as the headline win.

### Second run — with escalation enabled (`…06-16-24-tasks-haiku`, same questions)

Re-ran all four arms after adding the `detail:"full"` escape hatch, to see whether the crippled arm
*uses* it and whether it closes the gap.

| arm | run 1 acc / wc | run 2 acc / wc | get_blocks calls (run 2) | detail:full escalations |
|---|---|---|---|---|
| with | 97% / 2.67M | 94% / 2.63M | 1 | 0 |
| surface | 100% / 2.61M | 94% / 2.58M | 0 | 0 |
| without | 78% / 3.34M | 74% / 4.07M | 99 | 40 |
| without-surface | 74% / 3.48M | 66% / 4.37M | 109 | **39** |

Reads:

- **Production regime (with vs surface) is robust across both runs.** Accuracy is a tie (94 = 94
  this run; the run-1 100-vs-97 edge was noise), surface saves ~2% tokens, and the tools-available
  agent calls get_blocks **0–1×/32 sessions** — it answers from the predicates. Surface neither helps
  nor hurts accuracy; it's a small, safe token trim. Confirmed.
- **The escape hatch is used but does not rescue the crippled arm.** `without-surface` escalated to
  raw on **39 of 109** get_blocks calls (36%) — the mechanism works, 0 errors — yet it still landed
  *behind* `without` on both axes (66% vs 74%, 4.37M vs 4.07M, 5 vs 3 turn-caps). Both runs agree in
  direction (surface −4 pts, then −8 pts), so for a predicate-less agent the compact map is, if
  anything, a slightly *worse* substrate than raw — the map→escalate→full two-step spends extra turns
  on the hard rungs, which the turn budget can't always afford. This does not touch production (no
  predicate-less regime there) but it kills any idea that a cheaper get_blocks could stand in for the
  representation tools: it can't, escalation or not.

**Net:** adopt-as-default `surface` remains defensible purely as a safe ~2% trim + a crash fix; it is
not a lever of consequence, and it is not a predicate substitute. The real levers are unchanged: the
static prefix (Finding 1) and the predicates themselves.

## Reproduce

    # raw-vs-surface Category-T bench (needs the dev server up):
    node testbench/run-tasks.mjs --model haiku --seeds 2 --reps 2 \
      --arms with,surface,without,without-surface


    node testbench/tool-cacheread-report.mjs \
      testbench-results/2026-07-23T18-34-03-tasks-haiku \
      testbench-results/2026-07-23T18-08-29-mem-haiku \
      testbench-results/2026-07-23T18-02-22-play-haiku

    # Finding 4 — one tool's prefix cost + a batching tool's real saving (needs the dev server up):
    node testbench/run-shapebatch.mjs --dry                    # target, spec, arms — no spend
    node testbench/run-shapebatch.mjs --model haiku --seeds 3
    node testbench/run-shapebatch.mjs --from measurements/<dir> # re-derive the report, no spend

Caveats: token proxy is bytes/4 (consistent, not exact). C/P are precise (per-turn usage); T is
modelled from trace order × turn count. Bench data is gitignored — regenerate a category if cleared.
