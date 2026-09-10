// Session termination guards (FREEZE_PLAN A5 change 2). Shared by BOTH session runners (agent.mjs for
// Category T, ablation/runner-sdk.mjs for the embodied categories) so the doctrine lives in one place.
//
// DOCTRINE (Matthijs, 2026-07-25): "a turn-cap being hit is only evidence against the turn-cap." A
// per-template turn ceiling carries ZERO information about the subject (model, arm, task) — it only
// says the ceiling was set too low, and it censors the very variable under comparison (a task that
// needs many tool calls gets cut off, zeroing both arms). So the turn cap is REMOVED as a terminator:
//   - The SDK loop bound becomes a single, generous RUNAWAY guard. If it ever trips, that too is only
//     evidence against the guard → the row is flagged instrument-suspect and RE-RUN, never scored.
//   - The one LEGITIMATE early stop is a STALL: the session keeps making calls it already made,
//     advancing nothing. That is evidence about the SESSION (it got stuck), not the instrument.
// Both non-answer stops are CENSORED downstream (bench-report), never folded into failure.

//   - A third non-answer stop joined these on 2026-07-28: the session that opened with NO TOOLS. See
//     `toolSurfaceFailure` below — it is an INSTRUMENT failure, the strongest censoring case of all.

export const RUNAWAY_TURNS = 200;      // pure runaway backstop; legitimate T tasks use ~4–10 turns
export const STALL_STREAK = 8;         // consecutive no-progress turns before we call it stuck
// Token ceiling — tokens are the cost currency (turns are only its proxy). Measured on cumulative
// OUTPUT tokens (monotonic; unlike input, not inflated by the per-turn context re-read). Set so no
// legitimate session (which outputs single-digit-k) approaches it; a trip is a runaway → re-run.
export const TOKEN_CEILING_OUT = 200_000;
export const overTokenCeiling = (outputTokens) => Number(outputTokens) > TOKEN_CEILING_OUT;

/** A turn is NO-PROGRESS when it made ≥1 tool call and EVERY call repeats one already seen this
 *  session. A turn with a new call, or with no calls at all (thinking / committing the answer),
 *  resets the streak. `streak` consecutive no-progress turns ⇒ stalled. Pure + closure-stateful so
 *  it is unit-testable without the SDK. */
export function makeStallGuard({ streak = STALL_STREAK } = {}) {
  const seen = new Set();
  let noProgress = 0;
  return {
    /** @param {string[]} toolKeys  the `tool|args` signatures called this turn (in order)
     *  @returns {{stalled: boolean, noProgress: number}} */
    observe(toolKeys = []) {
      if (toolKeys.length === 0) { noProgress = 0; }
      else {
        let allRepeat = true;
        for (const k of toolKeys) { if (!seen.has(k)) allRepeat = false; seen.add(k); }
        noProgress = allRepeat ? noProgress + 1 : 0;
      }
      return { stalled: noProgress >= streak, noProgress };
    },
  };
}

/** The SDK bound to use, never below the caller's advisory value (strictly more permissive than the
 *  old per-template cap — it can only let a session run LONGER). */
export const runawayBound = (advisory) => Math.max(Number(advisory) || 0, RUNAWAY_TURNS);

// ---- instrument failure: the session that opened with no tools -----------------------------------
// 2026-07-28. A Category C smoke arm scored 1/6 with 5 abstains. Cause: its MCP shim never connected
// (`mcp_servers: [{status:"pending"}]`, `tools: []`, a 0-byte tool transcript), so the agent answered
// from the opening render in ONE turn — and the SDK still reported `subtype: "success"`, so every
// existing guard passed it through and the harness scored it. Reproducing the same startup connected
// fine, so the cause was transient; the DEFECT is that a run which measured nothing reported a number.
//
// This is the same silent-narrowing family as assertWorldToolsLive (FREEZE_PLAN B4) — an arm quietly
// losing the surface it was defined by — but one layer out: B4 checks the tools the SHIM can serve,
// this checks the tools the SESSION actually received. A stall or a runaway is evidence about the
// session; a missing tool surface is evidence about nothing at all, so the row must be CENSORED and
// the session re-run, never scored.
//
// Terminal subtypes that are non-answers. `metrics()` in bench-report and expandRow in ratchet both
// censor from this list, so the doctrine has exactly one definition.
export const CENSORED_SUBTYPES = ["stalled", "runaway", "error_max_turns", "no_tools"];
export const isCensoredSubtype = (s) => CENSORED_SUBTYPES.includes(s);

/**
 * Inspect the SDK's session-open `system/init` message. Returns a reason string when the tool surface
 * the session actually received cannot express the arm, or null when the surface is sound.
 *
 * @param {object}   o
 * @param {string[]} o.tools         `init.tools` — fully-qualified names as the SDK reports them
 * @param {object[]} o.mcpServers    `init.mcp_servers` — [{name, status}]
 * @param {string[]} o.expected      the arm's allow-list (unqualified tool names)
 * @param {string}   o.prefix        MCP name prefix the runner mounts the shim under
 * @param {string}   o.serverName    the server the ARM mounts; other servers are none of its business
 */
export function toolSurfaceFailure({ tools = [], mcpServers = [], expected = [], prefix = "", serverName = null } = {}) {
  // Scope the status check to the arm's OWN server. The SDK's init lists every MCP server configured
  // in the ambient environment, and a developer machine carries unrelated ones — this run met
  // `claude.ai Gmail/Drive/Calendar` sitting in `needs-auth`, which has nothing to do with the arm.
  // Censoring on those would throw away perfectly good sessions: the same defect as scoring a blind
  // one, pointed the other way, and a guard that cries wolf gets switched off. The arm's real
  // exposure is the tool list, checked below.
  const own = serverName ? mcpServers.filter((s) => s && s.name === serverName) : mcpServers;
  if (serverName && mcpServers.length && !own.length) {
    return `MCP server "${serverName}" is absent from the session's server list — the arm was never mounted`;
  }
  const bad = own.filter((s) => s && s.status !== "connected");
  if (bad.length) {
    return `MCP server(s) not connected at session open: ${bad.map((s) => `${s.name}=${s.status}`).join(", ")}`;
  }
  // An arm may legitimately expect nothing (a no-tools condition); only a non-empty allow-list can
  // be betrayed by an empty surface.
  if (!expected.length) return null;
  if (!tools.length) return `session opened with 0 tools while the arm expects ${expected.length}`;
  const live = new Set(tools.map((t) => (prefix && t.startsWith(prefix) ? t.slice(prefix.length) : t)));
  const missing = expected.filter((t) => !live.has(t));
  if (missing.length) {
    return `session opened without ${missing.length} allow-listed tool(s): ${missing.slice(0, 8).join(", ")}` +
      `${missing.length > 8 ? ` (+${missing.length - 8} more)` : ""}`;
  }
  return null;
}
