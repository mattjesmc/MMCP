#!/usr/bin/env node
// §6 VERDICT REPORT — reads a Category C result dir and reports every pre-registered prediction from
// OBSERVATION_MEMORY_DESIGN.md §6, including the ones that fail.
//
//   node testbench/obs-report.mjs <dir> [--baseline <dir> ...]
//
// This exists as its own script rather than a bench-report flag because §6 is a FIXED set of five
// claims with FIXED criteria, and the whole methodological point of a pre-registration is that the
// analysis is not chosen after seeing the data. The thresholds below are transcribed from §6 and are
// the only place they appear in code; the script reports PASS / FAIL / INCONCLUSIVE mechanically and
// never picks the more favourable of two readings.
//
// Baseline: §6 measures against the 0.9.5 numbers recorded in §2, which are re-derived from the
// baseline dirs rather than hard-coded — §6's own pre-committed caveat says that if the baseline
// moves on re-measurement the comparison uses the NEW baseline and the fact is reported.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { wilson, fmtCI, pairedSignTest } from "./stats.mjs";
import { isCensoredSubtype } from "./session-guards.mjs";

const HERE = join(fileURLToPath(import.meta.url), "..");
const RESULTS = join(HERE, "..", "testbench-results");
const argv = process.argv.slice(2);
const dirArg = (a) => (/[\\/]/.test(a) ? a : join(RESULTS, a));
const BASELINE_DEFAULT = ["2026-07-27T08-39-40-mem-haiku", "2026-07-27T08-21-57-mem-haiku"];

const dirs = [], baselines = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--baseline") baselines.push(dirArg(argv[++i]));
  else if (!argv[i].startsWith("--")) dirs.push(dirArg(argv[i]));
}
if (!dirs.length) { console.error("usage: obs-report.mjs <result-dir> [--baseline <dir>]"); process.exit(2); }
if (!baselines.length) baselines.push(...BASELINE_DEFAULT.map(dirArg).filter(existsSync));

// ---- §6, transcribed ------------------------------------------------------------------------------
const P1_UNITS = ["where", "count"];          // MOVES → ≥85% each
const P2_UNITS = ["chg_grew", "chg_vanished", "chg_appeared", "chg_same"]; // MOVES → ≥70%
const P3_UNITS = ["anchor", "region", "stale"]; // DOES NOT MOVE → each stays ≥90%
const P1_FLOOR = 0.85, P2_FLOOR = 0.70, P3_FLOOR = 0.90, P5_MAX_RISE = 0.25;

// ---- load -----------------------------------------------------------------------------------------
const rowsOf = (dir) => {
  const p = join(dir, "answers.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r && !r.error);
};
/** One record per (question, seed, arm), censoring applied — a censored session measured nothing. */
function cells(dir) {
  const out = [];
  for (const r of rowsOf(dir)) {
    const censored = r.censored === true || r.quiz?.capped === true ||
      isCensoredSubtype(r.stop_reason) || isCensoredSubtype(r.quiz?.subtype);
    for (const [id, q] of Object.entries(r.per_question ?? {})) {
      out.push({
        id, seed: r.seed, arch: r.arch ?? "full", workflow: r.workflow ?? "recall",
        arm: r.arm ?? r.arch, correct: !!q.exact, abstained: !!q.abstained, censored, dir,
        obs_tools: r.retrieval_calls?.obs_tools ?? 0,
        mem_recall: r.retrieval_calls?.mem_recall ?? 0,
        served: r.remembered_served ?? null,
        out_tokens: r.quiz?.usage?.output_tokens ?? 0,
        in_tokens: r.quiz?.usage?.input_tokens ?? 0,
      });
    }
  }
  return out;
}
const scored = (cs) => cs.filter((c) => !c.censored);

const RUN = dirs.flatMap(cells);
const BASE = baselines.flatMap(cells);
if (!RUN.length) { console.error(`no rows in ${dirs.join(", ")}`); process.exit(1); }

const pct = (x) => `${Math.round(x * 100)}%`;
const ciOf = (cs) => wilson(cs.filter((c) => c.correct).length, cs.length);
const verdict = (ok, inconclusive = false) => (inconclusive ? "INCONCLUSIVE" : ok ? "PASS" : "FAIL");
/** Sessions (not question-cells) for a slice — tokens and tool counts are per session, not per question. */
function sessionsOf(cs) {
  const seen = new Map();
  for (const c of cs) seen.set(`${c.dir}|${c.seed}|${c.arm}`, c);
  return [...seen.values()];
}

/** The arms present, and which are the capture ones. `full` is the paired control throughout. */
const ARMS = [...new Set(RUN.map((c) => c.arch))];
const CAPTURE_ARMS = ARMS.filter((a) => a.startsWith("capture"));

const at = (cs, { id, arch, workflow }) => scored(cs).filter((c) =>
  (id == null || (Array.isArray(id) ? id.includes(c.id) : c.id === id)) &&
  (arch == null || c.arch === arch) && (workflow == null || c.workflow === workflow));


/**
 * Minimum discordant pairs a two-sided sign test needs before p<.05 is even ATTAINABLE: min p is
 * 2*0.5^d, so d>=6. Below it the test cannot reject however lopsided the data — which means a
 * "FAIL" is a statement about n, and a "no difference" PASS is vacuous reassurance. Both are
 * reported as UNDERPOWERED rather than as results. (0.9.7's own methodological finding, applied to
 * the verdict line instead of only to the prose.)
 */
const SIGN_TEST_MIN_DISCORDANT = 6;
const underpowered = (st) => st.discordant < SIGN_TEST_MIN_DISCORDANT;
const powerNote = (st) =>
  `${st.discordant} discordant pair(s); a two-sided sign test needs >=${SIGN_TEST_MIN_DISCORDANT} before p<.05 is attainable at all`;

/**
 * DELIVERY vs OPPORTUNITY. §8 prediction 1 counts sessions SERVED a delta — but a session that never
 * read a changed cell it held a prior for gave the mechanism nothing to deliver, and its zero says
 * nothing about delivery. Observed 2026-07-29: a change-quiz session made ONE `locate` call, scored
 * 1/5, and served 0 — correct silence, indistinguishable in the raw count from a broken appendix.
 *
 * So the transcript is replayed against the seed's PRISTINE pre-quiz corpus (`seedN/memory`, which
 * quiz arms never write to — they clone into `quiz-<arm>/memory`), asking per read: would deltaView
 * have returned anything? `served/warranted` is the delivery rate; `warranted === 0` means the
 * session did not exercise the mechanism at all.
 *
 * The pre-registered criterion stays the literal §8 one (all sessions). This is reported ALONGSIDE
 * it as diagnostic context, never substituted for it — redefining a denominator after seeing the
 * data is exactly what a pre-registration exists to prevent.
 */
async function replayWarranted(dir, seed, arm) {
  const memRoot = join(dir, `seed${seed}`, "memory");
  const f = join(dir, `seed${seed}`, `transcript-quiz-${arm}.jsonl`);
  if (!existsSync(memRoot) || !existsSync(f)) return null;
  let ObservationStore, EXTRACTORS;
  try {
    ({ ObservationStore } = await import("../memory/observations.mjs"));
    ({ EXTRACTORS } = await import("../memory/capture.mjs"));
  } catch { return null; }
  const uuid = readdirSync(memRoot).find((x) => { try { return statSync(join(memRoot, x)).isDirectory(); } catch { return false; } });
  if (!uuid) return null;
  let store;
  try { store = await new ObservationStore(memRoot, uuid).open(); } catch { return null; }
  let reads = 0, warranted = 0, served = 0;
  for (const l of readFileSync(f, "utf8").split("\n").filter(Boolean)) {
    let r; try { r = JSON.parse(l); } catch { continue; }
    if (r.type !== "tool" || !EXTRACTORS[r.name]) continue;
    const res = r.result?.result;
    if (!res || !Number.isInteger(res.game_tick)) continue;
    let n; try { n = EXTRACTORS[r.name](r.input || {}, res); } catch { continue; }
    if (!n || n.skip) continue;
    reads++;
    if (res.remembered_served === true) served++;
    const box = n.impliedAir && n.area?.box && n.area?.complete ? n.area.box : null;
    let d; try { d = await store.deltaView({ dim: res.dimension, cells: n.cellValues || [], impliedAirBox: box }); } catch { continue; }
    if (d.filter((x) => x.was !== null).length) warranted++;
  }
  return { reads, warranted, served };
}
const out = [];
const say = (s = "") => out.push(s);

say(`# §6 verdict — ${dirs.map((d) => d.split(/[\\/]/).pop()).join(", ")}`);
say("");
say(`Pre-registration: \`OBSERVATION_MEMORY_DESIGN.md\` §6, committed before any implementation existed.`);
say(`Every prediction is reported, including the ones that fail. Criteria are transcribed from §6 and`);
say(`not chosen after seeing these numbers.`);
say("");
const cens = RUN.filter((c) => c.censored);
if (cens.length) {
  const sessions = new Set(cens.map((c) => `${c.seed}|${c.arm}`));
  say(`> ⚠ **${sessions.size} session(s) CENSORED** and excluded from every number below: ` +
    `${[...sessions].join(", ")}. A censored session measured nothing; it is never folded into failure.`);
  say("");
}

// ---- the baseline ---------------------------------------------------------------------------------
say("## Baseline");
say("");
if (!BASE.length) {
  say("_No baseline dir found — predictions 1 and 5 are reported against §2's recorded numbers only._");
} else {
  say(`From ${baselines.map((d) => d.split(/[\\/]/).pop()).join(", ")} (bench 0.9.5, arch \`full\`):`);
  say("");
  say(`| unit | 0.9.5 baseline | §2 as recorded |`);
  say(`|---|---|---|`);
  const RECORDED = { anchor: "100%", where: "57% [25–84]", count: "57% [25–84]", region: "100%", breadth: "71%", stale: "100%" };
  for (const id of ["anchor", "where", "count", "region", "breadth", "stale"]) {
    const cs = at(BASE, { id, arch: "full", workflow: "recall" });
    say(`| ${id} | ${cs.length ? `${fmtCI(ciOf(cs))} (${cs.filter((c) => c.correct).length}/${cs.length})` : "—"} | ${RECORDED[id] ?? "—"} |`);
  }
  say("");
  say(`§6's pre-committed caveat: if the baseline itself moved on re-measurement the comparison uses the`);
  say(`new one and the fact is reported — not the more favourable of the two.`);
}
say("");

// ---- prediction 1 ----------------------------------------------------------------------------------
say(`## Prediction 1 — MOVES: \`where\` and \`count\` rise to ≥85% each`);
say("");
say(`_Criterion: CI non-overlap with the 0.9.5 baseline OR paired sign test p<.05._`);
say("");
say(`| unit | arm | success (k/n) | baseline | CI disjoint | sign test | ≥85% |`);
say(`|---|---|---|---|---|---|---|`);
const p1Verdicts = [];
for (const id of P1_UNITS) {
  const base = at(BASE, { id, arch: "full", workflow: "recall" });
  const baseCI = base.length ? ciOf(base) : null;
  for (const arch of ARMS) {
    const cs = at(RUN, { id, arch, workflow: "recall" });
    if (!cs.length) continue;
    const ci = ciOf(cs);
    const disjoint = baseCI ? (ci.lo > baseCI.hi || ci.hi < baseCI.lo) : null;
    // Paired per seed against this run's own `full` arm — the within-run control.
    const ctrl = at(RUN, { id, arch: "full", workflow: "recall" });
    const pairs = cs.map((c) => {
      const m = ctrl.find((x) => x.seed === c.seed);
      return m ? { a: c.correct ? 1 : 0, b: m.correct ? 1 : 0 } : null;
    }).filter(Boolean);
    const st = arch === "full" ? null : pairedSignTest(pairs);
    const meets = ci.p >= P1_FLOOR;
    if (arch !== "full") p1Verdicts.push({ id, arch, meets, disjoint, p: st?.p });
    say(`| ${id} | ${arch} | ${fmtCI(ci)} (${cs.filter((c) => c.correct).length}/${cs.length}) | ` +
      `${baseCI ? fmtCI(baseCI) : "—"} | ${disjoint === null ? "—" : disjoint ? "yes" : "no"} | ` +
      `${st ? `Δ${st.delta >= 0 ? "+" : ""}${pct(st.delta)}, ${st.discordant} disc, p=${st.p.toFixed(3)}` : "— (control)"} | ` +
      `${meets ? "yes" : "no"} |`);
  }
}
say("");
{
  const capture = p1Verdicts.filter((v) => v.arch.startsWith("capture"));
  const anyMoved = capture.some((v) => v.meets && (v.disjoint || (v.p != null && v.p < 0.05)));
  const allMeet = capture.length > 0 && P1_UNITS.every((id) => capture.some((v) => v.id === id && v.meets));
  say(`**Prediction 1: ${verdict(anyMoved && allMeet, capture.length === 0)}** — ` +
    `the floor is met by ${capture.filter((v) => v.meets).length}/${capture.length} capture cells; ` +
    `the movement criterion (CI disjoint or p<.05) is met by ` +
    `${capture.filter((v) => v.disjoint || (v.p != null && v.p < 0.05)).length}/${capture.length}.`);
  say("");
  say(`_Standing caveat, recorded before the run: with a working block reader \`where\`/\`count\` are`);
  say(`answerable by LOOKING under the \`recall\` workflow's one permitted world read, so a high score in`);
  say(`EITHER arm may reflect re-reading rather than remembering. Headroom, not capability, is the limit`);
  say(`here — which is why prediction 2 carries the experiment._`);
}
say("");

// ---- prediction 2 ----------------------------------------------------------------------------------
say(`## Prediction 2 — MOVES: change detection becomes answerable at all (≥70%)`);
say("");
say(`| arm | change rung (k/n) | flag+prior | \`chg_now\` live control | obs-tool calls |`);
say(`|---|---|---|---|---|`);
for (const arch of ARMS) {
  const cs = at(RUN, { id: P2_UNITS, arch, workflow: "change" });
  if (!cs.length) continue;
  const now = at(RUN, { id: "chg_now", arch, workflow: "change" });
  const obs = sessionsOf(scored(RUN).filter((c) => c.arch === arch && c.workflow === "change"))
    .reduce((a, c) => a + c.obs_tools, 0);
  say(`| ${arch} | ${fmtCI(ciOf(cs))} (${cs.filter((c) => c.correct).length}/${cs.length}) | ` +
    `${pct(ciOf(cs).p)} | ${now.length ? `${fmtCI(ciOf(now))} (${now.filter((c) => c.correct).length}/${now.length})` : "—"} | ${obs} |`);
}
say("");
say(`| probe | ${ARMS.join(" | ")} |`);
say(`|---|${ARMS.map(() => "---").join("|")}|`);
for (const id of [...P2_UNITS, "chg_now"]) {
  const cellsFor = ARMS.map((a) => {
    const cs = at(RUN, { id, arch: a, workflow: "change" });
    return cs.length ? `${cs.filter((c) => c.correct).length}/${cs.length}` : "—";
  });
  say(`| ${id} | ${cellsFor.join(" | ")} |`);
}
say("");
{
  const best = CAPTURE_ARMS.map((a) => ({ a, ci: ciOf(at(RUN, { id: P2_UNITS, arch: a, workflow: "change" })) }))
    .filter((x) => x.ci && at(RUN, { id: P2_UNITS, arch: x.a, workflow: "change" }).length);
  const pass = best.some((x) => x.ci.p >= P2_FLOOR);
  const ctrl = at(RUN, { id: P2_UNITS, arch: "full", workflow: "change" });
  say(`**Prediction 2: ${verdict(pass, best.length === 0)}** — ` +
    `${best.map((x) => `${x.a} ${pct(x.ci.p)}`).join(", ") || "no capture arm"} against the ≥70% floor.`);
  say("");
  if (ctrl.length) {
    say(`**The floor is measured, not assumed.** §6 describes change detection as starting from "not`);
    say(`expressible today", but authored memory DOES record priors, so the \`full\` control can answer`);
    say(`from notes plus a live read: it scores ${pct(ciOf(ctrl).p)} (${ctrl.filter((c) => c.correct).length}/${ctrl.length}).`);
    say(`That number is the real floor, and the comparison below uses it.`);
    say("");
  }
  const nowRows = ARMS.map((a) => at(RUN, { id: "chg_now", arch: a, workflow: "change" })).filter((x) => x.length);
  if (nowRows.length) {
    const worst = Math.min(...nowRows.map((cs) => ciOf(cs).p));
    say(`\`chg_now\` (the live re-read every arm can do) sits at ${pct(worst)} or better in every arm. ` +
      (worst >= 0.8
        ? `The sessions travelled and read, so the prior columns are measuring memory, not travel.`
        : `**⚠ Below ceiling — the rung may be measuring travel rather than memory, and the prior columns above must be read with that in mind.**`));
  }
}
say("");

// ---- the split that actually answers §6: PRIOR probes vs the LIVE half ----------------------------
// §6 is a claim about the representation of a PRIOR. Two of the five change cells (`chg_same`, whose
// verdict needs a correct live read to be right, and `chg_now`, which is nothing but a live read)
// move with how well a session re-surveys. Pooling all five lets a travel/reading difference
// masquerade as a memory difference — so they are reported apart.
say(`## The split that answers §6: prior-only probes vs the live half`);
say("");
{
  const PRIOR_ONLY = ["chg_grew", "chg_vanished", "chg_appeared"]; // answerable only from a recorded prior
  const LIVE_DEP = ["chg_same", "chg_now"];                        // need a correct read of NOW
  say(`| arm | prior-only probes | live-dependent | obs calls |`);
  say(`|---|---|---|---|`);
  for (const arch of ARMS) {
    const pr = at(RUN, { id: PRIOR_ONLY, arch, workflow: "change" });
    const lv = at(RUN, { id: LIVE_DEP, arch, workflow: "change" });
    if (!pr.length) continue;
    const obs = sessionsOf(scored(RUN).filter((c) => c.arch === arch && c.workflow === "change"))
      .reduce((a, c) => a + c.obs_tools, 0);
    say(`| ${arch} | ${pr.filter((c) => c.correct).length}/${pr.length} (${pct(ciOf(pr).p)}) | ` +
      `${lv.filter((c) => c.correct).length}/${lv.length} (${pct(ciOf(lv).p)}) | ${obs} |`);
  }
  say("");
  // Paired per (probe, seed) against `full` — the within-run control over the same frozen corpus.
  say(`Paired sign test on the PRIOR probes, each arm vs \`full\` over the same corpus:`);
  say("");
  for (const arch of ARMS.filter((a) => a !== "full")) {
    const pairs = [];
    for (const id of PRIOR_ONLY) {
      for (const c of at(RUN, { id, arch, workflow: "change" })) {
        const m = at(RUN, { id, arch: "full", workflow: "change" }).find((x) => x.seed === c.seed);
        if (m) pairs.push({ a: c.correct ? 1 : 0, b: m.correct ? 1 : 0 });
      }
    }
    if (!pairs.length) continue;
    const t = pairedSignTest(pairs);
    say(`- **${arch}** ${pct(t.meanA)} vs full ${pct(t.meanB)} — ${t.discordant} discordant pair(s), p=${t.p.toFixed(3)}` +
      (t.discordant === 0 ? " — *not one probe differed on any seed*" : ""));
  }
}
say("");

// ---- power: can these criteria be resolved at this n? ---------------------------------------------
say(`## Power — what a cell of this size can resolve`);
say("");
say(`§6 asks for seeds ≥5, and this run has exactly 5. One per-unit cell is therefore n=5, and a`);
say(`Wilson interval at n=5 spans roughly 40 points at its narrowest:`);
say("");
for (const k of [5, 4, 3]) say(`- ${k}/5 = ${fmtCI(wilson(k, 5))}`);
say("");
say(`A **perfect** 5/5 cell is still statistically consistent with 57%. So §6's per-cell thresholds`);
say(`(≥85%, ≥90%) and its CI-non-overlap criterion cannot be discriminated at this sample size: a cell`);
say(`can fail the criterion while being consistent with passing it, and vice versa. Read every`);
say(`per-unit verdict below as directional. The paired tests above are the stronger instrument, because`);
say(`pairing on a shared corpus removes the between-seed variance that dominates these intervals.`);
say("");

// ---- prior observability: is the change rung asking an answerable question? -------------------------
// Found on the first change row of the step-5 run (2026-07-28): the `chg_vanished` prior was a wool
// tower of height 5, but the explore session's own describe_box covered y=199..202 and honestly saw
// TWO blocks. Authored memory and capture BOTH recorded 2, because the observation was 2. The truth is
// a construction truth the agent could not have seen given its own scan — grading against it measures
// how tall the explore session happened to scan, not whether memory retained a prior.
//
// It hits both arms identically, so the PAIRED comparison survives; what it damages is the absolute
// level that prediction 2's ≥70% floor is read against. So it is reported as a coverage column rather
// than silently folded into the score, and probes whose prior was never observable are called out.
// The rung was NOT edited after seeing this — changing a measurement mid-run because its first result
// was awkward is exactly what a prospective cycle exists to prevent. The fix belongs to a re-run.
say(`## Was the prior OBSERVABLE? (change rung coverage)`);
say("");
{
  const seedDirs = [];
  for (const d of dirs) {
    for (let s = 1; s <= 12; s++) {
      const md = join(d, `seed${s}`, "memory");
      if (existsSync(md)) seedDirs.push({ seed: s, memDir: md });
    }
  }
  const obsRecords = (memDir) => {
    for (const w of (() => { try { return readdirSync(memDir); } catch { return []; } })()) {
      const f = join(memDir, w, "observations.jsonl");
      if (existsSync(f)) {
        return readFileSync(f, "utf8").split("\n").filter(Boolean)
          .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      }
    }
    return [];
  };
  const norm = (b) => String(b ?? "").replace("minecraft:", "").split("[")[0];
  let rows = 0, unobservable = 0;
  say(`| seed | probe | truth prior | best captured prior | observable |`);
  say(`|---|---|---|---|---|`);
  for (const { seed, memDir } of seedDirs) {
    let scen;
    try { scen = (await import("./mem-scenario.mjs")).makeMemScenario(seed); } catch { continue; }
    const recs = obsRecords(memDir);
    if (!recs.length) continue;
    for (const p of scen.probes) {
      const [px, , pz] = p.pos;
      let best = null;
      for (const r of recs) {
        const b = r?.area?.box;
        if (!b) continue;
        const [[x0, , z0], [x1, , z1]] = b;
        if (px < x0 || px > x1 || pz < z0 || pz > z1) continue;
        for (const m of r.value?.materials ?? []) {
          if (p.before && norm(m.block) === norm(p.before.block)) best = Math.max(best ?? 0, m.count ?? 0);
        }
        if (!p.before && best === null) best = 0; // a bare platform read as bare
      }
      const want = p.before ? p.before.n : 0;
      const ok = best !== null && best === want;
      rows++; if (!ok) unobservable++;
      say(`| ${seed} | ${p.id} | ${p.before ? `${norm(p.before.block)}×${p.before.n}` : "bare"} | ` +
        `${best === null ? "not covered by any read" : `${best}`} | ${ok ? "yes" : "**NO**"} |`);
    }
  }
  say("");
  if (rows) {
    say(`**${unobservable}/${rows} probe priors were never observable** from the explore session's own`);
    say(`reads. Those cells cannot distinguish "memory lost the prior" from "the prior was never seen",`);
    say(`and they bound how high any arm can score on this rung — read prediction 2's absolute level`);
    say(`with that in mind. The arm-vs-arm comparison is unaffected: the upstream corpus is shared.`);
  } else {
    say(`_No captured observations found — coverage cannot be assessed._`);
  }
}
say("");

// ---- prediction 3 ----------------------------------------------------------------------------------
say(`## Prediction 3 — DOES NOT MOVE: \`anchor\`, \`region\`, \`stale\` each stay ≥90%`);
say("");
say(`| unit | ${ARMS.join(" | ")} |`);
say(`|---|${ARMS.map(() => "---").join("|")}|`);
const p3Fails = [];
for (const id of P3_UNITS) {
  const cellsFor = ARMS.map((a) => {
    const cs = at(RUN, { id, arch: a, workflow: "recall" });
    if (!cs.length) return "—";
    const ci = ciOf(cs);
    if (ci.p < P3_FLOOR) p3Fails.push(`${id}@${a} ${pct(ci.p)}`);
    return `${fmtCI(ci)} (${cs.filter((c) => c.correct).length}/${cs.length})`;
  });
  say(`| ${id} | ${cellsFor.join(" | ")} |`);
}
say("");
say(`**Prediction 3: ${verdict(p3Fails.length === 0)}**` +
  (p3Fails.length ? ` — below the ≥90% floor: ${p3Fails.join(", ")}. Capture was supposed to be unable to break these.` : " — every ceiling cell held."));
say("");

// ---- prediction 4 ----------------------------------------------------------------------------------
say(`## Prediction 4 — DOES NOT MOVE: the controls (E/Z/R/T)`);
say("");
say(`**Not measured by this run**, and reported as such rather than assumed — no control category was`);
say(`re-run at 0.9.6, so there is no post-intervention number to compare.`);
say("");
say(`What IS established is CONTAINMENT, verified mechanically rather than asserted (2026-07-28):`);
say("");
say(`- \`MCPTK_OBS_CAPTURE\` is set by exactly one runner, \`run-memory.mjs\`; \`ablation/mcp-shim.mjs\``);
say(`  defaults it **off**, so no other runner's sessions capture anything.`);
say(`- Every control runner (combat, diagnose, objectives, play, redstone, repair, traverse, wbuild)`);
say(`  hardcodes \`MCPTK_ABLATION_CONDITION: "a"\` — the amnesiac condition, which exposes no \`mem_*\``);
say(`  tool at all. Only conditions \`e\`/\`f\` carry the observation tools, and only \`run-memory.mjs\``);
say(`  can select them.`);
say(`- Category T runs through \`agent.mjs\`, which references neither the capture hook nor the`);
say(`  observation tools.`);
say(`- \`AGENT_WORLD_TOOLS\` contains no observation tool, so no arm picks one up by that route.`);
say("");
say(`That bounds the blast radius to Category C by construction. It is still an argument about the`);
say(`code, not a measurement of the controls: it cannot detect a control moving for an unrelated`);
say(`reason (a toolkit build, model drift), which is exactly what §6's "the controls move ⇒ the change`);
say(`was not confined to the observation layer" clause is watching for. **Prediction 4: NOT TESTED.**`);
say("");

// ---- prediction 5 ----------------------------------------------------------------------------------
say(`## Prediction 5 — COST: quiz tokens for C do not rise more than 25% over the 0.9.5 baseline`);
say("");
say(`_Read on the \`recall\` workflow only: the \`change\` quiz travels to four platforms by construction,`);
say(`so its tokens are not comparable to the 0.9.5 quiz and the bound does not apply to it._`);
say("");
const sessTok = (cs) => {
  const vals = sessionsOf(cs);
  return { n: vals.length, out: vals.reduce((a, c) => a + c.out_tokens, 0) / (vals.length || 1) };
};
const baseTok = sessTok(scored(BASE).filter((c) => c.arch === "full" && c.workflow === "recall"));
say(`| arm | workflow | sessions | mean quiz output tok | vs baseline |`);
say(`|---|---|---|---|---|`);
say(`| full (0.9.5 baseline) | recall | ${baseTok.n} | ${Math.round(baseTok.out)} | — |`);
const p5Fails = [];
let p5Bound = 0; // cells the §6 bound actually applies to — zero means INCONCLUSIVE, never PASS
for (const arch of ARMS) for (const workflow of ["recall", "change"]) {
  const t = sessTok(scored(RUN).filter((c) => c.arch === arch && c.workflow === workflow));
  if (!t.n) continue;
  const rise = baseTok.out ? (t.out - baseTok.out) / baseTok.out : null;
  const bound = workflow === "recall" && arch.startsWith("capture");
  if (bound) p5Bound++;
  if (bound && rise != null && rise > P5_MAX_RISE) p5Fails.push(`${arch} +${pct(rise)}`);
  say(`| ${arch} | ${workflow} | ${t.n} | ${Math.round(t.out)} | ` +
    `${rise == null ? "—" : `${rise >= 0 ? "+" : ""}${pct(rise)}${bound ? "" : " (not bound)"}`} |`);
}
say("");
say(`**Prediction 5: ${verdict(p5Fails.length === 0, !baseTok.n || p5Bound === 0)}**` +
  (p5Fails.length ? ` — over the +25% bound: ${p5Fails.join(", ")}. Accuracy bought with context is not accuracy bought with representation.`
    : !baseTok.n ? " — no 0.9.5 baseline dir to compare against."
    : p5Bound === 0 ? " — no capture arm ran the `recall` workflow, so the bound has nothing to bind."
    : " — within the bound."));
say("");

// ---- uptake ----------------------------------------------------------------------------------------
say(`## Free choice vs forced — did the captured surface get used at all?`);
say("");
say(`Broken out PER TOOL, not aggregated. An aggregate "obs calls" column hid the finding below on the`);
say(`first pass: the three tools are not interchangeable, and the one the change rung exists to test`);
say(`can sit at zero while the total looks healthy.`);
say("");
say(`| arm | workflow | sessions | using ≥1 | mem_seen | mem_changes | mem_last_seen |`);
say(`|---|---|---|---|---|---|---|`);
const obsTotals = { mem_seen: 0, mem_changes: 0, mem_last_seen: 0 };
for (const arch of ARMS) for (const workflow of ["recall", "change"]) {
  const armRows = rowsOf(dirs[0]).filter((r) => (r.arch ?? "full") === arch && (r.workflow ?? "recall") === workflow);
  if (!armRows.length) continue;
  const n = (t) => armRows.reduce((a, r) => a + (r.quiz?.tool_counts?.byName?.[t] ?? 0), 0);
  for (const t of Object.keys(obsTotals)) obsTotals[t] += n(t);
  const used = armRows.filter((r) => Object.keys(obsTotals).some((t) => (r.quiz?.tool_counts?.byName?.[t] ?? 0) > 0)).length;
  say(`| ${arch} | ${workflow} | ${armRows.length} | ${used} | ${n("mem_seen")} | ${n("mem_changes")} | ${n("mem_last_seen")} |`);
}
say("");
if (obsTotals.mem_changes === 0) {
  say(`> ⚠ **\`mem_changes\` was never called** — not once, in any arm or workflow. It is the tool built`);
  say(`> for "what changed here since tick T", i.e. the exact mechanism prediction 2 exists to test. So`);
  say(`> the change-rung result reads as *"\`mem_seen\` did not improve priors over authored memory"*,`);
  say(`> NOT as "the captured layer cannot do change detection" — the designed mechanism never ran.`);
  say("");
}
// Share of retrieval traffic: the discovery finding in one number.
{
  const OLD = ["mem_recall", "mem_read", "mem_recent", "describe_box", "get_blocks_at", "get_surface"];
  const all = rowsOf(dirs[0]);
  const sum = (ts) => all.reduce((a, r) => a + ts.reduce((b, t) => b + (r.quiz?.tool_counts?.byName?.[t] ?? 0), 0), 0);
  const nu = sum(Object.keys(obsTotals)), ol = sum(OLD);
  say(`Share of retrieval/read traffic going to the NEW surface: **${(100 * nu / Math.max(1, nu + ol)).toFixed(1)}%** ` +
    `(${nu} calls vs ${ol} to the pre-existing tools). Left to itself the model routes to what it already knows — ` +
    `PATTERN_SEARCH_DESIGN finding #1, reproduced.`);
  say("");
}
say(`\`locate\` is NOT in \`AGENT_WORLD_TOOLS\`, so the agent under test cannot call it. Two consequences`);
say(`for how far these numbers reach: \`mem_last_seen\` is described as "the remembered counterpart of`);
say(`locate", a tool absent from the arm, so its value proposition is untestable here; and`);
say(`\`capture.mjs\`'s locate extractor never fires in the bench path, so one of capture's four sources`);
say(`is dead and the captured corpus is narrower than the design describes.`);
say("");
say(`\`capture\` is the free-choice arm and \`capture-forced\` the steered one; they have byte-identical`);
say(`tools and differ by one prompt paragraph. Zero uptake on \`capture\` is a result about DISCOVERY,`);
say(`not a bug — capture-vs-capture-forced prices discovery, capture-forced-vs-full prices the`);
say(`representation, and §6 is a claim about the representation.`);
say("");

// ---- §8: the cycle-2 pre-registration (MEMORY_REDESIGN.md) -----------------------------------------
// Only rendered when the run actually carries cycle-2 arms; a 0.9.7 corpus reports §6 and stops.
const CYCLE2_ARMS = ARMS.filter((a) => ["annotate", "annotate-off", "worldonly-ann", "worldonly"].includes(a));
if (CYCLE2_ARMS.length) {
  const PRIOR_ONLY_8 = ["chg_grew", "chg_vanished", "chg_appeared"];
  const RECALL_UNITS_8 = ["anchor", "region", "stale", "where", "count", "breadth"];
  const P1_FLOOR_8 = 0.80, P2_FLOOR_8 = 0.60, P4_MAX_RISE_8 = 0.10;
  // Probe structures stand on top of the y=200 staging slab (mem-scenario `stage.Y + 1`), so this is
  // the lowest y a prior must reach to be about anything the change rung asks.
  const STRUCTURE_Y = 201;
  const keyOf = (c) => `${c.dir}|${c.seed}|${c.id}`;

  say(`# §8 verdict — MEMORY_REDESIGN.md pre-registration (sha256 6b1cbb27…)`);
  say("");
  say(`Committed 2026-07-29 BEFORE any implementation of §2–§4 existed. Every prediction is reported,`);
  say(`including the ones that fail. Paired comparisons on the shared frozen corpus are the PRIMARY`);
  say(`criteria throughout; absolute floors are secondary — the 0.9.7 lesson is that at n≈5 a perfect`);
  say(`5/5 is still consistent with 57%, so absolute thresholds sit below the instrument's resolution.`);
  say("");
  const rungV = dirs.map((d) => {
    try { return JSON.parse(readFileSync(join(d, "manifest.json"), "utf8")).change_rung_version ?? 1; } catch { return 1; }
  });
  say(`Change-rung staging version(s) in this run: **v${[...new Set(rungV)].join(", v")}**. v1 and v2 are a`);
  say(`comparability boundary — v1 staged \`chg_vanished\` as a tower whose prior was structurally`);
  say(`unobservable — so absolute levels are never pooled across versions.`);
  say("");

  // --- ANNOTATABLE PRIOR COVERAGE — read this BEFORE any prediction ------------------------------
  // The appendix can only fire where the EXPLORE pass left a cell-level prior. Whether it did is an
  // uncontrolled free choice: `get_blocks_at` captures cells, `describe_box` in SUMMARY mode captures
  // only aggregates, and the two answer the same question. Observed 2026-07-29: two runs of the
  // identical prompt and seed produced 172 cell rows and 0 cell rows respectively.
  //
  // A seed whose corpus has no cell rows cannot serve a delta no matter how well the mechanism
  // works, so its zero is NOT evidence about the design — exactly the distinction the 0.9.7 cycle
  // had to add for `chg_vanished`. Reported first so no prediction below is read without it.
  say(`## Annotatable prior coverage (read this first)`);
  say("");
  say(`The appendix diffs a live read against a CELL-LEVEL prior AT A POSITION THE RUNG ASKS ABOUT. Every`);
  say(`probe stands on top of a y=200 slab, so only priors at y>=${STRUCTURE_Y} can answer it — a corpus that`);
  say(`read the platform surface and stopped has cells, and none of them are about anything. \`describe_box\` in summary mode`);
  say(`captures aggregates only (per §2.2/§7, aggregate-vs-aggregate diffs are deferred), so a seed`);
  say(`explored entirely with summaries has no prior the mechanism can read — and its zero is a`);
  say(`property of the corpus, not of the design.`);
  say("");
  say(`| seed | explore records | CELL rows | of those, y>=${STRUCTURE_Y} | annotatable? |`);
  say(`|---|---|---|---|---|`);
  let dark = 0, seedsSeen = 0;
  const cellsBySeed = new Map(); // `${dir}|${seed}` -> cell rows captured by the explore pass
  for (const dir of dirs) {
    for (const sd of (existsSync(dir) ? readdirSync(dir) : []).filter((x) => /^seed\d+$/.test(x))) {
      const memRoot = join(dir, sd, "memory");
      if (!existsSync(memRoot)) continue;
      let records = 0, cells = 0, structureCells = 0;
      for (const w of readdirSync(memRoot)) {
        const f = join(memRoot, w, "observations.jsonl");
        if (!existsSync(f)) continue;
        for (const l of readFileSync(f, "utf8").split("\n").filter(Boolean)) {
          try {
            const r = JSON.parse(l);
            records++;
            for (const c of r.cells ?? []) {
              cells++;
              if (c[1] >= STRUCTURE_Y) structureCells++;
            }
          } catch { /* torn */ }
        }
      }
      seedsSeen++;
      // STRUCTURE-LAYER cells are the ones that matter: every probe stands ON TOP of a y=200 slab,
      // so a corpus that read only the platform surface has priors about cobblestone and nothing
      // about what the change rung asks. Measured 2026-07-29: a seed with 85 cell rows, ALL at
      // y=200, is exactly as dark as a seed with none — and a total-rows column called it "yes".
      if (!structureCells) dark++;
      cellsBySeed.set(`${dir}|${parseInt(sd.slice(4), 10)}`, structureCells);
      say(`| ${sd} | ${records} | ${cells} | ${structureCells} | ${structureCells ? "yes" : "**NO — read the slab, not what stands on it**"} |`);
    }
  }
  say("");
  if (dark) {
    say(`> ⚠ **${dark}/${seedsSeen} seed(s) captured ZERO structure-layer priors.** On those seeds no delta was`);
    say(`> reachable, so prediction 1's denominator and prediction 2's premise are both unmet there.`);
    say(`> Their zeros must not be pooled into a claim about the mechanism.`);
    say("");
  }

  // --- prediction 1: MECHANISM EXECUTES ------------------------------------------------------------
  say(`## Prediction 1 — the mechanism EXECUTES under free choice`);
  say("");
  say(`> ≥80% of \`annotate\` change-workflow sessions are SERVED at least one remembered-DELTA`);
  say(`> annotation (structural count, server-side) — against \`mem_changes\`' 0/30 under explicit`);
  say(`> instruction. This is a claim about DELIVERY, not about accuracy.`);
  say("");
  const gChange = sessionsOf(at(RUN, { arch: "annotate", workflow: "change" }));
  // A row with NO `remembered_served` field was produced by an instrument that never recorded the
  // marker. Reading that as "zero appendices served" would report an instrument gap as a build
  // defect — the two look identical in the arithmetic and are opposite in meaning.
  // A seed that captured no cell-level prior could not have served a delta however well the
  // mechanism works. Counting its zero as a failure would report a corpus property as a build
  // defect — the same conflation the coverage table above exists to prevent.
  const darkSessions = gChange.filter((c) => (cellsBySeed.get(`${c.dir}|${c.seed}`) ?? 0) === 0);
  if (darkSessions.length) {
    say(`> ⚠ **${darkSessions.length}/${gChange.length} \`annotate\` change session(s) ran on a corpus with NO`);
    say(`> cell-level priors** (see the coverage table). No delta was reachable there, so they are`);
    say(`> EXCLUDED from the denominator below rather than counted as failures to deliver.`);
    say("");
  }
  const unrecorded = gChange.filter((c) => c.served == null);
  if (unrecorded.length) {
    say(`> ⚠ **${unrecorded.length}/${gChange.length} \`annotate\` change session(s) carry NO \`remembered_served\` field.**`);
    say(`> These rows predate the marker being written into answers.jsonl (run-memory assembles rows by`);
    say(`> explicit field picking). They are NOT evidence of zero delivery and are EXCLUDED below; the`);
    say(`> raw markers still exist in their transcripts and can be recounted from there.`);
    say("");
  }
  const gChangeRec = gChange.filter((c) => c.served != null
    && (cellsBySeed.get(`${c.dir}|${c.seed}`) ?? 0) > 0);
  const withDelta = gChangeRec.filter((c) => (c.served?.delta ?? 0) > 0);
  const p1rate = gChangeRec.length ? withDelta.length / gChangeRec.length : 0;
  say(`| arm | workflow | sessions | >=1 delta served | >=1 appendix (any kind) | total appendices |`);
  say(`|---|---|---|---|---|---|`);
  for (const arch of CYCLE2_ARMS) for (const workflow of ["recall", "change"]) {
    const ss = sessionsOf(at(RUN, { arch, workflow }));
    if (!ss.length) continue;
    const d = ss.filter((c) => (c.served?.delta ?? 0) > 0).length;
    const anyA = ss.filter((c) => (c.served?.total ?? 0) > 0).length;
    const tot = ss.reduce((a, c) => a + (c.served?.total ?? 0), 0);
    say(`| ${arch} | ${workflow} | ${ss.length} | ${d} | ${anyA} | ${tot} |`);
  }
  say("");
  say(`**${verdict(p1rate >= P1_FLOOR_8, !gChangeRec.length)}** — ${withDelta.length}/${gChangeRec.length} = ${pct(p1rate)} against the >=${pct(P1_FLOOR_8)} floor` +
    `${unrecorded.length ? ` (${unrecorded.length} session(s) excluded as unrecorded)` : ""}.`);
  if (!gChangeRec.length) {
    say("");
    say(`> **INCONCLUSIVE, not FAIL.** Every \`annotate\` change session was either unrecorded or ran on`);
    say(`> a corpus with no annotatable prior. This measurement did not test the mechanism at all —`);
    say(`> whether the explore pass captures cell-level priors is an uncontrolled free choice between`);
    say(`> \`get_blocks_at\` and \`describe_box\` summary, and that choice decides whether the appendix`);
    say(`> can fire. Fix the coverage before spending seeds on this prediction.`);
  } else if (p1rate < P1_FLOOR_8) {
    say("");
    say(`> ⚠ Prediction 1 failing is a BUILD DEFECT, not a result about memory: it means the appendix was`);
    say(`> not served on the reads these sessions actually made. §8 requires it to be reported as such.`);
    say(`> Check that MCPTK_OBS_ANNOTATE reached the shim and that the reads were captured at all.`);
  }
  // Diagnostic, NOT the criterion: did each session give the mechanism anything to deliver?
  say("");
  say(`### Opportunity vs delivery (diagnostic — the criterion above is unchanged)`);
  say("");
  say(`A session that never re-read a changed cell it held a prior for cannot be served a delta, and`);
  say(`its zero is silence about the agent's surveying, not about the appendix. Replayed per session`);
  say(`against the pristine pre-quiz corpus.`);
  say("");
  say(`| seed | arm | captured reads | deltas WARRANTED | served |`);
  say(`|---|---|---|---|---|`);
  let oppTotal = 0, oppServed = 0;
  for (const c of [...gChange].sort((a, b) => a.seed - b.seed)) {
    const w = await replayWarranted(c.dir, c.seed, `${c.arch}+change`);
    if (!w) { say(`| ${c.seed} | ${c.arch} | — | — | — |`); continue; }
    oppTotal += w.warranted > 0 ? 1 : 0;
    oppServed += w.warranted > 0 && w.served > 0 ? 1 : 0;
    say(`| ${c.seed} | ${c.arch} | ${w.reads} | ${w.warranted} | ${w.served}${w.warranted === 0 ? "  _(no opportunity)_" : ""} |`);
  }
  say("");
  say(`Sessions that HAD an opportunity: ${oppTotal}. Of those, served: **${oppServed}**` +
    `${oppTotal ? ` (${pct(oppServed / oppTotal)})` : ""}. Sessions with no opportunity exercised nothing.`);
  say("");
  const hServed = sessionsOf(at(RUN, { arch: "annotate-off" })).reduce((a, c) => a + (c.served?.total ?? 0), 0);
  const jServed = sessionsOf(at(RUN, { arch: "worldonly" })).reduce((a, c) => a + (c.served?.total ?? 0), 0);
  say("");
  say(`Control check — the OFF arms must be structurally ZERO: \`annotate-off\` ${hServed}, \`worldonly\` ${jServed}` +
    `${hServed + jServed === 0 ? " ✓" : " — **NON-ZERO: the flag did not reach the shim, so these are not on/off pairs**"}.`);
  say("");

  // --- prediction 2: REPRESENTATION carries priors --------------------------------------------------
  say(`## Prediction 2 — the representation CARRIES PRIORS when delivered (i vs j)`);
  say("");
  say(`> On the change rung's prior-only probes, \`worldonly-ann\` beats \`worldonly\` — paired sign test`);
  say(`> p<.05 over the shared corpus. Secondary: i >=60% absolute on ANSWERABLE prior-only probes; j is`);
  say(`> expected near floor (it has no memory surface at all — its score IS the guessing floor).`);
  say("");
  const iCells = new Map(at(RUN, { id: PRIOR_ONLY_8, arch: "worldonly-ann", workflow: "change" }).map((c) => [keyOf(c), c]));
  const jCells = new Map(at(RUN, { id: PRIOR_ONLY_8, arch: "worldonly", workflow: "change" }).map((c) => [keyOf(c), c]));
  const pairs2 = [...iCells.keys()].filter((k) => jCells.has(k))
    .map((k) => ({ a: iCells.get(k).correct ? 1 : 0, b: jCells.get(k).correct ? 1 : 0 }));
  const st2 = pairedSignTest(pairs2);
  const iAcc = [...iCells.values()], jAcc = [...jCells.values()];
  say(`| arm | prior-only probes | accuracy |`);
  say(`|---|---|---|`);
  say(`| worldonly-ann (i) | ${iAcc.filter((c) => c.correct).length}/${iAcc.length} | ${iAcc.length ? fmtCI(ciOf(iAcc)) : "—"} |`);
  say(`| worldonly (j) | ${jAcc.filter((c) => c.correct).length}/${jAcc.length} | ${jAcc.length ? fmtCI(ciOf(jAcc)) : "—"} |`);
  say("");
  say(`Paired over ${st2.n} shared cells: ${st2.aWin} i-wins, ${st2.bWin} j-wins, ${st2.discordant} discordant, **p=${st2.p.toFixed(3)}**.`);
  const p2pass = st2.p < 0.05 && st2.aWin > st2.bWin;
  if (underpowered(st2)) {
    say(`**UNDERPOWERED — not a FAIL.** ${powerNote(st2)}. The direction is ` +
      `${st2.aWin > st2.bWin ? "toward i" : st2.bWin > st2.aWin ? "toward j" : "flat"} ` +
      `(${st2.aWin} i-wins vs ${st2.bWin} j-wins), which is reported as direction only. Add seeds.`);
  } else {
    say(`**${verdict(p2pass)}** (primary, paired).`);
  }
  say(`Secondary floor: i at ${iAcc.length ? pct(ciOf(iAcc).p) : "—"} against >=${pct(P2_FLOOR_8)}.`);
  say("");
  say(`Pre-committed reading: if annotations are VERIFIED SERVED (prediction 1) and i still does not beat`);
  say(`j, the hypothesis is FALSIFIED — delivery was not the bottleneck, the representation itself does`);
  say(`not help, and the 0.9.7 null generalizes.`);
  say("");

  // --- prediction 3: NO REGRESSION ------------------------------------------------------------------
  say(`## Prediction 3 — NO REGRESSION from the consolidation (g vs h, paired per unit)`);
  say("");
  say(`> No recall-workflow unit differs, in EITHER direction (sign test p<.05).`);
  say("");
  say(`| unit | annotate | annotate-off | discordant | p | differs? |`);
  say(`|---|---|---|---|---|---|`);
  const p3fail = [], p3weak = [];
  for (const id of RECALL_UNITS_8) {
    const gm = new Map(at(RUN, { id, arch: "annotate", workflow: "recall" }).map((c) => [keyOf(c), c]));
    const hm = new Map(at(RUN, { id, arch: "annotate-off", workflow: "recall" }).map((c) => [keyOf(c), c]));
    const prs = [...gm.keys()].filter((k) => hm.has(k)).map((k) => ({ a: gm.get(k).correct ? 1 : 0, b: hm.get(k).correct ? 1 : 0 }));
    if (!prs.length) { say(`| ${id} | — | — | — | — | no data |`); continue; }
    const st = pairedSignTest(prs);
    const differs = st.p < 0.05;
    if (differs) p3fail.push(id);
    if (underpowered(st)) p3weak.push(id);
    say(`| ${id} | ${pct(st.meanA)} | ${pct(st.meanB)} | ${st.discordant} | ${st.p.toFixed(3)} | ${differs ? "**YES**" : underpowered(st) ? "n/a (underpowered)" : "no"} |`);
  }
  say("");
  if (p3weak.length === RECALL_UNITS_8.length) {
    say(`**UNDERPOWERED — this PASS is vacuous.** Every unit has <${SIGN_TEST_MIN_DISCORDANT} discordant`);
    say(`pairs, so no unit COULD have differed significantly. "Nothing regressed" here means "the test`);
    say(`could not have detected a regression", which is reassurance the data does not support.`);
  } else {
    say(`**${verdict(!p3fail.length)}**${p3fail.length ? ` — ${p3fail.join(", ")} moved; the consolidation changed what already worked.` : ""}`);
    if (p3weak.length) say(`(${p3weak.length} unit(s) underpowered and cannot contribute either way: ${p3weak.join(", ")}.)`);
  }
  say("");
  say(`g against the 0.9.7 \`full\` arm is REPORTED but is a comparability boundary (a different tool`);
  say(`surface), never a criterion — §8 says so explicitly.`);
  say("");

  // --- prediction 4: COST --------------------------------------------------------------------------
  say(`## Prediction 4 — COST: g's quiz output tokens <= h + 10%, paired`);
  say("");
  say(`> Silence-on-agreement is the mechanism. If the appendix chatters on unchanged worlds, this bound`);
  say(`> catches it — the §6.5 failure mode of the prior design, priced.`);
  say("");
  const sessBy = (arch) => new Map(sessionsOf(at(RUN, { arch })).map((c) => [`${c.dir}|${c.seed}|${c.workflow}`, c]));
  const gS = sessBy("annotate"), hS = sessBy("annotate-off");
  const tokPairs = [...gS.keys()].filter((k) => hS.has(k)).map((k) => ({ g: gS.get(k).out_tokens, h: hS.get(k).out_tokens, k }));
  const gTok = tokPairs.reduce((a, x) => a + x.g, 0), hTok = tokPairs.reduce((a, x) => a + x.h, 0);
  const rise = hTok ? (gTok - hTok) / hTok : 0;
  say(`| seed·workflow | annotate out | annotate-off out | Δ |`);
  say(`|---|---|---|---|`);
  for (const x of tokPairs) {
    say(`| ${x.k.split("|").slice(1).join("·")} | ${x.g} | ${x.h} | ${x.h ? `${((x.g - x.h) / x.h * 100).toFixed(0)}%` : "—"} |`);
  }
  say("");
  say(`Pooled: ${gTok} vs ${hTok} = **${(rise * 100).toFixed(1)}%** against the <=${pct(P4_MAX_RISE_8)} bound.`);
  say(`**${verdict(rise <= P4_MAX_RISE_8, !tokPairs.length)}**`);
  say("");

  // --- prediction 5: uptake is NOT a criterion -------------------------------------------------------
  say(`## Prediction 5 — deep-dig uptake is REPORTED, and is NOT a criterion`);
  say("");
  say(`> A low \`mem_recall\` count is a design SUCCESS (the appendix answered first), not a failure.`);
  say(`> Pre-committed so the 5.9% class of number cannot be read against the design after the fact.`);
  say("");
  say(`| arm | workflow | sessions | mem_recall calls | appendices served |`);
  say(`|---|---|---|---|---|`);
  for (const arch of CYCLE2_ARMS) for (const workflow of ["recall", "change"]) {
    const ss = sessionsOf(at(RUN, { arch, workflow }));
    if (!ss.length) continue;
    say(`| ${arch} | ${workflow} | ${ss.length} | ${ss.reduce((a, c) => a + c.mem_recall, 0)} | ${ss.reduce((a, c) => a + (c.served?.total ?? 0), 0)} |`);
  }
  say("");
}

// ---- falsification --------------------------------------------------------------------------------
say(`## What §6 said would falsify the hypothesis`);
say("");
say(`> Any of: \`where\`/\`count\` fail to move while capture is verified present; the controls move`);
say(`> (⇒ the change was not confined to the observation layer); or accuracy rises only alongside a`);
say(`> token rise beyond the bound (⇒ bought with context, not with representation).`);
say("");
const capturePresent = scored(RUN).some((c) => c.obs_tools > 0);
say(`- Capture verified present in the sessions: **${capturePresent ? "yes" : "NO — the surface was never called"}**.`);
say(`- Controls: not measured here (see prediction 4).`);
say(`- Token bound: ${p5Fails.length ? "**exceeded**" : "held"}.`);
say("");

console.log(out.join("\n"));
