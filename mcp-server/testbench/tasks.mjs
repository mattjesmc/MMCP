// Category T — tool-ablation task battery (with vs without the representation tools).
//
// Each template instantiates per seed into a concrete task: a question over the live world with a
// machine-checkable truth. Truths for staged terrain are known by construction; truths on wild
// terrain come from the predicates themselves (probe-validated in probes/*.test.mjs — the bench
// measures agent behaviour, not predicate correctness). The rung ladder runs from anchor-easy to
// beyond-budget: the interesting output is WHERE each arm's accuracy cliff sits and what each
// answer cost in turns/tokens, not the mean score.

import { ORIGIN } from "./layout.mjs";
import { call, cmd } from "./bridge.mjs";

// The ablation subject: the without-arm loses exactly these. 0.7.0 added the predicate family's
// INVERSE — find_site (footprint -> ranked, fit-verified candidate sites) and resolve_anchor
// (spatial relation -> coordinates, fit check in-call) — confirmed against the Java registrations
// in mcp-toolkit/src/main/java/com/mattmc/mcptoolkit/PredicateTools.java (no dev server was up to
// cross-check the live manifest at prep time; run-tasks.mjs's own manifest validation at run start
// re-verifies these names against whatever bridge is actually running). These are exactly the
// tools TODO.md's "Category-T/A bench rerun" line and RESEARCH_WORLD_REPRESENTATION.md open
// question 4 want priced — t9_findsite (below) is the rung that actually calls them.
//
// 0.7.0 also shipped palette-level affordance flags (Affordances.flags on get_surface/
// get_blocks_at/describe_box/raycast) and opt-in region connectivity (get_region_summary's
// `connectivity`/`walk_components`) — but those are FIELDS added to tools already in this list or
// to base tools (get_surface) that stay visible in BOTH arms, not separate tools. They can't be
// ablated by hiding a tool name; their value is carried by the existing subject/base tools and
// isn't isolated by this with/without design.
export const REPRESENTATION_TOOLS = [
  // 0.22.0 merge: check_fit -> locate at+clear, check_clearance + find_site -> check_site doors.
  "check_path", "check_site", "get_region_summary", "mem_locate", "resolve_anchor",
];

// The INVERSE ablation (the `swap` arm): hide the raw reads and keep the representation tools +
// `locate`. `without` asks "are the predicates worth it?" (yes: 94 -> 74). This asks the question
// that actually pays the bill — "can we DELETE the raw reads?" — because those six are 19% of the
// manifest and the LOO scored them Δacc≈0 individually. Individually-substitutable does not imply
// collectively-removable (they substitute for EACH OTHER), which is exactly what this measures.
// Expect a per-rung capability map, not a single number: r10 asks for block IDENTITY at given
// coordinates and nothing here reports that, so its failure is a known-unanswerable pairing and a
// finding in itself (see TOOL_BILL_PLAN.md §6).
export const RAW_READ_TOOLS = [
  "get_surface", "get_blocks_at", "describe_box", "raycast", "raycast_fan", "get_entities",
];

// Hidden in BOTH arms: mutation and outsourcing. Command access would let a session answer by
// /execute-probing, write tools would let it rebuild the world instead of observing it, and
// companion/session tools would let it delegate the question to another session. Embodied
// OBSERVE probing (bot_spawn/bot_goto/bot_status) stays available in both arms on purpose — if
// empirical probing beats the predicates, that is a real finding, not a leak. Validated against
// the live manifest at run start.
export const BASE_HIDDEN = [
  "run_command", "set_blocks", "place_shape", "place_blocks", "undo_edit",
  "bot_place", "bot_mine", "bot_use", "bot_attack", "bot_give",
  "hotswap_class", "import_building", "save_building", "edit_building",
  "companion_spawn", "session_send",
];

// --- deterministic PRNG (mulberry32) — layout varies by seed, never by wall clock ---------------
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ri = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1)); // inclusive
const pick = (r, xs) => xs[Math.floor(r() * xs.length)];

// --- geography ----------------------------------------------------------------------------------
// Staged pads sit on the arena's sky level (y=150) but well clear of it; wild anchors land on
// untouched natural terrain 1-3km out, deterministic per seed, truths measured live.
const PAD_Y = ORIGIN.y;
// One pad per (template, seed) — templates sharing a pad would wipe each other's staging.
const padAt = (seed, slot) => ({ x: ORIGIN.x + 300 + seed * 120, y: PAD_Y, z: ORIGIN.z - 400 - slot * 60 });
const penAt = (seed) => ({ x: ORIGIN.x + 300 + seed * 120, y: PAD_Y, z: ORIGIN.z - 700 });
const wildAt = (seed, k = 0) => ({
  x: ORIGIN.x + 1000 + seed * 613 + k * 257,
  z: ORIGIN.z + 1400 + seed * 401 + k * 173,
});

// Staged sites are forceloaded for the whole run, exactly like the wild areas: check_path spawns
// a throwaway walker, and the honest-envelope rule means ANY tool over unloaded chunks answers
// null — the bench found this out the hard way on its own first dry run. The returned rect goes
// into the template's `forceloaded` so run-tasks.mjs releases it at the end.
async function loadRect(minX, minZ, maxX, maxZ) {
  await cmd(`forceload add ${minX} ${minZ} ${maxX} ${maxZ}`);
  const t0 = Date.now();
  for (;;) { // forceload marks async — wait for actual residency
    const s = await call("check_site", { at: { x: minX, z: minZ }, size: { w: 4, d: 4 } });
    if (s.coverage?.state === "complete") return [minX, minZ, maxX, maxZ];
    if (Date.now() - t0 > 120_000) throw new Error(`staged site (${minX},${minZ}) not resident in 120s`);
    await new Promise((res) => setTimeout(res, 1000));
  }
}

async function stagePad(seed, slot) {
  const p = padAt(seed, slot);
  p.area = await loadRect(p.x - 8, p.z - 8, p.x + 31, p.z + 31);
  await cmd(`fill ${p.x} ${p.y - 1} ${p.z} ${p.x + 23} ${p.y - 1} ${p.z + 23} minecraft:stone`);
  await cmd(`fill ${p.x} ${p.y} ${p.z} ${p.x + 23} ${p.y} ${p.z + 23} minecraft:stone`);
  await cmd(`fill ${p.x} ${p.y + 1} ${p.z} ${p.x + 23} ${p.y + 8} ${p.z + 23} minecraft:air`);
  return p;
}

async function stagePen(seed, r) {
  const p = penAt(seed);
  const S = 12, H = 4;
  p.area = await loadRect(p.x - 12, p.z - 12, p.x + S + 11, p.z + S + 11);
  await cmd(`fill ${p.x - 6} ${p.y - 1} ${p.z - 6} ${p.x + S + 5} ${p.y - 1} ${p.z + S + 5} minecraft:stone`);
  await cmd(`fill ${p.x - 6} ${p.y} ${p.z - 6} ${p.x + S + 5} ${p.y} ${p.z + S + 5} minecraft:stone`);
  await cmd(`fill ${p.x - 6} ${p.y + 1} ${p.z - 6} ${p.x + S + 5} ${p.y + H + 2} ${p.z + S + 5} minecraft:air`);
  // Four explicit walls (never `fill hollow` — it closes top/bottom faces, the staging lesson).
  await cmd(`fill ${p.x} ${p.y + 1} ${p.z} ${p.x + S} ${p.y + H} ${p.z} minecraft:stone_bricks`);
  await cmd(`fill ${p.x} ${p.y + 1} ${p.z + S} ${p.x + S} ${p.y + H} ${p.z + S} minecraft:stone_bricks`);
  await cmd(`fill ${p.x} ${p.y + 1} ${p.z} ${p.x} ${p.y + H} ${p.z + S} minecraft:stone_bricks`);
  await cmd(`fill ${p.x + S} ${p.y + 1} ${p.z} ${p.x + S} ${p.y + H} ${p.z + S} minecraft:stone_bricks`);
  const sealed = seed % 2 === 0; // balanced reachable/unreachable by construction across seeds
  const side = pick(r, ["north", "south", "east", "west"]);
  if (!sealed) {
    const mid = Math.floor(S / 2);
    const gaps = {
      north: [p.x + mid - 1, p.z, p.x + mid + 1, p.z],
      south: [p.x + mid - 1, p.z + S, p.x + mid + 1, p.z + S],
      west: [p.x, p.z + mid - 1, p.x, p.z + mid + 1],
      east: [p.x + S, p.z + mid - 1, p.x + S, p.z + mid + 1],
    }[side];
    await cmd(`fill ${gaps[0]} ${p.y + 1} ${gaps[1]} ${gaps[2]} ${p.y + 2} ${gaps[3]} minecraft:air`);
  }
  return { p, S, sealed, side };
}

// Wild chunks must exist before anything reads them (reads never generate). Forceload-adding a
// whole ungenerated region in one command stalls the server thread — the first big dry run got
// the world WATCHDOG-KILLED that way (a tick blocked >60s). So: add in 32-block strips, and wait
// for each strip to actually generate before adding the next; the server ticks in between.
export async function ensureGenerated(minX, minZ, maxX, maxZ, { timeoutMs = 600_000 } = {}) {
  const t0 = Date.now();
  const expired = () => {
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`wild area (${minX},${minZ})..(${maxX},${maxZ}) not generated within ${timeoutMs}ms`);
    }
  };
  for (let z = minZ; z <= maxZ; z += 32) {
    const zEnd = Math.min(z + 31, maxZ);
    await cmd(`forceload add ${minX} ${z} ${maxX} ${zEnd}`);
    // Brief pacing poll so consecutive adds don't pile ungenerated strips onto one tick.
    for (;;) {
      const probe = await call("check_site", { at: { x: minX, z }, size: { w: 4, d: 4 } });
      if (probe.coverage?.state === "complete") break;
      expired();
      await new Promise((res) => setTimeout(res, 1500));
    }
  }
  // Full verification sweep: EVERY 32×32 cell must read complete — corner probes once let
  // half-generated interiors through, and a bench truth over half-generated terrain is garbage.
  let cells = [];
  for (let x = minX; x <= maxX; x += 32) {
    for (let z = minZ; z <= maxZ; z += 32) {
      cells.push({ x, z, w: Math.min(32, maxX - x + 1), d: Math.min(32, maxZ - z + 1) });
    }
  }
  while (cells.length) {
    const still = [];
    for (const c of cells) {
      const s = await call("check_site", { at: { x: c.x, z: c.z }, size: { w: c.w, d: c.d } });
      if (s.coverage?.state !== "complete") still.push(c);
    }
    cells = still;
    if (cells.length) {
      expired();
      await new Promise((res) => setTimeout(res, 1500));
    }
  }
}
export const releaseArea = (minX, minZ, maxX, maxZ) =>
  cmd(`forceload remove ${minX} ${minZ} ${maxX} ${maxZ}`).catch(() => {});

// --- templates ----------------------------------------------------------------------------------
// Each returns a task: {id, rung, maxTurns, prompt, answer_type, truth, ...}. The old per-template
// `difficulty` label is gone: it was hand-assigned, never checked against outcomes, and the tier x
// arm split showed it was grading tool-dependence rather than difficulty. Its two successors
// (tool_dependence, reasoning_load) are MEASURED and live on the registry unit — see
// registry.mjs LOAD_BANDS; run-tasks.mjs stamps them onto each row from there.
// `forceloaded` rectangles stay loaded for the whole run (the bench measures reasoning economics,
// not chunk-paging ops); run-tasks.mjs releases them at the end.

const MARKERS = ["minecraft:gold_block", "minecraft:emerald_block", "minecraft:diamond_block", "minecraft:lapis_block"];

// --- t9 terrain: pure helpers (offline-testable, see tasks-truth.test.mjs) ----------------------
// The terrain is a 1-D step profile along x, constant along z, in buckets of width 2. Even buckets
// sit at 0; odd buckets rise to their own amplitude.
//
// WHY BUCKETS OF 2: any 3 consecutive integers span exactly 2 buckets (a span-3 window cannot fit
// inside a width-2 bucket) and those buckets are always consecutive, hence opposite parity. So every
// 3-wide window sees EXACTLY 2 distinct heights — 0 and one odd bucket's amplitude — split 2-1 in x,
// i.e. 6-3 over the 3x3 columns. That is a strict, tie-free modal majority no matter how the reader
// iterates its histogram, which matters because PredicateTools.findSite picks the target y by a
// HashMap max-by-count (bucket order, not insertion order) while this replication uses a Map.
//
// WHY THE AMPLITUDES VARY (the fix): the previous version gave every odd bucket the SAME amplitude
// `jump`. That made every window's terrain work identical — 3 minority columns x jump — so the
// "minimum over all anchors" was a constant, there was no argmin left to search, and the truth
// reduced to 3 x jump. Since the prompt states the feature's y-range (p.y .. p.y + jump), the answer
// was a closed-form function of the PROMPT TEXT: 3 x (y_max - y_min). Confirmed against the live
// corpus (seed 1 jump 5 -> truth 15; seed 2 jump 3 -> truth 9). A rung built to price find_site's
// search could be solved with arithmetic and zero world reads.
//
// With per-bucket amplitudes the work of a window is 3 x (that window's odd-bucket amplitude), so
// the minimum is 3 x the SMALLEST amplitude in the domain — a real argmin that has to be found by
// reading the terrain, while the prompt can only state the range (which reveals the LARGEST).
export function t9Profile(r, { span = 24, minDx = 4, maxDx = 19 } = {}) {
  const nB = Math.ceil(span / 2) + 2;
  const amp = Array.from({ length: nB }, (_, b) => (b % 2 === 0 ? 0 : ri(r, 2, 8)));
  const odd = t9OddBuckets(minDx, maxDx);
  // At least two DISTINCT amplitudes must be reachable, or the minimum collapses back to a constant
  // and the closed-form leak returns.
  if (odd.length >= 2 && new Set(odd.map((b) => amp[b])).size < 2) {
    const other = amp[odd[1]];
    const choices = [2, 3, 4, 5, 6, 7, 8].filter((v) => v !== other);
    amp[odd[0]] = choices[Math.floor(r() * choices.length)];
  }
  return amp;
}
/** Odd (raised) buckets reachable by any window inside the declared anchor domain. */
export function t9OddBuckets(minDx, maxDx) {
  const out = [];
  for (let b = Math.floor(minDx / 2); b <= Math.floor(maxDx / 2); b++) if (b % 2 === 1) out.push(b);
  return out;
}
export const t9HeightAt = (amp, dx) => amp[Math.floor(dx / 2)] ?? 0;

/** Replicates PredicateTools.findSite's modal-target-y + cut/fill, over the known height field. */
export function t9MinWork(amp, minDx, maxDx, W = 3, D = 3) {
  let best = Infinity;
  for (let ax = minDx; ax + W - 1 <= maxDx; ax++) {
    const hist = new Map();
    for (let dx = ax; dx < ax + W; dx++) {
      const h = t9HeightAt(amp, dx);
      hist.set(h, (hist.get(h) ?? 0) + D);
    }
    let targetY = null, targetCount = -1;
    for (const [h, n] of hist) if (n > targetCount) { targetY = h; targetCount = n; }
    let work = 0;
    for (let dx = ax; dx < ax + W; dx++) work += Math.abs(t9HeightAt(amp, dx) - targetY) * D;
    best = Math.min(best, work);
  }
  return best;
}

/** Every window must have a UNIQUE modal height, or the answer key depends on map iteration order. */
export function t9EveryWindowHasStrictMode(amp, minDx, maxDx, W = 3, D = 3) {
  for (let ax = minDx; ax + W - 1 <= maxDx; ax++) {
    const hist = new Map();
    for (let dx = ax; dx < ax + W; dx++) {
      const h = t9HeightAt(amp, dx);
      hist.set(h, (hist.get(h) ?? 0) + D);
    }
    const counts = [...hist.values()].sort((a, b) => b - a);
    if (counts.length > 1 && counts[0] === counts[1]) return false;
  }
  return true;
}

export const TEMPLATES = [
  {
    rung: 1, id: "t1_point", maxTurns: 64, // circuit breaker, never a budget (A5)
    async gen(seed, r) {
      const p = await stagePad(seed, 0);
      const at = { x: p.x + ri(r, 2, 21), y: p.y + 1, z: p.z + ri(r, 2, 21) };
      const block = pick(r, MARKERS);
      await call("set_blocks", { blocks: [{ ...at, block }] });
      return {
        prompt: `What is the exact block id at (${at.x}, ${at.y}, ${at.z})?`,
        answer_type: "block_id", truth: block, forceloaded: p.area,
      };
    },
  },
  {
    rung: 2, id: "t2_clear", maxTurns: 64, // circuit breaker, never a budget (A5)
    async gen(seed, r) {
      const p = await stagePad(seed, 1);
      const box = { x: p.x + ri(r, 2, 12), y: p.y + 1, z: p.z + ri(r, 2, 12) };
      const blocked = seed % 2 === 1; // balanced yes/no by construction — few seeds, no coin luck
      if (blocked) {
        const ob = { x: box.x + ri(r, 0, 4), y: box.y + ri(r, 0, 2), z: box.z + ri(r, 0, 4) };
        await call("set_blocks", { blocks: [{ ...ob, block: "minecraft:cobblestone" }] });
      }
      // A decoy just outside the box, so "read carefully" beats "saw a block nearby".
      await call("set_blocks", { blocks: [{ x: box.x + 6, y: box.y, z: box.z + 6, block: "minecraft:cobblestone" }] });
      return {
        prompt: `Is the box from (${box.x}, ${box.y}, ${box.z}) to (${box.x + 4}, ${box.y + 2}, ${box.z + 4}) inclusive entirely air? Answer yes or no.`,
        answer_type: "bool", truth: !blocked, forceloaded: p.area,
      };
    },
  },
  {
    rung: 3, id: "t3_conflicts", maxTurns: 64, // circuit breaker, never a budget (A5)
    async gen(seed, r) {
      const p = await stagePad(seed, 2);
      const base = { x: p.x + 4, y: p.y + 1, z: p.z + 4 };
      const n = ri(r, 3, 6);
      const cols = new Set();
      let truth = 0;
      const blocks = [];
      while (cols.size < n) {
        const cx = ri(r, 0, 8), cz = ri(r, 0, 8);
        if (cols.has(`${cx},${cz}`)) continue;
        cols.add(`${cx},${cz}`);
        const h = ri(r, 1, 3);
        truth += h; // pillars are ≤3 tall, so every pillar block sits inside the y..y+2 box
        for (let y = 0; y < h; y++) {
          blocks.push({ x: base.x + cx, y: base.y + y, z: base.z + cz, block: "minecraft:andesite" });
        }
      }
      await call("set_blocks", { blocks });
      return {
        prompt: `A 9x3x9 structure would occupy (${base.x}, ${base.y}, ${base.z}) to (${base.x + 8}, ${base.y + 2}, ${base.z + 8}) inclusive. Exactly how many non-air blocks currently intrude into that box?`,
        answer_type: "numeric", tolerance: 0, truth, forceloaded: p.area,
      };
    },
  },
  {
    rung: 4, id: "t4_reach", maxTurns: 64, // circuit breaker, never a budget (A5)
    async gen(seed, r) {
      const { p, S, sealed } = await stagePen(seed, r);
      const from = { x: p.x - 4, y: p.y + 1, z: p.z - 4 };
      const to = { x: p.x + Math.floor(S / 2), y: p.y + 1, z: p.z + Math.floor(S / 2) };
      // max_length explicit: the default cap truncates the legitimate ~40-block walk-around and
      // answers reachable:false partial:true (footgun noted in TODO — arguably that should be
      // null). The agent arms hit the same default; noticing `partial` is part of the task.
      const live = await call("check_path", { from, to, max_length: 128 });
      if (live.reachable !== !sealed) {
        throw new Error(`t4 invariant: staged sealed=${sealed} but pathfinder says reachable=${live.reachable}`);
      }
      return {
        prompt: `A walled stone-brick pen stands near (${p.x}, ${p.y + 1}, ${p.z}). Standing at (${from.x}, ${from.y}, ${from.z}), can a villager-sized walker reach (${to.x}, ${to.y}, ${to.z}) without breaking any blocks? Answer yes or no.`,
        answer_type: "bool", truth: !sealed, forceloaded: p.area,
      };
    },
  },
  {
    rung: 5, id: "t5_heights", maxTurns: 64, // circuit breaker, never a budget (A5)
    async gen(seed) {
      const w = wildAt(seed);
      await ensureGenerated(w.x, w.z, w.x + 15, w.z + 15);
      const site = await call("check_site", { at: { x: w.x, z: w.z }, size: { w: 16, d: 16 } });
      if (site.coverage?.state !== "complete") throw new Error("t5: site read incomplete after ensureGenerated");
      return {
        prompt: `Consider the natural terrain square from (${w.x}, ${w.z}) to (${w.x + 15}, ${w.z + 15}) (x,z; all 256 columns). Surface height of a column = the y of its topmost motion-blocking block, ignoring leaves (water counts as surface). What are the minimum and maximum surface heights in that square? Reply as: ANSWER: <min> <max>`,
        answer_type: "pair", truth: [site.ground_y.min, site.ground_y.max],
        forceloaded: [w.x, w.z, w.x + 15, w.z + 15],
      };
    },
  },
  {
    rung: 6, id: "t6_cutfill", maxTurns: 64, // circuit breaker, never a budget (A5)
    async gen(seed) {
      const cands = [0, 1, 2].map((k) => wildAt(seed, 3 + k));
      const stats = [];
      for (const c of cands) {
        await ensureGenerated(c.x, c.z, c.x + 15, c.z + 15);
        const targetY = null; // filled below from the site's own mean
        stats.push({ c, targetY });
      }
      const lines = [];
      let best = -1, bestWork = Infinity;
      for (let i = 0; i < 3; i++) {
        const { c } = stats[i];
        const probe = await call("check_site", { at: { x: c.x, z: c.z }, size: { w: 16, d: 16 } });
        const ty = Math.round(probe.ground_y.mean);
        const site = await call("check_site", { at: { x: c.x, z: c.z }, size: { w: 16, d: 16 }, y: ty });
        const work = site.cut + site.fill;
        if (work < bestWork) { bestWork = work; best = i + 1; }
        stats[i].work = work;
        lines.push(`Site ${i + 1}: the 16x16 square from (${c.x}, ${c.z}) to (${c.x + 15}, ${c.z + 15}), to be levelled at y=${ty}.`);
      }
      const works = stats.map((s) => s.work).sort((a, b) => a - b);
      if (works[1] - works[0] < 40) throw new Error(`t6 seed ${seed}: sites too close to call (${works[0]} vs ${works[1]}) — reseed`);
      return {
        prompt: `Three candidate building sites on natural terrain:\n${lines.join("\n")}\nTerrain work for a site = total blocks to remove above its target y plus total blocks to add below it, over all 256 columns (ignore leaves). Which site needs the LEAST terrain work? Answer 1, 2, or 3.`,
        answer_type: "numeric", tolerance: 0, truth: best,
        forceloaded: cands.map((c) => [c.x, c.z, c.x + 15, c.z + 15]),
      };
    },
  },
  {
    rung: 7, id: "t7_watertiles", maxTurns: 64, // circuit breaker, never a budget (A5)
    async gen(seed) {
      const w = wildAt(seed, 7);
      const c = { x: w.x, z: w.z };
      const half = 96; // 3×3 tiles of 64×64
      await ensureGenerated(c.x - half, c.z - half, c.x + half - 1, c.z + half - 1);
      const region = await call("get_region_summary", { center: c, tiles: 3, tile_chunks: 4 });
      const unread = region.tiles.filter((t) => t.state !== "complete").length;
      if (unread) throw new Error(`t7: ${unread} tiles not complete after ensureGenerated`);
      // Truth at FULL resolution via check_site (16 sub-squares per tile) — the rollup's stride-4
      // sample may miss a sliver of water, and an answer key must not depend on sampling luck.
      const truth = (await Promise.all(region.tiles.map(async (t) => {
        for (let sx = 0; sx < 4; sx++) {
          for (let sz = 0; sz < 4; sz++) {
            const s = await call("check_site", {
              at: { x: t.blocks.min_x + sx * 16, z: t.blocks.min_z + sz * 16 }, size: { w: 16, d: 16 },
            });
            if (s.fluids.water_columns > 0) return 1;
          }
        }
        return 0;
      }))).reduce((a, b) => a + b, 0);
      return {
        prompt: `Divide the 192x192 natural-terrain area centred on (${c.x}, ${c.z}) into a 3x3 grid of 64x64 tiles. In how many of the 9 tiles does at least one surface column top out in water?`,
        answer_type: "numeric", tolerance: 0, truth,
        forceloaded: [c.x - half, c.z - half, c.x + half - 1, c.z + half - 1],
      };
    },
  },
  {
    rung: 8, id: "t8_sitesearch", maxTurns: 64, // circuit breaker, never a budget (A5)
    async gen(seed) {
      // Argmin task, not a threshold task: "flattest water-free tile" always has an answer
      // wherever ≥3 dry tiles exist, while any fixed stddev cutoff makes solvability a biome
      // lottery (NO_LEAVES heightmaps still count tree TRUNKS — forest tiles never read flat).
      // Scan deterministic candidate regions until one has enough dry tiles and a clear winner;
      // candidate 0 is t7's region, which is ALREADY generated — worldgen is the expensive part
      // of this template, and the watchdog crash taught us to treat it as a budget.
      const half = 96;
      let c = null, region = null;
      // Stride ~1.8km per later attempt: big enough to escape an ocean or a single rough biome.
      for (let attempt = 0; attempt < 12; attempt++) {
        const w = attempt === 0 ? wildAt(seed, 7) : wildAt(seed, 9 + attempt * 7);
        const cand = { x: w.x, z: w.z };
        await ensureGenerated(cand.x - half, cand.z - half, cand.x + half - 1, cand.z + half - 1);
        const r2 = await call("get_region_summary", { center: cand, tiles: 3, tile_chunks: 4 });
        const dry = r2.tiles.filter((t) => t.state === "complete" && (t.fluids?.water ?? 0) === 0);
        if (dry.length >= 3) { c = cand; region = r2; break; }
        await releaseArea(cand.x - half, cand.z - half, cand.x + half - 1, cand.z + half - 1);
      }
      if (!c) throw new Error(`t8 seed ${seed}: no region with 3+ dry tiles in 12 candidates`);
      const centre = (t) => [
        t.blocks.min_x + Math.floor(t.blocks.size / 2),
        t.blocks.min_z + Math.floor(t.blocks.size / 2),
      ];
      const dry = region.tiles.filter((t) => t.state === "complete" && (t.fluids?.water ?? 0) === 0);
      const minStd = Math.min(...dry.map((t) => t.height.stddev));
      // Ties (and stride-4 sampling noise vs a full-resolution derivation) within 0.3 of the
      // minimum are all correct answers — a boundary disagreement must not score a defensible
      // answer wrong.
      const acceptable = dry.filter((t) => t.height.stddev <= minStd + 0.3);
      return {
        prompt: `Divide the 192x192 natural-terrain area centred on (${c.x}, ${c.z}) into a 3x3 grid of 64x64 tiles. Among the tiles with NO surface water columns, find the one whose ground surface varies LEAST (smallest spread of column surface heights, ignoring leaves). Reply with that tile's centre coordinates as: ANSWER: <x> <z>`,
        answer_type: "pair_oneof",
        truth: acceptable.map(centre),
        forceloaded: [c.x - half, c.z - half, c.x + half - 1, c.z + half - 1],
      };
    },
  },
  {
    // find_site's own opening question: "WHERE does a footprint fit?" The with-arm's natural
    // solve is ONE find_site call (near/size/radius covering the stated domain, stride:1 for an
    // exact scan — the tool description literally says "1 = exhaustive"); the without-arm has no
    // find_site/check_site/check_fit and must pull raw heights (get_surface) and do the window
    // search — the modal-target-y/cut/fill arithmetic — itself, by hand. That contrast is exactly
    // the "find_site-vs-get_surface-loop token delta" TODO.md's spatial-inversion follow-up asks for.
    //
    // REVISION (live cross-check, 2026-07-23): the first version of this rung used wild terrain and
    // asked for the true minimum cut+fill. Live-staged against find_site for seeds 1-3, the answer
    // came back 0 for all three — a 15x15 wild patch essentially always contains a perfectly flat
    // 3x3 corner, so the "minimum" was a constant both arms could reach by guessing. Fixed by
    // staging a deterministic, never-flat terrain feature instead (truth known BY CONSTRUCTION, the
    // same convention rungs 1-4 already use) rather than trusting wild terrain to be interesting.
    //
    // Tie-proofing: PredicateTools.findSite picks each window's target y via a java.util.HashMap's
    // max-by-count (iteration order is hash-bucket order, not insertion order); this rung's own JS
    // replication iterates a Map in insertion order. On a TIED histogram the two could legitimately
    // disagree at tolerance 0 — a live cross-check is what caught this. Rather than hope no seed
    // ever produces a tie, the terrain is built to make ties IMPOSSIBLE: a 1-D alternating
    // (period-2) step pattern along x, constant along z. Any 3 consecutive integers span exactly 2
    // distinct floor(x/2) buckets (a span-3 window can't fit inside a width-2 bucket), and those 2
    // buckets are always consecutive integers, hence always opposite parity under `% 2` — so every
    // 3-wide x-window sees EXACTLY 2 distinct heights, split 2-1 (never 1.5-1.5 — 3 is odd). Times
    // 3 z-rows, every 3x3 window's height histogram is a 6-vs-3 split: a strict, tie-free majority,
    // regardless of which map/hash implementation reads it back. It also makes every window's
    // terrain work the same nonzero constant (3 minority columns x `jump`), which is weaker
    // "search" flavour than a varied landscape but is provably never the trivial-zero bug above.
    // The pattern is painted across the WHOLE pad floor (not just the asked-about sub-window) so an
    // agent whose find_site radius overshoots the stated domain still lands on the same terrain
    // instead of escaping onto trivially-flatter ground just outside it.
    rung: 9, id: "t9_findsite", maxTurns: 64, // circuit breaker, never a budget (A5)
    async gen(seed, r) {
      const p = await stagePad(seed, 3);
      // Declared question domain: a sub-window well clear of the pad's edges (matching the "well
      // clear of it" convention every other staged template follows). Relative dx/dz throughout, so
      // the profile helpers stay pure and offline-testable.
      const W = 3, D = 3, minDx = 4, maxDx = 19;
      const amp = t9Profile(r, { span: 24, minDx, maxDx });
      const heightAt = (x) => t9HeightAt(amp, x - p.x);

      const blocks = [];
      for (let x = p.x; x <= p.x + 23; x++) {
        const extra = heightAt(x);
        if (extra === 0) continue;
        for (let z = p.z; z <= p.z + 23; z++) {
          for (let dy = 1; dy <= extra; dy++) blocks.push({ x, y: p.y + dy, z, block: "minecraft:andesite" });
        }
      }
      await call("set_blocks", { blocks });

      const minX = p.x + minDx, minZ = p.z + minDx, maxX = p.x + maxDx, maxZ = p.z + maxDx;
      const anchorMaxX = maxX - W + 1, anchorMaxZ = maxZ - D + 1;

      // Truth by construction, replicating find_site's own modal-target-y + cut/fill definition.
      const best = t9MinWork(amp, minDx, maxDx, W, D);
      // Invariant 1: no window may have a tied modal height (the answer key must not depend on
      // whether the reader iterates a HashMap or a Map).
      if (!t9EveryWindowHasStrictMode(amp, minDx, maxDx, W, D)) {
        throw new Error(`t9 invariant: seed ${seed} produced a window with a tied modal height`);
      }
      // Invariant 2: the ANTI-LEAK check. The prompt states the terrain's y-range, which reveals the
      // LARGEST amplitude. If the minimum work equalled 3 x that largest amplitude, the answer would
      // again be derivable from the prompt with no world read — the exact defect this rung had.
      const maxAmp = Math.max(...t9OddBuckets(minDx, maxDx).map((b) => amp[b]));
      if (best >= D * maxAmp) {
        throw new Error(`t9 invariant: seed ${seed} min work ${best} is derivable from the stated y-range (${D} x ${maxAmp})`);
      }

      return {
        prompt: `A stepped stone terrain feature sits from (${minX}, ${p.y}, ${minZ}) to (${maxX}, ${p.y + maxAmp}, ${maxZ}) — ground height rises and falls in steps of DIFFERING heights as x increases (constant along z; every column is stone, no water/lava anywhere here). Find where a ${W}x${D}-column building footprint fits with the least terrain work, considering every integer anchor position (x, z) — the footprint's min corner — with x from ${minX} to ${anchorMaxX} inclusive and z from ${minZ} to ${anchorMaxZ} inclusive (so the whole footprint's ${W}x${D} columns stay inside x ${minX}-${maxX}, z ${minZ}-${maxZ}). For a candidate anchor, its target y = the modal (most common) ground height under its own footprint; terrain work = total blocks above target y that would need removing, plus total blocks below target y that would need filling, summed over the ${W * D} columns. What is the MINIMUM possible terrain work over all valid anchors? Reply as: ANSWER: <number>`,
        answer_type: "numeric", tolerance: 0, truth: best,
        forceloaded: p.area,
      };
    },
  },
  // --- multi-referent rungs (r10, r11) ----------------------------------------------------------
  // These exist to test one methodological claim: a representation tool's value is holding SEVERAL
  // referents at once, so a single-target rung can't tell a real win from a substitutable read. r1
  // (one point → get_blocks_at) and r2 (one box → describe_box) both scored Δ≈0 in the --loo — but the
  // tool was only ever asked for ONE referent. r10/r11 are the same questions at 5 points / 4 boxes:
  // the SAME tool, now the natural batch/repeat instrument, so its single-vs-multi Δ is comparable.
  // If get_blocks_at/describe_box are truly substitutable the Δ stays ~0; if their value was referent
  // count, it appears here. Run paired: `run-tasks.mjs --loo get_blocks_at,describe_box --rungs 1-2,10-11`
  // (well, --rungs spans; use two runs) at reps ≥3 so a single-rung swing can't fake the result.
  {
    rung: 10, id: "t10_multipoint", maxTurns: 64, // circuit breaker, never a budget (A5)
    async gen(seed, r) {
      // Slot 7, NOT 3: t9 stages its stepped terrain on slot 3, and stagePad's air-clear would
      // wipe it after t9's truth is computed — co-running rungs 9+10 corrupted t9 (found while
      // preparing the first full-ladder run, 2026-07-25).
      const p = await stagePad(seed, 7);
      // 5 scattered points, each a marker block; a controlled number are the TARGET (guaranteed 1..5,
      // so "0" can't be confused with "couldn't read"). The question forces holding all 5 at once.
      const target = "minecraft:diamond_block";
      const others = MARKERS.filter((m) => m !== target);
      const k = ri(r, 1, 5); // how many are the target
      const isTarget = Array.from({ length: 5 }, (_, i) => i < k).sort(() => r() - 0.5);
      const pts = [];
      const used = new Set();
      for (let i = 0; i < 5; i++) {
        let at;
        do { at = { x: p.x + ri(r, 2, 21), y: p.y + 1, z: p.z + ri(r, 2, 21) }; } while (used.has(`${at.x},${at.z}`));
        used.add(`${at.x},${at.z}`);
        const block = isTarget[i] ? target : pick(r, others);
        await call("set_blocks", { blocks: [{ ...at, block }] });
        pts.push(at);
      }
      const list = pts.map((q, i) => `P${i + 1} (${q.x}, ${q.y}, ${q.z})`).join(", ");
      return {
        prompt: `Consider these 5 positions: ${list}. How many of them contain a ${target.replace("minecraft:", "")}?`,
        answer_type: "numeric", tolerance: 0, truth: k, forceloaded: p.area,
      };
    },
  },
  {
    rung: 11, id: "t11_multibox", maxTurns: 64, // circuit breaker, never a budget (A5)
    async gen(seed, r) {
      const p = await stagePad(seed, 4);
      // 4 non-overlapping 3×3×3 boxes; a controlled number are entirely air (guaranteed 1..4). Each
      // blocked box gets ONE intruder; every box gets a decoy just outside (read carefully beats
      // "saw a block nearby"). Truth = count of clear boxes.
      const corners = [
        { x: p.x + 2, z: p.z + 2 }, { x: p.x + 14, z: p.z + 2 },
        { x: p.x + 2, z: p.z + 14 }, { x: p.x + 14, z: p.z + 14 },
      ];
      const nClear = ri(r, 1, 4);
      const clear = Array.from({ length: 4 }, (_, i) => i < nClear).sort(() => r() - 0.5);
      const boxes = [];
      for (let i = 0; i < 4; i++) {
        const b = { x: corners[i].x, y: p.y + 1, z: corners[i].z };
        if (!clear[i]) {
          const ob = { x: b.x + ri(r, 0, 2), y: b.y + ri(r, 0, 2), z: b.z + ri(r, 0, 2) };
          await call("set_blocks", { blocks: [{ ...ob, block: "minecraft:cobblestone" }] });
        }
        // decoy one block outside the box's max corner
        await call("set_blocks", { blocks: [{ x: b.x + 3, y: b.y, z: b.z + 3, block: "minecraft:cobblestone" }] });
        boxes.push(b);
      }
      const list = boxes.map((b, i) => `B${i + 1} (${b.x}, ${b.y}, ${b.z})–(${b.x + 2}, ${b.y + 2}, ${b.z + 2})`).join(", ");
      return {
        prompt: `Consider these 4 boxes (inclusive): ${list}. How many of them are entirely air?`,
        answer_type: "numeric", tolerance: 0, truth: nClear, forceloaded: p.area,
      };
    },
  },
  // r12/r13 close the bench's SEMANTIC and RELATIONAL discipline gaps (DISCIPLINE_INDEX.md): every
  // earlier rung reads geometry or counts; none makes identity/purpose or connectivity-between-
  // entities load-bearing. Both stay in this ladder on purpose — they inherit the with/without/LOO
  // ablation and the fresh-session harness for free.
  {
    rung: 12, id: "t12_machineroom", maxTurns: 64, // circuit breaker, never a budget (A5)
    async gen(seed, r) {
      // Slot 8, NOT 5: padAt slot 5's z-band (-700) is EXACTLY penAt's — staging here shaves the
      // t4 pen's north wall, flipping a sealed pen's truth (the alias flagged in TODO.md; fixed
      // when the first full-ladder run made it live, 2026-07-25).
      const p = await stagePad(seed, 8);
      // A row of 5 workstations; the question asks for the machine BY PURPOSE, so the agent must
      // read which stations exist (perceptual) and map purpose → identity (semantic).
      //
      // THE LEAK THIS FIXES: the old version always staged the canonical best answer, and every
      // question's answer was a fact about Minecraft rather than about the world ("smelts fastest"
      // → blast_furnace). The five staged blocks could not change the answer, so the rung was
      // answerable CLOSED-BOOK with zero world reads — it scored 100%/12 and supplied 71% of the
      // bench's `semantic` rows, meaning the whole semantic claim rested on a question that needed
      // no world.
      //
      // THE FIX: every question now carries a RANKED answer list, and on half the seeds the top
      // choice is withheld from the row, so the correct answer becomes the best machine ACTUALLY
      // PRESENT. A model answering from prior knowledge alone is now wrong half the time; only
      // reading the row gets it right. `ban` removes any other station that would also satisfy the
      // question (a crafting table repairs tools by combining two damaged ones, so it cannot sit in
      // the row for the repair question), keeping exactly one defensible answer.
      const QS = [
        { q: "Which machine here smelts raw iron ore the fastest?", ranked: ["minecraft:blast_furnace", "minecraft:furnace"], ban: [] },
        { q: "Which machine here cooks raw food the fastest?", ranked: ["minecraft:smoker", "minecraft:furnace"], ban: [] },
        { q: "Which machine here can cut a stone block into stairs and slabs?", ranked: ["minecraft:stonecutter", "minecraft:crafting_table"], ban: [] },
        { q: "Which machine here can apply a pattern to a banner?", ranked: ["minecraft:loom", "minecraft:crafting_table"], ban: [] },
        { q: "Which machine here can repair a damaged iron pickaxe?", ranked: ["minecraft:anvil", "minecraft:grindstone"], ban: ["minecraft:crafting_table"] },
      ];
      const POOL = [
        "minecraft:furnace", "minecraft:blast_furnace", "minecraft:smoker", "minecraft:brewing_stand",
        "minecraft:smithing_table", "minecraft:anvil", "minecraft:crafting_table", "minecraft:grindstone",
        "minecraft:loom", "minecraft:cartography_table", "minecraft:fletching_table", "minecraft:stonecutter",
      ];
      const pickQ = QS[ri(r, 0, QS.length - 1)];
      // Seed-mixed so consecutive seeds cannot share the drop decision (the same guard r16 uses).
      const dropTop = ((seed + ri(r, 0, 1)) % 2) === 0;
      const answer = pickQ.ranked[dropTop ? 1 : 0];
      // Fillers exclude BOTH ranked entries (so the withheld top never sneaks back in as a
      // distractor) plus anything on the ban list.
      const banned = new Set([...pickQ.ranked, ...pickQ.ban]);
      const stations = [answer];
      const rest = POOL.filter((b) => !banned.has(b));
      while (stations.length < 5) {
        const b = pick(r, rest);
        if (!stations.includes(b)) stations.push(b);
      }
      stations.sort(() => r() - 0.5);
      const row = stations.map((block, i) => ({ x: p.x + 4 + i * 3, y: p.y + 1, z: p.z + 8, block }));
      await call("set_blocks", { blocks: row });
      // Answer-key self-check: every station must actually stand (anvil etc. must not have popped off).
      for (const s of row) {
        const got = await call("get_blocks_at", { blocks: [{ x: s.x, y: s.y, z: s.z }] });
        const id = got.palette[got.blocks[0][3]] ?? "";
        if (!id.startsWith(s.block)) throw new Error(`t12 invariant: staged ${s.block} at (${s.x},${s.y},${s.z}) but world has ${id}`);
      }
      // Answer-key self-check: the withheld top choice must genuinely be ABSENT, or a "closed-book"
      // answer would still score and the fix would be silently inert.
      if (dropTop && stations.includes(pickQ.ranked[0])) {
        throw new Error(`t12 invariant: seed ${seed} withheld ${pickQ.ranked[0]} but staged it anyway`);
      }
      return {
        prompt: `A row of 5 workstations stands at y=${p.y + 1}, z=${p.z + 8}, x from ${row[0].x} to ` +
          `${row[4].x} (every 3 blocks). ${pickQ.q} Answer with the exact block id of one of the ` +
          `machines actually present in that row.`,
        answer_type: "block_id", truth: answer, forceloaded: p.area,
      };
    },
  },
  {
    rung: 13, id: "t13_hopperchain", maxTurns: 64, // circuit breaker, never a budget (A5)
    async gen(seed, r) {
      const p = await stagePad(seed, 6);
      // A hopper line with a TURN: two straight hoppers, then two turning toward one of two chests
      // (seed-parity balanced). A decoy hopper points at the WRONG chest but is fed by nothing.
      // Truth is by construction (hoppers push along `facing`); the self-check below re-reads every
      // facing from the live world so a silent blockstate-staging failure can't corrupt the key.
      const y = p.y + 1, z0 = p.z + 10, x0 = p.x + 4;
      const south = seed % 2 === 0; // which way the line really turns
      const dz = south ? 1 : -1, dirName = south ? "south" : "north";
      const chestHit = { x: x0 + 2, y, z: z0 + 3 * dz };  // fed chest
      // FOUR chests, answered by COORDINATES. The old version listed two chests and asked "A or B",
      // a 50% guess floor on a rung that scored 100% at n=12 — indistinguishable from coin-flipping.
      // Decoy 1 is fed by the decoy hopper (which nothing feeds upstream), so "a chest with a hopper
      // pointing at it" is still wrong; decoys 2-3 stand alone. None may sit where the line ends.
      const decoys = [
        { x: x0 + 2, y, z: z0 - 3 * dz },
        { x: x0 - 3, y, z: z0 + 3 * dz },
        { x: x0 + 6, y, z: z0 - dz },
      ];
      const hoppers = [
        { x: x0, y, z: z0, block: "minecraft:hopper[facing=east]" },
        { x: x0 + 1, y, z: z0, block: "minecraft:hopper[facing=east]" },
        { x: x0 + 2, y, z: z0, block: `minecraft:hopper[facing=${dirName}]` },
        { x: x0 + 2, y, z: z0 + dz, block: `minecraft:hopper[facing=${dirName}]` },
        { x: x0 + 2, y, z: z0 + 2 * dz, block: `minecraft:hopper[facing=${dirName}]` },
        // decoy: aimed at the miss chest, connected to nothing
        { x: x0 + 1, y, z: z0 - 3 * dz, block: "minecraft:hopper[facing=east]" },
      ];
      const chests = [chestHit, ...decoys];
      for (const d of decoys) { // no decoy may stand where the line actually ends
        if (d.x === chestHit.x && d.z === chestHit.z) {
          throw new Error(`t13 invariant: decoy chest collides with the fed chest at (${d.x},${d.z})`);
        }
      }
      await call("set_blocks", { blocks: [
        ...hoppers,
        ...chests.map((c) => ({ ...c, block: "minecraft:chest" })),
      ] });
      for (const h of hoppers) { // facing self-check against the live world
        const got = await call("get_blocks_at", { blocks: [{ x: h.x, y: h.y, z: h.z }] });
        const id = got.palette[got.blocks[0][3]] ?? "";
        const want = /facing=(\w+)/.exec(h.block)[1];
        if (!id.includes(`facing=${want}`)) throw new Error(`t13 invariant: hopper at (${h.x},${h.y},${h.z}) staged facing=${want} but world has ${id}`);
      }
      // Listed in seeded order so the fed chest's position in the list carries no signal.
      const listed = [...chests].sort(() => r() - 0.5);
      return {
        prompt: `A line of hoppers starts at the hopper at (${x0}, ${y}, ${z0}). Four chests stand nearby, at ` +
          `${listed.map((c) => `(${c.x}, ${c.y}, ${c.z})`).join(", ")}. ` +
          `An item dropped into the STARTING hopper is carried along the hopper line and ends up in exactly one of them. ` +
          `Give that chest's coordinates. Reply as: ANSWER: <x> <y> <z>`,
        answer_type: "xyz_oneof", truth: [[chestHit.x, chestHit.y, chestHit.z]], forceloaded: p.area,
      };
    },
  },
  // r14-r16 are the RELATIONAL-SEARCH rungs (PATTERN_SEARCH_DESIGN.md §Bench): configurations of
  // blocks/entities where the answer is a relation instance, not a property of one referent. The
  // with-arm's natural solve is one locate `pattern` call; the ablation arm (`--loo locate`) must
  // assemble the same join from raw reads (get_entities + get_blocks_at neighborhoods) model-side —
  // the exact cross-domain join the perception design says models fail at. Truths by construction,
  // with face-vs-corner decoys so sloppy adjacency loses. Pad slots 10-12 (slots 5-6 are taken by
  // r12/r13, and the pen at z-700 aliases slot 5 — see the staging note in the run report).
  {
    rung: 14, id: "t14_markerpair", maxTurns: 64, // circuit breaker, never a budget (A5)
    async gen(seed, r) {
      const p = await stagePad(seed, 10);
      const y = p.y + 1;
      const cells = [];
      const clearAt = (x, z, minD) =>
        cells.every((c) => Math.max(Math.abs(c.x - x), Math.abs(c.z - z)) >= minD);
      const place = (minD) => {
        for (let guard = 0; guard < 800; guard++) {
          const x = p.x + ri(r, 2, 20), z = p.z + ri(r, 2, 20);
          if (clearAt(x, z, minD)) { cells.push({ x, z }); return { x, z }; }
        }
        throw new Error("t14: could not scatter markers");
      };
      // One true face-adjacent pair; one DIAGONAL decoy pair (corner contact only); four singles.
      const a = place(4);
      const b = { x: a.x + 1, z: a.z };
      cells.push(b);
      const d1 = place(4);
      const d2 = { x: d1.x + 1, z: d1.z + 1 };
      cells.push(d2);
      for (let i = 0; i < 4; i++) place(3);
      await call("set_blocks", { blocks: cells.map((c) => ({ x: c.x, y, z: c.z, block: "minecraft:gold_block" })) });
      return {
        prompt: `Gold blocks are scattered at y=${y} within the area x ${p.x}..${p.x + 23}, z ${p.z}..${p.z + 23}. ` +
          `Exactly one PAIR of gold blocks touches face-to-face (sharing a full face — corner or edge contact does not count). ` +
          `Give the coordinates of either gold block of that pair. Reply as: ANSWER: <x> <y> <z>`,
        answer_type: "xyz_oneof", truth: [[a.x, y, a.z], [b.x, y, b.z]], forceloaded: p.area,
      };
    },
  },
  {
    rung: 15, id: "t15_entityon", maxTurns: 64, // circuit breaker, never a budget (A5)
    async gen(seed, r) {
      const p = await stagePad(seed, 11);
      const y = p.y + 1;
      const cells = [];
      const place = (minD) => {
        for (let guard = 0; guard < 800; guard++) {
          const x = p.x + ri(r, 2, 20), z = p.z + ri(r, 2, 20);
          if (cells.every((c) => Math.max(Math.abs(c.x - x), Math.abs(c.z - z)) >= minD)) {
            cells.push({ x, z });
            return { x, z };
          }
        }
        throw new Error("t15: could not scatter markers");
      };
      const golds = Array.from({ length: 5 }, () => place(4));
      const target = golds[ri(r, 0, 4)];
      const beside = golds.find((g) => g !== target);
      await call("set_blocks", { blocks: golds.map((g) => ({ x: g.x, y, z: g.z, block: "minecraft:gold_block" })) });
      // Idempotent staging: a rerun on the same pad must not accumulate mobs. One kill is NOT
      // enough — a prior run's zombies ride the chunk save and their entity data loads a tick or
      // more AFTER loadRect, so an immediate kill matches nothing (the dry run caught exactly
      // this). Kill-and-verify: get_entities stages entity data in and waits for it, so a
      // complete 0 means the pad is genuinely clean.
      const box = `x=${p.x - 8},y=${p.y - 2},z=${p.z - 8},dx=40,dy=16,dz=40`;
      for (let i = 0; ; i++) {
        await cmd(`kill @e[type=minecraft:zombie,${box}]`).catch(() => {});
        const left = await call("get_entities", { origin: { x: p.x + 12, y, z: p.z + 12 }, radius: 32, type: "minecraft:zombie" });
        if ((left.total ?? -1) === 0 && left.coverage?.state === "complete") break;
        if (i >= 20) throw new Error(`t15: pad not clear of zombies after ${i} kill passes (${left.total})`);
        await new Promise((res) => setTimeout(res, 500));
      }
      const NBT = "{NoAI:1b,PersistenceRequired:1b,Invulnerable:1b}";
      // One zombie ON the target gold (feet cell = gold+1); one on the pad BESIDE another gold —
      // the decoy that separates "standing on" from "standing near".
      await cmd(`summon minecraft:zombie ${target.x + 0.5} ${y + 1} ${target.z + 0.5} ${NBT}`);
      await cmd(`summon minecraft:zombie ${beside.x + 1.5} ${y} ${beside.z + 0.5} ${NBT}`);
      // Answer-key self-check against the live world: exactly two zombies, one with feet on the target.
      const ents = await call("get_entities", { origin: { x: p.x + 12, y, z: p.z + 12 }, radius: 32, type: "minecraft:zombie" });
      const feet = (e) => ({ x: Math.floor(e.pos.x), y: Math.floor(e.pos.y), z: Math.floor(e.pos.z) });
      const onTarget = (ents.entities ?? []).filter((e) => {
        const f = feet(e);
        return f.x === target.x && f.y === y + 1 && f.z === target.z;
      });
      if ((ents.entities ?? []).length !== 2 || onTarget.length !== 1) {
        throw new Error(`t15 invariant: staged 2 zombies (1 on target) but world has ${JSON.stringify((ents.entities ?? []).map(feet))}`);
      }
      return {
        prompt: `Five gold blocks stand at y=${y} within the area x ${p.x}..${p.x + 23}, z ${p.z}..${p.z + 23}. ` +
          `Exactly one of them has a mob standing directly ON TOP of it (feet on the block's upper face — standing beside it does not count). ` +
          `Give that gold block's coordinates. Reply as: ANSWER: <x> <y> <z>`,
        answer_type: "xyz_oneof", truth: [[target.x, y, target.z]], forceloaded: p.area,
      };
    },
  },
  {
    rung: 16, id: "t16_relcount", maxTurns: 64, // circuit breaker, never a budget (A5)
    async gen(seed, r) {
      const p = await stagePad(seed, 12);
      const y = p.y + 1;
      const cells = [];
      const place = (minD) => {
        for (let guard = 0; guard < 800; guard++) {
          const x = p.x + ri(r, 3, 19), z = p.z + ri(r, 3, 19);
          if (cells.every((c) => Math.max(Math.abs(c.x - x), Math.abs(c.z - z)) >= minD)) {
            cells.push({ x, z });
            return { x, z };
          }
        }
        throw new Error("t16: could not scatter markers");
      };
      const golds = Array.from({ length: 6 }, () => place(5));
      // Seed-mixed so consecutive seeds can't land the same truth (both seeds drew 5 from the raw
      // rng on the first dry run — a same-truth pair hands a guesser the rung).
      const k = 1 + ((seed + ri(r, 0, 3)) % 5); // how many golds HAVE a face-adjacent cobblestone
      const withCobble = golds.slice(0, k);
      const bare = golds.slice(k);
      const DIRS = [{ dx: 1, dz: 0 }, { dx: -1, dz: 0 }, { dx: 0, dz: 1 }, { dx: 0, dz: -1 }];
      const blocks = [];
      for (const g of withCobble) {
        const d = pick(r, DIRS);
        blocks.push({ x: g.x + d.dx, y, z: g.z + d.dz, block: "minecraft:cobblestone" });
      }
      // Every BARE gold gets a DIAGONAL cobblestone (corner contact only) — counting "cobble
      // nearby" instead of "cobble face-adjacent" gets every one of these wrong.
      for (const g of bare) {
        blocks.push({ x: g.x + 1, y, z: g.z + 1, block: "minecraft:cobblestone" });
      }
      await call("set_blocks", { blocks: [
        ...golds.map((g) => ({ x: g.x, y, z: g.z, block: "minecraft:gold_block" })),
        ...blocks,
      ] });
      return {
        prompt: `Six gold blocks stand at y=${y} within the area x ${p.x}..${p.x + 23}, z ${p.z}..${p.z + 23}, ` +
          `with cobblestone blocks scattered among them. A gold block "has cobblestone attached" only if a cobblestone ` +
          `shares a FULL FACE with it (diagonal/corner contact does not count). Exactly how many of the six gold blocks ` +
          `have NO cobblestone attached? Reply as: ANSWER: <number>`,
        answer_type: "numeric", tolerance: 0, truth: 6 - k, forceloaded: p.area,
      };
    },
  },
];

// pair_oneof isn't in quiz.mjs's scorer: any of the listed pairs counts, with slack sized to
// tile-grid ambiguity: the prompt says "centred on (c)" but get_region_summary snaps tiles to
// chunk boundaries (up to 15 blocks off), so a model that picked the RIGHT tile from prompt
// geometry can name a centre ~15 blocks from ours (haiku run 06-31-05 lost a correct answer to a
// ±2 slack this way). 24 covers the snap and still uniquely identifies a 64-wide tile.
export function scoreTask(q, rawAnswer, quizScore) {
  // xyz_oneof: any listed cell scores, exact integers only — a relation instance is a cell, and
  // "one block off" is a different block (r14/r15; tolerance-0 by design, unlike tile centres).
  if (q.answer_type === "xyz_oneof") {
    if (rawAnswer === null) return { correct: false, abstained: true };
    if (String(rawAnswer).trim().toLowerCase() === "unknown") return { correct: false, abstained: true };
    const ns = [...String(rawAnswer).matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => parseFloat(m[0]));
    const ok = ns.length >= 3 &&
      q.truth.some(([tx, ty, tz]) => ns[0] === tx && ns[1] === ty && ns[2] === tz);
    return { correct: ok, abstained: false };
  }
  if (q.answer_type !== "pair_oneof") return quizScore(q, rawAnswer);
  if (rawAnswer === null) return { correct: false, abstained: true };
  if (String(rawAnswer).trim().toLowerCase() === "unknown") return { correct: false, abstained: true };
  const ns = [...String(rawAnswer).matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => parseFloat(m[0]));
  const ok = ns.length >= 2 &&
    q.truth.some(([tx, tz]) => Math.abs(ns[0] - tx) <= 24 && Math.abs(ns[1] - tz) <= 24);
  return { correct: ok, abstained: false };
}
