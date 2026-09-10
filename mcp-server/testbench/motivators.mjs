// Offline motivator counters — the three round-three counts RESEARCH_WORLD_REPRESENTATION.md's
// "Cross-cutting themes" section asks for, computed from the ordered per-call `trace` every
// Category-T session records (agent.mjs) into testbench-results/*/answers.jsonl. No model spend:
// these are pure functions over data already on disk.
//
// Every counter here is a HEURISTIC, not ground truth — the trace only has {tool, args (JSON,
// truncated to 200 chars), error?, result_chars}, not the model's reasoning, so "was this actually
// blind" or "was this actually derivable" can't be verified from the trace alone. Each function's
// doc comment says exactly what it approximates and how it can be wrong, honestly, rather than
// silently overclaiming precision analyze-motivators.mjs's table doesn't have.

/**
 * blind-retry-after-opaque-failure: a tool call errored, and the VERY NEXT call in the trace is
 * the same tool again, with nothing else landing in between.
 *
 * Heuristic, not a proof of blindness: this is the strict/cheap form. It UNDER-counts retries
 * separated by an unrelated call (a real diagnostic detour would also break this, so those two
 * cases are indistinguishable from the trace alone) and retries via a genuinely different but
 * equivalent "substitute" tool (e.g. retrying a failed check_path with a raycast instead) — the
 * research note explicitly allows "same or a substitute action", but detecting substitutability
 * needs tool semantics this module doesn't encode. It also OVER-counts a same-tool retry that DID
 * carry new diagnostic information in its (truncated, 200-char) args — the trace can't distinguish
 * "blind resend" from "informed retry with adjusted args" without deeper arg inspection.
 * @param {Array<{tool:string, args:string, error?:boolean}>} trace
 * @returns {number}
 */
export function blindRetryAfterOpaqueFailure(trace) {
  if (!Array.isArray(trace)) return 0;
  let count = 0;
  for (let i = 0; i < trace.length - 1; i++) {
    if (trace[i].error && trace[i + 1].tool === trace[i].tool) count++;
  }
  return count;
}

// Read-tool families for the derivable-follow-up heuristic: two back-to-back reads in the same
// family are candidates for "the second answer was already implied by the first". Families follow
// the toolkit's own perception-ladder grouping (RESEARCH_WORLD_REPRESENTATION.md / ARCHITECTURE),
// not call signature — e.g. check_site and find_site are both footprint/terrain predicates even
// though their argument shapes differ.
const READ_FAMILY = {
  get_blocks: "blocks", get_blocks_at: "blocks", scan_box: "blocks", get_surface: "blocks", describe_box: "blocks", // old+new names: this map classifies historical AND future traces
  get_entities: "entities",
  raycast: "sight", raycast_fan: "sight",
  scene_summary: "orient",
  check_fit: "predicate", check_clearance: "predicate", check_path: "predicate",
  check_site: "predicate", find_site: "predicate", resolve_anchor: "predicate",
  get_region_summary: "predicate", mem_locate: "predicate",
};

/** Best-effort numeric literals out of a (possibly truncated) JSON args string. */
function argNumbers(argsStr) {
  if (typeof argsStr !== "string") return new Set();
  // The stored string is JSON.stringify(...).slice(0, 200) — often a clean parse, sometimes cut
  // mid-token. Try the exact parse first (catches nested numbers reliably); fall back to scraping
  // numeric substrings out of the raw (possibly truncated) text.
  try {
    return new Set((JSON.stringify(JSON.parse(argsStr)).match(/-?\d+(?:\.\d+)?/g)) ?? []);
  } catch {
    return new Set((argsStr.match(/-?\d+(?:\.\d+)?/g)) ?? []);
  }
}

/**
 * derivable-follow-up read: two consecutive, non-error, same-family read calls whose args share at
 * least one numeric literal (a coordinate, a size, a radius — some sign the second call is
 * re-querying overlapping ground the first call already covered).
 *
 * Heuristic, approximate in both directions: sharing a numeric literal is neither necessary
 * (a genuinely derivable follow-up over a translated/rotated region may share no literal digits)
 * nor sufficient (two calls can share an incidental literal — a common y-level, a repeated radius
 * default — with no real overlap) for the second answer being an actual derivable property of the
 * first. It also can't tell "derivable" apart from "legitimately needs a second read at finer
 * detail" (e.g. get_blocks summary then get_blocks_at for one exact block) — both look the same
 * from the trace. Read as a rough upper-bound proxy for redundant-read pressure, not a verified
 * count of avoidable calls.
 * @param {Array<{tool:string, args:string, error?:boolean}>} trace
 * @returns {number}
 */
export function derivableFollowUpRead(trace) {
  if (!Array.isArray(trace)) return 0;
  let count = 0;
  for (let i = 0; i < trace.length - 1; i++) {
    const a = trace[i], b = trace[i + 1];
    if (a.error || b.error) continue;
    const famA = READ_FAMILY[a.tool], famB = READ_FAMILY[b.tool];
    if (!famA || famA !== famB) continue;
    const an = argNumbers(a.args);
    if (an.size === 0) continue;
    const bn = argNumbers(b.args);
    let overlap = false;
    for (const n of an) if (bn.has(n)) { overlap = true; break; }
    if (overlap) count++;
  }
  return count;
}

/**
 * statically-illegal first action: the session's very first tool call errored.
 *
 * Heuristic, deliberately the crudest of the three: "the first call failed" is a superset of
 * "the first call was a precondition violation a static pre-check could have caught" — the trace
 * doesn't distinguish that from a transient/environment failure (e.g. an unloaded chunk, a bridge
 * hiccup) that no amount of static checking would have prevented. Read this count as an upper
 * bound on statically-illegal first actions, not a confirmed one.
 * @param {Array<{tool:string, args:string, error?:boolean}>} trace
 * @returns {number}
 */
export function staticallyIllegalFirstAction(trace) {
  if (!Array.isArray(trace) || trace.length === 0) return 0;
  return trace[0].error ? 1 : 0;
}

/**
 * Compute all three counters for one answers.jsonl record (or a bare trace array). Records from
 * before the trace field shipped (2026-07-23) — or instantiation-error records that never ran a
 * session — carry no `trace`; those come back {hasTrace:false} so callers can report "no trace,
 * skipped" instead of crashing or silently reading zeros as real zeros.
 * @param {object|Array} recordOrTrace an answers.jsonl record, or a trace array directly
 * @returns {{hasTrace:boolean, blind_retry?:number, derivable_follow_up?:number, statically_illegal_first?:number}}
 */
export function motivatorCounts(recordOrTrace) {
  const trace = Array.isArray(recordOrTrace) ? recordOrTrace : recordOrTrace?.trace;
  if (!Array.isArray(trace)) return { hasTrace: false };
  return {
    hasTrace: true,
    blind_retry: blindRetryAfterOpaqueFailure(trace),
    derivable_follow_up: derivableFollowUpRead(trace),
    statically_illegal_first: staticallyIllegalFirstAction(trace),
  };
}
