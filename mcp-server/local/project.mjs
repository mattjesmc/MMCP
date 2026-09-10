// WHICH PROJECT this session is in — and why `launch_game` has to ask at all.
//
// `local/dev.mjs` derives REPO_ROOT from where THIS FILE lives, which is where the shim is
// INSTALLED, not where the session is. Every repo in the workspace registers the same
// `mcmodding/mcp-server/index.mjs` in its .mcp.json, so that answer is identical for all of them:
// from menagerie's session `launch_game` cycled THE TOOLKIT's game, by default, silently, with the
// tool sitting in the manifest looking like it belonged there. One more member of the wrong-game
// class RELEASE_1 section B0 exists to close.
//
// The resolution reads the PORT, because B0 already made the port the project constant:
// `mcmod.port` in each repo's gradle.properties, the same number as MCPTK_URL in that repo's
// .mcp.json. The port a session froze therefore NAMES its project, and nothing new has to be
// declared or kept in step. All the search needs is the candidate set:
//
//   1. MCPTK_PROJECT_DIR, when a session would rather say it outright. Ends the search.
//   2. The session's own Gradle root (walk up from cwd) and the roots nested directly inside it.
//      mcmodding's root is a Gradle root that is not a game (a bare settings.gradle); its game,
//      mcp-toolkit, is one level down (25599, the dev default it declares no override for). Until
//      2026-09-06 the root was ALSO villagejobs' build (25640); that mod is a sibling checkout now.
//   3. Failing that — cwd is not inside a checkout — every launchable root beside this one.
//   4. Failing THAT, prefer a candidate inside the shim's own checkout. This is the old behaviour,
//      demoted from "the answer" to a tiebreak of last resort.
//
// Anything still ambiguous is REFUSED, listing every candidate and its port. A default here is
// exactly the silent wrong-game launch, so the one thing this must not do is guess. The ambiguity
// is real and present: ArmorPieces and rocketeer-kami-int declare no `mcmod.port`, so those two,
// mcp-toolkit and any other undeclared root all bind 25599 — step 4 is what tells them apart.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { DEV_DEFAULT_PORT } from "../bridge-base.mjs";

const MAX_WALK_UP = 8;

function isGradleRoot(dir) {
  return existsSync(join(dir, "settings.gradle")) || existsSync(join(dir, "settings.gradle.kts"));
}

// A Gradle root that can actually LAUNCH a game. `gradle-conventions` (a plugin build) and
// `spike-neoforge` (ModDevGradle) are roots in this very checkout and are not games rebuild.ps1
// can cycle, so "has a settings.gradle" is not the test — "applies Loom, and has a wrapper" is.
function isLaunchable(dir) {
  for (const f of ["build.gradle", "build.gradle.kts"]) {
    const p = join(dir, f);
    if (!existsSync(p)) continue;
    try {
      if (!/fabric-loom/.test(readFileSync(p, "utf8"))) continue;
    } catch {
      continue;
    }
    return existsSync(join(dir, "gradlew.bat")) || existsSync(join(dir, "gradlew"));
  }
  return false;
}

/** The bridge port that root's dev game will bind, which is the number that identifies it. */
export function declaredPort(dir) {
  try {
    const m = readFileSync(join(dir, "gradle.properties"), "utf8")
      .match(/^[ \t]*mcmod\.port[ \t]*=[ \t]*(\d+)/m);
    if (m) return Number(m[1]);
  } catch {
    /* no gradle.properties, or unreadable — it takes the default, like anyone declaring nothing */
  }
  return DEV_DEFAULT_PORT;
}

/** A root and the roots nested one level inside it, launchable ones only. */
function family(dir) {
  const out = [];
  if (!dir || !isGradleRoot(dir)) return out;
  if (isLaunchable(dir)) out.push(dir);
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const sub = join(dir, e.name);
    if (isGradleRoot(sub) && isLaunchable(sub)) out.push(sub);
  }
  return out;
}

/** The nearest enclosing Gradle root of `cwd`, or null. */
export function sessionRoot(cwd) {
  let dir = cwd ? resolve(cwd) : null;
  for (let i = 0; dir && i < MAX_WALK_UP; i++) {
    if (isGradleRoot(dir)) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** Every launchable root in the shim's checkout and beside it. One stat per sibling, then a read. */
function neighbourhood(repoRoot) {
  const out = family(repoRoot);
  const parent = dirname(repoRoot);
  let entries = [];
  try {
    entries = readdirSync(parent, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const sib = join(parent, e.name);
    if (sib === resolve(repoRoot) || !isGradleRoot(sib)) continue;
    out.push(...family(sib));
  }
  return out;
}

function inside(child, parent) {
  const c = resolve(child);
  const p = resolve(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/**
 * Resolve the Gradle root whose dev game this session's port belongs to.
 *
 * Returns `{ ok: true, dir, how }` or `{ ok: false, error, candidates }`. Never a fallback.
 * Injectable (`cwd`, `repoRoot`, `env`) so the probe can drive it as any repo's session without
 * being run from there.
 */
export function resolveLaunchProject({ port, cwd = process.cwd(), repoRoot, env = process.env } = {}) {
  const explicit = env.MCPTK_PROJECT_DIR;
  if (explicit) {
    const dir = resolve(explicit);
    if (!isGradleRoot(dir)) {
      return {
        ok: false,
        candidates: [],
        error: `MCPTK_PROJECT_DIR=${explicit} is not a Gradle root (no settings.gradle there).`,
      };
    }
    return { ok: true, dir, how: "MCPTK_PROJECT_DIR" };
  }

  const own = sessionRoot(cwd);
  const tiers = [
    { how: own ? `the session's own checkout ${own}` : null, dirs: own ? family(own) : [] },
    { how: `the workspace beside ${repoRoot}`, dirs: neighbourhood(repoRoot) },
  ];

  const seen = new Map();
  for (const tier of tiers) {
    for (const d of tier.dirs) seen.set(d, declaredPort(d));
    const matches = tier.dirs.filter((d) => declaredPort(d) === port);
    if (matches.length === 1) return { ok: true, dir: matches[0], how: tier.how };
    if (matches.length > 1) {
      // Last-resort tiebreak, and the only place the shim's install location still counts.
      const mine = matches.filter((d) => inside(d, repoRoot));
      if (mine.length === 1) {
        return { ok: true, dir: mine[0], how: `${tier.how} (tiebreak: inside the shim's own checkout)` };
      }
    }
  }

  const listing = [...seen.entries()]
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .map(([d, p]) => `  ${p}  ${d}${p === DEV_DEFAULT_PORT ? "  (declares no mcmod.port - takes the dev default)" : ""}`)
    .join("\n");
  const matched = [...seen.entries()].filter(([, p]) => p === port).map(([d]) => d);
  return {
    ok: false,
    candidates: [...seen.entries()].map(([dir, p]) => ({ dir, port: p })),
    error:
      (matched.length === 0
        ? `no project in this workspace declares bridge port ${port}, so there is nothing to launch on it`
        : `${matched.length} projects would bind bridge port ${port} (${matched.join(", ")}), so which ` +
          "game to launch is undecidable") +
      `. This session's port is frozen at ${port} (MCPTK_URL). Launchable roots, and the ports they ` +
      `would bind:\n${listing}\n` +
      "Fix: give the project a port of its own with `mcmod.port` in its gradle.properties plus the " +
      "matching MCPTK_URL in its .mcp.json (the allocation table lives in " +
      "gradle-conventions/src/main/groovy/com.mattmc.mcmod.gradle), or set MCPTK_PROJECT_DIR in this " +
      "session's .mcp.json to name the build root outright.",
  };
}
