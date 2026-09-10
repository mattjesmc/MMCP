// The bench REGISTRY — the single index behind both construction and display. Every runnable unit
// of the bench (a rung, a question pack, a gate, a course, a family…) is one record declaring:
//   - where it lives (cat + runner + the subset-selector value that runs exactly it),
//   - which ablation arms its harness supports (the toolset A/Bs stay IN the harnesses; here they
//     are only named so run-bench can choose "full bench" vs "std ablation" per unit),
//   - which world-understanding disciplines it makes load-bearing (`disciplines`) vs touches (`also`),
//   - how to recognize and score its rows in testbench-results (match/success/tokens) so reports
//     can pivot old and new results along the same axes without the scenario files changing.
// run-bench.mjs resolves a selection (full | --cat | --discipline | --unit) to units and shells out
// to the existing run-*.mjs entrypoints; bench-report.mjs joins result rows back to units. Adding a
// bench = adding records here; the selection and reporting axes pick it up unchanged.

import { DISCIPLINES, assertDisciplines } from "./disciplines.mjs";

// ---- runners: how each entrypoint takes subsets and arms ---------------------------------------
// selType "list" = comma-joined values; "max" = numeric prefix count (ladder/tier semantics).
export const RUNNERS = {
  "run.mjs":            { selKey: "cat",    selType: "list" },
  "run-tasks.mjs":      { selKey: "rungs",  selType: "list", arms: { flag: "arms", full: "with",    std: "with,without" }, loo: true },
  "run-memory.mjs":     { selKey: null,     selType: null,   arms: { flag: "arch", full: "full",    std: "full,no-recall" } },
  "run-play.mjs":       { selKey: "slices", selType: "list" }, // survive runs legal vs xray internally
  "run-combat.mjs":     { selKey: "rounds", selType: "max",  arms: { flag: "arms", full: "legal",   std: "legal,xray" } },
  "run-traverse.mjs":   { selKey: "tiers",  selType: "max",  arms: { flag: "arms", full: "predict", std: "predict,blind" } },
  "run-repair.mjs":     { selKey: "rungs",  selType: "list", arms: { flag: "arms", full: "goal",    std: "goal,hand" } },
  "run-redstone.mjs":   { selKey: "gates",  selType: "list" },
  "run-diagnose.mjs":   { selKey: "kinds",  selType: "list" },
  "run-objectives.mjs": { selKey: "family", selType: "list" },
  "run-wbuild.mjs":     { selKey: "modes",  selType: "list" },
  "run-rotate.mjs":     { selKey: null,     selType: null },
};

// ---- result-dir → category (extends coverage-report's categoryOf with the new benches) ---------
export function categoryOfDir(dirname) {
  if (/tasks/.test(dirname)) return "T";
  if (/mem/.test(dirname)) return "C";
  if (/play/.test(dirname)) return "P";
  if (/combat/.test(dirname)) return "E";
  if (/traverse/.test(dirname)) return "E";
  if (/repair/.test(dirname)) return "E";
  if (/objectives/.test(dirname)) return "E";
  if (/redstone/.test(dirname)) return "Z";
  if (/diagnose/.test(dirname)) return "Z";
  if (/rotate/.test(dirname)) return "R";
  if (/wbuild/.test(dirname)) return "W";
  return "AB";
}

// ---- row scorers (tolerant: a row an accessor can't score returns null and is counted unscored) --
const sBool = (k) => (r) => (typeof r[k] === "boolean" ? (r[k] ? 1 : 0) : null);
const sCorrect = sBool("correct");
const sFrac = (k) => (r) => (typeof r[k] === "number" ? r[k] : null);
const rowKey = (r) => String(r.id ?? "").split(".")[0];

// ---- load bands: the SPLIT that replaces `difficulty` ------------------------------------------
// The old single `difficulty` field conflated two independent quantities, and splitting the corpus
// by tier x arm showed which one it was actually grading:
//
//   tier       with-arm   without-arm
//   easy       96%        94%
//   medium     96%        74%
//   hard       96%        87%
//   very_hard  96%        25%
//   frontier   92%        45%
//
// The with-arm is pinned at ~96% at EVERY labeled tier, so `difficulty` was tracking how much the
// task needs the tools, not how hard it is to reason about. One field cannot carry both, and
// recalibrating it would just reproduce the confusion in a new place. So:
//
//   tool_dependence — how much the without-arm loses: (with acc - without acc).
//                     none <5pt | low <15pt | medium <35pt | high >=35pt
//   reasoning_load  — how hard it stays WITH every tool available: with-arm accuracy.
//                     low >=95% | medium >=80% | high <80%
//
// These are MEASURED from testbench-results, not authored — the whole point of the finding is that
// the hand-assigned labels were wrong (t8 was tagged "frontier" and scores 100% with tools; t3 was
// "medium" and never misses). A band is only assigned where that arm has n>=10 for the unit;
// otherwise it stays null, which is a real state and not a default: `tool_dependence: null` on
// t10-t16 records that those seven rungs have NEVER been run in the without-arm at all, and every
// non-T unit is null because outside Category T no unit has more than n=4.
export const LOAD_BANDS = {
  t1_point:        { tool_dependence: "none",   reasoning_load: "low" },
  t2_clear:        { tool_dependence: "low",    reasoning_load: "medium" },
  t3_conflicts:    { tool_dependence: "none",   reasoning_load: "low" },
  t4_reach:        { tool_dependence: "high",   reasoning_load: "medium" },
  t5_heights:      { tool_dependence: "none",   reasoning_load: "medium" },
  t6_cutfill:      { tool_dependence: "low",    reasoning_load: "low" },
  t7_watertiles:   { tool_dependence: "high",   reasoning_load: "low" },
  t8_sitesearch:   { tool_dependence: "high",   reasoning_load: "low" },
  t9_findsite:     { tool_dependence: null,     reasoning_load: "high" },
  t10_multipoint:  { tool_dependence: null,     reasoning_load: "low" },
  t11_multibox:    { tool_dependence: null,     reasoning_load: "low" },
  t12_machineroom: { tool_dependence: null,     reasoning_load: "low" },
  t13_hopperchain: { tool_dependence: null,     reasoning_load: "low" },
  t14_markerpair:  { tool_dependence: null,     reasoning_load: "medium" },
  t15_entityon:    { tool_dependence: null,     reasoning_load: "low" },
  t16_relcount:    { tool_dependence: null,     reasoning_load: "medium" },
};
/** Bands for a unit id; null/null when that arm has never been measured at n>=10. */
export const loadOf = (id) => LOAD_BANDS[id] ?? { tool_dependence: null, reasoning_load: null };

// NOTE: t9's and t12's bands above were measured BEFORE their validity fixes (t9's answer was
// derivable from the prompt; t12 was answerable closed-book). Both must be re-measured on the next
// full run — their current reasoning_load describes the leaky versions.

// ---- unit builder -------------------------------------------------------------------------------
function U(id, cat, runner, sel, disciplines, also, title, extra = {}) {
  assertDisciplines(disciplines, id);
  assertDisciplines(also, id);
  if (!RUNNERS[runner]) throw new Error(`${id}: unknown runner ${runner}`);
  return {
    id, cat, runner, sel, title,
    disciplines, also: also ?? [],
    ...loadOf(id),
    status: extra.status ?? "proven", // proven = has produced live scored rows; pending = live knob unconfirmed
    match: extra.match ?? ((r, dcat) => dcat === cat && rowKey(r) === id),
    success: extra.success ?? sCorrect,
    tokens: (r) => r.tokens_out ?? 0,
  };
}

/** Category C's `change` workflow units. A recall/revisit dir must NOT be expected to hold them —
 *  ratchet's expectedUnitIds keys off the manifest's `workflow` field to decide. */
export const C_CHANGE_UNIT_IDS = ["chg_grew", "chg_vanished", "chg_appeared", "chg_same", "chg_now"];

// ---- the units ----------------------------------------------------------------------------------
const A = (id, d, also, title) =>
  U(id, "AB", "run.mjs", "a", d, also, title, { match: (r, c) => c === "AB" && rowKey(r) === id });

export const UNITS = [
  // Category A — spatial cognition VQA from a recorded walk transcript (fresh no-tools session).
  A("a1", ["perceptual", "semantic"], [], "anomaly block identity"),
  A("a2", ["spatial"], ["perceptual"], "compass bearing tower→tower"),
  A("a3", ["spatial"], [], "nearest-corner landmark"),
  A("a4", ["perceptual", "semantic"], [], "channel liquid identity"),
  A("a5", ["quantitative", "spatial"], [], "straight-line distance estimate"),
  A("a6", ["spatial"], [], "eight-way bearing"),
  A("a7", ["quantitative"], ["spatial"], "height comparison tower vs roof"),
  A("a8", ["spatial"], [], "closest tower to lava"),
  A("a9", ["spatial", "physical"], [], "line-crossing water vs bridge"),
  A("a10", ["physical", "spatial"], [], "pen reachability (open)"),
  A("a11", ["physical", "spatial"], [], "sealed-box reachability"),
  A("a12", ["spatial"], [], "egocentric left/right transform"),
  A("a13", ["spatial", "relational"], [], "which towers north of channel"),
  A("a14", ["quantitative", "perceptual"], [], "tower count"),
  // Category B — the same cognition through three serialization formats (perception under encoding).
  U("b_formats", "AB", "run.mjs", "b", ["perceptual"], ["spatial", "quantitative"],
    "identical questions across json_coords / palette_rows / ascii_grid",
    { match: (r, c) => c === "AB" && /^b/.test(rowKey(r)) }),

  // Category T — tool-ablation task ladder (observe/predicate tools; arms with/without + --loo).
  U("t1_point", "T", "run-tasks.mjs", "1", ["perceptual"], ["semantic"], "point block-id query"),
  U("t2_clear", "T", "run-tasks.mjs", "2", ["perceptual", "spatial"], [], "box-clear check with decoy"),
  U("t3_conflicts", "T", "run-tasks.mjs", "3", ["quantitative"], ["spatial"], "count intruding blocks"),
  U("t4_reach", "T", "run-tasks.mjs", "4", ["physical", "spatial"], [], "pen reachability predicate"),
  U("t5_heights", "T", "run-tasks.mjs", "5", ["quantitative"], ["perceptual"], "wild min/max surface height"),
  U("t6_cutfill", "T", "run-tasks.mjs", "6", ["quantitative", "counterfactual"], [], "3-site cut/fill comparison"),
  U("t7_watertiles", "T", "run-tasks.mjs", "7", ["quantitative"], ["perceptual"], "9-tile water survey"),
  U("t8_sitesearch", "T", "run-tasks.mjs", "8", ["counterfactual", "quantitative"], ["spatial"], "flattest-tile argmin"),
  U("t9_findsite", "T", "run-tasks.mjs", "9", ["spatial", "quantitative"], [], "find_site placement search"),
  U("t10_multipoint", "T", "run-tasks.mjs", "10", ["quantitative"], ["perceptual"], "5-point multi-referent read"),
  U("t11_multibox", "T", "run-tasks.mjs", "11", ["quantitative", "spatial"], [], "4-box multi-referent survey"),
  U("t12_machineroom", "T", "run-tasks.mjs", "12", ["semantic"], ["perceptual"], "purpose→machine identification"),
  U("t13_hopperchain", "T", "run-tasks.mjs", "13", ["relational"], ["semantic", "spatial"], "follow the hopper line to its chest"),
  // r14-r16: relational-search rungs pricing locate's `pattern` direction (PATTERN_SEARCH_DESIGN.md
  // §Bench) — run with `--loo locate` for the with/without-pattern contrast.
  U("t14_markerpair", "T", "run-tasks.mjs", "14", ["relational", "spatial"], ["perceptual"], "find the face-adjacent marker pair among corner decoys"),
  U("t15_entityon", "T", "run-tasks.mjs", "15", ["relational"], ["perceptual", "spatial"], "which block has the mob standing ON it"),
  U("t16_relcount", "T", "run-tasks.mjs", "16", ["relational", "quantitative"], ["perceptual"], "count markers with no face-adjacent cobble"),

  // Category C — memory recall depth (arch full vs no-recall over a frozen corpus).
  U("anchor", "C", "run-memory.mjs", null, ["epistemic", "temporal"], [], "anchor fact recall"),
  U("where", "C", "run-memory.mjs", null, ["spatial", "temporal"], [], "where-was-it recall"),
  U("count", "C", "run-memory.mjs", null, ["quantitative", "temporal"], [], "count recall"),
  U("region", "C", "run-memory.mjs", null, ["relational", "epistemic"], [], "cross-region attribution"),
  U("breadth", "C", "run-memory.mjs", null, ["epistemic", "quantitative"], [], "corpus breadth recall"),
  U("stale", "C", "run-memory.mjs", null, ["temporal", "epistemic"], [], "post-mutation staleness"),
  // Category C, `change` workflow — the change-detection rung (OBSERVATION_MEMORY_DESIGN §6
  // prediction 2). These ask what no live read can answer: what was here BEFORE. Their world
  // mutation is applied only when the change workflow runs, so a recall/revisit dir legitimately
  // holds none of these rows (expectedUnitIds keys off the manifest's `workflow`).
  U("chg_grew", "C", "run-memory.mjs", null, ["temporal", "quantitative"], ["epistemic"],
    "change: cluster grew — the prior COUNT must be exact"),
  U("chg_vanished", "C", "run-memory.mjs", null, ["temporal", "epistemic"], ["perceptual"],
    "change: structure removed — a disappearance has no live evidence at all"),
  U("chg_appeared", "C", "run-memory.mjs", null, ["temporal", "perceptual"], ["epistemic"],
    "change: structure appeared where the platform was bare"),
  U("chg_same", "C", "run-memory.mjs", null, ["temporal", "epistemic"], [],
    "change: unchanged control — the false-positive guard"),
  U("chg_now", "C", "run-memory.mjs", null, ["perceptual", "quantitative"], [],
    "change: live re-read control (both arms should sit at ceiling)"),

  // Category P — true-play perception + survival (player-legal).
  U("p_perceive", "P", "run-play.mjs", "perceive", ["perceptual", "epistemic"], [],
    "perception honesty: report only what FOV allows",
    // score = the honesty verdict the scenario already computed (saw the visible count AND did not
    // hallucinate hidden entities); sCorrect/score kept as fallbacks for any future row shape.
    { match: (r, c) => c === "P" && /perceive/.test(r.scenario ?? r.slice ?? ""), success: (r) => sBool("honest")(r) ?? sCorrect(r) ?? sFrac("score")(r) }),
  U("p_survive", "P", "run-play.mjs", "survive", ["physical"], ["temporal", "perceptual"],
    "single-round survival, legal vs xray",
    { match: (r, c) => c === "P" && /survive/.test(r.scenario ?? r.slice ?? ""), success: (r) => sBool("alive")(r) }),

  // Category E — embodied. Combat wave ladder, obstacle traversal, multi-objective missions.
  U("e_combat", "E", "run-combat.mjs", "4", ["physical", "temporal"], ["quantitative", "perceptual"],
    "combat wave ladder r1–r4 (skill×cost curve)",
    { match: (r, c) => c === "E" && /combat|p-survive-wave/.test(r.scenario ?? ""), success: (r) => sBool("cleared")(r) ?? sBool("alive")(r) }),
  ...[["flat straight", 1], ["1-wide gap", 2], ["wall + doorway", 3], ["water crossing", 4], ["S-maze", 5]].map(([course, tier]) =>
    U(`e_traverse_t${tier}`, "E", "run-traverse.mjs", String(tier), ["spatial", "physical"], ["epistemic"],
      `traverse tier ${tier}: ${course}`,
      { match: (r, c) => c === "E" && r.scenario === "e-traverse" && r.tier === tier, success: sBool("arrived") })),
  // E-repair — the failure-path ladder (bench 0.9.3, FREEZE_PLAN F1): every rung REQUIRES work,
  // so the goal-vs-hand A/B prices the remedial-turn loop itself. iron_control is a DIAGNOSIS
  // rung (no arm can pull the lever — bot_use is item-centric): success = naming the control.
  ...[["plug_break", ["physical", "spatial"]], ["bridge_gap", ["physical", "spatial"]],
      ["door_shut", ["physical", "spatial"]], ["budget_resume", ["physical", "temporal"]]].map(([key, disc]) =>
    U(`e_repair_${key}`, "E", "run-repair.mjs", key, disc, ["epistemic"],
      `repair rung: ${key} (work required; goal repairs server-side, hand repairs by hand)`,
      { match: (r, c) => c === "E" && r.scenario === "e-repair" && r.course === key, success: sBool("arrived") })),
  U("e_repair_control", "E", "run-repair.mjs", "iron_control", ["epistemic", "causal"], ["physical"],
    "repair rung: iron door + lever — success is NAMING the control from the obstruction locus",
    { match: (r, c) => c === "E" && r.scenario === "e-repair" && r.course === "iron_control",
      success: sBool("named_control") }),
  U("e_survive_build", "E", "run-objectives.mjs", "survive", ["physical", "quantitative"], ["spatial"],
    "gather from quarry, bridge the gap", {
      match: (r, c) => c === "E" && (r.family === "survive" || r.scenario === "e-survive-build"),
      // silhouette coverage of the gap footprint, recorded as `coverage` (== silhouette_iou);
      // silhouette_iou/fidelity kept as fallbacks for older/other row shapes.
      success: (r) => sFrac("coverage")(r) ?? sFrac("silhouette_iou")(r) ?? sFrac("fidelity")(r),
    }),
  U("e_milestone", "E", "run-objectives.mjs", "ladder", ["temporal", "quantitative"], ["physical"],
    "gather → build → fight, in order", {
      match: (r, c) => c === "E" && (r.family === "ladder" || r.scenario === "e-milestone"),
      success: (r) => (typeof r.deepest === "number" && typeof r.total === "number" && r.total > 0 ? r.deepest / r.total : null),
    }),
  U("e_dungeon", "E", "run-objectives.mjs", "dungeon", ["spatial", "temporal", "physical"], ["quantitative"],
    "vault → treasure → guard → exit capstone", {
      match: (r, c) => c === "E" && (r.family === "dungeon" || r.scenario === "e-dungeon"),
      success: (r) => (typeof r.deepest === "number" && typeof r.total === "number" && r.total > 0 ? r.deepest / r.total : null),
    }),

  // Category Z — redstone logic (world-edit builds a circuit; truth-table driven).
  ...["NOT", "OR", "AND", "XOR"].map((g) =>
    U(`z_gate_${g.toLowerCase()}`, "Z", "run-redstone.mjs", g, ["causal", "relational"], ["physical", "spatial"],
      `build a ${g} circuit to a driven truth table`,
      { match: (r, c) => c === "Z" && r.gate === g && !/diagnose/.test(r.scenario ?? ""), success: sFrac("accuracy") })),

  // Category Z, diagnose slice — READ an existing circuit (the inverse of the build direction).
  U("z_diag_wiring", "Z", "run-diagnose.mjs", "wiring", ["relational"], ["causal", "spatial"],
    "which input controls the lamp (dead-end decoy)",
    { match: (r, c) => c === "Z" && r.kind === "wiring" }),
  U("z_diag_fault", "Z", "run-diagnose.mjs", "fault", ["causal"], ["relational", "perceptual"],
    "locate the one break in the line (repair-verified)",
    { match: (r, c) => c === "Z" && r.kind === "fault" }),
  U("z_diag_whatif", "Z", "run-diagnose.mjs", "whatif", ["counterfactual", "causal"], ["relational"],
    "would the lamp survive removing this wire (intervention-verified)",
    { match: (r, c) => c === "Z" && r.kind === "whatif" }),

  // Category R — mental rotation / rigid-transform VQA (offline, no server).
  U("r_rotate", "R", "run-rotate.mjs", null, ["spatial"], ["counterfactual"],
    "grid transform prediction (rotate/mirror/compose)",
    { match: (r, c) => c === "R" }),

  // Category W — world-edit building against a code-defined target (auto-diffed).
  U("w_schematic", "W", "run-wbuild.mjs", "schematic", ["spatial", "semantic"], ["quantitative"],
    "build from glyph-slice spec", { match: (r, c) => c === "W" && r.mode === "schematic", success: sFrac("fidelity") }),
  U("w_repair", "W", "run-wbuild.mjs", "repair", ["perceptual", "spatial"], ["semantic", "quantitative"],
    "find and fix injected deviations", { match: (r, c) => c === "W" && r.mode === "repair", success: sFrac("fidelity") }),
];

// ---- selection ------------------------------------------------------------------------------
/** Resolve a selection to units. Axes compose as AND; each axis is an OR over its values. */
export function selectUnits({ cats, disciplines, ids, anyDiscipline } = {}) {
  const catSet = cats && new Set(cats.map((c) => c.toUpperCase()));
  const dSet = disciplines && new Set(disciplines);
  const idSet = ids && new Set(ids);
  if (dSet) assertDisciplines([...dSet], "--discipline");
  return UNITS.filter((u) => {
    if (catSet && !catSet.has(u.cat)) return false;
    if (idSet && !idSet.has(u.id)) return false;
    if (dSet) {
      const tags = anyDiscipline ? [...u.disciplines, ...u.also] : u.disciplines;
      if (!tags.some((t) => dSet.has(t))) return false;
    }
    return true;
  });
}

/** Group selected units into per-runner invocations. ablation: "none" | "std" | "loo". */
export function planRunners(units, { ablation = "none" } = {}) {
  const byRunner = new Map();
  for (const u of units) {
    if (!byRunner.has(u.runner)) byRunner.set(u.runner, []);
    byRunner.get(u.runner).push(u);
  }
  const plans = [];
  for (const [runner, us] of byRunner) {
    const spec = RUNNERS[runner];
    const args = [];
    if (spec.selKey) {
      const vals = [...new Set(us.map((u) => u.sel).filter(Boolean))];
      const value = spec.selType === "max" ? String(Math.max(...vals.map(Number))) : vals.join(",");
      args.push(`--${spec.selKey}`, value);
    }
    if (spec.arms) {
      if (ablation === "std") args.push(`--${spec.arms.flag}`, spec.arms.std);
      else args.push(`--${spec.arms.flag}`, spec.arms.full);
    }
    if (ablation === "loo" && spec.loo) args.push("--loo");
    plans.push({ runner, units: us, args });
  }
  return plans;
}
