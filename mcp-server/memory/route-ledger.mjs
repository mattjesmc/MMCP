// The failure ledger — what the toolkit could not answer, across every session
// (ROUTE_LEDGER_DESIGN.md §2).
//
// Before this file, a failed tool call left no trace anywhere. `BridgeServer.audit()` fires only for
// WORLD_EDIT/PRIVILEGED mechanisms and `locate` is `observe`, so it is excluded by design;
// `EventLog` is an in-memory ring that dies with the game; the shim turned `ok:false` into
// `isError:true` text and forgot it. Worse for the vocabulary question specifically: the
// unresolvable-`what` fallthrough (index.mjs) CONVERTS a concept miss into a plausible answer from
// memory, so the single most informative failure the tool has was being erased on the way out.
//
// What this is for. LOCATE_ROUTES.md's sixteen findings and its "Still open, RANKED" list were
// produced by reading code and reasoning about what a model might ask. This makes that empirical:
// the ranking becomes a frequency table over what models actually asked and did not get.
//
// The four buckets are the point. A pooled "errors" count is useless because each class wants a
// different fix, and three of the four are not route problems at all:
//
//   vocabulary  — `what` resolved against no registry ("tree").        → a route (routes.mjs)
//   affordance  — well-formed, wrong: `occupancy` on a non-POI route,  → error text / schema wording
//                 `detail:"full"` on the tool that hasn't got it.        (PATTERN_SEARCH §Findings 6:
//                                                                         error text is a routing
//                                                                         surface, and both shipped
//                                                                         discovery fixes were
//                                                                         error-remedy edits)
//   capability  — legal question, refused BY DESIGN: `in:` on a         → the audit's open items,
//                 nearest-only index, a cap, a budget.                     now with demand data
//   silent_miss — not an error at all: a valid search that found        → the failure that never
//                 nothing and could not prove absence.                     raises, hence never counted
//
// plus `environment` (bridge down, no body — not a design signal, and pooling it would drown the
// other four) and `crash` (an internal defect surfaced to the model as an error message; this bucket
// found a real one on its first run — see §Findings in the design doc).
//
// Never throws. Every entry point is wrapped: a telemetry layer that can break a tool call is worse
// than no telemetry layer.

import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { defaultRoutesRoot, normalizeConcept, routesLearning, routesMode, routesRecording } from "./routes.mjs";

export const LEDGER_VERSION = 1;

/** How many recent unanswered calls a session keeps in memory waiting for their sequel. */
const SEQUEL_RING = 6;
/** A repair has to be the same thought: four calls or five minutes, whichever ends first. */
const SEQUEL_MAX_CALLS = 4;
const SEQUEL_MAX_MS = 5 * 60_000;

// --- classification ----------------------------------------------------------------------------
//
// Patterns are matched against the mod's ACTUAL error strings (read out of LocateTools.java,
// BridgeServer.java and index.mjs, plus the 138 errored results in testbench-results/). They are
// kept in one ordered list so that adding a class is a local edit, and so the fallthrough bucket
// (`unclassified`) is visible in the overview — an overview whose biggest bucket is "other" is
// telling you the classifier is stale, and that has to be legible.

const CLASSIFIERS = [
  // FIRST: the environment. "no server running" is not a design signal, and if it fell through to
  // `affordance` a dead dev server would look like a wave of model confusion.
  ["environment", [
    /^Cannot reach the MCP toolkit bridge/i,
    /gave no answer within/i,
    /^Bridge at .* returned (HTTP|a non-JSON)/i,
    /^GET \/tools returned/i,
    /fetch failed/i,
    /no server running/i,
    /^no player online/i,
    /your session has no body/i,
    /^no actuator:/i,
    /timed out after \d+s/i,
    /game unreachable/i,
    /^Unknown tool: /i,
    /No such tool available/i,
  ]],
  // An internal defect that reached the model dressed as an ordinary refusal. Distinguished from
  // every other bucket because nothing about the CALL was wrong.
  ["crash", [
    /Cannot read propert(y|ies) of (undefined|null)/i,
    /is not a function/i,
    /is not iterable/i,
    /^Unexpected token .* in JSON/i,
    /^Maximum call stack/i,
  ]],
  // The concept gap. The first two are the exact pair memory/tools.mjs keys its fallthrough on
  // (kept in sync by hand with the mod's wording, deliberately — see isUnresolvableWhat).
  ["vocabulary", [
    /^`what` is not a valid id: /,
    // Deliberately LOOSER than `isUnresolvableWhat`'s copy of the same message. That one matches the
    // full sentence because it gates BEHAVIOUR — it decides whether a call is answered from memory
    // instead of erroring, so catching too much would turn a typo into a silent empty search. This
    // one only decides which column a row is counted in, so brittle exact-phrase matching buys
    // nothing and costs the count every time the mod rewords or a log truncates.
    /^unknown target '/,
    /^unknown tag '#/,
    /^unknown entity type '/,
    /^unknown structure(:| tag:)/,
    /^unknown biome(:| tag:)/,
    /Unknown block type/,
    /^bad block '/,
  ]],
  // Refused on purpose: the question is legitimate and the tool cannot answer it at this size or
  // through this index. These are the audit's open items arriving as demand.
  ["capability", [
    /exceeds the cap of/i,
    /^too many /i,
    /cannot scope a/i,
    /both set the extent/i,
    /a property-only node scans every cell/i,
    /^region spans /i,
    /exceeds the .*(cap|budget|limit)/i,
    /^line of \d+ blocks exceeds/i,
  ]],
  // The caller pointed at something that is not there: a dead entity id, a set/region name that was
  // never stored or died with another session, a place that does not exist. Distinct from
  // `vocabulary` (which is about a WORD not resolving) and from `affordance` (the call was
  // well-formed and named a referent in good faith) — the fix is handle lifetime and staleness
  // signposting, not wording and not a route.
  //
  // This bucket was NOT in the original four. It exists because the first backfill over the archive
  // produced nine `unclassified` rows and seven of them were `bot_engage` against entity ids of
  // 1, -1 and four dead mobs — a model inventing referents, which no amount of error rewording
  // fixes. That is the ledger doing its job on its first run.
  ["referent", [
    /^no such living entity \(id /i,
    /^no (result set|region or set) named/i,
    /^place .* does not exist/i,
    /^unknown (set|region|anchor) /i,
    /^no such (place|anchor|body|session)/i,
    /names unknown node '/i,
  ]],
  // Well-formed but wrong: the caller had the right question and the wrong words for it.
  ["affordance", [
    /InputValidationError/i,
    /^unknown detail/i,
    /must be (one of|any\|free\|claimed)/i,
    /filters the POI index only/i,
    /states its own positions/i,
    /^missing /i,
    /needs (x, y and z|an `id`|exactly|a )/i,
    /^relations\[/,
    /^pattern[.\s]/i,
    /^node '/,
    /^duplicate node id/i,
    /was recorded in .* dimension/i,
    /^`[a-z_]+`( is| must| needs| cannot)/i,
    /^[a-z_]+ must be /i,
    /not eligible:/i,
    /^no current task/i,
    // `op: expected set|update|clear, got undefined` — a missing or wrong enum argument. Added
    // 2026-08-02 from the FIRST live row the ledger ever recorded, which landed in `unclassified`.
    // That is the loop working as designed: the fallthrough bucket is visible precisely so a stale
    // classifier announces itself instead of quietly absorbing what it does not understand.
    /^[a-z_.]+: expected .+, got /i,
    // The mutually-exclusive-argument refusal: "give `to` … OR `reach` …, not both" (bot_goto),
    // "exactly one of what/at/pattern" (locate). One tool, several questions, and the caller asked
    // two at once — squarely a wording problem, and a recurring one across the whole surface.
    // Also from live rows, 2026-08-02.
    /\bnot both\b/i,
    /exactly one of/i,
    // "pass event_ids and/or rule" (mem_dismiss) — the supply-an-argument imperative. Third and
    // last shape the two live survival sessions of 2026-08-02 added; between them they took the
    // survival ledger from 60% unclassified to 0%.
    /^pass [`a-z_]/i,
  ]],
];

/**
 * Classify one failed call.
 * @returns {{class: string, matched: string|null}}
 */
export function classifyError(error) {
  const s = String(error ?? "");
  if (!s) return { class: "unclassified", matched: null };
  for (const [name, patterns] of CLASSIFIERS) {
    for (const re of patterns) {
      if (re.test(s)) return { class: name, matched: String(re) };
    }
  }
  return { class: "unclassified", matched: null };
}

/**
 * The concept a failed call was ASKING for, when there is one. Only `what` carries a concept —
 * `at` states positions and `pattern` states matchers, neither of which is a word an agent invented.
 */
export function conceptOf(tool, args) {
  if (tool !== "locate") return null;
  const what = args?.what;
  if (typeof what !== "string" || !what.trim()) return null;
  return normalizeConcept(what);
}

/**
 * The concept named by the ERROR rather than by the arguments. Vocabulary refusals quote the token
 * they could not resolve, which makes this tool-agnostic — and it has to be: the first backfill
 * found `unknown entity type '…'` coming from `get_entities`, i.e. a model asking for a *block*
 * through the entity door. Keying demand off `locate.what` alone would have missed it, and "the
 * model wanted this thing and no door gave it to them" is the fact worth counting.
 */
export function conceptFromError(error) {
  const s = String(error ?? "");
  const m = /^unknown (?:target|entity type|structure|biome|tag) '?#?([^'\s]+)'?/.exec(s)
    || /^`what` is not a valid id: (.+?)(?: \(expected|$)/.exec(s);
  return m ? normalizeConcept(m[1]) : null;
}

/** Which locate direction was used — the overview splits by it, because `at` failures and `what`
 *  failures have nothing to do with each other. */
export function directionOf(tool, args) {
  if (tool !== "locate") return null;
  if (args?.pattern) return "pattern";
  if (args?.at) return "at";
  if (args?.what) return "what";
  if (args?.in) return "in";
  if (args?.anchors || args?.show) return "anchors";
  return "unknown";
}

/**
 * A successful search that found nothing AND could not prove absence. Not an error, never surfaced
 * as one, and the biggest hole in any error-only ledger: the model asked a good question, got
 * "nothing here", and cannot tell whether that means anything.
 */
export function isSilentMiss(tool, result) {
  if (tool !== "locate" || !result || typeof result !== "object") return false;
  const search = result.search;
  if (!search) return false;
  const found = Array.isArray(result.found) ? result.found.length
    : typeof result.found === "number" ? result.found : null;
  const total = typeof result.matches_total === "number" ? result.matches_total : null;
  const empty = (found === 0 || found === null) && (total === 0 || total === null);
  if (!empty) return false;
  // A PROVEN negative is a real answer, and a good one — it is what the honesty machinery exists to
  // produce. Only the unprovable miss is a failure of the tool to answer.
  return search.negative_is_proof !== true;
}

// --- the ledger --------------------------------------------------------------------------------

const LOCK_WAIT_MS = 2000;
const LOCK_SPIN_MS = 25;
const STALE_LOCK_MS = 30_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function writeJsonAtomic(path, value) {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await rename(tmp, path);
}

export class RouteLedger {
  constructor(root = defaultRoutesRoot()) {
    this.dir = root;
    this.file = join(root, "ledger.jsonl");
    this.queueFile = join(root, "queue.json");
    this.lockDir = join(root, ".qlock");
    this.ready = false;
    /** Recent unanswered calls awaiting a sequel, this process only. */
    this.pending = [];
    this.callsSince = new Map();
  }

  async #ensure() {
    if (this.ready) return;
    await mkdir(this.dir, { recursive: true });
    this.ready = true;
  }

  /**
   * Append one record. Unlocked on purpose: a single sub-4KB line appended with O_APPEND is atomic
   * on both POSIX and Windows, and this is TELEMETRY — a lock here would put a cross-process wait on
   * the hot path of every tool call. The reader drops unparseable lines rather than trusting that.
   */
  async append(record) {
    await this.#ensure();
    const row = { v: LEDGER_VERSION, t: new Date().toISOString(), ...record };
    await appendFile(this.file, `${JSON.stringify(row)}\n`, "utf8");
    return row;
  }

  /** Every record, oldest first. Torn/partial lines are skipped and counted, never thrown on. */
  async read() {
    try {
      const text = await readFile(this.file, "utf8");
      const rows = [];
      let dropped = 0;
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try { rows.push(JSON.parse(line)); } catch { dropped++; }
      }
      if (dropped) process.stderr.write(`[routes] ledger: ${dropped} unparseable line(s) skipped\n`);
      return rows;
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
  }

  /**
   * Replace the whole ledger. The ONE operation that is not append-only, and it exists for exactly
   * one caller: re-backfilling the immutable bench archive, which must replace its own prior rows
   * rather than double every count. Live rows are never the input to this — the CLI filters them
   * back in — and the write is tmp+rename, so a crash leaves the old ledger, not half of one.
   */
  async rewrite(rows) {
    await this.#ensure();
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""), "utf8");
    await rename(tmp, this.file);
  }

  // --- the escalation queue ---------------------------------------------------------------------

  async #lock() {
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try { await mkdir(this.lockDir); return; } catch (e) {
        if (e.code !== "EEXIST") throw e;
        const age = await stat(this.lockDir).then((s) => Date.now() - s.mtimeMs).catch(() => 0);
        if (age > STALE_LOCK_MS) { await rm(this.lockDir, { recursive: true, force: true }); continue; }
        if (Date.now() > deadline) throw new Error("route queue is locked by another process");
        await sleep(LOCK_SPIN_MS);
      }
    }
  }

  async #unlock() { await rm(this.lockDir, { recursive: true, force: true }).catch(() => {}); }

  async readQueue() {
    try { return JSON.parse(await readFile(this.queueFile, "utf8")); }
    catch { return { version: 1, concepts: {} }; }
  }

  /**
   * Record demand for a concept nothing could route. Bounded evidence (4 examples) — the queue is a
   * work list, not a second copy of the ledger.
   */
  async enqueue(concept, evidence) {
    const key = normalizeConcept(concept);
    if (!key) return null;
    await this.#ensure();
    await this.#lock();
    try {
      const q = await this.readQueue();
      const now = new Date().toISOString();
      const e = q.concepts[key] ?? { concept: key, count: 0, first: now, status: "queued", examples: [] };
      if (e.status === "rejected") return e; // a human said no; stop counting it as demand
      e.count += 1;
      e.last = now;
      if (evidence && e.examples.length < 4) e.examples.push(evidence);
      q.concepts[key] = e;
      await writeJsonAtomic(this.queueFile, q);
      return e;
    } finally {
      await this.#unlock();
    }
  }

  async setQueueStatus(concept, status, note = null) {
    const key = normalizeConcept(concept);
    await this.#ensure();
    await this.#lock();
    try {
      const q = await this.readQueue();
      if (!q.concepts[key]) throw new Error(`'${key}' is not in the escalation queue`);
      q.concepts[key] = { ...q.concepts[key], status, note, status_at: new Date().toISOString() };
      await writeJsonAtomic(this.queueFile, q);
      return q.concepts[key];
    } finally {
      await this.#unlock();
    }
  }

  // --- the sequel: what the model did next ------------------------------------------------------

  /**
   * The cheapest source of routes there is. A miss followed by a rephrase that WORKED is a
   * self-repair — the model told us what it meant, for free, and the pair ("tree" → "#minecraft:logs"
   * → 3 found) is a candidate route with evidence already attached. Mining these first is what keeps
   * the escalation agent for the concepts that genuinely need thinking about.
   *
   * Deliberately loose about relatedness: an unrelated next call becomes noise, and FREQUENCY across
   * sessions is the filter that removes it — not a lexical rule guessing at intent one pair at a time.
   */
  notePending(row) {
    this.pending.unshift({
      id: row.id, concept: row.concept, tool: row.tool, args: row.args, at: Date.now(),
      calls: 0, emitted: 0, between: [],
    });
    this.pending = this.pending.slice(0, SEQUEL_RING);
  }

  /**
   * Every call, success or failure, ticks the open windows and records WHAT it was. The tool names
   * in between are the strongest continuity signal available (see continuityOf) and they are free —
   * the recorder already sees every call — but only if something bothers to keep them.
   */
  noteCall(tool) {
    const now = Date.now();
    this.pending = this.pending.filter((p) => {
      p.calls += 1;
      if (p.between.length < 8) p.between.push(tool);
      return p.calls <= SEQUEL_MAX_CALLS && now - p.at <= SEQUEL_MAX_MS;
    });
  }

  /**
   * @returns rows to append (may be empty). Pure bookkeeping; the caller does the I/O.
   *
   * A candidate does NOT close its window. The earlier version let the first qualifying success
   * claim the miss and drop it, which meant one incidental adjacent call could eat the slot and
   * hide the real continuation two calls later — the exact failure the window exists to catch.
   * Up to SEQUEL_MAX_CANDIDATES are emitted per miss and the reviewer sorts them out, which is the
   * right division of labour: this layer is built for recall, and the trial requirement downstream
   * is what supplies precision.
   */
  noteSuccess(tool, args, result) {
    const out = [];
    for (const p of this.pending) {
      if (tool !== p.tool) continue;
      if (p.emitted >= SEQUEL_MAX_CANDIDATES) continue;
      const found = Array.isArray(result?.found) ? result.found.length
        : typeof result?.found === "number" ? result.found : null;
      if (!found) continue; // an empty success answered nothing, so it continued nothing
      p.emitted += 1;
      out.push({
        kind: "sequel", of: p.id, concept: p.concept, tool,
        followed_with: compactArgs(args), found, calls_later: p.calls,
        // `between` excludes this call itself: it is what happened in the gap.
        continuity: continuityOf(p, args, p.between.slice(0, -1)),
      });
    }
    return out;
  }
}

/** At most this many candidate continuations per miss. Beyond it the model is doing something else. */
const SEQUEL_MAX_CANDIDATES = 3;

/**
 * How much reason there is to believe the later call CONTINUED the earlier question rather than
 * abandoning it.
 *
 * This exists because the honest answer to "how does the system know?" is that adjacency alone does
 * not know anything. The original defence — "frequency across sessions filters the noise" — is
 * weaker than it sounds: frequency filters RANDOM noise, and a model's post-failure behaviour is
 * systematic. A model that habitually falls back to the same call after any miss would produce a
 * high-frequency false pattern indistinguishable from a real repair, in exactly the shape that
 * looks most convincing.
 *
 * So four cheap features, all already in hand, none of them a gate:
 *
 *  - `remedy_taken`  — a registry/vocabulary lookup happened in the gap. Near-conclusive: the mod's
 *                      own error text says "use query_registry to find the right id", so taking that
 *                      advice and then succeeding is the model narrating its own repair.
 *  - `same_extent`   — the retry asks about the same box. A continuation looks in the same place; an
 *                      abandonment usually moves. `null` when neither call stated an extent, which
 *                      is common and proves nothing (the body may have walked).
 *  - `more_specific` — a bare word became a namespaced id or tag. That is the shape of a repair, and
 *                      the shape the error message asks for.
 *  - `lexical`       — the two share a word stem. WEAK on purpose and never required: "tree" →
 *                      "#minecraft:logs" has no overlap at all, and that pair is the single most
 *                      valuable one this whole mechanism exists to catch. Its absence means nothing;
 *                      its presence is a small extra.
 *
 * Reported, never enforced. A `sequel` row is a statement that two calls were adjacent plus the
 * evidence about what that adjacency was worth — the reviewer (or the escalation agent) judges. A
 * mechanism that silently decided which adjacency counted as intent would be inventing the one fact
 * it cannot observe, which is the failure mode this codebase spends most of its honesty machinery on.
 */
export const REMEDY_TOOLS = new Set(["query_registry", "anchors", "list_data", "get_world_info", "mem_recall"]);

export function continuityOf(pending, retryArgs, between = []) {
  const a = pending.args ?? {};
  const b = compactArgs(retryArgs);

  const remedy = between.filter((t) => REMEDY_TOOLS.has(t));
  const remedy_taken = remedy.length > 0;

  // Only a STATED extent can agree or disagree. Two calls that both defaulted to the observer look
  // identical and mean nothing, because the observer moves.
  const stated = (x) => x.near !== undefined || x.in !== undefined || x.radius !== undefined;
  const same_extent = (stated(a) || stated(b))
    ? JSON.stringify([a.near ?? null, a.in ?? null, a.radius ?? null])
      === JSON.stringify([b.near ?? null, b.in ?? null, b.radius ?? null])
    : null;

  const was = String(a.what ?? pending.concept ?? "");
  const now = String(b.what ?? "");
  const bare = (s) => !s.includes(":") && !s.startsWith("#");
  const more_specific = !!now && bare(was) && !bare(now);

  const words = (s) => new Set(String(s).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3));
  const wasW = words(was);
  const lexical = [...words(now)].some((w) => wasW.has(w));

  const score = (remedy_taken ? 2 : 0) + (same_extent === true ? 1 : 0)
    + (more_specific ? 1 : 0) + (lexical ? 1 : 0);
  return {
    remedy_taken, remedy_tools: remedy, same_extent, more_specific, lexical,
    between, score,
    // The threshold is a display split, not a filter: nothing is discarded for scoring low.
    strong: score >= 2,
  };
}

/** Arguments, small enough to keep forever. Positions and radii are the interesting part; a pattern
 *  body is summarized rather than stored whole (a ledger that grows with payload size stops being
 *  appendable-forever, and nothing downstream reads the relations). */
export function compactArgs(args) {
  const a = args ?? {};
  const out = {};
  for (const k of ["what", "in", "as", "radius", "limit", "occupancy", "dimension", "show", "from"]) {
    if (a[k] !== undefined) out[k] = a[k];
  }
  if (a.near) out.near = a.near;
  if (a.y_range) out.y_range = a.y_range;
  if (Array.isArray(a.at)) out.at = `${a.at.length} position(s)`;
  else if (a.at) out.at = a.at;
  if (a.dx !== undefined || a.dy !== undefined || a.dz !== undefined) out.extent = [a.dx ?? 0, a.dy ?? 0, a.dz ?? 0];
  if (a.pattern) {
    out.pattern = {
      nodes: (a.pattern.nodes ?? []).map((n) => n.block ?? n.entity ?? (n.set ? `set:${n.set}` : "props")),
      relations: (a.pattern.relations ?? []).map((r) => r.rel),
      anchor: a.pattern.anchor ?? null,
    };
  }
  return out;
}

// --- the hook ------------------------------------------------------------------------------------

let ledgerSingleton = null;

export function getLedger() {
  ledgerSingleton ??= new RouteLedger();
  return ledgerSingleton;
}

/** Reset for tests — the singleton would otherwise carry one suite's temp dir into the next. */
export function _resetLedger() { ledgerSingleton = null; }

/**
 * The one call index.mjs and the ablation shim make, on EVERY tool outcome.
 *
 * Contract: never throws, never awaits anything slow enough to matter (one small append), and never
 * changes the result. If it cannot write, the session is unaffected and stderr says so once.
 *
 * @param ctx {{tool, args, ok, error, result, session, world, profile, ms}}
 * @returns the appended row, or null when nothing was worth recording
 */
export async function recordOutcome(ctx) {
  if (!routesRecording()) return null;
  try {
    const ledger = getLedger();
    const { tool, args, ok, error, result } = ctx ?? {};
    // No tool name, nothing to attribute. Recording it would put a row in the overview that names
    // no call and suggests no fix — noise in the one table whose value is that every line is actionable.
    if (!tool) return null;
    // Tick the open continuity windows FIRST, so a call is counted whether it succeeded or failed
    // and the gap between a miss and a candidate continuation is a true record of what happened in
    // it. Ticking only on success would hide the failed attempts, which are the clearest evidence
    // that the model was still trying.
    ledger.noteCall(tool);

    if (ok) {
      // Successes are not recorded — the ledger is about what did NOT work, and a full call log is
      // the bench transcript's job (testbench/agent.mjs writes one already). Two exceptions: the
      // silent miss, which is a failure wearing ok:true, and the sequel that repairs an earlier one.
      const rows = ledger.noteSuccess(tool, args, result);
      for (const r of rows) await ledger.append({ ...r, session: ctx.session, world: ctx.world });
      if (isSilentMiss(tool, result)) {
        return await ledger.append({
          id: randomUUID(), kind: "miss", class: "silent_miss",
          tool, direction: directionOf(tool, args), concept: conceptOf(tool, args),
          args: compactArgs(args), session: ctx.session, world: ctx.world, profile: ctx.profile,
          mode: routesMode(), ms: ctx.ms ?? null,
          negative_is_proof: false,
          extent: result?.search?.extent ?? null,
          note: result?.search?.note ?? null,
        });
      }
      return null;
    }

    const cls = classifyError(error);
    const row = await ledger.append({
      id: randomUUID(), kind: "miss", class: cls.class,
      tool, direction: directionOf(tool, args),
      concept: conceptOf(tool, args) ?? conceptFromError(error),
      args: compactArgs(args), error: String(error ?? "").slice(0, 400),
      session: ctx.session, world: ctx.world, profile: ctx.profile, mode: routesMode(),
      ms: ctx.ms ?? null,
    });
    ledger.notePending(row);

    // Demand for an unroutable word is the escalation queue's entire input. `frozen` deliberately
    // does not grow it: a bench session must not widen the vocabulary a later run inherits.
    if (routesLearning() && cls.class === "vocabulary" && row.concept) {
      await ledger.enqueue(row.concept, {
        t: row.t, session: ctx.session, world: ctx.world, args: row.args, error: row.error,
      });
    }
    return row;
  } catch (e) {
    warnOnce(e);
    return null;
  }
}

let warned = false;
function warnOnce(e) {
  if (warned) return;
  warned = true;
  process.stderr.write(`[routes] ledger unavailable (${e.message}) — recording disabled this session\n`);
}

// --- the overview ---------------------------------------------------------------------------------

/**
 * Aggregate the ledger into the report the CLI prints. Pure — takes rows, returns numbers — so the
 * shape of the overview is unit-testable without a filesystem, and so the same function serves the
 * live ledger and a backfill over archived bench transcripts.
 */
export function summarize(rows, { since = null } = {}) {
  const win = rows.filter((r) => !since || r.t >= since);
  // `kind` is explicit on every row this version writes; the `undefined` case keeps a ledger
  // written by an older build readable rather than silently reclassifying it as something else.
  const misses = win.filter((r) => r.kind === "miss" || r.kind === undefined);
  const sequels = win.filter((r) => r.kind === "sequel");
  const routed = win.filter((r) => r.kind === "routed");
  const byId = new Map(misses.map((r) => [r.id, r]));

  const byClass = new Map();
  const byTool = new Map();
  const concepts = new Map();
  const errors = new Map();
  const worlds = new Set();
  const sessions = new Set();

  for (const raw of misses) {
    // RE-CLASSIFY on read, from the stored error text. The row keeps whatever the classifier
    // thought when it was written — that is history and stays — but the overview must reflect the
    // classifier as it is NOW, or every improvement only ever applies to calls that have not
    // happened yet and the `unclassified` bucket never shrinks for the data that motivated the fix.
    // Rows with no error text (silent_miss) carry a class no re-reading can derive; they keep theirs.
    const r = raw.error ? { ...raw, class: classifyError(raw.error).class } : raw;
    bump(byClass, r.class);
    bump(byTool, r.tool ?? "?");
    if (r.world) worlds.add(r.world);
    if (r.session) sessions.add(r.session);
    // Errors are grouped by SHAPE, not text: the interesting number is "this refusal fired 30
    // times", and leaving the coordinates in would scatter one refusal across 30 singleton rows.
    if (r.error) bump(errors, errorShape(r.error), r.class);
    if (r.concept && (r.class === "vocabulary" || r.class === "silent_miss")) {
      const c = concepts.get(r.concept) ?? { concept: r.concept, count: 0, classes: new Set(), followups: new Map(), sessions: new Set() };
      c.count++;
      c.classes.add(r.class);
      if (r.session) c.sessions.add(r.session);
      concepts.set(r.concept, c);
    }
  }

  // What the model did NEXT, attached to the concept. Called `followups`, not `repairs`: the
  // ledger observed adjacency, and adjacency is not intent. Each one carries its continuity
  // evidence (continuityOf) and the aggregate keeps the strong/weak split visible, because "3
  // sessions all took the registry remedy and re-asked the same box" and "3 sessions happened to
  // call locate again" are the same number and completely different findings.
  for (const s of sequels) {
    const miss = byId.get(s.of);
    const key = s.concept ?? miss?.concept;
    if (!key) continue;
    const c = concepts.get(key) ?? { concept: key, count: 0, classes: new Set(), followups: new Map(), sessions: new Set() };
    // `repaired_with` is the pre-0.17.0 field name, kept readable so an existing ledger still parses.
    const spec = s.followed_with ?? s.repaired_with;
    const followup = spec?.what ?? JSON.stringify(spec ?? {});
    const f = c.followups.get(followup) ?? { followup, count: 0, strong: 0, found: 0, remedy: 0, same_extent: 0 };
    f.count++;
    f.found += s.found ?? 0;
    if (s.continuity?.strong) f.strong++;
    if (s.continuity?.remedy_taken) f.remedy++;
    if (s.continuity?.same_extent === true) f.same_extent++;
    c.followups.set(followup, f);
    concepts.set(key, c);
  }

  // Routes that fired. This is the counterweight to the `vocabulary` bucket: as routes land, demand
  // moves from one table to the other, and the pair is how you see whether the layer is working.
  const routes = new Map();
  for (const r of routed) {
    const e = routes.get(r.concept) ?? {
      concept: r.concept, count: 0, found: 0, empty: 0, provenance: r.provenance,
      legs: r.legs ?? [], asked: new Set(),
    };
    e.count++;
    e.found += r.found ?? 0;
    if (!r.found) e.empty++;
    if (r.asked) e.asked.add(r.asked);
    routes.set(r.concept, e);
  }

  return {
    total: misses.length,
    sequels: sequels.length,
    routed: routed.length,
    routes: [...routes.values()].map((r) => ({ ...r, asked: [...r.asked] }))
      .sort((a, b) => b.count - a.count),
    sessions: sessions.size,
    worlds: worlds.size,
    span: misses.length ? [misses[0].t, misses[misses.length - 1].t] : null,
    classes: [...byClass.entries()].map(([k, v]) => ({ class: k, count: v })).sort((a, b) => b.count - a.count),
    tools: [...byTool.entries()].map(([k, v]) => ({ tool: k, count: v })).sort((a, b) => b.count - a.count),
    errors: [...errors.entries()].map(([k, v]) => ({ shape: k, count: v.n, class: [...v.classes].join("/") }))
      .sort((a, b) => b.count - a.count),
    concepts: [...concepts.values()].map((c) => ({
      concept: c.concept,
      count: c.count,
      sessions: c.sessions.size,
      classes: [...c.classes],
      // Strong-first: a followup backed by continuity evidence outranks a more frequent bare
      // adjacency, because frequency alone cannot tell a repair from a habit.
      followups: [...c.followups.values()].sort((a, b) => b.strong - a.strong || b.count - a.count),
    })).sort((a, b) => b.count - a.count || b.sessions - a.sessions),
  };
}

function bump(map, key, cls = null) {
  if (cls === null) { map.set(key, (map.get(key) ?? 0) + 1); return; }
  const e = map.get(key) ?? { n: 0, classes: new Set() };
  e.n++;
  e.classes.add(cls);
  map.set(key, e);
}

/**
 * Collapse an error message to its recurring shape: numbers, coordinates and quoted ids are the
 * varying part, the sentence is the signal. Without this the top-errors table is a list of unique
 * strings and reports nothing.
 */
export function errorShape(error) {
  return String(error)
    .replace(/'[^']*'/g, "'…'")
    .replace(/"[^"]*"/g, '"…"')
    .replace(/-?\d+(\.\d+)?/g, "N")
    .slice(0, 140)
    .trim();
}
