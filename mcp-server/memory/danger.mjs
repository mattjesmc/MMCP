// Danger rides the acts — SURVIVAL_SMALL_MODEL_PLAN.md P5.
//
// Every body loss to date shares one mechanism: event polling is a DISCIPLINE, and sessions lose
// disciplines — the first watched run read its drowning warning post-mortem from inside a blocking
// bot_target; the haiku probe's body was shot by a skeleton turns after it stopped polling
// get_events. The structural fix mirrors "memory rides the reads" (annotate.mjs): under the
// survival profile the shim PEEKS the event log after every successful act and appends a compact
// `danger` digest to the tool result itself, so a lapsed listen loop can no longer blind the body.
//
// Honesty contract: the peek is read-only (EventLog cursors are client-state; nothing is consumed
// or re-ordered), each danger event is digested ONCE (they are still delivered normally by the
// agent's own get_events poll — same promise as the `urgent` header), and the digest never
// invents: rows carry exactly the event's type/cause/tick. A failed peek attaches nothing — a
// broken digest must not break the act it rides on.

const DANGER_TYPES = "body_endangered,body_damaged,body_died,body_removed,reaction_fired";
const PEEK_LIMIT = 25;

// The newest event id already digested OR delivered to the agent through an unfiltered poll.
let digestCursor = null;

/**
 * Record what the agent's own get_events call delivered. Only an UNFILTERED poll (or one whose
 * filter includes body events) proves the agent saw pending danger — a chat-only poll advances
 * the log cursor without delivering body rows, and treating that as "seen" would silently drop
 * those rows from the digest too (the exact blindness this module exists to prevent).
 */
export function noteDelivered(args, result) {
  const type = args?.type;
  const covers = type === undefined || type === null || type === ""
    || String(type).split(",").some((t) => DANGER_TYPES.includes(t.trim()));
  if (covers && Number.isInteger(result?.cursor)) {
    digestCursor = digestCursor === null ? result.cursor : Math.max(digestCursor, result.cursor);
  }
}

/**
 * Peek for undigested danger events. Returns a compact digest object to attach to the current
 * tool result, or null (no danger / first call / bridge unreachable). Never throws.
 */
export async function dangerDigest(callTool) {
  try {
    if (digestCursor === null) {
      // First peek: learn the log head. History predating the session is not "new danger".
      const r = await callTool("get_events", { limit: 1 });
      if (r?.ok && Number.isInteger(r.result?.cursor)) digestCursor = r.result.cursor;
      return null;
    }
    const r = await callTool("get_events", { cursor: digestCursor, limit: PEEK_LIMIT, type: DANGER_TYPES });
    if (!r?.ok) return null;
    const events = Array.isArray(r.result?.events) ? r.result.events : [];
    if (Number.isInteger(r.result?.cursor)) digestCursor = Math.max(digestCursor, r.result.cursor);
    if (events.length === 0) return null;
    return {
      events: events.map((e) => ({
        type: e.type,
        ...(e.data?.cause ? { cause: e.data.cause } : {}),
        ...(e.data?.reason ? { reason: e.data.reason } : {}),
        ...(Number.isInteger(e.game_tick) ? { tick: e.game_tick } : {}),
      })),
      note: "UNREAD DANGER since your last event poll — call get_events NOW and act on it "
        + "(full rows are still there; this digest repeats nothing twice)",
    };
  } catch {
    return null;
  }
}
