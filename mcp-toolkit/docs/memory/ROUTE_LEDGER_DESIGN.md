# The route ledger — recording what `locate` could not answer, and routing the words it should

Status: **BUILT 2026-08-02, UNCOMMITTED, LIVE-UNRUN.** mcp-server 0.17.0. 149 offline probes green
(38 new in `memory/probes/routes.test.mjs`), 24 ablation green, 8 resume green; the first backfill
over `testbench-results/` is real data and is quoted throughout. Nothing here has run against a live
game yet — `trial`, the leg-resolution cache and the executor's merge have been exercised only
against a fake bridge. Authority: this doc for the ledger/route/escalation contract;
`LOCATE_ROUTES.md` for which questions `locate` can route at all; `PATTERN_SEARCH_DESIGN.md` for
pattern/set semantics; `ARCHITECTURE.md` §locate for doctrine.

Matthijs's design, 2026-08-02: *"perhaps occasionally the model might attempt to use it in an
invalid way — store/report this for all sessions and collect it in an overview … 'tree' or 'wood'
could be an autorouted pattern search … anything that fails could be escalated to an agent that
builds a specifically tuned pattern search, stored as an unauthored route, later authored."*

---

## 1. Why this exists

`locate` is the survey front door, and since 2026-07-29 the default profile is `standard` — a
question `locate` cannot route is a question the session cannot ask. LOCATE_ROUTES.md's sixteen
findings and its **"Still open, ranked"** list were produced by reading code and reasoning about
what a model *might* ask. Nothing measured what models actually asked, because nothing recorded it:

- `BridgeServer.audit()` fires only for `WORLD_EDIT`/`PRIVILEGED` mechanisms. `locate` is `observe`,
  so it is excluded **by design** — the audit exists to make world *changes* attributable.
- `EventLog` is an in-memory ring that dies with the game.
- The Node shim turned `ok:false` into `isError:true` text and forgot it.
- Worst of all: the unresolvable-`what` fallthrough (MEMORY_REDESIGN §3) *converts* a concept miss
  into a plausible `ok:true` answer from memory. The single most informative failure the toolkit
  has — "this word means nothing to me" — was being **erased on the way out**.

The one datapoint of this kind on record (TODO.md: *"models repeatedly guess `detail:"full"` on
scan_box — cross-tool vocabulary drift, 8 errored calls in one arm"*) was found by hand-reading a
bench log, once.

## 2. The ledger (`memory/route-ledger.mjs`)

Every tool outcome passes through `recordOutcome()`, called from `index.mjs` and
`ablation/mcp-shim.mjs`. It appends one line per *unanswered* call to
`memory-data/routes/ledger.jsonl` — global, cross-session, cross-world.

**Ordering is the load-bearing part.** The recorder runs **before** the fallthroughs, on the raw
bridge verdict. Recording after them would see `ok:true` from the memory search and write nothing,
which is precisely the erasure above.

**Successes are not recorded.** The ledger is about what did not work; a full call log is the bench
transcript's job. Two exceptions: the *silent miss* (below) and the *sequel*.

### The buckets, and why pooling them is useless

Each wants a different fix, and only one of the six is a route problem:

| bucket | what it is | the fix |
|---|---|---|
| `vocabulary` | `what` resolved against no registry ("tree") | a route |
| `affordance` | well-formed, wrong: `occupancy` on a non-POI route, `detail:"full"` on the wrong tool | error text / schema wording |
| `capability` | a legitimate question refused **by design**: a cap, a budget, `in:` on a nearest-only index | LOCATE_ROUTES.md's open items — now with demand data |
| `referent` | pointed at something that is not there: a dead entity id, an unknown set, a missing place | handle lifetime and staleness signposting |
| `silent_miss` | not an error at all: a valid search that found nothing **and could not prove absence** | the failure that never raises, hence was never counted |
| `environment` | bridge down, no body, timeout | nothing — but pooling it would drown the other five |
| `crash` | an internal defect surfaced to the model as an ordinary refusal | fix the code |

`affordance` is where PATTERN_SEARCH §Findings 6 cashes out — *error text is a routing surface*, and
both shipped discovery fixes were error-remedy edits at the moment of need, cheaper and better
targeted than description growth (which the tool bill taxes every turn).

`unclassified` is deliberately visible in the overview: an overview whose biggest bucket is "other"
is telling you the classifier is stale, and that has to be legible rather than quietly absorbed.

### The sequel — adjacency, and how much it is worth

A miss followed within 4 calls / 5 minutes by a call that **worked and found something** is recorded
as a `sequel`. The pair — `"tree"` → `#minecraft:logs` → 3 found — is a candidate route the model
contributed for free.

**It cannot tell whether the model kept trying or moved on, and it does not pretend to.** The first
version of this section claimed frequency across sessions would filter the noise. That argument is
weaker than it sounds: frequency filters *random* noise, and a model's post-failure behaviour is
**systematic**. A model with a habitual fallback — always re-asking for stone, always calling
`bot_status` — would produce a high-frequency false pattern indistinguishable from a real repair, in
exactly the shape that looks most convincing. Frequency is the wrong instrument for a systematic
confound.

So each sequel carries four cheap continuity features, all already in hand, **none of them a gate**:

| feature | what it means | strength |
|---|---|---|
| `remedy_taken` | a registry lookup happened in the gap | near-conclusive — the mod's error text literally says *"use query_registry to find the right id"*, so taking that advice and then succeeding is the model narrating its own repair |
| `same_extent` | the retry asks about the same box | good — a continuation looks in the same place. `null` when neither call stated an extent, which is common and proves nothing (the body may have walked) |
| `more_specific` | a bare word became a namespaced id or tag | weak alone — it is the shape of a repair *and* equally the shape of moving on to a better-formed question |
| `lexical` | the two share a word stem | weakest, and never required: `"tree"` → `#minecraft:logs` share nothing, and that pair is the single most valuable one this mechanism exists to catch. Absence means nothing |

`strong` = score ≥ 2, and it is a **display split, not a filter** — nothing is discarded for scoring
low. The overview sorts followups strong-first rather than frequency-first, and labels a bare
adjacency as such, so "3 sessions all took the registry remedy and re-asked the same box" and "3
sessions happened to call locate again" stop being the same number.

Two structural reasons this is the right shape rather than a cleverer classifier:

- **The pipeline already has a precision gate downstream.** A candidate becomes a route only by
  being proposed, trialled and promoted. So this layer's job is *recall* — surface everything, cost
  a reviewer a glance — and its only real obligation is to not misrepresent what it saw.
- **A candidate does not close its window.** The first version let the first qualifying success
  claim the miss and drop it, so one incidental adjacent call could eat the slot and hide the real
  continuation two calls later. Up to 3 candidates per miss are emitted now.

The field is `followed_with`, not `repaired_with` (the old name is still read, so an existing ledger
parses). The ledger observed adjacency; calling it a repair would be asserting the one fact it
cannot observe, which is what the rest of this system spends its honesty machinery refusing to do.

### Storage

Append-only JSONL, unlocked: a single sub-4KB `O_APPEND` line is atomic on POSIX and Windows, and
this is telemetry — a cross-process lock on the hot path of every tool call would be a worse trade
than the torn line it prevents. The reader skips unparseable lines and says how many. `rewrite()` is
the one non-append operation and has exactly one caller (re-backfilling the immutable bench archive,
which must replace its own prior rows rather than double every count).

**Never throws.** Every entry point is wrapped. A telemetry layer that can break a tool call is
worse than no telemetry layer.

## 3. The route table (`memory/routes.mjs`)

A **route** maps a word an agent types to a **disjunction** of predicates `locate` can really run.

```jsonc
{ "concept": "wood", "aliases": ["woods", "lumber"],
  "legs": [{ "what": "#minecraft:logs" }, { "what": "#minecraft:planks" }],
  "needles": ["log", "plank"],
  "provenance": "authored" | "unauthored",
  "note": "logs OR planks — the word covers the raw and the crafted form…",
  "trials": [ { "world", "center", "found", "negative_is_proof", "by" } ] }
```

**A leg may carry `what` and nothing else** — enforced in `validateRoute`. A leg with its own radius
would make the composed negative (§4) a claim about several different boxes wearing one sentence.

**Storage splits by what actually varies.** Concept→predicate is **global** (a tree is a tree in
every save) and lives at the memory root beside `last_world.json`. Predicate→ids is **per-world** (a
modpack has other logs, a datapack can remove a tag) and rides `routes/worlds/<uuid>.json` as a
leg-resolution cache, so a route that has quietly lost half its legs is visible in `routes-cli
routes` rather than merely weaker.

**Seeds live in code**, not on disk, so upgrading the package upgrades them; `table.json` holds only
what sessions and humans add, and a file entry overrides a seed of the same name. Twelve seeds ship:
tree, wood, log, leaves, ore, plank, bed, door, crop, flower, sapling, wool. **Every tag was verified
against the decompiled 26.2 source** (`vanilla-src/net/minecraft/tags/BlockItemTags.java`) rather
than remembered — a seed naming a tag that does not exist is exactly the confident-wrong this layer
is supposed to prevent, and it would fail *inside* an answer rather than at parse time.

**No fuzzy matching.** Lookup is exact over concept + declared aliases + the singular/plural pair,
and that is the only inflection allowed (Minecraft's own tags are plural, so it is the language's
convention showing up in the data, not a guess about meaning). `treetop` does not resolve to `tree`.
A near-miss must stay a miss and go to the ledger, because answering a nearby question is the
confident-wrong class the whole locate design fights.

**`wheat farm` must never route.** It names a *place*, and a place is what the memory fallthrough
answers correctly. A route there would convert a good answer into a bad one.

## 4. The executor (`memory/route-exec.mjs`) — the part that is a capability

The synonym half is small: `what:#minecraft:logs` has worked since B1/0.29.0, so routing "tree" is a
**discovery** fix. That is still the right thing to spend on — PATTERN_SEARCH §Findings 1 says
discovery is *the* bottleneck, whole-ladder. But the executor adds something the tool genuinely
could not do:

**Disjunction.** A pattern node takes exactly one matcher; there is no `or` and no `not`
(LOCATE_ROUTES B2), and §B1 records the consequence — *"N separate scans cannot compose one honest
negative."* A model can scan for logs, get a clean miss, scan for planks, get a clean miss, and own
two true statements it is not entitled to add together: nothing tracked whether the two extents were
the same box, whether either tripped a cap, or whether a leg failed to run at all.

The executor owns every leg of one concept, so it can add them up. It holds the caller's extent fixed
(legs may vary only `what`), runs every leg against the same centre, and composes:

```
negative_is_proof = every leg ran
                  ∧ every leg proved its own negative
                  ∧ the route is AUTHORED
```

Same recursive composition a pattern already performs over its result sets (PATTERN_SEARCH
§Honesty), one level up. Every failed clause names itself in `search.note`.

### The three honesty rules

1. **The interpretation is disclosed.** `search.route` states concept, what was asked, the legs, the
   provenance and the route's own caveat — beside `search.promoted`, which already does this job for
   the block-id promotion. The caller asked for a tree and is being shown logs; if the payload does
   not say so, the next restatement launders it, which is the 0.6.0 succeeds-falsely class through a
   new door.
2. **An unauthored route can never prove a negative.** Not because the scan was worse — it may have
   read every chunk — but because the **definition** was guessed. "No tree within 64" is a claim
   about what a tree is as much as about the box. This is the set-provenance rule (a pattern
   inherits its set's honesty) applied to vocabulary, and it is the single rule that separates a
   route table from a confident-wrong generator.
3. **A route only fires in the dead-end slot.** If `what` resolved against any registry, no route
   runs. Routing over a working answer would be the tool silently answering a different question on
   the model's most common call.

### Two smaller decisions

- **`as` is dropped on a multi-leg route, loudly.** There is no union-of-sets in the mod, and quietly
  storing the last leg's set under the caller's name would hand back a fraction of the answer, which
  then poisons every refinement chained onto it. The note says how to get a real set (re-run one leg
  by name). On a single-leg route `as` survives untouched — nothing is lost, so nothing is taken.
- **Every leg failing returns `null`**, so the caller falls through to the behaviour that existed
  before this module. Manufacturing an empty result would report "no trees" from a search that never
  happened, which is the worst answer available.

### Ordering: route first, memory second

```
locate what:"tree"  →  bridge says unresolvable
                    →  RECORD the miss                    (before anything rewrites it)
                    →  tryRoute()      — a class of block, searched live
                    →  locateFromMemory() — a place, remembered
```

A place has no route and never will, which is why the memory fallthrough keeps the last word rather
than the first.

## 5. One vocabulary, two consumers

`legal-locate.mjs` already contained a private route table: a de-pluralizer written for one bug
(`what:"logs"` missing a store full of `oak_log`, the second watched survival run), invisible to the
authoritative search, and unable to know that "tree" means a log at all. It now asks the shared table
first — a survival session cannot resolve a tag, so what it takes is the `needles` half, the
substrings this family's recorded ids contain — and keeps its de-pluralizer as the fallback for every
word nobody has routed, which is what it was always good at. One-definition rule. The remembered
answer discloses its route the same way the authoritative one does.

## 6. Escalation — never inline, and a trial is the product

**Never inline.** `locate` is a fast deterministic read; blocking a tool call on an LLM round-trip
would change its cost class invisibly to the caller. The miss returns immediately and honestly (with
the frontier, under survival); escalation runs out of band; the **next** attempt hits the route.

The queue (`routes/queue.json`) accumulates vocabulary misses with bounded evidence. `routes-cli
escalate --spawn` hands the top concepts to `companion_spawn` — the mechanism already exists, and it
matters that it does: `CompanionSessions` runs a headless `claude -p` with the toolkit attached, so
the authoring agent can **test its own candidate against the live world**.

**A candidate is not a route until it has run.** The agent's product is a route *plus evidence*: it
executed the legs somewhere the answer was known and this is what it found. `promote` refuses a
route with no trial (`--force` exists and says so in the output). "Unauthored" therefore means
*untested by a human*, and promotion is the act that lets a definition prove a negative.

The authoring brief (`routes-cli prompt <concept>`) is mostly **prohibitions**, because the failure
mode of this job is an enthusiastic agent inventing a definition and a trial that agree with each
other. It tells the agent to refuse — and say so — when the word names a place, when it is
irreducibly ambiguous ("stuff", "resources", "danger"), or when it cannot be tested. An empty answer
is a fine outcome.

## 7. The overview (`memory/routes-cli.mjs`)

A CLI, not a tool: the static tool prefix is re-read every turn and measures 50–92% of the bill
(TOKEN_PER_TOOL_FINDINGS Finding 1), so a surface whose audience is a human reviewing telemetry must
not cost every session a manifest entry. The escalation agent reaches it the same way a human does.

`overview` · `routes` · `queue` · `backfill` · `prompt` · `escalate` · `propose` · `trial` ·
`promote` · `reject`.

**Backfill reads two sources**, because they see different failures. `transcript-*.jsonl` is the
harness's own per-call log — the bridge-level view. `sdk-*.jsonl` is the only place a client-side
`InputValidationError` appears: the MCP client rejects those against the schema and the shim never
sees the call at all, so **a ledger built only from the shim is structurally blind to them**.

### First run: 131 unanswered calls out of the archive

```
affordance   56   ████████████████████████
environment  27   ████████████
capability   23   ██████████
crash        12   █████
referent      8   ███
vocabulary    5   ██

  23× [capability ] box volume N exceeds the cap of N blocks
  16× [affordance ] no current task — mem_task set first
  16× [affordance ] not eligible: pos: expected [x,y,z] ints or null, got [null,null,null]
  12× [crash      ] Cannot read properties of undefined (reading '…')
   7× [referent   ] no such living entity (id N) in the body's level
```

Four things this immediately produced, none of which was visible before:

1. **`referent` was not one of the four buckets.** It exists because the first backfill produced nine
   `unclassified` rows and seven were `bot_engage` against entity ids of `1`, `-1` and four dead
   mobs — a model *inventing referents*, which no amount of error rewording fixes. The ledger found
   a bucket the design had not thought of, on its first run.
2. **`"chest" 3× in 3 independent sessions**, via `unknown entity type 'minecraft:chest'` — a model
   asking for a *block* through the *entity* door. Keying demand off `locate.what` alone would have
   missed all three, which is why the concept is also recovered from the error text
   (`conceptFromError`), tool-agnostically.
3. **23 volume-cap refusals** is demand data for D3's counting rung, ranked against everything else
   for the first time.
4. **The 12 crashes are historical, not live.** All twelve are from one run on 2026-07-23, from the
   old `asciiSurfaceView` re-wrap of `get_blocks` in the ablation shim. That re-wrap has since been
   removed ("serve perception straight") and the production path wraps it in `try/catch`. So the
   ledger surfaced a real defect that had already been fixed by accident — worth stating plainly
   rather than claiming a live find.

The corpus is memory-bench-dominated and `locate at`-heavy (245 of 273 locate calls are cell reads),
so it says little about the *search* direction. It proves the instrument, not the population.

## 8. The bench hazard, and the guard

A route table that accumulates across sessions makes the toolkit **non-stationary**: run the same
bench twice and the second run knows more words. And `tools_hash` **structurally cannot see it** — a
route changes what `locate` can answer without adding, removing or rewording one manifest entry, so
two runs with different vocabularies hash identically on tools and pool silently. That is the same
failure as `e_repair_bridge_gap` (a pre-fix toolkit build pooling with post-fix builds under one
unchanged `bench_version`, resume.mjs), arriving through a door that fingerprint does not watch.

Three parts:

- **`MCPTK_ROUTES` = `off` | `record` | `frozen` | `learn`** (production default `learn`), read at
  *call* time, never captured at module load — ESM evaluates static imports before the importing
  module's body, so a constant could not be overridden by a shim setting its own default.
- **The bench is pinned to `record`** in `testbench/routes-pin.mjs`, imported by `agent.mjs` and
  every runner. Not `off`: `record` never fires a route, so the SUT is byte-identical to every
  historical row, while the ledger still fills — and a bench run is the richest source of
  unanswered-call data there is.
- **`routes_hash` joins `RESUME_GUARDED`** and every runner manifest, as `<mode>:<count>:<sha12>`.
  `routes-pin.mjs` both applies the pin and reports the hash, so the manifest cannot record a mode
  the run did not execute. Runs predating the field carry `undefined` on both sides and compare
  equal, so nothing historical becomes unresumable.

`routes on` vs `routes off` is also the obvious bench arm — a direct test of the Finding 1
discovery-bottleneck thread. Nothing has measured it yet.

## 9. Probes (`memory/probes/routes.test.mjs`, 38, offline)

In order of how badly it would hurt to lose them: the unauthored negative (an unauthored route must
never report `negative_is_proof: true`, however cleanly its legs ran); the disclosure; the composed
negative (one weak leg poisons the whole verdict; a leg that could not run poisons it rather than
shrinking the question); the recorder running *before* the fallthrough; and no-fuzzy-matching.

Plus: the executor's merge/rank/dedupe, `as` dropped on multi-leg and kept on single-leg, the
all-legs-failed `null`, `frozen` withholding unauthored routes, promotion refusing an untrialled
route, the classifier's bucket boundaries, `errorShape` collapsing 23 refusals into one row, the
sequel window, the queue's rejection latch, and `recordOutcome` never rejecting on a broken root.

One probe exists because of a bug the *suite* could not have caught: every other test runs against
an `mkdtemp` root that already exists, so **the path a real first install takes was the one path
untested**, and it failed with a bare `ENOENT` on `.lock`. Found by smoke-testing the CLI.

### Not yet done

- **Nothing has run live.** `trial`, the per-world leg-resolution cache, and the executor's merge
  against a real bridge are all unverified. The live probe files call `${BASE}/cmd` **directly** and
  bypass the shim entirely, so no existing live suite can cover a Node-side feature — a live route
  probe has to drive the shim, and that harness does not exist yet.
- No bench arm has priced the layer.
- The seeds have zero trials. They are authored on a source reading, which is stronger than a guess
  and weaker than a run.

## 10. Files

| file | what |
|---|---|
| `mcp-server/memory/routes.mjs` | route table, seeds, modes, fingerprint, per-world leg cache |
| `mcp-server/memory/route-ledger.mjs` | classifier, ledger, sequels, queue, `summarize` |
| `mcp-server/memory/route-exec.mjs` | disjunctive executor, composed negative, disclosure |
| `mcp-server/memory/routes-cli.mjs` | overview, backfill, escalation, propose/trial/promote/reject |
| `mcp-server/memory/probes/routes.test.mjs` | 34 offline probes |
| `mcp-server/testbench/routes-pin.mjs` | the bench pin + `routes_hash` |
| `mcp-server/index.mjs`, `ablation/mcp-shim.mjs` | the two hook sites |
| `mcp-server/memory/legal-locate.mjs` | route needles feed the survival belief store |

Cross-references: LOCATE_ROUTES.md (§D1 memory union, §B1/B2 the predicate holes this closes half
of, "Still open, ranked" — now measurable), PATTERN_SEARCH_DESIGN.md (§Findings 1 discovery, 6 error
text as routing surface, §Honesty the composition this mirrors), MEMORY_REDESIGN.md §3 (the
fallthrough this sits in front of), TOOL_BILL_PLAN.md §4b (why an unroutable question is
unanswerable under `standard`), FREEZE_PLAN.md (`routes_hash` as the second SUT axis).
