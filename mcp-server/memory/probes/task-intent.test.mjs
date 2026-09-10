// The task frame holds INTENT, not a report — enforced at the seam for the survival player.
//
// WHY THIS IS A PROBE AND NOT JUST A CHARTER LINE. `mem_task` is rendered back at every session
// open, so whatever it says is the first thing the player reads after a restart. Session w3-86528
// (2026-08-10) set it to "Session 1 complete. Stone tools ready. Underground exploration found no
// iron - need new strategy next session." — and from then on, every future wake in that world opened
// by reading a completion notice about itself. The handoff behaviour was feeding itself through
// memory: a frame that REPORTS teaches its reader to stop playing.
//
// Three properties, in order of how badly it would hurt to lose them:
//   1. The retrospective phrasings that actually showed up live are refused.
//   2. Ordinary intent — including sentences that merely contain the word "complete" as part of a
//      plan — is NOT refused. A lint that fires on legitimate play would be worse than none: the
//      player would learn the tool is broken and stop keeping the frame at all.
//   3. It is SURVIVAL-ONLY. The copilot workbench spawns and directs sessions for a living; telling
//      it that sessions are not real would be a lie in that role.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The lint sits inside the tool body, after world resolution — so the probe needs a world to exist.
// Minimal fake bridge: identity for resolveWorld, an empty event page for refreshPending.
const fakeBridge = async (tool) => {
  if (tool === "get_world_info") {
    return { ok: true, result: { world_uuid: "test-world-intent", name: "probe-world", game_tick: 1000 } };
  }
  if (tool === "get_events") {
    return { ok: true, result: { cursor: 0, events: [], missed: 0, more: false } };
  }
  return { ok: false, error: `unexpected tool in probe: ${tool}` };
};

/** tools.mjs reads MCPTK_PROFILE and MCPTK_MEMORY_DIR at module load, so each case needs its own
 *  module instance and its own memory root (ESM caches by specifier — hence the cache-buster). */
async function loadWith(profile, tag) {
  const root = await mkdtemp(join(tmpdir(), "mcintent-"));
  const prevProfile = process.env.MCPTK_PROFILE;
  const prevRoot = process.env.MCPTK_MEMORY_DIR;
  process.env.MCPTK_MEMORY_DIR = root;
  if (profile === undefined) delete process.env.MCPTK_PROFILE;
  else process.env.MCPTK_PROFILE = profile;
  const mod = await import(`../tools.mjs?intent=${tag}`);
  if (prevProfile === undefined) delete process.env.MCPTK_PROFILE;
  else process.env.MCPTK_PROFILE = prevProfile;
  if (prevRoot === undefined) delete process.env.MCPTK_MEMORY_DIR;
  else process.env.MCPTK_MEMORY_DIR = prevRoot;
  return { mod, root };
}

// Verbatim from the live transcript, plus the neighbouring phrasings of the same move.
const RETROSPECTIVES = [
  "Session 1 complete. Stone tools ready. Underground exploration found no iron - need new strategy next session.",
  "need new strategy next session",
  "Session 2 is done, handing off to the next session",
  "wrapping up: base established, iron pending",
  "Notes for the next agent: check the ravine at -230,60",
  "session complete",
];

// Real intents. Several deliberately contain words the lazy version of this regex would catch.
const INTENTS = [
  "digging a staircase to y=16 near (-230,70,-60) for iron",
  "walling in for the night at the base, then mining until dawn",
  "crafting a stone pickaxe to complete the tool set, then heading down",
  "returning to the death site at (-184,67,-59) to recover the dropped iron",
  "exploring west toward the locate frontier for a village",
];

test("survival: retrospective task frames are refused, with a corrective that names the fix", async () => {
  const { mod, root } = await loadWith("survival", "surv");
  try {
    for (const text of RETROSPECTIVES) {
      const set = await mod.callLocalTool("mem_task", { op: "set", goal: "Kill the Ender Dragon", state: text }, fakeBridge);
      assert.equal(set.ok, false, `state must be refused: ${text}`);
      assert.match(set.error, /^state: expected your CURRENT INTENT/);
      assert.match(set.error, /mem_note/, "the refusal has to say where the outcome DOES belong");

      const upd = await mod.callLocalTool("mem_task", { op: "update", state: text }, fakeBridge);
      assert.equal(upd.ok, false, `update must be refused too: ${text}`);

      // The goal field is the one that survives across wakes — it matters most of all.
      const goal = await mod.callLocalTool("mem_task", { op: "set", goal: text }, fakeBridge);
      assert.equal(goal.ok, false, `goal must be refused: ${text}`);
      assert.match(goal.error, /^goal: expected your CURRENT INTENT/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("survival: ordinary intent passes untouched", async () => {
  const { mod, root } = await loadWith("survival", "surv-ok");
  try {
    for (const text of INTENTS) {
      const r = await mod.callLocalTool("mem_task", { op: "set", goal: "Kill the Ender Dragon", state: text }, fakeBridge);
      assert.equal(r.ok, true, `must be allowed: ${text} (${r.error ?? ""})`);
      assert.equal(r.result.task.state, text);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("other roles are not linted — the workbench really does run sessions", async () => {
  for (const [profile, tag] of [[undefined, "none"], ["standard", "std"], ["full", "full"]]) {
    const { mod, root } = await loadWith(profile, tag);
    try {
      const r = await mod.callLocalTool("mem_task", {
        op: "set", goal: "supervise the build", state: "handing off the survey to the next session",
      }, fakeBridge);
      assert.equal(r.ok, true, `profile ${profile} must not be linted`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
