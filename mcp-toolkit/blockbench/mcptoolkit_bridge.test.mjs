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
const PLUGIN = path.join(HERE, 'mcptoolkit_bridge.js');
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
        // other view of them (`otherWindowsAnswer`).
        fetch, AbortSignal, URL,
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
        window: { onbeforeunload: null, close() { g._closed = (g._closed || 0) + 1; } },
        Plugin: { register(id, def) { g.__plugin = def; } },
        Action: class { constructor(id, o) { this.id = id; this.o = o; } delete() {} },
        MenuBar: { addAction() {} },
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
section('14. the crash-recovery guard: quitting takes only the backups of this window');
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

g.__plugin.onunload();
ok('unload restores the removeAllBackups Blockbench shipped', g.AutoBackup.removeAllBackups.name === 'removeAllBackups' && g.window.onbeforeunload === null, g.AutoBackup.removeAllBackups.name);
ok('unload removes the global', !g.mcptoolkitBridge);

console.log('\n' + (failures ? failures + ' FAILED of ' + count : 'all ' + count + ' ok'));
process.exit(failures ? 1 : 0);
