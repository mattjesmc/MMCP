// Regression harness for mcptoolkit_entity.js -- a Blockbench-shaped stub, so the plugin's headless
// half can be exercised without Blockbench. It stubs only what the plugin touches; anything else
// throwing is a finding, not a harness bug. Modelled on menagerie_divisions.test.mjs, which lived
// next door until phase 3 sent it home to `menagerie/blockbench/`.
//
//   cd mcp-toolkit/blockbench && node mcptoolkit_entity.test.mjs
//
// It covers the headless half ONLY: the Dialog, the buttons and the menu entry are the part a
// harness cannot reach, and ENTITY_AUTHORING_DESIGN.md §7 says so rather than implying otherwise.
//
// ---------------------------------------------------------------------------------------------
// WHAT THIS HARNESS LEARNT FROM THE ONE IT WAS MODELLED ON, AND WHY SECTION 3 IS THE LONGEST
//
// menagerie_divisions.test.mjs §4b (now in the menagerie checkout): its byte-equality check passed
// over all 29 shipped divisions while the format had a hole in it, because NO SHIPPED SUBJECT
// USED THE MISSING FEATURE. A round trip is worth only the vocabulary its subjects exercise.
//
// So the first thing this file did was ask what the seventeen `.bbmodel` sources in this workspace
// actually contain, and the answer was bracing: not ONE of them uses cube rotation, cube inflate,
// or mirrored UV. Three whole limbs of the conversion — including the rotation-subgroup synthesis,
// which is the most intricate thing in the plugin — have no real subject at all. Section 3 is the
// fixture that does, and it is deliberately asymmetric in every dimension so that a wrong sign or
// a swapped Euler order cannot hide behind a symmetry.
//
// ---------------------------------------------------------------------------------------------
// AND THE CHECK THAT IS NOT A ROUND TRIP AT ALL (section 2)
//
// Byte-stability proves the exporter is deterministic. It says nothing about whether the numbers
// are RIGHT — a golden file would only ever agree with whatever the exporter did the day it was
// written, which is a harness that trains a reader to edit numbers.
//
// So the real arbiter here is a GEOMETRIC one, and it uses two independent walkers written in this
// file rather than anything the plugin exports: one walks the `.bbmodel` by Blockbench's rules
// (origins absolute, y up, ZYX euler in degrees, cubes rotating about their own origin), the other
// walks the emitted interchange by VANILLA's rules (ModelPart.java:167-169 -- translate the pivot,
// then Quaternionf.rotationZYX; cube corners at origin..origin+size, grown by inflate). Every
// cube's eight corners must line up under the known map (x, y, z) -> (-x, 24 - y, z).
//
// That single assertion covers the pivot subtraction, both sign flips, the +24 ground offset, the
// rotation conjugation AND the euler order simultaneously — and it cannot be satisfied by copying
// the exporter, because neither walker knows the exporter exists.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import vm from 'node:vm';

const require_ = createRequire(import.meta.url);
const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const PLUGIN = path.join(HERE, 'mcptoolkit_entity.js');
// The real subjects: Blockbench's own output, as it is written today.
//
// PHASE 3 DECIDED THIS (ENTITY_AUTHORING_DESIGN.md §7.3). The fifteen `.bbmodel` sources lived in
// `mcmodding/blockbench_sources`, a SIBLING of mcp-toolkit (since 2026-09-06 they are in the
// rocketeer and villagejobs checkouts; fixtures/README.md) -- so on a checkout of mcp-toolkit
// alone (which is what the release is) section 2's arbiter would simply go missing,
// and a harness that quietly loses its only real subject is worse than one that never had it.
// So exactly one real model TRAVELS with the harness, in `fixtures/`, and the corpus is resolved
// widest-first: an explicit argument, then the sibling corpus, then the travelling fixture. The
// run prints which one it got, because "7 subjects" and "1 subject" are different amounts of
// evidence and the reader is entitled to know which they are reading.
const FIXTURES = path.join(HERE, 'fixtures');
const SOURCES = process.argv[2]
  || (fs.existsSync(path.resolve(HERE, '../../blockbench_sources'))
      ? path.resolve(HERE, '../../blockbench_sources')
      : FIXTURES);

const store = {};
const g = {
  require: require_,
  console,
  fetch: async () => { throw new Error('no dev game in the harness'); },
  setTimeout,
  localStorage: {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = v; },
  },
  document: {
    head: { appendChild() {} },
    getElementById: () => null,
    createElement: () => ({ style: {}, appendChild() {}, addEventListener() {}, setAttribute() {}, remove() {} }),
  },
  Blockbench: { showQuickMessage() {}, showMessageBox(o) { console.log('MSGBOX', o.message); } },
  Dialog: class { constructor(o) { this.o = o; } show() {} close() {} },
  Action: class { constructor(id, o) { this.id = id; this.o = o; } delete() {} },
  MenuBar: { addAction() {} },
  Plugin: { register(id, def) { g.__plugin = def; } },
};
g.globalThis = g;
vm.createContext(g);
vm.runInContext(fs.readFileSync(PLUGIN, 'utf8'), g, { filename: PLUGIN });
g.__plugin.onload();

const api = g.mcptoolkitEntity;
let failures = 0;
const ok = (name, cond, detail) => {
  console.log((cond ? '  ok   ' : '  FAIL ') + name + (cond ? '' : '  <- ' + detail));
  if (!cond) failures++;
};

// =============================================================================================
// The two independent walkers. Nothing below imports anything from the plugin.
// =============================================================================================

const I3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, b) => [0, 1, 2].map((i) => [0, 1, 2].map((j) =>
  a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j]));
const apply = (m, v) => [0, 1, 2].map((i) => m[i][0] * v[0] + m[i][1] * v[1] + m[i][2] * v[2]);

/** Rz(z) * Ry(y) * Rx(x) -- THREE.Euler order 'ZYX' (Blockbench's Format.euler_order default) and
 *  JOML's Quaternionf.rotationZYX(z, y, x) (what ModelPart applies). One formula, two consumers. */
function rotZYX(x, y, z) {
  const cz = Math.cos(z), sz = Math.sin(z), cy = Math.cos(y), sy = Math.sin(y);
  const cx = Math.cos(x), sx = Math.sin(x);
  return [
    [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
    [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
    [-sy, cy * sx, cy * cx],
  ];
}
const d2r = (d) => d * Math.PI / 180;
const rotDeg = (r) => rotZYX(d2r(r[0]), d2r(r[1]), d2r(r[2]));

function boxCorners(min, max, origin, frame) {
  const out = [];
  for (const x of [min[0], max[0]]) {
    for (const y of [min[1], max[1]]) {
      for (const z of [min[2], max[2]]) {
        out.push(add(frame.o, apply(frame.m, sub([x, y, z], origin))));
      }
    }
  }
  return out;
}

/** Walk a `.bbmodel` the way Blockbench does: absolute coordinates, y up, groups rotating about
 *  their own origin inside the parent's frame, cubes doing the same inside their group's. */
function blockbenchBoxes(doc) {
  const elements = {};
  (doc.elements || []).forEach((e) => { elements[e.uuid] = e; });
  const groups = {};
  (doc.groups || []).forEach((gr) => { groups[gr.uuid] = gr; });
  const out = [];

  const emit = (cube, frame, groupOrigin) => {
    if (!cube || cube.export === false) return;
    if (cube.type && cube.type !== 'cube') return;
    const origin = cube.origin || [0, 0, 0];
    const grow = cube.inflate || 0;
    const min = cube.from.map((v) => v - grow);
    const max = cube.to.map((v) => v + grow);
    const seat = {
      o: add(frame.o, apply(frame.m, sub(origin, groupOrigin))),
      m: mul(frame.m, rotDeg(cube.rotation || [0, 0, 0])),
    };
    out.push({ name: cube.name, corners: boxCorners(min, max, origin, seat) });
  };

  const walk = (nodes, frame, groupOrigin) => {
    (nodes || []).forEach((node) => {
      if (typeof node === 'string') { emit(elements[node], frame, groupOrigin); return; }
      const props = Object.assign({}, groups[node.uuid] || {}, node);
      if (props.export === false) return;
      const origin = props.origin || [0, 0, 0];
      walk(node.children, {
        o: add(frame.o, apply(frame.m, sub(origin, groupOrigin))),
        m: mul(frame.m, rotDeg(props.rotation || [0, 0, 0])),
      }, origin);
    });
  };
  walk(doc.outliner, { o: [0, 0, 0], m: I3 }, [0, 0, 0]);
  return out;
}

/** Walk the interchange the way the GAME does: PartPose translate then rotationZYX, cube corners at
 *  origin..origin+size grown by inflate (ModelPart.java:167-169 and ModelPart.Cube's ctor). */
function vanillaBoxes(model) {
  const byName = {};
  const out = [];
  (model.parts || []).forEach((part) => {
    const base = (part.parent && byName[part.parent]) || { o: [0, 0, 0], m: I3 };
    const frame = {
      o: add(base.o, apply(base.m, part.pivot)),
      m: mul(base.m, rotZYX(part.rotation[0], part.rotation[1], part.rotation[2])),
    };
    byName[part.name] = frame;
    (part.cubes || []).forEach((cube) => {
      const grow = cube.inflate || 0;
      const min = cube.origin.map((v) => v - grow);
      const max = [0, 1, 2].map((i) => cube.origin[i] + cube.size[i] + grow);
      out.push({ name: cube.name, corners: boxCorners(min, max, [0, 0, 0], frame) });
    });
  });
  return out;
}

/** The map the whole design turns on: vanilla renders through scale(-1, -1, 1) from a 24px ceiling. */
const toVanilla = (p) => [-p[0], 24 - p[1], p[2]];

const centroid = (pts) => pts.reduce((a, p) => add(a, p), [0, 0, 0]).map((v) => v / pts.length);
const sortCorners = (pts) => pts.slice().sort((a, b) =>
  (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]));

/**
 * Every cube in the .bbmodel must land, corner for corner, where the interchange puts it. Boxes are
 * paired by centroid because neither walker knows the other's ordering — and a duplicate pairing is
 * itself reported, since two cubes collapsing onto one seat is a real defect this would otherwise
 * average away.
 */
function geometryMatches(doc, model, tol = 1e-3) {
  const bb = blockbenchBoxes(doc).map((b) => ({
    name: b.name, corners: b.corners.map(toVanilla),
  }));
  const mc = vanillaBoxes(model);
  if (bb.length !== mc.length) return `cube count ${bb.length} in the .bbmodel vs ${mc.length} out`;
  const taken = new Set();
  for (const box of bb) {
    const c = centroid(box.corners);
    let best = -1, bestD = Infinity;
    mc.forEach((cand, i) => {
      if (taken.has(i)) return;
      const d = Math.hypot(...sub(centroid(cand.corners), c));
      if (d < bestD) { bestD = d; best = i; }
    });
    if (best < 0) return `no seat left for "${box.name}"`;
    taken.add(best);
    const a = sortCorners(box.corners), b = sortCorners(mc[best].corners);
    for (let i = 0; i < 8; i++) {
      for (let k = 0; k < 3; k++) {
        if (Math.abs(a[i][k] - b[i][k]) > tol) {
          return `"${box.name}" corner ${i} axis ${'xyz'[k]}: bbmodel says ${a[i][k].toFixed(4)},`
            + ` interchange says ${b[i][k].toFixed(4)}`;
        }
      }
    }
  }
  return null;
}

// =============================================================================================
// Fixture construction
// =============================================================================================

let uid = 0;
const uuid = (tag) => `${tag}-${(uid++).toString().padStart(4, '0')}`;

function cube(o) {
  return Object.assign({
    uuid: uuid('c'), type: 'cube', box_uv: true, export: true,
    origin: [0, 0, 0], uv_offset: [0, 0],
  }, o);
}

function group(o) {
  return Object.assign({ uuid: uuid('g'), export: true, origin: [0, 0, 0], rotation: [0, 0, 0] }, o);
}

/** A `.bbmodel` document in the shape Blockbench 5.x writes: flat `groups`, nested `outliner`. */
function doc({ name = 'fixture', resolution = { width: 64, height: 64 }, format = 'modded_entity',
               textures = [{ name: 'skin.png' }], cubes = [], groups: grps = [], outliner = [],
               animations = [] }) {
  return {
    meta: { format_version: '4.10', model_format: format, box_uv: true },
    name, resolution, modded_entity_flip_y: true, modded_entity_version: '1.17',
    elements: cubes, groups: grps, outliner, textures, animations,
  };
}

// =============================================================================================

console.log('\n1. status, with no Blockbench and no game');
let r = await api({ action: 'status' });
ok('status answers rather than throwing', r.ok === true, JSON.stringify(r));
ok('it reports the sync plugin missing', r.sync_plugin === false, r.sync_plugin);
ok('and the game unreachable, with the reason', r.game === false && !!r.game_error, JSON.stringify(r));
ok('the source root default is EMPTY, not somebody\'s checkout',
  r.settings.sourceRoot === '', r.settings.sourceRoot);

// ---------------------------------------------------------------------------------------------
console.log('\n2. the real subjects: every cube lands where the .bbmodel put it');
console.log('   corpus: ' + SOURCES + (SOURCES === FIXTURES
  ? '  (the travelling fixture -- the full workspace corpus is not beside this checkout)'
  : ''));
if (!fs.existsSync(SOURCES)) {
  ok('the .bbmodel sources are where the harness expects them', false,
    SOURCES + ' does not exist — pass the directory as argv[2]');
} else {
  const ALL = fs.readdirSync(SOURCES).filter((f) => f.endsWith('.bbmodel')).sort();
  // The workspace's `.bbmodel` sources are two different things: seven entity models and eight
  // BLOCK models, which are authored inside a 0..16 block and use per-face UV. Only the first kind
  // is this exporter's subject, and partitioning them here is the assertion -- an exporter that
  // happily converted a block model would be producing an entity standing somewhere nobody drew.
  const REAL = ALL.filter((f) =>
    JSON.parse(fs.readFileSync(path.join(SOURCES, f), 'utf8')).meta.model_format === 'modded_entity');
  const BLOCKS = ALL.filter((f) => !REAL.includes(f));
  ok('there are real entity subjects to convert', REAL.length > 0, REAL.length);
  let converted = 0;
  let refused = [];
  for (const file of REAL) {
    const full = path.join(SOURCES, file);
    const raw = JSON.parse(fs.readFileSync(full, 'utf8'));
    const out = await api({ action: 'convert', file: full, model: file.replace(/\.bbmodel$/, '') });
    if (!out.ok) { refused.push(file + ': ' + out.error); continue; }
    converted++;
    const model = JSON.parse(out.json);
    const problem = geometryMatches(raw, model);
    ok(file, problem === null, problem);
    // The loader's own rules, checked from the outside: format 1, parents before children, unique
    // names. A file that breaks any of these bakes as the magenta error cube in the game.
    const seen = new Set();
    let order = null;
    for (const part of model.parts) {
      if (seen.has(part.name)) order = 'duplicate part name ' + part.name;
      if (part.parent && !seen.has(part.parent)) order = part.name + ' names ' + part.parent
        + ', which is not defined above it';
      seen.add(part.name);
    }
    ok('  ' + file + ': parents come first, names unique', order === null, order);
  }
  ok('every shipped ENTITY source converts', refused.length === 0, refused.join(' | '));
  console.log('   ' + converted + ' of ' + REAL.length + ' entity sources converted, '
    + BLOCKS.length + ' block models set aside');

  // Per-face UV is the one thing format 1 does not speak, and the block models all use it -- so the
  // refusal is checked against a REAL file rather than only against a fixture. This arm exists
  // only while the block half of the corpus is present; section 5 carries the fixture-backed
  // version, so a narrower corpus costs the WORKED EXAMPLE and never the check itself.
  if (!BLOCKS.length) {
    console.log('   no block models in this corpus, so the partition below is not exercised here'
      + ' -- the per-face refusal and the ground-line warning are checked on fixtures in section 5');
  } else {
    const perFace = BLOCKS.filter((f) => {
      const d = JSON.parse(fs.readFileSync(path.join(SOURCES, f), 'utf8'));
      return (d.elements || []).some((e) => e.box_uv === false);
    });
    ok('the block models do use per-face UV, so the refusal has a real subject',
      perFace.length > 0, BLOCKS.join(','));
    if (perFace.length) {
      r = await api({ action: 'convert', file: path.join(SOURCES, perFace[0]) });
      ok('a real per-face-UV model is refused by name, not silently mis-UV\'d',
        r.ok === false && /PER-FACE UV/.test(r.error), JSON.stringify(r));
    }
    // A block model with box UV would convert -- and land somewhere nobody drew it. Not one of
    // this workspace's eight is box-UV, so this arm has never once run against a real subject:
    // phase 3's audit found it dark, and section 5 now plants the fixture it was always missing.
    const boxUvBlock = BLOCKS.find((f) => !perFace.includes(f));
    console.log('   ' + (boxUvBlock ? 'one box-UV block model in the corpus: ' + boxUvBlock
      : 'no box-UV block model in the corpus -- the ground-line warning rides a fixture'));
    if (boxUvBlock) {
      r = await api({ action: 'convert', file: path.join(SOURCES, boxUvBlock) });
      ok('a box-UV block model converts but is warned about',
        r.ok && r.warnings.some((w) => /ground line/.test(w)), JSON.stringify(r.warnings));
    }
  }
}

// ---------------------------------------------------------------------------------------------
console.log('\n3. THE VOCABULARY NO SHIPPED SUBJECT EXERCISES');
console.log('   (cube rotation, merged rotation subgroups, inflate, mirrored UV, root cubes,');
console.log('    a three-axis bone rotation -- see this file\'s header for why that is section 3)');

// Deliberately asymmetric everywhere: no two dimensions equal, no angle a multiple of 90, no pivot
// on an axis of symmetry. A sign flip or a swapped Euler order has nowhere to hide.
const bodyG = group({ name: 'body', origin: [0, 9, 0], rotation: [0, 0, 0] });
const tiltG = group({ name: 'tilt', origin: [3, 11, -2], rotation: [17, -23, 41] });
const headG = group({ name: 'head', origin: [5, 14, -6], rotation: [0, -30, 0] });

const bodyCube = cube({ name: 'torso', from: [-4, 6, -3], to: [3, 12, 5], uv_offset: [0, 0] });
const fatCube = cube({ name: 'padding', from: [-2, 12, -1], to: [1, 15, 2], uv_offset: [40, 0],
  inflate: 0.25 });
const mirrorCube = cube({ name: 'fin_r', from: [4, 10, 0], to: [7, 11, 4], uv_offset: [0, 24],
  mirror_uv: true });
// Two cubes with the SAME single-axis rotation whose pivots differ ONLY along that axis: the codec
// merges them into one subgroup, and a pivot may slide freely along the axis it turns about.
const spinA = cube({ name: 'blade_a', from: [-1, 16, -6], to: [2, 17, -1], origin: [0, 16, -3],
  rotation: [0, 37, 0], uv_offset: [0, 40] });
const spinB = cube({ name: 'blade_b', from: [-1, 18, -6], to: [2, 19, -1], origin: [0, 21, -3],
  rotation: [0, 37, 0], uv_offset: [24, 40] });
// Same angle, pivot differing on an axis that is NOT rotated -> a SEPARATE subgroup.
const spinC = cube({ name: 'blade_c', from: [-1, 22, -6], to: [2, 23, -1], origin: [4, 22, -3],
  rotation: [0, 37, 0], uv_offset: [48, 40] });
// A cube at the outliner root, which has no bone at all until `bb_main` is synthesised.
const loose = cube({ name: 'ground_tab', from: [-6, 0, -6], to: [-2, 1, -1], uv_offset: [0, 52] });
const headCube = cube({ name: 'skull', from: [3, 13, -9], to: [8, 18, -4], uv_offset: [20, 20] });

const vocab = doc({
  name: 'vocab',
  cubes: [bodyCube, fatCube, mirrorCube, spinA, spinB, spinC, loose, headCube],
  groups: [bodyG, tiltG, headG],
  outliner: [
    { uuid: bodyG.uuid, children: [
      bodyCube.uuid,
      { uuid: tiltG.uuid, children: [fatCube.uuid, mirrorCube.uuid, spinA.uuid, spinB.uuid, spinC.uuid] },
      { uuid: headG.uuid, children: [headCube.uuid] },
    ] },
    loose.uuid,
  ],
});

r = await api({ action: 'convert', doc: vocab, model: 'vocab' });
ok('the vocabulary fixture converts', r.ok, JSON.stringify(r).slice(0, 300));
if (r.ok) {
  const model = JSON.parse(r.json);
  const names = model.parts.map((p) => p.name);
  ok('root cubes get the bb_main catch bone', names.includes('bb_main'), names.join(','));
  // Blockbench walks a bone's cubes in REVERSE and names a subgroup after whichever cube made it,
  // so the merged pair is `blade_b_r1` and not `blade_a_r1` even though blade_a comes first in the
  // outliner. That is worth pinning rather than papering over: it is the kind of detail that makes
  // an export differ from Blockbench's own for no visible reason, and the names are what a
  // consumer mod's animation code will address parts by.
  const subgroups = names.filter((n) => /_r1$/.test(n));
  ok('rotated cubes get rotation subgroups', subgroups.length === 2, subgroups.join(','));
  ok('two cubes sharing an angle and a rotated-axis pivot share ONE subgroup',
    model.parts.find((p) => p.name === 'blade_b_r1')
      && model.parts.find((p) => p.name === 'blade_b_r1').cubes.length === 2,
    JSON.stringify(names));
  ok('a third with a pivot off a NON-rotated axis gets its own',
    model.parts.find((p) => p.name === 'blade_c_r1')
      && model.parts.find((p) => p.name === 'blade_c_r1').cubes.length === 1,
    names.join(','));
  ok('and a subgroup hangs off the bone the cubes were in',
    model.parts.find((p) => p.name === 'blade_b_r1').parent === 'tilt',
    model.parts.find((p) => p.name === 'blade_b_r1').parent);
  ok('every cube is accounted for once',
    model.parts.reduce((n, p) => n + p.cubes.length, 0) === 8,
    model.parts.map((p) => p.name + ':' + p.cubes.length).join(' '));
  ok('inflate survives', model.parts.some((p) => p.cubes.some((c) => c.inflate === 0.25)),
    JSON.stringify(model.parts.flatMap((p) => p.cubes.map((c) => c.inflate))));
  ok('mirrored UV survives', model.parts.some((p) => p.cubes.some((c) => c.mirror === true)),
    'no cube came out mirrored');

  // THE assertion. Everything above is bookkeeping; this is the conversion.
  const problem = geometryMatches(vocab, model);
  ok('every corner of all eight cubes lands where Blockbench put it', problem === null, problem);

  // And the three-axis rotation, called out separately: it is the ONLY thing that can tell a
  // correct Euler treatment from one that happens to work because every real subject rotates about
  // a single axis. If the plugin converted the order (it must not) or negated the wrong pair of
  // axes, `tilt` is the part that says so.
  const tilt = model.parts.find((p) => p.name === 'tilt');
  ok('a three-axis bone negates x and y and keeps z, in radians',
    Math.abs(tilt.rotation[0] - -d2r(17)) < 1e-6
    && Math.abs(tilt.rotation[1] - -d2r(-23)) < 1e-6
    && Math.abs(tilt.rotation[2] - d2r(41)) < 1e-6,
    JSON.stringify(tilt.rotation));
  ok('its pivot is relative to the parent, x and y negated',
    JSON.stringify(tilt.pivot) === JSON.stringify([-3, -2, -2]), JSON.stringify(tilt.pivot));
  ok('a root bone gets the +24 ground offset instead',
    JSON.stringify(model.parts.find((p) => p.name === 'body').pivot) === JSON.stringify([0, 15, 0]),
    JSON.stringify(model.parts.find((p) => p.name === 'body').pivot));
  ok('the texture is referenced, not embedded',
    model.texture.asset === 'mcptoolkit:textures/preview/vocab/skin.png', model.texture.asset);
  // The hitbox, checked against the independent walker rather than against a number somebody typed:
  // the model's height is the highest point Blockbench draws, in blocks, and its width is twice its
  // reach from the axis. A preview standing outside its own hitbox is a mistake this workspace has
  // already made once (the narwhal), and the server never parses geometry, so this is the ONLY
  // place the two can be made to agree.
  const drawn = blockbenchBoxes(vocab).flatMap((b) => b.corners);
  const tallest = Math.max(...drawn.map((p) => p[1]));
  const reach = Math.max(...drawn.map((p) => Math.max(Math.abs(p[0]), Math.abs(p[2]))));
  ok('the hitbox height is the top of the drawn model, in blocks',
    Math.abs(r.size[1] - tallest / 16) < 0.002, r.size[1] + ' vs ' + (tallest / 16).toFixed(4));
  ok('and its width is twice the reach from the axis',
    Math.abs(r.size[0] - 2 * reach / 16) < 0.002, r.size[0] + ' vs ' + (2 * reach / 16).toFixed(4));
}

// ---------------------------------------------------------------------------------------------
console.log('\n4. the same document converts to the same bytes');
const first = await api({ action: 'convert', doc: vocab, model: 'vocab' });
const second = await api({ action: 'convert', doc: JSON.parse(JSON.stringify(vocab)), model: 'vocab' });
ok('byte-stable across two runs', first.json === second.json,
  'lengths ' + first.json.length + ' vs ' + second.json.length);
ok('and no -0 anywhere in it', !/-0[,\]\s]/.test(first.json.replace(/-0\.\d/g, '')),
  (first.json.match(/-0[,\]\s]/g) || []).join(' '));
ok('it parses as JSON and declares format 2', JSON.parse(first.json).format === 2);
// §9.5's guarantee, from the writing side: a model with no clips carries no `animations` key at
// all, so what a format-2 exporter emits for every subject that existed before phase 4 is what a
// format-1 exporter emitted, but for the version number.
ok('a model with no clips writes no `animations` key',
  !('animations' in JSON.parse(first.json)), Object.keys(JSON.parse(first.json)).join(','));

// ---------------------------------------------------------------------------------------------
console.log('\n5. refusals (each anticipates a refusal the loader would make, or a silent lie)');
r = await api({ action: 'convert', doc: doc({ cubes: [], outliner: [] }) });
ok('an empty model is refused', !r.ok && /no exportable cubes/.test(r.error), JSON.stringify(r));

const dupA = group({ name: 'leg', origin: [1, 0, 0] });
const dupB = group({ name: 'leg', origin: [-1, 0, 0] });
const dupCube = cube({ name: 'x', from: [0, 0, 0], to: [1, 2, 3] });
r = await api({ action: 'convert', doc: doc({
  cubes: [dupCube], groups: [dupA, dupB],
  outliner: [{ uuid: dupA.uuid, children: [dupCube.uuid] }, { uuid: dupB.uuid, children: [] }] }) });
ok('two parts with one name are refused', !r.ok && /two parts named/.test(r.error), JSON.stringify(r));

const faceCube = cube({ name: 'perface', from: [0, 0, 0], to: [2, 3, 4], box_uv: false });
r = await api({ action: 'convert', doc: doc({ cubes: [faceCube], outliner: [faceCube.uuid] }) });
ok('per-face UV is refused with the reason', !r.ok && /PER-FACE UV/.test(r.error), JSON.stringify(r));

const meshEl = { uuid: uuid('m'), type: 'mesh', name: 'blob', export: true };
const keptCube = cube({ name: 'kept', from: [0, 0, 0], to: [2, 3, 4] });
r = await api({ action: 'convert', doc: doc({ cubes: [meshEl, keptCube],
  outliner: [meshEl.uuid, keptCube.uuid] }) });
ok('a mesh element is skipped with a warning, not silently dropped',
  r.ok && r.warnings.some((w) => /not a cube/.test(w)), JSON.stringify(r.warnings));

const hidden = cube({ name: 'hidden', from: [0, 0, 0], to: [1, 1, 1], export: false });
r = await api({ action: 'convert', doc: doc({ cubes: [hidden, keptCube],
  outliner: [hidden.uuid, keptCube.uuid] }), model: 'exports' });
ok('an un-exported cube stays out', r.ok && r.cubes === 1, JSON.stringify(r));

r = await api({ action: 'convert', doc: doc({ textures: [], cubes: [keptCube],
  outliner: [keptCube.uuid] }) });
ok('a textureless project warns and still converts',
  r.ok && r.warnings.some((w) => /missing-texture/.test(w)), JSON.stringify(r.warnings));
ok('and names no texture asset', !JSON.parse(r.json).texture.asset,
  JSON.stringify(JSON.parse(r.json).texture));

// A `java_block` project converts -- the arithmetic is identical -- and lands somewhere nobody
// drew it, because a block is authored inside 0..16 rather than standing on the entity ground
// line. Section 2 has checked this against a real subject exactly never: all eight block models
// in this workspace are per-face UV, so they are REFUSED before the warning can be reached, and
// the arm that was supposed to cover it has been dark since it was written. The fixture is what
// makes it a check rather than an intention.
const blockish = cube({ name: 'slab', from: [0, 0, 0], to: [16, 8, 16] });
r = await api({ action: 'convert', doc: doc({ format: 'java_block', cubes: [blockish],
  outliner: [blockish.uuid] }), model: 'blockish' });
ok('a box-UV BLOCK project converts but is warned about the ground line',
  r.ok && r.warnings.some((w) => /ground line/.test(w)), JSON.stringify(r));

const twoTex = await api({ action: 'convert', doc: doc({
  textures: [{ name: 'a.png' }, { name: 'b.png' }], cubes: [keptCube], outliner: [keptCube.uuid] }) });
ok('a second texture is named in a warning rather than quietly dropped',
  twoTex.ok && twoTex.warnings.some((w) => /b\.png/.test(w)), JSON.stringify(twoTex.warnings));

// ---------------------------------------------------------------------------------------------
console.log('\n6. the check battery, with defects planted one at a time');

// 6a. A PLANTED OVERLAP: two cubes in one part, interpenetrating by 3px on x.
const ovA = cube({ name: 'hull', from: [-6, 4, -3], to: [0, 10, 3], uv_offset: [0, 0] });
const ovB = cube({ name: 'spar', from: [-3, 5, -2], to: [4, 9, 2], uv_offset: [40, 0] });
const ovG = group({ name: 'body', origin: [0, 4, 0] });
r = await api({ action: 'verify', model: 'overlap', doc: doc({
  cubes: [ovA, ovB], groups: [ovG],
  outliner: [{ uuid: ovG.uuid, children: [ovA.uuid, ovB.uuid] }] }) });
ok('the planted overlap is found', r.ok === false && r.counts.overlap === 1,
  JSON.stringify(r.counts));
ok('and measured at 3px, not merely flagged',
  Math.abs(r.table[0].depth - 3) < 1e-6, r.table[0] && r.table[0].depth);
ok('the table is worst-first', r.table[0].kind === 'overlap', r.table[0].kind);

// A 1px sink of the same pair is the deliberate anti-z-fight trick and must NOT fail -- but must
// still appear in the table, because a tolerance that hides its subject is a blanket skip.
const sunk = cube({ name: 'spar', from: [-1, 5, -2], to: [6, 9, 2], uv_offset: [40, 0] });
r = await api({ action: 'verify', model: 'sunk', doc: doc({
  cubes: [ovA, sunk], groups: [ovG],
  outliner: [{ uuid: ovG.uuid, children: [ovA.uuid, sunk.uuid] }] }) });
ok('a 1px sink is tolerated', r.counts.overlap === 0 && r.counts.sunk === 1, JSON.stringify(r.counts));
ok('and still printed', /sunk/.test(r.text), r.text.split('\n').slice(0, 4).join(' / '));

// 6b. A PLANTED COPLANARITY, and it is the yaw case on purpose: SAT alone scores this pair 0.000
// and clean. The two cubes touch at y = 10 with fully overlapping footprints, and one is yawed --
// which does not move a single y-face, which is the entire trap.
const copA = cube({ name: 'base', from: [-4, 4, -4], to: [4, 10, 4], uv_offset: [0, 0] });
const copB = cube({ name: 'cap', from: [-3, 10, -3], to: [3, 14, 3], uv_offset: [40, 0],
  origin: [0, 12, 0], rotation: [0, 15, 0] });
r = await api({ action: 'verify', model: 'coplanar', doc: doc({
  cubes: [copA, copB], groups: [ovG],
  outliner: [{ uuid: ovG.uuid, children: [copA.uuid, copB.uuid] }] }) });
ok('a yawed cube resting flush on another is caught',
  r.ok === false && r.counts.coplanar === 1, JSON.stringify(r.counts));
ok('SAT alone would have called it clear', r.table[0].gap === 0 && r.table[0].depth === 0,
  JSON.stringify(r.table[0]));
ok('and the shared plane is named and measured',
  r.table[0].plane && r.table[0].plane.area > 30, JSON.stringify(r.table[0].plane));

// Lift the cap 1px clear and the finding must go away -- otherwise the detector is reporting
// proximity rather than coplanarity, which is a check that can never be satisfied.
const lifted = Object.assign({}, copB, { uuid: uuid('c'), from: [-3, 11, -3], to: [3, 15, 3] });
r = await api({ action: 'verify', model: 'lifted', doc: doc({
  cubes: [copA, lifted], groups: [ovG],
  outliner: [{ uuid: ovG.uuid, children: [copA.uuid, lifted.uuid] }] }) });
ok('lifting it 1px clears the finding', r.counts.coplanar === 0 && r.counts.clear === 1,
  JSON.stringify(r.counts));

// 6c. A PLANTED UV COLLISION -- the auto-UV default, where every cube gets [0, 0].
const uvA = cube({ name: 'a', from: [0, 0, 0], to: [4, 6, 2], uv_offset: [0, 0] });
const uvB = cube({ name: 'b', from: [0, 8, 0], to: [3, 13, 2], uv_offset: [2, 1] });
r = await api({ action: 'verify', model: 'uv', doc: doc({
  cubes: [uvA, uvB], groups: [ovG],
  outliner: [{ uuid: ovG.uuid, children: [uvA.uuid, uvB.uuid] }] }) });
ok('overlapping UV footprints are found', r.uv.some((f) => f.kind === 'collision'),
  JSON.stringify(r.uv));
ok('and that alone fails the run', r.ok === false, JSON.stringify(r.counts));

const shareA = cube({ name: 'wing_l', from: [0, 0, 0], to: [4, 6, 2], uv_offset: [8, 8] });
const shareB = cube({ name: 'wing_r', from: [-6, 0, 0], to: [-2, 6, 2], uv_offset: [8, 8],
  mirror_uv: true });
r = await api({ action: 'verify', model: 'shared', doc: doc({
  cubes: [shareA, shareB], groups: [ovG],
  outliner: [{ uuid: ovG.uuid, children: [shareA.uuid, shareB.uuid] }] }) });
ok('an identical footprint reads as shared, not as a collision',
  r.uv.length === 1 && r.uv[0].kind === 'shared', JSON.stringify(r.uv));
ok('and a mirror pair does not fail the run', r.ok === true, JSON.stringify(r));

const off = cube({ name: 'toobig', from: [0, 0, 0], to: [30, 30, 30], uv_offset: [0, 0] });
r = await api({ action: 'verify', model: 'offsheet', doc: doc({
  cubes: [off], groups: [ovG], outliner: [{ uuid: ovG.uuid, children: [off.uuid] }] }) });
ok('a footprint that runs off the sheet is found', r.uv.some((f) => f.kind === 'offsheet'),
  JSON.stringify(r.uv));

// 6d. THE PAINT ARITHMETIC -- the check that proves paint landed, since a screenshot cannot show
// you a face packed off-canvas. One 4x6x2 cube covers 2*(4*6 + 2*6 + 4*2) = 88 px of sheet.
const painted = cube({ name: 'solo', from: [0, 0, 0], to: [4, 6, 2], uv_offset: [0, 0] });
const soloDoc = doc({ cubes: [painted], groups: [ovG],
  outliner: [{ uuid: ovG.uuid, children: [painted.uuid] }] });
const sheet = (opaqueCount) => {
  const data = new Uint8Array(64 * 64 * 4);
  for (let i = 0; i < opaqueCount; i++) data[i * 4 + 3] = 255;
  return { width: 64, height: 64, data };
};
r = await api({ action: 'verify', model: 'paint', doc: soloDoc, pixels: sheet(88) });
ok('88 opaque px against 88 px of face area reads as every face landing',
  r.paint.painted === 88 && r.paint.opaque === 88 && r.paint.ok === true, JSON.stringify(r.paint));
r = await api({ action: 'verify', model: 'paint', doc: soloDoc, pixels: sheet(80) });
ok('eight missing pixels fail it', r.paint.ok === false && r.ok === false, JSON.stringify(r.paint));
r = await api({ action: 'verify', model: 'paint', doc: soloDoc });
ok('with no pixels to read, it says so instead of guessing',
  r.paint.opaque === null && /no texture pixels/.test(r.text), JSON.stringify(r.paint));

// 6d'. PER-FACE COVERAGE, STRAY PAINT, AND THE FACE THAT GREW (LOOP_KIT_DESIGN.md §3, §5.4).
// The whole-sheet count above cannot tell "88 px in the right places" from "88 px in a row along
// the top of the sheet" — sheet(88) is literally the latter, and 6d passed on it. These plants put
// the paint INSIDE the face rectangles and then break one thing at a time.
const solo = { up: [2, 0, 4, 2], down: [6, 0, 4, 2], east: [0, 2, 2, 6], north: [2, 2, 4, 6],
  west: [6, 2, 2, 6], south: [8, 2, 4, 6] };
const sheetOf = (rects, extra = []) => {
  const data = new Uint8Array(64 * 64 * 4);
  const put = ([x, y, w, h]) => { for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) data[(yy * 64 + xx) * 4 + 3] = 255; };
  rects.forEach(put); extra.forEach(put);
  return { width: 64, height: 64, data };
};
r = await api({ action: 'verify', model: 'faces', doc: soloDoc, pixels: sheetOf(Object.values(solo)) });
ok('six faces painted inside their own rectangles: all complete, no stray paint',
  r.faces.length === 6 && r.faces.every((f) => f.complete) && r.paint.stray === 0 && r.ok === true,
  JSON.stringify(r.faces) + ' ' + JSON.stringify(r.uv));
ok('the report names the faces line', /faces: 6\/6 painted in full, 0 in part, 0 unpainted; 0 opaque px outside/.test(r.text), r.text);

r = await api({ action: 'verify', model: 'hole', doc: soloDoc,
  pixels: sheetOf(Object.values(solo).filter((x) => x !== solo.north)) });
ok('a face with no paint behind it is named as unpainted, and fails the run',
  r.uv.some((f) => f.kind === 'unpainted' && /solo.north$/.test(f.a)) && r.ok === false, JSON.stringify(r.uv));
ok('...and the text says which', /! unpainted: body\/solo\.north/.test(r.text), r.text);

r = await api({ action: 'verify', model: 'stray', doc: soloDoc,
  pixels: sheetOf(Object.values(solo), [[30, 30, 5, 1]]) });
ok('five opaque px outside every face are found as stray, and fail the run',
  r.paint.stray === 5 && r.uv.some((f) => f.kind === 'stray' && /5 opaque px/.test(f.detail)) && r.ok === false,
  JSON.stringify(r.uv) + ' stray=' + r.paint.stray);

// Half the north face: a NOTE (partial), not a finding — though the whole-sheet arithmetic still
// fails the run, because 12 px are missing from it.
r = await api({ action: 'verify', model: 'half', doc: soloDoc,
  pixels: sheetOf([...Object.values(solo).filter((x) => x !== solo.north), [2, 2, 4, 3]]) });
ok('a half-painted face is a partial note, not an unpainted finding',
  r.uv.some((f) => f.kind === 'partial' && /solo.north$/.test(f.a) && /12\/24/.test(f.detail))
  && !r.uv.some((f) => f.kind === 'unpainted'), JSON.stringify(r.uv));
ok('...and partial is not counted among the failures', r.failures === 1, JSON.stringify({ failures: r.failures, uv: r.uv }));

// THE FACE THAT GREW. Complete at 4x6x2; the cube is resized to 4x8x2 and the paint stays where it
// was. Without the previous report this is "partial"; with it, it is "regrown", which is the
// finding ArmorPieces' helmet shell slipped past a wholly-empty-face test.
const grown = cube({ name: 'solo', from: [0, 0, 0], to: [4, 8, 2], uv_offset: [0, 0] });
const grownDoc = doc({ cubes: [grown], groups: [ovG], outliner: [{ uuid: ovG.uuid, children: [grown.uuid] }] });
const complete = await api({ action: 'verify', model: 'grow', doc: soloDoc, pixels: sheetOf(Object.values(solo)) });
r = await api({ action: 'verify', model: 'grow', doc: grownDoc, pixels: sheetOf(Object.values(solo)), previous: complete });
ok('a face that was complete and grew is REGROWN, not merely partial',
  r.uv.some((f) => f.kind === 'regrown' && /solo.north$/.test(f.a) && /24\/32/.test(f.detail))
  && r.uv.some((f) => f.kind === 'regrown' && /solo.south$/.test(f.a)), JSON.stringify(r.uv));
ok('...and regrown counts as a failure', r.failures >= 3, JSON.stringify({ failures: r.failures }));
r = await api({ action: 'verify', model: 'grow2', doc: grownDoc, pixels: sheetOf(Object.values(solo)), previous: null });
ok('with no previous report the same sheet is only partial',
  !r.uv.some((f) => f.kind === 'regrown') && r.uv.some((f) => f.kind === 'partial'), JSON.stringify(r.uv));

// 6d''. THE CHECK CONTRACT (loop/loop.mjs): {text, problems, notes, full}, and `previous` flows.
r = await api({ action: 'check', model: 'contract', doc: soloDoc, pixels: sheetOf(Object.values(solo)) });
ok('a clean check is ok with zero problems and a one-line text',
  r.ok === true && r.problems === 0 && /^verify contract: 1 cubes, 0 pairs, poses rest - ok: nothing needs a decision$/.test(r.text),
  JSON.stringify(r.text));
const c1 = r;
r = await api({ action: 'check', model: 'contract', doc: grownDoc, pixels: sheetOf(Object.values(solo)), previous: c1 });
ok('a check after a resize reports regrown faces as problems with ! lines and carries the full text',
  r.ok === false && r.problems >= 3 && /  ! regrown body\/solo\.north 24\/32/.test(r.text) && /ALL CLEAR|FINDING/.test(r.full),
  JSON.stringify(r.text));
ok('the contract carries faces so the NEXT check can diff', Array.isArray(r.faces) && r.faces.length === 6, JSON.stringify(r.faces));

// 6e. A CLEAN MODEL MUST BE ABLE TO PASS. A check battery no real model can satisfy is a battery
// that gets switched off, so this is as load-bearing as any of the plants above.
const cleanA = cube({ name: 'body', from: [-4, 4, -3], to: [4, 12, 3], uv_offset: [0, 0] });
const cleanB = cube({ name: 'horn', from: [-1, 14, -1], to: [1, 18, 1], uv_offset: [40, 0] });
r = await api({ action: 'verify', model: 'clean', doc: doc({
  cubes: [cleanA, cleanB], groups: [ovG],
  outliner: [{ uuid: ovG.uuid, children: [cleanA.uuid, cleanB.uuid] }] }) });
ok('a clean model comes back ALL CLEAR', r.ok === true && r.counts.clear === 1,
  JSON.stringify(r.counts) + ' ' + JSON.stringify(r.uv));
ok('the report says which poses it covered', JSON.stringify(r.poses) === '["rest"]',
  JSON.stringify(r.poses));
ok('and the text says the rest pose is the only one', /rest pose only/.test(r.text), r.text);
ok('an unanimated model reports no clips and no animated findings',
  r.animated.clips.length === 0 && r.animated.findings.length === 0 && r.animated.samples === 0,
  JSON.stringify(r.animated));

// The real subjects, run through the battery. Not asserted clean -- several of them ARE known to
// have coplanar faces, and a harness that demanded green here would be asserting somebody's art is
// finished. What is asserted is that the battery survives every one of them.
if (fs.existsSync(SOURCES)) {
  const REAL = fs.readdirSync(SOURCES).filter((f) => f.endsWith('.bbmodel')).sort()
    .filter((f) => JSON.parse(fs.readFileSync(path.join(SOURCES, f), 'utf8'))
      .meta.model_format === 'modded_entity');
  let ran = 0, crashed = [];
  const summary = [];
  for (const file of REAL) {
    const out = await api({ action: 'verify', file: path.join(SOURCES, file),
      model: file.replace(/\.bbmodel$/, '') });
    if (!out.counts) { crashed.push(file + ': ' + out.error); continue; }
    ran++;
    summary.push('     ' + file.replace(/\.bbmodel$/, '').padEnd(26)
      + out.pairs + ' pairs, ' + out.counts.overlap + ' overlap, '
      + out.counts.coplanar + ' coplanar, ' + out.counts.sunk + ' sunk');
  }
  ok('the battery runs over every convertible real subject', crashed.length === 0, crashed.join(' | '));
  console.log('   ' + ran + ' real subjects measured:');
  summary.forEach((s) => console.log(s));
}

// ---------------------------------------------------------------------------------------------
console.log('\n7. promotion refuses to guess where a mod lives');
r = await api({ action: 'promote', doc: vocab, model: 'vocab' });
ok('a promotion with no sourceRoot is refused, naming the setting',
  r.ok === false && /sourceRoot/.test(r.error), JSON.stringify(r));
r = await api({ action: 'settings', set: { sourceRoots: { vocab: 'C:/tmp/mod/src/main/resources' } } });
ok('a per-project sourceRoot stores', r.settings.sourceRoots.vocab === 'C:/tmp/mod/src/main/resources',
  JSON.stringify(r.settings.sourceRoots));
r = await api({ action: 'push', doc: vocab, model: 'vocab' });
ok('a push without the sync plugin says which plugin is missing',
  r.ok === false && /mcptoolkit_sync/.test(r.error), JSON.stringify(r));

console.log('\n8. the bridge actions fail cleanly with no game running');
for (const act of ['stage', 'clear', 'list']) {
  r = await api({ action: act, model: 'vocab' });
  ok(act + ' reports rather than throws', r.ok === false && !!r.error, JSON.stringify(r));
}
r = await api({ action: 'nonsense' });
ok('an unknown action is named back', r.ok === false && /nonsense/.test(r.error), JSON.stringify(r));
ok('every result is mirrored into mcptoolkitEntityLast',
  g.mcptoolkitEntityLast && g.mcptoolkitEntityLast.error === r.error);

// ---------------------------------------------------------------------------------------------
console.log('\n9. ANIMATION: the flip again, arbitrated by its own inverse');
console.log('   (the corpus has ZERO animations -- design §9.4a -- so the subject here is'
  + ' fixtures/animated_rig.bbmodel, authored in Blockbench for exactly this)');

// The rule, written HERE from the arbiter (Blockbench's `AnimationCodec('modded_entity')
// .compileFile` composed with vanilla's `KeyframeAnimations`) and not imported from the plugin.
// Section 2 arbitrates the geometry flip by walking both spaces; this arbitrates the animation
// flip by INVERTING it -- every emitted number must map back onto the number in the .bbmodel.
const AUTHORED_TO_VANILLA = {
  position: (v) => [-v[0], -v[1], v[2]],
  rotation: (v) => [-v[0] * Math.PI / 180, -v[1] * Math.PI / 180, v[2] * Math.PI / 180],
  scale: (v) => [v[0] - 1, v[1] - 1, v[2] - 1],
};
const near = (a, b, tol = 1e-5) => Math.abs(a - b) <= tol;
// Null-safe on purpose: a MISSING key is the exact shape a regression here takes (an omitted
// `pre` reads as undefined, not as a wrong number), and a comparison that throws on it aborts
// every section below instead of reporting one line -- which is a harness that hides its own news.
const nearVec = (a, b, tol = 1e-5) => Array.isArray(a) && Array.isArray(b)
  && a.length === b.length && a.every((v, i) => near(v, b[i], tol));

const RIG = path.join(FIXTURES, 'animated_rig.bbmodel');
if (!fs.existsSync(RIG)) {
  ok('the animated fixture travels with the harness', false, RIG + ' is missing');
} else {
  const rigDoc = JSON.parse(fs.readFileSync(RIG, 'utf8'));
  r = await api({ action: 'convert', file: RIG, model: 'animated_rig' });
  ok('the animated fixture converts', r.ok, r.error);
  const rig = JSON.parse(r.json);
  ok('it declares format 2 and carries `animations`',
    rig.format === 2 && !!rig.animations, JSON.stringify(Object.keys(rig)));
  ok('the clip is named back', JSON.stringify(r.clips) === '["swing"]', JSON.stringify(r.clips));

  const clip = rig.animations.swing;
  ok('length and loop survive', clip.length === rigDoc.animations[0].length && clip.loop === true,
    JSON.stringify({ length: clip.length, loop: clip.loop }));

  // Every emitted keyframe, inverted back to the authored number it came from. A step REWRITES the
  // following keyframe's `pre` (that is how a hold is expressed, see below), so that one keyframe's
  // `pre` is checked against the step's value instead -- and the arm below proves it does.
  const animators = rigDoc.animations[0].animators;
  let checked = 0;
  let mismatch = null;
  const stepHolds = {};
  Object.keys(animators).forEach((uuid) => {
    const animator = animators[uuid];
    const bone = animator.name;
    ['rotation', 'position', 'scale'].forEach((channelName) => {
      const authored = animator.keyframes
        .filter((k) => k.channel === channelName)
        .sort((a, b) => a.time - b.time);
      if (!authored.length) return;
      const emitted = (clip.bones[bone] || []).find((c) => c.target === channelName);
      if (!emitted) { mismatch = `${bone}/${channelName} was not emitted at all`; return; }
      if (emitted.keyframes.length !== authored.length) {
        mismatch = `${bone}/${channelName}: ${authored.length} authored keyframes came out as `
          + `${emitted.keyframes.length} -- a twin-keyframe idiom would do exactly this`;
        return;
      }
      authored.forEach((src, i) => {
        const out = emitted.keyframes[i];
        const flip = AUTHORED_TO_VANILLA[channelName];
        const dp = (n) => flip([Number(src.data_points[n].x), Number(src.data_points[n].y),
          Number(src.data_points[n].z)]);
        if (!near(out.t, src.time)) mismatch = `${bone}/${channelName}[${i}] t drifted`;
        if (!nearVec(out.post, dp(src.data_points.length > 1 ? 1 : 0))) {
          mismatch = `${bone}/${channelName}[${i}] post ${JSON.stringify(out.post)} does not invert`
            + ` to the authored ${JSON.stringify(src.data_points[src.data_points.length - 1])}`;
        }
        const heldByStep = i > 0 && authored[i - 1].interpolation === 'step';
        if (heldByStep) {
          stepHolds[`${bone}/${channelName}`] = { at: i, out };
        } else if (!nearVec(out.pre || out.post, dp(0))) {
          mismatch = `${bone}/${channelName}[${i}] pre ${JSON.stringify(out.pre || out.post)}`
            + ` does not invert to the authored ${JSON.stringify(src.data_points[0])}`;
        }
        checked++;
      });
    });
  });
  ok(`every one of the ${checked} emitted keyframes inverts to the number Blockbench holds`,
    mismatch === null, mismatch);

  // The two-data-point keyframe: dp[0] -> pre, dp[1] -> post, which is Blockbench's own
  // `getLerp` (leave on point 1, arrive on point 0) spelled as vanilla's pre/post.
  const bodyRot = clip.bones.body.find((c) => c.target === 'rotation');
  const jump = bodyRot.keyframes.find((k) => k.pre && !nearVec(k.pre, k.post));
  ok('a two-data-point keyframe becomes ONE keyframe with pre != post, not two keyframes',
    !!jump && bodyRot.keyframes.length === 3, JSON.stringify(bodyRot.keyframes));
  ok('  and the y rotation is negated on both halves',
    !!jump && near(jump.pre[1], -10 * Math.PI / 180) && near(jump.post[1], 10 * Math.PI / 180),
    JSON.stringify(jump));

  // STEP: vanilla has none, and pre/post expresses it EXACTLY -- lerping prev.post -> next.pre with
  // both set to the held value is a flat segment, where the codec's `next.t - 0.001` twin ramps.
  const bodyPos = clip.bones.body.find((c) => c.target === 'position');
  const stepAt = bodyPos.keyframes[1];
  const afterStep = bodyPos.keyframes[2];
  ok('a step keyframe holds its value into the NEXT keyframe\'s `pre`',
    nearVec(afterStep.pre, stepAt.post), JSON.stringify({ stepAt, afterStep }));
  ok('  and that segment is forced LINEAR, because CATMULLROM ignores preTarget entirely',
    afterStep.interp === 'linear', afterStep.interp);
  ok('  the step keyframe itself is emitted as linear, since vanilla has no step',
    stepAt.interp === 'linear', stepAt.interp);
  ok('  and the plugin did not invent a keyframe to fake it',
    bodyPos.keyframes.length === 3 && !bodyPos.keyframes.some((k) => /0\.001/.test(String(k.t))),
    JSON.stringify(bodyPos.keyframes.map((k) => k.t)));

  // Scale is the one channel with no sign flip and a -1 shift, and the fixture is asymmetric so a
  // transposed axis cannot hide.
  const handScale = clip.bones.hand.find((c) => c.target === 'scale');
  ok('scale converts to the OFFSET vanilla applies, s - 1, per axis',
    nearVec(handScale.keyframes[1].post, [0.5, -0.5, 0.25]),
    JSON.stringify(handScale.keyframes[1].post));

  // The two places the timeline and the game genuinely disagree. Both are warnings rather than
  // silent repairs, because the game is the judge -- see the plugin header.
  ok('the catmullrom->linear segment is warned about, not silently smoothed',
    r.warnings.some((w) => /SMOOTH in the timeline and STRAIGHT in the game/.test(w)),
    r.warnings.join(' | '));
  ok('and so is the loop seam vanilla clamps',
    r.warnings.some((w) => /wraps the catmullrom control points around the loop/.test(w)),
    r.warnings.join(' | '));
}

// ---------------------------------------------------------------------------------------------
console.log('\n10. THE SAMPLER: poses computed here, from vanilla\'s own rules, not from a golden file');

/** `Mth.catmullrom` (Mth.java:582), transcribed here so the plugin's copy has something to be
 *  wrong against. */
const mthCatmullrom = (a, p0, p1, p2, p3) => 0.5 * (2 * p1 + (p2 - p0) * a
  + (2 * p0 - 5 * p1 + 4 * p2 - p3) * a * a + (3 * p1 - p0 - 3 * p2 + p3) * a * a * a);

/** `KeyframeAnimation.Entry.apply` + `AnimationChannel.Interpolations`, transcribed the same way:
 *  the SEGMENT takes the LATER keyframe's interpolation, LINEAR reads prev.post -> next.pre, and
 *  CATMULLROM reads four posts with the ends CLAMPED (not wrapped, whatever the timeline shows). */
function vanillaSample(keyframes, t, axis) {
  let prev = 0;
  keyframes.forEach((k, i) => { if (k.t <= t) prev = i; });
  const next = Math.min(keyframes.length - 1, prev + 1);
  const a = keyframes[prev], b = keyframes[next];
  const alpha = next !== prev ? Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t))) : 0;
  if (b.interp === 'catmullrom') {
    return mthCatmullrom(alpha,
      keyframes[Math.max(0, prev - 1)].post[axis], a.post[axis], b.post[axis],
      keyframes[Math.min(keyframes.length - 1, next + 1)].post[axis]);
  }
  return a.post[axis] + ((b.pre || b.post)[axis] - a.post[axis]) * alpha;
}

/** A two-bone rig on one axis: two 4px cubes whose centres sit `apart` px apart in Blockbench, and
 *  a position clip that slides the second one along x. Everything is axis aligned and only x moves,
 *  so the expected penetration is arithmetic a reader can check by hand: 4 - |separation|. */
function slider(keyframes, { aCentre = 0, bCentre = 10 } = {}) {
  const box = (cx) => ({ from: [cx - 2, 8, -2], to: [cx + 2, 12, 2] });
  const ga = group({ name: 'a', origin: [aCentre, 10, 0] });
  const gb = group({ name: 'b', origin: [bCentre, 10, 0] });
  const ca = cube(Object.assign({ name: 'a_box', origin: [aCentre, 10, 0] }, box(aCentre)));
  const cb = cube(Object.assign({ name: 'b_box', origin: [bCentre, 10, 0] }, box(bCentre)));
  return doc({
    name: 'slider', cubes: [ca, cb], groups: [ga, gb],
    outliner: [{ uuid: ga.uuid, children: [ca.uuid] }, { uuid: gb.uuid, children: [cb.uuid] }],
    animations: [{
      name: 'slide', length: keyframes[keyframes.length - 1].time, loop: 'loop',
      animators: {
        [gb.uuid]: {
          name: 'b', type: 'bone',
          keyframes: keyframes.map((k) => ({
            channel: 'position', time: k.time, interpolation: k.interp || 'linear',
            data_points: [{ x: String(k.x), y: '0', z: '0' }],
          })),
        },
      },
    }],
  });
}

// The check §9.3 is FOR: both keyframes are clear and the arc between them is not. A sampler that
// only visited authored keyframes would report a clean model here, which is the whole failure mode.
let slide = slider([{ time: 0, x: 0 }, { time: 1, x: -20 }, { time: 2, x: 0 }]);
r = await api({ action: 'verify', doc: slide, model: 'slider' });
ok('the rest pose is clear', r.counts.overlap === 0, JSON.stringify(r.counts));
{
  const kf = [0, -20, 0].map((x, i) => ({ t: i, post: AUTHORED_TO_VANILLA.position([x, 0, 0]) }));
  // vanilla x of a bone pivot is negated too, so a and b sit at -0 and -10 with the offset added
  const sep = (t) => Math.abs((-10 + vanillaSample(kf, t, 0)) - 0);
  const expect = 4 - sep(0.5);
  ok('  keyframe 0 and keyframe 1 are BOTH clear, on their own', sep(0) >= 4 && sep(1) >= 4,
    `${sep(0)} / ${sep(1)}`);
  ok('  but the midpoint between them buries one cube in the other', expect > 0, expect);
  const found = r.animated.findings[0];
  ok('the animated arm finds it, at the midpoint and nowhere else',
    !!found && near(found.t, 0.5) && r.animated.findings.length === 1,
    JSON.stringify(r.animated.findings));
  ok('  to the depth this file computed independently: ' + expect.toFixed(3) + 'px',
    !!found && near(found.depth, expect, 1e-3), found && found.depth);
  ok('  and it is marked as a finding that exists ONLY when animated',
    !!found && found.fresh === true, JSON.stringify(found));
  ok('  which is what makes the run fail', r.ok === false && r.failures >= 1, JSON.stringify(r.counts));
  ok('the report says how many poses it actually visited',
    r.poses.length === 6 && r.poses[0] === 'rest' && r.animated.samples === 5,
    JSON.stringify(r.poses));
}

// If the exporter negated x the wrong way -- CensusTool's trap, in its second home -- the slide
// would go the other way and there would be NO overlap at all. This is that check, stated as one.
{
  const mirrored = slider([{ time: 0, x: 0 }, { time: 1, x: 20 }, { time: 2, x: 0 }]);
  const away = await api({ action: 'verify', doc: mirrored, model: 'slider_away' });
  ok('sliding the OTHER way collides with nothing, so the sign is load-bearing',
    away.animated.findings.length === 0, JSON.stringify(away.animated.findings));
}

// CATMULLROM, against this file's own transcription of Mth.catmullrom. A sampler that quietly fell
// back to LINEAR would land 2.5px away from where the spline puts it, and the geometry below is
// placed so that difference is the difference between a full burial and a graze.
{
  const kf = [{ time: 0, x: 0, interp: 'catmullrom' }, { time: 1, x: -20, interp: 'catmullrom' },
    { time: 2, x: -20, interp: 'catmullrom' }, { time: 3, x: 0, interp: 'catmullrom' }];
  const vk = kf.map((k) => ({ t: k.time, interp: 'catmullrom',
    post: AUTHORED_TO_VANILLA.position([k.x, 0, 0]) }));
  const at = vanillaSample(vk, 1.5, 0);
  const linearWouldBe = 20;
  ok('the spline overshoots the flat segment it sits between, so the two differ',
    Math.abs(at - linearWouldBe) > 1, `${at} vs ${linearWouldBe}`);
  // Put cube A exactly where the spline sends B, so a correct sampler buries the two completely
  // and a sampler that fell back to LINEAR leaves a 2.5px miss. Bone x is negated into vanilla
  // space, so B's cube sits at -bCentre + offset and A's at -aCentre.
  const bCentre = 10;
  const aCentre = bCentre - at;
  const smooth = slider(kf, { aCentre, bCentre });
  const sr = await api({ action: 'verify', doc: smooth, model: 'smooth' });
  const sep = Math.abs((-bCentre + at) - (-aCentre));
  const expect = 4 - sep;
  const found = sr.animated.findings[0];
  ok('a catmullrom channel is sampled as a SPLINE, to the value computed here ('
    + at.toFixed(3) + 'px)',
    !!found && near(found.depth, expect, 1e-3),
    JSON.stringify({ expect, got: found && found.depth, findings: sr.animated.findings.length }));
}

// ---------------------------------------------------------------------------------------------
console.log('\n11. animation refusals and drops');
{
  const bezier = slider([{ time: 0, x: 0 }, { time: 1, x: -20, interp: 'bezier' }]);
  r = await api({ action: 'convert', doc: bezier, model: 'bez' });
  ok('bezier is refused by name -- vanilla has no such interpolation',
    !r.ok && /bezier cannot be/.test(r.error), JSON.stringify(r));

  const molang = slider([{ time: 0, x: 0 }, { time: 1, x: 'math.sin(query.anim_time * 90)' }]);
  r = await api({ action: 'convert', doc: molang, model: 'molang' });
  ok('a Molang expression is refused rather than coerced to NaN',
    !r.ok && /Molang EXPRESSION/.test(r.error), JSON.stringify(r));

  // An animator pointing at a group that is not exported would bake into vanilla's
  // "Cannot animate X, which does not exist in model" -- a magenta cube for the WHOLE model.
  const orphan = slider([{ time: 0, x: 0 }, { time: 1, x: -20 }]);
  orphan.animations[0].animators['no-such-group'] = {
    name: 'ghost', type: 'bone',
    keyframes: [{ channel: 'position', time: 0, interpolation: 'linear',
      data_points: [{ x: '1', y: '0', z: '0' }] }],
  };
  r = await api({ action: 'convert', doc: orphan, model: 'orphan' });
  ok('an animator on a part that is not exported is dropped, by name, before the game sees it',
    r.ok && r.warnings.some((w) => /not an exported part/.test(w)), JSON.stringify(r.warnings));
  ok('  and the rest of the clip still converts',
    r.ok && JSON.parse(r.json).animations.slide.bones.b, r.error);

  const empty = slider([{ time: 0, x: 0 }, { time: 1, x: -20 }]);
  empty.animations[0].animators = {};
  r = await api({ action: 'convert', doc: empty, model: 'emptyclip' });
  ok('a clip that animates nothing is not written, and says so',
    r.ok && !JSON.parse(r.json).animations && r.warnings.some((w) => /animates no exported bone/.test(w)),
    JSON.stringify(r.warnings));
}

console.log('\n' + (failures ? failures + ' FAILURES' : 'ALL OK'));
process.exit(failures ? 1 : 0);
