// The change-detection rung + the instrument guard that made it safe to trust a Category C row.
// Offline: no server, no model, no bench dir. Run: node --test testbench/mem-change.test.mjs
//
// What these lock down, in the order the experiment depends on them:
//   1. the change rung scores the PRIOR, not the verdict — "everything changed" must not pass;
//   2. the recall/revisit quiz is untouched by the rung's existence (the §6 baseline survives);
//   3. a session that opens without its tool surface is CENSORED, not scored.

import { test } from "node:test";
import assert from "node:assert/strict";

import { makeMemScenario } from "./mem-scenario.mjs";
import { buildSystemPrompt, assertPromptNesting, PROMPT_CHAIN } from "../ablation/charter.mjs";
import { CONDITIONS } from "../ablation/conditions.mjs";
import { toolSurfaceFailure, isCensoredSubtype, CENSORED_SUBTYPES } from "./session-guards.mjs";
import { expandRow, expectedUnitIds } from "./ratchet.mjs";
import { C_CHANGE_UNIT_IDS, UNITS } from "./registry.mjs";
import { completedCells, corpusOnDisk } from "./resume.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const S = makeMemScenario(1);
const P = Object.fromEntries(S.probes.map((p) => [p.id, p]));
const json = (o) => "```json\n" + JSON.stringify(o) + "\n```";
/** A full change answer built from the truths, with per-probe overrides. */
const answerFrom = (over = {}) => json({
  changes: Object.fromEntries(S.probes.map((p) => [
    p.label,
    over[p.id] !== undefined ? over[p.id] : { changed: p.changed, was: p.before, now: p.after },
  ])),
});
const scoreChange = (text) => S.scoreChange(text, []);

// ---- 1. the rung scores the prior ---------------------------------------------------------------

test("a fully correct answer scores every probe plus the live-read control", () => {
  const r = scoreChange(answerFrom());
  assert.equal(r.correct, 5);
  assert.equal(r.confident_wrong, 0);
  assert.equal(r.abstained, 0);
  for (const id of C_CHANGE_UNIT_IDS) assert.equal(r.per_question[id].exact, true, id);
});

test('"everything changed" fails the unchanged control — the false-positive guard bites', () => {
  // The cheapest strategy available to an agent with no usable prior: claim change everywhere.
  const r = scoreChange(answerFrom({
    chg_same: { changed: true, was: P.chg_same.before, now: P.chg_same.after },
  }));
  assert.equal(r.per_question.chg_same.exact, false);
  assert.equal(r.per_question.chg_same.abstained, false, "a wrong claim is confident-wrong, not an abstain");
  assert.equal(r.confident_wrong, 1);
});

test("a right verdict reached from a WRONG prior does not score — that is the whole measurement", () => {
  const wrongCount = { block: P.chg_grew.before.block, n: P.chg_grew.before.n + 2 };
  const r = scoreChange(answerFrom({
    chg_grew: { changed: true, was: wrongCount, now: P.chg_grew.after },
  }));
  assert.equal(r.per_question.chg_grew.close, true, "the verdict was right");
  assert.equal(r.per_question.chg_grew.exact, false, "but the count it rests on was not");
});

test("the live-read control is independent of the prior: perfect `now`, absent `was`", () => {
  // This is exactly the shape an arm with no recorded prior should produce if it answers honestly:
  // it flies, it reads, it declines to invent a past.
  const r = scoreChange(answerFrom(Object.fromEntries(
    S.probes.map((p) => [p.id, { changed: null, was: null, now: p.after }]),
  )));
  assert.equal(r.per_question.chg_now.exact, true, "looking works");
  for (const p of S.probes) {
    assert.equal(r.per_question[p.id].exact, false);
    assert.equal(r.per_question[p.id].abstained, true, "declared unknown, not guessed");
  }
  assert.equal(r.confident_wrong, 0);
  assert.equal(r.abstained, 4);
});

test("a bare platform may be expressed as null, {block:null} or {block:null,n:null}", () => {
  for (const empty of [null, { block: null }, { block: null, n: null }]) {
    const r = scoreChange(answerFrom({
      chg_appeared: { changed: true, was: empty, now: P.chg_appeared.after },
      chg_vanished: { changed: true, was: P.chg_vanished.before, now: empty },
    }));
    assert.equal(r.per_question.chg_appeared.exact, true, `appeared/${JSON.stringify(empty)}`);
    assert.equal(r.change_detail[P.chg_vanished.label].now_ok, true, `vanished/${JSON.stringify(empty)}`);
  }
});

test("a claimed prior on a platform that was bare is a confident wrong, never an abstain", () => {
  const r = scoreChange(answerFrom({
    chg_appeared: { changed: false, was: { block: "minecraft:sponge", n: 3 }, now: P.chg_appeared.after },
  }));
  assert.equal(r.per_question.chg_appeared.abstained, false);
  assert.equal(r.per_question.chg_appeared.exact, false);
});

test("block ids match with or without the minecraft: namespace; counts must be exact", () => {
  const bare = { block: P.chg_grew.before.block.replace("minecraft:", ""), n: P.chg_grew.before.n };
  assert.equal(scoreChange(answerFrom({ chg_grew: { changed: true, was: bare, now: P.chg_grew.after } }))
    .per_question.chg_grew.exact, true);
  // The world returns hay as `minecraft:hay_block[axis=y]`; an agent quoting its own read must not be
  // marked wrong for quoting it accurately.
  const withState = { block: `${P.chg_grew.before.block}[axis=y]`, n: P.chg_grew.before.n };
  assert.equal(scoreChange(answerFrom({ chg_grew: { changed: true, was: withState, now: P.chg_grew.after } }))
    .per_question.chg_grew.exact, true, "a block-state suffix is not a wrong answer");
  const offByOne = { ...P.chg_grew.before, n: P.chg_grew.before.n + 1 };
  assert.equal(scoreChange(answerFrom({ chg_grew: { changed: true, was: offByOne, now: P.chg_grew.after } }))
    .per_question.chg_grew.exact, false, "±1 is not a correct count — exact values are the hypothesis");
});

test("a missing JSON block abstains everywhere rather than throwing", () => {
  const r = scoreChange("I could not complete the survey.");
  assert.equal(r.correct, 0);
  assert.equal(r.confident_wrong, 0, "reporting nothing is not a wrong claim");
  assert.equal(r.abstained, 5, "all four probes plus the live-read control");
});

test("obs-tool calls are counted for every arm, so zero uptake is reportable", () => {
  const transcript = [
    { type: "tool", name: "mem_seen", input: {} },
    { type: "tool", name: "mem_changes", input: {} },
    { type: "tool", name: "describe_box", input: {} },
  ];
  assert.equal(S.scoreChange(answerFrom(), transcript).retrieval_calls.obs_tools, 2);
  assert.equal(S.scoreChange(answerFrom(), []).retrieval_calls.obs_tools, 0);
  assert.equal(S.score("{}", transcript).retrieval_calls.obs_tools, 2, "recall arms report it too");
});

// ---- 2. the rung is additive — the 0.9.5 baseline survives ---------------------------------------

test("the probes never touch region 3, whose structure count is `breadth`'s truth", () => {
  for (const p of S.probes) assert.notEqual(p.region, 2, `${p.id} would move breadth's truth`);
});

test("the change rung leaves the recall/revisit quiz byte-identical", () => {
  assert.deepEqual(S.questionsFor("recall").map((q) => q.id), ["anchor", "where", "count", "region", "breadth", "stale"]);
  assert.equal(S.quizEpisodeFor("recall").prompt, S.quizEpisode.prompt);
  assert.ok(!S.quizEpisodeFor("recall").prompt.includes("Return visit"));
  assert.ok(!S.quizEpisodeFor("revisit").prompt.includes("Return visit"));
});

test("no probe is a TOWER — a tower's prior is truncated by a normal platform scan", () => {
  // bench 0.9.7. As a tower, `chg_vanished`'s prior spanned y=201..201+h (h 3..5) while explore
  // sessions scan a ~4-tall box, so the recorded prior was 2-of-5 in BOTH memory layers and the cell
  // graded scan height rather than recall. Flat structures at y=201 are caught by any platform box.
  for (let seed = 1; seed <= 12; seed++) {
    for (const p of makeMemScenario(seed).probes) {
      for (const st of [p.before, p.after]) {
        if (!st) continue;
        assert.ok(st.n <= 9, `seed ${seed} ${p.id}: n=${st.n} is not a flat cluster`);
      }
    }
  }
});

test("the change quiz never points at the slab — the 0.9.5 `anchor` defect must not return", () => {
  // v1 printed the platform's y beside "what has happened to them" and a session answered
  // stone/cobblestone for all four probes, scoring 0/5 with five confident wrongs. The quiz session
  // is FRESH: it never saw the patrol prompt, so the "structure on top" convention must be restated.
  const p = S.quizEpisodeFor("change").prompt;
  assert.match(p, /ON TOP/, "the prompt must say where the structure stands");
  assert.match(p, /slab itself is never the answer/i, "and say plainly what is NOT the answer");
  assert.match(p, new RegExp(`look at y=${201} and up`), "each probe line must give the structure's y");
  assert.match(p, /Never report the slab/i);
  // The slab materials the defective session actually reported.
  for (const m of ["stone", "cobblestone"]) assert.ok(p.includes(m), `the prompt should name the slab material ${m} as context`);
});

test("the change quiz names its platforms in patrol order and asks for a prior", () => {
  const p = S.quizEpisodeFor("change").prompt;
  for (const probe of S.probes) assert.ok(p.includes(probe.label), probe.label);
  assert.ok(p.includes("was") && p.includes("now"));
  assert.ok(/null for "was"/.test(p), "the honest-unknown escape must be offered, or abstention is not available");
  const order = S.probes.map((x) => ({ label: x.label, at: p.indexOf(`  ${x.label}:`) })).sort((a, b) => a.at - b.at);
  assert.deepEqual(order.map((o) => o.label), ["R1-W2", "R1-W4", "R2-W2", "R2-W3"]);
});

test("the funnel's fact→question map is workflow-specific (a shared map is constant-false)", () => {
  const recall = S.questionOfFact("recall");
  const change = S.questionOfFact("change");
  assert.equal(recall.gold, "where");
  assert.equal(change.gold, "chg_same");
  for (const [factKey, qid] of Object.entries(change)) {
    assert.ok(S.questionsFor("change").some((q) => q.id === qid), `${factKey}→${qid} is not a change question`);
    assert.ok(S.facts.some((f) => f.key === factKey), `${factKey} is not a tracked fact`);
  }
});

test("mutateFacts only grows a cluster it can grow — the stage lays out at most 9 blocks", () => {
  for (let seed = 1; seed <= 12; seed++) {
    for (const p of makeMemScenario(seed).probes) {
      if (p.after) assert.ok(p.after.n <= 9, `seed ${seed} ${p.id}: n=${p.after.n} exceeds the cluster layout`);
      if (p.kind === "grow") assert.ok(p.after.n > p.before.n);
    }
  }
});

test("every change unit is registered, so no row orphans the ratchet", () => {
  const ids = new Set(UNITS.filter((u) => u.cat === "C").map((u) => u.id));
  for (const q of S.questionsFor("change")) assert.ok(ids.has(q.id), `${q.id} has no registry unit`);
  assert.deepEqual([...C_CHANGE_UNIT_IDS].sort(), S.questionsFor("change").map((q) => q.id).sort());
});

test("a recall dir is not expected to hold change rows, and vice versa", () => {
  const recall = expectedUnitIds("C", { workflow: ["recall"] });
  const change = expectedUnitIds("C", { workflow: ["change"] });
  const both = expectedUnitIds("C", { workflow: ["recall", "change"] });
  assert.ok(recall.has("anchor") && !recall.has("chg_grew"));
  assert.ok(change.has("chg_grew") && !change.has("anchor"));
  assert.ok(both.has("anchor") && both.has("chg_grew"));
  // Pre-0.9.4 manifests have no workflow field and must resolve exactly as they always did.
  assert.deepEqual([...expectedUnitIds("C", { category: "c" })], [...recall]);
});

// ---- 3. conditions e and f differ by ONE thing ---------------------------------------------------

test("capture-forced has identical tools to capture and a strictly longer prompt", () => {
  assert.deepEqual(CONDITIONS.f.memTools, CONDITIONS.e.memTools);
  assert.ok(buildSystemPrompt("f").startsWith(buildSystemPrompt("e")));
  assert.ok(buildSystemPrompt("f").length > buildSystemPrompt("e").length);
});

test("the free-choice prompt does not steer, and the forced one does", () => {
  const e = buildSystemPrompt("e").slice(buildSystemPrompt("d").length);
  assert.ok(/mem_seen/.test(e), "e must still say the tools exist");
  assert.ok(!/FIRST|before answering|prefer/i.test(e), "e must not tell the agent to prefer them");
  const steer = buildSystemPrompt("f").slice(buildSystemPrompt("e").length);
  assert.ok(/FIRST/.test(steer));
});

test("the lattice is nested end to end", () => {
  assert.equal(assertPromptNesting(), true);
  assert.deepEqual(PROMPT_CHAIN, ["c", "d", "e", "f"]);
});

// ---- 4. the instrument guard ---------------------------------------------------------------------

const EXPECT = ["mem_note", "get_surface"];
const QUALIFIED = EXPECT.map((t) => `mcp__ablation__${t}`);
const surface = (o) => toolSurfaceFailure({ prefix: "mcp__ablation__", serverName: "ablation", expected: EXPECT, ...o });
const OK_SERVER = [{ name: "ablation", status: "connected" }];
// What a developer machine actually carries alongside the arm's own server.
const AMBIENT = [
  { name: "claude.ai Google Drive", status: "needs-auth" },
  { name: "claude.ai Gmail", status: "needs-auth" },
  { name: "claude.ai Google Calendar", status: "needs-auth" },
];

test("a healthy session open is not a failure", () => {
  assert.equal(surface({ tools: QUALIFIED, mcpServers: OK_SERVER }), null);
});

test("UNRELATED servers in needs-auth are not this arm's business", () => {
  // Met live on the first step-5 attempt: the guard aborted a session because the developer's
  // claude.ai servers were unauthenticated. Censoring a good session is the same defect as scoring
  // a blind one, pointed the other way — and a guard that cries wolf gets switched off.
  assert.equal(surface({ tools: QUALIFIED, mcpServers: [...OK_SERVER, ...AMBIENT] }), null);
});

test("the arm's own server missing from the list IS a failure", () => {
  assert.match(surface({ tools: QUALIFIED, mcpServers: AMBIENT }) ?? "", /absent from the session's server list/);
});

test("the exact 2026-07-27 signature is caught: pending server, zero tools", () => {
  const reason = surface({ tools: [], mcpServers: [{ name: "ablation", status: "pending" }, ...AMBIENT] });
  assert.match(reason ?? "", /not connected/);
  assert.match(reason ?? "", /ablation=pending/);
  assert.ok(!/Gmail/.test(reason ?? ""), "the reason must name the arm's server, not the ambient ones");
});

test("a connected server that serves nothing is still a failure", () => {
  assert.match(surface({ tools: [], mcpServers: OK_SERVER }) ?? "", /0 tools/);
});

test("a PARTIAL surface is a failure too — that is the silent-narrowing family", () => {
  assert.match(surface({ tools: ["mcp__ablation__mem_note"], mcpServers: OK_SERVER }) ?? "", /get_surface/);
});

test("an arm that expects no tools cannot be betrayed by an empty surface", () => {
  assert.equal(toolSurfaceFailure({ tools: [], mcpServers: [], expected: [] }), null);
});

test("no_tools joins the censored subtypes", () => {
  assert.ok(isCensoredSubtype("no_tools"));
  for (const s of ["stalled", "runaway", "error_max_turns"]) assert.ok(isCensoredSubtype(s), s);
  assert.ok(!isCensoredSubtype("success"));
  assert.ok(!isCensoredSubtype("answered"));
  assert.ok(CENSORED_SUBTYPES.includes("no_tools"));
});

test("a C row's terminal state reaches its per-question subrows (it never used to)", () => {
  const row = {
    seed: 1, arm: "capture", per_question: { anchor: { exact: true }, where: { exact: false, abstained: true } },
    quiz: { subtype: "no_tools", capped: true },
  };
  for (const sub of expandRow(row)) {
    assert.equal(sub.stop_reason, "no_tools");
    assert.equal(sub.capped, true);
  }
  const healthy = expandRow({ ...row, quiz: { subtype: "success", capped: false } });
  for (const sub of healthy) {
    assert.equal(sub.stop_reason, "answered");
    assert.equal(sub.capped, false);
  }
  // A row shape with no terminal state at all must not gain invented fields.
  const bare = expandRow({ seed: 1, per_question: { anchor: { exact: true } } })[0];
  assert.ok(!("stop_reason" in bare) && !("capped" in bare));
});

test("an instrument-failure cell is not complete — a resume re-runs it", () => {
  const key = (r) => `${r.seed}|${r.arm}`;
  const rows = [
    { seed: 1, arm: "full" },
    { seed: 1, arm: "capture", instrument_failure: "session opened with 0 tools while the arm expects 26" },
    { seed: 2, arm: "full", stop_reason: "stalled" },
  ];
  const done = completedCells(rows, key);
  assert.ok(done.has("1|full"));
  assert.ok(!done.has("1|capture"), "measured nothing ⇒ re-run");
  assert.ok(done.has("2|full"), "a stall is evidence about the session ⇒ keep it");
});

// ---- 5. the resume corpus predicate (found mid-run, 2026-07-28) ----------------------------------

test("corpusOnDisk sees the store's REAL layout — <memDir>/<world-uuid>/log.jsonl", () => {
  // The bug this pins: the check looked for <memDir>/log.jsonl, which the store never writes, so it
  // was always false and resume silently rebuilt each seed's corpus into the same directory —
  // layering a second explore pass on the first and quizzing later arms against a corpus no earlier
  // arm had seen. A false negative here is WORSE than no reuse at all.
  const root = mkdtempSync(join(tmpdir(), "memcorpus-"));
  const memDir = join(root, "memory");
  const world = join(memDir, "36046b64-9d65-4b4e-99d5-1a3ef91179e9");

  assert.equal(corpusOnDisk(root), false, "a dir that does not exist holds no corpus");
  mkdirSync(world, { recursive: true });
  writeFileSync(join(memDir, "last_world.json"), "{}");
  assert.equal(corpusOnDisk(memDir), false, "a world dir with no log is not a corpus");

  writeFileSync(join(world, "log.jsonl"), '{"kind":"obs","text":"gold_block x4"}\n');
  assert.equal(corpusOnDisk(memDir), true, "THE regression: the log is one level down, under the world uuid");

  // The shape the old check expected must not be the only shape that works, but it is still a corpus.
  const flat = join(root, "flat");
  mkdirSync(join(flat, "w"), { recursive: true });
  writeFileSync(join(flat, "w", "log.jsonl"), "{}\n");
  assert.equal(corpusOnDisk(flat), true);
  rmSync(root, { recursive: true, force: true });
});

test("a half-done seed reuses its corpus; a fresh seed does not", () => {
  // The decision the predicate feeds: reuse when arms remain, so every arm of a seed quizzes ONE
  // frozen corpus. Expressed here as the two states run-memory actually distinguishes.
  const root = mkdtempSync(join(tmpdir(), "memcorpus2-"));
  const half = join(root, "seed1", "memory", "world-a");
  mkdirSync(half, { recursive: true });
  writeFileSync(join(half, "log.jsonl"), "{}\n");
  mkdirSync(join(root, "seed2", "memory"), { recursive: true });

  assert.equal(corpusOnDisk(join(root, "seed1", "memory")), true, "seed 1 has a corpus → reuse it");
  assert.equal(corpusOnDisk(join(root, "seed2", "memory")), false, "seed 2 has none → build it");
  rmSync(root, { recursive: true, force: true });
});
