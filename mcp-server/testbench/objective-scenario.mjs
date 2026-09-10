// Categories E-survive-build + the milestone ladder + the dungeon capstone — embodied multi-objective
// scenarios for the in-game body. All three are auto-scored from server truth (no LLM judge) via the
// unit-tested pure cores: build-score (structural goals) and progress-score (sequential milestones).
//
// Shared spine: a set of PREDICATE EVALUATORS that turn server state into a boolean per objective —
//   invHas(item, n)      : bot_status{inventory:true} holds ≥ n of item
//   regionFilled(reg, k) : ≥ k occupied (non-air) cells in a region (build goal met)
//   entityGone(area,type): no live `type` mob near area (combat objective met)
//   bodyInRegion(reg)    : the body's position is inside reg (navigation/checkpoint met)
// The harnesses run ONE embodied session, then evaluate the objectives and score. Reuses stageArena /
// releaseAreaStripped / PBASE / AY from play-scenario.mjs (NOT tasks.mjs, which the concurrent bench
// is editing). Lights the dark embodied action cluster: bot_mine/place/use/attack + bot_goto.
//
// LIVE-ITERATION NOTE: embodied gather-and-build depends on the body reaching each cell (4.5-block
// eye reach, hovering) and the pathfinder cooperating — the same class of live tuning as E-combat's
// altitude and E-traverse's grounding. The pure scoring is validated offline; the embodiment is the
// in-game knob. --dry stages + evaluates baseline objective truth (all false) with no model spend.

import { call, cmd } from "./bridge.mjs";
import { stageArena, releaseAreaStripped, PBASE, AY } from "./play-scenario.mjs";
import { diffBuild } from "./build-score.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const OBASE = { x: PBASE.x + 8000, z: PBASE.z + 8000 }; // clear of perceive/survive/combat/traverse

// Full embodied surface (legal perception) — the objective slices need to see, move, and act.
export const EMBODIED_TOOLS = [
  "bot_status", "bot_goto", "bot_look", "bot_select",
  "bot_mine", "bot_place", "bot_use", "bot_attack", "bot_equip", "bot_reactions",
  "sense_entities", "scene_summary", "get_blocks_at",
];

// --- predicate evaluators (server truth → boolean) ---------------------------------------------
async function invHas(item, n) {
  const inv = await call("bot_status", { inventory: true }).then((r) => r.inventory ?? r).catch(() => ({ slots: [] }));
  const total = (inv.slots ?? []).filter((s) => (s.item ?? "").includes(item)).reduce((a, s) => a + (s.count ?? 0), 0);
  return { done: total >= n, detail: { item, have: total, need: n } };
}
async function regionFilled(region, k) {
  const { min, max } = region;
  let occ = 0;
  const cells = [];
  for (let x = min.x; x <= max.x; x++) for (let y = min.y; y <= max.y; y++) for (let z = min.z; z <= max.z; z++) cells.push({ x, y, z });
  const res = await call("get_blocks_at", { blocks: cells.slice(0, 256) }).catch(() => null);
  const pal = res?.palette ?? [];
  for (const row of res?.blocks ?? []) { const id = row[3] >= 0 ? pal[row[3]] : ""; if (id && !/air$/.test(id)) occ++; }
  return { done: occ >= k, detail: { occupied: occ, need: k } };
}
async function entityGone(center, radius, type) {
  const oracle = await call("get_entities", { origin: center, radius }).catch(() => ({ entities: [] }));
  const alive = (oracle.entities ?? oracle.list ?? []).filter((e) => new RegExp(type).test(e.type ?? "")).length;
  return { done: alive === 0, detail: { alive, type } };
}
async function bodyInRegion(region) {
  const st = await call("bot_status", {}).catch(() => ({}));
  const p = st.pos;
  const inR = p && p.x >= region.min.x && p.x <= region.max.x && p.z >= region.min.z && p.z <= region.max.z &&
    p.y >= region.min.y - 2 && p.y <= region.max.y + 3;
  return { done: !!inR, detail: { pos: p ?? null } };
}

// ================================================================================================
// E-survive-build — gather cobblestone from a quarry, then bridge a gap with it. Scored by silhouette
// coverage of the gap footprint (material-agnostic: any solid the body places counts).
// ================================================================================================
export function makeSurviveBuild(seed) {
  const cx = OBASE.x + seed * 200, cz = OBASE.z;
  const center = { x: cx, y: AY + 1, z: cz };
  // A gap (open trench) the body must bridge; a quarry row of cobblestone to mine for material.
  const gapXs = [cx + 3, cx + 4, cx + 5];
  const bridgeCells = gapXs.map((x) => ({ x, y: AY, z: cz }));                 // the goal footprint (floor level)
  const quarry = Array.from({ length: 6 }, (_, i) => ({ x: cx - 3 - i, y: AY, z: cz })); // mineable cobblestone
  const goalTarget = Object.fromEntries(bridgeCells.map((p) => [`${p.x},${p.y},${p.z}`, "minecraft:cobblestone"]));
  const region = { min: { x: gapXs[0], y: AY, z: cz }, max: { x: gapXs[gapXs.length - 1], y: AY, z: cz } };

  return {
    name: "e-survive-build", seed, arms: ["legal"], dronePos: center,
    toolsFor: () => EMBODIED_TOOLS, profileFor: () => "perceived", maxTurns: 30, observeWindowMs: 0, forceloaded: null,

    async setup() {
      this.forceloaded = await stageArena(cx, cz, 14);
      // Open the gap (remove floor over the trench), lay the quarry cobblestone.
      await cmd(`fill ${gapXs[0]} ${AY} ${cz - 1} ${gapXs[gapXs.length - 1]} ${AY} ${cz + 1} minecraft:air`);
      for (const p of quarry) await cmd(`setblock ${p.x} ${p.y} ${p.z} minecraft:cobblestone`);
    },
    async prepare() { await call("bot_profile", { perception: "perceived" }).catch(() => {}); await wait(300); },

    prompt: () =>
      `You are an embodied Minecraft body with an EMPTY inventory. GOAL: bridge the 3-block gap in the ` +
      `floor at x=${gapXs[0]}..${gapXs[gapXs.length - 1]} (z=${cz}, y=${AY}). There is no material in your ` +
      `inventory — first MINE cobblestone from the quarry row to your west (x=${quarry[quarry.length - 1].x}..${quarry[0].x}, ` +
      `z=${cz}, y=${AY}) with bot_mine (move within reach using bot_goto), then bot_place the blocks to ` +
      `fill each gap cell so the floor is solid across. Check bot_status {inventory:true} as you go. Reply DONE when the gap is bridged.`,

    async score() {
      const cap = {};
      for (const p of bridgeCells) { const b = await call("get_blocks_at", { blocks: [p] }).catch(() => null); const idx = b?.blocks?.[0]?.[3]; cap[`${p.x},${p.y},${p.z}`] = idx != null && idx >= 0 ? b.palette[idx] : "minecraft:air"; }
      const d = diffBuild(goalTarget, cap);
      const inv = await invHas("cobblestone", 1);
      return {
        metrics: { bridged: d.silhouette_iou === 1, coverage: d.silhouette_iou, filled: d.built_cells, goal_cells: d.target_cells, still_holding: inv.detail.have },
        truth: { region, goal_cells: d.target_cells },
      };
    },
    async cleanup() { if (this.forceloaded) await releaseAreaStripped(...this.forceloaded); },
  };
}

// --- milestone latching --------------------------------------------------------------------------
// Sequential milestones can be TRANSIENT: "holding ≥3 cobblestone" stops being true the moment the
// blocks are placed, "body in the vault" stops being true when it walks on. A post-hoc evaluation
// therefore under-scores real progress (live-proven 2026-07-25: ladder did build+fight but scored
// deepest 0 because the gathered cobble was spent). The runner polls pollLatch() DURING the episode;
// a step that was ever observed done stays done. score() merges fresh eval with the latches.
function withLatch(s, steps) {
  s._latched = {};
  s._polling = false;
  s.pollLatch = async () => {
    if (s._polling) return; // skip reentrant polls (bridge calls can outlast the interval)
    s._polling = true;
    try {
      for (const m of steps) {
        if (s._latched[m.key]) continue;
        const r = await m.eval().catch(() => ({ done: false }));
        if (r.done) s._latched[m.key] = true;
      }
    } finally { s._polling = false; }
  };
  s.score = async () => {
    const results = [];
    for (const m of steps) {
      const r = await m.eval().catch(() => ({ done: false, detail: null }));
      results.push({ key: m.key, done: r.done || !!s._latched[m.key], latched: !!s._latched[m.key], detail: r.detail ?? null });
    }
    return { results };
  };
  return s;
}

// ================================================================================================
// Milestone ladder — gather → build → fight, scored by sequential progress (deepest consecutive).
// ================================================================================================
export function makeMilestoneLadder(seed) {
  const cx = OBASE.x + 2000 + seed * 200, cz = OBASE.z + 2000;
  const center = { x: cx, y: AY + 1, z: cz };
  const quarry = Array.from({ length: 6 }, (_, i) => ({ x: cx - 3 - i, y: AY, z: cz }));
  const pad = { min: { x: cx + 3, y: AY + 1, z: cz - 1 }, max: { x: cx + 4, y: AY + 1, z: cz } }; // 2×2 platform goal
  const mobPos = { x: cx, y: AY + 1, z: cz + 6 };

  const milestones = [
    { key: "gather_3_cobblestone", eval: () => invHas("cobblestone", 3) },
    { key: "build_2x2_platform", eval: () => regionFilled(pad, 4) },
    { key: "defeat_zombie", eval: () => entityGone(center, 30, "zombie") },
  ];

  return withLatch({
    name: "e-milestone", seed, arms: ["legal"], dronePos: center,
    toolsFor: () => EMBODIED_TOOLS, profileFor: () => "perceived", maxTurns: 40, observeWindowMs: 8000, forceloaded: null, milestones,

    async setup() {
      this.forceloaded = await stageArena(cx, cz, 16);
      for (const p of quarry) await cmd(`setblock ${p.x} ${p.y} ${p.z} minecraft:cobblestone`);
      await cmd("time set 18000");
      await cmd(`summon minecraft:zombie ${mobPos.x} ${mobPos.y} ${mobPos.z} {PersistenceRequired:1b}`);
    },
    async prepare() {
      for (const [item, n] of [["iron_sword", 1], ["iron_chestplate", 1]]) await call("bot_give", { item: `minecraft:${item}`, count: n }).catch(() => {});
      await call("bot_profile", { perception: "perceived" }).catch(() => {});
      await wait(300);
    },
    prompt: () =>
      `You are an embodied Minecraft body. Complete these objectives IN ORDER:\n` +
      `1) Gather at least 3 cobblestone — mine the quarry row to your west (x=${quarry[quarry.length - 1].x}..${quarry[0].x}, z=${cz}, y=${AY}) with bot_mine.\n` +
      `2) Build a 2×2 platform at x=${pad.min.x}..${pad.max.x}, z=${pad.min.z}..${pad.max.z}, y=${AY + 1} by bot_place-ing the blocks you gathered.\n` +
      `3) Defeat the zombie to your south (near x=${mobPos.x}, z=${mobPos.z}) — equip your iron sword (bot_equip), then designate it (bot_target action:"attack") and arm combat (bot_body action:"engage", mode:"fight").\n` +
      `Use bot_goto to move within reach. Report progress; reply DONE when all three are complete.`,

    async cleanup() {
      await cmd(`kill @e[type=minecraft:zombie,distance=..50,x=${cx},y=${AY},z=${cz}]`).catch(() => {});
      if (this.forceloaded) await releaseAreaStripped(...this.forceloaded);
    },
  }, milestones);
}

// ================================================================================================
// Dungeon capstone — a linear checkpoint chain: reach the vault → mine the treasure → slay the guard
// → reach the exit. Composes navigation + mining + combat; scored by sequential progress.
// ================================================================================================
export function makeDungeon(seed) {
  const cx = OBASE.x + 4000 + seed * 300, cz = OBASE.z + 4000;
  const start = { x: cx, y: AY + 1, z: cz };
  const vault = { min: { x: cx + 10, y: AY + 1, z: cz - 2 }, max: { x: cx + 14, y: AY + 3, z: cz + 2 } };
  const treasure = { x: cx + 12, y: AY + 1, z: cz };            // a gold_block the body mines
  const guardPos = { x: cx + 18, y: AY + 1, z: cz };
  const exit = { min: { x: cx + 24, y: AY + 1, z: cz - 2 }, max: { x: cx + 28, y: AY + 3, z: cz + 2 } };

  const checkpoints = [
    { key: "reach_vault", eval: () => bodyInRegion(vault) },
    { key: "loot_treasure", eval: () => invHas("gold", 1) },
    { key: "slay_guard", eval: () => entityGone({ x: guardPos.x, y: guardPos.y, z: guardPos.z }, 12, "zombie|husk") },
    { key: "reach_exit", eval: () => bodyInRegion(exit) },
  ];

  return withLatch({
    name: "e-dungeon", seed, arms: ["legal"], dronePos: start,
    toolsFor: () => EMBODIED_TOOLS, profileFor: () => "perceived", maxTurns: 50, observeWindowMs: 6000, forceloaded: null, checkpoints,

    async setup() {
      this.forceloaded = await stageArena(cx, cz, 22);
      await cmd("time set 18000");
      await cmd(`setblock ${treasure.x} ${treasure.y} ${treasure.z} minecraft:gold_block`);
      await cmd(`summon minecraft:husk ${guardPos.x} ${guardPos.y} ${guardPos.z} {PersistenceRequired:1b,CustomName:'"guard"'}`);
    },
    async prepare() {
      for (const [item, n] of [["iron_sword", 1], ["iron_chestplate", 1], ["diamond_pickaxe", 1]]) await call("bot_give", { item: `minecraft:${item}`, count: n }).catch(() => {});
      await call("bot_profile", { perception: "perceived" }).catch(() => {});
      await wait(300);
    },
    prompt: () =>
      `You are an embodied Minecraft body at the entrance of a dungeon (running east, +x). Clear it IN ORDER:\n` +
      `1) Reach the VAULT room around x=${vault.min.x}..${vault.max.x}, z=${cz} (bot_goto).\n` +
      `2) Loot the treasure: mine the gold_block at (${treasure.x}, ${treasure.y}, ${treasure.z}) with your diamond_pickaxe (bot_equip then bot_mine).\n` +
      `3) Slay the guard (a husk) near x=${guardPos.x}, z=${cz} — equip the iron sword, designate it (bot_target action:"attack") and arm combat (bot_body action:"engage", mode:"fight").\n` +
      `4) Reach the EXIT around x=${exit.min.x}..${exit.max.x}, z=${cz}.\n` +
      `Report progress; reply DONE when you reach the exit.`,

    async cleanup() {
      await cmd(`kill @e[type=minecraft:husk,distance=..60,x=${cx},y=${AY},z=${cz}]`).catch(() => {});
      if (this.forceloaded) await releaseAreaStripped(...this.forceloaded);
    },
  }, checkpoints);
}

export const FAMILIES = { survive: makeSurviveBuild, ladder: makeMilestoneLadder, dungeon: makeDungeon };
