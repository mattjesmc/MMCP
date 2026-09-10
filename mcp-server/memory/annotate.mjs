// Annotate — MEMORY_REDESIGN.md §2.2, the heart of cycle 2.
//
// THE EVIDENCE THIS EXISTS FOR: the observation store worked and was never used. Its three query
// tools took 5.9% of retrieval traffic, and `mem_changes` — the tool built for exactly the
// discriminating question — was called ZERO times in 30 sessions, including the arm explicitly
// instructed to use it (bench 0.9.7). Meanwhile `locate` succeeded because the `what:<id>` instinct
// routed to it by name, unprompted. Tools agents already reach for get used; tools they must
// remember exist do not.
//
// So: stop building doors the agent must find. Put memory INSIDE the doors it already walks
// through. The capture hook already intercepts every captured world read with the result in hand;
// it now grows a second job — compare BEFORE recording, and append a labelled `remembered` section
// to the tool response when memory has something the live result does not. Change detection becomes
// a PUSH, not a pull: the agent never has to know to ask.
//
// Contract, identical in strength to capture's (and for the same reason — this rides every read):
//  - NEVER throws. NEVER blocks or mutates the live payload's own fields. A failure degrades to the
//    plain result plus a LOUD stderr line; it is never silent, because a silently-absent appendix
//    would read downstream as "memory had nothing to say", which is a different claim entirely.
//  - Remembered content is a SEPARATE, LABELLED, TICK-STAMPED section. It is never merged into the
//    live result set, never counted in `found`, never given handles (§5.1: a handle implies
//    re-resolvable-now; a stale site should be walked to and looked at).
//  - SILENCE ON AGREEMENT. When the live read matches memory the appendix says nothing — no news
//    costs no bytes. This is the mechanism §8 prediction 4's token bound is betting on.
//  - MCPTK_OBS_ANNOTATE=off disables the appendix while capture keeps running (arms h/j).

import { EXTRACTORS, cachedStore } from "./capture.mjs";
import { captureWorldRead } from "./capture.mjs";
import { AIR } from "./observations.mjs";
import { SESSION } from "./tools.mjs";
import { REMEMBERED_NOTE, fmtAge, fmtPos } from "./remembered.mjs";

/** Rendered delta lines per read. Beyond it the count is STATED with its bounding box — the agent
 *  is told how much it is not being shown, and where, so truncation is never silent. */
const DELTA_LINE_CAP = 8;
/** Remembered fills for unread (-1) positions. Same stated-truncation rule. */
const FILL_LINE_CAP = 6;
const SEARCH_CLUSTER_CAP = 4;
const SEARCH_SIGHTING_CAP = 4;

/**
 * Captured reads whose annotate coverage is deliberately PARTIAL, with the reason — the same
 * anti-silent-narrowing ledger pattern as capture.mjs's UNCAPTURED_WORLD_READS, and tested the same
 * way: a captured read absent from both the annotate path and this table is a declaration gap.
 * Keys are `tool:case`.
 */
export const UNANNOTATED_CASES = {
  "describe_box:summary_aggregates":
    "aggregate-vs-aggregate diffs ('this box's material counts moved') are deferred to a later cycle (§7). " +
    "Cell-level coverage still applies: a complete all-air summary implies air per cell and IS diffed.",
  "get_surface:summary_aggregates":
    "palette-histogram diffs deferred with the same reasoning (§7); the anomaly columns carry exact cells " +
    "and ARE diffed cell-level.",
  "get_surface:unloaded_columns":
    "unloaded columns are reported as a COUNT with no positions (WorldPerceptionTools.surface), so there is " +
    "no position to fill from memory — unlike get_blocks_at's -1 rows, which carry theirs.",
  "describe_box:unloaded_columns":
    "same: `unloaded_columns` is a count, not a position list.",
  "locate:search_extent":
    "a search sweep is a confirms:false aggregate with no cell rows, so it has no delta path at all; its " +
    "remembered answer is the lastSeen fallback below, not a diff.",
};

/** Extractor keys the annotate path actually handles. The coverage test pins EXTRACTORS against
 *  this set ∪ the UNANNOTATED_CASES prefixes, so a new captured read must declare its side. */
export const ANNOTATED_TOOLS = new Set([
  "get_blocks_at", "get_surface", "describe_box", "locate", "raycast", "raycast_fan",
]);

function annotateEnabled() {
  return (process.env.MCPTK_OBS_ANNOTATE ?? "on").trim() !== "off";
}

/** Positions a read explicitly reported as NOT READ (the -1 palette convention). Unknown never
 *  indexes as a fact — but the agent's own memory may know what is there, and that is worth saying. */
function unreadPositions(result) {
  if (!Array.isArray(result.blocks) || !Array.isArray(result.palette)) return [];
  const out = [];
  for (const row of result.blocks) {
    if (!Array.isArray(row) || row.length < 4) continue;
    const [x, y, z, pi] = row;
    if (pi !== -1) continue;
    if ([x, y, z].every(Number.isInteger)) out.push([x, y, z]);
  }
  return out;
}

function bboxOf(positions) {
  const lo = [...positions[0]];
  const hi = [...positions[0]];
  for (const p of positions) {
    for (let i = 0; i < 3; i++) {
      lo[i] = Math.min(lo[i], p[i]);
      hi[i] = Math.max(hi[i], p[i]);
    }
  }
  return [lo, hi];
}

// --- the appendix ---------------------------------------------------------------------------------

/**
 * Build the appendix for one read, BEFORE the read is recorded (recording it first would supersede
 * the very prior being compared against). Returns {lines, kinds, disclose} or null for silence.
 */
async function buildAppendix(tool, args, result, store) {
  const dim = result.dimension;
  const now = result.game_tick;
  const extract = EXTRACTORS[tool];
  const norm = extract(args ?? {}, result);
  if (norm === null || norm.skip) return null; // capture already logged the skip loudly

  const lines = [];
  const kinds = [];
  const disclose = [];

  // --- 1. the delta: what differs from what you last DELIBERATELY saw here -------------------------
  const cells = norm.cellValues ?? [];
  // A COMPLETE scan is evidence about every cell in its box, including the ones it does not mention.
  // That silence is what a disappearance looks like, so it is diffed too — otherwise the one change
  // with no live evidence whatsoever would be the one change the appendix cannot report.
  const impliedAirBox = norm.impliedAir && norm.area?.box && norm.area?.complete ? norm.area.box : null;
  if (cells.length || impliedAirBox) {
    const deltas = await store.deltaView({ dim, cells, impliedAirBox });
    // was === null is FIRST SIGHT, not a change: the agent is seeing this cell for the first time and
    // announcing that as "CHANGED" would be a fabricated history.
    const changed = deltas.filter((d) => d.was !== null);
    if (changed.length) {
      kinds.push("delta");
      for (const d of changed.slice(0, DELTA_LINE_CAP)) {
        const was = `${d.was.val}${d.was.implied ? " (implied by your complete scan: nothing was listed here)" : ""}`;
        const approx = d.approx ? " — approximate: older history dropped" : "";
        const ambient = d.ambient_seen
          ? `; a ${d.ambient_seen.channel} read saw ${d.ambient_seen.val} ${fmtAge(now, d.ambient_seen.tick)}`
          : "";
        const vanished = d.vanished ? " — this scan does not list it, so it is GONE" : "";
        lines.push(
          `CHANGED since you last looked: ${fmtPos(d.pos)} was ${was} (your read ${fmtAge(now, d.was.tick)})` +
          `, now ${d.live_val}${vanished}${ambient}${approx}`);
        disclose.push(d.pos);
      }
      if (changed.length > DELTA_LINE_CAP) {
        const rest = changed.slice(DELTA_LINE_CAP);
        const [lo, hi] = bboxOf(rest.map((d) => d.pos));
        lines.push(
          `(+${rest.length} more changed cell(s) in ${fmtPos(lo)}..${fmtPos(hi)} — shown live in this result, ` +
          `not listed here; re-read that range to see each prior)`);
      }
    }
  }

  // --- 2. unread fill: the -1 rows this read could not answer, which memory can ---------------------
  const unread = unreadPositions(result);
  if (unread.length) {
    const fills = [];
    for (const pos of unread) {
      if (fills.length >= FILL_LINE_CAP) break;
      const seen = await store.seenAt({ pos, dim });
      if (!seen.observed || !seen.cell) continue;
      const c = seen.cell;
      fills.push(`remembered (NOT live): ${fmtPos(pos)} ${c.val}${c.implied ? " (implied air)" : ""}, seen ${fmtAge(now, c.last_confirmed_tick)}`);
    }
    if (fills.length) {
      kinds.push("fill");
      lines.push(...fills);
      // Silence when memory has nothing: the -1 already says "unread". "No memory either" is text
      // reserved for SEARCHES, where absence is itself the answer.
    }
  }

  // --- 3. locate search: remembered sites when the live sweep came back thin -----------------------
  if (tool === "locate" && result.direction !== "identify" && typeof result.what === "string") {
    const found = Array.isArray(result.found) ? result.found : result.found ? [result.found] : [];
    const limit = Number.isInteger(args?.limit) ? args.limit : null;
    if (found.length === 0 || (limit !== null && found.length < limit)) {
      const r = await store.lastSeen({ what: result.what, dim: null });
      kinds.push("search");
      if (!r.found) {
        if (found.length === 0) lines.push(`no live matches, and nothing in memory either — absent from your memory, not proven absent from the world.`);
      } else {
        lines.push(found.length === 0
          ? `no live matches; remembered sites (NOT live, never re-resolved — walk there and look):`
          : `additional remembered sites (NOT live, not counted in \`found\`):`);
        for (const c of r.clusters.slice(0, SEARCH_CLUSTER_CAP)) {
          lines.push(`  ${c.dim} ${c.region}: ×${c.count} in ${fmtPos(c.bbox[0])}..${fmtPos(c.bbox[1])} — latest ${fmtAge(now, c.latest_tick)}`);
        }
        for (const s of r.sightings.slice(0, SEARCH_SIGHTING_CAP)) {
          const where = s.pos ? ` @ ${fmtPos(s.pos)}` : s.bbox ? ` bbox ${s.bbox}` : "";
          const count = s.count !== undefined ? ` ×${s.count}` : "";
          lines.push(`  [${s.source}] ${s.id ?? s.kind ?? ""}${count}${where} ${fmtAge(now, s.tick)} (${s.dim})`);
        }
        const extra = (r.clusters.length - SEARCH_CLUSTER_CAP) + (r.sightings.length - SEARCH_SIGHTING_CAP);
        if (extra > 0) lines.push(`  (+${extra} more remembered site(s))`);
      }
    }
  }

  if (!lines.length) return null; // silence on agreement
  lines.push(`[${REMEMBERED_NOTE}]`);
  return { lines, kinds, disclose };
}

// --- the hook -------------------------------------------------------------------------------------

/**
 * Capture + annotate for one successful world read. Replaces the bare captureWorldRead call at both
 * hook sites (production index.mjs and the bench shim). Ordering is load-bearing:
 *   compare (deltaView, against the prior)  →  record (capture, which supersedes it)  →  disclose.
 *
 * Returns {remembered, remembered_kinds, capture}. `remembered` is null for silence.
 */
export async function processWorldRead(tool, args, result, callBridge) {
  let appendix = null;
  let store = null;
  try {
    if (annotateEnabled() && EXTRACTORS[tool] && result && typeof result === "object"
      && Number.isInteger(result.game_tick) && typeof result.dimension === "string") {
      store = await cachedStore(callBridge);
      appendix = await buildAppendix(tool, args, result, store);
    }
  } catch (e) {
    // LOUD, never silent: a missing appendix must not read downstream as "memory had nothing".
    process.stderr.write(`[annotate] ${tool}: appendix failed (${e.message}) — result served unannotated\n`);
    appendix = null;
  }

  const capture = await captureWorldRead(tool, args, result, callBridge);

  if (appendix?.disclose.length && store) {
    try {
      // Serving a delta IS a deliberate disclosure. Persisting it is what keeps the same change from
      // being re-told on every subsequent read, and what makes that survive a restart.
      await store.recordDisclosure({
        tick: result.game_tick, dim: result.dimension, session: SESSION, cells: appendix.disclose,
      });
    } catch (e) {
      process.stderr.write(`[annotate] ${tool}: disclosure record failed (${e.message})\n`);
    }
  }

  return {
    remembered: appendix ? appendix.lines.join("\n") : null,
    remembered_kinds: appendix ? appendix.kinds : [],
    capture,
  };
}

/**
 * Attach a non-null appendix to a live result. Additive only — it adds fields, it never rewrites
 * one, so every existing consumer of every existing field is untouched. `remembered_served` is the
 * machine-countable marker the bench report keys on (§8 prediction 1 is a structural claim about
 * DELIVERY; it must never be measured by parsing prose).
 */
export function attachRemembered(result, ann) {
  if (!ann?.remembered || !result || typeof result !== "object") return result;
  result.remembered = ann.remembered;
  result.remembered_served = true;
  result.remembered_kinds = ann.remembered_kinds;
  return result;
}
