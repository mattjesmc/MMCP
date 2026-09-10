#!/usr/bin/env node
// Prints the mem_recent telescope render to stdout — the SessionStart hook uses this so every
// copilot session opens already oriented (MEMORY_DESIGN.md §The session charter). Exits 0 with a
// short notice when memory is unavailable (no world yet): a hook must never block a session.
//
// Flags (for bootstrapped game-dir workspaces whose bridge/memory differ from the dev defaults):
//   --url=http://127.0.0.1:25600   bridge base URL (else MCPTK_URL env, else dev default)
//   --dir=C:/path/to/memory-data   memory root (else MCPTK_MEMORY_DIR env, else repo default)
//   <number>                       optional render token budget (positional, as before)
// The env vars are set BEFORE tools.mjs loads — its MEMORY_ROOT is captured at module load, so
// this file must import it dynamically after flag parsing.

let budgetArg = "";
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith("--url=")) {
    process.env.MCPTK_URL = arg.slice("--url=".length);
  } else if (arg.startsWith("--dir=")) {
    process.env.MCPTK_MEMORY_DIR = arg.slice("--dir=".length);
  } else {
    budgetArg = arg;
  }
}

const { callLocalTool } = await import("./tools.mjs");
const { formatCompactionNag } = await import("./store.mjs");

const BASE =
  process.env.MCPTK_URL ||
  process.env.VJ_MCP_URL?.replace(/\/cmd\/?$/, "") ||
  "http://127.0.0.1:25599";

const bridge = async (tool, args) => {
  const res = await fetch(`${BASE}/cmd`, {
    method: "POST",
    // Session attribution when this render runs inside a mod-spawned session; anonymous otherwise.
    headers: process.env.MCPTK_SESSION ? { "X-MCPTK-Session": process.env.MCPTK_SESSION } : {},
    body: JSON.stringify({ tool, args: args ?? {} }),
    // A hung game accepts TCP and then parks the request forever (see index.mjs); a hook must
    // never block a session, and a hang is not an error tools.mjs's fallbacks can see — only a
    // timeout turns it into one (caught there, degrading to the cached-world/offline path).
    signal: AbortSignal.timeout(5000),
  });
  return res.json();
};

// Optional argv budget: the hook takes the default, probes and by-hand checks want to vary it.
const budget = Number.parseInt(budgetArg, 10);
const args = Number.isFinite(budget) && budget > 0 ? { budget_tokens: budget } : {};

const r = await callLocalTool("mem_recent", args, bridge);
if (!r.ok) {
  console.log(`agent memory unavailable: ${r.error}`);
  process.exit(0);
}
console.log(r.result.render);
if (r.result.offline) console.log(`\n[offline] ${r.result.offline}`);
if (r.result.rollback_warning) console.log(`\n[rollback] ${r.result.rollback_warning}`);
const nag = formatCompactionNag(r.result.compactionDue);
if (nag) console.log(`\n${nag}`);
