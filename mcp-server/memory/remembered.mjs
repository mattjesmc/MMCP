// Shared render helpers for REMEMBERED content (MEMORY_REDESIGN.md §2.2 guardrails).
//
// Every remembered value that reaches an agent is tick-stamped and labelled, in one vocabulary,
// wherever it is rendered — the on-read appendix (annotate.mjs), mem_recall, mem_recent's digest.
// This is the 0.6.0 succeeds-falsely doctrine as a shared function rather than a convention each
// call site re-implements: a caller must always be able to tell "I can see this now" from "I saw
// this once", and that distinction must never depend on which door the answer came through.

/** Game-tick age → compact human string (20 ticks/s). */
export function fmtTickAge(ticks) {
  const s = Math.max(0, Math.round(ticks / 20));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function fmtPos(pos) {
  return `(${pos.join(",")})`;
}

/** "@tick 81234, ~33m ago" — or just the tick when the game is down (age is then unknowable). */
export function fmtAge(nowTick, tick) {
  if (!Number.isInteger(nowTick)) return `@tick ${tick} (age unknown — game offline)`;
  return `@tick ${tick}, ${fmtTickAge(nowTick - tick)} ago`;
}

export const REMEMBERED_NOTE =
  "remembered observations from past tool reads — NOT a live read; the world may have changed since";
