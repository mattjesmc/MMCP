// Live-tools session runner for Category T (tool-ablation tasks). Unlike quiz.mjs, the session
// gets REAL tool access via the MCP shim; the with/without arm is selected by hiding tools from
// the shim's manifest (MCPTK_HIDE_TOOLS, index.mjs). Each task is one fresh session — no context
// carries over, so arms and repetitions stay independent samples.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeStallGuard, runawayBound, overTokenCeiling } from "./session-guards.mjs";
import { ROUTES_PIN } from "./routes-pin.mjs";

const INDEX = join(dirname(fileURLToPath(import.meta.url)), "..", "index.mjs");

// Builtins are blocked for the same reason quiz.mjs blocks them: the session must solve the task
// through the toolkit's eyes, not by shelling out or reading bench sources off disk.
const BUILTIN_TOOLS = [
  "Task", "Bash", "BashOutput", "KillShell", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit",
  "Glob", "Grep", "WebSearch", "WebFetch", "TodoWrite", "ExitPlanMode", "SlashCommand", "Skill",
  "ToolSearch", "ListMcpResources", "ReadMcpResource", "AskUserQuestion", "EnterPlanMode", "Monitor",
];

const SYSTEM = [
  "You are a Minecraft copilot answering a spatial question about the live world.",
  "Use the mcptoolkit tools to observe the world; you cannot place or break blocks for this task.",
  "Coordinate convention: +x is east, +z is south, y is up. Compass: north = -z, south = +z, east = +x, west = -x.",
  "Work efficiently — every tool call costs budget. When you know the answer, stop calling tools.",
  "End your reply with ONE final line of the form:",
  "ANSWER: <value>",
  "Keep <value> minimal (a block id, coordinates, a direction word, a number, yes/no, or a short list).",
  "If you genuinely cannot determine the answer with the tools available, end with: ANSWER: unknown",
].join("\n");

/**
 * Run one task in a fresh tool-using session.
 * @param {object} o
 * @param {string} o.model
 * @param {string} o.prompt task question (absolute coordinates included)
 * @param {string[]} o.hiddenTools bridge tool names this arm must not see
 * @param {number} o.maxTurns ADVISORY only now — the SDK bound is the generous runaway guard
 *   (session-guards.mjs); per-template turn caps no longer terminate (A5: a cap hit is only evidence
 *   against the cap). Kept in the signature so callers need not change.
 * @param {string} [o.view] get_surface encoding for this arm ("raw" | "surface"); index.mjs reads it
 * @returns {{text, usage, ms, turns, toolCalls, toolHistogram, hitTurnCap, stopReason}}
 */
export async function runTask({ model, prompt, hiddenTools = [], maxTurns = 24, view = "raw" }) {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const t0 = performance.now();
  const runawayTurns = runawayBound(maxTurns);
  const q = query({
    prompt,
    options: {
      systemPrompt: SYSTEM,
      model,
      maxTurns: runawayTurns,
      permissionMode: "bypassPermissions",
      settingSources: [],
      disallowedTools: BUILTIN_TOOLS,
      mcpServers: {
        mcptoolkit: {
          type: "stdio",
          command: process.execPath,
          args: [INDEX],
          // MCPTK_PROFILE is PINNED to full: arms are constructed from full via MCPTK_HIDE_TOOLS,
          // and every historical run was measured against the full manifest. When the production
          // default moved to `standard` (0.28.0) this pin is what kept the baseline from moving
          // with it — an unpinned profile here would silently re-shape every arm.
          //
          // MCPTK_ROUTES is PINNED to `record` for the same reason, and it is the sharper hazard of
          // the two: the route layer changes what `locate` can ANSWER while leaving the manifest
          // untouched, so `tools_hash` — the field resume.mjs treats as fatal drift, after
          // e_repair_bridge_gap pooled pre- and post-fix builds under one bench_version — cannot
          // see it. Production defaults to `learn`; inheriting that would make the bench
          // non-stationary (run it twice, the second run knows more words) with nothing in the
          // manifest to catch the pooling. `record` is byte-identical to the historical SUT from
          // the agent's side — no route ever fires — while still filling the ledger, so bench runs
          // become the largest source of the very demand data the route layer is authored from.
          // A deliberate routes arm overrides this per-run; `routes_hash` in the manifest is what
          // keeps its rows from pooling with these.
          env: {
            ...process.env,
            MCPTK_PROFILE: "full",
            MCPTK_HIDE_TOOLS: hiddenTools.join(","),
            MCPTK_GET_BLOCKS_VIEW: view,
            MCPTK_ROUTES: ROUTES_PIN,
          },
        },
      },
    },
  });
  let text = "";
  let usage = null;
  let turns = 0;
  let toolCalls = 0;
  const toolHistogram = {};
  // Ordered per-call trace (tool, truncated args, error flag, result size) — the raw material for
  // the round-three motivator counts (RESEARCH_WORLD_REPRESENTATION.md): blind-retry-after-opaque-
  // failure episodes, derivable-follow-up reads, statically-illegal first actions. Histograms
  // alone can't answer those; the ordered trace can, offline, for every run ever recorded.
  const trace = [];
  const traceById = new Map();
  let sawResult = false;
  let stopReason = "answered";
  // Accumulate usage per assistant turn so an early stall-stop still records real cost (the SDK only
  // emits the summed usage in the final result message, which a break would skip).
  const accum = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const stall = makeStallGuard();
  for await (const msg of q) {
    if (msg.type === "assistant") {
      turns++;
      const u = msg.message?.usage ?? {};
      for (const k of Object.keys(accum)) accum[k] += u[k] ?? 0;
      text = ""; // only the LAST assistant message carries the committed ANSWER line
      const turnKeys = [];
      for (const block of msg.message?.content ?? []) {
        if (block.type === "text") text += block.text;
        if (block.type === "tool_use") {
          toolCalls++;
          const name = block.name.replace(/^mcp__mcptoolkit__/, "");
          toolHistogram[name] = (toolHistogram[name] ?? 0) + 1;
          const entry = { tool: name, args: JSON.stringify(block.input ?? {}).slice(0, 200) };
          trace.push(entry);
          turnKeys.push(`${entry.tool}|${entry.args}`);
          if (block.id) traceById.set(block.id, entry);
        }
      }
      // A5: stall = the only legitimate early stop — repeated no-progress calls. Break and type it.
      if (stall.observe(turnKeys).stalled) { stopReason = "stalled"; break; }
      if (overTokenCeiling(accum.output_tokens)) { stopReason = "runaway"; break; } // cost backstop

    } else if (msg.type === "user") {
      for (const block of msg.message?.content ?? []) {
        if (block.type === "tool_result" && traceById.has(block.tool_use_id)) {
          const entry = traceById.get(block.tool_use_id);
          if (block.is_error) entry.error = true;
          entry.result_chars = JSON.stringify(block.content ?? "").length;
        }
      }
    } else if (msg.type === "result") {
      sawResult = true;
      usage = msg.usage ?? null;
    }
  }
  if (!usage) usage = accum;        // early stop skipped the result message — use the accumulated cost
  if (sawResult && turns >= runawayTurns) stopReason = "runaway"; // pure guard trip → instrument-suspect
  const seen = new Set();
  let repeatCalls = 0;
  for (const e of trace) {
    const key = `${e.tool}|${e.args}`;
    if (seen.has(key)) repeatCalls++;
    seen.add(key);
  }
  return {
    text, usage, turns, toolCalls, toolHistogram, trace,
    repeatCalls,
    errorCalls: trace.filter((e) => e.error).length,
    stopReason, // "answered" | "stalled" | "runaway"
    // hitTurnCap now means the RUNAWAY guard tripped (rare, instrument-suspect) — never the old
    // per-template cap. A stall is a separate typed, censored outcome.
    hitTurnCap: stopReason === "runaway",
    ms: Math.round(performance.now() - t0),
  };
}
