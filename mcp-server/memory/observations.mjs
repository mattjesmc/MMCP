// Observation store — OBSERVATION_MEMORY_DESIGN.md §3, build-order step 1 (§7.1).
//
// The CAPTURED layer: what a tool returned, when, about where — never a summary, never authored.
// This module deliberately extends (not replaces) the authored store in store.mjs: interpretation
// stays in mem_note/mem_write_block; exact values live here, recorded mechanically by the capture
// hook (capture.mjs). No importance classifier — every captured read is recorded, superseded by cell.
//
// Contract (§3.1 — storage scales with CHANGE, not with looking):
//  - observations.jsonl is append-only: ONE record per captured world read. A record carries only
//    the cells that are NEW or whose value DIFFERS from the current index (palette-compressed), plus
//    the read's coverage area. Re-observing an unchanged room appends a small area-only record.
//  - The current value per cell and its change history are DERIVED state, rebuilt from the file.
//    An older observation is retained exactly where the value differed — that is the change history.
//  - Freshness ("observed N ticks ago") is derived: a cell's last-confirmed tick is the max over its
//    own record tick and every later `confirms` record whose complete area covers it. Aggregate-only
//    reads (describe_box summary, locate sweeps) never confirm cells — they cannot vouch per-cell.
//  - Implied air: a COMPLETE box scan that reports every non-air cell (describe_box detail:layers,
//    or an all-air summary) implies the unlisted in-area cells are air. At capture time, previously
//    indexed non-air cells inside such an area that the scan no longer reports get an explicit
//    change-to-air record — a disappearance is a change, not an absence of data.
//  - Decay is representation, not deletion (§3.2): queries return value + tick; staleness is the
//    caller's to weigh. Nothing here is ever deleted.
//  - tick is REQUIRED (the claim is about that tick). A read the bridge could not tick-stamp is not
//    capturable — the capture hook skips it loudly rather than storing an undated claim.
//
// MEMORY_REDESIGN.md §2.3–§2.4 + §4 (cycle 2) add the CHANNEL split and its two consequences:
//  - Every record carries `channel: deliberate|ambient` (absent = deliberate, so every pre-existing
//    line reads correctly). `deliberate` = the result was served into an agent's context; `ambient` =
//    a sensor wrote without anyone reading it (none exist yet — the field is reserved so cycle 4's
//    retina lands without a schema change).
//  - Per cell the store therefore derives TWO things: `current` (freshest, either channel) and
//    LAST-DELIBERATE (value + tick). "Changed since you last looked" compares against the second —
//    the store's own supersession tick stops being a proxy for agent knowledge the moment anything
//    writes without passing through a context window (two concurrent sessions already do it).
//  - A `disclosure` record (tool:"disclosure") persists the fact that a delta or digest line was
//    SERVED to an agent. It is coverage-only (never a cell value, never freshness) and it is what
//    makes both the on-read delta and the unseen-changes digest self-clearing across restarts
//    without a second mutable file.
//  - History is bounded (§4): HIST_CAP superseded values per cell, drop-oldest. A value asked for
//    beyond the retained window answers with the oldest retained value flagged `approx` — degraded,
//    never silently wrong.
//
// Concurrency mirrors store.mjs: every session's shim shares one world dir; an advisory lock dir
// (`obs-lock`) serializes appends and read-side refreshes; #seen counts merged lines so resync only
// indexes the tail other processes appended. The reader skips torn lines (crashed writer) and
// repairs a missing trailing newline on the next append.

import { appendFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { regionOf } from "./schema.mjs";

export const OBS_SCHEMA_VERSION = 1;
export const OBS_FILE = "observations.jsonl";
export const AIR = "minecraft:air";

const LOCK_SPIN_MS = 25;
const LOCK_WAIT_MS = 2000;
const STALE_LOCK_MS = 30_000;

/** Cap on structured cell lists a query returns; truncation is always stated, never silent. */
const CELLS_CAP = 200;
const SIGHTINGS_CAP = 20;
const SWEEPS_CAP = 3;
/** §2.4: the digest is a telescope, not a dump — the count beyond the cap is always stated. */
const UNSEEN_CAP = 50;

/** §4: superseded values retained per cell. Beyond this the oldest are dropped and answers about
 *  ticks before the retained window are flagged `approx`. The on-read delta and the digest each
 *  need exactly ONE step of history; 8 is slack, not a design requirement. */
export const HIST_CAP = 8;

export const CHANNELS = ["deliberate", "ambient"];

/** MEMORY_REDESIGN §12.2 / SURVIVAL_MODE_PLAN §6: the tools whose observations a player-legal
 *  session may know the world through — sightline reads from the body's eye (either channel; an
 *  ambient fan is still the body seeing), the body's own traversal when the mod ships it, and
 *  "act" — the body's OWN verified world changes (a mined cell is air; a placed cell is that
 *  block: knowledge the hands earned, the most player-legal provenance there is). Before "act",
 *  locate kept advertising logs the body had already chopped (w2-79881) because nothing but a
 *  re-look could update the store. An X-ray read (describe_box, get_blocks_at, …) sits in the
 *  same store, labelled by its tool, and is invisible through this filter. */
export const LEGAL_OBSERVATION_TOOLS = ["raycast", "raycast_fan", "proprioception", "act"];

/** A record's channel, defaulting to deliberate — every pre-channel line in every existing
 *  observations.jsonl was a read served into a context window, which is exactly `deliberate`. */
function channelOf(rec) {
  return rec.channel === "ambient" ? "ambient" : "deliberate";
}

/** "minecraft:chest[facing=north]{items:…}" → "minecraft:chest" — the id change detection keys on.
 * The verbatim value is still stored; a same-id different-detail supersession reads as a refinement,
 * not a change (cross-tool detail differences must not masquerade as world changes). */
export function baseId(val) {
  const s = String(val);
  const cuts = [s.indexOf("["), s.indexOf("{")].filter((i) => i >= 0);
  return cuts.length ? s.slice(0, Math.min(...cuts)) : s;
}

function isInt(x) {
  return Number.isInteger(x);
}

function isPos(p) {
  return Array.isArray(p) && p.length === 3 && p.every(isInt);
}

function inBox(pos, box) {
  return (
    pos[0] >= box[0][0] && pos[0] <= box[1][0] &&
    pos[1] >= box[0][1] && pos[1] <= box[1][1] &&
    pos[2] >= box[0][2] && pos[2] <= box[1][2]
  );
}

function cellKey(dim, pos) {
  return `${dim}|${pos[0]},${pos[1]},${pos[2]}`;
}

function colKey(dim, x, z) {
  return `${dim}|${x},${z}`;
}

/** One of exactly these area forms, each with a `complete` flag (extractors set it from coverage):
 *  {cells:[[x,y,z],…]}  explicit positions actually read (get_blocks_at, anomalies, raycast hit)
 *  {box:[[x0,y0,z0],[x1,y1,z1]]}  a scanned volume (describe_box)
 *  {surface:{origin:[x,z], grid}}  a heightmap square (get_surface)
 *  {near:{center:[x,z], radius}}  a search disc (locate) — provenance only, never confirms      */
function validateArea(area) {
  const out = [];
  if (area === null || typeof area !== "object") return ["area: required object"];
  const forms = ["cells", "box", "surface", "near"].filter((k) => area[k] !== undefined);
  if (forms.length !== 1) out.push(`area: exactly one of cells|box|surface|near, got ${forms.join(",") || "none"}`);
  if (typeof area.complete !== "boolean") out.push("area.complete: required boolean");
  if (area.cells !== undefined && !(Array.isArray(area.cells) && area.cells.every(isPos))) out.push("area.cells: expected [[x,y,z],…]");
  if (area.box !== undefined && !(Array.isArray(area.box) && area.box.length === 2 && area.box.every(isPos)
    && area.box[0].every((lo, i) => lo <= area.box[1][i]))) out.push("area.box: expected [[min],[max]] with min<=max per axis");
  if (area.surface !== undefined && !(Array.isArray(area.surface.origin) && area.surface.origin.length === 2
    && area.surface.origin.every(isInt) && isInt(area.surface.grid))) out.push("area.surface: expected {origin:[x,z], grid}");
  if (area.near !== undefined && !Array.isArray(area.near.center)) out.push("area.near: expected {center:[x,z], radius}");
  return out;
}

export function validateObservation(obs) {
  const out = [];
  if (obs === null || typeof obs !== "object") return ["observation: not an object"];
  if (typeof obs.tool !== "string" || !obs.tool) out.push("tool: required non-empty string");
  if (!(isInt(obs.tick) && obs.tick >= 0)) out.push(`tick: required non-negative integer, got ${obs.tick} — an untickable read is not capturable`);
  if (typeof obs.dim !== "string" || !obs.dim.includes(":")) out.push(`dim: required namespaced dimension, got ${obs.dim}`);
  if (typeof obs.session !== "string" || !obs.session) out.push("session: required");
  out.push(...validateArea(obs.area));
  if (obs.cellValues !== undefined && !(Array.isArray(obs.cellValues)
    && obs.cellValues.every((c) => Array.isArray(c) && c.length === 4 && isPos(c.slice(0, 3)) && typeof c[3] === "string" && c[3]))) {
    out.push("cellValues: expected [[x,y,z,\"block id\"],…]");
  }
  if (obs.confirms !== undefined && typeof obs.confirms !== "boolean") out.push("confirms: expected boolean");
  if (obs.impliedAir !== undefined && typeof obs.impliedAir !== "boolean") out.push("impliedAir: expected boolean");
  if (obs.impliedAir && !obs.area?.box) out.push("impliedAir: only meaningful with a box area");
  if (obs.value !== undefined && (obs.value === null || typeof obs.value !== "object")) out.push("value: expected object when given");
  // §2.3: absent is deliberate; anything else must be an explicit, known channel — a typo'd channel
  // would silently reclassify what the agent is treated as knowing.
  if (obs.channel !== undefined && !CHANNELS.includes(obs.channel)) {
    out.push(`channel: expected ${CHANNELS.join("|")}, got ${obs.channel}`);
  }
  if (obs.disclosure !== undefined && typeof obs.disclosure !== "boolean") out.push("disclosure: expected boolean");
  return out;
}

export class ObservationStore {
  #seenLines = 0;
  #needsNewline = false;
  #lockDepth = 0;

  constructor(rootDir, worldUuid) {
    if (!rootDir) throw new Error("rootDir required");
    if (!worldUuid) throw new Error("worldUuid required");
    this.dir = join(rootDir, worldUuid);
    this.file = join(this.dir, OBS_FILE);
  }

  /** Load the file, rebuild the derived index. Idempotent. */
  async open() {
    await mkdir(this.dir, { recursive: true });
    this.records = [];
    // cell key -> {pos, dim, val, id, tick, tool, session, hist:[{val,id,tick,tool},…] (superseded, tick-ascending)}
    this.cells = new Map();
    // dim|x,z -> y of the latest surface-read top for that column (surface-area freshness rule)
    this.colTop = new Map();
    this.#seenLines = 0;
    await this.#withLock(() => this.#resync());
    return this;
  }

  // --- write -------------------------------------------------------------------------------------

  /**
   * Record one captured read. Computes the delta against the current index (only new/changed cells
   * persist), applies the implied-air rule, appends exactly one record, and returns
   * {cells_new, cells_changed, cells_unchanged}. Rejects (throws) on a malformed observation —
   * the capture hook is the one that must never throw, and it guards this call.
   */
  async record(obs) {
    const violations = validateObservation(obs);
    if (violations.length) throw new Error(`not a valid observation: ${violations.join("; ")}`);
    return this.#withLock(async () => {
      await this.#resync(); // other sessions' captures merge first, so the delta is real

      // Last-wins within one call (a duplicated position in one read is one observation).
      const reported = new Map();
      for (const [x, y, z, val] of obs.cellValues ?? []) reported.set(cellKey(obs.dim, [x, y, z]), [x, y, z, val]);

      let cells_new = 0;
      let cells_changed = 0;
      const delta = [];
      for (const [key, [x, y, z, val]] of reported) {
        const cur = this.cells.get(key);
        if (!cur) {
          cells_new++;
          delta.push([x, y, z, val]);
        } else if (cur.val !== val) {
          cells_changed++;
          delta.push([x, y, z, val]);
        }
      }
      const cells_unchanged = reported.size - cells_new - cells_changed;

      // Implied air (complete box scans only): an indexed non-air cell inside the area that the
      // scan no longer reports has become air — record the change explicitly.
      if (obs.impliedAir && obs.area.complete && obs.area.box) {
        for (const cur of this.cells.values()) {
          if (cur.dim !== obs.dim || cur.val === AIR) continue;
          if (!inBox(cur.pos, obs.area.box)) continue;
          if (reported.has(cellKey(obs.dim, cur.pos))) continue;
          cells_changed++;
          delta.push([...cur.pos, AIR]);
        }
      }

      const rec = {
        v: OBS_SCHEMA_VERSION,
        t: new Date().toISOString(),
        tick: obs.tick,
        dim: obs.dim,
        tool: obs.tool,
        session: obs.session,
        ...(obs.query !== undefined ? { query: obs.query } : {}),
        area: obs.area,
        confirms: obs.confirms ?? false,
        // Written only when ambient: `deliberate` is the default reading, so omitting it keeps
        // today's lines byte-identical to yesterday's and the file compact.
        ...(obs.channel === "ambient" ? { channel: "ambient" } : {}),
        ...(obs.impliedAir ? { implied_air: true } : {}),
        ...(obs.value !== undefined ? { value: obs.value } : {}),
      };
      if (delta.length) {
        const palette = [];
        const index = new Map();
        rec.cells = delta.map(([x, y, z, val]) => {
          let pi = index.get(val);
          if (pi === undefined) {
            pi = palette.length;
            index.set(val, pi);
            palette.push(val);
          }
          return [x, y, z, pi];
        });
        rec.palette = palette;
      }
      await this.#append(rec);
      this.#indexRecord(rec);
      return { cells_new, cells_changed, cells_unchanged };
    });
  }

  /**
   * Persist that a change WAS TOLD to the agent (MEMORY_REDESIGN §2.4). Serving an on-read delta or
   * a digest line is a deliberate disclosure but appends no observation — nothing was looked at — so
   * without this record the same delta would be re-served forever, and would not survive a restart.
   *
   * Coverage-only by construction: no cellValues, so it can never index a value, and #lastConfirmed
   * skips it so it can never masquerade as freshness. It moves exactly one thing: last-deliberate.
   */
  async recordDisclosure({ tick, dim, session, cells }) {
    const positions = (cells ?? []).filter(isPos);
    if (!positions.length) return { disclosed: 0 };
    const rec = {
      v: OBS_SCHEMA_VERSION,
      t: new Date().toISOString(),
      tick,
      dim,
      tool: "disclosure",
      session,
      channel: "deliberate",
      disclosure: true,
      area: { cells: positions.map((p) => [...p]), complete: true },
      confirms: true,
    };
    const violations = validateObservation(rec);
    if (violations.length) throw new Error(`not a valid disclosure: ${violations.join("; ")}`);
    return this.#withLock(async () => {
      await this.#resync();
      await this.#append(rec);
      this.#indexRecord(rec);
      return { disclosed: positions.length };
    });
  }

  // --- queries (raw ticks out; age formatting is the tool layer's job) ----------------------------

  /**
   * "What did I see at X?" — pos: one cell; box: every indexed cell in the volume plus per-id
   * tallies (count + bbox — the exact-value answer prose compaction kept losing). Explicit cells
   * first; implied air answers a pos the index has no record for but a complete box scan covered;
   * overlapping aggregate sweeps come along as context. Never guesses: an unobserved cell says so.
   */
  async seenAt({ pos = null, box = null, dim }) {
    await this.#refresh();
    if ((pos === null) === (box === null)) throw new Error("seenAt: exactly one of pos|box");

    if (pos) {
      const cur = this.cells.get(cellKey(dim, pos));
      if (cur) {
        return { observed: true, cell: this.#cellOut(cur), sweeps: this.#sweepsCovering(dim, pos) };
      }
      const implied = this.#impliedAirAt(dim, pos);
      if (implied) {
        return { observed: true, cell: implied, sweeps: this.#sweepsCovering(dim, pos) };
      }
      return { observed: false, cell: null, sweeps: this.#sweepsCovering(dim, pos) };
    }

    const inScope = [...this.cells.values()]
      .filter((c) => c.dim === dim && inBox(c.pos, box))
      .sort((a, b) => b.tick - a.tick);
    const byId = new Map();
    for (const c of inScope) {
      const e = byId.get(c.id) ?? { id: c.id, count: 0, bbox: [[...c.pos], [...c.pos]], latest_tick: c.tick };
      e.count++;
      for (let i = 0; i < 3; i++) {
        e.bbox[0][i] = Math.min(e.bbox[0][i], c.pos[i]);
        e.bbox[1][i] = Math.max(e.bbox[1][i], c.pos[i]);
      }
      e.latest_tick = Math.max(e.latest_tick, c.tick);
      byId.set(c.id, e);
    }
    const impliedAirTick = this.#impliedAirBoxTick(dim, box);
    return {
      observed: inScope.length > 0 || impliedAirTick !== null,
      cells: inScope.slice(0, CELLS_CAP).map((c) => this.#cellOut(c)),
      ...(inScope.length > CELLS_CAP ? { cells_truncated: inScope.length - CELLS_CAP } : {}),
      by_id: [...byId.values()].sort((a, b) => b.count - a.count),
      // Non-null: every in-box cell NOT listed above was air as of this tick (complete scan cover).
      implied_air_tick: impliedAirTick,
      sweeps: this.#sweepsCovering(dim, boxCenter(box), box),
    };
  }

  /**
   * THE ON-READ DELTA (MEMORY_REDESIGN §2.2) — the replacement for the `mem_changes` pull tool that
   * no agent ever called. Given the cells a live read is about to report, answer: which of them
   * differ from what the agent LAST DELIBERATELY saw there?
   *
   * Call this BEFORE record(), or the read being annotated will already have superseded the prior.
   *
   * Per differing cell: {pos, live_val, was:{val,tick,implied?}|null, ambient_seen|null, approx}.
   *  - `was: null` means never deliberately observed — FIRST SIGHT, which is not a change and must
   *    not be rendered as one. It is returned rather than dropped so a caller can tell "new to you"
   *    from "unchanged" without a second query.
   *  - `was.implied` means the prior is air implied by a complete box scan that covered the cell —
   *    the agent scanned this space and saw nothing here. That IS a prior, and it is the only prior
   *    an "it appeared out of empty space" change ever has.
   *  - `ambient_seen` enriches rather than eats the delta (§2.3): when a sensor superseded the cell
   *    after the agent's last look, the annotation can date the change instead of just reporting it.
   *
   * `impliedAirBox` handles the mirror case the reported cells cannot: a COMPLETE scan of a box is
   * evidence about every cell in it, so a cell the agent remembers as non-air that this scan does
   * not report has VANISHED. A disappearance has no live evidence at all — it is precisely the
   * change that silence hides — so it is diffed here rather than left to the agent to notice.
   */
  async deltaView({ dim, cells = [], impliedAirBox = null }) {
    await this.#refresh();
    const out = [];
    const reported = new Set();

    for (const [x, y, z, val] of cells) {
      const pos = [x, y, z];
      if (!isPos(pos) || typeof val !== "string") continue;
      reported.add(cellKey(dim, pos));
      const d = this.#deltaFor(dim, pos, val);
      if (d) out.push(d);
    }

    if (impliedAirBox) {
      for (const c of this.cells.values()) {
        if (c.dim !== dim || c.val === AIR || !inBox(c.pos, impliedAirBox)) continue;
        if (reported.has(cellKey(dim, c.pos))) continue;
        const d = this.#deltaFor(dim, c.pos, AIR, { impliedByScan: true });
        if (d) out.push(d);
      }
    }

    out.sort((a, b) => (b.was?.tick ?? 0) - (a.was?.tick ?? 0));
    return out;
  }

  /** One cell's delta against last-deliberate, or null when the agent's prior agrees with the read. */
  #deltaFor(dim, pos, liveVal, { impliedByScan = false } = {}) {
    const c = this.cells.get(cellKey(dim, pos));
    let was = null;
    let ambientSeen = null;
    if (c) {
      const ld = this.#lastDeliberateTick(c);
      if (ld !== null) {
        const at = this.#valueAtTick(c, ld);
        if (at) was = { val: at.val, id: at.id, tick: ld, ...(at.approx ? { approx: true } : {}) };
        // The store's current value postdates the agent's last look: something wrote without being
        // read (an ambient sensor, or another session under annotate-off). Date the change with it.
        if (c.tick > ld) ambientSeen = { val: c.val, id: c.id, tick: c.tick, channel: c.channel };
      }
    }
    if (!was) {
      // Never a cell row — but a complete scan that implied air here IS a deliberate prior.
      const implied = this.#impliedAirAt(dim, pos, { deliberateOnly: true });
      if (implied) was = { val: AIR, id: AIR, tick: implied.tick, implied: true };
    }
    if (was && baseId(liveVal) === was.id) return null; // agreement — silence costs no bytes
    return {
      pos: [...pos],
      live_val: liveVal,
      was,
      ambient_seen: ambientSeen,
      approx: was?.approx === true,
      ...(impliedByScan ? { vanished: true } : {}),
    };
  }

  /**
   * THE UNSEEN-CHANGES LEDGER (§2.4) — cells the store knows changed but the agent was never told
   * about: last-deliberate exists and differs from current. Bounded by construction (only cells the
   * agent once deliberately saw can enter) and self-clearing (a disclosure moves last-deliberate to
   * the current value, which removes the entry). No importance classifier: entry is mechanical.
   *
   * Sources, stated precisely so the digest is not overclaimed: a session running capture with
   * annotate OFF (arms h/j, and any annotate failure), a concurrent session in that state, and —
   * when cycle 4's retina lands — ambient writes, which is the case this was built for. A read
   * whose OWN delta list was truncated at the render cap does NOT land here: that read reports the
   * live values and supersedes them deliberately, so the count-and-bbox line is the honest remedy
   * there, not the ledger.
   */
  async unseenChanges({ dim = null } = {}) {
    await this.#refresh();
    const entries = [];
    for (const c of this.cells.values()) {
      if (dim && c.dim !== dim) continue;
      const ld = this.#lastDeliberateTick(c);
      if (ld === null) continue; // never deliberately observed — nothing was ever "told" to change
      const at = this.#valueAtTick(c, ld);
      if (!at || at.id === c.id) continue;
      entries.push({
        pos: [...c.pos],
        dim: c.dim,
        was: { val: at.val, id: at.id, tick: ld, ...(at.approx ? { approx: true } : {}) },
        now: { val: c.val, id: c.id, tick: c.tick, channel: c.channel },
        changed_tick: c.tick,
      });
    }
    entries.sort((a, b) => b.changed_tick - a.changed_tick);
    return {
      total: entries.length,
      entries: entries.slice(0, UNSEEN_CAP),
      ...(entries.length > UNSEEN_CAP ? { truncated: entries.length - UNSEEN_CAP } : {}),
    };
  }

  /**
   * "Where did I last see <what>?" — the remembered counterpart of locate's `what:` vocabulary.
   * Matches cells (by base id) and sweep result sets (locate matches, describe_box materials,
   * get_surface palettes). Cell hits cluster per dimension+region, never across dimensions.
   */
  async lastSeen({ what, dim = null }) {
    await this.#refresh();
    const q = String(what ?? "").toLowerCase().replace(/^minecraft:/, "").trim();
    if (!q) throw new Error("lastSeen: what required");
    const matches = (id) => baseId(String(id)).toLowerCase().replace(/^[a-z0-9_.-]+:/, "").includes(q);

    const clusters = new Map();
    for (const c of this.cells.values()) {
      if (dim && c.dim !== dim) continue;
      if (c.val === AIR || !matches(c.id)) continue;
      const region = regionOf(c.pos);
      const key = `${c.dim} ${region}`;
      const e = clusters.get(key) ?? {
        dim: c.dim, region, count: 0, bbox: [[...c.pos], [...c.pos]], latest_tick: 0, cells: [],
      };
      e.count++;
      for (let i = 0; i < 3; i++) {
        e.bbox[0][i] = Math.min(e.bbox[0][i], c.pos[i]);
        e.bbox[1][i] = Math.max(e.bbox[1][i], c.pos[i]);
      }
      e.latest_tick = Math.max(e.latest_tick, this.#lastConfirmed(c));
      e.cells.push({ pos: [...c.pos], val: c.val, tick: c.tick, last_confirmed_tick: this.#lastConfirmed(c) });
      clusters.set(key, e);
    }
    for (const e of clusters.values()) {
      e.cells.sort((a, b) => b.tick - a.tick);
      if (e.cells.length > 10) e.cells.length = 10;
    }

    const sightings = [];
    for (let i = this.records.length - 1; i >= 0 && sightings.length < SIGHTINGS_CAP; i--) {
      const r = this.records[i];
      if (!r.value || (dim && r.dim !== dim)) continue;
      for (const f of asArray(r.value.found)) {
        if ((f.id && matches(f.id)) || String(f.kind ?? "") === q) {
          sightings.push({ source: r.tool, kind: f.kind, id: f.id, pos: f.pos ?? null, dim: r.dim, tick: r.tick });
        }
      }
      for (const m of r.value.materials ?? []) {
        if (matches(m.block)) {
          sightings.push({ source: r.tool, id: m.block, count: m.count, bbox: m.bbox ?? null, box: r.area.box ?? null, dim: r.dim, tick: r.tick });
        }
      }
      for (const p of r.value.palette ?? []) {
        if (matches(p.block)) {
          sightings.push({ source: r.tool, id: p.block, count: p.count, surface: r.area.surface ?? null, dim: r.dim, tick: r.tick });
        }
      }
    }

    return {
      found: clusters.size > 0 || sightings.length > 0,
      clusters: [...clusters.values()].sort((a, b) => b.latest_tick - a.latest_tick),
      sightings: sightings.slice(0, SIGHTINGS_CAP),
    };
  }

  /**
   * The provenance-filtered LEGAL view (MEMORY_REDESIGN §12.2): every cell with at least one
   * observation through the named tools, valued at its latest LEGAL timeline entry. An X-ray read
   * that superseded a legally-seen cell must not leak its value into this view — but the older
   * legal sighting is still legal knowledge, so the cell answers with that, dated honestly.
   */
  async legalCells({ dim = null, tools = LEGAL_OBSERVATION_TOOLS } = {}) {
    await this.#refresh();
    const legal = new Set(tools);
    const out = [];
    for (const c of this.cells.values()) {
      if (dim && c.dim !== dim) continue;
      const timeline = [...c.hist, { val: c.val, id: c.id, tick: c.tick, tool: c.tool }];
      let last = null;
      for (const e of timeline) if (legal.has(e.tool) && (!last || e.tick >= last.tick)) last = e;
      if (!last) continue;
      out.push({
        pos: [...c.pos], dim: c.dim, val: last.val, id: last.id, tick: last.tick, tool: last.tool,
        // The legal view can be BEHIND the store: a later illegal read superseded this value. Said
        // so the caller can render "as of your last look", never "current".
        superseded_illegally: last.tick < c.tick,
      });
    }
    return out;
  }

  /**
   * Legal coverage + frontier around a point (SURVIVAL_MODE_PLAN §6): which COLUMNS within `radius`
   * of `center` [x,z] carry any legal observation, bucketed into 8 compass sectors. Per sector the
   * `horizon` is the farthest seen column — beyond it is frontier. This is a navigation hint at
   * column granularity, deliberately coarse: the legal profile can never prove absence (§12.2), so
   * the useful negative is "where seen space ends", not geometry.
   */
  async legalCoverage({ center, radius, dim, tools = LEGAL_OBSERVATION_TOOLS }) {
    await this.#refresh();
    const legal = new Set(tools);
    const cols = new Map(); // "x,z" -> nearest-seen info
    const consider = (x, z) => {
      const dx = x - center[0];
      const dz = z - center[1];
      const dist = Math.hypot(dx, dz);
      if (dist > radius) return;
      const key = `${x},${z}`;
      const prev = cols.get(key);
      if (!prev || dist < prev.dist) cols.set(key, { dist, dx, dz });
    };
    for (const r of this.records) {
      if (r.disclosure || r.dim !== dim || !legal.has(r.tool)) continue;
      for (const [x, , z] of r.cells ?? []) consider(x, z);
      if (r.area?.cells) for (const [x, , z] of r.area.cells) consider(x, z);
    }
    // 8 compass sectors, N at -Z (Minecraft): bearing from atan2(dx, -dz).
    const names = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    const sectors = names.map((bearing) => ({ bearing, columns: 0, horizon: 0 }));
    for (const { dist, dx, dz } of cols.values()) {
      const deg = ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360;
      const s = sectors[Math.round(deg / 45) % 8];
      s.columns++;
      s.horizon = Math.max(s.horizon, Math.round(dist));
    }
    // The denominator: integer columns inside the disc — so every answer can QUANTIFY ignorance
    // ("seen 142 of 12,853 columns"), not just name it. The legal profile's honesty is a ratio.
    let columns_total = 0;
    const r = Math.floor(radius);
    for (let dx = -r; dx <= r; dx++) {
      const span = Math.floor(Math.sqrt(radius * radius - dx * dx));
      columns_total += 2 * span + 1;
    }
    return {
      columns_seen: cols.size,
      columns_total,
      seen_fraction: columns_total ? cols.size / columns_total : 0,
      sectors,
      least_explored: [...sectors].sort((a, b) => a.horizon - b.horizon || a.columns - b.columns)
        .slice(0, 3).map((s) => s.bearing),
    };
  }

  /** Test/diagnostic surface. */
  async stats() {
    await this.#refresh();
    return { records: this.records.length, cells: this.cells.size };
  }

  // --- derived-state internals --------------------------------------------------------------------

  #cellOut(c) {
    return {
      pos: [...c.pos],
      val: c.val,
      id: c.id,
      tick: c.tick, // when this value was first recorded
      last_confirmed_tick: this.#lastConfirmed(c),
      tool: c.tool,
      previous: c.hist.length ? c.hist.map(({ val, id, tick, tool }) => ({ val, id, tick, tool })) : [],
    };
  }

  /**
   * A cell's freshness: its own record tick, extended by every later `confirms` record whose
   * COMPLETE area covers it. Coverage semantics per area form:
   *  - cells: the position is listed (it was individually read);
   *  - box + implied_air: a complete scan reported every non-air cell, so every in-box cell —
   *    reported or implied air — was re-observed;
   *  - surface: the position is in the square AND is currently the top of its column (a surface
   *    read says nothing about cells that are no longer the heightmap top).
   * Aggregate sweeps (confirms:false) never extend freshness — they cannot vouch per-cell.
   */
  #lastConfirmed(c) {
    if (c.lcAt === this.records.length) return c.lc;
    let best = c.tick;
    for (const r of this.records) {
      // A disclosure is not an observation: being TOLD a cell's value re-confirms nothing about the
      // world. It moves last-deliberate (below) and nothing else.
      if (r.disclosure) continue;
      if (!r.confirms || !r.area?.complete || r.dim !== c.dim || r.tick <= best) continue;
      if (this.#covers(r, c)) best = r.tick;
    }
    c.lc = best;
    c.lcAt = this.records.length;
    return best;
  }

  /**
   * LAST-DELIBERATE (§2.3): the freshest tick at which this cell's value passed through an agent's
   * context — its own record if that record was deliberate, any deliberate covering read, or a
   * disclosure that told the agent about it. `null` = the agent has never deliberately seen it.
   *
   * This is the comparand for "changed since you last looked", and it deliberately is NOT the
   * store's supersession tick: the two diverge the instant anything writes without being read.
   * Disclosure is per-AGENT (per world), not per-session — all sessions share one memory and are
   * treated as one continuous agent everywhere else in this architecture (§2.3, a decision).
   */
  #lastDeliberateTick(c) {
    if (c.ldAt === this.records.length) return c.ld;
    let best = channelOf(c) === "ambient" ? null : c.tick;
    for (const h of c.hist) {
      if (h.channel !== "ambient" && (best === null || h.tick > best)) best = h.tick;
    }
    for (const r of this.records) {
      if (channelOf(r) === "ambient") continue;
      if (!r.confirms || !r.area?.complete || r.dim !== c.dim) continue;
      if (best !== null && r.tick <= best) continue;
      if (this.#covers(r, c)) best = r.tick;
    }
    c.ld = best;
    c.ldAt = this.records.length;
    return best;
  }

  /**
   * This cell's value as of `tick`: the last timeline entry at or before it. Returns null when the
   * tick predates everything retained AND nothing was dropped (i.e. genuinely before first sight).
   * When history WAS dropped (§4's bound), answer with the oldest retained value flagged `approx`
   * rather than either fabricating or going silent — a degraded prior is still a prior, and the
   * render says which it is.
   */
  #valueAtTick(c, tick) {
    const timeline = [...c.hist, { val: c.val, id: c.id, tick: c.tick, tool: c.tool, channel: c.channel }];
    let found = null;
    for (const e of timeline) if (e.tick <= tick) found = e;
    const dropped = (c.histDropped ?? 0) > 0;
    if (found) return { ...found, approx: dropped && found === timeline[0] };
    return dropped ? { ...timeline[0], approx: true } : null;
  }

  #covers(r, c) {
    if (r.area.cells) return r.area.cells.some((p) => p[0] === c.pos[0] && p[1] === c.pos[1] && p[2] === c.pos[2]);
    if (r.area.box) return r.implied_air === true && inBox(c.pos, r.area.box);
    if (r.area.surface) {
      const { origin, grid } = r.area.surface; // origin is [x,z]
      return Math.abs(c.pos[0] - origin[0]) <= grid && Math.abs(c.pos[2] - origin[1]) <= grid
        && this.colTop.get(colKey(c.dim, c.pos[0], c.pos[2])) === c.pos[1];
    }
    return false;
  }

  /** Latest implied-air answer for an unindexed position: a complete implied-air scan covered it.
   *  `deliberateOnly` restricts to scans whose result reached an agent — the delta path asks what
   *  the AGENT knew, not what the store knows. */
  #impliedAirAt(dim, pos, { deliberateOnly = false } = {}) {
    let tick = null;
    let tool = null;
    for (const r of this.records) {
      if (!r.implied_air || !r.area?.complete || r.dim !== dim || !r.area.box) continue;
      if (deliberateOnly && channelOf(r) === "ambient") continue;
      if (!inBox(pos, r.area.box) || (tick !== null && r.tick <= tick)) continue;
      tick = r.tick;
      tool = r.tool;
    }
    return tick === null ? null : {
      pos: [...pos], val: AIR, id: AIR, tick, last_confirmed_tick: tick, tool,
      implied: true, previous: [],
    };
  }

  /** Latest tick at which a complete implied-air scan covered the WHOLE box, else null. */
  #impliedAirBoxTick(dim, box) {
    let tick = null;
    for (const r of this.records) {
      if (!r.implied_air || !r.area?.complete || r.dim !== dim || !r.area.box) continue;
      if (!inBox(box[0], r.area.box) || !inBox(box[1], r.area.box)) continue;
      if (tick === null || r.tick > tick) tick = r.tick;
    }
    return tick;
  }

  /** Aggregate sweeps whose area touches the position/box — returned as context, newest first. */
  #sweepsCovering(dim, pos, box = null) {
    const out = [];
    for (let i = this.records.length - 1; i >= 0 && out.length < SWEEPS_CAP; i--) {
      const r = this.records[i];
      if (!r.value || r.dim !== dim) continue;
      if (!this.#areaTouches(r.area, pos, box)) continue;
      out.push({ tool: r.tool, tick: r.tick, area: r.area, ...(r.query !== undefined ? { query: r.query } : {}), value: r.value });
    }
    return out;
  }

  #areaTouches(area, pos, box) {
    const boxes = box ? [box] : [[pos, pos]];
    if (area.box) {
      return boxes.some((b) => !(b[1][0] < area.box[0][0] || b[0][0] > area.box[1][0]
        || b[1][1] < area.box[0][1] || b[0][1] > area.box[1][1]
        || b[1][2] < area.box[0][2] || b[0][2] > area.box[1][2]));
    }
    if (area.surface) {
      const { origin, grid } = area.surface;
      return boxes.some((b) => b[0][0] <= origin[0] + grid && b[1][0] >= origin[0] - grid
        && b[0][2] <= origin[1] + grid && b[1][2] >= origin[1] - grid);
    }
    if (area.near && area.near.radius != null) {
      const [cx, cz] = area.near.center;
      const r = area.near.radius;
      return boxes.some((b) => b[0][0] <= cx + r && b[1][0] >= cx - r && b[0][2] <= cz + r && b[1][2] >= cz - r);
    }
    if (area.cells) {
      return area.cells.some((p) => boxes.some((b) => inBox(p, b)));
    }
    return false;
  }

  #indexRecord(rec) {
    const pal = rec.palette ?? [];
    for (const [x, y, z, pi] of rec.cells ?? []) {
      const val = pal[pi];
      if (typeof val !== "string") continue; // defensive: a foreign writer's malformed row
      this.#applyCell(rec, [x, y, z], val);
    }
    if (rec.tool === "get_surface" && rec.confirms) {
      // Surface reads define the current top-of-column; unchanged tops append no cell, so the
      // recorded y stays the current top until a later surface record moves it.
      for (const [x, y, z] of rec.cells ?? []) this.colTop.set(colKey(rec.dim, x, z), y);
    }
    this.records.push(rec);
  }

  #applyCell(rec, pos, val) {
    const key = cellKey(rec.dim, pos);
    const chan = channelOf(rec);
    const cur = this.cells.get(key);
    if (!cur) {
      this.cells.set(key, {
        pos, dim: rec.dim, val, id: baseId(val), tick: rec.tick,
        tool: rec.tool, session: rec.session, channel: chan, hist: [], histDropped: 0,
      });
      return;
    }
    if (cur.val === val) return; // duplicate first-observation from a racing session — keep the earlier tick
    if (rec.tick >= cur.tick) {
      cur.hist.push({ val: cur.val, id: cur.id, tick: cur.tick, tool: cur.tool, channel: cur.channel });
      cur.val = val;
      cur.id = baseId(val);
      cur.tick = rec.tick;
      cur.tool = rec.tool;
      cur.session = rec.session;
      cur.channel = chan;
    } else {
      // Out-of-order older observation (cross-process race): history, not current.
      cur.hist.push({ val, id: baseId(val), tick: rec.tick, tool: rec.tool, channel: chan });
      cur.hist.sort((a, b) => a.tick - b.tick);
    }
    // §4: bounded history, drop-oldest. What is dropped is counted, not forgotten — #valueAtTick
    // flags answers that fall off the retained window as approximate rather than asserting them.
    if (cur.hist.length > HIST_CAP) {
      cur.histDropped = (cur.histDropped ?? 0) + (cur.hist.length - HIST_CAP);
      cur.hist.splice(0, cur.hist.length - HIST_CAP);
    }
    cur.lcAt = -1; // derived-freshness memos are keyed on records.length; the value moved under them
    cur.ldAt = -1;
  }

  // --- file + lock internals (the store.mjs patterns, self-contained) ------------------------------

  async #refresh() {
    await this.#withLock(() => this.#resync());
  }

  /** Index the lines this instance has not seen. Torn/foreign lines are skipped, never fatal. */
  async #resync() {
    let text;
    try {
      text = await readFile(this.file, "utf8");
    } catch (e) {
      if (e.code === "ENOENT") return;
      throw e;
    }
    const lines = text.split("\n").filter(Boolean);
    for (const line of lines.slice(this.#seenLines)) {
      try {
        this.#indexRecord(JSON.parse(line));
      } catch {
        // torn tail from a crashed writer — skipped; the next append starts a fresh line
      }
    }
    this.#seenLines = lines.length;
    this.#needsNewline = text.length > 0 && !text.endsWith("\n");
  }

  async #append(rec) {
    const prefix = this.#needsNewline ? "\n" : "";
    this.#needsNewline = false;
    await appendFile(this.file, prefix + JSON.stringify(rec) + "\n", "utf8");
    this.#seenLines++; // our own line — resync must not re-index it
  }

  async #withLock(fn) {
    if (this.#lockDepth > 0) {
      this.#lockDepth++;
      try {
        return await fn();
      } finally {
        this.#lockDepth--;
      }
    }
    const lockDir = join(this.dir, "obs-lock");
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
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error(`observation lock busy: ${lockDir} held for over ${LOCK_WAIT_MS}ms`);
        }
        await new Promise((r) => setTimeout(r, LOCK_SPIN_MS));
      }
    }
    this.#lockDepth = 1;
    try {
      return await fn();
    } finally {
      this.#lockDepth = 0;
      await rm(lockDir, { recursive: true, force: true }).catch(async () => {
        await new Promise((r) => setTimeout(r, 50));
        await rm(lockDir, { recursive: true, force: true }).catch((e) => {
          process.stderr.write(`[observations] could not release lock ${lockDir} (${e.message})\n`);
        });
      });
    }
  }
}

function asArray(x) {
  return x === undefined || x === null ? [] : Array.isArray(x) ? x : [x];
}

function boxCenter(box) {
  return [0, 1, 2].map((i) => Math.round((box[0][i] + box[1][i]) / 2));
}
