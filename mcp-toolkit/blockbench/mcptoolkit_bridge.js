// MCP Toolkit: Bridge - the toolkit's own Blockbench plugin. BLOCKBENCH_BRIDGE_DESIGN.md is the record.
//
// WHAT THIS IS. The door between the toolkit's MCP shim (mcp-server/upstream/blockbench.mjs) and a
// running Blockbench: a small HTTP server on 127.0.0.1 speaking the same shape the GAME bridge
// speaks (GET /hello, GET /tools, GET /presence, POST /cmd), a queue so that calls from several sessions never
// interleave, a session -> project binding so that a call never lands in "whichever tab was
// active", and a tool surface designed the way the toolkit's own tools are: argument-checked by
// name, stamped with a mechanism, answering with the numbers the caller would otherwise spend a
// turn reading back, one undo entry per edit.
//
// WHAT THIS IS NOT. An editor. Geometry, codecs, undo, the texture canvas and the viewport are
// Blockbench's, and this file only calls them (design section 2). The two older plugins beside
// this one (mcptoolkit_sync.js, mcptoolkit_entity.js) are unchanged and are reached through
// `risky_eval` exactly as before.
//
// HOW A PLUGIN GETS `http`. Blockbench 5's sandbox gates native modules behind a permission
// dialog and `http` is on no list at all; a plugin holding the `process` grant reaches it through
// `process.getBuiltinModule('http')` (Node 24 in Blockbench 5.1.6). The grant is asked for ONCE,
// and never with a modal this file opens by itself: the permission dialog is synchronous and
// freezes the renderer for every session using Blockbench until a human clicks, so `onload` asks
// with `show_permission_dialog:false` and, when refused, waits for Tools > MCP Toolkit Bridge >
// Start, where a human is by definition present. Files are read and written through
// `Blockbench.read` / `Blockbench.writeFile` (app code, no grant), so `fs` is never requested.
//
// ONE WINDOW PER SESSION (BLOCKBENCH_ISOLATION_DESIGN.md sections 6.3 and 10). Blockbench has one
// active tab per WINDOW and a second window is a fresh realm, so the window is the unit of
// ownership: each window's plugin scans upward from the base port for a free one and the port it
// wins IS that window's name; a shim scans the same range and asks each `GET /hello`.
//
// A WINDOW IS THE PERSON'S UNLESS IT WAS OPENED FOR AN AGENT. `POST /window` leaves the asker's id
// in shared storage and the next window to win a port consumes it, which makes that window
// agent-born and pre-claimed for whoever paid for it; only such a window can be claimed, so nobody
// has to remember to protect the one they are sitting at. (Measured 2026-09-08: relaunching the exe
// with the same --userData forwards to the running instance and adds no window, so only the in-app
// action makes one, which puts window creation in here.) Tools > MCP Toolkit Bridge > Let agents
// use this window is the deliberate exception, for handing yours over.
//
// AND AN AGENT-BORN WINDOW CLOSES ITSELF once nothing holds it and nothing is open in it - never
// the last one, which would quit the app. The per-project `held_by` refusal is untouched by all of
// this: the point of a window each is to stop NEEDING it.
//
// THE MCP DOCK (BLOCKBENCH_ISOLATION_DESIGN.md section 11, and the reason for 0.8.0). All of the
// above left every window to govern itself out of its own memory, and a live scan on 2026-09-10
// found what that costs: six windows serving, every one of them empty, not one with a death
// condition that could fire - three were never agent-born so their sweep never started, three were
// held by sessions that had not gone away, and nothing anywhere had a close route. So the window is
// the unit of OWNERSHIP but cannot also be the unit of GOVERNMENT.
//
// The dock is one window that outranks the rest: it owns the roster, hands windows out
// (`POST /dock/window` - reusing an empty one before making another), arbitrates every close, and is
// never claimed and never closes itself, which is what turns "never the last window" from three
// windows guessing at once into an invariant. It assigns each window its ROLE and can REASSIGN it,
// so a window stuck as somebody's own can be recycled instead of living forever.
//
// A plugin cannot see or touch a window: Blockbench's sandbox has no `electron` and no
// `@electron/remote`, so there is no window list, nothing to focus from outside, nothing to destroy.
// Every cross-window act here is therefore a request the target window serves FOR ITSELF -
// `POST /close`, `POST /focus`, `POST /role` - and a window whose bridge is stopped can be named and
// dated by the dock but only closed by a person. With no dock open, everything below falls back to
// exactly what 0.7.0 did.
//
// INSTALL: File > Plugins > Load Plugin from File; Tools > MCP Toolkit Bridge > Start; allow
// `process` ("Always allow for this plugin"). The shim finds it at http://127.0.0.1:25801.
(function () {
    'use strict';

    const PLUGIN_ID = 'mcptoolkit_bridge';
    const PLUGIN_VERSION = '0.9.0';
    const DEFAULT_PORT = 25801;
    /** How far up from the base port a window looks for one of its own (design section 6.3): the
     *  port a window wins IS its name, and this is how many windows one machine can name. */
    const PORT_SPAN = 16;
    const STORE_KEY = 'mcptoolkit_bridge.settings';
    /** A session with NO presence connection unseen this long releases the project it held (design
     *  section 4). A setting so the harness can shorten it; the default is the designed two minutes.
     *  A session holding a presence connection (GET /presence) is released the moment that
     *  connection closes and never by this timer. */
    const DEFAULT_HOLD_MS = 120000;
    /** A byte down every open presence connection this often, so nothing between the two ends
     *  decides an idle socket is dead. */
    const PRESENCE_BEAT_MS = 30000;
    /** How long a fresh claim holds before it needs a presence socket to keep it. A window claim is
     *  NOT a project binding: a binding protects unsaved work and earns the two-minute hold, a claim
     *  protects nothing, so it dies with the socket. The grace covers the one gap there is - between
     *  winning a window and the shim's first tool-list poll, which is what opens presence - and it is
     *  also what lets a window be PRE-CLAIMED for a session that has not called it yet. */
    const CLAIM_GRACE_MS = 30000;
    const graceMs = () => (isNumLike(settings.claim_grace_ms) ? settings.claim_grace_ms : CLAIM_GRACE_MS);
    /** How long an agent-born window sits empty and unclaimed before it closes itself. Long enough
     *  for a shim whose presence dropped to come back and rejoin, short enough that an afternoon of
     *  sessions leaves no row of empty windows behind (design section 10). */
    const EMPTY_GRACE_MS = 60000;
    const emptyMs = () => (isNumLike(settings.empty_grace_ms) ? settings.empty_grace_ms : EMPTY_GRACE_MS);
    /** How often an agent-born window asks whether it is still needed. */
    const SWEEP_MS = 15000;
    /** An ask nobody came for is dropped rather than handed to whatever window a person opens next. */
    const PENDING_TTL_MS = 120000;
    /** How many calls the panel remembers, so a person can see what the session in this window is
     *  doing without reading a transcript. */
    const RECENT_MAX = 12;
    /** How often a window pushes its state to the dock, and how long without one before the dock
     *  calls it SILENT. Push and not poll, so that "last activity" is the window's own record rather
     *  than something the dock infers (BLOCKBENCH_ISOLATION_DESIGN.md section 11.8). */
    const BEAT_MS = 5000;
    const BEAT_STALE_MS = 20000;
    const beatMs = () => (isNumLike(settings.beat_ms) ? settings.beat_ms : BEAT_MS);
    const beatStaleMs = () => (isNumLike(settings.beat_stale_ms) ? settings.beat_stale_ms : BEAT_STALE_MS);
    /** How often the DOCK scans the port range. The scan says what is SERVING; the beats say what is
     *  ALIVE; the disagreement between them is what names a broken window (section 11.8). */
    const DOCK_SCAN_MS = 5000;
    const dockScanMs = () => (isNumLike(settings.dock_scan_ms) ? settings.dock_scan_ms : DOCK_SCAN_MS);
    /** How long one window is waited for over localhost. A window either answers at once or is not
     *  there, and the dock asks the whole range at once. */
    const REACH_MS = 600;
    const reachMs = () => (isNumLike(settings.reach_ms) ? settings.reach_ms : REACH_MS);
    /** How long the dock waits for a window it asked for to come and register. */
    const BIRTH_MS = 20000;
    const birthMs = () => (isNumLike(settings.birth_ms) ? settings.birth_ms : BIRTH_MS);
    /** The handoff a window leaves for the window it asks for. Its OWN key, read-modify-written on
     *  its own, because `settings` is written back WHOLE and two windows doing that would clobber
     *  each other's keys (design section 5). */
    const PENDING_KEY = 'mcptoolkit_bridge.pending';
    const BODY_LIMIT = 32 * 1024 * 1024;
    const FACES = ['north', 'south', 'east', 'west', 'up', 'down'];
    const EDIT = 'blockbench_edit';
    const OBSERVE = 'observe';

    // ------------------------------------------------------------------ settings
    // `shared_port` is the one piece of window state that IS persisted, and the shape is why it can
    // be: settings are a single store every window reads at boot and writes back whole (design
    // section 5), so a per-window `shared: true` would share them all. A PORT NUMBER survives that -
    // each window asks "is the port I won the shared one", and exactly one can answer yes.
    //
    // THE FLAG IS INVERTED from 0.6.0's `reserved_port`, and the inversion is the whole point of
    // design section 10: a window belongs to the person at the keyboard unless it was opened FOR an
    // agent, so nobody has to remember to protect their own. What is persisted now is the opposite
    // and much rarer act - a person handing THIS window over. 0.6.0's stored `reserved_port` is
    // deliberately not migrated: its meaning is gone, and reading it would share the one window it
    // was written to protect.
    // `dock_port` is where the MCP Dock was last seen. It is a HINT and never what makes a window
    // the dock (section 11.7): a window becomes the dock by adopting a `dock` handoff or by the menu
    // action, so a stale port left by a crash heals itself - whoever answers there says `role` and a
    // window that is not the dock 404s `/dock/hello`.
    const settings = { port: DEFAULT_PORT, autostart: true, hold_ms: DEFAULT_HOLD_MS, shared_port: null, dock_port: null };
    const holdMs = () => (isNumLike(settings.hold_ms) ? settings.hold_ms : DEFAULT_HOLD_MS);
    function isNumLike(v) { return typeof v === "number" && Number.isFinite(v) && v > 0; }
    function loadSettings() {
        try {
            const raw = localStorage.getItem(STORE_KEY);
            if (raw) Object.assign(settings, JSON.parse(raw));
        } catch (e) { /* a cleared storage is the defaults */ }
        return settings;
    }
    function saveSettings(patch) {
        Object.assign(settings, patch || {});
        try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch (e) { /* not worth failing */ }
        return settings;
    }

    // ------------------------------------------------------------------ small helpers
    function fail(message, hint) {
        const e = new Error(message);
        if (hint) e.hint = hint;
        throw e;
    }
    const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
    const vec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(isNum);
    const round = (n, d = 3) => Math.round(n * Math.pow(10, d)) / Math.pow(10, d);
    const rv = (v) => (Array.isArray(v) ? v.map((n) => round(n)) : v);
    const now = () => Date.now();

    function rgba(v) {
        if (v === null || v === undefined) return null;
        if (typeof v === 'number') { const g = Math.max(0, Math.min(255, Math.round(v))); return [g, g, g, 255]; }
        if (Array.isArray(v) && (v.length === 3 || v.length === 4) && v.every(isNum)) {
            return [v[0], v[1], v[2], v.length === 4 ? v[3] : 255].map((n) => Math.max(0, Math.min(255, Math.round(n))));
        }
        const s = String(v).trim();
        let m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s);
        if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16), m[2] ? parseInt(m[2], 16) : 255];
        m = /^#?([0-9a-f]{3})$/i.exec(s);
        if (m) return [parseInt(m[1][0] + m[1][0], 16), parseInt(m[1][1] + m[1][1], 16), parseInt(m[1][2] + m[1][2], 16), 255];
        fail('not a colour: ' + JSON.stringify(v) + ' (use "#rrggbb", "#rrggbbaa", [r,g,b,a] or a grey 0-255)');
    }
    const hex = (c) => '#' + [c[0], c[1], c[2]].map((n) => n.toString(16).padStart(2, '0')).join('') + (c[3] === 255 ? '' : c[3].toString(16).padStart(2, '0'));
    const lerp = (a, b, t) => [0, 1, 2, 3].map((i) => Math.round(a[i] + (b[i] - a[i]) * t));

    // ------------------------------------------------------------------ argument checking
    // The bridge's ArgCheck discipline: an undeclared argument, a wrong type or a value outside an
    // enum is refused BY NAME before anything runs. Schemas are ordinary JSON Schema subsets and
    // `additionalProperties:false` is the default here, not the exception.
    function typeOf(v) {
        if (v === null) return 'null';
        if (Array.isArray(v)) return 'array';
        return typeof v;
    }
    function checkArgs(schema, value, path) {
        if (!schema) return;
        const t = schema.type;
        if (t === 'integer') {
            if (!Number.isInteger(value)) fail(path + ': expected an integer, got ' + JSON.stringify(value));
        } else if (t && t !== typeOf(value) && !(t === 'number' && isNum(value))) {
            if (!(Array.isArray(t) && t.indexOf(typeOf(value)) >= 0)) {
                fail(path + ': expected ' + (Array.isArray(t) ? t.join('|') : t) + ', got ' + typeOf(value));
            }
        }
        if (schema.enum && schema.enum.indexOf(value) < 0) fail(path + ': must be one of ' + schema.enum.join(', ') + ', not ' + JSON.stringify(value));
        if (t === 'object' && value && typeof value === 'object') {
            const props = schema.properties || {};
            if (schema.additionalProperties !== true) {
                const unknown = Object.keys(value).filter((k) => !(k in props));
                if (unknown.length) {
                    fail(path + ': undeclared argument(s) ' + unknown.join(', ') + '; declared: ' + Object.keys(props).join(', '));
                }
            }
            for (const k of schema.required || []) if (!(k in value)) fail(path + ': missing required "' + k + '"');
            for (const k of Object.keys(value)) if (props[k]) checkArgs(props[k], value[k], path + '.' + k);
        }
        if (t === 'array' && Array.isArray(value)) {
            if (isNum(schema.minItems) && value.length < schema.minItems) fail(path + ': needs at least ' + schema.minItems + ' item(s)');
            if (isNum(schema.maxItems) && value.length > schema.maxItems) fail(path + ': at most ' + schema.maxItems + ' item(s)');
            if (schema.items) value.forEach((v, i) => checkArgs(schema.items, v, path + '[' + i + ']'));
        }
    }
    const V3 = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 };
    const V2 = { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 };
    const COLOUR = { description: 'colour: "#rrggbb", "#rrggbbaa", [r,g,b,a] or a grey 0-255; null clears' };
    const PROJECT_ARG = { type: 'string', description: 'Project name or uuid. Omit for the project this session is bound to (or the active tab, reported as bound:false).' };
    const LOOK_ARG = { type: 'boolean', description: 'Also return the viewport picture on this reply (a turn saved per look).' };
    const IDS_ARG = { type: 'array', items: { type: 'string' }, description: 'Element names or uuids.' };

    // ------------------------------------------------------------------ sessions and projects
    /** id -> {client, profile, game, project (uuid|null), seen, warned, connections (Set of sockets)} */
    const sessions = {};
    function session(block) {
        const id = (block && block.id) || 'anonymous';
        const s = sessions[id] || (sessions[id] = { id, project: null, game: null, seen: 0, warned: false, connections: new Set() });
        if (block && block.client) s.client = block.client;
        if (block && block.profile) s.profile = block.profile;
        // WHICH GAME this session drives (TODO.md 1.9). Kept here beside the project binding for the
        // same reason the binding is here: it is a fact about the SESSION, and the two older plugins
        // reached through `risky_eval` had to guess at both. `risky_eval` hands it to the code as
        // `GAME`, so `mcptoolkitPush({project: PROJECT, bridge: GAME})` cannot resolve wrongly in
        // either dimension. The shim puts it on every call's session block, so a window that was
        // never claimed still learns it.
        if (block && block.game) s.game = block.game;
        s.seen = now();
        return s;
    }
    /** Holds a presence connection: alive for as long as the socket is, whatever the clock says. */
    function connected(s) { return s.connections.size > 0; }
    /** Alive: connected, or (a client without presence - curl by hand) seen inside the hold window. */
    function alive(s) { return connected(s) || now() - s.seen <= holdMs(); }
    function reapSessions() {
        for (const id of Object.keys(sessions)) {
            if (!alive(sessions[id])) sessions[id].project = null;
        }
        releaseDeadClaim();
    }
    function holderOf(project, except) {
        for (const id of Object.keys(sessions)) {
            const s = sessions[id];
            if (s !== except && s.project === project.uuid && alive(s)) return s;
        }
        return null;
    }
    /** The sentence that says how a holder is known to be alive. */
    function liveness(s) {
        return connected(s) ? 'connected' : 'seen ' + Math.round((now() - s.seen) / 1000) + 's ago';
    }
    function holderBlock(s) {
        return { session: s.id, client: s.client || null, connected: connected(s), seen_s_ago: Math.round((now() - s.seen) / 1000) };
    }
    /**
     * One session id on more than one live socket is two processes that cannot be told apart - the
     * shape ArmorPieces' parallel batch had on 2026-09-07 (MCPTK_SESSION inherited by every
     * `claude -p` child): every unqualified call of every child landed in ONE binding, which was
     * another child's piece. The binding cannot be fixed from here; the reply can say so, with the
     * one thing a caller can do about it. Stamped on every reply while it holds: the condition is
     * abnormal and each of the processes must see it, not just the first to call.
     */
    function sharedIdNote(s) {
        const n = s.connections.size;
        if (n < 2) return null;
        return { id: s.id, connections: n, note: 'session id "' + s.id + '" is held by ' + n + ' connections; one binding cannot tell them apart (a child process inheriting MCPTK_SESSION?). Name `project` on every call.' };
    }
    function projects() { return (typeof ModelProject !== 'undefined' && ModelProject.all) || []; }
    function activeProject() { return (typeof Project !== 'undefined' && Project) ? Project : null; }
    function findProject(ref) {
        const all = projects();
        const hit = all.find((p) => p.uuid === ref) || all.find((p) => p.name === ref);
        if (!hit) {
            const names = all.map((p) => p.name).join(', ') || '(none open)';
            fail('no open project "' + ref + '" (open: ' + names + ')', 'project op:list shows them; project op:open {path} opens one');
        }
        return hit;
    }
    function ensureSelected(p) {
        if (activeProject() !== p) {
            const r = p.select();
            if (r === false) fail('project "' + p.name + '" refused to be selected (locked tab?)');
        }
    }
    /**
     * Which project a call is for (design section 4): the named one, else the session's bound
     * one, else the active tab with bound:false. Selects it. Returns the block every reply carries.
     */
    function resolveProject(args, sess, needed) {
        let p = null;
        let bound = false;
        if (args && args.project) {
            p = findProject(args.project);
            bound = sess.project === p.uuid;
        } else if (sess.project) {
            p = projects().find((x) => x.uuid === sess.project) || null;
            if (!p) {
                sess.project = null;
                fail('the project this session was bound to has been closed', 'project op:list, then project op:select or op:open');
            }
            bound = true;
        } else {
            p = activeProject();
            // The FALLBACK must not answer with someone else's work. A session with no binding has
            // nothing to resolve, so it lands on the active tab - which in a shared window belongs to
            // whoever is working. Measured 2026-09-08: a refused session asked about its OWN project
            // and was handed 23 cubes and the bones of another session's piece. A project the caller
            // NAMES is still read freely (reads are unrefused by design, section 4 of the isolation
            // record); it is only the fallback that stops.
            const owner = p ? holderOf(p, sess) : null;
            if (owner) {
                fail('held_by: session ' + owner.id + (owner.client ? ' (' + owner.client + ')' : '') + ' is bound to the active tab "' + p.name + '", ' + liveness(owner) + '; an unbound session does not fall through into a project another session holds',
                    'project op:new or op:open to work in your own, project op:list to see the tabs, or name it ({project:"' + p.name + '"}) to read theirs on purpose');
            }
        }
        if (!p) {
            if (needed) fail('no project is open', 'project op:new {name, format} or op:open {path}');
            return { name: null, bound: false, project: null };
        }
        ensureSelected(p);
        const block = { name: p.name, bound };
        if (!bound && !sess.warned) {
            sess.warned = true;
            block.note = 'unbound: acting on the active tab; project op:select {project} (or op:new/op:open) binds this session to one';
        }
        block.project = p;
        return block;
    }
    function guardHeld(p, sess) {
        const h = holderOf(p, sess);
        if (h) {
            fail('held_by: session ' + h.id + (h.client ? ' (' + h.client + ')' : '') + ' is bound to "' + p.name + '", ' + liveness(h),
                'work in your own project, or project op:select {project:"' + p.name + '", take:true}');
        }
    }

    // ------------------------------------------------------------------ this window
    /**
     * The window is the unit of ownership (design section 6.3), and section 10 says WHOSE: a window
     * belongs to the person at the keyboard unless this plugin was asked to open it for an agent.
     * `agentBorn` is that fact, and it is per-window and in memory on purpose - a Blockbench that is
     * restarted was started by a PERSON, so every window it comes back with is theirs again.
     *
     * `allowAgents` is the one deliberate exception, a person handing this window over, and it is
     * the only piece that persists (as `shared_port`, above). It is not co-authoring: an agent that
     * claims a donated window still steals the active tab whenever it reads its own model, because
     * one project is live at a time and no plugin can change that (section 4). Working in a person's
     * tab BESIDE them is a separate route (`connect`) and is not built.
     *
     * The port this window won is its NAME: a shim scans the range, and the port is what it puts in
     * its URL. WINDOW_ID is the second half of the same fact - it changes when the plugin restarts,
     * which is how a shim tells "my window came back" from "somebody else now answers on my port".
     */
    const WINDOW_ID = 'win-' + Math.random().toString(36).slice(2, 10);
    let boundPort = null;
    let agentBorn = false;
    let allowAgents = false;
    /**
     * THE DOCK (section 11.5). One window that outranks the rest: it owns the roster, it allocates
     * windows, it arbitrates every close, and it is never claimed and never closes itself. That last
     * pair is what makes "never the last window" a fact rather than the check-then-act race of 0.7.0
     * - the dock is always there, so no other window is ever the last one.
     *
     * A window becomes the dock by ADOPTING a `dock` handoff or by the menu action, never by finding
     * its own port in `settings.dock_port`: a port left behind by a crash would otherwise make the
     * first window a person opens into a dock they never asked for.
     */
    let isDock = false;
    /** The whole of a window's standing in one word, which is what the roster and the title show. */
    function role() { return isDock ? 'dock' : agentBorn ? 'agent' : 'person'; }
    let claimedBy = null; // session id, or null
    let claimedAt = 0;
    /**
     * The session holding this window, if the claim is still live - and "live" is NOT what it is for
     * a project binding. A binding survives a dropped socket for `hold_ms` because unsaved work is
     * behind it; a window claim has nothing behind it, so it dies with the socket, and the only
     * grace is the seconds a fresh claim needs before presence can possibly have arrived. Without
     * that distinction a session that died in the gap left its window looking taken for two minutes,
     * and the next session opened another rather than reusing it (design section 10).
     */
    function claimHolder() {
        const s = claimedBy ? sessions[claimedBy] : null;
        if (!s) return null;
        return connected(s) || now() - claimedAt <= graceMs() ? s : null;
    }
    function releaseDeadClaim() {
        if (claimedBy && !claimHolder()) { claimedBy = null; armEmptyCheck(); refreshIdentity(); }
    }
    /** Is this a window an agent session may claim at all? */
    function claimable() { return !isDock && (agentBorn || allowAgents); }
    /**
     * Read the persisted hand-over back onto THIS window, which can only be done once a port has
     * been won: what is stored is a port, and the port is what names a window.
     */
    function applyShare() {
        if (isNumLike(settings.shared_port)) allowAgents = boundPort === settings.shared_port;
    }
    /**
     * Hand this window to agent sessions, or take it back. `persist` writes the port into the shared
     * store so the hand-over survives a restart; the harness and `risky_eval` use the in-memory form.
     * Taking it back clears the stored port only when it is THIS window's - a person here must not
     * silently take back the window somebody handed over on another port.
     */
    function setAllowAgents(v, persist) {
        allowAgents = v === undefined ? !allowAgents : !!v;
        if (persist) {
            if (allowAgents) saveSettings({ shared_port: boundPort });
            else if (settings.shared_port === boundPort) saveSettings({ shared_port: null });
        }
        if (!claimable()) claimedBy = null;
        refreshIdentity();
        return windowBlock();
    }
    function windowBlock() {
        const h = claimHolder();
        return {
            window: WINDOW_ID,
            port: boundPort,
            base_port: settings.port,
            span: PORT_SPAN,
            // WHO THIS WINDOW IS FOR. `agent` is true only of a window this plugin was asked to open;
            // `allow_agents` is a person handing over the one they are sitting at. Anything else is
            // somebody's own window: never claimed, never shared, nothing to remember to switch on.
            agent: agentBorn,
            allow_agents: allowAgents,
            // `reserved` is kept, DERIVED, for a shim from before 0.7.0: that one read "not reserved"
            // as "yours to take", so a person's window has to go on answering yes to it, or an old
            // shim in a stale extraction would claim the very window the flip exists to protect.
            reserved: !claimable(),
            claimed_by: h ? holderBlock(h) : null,
            // Section 11.7: the ROLE is the whole standing in one word, and `dock` is the third value
            // 0.7.0 had no room for. `agent` and `reserved` stay beside it, unchanged, for a shim
            // from before this that reads those and has never heard of a dock.
            role: role(),
            dock_port: isNumLike(settings.dock_port) ? settings.dock_port : null,
        };
    }
    /**
     * What this window is DOING, as opposed to whose it is: the two fields a person needs to judge a
     * row in the dock and cannot get from `windowBlock` - what is open (and whether any of it is
     * unsaved, because that is what makes a close refuse) and when a session last did anything here.
     * It rides `GET /hello` and every beat, so the dock's picture and a `curl` agree by construction.
     */
    function stateBlock() {
        const last = recent.length ? recent[recent.length - 1] : null;
        return {
            // `open`, not `projects`: `GET /hello` has answered `projects` with a COUNT since the
            // first version of this plugin and something out there reads it. A new field is cheaper
            // than a shape somebody has to be told about.
            open: projects().map((p) => ({ name: p.name, saved: !!p.saved })),
            dirty: projects().filter((p) => !p.saved).length,
            last_call: last ? { name: last.name, ok: last.ok, session: last.session, s_ago: Math.round((now() - last.at) / 1000) } : null,
        };
    }
    /**
     * POST /claim. A window is claimed by one session at a time, and the claim dies with the
     * session exactly as a project binding does (the presence socket closing is the signal). It is
     * NOT enforced on /cmd: the claim steers DISCOVERY, so that two shims land in two windows
     * instead of racing for one tab. What refuses a call is still `held_by`, per project.
     */
    function claimWindow(sb, opts) {
        const s = session(sb);
        releaseDeadClaim();
        if (opts && opts.release) {
            // `released:false` for a session that was not the holder: it must not read as "the window
            // is free now" to a caller that never had it.
            const was = claimedBy === s.id;
            if (was) { claimedBy = null; armEmptyCheck(); refreshIdentity(); }
            return Object.assign({ ok: true, released: was }, windowBlock());
        }
        if (!claimable()) {
            return Object.assign({ ok: false, error: 'not an agent window: this one belongs to the person at the keyboard (a window is theirs unless it was opened for an agent)',
                hint: 'POST /window to be given one of your own, or Tools > MCP Toolkit Bridge > Let agents use this window to hand this one over' }, windowBlock());
        }
        const h = claimHolder();
        if (h && h !== s) {
            return Object.assign({ ok: false, error: 'claimed_by: session ' + h.id + (h.client ? ' (' + h.client + ')' : '') + ' holds this window, ' + liveness(h),
                hint: 'claim another port in the scan range, or POST /window to ask this one to open another' }, windowBlock());
        }
        claimedBy = s.id;
        claimedAt = now();
        freeSince = null;
        refreshIdentity();
        return Object.assign({ ok: true, claimed: true, rejoined: h === s }, windowBlock());
    }

    // ------------------------------------------------------------------ making a window
    /**
     * The handoff between a window that ASKS and the window that is born. Nothing reaches a new
     * renderer directly - `ipcMain.on('new-window')` takes no argument we control - so the fact is
     * left in shared storage and the next window to win a port CONSUMES it. Consumed, not read:
     * exactly one window takes each entry, so two asks make two agent windows and a window a person
     * opens by hand while no ask is outstanding stays theirs.
     *
     * The entry carries the asker's id, which PRE-CLAIMS the window it becomes. The port a new window
     * will win is not knowable here, so the asker has to go and look for it, and in that gap another
     * session's scan can arrive first; a window already claimed for the session that paid for it
     * cannot be taken out from under them.
     */
    function readPending() {
        try {
            const raw = localStorage.getItem(PENDING_KEY);
            const a = raw ? JSON.parse(raw) : [];
            return Array.isArray(a) ? a.filter((e) => e && isNumLike(e.at) && now() - e.at <= PENDING_TTL_MS) : [];
        } catch (e) { return []; }
    }
    function writePending(list) {
        try { localStorage.setItem(PENDING_KEY, JSON.stringify(list)); } catch (e) { /* not worth failing */ }
    }
    function pushPending(id, kind) { writePending(readPending().concat([{ session: id || null, kind: kind || 'agent', at: now() }])); }
    function dropPendingKind(kind) {
        const list = readPending();
        const i = list.findIndex((e) => (e.kind || 'agent') === kind);
        if (i >= 0) { list.splice(i, 1); writePending(list); }
    }
    function dropPending(id) {
        const list = readPending();
        const i = list.findIndex((e) => e.session === id);
        if (i >= 0) { list.splice(i, 1); writePending(list); }
    }
    /** The oldest ask, taken. Null when this window was opened by a person. */
    function takePending() {
        const list = readPending();
        const first = list.length ? list.shift() : null;
        writePending(list);
        return first;
    }
    /**
     * Become the window somebody asked for, if anybody did. Called once a port is won, because the
     * port is what a shim will come looking for.
     */
    function adoptPending() {
        const e = takePending();
        if (!e) return false;
        // A `dock` handoff makes this window the dock instead (section 11.7). It is the one kind the
        // menu writes, and no HTTP route can write one: a dock is a window a PERSON asked for.
        if (e.kind === 'dock') { becomeDock(); return true; }
        agentBorn = true;
        // Through `preClaim`, which makes the session RECORD as well. Setting `claimedBy` alone was
        // 0.7.0's shape and it never worked across windows: `claimHolder()` resolves the id through
        // `sessions`, the asking window is the one that ran `session(sb)`, and THIS window has never
        // heard of that id - so a window pre-claimed for the session that paid for it answered
        // `claimed_by: null` and the next scan could take it. Found live 2026-09-10, on the window
        // this very call opened; the offline test could not see it because one plugin instance
        // played both windows.
        if (e.session) preClaim(e.session);
        freeSince = null;
        startSweep();
        refreshIdentity();
        return true;
    }
    /**
     * POST /window. A shim cannot make itself a window - relaunching the exe with the same
     * --userData forwards to the running instance and exits 0 (measured, design section 8) - so the
     * only thing that creates one is the in-app action, and that lives in here. The new window
     * loads this plugin, autostarts, scans, wins the next free port, and takes the handoff above;
     * the caller finds it by scanning the range again. A person's own window still opens one:
     * making a window does not touch the projects of the window that made it.
     */
    function openWindow(sb) {
        const s = session(sb);
        const item = (typeof BarItems !== 'undefined' && BarItems && BarItems.new_window) || null;
        if (!item || (typeof item.click !== 'function' && typeof item.trigger !== 'function')) {
            return Object.assign({ ok: false, error: 'this Blockbench has no new_window action (not the desktop app?)',
                hint: 'open a window by hand (Window > New Window) and it will take the next free port' }, windowBlock());
        }
        pushPending(s.id);
        try {
            if (typeof item.click === 'function') item.click();
            else item.trigger();
        } catch (e) {
            // No window is coming, so the identity left for it must not sit there waiting to be taken
            // by the next window a person opens by hand.
            dropPending(s.id);
            return Object.assign({ ok: false, error: 'new_window refused: ' + String(e && e.message || e) }, windowBlock());
        }
        // `autostart` is shared settings: a window that will not start its bridge is a window the
        // caller will scan for and never find, so say it here rather than let it time out silently.
        return Object.assign({ ok: true, opened: true, requested_by: s.id, autostart: !!settings.autostart }, windowBlock());
    }

    // ------------------------------------------------------------------ the dock
    /**
     * THE MCP DOCK (BLOCKBENCH_ISOLATION_DESIGN.md section 11). Section 10 made a window belong to
     * somebody and then left every window to govern itself out of its own memory, which is the one
     * shape all five of section 11.3's findings share: `agentBorn` was an in-memory boolean set once
     * and never correctable, an empty window could not be commanded at all, nothing anywhere had a
     * close route, and the never-the-last-window rule was three windows guessing at once.
     *
     * The dock is the place that outranks a window. It owns the roster, it hands windows out, it
     * arbitrates every close, and because it is always present no other window is ever the last one -
     * which turns a distributed race into an invariant.
     *
     * WHAT IT CANNOT DO, and why the shape is what it is (section 11.4): Blockbench's plugin sandbox
     * allows no `electron` and no `@electron/remote`, so there is no `BrowserWindow.getAllWindows()`,
     * no way to focus a window from outside it and no way to destroy one. EVERY cross-window act here
     * is therefore a request the target window serves FOR ITSELF, and a window whose bridge is
     * stopped or whose renderer is wedged can be named and dated but never closed from here.
     */
    let dockPort = null;   // where THIS window believes the dock is (null: no dock, work alone)
    let beatTimer = null;

    /**
     * Hold this window for a session that has not called it yet. The RECORD is made here on purpose:
     * `claimHolder()` resolves the id through `sessions`, so a claim for an id nothing has registered
     * reads as no claim at all - which is the same reason 0.7.0's `POST /window` went through
     * `session(sb)` before it pre-claimed anything.
     */
    function preClaim(id) {
        session({ id: String(id) });
        claimedBy = String(id);
        claimedAt = now();
    }
    /** One request to another window on this machine. Localhost answers at once or is not there. */
    async function reach(port, path, body) {
        if (typeof fetch !== 'function') throw new Error('no fetch in this renderer');
        const opts = { method: body === undefined ? 'GET' : 'POST' };
        if (body !== undefined) { opts.headers = { 'Content-Type': 'application/json' }; opts.body = JSON.stringify(body); }
        if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opts.signal = AbortSignal.timeout(reachMs());
        const res = await fetch('http://127.0.0.1:' + port + path, opts);
        let parsed = null;
        try { parsed = await res.json(); } catch (e) { /* a body that is not JSON is not an answer */ }
        return { status: res.status, body: parsed };
    }

    // --- being a window that has a dock -------------------------------------------------------
    /**
     * Take the standing the dock just handed us. This REPLACES `adoptPending`'s one-shot boolean as
     * the source of a window's role (section 11.7): the dock can answer differently later, on any
     * beat, which is what makes a window stuck as somebody's own recoverable at all.
     */
    function adoptRole(ans) {
        if (!ans || !ans.role || ans.role === role()) {
            if (ans && ans.claim_for && claimedBy !== ans.claim_for) { preClaim(ans.claim_for); refreshIdentity(); }
            return false;
        }
        if (ans.role === 'agent') {
            agentBorn = true;
            if (ans.claim_for) preClaim(ans.claim_for);
            freeSince = null;
            startSweep();
        } else if (ans.role === 'person') {
            agentBorn = false;
            claimedBy = null;
            freeSince = null;
            stopSweep();
        }
        refreshIdentity();
        return true;
    }
    /**
     * Find the dock and say hello. The stored port is a HINT and is tried first because it is one
     * request rather than sixteen; when it misses, the range is scanned for whoever answers with
     * `role: 'dock'`, which is what heals a `dock_port` left behind by a crash.
     */
    async function findDock() {
        if (isDock || !boundPort) return null;
        const hint = isNumLike(settings.dock_port) ? settings.dock_port : null;
        const base = isNumLike(settings.port) ? settings.port : DEFAULT_PORT;
        const span = base === 0 ? 1 : PORT_SPAN;
        const order = [];
        if (hint !== null && hint !== boundPort) order.push(hint);
        for (let p = base; p < base + span; p++) if (p !== boundPort && p !== hint) order.push(p);
        for (const p of order) {
            try {
                const r = await reach(p, '/dock/hello', { window: WINDOW_ID, port: boundPort, role: role() });
                if (r.status === 200 && r.body && r.body.ok) {
                    dockPort = p;
                    if (p !== hint) saveSettings({ dock_port: p });
                    adoptRole(r.body);
                    return p;
                }
            } catch (e) { /* nothing there, or not the dock */ }
        }
        dockPort = null;
        return null;
    }
    /**
     * Push this window's state to the dock. A push and not a poll, so that "last activity" in the
     * roster is this window's own record of what a session did in it rather than something the dock
     * inferred from the outside (section 11.8) - and so that the dock can tell a window that has gone
     * quiet from one that has gone away, which is the whole of its diagnostic.
     */
    async function beat() {
        if (isDock || !server) return;
        if (dockPort === null) { await findDock(); return; }
        try {
            const r = await reach(dockPort, '/dock/beat', Object.assign({}, windowBlock(), stateBlock()));
            if (r.status !== 200 || !r.body || !r.body.ok) { dockPort = null; return; }
            adoptRole(r.body);
        } catch (e) { dockPort = null; }
    }
    function startBeat() {
        if (beatTimer || isDock) return;
        beatTimer = setInterval(() => { Promise.resolve(beat()).catch(() => { /* next beat */ }); }, beatMs());
        if (beatTimer.unref) beatTimer.unref();
    }
    function stopBeat() { if (beatTimer) { clearInterval(beatTimer); beatTimer = null; } }

    // --- the three things every window does for whoever asks ----------------------------------
    /**
     * POST /close. The route section 11.3(c) found missing everywhere: `POST /window` created windows
     * and nothing in the system destroyed one, so the plugin's private sweep was the only path to a
     * closed window - and for a window that was not agent-born that sweep never ran, which is why six
     * of them were found open with nothing in any of them.
     *
     * It answers BEFORE it goes. The port is about to stop existing, and a caller handed a dropped
     * socket cannot tell "it closed" from "it was never there".
     */
    function closeSelf(force) {
        if (isDock) {
            return { ok: false, error: 'this is the MCP Dock, and it does not close itself',
                hint: 'the dock is what keeps every other window from being the last one; close it by hand when you are done' };
        }
        const dirty = projects().filter((p) => !p.saved);
        if (dirty.length && !force) {
            return { ok: false, error: 'unsaved work here: ' + dirty.map((p) => p.name).join(', '),
                hint: 'project op:save, or POST /close {"force":true} to discard it' };
        }
        setTimeout(() => { try { closeThisWindow(); } catch (e) { /* going anyway */ } }, 60);
        return { ok: true, closing: true, window: WINDOW_ID, port: boundPort, discarded: dirty.map((p) => p.name) };
    }
    /**
     * POST /focus. A renderer cannot verify that its own BrowserWindow was raised - there is no
     * `electron` to ask (section 11.4) - so this reports what it DID and not what happened, and
     * `visibility` is the only nearby evidence there is. It reads `hidden` for a window that is
     * merely covered, so it is a hint and never a verdict.
     */
    function focusSelf() {
        let asked = false;
        try { if (typeof window !== 'undefined' && window.focus) { window.focus(); asked = true; } } catch (e) { asked = false; }
        return { ok: true, asked: asked, window: WINDOW_ID, port: boundPort,
            visibility: typeof document !== 'undefined' ? document.visibilityState : null };
    }
    /**
     * POST /role. The cure for section 11.3(a): a window's standing stops being a boolean decided
     * once at boot out of a 120-second localStorage handoff and becomes something the dock states and
     * can restate. Adopting a window a person will never use again is what recycles the row of empty
     * ones that had no death condition at all.
     */
    function setRole(body) {
        const want = body && body.role;
        if (want !== 'agent' && want !== 'person') {
            return { ok: false, error: 'role must be "agent" or "person"', hint: 'a window becomes the dock by being opened as one, not by being told' };
        }
        if (isDock) return Object.assign({ ok: false, error: 'the MCP Dock has no other role' }, windowBlock());
        agentBorn = want === 'agent';
        freeSince = null;
        if (agentBorn) {
            if (body.claim_for) preClaim(body.claim_for);
            startSweep();
        } else {
            claimedBy = null;
            stopSweep();
        }
        armEmptyCheck();
        refreshIdentity();
        return Object.assign({ ok: true }, windowBlock());
    }

    // --- being the dock -----------------------------------------------------------------------
    /** port -> what the dock knows about that window, from the scan AND from its beats. */
    const roster = {};
    /** Windows asked for and not yet registered: {session, at, resolve}. */
    const births = [];
    let dockScanTimer = null;

    function rosterRow(port) {
        return roster[port] || (roster[port] = { port: port, window: null, role: 'person', beat_at: 0, serving: false, seen_at: 0, claimed_by: null, open: [], dirty: 0, last_call: null });
    }
    /**
     * What a row IS, which is the answer to "which of these is broken?" and the reason the dock keeps
     * two pictures instead of one (section 11.8). The scan says what is SERVING; the beats say what
     * is ALIVE; every interesting state is a disagreement between them.
     */
    function rowState(r) {
        const quiet = now() - r.beat_at;
        if (!r.serving) return now() - Math.max(r.beat_at, r.seen_at) <= 3 * beatStaleMs() ? 'ghost' : 'gone';
        if (!r.beat_at || quiet > beatStaleMs()) return 'silent';
        if (r.role === 'agent' && !r.claimed_by && !(r.open || []).length) return 'orphan';
        return 'live';
    }
    function rosterRows() {
        return Object.keys(roster).map(Number).sort((a, b) => a - b).map((p) => {
            const r = roster[p];
            return {
                port: p, window: r.window, role: r.role, state: rowState(r),
                held_by: r.claimed_by || null,
                open: r.open || [], dirty: r.dirty || 0,
                last_call: r.last_call || null,
                beat_s_ago: r.beat_at ? Math.round((now() - r.beat_at) / 1000) : null,
                serving: !!r.serving,
            };
        });
    }
    function dockRoster() {
        return { ok: true, dock: { window: WINDOW_ID, port: boundPort }, base_port: settings.port, span: PORT_SPAN,
            pending_windows: births.length, windows: rosterRows() };
    }
    /**
     * POST /dock/hello. A window that has just won a port asking what it is.
     *
     * A window the dock ASKED for takes the oldest outstanding birth. That is still a race with a
     * person opening a window in the same two seconds, exactly as 0.7.0's localStorage handoff was -
     * but the window is now two seconds wide rather than a hundred and twenty, because the dock
     * triggered the creation itself and is holding the caller open until this arrives.
     */
    function dockHello(body) {
        const port = isNumLike(body && body.port) ? body.port : null;
        if (port === null) return { ok: false, error: 'POST /dock/hello needs {window, port}' };
        const row = rosterRow(port);
        row.window = (body && body.window) || null;
        row.seen_at = now();
        row.beat_at = now();
        row.serving = true;
        let claimFor = null;
        const b = births.length ? births.shift() : null;
        if (b) {
            row.role = 'agent';
            claimFor = b.session || null;
            if (b.resolve) b.resolve(port);
        } else if (body && body.role === 'agent') {
            // A window that was already an agent window before this dock existed keeps its standing:
            // the dock is learning the world, not resetting it.
            row.role = 'agent';
        } else {
            row.role = 'person';
        }
        paintDock();
        return { ok: true, role: row.role, claim_for: claimFor, dock: { window: WINDOW_ID, port: boundPort } };
    }
    /** POST /dock/beat. The answer carries the role, so a re-labelling reaches a window on its next beat. */
    function dockBeat(body) {
        const port = isNumLike(body && body.port) ? body.port : null;
        if (port === null) return { ok: false, error: 'POST /dock/beat needs {port}' };
        const row = rosterRow(port);
        row.window = body.window || row.window;
        row.beat_at = now();
        row.seen_at = now();
        row.serving = true;
        row.claimed_by = body.claimed_by || null;
        row.open = Array.isArray(body.open) ? body.open : [];
        row.dirty = body.dirty || 0;
        row.last_call = body.last_call || null;
        // The dock's word on the role wins, EXCEPT that it believes a window claiming to be agent-born
        // when it has no opinion of its own - the roster is rebuilt from nothing when a dock opens.
        if (!row.role || (row.role === 'person' && body.role === 'agent' && !row.assigned)) row.role = body.role || 'person';
        paintDock();
        return { ok: true, role: row.role };
    }
    /** The Blockbench action that makes a window, or null where there is none (the web build). */
    function newWindowAction() {
        const item = (typeof BarItems !== 'undefined' && BarItems && BarItems.new_window) || null;
        if (!item || (typeof item.click !== 'function' && typeof item.trigger !== 'function')) return null;
        return item;
    }
    function triggerNewWindow(item) {
        if (typeof item.click === 'function') item.click();
        else item.trigger();
    }
    /**
     * POST /dock/window. The front door: a session asking for somewhere to work.
     *
     * Reuse before creation, and the reuse is what 0.7.0 could not do - an empty agent window whose
     * session had gone was unreachable and uncountable, so the next session opened another one.
     *
     * The creation path answers with the PORT, which is the race section 11.9 deletes: 0.7.0's asker
     * could not know which port its window would win, so it had to go and scan for it and another
     * session's scan could arrive first. The dock triggers the window AND receives its `/dock/hello`,
     * so it learns the port directly.
     */
    async function dockAllocate(body) {
        const sid = (body && (typeof body.session === 'string' ? body.session : body.session && body.session.id)) || null;
        if (!sid) return { ok: false, error: 'POST /dock/window needs {session:{id}}' };
        // 1. One this session already holds. A rejoin, not a second window.
        for (const row of Object.values(roster)) {
            if (row.claimed_by && row.claimed_by.session === sid && rowState(row) !== 'gone') {
                return { ok: true, port: row.port, window: row.window, reused: true, rejoined: true };
            }
        }
        // 2. A free agent window standing empty.
        for (const row of Object.values(roster)) {
            if (row.role !== 'agent' || rowState(row) !== 'orphan') continue;
            try {
                const r = await reach(row.port, '/role', { role: 'agent', claim_for: sid });
                if (r.status === 200 && r.body && r.body.ok) {
                    row.claimed_by = { session: sid, client: null, connected: false, seen_s_ago: 0 };
                    paintDock();
                    return { ok: true, port: row.port, window: row.window, reused: true };
                }
            } catch (e) { /* it went away between the scan and now; try the next */ }
        }
        // 3. Make one.
        const item = newWindowAction();
        if (!item) {
            return { ok: false, error: 'this Blockbench has no new_window action (not the desktop app?)',
                hint: 'open a window by hand and it will register with the dock' };
        }
        const port = await new Promise((resolve) => {
            const b = { session: sid, at: now(), resolve: null };
            b.resolve = (p) => { const i = births.indexOf(b); if (i >= 0) births.splice(i, 1); resolve(p); };
            births.push(b);
            try { triggerNewWindow(item); } catch (e) { b.resolve(null); return; }
            setTimeout(() => b.resolve(null), birthMs());
        });
        if (port === null) {
            return { ok: false, error: 'a window was opened but never registered with the dock within ' + Math.round(birthMs() / 1000) + 's',
                hint: settings.autostart ? 'check Tools > MCP Toolkit Bridge > Start in the new window' : 'this Blockbench has "Start when Blockbench opens" off, so the new window serves nothing until somebody starts it',
                autostart: !!settings.autostart };
        }
        const row = rosterRow(port);
        row.claimed_by = { session: sid, client: null, connected: false, seen_s_ago: 0 };
        paintDock();
        return { ok: true, port: port, window: row.window, made: true };
    }
    /**
     * POST /dock/close. One arbiter, which is what section 11.3(d) needed: three windows each asking
     * "is anyone else there?" and all three acting on the answer in the same second could close them
     * all and quit the app. The dock never closes itself, so every other window is safe to close by
     * definition and there is nothing left to count.
     */
    async function dockClose(body) {
        const port = isNumLike(body && body.port) ? body.port : null;
        if (port === null) return { ok: false, error: 'POST /dock/close needs {port}' };
        if (port === boundPort) {
            return { ok: false, error: 'that is the dock itself, and it does not close',
                hint: 'the dock is what keeps every other window from being the last one' };
        }
        const row = roster[port];
        if (row && !row.serving) {
            return { ok: false, error: 'port ' + port + ' is not answering: its bridge is stopped, or the window is already gone',
                hint: 'a window that does not serve cannot be closed from here (a plugin cannot reach another window) - close it by hand',
                state: rowState(row) };
        }
        let r;
        try { r = await reach(port, '/close', { force: !!(body && body.force) }); } catch (e) {
            return { ok: false, error: 'port ' + port + ' did not answer: ' + String(e && e.message || e) };
        }
        // A window running a plugin from before 0.8.0 has no `/close` at all, and 404 is how it says
        // so. Naming that is the difference between a person closing one window by hand and
        // wondering why the dock is broken (live, 2026-09-10, against six 0.7.0 windows).
        if (r.status === 404) {
            return { ok: false, error: 'port ' + port + ' has no close route: its plugin is older than 0.8.0',
                hint: 'reload the bridge plugin in that window, or close it by hand; a restart of Blockbench brings every window up on the new one' };
        }
        if (r.status !== 200 || !r.body) return { ok: false, error: 'port ' + port + ' answered HTTP ' + r.status };
        if (r.body.ok) { delete roster[port]; paintDock(); }
        return r.body;
    }
    /**
     * The dock's own scan. It is the half of the picture the beats cannot give: a window that has
     * stopped beating is either wedged or gone, and only asking its port tells the two apart.
     */
    async function dockScan() {
        if (!isDock || !server) return;
        const base = isNumLike(settings.port) ? settings.port : DEFAULT_PORT;
        const span = base === 0 ? 1 : PORT_SPAN;
        const seen = {};
        const ports = [];
        for (let p = base; p < base + span; p++) if (p !== boundPort) ports.push(p);
        await Promise.all(ports.map(async (p) => {
            try {
                const r = await reach(p, '/hello');
                if (r.status === 200 && r.body && r.body.app === 'blockbench') seen[p] = r.body;
            } catch (e) { /* nothing there */ }
        }));
        // A dock below us means we are the spare one: stand down before touching the roster, so the
        // range converges on a single dock rather than keeping two half-pictures.
        const lower = Object.keys(seen).map(Number).filter((p) => seen[p].role === 'dock' && p < boundPort).sort((a, b) => a - b);
        if (lower.length) { resignDock(lower[0]); return; }
        for (const p of Object.keys(seen).map(Number)) {
            const h = seen[p];
            const row = rosterRow(p);
            row.window = h.window || row.window;
            row.serving = true;
            row.seen_at = now();
            row.claimed_by = h.claimed_by || null;
            if (Array.isArray(h.open)) row.open = h.open;
            if (isNum(h.dirty)) row.dirty = h.dirty;
            if (h.last_call !== undefined) row.last_call = h.last_call;
            // A window from before 0.8.0 never beats. Believe its own `role`/`agent` so it still shows
            // up truthfully as SILENT rather than as a mystery.
            if (!row.beat_at) row.role = h.role || (h.agent ? 'agent' : 'person');
        }
        for (const p of Object.keys(roster).map(Number)) {
            if (!(p in seen)) roster[p].serving = false;
            const r = roster[p];
            if (!r.serving && now() - Math.max(r.beat_at, r.seen_at) > 3 * beatStaleMs()) delete roster[p];
        }
        paintDock();
    }
    function startDockScan() {
        if (dockScanTimer || !isDock) return;
        dockScanTimer = setInterval(() => { Promise.resolve(dockScan()).catch(() => { /* next tick */ }); }, dockScanMs());
        if (dockScanTimer.unref) dockScanTimer.unref();
        Promise.resolve(dockScan()).catch(() => { /* the timer will try again */ });
    }
    function stopDockScan() { if (dockScanTimer) { clearInterval(dockScanTimer); dockScanTimer = null; } }
    /**
     * TWO DOCKS IS A STATE, NOT AN ERROR, and it resolves without negotiation. Seen live 2026-09-10:
     * two windows both answering `role: "dock"`, each having written its own port into the shared
     * settings that every other window reads - so a window was told a different address depending on
     * which dock happened to answer it, and the roster split in two.
     *
     * THE LOWEST PORT WINS. It is the one fact both windows can see, neither can argue with, and
     * nothing has to be exchanged to agree on - the same reason the port is a window's name in the
     * first place. The higher one stands down into an ordinary window and registers with the winner,
     * so the range converges on one dock within a scan whatever order they were made in.
     */
    function resignDock(toPort) {
        if (!isDock) return false;
        isDock = false;
        stopDockScan();
        removeDockPanel();
        for (const k of Object.keys(roster)) delete roster[k];
        // Anybody waiting on a window from THIS dock is answered rather than left hanging; their
        // caller falls back, and the surviving dock is who they should have asked.
        for (const b of births.splice(0, births.length)) { if (b.resolve) b.resolve(null); }
        if (settings.dock_port === boundPort) saveSettings({ dock_port: toPort });
        dockPort = null;
        startBeat();
        Promise.resolve(findDock()).catch(() => { /* the beat retries */ });
        refreshIdentity();
        return true;
    }
    /** The port a dock answers on, or null. One scan of the range, used before making another dock. */
    async function whereIsDock() {
        const base = isNumLike(settings.port) ? settings.port : DEFAULT_PORT;
        const span = base === 0 ? 1 : PORT_SPAN;
        for (let p = base; p < base + span; p++) {
            if (p === boundPort) continue;
            try {
                const r = await reach(p, '/hello');
                if (r.status === 200 && r.body && r.body.app === 'blockbench' && r.body.role === 'dock') return p;
            } catch (e) { /* nothing there */ }
        }
        return null;
    }
    /**
     * Become the dock. Deliberately not reachable over HTTP: a dock is opened by a person from the
     * menu, or born from a `dock` handoff the menu left. Nothing an agent says makes one, because a
     * dock that could be conjured remotely is a window a person did not ask for.
     */
    function becomeDock() {
        isDock = true;
        agentBorn = false;
        claimedBy = null;
        allowAgents = false;
        freeSince = null;
        stopSweep();
        stopBeat();
        dockPort = null;
        if (boundPort) saveSettings({ dock_port: boundPort });
        makeDockPanel();
        startDockScan();
        refreshIdentity();
        return windowBlock();
    }
    /** Open a window and tell it to be the dock. Called from the menu, in any window. */
    async function openDock() {
        if (isDock) return { ok: false, error: 'this window is already the MCP Dock' };
        // There is ONE dock by design: two would hand every window a different address for the roster
        // (live, 2026-09-10). `dockScan` would resolve it within a scan anyway, but refusing here is
        // the answer a person asked a question deserves.
        const there = await whereIsDock();
        if (there !== null) {
            return { ok: false, error: 'the MCP Dock is already open, on port ' + there, dock_port: there,
                hint: 'there is one dock by design - it is the window that lists all the others' };
        }
        const item = newWindowAction();
        if (!item) return { ok: false, error: 'this Blockbench has no new_window action (not the desktop app?)' };
        pushPending(null, 'dock');
        try { triggerNewWindow(item); } catch (e) { dropPendingKind('dock'); return { ok: false, error: String(e && e.message || e) }; }
        return { ok: true, opening: true };
    }

    // --- the dock's panel ---------------------------------------------------------------------
    /**
     * The list a person reads. Plain DOM appended to `Panel.node` for the same reason the status
     * panel is (below): the node is a real element the constructor has already made, and every value
     * that came off the wire goes in as `textContent` because window ids, session ids, client names
     * and project names are all strings somebody else chose.
     */
    let dockPanel = null;
    let dockBody = null;
    function makeDockPanel() {
        if (dockPanel || typeof Panel !== 'function' || typeof document === 'undefined' || !document.createElement) return;
        try {
            dockPanel = new Panel(PLUGIN_ID + '_dock', {
                name: 'MCP Dock', icon: 'dock', growable: true, resizable: true,
                default_position: { slot: 'left_bar', float_position: [0, 0], float_size: [420, 460], height: 420, sidebar_index: 0 },
            });
            dockBody = document.createElement('div');
            dockBody.style.cssText = 'padding:6px 8px;font-size:11px;line-height:1.5;overflow:auto';
            dockPanel.node.append(dockBody);
        } catch (e) { dockPanel = null; dockBody = null; return; }
        paintDock();
    }
    function removeDockPanel() {
        if (dockPanel) { try { dockPanel.delete(); } catch (e) { /* gone */ } }
        dockPanel = null;
        dockBody = null;
    }
    /** What each state means, in the words a person would use about the window in front of them. */
    const STATE_NOTE = {
        live: 'working',
        orphan: 'empty and unclaimed - safe to close',
        silent: 'answering but not reporting - wedged, or an older plugin',
        ghost: 'stopped answering - close it by hand',
        gone: 'gone',
    };
    function paintDock() {
        if (!dockBody) return;
        const rows = rosterRows();
        dockBody.textContent = '';
        const el = (tag, text, css) => { const d = document.createElement(tag); if (text !== undefined) d.textContent = text; if (css) d.style.cssText = css; return d; };
        dockBody.append(el('div', 'MCP Dock on port ' + (boundPort || '-') + '   ' + rows.length + ' window' + (rows.length === 1 ? '' : 's')
            + (births.length ? '   ' + births.length + ' asked for' : ''), 'font-weight:600;margin-bottom:4px'));
        if (!rows.length) {
            dockBody.append(el('div', 'no other window is serving. Agent sessions will be given one when they ask.', 'opacity:0.6'));
            return;
        }
        for (const r of rows) {
            const box = el('div', undefined, 'border-top:1px solid var(--color-border);padding:4px 0');
            const head = el('div', undefined, 'display:flex;gap:6px;align-items:baseline');
            head.append(el('span', String(r.port), 'font-weight:600;min-width:44px'));
            head.append(el('span', r.role, 'opacity:0.8'));
            head.append(el('span', r.state, r.state === 'live' ? 'opacity:0.6' : 'color:var(--color-accent)'));
            head.append(el('span', r.window || '', 'opacity:0.45;margin-left:auto'));
            box.append(head);
            box.append(el('div', STATE_NOTE[r.state] || r.state, 'opacity:0.6'));
            box.append(el('div', 'held by ' + (r.held_by ? r.held_by.session + (r.held_by.client ? ' (' + r.held_by.client + ')' : '') + (r.held_by.connected ? ', connected' : ', seen ' + r.held_by.seen_s_ago + 's ago') : '-')));
            box.append(el('div', 'open: ' + (r.open.length ? r.open.map((p) => p.name + (p.saved ? '' : ' *')).join(', ') : 'nothing')
                + (r.dirty ? '   ' + r.dirty + ' unsaved' : '')));
            box.append(el('div', r.last_call
                ? 'last call ' + r.last_call.name + ' ' + r.last_call.s_ago + 's ago' + (r.last_call.session ? ' by ' + r.last_call.session : '')
                : 'no calls', 'opacity:0.6'));
            const bar = el('div', undefined, 'display:flex;gap:4px;margin-top:3px;flex-wrap:wrap');
            const button = (label, fn) => {
                const b = document.createElement('button');
                b.textContent = label;
                b.style.cssText = 'font-size:10px;padding:1px 6px';
                b.addEventListener('click', () => { Promise.resolve(fn()).catch((e) => Blockbench.showQuickMessage(String(e && e.message || e), 3000)); });
                bar.append(b);
            };
            if (r.serving) {
                button('Focus', () => reach(r.port, '/focus', {}));
                button(r.role === 'agent' ? 'Release' : 'Adopt', async () => {
                    const res = await reach(r.port, '/role', { role: r.role === 'agent' ? 'person' : 'agent' });
                    if (res.body && res.body.ok) { rosterRow(r.port).role = r.role === 'agent' ? 'person' : 'agent'; paintDock(); }
                    else Blockbench.showQuickMessage((res.body && res.body.error) || 'refused', 3000);
                });
                button(r.dirty ? 'Close (discard)' : 'Close', async () => {
                    const res = await dockClose({ port: r.port, force: !!r.dirty });
                    if (!res.ok) Blockbench.showQuickMessage(res.error, 4000);
                });
            }
            box.append(bar);
            dockBody.append(box);
        }
        const closeable = rows.filter((r) => r.state === 'orphan');
        if (closeable.length > 1) {
            const b = document.createElement('button');
            b.textContent = 'Close all ' + closeable.length + ' empty agent windows';
            b.style.cssText = 'margin-top:6px;font-size:10px;padding:2px 8px';
            b.addEventListener('click', async () => { for (const r of closeable) await dockClose({ port: r.port }); });
            dockBody.append(b);
        }
    }
    // ------------------------------------------------------------------ the end of a window
    /**
     * An agent-born window closes itself once nothing needs it: no live claim, no open tabs, and a
     * grace period in which a shim whose presence dropped can come back and rejoin. Before this,
     * nothing anywhere closed a window - `POST /window` had no counterpart - so an afternoon of
     * sessions left a row of empty windows at ~220 MB each for a person to close by hand.
     *
     * WHY THE CLAIM AND NOT THE TAB. `project op:close` emptying a window arms this, but it does not
     * decide it: a session that closes one piece and opens the next has not finished. The claim is
     * the lease, and requiring zero projects on top of it is what keeps this compatible with design
     * section 6.2 - a dropped socket is not consent to destroy work, and a window with nothing open
     * has no work to destroy.
     */
    let freeSince = null;
    let sweepTimer = null;
    let closing = false;
    function armEmptyCheck() {
        if (!agentBorn) return;
        if (claimHolder() || projects().length) { freeSince = null; return; }
        if (freeSince === null) freeSince = now();
        startSweep();
    }
    function startSweep() {
        if (sweepTimer || !agentBorn) return;
        sweepTimer = setInterval(() => { Promise.resolve(sweep()).catch(() => { /* next tick */ }); }, SWEEP_MS);
        if (sweepTimer.unref) sweepTimer.unref();
    }
    function stopSweep() { if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; } }
    async function sweep() {
        refreshIdentity();
        // A window whose bridge a person STOPPED is not discoverable and not countable; closing it
        // would be acting on a picture we can no longer see.
        if (closing || !agentBorn || !server) return null;
        releaseDeadClaim();
        if (claimHolder() || projects().length) { freeSince = null; return null; }
        if (freeSince === null) { freeSince = now(); return null; }
        if (now() - freeSince < emptyMs()) return null;
        if (!(await otherWindowsAnswer())) return null;
        return closeThisWindow();
    }
    /**
     * NEVER THE LAST WINDOW: closing it would quit Blockbench, and an agent finishing its work is not
     * a request to shut the app. Counting windows from a renderer means asking the range the way a
     * shim does - a window whose bridge is stopped answers nothing and reads here as absent, so the
     * error this can make is always "stay open", which is the harmless direction to be wrong in.
     */
    async function otherWindowsAnswer() {
        if (typeof fetch !== 'function') return false;
        const base = isNumLike(settings.port) ? settings.port : DEFAULT_PORT;
        const span = base === 0 ? 1 : PORT_SPAN;
        for (let p = base; p < base + span; p++) {
            if (p === boundPort) continue;
            try {
                const opts = {};
                if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opts.signal = AbortSignal.timeout(400);
                const res = await fetch('http://127.0.0.1:' + p + '/hello', opts);
                if (!res || !res.ok) continue;
                const h = await res.json();
                if (h && h.app === 'blockbench' && h.window !== WINDOW_ID) return true;
            } catch (e) { /* nothing there */ }
        }
        return false;
    }
    /**
     * Close this window. `closeBlockbenchWindow` is module-scoped after esbuild and cannot be reached
     * from a plugin (design section 8), so this goes around it - and that is the safer half of the
     * bargain rather than a workaround, because the function we cannot call is the one that wipes
     * EVERY window's crash-recovery backups. An automatic close therefore cannot destroy another
     * window's entry even where the guard is absent. `allow_closing` is the flag Blockbench's own
     * `onbeforeunload` reads to skip the unsaved-work dialog; there is nothing unsaved here anyway,
     * because a window with a project open never reaches this point.
     */
    function closeThisWindow() {
        closing = true;
        stopSweep();
        // Give the port back first, so a shim scanning in the same second finds a door that is
        // already shut rather than one that is about to be.
        try { stop(); } catch (e) { /* going anyway */ }
        try { if (typeof Blockbench !== 'undefined' && Blockbench.addFlag) Blockbench.addFlag('allow_closing'); } catch (e) { /* going anyway */ }
        try { window.close(); } catch (e) { closing = false; return false; }
        return true;
    }

    // ------------------------------------------------------------------ who this window belongs to
    /**
     * A row of Blockbench windows all look the same, and until 0.7.0 the only way to ask which
     * session owned one was to read its `/hello` from outside the app. Two surfaces, because they
     * answer two different questions: the TITLE says whose window this is from the taskbar without
     * focusing it, and the PANEL says what that session is doing in it right now.
     */
    const recent = [];
    function noteCall(name, ok, ms, sess) {
        recent.push({ at: now(), name: name, ok: ok, ms: ms, session: (sess && sess.id) || null });
        while (recent.length > RECENT_MAX) recent.shift();
        paintPanel();
    }
    let titleObserver = null;
    let writingTitle = false;
    let lastPrefix = '';
    function titlePrefix() {
        if (!boundPort) return '';
        if (isDock) return '[MCP Dock ' + boundPort + '] ';
        const h = claimHolder();
        // THE PORT IS ALWAYS IN IT (section 11.3). Six windows maximised onto the same pixels under
        // the same title is what "hidden from Windows entirely" turned out to mean, and a person
        // cannot act on a row of them from the taskbar unless each one says which it is.
        if (h) return '[' + boundPort + ' ' + h.id + (h.client ? ' ' + h.client : '') + '] ';
        if (agentBorn) return '[' + boundPort + ' agent] ';
        if (allowAgents) return '[' + boundPort + ' open to agents] ';
        return '[' + boundPort + '] ';
    }
    /**
     * The prefix is put back on whatever Blockbench last wrote, and the previous one is stripped by
     * REMEMBERING it rather than by matching a shape - a project legitimately called "[wip] dragon"
     * must not lose its own brackets.
     */
    function applyTitle() {
        if (typeof document === 'undefined' || typeof document.title !== 'string') return;
        const want = titlePrefix();
        let bare = document.title;
        if (lastPrefix && bare.slice(0, lastPrefix.length) === lastPrefix) bare = bare.slice(lastPrefix.length);
        const next = want + bare;
        lastPrefix = want;
        if (next === document.title) return;
        writingTitle = true;
        try { document.title = next; } finally { writingTitle = false; }
    }
    /**
     * Blockbench rewrites the title from `setProjectTitle`, which esbuild made module-scoped and so
     * unpatchable - the same fact as `closeBlockbenchWindow` above. Watching the NODE needs no access
     * to whoever writes it, which is why this is an observer and not a hook.
     */
    function watchTitle() {
        if (titleObserver || typeof document === 'undefined' || typeof MutationObserver !== 'function') return;
        const node = document.querySelector && document.querySelector('title');
        if (!node) return;
        titleObserver = new MutationObserver(() => { if (!writingTitle) applyTitle(); });
        titleObserver.observe(node, { childList: true, characterData: true, subtree: true });
        applyTitle();
    }
    function unwatchTitle() {
        if (titleObserver) { try { titleObserver.disconnect(); } catch (e) { /* gone */ } titleObserver = null; }
        if (lastPrefix && typeof document !== 'undefined' && typeof document.title === 'string'
            && document.title.slice(0, lastPrefix.length) === lastPrefix) {
            writingTitle = true;
            try { document.title = document.title.slice(lastPrefix.length); } finally { writingTitle = false; }
        }
        lastPrefix = '';
    }
    let panel = null;
    let panelBody = null;
    /**
     * The panel is built as plain DOM appended to `Panel.node` rather than as a Vue component: the
     * node is a real element the constructor has already made, and a plugin that cannot be tested
     * headlessly should reach for the smallest surface it can. Every line is `textContent`, because
     * session ids, client names and project names are all strings somebody else chose.
     */
    function makePanel() {
        if (panel || typeof Panel !== 'function' || typeof document === 'undefined' || !document.createElement) return;
        try {
            panel = new Panel(PLUGIN_ID, {
                name: 'MCP Toolkit Bridge', icon: 'hub', growable: true, resizable: true,
                default_position: { slot: 'left_bar', float_position: [0, 0], float_size: [300, 260], height: 220, sidebar_index: 20 },
            });
            panelBody = document.createElement('div');
            panelBody.style.cssText = 'padding:6px 8px;font-size:11px;line-height:1.5;overflow:auto';
            panel.node.append(panelBody);
        } catch (e) { panel = null; panelBody = null; return; }
        paintPanel();
    }
    function removePanel() {
        if (panel) { try { panel.delete(); } catch (e) { /* gone */ } }
        panel = null;
        panelBody = null;
    }
    function paintPanel() {
        if (!panelBody) return;
        const h = claimHolder();
        const bound = h ? projects().find((p) => p.uuid === h.project) : null;
        const lines = [
            agentBorn ? 'agent window' : allowAgents ? 'your window, handed to agents' : 'your window',
            h ? 'held by ' + h.id + (h.client ? ' (' + h.client + ')' : '') + ', ' + liveness(h) : 'unclaimed',
            boundPort ? 'port ' + boundPort + '  ' + WINDOW_ID : 'not listening',
            'project ' + (bound ? bound.name : '-') + '   tabs ' + projects().length,
        ];
        if (agentBorn && freeSince !== null && !claimHolder()) {
            lines.push('empty ' + Math.round((now() - freeSince) / 1000) + 's of ' + Math.round(emptyMs() / 1000) + 's before this window closes');
        }
        panelBody.textContent = '';
        const line = (text, dim) => {
            const d = document.createElement('div');
            d.textContent = text;
            if (dim) d.style.opacity = '0.6';
            panelBody.append(d);
        };
        for (const l of lines) line(l);
        line(recent.length ? 'recent calls' : 'no calls yet', true);
        for (let i = recent.length - 1; i >= 0; i--) {
            const r = recent[i];
            line((r.ok ? '' : '! ') + r.name + '  ' + r.ms + 'ms', !r.ok);
        }
    }
    function refreshIdentity() { applyTitle(); paintPanel(); }

    // ------------------------------------------------------------------ element helpers
    function allElements() { return (typeof Outliner !== 'undefined' && Outliner.elements) || []; }
    function allGroups() { return (typeof Group !== 'undefined' && Group.all) || []; }
    function allCubes() { return (typeof Cube !== 'undefined' && Cube.all) || []; }
    function allTextures() { return (typeof Texture !== 'undefined' && Texture.all) || []; }
    function nodeType(n) {
        if (typeof Group !== 'undefined' && n instanceof Group) return 'group';
        if (typeof Cube !== 'undefined' && n instanceof Cube) return 'cube';
        return n.type || 'element';
    }
    function findNode(ref, kinds, fix) {
        const pool = [].concat(kinds.indexOf('group') >= 0 ? allGroups() : [], kinds.indexOf('cube') >= 0 ? allElements() : []);
        let hit = pool.find((n) => n.uuid === ref);
        if (!hit) {
            const byName = pool.filter((n) => n.name === ref);
            if (byName.length > 1) fail('"' + ref + '" names ' + byName.length + ' elements; use a uuid (list_outline shows them when names collide)');
            hit = byName[0];
        }
        if (!hit) fail('no ' + kinds.join('/') + ' named "' + ref + '"', fix || 'list_outline shows what exists');
        return hit;
    }
    const findCube = (ref) => findNode(ref, ['cube']);
    const findGroup = (ref) => findNode(ref, ['group'], 'add_group makes one; list_outline shows what exists');
    const findAny = (ref) => findNode(ref, ['group', 'cube']);
    function resolveIds(args) {
        const ids = [].concat(args.ids || [], args.id ? [args.id] : []);
        if (!ids.length) fail('give id or ids');
        return ids.map(findAny);
    }
    function parentOf(n) {
        return n.parent && n.parent !== 'root' && typeof n.parent === 'object' ? n.parent : null;
    }
    function groupRef(ref) {
        if (!ref || ref === 'root') return 'root';
        return findGroup(ref);
    }
    function findTexture(ref) {
        const all = allTextures();
        if (!all.length) fail('no textures in this project', 'create_texture makes one');
        if (!ref) return (typeof Texture !== 'undefined' && Texture.selected) || all[0];
        const bare = String(ref).replace(/\.png$/, '');
        const t = all.find((x) => x.uuid === ref) || all.find((x) => x.name === ref || x.name.replace(/\.png$/, '') === bare);
        if (!t) fail('no texture "' + ref + '" (have: ' + all.map((x) => x.name).join(', ') + ')');
        return t;
    }
    function textureFor(cube) {
        const f = cube.faces && cube.faces[FACES.find((k) => cube.faces[k] && cube.faces[k].texture)];
        const uuid = f && f.texture;
        return uuid ? allTextures().find((t) => t.uuid === uuid) : null;
    }
    /**
     * The UV space a face's numbers live in. A format with `per_texture_uv_size` (ArmorPieces'
     * is one; found live 2026-09-07 on a 64x64 skin beside a 64x32 project) keeps it on the
     * TEXTURE (`getUVWidth()` / `uv_width`); otherwise it is the project's. Scaling every sheet by
     * the project's size doubled every v on that skin and reported 42 faces "outside" the sheet.
     */
    function uvSize(tex) {
        const p = activeProject();
        let w = null, h = null;
        if (tex) {
            if (typeof tex.getUVWidth === 'function') { w = tex.getUVWidth(); h = tex.getUVHeight(); }
            else if (tex.uv_width && tex.uv_height) { w = tex.uv_width; h = tex.uv_height; }
        }
        if (!w || !h) { w = (p && p.texture_width) || (tex ? tex.width : 16); h = (p && p.texture_height) || (tex ? tex.height : 16); }
        return [w, h];
    }
    /** A face's rectangle in TEXTURE pixels (UV units scaled to the sheet). */
    function faceRect(cube, face, tex) {
        if (FACES.indexOf(face) < 0) fail('face must be one of ' + FACES.join('/') + ', not "' + face + '"');
        const f = cube.faces && cube.faces[face];
        if (!f || !f.uv) fail('cube "' + cube.name + '" has no ' + face + ' face');
        const uv = uvSize(tex);
        const uw = uv[0], uh = uv[1];
        const sx = (tex ? tex.width : uw) / uw;
        const sy = (tex ? tex.height : uh) / uh;
        const x0 = Math.min(f.uv[0], f.uv[2]) * sx, x1 = Math.max(f.uv[0], f.uv[2]) * sx;
        const y0 = Math.min(f.uv[1], f.uv[3]) * sy, y1 = Math.max(f.uv[1], f.uv[3]) * sy;
        return [Math.round(x0), Math.round(y0), Math.max(0, Math.round(x1) - Math.round(x0)), Math.max(0, Math.round(y1) - Math.round(y0))];
    }
    function faceRects(cube) {
        const tex = textureFor(cube);
        const out = {};
        for (const face of FACES) {
            const f = cube.faces && cube.faces[face];
            if (!f || !f.uv || f.texture === null) continue;
            out[face] = faceRect(cube, face, tex);
        }
        return out;
    }
    function isRotated(cube) {
        if (cube.rotation && cube.rotation.some((r) => r)) return true;
        let g = parentOf(cube);
        while (g) { if (g.rotation && g.rotation.some((r) => r)) return true; g = parentOf(g); }
        return false;
    }
    function box(cube) {
        const inf = cube.inflate || 0;
        return {
            from: [cube.from[0] - inf, cube.from[1] - inf, cube.from[2] - inf],
            to: [cube.to[0] + inf, cube.to[1] + inf, cube.to[2] + inf],
        };
    }
    function cubeReadback(cube, withEnvelope) {
        const r = {
            name: cube.name, uuid: cube.uuid,
            group: parentOf(cube) ? parentOf(cube).name : 'root',
            from: rv(cube.from), to: rv(cube.to), size: rv([0, 1, 2].map((i) => cube.to[i] - cube.from[i])),
            origin: rv(cube.origin), rotation: rv(cube.rotation),
        };
        if (cube.inflate) r.inflate = cube.inflate;
        if (cube.mirror_uv) r.mirror_uv = true;
        if (cube.visibility === false) r.visibility = false;
        if (cube.box_uv) r.uv_offset = rv(cube.uv_offset);
        try { r.faces = faceRects(cube); } catch (e) { r.faces_error = e.message; }
        if (withEnvelope) r.envelope = envelopeOf(cube);
        return r;
    }
    /** Neighbours on the same bone and the gap per axis: positive is air, negative is overlap. */
    function envelopeOf(cube) {
        const parent = parentOf(cube);
        const sibs = allCubes().filter((c) => c !== cube && parentOf(c) === parent);
        const a = box(cube);
        return sibs.map((s) => {
            const b = box(s);
            const gaps = [0, 1, 2].map((i) => round(Math.max(a.from[i] - b.to[i], b.from[i] - a.to[i])));
            const worst = Math.max.apply(null, gaps);
            const rel = worst > 0 ? 'clear' : worst === 0 ? 'touching' : 'overlap';
            const e = { name: s.name, from: rv(s.from), to: rv(s.to), gap: gaps, relation: rel };
            if (isRotated(s) || isRotated(cube)) e.rotated = true;
            return e;
        });
    }
    function boundsOf(cubes) {
        if (!cubes.length) return null;
        const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        let rotated = 0;
        for (const c of cubes) {
            const b = box(c);
            for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], b.from[i]); hi[i] = Math.max(hi[i], b.to[i]); }
            if (isRotated(c)) rotated++;
        }
        const size = [0, 1, 2].map((i) => hi[i] - lo[i]);
        const out = { from: rv(lo), to: rv(hi), size: rv(size), size_blocks: rv(size.map((n) => n / 16)), cubes: cubes.length };
        if (rotated) out.note = rotated + ' rotated cube(s) measured by their unrotated box';
        return out;
    }
    function opaqueCount(tex) {
        try {
            const c = tex.canvas;
            if (!c || c.width * c.height > 1048576) return null;
            const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
            let n = 0;
            for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
            return n;
        } catch (e) { return null; }
    }
    function updateCanvas() {
        if (typeof Canvas !== 'undefined' && Canvas.updateAll) Canvas.updateAll();
    }
    /**
     * One undo entry around fn. Blockbench snapshots the aspect ARRAYS at finishEdit, so a thing fn
     * CREATES must be pushed into them (fn receives `aspects`) or the entry does not know it exists:
     * undoing a place_cube whose cubes were never listed detached them to root instead of removing
     * them (live, 2026-09-07).
     */
    function undoEdit(aspects, name, fn) {
        if (typeof Undo !== 'undefined' && Undo.initEdit) Undo.initEdit(aspects);
        const out = fn(aspects);
        if (typeof Undo !== 'undefined' && Undo.finishEdit) Undo.finishEdit(name, aspects);
        return out;
    }
    function undoState() {
        if (typeof Undo === 'undefined' || !Undo.history) return null;
        const h = Undo.history;
        const last = h[Undo.index - 1];
        return { index: Undo.index, length: h.length, last: last ? last.action : null };
    }

    // ------------------------------------------------------------------ pictures
    function preview() {
        const p = typeof Preview !== 'undefined' ? Preview.selected : null;
        if (!p) fail('no viewport (is a project open?)');
        return p;
    }
    function renderViewport() {
        const pv = preview();
        let url = null;
        const shoot = () => { pv.render(); url = pv.canvas.toDataURL('image/png'); };
        if (typeof Canvas !== 'undefined' && Canvas.withoutGizmos) Canvas.withoutGizmos(shoot); else shoot();
        if (!url) fail('the viewport rendered nothing');
        return { url, width: pv.canvas.width, height: pv.canvas.height };
    }
    function imageOf(url, frame, extra) {
        return Object.assign({ mimeType: 'image/png', base64: url.split(',')[1], frame: !!frame }, extra || {});
    }
    function cameraState(pv) {
        const out = {
            position: pv.camera.position.toArray(), target: pv.controls.target.toArray(),
            projection: pv.isOrtho ? 'orthographic' : 'perspective', zoom: pv.camera.zoom,
        };
        const off = sceneOffset();
        if (off.some((n) => n !== 0)) out.scene_offset = off;
        return out;
    }
    /**
     * Where the model is DISPLAYED relative to its own coordinates. Blockbench shows a java_block
     * model with the scene moved by (-8, 0, -8) so the block sits on the grid's centre, and an entity
     * rig's cubes sit wherever their bones put them; a camera aimed at a cube's `from` therefore looked
     * at the model's edge, and a north capture showed one cube of two (live, 2026-09-07). position and
     * target are SCENE coordinates, the presets' space; fit frames the meshes' world bounds.
     */
    function sceneOffset() {
        const s = typeof Canvas !== 'undefined' && Canvas.scene && Canvas.scene.position;
        return s && typeof s.toArray === 'function' ? s.toArray() : [0, 0, 0];
    }
    function worldBounds() {
        const model = typeof Project !== 'undefined' && Project && Project.model_3d;
        if (model && typeof THREE !== 'undefined' && THREE.Box3 && typeof model.updateMatrixWorld === 'function') {
            model.updateMatrixWorld(true);
            const box = new THREE.Box3().setFromObject(model);
            if (!box.isEmpty()) {
                const from = box.min.toArray(), to = box.max.toArray();
                return { from, to, size: [0, 1, 2].map((i) => to[i] - from[i]) };
            }
        }
        const b = boundsOf(allCubes());
        if (!b) return null;
        const off = sceneOffset();
        return { from: b.from.map((n, i) => n + off[i]), to: b.to.map((n, i) => n + off[i]), size: b.size };
    }
    function applyCamera(args) {
        const pv = preview();
        let name = null;
        if (args.angle) {
            const presets = typeof DefaultCameraPresets !== 'undefined' ? DefaultCameraPresets : [];
            const preset = presets.find((p) => p.id === args.angle);
            if (!preset) fail('no camera preset "' + args.angle + '" (have: ' + presets.map((p) => p.id).join(', ') + ')');
            pv.loadAnglePreset(preset);
            // Blockbench skips a locked preset's zoom (north/south/east/west/top/bottom); apply it, so a
            // capture without fit is the preset and not whatever zoom the last fit left behind.
            if (pv.isOrtho && preset.zoom && preset.locked_angle) { pv.camera.zoom = preset.zoom; if (pv.camera.updateProjectionMatrix) pv.camera.updateProjectionMatrix(); }
            name = preset.id;
        }
        if (args.position || args.target || args.projection) {
            pv.loadAnglePreset({
                position: args.position || pv.camera.position.toArray(),
                target: args.target || pv.controls.target.toArray(),
                projection: args.projection || 'unset',
            });
        }
        if (args.fit) fitCamera(pv, args.fit_margin);
        return { angle: name, camera: cameraState(pv) };
    }
    /** Point the camera at the model's WORLD bounds from where it already looks, at a distance that frames them. */
    function fitCamera(pv, margin) {
        const b = worldBounds();
        if (!b) return;
        const centre = [0, 1, 2].map((i) => (b.from[i] + b.to[i]) / 2);
        const extent = Math.max(b.size[0], b.size[1], b.size[2]) * (margin || 1.25);
        const pos = pv.camera.position.toArray();
        const tgt = pv.controls.target.toArray();
        let dir = [0, 1, 2].map((i) => pos[i] - tgt[i]);
        const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
        dir = dir.map((n) => n / len);
        pv.controls.target.set(centre[0], centre[1], centre[2]);
        if (pv.isOrtho) {
            const dist = 512;
            pv.camera.position.set(centre[0] + dir[0] * dist, centre[1] + dir[1] * dist, centre[2] + dir[2] * dist);
            // The frustum's half-extents are the camera's own (Blockbench sets them from the canvas size /
            // 80); visible half-width = right / zoom, so the zoom that shows `extent` is the smaller ratio.
            const halfW = Math.abs(pv.camera.right || 0) || (pv.canvas.width / 160);
            const halfH = Math.abs(pv.camera.top || 0) || (pv.canvas.height / 160);
            pv.camera.zoom = Math.max(0.05, Math.min(halfW, halfH) / (extent / 2 + 0.5));
            if (pv.camera.updateProjectionMatrix) pv.camera.updateProjectionMatrix();
        } else {
            const fov = (pv.camera.fov || 45) * Math.PI / 180;
            const dist = (extent / 2) / Math.tan(fov / 2) + extent / 2;
            pv.camera.position.set(centre[0] + dir[0] * dist, centre[1] + dir[1] * dist, centre[2] + dir[2] * dist);
        }
        if (pv.controls.update) pv.controls.update();
    }
    function makeCanvas(w, h) {
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        return c;
    }
    function loadImage(url) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('could not decode the image'));
            img.src = url;
        });
    }
    async function contactSheet(views, tile) {
        const pv = preview();
        const before = cameraState(pv);
        const shots = [];
        try {
            for (const v of views) {
                applyCamera({ angle: v, fit: true });
                const r = renderViewport();
                shots.push({ view: v, url: r.url, w: r.width, h: r.height });
            }
        } finally {
            pv.loadAnglePreset({ position: before.position, target: before.target, projection: before.projection });
            if (before.projection === 'orthographic') { pv.camera.zoom = before.zoom; if (pv.camera.updateProjectionMatrix) pv.camera.updateProjectionMatrix(); }
        }
        const cols = shots.length <= 2 ? shots.length : 2;
        const rows = Math.ceil(shots.length / cols);
        const label = 14;
        const sheet = makeCanvas(cols * tile, rows * (tile + label));
        const ctx = sheet.getContext('2d');
        ctx.fillStyle = '#202020';
        ctx.fillRect(0, 0, sheet.width, sheet.height);
        ctx.imageSmoothingEnabled = true;
        for (let i = 0; i < shots.length; i++) {
            const img = await loadImage(shots[i].url);
            const x = (i % cols) * tile, y = Math.floor(i / cols) * (tile + label);
            const s = Math.min(tile / img.width, tile / img.height);
            const w = Math.round(img.width * s), h = Math.round(img.height * s);
            ctx.drawImage(img, x + Math.floor((tile - w) / 2), y + label + Math.floor((tile - h) / 2), w, h);
            ctx.fillStyle = '#e0e0e0';
            ctx.font = '11px sans-serif';
            ctx.fillText(shots[i].view, x + 3, y + 11);
        }
        return { url: sheet.toDataURL('image/png'), width: sheet.width, height: sheet.height, views: shots.map((s) => s.view), tile };
    }

    // ------------------------------------------------------------------ files
    function readFile(path, readtype) {
        return new Promise((resolve, reject) => {
            if (typeof Blockbench === 'undefined' || typeof Blockbench.read !== 'function') return reject(new Error('Blockbench.read is unavailable'));
            let done = false;
            try {
                Blockbench.read([path], { readtype: readtype || 'text', errorbox: false }, (files) => {
                    done = true;
                    if (!files || !files[0]) return reject(new Error('could not read ' + path));
                    resolve(files[0]);
                });
            } catch (e) { reject(e); }
            setTimeout(() => { if (!done) reject(new Error('reading ' + path + ' did not complete (does the file exist?)')); }, 10000);
        });
    }
    function writeFile(path, content, savetype) {
        return new Promise((resolve, reject) => {
            if (typeof Blockbench === 'undefined' || typeof Blockbench.writeFile !== 'function') return reject(new Error('Blockbench.writeFile is unavailable'));
            let done = false;
            try {
                Blockbench.writeFile(path, { content, savetype }, (p) => { done = true; resolve(p || path); });
            } catch (e) { return reject(e); }
            setTimeout(() => { if (!done) resolve(path); }, 3000);
        });
    }

    // ------------------------------------------------------------------ texture painting
    // The two batch painters, moved here from the shim (mcp-server/local/paint.mjs) unchanged in
    // contract: LOOP_KIT_DESIGN.md section 5.4 is the record and section 11 the falsifier.
    function paintOn(tex, undoName, fn) {
        const report = {};
        undoEdit({ textures: [tex], bitmap: true }, undoName, () => {
            const edit = (canvas) => {
                const ctx = canvas.getContext('2d');
                const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
                fn(img, canvas.width, canvas.height, report);
                ctx.putImageData(img, 0, 0);
            };
            if (typeof tex.edit === 'function') {
                // Blockbench 5.1.6 Painter.edit WITHOUT use_cache: that is the brush-stroke branch,
                // which leaves texture.source stale (get_texture then answers the pre-paint sheet).
                tex.edit((canvas) => edit(canvas), { no_undo: true });
            } else if (tex.canvas) {
                edit(tex.canvas);
                if (typeof tex.updateChangesAfterEdit === 'function') tex.updateChangesAfterEdit();
            } else {
                fail('texture "' + tex.name + '" has no canvas to paint on');
            }
        });
        return report;
    }
    function pixelOps(img, W, H, report) {
        const data = img.data;
        return {
            set(x, y, c) {
                if (x < 0 || y < 0 || x >= W || y >= H) { report.skipped = (report.skipped || 0) + 1; return; }
                const o = (y * W + x) * 4;
                if (c === null) { data[o] = 0; data[o + 1] = 0; data[o + 2] = 0; data[o + 3] = 0; return; }
                data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = c[3];
            },
            get(x, y) {
                if (x < 0 || y < 0 || x >= W || y >= H) return null;
                const o = (y * W + x) * 4;
                return [data[o], data[o + 1], data[o + 2], data[o + 3]];
            },
            opaque(x, y) { return x >= 0 && y >= 0 && x < W && y < H && data[(y * W + x) * 4 + 3] > 0; },
        };
    }
    function paintFaces(tex, args) {
        const report = paintOn(tex, 'paint_faces', (img, W, H, rep) => {
            const px = pixelOps(img, W, H, rep);
            rep.painted = {}; rep.cleared = {}; rep.pixels = 0;
            const faces = args.faces || {};
            for (const key of Object.keys(faces)) {
                const dot = key.lastIndexOf('.');
                if (dot < 0) fail('face key "' + key + '" must be "<cube>.<face>"');
                const cube = findCube(key.slice(0, dot));
                const which = key.slice(dot + 1);
                for (const face of which === '*' ? FACES : [which]) {
                    const r = faceRect(cube, face, tex);
                    const v = faces[key];
                    let top, bottom;
                    // A 2-list is a [top, bottom] pair; a 3- or 4-list is one colour ([r,g,b,a]).
                    if (Array.isArray(v) && v.length === 2) {
                        top = rgba(v[0]); bottom = rgba(v[1]);
                    } else {
                        top = bottom = rgba(v);
                    }
                    let n = 0;
                    for (let y = 0; y < r[3]; y++) {
                        const c = top === null ? null : (r[3] > 1 ? lerp(top, bottom, y / (r[3] - 1)) : top);
                        for (let x = 0; x < r[2]; x++) { px.set(r[0] + x, r[1] + y, c); n++; }
                    }
                    (top === null ? rep.cleared : rep.painted)[cube.name + '.' + face] = { rect: r, px: n };
                }
            }
            const pixels = args.pixels || {};
            for (const k of Object.keys(pixels)) {
                const xy = k.split(',').map(Number);
                if (xy.length !== 2 || xy.some((n) => !isNum(n))) fail('pixel key "' + k + '" must be "x,y"');
                px.set(xy[0], xy[1], rgba(pixels[k]));
                rep.pixels++;
            }
        });
        return Object.assign({ texture: tex.name, size: [tex.width, tex.height] }, report, { undo: 'one entry' });
    }
    function paintAscii(tex, args) {
        const report = paintOn(tex, 'paint_ascii', (img, W, H, rep) => {
            const px = pixelOps(img, W, H, rep);
            const global = args.palette || {};
            rep.stamps = [];
            (args.stamps || []).forEach((s, i) => {
                let region;
                if (s.at) region = [s.at[0], s.at[1], W - s.at[0], H - s.at[1]];
                else if (s.cube && s.face) region = faceRect(findCube(s.cube), s.face, tex);
                else fail('stamp ' + i + ' needs at:[x,y] or cube+face');
                const pal = Object.assign({}, global, s.palette || {});
                const out = { region, painted: 0, cleared: 0, left: 0, skipped_shade_only: 0 };
                if (s.fill !== undefined && s.fill !== null) {
                    const fc = rgba(s.fill);
                    for (let y = 0; y < region[3]; y++) for (let x = 0; x < region[2]; x++) {
                        if (s.shade_only && !px.opaque(region[0] + x, region[1] + y)) { out.skipped_shade_only++; continue; }
                        px.set(region[0] + x, region[1] + y, fc); out.painted++;
                    }
                }
                const rows = s.rows || [];
                const rh = rows.length;
                let rw = 0;
                rows.forEach((r) => { if (r.length > rw) rw = r.length; });
                const dx = (s.shift && s.shift[0]) || 0, dy = (s.shift && s.shift[1]) || 0;
                const spanW = s.tile ? region[2] : Math.min(rw, region[2] - dx);
                const spanH = s.tile ? region[3] : Math.min(rh, region[3] - dy);
                if (rh && rw) {
                    for (let y = 0; y < spanH; y++) for (let x = 0; x < spanW; x++) {
                        const ch = (rows[y % rh] || '')[x % rw];
                        if (ch === undefined || ch === ' ') { out.left++; continue; }
                        const tx = region[0] + dx + x, ty = region[1] + dy + y;
                        if (s.shade_only && !px.opaque(tx, ty)) { out.skipped_shade_only++; continue; }
                        if (ch === '.') { px.set(tx, ty, null); out.cleared++; continue; }
                        if (!(ch in pal)) fail('stamp ' + i + ': character "' + ch + '" is not in the palette');
                        px.set(tx, ty, rgba(pal[ch])); out.painted++;
                    }
                }
                rep.stamps.push(out);
            });
        });
        return Object.assign({ texture: tex.name, size: [tex.width, tex.height] }, report, { undo: 'one entry' });
    }
    const PALETTE_CHARS = '#@%*+=-:;abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    /** A region of a sheet as rows of characters, one per texel, with the legend that made them. */
    function readAscii(tex, region, palette) {
        const ctx = tex.canvas.getContext('2d');
        const [x0, y0, w, h] = region;
        if (w <= 0 || h <= 0 || w * h > 65536) fail('region must be within 1..65536 texels');
        const data = ctx.getImageData(x0, y0, w, h).data;
        const legend = {};
        const byColour = {};
        if (palette) for (const ch of Object.keys(palette)) byColour[hex(rgba(palette[ch]))] = ch;
        let next = 0;
        const rows = [];
        let unknown = 0;
        for (let y = 0; y < h; y++) {
            let row = '';
            for (let x = 0; x < w; x++) {
                const o = (y * w + x) * 4;
                if (data[o + 3] === 0) { row += '.'; continue; }
                const k = hex([data[o], data[o + 1], data[o + 2], data[o + 3]]);
                let ch = byColour[k];
                if (!ch) {
                    if (palette) { ch = '?'; unknown++; }
                    else if (next < PALETTE_CHARS.length) { ch = PALETTE_CHARS[next++]; byColour[k] = ch; legend[ch] = k; }
                    else { ch = '?'; unknown++; }
                }
                row += ch;
            }
            rows.push(row);
        }
        const out = { region: [x0, y0, w, h], rows, legend: palette ? undefined : legend };
        if (unknown) out.unmatched = unknown;
        if (palette) out.legend_note = 'palette given: "?" marks a texel whose colour is not in it';
        return out;
    }

    // ------------------------------------------------------------------ the tools
    const TOOLS = [];
    function tool(def) { TOOLS.push(def); return def; }

    tool({
        name: 'get_project_info', mechanism: OBSERVE,
        description: 'Orientation for the project this call resolves to: format, name, texture size, element and texture counts, top-level groups, bounds, save state, undo position and which session holds it. Free of JavaScript; call it first.',
        inputSchema: { type: 'object', properties: { project: PROJECT_ARG }, additionalProperties: false },
        run(args, ctx) { return projectInfo(ctx.project); },
    });
    function projectInfo(p) {
        const groups = (typeof Outliner !== 'undefined' && Outliner.root ? Outliner.root : []).filter((n) => nodeType(n) === 'group')
            .map((g) => ({ name: g.name, cubes: (g.children || []).filter((c) => nodeType(c) === 'cube').length, groups: (g.children || []).filter((c) => nodeType(c) === 'group').length }));
        const h = holderOf(p, null);
        return {
            name: p.name, uuid: p.uuid, format: p.format ? p.format.id : null,
            texture_width: p.texture_width, texture_height: p.texture_height, box_uv: !!p.box_uv,
            cubes: allCubes().length, elements: allElements().length, groups: allGroups().length,
            top_groups: groups,
            textures: allTextures().map((t) => ({ name: t.name, size: [t.width, t.height] })),
            bounds: boundsOf(allCubes()),
            animations: typeof Animation !== 'undefined' && Animation.all ? Animation.all.length : 0,
            saved: !!p.saved, save_path: p.save_path || null,
            undo: undoState(),
            held_by: h ? holderBlock(h) : null,
        };
    }

    tool({
        name: 'project', mechanism: EDIT,
        description: 'Project and session management. op:list every open tab with its holder; info (= get_project_info); new {name, format, texture_width, texture_height, bind} makes and binds (bind:false for a throwaway: created and made active, but it does NOT take the binding); open {path} loads a .bbmodel/.json and binds; select {project, take} binds this session (take:true takes it from another); save {path} writes the .bbmodel (path optional when it was saved before); close {force} (force closes unsaved); set {name, texture_width, texture_height, box_uv}. Every other tool acts on the bound project unless it names one.',
        inputSchema: {
            type: 'object',
            properties: {
                op: { type: 'string', enum: ['list', 'info', 'new', 'open', 'select', 'save', 'close', 'set'] },
                project: PROJECT_ARG,
                name: { type: 'string' }, format: { type: 'string', description: 'Format id (Formats registry): java_block, modded_entity, free, bedrock, ...' },
                path: { type: 'string', description: 'Absolute file path (open, save).' },
                take: { type: 'boolean' }, force: { type: 'boolean' }, bind: { type: 'boolean', description: 'new: false creates without binding this session to it (a scratch project should not take the binding).' },
                texture_width: { type: 'integer' }, texture_height: { type: 'integer' }, box_uv: { type: 'boolean' },
            },
            required: ['op'], additionalProperties: false,
        },
        async run(args, ctx) {
            const sess = ctx.session;
            switch (args.op) {
                case 'list': {
                    ctx.mechanism = OBSERVE;
                    reapSessions();
                    const active = activeProject();
                    return {
                        projects: projects().map((p) => {
                            const h = holderOf(p, null);
                            return {
                                name: p.name, uuid: p.uuid, format: p.format ? p.format.id : null,
                                active: p === active, bound_to_you: sess.project === p.uuid,
                                held_by: h && h !== sess ? holderBlock(h) : null,
                                saved: !!p.saved, save_path: p.save_path || null,
                            };
                        }),
                        sessions: Object.keys(sessions).filter((id) => alive(sessions[id])).map((id) => ({ id, client: sessions[id].client || null, project: (projects().find((p) => p.uuid === sessions[id].project) || {}).name || null, game: sessions[id].game || null, connections: sessions[id].connections.size })),
                        // The tabs above are THIS WINDOW's; another window's are invisible from here.
                        // Which window, and whether it is yours, is the difference between "nobody has
                        // that project open" and "somebody has it open where you cannot see".
                        window: { name: WINDOW_ID, port: boundPort, yours: claimHolder() === sess, agent: agentBorn, allow_agents: allowAgents },
                    };
                }
                case 'info': {
                    ctx.mechanism = OBSERVE;
                    const p = resolveProject(args, sess, true).project;
                    return projectInfo(p);
                }
                case 'new': {
                    if (!args.name) fail('new needs a name');
                    const fid = args.format || 'java_block';
                    if (typeof Formats === 'undefined' || !Formats[fid]) fail('no format "' + fid + '" (have: ' + (typeof Formats !== 'undefined' ? Object.keys(Formats).join(', ') : '?') + ')');
                    if (typeof newProject !== 'function') fail('newProject is unavailable');
                    newProject(Formats[fid]);
                    const p = activeProject();
                    if (!p) fail('Blockbench created no project');
                    p.name = args.name;
                    if (args.texture_width) p.texture_width = args.texture_width;
                    if (args.texture_height) p.texture_height = args.texture_height;
                    if (typeof args.box_uv === 'boolean') p.box_uv = args.box_uv;
                    // A throwaway must not take the binding. `op:new` binding is right for a piece and
                    // wrong for a scratch: a consumer that makes one from an error path came out bound to
                    // a project it meant to discard, and every later unqualified call resolved THERE by
                    // binding - which outlives the scratch stopping being the active tab, and which its
                    // own "am I bound?" guard could not see (2026-09-08, TODO 1.9).
                    const bind = args.bind !== false;
                    if (bind) sess.project = p.uuid;
                    armEmptyCheck();
                    const made = Object.assign(projectInfo(p), { bound: bind });
                    if (!bind) {
                        const held = projects().find((x) => x.uuid === sess.project);
                        made.note = held
                            ? 'not bound: this session stays bound to "' + held.name + '"'
                            : 'not bound: this session has no project, so an unqualified call falls back to the ACTIVE TAB, which is now "' + p.name + '"';
                    }
                    return made;
                }
                case 'open': {
                    if (!args.path) fail('open needs a path');
                    const path = args.path.replace(/\//g, '\\');
                    const existing = projects().find((p) => p.save_path === path || p.export_path === path || p.save_path === args.path || p.export_path === args.path);
                    let p = existing;
                    if (!p) {
                        const file = await readFile(args.path, 'text');
                        const before = new Set(projects().map((x) => x.uuid));
                        loadModelFile({ path: args.path, name: (file.name || args.path.split(/[\\/]/).pop()), content: file.content });
                        p = projects().find((x) => !before.has(x.uuid)) || activeProject();
                        if (!p) fail('Blockbench opened no project for ' + args.path);
                    } else {
                        ensureSelected(p);
                    }
                    sess.project = p.uuid;
                    armEmptyCheck();
                    return Object.assign(projectInfo(p), { bound: true, was_open: !!existing });
                }
                case 'select': {
                    const p = args.project ? findProject(args.project) : activeProject();
                    if (!p) fail('no project to select', 'project op:list');
                    const h = holderOf(p, sess);
                    if (h && !args.take) {
                        fail('held_by: session ' + h.id + (h.client ? ' (' + h.client + ')' : '') + ' holds "' + p.name + '", ' + liveness(h), 'project op:select {project:"' + p.name + '", take:true} to take it');
                    }
                    if (h) h.project = null;
                    ensureSelected(p);
                    sess.project = p.uuid;
                    return { name: p.name, uuid: p.uuid, bound: true, taken_from: h ? h.id : null };
                }
                case 'save': {
                    const p = resolveProject(args, sess, true).project;
                    guardHeld(p, sess);
                    const path = args.path || p.save_path;
                    if (!path) fail('"' + p.name + '" has never been saved; give path', 'project op:save {path:"C:/.../name.bbmodel"}');
                    if (typeof Codecs === 'undefined' || !Codecs.project) fail('the project codec is unavailable');
                    const content = Codecs.project.compile();
                    const written = await writeFile(path, content, 'text');
                    p.save_path = written;
                    p.saved = true;
                    return { name: p.name, written, bytes: content.length };
                }
                case 'close': {
                    const p = resolveProject(args, sess, true).project;
                    guardHeld(p, sess);
                    if (!p.saved && !args.force) fail('"' + p.name + '" has unsaved changes', 'project op:save first, or op:close {force:true} to discard them');
                    const name = p.name, uuid = p.uuid;
                    await p.close(true);
                    for (const id of Object.keys(sessions)) if (sessions[id].project === uuid) sessions[id].project = null;
                    // An agent-born window that has just gone empty starts its clock here rather than
                    // waiting for the next sweep, which is what makes "the agent finished" and "the
                    // window went away" read as one event to the person watching.
                    armEmptyCheck();
                    return { closed: name, remaining: projects().length };
                }
                case 'set': {
                    const p = resolveProject(args, sess, true).project;
                    guardHeld(p, sess);
                    const changed = {};
                    if (args.name) { p.name = args.name; changed.name = args.name; }
                    if (args.texture_width) { p.texture_width = args.texture_width; changed.texture_width = args.texture_width; }
                    if (args.texture_height) { p.texture_height = args.texture_height; changed.texture_height = args.texture_height; }
                    if (typeof args.box_uv === 'boolean') { p.box_uv = args.box_uv; changed.box_uv = args.box_uv; }
                    if (typeof Canvas !== 'undefined' && Canvas.updateAllUVs) Canvas.updateAllUVs();
                    return { name: p.name, changed };
                }
                default: fail('unknown op');
            }
        },
    });

    tool({
        name: 'list_outline', mechanism: OBSERVE,
        description: 'The outliner tree. detail:"names" (default) gives names and types; "boxes" adds from/to/origin/rotation; "faces" adds each cube\'s face rectangles in texture pixels. group scopes to one bone; depth limits nesting. Duplicate names are reported with their uuids, since a name is the address every other tool takes.',
        inputSchema: {
            type: 'object',
            properties: {
                project: PROJECT_ARG, group: { type: 'string' },
                detail: { type: 'string', enum: ['names', 'boxes', 'faces'] },
                depth: { type: 'integer' }, cubes: { type: 'boolean', description: 'false lists groups only' },
            },
            additionalProperties: false,
        },
        run(args) {
            const detail = args.detail || 'names';
            const maxDepth = args.depth || 32;
            const roots = args.group ? [findGroup(args.group)] : ((typeof Outliner !== 'undefined' && Outliner.root) || []);
            const seen = {};
            const walk = (n, d) => {
                const t = nodeType(n);
                seen[n.name] = (seen[n.name] || 0) + 1;
                if (t === 'group') {
                    const g = { name: n.name, type: 'group' };
                    if (detail !== 'names') { g.origin = rv(n.origin); if (n.rotation && n.rotation.some((r) => r)) g.rotation = rv(n.rotation); }
                    if (d < maxDepth) g.children = (n.children || []).filter((c) => args.cubes !== false || nodeType(c) === 'group').map((c) => walk(c, d + 1));
                    else g.children_hidden = (n.children || []).length;
                    return g;
                }
                if (t !== 'cube') return { name: n.name, type: t };
                if (detail === 'names') return { name: n.name, type: 'cube' };
                const c = cubeReadback(n, false);
                if (detail === 'boxes') delete c.faces;
                delete c.uuid; delete c.group;
                return c;
            };
            const tree = roots.filter((n) => args.cubes !== false || nodeType(n) === 'group').map((n) => walk(n, 1));
            const dupes = Object.keys(seen).filter((k) => seen[k] > 1);
            const out = { tree, cubes: allCubes().length, groups: allGroups().length };
            if (dupes.length) {
                out.duplicate_names = dupes.map((name) => ({ name, uuids: [].concat(allGroups(), allElements()).filter((n) => n.name === name).map((n) => n.uuid) }));
            }
            return out;
        },
    });

    tool({
        name: 'find_elements_by_criteria', mechanism: OBSERVE,
        description: 'Elements matching a name regex or substring, a type, a parent group, a size range. Returns name, type, group and box.',
        inputSchema: {
            type: 'object',
            properties: {
                project: PROJECT_ARG,
                name_pattern: { type: 'string', description: 'regex, case-sensitive' }, name_contains: { type: 'string', description: 'substring, case-insensitive' },
                type: { type: 'string', enum: ['cube', 'group', 'any'] }, parent_group: { type: 'string' },
                min_size: V3, max_size: V3, limit: { type: 'integer' },
            },
            additionalProperties: false,
        },
        run(args) {
            const re = args.name_pattern ? new RegExp(args.name_pattern) : null;
            const sub = args.name_contains ? args.name_contains.toLowerCase() : null;
            const parent = args.parent_group ? findGroup(args.parent_group) : null;
            const under = (n) => { let g = parentOf(n); while (g) { if (g === parent) return true; g = parentOf(g); } return false; };
            const pool = [].concat(args.type === 'cube' ? [] : allGroups(), args.type === 'group' ? [] : allElements());
            const hits = pool.filter((n) => {
                if (re && !re.test(n.name)) return false;
                if (sub && n.name.toLowerCase().indexOf(sub) < 0) return false;
                if (parent && !under(n)) return false;
                if (nodeType(n) === 'cube' && (args.min_size || args.max_size)) {
                    const s = [0, 1, 2].map((i) => n.to[i] - n.from[i]);
                    if (args.min_size && s.some((v, i) => v < args.min_size[i])) return false;
                    if (args.max_size && s.some((v, i) => v > args.max_size[i])) return false;
                }
                return true;
            });
            const limit = args.limit || 200;
            return {
                count: hits.length,
                elements: hits.slice(0, limit).map((n) => nodeType(n) === 'cube'
                    ? { name: n.name, type: 'cube', group: parentOf(n) ? parentOf(n).name : 'root', from: rv(n.from), to: rv(n.to) }
                    : { name: n.name, type: nodeType(n), group: parentOf(n) ? parentOf(n).name : 'root', origin: rv(n.origin), children: (n.children || []).length }),
            };
        },
    });

    tool({
        name: 'get_selection', mechanism: OBSERVE,
        description: 'What is selected in the editor: elements (name, type) and the selected texture.',
        inputSchema: { type: 'object', properties: { project: PROJECT_ARG }, additionalProperties: false },
        run() {
            const sel = (typeof Outliner !== 'undefined' && Outliner.selected) || [];
            const groups = allGroups().filter((g) => g.selected);
            const tex = typeof Texture !== 'undefined' && Texture.selected ? Texture.selected.name : null;
            return { elements: sel.map((n) => ({ name: n.name, type: nodeType(n) })), groups: groups.map((g) => g.name), texture: tex };
        },
    });

    tool({
        name: 'inspect', mechanism: OBSERVE,
        description: 'Measurements the 3D view cannot show. op:bounds (whole model, a group or ids); faces (each cube\'s face rectangles in texture pixels); envelope (for each cube, its neighbours on the same bone and the gap per axis: air, touching or overlap); overlaps (every unrotated cube pair that interpenetrates, with depth); uv (face rectangles that collide on the sheet or fall outside it). Rotated cubes are measured by their unrotated box and said so; the entity plugin\'s check battery is the full arbiter. When it beats the edit reply: after a rework, for the cubes and faces you did not just touch (place_cube/modify_cube already report the ones they did).',
        inputSchema: {
            type: 'object',
            properties: {
                op: { type: 'string', enum: ['bounds', 'faces', 'envelope', 'overlaps', 'uv'] },
                project: PROJECT_ARG, group: { type: 'string' }, id: { type: 'string' }, ids: IDS_ARG,
                texture: { type: 'string', description: 'uv: one sheet (default all)' },
            },
            required: ['op'], additionalProperties: false,
        },
        run(args) {
            let cubes;
            if (args.id || (args.ids && args.ids.length)) {
                cubes = resolveIds(args).flatMap((n) => nodeType(n) === 'group' ? cubesUnder(n) : [n]);
            } else if (args.group) {
                cubes = cubesUnder(findGroup(args.group));
            } else {
                cubes = allCubes();
            }
            switch (args.op) {
                case 'bounds': return { bounds: boundsOf(cubes), scope: args.group || (args.id || args.ids ? 'ids' : 'model') };
                case 'faces': return { cubes: cubes.map((c) => ({ name: c.name, texture: (textureFor(c) || {}).name || null, faces: faceRects(c) })) };
                case 'envelope': return { cubes: cubes.map((c) => ({ name: c.name, group: parentOf(c) ? parentOf(c).name : 'root', from: rv(c.from), to: rv(c.to), neighbours: envelopeOf(c) })) };
                case 'overlaps': {
                    const pairs = [];
                    const unchecked = [];
                    for (let i = 0; i < cubes.length; i++) {
                        if (isRotated(cubes[i])) { unchecked.push(cubes[i].name); continue; }
                        for (let j = i + 1; j < cubes.length; j++) {
                            if (isRotated(cubes[j])) continue;
                            const a = box(cubes[i]), b = box(cubes[j]);
                            const depth = [0, 1, 2].map((k) => Math.min(a.to[k], b.to[k]) - Math.max(a.from[k], b.from[k]));
                            if (depth.every((d) => d > 0)) pairs.push({ a: cubes[i].name, b: cubes[j].name, depth: rv(depth), least: round(Math.min.apply(null, depth)) });
                        }
                    }
                    pairs.sort((x, y) => y.least - x.least);
                    const out = { overlapping_pairs: pairs, checked: cubes.length - unchecked.length };
                    if (unchecked.length) out.unchecked_rotated = unchecked;
                    return out;
                }
                case 'uv': {
                    const sheets = args.texture ? [findTexture(args.texture)] : allTextures();
                    const out = { sheets: [] };
                    for (const tex of sheets) {
                        const rects = [];
                        for (const c of cubes) {
                            if (textureFor(c) !== tex) continue;
                            for (const face of FACES) {
                                const f = c.faces && c.faces[face];
                                if (!f || !f.uv || f.texture === null) continue;
                                rects.push({ key: c.name + '.' + face, r: faceRect(c, face, tex) });
                            }
                        }
                        const collisions = [];
                        const outside = [];
                        for (let i = 0; i < rects.length; i++) {
                            const A = rects[i].r;
                            if (A[0] < 0 || A[1] < 0 || A[0] + A[2] > tex.width || A[1] + A[3] > tex.height) outside.push(rects[i].key);
                            for (let j = i + 1; j < rects.length; j++) {
                                const B = rects[j].r;
                                const w = Math.min(A[0] + A[2], B[0] + B[2]) - Math.max(A[0], B[0]);
                                const h = Math.min(A[1] + A[3], B[1] + B[3]) - Math.max(A[1], B[1]);
                                if (w > 0 && h > 0 && A[2] > 0 && A[3] > 0 && B[2] > 0 && B[3] > 0) collisions.push({ a: rects[i].key, b: rects[j].key, px: w * h });
                            }
                        }
                        out.sheets.push({ texture: tex.name, size: [tex.width, tex.height], faces: rects.length, collisions, outside });
                    }
                    return out;
                }
                default: fail('unknown op');
            }
        },
    });
    function cubesUnder(g) {
        const out = [];
        const walk = (n) => { for (const c of n.children || []) { if (nodeType(c) === 'cube') out.push(c); else if (nodeType(c) === 'group') walk(c); } };
        walk(g);
        return out;
    }

    const CUBE_FIELDS = {
        name: { type: 'string' }, from: V3, to: V3, origin: V3, rotation: V3,
        inflate: { type: 'number' }, mirror_uv: { type: 'boolean' }, uv_offset: V2,
        visibility: { type: 'boolean' },
    };
    tool({
        name: 'place_cube', mechanism: EDIT,
        description: 'Add cubes in one call (one undo entry). Each element: name, from, to, optional origin/rotation/inflate/mirror_uv/uv_offset. group puts them in a bone (default root); texture names the sheet (default the selected/first); uv "auto" (default) maps each face by Blockbench\'s auto-UV, "box" uses box UV at uv_offset, "none" leaves faces unmapped. The reply carries every cube\'s face rectangles and its envelope (neighbours on the same bone, gap per axis) so the next call needs no read.',
        inputSchema: {
            type: 'object',
            properties: {
                project: PROJECT_ARG,
                elements: { type: 'array', minItems: 1, items: { type: 'object', properties: CUBE_FIELDS, required: ['from', 'to'], additionalProperties: false } },
                group: { type: 'string' }, texture: { type: 'string' },
                uv: { type: 'string', enum: ['auto', 'box', 'none'] }, look: LOOK_ARG,
            },
            required: ['elements'], additionalProperties: false,
        },
        run(args) {
            const parent = groupRef(args.group);
            const mode = args.uv || 'auto';
            const tex = mode === 'none' ? null : (allTextures().length ? findTexture(args.texture) : null);
            const made = undoEdit({ elements: [], outliner: true }, 'place_cube', (aspects) => {
                return args.elements.map((e) => {
                    for (let i = 0; i < 3; i++) if (e.to[i] < e.from[i]) fail('cube "' + (e.name || '?') + '": to must be >= from on every axis');
                    const c = new Cube({
                        name: e.name || 'cube', from: e.from, to: e.to, origin: e.origin || e.from, rotation: e.rotation || [0, 0, 0],
                        inflate: e.inflate || 0, mirror_uv: !!e.mirror_uv, autouv: mode === 'auto' ? 1 : 0, visibility: e.visibility !== false,
                    }).init();
                    c.addTo(parent);
                    if (mode === 'box') {
                        if (typeof c.setUVMode === 'function') c.setUVMode(true); else c.box_uv = true;
                        if (e.uv_offset) c.uv_offset = e.uv_offset;
                    }
                    if (tex) c.applyTexture(tex, true);
                    if (mode !== 'none') c.mapAutoUV();
                    aspects.elements.push(c);
                    return c;
                });
            });
            updateCanvas();
            return { cubes: made.map((c) => cubeReadback(c, true)), group: parent === 'root' ? 'root' : parent.name, texture: tex ? tex.name : null, undo: 'one entry' };
        },
    });

    tool({
        name: 'modify_cube', mechanism: EDIT,
        description: 'Change one cube (id) or several (ids) in one undo entry: any of from, to, origin, rotation, inflate, mirror_uv, uv_offset, name, visibility. Faces are re-mapped when the cube has auto-UV. Replies with the readback: box, face rectangles, envelope.',
        inputSchema: {
            type: 'object',
            properties: Object.assign({ project: PROJECT_ARG, id: { type: 'string' }, ids: IDS_ARG, look: LOOK_ARG }, CUBE_FIELDS),
            additionalProperties: false,
        },
        run(args) {
            const cubes = resolveIds(args).map((n) => { if (nodeType(n) !== 'cube') fail('"' + n.name + '" is a ' + nodeType(n) + ', not a cube (element op:set moves groups)'); return n; });
            const patch = {};
            for (const k of Object.keys(CUBE_FIELDS)) if (args[k] !== undefined) patch[k] = args[k];
            if (!Object.keys(patch).length) fail('nothing to change');
            if (args.name && cubes.length > 1) fail('name applies to one cube');
            undoEdit({ elements: cubes }, 'modify_cube', () => {
                for (const c of cubes) {
                    const from = patch.from || c.from, to = patch.to || c.to;
                    for (let i = 0; i < 3; i++) if (to[i] < from[i]) fail('"' + c.name + '": to must be >= from on every axis');
                    c.extend(patch);
                    if (c.autouv && (patch.from || patch.to || patch.inflate !== undefined)) c.mapAutoUV();
                }
            });
            updateCanvas();
            return { cubes: cubes.map((c) => cubeReadback(c, true)), changed: Object.keys(patch), undo: 'one entry' };
        },
    });

    tool({
        name: 'add_group', mechanism: EDIT,
        description: 'Add a bone: name, origin (pivot), rotation, parent (default root). children moves existing elements into it. Replies with the group and its path.',
        inputSchema: {
            type: 'object',
            properties: { project: PROJECT_ARG, name: { type: 'string' }, origin: V3, rotation: V3, parent: { type: 'string' }, children: IDS_ARG },
            required: ['name'], additionalProperties: false,
        },
        run(args) {
            const parent = groupRef(args.parent);
            const kids = (args.children || []).map(findAny);
            const g = undoEdit({ outliner: true, elements: kids }, 'add_group', () => {
                const grp = new Group({ name: args.name, origin: args.origin || [0, 0, 0], rotation: args.rotation || [0, 0, 0] }).init();
                grp.addTo(parent);
                for (const k of kids) k.addTo(grp);
                return grp;
            });
            updateCanvas();
            return { name: g.name, uuid: g.uuid, origin: rv(g.origin), rotation: rv(g.rotation), parent: parent === 'root' ? 'root' : parent.name, children: kids.map((k) => k.name), undo: 'one entry' };
        },
    });

    tool({
        name: 'element', mechanism: EDIT,
        description: 'Element operations on one (id) or several (ids), one undo entry: op remove; rename {name}; duplicate (returns the copies\' names); reparent {parent}; set {origin, rotation, visibility, name} on groups or cubes; select; show; hide.',
        inputSchema: {
            type: 'object',
            properties: {
                op: { type: 'string', enum: ['remove', 'rename', 'duplicate', 'reparent', 'set', 'select', 'show', 'hide'] },
                project: PROJECT_ARG, id: { type: 'string' }, ids: IDS_ARG,
                name: { type: 'string' }, parent: { type: 'string' }, origin: V3, rotation: V3, visibility: { type: 'boolean' }, look: LOOK_ARG,
            },
            required: ['op'], additionalProperties: false,
        },
        run(args) {
            const nodes = resolveIds(args);
            const names = nodes.map((n) => n.name);
            switch (args.op) {
                case 'remove':
                    undoEdit({ elements: nodes.filter((n) => nodeType(n) !== 'group'), outliner: true }, 'element remove', () => { for (const n of nodes) n.remove(); });
                    updateCanvas();
                    return { removed: names, undo: 'one entry' };
                case 'rename':
                    if (!args.name) fail('rename needs name');
                    if (nodes.length > 1) fail('rename one element at a time');
                    undoEdit({ elements: nodes.filter((n) => nodeType(n) !== 'group'), outliner: true }, 'element rename', () => { nodes[0].name = args.name; });
                    return { renamed: names[0], to: args.name, undo: 'one entry' };
                case 'duplicate': {
                    // Blockbench's duplicate() renames a copy by bumping a trailing number ("c1" -> "c2", colliding
                    // with an existing c2) and keeps a name without one; `name` overrides that (a suffix index when
                    // several are copied). The copies join the entry's elements so undo removes them.
                    const copies = undoEdit({ outliner: true, elements: [] }, 'element duplicate', (aspects) => nodes.map((n, i) => {
                        const c = n.duplicate();
                        if (args.name) c.name = nodes.length > 1 ? args.name + (i + 1) : args.name;
                        for (const el of (nodeType(c) === 'group' ? c.children.filter((k) => nodeType(k) !== 'group') : [c])) aspects.elements.push(el);
                        return c;
                    }));
                    updateCanvas();
                    const out = { duplicated: names, copies: copies.map((c) => (c && c.name) || null), undo: 'one entry' };
                    const pool = [].concat(allGroups(), allElements());
                    const collide = out.copies.filter((n) => n && pool.filter((x) => x.name === n).length > 1);
                    if (collide.length) out.note = 'name(s) now shared: ' + collide.join(', ') + '; pass name, or element op:rename by uuid';
                    return out;
                }
                case 'reparent': {
                    const parent = groupRef(args.parent);
                    undoEdit({ outliner: true, elements: nodes.filter((n) => nodeType(n) !== 'group') }, 'element reparent', () => { for (const n of nodes) n.addTo(parent); });
                    updateCanvas();
                    return { moved: names, parent: parent === 'root' ? 'root' : parent.name, undo: 'one entry' };
                }
                case 'set': {
                    const patch = {};
                    if (args.origin) patch.origin = args.origin;
                    if (args.rotation) patch.rotation = args.rotation;
                    if (typeof args.visibility === 'boolean') patch.visibility = args.visibility;
                    if (args.name) { if (nodes.length > 1) fail('name applies to one element'); patch.name = args.name; }
                    if (!Object.keys(patch).length) fail('set needs origin, rotation, visibility or name');
                    undoEdit({ outliner: true, elements: nodes.filter((n) => nodeType(n) !== 'group') }, 'element set', () => { for (const n of nodes) n.extend(patch); });
                    updateCanvas();
                    return { set: names, changed: Object.keys(patch), undo: 'one entry' };
                }
                case 'select':
                    // NOT n.select(): with no event its normal path is `unselectAllElements([this])`
                    // (Group.select() clears every group too), so a loop leaves only the LAST name
                    // selected while the reply claims all of them. `markAsSelected` / `multiSelect` are
                    // what the app's own multi-select paths call once the others are already cleared.
                    if (typeof unselectAllElements === 'function') unselectAllElements();
                    for (const n of nodes) {
                        if (nodeType(n) === 'group' && typeof n.multiSelect === 'function') n.multiSelect();
                        else if (typeof n.markAsSelected === 'function') n.markAsSelected(true);
                        else n.select();
                    }
                    if (typeof updateSelection === 'function') updateSelection();
                    return { selected: names };
                case 'show': case 'hide': {
                    const vis = args.op === 'show';
                    undoEdit({ outliner: true, elements: nodes.filter((n) => nodeType(n) !== 'group') }, 'element ' + args.op, () => {
                        for (const n of nodes) { n.visibility = vis; if (nodeType(n) === 'group') for (const c of cubesUnder(n)) c.visibility = vis; }
                    });
                    if (typeof Canvas !== 'undefined' && Canvas.updateVisibility) Canvas.updateVisibility();
                    return { [args.op === 'show' ? 'shown' : 'hidden']: names, undo: 'one entry' };
                }
                default: fail('unknown op');
            }
        },
    });

    tool({
        name: 'create_texture', mechanism: EDIT,
        description: 'Make a texture of a size that applies (width/height, default the project\'s UV size), filled with a colour or transparent, or loaded from a PNG path. assign "blank" (default) puts it on every face without one, "all" on every cube, "none" on nothing. Replies with the size actually made and the opaque count; get_texture shows it.',
        inputSchema: {
            type: 'object',
            properties: {
                project: PROJECT_ARG, name: { type: 'string' }, width: { type: 'integer' }, height: { type: 'integer' },
                fill: COLOUR, path: { type: 'string', description: 'PNG to load instead of filling' },
                assign: { type: 'string', enum: ['blank', 'all', 'none'] },
            },
            required: ['name'], additionalProperties: false,
        },
        async run(args, ctx) {
            const p = ctx.project;
            const w = args.width || p.texture_width || 16, h = args.height || p.texture_height || 16;
            if (allTextures().some((t) => t.name === args.name || t.name === args.name + '.png')) fail('a texture named "' + args.name + '" exists', 'texture op:remove it, or use another name');
            let t = new Texture({ name: args.name, width: w, height: h, internal: true });
            if (args.path) {
                const file = await readFile(args.path, 'image');
                t.fromDataURL(file.content);
                t.name = args.name;
                await new Promise((resolve) => { let n = 0; const iv = setInterval(() => { if ((t.img && t.img.complete && t.img.naturalWidth) || ++n > 40) { clearInterval(iv); resolve(); } }, 50); });
                if (t.img && t.img.naturalWidth) { t.width = t.img.naturalWidth; t.height = t.img.naturalHeight; }
            } else {
                // The size must be applied to the canvas itself: Blockbench's constructor takes
                // width/height but the canvas it makes stays 16x16 (blockbench-mcp-setup memory
                // gotcha 2), and painting into it then clips almost everything.
                t.width = w; t.height = h; t.uv_width = w; t.uv_height = h;
                if (t.canvas) { t.canvas.width = w; t.canvas.height = h; }
                const canvas = t.canvas || makeCanvas(w, h);
                const ctx2 = canvas.getContext('2d');
                t.ctx = ctx2;
                const c = args.fill === undefined ? null : rgba(args.fill);
                if (c) { ctx2.fillStyle = 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (c[3] / 255) + ')'; ctx2.fillRect(0, 0, w, h); } else ctx2.clearRect(0, 0, w, h);
                t.updateSource(canvas.toDataURL('image/png'));
                if (typeof t.updateLayerChanges === 'function') t.updateLayerChanges(true);
            }
            t.layers_enabled = false;
            undoEdit({ textures: [], elements: allCubes() }, 'create_texture', (aspects) => {
                t.add(false);
                aspects.textures.push(t);
                const assign = args.assign || 'blank';
                if (assign !== 'none') {
                    for (const c of allCubes()) {
                        const blank = FACES.filter((f) => c.faces && c.faces[f] && !c.faces[f].texture);
                        if (assign === 'all') c.applyTexture(t, true);
                        else if (blank.length) c.applyTexture(t, blank);
                    }
                }
            });
            updateCanvas();
            const opaque = opaqueCount(t);
            const out = { name: t.name, uuid: t.uuid, size: [t.width, t.height], opaque, project_uv: [p.texture_width, p.texture_height], undo: 'one entry' };
            if (!opaque && (args.assign || 'blank') !== 'none') out.note = 'fully transparent: every face wearing it is invisible until painted (paint_faces, paint_ascii, texture op:rects)';
            return out;
        },
    });

    tool({
        name: 'apply_texture', mechanism: EDIT,
        description: 'Put a texture on cubes (id/ids/group, default all): faces omitted means every face, else the named faces. null-faces stay unmapped.',
        inputSchema: {
            type: 'object',
            properties: { project: PROJECT_ARG, texture: { type: 'string' }, id: { type: 'string' }, ids: IDS_ARG, group: { type: 'string' }, faces: { type: 'array', items: { type: 'string', enum: FACES } } },
            required: ['texture'], additionalProperties: false,
        },
        run(args) {
            const tex = findTexture(args.texture);
            let cubes;
            if (args.id || args.ids) cubes = resolveIds(args).flatMap((n) => nodeType(n) === 'group' ? cubesUnder(n) : [n]);
            else if (args.group) cubes = cubesUnder(findGroup(args.group));
            else cubes = allCubes();
            undoEdit({ elements: cubes }, 'apply_texture', () => { for (const c of cubes) c.applyTexture(tex, args.faces || true); });
            updateCanvas();
            return { texture: tex.name, cubes: cubes.map((c) => c.name), faces: args.faces || 'all', undo: 'one entry' };
        },
    });

    tool({
        name: 'list_textures', mechanism: OBSERVE,
        description: 'Every texture: name, size, opaque pixel count, how many cubes use it, whether it is selected.',
        inputSchema: { type: 'object', properties: { project: PROJECT_ARG }, additionalProperties: false },
        run() {
            const cubes = allCubes();
            return {
                textures: allTextures().map((t) => ({
                    name: t.name, size: [t.width, t.height], opaque: opaqueCount(t),
                    used_by: cubes.filter((c) => textureFor(c) === t).length, selected: !!t.selected,
                })),
            };
        },
    });

    tool({
        name: 'get_texture', mechanism: OBSERVE,
        description: 'A texture as a picture (never cropped: its pixel (x, y) is an address the next paint call names), with size and opaque count. region [x, y, w, h] returns that part.',
        inputSchema: {
            type: 'object',
            properties: { project: PROJECT_ARG, texture: { type: 'string' }, region: { type: 'array', items: { type: 'integer' }, minItems: 4, maxItems: 4 } },
            additionalProperties: false,
        },
        run(args) {
            const t = findTexture(args.texture);
            let url;
            if (args.region) {
                const [x, y, w, h] = args.region;
                const c = makeCanvas(w, h);
                c.getContext('2d').drawImage(t.canvas, x, y, w, h, 0, 0, w, h);
                url = c.toDataURL('image/png');
            } else {
                url = t.canvas ? t.canvas.toDataURL('image/png') : t.getDataURL();
            }
            return { name: t.name, size: [t.width, t.height], opaque: opaqueCount(t), region: args.region || null, _image: imageOf(url, false) };
        },
    });

    tool({
        name: 'texture', mechanism: EDIT,
        description: 'Texture operations, one undo entry each. op:read {region | cube+face, palette?} returns the texels as rows of characters with a legend (the reading half of paint_ascii); rects {rects:[{x,y,w,h,c}]} fills or clears rectangles (c null clears); resize {width, height, mode:"scale"|"pad", project_uv} ; recolor {map:{"#from":"#to"}, region?}; flip {axis:"x"|"y"}; load {path} replaces the pixels from a PNG; write {path} saves a PNG; rename {name}; remove.',
        inputSchema: {
            type: 'object',
            properties: {
                op: { type: 'string', enum: ['read', 'rects', 'resize', 'recolor', 'flip', 'load', 'write', 'rename', 'remove'] },
                project: PROJECT_ARG, texture: { type: 'string' },
                region: { type: 'array', items: { type: 'integer' }, minItems: 4, maxItems: 4 }, cube: { type: 'string' }, face: { type: 'string', enum: FACES },
                palette: { type: 'object', additionalProperties: true },
                rects: { type: 'array', items: { type: 'object', properties: { x: { type: 'integer' }, y: { type: 'integer' }, w: { type: 'integer' }, h: { type: 'integer' }, c: COLOUR }, required: ['x', 'y', 'w', 'h'], additionalProperties: false } },
                width: { type: 'integer' }, height: { type: 'integer' }, mode: { type: 'string', enum: ['scale', 'pad'] }, project_uv: { type: 'boolean' },
                map: { type: 'object', additionalProperties: true }, axis: { type: 'string', enum: ['x', 'y'] },
                path: { type: 'string' }, name: { type: 'string' }, look: LOOK_ARG,
            },
            required: ['op'], additionalProperties: false,
        },
        async run(args, ctx) {
            const t = findTexture(args.texture);
            const regionOf = () => {
                if (args.region) return args.region;
                if (args.cube && args.face) return faceRect(findCube(args.cube), args.face, t);
                return [0, 0, t.width, t.height];
            };
            switch (args.op) {
                case 'read':
                    ctx.mechanism = OBSERVE;
                    return Object.assign({ texture: t.name, size: [t.width, t.height] }, readAscii(t, regionOf(), args.palette || null));
                case 'rects': {
                    if (!args.rects || !args.rects.length) fail('rects needs rects');
                    const rep = paintOn(t, 'texture rects', (img, W, H, r) => {
                        const px = pixelOps(img, W, H, r);
                        r.filled = 0; r.cleared = 0;
                        for (const q of args.rects) {
                            const c = q.c === undefined ? null : rgba(q.c);
                            for (let y = q.y; y < q.y + q.h; y++) for (let x = q.x; x < q.x + q.w; x++) { px.set(x, y, c); if (c) r.filled++; else r.cleared++; }
                        }
                    });
                    return Object.assign({ texture: t.name, size: [t.width, t.height], rects: args.rects.length }, rep, { undo: 'one entry' });
                }
                case 'resize': {
                    if (!args.width || !args.height) fail('resize needs width and height');
                    const src = makeCanvas(t.width, t.height);
                    src.getContext('2d').drawImage(t.canvas, 0, 0);
                    undoEdit({ textures: [t], bitmap: true }, 'texture resize', () => {
                        t.canvas.width = args.width; t.canvas.height = args.height;
                        const c2 = t.canvas.getContext('2d');
                        c2.imageSmoothingEnabled = false;
                        c2.clearRect(0, 0, args.width, args.height);
                        if ((args.mode || 'scale') === 'scale') c2.drawImage(src, 0, 0, src.width, src.height, 0, 0, args.width, args.height);
                        else c2.drawImage(src, 0, 0);
                        t.width = args.width; t.height = args.height; t.uv_width = args.width; t.uv_height = args.height;
                        t.ctx = c2;
                        t.updateSource(t.canvas.toDataURL('image/png'));
                        if (args.project_uv) { ctx.project.texture_width = args.width; ctx.project.texture_height = args.height; }
                    });
                    if (typeof Canvas !== 'undefined' && Canvas.updateAllUVs) Canvas.updateAllUVs();
                    updateCanvas();
                    return { texture: t.name, size: [t.width, t.height], mode: args.mode || 'scale', project_uv: [ctx.project.texture_width, ctx.project.texture_height], undo: 'one entry' };
                }
                case 'recolor': {
                    if (!args.map || !Object.keys(args.map).length) fail('recolor needs map {"#from": "#to"}');
                    const table = {};
                    for (const k of Object.keys(args.map)) table[hex(rgba(k))] = rgba(args.map[k]);
                    const region = regionOf();
                    const rep = paintOn(t, 'texture recolor', (img, W, H, r) => {
                        const px = pixelOps(img, W, H, r);
                        r.changed = 0;
                        for (let y = region[1]; y < region[1] + region[3]; y++) for (let x = region[0]; x < region[0] + region[2]; x++) {
                            const c = px.get(x, y);
                            if (!c || c[3] === 0) continue;
                            const to = table[hex(c)];
                            if (to) { px.set(x, y, to); r.changed++; }
                        }
                    });
                    return Object.assign({ texture: t.name, region }, rep, { undo: 'one entry' });
                }
                case 'flip': {
                    if (!args.axis) fail('flip needs axis');
                    const src = makeCanvas(t.width, t.height);
                    src.getContext('2d').drawImage(t.canvas, 0, 0);
                    paintOn(t, 'texture flip', (img, W, H) => {
                        const sctx = src.getContext('2d').getImageData(0, 0, W, H).data;
                        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
                            const sx = args.axis === 'x' ? W - 1 - x : x, sy = args.axis === 'y' ? H - 1 - y : y;
                            const o = (y * W + x) * 4, s = (sy * W + sx) * 4;
                            img.data[o] = sctx[s]; img.data[o + 1] = sctx[s + 1]; img.data[o + 2] = sctx[s + 2]; img.data[o + 3] = sctx[s + 3];
                        }
                    });
                    return { texture: t.name, flipped: args.axis, undo: 'one entry' };
                }
                case 'load': {
                    if (!args.path) fail('load needs path');
                    const file = await readFile(args.path, 'image');
                    const img = await loadImage(file.content);
                    undoEdit({ textures: [t], bitmap: true }, 'texture load', () => {
                        t.canvas.width = img.width; t.canvas.height = img.height;
                        const c2 = t.canvas.getContext('2d');
                        c2.clearRect(0, 0, img.width, img.height);
                        c2.drawImage(img, 0, 0);
                        t.width = img.width; t.height = img.height; t.uv_width = img.width; t.uv_height = img.height;
                        t.ctx = c2;
                        t.updateSource(t.canvas.toDataURL('image/png'));
                    });
                    updateCanvas();
                    return { texture: t.name, size: [t.width, t.height], opaque: opaqueCount(t), loaded: args.path, undo: 'one entry' };
                }
                case 'write': {
                    ctx.mechanism = OBSERVE;
                    if (!args.path) fail('write needs path');
                    const written = await writeFile(args.path, t.canvas ? t.canvas.toDataURL('image/png') : t.getDataURL(), 'image');
                    return { texture: t.name, written, size: [t.width, t.height] };
                }
                case 'rename':
                    if (!args.name) fail('rename needs name');
                    undoEdit({ textures: [t] }, 'texture rename', () => { t.name = args.name; });
                    return { renamed: args.name, undo: 'one entry' };
                case 'remove': {
                    const name = t.name;
                    // remove(no_update) opens its OWN Undo entry unless told not to, so the bare call
                    // made a SECOND entry inside ours and contradicted this reply's "one entry" (the
                    // animation path gets the same shape right with a.remove(false)). What no_update
                    // also skips is the refresh: updateCanvas() covers the faces and UVs (updateAll
                    // passes no element_aspects, so every element is rebuilt whole), and the UV panel
                    // holds a hard reference of its own, cleared below.
                    undoEdit({ textures: [t], elements: allCubes() }, 'texture remove', () => { t.remove(true); });
                    if (typeof UVEditor !== 'undefined' && UVEditor.vue && UVEditor.vue.texture === t && UVEditor.vue.updateTexture) UVEditor.vue.updateTexture();
                    updateCanvas();
                    return { removed: name, remaining: allTextures().map((x) => x.name), undo: 'one entry' };
                }
                default: fail('unknown op');
            }
        },
    });

    tool({
        name: 'paint_faces', mechanism: EDIT,
        description: 'Paint whole FACES of cubes on a texture in one call, one undo entry. faces maps "<cube>.<face>" (north/south/east/west/up/down, or "<cube>.*") to a colour, a [top, bottom] pair shaded row by row, or null to clear. pixels maps "x,y" to a colour for the odd texel. Replies with every rectangle painted and its pixel count.',
        inputSchema: {
            type: 'object',
            properties: {
                project: PROJECT_ARG, texture: { type: 'string' },
                faces: { type: 'object', additionalProperties: true }, pixels: { type: 'object', additionalProperties: true }, look: LOOK_ARG,
            },
            additionalProperties: false,
        },
        run(args) {
            if (!args.faces && !args.pixels) fail('give faces and/or pixels');
            return paintFaces(findTexture(args.texture), args);
        },
    });

    tool({
        name: 'paint_ascii', mechanism: EDIT,
        description: 'Stamp ASCII art onto a texture, several stamps in one call and one undo entry. Each stamp names a region (at:[x,y], or cube+face) and rows of one character per texel looked up in palette (the stamp\'s, else the call\'s): space leaves the texel alone, "." clears it. fill paints the region first; tile repeats the rows; shift offsets them; shade_only paints only where a texel is already opaque (pins the silhouette).',
        inputSchema: {
            type: 'object',
            properties: {
                project: PROJECT_ARG, texture: { type: 'string' }, palette: { type: 'object', additionalProperties: true },
                stamps: {
                    type: 'array', minItems: 1,
                    items: {
                        type: 'object',
                        properties: {
                            at: V2, cube: { type: 'string' }, face: { type: 'string', enum: FACES }, rows: { type: 'array', items: { type: 'string' } },
                            fill: COLOUR, tile: { type: 'boolean' }, shift: V2, shade_only: { type: 'boolean' }, palette: { type: 'object', additionalProperties: true },
                        },
                        additionalProperties: false,
                    },
                },
                look: LOOK_ARG,
            },
            required: ['stamps'], additionalProperties: false,
        },
        run(args) { return paintAscii(findTexture(args.texture), args); },
    });

    tool({
        name: 'capture_screenshot', mechanism: OBSERVE,
        description: 'The viewport as a picture. angle names a preset (initial, north, south, east, west, top, bottom, isometric_right, isometric_left, ...) or give position/target/projection; fit:true frames the whole model. views:["north","east","top"] is the recommended look: each preset rendered into ONE contact sheet, one turn and one picture instead of a set_camera_angle per view (tile px each, default 512; ask the shim for max:768 or more to keep it legible). The camera is left where it was for a single capture with no angle, and restored after a sheet.',
        inputSchema: {
            type: 'object',
            properties: {
                project: PROJECT_ARG, angle: { type: 'string' }, position: V3, target: V3,
                projection: { type: 'string', enum: ['perspective', 'orthographic'] }, fit: { type: 'boolean' }, fit_margin: { type: 'number' },
                views: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 6 }, tile: { type: 'integer' },
            },
            additionalProperties: false,
        },
        async run(args) {
            if (args.views) {
                const sheet = await contactSheet(args.views, args.tile || 512);
                return { views: sheet.views, tile: sheet.tile, width: sheet.width, height: sheet.height, _image: imageOf(sheet.url, true) };
            }
            const cam = applyCamera(args);
            const r = renderViewport();
            return { width: r.width, height: r.height, angle: cam.angle, camera: cam.camera, _image: imageOf(r.url, true) };
        },
    });

    tool({
        name: 'set_camera_angle', mechanism: OBSERVE,
        description: 'Move the viewport camera: a preset (angle) or position/target/projection; fit:true frames the model. Returns the camera; add look:true for the picture.',
        inputSchema: {
            type: 'object',
            properties: { project: PROJECT_ARG, angle: { type: 'string' }, position: V3, target: V3, projection: { type: 'string', enum: ['perspective', 'orthographic'] }, fit: { type: 'boolean' }, fit_margin: { type: 'number' }, look: LOOK_ARG },
            additionalProperties: false,
        },
        run(args) { return applyCamera(args); },
    });

    tool({
        name: 'export_model', mechanism: OBSERVE,
        description: 'Compile the project through a codec (default the format\'s own; "project" is the .bbmodel, "modded_entity" the Java, "java_block" the block model JSON) and return the text, or write it to path and return the size. list:true names the codecs.',
        inputSchema: {
            type: 'object',
            properties: { project: PROJECT_ARG, codec: { type: 'string' }, path: { type: 'string' }, options: { type: 'object', additionalProperties: true }, list: { type: 'boolean' } },
            additionalProperties: false,
        },
        async run(args, ctx) {
            if (typeof Codecs === 'undefined') fail('Codecs is unavailable');
            if (args.list) return { codecs: Object.keys(Codecs), current: ctx.project.format && ctx.project.format.codec ? ctx.project.format.codec.id : null };
            const codec = args.codec ? Codecs[args.codec] : (ctx.project.format && ctx.project.format.codec);
            if (!codec) fail('no codec "' + args.codec + '" (have: ' + Object.keys(Codecs).join(', ') + ')');
            if (typeof codec.compile !== 'function') fail('codec "' + codec.id + '" cannot compile');
            let content = codec.compile(args.options || undefined);
            if (typeof content !== 'string') content = JSON.stringify(content);
            if (args.path) {
                const written = await writeFile(args.path, content, 'text');
                return { codec: codec.id, written, bytes: content.length };
            }
            const LIMIT = 200000;
            const out = { codec: codec.id, bytes: content.length, content: content.slice(0, LIMIT) };
            if (content.length > LIMIT) out.truncated = true;
            return out;
        },
    });

    tool({
        name: 'undo', mechanism: EDIT,
        description: 'Undo steps (default 1) in this project. Replies with the undo position and the last entry name.',
        inputSchema: { type: 'object', properties: { project: PROJECT_ARG, steps: { type: 'integer' } }, additionalProperties: false },
        run(args) {
            const n = args.steps || 1;
            const before = (undoState() || { index: 0 }).index;
            for (let i = 0; i < n; i++) Undo.undo();
            updateCanvas();
            const after = undoState() || { index: 0 };
            // What moved, not what was asked: an empty stack undid nothing (live, 2026-09-07).
            return Object.assign({ undone: before - after.index, asked: n }, after, before === after.index ? { note: 'nothing to undo' } : {});
        },
    });
    tool({
        name: 'redo', mechanism: EDIT,
        description: 'Redo steps (default 1) in this project.',
        inputSchema: { type: 'object', properties: { project: PROJECT_ARG, steps: { type: 'integer' } }, additionalProperties: false },
        run(args) {
            const n = args.steps || 1;
            const before = (undoState() || { index: 0 }).index;
            for (let i = 0; i < n; i++) Undo.redo();
            updateCanvas();
            const after = undoState() || { index: 0 };
            return Object.assign({ redone: after.index - before, asked: n }, after, before === after.index ? { note: 'nothing to redo' } : {});
        },
    });
    tool({
        name: 'get_undo_stack', mechanism: OBSERVE,
        description: 'The last entries of this project\'s undo history (default 20) and the current index.',
        inputSchema: { type: 'object', properties: { project: PROJECT_ARG, limit: { type: 'integer' } }, additionalProperties: false },
        run(args) {
            if (typeof Undo === 'undefined' || !Undo.history) fail('no undo history');
            const limit = args.limit || 20;
            const h = Undo.history;
            const start = Math.max(0, h.length - limit);
            return Object.assign({ entries: h.slice(start).map((e, i) => ({ index: start + i + 1, action: e.action, current: start + i + 1 === Undo.index })) }, undoState());
        },
    });

    tool({
        name: 'risky_eval', mechanism: EDIT,
        description: 'Run JavaScript inside Blockbench, in the resolved project, and return its value (JSON). PROJECT is that project and GAME is this session\'s game bridge URL, both in scope: hand them to a plugin API (api.save(PROJECT), {bridge: GAME}) instead of letting the API read the global Project or a hardcoded port, and a call that resolved wrongly cannot write silently. An expression or statements; comments and console are fine; a returned Promise is awaited and a rejection is an error reply. The older plugins\' globals are here and both take them: mcptoolkitPush({project: PROJECT, bridge: GAME}), mcptoolkitEntity({action, project: PROJECT, bridge: GAME}).',
        inputSchema: { type: 'object', properties: { project: PROJECT_ARG, code: { type: 'string' } }, required: ['code'], additionalProperties: false },
        async run(args, ctx) {
            // PROJECT: the project this call resolved to (ArmorPieces' measurement of 2026-09-07, ask
            // 1). A plugin API reached through eval reads Blockbench's GLOBAL Project; the tab is
            // selected before the code runs, so the two agree at the start, but only a local lets
            // the code ASSERT which project it is writing. The function shapes take it as a
            // parameter; the script shape gets a `const` in the eval's own lexical scope (indirect
            // eval hosts lexical declarations in its own environment, so nothing leaks).
            const project = ctx.project;
            // GAME rides in beside it, from the session record (TODO.md 1.9). Same argument one
            // dimension over: the older plugins carried a hardcoded 25599, which since per-project
            // ports names the toolkit's own game and not the one this session drives. A session the
            // shim never told (a plugin driven by hand, curl) gets null, and a plugin handed null
            // REFUSES rather than dialling a plausible default.
            const game = (ctx.session && ctx.session.game) || null;
            // Three shapes, tried in order, and the code runs ONCE: an expression (wrapped in a return,
            // so `await` works inside it); statements, whose LAST value is the answer the way the old
            // plugin's eval answered (`let t = Texture.all[0]; t.name`) - a script, so a parse failure
            // is a SyntaxError reply and nothing ran; a body with its own `return` or a top-level
            // `await`, which only a function can host (live, 2026-09-07: a two-statement body without
            // `return` answered null).
            const AsyncFunction = Object.getPrototypeOf(async function () { }).constructor;
            let expr = null;
            try { expr = new AsyncFunction('PROJECT', 'GAME', 'return (' + args.code + '\n)'); } catch (e) { expr = null; }
            let value;
            if (expr) value = expr(project, game);
            else if (!/\breturn\b|\bawait\b/.test(args.code)) {
                globalThis.__mcptkEvalProject = project;
                globalThis.__mcptkEvalGame = game;
                try {
                    value = (0, eval)('const PROJECT = globalThis.__mcptkEvalProject;\n'
                        + 'const GAME = globalThis.__mcptkEvalGame;\n' + args.code);
                } finally { delete globalThis.__mcptkEvalProject; delete globalThis.__mcptkEvalGame; }
            } else value = new AsyncFunction('PROJECT', 'GAME', args.code)(project, game);
            if (value && typeof value.then === 'function') value = await value;
            let json;
            try { json = JSON.parse(JSON.stringify(value === undefined ? null : value)); } catch (e) { json = String(value); }
            return { value: json };
        },
    });

    tool({
        name: 'trigger_action', mechanism: EDIT,
        description: 'Trigger a Blockbench action by its BarItems id (e.g. "select_all", "delete", "screenshot_model").',
        inputSchema: { type: 'object', properties: { project: PROJECT_ARG, id: { type: 'string' } }, required: ['id'], additionalProperties: false },
        run(args) {
            const a = typeof BarItems !== 'undefined' ? BarItems[args.id] : null;
            if (!a) fail('no action "' + args.id + '"');
            if (typeof a.trigger === 'function') a.trigger(); else if (typeof a.click === 'function') a.click(); else fail('"' + args.id + '" is not triggerable');
            return { triggered: args.id };
        },
    });

    tool({
        name: 'animation', mechanism: EDIT,
        description: 'Keyframe animation (live-verified on a modded_entity rig 2026-09-07). op:list; create {name, length, loop:"once"|"loop"|"hold"}; remove {name}; select {name}; keyframes {name, bone, channel:"rotation"|"position"|"scale", keyframes:[{time, value:[x,y,z], interpolation?}]} adds keyframes (replace:true clears the channel first); time {seconds} scrubs the timeline so a capture shows that pose.',
        inputSchema: {
            type: 'object',
            properties: {
                op: { type: 'string', enum: ['list', 'create', 'remove', 'select', 'keyframes', 'time'] },
                project: PROJECT_ARG, name: { type: 'string' }, length: { type: 'number' }, loop: { type: 'string', enum: ['once', 'loop', 'hold'] },
                bone: { type: 'string' }, channel: { type: 'string', enum: ['rotation', 'position', 'scale'] },
                keyframes: { type: 'array', items: { type: 'object', properties: { time: { type: 'number' }, value: V3, interpolation: { type: 'string', enum: ['linear', 'catmullrom', 'step', 'bezier'] } }, required: ['time', 'value'], additionalProperties: false } },
                replace: { type: 'boolean' }, seconds: { type: 'number' }, look: LOOK_ARG,
            },
            required: ['op'], additionalProperties: false,
        },
        run(args, ctx) {
            if (typeof Animation === 'undefined') fail('this format has no animations');
            const all = Animation.all || [];
            const find = () => { const a = all.find((x) => x.name === args.name || x.uuid === args.name); if (!a) fail('no animation "' + args.name + '" (have: ' + all.map((x) => x.name).join(', ') + ')'); return a; };
            const describe = (a) => ({
                name: a.name, length: a.length, loop: a.loop, selected: !!a.selected,
                bones: Object.keys(a.animators || {}).map((k) => { const an = a.animators[k]; return { bone: an.name || k, rotation: (an.rotation || []).length, position: (an.position || []).length, scale: (an.scale || []).length }; }),
            });
            switch (args.op) {
                case 'list': ctx.mechanism = OBSERVE; return { animations: all.map(describe) };
                case 'create': {
                    if (!args.name) fail('create needs name');
                    const a = undoEdit({ animations: [] }, 'animation create', (aspects) => {
                        const made = new Animation({ name: args.name, length: args.length || 1, loop: args.loop || 'once' });
                        made.add(false);
                        made.select();
                        aspects.animations.push(made);
                        return made;
                    });
                    return describe(a);
                }
                case 'remove': { const a = find(); const n = a.name; undoEdit({ animations: [a] }, 'animation remove', () => a.remove(false)); return { removed: n }; }
                case 'select': { const a = find(); a.select(); return describe(a); }
                case 'keyframes': {
                    const a = find();
                    if (!args.bone || !args.channel || !args.keyframes) fail('keyframes needs bone, channel and keyframes');
                    const g = findGroup(args.bone);
                    // Blockbench's createKeyframe ends with Animation.selected.setLength() whatever animation
                    // the keyframe went into: an unselected target is a null dereference (live, 2026-09-07).
                    if (Animation.selected !== a) a.select();
                    const animator = a.getBoneAnimator(g);
                    if (!animator) fail('no animator for bone "' + g.name + '"');
                    if (!animator[args.channel]) fail('bone "' + g.name + '" has no ' + args.channel + ' channel');
                    // One undo entry: the channel's existing keyframes go in first (replace removes them), the
                    // new ones are pushed as they are made (live, 2026-09-07: without this, undo had nothing).
                    const made = undoEdit({ animations: [a], keyframes: (animator[args.channel] || []).slice() }, 'animation keyframes', (aspects) => {
                        if (args.replace) for (const kf of (animator[args.channel] || []).slice()) kf.remove();
                        const times = [];
                        for (const k of args.keyframes) {
                            const kf = animator.createKeyframe({ x: k.value[0], y: k.value[1], z: k.value[2] }, k.time, args.channel, false, false);
                            if (kf && k.interpolation) kf.interpolation = k.interpolation;
                            if (kf) aspects.keyframes.push(kf);
                            times.push(k.time);
                        }
                        return times;
                    });
                    return { animation: a.name, bone: g.name, channel: args.channel, added: made, total: (animator[args.channel] || []).length, undo: 'one entry' };
                }
                case 'time': {
                    ctx.mechanism = OBSERVE;
                    if (!isNum(args.seconds)) fail('time needs seconds');
                    if (typeof Timeline !== 'undefined' && Timeline.setTime) Timeline.setTime(args.seconds);
                    if (typeof Animator !== 'undefined' && Animator.preview) Animator.preview();
                    return { time: args.seconds };
                }
                default: fail('unknown op');
            }
        },
    });

    // ------------------------------------------------------------------ dispatch
    const BY_NAME = {};
    for (const t of TOOLS) BY_NAME[t.name] = t;
    /** Tools that need no open project. Everything else refuses without one, naming the fix. */
    const NO_PROJECT = { project: true };

    function manifest() {
        return TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, mechanism: t.mechanism }));
    }

    let chain = Promise.resolve();
    function enqueue(fn) {
        const run = () => fn();
        const p = chain.then(run, run);
        chain = p.then(() => undefined, () => undefined);
        return p;
    }

    async function perform(name, args, sessionBlock) {
        const def = BY_NAME[name];
        if (!def) return { ok: false, error: 'unknown tool "' + name + '"', hint: 'GET /tools lists ' + TOOLS.length };
        const started = now();
        let sess = null;
        try {
            checkArgs(def.inputSchema, args || {}, name);
            sess = session(sessionBlock);
            reapSessions();
            const ctx = { session: sess, mechanism: def.mechanism };
            let projectBlock = null;
            if (!NO_PROJECT[name]) {
                projectBlock = resolveProject(args || {}, sess, true);
                ctx.project = projectBlock.project;
                if (def.mechanism === EDIT) guardHeld(ctx.project, sess);
            }
            let result = await def.run(args || {}, ctx);
            if (result === undefined || result === null) result = {};
            if (typeof result !== 'object') result = { value: result };
            if (projectBlock) {
                const pb = { name: projectBlock.name, bound: projectBlock.bound };
                if (projectBlock.note) pb.note = projectBlock.note;
                result.project = pb;
            }
            const shared = sharedIdNote(sess);
            if (shared) result.session = shared;
            if (args && args.look && !result._image) {
                try { const r = renderViewport(); result._image = imageOf(r.url, true); result.look = [r.width, r.height]; } catch (e) { result.look_error = e.message; }
            }
            result.ms = now() - started;
            noteCall(name, true, result.ms, sess);
            return { ok: true, result, mechanism: ctx.mechanism };
        } catch (e) {
            const out = { ok: false, error: String(e && e.message ? e.message : e) };
            if (e && e.hint) out.hint = e.hint;
            noteCall(name, false, now() - started, sess);
            return out;
        }
    }
    function call(name, args, sessionBlock) {
        return enqueue(() => perform(name, args, sessionBlock));
    }

    // ------------------------------------------------------------------ transport
    let server = null;
    let httpModule = null;
    let lastError = null;
    function nativeHttp(prompt) {
        if (httpModule) return httpModule;
        if (typeof requireNativeModule !== 'function') throw new Error('requireNativeModule is unavailable (not the desktop app?)');
        const proc = requireNativeModule('process', {
            message: 'The MCP Toolkit Bridge hosts a local HTTP server for agent sessions and needs `process` to reach Node\'s http module. Nothing leaves this machine.',
            show_permission_dialog: prompt !== false,
        });
        if (!proc) return null;
        if (typeof proc.getBuiltinModule !== 'function') throw new Error('process.getBuiltinModule is missing (Node ' + (proc.versions && proc.versions.node) + ')');
        httpModule = proc.getBuiltinModule('http');
        return httpModule;
    }
    function readBody(req) {
        return new Promise((resolve, reject) => {
            let size = 0;
            const chunks = [];
            req.on('data', (d) => { size += d.length; if (size > BODY_LIMIT) { reject(new Error('body over ' + BODY_LIMIT + ' bytes')); req.destroy(); } else chunks.push(d); });
            req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            req.on('error', reject);
        });
    }
    function answer(res, status, obj) {
        const body = JSON.stringify(obj);
        res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
        res.end(body);
    }
    /**
     * GET /hello, which is now also the answer to "whose window is this?" - the window block is what
     * a scanning shim reads to decide between claiming this one, rejoining it, and leaving it alone.
     */
    function hello() {
        reapSessions();
        return Object.assign({
            ok: true, app: 'blockbench', version: typeof Blockbench !== 'undefined' ? Blockbench.version : null,
            plugin: PLUGIN_ID, plugin_version: PLUGIN_VERSION,
            projects: projects().length, active: activeProject() ? activeProject().name : null,
            sessions: Object.keys(sessions).filter((id) => alive(sessions[id])).length, tools: TOOLS.length,
        }, windowBlock(), stateBlock());
    }
    /**
     * GET /presence: a response that never ends. The shim opens one per process and holds it; the
     * session it names is alive for exactly as long as the socket is, and its binding is released
     * the moment the socket closes - a process that exited is gone at once, not "seen 15s ago" for
     * two minutes (ArmorPieces, 2026-09-07: a dead child's binding refused the human's own cleanup
     * call). The hold timer stays for clients that never open one. The first line answers what the
     * plugin sees (the connection count is the shared-id signal); after that a newline every
     * PRESENCE_BEAT_MS keeps intermediaries from closing an idle socket.
     */
    const presence = new Set();
    function holdPresence(req, res, sid) {
        if (!sid) return answer(res, 400, { ok: false, error: 'GET /presence needs the X-MCPTK-Session header' });
        const s = session({ id: String(sid), client: req.headers['x-mcptk-client'], profile: req.headers['x-mcptk-profile'] });
        const sock = req.socket;
        s.connections.add(sock);
        presence.add(res);
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'Connection': 'keep-alive' });
        res.write(JSON.stringify({ ok: true, session: s.id, connections: s.connections.size, project: (projects().find((p) => p.uuid === s.project) || {}).name || null }) + '\n');
        const beat = setInterval(() => { try { res.write('\n'); } catch (e) { /* the close below follows */ } }, PRESENCE_BEAT_MS);
        if (beat.unref) beat.unref();
        let done = false;
        const release = () => {
            if (done) return;
            done = true;
            clearInterval(beat);
            presence.delete(res);
            s.connections.delete(sock);
            // The last connection gone is the process gone: the binding AND the record. A record
            // kept "seen just now" would be exactly the fresh timestamp for a dead id that ask 2
            // named; a shim whose presence dropped while it lives (Stop/Start by hand) is
            // re-registered by its next request, unbound, and told so.
            if (!connected(s)) { s.project = null; if (sessions[s.id] === s) delete sessions[s.id]; releaseDeadClaim(); armEmptyCheck(); }
        };
        sock.on('close', release);
        res.on('close', release);
        res.on('error', release);
    }
    async function handle(req, res) {
        const url = (req.url || '/').split('?')[0];
        const sid = req.headers['x-mcptk-session'];
        // A SCAN IS NOT A SESSION (section 11.3e). Registering every id that merely carried a header
        // meant `GET /hello` did it - and every shim sends that to every port in the range every time
        // it looks for a window. Window 25804 was found holding ELEVEN session records, all left by
        // shims that had only ever scanned past it, and `sessions` is exactly the number a person
        // reads to decide whether a window is abandoned. A POST, or the presence socket, is a session
        // doing something here; a look is not.
        if (sid && (req.method === 'POST' || url === '/presence')) session({ id: String(sid), client: req.headers['x-mcptk-client'], profile: req.headers['x-mcptk-profile'] });
        if (req.method === 'GET' && (url === '/hello' || url === '/')) return answer(res, 200, hello());
        if (req.method === 'GET' && url === '/tools') return answer(res, 200, manifest());
        if (req.method === 'GET' && url === '/presence') return holdPresence(req, res, sid);
        if (req.method === 'POST' && (url === '/claim' || url === '/window')) {
            let body;
            try { body = JSON.parse((await readBody(req)) || '{}'); } catch (e) { return answer(res, 400, { ok: false, error: 'bad JSON: ' + e.message }); }
            const sb = typeof body.session === 'string' ? { id: body.session } : (body.session || (sid ? { id: String(sid) } : null));
            if (!sb || !sb.id) return answer(res, 400, { ok: false, error: 'POST ' + url + ' needs {session:{id}} or the X-MCPTK-Session header' });
            // A refusal is 200 with ok:false, as POST /cmd's is: the shim reads the envelope, and a
            // claim it did not win is an ordinary answer, not a transport failure.
            return answer(res, 200, url === '/claim' ? claimWindow(sb, body) : openWindow(sb));
        }
        if (req.method === 'GET' && url === '/dock') {
            return answer(res, isDock ? 200 : 404, isDock ? dockRoster()
                : { ok: false, error: 'this window is not the MCP Dock', role: role(), dock_port: isNumLike(settings.dock_port) ? settings.dock_port : null });
        }
        if (req.method === 'POST' && (url === '/close' || url === '/focus' || url === '/role'
            || url === '/dock/hello' || url === '/dock/beat' || url === '/dock/window' || url === '/dock/close')) {
            let body;
            try { body = JSON.parse((await readBody(req)) || '{}'); } catch (e) { return answer(res, 400, { ok: false, error: 'bad JSON: ' + e.message }); }
            // Every window serves these three for whoever asks, because a plugin cannot reach into
            // another window and do any of them TO it (section 11.4).
            if (url === '/close') return answer(res, 200, closeSelf(body.force));
            if (url === '/focus') return answer(res, 200, focusSelf());
            if (url === '/role') return answer(res, 200, setRole(body));
            // The rest are the dock's. A 404 is how a window that is not the dock says so, and it is
            // what heals a `dock_port` left behind by a crash.
            if (!isDock) {
                return answer(res, 404, { ok: false, error: 'this window is not the MCP Dock', role: role(),
                    dock_port: isNumLike(settings.dock_port) ? settings.dock_port : null });
            }
            if (url === '/dock/hello') return answer(res, 200, dockHello(body));
            if (url === '/dock/beat') return answer(res, 200, dockBeat(body));
            if (url === '/dock/window') return answer(res, 200, await dockAllocate(body));
            return answer(res, 200, await dockClose(body));
        }
        if (req.method === 'POST' && url === '/cmd') {
            let body;
            try { body = JSON.parse((await readBody(req)) || '{}'); } catch (e) { return answer(res, 400, { ok: false, error: 'bad JSON: ' + e.message }); }
            if (!body.tool) return answer(res, 400, { ok: false, error: 'POST /cmd needs {tool, args, session}' });
            // A plain string is an id (a curl by hand); the shim sends the {id, client, profile} block.
            const sb = typeof body.session === 'string' ? { id: body.session } : (body.session || (sid ? { id: String(sid) } : null));
            const out = await call(body.tool, body.args || {}, sb);
            return answer(res, 200, out);
        }
        answer(res, 404, { ok: false, error: 'no route ' + req.method + ' ' + url,
            routes: ['GET /hello', 'GET /tools', 'GET /presence', 'POST /cmd', 'POST /claim', 'POST /window',
                'POST /close', 'POST /focus', 'POST /role',
                'GET /dock', 'POST /dock/hello', 'POST /dock/beat', 'POST /dock/window', 'POST /dock/close'] });
    }
    /**
     * Listen on the first free port at or above the base, and remember which one that was: the port
     * a window wins is the window's NAME (design section 6.3), which is the whole of the discovery
     * protocol on this side. Before this, a second window loaded a second copy of the plugin, tried
     * the one stored port, failed with EADDRINUSE into a field nobody reads, and served nothing.
     *
     * The listen is asynchronous and so, therefore, is the scan: `starting` is what keeps a second
     * start() out while it walks, and `server` is only set once a socket is actually bound - so
     * `status().listening` stays the honest answer to "is there a door" throughout.
     */
    let starting = false;
    /**
     * Which walk is current. The listen is asynchronous, so a `stop()` (or a second `start()`) while
     * the scan is still walking has nothing to cancel - and without this the pending listen callback
     * would fire AFTERWARDS, set `server`, and leave a window serving on a port after the person at
     * the keyboard asked it to stop. Each walk carries the generation it began in and gives up the
     * moment that is no longer the current one.
     */
    let generation = 0;
    function start(opts) {
        opts = opts || {};
        if (server || starting) return status();
        let http;
        try { http = nativeHttp(opts.prompt); } catch (e) { lastError = e.message; return status(); }
        if (!http) { lastError = 'permission for `process` not granted yet: Tools > MCP Toolkit Bridge > Start asks for it'; return status(); }
        const base = (typeof settings.port === 'number' && Number.isInteger(settings.port) && settings.port >= 0 && settings.port < 65536) ? settings.port : DEFAULT_PORT;
        // Port 0 is "any free port" and has no neighbours to walk to (the harness uses it).
        const span = base === 0 ? 1 : PORT_SPAN;
        starting = true;
        const mine = ++generation;
        let i = 0;
        const attempt = () => {
            const s = http.createServer((req, res) => { handle(req, res).catch((e) => { try { answer(res, 500, { ok: false, error: String(e && e.message || e) }); } catch (e2) { /* gone */ } }); });
            const onError = (e) => {
                s.removeListener('error', onError);
                try { s.close(); } catch (e2) { /* never listened */ }
                if (generation !== mine) return;
                if (e && e.code === 'EADDRINUSE' && i + 1 < span) { i++; attempt(); return; }
                starting = false;
                lastError = e && e.code === 'EADDRINUSE'
                    ? 'every port from ' + base + ' to ' + (base + span - 1) + ' is taken - that many windows are already serving, or something else has the range'
                    : String(e && e.message || e);
            };
            s.on('error', onError);
            s.listen(base + i, '127.0.0.1', () => {
                s.removeListener('error', onError);
                // Stopped (or restarted) while this walk was in flight: the port it just won belongs
                // to nobody. Give it back rather than becoming a door the caller believes is shut.
                if (generation !== mine) { try { s.close(); } catch (e2) { /* never listened */ } return; }
                // A later error is not a failed listen: record it, but do not throw the live door away.
                s.on('error', (e) => { lastError = String(e && e.message || e); });
                const addr = s.address();
                server = s;
                boundPort = (addr && addr.port) || (base + i);
                starting = false;
                lastError = null;
                applyShare();
                // A port is what a shim comes looking for, so the identity somebody left for this
                // window is taken the moment there is one to find - not at onload, which runs before
                // the walk and would let a second window take the first one's handoff.
                adoptPending();
                refreshIdentity();
                // The dock is asked what this window is the moment there is a port to be told about,
                // and its answer OUTRANKS the handoff above (section 11.7) - which is what makes a
                // role something that can be corrected later rather than guessed once at boot.
                if (!isDock) { startBeat(); Promise.resolve(findDock()).catch(() => { /* the beat retries */ }); }
            });
        };
        attempt();
        return status();
    }
    function stop() {
        // Presence responses never end on their own; a server.close() would wait on them forever.
        for (const res of [...presence]) { try { res.destroy(); } catch (e) { /* gone */ } }
        if (server) { try { if (server.closeAllConnections) server.closeAllConnections(); server.close(); } catch (e) { /* closing */ } server = null; }
        // Cancels a port walk still in flight: its listen callback checks the generation and gives
        // the port back rather than quietly becoming a live door after a stop.
        generation++;
        starting = false;
        boundPort = null;
        // A window with no door owns nothing: whoever claimed it must be free to find another.
        claimedBy = null;
        // ...and a window nobody can find is not one to close automatically either: a person who
        // stopped the bridge is still sitting in front of it.
        stopSweep();
        stopBeat();
        stopDockScan();
        dockPort = null;
        // A dock with no door is not the dock: the stored port would send every window looking at one
        // that cannot answer, and each of them would scan the whole range for nothing.
        if (isDock && settings.dock_port === boundPort) saveSettings({ dock_port: null });
        refreshIdentity();
        return status();
    }
    function status() {
        const st = Object.assign({ plugin: PLUGIN_ID, version: PLUGIN_VERSION, listening: !!server && !!(server.address && server.address()) },
            windowBlock(),
            { url: boundPort ? 'http://127.0.0.1:' + boundPort : null, tools: TOOLS.length, sessions: Object.keys(sessions).length, connections: presence.size });
        if (starting) st.starting = true;
        if (lastError) st.error = lastError;
        if (!st.listening && !httpModule) st.needs = 'the `process` permission (Tools > MCP Toolkit Bridge > Start)';
        return st;
    }

    // ------------------------------------------------------------------ the plugin
    let actions = [];
    function menu() {
        const add = (id, name, icon, click) => { const a = new Action(id, { name, icon, description: name, click }); MenuBar.addAction(a, 'tools'); actions.push(a); };
        add('mcptoolkit_bridge_start', 'MCP Toolkit Bridge: Start', 'power', () => {
            const st = start({ prompt: true });
            Blockbench.showQuickMessage(st.listening ? 'MCP Toolkit Bridge listening on ' + st.url : 'MCP Toolkit Bridge: ' + (st.error || st.needs || 'starting...'), 3000);
            setTimeout(() => { const s2 = status(); if (s2.listening) Blockbench.showQuickMessage('MCP Toolkit Bridge listening on ' + s2.url, 2000); }, 500);
        });
        add('mcptoolkit_bridge_stop', 'MCP Toolkit Bridge: Stop', 'power_off', () => { stop(); Blockbench.showQuickMessage('MCP Toolkit Bridge stopped', 2000); });
        // A person's window needs no protecting since 0.7.0 - it is theirs unless an agent asked for
        // it (design section 10) - so what the menu carries now is the opposite and rarer act: handing
        // THIS window over. Stored as the port, because settings are one store every window shares.
        add('mcptoolkit_bridge_share', 'MCP Toolkit Bridge: Let agents use this window', 'group_add', () => {
            setAllowAgents(undefined, true);
            Blockbench.showQuickMessage(allowAgents
                ? 'MCP Toolkit Bridge: agent sessions may claim this window - they will switch the active tab to their own work'
                + (boundPort ? ' (port ' + boundPort + ', remembered across restarts)' : '')
                : 'MCP Toolkit Bridge: this window is yours again', 4000);
        });
        // THE DOCK (section 11). Two entries because they answer two different situations: the
        // ordinary one is "give me the window that shows me all the others", and the other is a person
        // who already has an empty window in front of them and would rather spend that one than a
        // seventh. Neither is reachable over HTTP - a dock is a window a PERSON asked for.
        add('mcptoolkit_bridge_open_dock', 'MCP Toolkit Bridge: Open the MCP Dock', 'dock', () => {
            Promise.resolve(openDock()).then((out) => {
                Blockbench.showQuickMessage(out.ok ? 'MCP Toolkit Bridge: opening the MCP Dock' : 'MCP Toolkit Bridge: ' + out.error, 3500);
            }).catch((e) => Blockbench.showQuickMessage('MCP Toolkit Bridge: ' + String(e && e.message || e), 3000));
        });
        add('mcptoolkit_bridge_become_dock', 'MCP Toolkit Bridge: Make this window the MCP Dock', 'hub', () => {
            if (isDock) { Blockbench.showQuickMessage('MCP Toolkit Bridge: this window already is the MCP Dock', 2500); return; }
            if (!boundPort) { Blockbench.showQuickMessage('MCP Toolkit Bridge: start the bridge in this window first', 3000); return; }
            becomeDock();
            Blockbench.showQuickMessage('MCP Toolkit Bridge: this window is the MCP Dock (port ' + boundPort + '). It will not be claimed and will not close itself.', 5000);
        });
        add('mcptoolkit_bridge_status', 'MCP Toolkit Bridge: Status', 'info', () => {
            const st = status();
            Blockbench.showMessageBox({ title: 'MCP Toolkit Bridge', message: JSON.stringify(st, null, 2) + '\n\nSessions: ' + JSON.stringify(Object.keys(sessions).map((id) => ({ id, client: sessions[id].client, project: (projects().find((p) => p.uuid === sessions[id].project) || {}).name || null, connections: sessions[id].connections.size, seen_s_ago: Math.round((now() - sessions[id].seen) / 1000) })), null, 2) });
        });
        add('mcptoolkit_bridge_settings', 'MCP Toolkit Bridge: Settings', 'settings', () => {
            new Dialog({
                id: 'mcptoolkit_bridge_settings', title: 'MCP Toolkit Bridge',
                form: { port: { label: 'First port to scan (this window takes the first free one; the shim scans the same ' + PORT_SPAN + ')', type: 'number', value: settings.port }, autostart: { label: 'Start when Blockbench opens', type: 'checkbox', value: settings.autostart } },
                onConfirm(form) {
                    saveSettings({ port: Number(form.port) || DEFAULT_PORT, autostart: !!form.autostart });
                    if (server) { stop(); start({ prompt: true }); }
                    Blockbench.showQuickMessage('MCP Toolkit Bridge: scanning from port ' + settings.port, 2000);
                },
            }).show();
        });
    }

    // ------------------------------------------------------------------ crash-recovery guard
    /**
     * Closing ANY Blockbench window clears the WHOLE shared backup store, so one session quitting
     * destroys another window's crash recovery. Measured 2026-09-08, alternating trials: three
     * unpatched closes out of three destroyed a canary belonging to another window; this guard
     * preserved it two out of two (`BLOCKBENCH_ISOLATION_DESIGN.md` section 8).
     *
     * Why it is shaped this way, all verified in the running renderer: `window.AutoBackup` IS the
     * object every internal caller holds and `closeBlockbenchWindow` looks the method up at CALL
     * time, so replacing the method reaches them all; `closeBlockbenchWindow` itself is module-scoped
     * after esbuild and cannot be patched; `before_closing` fires THIRTEEN LINES AFTER the wipe, so
     * it is useless here. `window.onbeforeunload` is the sole origin of every path into the close,
     * which makes it the one reliable "we are quitting" flag - and the flag is needed because the
     * start screen's Discard button is a legitimate caller of a real full clear.
     */
    let backupGuard = null;
    function installBackupGuard() {
        if (backupGuard) return backupGuard;
        if (typeof AutoBackup === 'undefined' || !AutoBackup || typeof AutoBackup.removeAllBackups !== 'function') return null;
        const guard = {
            quitting: false,
            removeAllBackups: AutoBackup.removeAllBackups,
            onbeforeunload: typeof window !== 'undefined' ? window.onbeforeunload : undefined,
        };
        if (typeof window !== 'undefined') {
            window.onbeforeunload = function (...a) {
                guard.quitting = true;
                let out;
                try {
                    out = typeof guard.onbeforeunload === 'function' ? guard.onbeforeunload.apply(this, a) : undefined;
                } catch (e) { guard.quitting = false; throw e; }
                // AND IT UN-LATCHES when the close was CANCELLED. Blockbench's own handler answers
                // `true` for unsaved work - the unload is called off and its dialog takes over, and
                // the person may well click Cancel - `false` when `closeBlockbenchWindow` is already
                // on its way, and `undefined` once `allow_closing` is set. Only the first of those
                // three is "not quitting after all", and without this the flag stayed true forever,
                // so a later legitimate full clear (the start screen's Discard) silently became a
                // partial one (section 11.11).
                if (out === true) guard.quitting = false;
                return out;
            };
        }
        AutoBackup.removeAllBackups = async function (...a) {
            if (!guard.quitting) return guard.removeAllBackups.apply(this, a);
            // Quitting: this window's projects only. Another window's entries are not ours to drop.
            const mine = (typeof ModelProject !== 'undefined' && ModelProject.all ? ModelProject.all : []).map((x) => x.uuid);
            if (typeof AutoBackup.removeBackup !== 'function') return guard.removeAllBackups.apply(this, a);
            for (const uuid of mine) { try { await AutoBackup.removeBackup(uuid); } catch (e) { /* one entry, keep going */ } }
            return undefined;
        };
        backupGuard = guard;
        return guard;
    }
    function removeBackupGuard() {
        if (!backupGuard) return;
        if (typeof AutoBackup !== 'undefined' && AutoBackup) AutoBackup.removeAllBackups = backupGuard.removeAllBackups;
        if (typeof window !== 'undefined') window.onbeforeunload = backupGuard.onbeforeunload;
        backupGuard = null;
    }

    Plugin.register(PLUGIN_ID, {
        title: 'MCP Toolkit: Bridge',
        author: 'mattmc',
        description: 'The MCP toolkit\'s own door into Blockbench: a local HTTP bridge with session-bound projects, a queue, and an argument-checked tool surface. Replaces the third-party Blockbench MCP plugin as the toolkit shim\'s upstream.',
        icon: 'hub',
        version: PLUGIN_VERSION,
        variant: 'desktop',
        onload() {
            loadSettings();
            globalThis.mcptoolkitBridge = {
                start, stop, status, manifest, call, settings: (patch) => (patch ? saveSettings(patch) : loadSettings()), sessions: () => sessions,
                window: () => windowBlock(),
                claim: (sb, opts) => claimWindow(sb, opts),
                share: (v, persist) => setAllowAgents(v, persist),
                adopt: () => adoptPending(),
                sweep: () => sweep(),
                role: () => role(),
                dock: () => (isDock ? dockRoster() : { ok: false, error: 'not the dock', dock_port: settings.dock_port }),
                openDock: () => openDock(),
                becomeDock: () => becomeDock(),
                resignDock: (to) => resignDock(to),
                whereIsDock: () => whereIsDock(),
                closeSelf: (force) => closeSelf(force),
                setRole: (r, claimFor) => setRole({ role: r, claim_for: claimFor }),
                findDock: () => findDock(),
                beat: () => beat(),
                dockPort: () => dockPort,
                scan: () => dockScan(),
                recent: () => recent.slice(),
            };
            if (typeof Action === 'function' && typeof MenuBar !== 'undefined') menu();
            installBackupGuard();
            watchTitle();
            makePanel();
            if (settings.autostart) start({ prompt: false });
        },
        onunload() {
            stop();
            stopSweep();
            stopBeat();
            stopDockScan();
            unwatchTitle();
            removePanel();
            removeDockPanel();
            removeBackupGuard();
            delete globalThis.mcptoolkitBridge;
            for (const a of actions) { try { a.delete(); } catch (e) { /* gone */ } }
            actions = [];
        },
    });
})();
