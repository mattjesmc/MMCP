// Blockbench, as a SECOND UPSTREAM behind this shim - served by the toolkit's OWN plugin.
//
// Until 0.64.0 this adapter spoke MCP-over-HTTP to the third-party "Blockbench MCP" plugin
// (jasonjgardner, 1.6.1): initialize, a session id in a response header, SSE frames, a 94-tool
// surface of which `art` kept 20 and the pipeline used one (`risky_eval`), an eval that refused
// comments, and every tool acting on whichever tab was active. BLOCKBENCH_BRIDGE_DESIGN.md is the
// record of why that was replaced; this file is the adapter to what replaced it.
//
// `mcp-toolkit/blockbench/mcptoolkit_bridge.js` hosts plain HTTP on 127.0.0.1:25801 in the SAME
// SHAPE THE GAME BRIDGE speaks (plus GET /presence, below): GET /hello, GET /tools (a manifest with `mechanism` stamped on
// every entry), POST /cmd {tool, args, session} -> {ok, result, mechanism} | {ok:false, error}.
// So this adapter is a copy of something the shim already has, not a second protocol:
//
//   - no handshake and no session id: a Blockbench restart is an upstream that went away and came
//     back, which watchToolList already handles for the game bridge;
//   - the mechanism comes off the manifest, and off each REPLY for a mixed tool (`project op:list`
//     is a read; `project op:new` is an edit) - BLOCKBENCH_READ_ONLY, the hand-kept list, is gone;
//   - a picture arrives as `result._image {mimeType, base64, frame}` and index.mjs renders it the
//     way it renders the bridge's, with `frame` deciding whether the budget may crop it;
//   - the shim identifies itself on every request (`session`), which is what lets the plugin bind
//     a session to a project and refuse an edit on a project another live session holds;
//   - the shim HOLDS ONE CONNECTION to the plugin for its whole life (GET /presence, below), which
//     is what lets the plugin release the binding the moment this process is gone;
//   - and the port is not one port but a RANGE (`resolveWindow`, below): a Blockbench window's
//     plugin takes the first free port at or above 25801, so the port names the window, and this
//     adapter scans the range and CLAIMS a window of its own instead of sharing the one active tab.
//
// Names still pass through UNPREFIXED. The plugin's 26 names were checked against the bridge
// manifest captures: zero collisions; buildToolList still drops a colliding entry and says so.

import http from "node:http";
import { BASE as GAME_URL } from "../bridge-base.mjs";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 25801;
const DEFAULT_URL = `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;
// How many windows one machine can name. The plugin walks the same span up from the same base, so
// this number is a shared constant in two files by nature; the plugin reports its own on /hello
// (`span`) and this one only decides how far a shim looks.
const PORT_SPAN = 16;

// Off by name, or pointed somewhere else. Default is ON at the default port: with no peer
// registration this adapter is the only path to Blockbench, and a config file nobody edits is a
// feature that nobody has. Costs a scan of the range - PORT_SPAN parallel localhost ECONNREFUSEDs,
// not one - whenever Blockbench isn't running, which is why an empty scan is not repeated at the
// tool-list watcher's cadence (EMPTY_RESCAN_MS below).
const RAW = (process.env.MCPTK_BLOCKBENCH ?? "").trim();
// Three shapes, and the one nobody has to type is the default. `host:from-to` names a RANGE and
// discovers over it exactly as the default does; a bare URL PINS one window - no scan, no other
// window considered, because that is what a person means by writing one down. A pinned window is
// still claimed, so other sessions leave it alone, but the claim is never required.
const RANGE = /^(?:https?:\/\/)?([^/:\s]+):(\d+)-(\d+)\/*$/i.exec(RAW);
export const BLOCKBENCH_URL = /^(off|no|0|false)$/i.test(RAW) ? null
  : RANGE ? `http://${RANGE[1]}:${RANGE[2]}`
    : (RAW || DEFAULT_URL).replace(/\/+$/, "");
const PINNED = !!RAW && !RANGE && !!BLOCKBENCH_URL;
const SCAN = (() => {
  if (!BLOCKBENCH_URL) return null;
  if (RANGE) {
    const from = Number(RANGE[2]);
    // A range somebody wrote down is theirs, but the scan is PORT_SPAN parallel requests in front
    // of a tool-list poll: four spans is where "a range" stops and "a port sweep" starts.
    return { host: RANGE[1], from, to: Math.max(from, Math.min(Number(RANGE[3]), from + 4 * PORT_SPAN - 1)) };
  }
  let u;
  try { u = new URL(BLOCKBENCH_URL); } catch { return null; }
  const from = Number(u.port || DEFAULT_PORT);
  return { host: u.hostname, from, to: PINNED ? from : from + PORT_SPAN - 1 };
})();
const ports = () => {
  const out = [];
  for (let port = SCAN.from; port <= SCAN.to; port++) out.push(port);
  return out;
};
const baseOf = (port) => `http://${SCAN.host}:${port}`;

const LIST_TIMEOUT_MS = 8_000;
// A window either answers on localhost at once or is not there. Short on purpose: the scan is
// PORT_SPAN of these in parallel, in front of a tool-list poll that a client is waiting on.
const HELLO_TIMEOUT_MS = 1_000;
// How long a window asked for is waited for. A Blockbench window opens in a second or two; the
// ceiling is here so that a window that will never come (autostart off, a refused permission) costs
// one slow poll and then the sharing fallback, rather than a client sitting on a dead list request.
const WINDOW_WAIT_MS = 12_000;
// A scan that found NOTHING is not repeated at the watcher's cadence. When the game bridge is down
// that cadence is 3s (index.mjs, WATCH_DOWN_MS), and a scan is PORT_SPAN parallel connects, so an
// afternoon with no Blockbench open used to cost 320 refused connections a minute for a surface
// nobody asked for. The cost of the throttle is noticing a Blockbench that just opened up to this
// much later, which is under the cadence the watcher already uses when the bridge is up.
const EMPTY_RESCAN_MS = 15_000;
// Generous, and deliberately so: a `risky_eval` that pushes a model into the game, or a contact
// sheet of six renders, is a long call. The one thing that used to make EVERY call hang - the
// permission dialog the old plugin's first fs write popped - is gone (the plugin never opens one
// by itself), but Blockbench can still be mid-dialog for a human's own reasons, so the message on
// a timeout still says where to look.
const CALL_TIMEOUT_MS = 120_000;

// Who this shim is to the plugin. MCPTK_SESSION is the id the game bridge minted when there is
// one, and an explicit one still wins, for deliberate sharing. Otherwise the PARENT process id -
// this session's `claude.exe` - which is the one thing every MCP server of one session already
// sees and no other session's does. A per-PROCESS fallback was actively wrong: a session running
// this shim beside a second server of its own (ArmorPieces' Blockbench proxy is the live case) got
// two identities that then refused each other's edits, because every guard the plugin has is keyed
// on the id. The prefix is deliberately NOT per-server for the same reason - the two must compute
// the same string - and `client` below is what says which of a session's servers is calling.
// `docs/models/BLOCKBENCH_ISOLATION_DESIGN.md` section 6.1.
const SESSION_ID = (process.env.MCPTK_SESSION ?? "").trim() || `mcptk-${process.ppid}`;
const CLIENT = (process.env.MCPTK_CLIENT ?? "").trim() || null;
let profileName = null;
/** index.mjs tells the adapter which profile it serves, so the plugin's status can show it. */
export function setBlockbenchProfile(p) { profileName = p; }
// WHICH GAME this session drives, told to the plugin (TODO.md 1.9). The two older plugins -
// `mcptoolkit_sync.js` and `mcptoolkit_entity.js`, reached as globals through `risky_eval` - each
// carried a bare `http://127.0.0.1:25599/cmd`, and since per-project bridge ports (RELEASE_1.md B0)
// that constant NAMES the toolkit's own dev game: from a consumer repo's Blockbench their pushes
// went to whatever was on 25599, refused if nothing was there and accepted silently if the wrong
// game was. Neither plugin's settings store had a port key, so there was no way to correct it
// either. THE SHIM IS THE ONLY COMPONENT THAT KNOWS BOTH ENDS, so it is the one that must say.
//
// It rides the session block rather than only `POST /claim`, which is the one deviation from the
// plan in 1.9 and it is a superset: the claim carries this block, and so does every `/cmd`, so a
// session whose claim 404s (a plugin from before step 2), is refused (another session holds the
// window) or never happens (a shared window) still delivers the URL. The plugin keeps it on the
// session record beside the project binding and `risky_eval` injects it as `GAME`.
export function blockbenchSession() {
  return { id: SESSION_ID, client: CLIENT, profile: profileName, game: GAME_URL };
}
function headers() {
  return {
    "Content-Type": "application/json",
    "X-MCPTK-Session": SESSION_ID,
    ...(CLIENT ? { "X-MCPTK-Client": CLIENT } : {}),
    ...(profileName ? { "X-MCPTK-Profile": profileName } : {}),
  };
}

// --- which window ---------------------------------------------------------------------------------
// The window is the unit of ownership (BLOCKBENCH_ISOLATION_DESIGN.md section 6.3). Until step 2
// every session spoke to ONE window, which meant one active tab: a session with no binding yet had
// nothing to name, so the call that would have given it one resolved against whoever was working,
// and the A/B's second session was refused ten times and first held a piece of its own three
// minutes after the first had FINISHED (section 9). Serialised, not slowed - which is why a window
// each is worth a protocol.
//
// The protocol, both halves in one place because they only make sense together:
//
//   1. Each window's plugin listens on the first free port at or above the base. The port it wins
//      IS the window's name, and `GET /hello` reports it with `window`, `agent`, `allow_agents` and
//      `claimed_by`.
//   2. A shim scans the range and asks each one /hello. It REJOINS the window already carrying its
//      session id, else CLAIMS the first AGENT window nobody holds (POST /claim) - a window is the
//      person's unless the plugin was asked to open it for an agent (design section 10), so the one
//      somebody is working in is never a candidate and they need set no flag to keep it.
//   3. With no agent window free it ASKS one for another (POST /window) and claims the port that
//      appears - which is the ordinary path now, not the fallback it was: the plugin pre-claims that
//      window for whoever asked, so the two seconds it costs cannot be lost to another scan.
//      A shim cannot make a window itself: relaunching the exe with the same --userData forwards to
//      the running instance and exits 0 (measured, section 8), so creation belongs to the plugin.
//   4. Failing even that it SHARES a window somebody handed over and says so on stderr, with
//      `held_by` still guarding every edit. A window the person at the keyboard is working in is
//      never taken, not even as the fallback: that is what the flip is for.
//
// `held_by` is untouched by all of this. The goal of a window each is to stop NEEDING the refusal,
// not to weaken it (section 6.3).
let windowState = null; // {base, port, window, claimed, claimable, shared}
let sharedNoted = false;
/** When the last scan came back empty, so an unopened Blockbench is not swept for every 3 seconds. */
let lastEmptyScan = 0;
/** Where calls go. The resolved window while there is one, else the configured base. */
const baseUrl = () => windowState?.base ?? BLOCKBENCH_URL;
/** For a message: the one window when it is known, and the range that was searched when it is not. */
export function blockbenchWhere() {
  if (!BLOCKBENCH_URL) return "off (MCPTK_BLOCKBENCH)";
  if (windowState) return windowState.base;
  if (!SCAN || PINNED) return BLOCKBENCH_URL;
  return `${SCAN.host}:${SCAN.from}-${SCAN.to}`;
}
/**
 * The window this session works in, for the lines a human reads. Which window a session got is the
 * whole of what step 2 changed, and until this was said out loud the only place to see it was the
 * plugin's own status box - inside the app, one window at a time, which is exactly the view that
 * cannot answer "did these two sessions land in two windows?".
 */
export function blockbenchWindow() { return windowState; }
/** The window in one phrase: `25802 (win-3f2a, claimed)`, or how it is being shared instead. */
export function blockbenchWindowNote() {
  const w = windowState;
  if (!w) return null;
  const how = w.pinned ? "pinned" : w.shared ? "SHARED with another session"
    : w.docked ? "from the MCP Dock" : w.claimed ? "claimed" : "unclaimed";
  return `${w.port}${w.window ? ` (${w.window})` : ""} — ${how}`;
}

async function helloAt(base) {
  const res = await fetch(`${base}/hello`, { headers: headers(), signal: AbortSignal.timeout(HELLO_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GET /hello: HTTP ${res.status}`);
  const h = await res.json();
  if (!h || h.ok === false) throw new Error("GET /hello: not a bridge");
  // A SCAN asks strangers, which a single configured URL never did: sixteen ports on localhost are
  // sixteen chances to find some other service that answers JSON on /hello and is not Blockbench.
  // Such a thing could not be claimed (`takeable` needs a window block) but could be SHARED, which
  // would quietly send every `/cmd` of this session to it. The app says who answered; believe it.
  if (h.app !== "blockbench") throw new Error(`GET /hello: not Blockbench (app: ${JSON.stringify(h.app ?? null)})`);
  return h;
}
/**
 * POST /claim. Returns the plugin's envelope, or null when this Blockbench does not know the route
 * (a plugin from before step 2, or a stub): a 404 is "there is nothing to claim here", which is a
 * window to use, not a window to skip.
 */
async function claimAt(base) {
  let res;
  try {
    res = await fetch(`${base}/claim`, {
      method: "POST", headers: headers(), body: JSON.stringify({ session: blockbenchSession() }),
      signal: AbortSignal.timeout(HELLO_TIMEOUT_MS),
    });
  } catch { return null; }
  if (res.status === 404) { res.body?.cancel?.(); return null; }
  try { return await res.json(); } catch { return null; }
}
async function scanWindows() {
  const found = [];
  await Promise.all(ports().map(async (port) => {
    const base = baseOf(port);
    try { found.push({ base, port, hello: await helloAt(base) }); } catch { /* nothing there */ }
  }));
  found.sort((a, b) => a.port - b.port);
  return found;
}
const mineIn = (found) => found.find((w) => w.hello.claimed_by?.session === SESSION_ID) ?? null;
/**
 * A window an agent session may take, and the DEFAULT FLIPPED here at plugin 0.7.0
 * (BLOCKBENCH_ISOLATION_DESIGN.md section 10): a window is the person's unless it was opened FOR an
 * agent, so what makes one takeable is `agent`, not "nobody has claimed it yet". Before this, the
 * window somebody was working in was the first thing a scanning shim claimed unless they had
 * remembered to reserve it - a flag you have to set to be safe is one you find out about by losing
 * your tab. `allow_agents` is the person's own opt-in the other way.
 *
 * A plugin from before 0.7.0 sends neither field; there the old reading is the best available, and
 * it is what that plugin's own claim route would enforce anyway. A 0.7.0 plugin keeps `reserved`
 * answering true for a person's window for the same reason from the other side.
 */
const agentWindow = (h) => (h.agent === undefined ? !h.reserved : h.agent === true || h.allow_agents === true);
const takeable = (w) => !!w.hello.window && agentWindow(w.hello) && !w.hello.claimed_by;
function use(w, extra) {
  // The presence socket is what makes a claim and a binding die WITH this process rather than two
  // minutes after it. It must therefore hang off the window we are actually working in: a window
  // change with presence still open would leave the socket in the old window and this session known
  // to the new one only by its `seen` clock. Drop it here; the next good poll reopens it in place.
  if (presenceState !== "closed" && presenceBase && presenceBase !== w.base) closeBlockbenchPresence();
  windowState = { base: w.base, port: w.port, window: w.hello.window ?? null, claimable: !!w.hello.window, claimed: false, shared: false, ...extra };
  return windowState;
}
/**
 * TWO PROCESSES, ONE WINDOW, and why that needs no machinery. A session is the shim AND, in a
 * consumer repo, that repo's own Blockbench proxy; both compute the same id from the parent pid
 * (design section 6.1) and both discover on their own, with no channel between them. They converge
 * anyway, for a reason worth writing down rather than re-deriving each time: the range is walked in
 * PORT ORDER, so both try the same window first, and a claim from an id that already holds a window
 * is a REJOIN rather than a refusal - so whichever arrives second is handed the same window, whether
 * or not it saw the first one's claim in its scan. `blockbench-surface.test.mjs` pins both sides of
 * that: two ids take two windows, one id across two processes takes one.
 *
 * A lowest-port tiebreak stood here first, to settle a split neither process could see. It was
 * deleted for failing its own falsifier - removing it turned nothing red, because the rejoin had
 * already done the work - and it was not free: a second full scan on every fresh claim.
 */
/** The dock, if one of the windows that answered is one. */
const dockIn = (found) => found.find((w) => w.hello.role === "dock") ?? null;
/**
 * ASK THE DOCK (BLOCKBENCH_ISOLATION_DESIGN.md section 11.9). When a dock is open it is the front
 * door, and it is strictly better than `askForWindow` below at the same job: it REUSES an empty
 * agent window before making a seventh one - the thing 0.7.0 could not do, because an empty window
 * whose session had gone was unreachable and uncountable - and because it both triggers the window
 * and receives that window's registration, it answers with the PORT.
 *
 * That is the race this deletes. `askForWindow` cannot know which port its window will win, so it
 * has to go back and scan for it, and another session's scan can arrive in that gap and claim the
 * window the first one paid two seconds for. Here there is no gap and no second scan.
 *
 * Null means "no dock, or it could not help" and the caller falls through to the 0.7.0 path, which
 * is also what happens against a Blockbench whose plugin is older than the dock.
 */
async function askTheDock(found) {
  const dock = dockIn(found);
  if (!dock) return null;
  let env;
  try {
    const res = await fetch(`${dock.base}/dock/window`, {
      method: "POST", headers: headers(), body: JSON.stringify({ session: blockbenchSession() }),
      signal: AbortSignal.timeout(WINDOW_WAIT_MS * 2),
    });
    env = await res.json();
  } catch { return null; }
  if (!env?.ok || typeof env.port !== "number") {
    if (env?.error) {
      process.stderr.write(`[mcp-toolkit] blockbench: the MCP Dock on port ${dock.port} could not give `
        + `this session a window — ${env.error}${env.hint ? ` (${env.hint})` : ""}\n`);
    }
    return null;
  }
  const base = baseOf(env.port);
  // The dock pre-claims the window for whoever asked, so this is a rejoin and cannot be refused. It
  // is still MADE, because the claim is what another session's scan reads later.
  const claimed = await claimAt(base);
  return use({ base, port: env.port, hello: { window: env.window ?? claimed?.window ?? null } },
    { claimed: claimed?.ok === true, docked: true });
}
/**
 * Ask a window we are allowed to ask for a new one, then claim the port that appears. Preference is
 * ours, then any agent window, then a person's - opening a window does not touch the projects of the
 * window that opens it, so somebody working in one is no reason not to ask it.
 */
async function askForWindow(found) {
  const asker = mineIn(found) ?? found.find((w) => agentWindow(w.hello)) ?? found[0];
  let env;
  try {
    const res = await fetch(`${asker.base}/window`, {
      method: "POST", headers: headers(), body: JSON.stringify({ session: blockbenchSession() }),
      signal: AbortSignal.timeout(HELLO_TIMEOUT_MS * 4),
    });
    env = await res.json();
  } catch { return null; }
  if (!env?.ok) return null;
  if (env.autostart === false) {
    process.stderr.write("[mcp-toolkit] blockbench: asked for a window, but this Blockbench has "
      + "\"Start when Blockbench opens\" off - the new window will serve nothing until somebody clicks "
      + "Tools > MCP Toolkit Bridge > Start in it\n");
  }
  const before = new Set(found.map((w) => w.port));
  const deadline = Date.now() + WINDOW_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    const now = await scanWindows();
    const mine = mineIn(now);
    if (mine) return use(mine, { claimed: true });
    const fresh = now.find((w) => !before.has(w.port) && takeable(w));
    if (!fresh) continue;
    const env2 = await claimAt(fresh.base);
    if (env2?.ok) return use(fresh, { claimed: true });
  }
  return null;
}
/**
 * The window this shim works in, discovered once and then remembered. Throws when NOTHING answers -
 * the ordinary "Blockbench isn't open" case, which the caller already treats as no surface today.
 *
 * ONE DISCOVERY AT A TIME. Asking for a window can take WINDOW_WAIT_MS, and the tool-list watcher is
 * only sequential with ITSELF - a tools/call arriving mid-ask would enter here with no window yet,
 * scan again, and post a SECOND `POST /window`, leaving a stray empty Blockbench nobody claimed.
 * Everything after the guard is one in-flight promise that every caller waits on.
 */
const nothing = () => new Error(`no Blockbench window answered on ${SCAN.host}:${SCAN.from}-${SCAN.to}`);
/**
 * A window to READ THE MANIFEST from - which is NOT a window to work in, and must never become one.
 *
 * THE BUG THIS FIXES, reported 2026-09-10 and the root of everything section 11 was cleaning up
 * after: `fetchBlockbenchTools` runs on the tool-list WATCHER, for every session, on a poll cadence,
 * whether or not anybody ever touches Blockbench - and it called `resolveWindow`, which claims or
 * CREATES one. So four live sessions and a Blockbench that starts meant four windows instantly, none
 * of which would ever be used; and closing one made that session's `/tools` fail, drop `windowState`,
 * and ask for a replacement on its next poll. **A person could not close a window at all.** The
 * windows were not leaking - they were being demanded, by sessions that had no work for them.
 *
 * Every window serves the SAME `/tools`, because a manifest is a property of the plugin and not of a
 * window. So reading it needs no ownership: take whatever answers first, claim nothing, open nothing.
 * A window is allocated at the FIRST CALL instead (`callBlockbench`), which is the first moment a
 * session has actually asked Blockbench to do something.
 */
async function peekBase() {
  if (windowState) return windowState.base;
  if (!SCAN) throw new Error(`MCPTK_BLOCKBENCH is not a URL: ${BLOCKBENCH_URL}`);
  if (PINNED) return BLOCKBENCH_URL;
  if (Date.now() - lastEmptyScan < EMPTY_RESCAN_MS) throw nothing();
  const found = await scanWindows();
  if (!found.length) { lastEmptyScan = Date.now(); throw nothing(); }
  // Lowest port first (`scanWindows` sorts), so every idle session reads from the same window and
  // none of them is singled out. A dock is as good as any other for this and costs nothing.
  return found[0].base;
}
let resolving = null;
function resolveWindow() {
  if (windowState) return Promise.resolve(windowState);
  if (resolving) return resolving;
  resolving = discoverWindow();
  resolving.catch(() => { /* the caller's to report; this only clears the slot */ })
    .then(() => { resolving = null; });
  return resolving;
}
async function discoverWindow() {
  if (!SCAN) throw new Error(`MCPTK_BLOCKBENCH is not a URL: ${BLOCKBENCH_URL}`);
  if (PINNED) {
    // A pinned URL is an instruction, not a candidate: claim it so other sessions leave it alone,
    // and use it either way.
    const env = await claimAt(BLOCKBENCH_URL);
    return use({ base: BLOCKBENCH_URL, port: SCAN.from, hello: { window: env?.window ?? null } },
      { claimable: !!env, claimed: env?.ok === true, pinned: true });
  }
  if (Date.now() - lastEmptyScan < EMPTY_RESCAN_MS) throw nothing();
  const found = await scanWindows();
  if (!found.length) {
    lastEmptyScan = Date.now();
    throw nothing();
  }
  const mine = mineIn(found);
  if (mine) return use(mine, { claimed: true });
  // A dock outranks the loop below: it reuses before it creates, and it answers with a port rather
  // than leaving this session to go and find one (section 11.9).
  const docked = await askTheDock(found);
  if (docked) return docked;
  for (const w of found) {
    if (!takeable(w)) continue;
    const env = await claimAt(w.base);
    if (env?.ok) return use(w, { claimed: true });
    // A claim lost to somebody else between the scan and the ask: try the next window, not this one.
  }
  // Every window is spoken for. Ask for one of our own before settling for sharing.
  const opened = await askForWindow(found);
  if (opened) return opened;
  // Sharing is now only ever a window somebody DECIDED to share: since the flip, a window nobody
  // opened for an agent is a window somebody is sitting at, and the old fallback's whole business
  // was walking into one of those.
  const shareable = found.filter((w) => agentWindow(w.hello));
  if (!shareable.length) {
    throw new Error(`no Blockbench window on ${SCAN.host}:${SCAN.from}-${SCAN.to} is available to agent `
      + "sessions, and asking for a new one did not produce one (is this the desktop app, and is "
      + "\"Start when Blockbench opens\" on?). Tools > MCP Toolkit Bridge > Let agents use this window "
      + "hands over the one you are in");
  }
  if (!sharedNoted) {
    sharedNoted = true;
    const w = shareable[0];
    process.stderr.write(`[mcp-toolkit] blockbench: no window of this session's own (asked for one and `
      + `none appeared) — sharing port ${w.port} with `
      + `${w.hello.claimed_by ? `session ${w.hello.claimed_by.session}` : "whoever is there"}. `
      + "Name `project` on every call; an edit on a project another session holds is still refused\n");
  }
  return use(shareable[0], { shared: true });
}
/**
 * While the presence connection is open, the window has not changed under us. When it is NOT - the
 * first poll, or a plugin that was stopped and started, or a Blockbench that quit and came back -
 * the port may now be a DIFFERENT window, so the claim is checked and re-made, and a stranger on
 * our port sends us back to the scan. One extra /hello per poll, and only while presence is down.
 */
async function reconcileWindow() {
  if (!windowState?.claimable || presenceState !== "closed") return;
  let h;
  try { h = await helloAt(windowState.base); } catch { windowState = null; return; }
  if (h.claimed_by?.session === SESSION_ID) return;
  if (windowState.pinned || (h.window === windowState.window && !h.claimed_by && agentWindow(h))) {
    const env = await claimAt(windowState.base);
    if (env?.ok || windowState.pinned) return;
  }
  windowState = null;
}

// --- presence -------------------------------------------------------------------------------------
// One long-lived GET /presence per shim process. The plugin keeps the response open and releases
// this session's binding the moment the socket closes, so a process that exits or is killed frees
// its project AT ONCE - not "seen 15s ago" for the two-minute hold timer, which is how a dead
// `claude -p` child refused the human's own cleanup call on 2026-09-07 (ArmorPieces' measurement,
// BLOCKBENCH_BRIDGE_DESIGN.md section 4). Opened after a successful /tools poll whenever none is
// open: a Blockbench restart reconnects on the next poll, and a plugin (or stub) without the route
// answers 404 and costs one refused request per poll, silently. The socket is unref'd: presence
// must never keep a shim alive past its stdio.
//
// The plugin's first line says how many connections carry THIS session id. Two is two processes
// the plugin cannot tell apart (an inherited MCPTK_SESSION), and the plugin stamps every reply
// with that; the stderr line here is the same fact where the human reads logs.
let presenceState = "closed"; // closed | opening | open
let presenceInfo = null;      // the plugin's first line: {session, connections, project}
let presenceReq = null;
/** The window this socket hangs off, so a window change can be seen to have moved out from under it. */
let presenceBase = null;
export function blockbenchPresence() {
  return { state: presenceState, ...(windowState ? { port: windowState.port, window: windowState.window } : {}), ...(presenceInfo ?? {}) };
}
export function ensureBlockbenchPresence() {
  // ONLY IN A WINDOW WE HOLD. Presence registers this session IN A WINDOW - it is what makes the
  // claim and the binding die with this process - so a session that has not been allocated one has
  // nothing to register and must open nothing. Before lazy allocation `baseUrl()` fell back to the
  // configured base, which since `peekBase` would open the socket in whatever window happens to sit
  // on the first port: presence held in a window the session does not work in, and a claim elsewhere
  // with no socket keeping it alive.
  if (!windowState || presenceState !== "closed") return;
  presenceState = "opening";
  presenceInfo = null;
  presenceBase = baseUrl();
  let u;
  try { u = new URL(`${baseUrl()}/presence`); } catch { presenceState = "closed"; return; }
  const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: "GET", headers: headers() }, (res) => {
    if (res.statusCode !== 200) { res.resume(); presenceState = "closed"; presenceReq = null; return; }
    presenceState = "open";
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      if (presenceInfo) return;
      const line = String(chunk).split("\n")[0].trim();
      if (!line) return;
      try { presenceInfo = JSON.parse(line); } catch { return; }
      if (presenceInfo && presenceInfo.connections > 1) {
        process.stderr.write(`[mcp-toolkit] blockbench: session id "${SESSION_ID}" is held by ${presenceInfo.connections} connections - `
          + "one binding cannot tell them apart (a child process inheriting MCPTK_SESSION?); name `project` on every call\n");
      }
    });
    res.on("close", () => { presenceState = "closed"; presenceInfo = null; presenceReq = null; });
    res.on("error", () => { /* close follows */ });
    if (res.socket && typeof res.socket.unref === "function") res.socket.unref();
  });
  req.on("socket", (sock) => { if (typeof sock.unref === "function") sock.unref(); });
  req.on("error", () => { presenceState = "closed"; presenceInfo = null; presenceReq = null; });
  req.end();
  presenceReq = req;
}
/** Drop the presence connection (the plugin releases the binding at once). For tests and a clean exit. */
export function closeBlockbenchPresence() {
  if (presenceReq) { try { presenceReq.destroy(); } catch { /* gone */ } }
  presenceReq = null;
  presenceState = "closed";
  presenceInfo = null;
  presenceBase = null;
}

/** Names last seen from Blockbench, and their mechanism. The call router asks this, so it must survive a failed poll. */
let known = new Set();
const mechanisms = new Map();

/**
 * Blockbench's tool list, normalized to the fields the served manifest carries, plus `mechanism`.
 *
 * Throws when Blockbench isn't there - which is the ordinary case, not an error condition: the app
 * is open some afternoons and not others. buildToolList treats a throw as "no Blockbench surface
 * today", exactly as it treats a down game bridge.
 */
export async function fetchBlockbenchTools() {
  if (!BLOCKBENCH_URL) throw new Error("blockbench upstream disabled (MCPTK_BLOCKBENCH)");
  // Only reconcile a window we actually HOLD; discovery itself must not take one (see `peekBase`).
  if (windowState) await reconcileWindow();
  const base = await peekBase();
  let res;
  try {
    res = await fetch(`${base}/tools`, { headers: headers(), signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
  } catch (e) {
    // The window we were working in is gone. Forget it, so the next poll scans the range again -
    // Blockbench restarting is an upstream that went away and came back, and it may come back as a
    // different window on a different port.
    windowState = null;
    throw e;
  }
  if (!res.ok) { windowState = null; throw new Error(`GET /tools: HTTP ${res.status}`); }
  const list = await res.json();
  if (!Array.isArray(list)) throw new Error("GET /tools: not a manifest");
  const tools = list.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    mechanism: t.mechanism,
  }));
  known = new Set(tools.map((t) => t.name));
  mechanisms.clear();
  for (const t of tools) if (typeof t.mechanism === "string") mechanisms.set(t.name, t.mechanism);
  ensureBlockbenchPresence();
  return tools;
}

/** Is this name one Blockbench last offered? Answers from the last successful list, never a fetch. */
export function isBlockbenchTool(name) {
  return known.has(name);
}

/**
 * Has this session EVER had a Blockbench manifest? The difference between "not one of its names"
 * and "no names to be one of" - which is what lets the router tell an unknown name that is a typo
 * from one it simply cannot classify yet (index.mjs, the lazy first list).
 */
export function hasBlockbenchManifest() {
  return known.size > 0;
}

/**
 * The mechanism a Blockbench tool carries, from its manifest entry. A name the manifest did not
 * stamp is an EDIT by default, which fails toward a loop check that runs one time too many rather
 * than one time too few.
 */
export function blockbenchMechanism(name) {
  return mechanisms.get(name) ?? "blockbench_edit";
}

/**
 * Un-learn names this session will not serve as Blockbench's - today, only ones a bridge tool already
 * owns (buildToolList drops the colliding entry, and the router must not then route that name here).
 *
 * NOT called when a profile stops serving Blockbench, and that is deliberate. Forgetting there looked
 * tidier and quietly broke the refusal: a client holding a tool list from before the switch can still
 * name `place_cube`, and a shim that has forgotten the name treats it as an ordinary unknown tool and
 * FORWARDS IT TO THE GAME BRIDGE. The call still fails, so a probe asserting "it refuses" stays green
 * while the session is doing something else entirely. Remembering is what makes `isServed` able to
 * answer `profile_hidden` - the honest refusal - instead.
 */
export function dropBlockbenchNames(names) {
  for (const n of names) known.delete(n);
}

/**
 * Call a Blockbench tool. Returns the plugin's envelope `{ok, result, mechanism}` on success and
 * throws with the plugin's own sentence (and hint) on `ok:false`, so the caller renders one shape.
 */
export async function callBlockbench(name, args) {
  if (!BLOCKBENCH_URL) throw new Error("blockbench upstream disabled (MCPTK_BLOCKBENCH)");
  // A call can be the FIRST thing that needs a window (a client holding a tool list from before a
  // Blockbench restart). Discovery failing there is the same "Blockbench isn't open" as below, and
  // must say the same thing about it.
  let base;
  try {
    base = windowState ? windowState.base : (await resolveWindow()).base;
  } catch (e) {
    throw new Error(`${e.message}. Is Blockbench open with the MCP Toolkit Bridge plugin started `
      + "(Tools > MCP Toolkit Bridge > Start)?");
  }
  let res;
  try {
    res = await fetch(`${base}/cmd`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ tool: name, args: args ?? {}, session: blockbenchSession() }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch (e) {
    if (e.name === "TimeoutError" || e.name === "AbortError" || /timed? ?out/i.test(e.message)) {
      throw new Error(
        `Blockbench accepted "${name}" but gave no answer within ${CALL_TIMEOUT_MS / 1000}s. `
        + "Blockbench may be sitting in a dialog of its own; ask the person at the keyboard to look at "
        + "the Blockbench window before treating this as a dead server.");
    }
    windowState = null;
    throw new Error(`Blockbench unreachable at ${base} (${e.message}). Is Blockbench open with `
      + "the MCP Toolkit Bridge plugin started (Tools > MCP Toolkit Bridge > Start)?");
  }
  let env;
  try {
    env = await res.json();
  } catch {
    throw new Error(`Blockbench answered "${name}" with HTTP ${res.status} and no JSON`);
  }
  if (!env || env.ok !== true) {
    const msg = env?.error ?? `HTTP ${res.status}`;
    throw new Error(env?.hint ? `${msg}. ${env.hint}` : msg);
  }
  return env;
}
