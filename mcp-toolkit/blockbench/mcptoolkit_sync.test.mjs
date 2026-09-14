// Regression harness for mcptoolkit_sync.js -- a Blockbench-shaped stub, so the headless
// `mcptoolkitPush` can be exercised without Blockbench and without a game.
//
//   cd mcp-toolkit/blockbench && node mcptoolkit_sync.test.mjs
//
// WHY IT EXISTS NOW AND NOT BEFORE. This file had NO harness at all through five plugin versions,
// which is most of why `TODO.md` 1.9 was a defect nobody tripped over: a hardcoded
// `http://127.0.0.1:25599/cmd` looks right in a diff and is only wrong from a repository whose game
// is on another port. The two things 1.9 changed are exactly the two things nothing could see -
// WHICH GAME a push reaches and WHICH PROJECT it reads - so both are asserted here by the only
// evidence that cannot be faked: the URL the transport was handed, and the texture names collected.
//
// WHAT THE STUB DOES NOT REACH, said plainly rather than implied (the plugin harnesses next door
// have been green through live-only faults before): Blockbench's own `ModelProject.select()`,
// `Texture.canvas`, `Format.codec.compile()` and the `Dialog`/`MenuBar` half are stubs answering
// the way the app's readable source says they do. What the stub CAN prove is this plugin's own
// arithmetic and its refusals, which is where 1.9 lives. The live arm is `TODO.md` 3.4 step 6.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import vm from 'node:vm';

const require_ = createRequire(import.meta.url);
const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const PLUGIN = path.join(HERE, 'mcptoolkit_sync.js');

let failures = 0;
let count = 0;
const ok = (name, cond, detail) => {
    count++;
    console.log((cond ? '  ok   ' : '  FAIL ') + name + (cond ? '' : '  <- ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))));
    if (!cond) failures++;
};
const section = (t) => console.log('\n== ' + t);

// =============================================================================================
// The stub world: two projects, each with its own textures and codec, and a recording transport.
// =============================================================================================
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const texture = (name) => ({ name, canvas: { toDataURL: () => PIXEL } });
const project = (name, textures, compiled) => ({
    uuid: 'uuid-' + name,
    name,
    textures: textures.map(texture),
    format: { id: 'java_block', codec: { compile: () => compiled } },
    selected: 0,
    select() { g.Project = this; g.Texture.all = this.textures; g.Format = this.format; this.selected++; },
});

const alpha = project('alpha', ['alpha_tex'], '{"alpha":true}');
const beta = project('beta', ['beta_tex'], '{"beta":true}');

const posts = [];       // {url, tool, args}
let nextAnswer = () => ({ ok: true, result: {} });

const store = {};
const g = {
    console,
    setTimeout,
    require: require_,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    Buffer,
    fetch: async (to, init) => {
        const body = JSON.parse(init.body);
        posts.push({ url: to, tool: body.tool, args: body.args });
        const answer = nextAnswer(body);
        return { json: async () => answer };
    },
    localStorage: {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = v; },
    },
    Blockbench: { showQuickMessage() {}, showMessageBox() {} },
    Dialog: class { constructor(o) { g.__dialog = o; } show() {} close() {} },
    Action: class { constructor(id, o) { this.id = id; this.o = o; } delete() {} },
    MenuBar: { addAction() {} },
    ModelProject: { all: [alpha, beta] },
    // The globals a project's `select()` swaps. They are here so that a regression which goes back
    // to reading them instead of the project object has something to read - and reads the WRONG
    // project, which is what section 2 catches.
    Texture: { all: [] },
    Format: null,
    Project: null,
    Plugin: { register(id, def) { g.__plugin = def; } },
};
g.globalThis = g;
vm.createContext(g);
vm.runInContext(fs.readFileSync(PLUGIN, 'utf8'), g, { filename: PLUGIN });
g.__plugin.onload();

const push = g.mcptoolkitPush;
const settings = g.mcptoolkitPushSettings;
/** Every push starts from a known world: beta active, nothing configured, nothing posted. */
function reset() {
    beta.select();
    alpha.selected = 0; beta.selected = 0;
    posts.length = 0;
    nextAnswer = () => ({ ok: true, result: {} });
    for (const k of Object.keys(store)) delete store[k];
    // The per-project maps MERGE since 0.5.0 (section 4), so `{}` clears nothing; null does, and the
    // next load reads it back as an empty map.
    settings({ bridge: '', bridges: null, sourceRoot: '', sourceRoots: null, namespace: '', namespaces: null });
}
// The bridge every successful push below is aimed at, and the namespace it needs since 0.5.0.
const GAME = 'http://127.0.0.1:25640';
const NS = { namespace: 'mymod' };

// =============================================================================================
section('0. WHICH NAMESPACE: the shipped default was one mod\'s name, so there is none now');
// =============================================================================================
// `villagejobs` was the literal default (isolation record section 13): from any other repo's
// Blockbench a push landed under assets/villagejobs/ and answered ok. The namespace is REQUIRED,
// like the bridge, and resolved the same way: per call, per project, then the global setting.
reset();
let r = await push({ bridge: GAME });
ok('a push with no namespace anywhere is refused', r.ok === false && /no namespace for project "beta"/.test(r.error), r);
ok('...naming the setting to make once', /mcptoolkitPushSettings\(\{namespaces: \{"beta": "mymod"\}\}\)/.test(r.error), r.error);
ok('...and nothing was posted', posts.length === 0, posts);
ok('...and the plugin\'s code carries no mod\'s name as a default', !/['"]villagejobs['"]/.test(fs.readFileSync(PLUGIN, 'utf8').split('(function ()')[1]), 'the literal default is back');
settings({ namespaces: { beta: 'permod' } });
r = await push({ bridge: GAME });
ok('a per-project namespace is used', r.ok === true && posts.some((p) => /^assets\/permod\//.test(p.args.path || '')), posts.map((p) => p.args.path));
reset();
settings({ namespace: 'globalmod' });
r = await push({ bridge: GAME });
ok('the global one is the fallback', r.ok === true && posts.some((p) => /^assets\/globalmod\//.test(p.args.path || '')), posts.map((p) => p.args.path));
settings({ namespaces: { beta: 'permod' } });
posts.length = 0;
r = await push({ bridge: GAME, namespace: 'percall' });
ok('and an explicit one beats both', r.ok === true && posts.filter((p) => p.args.path).every((p) => /^assets\/percall\//.test(p.args.path)), posts.map((p) => p.args.path));

// =============================================================================================
section('1. WHICH GAME: no bridge is a refusal, not a plausible default');
// =============================================================================================
reset();
r = await push(NS);
ok('a live push with no bridge is refused', r.ok === false, r);
ok('...naming what to pass and what to set', /GAME/.test(r.error) && /mcptoolkitPushSettings/.test(r.error), r.error);
ok('...and nothing was posted anywhere', posts.length === 0, posts);
ok('the refusal does not mention 25599 as a fallback', !/25599/.test(r.error), r.error);
// The whole defect in one assertion: the file used to carry this literal, and a consumer repo's
// game is never on it.
ok('the plugin source carries no hardcoded game port',
    !/127\.0\.0\.1:255\d\d/.test(fs.readFileSync(PLUGIN, 'utf8').split('(function ()')[1]),
    'a literal bridge URL is back in the code');

reset();
r = await push({ bridge: 'http://127.0.0.1:25640', ...NS });
ok('a bridge passed per call is used', r.ok === true, r);
ok('...as the /cmd endpoint of that origin', posts.every((p) => p.url === 'http://127.0.0.1:25640/cmd'), posts.map((p) => p.url));
ok('...for the texture and the reload alike',
    posts.map((p) => p.tool).join(',') === 'push_asset,reload_resources', posts.map((p) => p.tool));
ok('and the summary says where it went', r.bridge === 'http://127.0.0.1:25640/cmd', r);

for (const [given, want] of [
    ['http://127.0.0.1:25640/', 'http://127.0.0.1:25640/cmd'],
    ['http://127.0.0.1:25640/cmd', 'http://127.0.0.1:25640/cmd'],
]) {
    reset();
    r = await push({ bridge: given, ...NS });
    ok('"' + given + '" normalises to one /cmd', posts[0] && posts[0].url === want, posts[0] ? posts[0].url : r);
}

// `posts[0] &&` throughout: a push refused before it posts leaves the list empty, and a harness
// that throws on that reports nothing about the checks after it (this file died that way once).
reset();
settings({ bridge: 'http://127.0.0.1:25599' });
r = await push(NS);
ok('a stored global bridge is the fallback', posts[0] && posts[0].url === 'http://127.0.0.1:25599/cmd', posts[0] ? posts[0].url : r);
settings({ bridges: { beta: 'http://127.0.0.1:25641' } });
posts.length = 0;
r = await push(NS);
ok('a per-project bridge beats the global one, because the port NAMES the project',
    posts[0] && posts[0].url === 'http://127.0.0.1:25641/cmd', posts[0] ? posts[0].url : r);
posts.length = 0;
r = await push({ bridge: 'http://127.0.0.1:25642', ...NS });
ok('and an explicit one beats both', posts[0] && posts[0].url === 'http://127.0.0.1:25642/cmd', posts[0] ? posts[0].url : r);

// =============================================================================================
section('2. WHICH PROJECT: an object is used, a name is refused');
// =============================================================================================
reset();
r = await push({ bridge: 'http://127.0.0.1:25640', project: 'alpha', ...NS });
ok('a project NAME is refused', r.ok === false && /not the name "alpha"/.test(r.error), r);
ok('...pointing at PROJECT and saying why a name is not enough',
    /PROJECT/.test(r.error) && /ownership check/.test(r.error), r.error);
ok('...before anything was posted', posts.length === 0, posts);

reset();
r = await push({ bridge: 'http://127.0.0.1:25640', project: alpha, model: true, ...NS });
ok('a project OBJECT is pushed', r.ok === true, r);
ok('...selected first, because Blockbench works on the active tab', alpha.selected === 1 && g.Project === alpha, alpha.selected);
ok('...and it is ALPHA\'s textures that were collected, not the tab that was active',
    posts.some((p) => p.args.path && /alpha_tex\.png$/.test(p.args.path))
    && !posts.some((p) => p.args.path && /beta_tex/.test(p.args.path)),
    posts.map((p) => p.args.path));
ok('...and ALPHA\'s codec that compiled the model',
    Buffer.from(posts.find((p) => /\.json$/.test(p.args.path || '')).args.base64, 'base64').toString() === '{"alpha":true}',
    posts.map((p) => p.args.path));
ok('the summary names the project it acted on', r.project === 'alpha', r);

// ...and the object has to be what is READ, not merely what is selected. Selecting normally makes
// the globals agree, which is exactly why a collector that reads `Texture.all` and `Format` looks
// correct in every ordinary run. Here `select()` leaves the globals on beta - a Blockbench whose
// global view lags the tab switch - and the push must still be alpha's pixels and alpha's codec.
reset();
const realSelect = alpha.select;
alpha.select = function () { g.Project = this; this.selected++; };
r = await push({ bridge: 'http://127.0.0.1:25640', project: alpha, model: true, ...NS });
alpha.select = realSelect;
ok('the project OBJECT is what is read, not the globals the tab switch happens to set',
    r.ok === true && posts.some((p) => /alpha_tex\.png$/.test(p.args.path || ''))
    && !posts.some((p) => /beta_tex/.test(p.args.path || '')), posts.map((p) => p.args.path));
ok('...its codec too', r.ok === true
    && Buffer.from(posts.find((p) => /\.json$/.test(p.args.path || '')).args.base64, 'base64').toString() === '{"alpha":true}',
    posts.map((p) => p.args.path));

reset();
r = await push({ bridge: 'http://127.0.0.1:25640', ...NS });
ok('with no project the ACTIVE one is used and named', r.ok === true && r.project === 'beta', r);

// =============================================================================================
section('3. what did not change');
// =============================================================================================
reset();
r = await push({ target: 'source', project: alpha, ...NS });
ok('target:source still refuses without a sourceRoot', r.ok === false && /sourceRoot/.test(r.error), r);
ok('...and does NOT ask for a bridge it has no use for', !/bridge/.test(r.error), r.error);

reset();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcptk-sync-'));
settings({ sourceRoots: { alpha: tmp } });
r = await push({ target: 'source', project: alpha, namespace: 'mymod', folder: 'textures/block' });
ok('a source push needs no bridge at all', r.ok === true && posts.length === 0, r);
ok('...and lands the file where the sourceRoot says',
    fs.existsSync(path.join(tmp, 'assets/mymod/textures/block/alpha_tex.png')), tmp);
ok('...with the bridge left null in the summary', r.bridge === null, r);

reset();
r = await push({ bridge: 'http://127.0.0.1:25640', only: ['nope'], ...NS });
ok('a texture that is not in the project is still refused by name',
    r.ok === false && /nope/.test(r.error), r);

reset();
nextAnswer = () => ({ ok: false, error: 'no game there' });
r = await push({ bridge: 'http://127.0.0.1:25640', ...NS });
ok('a refusing bridge RESOLVES as {ok:false} rather than rejecting (it would wedge risky_eval)',
    r.ok === false && /no game there/.test(r.error), r);
ok('and the last summary is mirrored for a caller that cannot await',
    g.mcptoolkitLastPush && g.mcptoolkitLastPush.ok === false, g.mcptoolkitLastPush);

// =============================================================================================
section('4. an explicit null is refused, target is checked, and a settings patch merges');
// =============================================================================================
// The refuse-on-null rule of 0.140.0 held for an ABSENT key and not for the `GAME` an agent
// dutifully passes when it is null (isolation record section 13): `bridge: null` fell through to
// the stored URL - whichever game somebody typed in last - and `project: null` to the active tab,
// a project the caller had just been told does not exist.
reset();
settings({ bridge: 'http://127.0.0.1:25599' });
r = await push({ bridge: null, ...NS });
ok('`bridge: null` is refused, not resolved from the store', r.ok === false && /bridge is null/.test(r.error), r);
ok('...saying that GAME is null because the shim never said, and what to pass instead', /GAME is null/.test(r.error) && /ping/.test(r.error) && /mcptoolkitPushSettings\(\{bridges:/.test(r.error), r.error);
ok('...and nothing was posted to the stored game', posts.length === 0, posts);
reset();
r = await push({ bridge: GAME, project: null, ...NS });
ok('`project: null` is refused, not resolved to the active tab', r.ok === false && /project is null/.test(r.error) && /PROJECT is null because no project is open/.test(r.error), r);
ok('...before anything was posted', posts.length === 0, posts);
ok('...and beta, the active tab, was not selected on the way', beta.selected === 0, beta.selected);
// `target` was never validated, so `target:'game'` pushed nothing and answered `ok:true, pushed:N`.
reset();
r = await push({ bridge: GAME, target: 'game', ...NS });
ok('an unknown `target` is refused with the three values', r.ok === false && /target must be one of live \| source \| both, not "game"/.test(r.error), r);
ok('...and nothing was posted, nothing answered pushed', posts.length === 0 && r.pushed === undefined, { posts, r });
// A headless settings patch REPLACED whole per-project maps where the dialog had always merged.
reset();
settings({ bridges: { x: 'http://127.0.0.1:1' } });
const merged = settings({ bridges: { y: 'http://127.0.0.1:2' } });
ok('a second per-project bridge keeps the first: the maps merge', merged.bridges.x === 'http://127.0.0.1:1' && merged.bridges.y === 'http://127.0.0.1:2', merged.bridges);
settings({ namespaces: { x: 'a' } });
settings({ sourceRoots: { x: 'C:/a' } });
const all = settings({ namespaces: { y: 'b' } });
ok('...for every per-project map, and a patch to one leaves the others alone', all.namespaces.x === 'a' && all.namespaces.y === 'b' && all.sourceRoots.x === 'C:/a' && all.bridges.x === 'http://127.0.0.1:1', all);
ok('...and it is what the store holds, not only what was answered', JSON.parse(store[Object.keys(store)[0]]).bridges.x === 'http://127.0.0.1:1', store);

console.log('\n' + (failures ? failures + ' FAILED of ' + count : 'all ' + count + ' ok'));
process.exit(failures ? 1 : 0);
