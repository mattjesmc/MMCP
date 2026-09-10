// WHICH GAME this shim talks to — resolved once, at process start, and never renegotiated.
//
// The port has a DIRECTION, and it runs opposite ways in the two cases:
//
//   GAME FIRST, session connects to it. The game has already bound a socket, so it publishes the
//     port it ACTUALLY bound into <gameDir>/.mcp.json (ClaudeBootstrap, reconciled on every click so
//     a run bound elsewhere cannot strand the config dialing a dead bridge). The game is the
//     immovable end; the session follows it. Nothing for this file to decide — MCPTK_URL is already
//     set by the time the process starts.
//
//   SESSION FIRST, and the session launches the game (launch_game -> tools/rebuild.ps1). Now BASE is
//     the immovable end: it is frozen for this process's whole life and there is no protocol for
//     changing it, while the game has not booted yet and will take any port it is handed. So the
//     port is PUSHED down instead of discovered — local/dev.mjs reads basePort() and hands it to
//     rebuild.ps1, which forwards it as -Pport, which build.gradle turns into -Dmcptoolkit.port,
//     which is first in BridgeServer's precedence and so overrides the target gameDir's config file.
//
// Getting that direction backwards is the bug this file exists to close: three components each held
// their own idea of the port (launcher polled 25599, run-server/config/mcptoolkit.properties bound
// 25610, shim dialed 25599) and a perfectly healthy server sat unreachable through a four-minute
// timeout. Note which way the fix does NOT go: making the session chase the game is case-one logic,
// and in case two the session is the end that cannot move.
export const BASE =
  process.env.MCPTK_URL ||
  process.env.VJ_MCP_URL?.replace(/\/cmd\/?$/, "") ||
  "http://127.0.0.1:25599";

// The dev default, and the fallback when BASE names no explicit port. Mirrors
// BridgeConfig.DEV_DEFAULT_PORT — the one number that is genuinely a shared constant between the
// Java side and this one, because it is what BOTH ends fall back to when nobody has said otherwise.
export const DEV_DEFAULT_PORT = 25599;

/**
 * The port half of BASE: the port a game launched BY this session must bind for its tools to be
 * reachable here. Not a guess about what is currently running — a requirement placed on what boots.
 */
export function basePort() {
  try {
    const port = new URL(BASE).port;
    return port ? Number(port) : DEV_DEFAULT_PORT;
  } catch {
    return DEV_DEFAULT_PORT;
  }
}
