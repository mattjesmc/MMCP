// Ablation conditions (ABLATION_DESIGN.md §Conditions) — a nested lattice: each condition adds one
// architectural layer, so a metric jump between adjacent conditions localizes to that layer.
// The ONLY axis is which mem_* tools exist and what the session-open render contains.

const B_TOOLS = ["mem_note", "mem_recent", "mem_task"];
const C_TOOLS = [...B_TOOLS, "mem_write_block", "mem_place", "mem_verify", "mem_read", "mem_dismiss"];
const D_TOOLS = [...C_TOOLS, "mem_recall"];
// The captured-observation query surface (OBSERVATION_MEMORY_DESIGN §3). Deliberately a SEPARATE
// condition rather than an addition to D_TOOLS: `d`/`full` at bench 0.9.5 IS the baseline that the
// §6 pre-registration is measured against, so folding these into it would move the baseline by the
// very change under test — the comparability hazard this repo keeps re-learning.
const OBS_TOOLS = ["mem_seen", "mem_changes", "mem_last_seen"];

// ⚠ CONDITIONS a–f ARE HISTORICAL DATA. Their tool lists and prompt bytes are what make the 0.9.5
// and 0.9.7 corpora comparable, so they are frozen — including the five tool names above and in
// C_TOOLS that MEMORY_REDESIGN §3 has since DELETED. That makes c–f NON-RUNNABLE, which is correct
// and must be LOUD: assertMemToolsLive (below) throws at ListTools time rather than letting the
// shim's silent .filter() serve a narrower arm and score it anyway.

/** The redesigned 8-tool surface (MEMORY_REDESIGN §3): 13 → 8. mem_seen/mem_changes/mem_last_seen
 *  became the on-read appendix, mem_locate folded into locate's fallthrough, mem_verify's job is
 *  derived from capture, and mem_read merged into mem_recall's `ids`. */
const G_TOOLS = [
  "mem_note", "mem_recent", "mem_task", "mem_write_block", "mem_place", "mem_dismiss", "mem_recall",
];

// World tools the agent under test may call. Deliberately excludes world-edit/authoring/dev tools
// (set_blocks, place_shape, hotswap_class, bot_give, …): the harness owns the stage; the agent is a
// perceive-navigate-act copilot. run_command is included because the real copilot has it (audited) —
// scenarios need `data get block` for chest contents; forbidden-command use is detected in metrics.
// bot_spawn is deliberately ABSENT: the harness owns the drone lifecycle (spawn + inventory seeding
// happen before each episode), and an agent-side respawn creates a fresh drone that silently wipes
// the seeded inventory — which is exactly what broke stash-self v1 b/c/d in the first grid pass.
// `get_blocks` was renamed in toolkit 0.6.0 (→ get_surface) and `scan_box` → describe_box. The old
// name sat here unnoticed because the shim filters this list against the LIVE manifest, so a stale
// entry silently DISAPPEARS instead of failing: Category C ran with no structured block reader at
// all, raycasting 70+ times to find a chest 6 blocks from a coordinate it had been given. That is
// what assertWorldToolsLive (below) now prevents — FREEZE_PLAN B4, "can't express ⇒ throw".
export const AGENT_WORLD_TOOLS = [
  "scene_summary", "get_surface", "describe_box", "get_blocks_at",
  "get_entities", "raycast", "check_path", "get_events",
  "bot_goto", "bot_look", "bot_status", "bot_select",
  "bot_mine", "bot_place", "bot_use", "bot_attack",
  "run_command",
];

/**
 * The cycle-2 world surface = the PRODUCTION `standard` profile (toolkit 0.28.0, TOOL_BILL_PLAN
 * §4b): the copilot tools minus the three block reads with a benched 1:1 substitute, plus `locate`.
 *
 * Why this differs from AGENT_WORLD_TOOLS, deliberately. The ablation lattice builds its own surface
 * and never reads MCPTK_PROFILE (§4b says so explicitly), so AGENT_WORLD_TOOLS is frozen in the
 * PRE-`standard` world. Arms a-f keep it — they are historical data. Arms g-j must not: measuring
 * memory on a surface production turned off is measuring the wrong thing, and it had a concrete
 * consequence. `get_blocks_at` and `describe_box:layers` capture cell-level priors; `describe_box`
 * in SUMMARY mode captures only aggregates. With all of them present, whether the annotate mechanism
 * had any prior to fire on came down to an uncontrolled coin flip in the explore pass — measured
 * 2026-07-29, two runs of the identical prompt and seed producing 172 cell rows and 0 cell rows.
 *
 * On the `standard` surface the point read IS `locate at:`, whose identify mode delegates to the
 * same palette-row extraction as get_blocks_at — so priors are captured by the tool the task pushes
 * the agent toward, by construction rather than by luck.
 *
 * No historical comparability is broken: g-j are new arms with no prior rows.
 */
export const LOCATE_SUBSTITUTED_READS = ["get_surface", "get_blocks_at", "describe_box"];
export const G_WORLD_TOOLS = [
  ...AGENT_WORLD_TOOLS.filter((t) => !LOCATE_SUBSTITUTED_READS.includes(t)),
  "locate",
];

/**
 * The LEGAL arm's world surface (MEMORY_REDESIGN §12.5, arm `k`) = the production `survival`
 * profile's shape: every X-ray read and the operator surface removed AT THE TOOL LEVEL
 * (`scene_summary`, `get_entities`, `run_command` out — "no prompt can bind a tool capability"),
 * the legal senses in (`raycast` the focused look, `sense_entities` the entity belief store), and
 * `locate` answered from the provenance-filtered observation store (the shim routes it through
 * legalLocate — §12.1's "swap the knowledge source, keep the name"). `bot_scan` — the deliberate
 * look-around production ships instead of a hand-called raycast_fan (SURVIVAL_MODE_PLAN §5b) — is
 * shim-local orchestration (memory/scan.mjs), added to the manifest by the `legal` flag, NOT
 * listed here: assertWorldToolsLive checks this list against the BRIDGE manifest, which never
 * carries a Node-side tool.
 */
export const LEGAL_WORLD_TOOLS = [
  // No `raycast`/`raycast_fan`: production hides the whole family under `survival` (looking is the
  // retina's job or bot_scan's), and an arm that could hand-aim rays would measure a different
  // perception architecture than the one shipping.
  "check_path", "get_events", "sense_entities",
  "bot_goto", "bot_look", "bot_status", "bot_select",
  "bot_mine", "bot_place", "bot_use", "bot_attack",
  "locate",
];

export const CONDITIONS = {
  a: { key: "a", name: "amnesiac", memTools: [], tailOnly: false, openingRender: false },
  b: { key: "b", name: "tail", memTools: B_TOOLS, tailOnly: true, openingRender: true },
  c: { key: "c", name: "telescope", memTools: C_TOOLS, tailOnly: false, openingRender: true },
  d: { key: "d", name: "full", memTools: D_TOOLS, tailOnly: false, openingRender: true },
  // e = d + captured observations. Its paired control is `d` itself: both quiz the SAME corpus, and
  // capture is invisible to `d` because `d` cannot call the obs tools — so one explore pass serves
  // both arms and the shared-corpus invariant that makes C's arms comparable is preserved.
  e: { key: "e", name: "capture", memTools: [...D_TOOLS, ...OBS_TOOLS], tailOnly: false, openingRender: true },
  // f = e with the SAME tools and a STEERED prompt. The first paired smoke (2026-07-27) exposed the
  // obs tools to a free-choosing agent and it called them ZERO times, routing to the familiar
  // mem_recall / describe_box — PATTERN_SEARCH_DESIGN finding #1 reproducing exactly ("capability
  // confirmed, discovery is the bottleneck"). Free choice measures DISCOVERY; steering measures the
  // REPRESENTATION but confounds it with instruction. PATTERN_SEARCH resolved that tension by
  // reporting both arms rather than picking one, and this lattice follows the precedent: e and f
  // differ ONLY in prompt text, so e-vs-f prices discovery and f-vs-d prices the representation.
  f: { key: "f", name: "capture-forced", memTools: [...D_TOOLS, ...OBS_TOOLS], tailOnly: false, openingRender: true },

  // --- cycle 2: the redesigned surface (MEMORY_REDESIGN §8) ---------------------------------------
  // g/h and i/j are annotate ON/OFF pairs. Their tool manifests are BYTE-IDENTICAL within a pair —
  // the appendix is env (MCPTK_OBS_ANNOTATE), never a tool — so the only variable is whether memory
  // arrives unbidden on the reads the agent was already making. That is the delivery claim §8's
  // prediction 1 tests, and it is untestable if the arms differ in anything else.
  //
  // `locate` joins the world tools here: 0.9.7's scope note found the agent under test could not
  // call it at all, which killed the locate extractor's corpus contribution AND made mem_last_seen's
  // "the remembered counterpart of locate" framing reference an absent tool.
  g: { key: "g", name: "annotate", memTools: G_TOOLS, worldTools: G_WORLD_TOOLS, tailOnly: false, openingRender: true },
  h: { key: "h", name: "annotate-off", memTools: G_TOOLS, worldTools: G_WORLD_TOOLS, tailOnly: false, openingRender: true },
  // i/j isolate the REPRESENTATION: world reads only, no authored-memory tools at all. j has no
  // memory surface of any kind, so its score IS the guessing floor — measured, not assumed.
  i: { key: "i", name: "worldonly-ann", memTools: [], worldTools: G_WORLD_TOOLS, tailOnly: false, openingRender: false },
  j: { key: "j", name: "worldonly", memTools: [], worldTools: G_WORLD_TOOLS, tailOnly: false, openingRender: false },

  // --- cycle 4: the legal arm (MEMORY_REDESIGN §12.5) ---------------------------------------------
  // X-ray removed at the tool level, so memory is load-bearing BY CONSTRUCTION: the explore corpus
  // is X-ray-provenance and the legal locate structurally cannot re-survey it — correct answers must
  // come through mem_* recall or fresh legal observation. That asymmetry is the instrument fix
  // Category C has needed (agents re-survey with describe_box instead of remembering), not a bug.
  // `legal: true` makes the shim route locate through legalLocate and serve bot_scan; capture must
  // be ON for this arm (its own raycasts/scans feed the store its locate answers from).
  k: { key: "k", name: "legal", memTools: G_TOOLS, worldTools: LEGAL_WORLD_TOOLS, tailOnly: false, openingRender: true, legal: true },
};

// `locate` joins the perception set with the cycle-2 surface: it is the point read on `standard`,
// and the staleness taxonomy ("did the agent actually re-observe the chest before reporting it?")
// reads this set. Leaving it out would have made every locate-based re-observation invisible, so a
// session that DID look would score as a stale_assumption. Additive for historical dirs — no arm
// before g could call locate, so no existing row's metrics move.
export const PERCEPTION_TOOLS = new Set([
  "scene_summary", "get_surface", "describe_box", "get_blocks_at", "get_entities", "raycast",
  "check_path", "locate",
]);

/**
 * The MEMORY-tool half of the same guard. `mcp-shim.mjs` composes its manifest with
 * `localTools().filter((t) => memToolSet.has(t.name))` — a filter, which means a condition naming a
 * tool the registry no longer has serves a SILENTLY NARROWER arm and still scores. That is exactly
 * the B4 bug class (Category C ran with no block reader for a whole grid pass), one layer over.
 *
 * MEMORY_REDESIGN §3 deletes five tools, so conditions c–f now name tools that do not exist. They
 * are HISTORICAL DATA and are deliberately not repaired — their prompt bytes and tool lists are what
 * makes the 0.9.5/0.9.7 corpora comparable. What must not happen is running them anyway: this turns
 * that into a loud throw at ListTools time, before a single token is spent.
 */
export function assertMemToolsLive(condition, registryNames) {
  const live = new Set(registryNames);
  const missing = (condition.memTools ?? []).filter((t) => !live.has(t));
  if (missing.length) {
    throw new Error(
      `condition ${condition.key} (${condition.name}) names memory tools that no longer exist: ` +
      `${missing.join(", ")} — this arm CANNOT be run. Conditions a–f are historical data from the ` +
      `pre-consolidation surface (MEMORY_REDESIGN §3); use g/h/i/j for new runs. Serving the arm ` +
      `without these tools would silently measure a different architecture.`);
  }
}

/** FREEZE_PLAN B4: a surface transform that names a tool the SUT does not expose must THROW, not
 *  silently narrow the arm. Call with the live manifest before any session starts. */
export function assertWorldToolsLive(manifestNames, tools = AGENT_WORLD_TOOLS) {
  const live = new Set(manifestNames);
  const missing = tools.filter((t) => !live.has(t));
  if (missing.length) {
    throw new Error(
      `world tools not present on the live surface: ${missing.join(", ")} — the adapter cannot express ` +
      `this arm (renamed or removed tool). Fix AGENT_WORLD_TOOLS/MCPTK_WORLD_TOOLS; do NOT run, the ` +
      `arm would silently lose the tool and the scores would not be comparable.`);
  }
}

const tokens = (s) => Math.ceil(s.length / 4);

/**
 * Condition B's render policy: verbatim tail only, newest-first within budget, behind an EXPLICIT
 * truncation banner (silent truncation would be epistemic sabotage — rev 2 fix). No block summaries,
 * no [pending], no compaction_due. The [task] line stays: B is "a scratchpad and a goal line".
 */
export function tailOnlyRecent(result, budgetTokens = 600) {
  const lines = result.render.split("\n");
  const sep = lines.indexOf("--- recent entries (verbatim) ---");
  const head = sep === -1 ? lines : lines.slice(0, sep);
  const kept = head.filter((l) => l.startsWith("## Memory") || l.startsWith("[task")); // "[task]" none-line or "[task <session>]" frames
  const tail = sep === -1 ? [] : lines.slice(sep + 1).filter(Boolean);

  const keptTail = [];
  let budget = budgetTokens;
  for (let i = tail.length - 1; i >= 0; i--) {
    const cost = tokens(tail[i]);
    if (budget - cost < 0) break;
    budget -= cost;
    keptTail.unshift(tail[i]);
  }
  const omitted = tail.length - keptTail.length;
  const out = [...kept];
  if (omitted > 0) {
    out.push(`[tail truncated: ${omitted} older entr${omitted === 1 ? "y" : "ies"} omitted — they are not retrievable in this configuration]`);
  }
  out.push("--- recent entries (verbatim) ---", ...keptTail);
  return {
    render: out.join("\n"),
    compactionDue: null,
    pending: [],
    task: result.task ?? null,
    tail_truncated: omitted > 0,
    omitted_entries: omitted,
  };
}
