// Ambient autofan — the legal profile's retina (MEMORY_REDESIGN.md §12.4, SURVIVAL_MODE_PLAN.md §5).
//
// While the session is actively embodied, a forward-cone raycast_fan fires from the body's eye on a
// timer and its result is CAPTURED to the observation store on the `ambient` channel — never served
// into the model's context. §2.3's definition verbatim: a sensor writing without anyone reading the
// result. A human player passively sees everything they walk past; this is that, at fan resolution.
//
// Guardrails:
//  - Off by default. MCPTK_OBS_AMBIENT=on enables; the survival runbook sets it.
//  - Fires only within an ACTIVITY WINDOW after the session's last successful tool call — an
//    ABANDONED session must not poll the bridge forever. Any call refreshes it, and that breadth is
//    load-bearing: the window originally tracked `bot_*` calls only, so a session that PERCEIVED
//    rather than moved (raycast, locate, mem_*) had a retina that ran for 30s after its spawn and
//    then went silent forever. Live-caught on the second watched run — "the fan is not being done
//    continuously and nothing is built up", and the agent fell back to hand-rolled raycasts, which
//    do not refresh the window either, so the silence was self-reinforcing.
//  - Forward cone only (120°×60°), facing wherever the body faces: a 360° sweep is a slow X-ray
//    and will collide with the profile's future rotation caps.
//  - load:false — a player's eyes do not load chunks; rays stop honestly at unloaded terrain (`u`),
//    which the capture extractor already refuses to index as fact.
//  - One fan in flight at a time; a missing body logs once per outage, not per tick.

import { captureWorldRead } from "./capture.mjs";

export const AMBIENT_ENV = "MCPTK_OBS_AMBIENT";
const INTERVAL_MS = parseInt(process.env.MCPTK_OBS_AMBIENT_MS ?? "2000", 10);
/** How long after a session's last tool call the retina keeps looking. Exported for tests. */
export const ACTIVITY_WINDOW_MS = 30_000;

/** The fan the retina casts: the body's eye, its own facing, a forward cone, no chunk loading. */
export const AMBIENT_FAN_ARGS = Object.freeze({
  drone: true, h_fov: 120, v_fov: 60, steps_h: 9, steps_v: 5, range: 96, load: false,
});

/**
 * The fan a DELIBERATE look casts (bot_scan). Same eye, same cone — only denser.
 *
 * The two budgets are split because they are paid for differently, which the single shared constant
 * hid (PERCEPTION_NAV_FIXES §1.4). Ambient fires every 2 s forever and must stay invisible against
 * the tick, so it keeps its 45 rays. A scan is one deliberate act that already spends ~1.2 s turning
 * the body's head, so a few ms of ray marching is noise — and the density is the whole point: at
 * 9×5 the rays are 8.4 blocks apart at range 32, wide enough that a whole spruce fits between two of
 * them (eleven sessions, zero logs seen in a taiga). At 32×32 they are ~2.2 blocks apart, so a tree
 * cannot fall through the grid.
 *
 * h_fov/v_fov MUST match the ambient cone: scan.mjs tiles its sweep with FAN_H_FOV, and captures
 * from both channels share one store, so a scan that saw a different shape of cone would make the
 * coverage arithmetic lie.
 *
 * **STEP COUNTS MUST BE ODD.** A fan spreads its rays evenly across the cone, so an EVEN count puts
 * no ray on the centre line — the one bearing a walking body cares about most. Measured: one 3-wide
 * trunk due north, 32x32 found it at 12/24/36/48/60 blocks and MISSED it at 72/84/96, while 31x31
 * found all eight. At 32 steps the nearest rays sit ±1.94° off centre, which is ±2.4 blocks at 72 —
 * wider than the trunk. The sparse 9x5 retina outperformed the 1024-ray scan on exactly this,
 * because 9 is odd.
 *
 * **RANGE.** Both channels reach 96 blocks. 32 was the toolkit default and it is why a human
 * watching says "it walked straight past a tree I could see": at r=32 the same experiment found 2 of
 * 8 trees, at r=64 five, at r=96 all eight. The cost is nothing — 961 rays at r=96 measured ~3ms,
 * the 45-ray retina 0.25ms — because reach costs cells per ray, and cells per ray are the cheap axis.
 */
export const SCAN_FAN_ARGS = Object.freeze({
  drone: true, h_fov: 120, v_fov: 60, steps_h: 31, steps_v: 31, range: 96, load: false,
});

export function ambientEnabled() {
  return (process.env[AMBIENT_ENV] ?? "off").trim() === "on";
}

/**
 * One retina tick, exported for tests: fire the fan and capture it ambient. Returns what happened.
 * Never throws. `state` carries {lastActiveAt, busy, loggedNoBody} between ticks.
 */
export async function ambientTick(state, callBridge, now = Date.now()) {
  if (state.busy) return { fired: false, reason: "busy" };
  if (now - state.lastActiveAt > ACTIVITY_WINDOW_MS) return { fired: false, reason: "idle" };
  state.busy = true;
  try {
    const fan = await callBridge("raycast_fan", { ...AMBIENT_FAN_ARGS });
    if (!fan.ok) {
      if (!state.loggedNoBody) {
        state.loggedNoBody = true;
        process.stderr.write(`[ambient] autofan paused: ${fan.error}\n`);
      }
      return { fired: false, reason: fan.error };
    }
    state.loggedNoBody = false;
    const capture = await captureWorldRead("raycast_fan", AMBIENT_FAN_ARGS, fan.result, callBridge, { channel: "ambient" });
    return { fired: true, capture };
  } catch (e) {
    return { fired: false, reason: e.message };
  } finally {
    state.busy = false;
  }
}

/**
 * Wire the retina into a shim: marks session activity and, when enabled, starts the unref'd timer.
 * Returns {noteActivity} for the tool-call path to ping on EVERY successful call — see the header:
 * narrowing this to the embodied verbs is what blinded the retina on the second watched run.
 */
export function startAmbient(callBridge) {
  const state = { lastActiveAt: 0, busy: false, loggedNoBody: false };
  if (ambientEnabled()) {
    setInterval(() => { ambientTick(state, callBridge); }, INTERVAL_MS).unref();
    process.stderr.write(`[ambient] autofan armed: forward cone every ${INTERVAL_MS}ms while active\n`);
  }
  return {
    noteActivity() { state.lastActiveAt = Date.now(); },
    state, // exposed for tests
  };
}
