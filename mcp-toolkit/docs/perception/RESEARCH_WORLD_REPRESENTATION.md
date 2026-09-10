# World-Representation Research — SOTA survey vs. the mcp-toolkit stack

Date: 2026-07-22. Two deep-research rounds + a targeted verification pass, judged against
ARCHITECTURE.md, not in the abstract.

- **Round one** (this file, top): symbolic world representation — 5 angles, 23 sources, 114 claims
  extracted, top 25 panel-verified (3-vote adversarial, 2/3 refutes kill): 21 confirmed, 4 refuted.
- **Round two** (§Round two below): the client/visual channel — where pixels ADD value for a copilot
  that already has symbolic ground truth — 24 sources, 115 claims, top 25 panel-verified: 23
  confirmed, 2 refuted. Round two's verification budget covered the web/GUI-agent legs; its
  Minecraft-specific/viewpoint/format legs were then checked by a dedicated single-verifier pass
  (§Verification pass) against primary full texts.

Markers: **[verified]** = survived an adversarial panel. **[checked]** = confirmed by the dedicated
single-verifier pass (weaker than a panel, stronger than extraction). **[unverified lead]** =
extracted with verbatim quotes but never independently re-checked — treat as pointer, not evidence.

## Headline

**The literature validates our architecture more than it challenges it.** Nearly every SOTA system
solves a problem we deliberately don't have (partial observability, noisy sensors, expensive
re-observation), and the strongest *measured* evidence — FLE's query-on-demand design, AriGraph's own
oracle-vs-graph numbers, osmAG-LLM's coarse-map-plus-recheck results — points at exactly the design we
already run: the game is the world model, query and serialize per-call, verify at use time. The genuinely
new opportunities are three: a **region-scale rung above the ladder** (SayPlan's collapse/expand pattern,
computed on demand), a **spatial index + `locate` over agent memory** (eMEM pattern), and **server-side
derived spatial predicates** (fit/clearance/pathability) — because the best-documented failure mode is
not perception quality but the model's own spatial arithmetic.

A meta-finding that changes how we should read this literature: **4 of 25 claims were refuted 0-3, all
of them summary-level characterizations of what representation actually reaches the LLM** in
GITM/JARVIS-1/Optimus-1. Abstracts and surveys in this field routinely misdescribe the observation
pipeline. Anything load-bearing must be checked against paper bodies.

## (a) Taxonomy of approaches, with evidence quality

### 1. Per-query text serialization — the Minecraft-agent default
**Voyager** (arXiv 2305.16291): Mineflayer state → prompt text; only persistent memory is a skill
library of executable code — no spatial map at all. **GITM** (2305.17144): headline gains (+47.5%
ObtainDiamond) are confounded with a structured *action-space* abstraction vs whole-architecture RL
baselines — nothing attributes anything to observation format. **JARVIS-1** (2311.05997): persistence is
a multimodal memory of (task, observation) → successful-plan entries, not a scene representation.
**[verified, 9-0 merged]**
**Evidence quality: precedent only.** None of the flagship papers ablate the representation choice.
"The field does X" is convention, not evidence.

### 2. Query-on-demand typed API — Factorio Learning Environment (2503.09617)
Agents interact through a REPL calling typed methods; observations are only what their own queries
return; queries return snapshots, not live references, requiring re-query. **The closest architectural
cousin to mcp-toolkit in the literature and direct support for "Minecraft is the world model".**
**[verified 3-0]** NeurIPS 2025 D&B, benchmark scale. Caveat: FLE never ablated its serialization either.

### 3. Human-realism pixel observability — JARVIS-1, Optimus-1 (2408.03615)
Both deliberately restrict to 640×360 RGB + mouse/keyboard ("observation space completely consistent
with human players"; "no high-level observations like voxels... can be accessed"). **[verified 6-0]**
This is the *opposite design point* from a labeled-omniscient copilot: their vision-language grounding
machinery exists to overcome constraints we don't have. Do not import.

### 4. Persistent graph-memory world models — AriGraph (2407.04363, IJCAI 2025)
LLM-extracted semantic triplets + episodic vertices, with staleness handling (outdated-edge
detection/removal — i.e., it *implements the sync burden our don't-build list predicts*). Its own
NetHack numbers are the decisive datum: accumulated graph **593.00 ± 202.62** vs direct oracle access
to explored state **675.33 ± 130.27** — the graph only *approaches* the ceiling that omniscient
re-query sets; when oracle access exists, the graph adds nothing. Navigation payoff depends on
hand-coded expert knowledge of which triplets are locations/exits (Appendix B), so "learned world model
from scratch" is overstated. **[verified 9-0]** Caveat: n=3, overlapping error bars — but the
*direction* (graph ≤ oracle) is exactly what our build/don't-build decision needs.
**One transferable idea:** explicit place-connectivity + "unexplored exit" tracking as agent-side
memory *annotations*, not a mirror.

### 5. Hierarchical collapse/expand — SayPlan (2307.06135, CoRL 2023 oral)
LLM sees only a collapsed top level of a large 3D scene graph and issues explicit expand/contract API
calls to unfold task-relevant subgraphs; **measured 82.1%/60.4% input-token reductions** — quantified,
peer-reviewed. **[verified 6-0]** Mismatch: SayPlan presupposes a curated *static* scene graph and a
graph simulator for replan feedback. Take only the **interaction pattern** — agent chooses when to
descend (our ladder already does this at block scale) — and extend it *upward* to region scale via
on-demand aggregation against live chunks. No persistent graph required.

### 6. Coarse hierarchical text map + live re-verification — osmAG-LLM (2507.12753, RA-L 2026)
OSM-style XML, key-value tags, explicit parent hierarchy: 3.2 MB vs 1493 MB for a dense scene graph
(HOV-SG) on HM3D-SEM; beat dense-graph baselines on open-vocab retrieval (room retrieval 1.00 vs
0.40/0.50); on relocated objects, coarse-cached-index-plus-online-recheck scored **0.70 detection
improvement vs 0.00 for the static dense map**. **[verified 9-0]** Caveats: single building, author-run,
~10 queries per category (1.00 = 10/10), the 0.00 baseline is near-tautological, and the size comparison
isn't information-equivalent (HOV-SG stores CLIP features). Direction nonetheless matches our existing
places-memory + `expect`-verification pattern: **small coarse textual index, leaves re-verified live at
use time**. The extension it suggests: hierarchy (region → place parent tags) in places memory.

### 7. Multi-index agent memory with spatial retrieval — eMEM (2606.03374)
SQLite structured + HNSW semantic + R-tree spatial behind one graph model; ten retrieval primitives as
first-class LLM tools, including `locate` (concept → centroid + spread, bridging "kitchen" to
coordinates); regions/places are *query-time clusters*, explicitly not a mirrored scene.
**[verified 3-0, but confidence medium]** — one-month-old unreviewed preprint, descriptive claim, no
comparative performance evidence. The pattern (not the results) is directly importable.

### 8. Factored typed observation channels — NetHack LE (2006.13760)
Separate typed streams (glyph map, stats, message, inventory) parallel our ladder-of-distinct-tools.
But the paper offers **no measured evidence** the symbolic representation outperforms anything — the
claimed benefit rests on qualitative analyses; no symbolic-vs-pixel ablation exists (pixels weren't
even renderable at release). Also targets RL training, not LLM context. **[verified 6-0]**
**Design precedent, not evidence.**

### 9. Structured procedural knowledge — Optimus-1's one real ablation
Removing the craft-relation knowledge graph cost ~20% average success; removing the episodic
experience pool ~12%; removing episodic retrieval for reflection ~10%. One of the very few genuine
memory ablations in the surveyed literature. **[verified 3-0]** Author-run, unreplicated, single
backbone (GPT-4V), autonomous-player setting. Transferable lesson: **structured queryable domain
knowledge beats episodic logs** — and we already get the equivalent (recipes, registries) free from
authoritative server queries. Weakly supports investing in the typed tasks/procedural side of memory
over richer episodic recall.

## (b) Failure-mode evidence that should shape our formats

- **Models cannot mentally integrate a map from sequential observations.** GPT-3.5 Zork probe: 18.5%
  destination prediction, 22.8% two-step navigation (Tsai et al., via survey 2404.02039); CogEval
  corroborates for GPT-4. **[verified 6-0]** — dated (2023), may understate 2026 models. But a 2026
  benchmark shows the gap persists at frontier: on a Cognitive Mapping subtask (build topology of a
  large space from textual observations) the best model scored **8.34% vs 26.77% human**
  (2601.03590) **[unverified lead]**. Consequence: never design a tool that only works if the model
  accumulates a mental map across calls — compute topology/summaries tool-side.
- **Even clean ground-truth symbolic observations don't fix spatial arithmetic.** FLE Insight 2:
  frontier models (incl. Claude 3.5 Sonnet) systematically placed entities on top of / too close to
  each other and failed to leave room for connections — with text-only API observations, structurally
  excluding perception as the cause. **[verified 6-0]** FloorplanQA corroborates **[unverified leads]**:
  failures are dominated by geometric *computation* errors (centroids, unions), not parsing; near-ceiling
  on lookups (99.8% pair-distance) vs near-floor on compositional geometry (0.2–47% free-space);
  permuting semantic labels while preserving geometry degrades performance (models lean on semantic
  priors — an argument *for* our meaningful `id[state]` palette strings); verbosity measurably costs
  accuracy on large layouts. Consequence: **serve derived answers (fit, clearance, pathability), don't
  serve raw coordinates and hope.**
- **ASCII grids are a documented hazard.** GVGAI-LLM (2508.08501) **[unverified leads]**: models
  reverse vertical orientation, swap row/column, hallucinate proximity in sparse layouts; their own
  ablation found explicit coordinate tags did NOT significantly help; ~5–8k tokens per step for 10.27%
  win rate. A 5×5 grid-world study (2502.16690) **[unverified lead]**: cartesian coordinate lists beat
  symbol grids 66% vs 30% at 8B scale (98% at 90B; small models near chance on everything except JSON
  coordinates) — LLaMA-3-only, deliberately simple task. Consequence: our coordinate-row + palette
  format is on the right side of this evidence; don't add an ASCII-art map rung.
- **Text beats pixels for spatial input, dramatically.** Maze study (2603.26839) **[unverified leads]**:
  Claude Sonnet 4.6 goes 6% (image) → 80% (text grid); Opus 4.7 31% → 90%; models solve mazes by
  translating images into token grids then serially enumerating — the bottleneck is image→structure
  extraction, which we can always do server-side for free. Supports keeping pixels off-ladder.
- **Field report — Gemini Plays Pokemon** (blog, quality: anecdotal) **[unverified leads]**: harness
  injected ground-truth RAM state because the VLM misread pixels (signs as doors, own avatar as NPC);
  the model consumed a *text rendering* of a cached fog-of-war tile memory (agent-side spatial index
  over ground truth — our pattern); spatial decisions degraded past ~100k context (walking in circles
  for ~8h), fixed by summarization+reset, not richer maps; a delegated LLM "pathfinder" solved a
  long-stuck maze on first attempt *and still hallucinated walking through walls*. Consequence:
  pathfinding belongs in code (we have it — `bot_goto`), never in a sub-LLM.

## (c) Format/serialization findings (research question 4 — mostly unanswered)

No format-comparison claim survived to the verified set; the caveat stands that **our palette/heightmap
format choices remain justified by first principles, not external evidence**. Unverified leads worth
knowing:

- JSON vs XML: minimal accuracy difference when semantic content is held constant (FloorplanQA ablation).
- Compact formats (TRON/TOON): 18–27% token savings but a measurable accuracy tax on 17–32B open models;
  a single failed parse can trigger reasoning cascades that *reverse* the savings (+8–11% total tokens);
  format-by-model interaction is as large as the format effect; prior work at frontier scale (9,649
  trials, 11 models) found format does not significantly affect accuracy (p=0.484). **Consequence: do
  not switch serialization formats without local measurement; expect null results at frontier scale.**
- Token cost for identical spatial tasks varies ~14× across models; output-budget exhaustion is a real
  failure mode on large layouts — compact *summarization* (not compact *syntax*) is what matters at
  region scale.

The literature lacks the head-to-head we care about (JSON block lists vs palette/RLE vs ASCII grid vs
rendered image, on token cost + misread rate). A cheap local ablation on our own `get_blocks` output
would produce evidence the field doesn't have.

## (d) Shortlist — concrete candidates, evidence, cheap ablations

1. **Region-rollup rung above `scene_summary`** (SayPlan pattern, derived on demand).
   A `get_region_summary` that aggregates loaded chunk data into per-region rollups — biome mix,
   height stats, structure tags, water/lava presence, player-built-block density, notable POIs from
   places memory — with the agent expanding subregions on demand, everything under the existing
   coverage envelope (unloaded chunks honestly reported, never generated). No persistent cache in v1:
   compute per query; only consider an invalidate-on-chunk-dirty cache if measured latency demands it
   (open question 2). Evidence: SayPlan's 82/60% token reductions [verified]; osmAG's
   coarse-hierarchy-plus-recheck [verified]; the map-integration failure mode makes survey-level
   summaries necessary rather than nice-to-have [verified].
   **Ablation:** "find a site / plan over a large area" tasks (extends the existing scenario-1
   harness), with vs without the rung; measure tokens, calls, task success, wrong claims.

2. **`locate` over agent memory** (eMEM pattern) — **narrowed 2026-07-22 after code validation:**
   `mem_recall` ALREADY has a spatial filter (`center`+`radius`, 3D Euclidean via
   `store.mjs inSpace`; records carry `pos`/`bounds`/`chunk`/`region` tags). What's actually missing
   is the *other direction*: concept → location ("where is the sheep farm?" → centroid + spread +
   the matching places), i.e. a locate-style render, not a new filter. An acceleration index
   (grid buckets keyed by the existing `region` strings, built in `#resyncRecords`) is deferred
   until linear-scan recall measurably hurts — recall is a full scan today and fine at current
   scale. Keep it agent-side — memory, not world; don't-build list untouched. Evidence: eMEM
   [verified but medium — pattern, not results]. **Ablation:** answer quality + tokens on
   "where is X" concept queries with vs without the locate render, over the soak corpus.

3. **Server-side derived spatial predicates.**
   `check_fit` (does footprint W×H×D fit at pos, respecting clearance), `check_clearance`,
   pathability/reachability queries — vanilla pathfinder answering "can an entity walk from A to B"
   as an observe tool. Code validation 2026-07-22: `check_path` ALREADY exists
   (`VillageJobsTools.checkPath` — throwaway Villager + `PathNavigation.createPath`, returns
   reachable/partial/nodes/end; registered and current) — generalize/promote it into mcp-toolkit
   rather than build anew. Clearance precedent: `SiteCheck.firstObstruction` (BlockGetter-based).
   A flatness/height-variance helper exists NOWHERE — `check_site` would be genuinely new math.
   Precondition for any new predicate/rollup tool outside `WorldPerceptionTools`: the `ChunkLoader`
   and `coverage()` helpers are currently PRIVATE to that class — promote to a shared util first. Evidence: FLE placement failures with clean symbolic obs [verified];
   FloorplanQA's computation-not-parsing failure profile [unverified lead]; Pokemon pathfinder
   hallucinations [unverified lead]. This attacks the *actual* documented bottleneck (model spatial
   arithmetic) instead of re-litigating perception.
   **Ablation (also open question 4):** mine mcp-toolkit session logs for the placement-error class
   first; count errors on building-copilot tasks with vs without predicates.
   *Status 2026-07-23 (0.7.0): the predicate family gained its INVERSE — `find_site` (footprint →
   ranked, fit-verified candidates; the model no longer generates candidate coordinates, the
   documented failing step) and `resolve_anchor` (relation → coordinates for placement, fit check
   in-call). Region connectivity (surface-walk components + tri-state `connected` on
   get_region_summary, opt-in) closes the region-adjacency gap the same way. Live-verified 8/8
   (probes/spatial-inversion.test.mjs), full suite 93/93. The with/without token ablation remains
   to run.*

4. **Hierarchy tags in places memory** (osmAG pattern, small).
   Region → place parent tags on `places.jsonl` entries, so rendered memory summaries can collapse by
   region. Cheap, composes with items 1–2.

5. **Local format ablation on `get_blocks`/`get_blocks_at` output** — generate the evidence the
   literature lacks before considering any format change. Expect a null result at frontier scale
   (McMillan p=0.484); that null would itself close the question cheaply.

## (e) Explicitly rejected, and why

| Rejected | Why |
|---|---|
| AriGraph-style persistent KG world model | Solves POMDP re-observation cost (~zero here); its own numbers show graph ≤ oracle when re-query exists; implements the exact sync burden our don't-build list predicts. Confirms the existing don't-build entry with external evidence. |
| Pixel-first perception / VLM grounding imports (JARVIS-1/Optimus-1 pipelines) | Machinery exists to overcome human-realism constraints we deliberately don't have; maze evidence shows text-grid input beats images 6%→80% when structure can be extracted — and we extract server-side for free. Screenshot stays off-ladder; the drone-POV render stays gated on a benchmark showing symbolic failure (GUIs/textures), per ARCHITECTURE.md. |
| ASCII-map rung on the ladder | Documented orientation/row-col/proximity failure modes; coordinate tags didn't fix it in the one ablation; coordinate+palette formats outperform grids in the available (weak) evidence. |
| Blanket serialization format switch (TOON/TRON/etc.) | Model-dependent, parsing-cascade risk, likely null at frontier scale; measure locally or don't move. |
| Any tool whose correctness relies on the model mentally accumulating a map across calls | Best-documented failure mode in the corpus (18.5% GPT-3.5 → still 8.34% vs 26.77% human at 2026 frontier on cognitive mapping). Summaries and topology are computed tool-side or not at all. |
| LLM-delegated pathfinding sub-agent | Anecdotal but vivid: solved the maze, still walked through walls. Pathfinding is code (`bot_goto`), verification is `expect`. |

## Round two — the client/visual channel

Question: our copilot has BOTH channels (authoritative symbolic reads + client screenshot/UI tools +
a possible off-screen render). Where do pixels measurably ADD value on top of symbolic access?
Best-evidenced analog: web/GUI agents, the one literature where agents genuinely have a complete
symbolic ground truth (DOM/accessibility tree ≈ our server state) *and* pixels, with real ablations.

### The one-line answer

**Pixels add value exactly where the symbolic representation is incomplete for the task's content —
and nowhere else.** And even there, text must always ride along: removing text while keeping the
annotated screenshot collapses performance (Gemini 1.5: 64.20% → 3.70% on VisualWebArena).

### Task-class matrix (all deltas panel-verified, all 2024-era GPT-4V-generation)

| Task class | Winner | Measured delta | Source |
|---|---|---|---|
| Complete symbolic representation exists | **Symbolic, ~2×** | OSWorld: a11y-tree GPT-4 12.24% vs screenshot-only 5.26%; same-model control GPT-4o 11.36% vs 5.03%; hybrid merely matches text-only (12.17%), sometimes below it | OSWorld (NeurIPS 2024 D&B) |
| State-tracking / history | **Text** | More trajectory history helps as text, adds nothing as screenshots; "never carry screenshots forward as memory — summarize to text immediately" | OSWorld analysis [medium confidence: single model, subset] |
| Element grounding / action targeting | **Textual choices** | SeeAct: textual-choice grounding beats image-annotation grounding by ~18–19pp on every Mind2Web split | SeeAct (ICML 2024) |
| Content the symbolic layer can't express (visual identification, spatially-entangled dynamic layouts) | **Hybrid, up to ~2×+** | VWA: 7.25% → 15.05%; WebVoyager: 40.1% → 59.1%; SeeAct live: 13.3% → 37.8%; per-site up to Booking 2.3% → 43.2%; but null-to-negative on text-dense sites | VWA (ACL 2024), WebVoyager, SeeAct |
| — of which describable content | Captions recover ~70% | Feeding BLIP-2 captions to text-only GPT-4 recovers 12.75 of the 15.05; irreducible pixel-only margin ≈ 2.3pp | VWA Table 3 |
| Planning-from-render vs grounding | VLM plans, symbols ground | GPT-4V completes 51.1% with oracle-grounded plans vs 37.8% with best automatic grounding — never ask the VLM for coordinates | SeeAct |

### Set-of-marks (annotated screenshots): density and mark quality govern everything

- Good marks on natural images: transformative — RefCOCOg 25.7 → 86.4 ACC@0.5. **[verified]**
- Cluttered-but-sparse agent screenshots: modest and model-dependent — VWA +1.32pp overall for
  GPT-4V, best on dense Classifieds, slight loss on Shopping; no benefit for Gemini-Pro;
  near-zero for open models. **[verified]**
- Dense high-resolution scenes with many similar elements — *the closest analog to a wall of
  identical blocks*: **actively harmful** — OSWorld SoM collapsed GPT-4o 11.21% → 4.59%
  (spreadsheet cells; label noise + tasks needing coordinate precision that box indices can't
  express). **[verified]** Confounds recorded: OSWorld's marks were low-quality a11y-leaf boxes, and
  SoM *helped* Claude-3-Opus and Gemini-Pro-1.5 in the same table — density and mark quality are the
  governing variables, and **both are controllable by us**: the server can supply ground-truth marks
  (better than every surveyed system, which all inferred marks) on deliberately sparse targets.
- Overlay hazard: 24.8% of WebVoyager failures were visual-grounding errors, including the model
  confusing page content with its own overlaid labels — directly relevant to overlays on Minecraft
  scenes full of signs and numbers. **[verified]**

### Round-two caveats that bound all of the above

Every number is early-2024 GPT-4V-generation; pixel-native *trained* agents (UI-TARS, CUA) have since
inverted text-vs-pixels via RL on pixels — but we prompt general-purpose models, so the prompted-agent
regime is our regime, with 2026 deltas unmeasured. VWA is deliberately visual (deltas are upper
bounds); OSWorld's a11y tree completeness is generous; several deltas are single-run and small-n.
One contaminated source: arXiv 2409.12089's "74.07% hybrid vs 38.89%" table was refuted 0-3 —
treat anything citing it as suspect.

## Verification pass — RQ3–5 (Minecraft visuals, viewpoint, formats, frontier status)

Round two's panels never reached these legs; extractions existed with verbatim quotes. A dedicated
single-verifier pass (one adversarial agent per primary source, refute-by-default, numbers checked
against tables in the full text) ran on the six load-bearing sources. **All six survived**, with
corrections noted inline.

### VLM-as-judge on Minecraft works — the purely-additive use case has real evidence **[checked]**

**MCU** ("MCU: An Evaluation Framework for Open-Ended Game Agents", arXiv 2310.08367v4, ICML 2025
Spotlight): a GPT-4o judge shown gameplay frames (1-in-30 sampling) + task-specific criteria reaches
**91.5% average agreement with human raters** across six dimensions on open-ended Minecraft tasks —
including build tasks (Build Pillar, Nether Portal, Waterfall…; build F1 85.0). Verified weak spots:
fine-detail **craft/GUI reading is its worst category (F1 62.0)** — supporting keeping GUI reads
symbolic — and creativity is the weakest-correlated dimension (Pearson 0.63, partly because human
inter-rater agreement on creativity is itself only ~0.69). The generalist VLM judge crushes
domain-tuned MineCLIP at comparative evaluation (84.0 vs 34.6 F1) — frontier general VLMs, not
domain-tuned encoders, are the right judging engine. MCU agents are pixel-only (640×360) with no
vision-vs-symbolic ablation, so its evidence transfers ONLY to the judge/aesthetics role, not to
perception-channel choice.

### Stock VLMs are measurably weak at Minecraft perception **[checked, one correction]**

**JARVIS-VLA** (arXiv 2503.16365, ACL 2025): genuinely off-the-shelf Qwen2-VL scores 46.5% on
Minecraft visual-understanding QA and **16.6% on spatial grounding** (localizing objects in MC
scenes); Minecraft-specific post-training lifts these to 76.7%/88.0%, and the stage ablation shows
**spatial-grounding training is the single most impactful capability** — i.e. localization is the
weakest VLM skill on Minecraft imagery, exactly what server-supplied marks/coordinates externalize.
GPT-4o scored 76.7% visual understanding (no grounding score reported) — better, not solved.
**Correction to the round-two extraction:** raw-model GUI failure was overstated — craft was 0.60
(not 0.03–0.10); only smelt, the most precision-demanding GUI task, was at 0.07 (→0.70 after
post-training). And "raw" rows are trajectory-fine-tuned (an off-the-shelf VLM can't emit actions
at all), so the acting numbers are not zero-shot evidence.

### Renders don't fix spatial reasoning; symbolic coordinates do — now confirmed at the 2026 frontier **[checked]**

Three independent confirmations of the same pattern:

- **Disjoint-3DQA** (arXiv 2505.24257): VLMs answering spatial questions about objects seen in
  different video frames lag humans by 28% (60%→30% as the frame gap widens). Giving them BEV
  projections or trajectories: **marginal** (+2.6% GPT-4o). Giving them oracle 3D coordinates:
  **+20%.**
- **Think-Remember-Navigate** (arXiv 2511.08942): ablation — removing the top-down obstacle-map
  *image* costs 0.7 SR points; removing *textual* action history costs 10.3. The text channel
  carries the system; the render is nearly decorative.
- **IndustryNav** (arXiv 2511.17384) — **the frontier answer.** Fourteen VLLMs including GPT-5.2,
  Claude-Sonnet-4.6, Gemini-3-flash: best (Claude-Sonnet-4.6) reaches 79.17% SR vs human 100%,
  collision ratios 36–38% even for leaders, and the top-down-map ablation verbatim: "incorporating
  the top-down map does not improve task success or reduce warning ratios... We attribute this to
  VLLMs' limited ability to interpret top-down maps and the additional noise such representations
  introduce **compared to clean odometry signals**." Symbolic odometry and text history help;
  the extra render does not. The sequential-observation spatial-integration weakness **persists
  into the 2026 model generation** — round-one open question 3 is answered.

### Viewpoint matters only for gestalt, never for geometry **[checked]**

**InfiniBench** (arXiv 2511.18200): raising the camera from egocentric (1m) to bird's-eye (2.5m)
substantially improves counting/perspective-taking (GPT-5 55.5→69.1) and appearance-order
(GPT-5 31.3→49.0) but is **negligible on measurement/distance tasks** (Gemini 68.9 vs 68.1). Accuracy
collapses with clutter (Gemini spatiotemporal 87.9→56.2 from ~5→~50 objects; documented
repetitive-counting overestimation on multi-frame input) — bounding expectations for renders of busy
Minecraft scenes. Synthetic Blender scenes; no symbolic-input arm. Practical read: if we ever render
for the agent, render *elevated and sparse*, and only for gestalt questions.

### Text arrays beat both image viewpoints — SPACE, with honest caveats **[checked]**

**SPACE** ("Does Spatial Cognition Emerge in Frontier Models?", Apple, ICLR 2025, arXiv 2410.06468):
the only three-way format head-to-head found anywhere — on identical large-scale spatial tasks,
**text character-array maps beat allocentric map images beat egocentric images** (Claude 3.5 Sonnet
33.5 / 26.3 / 19.6; GPT-4o 32.6 / 28.8 / 23.0), and a selective-attention control (>95%, at/above
human) proves the failures are spatial computation, not input parsing. Near-chance on cognitive
mapping from egocentric input; the allocentric map does not rescue it. Caveats the verifier pinned
down: **2024-era models only** (no Claude 4+/GPT-5/Gemini — frontier transfer comes from IndustryNav
above, not SPACE); small-scale text-vs-multimodal gaps are partly an artifact of simplified text task
variants (authors' own admission); environments are 2D tile maps, not voxel worlds — and human
text-array scores drop to 65–80% because text arrays impose their own legibility cost, which would
worsen for 3D coordinate lists.

### Round-one lead status after both passes

| Lead | Status |
|---|---|
| MazeBench 6% image vs 80% text-grid (2603.26839) | **[checked]** — round-two full-text re-extraction, quotes + scope note (110 mazes, 16 configs, single-author preprint) |
| GVGAI-LLM grid confusions; coordinate-tag ablation not significant (2508.08501) | **[checked]** — Table 6 numbers quoted (0.00→0.08 best case, Fisher n.s.); + wall-bumping stat (137 vs 14 steps) |
| FloorplanQA computation-not-parsing; label-permutation; JSON≈XML (2507.07644) | **[checked]** — invalid answers <1%, code interpreter +40pt on arithmetic tasks; label-permutation effect is task-dependent (Repositioning 60.5→40.0, others stable); JSON vs XML ±3pp |
| Cartesian 66% vs symbol-grid 30% (2502.16690) | **[checked]** — exact; but gap largely closes at 70B/90B scale (>74% all formats), weakening frontier transfer |
| TRON/TOON token/accuracy trade (2605.29676) | **still [unverified lead]** |
| SiT-Bench cognitive mapping 8.34% vs 26.77% (2601.03590) | **still [unverified lead]**; benchmark unreleased (placeholder repo) — cannot run it yet |
| Gemini-Plays-Pokemon harness lessons (blog) | anecdote, now corroborated in kind by a second blog datum: Claude Opus 4.5 (Jan 2026) still vision-bottlenecked on Game Boy screens, stuck on boulder (precise-geometry) puzzles after 230k steps |

## Client-channel candidates (extends the round-one shortlist)

6. **VLM-as-judge build-quality rung** — the one purely-additive visual use (no symbolic
   alternative), now with real evidence (MCU 91.5% human agreement; build F1 85.0). Shape: a
   `judge_build` flow — screenshot or (future) drone render + task/aesthetic criteria → structured
   judgment; never for GUI reads (craft F1 62.0 is the documented floor — `get_screen` stays
   authoritative). Fits Village Jobs building-pipeline review. **Ablation:** have the judge score
   N builds Matthijs also rates; check agreement + which criteria correlate.
7. **Optional elevated render for gestalt only** (drone-POV/orthographic, off-screen later): justified
   for counting/overview/anomaly-spotting questions (InfiniBench BEV gains; VWA-class content pixels
   express that symbols don't), *never* for measurement/geometry/navigation (InfiniBench negligible;
   IndustryNav map-doesn't-help; Disjoint-3DQA oracle-coords-beat-BEV). Rules from the verified
   evidence: always paired with symbolic text (Gemini 64.20→3.70 collapse without text); sparse
   server-supplied ground-truth marks only (dense SoM collapsed GPT-4o 11.21→4.59 on
   spreadsheet-like scenes — the wall-of-identical-blocks analog); expect degradation in cluttered
   scenes; **never carry images forward as memory — summarize to text immediately** (OSWorld
   history finding).
8. **Marks-as-grounding, not marks-as-decoration**: if an annotated render ships, marks exist to
   externalize localization (the weakest VLM skill on Minecraft imagery per JARVIS-VLA's grounding
   ablation), with the VLM proposing over mark IDs and the symbolic layer grounding/executing
   (SeeAct: oracle-grounded plans 51.1% vs 37.8% self-grounded — never ask the VLM for coordinates).

## Client-channel rejections (extends the round-one reject list)

| Rejected | Why |
|---|---|
| Top-down map/minimap as a *planning* aid | Three independent confirmations it doesn't help planning/navigation (IndustryNav frontier ablation; Think-Remember-Navigate 0.7pp; Disjoint-3DQA marginal) while symbolic coordinates/odometry do. Elevation earns its keep only on gestalt tasks (InfiniBench). |
| Dense set-of-marks on block-dense scenes | OSWorld: SoM collapsed GPT-4o 11.21→4.59 on many-similar-elements scenes; SeeAct: image-annotation grounding −18–19pp vs textual choices; WebVoyager: models confuse overlays with content. Sparse ground-truth marks remain allowed (density + mark quality are the governing variables, both ours to control). |
| VLM GUI reading as a `get_screen` replacement | MCU judge worst on craft detail (62.0 F1); JARVIS-VLA needed heavy domain post-training to make pixel GUI work (smelt 0.07→0.70); we already have the symbolic ground truth. Pixels may *supplement* for texture-dependent GUI content only. |
| Screenshots as memory/history | OSWorld: text history helps, screenshot history doesn't [medium confidence]. Any visual observation worth keeping gets summarized to text (which our typed memory already enforces by shape). |

## Open questions (updated after all passes)

1. Spatial serialization head-to-head: SPACE now gives text-array > map-image > ego-image (2024-era,
   2D tiles, with artifact caveats), but JSON-coordinate-lists vs palette/RLE vs text-grid on *voxel*
   data with token cost and misread rate remains unmeasured — our own ablation is still novel
   evidence (shortlist item 5).
2. Can region rollups be computed per-query fast enough over loaded chunks with honest coverage, or
   does a derived invalidate-on-dirty cache earn its keep despite the sync cost? (Measure before caching.)
3. ~~Do 2026 frontier models still show the map-integration failure?~~ **Answered: yes** —
   IndustryNav (GPT-5.2/Claude-4.6/Gemini-3: best 79% SR, human 100%, top-down map doesn't help) and
   Disjoint-3DQA (oracle coords +20% vs marginal visual aids). Still open: the *voxel-specific*
   variant (Y-up confusion, block coordinates) — no benchmark tests it; SiT-Bench is unreleased
   (placeholder repo as of 2026-07-22) and is indoor/robotics-flavored anyway. A local
   walk-then-quiz probe (sequential ladder observations → topology questions scored against server
   truth) remains the decisive test and is cheap to build on the existing harness.
4. Which minimal set of derived spatial predicates covers most observed placement failures in our own
   session logs?
5. Does the VLM-as-judge agreement (MCU: 91.5%, creativity 0.63) hold for *our* build-quality
   criteria on real player builds? (Shortlist item 6's ablation.)

## Refuted during verification (do not cite)

- "GITM is entirely text-based with no pixel/voxel encoding" — 0-3.
- "JARVIS-1 maps raw visuals directly to plans with no symbolic state" — 0-3 (its planner also gets
  client-side symbolic text: coords, biome, inventory).
- "Optimus-1's HDKG retrieval works via topological sorting / is never serialized" — 0-3.
- "Survey: the dominant representation is Mineflayer-symbolic-state templates" — 0-3.

Pattern: all four are abstract/survey-level characterizations of observation pipelines. Full text or it
didn't happen.

## Round three — agent-platform survey (2026-07-23)

Four platforms surveyed as running systems rather than papers: **minecraft-dev-mcp** (MCDxAI —
static mod-dev tooling), **MineDojo** (NVIDIA, NeurIPS 2022 — pixel-RL platform + benchmark),
**TeamCraft** (UCLA, arXiv:2412.05255 — multi-modal multi-agent benchmark), and **mineflayer**
(PrismarineJS — the protocol-bot substrate under Voyager and Mindcraft). Same verdict as round
one, now from the platform side: **corroboration, not challenge**. Nothing surveyed argues against
the ladder, the mechanism taxonomy, or query-on-demand. The genuinely new candidates are
**action-side, not perception-side** — the perception argument is largely settled; where the
survey suggests improvement is in how actions are specified, narrated, and composed.

### Corroborating evidence (backs decisions already made)

- **Symbolic beats vision at the benchmark level** [verified — paper body, 2412.05255]. TeamCraft's
  own text-only grid-world ablation **outperforms their fine-tuned VLA vision models**, and GPT-4o
  few-shot scores near zero from images — failing specifically at 3D coordinate grounding from
  orthographic renders (places at (7,0,9) for (8,0,8)). This is an independent multi-agent
  replication of the round-two finding (text arrays beat both image viewpoints) and direct external
  evidence for the symbolic-ladder-first decision. Caveat consistent with round-two hygiene:
  their VLAs are 2024-era 7B/13B fine-tunes; frontier VLMs may narrow the gap (the McMillan-null
  class of caveat), but the direction matches every other measured result in this file.
- **The field's revealed preference for our architecture class** [verified — repo history]. The
  MineDojo team themselves abandoned their pixel-RL simulator (dormant since 2024, MC 1.11.2) for
  Voyager: code-as-actions against a live modern server. The platform generation we'd have had to
  argue against retired itself.
- **Convergent reinvention of the mechanism taxonomy** [verified — Mindcraft source]. Mindcraft's
  command surface is strictly split into mutating action commands vs read-only query commands —
  the observe/embodied/world_edit split independently reinvented by the largest community
  LLM-agent project. Voyager's wrapper conventions (legible failure strings fed back into context,
  escalating fail counters) match the legible-bounded-agency stance.
- **Centralized coordination wins absent communication** [verified — paper body, 2412.05255].
  TeamCraft: decentralized agents (no explicit channel) hit 15–24% redundant/conflicting actions
  vs ~1% centralized, and decentralized building success collapses toward zero. Direct input for
  the companion redesign: either one orchestrator issuing per-companion actions, or an explicit
  intent-sharing channel — silent parallel autonomy is the measured-worst shape.
- **Judge validation methodology** [verified — 2206.08853]. Before trusting MineCLIP as a creative-
  task judge, MineDojo validated it against 100-success/100-failure human-labeled trajectories per
  task (F1 97–100%). Portable protocol for validating any LLM/VLM judge we adopt (judge_build).

### Explorative options (extends the shortlist — each gated on a testbench motivation, not built on survey enthusiasm)

1. **Goal-shaped navigation targets** (mineflayer-pathfinder vocabulary). `bot_goto` takes a bare
   coordinate; mineflayer callers state a satisfaction predicate: `GoalNear(x,y,z,r)`,
   `GoalGetToBlock` (adjacent-to, not inside — the chest case), `GoalLookAtBlock`/`GoalPlaceBlock`
   (interaction precondition baked into the goal), combinators (any/all/invert=flee). The
   testbench already surfaced the ambiguity this vocabulary exists to kill (`arrived:true` without
   moving, TODO). **Motivator:** goto-then-interact failure counts in bench/live logs; if
   arrival-ambiguity errors recur, adopt goal kinds; if not, the coordinate contract is enough.
   *Status 2026-07-23: BUILT (0.5.0, principal decision ahead of the bench gate) — `reach {x,y,z}`
   on check_path/bot_goto/bot_run via a mode-blind ReachSolver + vanilla multi-target A*; see
   TODO.md and ARCHITECTURE.md "Reach goals". The motivator count remains worth running for the
   token-value number.*
   *Status 2026-07-23 (0.4.3): the GoalNear half is ADOPTED — `bot_goto` takes `within` (arrival
   radius, the r in GoalNear) and completions carry an honest enumerated `outcome`
   (arrived | already_there | stopped_short) with `traveled`/`path_partial`/remedy note, closing
   the arrival ambiguity and the 2.5-arrival-vs-4.5-hand-reach queue failure. The richer goal
   kinds (GoalGetToBlock/GoalLookAtBlock/combinators) stay gated on the original motivator, now
   countable: the per-call traces (91e32ac) record goto-then-interact sequences.*
2. **Enumerated failure reasons on long-running actions** — the action-side twin of the coverage
   contract. mineflayer path events carry machine-readable causes (`stuck`,
   `no_scaffolding_blocks`, `dig_error`, `goal_moved`) and statuses
   (`success/partial/timeout/noPath`). Our `action_failed`/follow/queue events could carry the
   same taxonomy; check_path's tri-state verdict (0.4.1) is a first instance of the same
   philosophy on the predicate side — **and the first MEASURED one**: the Category-T ablation
   caught haiku trusting a budget-truncated `reachable:false, partial:true` (rung-4 with-arm 50%,
   two confident-wrongs from one opaque verdict), and the 0.4.1 null-verdict-plus-remedy-note
   rerun took the same cell to 100% (4/4, one call, ~570 tokens/session) while the without-arm
   stayed at 50% at 20× the tokens (testbench-results/2026-07-23T06-31-05 and …T07-56-23). That is
   the per-episode token bill this theme claims, quantified once already. **Motivator:** count
   "model retries blind after opaque action failure" episodes in bench transcripts; each is a
   token bill this closes. *Status 2026-07-23 (0.4.3): second instance shipped on the action side —
   `bot_goto` completions carry the enumerated outcome + remedy note (see option 1), and
   `bot_run`'s `not_arrived` forwards the sub-action's distance/partial/pos instead of an opaque
   reason string. Not yet bench-measured (unlike check_path); the audit's remaining opaque spots
   are catalogued in TODO §hands (silent wrong-success class).*
3. **`exploreUntil(direction, timeout, predicate)`** (Voyager) — "wander that way until perception
   says stop" as one awaitable verb. **Motivator:** token count on discovery tasks vs the current
   goto+look loop.
4. **Testbench harness adoptions** (pure harness, no bridge changes — cheapest of the list):
   MineDojo's task-spec pattern (small parameterized meta-task set × item/quantity/initial
   conditions, success = declarative predicate over server state) with **two-seed determinism**
   (world seed vs variation seed); TeamCraft's **Redundancy Rate** (conflicting/duplicate actions ÷
   total) and **four-way generalization splits** (held-out goals / scenes / agent counts) for
   Category C. These don't need motivation — they ARE the motivation machinery. *Status
   2026-07-23: Category T (testbench/run-tasks.mjs) already implements the task-spec pattern
   (8 parameterized templates × variation seed, declarative server-truth scoring, fixed world) and
   a single-agent Redundancy-Rate analogue (`repeat_calls`: identical tool+args re-issued within a
   session, reported per arm). Generalization splits remain a Category-C item.*

### Cross-cutting themes (candidate design principles, to be motivated per-tool against bench results)

*Measurement plumbing (2026-07-23): every Category-T session now records an ordered per-call trace
(tool, args, error flag, result size) plus `repeat_calls`/`error_calls` in
testbench-results/*/answers.jsonl — the three motivator counts below (blind-retry episodes,
derivable-follow-up reads, statically-illegal first actions) are computable offline from any run,
no re-spend. The 2026-07-23 haiku baseline predates the trace field but its histograms already
show the shape: the without-arm burned 99 `get_blocks` calls where the with-arm spent 15
`check_site` + 8 `get_region_summary`.*

- **Affordance carrying.** MineDojo's symbolic channel attaches action-relevant flags to every
  observation unit: voxels and lidar rays carry `is_solid`, `is_liquid`, `blocks_movement`,
  `harvest_level`, `can_burn`, plus per-voxel cosine-with-gaze. The principle: an observation
  should answer the *next* question (can I dig/walk/swim/burn it) in the same payload, not just
  identity+geometry. Applies across the ladder: `raycast`/`raycast_fan` hits, `get_blocks_at`,
  `scan_box`, `get_entities` (reach/threat). Token mechanics: kills the follow-up query per hit.
  **Motivator:** count bench transcripts where a read is immediately followed by a second read
  whose answer is a derivable property of the first. *Status 2026-07-23 (0.7.0): SHIPPED at
  palette level ahead of the count (principal decision) — `Affordances.flags` per palette entry
  (O(palette), not O(cells)) on get_blocks/get_blocks_at/scan_box/raycast, plus `bearing`/`dy` on
  get_entities rows. The motivator count stays worth running for the token-value number.*
- **Action masks as observations.** MineDojo exposes per-step validity masks (which functional
  actions are legal, which of 244 recipes are craftable from current inventory, which slots
  equippable); Mindcraft computes inventory-aware `!craftable` and `!getCraftingPlan` server-side.
  The principle: surface "what is legal/possible right now" as state, so validity is observed
  rather than discovered by failing. Our analogues: `bot_status` could carry the active body's
  currently-valid actions (capability honesty is already per-body — extend to state-dependent);
  `get_screen` is already a UI action mask; a craftable-from-inventory query is the missing one.
  **Motivator:** fail-and-retry sequences in bench transcripts whose first action was statically
  illegal.
- **Automation verbs — closed loops move server-side.** The mineflayer plugin ladder is a
  15-year convergence on where the abstraction boundary sits: `collectBlock` = path→best-tool→
  dig→chase-drops→auto-deposit as ONE call; pvp's chase loop; auto-eat as a toggleable background
  *mode* distinct from foreground actions; TeamCraft drives its whole benchmark with 8
  parameterized skills of uniform signature (agent, item, target-pos). Our `bot_run` is a step
  *queue* — it sequences primitives but closes no loop (no retarget-on-move, no chase-drops, no
  tool selection). The principle: every loop the model would run turn-by-turn is a token bill;
  loops with crisp invariants belong in Java behind one verb. Candidates in rough order:
  `collect` (mine+pickup closure), best-tool selection inside `bot_mine`, follow-mode-style
  standing reflexes as named toggles. **Motivator:** tokens-per-outcome on delegated-physical
  bench tasks (Evaluation scenario 2) — compare one composite call vs the primitive loop.

### Rejected (extends the reject list)

| Rejected | Why |
|---|---|
| MineCLIP-style learned video-reward judge | Solves dense reward for RL, not our problem; the validation *protocol* (human-labeled success/failure sets, report F1) is kept above, the model is not. |
| Orthographic blueprint images as canonical build spec | TeamCraft's own data: models fail 3D grounding from exactly these renders while their text ablation succeeds. Build specs stay symbolic (structure NBT / block lists); renders remain optional human-facing artifacts. |
| Protocol-side bot substrate (mineflayer) for embodiment | Version ceiling (1.21.11, structurally lagging; 26.x unreachable), client-side physics re-implementation with server-correction desync, view-distance visibility ceiling, zero server-internal access. We are server-side; every ceiling listed is a thing we already have. Its *API vocabulary* is the import, per the explorative options above. |
| Pixel/RL observation-action spaces (MineDojo MultiDiscrete, camera-bin actions) | Built for policy learning, not tool-calling; the platform is dormant and its own authors moved on. |

### Sources (round three)

- TeamCraft: arXiv:2412.05255 (paper body read), github.com/teamcraft-bench/teamcraft, HF org
  `teamcraft` (55K demos; results table: Cen-7B TS build 42%/clear 64%/farm 36%/smelt 24%; RR
  0.01 cen vs 0.15–0.24 dec; GPT-4o near-zero; grid-world text ablation > VLA).
- MineDojo: arXiv:2206.08853, docs.minedojo.org (obs/action space pages), github.com/MineDojo —
  dormant (last push 2024-03); Voyager (same org) is the successor and uses mineflayer + code-gen.
- mineflayer: github.com/PrismarineJS/mineflayer docs/api.md; plugins pathfinder / collectblock /
  tool / pvp / auto-eat / statemachine; Voyager control_primitives; Mindcraft
  src/agent/commands/{actions,queries}.js.
- minecraft-dev-mcp: github.com/MCDxAI/minecraft-dev-mcp (static mod-dev tooling; complementary,
  no overlap — covered in the 2026-07-23 comparison; extraction script + query_class TODO).

## Sources (verified findings)

Round one: Voyager arXiv:2305.16291 · GITM 2305.17144 · JARVIS-1 2311.05997 · Optimus-1 2408.03615 ·
FLE 2503.09617 (NeurIPS 2025 D&B) · NLE 2006.13760 · SayPlan 2307.06135 (CoRL 2023) ·
AriGraph 2407.04363 (IJCAI 2025) · osmAG-LLM 2507.12753 (RA-L 2026) · eMEM 2606.03374 (preprint) ·
LM-spatial survey 2404.02039.

Round two (panel-verified): VisualWebArena 2401.13649 (ACL 2024) · SeeAct 2401.01614 (ICML 2024) ·
WebVoyager 2401.13919 · OSWorld 2404.07972 (NeurIPS 2024 D&B) · Set-of-Mark 2310.11441 ·
element-ordering TMLR 2025. Contaminated: 2409.12089 (phantom hybrid table, refuted 0-3).

Verification pass ([checked]): MCU 2310.08367v4 (ICML 2025 Spotlight) · JARVIS-VLA 2503.16365
(ACL 2025) · Disjoint-3DQA 2505.24257 · Think-Remember-Navigate 2511.08942 · IndustryNav 2511.17384 ·
InfiniBench 2511.18200 · SPACE 2410.06468 (ICLR 2025) · MineDojo/MineCLIP 2206.08853 (NeurIPS 2022,
[unverified-extraction only]) · FloorplanQA 2507.07644 · GVGAI-LLM 2508.08501 · grid-format 2502.16690 ·
MazeBench 2603.26839.

Still unverified leads: TRON/TOON 2605.29676 · SiT-Bench 2601.03590 (benchmark unreleased) ·
Gemini-Plays-Pokemon blog (jcz.dev) · Claude-plays-Pokemon LessWrong post (2026-01).
