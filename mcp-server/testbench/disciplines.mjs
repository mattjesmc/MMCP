// The world-understanding discipline taxonomy — the SECOND axis of the bench (the first is the
// tool/mechanism axis in coverage-report.mjs). A discipline is a kind of understanding a task can
// demand; every bench unit in registry.mjs declares which disciplines it makes LOAD-BEARING (the
// unit fails without that skill) and which it merely touches. Selection (run-bench.mjs --discipline)
// and reporting (bench-report.mjs --by discipline) both key off these ids, so the taxonomy is the
// contract: add a discipline here and the whole harness picks it up.
//
// `gauge` = what the discipline measures; `example` = the canonical Minecraft-flavoured probe.

export const DISCIPLINES = {
  perceptual: {
    label: "Perceptual / observational",
    gauge: "extracting facts from incomplete, noisy, occluded, or summarized observations",
    example: "recognize a hostile from partial sight; read a fact out of a summarized envelope",
  },
  spatial: {
    label: "Spatial",
    gauge: "position, direction, geometry, topology, distance, containment",
    example: "compass bearings between landmarks; egocentric left/right; whether two spaces connect",
  },
  semantic: {
    label: "Semantic",
    gauge: "entity identity, category, properties, purpose",
    example: "blast furnace vs furnace; which block in a machine room is the container being fed",
  },
  relational: {
    label: "Relational",
    gauge: "connections between entities",
    example: "which input feeds the lamp; hopper feeds furnace which outputs into a chest",
  },
  quantitative: {
    label: "Quantitative",
    gauge: "counts, measurements, ratios, thresholds, capacities",
    example: "count intruding blocks; min/max surface height; is 23 iron enough",
  },
  temporal: {
    label: "Temporal",
    gauge: "order, duration, periodicity, recency, state transitions",
    example: "has the region changed since the last observation; complete objectives in order",
  },
  causal: {
    label: "Causal",
    gauge: "mechanisms, dependencies, interventions",
    example: "why doesn't the lamp light; would removing this torch break the circuit",
  },
  physical: {
    label: "Physical / dynamical",
    gauge: "movement, collision, gravity, fluids, projectiles, redstone timing",
    example: "is the jump reachable; wade the flooded span; survive the melee",
  },
  epistemic: {
    label: "Epistemic",
    gauge: "knowledge, uncertainty, evidence, source reliability",
    example: "don't report the mob you couldn't see; distinguish remembered from verified",
  },
  counterfactual: {
    label: "Counterfactual",
    gauge: "reasoning about alternative worlds or actions",
    example: "which of three sites needs least cut+fill; where does the marker land after rotation",
  },
};

export const DISCIPLINE_ORDER = Object.keys(DISCIPLINES);

/** Validate a discipline id list (registry self-check — a typo must throw, not silently untag). */
export function assertDisciplines(ids, where) {
  for (const d of ids ?? []) {
    if (!DISCIPLINES[d]) throw new Error(`${where}: unknown discipline "${d}" (known: ${DISCIPLINE_ORDER.join(", ")})`);
  }
  return ids ?? [];
}
