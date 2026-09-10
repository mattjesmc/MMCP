# Bench discipline index — 55 units × 10 disciplines

## Taxonomy

| discipline | measures | canonical probe |
|---|---|---|
| **perceptual** (Perceptual / observational) | extracting facts from incomplete, noisy, occluded, or summarized observations | recognize a hostile from partial sight; read a fact out of a summarized envelope |
| **spatial** (Spatial) | position, direction, geometry, topology, distance, containment | compass bearings between landmarks; egocentric left/right; whether two spaces connect |
| **semantic** (Semantic) | entity identity, category, properties, purpose | blast furnace vs furnace; which block in a machine room is the container being fed |
| **relational** (Relational) | connections between entities | which input feeds the lamp; hopper feeds furnace which outputs into a chest |
| **quantitative** (Quantitative) | counts, measurements, ratios, thresholds, capacities | count intruding blocks; min/max surface height; is 23 iron enough |
| **temporal** (Temporal) | order, duration, periodicity, recency, state transitions | has the region changed since the last observation; complete objectives in order |
| **causal** (Causal) | mechanisms, dependencies, interventions | why doesn't the lamp light; would removing this torch break the circuit |
| **physical** (Physical / dynamical) | movement, collision, gravity, fluids, projectiles, redstone timing | is the jump reachable; wade the flooded span; survive the melee |
| **epistemic** (Epistemic) | knowledge, uncertainty, evidence, source reliability | don't report the mob you couldn't see; distinguish remembered from verified |
| **counterfactual** (Counterfactual) | reasoning about alternative worlds or actions | which of three sites needs least cut+fill; where does the marker land after rotation |

## Discipline × category (● load-bearing, ○ incidental)

| discipline | AB | T | C | P | E | Z | R | W |
|---|---|---|---|---|---|---|---|---|
| perceptual | ● | ● |  | ● | ○ | ○ |  | ● |
| spatial | ● | ● | ● |  | ● | ○ | ● | ● |
| semantic | ● | ● |  |  |  |  |  | ● |
| relational | ● | ● | ● |  |  | ● |  |  |
| quantitative | ● | ● | ● |  | ● |  |  | ○ |
| temporal |  |  | ● | ○ | ● |  |  |  |
| causal |  |  |  |  |  | ● |  |  |
| physical | ● | ● |  | ● | ● | ○ |  |  |
| epistemic |  |  | ● | ● | ○ |  |  |  |
| counterfactual |  | ● |  |  |  | ● | ○ |  |

## Units

| unit | cat | load-bearing | incidental | status | title |
|---|---|---|---|---|---|
| a1 | AB | perceptual+semantic | — | proven | anomaly block identity |
| a2 | AB | spatial | perceptual | proven | compass bearing tower→tower |
| a3 | AB | spatial | — | proven | nearest-corner landmark |
| a4 | AB | perceptual+semantic | — | proven | channel liquid identity |
| a5 | AB | quantitative+spatial | — | proven | straight-line distance estimate |
| a6 | AB | spatial | — | proven | eight-way bearing |
| a7 | AB | quantitative | spatial | proven | height comparison tower vs roof |
| a8 | AB | spatial | — | proven | closest tower to lava |
| a9 | AB | spatial+physical | — | proven | line-crossing water vs bridge |
| a10 | AB | physical+spatial | — | proven | pen reachability (open) |
| a11 | AB | physical+spatial | — | proven | sealed-box reachability |
| a12 | AB | spatial | — | proven | egocentric left/right transform |
| a13 | AB | spatial+relational | — | proven | which towers north of channel |
| a14 | AB | quantitative+perceptual | — | proven | tower count |
| b_formats | AB | perceptual | spatial+quantitative | proven | identical questions across json_coords / palette_rows / ascii_grid |
| t1_point | T | perceptual | semantic | proven | point block-id query |
| t2_clear | T | perceptual+spatial | — | proven | box-clear check with decoy |
| t3_conflicts | T | quantitative | spatial | proven | count intruding blocks |
| t4_reach | T | physical+spatial | — | proven | pen reachability predicate |
| t5_heights | T | quantitative | perceptual | proven | wild min/max surface height |
| t6_cutfill | T | quantitative+counterfactual | — | proven | 3-site cut/fill comparison |
| t7_watertiles | T | quantitative | perceptual | proven | 9-tile water survey |
| t8_sitesearch | T | counterfactual+quantitative | spatial | proven | flattest-tile argmin |
| t9_findsite | T | spatial+quantitative | — | proven | find_site placement search |
| t10_multipoint | T | quantitative | perceptual | proven | 5-point multi-referent read |
| t11_multibox | T | quantitative+spatial | — | proven | 4-box multi-referent survey |
| t12_machineroom | T | semantic | perceptual | proven | purpose→machine identification |
| t13_hopperchain | T | relational | semantic+spatial | proven | follow the hopper line to its chest |
| anchor | C | epistemic+temporal | — | proven | anchor fact recall |
| where | C | spatial+temporal | — | proven | where-was-it recall |
| count | C | quantitative+temporal | — | proven | count recall |
| region | C | relational+epistemic | — | proven | cross-region attribution |
| breadth | C | epistemic+quantitative | — | proven | corpus breadth recall |
| stale | C | temporal+epistemic | — | proven | post-mutation staleness |
| p_perceive | P | perceptual+epistemic | — | proven | perception honesty: report only what FOV allows |
| p_survive | P | physical | temporal+perceptual | proven | single-round survival, legal vs xray |
| e_combat | E | physical+temporal | quantitative+perceptual | proven | combat wave ladder r1–r4 (skill×cost curve) |
| e_traverse_t1 | E | spatial+physical | epistemic | proven | traverse tier 1: flat straight |
| e_traverse_t2 | E | spatial+physical | epistemic | proven | traverse tier 2: 1-wide gap |
| e_traverse_t3 | E | spatial+physical | epistemic | proven | traverse tier 3: wall + doorway |
| e_traverse_t4 | E | spatial+physical | epistemic | proven | traverse tier 4: water crossing |
| e_traverse_t5 | E | spatial+physical | epistemic | proven | traverse tier 5: S-maze |
| e_survive_build | E | physical+quantitative | spatial | proven | gather from quarry, bridge the gap |
| e_milestone | E | temporal+quantitative | physical | proven | gather → build → fight, in order |
| e_dungeon | E | spatial+temporal+physical | quantitative | proven | vault → treasure → guard → exit capstone |
| z_gate_not | Z | causal+relational | physical+spatial | proven | build a NOT circuit to a driven truth table |
| z_gate_or | Z | causal+relational | physical+spatial | proven | build a OR circuit to a driven truth table |
| z_gate_and | Z | causal+relational | physical+spatial | proven | build a AND circuit to a driven truth table |
| z_gate_xor | Z | causal+relational | physical+spatial | proven | build a XOR circuit to a driven truth table |
| z_diag_wiring | Z | relational | causal+spatial | proven | which input controls the lamp (dead-end decoy) |
| z_diag_fault | Z | causal | relational+perceptual | proven | locate the one break in the line (repair-verified) |
| z_diag_whatif | Z | counterfactual+causal | relational | proven | would the lamp survive removing this wire (intervention-verified) |
| r_rotate | R | spatial | counterfactual | proven | grid transform prediction (rotate/mirror/compose) |
| w_schematic | W | spatial+semantic | quantitative | proven | build from glyph-slice spec |
| w_repair | W | perceptual+spatial | semantic+quantitative | proven | find and fix injected deviations |

## Gaps

- (every discipline has at least one load-bearing unit; see live-pending notes above)
