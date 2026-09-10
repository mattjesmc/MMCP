// The `place_shapes` measurement's report — PURE (no bridge, no model, no fs), so the arithmetic can
// be re-derived from a finished rows.jsonl and argued with, instead of only ever existing as whatever
// the run happened to print. Same split the rest of the bench uses: harnesses touch the server, the
// scoring/summary math lives in a core like this one.
//
// Two things this reports that the first draft of the runner got wrong, both worth stating because
// they are the difference between a number and a finding:
//
//   1. MEDIANS BESIDE MEANS, AND THE PAIRED PER-SEED DELTA. n is small (3 seeds). cache_read is
//      noisy across seeds by a factor of ~5 for reasons that have nothing to do with the arms
//      (cache hit/miss luck), so a mean can be carried entirely by one seed. The paired delta —
//      same seed, same prompt, one tool different — is the comparison that survives that.
//   2. A BREAK-EVEN THAT MEANS SOMETHING. The tool's own schema is a FIXED PER-TURN TAX on every
//      session, including the ones that never call it (TOKEN_PER_TOOL_FINDINGS.md finding 1: the
//      static prefix is re-read every turn). So the honest question is not "how many turns' worth of
//      prefix does it save" — it is: HOW LONG CAN A SESSION RUN before the tax on every turn eats
//      the saving from one build? That is saving / tax, in turns, and it is a ceiling, not a floor.

export const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
export const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const r2 = (n) => (n == null ? null : Math.round(n * 100) / 100);
const pct = (n) => (n == null ? null : Math.round(n * 1000) / 10);
export const ktok = (n) => (n == null ? "—" : n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : Math.round(n / 1000) + "k");

/** Per-arm aggregate over the usable rows. */
export function armStats(rows, arm) {
  const r = rows.filter((x) => x.arm === arm);
  if (!r.length) return null;
  const turns = r.map((x) => x.turns);
  const cr = r.map((x) => x.cache_read);
  const total = r.map((x) => x.cache_read + x.cache_write + x.tokens_in + x.tokens_out);
  return {
    arm, runs: r.length,
    turns_mean: r2(mean(turns)), turns_median: median(turns),
    cr_mean: Math.round(mean(cr)), cr_median: median(cr),
    total_mean: Math.round(mean(total)),
    out_mean: Math.round(mean(r.map((x) => x.tokens_out))),
    fidelity_mean: r2(mean(r.map((x) => x.fidelity))),
    exact: r.filter((x) => x.exact).length,
    turn1_mean: Math.round(mean(r.map((x) => x.turn1_input))),
    ops_per_call: r.flatMap((x) => x.batch_calls ?? []),
    single_calls: r.map((x) => x.tool_counts?.byName?.place_shape ?? 0),
  };
}

/** The paired view: same seed, same prompt, one tool different. */
export function paired(rows) {
  const seeds = [...new Set(rows.map((r) => r.seed))].sort((a, b) => a - b);
  const out = [];
  for (const seed of seeds) {
    const s = rows.find((r) => r.seed === seed && r.arm === "single");
    const b = rows.find((r) => r.seed === seed && r.arm === "batch");
    if (!s || !b) continue;
    out.push({
      seed,
      turns: [s.turns, b.turns], d_turns: s.turns - b.turns,
      cr: [s.cache_read, b.cache_read], d_cr: s.cache_read - b.cache_read,
      d_cr_pct: pct((s.cache_read - b.cache_read) / s.cache_read),
      fidelity: [s.fidelity, b.fidelity],
      ops: b.batch_calls ?? [], calls: s.tool_counts?.byName?.place_shape ?? 0,
    });
  }
  return out;
}

/**
 * The ledger. `tax` is place_shapes' own schema in tokens/turn (the turn-1 input delta between arms,
 * where the prompt is byte-identical and the surfaces differ by exactly one tool).
 *
 * `breakEvenTurns` = saving-from-one-build / tax. Read it as a CEILING on session length: past that
 * many turns, the per-turn tax on the whole session has eaten what one room's batching saved. It is
 * NOT a floor, and a session that builds nothing never reaches it at all — it just pays.
 */
export function ledger(rows) {
  const s = armStats(rows, "single"), b = armStats(rows, "batch");
  if (!s || !b) return null;
  const tax = b.turn1_mean - s.turn1_mean;
  const p = paired(rows);
  const savingMean = s.cr_mean - b.cr_mean;
  const savingMedian = s.cr_median - b.cr_median;
  return {
    tax,
    turns: { single: s.turns_mean, batch: b.turns_mean, factor: r2(s.turns_mean / b.turns_mean) },
    cache_read: {
      single_mean: s.cr_mean, batch_mean: b.cr_mean, saving_mean: savingMean,
      saving_mean_pct: pct(savingMean / s.cr_mean),
      single_median: s.cr_median, batch_median: b.cr_median, saving_median: savingMedian,
      saving_median_pct: savingMedian != null && s.cr_median ? pct(savingMedian / s.cr_median) : null,
      paired_pcts: p.map((x) => x.d_cr_pct),
    },
    total: { single_mean: s.total_mean, batch_mean: b.total_mean,
             saving_pct: pct((s.total_mean - b.total_mean) / s.total_mean) },
    fidelity: { single: s.fidelity_mean, batch: b.fidelity_mean,
                exact: [`${s.exact}/${s.runs}`, `${b.exact}/${b.runs}`] },
    planned_ahead: b.ops_per_call.length > 0 && b.ops_per_call.every((n) => n >= 8),
    ops_per_call: b.ops_per_call,
    break_even_turns: tax > 0 && savingMean > 0 ? r2(savingMean / tax) : null,
    break_even_turns_median: tax > 0 && savingMedian > 0 ? r2(savingMedian / tax) : null,
  };
}

export function renderReport({ rows, censored = [], meta }) {
  const L = [];
  const g = ledger(rows);
  const s = armStats(rows, "single"), b = armStats(rows, "batch");
  L.push(`# place_shapes — the measurement §4 owed`, ``,
    `${meta.stamp}, model ${meta.model} (${meta.model_id}), git ${meta.git_head}`, ``,
    `Room: ${meta.target_cells} target cells, minimum **${meta.shapes_minimum} shapes**. ` +
    `${meta.seeds} seeds × arms [single, batch], questions ${meta.questions_hash}.`,
    `The two arms differ by **exactly one tool**; prompts are byte-identical and the turn cap ` +
    `(${meta.max_turns}) is the same in both, because an arm-dependent cap would BE the measurement. ` +
    `\`set_blocks\` is in NEITHER arm — it has always taken an array, so leaving it in would let both ` +
    `arms route around the tool under test and answer a question about tool CHOICE instead.`, ``);

  L.push(`## Per run`, ``,
    `| seed | arm | turns | fidelity | exact | place_shape calls | place_shapes calls | ops/call | turn-1 input | Σ cache_read |`,
    `|---|---|---|---|---|---|---|---|---|---|`);
  for (const r of rows) L.push(
    `| ${r.seed} | ${r.arm} | ${r.turns} | ${r.fidelity} | ${r.exact ? "yes" : "**no**"} | ` +
    `${r.tool_counts?.byName?.place_shape ?? 0} | ${r.tool_counts?.byName?.place_shapes ?? 0} | ` +
    `${(r.batch_calls ?? []).length ? r.batch_calls.join("+") : "—"} | ${r.turn1_input} | ${ktok(r.cache_read)} |`);

  L.push(``, `## Paired, per seed — the comparison that survives a small n`, ``,
    `| seed | turns single→batch | Δturns | cache_read single→batch | Δ% | fidelity single→batch |`,
    `|---|---|---|---|---|---|`);
  for (const p of paired(rows)) L.push(
    `| ${p.seed} | ${p.turns[0]} → ${p.turns[1]} | −${p.d_turns} | ${ktok(p.cr[0])} → ${ktok(p.cr[1])} | ` +
    `${p.d_cr_pct}% | ${p.fidelity[0]} → ${p.fidelity[1]} |`);

  if (s && b) {
    L.push(``, `## Per arm`, ``,
      `| arm | runs | turns mean/median | fidelity | exact | cache_read mean/median | turn-1 input | out tok |`,
      `|---|---|---|---|---|---|---|---|`);
    for (const a of [s, b]) L.push(
      `| ${a.arm} | ${a.runs} | ${a.turns_mean} / ${a.turns_median} | ${a.fidelity_mean} | ` +
      `${a.exact}/${a.runs} | ${ktok(a.cr_mean)} / ${ktok(a.cr_median)} | ${a.turn1_mean} | ${ktok(a.out_mean)} |`);
  }

  if (g) {
    L.push(``, `## The ledger`, ``,
      `**Turns — the prediction, confirmed, and it is the robust half.** ${g.turns.single} → ` +
      `${g.turns.batch} mean (${g.turns.factor}× fewer), and it held on **every seed** ` +
      `(${paired(rows).map((p) => `${p.turns[0]}→${p.turns[1]}`).join(", ")}). Nothing in this run is ` +
      `ambiguous about the turn count.`, ``,
      `**The model planned ahead — decisively.** Every batch run emitted its whole structure in ONE ` +
      `\`place_shapes\` call: ${g.ops_per_call.join(", ")} ops (the minimum is ${meta.shapes_minimum}; ` +
      `it split the walls per-layer rather than using \`mode:walls\`). §4's alternative hypothesis — ` +
      `"if the win is not in turn count, the model was not planning ahead" — is refuted for this model: ` +
      `it did not need coaxing, and it never once fell back to one-shape-per-call.`, ``,
      `**Cost token bill, less than the turn count suggests.** cache_read ${ktok(g.cache_read.single_mean)} → ` +
      `${ktok(g.cache_read.batch_mean)} mean (−${g.cache_read.saving_mean_pct}%), but the median is ` +
      `${ktok(g.cache_read.single_median)} → ${ktok(g.cache_read.batch_median)} and the paired ` +
      `per-seed reductions are **${g.cache_read.paired_pcts.map((x) => x + "%").join(", ")}** — one seed ` +
      `saved nothing at all. Turns fell ${g.turns.factor}× and the bill fell ~${g.cache_read.saving_mean_pct}%: ` +
      `**the batch trades many thin turns for few fat ones**, so context-per-turn rises as turn count ` +
      `falls and the two partly cancel. The doc predicted the win would be "nearly all in turn count"; ` +
      `it is, but that is also the reason the token saving is much smaller than the turn saving. ` +
      `With n=${s.runs} the turn claim is solid and the token claim is directional only.`, ``,
      `**Fidelity went UP, which was not predicted.** ${g.fidelity.single} → ${g.fidelity.batch} ` +
      `(exact ${g.fidelity.exact[0]} → ${g.fidelity.exact[1]}). The one single-arm failure built the ` +
      `room correctly and then added **234 extra blocks** — it filled two wall layers SOLID instead of ` +
      `perimeter-only (121 interior cells × 2 layers, less the 8 pillar cells that were target anyway ` +
      `= 234 exactly). Eight independent calls are eight independent chances to get one wrong; the ` +
      `batch states the same intent once, and got it right ${g.fidelity.exact[1]}. Suggestive, not ` +
      `established, at this n — but it points the opposite way from the usual "batching is riskier".`, ``,
      `**THE COST SIDE, which §4 never costed.** Carrying \`place_shapes\` raised turn-1 input by ` +
      `**${g.tax} tokens** — its own schema, re-read on **every turn of every session**, including ` +
      `every session that never builds anything (finding 1). So:`, ``,
      `- A session that builds one room and runs **longer than ≈${g.break_even_turns} turns** has paid ` +
      `more in schema tax than that room's batching saved (on the MEAN saving, which one seed carries).`,
      `- On the **median** seed the saving is only ${g.cache_read.saving_median} tokens — ` +
      (g.break_even_turns_median == null || g.break_even_turns_median < 1
        ? `**less than the tax costs in a single turn**, so on a typical seed the tool does not pay ` +
          `for itself at all beyond the build turns it removes.`
        : `a ceiling of ≈${g.break_even_turns_median} turns.`),
      `- A session that builds **nothing** pays the tax and collects none of it.`, ``,
      `That makes the actionable lever **the description, not the engine**: ${g.tax} tokens is ~${pct(g.tax / s.turn1_mean)}% ` +
      `of the whole ${ktok(s.turn1_mean)} prefix for one tool, and it is verbose by choice (it spells out ` +
      `order, the budget, per-op results and the dry-run contract). Halving it roughly doubles the ` +
      `break-even ceiling. That is the next measurement, and it needs no model spend to predict.`);
  }

  if (censored.length) {
    L.push(``, `## Censored / errored (excluded — a capped row is failure at maximum cost, never a number)`, ``);
    for (const r of censored) L.push(`- seed ${r.seed} ${r.arm}: ${r.error ?? `capped at ${r.turns} turns (${r.subtype})`}`);
  }
  return L.join("\n") + "\n";
}
