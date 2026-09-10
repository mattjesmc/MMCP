// Local mem_* tools (MEMORY_DESIGN.md §Tools) — agent-side memory, merged into the proxied manifest
// by index.mjs. They call the bridge only to stamp tick/world identity and degrade to wall-clock-only
// when the game is down (memory must be readable offline). Mechanism: reads are `observe`; mutations
// get the Node-stamped `memory` tag (they mutate agent state, not the world).

import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryStore, writeJsonAtomic } from "./store.mjs";
import { CONFIDENCE_LEVELS, ENTRY_KINDS } from "./schema.mjs";
import { REMEMBERED_NOTE, fmtAge, fmtPos } from "./remembered.mjs";

export const MEMORY_ROOT =
  process.env.MCPTK_MEMORY_DIR ||
  join(dirname(fileURLToPath(import.meta.url)), "..", "memory-data");

/**
 * Session identity: mod-spawned sessions arrive with MCPTK_SESSION (the id the bridge attributes
 * their calls to), and memory attribution must match bridge attribution — so it wins when present,
 * sanitized into the frozen `s-` id shape (schema.mjs ID_PATTERNS.session). Standalone processes
 * mint a timestamp id suffixed with the pid — the timestamp alone has 1-second resolution, and two
 * sessions launched in the same second would share a task-frame key and clobber each other's goals.
 */
function sessionId() {
  const raw = process.env.MCPTK_SESSION;
  if (raw) {
    const slug = String(raw).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    if (slug) return /^s-./.test(slug) ? slug : `s-${slug}`;
  }
  return `s-${new Date().toISOString().slice(0, 19).toLowerCase().replace(/[t:]/g, "-").replace(/--/g, "-")}-p${process.pid}`;
}

export const SESSION = sessionId();

/**
 * The task frame holds INTENT, and for the survival player that is load-bearing rather than stylish.
 *
 * `mem_task` is rendered back at every session open, so whatever it says is the first thing the
 * player reads after a restart. Session w3-86528 (2026-08-10) wrote "Session 1 complete. Stone tools
 * ready. Underground exploration found no iron - need new strategy next session." into it, and from
 * then on every future wake in that world opened by reading a completion notice about itself. A
 * frame that reports teaches the reader to stop playing; a frame that intends puts them back to
 * work. The charter says so in prose — this is the same rule at the seam, because a small model on a
 * bad day follows the seam and not the prose.
 *
 * Survival-only: the copilot workbench legitimately talks about sessions (it spawns and directs
 * them), so the lint would be wrong there.
 */
const IS_SURVIVAL = (process.env.MCPTK_PROFILE ?? "").trim() === "survival";
const RETROSPECTIVE_TASK =
  /\b(?:next|this|last|previous)\s+session\b|\bsession\s*\d*\s*(?:is\s+)?(?:complete|completed|done|over|ends?|ending|summary|recap)\b|\bhand-?off\b|\bhanding\s+off\b|\bwrap(?:ping)?[-\s]?up\b|\bfor\s+the\s+next\s+(?:session|run|player|agent)\b/i;

/** Null when the text is fine; otherwise the refusal the caller should get back. */
function retrospectiveRefusal(field, text) {
  if (!IS_SURVIVAL || !text) return null;
  const m = RETROSPECTIVE_TASK.exec(String(text));
  if (!m) return null;
  // Machine-stable prefix shape (`field: expected ..., got ...`) so the route ledger's `affordance`
  // classifier keeps binning these the way it bins every other argument refusal.
  return `${field}: expected your CURRENT INTENT, got a retrospective ("${m[0]}") — mem_task is what `
    + `you read after a nap, and a task that reports teaches you to stop playing. Write the present `
    + `tense and the next concrete act instead (e.g. "digging a staircase to y=16 near (-230,70,-60) `
    + `for iron"). Outcomes belong in mem_note; sessions are not yours to track.`;
}

/** store keyed by world uuid; one process usually serves one world, but switching worlds must not mix. */
const stores = new Map();

async function cacheWorld(info) {
  await mkdir(MEMORY_ROOT, { recursive: true });
  // Atomic (and per-pid tmp): this file lives OUTSIDE the world dir's lock, and concurrent
  // sessions all rewrite it; torn JSON here would sever offline access to memory entirely.
  await writeJsonAtomic(join(MEMORY_ROOT, "last_world.json"), info);
}

async function cachedWorld() {
  try {
    return JSON.parse(await readFile(join(MEMORY_ROOT, "last_world.json"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Resolve the active world + current tick. Online: ask the bridge and refresh the offline cache.
 * Offline: fall back to the last known world, tick null. (Exported for the observation layer —
 * capture.mjs and obs-tools.mjs key their store by the same world identity as authored memory.)
 */
export async function resolveWorld(callBridge) {
  try {
    const data = await callBridge("get_world_info", {});
    if (data.ok) {
      const { world_uuid, name, game_tick } = data.result;
      await cacheWorld({ world_uuid, name });
      return { world_uuid, name, tick: game_tick, offline: false };
    }
  } catch {
    // fall through to cache
  }
  const cached = await cachedWorld();
  if (!cached) {
    throw new Error(
      "no world identity: the game is not running and no cached world exists yet — start the game once so get_world_info can mint/report the world uuid");
  }
  return { ...cached, tick: null, offline: true };
}

async function getStore(callBridge) {
  const world = await resolveWorld(callBridge);
  let store = stores.get(world.world_uuid);
  if (!store) {
    store = new MemoryStore(MEMORY_ROOT, { world_uuid: world.world_uuid, name: world.name });
    await store.open();
    stores.set(world.world_uuid, store);
  }
  if (!world.offline) await refreshPending(store, callBridge);
  return { store, world };
}

// --- pending candidates: hardcoded rules, lazy cursor pull — never a background poller ------------

/**
 * Classify one event-log record into a pending-memory candidate, or null. RULES ONLY — an importance
 * classifier is explicitly on the don't-build list. The agent stays the author: candidates nag until
 * described (mem_note with refs.events) or dismissed (mem_dismiss).
 */
export function classifyEvent(ev) {
  const d = ev.data ?? {};
  const mk = (rule, summary) => ({ event_id: ev.id, game_tick: ev.game_tick, rule, summary, t: new Date().toISOString() });
  switch (ev.type) {
    case "action_completed":
      // An arrival is routine mechanics — the outcome the agent narrates is the memory, not the
      // goto. Only a completion that did NOT arrive is a surprise worth nagging about.
      if (d.arrived === true) return null;
      return mk("action_outcome", `${d.action ?? "action"} ${d.action_id ?? ""} completed${d.arrived !== undefined ? ` (arrived: ${d.arrived})` : ""}`.trim());
    case "action_superseded":
      return null; // normal control flow (a new goto replacing the old one while tailing) — never pending
    case "action_failed":
      return mk("action_outcome", `${d.action ?? "action"} ${d.action_id ?? ""} FAILED: ${d.reason ?? "unknown"}`.trim());
    case "drone_removed":
      return String(d.reason ?? "").includes("died") ? mk("drone_lost", `drone removed: ${d.reason}`) : null;
    case "audit":
      if (d.ok === false) return mk("failed_authority_call", `${d.tool} failed: ${d.error ?? "error"}`);
      if (d.mechanism === "world_edit") return mk("world_edit", `${d.tool} ${JSON.stringify(d.args ?? {}).slice(0, 120)}`);
      return null; // successful privileged calls (run_command …) are the agent's own routine ops — noise
    // How the body died is the single most valuable episodic fact a survival session produces, and
    // it used to fall through to `default` — so it lived only in a 1000-entry ring that is cleared
    // at every world close. Next session could not learn from the last one's death. Still RULES
    // ONLY: this makes a candidate that nags until the agent describes it (mem_note) or dismisses
    // it — the agent stays the author, an importance classifier stays on the don't-build list.
    case "body_died":
      return mk("body_died", `DIED at ${fmtEventPos(d.pos)}: ${d.cause ?? "unknown cause"}`
        + (Array.isArray(d.hazards) && d.hazards.length ? ` while ${d.hazards.join(", ")}` : ""));
    case "body_endangered":
      // Only the causes that kill without an obvious story. falling/on_fire/starving are frequent
      // and self-explaining — nagging about them would train the agent to bulk-dismiss the rule,
      // taking the near-drownings with it.
      return ["air_low", "in_lava", "suffocating"].includes(d.cause)
        ? mk("body_hazard", `${d.cause} at ${fmtEventPos(d.pos)}`
          + (d.seconds_left !== undefined ? ` (${d.seconds_left}s left)` : ""))
        : null;
    default:
      return null; // weather/time/entity radius events: situational awareness, not memory candidates
  }
}

/** `{x,y,z}` (rounded, as the mod sends it) as a compact "(x, y, z)" — or "an unknown place". */
function fmtEventPos(pos) {
  if (!pos || typeof pos !== "object") return "an unknown place";
  const { x, y, z } = pos;
  if (![x, y, z].every((n) => typeof n === "number")) return "an unknown place";
  return `(${Math.round(x)}, ${Math.round(y)}, ${Math.round(z)})`;
}

/**
 * Advance the event cursor and enqueue candidates. First contact adopts the cursor WITHOUT
 * classifying — the no-cursor query returns pre-existing history, and flooding a fresh memory with
 * stale candidates would be noise, not assistance. Failures are swallowed: pending is assistive.
 * Exported for the probe suite; production callers go through getStore().
 */
export async function refreshPending(store, callBridge) {
  try {
    if (store.eventCursor === null) {
      const first = await callBridge("get_events", { limit: 1 });
      if (first.ok) await store.updatePending(first.result.cursor, []);
      return;
    }
    let cursor = store.eventCursor;
    for (let round = 0; round < 10; round++) {
      const data = await callBridge("get_events", { cursor, limit: 200 });
      if (!data.ok) return;
      if (data.result.cursor_reset) {
        // The game restarted: event ids begin again at 1, so our persisted cursor points at a
        // future this launch will not reach — without this branch the pending surface would stay
        // silently empty forever. Re-scan from 0 so this launch's events classify normally.
        await store.resetEventCursor(0);
        cursor = 0;
        continue;
      }
      const { events, cursor: next, more, missed } = data.result;
      const candidates = events.map(classifyEvent).filter(Boolean);
      if (missed > 0) {
        // The ring evicted events between our cursor and its oldest retained id (>1000-event
        // burst between mem_* calls). That span is unclassifiable — no candidate from it can ever
        // appear — so the gap itself becomes the candidate instead of vanishing without trace.
        candidates.unshift({
          event_id: cursor + 1, // first evicted id: real, unique, and > the cursor so updatePending keeps it
          game_tick: events[0]?.game_tick ?? null,
          rule: "event_gap",
          summary: `${missed} event(s) (ids ${cursor + 1}–${cursor + missed}) were evicted before this session polled — that span was never classified; memory of it may be incomplete`,
          t: new Date().toISOString(),
        });
      }
      cursor = next;
      await store.updatePending(next, candidates);
      if (!more) break;
    }
  } catch {
    // bridge hiccup — next mem_* call retries from the stored cursor
  }
}

// --- schemas (same JSON-Schema style the mod's manifest uses) -------------------------------------

const posSchema = {
  type: "object",
  description: "Block position. Body coordinates (floats, as bot_status reports them) are accepted and floored.",
  properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } },
  required: ["x", "y", "z"],
};

function obj(properties, required) {
  return { type: "object", properties, required };
}

const TOOLS = [
  {
    name: "mem_note",
    description:
      "Append an entry to the agent's traversal log (L0 memory). Describe explicitly — position, what was seen/done — at the moment of observation; only described facts persist. kinds: obs|act|outcome|note. If the note asserts a MECHANISM (\"X causes Y\", \"doing Z fixes it\") that you did not test, say so with `confidence` — a guess stored in the same voice as an observation becomes a law for every later session.",
    inputSchema: obj({
      kind: { type: "string", enum: ENTRY_KINDS },
      text: { type: "string", description: "Explicit description; include coordinates and specifics — this is what will be remembered." },
      confidence: {
        type: "string",
        enum: CONFIDENCE_LEVELS,
        description: "observed (default — you saw it) | inferred (reasoned from what you saw) | guessed (it fit; you could not test it). Required honesty for cause-and-effect claims.",
      },
      pos: { ...posSchema, description: "Where this happened/was observed. Omit only for placeless notes." },
      refs: {
        type: "object",
        description: "Provenance links: event-log ids, place ids.",
        properties: {
          events: { type: "array", items: { type: "integer" } },
          places: { type: "array", items: { type: "string" } },
        },
      },
    }, ["kind", "text"]),
    mechanism: "memory",
  },
  {
    name: "mem_recent",
    description:
      "Telescope render of working memory: frontier blocks (coarse, older) + uncompacted entries (verbatim, recent), both budgeted. Returns compaction_due when a layer outgrows its share — entries to compact into L1 blocks and/or older blocks to compact into L2. Act on it before continuing the task.",
    inputSchema: obj({ budget_tokens: { type: "integer", description: "Render budget, default 4000." } }, []),
    mechanism: "observe",
  },
  {
    name: "mem_write_block",
    description:
      "Compact log entries (or child blocks) into a history block. Supply ONLY interpretation — links, activity, outcome, prose, pois; the tool derives ranges/bounds/regions/tallies and rejects ineligible or incoherent groupings. Generalize the prose; specifics survive in the linked records.",
    inputSchema: obj({
      links: obj({
        entries: { type: "array", items: { type: "string" } },
        blocks: { type: "array", items: { type: "string" } },
      }, []),
      activity: { type: "string", description: "One word/phrase: exploration, build, mining, …" },
      outcome: { type: "string", description: "One-line result of the episode." },
      prose: { type: "string", description: "General description; omit specifics rather than paraphrasing them." },
      pois: { type: "array", items: { type: "string" }, description: "Place ids touched (promote via mem_place first)." },
    }, ["links", "activity", "outcome", "prose"]),
    mechanism: "memory",
  },
  {
    name: "mem_place",
    description: "Promote/update a point of interest (POI). Same name → same id → update (append-only, last version wins).",
    inputSchema: obj({
      category: { type: "string" },
      pos: posSchema,
      name: { type: "string" },
      notes: { type: "string" },
    }, ["category", "pos"]),
    mechanism: "memory",
  },
  {
    name: "mem_dismiss",
    description:
      "Dismiss pending memory candidates — a deliberate 'not worth remembering'. By `event_ids`, or in bulk by `rule` (e.g. rule:\"action_outcome\" sweeps goto-mechanics spam in one call). To acknowledge one INTO memory instead, mem_note what it meant with refs.events.",
    inputSchema: obj({
      event_ids: { type: "array", items: { type: "integer" } },
      rule: { type: "string", description: "Dismiss every pending candidate flagged by this rule (action_outcome | world_edit | failed_authority_call | drone_lost | event_gap)." },
    }, []),
    mechanism: "memory",
  },
  {
    name: "mem_task",
    description:
      // THE FIELD GRAPH, STATED ONCE. w2-56123 needed three round trips to discover it: `state:
      // required non-empty string` → `no current task — mem_task set first` → `goal: required
      // non-empty string`. Each error was correct and each was one third of the answer; a required-
      // field graph the schema knows is not something a caller should have to excavate by failing.
      "Task frame (current goal / working state) — rendered at every session open so work survives context resets. FIELDS BY OP: set needs `goal` (and takes `state`); update needs `state` and requires a task already set; clear needs neither. So the first call in a session is always set. update revises the one-line working state. clear closes it out — mem_note the outcome FIRST; the frame is working state, not history.",
    inputSchema: obj({
      // `action` is accepted as an alias for `op`. Every other verb on this surface — all ~70 bot_*,
      // mem_dismiss, bot_reactions, bot_body — spells this argument `action`, so a model that has
      // learned the surface reaches for `action` here and gets a hard error. Observed live twice
      // (sessions w1-85918 and the 13:06 run that seeded the route ledger's `affordance` bucket),
      // and the survival Stop hook actively steers models into this call ("check mem_task").
      // The convention is the surface's, not this tool's, to redefine.
      op: { type: "string", enum: ["set", "update", "clear"], description: "set | update | clear (alias: `action`)." },
      action: { type: "string", enum: ["set", "update", "clear"], description: "Alias for `op`." },
      goal: { type: "string", description: "set: the goal being started." },
      state: { type: "string", description: "set/update: one-line working state — where things stand, what comes next." },
    }, []),
    mechanism: "memory",
  },
  {
    name: "mem_recall",
    description:
      "Ask memory directly — the one retrieval tool, over BOTH what you wrote down and what your tool reads recorded. Structured filters (position radius, tick range), exact-word search over all records, `ids` to drill into full records by id (e-/b-/p-) with their relations, and `at`/`box` to get the exact block values past reads observed there (per-id counts and bounding boxes). Results render chronologically, clustered by episode; remembered block values are labelled REMEMBERED and are never live. Use before assuming anything about a previously visited region.",
    inputSchema: obj({
      query: { type: "string", description: "Exact words to find: item names, numbers, entity names." },
      center: posSchema,
      radius: { type: "number", description: "Blocks around `center` (default 64 when `center` is given)." },
      tick_range: { type: "array", items: { type: "integer" }, description: "[lo, hi] game ticks." },
      ids: { type: "array", items: { type: "string" }, description: "Drill down: full records by id (e-/b-/p-), each with every relation that mentions it." },
      at: { ...posSchema, description: "REMEMBERED block value observed at this position by past tool reads, with the tick it was seen and its age." },
      box: {
        type: "object",
        description: "REMEMBERED block values observed in this volume: per-block-id counts and bounding boxes (exact cluster sizes/extents).",
        properties: { min: posSchema, max: posSchema },
        required: ["min", "max"],
      },
      dimension: { type: "string", description: "Dimension for at/box; default minecraft:overworld." },
      budget_tokens: { type: "integer", description: "Render budget, default 2000." },
    }, []),
    mechanism: "observe",
  },
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));

export function localTools() {
  return TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

export function isLocalTool(name) {
  return byName.has(name);
}

// FLOOR THE FLOATS THE BODY READS ABOUT ITSELF. Every position a body reads about its own location
// is a float — bot_status reports {x:-341.5, y:70, z:273.5} — and mem_note refused exactly that with
// "pos: expected [x,y,z] ints or null" (session w2-56123 #12). The agent retyped the call with
// truncated ints and moved on, which is a round trip spent on a conversion the tool could do: a
// block position IS the floor of a body position, unambiguously, and refusing the only form the
// body can produce is a validator picking a fight with its own surface. The strict check stays where
// it belongs — on the stored record (memory/schema.mjs).
const floorPos = (v) => (typeof v === "number" ? Math.floor(v) : v);
const toArr = (p) => (p == null ? null : [floorPos(p.x), floorPos(p.y), floorPos(p.z)]);
const isPosArr = (p) => Array.isArray(p) && p.length === 3 && p.every(Number.isInteger);
const toBox = (b) => (b == null || b.min == null || b.max == null ? null : [
  [0, 1, 2].map((i) => Math.min(b.min[i === 0 ? "x" : i === 1 ? "y" : "z"], b.max[i === 0 ? "x" : i === 1 ? "y" : "z"])),
  [0, 1, 2].map((i) => Math.max(b.min[i === 0 ? "x" : i === 1 ? "y" : "z"], b.max[i === 0 ? "x" : i === 1 ? "y" : "z"])),
]);

const DEFAULT_DIM = "minecraft:overworld";
/** Blocks around a place whose captured cells count as "this place, re-observed". */
const PLACE_FRESHNESS_RADIUS = 2;

/**
 * The observation store, imported lazily. capture.mjs imports MEMORY_ROOT/SESSION/resolveWorld from
 * THIS module, so a static import here would close a module cycle; a dynamic one keeps the
 * dependency one-way and costs a registry lookup after the first call.
 */
async function obsStoreFor(callBridge) {
  const { cachedStore } = await import("./capture.mjs");
  return cachedStore(callBridge);
}

function renderRecords(records) {
  const lines = ["--- records ---"];
  for (const { id, record, relations } of records) {
    if (!record) {
      lines.push(`${id}: no such record`);
      continue;
    }
    lines.push(`${id}: ${JSON.stringify(record)}`);
    for (const rel of relations) lines.push(`  rel ${JSON.stringify(rel)}`);
  }
  return lines.join("\n");
}

/** mem_seen's exact-value answer, relocated into mem_recall (§3). Always labelled REMEMBERED. */
async function observedSection(callBridge, { pos, box, dim, nowTick }) {
  const store = await obsStoreFor(callBridge);
  const r = await store.seenAt({ pos, box, dim });
  const lines = [`--- REMEMBERED block values (${pos ? fmtPos(pos) : `${fmtPos(box[0])}..${fmtPos(box[1])}`} ${dim}) ---`];
  if (pos) {
    if (!r.observed) lines.push("never observed — no captured read covers this cell; look with a live read.");
    else {
      const c = r.cell;
      lines.push(`${c.val}${c.implied ? " (implied by a complete box scan: not listed = air)" : ""} — first ${fmtAge(nowTick, c.tick)}, last confirmed ${fmtAge(nowTick, c.last_confirmed_tick)} (${c.tool})`);
      for (const p of c.previous) lines.push(`  previously ${p.val} ${fmtAge(nowTick, p.tick)} (${p.tool})`);
    }
  } else if (!r.observed) {
    lines.push("never observed — no captured read covers this box.");
  } else {
    for (const e of r.by_id) {
      lines.push(`${e.id} ×${e.count} in ${fmtPos(e.bbox[0])}..${fmtPos(e.bbox[1])} — latest ${fmtAge(nowTick, e.latest_tick)}`);
    }
    if (r.implied_air_tick !== null) {
      lines.push(`(every other cell in the box was air as of ${fmtAge(nowTick, r.implied_air_tick)} — complete scan cover)`);
    }
    if (r.cells_truncated) lines.push(`(${r.cells_truncated} cell(s) beyond the structured cap — narrow the box)`);
  }
  lines.push(`[${REMEMBERED_NOTE}]`);
  return { data: r, render: lines.join("\n") };
}

/**
 * DERIVED FRESHNESS — mem_verify's replacement (§3). Capture mechanically re-confirms cells, so a
 * place can say "cells here re-observed 40m ago" without anyone having recorded a verification
 * stamp. Better than the authored stamp (it is free, and it cannot be forgotten) and it is why
 * mem_verify is deleted rather than kept as a second, weaker signal.
 *
 * Lives here, not in store.mjs: the authored store stays unaware of the observation store, so the
 * join is a render-time composition rather than a dependency between the two layers.
 */
async function placeFreshness(callBridge, results, nowTick) {
  const places = (results ?? []).filter((r) => r.pos && r.category);
  if (!places.length) return null;
  let store;
  try {
    store = await obsStoreFor(callBridge);
  } catch {
    return null; // no world identity (game never started) — freshness is assistive, never fatal
  }
  const lines = [];
  for (const p of places.slice(0, 10)) {
    const box = [
      p.pos.map((v) => v - PLACE_FRESHNESS_RADIUS),
      p.pos.map((v) => v + PLACE_FRESHNESS_RADIUS),
    ];
    const seen = await store.seenAt({ box, dim: p.dim ?? DEFAULT_DIM });
    if (!seen.observed || !seen.cells.length) continue;
    const latest = Math.max(...seen.cells.map((c) => c.last_confirmed_tick));
    lines.push(`  ${p.id}${p.name ? ` "${p.name}"` : ""}: ${seen.cells.length} cell(s) here last re-observed ${fmtAge(nowTick, latest)}`);
  }
  if (!lines.length) return null;
  return ["--- derived freshness (from captured reads, not an authored stamp) ---", ...lines].join("\n");
}

/** Digest lines before the count takes over — a telescope, not a dump. */
const DIGEST_LINE_CAP = 10;

/**
 * THE UNSEEN-CHANGES DIGEST (MEMORY_REDESIGN §2.4) — the second prong of the push. The on-read
 * delta covers cells the agent looks at; this covers the ones it would have no reason to re-read.
 * "While you were away: the wool tower at (x,y,z) is gone."
 *
 * Rendering IS a disclosure, so it appends one disclosure record covering exactly the cells it
 * showed — which is what makes it self-clearing without any ledger file to maintain.
 *
 * Gated by MCPTK_OBS_ANNOTATE with the appendix: the flag governs the PUSH CHANNEL as a whole, so
 * arms g/h (and i/j) differ in "does memory arrive unbidden" and in nothing else.
 */
async function unseenDigest(callBridge, nowTick) {
  if ((process.env.MCPTK_OBS_ANNOTATE ?? "on").trim() === "off") return null;
  let store;
  try {
    store = await obsStoreFor(callBridge);
  } catch {
    return null; // no world identity yet — the digest is assistive, never fatal
  }
  const led = await store.unseenChanges({ dim: null });
  if (!led.total) return null;
  const shown = led.entries.slice(0, DIGEST_LINE_CAP);
  const lines = ["[while you were away — changes detected but never shown to you]"];
  for (const e of shown) {
    lines.push(`  ${fmtPos(e.pos)} ${e.dim}: was ${e.was.val} (your read ${fmtAge(nowTick, e.was.tick)})` +
      `, now ${e.now.val} ${fmtAge(nowTick, e.now.tick)}${e.was.approx ? " — approximate: older history dropped" : ""}`);
  }
  const rest = led.total - shown.length;
  if (rest > 0) lines.push(`  (+${rest} more changed cell(s) — mem_recall at/box to inspect a region)`);
  lines.push(`[${REMEMBERED_NOTE}]`);

  if (Number.isInteger(nowTick)) {
    try {
      // One record covering everything rendered. Offline (tick null) we render but cannot honestly
      // date a disclosure, so the entries stay in the ledger and re-render next time — a duplicate,
      // never a false "already told you".
      const byDim = new Map();
      for (const e of shown) byDim.set(e.dim, [...(byDim.get(e.dim) ?? []), e.pos]);
      for (const [dim, cells] of byDim) {
        await store.recordDisclosure({ tick: nowTick, dim, session: SESSION, cells });
      }
    } catch (e) {
      process.stderr.write(`[observations] digest disclosure failed (${e.message}) — it will re-render\n`);
    }
  }
  return { render: lines.join("\n"), data: led };
}

// --- locate `what:` concept fallthrough (MEMORY_REDESIGN §3) ---------------------------------------

/**
 * The two errors the mod raises when `what` resolves against NO registry (LocateTools.resolveTarget,
 * verified against the mod source 2026-07-29):
 *   - "`what` is not a valid id: …"  — not even id-shaped, e.g. "wheat farm"
 *   - "unknown target '…' — not a structure, point-of-interest type, entity type, biome or block…"
 * Everything else locate can raise (an unknown #tag, malformed pattern relations, bad radius) is a
 * REAL argument error and must keep erroring — catching those would turn a typo into a silent empty
 * memory search. A tag is registry-shaped by construction, so `#whatever` is a typo, never a
 * concept: it keeps erroring even though it is also unresolvable.
 *
 * Kept in sync by hand with the mod's wording (toolkit 0.29.0 added the biome index to both the
 * probe order and this sentence).
 */
const UNRESOLVABLE_WHAT = [
  /^`what` is not a valid id: /,
  /^unknown target '.*' — not a structure, point-of-interest type, entity type, biome or block/,
];

export function isUnresolvableWhat(error) {
  const s = String(error ?? "");
  return UNRESOLVABLE_WHAT.some((re) => re.test(s));
}

/**
 * Answer an unresolvable `what` from memory instead of dead-ending. "Where's the wheat farm" and
 * "where's gold_block" become ONE vocabulary — which was PATTERN_SEARCH's original point, and is
 * why mem_locate is deleted rather than kept beside a tool the agent already reaches for by name.
 *
 * Everything returned is labelled remembered, carries its age, and mints no handles. The
 * absent-concept-says-absent rule carries over: no nearest-match guessing.
 */
export async function locateFromMemory(what, callBridge) {
  const { store, world } = await getStore(callBridge);
  const authored = await store.locate({ concept: what, budgetTokens: 1500 });
  let sightings = { found: false, clusters: [], sightings: [] };
  try {
    const { cachedStore } = await import("./capture.mjs");
    sightings = await (await cachedStore(callBridge)).lastSeen({ what, dim: null });
  } catch {
    // no observation store yet (fresh world) — the authored half still answers
  }
  const lines = [`## "${what}" is not a structure, POI, entity or block id — answered from MEMORY instead`];
  lines.push(authored.render);
  if (sightings.found) {
    lines.push("--- REMEMBERED sightings from past tool reads ---");
    for (const c of sightings.clusters.slice(0, 4)) {
      lines.push(`${c.dim} ${c.region}: ×${c.count} in ${fmtPos(c.bbox[0])}..${fmtPos(c.bbox[1])} — latest ${fmtAge(world.tick, c.latest_tick)}`);
    }
    for (const s of sightings.sightings.slice(0, 4)) {
      lines.push(`[${s.source}] ${s.id ?? s.kind ?? ""}${s.pos ? ` @ ${fmtPos(s.pos)}` : ""} ${fmtAge(world.tick, s.tick)} (${s.dim})`);
    }
  }
  lines.push(`[${REMEMBERED_NOTE}]`);
  return {
    ok: true,
    result: {
      ...authored,
      sightings: sightings.sightings,
      sighting_clusters: sightings.clusters,
      remembered: true,
      fallthrough: "concept",
      negative_is_proof: false,
      render: lines.join("\n"),
      mechanism: "observe",
      note: REMEMBERED_NOTE,
    },
  };
}

/** Execute a local tool. Returns the same {ok, result|error} envelope the bridge uses. */
export async function callLocalTool(name, args, callBridge) {
  const a = args ?? {};
  try {
    const { store, world } = await getStore(callBridge);
    const warn = {};
    if (world.offline) warn.offline = "game unreachable — tick not stamped, wall clock only";
    if (store.rollbackDetected(world.tick)) {
      warn.rollback_warning = `world tick ${world.tick} is BEFORE memory's horizon ${store.maxSeenTick}: backup restore/rollback — memory past that tick describes events that no longer happened`;
    }
    const mech = { mechanism: byName.get(name).mechanism, ...warn };

    switch (name) {
      case "mem_note": {
        const rec = await store.note({
          kind: a.kind, text: a.text, pos: toArr(a.pos), refs: a.refs ?? null,
          tick: world.tick, session: SESSION, confidence: a.confidence ?? null,
        });
        return { ok: true, result: { entry: rec, ...mech } };
      }
      case "mem_recent": {
        const r = await store.recent({ budgetTokens: a.budget_tokens ?? 4000, session: SESSION });
        const digest = await unseenDigest(callBridge, world.tick);
        if (digest) {
          // Headline position: this is the session-open telescope, and "while you were away" is the
          // thing that changes what the agent does next. The header line stays first.
          const lines = r.render.split("\n");
          r.render = [lines[0], digest.render, ...lines.slice(1)].join("\n");
          r.unseen_changes = digest.data;
        }
        return { ok: true, result: { ...r, ...mech } };
      }
      case "mem_write_block": {
        const rec = await store.writeBlock({
          links: a.links, activity: a.activity, outcome: a.outcome, prose: a.prose, pois: a.pois ?? [],
        });
        return { ok: true, result: { block: rec, ...mech } };
      }
      case "mem_place": {
        const rec = await store.place({
          category: a.category, pos: toArr(a.pos), name: a.name ?? null, notes: a.notes ?? null,
          tick: world.tick,
        });
        return { ok: true, result: { place: rec, ...mech } };
      }
      case "mem_dismiss": {
        if (!a.event_ids?.length && !a.rule) {
          return { ok: false, error: "pass event_ids and/or rule" };
        }
        const dropped = await store.dismissPending(a.event_ids ?? [], a.rule ?? null);
        return { ok: true, result: { dismissed: dropped, remaining_pending: store.pending.length, ...mech } };
      }
      case "mem_task": {
        // `action` is the surface-wide spelling; `op` is this tool's. Accept both (see the schema).
        const op = a.op ?? a.action;
        switch (op) {
          case "set": {
            const bad = retrospectiveRefusal("goal", a.goal) ?? retrospectiveRefusal("state", a.state);
            if (bad) return { ok: false, error: bad };
            const { task, replaced } = await store.setTask({ goal: a.goal, state: a.state ?? null, tick: world.tick, session: SESSION });
            return { ok: true, result: { task, ...(replaced ? { replaced, note: "previous task replaced — if its outcome mattered, mem_note it" } : {}), ...mech } };
          }
          case "update": {
            const bad = retrospectiveRefusal("state", a.state);
            if (bad) return { ok: false, error: bad };
            return { ok: true, result: { task: await store.updateTask({ state: a.state, tick: world.tick, session: SESSION }), ...mech } };
          }
          case "clear": {
            const closed = await store.clearTask({ tick: world.tick, session: SESSION });
            return { ok: true, result: { closed, note: "task frame cleared — the durable outcome belongs in mem_note/mem_write_block", ...mech } };
          }
          default:
            // Prefix shape kept machine-stable on purpose: route-ledger's `affordance` classifier
            // anchors on /^[a-z_.]+: expected .+, got /, so the teaching goes AFTER the comma.
            return {
              ok: false,
              error: `op: expected set|update|clear, got ${op} — this tool spells it \`op\`; \`action\` is accepted as an alias`,
            };
        }
      }
      case "mem_recall": {
        // The ONE "ask memory directly" tool, over BOTH stores (MEMORY_REDESIGN §3). `ids` is
        // mem_read's drill-down; `at`/`box` is mem_seen's exact-value answer. Everything remembered
        // is labelled as such and never merged with a live read.
        const r = await store.recall({
          query: a.query ?? null, center: toArr(a.center), radius: a.radius ?? null,
          tickRange: a.tick_range ?? null, budgetTokens: a.budget_tokens ?? 2000,
        });
        const extra = { render: r.render };
        if (a.ids?.length) {
          const records = await store.read({ ids: a.ids });
          extra.records = records;
          extra.render += `\n${renderRecords(records)}`;
        }
        if (a.at || a.box) {
          // A malformed `at`/`box` must ERROR, not answer "never observed" — that reads as a fact
          // about the world ("nothing was ever seen there") when it is really a fact about the
          // argument. Exactly the succeeds-falsely class the 0.6.0 purge removed everywhere else.
          const pos = toArr(a.at), box = toBox(a.box);
          if (a.at && !isPosArr(pos)) return { ok: false, error: "at: expected {x,y,z} integers" };
          if (a.box && !(isPosArr(box?.[0]) && isPosArr(box?.[1]))) {
            return { ok: false, error: "box: expected {min:{x,y,z}, max:{x,y,z}} integers" };
          }
          const obs = await observedSection(callBridge, {
            pos, box, dim: a.dimension ?? DEFAULT_DIM, nowTick: world.tick,
          });
          extra.observed = obs.data;
          extra.render += `\n${obs.render}`;
        }
        const fresh = await placeFreshness(callBridge, r.results, world.tick);
        if (fresh) extra.render += `\n${fresh}`;
        return { ok: true, result: { ...r, ...extra, ...mech } };
      }
      default:
        return { ok: false, error: `unknown local tool ${name}` };
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
