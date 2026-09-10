#!/usr/bin/env node
// The checker for `block-model.loop.json` - a Minecraft block model, read back off disk after
// `export_model` wrote it, and judged against the rules the game applies at load time.
//
// THIS IS AN EXAMPLE YOU COPY AND THEN OWN. Copy it and the loop file into your workspace's
// `.mcptoolkit/` (the loop file's `run` names it at `.mcptoolkit/check-block-model.mjs`, resolved
// against the project root) and edit the rules until they are your project's rules. The kit's
// promise is that a checker is one script with a JSON line at the end, not a proxy server.
//
//   node .mcptoolkit/check-block-model.mjs [--assets <dir>] [--unit <name>] [--json] [--brief]
//                                          [--previous <file>]
//
//   --assets    the resource root holding <namespace>/models/... (default src/main/resources/assets)
//   --unit      the model's file stem; defaults to $MCPTK_UNIT, which `run-unit.ps1` exports from
//               the brief's filename. With neither, the NEWEST model json under --assets is read,
//               which is the one export_model just wrote.
//   --json      print only the report line (the shim reads the last stdout line either way)
//   --brief     leave `full` out of the report - the compact block is what rides the reply
//   --previous  a json file holding the last report; the shim passes it when the check is
//               `stateful`. Used for one thing: saying whether the count moved.
//
// THE CONTRACT (mcp-server/loop/loop.mjs): the LAST stdout line is
//   { "text": "<the block appended to the reply>", "problems": N, "notes": N, "full": "<long form>" }
// `problems` is what a `gate` reads, so anything counted there must be something the author can
// actually fix - a missing texture file is a problem, a 32x32 sheet is a note.

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, basename, relative, sep } from "node:path";

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(name);

const ASSETS = flag("--assets", "src/main/resources/assets");
const UNIT = flag("--unit", (process.env.MCPTK_UNIT ?? "").trim() || null);
const JSON_ONLY = has("--json");
const BRIEF = has("--brief");
const PREVIOUS = flag("--previous", null);

// Minecraft's own limits, and why each is here rather than being a matter of taste:
const BOUND_LO = -16, BOUND_HI = 32;          // the game refuses an element outside this
const ANGLES = [-45, -22.5, 0, 22.5, 45];     // the only rotations a block element may carry
const AXES = ["x", "y", "z"];
const FACES = ["north", "south", "east", "west", "up", "down"];
const FACE_ROTATIONS = [0, 90, 180, 270];

const problems = [];
const notes = [];
const problem = (s) => problems.push(s);
const note = (s) => notes.push(s);

/**
 * Print the human form (unless --json) and the report line, and exit. `head` is the first line of
 * the compact block; after it come at most MAX_LINES of `!` problems then `-` notes, so the block
 * a reply carries stays a handful of lines whatever the model does.
 */
function report(head, extra) {
  const MAX_LINES = 6;
  const rest = [...problems.map((s) => `!   ${s}`), ...notes.map((s) => `-   ${s}`)];
  const lines = [head, ...rest.slice(0, MAX_LINES)];
  if (rest.length > MAX_LINES) lines.push(`    +${rest.length - MAX_LINES} more (rerun the command to see them all)`);

  let previous = null;
  if (PREVIOUS && existsSync(PREVIOUS)) {
    try { previous = JSON.parse(readFileSync(PREVIOUS, "utf8")); } catch { previous = null; }
  }
  if (previous && typeof previous.problems === "number" && previous.problems !== problems.length) {
    lines[0] += ` (was ${previous.problems})`;
  }

  const out = { text: lines.join("\n"), problems: problems.length, notes: notes.length, ...(extra ?? {}) };
  if (!BRIEF) out.full = [head, ...rest].join("\n");
  if (!JSON_ONLY) process.stdout.write(`${[head, ...rest].join("\n")}\n`);
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exit(0);
}

/** Every file under `dir` matching `ok`, depth first. A missing directory is simply empty. */
function walk(dir, ok, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, ok, out);
    else if (ok(p)) out.push(p);
  }
  return out;
}

/** A PNG's size from its IHDR, without decoding it. null when it is not a PNG. */
function pngSize(path) {
  try {
    const b = readFileSync(path);
    if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return null;
    return [b.readUInt32BE(16), b.readUInt32BE(20)];
  } catch { return null; }
}

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const triple = (v) => Array.isArray(v) && v.length === 3 && v.every(isNum);
const show = (p) => relative(process.cwd(), p).split(sep).join("/");

// --- find the model -----------------------------------------------------------------------------
// A namespace directory holds `models/`; every json under one of those is a candidate.
const namespaces = (() => {
  try { return readdirSync(ASSETS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); }
  catch { return null; }
})();

if (namespaces === null) {
  // Loud, and counted as a problem: this is the checker pointed at the wrong tree, and a checker
  // nobody can run must never read as "nothing wrong". Fix --assets in the loop file.
  problem(`no resource root at "${ASSETS}" (run from the project root, or fix --assets in the loop file)`);
  report(`! ${UNIT ?? "block"}: the checker cannot see the assets`, null);
}

const candidates = namespaces.flatMap((ns) => walk(join(ASSETS, ns, "models"), (p) => p.endsWith(".json")));
let modelPath = null;
if (UNIT) modelPath = candidates.find((p) => basename(p, ".json") === UNIT) ?? null;
else if (candidates.length) modelPath = candidates.map((p) => [p, statSync(p).mtimeMs]).sort((a, b) => b[1] - a[1])[0][0];

if (!modelPath) {
  // Not a problem: before the first export there is nothing to judge, and the useful thing to say
  // is the call that makes one.
  const name = UNIT ?? "your block";
  note(`nothing under ${ASSETS} yet - export_model {codec:"java_block", path:"${ASSETS}/<namespace>/models/block/${UNIT ?? "<name>"}.json"}`);
  report(`- ${name}: not exported yet`, null);
}

const unit = basename(modelPath, ".json");

// --- read it ------------------------------------------------------------------------------------
let model = null;
try {
  model = JSON.parse(readFileSync(modelPath, "utf8"));
} catch (e) {
  problem(`${show(modelPath)} is not valid JSON - ${e.message}`);
  report(`! ${unit}: 1 problem(s)`, null);
}
if (!model || typeof model !== "object" || Array.isArray(model)) {
  problem(`${show(modelPath)} is not a model object`);
  report(`! ${unit}: 1 problem(s)`, null);
}

const textures = (model.textures && typeof model.textures === "object" && !Array.isArray(model.textures))
  ? model.textures : {};
const elements = Array.isArray(model.elements) ? model.elements : null;

if (!elements && !model.parent) {
  problem(`${show(modelPath)} has neither "elements" nor "parent", so the game renders nothing`);
}

// --- texture variables --------------------------------------------------------------------------
// A face names a variable ("#side"); the variable resolves through `textures` to a reference
// ("mymod:block/crate"), which is a file. Either hop can be broken and they fail differently.
const used = new Set();
function resolveVar(name, seen = new Set()) {
  if (seen.has(name)) return { loop: true };
  seen.add(name);
  const v = textures[name];
  if (v === undefined) return { missing: true };
  return typeof v === "string" && v.startsWith("#") ? resolveVar(v.slice(1), seen) : { ref: v };
}

// --- elements -----------------------------------------------------------------------------------
let faceCount = 0;
for (const [i, el] of (elements ?? []).entries()) {
  const at = el && typeof el.name === "string" && el.name ? `"${el.name}"` : `element[${i}]`;
  if (!el || typeof el !== "object") { problem(`${at} is not an object`); continue; }
  if (!triple(el.from) || !triple(el.to)) { problem(`${at} needs "from" and "to", three numbers each`); continue; }
  for (let a = 0; a < 3; a++) {
    const axis = AXES[a];
    for (const [what, v] of [["from", el.from[a]], ["to", el.to[a]]]) {
      if (v < BOUND_LO || v > BOUND_HI) problem(`${at} ${what}.${axis} ${v} is outside Minecraft's ${BOUND_LO}..${BOUND_HI}`);
    }
    if (el.to[a] < el.from[a]) problem(`${at} to.${axis} ${el.to[a]} is below from.${axis} ${el.from[a]} (an inside-out cube)`);
  }
  if (AXES.every((_, a) => el.to[a] === el.from[a])) problem(`${at} has zero size on every axis`);
  else if (AXES.some((_, a) => el.to[a] === el.from[a])) note(`${at} is flat on one axis (a plane: right for a cross model, a mistake in a box)`);

  if (el.rotation !== undefined) {
    const r = el.rotation;
    if (!r || typeof r !== "object") problem(`${at} rotation is not an object`);
    else {
      if (!AXES.includes(r.axis)) problem(`${at} rotation.axis "${r.axis}" is not x, y or z (a block element rotates about ONE axis)`);
      if (!ANGLES.includes(r.angle)) problem(`${at} rotation.angle ${r.angle} is not one of ${ANGLES.join(", ")}`);
      if (r.origin !== undefined && !triple(r.origin)) problem(`${at} rotation.origin is not three numbers`);
    }
  }

  const faces = el.faces && typeof el.faces === "object" ? el.faces : {};
  for (const [name, f] of Object.entries(faces)) {
    if (!FACES.includes(name)) { problem(`${at} has a face "${name}"; the six are ${FACES.join(", ")}`); continue; }
    faceCount++;
    if (!f || typeof f !== "object") { problem(`${at} face ${name} is not an object`); continue; }
    if (typeof f.texture !== "string" || !f.texture.startsWith("#")) {
      problem(`${at} face ${name} needs texture:"#<variable>"${f.texture ? ` (has "${f.texture}")` : ""}`);
    } else {
      const key = f.texture.slice(1);
      used.add(key);
      const r = resolveVar(key);
      if (r.missing) problem(`${at} face ${name} names #${key}, which "textures" does not define`);
      else if (r.loop) problem(`#${key} resolves in a circle through "textures"`);
    }
    if (f.uv !== undefined) {
      if (!Array.isArray(f.uv) || f.uv.length !== 4 || !f.uv.every(isNum)) problem(`${at} face ${name} uv is not four numbers`);
      else {
        if (f.uv.some((v) => v < 0 || v > 16)) problem(`${at} face ${name} uv ${f.uv.join(",")} leaves 0..16 (uv is in sixteenths of the sheet, not pixels)`);
        if (f.uv[0] === f.uv[2] || f.uv[1] === f.uv[3]) problem(`${at} face ${name} uv has zero width or height, so the face is invisible`);
      }
    }
    if (f.rotation !== undefined && !FACE_ROTATIONS.includes(f.rotation)) {
      problem(`${at} face ${name} rotation ${f.rotation} is not one of ${FACE_ROTATIONS.join(", ")}`);
    }
    if (f.cullface !== undefined && !FACES.includes(f.cullface)) problem(`${at} face ${name} cullface "${f.cullface}" is not one of the six`);
  }
  if (elements && !Object.keys(faces).some((n) => FACES.includes(n))) note(`${at} has no faces, so nothing of it is drawn`);
}

// --- the texture files --------------------------------------------------------------------------
// A reference "ns:block/name" is the file <assets>/ns/textures/block/name.png. `minecraft:` is the
// game's own and is not in this tree, so it is reported and not judged.
let sheets = 0;
for (const [key, value] of Object.entries(textures)) {
  if (key !== "particle" && elements && !used.has(key)) note(`texture variable #${key} is defined and no face uses it`);
  if (typeof value !== "string") { problem(`texture "${key}" is not a string`); continue; }
  if (value.startsWith("#")) continue;
  const [ns, path] = value.includes(":") ? [value.slice(0, value.indexOf(":")), value.slice(value.indexOf(":") + 1)] : ["minecraft", value];
  if (ns === "minecraft") { note(`#${key} is the game's own "${value}" (not checked here)`); continue; }
  const file = join(ASSETS, ns, "textures", `${path}.png`);
  if (!existsSync(file)) {
    problem(`#${key} is "${value}", and ${show(file)} does not exist (texture op:write saves the sheet)`);
    continue;
  }
  sheets++;
  const size = pngSize(file);
  if (!size) problem(`#${key} points at ${basename(file)}, which is not a PNG`);
  else if (size[1] % size[0] !== 0) note(`#${key} is ${size[0]}x${size[1]}; the game reads a non-square sheet as an animation strip and wants a .mcmeta`);
  else if (size[0] & (size[0] - 1)) note(`#${key} is ${size[0]} wide, which is not a power of two`);
}

// --- the report ---------------------------------------------------------------------------------
report(
  problems.length
    ? `! ${unit}: ${problems.length} problem(s)`
    : `- ${unit}: ${(elements ?? []).length} element(s), ${faceCount} face(s), ${sheets} sheet(s) - ok`,
  { elements: (elements ?? []).length, faces: faceCount, sheets, model: show(modelPath) },
);
