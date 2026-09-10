// Resume support (FREEZE_PLAN B1) — shared by every runner, so the rules live in ONE place and are
// unit-testable without touching a server or spending a token.
//
// The contract: answers.jsonl is append-only, so "what already ran" is simply read back off disk.
// Resuming re-enters an existing result dir and skips the cells it already holds.
//
// The dangerous half is not the skipping, it is the POOLING. A resumed dir ends up holding rows from
// two invocations, and if anything that changes what a row MEANS moved in between, the halves are
// not the same measurement — but they land in one dir, under one manifest, and every downstream
// report treats a dir as homogeneous. So drift is FATAL, never a warning. `tools_hash` is in the
// guarded set for a reason found the hard way: on 2026-07-26 `e_repair_bridge_gap` read 60% purely
// because a pre-fix toolkit build pooled with post-fix builds under one unchanged bench_version.

import * as fs from "node:fs";
import { join } from "node:path";

/** Manifest fields that must be identical to resume: each one changes what a row means. */
export const RESUME_GUARDED = [
  "bench_version", "model", "adapter", "tools_hash", "questions_hash",
  // `routes_hash` is the SECOND SUT axis, added 2026-08-02 with the route layer
  // (ROUTE_LEDGER_DESIGN.md §8). It exists because `tools_hash` structurally cannot cover it: a
  // route changes what `locate` can answer without adding, removing or rewording a single manifest
  // entry, so two runs whose vocabularies differ hash identically on tools and pool silently. Same
  // failure as e_repair_bridge_gap above, through a door that fingerprint does not watch. Runs
  // predating the field carry `undefined` on both sides and compare equal, so nothing historical
  // is retroactively unresumable.
  "routes_hash",
];

/**
 * Compare a prior manifest against the current invocation's.
 * @param prior the manifest.json already in the dir
 * @param current the manifest this invocation would have written
 * @param extra additional keys to guard (per-runner selectors: rungs, arms, seeds, reps, tiers…)
 * @returns array of human-readable drift descriptions; empty means safe to resume.
 */
export function resumeDrift(prior, current, extra = []) {
  const out = [];
  for (const k of [...RESUME_GUARDED, ...extra]) {
    // Compare arms by NAME set: the spec bodies carry incidental ordering, but a changed arm name
    // set means the run is asking a different question.
    const norm = (v) => (k === "arms" && v && !Array.isArray(v) ? Object.keys(v).sort() : v);
    const a = JSON.stringify(norm(prior?.[k]) ?? null);
    const b = JSON.stringify(norm(current?.[k]) ?? null);
    if (a !== b) out.push(`${k}: ${a} → ${b}`);
  }
  return out;
}

/**
 * Cells already completed, from the rows on disk.
 * An ERROR row is NOT complete: an exception is not a result, so the cell is retried rather than
 * left as a permanent hole. The error row itself stays on disk as the record that it happened.
 * An INSTRUMENT-FAILURE row (`instrument_failure` — a session that opened with no tool surface, see
 * session-guards) is not complete either, and for the same reason: it measured nothing. A stall or a
 * runaway DOES complete the cell — those are typed evidence about the session, censored downstream
 * but not re-run on a resume, which would silently re-roll a real outcome.
 * @param rows parsed answers.jsonl rows
 * @param keyOf row → cell key (per-runner: id|arm|rep, course|arm|seed, …)
 */
export function completedCells(rows, keyOf) {
  const done = new Set();
  for (const r of rows) {
    if (!r || r.error || r.instrument_failure) continue;
    const k = keyOf(r);
    if (k != null) done.add(k);
  }
  return done;
}

/**
 * Does a usable memory corpus already sit in `memDir`?
 *
 * Category C's arms are only comparable because they share ONE frozen corpus, so a partially-done
 * seed must REUSE what is on disk rather than rebuild it. Getting this predicate wrong is worse than
 * having no reuse at all: a false negative re-runs explore into the SAME directory, layering a second
 * pass on top of the first, and the arms that run afterwards are then quizzed against a corpus no
 * earlier arm ever saw — the exact pooling hazard the reuse branch exists to prevent.
 *
 * That is not hypothetical. The original check looked for `<memDir>/log.jsonl`, but the store
 * namespaces by world and writes `<memDir>/<world-uuid>/log.jsonl`, so it was ALWAYS false and the
 * reuse branch was dead code (found 2026-07-28, mid-run). It survived B1's end-to-end verification
 * because that test resumed a COMPLETE dir, which short-circuits at the all-arms-done check and never
 * evaluates this predicate — a reminder that verifying the happy path verifies the happy path.
 */
export function corpusOnDisk(memDir, { existsSync, readdirSync } = fs) {
  if (!existsSync(memDir)) return false;
  return readdirSync(memDir, { withFileTypes: true })
    .some((d) => d.isDirectory() && existsSync(join(memDir, d.name, "log.jsonl")));
}

/** Parse an append-only JSONL file body, skipping torn/partial trailing lines (a killed run's last
 *  write may be incomplete — that line is not a result and must not abort the resume). */
export function parseRows(text) {
  const rows = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* torn line from a kill — skip */ }
  }
  return rows;
}
