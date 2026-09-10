// Memory-pattern — SURVIVAL_SENSES_DESIGN.md §3: pattern search over the block belief store.
//
// The bridge's `pattern` is an X-ray world scan and stays refused under the survival profile. THIS
// is not that: a pattern evaluated over the observation store is "I have seen part of this shape;
// the rest is worth digging out" — what a player does. The honesty rules that make it sound:
//
//   - Candidates are SEEDED ONLY FROM OBSERVED CELLS matching one of the pattern's nodes (the
//     rarest-in-memory node seeds; a placement supported by zero observations never enumerates —
//     that is the explosion guard that makes unknown-as-wildcard tractable).
//   - Per cell, tri-state: observed-and-matches → MATCH; observed-and-differs → MISMATCH, kills
//     the candidate (an observed contradiction is disqualifying); never-observed → UNKNOWN, dilutes
//     the score but never kills.
//   - The score is always the PAIR (nodes_matched, nodes_unknown) — never collapsed to one number —
//     ranked most-confirmed first, and each candidate lists its unknown cells: the verification
//     plan ("go look/dig here"), the frontier idea at pattern scale.
//   - No registry here, so node matchers get the same needle/route treatment as `what`, with the
//     interpretation disclosed. `negative_is_proof` is false, structurally, like every legal answer.
//
// Vocabulary is a deliberate SUBSET of the bridge's, refused loudly beyond it: block nodes only
// (entities are never in block memory; sets and cell properties are not in the store), relations
// adjacent|above|below|offset|within with the bridge's exact cell arithmetic (LocateTools.PRel).
// Multi-node patterns must be relation-CONNECTED: a floating node has no place in memory to be
// looked for, and a wildcard without a pin is a hypothesis about nowhere.

import { AIR } from "./observations.mjs";
import { cachedStore } from "./capture.mjs";
import { resolveWorld } from "./tools.mjs";
import { REMEMBERED_NOTE, fmtAge, fmtPos } from "./remembered.mjs";
import { matcherFor, routeFor, resolveCenter, frontierLines, bearingOf } from "./legal-locate.mjs";

const DEFAULT_RADIUS = 64;
const MAX_RADIUS = 128;
const DEFAULT_LIMIT = 3;
const MAX_LIMIT = 8;
const MAX_NODES = 6;
const WITHIN_MAX = 16;
/** Seeds tried per search (nearest first) — bounds work, truncation is stated. */
const SEED_CAP = 128;
/** A relation-implied position set larger than this stops hypothesizing blindly: it is intersected
 *  with the node's own observed matches instead (stated per node as `wildcards_limited`). Keeps a
 *  lone `within r:16` (35937 cells) from turning one seed into a cell sweep. */
const IMPLIED_CAP = 512;
/** Distinct surviving candidates kept before ranking; beyond it the search reports truncation. */
const CANDIDATE_CAP = 256;

const RELS = new Set(["adjacent", "above", "below", "offset", "within"]);

/** The bridge's exact relation arithmetic (LocateTools.PRel.holds): d = a − b. */
function relHolds(rel, a, b) {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
  switch (rel.rel) {
    case "adjacent": return Math.abs(dx) + Math.abs(dy) + Math.abs(dz) === 1;
    case "above": return dx === 0 && dz === 0 && dy === 1;
    case "below": return dx === 0 && dz === 0 && dy === -1;
    case "offset": return dx === rel.dx && dy === rel.dy && dz === rel.dz;
    case "within": return Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) <= rel.r;
    default: return false;
  }
}

/** Positions node `forId` may occupy given a placed partner, per one relation. Inverts the a−b
 *  arithmetic: when the placed node is `b`, a = b + d; when it is `a`, b = a − d. */
function impliedPositions(rel, forId, placedId, placedPos) {
  const forIsA = rel.of[0] === forId && rel.of[1] === placedId;
  const [px, py, pz] = placedPos;
  const one = (dx, dy, dz) => [forIsA ? [px + dx, py + dy, pz + dz] : [px - dx, py - dy, pz - dz]];
  switch (rel.rel) {
    case "adjacent":
      return [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
        .map(([dx, dy, dz]) => [px + dx, py + dy, pz + dz]); // symmetric
    case "above": return one(0, 1, 0);
    case "below": return one(0, -1, 0);
    case "offset": return one(rel.dx, rel.dy, rel.dz);
    case "within": {
      const out = [];
      for (let dx = -rel.r; dx <= rel.r; dx++) {
        for (let dy = -rel.r; dy <= rel.r; dy++) {
          for (let dz = -rel.r; dz <= rel.r; dz++) {
            out.push([px + dx, py + dy, pz + dz]); // symmetric (Chebyshev ball)
          }
        }
      }
      return out;
    }
    default: return [];
  }
}

/** Parse+validate the pattern, refusing the bridge vocabulary this store cannot serve — by name,
 *  never by silent narrowing. Returns {nodes, rels, anchor} or throws {message}. */
function parsePattern(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) {
    throw new Error("pattern must be an object {nodes, relations}");
  }
  if (!Array.isArray(p.nodes) || p.nodes.length === 0) {
    throw new Error("pattern.nodes must be a non-empty array of {id, block}");
  }
  if (p.nodes.length > MAX_NODES) {
    throw new Error(`too many pattern nodes (${p.nodes.length} > ${MAX_NODES})`);
  }
  const ids = new Set();
  const nodes = p.nodes.map((n, i) => {
    if (!n || typeof n !== "object") throw new Error(`pattern.nodes[${i}] must be an object`);
    if (typeof n.id !== "string" || !n.id.trim()) throw new Error(`pattern.nodes[${i}] needs an \`id\``);
    if (ids.has(n.id)) throw new Error(`duplicate node id '${n.id}'`);
    ids.add(n.id);
    for (const k of ["entity", "set", "light", "sky_light", "sees_sky", "spawnable"]) {
      if (n[k] !== undefined) {
        throw new Error(`legal_profile: node '${n.id}' uses \`${k}\` — a memory pattern matches only `
          + `remembered BLOCKS (entities: sense_entities; sets/cell properties are not in the store)`);
      }
    }
    if (typeof n.block !== "string" || !n.block.trim()) {
      throw new Error(`pattern.nodes[${i}] ('${n.id}') needs \`block\` (id, #tag, or plain word)`);
    }
    return { id: n.id, block: n.block.trim() };
  });
  const rels = (Array.isArray(p.relations) ? p.relations : []).map((r, i) => {
    if (!r || typeof r !== "object" || !RELS.has(r.rel)) {
      throw new Error(`pattern.relations[${i}]: \`rel\` must be adjacent|above|below|offset|within`);
    }
    if (!Array.isArray(r.of) || r.of.length !== 2 || !ids.has(r.of[0]) || !ids.has(r.of[1])
        || r.of[0] === r.of[1]) {
      throw new Error(`pattern.relations[${i}]: \`of\` must name two distinct node ids`);
    }
    const rel = { rel: r.rel, of: [r.of[0], r.of[1]], dx: r.dx ?? 0, dy: r.dy ?? 0, dz: r.dz ?? 0, r: r.r ?? 1 };
    if (r.rel === "offset" && ![rel.dx, rel.dy, rel.dz].every(Number.isInteger)) {
      throw new Error(`pattern.relations[${i}]: offset needs integer dx/dy/dz`);
    }
    if (r.rel === "within" && (!Number.isInteger(rel.r) || rel.r < 1 || rel.r > WITHIN_MAX)) {
      throw new Error(`pattern.relations[${i}]: within needs \`r\` 1..${WITHIN_MAX}`);
    }
    return rel;
  });
  // Connectivity: every node reachable from the first over the relation graph (single node exempt).
  if (nodes.length > 1) {
    const adj = new Map(nodes.map((n) => [n.id, []]));
    for (const r of rels) {
      adj.get(r.of[0]).push(r.of[1]);
      adj.get(r.of[1]).push(r.of[0]);
    }
    const seen = new Set([nodes[0].id]);
    const queue = [nodes[0].id];
    while (queue.length) for (const nx of adj.get(queue.shift())) if (!seen.has(nx)) { seen.add(nx); queue.push(nx); }
    if (seen.size !== nodes.length) {
      const floating = nodes.filter((n) => !seen.has(n.id)).map((n) => `'${n.id}'`).join(", ");
      throw new Error(`legal_profile: node(s) ${floating} have no relation connecting them to the rest — `
        + `a floating node has no place in memory to be looked for. Relate every node, or search it `
        + `separately with \`what:\``);
    }
  }
  let anchor = nodes[0].id;
  if (p.anchor !== undefined) {
    if (!ids.has(p.anchor)) throw new Error(`anchor '${p.anchor}' is not a node id`);
    anchor = p.anchor;
  }
  return { nodes, rels, anchor };
}

/**
 * The survival-profile pattern search. Same envelope contract as legalLocate; `callBridge` is used
 * only for centre resolution and world identity — never a world read.
 */
export async function legalPattern(args, callBridge) {
  const a = args ?? {};
  let parsed;
  try {
    parsed = parsePattern(a.pattern);
  } catch (e) {
    return { ok: false, error: `locate pattern: ${e.message}` };
  }
  const { nodes, rels, anchor } = parsed;

  const store = await cachedStore(callBridge);
  const world = await resolveWorld(callBridge);
  const now = Number.isInteger(world.tick) ? world.tick : null;
  const dim = a.dimension ?? "minecraft:overworld";
  const radius = Math.min(Number.isFinite(a.radius) ? a.radius : DEFAULT_RADIUS, MAX_RADIUS);
  const limit = Math.min(Number.isInteger(a.limit) ? a.limit : DEFAULT_LIMIT, MAX_LIMIT);
  const { center, from } = await resolveCenter(a, callBridge);
  if (!center) {
    return { ok: false, error: "legal locate searches around your body or `near` — no body is spawned and no near given" };
  }
  const inRadius = (pos) => Math.hypot(pos[0] - center[0], pos[2] - center[1]) <= radius;

  // The store, indexed once: cell lookup for tri-state tests, per-node observed matches for seeds.
  const cells = await store.legalCells({ dim });
  const byKey = new Map(cells.map((c) => [c.pos.join(","), c]));
  const routeNotes = [];
  const perNode = new Map(); // id → {matches(fn), observed: [cell...] in-radius, sorted nearest}
  for (const n of nodes) {
    const routed = await routeFor(n.block);
    if (routed) {
      routeNotes.push(`[route] node '${n.id}': "${n.block}" read as `
        + `${routed.route.legs.map((l) => l.what).join(" ∨ ")} (${routed.route.provenance})`);
    }
    const { matches } = matcherFor(n.block, routed?.needles ?? null);
    const observed = cells
      .filter((c) => c.val !== AIR && matches(c.id) && inRadius(c.pos))
      .sort((x, y) => Math.hypot(x.pos[0] - center[0], x.pos[2] - center[1])
        - Math.hypot(y.pos[0] - center[0], y.pos[2] - center[1]));
    perNode.set(n.id, { matches, observed });
  }

  // Tri-state for one node at one position. MISMATCH kills upstream; here it returns null.
  const stateAt = (nodeId, pos) => {
    const c = byKey.get(pos.join(","));
    if (!c) return { state: "unknown" };
    return perNode.get(nodeId).matches(c.id) && c.val !== AIR
      ? { state: "match", cell: c }
      : null; // observed and it is something else — the candidate dies here
  };

  // Seed from the rarest node that has observed matches at all.
  const seedNode = [...perNode.entries()]
    .filter(([, v]) => v.observed.length > 0)
    .sort((x, y) => x[1].observed.length - y[1].observed.length)[0]?.[0];

  const cov = await store.legalCoverage({ center, radius, dim });
  const baseLines = [`## remembered pattern (survival profile: your memory, not a live scan)`, ...routeNotes];

  if (!seedNode) {
    const lines = [...baseLines,
      `no node of this pattern matches anything you have seen within r=${radius} of ${fmtPos(center)} — `
      + `absent from your MEMORY, not proven absent from the world.`,
      ...frontierLines(cov, radius, { hit: false }),
      `[${REMEMBERED_NOTE}]`];
    return {
      ok: true,
      result: {
        direction: "pattern", remembered: true, legal_profile: true, mechanism: "memory_pattern",
        center, center_from: from, radius, candidates: [], coverage: cov,
        negative_is_proof: false, render: lines.join("\n"), note: REMEMBERED_NOTE,
      },
    };
  }

  // Place nodes in BFS order from the seed so every placement is relation-implied from a pin.
  const order = [seedNode];
  {
    const placed = new Set(order);
    while (placed.size < nodes.length) {
      const next = nodes.find((n) => !placed.has(n.id)
        && rels.some((r) => r.of.includes(n.id) && r.of.some((o) => placed.has(o) && o !== n.id)));
      order.push(next.id); // connectivity was validated, so `next` always exists
      placed.add(next.id);
    }
  }

  const wildcardsLimited = new Set();
  let truncated = false;
  // Dedup on the MULTISET of (block spec, position): two nodes with the same spec are
  // interchangeable, so a symmetric pattern's mirrored assignments (a↔b swapped) are one candidate,
  // not two — the bridge's groupKey rule, applied to what this store can distinguish.
  const specOf = new Map(nodes.map((n) => [n.id, n.block]));
  const seen = new Set();
  const candidates = [];
  const seeds = perNode.get(seedNode).observed;
  if (seeds.length > SEED_CAP) truncated = true;

  for (const seed of seeds.slice(0, SEED_CAP)) {
    // Backtracking join, mismatches pruned as they appear.
    const place = (idx, assignment) => {
      if (candidates.length >= CANDIDATE_CAP) { truncated = true; return; }
      if (idx === order.length) {
        const key = order.map((id) => `${specOf.get(id)}@${assignment.get(id).pos.join(",")}`).sort().join("|");
        if (seen.has(key)) return;
        seen.add(key);
        candidates.push(new Map(assignment));
        return;
      }
      const nodeId = order[idx];
      const constraining = rels.filter((r) => r.of.includes(nodeId)
        && assignment.has(r.of[0] === nodeId ? r.of[1] : r.of[0]));
      // Intersect the implied position sets of every relation to an already-placed partner.
      let positions = null;
      for (const r of constraining) {
        const partner = r.of[0] === nodeId ? r.of[1] : r.of[0];
        const impl = impliedPositions(r, nodeId, partner, assignment.get(partner).pos);
        positions = positions === null
          ? impl
          : positions.filter((p) => impl.some((q) => q[0] === p[0] && q[1] === p[1] && q[2] === p[2]));
      }
      if (positions.length > IMPLIED_CAP) {
        // A loose `within` must not hypothesize over thousands of cells: fall back to the node's
        // own observed matches that satisfy the constraints — stated, not silent.
        wildcardsLimited.add(nodeId);
        positions = perNode.get(nodeId).observed
          .map((c) => c.pos)
          .filter((p) => constraining.every((r) => {
            const partner = r.of[0] === nodeId ? r.of[1] : r.of[0];
            const pa = r.of[0] === nodeId ? p : assignment.get(partner).pos;
            const pb = r.of[0] === nodeId ? assignment.get(partner).pos : p;
            return relHolds(r, pa, pb);
          }));
      }
      for (const pos of positions) {
        if (!inRadius(pos)) continue;
        // Two nodes on one cell is a degenerate shape (one block counted twice) — skip it.
        if ([...assignment.values()].some((v) => v.pos[0] === pos[0] && v.pos[1] === pos[1] && v.pos[2] === pos[2])) continue;
        const st = stateAt(nodeId, pos);
        if (st === null) continue; // observed mismatch — killed
        assignment.set(nodeId, { pos, ...st });
        place(idx + 1, assignment);
        assignment.delete(nodeId);
        if (candidates.length >= CANDIDATE_CAP) return;
      }
    };
    place(1, new Map([[seedNode, { pos: seed.pos, state: "match", cell: seed }]]));
    if (candidates.length >= CANDIDATE_CAP) break;
  }

  // Score, floor, rank. The floor (≥2 observed nodes, ≥1 for small patterns) keeps a single stray
  // match from projecting a mostly-imaginary shape.
  const minObserved = nodes.length <= 2 ? 1 : 2;
  const scored = candidates
    .map((asg) => {
      const rows = order.map((id) => ({ node: id, ...asg.get(id) }));
      const matched = rows.filter((r) => r.state === "match");
      const unknown = rows.filter((r) => r.state === "unknown");
      const apos = asg.get(anchor).pos;
      const dx = apos[0] - center[0], dz = apos[2] - center[1];
      return {
        rows, matched, unknown,
        anchor_pos: apos,
        dist: Math.round(Math.hypot(dx, dz)),
        bearing: bearingOf(dx, dz),
      };
    })
    .filter((c) => c.matched.length >= minObserved)
    .sort((x, y) => (y.matched.length - x.matched.length)
      || (x.unknown.length - y.unknown.length) || (x.dist - y.dist));

  const shown = scored.slice(0, limit).map((c) => ({
    nodes_matched: c.matched.length,
    nodes_unknown: c.unknown.length,
    nodes_total: nodes.length,
    anchor: { node: anchor, pos: c.anchor_pos, dist: c.dist, bearing: c.bearing },
    observed: c.matched.map((r) => ({
      node: r.node, pos: [...r.pos], val: r.cell.val, seen_tick: r.cell.tick, seen_via: r.cell.tool,
      ...(r.cell.superseded_illegally ? { note: "as of YOUR last look" } : {}),
    })),
    unknown_cells: c.unknown.map((r) => ({ node: r.node, pos: [...r.pos] })),
  }));

  const lines = [...baseLines];
  if (shown.length) {
    lines.push(`${scored.length} candidate placement(s) — partial SHAPES assembled from SEEN blocks; `
      + `unknown cells are hypotheses, not findings:`);
    for (const c of shown) {
      lines.push(`${c.nodes_matched}/${c.nodes_total} nodes seen`
        + (c.nodes_unknown ? ` (${c.nodes_unknown} unknown)` : "")
        + ` — anchor '${c.anchor.node}' @ ${fmtPos(c.anchor.pos)}, ${c.anchor.dist} blocks `
        + `${c.anchor.bearing} of ${from === "body" ? "you" : "near"}`);
      for (const o of c.observed) {
        lines.push(`  seen: '${o.node}' = ${o.val} @ ${fmtPos(o.pos)}`
          + (now !== null ? ` (${fmtAge(now, o.seen_tick)})` : ""));
      }
      for (const u of c.unknown_cells) {
        lines.push(`  UNKNOWN: '${u.node}' would be @ ${fmtPos(u.pos)} — go look or dig there to confirm`);
      }
    }
    if (scored.length > limit) lines.push(`(+${scored.length - limit} more candidate(s))`);
    lines.push(`These are memories plus hypotheses — verify the unknown cells before acting.`);
  } else {
    lines.push(`no candidate placement survives within r=${radius} of ${fmtPos(center)} — either the `
      + `seen parts contradict the shape, or too little of it has been seen. Absent from your `
      + `MEMORY, not proven absent from the world.`);
  }
  if (wildcardsLimited.size) {
    lines.push(`(node(s) ${[...wildcardsLimited].map((n) => `'${n}'`).join(", ")}: a loose \`within\` `
      + `spans too many cells to hypothesize blindly — only their SEEN matches were considered)`);
  }
  if (truncated) lines.push(`(search truncated at caps — nearer placements were preferred)`);
  lines.push(...frontierLines(cov, radius, { hit: shown.length > 0 }));
  lines.push(`[${REMEMBERED_NOTE}]`);

  return {
    ok: true,
    result: {
      direction: "pattern", remembered: true, legal_profile: true, mechanism: "memory_pattern",
      center, center_from: from, radius,
      candidates: shown,
      ...(scored.length > limit ? { candidates_truncated: scored.length - limit } : {}),
      ...(wildcardsLimited.size ? { wildcards_limited: [...wildcardsLimited] } : {}),
      ...(truncated ? { search_truncated: true } : {}),
      coverage: cov,
      negative_is_proof: false,
      render: lines.join("\n"),
      note: REMEMBERED_NOTE,
    },
  };
}
