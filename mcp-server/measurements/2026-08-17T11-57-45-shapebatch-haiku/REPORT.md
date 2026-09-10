# place_shapes — the measurement §4 owed

2026-08-17T11:57:45.621Z, model haiku (claude-haiku-4-5-20251001), git da4d6b4

Room: 537 target cells, minimum **8 shapes**. 3 seeds × arms [single, batch], questions 4c5a7057c81a.
The two arms differ by **exactly one tool**; prompts are byte-identical and the turn cap (60) is the same in both, because an arm-dependent cap would BE the measurement. `set_blocks` is in NEITHER arm — it has always taken an array, so leaving it in would let both arms route around the tool under test and answer a question about tool CHOICE instead.

## Per run

| seed | arm | turns | fidelity | exact | place_shape calls | place_shapes calls | ops/call | turn-1 input | Σ cache_read |
|---|---|---|---|---|---|---|---|---|---|
| 1 | single | 11 | 1 | yes | 9 | 0 | — | 7990 | 109k |
| 1 | batch | 4 | 1 | yes | 0 | 1 | 12 | 8944 | 52k |
| 2 | single | 14 | 1 | yes | 12 | 0 | — | 7984 | 22k |
| 2 | batch | 2 | 1 | yes | 0 | 1 | 11 | 8938 | 9k |
| 3 | single | 10 | 0.696 | **no** | 8 | 0 | — | 7983 | 26k |
| 3 | batch | 3 | 1 | yes | 0 | 1 | 11 | 8937 | 26k |

## Paired, per seed — the comparison that survives a small n

| seed | turns single→batch | Δturns | cache_read single→batch | Δ% | fidelity single→batch |
|---|---|---|---|---|---|
| 1 | 11 → 4 | −7 | 109k → 52k | 51.9% | 1 → 1 |
| 2 | 14 → 2 | −12 | 22k → 9k | 60.2% | 1 → 1 |
| 3 | 10 → 3 | −7 | 26k → 26k | 0.4% | 0.696 → 1 |

## Per arm

| arm | runs | turns mean/median | fidelity | exact | cache_read mean/median | turn-1 input | out tok |
|---|---|---|---|---|---|---|---|
| single | 3 | 11.67 / 11 | 0.9 | 2/3 | 52k / 26k | 7986 | 11k |
| batch | 3 | 3 / 3 | 1 | 3/3 | 29k / 26k | 8940 | 10k |

## The ledger

**Turns — the prediction, confirmed, and it is the robust half.** 11.67 → 3 mean (3.89× fewer), and it held on **every seed** (11→4, 14→2, 10→3). Nothing in this run is ambiguous about the turn count.

**The model planned ahead — decisively.** Every batch run emitted its whole structure in ONE `place_shapes` call: 12, 11, 11 ops (the minimum is 8; it split the walls per-layer rather than using `mode:walls`). §4's alternative hypothesis — "if the win is not in turn count, the model was not planning ahead" — is refuted for this model: it did not need coaxing, and it never once fell back to one-shape-per-call.

**Cost token bill, less than the turn count suggests.** cache_read 52k → 29k mean (−44.6%), but the median is 26k → 26k and the paired per-seed reductions are **51.9%, 60.2%, 0.4%** — one seed saved nothing at all. Turns fell 3.89× and the bill fell ~44.6%: **the batch trades many thin turns for few fat ones**, so context-per-turn rises as turn count falls and the two partly cancel. The doc predicted the win would be "nearly all in turn count"; it is, but that is also the reason the token saving is much smaller than the turn saving. With n=3 the turn claim is solid and the token claim is directional only.

**Fidelity went UP, which was not predicted.** 0.9 → 1 (exact 2/3 → 3/3). The one single-arm failure built the room correctly and then added **234 extra blocks** — it filled two wall layers SOLID instead of perimeter-only (121 interior cells × 2 layers, less the 8 pillar cells that were target anyway = 234 exactly). Eight independent calls are eight independent chances to get one wrong; the batch states the same intent once, and got it right 3/3. Suggestive, not established, at this n — but it points the opposite way from the usual "batching is riskier".

**THE COST SIDE, which §4 never costed.** Carrying `place_shapes` raised turn-1 input by **954 tokens** — its own schema, re-read on **every turn of every session**, including every session that never builds anything (finding 1). So:

- A session that builds one room and runs **longer than ≈24.47 turns** has paid more in schema tax than that room's batching saved (on the MEAN saving, which one seed carries).
- On the **median** seed the saving is only 111 tokens — **less than the tax costs in a single turn**, so on a typical seed the tool does not pay for itself at all beyond the build turns it removes.
- A session that builds **nothing** pays the tax and collects none of it.

That makes the actionable lever **the description, not the engine**: 954 tokens is ~11.9% of the whole 8k prefix for one tool, and it is verbose by choice (it spells out order, the budget, per-op results and the dry-run contract). Halving it roughly doubles the break-even ceiling. That is the next measurement, and it needs no model spend to predict.
