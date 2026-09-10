// Pure sequential-progress core — the auto-scoring shared by the milestone ladder (build home →
// gather diamonds → …) and the dungeon capstone (checkpoint chain: reach room → open gate → loot →
// exit). Server-free and unit-testable (progress-score.test.mjs). The harnesses evaluate each
// step/checkpoint's predicate against server truth (inventory-has, structure-exists, entity-dead,
// body-in-region) and hand the resulting booleans here; ALL the progression + cost math is here.

/**
 * Aggregate an ordered list of steps. Each step: {key, done:boolean, [tokens], [turns]}.
 * The bench's headline is not "how many done" but "how FAR" — the deepest prefix reached before the
 * first gap (a later step done after an earlier gap is a lucky skip, not progress), plus totals and
 * where it stalled.
 */
export function sequentialProgress(steps) {
  const total = steps.length;
  const done = steps.filter((s) => s.done).length;
  let deepest = 0;
  while (deepest < total && steps[deepest]?.done) deepest++;   // consecutive from start
  const stalledAt = deepest < total ? deepest : null;          // index of first unmet step, or null if all met
  return {
    total, done, deepest,
    stalled_at: stalledAt,
    stalled_key: stalledAt != null ? (steps[stalledAt]?.key ?? null) : null,
    completed_all: deepest === total,
    skipped: done - deepest,                                    // steps met out of order (past the first gap)
  };
}

/** Tokens/turns spent per milestone actually reached (deepest), for the skill×cost curve. Uses
 *  deepest (earned progress), not done, so lucky skips don't flatter the efficiency number. */
export function costPerMilestone(steps) {
  const p = sequentialProgress(steps);
  const tokens = steps.reduce((a, s) => a + (s.tokens ?? 0), 0);
  const turns = steps.reduce((a, s) => a + (s.turns ?? 0), 0);
  return {
    deepest: p.deepest,
    tokens_total: tokens, turns_total: turns,
    tokens_per_milestone: p.deepest ? Math.round(tokens / p.deepest) : null,
    turns_per_milestone: p.deepest ? Math.round((turns / p.deepest) * 10) / 10 : null,
  };
}
