// Regression harness for mcptoolkit_bridge.js: a Blockbench-shaped stub world, the plugin loaded
// into it, and its headless half exercised end to end - argument checking, session binding and
// holds, the queue, every tool's arithmetic (face rectangles, envelopes, overlaps, UV collisions,
// the painters, the ASCII reader, resize/recolor/flip), pictures as real PNGs, `risky_eval` (with
// PROJECT in its scope), the HTTP transport over Node's own http module, and presence: a binding
// that lives exactly as long as its GET /presence socket, and the note a shared session id earns.
// Modelled on mcptoolkit_entity.test.mjs.
//
//   cd mcp-toolkit/blockbench && node mcptoolkit_bridge.test.mjs            # run
//   node mcptoolkit_bridge.test.mjs --write-fixture                          # refresh the shim's capture
//
// What it cannot reach, and says so (BLOCKBENCH_BRIDGE_DESIGN.md section 11): Blockbench's own
// behaviour behind the stubs - `ModelProject.select()`, `Cube.mapAutoUV()`, `Texture.edit()`,
// `Preview.render()`, `loadModelFile`, the permission dialog. The stub answers those the way the
// app's readable source says it does, and the live arm is what proves it.
//
// THE FIXTURE. The shim's probe (mcp-server/probes/blockbench-surface.test.mjs) pins the plugin's
// manifest at probes/fixtures/blockbench-bridge-<date>.json. This harness asserts the pinned
// capture IS the current manifest, so a tool added here without re-pinning is a red here rather
// than a probe that quietly tests last month's surface.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import vm from 'node:vm';
import http from 'node:http';
import { createRequire } from 'node:module';
import { encodePng, decodePng } from '../../mcp-server/image/png.mjs';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
// MCPTK_PLUGIN_PATH points the harness at ANOTHER copy of the plugin - the one from the previous
// release, extracted with `git show HEAD:...` - which is how a new check is proved to be a falsifier
// (isolation record 12.8, 13.3): it must go red there and green here, or it tests nothing.
const PLUGIN = process.env.MCPTK_PLUGIN_PATH ? path.resolve(process.env.MCPTK_PLUGIN_PATH) : path.join(HERE, 'mcptoolkit_bridge.js');
// The shipped range of a REAL Blockbench (25801 and the fifteen ports above it). A harness that
// scans it registers test processes in the developer's own dock (seen 2026-09-12), so every
// outbound request the plugin makes from this world is refused there - whichever plugin version is
// loaded, since the older ones folded port 0 to that base (`scanBase`).
const REAL_RANGE = /^https?:\/\/(127\.0\.0\.1|localhost):258(0[1-9]|1[0-6])(\/|$)/i;
const FIXTURE = path.join(HERE, '..', '..', 'mcp-server', 'probes', 'fixtures', 'blockbench-bridge-2026-09-07.json');
const WRITE_FIXTURE = process.argv.includes('--write-fixture');

let failures = 0;
let count = 0;
const ok = (name, cond, detail) => {
    count++;
    console.log((cond ? '  ok   ' : '  FAIL ') + name + (cond ? '' : '  <- ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))));
    if (!cond) failures++;
};
const section = (t) => console.log('\n== ' + t);

// =============================================================================================
// 1. A canvas that is a Uint8ClampedArray, and an Image that decodes what toDataURL encodes.
// =============================================================================================
function parseCss(c) {
    const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(c);
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 255 : Math.round(Number(m[4]) * 255)];
    const h = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c);
    if (h) return [parseInt(h[1].slice(0, 2), 16), parseInt(h[1].slice(2, 4), 16), parseInt(h[1].slice(4, 6), 16), h[2] ? parseInt(h[2], 16) : 255];
    return [0, 0, 0, 255];
}
class FakeCanvas {
    constructor(w = 16, h = 16) { this._w = w; this._h = h; this.data = new Uint8ClampedArray(w * h * 4); this._ctx = null; }
    get width() { return this._w; }
    set width(v) { this._w = v; this.data = new Uint8ClampedArray(this._w * this._h * 4); }
    get height() { return this._h; }
    set height(v) { this._h = v; this.data = new Uint8ClampedArray(this._w * this._h * 4); }
    getContext() { return this._ctx || (this._ctx = new FakeCtx(this)); }
    toDataURL() { return 'data:image/png;base64,' + encodePng({ width: this._w, height: this._h, data: this.data }).toString('base64'); }
}
class FakeCtx {
    constructor(c) { this.canvas = c; this.fillStyle = '#000000'; this.imageSmoothingEnabled = true; this.font = ''; }
    getImageData(x, y, w, h) {
        const out = new Uint8ClampedArray(w * h * 4);
        for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
            const sx = x + xx, sy = y + yy;
            if (sx < 0 || sy < 0 || sx >= this.canvas._w || sy >= this.canvas._h) continue;
            const s = (sy * this.canvas._w + sx) * 4, d = (yy * w + xx) * 4;
            out.set(this.canvas.data.subarray(s, s + 4), d);
        }
        return { width: w, height: h, data: out };
    }
    putImageData(img, x, y) {
        for (let yy = 0; yy < img.height; yy++) for (let xx = 0; xx < img.width; xx++) {
            const dx = x + xx, dy = y + yy;
            if (dx < 0 || dy < 0 || dx >= this.canvas._w || dy >= this.canvas._h) continue;
            const s = (yy * img.width + xx) * 4, d = (dy * this.canvas._w + dx) * 4;
            this.canvas.data.set(img.data.subarray(s, s + 4), d);
        }
    }
    fillRect(x, y, w, h) {
        const c = parseCss(this.fillStyle);
        for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
            if (xx < 0 || yy < 0 || xx >= this.canvas._w || yy >= this.canvas._h) continue;
            this.canvas.data.set(c, (yy * this.canvas._w + xx) * 4);
        }
    }
    clearRect(x, y, w, h) {
        for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
            if (xx < 0 || yy < 0 || xx >= this.canvas._w || yy >= this.canvas._h) continue;
            this.canvas.data.fill(0, (yy * this.canvas._w + xx) * 4, (yy * this.canvas._w + xx) * 4 + 4);
        }
    }
    fillText() {}
    drawImage(src, ...a) {
        // (src, dx, dy) | (src, sx, sy, sw, sh, dx, dy, dw, dh) | (src, dx, dy, dw, dh)
        let sx = 0, sy = 0, sw = src.width, sh = src.height, dx, dy, dw, dh;
        if (a.length === 2) { [dx, dy] = a; dw = sw; dh = sh; }
        else if (a.length === 4) { [dx, dy, dw, dh] = a; }
        else { [sx, sy, sw, sh, dx, dy, dw, dh] = a; }
        const sdata = src.data || src.canvas.data;
        const SW = src._w || src.width;
        for (let yy = 0; yy < dh; yy++) for (let xx = 0; xx < dw; xx++) {
            const px = sx + Math.floor(xx * sw / dw), py = sy + Math.floor(yy * sh / dh);
            const tx = dx + xx, ty = dy + yy;
            if (tx < 0 || ty < 0 || tx >= this.canvas._w || ty >= this.canvas._h) continue;
            const s = (py * SW + px) * 4;
            if (sdata[s + 3] === 0) continue;
            this.canvas.data.set(sdata.subarray(s, s + 4), (ty * this.canvas._w + tx) * 4);
        }
    }
}
class FakeImage {
    set src(u) {
        const buf = Buffer.from(u.split(',')[1], 'base64');
        const d = decodePng(buf);
        this.width = d.width; this.height = d.height; this.data = d.data; this.complete = true; this.naturalWidth = d.width; this.naturalHeight = d.height;
        setTimeout(() => this.onload && this.onload(), 0);
    }
}

// =============================================================================================
// 2. The Blockbench-shaped world: projects with their own element and texture lists, swapped on
//    select() exactly as the app swaps its globals, Undo as a history of finishEdit names.
// =============================================================================================
let uuidN = 0;
const uuid = () => 'u' + (++uuidN).toString(36).padStart(4, '0');
const g = {};
class FakeProject {
    constructor(o) {
        this.uuid = uuid(); this.name = o.name || 'project'; this.format = o.format; this.texture_width = 64; this.texture_height = 64;
        this.box_uv = false; this.saved = false; this.save_path = ''; this.selected = false;
        this.elements = []; this.groups = []; this.textures = []; this.root = [];
        this.undo = { history: [], index: 0 };
        this.animations = [];
    }
    select() { if (g.Project) g.Project.selected = false; g.Project = this; this.selected = true; g.Preview.selected.project = this; return true; }
    async close() { const i = g.ModelProject.all.indexOf(this); if (i >= 0) g.ModelProject.all.splice(i, 1); if (g.Project === this) { g.Project = g.ModelProject.all[0] || null; if (g.Project) g.Project.selected = true; } return true; }
}
class Node {
    constructor(o) { Object.assign(this, { name: 'node', origin: [0, 0, 0], rotation: [0, 0, 0], visibility: true }, o); this.uuid = uuid(); this.parent = 'root'; this.selected = false; }
    init() { return this; }
    addTo(parent) {
        const list = this.parent === 'root' ? g.Project.root : this.parent.children;
        const i = list.indexOf(this); if (i >= 0) list.splice(i, 1);
        this.parent = parent;
        (parent === 'root' ? g.Project.root : parent.children).push(this);
        return this;
    }
    extend(o) { Object.assign(this, o); return this; }
    // The app's select(), with NO event, clears the others first (`unselectAllElements([this])`),
    // which is why a loop over it selects only the last node. The stub said otherwise and hid that
    // bug for a version - markAsSelected is the marking half, without the clear.
    select() { g.unselectAllElements([this]); this.markAsSelected(true); return this; }
    markAsSelected() { this.selected = true; if (!g.Outliner.selected.includes(this)) g.Outliner.selected.push(this); return this; }
    remove() {
        const list = this.parent === 'root' ? g.Project.root : this.parent.children;
        const i = list.indexOf(this); if (i >= 0) list.splice(i, 1);
        const e = g.Project.elements.indexOf(this); if (e >= 0) g.Project.elements.splice(e, 1);
        const gi = g.Project.groups.indexOf(this); if (gi >= 0) g.Project.groups.splice(gi, 1);
    }
}
class FakeCube extends Node {
    constructor(o) {
        super(Object.assign({ name: 'cube', from: [0, 0, 0], to: [1, 1, 1], inflate: 0, mirror_uv: false, autouv: 1, uv_offset: [0, 0], box_uv: false }, o));
        this.faces = {};
        for (const f of ['north', 'south', 'east', 'west', 'up', 'down']) this.faces[f] = { uv: [0, 0, 0, 0], texture: false };
    }
    init() { g.Project.elements.push(this); g.Project.root.push(this); return this; }
    applyTexture(t, faces) { for (const f of faces === true ? Object.keys(this.faces) : faces) this.faces[f].texture = t.uuid; }
    setUVMode(box) { this.box_uv = box; }
    mapAutoUV() {
        // A stand-in for Blockbench's box layout: the six faces side by side in a row starting at
        // uv_offset, sized by the cube. Enough to make rectangles distinct and measurable.
        const s = [0, 1, 2].map((i) => this.to[i] - this.from[i]);
        let x = this.uv_offset[0], y = this.uv_offset[1];
        const dims = { north: [s[0], s[1]], south: [s[0], s[1]], east: [s[2], s[1]], west: [s[2], s[1]], up: [s[0], s[2]], down: [s[0], s[2]] };
        for (const f of Object.keys(dims)) { this.faces[f].uv = [x, y, x + dims[f][0], y + dims[f][1]]; x += dims[f][0]; }
    }
    duplicate() { const c = new FakeCube({ name: this.name + '_copy', from: this.from.slice(), to: this.to.slice() }); c.init(); c.addTo(this.parent); return c; }
}
class FakeGroup extends Node {
    constructor(o) { super(Object.assign({ name: 'group' }, o)); this.children = []; }
    init() { g.Project.groups.push(this); g.Project.root.push(this); return this; }
    // Group.select() clears every element AND every group's flag before marking itself; multiSelect
    // is the app's add-to-the-selection path (it marks the children too).
    select() { g.unselectAllElements(); this.multiSelect(); return this; }
    multiSelect() { this.selected = true; for (const c of this.children) c.markAsSelected(true); return this; }
    duplicate() { const c = new FakeGroup({ name: this.name + '_copy' }); c.init(); c.addTo(this.parent); return c; }
}
class FakeTexture {
    constructor(o) { this.uuid = uuid(); this.name = o.name; this.width = o.width || 16; this.height = o.height || 16; this.canvas = new FakeCanvas(16, 16); this.ctx = this.canvas.getContext('2d'); this.selected = false; this.source = ''; }
    add() { g.Project.textures.push(this); return this; }
    // remove(no_update) wraps ITSELF in an undo entry unless told not to - the reason a bare call
    // inside our own undoEdit made two entries for one removal.
    remove(no_update) {
        if (!no_update) g.Undo.initEdit({ textures: [this] });
        const i = g.Project.textures.indexOf(this); if (i >= 0) g.Project.textures.splice(i, 1);
        this.selected = false;
        if (!no_update) g.Undo.finishEdit('Remove texture', { textures: [] });
    }
    updateSource(u) { this.source = u; }
    updateChangesAfterEdit() { this.source = this.canvas.toDataURL(); }
    updateLayerChanges() {}
    getDataURL() { return this.source || this.canvas.toDataURL(); }
    edit(cb, opts) { this.editOpts = opts; cb(this.canvas); this.updateChangesAfterEdit(); }
    fromDataURL(u) { const img = new FakeImage(); img.src = u; this.img = img; this.canvas.width = img.width; this.canvas.height = img.height; this.canvas.data.set(img.data); this.width = img.width; this.height = img.height; }
}
function world() {
    const listeners = {};
    Object.assign(g, {
        console, setTimeout, clearTimeout, setInterval, clearInterval, Buffer, Promise,
        // The window counts its neighbours the way a shim does, over http, because a renderer has no
        // other view of them (`otherWindowsAnswer`). Guarded: a test must not be able to appear in
        // the app it is testing.
        fetch: (u, o) => (REAL_RANGE.test(String(u))
            ? Promise.reject(new Error('refused by the harness: ' + u + ' is in the real Blockbench range'))
            : fetch(u, o)),
        AbortSignal, URL,
        localStorage: { _: {}, getItem(k) { return k in this._ ? this._[k] : null; }, setItem(k, v) { this._[k] = v; } },
        // `title` is what the ownership prefix is written onto; `querySelector` answering null is a
        // renderer with no <title> node, which makes `watchTitle` a no-op and leaves the prefix itself
        // testable on its own.
        document: { title: 'Blockbench', querySelector: () => null, createElement: (t) => (t === 'canvas' ? new FakeCanvas(1, 1) : {}) },
        Image: FakeImage,
        Blockbench: {
            version: '5.1.6-stub',
            showQuickMessage() {}, showMessageBox() {},
            read(paths, opts, cb) { const p = paths[0]; if (!fs.existsSync(p)) return cb([]); const content = opts.readtype === 'image' ? 'data:image/png;base64,' + fs.readFileSync(p).toString('base64') : fs.readFileSync(p, 'utf8'); cb([{ path: p, name: path.basename(p), content }]); },
            writeFile(p, opts, cb) { const c = opts.savetype === 'image' ? Buffer.from(opts.content.split(',')[1], 'base64') : opts.content; fs.writeFileSync(p, c); cb && cb(p); },
        },
        ModelProject: { all: [] },
        Project: null,
        Cube: FakeCube, Group: FakeGroup, Texture: FakeTexture,
        Formats: { java_block: { id: 'java_block', codec: { id: 'java_block', compile: () => '{"elements":[]}' } }, modded_entity: { id: 'modded_entity', codec: { id: 'modded_entity', compile: () => 'class X {}' } } },
        Codecs: { project: { id: 'project', compile: () => JSON.stringify({ meta: { format_version: '4.10' }, name: g.Project.name, elements: g.Project.elements.length }) }, java_block: { id: 'java_block', compile: () => '{"elements":[]}' } },
        newProject(format) { const p = new FakeProject({ name: 'new', format }); g.ModelProject.all.push(p); p.select(); return true; },
        loadModelFile(file) { const p = new FakeProject({ name: file.name.replace(/\.\w+$/, ''), format: g.Formats.java_block }); p.save_path = file.path; g.ModelProject.all.push(p); p.select(); },
        Undo: {
            initEdit(a) { this._pending = a; },
            // Blockbench reads the aspect arrays at finishEdit: what an edit CREATED must be in them by
            // then, or undo does not know the thing exists. The entry records their sizes for the checks.
            finishEdit(name, aspects) { const u = g.Project.undo; u.history.length = u.index; const a = aspects || this._pending || {}; u.history.push({ action: name, elements: (a.elements || []).length, textures: (a.textures || []).length }); u.index++; },
            undo() { if (g.Project.undo.index > 0) g.Project.undo.index--; },
            redo() { if (g.Project.undo.index < g.Project.undo.history.length) g.Project.undo.index++; },
            get history() { return g.Project.undo.history; },
            get index() { return g.Project.undo.index; },
        },
        Canvas: { updateAll() { g._updates = (g._updates || 0) + 1; }, updateAllUVs() {}, updateVisibility() {}, withoutGizmos(cb) { cb(); } },
        Preview: { selected: { canvas: new FakeCanvas(64, 48), project: null, isOrtho: false, camera: { position: v3(), zoom: 1, fov: 45 }, controls: { target: v3(), update() {} }, render() { const c = this.canvas.getContext('2d'); c.fillStyle = '#ff8800'; c.fillRect(20, 10, 24, 28); }, loadAnglePreset(p) { this.camera.position.fromArray(p.position); if (p.target) this.controls.target.fromArray(p.target); if (p.projection && p.projection !== 'unset') this.isOrtho = p.projection === 'orthographic'; } } },
        DefaultCameraPresets: [{ id: 'initial', position: [-40, 32, -40], target: [0, 12, 0], projection: 'perspective' }, { id: 'north', position: [0, 0, -512], target: [0, 0, 0], projection: 'orthographic' }, { id: 'top', position: [0, 512, 0], target: [0, 0, 0], projection: 'orthographic' }],
        BarItems: {
            select_all: { trigger() { g._triggered = 'select_all'; } },
            // Blockbench's own new_window: `click` IS the handler that sends the IPC making a window,
            // `trigger()` is the keybind path that checks the condition and then calls click. The
            // isolation record's measurement drove `click()`, so the stub records WHICH entry point
            // the plugin used and the harness pins it - a stub that accepted either would let the
            // plugin drift onto the path nobody measured.
            new_window: {
                click() { g._new_window = (g._new_window || []).concat(['click']); if (g._openStubWindow) g._stubWindow = g._openStubWindow(); },
                trigger() { g._new_window = (g._new_window || []).concat(['trigger']); return this.click(); },
            },
        },
        unselectAllElements(exceptions) {
            const keep = g.Outliner.selected.filter((e) => exceptions instanceof Array && exceptions.includes(e));
            for (const e of g.Project.elements) if (!keep.includes(e)) e.selected = false;
            g.Outliner.selected.length = 0;
            for (const e of keep) g.Outliner.selected.push(e);
            for (const gr of g.Project.groups) gr.selected = false;
        },
        updateSelection() { g._selection_updates = (g._selection_updates || 0) + 1; },
        // Blockbench's crash-recovery store, keyed by project uuid, and the one global the close path
        // runs through. removeAllBackups clears EVERY window's entries, which is the hazard.
        AutoBackup: {
            entries: {},
            async removeAllBackups() { g.AutoBackup.entries = {}; },
            async removeBackup(uuid) { delete g.AutoBackup.entries[uuid]; },
        },
        // `close` is what an agent-born window calls on itself once nothing needs it. Counted rather
        // than acted on: there is no window here to go away.
        // `listeners` records what the plugin subscribes to: the `storage` event is the one
        // cross-window channel settings have (section 13), and a listener that is never registered
        // is a design that only works in the harness, where the event is dispatched by hand.
        window: {
            onbeforeunload: null, close() { g._closed = (g._closed || 0) + 1; },
            listeners: {},
            addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
            removeEventListener(type, fn) { const l = this.listeners[type] || []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); },
        },
        Plugin: { register(id, def) { g.__plugin = def; } },
        // `setName` and `children` are the two parts of the real Action the menu work depends on,
        // both checked in the running app (5.1.6): `setName` is on Action.prototype, and an Action
        // with a `children` array is what Blockbench nests a submenu under.
        Action: class {
            constructor(id, o) { this.id = id; this.o = o; this.name = o && o.name; this.children = o && o.children; }
            setName(n) { this.name = n; if (this.o) this.o.name = n; }
            delete() {}
        },
        // Records what was registered and where, because "one entry in Tools, not seven" is a claim
        // about this call and nothing else can see it (section 12.5).
        MenuBar: { added: [], addAction(a, path) { this.added.push({ id: a.id, path, children: a.children ? a.children.length : 0 }); } },
        Dialog: class { constructor(o) { this.o = o; } show() {} },
        requireNativeModule(name, opts) { g._asked = (g._asked || []).concat([{ name, prompt: opts && opts.show_permission_dialog }]); if (name === 'process' && g._grant) return { getBuiltinModule: (m) => (m === 'http' ? http : null), versions: process.versions }; return undefined; },
        Outliner: { get root() { return g.Project ? g.Project.root : []; }, get elements() { return g.Project ? g.Project.elements : []; }, selected: [] },
        Timeline: { setTime(t) { g._time = t; } }, Animator: { preview() {} },
    });
    Object.defineProperty(g.Cube, 'all', { get: () => (g.Project ? g.Project.elements.filter((e) => e instanceof FakeCube) : []) });
    Object.defineProperty(g.Group, 'all', { get: () => (g.Project ? g.Project.groups : []) });
    Object.defineProperty(g.Texture, 'all', { get: () => (g.Project ? g.Project.textures : []) });
    Object.defineProperty(g.Texture, 'selected', { get: () => (g.Project ? g.Project.textures.find((t) => t.selected) || null : null) });
    g.globalThis = g;
    return g;
}
function v3() { const v = { x: 0, y: 0, z: 0, toArray() { return [this.x, this.y, this.z]; }, fromArray(a) { [this.x, this.y, this.z] = a; return this; }, set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } }; return v; }

world();
vm.createContext(g);
vm.runInContext(fs.readFileSync(PLUGIN, 'utf8'), g, { filename: PLUGIN });
g.__plugin.onload();
const api = g.mcptoolkitBridge;
api.settings({ hold_ms: 400 });
const S1 = { id: 's1', client: 'probe-a' };
const S2 = { id: 's2', client: 'probe-b' };
const call = (tool, args, s = S1) => api.call(tool, args, s);

// =============================================================================================
section('1. manifest and the pinned capture');
// =============================================================================================
const man = api.manifest();
ok('26 tools', man.length === 26, man.length);
ok('every tool stamped observe|blockbench_edit', man.every((t) => t.mechanism === 'observe' || t.mechanism === 'blockbench_edit'));
ok('every schema refuses undeclared arguments', man.every((t) => t.inputSchema.additionalProperties === false));
ok('every tool but project takes project', man.filter((t) => t.name !== 'project').every((t) => t.inputSchema.properties.project));
ok('descriptions are priced: none over 700 chars', man.every((t) => t.description.length <= 700), man.filter((t) => t.description.length > 700).map((t) => t.name + ':' + t.description.length));
const manifestJson = JSON.stringify(man, null, 1);
if (WRITE_FIXTURE) {
    fs.writeFileSync(FIXTURE, manifestJson);
    console.log('  wrote ' + FIXTURE);
} else {
    ok('the shim\'s pinned capture is the current manifest (run with --write-fixture to re-pin)',
        fs.existsSync(FIXTURE) && fs.readFileSync(FIXTURE, 'utf8') === manifestJson);
}
ok('onload asked for process WITHOUT a dialog', g._asked && g._asked.length === 1 && g._asked[0].name === 'process' && g._asked[0].prompt === false, g._asked);
ok('and reports what it needs', /process/.test(api.status().needs || ''), api.status());

// =============================================================================================
section('2. argument checking');
// =============================================================================================
let r = await call('place_cube', { elements: [{ from: [0, 0, 0], to: [1, 1, 1] }], colour: 'red' });
ok('undeclared argument refused by name', !r.ok && /undeclared argument\(s\) colour; declared: /.test(r.error), r);
r = await call('inspect', { op: 'volume' });
ok('enum refused with the list', !r.ok && /must be one of bounds, faces, envelope, overlaps, uv/.test(r.error), r);
r = await call('place_cube', {});
ok('required argument named', !r.ok && /missing required "elements"/.test(r.error), r);
r = await call('place_cube', { elements: [{ from: [0, 0], to: [1, 1, 1] }] });
ok('a vec3 with two numbers refused at its path', !r.ok && /elements\[0\]\.from: needs at least 3/.test(r.error), r);
r = await call('nope', {});
ok('unknown tool', !r.ok && /unknown tool/.test(r.error));
r = await call('get_project_info', {});
ok('no project open: refused with the fix', !r.ok && /no project is open/.test(r.error) && /project op:new/.test(r.hint), r);

// =============================================================================================
section('3. sessions: binding, the unbound note, holds, take, expiry');
// =============================================================================================
r = await call('project', { op: 'new', name: 'alpha', format: 'java_block', texture_width: 32, texture_height: 32 }, S1);
ok('op:new makes and binds', r.ok && r.result.name === 'alpha' && r.result.bound === true && r.result.texture_width === 32, r);
r = await call('project', { op: 'new', name: 'beta', format: 'modded_entity' }, S2);
ok('a second session makes its own', r.ok && r.result.name === 'beta' && g.Project.name === 'beta');
r = await call('get_project_info', {}, S1);
ok('s1 without `project` lands in ITS project, not the active tab', r.ok && r.result.name === 'alpha' && r.result.project.bound === true && g.Project.name === 'alpha', r);
r = await call('place_cube', { elements: [{ name: 'body', from: [0, 0, 0], to: [8, 8, 8] }], project: 'beta' }, S1);
ok('an edit on a project another live session holds is refused with held_by and the fix', !r.ok && /held_by: session s2 \(probe-b\)/.test(r.error) && /take:true/.test(r.hint), r);
r = await call('get_project_info', { project: 'beta' }, S1);
ok('a read on it is not refused', r.ok && r.result.name === 'beta' && r.result.project.bound === false, r);
const S3 = { id: 's3', client: 'probe-c' };
// The fallback must not hand an unbound session someone else's work: beta is the active tab and s2
// holds it. Before 0.138.0 this answered with beta's contents - 23 cubes and its bones, in the live
// run that found it (isolation record section 6.3).
r = await call('get_project_info', {}, S3);
ok('the active-tab fallback refuses a project another session holds', !r.ok && /held_by: session s2 \(probe-b\) is bound to the active tab "beta"/.test(r.error) && /does not fall through/.test(r.error), r);
ok('...and the refusal offers all three ways out', /op:new/.test(r.hint) && /op:list/.test(r.hint) && /project:"beta"/.test(r.hint), r.hint);
// An UNHELD active tab is still the fallback, with the unbound note, once.
await call('project', { op: 'new', name: 'free-tab', bind: false }, S3);
r = await call('get_project_info', {}, S3);
ok('an unbound session acts on an unheld active tab and is told so once', r.ok && r.result.name === 'free-tab' && r.result.project.bound === false && /unbound/.test(r.result.project.note), r);
r = await call('get_project_info', {}, S3);
ok('...once', r.ok && !r.result.project.note);
// Naming it is still a free read - reads are unrefused by design; only the fallback stops.
r = await call('get_project_info', { project: 'beta' }, S3);
ok('...but naming the held project still reads it', r.ok && r.result.name === 'beta', r);
await call('project', { op: 'close', project: 'free-tab', force: true }, S3);
await call('project', { op: 'select', project: 'beta', take: true }, { id: 's-restore-active' });
await call('project', { op: 'select', project: 'beta', take: true }, S2);
r = await call('project', { op: 'select', project: 'beta' }, S3);
ok('select of a held project refused without take', !r.ok && /held_by: session s2/.test(r.error), r);
r = await call('project', { op: 'select', project: 'beta', take: true }, S3);
ok('take:true takes it', r.ok && r.result.taken_from === 's2' && r.result.bound === true, r);
r = await call('project', { op: 'list' }, S1);
ok('list shows holders and sessions', r.ok && r.result.projects.find((p) => p.name === 'beta').held_by.session === 's3' && r.result.sessions.some((s) => s.id === 's3' && s.project === 'beta'), r.result);
ok('list is stamped observe on the reply though the tool is an edit', r.mechanism === 'observe');
await new Promise((res) => setTimeout(res, 500));
r = await call('place_cube', { elements: [{ name: 'body', from: [0, 0, 0], to: [8, 8, 8] }], project: 'beta' }, S1);
ok('a hold expires with the session (hold_ms elapsed, s3 silent)', r.ok, r);
await call('get_project_info', {}, S2).then((x) => ok('s2 lost its binding to beta when s3 took it: acts on active tab', x.ok && x.result.project.bound === false, x));
// A THROWAWAY must not take the binding (TODO 1.9, 2026-09-08). The defect this closes: a consumer
// made a scratch project from an error path, so the session came out bound to a project it meant to
// discard, and every later unqualified call resolved THERE - by binding, which outlives the scratch
// stopping being the active tab, and which the consumer's own "am I bound?" guard could not see.
const S4 = { id: 's4', client: 'probe-d' };
r = await call('project', { op: 'new', name: 'scratch', bind: false }, S1);
ok('op:new {bind:false} creates and does NOT bind', r.ok && r.result.name === 'scratch' && r.result.bound === false && g.Project.name === 'scratch', r);
ok('...and says which project the session kept', /stays bound to "alpha"/.test(r.result.note || ''), r.result);
r = await call('get_project_info', {}, S1);
ok('...so an unqualified call still lands in alpha, with the scratch on the active tab', r.ok && r.result.name === 'alpha', r);
r = await call('project', { op: 'new', name: 'scratch2', bind: false }, S4);
ok('an UNBOUND session is told the throwaway is now what the fallback resolves to', r.ok && r.result.bound === false && /ACTIVE TAB/.test(r.result.note || ''), r.result);
await call('project', { op: 'close', project: 'scratch2', force: true }, S4);
r = await call('project', { op: 'close', project: 'scratch', force: true }, S1);
ok('the throwaways close and S1 keeps alpha', r.ok && !g.ModelProject.all.some((p) => p.name.startsWith('scratch')), r);
r = await call('get_project_info', {}, S1);
ok('...still bound to alpha after the close', r.ok && r.result.name === 'alpha' && r.result.project.bound === true, r);

// =============================================================================================
section('4. the queue: interleaved sessions each land in their own project');
// =============================================================================================
await call('project', { op: 'select', project: 'alpha' }, S1);
await call('project', { op: 'select', project: 'beta', take: true }, S2);
const burst = await Promise.all([
    call('place_cube', { elements: [{ name: 'a1', from: [0, 0, 0], to: [4, 4, 4] }] }, S1),
    call('place_cube', { elements: [{ name: 'b1', from: [0, 0, 0], to: [2, 2, 2] }] }, S2),
    call('place_cube', { elements: [{ name: 'a2', from: [4, 0, 0], to: [8, 4, 4] }] }, S1),
    call('get_project_info', {}, S2),
    call('place_cube', { elements: [{ name: 'b2', from: [2, 0, 0], to: [4, 2, 2] }] }, S2),
]);
const alpha = g.ModelProject.all.find((p) => p.name === 'alpha'), beta = g.ModelProject.all.find((p) => p.name === 'beta');
ok('all five answered ok', burst.every((x) => x.ok), burst.filter((x) => !x.ok));
ok('alpha got a1, a2', alpha.elements.map((e) => e.name).join(',') === 'a1,a2', alpha.elements.map((e) => e.name));
ok('beta got body, b1, b2', beta.elements.map((e) => e.name).join(',') === 'body,b1,b2', beta.elements.map((e) => e.name));
ok('the read in the middle saw beta', burst[3].result.name === 'beta');

// =============================================================================================
section('5. cubes, groups, elements: readbacks carry the numbers');
// =============================================================================================
await call('project', { op: 'select', project: 'alpha' }, S1);
r = await call('add_group', { name: 'torso', origin: [0, 12, 0], children: ['a1', 'a2'] }, S1);
ok('add_group with children', r.ok && r.result.children.join(',') === 'a1,a2' && alpha.groups[0].children.length === 2, r);
r = await call('place_cube', { elements: [{ name: 'a3', from: [8, 0, 0], to: [12, 4, 4] }, { name: 'a4', from: [0, 5, 0], to: [4, 9, 4] }], group: 'torso' }, S1);
ok('place_cube into a group', r.ok && r.result.group === 'torso' && r.result.cubes.length === 2, r);
const a3 = r.result.cubes[0];
ok('readback: envelope names a2 touching a3 (gap 0 on x)', a3.envelope.some((e) => e.name === 'a2' && e.relation === 'touching' && e.gap[0] === 0), a3.envelope);
ok('readback: a4 sits 1 above a1 (gap y = 1, clear)', r.result.cubes[1].envelope.find((e) => e.name === 'a1').gap[1] === 1 && r.result.cubes[1].envelope.find((e) => e.name === 'a1').relation === 'clear', r.result.cubes[1].envelope);
r = await call('modify_cube', { id: 'a4', to: [4, 9, 6] }, S1);
ok('modify_cube readback', r.ok && r.result.cubes[0].size.join(',') === '4,4,6' && r.result.changed.join() === 'to', r);
r = await call('modify_cube', { id: 'a4', to: [4, 1, 6] }, S1);
ok('to < from refused', !r.ok && /to must be >= from/.test(r.error));
r = await call('list_outline', { detail: 'boxes' }, S1);
ok('list_outline tree with the group and its cubes', r.ok && r.result.tree[0].name === 'torso' && r.result.tree[0].children.length === 4 && r.result.tree[0].children[0].from, r.result);
r = await call('element', { op: 'duplicate', id: 'a1' }, S1);
ok('duplicate', r.ok && r.result.copies[0] === 'a1_copy');
r = await call('list_outline', {}, S1);
r = await call('element', { op: 'rename', id: 'a1_copy', name: 'a1' }, S1);
r = await call('list_outline', {}, S1);
ok('duplicate names reported with uuids', r.ok && r.result.duplicate_names && r.result.duplicate_names[0].name === 'a1' && r.result.duplicate_names[0].uuids.length === 2, r.result.duplicate_names);
r = await call('modify_cube', { id: 'a1', to: [1, 1, 1] }, S1);
ok('an ambiguous name is refused, pointing at the uuid', !r.ok && /names 2 elements; use a uuid/.test(r.error), r);
const dupeUuid = alpha.elements.filter((e) => e.name === 'a1')[1].uuid;
r = await call('element', { op: 'remove', id: dupeUuid }, S1);
ok('remove by uuid', r.ok && alpha.elements.filter((e) => e.name === 'a1').length === 1);
r = await call('element', { op: 'reparent', ids: ['a3'], parent: 'root' }, S1);
ok('reparent to root', r.ok && alpha.root.includes(alpha.elements.find((e) => e.name === 'a3')));
r = await call('element', { op: 'set', id: 'torso', rotation: [0, 0, 15] }, S1);
ok('set rotation on a group', r.ok && alpha.groups[0].rotation[2] === 15);
r = await call('element', { op: 'hide', id: 'torso' }, S1);
ok('hide a group hides its cubes', r.ok && alpha.elements.find((e) => e.name === 'a4').visibility === false);
await call('element', { op: 'show', id: 'torso' }, S1);
r = await call('find_elements_by_criteria', { name_pattern: '^a\\d$', type: 'cube', min_size: [4, 4, 4] }, S1);
ok('find by regex, type and size', r.ok && r.result.count === 4 && r.result.elements.every((e) => e.type === 'cube'), r.result);
r = await call('get_undo_stack', {}, S1);
ok('undo stack lists the named entries', r.ok && r.result.entries.some((e) => e.action === 'place_cube') && r.result.entries.some((e) => e.action === 'element hide'), r.result);
{
  // The created things are IN their undo entries (live, 2026-09-07: without this, undoing a place_cube
  // detached its cubes to root instead of removing them, and a duplicate's copy survived its undo).
  const h = alpha.undo.history;
  const placed = h.filter((e) => e.action === 'place_cube');
  ok('place_cube lists the cubes it made in its undo entry', placed.length > 0 && placed.every((e) => e.elements > 0), placed);
}
r = await call('undo', { steps: 2 }, S1);
ok('undo moves the index', r.ok && r.result.undone === 2 && r.result.index === alpha.undo.history.length - 2, r.result);
r = await call('redo', {}, S1);
ok('redo', r.ok && r.result.index === alpha.undo.history.length - 1);
r = await call('undo', { steps: 100 }, S1);
ok('undo past the bottom reports what MOVED, not what was asked', r.ok && r.result.undone === alpha.undo.history.length - 1 && r.result.asked === 100 && r.result.index === 0, r.result);
r = await call('undo', {}, S1);
ok('undo on an empty stack says so', r.ok && r.result.undone === 0 && r.result.note === 'nothing to undo', r.result);
r = await call('redo', { steps: 100 }, S1);
ok('redo past the top reports what moved', r.ok && r.result.redone === alpha.undo.history.length && r.result.index === alpha.undo.history.length, r.result);

// =============================================================================================
section('6. textures: a size that applies, painters, the ASCII reader, ops');
// =============================================================================================
r = await call('create_texture', { name: 'skin', width: 32, height: 32 }, S1);
ok('create_texture makes the size it was asked for', r.ok && r.result.size.join('x') === '32x32' && alpha.textures[0].canvas.width === 32, r);
{
  const made = alpha.undo.history.find((e) => e.action === 'create_texture');
  ok('create_texture lists the texture it made in its undo entry', made && made.textures === 1, made);
}
ok('...and assigned it to every blank face', alpha.elements.every((c) => Object.values(c.faces).every((f) => f.texture === alpha.textures[0].uuid)));
r = await call('create_texture', { name: 'skin' }, S1);
ok('a duplicate texture name is refused', !r.ok && /exists/.test(r.error));
for (const c of alpha.elements) c.mapAutoUV();
r = await call('inspect', { op: 'faces', id: 'a3' }, S1);
ok('inspect faces gives rectangles in texture pixels (project 32 uv, sheet 32: 1:1)', r.ok && r.result.cubes[0].faces.north.join(',') === '0,0,4,4', r.result);
r = await call('paint_faces', { faces: { 'a3.north': '#ff0000', 'a3.east': [255, '#000000'], 'a3.up': null }, pixels: { '30,30': '#00ff00' } }, S1);
ok('paint_faces reports rectangles and counts', r.ok && r.result.painted['a3.north'].px === 16 && r.result.painted['a3.east'].px === 16 && r.result.cleared['a3.up'] && r.result.pixels === 1, r);
const skin = alpha.textures[0];
const px = (x, y) => Array.from(skin.canvas.data.subarray((y * 32 + x) * 4, (y * 32 + x) * 4 + 4));
ok('the red landed', px(0, 0).join() === '255,0,0,255' && px(3, 3).join() === '255,0,0,255', px(0, 0));
ok('the [top,bottom] pair shaded rows', px(8, 0)[0] === 255 && px(8, 3)[0] === 0, [px(8, 0), px(8, 3)]);
ok('the pixel landed', px(30, 30).join() === '0,255,0,255');
ok('edit went through Texture.edit without use_cache', skin.editOpts && skin.editOpts.no_undo === true && !('use_cache' in skin.editOpts), skin.editOpts);
r = await call('texture', { op: 'read', texture: 'skin', region: [0, 0, 6, 2] }, S1);
ok('texture read: rows through an auto legend', r.ok && r.result.rows.length === 2 && r.result.rows[0].slice(0, 4) === '####' && r.result.rows[0][4] === '.' && r.result.legend['#'] === '#ff0000', r.result);
ok('read is stamped observe on the reply', r.mechanism === 'observe');
r = await call('paint_ascii', { palette: { '#': '#0000ff', o: '#ffffff' }, stamps: [{ at: [10, 10], rows: ['#o#', 'o.o'] }, { cube: 'a3', face: 'south', fill: '#123456', rows: ['#'], shade_only: true }] }, S1);
ok('paint_ascii stamps', r.ok && r.result.stamps[0].painted === 5 && r.result.stamps[0].cleared === 1 && r.result.stamps[0].left === 0, r.result);
ok('shade_only on an unpainted face skipped every texel', r.result.stamps[1].skipped_shade_only === 16 + 1 && r.result.stamps[1].painted === 0, r.result.stamps[1]);
r = await call('texture', { op: 'read', texture: 'skin', region: [10, 10, 3, 2], palette: { '#': '#0000ff', o: '#ffffff' } }, S1);
ok('read with the same palette round-trips the stamp', r.ok && r.result.rows.join('/') === '#o#/o.o', r.result);
r = await call('texture', { op: 'rects', texture: 'skin', rects: [{ x: 20, y: 20, w: 2, h: 2, c: '#010203' }, { x: 0, y: 0, w: 1, h: 1 }] }, S1);
ok('rects fill and clear', r.ok && r.result.filled === 4 && r.result.cleared === 1 && px(21, 21).join() === '1,2,3,255' && px(0, 0)[3] === 0, r.result);
r = await call('texture', { op: 'recolor', texture: 'skin', map: { '#010203': '#ffffff' } }, S1);
ok('recolor by map', r.ok && r.result.changed === 4 && px(21, 21).join() === '255,255,255,255', r.result);
r = await call('texture', { op: 'flip', texture: 'skin', axis: 'x' }, S1);
ok('flip x moved the white block', r.ok && px(31 - 21, 21).join() === '255,255,255,255');
await call('texture', { op: 'flip', texture: 'skin', axis: 'x' }, S1);
r = await call('texture', { op: 'resize', texture: 'skin', width: 64, height: 64, mode: 'scale', project_uv: true }, S1);
ok('resize scales and moves the project UV', r.ok && skin.width === 64 && alpha.texture_width === 64 && Array.from(skin.canvas.data.subarray((43 * 64 + 43) * 4, (43 * 64 + 43) * 4 + 3)).join() === '255,255,255', r.result);
r = await call('list_textures', {}, S1);
ok('list_textures with use counts', r.ok && r.result.textures[0].used_by === 4 && r.result.textures[0].opaque > 0, r.result);
r = await call('get_texture', { texture: 'skin', region: [42, 42, 4, 4] }, S1);
ok('get_texture returns a PNG that is NOT a frame', r.ok && r.result._image && r.result._image.frame === false && decodePng(Buffer.from(r.result._image.base64, 'base64')).width === 4, r.result && r.result._image && r.result._image.frame);
const tmp = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'bbbridge-'));
r = await call('texture', { op: 'write', texture: 'skin', path: path.join(tmp, 'skin.png') }, S1);
ok('write a PNG', r.ok && fs.existsSync(path.join(tmp, 'skin.png')) && decodePng(fs.readFileSync(path.join(tmp, 'skin.png'))).width === 64, r);
r = await call('create_texture', { name: 'loaded', path: path.join(tmp, 'skin.png'), assign: 'none' }, S1);
ok('create_texture from a path takes the file\'s size', r.ok && r.result.size.join('x') === '64x64', r);
const undo_before_remove = g.Project.undo.history.length;
r = await call('texture', { op: 'remove', texture: 'loaded' }, S1);
ok('remove', r.ok && r.result.remaining.join() === 'skin');
// Texture.remove() opens an undo entry OF ITS OWN unless passed no_update, so the bare call made two
// entries for one removal while the reply said "one entry" (found reading the source, 2026-09-08).
ok('...and it is ONE undo entry, as the reply says', g.Project.undo.history.length === undo_before_remove + 1 && g.Project.undo.history[g.Project.undo.history.length - 1].action === 'texture remove', g.Project.undo.history.slice(-2));
r = await call('inspect', { op: 'uv', texture: 'skin' }, S1);
ok('inspect uv: the stub packs every cube at 0,0, so faces collide, none outside', r.ok && r.result.sheets[0].collisions.length > 0 && r.result.sheets[0].outside.length === 0, r.result.sheets[0]);

// =============================================================================================
section('7. inspect: bounds and overlaps');
// =============================================================================================
await call('place_cube', { elements: [{ name: 'deep', from: [9, 1, 1], to: [11, 3, 3] }, { name: 'tilted', from: [20, 0, 0], to: [22, 2, 2], rotation: [0, 45, 0] }] }, S1);
r = await call('inspect', { op: 'overlaps' }, S1);
ok('overlaps: deep sits inside a3 with depth 2, worst first', r.ok && r.result.overlapping_pairs[0].a === 'a3' && r.result.overlapping_pairs[0].b === 'deep' && r.result.overlapping_pairs[0].least === 2, r.result);
ok('...and the rotated cube AND the cubes on the rotated bone are named as unchecked', r.result.unchecked_rotated && r.result.unchecked_rotated.includes('tilted') && r.result.unchecked_rotated.includes('a1'), r.result.unchecked_rotated);
r = await call('inspect', { op: 'bounds', group: 'torso' }, S1);
ok('bounds of a group', r.ok && r.result.bounds.cubes === 3 && r.result.bounds.from.join() === '0,0,0', r.result);
r = await call('inspect', { op: 'bounds' }, S1);
ok('bounds of the model in blocks', r.ok && r.result.bounds.size_blocks[0] === 22 / 16 && /rotated/.test(r.result.bounds.note), r.result);

// =============================================================================================
section('8. pictures: frames, look, the contact sheet');
// =============================================================================================
r = await call('capture_screenshot', { angle: 'north' }, S1);
ok('capture returns a frame PNG of the viewport', r.ok && r.result._image.frame === true && r.result.angle === 'north' && r.result.width === 64, r.result && r.result.width);
r = await call('capture_screenshot', { angle: 'nowhere' }, S1);
ok('an unknown preset lists the known ones', !r.ok && /have: initial, north, top/.test(r.error));
r = await call('set_camera_angle', { fit: true }, S1);
ok('fit moves the target to the model centre', r.ok && r.result.camera.target[0] === 11 && r.result.camera.target[2] === 3, r.result);
r = await call('modify_cube', { id: 'deep', inflate: 0.5, look: true }, S1);
ok('look:true rides an edit reply as a frame', r.ok && r.result._image && r.result._image.frame === true && r.result.look.join('x') === '64x48', r.result && Object.keys(r.result));
r = await call('capture_screenshot', { views: ['north', 'top', 'initial'], tile: 32 }, S1);
ok('a contact sheet: one picture, three views, camera restored', r.ok && r.result.views.length === 3 && r.result.width === 64 && r.result.height === 2 * (32 + 14) && g.Preview.selected.controls.target.toArray()[0] === 11, r.result);
const sheet = decodePng(Buffer.from(r.result._image.base64, 'base64'));
ok('...and it is a real PNG of that size', sheet.width === 64 && sheet.height === 92);

// =============================================================================================
section('9. project ops, export, eval, actions, animation');
// =============================================================================================
r = await call('project', { op: 'save' }, S1);
ok('save without a path is refused with the fix', !r.ok && /never been saved/.test(r.error) && /op:save \{path/.test(r.hint), r);
const bb = path.join(tmp, 'alpha.bbmodel');
r = await call('project', { op: 'save', path: bb }, S1);
ok('save writes the codec\'s output', r.ok && fs.existsSync(bb) && JSON.parse(fs.readFileSync(bb, 'utf8')).name === 'alpha' && alpha.saved === true, r);
r = await call('project', { op: 'open', path: bb }, S2);
ok('open of a path already open selects that tab and binds', r.ok && r.result.was_open === true && r.result.name === 'alpha', r);
r = await call('project', { op: 'open', path: path.join(tmp, 'missing.bbmodel') }, S2);
ok('open of a missing file fails cleanly', !r.ok && /could not read|did not complete/.test(r.error), r);
fs.copyFileSync(bb, path.join(tmp, 'gamma.bbmodel'));
r = await call('project', { op: 'open', path: path.join(tmp, 'gamma.bbmodel') }, S2);
ok('open loads a new tab and binds', r.ok && r.result.name === 'gamma' && r.result.bound === true && r.result.was_open === false, r);
r = await call('project', { op: 'close' }, S2);
ok('close of an unsaved project refused', !r.ok && /unsaved/.test(r.error));
r = await call('project', { op: 'close', force: true }, S2);
ok('close force', r.ok && r.result.closed === 'gamma' && !g.ModelProject.all.some((p) => p.name === 'gamma'));
r = await call('project', { op: 'list' }, S2);
ok('s2 unbound again after its project closed', r.ok && r.result.sessions.find((x) => x.id === 's2').project === null, r.result.sessions);
r = await call('export_model', { list: true }, S1);
ok('export_model list', r.ok && r.result.codecs.includes('project'));
r = await call('export_model', { codec: 'java_block' }, S1);
ok('export_model content', r.ok && r.result.content === '{"elements":[]}');
r = await call('export_model', { codec: 'project', path: path.join(tmp, 'out.bbmodel') }, S1);
ok('export_model to path', r.ok && r.result.written && fs.existsSync(path.join(tmp, 'out.bbmodel')));
r = await call('risky_eval', { code: '// a comment\nCube.all.length /* and another */' }, S1);
ok('eval: an expression with comments', r.ok && r.result.value === alpha.elements.length, r);
r = await call('risky_eval', { code: 'const n = Texture.all.length; return {n, ok: n === 1};' }, S1);
ok('eval: statements with return', r.ok && r.result.value.ok === true, r);
r = await call('risky_eval', { code: '// note\nconst first = Texture.all[0];\nfirst.name' }, S1);
ok('eval: statements WITHOUT return answer the last value (the old eval\'s contract)', r.ok && r.result.value === alpha.textures[0].name, r);
r = await call('risky_eval', { code: 'const later = await new Promise((res) => setTimeout(() => res(7), 5)); return later + 1;' }, S1);
ok('eval: a top-level await in a body with return', r.ok && r.result.value === 8, r);
r = await call('risky_eval', { code: 'this is not javascript' }, S1);
ok('eval: a parse failure is a SyntaxError reply', !r.ok && /Unexpected|SyntaxError|identifier/i.test(r.error), r);
r = await call('risky_eval', { code: 'new Promise((res) => setTimeout(() => res("later"), 5))' }, S1);
ok('eval: a promise is awaited', r.ok && r.result.value === 'later', r);
r = await call('risky_eval', { code: 'Promise.reject(new Error("boom"))' }, S1);
ok('eval: a rejection is an error reply, not a wedge', !r.ok && /boom/.test(r.error), r);
r = await call('risky_eval', { code: 'throw new Error("sync")' }, S1);
ok('eval: a throw is an error reply', !r.ok && /sync/.test(r.error));
// PROJECT in scope (ArmorPieces ask 1, 2026-09-07): the resolved project, in all three shapes, and
// equal to the global at the start of the code - so an API can take PROJECT instead of reading Project.
r = await call('risky_eval', { code: 'PROJECT.name' }, S1);
ok('eval: PROJECT is the resolved project (expression shape)', r.ok && r.result.value === r.result.project.name, r);
r = await call('risky_eval', { code: '// script shape\nconst same = PROJECT === Project;\nsame && PROJECT.name' }, S1);
ok('eval: PROJECT in the script shape, equal to the global Project', r.ok && r.result.value === r.result.project.name, r);
ok('eval: the script shape leaves no global behind', typeof g.__mcptkEvalProject === 'undefined' && typeof g.PROJECT === 'undefined');
r = await call('risky_eval', { code: 'const n = PROJECT.name; return { n, same: PROJECT === Project };' }, S1);
ok('eval: PROJECT in the return shape', r.ok && r.result.value.same === true && r.result.value.n === r.result.project.name, r);
// GAME in scope (TODO.md 1.9), the same three shapes and for the same reason one dimension over:
// the two older plugins carried a hardcoded 25599, which since per-project bridge ports names the
// TOOLKIT's own game rather than the one this session drives. The shim puts it on the session
// block; the record keeps it beside the binding; a session never told gets null, and a plugin
// handed null must refuse rather than dial a plausible default. Driven as s1 - which holds alpha -
// because risky_eval is an EDIT and since 0.138.0 no other session may reach a held project.
r = await call('risky_eval', { code: 'GAME' }, S1);
ok('eval: a session the shim never told gets null, NOT a plausible port', r.ok && r.result.value === null, r);
const GAME_URL = 'http://127.0.0.1:25642';
const S1G = { id: 's1', client: 'probe-a', game: GAME_URL };
r = await call('risky_eval', { code: 'GAME' }, S1G);
ok('eval: GAME is the game bridge this session named (expression shape)', r.ok && r.result.value === GAME_URL, r);
r = await call('risky_eval', { code: '// script shape\nconst where = GAME;\nwhere' }, S1G);
ok('eval: GAME in the script shape', r.ok && r.result.value === GAME_URL, r);
ok('eval: the script shape leaves no GAME global behind',
    typeof g.__mcptkEvalGame === 'undefined' && typeof g.GAME === 'undefined');
r = await call('risky_eval', { code: 'return { game: GAME, project: PROJECT.name };' }, S1G);
ok('eval: GAME beside PROJECT in the return shape',
    r.ok && r.result.value.game === GAME_URL && r.result.value.project === r.result.project.name, r);
r = await call('project', { op: 'list' }, S1);
ok('the session record carries the game, so it can be seen',
    r.ok && r.result.sessions.find((x) => x.id === 's1').game === GAME_URL, r.result.sessions);
r = await call('risky_eval', { code: 'GAME' }, S1);
ok('and it STICKS: a later call whose block omits it still knows where the game is',
    r.ok && r.result.value === GAME_URL, r);
r = await call('get_project_info', {}, S1);
ok('the queue survived the rejections', r.ok);
r = await call('trigger_action', { id: 'select_all' }, S1);
ok('trigger_action', r.ok && g._triggered === 'select_all');
r = await call('trigger_action', { id: 'nothing' }, S1);
ok('unknown action refused', !r.ok);
r = await call('animation', { op: 'list' }, S1);
ok('animation list without the class: refused, not crashed', !r.ok && /no animations/.test(r.error), r);
r = await call('element', { op: 'select', id: 'a3' }, S1);
r = await call('get_selection', {}, S1);
ok('get_selection', r.ok && r.result.elements[0].name === 'a3');
// Two names must select BOTH: the app's select() clears the others first, so the loop that called it
// left only the last one selected while the reply claimed all of them (2026-09-08).
r = await call('element', { op: 'select', ids: ['a3', 'deep'] }, S1);
ok('element op:select takes several names', r.ok && r.result.selected.join() === 'a3,deep', r);
r = await call('get_selection', {}, S1);
ok('...and BOTH are selected, not just the last', r.ok && r.result.elements.map((e) => e.name).sort().join() === 'a3,deep', r.result);
r = await call('element', { op: 'select', ids: ['torso'] }, S1);
r = await call('get_selection', {}, S1);
ok('...and selecting a group clears the elements it replaced', r.ok && r.result.groups.join() === 'torso', r.result);

// =============================================================================================
section('10. the transport: real http, the bridge shape');
// =============================================================================================
g._grant = true;
api.settings({ port: 0 });
let st = api.start({ prompt: false });
await new Promise((res) => setTimeout(res, 100));
st = api.status();
ok('listening once process is granted', st.listening === true, st);
ok('asked without a dialog again', g._asked.every((a) => a.prompt === false), g._asked);
// port 0 = an ephemeral port; read it back off the server for the calls below
const server = (() => { try { return null; } catch { return null; } })();
const base = 'http://127.0.0.1:' + (api.status().port || 0);
// The plugin reports the configured port; with 0 we need the bound one - ask the module.
const bound = await (async () => {
    // A tiny trick: the plugin exposes nothing for the socket, so probe via a hello on the
    // ephemeral range is impossible; instead re-start on a fixed free port.
    api.stop();
    const srv = http.createServer(); srv.listen(0, '127.0.0.1'); await new Promise((r2) => srv.on('listening', r2));
    const port = srv.address().port; await new Promise((r2) => srv.close(r2));
    api.settings({ port }); api.start({ prompt: false });
    await new Promise((r2) => setTimeout(r2, 100));
    return 'http://127.0.0.1:' + port;
})();
let res = await fetch(bound + '/hello');
let body = await res.json();
ok('GET /hello', res.status === 200 && body.ok && body.plugin === 'mcptoolkit_bridge' && body.tools === 26 && body.projects === g.ModelProject.all.length, body);
res = await fetch(bound + '/tools', { headers: { 'X-MCPTK-Session': 'http-1', 'X-MCPTK-Client': 'curl' } });
body = await res.json();
ok('GET /tools is the manifest', res.status === 200 && Array.isArray(body) && body.length === 26 && body[0].mechanism);
res = await fetch(bound + '/cmd', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool: 'get_project_info', args: { project: 'alpha' }, session: { id: 'http-1', client: 'curl' } }) });
body = await res.json();
ok('POST /cmd answers the bridge envelope', res.status === 200 && body.ok && body.mechanism === 'observe' && body.result.name && body.result.project, body);
res = await fetch(bound + '/cmd', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool: 'project', args: { op: 'list' }, session: 'curl-by-hand' }) });
body = await res.json();
ok('a plain-string session on POST /cmd is an id, not anonymous', body.ok && body.result.sessions.some((x) => x.id === 'curl-by-hand') && !body.result.sessions.some((x) => x.id === 'anonymous'), body.result && body.result.sessions);
ok('the header touch registered the session', Object.keys(api.sessions()).includes('http-1'));
res = await fetch(bound + '/cmd', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool: 'capture_screenshot', args: { project: 'alpha' }, session: { id: 'http-1' } }) });
body = await res.json();
ok('a picture rides the envelope as _image', body.ok && body.result._image && body.result._image.frame === true);
res = await fetch(bound + '/cmd', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' });
ok('bad JSON is 400', res.status === 400);
res = await fetch(bound + '/nothing');
body = await res.json();
ok('an unknown route is 404 with the routes', res.status === 404 && body.routes.length === 14 && body.routes.includes('GET /presence') && body.routes.includes('POST /claim') && body.routes.includes('POST /window'), body);
// 0.8.0's three every-window routes and the dock's five. They are listed because a 404 naming its
// routes is the only discovery a `curl` by hand has (BLOCKBENCH_ISOLATION_DESIGN.md section 11.9).
ok('...including the close route nothing in the system had before 0.8.0', body.routes.includes('POST /close') && body.routes.includes('POST /focus') && body.routes.includes('POST /role'), body.routes);
ok('...and the five that are the dock\'s', ['GET /dock', 'POST /dock/hello', 'POST /dock/beat', 'POST /dock/window', 'POST /dock/close'].every((r) => body.routes.includes(r)), body.routes);
res = await fetch(bound + '/cmd', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool: 'place_cube', args: { elements: [{ from: [0, 0, 0], to: [1, 1, 1] }], bogus: 1 }, session: { id: 'http-1' } }) });
body = await res.json();
ok('an argument error over http is ok:false with the name', body.ok === false && /bogus/.test(body.error));

// =============================================================================================
section('11. presence: a binding lives exactly as long as its connection; a shared id is said');
// =============================================================================================
// ArmorPieces asks 2 and 3 (2026-09-07). Before: a binding expired on a timer, so a process that
// had EXITED held its project for two minutes and refused the human's cleanup; and four children
// sharing one inherited id were one session with one binding, and nothing said so.
const sleep = (ms) => new Promise((res2) => setTimeout(res2, ms));
const cmd = (tool, args, sessionBlock) => fetch(bound + '/cmd', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool, args, session: sessionBlock }) }).then((x) => x.json());
const openPresence = (id, client) => new Promise((resolve, reject) => {
    const req = http.get(bound + '/presence', { headers: Object.assign({ 'X-MCPTK-Client': client }, id ? { 'X-MCPTK-Session': id } : {}) }, (pres) => {
        if (pres.statusCode !== 200) { resolve({ req, status: pres.statusCode }); pres.resume(); return; }
        pres.setEncoding('utf8');
        pres.once('data', (d) => resolve({ req, status: 200, first: JSON.parse(d.split('\n')[0]) }));
    });
    req.on('error', reject);
});
const P1 = { id: 'pres-1', client: 'shim-a' };
const P2 = { id: 'pres-2', client: 'shim-b' };
let noHeader = await openPresence(undefined, 'curl');
ok('presence without a session header is refused', noHeader.status === 400, noHeader.status);
const c1 = await openPresence(P1.id, P1.client);
ok('presence answers a first line: the session and its connection count', c1.status === 200 && c1.first.ok && c1.first.session === 'pres-1' && c1.first.connections === 1, c1.first);
body = await cmd('project', { op: 'new', name: 'gamma', format: 'java_block' }, P1);
ok('the connected session binds a project', body.ok && body.result.bound === true, body);
await sleep(500); // hold_ms is 400 here: the timer would have released it
body = await cmd('project', { op: 'list' }, P2);
let gamma = body.ok && body.result.projects.find((p) => p.name === 'gamma');
ok('the hold outlives hold_ms while the connection is open, and list says connected', gamma && gamma.held_by && gamma.held_by.session === 'pres-1' && gamma.held_by.connected === true, gamma);
ok('the sessions list carries the connection count', body.result.sessions.some((x) => x.id === 'pres-1' && x.connections === 1), body.result.sessions);
body = await cmd('place_cube', { elements: [{ from: [0, 0, 0], to: [1, 1, 1] }], project: 'gamma' }, P2);
ok('an edit on it from another session is refused, and the refusal says "connected" not a timestamp', !body.ok && /held_by: session pres-1 \(shim-a\) is bound to "gamma", connected/.test(body.error), body);
const c1b = await openPresence(P1.id, 'shim-a-child');
ok('a second connection with the same id is counted', c1b.status === 200 && c1b.first.connections === 2, c1b.first);
body = await cmd('get_project_info', {}, P1);
ok('every reply to a shared id carries the note, naming the fix', body.ok && body.result.session && body.result.session.connections === 2 && /held by 2 connections/.test(body.result.session.note) && /Name `project` on every call/.test(body.result.session.note), body.result.session);
body = await cmd('project', { op: 'list' }, P1);
ok('...a no-project tool too', body.ok && body.result.session && body.result.session.connections === 2, body.result.session);
c1b.req.destroy();
await sleep(80);
body = await cmd('get_project_info', {}, P1);
ok('the note is gone when the second connection closes, and the binding stayed', body.ok && !body.result.session && body.result.name === 'gamma' && body.result.project.bound === true, body.result);
c1.req.destroy();
await sleep(80);
body = await cmd('project', { op: 'list' }, P2);
gamma = body.ok && body.result.projects.find((p) => p.name === 'gamma');
ok('closing the last connection releases the binding at once (no timer)', gamma && gamma.held_by === null, gamma);
ok('...and the session is no longer listed as alive', !body.result.sessions.some((x) => x.id === 'pres-1'), body.result.sessions);
body = await cmd('place_cube', { elements: [{ from: [0, 0, 0], to: [1, 1, 1] }], project: 'gamma' }, P2);
ok('the edit another session was refused a moment ago now lands', body.ok, body);
const c3 = await openPresence('pres-3', 'shim-c');
ok('a presence connection is open when the plugin stops', c3.status === 200 && api.status().connections === 1, api.status());
api.stop();
ok('stopped', api.status().listening === false);

// =============================================================================================
section('12. the window: whose it is, how one is asked for, and how it ends');
// =============================================================================================
// Design section 6.3, step 2. Blockbench has ONE active tab per window and a second window is a
// fresh realm, so the window is the unit of ownership: this window's plugin takes the first free
// port at or above the base and that port IS its name; a shim scans the same range and claims the
// first window nobody holds. What the harness cannot reach is the second REALM - `new_window` in
// the app loads a second copy of this plugin into a new window, and the stub below stands in for
// only what a scanning shim SEES of it (another port in the range answering /hello, unclaimed,
// under a different name). That the copy starts at all is the live arm's to prove.
const occupy = (port) => new Promise((resolve) => {
    const srv = http.createServer((q, r) => { r.writeHead(204); r.end(); });
    srv.once('error', () => resolve(null));
    srv.listen(port, '127.0.0.1', () => resolve(srv));
});
/**
 * A base with a whole free span above it, chosen OUTSIDE the ephemeral range (49152+ on Windows) and
 * clear of the plugin's own 25801. An ephemeral port is free when you ask and gone a moment later,
 * because the OS hands the neighbourhood out to any outbound socket - which made this section fail
 * one run in four before the base moved down here. The span is proved free by binding all of it at
 * once, and only the base is kept: everything above it is what the window must be able to walk into.
 */
const pickBase = async (span) => {
    for (let base = 25901; base < 26400; base += span) {
        const held = [];
        for (let i = 0; i < span; i++) held.push(await occupy(base + i));
        const all = held.every(Boolean);
        // Keep only the base when the whole span was free; give everything else back at once.
        for (let i = all ? 1 : 0; i < held.length; i++) if (held[i]) await new Promise((r) => held[i].close(r));
        if (all) return { base, squatter: held[0] };
    }
    return { base: null, squatter: null };
};
const presenceAt = (base, id, client) => new Promise((resolve, reject) => {
    const req = http.get(base + '/presence', { headers: Object.assign({ 'X-MCPTK-Client': client }, id ? { 'X-MCPTK-Session': id } : {}) }, (pres) => {
        if (pres.statusCode !== 200) { resolve({ req, status: pres.statusCode }); pres.resume(); return; }
        pres.setEncoding('utf8');
        pres.once('data', (d) => resolve({ req, status: 200, first: JSON.parse(d.split('\n')[0]) }));
    });
    req.on('error', reject);
});

// The base taken by something else, and the whole span above it free: the window must walk.
const picked = await pickBase(16);
const wbase = picked.base;
const squatter = picked.squatter;
ok('a free span, with something else already on the base port', !!squatter && !!wbase, wbase);
g._openStubWindow = () => new Promise((resolve) => {
    let port = wbase;
    const id = 'win-stub2';
    const tryPort = () => {
        const srv = http.createServer((q, r) => {
            const payload = JSON.stringify({ ok: true, app: 'blockbench', plugin: 'mcptoolkit_bridge', plugin_version: 'stub-second-window', window: id, port, base_port: wbase, span: api.status().span, reserved: false, claimed_by: null, tools: 26 });
            r.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
            r.end(payload);
        });
        srv.once('error', () => { try { srv.close(); } catch (e) { /* never listened */ } port++; if (port < wbase + api.status().span) tryPort(); else resolve(null); });
        srv.listen(port, '127.0.0.1', () => resolve({ srv, port, window: id }));
    };
    tryPort();
});
api.settings({ port: wbase });
api.start({ prompt: false });
await sleep(150);
st = api.status();
ok('the window takes the first FREE port at or above the base', st.listening === true && st.port === wbase + 1, st);
ok('...and the base it scanned from, and how far, are on the status', st.base_port === wbase && st.span >= 2 && st.url === 'http://127.0.0.1:' + (wbase + 1), st);
ok('the window has a name of its own', /^win-[0-9a-z]{4,}$/.test(st.window) && st.agent === false && st.claimed_by === null, st);
const WURL = 'http://127.0.0.1:' + st.port;
const wclaim = (payload) => fetch(WURL + '/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then(async (r) => Object.assign({ _status: r.status }, await r.json()));
const wopen = (payload) => fetch(WURL + '/window', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then(async (r) => Object.assign({ _status: r.status }, await r.json()));
const whello = () => fetch(WURL + '/hello').then((r) => r.json());
const wcmd = (tool, args, sb) => fetch(WURL + '/cmd', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool, args, session: sb }) }).then((x) => x.json());
let hi = await whello();
ok('GET /hello carries the window block a scanning shim reads', hi.ok && hi.window === st.window && hi.port === wbase + 1 && hi.base_port === wbase && hi.claimed_by === null, hi);
// A WINDOW IS THE PERSON'S UNLESS SOMEBODY ASKED FOR IT (design section 10). This one was opened by
// nobody, so it is theirs: not agent-born, not handed over, and `reserved` derived true so that a
// shim from before 0.7.0 - which read that field as "yours to take" - leaves it alone as well.
ok('a window nobody asked for belongs to the person at the keyboard', hi.agent === false && hi.allow_agents === false && hi.reserved === true, hi);
let cl = await wclaim({});
ok('a claim with no session is 400, naming both ways to say who you are', cl._status === 400 && /X-MCPTK-Session/.test(cl.error), cl);
const W1 = { id: 'win-1', client: 'shim-1' };
const W2 = { id: 'win-2', client: 'shim-2' };
const w1p = await presenceAt(WURL, W1.id, W1.client);
const w2p = await presenceAt(WURL, W2.id, W2.client);
ok('two shims are connected to the one window', w1p.status === 200 && w2p.status === 200, [w1p.status, w2p.status]);
cl = await wclaim({ session: W1 });
ok('a person\'s window refuses a claim, and names both ways out', cl._status === 200 && cl.ok === false && /^not an agent window/.test(cl.error) && /POST \/window/.test(cl.hint) && /Let agents use this window/.test(cl.hint), cl);
body = await wcmd('project', { op: 'list' }, W1);
ok('...but still answers calls: what it refuses is being CLAIMED, not being spoken to', body.ok === true, body.ok === false ? body : true);

// HANDING OVER A WINDOW A PERSON IS SITTING IN, the one deliberate exception to the flip. It is not
// co-authoring: an agent that claims it still steals the active tab whenever it reads its own model
// (design section 4), because one project is live at a time. Working BESIDE a person is a separate
// route (`connect`) and is not built.
api.settings({ shared_port: null });
api.share(true);
hi = await whello();
ok('a person can hand their window over, and /hello says which kind of window that makes it', hi.allow_agents === true && hi.agent === false && hi.reserved === false, hi);
cl = await wclaim({ session: W1 });
ok('...and an agent session may then claim it', cl.ok === true && cl.claimed === true, cl);
api.share(false);
hi = await whello();
ok('taking it back takes the claim with it: nobody keeps a window that is no longer on offer', hi.allow_agents === false && hi.reserved === true && hi.claimed_by === null, hi);
cl = await wclaim({ session: W1 });
ok('...and the next claim is refused again', cl.ok === false && /^not an agent window/.test(cl.error), cl);

// ASKING FOR A WINDOW, AND THE HANDOFF THAT MAKES IT AN AGENT'S. `POST /window` leaves the asker's
// id in shared storage; the window that is born takes it as it wins its port, which is what makes
// that window agent-born AND pre-claimed for the session that paid the two seconds for it. The
// second realm is what no stub can reach, so the harness plays both parts: this window does the
// asking, and `adopt()` - the same call the port walk makes - stands in for the new window consuming
// the entry.
let ow = await wopen({ session: W1 });
ok('POST /window opens one, says who asked and whether it will autostart its bridge', ow.ok === true && ow.opened === true && ow.requested_by === 'win-1' && ow.autostart === true, ow);
ok('...through the entry point the measurement drove (click, not the keybind path)', JSON.stringify(g._new_window) === JSON.stringify(['click']), g._new_window);
const second = await g._stubWindow;
ok('...and a second window is then in the range, on the next free port, under its own name', second && second.port === wbase + 2, second);
hi = await fetch('http://127.0.0.1:' + second.port + '/hello').then((r) => r.json());
ok('...unclaimed, so the scanning shim can have it', hi.window === 'win-stub2' && hi.window !== st.window && hi.claimed_by === null, hi);
ok('the window born from that ask takes the identity left for it', api.adopt() === true && api.window().agent === true, api.window());
hi = await whello();
ok('...and is PRE-CLAIMED for the session that asked, before that session has called it once', hi.agent === true && hi.reserved === false && hi.claimed_by && hi.claimed_by.session === 'win-1', hi);
ok('an entry is CONSUMED, not read: a window opened by hand afterwards is still the person\'s', api.adopt() === false, api.adopt());
// A `new_window` that throws makes no window, so the identity left for it must not sit there waiting
// to be taken by the next window a person opens by hand.
const realNewWindow = g.BarItems.new_window;
g.BarItems.new_window = { click() { throw new Error('refused by the app'); } };
ow = await wopen({ session: W2 });
ok('an ask the app refuses is reported, not swallowed', ow.ok === false && /new_window refused: refused by the app/.test(ow.error), ow);
ok('...and takes back the identity it had left for a window that is not coming', api.adopt() === false, api.adopt());
delete g.BarItems.new_window;
ow = await wopen({ session: W1 });
ok('a Blockbench with no new_window action refuses and says what to do by hand', ow.ok === false && /no new_window action/.test(ow.error) && /New Window/.test(ow.hint), ow);
g.BarItems.new_window = realNewWindow;

// THE PRE-CLAIM MAKES THE SESSION RECORD, and that is the only reason it holds. `claimHolder()`
// resolves the id through `sessions`; the window that runs `session(sb)` is the one that was ASKED,
// not the one that is born. Until 0.8.0 a window pre-claimed for the session that paid two seconds
// for it therefore answered `claimed_by: null`, and the next scan could take it out from under
// them. Found LIVE on 2026-09-10, on the very window that ask had just opened.
//
// Deleting the record is what makes this a falsifier rather than a restatement: in ONE process the
// ask and the adoption share a `sessions` object, so the id is always there and nothing is proved.
// The window is opened through a no-op `new_window` so that no stub server joins the range and the
// port arithmetic below is untouched, and the claim is put back the way this section found it.
const noopNewWindow = g.BarItems.new_window;
g.BarItems.new_window = { click() {} };
await wopen({ session: { id: 'win-4', client: 'shim-4' } });
g.BarItems.new_window = noopNewWindow;
delete api.sessions()['win-4'];
const adopted4 = api.adopt();
const preclaimed = await whello();
ok('the pre-claim REGISTERS the asker, which is the only reason claimed_by resolves in the window that is born', adopted4 === true && preclaimed.claimed_by && preclaimed.claimed_by.session === 'win-4', preclaimed.claimed_by);
await wclaim({ session: { id: 'win-4' }, release: true });
await wclaim({ session: W1 });

// CLAIMS, on the agent window that ask made.
ok('/hello says whose window it is, and that they are connected', hi.claimed_by.session === 'win-1' && hi.claimed_by.client === 'shim-1' && hi.claimed_by.connected === true, hi.claimed_by);
cl = await wclaim({ session: W2 });
ok('the second shim is refused: 200 with ok:false, the holder named, and where else to look', cl._status === 200 && cl.ok === false && /^claimed_by: session win-1 \(shim-1\) holds this window, connected$/.test(cl.error) && /POST \/window/.test(cl.hint), cl);
cl = await wclaim({ session: W1 });
ok('the holder re-claiming is a rejoin, not a second claim', cl.ok === true && cl.rejoined === true, cl);
body = await wcmd('project', { op: 'list' }, W2);
ok('the claim steers DISCOVERY and refuses no call: the unclaiming session still reads', body.ok === true && Array.isArray(body.result.projects), body.ok === false ? body : true);
ok('...and op:list says which window this is and that it is not theirs', body.result.window && body.result.window.name === st.window && body.result.window.port === wbase + 1 && body.result.window.yours === false && body.result.window.agent === true, body.result.window);
body = await wcmd('project', { op: 'list' }, W1);
ok('...and yours:true for the session that holds it', body.result.window.yours === true, body.result.window);
cl = await wclaim({ session: W2, release: true });
ok('a release by a session that never held it releases nothing, and says so', cl.ok === true && cl.released === false && cl.claimed_by.session === 'win-1', cl);
cl = await wclaim({ session: W1, release: true });
ok('the holder releases it', cl.ok === true && cl.released === true && cl.claimed_by === null, cl);
cl = await wclaim({ session: W2 });
ok('...and the window it turned down is claimable now', cl.ok === true && cl.claimed_by.session === 'win-2', cl);
w2p.req.destroy();
await sleep(120);
hi = await whello();
ok('a claim dies with the session that holds it, the moment its presence closes', hi.claimed_by === null, hi.claimed_by);

// A WINDOW CLAIM IS NOT A PROJECT BINDING. A binding survives a dropped socket for `hold_ms` because
// unsaved work is behind it; a claim has nothing behind it, so it dies with the socket, and the only
// grace is the seconds a fresh claim needs before presence can possibly have arrived. Getting that
// wrong is what left an abandoned window looking taken for two minutes, so that the next session
// opened another rather than reusing it (design section 10). `claim_grace_ms` is shortened here the
// way `hold_ms` is; what ships is 30 seconds.
api.settings({ claim_grace_ms: 300 });
cl = await wclaim({ session: { id: 'win-3', client: 'curl' } });
hi = await whello();
ok('a fresh claim holds without presence, which is what keeps a PRE-CLAIMED window from being taken', cl.ok === true && hi.claimed_by.session === 'win-3' && hi.claimed_by.connected === false, hi.claimed_by);
await sleep(400);
hi = await whello();
ok('...and once that grace is out an unconnected claim is dead, however recently it called', hi.claimed_by === null, hi.claimed_by);
ok('...while the SESSION is still inside hold_ms, because a binding and a claim are not the same lease', api.sessions()['win-3'] !== undefined, Object.keys(api.sessions()));
api.settings({ claim_grace_ms: null });

// THE TITLE: which window belongs to whom, readable from the taskbar without focusing it. Before
// 0.7.0 the only place that fact existed was /hello, from outside the app.
// AND THE PORT IS ALWAYS IN IT since 0.8.0 (section 11.3). Six windows were found maximised onto the
// same pixels under the same title, which is what "hidden from Windows entirely" turned out to mean;
// a person cannot act on a row of them from the taskbar unless every one says which it is.
const wport = wbase + 1;
g.document.title = 'dragon_scales - Blockbench';
cl = await wclaim({ session: W1 });
ok('a claimed window says whose it is in its title, and which port it is', g.document.title === '[' + wport + ' win-1 shim-1] dragon_scales - Blockbench', g.document.title);
cl = await wclaim({ session: W1, release: true });
ok('...and an unclaimed agent window says that instead, over the name Blockbench wrote', g.document.title === '[' + wport + ' agent] dragon_scales - Blockbench', g.document.title);
// The old prefix comes off by being REMEMBERED, not by matching a shape: a project called
// "[wip] dragon" must keep its own brackets.
g.document.title = '[' + wport + ' agent] [wip] dragon - Blockbench';
cl = await wclaim({ session: W1 });
ok('...and a project whose own name starts with brackets keeps them', g.document.title === '[' + wport + ' win-1 shim-1] [wip] dragon - Blockbench', g.document.title);
await wclaim({ session: W1, release: true });

// THE RECENT CALLS the panel shows. The panel needs a renderer; what it reads does not.
const rec = api.recent();
ok('every call is remembered, with its name, its cost and whether it worked', rec.length > 0 && rec.every((r) => typeof r.name === 'string' && typeof r.ms === 'number' && typeof r.ok === 'boolean') && rec.some((r) => r.name === 'project'), rec.slice(-2));

await new Promise((r) => second.srv.close(r));
api.stop();
st = api.status();
ok('stopping gives up the port AND the claim: a window with no door owns nothing', st.listening === false && st.port === null && st.claimed_by === null && st.url === null, st);
// The whole range taken is the one failure the scan can end in, and it must name the range.
const squatters = [squatter];
for (let i = 1; i < st.span; i++) squatters.push(await occupy(wbase + i));
ok('...with every port in the range held by something else', squatters.every(Boolean), squatters.map((x, i) => (x ? '' : wbase + i)).filter(Boolean));
api.start({ prompt: false });
await sleep(250);
st = api.status();
ok('with every port in the range taken it says so, and how wide it looked', st.listening === false && new RegExp('every port from ' + wbase + ' to ' + (wbase + st.span - 1) + ' is taken').test(st.error || ''), st);
for (const srv of squatters) if (srv) await new Promise((r) => srv.close(r));

// A STOP WHILE A LISTEN IS STILL IN FLIGHT. The listen is asynchronous, so `start()` returns before
// any port has been won, and "Stop right after Start" is the ordinary shape of this rather than a
// contrived one. Two halves, because the walk has two ways to be in flight and each is cancelled by
// a different check: a listen that will SUCCEED (the callback below), and a listen that will fail
// with EADDRINUSE and recurse (the error handler). Without either, the pending callback lands after
// the stop, sets `server`, and leaves a window serving on a port that was just given up.
api.start({ prompt: false });
api.stop();
await sleep(250);
st = api.status();
ok('a stop during a pending listen cancels it: no door, and nothing claimed', st.listening === false && st.port === null && st.url === null, st);
let pendingFree = await occupy(wbase);
ok('...and the port that listen was about to win is genuinely free', !!pendingFree, wbase);
const walkSquatter = pendingFree; // keep the base occupied: the next start has to WALK
api.start({ prompt: false });
api.stop();
await sleep(250);
st = api.status();
ok('a stop during the port WALK cancels that too', st.listening === false && st.port === null, st);
const walkFree = [];
for (let i = 1; i < 4; i++) walkFree.push(await occupy(wbase + i));
ok('...and no port above the base was left bound either', walkFree.every(Boolean), walkFree.map((x, i) => (x ? '' : wbase + i + 1)).filter(Boolean));
for (const srv of walkFree) if (srv) await new Promise((r) => srv.close(r));

// And a cancelled walk must stop WALKING, not merely stop serving. With the whole span taken it
// would otherwise probe every port in it and then report "every port is taken" out of a bridge that
// was stopped before it won anything - an error about a scan nobody is waiting on. (A clean start
// first, because the exhausted-range check above deliberately left an error standing.)
api.start({ prompt: false });
await sleep(200);
ok('a clean start clears the error the exhausted range left', api.status().listening === true && !api.status().error, api.status());
api.stop();
const spanSquatters = [];
for (let i = 1; i < st.span; i++) spanSquatters.push(await occupy(wbase + i));
ok('the whole span is occupied, so an uncancelled walk would exhaust it', spanSquatters.every(Boolean), spanSquatters.length);
api.start({ prompt: false });
api.stop();
await sleep(400);
ok('a cancelled walk reports no error: it was cancelled, not exhausted', !api.status().error, api.status().error);
for (const srv of spanSquatters) if (srv) await new Promise((r) => srv.close(r));

// A HAND-OVER THAT SURVIVES A RESTART. Since 0.7.0 what is stored is the opposite of what 0.6.0
// stored: a person's window needs no protecting, so the rare and deliberate act - handing THIS one
// to agents - is the one worth remembering. The stored form is a PORT rather than a flag for the
// reason it always was: settings are ONE store every window reads at boot and writes back whole
// (design section 5), so a stored `shared:true` would hand over every window at once, while a port
// number can only ever be true of the one window that won it.
api.settings({ shared_port: null });
api.share(false);
api.start({ prompt: false });
await sleep(200);
st = api.status();
// (This instance is agent-born from the ask above and stays so - a fresh renderer is what makes a
// window the person's again, and the harness has only the one. What this block is about is the
// STORED half, which starts empty here.)
ok('a window starts with no hand-over of its own, on the port above the occupied base', st.listening === true && st.port === wbase + 1 && st.allow_agents === false, st);
api.share(true, true);
ok('handing over with persist stores the PORT this window won, not a per-window flag', api.settings().shared_port === wbase + 1 && api.status().allow_agents === true, api.settings().shared_port);
// The in-memory flag is dropped on purpose here: a restart is a fresh renderer with `allow_agents`
// back at false, and what has to bring it back is the STORED port and nothing else.
api.stop();
api.share(false);
api.start({ prompt: false });
await sleep(200);
ok('a window that wins the stored port comes back HANDED OVER with nobody doing it again', api.status().allow_agents === true && api.status().port === wbase + 1, api.status());
api.share(false, true);
ok('taking it back clears the stored port, because the port is this one', api.settings().shared_port === null && api.status().allow_agents === false, api.settings().shared_port);
api.settings({ shared_port: wbase + 9 });
api.stop();
api.share(false);
api.start({ prompt: false });
await sleep(200);
ok('a hand-over made on ANOTHER port leaves this window the person\'s', api.status().allow_agents === false && api.status().port === wbase + 1, api.status());
api.share(false, true);
ok('...and taking this one back does not take back the one handed over elsewhere', api.settings().shared_port === wbase + 9, api.settings().shared_port);
api.settings({ shared_port: null });

// THE END OF A WINDOW. Nothing anywhere closed one before 0.7.0 - `POST /window` had no counterpart -
// so an afternoon of sessions left a row of empty windows at ~220 MB each for a person to close by
// hand. An agent-born window now closes itself once nothing holds it and nothing is open in it, and
// `project op:close` emptying it starts that clock rather than waiting for a sweep. The three
// refusals below are the whole of the safety: a window with work in it, a window somebody holds, and
// the LAST window, which cannot go because closing it would quit the app.
const openProjects = g.ModelProject.all.slice();
// This section's earlier phase already asked for a window as W1, and since 0.10.0 one session gets
// one new window per `birth_ms` (section 12.4). A real session would have waited that out; here the
// ask is forgotten, because what this phase is about is the END of a window and not the ask.
api.forgetAsk('win-1');
api.settings({ empty_grace_ms: 60 });
api.stop();
api.start({ prompt: false });
await sleep(200);
const WPORT = api.status().port;
// A window this plugin was asked for, standing in for the second realm again.
await fetch('http://127.0.0.1:' + WPORT + '/window', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: W1 }) }).then((r) => r.json());
const asked = await g._stubWindow;
ok('the ask is answered by a window in the range for the sweep to find', !!asked, asked);
ok('...and this one adopts the identity left for it, so it is agent-born', api.adopt() === true && api.window().agent === true, api.window());
const held = await fetch('http://127.0.0.1:' + WPORT + '/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: W1 }) }).then((r) => r.json());
ok('...and the session it was opened for holds it', held.ok === true && held.claimed_by.session === 'win-1', held);
await sleep(120);
ok('a window a session is holding does not close, however long it has been empty', (await api.sweep()) === null && !g._closed, g._closed);
await fetch('http://127.0.0.1:' + WPORT + '/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: W1, release: true }) });
ok('a window with a project still open does not close either', g.ModelProject.all.length > 0 && (await api.sweep()) === null && !g._closed, g._closed);
// Empty and unheld, with the grace out: everything is true except that it is not alone.
g.ModelProject.all.length = 0;
g.Project = null;
await api.sweep();
await sleep(120);
await new Promise((r) => asked.srv.close(r));
ok('...and neither does the LAST window: closing it would quit Blockbench', (await api.sweep()) === null && !g._closed, g._closed);
// With another window answering, the same state closes it.
const neighbour = await new Promise((resolve) => {
    const srv = http.createServer((q, r) => {
        const payload = JSON.stringify({ ok: true, app: 'blockbench', window: 'win-neighbour', port: wbase + 3, claimed_by: null });
        r.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
        r.end(payload);
    });
    srv.listen(wbase + 3, '127.0.0.1', () => resolve(srv));
});
g.AutoBackup.entries = { 'other-window': 'canary' };
ok('an agent window that is empty, unheld and not alone closes itself', (await api.sweep()) === true && g._closed === 1, g._closed);
ok('...giving its port back on the way out, so a scan finds a shut door and not a dying one', api.status().listening === false && api.status().port === null, api.status());
// It goes around `closeBlockbenchWindow` because that function is module-scoped and unreachable
// (design section 8) - and that is the safer half of the bargain, because the function we cannot call
// is the one that wipes EVERY window's crash-recovery entries.
ok('...and takes no backups with it: an automatic close never reaches removeAllBackups at all', g.AutoBackup.entries['other-window'] === 'canary', g.AutoBackup.entries);
g.AutoBackup.entries = {};
await new Promise((r) => neighbour.close(r));
api.settings({ empty_grace_ms: null });
g.ModelProject.all.push(...openProjects);
g.Project = openProjects[openProjects.length - 1] || null;
w1p.req.destroy();
if (walkSquatter) await new Promise((r) => walkSquatter.close(r));

// =============================================================================================
section('13. the dock: the one place that outranks a window');
// =============================================================================================
// BLOCKBENCH_ISOLATION_DESIGN.md section 11. Section 10 gave a window an owner and then left every
// window to govern itself out of its own memory, and a live scan on 2026-09-10 found what that
// costs: six windows serving, every one of them empty, and not one of them with a death condition
// that could fire. Three were not agent-born, so their sweep never started at all; three were held
// by sessions that had not gone away. Nothing anywhere had a close route.
//
// The dock is the answer, and the shape is forced by section 11.4: Blockbench's plugin sandbox has
// no `electron` and no `@electron/remote`, so there is no window list to read, nothing to focus from
// outside and nothing to destroy. EVERY act here is a request the target window serves for itself,
// which is why the stubs below are servers and not objects.
const jget = async (port, path) => {
    const r = await fetch('http://127.0.0.1:' + port + path);
    const j = await r.json().catch(() => null);
    return Object.assign({ _s: r.status }, j || {});
};
const jpost = async (port, path, body) => {
    const r = await fetch('http://127.0.0.1:' + port + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    const j = await r.json().catch(() => null);
    return Object.assign({ _s: r.status }, j || {});
};
const serveJson = (r, out) => {
    const payload = JSON.stringify(out);
    r.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
    r.end(payload);
};
const readJson = (q) => new Promise((resolve) => {
    let raw = '';
    q.on('data', (d) => { raw += d; });
    q.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch (e) { resolve({}); } });
});
/** A second window: it serves the three routes every window owes whoever asks, and counts them. */
const stubWindow = (port, info) => new Promise((resolve) => {
    const state = { port, info, closed: 0, focused: 0, roles: [], forced: null };
    const srv = http.createServer(async (q, r) => {
        const url = (q.url || '/').split('?')[0];
        if (q.method === 'GET' && url === '/hello') return serveJson(r, Object.assign({ ok: true, app: 'blockbench', port, claimed_by: null }, state.info));
        const body = await readJson(q);
        if (url === '/close') { state.closed++; state.forced = !!body.force; return serveJson(r, { ok: true, closing: true, window: state.info.window, port }); }
        if (url === '/role') { state.roles.push(body); state.info.role = body.role; return serveJson(r, { ok: true, role: body.role }); }
        if (url === '/focus') { state.focused++; return serveJson(r, { ok: true, asked: true }); }
        serveJson(r, { ok: false, error: 'no route ' + url });
    });
    srv.listen(port, '127.0.0.1', () => { state.srv = srv; resolve(state); });
});
/** A dock, for testing the other half: what a window does when it FINDS one. */
const stubDock = (port, answer) => new Promise((resolve) => {
    const state = { port, answer, hellos: 0, beats: 0, last: null };
    const srv = http.createServer(async (q, r) => {
        const url = (q.url || '/').split('?')[0];
        const body = await readJson(q);
        state.last = body;
        if (url === '/dock/hello') { state.hellos++; return serveJson(r, Object.assign({ ok: true, dock: { window: 'stub-dock', port } }, state.answer)); }
        if (url === '/dock/beat') { state.beats++; return serveJson(r, Object.assign({ ok: true }, state.answer)); }
        serveJson(r, { ok: false, error: 'not the dock' });
    });
    srv.listen(port, '127.0.0.1', () => { state.srv = srv; resolve(state); });
});

const dpick = await pickBase(8);
const dbase = dpick.base;
ok('a free span for the dock', !!dbase && !!dpick.squatter, dbase);
await new Promise((r) => dpick.squatter.close(r));
// `dock_scan_ms` is parked high so the roster only moves when this test moves it; what ships is 5s.
api.settings({ port: dbase, dock_port: null, beat_stale_ms: 400, reach_ms: 600, birth_ms: 2000, dock_scan_ms: 600000, empty_grace_ms: null });
api.start({ prompt: false });
await sleep(200);
const DPORT = api.status().port;
ok('the bridge is listening again, on the base of a clean span', DPORT === dbase && api.status().listening === true, api.status());

// --- what a window does when it finds a dock ------------------------------------------------
// The half that cures section 11.3(a): before this, `agentBorn` was one in-memory boolean set from a
// 120-second localStorage handoff inside the port-listen callback, and NOTHING could correct it. Two
// of the six windows found on 2026-09-10 were stuck as the person's that way, permanently.
const sdock = await stubDock(dbase + 1, { role: 'agent', claim_for: 'sess-x' });
api.settings({ dock_port: dbase + 1 });
ok('a window is not the dock until it is made one, and says so with a 404', (await jget(DPORT, '/dock'))._s === 404 && (await jpost(DPORT, '/dock/beat', {}))._s === 404, await jget(DPORT, '/dock'));
// `POST /close` is the route section 11.3(c) found missing everywhere, and it refuses for the one
// reason a close should: there is work here that nobody saved.
const cdirty = await jpost(DPORT, '/close', {});
ok('POST /close refuses while there is unsaved work, naming both the work and the way past it', cdirty.ok === false && /unsaved work here/.test(cdirty.error) && /force/.test(cdirty.hint), cdirty);
const found = await api.findDock();
ok('a window asks the dock what it is as soon as it has a port to be told about', found === dbase + 1 && sdock.hellos === 1, { found, hellos: sdock.hellos });
ok('...and it says which window and which port it is asking about', sdock.last.window === api.status().window && sdock.last.port === DPORT, sdock.last);
ok('the dock\'s answer OUTRANKS the boot-time guess: this window is an agent\'s now', api.window().agent === true && api.window().role === 'agent' && api.window().claimed_by.session === 'sess-x', api.window());
// And it can say something else later. A role that can be restated is the whole difference between
// a window that can be recycled and the row of permanently-the-person's empties (section 11.7).
sdock.answer = { role: 'person' };
await api.beat();
ok('a re-labelling reaches the window on its next beat: a stuck role is recoverable', api.window().agent === false && api.window().role === 'person' && api.window().claimed_by === null, api.window());
ok('...and the beat carries what this window is doing, not just that it is alive', sdock.beats === 1 && Array.isArray(sdock.last.open) && sdock.last.port === DPORT, sdock.last);
await new Promise((r) => sdock.srv.close(r));
await api.beat();
ok('a dock that goes away is forgotten rather than beaten at forever', api.dockPort() === null, api.dockPort());

// --- being the dock --------------------------------------------------------------------------
api.becomeDock();
ok('the menu action makes this window the dock', api.role() === 'dock' && api.window().role === 'dock', api.window());
ok('...and remembers its port, which is the hint every other window tries before scanning', api.status().dock_port === DPORT, api.status());
let cl2 = await jpost(DPORT, '/claim', { session: { id: 'someone' } });
ok('the dock is never claimable: it is nobody\'s to work in', cl2.ok === false && /not an agent window/.test(cl2.error), cl2);
ok('...and has no other role to be given', api.setRole('agent').ok === false && api.role() === 'dock', api.role());
cl2 = await jpost(DPORT, '/close', {});
ok('THE DOCK DOES NOT CLOSE ITSELF, which is what makes every other window safe to close', cl2.ok === false && /does not close itself/.test(cl2.error), cl2);
cl2 = await jpost(DPORT, '/dock/close', { port: DPORT });
ok('...through its own route either, so there is no last-window race left to lose', cl2.ok === false && /does not close/.test(cl2.error), cl2);

// A window registering, and then reporting.
const wa = await stubWindow(dbase + 2, { window: 'win-a', role: 'person' });
let reg = await jpost(DPORT, '/dock/hello', { window: 'win-a', port: dbase + 2, role: 'person' });
ok('a window nobody asked for registers as the PERSON\'S: the section 10 default, now decided in one place', reg.ok === true && reg.role === 'person' && reg.claim_for === null && reg.dock.port === DPORT, reg);
await jpost(DPORT, '/dock/beat', { window: 'win-a', port: dbase + 2, role: 'person', claimed_by: null, open: [{ name: 'dragon', saved: false }], dirty: 1, last_call: { name: 'place_cube', ok: true, session: 's9', s_ago: 2 } });
let roster = await jget(DPORT, '/dock');
let row = roster.windows.find((w) => w.port === dbase + 2);
ok('the roster carries what is open, what is unsaved and who last did anything there', row.state === 'live' && row.dirty === 1 && row.open[0].name === 'dragon' && row.last_call.name === 'place_cube' && row.last_call.session === 's9', row);
ok('...and never lists the dock among the windows it is watching', !roster.windows.some((w) => w.port === DPORT) && roster.dock.port === DPORT, roster.windows.map((w) => w.port));

// ALLOCATION. The dock triggers the window AND receives its `/dock/hello`, so it learns the port
// directly - which deletes 0.7.0's race, where the asker could not know which port its window would
// win and had to go and scan for it while another session's scan raced it there.
let born = null;
g._new_window = [];
g._openStubWindow = async () => {
    born = await stubWindow(dbase + 3, { window: 'win-born', role: 'person' });
    await jpost(DPORT, '/dock/hello', { window: 'win-born', port: dbase + 3, role: 'person' });
    return born;
};
const alloc = await jpost(DPORT, '/dock/window', { session: { id: 'sess-1' } });
ok('POST /dock/window makes a window and answers WITH ITS PORT', alloc.ok === true && alloc.made === true && alloc.port === dbase + 3, alloc);
ok('...and the window it made is an agent\'s, pre-claimed for whoever paid for it', (await jget(DPORT, '/dock')).windows.find((w) => w.port === dbase + 3).role === 'agent', (await jget(DPORT, '/dock')).windows);

// An agent window whose session has gone is the thing 0.7.0 could neither see nor reuse.
await jpost(DPORT, '/dock/beat', { window: 'win-born', port: dbase + 3, role: 'agent', claimed_by: null, open: [], dirty: 0 });
roster = await jget(DPORT, '/dock');
row = roster.windows.find((w) => w.port === dbase + 3);
ok('an agent window standing empty with nobody holding it reads as an ORPHAN', row.state === 'orphan', row);
g._new_window = [];
const reuse = await jpost(DPORT, '/dock/window', { session: { id: 'sess-2' } });
ok('REUSE BEFORE CREATION: the next session is handed that one, and no seventh window is opened', reuse.ok === true && reuse.reused === true && reuse.port === dbase + 3 && g._new_window.length === 0, { reuse, opened: g._new_window });
ok('...by being told to be an agent\'s again, over the route only that window can serve', born.roles.length === 1 && born.roles[0].role === 'agent' && born.roles[0].claim_for === 'sess-2', born.roles);
const rejoin = await jpost(DPORT, '/dock/window', { session: { id: 'sess-2' } });
ok('...and a session that already holds one is handed the same window back, not another', rejoin.ok === true && rejoin.rejoined === true && rejoin.port === dbase + 3, rejoin);

// CLOSING, which nothing in the system could do before 0.8.0 at all (section 11.3c).
const closed = await jpost(DPORT, '/dock/close', { port: dbase + 3 });
ok('the dock closes a window through the route only that window can serve', closed.ok === true && closed.closing === true && born.closed === 1, { closed, asked: born.closed });
ok('...and the row goes with it', !(await jget(DPORT, '/dock')).windows.some((w) => w.port === dbase + 3), (await jget(DPORT, '/dock')).windows.map((w) => w.port));

// THE TWO PICTURES, and what their disagreement is for (section 11.8).
const wc = await stubWindow(dbase + 4, { window: 'win-c', role: 'agent' });
await api.scan();
roster = await jget(DPORT, '/dock');
row = roster.windows.find((w) => w.port === dbase + 4);
ok('a window that serves but has never beaten is SILENT: a wedged renderer, or a plugin from before 0.8.0', row.state === 'silent' && row.role === 'agent', row);
await new Promise((r) => wa.srv.close(r));
await api.scan();
roster = await jget(DPORT, '/dock');
row = roster.windows.find((w) => w.port === dbase + 2);
ok('a window that beat and then stopped answering is a GHOST', row.state === 'ghost' && row.serving === false, row);
const ghost = await jpost(DPORT, '/dock/close', { port: dbase + 2 });
ok('...and the dock says plainly that it cannot close one, because a plugin cannot reach another window', ghost.ok === false && /not answering/.test(ghost.error) && /by hand/.test(ghost.hint), ghost);
await new Promise((r) => wc.srv.close(r));

// TWO DOCKS, and how that resolves without anything being exchanged. Seen live 2026-09-10: two
// windows both answering `role: "dock"`, each having written its OWN port into the shared settings
// every other window reads, so a window was told a different address depending on which one answered
// it. The LOWEST PORT WINS - the one fact both can see, neither can argue with, and nothing has to
// be exchanged to agree on - and the higher stands down into an ordinary window.
//
// The rival has to sit BELOW this window for the rule to bite, so the bridge is restarted with the
// base already taken and walks up to the next port, which is the arrangement a second dock actually
// arrives in.
api.stop();
const rival = await stubWindow(dbase, { window: 'win-rival', role: 'dock' });
api.start({ prompt: false });
await sleep(250);
const DPORT2 = api.status().port;
ok('the bridge walked past the rival and took the next port', DPORT2 === dbase + 1, api.status());
ok('and one scan of the range finds where the dock is, which is what openDock checks before making another', (await api.whereIsDock()) === dbase, await api.whereIsDock());
api.becomeDock();
ok('two docks, for the moment before either has looked', api.role() === 'dock' && api.status().dock_port === DPORT2, api.status());
await api.scan();
ok('...and the one with the HIGHER port stands down: one dock, whatever order they were made in', api.role() === 'person' && api.status().dock_port === dbase, api.status());
ok('...taking its roster with it, so no half-picture is left answering', (await jget(DPORT2, '/dock'))._s === 404, await jget(DPORT2, '/dock'));
await new Promise((r) => rival.srv.close(r));
api.becomeDock();
ok('and with the rival gone this window can be the dock again', api.role() === 'dock' && (await jget(DPORT2, '/dock')).ok === true, api.role());

// The routes every window owes, on this one.
ok('POST /focus asks the window to raise itself and reports what it DID, since it cannot verify more', (await jpost(DPORT2, '/focus', {})).ok === true, await jpost(DPORT2, '/focus', {}));
const badrole = await jpost(DPORT2, '/role', { role: 'dock' });
ok('a window cannot be TOLD to be the dock: a dock is a window a person asked for', badrole.ok === false && /role must be/.test(badrole.error), badrole);
api.settings({ dock_port: null, beat_stale_ms: null, reach_ms: null, birth_ms: null, dock_scan_ms: null });
api.stop();

// =============================================================================================
section('14. what a person can see and press, the limit the plugin keeps, and a claim gone idle');
// =============================================================================================
// BLOCKBENCH_ISOLATION_DESIGN.md section 12, from a report on 2026-09-12: eight windows two days
// after the work they were opened for, none with a project, no controls anywhere, and the dock
// running the whole time with a complete roster nobody could see.
//
// Three findings, each with its own test below. (1) A PANEL is invisible in exactly the state the
// dock lives in - measured in the running app, 544x93 with a project open and 0x0 without, the
// start screen covering the workspace - so what a person is shown has to be a start-screen section,
// and what it SAYS is assertable here even though the DOM it paints into is not. (2) A claim held
// by a session that has done nothing for two days kept an empty window alive, because the only
// question asked of it was whether its socket was open. (3) The demanding shims were pinned to an
// older toolkit and could not be fixed from the shim at all, so the reuse and the ceiling have to
// live in the plugin, on `POST /window`.
const spick = await pickBase(8);
const sbase = spick.base;
ok('a free span for the surfaces', !!sbase && !!spick.squatter, sbase);
await new Promise((r) => spick.squatter.close(r));
api.settings({ port: sbase, dock_port: null, reach_ms: 400, dock_scan_ms: 600000, empty_grace_ms: 60, idle_claim_ms: 250 });
api.start({ prompt: false });
await sleep(200);
const SPORT = api.status().port;
ok('the bridge is listening on the base of a clean span', SPORT === sbase && api.status().listening === true, api.status());
// Section 13 left this window standing as a dock, and a dock has no other role to be given; its
// stub-window factory goes too, so an ask here does not try to bind a port that stub still holds.
api.resignDock(null);
g._openStubWindow = null;
api.setRole('agent');
ok('...as an agent window, which is the kind this section is about', api.window().agent === true, api.window());

// --- A CLAIM THAT IS LIVE AND IDLE ----------------------------------------------------------
// The two-day windows were every one of them `connected: true`. A presence socket is the liveness
// of a PROCESS; it says nothing about whether anybody is working here.
let scl = await jpost(SPORT, '/claim', { session: { id: 'idle-1', client: 'shim-idle' } });
ok('a fresh claim is not idle: its clock starts at the claim', scl.ok === true && api.claimIdle().idle === false && api.claimIdle().limit_ms === 250, api.claimIdle());
await sleep(320);
let shi = await jget(SPORT, '/hello');
ok('a claim that has asked for nothing goes IDLE while its holder is still connected', api.claimIdle().idle === true && shi.claimed_by && shi.claimed_by.idle === true && shi.claimed_by.idle_s >= 0, shi.claimed_by);
// A window with work in it is never judged by its claim: that rule is what keeps an idle socket
// from becoming a reason to close something unsaved (design section 6.2).
ok('...but a window with a project open keeps its holder, idle or not', g.ModelProject.all.length > 0 && shi.claimed_by.session === 'idle-1' && (await api.sweep()) === null, g._closed);
// One call is all it takes to be working again, and it is the CALL that counts: `seen` is refreshed
// by presence and by every scan, so it could never have answered this question.
await jpost(SPORT, '/cmd', { tool: 'project', args: { op: 'list' }, session: { id: 'idle-1' } });
ok('a call by the holder puts the claim back to work', api.claimIdle().idle === false && api.claimIdle().idle_ms < 250, api.claimIdle());
await sleep(320);
// Now the shape the report was about: empty, held, and idle. The claim is dropped, which is what
// makes the window reusable rather than merely closeable.
const sOpen = g.ModelProject.all.slice();
g.ModelProject.all.length = 0;
g.Project = null;
shi = await jget(SPORT, '/hello');
ok('an EMPTY window whose holder has gone quiet is released: the claim stops protecting it', shi.claimed_by === null && api.window().claimed_by === null, shi);
const sneighbour = await stubWindow(sbase + 5, { window: 'win-else', role: 'person' });
const closedBefore = g._closed || 0;
await api.sweep();
await sleep(90);
ok('...and with another window answering, the window it was holding closes itself', (await api.sweep()) === true && g._closed === closedBefore + 1, g._closed);
api.start({ prompt: false });
await sleep(200);
api.setRole('agent');

// --- WHAT THE START SCREEN SAYS -------------------------------------------------------------
// The model is the assertable half: what a person is shown, and what each button will do. (The DOM
// it paints into needs a renderer; the live spike is what proved that half - 1000x211 with no
// project open, topmost and hit-testable.)
let scr = api.startScreen();
ok('an ordinary window says which window it is, in a window that has no project to show a panel in',
    scr.heading === 'MCP Toolkit Bridge' && scr.rows.length === 1 && scr.rows[0].self === true
    && scr.rows[0].lines[0].indexOf('port ' + api.status().port) === 0, scr.rows[0]);
ok('...and offers the two acts a person in front of a blank window wants: find the dock, or close this one',
    scr.rows[0].buttons.map((b) => b.label).join('|') === 'Open the MCP Dock|Close this window', scr.rows[0].buttons.map((b) => b.label));
api.settings({ dock_port: sbase + 5 });
scr = api.startScreen();
ok('...and when a dock is already known it offers to RAISE it rather than make a second one',
    scr.rows[0].buttons[0].label === 'Show the MCP Dock', scr.rows[0].buttons.map((b) => b.label));
await scr.rows[0].buttons[0].act();
ok('...which asks that window to focus itself, over the only route a plugin has into another window', sneighbour.focused === 1, sneighbour.focused);
api.settings({ dock_port: null });
// An idle holder is SAID, because "why is this window about to be recycled" is a question the row
// has to answer on its own.
await jpost(SPORT, '/claim', { session: { id: 'idle-2', client: 'shim-idle' } });
await sleep(320);
scr = api.startScreen();
ok('an idle holder is named as such, with what that means for the window', /idle \d+s - this window is free to recycle/.test(scr.rows[0].lines[1]), scr.rows[0].lines[1]);
await jpost(SPORT, '/claim', { session: { id: 'idle-2' }, release: true });
// A stopped bridge is the one state where the section's only useful offer is to start it.
api.stop();
scr = api.startScreen();
ok('a window whose bridge is stopped says so and offers the one thing worth doing', scr.rows[0].head.indexOf('stopped') > 0 && scr.rows[0].buttons.length === 1 && scr.rows[0].buttons[0].label === 'Start the bridge', scr.rows[0]);
api.start({ prompt: false });
await sleep(200);
api.setRole('agent');

// --- THE DOCK'S START SCREEN ----------------------------------------------------------------
const SP2 = api.status().port;
api.becomeDock();
await jpost(SP2, '/dock/hello', { window: 'win-o1', port: sbase + 6, role: 'agent' });
await jpost(SP2, '/dock/beat', { window: 'win-o1', port: sbase + 6, role: 'agent', claimed_by: null, open: [], dirty: 0 });
await jpost(SP2, '/dock/hello', { window: 'win-o2', port: sbase + 7, role: 'agent' });
await jpost(SP2, '/dock/beat', { window: 'win-o2', port: sbase + 7, role: 'agent', claimed_by: null, open: [], dirty: 0 });
scr = api.startScreen();
const srow = (port) => api.startScreen().rows.find((r) => r.port === port);
ok('the DOCK\'s start screen is the roster: itself first, then the windows it watches',
    scr.heading === 'MCP Dock' && scr.rows[0].self === true && scr.rows[0].port === SP2
    && !!srow(sbase + 6) && !!srow(sbase + 7), scr.rows.map((r) => r.port));
ok('...and the dock offers no Close for itself, because it is what keeps every other window safe to close',
    scr.rows[0].buttons.map((b) => b.label).join('|') === 'Rescan now', scr.rows[0].buttons.map((b) => b.label));
// The verbs say what they do since 0.11.0 (section 13): "Release" did not say it takes the window
// away from the session in it, and "Adopt" did not say it makes a person's window claimable.
ok('...while each window it watches gets Focus, a role it can be given, and a close', srow(sbase + 6).buttons.map((b) => b.label).join('|') === 'Focus|Take back|Close', srow(sbase + 6).buttons.map((b) => b.label));
ok('...and an empty agent window is labelled with what a person should do about it', srow(sbase + 6).note === 'empty and unclaimed - safe to close', srow(sbase + 6).note);
// The one act the report asked for by name: get rid of the row of empties, in one press.
const o1 = await stubWindow(sbase + 6, { window: 'win-o1', role: 'agent' });
const o2 = await stubWindow(sbase + 7, { window: 'win-o2', role: 'agent' });
scr = api.startScreen();
const sweepAll = scr.buttons.find((b) => /Close all 2 empty agent windows/.test(b.label));
ok('two empty agent windows earn one button that closes them both', !!sweepAll, scr.buttons.map((b) => b.label));
await sweepAll.act();
ok('...and pressing it closes each of them through the route only that window can serve', o1.closed === 1 && o2.closed === 1, { o1: o1.closed, o2: o2.closed });

// --- A DOCK WHOSE TIMERS ARE FROZEN ---------------------------------------------------------
// Measured in the running app 2026-09-12: every bridge window reports `visibilityState: "hidden"`,
// and a window hidden longer than five minutes gets Chromium's INTENSIVE THROTTLING - a 500ms
// interval ticked ZERO times in eight seconds in the dock against six in a window hidden for less.
// The dock is by definition the window a person leaves in the background, so nothing about its
// picture may depend on its own timer. Two consequences, both tested here.
const stale = api.status().limits.beat_stale_ms;
ok('the staleness threshold clears Chromium\'s one-callback-a-minute floor, or every background window reads as wedged', stale >= 60000, stale);
api.settings({ beat_stale_ms: 300 });
await jpost(SP2, '/dock/hello', { window: 'win-vanish', port: sbase + 9, role: 'agent' });
await jpost(SP2, '/dock/beat', { window: 'win-vanish', port: sbase + 9, role: 'agent', claimed_by: null, open: [], dirty: 0 });
ok('a window that registered and beat is in the roster', !!api.startScreen().rows.find((r) => r.port === sbase + 9), api.startScreen().rows.map((r) => r.port));
await sleep(1000);
ok('...and once nothing has been heard from it, it is not LISTED - with no scan having run at all', !api.startScreen().rows.find((r) => r.port === sbase + 9), api.startScreen().rows.map((r) => r.port));
// An incoming beat is the one clock a throttled window still has, so it does the forgetting too -
// and this is a beat from a DIFFERENT window, which is what makes it the beat and not the read.
await jpost(SP2, '/dock/beat', { window: 'win-h' + (sbase + 2), port: sbase + 2, role: 'agent', claimed_by: { session: 'held-' + (sbase + 2), connected: true }, open: [{ name: 'x', saved: true }], dirty: 0 });
ok('...and an incoming beat from any window is what forgets that row for good', !(await jget(SP2, '/dock')).windows.some((w) => w.port === sbase + 9), (await jget(SP2, '/dock')).windows.map((w) => w.port));
api.settings({ beat_stale_ms: null });

// --- THE CEILING, AND REUSE BEFORE IT --------------------------------------------------------
// `POST /window` is the route a shim from before toolkit 0.145.0 calls on a poll, forever, and no
// shim-side fix reaches one that is already running (section 12.2). So the plugin answers it.
// (The two orphans above are gone from the roster, because that is what the button did to them.)
api.settings({ max_agent_windows: 3 });
for (const p of [sbase + 2, sbase + 3, sbase + 4]) {
    await jpost(SP2, '/dock/beat', { window: 'win-h' + p, port: p, role: 'agent', claimed_by: { session: 'held-' + p, connected: true }, open: [{ name: 'x', saved: true }], dirty: 0 });
}
const dagents = (await jget(SP2, '/dock')).windows.filter((w) => w.role === 'agent');
ok('the dock is watching three agent windows', dagents.length === 3, dagents.map((w) => w.port));
const dalloc = await jpost(SP2, '/dock/window', { session: { id: 'newcomer' } });
ok('...so a fourth is refused, naming the windows it has and the setting that says how many', dalloc.ok === false && /limit is 3/.test(dalloc.error) && dalloc.agent_windows.length === 3 && /Settings/.test(dalloc.hint), dalloc);
api.resignDock(null);
await new Promise((r) => o1.srv.close(r));
await new Promise((r) => o2.srv.close(r));

const SP3 = api.status().port;
// One empty agent window in the range: hand it over rather than make a second.
const free1 = await stubWindow(sbase + 6, { window: 'win-free', role: 'agent' });
g._new_window = [];
let sw = await jpost(SP3, '/window', { session: { id: 'asker-1' } });
ok('POST /window REUSES an empty agent window before it makes one', sw.ok === true && sw.reused === true && sw.port === sbase + 6 && g._new_window.length === 0, { sw, opened: g._new_window });
ok('...by telling that window to be an agent\'s again, pre-claimed for whoever asked', free1.roles.length === 1 && free1.roles[0].claim_for === 'asker-1' && free1.roles[0].role === 'agent', free1.roles);
// A session that already holds one is handed the same one back. This is the poll-forever case: an
// old shim that asks on every tick must not be given a window on every tick.
const held1 = await stubWindow(sbase + 3, { window: 'win-held', role: 'agent', claimed_by: { session: 'asker-2', connected: true } });
g._new_window = [];
sw = await jpost(SP3, '/window', { session: { id: 'asker-2' } });
ok('...and a session that already holds a window is handed that one, not another', sw.ok === true && sw.rejoined === true && sw.port === sbase + 3 && g._new_window.length === 0, { sw, opened: g._new_window });
// Now the ceiling itself: every agent window in the range spoken for, and the limit reached.
free1.info.claimed_by = { session: 'someone-else', connected: true };
const held2 = await stubWindow(sbase + 2, { window: 'win-held2', role: 'agent', claimed_by: { session: 'third', connected: true } });
g._new_window = [];
sw = await jpost(SP3, '/window', { session: { id: 'asker-3' } });
ok('with every agent window held and the limit reached, no window is made', sw.ok === false && sw.opened === false && g._new_window.length === 0, { sw, opened: g._new_window });
ok('...and the refusal names the ports, the limit and where a person changes it', /limit is 3/.test(sw.error) && sw.max_agent_windows === 3 && sw.agent_windows.length >= 3 && /Settings/.test(sw.hint), sw);
// A person's own windows are not counted and never stand in the way of an agent getting one.
const personWindow = await stubWindow(sbase + 1, { window: 'win-person', role: 'person' });
api.settings({ max_agent_windows: 8 });
g._new_window = [];
g._openStubWindow = null;
sw = await jpost(SP3, '/window', { session: { id: 'asker-4' } });
ok('a raised limit lets the next ask through, and a person\'s window was never part of the count', sw.ok === true && sw.opened === true && g._new_window.length === 1, { sw, opened: g._new_window });
// AND THE ASK NOBODY CAN SEE YET. Six windows got past a ceiling of three on 2026-09-12, live:
// several stale shims asked inside the same second, and a window that has been asked for does not
// exist for a second or two - no scan can count it. So the ask itself is counted, out of the
// pending handoffs, which are also the one count SHARED between windows: that is what makes this
// hold when the asks arrive at different windows, which is the shape the live run had.
//
// The limit is set to FOUR here, one above the three windows that can be scanned, so that only the
// outstanding ask can account for the refusal.
api.settings({ max_agent_windows: 4 });
// Every ask but asker-4's is forgotten - earlier sections of this file ask as sessions of their own,
// and inside one fast test run those asks are still in flight - so the count below is unambiguous:
// three windows that can be scanned, and one that cannot be.
for (const e of api.asked()) if (e.session !== 'asker-4') api.forgetAsk(e.session);
g._new_window = [];
sw = await jpost(SP3, '/window', { session: { id: 'racer-1' } });
ok('a window that has been asked for but does not exist yet is still counted', sw.ok === false && /3 agent window\(s\)/.test(sw.error) && /1 asked for/.test(sw.error) && g._new_window.length === 0, sw);
// ONE SESSION, ONE WINDOW, EVEN WHEN IT ASKS TWICE. Live on 2026-09-12 a single stale shim held
// THREE windows: it asks on its poll cadence, and each ask ran before the window the previous one
// triggered existed to be found. The ask it already has outstanding is the thing to find instead.
ok('...and the identity left for that window is still the one the asker paid for', api.adopt() === true && api.window().claimed_by.session === 'asker-4', api.window());
// THE GAP IS MODELLED, because it is the whole point: the window that was born CONSUMES the handoff
// and then takes a second or two to answer on a port, and it is in there that a polling shim asks
// again. So the pending list is emptied here the way that newborn empties it, while the window it
// became is still not in any scan.
g.localStorage.setItem('mcptoolkit_bridge.pending', '[]');
g._new_window = [];
const twice = await jpost(SP3, '/window', { session: { id: 'asker-4' } });
ok('a session that has already asked is told one is coming, and no second window is made', twice.ok === true && twice.opening === true && twice.opened === undefined && g._new_window.length === 0, { twice, opened: g._new_window });
ok('...and it is the ASK that says so, which outlives the handoff the newborn window consumed', api.asked().some((e) => e.session === 'asker-4') && JSON.parse(g.localStorage.getItem('mcptoolkit_bridge.pending')).length === 0, { asked: api.asked(), pending: g.localStorage.getItem('mcptoolkit_bridge.pending') });
api.settings({ max_agent_windows: 8 });
// A RELOAD IS NOT A BIRTH. Reloading the plugin looks identical from inside - onload, a port, a
// pending entry to consume - and live on 2026-09-12 four reloads ate four asks, so the windows that
// did appear registered as the person's and the ceiling stopped counting them. `sessionStorage` is
// per WINDOW and survives a plugin reload, which is exactly the distinction, and the harness can
// play the reload by setting the mark this renderer would already carry.
g.sessionStorage = { store: { 'mcptoolkit_bridge.born': '1' }, getItem(k) { return this.store[k] ?? null; }, setItem(k, v) { this.store[k] = String(v); } };
g.__plugin.onload();
await jpost(SP3, '/window', { session: { id: 'asker-5' } });
ok('a plugin RELOAD does not eat the handoff left for a window that is being born', api.adopt() === false, api.adopt());
delete g.sessionStorage;
g.__plugin.onload();
ok('...and a renderer that has never run this plugin still takes the one left for it', api.adopt() === true && api.window().claimed_by.session === 'asker-5', api.window());
await jpost(SP3, '/claim', { session: { id: 'asker-4' }, release: true });
for (const s of [free1, held1, held2, personWindow, sneighbour]) await new Promise((r) => s.srv.close(r));

// --- DRIVING A WINDOW THAT HAS NOTHING OPEN --------------------------------------------------
// The dock holds no project by design, and every tool resolved one first - so the window that
// governs the others could not be driven, read or probed at all (section 12.6).
let rv = await jpost(SP3, '/cmd', { tool: 'risky_eval', args: { code: 'PROJECT === null ? "no project" : PROJECT.name' }, session: { id: 'prober' } });
ok('risky_eval runs in a window with no project, and PROJECT is null there rather than a refusal', rv.ok === true && rv.result.value === 'no project' && rv.result.project === undefined, rv);
rv = await jpost(SP3, '/cmd', { tool: 'trigger_action', args: { id: 'select_all' }, session: { id: 'prober' } });
ok('...and so does trigger_action, which is how a window\'s own menu is reachable', rv.ok === true && rv.result.triggered === 'select_all', rv);
rv = await jpost(SP3, '/cmd', { tool: 'list_outline', args: {}, session: { id: 'prober' } });
ok('a tool that genuinely needs a project still refuses, naming the fix', rv.ok === false && /no project is open/.test(rv.error) && /project op:new/.test(rv.hint), rv);

// --- ONE ENTRY IN THE TOOLS MENU -------------------------------------------------------------
// Seven top-level entries, with two other plugins of this workspace in the same menu, took the menu
// over (reported 2026-09-12, and read back from the live menu structure).
const menu = api.menuNames();
// EVERY registration this plugin has ever made is the one submenu - not "one at the moment", which
// a second onload would satisfy while seven loose entries sat beside it.
ok('the plugin registers ONE entry in Tools, and everything else hangs under it',
    g.MenuBar.added.length >= 1 && g.MenuBar.added.every((a) => a.id === 'mcptoolkit_bridge_menu' && a.path === 'tools' && a.children === 8), g.MenuBar.added);
ok('...and start and stop are one entry that says which is true', /^Stop the bridge \(running on \d+\)$/.test(menu.toggle) && menu.children.indexOf('mcptoolkit_bridge_toggle') === 0, menu);
ok('...and the parent carries the port, so a stack of windows is tellable apart from the menu alone', menu.parent === 'MCP Toolkit Bridge (port ' + SP3 + ')', menu.parent);
api.stop();
ok('a stopped bridge re-labels the entry rather than offering both', api.menuNames().toggle === 'Start the bridge' && api.menuNames().parent === 'MCP Toolkit Bridge (stopped)', api.menuNames());

g.ModelProject.all.push(...sOpen);
g.Project = sOpen[sOpen.length - 1] || null;
g._closed = closedBefore;
// The base is left where this section put it and NEVER set back to the shipped 25801, which is a
// real Blockbench's range: with a base in that range and a port already bound, this harness's next
// `findDock` scan reached the developer's OWN dock and registered itself in its roster - seen
// 2026-09-12, a live dock listing four ephemeral ports that were test processes. A test must not be
// able to appear in the app it is testing.
api.settings({ max_agent_windows: null, idle_claim_ms: null, empty_grace_ms: null, reach_ms: null, dock_scan_ms: null, dock_port: null });

// =============================================================================================
// SECTION 13 OF THE ISOLATION RECORD (2026-09-13), sections 15-23 here. Every check below was run
// against plugin 0.10.0 first (MCPTK_PLUGIN_PATH, see the top of this file) and went red there;
// a check that is green on both versions is not a falsifier and does not belong here. Each group
// is guarded so that an older plugin - which lacks half of the api - reports a red line for the
// group rather than killing the run before the later groups have said anything.
// =============================================================================================
const guarded = async (what, fn) => {
    try { await fn(); } catch (e) { ok(what + ': the group ran to its end', false, String(e && e.stack || e).split('\n').slice(0, 2).join(' ')); }
};
const STORE_KEY = 'mcptoolkit_bridge.settings';
const readStore = () => JSON.parse(g.localStorage.getItem(STORE_KEY) || '{}');
/** A presence socket that keeps EVERY line it is sent, and knows when the plugin closed it. */
const presenceLines = (base, id, client) => new Promise((resolve, reject) => {
    const out = { lines: [], closed: false, req: null };
    out.req = http.get(base + '/presence', { headers: { 'X-MCPTK-Client': client, 'X-MCPTK-Session': id } }, (pres) => {
        pres.setEncoding('utf8');
        let tail = '';
        pres.on('data', (d) => {
            tail += d;
            const parts = tail.split('\n'); tail = parts.pop();
            for (const p of parts) { if (p.trim()) { try { out.lines.push(JSON.parse(p)); } catch (e) { /* a beat */ } } }
            if (out.lines.length === 1 && out.status === undefined) { out.status = pres.statusCode; resolve(out); }
        });
        pres.on('close', () => { out.closed = true; });
        pres.on('end', () => { out.closed = true; });
        if (pres.statusCode !== 200) { out.status = pres.statusCode; resolve(out); }
    });
    out.req.on('error', reject);
});

// =============================================================================================
section('15. settings live in the store, not in the window');
// =============================================================================================
// Until 0.11.0 `settings` was read once at onload and written back WHOLE, so a save from one window
// overwrote what another had changed, and a ceiling raised in window A was never the ceiling the
// dock applied. Two halves, both testable without a second renderer: the write reloads before it
// merges, and the read listens to the `storage` event - which the harness dispatches by hand,
// because both plugin instances here share one process and no real event crosses them.
await guarded('settings: the write', async () => {
    // Another window saved a key this instance has never heard of.
    const foreign = Object.assign(readStore(), { foreign_key: 'written-by-window-b' });
    g.localStorage.setItem(STORE_KEY, JSON.stringify(foreign));
    api.settings({ x: 1 });
    const after = readStore();
    ok('a save carries only the keys it was given: a key another window wrote survives it', after.foreign_key === 'written-by-window-b' && after.x === 1, after);
});
await guarded('settings: the listener', async () => {
    // The listener the plugin registered at onload is what a real renderer would call.
    const stored = (g.window.listeners.storage || []);
    ok('onload registered ONE storage listener on the window', stored.length === 1 && typeof stored[0] === 'function', stored.length);
    g.localStorage.setItem(STORE_KEY, JSON.stringify(Object.assign(readStore(), { idle_claim_ms: 4321 })));
    ok('...and a value another window stored is not this window\'s until the event says so', api.status().limits.idle_claim_ms !== 4321, api.status().limits);
    if (stored[0]) stored[0]({ key: STORE_KEY });
    ok('...and it reloads: a setting saved elsewhere reaches every reader here', api.status().limits.idle_claim_ms === 4321, api.status().limits);
});
await guarded('settings: the event', async () => {
    // Another window raised the ceiling. The value is in the store and NOT yet in this instance -
    // and it is the event, not the save, that delivers it.
    g.localStorage.setItem(STORE_KEY, JSON.stringify(Object.assign(readStore(), { max_agent_windows: 7 })));
    ok('a ceiling another window stored is not this window\'s yet', api.status().limits.max_agent_windows !== 7, api.status().limits);
    api.onStorage({ key: STORE_KEY });
    ok('the storage event reloads: the ceiling read here is the one saved elsewhere', api.status().limits.max_agent_windows === 7, api.status().limits);
    api.onStorage({ key: 'somebody_elses.key' });
    ok('...and an event for another key is ignored', api.status().limits.max_agent_windows === 7, api.status().limits);
});
api.settings({ max_agent_windows: null, idle_claim_ms: null, x: null, foreign_key: null });

// =============================================================================================
section('16. a dock survives an internal restart and not an explicit stop, and become-dock checks first');
// =============================================================================================
const xpick = await pickBase(8);
const xbase = xpick.base;
ok('a free span for section 13\'s checks', !!xbase && !!xpick.squatter, xbase);
await new Promise((r) => xpick.squatter.close(r));
api.settings({ port: xbase, dock_port: null, reach_ms: 400, dock_scan_ms: 600000, birth_ms: null, empty_grace_ms: null, idle_claim_ms: null });
api.start({ prompt: false });
await sleep(200);
const XP = api.status().port;
ok('the bridge is listening on the base of that span', XP === xbase && api.status().listening === true, api.status());
await guarded('dock: stop', async () => {
    // `stop()` nulled `boundPort` before comparing it to `dock_port`, so a stopped dock never cleared
    // its hint and every other window kept trying a door that could not answer.
    api.becomeDock();
    ok('the menu makes this window the dock and stores its port as the hint', api.role() === 'dock' && api.settings().dock_port === XP, api.settings().dock_port);
    api.stop();
    ok('an explicit stop resigns the dock and clears the hint it left for the others', api.settings().dock_port === null && api.role() !== 'dock' && api.status().listening === false, { dock_port: api.settings().dock_port, role: api.role() });
    api.start({ prompt: false });
    await sleep(200);
});
// (The stubs live OUTSIDE the guarded groups: a group that throws on an older plugin must not leave
// a server on a port the next section binds.)
const xrival = await stubWindow(xbase + 1, { window: 'win-rival', role: 'dock' });
await guarded('dock: make', async () => {
    // "Make this window the MCP Dock" used to skip the one-dock check "Open the MCP Dock" makes, and
    // the lowest-port rule then quietly overruled the window the person had just chosen.
    const md = await api.makeDock();
    ok('make-dock refuses while a dock answers in the range, naming its port', md.ok === false && md.dock_port === xbase + 1 && new RegExp('port ' + (xbase + 1)).test(md.error) && api.role() !== 'dock', md);
});
await new Promise((r) => xrival.srv.close(r));
await guarded('dock: make, range clear', async () => {
    const md = await api.makeDock();
    ok('...and with the range clear it makes this window the dock', md.ok === true && api.role() === 'dock' && api.settings().dock_port === XP, md);
});
api.stop();
api.resignDock(null);
api.start({ prompt: false });
await sleep(200);
const inRange = await stubWindow(xbase + 2, { window: 'win-r', role: 'agent' });
await guarded('dock: restart', async () => {
    // A base-port change in Settings goes through `restart`, which keeps the role - and scans again,
    // which a stopped-and-started dock never did.
    api.becomeDock();
    api.restart({ prompt: false });
    await sleep(600);
    ok('an internal restart keeps the dock role and re-writes the hint', api.role() === 'dock' && api.status().listening === true && api.settings().dock_port === api.status().port, { role: api.role(), status: api.status() });
    const roster = api.dock();
    ok('...and scans again: a window in the range is in the roster with no scan asked for', roster.ok !== false && Array.isArray(roster.windows) && roster.windows.some((w) => w.port === xbase + 2), roster.windows && roster.windows.map((w) => w.port));
    api.stop();
    ok('...and stopping it afterwards still resigns it', api.role() !== 'dock' && api.settings().dock_port === null, api.role());
});
await new Promise((r) => inRange.srv.close(r));
// An older plugin's stop() does not resign the dock; said explicitly so the sections below test what
// they say they test on either version.
api.stop();
api.resignDock(null);
api.settings({ dock_port: null });

// =============================================================================================
section('17. a handoff lives as long as its ask');
// =============================================================================================
// A handoff lived 120 s and its ask was counted for 20 s, so a window a person opened by hand in
// the gap became an agent window pre-claimed for a session that had already given up.
api.start({ prompt: false });
await sleep(200);
api.setRole('person');
await guarded('handoff: forgotten with its ask', async () => {
    g.localStorage.setItem('mcptoolkit_bridge.pending', '[]');
    g.localStorage.setItem('mcptoolkit_bridge.asked', '[]');
    const realNW = g.BarItems.new_window;
    g.BarItems.new_window = { click() {} };
    const asked = await jpost(XP, '/window', { session: { id: 'ttl-1', client: 'shim-ttl' } });
    g.BarItems.new_window = realNW;
    const pendingNow = JSON.parse(g.localStorage.getItem('mcptoolkit_bridge.pending') || '[]');
    ok('an ask leaves a handoff for the window it opens', asked.ok === true && pendingNow.some((e) => e.session === 'ttl-1'), { asked, pendingNow });
    api.forgetAsk('ttl-1');
    const pendingAfter = JSON.parse(g.localStorage.getItem('mcptoolkit_bridge.pending') || '[]');
    ok('forgetting the ask drops the handoff with it, so no later window becomes that session\'s', !pendingAfter.some((e) => e.session === 'ttl-1') && api.adopt() === false, { pendingAfter, adopted: api.adopt() });
});
await guarded('handoff: one clock', async () => {
    api.settings({ birth_ms: 2500 });
    ok('the handoff TTL is the ask\'s clock, `birth_ms`', api.pendingTtlMs() === 2500, api.pendingTtlMs());
    api.settings({ birth_ms: null });
    ok('...and the shipped default is the same 20 seconds', api.pendingTtlMs() === 20000, api.pendingTtlMs());
});

// =============================================================================================
section('18. the queue: visible on /hello, and a call whose caller hung up is dropped');
// =============================================================================================
// One queue for every session and a two-minute ceiling in the shim: a `place_cube` queued behind a
// long push used to RUN after the agent had been told it failed, and the retry doubled it.
const qOpen = g.ModelProject.all.slice();
g.ModelProject.all.length = 0;
g.Project = null;
await guarded('queue', async () => {
    // The control: the very call that is dropped below does run, and does what it says, when its
    // caller waits for it. Without this the drop check could pass because the call was refused.
    delete g.__mcptkRan;
    const ctrl = await jpost(XP, '/cmd', { tool: 'risky_eval', args: { code: 'globalThis.__mcptkRan = 1' }, session: { id: 'q-0' } });
    ok('control: the side-effect call runs when its caller waits', ctrl.ok === true && g.__mcptkRan === 1, { ctrl, ran: g.__mcptkRan });
    delete g.__mcptkRan;
    const slow = jpost(XP, '/cmd', { tool: 'risky_eval', args: { code: 'await new Promise((r) => setTimeout(r, 500)); 1' }, session: { id: 'q-1' } });
    await sleep(80);
    let qh = await jget(XP, '/hello');
    ok('/hello says what is running and for whom', qh.queue && qh.queue.running && qh.queue.running.name === 'risky_eval' && qh.queue.running.session === 'q-1' && qh.queue.waiting === 0, qh.queue);
    const behind = jpost(XP, '/cmd', { tool: 'project', args: { op: 'list' }, session: { id: 'q-2' } });
    await sleep(60);
    qh = await jget(XP, '/hello');
    ok('...and how many wait behind it', qh.queue && qh.queue.waiting === 1, qh.queue);
    // A caller that gives up before its turn: the body is delivered, the socket is destroyed while
    // the call sits in the queue behind the slow one.
    await new Promise((resolve) => {
        const body = JSON.stringify({ tool: 'risky_eval', args: { code: 'globalThis.__mcptkRan = 1' }, session: { id: 'q-3' } });
        const rq = http.request('http://127.0.0.1:' + XP + '/cmd', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } });
        rq.on('error', () => {});
        rq.on('response', (rs) => rs.resume());
        rq.end(body);
        setTimeout(() => { rq.destroy(); resolve(); }, 80);
    });
    await slow;
    await behind;
    await sleep(150);
    const rec = api.recent();
    ok('a call whose caller hung up before its turn is skipped and recorded as such', rec.some((r) => r.name === 'risky_eval' && r.session === 'q-3' && r.ok === false && /dropped/.test(r.note || '')), rec.slice(-4));
    ok('...and its side effect never happened', g.__mcptkRan === undefined, g.__mcptkRan);
    qh = await jget(XP, '/hello');
    ok('with the queue drained /hello says nothing is running', qh.queue && qh.queue.running === null && qh.queue.waiting === 0, qh.queue);
});

// =============================================================================================
section('19. risky_eval puts SESSION in scope');
// =============================================================================================
await guarded('SESSION', async () => {
    let ev = await jpost(XP, '/cmd', { tool: 'risky_eval', args: { code: 'SESSION' }, session: { id: 'sess-eval', client: 'probe' } });
    ok('SESSION is the id of the session making the call', ev.ok === true && ev.result.value === 'sess-eval', ev);
    ev = await jpost(XP, '/cmd', { tool: 'risky_eval', args: { code: 'SESSION' } });
    ok('...and null for a call with no session block (curl by hand)', ev.ok === true && ev.result.value === null, ev);
    ev = await jpost(XP, '/cmd', { tool: 'risky_eval', args: { code: 'const s = SESSION; return s + "!"' }, session: { id: 'sess-eval' } });
    ok('...in the statement shape too', ev.ok === true && ev.result.value === 'sess-eval!', ev);
});
g.ModelProject.all.push(...qOpen);
g.Project = qOpen[qOpen.length - 1] || null;

// =============================================================================================
section('20. eviction is said, not enforced: the window note on every reply');
// =============================================================================================
// A claim steers discovery and nothing else (6.3 stands), so nothing a person did to a window
// reached the session in it: Take back, the recycle, Stop all dropped `claimedBy` while the shim
// kept its cached window. Now every `/cmd` reply from an agent window whose holder is not the
// caller carries `window: {port, window, held_by, reason, note}`; the call still RUNS.
await guarded('eviction note', async () => {
    api.setRole('agent');
    const A = { id: 'ev-a', client: 'shim-a' };
    let cl = await jpost(XP, '/claim', { session: A });
    ok('session A holds the agent window', cl.ok === true && cl.claimed_by.session === 'ev-a', cl);
    let env = await jpost(XP, '/cmd', { tool: 'project', args: { op: 'list' }, session: { id: 'ev-b', client: 'shim-b' } });
    ok('a call from another session carries the window note on the ENVELOPE, and still ran', env.ok === true && Array.isArray(env.result.projects) && env.window && env.window.port === XP && env.window.window === api.status().window && env.window.held_by && env.window.held_by.session === 'ev-a', env.window);
    ok('...saying whose it is and what to do', env.window && env.window.reason === 'held by session ev-a (shim-a)' && /held by session ev-a \(shim-a\)/.test(env.window.note) && /next call resolves a window of its own/.test(env.window.note), env.window);
    // EVERY envelope: the note is stamped in `call()` after `perform()`, so the two refusals that
    // used to escape it - an argument refusal thrown by `checkArgs` before the session was resolved,
    // and an unknown tool's early return - carry it as well.
    env = await jpost(XP, '/cmd', { tool: 'get_project_info', args: { project: 'no-such-project' }, session: { id: 'ev-b' } });
    ok('a refusal carries it as well as a result', env.ok === false && /no-such-project/.test(env.error) && env.window && env.window.held_by.session === 'ev-a', env);
    env = await jpost(XP, '/cmd', { tool: 'place_cube', args: { elements: [], bogus: 1 }, session: { id: 'ev-b' } });
    ok('...an argument refusal too', env.ok === false && /bogus/.test(env.error) && env.window && env.window.held_by.session === 'ev-a', env);
    env = await jpost(XP, '/cmd', { tool: 'no_such_tool', args: {}, session: { id: 'ev-b' } });
    ok('...and an unknown tool', env.ok === false && /unknown tool/.test(env.error) && env.window && env.window.held_by.session === 'ev-a', env);
    env = await jpost(XP, '/cmd', { tool: 'project', args: { op: 'list' }, session: A });
    ok('the holder\'s own call carries none', env.ok === true && env.window === undefined, env.window);
    // The person takes the window back (the dock's Take back, the menu's take-back): it is a
    // person's window now. THE SESSION IT WAS TAKEN FROM IS STILL TOLD - found live 2026-09-13: an
    // agent-only rule left the evicted session calling into a person's window with nothing said -
    // while anybody else calling into a person's window reads nothing, because a person's window
    // was never theirs to lose.
    api.setRole('person');
    ok('taking it back drops the claim', (await jget(XP, '/hello')).claimed_by === null, await jget(XP, '/hello'));
    env = await jpost(XP, '/cmd', { tool: 'project', args: { op: 'list' }, session: A });
    ok('in the (now person) window A\'s next call still says it was taken back, and that nobody holds it', env.ok === true && env.window && env.window.reason === 'taken back from the MCP Dock' && env.window.held_by === null && /held by nobody yet/.test(env.window.note), env.window);
    env = await jpost(XP, '/cmd', { tool: 'project', args: { op: 'list' }, session: { id: 'ev-f', client: 'shim-f' } });
    ok('...while a fresh session calling into that person\'s window reads nothing: only the evicted one is told', env.ok === true && env.window === undefined, env.window);
    // Given to agents again and claimed by C: A is told what happened to it, by name, because the
    // last eviction here was A's; a bystander is only told who holds it.
    api.setRole('agent');
    cl = await jpost(XP, '/claim', { session: { id: 'ev-c', client: 'shim-c' } });
    ok('session C claims it', cl.ok === true && cl.claimed_by.session === 'ev-c', cl);
    env = await jpost(XP, '/cmd', { tool: 'project', args: { op: 'list' }, session: A });
    ok('A\'s call now says it was taken back, and who has the window since', env.window && env.window.reason === 'taken back from the MCP Dock' && /any more \(taken back from the MCP Dock\)/.test(env.window.note) && /held by session ev-c \(shim-c\)/.test(env.window.note) && env.window.held_by.session === 'ev-c', env.window);
    env = await jpost(XP, '/cmd', { tool: 'project', args: { op: 'list' }, session: { id: 'ev-d' } });
    ok('...while a bystander that never held it reads only who does', env.window && env.window.reason === 'held by session ev-c (shim-c)' && !/any more/.test(env.window.note), env.window);
    env = await jpost(XP, '/cmd', { tool: 'project', args: { op: 'list' }, session: { id: 'ev-c' } });
    ok('...and C, the holder, reads nothing', env.window === undefined, env.window);
    await jpost(XP, '/claim', { session: { id: 'ev-c' }, release: true });
    env = await jpost(XP, '/cmd', { tool: 'project', args: { op: 'list' }, session: { id: 'ev-d' } });
    ok('an unclaimed agent window says so, without naming a holder', env.window && env.window.reason === 'unclaimed' && env.window.held_by === null, env.window);
});

// =============================================================================================
section('21. the recycle closes the evicted session\'s presence, with a last line');
// =============================================================================================
// A shim between calls has no reply to read the note off, so the recycle - and ONLY the recycle,
// which happens to an empty window with nothing behind the socket - writes one last line on the
// evicted session's presence responses and closes them (`reconcileWindow` then runs in the shim).
const rOpen = g.ModelProject.all.slice();
await guarded('recycle presence', async () => {
    api.setRole('agent');
    api.settings({ idle_claim_ms: 250 });
    const pl = await presenceLines('http://127.0.0.1:' + XP, 'rc-1', 'shim-rc');
    ok('session rc-1 is connected through presence', pl.status === 200 && pl.lines[0] && pl.lines[0].session === 'rc-1', pl.lines[0]);
    const cl = await jpost(XP, '/claim', { session: { id: 'rc-1', client: 'shim-rc' } });
    ok('...and holds the window', cl.ok === true && cl.claimed_by.session === 'rc-1', cl);
    g.ModelProject.all.length = 0;
    g.Project = null;
    await sleep(330);
    const hi = await jget(XP, '/hello');
    ok('an empty window whose holder went idle is recycled: the claim is dropped', hi.claimed_by === null, hi.claimed_by);
    await sleep(200);
    const evicted = pl.lines.find((l) => l.evicted === true);
    ok('the evicted session was told on the socket it already holds, with the reason', !!evicted && evicted.session === 'rc-1' && /recycled/.test(evicted.reason) && evicted.port === XP && /next call resolves a window of its own/.test(evicted.note), pl.lines);
    ok('...and the socket was then closed by the plugin, not by the shim', pl.closed === true, pl.closed);
    try { pl.req.destroy(); } catch (e) { /* already gone */ }
    api.settings({ idle_claim_ms: null });
});
g.ModelProject.all.length = 0;
g.ModelProject.all.push(...rOpen);
g.Project = rOpen[rOpen.length - 1] || null;
api.setRole('person');

// =============================================================================================
section('22. the door refuses a browser');
// =============================================================================================
// A page in a browser tab can blind-POST `risky_eval` or `POST /close {force:true}` to a loopback
// port as a request that needs no preflight. A browser sends an Origin it cannot forge; a local
// process (curl, the shim, another window's plugin) sends none - measured 2026-09-13, the Blockbench
// renderer sends no Origin on its own cross-window fetches.
await guarded('origin', async () => {
    const post = (origin) => fetch('http://127.0.0.1:' + XP + '/cmd', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, origin === undefined ? {} : { Origin: origin }), body: JSON.stringify({ tool: 'project', args: { op: 'list' }, session: { id: 'origin-probe' } }) }).then(async (r) => Object.assign({ _s: r.status }, await r.json()));
    let o = await post('https://example.com');
    ok('a POST /cmd from a web origin is 403 with ok:false and the sentence', o._s === 403 && o.ok === false && /loopback origins only/.test(o.error) && /browser/.test(o.error), o);
    o = await post('http://127.0.0.1:1234');
    ok('a loopback origin passes', o._s === 200 && o.ok === true, o);
    o = await post(undefined);
    ok('...and so does no Origin at all, which is what every local process sends', o._s === 200 && o.ok === true, o);
    const hi = await fetch('http://127.0.0.1:' + XP + '/hello', { headers: { Origin: 'https://example.com' } });
    ok('the rule is on the DOOR, not one route: GET /hello from a web origin is refused too', hi.status === 403, hi.status);
    ok('the refusal is in the recent calls, so a person can see that a page tried', api.recent().some((r) => r.ok === false && /refused: Origin https:\/\/example\.com/.test(r.note || '')), api.recent().slice(-3));
});
await guarded('origin: the rule', async () => {
    const table = [[null, true], ['', true], ['null', true], ['http://localhost', true], ['https://[::1]:1', true], ['http://127.0.0.1:25801', true],
        ['file://127.0.0.1', false], ['http://127.0.0.1.evil.example', false], ['https://example.com', false], ['http://localhost.evil', false]];
    const wrong = table.filter(([v, want]) => api.isLoopbackOrigin(v) !== want).map(([v]) => JSON.stringify(v));
    ok('isLoopbackOrigin: absent, blank and "null" pass, loopback http(s) passes, everything else is refused', wrong.length === 0, wrong);
});

// =============================================================================================
section('23. the dock\'s verbs say what they do, and Status is the same rows');
// =============================================================================================
const dockStubs = [];
await guarded('dock verbs', async () => {
    api.settings({ dock_port: null });
    api.becomeDock();
    ok('this window is the dock for the roster below', api.role() === 'dock', api.role());
    // Three windows a dock can watch: a person's with work in it, an agent's somebody holds, and a
    // person's standing empty. `open` and `claimed_by` ride /hello, which is what the scan reads.
    dockStubs.push(await stubWindow(xbase + 2, { window: 'win-p', role: 'person', open: [{ name: 'dragon', saved: true }, { name: 'egg', saved: false }], dirty: 1 }));
    dockStubs.push(await stubWindow(xbase + 3, { window: 'win-h', role: 'agent', claimed_by: { session: 'held-x', client: 'shim-x', connected: true, seen_s_ago: 0 }, open: [] }));
    dockStubs.push(await stubWindow(xbase + 4, { window: 'win-e', role: 'person', open: [] }));
    await api.scan();
    const vrow = (port) => api.startScreen().rows.find((r) => r.port === port);
    const labels = (port) => (vrow(port) ? vrow(port).buttons.map((b) => b.label).join('|') : null);
    ok('a person\'s window with a project open offers "Give to agents"', labels(xbase + 2) === 'Focus|Give to agents|Close (discard)', labels(xbase + 2));
    const give = vrow(xbase + 2) && vrow(xbase + 2).buttons[1];
    ok('...and that button ASKS, naming the projects that would be exposed', give && typeof give.confirm === 'string' && /dragon, egg/.test(give.confirm) && new RegExp('Port ' + (xbase + 2)).test(give.confirm) && /Give it anyway\?/.test(give.confirm), give && give.confirm);
    ok('an agent window somebody holds offers "Take back"', labels(xbase + 3) === 'Focus|Take back|Close', labels(xbase + 3));
    const take = vrow(xbase + 3) && vrow(xbase + 3).buttons[1];
    ok('...which asks, naming the session that loses the window', take && typeof take.confirm === 'string' && /held by session held-x \(shim-x\)/.test(take.confirm) && /Take it back\?/.test(take.confirm), take && take.confirm);
    const giveEmpty = vrow(xbase + 4) && vrow(xbase + 4).buttons[1];
    ok('an empty person\'s window is given without a question', giveEmpty && giveEmpty.label === 'Give to agents' && giveEmpty.confirm === null, giveEmpty);
});
await guarded('status model', async () => {
    // Status... was a JSON dump. It is the same rows as the start screen - one model, painted a
    // second way - plus the sessions this window knows, with the raw JSON behind one button.
    const sm = api.statusModel();
    const screen = api.startScreen();
    ok('statusModel carries the start screen\'s rows, verbatim', sm.rows.map((r) => r.head).join('|') === screen.rows.map((r) => r.head).join('|') && sm.heading === screen.heading && sm.rows.length === 4, sm.rows.map((r) => r.head));
    ok('...the sessions this window knows, and the queue', Array.isArray(sm.sessions) && sm.sessions.every((s) => typeof s.id === 'string' && typeof s.alive === 'boolean') && sm.queue && 'running' in sm.queue && 'waiting' in sm.queue, { sessions: sm.sessions.length, queue: sm.queue });
    ok('...and the raw status behind it, in the shape status() has', sm.raw && Object.keys(sm.raw).join() === Object.keys(api.status()).join(), Object.keys(sm.raw || {}));
});
await guarded('pressing', async () => {
    // Pressing: `confirm` goes through Blockbench's own message box, and the act runs only on the
    // confirming answer (index 0). The stub records the box instead of showing one.
    const realBox = g.Blockbench.showMessageBox;
    g._boxes = [];
    g.Blockbench.showMessageBox = (o, cb) => { g._boxes.push(o); g._boxCb = cb; };
    let acted = 0;
    const item = { label: 'Take back', confirm: 'sure?', act: () => { acted++; } };
    let pressed = api.pressItem(item);
    ok('pressing an item with `confirm` opens the message box with that sentence and the verb as its button', g._boxes.length === 1 && g._boxes[0].message === 'sure?' && g._boxes[0].buttons[0] === 'Take back' && acted === 0, g._boxes[0]);
    g._boxCb(1);
    await pressed;
    ok('...and Cancel runs nothing', acted === 0, acted);
    pressed = api.pressItem(item);
    g._boxCb(0);
    await pressed;
    ok('...while the confirming answer runs the act', acted === 1, acted);
    await api.pressItem({ label: 'Focus', confirm: null, act: () => { acted++; } });
    ok('an item without `confirm` runs at once, with no box', acted === 2 && g._boxes.length === 2, { acted, boxes: g._boxes.length });
    g.Blockbench.showMessageBox = realBox;
});
for (const s of dockStubs) await new Promise((r) => s.srv.close(r));
api.stop();
api.settings({ dock_port: null, reach_ms: null, dock_scan_ms: null });

// =============================================================================================
section('24. the crash-recovery guard: quitting takes only the backups of this window');
// =============================================================================================
// Closing ANY window clears the whole shared backup store, so one session quitting destroys another
// window's recovery - measured live, three closes out of three (isolation record section 8). The
// guard is installed at onload; `window.AutoBackup` is the object every internal caller holds, so
// replacing the method reaches them all, and `onbeforeunload` is the only reliable "we are quitting"
// flag (`before_closing` fires AFTER the wipe).
const mine = g.ModelProject.all.map((p) => p.uuid);
ok('the guard replaced removeAllBackups at onload', typeof g.window.onbeforeunload === 'function' && g.AutoBackup.removeAllBackups.name !== 'removeAllBackups', g.AutoBackup.removeAllBackups.name);
// Off the quit path it is still a REAL full clear: the start screen's Discard button must work.
g.AutoBackup.entries = { 'other-window': 'canary', [mine[0]]: 'ours' };
await g.AutoBackup.removeAllBackups();
ok('outside the quit path it still clears everything (Discard keeps working)', Object.keys(g.AutoBackup.entries).length === 0, g.AutoBackup.entries);
// Quitting: this window's projects only, and the other window's canary survives.
g.AutoBackup.entries = { 'other-window': 'canary', [mine[0]]: 'ours' };
if (typeof g.window.onbeforeunload === 'function') g.window.onbeforeunload();
await g.AutoBackup.removeAllBackups();
ok('quitting drops only the uuids of this window', Object.keys(g.AutoBackup.entries).join() === 'other-window', g.AutoBackup.entries);

// =============================================================================================
section('25. place_cube uv:"pack" lays box UV out in free space, and says so when there is none');
// =============================================================================================
// LOOP_KIT_DESIGN.md section 13: laying out a sheet is labour, and a designed model has no brief
// to pin it. A 4x4x4 cube needs a 16x8 box-UV footprint (2(d+w) x (d+h)); a 32x16 sheet holds
// four of them, and a cube placed by hand at [16,0] with uv:"box" must count as taken.
r = await call('project', { op: 'new', name: 'packer', format: 'modded_entity', texture_width: 32, texture_height: 16 }, S1);
ok('a fresh sheet to pack', r.ok && r.result.texture_width === 32 && r.result.texture_height === 16, r);
r = await call('place_cube', { uv: 'box', elements: [{ name: 'byhand', from: [0, 0, 0], to: [4, 4, 4], uv_offset: [16, 0] }] }, S1);
ok('a box-UV cube placed by hand keeps its own offset', r.ok && r.result.cubes[0].uv_offset.join() === '16,0', r);
r = await call('place_cube', { uv: 'pack', elements: [
  { name: 'p1', from: [0, 0, 0], to: [4, 4, 4] }, { name: 'p2', from: [0, 0, 0], to: [4, 4, 4] }, { name: 'p3', from: [0, 0, 0], to: [4, 4, 4] },
] }, S1);
const packed = r.ok ? r.result.cubes.map((c) => c.uv_offset.join()) : [];
ok('three packed cubes land in the three free 16x8 rectangles, top-left first, around the one placed by hand',
  r.ok && packed.join('|') === '0,0|0,8|16,8', JSON.stringify(r.ok ? packed : r));
ok('  and the readback says they are box UV', r.ok && r.result.cubes.every((c) => Array.isArray(c.uv_offset)), r.ok && JSON.stringify(r.result.cubes[0]));
r = await call('place_cube', { uv: 'pack', elements: [{ name: 'p4', from: [0, 0, 0], to: [4, 4, 4] }] }, S1);
ok('a fifth 16x8 footprint on a full 32x16 sheet is refused, with the size it needs and the fix',
  !r.ok && /sheet full: cube "p4" needs a 16x8 box-UV footprint/.test(r.error) && /4 box-UV cube\(s\) on it/.test(r.error) && /texture op:resize/.test(r.error), r);
r = await call('place_cube', { uv: 'pack', elements: [{ name: 'thin', from: [0, 0, 0], to: [2, 4, 2] }] }, S1);
ok('  while a smaller footprint (8x6) still finds no room on a sheet the four 16x8s fill exactly', !r.ok && /sheet full/.test(r.error), r);
r = await call('project', { op: 'set', texture_height: 32 }, S1);
r = await call('place_cube', { uv: 'pack', elements: [{ name: 'p5', from: [0, 0, 0], to: [4, 4, 4] }] }, S1);
ok('grow the sheet and the same cube packs into the new rows', r.ok && r.result.cubes[0].uv_offset.join() === '0,16', r);
r = await call('place_cube', { uv: 'pack', elements: [{ name: 'half', from: [0, 0, 0], to: [3, 4.5, 2] }] }, S1);
ok('a fractional size is packed on a whole-texel footprint (10x7 for 3x4.5x2), so its rows never straddle a neighbour',
  r.ok && r.result.cubes[0].uv_offset.join() === '16,16', r);
r = await call('project', { op: 'close', force: true }, S1);

g.__plugin.onunload();
ok('unload restores the removeAllBackups Blockbench shipped', g.AutoBackup.removeAllBackups.name === 'removeAllBackups' && g.window.onbeforeunload === null, g.AutoBackup.removeAllBackups.name);
ok('unload removes the global', !g.mcptoolkitBridge);
ok('unload removes the storage listener it registered', (g.window.listeners.storage || []).length === 0, g.window.listeners.storage);

console.log('\n' + (failures ? failures + ' FAILED of ' + count : 'all ' + count + ' ok'));
process.exit(failures ? 1 : 0);
