// Category E, slice E-traverse — in-body pathfinding / obstacle course (BENCH_EXPANSION.md).
//
// The premise the predicate bench (Category T) never tests: T checks check_path's VERDICT against the
// pathfinder, but never that a real BODY can follow it. E-traverse stages a physical course A→B with
// obstacles (gap, wall+doorway, water, S-maze) and makes the drone body actually get there with
// bot_goto/bot_run. Two deliverables per course, both auto-scored from server truth (no LLM judge):
//   1. skill × cost — did the body ARRIVE, how far short, health lost to falls, turns, tokens;
//   2. predict-vs-execute — did check_path's `reachable` verdict match whether the body arrived
//      (the validity signal T structurally cannot produce).
//
// Ablation (Category-T LOO style — "is check_path a win for a MOVING body?"): both arms get the full
// nav+perception surface; the `predict` arm additionally has check_path to plan/diagnose a route
// before/while moving, the `blind` arm must react to bot_goto stopped_short from bot_status alone.
//
// Reuse vs P/E-combat (imported, not duplicated): stageArena / releaseAreaStripped / PBASE / AY from
// play-scenario.mjs; call / cmd from bridge.mjs. What's NEW: the course ladder + obstacle builders,
// and the ROOFED-CORRIDOR grounding trick (see below) that keeps the hovering flyer drone at floor
// level so terrain is an obstacle at all.
//
// GROUNDING (the one part that needs live in-game confirmation, isolated here like E-combat's
// altitude platform): the drone hovers ~16 blocks up (the documented P-survive hover), so a raw
// flyer would sail OVER every obstacle and the course would be meaningless. Fix: roof every corridor
// at AY+3 with a 2-high interior (AY+1..AY+2). A body capped under a head-height ceiling must move
// horizontally through the tube — around walls, across gaps — instead of climbing. The oracle
// check_path is queried with body:"flyer" to MATCH the executor, so predict-vs-execute compares like
// with like. Every score records body_y so the first --dry run reveals whether grounding held (feet
// near AY+1) or the drone escaped the roof (a live-tuning signal, not a silent wrong number).

import { call, cmd } from "./bridge.mjs";
import { stageArena, releaseAreaStripped, PBASE, AY } from "./play-scenario.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const dist3 = (a, b) => (a && b ? Math.hypot((a.x ?? a[0]) - b.x, (a.y ?? a[1]) - b.y, (a.z ?? a[2]) - b.z) : Infinity);
const r1 = (n) => Math.round(n * 10) / 10;

export const ARRIVE_R = 2.5; // final distance to GOAL that counts as arrival (matches bot_goto default within)
const HW = 2;                // corridor half-width in z: interior lanes cz-1..cz+1, walls at cz±2
// Roof height is BODY-dependent (0.9.2). The flyer needs a 2-high interior (roof AY+3) or it sails
// over everything — the original grounding trick. A walker is grounded by gravity, and a 2-high
// interior would make sprint-jump edges honestly unplannable (the 0.24.0 apex rule: a jump lifts the
// body into y+2, so a jump under a head-height roof is a bonk, not a route) — so its tube is 3-high
// (roof AY+4), tall enough to leap the gap course the way the body really would.
const roofDy = (body) => (body === "walker" ? 4 : 3);

// --- player-legal (or check_path-enabled) tool surfaces -----------------------------------------
// Both arms share the full nav+perception surface; the ONLY difference is check_path (the ablation
// subject). bot_goto/bot_run pathfind+walk server-side; bot_status/get_surface/scene_summary let the
// blind arm diagnose a stopped_short reactively. Validated against the live manifest in run-traverse.
const NAV_CORE = ["bot_goto", "bot_run", "bot_status", "bot_look", "get_surface", "scene_summary"];
export const TRAVERSE_TOOLS = {
  predict: [...NAV_CORE, "check_path"],
  blind: NAV_CORE,
  // The goal-loop arm: bot_target navigates AND repairs its own stopped-shorts server-side, so the
  // agent should need fewer turns than the bot_goto arms on the obstacle courses. Same diagnostic
  // reads available (bot_status/get_surface) but ideally not needed. This is the turn A/B that
  // justifies the goal loop (BOT_SURFACE_DESIGN.md §7).
  goal: ["bot_target", "bot_status", "bot_look", "get_surface", "scene_summary"],
};

// --- course ladder ------------------------------------------------------------------------------
// Data-driven so difficulty is trivial to tune. Each course runs a straight corridor from START
// (west) to GOAL (east) of length `len`; `build(g)` sculpts obstacles into the roofed tube. Every
// course is REACHABLE by construction (the answer key self-checks check_path(flyer)===reachable at
// stage time and throws otherwise — same discipline as questions.mjs's pen/sealed invariants), so a
// non-arrival is the body's failure, never an impossible course. Ladder per BENCH_EXPANSION.md.
export const COURSES = [
  { name: "flat straight",  len: 20, build: async () => {} },                 // anchor: one bot_goto arrives
  { name: "1-wide gap",     len: 22, build: (g) => buildGap(g) },             // jump a floor gap over a pit
  { name: "wall + doorway", len: 24, build: (g) => buildWall(g, +1) },        // detour to an offset opening
  { name: "water crossing", len: 24, build: (g) => buildWater(g) },          // wade a flooded span
  { name: "S-maze",         len: 30, build: (g) => buildMaze(g) },            // staggered walls force an S
];

// Geometry for one course, derived from its cell + length.
function geometryFor(cx, cz, len) {
  const ax0 = cx;                 // START x (west end)
  const gx = cx + len;            // GOAL x (east end)
  const xmid = Math.round((ax0 + gx) / 2);
  return { cx, cz, ax0, gx, xmid, y: AY };
}

// Stage the roofed tube over the whole corridor: reuse stageArena for the AY floor + cleared
// headroom, then add side walls (cz±HW) and a roof (AY+roofDy) — 2-high interior caps the flyer at
// head height; 3-high gives the walker leap headroom (see roofDy above).
async function stageCorridor(g, body) {
  const dy = roofDy(body);
  const cxc = Math.round((g.ax0 + g.gx) / 2);
  const half = Math.ceil((g.gx - g.ax0) / 2) + 4; // cover the x-extent (over-stages z harmlessly)
  const rect = await stageArena(cxc, g.cz, half);
  const x0 = g.ax0 - 2, x1 = g.gx + 2, z0 = g.cz - HW, z1 = g.cz + HW;
  // side walls (AY+1..AY+dy) and roof (AY+dy) — the interior below stays the air from stageArena
  await cmd(`fill ${x0} ${AY + 1} ${z0} ${x1} ${AY + dy} ${z0} minecraft:stone`);
  await cmd(`fill ${x0} ${AY + 1} ${z1} ${x1} ${AY + dy} ${z1} minecraft:stone`);
  await cmd(`fill ${x0} ${AY + dy} ${z0} ${x1} ${AY + dy} ${z1} minecraft:stone`);
  // west end wall behind START so the body can't wander backward out of the tube
  await cmd(`fill ${x0} ${AY + 1} ${z0} ${x0} ${AY + dy} ${z1} minecraft:stone`);
  return rect;
}

// --- obstacle builders (interior lanes are z in [cz-1 .. cz+1]) ---------------------------------
// A 1-wide floor gap at xmid over a 2-deep pit (floored at AY-3 so a fall is a survivable penalty,
// never a void death that needs cleanup). A flyer capped under the roof must cross it, not rise over.
async function buildGap(g) {
  const z0 = g.cz - 1, z1 = g.cz + 1, x = g.xmid;
  await cmd(`fill ${x} ${AY - 3} ${z0} ${x} ${AY - 3} ${z1} minecraft:stone`);      // pit floor
  await cmd(`fill ${x} ${AY - 2} ${z0} ${x} ${AY} ${z1} minecraft:air`);            // open the 1-wide gap + pit
}

// A 2-high wall across the interior at xmid with a single 1-wide doorway offset to one lane
// (doorSide: -1 → cz-1, +1 → cz+1). The body must path to the opening, not straight through.
async function buildWall(g, doorSide) {
  const z0 = g.cz - 1, z1 = g.cz + 1, x = g.xmid;
  const doorZ = g.cz + doorSide;
  await cmd(`fill ${x} ${AY + 1} ${z0} ${x} ${AY + 2} ${z1} minecraft:stone`);      // full wall
  await cmd(`fill ${x} ${AY + 1} ${doorZ} ${x} ${AY + 2} ${doorZ} minecraft:air`);  // punch the doorway
}

// A 1-deep flooded span (water at AY+1 over 3 x-cells): the body wades/swims through. Contained by
// the tube walls; the AY stone floor keeps it from draining, so no void risk.
async function buildWater(g) {
  const z0 = g.cz - 1, z1 = g.cz + 1;
  await cmd(`fill ${g.xmid - 1} ${AY + 1} ${z0} ${g.xmid + 1} ${AY + 1} ${z1} minecraft:water`);
}

// Two staggered partial walls forming an S: the first opens on cz+1, the second (two blocks east)
// opens on cz-1, so a straight goto stops short and the route needs the zig-zag.
async function buildMaze(g) {
  await buildWall({ ...g, xmid: g.xmid - 2 }, +1);
  await buildWall({ ...g, xmid: g.xmid + 2 }, -1);
}

// --- factory ------------------------------------------------------------------------------------
// One instance = one (seed, course/tier). Cells are laid out clear of P (perceive +0 / survive +2000)
// and E-combat (+4000): traverse lives at PBASE+6000, tiers spaced in x, seeds spaced in z.
export function makeTraverseCourse({ seed, tier, body = "flyer" }) {
  const course = COURSES[tier];
  const cx = PBASE.x + 6000 + tier * 200;
  const cz = PBASE.z + 6000 + seed * 200 + (body === "walker" ? 100 : 0); // walker cells offset: taller tube, own terrain
  const g = geometryFor(cx, cz, course.len);
  const START = { x: g.ax0, y: AY + 1, z: g.cz };
  const GOAL = { x: g.gx, y: AY + 1, z: g.cz };

  return {
    name: "e-traverse", seed, tier, body,
    course_name: course.name,
    arms: ["predict", "blind"],
    dronePos: START,
    goal: GOAL,
    toolsFor: (arm) => TRAVERSE_TOOLS[arm] ?? TRAVERSE_TOOLS.predict,
    maxTurns: 12,
    observeWindowMs: 4000, // let the final bot_goto settle before reading the body's resting position
    forceloaded: null,

    /** Build the roofed corridor + obstacles, then self-check the course is reachable for THIS body. */
    async setup() {
      this.forceloaded = await stageCorridor(g, body);
      await cmd("weather clear");
      await course.build(g);
      await wait(300);
      // Invariant: a staged course MUST be solvable, or a non-arrival is meaningless. Query with the
      // SAME body the executor runs (flyer probe, or the entity-free walker physique). reachable may
      // legitimately be null if the search budget is short — raise max_length rather than trusting a
      // null (the check_path contract).
      const oracle = await call("check_path", { from: START, to: GOAL, body, max_length: 512 })
        .catch((e) => ({ reachable: null, error: String(e) }));
      if (oracle.reachable !== true) {
        throw new Error(`bench invariant: course "${course.name}" (seed ${seed}) must be ${body}-reachable, ` +
          `got ${JSON.stringify(oracle)}`);
      }
      this._oracle = oracle;
    },

    prompt: (arm) =>
      arm === "goal"
        ? `You control a Minecraft body inside a roofed corridor. Travel from your current position to ` +
          `the GOAL at x=${GOAL.x}, y=${GOAL.y}, z=${GOAL.z}. Issue bot_target {action:"move", ` +
          `target:{at:{x:${GOAL.x},y:${GOAL.y},z:${GOAL.z}}}, wait:true} — the server navigates and ` +
          `handles obstacles for you, then returns whether it achieved the goal. The corridor is only ` +
          `2 blocks tall (no rising over obstacles). If it reports it stopped, read bot_status and ` +
          `issue another bot_target toward the goal. Reply "ARRIVED" once bot_status shows you at the goal.`
        : `You control a Minecraft body inside a roofed corridor. Travel from your current position to the ` +
          `GOAL at x=${GOAL.x}, y=${GOAL.y}, z=${GOAL.z}. Use bot_goto (the server pathfinds and moves your ` +
          `body toward a target); if it returns outcome "stopped_short", read bot_status to see where you ` +
          `ended up and continue toward the goal — re-goto, or step past the obstacle with bot_run waypoints. ` +
          (arm === "predict"
            ? `You may call check_path (from your position to a target) to test whether a route is ` +
              `traversable BEFORE committing to it. `
            : ``) +
          `The corridor is only 2 blocks tall, so you cannot rise over obstacles — go through/around them. ` +
          `Reply "ARRIVED" once bot_status shows your body at the goal.`,

    /** Score from server truth: arrival, falls, grounding, and the predict-vs-execute match. */
    async score(_arm) {
      const status = await call("bot_status", {}).catch(() => ({}));
      const pos = status?.pos ?? null;
      const alive = !!status.spawned && (status.health ?? 0) > 0;
      const d = dist3(pos, GOAL);
      const arrived = alive && d <= ARRIVE_R;
      // Oracle: same body type as the executor, so this is a fair verdict-vs-outcome comparison.
      const oracle = this._oracle ??
        await call("check_path", { from: START, to: GOAL, body, max_length: 512 }).catch(() => ({}));
      const predictReachable = oracle?.reachable ?? null;
      return {
        metrics: {
          tier: tier + 1, course_name: course.name, body,
          arrived, final_dist: Number.isFinite(d) ? r1(d) : null,
          alive, final_health: status.health ?? 0, health_lost: 20 - (status.health ?? 0),
          body_y: typeof pos?.y === "number" ? r1(pos.y) : null,   // grounding diagnostic (want ~AY+1)
          predict_reachable: predictReachable, predict_nodes: oracle?.nodes ?? null,
          // The validity signal Category T cannot produce: did the verdict match reality?
          predict_matched: (predictReachable === true) === arrived,
        },
        truth: { start: START, goal: GOAL, floor_y: AY, oracle_end: oracle?.end ?? null, len: course.len },
      };
    },

    async cleanup() {
      if (this.forceloaded) await releaseAreaStripped(...this.forceloaded);
    },
  };
}

export const SCENARIOS = { traverse: makeTraverseCourse };
