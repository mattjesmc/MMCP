// Capture hook — OBSERVATION_MEMORY_DESIGN.md §7 step 2: the bridge proxy records every world READ
// into the observation store. Mechanical, reads only — never writes/actions (those are the event
// log's job), never a summary, no importance classifier. The agent's context is untouched: capture
// happens at write time in the harness (that is §6 prediction 5's cost bound).
//
// Contract:
//  - captureWorldRead NEVER throws and never blocks a tool result on failure — worst case the model
//    gets its result and stderr gets a line. But failures are LOUD, not silent: a captured tool
//    whose result is missing the fields its extractor names is the "silent narrowing that still
//    produces a number" class (HANDOFF 2026-07-27), and every occurrence is logged.
//  - Only tools in EXTRACTORS are captured; UNCAPTURED_WORLD_READS names every world read that is
//    deliberately not, with the reason. A world read in neither table is a declaration gap — tests
//    assert the union covers the manifest's spatial reads, so new tools must declare their side.
//  - MCPTK_OBS_CAPTURE=off disables capture entirely — the ablation arm for the §6 bench cycle.
//  - Extractors record the tool's OWN values verbatim (block ids as returned), and only what was
//    actually read: unread positions (palette index -1), unloaded columns and partial scans are
//    skipped or downgraded — unknown must never index as a fact.

import { ObservationStore } from "./observations.mjs";
import { MEMORY_ROOT, SESSION, resolveWorld } from "./tools.mjs";

/** World identity changes only on relaunch; re-asking the bridge per captured read would double
 * bridge traffic. Tick/dim come from each result's own envelope, so only the uuid is cached. */
const WORLD_TTL_MS = 60_000;

// --- extractors: raw bridge result → normalized observation --------------------------------------
// Each returns null (nothing capturable in this result), {skip: "reason"} (shape missing — logged
// loudly), or {confirms, impliedAir?, area, cellValues?, value?, query}.

function posArr(p) {
  return p && Number.isInteger(p.x) && Number.isInteger(p.y) && Number.isInteger(p.z) ? [p.x, p.y, p.z] : null;
}

/** "x,y,z" (describe_box's box/bbox strings) → [x,y,z]. */
function parsePosStr(s) {
  const parts = String(s ?? "").split(",").map((n) => parseInt(n, 10));
  return parts.length === 3 && parts.every(Number.isInteger) ? parts : null;
}

/** Shared by get_blocks_at and locate's identify mode (which IS the same read, per the mod). */
function cellsFromPaletteRows(r) {
  if (!Array.isArray(r.palette) || !Array.isArray(r.blocks)) return null;
  const cellValues = [];
  for (const row of r.blocks) {
    if (!Array.isArray(row) || row.length < 4) continue;
    const [x, y, z, pi] = row;
    if (pi === -1) continue; // the -1 not-read convention: unknown never indexes as a fact
    const val = r.palette[pi];
    if (typeof val !== "string") continue;
    cellValues.push([x, y, z, val]);
  }
  return cellValues;
}

export const EXTRACTORS = {
  get_blocks_at(args, r) {
    const cellValues = cellsFromPaletteRows(r);
    if (cellValues === null) return { skip: "expected palette + blocks rows" };
    return {
      confirms: true,
      area: { cells: cellValues.map(([x, y, z]) => [x, y, z]), complete: true },
      cellValues,
      query: { n: (r.blocks ?? []).length, detail: r.detail },
    };
  },

  get_surface(args, r) {
    const origin = r.origin && Number.isFinite(r.origin.x) && Number.isFinite(r.origin.z)
      ? [Math.floor(r.origin.x), Math.floor(r.origin.z)] : null;
    if (!origin || !Number.isInteger(r.grid)) return { skip: "expected origin + grid" };
    const query = { grid: r.grid, heightmap: r.heightmap, detail: r.detail };
    if (r.detail === "full") {
      const cellValues = cellsFromPaletteRows(r);
      if (cellValues === null) return { skip: "detail:full without palette + blocks rows" };
      return {
        confirms: true,
        area: { surface: { origin, grid: r.grid }, complete: r.unloaded === 0 && r.truncated !== true },
        cellValues,
        query,
      };
    }
    // Summary: the palette histogram + heights are a sweep value; only the anomaly columns carry
    // exact cells (they are re-reported each call, so they double as the confirmable area).
    const anomalies = (r.anomalies ?? [])
      .map((a) => (posArr(a) && typeof a.block === "string" ? [a.x, a.y, a.z, a.block] : null))
      .filter(Boolean);
    return {
      confirms: true,
      area: { cells: anomalies.map(([x, y, z]) => [x, y, z]), complete: true },
      cellValues: anomalies,
      value: {
        palette: (r.palette ?? []).map((p) => ({ block: p.block, count: p.count })),
        ...(r.heights ? { heights: r.heights } : {}),
        covered_radius: r.covered_radius,
        columns: r.columns,
        unloaded: r.unloaded,
      },
      query,
    };
  },

  describe_box(args, r) {
    const box = r.box ? [parsePosStr(r.box.min), parsePosStr(r.box.max)] : null;
    if (!box || !box[0] || !box[1]) return { skip: "expected box.min/max" };
    const complete = r.unloaded_columns === 0;
    const value = {
      volume: r.volume,
      air: r.air,
      materials: (r.materials ?? []).map((m) => ({ block: m.block, count: m.count, ...(m.bbox ? { bbox: m.bbox } : {}) })),
      ...(r.nonair_bbox ? { nonair_bbox: r.nonair_bbox } : {}),
      unloaded_columns: r.unloaded_columns,
    };
    const query = { detail: r.layers ? "layers" : "summary" };

    if (r.layers && r.legend) {
      // A partial layers read renders unloaded columns exactly like air — per-cell trust requires a
      // complete scan. '?' glyphs (palette overflow) break the "unlisted = air" implication too.
      if (!complete) {
        return { confirms: false, area: { box, complete: false }, value, query };
      }
      const cellValues = [];
      let unknownGlyph = false;
      for (const [yKey, rows] of Object.entries(r.layers)) {
        const y = parseInt(yKey, 10);
        if (!Number.isInteger(y) || !Array.isArray(rows)) continue;
        // rows[0] is the x-ruler: "x: nx0..nx1 (left..right)"
        const xm = /x:\s*(-?\d+)\.\./.exec(String(rows[0] ?? ""));
        if (!xm) return { skip: "layers slice without its x ruler" };
        const x0 = parseInt(xm[1], 10);
        for (const row of rows.slice(1)) {
          const zm = /^z=(-?\d+)\|(.*)$/.exec(String(row));
          if (!zm) return { skip: "layers row without its z label" };
          const z = parseInt(zm[1], 10);
          const glyphs = zm[2];
          for (let i = 0; i < glyphs.length; i++) {
            const g = glyphs[i];
            if (g === ".") continue; // air — implied by the complete-box rule, never stored per cell
            const id = r.legend[g];
            if (typeof id !== "string") {
              unknownGlyph = true; // >62 materials: this cell's value is not in the legend
              continue;
            }
            cellValues.push([x0 + i, y, z, id]);
          }
        }
      }
      if (unknownGlyph) {
        // Some cells are unresolvable, so "unlisted = air" no longer holds; confirm only the
        // resolved cells and keep the aggregate value.
        return {
          confirms: true,
          area: { cells: cellValues.map(([x, y, z]) => [x, y, z]), complete: true },
          cellValues,
          value,
          query,
        };
      }
      return { confirms: true, impliedAir: true, area: { box, complete: true }, cellValues, value, query };
    }

    // Summary detail. One exact special case: a complete all-air box is cell-exact knowledge.
    const allAir = complete && Number.isInteger(r.air) && r.air === r.volume;
    return {
      confirms: allAir,
      ...(allAir ? { impliedAir: true } : {}),
      area: { box, complete },
      value,
      query,
    };
  },

  locate(args, r) {
    // Identify mode ("what is at X?") delegates to the get_blocks_at read — same extraction.
    if (r.direction === "identify" && Array.isArray(r.palette) && Array.isArray(r.blocks)) {
      const cellValues = cellsFromPaletteRows(r);
      return {
        confirms: true,
        area: { cells: cellValues.map(([x, y, z]) => [x, y, z]), complete: true },
        cellValues,
        query: { direction: "identify" },
      };
    }
    // Search mode: store the result SET (§3 — "where did I last see chests" is the same query
    // shape as the live search). Matches keep kind/id/pos verbatim; pos may lack y.
    const found = [];
    const rawFound = r.found === undefined || r.found === null ? [] : Array.isArray(r.found) ? r.found : [r.found];
    for (const f of rawFound.slice(0, 50)) {
      if (!f || typeof f !== "object") continue;
      const pos = f.pos && Number.isFinite(f.pos.x) && Number.isFinite(f.pos.z)
        ? [f.pos.x, Number.isFinite(f.pos.y) ? f.pos.y : null, f.pos.z] : null;
      found.push({ kind: f.kind, id: f.id, pos, ...(f.detail !== undefined ? { detail: f.detail } : {}) });
    }
    if (typeof r.what !== "string") return { skip: "expected what" };
    const center = r.center && Number.isFinite(r.center.x) && Number.isFinite(r.center.z)
      ? [Math.floor(r.center.x), Math.floor(r.center.z)] : null;
    const radius = r.search?.radius ?? args?.radius ?? null;
    return {
      confirms: false,
      area: { near: { center: center ?? [0, 0], radius }, complete: false },
      value: {
        what: r.what,
        found,
        search: r.search
          ? {
            mechanism: r.search.mechanism,
            found: r.search.found,
            negative_is_proof: r.search.negative_is_proof,
            ...(r.search.extent !== undefined ? { extent: r.search.extent } : {}),
          }
          : null,
      },
      query: { what: r.what, radius },
    };
  },

  raycast(args, r) {
    if (r.hit !== "block") return null; // miss/unread/entity: no cell value to record
    const pos = posArr(r.block?.pos);
    if (!pos || typeof r.block?.block !== "string") return { skip: "hit:block without block.pos/id" };
    return {
      confirms: true,
      area: { cells: [pos], complete: true },
      cellValues: [[...pos, r.block.block]],
      query: { hit: "block", distance: r.distance },
    };
  },

  raycast_fan(args, r) {
    // Compact rows: [dyaw, dpitch, kind, …]. kind b=block ([…,"b",id,dist,x,y,z]) is the only one
    // carrying a cell value — e (entity) belongs to the belief layer, m (miss) says nothing about a
    // specific cell, and u (unread) is the whole point of the -1 convention: unknown never indexes
    // as a fact. Each block hit IS a read cell (sightline), so it confirms exactly like `raycast`.
    if (!Array.isArray(r.rays)) return { skip: "expected rays rows" };
    const cellValues = [];
    for (const row of r.rays) {
      if (!Array.isArray(row) || row[2] !== "b") continue;
      const [, , , id, , x, y, z] = row;
      if (typeof id !== "string" || !isPos([x, y, z])) continue;
      cellValues.push([x, y, z, id]);
    }
    if (!cellValues.length) return null; // an all-miss/unread fan observes no cell
    // A tight fan lands many rays on ONE block, so the raw hit list repeats positions. The area is
    // persisted on every record, so dedupe it rather than storing the same cell N times per call.
    const area = [...new Map(cellValues.map(([x, y, z]) => [`${x},${y},${z}`, [x, y, z]])).values()];
    return {
      confirms: true,
      area: { cells: area, complete: true },
      cellValues,
      query: { rays: r.rays.length, hits: cellValues.length, cells: area.length, range: r.range },
    };
  },
};

function isPos(p) {
  return Array.isArray(p) && p.length === 3 && p.every(Number.isInteger);
}

/** World reads deliberately NOT captured, with the reason — the anti-silent-narrowing ledger.
 * A spatial read absent from both this list and EXTRACTORS is an undeclared gap (tested). */
export const UNCAPTURED_WORLD_READS = {
  get_entities: "entities move — transient positions belong to the event/belief layer, not a cell store",
  sense_entities: "embodied belief store, same reason as get_entities",
  scene_summary: "narrative aggregate over a vantage point; no per-cell values",
  get_region_summary: "per-tile aggregates; no per-cell values",
  check_path: "verdict (reachable), not an observation of cells",
  check_site: "verdict (site fitness), not an observation of cells",
  resolve_anchor: "verdict (fits), not an observation of cells",
  get_region: "editing-session stream, not a world read in the perception sense",
};

// --- store resolution -----------------------------------------------------------------------------

const stores = new Map(); // world_uuid -> ObservationStore
let worldCache = null; // {uuid, at}

/** Per-uuid store, shared by capture and the query tools. */
export async function storeFor(worldUuid) {
  let store = stores.get(worldUuid);
  if (!store) {
    store = new ObservationStore(MEMORY_ROOT, worldUuid);
    await store.open();
    stores.set(worldUuid, store);
  }
  return store;
}

/** The store for the active world, behind the uuid TTL cache. Exported so annotate.mjs resolves the
 *  SAME store instance capture writes to — two instances over one dir would work (the file is the
 *  source of truth) but would double every resync on the read path. */
export async function cachedStore(callBridge) {
  const now = Date.now();
  if (!worldCache || now - worldCache.at > WORLD_TTL_MS) {
    const world = await resolveWorld(callBridge);
    worldCache = { uuid: world.world_uuid, at: now };
  }
  return storeFor(worldCache.uuid);
}

/** Test seam: drop cached world identity + stores (a fresh test dir must not reuse an old store). */
export function resetCaptureCache() {
  stores.clear();
  worldCache = null;
}

// --- the hook -------------------------------------------------------------------------------------

function captureEnabled() {
  return (process.env.MCPTK_OBS_CAPTURE ?? "on").trim() !== "off";
}

/**
 * Record a successful world read into the observation store. Called by the MCP shim after every
 * non-local tool call that returned ok. Never throws; returns what happened for tests/diagnostics.
 * `channel` (§2.3): "deliberate" (default — the result was served into the agent's context) or
 * "ambient" (a sensor wrote without anyone reading it — the autofan path, SURVIVAL_MODE_PLAN §5).
 */
export async function captureWorldRead(tool, args, result, callBridge, { channel } = {}) {
  try {
    if (!captureEnabled()) return { captured: false, reason: "disabled" };
    const extract = EXTRACTORS[tool];
    if (!extract) return { captured: false, reason: "not a captured read" };
    if (!result || typeof result !== "object") return { captured: false, reason: "no result object" };
    if (!Number.isInteger(result.game_tick) || typeof result.dimension !== "string") {
      // A world read without its envelope cannot be honestly dated/placed — skip, loudly.
      process.stderr.write(`[observations] ${tool}: result lacks game_tick/dimension — not captured\n`);
      return { captured: false, reason: "no envelope" };
    }
    const norm = extract(args ?? {}, result);
    if (norm === null) return { captured: false, reason: "nothing capturable" };
    if (norm.skip) {
      process.stderr.write(`[observations] ${tool}: ${norm.skip} — not captured (result shape drifted?)\n`);
      return { captured: false, reason: norm.skip };
    }
    const store = await cachedStore(callBridge);
    const counts = await store.record({
      tool,
      tick: result.game_tick,
      dim: result.dimension,
      session: SESSION,
      ...(channel === "ambient" ? { channel } : {}),
      ...norm,
    });
    return { captured: true, ...counts };
  } catch (e) {
    process.stderr.write(`[observations] capture failed for ${tool}: ${e.message}\n`);
    return { captured: false, reason: e.message };
  }
}

/**
 * Proprioception capture (SURVIVAL_MODE_PLAN.md §4): a nav verdict carrying `traversed` rows
 * [x, y, z, feet_id, head_id, ground_id] becomes a legal observation under the reserved provenance
 * name "proprioception" (LEGAL_OBSERVATION_TOOLS) — the body KNOWS the corridor it walked through,
 * with what the cells really contained (a swimming body's feet record water, never assumed air).
 *
 * Called wherever such a payload can surface: an embodied tool result (wait:true verdicts) or an
 * event row from get_events (polled completions). Envelope-gated exactly like every capture. One
 * honest limit, documented in §4: the record is stamped at the verdict's tick, so cell freshness is
 * overstated by at most the nav's own duration. Never throws.
 */
/** The value a freshly-mined cell holds. Exported for the act-capture tests. */
const MINED_VALUE = "minecraft:air";

/**
 * Act capture (w2-79881 postmortem §6): the body's own VERIFIED world changes ride into the seen
 * store under the reserved legal provenance "act". A `bot_mine` success means that cell is now
 * air; a `bot_place` success means that cell is now that block; a `bot_target` ledger lists both
 * kinds — the toolkit already refuses to report an act that did not land (the succeeds-falsely
 * purge), so these are observations of the highest confidence the system has. Without this,
 * `locate` kept advertising the dark-oak logs the body itself had chopped, because only a re-LOOK
 * could update memory about a change the hands made.
 *
 * Accepts a direct tool result OR a get_events row's data (both are envelope-stamped). Never
 * throws. Returns what happened for tests/diagnostics.
 */
export async function captureActOutcome(payload, callBridge) {
  try {
    if (!captureEnabled()) return { captured: false, reason: "disabled" };
    if (!payload || typeof payload !== "object") return { captured: false, reason: "no payload" };
    if (!Number.isInteger(payload.game_tick) || typeof payload.dimension !== "string") {
      return { captured: false, reason: "no envelope" };
    }
    const cellValues = [];
    const cellOf = (p) => p && Number.isInteger(p.x) && Number.isInteger(p.y) && Number.isInteger(p.z)
      ? [p.x, p.y, p.z] : null;
    // Direct bot_mine verdict (or its action_completed row): the mined cell is air now.
    if (typeof payload.mined === "string" && payload.pos) {
      const c = cellOf(payload.pos);
      if (c) cellValues.push([...c, MINED_VALUE]);
    }
    // Direct bot_place verdict/row: the cell holds what was placed.
    if (typeof payload.placed === "string" && payload.pos) {
      const c = cellOf(payload.pos);
      if (c) cellValues.push([...c, payload.placed]);
    }
    // A goal ledger: every mined row is air, every placed row is its block.
    const ledger = payload.ledger;
    if (ledger && typeof ledger === "object") {
      for (const row of Array.isArray(ledger.mined) ? ledger.mined : []) {
        const c = cellOf(row);
        if (c) cellValues.push([...c, MINED_VALUE]);
      }
      for (const row of Array.isArray(ledger.placed) ? ledger.placed : []) {
        const c = cellOf(row);
        if (c && typeof row.item === "string" && row.item !== "held") {
          cellValues.push([...c, row.item]);
        }
      }
    }
    if (!cellValues.length) return { captured: false, reason: "no acts" };
    const store = await cachedStore(callBridge);
    const counts = await store.record({
      tool: "act",
      tick: payload.game_tick,
      dim: payload.dimension,
      session: SESSION,
      confirms: true,
      area: { cells: cellValues.map(([x, y, z]) => [x, y, z]), complete: true },
      cellValues,
      query: { action: payload.action ?? "act", cells: cellValues.length },
    });
    return { captured: true, ...counts };
  } catch (e) {
    process.stderr.write(`[observations] act capture failed: ${e.message}\n`);
    return { captured: false, reason: e.message };
  }
}

export async function captureProprioception(payload, callBridge) {
  try {
    if (!captureEnabled()) return { captured: false, reason: "disabled" };
    if (!payload || typeof payload !== "object" || !Array.isArray(payload.traversed)
      || payload.traversed.length === 0) {
      return { captured: false, reason: "no trail" };
    }
    if (!Number.isInteger(payload.game_tick) || typeof payload.dimension !== "string") {
      process.stderr.write(`[observations] proprioception: payload lacks game_tick/dimension — not captured\n`);
      return { captured: false, reason: "no envelope" };
    }
    const cellValues = [];
    for (const row of payload.traversed) {
      if (!Array.isArray(row) || row.length < 6 || ![row[0], row[1], row[2]].every(Number.isInteger)) {
        process.stderr.write(`[observations] proprioception: malformed traversed row — not captured\n`);
        return { captured: false, reason: "bad trail row" };
      }
      const [x, y, z, feet, head, ground] = row;
      cellValues.push([x, y, z, String(feet)], [x, y + 1, z, String(head)], [x, y - 1, z, String(ground)]);
    }
    const store = await cachedStore(callBridge);
    const counts = await store.record({
      tool: "proprioception",
      tick: payload.game_tick,
      dim: payload.dimension,
      session: SESSION,
      confirms: true,
      area: { cells: cellValues.map(([x, y, z]) => [x, y, z]), complete: true },
      cellValues,
      query: { action: payload.action ?? "nav", cells: payload.traversed.length },
    });
    return { captured: true, ...counts };
  } catch (e) {
    process.stderr.write(`[observations] proprioception capture failed: ${e.message}\n`);
    return { captured: false, reason: e.message };
  }
}
