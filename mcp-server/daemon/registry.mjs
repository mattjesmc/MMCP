// The registry: the one place that knows which game is which (HOST_DESIGN.md section 3.3).
//
// `~/.mmcp/registry.json` holds the PROJECTS the daemon serves - name, root, bridge port, loader -
// and nothing live: state (down/up/world) is read from the game when asked, never stored. The port
// is the project constant that names the project (RELEASE_1.md B0): it is read from the root's
// gradle.properties (`mcmod.port`), the same number `toolkitInit` writes into every registration,
// so a project registered here dials the game its own build binds. Only mcp-toolkit's own tree
// declares no port, and that one IS what BridgeConfig.DEV_DEFAULT_PORT names.

import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/** Where everything the daemon owns lives: registry, per-project memory, Blockbench user dirs, log. */
export const MMCP_HOME = (process.env.MMCP_HOME ?? "").trim() || join(homedir(), ".mmcp");
export const REGISTRY_PATH = join(MMCP_HOME, "registry.json");
/** The daemon's own port. Bound to 127.0.0.1 only; the bind is also the single-instance lock. */
export const DAEMON_DEFAULT_PORT = 25500;
/** mcp-toolkit's own dev game: BridgeConfig.DEV_DEFAULT_PORT, the one shared constant. */
const TOOLKIT_DEV_PORT = 25599;

const EMPTY = () => ({ projects: [], blockbench: { port: 25801 }, daemon: { port: DAEMON_DEFAULT_PORT } });

export function loadRegistry(path = REGISTRY_PATH) {
  let reg;
  try {
    reg = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return EMPTY();
    // A registry that does not parse is a file somebody edited: say so, never silently start empty
    // and then overwrite it on the first save.
    throw new Error(`registry ${path} is not JSON (${e.message}) - fix or delete it`);
  }
  const base = EMPTY();
  return {
    ...base, ...reg,
    projects: Array.isArray(reg.projects) ? reg.projects : [],
    blockbench: { ...base.blockbench, ...(reg.blockbench ?? {}) },
    daemon: { ...base.daemon, ...(reg.daemon ?? {}) },
  };
}

export function saveRegistry(reg, path = REGISTRY_PATH) {
  mkdirSync(MMCP_HOME, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(reg, null, 2)}\n`);
  renameSync(tmp, path);
}

/** Parse a .properties file into a plain object - enough for gradle.properties, no escapes. */
function readProperties(path) {
  const out = {};
  let text;
  try { text = readFileSync(path, "utf8"); } catch { return out; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    const i = line.search(/[=:]/);
    if (i < 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

const isToolkitTree = (root) => existsSync(join(root, "src", "main", "java", "com", "mattmc", "mcptoolkit", "BridgeServer.java"));

/**
 * What a root says about itself: the entry `POST /projects` and `mmcpd add` write. Throws when the
 * root declares no port and is not the toolkit's own tree, because a project without a port has no
 * game to dial and registering it would only defer the error to the first session.
 */
export function scanProject(root, { name, profile } = {}) {
  root = resolve(root).replace(/\\/g, "/");
  if (!existsSync(root)) throw new Error(`${root} does not exist`);
  const props = readProperties(join(root, "gradle.properties"));
  let port = Number(props["mcmod.port"]);
  if (!Number.isInteger(port) || port <= 0) {
    if (isToolkitTree(root)) port = TOOLKIT_DEV_PORT;
    else {
      throw new Error(`${root}/gradle.properties declares no mcmod.port - the port this repository's game `
        + "binds, which is also what its MCP registration names. Pick one no other dev game on this machine "
        + "uses (the workbench allocates 25641 upward; 25599 is the toolkit's own).");
    }
  }
  const res = join(root, "src", "main", "resources");
  const loader = existsSync(join(res, "fabric.mod.json")) ? "fabric"
    : existsSync(join(res, "META-INF", "neoforge.mods.toml")) ? "neoforge" : null;
  return {
    name: (name ?? basename(root)).trim(),
    root,
    port,
    loader,
    mc: props.minecraft_version ?? null,
    // Where the dev game runs, absolute: the shim's attachment check compares the game's reported
    // directory with it and WARNS when they disagree (announceAttachment). A consumer repo runs in
    // its own `run/`; the toolkit's own tree runs in the WORKBENCH root's `run/` (its settings.gradle
    // is the workbench's), which is the one case a root-relative default gets wrong.
    gameDir: (isToolkitTree(root) && existsSync(join(root, "..", "run")) ? resolve(root, "..", "run") : join(root, "run")).replace(/\\/g, "/"),
    // The default profile a session on this project gets when its URL names none; null lets the
    // shim decide (the loop file's `project`, else `modding`).
    profile: profile ?? null,
  };
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function addProject(reg, entry) {
  if (!NAME.test(entry.name)) throw new Error(`project name "${entry.name}" - letters, digits, . _ - only`);
  const clashPort = reg.projects.find((p) => p.port === entry.port && p.root !== entry.root);
  if (clashPort) {
    throw new Error(`port ${entry.port} is already ${clashPort.name}'s (${clashPort.root}) - two dev games on one port `
      + "means the second to boot loses the bind and its session drives the first game's world");
  }
  const i = reg.projects.findIndex((p) => p.name === entry.name || p.root === entry.root);
  if (i >= 0) reg.projects[i] = { ...reg.projects[i], ...entry };
  else reg.projects.push(entry);
  return entry;
}

export function removeProject(reg, name) {
  const i = reg.projects.findIndex((p) => p.name === name);
  if (i < 0) return false;
  reg.projects.splice(i, 1);
  return true;
}

export function findProject(reg, name) {
  return reg.projects.find((p) => p.name === name) ?? null;
}
