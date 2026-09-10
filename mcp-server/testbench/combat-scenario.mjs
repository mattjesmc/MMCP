// Category E, slice E-combat — multi-round combat arena for the in-game body (BENCH_EXPANSION.md).
//
// A generalization of Category P's makeSurviveScenario (play-scenario.mjs) from a SINGLE round into
// an escalating WAVE LADDER: one night arena is staged once, then round r=1..N spawns a harder
// threat, the body is re-geared between rounds, and each round runs until the body dies or the wave
// is cleared. The ladder stops at the first death. Auto-scored from server truth (no LLM judge),
// same legal-vs-xray ablation P uses.
//
// Reuse vs P (imported, not duplicated): stageArena / releaseAreaStripped / PBASE / AY / SURVIVE_GEAR
// / TOOLSETS from play-scenario.mjs; call / cmd from bridge.mjs. What's NEW here is the wave ladder,
// the per-round orchestration surface (prepareRound / scoreRound / clearRound), and the
// altitude-matched-threat platform that unblocks P-survive's hover bug.

import { call, cmd } from "./bridge.mjs";
import {
  stageArena, releaseAreaStripped, PBASE, AY, SURVIVE_GEAR, TOOLSETS,
} from "./play-scenario.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const HALF = 16; // arena half-width — big enough for a ring of ~7 mobs + kiting room

// --- escalation ladder --------------------------------------------------------------------------
// Data-driven so it's trivial to tune: each round is a list of mob groups {type, n, [nbt], [tag]}.
// The wave's mobs share one ring around the body. Ladder per BENCH_EXPANSION.md:
//   r1: 3 zombies → r2: 5 zombies → r3: 5 skeletons (ranged) → r4: 6 mixed + 1 tougher "brute".
// The brute is a buffed zombie (extra max-health, iron gear). Its NBT is the one bit that may need
// live tuning for MC 26.2 attribute syntax — each summon is individually catchable, so a rejected
// brute NBT only drops that one mob, the round still runs. TODO(live): confirm the attributes tag.
const BRUTE_NBT =
  "attributes:[{id:\"minecraft:max_health\",base:40}],Health:40f," +
  "ArmorItems:[{},{},{},{id:\"minecraft:iron_helmet\",count:1}]," +
  "HandItems:[{id:\"minecraft:iron_sword\",count:1},{}]," +
  "PersistenceRequired:1b,CustomName:'\"brute\"'";
export const LADDER = [
  { name: "3 zombies",            mobs: [{ type: "zombie", n: 3 }] },
  { name: "5 zombies",            mobs: [{ type: "zombie", n: 5 }] },
  { name: "5 skeletons (ranged)", mobs: [{ type: "skeleton", n: 5 }] },
  { name: "6 mixed + 1 brute",    mobs: [
    { type: "zombie", n: 4 }, { type: "skeleton", n: 2 },
    { type: "zombie", n: 1, nbt: BRUTE_NBT, tag: "brute" },
  ] },
];

const isHostile = (e) => /zombie|skeleton|husk|stray/.test(e.type ?? "");
const roundCount = (round) => round.mobs.reduce((s, g) => s + g.n, 0);

// Ring of `count` positions around (cx,cz) at feet-level `y`. Tight radius (5-6) so the whole wave
// converges on the body — same trick as makeSurviveScenario's ring.
function ringPositions(cx, cz, y, count) {
  return Array.from({ length: count }, (_, i) => {
    const a = (2 * Math.PI * i) / count;
    const rad = 5 + (i % 2);
    return { x: Math.round(cx + Math.cos(a) * rad), y, z: Math.round(cz + Math.sin(a) * rad) };
  });
}

// --- altitude-matched threats (THE unblock for P-survive's hover bug) ---------------------------
// P-survive scored 0 damage / 0 kills because the drone hovers ~16 blocks above the AY floor within
// the first seconds (CATEGORY_P_DESIGN §"BLOCKED on drone hover height"): ground mobs on the AY
// floor can't reach it and it can't melee down to them. Fix: read the body's ACTUAL settled y from
// bot_status (don't assume 166 — it may drift), lay a solid platform ONE BLOCK BELOW that y across
// the arena, and summon the wave ON that platform (feet at the body's level). Rebuilt every round so
// it re-matches any drift. Isolated in this one helper so it's the single thing to iterate on live.
async function matchPlatformToBody(cx, cz) {
  const status = await call("bot_status", {}).catch(() => ({}));
  // status.pos.y = drone feet height (DroneTools.botStatus → addVec("pos", drone.position())).
  const bodyY = status?.pos?.y;
  // Fallback: AY + the ~16-block hover offset documented in CATEGORY_P_DESIGN, if pos is missing.
  const groundY = Math.floor(typeof bodyY === "number" ? bodyY : AY + 16); // TODO(live): verify pos.y present
  const platY = groundY - 1; // solid block one below the body → mobs summoned at groundY stand level with it
  // Solid combat floor at the body's level + clear headroom so mobs stand and path on it.
  await cmd(`fill ${cx - HALF} ${platY} ${cz - HALF} ${cx + HALF} ${platY} ${cz + HALF} minecraft:stone`);
  await cmd(`fill ${cx - HALF} ${platY + 1} ${cz - HALF} ${cx + HALF} ${platY + 5} ${cz + HALF} minecraft:air`);
  return { platY, mobY: groundY, bodyY: typeof bodyY === "number" ? bodyY : null };
}

// --- factory ------------------------------------------------------------------------------------
export function makeCombatArena({ seed, rounds = LADDER.length }) {
  const cx = PBASE.x + 4000 + seed * 200, cz = PBASE.z + 4000; // clear of perceive (+0) and survive (+2000)
  const center = { x: cx, y: AY + 1, z: cz };
  const ladder = LADDER.slice(0, rounds);

  return {
    name: "e-combat", seed,
    rounds: ladder.length,
    arms: ["legal", "xray"],
    dronePos: center,
    // Same player-legal (or x-ray) surfaces as P-survive — combat is the same tool cluster.
    toolsFor: (arm) => (arm === "xray" ? TOOLSETS.survive_xray : TOOLSETS.survive_legal),
    profileFor: (arm) => (arm === "xray" ? "authoritative" : "perceived"),
    maxTurns: 16,
    observeWindowMs: 25000, // per round: let the armed reflexes + engagement play out (P-survive value)
    forceloaded: null,

    /** Stage the arena ONCE (night floor). The body is spawned + the waves staged per round. */
    async setup() {
      this.forceloaded = await stageArena(cx, cz, HALF);
      await cmd("time set 18000"); // night: zombies don't burn
    },

    roundName: (r) => ladder[r - 1].name,
    roundThreat: (r) => roundCount(ladder[r - 1]),

    /** Re-stage the threat + re-gear the body fresh for round r (1-based). Returns the wave truth. */
    async prepareRound(arm, r) {
      const round = ladder[r - 1];
      await this.clearRound(); // remove any survivors of the previous round before the next spawns
      const { platY, mobY, bodyY } = await matchPlatformToBody(cx, cz);
      // Lay the whole wave on one ring at the body's level.
      const total = roundCount(round);
      const ring = ringPositions(cx, cz, mobY, total);
      let idx = 0;
      for (const g of round.mobs) {
        for (let k = 0; k < g.n; k++) {
          const p = ring[idx++];
          const nbt = g.nbt ?? "PersistenceRequired:1b";
          await cmd(`summon minecraft:${g.type} ${p.x} ${p.y} ${p.z} {${nbt}}`).catch(() => {});
        }
      }
      // Re-gear the body from the shared survival loadout (agent equips it via bot_equip).
      for (const [item, n] of SURVIVE_GEAR) await call("bot_give", { item: `minecraft:${item}`, count: n }).catch(() => {});
      await call("bot_profile", { perception: this.profileFor(arm) }).catch(() => {});
      // Make the threat REAL: mobs won't target a non-player drone on their own (P saw 0 damage until
      // this). `/damage … by <drone>` attributes a 1-point hit to the drone, setting each mob's
      // retaliation target to it, so the wave paths in and actually attacks. Same trick as P-survive.
      await cmd(`damage @e[type=minecraft:zombie,distance=..25,x=${cx},y=${platY},z=${cz}] 1 minecraft:mob_attack by @e[type=mcptoolkit:drone,limit=1]`).catch(() => {});
      await cmd(`damage @e[type=minecraft:skeleton,distance=..25,x=${cx},y=${platY},z=${cz}] 1 minecraft:mob_attack by @e[type=mcptoolkit:drone,limit=1]`).catch(() => {});
      await wait(500);
      // Baseline health AFTER re-gear so per-round damage_taken isn't confounded by healing between rounds.
      const status = await call("bot_status", {}).catch(() => ({}));
      return { threat: total, health_before: status?.health ?? 20, platY, bodyY };
    },

    prompt: (r) => {
      const round = ladder[r - 1];
      return (
        `WAVE ${r} of ${ladder.length}: ${roundCount(round)} hostiles (${round.name}) close in on you ` +
        `(it is night). Your inventory holds iron armor, an iron sword, a shield, a bow with arrows, ` +
        `and golden apples. SURVIVE and CLEAR the wave: equip your gear (bot_equip), arm defensive ` +
        `reflexes (bot_reactions — e.g. shield/eat on low health), and fight them off (bot_target action:"attack" to designate + bot_body action:"engage" ` +
        `close to melee, or shoot). They retaliate when engaged. Act now; the server keeps fighting ` +
        `on your behalf once your reflexes and engagement are set.`
      );
    },

    /** Score round r from server truth. `pre` is the object prepareRound returned. */
    async scoreRound(arm, r, pre) {
      const status = await call("bot_status", {}).catch(() => ({}));
      const alive = !!status.spawned && (status.health ?? 0) > 0;
      const oracle = await call("get_entities", { origin: center, radius: 30 }).catch(() => ({ entities: [] }));
      const remaining = (oracle.entities ?? oracle.list ?? []).filter(isHostile).length;
      const killed = Math.max(0, pre.threat - remaining);
      const healthBefore = pre.health_before ?? 20;
      return {
        metrics: {
          round: r, round_name: ladder[r - 1].name,
          cleared: remaining === 0,
          alive, final_health: status.health ?? 0,
          mobs_initial: pre.threat, mobs_remaining: remaining, mobs_killed: killed,
          damage_taken: Math.max(0, healthBefore - (status.health ?? 0)),
        },
        truth: { threat: pre.threat, body_y: pre.bodyY, plat_y: pre.platY },
      };
    },

    /** Kill any hostiles left in the arena (between rounds, and on cleanup). */
    async clearRound() {
      for (const t of ["zombie", "skeleton", "husk", "stray"]) {
        await cmd(`kill @e[type=minecraft:${t},distance=..50,x=${cx},y=${AY},z=${cz}]`).catch(() => {});
      }
    },

    async cleanup() {
      await this.clearRound();
      if (this.forceloaded) await releaseAreaStripped(...this.forceloaded);
    },
  };
}

export const SCENARIOS = { combat: makeCombatArena };
