# Reducing the tool bill — measured plan

Status: 2026-07-24. Numbers below are measured against the live headless manifest (66 tools) and the
existing token decomposition in TOKEN_PER_TOOL_FINDINGS.md. Nothing here is adopted on argument; each
lever names what would falsify it and which arm measures it.

## 1. What the bill actually is

The manifest is **74,797 chars of descriptions + schemas ≈ 18.7k tokens** (66 tools, headless; a
client instance carries more). Per Finding 1 the static prefix is **re-read every turn**, so:

```
bill ≈ prefix × turns + accumulated context
```

Measured share of Σ cache_read: **92%** prefix on category P (~7 turns), **50%** on category C
(~38 turns, 3.21M of 6.36M). On a C-length session a 30% manifest cut is roughly a million tokens.

Concentration (live measurement):

| slice | chars | share of manifest |
|---|---|---|
| top-10 tools | 27,700 | **37%** |
| 6 raw reads (`get_blocks`, `get_blocks_at`, `scan_box`, `raycast`, `raycast_fan`, `get_entities`) | 14,459 | **19%** |
| 16 dev/admin tools | 10,194 | **13%** |
| `bot_reactions` alone (1,792 desc + 1,982 schema) | 3,774 | 5% |
| shared doctrine restated across descriptions | 6,376 | 8.5% (14% of description text) |

**The multiplier matters more than any single cut.** A turn costs the whole prefix, so a tool that
saves one turn is worth ~18.7k tokens — more than any description you could trim. Cutting the
manifest by 32% is worth about as much as saving one turn in three. That ranks structural work above
copy-editing, and it is why the `locate` thesis attacks both factors at once (fewer tools shrinks the
prefix; answer-shaped tools shrink the turn count).

## 2. Levers, ranked by size × confidence

### L1 — Profile the manifest per session role. ~13%, zero accuracy risk, possible today.

`MCPTK_HIDE_TOOLS` already exists. A play/companion session has no use for `hotswap_class`, the
`*_data` tools, `launch_game`, the building pipeline, companion/session management, or `get_region`.
This is not deleting capability; it is not shipping the dev console to the survey agent.

**Guard against a misreading of our own data:** *dark-in-bench ≠ useless-in-production.* `world_edit`
is 0/6 dark purely because no bench task edits anything (BENCH_EXPANSION.md). The 47-dark number
should drive **profiles**, never deletions.

### L2 — The locate swap. 19%, best-evidenced, arm queued.

The six raw reads are exactly the tools the LOO scored at Δacc ≈ 0 (TOOL_VALUE_LOO.md). L1+L2
together are **32% of the manifest**. Design and known limits: §4.

### L3 — Trim the top-10 descriptions. Up to 37% of the bill sits there, but this is the risky one.

Those descriptions were written as human documentation. The repo's own finding is that agents reach
for the predicates *because* the descriptions tell them to, so cutting guidance can buy tokens and
lose accuracy in the same edit. Safest cuts first: **schema** rather than prose — `bot_reactions`
carries 1,982 chars of schema, `resolve_anchor` 1,977, `place_shape` 1,706. Bench before cutting
prose.

### L4 — Factor shared doctrine into the session charter. ~1,600 tokens, no routing level, no risk.

14% of description text is the same contract restated per tool (coverage semantics, never-generates,
absence-is-not-absence, coordinates-are-not-for-arithmetic). Concentrated where you would guess:

| tool | doctrine chars | mechanics chars |
|---|---|---|
| `get_entities` | **1,168** | 561 |
| `raycast` | 472 | 490 |
| `get_region_summary` | 438 | 1,257 |

`get_entities` is 68% doctrine — more contract restatement than tool. The charter already exists
(memory layer, SessionStart hook) and is paid once per session instead of once per turn per tool.
This one needs no bench; it is pure factoring.

*(Literal substring duplication is only ~1,000 chars — mostly the repeated `dimension` and `load`
property descriptions. Deduping strings is NOT the lever; moving the doctrine is.)*

## 3. Two ideas evaluated, with where each fails

### Escalating tool descriptions (stub + `tool_help(name)`)

**Token math favours it.** A stub manifest at ~40% of full saves ~11k/turn; each escalation costs one
extra turn (~7.5k + payload). On a 7-turn session two help calls cost ~16k against ~77k saved; on a
38-turn session it is not close.

**It fails invisibly, which is the real objection.** A truncated description does not make the model
pick wrong — it makes the model never realise the tool answers its question, and the tool goes dark.
That is strictly worse than paying for the description: you pay the stub *and* lose the capability,
and nothing in the output says so. It is also a second routing level applied to tool selection, which
is the shape the progressive-disclosure evidence (arXiv 2607.17598) says breaks accuracy.

**Therefore, if benched, the metric must include tool-call coverage** — did the load-bearing tool get
called at all — which `coverage-report.mjs` already computes.

### Collapsing tools

`locate` is the worked example: three would-be tools behind one polymorphic `what`.

**The criterion:** collapse when tools answer *the same question at different arity or resolution*;
never when they answer *different questions*. The first is a parameter; the second is a routing
decision, and moving a genuine routing decision into arguments is worse than leaving it in tool
selection — argument routing gets no harness support and is not what models are post-trained on.

By that rule:

- **`raycast` + `raycast_fan`** (4,440 ch) — a raycast *is* a 1×1 fan. Clean, ~2.2k back.
- **`get_blocks` + `get_blocks_at`** (5,232 ch) — grid vs position list, same question. Defensible.
- **`check_fit`/`check_clearance`/`check_path`/`check_site`** — different questions, different
  verdicts. Leave alone.
- `*_data` and the building pipeline — admin: **profile them away (L1) rather than collapse**. Hiding
  is free; collapsing is not.

**Sequencing:** L2 already *hides* raycast and get_blocks, so collapsing them only matters if the swap
arm fails. Collapse is the fallback, not a parallel track.

## 4. How to measure — no Java required

`index.mjs` already rewrites both results (`MCPTK_GET_BLOCKS_VIEW`) and the manifest
(`MCPTK_HIDE_TOOLS`). Everything above is a manifest transform in the Node shim:

- `MCPTK_MANIFEST=short` — truncate each description to its first sentence, register `tool_help(name)`.
- `MCPTK_MANIFEST=collapsed` — merge the same-question pairs, route in the shim.

Four metrics, and the third is the one that gets forgotten:

1. **accuracy**
2. **tokens**, split prefix vs variable (`tool-cacheread-report.mjs` already does this)
3. **turns** — the failure channel for description escalation
4. **tool-call coverage** — did anything go dark (`coverage-report.mjs`)

## 4a. DECISION (2026-07-24, after the §6c result) — what is adopted, and what is rejected

**ADOPTED — L1 profiles, shipped.** `MCPTK_PROFILE` in `mcp-server/index.mjs`, three nested slices,
composing with `MCPTK_HIDE_TOOLS`. Priced against the live manifest:

| profile | tools | ~tokens | vs today | basis |
|---|---|---|---|---|
| `full` (default) | 66 | 18.9k | — | unchanged; nothing breaks |
| `play` | 46 | 13.7k | **−27%** | reasoned: no session calls the dev surface |
| `survey` | 22 | 8.1k | **−57%** | measured neutral (§6c) for terrain/geometry work |

> **This table is a 2026-07-24 measurement and is read as one.** The manifest has grown since —
> `full` is **70 tools** on a live dev bridge (2026-08-26), the default became `standard` (§4b), and
> `entity` (0.90.0), the profile placement of `get_log` (0.91.0), the `query_registry` growth
> (0.92.0, +181 tok/turn into an existing entry) and `place_structure` (0.94.0, a 71st tool at 601
> tok/turn, `DEV_ONLY`) all post-date it. Two things
> are deliberately NOT patched into the row above: the counts, because a table half-remeasured is
> worse than one honestly dated, and the percentages, which were derived from that day's manifest.
> **`RELEASE_1.md` §C5 owns the re-price**, after §D and §E land, since re-pricing between every
> tool addition measures noise. The per-entry method (`TOKEN_PER_TOOL_FINDINGS.md` Findings 5, 7,
> 8) is what to use, and the newest entries are already priced individually there.

Default stays `full` on purpose: a silent capability cut is exactly the failure mode this repo
spends its honesty budget preventing. Profiles are opt-in per session role.

`survey` keeps **`raycast`** although hiding it benched neutral — no rung tests occlusion and it is
the only line-of-sight read in the toolkit, so 2,177 chars is cheap insurance against a capability no
measurement has exercised. `play` keeps `get_entities` and the raycast pair because substituting
`locate what:"hostile"` for them is **reasoned, not benched** — the §6c rungs are terrain and
geometry. Standing probe: `mcp-server/probes/profiles.test.mjs` (a profile that hides a name the
manifest lacks, or hides a measured load-bearing tool, fails the suite).

**ADOPTED — L2**, encoded as the `survey` profile rather than as a deletion. The six raw reads still
exist; they are simply not shipped to a session whose role never calls them.

**REJECTED — L4 as designed (move doctrine into the charter).** The measurement stands (14% of
description text is shared contract restated per tool, `get_entities` 68%), but the destination is
wrong: **tool descriptions must be self-contained.** The charter reaches Claude Code sessions through
the SessionStart hook; it does not reach an arbitrary MCP client, and the toolkit is an MCP server
that any client may attach to. Moving the coverage contract out of the descriptions would mean the
honesty doctrine — check `coverage.state`, absence is not evidence of absence, unread is not empty —
is present for our sessions and *silently absent* for everyone else. That is a worse failure than
the tokens are worth.

*What survives of L4:* compressing the restatements **in place** (same information, fewer words) is
still available — but that is L3, not L4, and it carries L3's risk: the descriptions are why agents
reach for the predicates at all. Gate unchanged: the `MCPTK_MANIFEST=short` arm with **tool-call
coverage** as a metric (§4), so a description edit that quietly makes a tool go dark is visible.

**DEFERRED — L3 and tool collapsing.** Both are real (~37% and ~10% respectively) and both trade
tokens against an invisible failure mode. Neither is worth starting before the `MCPTK_MANIFEST=short`
arm exists to detect it.

## 4b. DECISION (2026-07-29, Matthijs) — the locate surface becomes the default: `standard`

The §4a call ("default stays `full`") is REVISED: the measured half of L2 now ships by default.
New profile `standard` = full minus **exactly the three block reads with a benched 1:1 substitute**
(`get_surface`, `get_blocks_at`, `describe_box` — §6c: two-way `locate` for point identity,
`get_region_summary` for aggregates, `check_site` for volume predicates), and
`MCPTK_PROFILE` defaults to it (toolkit 0.28.0).

Scope is deliberately narrower than the benched swap arm: `raycast`, `raycast_fan`, and
`get_entities` STAY on the default surface. The swap arm hid all six at 97% parity, but only on
terrain/geometry rungs — the entity/sightline substitution remains reasoned-not-benched, and the
default must not be more aggressive than the `play` gate ("keep until a play/combat bench measures
it"). That bench (§5's "next measurement that would change anything") is unchanged and still the
door those three walk through.

What keeps this honest:

- **Bench baselines do not move.** `testbench/agent.mjs` pins `MCPTK_PROFILE=full` in the shim env —
  every arm is still constructed from the full manifest via `MCPTK_HIDE_TOOLS`, comparable with all
  historical dirs. The ablation lattice (`ablation/mcp-shim.mjs`) builds its own surface from
  `AGENT_WORLD_TOOLS` and never read the profile. Conformance reads the bridge `/tools` directly.
- **The cut is loud, not silent.** `standard` sits outside the role chain (keeps the dev surface
  `play` drops); `probes/profiles.test.mjs` asserts the default manifest differs from full by
  exactly those three names, so a drive-by addition to the drop list fails the suite.
- **Reversal is one env var**: `MCPTK_PROFILE=full`.

**Addendum (2026-08-28, toolkit 0.107.0): `standard` is no longer the default, and the hole this
section knew about is what moved it.** RELEASE_1.md §C2. Everything decided above stands as a
decision about a *navigation* rung and `standard` is unchanged, so every bench arm above is still
comparable. What changed is who runs it by default: nobody. The three block reads have a measured
1:1 substitute for an agent that WALKS and none at all for an agent that writes a box and reads it
back, and the default profile could not perform the read half of the 0.89.0 authoring round trip
(`describe_box detail:"layers"` -> legend -> `set_blocks` grid) for three releases — `menagerie`,
naming no profile, silently could not. The default is now `modding`, a keep-list authored from the
modder role: all three block reads present, and *smaller* anyway (52 tools / ~24.6k tok against
`standard`'s 100 / ~42.3k, re-measured live 2026-08-28 against a 94-tool manifest) because it drops
the 28 embodied verbs a content-authoring session never calls. `standard` keeps its benched shape and
its name on the ladder.

**Addendum (2026-07-30, toolkit 0.32.0): the one capability this profile actually cost is back, in
`locate`.** Hiding `describe_box` was the only part of §4b with a known hole — volume statistics
(PATTERN_SEARCH §Findings 5; LOCATE_ROUTES §D3), and §6c's own r11 trace shows the swap agent
reaching for `locate at` on a volume question and sampling points into that arm's only
confident-wrong. `locate at` now takes an EXTENT (`dx/dy/dz`) and `in:` a named region, returning the
census through describe_box's own implementation — the collapse rule (§3) applied at the arity that
was missing, rather than restoring a tool every session pays a description for. `standard` is
unchanged and now has no known capability gap; `describe_box` stays in `full` for its `layers` view,
which is deliberately not offered through the `locate` door (the measured extraction hazard).
`probes/profiles.test.mjs`'s exact-three-names assertion is untouched.

## 5. Order of work — status

1. ~~**L2 swap arm**~~ — **DONE**, §6c: 97% vs 97%, ~5% cheaper, 1:1 substitution confirmed.
2. ~~**L4 doctrine → charter**~~ — **REJECTED**, §4a: descriptions must be self-contained for
   non-charter MCP clients.
3. ~~**L1 profiles**~~ — **DONE**, §4a: `MCPTK_PROFILE=full|play|survey`, probes green.
4. **L3 / `MCPTK_MANIFEST=short`** — open. Build the arm (with tool-call coverage) before any
   description edit.
5. **Collapse** — open, and now lower priority: `survey` already *hides* the tools collapsing would
   merge, and hiding is free while collapsing costs a build plus a bench.

**Next measurement that would change anything:** a play/combat arm (Category P/E) that exercises
entity queries and sightlines. It is the only thing standing between the `play` profile and the
`survey` profile's cut — everything else is priced.

## 6. The L2 arm as run — and one honest limit found before running it

Arm definition (`run-tasks.mjs --arms with,swap`):

```
swap = BASE_HIDDEN + [get_blocks, get_blocks_at, scan_box, raycast, raycast_fan, get_entities]
```

Left available: `locate`/`anchors`, the four `check_*`, `get_region_summary`, `find_site`,
`resolve_anchor`, `mem_*`, and the embodied OBSERVE probes. Write tools stay hidden in **both** arms,
as in every prior T run — the bench measures perception, and an agent that can rebuild the world can
answer by construction. (This deviates from the informal "+ write tools" phrasing of the plan; keeping
BASE_HIDDEN unchanged is what preserves comparability with the existing `with` baseline.)

**Limit found by inspection, before spending anything.** The swap is not a clean substitution on every
rung, and one rung is *structurally* unanswerable in it:

- **r10 (`t10_multipoint`)** asks the block **identity** at 5 given coordinates. Nothing in the
  surviving set reports a block id at a coordinate — `check_fit` returns a boolean, `locate` answers
  "where is X" and not "what is at (x,y,z)". Expect ~0; that is a *known-unanswerable pairing*, not
  evidence about the hypothesis.
- **r11 (`t11_multibox`)** asks whether 4 boxes are entirely air, which `check_fit` answers exactly
  (its predicate is air-or-replaceable). Expect this to survive.

So the deliverable is not a single pass/fail number: it is a **per-rung capability map** — where
predicates + `locate` suffice, and where a raw read is genuinely load-bearing. That is the honest
form of "can we cut 19% of the manifest?", and it converts r10's failure from a confound into the
finding that **block identity at a coordinate has no predicate substitute**.

### 6a. Partial result (run stopped at ~50/132 sessions), and what it changed

Seed 1, rungs 1–8, 3 reps: **parity on 7 of 8** (t2–t8 all 100% vs 100%, at equal or fewer turns).
The single break was **t1 point identity: 100% → 0%**, degrading to `ABSTAIN (unknown)` on 2 of 3
reps — a capability loss, not an honesty loss. r10/r11 were never reached, so the multi-referent
question stayed open.

The right reading was not "keep `get_blocks_at`" (a patch) but **"`locate` has no reverse"**: t2–t8
are all top-down (constraint → positions) and survived; t1 is bottom-up (position → identity) and
died. Hiding the raw reads removed an entire *direction*, not a redundant tool.

### 6b. Resolution: `locate` is two-way (0.8.1)

`locate at:[{x,y,z,expect?}]` supplies the missing direction, in the relational frame. Live 16/16 +
66/66 regression. Manifest effect:

| | chars |
|---|---|
| `locate` before → after | 2,889 → 4,120 (+1,231) |
| 6 raw reads (hideable) | 14,412 |
| **net cut available** | **~13,180 ch ≈ 17.6% of the manifest** |

That beats the `swap-lite` compromise (16%, keeping `get_blocks_at`) *and* returns bottom-up answers
already related to the session's anchors. The full `swap` arm is now a fair test rather than a
known-unanswerable pairing, and r10 becomes a real measurement.

### 6c. RESULT — `2026-07-24T18-03-57-tasks-haiku` (rungs 1,5,8,10,11 × 2 seeds × 3 reps, 60 sessions)

**Accuracy 97% vs 97% — a dead heat — at ~5% fewer tokens.**

| rung | with | swap | note |
|---|---|---|---|
| r1 point identity | 100% | **100%** | was **0%** before the two-way fix |
| r5 heights | 83% (1 conf-wrong) | 100% | |
| r8 site search | 100% | 100% | top-tier control |
| r10 multipoint (5 referents) | 100% | **100%** | the untested multi-referent case |
| r11 multibox (4 boxes) | 100% | 83% (1 conf-wrong) | see below |
| **total** | **97%**, 44k/2.55M tok, 88k per correct | **97%**, 58k/2.41M tok, **83k per correct** | |

**The substitution is 1:1 and confirmed from the call log, not inferred:**

```
r1   with {get_blocks_at: 6}   swap {locate: 6}
r10  with {get_blocks_at: 6}   swap {locate: 6}
r8   with {get_region_summary: 6}  swap {get_region_summary: 6}
```

`locate` stood in for `get_blocks_at` on every single point-identity session, including the
5-referent rung, at one call each.

**Two honest qualifications.**

1. *The token win is ~5%, not 17.6%.* The manifest cut is 17.6% of **tool-schema** text, but the
   re-read prefix also carries the system prompt and task, and with-cache pricing discounts cache
   reads. 2.55M → 2.41M (−5.5%), 88k → 83k per correct answer (−5.7%). Real, and smaller than the
   headline manifest number — quote the measured one.
2. *r11 is the one place swap reads worse, and the mechanism is visible.* The swap agent reached for
   `locate at` (point reads) where the `with` agent used `scan_box`, and sampling cells is a weaker
   instrument for "is this volume entirely air" than describing the volume — one confident-wrong.
   n=6, so it is at the noise floor, but the mechanism is plausible and worth watching. Note that
   **neither** arm reliably picked `check_fit` (1/6 in both), which answers r11 exactly — that is a
   tool-discovery gap, not a swap problem.

**Two-rung theory: supported.** The top tier (`get_region_summary`) and the bottom tier
(`locate`/`get_blocks_at`) carried every rung. The middle tier appeared **twice in 60 sessions** —
`get_blocks` ×2, in the `with` arm on r5, the one rung where that arm scored *worse*. Suggestive
rather than causal at n=1, but consistent with everything else.

**Verdict: the 6 raw reads can be hidden in a production perception profile.** Accuracy-neutral,
~5% cheaper, and the capability that made the first attempt fail is now inside `locate`.

---

## 7. A SECOND UPSTREAM: Blockbench behind the shim (2026-08-26, mcp-server 0.45.0)

Everything above prices the bill of ONE server. This workspace has been paying two: `blockbench` was
registered as a PEER MCP server in `~/.claude.json` for the `mcmodding` project, which puts its whole
list into the prefix of every session no matter what that session is for.

**Measured live** (Blockbench MCP 1.6.1, `http://127.0.0.1:3000/bb-mcp`, captured at
`mcp-server/probes/fixtures/blockbench-2026-08-26.json`): **94 tools, 72,664 chars, ~18.2k tokens**,
re-read every turn. The fattest entries are `place_cube` (2,038 chars), `manage_keyframes` (1,872),
`batch_keyframe_operations` (1,846), `paint_settings` (1,823) — an armature/animation/PBR surface that
Minecraft Java's cuboid models cannot express and this workspace has never called.

A peer registration cannot be profiled, cannot be narrowed by `tool_surface`, and cannot be told about
`capabilities.tools.listChanged` — so opening Blockbench after a session starts left its tools
invisible for the life of that session, the same connect-time-snapshot trap §0.98.0 fixed for the game
bridge. `mcp-server/upstream/blockbench.mjs` makes it an upstream of this shim instead, at which point
all three become problems the shim already solves.

**What it costs and what it saves, measured live 2026-08-26 with the game bridge down** (so these are
local + Blockbench only; the bridge adds its own ~90):

| profile | tools | chars | ~tokens |
|---|---|---|---|
| `standard` | 104 | 83,472 | 20,868 |
| `art` | 29 | 24,011 | 6,003 |

`tool_surface {profile:"art"}` reported **14,865 tokens saved per turn**, and the Blockbench surface
alone goes 94 → 20 (a 79.7% cut against the pinned capture; `probes/blockbench-surface.test.mjs`
prints both figures and asserts a floor, never the figure). The site of record for the keep-list's
number is the `BLOCKBENCH_KEEP` comment in `mcp-server/index.mjs`.

**Which profiles serve it:** `standard`/`full`/`entity` (the workbench roles) and `art` (the slice).
`play`/`survey`/`survival` do not serve it and do not even POLL it — a body does not open a modelling
app. `authoring`/`rocketeer_authoring` do not either: they are BLOCK-authoring surfaces, and adding
18k of mesh editor would undo the 72% they exist to save.

**The precondition, which is the whole trade:** this saves nothing while the peer registration also
exists. Two paths to one server pays both prefixes and serves every name twice. Adapter in,
registration out, together — `claude mcp remove blockbench`.

**Names pass through unprefixed.** All 94 checked against the captured 90-tool bridge manifest: zero
collisions, so every name in past transcripts and in `blockbench_sources/` keeps meaning what it
meant. A future collision is dropped on the Blockbench side (the game owns its names) and said out
loud on stderr.
