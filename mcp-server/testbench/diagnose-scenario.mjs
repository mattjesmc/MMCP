// Category Z, slice Z-diagnose — READING a circuit someone else made, the inverse of z-redstone's
// build direction and the bench's causal/counterfactual/relational-READ coverage (DISCIPLINE_INDEX
// gaps). The HARNESS stages a code-known circuit; the agent gets READ-ONLY tools and answers one
// question from inspection:
//   wiring  (relational)    : two inputs, one wired through, one dead-ended — which controls the lamp?
//   fault   (causal)        : the line has exactly one missing wire cell — which candidate is the break?
//   whatif  (counterfactual): would the lamp still light if THIS wire cell were removed? (a redundant
//                             parallel branch vs the shared trunk — seed-balanced yes/no)
//
// Every truth is by construction AND verified by live intervention before any model is spent: the
// driver toggles the real inputs (setblock redstone_block, as z-redstone does), reads the real lamp
// (readLit), and for fault/whatif actually performs the repair/removal, asserts the predicted
// behaviour, and restores the circuit. A wrong assumption about wire semantics throws at --dry.

import { cmd, call } from "./bridge.mjs";
import { stagePlot, releasePlot, FLOOR_Y, WEBASE } from "./plot.mjs";
import { readLit } from "./world-read.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const SETTLE = 400; // same propagation window as z-redstone (LIVE knob)

export const DIAGNOSE_KINDS = ["wiring", "fault", "whatif"];
// Read-only surface: this slice must not be able to fix or probe-by-mutation.
export const DIAGNOSE_TOOLS = ["get_blocks_at", "describe_box", "get_surface"];

const WIRE = "minecraft:redstone_wire";
const setb = (p, block) => cmd(`setblock ${p.x} ${p.y} ${p.z} minecraft:${block.replace("minecraft:", "")}`);
const drive = async (p, on) => { await setb(p, on ? "redstone_block" : "air"); await wait(SETTLE); };

export function makeDiagnosePuzzle({ seed, kind }) {
  const ki = Math.max(0, DIAGNOSE_KINDS.indexOf(kind));
  const cx = WEBASE.x + 1000 + ki * 100, cz = WEBASE.z + 5000 + seed * 100;
  const y = FLOOR_Y + 1, x0 = cx - 5, z0 = cz;
  const s = {
    name: "z-diagnose", seed, kind, arms: ["read"], maxTurns: 14, plot: null,
    toolsFor: () => DIAGNOSE_TOOLS,
    region: { min: { x: cx - 7, y: FLOOR_Y, z: cz - 4 }, max: { x: cx + 7, y: FLOOR_Y + 2, z: cz + 4 } },
  };

  if (kind === "wiring") {
    // Two inputs on the west edge, lanes 2 apart (never orthogonally adjacent → never merge). The
    // live lane jogs into the center and runs to the lamp; the dead lane stops after 3 cells.
    const chosen = seed % 2; // which input is really connected
    const feeds = [{ x: x0 - 1, y, z: z0 - 2 }, { x: x0 - 1, y, z: z0 + 2 }];
    const lamp = { x: x0 + 8, y, z: z0 };
    const laneZ = (i) => (i === 0 ? z0 - 2 : z0 + 2);
    const live = [], dead = [];
    for (let i = 0; i < 3; i++) live.push({ x: x0 + i, y, z: laneZ(chosen) });
    live.push({ x: x0 + 3, y, z: laneZ(chosen) });
    // jog to center: one step at a time toward z0
    const dzs = chosen === 0 ? [z0 - 1, z0] : [z0 + 1, z0];
    for (const z of dzs) live.push({ x: x0 + 3, y, z });
    for (let x = x0 + 4; x < lamp.x; x++) live.push({ x, y, z: z0 });
    for (let i = 0; i < 3; i++) dead.push({ x: x0 + i, y, z: laneZ(1 - chosen) });
    s.truth = String(chosen + 1);
    s.answer_type = "enum"; s.options = ["1", "2"];
    s.setup = async () => {
      s.plot = await stagePlot(cx, cz, 12);
      for (const p of [...live, ...dead]) await setb(p, WIRE);
      await setb(lamp, "redstone_lamp");
      for (const f of feeds) await setb(f, "air");
    };
    s.selfCheck = async () => {
      const out = {};
      for (const i of [0, 1]) {
        await drive(feeds[i], true);
        out[`input${i + 1}_lights_lamp`] = await readLit(lamp);
        await drive(feeds[i], false);
      }
      const okOn = out[`input${chosen + 1}_lights_lamp`] === true;
      const okOff = out[`input${2 - chosen}_lights_lamp`] === false;
      if (!okOn || !okOff) throw new Error(`wiring invariant: ${JSON.stringify(out)} but chosen=input${chosen + 1}`);
      return { ...out, verified: true };
    };
    s.prompt = () =>
      `A redstone circuit stands on the floor (wires at y=${y}). Two INPUT positions exist: ` +
      `input 1 at (${feeds[0].x}, ${feeds[0].y}, ${feeds[0].z}) and input 2 at (${feeds[1].x}, ${feeds[1].y}, ${feeds[1].z}) ` +
      `(a redstone_block appears there when that input turns on). A redstone_lamp sits at (${lamp.x}, ${lamp.y}, ${lamp.z}). ` +
      `Exactly ONE input is wired through to the lamp; the other line dead-ends. ` +
      `Inspect the wiring with your read-only tools and answer: which input controls the lamp? ` +
      `Reply exactly "ANSWER: 1" or "ANSWER: 2".`;
  }

  if (kind === "fault") {
    // A straight input→lamp line with exactly one wire cell missing. Candidates = the gap + 3
    // intact cells, shuffled deterministically by seed.
    const feed = { x: x0 - 1, y, z: z0 };
    const lamp = { x: x0 + 8, y, z: z0 };
    const line = []; for (let x = x0; x < lamp.x; x++) line.push({ x, y, z: z0 });
    const gapIdx = 2 + (seed % (line.length - 4)); // never the first/last cell
    const gap = line[gapIdx];
    const intact = [line[gapIdx - 2] ?? line[0], line[gapIdx + 2] ?? line[line.length - 1], line[gapIdx - 1]];
    const cands = [gap, ...intact];
    for (let i = cands.length - 1; i > 0; i--) { const j = (seed * 7 + i * 13) % (i + 1); [cands[i], cands[j]] = [cands[j], cands[i]]; }
    s.truth = String(cands.findIndex((c) => c === gap) + 1);
    s.answer_type = "enum"; s.options = ["1", "2", "3", "4"];
    s.setup = async () => {
      s.plot = await stagePlot(cx, cz, 12);
      for (const p of line) await setb(p, p === gap ? "air" : WIRE);
      await setb(lamp, "redstone_lamp");
      await setb(feed, "air");
    };
    s.selfCheck = async () => {
      await drive(feed, true);
      const brokenOff = (await readLit(lamp)) === false;   // the fault is real
      await setb(gap, WIRE); await wait(SETTLE);
      const repairedOn = (await readLit(lamp)) === true;   // and it is the ONLY fault
      await setb(gap, "air"); await drive(feed, false);
      if (!brokenOff || !repairedOn) throw new Error(`fault invariant: brokenOff=${brokenOff} repairedOn=${repairedOn}`);
      return { broken_lamp_off: brokenOff, repaired_lamp_on: repairedOn, verified: true };
    };
    s.prompt = () =>
      `A straight redstone wire line should run at y=${y}, z=${z0} from x=${x0} to x=${lamp.x - 1}, carrying the ` +
      `input at (${feed.x}, ${feed.y}, ${feed.z}) (a redstone_block when on) to the redstone_lamp at ` +
      `(${lamp.x}, ${lamp.y}, ${lamp.z}). The lamp does NOT light when the input is on: exactly one wire cell ` +
      `is missing. Which candidate position is the break?\n` +
      cands.map((c, i) => `  ${i + 1}: (${c.x}, ${c.y}, ${c.z})`).join("\n") +
      `\nInspect with your read-only tools and reply exactly "ANSWER: <1-4>".`;
  }

  if (kind === "whatif") {
    // Trunk → fork → two parallel branches (2 apart, reunited) → lamp. Ask about removing either a
    // TRUNK cell (lamp dies) or a BRANCH cell (the twin branch keeps it lit) — seed-balanced.
    const feed = { x: x0 - 1, y, z: z0 };
    const fork = { x: x0 + 2, y, z: z0 };
    const rejoin = { x: x0 + 6, y, z: z0 };
    const lamp = { x: x0 + 8, y, z: z0 };
    const trunk = [{ x: x0, y, z: z0 }, { x: x0 + 1, y, z: z0 }, fork];
    const branch = (dz) => [
      { x: fork.x, y, z: z0 + dz }, { x: fork.x + 1, y, z: z0 + dz }, { x: fork.x + 2, y, z: z0 + dz },
      { x: fork.x + 3, y, z: z0 + dz }, { x: rejoin.x, y, z: z0 + dz },
    ];
    const north = branch(-1), southB = branch(1);
    const tail = [rejoin, { x: x0 + 7, y, z: z0 }];
    const askTrunk = seed % 2 === 0;
    const target = askTrunk ? trunk[1] : north[2];
    s.truth = !askTrunk; // quiz.mjs bool scoring compares against a BOOLEAN (yes ⇒ true)
    s.answer_type = "bool";
    s.setup = async () => {
      s.plot = await stagePlot(cx, cz, 12);
      for (const p of [...trunk, ...north, ...southB, ...tail]) await setb(p, WIRE);
      await setb(lamp, "redstone_lamp");
      await setb(feed, "air");
    };
    s.selfCheck = async () => {
      await drive(feed, true);
      const baseOn = (await readLit(lamp)) === true;
      await setb(target, "air"); await wait(SETTLE);
      const after = await readLit(lamp);
      await setb(target, WIRE); await wait(SETTLE);
      const restored = (await readLit(lamp)) === true;
      await drive(feed, false);
      const expect = s.truth === true;
      if (!baseOn || after !== expect || !restored)
        throw new Error(`whatif invariant: baseOn=${baseOn} afterRemoval=${after} expect=${expect} restored=${restored}`);
      return { base_lamp_on: baseOn, after_removal: after, restored, verified: true };
    };
    s.prompt = () =>
      `A working redstone circuit stands on the floor (wires at y=${y}): the input at (${feed.x}, ${feed.y}, ${feed.z}) ` +
      `(a redstone_block when on) lights the redstone_lamp at (${lamp.x}, ${lamp.y}, ${lamp.z}). ` +
      `Inspect the wiring with your read-only tools, then answer this WITHOUT anything being changed yet: ` +
      `if the redstone wire at (${target.x}, ${target.y}, ${target.z}) were removed, would the lamp STILL light ` +
      `while the input is on? Reply exactly "ANSWER: yes" or "ANSWER: no".`;
  }

  s.cleanup = async () => { await releasePlot(s.plot); };
  return s;
}
