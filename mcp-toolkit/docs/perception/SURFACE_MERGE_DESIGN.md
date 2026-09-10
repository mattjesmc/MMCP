# Surface merge — one question, one door (0.22.0)

Status: BUILT 2026-07-26, from the post-full-ladder merge discussion (Matthijs). The consolidated
pattern-search arc that led here: PATTERN_SEARCH_DESIGN.md §Results. Bench verdict for THIS
change: appended below when the run lands.

## What merged, and the test each merge passed

The collapse rule (ARCHITECTURE §locate): merge tools that compute the same relation with a
different unknown; never tools that answer different questions.

1. **check_fit → locate `at` + `clear:true`** (Matthijs's finding). locate's `at`+`expect` was
   already the batch-verification direction; fit only lacked the clear-class predicate. `clear`
   is a SEPARATE named per-entry predicate (air or replaceable growth — the shared SiteCheck
   class), deliberately not a pseudo block matcher, so `expect` stays exactly vanilla BlockInput
   (one-definition rule). check.all_matched IS the fits verdict; mismatches are the conflicts.
   Regression accepted knowingly: >64-cell fits need split calls or describe_box (was 64³).
2. **find_site → check_site `near` door.** Identical cost function (t9's truth code proves it) —
   same relation, opposite unknown (verify an anchor vs search for one). Evidence: find_site got
   ZERO calls in 128 sessions including its home rung t9, which both arms answered by hand-looping
   check_site. The locate what/at lesson applied: models find the door they already know.
3. **check_clearance → check_site `from`+`to` door.** Obstruction count is cut-only work — the
   same work-over-an-extent relation with corridor geometry. clear ⇔ work == 0.
4. **NOT merged, and why**: check_path (different question — existential over routes, real
   pathfinder, vs clearance's universal over one stated corridor); describe_box (contents ≠
   cost; a lens argument would be a mode flag); scene_summary (situation ≠ survey; slimming
   deferred to a P-bench trial); resolve_anchor (placement arithmetic, unexercised by the
   read-only ladder — verdict needs a W arm).

## Mechanics

check_site = ONE relation (modification work over an extent), three doors selected by argument —
`at` (footprint verdict) | `near` (site search) | `from`+`to` (corridor) — exactly-one enforced,
no mode flag, per-door response shapes unchanged (candidates/fits/clear keep their names so
nothing downstream re-learns). checkFit/fitScan survive as plumbing (find_site verification,
resolve_anchor check). Registrations removed: check_fit, check_clearance, find_site → manifest
28 → 25 observe tools. Conformance specs updated; predicates/spatial-inversion probes repointed;
REPRESENTATION_TOOLS shrunk. resolve_anchor description no longer names a removed tool.

## Bench plan

Full ladder t1–t16 × with/swap × 2 seeds × 2 reps on the merged manifest vs the pre-merge
baseline `2026-07-25T19-11-38`. Merging mostly-dark tools predicts a token drop (three fewer
static-prefix entries); the open question is accuracy — does the search door get found on t9,
does anything regress on the doors' home rungs.

## Bench verdict (run `2026-07-26T06-14-26` vs pre-merge `2026-07-25T19-11-38`, appended 2026-07-26)

**Accuracy: preserved.** swap 97% (62/64) vs 98% pre-merge; with 94% vs 95% — ±1 session per
arm, different instances missed, statistically flat. The swap surface keeps its structural win
(97% @ 140k/correct vs with 94% @ 166k). Zero cap trips.

**Efficiency: the prediction was half right.** The manifest saving is real but SMALL — visible
only on minimal sessions (rung-1 floor: with 85k→84k, swap 77k→75k wc/session). It is swamped
by two counterweights: (a) the fit fold-in trades one compact check_fit call for 48-cell
`locate at` enumerations — request+response payload, paid per fit question (swap t2 126→147k,
t11 87→122k, t3 200→219k); (b) shared day-to-day behavioral drift (+15% both arms, both
directions of the merge — not attributable to the surface). Net: manifest bill (every session)
traded for payload bill (fit sessions only) — a wash on this ladder; wins only if fit
questions are rare, which they are in production traces.

**Doors: the discovery lesson repeats exactly.** The `clear` flag was adopted spontaneously
(15 calls, first run, zero instruction — correct every time); the SEARCH door went dark on its
home rung exactly as find_site did before it (t9 swap sessions hand-looped 15–18 at-door calls
to 100% accuracy at 2× the pre-merge token cost). Doors inherit the discovery problem of the
tools they replace; a fold-in without a promotion-equivalent moves the question but not the
routing. Open: what the search door's "promotion" is (the at-door has no natural refusal
moment to carry a remedy).

**Misc:** t3's swap miss (4 vs 6) confirms the volume-stats gap can cost accuracy, not just
tokens, when the model sweeps instead of using describe_box's question. The t14 layers slip
did NOT recur this run (3 of 5 runs total). t5.s2's twin identical wrongs were boundary
overreach onto neighboring shore (truth re-verified live: 62/62, stable) — model-side, both
arms, same slip.

**Standing:** the merge holds — 25 tools, accuracy intact, question-ownership cleaner — but it
argues for itself on surface hygiene, not on measured token savings. The recommendation to
ship swap-as-default is unchanged by this run (swap still wins both axes vs with).

## Failure-mode taxonomy (2026-07-26, from all wrongs + turn/token outliers of both ladder runs)

Every wrong and every >2.5×-cell-median outlier across `2026-07-25T19-11-38` and
`2026-07-26T06-14-26`, traced to mechanism. Five modes; M1 is the dominant cluster and was
invisible in score tables.

**M1 — Extent mis-specification** (the question's extent doesn't reach the tool intact):
- (a) *centre-vs-min-corner confusion*: t5.s2's twin identical wrongs — BOTH arms passed the
  square's CENTRE to check_site's min-corner `at`, reading 7 blocks of shore (live re-check:
  truth stable, 62/62). Root: convention split across tools — get_surface `origin` is a centre
  with `grid` half-width; check_site `at` is a min corner. Models blur them.
- (b) *tool cannot express the extent*: t9's declared domain is a RECTANGLE; the search door
  only takes near+radius, overshoots the floating pad onto wild ground and returns honest
  work-0 candidates OUTSIDE the domain (live-replicated: cand y=63 work 0). The one session
  that DISCOVERED the search door got domain-mismatched answers, rightly ignored them, then
  trusted its own wrong hand-math. Not tool distrust — extent-expression failure upstream.
- (c) *incomplete enumeration*: t3 swap swept only part of the box (undercount 4 vs 6);
  t7 concluded "3 tiles never generated" from misread partial windows.

**M2 — Estimate-as-answer** (honesty): t16 swap "assuming similar distribution → 3"; t3 "may
have missed"; t9 rep2 overriding data. Every M2 case sits DOWNSTREAM of an M1/M4 failure —
the guess fills the hole the extent failure left. Closing M1 shrinks M2's habitat.

**M3 — Raw-view extraction arithmetic**: t14 layers char-slip (3 of 5 runs, same wrong cell);
t9 with-arm windowed-argmin = 6 (3 sessions, 2 runs); t16 with-arm sweep miscount. The known
class; the swap-surface argument.

**M4 — Grind loops** (cost, not accuracy): at-door hand-loops on t9 (15–33 calls); with-arm
gba-sweeps after a failed first view (t14/t15 anomalies, up to 1.02M wc); run-2's 134-turn
no-locate session. Routing, not capability.

**M5 — Argument-convention detours**: get_surface `origin` REQUIRES y (irrelevant for a
heightmap read) → two errors → the model switched to check_site → landed in M1a: the t5 wrong
is a two-mode chain (M5 → M1a). Search door's size needs `h` (error message recovered it).

## Strategy (ranked, all principle-compatible; each closes a named mode)

1. **Search door `bounds` {min_x,min_z,max_x,max_z}** beside near+radius — makes rectangle
   domains expressible (M1b; t9's real question). One optional arg.
2. **check_site verdict door echoes its box** (`region` {min,max}) — a shifted read becomes
   visible to the model that made it (M1a self-check). Response field, no manifest cost.
3. **get_surface `origin.y` optional** — a heightmap read needs no y (kills the M5 detour that
   caused t5's chain).
4. **"min corner (NOT the centre)"** stated on every min-corner argument (M1a); the
   centre-vs-corner convention split named where it exists.
5. **describe_box layers: coordinate rulers** (axis labels on the ASCII grid) — attacks M3's
   reproducible char-counting slip.
6. **At-door response breadcrumb** ("ranking anchors automatically: give `near`+`size` — or
   `bounds` for an exact area") — the promotion-equivalent for the search door, placed where
   hand-loopers actually are (M4); useful only after (1) exists.

M2 gets no direct fix (model-class honesty) but shrinks with M1/M4. Verification: focused
rungs (t5/t9/t3/t14) before any full ladder.

## Fix verdict (focused run `2026-07-26T08-32-41`, t3/t5/t9/t14 × with/swap × 2×2, toolkit 0.23.0)

**31/32 — the best score these four rungs have ever produced** (pre-merge 30/32, post-merge
27/32), and every cell a fix targeted went to 100%:

- **t5 (M5→M1a chain): 8/8** (was 6/8). The optional-y fix was exercised TEN times
  (get_surface origin without y, zero errors) — the detour that caused the chain is gone at
  the source.
- **t9 (M1b + M3): 8/8** (post-merge: 6/8 with with-arm at 50%). The with-arm's reproducible
  wrong-6 arithmetic did not recur (mean 1.5 calls, 115k vs 236k). And one swap session used
  the **`bounds` door: 1 call, 5 turns — the fastest correct t9 session ever recorded**,
  exactly the one-shot the domain-constrained search was built for. (The other three swap
  sessions still hand-looped the at-door: 14–42 calls; the breadcrumb's near/bounds hint was
  followed once of four opportunities — door discovery improves by increments, as with the
  promotion.)
- **t14 (M3): 8/8** including the thrice-reproduced layers-slip instance; the rulered layers
  view was called once and read correctly.
- **t3: 7/8** — the one remaining wrong is the KNOWN unfixed gap (volume-stats counting via
  enumeration, off-by-one 13 vs 14; describe_box's question, absent from the swap surface by
  design). Nothing shipped today targeted it.

Costs equal-or-down on three of four rungs (t9 with 236k→115k the standout; t14 up on grind
variance). Modes M1a/M1b/M3/M5 have no surviving failing cell; M2 (estimate-as-answer) had no
occurrence this run — consistent with its habitat shrinking when extent failures close; M4
persists as cost-not-accuracy (at-door loops) with its remedy (bounds + breadcrumb) now
adopted 1/4 on first exposure.

## The BOX door (0.25.0) + the tripwire + a parked gate

t3's off-by-one closed on its own terms: `box` {min,max} is check_site's fourth door — cut-only
work over an explicit volume (`obstruction_count`, conflicts named, clear ⇔ zero), the corridor
predicate with the fourth extent geometry. One call replaces the 4-batch enumeration whose
model-side summing produced the off-by-one. Partial reads return a null count with
`obstruction_count_lower_bound`, never an exact-looking number.

**TRIPWIRE (now load-bearing):** the box door sits on the COST side of the contents-vs-cost
boundary that keeps describe_box a separate question. If a material-histogram/palette door is
ever proposed on check_site, that is "what is in it" — describe_box's question — and the tool
becomes the mode-flag junk drawer the collapse rule forbids. Work doors count and locate
conflicts; they never describe.

**PARKED (anti-speculative rule, checked 2026-07-26):** pattern-direction `bounds` — no task
fails for want of a rectangular pattern extent; "extent consistency" is symmetry-driven
reasoning, exactly what the rule stops. Gate: the first pattern task whose stated extent is a
rectangle the radius cannot express.

## Box-door verdict (run `2026-07-26T10-14-23`, t3 × with/swap × 2×2)

**8/8 — the t3 gap is closed.** swap 100% (was 75% in both prior runs). Door discovery: **2 of 4
swap sessions found the box door on first exposure** — the best first-run door adoption measured
(promotion 2/12 free-choice, search door 1/4, box door 2/4) — and both one-shot the task at
4t/1c/77-78k, at parity with (slightly cheaper than) the with-arm's describe_box (85k). The two
sessions that still enumerated via locate got it right anyway (the off-by-one did not recur) at
2-3× the cost. With this, the swap surface has NO known accuracy gap on the 16-rung ladder, and
every rung has a one-call answer-shaped path.
