// Category C scenario — the memory recall depth fixture (CATEGORY_C_DESIGN.md).
//
// A seeded, multi-session, single-world / multi-region scenario. Three explore sessions each patrol
// one region and narrate what they see into durable memory; between explore and quiz the harness
// mutates the depot chest (the staleness subject); a fourth FRESH session answers a difficulty
// gradient of questions from memory alone. Every truth is known by construction or read from the
// server — no LLM judge (the ablation don't-build rule).
//
// The upgrade over the ablation's interrogation-multi is DEPTH: enough regions × facts × episodes
// that early facts compact to L1 blocks and drop out of the session-open render. run-memory.mjs
// asserts `in_render:false` for the demoted facts (via the pipeline funnel) before trusting a score,
// so this is finally the corpus where mem_recall can differ from manual mem_read — the rule-3 test
// ABLATION_RESULTS.md said was missing.

import * as stage from "../ablation/scenarios/stage.mjs";
import { cmd } from "../ablation/bridge.mjs";
import { ensureGenerated } from "./tasks.mjs";
import { extractJson, posMatch, forbiddenCommands, perceivedNear, dataReadNear, toolCalls } from "../ablation/metrics.mjs";

// Regions are far apart in x (2 chunks of separation min) so each is its own memory region tag and
// the drone genuinely travels; all staging floats at stage.Y to keep worldgen out of the fixture.
const BASE_X = 116288;
const BASE_Z = 100000;
const REGION_DX = 1024;

// A small deterministic PRNG so item identities / counts vary by seed but never by wall clock.
function rng(seed) {
  let a = (seed >>> 0) || 1;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build the scenario for one seed.
 * @param {number} seed
 * @returns scenario with { name, seed, params, dronePos, exploreEpisodes, quizEpisode, mutate, facts, questions, score }
 */
/**
 * The change rung's staging version. v1 (bench 0.9.6–0.9.7) staged `chg_vanished` as a wool TOWER,
 * whose prior was structurally unobservable — a habitual ~4-tall platform scan truncated it at every
 * height in the seeded range, so the probe measured how tall the explore session happened to scan
 * rather than whether memory kept a prior. v2 stages it as a flat cluster at y=201, caught by any
 * platform-sized box.
 *
 * This is a COMPARABILITY BOUNDARY, and it is stamped into the manifest so obs-report and the
 * ratchet can split rung versions rather than pooling them: a v1 absolute score and a v2 absolute
 * score are not the same measurement, and the difference is the question, not the subject.
 */
export const CHANGE_RUNG_VERSION = 2;

/**
 * The EXPLORE prompt's version — a separate axis from the change rung's staging, because it moves
 * something bigger: the shared corpus, and therefore EVERY Category C unit's answerability, not just
 * the change probes. v1 pointed the agent at the slab surface (y=200) while asking what stands on it;
 * v2 mirrors the change-quiz prompt's ON-TOP framing (see `patrolPrompt`).
 *
 * A COMPARABILITY BOUNDARY for all of C: rows built on a v1 corpus may simply not contain the
 * structures their questions ask about, so v1 and v2 absolute levels are not interchangeable for
 * `where`/`count`/`breadth`/`anchor`/`region`/`stale` OR the `chg_*` probes. Stamped into the
 * manifest so a reader can split on it instead of discovering this the way we did.
 */
export const EXPLORE_PROMPT_VERSION = 2;

export function makeMemScenario(seed) {
  const r = rng(seed * 2654435761);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const rint = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));

  // Region origins (x0) and the per-region start platform the drone spawns onto.
  const regionX = [0, 1, 2].map((k) => BASE_X + k * REGION_DX + seed * 64);
  const z0 = BASE_Z;

  // Four raised waypoint platforms per region, well separated in z.
  const waypoints = (x0) => Array.from({ length: 4 }, (_, i) => [x0 + i * 40, z0 + (i % 2 ? 60 : 0) + Math.floor(i / 2) * 130]);
  const regions = regionX.map((x0) => ({ x0, wps: waypoints(x0), start: [x0 - 30, stage.Y + 2, z0 - 20] }));

  // Fact structures. Identities/counts vary by seed; positions are pinned to specific waypoints so
  // truth is exact. Each region carries 2-3 facts → 6-7 planted facts across a 3-block corpus.
  const GOLD = "minecraft:gold_block", EMERALD = "minecraft:emerald_block";
  const HAY = "minecraft:hay_block", COPPER = "minecraft:copper_block", IRON = "minecraft:iron_block";
  const BOOKSHELF = "minecraft:bookshelf";
  const WOOL = pick(["red_wool", "blue_wool", "lime_wool"]);

  // fact key → the question id whose truth is built from that fact (see `questions` below). Facts
  // absent here are corpus depth, not question subjects, and their `used_correctly` is null.
  const QUESTION_OF_FACT = { gold: "where", emerald: "count", bookshelf: "region" };

  const facts = {
    // region 0
    gold:      { region: 0, wp: 1, kind: "cluster", block: GOLD,      count: rint(3, 5) },
    hay:       { region: 0, wp: 3, kind: "cluster", block: HAY,       count: rint(2, 4) },
    // region 1
    emerald:   { region: 1, wp: 0, kind: "cluster", block: EMERALD,   count: rint(4, 7) },
    // FLAT, not a tower (bench 0.9.7). This structure is the change rung's `chg_vanished` prior, and
    // as a tower its prior was UNOBSERVABLE: a tower spans y=201..201+h with h ∈ [3,5], while explore
    // sessions habitually scan a ~4-tall box, so the read truncated it at every height in the range.
    // The agent honestly saw 2 of 5 blocks and wrote down 2 — and capture recorded 2 as well, because
    // the observation was 2. Grading against the construction truth then measured how tall the
    // session happened to scan, not whether memory kept a prior. A flat cluster at y=201 is caught by
    // any platform-sized box, so the prior is always observable and the probe measures memory.
    woolPatch: { region: 1, wp: 2, kind: "cluster", block: `minecraft:${WOOL}`, count: rint(3, 5) },
    // region 2 (the "breadth" region — three distinct structure types)
    bookshelf: { region: 2, wp: 0, kind: "tower",   block: BOOKSHELF, height: rint(3, 5) },
    copper:    { region: 2, wp: 2, kind: "cluster", block: COPPER,    count: rint(3, 6) },
    ironTower: { region: 2, wp: 3, kind: "tower",   block: IRON,      height: rint(2, 4) },
  };
  const factWp = (f) => regions[f.region].wps[f.wp];
  const factPos = (f) => [factWp(f)[0], stage.Y + (f.kind === "tower" ? f.height : 1), factWp(f)[1]];
  // Any block of the structure (for pos tolerance matching the answer to a waypoint).
  const factBase = (f) => [factWp(f)[0], stage.Y + 1, factWp(f)[1]];

  // The staleness subject: a depot chest on region 0's start platform, moved+restocked between
  // explore and quiz. Item/count differ pre/post so a remembered answer is detectably stale.
  const depot = [regions[0].x0 - 30, z0 - 20];
  const chestOld = [depot[0] + 2, stage.Y + 1, depot[1] + 2];
  const chestNew = [depot[0] + 2, stage.Y + 1, depot[1] - 6];
  const oldItem = "minecraft:iron_ingot", oldCount = rint(6, 12);
  const newItem = pick(["minecraft:copper_ingot", "minecraft:redstone", "minecraft:lapis_lazuli"]);
  const newCount = rint(14, 30);

  // The start marker (region 0 start platform) carries a named top block — the trivial anchor
  // question, expected to stay in the render.
  const markerBlock = pick(["minecraft:diamond_block", "minecraft:netherite_block", "minecraft:beacon"]);
  const markerPos = [regions[0].start[0], stage.Y + 1, regions[0].start[2]];

  // EXPLORE_PROMPT_VERSION 2 (2026-07-30). v1 read: "Survey these 4 raised platforms (all at
  // y=200)" and listed each waypoint as `(x, 200, z)` — handing the agent the SLAB's coordinate and
  // asking what is built there. Agents did what they were told: they read y=200, found cobblestone,
  // and recorded the slab. Measured over three seeds, captured structure-layer priors (y>=201, the
  // only ones any question is about) were 54 / 0 / 2 cells — the shared corpus was dark or nearly
  // dark in two of three seeds, and every arm quizzing it inherited that.
  //
  // This is the 0.9.5 `anchor` defect ("a coordinate that is not the answer's coordinate invites that
  // answer"), which was fixed in the CHANGE-QUIZ prompt at 0.9.7 and left standing here — where it
  // costs more, because explore builds the ONE corpus all arms share. The wording below is the quiz
  // prompt's own ON-TOP framing, mirrored, so both halves of the scenario describe the same world.
  const patrolPrompt = (n, region) =>
    `Patrol duty, region ${n} of 3. Survey these 4 raised platforms; at each, record exactly what is ` +
    `built there — block type, exact count or height, and position:\n` +
    `Each platform is a raised slab of stone or cobblestone whose surface is at y=${stage.Y}. Anything ` +
    `built there stands ON TOP of that slab, at y=${stage.Y + 1} and above. The slab itself is never ` +
    `what you are recording; a platform with nothing standing on it is empty.\n` +
    region.wps.map(([x, z], i) =>
      `  R${n}-W${i + 1}: slab surface (${x}, ${stage.Y}, ${z}), so look at y=${stage.Y + 1} and up`).join("\n") +
    `\nEmpty platforms count as "empty". Note the region number with each observation. Finish with a ` +
    `one-line region summary. Before ending, follow your memory discipline (compact if a render says so).`;

  // The six gradient questions. `truth` is by construction; `score(answer)` is mechanical.
  const questions = [
    {
      id: "anchor", tier: "easy",
      // Print markerPos[1] (the marker block's OWN y), not stage.Y (the platform under it). Printing
      // the platform's y next to the words "on top of" made three independent sessions answer with
      // the platform body (polished_andesite) instead of the marker: a coordinate that is not the
      // answer's coordinate invites exactly that, and a reproducible wrong answer is a question
      // defect, not a capability result.
      ask: `- "anchor": the block type of the START marker itself, resting on top of the marker platform, at (${markerPos[0]}, ${markerPos[1]}, ${markerPos[2]}) (a block id string)`,
      truth: markerBlock.replace("minecraft:", ""),
      score: (a) => { const ok = strEq(a?.anchor, markerBlock); return { exact: ok, close: ok }; },
    },
    {
      id: "where", tier: "medium",
      ask: `- "where": the [x, y, z] position of any block of the GOLD cluster you saw (integer array)`,
      truth: factBase(facts.gold),
      score: (a) => { const m = posMatch(a?.where, factBase(facts.gold), 3); return { exact: m.exact, close: m.close }; },
    },
    {
      id: "count", tier: "medium",
      ask: `- "count": how many blocks were in the EMERALD cluster (a number)`,
      truth: facts.emerald.count,
      score: (a) => ({ exact: numEq(a?.count, facts.emerald.count), close: numNear(a?.count, facts.emerald.count, 1) }),
    },
    {
      id: "region", tier: "hard",
      ask: `- "region": which region number (1, 2, or 3) held the BOOKSHELF tower (a number)`,
      truth: facts.bookshelf.region + 1,
      score: (a) => ({ exact: numEq(a?.region, facts.bookshelf.region + 1), close: numEq(a?.region, facts.bookshelf.region + 1) }),
    },
    {
      id: "breadth", tier: "hard",
      // "you recorded" was ungradeable: it asks about the agent's own log but scores against
      // construction truth, so an agent that wrote down two and honestly answered two was marked
      // wrong. Construction truth is the only mechanically scorable target, so the wording now
      // matches what is actually graded.
      ask: `- "breadth": how many DISTINCT non-empty structures are present in region 3 (a number)`,
      truth: Object.values(facts).filter((f) => f.region === 2).length,
      score: (a) => { const t = Object.values(facts).filter((f) => f.region === 2).length; return { exact: numEq(a?.breadth, t), close: numNear(a?.breadth, t, 1) }; },
    },
    {
      id: "stale", tier: "hard",
      ask: `- "stale": the CURRENT contents of the depot chest near (${depot[0]}, ${stage.Y}, ${depot[1]}) as {"item": id, "count": n, "pos": [x,y,z]} — verify against the world, do not trust an old memory`,
      truth: { item: newItem, count: newCount, pos: chestNew },
      score: (a) => {
        const g = a?.stale ?? {};
        const p = posMatch(g.pos, chestNew, 3);
        return { exact: strEq(g.item, newItem) && numEq(g.count, newCount) && p.close, close: strEq(g.item, newItem) && p.close };
      },
    },
  ];

  // --- the change-detection rung (OBSERVATION_MEMORY_DESIGN §6 prediction 2) ----------------------
  // "What changed here since my last visit" is the one question no live read can answer without a
  // recorded prior — which is why the pre-registration puts the weight of the experiment on it, and
  // why it gets its OWN workflow rather than a seventh question in the existing quiz: adding a rung
  // to the shared answer block would change the prompt every arm sees and move the 0.9.5 baseline
  // that predictions 1 and 3 are measured against. Same corpus, same explore pass, separate quiz.
  //
  // Probes live in regions 1 and 2 only. Region 3 backs `breadth`, whose truth is a construction
  // count, so mutating it would make the recall/revisit truths depend on the order the workflows ran.
  const GROW_BY = 3;
  const APPEARED = "minecraft:sponge"; // absent from the fact palette — unmistakable when it shows up
  const stateOf = (f) => ({ block: f.block, n: f.kind === "tower" ? f.height : f.count });
  // before → after, by construction. `null` = a bare platform.
  const probes = [
    { id: "chg_grew", region: 0, wp: 3, kind: "grow", fact: "hay",
      before: stateOf(facts.hay), after: { block: facts.hay.block, n: facts.hay.count + GROW_BY } },
    { id: "chg_vanished", region: 1, wp: 2, kind: "remove", fact: "woolPatch",
      before: stateOf(facts.woolPatch), after: null },
    { id: "chg_appeared", region: 1, wp: 1, kind: "appear", fact: null,
      before: null, after: { block: APPEARED, n: 3 } },
    // The false-positive guard. Without it, "everything changed" scores 3/4 — and an agent with no
    // usable prior has every incentive to say exactly that.
    { id: "chg_same", region: 0, wp: 1, kind: "same", fact: "gold",
      before: stateOf(facts.gold), after: stateOf(facts.gold) },
  ].map((p) => ({
    ...p,
    label: `R${p.region + 1}-W${p.wp + 1}`,           // the patrol prompt's own vocabulary
    pos: [regions[p.region].wps[p.wp][0], stage.Y, regions[p.region].wps[p.wp][1]],
    changed: p.kind !== "same",
  }));
  // fact key → change-probe id, for the pipeline funnel's `used_correctly` join under this workflow.
  const PROBE_OF_FACT = Object.fromEntries(probes.filter((p) => p.fact).map((p) => [p.fact, p.id]));

  // The change rung's question set, in the same shape the gradient uses (id + truth), so
  // total_questions and the manifest's questions_hash are workflow-aware without a second mechanism.
  const changeQuestions = [
    ...probes.map((p) => ({
      id: p.id, tier: p.kind === "same" ? "hard" : "medium",
      truth: { changed: p.changed, was: p.before, now: p.after },
    })),
    { id: "chg_now", tier: "easy", truth: probes.length },
  ];

  // Listed in patrol order, not probe order — the quiz is about memory, not about route-planning.
  const probesInOrder = [...probes].sort((a, b) => a.region - b.region || a.wp - b.wp);
  // The subject is the STRUCTURE, stated explicitly and given its own y (bench 0.9.7). v1 printed the
  // platform's y beside "what has happened to them", and a session answered `stone` / `cobblestone`
  // for all four probes — the platform slabs — scoring 0/5 with five confident wrongs. That is
  // precisely the 0.9.5 `anchor` defect: a coordinate that is not the answer's coordinate invites
  // exactly that answer. It bites harder here because the quiz session is FRESH — it never saw the
  // patrol prompt, so the "raised platform, record what is built on it" convention is nowhere in its
  // context and must be restated. A reproducible wrong answer is a question defect, not a result.
  const changePrompt =
    `Return visit. You patrolled these platforms earlier; report what has happened to the STRUCTURES ` +
    `built on them since.\n` +
    `Each platform is a raised slab of stone or cobblestone whose surface is at y=${stage.Y}. Anything ` +
    `built there stands ON TOP of that slab, at y=${stage.Y + 1} and above. The slab itself is never ` +
    `the answer; a platform with nothing standing on it is bare.\n` +
    probesInOrder.map((p) => `  ${p.label}: slab surface (${p.pos[0]}, ${stage.Y}, ${p.pos[2]}), so look at y=${stage.Y + 1} and up`).join("\n") +
    `\nFor EACH platform, establish what was standing there when you last observed it, read what is ` +
    `standing there NOW, and say whether they differ.\n` +
    `Report exactly this JSON:\n` +
    "```json\n" +
    // Placeholders, not values: a template showing `true` in four slots is itself a nudge toward
    // answering true four times, and `chg_same` exists precisely to catch that.
    `{"changes": {\n${probesInOrder.map((p) => `  "${p.label}": {"changed": true|false, "was": {"block": "id", "n": n}, "now": {"block": "id", "n": n}}`).join(",\n")}\n}}\n` +
    "```\n" +
    `- "was" is the structure you last OBSERVED standing there; "now" is the structure standing there ` +
    `on this visit. Each is {"block": id, "n": n} where n is the block COUNT for a flat cluster or ` +
    `the HEIGHT for a tower — or null if the platform was/is bare. Never report the slab.\n` +
    `- "changed" is whether "was" and "now" differ.\n` +
    `- If you genuinely cannot establish what was there before, write null for "was" and null for ` +
    `"changed". An honest unknown is a real answer; a guessed prior is not.`;

  // The answer contract is identical across workflows — only the ROUTE to the answer differs.
  const answerBlock =
    `Report exactly this JSON (use null for anything you genuinely do not know — never guess):\n` +
    "```json\n" +
    `{"anchor": "block_id", "where": [x,y,z], "count": n, "region": n, "breadth": n,\n` +
    ` "stale": {"item": "id", "count": n, "pos": [x,y,z]}}\n` +
    "```\n" +
    questions.map((q) => q.ask).join("\n");

  // Two WORKFLOWS over one corpus, one question set, one set of truths (design call, 2026-07-27):
  //   recall  — answer from memory alone. Measures recall DEPTH: what survived compaction.
  //   revisit — memory may LOCATE; the world must be re-read before answering. Measures whether
  //             memory is a good enough INDEX to get you back to the fact.
  // Orthogonal to the `arch` axis, which ablates the recall TOOL; this ablates the WORKFLOW, so the
  // two compose. Motive: five of six questions ask for values good design would re-derive (an exact
  // block id, an exact count, an exact position), and only `stale` — whose prior is gone, so it
  // cannot be re-derived — mandates verifying. `recall` therefore grades eager memorization, which
  // may be an anti-pattern rather than a capability. `revisit` reads a failure as "memory couldn't
  // get me back", which is the stronger claim. Note `breadth` ("structures YOU RECORDED") is graded
  // against what EXISTS — incoherent under `recall`, coherent under `revisit` where you re-count.
  const QUIZ_PROMPT = {
    recall:
      `Debrief across all three patrol regions. Answer from MEMORY — do NOT re-fly to the fact ` +
      `platforms or re-survey them. The ONE exception is the depot chest: its state may have ` +
      `changed, so you SHOULD verify it against the world before answering "stale".\n` + answerBlock,
    revisit:
      `Debrief across all three patrol regions. Your memory is an INDEX, not the answer: use it to ` +
      `work out WHERE to look, then fly there and READ THE WORLD to confirm every value before you ` +
      `report it. Do not report a remembered value you have not re-verified. If memory cannot get ` +
      `you back to the place at all, answer null for that question rather than guessing — that is a ` +
      `real result, not a failure to try. The depot chest may have MOVED since you last saw it.\n` +
      answerBlock,
    // `change` asks a question the other two cannot: it needs a PRIOR, and no amount of looking
    // supplies one. Both arms must re-read the world to get "now", so the live half is a built-in
    // control and the remembered half is the whole test.
    change: changePrompt,
  };

  const quizEpisodeFor = (workflow = "recall") => {
    const prompt = QUIZ_PROMPT[workflow];
    if (!prompt) throw new Error(`unknown quiz workflow "${workflow}" (recall|revisit|change)`);
    return {
      key: workflow === "recall" ? "quiz" : `quiz-${workflow}`,
      // 24 was too tight for haiku: seed-2's quiz capped at 25 with NO committed JSON answer, so
      // every question scored a false abstain. 34 leaves room to drill mem_read and still answer;
      // `revisit` must actually TRAVEL three regions, so its advisory is higher. Both are ADVISORY
      // only — session-guards' runawayBound is max(advisory, 200) — never a budget (FREEZE_PLAN A5).
      // `change` must reach 4 platforms across 2 regions and read each one, so it travels like
      // `revisit` does.
      maxTurns: workflow === "recall" ? 34 : 90,
      // Drone parks at region 0 start. Under `recall` it may fly only to verify the depot chest;
      // under `revisit`/`change` travel is the point.
      dronePos: { x: regions[0].start[0], y: regions[0].start[1], z: regions[0].start[2] },
      prompt,
    };
  };

  return {
    name: "mem-depth",
    seed,
    forceloaded: null, // filled by setup()
    params: { regions, facts, depot, chestOld, chestNew, oldItem, oldCount, newItem, newCount, markerBlock, markerPos },
    dronePos: { x: regions[0].start[0], y: regions[0].start[1], z: regions[0].start[2] },

    // Facts the pipeline funnel tracks (demotion assertions run over these). Pattern is matched
    // case-insensitively against L0 note text / block prose.
    facts: Object.entries(facts).map(([key, f]) => ({
      key,
      pattern: `${key}|${f.block.replace("minecraft:", "")}`,
      pos: factBase(f),
      // Which quiz question this fact ANSWERS, or null when no question is 1:1 with it. The funnel's
      // last stage (`used_correctly`) needs this join: fact keys (gold, emerald…) and question ids
      // (where, count…) are different key spaces, and indexing per_question by a fact key silently
      // yields undefined for EVERY fact — a constant-false final column.
      question: QUESTION_OF_FACT[key] ?? null,
    })),

    questions,

    async setup() {
      // Each region is far-out VIRGIN terrain (~116k blocks). One giant forceload spanning all
      // three regions triggers thousands of virgin worldgen chunks on one tick and blows the 15s
      // bridge timeout — so generate each region's own small rect with the Category-T strip-batched
      // loader (ensureGenerated: 32-block z-strips, per-strip residency poll, full verification
      // sweep). Regions load independently (1024 apart; the drone patrols within a region, never
      // between), so the inter-region gaps stay ungenerated and cheap.
      this.forceloaded = [];
      for (const reg of regions) {
        const xs = [reg.start[0], ...reg.wps.map((w) => w[0])];
        const zs = [reg.start[2], ...reg.wps.map((w) => w[1])];
        const rect = [Math.min(...xs) - 40, Math.min(...zs) - 40, Math.max(...xs) + 40, Math.max(...zs) + 40];
        await ensureGenerated(...rect);
        this.forceloaded.push(rect);
      }
      await stage.lockConditions();

      for (const reg of regions) {
        await stage.platform(reg.start[0], reg.start[2], 3, "minecraft:polished_andesite");
        for (let i = 0; i < reg.wps.length; i++) {
          await stage.platform(reg.wps[i][0], reg.wps[i][1], 3, i % 2 ? "minecraft:stone" : "minecraft:cobblestone");
        }
      }
      // Start marker (anchor question).
      await cmd(`setblock ${markerPos[0]} ${markerPos[1]} ${markerPos[2]} ${markerBlock}`);
      // Fact structures.
      for (const f of Object.values(facts)) {
        const [x, z] = factWp(f);
        if (f.kind === "tower") await stage.tower(x, z, f.block, f.height);
        else await stage.cluster(x, z, f.block, f.count);
      }
      // Depot chest (old site stocked; new site cleared, ready for mutate()).
      await stage.clear(chestNew[0] - 1, stage.Y, chestNew[2] - 1, chestNew[0] + 1, stage.Y + 3, chestNew[2] + 1);
      await stage.chest(chestOld[0], chestOld[2], oldItem, oldCount);
    },

    // Explore sessions build the corpus — one per region. maxTurns generous: the corpus must be
    // deep, and haiku is turn-hungrier than the Sonnet the ablation tuned for (seed-2's e2 capped
    // at 35 and never recorded region 2 — the whole-seed collapse). 45 gives the slower model room.
    exploreEpisodes: regions.map((reg, k) => ({
      key: `e${k + 1}`,
      maxTurns: 45,
      prompt: patrolPrompt(k + 1, reg),
      // Each explore session spawns on its own region's start platform.
      dronePos: { x: reg.start[0], y: reg.start[1], z: reg.start[2] },
    })),

    // Between explore and quiz, drone despawned: move + restock the depot chest.
    async mutate() {
      await cmd(`setblock ${chestOld[0]} ${chestOld[1]} ${chestOld[2]} minecraft:air`);
      await cmd(`setblock ${chestNew[0]} ${chestNew[1]} ${chestNew[2]} minecraft:chest`);
      await cmd(`item replace block ${chestNew[0]} ${chestNew[1]} ${chestNew[2]} container.0 with ${newItem} ${newCount}`);
    },

    probes,

    /** The `change` workflow's world mutation — applied ONCE per seed, immediately before the first
     *  change-workflow quiz and therefore AFTER every recall/revisit arm has run (run-memory orders
     *  the workflows for exactly this reason). It rewrites the probe platforms only; the recall
     *  truths live elsewhere, so a run that never selects `change` never touches them. */
    async mutateFacts() {
      for (const p of probes) {
        const [x, , z] = p.pos;
        if (p.kind === "grow") await stage.cluster(x, z, p.after.block, p.after.n); // prefix layout ⇒ superset
        // Clear the whole cluster footprint (the 3x3 the stage vocabulary can occupy), not just the
        // centre column — the vanish probe is a flat cluster as of 0.9.7, not a 1x1 tower.
        else if (p.kind === "remove") await stage.clear(x - 1, stage.Y + 1, z - 1, x + 1, stage.Y + 8, z + 1);
        else if (p.kind === "appear") await stage.cluster(x, z, p.after.block, p.after.n);
      }
    },

    quizEpisodeFor,
    quizEpisode: quizEpisodeFor("recall"), // back-compat: the default workflow

    /** The questions a workflow actually asks (recall/revisit share the gradient; change has its
     *  own). Drives the row's `total_questions` and the manifest's questions_hash. */
    questionsFor: (workflow = "recall") => (workflow === "change" ? changeQuestions : questions),

    /** fact key → the question id that fact answers under this workflow, or null. Fact keys and
     *  question ids are different key spaces; indexing one by the other silently yields undefined for
     *  EVERY fact, which reads as a constant-false `used_correctly` column. */
    questionOfFact: (workflow = "recall") => (workflow === "change" ? PROBE_OF_FACT : QUESTION_OF_FACT),

    scoreFor(workflow = "recall") {
      return workflow === "change" ? this.scoreChange.bind(this) : this.score.bind(this);
    },

    /** Mechanical scoring of the change rung. Three axes per probe, kept SEPARATE on purpose:
     *   `now`  — read live this visit. Both arms can get it by looking; it is the control that says
     *            the session actually went and looked, so a floor here indicts the episode, not memory.
     *   `was`  — the prior. Nothing in the live world supplies it. This is the measurement.
     *   flag   — whether the two differ, which is only meaningful when the prior is.
     *  A probe scores `exact` only when the flag AND the prior are both right: a correct verdict
     *  reached from a wrong prior is a coin flip, not change detection. */
    scoreChange(finalText, quizTranscript) {
      const answer = extractJson(finalText);
      const got = answer?.changes ?? {};
      const per = {};
      let correct = 0, confWrong = 0, abstained = 0;
      const detail = {};
      let nowHits = 0, nowGiven = 0;
      for (const p of probes) {
        const g = got[p.label] ?? {};
        const wasOk = stateMatch(g.was, p.before, false);
        const nowOk = stateMatch(g.now, p.after, false);
        const flagOk = typeof g.changed === "boolean" && g.changed === p.changed;
        // Abstention is the honest unknown the prompt offers: no verdict AND no claimed prior.
        const isNull = (g.changed === null || g.changed === undefined) && !isState(g.was);
        const exact = flagOk && wasOk;
        per[p.id] = {
          tier: p.kind === "same" ? "hard" : "medium",
          exact, close: flagOk, abstained: isNull,
          answer: { changed: g.changed ?? null, was: g.was ?? null, now: g.now ?? null },
          truth: { changed: p.changed, was: p.before, now: p.after },
        };
        detail[p.label] = { kind: p.kind, flag_ok: flagOk, was_ok: wasOk, now_ok: nowOk };
        if (exact) correct++;
        else if (isNull) abstained++;
        else confWrong++;
        if (isState(g.now) || g.now === null) nowGiven++;
        if (nowOk) nowHits++;
      }
      // The live-read control: one row, exact only when every `now` is right. A capture arm and a
      // control arm should BOTH sit at ceiling here; if they don't, the rung is measuring travel.
      const nowExact = nowHits === probes.length;
      per.chg_now = {
        tier: "easy", exact: nowExact, close: nowHits >= probes.length - 1,
        abstained: nowGiven === 0, answer: nowHits, truth: probes.length,
      };
      if (nowExact) correct++; else if (nowGiven === 0) abstained++; else confWrong++;

      const obsCalls = toolCalls(quizTranscript).filter((c) => OBS_TOOL_NAMES.has(c.name)).length;
      return {
        answer,
        per_question: per,
        correct, confident_wrong: confWrong, abstained,
        by_tier: tierRollup(per),
        change_detail: detail,
        probe_scores: { now_correct: nowHits, probes: probes.length },
        // Free-choice vs forced turns on this number: the 2026-07-27 smoke exposed the obs tools and
        // the agent called them zero times, so "did it even reach for the surface" is a reported
        // result, not a diagnostic.
        retrieval_calls: {
          mem_recall: toolCalls(quizTranscript).filter((c) => c.name === "mem_recall").length,
          mem_read: toolCalls(quizTranscript).filter((c) => c.name === "mem_read").length,
          obs_tools: obsCalls,
        },
        remembered_served: rememberedServed(quizTranscript),
        staleness: { verified_chest: null, stale_assumption: false, contradiction_recorded: false },
        flags: forbiddenCommands(quizTranscript).map((c) => `forbidden_command:${c}`),
        truth: Object.fromEntries(probes.map((p) => [p.label, { changed: p.changed, was: p.before, now: p.after }])),
      };
    },

    /** Mechanical scoring of one quiz answer against the gradient. Returns per-question + rollups. */
    score(finalText, quizTranscript) {
      const answer = extractJson(finalText);
      const per = {};
      let correct = 0, confWrong = 0, abstained = 0;
      for (const q of questions) {
        const provided = answer?.[q.id] ?? null;
        const isNull = provided === null || provided === undefined;
        const s = q.score(answer ?? {});
        per[q.id] = { tier: q.tier, exact: !!s.exact, close: !!s.close, abstained: isNull, answer: provided, truth: q.truth };
        if (s.exact) correct++;
        else if (isNull) abstained++;
        else confWrong++;
      }
      // Staleness taxonomy (reused from stale-fact): did the agent re-observe the chest before
      // reporting it? A remembered-old answer without verification is a stale_assumption.
      const verifiedChest =
        perceivedNear(quizTranscript, chestOld, 24) || dataReadNear(quizTranscript, chestOld, 6) ||
        perceivedNear(quizTranscript, chestNew, 24) || dataReadNear(quizTranscript, chestNew, 6);
      const staleAns = answer?.stale ?? {};
      const reportedOld = posMatch(staleAns.pos, chestOld, 3).close || strEq(staleAns.item, oldItem);
      const staleAssumption = reportedOld && !verifiedChest;
      const memVerifies = toolCalls(quizTranscript).filter((c) => c.name === "mem_verify");
      const contradictionRecorded = memVerifies.some((c) => c.input?.result === "contradicted");
      const recallCalls = toolCalls(quizTranscript).filter((c) => c.name === "mem_recall").length;
      const readCalls = toolCalls(quizTranscript).filter((c) => c.name === "mem_read").length;
      // Reported for EVERY arm, not just the capture ones: on a `full` arm this is structurally 0
      // (the tools are not exposed), and on a capture arm a 0 is the finding — the first paired smoke
      // exposed the surface and the agent never touched it.
      const obsCalls = toolCalls(quizTranscript).filter((c) => OBS_TOOL_NAMES.has(c.name)).length;

      return {
        answer,
        per_question: per,
        correct, confident_wrong: confWrong, abstained,
        by_tier: tierRollup(per),
        staleness: { verified_chest: verifiedChest, stale_assumption: staleAssumption, contradiction_recorded: contradictionRecorded },
        retrieval_calls: { mem_recall: recallCalls, mem_read: readCalls, obs_tools: obsCalls },
        remembered_served: rememberedServed(quizTranscript),
        flags: forbiddenCommands(quizTranscript).map((c) => `forbidden_command:${c}`),
        truth: Object.fromEntries(questions.map((q) => [q.id, q.truth])),
      };
    },
  };
}

// --- scoring helpers ------------------------------------------------------------------------------
// Block ids come back from the world carrying their STATE, and an agent quoting what it read is
// quoting that: the change rung's hay cluster reads as `minecraft:hay_block[axis=y]`, so a bare
// id-vs-id compare would mark a verbatim-correct answer wrong. That is a question defect, not a
// capability result (the same shape as 0.9.5's `anchor` fix), so ids are normalized to the plain
// registry name — namespace, block-state suffix and nbt suffix all stripped — on both sides.
const blockId = (v) => String(v).replace("minecraft:", "").split("[")[0].split("{")[0].trim();
const strEq = (a, b) => typeof a === "string" && blockId(a) === blockId(b);
const numEq = (a, b) => typeof a === "number" && a === b;
const numNear = (a, b, tol) => typeof a === "number" && Math.abs(a - b) <= tol;

// The captured-observation query surface, for the "did the arm reach for it at all" column.
// HISTORICAL: these three tools were deleted in MEMORY_REDESIGN §3. The counter stays so old result
// dirs keep reporting the same number — obs-report reads corpora from before the consolidation.
const OBS_TOOL_NAMES = new Set(["mem_seen", "mem_changes", "mem_last_seen"]);

/**
 * §8 prediction 1 is a STRUCTURAL claim about delivery: was a remembered annotation actually SERVED
 * on the reads this session made? It is counted from the `remembered_served` marker the shim
 * attaches to the tool result — never by parsing prose, which would make the headline number a
 * function of wording. `kinds` splits delta (the change-detection mechanism) from fill/search, so
 * "the appendix fired" cannot be satisfied by an unrelated case.
 */
function rememberedServed(transcript) {
  const out = { total: 0, delta: 0, fill: 0, search: 0, by_tool: {} };
  for (const row of transcript ?? []) {
    if (row.type !== "tool") continue;
    const res = row.result?.result;
    if (!res || res.remembered_served !== true) continue;
    out.total++;
    out.by_tool[row.name] = (out.by_tool[row.name] ?? 0) + 1;
    for (const k of res.remembered_kinds ?? []) if (k in out) out[k]++;
  }
  return out;
}

/** Did the agent report a platform state at all? `{block, n}` counts; null/absent does not. */
const isState = (g) => !!g && typeof g === "object" && (g.block != null || g.n != null);

/**
 * Compare a reported platform state against a truth state. A bare platform is truth `null`, and the
 * agent may express it as null, {block:null}, or {block:null,n:null} — all three are the same claim.
 * `tol` allows the ±1 near-miss used for the `close` column; exact scoring passes false.
 */
function stateMatch(got, truth, near = false) {
  const empty = (v) => v === null || v === undefined || (typeof v === "object" && v.block == null && v.n == null);
  if (truth === null) return empty(got);
  if (empty(got)) return false;
  if (!strEq(got.block, truth.block)) return false;
  return near ? numNear(got.n, truth.n, 1) : numEq(got.n, truth.n);
}

function tierRollup(per) {
  const out = {};
  for (const { tier, exact } of Object.values(per)) {
    out[tier] ??= { n: 0, correct: 0 };
    out[tier].n++;
    if (exact) out[tier].correct++;
  }
  return out;
}
