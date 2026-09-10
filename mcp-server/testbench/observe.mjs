// The scripted walk: visit each of the arena's vantage points and record the natural
// perception-ladder reads (scene_summary + get_surface summary) VERBATIM. This transcript is exactly
// what a copilot session would have seen walking the arena — the quiz measures what a model can
// rebuild from it.
//
// EYE HEIGHT (fixed here): stop coordinates are RELATIVE to the arena origin, so `y: 1` means one
// block above the floor — standing on it. The previous hardcoded walk carried `y: 101`, which was an
// ABSOLUTE y from back when the platform floor sat at y=100. When the arena moved to y=150 (to clear
// the dark-forest canopy) those entries were still passed through `abs()`, which ADDS the origin's
// y — so every observation was taken from y=251, a hundred blocks above the arena. Category A's
// premise is a ground-level walk whose stops each reveal one feature ("the quiz measures whether a
// model can integrate them into one map"); a flyover shows the whole arena at once and makes the
// integration the questions are meant to test substantially easier. Relative stops keep the eye on
// the floor where the design intended.

import { call } from "./bridge.mjs";

export async function observeWalk(arena, { log = console.log } = {}) {
  const o = arena.origin;
  const observations = [];
  for (const wp of arena.walk) {
    const origin = { x: o.x + wp.x, y: o.y + (wp.y ?? 1), z: o.z + wp.z };
    const scene = await call("scene_summary", { origin });
    const blocks = await call("get_surface", { origin, grid: 16 });
    observations.push({ label: wp.label, origin, scene, blocks });
    log(`  observed: ${wp.label}`);
  }
  return observations;
}

/** Render the walk as the quiz context — verbatim envelopes, labeled, in visit order. */
export function renderObservations(observations) {
  const parts = [
    "You walked through an area in Minecraft. Below is the complete, ordered log of what you",
    "observed at each stop — verbatim tool output from the game (coordinates are absolute;",
    "x grows east, z grows south, y is up).",
    "",
  ];
  observations.forEach((o, i) => {
    parts.push(`## Stop ${i + 1}: ${o.label} (standing at ${o.origin.x}, ${o.origin.y}, ${o.origin.z})`);
    parts.push(`scene_summary: ${JSON.stringify(o.scene)}`);
    parts.push(`get_surface (grid 16, summary): ${JSON.stringify(o.blocks)}`);
    parts.push("");
  });
  return parts.join("\n");
}
