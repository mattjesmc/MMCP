// Category E, slice E-repair — the FAILURE-PATH ladder (FREEZE_PLAN Workstream F1).
//
// E-traverse measured the goal loop's one-call shape but its courses were mild: `repairs:0` on
// every row, so the repair loop's headline capability — server-side repair of a route that CANNOT
// be walked — was never on the scoreboard (BOT_SURFACE_DESIGN §12.1's named gap). Every rung here
// stages a corridor whose cheapest route REQUIRES work, and the A/B is the remedial-turn loop
// itself:
//
//   goal arm — bot_target with rights (may_modify/open_doors/budget): the server repairs.
//   hand arm — check_path + bot_goto + bot_mine/bot_place: the agent diagnoses and repairs BY
//              HAND, spending the turns §0 says the money is in.
//
// WALKER-ONLY, by design (F4): the body must actually be stopped by terrain. Tube interior is
// 3-high (the 0.24.0 apex rule: a jump under a 2-high roof is a bonk, not a route).
//
// Rungs (each also an honesty probe in bench form — the walker-caps contracts, priced):
//   plug_break    — 2-high full-width plug; break through (2 cells on the cheapest lane).
//   bridge_gap    — 7-wide, 4-deep trench (past jump range 5); bridge with carried cobblestone.
//   door_shut     — full-width wall with a shut oak door; goal arm opens it (open_doors default),
//                   the hand arm CANNOT (bot_use is item-centric — no bare-hand block interaction)
//                   and must mine instead. The asymmetry is real capability, measured not hidden.
//   iron_control  — iron door + lever, corridor sealed. NO arm can pull the lever (same bot_use
//                   limit), so this is a DIAGNOSIS rung: success is NAMING the control's location
//                   (both arms can learn it from the obstruction locus), not arriving.
//   budget_resume — goal arm only: a 4-break plug attacked with budget {break:2} per call — stops
//                   break_budget_spent mid-course; success = finishing on a re-issue, off the
//                   resumable ledger (§2.2's claim, priced in turns).

import { call, cmd } from "./bridge.mjs";
import { stageArena, releaseAreaStripped, PBASE, AY } from "./play-scenario.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const dist3 = (a, b) => (a && b ? Math.hypot((a.x ?? a[0]) - b.x, (a.y ?? a[1]) - b.y, (a.z ?? a[2]) - b.z) : Infinity);
const r1 = (n) => Math.round(n * 10) / 10;

export const ARRIVE_R = 2.5;
const HW = 2;        // interior lanes cz-1..cz+1, walls at cz±2
const ROOF_DY = 4;   // walker tube: 3-high interior (leap headroom under the apex rule)

// Tool surfaces. The goal arm is deliberately minimal — the thesis is that bot_target absorbs the
// remedial loop. The hand arm gets the full manual kit INCLUDING check_path (it is the
// diagnose-then-act arm, not a blind arm).
export const REPAIR_TOOLS = {
  goal: ["bot_target", "bot_status", "bot_look", "get_surface", "scene_summary"],
  hand: ["bot_goto", "bot_run", "bot_mine", "bot_place", "bot_select", "bot_status", "bot_look",
         "get_surface", "scene_summary", "check_path"],
};

// One rung = corridor of `len` plus an obstacle that REQUIRES the named work.
//   goalHint — appended to the goal arm's prompt (which rights to pass).
//   handHint — appended to the hand arm's prompt (which manual repair applies).
//   give     — item staged into the body's inventory before the session (both arms).
//   arms     — which arms this rung runs (budget_resume is goal-only).
//   diagnose — true: success is naming the control location, not arriving (iron_control).
export const RUNGS = [
  {
    key: "plug_break", len: 18, arms: ["goal", "hand"],
    goalHint: `The corridor is plugged with stone. You are PERMITTED to break blocks to get ` +
      `through: pass may_modify:"break".`,
    handHint: `The corridor is plugged with stone. Mine the blocking blocks with bot_mine ` +
      `{at:{x,y,z}} (walk into reach first with bot_goto reach), then continue.`,
    build: async (g) => {
      await cmd(`fill ${g.xmid} ${AY + 1} ${g.cz - 1} ${g.xmid} ${AY + 2} ${g.cz + 1} minecraft:stone`);
    },
  },
  {
    key: "bridge_gap", len: 20, arms: ["goal", "hand"], give: "minecraft:cobblestone",
    goalHint: `A wide trench crosses the corridor — too wide to jump. You carry cobblestone and ` +
      `are PERMITTED to bridge: pass may_modify:"place", item:"minecraft:cobblestone".`,
    handHint: `A wide trench crosses the corridor — too wide to jump. You carry cobblestone: ` +
      `bot_place blocks at floor level (y=${AY}) to bridge it, walking out onto your bridge as ` +
      `you extend it.`,
    build: async (g) => {
      // Encase FIRST, then carve — a trench over hollow ground cascades every stranding into the
      // void (the walker-caps course lesson, now bench doctrine).
      await cmd(`fill ${g.xmid - 4} ${AY - 4} ${g.cz - 2} ${g.xmid + 4} ${AY - 1} ${g.cz + 2} minecraft:stone`);
      await cmd(`fill ${g.xmid - 3} ${AY - 3} ${g.cz - 1} ${g.xmid + 3} ${AY} ${g.cz + 1} minecraft:air`);
    },
  },
  {
    key: "door_shut", len: 18, arms: ["goal", "hand"],
    goalHint: `A shut wooden door blocks the corridor. bot_target opens wooden doors en route by ` +
      `default — just issue the move.`,
    handHint: `A shut wooden door blocks the corridor. You cannot open it by hand (bot_use needs ` +
      `an item), but doors are breakable: bot_mine the door (walk into reach first).`,
    build: async (g) => {
      await cmd(`fill ${g.xmid} ${AY + 1} ${g.cz - 1} ${g.xmid} ${AY + 3} ${g.cz + 1} minecraft:stone`);
      await cmd(`setblock ${g.xmid} ${AY + 1} ${g.cz} minecraft:oak_door[facing=east,half=lower]`);
      await cmd(`setblock ${g.xmid} ${AY + 2} ${g.cz} minecraft:oak_door[facing=east,half=upper]`);
    },
  },
  {
    key: "iron_control", len: 18, arms: ["goal", "hand"], diagnose: true,
    // The diagnosis rung must keep modification OFF the table, or agents legitimately mine the
    // iron door instead of reporting its control (live-caught on the first run: the hand arm
    // mined through in 3 turns, the goal arm passed itself may_modify). The hand arm loses its
    // mine/place tools for this rung; both prompts forbid world modification.
    tools: {
      goal: REPAIR_TOOLS.goal,
      hand: REPAIR_TOOLS.hand.filter((t) => t !== "bot_mine" && t !== "bot_place" && t !== "bot_select"),
    },
    goalHint: `You are NOT permitted to modify the world on this task — never pass may_modify. ` +
      `If the goal is unreachable, report EXACTLY what blocks you and where its control is ` +
      `(the stop verdict names both).`,
    handHint: `You are NOT permitted to modify the world on this task. If the goal is ` +
      `unreachable, report EXACTLY what blocks you and where its control is (check_path's ` +
      `obstruction verdict names both).`,
    build: async (g) => {
      await cmd(`fill ${g.xmid} ${AY + 1} ${g.cz - 1} ${g.xmid} ${AY + 3} ${g.cz + 1} minecraft:stone`);
      await cmd(`setblock ${g.xmid} ${AY + 1} ${g.cz} minecraft:iron_door[facing=east,half=lower]`);
      await cmd(`setblock ${g.xmid} ${AY + 2} ${g.cz} minecraft:iron_door[facing=east,half=upper]`);
      // The control, on the start side, attached to the crossing wall — inside the locator's
      // radius-3 box around the door.
      await cmd(`setblock ${g.xmid - 1} ${AY + 2} ${g.cz + 1} minecraft:lever[face=wall,facing=west]`);
    },
    control: (g) => ({ x: g.xmid - 1, y: AY + 2, z: g.cz + 1 }),
  },
  {
    key: "budget_resume", len: 18, arms: ["goal"],
    goalHint: `The corridor is plugged 2 blocks thick. Policy: pass budget {break:2} on every ` +
      `bot_target call (never more). A call may stop with break_budget_spent — that is partial ` +
      `PROGRESS, disclosed in the ledger; re-issue the same goal (again with budget {break:2}) ` +
      `and it resumes where it stopped. Also pass may_modify:"break".`,
    handHint: null,
    build: async (g) => {
      await cmd(`fill ${g.xmid} ${AY + 1} ${g.cz - 1} ${g.xmid + 1} ${AY + 2} ${g.cz + 1} minecraft:stone`);
    },
  },
];

// Roofed 3-high tube (walker) — same shape as E-traverse's, sized for this body.
async function stageTube(g) {
  const cxc = Math.round((g.ax0 + g.gx) / 2);
  const half = Math.ceil((g.gx - g.ax0) / 2) + 4;
  const rect = await stageArena(cxc, g.cz, half);
  const x0 = g.ax0 - 2, x1 = g.gx + 2, z0 = g.cz - HW, z1 = g.cz + HW;
  await cmd(`fill ${x0} ${AY + 1} ${z0} ${x1} ${AY + ROOF_DY} ${z0} minecraft:stone`);
  await cmd(`fill ${x0} ${AY + 1} ${z1} ${x1} ${AY + ROOF_DY} ${z1} minecraft:stone`);
  await cmd(`fill ${x0} ${AY + ROOF_DY} ${z0} ${x1} ${AY + ROOF_DY} ${z1} minecraft:stone`);
  await cmd(`fill ${x0} ${AY + 1} ${z0} ${x0} ${AY + ROOF_DY} ${z1} minecraft:stone`);
  return rect;
}

/** One instance = (seed, rung). Cells at PBASE+8000, clear of traverse (+6000). */
export function makeRepairRung({ seed, rung }) {
  const spec = RUNGS[rung];
  const cx = PBASE.x + 8000 + rung * 200;
  const cz = PBASE.z + 8000 + seed * 200;
  const ax0 = cx, gx = cx + spec.len;
  const g = { cx, cz, ax0, gx, xmid: Math.round((ax0 + gx) / 2), y: AY };
  const START = { x: ax0, y: AY + 1, z: cz };
  const GOAL = { x: gx, y: AY + 1, z: cz };
  const control = spec.control ? spec.control(g) : null;

  return {
    name: "e-repair", seed, rung, body: "walker",
    rung_key: spec.key,
    arms: spec.arms,
    give: spec.give ?? null,
    dronePos: START,
    goal: GOAL,
    toolsFor: (arm) => spec.tools?.[arm] ?? REPAIR_TOOLS[arm] ?? REPAIR_TOOLS.goal,
    maxTurns: 16, // advisory (A5: guards, not caps)
    observeWindowMs: 4000,
    forceloaded: null,

    async setup() {
      this.forceloaded = await stageTube(g);
      await cmd("weather clear");
      await spec.build(g);
      await wait(300);
      // Invariant, per rung kind. Work rungs must be reachable WITH rights and unreachable
      // without (otherwise the rung does not require work and measures nothing); the diagnosis
      // rung must be unreachable outright, with the obstruction naming the control.
      const plain = await call("check_path", { from: START, to: GOAL, body: "walker", max_length: 512 })
        .catch((e) => ({ reachable: null, error: String(e) }));
      if (spec.diagnose) {
        if (plain.reachable !== false || !plain.obstruction?.control) {
          throw new Error(`bench invariant: ${spec.key} must be unreachable WITH a located control, ` +
            `got ${JSON.stringify(plain)}`);
        }
      } else {
        if (plain.reachable !== false && spec.key !== "door_shut") {
          // door_shut IS plain-unreachable too (check_path defaults doors closed) — same branch.
          throw new Error(`bench invariant: ${spec.key} must NOT be plain-walkable, got ${JSON.stringify(plain)}`);
        }
        const rights = spec.key === "door_shut"
          ? { open_doors: true }
          : spec.give ? { may_modify: "place" } : { may_modify: "break" };
        const armed = await call("check_path",
          { from: START, to: GOAL, body: "walker", max_length: 512, ...rights })
          .catch((e) => ({ reachable: null, error: String(e) }));
        if (armed.reachable !== true) {
          throw new Error(`bench invariant: ${spec.key} must be reachable WITH rights ` +
            `${JSON.stringify(rights)}, got ${JSON.stringify(armed)}`);
        }
      }
      this._plain = plain;
    },

    prompt: (arm) => {
      const core = `You control a Minecraft body (a grounded walker) inside a roofed corridor. ` +
        `Your GOAL is x=${GOAL.x}, y=${GOAL.y}, z=${GOAL.z}. `;
      const armText = arm === "goal"
        ? `Use bot_target {action:"move", target:{at:{x:${GOAL.x},y:${GOAL.y},z:${GOAL.z}}}, ` +
          `wait:true} — the server navigates and repairs obstacles within the rights you pass. ` +
          `If it stops, read its reason/obstruction/ledger and act on what it says. `
        : `Move with bot_goto {to/reach, wait:true}; when it stops short, diagnose with ` +
          `check_path/bot_status and repair by hand. `;
      const finish = `\nWhen bot_status shows you within ${ARRIVE_R} blocks of the goal, reply ` +
        `ARRIVED. If you determine the goal cannot be reached, reply BLOCKED and state exactly ` +
        `what blocks you, with coordinates of any control that would clear it.`;
      const hint = arm === "goal" ? spec.goalHint : spec.handHint;
      return core + armText + (hint ? `\n${hint}` : "") + finish;
    },

    /** Server-truth scoring; the diagnosis rung scores the report, not the arrival. */
    async score(_arm, finalText = "") {
      const status = await call("bot_status", {}).catch(() => ({}));
      const pos = status?.pos ?? null;
      const alive = !!status.spawned && (status.health ?? 0) > 0;
      const d = dist3(pos, GOAL);
      const arrived = alive && d <= ARRIVE_R;
      const metrics = {
        rung: rung + 1, rung_key: spec.key, body: "walker",
        arrived, final_dist: Number.isFinite(d) ? r1(d) : null,
        alive, final_health: status.health ?? 0,
        body_y: typeof pos?.y === "number" ? r1(pos.y) : null,
      };
      if (spec.diagnose && control) {
        // Success = the agent's final report NAMES the control's coordinates (all three numbers
        // present — they are large and distinctive, so a textual match is unambiguous).
        metrics.named_control = [control.x, control.y, control.z]
          .every((n) => finalText.includes(String(n)));
        metrics.control = control;
      }
      return { metrics, truth: { start: START, goal: GOAL, floor_y: AY, control, len: spec.len } };
    },

    async cleanup() {
      if (this.forceloaded) await releaseAreaStripped(...this.forceloaded);
    },
  };
}

export const SCENARIOS = { repair: makeRepairRung };
