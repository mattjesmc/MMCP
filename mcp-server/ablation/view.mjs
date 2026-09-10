// Abstracted perception view (ABLATION_DESIGN pilot finding; phase-C "current environment is the
// abstracted view"). Raw get_blocks JSON is a needle-in-haystack encoding: 3 missing walkway
// columns among thousands of terrain entries defeated two agents in the stale-fact pilot, and big
// grids blew the payload cap (7–11% visible after truncation). This re-encodes the column list as
// an ASCII surface map + legend: structure reads as shape, gaps read as holes, ~50× smaller.
// Harness policy — applied uniformly across all conditions, upstream of the transcript.

const PALETTE = ".#POSWTGCLBHXAEFIKMNRUVYZabcdefghij".split("");

// The bridge's get_blocks (detail:full) returns columns as palette-indexed tuples
// `blocks: [[x,y,z,paletteIdx], …]` + `palette: ["minecraft:…", …]` (verified against toolkit
// 0.14.0). Older/synthetic callers passed object columns `[{x,y,z,block}, …]`. Normalize both to
// `{x,y,z,block}` so the renderer has one shape — the array form silently produced `undefined`
// coordinates and crashed on `b.block.replace` before this (Category C recorded the crash envelopes).
function normalizeColumns(result) {
  const raw = result.blocks ?? [];
  if (!raw.length) return [];
  if (Array.isArray(raw[0])) {
    const pal = result.palette ?? [];
    return raw.map(([x, y, z, idx]) => ({ x, y, z, block: pal[idx] ?? `#${idx}` }));
  }
  return raw; // already {x,y,z,block}
}

/**
 * Re-encode a get_blocks result as a compact ASCII surface map + legend (~1 char/column vs a full
 * per-column JSON row): structure reads as shape, gaps read as holes.
 * @param {{origin?: object, grid?: number, palette?: string[],
 *          blocks: Array<[number,number,number,number]>|Array<{x,y,z,block}>}} result
 */
export function asciiSurfaceView(result) {
  const blocks = normalizeColumns(result);
  // Preserve the completeness signals the agent needs to trust a read (was anything unloaded /
  // truncated?) even when there are no columns to map.
  const meta = {
    origin: result.origin, grid: result.grid, heightmap: result.heightmap,
    dimension: result.dimension, columns: result.columns, game_tick: result.game_tick,
    perception_mode: result.perception_mode, coverage: result.coverage,
    unloaded: result.unloaded, truncated: result.truncated,
  };
  if (!blocks.length) return { ...meta, view: "(no columns returned)" };

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const byBlock = new Map(); // block id -> {count, ys: Map<y, count>}
  for (const b of blocks) {
    if (b.x < minX) minX = b.x;
    if (b.x > maxX) maxX = b.x;
    if (b.z < minZ) minZ = b.z;
    if (b.z > maxZ) maxZ = b.z;
    const e = byBlock.get(b.block) ?? { count: 0, ys: new Map() };
    e.count++;
    e.ys.set(b.y, (e.ys.get(b.y) ?? 0) + 1);
    byBlock.set(b.block, e);
  }

  // Char per block id, most common first ('.' = dominant background).
  const ranked = [...byBlock.entries()].sort((a, b) => b[1].count - a[1].count);
  const charOf = new Map(ranked.map(([id], i) => [id, PALETTE[Math.min(i, PALETTE.length - 1)]]));

  const grid = new Map(); // "x,z" -> {c, y}
  for (const b of blocks) grid.set(`${b.x},${b.z}`, { c: charOf.get(b.block), y: b.y });

  const rows = [];
  for (let z = minZ; z <= maxZ; z++) {
    let line = "";
    for (let x = minX; x <= maxX; x++) line += grid.get(`${x},${z}`)?.c ?? " ";
    rows.push(`z${z} ${line}`);
  }

  const legend = ranked.map(([id, e]) => {
    const ys = [...e.ys.entries()].sort((a, b) => b[1] - a[1]);
    const dom = ys[0][0];
    const spread = ys.length > 1 ? ` y${Math.min(...e.ys.keys())}..${Math.max(...e.ys.keys())} (mostly y${dom})` : ` y${dom}`;
    return `${charOf.get(id)}=${id.replace("minecraft:", "")}${spread} ×${e.count}`;
  });

  // Outliers: same block at a y far from its dominant y (part-built/broken structures stand out).
  const domY = new Map(ranked.map(([id, e]) => [id, [...e.ys.entries()].sort((a, b) => b[1] - a[1])[0][0]]));
  const outliers = blocks
    .filter((b) => Math.abs(b.y - domY.get(b.block)) > 3)
    .slice(0, 30)
    .map((b) => `(${b.x},${b.y},${b.z}) ${b.block.replace("minecraft:", "")}`);

  return {
    ...meta,
    view: [
      `surface map, x ${minX}..${maxX} (left→right), z ${minZ}..${maxZ} (top→bottom); each cell = column's surface block`,
      `legend: ${legend.join("  ")}`,
      ...rows,
      ...(outliers.length ? [`outlier columns (y far from block's usual): ${outliers.join("; ")}`] : []),
      // The one axis this view compresses: a non-outlier column's exact y is only known to its
      // block's legend band. Tasks needing exact adjacent heights (reachability, per-tile flatness)
      // should escalate for certainty rather than guess from the band.
      `heights aggregated per block (see legend bands); for exact per-column y call get_blocks detail:"full".`,
    ].join("\n"),
  };
}
