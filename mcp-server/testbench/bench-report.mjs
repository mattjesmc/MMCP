#!/usr/bin/env node
// Unified bench DISPLAY — pivot testbench-results along the same axes run-bench.mjs constructs from:
// full / category / discipline / ablation arm. Rows join back to registry units by each unit's
// `match`, and to their run's manifest by dir, so old results gain the discipline view and the
// manifest attributes (model, bench_version, adapter, tools_hash) without rewriting anything.
//
//   node testbench/bench-report.mjs                        # all dirs, pivot by category
//   node testbench/bench-report.mjs --by discipline        # discipline scorecard (load-bearing tags)
//   node testbench/bench-report.mjs --by arm               # ablation arms side by side
//   node testbench/bench-report.mjs --by unit              # finest grain
//   node testbench/bench-report.mjs --by discipline,cat    # CROSS pivot (the confound split)
//   node testbench/bench-report.mjs --by model,arm         # secondary hypothesis
//   node testbench/bench-report.mjs --model haiku          # filter to a model (also --bench-version)
//   node testbench/bench-report.mjs <dir ...> --by arm     # specific runs only
//   node testbench/bench-report.mjs --coverage             # per-category tool-call coverage
//   node testbench/bench-report.mjs --index                # the marker index (no results needed)
//
// Metric columns per cell: mean success (over SCORED rows), confident-wrong / abstain / turn-cap
// (over rows where those are DEFINED — graded build/traverse units have no answer/abstain, so they
// drop out of calibration), mean turns, and mean tokens BOTH ways (no-cache / with-cache). Scoring
// is unit-defined (registry `success` → 0..1 or null=unscorable); a category mixes accuracy and
// graded units, so cells report mean success, not "percent correct".

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { UNITS, categoryOfDir } from "./registry.mjs";
import { expandRow } from "./ratchet.mjs";
import { DISCIPLINES, DISCIPLINE_ORDER } from "./disciplines.mjs";
import { tokFields, accTok, zeroTok, noCache, withCache, ktok } from "./tokens.mjs";
import { wilson, normalCI, fmtCI, pairedSignTest } from "./stats.mjs";
import { isCensoredSubtype } from "./session-guards.mjs";

const here = join(fileURLToPath(import.meta.url), "..");
const argv = process.argv.slice(2);
const flagVals = new Set(); // arg values consumed by --opt, so they aren't mistaken for dirs
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); if (i >= 0) { flagVals.add(argv[i + 1]); return argv[i + 1]; } return dflt; };
const BY = opt("by", "cat");
const MODEL = opt("model", null);
const BENCHVER = opt("bench-version", null);
const DELTA = opt("delta", null); // "with,without" — paired arm comparison
const INDEX = argv.includes("--index");
const COVERAGE = argv.includes("--coverage");
const MIN_SEEDS = 2, MIN_REPS = 3; // A3 minimum-n policy for a citable cell

// ---- the marker index (static: registry + taxonomy, no results) -------------------------------
if (INDEX) {
  const cats = [...new Set(UNITS.map((u) => u.cat))];
  console.log(`# Bench discipline index — ${UNITS.length} units × ${DISCIPLINE_ORDER.length} disciplines\n`);
  console.log(`## Taxonomy\n`);
  console.log(`| discipline | measures | canonical probe |`);
  console.log(`|---|---|---|`);
  for (const d of DISCIPLINE_ORDER) console.log(`| **${d}** (${DISCIPLINES[d].label}) | ${DISCIPLINES[d].gauge} | ${DISCIPLINES[d].example} |`);

  console.log(`\n## Discipline × category (● load-bearing, ○ incidental)\n`);
  console.log(`| discipline | ${cats.join(" | ")} |`);
  console.log(`|---|${cats.map(() => "---").join("|")}|`);
  for (const d of DISCIPLINE_ORDER) {
    const cells = cats.map((c) => {
      const us = UNITS.filter((u) => u.cat === c);
      if (us.some((u) => u.disciplines.includes(d))) return "●";
      if (us.some((u) => u.also.includes(d))) return "○";
      return "";
    });
    console.log(`| ${d} | ${cells.join(" | ")} |`);
  }

  console.log(`\n## Units\n`);
  console.log(`| unit | cat | load-bearing | incidental | status | title |`);
  console.log(`|---|---|---|---|---|---|`);
  for (const u of UNITS) {
    console.log(`| ${u.id} | ${u.cat} | ${u.disciplines.join("+")} | ${u.also.join("+") || "—"} | ${u.status} | ${u.title} |`);
  }

  console.log(`\n## Gaps\n`);
  for (const d of DISCIPLINE_ORDER) {
    const primary = UNITS.filter((u) => u.disciplines.includes(d));
    const proven = primary.filter((u) => u.status !== "pending");
    if (!primary.length) console.log(`- **${d}**: NO unit makes this load-bearing — a bench gap.`);
    else if (!proven.length) console.log(`- **${d}**: load-bearing only in live-pending units (${primary.map((u) => u.id).join(", ")}).`);
  }
  const none = DISCIPLINE_ORDER.every((d) => UNITS.some((u) => u.disciplines.includes(d)));
  if (none) console.log(`- (every discipline has at least one load-bearing unit; see live-pending notes above)`);
  process.exit(0);
}

// ---- load rows + join manifests ----------------------------------------------------------------
const jl = (p) => readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const dirs = argv.filter((a) => !a.startsWith("--") && !flagVals.has(a));
const roots = dirs.length
  ? dirs.map((d) => (d.includes("/") || d.includes("\\") ? d : join(here, "..", "testbench-results", d)))
  : readdirSync(join(here, "..", "testbench-results")).map((d) => join(here, "..", "testbench-results", d)).filter((p) => statSync(p).isDirectory());

function readManifest(root) {
  const mp = join(root, "manifest.json");
  if (!existsSync(mp)) return {};
  try { return JSON.parse(readFileSync(mp, "utf8")); } catch { return {}; }
}
/** Per-run attributes lifted from the manifest onto every row of the run. */
function dirMeta(m) {
  return {
    model: m.model ?? "?", model_id: m.model_id ?? null,
    bench_version: m.bench_version ?? null, adapter: m.adapter ?? null,
    tools_hash: m.tools_hash ?? null, git_head: m.git_head ?? null,
  };
}

const joined = []; // {unit, row, dirCat, arm, meta}
let unmatched = 0, errors = 0, splitRows = 0, filtered = 0;
for (const root of roots) {
  const dirCat = categoryOfDir(root.split(/[\\/]/).pop());
  const meta = dirMeta(readManifest(root));
  if (MODEL && meta.model !== MODEL) { filtered++; continue; }
  if (BENCHVER && String(meta.bench_version) !== BENCHVER) { filtered++; continue; }
  const ap = join(root, "answers.jsonl");
  if (!existsSync(ap)) continue;
  for (const raw of jl(ap)) {
    if (raw.error) { errors++; continue; }
    for (const row of expandRow(raw)) {
      if (row._split) splitRows++;
      const unit = UNITS.find((u) => u.match(row, dirCat));
      if (!unit) { unmatched++; continue; }
      joined.push({ unit, row, dirCat, arm: row.arm ?? row.arch ?? row.condition ?? "-", meta });
    }
  }
}

// ---- coverage mode: per-category tool-call histogram (offline; DARK/universe needs the live map) --
if (COVERAGE) {
  const strip = (n) => String(n || "").replace(/^mcp__[a-z0-9_]+__/, "");
  const byCat = new Map(); // cat -> Map(tool -> calls)
  for (const { dirCat, row } of joined) {
    const m = byCat.get(dirCat) ?? new Map();
    byCat.set(dirCat, m);
    const bump = (t, n) => { const s = strip(t); if (s) m.set(s, (m.get(s) ?? 0) + (n || 1)); };
    for (const e of row.trace ?? []) if (e.tool) bump(e.tool, 1);
    for (const [t, n] of Object.entries(row.tools ?? {})) bump(t, n);
    for (const [t, n] of Object.entries(row.tool_counts?.byName ?? {})) bump(t, n);
  }
  console.log(`# bench tool-call coverage — ${joined.length} rows, by category\n`);
  console.log(`| cat | distinct tools | calls | top tools (calls) |`);
  console.log(`|---|---|---|---|`);
  for (const cat of [...byCat.keys()].sort()) {
    const m = byCat.get(cat);
    const tot = [...m.values()].reduce((a, b) => a + b, 0);
    const top = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t, n]) => `${t}(${n})`).join(", ");
    console.log(`| ${cat} | ${m.size} | ${tot} | ${top || "—"} |`);
  }
  console.log(`\nUsage side only — the DARK set (tools no bench can call) needs the live bridge: \`node testbench/coverage-report.mjs\`.`);
  process.exit(0);
}

if (!joined.length) { console.error(`no joinable rows in ${roots.length} dirs (${unmatched} unmatched, ${errors} errors, ${filtered} dirs filtered out)`); process.exit(1); }

// ---- paired arm-delta mode (A3): exact sign test over shared instances --------------------------
if (DELTA) {
  const [armA, armB] = DELTA.split(",").map((s) => s.trim());
  if (!armA || !armB) { console.error(`--delta needs two arms, e.g. --delta with,without`); process.exit(2); }
  const instKey = (j) => `${j.row.id ?? j.row.scenario}|${j.row.seed ?? "-"}|${j.row.rep ?? "-"}`;
  const byUnit = new Map(); // unitId -> Map(instKey -> {a, b})
  for (const j of joined) {
    const v = j.unit.success(j.row);
    if (v === null || v === undefined) continue;
    const arm = j.arm;
    const slot = arm === armA ? "a" : arm === armB ? "b" : null;
    if (!slot) continue;
    const m = byUnit.get(j.unit.id) ?? new Map();
    byUnit.set(j.unit.id, m);
    const rec = m.get(instKey(j)) ?? {};
    rec[slot] = v;
    m.set(instKey(j), rec);
  }
  console.log(`# paired arm delta — ${armA} vs ${armB} (exact two-sided sign test over shared instances)\n`);
  console.log(`| unit | pairs | discordant | mean ${armA} | mean ${armB} | Δ (${armA}−${armB}) | p | sig |`);
  console.log(`|---|---|---|---|---|---|---|---|`);
  let any = false;
  for (const u of UNITS) {
    const m = byUnit.get(u.id);
    if (!m) continue;
    const pairs = [...m.values()].filter((r) => r.a !== undefined && r.b !== undefined);
    if (!pairs.length) continue;
    any = true;
    const r = pairedSignTest(pairs);
    const sig = r.discordant === 0 ? "—" : (r.p < 0.05 ? `p<.05` : "ns");
    const d = (r.delta >= 0 ? "+" : "") + Math.round(r.delta * 100) + "%";
    console.log(`| ${u.cat} ${u.id} | ${r.n} | ${r.discordant} | ${Math.round(r.meanA * 100)}% | ${Math.round(r.meanB * 100)}% | ${d} | ${r.p.toFixed(3)} | ${sig} |`);
  }
  if (!any) { console.error(`no shared ${armA}/${armB} instances found`); process.exit(1); }
  console.log(`\n_Paired per (id, seed, rep); only discordant pairs carry signal. Δ = mean success difference; ` +
    `p from the exact binomial sign test (McNemar) over discordant pairs. "ns" = not significant at .05._`);
  process.exit(0);
}

// ---- per-row metric extraction (null where undefined for this row shape) -------------------------
const isBool = (v) => typeof v === "boolean";
function metrics(unit, row) {
  // CENSORED = a non-answer terminal state: the old turn cap, the A5 stall/runaway stops, or a
  // no-tools instrument failure. A cap hit is only evidence against the cap, never a property of the
  // subject — so accuracy is undefined here. The list lives in session-guards (one definition).
  const censoredReason = isCensoredSubtype(row.stop_reason) || isCensoredSubtype(row.subtype);
  const capField = "hit_turn_cap" in row || "capped" in row || "stop_reason" in row;
  const capped = row.hit_turn_cap === true || row.capped === true || censoredReason;
  const turnCap = capField || row.subtype != null ? (capped ? 1 : 0) : null;
  const turns = typeof row.turns === "number" ? row.turns : null;
  // A5 CENSORING: a turn-capped row is CENSORED, not a failure — its budget ran out before the answer
  // resolved, so accuracy is UNDEFINED (null, excluded from success/conf-wrong/abstain) and its cost
  // is a lower bound (tokens still counted). Never fold the cap into the failure column.
  if (capped) return { succ: null, confWrong: null, abstain: null, censored: turnCap, turns, tok: tokFields(row) };
  const succ = unit.success(row);
  const answered = isBool(row.abstained) ? !row.abstained : null;
  const correctBool = isBool(row.correct) ? row.correct : null;
  const confWrong = (correctBool !== null && answered !== null) ? (correctBool === false && answered ? 1 : 0) : null;
  const abstain = answered !== null ? (answered ? 0 : 1) : null;
  return { succ, confWrong, abstain, censored: turnCap, turns, tok: tokFields(row) };
}

// ---- aggregate ----------------------------------------------------------------------------------
function cell() {
  return { n: 0, sc: acc(), cw: acc(), ab: acc(), tc: acc(), tn: acc(), tok: zeroTok(),
    vals: [], allBool: true, seeds: new Set(), reps: new Set() };
}
function acc() { return { n: 0, sum: 0 }; }
function put(a, v) { if (v !== null && v !== undefined) { a.n++; a.sum += v; } }
function add(c, unit, row) {
  c.n++;
  const m = metrics(unit, row);
  put(c.sc, m.succ); put(c.cw, m.confWrong); put(c.ab, m.abstain); put(c.tc, m.censored); put(c.tn, m.turns);
  if (m.succ !== null && m.succ !== undefined) { c.vals.push(m.succ); if (m.succ !== 0 && m.succ !== 1) c.allBool = false; }
  if (row.seed !== undefined && row.seed !== null) c.seeds.add(row.seed);
  if (row.rep !== undefined && row.rep !== null) c.reps.add(row.rep);
  accTok(c.tok, row);
}
const avg = (a) => (a.n ? (Math.round((a.sum / a.n) * 10) / 10).toString() : "—");
const pct = (a) => (a.n ? `${Math.round((a.sum / a.n) * 100)}%` : "—");
const meanTok = (c) => c.n ? `${ktok(noCache(c.tok) / c.n)}/${ktok(withCache(c.tok) / c.n)}` : "—/—";
// success cell = Wilson CI (boolean cells) or normal-approx CI (graded cells), with the min-n flag.
function successCell(c) {
  if (!c.sc.n) return `— (0/${c.n})`;
  const ci = c.allBool ? wilson(Math.round(c.sc.sum), c.sc.n) : normalCI(c.vals);
  const belowN = (c.seeds.size > 0 && c.seeds.size < MIN_SEEDS) || (c.reps.size > 0 && c.reps.size < MIN_REPS);
  return `${fmtCI(ci)}${c.allBool ? "" : "~"} (${c.sc.n}/${c.n})${belowN ? " †" : ""}`;
}

// ---- pivots: --by is a comma list of axes; discipline is multi-valued (row appears per tag) -------
const AXES = BY.split(",").map((s) => s.trim());
// `difficulty` is the LEGACY axis, kept so pre-split runs still pivot (their rows carry it). Its two
// successors read from the registry unit rather than the row, so they work on old and new results
// alike: `tool_dependence` (how much the without-arm loses) and `reasoning_load` (how hard the task
// stays with every tool available). One field could not carry both — splitting the corpus by
// tier × arm showed `difficulty` was tracking only the first, while the with-arm sat at ~96% across
// every tier. See registry.mjs LOAD_BANDS.
// `tools_hash`/`git_head` pivot the SUT, not the instrument. bench_version freezes the BENCH; the
// toolkit under test can still change beneath a fixed one, and pooling across that is a live
// citation hazard: e_repair_bridge_gap reads 60% over 0.9.3 only because the pre-vertical-edge
// build (git dae9cbb) is pooled with the post-fix builds, where it is 3/3. Splitting on these makes
// the SUT boundary visible in the same table.
const KNOWN = new Set(["cat", "discipline", "arm", "unit", "model", "bench-version", "difficulty",
  "tool_dependence", "reasoning_load", "tools_hash", "git_head"]);
const BAND_ORDER = ["none", "low", "medium", "high", "—"];
for (const a of AXES) if (!KNOWN.has(a)) { console.error(`unknown --by axis '${a}' (known: ${[...KNOWN].join(", ")})`); process.exit(2); }
function axisValues(axis, j) {
  switch (axis) {
    case "cat": return [j.unit.cat];
    case "unit": return [`${j.unit.cat} ${j.unit.id}`];
    case "arm": return [j.arm];
    case "model": return [j.meta.model];
    case "bench-version": return [String(j.meta.bench_version ?? "—")];
    case "tools_hash": return [String(j.meta.tools_hash ?? "—")];
    case "git_head": return [String(j.meta.git_head ?? "—")];
    case "difficulty": return [j.row.difficulty ?? j.unit.difficulty ?? "—"];
    // "—" is a real value here, not a missing one: it marks a unit whose band has never been
    // measured at n>=10 for that arm (every non-T unit, and the without-arm of t9-t16).
    case "tool_dependence": return [j.unit.tool_dependence ?? "—"];
    case "reasoning_load": return [j.unit.reasoning_load ?? "—"];
    case "discipline": return j.unit.disciplines;
  }
}
/** Cartesian product of each axis's values → composite keys. */
function keysOf(j) {
  let keys = [""];
  for (const axis of AXES) {
    const vals = axisValues(axis, j);
    keys = keys.flatMap((k) => vals.map((v) => (k ? `${k} · ${v}` : v)));
  }
  return keys;
}

const groups = new Map();
for (const j of joined) for (const k of keysOf(j)) {
  if (!groups.has(k)) groups.set(k, cell());
  add(groups.get(k), j.unit, j.row);
}

// ---- render -------------------------------------------------------------------------------------
const filt = [MODEL && `model=${MODEL}`, BENCHVER && `bench_version=${BENCHVER}`].filter(Boolean).join(", ");
const unscored = joined.filter((j) => { const s = metrics(j.unit, j.row).succ; return s === null || s === undefined; }).length;
console.log(`# bench report — ${joined.length} rows from ${roots.length - filtered} dirs, by ${AXES.join("×")}` +
  `${filt ? ` [${filt}]` : ""}${unmatched ? ` (${unmatched} unmatched)` : ""}${errors ? ` (${errors} error rows)` : ""}\n`);
console.log(`| ${AXES.join(" × ")} | success 95% CI (scored/n) | conf-wrong | abstain | censored | turns | tok nc/wc | n |`);
console.log(`|---|---|---|---|---|---|---|---|`);
const onlyDiscipline = AXES.length === 1 && AXES[0] === "discipline";
// Band axes sort by severity, not alphabetically — "high" must not print between "—" and "low".
const onlyBand = AXES.length === 1 && (AXES[0] === "tool_dependence" || AXES[0] === "reasoning_load");
const order = onlyDiscipline ? DISCIPLINE_ORDER.filter((d) => groups.has(d))
  : onlyBand ? BAND_ORDER.filter((b) => groups.has(b))
    : [...groups.keys()].sort();
let flagged = 0;
for (const k of order) {
  const c = groups.get(k);
  const sc = successCell(c);
  if (sc.includes("†")) flagged++;
  console.log(`| ${k} | ${sc} | ${pct(c.cw)} | ${pct(c.ab)} | ${pct(c.tc)} | ${avg(c.tn)} | ${meanTok(c)} | ${c.n} |`);
}

// ---- footer disclosures -------------------------------------------------------------------------
console.log(`\n_disclosures:_ success is a 95% CI — Wilson for boolean cells, normal-approx (marked \`~\`) ` +
  `for graded cells (coverage/fidelity/deepest). \`†\` = below the min-n policy (seeds ≥ ${MIN_SEEDS}, reps ≥ ${MIN_REPS}) ` +
  `for a citable cell${flagged ? `; ${flagged} cell(s) flagged` : ""}. ` +
  `${unscored} of ${joined.length} rows unscored (success null; graded/censored/other).` +
  (splitRows ? ` ${splitRows} memory subrows carry EVENLY-SPLIT session tokens (per-question attribution approximate).` : "") +
  ` A5 CENSORING: turn-capped rows are CENSORED — excluded from success/conf-wrong/abstain (their budget ran out before the answer resolved), counted only in \`censored\` and in tokens (a lower bound). ` +
  `conf-wrong/abstain are means over rows where DEFINED (graded units drop out), not over all n.`);
if (onlyDiscipline) {
  const missing = DISCIPLINE_ORDER.filter((d) => !groups.has(d));
  if (missing.length) console.log(`\nNo scored rows yet for: ${missing.join(", ")} (run those units or see --index gaps).`);
}
