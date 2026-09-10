// Mechanical metrics over runner transcripts and memory files (ABLATION_DESIGN.md §Metrics).
// No LLM judge anywhere: assertions on parsed answers, tool-call series, and JSONL records.

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { PERCEPTION_TOOLS } from "./conditions.mjs";

// --- transcript helpers ---------------------------------------------------------------------------

export function toolCalls(transcript) {
  return transcript.filter((e) => e.type === "tool");
}

export function toolCounts(transcript) {
  const byName = {};
  let perception = 0;
  let memory = 0;
  for (const e of toolCalls(transcript)) {
    byName[e.name] = (byName[e.name] ?? 0) + 1;
    if (PERCEPTION_TOOLS.has(e.name)) perception++;
    if (e.name.startsWith("mem_")) memory++;
  }
  return { total: toolCalls(transcript).length, perception, memory, byName };
}

export function dist(a, b) {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

const posOf = (p) => (p == null ? null : Array.isArray(p) ? p : [p.x, p.y, p.z]);

/**
 * Where a perception call was LOOKING. Most reads carry `origin`; `locate` in identify mode carries
 * `at: [{x,y,z}, ...]` and no origin at all, so without this branch every locate-based observation
 * reads as "never looked" — and on the cycle-2 `standard` surface locate IS the point read, which
 * would have made the staleness taxonomy report re-observations as stale assumptions.
 */
function probedPositions(c) {
  const out = [];
  const o = posOf(c.input?.origin) ?? posOf(c.input?.to);
  if (o) out.push(o);
  for (const a of c.input?.at ?? []) {
    const p = posOf(a);
    if (p && p.every(Number.isFinite)) out.push(p);
  }
  for (const b of c.input?.blocks ?? []) {
    const p = posOf(b);
    if (p && p.every(Number.isFinite)) out.push(p);
  }
  return out;
}

/**
 * Targeted acquisition cost: tool calls from episode open until the first correctly-targeted act —
 * a bot_goto or perception origin within `radius` of `target`. Replaces rev-1 "repeated
 * exploration", which punished rational re-observation.
 */
export function targetedAcquisition(transcript, target, radius = 12) {
  const calls = toolCalls(transcript);
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i];
    const probes = c.name === "bot_goto" ? [posOf(c.input?.to)].filter(Boolean)
      : PERCEPTION_TOOLS.has(c.name) ? probedPositions(c)
      : [];
    if (probes.some((p) => dist(p, target) <= radius)) return { found: true, calls_before: i, tool: c.name };
  }
  return { found: false, calls_before: calls.length, tool: null };
}

/** True when any perception call's origin (or a raycast toward) lands within radius of pos. */
export function perceivedNear(transcript, pos, radius = 24) {
  return toolCalls(transcript).some((c) => {
    if (!PERCEPTION_TOOLS.has(c.name)) return false;
    return probedPositions(c).some((p) => dist(p, pos) <= radius);
  });
}

/** run_command inputs that read a specific block (data get block x y z ...) near pos. */
export function dataReadNear(transcript, pos, radius = 4) {
  return toolCalls(transcript).some((c) => {
    if (c.name !== "run_command") return false;
    const m = /data\s+get\s+block\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)/.exec(c.input?.command ?? "");
    return m && dist([+m[1], +m[2], +m[3]], pos) <= radius;
  });
}

/** Commands the AGENT must not run (the charter forbids them; the harness itself uses run_command freely). */
export function forbiddenCommands(transcript) {
  const re = /\b(give|setblock|fill|tp|teleport|summon|clone|kill|gamemode|forceload)\b|^\/?item\s/i;
  return toolCalls(transcript)
    .filter((c) => c.name === "run_command" && re.test(c.input?.command ?? ""))
    .map((c) => c.input.command);
}

/** Did the agent poll the raw event log this episode? (Stale-fact mutation leak vector — flag, not prevent.) */
export function polledRawEvents(transcript) {
  return toolCalls(transcript).some((c) => c.name === "get_events");
}

// --- answers --------------------------------------------------------------------------------------

/** Parse the single ```json block (or best-effort first balanced object) out of the final message. */
export function extractJson(text) {
  const fence = /```json\s*([\s\S]*?)```/g;
  let last = null;
  for (let m; (m = fence.exec(text)); ) last = m[1];
  const candidates = last ? [last] : [];
  if (!candidates.length) {
    const start = text.indexOf("{");
    if (start !== -1) candidates.push(text.slice(start, text.lastIndexOf("}") + 1));
  }
  for (const c of candidates) {
    try { return JSON.parse(c); } catch { /* fall through */ }
  }
  return null;
}

export function posMatch(answer, truth, tolerance = 0) {
  const a = posOf(answer);
  if (!a || a.length !== 3 || !a.every(Number.isFinite)) return { exact: false, close: false };
  const d = dist(a, truth);
  return { exact: d === 0, close: d <= (tolerance || 2) };
}

// --- memory-pipeline funnel -----------------------------------------------------------------------

async function readJsonl(dir, file) {
  try {
    const text = await readFile(join(dir, file), "utf8");
    return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}

/** The per-world dir inside a run's memory root (world uuid is whatever get_world_info reported). */
export async function worldMemoryDir(memoryRoot) {
  const entries = await readdir(memoryRoot, { withFileTypes: true }).catch(() => []);
  const dirs = entries.filter((e) => e.isDirectory() && e.name !== "index").map((e) => e.name);
  return dirs.length ? join(memoryRoot, dirs[0]) : null;
}

/**
 * Per-fact pipeline funnel (rev 2 §Metrics): localizes WHERE memory failed —
 * observed → written → compacted → present in session render → recall called → returned → used.
 * fact: {key, pattern (RegExp source, matched case-insensitively), pos}
 */
/** What mem_recall actually RETURNED, with the echoed query stripped. `render` repeats the query
 *  verbatim (`## Recall: "bookshelf" — 0 result(s), oldest first`), so testing the whole payload
 *  scores a 0-result call as a hit: an unwritten fact reads as retrieved purely because the agent
 *  asked for it by name. Match the results, never the question. */
function recallPayload(res) {
  if (!res || typeof res !== "object") return "";
  if (Array.isArray(res.results)) return JSON.stringify(res.results);
  const { render, query, ...rest } = res;
  return JSON.stringify(rest);
}

export async function factFunnel({ fact, memoryRoot, openingRender, e1Transcript, e2Transcript, usedCorrectly }) {
  const re = new RegExp(fact.pattern, "i");
  const dir = memoryRoot ? await worldMemoryDir(memoryRoot) : null;
  const log = dir ? await readJsonl(dir, "log.jsonl") : [];
  const blocks = dir ? await readJsonl(dir, "blocks.jsonl") : [];
  const relations = dir ? await readJsonl(dir, "relations.jsonl") : [];

  const writtenEntries = log.filter((e) => re.test(e.text));
  const compactedIds = new Set(relations.filter((r) => r.kind === "compaction").flatMap((r) => r.entries ?? []));
  const recallCalls = toolCalls(e2Transcript ?? []).filter((c) => c.name === "mem_recall");
  const returned = recallCalls.some((c) => re.test(recallPayload(c.result?.result)));

  return {
    key: fact.key,
    observed: fact.pos ? perceivedNear(e1Transcript ?? [], fact.pos) || dataReadNear(e1Transcript ?? [], fact.pos) : null,
    written: writtenEntries.length > 0,
    compacted: writtenEntries.some((e) => compactedIds.has(e.id)),
    in_render: openingRender ? re.test(openingRender) : false,
    recall_called: recallCalls.length > 0,
    returned_by_recall: returned,
    used_correctly: usedCorrectly,
    blocks_total: blocks.length,
  };
}
