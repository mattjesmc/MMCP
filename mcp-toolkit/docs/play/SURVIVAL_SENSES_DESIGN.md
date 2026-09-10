# Survival senses — locate description diet, entity memory, memory-pattern

Status: **P1 + P2 BUILT 2026-08-03** (same day as the design). P1 offline-green (profiles suite
holds the diet). P2 compiles clean (toolkit 0.47.0), **live probes written and NOT run** — the
changes are structural, the dev server was up with four active adopted sessions (incl. w1-85918)
at build time, and cycling it over live work was not worth a probe run; the next
`tools/rebuild.ps1` covers it (`probes/perception.test.mjs`, 4 new tests). §2.4 was found ALREADY
BUILT in the shim. **P3 BUILT later the same day** (mcp-server 0.20.0) after Matthijs retired the
demand gate — see §3.1 for why the gate was measuring its own hiding. Offline batteries after all
three: memory 160/160 (incl. legal-pattern 6/6), ablation 24/24, profiles 11/11.
Provenance: Matthijs's review of the survival `locate`
override (this doc's §1 quote) plus two proposals (pattern-over-memory, ambient entity memory),
worked into the existing architecture in conversation. Authority relationships: §1 amends
`mcp-server/memory/survival-overrides.mjs`; §2 amends `Perception.java` / `DroneObserver.java` and
the survival shim; §3 extends `mcp-server/memory/legal-locate.mjs`. Nothing here touches the bench,
but §1 and §2 both move the manifest, so `tools_hash` moves — bench rows from before and after must
not be pooled (`testbench/resume.mjs` treats that as fatal, by design).

Build order: **P1 → P2 → P3**, with P3 gated on measured demand (§3.1).

---

## §1 (P1) The locate description diet

**The finding.** The survival `locate` override description is ~1000 chars, and roughly a third of
it coaches frontier-following ("On a miss, go look where it points — bot_scan that direction or
travel there — then ask again"). But `frontierLines` (`legal-locate.mjs`) already delivers that
lesson **in the miss payload, verbatim and better** — down to the copy-pasteable calls
(`bot_scan direction:"SW"`, `bot_target action:"vantage"`, "then re-ask"). So the description
paragraph is paid on every turn (TOOL_BILL_PLAN: static prefix = 50–92% of the bill) to pre-teach
guidance the response hands over at exactly the moment it applies. That is the same argument
`LocateTools.rejectUnknownArgs` makes for refusals — a correction at the moment of the mistake
beats description growth — applied to the success path. Meanwhile `near`, `radius`, `limit` and
`dimension` never appeared in the description prose at all (only in schema property text, which
small models demonstrably skim).

**The rule this extracts** (reusable for every override): the description carries the **contract**
— whatever changes how a model must *interpret an answer*, which no error or payload can teach
after the fact. The response carries the **coaching** — what to do next, delivered when it's next.
Contract lines for this tool: memory-not-live; `observed:false` = unknown-not-air; a miss is never
proof. Everything else is coaching and lives in the render, where it already is.

**The new description** (~460 chars, every argument present with an example):

> Your MEMORY of blocks your body has seen — not a live read, and a miss is never proof of absence
> (the reply maps how much you've seen and where to look next). Give ONE of: `what:"iron_ore"` |
> `what:"#minecraft:logs"` | `what:"stone"` → nearest remembered sightings with bearings;
> `at:[{x,y,z},…]` → what you saw at those positions (`observed:false` = never seen — unknown, NOT
> air). Options: `near:{x,z}` recenter (default: your body), `radius` ≤128, `limit` ≤8,
> `dimension`. Entities are never in block memory — use `sense_entities`.

Schema: unchanged (it is already minimal and honest). Note for the record: `from` is not a locate
argument (it belongs to `anchors` paging) — the review's instinct that it was missing is really the
centering-vocabulary gap, which is §2's business (entity/anchor-relative `near` needs the entity
memory to exist first, and is NOT in scope here).

**Probe.** A static assertion in `mcp-server/probes/profiles.test.mjs` (beside the existing
override checks): the survival locate description names every property in its own inputSchema, and
stays under a length budget (600 chars) so the diet can't silently regrow.

**Cost/risk.** One string in one file; mcp-server version bump (manifest change).

---

## §2 (P2) Entity memory — extend what Perception.java already is

**What exists** (found while designing — the proposal is ~70% built). `Perception.java` is already
a per-body entity belief store: per-tick once armed, vision = 120° FOV cone + a real occlusion
raycast at 32 blocks (live pos + velocity), hearing = 16 blocks quantized to a 2-block grid (coarse
pos, no velocity), unperceived beliefs freeze at last-known with growing `age_ticks`, decay at 200
ticks. `bot_profile {perception:"perceived"}` points the reflex triggers at it instead of ground
truth. `sense_entities` renders it with server-computed distance/bearing and a nearest-threat
summary. What follows are the four deltas that turn it into the proposal.

### §2.1 Two-tier retention (the "recent nearby entities" half)

10 seconds is a working-memory horizon, not memory: a player still knows about the creeper around
the corner two minutes later. But naively lengthening `DECAY_TICKS` would feed five-minute-old
ghosts to the reflex layer and the threat summary. So: two tiers.

- **Percept tier** — exactly today's store, decay 200 ticks, untouched. It alone feeds
  `perceivedThreatsWithin` / `perceivedThreatCentroid` (reflexes), `summary.hostiles` and
  `nearest_threat`. Reflexes must never fire on a memory.
- **Remembered tier** — a belief aging out of the percept tier moves here instead of vanishing:
  type, hostile, last-known pos, last tick, channel it was last perceived by, and `fate` (§2.2).
  Cap 32 per session (LRU), TTL 6000 ticks (5 min), cleared by the existing `reset()` (a new body
  has no memory of the old one's percepts — unchanged) and on dimension change. Rendered by
  `sense_entities` as a separate `remembered` array — never `fresh`, never velocity, always an age
  ("zombie, hostile, last seen 2m ago at …"). Never feeds reflexes or the summary.

Uncertainty stays carried by age + tier label, never a confidence number — the toolkit's
no-detection-noise doctrine.

### §2.2 Refutation by observation (the alive tracker, generalized)

Today a watched kill just freezes the belief: `isAlive()` filters the corpse out of both passes, so
the store reports a stale hostile at that spot for 10 more seconds — a small lie about the one
event the body actually witnessed. The general rule, and it is exactly the **implied-air VANISH
rule from `observations.mjs` applied to entities**: *looking at where a belief lives and not
perceiving the entity is itself an observation.*

- In the vision pass, after the perceive loops: for each belief whose last-known position is inside
  the FOV cone with line of sight this tick and whose entity was not perceived this tick — the
  belief is **refuted**. If the entity is dead/removed and was in sight when it happened, it moves
  to the remembered tier with `fate:"died"` (witnessed); otherwise `fate:"gone"` (you looked, it
  wasn't there — moved while you weren't watching, or despawned).
- A refuted percept never lingers as `stale`; `stale` now means precisely "last-known, NOT since
  checked", which is what it always claimed to mean.

### §2.3 Close the event door's X-ray leak (a real bug, found by this design)

`DroneObserver` — the source of `entity_entered_radius` / `entity_left_radius` /
`nearest_threat_changed` — diffs a **raw 24/26-block radius scan** with no FOV and no line of
sight. Under the survival profile that means the event stream announces entities *behind walls*:
the reflex door was made perception-legal (`bot_profile perceived`) but the event door never was,
and events are served straight into the survival session's context. That contradicts the profile's
foundational rule (perceivable-then-delivered) and is precisely the confabulation feed the
[agents-confabulate-without-senses] incident warns about — the session gets told about mobs its
body could not know exist.

Fix, one-definition style: in perceived mode the observer **consumes the belief store instead of
running its own scan** — "entered" = a belief newly exists (first perceived), "left" = a belief
decayed out of the percept tier or was refuted (§2.2, carrying `fate`), `nearest_threat_changed`
diffs the *believed* nearest threat. Authoritative mode keeps today's radius diff untouched (the
copilot's sensor is supposed to be X-ray). Hysteresis is no longer needed in perceived mode — the
decay window already debounces.

### §2.4 Auto-arm under survival — FOUND ALREADY BUILT (build discovery, 2026-08-03)

Designed as: the shim arms `bot_profile {perception:"perceived"}` after a survival spawn. Found at
build time to already exist in `index.mjs` (~L478), and better than designed: it covers `possess`
as well as `spawn`, AWAITS the arm so no tool call can slip between spawn and the lock, and is loud
on stderr when refused. Nothing to build; §2.3 makes this pre-existing arm also govern the event
door, which is what gives it teeth.

### Deliberate non-goals

- **No persistence to `observations.jsonl`.** Entities move; a cross-session entity memory is
  stale by construction, and rendering it would put exact-sounding positions on day-old mobs. The
  remembered tier is session-scoped, in-mod, bounded. (Blocks persist because blocks stay put.)
- **`reset()` semantics unchanged** — body replacement clears both tiers. The *model's* memory of
  what it saw is its context/notes; this store is the body's.
- **No entity-centering `near` yet** (§1's `from` instinct). It becomes designable once the
  remembered tier exists; it is not part of this build.

**Probes.** Extend `probes/perception.test.mjs`: (a) a decayed percept reappears in `remembered`
with an age, and never in `summary`; (b) kill a watched zombie → no stale hostile, remembered
`fate:"died"`; (c) look back at a vacated last-known cell → refutation, `fate:"gone"`; (d) the
observer gate: zombie summoned behind a staged wall emits **no** `entity_entered_radius` in
perceived mode and does in authoritative — the §2.3 leak, probed from both sides. All stageable
headless.

**Cost/risk.** Toolkit version bump (0.47.0-shaped); structural Java changes, so no hotswap — full
rebuild via `tools/rebuild.ps1`, never while the dev game runs (jar-lock rule). §2.3 changes what
events survival sessions receive; the event-stream battery must re-run.

---

## §3 (P3) Memory-pattern — pattern search over the block belief store

The survival refusal says "`pattern` is an X-ray world scan", which is true of the *bridge's*
pattern. A pattern evaluated **over the observation store** is not X-ray at all — it is "I have
seen half of this shape; the rest is worth digging out", which is exactly what a player does. The
proposal is honest by the same rule as everything else in the legal profile, with the scoring
Matthijs specified: unknown cells are wildcards *reported as unknowns*, never as matches.

### §3.1 The demand gate — RETIRED (Matthijs, 2026-08-03), and why

The gate said "build when the ledger shows refused survival `pattern` calls." Matthijs's challenge
("if it answers from memory only, it's not exactly illegal, is it?") exposed the flaw: the survival
schema deliberately hides `pattern`, and an agent only knows a tool through its description — **a
door nobody can see is a door nobody knocks on**, so the ledger's zero partly measured the hiding,
not the wanting. The ledger gate is sound for mis-aimed *vocabulary* (words models type from their
own priors: `center`, "chest") and unsound for *capabilities the surface conceals* — worth keeping
as a general lesson about when demand-gating works. With legality conceded and the measurement
biased, the only cost left was maintenance surface, and the capability matches how the profile
already thinks. **Built same day** (mcp-server 0.20.0, `memory/legal-pattern.mjs`, offline 6/6).

### §3.2 Semantics

- **Candidates are seeded only from observed cells.** Pick the pattern's rarest-in-store node,
  enumerate the store's observed matches for it, and try to place the pattern around each. A
  placement supported by zero observations never enumerates — this is the explosion guard that
  makes unknown-as-wildcard tractable (otherwise every unseen region "matches" everything at 50%).
  The search space is the store, not the world, so it is bounded by what has been seen.
- **Per-cell tri-state.** Observed-and-matches → match. Observed-and-differs → **mismatch, kills
  the candidate** (an observed contradiction is disqualifying — that is what makes the score
  honest). Never-observed → **unknown, dilutes the score**, never kills.
- **Scoring and order.** Each surviving candidate reports the pair — `matched: 6/9, unknown: 3/9`
  — never a collapsed single number. Rank by matched-fraction descending (most-confirmed first —
  "sort like a player would"), ties by distance. Require ≥2 observed node matches (≥1 for 2-node
  patterns) for a candidate to exist at all.
- **The unknowns are the verification plan.** Each result lists its unknown cells' positions —
  "dig/look here to confirm" — the frontier idea at pattern scale. `negative_is_proof: false`
  always, structurally, same as every legal answer.
- **No tag resolution** (no registry here): node matchers get the same needle treatment as `what`,
  routed through the shared route table first, with the interpretation disclosed in the reply
  exactly as `legalLocate` discloses routes.
- **Vocabulary subset, refused loudly:** block nodes + the bridge's five relations
  (adjacent|above|below|offset|within, same cell arithmetic as `LocateTools.PRel`). Cell properties
  (light/spawnable) and entity/set nodes are not in the store and are refused by name, not silently
  narrowed. Multi-node patterns must be relation-connected — a floating node has no place in memory
  to be looked for. As built: two nodes never share a cell, and a loose `within` whose implied set
  exceeds 512 cells stops hypothesizing blindly and considers only that node's SEEN matches
  (`wildcards_limited`, stated in the render).

### §3.3 Home and probes

`mcp-server/memory/legal-pattern.mjs`, called from `legalLocate` where the refusal sits today (the
refusal remains for malformed/unsupported patterns). Pure JS over `store.legalCells` — the whole
thing probes **offline** with store fixtures (`memory/probes/` style): a half-seen 3×3 shape ranks
above a third-seen one; one observed mismatch kills; unknown cells listed; a later observation
flips unknown→mismatch and the candidate dies; needle/route disclosure present.

---

## §4 Execution ledger

| step | touches | version | verify |
|---|---|---|---|
| P1 description diet — **BUILT, offline-green** | `survival-overrides.mjs`, probe in `profiles.test.mjs` | mcp-server 0.19.0 | offline probe green 2026-08-03 |
| P2 entity memory §2.1–2.3 — **BUILT, compile-clean, LIVE-UNRUN** (§2.4 pre-existed) | `Perception.java`, `DroneObserver.java`, `DroneTools.java` (tick order: perception BEFORE observer), `EventTypes.java` (NEAR text), `perception.test.mjs` (+4 tests) | toolkit 0.47.0 | pending next `tools/rebuild.ps1`: perception battery incl. the §2.3 wall probe, then event-stream suite |
| P3 memory-pattern — **BUILT, offline-green 6/6** (gate retired, §3.1) | `memory/legal-pattern.mjs` (new), `legal-locate.mjs` (helpers exported, pattern delegates), `survival-overrides.mjs` (schema + a sentence), probes: `memory/probes/legal-pattern.test.mjs` + updated `legal-locate.test.mjs` / `profiles.test.mjs` | mcp-server 0.20.0 | offline fixtures green 2026-08-03; the diet probe caught its own regrowth (612>600) during the build |

Standing caveats: the working tree already carries uncommitted 0.46.0/0.18.0 work — P1/P2 land on
top of it and ride the same eventual commit train, or after it, Matthijs's call. Every step that
changes the manifest moves `tools_hash`; do not pool bench rows across it.
