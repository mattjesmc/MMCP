// Frozen record schemas for agent memory. MEMORY_DESIGN.md (rev 2) is the authority; this module is
// its executable form. Records are immutable and append-only; anything that "changes" is a relation
// record; current state is derived by readers. Bump SCHEMA_VERSION only with a migration story.

export const SCHEMA_VERSION = 1;

export const ENTRY_KINDS = ["obs", "act", "outcome", "note"];

/**
 * How the writer knows what it wrote. `observed` = I saw this happen; `inferred` = I reasoned it
 * from what I saw; `guessed` = it fit and I could not test it. Only meaningful for claims about
 * MECHANISM, which is exactly the class of note that has already poisoned this store once
 * (W2_56123_POSTMORTEM §5b). Absent means `observed` — the honest default for a log whose other
 * kinds are all first-hand.
 */
export const CONFIDENCE_LEVELS = ["observed", "inferred", "guessed"];
export const RELATION_KINDS = ["compaction", "verification", "ack"];
export const VERIFY_TARGET_TYPES = ["place", "entry"];
export const VERIFY_RESULTS = ["confirmed", "contradicted"];

// --- spatial derivation (region = 32×32 chunks, mirroring Minecraft's region files) ---------------

export function chunkOf(pos) {
  return [Math.floor(pos[0] / 16), Math.floor(pos[2] / 16)];
}

export function regionOf(pos) {
  const [cx, cz] = chunkOf(pos);
  return `r.${Math.floor(cx / 32)}.${Math.floor(cz / 32)}`;
}

// --- id formats -----------------------------------------------------------------------------------

export const ID_PATTERNS = {
  entry: /^e-\d{6}$/,
  block: /^b-\d{6}$/,
  place: /^p-[a-z0-9][a-z0-9-]*$/,
  session: /^s-[a-z0-9][a-z0-9-]*$/,
};

export function entryId(n) {
  return `e-${String(n).padStart(6, "0")}`;
}

export function blockId(n) {
  return `b-${String(n).padStart(6, "0")}`;
}

// --- validators -----------------------------------------------------------------------------------
// Each returns an array of violation strings; empty array = valid. Violations name the field and the
// rule so a rejected write comes back actionable ("bounds[0][1] > bounds[1][1]"), not just "invalid".

function isInt(x) {
  return Number.isInteger(x);
}

function isIsoDate(s) {
  return typeof s === "string" && !Number.isNaN(Date.parse(s));
}

function isPos(p) {
  return Array.isArray(p) && p.length === 3 && p.every(isInt);
}

function base(rec, idKind, out) {
  if (rec === null || typeof rec !== "object") {
    out.push("record: not an object");
    return false;
  }
  if (rec.v !== SCHEMA_VERSION) out.push(`v: expected ${SCHEMA_VERSION}, got ${rec.v}`);
  if (idKind && !ID_PATTERNS[idKind].test(rec.id ?? "")) out.push(`id: expected ${idKind} id, got ${rec.id}`);
  return true;
}

/** L0 traversal-log entry. `tick` may be null (offline degradation); `pos` may be null (placeless note). */
export function validateEntry(rec) {
  const out = [];
  if (!base(rec, "entry", out)) return out;
  if (!ID_PATTERNS.session.test(rec.session ?? "")) out.push(`session: expected s- id, got ${rec.session}`);
  if (!isIsoDate(rec.t)) out.push(`t: expected ISO date, got ${rec.t}`);
  if (rec.tick !== null && !(isInt(rec.tick) && rec.tick >= 0)) out.push(`tick: expected non-negative integer or null, got ${rec.tick}`);
  if (!ENTRY_KINDS.includes(rec.kind)) out.push(`kind: expected one of ${ENTRY_KINDS.join("|")}, got ${rec.kind}`);
  if (typeof rec.dim !== "string" || !rec.dim) out.push("dim: required non-empty string");
  if (rec.pos !== null) {
    if (!isPos(rec.pos)) {
      out.push(`pos: expected [x,y,z] ints or null, got ${JSON.stringify(rec.pos)}`);
    } else {
      const [cx, cz] = chunkOf(rec.pos);
      if (!Array.isArray(rec.chunk) || rec.chunk[0] !== cx || rec.chunk[1] !== cz) {
        out.push(`chunk: expected [${cx},${cz}] derived from pos, got ${JSON.stringify(rec.chunk)}`);
      }
      if (rec.region !== regionOf(rec.pos)) {
        out.push(`region: expected ${regionOf(rec.pos)} derived from pos, got ${rec.region}`);
      }
    }
  }
  if (typeof rec.text !== "string" || !rec.text.trim()) out.push("text: required non-empty string");
  // CONFIDENCE IS PART OF THE RECORD, not part of the prose. Session w2-56123 hit a five-minute dig
  // stall, guessed a cause, and wrote the guess into memory as fact: "re-selecting the held item via
  // bot_select cleared the stuck state". The symptom was real; the mechanism is false on every code
  // path (bot_select never touches the dig slot), and the store had no way to say so — so every
  // future session reads a fabricated repair recipe in the same voice as an observed one. Absent
  // stays valid and means `observed`, so nothing already written changes meaning.
  if (rec.confidence !== undefined && rec.confidence !== null
      && !CONFIDENCE_LEVELS.includes(rec.confidence)) {
    out.push(`confidence: expected one of ${CONFIDENCE_LEVELS.join("|")}, got ${rec.confidence}`);
  }
  if (rec.refs !== undefined && rec.refs !== null) {
    if (typeof rec.refs !== "object") out.push("refs: expected object");
    else {
      if (rec.refs.events !== undefined && !(Array.isArray(rec.refs.events) && rec.refs.events.every(isInt))) out.push("refs.events: expected int array");
      if (rec.refs.places !== undefined && !(Array.isArray(rec.refs.places) && rec.refs.places.every((p) => ID_PATTERNS.place.test(p)))) out.push("refs.places: expected p- id array");
    }
  }
  return out;
}

/**
 * L1+ compacted block. Header fields are DERIVED BY THE TOOL from linked records (never authored by the
 * model); this validates the persisted shape. Blocks never mutate — no last_verified here; freshness is
 * per-subject via verification relations.
 */
export function validateBlock(rec) {
  const out = [];
  if (!base(rec, "block", out)) return out;
  if (!(isInt(rec.level) && rec.level >= 1)) out.push(`level: expected integer >= 1, got ${rec.level}`);
  if (!(Array.isArray(rec.tick_range) && rec.tick_range.length === 2 && rec.tick_range.every(isInt) && rec.tick_range[0] <= rec.tick_range[1])) {
    out.push(`tick_range: expected [lo,hi] ints with lo<=hi, got ${JSON.stringify(rec.tick_range)}`);
  }
  if (!(Array.isArray(rec.time_range) && rec.time_range.length === 2 && rec.time_range.every(isIsoDate))) {
    out.push(`time_range: expected [ISO,ISO], got ${JSON.stringify(rec.time_range)}`);
  }
  if (typeof rec.dim !== "string" || !rec.dim) out.push("dim: required non-empty string");
  if (!(Array.isArray(rec.regions) && rec.regions.length > 0 && rec.regions.every((r) => /^r\.-?\d+\.-?\d+$/.test(r)))) {
    out.push(`regions: expected non-empty r.x.z array, got ${JSON.stringify(rec.regions)}`);
  }
  if (!(Array.isArray(rec.bounds) && rec.bounds.length === 2 && rec.bounds.every(isPos) && rec.bounds[0].every((lo, i) => lo <= rec.bounds[1][i]))) {
    out.push(`bounds: expected [[min],[max]] with min<=max per axis, got ${JSON.stringify(rec.bounds)}`);
  }
  if (typeof rec.activity !== "string" || !rec.activity.trim()) out.push("activity: required non-empty string");
  if (!(Array.isArray(rec.pois) && rec.pois.every((p) => ID_PATTERNS.place.test(p)))) out.push("pois: expected p- id array (may be empty)");
  if (rec.tallies === null || typeof rec.tallies !== "object" || typeof rec.tallies.derived_from !== "string") {
    out.push("tallies: expected object with derived_from provenance label");
  }
  if (typeof rec.outcome !== "string" || !rec.outcome.trim()) out.push("outcome: required non-empty string");
  if (typeof rec.prose !== "string" || !rec.prose.trim()) out.push("prose: required non-empty string");
  const entries = rec.links?.entries ?? [];
  const blocks = rec.links?.blocks ?? [];
  if (!Array.isArray(entries) || !Array.isArray(blocks)) {
    out.push("links: expected {entries:[], blocks:[]}");
  } else {
    if (rec.level === 1 && (entries.length === 0 || blocks.length !== 0)) out.push("links: level-1 block must link entries and no blocks");
    if (rec.level >= 2 && (blocks.length === 0 || entries.length !== 0)) out.push("links: level-2+ block must link child blocks and no entries");
    if (!entries.every((e) => ID_PATTERNS.entry.test(e))) out.push("links.entries: expected e- ids");
    if (!blocks.every((b) => ID_PATTERNS.block.test(b))) out.push("links.blocks: expected b- ids");
  }
  if (!isInt(rec.created_tick)) out.push(`created_tick: expected integer, got ${rec.created_tick}`);
  if (!isInt(rec.last_activity_tick)) out.push(`last_activity_tick: expected integer, got ${rec.last_activity_tick}`);
  return out;
}

/** Relation record: compaction membership, per-subject verification, or pending-candidate ack. */
export function validateRelation(rec) {
  const out = [];
  if (!base(rec, null, out)) return out;
  if (!RELATION_KINDS.includes(rec.kind)) {
    out.push(`kind: expected one of ${RELATION_KINDS.join("|")}, got ${rec.kind}`);
    return out;
  }
  if (!isIsoDate(rec.t)) out.push(`t: expected ISO date, got ${rec.t}`);
  if (rec.kind === "compaction") {
    if (!ID_PATTERNS.block.test(rec.block ?? "")) out.push(`block: expected b- id, got ${rec.block}`);
    const children = rec.entries ?? rec.blocks ?? null;
    if (!(Array.isArray(children) && children.length > 0)) out.push("compaction: expected non-empty entries[] or blocks[]");
  }
  if (rec.kind === "verification") {
    if (!VERIFY_TARGET_TYPES.includes(rec.target_type)) out.push(`target_type: expected ${VERIFY_TARGET_TYPES.join("|")}, got ${rec.target_type}`);
    if (typeof rec.target_id !== "string" || !rec.target_id) out.push("target_id: required");
    if (!VERIFY_RESULTS.includes(rec.result)) out.push(`result: expected ${VERIFY_RESULTS.join("|")}, got ${rec.result}`);
    if (rec.tick !== null && !isInt(rec.tick)) out.push(`tick: expected integer or null, got ${rec.tick}`);
  }
  if (rec.kind === "ack") {
    if (!isInt(rec.event_id)) out.push(`event_id: expected integer, got ${rec.event_id}`);
    if (!ID_PATTERNS.entry.test(rec.entry ?? "")) out.push(`entry: expected e- id, got ${rec.entry}`);
  }
  return out;
}

/** POI record (places.jsonl). Freshness lives in verification relations, not here. */
export function validatePlace(rec) {
  const out = [];
  if (!base(rec, "place", out)) return out;
  if (typeof rec.category !== "string" || !rec.category.trim()) out.push("category: required non-empty string");
  if (typeof rec.dim !== "string" || !rec.dim) out.push("dim: required non-empty string");
  if (!isPos(rec.pos)) out.push(`pos: expected [x,y,z] ints, got ${JSON.stringify(rec.pos)}`);
  if (rec.discovered_tick !== null && !isInt(rec.discovered_tick)) out.push(`discovered_tick: expected integer or null, got ${rec.discovered_tick}`);
  return out;
}
