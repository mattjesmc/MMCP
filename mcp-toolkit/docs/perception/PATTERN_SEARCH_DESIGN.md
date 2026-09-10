# Pattern search — the relational rung of `locate`

Status: SHIPPED + BENCHED 2026-07-25 (designed, built, probed, priced and iterated in one day —
§Results at the end of this doc is the consolidated overview of the whole arc: versions
0.18.0→0.20.0, all five bench runs, findings, and the standing recommendation). This is the "volume scan" rung
ARCHITECTURE.md §locate deferred ("no volume scan and no anomaly detection: those are a later
rung, gated on this one benching") — the gate ran 2026-07-24 (surface-swap arm, TOOL_BILL_PLAN
§4a: `locate` substituted 1:1 for the point reads at equal accuracy), so the rung unblocks.
Authority: ARCHITECTURE.md for vocabulary and doctrine; this doc for the pattern/set semantics.

## What this is

`locate` gains a third argument, `pattern`: a **declarative conjunctive pattern** — typed nodes
(block matchers, entity matchers, prior result sets) plus relations between them (adjacent,
above, below, offset, within) — and the server returns the places where the whole configuration
holds. "Two gold blocks adjacent", "a gold block with a living entity standing on it", "a hopper
feeding a furnace whose output chest sits beside it": the model states the *relation*, the
server produces the *coordinates*. Same inversion as find_site/resolve_anchor, generalized from
one relation to a stated conjunction of them.

Search results can be **named into a result set** (`as:`), and a later pattern can use that set
as a node (`set:` node kind) — refinement seeds from the stored members instead of rescanning.
That is the repetitive-escalation loop: find all X (cheap, wide) → inspect → "of those, which
have Y above them" (cheaper, narrower) → … Each step is opt-in; the one-shot compound pattern
remains a single call, so no mandatory second routing level is introduced.

## Why (the evidence, briefly)

- The two-rung finding (TOOL_BILL_PLAN): models need **a computed answer over many cells or an
  exact fact about one** — the middle (raw grids) went dark, 2 calls in 60 sessions. A pattern
  match is a computed answer over many cells; it lands on the proven end of the barbell.
- Cross-domain joins (block×block geometry, block×entity) are today assembled model-side from
  get_entities + get_blocks_at output — coordinate arithmetic plus map integration, the two
  documented failure modes the perception design exists to remove.
- The bench's **relational discipline** (t13 hopper-chain, a13, z_diag_wiring) is the pricing
  instrument; this ships as hypothesis, the bench arm decides (see §Bench).

## Shape

`locate` takes exactly one of `what` | `at` | `pattern`. Still no mode flag: which argument is
given selects the question, per the collapse rule ("merge tools that compute the same relation
with a different unknown"). `pattern` is the `what` direction with a composite subject —
thing-configuration → positions.

```jsonc
locate {
  pattern: {
    nodes: [
      { "id": "a", "block": "minecraft:gold_block" },          // BlockInput, set_blocks syntax
      { "id": "b", "block": "minecraft:gold_block" },
      { "id": "e", "entity": "living" }                        // get_entities vocabulary
      // { "id": "g", "set": "golds" }                         // member of a stored result set
    ],
    relations: [
      { "rel": "adjacent", "of": ["a", "b"] },
      { "rel": "above", "of": ["e", "a"] }
    ],
    anchor: "a"              // optional: which node's positions are THE result (default: first)
  },
  near: { "x": 100, "z": -40 },   // scan centre, required for pattern (like `what`)
  radius: 32,                      // horizontal half-width; default 32, cap 128
  y_range: { "min": 60, "max": 90 },  // optional vertical bound; default full world height
  limit: 5,                        // reported referents; matches_total always reported
  as: "marked_golds"               // names the RESULT SET (all anchor positions, capped)
}
```

### Node kinds — exactly one key per node, all reusing existing vocabularies

- `block`: vanilla `id[state]{nbt}` string through `BlockTools.parseInput` — **the same
  `BlockInput` matcher `expect` and `/execute if block` use** (one-definition rule; partial
  properties and NBT included).
- `entity`: exact type id (`minecraft:zombie`), `#tag`, or category `hostile|living|item|player`
  — `locate what`'s existing entity matcher, reused verbatim.
- `set`: the name of a result set this session stored. Members are re-verified on use (§Sets).

### Relations v1 — deliberately tiny; grown only when a task needs one

Every node occupies a **cell**: a block node its position, an entity node `blockPosition()`
(the cell containing its feet). Relations are cell relations:

| rel | of | holds when | params |
|---|---|---|---|
| `adjacent` | [a,b] | cells share a face (6-neighborhood) | — |
| `above` | [a,b] | cell(a) == cell(b) + (0,+1,0) — an entity `above` a block is standing on it | — |
| `below` | [a,b] | cell(a) == cell(b) + (0,−1,0) | — |
| `offset` | [a,b] | cell(a) == cell(b) + (dx,dy,dz) — the general exact form | dx,dy,dz |
| `within` | [a,b] | Chebyshev distance ≤ r (3D: max of |dx|,|dy|,|dz|) — block-grid "near" | r |

Not in v1 (each waits for a task that needs it, per the anti-speculative-taxonomy rule):
disjunction/negation, counting ("at least 3"), diagonal adjacency, horizontal-only within,
line/plane relations, block-property joins ("same facing"), anomaly detection ("unusual for
this biome"), and **any scripted/imperative predicate** — a freeform script is inner-model
query formulation, is unpriceable by the bench, and can't be held to the conformance contract.
The relation graph must be **connected** (a disconnected pattern is a cross product — reject
with the reason, don't enumerate it).

### Results

Same contract as `what`: up to `limit` matches come back as referents — handle
(`marked_golds@x,y,z` / block short name), pos, per-node `bindings` (where each node landed for
that match), `relations` to observer + ≤2 ledger anchors — and join the anchor ledger.
`matches_total` counts all matches found (search doesn't stop at `limit` unless the match cap
trips). The `search` record carries `mechanism: "pattern_scan"` + extent + `negative_is_proof`
+ measured `ms`, and lands in the ledger like every search.

## Result sets — marked ids, chained refinement

`as:` on a pattern (or entity/POI `what`) search stores a **result set**: the anchor node's
cells for every match (not just the reported `limit`), capped at 256 members.

```
ResultSet {
  name, dimension, tick, matcher,        // matcher = the anchor node's block spec, re-testable
  members: [{x,y,z}],                    // cells of the anchor node, one per distinct match
  extent: { chunk box, fully_read },     // what the producing scan covered
  truncated: bool                        // member cap or candidate cap tripped
}
```

- **Block cells only.** The pattern `anchor` must be a block node; sets of entities are not in
  v1. Entity results are already served by volatile anchors (UUID re-resolution), and a stored
  entity set cannot distinguish *gone* from *chunk-not-loaded* on re-use — an ambiguity that
  would poison every downstream negative. Waits for a task that needs it, like every other
  vocabulary extension. Entity nodes still participate in patterns; they just aren't the
  stored result.
- **Re-verified on every use.** A member is re-tested with the stored `BlockInput` at its
  cell; a mined gold block drops out, counted `stale_dropped`. An unreadable member (chunk not
  readable now) is neither kept nor silently dropped: counted `unverifiable`, excluded from
  matching, and it poisons the negative (below). The set is therefore a symbol table entry
  that re-reads the world on every use — the exact line the ledger's don't-build clause draws.
- **Bounded ring**: 8 sets per session, oldest evicted; sets die with the session and the
  world (same reap as anchors). No pinning in v1.
- **Same-dimension only**: a pattern referencing a set from another dimension is an error.
- `anchors` lists sets (name, size, age, extent one-liner, truncated flag) and `drop`s them by
  name; `clear` drops sets too.

## Matching: escalation inside the tool

1. **Candidate enumeration, one cheap pass per node kind.**
   - Block nodes: one sweep over the extent's chunks via `ChunkAccess.findBlocks` — the
     **section palette prefilter** (`LevelChunkSection.maybeHas`) skips every 16³ section whose
     palette lacks the block, so scanning for anything rarer than stone is nearly free. All
     block nodes share the one sweep (combined predicate, bucketed per node). The state-level
     prefilter comes from `BlockInput.getState()`/`getDefinedProperties()`; a matcher with NBT
     re-tests candidates with the full `test(level,pos)`.
   - Entity nodes: the existing entity-section query (horizontal radius, full height).
   - Set nodes: the stored members, re-verified (§Sets) — no scan at all. This is why chained
     refinement gets cheaper each step.
   - Per-node candidate cap 4096; tripping it flags `truncated` and kills the negative.
2. **Join, smallest first.** Nodes ordered by candidate count; seed on the smallest, then
   resolve neighbors through exact relations (offset/above/below give 1 candidate cell,
   adjacent gives 6 — membership-checked against the node's candidate hash set) with
   backtracking for `within`. Match cap 512 (`matches_capped` flag).
3. Chunks page in through the shared `ChunkLoader` (never generate, 48-chunk/1.5s budget);
   unreadable chunks ride the extent accounting.

Cost is reported, not hidden: `search.ms`, chunks swept/paged/skipped-by-palette.

## Honesty: the negative, composed

`negative_is_proof` (and the trustworthiness of `matches_total`) is TRUE only when **every**
input was fully seen:

- every chunk in the requested extent was readable (else: chunk shortfall named),
- no candidate/match cap tripped,
- every set node was clean: produced `fully_read` + not `truncated` at creation, and this
  use's re-verification had `unverifiable == 0`.

Any failure turns `negative_is_proof` false with the cause named in `search.note`, and the
scoped claim is stated the way locate already states it: "no match **within the readable
extent**". A set-node search additionally stamps `search.scope` with the set's provenance
(name, creation tick, original extent) — "no entity above any of these golds" is a claim about
*those golds*, found *there*, *then*, and the record must say so, or chaining launders a
partial scan into a universal negative two calls later (the 0.6.0 succeeds-falsely class
through a new door; negatives are what lie when restated later — ARCHITECTURE §locate).

An all-nodes-unreadable scan returns a null `matches_total` verdict, never an empty list
(the find_site rule).

## Re-verification against the principles (the checklist this shipped under)

| Principle | Verdict |
|---|---|
| Collapse rule ("same relation, different unknown → merge") | Followed: pattern→positions is `what`'s direction with a composite subject; lands in `locate`, no new tool. Argument-selects-direction preserved (exactly one of what/at/pattern). |
| Tool bill (static prefix 50–92%) | No new manifest entry. locate's description/schema grow ~180 words — the one real cost; accepted because the alternative (new tool) costs strictly more. No profile change: locate ships in all three. |
| One-definition rule | Block matching = `BlockTools.parseInput` (BlockInput, the `expect`/set_blocks matcher). Entity matching = `what`'s existing matcher. Palette strings stay `id[state]`, semantic (opaque-palette don't-build row untouched). |
| One routing level | Refinement is opt-in, never mandatory; a compound pattern is one call. Set chaining adds capability, not a required step. |
| Search is index lookup, not scanning | Superseded *knowingly* for this rung: the section palette IS an index (maybeHas prefilter), the scan is bounded+budgeted+priced (`ms`, extent), and the doctrine sentence in locate's description is reworded to say scanning happens only for `pattern`, bounded, and where. |
| Coverage contract / tri-state | Chunk-counted extent; reads page, never generate (shared ChunkLoader); null verdict over a fully-unreadable extent; partial → scoped claim. |
| Typed negatives | `negative_is_proof` computed from extent + caps + set provenance, composed recursively; cause always named. |
| Ledger don't-build clause (no world mirror) | Sets store handles-to-re-verify, not trusted state: block members re-tested on use, entity members re-resolved by UUID, bounded ring of 8, session/world lifetime. Caching block state or outliving the session = the rejected thing; probes assert the re-verify path. |
| No confidence scores | Staleness is counted (`stale_dropped`, `unverifiable`) and timestamped (`tick`), never scored. |
| Anti-speculative taxonomy | 5 relations, 3 node kinds, no DSL; the not-in-v1 list is explicit and each entry waits for a motivating task. |
| Act-verdict honesty (0.6.0) | Observe-only tool; the analog is the negative composition above. |
| Conformance ratchet | locate's spec entry unchanged in tier (spatial, noCoverage); pattern responses carry the envelope; new probe file asserts the search-block contract. |
| Mechanism taxonomy | `observe`, unchanged. |
| Freeze plan non-collision | Toolkit-side change + probes only; bench units for it are pre-freeze *direction* (never citation), added ratchet-green or run outside the results root (§Bench). tools_hash changes with the manifest — recorded per-run as always. |

## Bench (the shipping gate)

Hypothesis: on relational tasks, the pattern arm beats the model-side-join arm on accuracy
and/or tokens, and the tool actually gets called (the middle-rung failure mode is a tool nobody
calls — that is what falsifies this rung).

- Tasks (staged, deterministic truths): (1) find the marked pair — two gold blocks adjacent
  among decoy singles; (2) entity-on-block — which gold block has a mob standing on it (decoys:
  mobs beside, block without mob); (3) chained refinement — of all lamps in the area, which has
  no redstone wire adjacent (exercises set + negative composition).
- Arms: `with` (pattern available) vs `without` (pattern hidden — the model joins
  get_entities/locate-at/scan_box output itself). Few reps (2–3), small model, report accuracy,
  tokens, calls-made.
- Pre-freeze discipline: these runs are direction, never citation; result dirs either join the
  registry with proper accessors (ratchet-green) or live outside the ratchet's sweep root,
  clearly marked. Decision at build time with registry.mjs open.

## Probes (standing, `mcp-server/probes/pattern-search.test.mjs`)

1. Two adjacent golds found among decoy singles; bindings correct; matches_total exact.
2. Entity-above-block: finds the gold with the zombie on it, not the bare one, not the one
   with a zombie beside it.
3. Fully-loaded extent → `negative_is_proof: true` on a miss; `load:false` over absent chunks
   → false, cause named, scoped note.
4. `as:` stores the set; mining one member then reusing the set drops it (`stale_dropped: 1`),
   and the refined search does not match through the mined block.
5. Set provenance poisons the negative: a set created `truncated` (or with unverifiable
   members) → downstream `negative_is_proof: false` naming the set.
6. Disconnected pattern rejected; unknown node id in a relation rejected; wrong-dimension set
   rejected; exactly-one-of what/at/pattern enforced.
7. Ledger: sets listed in `anchors`, bounded ring evicts, `drop` removes.

---

# §Results — the consolidated overview (2026-07-25/26)

## What shipped, in order

| Version | Change |
|---|---|
| **0.18.0** | `locate` gains the `pattern` direction (this doc §Shape): declarative conjunctive patterns, palette-prefiltered scan, result sets re-verified on use, negative composition. Probes 8/8; locate 16 + conformance 40 green. Bench rungs t14–t16 + `xyz_oneof` scorer + registry units (ratchet-green). |
| **0.18.1** | Bench-observed miss #1 fixed: a block-id `what` errors WITH the pattern recipe (was: refused toward query_registry — cost one session 21 blind calls). |
| **0.19.0** | Principal's nod: bare block id in `what` **promotes** to a one-node pattern scan (`search.promoted` disclosed, stamped `pattern_scan`). The doctrine line "index lookup, never scanning" amended. |
| **0.20.0** | Principal-directed renames — names must state the question: `get_blocks`→**`get_surface`**, `scan_box`→**`describe_box`** (only these; the rest judged question-shaped, `locate` bench-proven). Cross-tool `detail` error hint. Bench: `no-locate` named arm; ladder-wide maxTurns 64 (A5 circuit breakers, after run 1 proved binding caps invert verdicts); staging collision fixes t10 slot 3→7, t12 slot 5→8. |

## The five runs (all haiku, staged truths, same-hash instances within comparisons)

| # | Run dir (testbench-results/) | Design | Headline |
|---|---|---|---|
| 1 | `2026-07-25T12-19-19` | t14–16, full/no-locate, **capped 12/16** | INVALID BY DESIGN — 10 cap trips censored accuracy AND tokens; verdict inverted vs run 2. The A5 lesson, live. |
| 2 | `2026-07-25T13-32-05` | same, uncapped (64) | Token verdict flips: no-locate 564k vs full 479k wc/correct. Pattern dark 1/12 — but that call was `what:"gold_block"`, the right instinct refused → drove 0.18.1/0.19.0. |
| 3 | `2026-07-25T16-52-11` | t14–16, with/no-locate/**swap**, renamed+promoted | **swap sweeps: 100%, 113k/correct, 1–3 calls.** All 12 swap sessions opened with the PROMOTED `what` — zero hand-written patterns. Discovery on free choice: 0/12→2/12. |
| 4 | — | (run 1 re-counted post-A5) | folded into the lesson; no separate dir |
| 5 | `2026-07-25T19-11-38` | **full ladder t1–t16**, with/swap, 128 sessions, 0 cap trips | **swap wins the whole ladder: 98% @ 119k vs with 95% @ 141k.** swap ≥ with on 15/16 rungs; five tools carried everything (locate 89, check_site 87, check_path, check_fit, get_region_summary). |

## Findings that outlive the runs

1. **Capability confirmed, discovery is the bottleneck.** Forced onto the surface, the pattern
   family is the best performance measured on this bench, whole-ladder. Left to free choice, a
   small model routes to familiar raw reads (0→2 of 12 sessions after promotion+renames).
   Freshest evidence for the R6 short-manifest/tool_help thread.
2. **The promotion IS the discovery bridge.** Models never wrote pattern syntax in any arm; they
   used `what:<block id>` — the universal instinct — which now lands on the scan. Explicit
   pattern syntax is the substrate (and the compound-relation reserve), not the front door.
3. **Few clean referents are model-safe; raw grids are not.** The single most reproduced defect:
   the SAME wrong cell from `describe_box detail:layers` character-arithmetic in three
   independent sessions across two runs. Confident-wrongs came from view extraction, never from
   handle reasoning.
4. **Binding turn caps are instrument poison** (run 1 vs 2: the cap amputated the join arm's
   heavy tail and inverted the token verdict). Caps are circuit breakers ≥4–10× median, trips
   reported as CENSORED — codified ladder-wide, aligned with FREEZE_PLAN A5.
5. **One capability gap in the swap surface: volume statistics** (t3 costs 2.3× via locate-at
   batches vs one describe_box call; accuracy held). Everything else the six raw reads answer
   was substituted at equal-or-better accuracy and cost. **CLOSED 2026-07-30 (toolkit 0.32.0):** the
   census became the *region arity* of `locate at` (`dx/dy/dz`, or `in:` a named region), delegating
   to describe_box's own implementation — so the capability moved into the front door rather than the
   profile moving back. The standing recommendation below is amended accordingly: `describe_box`
   itself no longer needs to ride `standard`. Note the t3/r11 pair is now the natural bench rung for
   the new arity — nothing has measured it yet.
6. **Error text is a routing surface.** Both shipped discovery fixes were error-remedy edits at
   the exact moment of need — cheaper and better-targeted than description growth (which the
   tool bill taxes every turn).

## Standing recommendation (decision: Matthijs, at the freeze/profile point)

Default-shipped surface → **locate (+pattern/promotion) + check_* predicates + survey rungs +
describe_box** (kept for volume stats until a counting rung prices its removal);
`get_blocks_at` / `get_surface` / `get_entities` / `raycast_fan` substituted on this evidence;
`raycast` retained for its line-of-sight-only role (profile caveat). Five runs back it.

## Still open

- Harder multi-chunk relational instances (kept out to preserve questions-hash lineage).
- Relation-vocabulary growth + entity sets: gated on motivating tasks, as designed.
- The t16 "answered an estimate as a count" honesty class; the layers-view extraction hazard
  (feeds the profile decision).
- Second-model coverage (all five runs are haiku).

Cross-references: TODO.md §Pattern search (status ledger), ARCHITECTURE.md §locate (doctrine),
memory `mcp-toolkit-threads` (session record), bench-no-turn-caps memory (A5 rule).
