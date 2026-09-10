// Pure logic-gate truth-table core for Category Z (redstone/logic puzzle). Server-free and fully
// unit-testable (redstone-score.test.mjs). The harness stages a circuit slot with N input levers and
// one output lamp, drives every input combination, and reads the lamp's lit state per combo; THIS
// module defines the target functions, enumerates the combos in a fixed order, and scores the
// observed outputs against the target — no dev server, no model spend to validate.

/** Standard gate functions over a boolean input array. */
export const GATES = {
  NOT:      (i) => !i[0],
  AND:      (i) => i.every(Boolean),
  OR:       (i) => i.some(Boolean),
  NAND:     (i) => !i.every(Boolean),
  NOR:      (i) => !i.some(Boolean),
  XOR:      (i) => i.filter(Boolean).length % 2 === 1,
  XNOR:     (i) => i.filter(Boolean).length % 2 === 0,
  MAJORITY: (i) => i.filter(Boolean).length * 2 > i.length,
};

/** How many inputs each gate is defined for (NOT is unary; the rest default to 2 but scale). */
export function defaultInputs(gate) { return gate === "NOT" ? 1 : gate === "MAJORITY" ? 3 : 2; }

/** Enumerate all 2^n input combinations in ascending binary order (LSB = input 0). Deterministic. */
export function enumerateInputs(n) {
  const rows = [];
  for (let m = 0; m < (1 << n); m++) {
    rows.push(Array.from({ length: n }, (_, b) => Boolean((m >> b) & 1)));
  }
  return rows;
}

/** The target truth table for a gate: [{inputs:[bool...], out:bool}], in enumerateInputs order. */
export function expectedTable(gate, nIn = defaultInputs(gate)) {
  const fn = GATES[gate];
  if (!fn) throw new Error(`unknown gate ${gate}`);
  return enumerateInputs(nIn).map((inputs) => ({ inputs, out: fn(inputs) }));
}

/**
 * Score observed outputs (array of bool, one per combo in enumerateInputs order) against a gate's
 * target table. Returns per-row detail + accuracy + exact. `observed` shorter/longer than the table,
 * or holding non-bool (e.g. null from an unread lamp), scores those rows wrong rather than throwing.
 */
export function scoreObserved(gate, nIn, observed) {
  const table = expectedTable(gate, nIn);
  const rows = table.map((t, i) => {
    const obs = observed?.[i];
    const ok = typeof obs === "boolean" && obs === t.out;
    return { inputs: t.inputs, expected: t.out, observed: obs ?? null, ok };
  });
  const correct = rows.filter((r) => r.ok).length;
  return {
    gate, n_in: nIn, rows_total: rows.length, rows_correct: correct,
    accuracy: rows.length ? Math.round((correct / rows.length) * 1000) / 1000 : 0,
    exact: correct === rows.length, rows,
  };
}
