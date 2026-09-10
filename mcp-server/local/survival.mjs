// Survival-only local tools — present ONLY when this session runs the player-legal profile.
//
// Conditional the same way dev.mjs is (guard there: a build tree exists; guard here: the profile is
// survival), and for the same reason: the static tool prefix is re-read every turn and measures
// 50-92% of the bill (TOKEN_PER_TOOL_FINDINGS Finding 1), so a verb only one role can use must not
// be described to the other five.
//
// --- why session_stop exists ------------------------------------------------------------------
//
// The survival session runs under a Stop hook (`keep-playing.mjs`) that blocks the model from
// ending its turn, because "repeat this for as long as you play" was a hope in the charter and
// nothing in the harness made it true. The hook has a legitimate escape: a `.claude/STOP_OK` file.
// Its block message told the model to create that file with the **Write tool**.
//
// The launcher hard-denies Write. `ClaudeBootstrap` passes
// `--disallowedTools 'Bash,PowerShell,Task,Agent,WebSearch,WebFetch,Write,Edit,NotebookEdit'`, which
// no permission rule can override — deliberately, because a player-legal body must not be able to
// edit files, least of all its own charter. So three components disagreed: the hook demanded a
// file, the launcher forbade the only tool that writes one, and the charter described neither.
//
// Live consequence, 2026-08-02 (session w1-75920): the body died, the model decided — correctly —
// to end, tried the sanctioned exit, and got "Write exists but is not enabled in this context". It
// then sat in the loop until a human interrupted it. A legitimate decision to stop was unreachable.
//
// The fix keeps the launcher's deny (arbitrary writes stay impossible) and gives the intent its own
// door: one verb, in the surface the session already has, that writes exactly one file and nothing
// else. The shim can do this because the shim is not the agent — the same seam that lets it own
// memory files the mod and the model cannot touch.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const IS_SURVIVAL = (process.env.MCPTK_PROFILE ?? "").trim() === "survival";

/** The files a stop writes. Resolved from the working directory because the CLI is launched in the
 *  survival workspace and spawns this server as a child, so cwd IS that workspace — the same
 *  assumption index.mjs already makes for its `/hello` label.
 *
 *  TWO files, because two different components need to know two different things:
 *  - STOP_OK is the Stop hook's one-shot permission slip. It is CONSUMED on use, precisely so the
 *    next wake loops normally.
 *  - LAST_STOP.json is the relauncher's signal (run-loop.ps1) and it PERSISTS. Without it the
 *    wrapper cannot tell a deliberate end from an idling CLI, and would cheerfully wake the player
 *    back up thirty seconds after the human told it to stop. It doubles as the record a person
 *    reads afterwards to find out how the run ended. */
function stopPaths() {
  const dir = join(process.cwd(), ".claude");
  return { dir, stopOk: join(dir, "STOP_OK"), lastStop: join(dir, "LAST_STOP.json") };
}

const TOOLS = IS_SURVIVAL
  ? [
      {
        name: "session_stop",
        description:
          "END YOUR PLAY IN THIS WORLD — permanently, not until the next turn. A stop hook enforces " +
          "the living loop and a relauncher wakes you again whenever the CLI stops for any other " +
          "reason, so this verb is the only thing that actually stops the game, and nothing wakes " +
          "you after it. Use it for exactly two situations: the player told you to stop, or your " +
          "body is dead AND a respawn attempt was actually REFUSED (call bot_body {action:\"spawn\"} " +
          "and read the error first — do not assume). NOT for \"I finished a batch of work\", not " +
          "for running low on context (a restart is a nap: same world, memory intact, nothing to " +
          "hand over) — those are what the loop exists to continue past. Records the reason, then " +
          "end your turn.",
        inputSchema: {
          type: "object",
          properties: {
            reason: {
              type: "string",
              description:
                "Why the session is ending, in one sentence. Recorded for the human who reads the " +
                "run afterwards — say what happened, not that you are stopping.",
            },
          },
          required: ["reason"],
        },
        mechanism: "memory",
      },
    ]
  : [];

export function localTools() {
  return TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}

export function isLocalTool(name) {
  return TOOLS.some((t) => t.name === name);
}

export async function callLocalTool(name, args) {
  if (name !== "session_stop") {
    throw new Error(`not a survival tool: ${name}`);
  }
  const reason = String(args?.reason ?? "").trim();
  if (!reason) {
    return { ok: false, error: "`reason` is required — a session that ends without saying why leaves the next run nothing to learn from" };
  }
  const { dir, stopOk, lastStop } = stopPaths();
  const stamp = new Date().toISOString();
  const session = process.env.MCPTK_SESSION ?? "(anonymous)";
  try {
    await mkdir(dir, { recursive: true });
    // The hook only tests for existence, but a human reads this file after a bad run — so it
    // carries the account rather than being an empty token.
    await writeFile(stopOk, `${stamp} ${session}\n${reason}\n`, "utf8");
    // Written SECOND and on purpose: the wrapper polls for this one, and a wrapper that saw it
    // before STOP_OK existed could kill the CLI in the window where the hook would still block.
    await writeFile(lastStop, JSON.stringify({ stopped_at: stamp, session, reason }, null, 2), "utf8");
  } catch (e) {
    return { ok: false, error: `could not signal the stop (${e.message}) — the session cannot end cleanly; tell the player in chat` };
  }
  return {
    ok: true,
    result: {
      stopped: true,
      reason,
      session,
      signalled_at: stamp,
      mechanism: "memory",
      note: "the stop is authorised — END YOUR TURN NOW without another tool call. This ends your "
        + "play for good: the relauncher sees the record and will NOT wake you again, so use it "
        + "only for the two situations in this tool's description.",
    },
  };
}
