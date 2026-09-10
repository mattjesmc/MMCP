// Pure block-grid diff — the auto-scoring core shared by W-schematic (build-to-match a target NBT)
// and W-repair (fix deviations from a blueprint) and E-survive-build's structural goals. Server-free
// and fully unit-testable (build-score.test.mjs): it takes two block maps and reports fidelity. The
// harnesses do the staging/capture; ALL scoring math lives here so it can be validated with zero
// model spend and zero dev server.
//
// A "block map" is a plain object keyed "x,y,z" → raw block id (e.g. "minecraft:oak_planks" or
// "minecraft:oak_stairs[facing=east]"). `target` is the intended structure; `built` is what was read
// out of the plot region afterward. Air (any *air variant, empty, or null) is UNOCCUPIED — a target
// never asks for air, and built air just means "nothing there".

export function normId(b) {
  if (b == null) return "";
  let s = String(b).toLowerCase().trim();
  s = s.replace(/^minecraft:/, "");   // drop the default namespace
  s = s.replace(/\[.*\]$/, "");        // drop blockstate props — silhouette/material match is by base id
  return s;
}
export function isAir(b) {
  const s = normId(b);
  return s === "" || s === "air" || s === "cave_air" || s === "void_air";
}
export function keyOf(p) {
  if (Array.isArray(p)) return `${p[0]},${p[1]},${p[2]}`;
  return `${p.x},${p.y},${p.z}`;
}

/** Occupied (non-air) keys of a block map, as a Set. */
function occupied(map) {
  const s = new Set();
  for (const k of Object.keys(map)) if (!isAir(map[k])) s.add(k);
  return s;
}
const inter = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n; };
const union = (a, b) => { const u = new Set(a); for (const x of b) u.add(x); return u.size; };

/**
 * Diff `built` against `target`. All fields are counts unless a ratio (0..1). Ratios are safe on
 * empty targets (an empty target with an empty build is a perfect 1). Material match ignores
 * blockstate props (normId strips them) — position+base-id is the fidelity the bench cares about.
 */
export function diffBuild(target, built) {
  const tOcc = occupied(target), bOcc = occupied(built);
  let correct = 0, wrongMaterial = 0, missing = 0;
  for (const k of tOcc) {
    if (!bOcc.has(k)) { missing++; continue; }
    if (normId(built[k]) === normId(target[k])) correct++;
    else wrongMaterial++;
  }
  let extra = 0;
  for (const k of bOcc) if (!tOcc.has(k)) extra++;

  const tN = tOcc.size, uN = union(tOcc, bOcc);
  const blockMatch = tN ? correct / tN : (bOcc.size ? 0 : 1);          // % of target cells built correctly
  const silhouetteIoU = uN ? inter(tOcc, bOcc) / uN : 1;               // shape fidelity, material-agnostic
  const fidelity = uN ? correct / uN : 1;                              // strict: correct cell AND material, penalizes extras
  const exact = missing === 0 && extra === 0 && wrongMaterial === 0;

  return {
    target_cells: tN, built_cells: bOcc.size,
    correct, wrong_material: wrongMaterial, missing, extra,
    block_match: round3(blockMatch), silhouette_iou: round3(silhouetteIoU), fidelity: round3(fidelity),
    exact,
  };
}

/** Build a block map from a list of {x,y,z,block} (or {pos:[x,y,z],block}) cells. */
export function mapFromCells(cells) {
  const m = {};
  for (const c of cells) {
    const p = c.pos ?? c;
    m[keyOf(p)] = c.block ?? c.id ?? c.b;
  }
  return m;
}

/** Build a block map from the toolkit's palette_rows shape ({palette:[...], blocks:[[x,y,z,idx],...]}). */
export function mapFromPaletteRows(obj) {
  const m = {};
  const pal = obj.palette ?? [];
  for (const row of obj.blocks ?? []) {
    const [x, y, z, idx] = row;
    m[keyOf({ x, y, z })] = pal[idx];
  }
  return m;
}

function round3(n) { return Math.round(n * 1000) / 1000; }
