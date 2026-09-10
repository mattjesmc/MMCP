// bot_scan — the deliberate look-around (SURVIVAL_MODE_PLAN.md §5b).
//
// With the ambient retina live, a hand-called `raycast_fan` under the legal profile is redundant at
// best and a fan-spam X-ray at worst — the survival profile hides it. What replaces it is EMBODIED:
// this tool turns the body (real `bot_look` steps, watchable in game), fires the retina's own fan
// args at each facing, captures every fan DELIBERATE (a commanded look moves the last-deliberate
// comparand; the annotate appendix rides the scan like any read), and returns ONLY the summary —
// coverage before/after, sectors swept, a `visible` materials tally, and whatever memory had to
// say. No block POSITIONS enter the model's context (those go to memory; ask locate) — but the
// per-id tally of what the sightlines hit does, because "what is this place made of" is the one
// question a look-around exists to answer and no other survival surface answers it (the
// w2-56123 gap: cave-vs-house-vs-outside was inferable only from enclosed+sees_sky; materials
// are the discriminator). The tally is line-of-sight honest by construction — rays cannot X-ray.
//
// A 360° arc is 4 fan steps at 90° offsets — deliberately paced by real look calls, never an
// instant omniscan. Shared by index.mjs (the survival profile) and the ablation shim (the legal
// bench arm), so bench and production present the same deliberate-look verb.

import { SCAN_FAN_ARGS } from "./ambient.mjs";
import { cachedStore } from "./capture.mjs";
import { processWorldRead } from "./annotate.mjs";

/** The fan's own horizontal field — the step size a sweep tiles the arc with. */
const FAN_H_FOV = SCAN_FAN_ARGS.h_fov;
/** Coverage is reported over this disc around the body — the legal locate's default radius. */
const COVERAGE_RADIUS = 64;
/** The `visible` tally names at most this many block kinds; the rest are a stated count. */
const VISIBLE_KINDS_CAP = 6;

/** Compass name → Minecraft yaw (0 = south/+Z, 90 = west/−X, 180 = north/−Z, −90 = east/+X). */
const COMPASS_YAW = {
  s: 0, sw: 45, w: 90, nw: 135, n: 180, ne: -135, e: -90, se: -45,
  south: 0, southwest: 45, west: 90, northwest: 135, north: 180,
  northeast: -135, east: -90, southeast: -45,
};

export const SCAN_TOOL = {
  name: "bot_scan",
  description: "Have YOUR body LOOK AROUND: turns in real bot_look steps and commits what each "
    + "facing sees to memory (block positions are not dumped into context — ask locate / read the "
    + "remembered appendix afterwards). Default sweeps the full 360°; `direction` (N/NE/E/… or a "
    + "yaw in degrees) with `arc` (degrees, default 120 when a direction is given) scans one way — "
    + "e.g. the least-explored direction a locate miss names. `pitch` tilts the gaze (degrees, "
    + "+down, default 10). Returns `visible` — a tally of what your sightlines hit (distinct "
    + "blocks per id: stone = cave, planks = structure, grass = outside), `items` — dropped "
    + "stacks in sight, named and counted, usually your own drops (walk over them to collect) — "
    + "the swept sectors, "
    + "your seen-coverage before/after, and `horizons` — how far each compass sightline ran "
    + "before hitting something. UNDERGROUND the horizons are the real answer: 'sealed in rock' "
    + "means scanning cannot reveal more (mine or travel instead); a long horizon names the cave "
    + "to follow. Plus anything memory flagged. Requires a spawned body.",
  inputSchema: {
    type: "object",
    properties: {
      direction: { type: "string", description: "Compass direction (N, NE, …) or yaw degrees to scan toward; omit for a full 360° sweep. Also accepts 'down'/'up': a full sweep at a steep gaze (the ground / the sky)." },
      arc: { type: "number", description: "Arc width in degrees (default 360 without direction, 120 with)." },
      pitch: { type: "number", description: "Gaze pitch in degrees, positive = down (default 10)." },
    },
  },
};

function yawOf(direction) {
  if (direction === undefined || direction === null || direction === "") return null;
  const byName = COMPASS_YAW[String(direction).trim().toLowerCase()];
  if (byName !== undefined) return byName;
  const deg = Number(direction);
  if (!Number.isFinite(deg)) {
    throw new Error(`bot_scan: unknown direction "${direction}" (compass name or yaw degrees; `
      + `for up/down use \`pitch\` — degrees, positive looks down, e.g. pitch:45 with any direction)`);
  }
  return deg;
}

/** The yaw steps that tile [center-arc/2, center+arc/2] with the fan's own FOV. */
export function sweepYaws(centerYaw, arc) {
  const span = Math.max(1, Math.min(360, arc));
  const steps = Math.max(1, Math.min(4, Math.ceil(span / FAN_H_FOV)));
  if (steps === 1) return [centerYaw];
  const usable = span - FAN_H_FOV; // first and last fan centers sit half a FOV inside the arc edges
  const out = [];
  for (let i = 0; i < steps; i++) {
    out.push(centerYaw - usable / 2 + (usable * i) / (steps - 1));
  }
  return out;
}

/**
 * Run the scan through `callBridge`. Returns the bridge's {ok, result|error} envelope shape.
 * Every fan is captured DELIBERATE via processWorldRead — the same path a hand-called read takes.
 */
export async function botScan(args, callBridge) {
  const a = args ?? {};
  const status = await callBridge("bot_status", {});
  if (!status.ok || !status.result?.spawned) {
    return { ok: false, error: "bot_scan needs a spawned body (bot_body spawn first)" };
  }
  const pos = status.result.pos;
  const dim = typeof status.result.dimension === "string" ? status.result.dimension : "minecraft:overworld";
  const center = [Math.floor(pos.x), Math.floor(pos.z)];
  let pitch = Number.isFinite(a.pitch) ? a.pitch : 10;

  // "down"/"up" are PITCH words, not compass words — but a session that wants the ground says
  // "down" (both haiku probe runs did), so accept them: a full sweep (unless `arc` narrows it)
  // at a steep gaze, and any given pitch is bent to the named half (+down / -up).
  let direction = a.direction;
  const dword = typeof direction === "string" ? direction.trim().toLowerCase() : null;
  if (dword === "down" || dword === "up") {
    pitch = Number.isFinite(a.pitch)
      ? (dword === "down" ? Math.abs(a.pitch) : -Math.abs(a.pitch))
      : (dword === "down" ? 55 : -40);
    direction = undefined;
  }

  const dirYaw = yawOf(direction);
  const arc = Number.isFinite(a.arc) ? a.arc : dirYaw === null ? 360 : FAN_H_FOV;
  const baseYaw = dirYaw !== null ? dirYaw : Number.isFinite(status.result.yaw) ? status.result.yaw : 0;

  const store = await cachedStore(callBridge);
  const before = await store.legalCoverage({ center, radius: COVERAGE_RADIUS, dim });

  const remembered = [];
  const horizons = {}; // compass sector -> longest open sightline seen this sweep (blocks)
  const seen = new Map(); // block id -> Set of "x,y,z" — distinct positions the sweep's rays hit
  const items = new Map(); // item id -> {count, at, nearest, bearing} — dropped stacks in sight
  let fans = 0;
  for (const yaw of sweepYaws(baseYaw, arc)) {
    // sweep_ticks: the head TURNS to each fan heading (~0.4s) instead of teleporting — a watcher
    // sees the scan happen. The ambient retina never calls bot_look, so it stays motionless.
    const look = await callBridge("bot_look", { yaw, pitch, sweep_ticks: 8 });
    if (!look.ok) return { ok: false, error: `bot_scan: look failed mid-sweep: ${look.error}` };
    const fan = await callBridge("raycast_fan", { ...SCAN_FAN_ARGS });
    if (!fan.ok) return { ok: false, error: `bot_scan: fan failed mid-sweep: ${fan.error}` };
    fans++;
    accumulateHorizons(horizons, fan.result, yaw);
    accumulateVisible(seen, fan.result);
    accumulateItems(items, fan.result, yaw);
    // Deliberate capture + appendix — the scan is a commanded look, so it moves last-deliberate
    // and memory speaks up exactly as it would on a hand-called read.
    const ann = await processWorldRead("raycast_fan", SCAN_FAN_ARGS, fan.result, callBridge)
      .catch(() => null);
    if (ann?.remembered) remembered.push(ann.remembered);
  }

  const after = await store.legalCoverage({ center, radius: COVERAGE_RADIUS, dim });
  const pct = (c) => `${(c.seen_fraction * 100).toFixed(c.seen_fraction < 0.1 ? 1 : 0)}%`;
  // THE MATERIALS TALLY (w2-56123): what the space is made of is the cave-vs-house-vs-outside
  // discriminator, and until now no survival surface said it — the fan computed a histogram
  // server-side and this shim threw it away. Distinct positions, not ray samples: overlapping
  // fans in a 360° sweep would double-count every block two fans both hit.
  const kinds = [...seen.entries()].map(([id, s]) => [id, s.size]).sort((x, y) => y[1] - x[1]);
  const shown = kinds.slice(0, VISIBLE_KINDS_CAP);
  const otherKinds = kinds.length - shown.length;
  const lines = [
    `scanned ${Math.round(Math.min(360, arc))}° in ${fans} look(s)` +
      (dirYaw !== null ? ` toward ${a.direction}` : " around you"),
  ];
  if (shown.length) {
    lines.push("your sightlines hit: "
      + shown.map(([id, n]) => `${id.replace(/^minecraft:/, "")} ×${n}`).join(", ")
      + (otherKinds > 0 ? ` (+${otherKinds} more kinds)` : ""));
  }
  // DROPPED LOOT. Usually the body's own — walk over it to pick it up. Named and counted, because
  // "an item entity" is not an answer to "what is lying there", and a body that cannot see its own
  // drops re-mines what it already broke.
  const loot = [...items.entries()].sort((x, y) => (x[1].nearest ?? 99) - (y[1].nearest ?? 99));
  if (loot.length) {
    lines.push("dropped items in sight: "
      + loot.slice(0, VISIBLE_KINDS_CAP).map(([id, r]) =>
          `${id.replace(/^minecraft:/, "")} ×${r.count} (${r.nearest?.toFixed(1)} blocks ${r.bearing})`).join(", ")
      + (loot.length > VISIBLE_KINDS_CAP ? ` (+${loot.length - VISIBLE_KINDS_CAP} more)` : "")
      + " — walk over them to pick them up");
  }
  lines.push(
    `seen coverage within r=${COVERAGE_RADIUS}: ${before.columns_seen} → ${after.columns_seen} columns (${pct(before)} → ${pct(after)})`,
    `least-explored now: ${after.least_explored.join(", ")}`,
  );
  // THE UNDERGROUND VOICE (w2-79881): coverage is a SURFACE metric — a 2-D column disc — so a
  // body sealed in a tunnel scanned 48 times, moved it 0, and was never told why. The fan already
  // measured how far each sightline ran before dying; underground, that per-sector horizon IS the
  // answer ("sealed in rock" vs "there is a cavern to the W"), so it leads the render there.
  const seesSky = status.result.sees_sky === true;
  const { state: overhead, note: overheadNote } = classifyOverhead({
    kinds, seesSky, submerged: status.result.submerged === true,
  });
  if (overheadNote) lines.unshift(overheadNote);
  // The horizons DATA is reported wherever it means anything — "how far can I see each way" is a fair
  // question outdoors too. Only under a canopy is it withheld, because there every sightline dies on
  // the nearest leaf and the numbers describe the foliage, not the place (kept from the 2026-08-10
  // canopy fix, which is live-validated).
  //
  // The cave VOICE is gated harder: it speaks only over rock. Every other state has already said what
  // the roof is made of, and a long horizon under leaves or through water is not a cavity worth
  // following (PERCEPTION_NAV_FIXES §4.1: "surface materials veto the underground framing"). Keeping
  // the two gates separate is the point — conflating them would have hidden honest data to silence a
  // dishonest sentence.
  const sectors = overhead === "canopy" ? [] : Object.entries(horizons);
  if (overhead === "solid" && sectors.length) {
    const [bestDir, bestDist] = sectors.reduce((a2, b2) => (b2[1] > a2[1] ? b2 : a2));
    if (bestDist <= 3) {
      lines.unshift("SEALED IN ROCK: every sightline dies within ~" + Math.ceil(bestDist)
        + " blocks — looking around cannot reveal more here; ore/caves are found by MINING "
        + "(bot_target destroy/move with may_modify) or by traveling to open space");
    } else if (bestDist >= 12) {
      lines.unshift(`underground, at OPEN SPACE: sightlines run ~${Math.round(bestDist)} blocks `
        + `${bestDir} — a cave or cavity worth following; other directions end at rock`);
    }
  }
  if (remembered.length) lines.push(...remembered);

  return {
    ok: true,
    result: {
      mechanism: "embodied",
      scanned_arc: Math.round(Math.min(360, arc)),
      fans,
      pitch,
      coverage_before: { columns_seen: before.columns_seen, seen_fraction: before.seen_fraction },
      coverage_after: { columns_seen: after.columns_seen, seen_fraction: after.seen_fraction },
      least_explored: after.least_explored,
      // Both facts, so the caller never has to infer "am I outside" from a block histogram.
      sees_sky: seesSky,
      overhead,
      ...(shown.length ? { visible: Object.fromEntries(shown) } : {}),
      ...(loot.length ? { items: Object.fromEntries(loot.map(([id, r]) =>
        [id, { count: r.count, nearest: r.nearest, bearing: r.bearing }])) } : {}),
      ...(otherKinds > 0 ? { visible_other_kinds: otherKinds } : {}),
      ...(sectors.length ? { horizons } : {}),
      ...(status.result.sees_sky !== undefined ? { sees_sky: status.result.sees_sky } : {}),
      ...(status.result.enclosed === true ? { enclosed: true } : {}),
      render: lines.join("\n"),
    },
  };
}

/**
 * Fold one fan's rays into the per-sector horizon map: for each ray, how far the sightline ran
 * before something stopped it — a block/entity hit at distance d, a clean miss = the fan's whole
 * range (fully open), an unread ray = open at least as far as it could read. Sector = the ray's
 * ABSOLUTE bearing (the look yaw plus the ray's own offset), so a 360° sweep fills all eight.
 */
/**
 * Foliage: a roof made of leaves and logs. Deliberately includes `_log`/`_wood` — a jungle sweep hits
 * as much trunk as leaf, and a canopy that reads as half-trunk is still a canopy.
 */
const FOLIAGE = /(_leaves$|^minecraft:vine|_log$|_wood$|bamboo|_sapling|azalea|moss)/;
/**
 * Blocks that CANNOT be underground, because each one needs sky to exist or to have formed: snow
 * falls from weather, dirt paths and farmland are made by walking and hoeing, leaf litter falls off
 * trees, crops and flowers need light. Seeing any quantity of these means the body is standing on
 * the surface whatever the heightmap says.
 *
 * <p>Deliberately EXCLUDES dirt, sand, gravel, clay and stone. Every one of them occurs in caves, so
 * admitting them would silence the cave voice exactly where it is TRUE — the expensive direction of
 * this error, since a body wrongly told it is outside stops looking for the cavern it is standing in.
 *
 * <p>Also excludes <b>short_grass, tall_grass and moss_carpet</b>, which were in this list until the
 * review card `scan-overhead-voice` was finally walked in a world (2026-09-10). They break the
 * list's own rule: LUSH CAVES grow all three. A body at 303,38,-184 in probe-0143 — sky light 0,
 * fifty-three blocks of stone and andesite between its head and the surface — scanned
 * `stone ×453, moss_block ×146, short_grass ×59, moss_carpet ×37, granite ×25, tall_grass ×22` and
 * was told "ON THE SURFACE ... the roof overhead is cover ... to get underground you must dig DOWN".
 * That is precisely the expensive direction above, so the three leave and the rule holds again.
 * The cost is real but small: a mangrove swamp loses its carpet and a plains floor its tufts, and
 * both still arrive here through `grass_block`, `leaf_litter` and the foliage arm.
 */
const SURFACE_ONLY = new RegExp("^minecraft:(" + [
  "grass_block", "podzol", "mycelium", "dirt_path", "farmland",
  "fern", "large_fern", "leaf_litter", "pale_moss_carpet",
  "snow", "snow_block", "powder_snow", "ice", "cactus", "sugar_cane", "pumpkin", "melon",
  "dandelion", "poppy", "blue_orchid", "allium", "azure_bluet", "oxeye_daisy", "cornflower",
  "lily_of_the_valley", "sunflower", "lilac", "rose_bush", "peony", "pitcher_plant", "torchflower",
  "wheat", "carrots", "potatoes", "beetroots",
].join("|") + ")$");
/** The water column itself, so a seabed is readable even if `bot_status` never reported `submerged`. */
const WATER_COLUMN = /^minecraft:(water|kelp|kelp_plant|seagrass|tall_seagrass|bubble_column)$/;

/**
 * What is over the body's head, and the one line that says so — the whole reason `bot_scan` can be
 * trusted about where it is. PURE, and exported for that reason: every input is a plain value, so the
 * cases below are checkable offline (`memory/probes/scan-overhead.test.mjs`) instead of needing a world.
 *
 * <p><b>The bug this exists to prevent</b> (PERCEPTION_NAV_FIXES.md §4.1). `sees_sky` is
 * `level.canSeeSky()`, whose MOTION_BLOCKING heightmap counts leaves AND water as blocking. So a body
 * in a forest and a body on a seabed both report `sees_sky:false`, and the render used to answer both
 * with "underground, at OPEN SPACE: … a cave or cavity worth following". Twelve-plus scans said that
 * over a forest floor or a kelp bed. The canopy arm was fixed in 2026-08-10 (w3-86528); the two arms
 * below — water, and surface ground that is not leaf-dominant — were not, and §4.1's OWN worked
 * example (`grass_block ×31, oak_leaves ×20, leaf_litter ×12, dark_oak_log ×7`) still failed the
 * foliage-fraction gate at 0.386, because counting only foliage cannot see a lawn.
 *
 * @param kinds `[id, count]` pairs — distinct positions per block id, as `visible` reports them.
 * @returns `{state, note}`; `state` is the machine field, `note` the sentence, null when none is owed.
 */
export function classifyOverhead({ kinds = [], seesSky = false, submerged = false }) {
  if (seesSky) return { state: "open_sky", note: null };
  const total = kinds.reduce((n, [, c]) => n + c, 0);
  const sum = (re) => kinds.filter(([id]) => re.test(id)).reduce((n, [, c]) => n + c, 0);

  // WATER FIRST: it is the only state that also explains why the body is losing air, and the only
  // one where "follow the cavity" can drown it. The tally is a fallback for the flag, not a
  // duplicate of it — a body can stand on the seabed with its eye in an air pocket.
  if (submerged || (total >= 12 && sum(WATER_COLUMN) / total >= 0.5)) {
    return { state: "water", note: "UNDERWATER, NOT UNDERGROUND: the sky is blocked by WATER, not "
      + "rock — long sightlines here are open water, not a cave, and following one costs air. "
      + "Surface first (bot_surface) and check your air before treating anything here as a cavity." };
  }
  // CANOPY: leaf-dominant. Wording live-validated by w3-86528 and kept verbatim.
  if (total >= 12 && sum(FOLIAGE) / total >= 0.6) {
    return { state: "canopy", note: "UNDER A CANOPY, NOT UNDERGROUND: your view of the sky is "
      + "blocked by leaves and logs, not by rock — you are standing on the surface in a forest. Do "
      + "not read this as a cave. Ore is not up here: to get underground you must dig DOWN "
      + "(bot_tunnel slope:\"down\", or destroy with may_modify), and check your Y before judging a "
      + "region empty." };
  }
  // SURFACE: no single roof dominates the tally, but blocks that only exist under sky are in it.
  // The veto §4.1 asked for, and the arm that catches its own worked example.
  const surfaceSeen = sum(SURFACE_ONLY);
  if (surfaceSeen >= 4 && surfaceSeen / total >= 0.1) {
    return { state: "surface", note: "ON THE SURFACE, NOT UNDERGROUND: your sightlines hit blocks "
      + "that only exist under open sky (grass, snow, crops or flowers), so the roof overhead is "
      + "cover — leaves, an overhang, a building — not rock. Do not read a long sightline here as "
      + "a cave; to get underground you must dig DOWN." };
  }
  return { state: "solid", note: null };
}

export function accumulateHorizons(horizons, fanResult, lookYaw) {
  const rows = Array.isArray(fanResult?.rays) ? fanResult.rays : [];
  const range = Number.isFinite(fanResult?.range) ? fanResult.range : 32;
  const NAMES = ["S", "SW", "W", "NW", "N", "NE", "E", "SE"];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 3) continue;
    const kind = row[2];
    let open;
    if (kind === "m") open = range;
    else if (kind === "b" || kind === "e") open = Number.isFinite(row[4]) ? row[4] : 0;
    else if (kind === "u") open = Number.isFinite(row[3]) ? row[3] : 0;
    else continue;
    const yaw = ((lookYaw + (Number.isFinite(row[0]) ? row[0] : 0)) % 360 + 360) % 360;
    const name = NAMES[Math.round(yaw / 45) % 8];
    const rounded = Math.round(open * 10) / 10;
    if (!(name in horizons) || horizons[name] < rounded) horizons[name] = rounded;
  }
}

/**
 * Fold one fan's block hits into the visible-materials tally: id -> Set of "x,y,z" positions.
 * Only `b` rows count — entities have their own organ (sense_entities), and misses/unread carry
 * no material. Distinct positions so overlapping fans cannot inflate the count.
 */
export function accumulateVisible(seen, fanResult) {
  const rows = Array.isArray(fanResult?.rays) ? fanResult.rays : [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 8 || row[2] !== "b") continue;
    const id = String(row[3]);
    let at = seen.get(id);
    if (!at) seen.set(id, (at = new Set()));
    at.add(`${row[5]},${row[6]},${row[7]}`);
  }
}

/**
 * Fold one fan's DROPPED ITEMS into the loot tally: item id -> {count, nearest, bearing}.
 *
 * Entity rows were dropped on the floor here, on the reasoning that entities have their own organ
 * (sense_entities). That is right for mobs and wrong for items: the drops a body is standing over
 * are usually its OWN — it mined three logs, looked around, and the look-around verb said nothing
 * about them. Live-caught by a human watching a survival run, 2026-08-06. Mobs stay out; this is
 * loot, which the scan is the natural place to notice.
 *
 * Keyed by position so overlapping fans in a 360° sweep cannot count one stack twice.
 */
export function accumulateItems(items, fanResult, originYaw) {
  const rows = Array.isArray(fanResult?.rays) ? fanResult.rays : [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 10 || row[2] !== "e") continue;
    if (String(row[3]) !== "minecraft:item") continue;
    const id = String(row[8]);
    const count = Number(row[9]) || 1;
    const key = `${row[5]},${row[6]},${row[7]}`;
    let rec = items.get(id);
    if (!rec) items.set(id, (rec = { count: 0, at: new Map() }));
    if (rec.at.has(key)) continue;
    rec.at.set(key, true);
    rec.count += count;
    const dist = Number(row[4]);
    if (!Number.isFinite(rec.nearest) || dist < rec.nearest) {
      rec.nearest = dist;
      rec.bearing = compassOf(((originYaw + (Number(row[0]) || 0)) % 360 + 360) % 360);
    }
  }
}

/** Minecraft yaw -> compass name (0 = south). Shared with the horizon sectors. */
function compassOf(yaw) {
  return ["S", "SW", "W", "NW", "N", "NE", "E", "SE"][Math.round(yaw / 45) % 8];
}

// --- local-registry triple (local/registry.mjs shape) ----------------------------------------------

export function localTools() {
  return [SCAN_TOOL];
}

export function isLocalTool(name) {
  return name === SCAN_TOOL.name;
}

export function callLocalTool(name, args, callBridge) {
  if (!isLocalTool(name)) throw new Error(`not a local tool: ${name}`);
  return botScan(args, callBridge);
}
