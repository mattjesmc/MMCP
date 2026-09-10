package com.mattmc.mcptoolkit.drone;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.BlockTools;
import com.mattmc.mcptoolkit.EventLog;
import com.mattmc.mcptoolkit.ExecutionContext;
import com.mattmc.mcptoolkit.McpTools;
import com.mattmc.mcptoolkit.Mechanism;
import com.mattmc.mcptoolkit.Schemas;
import com.mattmc.mcptoolkit.ToolDef;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.MoverType;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.entity.projectile.Projectile;
import net.minecraft.world.entity.projectile.ProjectileDeflection;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

/**
 * The reflex loadout: a per-session set of armed trigger→response bindings that the server evaluates
 * every tick and fires without a round-trip to the agent — the reactive layer beneath deliberation
 * (PLAYER_CONTROL_DESIGN.md §2–§3). The agent arms a loadout with {@code bot_reactions}; code runs it.
 *
 * <p><b>Interrupt over a base intent.</b> A reflex is not another base intent — it is a transient
 * interrupt <em>above</em> whatever base intent ({@link DroneTools.BaseKind} GOTO/RUN/FOLLOW/…) is
 * driving the body. When a trigger fires the arbiter <b>suspends</b> the base (stops the body's
 * navigation), <b>runs</b> the response, then
 * <b>resumes</b> the base (re-issues the paused flight via {@link DroneTools#renav}). While a reaction
 * owns the body, {@code DroneTools.tickWatch} skips all base servicing. An explicit agent command wins:
 * {@link DroneTools#claimBase} calls {@link #cancel} so a new base intent abandons an in-flight reaction.
 *
 * <p><b>Honest, legible, no arithmetic in the model.</b> Triggers are computed server-side from world
 * facts (health, later projectiles/threats/effects) — the agent states a threshold, never does the
 * math. Responses reuse the exact hand-tool bodies ({@link DroneHands#botAttack}), so a reaction's act
 * gets the same reach checks, durability write-back, and {@code action_completed}/{@code action_failed}
 * events as a hand-issued one; the reaction itself brackets those with {@code reaction_fired} /
 * {@code reaction_done} so the override is never a silent takeover.
 *
 * <p>Slice 1 (this file's first cut): one trigger kind ({@code health_below}) and one response op
 * ({@code attack}). Same-tick collisions resolve by {@code priority}; a fired reaction respects its
 * {@code cooldown_ticks}; one reaction runs at a time. All state is server-thread only.
 */
public final class Reflexes {

    private Reflexes() {}

    /** Trigger kinds understood so far (server-observable facts only). {@code hazard} binds the whole
     *  danger-sense vocabulary ({@link Hazards#CAUSES}) — see {@link #evalTrigger}. */
    private static final java.util.Set<String> TRIGGER_KINDS =
        java.util.Set.of("health_below", "projectile_incoming", "threats_nearby", "air_below", "hazard",
            "block_near");
    /** {@code block_near} radius: default and hard cap. Deliberately tiny — see {@link #blockNear}. */
    private static final int BLOCK_NEAR_DEFAULT = 3;
    private static final int BLOCK_NEAR_MAX = 5;
    /** Response ops understood so far: attack/eat/drink reuse tool bodies; backstep/strafe are
     *  routing-free direct movement (the multi-tick dodge/disengage primitives — no navigation, so
     *  they never contend for the pathfinder while the base's flight is paused); deflect is a native
     *  combat move that reverses an incoming projectile; surface swims UP out of water. */
    private static final java.util.Set<String> RESPONSE_OPS =
        java.util.Set.of("attack", "shoot", "backstep", "strafe", "deflect", "eat", "drink", "shield",
            "flee", "surface");
    /** Default air threshold for `air_below`, in ticks of breath (300 = 15s; 150 = half gone). */
    private static final int AIR_BELOW_DEFAULT = 150;
    /** How long a `surface` response may hold its ascent before conceding (5s of swimming up). */
    private static final int SURFACE_TICKS_MAX = 100;
    /** How far up the entry scan looks for real air before calling the pocket sealed. */
    private static final int SURFACE_SCAN_MAX = 24;
    /** A flyer has no jump input, so its ascent is a direct nudge (blocks per tick). */
    private static final double SURFACE_RISE = 0.15;
    /** Default sense radius for threats_nearby and the flee centroid. */
    private static final double THREAT_RANGE_DEFAULT = 8.0;
    /** Upward bias of a flee (a flyer breaks contact by gaining altitude — the cheap vantage). */
    private static final double FLEE_ASCEND = 0.8;
    /** Default flee duration and speed (longer/faster than a dodge — it's a full disengage). */
    private static final int FLEE_TICKS_DEFAULT = 20;
    private static final double FLEE_SPEED_DEFAULT = 0.6;
    /**
     * F3: ground-body flee candidate headings, degrees off the away vector, most-away first — the
     * preference order IS this order, and {@link #pickFleeHeading} takes the first that fits, so
     * later entries are strictly last resorts.
     *
     * <p>F3b widened this past ±90°. The original cap encoded "never toward the threat", which is
     * right whenever any other exit exists and fatal when none does: a body in a dead end with the
     * mob at the mouth found every candidate shut, reported `blocked`, and stood there until it
     * died (measured 2026-08-11, 5 runs of 5, in a 3-sided pen with the threat on the open side —
     * the audit's "flees into corners" defect, still live after F3). The last three offsets let it
     * squeeze past rather than wedge. They are attempted only after every away-ward heading has
     * failed, so ordinary flight is unchanged; 180 (straight through the threat) is the final
     * concession before conceding for real.
     */
    private static final double[] FLEE_OFFSETS = { 0, -45, 45, -90, 90, -135, 135, 180 };
    /** F3b: how far out the cover solver looks for a cell the threat cannot see. Kept short on
     *  purpose — cover is a reflex, not a journey, and the ring search widens quadratically. */
    private static final int COVER_RANGE = 12;
    /** Sentinel for {@code fleeChoice} meaning "this leg is running to cover, not to a compass
     *  offset". Deliberately outside FLEE_OFFSETS' index range so it can never index it. */
    private static final int COVER_CHOICE = 99;
    /** Threat centroid → eye height. The centroid is a position, and a sightline test wants eyes;
     *  1.5 is close enough for zombie/skeleton/spider and errs LOW, which errs toward calling a
     *  cell exposed (the safe direction for a cover test). */
    private static final double THREAT_EYE_APPROX = 1.5;
    /** F3's rolling wall-press detector: this many consecutive ticks moving less than the epsilon
     *  re-picks the heading (the old start-anchored probe missed a leg that walked two blocks and
     *  THEN ground a wall — exactly the corner-death signature). */
    private static final int FLEE_STUCK_TICKS = 4;
    /** Bodies without the widened input frame, still moved by {@code Entity.move} at the requested
     *  ~0.5 blocks per tick: a sixth of a step is unambiguously wedged. */
    private static final double FLEE_STUCK_EPSILON = 0.08;
    /** S5 (EVAL_AUDIT_V2.md §10 / V3_PLAN.md §2 F3): the same detector for a DRIVEN flee, re-derived
     *  from what a LEGAL frame actually displaces. Full input on stone ramps
     *  0 → 0.098 → 0.152 → 0.181 → 0.197 → … → 0.216 blocks per tick (0.21600002F is vanilla's own
     *  walk constant, {@code LivingEntity.getFrictionInfluencedSpeed}); the leading zero is the
     *  reflex tick writing a frame that only lands on the NEXT travel tick — the same offset
     *  {@link #MOVE_BLOCKED_PROBE_TICKS_INPUT} was widened for. 0.08 was calibrated against the old
     *  cheating speed: at 37% of a legal step, and 82% of the first accelerating one, it would have
     *  turned this detector into a false-positive generator re-picking headings that were working.
     *  0.04 sits under half that first tick and is still far above the ~0 a body pressed flat into
     *  a wall achieves. */
    private static final double FLEE_STUCK_EPSILON_INPUT = 0.04;
    /** Cells of drop past which a flee heading is rejected (~safe fall). */
    private static final int FLEE_SAFE_FALL = 3;
    /** F1: turn budget for a reflex attack's facing sweep (a 180° flip is 2 ticks at the driver's
     *  rate; the rest is margin for a dancing target). A circuit breaker, not a duration. */
    private static final int ATTACK_TURN_TICKS_MAX = 10;
    /** How far out a deflect scans for an incoming projectile to punch back. */
    private static final double DEFLECT_RANGE = 10.0;
    /** Default detection radius for the projectile_incoming trigger. */
    private static final double PROJECTILE_WITHIN_DEFAULT = 8.0;
    /** Default / clamp for a movement response's duration in ticks, and its blocks-per-tick speed. */
    private static final int MOVE_TICKS_DEFAULT = 10;
    private static final int MOVE_TICKS_MAX = 100;
    private static final double MOVE_SPEED_DEFAULT = 0.5;
    /** Vanilla walk gait (~4.317 m/s ÷ 20): the conversion from a configured blocks-per-tick dodge
     *  speed to an input fraction for bodies dodging through the widened input frame. */
    private static final double WALK_BLOCKS_PER_TICK = 0.216;
    /**
     * The response ops that need the LEGS — they steer the body directly, so a paused navigation
     * would fight them. Only these suspend the base intent. Everything else (attack, shoot, eat,
     * shield, deflect) is an OVERLAY act: it runs beside whatever the base is doing, because
     * stopping navigation for a hand swing is what starved every bot_goto in session w2-79881 —
     * suspend() ran nav.stop() for EVERY op, the tick watch runs after entities, so a reflex firing
     * on tick N deleted the movement input navigation had just written for tick N+1. A reflex loop
     * at 20 Hz meant the body never moved again until the loadout was cleared, while a skeleton
     * shot it dead in a corner.
     */
    private static final java.util.Set<String> LEG_OPS =
        java.util.Set.of("backstep", "strafe", "flee", "surface");
    /** Cooldown floor for un-specified leg ops: a movement reflex re-firing the very next tick
     *  never gives the base intent one full tick of legs back. Explicit 0 is still honored. */
    private static final int LEG_COOLDOWN_DEFAULT = 10;
    /** Failure damper: cap on the exponential re-fire spacing (2 seconds). */
    private static final int DAMPER_MAX_TICKS = 40;
    /** After this many leg-op ticks with almost no displacement, the move is declared blocked.
     *  Input-frame dodges get a longer window: the frame applies on the NEXT travel tick and the
     *  gait ramps from standstill, so 4 ticks of honest walking (~0.44 blocks) sits under the
     *  epsilon that a direct 0.5-blocks-per-tick move cleared trivially. */
    private static final int MOVE_BLOCKED_PROBE_TICKS = 4;
    private static final int MOVE_BLOCKED_PROBE_TICKS_INPUT = 7;
    private static final double MOVE_BLOCKED_EPSILON = 0.5;
    /** While a failure streak is coalesced, one reaction_repeating row per this many ticks. */
    private static final int STREAK_REPEAT_EVERY = 100;
    /** How often a starved navigation is announced (in preemptions, ~3s of tick-true firing). */
    private static final int NAV_STARVED_EVERY = 60;

    /** One armed reaction: an immutable trigger→response config plus a live cooldown counter. */
    static final class Reaction {
        final String id;
        final String triggerKind;
        final JsonObject trigger;   // raw trigger params (e.g. {kind, hearts})
        final JsonObject response;  // raw response spec  (e.g. {op, nearest|target})
        final int priority;
        final int cooldownTicks;
        int cooldownRemaining;      // ticks until it may fire again (0 = ready)
        /** Parsed ONCE at arm time for {@code block_near} (null for every other kind): re-parsing a
         *  spec inside a per-tick cube scan would be the expensive way to get the same answer. */
        final BlockTools.@Nullable Matcher blockMatcher;
        /**
         * Consecutive fires that FAILED the same way, and the reason they gave. A response whose
         * preconditions are absent — {@code eat} with no food, {@code shoot} with no bow — fails
         * instantly, leaves the trigger still true, and is re-picked next tick, forever. Every one of
         * those fires is honestly reported, which is precisely how the honesty drowns: 20 fires a
         * second of {@code reaction_fired}/{@code reaction_done{ok:false}}.
         *
         * <p>Live, session w1-85918: the charter's {@code heal} reaction (health_below 8 → eat) was
         * armed with an EMPTY inventory. It fired every tick through both deaths; the disarm that
         * finally stopped it reported dozens of fires, and the body_damaged rows that mattered were
         * buried inside 11KB event pages the agent then had to page through while dying.
         */
        int consecutiveFailures;
        @Nullable String lastFailureReason;
        /** Ticks until a suspended reaction re-arms itself; -1 when it is not suspended. */
        int suspendedFor = -1;
        /**
         * Failure damper (w2-79881): ANY identical consecutive failure — including the "transient"
         * reasons the suspension allowlist deliberately excludes — spaces the next fire out
         * exponentially (2, 4, 8, … {@link #DAMPER_MAX_TICKS} ticks). The dead band that motivated
         * it: a fight trigger true at 6 blocks whose attack response reaches 4.0 fired+failed
         * no_target 20 times a second for MINUTES, cycling the whole event ring. Damping never
         * disarms — the instant the mob steps into reach the swing lands and the damper resets —
         * so the suspension trade-off (a 30s outage mid-fight) is not re-litigated here.
         */
        int damperFails;
        @Nullable String damperReason;
        int nextFireIn;
        /** Streak coalescing for the event log — see {@link #emitDone}. */
        @Nullable String streakReason;
        int streakCount;
        long streakStartTick;
        long streakLastRepeatTick;
        /** Alternating default strafe side, so a dodge in a corner tries the other way next fire. */
        boolean lastStrafeLeft;

        Reaction(final String id, final String triggerKind, final JsonObject trigger,
                 final JsonObject response, final int priority, final int cooldownTicks,
                 final BlockTools.@Nullable Matcher blockMatcher) {
            this.id = id;
            this.triggerKind = triggerKind;
            this.trigger = trigger;
            this.response = response;
            this.priority = priority;
            this.cooldownTicks = cooldownTicks;
            this.blockMatcher = blockMatcher;
        }
    }

    /** The in-flight reaction interrupt: which reaction fired, what it preempted, and its progress. */
    static final class Active {
        final Reaction reaction;
        final DroneTools.BaseKind preempted; // the base intent suspended when it fired
        /** True only for {@link #LEG_OPS}: the reaction owns the body's movement. An overlay act
         *  (attack, shield, eat) advances here too but never suspends the base — Reflexes.tick
         *  returns false for it, so navigation keeps its legs. */
        final boolean claimsBody;
        int ticksLeft = -1;                  // remaining ticks for a multi-tick response (-1 = not started)
        @Nullable JsonObject lastResult;     // the response body's own verdict, surfaced on reaction_done
        /** Where a leg op started, and how many ticks it has run — the blocked-move probe. */
        @Nullable Vec3 moveStart;
        int ranTicks;
        /** The `surface` budget as granted at entry, so "finished on the first tick" is detectable
         *  — that is the difference between a rescue and a no-op reported as one. */
        int surfaceBudget;
        /** The in-flight HELD USE of a response that has one: an eat/drink's chew (~1.6s) or a
         *  shoot's draw (aim + 20 ticks). The reaction stays live until it completes, because both
         *  are real vanilla use-ticks — a body under fire pays the same eating time, and the same
         *  draw time, a player does. Null for every other op. */
        java.util.concurrent.@Nullable CompletableFuture<com.google.gson.JsonElement> pending;
        /** F3 flee state (ground bodies): the chosen candidate index into FLEE_OFFSETS, which
         *  candidates were already spent, the world-space heading held between re-picks, and the
         *  rolling wall-press detector's last position + stagnant-tick count. */
        int fleeChoice = -1;
        boolean @Nullable [] fleeTried;
        @Nullable Vec3 fleeDir;
        @Nullable Vec3 fleeLastPos;
        int fleeStuckTicks;
        /** F3b cover: the standable cell this leg is running to because the threat cannot SEE it,
         *  solved once per leg (never per tick — the ring search costs what Engage stationing does).
         *  `fleeCoverSpent` latches when cover was solved, so a wall-press re-pick falls through to
         *  the compass fan instead of re-solving the same unreachable cell every time. */
        @Nullable Vec3 fleeCover;
        boolean fleeCoverSpent;

        Active(final Reaction reaction, final DroneTools.BaseKind preempted, final boolean claimsBody) {
            this.reaction = reaction;
            this.preempted = preempted;
            this.claimsBody = claimsBody;
        }
    }

    /**
     * Which armed reactions cannot possibly act, right now, for want of an item. Asked at arm time
     * against the body's REAL inventory, using the same lookups the response ops themselves use — so
     * this cannot drift into a second, more optimistic opinion about what the body is carrying. A
     * body with no body yet answers empty: nothing is knowable, and inventing a warning there would
     * train the reader to ignore the field.
     */
    private static JsonArray uncoveredReactions(final DroneTools.Slot slot) {
        JsonArray out = new JsonArray();
        LivingEntity body = slot.activeBody();
        if (body == null) {
            return out;
        }
        net.minecraft.world.Container inv;
        try {
            inv = Actuator.require(slot).hands().container();
        } catch (RuntimeException e) {
            return out; // no hands to check against — silence beats a guess
        }
        for (Reaction rx : slot.reactions) {
            String op = rx.response.has("op") && !rx.response.get("op").isJsonNull()
                ? rx.response.get("op").getAsString() : "";
            String named = rx.response.has("item") && !rx.response.get("item").isJsonNull()
                ? rx.response.get("item").getAsString() : null;
            String why = switch (op) {
                case "eat" -> named != null
                    ? (DroneHands.findItemSlot(inv, named) < 0 ? "no " + named + " carried" : null)
                    : (DroneHands.bestPlainFoodSlot(inv) < 0 ? "nothing edible carried" : null);
                case "drink" -> named != null && DroneHands.findItemSlot(inv, named) < 0
                    ? "no " + named + " carried" : null;
                case "shoot" -> DroneHands.findItemSlot(inv, "minecraft:arrow") < 0
                    ? "no arrows carried" : null;
                // NOT "in the offhand" any more — the op fills the offhand itself now (step 4), so
                // the honest question is whether the body CARRIES anything that blocks. Asked
                // against the pack via the same component every other blocking check reads, and
                // deliberately NOT phrased as a remedy naming a tool: `bot_equip` is hidden by the
                // survival profile, and a refusal naming a verb the reader cannot see has now bitten
                // this project twice (COMBAT_KIT_PLAN.md §5).
                case "shield" -> CombatKit.carriesBlocker(body, Hands.of(body))
                    ? null : "nothing that blocks attacks carried";
                default -> null;
            };
            if (why != null) {
                out.add(rx.id + ": " + why);
            }
        }
        return out;
    }

    /**
     * Is there breathable air straight above the head? Walks the column from the eye cell upward:
     * the first cell that is neither fluid nor solid is the surface. A solid cell (one that would
     * stop a rising body) ends the walk with "no" — that is the enclosed pocket. Bounded by
     * {@link #SURFACE_SCAN_MAX} because a body cannot swim further than its budget anyway.
     */
    private static boolean surfaceAbove(final LivingEntity body) {
        net.minecraft.server.level.ServerLevel level = (net.minecraft.server.level.ServerLevel) body.level();
        net.minecraft.core.BlockPos.MutableBlockPos p =
            new net.minecraft.core.BlockPos.MutableBlockPos(
                net.minecraft.util.Mth.floor(body.getX()),
                net.minecraft.util.Mth.floor(body.getEyeY()),
                net.minecraft.util.Mth.floor(body.getZ()));
        for (int i = 0; i < SURFACE_SCAN_MAX; i++) {
            p.setY(p.getY() + 1);
            net.minecraft.world.level.block.state.BlockState st = level.getBlockState(p);
            if (!st.getFluidState().isEmpty()) {
                continue; // still inside the fluid column — keep looking up
            }
            // Air (or anything a body can rise through) here means the surface is reachable; a
            // solid ceiling means it is not, and nothing below will change that.
            return st.getCollisionShape(level, p).isEmpty();
        }
        return false;
    }

    /** Does this reaction's response op need the legs (and therefore the base suspended)? */
    private static boolean needsLegs(final Reaction r) {
        String op = r.response.has("op") && !r.response.get("op").isJsonNull()
            ? r.response.get("op").getAsString() : "";
        return LEG_OPS.contains(op);
    }

    // ---- tool registration ---------------------------------------------------

    /**
     * {@code bot_surface} — ask for, deliberately, what the drown net does involuntarily.
     *
     * <p>The op already existed; only the reflex could reach it. An agent that noticed it was in
     * water had no way to say "get me out" and could only poll {@code bot_status} while its breath
     * ran down (PERCEPTION_NAV_FIXES §2.2).
     *
     * <p><b>This verb is TERMINAL.</b> It goes through {@link DroneTools#claimBase}, so it cancels
     * the goal/queue/follow underneath it and nothing is resumed when it finishes — the body stays
     * at the surface, treading, until the agent says otherwise. That is the opposite of the reflex,
     * which is an INTERRUPT: the reflex preempts the base and resumes it, because the agent never
     * asked to stop. Asking to surface is usually the prelude to a different decision, and silently
     * resuming the route that put the body underwater would be exactly wrong.
     */
    private static JsonObject botSurface(final JsonObject a, final DroneTools.Slot slot) {
        LivingEntity body = slot.activeBody();
        if (body == null) {
            throw new IllegalStateException("your session has no body — spawn one with "
                + "bot_body {action:\"spawn\"} first");
        }
        JsonObject r = new JsonObject();
        boolean inWater = body.isEyeInFluid(net.minecraft.tags.FluidTags.WATER);
        boolean inLava = body.isEyeInFluid(net.minecraft.tags.FluidTags.LAVA);
        if (!inWater && !inLava) {
            // Answering "you were never under" as a rescue would let a run of ten read back as ten
            // rescues — the same honesty rule the reflex verdict already keeps.
            r.addProperty("ok", true);
            r.addProperty("reason", "already_clear");
            r.addProperty("moved", false);
            r.addProperty("air", body.getAirSupply());
            return r;
        }
        if (!surfaceAbove(body)) {
            r.addProperty("ok", false);
            r.addProperty("reason", "no_surface_reachable");
            r.addProperty("fluid", inLava ? "lava" : "water");
            r.addProperty("air", body.getAirSupply());
            r.addProperty("note", "the column above your head is solid to the ceiling — swimming up "
                + "cannot reach air. Mine upward (bot_target destroy/move with may_modify:\"break\"), "
                + "or move horizontally out of the pocket");
            return r;
        }
        int ticks = Math.max(1, Math.min(SURFACE_TICKS_MAX,
            a.has("ticks") && !a.get("ticks").isJsonNull() ? a.get("ticks").getAsInt() : SURFACE_TICKS_MAX));

        // An explicit command wins: cancel whatever was driving the body, so the completion resumes
        // nothing. cancel() inside claimBase also clears any in-flight reaction, including a `drown`
        // already working on this — one surfacing at a time.
        DroneTools.claimBase(slot, DroneTools.BaseKind.IDLE, "bot_surface");

        JsonObject response = new JsonObject();
        response.addProperty("op", "surface");
        response.addProperty("ticks", ticks);
        Reaction rx = new Reaction("bot_surface", "air_below", new JsonObject(), response, 100, 0, null);
        Active act = new Active(rx, DroneTools.BaseKind.IDLE, true);
        suspend(slot, body, rx);
        slot.active = act;
        emitFired(slot, rx, null, body);

        r.addProperty("ok", true);
        r.addProperty("started", true);
        r.addProperty("fluid", inLava ? "lava" : "water");
        r.addProperty("air", body.getAirSupply());
        r.addProperty("ticks", ticks);
        r.addProperty("note", "swimming up; the verdict arrives as a reaction_done event with "
            + "id bot_surface (ok:true surfaced, still_submerged if the budget ran out). The body "
            + "TREADS at the surface afterwards and nothing you were doing is resumed — it will sink "
            + "again if left there, so follow with a bot_goto onto solid ground");
        return r;
    }

    public static void register() {
        McpTools.register(ToolDef.of(
            "bot_surface",
            "GET YOUR HEAD OUT OF THE WATER (or lava) — swim straight up until the eye is clear. "
                + "Breath is 300 ticks and drowning is faster than a round trip, so the survival "
                + "reflex preset also does this automatically as `drown`; this is the DELIBERATE "
                + "form, for when you notice you are submerged and want out now. Answers immediately "
                + "with already_clear (you were not under), or no_surface_reachable when the column "
                + "overhead is solid — a flooded shaft, where swimming up cannot help and you must "
                + "mine upward or move sideways instead. Otherwise it starts and the verdict arrives "
                + "as a reaction_done event. This CANCELS whatever you were doing (goal, queue, "
                + "follow) and resumes nothing: the body treads at the surface, so send it to solid "
                + "ground afterwards or it will sink again.",
            Schemas.objectOpt(Schemas.object(
                "ticks", Schemas.integer("How long to keep swimming up before giving up (default and max "
                    + SURFACE_TICKS_MAX + ").")),
                "ticks"),
            ExecutionContext.SERVER,
            Mechanism.EMBODIED,
            (ctx, a) -> botSurface(a, DroneTools.slotFor(ctx.sessionId()))));

        McpTools.register(ToolDef.of(
            "bot_reactions",
            "Arm YOUR body's reflex loadout — trigger→response bindings the SERVER runs every tick, so "
                + "the body reacts within a tick instead of waiting on a round-trip. `action`: "
                + "arm|disarm|list|clear (default list). "
                + "arm takes `reactions`:[{id, trigger, response, priority?, cooldown_ticks?}] and "
                + "adds/replaces by id. A trigger is {kind, ...}: `health_below` {hearts} (fires while "
                + "health is under that many hearts), `projectile_incoming` {within} (fires while a "
                + "projectile within `within` blocks is closing on the body — arrows, fireballs), or "
                + "`threats_nearby` {within, count} (fires while >= `count` hostile mobs are within "
                + "`within` blocks — the surrounded signal), `air_below` {ticks} (fires while breath "
                + "is under `ticks` of the 300 a body starts with — 150 = half gone, ~7s left; the "
                + "DROWNING guard, and the one danger too fast for a round trip), or `hazard` {cause} "
                + "(fires while your danger sense reports that cause — the same air_low|in_lava|on_fire|"
                + "falling|suffocating|starving you receive as body_endangered events, plus food_low "
                + "(hunger under 10: the gentle tier, never urgent). THE STANDING "
                + "ORDERS: hazard/in_lava -> surface, hazard/food_low -> eat, hazard/suffocating -> "
                + "backstep. Lava kills in ~4s and hunger damage does not pause for your turn: reading "
                + "the event and then acting is already too late, which is what this trigger is for), "
                + "or `block_near` {block, within} (fires while a matching block — id or #tag — is "
                + "within `within` blocks of you, default 3, MAX 5: a CONTACT sense for what you are "
                + "about to break into, e.g. {block:\"minecraft:lava\", within:3} -> backstep while "
                + "mining. It is not a search: to be told about ore you SEE, use bot_watch). "
                + "A response is {op, ...}: `attack` "
                + "{nearest:true | target:<id>} (reuses bot_attack), `shoot` {nearest|target} (fire an arrow, no reach limit), `backstep`/`strafe`{ticks, speed, "
                + "side:left|right} (routing-free dodge/disengage), `flee` {ticks, speed, within} (break "
                + "away from the whole swarm — move off the threat centroid, gaining altitude for a flyer "
                + "so ground mobs can't follow: the fix for being surrounded), `deflect` (punch the "
                + "nearest incoming projectile back — reverses a fireball toward its shooter), `shield` "
                + "{ticks} (RAISE THE SHIELD — the body equips one from its own pack, so you never "
                + "have to; it blocks a ~90° arc in FRONT of the head and NOT for the first 5 ticks "
                + "of the raise, so pair it with `projectile_incoming` and never with a damage "
                + "trigger. Refuses `totem_preferred` when the body is hurt enough that the offhand "
                + "policy is holding a totem instead), `surface` {ticks} (swim UP "
                + "until the head is out of water — pair it with air_below and the body saves itself "
                + "from drowning; honest about failing: ok:false with still_submerged, or "
                + "no_surface_reachable when the column overhead is solid, which is the sealed-pocket "
                + "case where swimming up cannot work at all), or "
                + "`eat`/`drink` {item} (consume a food/potion — reuses bot_eat/bot_drink). "
                + "When a reaction fires it SUSPENDS whatever the body is doing (goto/"
                + "run/follow), runs the response, then RESUMES it — emitting reaction_fired then "
                + "reaction_done; an explicit bot_goto/bot_run/bot_follow cancels an in-flight reaction "
                + "(you win over your reflexes). `priority` breaks same-tick ties (higher wins); "
                + "`cooldown_ticks` is the minimum spacing between fires. One reaction runs at a time. "
                + "START WITH `preset`:\"survival\" — the standard 9 (drown, lava, lava_near, "
                + "unstick, eat, heal, guard, dodge, fight), correct by construction; add `reactions` in the "
                + "same call to override members by id or extend it. A reaction that fires and fails "
                + "the SAME way 3 times running (eat with no food) suspends itself and says so with "
                + "an urgent reaction_suspended rather than retrying 20x a second — fix the "
                + "precondition and arm it again. "
                + "disarm takes `id`; clear removes all; list reports the armed set with cooldowns "
                + "and any suspensions.",
            Schemas.objectOpt(Schemas.object(
                "action", Schemas.str("arm | disarm | list | clear (default list)."),
                "preset", Schemas.str("arm: a named standard loadout — \"survival\" arms the 8 "
                    + "reflexes a body needs to stay alive. Applied before `reactions`, so an entry "
                    + "with the same id overrides it."),
                "reactions", Schemas.array(Schemas.objectOpt(Schemas.object(
                    "id", Schemas.str("Unique reaction id (re-arming the same id replaces it)."),
                    "trigger", Schemas.objectOpt(Schemas.object(
                        "kind", Schemas.str("Trigger kind: health_below | projectile_incoming | threats_nearby | air_below | hazard | block_near."),
                        "hearts", Schemas.number("health_below: fire while health < this many hearts."),
                        "block", Schemas.str("block_near: BLOCK id or block #tag to react to (e.g. minecraft:lava; note #minecraft:lava is a FLUID tag, not a block one)."),
                        "within", Schemas.number("projectile_incoming/threats_nearby: detection radius (default 8). block_near: block radius (default 3, max 5)."),
                        "count", Schemas.integer("threats_nearby: fire while >= this many hostiles are within (default 1)."),
                        "ticks", Schemas.integer("air_below: fire while breath < this many ticks (of 300; default 150)."),
                        "cause", Schemas.str("hazard: which danger — air_low|in_lava|on_fire|falling|suffocating|starving.")),
                        "hearts", "within", "count", "ticks", "cause", "block"),
                    "response", Schemas.objectOpt(Schemas.object(
                        "op", Schemas.str("Response op: attack | shoot | backstep | strafe | flee | deflect | shield | surface | eat | drink."),
                        "nearest", Schemas.bool("attack/shoot: target the nearest (living in reach / hostile in range)."),
                        "target", Schemas.integer("attack/shoot: entity id to target (alternative to nearest)."),
                        "ticks", Schemas.integer("backstep/strafe/flee/surface: how many ticks to run (default 10; flee 20; surface 100)."),
                        "speed", Schemas.number("backstep/strafe/flee: blocks per tick (default 0.5; flee 0.6)."),
                        "side", Schemas.str("strafe: left|right (default right)."),
                        "within", Schemas.number("flee: swarm-sense radius for the centroid (default 8)."),
                        "item", Schemas.str("eat/drink: item id to consume (defaults to the held item).")),
                        "nearest", "target", "ticks", "speed", "side", "within", "item"),
                    "priority", Schemas.integer("Higher wins same-tick ties (default 0)."),
                    "cooldown_ticks", Schemas.integer("Min ticks between fires (default 0).")),
                    "priority", "cooldown_ticks")),
                "id", Schemas.str("Reaction id to disarm (action:disarm).")),
                "action", "preset", "reactions", "id"),
            ExecutionContext.SERVER,
            Mechanism.EMBODIED,
            (ctx, a) -> handle(ctx.serverOrThrow(), a, DroneTools.slotFor(ctx.sessionId()))));
    }

    // ---- the interrupt loop (server tick) ------------------------------------

    /**
     * Advance the slot's reflex layer one tick. Returns {@code true} when a reaction owns the body this
     * tick (the caller then skips all base servicing). Called from {@code DroneTools.tickWatch} before
     * the base intents, with the slot's active body (possessed mob or drone), which may be null.
     */
    static boolean tick(final DroneTools.Slot slot, final @Nullable LivingEntity body) {
        // Cooldowns count down in real ticks from when a reaction fired.
        for (Reaction r : slot.reactions) {
            if (r.cooldownRemaining > 0) {
                r.cooldownRemaining--;
            }
            if (r.nextFireIn > 0) {
                r.nextFireIn--; // the failure damper's spacing (recordOutcome)
            }
            // A suspended reaction serves its window, then re-arms and gets to try once more. It is
            // never retired for good: the world moves, and the food a `heal` was missing can be
            // picked up two minutes later — a reflex that stayed off would then be a silent
            // capability removal, which is the failure this layer exists to prevent.
            if (r.suspendedFor > 0 && --r.suspendedFor == 0) {
                r.suspendedFor = -1;
                r.consecutiveFailures = 0;
                r.lastFailureReason = null;
                JsonObject d = new JsonObject();
                d.addProperty("id", r.id);
                EventLog.emit("reaction_rearmed", d, slot.target());
            }
        }

        Active active = slot.active;
        if (active != null) {
            if (body == null || body.isRemoved()) {
                // The body vanished mid-reaction: end the interrupt honestly, let the base (if any) go.
                if (active.claimsBody) {
                    resume(slot, null);
                }
                slot.active = null;
                emitDone(slot, active, "body_lost");
                return false;
            }
            if (advance(slot, active, body)) {
                if (active.claimsBody) {
                    resume(slot, body);
                }
                slot.active = null;
                emitDone(slot, active, null);
                return false;
            }
            return active.claimsBody;
        }

        if (body == null || slot.reactions.isEmpty()) {
            return false;
        }

        Reaction fired = pick(slot, body);
        if (fired == null) {
            return false;
        }

        // FIRE. A LEG op suspends the base intent (it owns movement until it finishes); an overlay
        // op (attack, shoot, eat, shield, deflect) leaves the base — and its navigation inputs —
        // completely alone and just acts.
        boolean legs = needsLegs(fired);
        DroneTools.BaseKind preempted = legs ? slot.baseKind : DroneTools.BaseKind.IDLE;
        // Causality marker, at FIRE time and independent of leg-claiming: an overlay attack that
        // consumes a running queue's target never suspends the queue, but it is still why the
        // queue's next step fails — after_reaction must name it (live-caught: the marker used to
        // live inside emitFired gated on preempted==RUN, which the overlay split made unreachable).
        if (slot.baseKind == DroneTools.BaseKind.RUN) {
            slot.queueInterruptedBy = fired.id;
        }
        if (legs) {
            suspend(slot, body, fired);
        }
        fired.cooldownRemaining = fired.cooldownTicks;
        Active act = new Active(fired, preempted, legs);
        slot.active = act;
        emitFired(slot, fired, legs ? preempted : null, body);
        if (advance(slot, act, body)) {
            if (legs) {
                resume(slot, body);
            }
            slot.active = null;
            emitDone(slot, act, null);
            return false;
        }
        return legs;
    }

    /** The highest-priority ready reaction whose trigger holds, or null. */
    private static @Nullable Reaction pick(final DroneTools.Slot slot, final LivingEntity body) {
        Reaction best = null;
        for (Reaction r : slot.reactions) {
            if (r.cooldownRemaining > 0 || r.suspendedFor > 0 || r.nextFireIn > 0) {
                continue;
            }
            if (unarmed(slot, r, body)) {
                continue;
            }
            if (evalTrigger(slot, r, body) && (best == null || r.priority > best.priority)) {
                best = r;
            }
        }
        return best;
    }

    /**
     * <b>A reaction that cannot possibly act is not a candidate.</b> Otherwise it WINS the tick on
     * priority, refuses in the same breath, burns its cooldown, and the reaction that could have
     * helped never runs — the arbiter picked the loudest, not the useful one.
     *
     * <p>Deliberately narrow: {@code shield} only. The survival preset now arms a {@code guard} ABOVE
     * {@code dodge} on the same {@code projectile_incoming} trigger, because a body carrying a shield
     * should block rather than sidestep — and most bodies carry no shield, so without this the new
     * reaction would have silently taken the dodge away from every one of them. The general rule
     * ("skip any uncovered op") is the right one and {@link #uncoveredReactions} already computes
     * it, but applying it to eat/drink/shoot as well would move behaviour four probe files pin; that
     * is a change to make deliberately, with its own battery, not as a side effect of the shield.
     */
    private static boolean unarmed(final DroneTools.Slot slot, final Reaction r,
                                   final LivingEntity body) {
        String op = r.response.has("op") && !r.response.get("op").isJsonNull()
            ? r.response.get("op").getAsString() : "";
        if (!"shield".equals(op)) {
            return false;
        }
        try {
            return !CombatKit.carriesBlocker(body, Actuator.require(slot).hands());
        } catch (RuntimeException e) {
            return true; // no hands to carry one with
        }
    }

    /** Evaluate a trigger against live world facts (server-side; the model never does this arithmetic).
     *  In perceived mode (bot_profile), threat triggers read the belief store, not ground truth. */
    private static boolean evalTrigger(final DroneTools.Slot slot, final Reaction r, final LivingEntity body) {
        switch (r.triggerKind) {
            case "health_below" -> {
                double hearts = r.trigger.has("hearts") && !r.trigger.get("hearts").isJsonNull()
                    ? r.trigger.get("hearts").getAsDouble() : 0.0;
                return body.getHealth() < hearts * 2.0; // 1 heart = 2 health points
            }
            case "projectile_incoming" -> {
                double within = r.trigger.has("within") && !r.trigger.get("within").isJsonNull()
                    ? r.trigger.get("within").getAsDouble() : PROJECTILE_WITHIN_DEFAULT;
                return nearestIncomingProjectile((ServerLevel) body.level(), body, within) != null;
            }
            case "threats_nearby" -> {
                double within = r.trigger.has("within") && !r.trigger.get("within").isJsonNull()
                    ? r.trigger.get("within").getAsDouble() : THREAT_RANGE_DEFAULT;
                int count = r.trigger.has("count") && !r.trigger.get("count").isJsonNull()
                    ? r.trigger.get("count").getAsInt() : 1;
                int n = slot.perceivedMode
                    ? Perception.perceivedThreatsWithin(slot, body, within)
                    : countThreats((ServerLevel) body.level(), body, within);
                return n >= count;
            }
            case "air_below" -> {
                // Drowning is the danger a reflex layer is FOR: breath runs out in 15s, which is
                // faster than an agent turn, so the body has to save itself and report afterwards.
                // Bodies that breathe water never trip it.
                if (body.canBreatheUnderwater()) {
                    return false;
                }
                // AIR THAT IS REFILLING IS NOT AN EMERGENCY. Vanilla restores breath at 4/tick once
                // the head is clear, so a body that just climbed out sits under the threshold for
                // ~4 more seconds — and this trigger, reading the gauge alone, kept firing the whole
                // time. Each fire ran `surface`, which found the eye already clear and returned
                // ok:true on tick one without moving: ten "successful" rescues from nothing, which
                // is exactly what session w2-56123 reported and read to it as a reflex that no-ops
                // while claiming to work. The danger sense already draws this line
                // (Hazards.current's air_low is eye-in-water AND low); the fast layer now agrees.
                if (!body.isEyeInFluid(net.minecraft.tags.FluidTags.WATER)) {
                    return false;
                }
                int ticks = r.trigger.has("ticks") && !r.trigger.get("ticks").isJsonNull()
                    ? r.trigger.get("ticks").getAsInt() : AIR_BELOW_DEFAULT;
                return body.getAirSupply() < ticks;
            }
            case "hazard" -> {
                // The danger sense, bound. Reads the SAME live cause set that produced the
                // body_endangered event (DroneTools.tickWatch runs Hazards.tick first, so it is this
                // tick's truth) — one vocabulary for feeling a danger and for reacting to it, rather
                // than an event layer that can name in_lava and a reflex layer that cannot.
                String cause = r.trigger.has("cause") && !r.trigger.get("cause").isJsonNull()
                    ? r.trigger.get("cause").getAsString() : "";
                // `food_low` is the one bindable cause that is NOT a danger — it is the gentle tier
                // below `starving`, and it deliberately never emits body_endangered (an urgent lane
                // that carries "you might want a snack" stops being an urgent lane). It is still
                // worth a standing order, so the trigger reads the same latch the event does.
                if (Hazards.FOOD_LOW_CAUSE.equals(cause)) {
                    return slot.foodWarned;
                }
                return slot.hazards.contains(cause);
            }
            case "block_near" -> {
                return blockNear(body, r);
            }
            default -> {
                return false;
            }
        }
    }

    /**
     * The one WORLD trigger: is a matching block inside the body's contact neighbourhood?
     *
     * <p><b>Why this is a contact sense and not a search.</b> {@code hazard {cause:"in_lava"}} fires
     * when the body is ALREADY in lava, with roughly four seconds to live — the event's own remedy
     * text admits that reading it is already late. What was missing was the tick before: the lava
     * you are about to break into. So the radius is capped hard at {@link #BLOCK_NEAR_MAX} and
     * defaults to {@link #BLOCK_NEAR_DEFAULT} — this answers "what am I touching / about to touch",
     * which is proprioception, and it cannot answer "where is the diamond", which would be an X-ray
     * scan wearing a reflex's clothes. Prospecting has its own legal answer ({@code bot_watch}, which
     * only ever reports what a sightline actually hit).
     *
     * <p>Cost is a cube of {@code getBlockState} calls per armed reaction per tick — 343 at the
     * default radius, which is a chunk-section array read each and cheap; the cap keeps the worst
     * case (1331) bounded too.
     */
    private static boolean blockNear(final LivingEntity body, final Reaction r) {
        if (r.blockMatcher == null) {
            return false; // unparseable spec: refused at arm time, so this is belt-and-braces
        }
        int within = r.trigger.has("within") && !r.trigger.get("within").isJsonNull()
            ? r.trigger.get("within").getAsInt() : BLOCK_NEAR_DEFAULT;
        within = Math.max(1, Math.min(BLOCK_NEAR_MAX, within));
        ServerLevel level = (ServerLevel) body.level();
        net.minecraft.core.BlockPos at = body.blockPosition();
        net.minecraft.core.BlockPos.MutableBlockPos cur = new net.minecraft.core.BlockPos.MutableBlockPos();
        for (int dx = -within; dx <= within; dx++) {
            for (int dy = -within; dy <= within; dy++) {
                for (int dz = -within; dz <= within; dz++) {
                    cur.set(at.getX() + dx, at.getY() + dy, at.getZ() + dz);
                    if (!level.isLoaded(cur)) {
                        continue; // never read through an unloaded boundary
                    }
                    if (r.blockMatcher.prefilter(level.getBlockState(cur))
                        && r.blockMatcher.test(level, cur)) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    /** Living hostiles (the {@link Enemy} marker) within {@code within} blocks. Server-computed.
     *  A real SPHERE: the inflated box alone admits a corner mob at ~within·√3 (10.4 blocks for the
     *  preset's 6), which is how the w2-79881 fight trigger stayed true against a skeleton its
     *  attack response could never reach — the box is only the coarse candidate scan. */
    private static java.util.List<Entity> threats(final ServerLevel level, final LivingEntity body, final double within) {
        AABB box = body.getBoundingBox().inflate(within);
        return level.getEntities(body, box,
            x -> x instanceof Enemy && x.isAlive() && body.distanceTo(x) <= within);
    }

    private static int countThreats(final ServerLevel level, final LivingEntity body, final double within) {
        return threats(level, body, within).size();
    }

    /** The average position of nearby hostiles (the centre of the swarm to flee), or null if none. */
    private static @Nullable Vec3 threatCentroid(final ServerLevel level, final LivingEntity body, final double within) {
        Vec3 sum = Vec3.ZERO;
        int n = 0;
        for (Entity e : threats(level, body, within)) {
            sum = sum.add(e.position());
            n++;
        }
        return n == 0 ? null : sum.scale(1.0 / n);
    }

    /**
     * The nearest live projectile within {@code within} blocks that is CLOSING on the body (its velocity
     * points toward the body). Server-computed — the agent never inspects the entity list. The body's
     * own facing is not required here (that FOV gate is the deferred player-legal profile, not core).
     */
    private static @Nullable Projectile nearestIncomingProjectile(final ServerLevel level, final LivingEntity body,
                                                                  final double within) {
        AABB box = body.getBoundingBox().inflate(within);
        Vec3 eye = body.getEyePosition();
        Projectile best = null;
        double bestD = Double.MAX_VALUE;
        for (Entity e : level.getEntities(body, box, x -> x instanceof Projectile && x.isAlive())) {
            if (body.distanceTo(e) > within) {
                continue; // the inflated box admits corners past `within` — sphere-gate it
            }
            Vec3 vel = e.getDeltaMovement();
            if (vel.lengthSqr() < 1.0e-6) {
                continue; // stationary/settled — not incoming
            }
            if (eye.subtract(e.position()).dot(vel) <= 0) {
                continue; // heading away, not toward the body
            }
            double d = e.distanceToSqr(body);
            if (d < bestD) {
                bestD = d;
                best = (Projectile) e;
            }
        }
        return best;
    }

    /** Run one tick of the response; return true when it has finished (attack is instant). */
    private static boolean advance(final DroneTools.Slot slot, final Active act, final LivingEntity body) {
        // Action provenance (world-model DESIGN.md §13.3): every input frame this response writes
        // is the REFLEX's policy, not the nav driver's — cloning an unlabeled mixture teaches a
        // policy nobody wrote. Set before the drive, read by the sink, free when not recording.
        com.mattmc.mcptoolkit.wm.Wm.actor("reflex:" + act.reaction.id);
        String op = act.reaction.response.get("op").getAsString();
        switch (op) {
            case "attack" -> {
                // F1: the reflex swing waits on the SAME facing+LOS gate as every other swing. The
                // target is resolved here (nearestLiving is LOS-filtered now — no more picking a
                // zombie through a wall), the body turns toward it at the driver's gaze rate over
                // however many ticks it takes (the reaction owns the body meanwhile — a reflex
                // that spends 2-3 ticks turning before the swing is CORRECT), and only a READY
                // verdict calls the real hand body: reach-gated, durability written back, its own
                // action_completed on a hit. A refusal surfaces on reaction_done.
                JsonObject resp = act.reaction.response;
                net.minecraft.server.level.ServerLevel level =
                    (net.minecraft.server.level.ServerLevel) body.level();
                Entity target = resp.has("target") && !resp.get("target").isJsonNull()
                    ? level.getEntity(resp.get("target").getAsInt())
                    : DroneHands.nearestLiving(level, body);
                if (target == null || !target.isAlive()) {
                    JsonObject miss = new JsonObject();
                    miss.addProperty("ok", false);
                    miss.addProperty("reason", "no_target");
                    act.lastResult = miss;
                    return true;
                }
                if (act.ticksLeft < 0) {
                    act.ticksLeft = ATTACK_TURN_TICKS_MAX; // turn budget, not a duration
                }
                switch (AttackGate.gate(body, target, true)) {
                    case READY -> {
                        JsonObject arg = new JsonObject();
                        arg.addProperty("target", target.getId());
                        try {
                            act.lastResult = DroneHands.botAttack(arg, slot);
                        } catch (Exception e) {
                            JsonObject err = new JsonObject();
                            err.addProperty("ok", false);
                            err.addProperty("reason",
                                e.getMessage() == null ? e.toString() : e.getMessage());
                            act.lastResult = err;
                        }
                        return true;
                    }
                    case TURNING -> {
                        if (--act.ticksLeft <= 0) {
                            JsonObject err = new JsonObject();
                            err.addProperty("ok", false);
                            err.addProperty("reason", "facing_timeout");
                            act.lastResult = err;
                            return true;
                        }
                        return false; // still turning — the reaction keeps the body one more tick
                    }
                    case OCCLUDED -> {
                        JsonObject err = new JsonObject();
                        err.addProperty("ok", false);
                        err.addProperty("reason", "occluded");
                        act.lastResult = err;
                        return true;
                    }
                    default -> { // OUT_OF_REACH
                        JsonObject err = new JsonObject();
                        err.addProperty("ok", false);
                        err.addProperty("reason", "out_of_reach");
                        act.lastResult = err;
                        return true;
                    }
                }
            }
            case "backstep", "strafe" -> {
                // Routing-free direct movement: for `ticks` ticks, away from (backstep) or sideways
                // to (strafe) the body's facing. Never touches the navigation, so the paused base
                // flight is undisturbed and resumes cleanly when this finishes. Bodies with the
                // widened input frame dodge by INPUT (honest physics); the rest keep Entity.move.
                JsonObject resp = act.reaction.response;
                if (act.ticksLeft < 0) {
                    int t = resp.has("ticks") && !resp.get("ticks").isJsonNull()
                        ? resp.get("ticks").getAsInt() : MOVE_TICKS_DEFAULT;
                    act.ticksLeft = Math.max(1, Math.min(t, MOVE_TICKS_MAX));
                    act.moveStart = body.position();
                }
                double speed = resp.has("speed") && !resp.get("speed").isJsonNull()
                    ? resp.get("speed").getAsDouble() : MOVE_SPEED_DEFAULT;
                Vec3 view = body.getViewVector(1.0F);
                Vec3 horiz = new Vec3(view.x, 0, view.z);
                horiz = horiz.lengthSqr() < 1.0e-6 ? new Vec3(0, 0, 1) : horiz.normalize();
                Vec3 dir;
                boolean left = false;
                if ("strafe".equals(op)) {
                    // Side choice: an explicit `side` is obeyed; otherwise ALTERNATE per fire, and
                    // prefer a side whose next cell is actually enterable. The w2-79881 corner death
                    // was a dodge strafing the same way into the same wall for minutes — Entity.move
                    // clipped it to zero and nothing noticed.
                    if (resp.has("side") && !resp.get("side").isJsonNull()) {
                        left = "left".equalsIgnoreCase(resp.get("side").getAsString());
                    } else {
                        left = !act.reaction.lastStrafeLeft;
                        Vec3 leftDir = new Vec3(-horiz.z, 0, horiz.x).scale(-1);
                        Vec3 rightDir = new Vec3(-horiz.z, 0, horiz.x);
                        boolean leftOpen = sideOpen(body, leftDir);
                        boolean rightOpen = sideOpen(body, rightDir);
                        if (leftOpen != rightOpen) {
                            left = leftOpen; // one side is a wall — take the open one
                        }
                        act.reaction.lastStrafeLeft = left;
                    }
                    dir = new Vec3(-horiz.z, 0, horiz.x).scale(left ? -1 : 1); // perpendicular to facing
                } else {
                    dir = horiz.scale(-1); // backstep: opposite the facing
                }
                boolean inputDodge =
                    body instanceof com.mattmc.mcptoolkit.nav.NavBody nb0 && nb0.canStrafeInput();
                if (inputDodge && body instanceof com.mattmc.mcptoolkit.nav.NavBody nb) {
                    // Honest actuation (world-model DESIGN.md §9 Phase 3): the dodge is an input
                    // frame, not a velocity write, so it moves at what the engine grants a player —
                    // the old direct move at the 0.5 default was ~2.3× sprint speed, a dodge no
                    // client could perform (and reflex dodges "cheating physics" was the named
                    // Phase-3 debt). The configured blocks-per-tick maps onto input fraction
                    // against the ~0.216 b/t walk gait and clamps at full input.
                    float input = (float) Math.min(1.0, speed / WALK_BLOCKS_PER_TICK);
                    if ("strafe".equals(op)) {
                        // +xxa is strafe-left in the vanilla input frame (KeyboardInput.leftImpulse).
                        nb.driveMove(body.getYRot(), body.getXRot(), 0.0F, left ? input : -input,
                            false, false, false);
                    } else {
                        nb.driveMove(body.getYRot(), body.getXRot(), -input, 0.0F,
                            false, false, false);
                    }
                } else {
                    body.move(MoverType.SELF, dir.scale(speed));
                }
                act.ranTicks++;
                // The blocked-move probe: a leg op that has run its first ticks with almost no
                // displacement is pressed against something. Reporting ok:true for a move that did
                // not happen was the lie that let a cornered dodge repeat forever — and `blocked`
                // is in the suspension allowlist, so a hopelessly cornered dodge says so, once,
                // urgently, instead of eating every tick while arrows land.
                if (act.ranTicks >= (inputDodge ? MOVE_BLOCKED_PROBE_TICKS_INPUT
                        : MOVE_BLOCKED_PROBE_TICKS)
                    && body.position().distanceTo(act.moveStart) < MOVE_BLOCKED_EPSILON) {
                    JsonObject blocked = new JsonObject();
                    blocked.addProperty("ok", false);
                    blocked.addProperty("op", op);
                    blocked.addProperty("reason", "blocked");
                    act.lastResult = blocked;
                    return true;
                }
                if (--act.ticksLeft <= 0) {
                    JsonObject ok = new JsonObject();
                    ok.addProperty("ok", true);
                    ok.addProperty("op", op);
                    act.lastResult = ok;
                    return true;
                }
                return false;
            }
            case "flee" -> {
                // Break contact with the whole swarm: move away from the threat CENTROID (kite fails
                // when surrounded — backing from one walks into another), and for a flyer gain altitude
                // (ground mobs can't follow — the cheapest vantage). Routing-free, multi-tick.
                //
                // F3 (V3_PLAN.md §2): a GROUND body no longer runs the raw away vector into whatever
                // wall happens to stand there (the audited corner-death: full-health walker, one
                // zombie, dead in ~170 ticks against a boundary). It picks from candidate headings
                // [away, away±45°, away±90°] — most-away first, never toward the threat — scored by
                // the sideOpen probe (feet+head enterable) plus a no-drop-past-safe-fall check; and
                // when a heading wedges mid-leg (rolling wall-press detector) it RE-PICKS from the
                // remaining candidates instead of giving up. It gives up only when every candidate
                // is shut.
                //
                // S5 (audit of that rewrite): the heading choice was the fix, but the MOTION under it
                // was still the raw Entity.move the sibling dodge had already been taken off — so the
                // escape F3 bought was a physics cheat, performed by the imitation-legal body, in the
                // session whose whole point is that the expert's behaviour becomes the training data.
                // A ground body with the widened input frame now flees by INPUT (see below).
                JsonObject resp = act.reaction.response;
                if (act.ticksLeft < 0) {
                    int t = resp.has("ticks") && !resp.get("ticks").isJsonNull()
                        ? resp.get("ticks").getAsInt() : FLEE_TICKS_DEFAULT;
                    act.ticksLeft = Math.max(1, Math.min(t, MOVE_TICKS_MAX));
                    act.moveStart = body.position();
                    act.fleeTried = new boolean[FLEE_OFFSETS.length];
                    act.fleeChoice = -1;
                    act.fleeLastPos = body.position();
                    act.fleeStuckTicks = 0;
                    act.fleeCover = null;
                    act.fleeCoverSpent = false;
                }
                double speed = resp.has("speed") && !resp.get("speed").isJsonNull()
                    ? resp.get("speed").getAsDouble() : FLEE_SPEED_DEFAULT;
                double within = resp.has("within") && !resp.get("within").isJsonNull()
                    ? resp.get("within").getAsDouble() : THREAT_RANGE_DEFAULT;
                Vec3 centroid = slot.perceivedMode
                    ? Perception.perceivedThreatCentroid(slot, body, within)
                    : threatCentroid((ServerLevel) body.level(), body, within);
                Vec3 away;
                if (centroid != null) {
                    away = body.position().subtract(centroid);
                    away = new Vec3(away.x, 0, away.z);
                    away = away.lengthSqr() < 1.0e-6 ? body.getViewVector(1.0F).scale(-1) : away.normalize();
                } else {
                    away = body.getViewVector(1.0F).scale(-1); // no threats sensed — just back off
                    away = new Vec3(away.x, 0, away.z);
                    away = away.lengthSqr() < 1.0e-6 ? new Vec3(1, 0, 0) : away.normalize();
                }
                boolean ground = !(body instanceof DroneEntity);
                // Asked once, here: the actuation decides both how the body moves AND how much
                // per-tick displacement counts as wedged (S5 — the two must be derived together).
                boolean inputFlee = ground
                    && body instanceof com.mattmc.mcptoolkit.nav.NavBody nbf0 && nbf0.canStrafeInput();
                Vec3 dir;
                if (ground) {
                    // F3b: SEEK COVER BEFORE PICKING A COMPASS HEADING.
                    //
                    // The fan below runs from the away-vector and spans only ±90°, which encodes
                    // "never toward the threat". That is right in the open and wrong indoors: when
                    // the sole exit lies past the threat, no candidate covers it and the body wedges
                    // (live 2026-08-11: a 3-sided pen with the threat on the open side, stuck 5/5,
                    // reporting `blocked` from the concession below). It also cannot tell an alley
                    // from a field, because each candidate is judged by ONE cell of footing.
                    //
                    // Cover asks a different question — where can I stand that this thing cannot SEE
                    // — and answers it with the sightline machinery Vantage already owns, inverted.
                    // The result is a heading with a REASON, and it is free to point anywhere,
                    // including past the threat, which is what unwedges the pen.
                    //
                    // Solved once per leg and latched: the ring search costs what Engage stationing
                    // costs, and that is already too much to pay per tick.
                    if (act.fleeChoice < 0 && !act.fleeCoverSpent && centroid != null) {
                        act.fleeCoverSpent = true;
                        net.minecraft.core.BlockPos cov = Vantage.cover((ServerLevel) body.level(),
                            body, centroid.add(0, THREAT_EYE_APPROX, 0), COVER_RANGE);
                        if (cov != null) {
                            Vec3 toCover = new Vec3(cov.getX() + 0.5 - body.getX(), 0,
                                cov.getZ() + 0.5 - body.getZ());
                            // A cover cell directly underfoot is not a destination; fall through.
                            if (toCover.lengthSqr() > 1.0e-6) {
                                Vec3 headed = toCover.normalize();
                                // The motion guards still apply — cover that needs a step through a
                                // wall or off a cliff is not cover the body can take.
                                if (sideOpen(body, headed) && safeLanding(body, headed)) {
                                    act.fleeCover = new Vec3(cov.getX() + 0.5, cov.getY(), cov.getZ() + 0.5);
                                    act.fleeDir = headed;
                                    act.fleeChoice = COVER_CHOICE;
                                }
                            }
                        }
                    }
                    if (act.fleeChoice < 0) {
                        act.fleeChoice = pickFleeHeading(body, away, act.fleeTried);
                        if (act.fleeChoice < 0) {
                            JsonObject blocked = new JsonObject();
                            blocked.addProperty("ok", false);
                            blocked.addProperty("op", "flee");
                            blocked.addProperty("reason", "blocked");
                            act.lastResult = blocked;
                            return true; // every candidate shut — the honest concession
                        }
                        act.fleeDir = rotateY(away, FLEE_OFFSETS[act.fleeChoice]);
                    }
                    dir = act.fleeDir;
                } else {
                    // Flyers add a strong upward component (vantage by altitude).
                    dir = away.add(0, FLEE_ASCEND, 0).normalize();
                }
                if (inputFlee && body instanceof com.mattmc.mcptoolkit.nav.NavBody nbf) {
                    // Honest actuation, the same route the backstep/strafe sibling took in Phase 3
                    // (world-model DESIGN.md §9): the flee is an INPUT FRAME, so it moves at what the
                    // engine grants a player — the old direct move at the 0.6 default was 2.8× the
                    // walk gait and 2.1× SPRINT, an escape no client could perform. Two things ride
                    // along for free:
                    //  • the frame passes through the FakePlayerEntity.driveMove sink, so Wm.actionMove
                    //    records it — the recovery leg V3_PLAN §4.3 wants arrives WITH the action row
                    //    that caused it (displacement with no action row is worse than no data, it
                    //    reads as data);
                    //  • the body's own yaw/pitch are handed straight back, so the flee NEVER writes
                    //    gaze. The chosen world heading is decomposed into forward/strafe against the
                    //    CURRENT facing instead of snapping the body around: a retreat that keeps its
                    //    eyes on the threat, no flick to record, and nothing to fight F1's attack turn
                    //    over the shared gaze (the values written are the ones read this same tick).
                    float input = (float) Math.min(1.0, speed / WALK_BLOCKS_PER_TICK);
                    Vec3 face = body.getViewVector(1.0F);
                    Vec3 fwd = new Vec3(face.x, 0, face.z);
                    fwd = fwd.lengthSqr() < 1.0e-6 ? new Vec3(0, 0, 1) : fwd.normalize();
                    Vec3 leftDir = new Vec3(fwd.z, 0, -fwd.x); // +xxa is strafe-LEFT (KeyboardInput)
                    nbf.driveMove(body.getYRot(), body.getXRot(),
                        (float) dir.dot(fwd) * input, (float) dir.dot(leftDir) * input,
                        false, false, false);
                } else {
                    body.move(MoverType.SELF, dir.scale(speed)); // flyer / no widened input frame
                }
                act.ranTicks++;
                if (ground) {
                    // Rolling wall-press detector: stagnant ticks re-pick, they don't give up. The
                    // threshold follows the actuation — a driven flee steps at the walk gait, not at
                    // the old 0.5-per-tick write (S5).
                    double stuckEps = inputFlee ? FLEE_STUCK_EPSILON_INPUT : FLEE_STUCK_EPSILON;
                    if (body.position().distanceTo(act.fleeLastPos) < stuckEps) {
                        act.fleeStuckTicks++;
                    } else {
                        act.fleeStuckTicks = 0;
                    }
                    act.fleeLastPos = body.position();
                    if (act.fleeStuckTicks >= FLEE_STUCK_TICKS) {
                        act.fleeStuckTicks = 0;
                        act.fleeChoice = pickFleeHeading(body, away, act.fleeTried);
                        if (act.fleeChoice < 0) {
                            JsonObject blocked = new JsonObject();
                            blocked.addProperty("ok", false);
                            blocked.addProperty("op", "flee");
                            blocked.addProperty("reason", "blocked");
                            act.lastResult = blocked;
                            return true;
                        }
                        act.fleeDir = rotateY(away, FLEE_OFFSETS[act.fleeChoice]);
                    }
                } else if (act.ranTicks >= MOVE_BLOCKED_PROBE_TICKS
                    && body.position().distanceTo(act.moveStart) < MOVE_BLOCKED_EPSILON) {
                    JsonObject blocked = new JsonObject();
                    blocked.addProperty("ok", false);
                    blocked.addProperty("op", "flee");
                    blocked.addProperty("reason", "blocked");
                    act.lastResult = blocked;
                    return true;
                }
                if (--act.ticksLeft <= 0) {
                    JsonObject ok = new JsonObject();
                    ok.addProperty("ok", true);
                    ok.addProperty("op", "flee");
                    act.lastResult = ok;
                    return true;
                }
                return false;
            }
            case "surface" -> {
                // Get the head into air. A player rises in a fluid by HOLDING JUMP — the driver only
                // ever sets that flag for a leap, so a body that fell in had no way up and sank
                // (the first watched session drowned exactly here). Multi-tick and routing-free like
                // flee: it owns the body until the eye clears the fluid or the budget runs out.
                //
                // LAVA counts too (0.42.0). The op was water-only, which made it the answer to
                // air_low and to nothing else — yet lava is the faster killer (~4s) and floating out
                // is the same motion. A body in lava that "surfaced" by water's definition would have
                // reported ok:true while still burning to death.
                if (act.ticksLeft < 0) {
                    JsonObject resp = act.reaction.response;
                    int t = resp.has("ticks") && !resp.get("ticks").isJsonNull()
                        ? resp.get("ticks").getAsInt() : SURFACE_TICKS_MAX;
                    act.ticksLeft = Math.max(1, Math.min(t, SURFACE_TICKS_MAX));
                    act.surfaceBudget = act.ticksLeft;
                    // IS THERE A SURFACE AT ALL? An enclosed pocket — a flooded shaft with a solid
                    // ceiling, which is precisely where a mining body drowns — has no air above it,
                    // and holding jump into stone for five seconds is not a rescue, it is five
                    // seconds of dying while the protection reports it is working. Answer at entry,
                    // once, from the column overhead: this is the verdict that lets the suspension
                    // machinery see the failure and tell the agent its drown net is not covering it.
                    if (!surfaceAbove(body)) {
                        JsonObject blocked = new JsonObject();
                        blocked.addProperty("ok", false);
                        blocked.addProperty("op", "surface");
                        blocked.addProperty("reason", "no_surface_reachable");
                        blocked.addProperty("air", body.getAirSupply());
                        blocked.addProperty("note", "the column above your head is solid to the "
                            + "ceiling — swimming up cannot reach air. Mine upward, or move "
                            + "horizontally out of the pocket");
                        act.lastResult = blocked;
                        return true;
                    }
                }
                boolean inWater = body.isEyeInFluid(net.minecraft.tags.FluidTags.WATER);
                boolean inLava = body.isEyeInFluid(net.minecraft.tags.FluidTags.LAVA);
                boolean clear = !inWater && !inLava;
                if (clear || --act.ticksLeft <= 0) {
                    JsonObject done = new JsonObject();
                    // Honest either way: "I held jump for 5s and my head is still under" is a
                    // different outcome from "I surfaced", and the agent must be able to tell.
                    done.addProperty("ok", clear);
                    done.addProperty("op", "surface");
                    done.addProperty("air", body.getAirSupply());
                    // ...and "I surfaced" is a different outcome from "I was never under". A
                    // response that finds its goal already true reports the truth AND says it did
                    // nothing, so a run of ten cannot read back as ten rescues.
                    if (clear && act.ticksLeft >= act.surfaceBudget) {
                        done.addProperty("reason", "already_clear");
                        done.addProperty("moved", false);
                    }
                    if (!clear) {
                        done.addProperty("reason", "still_submerged");
                        done.addProperty("fluid", inLava ? "lava" : "water");
                    }
                    act.lastResult = done;
                    return true;
                }
                // Swim up — through the body's OWN swim actuation, not a hand-rolled half of it.
                //
                // This used to set the jump flag and zero the walk inputs, and a fake ServerPlayer
                // then held jump and went nowhere: rising in a fluid is driven by `yya`, the vertical
                // input Player.travel reads, and this never set it. So the drown reaction fired on
                // time, reported that it was rescuing the body, and the body drowned anyway — the
                // worst shape a safety net can take. Live-caught by probes/drown-net.test.mjs: air
                // 300 -> 104 with `reaction_fired` present and the head never leaving the water.
                //
                // NavBody.driveSwim is the definition that swimming navigation already uses and that
                // the swim probes already defend; there is no reason for a second one here.
                if (body instanceof DroneEntity) {
                    body.move(MoverType.SELF, new Vec3(0, SURFACE_RISE, 0)); // a flyer has no jump
                } else if (body instanceof com.mattmc.mcptoolkit.nav.NavBody nav) {
                    // Head up: the vertical input does the lifting, and looking where you are going
                    // is what makes it read as swimming for air rather than twitching.
                    nav.driveSwim(body.getYRot(), -45.0F, 0.0F, 1.0F, false);
                } else {
                    body.setJumping(true);
                    body.setSprinting(false);
                    body.zza = 0.0F;
                    body.xxa = 0.0F;
                    body.yya = 1.0F;
                }
                return false;
            }
            case "deflect" -> {
                // Punch the nearest incoming projectile back the way it came (reverses velocity, and
                // reassigns owner so a reflected fireball can strike its shooter). Instant.
                Projectile proj = nearestIncomingProjectile((ServerLevel) body.level(), body, DEFLECT_RANGE);
                JsonObject res = new JsonObject();
                if (proj == null) {
                    res.addProperty("ok", false);
                    res.addProperty("reason", "no_projectile");
                } else {
                    proj.deflect(ProjectileDeflection.REVERSE, body, null, true);
                    proj.setOwner(body);
                    res.addProperty("ok", true);
                    res.addProperty("deflected", proj.getId());
                }
                act.lastResult = res;
                return true;
            }
            case "shield" -> {
                // THE BODY NOW FILLS ITS OWN OFFHAND (COMBAT_KIT_PLAN.md §4.2, step 4). This op has
                // existed since 0.14.0 and had never blocked anything, because it refused with "no
                // shield in the offhand (bot_equip {offhand:…})" and NO PATH EVER CALLED bot_equip.
                // It reaches for the shield now, through the one offhand decision site.
                //
                // The hold is Shields.Guard's, not this reaction's: vanilla keeps ONE in-flight use
                // per entity, so a bow draw or a meal ends a block whether or not anyone notices,
                // and the old "re-raise whenever the hand looks empty" loop fought PlayerVerbs'
                // draw for the same hand forever. One owner of the raise, one clock, one teardown.
                if (act.ticksLeft < 0) {
                    JsonObject resp = act.reaction.response;
                    int t = resp.has("ticks") && !resp.get("ticks").isJsonNull()
                        ? resp.get("ticks").getAsInt() : MOVE_TICKS_DEFAULT;
                    JsonObject up = Shields.raise(slot, Math.max(1, Math.min(t, MOVE_TICKS_MAX)));
                    if (!up.has("ok") || !up.get("ok").getAsBoolean()) {
                        up.addProperty("op", "shield");
                        act.lastResult = up;
                        return true; // nothing to hold up — finish immediately, with the reason
                    }
                    act.ticksLeft = 1; // a live marker; the guard's own clock is the real one
                }
                if (slot.guard != null) {
                    return false; // still up — the guard's watch lowers it when the hold runs out
                }
                JsonObject ok = new JsonObject();
                ok.addProperty("ok", true);
                ok.addProperty("op", "shield");
                act.lastResult = ok;
                return true;
            }
            case "shoot" -> {
                // Multi-tick on a PLAYER body, like `eat`/`drink` below and for the same reason: a
                // shot is now a real draw (toolkit 0.73.0), so the reaction stays live until the
                // arrow leaves the bow. Before this it called botShoot synchronously and returned
                // true the same tick — which under a real draw would report "done" on the tick the
                // body STARTED aiming, hand the body straight back, and let the next thing to claim
                // it cancel the draw it had just announced. The drone's shot is still instant and
                // resolves through the same branch on its first tick.
                if (act.pending != null) {
                    if (act.pending.isDone()) {
                        com.google.gson.JsonElement done = act.pending.getNow(null);
                        act.lastResult = done instanceof JsonObject o ? o : new JsonObject();
                        return true;
                    }
                    if (act.ticksLeft > 0 && --act.ticksLeft == 0) {
                        PlayerVerbs.failUse(slot, "reflex_timeout");
                        com.google.gson.JsonElement done = act.pending.getNow(null);
                        act.lastResult = done instanceof JsonObject o ? o : new JsonObject();
                        return true;
                    }
                    return false;
                }
                JsonObject arg = new JsonObject();
                JsonObject resp = act.reaction.response;
                if (resp.has("target") && !resp.get("target").isJsonNull()) {
                    arg.add("target", resp.get("target"));
                } else {
                    arg.addProperty("nearest", true);
                }
                if (resp.has("draw_ticks") && !resp.get("draw_ticks").isJsonNull()) {
                    arg.add("draw_ticks", resp.get("draw_ticks"));
                }
                try {
                    java.util.concurrent.CompletableFuture<com.google.gson.JsonElement> fut =
                        new java.util.concurrent.CompletableFuture<>();
                    JsonObject r = DroneHands.botShoot(arg, slot, fut);
                    if (r.has("started") && r.get("started").getAsBoolean()) {
                        act.pending = fut;
                        // Over the draw's own bounds (aim timeout + draw), so the shot's honest
                        // failure is what the reaction reports, not this backstop.
                        act.ticksLeft = PlayerVerbs.AIM_TIMEOUT_TICKS + 60;
                        return false;
                    }
                    act.lastResult = r;
                } catch (Exception e) {
                    JsonObject err = new JsonObject();
                    err.addProperty("ok", false);
                    err.addProperty("reason", e.getMessage() == null ? e.toString() : e.getMessage());
                    act.lastResult = err;
                }
                return true;
            }
            case "eat", "drink" -> {
                // Multi-tick like `shield`: the player body eats for REAL (~32 vanilla use-ticks),
                // so the reaction stays live until the swallow lands — a body under fire pays the
                // same eating time a player does. The drone (and any refusal) resolves instantly.
                if (act.pending != null) {
                    if (act.pending.isDone()) {
                        com.google.gson.JsonElement done = act.pending.getNow(null);
                        act.lastResult = done instanceof JsonObject o ? o : new JsonObject();
                        return true;
                    }
                    if (act.ticksLeft > 0 && --act.ticksLeft == 0) {
                        PlayerVerbs.abortChew(slot, "reflex_timeout");
                        com.google.gson.JsonElement done = act.pending.getNow(null);
                        act.lastResult = done instanceof JsonObject o ? o : new JsonObject();
                        return true;
                    }
                    return false;
                }
                JsonObject arg = new JsonObject();
                JsonObject resp = act.reaction.response;
                if (resp.has("item") && !resp.get("item").isJsonNull()) {
                    arg.add("item", resp.get("item"));
                }
                try {
                    java.util.concurrent.CompletableFuture<com.google.gson.JsonElement> fut =
                        new java.util.concurrent.CompletableFuture<>();
                    JsonObject r = DroneHands.botConsume(arg, slot, "drink".equals(op), fut);
                    if (r.has("started") && r.get("started").getAsBoolean()) {
                        act.pending = fut;
                        act.ticksLeft = 100; // backstop over the chew's own 60-tick backstop
                        return false;
                    }
                    act.lastResult = r;
                } catch (Exception e) {
                    JsonObject err = new JsonObject();
                    err.addProperty("ok", false);
                    err.addProperty("reason", e.getMessage() == null ? e.toString() : e.getMessage());
                    act.lastResult = err;
                }
                return true;
            }
            default -> {
                JsonObject err = new JsonObject();
                err.addProperty("ok", false);
                err.addProperty("reason", "unknown_response_op");
                act.lastResult = err;
                return true;
            }
        }
    }

    /**
     * F3: the best untried flee candidate — the first offset (most-away order) whose next cell is
     * enterable ({@link #sideOpen}) AND whose footing does not drop past safe fall. Marks the
     * chosen candidate spent so a later re-pick moves on; candidates that merely FAIL the probes
     * stay unmarked (the world moves — they may open). -1 = every candidate is shut.
     */
    private static int pickFleeHeading(final LivingEntity body, final Vec3 away, final boolean[] tried) {
        for (int i = 0; i < FLEE_OFFSETS.length; i++) {
            if (tried[i]) {
                continue;
            }
            Vec3 dir = rotateY(away, FLEE_OFFSETS[i]);
            if (sideOpen(body, dir) && safeLanding(body, dir)) {
                tried[i] = true;
                return i;
            }
        }
        return -1;
    }

    /** Rotate a horizontal vector around Y by {@code degrees} (flee candidate fan). */
    private static Vec3 rotateY(final Vec3 v, final double degrees) {
        double rad = Math.toRadians(degrees);
        double cos = Math.cos(rad);
        double sin = Math.sin(rad);
        return new Vec3(v.x * cos - v.z * sin, 0, v.x * sin + v.z * cos);
    }

    /** Does the cell one block toward {@code dir} keep footing within safe fall (~{@value
     *  #FLEE_SAFE_FALL} blocks)? A flee that saves the body from zombies by running it off a cliff
     *  is not a rescue. Unloaded ⇒ false (never flee into the unknown). */
    private static boolean safeLanding(final LivingEntity body, final Vec3 dir) {
        net.minecraft.core.BlockPos at = net.minecraft.core.BlockPos.containing(
            body.position().add(dir.normalize()));
        ServerLevel level = (ServerLevel) body.level();
        for (int dy = 1; dy <= FLEE_SAFE_FALL + 1; dy++) {
            net.minecraft.core.BlockPos below = at.below(dy);
            if (!level.isLoaded(below)) {
                return false;
            }
            if (!level.getBlockState(below)
                .isPathfindable(net.minecraft.world.level.pathfinder.PathComputationType.LAND)) {
                return true; // solid footing within the fall budget
            }
        }
        return false;
    }

    /** Can the body enter the cell one block toward {@code dir}? (Feet + head pathfindable.) */
    private static boolean sideOpen(final LivingEntity body, final Vec3 dir) {
        net.minecraft.core.BlockPos at = net.minecraft.core.BlockPos.containing(
            body.position().add(dir.normalize()));
        ServerLevel level = (ServerLevel) body.level();
        if (!level.isLoaded(at)) {
            return false;
        }
        return level.getBlockState(at)
            .isPathfindable(net.minecraft.world.level.pathfinder.PathComputationType.LAND)
            && level.getBlockState(at.above())
            .isPathfindable(net.minecraft.world.level.pathfinder.PathComputationType.LAND);
    }

    // ---- suspend / resume ----------------------------------------------------

    private static void suspend(final DroneTools.Slot slot, final LivingEntity body,
                                final Reaction firing) {
        Bodies.nav(body).stop(); // the reflex owns movement now — LEG_OPS only, per tick()
        // Starvation is visible: a leg reflex preempting an outstanding flight is legitimate once
        // and pathological on repeat. Count it on the flight and say so periodically — the agent's
        // remedy (disarm the reflex, or move differently) needs the reflex NAMED, which is exactly
        // what the w2-79881 session had to reverse-engineer from a wall of reaction_fired rows.
        DroneTools.PendingNav p = slot.pendingNav;
        if (p != null && p.body == body) {
            p.preemptions++;
            p.lastPreemptedBy = firing.id;
            if (p.preemptions % NAV_STARVED_EVERY == 0) {
                JsonObject d = new JsonObject();
                d.addProperty("action_id", p.actionId);
                d.addProperty("by", p.lastPreemptedBy);
                d.addProperty("preemptions", p.preemptions);
                d.addProperty("note", "this navigation keeps being preempted by the named reflex — "
                    + "it is not traveling. Deal with the trigger (fight/flee deliberately), or "
                    + "bot_reactions {action:\"disarm\", id} if the reflex is misfiring");
                EventLog.emit("nav_starved", d, slot.target());
            }
        }
    }

    private static void resume(final DroneTools.Slot slot, final @Nullable LivingEntity body) {
        // Re-drive a paused flight (manual goto or a queue's goto step both track it as pendingNav);
        // follow/engage/idle re-path themselves next tick, so there is nothing to resume for them.
        // NOT while fight-mode combat holds the body: the combat watch owns movement and would be
        // fought over for a tick — combat's own end re-paths whatever survives it.
        if (slot.combatHoldsBody) {
            return;
        }
        DroneTools.PendingNav p = slot.pendingNav;
        if (body != null && p != null && p.body == body) {
            DroneTools.renav(p);
        }
    }

    /**
     * Drop any in-flight reaction — an explicit agent command won (agent intent &gt; reflex). Called from
     * {@link DroneTools#claimBase}. Does NOT re-drive the flight: the incoming base intent will.
     */
    static void cancel(final DroneTools.Slot slot) {
        Active active = slot.active;
        if (active != null) {
            // A cancelled shield hold must not keep blocking forever — only natural expiry used to
            // stopUsingItem, so a claimBase mid-block leaked a raised shield (live-review find).
            // The lowering itself now belongs to Shields, which owns the raise: a second place that
            // calls stopUsingItem is a second place that can forget to.
            String op = active.reaction.response.has("op")
                && !active.reaction.response.get("op").isJsonNull()
                ? active.reaction.response.get("op").getAsString() : "";
            if ("shield".equals(op)) {
                Shields.lower(slot, "superseded");
            }
            emitDone(slot, active, "superseded");
            slot.active = null;
        }
    }

    // ---- tool handler (arm/disarm/list/clear) --------------------------------

    private static JsonObject handle(final net.minecraft.server.MinecraftServer server,
                                     final JsonObject a, final DroneTools.Slot slot) {
        String action = a.has("action") && !a.get("action").isJsonNull()
            ? a.get("action").getAsString() : "list";
        JsonObject r = new JsonObject();
        switch (action) {
            case "arm" -> {
                boolean hasPreset = a.has("preset") && !a.get("preset").isJsonNull();
                if (!hasPreset && (!a.has("reactions") || !a.get("reactions").isJsonArray())) {
                    throw new IllegalArgumentException("arm needs `reactions`:[{id, trigger, "
                        + "response, ...}] or `preset`:\"survival\"");
                }
                JsonArray armed = new JsonArray();
                // The preset lands FIRST, so an explicit `reactions` array in the same call overrides
                // members by id and extends the set — "the standard loadout, plus/minus my changes"
                // is one call, and the caller never has to retype the parts they agree with.
                if (hasPreset) {
                    for (JsonElement el : preset(a.get("preset").getAsString())) {
                        Reaction rx = parse(server, el.getAsJsonObject());
                        slot.reactions.removeIf(existing -> existing.id.equals(rx.id));
                        slot.reactions.add(rx);
                        armed.add(rx.id);
                    }
                }
                if (a.has("reactions") && a.get("reactions").isJsonArray()) {
                    for (JsonElement el : a.getAsJsonArray("reactions")) {
                        if (!el.isJsonObject()) {
                            throw new IllegalArgumentException("each reaction must be an object");
                        }
                        Reaction rx = parse(server, el.getAsJsonObject());
                        boolean replaced = slot.reactions.removeIf(existing -> existing.id.equals(rx.id));
                        slot.reactions.add(rx);
                        if (!replaced || !hasPreset) {
                            armed.add(rx.id);
                        }
                    }
                }
                r.addProperty("action", "arm");
                r.add("armed", armed);
                r.addProperty("count", slot.reactions.size());
                // The loadout's own verdict on itself. A set with no combat response is the specific
                // hole that killed session w1-85918 twice: the charter's 8-reaction loadout was
                // retyped by hand and `fight` was dropped from all three arms, so `engage defend` —
                // which delegates ALL fighting to this layer — left a body that could not swing back
                // while a spider and then a skeleton killed it. Nothing said so; `armed:[7 ids]`
                // looks like success. It is the coverage, not the count, that the caller cares about.
                // ARM-TIME CAPABILITY HONESTY. `eat` and `heal` were armed for the whole of session
                // w2-56123 over an empty pantry: two safety nets that were not there, and the
                // session believed it was covered. This is the same shape as a reflex that reports
                // ok:true without moving — a protection that CANNOT fire is worse than a declined
                // one, because believing in it suppresses the decision to go arrange it. Warn, never
                // refuse: arming before looting is a perfectly good order to do things in.
                JsonArray uncovered = uncoveredReactions(slot);
                if (!uncovered.isEmpty()) {
                    r.add("uncovered", uncovered);
                    DroneHands.note(r, "ARMED BUT NOT COVERED — these reactions have no item to "
                        + "act with, so they will fire and fail: " + uncovered + ". Get the item, or "
                        + "treat that danger as unhandled");
                }
                if (slot.reactions.stream().noneMatch(Reflexes::isCombatResponse)) {
                    r.addProperty("no_combat_response", true);
                    DroneHands.note(r, "NONE of your armed reactions fights back (no attack/shoot/"
                        + "shield/flee response). With bot_body engage mode:\"defend\" the reflex "
                        + "layer IS your combat — a body armed like this takes hits without "
                        + "answering. Arm preset:\"survival\", or add {id:\"fight\", trigger:{kind:"
                        + "\"threats_nearby\", within:6}, response:{op:\"attack\", nearest:true}}");
                }
            }
            case "disarm" -> {
                if (!a.has("id") || a.get("id").isJsonNull()) {
                    throw new IllegalArgumentException("disarm needs `id`");
                }
                String id = a.get("id").getAsString();
                for (Reaction rx : slot.reactions) {
                    if (rx.id.equals(id)) {
                        flushStreak(slot, rx); // a coalesced tally must not die silently with its reaction
                    }
                }
                boolean removed = slot.reactions.removeIf(rx -> rx.id.equals(id));
                if (slot.active != null && slot.active.reaction.id.equals(id)) {
                    cancel(slot); // stop an in-flight instance of the disarmed reaction
                }
                r.addProperty("action", "disarm");
                r.addProperty("disarmed", removed);
                r.addProperty("count", slot.reactions.size());
            }
            case "clear" -> {
                int n = slot.reactions.size();
                for (Reaction rx : slot.reactions) {
                    flushStreak(slot, rx);
                }
                slot.reactions.clear();
                if (slot.active != null) {
                    cancel(slot);
                }
                r.addProperty("action", "clear");
                r.addProperty("cleared", n);
            }
            case "list" -> {
                r.addProperty("action", "list");
                JsonArray list = new JsonArray();
                for (Reaction rx : slot.reactions) {
                    JsonObject o = new JsonObject();
                    o.addProperty("id", rx.id);
                    o.addProperty("trigger", rx.triggerKind);
                    o.addProperty("response", rx.response.get("op").getAsString());
                    o.addProperty("priority", rx.priority);
                    o.addProperty("cooldown_ticks", rx.cooldownTicks);
                    if (rx.cooldownRemaining > 0) {
                        o.addProperty("cooldown_remaining", rx.cooldownRemaining);
                    }
                    // A suspended reaction is armed but NOT protecting you — `list` has to say so, or
                    // its presence in this array reads as coverage the body does not have.
                    if (rx.suspendedFor > 0) {
                        o.addProperty("suspended", true);
                        o.addProperty("suspended_reason", rx.lastFailureReason == null
                            ? "repeated failure" : rx.lastFailureReason);
                        o.addProperty("rearms_in_ticks", rx.suspendedFor);
                    }
                    list.add(o);
                }
                r.add("reactions", list);
                r.addProperty("count", slot.reactions.size());
                if (slot.active != null) {
                    r.addProperty("firing", slot.active.reaction.id);
                }
            }
            default -> throw new IllegalArgumentException(
                "unknown `action` '" + action + "' (arm|disarm|list|clear)");
        }
        return r;
    }

    /** Does this session's loadout answer an attacker at all? Asked by {@code bot_body engage}. */
    static boolean hasCombatResponse(final DroneTools.Slot slot) {
        return slot.reactions.stream().anyMatch(Reflexes::isCombatResponse);
    }

    /** Response ops that answer an attacker. Used only to notice a loadout that has none. */
    private static boolean isCombatResponse(final Reaction r) {
        String op = r.response.has("op") && !r.response.get("op").isJsonNull()
            ? r.response.get("op").getAsString() : "";
        return switch (op) {
            case "attack", "shoot", "shield", "flee", "deflect" -> true;
            default -> false;
        };
    }

    /**
     * A named standard loadout, resolved SERVER-SIDE.
     *
     * <p>The survival charter used to carry these eight as literal JSON under the instruction "copy
     * this loadout EXACTLY". That makes the body's entire automatic defence a transcription exercise
     * performed by a small model at low effort, once per spawn, with no check on the result — and in
     * session w1-85918 it was mis-transcribed identically all three times: `fight` silently absent,
     * so the body never once swung back, and both deaths were of a body whose combat was "on".
     *
     * <p>A loadout is a fact about how to survive here, not a fact about the agent's prompt. It
     * belongs where it can be named, versioned, and got right once. The charter's copy shrinks to
     * `bot_reactions {action:"arm", preset:"survival"}`, which cannot be got wrong, and the pieces
     * are still visible and overridable one id at a time.
     *
     * <p>NOTE the reflexes here are the ones too fast to answer by round trip: drowning (15s), lava
     * (~4s), an arrow already in flight. `falling` is deliberately absent — nothing helps in flight,
     * prevent it with check_path.
     */
    private static JsonArray preset(final String name) {
        if (!"survival".equals(name)) {
            throw new IllegalArgumentException("unknown preset '" + name + "' (survival)");
        }
        // EXPLICIT priorities, life-threat first. These used to be all 0, which made every same-tick
        // tie resolve by list insertion order — the "dodge outranks fight" the old comment asserted
        // was an accident of two adjacent add() calls, one reordering away from being false. Now
        // the ordering is a stated fact: lava (~4s to live) over drowning (15s) over the contact
        // hazards, dodge (an arrow in flight) over fight (a melee answer), sustenance last —
        // and every reaction states its cooldown instead of inheriting a surprising default.
        JsonArray out = new JsonArray();
        out.add(reaction("lava", hazard("in_lava"), response("surface", "ticks", 100), 100, 0));
        out.add(reaction("drown", trigger("air_below", "ticks", 150),
            response("surface", "ticks", 100), 90, 0));
        out.add(reaction("lava_near",
            blockNear("minecraft:lava", 3), response("backstep", "ticks", 5), 80, 10));
        out.add(reaction("unstick", hazard("suffocating"), response("backstep", "ticks", 5), 70, 10));
        // BLOCK BEFORE YOU DODGE, when there is anything to block with. Both hang off the same
        // trigger and `guard` outranks `dodge` on purpose: a raised shield takes ~90% of an arrow
        // inside its arc, while a sidestep against a tracking skeleton mostly does not. `pick` skips
        // a shield reaction on a body carrying no shield, so this cannot quietly steal the dodge
        // from the bodies that have no better option — which is most of them.
        //
        // The trigger is projectile_incoming and NOT damage, and that is the whole design: the
        // shield does not protect for the first 5 ticks of the raise (BlocksAttacks.blockDelay), so
        // a guard that goes up when the arrow LANDS blocks exactly nothing.
        out.add(reaction("guard", trigger("projectile_incoming", "within", 12),
            response("shield", "ticks", 30), 45, 10));
        out.add(reaction("dodge", trigger("projectile_incoming", "within", 12),
            response("strafe", "ticks", 14), 40, 20));
        out.add(reaction("fight", trigger("threats_nearby", "within", 6),
            responseAttackNearest(), 30, 10));
        out.add(reaction("heal", trigger("health_below", "hearts", 8), response("eat"), 20, 40));
        out.add(reaction("eat", hazard("starving"), response("eat"), 10, 40));
        return out;
    }

    private static JsonObject reaction(final String id, final JsonObject trigger, final JsonObject response) {
        JsonObject o = new JsonObject();
        o.addProperty("id", id);
        o.add("trigger", trigger);
        o.add("response", response);
        return o;
    }

    private static JsonObject reaction(final String id, final JsonObject trigger,
                                       final JsonObject response, final int priority,
                                       final int cooldownTicks) {
        JsonObject o = reaction(id, trigger, response);
        o.addProperty("priority", priority);
        o.addProperty("cooldown_ticks", cooldownTicks);
        return o;
    }

    private static JsonObject trigger(final String kind, final String key, final Number value) {
        JsonObject o = new JsonObject();
        o.addProperty("kind", kind);
        o.addProperty(key, value);
        return o;
    }

    private static JsonObject hazard(final String cause) {
        JsonObject o = new JsonObject();
        o.addProperty("kind", "hazard");
        o.addProperty("cause", cause);
        return o;
    }

    private static JsonObject blockNear(final String block, final int within) {
        JsonObject o = new JsonObject();
        o.addProperty("kind", "block_near");
        o.addProperty("block", block);
        o.addProperty("within", within);
        return o;
    }

    private static JsonObject response(final String op) {
        JsonObject o = new JsonObject();
        o.addProperty("op", op);
        return o;
    }

    private static JsonObject response(final String op, final String key, final Number value) {
        JsonObject o = response(op);
        o.addProperty(key, value);
        return o;
    }

    private static JsonObject responseAttackNearest() {
        JsonObject o = response("attack");
        o.addProperty("nearest", true);
        return o;
    }

    /** Parse and validate one reaction spec into an armed {@link Reaction}. */
    private static Reaction parse(final net.minecraft.server.MinecraftServer server,
                                  final JsonObject o) {
        String id = reqStr(o, "id");
        JsonObject trigger = reqObj(o, "trigger");
        String kind = reqStr(trigger, "kind");
        if (!TRIGGER_KINDS.contains(kind)) {
            throw new IllegalArgumentException("unknown trigger kind '" + kind + "' (" + TRIGGER_KINDS + ")");
        }
        if ("health_below".equals(kind) && (!trigger.has("hearts") || trigger.get("hearts").isJsonNull())) {
            throw new IllegalArgumentException("trigger health_below needs `hearts`");
        }
        if ("hazard".equals(kind)) {
            // A misspelled cause would arm a reaction that can never fire — a reflex that silently
            // does nothing is worse than no reflex, because the agent believes it is covered.
            String cause = trigger.has("cause") && !trigger.get("cause").isJsonNull()
                ? trigger.get("cause").getAsString() : "";
            if (!Hazards.CAUSES.contains(cause)) {
                throw new IllegalArgumentException("trigger hazard needs `cause`, one of "
                    + new java.util.TreeSet<>(Hazards.CAUSES)
                    + (cause.isEmpty() ? "" : " (got '" + cause + "')"));
            }
        }
        BlockTools.Matcher blockMatcher = null;
        if ("block_near".equals(kind)) {
            // Same rule as `hazard`'s cause check, same reason: a spec that cannot resolve arms a
            // reflex that can never fire, and the agent believes it is covered. Parsed here so a bad
            // id fails the ARM call, not silently every tick afterwards.
            String spec = trigger.has("block") && !trigger.get("block").isJsonNull()
                ? trigger.get("block").getAsString() : "";
            if (spec.isBlank()) {
                throw new IllegalArgumentException("trigger block_near needs `block` (a block id or "
                    + "block #tag, e.g. minecraft:lava or #minecraft:logs — note that #minecraft:lava is a "
                    + "FLUID tag and will not resolve here)");
            }
            blockMatcher = Watch.matcher(server, spec);
        }
        JsonObject response = reqObj(o, "response");
        String op = reqStr(response, "op");
        if (!RESPONSE_OPS.contains(op)) {
            throw new IllegalArgumentException("unknown response op '" + op + "' (" + RESPONSE_OPS + ")");
        }
        int priority = o.has("priority") && !o.get("priority").isJsonNull() ? o.get("priority").getAsInt() : 0;
        // Leg ops get a cooldown FLOOR when the caller says nothing: a movement reflex re-firing
        // the very next tick starves the base intent of its legs forever (the w2-79881 corner
        // death). An explicit cooldown_ticks — including 0 — is the caller's contract and stands.
        int cooldownDefault = LEG_OPS.contains(op) ? LEG_COOLDOWN_DEFAULT : 0;
        int cooldown = o.has("cooldown_ticks") && !o.get("cooldown_ticks").isJsonNull()
            ? Math.max(0, o.get("cooldown_ticks").getAsInt()) : cooldownDefault;
        return new Reaction(id, kind, trigger, response, priority, cooldown, blockMatcher);
    }

    private static String reqStr(final JsonObject o, final String key) {
        if (!o.has(key) || o.get(key).isJsonNull()) {
            throw new IllegalArgumentException("missing `" + key + "`");
        }
        return o.get(key).getAsString();
    }

    private static JsonObject reqObj(final JsonObject o, final String key) {
        if (!o.has(key) || !o.get(key).isJsonObject()) {
            throw new IllegalArgumentException("missing `" + key + "` object");
        }
        return o.getAsJsonObject(key);
    }

    // ---- events --------------------------------------------------------------

    private static void emitFired(final DroneTools.Slot slot, final Reaction r,
                                  final DroneTools.@Nullable BaseKind preempted,
                                  final LivingEntity body) {
        // (The after_reaction causality marker is stamped at the fire site in tick() — it must not
        // depend on `preempted`, which is null for overlay ops that never suspend the queue.)
        // Streak coalescing: while this reaction is inside an identical-failure streak, the fired
        // row is WITHHELD — emitDone re-emits it retroactively if this fire breaks the streak, so
        // nothing is lost, only the 20-a-second repetition. w2-79881 measured the alternative: a
        // fight reflex's fired/done pairs cycled the whole 1000-event ring in 25 seconds and the
        // body_damaged rows that mattered were evicted under them.
        if (r.streakReason != null) {
            return;
        }
        EventLog.emit("reaction_fired", firedRow(r, preempted), slot.target());
    }

    private static JsonObject firedRow(final Reaction r, final DroneTools.@Nullable BaseKind preempted) {
        JsonObject d = new JsonObject();
        d.addProperty("id", r.id);
        d.addProperty("response_op", r.response.get("op").getAsString());
        if (preempted != null) {
            // Overlay ops (attack, eat, shield) preempt nothing — the base keeps the legs — so the
            // field only appears when a LEG op genuinely suspended the base.
            d.addProperty("preempted", preempted.name().toLowerCase(java.util.Locale.ROOT));
        }
        return d;
    }

    private static void emitDone(final DroneTools.Slot slot, final Active act,
                                 final @Nullable String abortedReason) {
        Reaction r = act.reaction;
        JsonObject d = new JsonObject();
        d.addProperty("id", r.id);
        if (abortedReason != null) {
            d.addProperty("aborted", abortedReason);
        }
        if (act.lastResult != null) {
            // Surface the response body's own verdict (hit/miss/reason) — the reaction is honest about
            // whether its act actually landed, not just that it ran.
            JsonObject res = act.lastResult;
            if (res.has("ok")) {
                d.addProperty("ok", res.get("ok").getAsBoolean());
            }
            if (res.has("reason")) {
                d.addProperty("reason", res.get("reason").getAsString());
            }
            if (res.has("hit")) {
                d.addProperty("hit", res.get("hit").getAsBoolean());
            }
        }
        boolean failed = d.has("ok") && !d.get("ok").getAsBoolean() && abortedReason == null;
        String reason = failed && d.has("reason") ? d.get("reason").getAsString() : null;
        LivingEntity body = slot.activeBody();
        long now = body != null ? body.level().getGameTime()
            : r.streakLastRepeatTick + STREAK_REPEAT_EVERY;

        if (failed && reason != null && reason.equals(r.streakReason)) {
            // Same failure again: swallow the pair, keep the exact count, surface a compact
            // heartbeat at most once per STREAK_REPEAT_EVERY ticks.
            r.streakCount++;
            if (now - r.streakLastRepeatTick >= STREAK_REPEAT_EVERY) {
                r.streakLastRepeatTick = now;
                JsonObject rep = new JsonObject();
                rep.addProperty("id", r.id);
                rep.addProperty("reason", reason);
                rep.addProperty("count", r.streakCount);
                rep.addProperty("since_tick", r.streakStartTick);
                // URGENCY IS DECIDED HERE, BY THE DANGER SENSE — never by the reason string.
                //
                // A repeating reflex is usually the body COPING: `lava_near` backstepping off a lip
                // fired 130 times across three watched hours and none of them was an emergency. The
                // one that is an emergency looks identical from the outside and differs in exactly
                // one respect: the hazard the reflex exists to escape is STILL ON THE BODY while the
                // escape keeps failing. That is `Hazards.current`, which already draws this line for
                // body_endangered, so asking it keeps one definition of "in trouble" instead of two.
                //
                // Session w1-97535 drowned with `drown`/`no_surface_reachable` repeating 13 times in
                // a sealed pocket: the reflex layer was right, and the only place it said so was an
                // ordinary row behind a long blocking act. Marking this urgent puts it in the
                // get_events preview AND in the `danger` field that rides every tool result, which
                // is the one channel a body inside a goal call still sees.
                if (body != null) {
                    java.util.Set<String> live = Hazards.current(body);
                    if (!live.isEmpty()) {
                        rep.addProperty("urgent", true);
                        JsonArray hz = new JsonArray();
                        for (String h : live) {
                            hz.add(h);
                        }
                        rep.add("hazards", hz);
                    }
                }
                EventLog.emit("reaction_repeating", rep, slot.target());
            }
            recordOutcome(slot, act, d);
            return;
        }

        // The streak (if any) is over: flush its exact tally, then re-emit the withheld fired row
        // so this outcome still arrives as the fired/done pair the vocabulary promises.
        boolean hadStreak = flushStreak(slot, r);
        if (hadStreak) {
            EventLog.emit("reaction_fired", firedRow(r, act.claimsBody ? act.preempted : null),
                slot.target());
        }
        if (failed && reason != null) {
            r.streakReason = reason;
            r.streakCount = 1;
            r.streakStartTick = now;
            r.streakLastRepeatTick = now;
        }
        EventLog.emit("reaction_done", d, slot.target());
        recordOutcome(slot, act, d);
    }

    /** End a coalesced failure streak, reporting its exact count. True if one was in progress. */
    private static boolean flushStreak(final DroneTools.Slot slot, final Reaction r) {
        boolean had = r.streakReason != null;
        if (had && r.streakCount > 1) {
            JsonObject d = new JsonObject();
            d.addProperty("id", r.id);
            d.addProperty("reason", r.streakReason);
            d.addProperty("count", r.streakCount);
            d.addProperty("since_tick", r.streakStartTick);
            EventLog.emit("reaction_streak_ended", d, slot.target());
        }
        r.streakReason = null;
        r.streakCount = 0;
        return had;
    }

    /**
     * The refusal reasons that describe a STANDING condition the body owns — something absent from
     * its own inventory or hands, which will still be absent next tick and every tick after until
     * the agent does something about it. Only these can suspend a reaction.
     *
     * <p>An ALLOWLIST, not a denylist of transient reasons, and the difference is load-bearing: an
     * unrecognised reason must leave the reflex ARMED, because the cost of wrongly suspending a
     * defence is a dead body and the cost of wrongly keeping one is some noise. The first live run
     * of this code proved the point — a `fight` reflex failing {@code no_target} three times while
     * the mob was briefly out of range suspended itself for 30 seconds, which is precisely the
     * window a fight happens in. {@code no_target}, {@code out_of_reach}, {@code busy} and
     * {@code still_submerged} are facts about a world that changes every tick; they are not this.
     */
    private static final java.util.Set<String> STANDING_FAILURES = java.util.Set.of(
        "no_food",        // eat: nothing edible carried — the live w1-85918 heal-spam case
        "not_food",       // eat: the named item is not food
        "not_a_potion",   // drink: the named item carries no effects
        "item_missing",   // the named item is not in the inventory
        "empty_hand",     // no item selected to act with
        "held_item_not_a_block", // the held item is not a block
        "blocked",        // a movement op that produced no displacement: the wall is standing too.
                          // w2-79881: a cornered dodge strafed into the same wall for minutes,
                          // reporting ok:true each time — with the displacement probe it now fails
                          // `blocked`, and three of those in a row mean this dodge is NOT covering
                          // you (the reaction_suspended event says so, urgently, once)
        "unknown_response_op"); // an op this build cannot run at all

    /** Fires before a reaction is suspended: 3 identical failures in a row is a standing condition. */
    private static final int FAILURES_BEFORE_SUSPEND = 3;
    /** First suspension window (30s), doubled on each repeat, capped — see {@link #suspend}. */
    private static final int SUSPEND_TICKS_BASE = 600;
    private static final int SUSPEND_TICKS_MAX = 6000;

    /**
     * Score a completed reaction and suspend one that keeps failing the same way.
     *
     * <p>A reflex whose response cannot execute — {@code eat} with nothing edible, {@code shoot}
     * with no bow — fails in the same tick it fires, leaves its trigger true, and is re-picked on the
     * very next tick. Each fire is honestly reported, and that is exactly the problem: at 20 fires a
     * second the honest report becomes the noise that hides everything else. It is also not
     * information: after the second identical failure the third adds nothing a reader did not know.
     *
     * <p>So the layer says it ONCE, loudly, and stops: an urgent {@code reaction_suspended} naming
     * the id, the reason, and how to fix it. That is the honest description of the state the reflex
     * was already in — a response that cannot run is disarmed in every way that matters; before this,
     * the only thing hiding that was the volume of it.
     */
    private static void recordOutcome(final DroneTools.Slot slot, final Active act,
                                      final JsonObject done) {
        Reaction r = act.reaction;
        boolean failed = done.has("ok") && !done.get("ok").getAsBoolean();
        if (!failed) {
            r.consecutiveFailures = 0;
            r.lastFailureReason = null;
            r.damperFails = 0;
            r.damperReason = null;
            r.nextFireIn = 0;
            return;
        }
        String reason = done.has("reason") && !done.get("reason").isJsonNull()
            ? done.get("reason").getAsString() : "unspecified";
        // The failure damper: EVERY identical consecutive failure — transient or standing — spaces
        // the next fire exponentially (2, 4, … DAMPER_MAX_TICKS). This is the anti-spam the
        // suspension allowlist deliberately is not: it never takes a defence offline, it only stops
        // a fire-fail loop from running at tick rate. The moment the world changes (different
        // reason, or a success) the spacing resets to nothing.
        if (reason.equals(r.damperReason)) {
            r.damperFails = Math.min(r.damperFails + 1, 16);
        } else {
            r.damperReason = reason;
            r.damperFails = 1;
        }
        r.nextFireIn = Math.min(1 << Math.min(r.damperFails, 6), DAMPER_MAX_TICKS);
        // A failure the WORLD caused is not a reason to stop defending the body — see
        // STANDING_FAILURES. Such a fire still clears the streak: it is evidence the reaction is
        // live and being tried, not evidence it is hopeless.
        if (!STANDING_FAILURES.contains(reason)) {
            r.consecutiveFailures = 0;
            r.lastFailureReason = null;
            return;
        }
        // Only a REPEAT of the same failure counts. A reaction failing two different ways is a body
        // in a changing situation, not a standing impossibility.
        if (!reason.equals(r.lastFailureReason)) {
            r.lastFailureReason = reason;
            r.consecutiveFailures = 1;
            return;
        }
        if (++r.consecutiveFailures >= FAILURES_BEFORE_SUSPEND) {
            suspend(slot, r, reason);
        }
    }

    /** Suspend a hopeless reaction for a growing window and say so, urgently, once. */
    private static void suspend(final DroneTools.Slot slot, final Reaction r, final String reason) {
        int previous = r.suspendedFor == -1 ? 0 : r.suspendedFor;
        int window = Math.min(SUSPEND_TICKS_MAX,
            previous > 0 ? previous * 2 : SUSPEND_TICKS_BASE);
        r.suspendedFor = window;
        r.consecutiveFailures = 0;
        JsonObject d = new JsonObject();
        d.addProperty("id", r.id);
        d.addProperty("response_op", r.response.get("op").getAsString());
        d.addProperty("reason", reason);
        d.addProperty("after_fires", FAILURES_BEFORE_SUSPEND);
        d.addProperty("rearms_in_ticks", window);
        d.addProperty("note", "this reaction fired " + FAILURES_BEFORE_SUSPEND + " times in a row and"
            + " failed the same way every time (" + reason + ") — it cannot do its job as armed, so"
            + " it is suspended for " + (window / 20) + "s rather than firing 20x a second and"
            + " burying your other events. FIX THE PRECONDITION (for `eat`: get food and it works;"
            + " bot_status {inventory:true}), then bot_reactions {action:\"arm\"} it again to restore"
            + " it immediately. It also re-arms itself when the window expires");
        EventLog.emit("reaction_suspended", d, slot.target());
    }
}
