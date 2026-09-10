import { make as stashFixed } from "./stash-fixed.mjs";
import { make as stashSelf } from "./stash-self.mjs";
import { make as interrogation } from "./interrogation.mjs";
import { make as interrogationMulti } from "./interrogation-multi.mjs";
import { make as staleFact } from "./stale-fact.mjs";
import { make as resumeBuild } from "./resume-build.mjs";

export const SCENARIOS = {
  "stash-fixed": stashFixed,
  "stash-self": stashSelf,
  interrogation,
  "interrogation-multi": interrogationMulti,
  "stale-fact": staleFact,
  "resume-build": resumeBuild,
};

export function makeScenario(name, variant) {
  const make = SCENARIOS[name];
  if (!make) throw new Error(`unknown scenario "${name}" — one of: ${Object.keys(SCENARIOS).join(", ")}`);
  return make(variant);
}
