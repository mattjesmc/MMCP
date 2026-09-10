// Max-subscription runner (ABLATION_DESIGN.md §Runner, substrate revision 2026-07-19): drives the
// agent under test through the Claude Agent SDK — no Anthropic API key on this machine; auth falls
// back to the local Claude Code (Max) login when ANTHROPIC_API_KEY is unset.
//
// The Claude Code harness wraps every condition IDENTICALLY, so the pre-registered contrasts stay
// internally valid. The agent's only tools are the ablation MCP shim's (condition-filtered there,
// AND allow-listed here); every built-in Claude Code tool is disallowed explicitly.
//
// Transcript split: the shim writes the authoritative tool transcript (verbatim result envelopes —
// metrics read those); the SDK message stream (assistant text, thinking, result) is logged
// separately for debugging and usage accounting.

import { appendFile, readFile, writeFile } from "node:fs/promises";
import {
  makeStallGuard, runawayBound, overTokenCeiling, toolSurfaceFailure, isCensoredSubtype,
} from "../testbench/session-guards.mjs";

const MCP_SERVER = "ablation";
const MCP_PREFIX = `mcp__${MCP_SERVER}__`;

const BUILTIN_TOOLS = [
  "Task", "Bash", "BashOutput", "KillShell", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit",
  "Glob", "Grep", "WebSearch", "WebFetch", "TodoWrite", "ExitPlanMode", "SlashCommand", "Skill",
  "ToolSearch", "ListMcpResources", "ReadMcpResource", "AskUserQuestion", "EnterPlanMode", "Monitor",
];

/**
 * Run one episode as a fresh Agent SDK query (fresh conversation per episode — the context reset is
 * the treatment; the SDK starts a new session when neither `continue` nor `resume` is passed).
 */
export async function runEpisodeSdk({
  model, system, prompt, maxTurns,
  shimPath, shimEnv, allowedToolNames, toolTranscriptPath, sdkLogPath,
  log = () => {},
}) {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  await writeFile(toolTranscriptPath, "", "utf8"); // the shim appends to a fresh file per episode

  const runawayTurns = runawayBound(maxTurns); // A5: per-template cap no longer terminates; runaway guard only
  const q = query({
    prompt,
    options: {
      systemPrompt: system,                    // plain string = FULL replacement, no Claude Code preset
      model,
      maxTurns: runawayTurns,
      permissionMode: "dontAsk",               // deny anything not allow-listed — locked-down headless
      settingSources: [],                      // never load CLAUDE.md / .claude settings into the experiment
      tools: [],                               // disable EVERY built-in tool (ToolSearch included) — MCP tools unaffected
      allowedTools: allowedToolNames.map((n) => `${MCP_PREFIX}${n}`),
      disallowedTools: BUILTIN_TOOLS,
      mcpServers: {
        ablation: { command: process.execPath, args: [shimPath], env: shimEnv },
      },
    },
  });

  // Accumulate as we stream: on error_max_turns the CLI exits non-zero and the SDK THROWS instead of
  // returning cleanly — a capped episode is a legitimate outcome (failure at max cost), so we
  // synthesize the result from what streamed rather than crashing the run.
  let result = null;
  let assistantTurns = 0;
  let lastText = "";
  let stalled = false;
  let overCost = false;
  let instrumentFailure = null; // set from the session-open init message; see toolSurfaceFailure
  const accum = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const stall = makeStallGuard();
  let streamError = null;
  try {
    for await (const m of q) {
      await appendFile(sdkLogPath, JSON.stringify(m) + "\n", "utf8");
      // The tool surface the session ACTUALLY received, checked before it can answer. A session whose
      // shim never connected opens with 0 tools, answers blind in one turn, and the SDK still calls
      // that `success` — so this is the only place the failure is visible. Stop immediately: nothing
      // observed after this point is evidence about the subject.
      if (m.type === "system" && m.subtype === "init") {
        instrumentFailure = toolSurfaceFailure({
          tools: m.tools ?? [], mcpServers: m.mcp_servers ?? [],
          expected: allowedToolNames, prefix: MCP_PREFIX, serverName: MCP_SERVER,
        });
        if (instrumentFailure) { log(`INSTRUMENT FAILURE — ${instrumentFailure}; aborting (row will be censored)`); break; }
      }
      if (m.type === "assistant") {
        assistantTurns++;
        const u = m.message?.usage ?? {};
        for (const k of Object.keys(accum)) accum[k] += u[k] ?? 0;
        const blocks = m.message?.content ?? [];
        const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join(" ");
        if (text.trim()) lastText = text;
        const toolBlocks = blocks.filter((b) => b.type === "tool_use");
        const tools = toolBlocks.map((b) => b.name.replace("mcp__ablation__", ""));
        if (tools.length) log(`→ ${tools.join(", ")}`);
        else if (text) log(`… ${text.slice(0, 100)}`);
        // A5: stall = the only legitimate early stop (repeated no-progress calls). Break and type it.
        const turnKeys = toolBlocks.map((b) => `${b.name}|${JSON.stringify(b.input ?? {}).slice(0, 200)}`);
        if (stall.observe(turnKeys).stalled) { stalled = true; log(`stall detected — no progress; stopping`); break; }
        if (overTokenCeiling(accum.output_tokens)) { overCost = true; log(`token ceiling hit — runaway`); break; }
      }
      if (m.type === "result") result = m;
    }
  } catch (e) {
    streamError = e;
  }
  if (!result) {
    if (instrumentFailure) {
      result = { subtype: "no_tools", result: "", num_turns: assistantTurns, usage: accum, total_cost_usd: null, session_id: null };
    } else if (stalled) {
      result = { subtype: "stalled", result: lastText, num_turns: assistantTurns, usage: accum, total_cost_usd: null, session_id: null };
    } else if (overCost || (streamError && /maximum number of turns/i.test(streamError.message))) {
      // The runaway guard tripped (token ceiling or the turn backstop) — instrument-suspect, rare,
      // and NOT the old per-template cap. Synthesize a typed result rather than crashing the run.
      log(`runaway guard hit — synthesizing result (${assistantTurns} assistant turns)`);
      result = { subtype: "runaway", result: lastText, num_turns: assistantTurns, usage: accum, total_cost_usd: null, session_id: null };
    } else {
      throw streamError ?? new Error("query ended without a result message");
    }
  }

  // Merge: user prompt + the shim's verbatim tool rows (the metrics source of truth).
  const shimRows = (await readFile(toolTranscriptPath, "utf8"))
    .split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const transcript = [{ t: new Date().toISOString(), type: "user", text: prompt }, ...shimRows];

  // CENSORED = a non-answer terminal state (stall, the rare runaway/legacy cap, or an instrument
  // failure) — excluded from accuracy downstream, never scored. `capped` kept for back-compat;
  // `stop_reason` is the typed axis.
  const subtype = instrumentFailure ? "no_tools" : result.subtype;
  const censored = isCensoredSubtype(subtype);
  const stopReason = subtype === "success" ? "answered" : subtype;
  if (subtype !== "success" && !censored) {
    log(`result subtype: ${subtype}`);
  }
  return {
    finalText: result.result ?? "",
    subtype,
    instrument_failure: instrumentFailure,
    turns: result.num_turns,
    capped: censored,
    stop_reason: stopReason,
    censored,
    usage: {
      input_tokens: result.usage?.input_tokens ?? 0,
      output_tokens: result.usage?.output_tokens ?? 0,
      cache_creation_input_tokens: result.usage?.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: result.usage?.cache_read_input_tokens ?? 0,
    },
    total_cost_usd: result.total_cost_usd ?? null,
    session_id: result.session_id ?? null,
    transcript,
  };
}
