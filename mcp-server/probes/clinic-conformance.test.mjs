// The combat clinic's CONFORMANCE RATCHET (world-model/COMBAT_CLINIC.md §9.2) — the
// `bench-conformance.test.mjs` precedent, pointed at `world-model/data/clinic/*.jsonl`.
//
// Offline. No bridge, no world, no model spend. It lives in probes/ for exactly one reason:
// `tools/battery.ps1` sweeps `probes/*.test.mjs`, so a rule that lives here gets read every time
// anybody asks whether the toolkit is healthy, and a rule that lives in a design document does not.
//
// WHAT IT HOLDS THE CORPUS TO. §6's schema invariants are not style — each one is a way the written
// file can lie to whoever reads it later, and the ratchet is the only thing standing between a lie
// and a number in a report:
//
//   - EVERY ROW JOINS EXACTLY ONE REGISTRY CELL. An orphan is a row every downstream aggregate
//     silently drops, so a renamed panel does not fail anything — it quietly removes trials from a
//     mean. And `panels.matchRow` deliberately ignores the row's own `cell_key` and rebuilds it
//     from the identity fields, so a hand-patched key is an orphan rather than a pass.
//   - A VOID ROW CARRIES NO `auto`. §4.2 puts the void check BEFORE the arithmetic precisely so a
//     contaminated trial produces a named hole and not a plausible number. A void row that still
//     carries metrics means somebody computed first and voided afterwards, and the metrics are of
//     an unknown fight.
//   - `0` IS NOT A SCORE. `rating: null` and `scores.X: null` mean UNRATED. If a rated zero were
//     legal, "nobody judged this" and "this was terrible" would be the same byte.
//   - `scope:"cell"` IS ONE JUDGEMENT (D-6). Per-cell rating copies one human opinion onto five
//     rows; counting those as five is fabrication dressed as agreement, and it is the ratchet — not
//     a paragraph — that refuses it.
//   - ONE (cell_key, trial) HOLDS ONE LIVE ROW, ACROSS THE WHOLE CORPUS. Re-running a panel in a
//     second sitting is the NORMAL way a bad session gets redone, and it writes a second .jsonl —
//     so `ledger.mjs`'s `cell_already_complete` guard, which is per-FILE by construction, never
//     sees it. Ten rows land in a five-trial cell and every downstream mean over `cell_key`
//     averages ten while clause (i) certifies five. The redo is legitimate; what is not legitimate
//     is leaving both copies live, and `replaces` is how a row says which one it retires.
//   - `metric_set`, `body_class` and `degraded[]` PARTITION THE POPULATION. A `human_reduced` row
//     has thirteen fewer columns than a `full` one; `entityFactor` puts the spear's damage gate at
//     4.6 for a player body and 0.92 for anything else (§8.1), so the same curve on two body
//     classes is two weapons. A mean across either describes nothing.
//
// THE SANITY FLOOR IS THE POINT OF THE WHOLE FILE, and it is the assertion to defend in review.
// Every join rule above passes VACUOUSLY over an empty corpus: zero orphans, zero collisions, zero
// bad ratings — a perfect green report about nothing. `bench-conformance.test.mjs:38` learned this
// the same way and guards it with `assert.ok(r.totals.rows > 500)`. This file separates the two
// states that an absent corpus can be in, because they need opposite answers:
//
//   the tree moved / the modules are gone   -> FAIL LOUDLY. The ratchet is misrouted; every
//                                              assertion below is meaningless and a green is a lie.
//   the corpus is genuinely not written yet -> SKIP LOUDLY, and say the directory name out loud.
//                                              No sitting has run; there is nothing to conform to.
//
// which is why the anchor test below asserts against `world-model/tools/clinic/panels.mjs` (a file
// that must exist) and not against `world-model/data/clinic/` (a directory that must not, yet).
// The registry tests always run, so this file contributes a known non-zero pass count to its chunk
// log even before the first sitting — §9.2's "two receipts", the half that is checkable today.
//
// HARD RULE (§9.2), restated where the temptation would be: no clinic file in probes/ may ever call
// `wm_session_tag`. battery.ps1 stamps the live session `purpose=battery` before running anything;
// a probe stamping `bench` would retag it, set `purpose_conflict`, and put a permanent black mark
// on the very manifest it is testing (`wm-rblock.test.mjs:26-28`). Nothing here touches the bridge.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { allCells, matchRow, cellKey, MANOEUVRES, SCORE_RANGE } from
  "../../world-model/tools/clinic/panels.mjs";
import { validateRow, isVoidReason, aggregationKey, independentJudgements, RATING_KEYS,
  RATING_SCOPES, VOID_REASONS, ROW_SCHEMA_VERSION } from "../../world-model/tools/clinic/row.mjs";
import { readLedger, resumeIndex } from "../../world-model/tools/clinic/ledger.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const REGISTRY = join(REPO, "world-model", "tools", "clinic", "panels.mjs");
const CORPUS = join(REPO, "world-model", "data", "clinic");   // §6: <yyyyMMdd-HHmmss>.jsonl

// §9.2's floor. It is a MISROUTE DETECTOR, not a quality bar — the question it answers is "did this
// ratchet actually look at a corpus", and 40 is the design's number (a single named panel is 20-45
// trials, so a corpus with fewer rows than one panel is almost certainly a corpus this file failed
// to find). ONE LEGITIMATE CASE WILL TRIP IT, and it is worth stating now rather than discovering
// it at 2am: build-order step 5 runs `spear-target-half` alone, which is 25 trials. If that is the
// only sitting on disk, lower this constant DELIBERATELY and leave the reason — the guard is worth
// keeping at a lower number and worthless deleted.
const MIN_ROWS = 40;

// ---- load ------------------------------------------------------------------------------------

/** `{state, why, files, rows, fileOf}`. `state` is one of `anchored-missing` (skip),
 *  `empty-dir` (skip) or `present`. The row objects are handed back UNMODIFIED — no `__file` key,
 *  no normalisation — because `row.mjs`'s top-level key set is CLOSED and a probe that decorated a
 *  row would make every row it loaded fail `validateRow` for a reason the probe invented. */
function loadCorpus(dir) {
  const fileOf = new Map();
  if (!existsSync(dir)) {
    return { state: "anchored-missing", files: [], rows: [], fileOf,
      why: `no such directory: ${dir}` };
  }
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
  if (files.length === 0) {
    return { state: "empty-dir", files, rows: [], fileOf,
      why: `${dir} exists but holds no .jsonl ledger` };
  }
  const rows = [];
  for (const f of files) {
    for (const row of readLedger(join(dir, f))) {
      rows.push(row);
      fileOf.set(row, f);
    }
  }
  return { state: "present", files, rows, fileOf, why: null };
}

const CORPUS_DATA = loadCorpus(CORPUS);
const PRESENT = CORPUS_DATA.state === "present";

// Said out loud, in the battery log, every run. A ratchet that skips quietly is indistinguishable
// from a ratchet that passed, which is the thing this whole file is against.
process.stdout.write(
  `[clinic-conformance] corpus root: ${CORPUS}\n` +
  (PRESENT
    ? `[clinic-conformance] ${CORPUS_DATA.files.length} ledger file(s), ` +
      `${CORPUS_DATA.rows.length} row(s)\n`
    : `[clinic-conformance] NO CORPUS — ${CORPUS_DATA.why}\n` +
      "[clinic-conformance] the join assertions below are SKIPPED, not passed. No clinic sitting " +
      "has written a ledger yet (design build order step 5 is the first one that does).\n"));

const SKIP = PRESENT ? false : `no clinic corpus yet — ${CORPUS_DATA.why}`;

/** `panel/arena/loadout/arm[/bucket]` for a ROW, without consulting `row.cell_key`. */
function identityKey(row) {
  return cellKey({ panel: row.panel, arena: row.arena, loadout: row.loadout, arm: row.arm,
    bucket: row.bucket ?? null });
}

const where = (row) => `${CORPUS_DATA.fileOf.get(row) ?? "?"}:${row?.row_id ?? "?"}`;

/** Format a list of offenders for an assertion message, capped so a systemic break does not print
 *  four thousand lines and bury the count that says it is systemic. */
function offenders(list, n = 12) {
  return list.slice(0, n).map((s) => `  ${s}`).join("\n") +
    (list.length > n ? `\n  … and ${list.length - n} more` : "");
}

// ---- the anchor: always runs, and is the difference between "skip" and "lie" -------------------

test("the ratchet is pointed at this repo (anchor, not the corpus)", () => {
  // The corpus MAY be absent. The registry may not: if `panels.mjs` is not where this file resolves
  // it, then `CORPUS` was resolved from the same wrong place, and every skip below is a misroute
  // reported as an absence. This is the assertion that makes a green trustworthy.
  assert.ok(existsSync(REGISTRY), `clinic registry not found at ${REGISTRY}. This probe resolves ` +
    "both the registry and the corpus root from its own location, so a registry it cannot see " +
    "means the corpus root is wrong too — and an empty corpus root passes every join rule below " +
    "vacuously. Fix the path here, never the assertions.");
  assert.ok(allCells().length > 0, "the panel registry resolved to zero cells");
});

test("the registry is self-consistent — keys unique, every cell matchable", () => {
  const cellsAll = allCells();
  const keys = new Set();
  const dupes = [];
  for (const c of cellsAll) {
    if (keys.has(c.cell_key)) dupes.push(c.cell_key);
    keys.add(c.cell_key);
  }
  assert.deepEqual(dupes, [], `duplicate cell keys in the registry:\n${offenders(dupes)}`);

  // The join, exercised against the registry itself. If a cell cannot classify a row built from
  // its own identity fields, then no real row of that cell can either — and every trial it ever
  // produces would be an orphan. Cheaper to learn here than after 40 trials.
  const unmatchable = cellsAll
    .filter((c) => matchRow({ panel: c.panel, arena: c.arena, loadout: c.loadout, arm: c.arm,
      bucket: c.bucket, cell_key: c.cell_key }) !== c.cell_key)
    .map((c) => c.cell_key);
  assert.deepEqual(unmatchable, [],
    `registry cells whose own identity does not join back to them:\n${offenders(unmatchable)}`);
});

test("the rating vocabulary is ONE vocabulary across the two modules", () => {
  // row.mjs duplicates panels.mjs's manoeuvre list rather than importing it (it must validate an
  // old file without the panel registry loaded), so the two copies can drift — and the drift is
  // invisible: a row rated on a manoeuvre panels.mjs no longer knows about validates fine and
  // aggregates into nothing. This is the only place the two are compared.
  assert.deepEqual([...MANOEUVRES], [...RATING_KEYS],
    "panels.MANOEUVRES and row.RATING_KEYS have drifted apart");
  assert.deepEqual(SCORE_RANGE, { min: 1, max: 5 },
    "the score range moved; `0` must stay illegal or unrated and rated-zero become the same byte");
});

// ---- the corpus: skipped, loudly, until a sitting writes one -----------------------------------

test("the corpus actually parsed (ledger files exist and yielded rows)", { skip: SKIP }, () => {
  // Only reachable when .jsonl files are on disk. Files present and zero rows parsed is not an
  // empty corpus — it is a reader that cannot read what the writer wrote, and it must be red.
  assert.ok(CORPUS_DATA.rows.length > 0,
    `${CORPUS_DATA.files.length} ledger file(s) in ${CORPUS} parsed to ZERO rows: ` +
    `${CORPUS_DATA.files.join(", ")}`);
});

test("(a) every row joins exactly one registry cell — no orphans", { skip: SKIP }, () => {
  const orphans = CORPUS_DATA.rows
    .filter((r) => matchRow(r) === null)
    .map((r) => `${where(r)} — ${identityKeySafe(r)} (stored cell_key: ${r?.cell_key ?? "—"})`);
  assert.deepEqual(orphans, [],
    "rows that classify to no registry cell. Every aggregate downstream DROPS these silently, so " +
    "a renamed panel thins a mean instead of failing anything. Note matchRow ignores the stored " +
    `cell_key on purpose: a disagreement between it and the identity fields is an orphan.\n` +
    offenders(orphans));
});

function identityKeySafe(row) {
  try { return identityKey(row); } catch (e) { return `<unkeyable: ${e.message}>`; }
}

test("(b) no two registry cells accept the same row — no collisions", { skip: SKIP }, () => {
  // Computed WITHOUT matchRow. matchRow builds one key and looks it up, so asking it about
  // collisions is asking a map whether it has duplicate keys — true by construction, and a check
  // that cannot fail is not a check. This scans every cell for every row.
  const index = allCells();
  const collisions = [];
  for (const row of CORPUS_DATA.rows) {
    const hits = index.filter((c) =>
      c.panel === row.panel && c.arena === row.arena && c.loadout === row.loadout &&
      c.arm === row.arm && (c.bucket ?? null) === (row.bucket ?? null));
    if (hits.length > 1) {
      collisions.push(`${where(row)} → ${hits.map((h) => h.cell_key).join(" | ")}`);
    }
  }
  assert.deepEqual(collisions, [],
    `rows accepted by more than one cell — every one of them is DOUBLE-COUNTED:\n` +
    offenders(collisions));
});

/**
 * §9.2's required-key list, applied to ONE row. Returns the complaints, or [].
 *
 * TWO OF THE KEYS ARE CONDITIONAL, and the condition is stated by the row itself. §4.1 step 3
 * defines `--live-only` as "run without the recorder, stamping `rec:false` on EVERY row" — and both
 * `session_dir` and `world.toolkit_version` are read out of the recorder's `<session_dir>/
 * manifest.json`, so under that flag neither exists. Demanding them unconditionally made a
 * documented flag unable to write a single row, and it made this ratchet certain to redden on the
 * first legitimate `--live-only` sitting. The relaxation is EXACTLY row.mjs's (they are one
 * contract, split across two modules, so they are written to match line for line):
 *
 *   rec === true   ⇒  session_dir is a non-empty string
 *   rec === false  ⇒  session_dir is EXACTLY null — the key is present and states the absence,
 *                     because a missing key is indistinguishable from a driver that forgot
 *   toolkit_version non-null UNLESS `degraded[]` carries "toolkit_version_unread", which is the
 *   hole preflight already names for it — and a degraded row is its own aggregation population
 *   (clause (h)), so the relaxation cannot leak into a clean mean.
 */
function requiredKeyComplaints(row) {
  const REQUIRED = ["panel", "arena", "loadout", "arm", "trial", "session",
    "t_open_tick", "t_close_tick", "status"];
  const out = REQUIRED.filter((k) => row?.[k] === undefined || row[k] === null);

  if (row?.world?.difficulty === undefined || row.world.difficulty === null) {
    out.push("world.difficulty");
  }
  const degraded = Array.isArray(row?.degraded) ? row.degraded : [];
  if ((row?.world?.toolkit_version === undefined || row.world.toolkit_version === null) &&
      !degraded.includes("toolkit_version_unread")) {
    out.push('world.toolkit_version (null, and degraded[] does not carry "toolkit_version_unread")');
  }

  if (row?.rec === true) {
    if (typeof row.session_dir !== "string" || !row.session_dir) {
      out.push("session_dir (rec:true says a recorder was running, so the join to phase 2 exists " +
        "and must be written)");
    }
  } else if (row?.rec === false) {
    if (!Object.hasOwn(row, "session_dir") || row.session_dir !== null) {
      out.push(`session_dir must be exactly null when rec:false (got ` +
        `${JSON.stringify(row.session_dir)}) — no recorder ran, and that absence is a STATED fact`);
    }
  } else {
    out.push(`rec (a boolean; session_dir's requirement is read off it, got ` +
      `${JSON.stringify(row?.rec)})`);
  }
  return out;
}

test("(c) the required keys are on every row", { skip: SKIP }, () => {
  // §9.2's list: these are the join keys: without them a row cannot be tied back to the recorder
  // session, the world it ran in, or the tick window it covers — "unjoinable to phase 2 FOREVER" is
  // §6's own phrasing, and it is not recoverable after the server stops.
  const bad = [];
  for (const row of CORPUS_DATA.rows) {
    const missing = requiredKeyComplaints(row);
    if (missing.length) bad.push(`${where(row)} — missing ${missing.join(", ")}`);
  }
  assert.deepEqual(bad, [], `rows missing required keys:\n${offenders(bad)}`);
});

test("(c) is the SAME contract row.mjs applies — checked on fabricated rows, not on an absent corpus",
  () => {
    // ALWAYS RUNS. Clause (c) itself is skipped until a sitting writes a ledger, so the relaxation
    // above would otherwise ship unexercised — and its whole purpose is to accept a shape no corpus
    // on disk has ever contained yet (`--live-only`).
    const live = { rec: false, session_dir: null, panel: "p", arena: "a", loadout: "l", arm: "human",
      trial: 1, session: "s", t_open_tick: 1, t_close_tick: 2, status: "measured", degraded: [],
      world: { difficulty: "hard", toolkit_version: "0.75.0" } };
    assert.deepEqual(requiredKeyComplaints(live), [],
      "a valid --live-only row (rec:false, session_dir:null) must pass — it is the one shape §4.1 " +
      "step 3 promises and the ratchet used to refuse");
    assert.deepEqual(requiredKeyComplaints({ ...live, rec: true }).length, 1,
      "rec:true with session_dir:null is unjoinable to phase 2 and must still be refused");
    assert.deepEqual(requiredKeyComplaints({ ...live, session_dir: undefined }).length, 1,
      "rec:false with the KEY ABSENT is not a stated absence — null is");

    const noVersion = { ...live, world: { difficulty: "hard", toolkit_version: null } };
    assert.equal(requiredKeyComplaints(noVersion).length, 1,
      "a null toolkit_version with a clean degraded[] is an unexplained hole");
    assert.deepEqual(requiredKeyComplaints({ ...noVersion, degraded: ["toolkit_version_unread"] }), [],
      "…but the row that NAMES the hole in degraded[] is honest, and clause (h) already keeps it " +
      "out of every clean mean");
  });

test("(d) every row validates against the v1 row schema", { skip: SKIP }, () => {
  // The per-row half of §6, delegated to the module that owns it. Rows stamped with a different
  // schema version are SKIPPED rather than failed: a v2 row is not a broken v1 row, and a ratchet
  // that reddened on a deliberate migration would be turned off during the migration.
  const bad = [];
  for (const row of CORPUS_DATA.rows) {
    if (row?.v !== ROW_SCHEMA_VERSION) continue;
    const v = validateRow(row);
    if (!v.ok) bad.push(`${where(row)} — ${v.errors.join("; ")}`);
  }
  assert.deepEqual(bad, [], `rows that do not satisfy the §6 schema:\n${offenders(bad)}`);
});

test("(e) rated manoeuvres are in the closed vocabulary; 0 is not a score", { skip: SKIP }, () => {
  const bad = [];
  for (const row of CORPUS_DATA.rows) {
    const rating = row?.rating;
    if (rating == null) continue;                    // unrated, and null is how that is said
    if (!RATING_SCOPES.includes(rating.scope)) {
      bad.push(`${where(row)} — rating.scope ${JSON.stringify(rating.scope)} not in ` +
        RATING_SCOPES.join("|"));
    }
    const scores = rating.scores ?? {};
    for (const [k, v] of Object.entries(scores)) {
      if (!MANOEUVRES.includes(k)) {
        bad.push(`${where(row)} — manoeuvre ${JSON.stringify(k)} is outside the closed vocabulary`);
        continue;
      }
      if (v === null) continue;                      // explicitly unrated on this manoeuvre
      if (!Number.isInteger(v) || v < SCORE_RANGE.min || v > SCORE_RANGE.max) {
        bad.push(`${where(row)} — ${k}=${JSON.stringify(v)}; a score is an integer ` +
          `${SCORE_RANGE.min}-${SCORE_RANGE.max} or null. ` +
          (v === 0 ? "0 is NOT a score: it would make unrated and rated-zero the same byte." : ""));
      }
    }
    for (const k of MANOEUVRES) {
      if (!Object.hasOwn(scores, k)) {
        bad.push(`${where(row)} — no ${k} key at all. Absent and null are different claims; a ` +
          "panel that rates two manoeuvres writes null for the other three.");
      }
    }
  }
  assert.deepEqual(bad, [], `rating sheet violations:\n${offenders(bad)}`);
});

test("(f) void rows name a reason and carry NO auto", { skip: SKIP }, () => {
  const bad = [];
  for (const row of CORPUS_DATA.rows) {
    if (row?.status !== "void") continue;
    if (!isVoidReason(row.void_reason)) {
      bad.push(`${where(row)} — void_reason ${JSON.stringify(row.void_reason)} is not in the ` +
        `closed set (${VOID_REASONS.join(", ")})`);
    }
    // The KEY, not the value: `auto: null` still satisfies every `row.auto !== undefined` test a
    // reader will write downstream. §4.2's ordering is that the void is decided BEFORE the
    // arithmetic runs, so a void row that carries an `auto` at all means somebody measured a
    // contaminated fight and then noticed.
    if (Object.hasOwn(row, "auto")) {
      bad.push(`${where(row)} — void (${row.void_reason}) but carries an \`auto\` key ` +
        `(${row.auto === null ? "null" : "populated"}); a voided trial is a named hole, not a ` +
        "sample");
    }
  }
  assert.deepEqual(bad, [], `void rows that still look measurable:\n${offenders(bad)}`);
});

test("(g) scope:\"cell\" ratings are ONE judgement, not five", { skip: SKIP }, () => {
  // Two halves, and both are needed. First: the count must actually collapse — if it does not,
  // `independentJudgements` is broken and every report built on it inflates the human sample 5×.
  // Second: the five sibling rows must genuinely carry the SAME scores, because a per-cell rating
  // that differs per trial is a per-trial rating wearing the wrong scope, and reading it as one
  // judgement discards four real ones.
  const rated = CORPUS_DATA.rows.filter((r) => r?.rating != null);
  const cellScoped = rated.filter((r) => r.rating.scope === "cell");
  const judgements = independentJudgements(CORPUS_DATA.rows);
  if (cellScoped.length > 0) {
    assert.ok(judgements.count < rated.length,
      `${cellScoped.length} rows carry a cell-scoped rating but independentJudgements() still ` +
      `counts ${judgements.count} of ${rated.length} rated rows as independent`);
  }

  const byCell = new Map();
  for (const row of cellScoped) {
    const key = row.cell_key ?? identityKeySafe(row);
    byCell.set(key, [...(byCell.get(key) ?? []), row]);
  }
  const bad = [];
  for (const [key, rows] of byCell) {
    const canon = JSON.stringify(rows[0].rating.scores);
    for (const row of rows.slice(1)) {
      if (JSON.stringify(row.rating.scores) !== canon) {
        bad.push(`${key} — ${where(rows[0])} and ${where(row)} disagree; a cell-scoped rating is ` +
          "one judgement stamped on every trial, so differing scores mean the scope is wrong");
      }
    }
  }
  assert.deepEqual(bad, [], `cell-scoped ratings that are not identical across siblings:\n` +
    offenders(bad));
});

test("(h) a cell never spans two populations (metric_set / body_class / degraded)",
  { skip: SKIP }, () => {
    // The executable form of §6's last three invariants. A reader averages WITHIN a cell, so the
    // rule bites exactly here: if one cell's five trials straddle two aggregation partitions, the
    // cell's mean is across two instruments and there is no way to notice from the number.
    const byCell = new Map();
    for (const row of CORPUS_DATA.rows) {
      if (row?.status === "void") continue;          // a hole belongs to no population
      const key = row?.cell_key ?? identityKeySafe(row);
      const part = aggregationKey(row);
      const seen = byCell.get(key) ?? new Map();
      seen.set(part, [...(seen.get(part) ?? []), where(row)]);
      byCell.set(key, seen);
    }
    const bad = [];
    for (const [key, parts] of byCell) {
      if (parts.size > 1) {
        bad.push(`${key} spans ${parts.size} populations:\n` +
          [...parts.entries()].map(([p, ids]) => `      ${p}  ← ${ids.join(", ")}`).join("\n"));
      }
    }
    assert.deepEqual(bad, [], `cells whose own trials must not be averaged together:\n` +
      offenders(bad));
  });

test("(i) trials-per-cell is the planned count, or the shortfall is a named void",
  { skip: SKIP }, () => {
    // Departure 9: 5 is a FLOOR WITH NAMED VOIDS. A cell that reports n=4 must say why in the file;
    // a cell that is simply short of rows says nothing at all, and its mean is quietly over four
    // samples. This is THE SHORTFALL CHECK and nothing else: `resumeIndex` counts distinct trial
    // SLOTS, so ten rows in a five-trial cell read as five here and the over-count branch below is
    // unreachable for any schema-valid corpus (`validateRow` refuses `trial > trials_planned`
    // outright). It shipped believing itself to be the double-count guard, and it is not — clause
    // (j) is, taken across files and before the slot collapse. The branch stays as a belt for a
    // corpus written by some future driver that skips the row validator.
    const index = resumeIndex(CORPUS_DATA.rows);
    const bad = [];
    for (const e of index.values()) {
      if (e.trials_planned == null) {
        bad.push(`${e.cell_key} — no row states trials_planned, so "short" is undefined`);
        continue;
      }
      if (e.trials > e.trials_planned) {
        bad.push(`${e.cell_key} — ${e.trials} live trial SLOTS for a ${e.trials_planned}-trial ` +
          "cell, which validateRow refuses per row, so this corpus was written past the schema. " +
          "(The doubled-rows form of the resume bug is clause (j)'s, not this one.)");
        continue;
      }
      if (e.trials < e.trials_planned) {
        bad.push(`${e.cell_key} — ${e.trials}/${e.trials_planned} slots filled and the missing ` +
          "slot carries no row, so nothing in the file names the hole. Finish the cell with " +
          "--resume, or the shortfall is invisible to every reader.");
      }
    }
    assert.deepEqual(bad, [], `cells whose trial count cannot be read honestly:\n${offenders(bad)}`);
  });

/**
 * Every `(cell_key, trial)` pair holding more than one LIVE row — corpus-wide, across files.
 *
 * WHY THIS IS NOT CLAUSE (i) AGAIN. Clause (i) reads `resumeIndex`, and `resumeIndex` counts
 * DISTINCT trial slots (`if (… && !e.slots.includes(r.trial)) e.slots.push(r.trial)`,
 * ledger.mjs:219). Ten rows in a five-trial cell collapse to five slots there, so `e.trials >
 * e.trials_planned` is UNREACHABLE for any schema-valid corpus — `validateRow` already refuses
 * `trial > trials_planned`, so no row can even occupy a sixth slot. Clause (i)'s double-count
 * branch could not fire, and the double-count it describes passed silently: two sittings of
 * `baseline` written as two .jsonl files, ten rows per five-trial cell, and this probe reported
 * 14 pass / 0 fail. So the count has to be taken BEFORE the slot collapse, and across files —
 * which is precisely the seam `ledger.mjs` cannot cover, because `guardCell` only ever sees the
 * rows of the file it has open (ledger.mjs:120-123 says so in as many words).
 *
 * `replaces` is the legitimate redo: a row named by some other row's `replaces` is superseded and
 * drops out, exactly as `resumeIndex` treats it. That makes the remedy for a real re-run concrete
 * — write the second sitting's rows with `replaces:<row_id>` — rather than "do not re-run panels".
 *
 * @param {Array<{row: object, file: string}>} entries
 * @returns {Array<{pair: string, where: string[]}>}
 */
function liveDuplicates(entries) {
  const superseded = new Set();
  for (const { row } of entries) {
    if (typeof row?.replaces === "string" && row.replaces) superseded.add(row.replaces);
  }
  const byPair = new Map();
  for (const { row, file } of entries) {
    if (typeof row?.cell_key !== "string" || !row.cell_key) continue;  // orphans are clause (a)'s
    if (!Number.isInteger(row?.trial)) continue;                       // unkeyed slot: clause (d)'s
    if (superseded.has(row?.row_id)) continue;
    const pair = `${row.cell_key} trial ${row.trial}`;
    byPair.set(pair, [...(byPair.get(pair) ?? []), `${file}:${row?.row_id ?? "?"}`]);
  }
  return [...byPair.entries()]
    .filter(([, w]) => w.length > 1)
    .map(([pair, w]) => ({ pair, where: w }));
}

test("(j) one (cell_key, trial) holds ONE live row, across ALL files", { skip: SKIP }, () => {
  const entries = CORPUS_DATA.rows.map((row) => ({ row, file: CORPUS_DATA.fileOf.get(row) ?? "?" }));
  const dupes = liveDuplicates(entries)
    .map((d) => `${d.pair} — ${d.where.length} live rows: ${d.where.join(", ")}`);
  assert.deepEqual(dupes, [],
    "the same trial of the same cell is written more than once and NEITHER copy is retired. Every " +
    "downstream mean over cell_key counts them all, while clause (i) certifies the planned count " +
    "(it reads distinct trial SLOTS, so a doubled cell looks complete to it). If the second " +
    "sitting is the one to keep, write its rows with `replaces:<row_id>` naming the rows it " +
    "supersedes — that is the only statement in the schema that retires a row.\n" +
    offenders(dupes));
});

test("(j) is a real check — a second sitting of one panel is caught, and `replaces` clears it", () => {
  // ALWAYS RUNS, and it is the assertion that would have caught the shipped defect: the corpus
  // clause above is skipped until a ledger exists, and the branch it replaces was unreachable for
  // any schema-valid corpus, so "green" said nothing either way. These rows are the reviewer's
  // reproduction, minimised: two files, one cell, the same five trial slots in both.
  const sitting = (file, ids) => ids.map((n) => ({
    file,
    row: { row_id: `${file}-r${n}`, cell_key: "baseline/field/iron_sword/both", trial: n },
  }));
  const monday = sitting("20260901-100000.jsonl", [1, 2, 3, 4, 5]);
  const tuesday = sitting("20260902-100000.jsonl", [1, 2, 3, 4, 5]);

  assert.deepEqual(liveDuplicates(monday), [],
    "one clean five-trial sitting is not a duplicate of anything");

  const both = liveDuplicates([...monday, ...tuesday]);
  assert.equal(both.length, 5, "all five slots are doubled, so all five must be named");
  for (const d of both) {
    assert.equal(d.where.length, 2);
    assert.ok(d.where.some((w) => w.startsWith("20260901")) &&
      d.where.some((w) => w.startsWith("20260902")),
      `the message must name BOTH files or nobody can tell which sitting to retire: ${d.where}`);
  }

  // The legitimate redo: Tuesday says what it supersedes, so Monday's rows stop being live.
  const retired = tuesday.map((e) => ({
    file: e.file,
    row: { ...e.row, replaces: `20260901-100000.jsonl-r${e.row.trial}` },
  }));
  assert.deepEqual(liveDuplicates([...monday, ...retired]), [],
    "`replaces` is the schema's way to redo a sitting; a check that refused it would only teach " +
    "people to delete the evidence instead");

  // And the slot collapse this exists to get around: resumeIndex sees the doubled cell as complete.
  const doubled = [...monday, ...tuesday].map((e) => ({ ...e.row, trials_planned: 5 }));
  const idx = resumeIndex(doubled).get("baseline/field/iron_sword/both");
  assert.equal(idx.trials, 5, "resumeIndex collapses ten rows to five distinct slots…");
  assert.equal(idx.rowIds.length, 10, "…while ten rows are live in it — which is the whole defect");
  assert.ok(idx.trials <= idx.trials_planned,
    "so clause (i)'s `trials > trials_planned` branch cannot fire here, and never could");
});

test("SANITY FLOOR — the ratchet actually looked at a corpus", { skip: SKIP }, () => {
  // The assertion the whole file is built around. Every join rule above is vacuously true over an
  // empty or misrouted corpus, and a vacuous green reports the instrument HEALTHY.
  assert.ok(CORPUS_DATA.rows.length > MIN_ROWS,
    `expected more than ${MIN_ROWS} clinic rows, saw ${CORPUS_DATA.rows.length} across ` +
    `${CORPUS_DATA.files.length} file(s) in ${CORPUS}.\n` +
    "  Two legitimate readings, and they need different fixes:\n" +
    "   - the corpus root moved, or a sitting wrote somewhere else: every assertion above just " +
    "passed over nothing. Fix the path.\n" +
    "   - a deliberately short sitting (build order step 5 is spear-target-half, 25 trials): lower " +
    "MIN_ROWS in this file WITH A NOTE. The guard is worth keeping at a lower number and " +
    "worthless deleted.");
});
