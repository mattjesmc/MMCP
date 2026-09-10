// Agent memory store — MEMORY_DESIGN.md rev 2, build-order steps 3–4 (append-only records, derived
// index, deterministic block headers, structured + lexical recall). Semantic recall over frontier
// blocks is step 5 and deliberately absent here.
//
// Contract:
//  - log.jsonl / blocks.jsonl / places.jsonl / relations.jsonl are strictly append-only; records are
//    immutable; current state (compaction membership, frontier set, per-subject freshness, id counters)
//    is a derived in-memory index rebuilt from the files in open(). Mutable files are meta.json
//    (derived world metadata), pending.json (assistive queue), tasks.json (per-session task frames)
//    — never records.
//  - Concurrent sessions each run their own process (and MemoryStore) over the same world dir. An
//    advisory lock dir serializes every write and read-side refresh; before allocating an id the
//    index resyncs with the on-disk tail, and the mutable files are re-read inside the lock before
//    each rewrite (advance-only cursor/tick, per-session frames), so writers merge, never clobber.
//  - writeBlock: the model supplies interpretation only (links, activity, outcome, prose, pois); the
//    store DERIVES id, level, tick/time ranges, dim, regions, bounds, tallies and validates
//    ELIGIBILITY (links exist, frontier, coherent) — never whether the model copied data correctly.
//  - tick may be null on any write (offline degradation: game down, wall clock only).

import { appendFile, mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as embeddings from "./embeddings.mjs";
import {
  SCHEMA_VERSION,
  ENTRY_KINDS,
  VERIFY_TARGET_TYPES,
  VERIFY_RESULTS,
  chunkOf,
  regionOf,
  entryId,
  blockId,
  validateEntry,
  validateBlock,
  validateRelation,
  validatePlace,
} from "./schema.mjs";

const DEFAULT_DIM = "minecraft:overworld";

// Cross-process lock tuning: many shim processes (one per Claude session) share one world dir.
const LOCK_SPIN_MS = 25; // sleep between acquisition attempts
const LOCK_WAIT_MS = 2000; // give up (with a clear error) after this long
const STALE_LOCK_MS = 30_000; // a lock dir older than this belongs to a crashed holder — break it
const LOCK_REFRESH_MS = 10_000; // touch the held lock's mtime well inside STALE_LOCK_MS: a
// legitimately long hold (first-ever embedding pass, slow disk) must not read as crashed and get
// broken out from under its holder mid-operation.

// A task frame this old without an update is probably an abandoned session's leftover.
const STALE_TASK_MS = 24 * 3600_000;

/** Rough token estimate for budget math; precision is not the point, monotonicity is. */
/** Cap on the structured `results` array a recall returns — the render is the interface; the
 * payload must stay bounded too (an uncapped structured-only recall returned the whole store). */
const RESULTS_CAP = 100;

function tokens(s) {
  return Math.ceil(s.length / 4);
}

/**
 * tmp+rename JSON write: a crash mid-write must leave either the old file or the new one, never a
 * torn half — torn meta/tasks/pending JSON bricked every subsequent mem_* call until hand-repaired.
 * The tmp name carries the pid so unlocked callers (last_world.json) can't interleave in one tmp
 * file; a leftover tmp from a crash is inert. Node's rename overwrites atomically on POSIX and on
 * Windows (MoveFileEx with REPLACE_EXISTING).
 */
export async function writeJsonAtomic(path, value) {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await rename(tmp, path);
}

/**
 * The compaction nag, worded once for every surface that shows it (recent-cli, ablation harness,
 * soak). Either level can fire alone, so the line names the level it is asking for.
 */
export function formatCompactionNag(due) {
  if (!due) return null;
  const parts = [];
  if (due.entries?.length) parts.push(`${due.entries.length} entries → L1 (${due.entries.join(", ")})`);
  if (due.blocks?.length) parts.push(`${due.blocks.length} blocks → L2 (${due.blocks.join(", ")})`);
  if (!parts.length) return null;
  return `[compaction_due] overdue: ${parts.join("; ")} — mem_write_block before continuing.`;
}

function fmtPos(pos) {
  return pos ? `(${pos[0]},${pos[1]},${pos[2]})` : "(no position)";
}

/** Compact wall-clock age for the task-frame render: 45s, 12m, 5h, 3d. */
function fmtAge(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/**
 * Advance-only event-cursor merge: the cursor never moves backwards — a lower cursor would re-deliver
 * events another process already classified. Non-numeric cursors degrade to "incoming non-null wins".
 */
function mergeCursor(current, incoming) {
  if (current === null || current === undefined) return incoming ?? null;
  if (incoming === null || incoming === undefined) return current;
  if (typeof current === "number" && typeof incoming === "number") return Math.max(current, incoming);
  return incoming;
}

/**
 * tasks.json shape tolerance: current shape is {v, frames: {sessionKey: task}}; the pre-concurrency
 * shape {v, current: task} reads as a single frame under the key "legacy".
 */
function taskFrames(parsed) {
  if (parsed.frames) return { ...parsed.frames };
  return parsed.current ? { legacy: parsed.current } : {};
}

/** Distance from a point to an axis-aligned box (0 when inside). */
function boxDistance(pos, bounds) {
  let d2 = 0;
  for (let i = 0; i < 3; i++) {
    const c = Math.max(bounds[0][i], Math.min(pos[i], bounds[1][i]));
    d2 += (pos[i] - c) ** 2;
  }
  return Math.sqrt(d2);
}

function dist(a, b) {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

function tokenize(s) {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** Fraction of query tokens present in the text (lexical channel score). */
function lexScore(queryTokens, text) {
  if (queryTokens.length === 0) return 0;
  const hay = new Set(tokenize(text));
  let hit = 0;
  for (const t of queryTokens) if (hay.has(t)) hit++;
  return hit / queryTokens.length;
}

function reject(violations) {
  throw new Error(`not eligible: ${violations.join("; ")}`);
}

export class MemoryStore {
  // Cross-process coordination. #lockDepth makes the advisory lock reentrant within one logical
  // operation of THIS instance; #seen counts how many records of each append-only file this instance
  // has indexed, so #resyncRecords can merge just the tail other processes appended.
  #lockDepth = 0;
  #seen = {};
  // Embedding-index tail tracking (mirrors #seen for embeddings.jsonl): how many lines this
  // instance has indexed, and whether the file's last line is missing its newline (a crashed
  // writer's torn tail — the next append must not concatenate onto it).
  #embedSeenLines = 0;
  #embedNeedsNewline = false;

  /**
   * @param {string} rootDir   memory root; records live under `${rootDir}/${worldUuid}/`
   * @param {{world_uuid: string, name?: string}} worldInfo   from get_world_info (or cached offline)
   */
  constructor(rootDir, worldInfo) {
    if (!rootDir) throw new Error("rootDir required");
    if (!worldInfo?.world_uuid) throw new Error("worldInfo.world_uuid required");
    this.rootDir = rootDir;
    this.worldInfo = worldInfo;
    this.dir = join(rootDir, worldInfo.world_uuid);
    this.schemaVersion = SCHEMA_VERSION;
  }

  // --- lifecycle ---------------------------------------------------------------------------------

  /** Load files, rebuild the derived index. Idempotent. */
  async open() {
    await mkdir(this.dir, { recursive: true });
    this.entries = new Map();
    this.blocks = new Map();
    this.places = new Map();
    this.relations = [];
    this.compactedInto = new Map(); // entry/block id -> covering block id
    this.latestVerification = new Map(); // place/entry id -> verification relation
    this.maxSeenTick = 0;
    this.#seen = {};
    // Pending-candidate queue: derived, rebuildable, assistive — NOT memory. Mutable like meta.json;
    // the append-only guarantee covers record files only.
    this.eventCursor = null;
    this.pending = [];
    // Task frames: per-session goal / working state (MEMORY_DESIGN.md §Session charter), keyed by
    // session id. Working state, not history — history is what mem_note/mem_write_block record when
    // a task ends. Pre-concurrency files carried a single `current`, read as frame key "legacy".
    this.tasks = {};

    await this.#withLock(async () => {
      await this.#resyncRecords(); // from empty index: reads everything
      await this.#syncPending();
      await this.#syncTasks();
      await this.#writeMeta(); // also merges max_seen_tick forward from meta.json
    });
    return this;
  }

  /** True when the world's current tick sits BEFORE memory's horizon: backup restore / rollback. */
  rollbackDetected(currentTick) {
    return Number.isInteger(currentTick) && currentTick < this.maxSeenTick;
  }

  // --- writes ------------------------------------------------------------------------------------

  /** mem_note: append an L0 entry. Stamps id/t/chunk/region; tick from caller (null when offline). */
  async note({ kind, text, pos = null, refs = null, tick = null, session, dim = DEFAULT_DIM,
               confidence = null }) {
    if (!ENTRY_KINDS.includes(kind)) throw new Error(`kind must be one of ${ENTRY_KINDS.join("|")}`);
    return this.#withLock(async () => {
      await this.#resyncRecords(); // other processes may have allocated ids since we last looked
      const rec = {
        v: SCHEMA_VERSION,
        id: entryId(this.#nextId(this.entries)),
        session,
        t: new Date().toISOString(),
        tick,
        kind,
        dim,
        pos,
        chunk: pos ? chunkOf(pos) : null,
        region: pos ? regionOf(pos) : null,
        text,
        refs,
        // Written only when it is not the default, so existing records stay byte-identical and the
        // common (first-hand) note costs no bytes.
        ...(confidence && confidence !== "observed" ? { confidence } : {}),
      };
      const violations = validateEntry(rec);
      if (violations.length) reject(violations);
      await this.#append("log.jsonl", rec);
      this.entries.set(rec.id, rec);
      await this.#bumpTick(tick);

      // Auto-ack: describing a pending event IS the acknowledgment. The ack relation links entry↔event.
      if (refs?.events?.length) {
        await this.#syncPending();
        for (const eventId of refs.events) {
          if (this.pending.some((c) => c.event_id === eventId)) {
            const rel = { v: SCHEMA_VERSION, kind: "ack", t: rec.t, event_id: eventId, entry: rec.id };
            await this.#append("relations.jsonl", rel);
            this.#indexRelation(rel);
            this.pending = this.pending.filter((c) => c.event_id !== eventId);
          }
        }
        await this.#writePending();
      }
      return rec;
    });
  }

  // --- pending-candidate surface (assistive narration, not automation) ---------------------------

  /** Adopt a new event-log cursor and enqueue rule-flagged candidates (classification is caller-side). */
  async updatePending(cursor, candidates = []) {
    await this.#withLock(async () => {
      await this.#syncPending(); // merge other processes' queue state before mutating
      // Candidates at or below the cursor already on disk were classified by another process —
      // and possibly dismissed. Re-adding them here would resurrect that dismissal (the queue has
      // no tombstones; the cursor IS the tombstone).
      const seenTo = typeof this.eventCursor === "number" ? this.eventCursor : -Infinity;
      const fresh = candidates.filter((c) => typeof c.event_id !== "number" || c.event_id > seenTo);
      this.eventCursor = mergeCursor(this.eventCursor, cursor);
      const known = new Set(this.pending.map((c) => c.event_id));
      for (const c of fresh) {
        if (!known.has(c.event_id)) this.pending.push(c);
      }
      await this.#writePending();
    });
  }

  /**
   * The one sanctioned backwards cursor move: the game restarted and event ids began again at 1
   * (get_events said cursor_reset), so the advance-only merge would pin us at a future id forever.
   */
  async resetEventCursor(cursor = 0) {
    await this.#withLock(async () => {
      await this.#syncPending(); // adopt the queue as others left it; only the cursor resets
      this.eventCursor = cursor;
      await this.#writePending();
    });
  }

  /**
   * Explicit dismissal: drop from the queue, by event id and/or by classification rule (bulk sweep —
   * e.g. rule "action_outcome" clears goto-mechanics spam in one call). No relation — the queue is
   * assistive state, not memory.
   */
  async dismissPending(eventIds = [], rule = null) {
    return this.#withLock(async () => {
      await this.#syncPending();
      const drop = new Set(eventIds);
      const before = this.pending.length;
      this.pending = this.pending.filter((c) => !drop.has(c.event_id) && (rule === null || c.rule !== rule));
      await this.#writePending();
      return before - this.pending.length;
    });
  }

  // --- task frames (tasks.json — per-session goal / working state; mutable, never a record file) ---
  // Concurrent sessions each own one frame, keyed by their session id. A pre-concurrency single
  // `current` task reads as frame "legacy"; the first session to touch the frame (set falls back to
  // it for `replaced`, update/clear fall back to operating on it) adopts or closes it, so upgrades
  // never strand a live goal.

  /** The frame key this session's op targets: its own frame, else a leftover legacy frame, else null. */
  #taskKeyFor(session) {
    if (typeof session !== "string" || !session) throw new Error("session: required");
    return this.tasks[session] ? session : this.tasks.legacy ? "legacy" : null;
  }

  /** mem_task set: begin/replace this session's task. Returns any displaced task for the same frame so it is never silently lost. */
  async setTask({ goal, state = null, tick = null, session }) {
    if (typeof session !== "string" || !session) throw new Error("session: required");
    if (typeof goal !== "string" || !goal.trim()) throw new Error("goal: required non-empty string");
    if (state !== null && (typeof state !== "string" || !state.trim())) throw new Error("state: expected non-empty string when given");
    return this.#withLock(async () => {
      await this.#syncTasks();
      const replaced = this.tasks[session] ?? this.tasks.legacy ?? null;
      if (!this.tasks[session] && this.tasks.legacy) delete this.tasks.legacy; // adopted — returned as replaced
      const now = new Date().toISOString();
      this.tasks[session] = {
        v: SCHEMA_VERSION,
        goal: goal.trim(),
        state: state?.trim() ?? null,
        session,
        started_t: now,
        started_tick: tick,
        updated_t: now,
        updated_tick: tick,
      };
      await this.#writeTasks();
      await this.#bumpTick(tick);
      return { task: this.tasks[session], replaced };
    });
  }

  /** mem_task update: revise the working-state line of this session's task (goal unchanged). */
  async updateTask({ state, tick = null, session }) {
    if (typeof state !== "string" || !state.trim()) throw new Error("state: required non-empty string");
    return this.#withLock(async () => {
      await this.#syncTasks();
      const key = this.#taskKeyFor(session);
      if (!key) throw new Error("no current task — call mem_task {op:\"set\", goal:\"…\", state:\"…\"} "
        + "first; `update` only revises the state line of a task that already exists");
      this.tasks[key] = { ...this.tasks[key], state: state.trim(), updated_t: new Date().toISOString(), updated_tick: tick ?? this.tasks[key].updated_tick };
      await this.#writeTasks();
      await this.#bumpTick(tick);
      return this.tasks[key];
    });
  }

  /** mem_task clear: close out this session's task. The durable outcome belongs in mem_note, not here. */
  async clearTask({ tick = null, session } = {}) {
    return this.#withLock(async () => {
      await this.#syncTasks();
      const key = this.#taskKeyFor(session);
      if (!key) throw new Error("no current task to clear");
      const closed = this.tasks[key];
      delete this.tasks[key];
      await this.#writeTasks();
      await this.#bumpTick(tick);
      return closed;
    });
  }

  /**
   * mem_write_block: validated compaction. Interpretation in, derived block out; appends the block
   * and one compaction relation (block line first, then relation — a crash between the two leaves an
   * orphan block that stays out of the frontier index and is harmless).
   */
  async writeBlock({ links, activity, outcome, prose, pois = [] }) {
    return this.#withLock(async () => {
      await this.#resyncRecords(); // fresh view: other processes' entries/blocks are linkable, ids stay unique
      return this.#writeBlockLocked({ links, activity, outcome, prose, pois });
    });
  }

  async #writeBlockLocked({ links, activity, outcome, prose, pois }) {
    const entryIds = links?.entries ?? [];
    const blockIds = links?.blocks ?? [];
    const violations = [];

    if ((entryIds.length === 0) === (blockIds.length === 0)) {
      violations.push("links: exactly one of entries[] or blocks[] must be non-empty");
    }
    const children = [];
    for (const id of entryIds) {
      const e = this.entries.get(id);
      if (!e) violations.push(`links.entries: ${id} does not exist`);
      else if (this.compactedInto.has(id)) violations.push(`links.entries: ${id} already compacted into ${this.compactedInto.get(id)} (not frontier)`);
      else children.push(e);
    }
    for (const id of blockIds) {
      const b = this.blocks.get(id);
      if (!b) violations.push(`links.blocks: ${id} does not exist`);
      else if (this.compactedInto.has(id)) violations.push(`links.blocks: ${id} already compacted into ${this.compactedInto.get(id)} (not frontier)`);
      else children.push(b);
    }
    for (const p of pois) {
      if (!this.places.has(p)) violations.push(`pois: ${p} not in places.jsonl — promote via mem_place first`);
    }
    if (typeof activity !== "string" || !activity.trim()) violations.push("activity: required");
    if (typeof outcome !== "string" || !outcome.trim()) violations.push("outcome: required");
    if (typeof prose !== "string" || !prose.trim()) violations.push("prose: required");
    if (violations.length) reject(violations);

    // Coherence: one dimension per block (multi-dim episodes must be partitioned).
    const dims = [...new Set(children.map((c) => c.dim))];
    if (dims.length > 1) reject([`coherence: children span dimensions ${dims.join(", ")} — partition the compaction`]);

    // Derived header. Ticks: entries may be tickless (offline); ranges come from what carries ticks.
    const ticks = children.flatMap((c) => (c.tick_range ? c.tick_range : c.tick !== null ? [c.tick] : []));
    if (ticks.length === 0) reject(["cannot derive tick_range: no linked record carries a tick"]);
    const positioned = children.flatMap((c) => (c.bounds ? c.bounds : c.pos ? [c.pos] : []));
    if (positioned.length === 0) reject(["cannot derive bounds: no linked record carries a position"]);
    const times = children.flatMap((c) => (c.time_range ? c.time_range : [c.t]));
    const regions = [...new Set(children.flatMap((c) => (c.regions ? c.regions : c.region ? [c.region] : [])))].sort();
    const level = blockIds.length > 0 ? Math.max(...children.map((c) => c.level)) + 1 : 1;
    const eventsLinked = children.flatMap((c) => c.refs?.events ?? []).length;

    const rec = {
      v: SCHEMA_VERSION,
      id: blockId(this.#nextId(this.blocks)),
      level,
      tick_range: [Math.min(...ticks), Math.max(...ticks)],
      time_range: [times.reduce((a, b) => (a < b ? a : b)), times.reduce((a, b) => (a > b ? a : b))],
      dim: dims[0],
      regions,
      bounds: [
        [0, 1, 2].map((i) => Math.min(...positioned.map((p) => p[i]))),
        [0, 1, 2].map((i) => Math.max(...positioned.map((p) => p[i]))),
      ],
      activity,
      pois: [...pois],
      tallies: { events_linked: eventsLinked, derived_from: "linked audit events" },
      outcome,
      prose,
      links: { entries: [...entryIds], blocks: [...blockIds] },
      created_tick: this.maxSeenTick,
      last_activity_tick: Math.max(...ticks),
    };
    const recViolations = validateBlock(rec);
    if (recViolations.length) reject(recViolations); // derivation bug, not caller error — but never persist it

    const rel = {
      v: SCHEMA_VERSION,
      kind: "compaction",
      t: new Date().toISOString(),
      tick: this.maxSeenTick,
      block: rec.id,
      ...(entryIds.length > 0 ? { entries: [...entryIds] } : { blocks: [...blockIds] }),
    };
    await this.#append("blocks.jsonl", rec);
    await this.#append("relations.jsonl", rel);
    this.blocks.set(rec.id, rec);
    this.#indexRelation(rel);
    return rec;
  }

  /** mem_place: promote/update a POI. Same name → same id → append-only update, last version wins. */
  async place({ category, pos, name = null, notes = null, tick = null, dim = DEFAULT_DIM }) {
    const slug = (name ?? category ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    if (!slug) throw new Error("place needs a name or category to derive its id");
    return this.#withLock(async () => {
      await this.#resyncRecords(); // an earlier version of this place may exist from another process
      return this.#placeLocked({ category, pos, name, notes, tick, dim, slug });
    });
  }

  async #placeLocked({ category, pos, name, notes, tick, dim, slug }) {
    const rec = {
      v: SCHEMA_VERSION,
      id: `p-${slug}`,
      category,
      dim,
      pos,
      name,
      notes,
      discovered_tick: this.places.get(`p-${slug}`)?.discovered_tick ?? tick,
    };
    const violations = validatePlace(rec);
    if (violations.length) reject(violations);
    await this.#append("places.jsonl", rec);
    this.places.set(rec.id, rec);
    await this.#bumpTick(tick);
    return rec;
  }

  /** Per-subject verification relation (target place|entry — never a block). The mem_verify TOOL is
   *  deleted (MEMORY_REDESIGN §3 — freshness now derives from capture); this stays so the relations
   *  already written into stores keep loading and rendering as history. */
  async verify({ targetType, targetId, result, note = null, tick = null }) {
    if (!VERIFY_TARGET_TYPES.includes(targetType)) throw new Error(`targetType must be ${VERIFY_TARGET_TYPES.join("|")}`);
    if (!VERIFY_RESULTS.includes(result)) throw new Error(`result must be ${VERIFY_RESULTS.join("|")}`);
    return this.#withLock(async () => {
      await this.#resyncRecords(); // the target may have been recorded by another process
      return this.#verifyLocked({ targetType, targetId, result, note, tick });
    });
  }

  async #verifyLocked({ targetType, targetId, result, note, tick }) {
    const exists = targetType === "place" ? this.places.has(targetId) : this.entries.has(targetId);
    if (!exists) throw new Error(`${targetType} ${targetId} does not exist`);
    const rel = {
      v: SCHEMA_VERSION,
      kind: "verification",
      t: new Date().toISOString(),
      target_type: targetType,
      target_id: targetId,
      result,
      tick,
      ...(note !== null ? { note } : {}),
    };
    const violations = validateRelation(rel);
    if (violations.length) reject(violations);
    await this.#append("relations.jsonl", rel);
    this.#indexRelation(rel);
    await this.#bumpTick(tick);
    return rel;
  }

  // --- reads -------------------------------------------------------------------------------------

  /** mem_recall `ids`: full records by id, each with every relation that mentions it, in file order. */
  async read({ ids }) {
    await this.#refreshFromDisk();
    return ids.map((id) => {
      const record = this.entries.get(id) ?? this.blocks.get(id) ?? this.places.get(id) ?? null;
      const relations = this.relations.filter((r) =>
        r.block === id || r.target_id === id || r.entry === id ||
        (r.entries ?? []).includes(id) || (r.blocks ?? []).includes(id));
      return { id, record, relations };
    });
  }

  /** mem_recent: telescope render — frontier blocks coarse, uncompacted entries verbatim. `session` labels the caller's own frame in the structured result. */
  async recent({ budgetTokens = 4000, session = null } = {}) {
    await this.#refreshFromDisk();
    const lines = [`## Memory @ tick ${this.maxSeenTick} (world: ${this.worldInfo.name ?? this.worldInfo.world_uuid})`];
    const frontierBlocks = [...this.blocks.values()]
      .filter((b) => !this.compactedInto.has(b.id))
      .sort((a, b) => a.tick_range[0] - b.tick_range[0]);

    // The coarse layer is budgeted like the tail: without a cap it grows linearly with history and
    // the telescope stops being a telescope. Overflow is elided oldest-first (those are exactly the
    // blocks the L1→L2 nag below asks to compact) and the elision line keeps them findable.
    const blockBudget = budgetTokens / 4;
    const blockLine = (b) =>
      `[${b.id} L${b.level} tick ${b.tick_range[0]}–${b.tick_range[1]} ${b.regions.join(",")}] ${b.outcome} (mem_recall ids:["${b.id}"])`;
    const blockTokens = tokens(frontierBlocks.map(blockLine).join("\n"));
    const elisionLineFor = (elided) =>
      `[… ${elided.length} older frontier block(s) elided, tick ${elided[0].tick_range[0]}–${elided[elided.length - 1].tick_range[1]} — mem_recall ids: ${elided[0].id}…${elided[elided.length - 1].id}]`;
    let shownBlocks = frontierBlocks;
    let elisionLine = null;
    if (blockTokens > blockBudget) {
      // Drop oldest-first until the section fits — counting the elision line itself, which is part
      // of the section. At least one block always survives, so the frontier never renders empty.
      for (let cut = 1; cut < frontierBlocks.length; cut++) {
        shownBlocks = frontierBlocks.slice(cut);
        elisionLine = elisionLineFor(frontierBlocks.slice(0, cut));
        if (tokens([elisionLine, ...shownBlocks.map(blockLine)].join("\n")) <= blockBudget) break;
      }
    }
    if (elisionLine) lines.push(elisionLine);
    for (const b of shownBlocks) lines.push(blockLine(b));
    // Task frames: every live session's goal, labeled by session key, freshest first. Stale frames
    // are a real hazard with concurrent sessions — an abandoned frame reads like a live goal.
    const frames = Object.entries(this.tasks)
      .sort((a, b) => (Date.parse(b[1].updated_t) || 0) - (Date.parse(a[1].updated_t) || 0));
    if (frames.length === 0) {
      lines.push(`[task] none — mem_task set when a goal begins`);
    } else {
      for (const [key, t] of frames) {
        const st = t.state ? ` — ${t.state}` : "";
        const ageMs = Date.now() - (Date.parse(t.updated_t) || Date.now());
        const stale = ageMs > STALE_TASK_MS ? " (stale — clear or update)" : "";
        lines.push(`[task ${key}] ${t.goal}${st} (updated ${fmtAge(ageMs)} ago)${stale}`);
      }
    }
    if (this.pending.length > 0) {
      const shown = this.pending.slice(0, 5);
      lines.push(`[pending] ${this.pending.length} event(s) not yet in memory — mem_note with refs.events to acknowledge, or mem_dismiss:`);
      for (const c of shown) {
        lines.push(`  event ${c.event_id} tick ${c.game_tick} (${c.rule}): ${c.summary}`);
      }
      if (this.pending.length > shown.length) lines.push(`  … ${this.pending.length - shown.length} more`);
    }
    const tail = [...this.entries.values()]
      .filter((e) => !this.compactedInto.has(e.id))
      .sort((a, b) => (a.tick ?? 0) - (b.tick ?? 0));
    lines.push("--- recent entries (verbatim) ---");
    // The confidence marker rides the rendered line, not just the record: a note read back without
    // it is read as fact, which is the whole failure this field exists to stop.
    const entryLine = (e) => `${e.id} tick ${e.tick ?? "?"} ${fmtPos(e.pos)} ${e.kind}`
      + (e.confidence && e.confidence !== "observed" ? ` [${e.confidence.toUpperCase()}]` : "")
      + `: ${e.text}`;
    const tailLines = tail.map(entryLine);
    lines.push(...tailLines);

    // Compaction triggers: tool-visible, never a daemon. Oldest first until the section fits.
    const dueEntries = [];
    const dueBlocks = [];

    // L0 → L1: tail over half the budget, nominate until it fits a quarter.
    let tailTokens = tokens(tailLines.join("\n"));
    if (tailTokens > budgetTokens / 2) {
      for (const e of tail) {
        if (tailTokens <= budgetTokens / 4) break;
        dueEntries.push(e.id);
        tailTokens -= tokens(entryLine(e));
      }
    }

    // L1 → L2: the same rule one level up. writeBlock rejects children spanning dimensions, so
    // nominate within a single dim at the most granular frontier level; fewer than two children
    // would be a compaction that compresses nothing.
    if (blockTokens > blockBudget && frontierBlocks.length > 1) {
      const level = Math.min(...frontierBlocks.map((b) => b.level));
      const group = frontierBlocks.filter((b) => b.level === level && b.dim === frontierBlocks[0].dim);
      let t = blockTokens;
      for (const b of group) {
        if (t <= blockBudget / 2) break;
        dueBlocks.push(b.id);
        t -= tokens(blockLine(b));
      }
      if (dueBlocks.length < 2) dueBlocks.length = 0;
    }

    const compactionDue = dueEntries.length || dueBlocks.length
      ? { entries: dueEntries, blocks: dueBlocks }
      : null;
    return {
      render: lines.join("\n"),
      compactionDue,
      pending: [...this.pending],
      // `task` stays the caller's own frame (legacy fallback mirrors mem_task's); `frames` is all of them.
      task: (session ? this.tasks[session] ?? this.tasks.legacy : null) ?? null,
      frames: { ...this.tasks },
    };
  }

  /**
   * mem_recall: hybrid retrieval — structured filters and lexical scan over ALL records; semantic
   * over frontier blocks arrives with step 5. Results render chronologically, clustered by episode;
   * a raw L0 hit renders with its covering block's gloss; per-subject verification and truncation are
   * explicit.
   */
  async recall({ query = null, center = null, radius = null, tickRange = null, budgetTokens = 2000 } = {}) {
    await this.#refreshFromDisk();
    // A `center` with no `radius` used to silently disable the spatial filter while the header
    // still read "near (x,y,z)" — every record matched under a near-heading. Default the radius
    // instead (disclosed in the header, which prints the effective value).
    if (center && radius === null) radius = 64;
    const queryTokens = query ? tokenize(query) : null;

    const inSpace = (rec) => {
      if (!center || radius === null) return true;
      if (rec.bounds) return boxDistance(center, rec.bounds) <= radius;
      if (rec.pos) return dist(center, rec.pos) <= radius;
      return false;
    };
    const inTime = (rec) => {
      if (!tickRange) return true;
      const [lo, hi] = tickRange;
      if (rec.tick_range) return rec.tick_range[1] >= lo && rec.tick_range[0] <= hi;
      // Places carry no event tick; discovered_tick is their only timestamp. Without this
      // fallback a tick_range filter silently excluded every place — "no places match" over
      // data that exists.
      const t = rec.tick ?? rec.discovered_tick ?? null;
      return t !== null && t >= lo && t <= hi;
    };
    const lexText = (rec) =>
      rec.text ?? [rec.prose, rec.outcome, rec.activity].filter(Boolean).join(" ") ??
      "";
    const placeText = (rec) => [rec.name, rec.category, rec.notes].filter(Boolean).join(" ");

    const hits = [];
    const byId = new Map();
    const consider = (rec, text) => {
      if (!inSpace(rec) || !inTime(rec)) return;
      if (queryTokens) {
        const score = lexScore(queryTokens, text);
        if (score < 0.5) return;
        byId.set(rec.id, { rec, score, channel: "lexical" });
        hits.push(byId.get(rec.id));
      } else {
        hits.push({ rec, score: 0, channel: "structured" });
      }
    };
    for (const e of this.entries.values()) consider(e, e.text);
    for (const b of this.blocks.values()) consider(b, lexText(b));
    for (const p of this.places.values()) consider(p, placeText(p));

    // Semantic channel: conceptual retrieval over FRONTIER blocks only. Exact channels above stay
    // primary; a block already found lexically just gains the higher score. Absent backend or
    // unembedded blocks degrade to lexical-only — never an error.
    if (query && (await embeddings.available())) {
      // The whole channel is best-effort: any failure here (index IO, inference) degrades recall
      // to structured + lexical — "semantic channel degrades, never errors" is the contract.
      try {
        await this.#ensureEmbedded();
        // Per-model cutoff, not a constant: cosine scales differ enough between models that a shared
        // number silently turns "no match" into "every match" (queue item 3).
        const minCos = embeddings.threshold();
        const [qvec] = (await embeddings.embed([query])) ?? [null];
        if (qvec) {
          for (const b of this.blocks.values()) {
            if (this.compactedInto.has(b.id) || !inSpace(b) || !inTime(b)) continue;
            const vec = this.embedIndex?.get(b.id);
            if (!vec) continue;
            const cos = embeddings.cosine(qvec, vec);
            if (cos < minCos) continue;
            const existing = byId.get(b.id);
            if (existing) {
              existing.channel = "both";
              existing.score = Math.max(existing.score, cos);
            } else {
              byId.set(b.id, { rec: b, score: cos, channel: "semantic" });
              hits.push(byId.get(b.id));
            }
          }
        }
      } catch (e) {
        process.stderr.write(`[memory] semantic channel failed (${e.message}) — recall served lexical/structured only\n`);
      }
    }

    // Dedup: an entry and its covering block collapse to the entry (most specific record wins).
    const hitIds = new Set(hits.map((h) => h.rec.id));
    const deduped = hits.filter((h) => {
      if (!h.rec.links) return true; // not a block
      const children = [...(h.rec.links.entries ?? []), ...(h.rec.links.blocks ?? [])];
      return !children.some((c) => hitIds.has(c));
    });

    // Enrich: covering block + per-subject verification (freshness is per subject, never per block).
    // Exact-first: lexical hits outrank semantic-only ones regardless of score (a verbatim match is
    // evidence; a concept match is a suggestion).
    const channelRank = (c) => (c === "semantic" ? 1 : 0);
    const results = deduped
      .sort((a, b) => channelRank(a.channel) - channelRank(b.channel) || b.score - a.score || (a.rec.tick ?? a.rec.tick_range?.[0] ?? a.rec.discovered_tick ?? 0) - (b.rec.tick ?? b.rec.tick_range?.[0] ?? b.rec.discovered_tick ?? 0))
      .map(({ rec, score, channel }) => ({
        ...rec,
        ...(query ? { score, channel } : {}),
        covering_block: this.compactedInto.get(rec.id) ?? null,
        verification: this.latestVerification.get(rec.id)
          ? { result: this.latestVerification.get(rec.id).result, tick: this.latestVerification.get(rec.id).tick }
          : null,
      }));

    // Render: chronological, clustered by covering episode.
    const sortTick = (r) => r.tick ?? r.tick_range?.[0] ?? r.discovered_tick ?? 0;
    const chronological = [...results].sort((a, b) => sortTick(a) - sortTick(b));
    const lines = [`## Recall${query ? `: "${query}"` : ""}${center ? ` near ${fmtPos(center)} r=${radius}` : ""} — ${results.length} result(s), oldest first`];
    const emittedBlocks = new Set();
    let omitted = 0;
    for (const r of chronological) {
      const cluster = [];
      const coveringId = r.covering_block;
      if (coveringId && !emittedBlocks.has(coveringId)) {
        const b = this.blocks.get(coveringId);
        cluster.push(`[${b.id} L${b.level} tick ${b.tick_range[0]}–${b.tick_range[1]}] ${b.outcome} (mem_recall ids:["${b.id}"])`);
        emittedBlocks.add(coveringId);
      }
      const fresh = r.verification
        ? `verified ${r.verification.result} @tick ${r.verification.tick}`
        : "not verified since recorded";
      if (r.text) cluster.push(`  ${r.id} tick ${r.tick ?? "?"} ${fmtPos(r.pos)}: ${r.text} [${fresh}]`);
      else if (r.links) {
        if (!emittedBlocks.has(r.id)) {
          cluster.push(`[${r.id} L${r.level} tick ${r.tick_range[0]}–${r.tick_range[1]}] ${r.outcome} (mem_recall ids:["${r.id}"])`);
          emittedBlocks.add(r.id);
        }
      } else cluster.push(`  ${r.id} ${r.category} @ ${fmtPos(r.pos)}${r.name ? ` "${r.name}"` : ""} [${fresh}]`);

      if (tokens(lines.concat(cluster).join("\n")) > budgetTokens) {
        omitted++;
        continue;
      }
      lines.push(...cluster);
    }
    if (omitted > 0) lines.push(`(${omitted} result(s) omitted for budget — raise budget_tokens or narrow the query)`);
    // The render is budgeted; the structured payload must be too. A structured-only recall over a
    // mature world used to return the entire store here — hundreds of KB straight into context.
    const truncated = Math.max(0, results.length - RESULTS_CAP);
    if (truncated > 0) lines.push(`(results list capped at ${RESULTS_CAP} of ${results.length} — narrow the filters)`);
    return {
      results: results.slice(0, RESULTS_CAP),
      ...(truncated > 0 ? { results_truncated: truncated } : {}),
      render: lines.join("\n"),
    };
  }

  /**
   * mem_locate: the reverse of mem_recall's spatial filter — concept in, locations out. Lexical
   * match over places, entries and blocks; positional hits cluster per dimension+region (positions
   * from different dimensions are NEVER merged — a nether "farm" and an overworld "farm" are two
   * answers). Absent concepts say absent; there is no nearest-match guessing. Staleness is
   * surfaced per place; freshness beyond the authored stamp derives from captured reads at render time.
   * Semantic channel deliberately absent until calibrated (design decision 2026-07-22).
   */
  async locate({ concept, budgetTokens = 1500 } = {}) {
    await this.#refreshFromDisk();
    const queryTokens = tokenize(concept ?? "");
    if (queryTokens.length === 0) reject(["locate needs a non-empty concept"]);

    const placeText = (rec) => [rec.name, rec.category, rec.notes].filter(Boolean).join(" ");
    const blockText = (rec) => [rec.prose, rec.outcome, rec.activity].filter(Boolean).join(" ");
    const matches = (text) => lexScore(queryTokens, text) >= 0.5;

    // Evidence points: anything matching that knows where it is. Places are the primary answer;
    // entries and blocks corroborate (and can answer alone when no place was ever promoted).
    const clusters = new Map(); // `${dim} ${region}` -> {dim, region, points, places, entries, blocks}
    let nonSpatial = 0;
    const clusterFor = (dim, region) => {
      const key = `${dim} ${region}`;
      if (!clusters.has(key)) {
        clusters.set(key, { dim, region, points: [], places: [], entries: 0, blocks: 0 });
      }
      return clusters.get(key);
    };
    for (const p of this.places.values()) {
      if (!matches(placeText(p))) continue;
      const c = clusterFor(p.dim, p.region ?? regionOf(p.pos));
      c.points.push(p.pos);
      c.places.push(p);
    }
    for (const e of this.entries.values()) {
      if (!matches(e.text ?? "")) continue;
      if (!e.pos) { nonSpatial++; continue; }
      const c = clusterFor(e.dim, e.region ?? regionOf(e.pos));
      c.points.push(e.pos);
      c.entries++;
    }
    for (const b of this.blocks.values()) {
      if (!matches(blockText(b))) continue;
      if (!b.bounds) { nonSpatial++; continue; }
      const mid = [0, 1, 2].map((i) => Math.round((b.bounds[0][i] + b.bounds[1][i]) / 2));
      const c = clusterFor(b.dim, (b.regions ?? [])[0] ?? regionOf(mid));
      c.points.push(mid);
      c.blocks++;
    }

    if (clusters.size === 0) {
      const note = nonSpatial > 0
        ? `${nonSpatial} record(s) mention it but none carry a position — nothing to locate.`
        : "Nothing in memory matches — absent, not merely far away.";
      return { found: false, clusters: [], render: `## Locate: "${concept}" — no known location. ${note}` };
    }

    const out = [...clusters.values()].map((c) => {
      const centroid = [0, 1, 2].map((i) =>
        Math.round(c.points.reduce((s, p) => s + p[i], 0) / c.points.length));
      const spread = Math.round(Math.max(...c.points.map((p) => dist(p, centroid))));
      const places = c.places.map((p) => ({
        id: p.id, name: p.name, category: p.category, pos: p.pos, dim: p.dim,
        discovered_tick: p.discovered_tick ?? null,
        verification: this.latestVerification.get(p.id)
          ? { result: this.latestVerification.get(p.id).result, tick: this.latestVerification.get(p.id).tick }
          : null,
      }));
      return { dim: c.dim, region: c.region, centroid, spread, places, evidence: { entries: c.entries, blocks: c.blocks } };
    }).sort((a, b) => (b.places.length - a.places.length) || (b.evidence.entries + b.evidence.blocks) - (a.evidence.entries + a.evidence.blocks));

    const totalPlaces = out.reduce((s, c) => s + c.places.length, 0);
    const lines = [`## Locate: "${concept}" — ${out.length} cluster(s), ${totalPlaces} place(s)`];
    let stale = false;
    let omitted = 0;
    for (const c of out) {
      const cluster = [`${c.dim} ${c.region} — centroid ${fmtPos(c.centroid)}, spread ${c.spread}:`];
      for (const p of c.places) {
        const fresh = p.verification
          ? `verified ${p.verification.result} @tick ${p.verification.tick}`
          : "not verified since recorded";
        if (!p.verification || p.verification.result === "contradicted") stale = true;
        cluster.push(`  ${p.id} ${p.category} @ ${fmtPos(p.pos)}${p.name ? ` "${p.name}"` : ""} [${fresh}]`);
      }
      if (c.evidence.entries || c.evidence.blocks) {
        cluster.push(`  + ${c.evidence.entries} note(s), ${c.evidence.blocks} episode block(s) here`);
      }
      if (tokens(lines.concat(cluster).join("\n")) > budgetTokens) { omitted++; continue; }
      lines.push(...cluster);
    }
    if (nonSpatial > 0) lines.push(`(${nonSpatial} matching record(s) carry no position and are not located)`);
    if (omitted > 0) lines.push(`(${omitted} cluster(s) omitted for budget — raise budget_tokens)`);
    if (stale) lines.push("(some places are unverified or contradicted — re-read them in the world before relying on them; captured reads there are shown as derived freshness)");
    return { found: true, clusters: out, render: lines.join("\n") };
  }

  // --- internals ---------------------------------------------------------------------------------

  async #readJsonl(file) {
    try {
      const text = await readFile(join(this.dir, file), "utf8");
      return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
  }

  async #append(file, rec) {
    await appendFile(join(this.dir, file), JSON.stringify(rec) + "\n", "utf8");
    this.#seen[file] = (this.#seen[file] ?? 0) + 1; // our own line — resync must not re-index it
  }

  // --- cross-process coordination ----------------------------------------------------------------
  // Every Claude session runs its own shim process, each with a MemoryStore over the SAME world dir.
  // An advisory lock (a `lock` subdirectory — mkdir is atomic, exactly one creator wins) serializes
  // all writes and read-side refreshes; it is held for milliseconds. A lock whose mtime is older
  // than STALE_LOCK_MS belongs to a crashed holder and is broken. The lock is advisory: it cannot
  // rule out a double-break race at the exact staleness boundary, which is acceptable for files
  // this small and writes this short.

  async #withLock(fn) {
    if (this.#lockDepth > 0) {
      // Reentrant within one logical operation of this instance (e.g. note → bumpTick → writeMeta).
      this.#lockDepth++;
      try {
        return await fn();
      } finally {
        this.#lockDepth--;
      }
    }
    const lockDir = join(this.dir, "lock");
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        await mkdir(lockDir); // atomic acquisition
        break;
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
        try {
          const st = await stat(lockDir);
          if (Date.now() - st.mtimeMs > STALE_LOCK_MS) {
            await rm(lockDir, { recursive: true, force: true }); // crashed holder — break it
            continue;
          }
        } catch (e2) {
          if (e2.code !== "ENOENT") throw e2;
          continue; // holder released between mkdir and stat — retry immediately
        }
        if (Date.now() >= deadline) {
          throw new Error(
            `memory lock busy: another process has held ${lockDir} for over ${LOCK_WAIT_MS}ms — retry; a crashed holder's lock breaks after ${STALE_LOCK_MS / 1000}s`);
        }
        await new Promise((r) => setTimeout(r, LOCK_SPIN_MS));
      }
    }
    this.#lockDepth = 1;
    // Keepalive: refresh the lock's mtime so a hold that legitimately outlives STALE_LOCK_MS (the
    // embedding pass over a backlog, a slow disk) is not broken as "crashed" mid-operation.
    const keepalive = setInterval(() => {
      const now = new Date();
      utimes(lockDir, now, now).catch(() => {});
    }, LOCK_REFRESH_MS);
    keepalive.unref?.();
    try {
      return await fn();
    } finally {
      this.#lockDepth = 0;
      clearInterval(keepalive);
      try {
        await rm(lockDir, { recursive: true, force: true });
      } catch {
        // A swallowed release failure orphans the lock: every session stalls until the stale
        // break, 30s per occurrence. Retry once (Windows AV/indexer holds are transient), then
        // at least say so — an announced outage is debuggable, a silent one is not.
        await new Promise((r) => setTimeout(r, 50));
        await rm(lockDir, { recursive: true, force: true }).catch((e) => {
          process.stderr.write(
            `[memory] could not release lock ${lockDir} (${e.message}) — sessions will stall until the stale-lock break (${STALE_LOCK_MS / 1000}s)\n`);
        });
      }
    }
  }

  /**
   * Merge the tail of each append-only file that other processes appended since this instance last
   * looked (#seen counts what we have indexed; our own #append bumps it). Under the lock, so no line
   * is ever read mid-append. From a fresh index this IS the full load open() needs.
   */
  async #resyncRecords() {
    const files = [
      ["log.jsonl", (rec) => {
        this.entries.set(rec.id, rec);
        if (rec.tick !== null) this.maxSeenTick = Math.max(this.maxSeenTick, rec.tick);
      }],
      ["blocks.jsonl", (rec) => {
        this.blocks.set(rec.id, rec);
        this.maxSeenTick = Math.max(this.maxSeenTick, rec.last_activity_tick);
      }],
      ["places.jsonl", (rec) => this.places.set(rec.id, rec)], // append-only updates: last version wins
      ["relations.jsonl", (rec) => this.#indexRelation(rec)],
    ];
    for (const [file, index] of files) {
      const recs = await this.#readJsonl(file);
      for (const rec of recs.slice(this.#seen[file] ?? 0)) index(rec);
      this.#seen[file] = Math.max(this.#seen[file] ?? 0, recs.length);
    }
  }

  /**
   * Adopt pending.json as the processes sharing this dir left it. The candidate list on disk is
   * authoritative: every writer persists under the lock before releasing it, so this instance never
   * holds additions that are not also on disk — adopting (rather than unioning with possibly-stale
   * memory) is what makes another process's ack/dismiss stick instead of resurrecting the candidate.
   * The cursor merges advance-only (mergeCursor): it never moves backwards.
   */
  async #syncPending() {
    try {
      const p = JSON.parse(await readFile(join(this.dir, "pending.json"), "utf8"));
      this.eventCursor = mergeCursor(this.eventCursor, p.cursor ?? null);
      this.pending = p.candidates ?? [];
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }

  /**
   * Adopt tasks.json as other sessions left it (both shapes — see taskFrames). Disk is authoritative
   * for the same reason as #syncPending: our own frame was persisted under the lock by our last
   * mutation, so any divergence is other sessions' writes.
   */
  async #syncTasks() {
    try {
      this.tasks = taskFrames(JSON.parse(await readFile(join(this.dir, "tasks.json"), "utf8")));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      this.tasks = {};
    }
  }

  /** Read-side refresh: reads serve what other processes wrote, not this instance's stale view. */
  async #refreshFromDisk() {
    await this.#withLock(async () => {
      await this.#resyncRecords();
      await this.#syncPending();
      await this.#syncTasks();
    });
  }

  #indexRelation(rel) {
    this.relations.push(rel);
    if (rel.kind === "compaction") {
      for (const id of rel.entries ?? rel.blocks ?? []) this.compactedInto.set(id, rel.block);
    }
    if (rel.kind === "verification") {
      this.latestVerification.set(rel.target_id, rel);
    }
  }

  #nextId(map) {
    let max = 0;
    for (const id of map.keys()) max = Math.max(max, parseInt(id.slice(2), 10));
    return max + 1;
  }

  async #bumpTick(tick) {
    if (Number.isInteger(tick) && tick > this.maxSeenTick) {
      this.maxSeenTick = tick;
      await this.#writeMeta();
    }
  }

  async #writeMeta() {
    await this.#withLock(async () => {
      // Advance-only merge: another process may have seen a later tick than this one.
      try {
        const meta = JSON.parse(await readFile(join(this.dir, "meta.json"), "utf8"));
        this.maxSeenTick = Math.max(this.maxSeenTick, meta.max_seen_tick ?? 0);
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      await writeJsonAtomic(join(this.dir, "meta.json"), {
        v: SCHEMA_VERSION,
        world_uuid: this.worldInfo.world_uuid,
        name: this.worldInfo.name ?? null,
        max_seen_tick: this.maxSeenTick,
      });
    });
  }

  /**
   * Load the per-model embedding index and lazily embed frontier blocks it is missing. The index
   * never mixes models: `index/<model-slug>/embeddings.jsonl`, rebuilt from scratch under a new slug
   * when the model changes. Embedding text = activity + outcome + prose + POI names.
   */
  async #ensureEmbedded() {
    const dir = join(this.dir, "index", embeddings.modelSlug());
    const file = join(dir, "embeddings.jsonl");
    if (!this.embedIndex) this.embedIndex = new Map();
    await this.#loadEmbedTail(file);
    const missing = [...this.blocks.values()].filter((b) => !this.compactedInto.has(b.id) && !this.embedIndex.has(b.id));
    if (missing.length === 0) return;
    const texts = missing.map((b) =>
      `${b.activity}. ${b.outcome} ${b.prose} ${b.pois.map((p) => this.places.get(p)?.name ?? p).join(" ")}`);
    // Inference stays OUTSIDE the lock: a first-ever pass over a backlog can take minutes, and the
    // lock exists for millisecond file operations, not model latency.
    const vecs = await embeddings.embed(texts);
    if (!vecs) return;
    // Appends go INSIDE the lock: concurrent sessions embedding the same frontier used to
    // interleave writes into one shared jsonl. Re-reading the tail under the lock also skips rows
    // another process finished while we inferred, instead of duplicating them.
    await this.#withLock(async () => {
      await this.#loadEmbedTail(file);
      await mkdir(dir, { recursive: true });
      for (let i = 0; i < missing.length; i++) {
        if (this.embedIndex.has(missing[i].id)) continue;
        const row = { v: SCHEMA_VERSION, id: missing[i].id, dim: vecs[i].length, vec: vecs[i] };
        const prefix = this.#embedNeedsNewline ? "\n" : "";
        this.#embedNeedsNewline = false;
        await appendFile(file, prefix + JSON.stringify(row) + "\n", "utf8");
        this.#embedSeenLines++;
        this.embedIndex.set(missing[i].id, vecs[i]);
      }
    });
  }

  /**
   * Index the lines of embeddings.jsonl this instance has not seen yet. A torn line (crashed
   * writer) is skipped, not fatal — its block simply re-embeds; #embedNeedsNewline records a
   * missing trailing newline so the next append starts a fresh line instead of garbling the tail.
   */
  async #loadEmbedTail(file) {
    let text;
    try {
      text = await readFile(file, "utf8");
    } catch (e) {
      if (e.code === "ENOENT") return;
      throw e;
    }
    const lines = text.split("\n").filter(Boolean);
    for (const line of lines.slice(this.#embedSeenLines)) {
      try {
        const { id, vec } = JSON.parse(line);
        this.embedIndex.set(id, vec);
      } catch {
        // torn tail from a crashed writer — unusable; its block stays "missing" and re-embeds
      }
    }
    this.#embedSeenLines = lines.length;
    this.#embedNeedsNewline = text.length > 0 && !text.endsWith("\n");
  }

  async #writeTasks() {
    await writeJsonAtomic(join(this.dir, "tasks.json"), {
      v: SCHEMA_VERSION,
      frames: this.tasks,
    });
  }

  async #writePending() {
    await writeJsonAtomic(join(this.dir, "pending.json"), {
      v: SCHEMA_VERSION,
      cursor: this.eventCursor,
      candidates: this.pending,
    });
  }
}
