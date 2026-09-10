// Unit tests for the ablation harness's pure parts (no bridge, no API). The scenarios themselves
// are validated live via `node ablation/run.mjs --dry`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { CONDITIONS, AGENT_WORLD_TOOLS, LEGAL_WORLD_TOOLS, LOCATE_SUBSTITUTED_READS, PERCEPTION_TOOLS, tailOnlyRecent, assertMemToolsLive } from "./conditions.mjs";
import { extractJson, targetedAcquisition, forbiddenCommands, posMatch } from "./metrics.mjs";
import { buildSystemPrompt, assertPromptNesting, assertPromptPairs } from "./charter.mjs";
import { localTools } from "../memory/tools.mjs";

test("conditions form a strict nested lattice (each layer adds tools, never removes)", () => {
  const order = ["a", "b", "c", "d"];
  for (let i = 1; i < order.length; i++) {
    const prev = new Set(CONDITIONS[order[i - 1]].memTools);
    const cur = new Set(CONDITIONS[order[i]].memTools);
    for (const t of prev) assert.ok(cur.has(t), `${order[i]} must include ${t} from ${order[i - 1]}`);
    assert.ok(cur.size > prev.size, `${order[i]} must add at least one tool over ${order[i - 1]}`);
  }
  assert.ok(CONDITIONS.b.memTools.includes("mem_task"), "task frame belongs to B — the honest cheap competitor");
  assert.ok(!CONDITIONS.c.memTools.includes("mem_recall"), "recall is D's layer");
});

test("condition B render: explicit truncation banner, no blocks, no pending, task kept", () => {
  const tail = Array.from({ length: 30 }, (_, i) => `e-0000${String(i).padStart(2, "0")} tick ${i} (1,2,3) obs: filler observation number ${i} with some words in it`);
  const result = {
    render: [
      "## Memory @ tick 999 (world: w)",
      "[b-000001 L1 tick 1–2 r.0.0] some episode outcome (mem_read b-000001)",
      "[task] Current: patrol — leg 3 (since tick 1, updated tick 5)",
      "[pending] 2 event(s) not yet in memory — …",
      "  event 40 tick 5000 (action_outcome): goto completed",
      "--- recent entries (verbatim) ---",
      ...tail,
    ].join("\n"),
    compactionDue: { entries: ["e-000001"] },
    pending: [{ event_id: 40 }],
    task: { goal: "patrol" },
  };
  const b = tailOnlyRecent(result, 200);
  assert.ok(b.tail_truncated, "small budget must truncate");
  assert.match(b.render, /\[tail truncated: \d+ older entries omitted/);
  assert.ok(!b.render.includes("[b-000001"), "no block summaries in B");
  assert.ok(!b.render.includes("[pending]"), "no pending surface in B");
  assert.ok(b.render.includes("[task] Current: patrol"), "task line survives");
  assert.equal(b.compactionDue, null, "no compaction nag in B");
  // Newest entries survive, oldest are dropped.
  assert.ok(b.render.includes("filler observation number 29"));
  assert.ok(!b.render.includes("filler observation number 0 "));
  // Under a huge budget nothing truncates and no banner appears.
  const big = tailOnlyRecent(result, 100000);
  assert.ok(!big.tail_truncated);
  assert.ok(!big.render.includes("[tail truncated"));
});

test("extractJson: fenced block wins, bare object fallback, garbage → null", () => {
  assert.deepEqual(extractJson('text\n```json\n{"a": 1}\n```\nmore'), { a: 1 });
  assert.deepEqual(extractJson('first ```json\n{"a":1}\n``` then ```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(extractJson('no fence but {"b": [1,2]} inline'), { b: [1, 2] });
  assert.equal(extractJson("nothing here"), null);
});

test("targetedAcquisition counts calls before the first correctly-targeted act", () => {
  const t = [
    { type: "tool", name: "scene_summary", input: {} },
    { type: "tool", name: "get_blocks", input: { origin: { x: 0, y: 200, z: 0 } } },
    { type: "tool", name: "bot_goto", input: { to: { x: 500, y: 200, z: 0 } } },
    { type: "tool", name: "bot_goto", input: { to: { x: 100, y: 201, z: 2 } } },
  ];
  const a = targetedAcquisition(t, [100, 201, 0], 12);
  assert.deepEqual(a, { found: true, calls_before: 3, tool: "bot_goto" });
  const miss = targetedAcquisition(t, [9999, 0, 9999], 12);
  assert.equal(miss.found, false);
  assert.equal(miss.calls_before, 4);
});

test("forbiddenCommands flags creative/teleport commands but not data reads", () => {
  const t = [
    { type: "tool", name: "run_command", input: { command: "data get block 10 201 10 Items" } },
    { type: "tool", name: "run_command", input: { command: "give @p minecraft:diamond 64" } },
    { type: "tool", name: "run_command", input: { command: "tp @p 0 200 0" } },
  ];
  const bad = forbiddenCommands(t);
  assert.equal(bad.length, 2);
  assert.ok(bad.every((c) => !c.startsWith("data get")));
});

test("posMatch: exact vs ±tolerance vs malformed", () => {
  assert.deepEqual(posMatch([1, 2, 3], [1, 2, 3], 2), { exact: true, close: true });
  assert.deepEqual(posMatch([2, 2, 3], [1, 2, 3], 2), { exact: false, close: true });
  assert.deepEqual(posMatch([9, 2, 3], [1, 2, 3], 2), { exact: false, close: false });
  assert.deepEqual(posMatch(null, [1, 2, 3], 2), { exact: false, close: false });
  assert.deepEqual(posMatch({ x: 1, y: 2, z: 3 }, [1, 2, 3], 2), { exact: true, close: true });
});

test("charter: each condition's prompt mentions only the tools it has", () => {
  const a = buildSystemPrompt("a");
  assert.ok(!a.includes("mem_"), "condition a must not mention memory tools");
  const b = buildSystemPrompt("b");
  assert.ok(b.includes("mem_note") && b.includes("mem_task"));
  assert.ok(!b.includes("mem_recall") && !b.includes("mem_write_block"));
  const c = buildSystemPrompt("c");
  assert.ok(c.includes("mem_write_block") && c.includes("mem_verify"));
  assert.ok(!c.includes("mem_recall"));
  const d = buildSystemPrompt("d");
  assert.ok(d.includes("mem_recall"));
});

// --- cycle 2 (MEMORY_REDESIGN §8) ------------------------------------------------------------------

test("charter: g/h and i/j are byte-identical pairs, and g names only the 8 surviving tools", () => {
  assertPromptPairs();
  const g = buildSystemPrompt("g");
  for (const t of CONDITIONS.g.memTools) {
    assert.ok(g.includes(t), `condition g's prompt must name ${t}`);
  }
  for (const gone of ["mem_verify", "mem_read", "mem_locate", "mem_seen", "mem_changes", "mem_last_seen"]) {
    assert.ok(!g.includes(gone), `condition g must not mention the deleted ${gone}`);
  }
  // §8: nothing to steer toward. An arm told to look for the appendix would measure compliance,
  // not delivery — and delivery is precisely what the 0.9.7 null left untested.
  for (const steer of ["remembered", "appendix", "CHANGED since", "annotat"]) {
    assert.ok(!g.toLowerCase().includes(steer.toLowerCase()),
      `condition g must NOT mention "${steer}" — the appendix arrives unbidden or the measurement is void`);
  }
  // i/j have no memory surface at all, so no memory text.
  assert.ok(!buildSystemPrompt("i").includes("mem_"));
  // The historical lattice is untouched.
  assertPromptNesting();
});

test("assertMemToolsLive throws for the post-consolidation arms and passes for the new ones", () => {
  const live = localTools().map((t) => t.name);
  for (const key of ["c", "d", "e", "f"]) {
    assert.throws(() => assertMemToolsLive(CONDITIONS[key], live), /CANNOT be run/,
      `condition ${key} names deleted tools and must refuse to run rather than narrow silently`);
  }
  for (const key of ["a", "b", "g", "h", "i", "j", "k"]) {
    assert.doesNotThrow(() => assertMemToolsLive(CONDITIONS[key], live), `condition ${key} must be runnable`);
  }
});

test("the legal arm removes X-ray AT THE TOOL LEVEL (MEMORY_REDESIGN §12.5)", () => {
  // §12.5's whole argument: "no prompt can bind a tool capability". If any X-ray read or the
  // operator surface survives in this list, the arm measures a nagged agent instead of a bound one,
  // and memory stops being load-bearing by construction.
  const forbidden = [...LOCATE_SUBSTITUTED_READS, "scene_summary", "get_entities", "get_region_summary",
    "run_command", "check_site", "resolve_anchor",
    // The WHOLE raycast family, matching production's `survival` hide-list: looking is the ambient
    // retina's job or bot_scan's. An arm that could hand-aim rays would measure a different
    // perception architecture than the one shipping — and the second watched run showed exactly what
    // an agent does with a hand-aimable ray: it re-implements the automated sense, one call at a time.
    "raycast_fan", "raycast"];
  for (const t of forbidden) {
    assert.ok(!LEGAL_WORLD_TOOLS.includes(t), `${t} is X-ray/operator surface and must not be in the legal arm`);
  }
  // What it MUST have: the legal senses and the memory-routed locate.
  for (const t of ["sense_entities", "locate", "bot_goto", "bot_status"]) {
    assert.ok(LEGAL_WORLD_TOOLS.includes(t), `the legal arm needs ${t}`);
  }
  assert.equal(CONDITIONS.k.legal, true, "the `legal` flag is what routes locate through legalLocate");
  assert.deepEqual(CONDITIONS.k.memTools, CONDITIONS.g.memTools,
    "k's memory surface must be g's verbatim — only perception is the variable");
  // bot_scan is Node-side orchestration, so it must NOT be in the list checked against the BRIDGE
  // manifest (assertWorldToolsLive would throw on a tool the bridge cannot have).
  assert.ok(!LEGAL_WORLD_TOOLS.includes("bot_scan"),
    "bot_scan is shim-local; listing it here would fail assertWorldToolsLive against the bridge manifest");
});

test("the legal prompt names no tool the legal arm lacks", () => {
  // ABLATION_DESIGN's rule: a condition's prompt mentions only the tools it has. The standard CORE
  // names scene_summary/get_blocks/run_command, none of which arm k carries — which is why k has its
  // own core rather than reusing CORE.
  const legal = buildSystemPrompt("k");
  for (const t of ["scene_summary", "get_blocks", "get_surface", "describe_box", "run_command", "raycast_fan"]) {
    assert.ok(!legal.includes(t), `the legal prompt must not mention ${t} — the arm cannot call it`);
  }
  assert.ok(legal.includes("bot_scan"), "the legal prompt must name the deliberate look-around it does have");
  assert.notEqual(legal, buildSystemPrompt("g"), "k is not g: its perception framing differs");
});

test("g/h and i/j serve byte-identical tool manifests — the appendix is env, never a tool", () => {
  assert.deepEqual(CONDITIONS.g.memTools, CONDITIONS.h.memTools);
  assert.deepEqual(CONDITIONS.g.worldTools, CONDITIONS.h.worldTools);
  assert.deepEqual(CONDITIONS.i.memTools, CONDITIONS.j.memTools);
  assert.deepEqual(CONDITIONS.i.worldTools, CONDITIONS.j.worldTools);
  assert.ok(CONDITIONS.g.worldTools.includes("locate"), "0.9.7's instrument fix: locate must be callable");
});

test("g-j run the PRODUCTION `standard` surface, not the frozen pre-standard one", () => {
  // TOOL_BILL_PLAN §4b: toolkit 0.28.0 defaults MCPTK_PROFILE to `standard` = full minus exactly the
  // three block reads with a benched 1:1 locate substitute. The ablation lattice builds its own
  // surface and never reads the profile, so this is the only thing keeping the two aligned — and
  // alignment is load-bearing: on `standard` the point read is `locate at:`, which CAPTURES cell
  // priors, whereas `describe_box` summary captures none. Which tool the explore agent picked was
  // deciding whether the annotate mechanism could fire at all.
  for (const t of LOCATE_SUBSTITUTED_READS) {
    assert.ok(!CONDITIONS.g.worldTools.includes(t), `${t} is substituted by locate on \`standard\` and must not be in g-j`);
    assert.ok(AGENT_WORLD_TOOLS.includes(t), `${t} must STAY in AGENT_WORLD_TOOLS — a-f are historical data`);
  }
  assert.deepEqual([...LOCATE_SUBSTITUTED_READS].sort(), ["describe_box", "get_blocks_at", "get_surface"],
    "must match probes/profiles.test.mjs's asserted drop list exactly");
  // locate is a perception read, or the staleness taxonomy cannot see a re-observation.
  assert.ok(PERCEPTION_TOOLS.has("locate"));
});

test("openingRender and memTools agree — a memory render for a tool-less arm is leakage", () => {
  // The session-open render IS a memory surface. An arm with no mem_* tools that still receives the
  // telescope has been handed the memory it exists to be measured without; an arm with tools and no
  // render is a different condition than the lattice documents. Either mismatch silently changes
  // what an arm measures, so the pairing is asserted rather than assumed.
  for (const c of Object.values(CONDITIONS)) {
    assert.equal(c.openingRender, c.memTools.length > 0,
      `condition ${c.key} (${c.name}): openingRender=${c.openingRender} with ${c.memTools.length} mem tool(s)`);
  }
});
