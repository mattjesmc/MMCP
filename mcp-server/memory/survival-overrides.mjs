// Survival-profile manifest overrides — SURVIVAL_SMALL_MODEL_PLAN.md P1.
//
// Under MCPTK_PROFILE=survival the shim REROUTES `locate` to the belief store (legal-locate.mjs)
// but used to pass the bridge's X-ray description through untouched: ~60% of its 7.4k chars
// described pattern scans, POI occupancy, biome sampling and seed-deterministic negatives that
// this profile refuses or answers completely differently. A tool whose description contradicts
// its behavior is worse than a terse one — the description is what the model reads at call time,
// closer than any charter. Same reasoning, smaller doses, for get_events (audit/drone/session
// prose a survival session never sees) and bot_body (possession/flyer prose that buries the two
// calls a survival session actually makes).
//
// These are OVERRIDES applied at tools/list time, keyed by tool name. Only the description (and
// for locate also the inputSchema, which advertised the refused `in`/`occupancy` machinery and the
// bridge's X-ray pattern — the `pattern` served here is the MEMORY one, legal-pattern.mjs) is
// replaced; everything else in the manifest entry rides through, so a bridge-side schema change is
// never silently masked except where the override deliberately owns the schema.

const pos = { type: "object", properties: { x: { type: "integer" }, y: { type: "integer" }, z: { type: "integer" } }, required: ["x", "y", "z"] };

export const SURVIVAL_OVERRIDES = {
  locate: {
    // SURVIVAL_SENSES_DESIGN.md §1: the description carries the CONTRACT (memory-not-live,
    // observed:false = unknown-not-air, a miss is never proof); the COACHING (go look where it
    // points) lives in the miss render, where frontierLines already delivers it verbatim at the
    // moment it applies. Every argument appears with an example — schema property text alone is
    // skimmed. profiles.test.mjs holds the diet: every schema property named, <600 chars.
    description:
      "Your MEMORY of blocks your body has seen — not a live read, and a miss is never proof of "
      + "absence (the reply maps how much you've seen and where to look next). Give ONE of: "
      + "`what`:\"iron_ore\" | `what`:\"#minecraft:logs\" | `what`:\"stone\" = nearest remembered "
      + "sightings with bearings; `at`:[{x,y,z},…] = what you saw at those positions "
      + "(observed:false = never seen — unknown, NOT air); `pattern` = find a SHAPE in your memory "
      + "(unknowns listed to verify). Options: `near`:{x,z} recenter (default: your body), "
      + "`radius` ≤128, `limit` ≤8, `dimension`. Entities are never in block memory — "
      + "sense_entities.",
    inputSchema: {
      type: "object",
      properties: {
        what: { type: "string", description: "Block id, #tag, or plain word to search your memory for. Give ONE of what | at | pattern." },
        at: { type: "array", items: pos, description: "Positions to identify from memory (max 64). observed:false = never seen (unknown, not air)." },
        pattern: {
          type: "object",
          description: "A shape to find in remembered blocks: {nodes:[{id,block}], relations:[{rel:adjacent|above|below|offset|within, of:[a,b], dx/dy/dz, r}]}. Candidates rank most-seen first; never-seen cells count as unknown and are listed to verify; a remembered cell that contradicts the shape kills the candidate.",
        },
        near: { type: "object", properties: { x: { type: "integer" }, z: { type: "integer" } }, required: ["x", "z"], description: "Recenter the search (default: your body)." },
        radius: { type: "integer", description: "Search radius in blocks (default 64, max 128)." },
        limit: { type: "integer", description: "Max results (default 3, max 8)." },
        dimension: { type: "string", description: "Dimension id, default minecraft:overworld." },
      },
      required: [],
    },
  },

  get_events: {
    description:
      "Poll your event log — YOUR NERVOUS SYSTEM. Without `cursor`: the newest events plus a "
      + "`cursor` to poll from next. With `cursor`: only newer events, plus `missed` (events that "
      + "fell out of the log before you polled; `missed_urgent` = how many were danger), `more` "
      + "(true = poll again immediately) and `urgent` (danger still queued BEHIND this page — act "
      + "on those FIRST). Event kinds: body_endangered/body_safe {cause: "
      + "air_low|in_lava|on_fire|falling|suffocating|starving} — YOUR PAIN, act immediately "
      + "(air_low carries seconds_left); body_damaged/body_died {cause} — what actually hurt you; "
      + "body_removed — your body is gone; reaction_fired/reaction_done — a reflex took your body "
      + "(read these when you are somewhere unexpected instead of guessing); "
      + "action_completed/action_failed/action_superseded — your commanded acts, by action_id; "
      + "inventory_full — mined drops fell ON THE GROUND and will despawn; "
      + "entity_entered_radius/entity_left_radius and nearest_threat_changed — what is closing on "
      + "you; block_sighted {watch_id, block, pos, distance} — a bot_watch match came into view "
      + "(you will NOT be told twice about the same block); weather_changed/time_of_day; chat — "
      + "the player talking to you (reply briefly via send_chat). Take the default (ALL types): a "
      + "`type` filter that excludes body events is a body that cannot feel. `wait_ms` (max 60000) "
      + "long-polls at no extra cost — use wait_ms 20000 between actions as your listen loop.",
  },

  bot_body: {
    description:
      "Your body. `action`:\"spawn\" with `type`:\"player\" creates YOUR REAL PLAYER body: in the "
      + "tab list, hunted by hostiles like any player, real hunger (eat or you starve), and a real "
      + "36-slot inventory that AUTO-COLLECTS items you walk over. It has the full verb surface "
      + "(bot_goto/bot_target, bot_mine/bot_place/bot_use, bot_craft, bot_attack/bot_shoot, "
      + "bot_eat/bot_drink, bot_equip/bot_select, reflexes and engage) and digs at the engine's "
      + "own speed — HOLD THE RIGHT TOOL. Spawns beside the watching player unless `pos` {x,y,z} "
      + "(+ `dimension`) is given. Spawning again REPLACES your body and its carried items drop "
      + "where the old one stood. `action`:\"engage\" arms AUTOMATED COMBAT (`on` true/false): "
      + "`mode` \"defend\" (default — fights off attackers without abandoning what you were doing) "
      + "or \"fight\" (commits until the designated target is down; `policy` "
      + "kite|strafe|close|hold, `range` blocks). WHO it fights comes from the threat table — "
      + "bot_target {action:\"attack\"} designates; defend mode answers attackers on its own. "
      + "`action`:\"despawn\" removes your body (items drop).",
  },
};
