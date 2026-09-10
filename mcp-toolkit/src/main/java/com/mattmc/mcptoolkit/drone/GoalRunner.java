package com.mattmc.mcptoolkit.drone;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.EventLog;
import com.mattmc.mcptoolkit.ReachSolver;
import com.mattmc.mcptoolkit.nav.BuildWalkNodeEvaluator;
import com.mattmc.mcptoolkit.nav.MobPhysique;
import com.mattmc.mcptoolkit.nav.NavPhysique;
import com.mattmc.mcptoolkit.nav.NavProfile;
import com.mattmc.mcptoolkit.nav.NavSolver;
import net.minecraft.world.level.block.DoorBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Mob;
import org.jspecify.annotations.Nullable;

import java.util.concurrent.CompletableFuture;

/**
 * The goal loop behind {@code bot_target} (BOT_SURFACE_DESIGN.md §3.2) — <b>segment-and-repair</b>.
 *
 * <p>The problem it exists to solve is measured, not aesthetic. {@link QueueRunner} is
 * abort-on-first-failure with no retry, so every {@code stopped_short}, {@code out_of_reach}, or
 * blocked line of sight kills the queue and costs a full agent turn to diagnose and re-issue — and a
 * turn is worth the whole re-read prefix (~18.7k tokens against the live manifest). The happy path was
 * already one call; <b>all</b> the remaining savings live on the failure path. So this loop repairs
 * what it can, server-side, and surfaces only what it genuinely cannot fix.
 *
 * <pre>
 * navigate toward the goal
 *   arrived?      -> perform the act (mine / place / nothing for a move) -> done
 *   stopped short -> ask NavSolver WHICH block stopped us
 *                    one local repair (break it / bridge the gap / open the door) -> navigate again
 *   no repair applies, or the budget is spent -> stop, report the locus AND the ledger
 * </pre>
 *
 * <p>Greedy, and it will dead-end where a global search would not. It also reuses the real tool bodies
 * for every act it performs ({@link DroneTools#startNav}, {@link DroneHands#startMine},
 * {@code botPlace}, {@code botUse}), so events, audit, and honest verdicts are identical to
 * hand-issued actions — a repair that cannot really be done fails for the real reason, in the real
 * words, rather than being retried forever.
 *
 * <p><b>The optimism is reconciled here.</b> {@link BuildWalkNodeEvaluator} plans on the assumption
 * that materials last and breaks succeed; this loop finds out for real and writes what actually
 * happened into the {@link Ledger}, which is what makes a partial failure resumable without a
 * re-survey turn.
 */
final class GoalRunner {

    /** Repairs one goal may attempt before it concedes — bounds a body that is merely confused. */
    private static final int MAX_REPAIRS = 24;
    /** {@code bot_tunnel} corridor length: default and hard cap (blocks of advance). */
    private static final int TUNNEL_LENGTH_DEFAULT = 16;
    private static final int TUNNEL_LENGTH_MAX = 128;
    /** Spare breaks over the corridor's own volume — gravel falls in, a ceiling needs one more. */
    private static final int TUNNEL_BREAK_SLACK = 16;
    /** Cells cleared before each walk leg. >1 on purpose: see the nav call in tickTunnel. */
    private static final int TUNNEL_WALK_AHEAD = 3;
    /** Arrival radius for a plain `move` goal. */
    static final double MOVE_WITHIN = 2.5;
    // ---- attack goal (w2-79881: `attack` used to designate-and-orphan — no approach, no swing,
    // ---- and a wait:true future nothing could ever complete; the 360s tool timeout was the only
    // ---- way out while the body stood still being shot) ----
    /** Arrival radius for an attack approach leg: inside swing reach with margin to spare — the
     * PLAYER body's honest reach is now the vanilla 3.0 (F1), so the approach must land closer
     * than the old 3.0 or every hunt ends circling the reach boundary. */
    private static final double ATTACK_APPROACH_WITHIN = 2.0;
    /** Re-path when the target has drifted this far from where the current leg was solved for. */
    private static final double ATTACK_REPATH_DISTANCE = 2.0;
    /** Ticks between swings (~0.6s — a full-strength sword rhythm; vanilla scales weak spam down). */
    private static final int ATTACK_SWING_TICKS = 12;
    /**
     * Ticks between shots — {@code BowItem.MAX_DRAW_DURATION}, the time a full draw costs. The
     * rhythm is set to the real one NOW, before the draw itself is real (COMBAT_KIT_PLAN.md step
     * 3), so that making it real changes the mechanism and not the cadence: an archer that looses
     * faster than a bow can be drawn is the ranged twin of the pickaxe-swinging melee body.
     */
    private static final int ATTACK_SHOT_TICKS =
        net.minecraft.world.item.BowItem.MAX_DRAW_DURATION;
    /** Default and cap for how long one attack goal may hunt before conceding (60s / 5min). */
    private static final int ATTACK_TIMEOUT_DEFAULT = 1200;
    private static final int ATTACK_TIMEOUT_MAX = 6000;
    /** How far from the target a vantage stand may be sampled (SURVIVAL_MODE_PLAN.md §7). */
    private static final int VANTAGE_RANGE = 24;

    // ---- pillar-up maneuver phases (Goal.pillarPhase) ----
    private static final int PILLAR_RISING = 1;   // airborne, waiting to clear the cell then place
    private static final int PILLAR_LANDING = 2;  // block placed, waiting for touchdown one block up
    /** Straight-up launch velocity — vanilla jump (~1.25-block apex, head stays within the y+2 cell
     * the search cleared). Horizontal is zeroed so the body comes back down on its own column. */
    private static final double PILLAR_JUMP_VY = 0.42;
    /** Place once the feet have risen this far above the block cell's top, so it is never dropped into
     * the body (which would suffocate/eject it); the apex clears it with margin. */
    private static final double PILLAR_PLACE_CLEARANCE = 0.02;
    /** A pillar that neither placed nor landed within this many ticks is abandoned honestly. */
    private static final int PILLAR_TIMEOUT = 40;

    private static long actionSeq = 0;

    /** One running goal. */
    static final class Goal {
        final String actionId;
        final String action;              // move | destroy | place | attack
        final JsonObject selector;        // kept so the loop can RE-RESOLVE after a failure
        final NavProfile profile;
        final Ledger ledger = new Ledger();
        final @Nullable String item;      // block to place / bridge with, or tool to mine with
        boolean acceptNoDrops;            // destroy: break a drop-gated block with a wrong tool anyway
        final @Nullable CompletableFuture<JsonElement> waiter;
        Targets.Resolved target;
        @Nullable String waiting;         // in-flight sub-action id (nav or dig)
        int breaksLeft;
        int placesLeft;
        int repairs;
        /**
         * How many of this goal's legs were preempted by the DROWN reflex. A goal whose route crosses
         * water (swim:true, legitimately) drives the body in, the reflex surfaces it, the goal drives
         * it straight back in — and with the reflex on a zero cooldown that oscillates until the body
         * dies, reporting a successful rescue every time. Counted so the goal can concede instead
         * (PERCEPTION_NAV_FIXES §2.2).
         */
        int drownPreemptions;
        /** A navigation reported arrival: the next tick re-checks touch (F2 — sightline is never
         *  assumed from a path) and then acts; a range-only miss re-navigates, it does not repair. */
        boolean readyToAct;
        /** `move` only: arrive within HAND REACH (solved against real geometry) rather than within
         *  MOVE_WITHIN blocks. The right test whenever a dig follows the move. */
        boolean reachArrival;
        /** Set for a {@code bot_tunnel} goal — its own state machine owns the tick (see tickTunnel). */
        @Nullable Tunnel tunnel;
        /** True once this goal issued any navigation — so a `move` that never had to move is honest. */
        boolean navigated;
        /** Set while a dig is a REPAIR (so its completion feeds the ledger as a repair, not the act). */
        @Nullable BlockPos repairingAt;
        /**
         * Set while a navigation is an APPROACH TO PLANNED WORK (walking into reach of a cell to
         * mine/open), not travel toward the goal. Without it, the approach's arrival reads as goal
         * arrival — live-caught: a move goal declared "achieved" the moment the body could merely SEE
         * the wall it was supposed to mine through.
         */
        @Nullable BlockPos workNav;
        /**
         * A possessed-body ballistic leap in flight, awaiting its landing verdict. The ledger's
         * contract is "a real completed act, never a prediction" — so `jumped` is written only when
         * the body actually comes down at the landing (the walker's driver verifies its own leaps
         * the same way).
         */
        @Nullable BlockPos leapVerify;
        int leapVerifyTicks;
        /**
         * A pillar-up maneuver in flight: {@code pillarAt} is the cell the block drops into (and the
         * body climbs onto), {@code pillarPhase} tracks rising→place→landing, {@code pillarTicks}
         * bounds it. Like a leap it owns the body across the arc, so nothing re-navigates until the
         * body is verifiably one block higher (BOT_SURFACE_DESIGN.md §12.2).
         */
        @Nullable BlockPos pillarAt;
        int pillarPhase;
        int pillarTicks;
        /**
         * A vantage goal's candidate stand cells (LOS into the target, nearest-the-body first) and
         * the one currently being tried. Computed lazily on first navigate; arrival is never the
         * verdict — LOS is re-verified from the body's real eye.
         */
        java.util.@Nullable List<BlockPos> vantageCandidates;
        int vantageIdx;
        /**
         * Stagnation guard (the 2026-08-02 live wedge): the body's cell at the last repair decision,
         * and how many consecutive repairs have run from that same cell without any work being
         * performed. Navigation-only repair rounds that leave the body where it stood are the wedge
         * signature — the live goal burned 25 of them, a 101-tick node timeout each, before the
         * repair budget conceded. Real work (a mine, a place, a door, a launch) resets the count, so
         * legitimate mine-ahead sequences from one stand never trip it.
         */
        @Nullable BlockPos lastRepairCell;
        int fruitlessRepairs;
        /**
         * Repair rounds that CHANGED THE WORLD (a mine, a place, a pillar, a leap). Exempt from
         * {@link #MAX_REPAIRS}, because that budget bounds a body that is merely confused — and a
         * round that just dug a block is not confused, it is working.
         *
         * <p>This matters the moment a goal is allowed to dig to a buried target: a 30-block descent
         * is ~30 productive rounds, so a flat 24-round ceiling would concede two thirds of the way
         * down with the shaft half-finished and the ledger reporting `repair_budget_spent` — a
         * failure invented by the bound rather than found in the world. Deliberate work is bounded by
         * the thing the CALLER set for it: `budget` {break, place}, which fails as break/
         * place_budget_spent. Confusion is bounded by MAX_REPAIRS and by the 3-strike stagnation
         * check above; between them, neither bound has to do the other's job.
         */
        int productiveRepairs;
        /** Attack-goal state: total ticks hunted, the concede ceiling, swing spacing, hits landed,
         *  and where the target was when the current approach leg was solved (re-path trigger). */
        int attackTicks;
        int attackTimeout = ATTACK_TIMEOUT_DEFAULT;
        int swingCooldown;
        int hits;
        /**
         * This hunt has given up on the LEGS and is shooting instead (COMBAT_KIT_PLAN.md §4.3).
         * Sticky on purpose: set once the approach has provably failed, it stops the loop from
         * flapping between a path it cannot walk and a bow it can. Cleared only if the ranged
         * capability itself is lost mid-fight (the last arrow spent), which puts the goal back on
         * its feet for exactly one tick before it concedes honestly.
         */
        boolean rangedFight;
        /** Shots fired by a {@link #rangedFight} hunt, reported beside {@code hits}. */
        int shots;
        /** The kit's clause for why this hunt ended the way it did — the missing capability, not
         *  the symptom. `target_unreachable` alone sent the 2026-08-11 agent looking for a path
         *  bug seven times when what it needed was a bow. */
        @Nullable String why;
        net.minecraft.world.phys.@Nullable Vec3 lastAttackNavPos;
        /** Approach legs that ended WEDGED (stalled / nav_timeout — the follower's node timeout).
         *  Reported in the attack verdict: pressing into a ledge for 5s per leg is invisible in
         *  `hits`/`repairs`, and w1_42257's beeline hypotheses (H1/H2) need this instrument. */
        int stalledLegs;

        Goal(final String actionId, final String action, final JsonObject selector,
             final NavProfile profile, final Targets.Resolved target, final @Nullable String item,
             final @Nullable CompletableFuture<JsonElement> waiter) {
            this.actionId = actionId;
            this.action = action;
            this.selector = selector;
            this.profile = profile;
            this.target = target;
            this.item = item;
            this.waiter = waiter;
            this.breaksLeft = profile.breakBudget();
            this.placesLeft = profile.placeBudget();
        }
    }

    private GoalRunner() {}

    // ---- start ---------------------------------------------------------------

    static JsonObject start(final JsonObject a, final DroneTools.Slot slot,
                            final @Nullable CompletableFuture<JsonElement> waiter) {
        LivingEntity body = DroneTools.requireBody(slot);
        ServerLevel level = (ServerLevel) body.level();

        String action = a.has("action") && !a.get("action").isJsonNull()
            ? a.get("action").getAsString() : null;
        if (action == null) {
            throw new IllegalArgumentException("missing `action` (move|destroy|place|attack|vantage)");
        }
        switch (action) {
            case "move", "destroy", "place", "attack", "vantage" -> { }
            // The tool this names EXISTS as of 0.92.0 (RELEASE_1.md §D3). It did not when this message
            // was written, which is the point worth keeping: a refusal that points at a phantom tool
            // costs the reader the call it saved them.
            case "build" -> throw new IllegalArgumentException("`build` is not implemented yet — it "
                + "needs the schematic staging layer (BOT_SURFACE_DESIGN.md §3.2); use place, or "
                + "place_structure/set_blocks for a world-edit build");
            default -> throw new IllegalArgumentException("unknown `action` '" + action
                + "' (move|destroy|place|attack|vantage)");
        }

        JsonObject selector = a.has("target") && a.get("target").isJsonObject()
            ? a.getAsJsonObject("target") : null;
        if (selector == null) {
            throw new IllegalArgumentException("missing `target` selector");
        }
        Targets.Resolved target = Targets.resolve(level, body, selector);
        JsonObject r = new JsonObject();
        // A kind-selector attack is a STANDING RULE ("zombies, generally") — armable with nothing
        // in range: "arm the defenses before the night raid" must not fail no_target precisely
        // when it is most wanted. Everything else needs a live referent.
        boolean standingAttack = "attack".equals(action)
            && selector.has("kind") && !selector.get("kind").isJsonNull();
        if (target == null && !standingAttack) {
            r.addProperty("started", false);
            r.addProperty("reason", "no_target");
            r.addProperty("note", "the selector is well-formed but matched nothing right now");
            return r;
        }
        if ("destroy".equals(action) && target.isEntity()) {
            throw new IllegalArgumentException("`destroy` needs a BLOCK target (at/handle), not an entity");
        }
        if ("vantage".equals(action) && target.isEntity()) {
            throw new IllegalArgumentException("`vantage` needs a BLOCK/region target (at/handle) — "
                + "to keep sight of an entity, use bot_follow");
        }
        if ("attack".equals(action)) {
            if (target != null && !target.isEntity()) {
                throw new IllegalArgumentException(
                    "`attack` needs an ENTITY target (entity/uuid/player/kind)");
            }
            if (standingAttack) {
                // A standing rule is an ARM, not an act — it completes now, by definition. The
                // waiter must be completed HERE: nothing downstream ever holds it, and an
                // uncompleted waiter is exactly the w2-79881 wedge (a wait:true attack parked for
                // the full 360s tool timeout while the body was shot).
                JsonObject res = designate(slot, a, selector, target);
                if (waiter != null) {
                    waiter.complete(res.deepCopy());
                }
                return res;
            }
            // An INDIVIDUAL target is a real goal: approach, swing on rhythm, finish when the
            // target is down (or honestly concede: target_lost / target_unreachable / gave_up).
            // Designation still happens as a side effect so Engage and the threat table know who
            // the enemy is — but designation is no longer the whole behavior.
            slot.threats.designate(target.entity());
            if (a.has("engage") && !a.get("engage").isJsonNull() && a.get("engage").getAsBoolean()) {
                slot.engaged = true;
            }
            // HUNTS DEFAULT DRY (w1_42257 R8). Deliberate deviation from the surface-wide swim-on
            // default (NavProfile:186): for travel, refusing water is the surprising case; for a
            // FIGHT it is the correct one — the chicken chase waded a pond mid-hunt and tripped
            // the drown net inside its own goal. A target across water now ends
            // target_unreachable naming the fluid, and the agent re-issues with swim:true as an
            // informed choice.
            NavProfile attackProfile = NavProfile.fromJson(a, true);
            if (!a.has("swim") || a.get("swim").isJsonNull()) {
                attackProfile = attackProfile.withoutSwim();
            }
            DroneTools.claimBase(slot, DroneTools.BaseKind.GOAL, "superseded");
            DroneTools.failPending(slot, "superseded");
            Goal attackGoal = new Goal("g-" + (++actionSeq), action, selector, attackProfile,
                target, null, waiter);
            if (a.has("attack_timeout_ticks") && !a.get("attack_timeout_ticks").isJsonNull()) {
                attackGoal.attackTimeout = Math.max(20,
                    Math.min(ATTACK_TIMEOUT_MAX, a.get("attack_timeout_ticks").getAsInt()));
            }
            slot.goal = attackGoal;
            com.mattmc.mcptoolkit.wm.Wm.goalStarted(slot.target(), slot.activeBody(),
                attackGoal.actionId, attackGoal.action, selector, attackGoal.profile.describe());
            r.addProperty("started", true);
            r.addProperty("action_id", attackGoal.actionId);
            r.addProperty("action", "attack");
            r.addProperty("target", target.describe());
            r.add("profile", attackGoal.profile.describe());
            r.addProperty("engaged", slot.engaged);
            r.addProperty("note", "hunting: the goal walks into swing reach and attacks on rhythm "
                + "until the target is down — it completes with outcome achieved (dead), "
                + "target_lost, target_unreachable, or gave_up (attack_timeout_ticks, default "
                + ATTACK_TIMEOUT_DEFAULT + ")"
                + (attackProfile.canSwim() ? "" : ". Hunts default DRY (swim:false): a target "
                    + "across water ends target_unreachable naming the fluid — re-issue with "
                    + "swim:true to wade in deliberately"));
            return r;
        }

        // Validate BEFORE tearing anything down (bot_goto's discipline): a malformed profile or a
        // hands-less body must not cost the caller a running queue/follow/goal.
        NavProfile profile = NavProfile.fromJson(a, true);
        boolean needsHands = "destroy".equals(action) || "place".equals(action)
            || profile.modifiesWorld();
        if (needsHands && Hands.of(body) == null) {
            r.addProperty("started", false);
            r.addProperty("reason", "no_hands");
            r.addProperty("note", "this body has no hands (a possessed mob can move/look/attack only)"
                + " — `destroy`/`place` and `may_modify` need a body with hands: bot_release, or"
                + " bot_body spawn");
            return r;
        }

        // BUDGET PRE-FLIGHT (w2-79881): when the route needs modification, solve once NOW and refuse
        // a plan the budgets cannot carry — with the real numbers — instead of dying mid-route with
        // the shaft half-built. An 80-block ascent needs ~80 places against a default budget of 16,
        // and nothing used to say so until the work was already spent. Runs before any teardown
        // (validate-before-teardown discipline); a partial/failed solve is NOT a refusal — the
        // repair loop re-solves incrementally en route and may still get there.
        if (profile.modifiesWorld() && !"vantage".equals(action)) {
            float preBudget = Math.min(256.0F,
                (float) body.position().distanceTo(target.where()) * 4.0F + 32.0F);
            NavSolver.Result preSolve = NavSolver.solve(level, physique(body, profile),
                java.util.Set.of(target.blockPos()), preBudget, profile);
            // A PARTIAL solve refuses too: deep modify-heavy routes routinely exhaust the search
            // budget before reaching (live-caught on a 21-level mine-up — reached() was false, the
            // pre-flight waved it through, and the goal died mid-route at place_budget_spent, the
            // exact old failure). The partial plan's work count is evidence enough: if the best
            // path the search found already exceeds the budgets, the caller's next move is the
            // same either way — raise them or split the trip.
            String over = preSolve.overBudget();
            if (over != null) {
                int breaks = preSolve.evaluator().planned(BuildWalkNodeEvaluator.Action.BREAK);
                int places = preSolve.evaluator().planned(BuildWalkNodeEvaluator.Action.PLACE)
                    + preSolve.evaluator().planned(BuildWalkNodeEvaluator.Action.PILLAR);
                r.addProperty("started", false);
                r.addProperty("reason", "over_budget");
                r.addProperty("over", over);
                JsonObject needs = new JsonObject();
                needs.addProperty("breaks", breaks);
                needs.addProperty("places", places);
                r.add("route_needs", needs);
                JsonObject budgets = new JsonObject();
                budgets.addProperty("break", profile.breakBudget());
                budgets.addProperty("place", profile.placeBudget());
                r.add("budgets", budgets);
                if (!preSolve.reached()) {
                    r.addProperty("partial_solve", true);
                }
                r.addProperty("note", (preSolve.reached()
                    ? "a route EXISTS but not under these budgets"
                    : "even the best PARTIAL route the search found needs more than these budgets")
                    + " — re-issue with `budget` {break: " + Math.max(breaks, profile.breakBudget())
                    + ", place: " + Math.max(places, profile.placeBudget())
                    + "} (max 256 each), or split the trip");
                return r;
            }
        }

        // Displace whatever base intent was running; a goal owns the body while it runs.
        DroneTools.claimBase(slot, DroneTools.BaseKind.GOAL, "superseded");
        DroneTools.failPending(slot, "superseded");

        String item = a.has("item") && !a.get("item").isJsonNull() ? a.get("item").getAsString() : null;
        Goal goal = new Goal("g-" + (++actionSeq), action, selector, profile, target, item, waiter);
        goal.acceptNoDrops = a.has("accept_no_drops") && !a.get("accept_no_drops").isJsonNull()
            && a.get("accept_no_drops").getAsBoolean();
        // TWO RADII THAT DISAGREE. Arrival for `move` is 2.5 blocks; hand reach is 4.5 WITH line of
        // sight — so a cell 2.4 blocks away behind a corner satisfies arrival and fails reach, and
        // the bot_mine that follows returns out_of_reach (26 times in w2-56123). The remedy its note
        // recommends, bot_goto {reach}, was not reachable from inside a goal at all: `move` did not
        // accept `reach`, though the machinery has passed it for destroy/place since the beginning
        // (see navigate()). Now the goal-shaped approach and the hand-shaped approach are one call.
        goal.reachArrival = a.has("reach") && !a.get("reach").isJsonNull()
            && a.get("reach").getAsBoolean();
        slot.goal = goal;
        com.mattmc.mcptoolkit.wm.Wm.goalStarted(slot.target(), slot.activeBody(), goal.actionId,
            goal.action, selector, goal.profile.describe());

        r.addProperty("started", true);
        r.addProperty("action_id", goal.actionId);
        r.addProperty("action", action);
        r.addProperty("target", target.describe());
        r.add("profile", goal.profile.describe());
        return r;
    }

    /**
     * A STANDING-RULE {@code attack} ({@code kind} selector) designates rather than swings: it writes
     * a row in the {@link ThreatTable}, and the engage toggle on {@code bot_body} decides whether
     * anything acts on it (BOT_SURFACE_DESIGN.md §4.4). An INDIVIDUAL attack no longer comes here at
     * all — it is a real goal (approach + swing + completion, {@link #tickAttack}); w2-79881 proved
     * that "attack = a table row" reads as "the body will fight" and it will not.
     *
     * <p><b>The honesty trap this closes.</b> With combat off, designating did nothing but record an
     * intent — reporting plain success would be a textbook false success. So the verdict says
     * {@code engaged:false} and names what is missing. Designation deliberately does NOT arm combat
     * implicitly (that would make a mode change invisible); {@code engage:true} arms it explicitly in
     * the same call, so the common case is still one round trip.
     */
    private static JsonObject designate(final DroneTools.Slot slot, final JsonObject a,
                                        final JsonObject selector, final Targets.@Nullable Resolved target) {
        // A `kind` selector is a STANDING RULE ("zombies, generally"); anything else is an individual.
        // A standing rule arms with target == null — nothing of the kind needs to exist yet.
        boolean standing = selector.has("kind") && !selector.get("kind").isJsonNull();
        if (standing) {
            slot.threats.designateKind(selector.get("kind").getAsString());
        } else {
            slot.threats.designate(target.entity());
        }
        if (a.has("engage") && !a.get("engage").isJsonNull() && a.get("engage").getAsBoolean()) {
            slot.engaged = true;
        }

        JsonObject r = new JsonObject();
        r.addProperty("started", true);
        r.addProperty("action", "attack");
        r.addProperty("designated", true);
        r.addProperty("standing_rule", standing);
        r.addProperty("target", target != null ? target.describe()
            : "none in range yet (standing rule armed)");
        r.addProperty("engaged", slot.engaged);
        r.add("designations", slot.threats.describe());
        if (!slot.engaged) {
            r.addProperty("note", "combat mode is OFF — this target is recorded but NOTHING will act "
                + "on it. Arm it with bot_body action:\"engage\", or pass engage:true here.");
        } else if (target == null) {
            r.addProperty("note", "nothing of this kind is in range right now — the rule stands, and "
                + "combat will act on the first one that appears");
        }
        return r;
    }

    // ---- bot_tunnel ----------------------------------------------------------

    /**
     * THE BRANCH TUNNEL, AS ONE CALL. Session w2-56123 spent 347 {@code bot_mine} and 187
     * {@code bot_target} calls — a third of everything it did — hand-cranking corridors one block at
     * a time, and its own end-of-session report named this verb as the single largest call-count win
     * available. ~200 round trips collapse into ~10.
     *
     * <p>It is a GOAL, not a client-side loop, and that is the whole design: it inherits budgets,
     * the nav profile, the ledger (so a tunnel that stops halfway is resumable without a survey
     * turn), supersession, the watchdogs, and the honest-verdict machinery for free. What it adds is
     * a position-driven state machine — every tick re-decides from where the body ACTUALLY is,
     * rather than from a step counter that can drift out of agreement with the world.
     *
     * <p>{@code slope:"up"} is the same primitive rotated: a staircase, which is what a player
     * builds to get out of a mine. That is the answer to "there is no route home" — descending is
     * gravity plus a pickaxe, and ascending 50 blocks was asking the solver for a path it will not
     * find (w2-56123 ended stranded at y=16 with {@code pillar_blocked} 28 times).
     */
    static JsonObject startTunnel(final JsonObject a, final DroneTools.Slot slot,
                                  final @Nullable CompletableFuture<JsonElement> waiter) {
        JsonObject r = new JsonObject();
        LivingEntity body = slot.activeBody();
        if (body == null) {
            r.addProperty("started", false);
            r.addProperty("reason", "no_body");
            return r;
        }
        if (Hands.of(body) == null) {
            r.addProperty("started", false);
            r.addProperty("reason", "no_hands");
            r.addProperty("note", "digging needs a body with hands — bot_release, or bot_body spawn");
            return r;
        }
        Direction dir = a.has("direction") && !a.get("direction").isJsonNull()
            ? parseDirection(a.get("direction").getAsString())
            : body.getDirection();
        int slope = switch (a.has("slope") && !a.get("slope").isJsonNull()
                ? a.get("slope").getAsString() : "flat") {
            case "flat" -> 0;
            case "up" -> 1;
            case "down" -> -1;
            default -> throw new IllegalArgumentException("`slope` is flat | up | down");
        };
        int length = a.has("length") && !a.get("length").isJsonNull()
            ? a.get("length").getAsInt() : TUNNEL_LENGTH_DEFAULT;
        if (length < 1 || length > TUNNEL_LENGTH_MAX) {
            throw new IllegalArgumentException("`length` is 1.." + TUNNEL_LENGTH_MAX + " blocks");
        }
        int height = a.has("height") && !a.get("height").isJsonNull()
            ? a.get("height").getAsInt() : 2;
        if (height < 2 || height > 3) {
            throw new IllegalArgumentException("`height` is 2 (a corridor) or 3");
        }
        int torchEvery = a.has("torch_every") && !a.get("torch_every").isJsonNull()
            ? Math.max(0, a.get("torch_every").getAsInt()) : 0;
        Integer toY = a.has("to_y") && !a.get("to_y").isJsonNull() ? a.get("to_y").getAsInt() : null;
        boolean untilSky = a.has("until_sky") && !a.get("until_sky").isJsonNull()
            && a.get("until_sky").getAsBoolean();
        if ((toY != null || untilSky) && slope == 0) {
            throw new IllegalArgumentException(
                "`to_y`/`until_sky` need a sloped tunnel — pass slope:\"up\" (the way home) or \"down\"");
        }

        // A tunnel always breaks; that is what it is. Places are only ever torches, so the profile's
        // place rights stay off and the torch goes through bot_place directly. A SLOPED tunnel digs
        // one transition-clearance cell per step on top of the column (launch headroom going up, the
        // landing lip going down — see the want loop in tickTunnel), so its budget is height+1 per
        // step; sizing it at height meant a long staircase died break_budget_spent mid-climb.
        NavProfile profile = NavProfile.tunnel(
            length * (slope == 0 ? height : height + 1) + TUNNEL_BREAK_SLACK);
        DroneTools.claimBase(slot, DroneTools.BaseKind.GOAL, "superseded");
        DroneTools.failPending(slot, "superseded");

        BlockPos start = body.blockPosition();
        BlockPos end = start.relative(dir, length).above(slope * length);
        Targets.Resolved target = new Targets.Resolved(null, end,
            "tunnel " + length + " " + dir.getName() + (slope == 0 ? "" : " sloping "
                + (slope > 0 ? "up" : "down")));
        Goal goal = new Goal("g-" + (++actionSeq), "tunnel", a.deepCopy(), profile, target, null, waiter);
        goal.tunnel = new Tunnel(dir, length, height, slope, torchEvery, toY, untilSky, start);
        slot.goal = goal;
        com.mattmc.mcptoolkit.wm.Wm.goalStarted(slot.target(), slot.activeBody(), goal.actionId,
            goal.action, goal.selector, goal.profile.describe());

        r.addProperty("started", true);
        r.addProperty("action_id", goal.actionId);
        r.addProperty("action", "bot_tunnel");
        r.addProperty("direction", dir.getName());
        r.addProperty("length", length);
        r.addProperty("height", height);
        addPos(r, "toward", end);
        r.addProperty("note", "digging; the outcome carries a ledger of every cell actually mined, so "
            + "a tunnel that stops early resumes without a survey. It stops honestly on "
            + "fluid_ahead (water/lava — never dug), unbreakable_ahead, break_budget_spent, or stuck");
        return r;
    }

    private static Direction parseDirection(final String name) {
        Direction d = Direction.byName(name.toLowerCase(java.util.Locale.ROOT));
        if (d == null || d.getAxis().isVertical()) {
            throw new IllegalArgumentException("`direction` is north|south|east|west — for vertical "
                + "travel use slope:\"up\"/\"down\" (a staircase), which is what a body can walk");
        }
        return d;
    }

    /** The tunnel's own state: what was asked for, and where it began. Progress is read from the
     *  BODY's position every tick, never from a counter — a counter can disagree with the world. */
    static final class Tunnel {
        final Direction dir;
        final int length;
        final int height;
        final int slope;          // +1 up, 0 flat, -1 down
        final int torchEvery;
        final @Nullable Integer toY;
        final boolean untilSky;
        final BlockPos start;
        int stalls;
        int torchedAt = -1;       // advance count at which the last torch was placed
        boolean torchWarned;
        /** Progress at the last walk leg, and whether any leg has run — the no-progress bound. */
        int lastAdvance = Integer.MIN_VALUE;
        boolean walked;
        /** Target of the last walk leg issued — the diagnostic locus when a leg is refused. */
        @Nullable BlockPos lastWalkTo;
        /** Consecutive {@code did_not_start} walk legs. A refused solve is deterministic over an
         *  unchanged world: one retry (the world may still be settling from a dig), then terminal —
         *  never the 2-tick spin that flooded w1_42257's event stream with ~23 identical pairs. */
        int walkRefusals;

        Tunnel(Direction dir, int length, int height, int slope, int torchEvery,
               @Nullable Integer toY, boolean untilSky, BlockPos start) {
            this.dir = dir;
            this.length = length;
            this.height = height;
            this.slope = slope;
            this.torchEvery = torchEvery;
            this.toY = toY;
            this.untilSky = untilSky;
            this.start = start;
        }

        /** Blocks advanced along the dig axis — signed, so backsliding is visible rather than lost. */
        int advanced(final BlockPos feet) {
            return (feet.getX() - start.getX()) * dir.getStepX()
                + (feet.getZ() - start.getZ()) * dir.getStepZ();
        }
    }

    /**
     * One tick of a tunnel: finish if the goal is met, refuse honestly if the next cells cannot be
     * dug, dig the first blocked cell, or walk into the cell just opened. Exactly one of those per
     * tick, and every one of them is re-derived from the body's real position.
     */
    private static void tickTunnel(final DroneTools.Slot slot, final Goal goal,
                                   final LivingEntity body, final ServerLevel level) {
        Tunnel t = goal.tunnel;
        BlockPos feet = body.blockPosition();
        int advanced = t.advanced(feet);

        if (advanced >= t.length) {
            emitComplete(slot, goal, "achieved", "tunnel complete — " + advanced + " blocks "
                + t.dir.getName() + ", ledger has every cell mined");
            return;
        }
        if (t.toY != null && (t.slope > 0 ? feet.getY() >= t.toY : feet.getY() <= t.toY)) {
            emitComplete(slot, goal, "achieved", "reached y=" + feet.getY() + " after " + advanced
                + " blocks of staircase");
            return;
        }
        if (t.untilSky && level.canSeeSky(feet.above())) {
            emitComplete(slot, goal, "achieved", "SURFACE — open sky above this cell, after "
                + advanced + " blocks of staircase from y=" + t.start.getY());
            return;
        }

        // A torch on the cell just left: lit corridors are how a body keeps a mine from re-spawning
        // mobs behind it. Silent when there are no torches (the tunnel is still worth digging), but
        // said ONCE so a dark tunnel is never a surprise.
        if (t.torchEvery > 0 && advanced > 0 && advanced != t.torchedAt
                && advanced % t.torchEvery == 0) {
            t.torchedAt = advanced;
            JsonObject targs = new JsonObject();
            addPos(targs, "at", feet);
            targs.addProperty("item", "minecraft:torch");
            JsonObject tr = DroneHands.botPlace(targs, slot);
            if (tr.has("ok") && tr.get("ok").getAsBoolean()) {
                goal.ledger.placed(feet, "minecraft:torch");
            } else if (!t.torchWarned) {
                t.torchWarned = true;
                DroneHands.echoAct(slot, tr, "bot_place", feet);
            }
        }

        // CLEAR AHEAD, THEN WALK — in legs of more than one block, deliberately. `within` clamps at
        // 1.0 (DroneTools.MIN_WITHIN) and a one-cell step is exactly 1.0 away, so a per-cell
        // navigation can satisfy its own arrival test without the body ever moving: the state
        // machine would re-decide the same step forever. Legs of `TUNNEL_WALK_AHEAD` cells are
        // unambiguously travel, and they cost fewer nav starts besides. Digging still happens one
        // cell per tick (each dig returns), so this batches naturally rather than blocking.
        int remaining = t.length - advanced;
        int lookahead = Math.max(1, Math.min(TUNNEL_WALK_AHEAD, remaining));
        BlockPos walkTo = feet;
        for (int step = 1; step <= lookahead; step++) {
            BlockPos at = feet.relative(t.dir, step).above(t.slope * step);
            java.util.List<BlockPos> want = new java.util.ArrayList<>();
            for (int j = 0; j < t.height; j++) {
                want.add(at.above(j));
            }
            if (t.slope > 0) {
                // A body cannot jump through its own ceiling: the cell above the head of the step it
                // launches FROM has to be open too.
                want.add(feet.relative(t.dir, step - 1).above(t.slope * (step - 1) + t.height));
            }
            if (t.slope < 0 && t.height == 2) {
                // The descent's mirror cell. Stepping DOWN, the head (top at oldFeet+1.8) sweeps
                // through the landing column's feet+2 cell BEFORE the body drops — at height 2 that
                // cell is the previous step's floor-level rock, and without it the staircase is a
                // lip no 1.8-tall body can pass (w1_42257 g-49/g-50: dug 9 cells, descended one
                // step, and the walk leg rightly found no path into the rest). A height-3 column
                // already contains it.
                want.add(at.above(t.height));
            }
            // Dig each step's cells NEAREST-THE-EYE FIRST — the order a real player digs a
            // staircase. The order used to be bottom-up and it never mattered, until the F2
            // occluded gate (0.69.0): a DESCENDING step's bottom cell hides behind that same
            // step's top cell, and an ASCENDING step's far-top cell hides behind the launch
            // headroom — a fixed vertical order is wrong for one slope or the other. Nearest-first
            // digs each cell through the opening the previous one made, so the gate and the
            // corridor agree by construction on every slope.
            final net.minecraft.world.phys.Vec3 digEye = body.getEyePosition();
            want.sort(java.util.Comparator.comparingDouble(
                p -> digEye.distanceToSqr(p.getX() + 0.5, p.getY() + 0.5, p.getZ() + 0.5)));
            boolean stepClear = true;
            for (BlockPos cell : want) {
                BlockState st = level.getBlockState(cell);
                if (st.isAir()) {
                    continue;
                }
                stepClear = false;
                // A TUNNEL THAT HITS WATER STOPS AND SAYS SO. Digging a fluid is refused at the
                // hands (fluid_target, 10 000 ticks for nothing), and a corridor loop that kept
                // re-trying it would be the same eight-minute wedge wearing a new hat.
                if (!st.getFluidState().isEmpty() && st.getCollisionShape(level, cell).isEmpty()) {
                    fail(slot, goal, "fluid_ahead", obstructionAt(level, cell, goal, body));
                    return;
                }
                if (st.getDestroySpeed(level, cell) < 0) {
                    fail(slot, goal, "unbreakable_ahead", obstructionAt(level, cell, goal, body));
                    return;
                }
                if (goal.breaksLeft <= 0) {
                    fail(slot, goal, "break_budget_spent", obstructionAt(level, cell, goal, body));
                    return;
                }
                JsonObject args = new JsonObject();
                addPos(args, "at", cell);
                // A corridor dig is for PASSAGE, not drops — wrong_tool must not wedge the route.
                // (The auto-switch still fires first when the pack holds the right tool.)
                args.addProperty("accept_no_drops", true);
                JsonObject mined = DroneHands.startMine(args, slot, null);
                DroneHands.echoAct(slot, mined, "bot_mine", cell);
                if (mined.get("started").getAsBoolean()) {
                    goal.breaksLeft--;
                    goal.repairingAt = cell; // ledgers the mine, then the next tick re-decides
                    goal.waiting = mined.get("action_id").getAsString();
                    t.stalls = 0;
                    t.walkRefusals = 0; // a dig changes the world — a refused walk may pass now
                    didWork(goal);
                    return;
                }
                String reason = mined.get("reason").getAsString();
                // Out of reach is not a refusal here, it is an INSTRUCTION: the far end of the
                // look-ahead is past the arm, so walk into what has already been opened and dig it
                // from there. Only a first step out of reach is genuinely stuck.
                //
                // OCCLUDED (F2, V3_PLAN.md §2) reads exactly the same way, and MUST — the raw dig
                // now refuses a cell no sightline touches, and the far end of a look-ahead is
                // precisely where a corridor cell hides behind the one in front of it. Walking into
                // the stretch already opened IS the repositioning the refusal asks for: from the
                // new stand the cell is an adjacent face, which always has a ray.
                if (("out_of_reach".equals(reason) || "occluded".equals(reason)) && step > 1) {
                    break;
                }
                if ("busy".equals(reason) || "out_of_reach".equals(reason)
                        || "occluded".equals(reason)) {
                    // Something else owns the hands, the body drifted, or this tick's eye has no ray
                    // to the cell. Bounded so a genuinely wedged tunnel concedes instead of spinning
                    // forever — but NOT terminal for occlusion: one badly-ordered cell must not end
                    // a whole corridor. The nearest-first sort above makes gate and corridor agree
                    // in the common case; it is not a proof, because the launch-headroom cell and
                    // the descent-mirror cell sit in DIFFERENT COLUMNS from `at`, so "nearest to the
                    // eye" and "unoccluded" can disagree on a height-3 descent, or from a body
                    // standing off-centre after a partial step. Retrying costs ticks the settling
                    // body spends moving its eye; conceding costs the whole tunnel.
                    if (++t.stalls > MAX_REPAIRS) {
                        fail(slot, goal, reason, obstructionAt(level, cell, goal, body));
                    }
                    return;
                }
                fail(slot, goal, reason, obstructionAt(level, cell, goal, body));
                return;
            }
            if (!stepClear) {
                break; // this step is opened as far as the arm reaches — walk to what is clear
            }
            walkTo = at;
        }
        if (walkTo.equals(feet)) {
            // Nothing ahead is open and nothing could be dug this tick: the only honest move is to
            // let the next tick try again, under the same patience the dig path uses.
            if (++t.stalls > MAX_REPAIRS) {
                fail(slot, goal, "stuck", obstructionAt(level, feet.relative(t.dir), goal, body));
            }
            return;
        }

        // The way is open: walk into it. Movement goes through the real navigation so footing,
        // jumping and the stall watchdog are the ones every other leg uses.
        //
        // PROGRESS IS THE BOUND. A leg that "succeeds" without moving the body is the shape that
        // turns a state machine into a spin, so a walk that leaves `advanced` where it was counts
        // against the same patience a refused dig does — and runs out honestly.
        if (advanced <= t.lastAdvance && t.walked) {
            if (++t.stalls > MAX_REPAIRS) {
                // walkTo is usually an OPEN cell here (the corridor is dug, the body just cannot
                // walk into it — the g-50 shape), so obstructionAt has nothing to describe and the
                // verdict used to end empty. An empty terminal verdict is impossible for tunnels:
                // the fallback names the refused walk instead.
                JsonObject o = obstructionAt(level, walkTo, goal, body);
                fail(slot, goal, "no_progress", o != null ? o : walkRefusedDiag(t, walkTo, null));
                return;
            }
        } else {
            t.stalls = 0;
        }
        t.lastAdvance = advanced;
        t.walked = true;

        JsonObject args = new JsonObject();
        JsonObject to = new JsonObject();
        to.addProperty("x", walkTo.getX() + 0.5);
        to.addProperty("y", (double) walkTo.getY());
        to.addProperty("z", walkTo.getZ() + 0.5);
        args.add("to", to);
        args.addProperty("within", 1.0);
        goal.profile.writeArgs(args);
        t.lastWalkTo = walkTo;
        JsonObject nav = DroneTools.startNav(args, slot, null);
        if (!nav.get("started").getAsBoolean()) {
            if (++t.stalls > MAX_REPAIRS) {
                // The corridor is open but the follower's solve refuses to enter it — walkTo is an
                // air cell, so obstructionAt has nothing to blame and the verdict would end empty.
                // Name the refused walk instead (same never-empty rule as the no_progress path).
                JsonObject o = obstructionAt(level, walkTo, goal, body);
                fail(slot, goal, nav.has("reason") && !nav.get("reason").isJsonNull()
                    ? nav.get("reason").getAsString() : (o == null ? "walk_refused" : "stuck"),
                    o != null ? o : walkRefusedDiag(t, walkTo, null));
            }
            return;
        }
        goal.waiting = nav.get("action_id").getAsString();
    }

    // ---- tick ----------------------------------------------------------------

    static void tick(final DroneTools.Slot slot) {
        Goal goal = slot.goal;
        if (goal == null || goal.waiting != null) {
            return;
        }
        // Same containment as QueueRunner: an act/repair body that throws (no_hands on a possessed
        // body, an unexpected world state) must fail THIS goal honestly, never escape into the
        // server tick event.
        try {
            tickInner(slot, goal);
        } catch (Exception e) {
            if (slot.goal == goal) { // already-terminated goals must not double-report
                fail(slot, goal, e.getMessage() == null ? e.toString() : e.getMessage(), null);
            }
        }
    }

    private static void tickInner(final DroneTools.Slot slot, final Goal goal) {
        LivingEntity body = slot.activeBody();
        if (body == null) {
            fail(slot, goal, "no_body", null);
            return;
        }
        ServerLevel level = (ServerLevel) body.level();

        // A pillar-up owns the body across its arc: place at apex, verify the climb, then re-navigate
        // from one block higher — nothing else steers until it lands.
        if (goal.pillarAt != null) {
            tickPillar(slot, goal, body, level);
            return;
        }

        // A ballistic leap owns the body until touchdown: verify the landing before anything else
        // re-navigates, and ledger the jump only if it really came down at the landing.
        if (goal.leapVerify != null) {
            goal.leapVerifyTicks++;
            boolean landed = body.onGround() && goal.leapVerifyTicks > 2;
            if (landed || goal.leapVerifyTicks > 40) {
                if (landed && body.blockPosition().closerThan(goal.leapVerify, 1.5)) {
                    goal.ledger.jumped(goal.leapVerify);
                }
                goal.leapVerify = null;
                goal.leapVerifyTicks = 0;
            } else {
                return; // mid-arc: no steering, no re-navigation
            }
        }

        // The attack goal has its own loop: a dead target is its VICTORY condition, not a
        // re-resolve trigger, and its act (a swing on rhythm) repeats rather than terminates.
        if ("attack".equals(goal.action)) {
            tickAttack(slot, goal, body, level);
            return;
        }

        // The tunnel has its own loop too: its "target" is a direction and a distance, so there is
        // nothing to re-resolve and no single terminal act — every step is dig, dig, walk.
        if (goal.tunnel != null) {
            tickTunnel(slot, goal, body, level);
            return;
        }

        // Re-resolve: a dead mob or a vanished block should cost the loop a retry, not the agent a turn.
        if (goal.target.isEntity() && !goal.target.entity().isAlive()) {
            Targets.Resolved again = Targets.resolve(level, body, goal.selector);
            if (again == null) {
                fail(slot, goal, "target_lost", null);
                return;
            }
            goal.target = again;
        }

        // A navigation just reported arrival: RE-RUN the touch predicate on the attempt tick (F2 —
        // 4 rays, cheap), then attempt the act. This inverts the old "no re-check" rule: skipping
        // the check was the seam that let a post-arrival dig fire on stale geometry (the wall the
        // audit watched a body mine through).
        //
        // THE TWO GATES ARE NOT ONE VERDICT. The old rule existed for a real reason — a hover-drift
        // oscillation — and `Touch.ok()` collapses exactly the two facts that tell drift from
        // geometry: reach stands are PLANNED at HAND_REACH - PLAN_MARGIN (3.5) while touch() ranges
        // at 4.5 to the block CENTRE, and a flyer drifts ~1 block, so `inRange` alone flips false
        // by centimetres with nothing about the world having changed. Collapsed, every such flip
        // cost a full repair() (a NavSolver.solve plus a repair-budget strike) and surfaced a
        // pathing reason for what is a hover artifact. So they are answered separately:
        //   los == FALSE  → geometry, not drift: no ray reaches any face from this eye. repair() is
        //                   the right machinery (mine the occluder under break rights, else concede
        //                   with the locus), and `occluded` is the word the agent needs to hear.
        //   inRange false → the drift case: the SAME bounded navigate() the act's own out_of_reach
        //                   handler runs below, so one vocabulary and one budget cover both.
        //   los == null   → unreadable chunks: unproven either way, so attempt the act and let the
        //                   hands report `unreadable` themselves rather than inventing a verdict.
        if (goal.readyToAct) {
            goal.readyToAct = false;
            if ("destroy".equals(goal.action) || "place".equals(goal.action)) {
                ReachSolver.Touch touch =
                    ReachSolver.touch(level, body.getEyePosition(), goal.target.blockPos());
                if (Boolean.FALSE.equals(touch.los())) {
                    repair(slot, goal, body, "occluded");
                    return;
                }
                // Out of range short-circuits touch() before any ray is cast (los stays null), so
                // this arm is reached only by a genuine range miss — never by an occlusion.
                if (!touch.inRange() && ++goal.repairs - goal.productiveRepairs <= MAX_REPAIRS) {
                    navigate(slot, goal, body);
                    return;
                }
            }
            act(slot, goal, body, level);
            return;
        }
        if (canActNow(level, body, goal)) {
            act(slot, goal, body, level);
            return;
        }
        navigate(slot, goal, body);
    }

    /**
     * One tick of an attack goal: finish if the target is down or gone, swing if it is in reach,
     * otherwise approach it leg by leg (re-pathing when it drifts). Bounded three ways — the
     * stagnation check (three legs from the same cell without ever reaching = target_unreachable),
     * the caller's {@code attack_timeout_ticks}, and MAX_REPAIRS on refused legs.
     */
    private static void tickAttack(final DroneTools.Slot slot, final Goal goal,
                                   final LivingEntity body, final ServerLevel level) {
        if (++goal.attackTicks > goal.attackTimeout) {
            fail(slot, goal, "gave_up", null);
            return;
        }
        if (goal.swingCooldown > 0) {
            goal.swingCooldown--;
        }
        net.minecraft.world.entity.Entity target = goal.target.entity();
        if (target == null || !target.isAlive()) {
            // Down, or gone. A LivingEntity at 0 health DIED — the goal's predicate holds, no
            // matter whose blow landed last. Anything else (despawn, unload, dimension change)
            // is re-resolved once; a selector that then matches nothing is target_lost.
            if (target instanceof LivingEntity le && le.isDeadOrDying()) {
                emitComplete(slot, goal, "achieved", goal.hits > 0
                    ? "target down (" + goal.hits + " hit(s) landed)"
                    : "target down (it died before this body landed a hit)");
                return;
            }
            Targets.Resolved again = Targets.resolve(level, body, goal.selector);
            if (again == null || !again.isEntity() || !again.entity().isAlive()) {
                fail(slot, goal, "target_lost", null);
                return;
            }
            goal.target = again;
            target = again.entity();
        }

        // In reach: run the F1 gate instead of the old courtesy lookAt. READY → swing on rhythm
        // (the swing reuses the real bot_attack body, so reach/LOS/facing checks, durability, and
        // action events are identical to a hand-issued attack). TURNING → no swing this tick while
        // the rate-limited turn progresses (the loop re-ticks — that IS the async model here).
        // OCCLUDED (in reach but behind cover) falls through to the approach: path around it
        // rather than swing through it.
        if (body.distanceTo(target) <= AttackGate.entityReach(body)) {
            AttackGate.Verdict facing = AttackGate.gate(body, target, true);
            if (facing == AttackGate.Verdict.TURNING) {
                goal.fruitlessRepairs = 0;
                // THE APPROACH MUST NOT DRIVE THROUGH THE TURN. The gate rotates the body itself,
                // and a path being followed rewrites yaw from its heading on every driven frame
                // (FakePlayerEntity.driveMove) — the two then fight and the turn never converges,
                // which is the whole reason the gaze needs ONE owner (V3_PLAN.md §2 F1). Inside
                // reach the leg has nothing left to earn anyway: a stale leg here is one combat or
                // a reflex left running (their navs are issued straight on Bodies.nav, outside this
                // goal's action bookkeeping), still steering toward where the enemy USED to be
                // while the enemy stands at arm's length. Stop it, let the turn complete against a
                // settled body, and swing next tick.
                //
                // Costs no stalled_legs: this goal owns no in-flight leg while it ticks (`waiting`
                // gates tick()), so no leg verdict is produced by the stop — and a fresh approach
                // is issued below the moment the target steps back out of reach.
                if (!Bodies.nav(body).isDone()) {
                    Bodies.nav(body).stop();
                    goal.lastAttackNavPos = null; // the leg is gone; its re-path anchor dies with it
                }
                return; // the turn is this tick's work; the swing waits for the facing
            }
            if (facing == AttackGate.Verdict.READY) {
                goal.fruitlessRepairs = 0;
                if (goal.swingCooldown == 0) {
                    JsonObject arg = new JsonObject();
                    arg.addProperty("target", target.getId());
                    JsonObject r = DroneHands.botAttack(arg, slot);
                    goal.swingCooldown = ATTACK_SWING_TICKS;
                    if (r.has("hit") && r.get("hit").getAsBoolean()) {
                        goal.hits++;
                        didWork(goal);
                    }
                }
                return;
            }
            // OCCLUDED: approach code below repositions (the wall is the obstruction, not range).
        }

        // This hunt already concluded the legs cannot get there and switched to shooting.
        if (goal.rangedFight) {
            shootLeg(slot, goal, body, target);
            return;
        }

        // Out of reach: approach. A leg is (re)issued when none is running, or when the target has
        // drifted from where the running leg was solved for.
        boolean navRunning = goal.waiting != null || !Bodies.nav(body).isDone();
        net.minecraft.world.phys.Vec3 tpos = target.position();
        if (navRunning && goal.lastAttackNavPos != null
            && tpos.distanceTo(goal.lastAttackNavPos) <= ATTACK_REPATH_DISTANCE) {
            return; // the current leg still points at the target
        }
        // Stagnation: a fresh leg from the SAME cell as the last one, still out of reach, three
        // times running, is a target this body cannot close on (walled off, or above/below it).
        if (body.blockPosition().equals(goal.lastRepairCell)) {
            if (++goal.fruitlessRepairs >= 3) {
                concedeOrShoot(slot, goal, body, target, level);
                return;
            }
        } else {
            goal.fruitlessRepairs = 0;
            goal.lastRepairCell = body.blockPosition();
        }
        goal.navigated = true;
        JsonObject args = new JsonObject();
        JsonObject to = new JsonObject();
        to.addProperty("x", tpos.x);
        to.addProperty("y", tpos.y);
        to.addProperty("z", tpos.z);
        args.add("to", to);
        args.addProperty("within", ATTACK_APPROACH_WITHIN);
        goal.profile.writeArgs(args);
        JsonObject r = DroneTools.startNav(args, slot, null);
        if (!r.get("started").getAsBoolean()) {
            if (++goal.repairs - goal.productiveRepairs > MAX_REPAIRS) {
                concedeOrShoot(slot, goal, body, target, level);
            }
            return; // next tick retries (the target moves; a refused leg is not final)
        }
        goal.lastAttackNavPos = tpos;
        goal.waiting = r.get("action_id").getAsString();
    }

    /**
     * The hunt has run out of ways to WALK to its target. <b>Before conceding, ask whether it can
     * be shot instead</b> (COMBAT_KIT_PLAN.md §4.3).
     *
     * <p>This is the exact point at which 7 attack goals died in the 9h47m survival run of
     * 2026-08-11 — against targets the body could SEE perfectly well, across a gap or a stretch of
     * water — because nothing had ever asked whether the pack held a bow. Being unable to walk to
     * something was the end of the fight.
     *
     * <p>BOTH unreachable exits come through here, and that is the point of extracting it: the
     * stagnation counter (three fresh legs from the same cell) and the refused-leg budget
     * ({@link #MAX_REPAIRS}) reach the same conclusion by different routes, and a target on a
     * pillar takes the second one while a target across water takes the first. Hooking only one
     * would have left half the defect standing — and the half left standing would have been
     * whichever the probe did not happen to stage.
     */
    private static void concedeOrShoot(final DroneTools.Slot slot, final Goal goal,
                                       final LivingEntity body,
                                       final net.minecraft.world.entity.Entity target,
                                       final ServerLevel level) {
        CombatKit.Kit kit = CombatKit.choose(body, Hands.of(body), target,
            CombatKit.Reachability.UNREACHABLE);
        goal.why = kit.why();
        // THE SIGHTLINE IS CHECKED HERE, not inside the kit. The kit answers "what kind of fight
        // is this", and a blocked view is not a kind of fight — it is a fact about this spot, and
        // the cure for it is to stand somewhere else (see CombatKit.choose's note: gating the mode
        // on it made an archer oscillate between the ledge and the enemy's face). But THIS caller
        // is the one that has just decided to stop moving, so for it the sightline really is
        // final: a hunt that stands still shooting at a wall until `gave_up` is a worse answer
        // than conceding now and saying why.
        boolean sighted = AttackGate.hasLos(body, target);
        // THROW counts as a ranged answer here, and the hunt does not need to know the difference:
        // both mean "the arsenal can reach what the legs cannot", both are actuated by the same
        // botShoot, and CombatKit has already applied the disarm check that decides whether
        // spending the trident is wise (COMBAT_KIT_PLAN.md D2). What the hunt WILL learn, one shot
        // later, is that a thrown weapon does not repeat: shootLeg's next call refuses, the ranged
        // conclusion is dropped, and the goal concedes honestly instead of miming a throw it can no
        // longer make.
        boolean canReach = kit.mode() == CombatKit.Mode.RANGED || kit.mode() == CombatKit.Mode.THROW;
        if (canReach && !sighted) {
            goal.why = kit.why() + ", but the sightline is blocked from here";
        }
        if (canReach && sighted) {
            goal.rangedFight = true;
            Bodies.nav(body).stop(); // the legs are done arguing with the terrain
            JsonObject md = new JsonObject();
            md.addProperty("action_id", goal.actionId);
            md.addProperty("mode", kit.mode().name().toLowerCase(java.util.Locale.ROOT));
            md.addProperty("why", kit.why());
            EventLog.emit("attack_mode_changed", md, slot.target());
            shootLeg(slot, goal, body, target);
            return;
        }
        fail(slot, goal, "target_unreachable", NavSolver.obstruction(level,
            body.blockPosition(), target.blockPosition(), goal.profile));
    }

    /**
     * One tick of a hunt that has switched to shooting: aim, and loose on the draw rhythm.
     *
     * <p>The aim runs through {@link AttackGate#aim} — the SAME rate-limited turn a swing uses —
     * for two reasons. It is the gaze-leads-action pattern the v3 campaign exists to record, and
     * it is load-bearing the moment the shot becomes real: vanilla fires along the shooter's look
     * vector, so where the body is looking IS where the arrow goes.
     *
     * <p>A shot that fails takes the ranged conclusion with it — the last arrow spent means the
     * capability is gone, and the goal goes back on its feet rather than miming a bow it cannot
     * fire. It concedes honestly one tick later, with a {@code why} that now names the empty
     * quiver instead of the terrain.
     */
    private static void shootLeg(final DroneTools.Slot slot, final Goal goal,
                                 final LivingEntity body, final net.minecraft.world.entity.Entity target) {
        AttackGate.aim(body, target);
        if (goal.swingCooldown > 0) {
            // The hunt's own between-shots time, spent winding (COMBAT_KIT_PLAN.md §4.3). This is
            // the case the design named "during the approach": the body has already concluded it
            // cannot WALK to the target, so every tick from here to the end of the fight is time
            // the legs are not using.
            Crossbows.preload(slot, body);
            return;
        }
        JsonObject arg = new JsonObject();
        arg.addProperty("target", target.getId());
        JsonObject r = DroneHands.botShoot(arg, slot);
        goal.swingCooldown = ATTACK_SHOT_TICKS;
        // A player body's shot is a real DRAW (0.73.0), so `started` — not `ok` — is what a
        // successful hand-off looks like: the body is aiming and will loose on its own clock, and
        // this loop's job is only to stay out of its way until it does. The cooldown covers the
        // whole aim+draw rather than the nominal rhythm, because a re-issue mid-draw would answer
        // `busy` and read here as the capability failing. The drone's shot still answers `ok` the
        // same tick and needs none of this.
        if (r.has("started") && r.get("started").getAsBoolean()) {
            goal.shots++;
            goal.swingCooldown = Math.max(ATTACK_SHOT_TICKS,
                r.has("eta_ticks") ? r.get("eta_ticks").getAsInt() : ATTACK_SHOT_TICKS);
            didWork(goal);
            return;
        }
        if (r.has("ok") && r.get("ok").getAsBoolean()) {
            goal.shots++;
            didWork(goal);
            return;
        }
        goal.rangedFight = false;
        goal.why = r.has("note") ? r.get("note").getAsString()
            : "the shot was refused (" + (r.has("reason") ? r.get("reason").getAsString() : "?") + ")";
    }

    /**
     * Is the body ALREADY in position, before any navigation? Used only on the first tick — after a
     * navigation the arrival verdict (not this) decides, to avoid the hover-drift oscillation above.
     */
    private static boolean canActNow(final ServerLevel level, final LivingEntity body, final Goal goal) {
        return switch (goal.action) {
            case "move" -> goal.reachArrival
                ? ReachSolver.touch(level, body.getEyePosition(), goal.target.blockPos()).ok()
                : body.position().distanceTo(goal.target.where()) <= MOVE_WITHIN;
            case "destroy", "place" ->
                ReachSolver.touch(level, body.getEyePosition(), goal.target.blockPos()).ok();
            case "vantage" -> Vantage.hasLos(level, body, body.getEyePosition(), goal.target.where());
            default -> false;
        };
    }

    /** Perform the goal's terminal act now that the body is in position. */
    private static void act(final DroneTools.Slot slot, final Goal goal, final LivingEntity body,
                            final ServerLevel level) {
        switch (goal.action) {
            case "move" -> {
                goal.ledger.traveledTo(body.blockPosition());
                // Distinguish "I arrived" from "I was already here" — otherwise an agent that
                // re-issues move on a body already within `within` gets a fresh "achieved" each
                // time, reads bot_status, sees it isn't EXACTLY on the goal cell, and re-issues
                // again: a thrash the bench caught (goal arm, gap course, 12 turns). already_there
                // is the "stop, you are done" signal, mirroring bot_goto.
                completeMove(slot, goal, goal.navigated);
            }
            case "destroy" -> {
                JsonObject args = new JsonObject();
                addPos(args, "at", goal.target.blockPos());
                if (goal.item != null) {
                    args.addProperty("item", goal.item);
                }
                // A destroy goal is a HARVEST unless the caller says otherwise: a wrong-tool dig
                // fails the goal (reason wrong_tool) instead of wasting the block.
                if (goal.acceptNoDrops) {
                    args.addProperty("accept_no_drops", true);
                }
                JsonObject r = DroneHands.startMine(args, slot, null);
                DroneHands.echoAct(slot, r, "bot_mine", goal.target.blockPos());
                if (!r.get("started").getAsBoolean()) {
                    String reason = r.get("reason").getAsString();
                    if ("nothing_to_mine".equals(reason)) {
                        // Already air: the goal's PREDICATE holds, but a bare "achieved" here is a
                        // false success in the caller's hands — live-caught 2026-08-09: a survival
                        // agent invented coordinates from scan tallies, and every destroy at an
                        // empty guessed cell came back looking exactly like a real harvest, so it
                        // kept guessing. Complete (idempotent re-runs stay cheap and final), but
                        // SAY what happened: nothing was mined, and if a block was expected the
                        // coordinates were wrong. Mirrors move's already_there.
                        emitComplete(slot, goal, "already_clear",
                            "that cell already held no block — nothing was mined and there are no "
                            + "drops. If you expected a block here, the coordinates are wrong: scan "
                            + "tallies carry NO coordinates. locate gives exact remembered cells, "
                            + "vantage names obstructions, raycast reads what you are looking at");
                        return;
                    }
                    // Arrived-but-not-in-reach (hover drift, or the flight stopped just short) or
                    // arrived-but-occluded (F2 — the raw dig now refuses what no sightline
                    // touches): navigate again rather than failing on a transient. Bounded so a
                    // genuinely unreachable/buried target still stops.
                    if (("out_of_reach".equals(reason) || "occluded".equals(reason))
                        && ++goal.repairs - goal.productiveRepairs <= MAX_REPAIRS) {
                        navigate(slot, goal, body);
                        return;
                    }
                    fail(slot, goal, reason, null);
                    return;
                }
                goal.repairingAt = null; // this dig IS the act, not a repair
                goal.waiting = r.get("action_id").getAsString();
            }
            case "place" -> {
                JsonObject args = new JsonObject();
                addPos(args, "at", goal.target.blockPos());
                if (goal.item != null) {
                    args.addProperty("item", goal.item);
                }
                JsonObject r = DroneHands.botPlace(args, slot);
                DroneHands.echoAct(slot, r, "bot_place", goal.target.blockPos());
                if (r.has("ok") && !r.get("ok").getAsBoolean()) {
                    String reason = r.get("reason").getAsString();
                    if ("out_of_reach".equals(reason) && ++goal.repairs - goal.productiveRepairs <= MAX_REPAIRS) {
                        navigate(slot, goal, body);
                        return;
                    }
                    fail(slot, goal, reason, null);
                    return;
                }
                goal.ledger.placed(goal.target.blockPos(), goal.item == null ? "held" : goal.item);
                complete(slot, goal);
            }
            case "vantage" -> {
                // Seeing IS the act: verify from the body's REAL eye, face the target, done. A
                // candidate that lost its sightline en route falls through to the next one.
                if (Vantage.hasLos(level, body, body.getEyePosition(), goal.target.where())) {
                    body.lookAt(net.minecraft.commands.arguments.EntityAnchorArgument.Anchor.EYES,
                        goal.target.where());
                    goal.ledger.traveledTo(body.blockPosition());
                    emitComplete(slot, goal, "los_achieved",
                        "you can see the target from here — the view is live; look/scan to observe");
                    return;
                }
                if (++goal.repairs - goal.productiveRepairs > MAX_REPAIRS) {
                    fail(slot, goal, "no_vantage_reachable", null);
                    return;
                }
                navigate(slot, goal, body);
            }
            default -> fail(slot, goal, "unknown_action", null);
        }
    }

    /** Start (or restart) navigation toward the goal. */
    private static void navigate(final DroneTools.Slot slot, final Goal goal, final LivingEntity body) {
        goal.navigated = true;
        JsonObject args = new JsonObject();
        if ("vantage".equals(goal.action)) {
            navigateVantage(slot, goal, body);
            return;
        }
        if ("destroy".equals(goal.action) || "place".equals(goal.action)
                || ("move".equals(goal.action) && goal.reachArrival)) {
            addPos(args, "reach", goal.target.blockPos());
        } else {
            JsonObject to = new JsonObject();
            var w = goal.target.where();
            to.addProperty("x", w.x);
            to.addProperty("y", w.y);
            to.addProperty("z", w.z);
            args.add("to", to);
            args.addProperty("within", MOVE_WITHIN);
        }
        goal.profile.writeArgs(args); // every leg walks under the GOAL's rights, not DEFAULT
            JsonObject r = DroneTools.startNav(args, slot, null);
        if (!r.get("started").getAsBoolean()) {
            // A start refusal that pathing cannot fix (occluded, reach_unresolved) is terminal —
            // but a plain no_path is exactly what the repair loop exists for.
            String reason = r.has("reason") && !r.get("reason").isJsonNull()
                ? r.get("reason").getAsString() : "no_path";
            boolean buried = "occluded".equals(reason) || "no_path_to_reach_position".equals(reason);
            if ("no_path".equals(reason) || "not_arrived".equals(reason)) {
                repair(slot, goal, body, reason);
            } else if (buried && goal.profile.canBreak()) {
                // A BURIED TARGET IS WORK, NOT A REFUSAL — when the goal was given break rights.
                //
                // "occluded" says no cell in hand reach has line of sight to the target; the note it
                // carries says "mine an occluder to expose a face first". That is a repair: exactly
                // the decision repair() already makes, with the build-aware search choosing which
                // cell to mine by route cost. But this branch treated every non-no_path refusal as
                // terminal, so a `destroy` with may_modify:"break" — a caller who has explicitly
                // said "dig through what is in the way" — was answered "stopped: occluded" without
                // one block being touched, and the goal layer's whole reason for existing (repair
                // server-side instead of spending an agent turn) never engaged.
                //
                // Live, session w1-85918: `bot_target destroy` on the cell UNDER THE BODY'S OWN FEET
                // returned occluded twice. Digging down — the most ordinary act in the game — had no
                // goal-shaped form at all, so the agent fell back to raw bot_mine and spent 66 calls
                // plus 75 event polls (58% of the session) hand-cranking a 1x1 shaft, hitting `busy`
                // and `out_of_reach` the whole way down. The capability was already built and
                // reachable (mined-descent edges 0.38.0, pillar edges 0.26.0, and goal.profile is
                // threaded into every nav leg below); this line was the gate that never opened.
                //
                // Without break rights the refusal stands and is still terminal — a body that
                // silently tunnels to something it was told not to tunnel to is the false success
                // may_modify exists to prevent.
                repair(slot, goal, body, reason);
            } else {
                fail(slot, goal, reason, buried ? enclosedLocus(body, goal, reason) : null);
            }
            return;
        }
        goal.waiting = r.get("action_id").getAsString();
    }

    /**
     * Navigate toward the NEXT untried vantage candidate. Candidates are computed once (LOS from
     * their eye height at compute time); the act re-verifies from the body's real eye on arrival,
     * so a stale candidate costs one leg of travel, never a false success.
     */
    private static void navigateVantage(final DroneTools.Slot slot, final Goal goal,
                                        final LivingEntity body) {
        ServerLevel level = (ServerLevel) body.level();
        if (goal.vantageCandidates == null) {
            goal.vantageCandidates = Vantage.candidates(level, body, goal.target.where(), VANTAGE_RANGE);
        }
        while (goal.vantageIdx < goal.vantageCandidates.size()) {
            BlockPos stand = goal.vantageCandidates.get(goal.vantageIdx++);
            JsonObject args = new JsonObject();
            addPos(args, "to", stand);
            args.addProperty("within", 1.5);
            goal.profile.writeArgs(args); // every leg walks under the GOAL's rights, not DEFAULT
            JsonObject r = DroneTools.startNav(args, slot, null);
            if (r.get("started").getAsBoolean()) {
                goal.waiting = r.get("action_id").getAsString();
                return;
            }
        }
        fail(slot, goal, goal.vantageCandidates.isEmpty() ? "no_vantage_found" : "no_vantage_reachable",
            NavSolver.obstruction(level, body.blockPosition(), goal.target.blockPos(), goal.profile));
    }

    // ---- repair --------------------------------------------------------------

    /**
     * One local repair at the frontier, then navigation is retried. The obstruction is computed from
     * the body's OWN position, so the blocking cell is adjacent — and therefore within hand reach,
     * which is what makes a repair a single act rather than another journey.
     */
    /**
     * Mark a repair round as REAL WORK: the world changed under it. Clears the stagnation strikes and
     * credits the round, exempting it from the confusion budget (see {@link Goal#productiveRepairs}).
     */
    private static void didWork(final Goal goal) {
        goal.fruitlessRepairs = 0;
        goal.productiveRepairs++;
    }

    private static void repair(final DroneTools.Slot slot, final Goal goal, final LivingEntity body,
                               final String navReason) {
        ServerLevel level = (ServerLevel) body.level();
        // Only rounds that achieved NOTHING count against the budget — a mine-by-mine descent is
        // hundreds of legitimate rounds and is bounded by the caller's `budget` {break, place}.
        if (++goal.repairs - goal.productiveRepairs > MAX_REPAIRS) {
            fail(slot, goal, "repair_budget_spent",
                NavSolver.obstruction(level, body.blockPosition(), goal.target.blockPos(), goal.profile));
            return;
        }

        // Ask the BUILD-AWARE SEARCH what to do — the choice among jump / open-door / mine / bridge is
        // made by global A* cost (which route is cheapest given this body's rights), not by eyeballing
        // the single next cell. The vanilla nav in navigate() moves the body up to the first
        // obstruction; this decides the one action that clears it, then the next tick re-navigates.
        float budget = Math.min(256.0F,
            (float) body.position().distanceTo(goal.target.where()) * 4.0F + 32.0F);
        NavSolver.Result solved = NavSolver.solve(level, physique(body, goal.profile),
            java.util.Set.of(goal.target.blockPos()), budget, goal.profile);
        NavSolver.Step step = NavSolver.firstPlannedStep(solved);

        if (step == null) {
            // The capable search sees no work to do, yet the body stopped short. If even the
            // build-aware search can't reach, it is genuinely blocked; report the locus honestly.
            JsonObject locus = NavSolver.obstruction(level, body.blockPosition(),
                goal.target.blockPos(), goal.profile);
            fail(slot, goal, solved.reached() ? navReason : "unreachable", locus);
            return;
        }

        // IN-REACH WORK FIRST (w1_42257 F5). The first planned step along the path can be
        // untouchable from here while LATER planned work already sits at arm's length — from
        // inside a pocket every route out IS the work, so "walk to the first step" was a leg the
        // follower rightly refused, once per round (the pit probe counted 9 did_not_start
        // completions on a WORKING escape). Prefer the first planned act the hands can touch NOW;
        // walking stays the fallback when nothing is in reach. JUMP/PILLAR keep their exemption —
        // their work is underfoot.
        if (step.action() != BuildWalkNodeEvaluator.Action.JUMP
                && step.action() != BuildWalkNodeEvaluator.Action.PILLAR
                && !ReachSolver.touch(level, body.getEyePosition(), step.at()).ok()) {
            net.minecraft.world.level.pathfinder.Path plannedPath = solved.path();
            search:
            for (int i = 0; plannedPath != null && i < plannedPath.getNodeCount(); i++) {
                BlockPos feet = plannedPath.getNode(i).asBlockPos();
                for (BlockPos c : new BlockPos[] { feet, feet.above(), feet.above(2), feet.below() }) {
                    BuildWalkNodeEvaluator.Action a = solved.evaluator().plannedAt(c);
                    if ((a == BuildWalkNodeEvaluator.Action.BREAK
                            || a == BuildWalkNodeEvaluator.Action.PLACE
                            || a == BuildWalkNodeEvaluator.Action.OPEN_DOOR)
                        && ReachSolver.touch(level, body.getEyePosition(), c).ok()) {
                        step = new NavSolver.Step(c, a);
                        break search;
                    }
                }
            }
        }

        BlockPos at = step.at();

        // Stagnation: a repair round that starts from the SAME cell as the last one, with no work
        // performed in between, is re-deciding a dead end — the re-solve is deterministic over an
        // unchanged world, so the next round decides the same thing. Three such rounds end the goal
        // with the obstruction now, instead of burning a node timeout per round until MAX_REPAIRS
        // (measured: ~2 minutes of a body jittering in place, per goal, on the live wedge).
        boolean moved = !body.blockPosition().equals(goal.lastRepairCell);
        goal.lastRepairCell = body.blockPosition();
        if (moved) {
            goal.fruitlessRepairs = 0;
        } else if (++goal.fruitlessRepairs >= 3) {
            fail(slot, goal, "no_progress", obstructionAt(level, at, goal, body));
            return;
        }

        // The planned work may be far down the path (a door around a corner, a wall several cells
        // out). Acting on a cell the body cannot touch would be action-at-a-distance — walk to the
        // work first; the next tick re-decides from there (and re-solving may pick a different step,
        // which is fine: the plan is optimism, the loop is the reconciliation). JUMP and PILLAR are
        // exempt: their "work cell" is under the body's own feet — there is nowhere to walk to.
        if (step.action() != BuildWalkNodeEvaluator.Action.JUMP
            && step.action() != BuildWalkNodeEvaluator.Action.PILLAR
            && !ReachSolver.touch(level, body.getEyePosition(), at).ok()) {
            goal.navigated = true;
            JsonObject args = new JsonObject();
            addPos(args, "reach", at);
            goal.profile.writeArgs(args); // every leg walks under the GOAL's rights, not DEFAULT
            JsonObject r = DroneTools.startNav(args, slot, null);
            if (r.get("started").getAsBoolean()) {
                goal.workNav = at;
                goal.waiting = r.get("action_id").getAsString();
                return;
            }
            // Could not even start toward the work — report the work cell, not a generic stall.
            fail(slot, goal, "cannot_reach_work", obstructionAt(level, at, goal, body));
            return;
        }

        switch (step.action()) {
            case JUMP -> {
                // Ledgering happens at VERIFIED TOUCHDOWN, not here — the ledger's contract is "a
                // real completed act, never a prediction", and an undershoot into the gap is not a
                // jump that happened. Walker leaps report through the driver's landing drain; a
                // possessed leap is verified by the tick watch (Goal.leapVerify).
                actuateJump(slot, goal, body, at);
                // no waiting unless actuateJump navigated: the impulse advances the body; next tick
                // re-navigates from wherever it lands.
            }
            case OPEN_DOOR -> {
                // A door is a bare-hand BLOCK interaction, not an item use — open it the way a
                // vanilla mob's OpenDoorGoal does. botUse stays item-centric (its empty_hand refusal
                // is correct for item use; routing doors through it was live-caught as a stall).
                BlockState doorState = level.getBlockState(at);
                if (doorState.getBlock() instanceof DoorBlock door && door.type().canOpenByHand()) {
                    door.setOpen(body, level, doorState, at, true);
                    goal.ledger.doorOpened(at);
                    didWork(goal); // real work performed — not a stagnant round, and not confusion
                } else {
                    fail(slot, goal, "door_missing", obstructionAt(level, at, goal, body));
                    return;
                }
            }
            case PLACE -> {
                if (goal.placesLeft <= 0) {
                    fail(slot, goal, "place_budget_spent", obstructionAt(level, at, goal, body));
                    return;
                }
                JsonObject args = new JsonObject();
                addPos(args, "at", at);
                // Self-provisioned fill: an unnamed `item` resolves to the pack's cheap fill, never
                // the held slot — a repairing body holds its TOOL (see fillItem).
                String fill = goal.item != null ? goal.item : fillItem(body);
                if (fill == null) {
                    fail(slot, goal, "no_blocks_to_place", obstructionAt(level, at, goal, body));
                    return;
                }
                args.addProperty("item", fill);
                JsonObject r = DroneHands.botPlace(args, slot);
                DroneHands.echoAct(slot, r, "bot_place", at);
                if (r.has("ok") && !r.get("ok").getAsBoolean()) {
                    // item_missing here IS a navigation failure — you cannot bridge without blocks.
                    fail(slot, goal, r.get("reason").getAsString(), obstructionAt(level, at, goal, body));
                    return;
                }
                goal.placesLeft--;
                goal.ledger.placed(at, fill);
                didWork(goal); // real work performed — not a stagnant round, and not confusion
            }
            case BREAK -> {
                if (goal.breaksLeft <= 0) {
                    fail(slot, goal, "break_budget_spent", obstructionAt(level, at, goal, body));
                    return;
                }
                JsonObject args = new JsonObject();
                addPos(args, "at", at);
                // Repair digs open the way; drops are incidental. Never wedge on wrong_tool.
                args.addProperty("accept_no_drops", true);
                JsonObject r = DroneHands.startMine(args, slot, null);
                DroneHands.echoAct(slot, r, "bot_mine", at);
                if (!r.get("started").getAsBoolean()) {
                    fail(slot, goal, r.get("reason").getAsString(), obstructionAt(level, at, goal, body));
                    return;
                }
                goal.breaksLeft--;
                goal.repairingAt = at;
                goal.waiting = r.get("action_id").getAsString();
                didWork(goal); // real work performed — not a stagnant round, and not confusion
            }
            case PILLAR -> {
                if (goal.placesLeft <= 0) {
                    fail(slot, goal, "place_budget_spent", obstructionAt(level, at, goal, body));
                    return;
                }
                // TELEPORT GUARD: the planned pillar column must be UNDERFOOT. firstPlannedStep can
                // return a pillar cell blocks along the path, and the recentre below is a setPos —
                // fired from afar it was a silent horizontal teleport (review-caught, w2 postmortem).
                // Walking into the column is work approach like any other; the next round pillars.
                double flat = Math.hypot(at.getX() + 0.5 - body.getX(), at.getZ() + 0.5 - body.getZ());
                if (flat > 1.6) {
                    goal.navigated = true;
                    JsonObject args = new JsonObject();
                    addPos(args, "to", at);
                    goal.profile.writeArgs(args);
                    JsonObject r = DroneTools.startNav(args, slot, null);
                    if (r.get("started").getAsBoolean()) {
                        goal.workNav = at;
                        goal.waiting = r.get("action_id").getAsString();
                        return;
                    }
                    fail(slot, goal, "cannot_reach_work", obstructionAt(level, at, goal, body));
                    return;
                }
                // MINE-UP interplay: the plan may pair this pillar with BREAKs overhead (the mine-up
                // edge records the ceiling cells it intends to open). Launching under a still-solid
                // ceiling just bonks — clear the overhead cells first, one dig per round exactly like
                // any BREAK repair; the pillar fires on a later round once the column is open.
                BlockPos overhead = null;
                for (BlockPos cell : new BlockPos[] { at.above(), at.above(2) }) {
                    if (!level.getBlockState(cell)
                        .isPathfindable(net.minecraft.world.level.pathfinder.PathComputationType.LAND)) {
                        overhead = cell;
                        break;
                    }
                }
                if (overhead != null) {
                    if (goal.breaksLeft <= 0) {
                        fail(slot, goal, "break_budget_spent", obstructionAt(level, overhead, goal, body));
                        return;
                    }
                    JsonObject args = new JsonObject();
                    addPos(args, "at", overhead);
                    // Clearing a pillar's headroom is passage work, like any BREAK repair.
                    args.addProperty("accept_no_drops", true);
                    JsonObject r = DroneHands.startMine(args, slot, null);
                    DroneHands.echoAct(slot, r, "bot_mine", overhead);
                    if (!r.get("started").getAsBoolean()) {
                        fail(slot, goal, r.get("reason").getAsString(),
                            obstructionAt(level, overhead, goal, body));
                        return;
                    }
                    goal.breaksLeft--;
                    goal.repairingAt = overhead;
                    goal.waiting = r.get("action_id").getAsString();
                    didWork(goal);
                    return;
                }
                // Clear any residual path so the driver's steer can't add horizontal drift mid-arc,
                // recentre on the column (a sub-block nudge inside the body's OWN standing cell, so it
                // comes down squarely on the 1x1 block rather than slipping off its edge back into the
                // pit), launch STRAIGHT up, and hand off to the pillar state machine.
                Bodies.nav(body).stop();
                body.setPos(at.getX() + 0.5, body.getY(), at.getZ() + 0.5);
                if (body instanceof WalkerEntity walker) {
                    walker.launch(0.0, PILLAR_JUMP_VY, 0.0);
                } else {
                    body.setDeltaMovement(0.0, PILLAR_JUMP_VY, 0.0);
                    body.hurtMarked = true;
                }
                goal.pillarAt = at;
                goal.pillarPhase = PILLAR_RISING;
                goal.pillarTicks = 0;
                didWork(goal); // real work performed — not a stagnant round, and not confusion
                // No goal.waiting: tickPillar drives the maneuver over the next ticks.
            }
        }
    }

    /**
     * Drive the pillar-up maneuver a tick at a time (BOT_SURFACE_DESIGN.md §12.2). RISING: once the
     * feet clear the block cell, drop the block underfoot (a real {@code bot_place}, disclosed in the
     * ledger) and switch to LANDING. LANDING: wait for touchdown one block up, then re-navigate. Any
     * failure — no room to place, a bonked ceiling the search missed, a timeout — stops the goal
     * honestly rather than looping, with the same obstruction locus a stalled repair reports.
     */
    private static void tickPillar(final DroneTools.Slot slot, final Goal goal, final LivingEntity body,
                                   final ServerLevel level) {
        goal.pillarTicks++;
        BlockPos at = goal.pillarAt;
        if (goal.pillarPhase == PILLAR_RISING) {
            if (body.getY() >= at.getY() + 1.0 + PILLAR_PLACE_CLEARANCE) {
                JsonObject args = new JsonObject();
                addPos(args, "at", at);
                String fill = goal.item != null ? goal.item : fillItem(body);
                if (fill == null) {
                    goal.pillarAt = null;
                    fail(slot, goal, "no_blocks_to_place", obstructionAt(level, at, goal, body));
                    return;
                }
                args.addProperty("item", fill);
                JsonObject r = DroneHands.botPlace(args, slot);
                DroneHands.echoAct(slot, r, "bot_place", at);
                if (r.has("ok") && !r.get("ok").getAsBoolean()) {
                    goal.pillarAt = null;
                    fail(slot, goal, r.get("reason").getAsString(), obstructionAt(level, at, goal, body));
                    return;
                }
                goal.placesLeft--;
                goal.ledger.placed(at, fill);
                goal.pillarPhase = PILLAR_LANDING;
                goal.pillarTicks = 0;
                return;
            }
            // Back on the ground without ever clearing the cell (bonked a ceiling the search missed):
            // concede this pillar rather than jump forever in place.
            if (body.onGround() && goal.pillarTicks > 2) {
                goal.pillarAt = null;
                fail(slot, goal, "pillar_blocked", obstructionAt(level, at, goal, body));
                return;
            }
            if (goal.pillarTicks > PILLAR_TIMEOUT) {
                goal.pillarAt = null;
                fail(slot, goal, "pillar_timeout", obstructionAt(level, at, goal, body));
            }
            return;
        }
        // LANDING: the block is placed; wait to come down on top of it, then re-path from up here.
        boolean landed = body.onGround() && goal.pillarTicks > 1;
        if (landed || goal.pillarTicks > PILLAR_TIMEOUT) {
            goal.pillarAt = null;
            goal.pillarPhase = 0;
            goal.ledger.traveledTo(body.blockPosition());
            navigate(slot, goal, body);
        }
    }

    /** Cheap fills a bridging/pillaring body should spend, in no particular order — the choice
     *  among them is by count. Valuables and functional blocks never qualify implicitly. */
    private static final java.util.Set<String> CHEAP_FILL = java.util.Set.of(
        "minecraft:cobblestone", "minecraft:cobbled_deepslate", "minecraft:dirt",
        "minecraft:netherrack", "minecraft:diorite", "minecraft:andesite", "minecraft:granite",
        "minecraft:tuff", "minecraft:stone", "minecraft:deepslate");

    /**
     * The block this body should place when the caller named none: the most plentiful cheap fill
     * it carries, else the most plentiful block of any kind, else null. "The solver may place"
     * implies the solver picks its own material — before this, an unnamed `item` fell back to the
     * HELD slot, and a mining body holds a pickaxe: every pillar/bridge repair failed
     * `held_item_not_a_block` (w2-79881, reported then as the terrain-shaped `not_placeable`)
     * while 60 cobblestone sat in the pack.
     */
    private static @Nullable String fillItem(final LivingEntity body) {
        Hands hands = Hands.of(body);
        if (hands == null) {
            return null;
        }
        net.minecraft.world.Container inv = hands.container();
        String bestCheap = null;
        int bestCheapCount = 0;
        String bestAny = null;
        int bestAnyCount = 0;
        for (int i = 0; i < inv.getContainerSize(); i++) {
            var st = inv.getItem(i);
            if (st.isEmpty() || !(st.getItem() instanceof net.minecraft.world.item.BlockItem)) {
                continue;
            }
            String id = net.minecraft.core.registries.BuiltInRegistries.ITEM
                .getKey(st.getItem()).toString();
            if (CHEAP_FILL.contains(id) && st.getCount() > bestCheapCount) {
                bestCheap = id;
                bestCheapCount = st.getCount();
            }
            if (st.getCount() > bestAnyCount) {
                bestAny = id;
                bestAnyCount = st.getCount();
            }
        }
        return bestCheap != null ? bestCheap : bestAny;
    }

    /**
     * The body as the search's physique: a Mob wraps with the profile's door rights overlaid
     * (§11.8b's dispatch); the player body IS its own {@link NavPhysique}.
     */
    private static NavPhysique physique(final LivingEntity body, final NavProfile profile) {
        if (body instanceof FakePlayerEntity player) {
            return player;
        }
        if (body instanceof Mob mob) {
            return MobPhysique.of(mob, profile.canOpenDoors());
        }
        throw new IllegalStateException("body " + body.getType() + " has no nav physique");
    }

    /**
     * The locus for a target that could not be REACHED rather than not be walked to: it is enclosed
     * (no face in hand reach has line of sight), or touchable positions exist but none is walkable.
     *
     * <p>This used to report nothing at all — `fail(..., null)` — so a stopped goal named a reason
     * and no place, and the caller's only move was to survey. It is also the one obstruction whose
     * remedy is not "mine the blocking cell": the blocking cell IS the target's own cover, and the
     * thing that changes the answer is the rights the goal was given. Say that.
     */
    private static JsonObject enclosedLocus(final LivingEntity body, final Goal goal,
                                            final String reason) {
        ServerLevel level = (ServerLevel) body.level();
        BlockPos at = goal.target.blockPos();
        JsonObject o = new JsonObject();
        o.addProperty("x", at.getX());
        o.addProperty("y", at.getY());
        o.addProperty("z", at.getZ());
        boolean enclosed = "occluded".equals(reason);
        o.addProperty("kind", enclosed ? "enclosed" : "no_walkable_touch_position");
        // NAMING THE BLOCK IS AN X-RAY WHEN THE TARGET IS ENCLOSED. `enclosed` means precisely that
        // no face of this cell has line of sight from hand reach — so no sightline fan can have hit
        // it, and its identity is not something the body knows. Reading level.getBlockState(at) here
        // laundered world truth into a refusal message. Live, 2026-08-10 (session w3-86528): the
        // agent dug blind, was refused at y72 with block "minecraft:stone", and answered "Found
        // stone!" — it discovered ore-grade information FROM A REFUSAL, having never seen the cell.
        // The remedy line below is the actionable half and stays; what is buried stays buried until
        // the body digs to it, which is the game. The other branch keeps the id: a target that has
        // touchable-but-unwalkable positions is one the body can see, it just cannot stand there.
        if (!enclosed) {
            o.addProperty("block", net.minecraft.core.registries.BuiltInRegistries.BLOCK
                .getKey(level.getBlockState(at).getBlock()).toString());
        }
        o.addProperty("remedy", "occluded".equals(reason)
            ? "the target has no exposed face within hand reach: re-run with may_modify "
                + "\"break\" (or \"both\") and this goal will mine its way in — that is the "
                + "goal-shaped way to dig down or tunnel to a buried block"
            : "positions that could touch the target exist but none is walkable from here: re-run "
                + "with may_modify \"break\"|\"both\" to open a route to one");
        return o;
    }

    /**
     * The obstruction-locus JSON for a specific cell, for a failure report. The cell may be a
     * PLANNED work cell blocks away from the body (firstPlannedStep scans the whole path) — when it
     * is, the report says so, because a bare far-away coordinate reads as "the wall next to me"
     * and sent w2-79881 mining at phantom obstructions 10 blocks behind its own position.
     */
    private static @Nullable JsonObject obstructionAt(final ServerLevel level, final BlockPos at,
                                                      final Goal goal, final @Nullable LivingEntity body) {
        // Describe THIS cell, the one that actually stopped the goal. This used to pass `at.below()`
        // into NavSolver.obstruction, which expects a FRONTIER and steps one more cell toward the
        // goal — so the block named in the failure was `at.below().relative(dir)`, neither the
        // offending cell nor its neighbour. The stop reason and the block it named routinely
        // contradicted each other (PERCEPTION_NAV_FIXES §3).
        JsonObject o = NavSolver.obstructionOf(level, at, goal.profile);
        if (o != null && body != null) {
            double d = Math.sqrt(body.blockPosition().distSqr(at));
            if (d > 4.5) {
                o.addProperty("at_planned_step", true);
                o.addProperty("body_distance", Math.round(d * 10.0) / 10.0);
            }
        }
        return o;
    }

    /**
     * The diagnostic for a tunnel whose WALK leg is the obstruction — the corridor is dug, the
     * cells are open, and obstructionAt therefore has no block to blame. What stopped the goal is
     * that the follower found no walkable route into the geometry just dug, and this says exactly
     * that, with the refused target as its locus (R4: an empty terminal verdict is impossible for
     * tunnels).
     */
    private static JsonObject walkRefusedDiag(final Tunnel t, final @Nullable BlockPos to,
                                              final @Nullable JsonObject completion) {
        JsonObject o = new JsonObject();
        o.addProperty("kind", "walk_refused");
        if (to != null) {
            addPos(o, "to", to);
        }
        o.addProperty("attempts", Math.max(1, Math.max(t.walkRefusals, t.stalls)));
        if (completion != null && completion.has("blocked_on")
                && completion.get("blocked_on").isJsonObject()) {
            o.add("blocked_on", completion.get("blocked_on").deepCopy());
        }
        o.addProperty("note", "the follower found no walkable route into the corridor just dug — "
            + "the dug geometry is not traversable from here");
        return o;
    }

    /** Drown-reflex preemptions on one goal before it concedes the route rather than oscillating. */
    private static final int MAX_DROWN_PREEMPTIONS = 3;

    /** The leap trigger gate's margin past the profile's max gap — mirrors NavDriver's. */
    private static final double LEAP_TRIGGER_MARGIN = 0.2;

    /**
     * Cross a gap by jumping to {@code landing}. A flyer body simply flies there (its own navigation
     * handles the arc); the walker leaps through its {@link com.mattmc.mcptoolkit.nav.NavDriver}
     * (launch impulse + held sprint/forward through the arc — the same actuation path-following
     * uses); any other grounded body gets the bare ballistic impulse.
     *
     * <p><b>The trigger gate applies here too.</b> The live-tuned launch carries ~maxJumpGap blocks;
     * fired from farther (the body stalled a cell or more before the edge) it undershoots into the
     * gap — the exact trench-fall NavDriver's gate was added for. Beyond the gate this walks toward
     * the landing first (as work approach, so its completion re-enters the repair decision); the
     * next round — or the walker driver's own gated self-leap en route — takes the jump from the
     * edge.
     */
    private static void actuateJump(final DroneTools.Slot slot, final Goal goal, final LivingEntity body,
                                    final BlockPos landing) {
        goal.navigated = true;
        net.minecraft.world.phys.Vec3 to = net.minecraft.world.phys.Vec3.atBottomCenterOf(landing);
        body.lookAt(net.minecraft.commands.arguments.EntityAnchorArgument.Anchor.EYES, to);
        if (body instanceof FakePlayerEntity) {
            // The player's leap is REAL physics and needs its run-up (§11.8's two live findings) —
            // navigate to the landing and let the driver's own gated self-leap take it from the
            // lip; a bare impulse from repair range undershoots into exactly the gap it planned over.
            JsonObject args = new JsonObject();
            addPos(args, "to", landing);
            goal.profile.writeArgs(args); // every leg walks under the GOAL's rights, not DEFAULT
            JsonObject r = DroneTools.startNav(args, slot, null);
            if (r.get("started").getAsBoolean()) {
                goal.workNav = landing; // approach to work — completion re-enters the repair decision
                goal.waiting = r.get("action_id").getAsString();
            }
            return;
        }
        if (body instanceof DroneEntity) {
            // A flyer doesn't jump — it flies the same arc; delegate to its own navigation.
            JsonObject args = new JsonObject();
            addPos(args, "to", landing);
            goal.profile.writeArgs(args); // every leg walks under the GOAL's rights, not DEFAULT
            JsonObject r = DroneTools.startNav(args, slot, null);
            if (r.get("started").getAsBoolean()) {
                goal.waiting = r.get("action_id").getAsString();
            }
            return;
        }
        double flat = Math.hypot(to.x - body.getX(), to.z - body.getZ());
        if (flat > goal.profile.maxJumpGap() + LEAP_TRIGGER_MARGIN) {
            JsonObject args = new JsonObject();
            addPos(args, "to", landing);
            goal.profile.writeArgs(args); // every leg walks under the GOAL's rights, not DEFAULT
            JsonObject r = DroneTools.startNav(args, slot, null);
            if (r.get("started").getAsBoolean()) {
                goal.workNav = landing; // approach to work, not goal travel — completion re-repairs
                goal.waiting = r.get("action_id").getAsString();
                return;
            }
            // Could not even walk toward the edge: fall through and let the leap try — bounded by
            // MAX_REPAIRS, and an undershoot is disclosed by the missing ledger entry.
        }
        if (body instanceof WalkerEntity walker) {
            walker.walkerNavigation().leapTo(landing);
            didWork(goal); // an actuated leap is real work — not a stagnant round, and not confusion
            return;
        }
        // Possessed grounded body: a bare ballistic leap. Horizontal speed sized to cover the span
        // during the ~10-tick hop, plus vanilla jump velocity up. The landing is verified by the
        // tick watch before it is ledgered (leapVerify).
        net.minecraft.world.phys.Vec3 delta = to.subtract(body.position());
        double speed = Math.min(0.68, 0.15 * Math.max(1.0, flat)); // ~sprint-jump horizontal (matches NavDriver)
        net.minecraft.world.phys.Vec3 dir = flat < 1.0e-6 ? net.minecraft.world.phys.Vec3.ZERO
            : new net.minecraft.world.phys.Vec3(delta.x / flat, 0, delta.z / flat);
        body.setDeltaMovement(dir.x * speed, 0.42, dir.z * speed);
        body.hurtMarked = true; // force the velocity to sync to clients so the leap renders
        goal.leapVerify = landing;
        goal.leapVerifyTicks = 0;
        didWork(goal); // an actuated leap is real work — not a stagnant round, and not confusion
    }

    // ---- sub-action completion ----------------------------------------------

    /**
     * Fold the walker driver's SELF-initiated leaps into the ledger. Path-following leaps happen
     * inside the navigation (the driver sees a planned JUMP waypoint and takes it) — without this
     * drain the body would jump gaps and the ledger would not say so, a silent world-interaction.
     * Repair-actuated leaps are logged at their actuation site instead and are not in this list.
     */
    private static void drainLeaps(final DroneTools.Slot slot, final Goal goal) {
        LivingEntity body = slot.activeBody();
        if (body != null) {
            for (BlockPos at : Bodies.nav(body).drainSelfLeaps()) {
                goal.ledger.jumped(at);
            }
        }
    }

    /** A nav or dig this goal was waiting on finished. */
    static void onActionDone(final DroneTools.Slot slot, final String actionId, final JsonObject data) {
        Goal goal = slot.goal;
        if (goal == null || !actionId.equals(goal.waiting)) {
            return;
        }
        try {
            onActionDoneInner(slot, goal, data);
        } catch (Exception e) {
            if (slot.goal == goal) {
                fail(slot, goal, e.getMessage() == null ? e.toString() : e.getMessage(), null);
            }
        }
    }

    private static void onActionDoneInner(final DroneTools.Slot slot, final Goal goal,
                                          final JsonObject data) {
        goal.waiting = null;
        drainLeaps(slot, goal);

        if (goal.repairingAt != null) {
            goal.ledger.mined(goal.repairingAt, minedBlock(data));
            goal.repairingAt = null;
            return; // next tick re-navigates through the hole
        }

        // A tunnel leg (dig or walk) finished. Mostly nothing to interpret: the state machine
        // re-derives everything from where the body now stands, which is the point of making it
        // position-driven rather than step-counted. The ONE verdict read here: a walk leg that
        // could not set off at all. That solve is deterministic over an unchanged world, so
        // re-entering the state machine until the stall budget ran out was a 2-tick event-stream
        // flood ending in a verdict that blamed nothing (w1_42257 g-49/g-50, ~23 identical pairs).
        // One retry — a dig completes one tick before the walk is issued and block-update settling
        // has burned us before — then the tunnel ends honestly, naming the refused walk.
        if (goal.tunnel != null) {
            Tunnel t = goal.tunnel;
            LivingEntity tbody = slot.activeBody();
            if (tbody != null) {
                goal.ledger.traveledTo(tbody.blockPosition());
                goal.ledger.stepCompleted();
            }
            if ("did_not_start".equals(data.has("outcome") && !data.get("outcome").isJsonNull()
                    ? data.get("outcome").getAsString() : "")) {
                if (++t.walkRefusals > 1) {
                    fail(slot, goal, "walk_refused", walkRefusedDiag(t, t.lastWalkTo, data));
                }
            } else {
                t.walkRefusals = 0;
            }
            return;
        }

        // An approach to planned work finished (arrived OR stopped short) — either way this was
        // never goal travel: re-enter the repair decision from wherever the body now stands.
        if (goal.workNav != null && "bot_goto".equals(
                data.has("action") && !data.get("action").isJsonNull()
                    ? data.get("action").getAsString() : "")) {
            goal.workNav = null;
            LivingEntity body = slot.activeBody();
            if (body == null) {
                fail(slot, goal, "no_body", null);
                return;
            }
            goal.ledger.traveledTo(body.blockPosition());
            repair(slot, goal, body, "work_approach");
            return;
        }

        String action = data.has("action") && !data.get("action").isJsonNull()
            ? data.get("action").getAsString() : "";
        if ("bot_goto".equals(action)) {
            // THE DROWNING LOOP. The leg reports which reflex preempted it; if that keeps being the
            // drown net, this route goes through water the body cannot survive crossing, and
            // re-issuing it is how the body dies with the safety net "working" the whole time.
            if (data.has("last_preempted_by") && !data.get("last_preempted_by").isJsonNull()
                && "drown".equals(data.get("last_preempted_by").getAsString())
                && ++goal.drownPreemptions >= MAX_DROWN_PREEMPTIONS) {
                LivingEntity drowning = slot.activeBody();
                fail(slot, goal, "drowning_route", drowning == null ? null
                    : NavSolver.obstruction((ServerLevel) drowning.level(), drowning.blockPosition(),
                        goal.target.blockPos(), goal.profile));
                return;
            }
            boolean arrived = data.has("arrived") && data.get("arrived").getAsBoolean();
            goal.ledger.traveledTo(new BlockPos((int) Math.floor(posOf(data, "x")),
                (int) Math.floor(posOf(data, "y")), (int) Math.floor(posOf(data, "z"))));
            if ("attack".equals(goal.action)) {
                // An approach leg ended (arrived or short, either is fine): tickAttack re-decides
                // from wherever the body now stands — swing if in reach, another leg if not. A
                // WEDGED end is counted: it is the beeline-into-a-ledge signature the verdict
                // must disclose (w1_42257 H1/H2).
                String legOutcome = data.has("outcome") && !data.get("outcome").isJsonNull()
                    ? data.get("outcome").getAsString() : "";
                if ("stalled".equals(legOutcome) || "nav_timeout".equals(legOutcome)) {
                    goal.stalledLegs++;
                }
                return;
            }
            if (arrived) {
                goal.ledger.stepCompleted();
                if ("move".equals(goal.action)) {
                    completeMove(slot, goal, true); // arriving IS the whole goal — one vocabulary
                } else {
                    goal.readyToAct = true; // next tick re-checks touch (F2), then attempts the act
                }
                return;
            }
            LivingEntity body = slot.activeBody();
            if (body == null) {
                fail(slot, goal, "no_body", null);
                return;
            }
            if ("vantage".equals(goal.action)) {
                // A stopped-short vantage leg does not mine its way to a viewpoint — but the body
                // may already SEE the target from where it stalled; let the act decide, else the
                // next candidate is tried.
                goal.readyToAct = true;
                return;
            }
            // Carry the leg's REAL outcome into the repair, not a fixed "stopped_short". A leg that
            // never moved fails as `did_not_start`, which is the difference between "ran out of path
            // here" and "could not set off at all" — and the repair loop's own stagnation guard is
            // the thing that then ends it, rather than the budget draining one node timeout at a
            // time (PERCEPTION_NAV_FIXES §2.3: most of the 328 zero-travel completions were these
            // repair legs).
            repair(slot, goal, body, data.has("outcome") && !data.get("outcome").isJsonNull()
                ? data.get("outcome").getAsString() : "stopped_short");
            return;
        }

        // The terminal dig completed: the goal's predicate now holds.
        if (data.has("mined") || "bot_mine".equals(action)) {
            goal.ledger.mined(goal.target.blockPos(), minedBlock(data));
        }
        goal.ledger.stepCompleted();
        complete(slot, goal);
    }

    /** A nav or dig this goal was waiting on failed outright. */
    static void onActionFailed(final DroneTools.Slot slot, final String actionId, final String reason) {
        Goal goal = slot.goal;
        if (goal == null || !actionId.equals(goal.waiting)) {
            return;
        }
        goal.waiting = null;
        drainLeaps(slot, goal); // leaps taken before the stop still happened — disclose them
        goal.workNav = null; // a failed approach re-enters repair below, same as any failed nav
        if ("superseded".equals(reason)) {
            return; // something else claimed the body; that path already reported itself
        }
        try {
            LivingEntity body = slot.activeBody();
            if (body != null && "attack".equals(goal.action)) {
                return; // a failed approach leg is not final — tickAttack re-decides (and bounds)
            }
            if (body != null && goal.tunnel != null) {
                // A tunnel leg failed. Not final either — but bounded: the state machine will try
                // the same cell again next tick, so an unfixable one has to run out of patience
                // rather than run forever. The terminal verdict is never empty: the failed dig's
                // cell, or the last walk target, is in the goal/tunnel state — describe it.
                BlockPos at = goal.repairingAt != null ? goal.repairingAt : goal.tunnel.lastWalkTo;
                goal.repairingAt = null;
                if (++goal.tunnel.stalls > MAX_REPAIRS) {
                    JsonObject o = at == null ? null
                        : obstructionAt((ServerLevel) body.level(), at, goal, body);
                    fail(slot, goal, reason,
                        o != null ? o : walkRefusedDiag(goal.tunnel, at, null));
                }
                return;
            }
            if (body != null && "vantage".equals(goal.action)) {
                goal.readyToAct = true; // try the sightline from here, else the next candidate
            } else if (body != null && goal.repairingAt == null) {
                repair(slot, goal, body, reason);
            } else {
                fail(slot, goal, reason, null);
            }
        } catch (Exception e) {
            if (slot.goal == goal) {
                fail(slot, goal, e.getMessage() == null ? e.toString() : e.getMessage(), null);
            }
        }
    }

    // ---- terminal ------------------------------------------------------------

    static void abort(final DroneTools.Slot slot, final String reason) {
        Goal goal = slot.goal;
        if (goal != null) {
            fail(slot, goal, reason, null);
        }
    }

    private static void complete(final DroneTools.Slot slot, final Goal goal) {
        emitComplete(slot, goal, "achieved", null);
    }

    /**
     * A move goal's ONE completion vocabulary: {@code achieved} (the body traveled into range) or
     * {@code already_there} (it was in range and did not move) — both carrying the do-not-reissue
     * note. Every move completion routes through here; a second word for "traveled and got there"
     * depending on which internal path noticed the arrival was a review-caught inconsistency, and
     * the un-noted variant re-invited the gap-course thrash the bench caught.
     */
    private static void completeMove(final DroneTools.Slot slot, final Goal goal, final boolean moved) {
        // The note used to end "do not re-issue", which read as a scolding for what was actually a
        // MISSING READ: with no cheap "am I there yet", a move goal was the only way to ask, and 58
        // of ~185 goals in w2-56123 were that question. There is a cheap read now — `at_goal` and
        // `distance_to_goal` ride every act reply — so the note can point at it instead of blaming.
        String where = goal.reachArrival ? "in hand reach of the goal"
            : "within " + MOVE_WITHIN + " blocks of the goal";
        emitComplete(slot, goal, moved ? "achieved" : "already_there",
            (moved ? "you are " + where : "you were already " + where + " — the body did not move")
                + ". Every act reply carries at_goal/distance_to_goal while a goal runs, so you "
                + "never have to spend a goal to ask where you are"
                + (goal.reachArrival ? "" : ". If a dig follows, re-issue with reach:true — 2.5 "
                    + "blocks around a corner is not hand reach"));
    }

    private static void emitComplete(final DroneTools.Slot slot, final Goal goal,
                                     final String outcome, final @Nullable String note) {
        drainLeaps(slot, goal); // a self-leap right before completion must still be disclosed
        slot.goal = null;
        if (slot.baseKind == DroneTools.BaseKind.GOAL) {
            slot.baseKind = DroneTools.BaseKind.IDLE;
        }
        JsonObject d = new JsonObject();
        d.addProperty("action_id", goal.actionId);
        d.addProperty("action", "bot_target");
        d.addProperty("goal", goal.action);
        d.addProperty("outcome", outcome);
        d.addProperty("repairs", goal.repairs);
        if ("attack".equals(goal.action)) {
            d.addProperty("hits", goal.hits);
            d.addProperty("stalled_legs", goal.stalledLegs);
            if (goal.shots > 0) {
                d.addProperty("shots", goal.shots);
            }
            // WHAT WAS MISSING, not just what went wrong (COMBAT_KIT_PLAN.md §4.6). An agent that
            // reads `target_unreachable` goes looking for a path; one that reads "unreachable, and
            // no bow or crossbow carried" goes looking for a bow.
            if (goal.why != null) {
                d.addProperty("why", goal.why);
            }
        }
        if (note != null) {
            d.addProperty("note", note);
        }
        stampEnd(goal, slot); // traveled_to is the BODY's final cell, not the last branch to write
        if (!goal.ledger.isEmpty()) {
            d.add("ledger", goal.ledger.describe(null, null));
        }
        DroneTools.stampEnvelope(d, slot.activeBody()); // embodied verdicts are datable (§4)
        EventLog.emit("action_completed", d, slot.target());
        if (goal.waiter != null) {
            goal.waiter.complete(d.deepCopy());
        }
    }

    private static void fail(final DroneTools.Slot slot, final Goal goal, final String reason,
                             final @Nullable JsonObject obstruction) {
        drainLeaps(slot, goal); // leaps that verifiably landed before the stop are still disclosed
        slot.goal = null;
        if (slot.baseKind == DroneTools.BaseKind.GOAL) {
            slot.baseKind = DroneTools.BaseKind.IDLE;
        }
        JsonObject d = new JsonObject();
        d.addProperty("action_id", goal.actionId);
        d.addProperty("action", "bot_target");
        d.addProperty("goal", goal.action);
        d.addProperty("outcome", "stopped");
        d.addProperty("reason", reason);
        d.addProperty("repairs", goal.repairs);
        // A budget stop is a RESUMPTION point, not a dead end — and the pre-flight cannot always
        // see it coming (a deep modify-heavy route exhausts the solver's node budget before the
        // plan shows its true size), so the mid-route stop carries the remedy too.
        if ("break_budget_spent".equals(reason) || "place_budget_spent".equals(reason)) {
            d.addProperty("note", "the route needs more than `budget` allowed (break: "
                + goal.profile.breakBudget() + ", place: " + goal.profile.placeBudget()
                + ") — the ledger below is work ALREADY DONE; re-issue the same goal with a larger"
                + " `budget` (max 256 each) and it resumes from here");
        }
        if ("attack".equals(goal.action)) {
            d.addProperty("hits", goal.hits);
            d.addProperty("stalled_legs", goal.stalledLegs);
            if (goal.shots > 0) {
                d.addProperty("shots", goal.shots);
            }
            // WHAT WAS MISSING, not just what went wrong (COMBAT_KIT_PLAN.md §4.6). An agent that
            // reads `target_unreachable` goes looking for a path; one that reads "unreachable, and
            // no bow or crossbow carried" goes looking for a bow.
            if (goal.why != null) {
                d.addProperty("why", goal.why);
            }
        }
        if (obstruction != null) {
            d.add("obstruction", obstruction);
        }
        // The ledger is the point: what it DID still stands, so the next attempt resumes rather
        // than re-surveying.
        stampEnd(goal, slot); // where the body IS, not where some branch last said it was
        d.add("ledger", goal.ledger.describe(reason, obstruction));
        DroneTools.stampEnvelope(d, slot.activeBody()); // embodied verdicts are datable (§4)
        EventLog.emit("action_failed", d, slot.target());
        if (goal.waiter != null) {
            goal.waiter.complete(d.deepCopy());
        }
    }

    static @Nullable JsonObject describe(final DroneTools.Slot slot) {
        Goal goal = slot.goal;
        if (goal == null) {
            return null;
        }
        JsonObject o = new JsonObject();
        o.addProperty("action_id", goal.actionId);
        o.addProperty("goal", goal.action);
        o.addProperty("target", goal.target.describe());
        o.addProperty("repairs", goal.repairs);
        return o;
    }

    /**
     * Stamp the ledger's final position from the body, at the one moment it is unambiguous: the
     * terminal event. Both terminal paths call it, so there is no branch left that can leave
     * {@code traveled_to} holding an intermediate coordinate (see {@link Ledger#endedAt}). A goal
     * that ends with no body leaves the running record alone rather than inventing a cell.
     */
    private static void stampEnd(final Goal goal, final DroneTools.Slot slot) {
        LivingEntity body = slot.activeBody();
        if (body != null) {
            goal.ledger.endedAt(body.blockPosition());
        }
    }

    private static void addPos(final JsonObject o, final String key, final BlockPos pos) {
        JsonObject p = new JsonObject();
        p.addProperty("x", pos.getX());
        p.addProperty("y", pos.getY());
        p.addProperty("z", pos.getZ());
        o.add(key, p);
    }

    /** The block a dig completion actually broke: bot_mine reports it as `mined`, some paths as `block`. */
    private static String minedBlock(final JsonObject data) {
        for (String key : new String[] { "mined", "block" }) {
            if (data.has(key) && !data.get(key).isJsonNull()) {
                return data.get(key).getAsString();
            }
        }
        return "unknown";
    }

    private static double posOf(final JsonObject data, final String axis) {
        if (data.has("pos") && data.get("pos").isJsonObject()) {
            JsonObject p = data.getAsJsonObject("pos");
            if (p.has(axis)) {
                return p.get(axis).getAsDouble();
            }
        }
        return 0.0;
    }
}
