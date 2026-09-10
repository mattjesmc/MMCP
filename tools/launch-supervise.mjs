// CLI test harness for the Node server's launch_game local tool.
//
// launch_game pipes rebuild.ps1's output into its log via the CALLING process, so the caller must
// outlive the cycle — in real use that's the long-lived MCP server; a one-shot `node -e` that exits
// immediately kills the pipes and with them the spawned PowerShell. This script is the supervising
// parent for by-hand testing: it launches the client, tails the log, and exits when the bridge
// answers or the script reports its exit code.
//
// Usage: node tools/launch-supervise.mjs [client|server] [--rebuild]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const target = process.argv[2] === "server" ? "server" : "client";
const rebuild = process.argv.includes("--rebuild");
const devTools = join(dirname(fileURLToPath(import.meta.url)), "..", "mcp-server", "local", "dev.mjs");

// The launcher stamps what the session it just opened is FOR (V3_PLAN.md §3 R-b): this is the
// survival launcher, and the play it supervises is §4.2's survival lane (~15% of the v3 mix,
// free because the recorder is always on). corpus-v3.json admits BY PURPOSE (§4.4) — a session
// nobody tagged is `adhoc`, and adhoc is out of corpus, which is how battery geometry once ate
// 62% of the training steps under a silent data/raw sweep. Either target ends up stamping the
// SERVER-side recorder session, which is the only one recording. Best-effort: `wm_session_tag`
// ships with the R-block toolkit, and this script's job — bring the game up, say whether the
// bridge answered — must not fail because an older jar lacks a dev tool; untagged costs the
// session its corpus admission, nothing else.
async function tagSession(purpose) {
  try {
    const res = await fetch("http://127.0.0.1:25599/cmd", {
      method: "POST", body: JSON.stringify({ tool: "wm_session_tag", args: { purpose } }),
      signal: AbortSignal.timeout(3000),
    });
    const j = await res.json();
    if (j.ok) console.log(`session tagged purpose=${purpose}`);
    else console.log(`WARN wm_session_tag refused (${JSON.stringify(j.error).slice(0, 140)}) — ` +
      `session stays untagged = adhoc = OUT of corpus-v3.json`);
  } catch (e) {
    console.log(`WARN wm_session_tag unavailable (${String(e.message ?? e).slice(0, 140)}) — ` +
      `pre-R-block toolkit? session stays untagged = adhoc = OUT of corpus-v3.json`);
  }
}

const d = await import(`file:///${devTools.replace(/\\/g, "/")}`);
const r = await d.callLocalTool("launch_game", { target, rebuild });
if (!r.ok) {
  console.error("launch_game refused:", r.error);
  process.exit(1);
}
console.log("log:", r.result.log);

const deadline = Date.now() + 5 * 60 * 1000;
while (Date.now() < deadline) {
  await new Promise((res) => setTimeout(res, 5000));
  let text = "";
  try { text = readFileSync(r.result.log, "utf8"); } catch { /* not yet */ }
  if (text.includes("EXIT=")) {
    console.log("--- final log:\n" + text);
    process.exit(text.includes("EXIT=0") ? 0 : 1);
  }
  try {
    const res = await fetch("http://127.0.0.1:25599/cmd", {
      method: "POST", body: JSON.stringify({ tool: "ping", args: {} }),
      signal: AbortSignal.timeout(3000),
    });
    const j = await res.json();
    if (j.ok && j.result.env) {
      console.log("BRIDGE UP:", JSON.stringify(j.result));
      await tagSession("survival");
      process.exit(0);
    }
  } catch { /* bridge down, keep waiting */ }
}
console.error("timed out; log so far:\n" + (() => { try { return readFileSync(r.result.log, "utf8"); } catch { return "(none)"; } })());
process.exit(1);
