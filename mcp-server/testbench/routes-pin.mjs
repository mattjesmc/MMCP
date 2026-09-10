// The bench's route-layer pin, in one place (ROUTE_LEDGER_DESIGN.md §8).
//
// Two jobs, and they have to be done by the same module or they drift apart:
//
//  1. PIN the mode for every process this run spawns. Production defaults MCPTK_ROUTES to `learn`;
//     a bench that inherited that would answer concepts prior runs could not, and would keep
//     learning between runs — a non-stationary instrument. `record` is the pin: no route ever
//     fires, so the SUT is byte-identical to every historical row, while the ledger still fills.
//  2. FINGERPRINT what was pinned, into the manifest as `routes_hash`. This is the part that is
//     easy to get subtly wrong: the fingerprint must be computed in a process whose MCPTK_ROUTES
//     already holds the pinned value, or the manifest records `learn` for a run that executed
//     `record`. Setting the env in this module's body and exposing the hash from the same module
//     makes that ordering structural — a runner's static import of this file is evaluated before
//     the runner's own body, so there is no way to read the hash before the pin is applied.
//
// Why a separate axis at all: `tools_hash` fingerprints the manifest, and the route layer never
// touches the manifest. Two runs with different vocabularies hash identically on tools and pool
// silently — the same class of failure as `e_repair_bridge_gap` (resume.mjs), through a door that
// fingerprint cannot watch. `routes_hash` joins RESUME_GUARDED for exactly that reason.

export const ROUTES_PIN = process.env.MCPTK_ROUTES ?? "record";
process.env.MCPTK_ROUTES = ROUTES_PIN;

const { routesFingerprintSync } = await import("../memory/routes.mjs");

/** `<mode>:<active route count>:<sha12 of the active table>` — e.g. `record:12:9040784d68d9`. */
export function routesHashForRun() {
  return routesFingerprintSync();
}
