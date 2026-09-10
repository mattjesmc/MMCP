// Aggregates the local (non-proxied) tool registries the MCP server serves beside the bridge
// manifest. Each registry exports the same triple — localTools(), isLocalTool(name),
// callLocalTool(name, args, callBridge) — and owns its own dispatch, so e.g. launch_game never
// routes through the memory world-identity path (which throws when the game is down).

import * as memory from "../memory/tools.mjs";
import * as scan from "../memory/scan.mjs";
import * as dev from "./dev.mjs";
// Survival-only, and empty in every other profile — the session's one legitimate exit, which the
// launcher's `--disallowedTools Write` had made unreachable (see survival.mjs).
import * as survival from "./survival.mjs";

// The observation registry is gone (MEMORY_REDESIGN §3): mem_seen/mem_changes/mem_last_seen became
// properties of the reads the agent already makes (the annotate appendix) rather than three more
// doors it had to discover — which, measured, it did not.
// The Blockbench painters that lived here until 0.64.0 (local/paint.mjs) are tools of the
// toolkit's own Blockbench plugin now (mcp-toolkit/blockbench/mcptoolkit_bridge.js).
const REGISTRIES = [memory, scan, dev, survival];

export function localTools() {
  return REGISTRIES.flatMap((r) => r.localTools());
}

export function isLocalTool(name) {
  return REGISTRIES.some((r) => r.isLocalTool(name));
}

export function callLocalTool(name, args, callBridge) {
  const r = REGISTRIES.find((reg) => reg.isLocalTool(name));
  if (!r) throw new Error(`not a local tool: ${name}`);
  return r.callLocalTool(name, args, callBridge);
}
