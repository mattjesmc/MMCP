// SUT ADAPTER SEAM — the bench's agent channel, made explicit (BENCH_EXTERNALIZATION.md).
//
// The bench has two channels that must never be confused:
//   ORACLE channel — staging, truth generation, intervention-verification, server-state scoring.
//     Runs on the bridge/mod. Part of the instrument. Identical under every arm; the system under
//     test never touches it.
//   AGENT channel — the tool surface the system under test exposes to its model. THIS file. An
//     ablation arm is a degraded agent channel (hide/swap/view are surface transforms); the oracle
//     never varies with the arm.
//
// An adapter runs ONE episode of a system-under-test against a task prompt and returns the
// standard episode record. The contract is deliberately the union of what every scorer/report
// already consumes, so adapters are interchangeable rows in the same answers.jsonl:
//
//   run({ model, prompt, system?, maxTurns, surface }) → {
//     text,            // the SUT's final reply (ANSWER: line extraction happens outside)
//     usage,           // {input_tokens, output_tokens, cache_read_input_tokens, ...} or null
//     turns, toolCalls, toolHistogram,
//     trace,           // ordered [{tool, args, error?, result_chars?}] — motivator counts read this
//     repeatCalls, errorCalls, hitTurnCap, ms,
//   }
//
//   surface = { hiddenTools?: string[], view?: string }  — the arm, expressed as a surface
//   transform. Adapters that cannot express a transform MUST throw, never silently ignore it: an
//   arm that isn't the arm we think it is invalidates the run (the run-tasks manifest-validation
//   lesson).
//
// Adapter #1 is the MCP shim (the toolkit's own surface via index.mjs). The seam exists so a
// second substrate — a different MCP server, or a protocol-level bot if one ever reaches the
// server's MC version — plugs in as a row in ADAPTERS without the runners changing. quiz.mjs
// (no-tools transcript QA) is deliberately NOT an adapter: it has no agent channel at all.
// ablation/runner-sdk.mjs (the C/P/E/Z/W launcher) is the next unification target; see
// BENCH_EXTERNALIZATION.md §Path.

import { runTask } from "./agent.mjs";

export const ADAPTERS = {
  "mcp-shim": {
    name: "mcp-shim",
    description:
      "Claude Agent SDK session whose only tools are the mcptoolkit MCP shim (index.mjs); " +
      "arms via MCPTK_HIDE_TOOLS / MCPTK_GET_BLOCKS_VIEW manifest transforms.",
    async run({ model, prompt, maxTurns, surface = {} }) {
      return runTask({
        model,
        prompt,
        maxTurns,
        hiddenTools: surface.hiddenTools ?? [],
        view: surface.view ?? "raw",
      });
    },
  },
};

export function getAdapter(name) {
  const a = ADAPTERS[name];
  if (!a) throw new Error(`unknown adapter "${name}" (known: ${Object.keys(ADAPTERS).join(", ")})`);
  return a;
}
