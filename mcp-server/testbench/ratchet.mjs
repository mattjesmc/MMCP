#!/usr/bin/env node
// The bench CONFORMANCE RATCHET (FREEZE_PLAN Workstream A1) — the instrument's own consistency
// contract, enforced offline over every result dir. No model spend, no bridge; pure join validation.
//
// Three checks, same spirit as the tool-output conformance suite:
//   (a) CLASSIFY   — every scored row joins EXACTLY ONE registry unit. A zero-match row is an orphan
//                    the reports would silently drop; a multi-match row would be double-counted.
//   (b) COVERAGE   — every unit a run's MANIFEST selected that PRODUCED rows had ≥1 SCORED. The
//                    fatal case is rows-present-but-none-scorable: a scorer that can't score its own
//                    unit's rows (an accessor defect, e.g. p_perceive scoring `honest`). A selected
//                    unit that produced NO rows at all (interrupted/crashed run, or rows deleted as
//                    artifacts) is an INCOMPLETE note, not a failure — that is the harness's concern
//                    (B1 --resume), not the instrument's; the allowlist documents the deliberate ones.
//   (c) COLLISION  — no two units' `match` accept the same recorded row (aggregated from (a)'s
//                    multi-matches, reported as the offending unit pairs).
//
// A result dir whose rows can't be cleanly classified fails the ratchet — new benches must declare a
// unit whose `match` claims their rows the day they ship. Genuinely-orphaned or deliberately-removed
// historical rows are ALLOWLISTED below with a reason (never silently tolerated).
//
//   node testbench/ratchet.mjs            # ratchet all dirs, print report, exit nonzero on any fail
//   node testbench/ratchet.mjs <dir ...>  # ratchet specific dirs only
// Consumed as a library by probes/bench-conformance.test.mjs.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { UNITS, categoryOfDir, C_CHANGE_UNIT_IDS } from "./registry.mjs";

const here = join(fileURLToPath(import.meta.url), "..");
export const RESULTS_ROOT = join(here, "..", "testbench-results");

// ---- ALLOWLIST — historical dirs where a manifest-declared unit legitimately has no scored row ----
// keyed "<dir>::<unitId>". Every entry is a reason the ratchet must NOT redden, not a silent skip.
// These are ABSENT-rows cases (deliberate deletions) — suppressed from the incomplete-coverage notes
// so intentional gaps read as documented, not as run debris.
export const ALLOWLIST = {
  "2026-07-25T07-40-59-objectives-haiku::e_milestone":
    "pre-latch-fix milestone rows deleted as artifacts (see session 2026-07-25 milestone LATCH fix)",
  "2026-07-25T07-40-59-objectives-haiku::e_dungeon":
    "pre-latch-fix dungeon rows deleted as artifacts (see session 2026-07-25 milestone LATCH fix)",
  "2026-07-25T07-18-18-diagnose-haiku::z_diag_whatif":
    "pre-BOOLEAN-fix whatif rows deleted as artifacts (quiz.mjs bool scorer mis-scored yes/no strings)",
};

// ---- row loading (mirrors bench-report.mjs; A2 will unify) ---------------------------------------
const jl = (p) => readFileSync(p, "utf8").split("\n").filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

/** Memory runs write one row per SESSION with per_question; expand to per-question subrows. Session
 *  tokens are split EVENLY across questions (an approximation bench-report discloses in its footer);
 *  `_split` marks the row so downstream can flag it. */
export function expandRow(row) {
  if (row.per_question && typeof row.per_question === "object") {
    const qs = Object.entries(row.per_question);
    const n = Math.max(1, qs.length);
    // `arm` carries the workflow when one is present (arch+revisit); older rows have neither field
    // and keep their plain arch label, so historical dirs pivot exactly as before.
    const arm = row.arm ?? row.arch ?? row.condition ?? "-";
    const split = (v) => Math.round((v ?? 0) / n);
    // A C row records its terminal state on the nested `quiz` object, so the SESSION-level censoring
    // axis never reached the per-question subrows — a stalled / runaway / no-tools quiz was scored
    // question-by-question exactly like a healthy one. Carry it down (2026-07-28); bench-report's
    // `metrics()` reads these names. Verified score-neutral on every current dir: the only non-success
    // C rows on disk are the two 2026-07-23 error_max_turns rows, which predate the 0.9.5 baseline.
    const sess = row.quiz ?? {};
    const stop = row.stop_reason ?? sess.stop_reason ?? sess.subtype ?? null;
    const capped = row.capped ?? sess.capped ?? null;
    return qs.map(([qid, q]) => ({
      id: qid, correct: !!q.exact, abstained: !!q.abstained, arm, seed: row.seed, _split: true,
      ...(stop === null ? {} : { stop_reason: stop === "success" ? "answered" : stop }),
      ...(capped === null ? {} : { capped }),
      tokens_in: split(row.tokens_in), tokens_out: split(row.tokens_out),
      cache_read: split(row.cache_read), cache_write: split(row.cache_write),
    }));
  }
  return [row];
}

// ---- manifest → the units a run INTENDED to produce (null = unresolvable, treated leniently) ------
const idsWhere = (pred) => UNITS.filter(pred).map((u) => u.id);
const asStrings = (a) => (Array.isArray(a) ? a.map(String) : null);

/** Resolve a manifest to the set of unit ids it selected, or null when the manifest is too old/loose
 *  to map (legacy tolerance — such a dir is recorded b-skipped, never failed). */
export function expectedUnitIds(dirCat, m) {
  if (!m) return null;
  switch (dirCat) {
    case "AB": {
      const cats = asStrings(m.categories) ?? [];
      const ids = [];
      if (cats.includes("a")) ids.push(...idsWhere((u) => u.cat === "AB" && /^a\d/.test(u.id)));
      if (cats.includes("b")) ids.push("b_formats");
      return new Set(ids);
    }
    case "T": {
      const rungs = asStrings(m.rungs);
      if (!rungs) return null;
      return new Set(idsWhere((u) => u.cat === "T" && rungs.includes(String(u.sel))));
    }
    case "C": {
      // Memory: no per-unit selector — the whole pack runs, but WHICH pack depends on the workflow.
      // `change` is a different quiz with its own question set, so a recall/revisit dir holds none of
      // its rows and must not be marked incomplete for that. Manifests older than the workflow axis
      // (pre-0.9.4) have no field and default to recall, exactly as they always resolved.
      const wf = asStrings(m.workflow) ?? ["recall"];
      const wantChange = wf.includes("change");
      const wantQuiz = wf.some((w) => w !== "change");
      const isChange = new Set(C_CHANGE_UNIT_IDS);
      return new Set(idsWhere((u) => u.cat === "C" && (isChange.has(u.id) ? wantChange : wantQuiz)));
    }
    case "P": {
      const sl = asStrings(m.slices) ?? (m.slice ? [m.slice] : []);
      const ids = [];
      if (sl.includes("perceive")) ids.push("p_perceive");
      if (sl.includes("survive")) ids.push("p_survive");
      return new Set(ids);
    }
    case "R":
      return new Set(["r_rotate"]);
    case "W": {
      const modes = asStrings(m.modes);
      if (!modes) return null;
      const map = { schematic: "w_schematic", repair: "w_repair" };
      return new Set(modes.map((x) => map[x]).filter(Boolean));
    }
    case "Z": {
      if (m.slice === "diagnose") {
        const kinds = asStrings(m.kinds);
        if (!kinds) return null;
        const map = { wiring: "z_diag_wiring", fault: "z_diag_fault", whatif: "z_diag_whatif" };
        return new Set(kinds.map((k) => map[k]).filter(Boolean));
      }
      const gates = asStrings(m.gates);
      if (!gates) return null;
      return new Set(gates.map((g) => `z_gate_${g.toLowerCase()}`));
    }
    case "E": {
      if (m.slice === "e-combat" || m.rounds != null) return new Set(["e_combat"]);
      if (m.slice === "e-traverse") {
        const n = Number(m.tiers) || 0;
        const ids = [];
        for (let t = 1; t <= n; t++) ids.push(`e_traverse_t${t}`);
        return new Set(ids);
      }
      if (m.slice === "objectives") {
        const fams = asStrings(m.families);
        if (!fams) return null;
        const map = { survive: "e_survive_build", ladder: "e_milestone", dungeon: "e_dungeon" };
        return new Set(fams.map((f) => map[f]).filter(Boolean));
      }
      // e-repair (bench 0.9.3): manifest `rungs` are the registry `sel` values verbatim, so resolve
      // through the registry rather than a second hand-kept map (iron_control → e_repair_control is
      // the one id that isn't a mechanical prefix of its rung).
      if (m.slice === "e-repair") {
        const rungs = asStrings(m.rungs);
        if (!rungs) return null;
        return new Set(idsWhere((u) => u.cat === "E" && u.runner === "run-repair.mjs" && rungs.includes(String(u.sel))));
      }
      return null;
    }
    default:
      return null;
  }
}

// ---- the ratchet ---------------------------------------------------------------------------------
/** Ratchet one dir. Returns { dir, dirCat, rows, errors, orphans, collisions, coverage } where
 *  coverage is { checked, missing:[unit], skipped:reason|null } and orphans/collisions are the (a)/(c)
 *  failures for this dir. */
export function ratchetDir(root) {
  const dir = root.split(/[\\/]/).pop();
  const dirCat = categoryOfDir(dir);
  const ap = join(root, "answers.jsonl");
  const out = { dir, dirCat, rows: 0, errors: 0, orphans: [], collisions: [], coverage: null };
  if (!existsSync(ap)) { out.coverage = { checked: 0, missing: [], skipped: "no answers.jsonl" }; return out; }

  const rowCount = new Map(); // unit id -> rows matched in this dir
  const scoredCount = new Map(); // unit id -> rows scored in this dir
  const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
  for (const raw of jl(ap)) {
    if (raw.error) { out.errors++; continue; }
    for (const row of expandRow(raw)) {
      out.rows++;
      const hits = UNITS.filter((u) => u.match(row, dirCat));
      if (hits.length === 0) {
        out.orphans.push({ id: row.id ?? row.scenario ?? "(no id)", keys: Object.keys(row).slice(0, 10) });
      } else if (hits.length > 1) {
        out.collisions.push({ id: row.id ?? row.scenario ?? "(no id)", units: hits.map((u) => u.id) });
      } else {
        const u = hits[0];
        bump(rowCount, u.id);
        const s = u.success(row);
        if (s !== null && s !== undefined) bump(scoredCount, u.id);
      }
    }
  }

  // (b) coverage — split by whether the unit produced any rows at all:
  //   unscorable = rows present, none scored  → FATAL (accessor defect)
  //   absent     = no rows                    → INCOMPLETE note (interrupted/deleted; allowlist docs it)
  const expected = expectedUnitIds(dirCat, readManifest(root));
  if (expected == null) out.coverage = { checked: 0, unscorable: [], absent: [], skipped: "manifest not resolvable to units" };
  else {
    const unscorable = [], absent = [];
    for (const id of expected) {
      if (ALLOWLIST[`${dir}::${id}`]) continue;
      const rows = rowCount.get(id) ?? 0;
      if (rows === 0) absent.push(id);
      else if ((scoredCount.get(id) ?? 0) === 0) unscorable.push(id);
    }
    out.coverage = { checked: expected.size, unscorable, absent, skipped: null };
  }
  return out;
}

function readManifest(root) {
  const mp = join(root, "manifest.json");
  if (!existsSync(mp)) return null;
  try { return JSON.parse(readFileSync(mp, "utf8")); } catch { return null; }
}

/** Ratchet a set of roots (default: all result dirs). Returns { pass, dirs, totals, failures }. */
export function ratchet(roots) {
  roots ??= readdirSync(RESULTS_ROOT).map((d) => join(RESULTS_ROOT, d))
    .filter((p) => statSync(p).isDirectory());
  const dirs = roots.map(ratchetDir);
  const collisionPairs = new Map(); // "a + b" -> count
  const failures = [];
  const incomplete = []; // non-fatal: selected units that produced no rows (interrupted/deleted)
  const totals = { rows: 0, errors: 0, orphans: 0, collisions: 0, bChecked: 0, bUnscorable: 0, bAbsent: 0, bSkipped: 0 };
  for (const d of dirs) {
    totals.rows += d.rows; totals.errors += d.errors;
    totals.orphans += d.orphans.length; totals.collisions += d.collisions.length;
    if (d.orphans.length) failures.push(`[${d.dir}] ${d.orphans.length} ORPHAN row(s): ` +
      d.orphans.slice(0, 5).map((o) => `${o.id}{${o.keys.join(",")}}`).join("; "));
    for (const c of d.collisions) {
      const key = [...c.units].sort().join(" + ");
      collisionPairs.set(key, (collisionPairs.get(key) ?? 0) + 1);
    }
    if (d.coverage.skipped) { totals.bSkipped++; continue; }
    totals.bChecked += d.coverage.checked;
    if (d.coverage.unscorable.length) {
      totals.bUnscorable += d.coverage.unscorable.length;
      failures.push(`[${d.dir}] selected unit(s) produced rows but NONE scorable: ${d.coverage.unscorable.join(", ")}`);
    }
    if (d.coverage.absent.length) {
      totals.bAbsent += d.coverage.absent.length;
      incomplete.push(`[${d.dir}] selected but produced no rows (interrupted/deleted): ${d.coverage.absent.join(", ")}`);
    }
  }
  for (const [pair, n] of collisionPairs)
    failures.push(`COLLISION: units [${pair}] both match ${n} row(s)`);
  return { pass: failures.length === 0, dirs, totals, failures, incomplete, collisionPairs };
}

// ---- CLI ----------------------------------------------------------------------------------------
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const roots = argv.length ? argv.map((a) => (a.includes("/") || a.includes("\\") ? a : join(RESULTS_ROOT, a))) : undefined;
  const r = ratchet(roots);
  const t = r.totals;
  console.log(`# bench conformance ratchet — ${r.dirs.length} dirs, ${t.rows} rows (${t.errors} error rows)\n`);
  console.log(`(a) classify : ${t.orphans} orphan, ${t.collisions} multi-match`);
  console.log(`(b) coverage : ${t.bChecked} selected-unit checks — ${t.bUnscorable} unscorable (fatal), ` +
    `${t.bAbsent} absent (incomplete), ${t.bSkipped} dir(s) manifest-unresolvable`);
  console.log(`(c) collision: ${r.collisionPairs.size} colliding unit pair(s)\n`);
  if (r.incomplete.length) {
    console.log(`incomplete coverage (non-fatal):`);
    for (const f of r.incomplete) console.log(`  · ${f}`);
    console.log("");
  }
  if (r.pass) {
    console.log(`RATCHET GREEN — every row classifies to exactly one unit; every unit that produced rows scored them.`);
    process.exit(0);
  }
  console.log(`RATCHET RED — ${r.failures.length} failure(s):\n`);
  for (const f of r.failures) console.log(`  - ${f}`);
  process.exit(1);
}
