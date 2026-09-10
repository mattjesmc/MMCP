// Legal locate — MEMORY_REDESIGN.md §12 (cycle 4, pulled forward) / SURVIVAL_MODE_PLAN.md §6.
//
// Under MCPTK_PROFILE=survival, `locate` NEVER runs the bridge's X-ray search. It answers from the
// observation store through the provenance filter (LEGAL_OBSERVATION_TOOLS): what the body has
// actually seen through its own sightlines (deliberate or ambient) or its own traversal. The
// authoritative locate can prove absence within a radius; this one structurally never can — so its
// negative carries THE FRONTIER instead: how much of the queried disc has been seen, per compass
// sector, and where seen space ends. "Not found" becomes a search plan, not a dead end.
//
// Same honesty contract as every remembered surface (remembered.mjs): tick-stamped, labelled, no
// handles minted, negative_is_proof always false.

import { AIR, LEGAL_OBSERVATION_TOOLS } from "./observations.mjs";
import { cachedStore } from "./capture.mjs";
import { resolveWorld } from "./tools.mjs";
import { REMEMBERED_NOTE, fmtAge, fmtPos } from "./remembered.mjs";
import { getRouteTable, routesMode, routesRouting } from "./routes.mjs";
// Module cycle by design (SURVIVAL_SENSES_DESIGN.md §3.3): legal-pattern borrows this module's
// matcher/centre/frontier helpers (one definition each), this module routes `pattern` there. Both
// sides touch the other only at call time, so the cycle never bites at load.
import { legalPattern } from "./legal-pattern.mjs";

const DEFAULT_RADIUS = 64;
const MAX_RADIUS = 128;
const DEFAULT_LIMIT = 3;
const MAX_LIMIT = 8;
const MAX_AT = 64;

const ENTITY_CATEGORIES = new Set(["hostile", "living", "item", "player"]);

/**
 * lastSeen's id-matching normalization, widened to the forms an agent actually types.
 *
 * <p>The narrow version matched a single needle, so `locate what:"logs"` MISSED a store full of
 * `oak_log` — `"oak_log".includes("logs")` is false — and so did the tag form `#minecraft:logs`,
 * which no legal search can resolve because there is no registry lookup here. Both read back as
 * "not in anything you've seen", which is a false negative dressed as an honest one: the second
 * watched run could not find logs it had almost certainly recorded. So a query contributes several
 * needles (bare, un-namespaced, un-tagged, de-pluralized) and matches if ANY hits.
 *
 * <p><b>The route table comes first (ROUTE_LEDGER_DESIGN §5).</b> This function was, in effect, a
 * private one-path route table: a de-pluralizer written for exactly this bug, invisible to the
 * authoritative search, and unable to know that "tree" means a log at all. Now the shared table
 * answers when it can — one vocabulary, two consumers, per the one-definition rule — and the
 * de-pluralizer stays as the fallback for every word nobody has routed, which is what it was
 * always good at. A survival session cannot resolve a tag (no registry here), so what it takes from
 * a route is the `needles` half: the substrings this family's recorded ids contain.
 */
export function matcherFor(what, routeNeedles = null) {
  const raw = String(what ?? "").toLowerCase().trim();
  const bare = raw.replace(/^#/, "").replace(/^minecraft:/, "").replace(/^[a-z0-9_.-]+:/, "");
  const needles = new Set(routeNeedles ?? []);
  if (!routeNeedles) {
    needles.add(bare);
    // A block tag is conventionally the plural of the family (#minecraft:logs → oak_log), and agents
    // type plurals unprompted. Singularizing is what makes "logs"/"planks"/"leaves" land.
    if (bare.endsWith("ies")) needles.add(`${bare.slice(0, -3)}y`);
    if (bare.endsWith("ves")) needles.add(`${bare.slice(0, -3)}f`);
    if (bare.endsWith("s") && bare.length > 2) needles.add(bare.slice(0, -1));
  }
  // Block ids only ever separate words with underscores, so ANY needle carrying a space is a needle
  // that can never match — `"oak_log".includes("oak log")` is false. The corpus shows it plainly:
  // `oak_log` found 5/5, `oak log` 0/1, `grass_block` 1/1, `grass block` 0/1 (PERCEPTION_NAV_FIXES
  // §4.3). It is the space, not the plural. Route concepts arrive space-separated on purpose —
  // normalizeConcept collapses `[_\s]+` to a space so `oak_tree` and `oak tree` are one route key,
  // and that collapse is load-bearing for the ledger — so the repair belongs here at the needle,
  // never there at the key.
  for (const n of [...needles]) {
    if (/\s/.test(n)) needles.add(n.replace(/\s+/g, "_"));
  }
  needles.delete("");
  return {
    q: bare,
    matches: (id) => {
      const idBare = String(id).toLowerCase().replace(/^[a-z0-9_.-]+:/, "");
      for (const n of needles) {
        if (idBare.includes(n)) return true;
      }
      return false;
    },
  };
}

/**
 * The route, if this world's vocabulary has one. Never throws and never blocks the search: a route
 * layer that could break the survival profile's only way of finding anything would be a bad trade
 * for a better synonym list.
 */
export async function routeFor(what) {
  try {
    if (!routesRouting()) return null;
    const table = await getRouteTable();
    const hit = table.needlesFor(what);
    if (!hit) return null;
    if (hit.route.provenance !== "authored" && routesMode() !== "learn") return null;
    return hit;
  } catch {
    return null;
  }
}

/** Compass bearing of [dx,dz] (Minecraft: N = -Z). */
export function bearingOf(dx, dz) {
  const names = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const deg = ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360;
  return names[Math.round(deg / 45) % 8];
}

/** Where the search is centred: explicit near > the session's own body. A survival session with no
 *  body and no near has no legal vantage to search "around" — that is an argument error, stated. */
export async function resolveCenter(args, callBridge) {
  if (args?.near && Number.isFinite(args.near.x) && Number.isFinite(args.near.z)) {
    return { center: [Math.floor(args.near.x), Math.floor(args.near.z)], from: "near" };
  }
  try {
    const s = await callBridge("bot_status", {});
    if (s.ok && s.result?.spawned && s.result?.pos) {
      return { center: [Math.floor(s.result.pos.x), Math.floor(s.result.pos.z)], from: "body" };
    }
  } catch { /* fall through to the honest error */ }
  return { center: null, from: null };
}

/** The epistemic ledger every legal search answer carries, hit or miss: how much of the queried
 *  disc has actually been seen, and where the unseen remainder is. A hit without this line reads
 *  as "these are all there are", which the legal profile can never claim. */
export function frontierLines(cov, radius, { hit }) {
  const seen = cov.sectors.filter((s) => s.columns > 0);
  const pct = (cov.seen_fraction * 100).toFixed(cov.seen_fraction < 0.1 ? 1 : 0);
  const lines = [];
  lines.push(`you have seen ${cov.columns_seen} of ~${cov.columns_total} columns (${pct}%) within r=${radius}` +
    (seen.length ? ` (${seen.map((s) => `${s.bearing}:${s.columns} to ~${s.horizon}`).join(", ")})` : " — nothing seen yet"));
  lines.push((hit
    ? `more may exist in the unseen ${(100 - Number(pct)).toFixed(0)}% — `
    : "") +
    `least-explored directions: ${cov.least_explored.join(", ")}. Beyond each sector's horizon nothing ` +
    `has been seen: scan that way (bot_scan direction:"${cov.least_explored[0] ?? "N"}"), or travel ` +
    `(bot_target action:"vantage" to stand in sight of a spot), then re-ask.`);
  return lines;
}

/**
 * The survival-profile locate. Returns the bridge's {ok, result|error} envelope shape.
 * `callBridge` is only used for center resolution (bot_status) and world identity — never a search.
 */
/**
 * Arguments this door understands. Everything else is refused rather than ignored.
 *
 * This is the SURVIVAL half of the same fix made in LocateTools.rejectUnknownArgs, and it is the
 * half that actually mattered on the day: the thirteen `center` calls that went unnoticed on
 * 2026-08-02 were survival calls, and a survival `locate` never reaches the mod at all — the shim
 * routes it here (index.mjs, `legalLocal`). A guard only in Java would have looked like a fix and
 * changed nothing for the sessions that found the bug.
 *
 * `near` is accepted but never silently: it is the authoritative tool's name for the centre and
 * resolveCenter honours it, so a caller who learned it there is right here too.
 */
const LEGAL_LOCATE_ARGS = new Set([
  "what", "at", "near", "radius", "limit", "dimension", "pattern",
]);
const LEGAL_ARG_HINTS = {
  center: "near", centre: "near", origin: "near", pos: "at", position: "at",
  range: "radius", max: "limit", count: "limit", type: "what", block: "what",
};

function rejectUnknownArgs(a) {
  const unknown = Object.keys(a).filter((k) => !LEGAL_LOCATE_ARGS.has(k)).sort();
  if (!unknown.length) return null;
  const named = unknown
    .map((k) => `\`${k}\`${LEGAL_ARG_HINTS[k.toLowerCase()] ? ` (did you mean \`${LEGAL_ARG_HINTS[k.toLowerCase()]}\`?)` : ""}`)
    .join(", ");
  return {
    ok: false,
    error: `locate has no argument ${named}. It was NOT applied — the search would have run from `
      + `your body instead of where you asked, and the \`center\` in the reply would have looked `
      + `like agreement. Arguments here: what | at | pattern (one of), near, radius, limit, dimension.`,
  };
}

export async function legalLocate(args, callBridge) {
  const a = args ?? {};
  const bad = rejectUnknownArgs(a);
  if (bad) return bad;
  // The bridge's pattern is an X-ray world scan and stays out of reach; a pattern over the BELIEF
  // STORE is legal (SURVIVAL_SENSES_DESIGN.md §3) and lives in legal-pattern.mjs.
  if (a.pattern) {
    if ((typeof a.what === "string" && a.what.trim()) || (Array.isArray(a.at) && a.at.length)) {
      return { ok: false, error: "locate: give exactly ONE of `what`, `at`, or `pattern`" };
    }
    return legalPattern(a, callBridge);
  }
  const store = await cachedStore(callBridge);
  const world = await resolveWorld(callBridge);
  const now = Number.isInteger(world.tick) ? world.tick : null;
  const dim = a.dimension ?? "minecraft:overworld";

  // --- identify: what did I SEE at these positions -------------------------------------------------
  if (Array.isArray(a.at) && a.at.length) {
    if (a.at.length > MAX_AT) return { ok: false, error: `at: max ${MAX_AT} positions` };
    const legal = new Map();
    for (const c of await store.legalCells({ dim })) legal.set(c.pos.join(","), c);
    const positions = [];
    const lines = [`## remembered identify (survival profile: your memory, not a live read)`];
    let unobserved = 0;
    for (const p of a.at) {
      if (![p?.x, p?.y, p?.z].every(Number.isInteger)) return { ok: false, error: "at: entries need integer x,y,z" };
      const c = legal.get(`${p.x},${p.y},${p.z}`);
      if (!c) {
        unobserved++;
        positions.push({ pos: [p.x, p.y, p.z], observed: false });
        lines.push(`${fmtPos([p.x, p.y, p.z])}: never seen — unknown, not air`);
      } else {
        positions.push({
          pos: [...c.pos], observed: true, val: c.val, tick: c.tick, tool: c.tool,
          ...(c.superseded_illegally ? { note: "an unshared read has newer data; as of YOUR last look" } : {}),
        });
        lines.push(`${fmtPos(c.pos)}: ${c.val} — seen via ${c.tool} ${now !== null ? fmtAge(now, c.tick) : `@tick ${c.tick}`}`);
      }
    }
    if (a.at.some((p) => p.expect !== undefined || p.clear !== undefined)) {
      lines.push(`(expect/clear are live-world tests — not answerable from memory; walk there and look)`);
    }
    lines.push(`[${REMEMBERED_NOTE}]`);
    return {
      ok: true,
      result: {
        direction: "identify", remembered: true, legal_profile: true, mechanism: "memory",
        positions, unobserved,
        negative_is_proof: false,
        render: lines.join("\n"),
        note: REMEMBERED_NOTE,
      },
    };
  }

  // --- search: where have I SEEN <what> ------------------------------------------------------------
  if (typeof a.what === "string" && a.what.trim()) {
    const what = a.what.trim();
    const radius = Math.min(Number.isFinite(a.radius) ? a.radius : DEFAULT_RADIUS, MAX_RADIUS);
    const limit = Math.min(Number.isInteger(a.limit) ? a.limit : DEFAULT_LIMIT, MAX_LIMIT);
    const { center, from } = await resolveCenter(a, callBridge);
    if (!center) {
      return { ok: false, error: "legal locate searches around your body or `near` — no body is spawned and no near given" };
    }

    if (ENTITY_CATEGORIES.has(what) || what.startsWith("entity:")) {
      return {
        ok: false,
        error: `legal_profile: entities are not in block memory — sense_entities is your belief store for "${what}"`,
      };
    }

    const routed = await routeFor(what);
    const { matches } = matcherFor(what, routed?.needles ?? null);
    const cells = (await store.legalCells({ dim }))
      .filter((c) => c.val !== AIR && matches(c.id))
      .map((c) => {
        const dx = c.pos[0] - center[0];
        const dz = c.pos[2] - center[1];
        return { ...c, dist: Math.round(Math.hypot(dx, dz)), bearing: bearingOf(dx, dz) };
      })
      .filter((c) => c.dist <= radius)
      .sort((x, y) => x.dist - y.dist);

    const found = cells.slice(0, limit).map((c) => ({
      pos: [...c.pos], id: c.id, val: c.val, dist: c.dist, bearing: c.bearing,
      seen_tick: c.tick, seen_via: c.tool,
      ...(c.superseded_illegally ? { note: "as of YOUR last look" } : {}),
    }));
    const cov = await store.legalCoverage({ center, radius, dim });

    const lines = [`## remembered locate "${what}" (survival profile: your memory, not a live search)`];
    // Disclose the interpretation, exactly as the authoritative route does. A body told "no trees
    // remembered" deserves to know the search was for logs, and whether that definition was accepted
    // or guessed — the negative here is already unprovable, but a WRONG definition makes it useless
    // rather than merely partial.
    if (routed) {
      lines.push(`[route] "${what}" was read as ${routed.route.legs.map((l) => l.what).join(" ∨ ")} `
        + `(${routed.route.provenance}); matching remembered ids containing ${routed.needles.map((n) => `"${n}"`).join(", ")}.`);
    }
    if (found.length) {
      lines.push(`${cells.length} remembered match(es) — SEEN blocks only, not a world census:`);
      for (const f of found) {
        lines.push(`${f.val} @ ${fmtPos(f.pos)} — ${f.dist} blocks ${f.bearing} of ${from === "body" ? "you" : "near"}, ` +
          `seen via ${f.seen_via} ${now !== null ? fmtAge(now, f.seen_tick) : `@tick ${f.seen_tick}`}`);
      }
      if (cells.length > limit) lines.push(`(+${cells.length - limit} more remembered match(es) in range)`);
      lines.push(`These are memories — walk there and look before acting on them.`);
    } else {
      lines.push(`not in anything you've seen within r=${radius} of ${fmtPos(center)} — absent from your MEMORY, not proven absent from the world.`);
    }
    // Hit or miss, the answer quantifies its own ignorance: seen fraction + where the unseen is.
    lines.push(...frontierLines(cov, radius, { hit: found.length > 0 }));
    lines.push(`[${REMEMBERED_NOTE}]`);
    return {
      ok: true,
      result: {
        direction: "search", what, remembered: true, legal_profile: true, mechanism: "memory",
        center, center_from: from, radius,
        found,
        ...(cells.length > limit ? { found_truncated: cells.length - limit } : {}),
        ...(routed ? {
          route: {
            concept: routed.route.concept,
            asked: what,
            legs: routed.route.legs.map((l) => l.what),
            needles: routed.needles,
            provenance: routed.route.provenance,
            caveat: "a remembered search is never proof of absence; an UNAUTHORED route additionally "
              + "means the definition of the word was guessed",
          },
        } : {}),
        coverage: cov,
        negative_is_proof: false,
        render: lines.join("\n"),
        note: REMEMBERED_NOTE,
      },
    };
  }

  return { ok: false, error: "locate: give exactly one of `what` (search your memory), `at` (identify from memory), or `pattern` (find a shape in your memory)" };
}
