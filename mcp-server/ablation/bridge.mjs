// Bridge access for the ablation harness: raw tool calls (harness setup + agent dispatch) and the
// manifest → Anthropic tool-definition conversion.

export const BASE =
  process.env.MCPTK_URL ||
  process.env.VJ_MCP_URL?.replace(/\/cmd\/?$/, "") ||
  "http://127.0.0.1:25599";

/** POST one tool call to the bridge; returns the {ok, result|error} envelope. */
export async function bridge(tool, args) {
  const res = await fetch(`${BASE}/cmd`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool, args: args ?? {} }),
  });
  return res.json();
}

/** Run a privileged server command via the bridge (harness setup/mutation only). Throws on failure. */
export async function cmd(command) {
  const r = await bridge("run_command", { command });
  if (!r.ok) throw new Error(`run_command failed: ${command}: ${r.error}`);
  return r.result;
}

export async function fetchManifest() {
  const res = await fetch(`${BASE}/tools`);
  if (!res.ok) throw new Error(`GET /tools returned HTTP ${res.status}`);
  return res.json();
}

/** Convert manifest entries ({name, description, inputSchema}) to Anthropic tool defs, filtered. */
export function toAnthropicTools(defs, allowNames) {
  const allow = new Set(allowNames);
  return defs
    .filter((t) => allow.has(t.name))
    .map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
}
