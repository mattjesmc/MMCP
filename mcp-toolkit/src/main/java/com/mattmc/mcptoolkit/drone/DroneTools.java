package com.mattmc.mcptoolkit.drone;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.EventLog;
import com.mattmc.mcptoolkit.ExecutionContext;
import com.mattmc.mcptoolkit.McpTools;
import com.mattmc.mcptoolkit.Sessions;
import com.mattmc.mcptoolkit.hooks.ServerHooks;
import com.mattmc.mcptoolkit.Mechanism;
import com.mattmc.mcptoolkit.Schemas;
import com.mattmc.mcptoolkit.ToolDef;
import net.minecraft.commands.arguments.EntityAnchorArgument;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntitySpawnReason;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.level.pathfinder.Path;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

/**
 * The drone control surface: spawn a {@link BotBodyEntity}, fly it to a point, aim it, read its state, and
 * despawn it — plus the higher control layers: <b>follow mode</b> ({@link Follow}), <b>possession</b> of
 * world mobs ({@link Possession}), the <b>step queue</b> ({@link QueueRunner}), and the pointer beam.
 * The body is a directly-commanded puppet — these tools are the only thing that moves it. Hands
 * (mine/place/use/attack/inventory) live in {@link DroneHands} behind the {@link Actuator} contract.
 *
 * <p><b>The active body.</b> Movement/look/attack commands route to the session's possessed mob while a
 * possession is live, otherwise to its drone ({@link Slot#activeBody()}). The drone alone has hands and
 * the beam; a possessed body moves with its own legs (ground pathfinding included).
 *
 * <p><b>Per-session slots.</b> Each session gets its own {@link Slot}: drone, possession, follow mode,
 * queue, outstanding flight/dig, and {@link DroneObserver}, keyed by the caller's session id
 * ({@code ToolContext.sessionId()}; anonymous callers share the legacy {@code anon} slot). Events are
 * TARGETED at the owning session; the anonymous slot broadcasts.
 *
 * <p><b>Session-bound lifetime.</b> A drone (and any possession) lives only as long as its owning
 * session: the per-tick watch checks {@link Sessions#isLive} and releases everything when the owner
 * ended, crashed, or disconnected.
 *
 * <p><b>Waiting.</b> {@code bot_goto} (and {@code bot_mine}, {@code bot_run}) accept {@code wait:true}:
 * the tool's future then completes when the action finishes, so the HTTP bridge parks instead of the
 * agent polling {@code get_events}. The action itself is unaffected by a wait timeout — it keeps
 * running and still reports through the event log.
 *
 * <p>All state is server-thread only (tools run on {@link ExecutionContext#SERVER}, the watch on the
 * end-of-tick hook), so no synchronization is needed.
 */
public final class DroneTools {

    /** Slot key for callers without a session id — the legacy shared drone. */
    static final String ANON = "anon";

    /**
     * Which mutually-exclusive base intent currently drives the active body. The base intents —
     * {@code GOTO} (a flight), {@code RUN} (a bot_run queue), {@code FOLLOW}, and later
     * {@code ENGAGE} — are mutually exclusive: only one drives the body at a time. {@code IDLE}
     * means nothing sustained is driving it. Set via {@link #claimBase} at each install site and
     * reset to {@code IDLE} where an intent ends (queue complete/fail, follow lost, a manual goto
     * arriving). Nothing reads it yet — it is the seam the reflex interrupt layer
     * (PLAYER_CONTROL_DESIGN.md §2) suspends/resumes on top of. Body-teardown sites (despawn,
     * possession) may leave it briefly stale; harmless while unread, tightened when the reflex
     * layer lands.
     */
    public enum BaseKind { IDLE, GOTO, RUN, FOLLOW, GOAL }

    /** One session's embodiment: its drone and everything in flight around it. */
    static final class Slot {
        final String owner;
        final DroneObserver observer;
        @Nullable BotBodyEntity drone;
        /** The session's PLAYER body (a real headless ServerPlayer, §11.8) — mutually exclusive
         *  with {@link #drone} in practice: bot_body spawn replaces whichever body was live. */
        @Nullable FakePlayerEntity player;
        @Nullable PendingNav pendingNav;
        DroneHands.@Nullable Dig dig;
        /** In-flight attack TURN (F1) — the body is rotating toward its target at the driver's
         *  gaze rate; the swing fires when facing with LOS clear. Serviced UNCONDITIONALLY
         *  (DroneHands.swingTick, outside the base branch — a swing drives no legs, so a reflex or
         *  a fight holding the body must not stop its clock, S1); the LookDriver yields to it. */
        DroneHands.@Nullable Swing swing;
        /** In-flight smooth turn ({@link LookDriver}) — the visible head sweep of scans, digs and
         *  ceremonies. Serviced in the base branch; combat aim and the nav driver veto it. */
        LookDriver.@Nullable Turn look;
        /** In-flight act ceremony ({@link ActCeremony}) — the ticked face/open/swing performance
         *  around a container transfer or bench craft. Reflex/fight preemption resolves it
         *  immediately (commit runs, theater is cut). */
        ActCeremony.@Nullable Act ceremony;
        /** In-flight REAL eat/drink ({@link PlayerVerbs.Chew}) — vanilla use-ticks doing the
         *  consuming; serviced unconditionally (a reflex owning the legs does not stop a swallow). */
        PlayerVerbs.@Nullable Chew chew;
        /** In-flight REAL held use ({@link PlayerVerbs.UseHold}) — the aim and the draw of a shot,
         *  released on purpose. Mutually exclusive with {@link #chew}: one mainhand, and the two
         *  refuse each other {@code busy}. Serviced unconditionally, like the swing clock. */
        PlayerVerbs.@Nullable UseHold use;
        /** The raised shield ({@link Shields.Guard}) — vanilla holds ONE in-flight use per entity,
         *  so this and {@link #use} are mutually exclusive by construction: a raise cancels a draw
         *  and a draw lowers the guard, both explicitly, because letting them stomp each other
         *  silently made the pair livelock. Serviced unconditionally, like the swing clock. */
        Shields.@Nullable Guard guard;
        /** A crossbow being WOUND ({@link Crossbows.Load}) — the fourth thing that can own vanilla's
         *  single in-flight use, and the lowest-priority of them: a shot, a meal or a raised shield
         *  all take the hand from it, each saying so. Serviced unconditionally, like the others. */
        Crossbows.@Nullable Load load;
        /** Weapons this body threw and would like back ({@link Retrieve}) — the scheduled half of
         *  COMBAT_KIT_PLAN.md D2. The errand runs only while the body has nothing else to do, so
         *  the list can outlive several fights before it is walked. */
        final List<Retrieve.Pending> pickups = new ArrayList<>();
        /** What the shield ate THIS tick ({@link Shields#tick} drains it; the vitals watch at the
         *  end of the same pass emits from it). A blow blocked whole moves no health at all, so
         *  this is the only witness there is for the hit that never landed. */
        Shields.@Nullable Hit blockHit;
        /** Arrows this body has in the air ({@link Shots}) — watched only until each lands, so the
         *  agent hears whether the shot connected. Never more than a handful. */
        final List<Shots.Flight> flights = new ArrayList<>();
        /** Set by {@link Engage#tick} on the tick it aimed at an enemy (defend mode included),
         *  cleared at the top of each tickWatch pass — danger-facing beats camera-facing, and
         *  without this flag a later-serviced sweep would silently win last-writer-wins. */
        boolean enemyFacedThisTick;
        Possession.@Nullable Hold possession;
        @Nullable Follow follow;
        QueueRunner.@Nullable Run queue;
        GoalRunner.@Nullable Goal goal;
        BaseKind baseKind = BaseKind.IDLE;
        // Combat is a body MODE, not a base intent (BOT_SURFACE_DESIGN.md §4): `engaged` arms it,
        // `threats` says against whom, and `combatMode` decides whether it may claim the body.
        final ThreatTable threats = new ThreatTable();
        boolean engaged;
        String combatMode = "defend";   // defend (reflexes only, keeps the base) | fight (claims it)
        String combatPolicy = "kite";   // kite | strafe | close | hold
        double combatRange = Engage.DEFAULT_RANGE;
        /** True once the caller passed an explicit `range` — Engage then clamps IT into the held
         *  weapon's band; false = the weapon's own default range applies (F4). */
        boolean combatRangeExplicit;
        boolean combatHoldsBody;        // true while fight mode owns movement
        int combatRepathCooldown;
        /** Ticks until a fight-mode engagement may loose its next arrow ({@link Engage}). */
        int combatShotCooldown;
        // Reflex layer: the armed loadout and the in-flight reaction (if any). Body OWNERSHIP is
        // return-value gated in tickWatch — Reflexes.tick true means a reaction owns the body,
        // Engage.tick true means fight-mode combat does; base servicing is skipped while either
        // holds. That gating IS the contract (there is no parallel boolean to keep in sync — the
        // old `baseSuspended` was written by both layers and read by nothing, i.e. a lie waiting
        // to be believed).
        final List<Reflexes.Reaction> reactions = new ArrayList<>();
        Reflexes.@Nullable Active active;
        // Player-legal perception belief store (present once sense_entities turns tracking on).
        Perception.@Nullable Store perception;
        // When true (bot_profile perceived), reflex triggers count perceived threats, not ground truth.
        boolean perceivedMode;
        // The id of the reaction that most recently interrupted a running queue, until that queue
        // advances a step (cleared) or fails (stamped as after_reaction). See QueueRunner / Reflexes.
        @Nullable String queueInterruptedBy;
        boolean hadDrone;
        float lastHealth = -1;
        /** Player-body vitals watch — the drone's `hadDrone`/`lastHealth` twin (see tickWatch). */
        boolean hadPlayer;
        float lastPlayerHealth = -1;
        /** How many DEATH_PROTECTION items the body carried last tick. A DROP in this, on a tick
         *  where the body took damage and lived, is a totem SPENT rather than merely moved — the
         *  count spans the equipment slots, so the offhand policy's own swaps do not move it (see
         *  the detection in tickWatch). */
        int totemCount;
        /**
         * Environmental hazards currently announced for the active body ({@link Hazards}). Held per
         * slot so each cause events its ONSET once and its clear once, rather than every tick.
         */
        final java.util.Set<String> hazards = new java.util.LinkedHashSet<>();
        /**
         * The gentle hunger latch ({@link Hazards#FOOD_LOW_CAUSE}) — set when food crosses 10 going
         * down, cleared at 12 going up. Separate from {@code hazards} because it is deliberately not
         * a danger: it emits {@code food_low}, never {@code body_endangered}, and the urgent lane
         * stays for things that are killing you.
         */
        boolean foodWarned;
        /**
         * Standing block watches ({@link Watch}) — the session's "tell me when I see this" list,
         * consulted on every ray hit. Held per slot for the same reason reflexes are: it is a
         * property of the agent's attention, not of the world.
         */
        final List<Watch.Entry> watches = new ArrayList<>();
        /** Where this session's last body DIED (position, tick, dimension) — the respawn anchor,
         *  so a new body comes back near its drops instead of near whoever happens to be online. */
        @Nullable Vec3 lastDeathPos;
        long lastDeathTick;
        @Nullable String lastDeathDim;
        /** What the body was carrying when it was last HURT — the manifest of what it drops if that
         *  damage kills it. Sampled at damage rather than at death because vanilla empties the
         *  inventory inside die()/dropAllDeathLoot, long before this watch notices the corpse: a read
         *  at death time returns nothing. Nothing can die without being hurt first, so the last
         *  damage tick is the freshest legal snapshot available. Own-inventory, so this is
         *  proprioception (the body knew what it carried a second ago), never an X-ray. */
        @Nullable JsonArray lastInventory;

        Slot(final String owner) {
            this.owner = owner;
            this.observer = new DroneObserver(ANON.equals(owner) ? null : owner);
        }

        /** Event-targeting address: the owning session, or null (broadcast) for the anon slot. */
        @Nullable String target() {
            return ANON.equals(owner) ? null : owner;
        }

        /** The slot's live drone, dropping a stale reference to a removed entity. */
        @Nullable BotBodyEntity drone() {
            if (drone != null && drone.isRemoved()) {
                drone = null;
            }
            return drone;
        }

        /** The slot's live PLAYER body (§11.8 widening), dropping a stale reference on removal. */
        @Nullable FakePlayerEntity player() {
            if (player != null && player.isRemoved()) {
                player = null;
            }
            return player;
        }

        /** The body commands act through: possessed mob, else the player body, else the drone. */
        @Nullable LivingEntity activeBody() {
            LivingEntity possessed = Possession.live(this);
            if (possessed != null) {
                return possessed;
            }
            FakePlayerEntity p = player();
            return p != null ? p : drone();
        }

        /** The offline-username this session's player body logs in as: the session id squeezed into
         *  Minecraft's [A-Za-z0-9_], max 16 — stable per session, visible in the tab list. */
        String fakeName() {
            String s = owner.replaceAll("[^A-Za-z0-9_]", "_");
            return s.length() > 16 ? s.substring(0, 16) : s;
        }
    }

    private static final Map<String, Slot> SLOTS = new HashMap<>();

    /** Live session bodies (session label -> body), for the human-facing watch commands
     *  ({@code /mmcp body …}). Possessed bodies are not listed — the drone/walker is the body a
     *  human wants to find and follow. */
    public static Map<String, BotBodyEntity> liveBodies() {
        Map<String, BotBodyEntity> out = new java.util.LinkedHashMap<>();
        for (Map.Entry<String, Slot> e : SLOTS.entrySet()) {
            BotBodyEntity body = e.getValue().drone();
            if (body != null) {
                out.put(e.getKey(), body);
            }
        }
        return out;
    }
    /** Sequence for embodied action ids; completion events correlate via {@code action_id}. */
    private static long actionSeq = 0;
    /** Owner-liveness sweep cadence (ticks): dead sessions lose their drones within ~5s of detection. */
    private static final int REAP_INTERVAL = 100;
    private static int reapCounter;
    /** Dispatch timeout for waitable embodied tools — long flights/digs park the HTTP thread this long. */
    private static final int WAIT_TIMEOUT_SECONDS = 120;

    /** Default + bounds for the {@code within} arrival radius (blocks from the target). */
    static final double DEFAULT_WITHIN = 2.5;
    private static final double MIN_WITHIN = 1.0;
    private static final double MAX_WITHIN = 16.0;
    /** Below this displacement a completed move counts as "already_there", not a journey. Verified
     * live 2026-07-23: a hovering drone drifts ~1 block while "not moving", so this sits above
     * hover drift and below any genuine repositioning. */
    private static final double TRAVELED_EPSILON = 1.5;

    /**
     * An outstanding {@code bot_goto} flight: which body flies, where to, and who (if anyone) waits —
     * plus what the completion verdict needs to be honest: where the body started ({@code startPos},
     * so "arrived" and "already_there" are distinguishable), the caller's arrival radius
     * ({@code within}), and whether the path was partial at start ({@code pathPartial} — a partial
     * path that happens to end near the target must not be reported as a clean arrival). A reach
     * goal carries its block ({@code reachTarget}) and whether the body could already touch it at
     * start ({@code startTouch}) — arrival is then the touch predicate re-verified against real
     * geometry, not a distance.
     */
    static final class PendingNav {
        final String actionId;
        final LivingEntity body;
        final Vec3 target;
        final Vec3 startPos;
        final double within;
        final boolean pathPartial;
        final @Nullable BlockPos reachTarget;
        final boolean startTouch;
        /** The rights this navigation was STARTED with — so a repair re-plans identically. Without
         *  it, renav silently re-planned every stalled leg with DEFAULT (swim allowed). */
        final com.mattmc.mcptoolkit.nav.NavProfile profile;
        final @Nullable CompletableFuture<JsonElement> waiter;
        /** Stall watch (§12.4): the last position that counted as progress, and how long since. */
        Vec3 progressPos;
        int stallTicks;
        /** Total ticks this navigation has been outstanding — the absolute circuit breaker. */
        int liveTicks;
        /** Set when the watchdog cut this navigation off: {@code stalled}, {@code nav_timeout},
         *  or {@code replan_failed} (a reflex tore the path down and the re-solve found none). */
        @Nullable String stalledAs;
        /** How many times a leg reflex preempted this flight, and which one did it last — the
         *  starvation ledger (Reflexes.suspend counts; the verdict discloses). */
        int preemptions;
        @Nullable String lastPreemptedBy;

        PendingNav(final String actionId, final LivingEntity body, final Vec3 target, final Vec3 startPos,
                   final double within, final boolean pathPartial,
                   final @Nullable BlockPos reachTarget, final boolean startTouch,
                   final com.mattmc.mcptoolkit.nav.NavProfile profile,
                   final @Nullable CompletableFuture<JsonElement> waiter) {
            this.actionId = actionId;
            this.body = body;
            this.target = target;
            this.startPos = startPos;
            this.within = within;
            this.pathPartial = pathPartial;
            this.reachTarget = reachTarget;
            this.startTouch = startTouch;
            this.profile = profile;
            this.waiter = waiter;
            this.progressPos = startPos;
        }
    }

    /**
     * The <b>stall watchdog</b> (§12.4) — the one place that guarantees a navigation cannot wait
     * forever, for every body kind.
     *
     * <p><b>Why it lives here and not in a navigation.</b> A {@code bot_goto} ends when
     * {@code Bodies.nav(body).isDone()} goes true, and nothing else. The Mob bodies inherit vanilla's
     * {@code doStuckDetection}; the player body had none, and the goal loop it delegated to could not
     * act because it was itself blocked waiting for this completion. The result was a live session
     * wedged at a shoreline with an agent polling an event that would never arrive. Putting the
     * invariant on the pending record — not inside either follower — means a body kind added later
     * cannot reintroduce the hang by forgetting to implement it.
     *
     * <p>Both bounds are circuit breakers, not budgets: the stall window resets on every metre of
     * genuine progress, so a long route never trips it by being long, and a body legitimately held
     * (mid-leap, or surfacing for air) is not counted as stalled at all.
     */
    /**
     * Displacement counting as progress. Sized off {@link #TRAVELED_EPSILON} for the same measured
     * reason it exists: a hovering flyer drifts ~1 block while "not moving", so a 1.0 threshold would
     * be met by drift alone and a wedged drone would never be found stalled. Every real body clears
     * this many times over inside the window — a walker covers ~25 blocks in it, a swimmer ~12.
     */
    private static final double STALL_PROGRESS = TRAVELED_EPSILON;
    /** Ticks of no progress before a navigation is declared stalled (6 seconds). */
    private static final int STALL_TICKS = 120;
    /** Absolute ceiling on one navigation (5 minutes) — a backstop for a body that oscillates
     *  without ever advancing, which no progress test can catch. Far above any real 512-block route. */
    private static final int NAV_MAX_TICKS = 6000;

    /**
     * Advance the stall watch a tick. Returns the reason word when the navigation must be cut off, or
     * null while it is still making progress (or is legitimately held).
     */
    private static @Nullable String stallReason(final PendingNav p) {
        if (++p.liveTicks > NAV_MAX_TICKS) {
            return "nav_timeout";
        }
        // A body mid-leap or breathing is not stalled — it is doing the thing that finishes the route.
        if (heldByDriver(p.body)) {
            return null;
        }
        if (p.body.position().distanceTo(p.progressPos) >= STALL_PROGRESS) {
            p.progressPos = p.body.position();
            p.stallTicks = 0;
            return null;
        }
        return ++p.stallTicks > STALL_TICKS ? "stalled" : null;
    }

    /** Is a driver legitimately holding this body (a leap arc, or a swim break to breathe)? */
    private static boolean heldByDriver(final LivingEntity body) {
        if (body instanceof FakePlayerEntity player) {
            return player.navigation().isSurfacing();
        }
        return false;
    }

    private DroneTools() {}

    static String key(final @Nullable String sessionId) {
        return sessionId == null || sessionId.isBlank() ? ANON : sessionId;
    }

    /** The caller's slot, created on demand. */
    static Slot slotFor(final @Nullable String sessionId) {
        return SLOTS.computeIfAbsent(key(sessionId), Slot::new);
    }

    /**
     * The caller's slot WITHOUT creating one. {@link Watch#sight} runs on every ray hit, including
     * anonymous ones, and creating a slot per stray raycast would grow the map for callers that
     * never had a body.
     */
    static @Nullable Slot peekSlot(final @Nullable String sessionId) {
        return SLOTS.get(key(sessionId));
    }

    /** Every live slot — for the cross-session sweeps ({@link Watch}'s armed count / world close). */
    static java.util.Collection<Slot> allSlots() {
        return SLOTS.values();
    }

    /** The session's active body (possessed mob or drone), or null. Perception's {@code drone} origin case. */
    public static @Nullable LivingEntity activeBodyFor(final @Nullable String sessionId) {
        Slot s = SLOTS.get(key(sessionId));
        return s == null ? null : s.activeBody();
    }

    public static void register() {
        // Action feedback + drone state events, checked once per server tick (server thread, like the tools).
        // The activity snapshot rebuilds AFTER the watch, so /activity reports this tick's real state.
        ServerHooks.END_SERVER_TICK.register(s -> {
            tickWatch();
            ActivitySnapshot.update(SLOTS.values(), s.getTickCount());
        });

        // A conversion (zombie→drowned) discards the old entity — without this hook a possessed
        // body's conversion reads as a despawn/death instead of naming the successor to re-possess.
        ServerHooks.MOB_CONVERSION.register(
            (previous, converted) -> {
                for (Slot slot : SLOTS.values()) {
                    Possession.onConverted(slot, previous, converted);
                }
            });

        // World exit is a hard lifecycle end: the drone is never written to disk
        // (BotBodyEntity.shouldBeSaved — a saved drone only ever resurrects as an ownerless ghost), so
        // reap every live one here. Cargo is deliberately NOT dropped: items spawned during
        // stopServer don't survive the shutdown save (verified live 2026-07-22), and quit-loses-cargo
        // is accepted behavior — despawn/replace/death are the drop paths.
        // Possessions release too — the mob is the world's, and its AI must come back before the save.
        ServerHooks.SERVER_STOPPING.register(s -> {
            Iterator<Slot> it = SLOTS.values().iterator();
            while (it.hasNext()) {
                Slot slot = it.next();
                BotBodyEntity drone = slot.drone();
                QueueRunner.abort(slot, "server_stopping");
                GoalRunner.abort(slot, "server_stopping"); // before failPending: no repair mid-teardown
                Follow.clear(slot);
                failPending(slot, "server_stopping");
                Possession.release(slot, "server_stopping");
                if (drone != null) {
                    DroneHands.abort(slot, "server_stopping");
                    drone.discard();
                }
                it.remove();
            }
        });

        McpTools.register(ToolDef.of(
            "bot_body",
            "Which body you drive, and how it behaves. `action`: "
                + "spawn — create YOUR body (each session commands its own). `type`: 'flyer' (default "
                + "— the recon drone, a flying camera + hands that sails over gaps and through "
                + "doorways), 'walker' (player-shaped GROUND body: walks, sprint-jumps gaps, takes "
                + "falls; it must actually traverse terrain, so paths/doors/gaps are real obstacles "
                + "for it — the body to use when the route itself matters), or 'player' (a REAL "
                + "headless player: tab list, hunted natively by hostiles, real 36-slot inventory "
                + "that auto-collects drops it walks over, real hunger — eat or starve. FULL verb "
                + "surface: goto/look/status/attack/eat/drink/equip/select/inventory + "
                + "mine/place/use/shoot/craft (engine dig timing — tools matter), bot_target goals, "
                + "reflexes/engage). Position: after a recent death the spawn anchors on YOUR DEATH "
                + "SITE (your drops are there); otherwise near the first online player. Placement "
                + "prefers cells clear of hostiles (escalating search to 24 blocks; when nothing "
                + "clears them the result carries spawned_unsafe:true + an urgent spawned_in_danger "
                + "event). Override the anchor with `near`:\"death\"|\"player\", or fully with "
                + "`pos` {x,y,z} + `dimension`. Replaces your existing body (carried items drop); "
                + "other sessions' bodies are untouched; yours dies with your session. "
                + "despawn — remove your drone (carried items drop). "
                + "possess — take over a mob already in the world (`target` entity id): its AI is "
                + "suspended (not erased) and your movement/look/attack and the perception `drone` "
                + "origin route to it; the drone parks. Capability-honest: a possessed body has NO "
                + "hands (mine/place/use/inventory refuse). Goal-driven mobs only — brain-driven ones "
                + "(villagers, piglins…) are refused with brain_mob_unsupported. "
                + "release — end the possession; the mob's own mind resumes untouched. "
                + "engage — arm/disarm AUTOMATED COMBAT (`on`, default true). This is a MODE, not a "
                + "target: WHO it fights comes from the threat table (bot_target action:\"attack\"), "
                + "so a killed enemy yields to the next instead of ending the fight. `mode`: 'defend' "
                + "(default — reflex responses only, never abandons what the body was doing, so it "
                + "mines/travels and fights off what jumps it) or 'fight' (commits: takes over "
                + "movement, kites until the enemy is down, then resumes the interrupted goal). "
                + "`policy` kite|strafe|close|hold and `range` shape fight-mode movement. The stand "
                + "range FOLLOWS THE HELD WEAPON: melee/empty hands → default 2.5 (inside swing "
                + "reach — the band's ceiling is THIS body's reach less anchor slack, so 2.25 on a "
                + "player body and 3.25 on a drone/walker); bow/crossbow → default 10 (fight at "
                + "distance, band [6, 20]); an explicit `range` clamps into the held weapon's band "
                + "and the reply says so. Fight-mode repositioning sprints, stations only on "
                + "STANDABLE cells, and "
                + "with a ranged weapon prefers elevated stands with line of sight. "
                + "`clear_targets`:true empties the threat table. "
                + "guard — RAISE THE SHIELD and hold it for `ticks` (default 60, i.e. 3s; `on`:false "
                + "lowers it). The body fills its own offhand from the pack, so you never have to "
                + "equip one: a shield while healthy, a totem of undying once one more hit would be "
                + "death (that case refuses `totem_preferred` — the totem is the better bet there). "
                + "TWO THINGS DECIDE WHETHER A BLOCK HAPPENS, and both are vanilla's: the shield "
                + "covers a ~90° arc in FRONT of where the head is looking (nothing from behind), "
                + "and it does not protect for the first 5 ticks of the raise — raise it BEFORE the "
                + "blow, never as it lands. bot_status reports `blocking` and `block_ready_in` while "
                + "one is up. Blocked blows arrive as body_damaged {blocked, blocked_damage} even "
                + "when they cost no health; an axe can knock the guard aside (shield_disabled, and "
                + "the shield then refuses to rise until its cooldown clears). For an incoming "
                + "ARROW this is usually too slow to call by hand — arm it as a reflex instead: "
                + "bot_reactions {trigger:{kind:\"projectile_incoming\"}, response:{op:\"shield\"}}. "
                + "load — WIND A CARRIED CROSSBOW so the next shot costs no draw. A crossbow stays "
                + "loaded indefinitely once charged, so the ~25 ticks are worth paying before a "
                + "fight rather than inside one. The body already does this BY ITSELF between the "
                + "shots of a ranged fight; call it to walk into one ready. bot_status reports "
                + "crossbow_charged whenever a crossbow is carried. Fails: no_weapon (none carried "
                + "— a BOW cannot be pre-loaded, its draw is spent at the shot), item_missing (no "
                + "arrows), already_charged, busy (a draw, a meal or a raised shield owns the same "
                + "hand — vanilla allows one use at a time).",
            Schemas.objectOpt(Schemas.object(
                "action", Schemas.str("spawn | despawn | possess | release | engage | guard | load"),
                "type", Schemas.str("spawn: flyer (default) | walker | player."),
                "pos", Schemas.object("x", Schemas.number(), "y", Schemas.number(), "z", Schemas.number()),
                "dimension", Schemas.str("Dimension for an explicit spawn `pos` (default minecraft:overworld)."),
                "near", Schemas.str("spawn: anchor override — death (your last death site) | player."),
                "target", Schemas.integer("Entity id of the mob to possess."),
                "on", Schemas.bool("engage: arm (true, default) or disarm (false). guard: raise "
                    + "(true, default) or lower (false)."),
                "ticks", Schemas.integer("guard: how long to hold the shield up (default "
                    + Shields.DEFAULT_TICKS + ", max " + Shields.MAX_TICKS + ")."),
                "mode", Schemas.str("engage: defend (default) | fight."),
                "policy", Schemas.str("engage FIGHT-mode movement: kite (default) | strafe | close | hold (refused in defend mode)."),
                "range", Schemas.number("engage FIGHT mode: preferred stand distance in blocks, "
                    + "clamped into the HELD weapon's band (melee [1, this body's swing reach less "
                    + "0.75 — 2.25 player / 3.25 drone-walker], bow/crossbow [6, 20]); "
                    + "omit for the weapon's default (2.5 melee / 10 ranged). Refused in defend mode."),
                "clear_targets", Schemas.bool("engage: empty the threat table.")),
                "type", "pos", "dimension", "near", "target", "on", "ticks", "mode", "policy",
                "range", "clear_targets"),
            ExecutionContext.SERVER,
            Mechanism.EMBODIED,
            (ctx, a) -> botBody(ctx.serverOrThrow(), a, slotFor(ctx.sessionId()))));

        McpTools.register(ToolDef.async(
            "bot_goto",
            "Move YOUR body to `to` {x,y,z} using real pathfinding (ground navigation — walking, "
                + "sprint-jumps, swimming — for a player/walker body or possessed mob; flying for the "
                + "drone). Returns whether a path was found and started "
                + "(reachable/partial/nodes) plus an `action_id`; the move proceeds over subsequent ticks "
                + "and finishes with an action_completed event or an action_failed event in get_events. "
                + "The completion is honest about HOW it ended: `outcome` is arrived (traveled to within "
                + "`within` blocks of the target), already_there (was already within range — the body did "
                + "not move), stopped_short (WALKED and ran out of path farther away; distance_to_target "
                + "says how far, and `path_partial`:true means the pathfinder could not reach the target "
                + "from here — check_path to diagnose, or raise `within` if nearby suffices), "
                + "did_not_start (the body never moved — re-issuing replays the same solve and moves "
                + "nothing; change something first: check_path, or allow may_modify to dig/bridge), "
                + "or — the two WEDGED outcomes — stalled (the body stopped moving along a path that had not ended: "
                + "re-issuing the same call will wedge again; check_path from here, break/bridge the "
                + "obstruction with bot_target may_modify, or route via an intermediate point) and "
                + "nav_timeout (moving the whole time but never arriving). `within` is the "
                + "arrival radius in blocks (default " + DEFAULT_WITHIN + ", max " + (int) MAX_WITHIN
                + "). GOAL-SHAPED ALTERNATIVE for goto-before-mine/place/use: give `reach` {x,y,z} (a "
                + "BLOCK position) instead of `to` — the body lands anywhere it can TOUCH that block "
                + "(hand reach 4.5 from the eye WITH line of sight, solved against real geometry; "
                + "`within` is ignored). Its completion re-verifies the touch: arrived means the hands "
                + "work NOW; stopped_short carries `gates` {range, los} naming the failed precondition "
                + "(range false → path problem; los false → in range but an occluder blocks sight: mine "
                + "it or approach another face). Starts can fail with `occluded` (block fully enclosed — "
                + "pathing cannot help, expose a face first). Pass `wait`:true to "
                + "have THIS CALL block until the move finishes and return the outcome directly (no "
                + "event polling needed). Issuing a new bot_goto supersedes the old one "
                + "(action_superseded — normal, not a failure) and cancels follow mode / a running "
                + "bot_run queue. Optional `speed` multiplier (default 1.0).",
            Schemas.objectOpt(Schemas.object(
                "to", Schemas.object("x", Schemas.number(), "y", Schemas.number(), "z", Schemas.number()),
                "reach", Schemas.vec3i(),
                "within", Schemas.number("Arrival radius in blocks (default " + DEFAULT_WITHIN
                    + ", clamped 1-" + (int) MAX_WITHIN + "). Arrival means final distance to target <= within. Ignored with `reach`."),
                "speed", Schemas.number("Movement speed multiplier, default 1.0."),
                // The route profile. This path has ALWAYS parsed these (see startNav:
                // NavProfile.fromJson) and the charter documents `swim:false` on bot_goto — they
                // were simply never declared, so the schema said less than the tool did. Undeclared
                // was survivable while nothing checked; ArgCheck checks, and a real argument missing
                // from the schema now reads as a typo to the caller. Declared 0.46.0.
                "swim", Schemas.bool("Swim across/through water (default true). false = land only, "
                    + "for route AND steering."),
                "may_modify", Schemas.str("World changes allowed en route: none (default) | break | "
                    + "place | both. Granting rights makes this call RUN AS a bot_target move goal "
                    + "(same solve, repair loop, and ledger — a plain follow can never perform the "
                    + "digs its path plans); the reply then carries a g- action id and the outcome "
                    + "arrives as a bot_target completion. Not combinable with `reach` — use "
                    + "bot_target directly there."),
                "open_doors", Schemas.bool("Open closed wooden doors en route (default true)."),
                "budget", Schemas.objectOpt(Schemas.object(
                    "break", Schemas.integer("Max blocks it may mine to get through."),
                    "place", Schemas.integer("Max blocks it may place to bridge.")),
                    "break", "place"),
                "wait", Schemas.bool("If true, the call returns only when the move completes/fails.")),
                "to", "reach", "within", "speed", "swim", "may_modify", "open_doors", "budget",
                "wait"),
            ExecutionContext.SERVER,
            Mechanism.EMBODIED,
            (ctx, a) -> {
                Slot slot = slotFor(ctx.sessionId());
                // Validate BEFORE tearing anything down: a malformed call must not cost the caller
                // a running queue or follow mode (bot_follow and bot_run already validate first).
                requireBody(slot);
                // BUILD-ASSISTED bot_goto IS a move goal (w1_42257 R2). A followed path must never
                // assume un-performed repairs, so PlayerNavigation strips build rights from every
                // follow — which made `bot_goto may_modify` a silent no-op: the reply echoed
                // break_budget:16, check_path answered reachable:true, and the walk went nowhere.
                // Every did_not_start advisory already says "allow may_modify to dig/bridge"; this
                // makes that advice true by routing the call into the machinery that performs the
                // work it plans (same solve, same repair loop, same ledger and watchdogs).
                com.mattmc.mcptoolkit.nav.NavProfile rights =
                    com.mattmc.mcptoolkit.nav.NavProfile.fromJson(a, true);
                if (rights.modifiesWorld()) {
                    if (a.has("reach") && !a.get("reach").isJsonNull()) {
                        JsonObject r = new JsonObject();
                        r.addProperty("started", false);
                        r.addProperty("reason", "reach_with_rights_is_a_goal");
                        r.addProperty("note", "`reach` + `may_modify` is exactly what bot_target "
                            + "already is: use bot_target {action:\"move\", target:{at}, reach:true, "
                            + "may_modify} — or destroy/place if hands-on-the-block is the point");
                        return CompletableFuture.completedFuture(r);
                    }
                    Vec3 to = navTarget(a);
                    JsonObject ga = new JsonObject();
                    ga.addProperty("action", "move");
                    JsonObject sel = new JsonObject();
                    JsonObject at = new JsonObject();
                    at.addProperty("x", (int) Math.floor(to.x));
                    at.addProperty("y", (int) Math.floor(to.y));
                    at.addProperty("z", (int) Math.floor(to.z));
                    sel.add("at", at);
                    ga.add("target", sel);
                    rights.writeArgs(ga); // round-trip shape: may_modify, open_doors, swim, budget
                    CompletableFuture<JsonElement> waiter =
                        wantsWait(a) ? new CompletableFuture<>() : null;
                    JsonObject r = GoalRunner.start(ga, slot, waiter);
                    r.addProperty("action", "bot_goto");
                    if (r.get("started").getAsBoolean()) {
                        r.addProperty("note", "build-assisted: running as a move goal (same rights, "
                            + "ledger, and watchdogs) — arrival within " + GoalRunner.MOVE_WITHIN
                            + " blocks; the outcome arrives as a bot_target completion under this "
                            + "action_id");
                        if (waiter != null) {
                            return waiter;
                        }
                    }
                    return CompletableFuture.completedFuture(r);
                }
                navTarget(a);
                // Displace any queue/follow base intent; startNav supersedes any loose flight.
                claimBase(slot, BaseKind.GOTO, "superseded");
                CompletableFuture<JsonElement> waiter = wantsWait(a) ? new CompletableFuture<>() : null;
                JsonObject r = startNav(a, slot, waiter);
                if (waiter != null && r.get("started").getAsBoolean()) {
                    return waiter;
                }
                return CompletableFuture.completedFuture(r);
            }).withTimeout(WAIT_TIMEOUT_SECONDS));

        McpTools.register(ToolDef.async(
            "bot_look",
            "Aim YOUR body's eye (the perception origin). Give either `yaw`/`pitch` in degrees, or `at` "
                + "{x,y,z} to look toward a point. Returns the resulting yaw/pitch. `sweep_ticks` turns "
                + "smoothly over that many ticks instead of snapping (the call returns when the sweep "
                + "lands; combat aim or navigation can preempt it — the reply then carries swept:false).",
            Schemas.objectOpt(Schemas.object(
                "yaw", Schemas.number(), "pitch", Schemas.number(),
                "at", Schemas.object("x", Schemas.number(), "y", Schemas.number(), "z", Schemas.number()),
                "sweep_ticks", Schemas.integer("Turn smoothly over N ticks instead of snapping.")),
                "yaw", "pitch", "at", "sweep_ticks"),
            ExecutionContext.SERVER,
            Mechanism.EMBODIED,
            (ctx, a) -> {
                Slot slot = slotFor(ctx.sessionId());
                int sweep = a.has("sweep_ticks") && !a.get("sweep_ticks").isJsonNull()
                    ? a.get("sweep_ticks").getAsInt() : 0;
                if (sweep <= 0) {
                    return CompletableFuture.completedFuture(doLook(a, slot));
                }
                LivingEntity body = requireBody(slot);
                CompletableFuture<JsonElement> waiter = new CompletableFuture<>();
                if (a.has("at") && !a.get("at").isJsonNull()) {
                    JsonObject at = a.getAsJsonObject("at");
                    LookDriver.sweepAt(slot, body, new Vec3(at.get("x").getAsDouble(),
                        at.get("y").getAsDouble(), at.get("z").getAsDouble()), sweep, waiter);
                } else if (a.has("yaw") || a.has("pitch")) {
                    float yaw = a.has("yaw") && !a.get("yaw").isJsonNull()
                        ? a.get("yaw").getAsFloat() : body.getYRot();
                    float pitch = a.has("pitch") && !a.get("pitch").isJsonNull()
                        ? a.get("pitch").getAsFloat() : body.getXRot();
                    LookDriver.sweepTo(slot, body, yaw, pitch, sweep, waiter);
                } else {
                    throw new IllegalArgumentException("pass `yaw`/`pitch` or `at` {x,y,z}");
                }
                return waiter;
            }).withTimeout(30));

        McpTools.register(ToolDef.of(
            "bot_follow",
            "Continuous follow mode: YOUR body tails a target entity with automatic re-pathing — set it "
                + "once, it runs every tick until stopped (no goto-per-correction). Give `target` (entity "
                + "id, from `sense_entities` or `get_entities` — whichever your role has) or `player` "
                + "(name). ANOTHER AGENT'S BODY is followable both ways: it is a real player in the tab "
                + "list, so `player` takes its name and `sense_entities` reports it like any other. "
                + "`distance` (default 4) and `height` (default 2.5 for the drone, "
                + "0 for a ground body) shape the station point. `look`: 'target' aims the eye at the "
                + "target (camera-follow, default); 'mirror' copies the target's yaw/pitch AND hangs "
                + "behind their shoulder, so perception/screenshots from the body approximate what they "
                + "see; 'forward' leaves facing to navigation. Ends on `stop`:true, an explicit "
                + "bot_goto/bot_run, or target loss (emits a follow_lost event).",
            Schemas.objectOpt(Schemas.object(
                "target", Schemas.integer("Entity id to follow (from get_entities)."),
                "player", Schemas.str("Player name to follow (alternative to `target`)."),
                "distance", Schemas.number("Preferred follow range in blocks, default 4."),
                "height", Schemas.number("Hover height above the target, default 2.5 (drone) / 0 (mob)."),
                "look", Schemas.str("Camera mode: target|mirror|forward (default target)."),
                "stop", Schemas.bool("If true, stop following (all other args ignored).")),
                "target", "player", "distance", "height", "look", "stop"),
            ExecutionContext.SERVER,
            Mechanism.EMBODIED,
            (ctx, a) -> botFollow(ctx.serverOrThrow(), a, slotFor(ctx.sessionId()))));

        McpTools.register(ToolDef.of(
            "bot_point",
            "Shine your body's pointer laser at something — the agent-to-player 'look here' channel. Give "
                + "`at` {x,y,z} or `target` (entity id); the beam (and the body's gaze) aims there for "
                + "`seconds` (default 5, max 60). `off`:true switches it off early. Flyer/walker bodies "
                + "only (the beam is drone hardware; a player body or possessed mob has none). The same "
                + "beam also colors digs (orange) and attacks (red) automatically; the pointer is "
                + "white-cyan.",
            Schemas.objectOpt(Schemas.object(
                "at", Schemas.object("x", Schemas.number(), "y", Schemas.number(), "z", Schemas.number()),
                "target", Schemas.integer("Entity id to point at."),
                "seconds", Schemas.number("Beam duration, default 5, max 60."),
                "off", Schemas.bool("If true, switch the pointer off.")),
                "at", "target", "seconds", "off"),
            ExecutionContext.SERVER,
            Mechanism.EMBODIED,
            (ctx, a) -> doPoint(a, slotFor(ctx.sessionId()))));

        McpTools.register(ToolDef.async(
            "bot_run",
            "Run a QUEUE of embodied steps server-side, in order, as one call — e.g. goto→mine→goto→"
                + "place. `steps` is an array of {op, ...args} where op is goto|mine|look|place|use|"
                + "attack|select|point|wait (each takes the same args as its bot_* tool; wait takes "
                + "{ticks}). Async steps (goto/mine) complete before the next step starts. A goto step "
                + "that positions for a following mine/place should be goal-shaped: {op:'goto', "
                + "reach:{x,y,z}} with the block the NEXT step touches — it lands anywhere the hand "
                + "can reach it (no `within` arithmetic; a plain `to` goto with `within`:4 still "
                + "works but does not verify line of sight). Aborts on the first failure with an "
                + "action_failed event "
                + "{step_index, op, reason, steps_completed} — a not_arrived goto failure carries "
                + "outcome/distance_to_target/path_partial (and `gates` for a reach goto) so the next "
                + "decision needs no follow-up "
                + "read; completes with an action_completed event. Pass `wait`:true to have THIS CALL return "
                + "the final outcome directly. A new bot_run/bot_goto/bot_follow supersedes a running "
                + "queue. Max 64 steps.",
            Schemas.objectOpt(Schemas.object(
                "steps", Schemas.array(Schemas.objectOpt(Schemas.object(
                    "op", Schemas.str("goto|mine|look|place|use|attack|select|point|wait")))),
                "wait", Schemas.bool("If true, the call returns only when the whole queue completes/fails.")),
                "wait"),
            ExecutionContext.SERVER,
            Mechanism.EMBODIED,
            (ctx, a) -> {
                Slot slot = slotFor(ctx.sessionId());
                requireBody(slot);
                CompletableFuture<JsonElement> waiter = wantsWait(a) ? new CompletableFuture<>() : null;
                JsonObject r = QueueRunner.start(a, slot, waiter);
                return waiter != null ? waiter : CompletableFuture.completedFuture(r);
            }).withTimeout(WAIT_TIMEOUT_SECONDS * 3));

        McpTools.register(ToolDef.async(
            "bot_target",
            "GOAL-SHAPED embodied action: state WHAT you want done to WHICH thing; the server "
                + "navigates, performs it, and REPAIRS ITS OWN FAILURES instead of handing them back. "
                + "`action`: move (be there) | destroy (that block is gone; a cell that was ALREADY "
                + "empty completes `already_clear` — nothing mined, no drops, NOT a harvest) | place "
                + "(that block "
                + "exists) | attack (HUNT that entity: the goal closes to swing reach, attacks on "
                + "rhythm, re-pathing as it moves, and completes achieved when it is DOWN — or "
                + "stops honestly: target_lost, target_unreachable, gave_up after "
                + "attack_timeout_ticks. A {kind} selector instead ARMS A STANDING RULE for combat "
                + "mode without hunting anything now) | vantage (STAND WHERE YOU CAN SEE the target "
                + "cell — navigates to a reachable spot with line of sight and faces it; verdict "
                + "los_achieved. The explore move for a locate miss: walk until the place is in "
                + "view, then look/scan). `target` is one selector — {entity}|{uuid}|"
                + "{player}|{at:{x,y,z}}|{handle} (a locate handle — pass handles, never retyped "
                + "coordinates)|{kind} (nearest of that type within 32 blocks of your body; to SEARCH "
                + "the world use locate instead). Prefer this over goto-then-mine: when the path "
                + "stops short, the line of sight is blocked, or a door is shut, it fixes that and "
                + "carries on — each of those would otherwise cost you a round trip. "
                + "BUILD-ASSISTED: `may_modify` break|place|both lets it mine through an obstruction "
                + "or bridge a gap TO GET THERE (default none — a body that silently tunnels through "
                + "someone's wall is a false success), bounded by `budget` {break, place}. THIS IS "
                + "ALSO HOW YOU DIG: with break rights, a destroy goal whose target is BURIED (no "
                + "exposed face — the cell under your feet, ore behind stone, anything underground) "
                + "mines its way in instead of stopping `occluded`, so \"dig down to y=32\" is ONE "
                + "call — raise `budget.break` to the depth you mean. With place rights a move goal "
                + "pillars UP the same way, which is how a body climbs out of its own shaft; "
                + "`open_doors` defaults true here, iron doors are never assumed. "
                + "The outcome is honest and RESUMABLE: `ledger` reports what it actually did "
                + "(traveled_to / mined / placed / doors_opened / jumped) so a partial result needs no "
                + "re-survey, and a stop names the BLOCKING BLOCK (`obstruction` "
                + "{x,y,z,block,path_type,remedy}), not just where it stopped. Pass `wait`:true to "
                + "get the final outcome from THIS CALL. Supersedes any goto/queue/follow.",
            Schemas.objectOpt(Schemas.object(
                "action", Schemas.str("move | destroy | place | attack | vantage"),
                "target", Targets.schema(),
                "item", Schemas.str("Block to place/bridge with, or tool to mine with; defaults to the held item."),
                "reach", Schemas.bool("move: arrive within HAND REACH of the target with line of "
                    + "sight (what bot_goto {reach} solves), instead of within " + GoalRunner.MOVE_WITHIN
                    + " blocks. Use it whenever a dig follows — 2.5 blocks around a corner is not "
                    + "reach, and the mine then fails out_of_reach."),
                "may_modify", Schemas.str("World changes allowed while getting there: none (default) | break | place | both."),
                "open_doors", Schemas.bool("Open closed wooden doors en route (default true)."),
                "swim", Schemas.bool("Swim across/through water (default true — EXCEPT attack: "
                    + "hunts default DRY, and a target across water ends target_unreachable; pass "
                    + "swim:true to wade in deliberately). The body dives, surfaces to breathe on "
                    + "its own, and prefers surface routes. false = land only."),
                "budget", Schemas.objectOpt(Schemas.object(
                    "break", Schemas.integer("Max blocks it may mine to get through (default 16)."),
                    "place", Schemas.integer("Max blocks it may place to bridge (default 16).")),
                    "break", "place"),
                "attack_timeout_ticks", Schemas.integer("attack: how long the hunt may run before "
                    + "conceding gave_up (default 1200 = 60s, max 6000)."),
                "engage", Schemas.bool("attack: also arm combat mode in the same call."),
                "accept_no_drops", Schemas.bool("destroy: break a drop-gated block even though the "
                    + "tool collects nothing from it. Without this, a player-body destroy whose tool "
                    + "cannot harvest the block stops wrong_tool instead of wasting it (the body "
                    + "auto-switches to a correct pack tool first when it carries one)."),
                "wait", Schemas.bool("If true, the call returns only when the goal completes or stops.")),
                "item", "reach", "may_modify", "open_doors", "swim", "budget", "attack_timeout_ticks",
                "engage", "accept_no_drops", "wait"),
            ExecutionContext.SERVER,
            Mechanism.EMBODIED,
            (ctx, a) -> {
                Slot slot = slotFor(ctx.sessionId());
                CompletableFuture<JsonElement> waiter = wantsWait(a) ? new CompletableFuture<>() : null;
                JsonObject r = GoalRunner.start(a, slot, waiter);
                if (waiter != null && r.get("started").getAsBoolean()) {
                    return waiter;
                }
                return CompletableFuture.completedFuture(r);
            }).withTimeout(WAIT_TIMEOUT_SECONDS * 3));

        McpTools.register(ToolDef.async(
            "bot_tunnel",
            "DIG A CORRIDOR — the mining verb, as one call instead of two hundred. Clears a "
                + "`height`-tall (2 default) passage `length` blocks in `direction` "
                + "(north|south|east|west; default = the way you are facing), walking it as it goes "
                + "and lighting it every `torch_every` blocks if you carry torches. `slope`:\"up\" "
                + "cuts a STAIRCASE instead — that is how you climb out of a mine, and with "
                + "`until_sky`:true or `to_y` it is your route home from any depth (a straight-up "
                + "pillar is refused by terrain the staircase simply walks). \"down\" descends the "
                + "same way. It is a goal, so it repairs its own footing, obeys a break budget, and "
                + "returns a LEDGER of every cell actually mined — a tunnel that stops early "
                + "resumes without a survey. Honest stops: fluid_ahead (it will never dig water or "
                + "lava — displace it yourself and re-issue), unbreakable_ahead, "
                + "break_budget_spent, stuck. Pass `wait`:true for the final outcome.",
            Schemas.objectOpt(Schemas.object(
                "direction", Schemas.str("north|south|east|west (default: the way the body faces)."),
                "length", Schemas.integer("Blocks to advance (default 16, max 128)."),
                "height", Schemas.integer("Corridor height: 2 (default) or 3."),
                "slope", Schemas.str("flat (default) | up (staircase, the way home) | down."),
                "torch_every", Schemas.integer("Place a torch every N blocks (0/absent = none)."),
                "to_y", Schemas.integer("Sloped tunnels: stop when the feet reach this y."),
                "until_sky", Schemas.bool("Sloped tunnels: stop at the first cell under open sky."),
                "wait", Schemas.bool("If true, the call returns only when the tunnel finishes/stops.")),
                "direction", "length", "height", "slope", "torch_every", "to_y", "until_sky", "wait"),
            ExecutionContext.SERVER,
            Mechanism.EMBODIED,
            (ctx, a) -> {
                Slot slot = slotFor(ctx.sessionId());
                CompletableFuture<JsonElement> waiter = wantsWait(a) ? new CompletableFuture<>() : null;
                JsonObject r = GoalRunner.startTunnel(a, slot, waiter);
                if (waiter != null && r.get("started").getAsBoolean()) {
                    return waiter;
                }
                return CompletableFuture.completedFuture(r);
            }).withTimeout(WAIT_TIMEOUT_SECONDS * 3));

        McpTools.register(ToolDef.of(
            "bot_status",
            "Report YOUR embodiment: which body is active (player, walker, drone, or possessed mob), "
                + "its position/facing/health — for a player body also hunger, air, and current "
                + "`dangers` — plus the SPATIAL SENSE: `sees_sky`, `light` {sky, block}, "
                + "`enclosed`:true when the body is sealed in on all six sides (underground in "
                + "solid rock — looking around reveals nothing there; mining is the only eye), and "
                + "when NOT sealed but under a roof, `open_directions` — which of up/down/N/E/S/W "
                + "have passable space within 8 blocks (the ways out) — "
                + "whether it is moving (with `speed_known`/`speed_delta` in blocks/second while "
                + "it is), plus follow mode, a running bot_run queue, a "
                + "running bot_target goal, and combat state (engaged/mode/designated targets). Pass "
                + "`inventory`:true to include the carried inventory (every non-empty slot "
                + "{slot,item,count}, the size, and the held slot) — this IS the inventory check; "
                + "there is no separate inventory tool. Returns spawned=false if your session has no "
                + "body (other sessions' bodies are listed under `others`).",
            Schemas.objectOpt(Schemas.object(
                "inventory", Schemas.bool("Include the carried inventory in the report.")),
                "inventory"),
            ExecutionContext.SERVER,
            Mechanism.OBSERVE,
            (ctx, a) -> {
                Slot slot = slotFor(ctx.sessionId());
                JsonObject r = botStatus(slot);
                if (a.has("inventory") && !a.get("inventory").isJsonNull()
                    && a.get("inventory").getAsBoolean()) {
                    r.add("inventory", DroneHands.botInventory(slot));
                }
                return r;
            }));

    }

    // ---- tool bodies (server thread) -----------------------------------------

    static boolean wantsWait(final JsonObject a) {
        return a.has("wait") && !a.get("wait").isJsonNull() && a.get("wait").getAsBoolean();
    }

    /** Drop the drone's carried inventory into the world at its position (on commanded despawn). */
    private static void dropInventory(final BotBodyEntity drone) {
        var inv = drone.inventory();
        for (int i = 0; i < inv.getContainerSize(); i++) {
            var st = inv.getItem(i);
            if (!st.isEmpty()) {
                net.minecraft.world.level.block.Block.popResource(
                    (ServerLevel) drone.level(), drone.blockPosition(), st.copy());
                st.setCount(0);
            }
        }
    }

    /** How far from the anchor a body may be placed before the spawn is refused instead. Small on
     *  purpose: "near the player" is the contract, and a body that appears 40 blocks away has
     *  silently answered a different request. */
    private static final int SPAWN_SEARCH_RADIUS = 8;
    /** How far up and down each column is probed. Deep enough to climb out of a spectator's hillside
     *  or drop to a cave floor; bounded so a body never surfaces from bedrock into daylight. */
    private static final int SPAWN_SEARCH_VERTICAL = 16;

    /**
     * A cell a body can occupy without immediately dying in it: two free cells with a floor under
     * them, and no lava in any of the three.
     *
     * <p>Water is deliberately ALLOWED. It is survivable, the swim stack exists to handle it
     * (BOT_SURFACE_DESIGN §12.4), and refusing it would make an ocean-side respawn impossible;
     * `air_below` then fires as the honest warning it is meant to be. Lava is not survivable and is
     * refused outright.
     */
    /**
     * How far a grounded body may be placed above its floor. Four blocks is a fall that costs
     * nothing (vanilla fall damage starts past three) — beyond it, a spawn is guessing at where the
     * caller meant, and the ring search will find a better cell anyway.
     */
    private static final int SPAWN_MAX_DROP = 4;

    /**
     * Is there something to land on within {@link #SPAWN_MAX_DROP} of these feet? Solid ground or a
     * non-lava fluid both count — water is a survivable landing, and the swim stack handles it.
     * Lava underfoot ends the search: falling into it is exactly the death this guard prevents.
     */
    private static boolean hasFooting(final ServerLevel level, final BlockPos feet) {
        for (int drop = 1; drop <= SPAWN_MAX_DROP; drop++) {
            BlockPos below = feet.below(drop);
            if (level.isOutsideBuildHeight(below)) {
                return false;
            }
            if (level.getFluidState(below).is(net.minecraft.tags.FluidTags.LAVA)) {
                return false;
            }
            if (!level.getFluidState(below).isEmpty()) {
                return true; // water: a landing, not a hazard
            }
            if (!level.getBlockState(below)
                .isPathfindable(net.minecraft.world.level.pathfinder.PathComputationType.LAND)) {
                return true; // solid ground
            }
        }
        return false;
    }

    private static boolean spawnable(final ServerLevel level, final BlockPos feet, final boolean needsFloor) {
        if (level.isOutsideBuildHeight(feet) || level.isOutsideBuildHeight(feet.above())) {
            return false;
        }
        // Same clearance predicate the navigator uses (Vantage.standable, BuildWalkNodeEvaluator):
        // one definition of "a body fits here", so a spawn cannot land somewhere nav calls solid.
        boolean feetClear = level.getBlockState(feet)
            .isPathfindable(net.minecraft.world.level.pathfinder.PathComputationType.LAND);
        boolean headClear = level.getBlockState(feet.above())
            .isPathfindable(net.minecraft.world.level.pathfinder.PathComputationType.LAND);
        // A FLYER hovers, so demanding a floor under it would refuse the open air it is built for —
        // and would have quietly changed what `bot_body {type:"flyer"}` means while fixing a bug
        // about grounded bodies.
        //
        // "Footing" is a floor within a SURVIVABLE DROP, not a floor pressed against the feet. The
        // entombment fix this guard was written for is the clearance test above (a spectator sitting
        // inside terrain has no free cell); demanding a solid block directly underneath went further
        // than that and refused ordinary mid-air spawns, where the body simply falls a block and
        // stands up. Live consequence, found by the battery at 0.46.0: five probe files and ~24
        // assertions asked to spawn one or two blocks over their own staged floor and were refused —
        // and so would any agent that says "put me above that ground I can see".
        boolean hasFloor = hasFooting(level, feet);
        if (!feetClear || !headClear || (needsFloor && !hasFloor)) {
            return false;
        }
        for (BlockPos p : new BlockPos[] { feet.below(), feet, feet.above() }) {
            if (level.getFluidState(p).is(net.minecraft.tags.FluidTags.LAVA)) {
                return false;
            }
        }
        // ...AND NOT SUBMERGED. Lava was refused here from the start; water was not, so a respawn
        // could place a body underwater with its air already draining. `a87c11eb` 13:17:30 respawned
        // into a flooded cave at (60.75, 61, 7.3) — `submerged:true`, inventory empty — and drowned
        // without ever moving (PERCEPTION_NAV_FIXES §5).
        //
        // The test is the HEAD cell, not "any fluid touching the body". Feet in shallow water is
        // wading, which is survivable and ordinary at any shoreline; refusing it would refuse a large
        // share of legitimate coastal spawns and change what `pos` means for callers who know exactly
        // where they want to stand. Head under water is drowning, and nobody ever wants to start
        // there. Breathing bodies only — a flyer is a tool body with no air supply, and widening this
        // to it would alter what bot_body {type:"flyer"} accepts while fixing a bug about bodies that
        // breathe.
        if (needsFloor && level.getFluidState(feet.above()).is(net.minecraft.tags.FluidTags.WATER)) {
            return false;
        }
        return true;
    }

    /**
     * The nearest cell to {@code wanted} a body can be put in, or null if there is none within
     * {@link #SPAWN_SEARCH_RADIUS}.
     *
     * <p>Search order is nearest-first in the way that matters to the caller: the requested COLUMN
     * is probed before any neighbour, from the requested Y outwards (0, +1, −1, +2, −2, …), so a
     * body asked for inside a hillside comes out at the nearest opening of that hillside rather than
     * teleporting sideways. Only when the whole column fails does it try rings outward.
     */
    private static @Nullable Vec3 safeSpawnNear(final ServerLevel level, final Vec3 wanted,
                                                final boolean needsFloor) {
        SpawnPick pick = pickSpawn(level, wanted, needsFloor, java.util.List.of());
        return pick == null ? null : pick.pos();
    }

    /** How far from a hostile a spawn cell would rather be. Beyond a spider's notice-and-close range. */
    private static final double SPAWN_HOSTILE_CLEARANCE = 8.0;
    /** How far around the anchor hostiles are gathered for that test. */
    private static final double SPAWN_HOSTILE_SCAN = 24.0;
    /** Ring bands the search escalates through when the inner one has no hostile-free cell. The old
     *  single radius EQUALLED the clearance (both 8), which made the quiet test unsatisfiable
     *  whenever a hostile stood near the anchor — precisely when it mattered (w2-79881: respawned
     *  8 blocks from the skeleton that had just made the corpse, twice). */
    private static final int[] SPAWN_RING_BANDS = { SPAWN_SEARCH_RADIUS, 16, 24 };

    /** A chosen spawn cell: where, whether it clears every hostile, and by how much. */
    record SpawnPick(Vec3 pos, boolean quiet, double hostileDistance) {}

    /**
     * The best survivable cell near {@code wanted}: hostile-free if one exists in the innermost
     * band that has any (escalating outward), chosen by hostile clearance FIRST, closeness to the
     * anchor second, sky access as the tiebreak. When no cell anywhere clears the hostiles, the
     * fallback is the survivable cell FARTHEST from them — never the one nearest the anchor, which
     * under a contested anchor is the one nearest the fight.
     *
     * <p>Preference, never refusal: a respawn has to succeed even when the whole area is hostile,
     * and a body that cannot spawn is worse than one that spawns in danger and is TOLD so
     * ({@code quiet:false} → the caller marks {@code spawned_unsafe} and events it).
     */
    private static @Nullable SpawnPick pickSpawn(final ServerLevel level, final Vec3 wanted,
                                                 final boolean needsFloor,
                                                 final java.util.List<? extends Entity> hostiles) {
        BlockPos origin = BlockPos.containing(wanted);
        Vec3 bestUnsafe = null;
        double bestUnsafeDist = -1.0;
        int innerEdge = 0;
        for (int band : SPAWN_RING_BANDS) {
            Vec3 bestQuiet = null;
            double bestQuietScore = -Double.MAX_VALUE;
            for (int r = innerEdge; r <= band; r++) {
                for (int dx = -r; dx <= r; dx++) {
                    for (int dz = -r; dz <= r; dz++) {
                        // Ring, not disc: the inner cells were covered by a previous, closer r.
                        if (r > 0 && Math.abs(dx) != r && Math.abs(dz) != r) {
                            continue;
                        }
                        for (int i = 0; i <= 2 * SPAWN_SEARCH_VERTICAL; i++) {
                            int dy = (i % 2 == 0) ? i / 2 : -((i + 1) / 2); // 0, -1, 1, -2, 2, …
                            BlockPos feet = origin.offset(dx, dy, dz);
                            if (!spawnable(level, feet, needsFloor)) {
                                continue;
                            }
                            // Block centre, feet on the floor — the same convention teleportTo and
                            // FakePlayers.spawn expect.
                            Vec3 cell = new Vec3(feet.getX() + 0.5, feet.getY(), feet.getZ() + 0.5);
                            double hd = nearestHostileDistance(cell, hostiles);
                            if (hd >= SPAWN_HOSTILE_CLEARANCE) {
                                // Clearance dominates (capped at 16 — past that, farther is not
                                // safer), anchor closeness breaks ties, sky access nudges.
                                double score = Math.min(hd, 16.0) * 100.0 - cell.distanceTo(wanted)
                                    + (level.canSeeSky(feet.above()) ? 0.5 : 0.0);
                                if (score > bestQuietScore) {
                                    bestQuietScore = score;
                                    bestQuiet = cell;
                                }
                            } else if (hd > bestUnsafeDist) {
                                bestUnsafeDist = hd;
                                bestUnsafe = cell;
                            }
                        }
                    }
                }
            }
            if (bestQuiet != null) {
                return new SpawnPick(bestQuiet, true,
                    nearestHostileDistance(bestQuiet, hostiles));
            }
            innerEdge = band + 1;
        }
        return bestUnsafe == null ? null : new SpawnPick(bestUnsafe, false, bestUnsafeDist);
    }

    /** Distance from this cell to the nearest listed hostile (infinite when there are none). */
    private static double nearestHostileDistance(final Vec3 cell,
                                                 final java.util.List<? extends Entity> hostiles) {
        double best = Double.POSITIVE_INFINITY;
        for (Entity h : hostiles) {
            best = Math.min(best, h.position().distanceTo(cell));
        }
        return best;
    }

    /** Living hostiles around a spawn anchor — the {@link Enemy} marker, as the reflex layer uses. */
    private static java.util.List<Entity> hostilesNear(final ServerLevel level, final Vec3 at) {
        return level.getEntities((Entity) null,
            new net.minecraft.world.phys.AABB(at, at).inflate(SPAWN_HOSTILE_SCAN),
            e -> e instanceof net.minecraft.world.entity.monster.Enemy && e.isAlive());
    }

    /** The hostiles a fresh body should know about, nearest first, as a reply field. */
    private static JsonArray hostilesReport(final Vec3 pos, final java.util.List<? extends Entity> hostiles) {
        java.util.List<? extends Entity> sorted = hostiles.stream()
            .sorted(java.util.Comparator.comparingDouble(e -> e.position().distanceTo(pos)))
            .limit(8)
            .toList();
        JsonArray out = new JsonArray();
        for (Entity h : sorted) {
            JsonObject o = new JsonObject();
            o.addProperty("type", net.minecraft.core.registries.BuiltInRegistries.ENTITY_TYPE
                .getKey(h.getType()).toString());
            o.addProperty("distance", round3(h.position().distanceTo(pos)));
            addVec(o, "pos", h.position());
            out.add(o);
        }
        return out;
    }

    /** How long a death site stays the preferred respawn anchor (10 minutes — drop-despawn time). */
    private static final long DEATH_ANCHOR_TICKS = 12000;

    private static JsonObject botSpawn(final MinecraftServer server, final JsonObject a, final Slot slot) {
        ServerLevel level;
        Vec3 pos;
        SpawnPick pick = null;
        String anchorKind = null;
        // Body kind decides what "safe" means, so it has to be known BEFORE the position is chosen:
        // a grounded body needs a floor, a flyer needs only clearance.
        String type = a.has("type") && !a.get("type").isJsonNull() ? a.get("type").getAsString() : "flyer";
        boolean needsFloor = !"flyer".equals(type);
        if (a.has("pos") && !a.get("pos").isJsonNull()) {
            JsonObject p = a.getAsJsonObject("pos");
            pos = new Vec3(p.get("x").getAsDouble(), p.get("y").getAsDouble(), p.get("z").getAsDouble());
            level = com.mattmc.mcptoolkit.WorldPerceptionTools.levelArg(server, a);
            // A STATED position is never silently moved — quietly relocating it would be the same
            // class of lie as quietly ignoring it. It is checked and REFUSED, with the nearest place
            // that would work named, so the caller decides.
            if (!spawnable(level, BlockPos.containing(pos), needsFloor)) {
                Vec3 alt = safeSpawnNear(level, pos, needsFloor);
                throw new IllegalArgumentException("a " + type + " cannot exist at "
                    + BlockPos.containing(pos).toShortString() + ": "
                    + (needsFloor ? "it needs two free cells with something to land on within "
                        + SPAWN_MAX_DROP + " blocks below, out of lava, and not head-under-water"
                                  : "it needs two free cells, out of lava")
                    + (alt == null
                        ? " — and nothing within " + SPAWN_SEARCH_RADIUS + " blocks would work either"
                        : " — the nearest cell that works is "
                          + BlockPos.containing(alt).toShortString()));
            }
        } else {
            // ANCHOR CHOICE. After a death, the anchor is the DEATH SITE (drops and the agent's
            // mental map are there) — not the watching human, who in w2-79881 was standing next to
            // the killer, so "near the player" respawned the body straight back into the kill zone
            // twice. First spawns (no recent death in this level) still anchor on the player; the
            // `near` arg overrides either way. An explicit near:"death" needs no human online at
            // all — its level is the death's own dimension.
            String near = a.has("near") && !a.get("near").isJsonNull()
                ? a.get("near").getAsString() : null;
            if ("death".equals(near)) {
                if (slot.lastDeathPos == null) {
                    throw new IllegalArgumentException("near:\"death\" but this session has no "
                        + "recorded death — omit `near`, or pass pos/near:\"player\"");
                }
                ServerLevel deathLevel = null;
                for (ServerLevel l : server.getAllLevels()) {
                    if (l.dimension().identifier().toString().equals(slot.lastDeathDim)) {
                        deathLevel = l;
                        break;
                    }
                }
                if (deathLevel == null) {
                    throw new IllegalStateException("the death dimension " + slot.lastDeathDim
                        + " is not loaded — pass an explicit `pos` {x,y,z}");
                }
                level = deathLevel;
                anchorKind = "death_site";
                pick = pickSpawn(level, slot.lastDeathPos, needsFloor,
                    hostilesNear(level, slot.lastDeathPos));
                if (pick == null) {
                    throw new IllegalStateException("no safe place to put a body within "
                        + SPAWN_RING_BANDS[SPAWN_RING_BANDS.length - 1] + " blocks of the death "
                        + "site at " + BlockPos.containing(slot.lastDeathPos).toShortString()
                        + " — pass an explicit `pos` {x,y,z}");
                }
                pos = pick.pos();
            } else {
                List<ServerPlayer> players = server.getPlayerList().getPlayers();
                if (players.isEmpty()) {
                    throw new IllegalStateException("no player online; pass an explicit `pos` {x,y,z}");
                }
                ServerPlayer player = players.get(0);
                level = (ServerLevel) player.level();
                boolean deathFresh = slot.lastDeathPos != null
                    && level.dimension().identifier().toString().equals(slot.lastDeathDim)
                    && level.getGameTime() - slot.lastDeathTick <= DEATH_ANCHOR_TICKS;
                Vec3 anchor;
                if ("player".equals(near) || !deathFresh) {
                    // The player anchor used to be the ANSWER: `player.position().add(0, 2, 0)`,
                    // no test of any kind — catastrophic the moment the watcher is a spectator
                    // inside terrain (w2-75927: two respawns entombed at the spectator's y+2).
                    anchor = player.position();
                    anchorKind = "player";
                } else {
                    anchor = slot.lastDeathPos;
                    anchorKind = "death_site";
                }
                pick = pickSpawn(level, anchor, needsFloor, hostilesNear(level, anchor));
                if (pick == null) {
                    throw new IllegalStateException("no safe place to put a body within "
                        + SPAWN_RING_BANDS[SPAWN_RING_BANDS.length - 1] + " blocks of the "
                        + anchorKind + " at " + BlockPos.containing(anchor).toShortString()
                        + " (every candidate was solid, lava, or had no floor) — pass an explicit "
                        + "`pos` {x,y,z}, or move to somewhere a body could stand");
                }
                pos = pick.pos();
            }
        }

        // One body per session: retire the caller's existing PLAYER body first (evented below), then
        // any drone. A replace must not leave two bodies answering to one session.
        FakePlayerEntity previousPlayer = slot.player();
        if (previousPlayer != null) {
            QueueRunner.abort(slot, "body_replaced");
            GoalRunner.abort(slot, "body_replaced");
            if (slot.pendingNav != null && slot.pendingNav.body == previousPlayer) {
                failPending(slot, "body_replaced");
            }
            DroneHands.abort(slot, "body_replaced"); // a player-hands dig dies with its body
            Follow.clear(slot);
            FakePlayers.despawn(server, previousPlayer.getGameProfile().name(), "replaced");
            slot.player = null;
            slot.observer.reset();
            Perception.reset(slot);
            JsonObject d = new JsonObject();
            d.addProperty("reason", "replaced");
            EventLog.emit("body_removed", d, slot.target());
        }
        // One drone per session: retire the caller's existing one first (evented as "replaced").
        BotBodyEntity previous = slot.drone();
        if (previous != null) {
            QueueRunner.abort(slot, "drone_replaced");
            GoalRunner.abort(slot, "drone_replaced"); // a goal must not continue on the fresh body
            if (slot.pendingNav != null && slot.pendingNav.body == previous) {
                failPending(slot, "drone_replaced");
            }
            DroneHands.abort(slot, "drone_replaced");
            // Same courtesy as a commanded despawn: repositioning must not vaporize carried loot.
            dropInventory(previous);
            previous.discard();
            slot.drone = null;
            slot.hadDrone = false;
            slot.lastHealth = -1;
            slot.observer.reset(); // the new drone re-observes from scratch at its own position
            Perception.reset(slot); // a fresh body carries no perception memory from the old one
            JsonObject d = new JsonObject();
            d.addProperty("reason", "replaced");
            EventLog.emit("drone_removed", d, slot.target());
        }

        // Body kind (read at the top of this method, because the position search needs it): the
        // flying recon drone (default), the grounded player-shaped walker (§11.3), or the REAL
        // player body (§11.8 widening) — a headless ServerPlayer: in the tab list, hunted natively
        // by hostiles, real inventory that auto-collects drops, real hunger.
        if ("player".equals(type)) {
            FakePlayerEntity playerBody;
            try {
                playerBody = FakePlayers.spawn(server, level, slot.fakeName(), pos, 0.0F);
            } catch (IllegalStateException e) {
                throw new IllegalStateException("could not spawn the player body: " + e.getMessage());
            }
            slot.player = playerBody;
            JsonObject r = new JsonObject();
            r.addProperty("id", playerBody.getId());
            r.addProperty("uuid", playerBody.getUUID().toString());
            r.addProperty("type", "player");
            r.addProperty("name", playerBody.getGameProfile().name());
            addVec(r, "pos", playerBody.position());
            r.addProperty("note", "a real (headless) player: tab list, native mob targeting, real "
                + "inventory that auto-collects drops, real hunger — eat to survive. Full verb "
                + "surface: goto/look/attack/eat/equip + mine/place/use/shoot/craft (engine dig "
                + "timing — hold the right tool) + bot_target goals");
            // WHO IS ALREADY HERE. A player body is hunted natively from the tick it exists, and the
            // first thing it needs to know is what is looking at it — one poll later is a poll too
            // late when a fresh body has 20 health, no armour and no weapon (session w1-85918 lost
            // its first body inside 9 seconds this way). Only reported, never acted on: what to do
            // about a spider 3 blocks away is the agent's call.
            addSpawnThreats(r, level, playerBody.position());
            addSpawnQuality(r, level, slot, pick, anchorKind);
            return r;
        }
        BotBodyEntity drone = switch (type) {
            case "flyer" -> DroneEntities.DRONE.spawn(level, BlockPos.containing(pos), EntitySpawnReason.MOB_SUMMONED);
            case "walker" -> DroneEntities.WALKER.spawn(level, BlockPos.containing(pos), EntitySpawnReason.MOB_SUMMONED);
            default -> throw new IllegalArgumentException("unknown `type` '" + type + "' (flyer | walker | player)");
        };
        if (drone == null) {
            throw new IllegalStateException("could not spawn the " + type + " at " + BlockPos.containing(pos).toShortString());
        }
        drone.teleportTo(pos.x, pos.y, pos.z);
        // Nameplate = the owning session: the human's visual handle on WHOSE body this is, and the
        // anchor for /mmcp body tp. Broadcast-slot bodies read "bot".
        String plate = slot.target() != null ? slot.target() : "bot";
        drone.setCustomName(net.minecraft.network.chat.Component.literal(plate));
        drone.setCustomNameVisible(true);
        slot.drone = drone;

        JsonObject r = new JsonObject();
        r.addProperty("id", drone.getId());
        r.addProperty("uuid", drone.getUUID().toString());
        r.addProperty("type", type);
        addVec(r, "pos", drone.position());
        addSpawnThreats(r, level, drone.position());
        addSpawnQuality(r, level, slot, pick, anchorKind);
        return r;
    }

    /**
     * How good the chosen spawn cell actually is — the placement's own inputs, disclosed. When the
     * hostile-clearance rule could not be met anywhere, {@code spawned_unsafe:true} plus an urgent
     * {@code spawned_in_danger} event: a body placed in a kill zone must know it is in one before
     * its first poll, not after its first arrow.
     */
    private static void addSpawnQuality(final JsonObject r, final ServerLevel level,
                                        final Slot slot, final @Nullable SpawnPick pick,
                                        final @Nullable String anchorKind) {
        if (pick == null) {
            return; // explicit-pos spawn: the caller chose the cell; hostiles_nearby still reports
        }
        JsonObject q = new JsonObject();
        if (anchorKind != null) {
            q.addProperty("anchor", anchorKind);
        }
        if (pick.hostileDistance() != Double.POSITIVE_INFINITY) {
            q.addProperty("hostile_clearance", round3(pick.hostileDistance()));
        }
        q.addProperty("sees_sky", level.canSeeSky(BlockPos.containing(pick.pos()).above()));
        r.add("spawn_quality", q);
        if (!pick.quiet()) {
            r.addProperty("spawned_unsafe", true);
            JsonObject d = new JsonObject();
            addVec(d, "pos", pick.pos());
            d.addProperty("hostile_distance", round3(pick.hostileDistance()));
            d.addProperty("note", "NO cell within " + SPAWN_RING_BANDS[SPAWN_RING_BANDS.length - 1]
                + " blocks cleared every hostile by " + SPAWN_HOSTILE_CLEARANCE + " — this is the "
                + "cell FARTHEST from them, and it is still contested. Arm reflexes and move NOW");
            EventLog.emit("spawned_in_danger", d, slot.target());
        }
    }

    /**
     * Attach {@code hostiles_nearby} when a fresh body has company. Silent when it does not: an
     * empty array on every quiet spawn is a field agents learn to skip, and this one has to be read.
     */
    private static void addSpawnThreats(final JsonObject r, final ServerLevel level, final Vec3 pos) {
        java.util.List<Entity> hostiles = hostilesNear(level, pos).stream()
            .filter(h -> h.position().distanceTo(pos) <= SPAWN_HOSTILE_SCAN)
            .toList();
        if (hostiles.isEmpty()) {
            return;
        }
        r.add("hostiles_nearby", hostilesReport(pos, hostiles));
        boolean adjacent = hostiles.stream()
            .anyMatch(h -> h.position().distanceTo(pos) < SPAWN_HOSTILE_CLEARANCE);
        r.addProperty("spawn_threat_note", adjacent
            ? "HOSTILES ARE ON TOP OF YOU — no quieter cell existed within the search radius. You "
                + "have full health and nothing else: arm bot_reactions {preset:\"survival\"} NOW, "
                + "then get away or fight deliberately; a fresh body loses a straight melee"
            : "hostiles are in the area but not adjacent — arm bot_reactions {preset:\"survival\"} "
                + "before you go anywhere near them");
    }

    /** Parse and validate the `to` {x,y,z} / `reach` {x,y,z} target — shared by the pre-teardown
     * check and startNav. For a reach goal the returned point is the block's center (the distance
     * metrics anchor); the goal itself is carried by {@link #reachTargetArg}. */
    static Vec3 navTarget(final JsonObject a) {
        BlockPos reach = reachTargetArg(a);
        if (reach != null) {
            if (a.has("to") && !a.get("to").isJsonNull()) {
                throw new IllegalArgumentException("give `to` (arrive at a point) OR `reach` (get in"
                    + " touching range of a block), not both");
            }
            return Vec3.atCenterOf(reach);
        }
        JsonObject to = a.getAsJsonObject("to");
        if (to == null || !to.has("x") || !to.has("y") || !to.has("z")) {
            throw new IllegalArgumentException("missing `to` {x,y,z} (or `reach` {x,y,z})");
        }
        return new Vec3(to.get("x").getAsDouble(), to.get("y").getAsDouble(), to.get("z").getAsDouble());
    }

    /** The `reach` goal block, or null when this is a plain `to` navigation. */
    static @Nullable BlockPos reachTargetArg(final JsonObject a) {
        if (!a.has("reach") || a.get("reach").isJsonNull()) {
            return null;
        }
        JsonObject o = a.getAsJsonObject("reach");
        if (o == null || !o.has("x") || !o.has("y") || !o.has("z")) {
            throw new IllegalArgumentException("`reach` must be {x,y,z} (a block position)");
        }
        return new BlockPos(o.get("x").getAsInt(), o.get("y").getAsInt(), o.get("z").getAsInt());
    }

    /** Parse the `within` arrival radius, defaulted and clamped. */
    static double withinArg(final JsonObject a) {
        double within = a.has("within") && !a.get("within").isJsonNull()
            ? a.get("within").getAsDouble() : DEFAULT_WITHIN;
        return Math.min(Math.max(within, MIN_WITHIN), MAX_WITHIN);
    }

    /**
     * Start a navigation on the active body. Shared by the manual {@code bot_goto} handler and queue
     * {@code goto} steps; {@code waiter}, when given, completes with the flight's final outcome.
     */
    /**
     * The profile echo for a plain FLIGHT (startNav — a follow, never a build). A player body's
     * follower strips build rights by design ({@link
     * com.mattmc.mcptoolkit.nav.NavProfile#withoutBuildRights}), so when the requested profile
     * carries them the echo keeps them — they explain WHY the leg exists — but flags
     * {@code walk_only}: no event may advertise a right the leg will not use (w1_42257: a-97's
     * completion echoed {@code may_modify:"break"} on a leg that could never dig).
     */
    private static JsonObject describeFlightProfile(final com.mattmc.mcptoolkit.nav.NavProfile profile,
                                                    final LivingEntity body) {
        JsonObject o = profile.describe();
        if (profile.modifiesWorld() && !(body instanceof Mob)) {
            o.addProperty("walk_only", true);
        }
        return o;
    }

    static JsonObject startNav(final JsonObject a, final Slot slot,
                               final @Nullable CompletableFuture<JsonElement> waiter) {
        LivingEntity body = requireBody(slot);
        BlockPos reach = reachTargetArg(a);
        Vec3 target = navTarget(a);
        double speed = a.has("speed") && !a.get("speed").isJsonNull() ? a.get("speed").getAsDouble() : 1.0;
        double requestedWithin = a.has("within") && !a.get("within").isJsonNull()
            ? a.get("within").getAsDouble() : DEFAULT_WITHIN;
        double within = withinArg(a);
        // The rights this flight runs under. bot_goto has always ACCEPTED `swim` (and the modify
        // flags); until now they were parsed nowhere on this path and the walk always planned with
        // DEFAULT. Parsed here so the plan, the driver and the echoed verdict agree.
        com.mattmc.mcptoolkit.nav.NavProfile profile =
            com.mattmc.mcptoolkit.nav.NavProfile.fromJson(a, true);

        JsonObject r = new JsonObject();
        // The arrival verdict is judged against the EFFECTIVE radius — echo it (and any clamp) so
        // the caller is never told stopped_short against a tolerance it did not choose.
        if (reach == null) {
            r.addProperty("within", within);
            if (within != requestedWithin) {
                r.addProperty("within_clamped_from", requestedWithin);
                r.addProperty("within_note", "requested `within` was outside " + MIN_WITHIN + ".."
                    + (int) MAX_WITHIN + " and was clamped; arrival is judged against " + within);
            }
        }
        java.util.Set<BlockPos> reachStands = null;
        boolean startTouch = false;
        if (reach != null) {
            // Goal-shaped navigation: resolve the touch shell against real geometry, then hand the
            // WHOLE shell to the body's own navigation — its NodeEvaluator (fly/walk/swim, whatever
            // this body is) picks the members it can occupy; the cheapest reachable one wins. The
            // solver stays mode-blind on purpose. Dead-ends fail here with the diagnosis pathing
            // could never produce: `occluded` means expose a face, not path harder.
            ServerLevel level = (ServerLevel) body.level();
            com.mattmc.mcptoolkit.ReachSolver.Result res =
                com.mattmc.mcptoolkit.ReachSolver.solve(level, reach, body.getEyeHeight(), true);
            JsonObject rj = new JsonObject();
            rj.addProperty("candidates", res.candidates());
            rj.addProperty("visible", res.visible());
            rj.addProperty("unreadable", res.unreadable());
            r.add("reach", rj);
            if (res.visible() == 0) {
                r.addProperty("started", false);
                if (res.unreadable() > 0) {
                    r.addProperty("reason", "reach_unresolved");
                    r.addProperty("note", res.unreadable() + " cell(s) of the touch shell were "
                        + "unreadable — forceload the area or move closer, then retry");
                } else {
                    r.addProperty("reason", "occluded");
                    r.addProperty("note", "no position within hand reach has line of sight to the "
                        + "block — it is enclosed; mine an occluder to expose a face first");
                }
                return r;
            }
            startTouch = com.mattmc.mcptoolkit.ReachSolver
                .touch(level, body.getEyePosition(), reach).ok();
            if (startTouch) {
                // A satisfied goal never moves the body — without this, A* still flies it to the
                // cheapest shell cell (measured: 1.6 blocks of pointless travel on a re-goto,
                // misreporting already_there as arrived). Park a pending flight with no navigation;
                // the tick watch completes it as already_there via the normal event/waiter path.
                Bodies.nav(body).stop();
                failPending(slot, "superseded");
                String actionId = "a-" + (++actionSeq);
                slot.pendingNav = new PendingNav(actionId, body, target, body.position(), within,
                    false, reach, true, profile, waiter);
                r.addProperty("started", true);
                r.addProperty("action_id", actionId);
                r.addProperty("reachable", true);
                r.addProperty("partial", false);
                r.addProperty("nodes", 0);
                r.addProperty("note", "already in touching range — completing without moving");
                addVec(r, "target", target);
                return r;
            }
            reachStands = res.stands();
        }

        boolean started;
        boolean reachable;
        boolean partial;
        BlockPos stand = null;
        if (body instanceof Mob mob) {
            // Vanilla Path flow — byte-identical to the pre-widening behavior for every Mob body.
            Path path = reachStands != null
                ? mob.getNavigation().createPath(reachStands, 0)
                : mob.getNavigation().createPath(target.x, target.y, target.z, 0);
            started = path != null && mob.getNavigation().moveTo(path, speed);
            reachable = path != null && path.canReach();
            partial = path != null && !path.canReach();
            r.addProperty("nodes", path == null ? 0 : path.getNodeCount());
            if (started && reachStands != null) {
                stand = path.getTarget();
            }
        } else {
            // Player body (PlayerNavigation): a solve either returns a followable full path or
            // refuses — there is no partial-walk arm to report.
            Bodies.Nav nav = Bodies.nav(body);
            if (reachStands != null) {
                stand = nav.moveToStands(reachStands, speed, profile);
                started = stand != null;
            } else {
                started = nav.moveTo(target.x, target.y, target.z, speed, profile);
            }
            reachable = started;
            partial = false;
            r.addProperty("nodes", nav.nodeCount());
        }

        r.addProperty("started", started);
        if (started) {
            failPending(slot, "superseded"); // a new move replaces any outstanding one
            String actionId = "a-" + (++actionSeq);
            slot.pendingNav = new PendingNav(actionId, body, target, body.position(), within,
                partial, reach, startTouch, profile, waiter);
            r.addProperty("action_id", actionId);
            r.add("profile", describeFlightProfile(profile, body));
            if (reach != null && stand != null) {
                JsonObject s = new JsonObject();
                s.addProperty("x", stand.getX());
                s.addProperty("y", stand.getY());
                s.addProperty("z", stand.getZ());
                r.add("stand", s);
            }
        } else if (!reachable && reach != null) {
            r.addProperty("reason", "no_path_to_reach_position");
        }
        r.addProperty("reachable", reachable);
        r.addProperty("partial", partial);
        addVec(r, "target", target);
        return r;
    }

    /** Aim the active body's eye — shared by {@code bot_look} and queue {@code look} steps. */
    static JsonObject doLook(final JsonObject a, final Slot slot) {
        LivingEntity body = requireBody(slot);
        if (a.has("at") && !a.get("at").isJsonNull()) {
            JsonObject at = a.getAsJsonObject("at");
            body.lookAt(EntityAnchorArgument.Anchor.EYES,
                new Vec3(at.get("x").getAsDouble(), at.get("y").getAsDouble(), at.get("z").getAsDouble()));
        } else if (a.has("yaw") || a.has("pitch")) {
            float yaw = a.has("yaw") && !a.get("yaw").isJsonNull() ? a.get("yaw").getAsFloat() : body.getYRot();
            float pitch = a.has("pitch") && !a.get("pitch").isJsonNull() ? a.get("pitch").getAsFloat() : body.getXRot();
            body.setYRot(yaw);
            body.setXRot(pitch);
        } else {
            throw new IllegalArgumentException("pass `yaw`/`pitch` or `at` {x,y,z}");
        }
        body.setYHeadRot(body.getYRot());
        body.setYBodyRot(body.getYRot());

        JsonObject r = new JsonObject();
        r.addProperty("yaw", body.getYRot());
        r.addProperty("pitch", body.getXRot());
        return r;
    }

    /** The pointer beam — shared by {@code bot_point} and queue {@code point} steps. Drone only. */
    static JsonObject doPoint(final JsonObject a, final Slot slot) {
        BotBodyEntity drone = requireDrone(slot);
        JsonObject r = new JsonObject();
        if (a.has("off") && !a.get("off").isJsonNull() && a.get("off").getAsBoolean()) {
            drone.clearBeam();
            r.addProperty("ok", true);
            r.addProperty("pointing", false);
            return r;
        }

        Vec3 at;
        if (a.has("at") && !a.get("at").isJsonNull()) {
            JsonObject p = a.getAsJsonObject("at");
            at = new Vec3(p.get("x").getAsDouble(), p.get("y").getAsDouble(), p.get("z").getAsDouble());
        } else if (a.has("target") && !a.get("target").isJsonNull()) {
            Entity e = ((ServerLevel) drone.level()).getEntity(a.get("target").getAsInt());
            if (e == null) {
                r.addProperty("ok", false);
                r.addProperty("reason", "no_target");
                return r;
            }
            at = e.getEyePosition();
        } else {
            throw new IllegalArgumentException("pass `at` {x,y,z}, `target` (entity id), or `off`:true");
        }

        double seconds = a.has("seconds") && !a.get("seconds").isJsonNull()
            ? a.get("seconds").getAsDouble() : 5.0;
        int ticks = (int) Math.round(Math.min(Math.max(seconds, 0.5), 60.0) * 20.0);
        drone.setBeam(BotBodyEntity.BEAM_POINT, at, ticks);
        drone.lookAt(EntityAnchorArgument.Anchor.EYES, at);
        drone.setYHeadRot(drone.getYRot());
        drone.setYBodyRot(drone.getYRot());

        r.addProperty("ok", true);
        r.addProperty("pointing", true);
        addVec(r, "at", at);
        r.addProperty("seconds", ticks / 20.0);
        return r;
    }

    private static JsonObject botFollow(final MinecraftServer server, final JsonObject a, final Slot slot) {
        JsonObject r = new JsonObject();
        if (a.has("stop") && !a.get("stop").isJsonNull() && a.get("stop").getAsBoolean()) {
            boolean was = slot.follow != null;
            Follow.clear(slot);
            LivingEntity body = slot.activeBody();
            if (body != null) {
                Bodies.nav(body).stop();
            }
            r.addProperty("following", false);
            r.addProperty("stopped", was);
            return r;
        }

        LivingEntity body = requireBody(slot);
        Entity target;
        if (a.has("player") && !a.get("player").isJsonNull()) {
            String name = a.get("player").getAsString();
            target = server.getPlayerList().getPlayerByName(name);
            if (target == null) {
                throw new IllegalArgumentException("no player named '" + name + "' online");
            }
        } else if (a.has("target") && !a.get("target").isJsonNull()) {
            target = ((ServerLevel) body.level()).getEntity(a.get("target").getAsInt());
            if (target == null || !target.isAlive()) {
                throw new IllegalArgumentException("no such entity (id " + a.get("target").getAsInt()
                    + ") in the body's level");
            }
        } else {
            throw new IllegalArgumentException("pass `target` (entity id), `player` (name), or `stop`:true");
        }
        if (target == body) {
            throw new IllegalArgumentException("the body cannot follow itself");
        }
        // The player lookup resolves across dimensions; the body can only follow in its own level.
        // Refuse now instead of returning following:true and losing it on the very next tick.
        if (target.level() != body.level()) {
            throw new IllegalArgumentException("target_in_other_dimension: '"
                + target.getName().getString() + "' is in "
                + target.level().dimension().identifier() + " but the body is in "
                + body.level().dimension().identifier());
        }

        double distance = a.has("distance") && !a.get("distance").isJsonNull()
            ? a.get("distance").getAsDouble() : 4.0;
        distance = Math.min(Math.max(distance, 1.0), 16.0);
        double height = a.has("height") && !a.get("height").isJsonNull()
            ? a.get("height").getAsDouble()
            : (body instanceof DroneEntity ? 2.5 : 0.0); // only the FLYER hovers above its target
        height = Math.min(Math.max(height, -8.0), 16.0);
        String look = a.has("look") && !a.get("look").isJsonNull() ? a.get("look").getAsString() : "target";
        if (!"target".equals(look) && !"mirror".equals(look) && !"forward".equals(look)) {
            throw new IllegalArgumentException("`look` must be target|mirror|forward");
        }

        claimBase(slot, BaseKind.FOLLOW, "follow_started"); // continuous mode wins over queue/follow
        failPending(slot, "superseded");                    // and over a loose manual flight
        slot.follow = new Follow(target, distance, height, look);

        r.addProperty("following", true);
        r.addProperty("target_id", target.getId());
        r.addProperty("target_type", BuiltInRegistries.ENTITY_TYPE.getKey(target.getType()).toString());
        r.addProperty("distance", distance);
        r.addProperty("height", height);
        r.addProperty("look", look);
        return r;
    }

    /**
     * The {@code bot_body} dispatcher: everything that answers "which body am I driving, and how does
     * it behave" — spawn/despawn/possess/release plus the combat-engagement toggle. These are one
     * question at different arity, which is what licenses the merge (TOOL_BILL_PLAN.md §3).
     */
    private static JsonObject botBody(final MinecraftServer server, final JsonObject a, final Slot slot) {
        String action = a.has("action") && !a.get("action").isJsonNull()
            ? a.get("action").getAsString() : null;
        if (action == null) {
            throw new IllegalArgumentException(
                "missing `action` (spawn|despawn|possess|release|engage|guard|load)");
        }
        return switch (action) {
            case "spawn" -> botSpawn(server, a, slot);
            case "despawn" -> botDespawn(slot);
            case "possess" -> botPossess(server, a, slot);
            case "release" -> botRelease(slot);
            case "engage" -> setEngage(a, slot);
            case "guard" -> setGuard(a, slot);
            case "load" -> setLoad(slot);
            default -> throw new IllegalArgumentException("unknown `action` '" + action
                + "' (spawn|despawn|possess|release|engage|guard|load)");
        };
    }

    /**
     * Raise or lower the shield (COMBAT_KIT_PLAN.md §4.4, step 4). A posture, which is why it lives
     * on {@code bot_body} beside {@code engage} rather than becoming a verb of its own: the answer
     * to "how does this body behave right now", at one more arity.
     *
     * <p>The reflex layer is still the fast path — five ticks of block delay is not an agent-turn
     * decision, so {@code bot_reactions} with a {@code projectile_incoming} trigger is what actually
     * saves a body under fire. This is the DELIBERATE raise: crossing a corridor, closing on an
     * archer, holding a doorway. Both go through {@link Shields}, so the offhand policy, the
     * one-hand contention with a draw, and the accounting are shared.
     */
    private static JsonObject setGuard(final JsonObject a, final Slot slot) {
        boolean on = !a.has("on") || a.get("on").isJsonNull() || a.get("on").getAsBoolean();
        if (!on) {
            JsonObject r = new JsonObject();
            boolean was = slot.guard != null;
            Shields.lower(slot, "commanded");
            r.addProperty("ok", true);
            r.addProperty("blocking", false);
            r.addProperty("note", was ? "the shield is down" : "no shield was up");
            return r;
        }
        int ticks = a.has("ticks") && !a.get("ticks").isJsonNull()
            ? a.get("ticks").getAsInt() : Shields.DEFAULT_TICKS;
        return Shields.raise(slot, ticks);
    }

    /**
     * Wind a carried crossbow NOW (COMBAT_KIT_PLAN.md §4.3, step 5). A preparation, which is why it
     * lives on {@code bot_body} beside {@code guard}: both answer "get the body ready", and neither
     * is a thing done TO anything.
     *
     * <p>The body also does this by itself, between the shots of a ranged fight — that is the whole
     * point, since the 25 ticks are then paid out of time nobody was waiting on. This is the
     * deliberate version, for the moment before a fight rather than during one: walk up to a cave
     * mouth loaded, and the first bolt costs no draw at all.
     */
    private static JsonObject setLoad(final Slot slot) {
        return Crossbows.load(slot, "asked for");
    }

    /**
     * Arm or disarm combat, and set how it behaves. Engagement is a MODE, not a target: who counts as
     * an enemy comes from the threat table ({@code bot_target action:"attack"}), so a killed enemy
     * yields to the next instead of ending the fight (BOT_SURFACE_DESIGN.md §4).
     */
    private static JsonObject setEngage(final JsonObject a, final Slot slot) {
        JsonObject r = new JsonObject();
        if (a.has("mode") && !a.get("mode").isJsonNull()) {
            String mode = a.get("mode").getAsString();
            if (!"defend".equals(mode) && !"fight".equals(mode)) {
                throw new IllegalArgumentException("`mode` must be defend | fight");
            }
            slot.combatMode = mode;
        }
        // policy/range are FIGHT-MODE knobs: defend mode never reads them (Engage.tick returns
        // before station()). Accepting-and-echoing them in defend mode was a false affordance —
        // w2-79881 armed defend+kite@6 believing the body would keep its distance, and the fleeing
        // it then saw was the dodge reflex, not any policy. Refuse the dead knob instead.
        boolean defendAfter = "defend".equals(slot.combatMode);
        if (a.has("policy") && !a.get("policy").isJsonNull()) {
            if (defendAfter) {
                throw new IllegalArgumentException("`policy` is a fight-mode knob — defend mode "
                    + "fights only through reflexes and never reads it. Use mode:\"fight\", or "
                    + "drop the policy");
            }
            String policy = a.get("policy").getAsString();
            if (!"kite".equals(policy) && !"strafe".equals(policy)
                && !"close".equals(policy) && !"hold".equals(policy)) {
                throw new IllegalArgumentException("`policy` must be kite|strafe|close|hold");
            }
            slot.combatPolicy = policy;
        }
        if (a.has("range") && !a.get("range").isJsonNull()) {
            if (defendAfter) {
                throw new IllegalArgumentException("`range` is a fight-mode knob — defend mode "
                    + "fights only through reflexes and never reads it. Use mode:\"fight\", or "
                    + "drop the range");
            }
            slot.combatRange = Math.min(Math.max(a.get("range").getAsDouble(), 1.0), 24.0);
            slot.combatRangeExplicit = true;
        }
        if (a.has("clear_targets") && !a.get("clear_targets").isJsonNull()
            && a.get("clear_targets").getAsBoolean()) {
            slot.threats.clear();
        }
        boolean on = !a.has("on") || a.get("on").isJsonNull() || a.get("on").getAsBoolean();
        slot.engaged = on;
        if (!on) {
            Engage.clear(slot);
            LivingEntity body = slot.activeBody();
            if (body != null) {
                Bodies.nav(body).stop();
            }
        }

        r.addProperty("engaged", slot.engaged);
        r.addProperty("mode", slot.combatMode);
        if (!"defend".equals(slot.combatMode)) {
            // Only fight mode reads these; echoing them in defend mode dressed a dead knob up as
            // a live one (see the refusals above).
            r.addProperty("policy", slot.combatPolicy);
            // F4: the stand range FOLLOWS THE WEAPON, as the game itself fights — melee stations
            // inside swing reach, bow/crossbow keeps the skeleton's distance. An explicit `range`
            // clamps into that band; kite-at-6-with-a-sword (the fight the walker lost 20→0
            // without one swing) is unrequestable now, and the clamp SAYS so.
            //
            // "The weapon" is now what the body CARRIES AND CAN FEED, not what happens to be in
            // its hand (CombatKit.rangedCapable): the hand is the arming gate's business and is
            // settled at the shot, while a pickaxe left selected by the dig gate used to make an
            // archer station inside a zombie's reach. This reply is issued BEFORE there is an
            // enemy, so it can only answer the capability question; the station itself additionally
            // reads the distance and may close to melee with the same pack (Engage.station).
            LivingEntity rangedBody = slot.activeBody();
            boolean ranged = rangedBody != null && Engage.holdsRangedWeapon(rangedBody);
            double effective = Engage.standRange(slot, ranged);
            // The melee ceiling is PER BODY (Engage.meleeStandMax — the player body's honest reach
            // is the vanilla 3.0 attribute, toolkit bodies keep the disclosed 4.0), so report the
            // band this body actually fights in. Quoting the static MELEE_BAND_MAX here printed a
            // 3.25 ceiling next to a 2.25 clamp derived from a different number — three numbers for
            // one band, which is how a dead band hides in plain sight (the kite_note lesson).
            double meleeMax = rangedBody == null ? Engage.MELEE_BAND_MAX
                : Engage.meleeStandMax(rangedBody);
            r.addProperty("range", effective);
            r.addProperty("range_band", ranged ? "ranged (bow/crossbow): [6, 20]"
                : "melee: [" + Engage.MELEE_BAND_MIN + ", " + meleeMax + "]");
            if (slot.combatRangeExplicit && Math.abs(effective - slot.combatRange) > 1.0e-6) {
                r.addProperty("range_clamped", true);
                r.addProperty("note_range", "requested range " + slot.combatRange + " clamped to "
                    + effective + " — this body's weapon is " + (ranged ? "ranged, which fights at "
                    + "distance (band [6, 20])" : "melee (or empty hands), which must station "
                    + "inside swing reach (band [" + Engage.MELEE_BAND_MIN + ", "
                    + meleeMax + "]). CARRY a bow or crossbow AND ammunition for it to fight at "
                    + "range — the body reaches for it itself; it does not need to be held"));
            }
        }
        r.add("designated", slot.threats.describe());
        // Honest about the armed-but-empty case: engagement with no designations does nothing.
        //
        // In DEFEND mode that sentence understates it. Defend delegates ALL fighting to the reflex
        // layer (Engage: "this watch claims no movement"), so defend + a loadout with no combat
        // response is a body with combat switched on and no way to fight — which reads, from the
        // reply, exactly like a body that is now defended. Live, session w1-85918: engage defend was
        // called before each of three spawns, every armed loadout was missing its `fight` reaction,
        // and the body was killed twice without landing a blow. The human watching had to say it in
        // chat ("why are you not runnig away or engaging?") because nothing in the tool did.
        boolean defendWithoutReflexes = slot.engaged && "defend".equals(slot.combatMode)
            && !Reflexes.hasCombatResponse(slot);
        if (defendWithoutReflexes) {
            r.addProperty("no_combat_response", true);
            r.addProperty("note", "DEFEND MODE FIGHTS ONLY THROUGH REFLEXES, and none of yours "
                + "answers an attacker — as armed, this body takes hits without hitting back. Arm "
                + "bot_reactions {action:\"arm\", preset:\"survival\"} (which includes fight+dodge), "
                + "or switch to mode:\"fight\" and designate a target with bot_target "
                + "action:\"attack\"");
        } else if (slot.engaged && slot.threats.isEmpty()) {
            r.addProperty("note", "combat is ON but nothing is designated — it will not attack "
                + "anything until bot_target action:\"attack\" names a target or a kind"
                + (Reflexes.hasCombatResponse(slot)
                    ? " (your reflex loadout does answer attackers on its own)" : ""));
        }
        return r;
    }

    private static JsonObject botPossess(final MinecraftServer server, final JsonObject a, final Slot slot) {
        if (!a.has("target") || a.get("target").isJsonNull()) {
            throw new IllegalArgumentException("missing `target` (entity id)");
        }
        int id = a.get("target").getAsInt();
        Entity found = null;
        for (ServerLevel level : server.getAllLevels()) {
            found = level.getEntity(id);
            if (found != null) {
                break;
            }
        }
        if (found == null || !found.isAlive()) {
            throw new IllegalArgumentException("no living entity with id " + id);
        }
        if (found instanceof BotBodyEntity) {
            throw new IllegalArgumentException("cannot possess a toolkit body (it is already commanded)");
        }
        if (!(found instanceof Mob mob)) {
            throw new IllegalArgumentException("entity " + id + " ("
                + BuiltInRegistries.ENTITY_TYPE.getKey(found.getType()) + ") is not a possessable mob");
        }
        if (!mob.getBrain().isBrainDead()) {
            throw new IllegalStateException("brain_mob_unsupported: "
                + BuiltInRegistries.ENTITY_TYPE.getKey(mob.getType())
                + " is brain-driven (villager-like); possession currently covers goal-driven mobs only");
        }
        for (Slot s : SLOTS.values()) {
            if (s != slot && s.possession != null && s.possession.mob() == mob) {
                throw new IllegalStateException("that mob is already possessed by session " + s.owner);
            }
        }

        QueueRunner.abort(slot, "body_changed");
        GoalRunner.abort(slot, "body_changed"); // a goal must not silently continue on the new body
        failPending(slot, "body_changed");
        Possession.possess(slot, mob);

        JsonObject d = new JsonObject();
        d.addProperty("entity_id", mob.getId());
        d.addProperty("type", BuiltInRegistries.ENTITY_TYPE.getKey(mob.getType()).toString());
        EventLog.emit("possessed", d, slot.target());

        JsonObject r = new JsonObject();
        r.addProperty("possessed", true);
        r.addProperty("entity_id", mob.getId());
        r.addProperty("type", BuiltInRegistries.ENTITY_TYPE.getKey(mob.getType()).toString());
        r.addProperty("name", mob.getDisplayName() == null
            ? mob.getType().toShortString() : mob.getDisplayName().getString());
        r.addProperty("health", mob.getHealth());
        r.addProperty("maxHealth", mob.getMaxHealth());
        addVec(r, "pos", mob.position());
        r.addProperty("hands", false);
        return r;
    }

    private static JsonObject botRelease(final Slot slot) {
        JsonObject r = new JsonObject();
        if (slot.possession == null) {
            r.addProperty("released", false);
            return r;
        }
        QueueRunner.abort(slot, "body_changed");
        GoalRunner.abort(slot, "body_changed");
        if (slot.pendingNav != null && slot.pendingNav.body == slot.possession.mob()) {
            failPending(slot, "body_changed");
        }
        Possession.release(slot, "released");
        r.addProperty("released", true);
        r.addProperty("body", slot.drone() != null ? "drone" : "none");
        return r;
    }

    /** How far the six enclosure probes look before calling a direction open. */
    private static final int ENCLOSURE_PROBE_BLOCKS = 8;

    /**
     * The body's spatial sense: {@code sees_sky} (straight up is sky), {@code light} {sky, block}
     * at the feet, and the six enclosure probes — up, down, and the four cardinals, each walking
     * up to {@link #ENCLOSURE_PROBE_BLOCKS} cells. All blocked → {@code enclosed:true}: a body
     * sealed in rock, for which looking around cannot reveal anything mining would not. Some open
     * while the sky is NOT visible → {@code open_directions} names them (e.g. {@code ["down","N"]}
     * in a tunnel: the ways out of an enclosure are exactly what a body inside one needs, and the
     * probes were already computing them and throwing them away). Under open sky both are silent —
     * "open in most directions" is the boring state, and a field that is always present is a field
     * that is always paid for.
     */
    private static void addSpatialSense(final JsonObject r, final LivingEntity body) {
        ServerLevel level = (ServerLevel) body.level();
        BlockPos feet = body.blockPosition();
        boolean seesSky = level.canSeeSky(BlockPos.containing(body.getEyePosition()));
        r.addProperty("sees_sky", seesSky);
        JsonObject light = new JsonObject();
        light.addProperty("sky", level.getBrightness(net.minecraft.world.level.LightLayer.SKY, feet));
        light.addProperty("block", level.getBrightness(net.minecraft.world.level.LightLayer.BLOCK, feet));
        r.add("light", light);
        int[][] probes = { { 0, 1, 0 }, { 0, -1, 0 }, { 0, 0, -1 }, { 1, 0, 0 }, { 0, 0, 1 }, { -1, 0, 0 } };
        String[] names = { "up", "down", "N", "E", "S", "W" };
        com.google.gson.JsonArray openDirs = new com.google.gson.JsonArray();
        for (int p = 0; p < probes.length; p++) {
            int[] d = probes[p];
            boolean open = true;
            // Start at the head for horizontal probes; feet-level walls are floors half the time.
            BlockPos.MutableBlockPos cur = new BlockPos.MutableBlockPos(
                feet.getX(), feet.getY() + (d[1] == 0 ? 1 : (d[1] > 0 ? 2 : -1)), feet.getZ());
            for (int i = 0; i < ENCLOSURE_PROBE_BLOCKS; i++) {
                if (!level.isLoaded(cur)) {
                    break; // unloaded is unknown, not a wall — call the direction open
                }
                if (!level.getBlockState(cur)
                    .isPathfindable(net.minecraft.world.level.pathfinder.PathComputationType.LAND)) {
                    open = false;
                    break;
                }
                cur.move(d[0], d[1], d[2]);
            }
            if (open) {
                openDirs.add(names[p]);
            }
        }
        if (openDirs.isEmpty()) {
            r.addProperty("enclosed", true);
        } else if (!seesSky) {
            r.add("open_directions", openDirs);
        }
    }

    /** Below this a body is standing still and the two speed keys are noise, so they are left
     *  off entirely — the file's own idiom for a reading whose mere presence is the fact. */
    private static final double SPEED_EPSILON_BPS = 0.05;

    /**
     * <b>How fast the body is actually going — from the two witnesses that can disagree</b>
     * (COMBAT_CLINIC.md §9.4, check C6; J4).
     *
     * <p>{@code speed_delta} is {@code getDeltaMovement()}: what the physics INTENDS this tick.
     * {@code speed_known} is {@code getKnownSpeed()}: the realized displacement the rest of the game
     * asks about — and the two are not the same question. Walk into a wall and the intent stays high
     * while the realization is zero; more to the point, {@code ServerPlayer} overrides
     * {@code getKnownSpeed} to return the movement its CLIENT last reported, so before the
     * {@code FakePlayerEntity} mirror a headless body sprinted at 5.6 b/s while every weapon,
     * projectile and reach test in the game was told it was standing still.
     *
     * <p><b>Both are reported whenever EITHER is moving, and that is the whole point.</b> Emitting
     * only the non-zero one would hide the exact failure this key exists to expose: a
     * {@code speed_known: 0.0} sitting next to a {@code speed_delta: 5.6} IS the diagnosis, and it
     * has to be readable as a pair rather than inferred from an absent key.
     *
     * <p>Both in blocks per second — the unit every {@code KineticWeapon.Condition} threshold is in
     * ({@code getKnownSpeed} is per-tick and {@code getMotion} scales it by 20), so a caller can
     * compare a reading against 4.6 without converting anything.
     *
     * <p><b>Both are HORIZONTAL speed, and that was measured rather than assumed.</b> The first live
     * read of this key had a body standing perfectly still on stone reporting
     * {@code speed_delta: 1.57} — 0.0784 blocks per tick, which is vanilla's gravity term. A
     * grounded entity's {@code getDeltaMovement} carries a permanent downward component, so a 3-D
     * magnitude answers "how fast am I falling into the floor I am standing on", never drops below
     * any epsilon, and reads as a third of walking pace for a body that has not moved. Vanilla asks
     * the same question the same way — {@code Entity.hasMovedHorizontallyRecently} is
     * {@code lastKnownSpeed.horizontalDistance() > 1e-5} — and the gaits these numbers get compared
     * against (walk 4.317, sprint 5.612) are horizontal figures too.
     *
     * <p>The cost is stated so nobody is surprised by it: {@code KineticWeapon} projects the FULL
     * 3-D motion onto the look vector, so a body falling while looking down carries spear speed this
     * reading does not show. That is design §8.4's "pitch × vertical velocity" confounder, and the
     * clinic isolates it by pinning pitch and asserting {@code |vy| < 0.01} rather than by reading
     * it here.
     */
    private static void addSpeed(final JsonObject r, final LivingEntity vitals) {
        double known = vitals.getKnownSpeed().horizontalDistance() * 20.0;
        double delta = vitals.getDeltaMovement().horizontalDistance() * 20.0;
        if (known < SPEED_EPSILON_BPS && delta < SPEED_EPSILON_BPS) {
            return;
        }
        r.addProperty("speed_known", Math.round(known * 100.0) / 100.0);
        r.addProperty("speed_delta", Math.round(delta * 100.0) / 100.0);
    }

    private static JsonObject botStatus(final Slot slot) {
        JsonObject r = new JsonObject();
        BotBodyEntity drone = slot.drone();
        FakePlayerEntity playerBody = slot.player();
        LivingEntity body = slot.activeBody();
        r.addProperty("body", Bodies.kind(body));
        // The spawned vitals read from whichever OWNED body is live (player or drone) — a possessed
        // mob's vitals ride the possession block below, as before.
        LivingEntity vitals = playerBody != null ? playerBody : drone;
        if (vitals == null) {
            r.addProperty("spawned", false);
        } else {
            r.addProperty("spawned", true);
            r.addProperty("id", vitals.getId());
            r.addProperty("uuid", vitals.getUUID().toString());
            addVec(r, "pos", vitals.position());
            addVec(r, "eye", vitals.getEyePosition());
            r.addProperty("yaw", vitals.getYRot());
            r.addProperty("pitch", vitals.getXRot());
            r.addProperty("health", vitals.getHealth());
            r.addProperty("maxHealth", vitals.getMaxHealth());
            // Where the body IS, physically. Always reported, never only-when-interesting: the first
            // watched session drowned while bot_status answered health and food and said nothing
            // about air or water, so the agent could see it dying and not why (Hazards' javadoc).
            r.addProperty("onGround", vitals.onGround());
            r.addProperty("inWater", vitals.isInWater());
            r.addProperty("submerged", vitals.isEyeInFluid(net.minecraft.tags.FluidTags.WATER));
            addSpeed(r, vitals);
            if (!vitals.canBreatheUnderwater()) {
                r.addProperty("air", vitals.getAirSupply());
                r.addProperty("maxAir", vitals.getMaxAirSupply());
            }
            JsonArray dangers = Hazards.describe(vitals);
            if (!dangers.isEmpty()) {
                // The same causes body_endangered announces — an event is a notification and the
                // agent may arrive after it, so the state is always readable on demand too.
                r.add("dangers", dangers);
            }
            // WHERE THE BODY IS, spatially: sky access, light, and enclosure — the body's own
            // senses (embodied-legal, like onGround/inWater above). w2-79881 spent 12 minutes
            // sealed in a tunnel calling bot_scan 48 times with nothing anywhere saying "you are
            // underground, enclosed in rock" — the agent had to infer it from time_of_day events.
            addSpatialSense(r, vitals);
            if (playerBody != null) {
                r.addProperty("name", playerBody.getGameProfile().name());
                // Real hunger: the one vital a player body has that no mob body does — starving is
                // a real way to die, so it is always reported, never only-when-interesting.
                r.addProperty("food", playerBody.getFoodData().getFoodLevel());
                r.addProperty("saturation", playerBody.getFoodData().getSaturationLevel());
            }
            if (vitals.getArmorValue() > 0) {
                r.addProperty("armor", vitals.getArmorValue());
            }
            // THE OTHER HAND (COMBAT_KIT_PLAN.md §4.6). The body now fills its own offhand — a
            // shield while healthy, a totem when one more hit is death — and a slot the body
            // writes but no read reports is a state the agent can only discover by dying in it.
            // Reported whenever it holds anything, on any body family: the equipment slot exists
            // on every LivingEntity, and an offhand the caller put there with bot_equip was just
            // as invisible before this.
            net.minecraft.world.item.ItemStack offhand = vitals.getItemBySlot(
                net.minecraft.world.entity.EquipmentSlot.OFFHAND);
            if (!offhand.isEmpty()) {
                r.addProperty("offhand", DroneHands.itemId(offhand.getItem()));
            }
            // A DRAW IN PROGRESS. Present only while one is, so it costs nothing in the ordinary
            // read: the key's mere presence is the fact ("the bow is bent right now"), and a body
            // that answers `busy` to a second shot without any read ever saying why is the kind of
            // invisible state this surface keeps having to pay for.
            if (slot.use != null) {
                r.addProperty("drawing", slot.use.weaponId);
            }
            // A SHIELD THAT IS UP, and — separately — whether it is WORKING yet. Vanilla will not
            // block for the first five ticks of a raise (BlocksAttacks.blockDelayTicks), and a
            // raised-but-not-yet-live shield is indistinguishable from a live one on every other
            // reading, so a body that raises into an arrow already at the bowstring learns nothing
            // from its own senses about why it still took the hit.
            Shields.status(slot, vitals, r);
            // A CROSSBOW STAYS LOADED (COMBAT_KIT_PLAN.md §4.6's last unbuilt status key). Unlike
            // the draw and the raise this is a standing property of a carried item rather than a
            // moment, so it reports false as well as true: "I have a free shot" and "I owe 25
            // ticks" are both facts a body picking its next act needs.
            Crossbows.status(slot, vitals, r);
            if (vitals.getAbsorptionAmount() > 0) {
                r.addProperty("absorption", vitals.getAbsorptionAmount());
            }
            if (!vitals.getActiveEffects().isEmpty()) {
                com.google.gson.JsonArray eff = new com.google.gson.JsonArray();
                for (var mei : vitals.getActiveEffects()) {
                    eff.add(mei.getEffect().getRegisteredName());
                }
                r.add("effects", eff);
            }
            if (drone != null && drone.beamMode() != BotBodyEntity.BEAM_NONE) {
                r.addProperty("beam", switch (drone.beamMode()) {
                    case BotBodyEntity.BEAM_POINT -> "point";
                    case BotBodyEntity.BEAM_DIG -> "dig";
                    case BotBodyEntity.BEAM_ATTACK -> "attack";
                    default -> "unknown";
                });
            }
        }
        if (slot.possession != null) {
            Mob mob = slot.possession.mob();
            JsonObject p = new JsonObject();
            p.addProperty("entity_id", mob.getId());
            p.addProperty("type", BuiltInRegistries.ENTITY_TYPE.getKey(mob.getType()).toString());
            p.addProperty("health", mob.getHealth());
            p.addProperty("maxHealth", mob.getMaxHealth());
            addVec(p, "pos", mob.position());
            p.addProperty("yaw", mob.getYRot());
            p.addProperty("pitch", mob.getXRot());
            r.add("possessed", p);
        }
        if (body != null) {
            boolean navigating = !Bodies.nav(body).isDone();
            r.addProperty("navigating", navigating);
            if (navigating && Bodies.nav(body).targetPos() != null) {
                addPos(r, "navTarget", Bodies.nav(body).targetPos());
            }
            // "Am I there yet" answered as a READ. bot_status is OBSERVE, so the act-reply stamp
            // (stampBodyState) does not ride it — and this is the tool an agent reaches for when it
            // wants to know where it stands. Without it, the only way to ask was to re-issue the
            // movement goal and read `already_there` off the reply (58 times in w2-56123).
            GoalRunner.Goal goal = slot.goal;
            if (goal != null && goal.target != null) {
                double d = body.position().distanceTo(goal.target.where());
                r.addProperty("distance_to_goal", Math.round(d * 10.0) / 10.0);
                r.addProperty("at_goal", d <= GoalRunner.MOVE_WITHIN);
            }
        }
        JsonObject follow = Follow.describe(slot);
        if (follow != null) {
            r.add("follow", follow);
        }
        JsonObject queue = QueueRunner.describe(slot);
        if (queue != null) {
            r.add("queue", queue);
        }
        JsonObject engage = Engage.describe(slot);
        if (engage != null) {
            r.add("engage", engage);
        }
        JsonObject goal = GoalRunner.describe(slot);
        if (goal != null) {
            r.add("goal", goal);
        }
        // Reflex loadout summary (the escalation rung; bot_reactions list is the drill-down).
        if (!slot.reactions.isEmpty()) {
            r.addProperty("reactions_armed", slot.reactions.size());
        }
        if (slot.active != null) {
            r.addProperty("reacting", slot.active.reaction.id);
        }
        // Awareness without command authority: other sessions' drones, by owner and position.
        com.google.gson.JsonArray others = new com.google.gson.JsonArray();
        for (Slot s : SLOTS.values()) {
            BotBodyEntity d = s == slot ? null : s.drone();
            if (d != null) {
                JsonObject o = new JsonObject();
                o.addProperty("session", s.owner);
                addVec(o, "pos", d.position());
                others.add(o);
            }
        }
        if (!others.isEmpty()) {
            r.add("others", others);
        }
        return r;
    }

    private static JsonObject botDespawn(final Slot slot) {
        JsonObject r = new JsonObject();
        FakePlayerEntity player = slot.player();
        if (player != null) {
            QueueRunner.abort(slot, "body_despawned");
            GoalRunner.abort(slot, "body_despawned");
            if (slot.pendingNav != null && slot.pendingNav.body == player) {
                failPending(slot, "body_despawned");
            }
            DroneHands.abort(slot, "body_despawned");
            Follow.clear(slot);
            // A real player drops its real inventory on removal the honest way: scatter it first.
            player.getInventory().dropAll();
            FakePlayers.despawn(((ServerLevel) player.level()).getServer(),
                player.getGameProfile().name(), "commanded");
            slot.player = null;
            slot.observer.reset();
            Perception.reset(slot);
            JsonObject d = new JsonObject();
            d.addProperty("reason", "despawned");
            EventLog.emit("body_removed", d, slot.target());
            r.addProperty("despawned", true);
            return r;
        }
        BotBodyEntity drone = slot.drone();
        if (drone == null) {
            r.addProperty("despawned", false);
            return r;
        }
        QueueRunner.abort(slot, "drone_despawned"); // queues may lean on the drone's hands
        if (slot.possession == null) { // a goal on a live possession survives its idle drone's removal
            GoalRunner.abort(slot, "drone_despawned");
        }
        if (slot.pendingNav != null && slot.pendingNav.body == drone) {
            failPending(slot, "drone_despawned");
        }
        if (slot.possession == null) {
            Follow.clear(slot);
        }
        DroneHands.abort(slot, "drone_despawned");
        dropInventory(drone); // don't vaporize carried items on a commanded despawn
        drone.discard();
        slot.drone = null;
        // Commanded removal: evented here with the honest reason; reset the watch so the tick
        // watcher doesn't double-report it as an uncommanded loss.
        slot.hadDrone = false;
        slot.lastHealth = -1;
        slot.observer.reset(); // silent: drone_removed tells the story, no leave-event flush
        Perception.reset(slot); // the body is gone — forget what it perceived
        JsonObject d = new JsonObject();
        d.addProperty("reason", "despawned");
        EventLog.emit("drone_removed", d, slot.target());
        r.addProperty("despawned", true);
        return r;
    }

    // ---- event emission (server tick) ----------------------------------------

    /**
     * Per-tick watch over every slot: completes/fails outstanding {@code bot_goto} actions, advances
     * digs, follow mode, and queues, reports damage and uncommanded removal — and, on the
     * {@link #REAP_INTERVAL}, destroys drones (and releases possessions) whose owning session is no
     * longer live (session-bound lifetime). Runs on the server thread, same as the tools.
     */
    private static void tickWatch() {
        boolean sweep = ++reapCounter % REAP_INTERVAL == 0;
        Iterator<Slot> it = SLOTS.values().iterator();
        while (it.hasNext()) {
            Slot slot = it.next();
            BotBodyEntity drone = slot.drone();

            if (sweep && !ANON.equals(slot.owner) && !Sessions.isLive(slot.owner)
                && !waiterParked(slot)) {
                // The owning session ended/disconnected: its bodies go with it. Broadcast (not
                // targeted — the owner is gone) so an orchestrating session sees the removal.
                QueueRunner.abort(slot, "session_ended");
                GoalRunner.abort(slot, "session_ended"); // completes any parked waiter, evented
                com.mattmc.mcptoolkit.wm.WmSeen.drop(slot.owner); // its held knowledge dies with it
                Follow.clear(slot);
                LookDriver.abortAll(slot); // completes a parked sweep waiter with actuals
                ActCeremony.resolveNow(slot, "session_ended"); // commit + answer, never strand
                PlayerVerbs.abortChew(slot, "session_ended");
                PlayerVerbs.failUse(slot, "session_ended");
                Shields.lower(slot, "session_ended");
                failPending(slot, "session_ended");
                // Hands fail for EVERY body family (S11). This used to live inside the two
                // teardown branches below, so a slot whose active body was a POSSESSED MOB was
                // swept with its dig and its in-flight attack turn (F1's `slot.swing`) never
                // failed — no action_failed, and a `bot_attack {wait:true}` future left hanging
                // until the caller's own timeout. Hoisted ABOVE Possession.release so the hands
                // still have a live body to clear the crack overlay and dig visual on; abort is
                // a no-op when nothing is in flight, so the branches below no longer repeat it.
                DroneHands.abort(slot, "session_ended");
                Possession.release(slot, "session_ended");
                FakePlayerEntity fp = slot.player();
                if (fp != null) {
                    fp.getInventory().dropAll();
                    FakePlayers.despawn(((ServerLevel) fp.level()).getServer(),
                        fp.getGameProfile().name(), "session_ended");
                    slot.player = null;
                    JsonObject d = new JsonObject();
                    d.addProperty("reason", "session_ended");
                    d.addProperty("session", slot.owner);
                    EventLog.emit("body_removed", d);
                }
                if (drone != null) {
                    dropInventory(drone);
                    drone.discard();
                    JsonObject d = new JsonObject();
                    d.addProperty("reason", "session_ended");
                    d.addProperty("session", slot.owner);
                    EventLog.emit("drone_removed", d);
                }
                it.remove();
                continue;
            }

            LivingEntity body = slot.activeBody(); // also auto-releases a dead/unloaded possession (evented)
            // World-model recorder (DESIGN.md §13.1/§13.2): the ticks-stream envelope row plus the
            // gait/gaze fans, every tick a body exists. Also how the recorder learns which session
            // and goal a body belongs to, for the action rows the drivers write later this tick.
            com.mattmc.mcptoolkit.wm.Wm.tickBody(slot.target(), body,
                slot.goal != null ? slot.goal.actionId : null);
            slot.enemyFacedThisTick = false; // Engage.tick re-asserts it below if combat aims
            Possession.verifyTick(slot); // release a possession whose puppet goal never engaged
            Hazards.tick(slot, body); // environmental danger onset/clear (drowning, lava, fire, falling)
            Perception.tick(slot, body); // player-legal belief store (vision+hearing), if tracking is on
            // Observer AFTER perception: in perceived mode it diffs the belief store, and diffing
            // last tick's beliefs would report every percept one scan late (SURVIVAL_SENSES §2.3).
            slot.observer.tick(slot, body); // derived observation events (enter/leave, nearest threat)
            PlayerVerbs.chewTick(slot); // observe an in-flight eat/drink (vanilla ticks do the work)
            PlayerVerbs.useTick(slot);  // aim + draw a shot (unconditional, for swingTick's reason)
            // The raised shield, and the drain of what it ATE this tick. EARLY, so the guard's own
            // clock cannot be frozen by whoever owns the body, and so the record is parked on the
            // slot before the vitals watch at the end of this pass emits from it.
            Shields.tick(slot);
            Crossbows.tick(slot);       // a crossbow being wound between shots (crossbow_loaded)
            Shots.tick(slot);           // did the arrow land? (shot_landed, both body families)
            // Weapons the body threw and wants back. Serviced unconditionally so the EXPIRY clock
            // runs even while something else owns the body — an errand whose deadline only ticks
            // when the body is free would wait forever for a body that never is.
            Retrieve.tick(slot);

            // Reflex interrupt layer runs above the base intents: while a reaction owns the body
            // (Reflexes.tick returns true), all base servicing — dig, follow, queue, and flight
            // completion — is frozen, resuming when the reaction finishes (PLAYER_CONTROL_DESIGN.md
            // §2). Ownership is these return values, nothing else.
            boolean reflexActive = Reflexes.tick(slot, body);
            // Combat runs BEFORE the base intents so a fight-mode engagement can claim the body in
            // the same tick it starts — otherwise the goal loop would re-issue navigation underneath
            // the combat watch and the two would fight over the legs. In defend mode this returns
            // false and the base keeps running: mine, fend off what jumps you, resume mining.
            boolean combatHolds = !reflexActive && Engage.tick(slot);
            // THE SWING CLOCK (V3_PLAN.md §2 F1) — serviced UNCONDITIONALLY, outside the base
            // branch. `Swing.ticksLeft` only decrements inside swingTick, so parking this call in
            // the base branch (where F1 first put it) froze an in-flight attack turn TOGETHER WITH
            // its 60-tick circuit breaker whenever a reaction or a fight-mode engagement held the
            // body: no advance, no timeout, a `bot_attack {wait:true}` caller left to eat the 15s
            // tool timeout, and then — worse — the swing firing seconds later on stale geometry,
            // emitting action_completed for an action the caller had long abandoned (a parked
            // bot_run attack step behaves the same way). That is the exact shape the dig watchdog
            // below exists for, and the swing had nothing; reflexes-flee.test.mjs:122 already
            // attacks three zombies with a flee reaction firing. The invariant: an in-flight swing
            // ALWAYS has a running clock, and its waiter is ALWAYS answered.
            //
            // Servicing it here — rather than giving it a starvedTick twin — is right because a
            // swing does not contend with whoever holds the body. (a) LEGS: it drives none, it
            // only turns the head and swings. (b) GEOMETRY: every gate re-runs per tick, so a
            // reflex carrying the body out of reach or behind cover fails the swing
            // `out_of_reach`/`occluded` PROMPTLY — an honest answer in the caller's own call
            // window, which is what a watchdog could only ever approximate. (c) GAZE: the swing is
            // the declared gaze owner while it lives (`AttackGate.holdsGaze` — the movement
            // drivers withhold yaw/pitch for that body; LookDriver already vetoes on
            // `slot.swing != null`), and it is placed AFTER Reflexes.tick/Engage.tick so its
            // rate-limited turn is the last gaze write of the tick regardless. Position relative
            // to the base servicing below is unchanged, so the non-held path behaves exactly as
            // it did.
            DroneHands.swingTick(slot);
            if (!reflexActive && !combatHolds) {
                // The smooth-turn servo runs before the acts it aims for, so a dig/ceremony facing
                // installed THIS tick starts moving THIS tick (LookDriver applies its own vetoes).
                LookDriver.tick(slot, body);
                // advance/complete an outstanding dig (bot_mine) — drone or player hands
                DroneHands.tick(slot, drone != null ? drone : slot.player());
                ActCeremony.tick(slot); // the ticked container/bench performance
                Follow.tick(slot); // continuous follow mode (station-keeping + camera)
                QueueRunner.tick(slot); // advance a bot_run queue
                GoalRunner.tick(slot); // advance a bot_target goal (navigate / repair / act)
            } else {
                // THE DIG WATCHDOG. A frozen dig does not advance, does not fail, and does not time
                // out — it stops existing in time, while `slot.dig` keeps answering `busy` to every
                // other dig in the world. The fight reflex fired 50 times in session w2-56123, on
                // consecutive ticks, whiffing. Nav has nav_starved for exactly this; the dig had
                // nothing. Announce once past DIG_STARVED_TICKS, concede past the abort bound.
                DroneHands.starvedTick(slot, reflexActive ? "reflex" : "fight");
                // A ceremony must not sit frozen under combat: cut the theater, run the commit,
                // answer the waiter (ActCeremony's preemption rule).
                ActCeremony.resolveNow(slot, reflexActive ? "reflex" : "fight");
            }

            PendingNav p = slot.pendingNav;
            if (p != null && !reflexActive && !combatHolds) {
                if (p.body.isRemoved() || !p.body.isAlive()) {
                    failPending(slot, p.body instanceof BotBodyEntity ? "drone_removed" : "body_removed");
                    p = null;
                } else if (!Bodies.nav(p.body).isDone()) {
                    // The stall watchdog. Cutting the path here rather than reporting a special
                    // failure is deliberate: it makes isDone() true, so the SAME honest verdict
                    // machinery below runs (distance, gates, partial-path disclosure, the ledger
                    // hand-off to QueueRunner/GoalRunner) and a stall is repairable exactly like any
                    // other stopped-short navigation instead of being a separate dead end.
                    p.stalledAs = stallReason(p);
                    if (p.stalledAs != null) {
                        Bodies.nav(p.body).stop();
                    }
                }
            } else if (p != null && !p.body.isRemoved() && p.body.isAlive()) {
                // A reflex or fight-mode combat holds the body, so base servicing is frozen — but
                // the watchdog's CLOCK is not. Before this, its whole block sat behind
                // !reflexActive, so a reflex loop that owned every tick also owned the only
                // mechanism that could cut the starved flight loose (w2-79881: gotos "in flight"
                // for minutes with traveled 0 while dodge held the legs). The clock accrues here;
                // the verdict still waits for the base to get a tick back — except a watchdog cut,
                // which the block below serves regardless of who holds the body.
                String cut = stallReason(p);
                if (cut != null) {
                    p.stalledAs = cut;
                    Bodies.nav(p.body).stop();
                }
            }
            if (p != null && slot.pendingNav == p && !p.body.isRemoved()
                && (!reflexActive && !combatHolds || p.stalledAs != null)) {
                if (Bodies.nav(p.body).isDone()) {
                    // The navigation may have ended by its OWN stuck detection — vanilla's
                    // doStuckDetection on a Mob body, PlayerNavigation's node timeout on the player —
                    // which stops the path before this watchdog's window elapses. Without asking, that
                    // race silently downgraded a wedged body to a plain stopped_short, and
                    // stopped_short's advice ("re-issue bot_goto") is exactly wrong for a body that
                    // will wedge again in the same cell.
                    if (p.stalledAs == null && Bodies.nav(p.body).stalled()) {
                        p.stalledAs = "stalled";
                    }
                    slot.pendingNav = null;
                    // A manual goto's base intent ends here; a queue goto step keeps RUN (its
                    // completion flows on to QueueRunner.onActionDone below).
                    if (slot.baseKind == BaseKind.GOTO) {
                        slot.baseKind = BaseKind.IDLE;
                    }
                    double distance = p.body.position().distanceTo(p.target);
                    double traveled = p.body.position().distanceTo(p.startPos);
                    // The honest arrival verdict (the old bare `arrived: distance<=2.5` claimed
                    // arrival off unreachable 1-node paths with zero displacement): arrived means
                    // the body TRAVELED into range; already_there means it was in range at start
                    // AND didn't meaningfully move; and a partial path is always disclosed —
                    // being near a target the pathfinder could not reach is not the same fact as
                    // having reached it. A reach goal re-verifies the TOUCH predicate (range +
                    // line of sight) against world geometry instead of trusting the path — the
                    // gates say which precondition failed, because the remedies differ (out of
                    // range → path again; no sightline → mine the occluder).
                    // The zero-motion epsilon is BODY-KIND-SIZED: 1.5 exists because a hovering
                    // drone drifts ~1 block while "not moving" — but a grounded player drifts
                    // nothing, and 1.5 relabeled a real 1.4-block stair-step climb as
                    // "did_not_start: the body did not move at all" (w1_42257 F5's pit probe
                    // caught the goal loop's own productive legs being reported as refusals).
                    double eps = p.body instanceof FakePlayerEntity ? 0.25 : TRAVELED_EPSILON;
                    boolean unmoved = traveled < eps;
                    boolean within;
                    boolean startedInRange;
                    com.mattmc.mcptoolkit.ReachSolver.Touch touch = null;
                    if (p.reachTarget != null) {
                        touch = com.mattmc.mcptoolkit.ReachSolver.touch(
                            (ServerLevel) p.body.level(), p.body.getEyePosition(), p.reachTarget);
                        within = touch.ok();
                        startedInRange = p.startTouch;
                    } else {
                        within = distance <= p.within;
                        startedInRange = p.startPos.distanceTo(p.target) <= p.within;
                    }
                    // ARRIVAL IS EVALUATED WHERE THE BODY IS — and for a body that never moved,
                    // that is where it STARTED. A hovering drone drifts about a block while doing
                    // nothing, which is the whole reason TRAVELED_EPSILON exists; but the arrival
                    // test did not use it, so a goal that was satisfied at the moment it was asked
                    // could report failure a second later because the eye had wandered 0.14 blocks
                    // outside a 4.5 shell. `reach-goals` case 8 did exactly that in three
                    // consecutive batteries: did_not_start at distance_to_target 4.643.
                    //
                    // The verdict below is honest precisely BECAUSE it is conditioned on the body
                    // not having moved: re-sampling the shell after zero displacement measures
                    // drift, not the goal, and the only non-drifting reading available is the one
                    // taken when the goal was set. Anything that actually travelled — including a
                    // body genuinely shoved out of range — is past the epsilon and unaffected.
                    boolean heldFromStart = !within && unmoved && startedInRange;
                    if (heldFromStart) {
                        within = true;
                    }
                    // A watchdog cut is its own fact, not a plain "the path ended short": the path did
                    // NOT end, the body stopped moving along it. Naming it is what lets the agent (and
                    // the goal loop's repair) tell "no route from here" apart from "wedged here".
                    // A body that stalled but is nonetheless in range still arrived — the stall is
                    // then just how the last centimetre was spent, and claiming failure would be the
                    // mirror-image false report.
                    // ZERO PROGRESS IS NOT "SHORT". `stopped_short` means the body walked and ran
                    // out of path, and its advice — "re-issue bot_goto to continue" — is right for
                    // that. It is exactly wrong for a body that never moved: re-issuing replays the
                    // same failed solve, which is why 328 of 489 stopped_short completions across
                    // eleven sessions carried traveled:0, mostly as the goal loop's own repair legs
                    // burning their budget on a step that could not move (PERCEPTION_NAV_FIXES §2.3).
                    // Observed as identical repeated pairs at a fixed distance_to_target.
                    String outcome = within
                        ? (startedInRange && unmoved ? "already_there" : "arrived")
                        : (p.stalledAs != null ? p.stalledAs
                            : (unmoved ? "did_not_start" : "stopped_short"));
                    JsonObject d = new JsonObject();
                    d.addProperty("action_id", p.actionId);
                    d.addProperty("action", "bot_goto");
                    d.addProperty("arrived", within);
                    d.addProperty("outcome", outcome);
                    if (heldFromStart) {
                        // Never silent: this is the one verdict here that is not a fresh
                        // measurement, so it says so rather than letting a caller believe the
                        // shell was re-tested and passed.
                        d.addProperty("arrival_from", "start");
                        d.addProperty("drift", round3(distance));
                    }
                    d.addProperty("distance_to_target", round3(distance));
                    d.addProperty("traveled", round3(traveled));
                    // Echo the rights this flight actually ran under. The START result already
                    // echoes them, but a wait:true caller only ever sees THIS object — and the
                    // 2026-08-01 drowning postmortem's ask was precisely "show me the swim right
                    // the leg used" (the swim probes assert it here).
                    d.add("profile", describeFlightProfile(p.profile, p.body));
                    if (touch == null) {
                        d.addProperty("within_radius", p.within); // the radius the verdict used
                    }
                    if (touch != null) {
                        JsonObject gates = new JsonObject();
                        gates.addProperty("range", touch.inRange());
                        if (touch.los() == null) {
                            gates.add("los", null);
                        } else {
                            gates.addProperty("los", touch.los());
                        }
                        d.add("gates", gates);
                    }
                    if (p.pathPartial) {
                        d.addProperty("path_partial", true);
                    }
                    if (!within) {
                        if (touch != null) {
                            d.addProperty("note", !touch.inRange()
                                ? "navigation ended out of hand reach (" + round3(distance)
                                    + " blocks from the block's center)"
                                    + (p.pathPartial
                                        ? " on a partial path — no touchable position was reachable;"
                                            + " check_path with `reach` to diagnose"
                                        : " — re-issue bot_goto `reach` to continue")
                                : "in hand reach but line of sight is blocked — mine the occluder"
                                    + " or approach another face");
                        } else if ("did_not_start".equals(outcome)) {
                            d.addProperty("note", "the body did not move at all (" + round3(distance)
                                + " blocks from the target). Re-issuing bot_goto will replay the same"
                                + " solve and move nothing — something has to change first: check_path"
                                + " to see what is in the way, allow may_modify to dig/bridge through"
                                + " it, or pick a target the body can actually walk to");
                        } else {
                            d.addProperty("note", "navigation ended " + round3(distance)
                                + " blocks from the target"
                                + (p.pathPartial
                                    ? " on a partial path — the pathfinder could not reach the target"
                                        + " from here; check_path to diagnose, or raise `within` (max "
                                        + (int) MAX_WITHIN + ") if nearby suffices"
                                    : " — re-issue bot_goto to continue, or raise `within` if this is"
                                        + " close enough"));
                        }
                    } else if (p.pathPartial) {
                        d.addProperty("note", "within " + (touch != null ? "hand reach" : p.within
                            + " blocks") + " of the target, but the"
                            + " path was partial — the exact target is not reachable for this body");
                    }
                    // PENNED IN: a partial path the body could not even start walking. Distance is
                    // not the story here — "ended 52 blocks from the target" having travelled ZERO
                    // means no walkable route leaves this cell at all, and the generic advice
                    // ("check_path to diagnose, or raise `within`") answers a question the caller
                    // does not have. Raising the arrival radius cannot help a body that is walled in.
                    //
                    // Live, session w1-85918: the body dug a 1-wide shaft 31 blocks down, then spent
                    // its last four minutes here — three gotos and two goals, every one of them
                    // stopped_short with traveled ~0, and nothing ever said the words "you can dig
                    // your way out". It could have: it was carrying ~48 cobblestone (see the drop-id
                    // fix in DroneHands) and the solver has had pillar/mine edges since 0.26.0/0.38.0.
                    // They just need asking for, and this is the moment the agent is reading.
                    // (`stalledAs == null`: a body that DID set off and then wedged is a different
                    // story with a better message of its own, immediately below — it can name the
                    // exact cell it could not enter, which this cannot.)
                    if (!within && p.pathPartial && p.stalledAs == null && traveled < TRAVELED_EPSILON) {
                        d.addProperty("penned_in", true);
                        d.addProperty("note", "the body did not move: NO walkable route leaves this"
                            + " cell for the target (raising `within` cannot help — there is nowhere"
                            + " to walk). If you may change the world, bot_target {action:\"move\","
                            + " may_modify:\"break\"|\"both\"} can mine/bridge a route out — that is"
                            + " the way out of a shaft or a sealed room. Otherwise check_path to see"
                            + " where the walls are");
                    }
                    // Starvation ledger: if leg reflexes preempted this flight at all, the verdict
                    // says so and names the last one — "stopped_short traveled:0" with no cause was
                    // what w2-79881 could not diagnose while a dodge loop owned the legs.
                    if (p.preemptions > 0) {
                        d.addProperty("reflex_preemptions", p.preemptions);
                        if (p.lastPreemptedBy != null) {
                            d.addProperty("last_preempted_by", p.lastPreemptedBy);
                        }
                    }
                    if (p.stalledAs != null && !within) {
                        // Override the generic stopped-short advice: "re-issue bot_goto" is the WRONG
                        // remedy for a wedged body — it would wedge again in the same cell. Say what
                        // actually happened and name remedies that change something.
                        d.addProperty("stalled_after_ticks", p.liveTicks);
                        BlockPos blockedOn = Bodies.nav(p.body).blockedOn();
                        if (blockedOn != null) {
                            // The follower named the exact cell it could not enter — report THAT,
                            // with the remedy that clears it, instead of the generic wedge advice.
                            JsonObject b = new JsonObject();
                            b.addProperty("x", blockedOn.getX());
                            b.addProperty("y", blockedOn.getY());
                            b.addProperty("z", blockedOn.getZ());
                            b.addProperty("block", net.minecraft.core.registries.BuiltInRegistries
                                .BLOCK.getKey(p.body.level().getBlockState(blockedOn).getBlock())
                                .toString());
                            d.add("blocked_on", b);
                            d.addProperty("note", "the path is blocked by the named cell — the world"
                                + " changed under the plan (or a door is closed). Mine/open it"
                                + " (bot_target may_modify, or bot_mine if it is in reach), or route"
                                + " around it; re-issuing the same bot_goto hits the same wall");
                        } else if ("replan_failed".equals(p.stalledAs)) {
                            d.addProperty("note", "a reflex interrupted this navigation and the"
                                + " re-plan after it found NO route from here"
                                + (p.lastPreemptedBy != null
                                    ? " (last preempted by `" + p.lastPreemptedBy + "`)" : "")
                                + " — the flight is over, not paused. check_path to see what"
                                + " changed, or bot_target with may_modify to open a route");
                        } else {
                            d.addProperty("note", "nav_timeout".equals(p.stalledAs)
                                ? "the navigation ran " + (p.liveTicks / 20) + "s without finishing and"
                                    + " was cut off — the body was moving but never arrived; check_path"
                                    + " to see whether a route exists at all"
                                : "the body STOPPED MAKING PROGRESS " + round3(distance) + " blocks from"
                                    + " the target and was cut loose — it is wedged, not merely short."
                                    + (p.preemptions > 0 && p.lastPreemptedBy != null
                                        ? " Reflex `" + p.lastPreemptedBy + "` preempted this flight "
                                            + p.preemptions + "x — a reflex loop can starve travel;"
                                            + " deal with its trigger or disarm it."
                                        : "")
                                    + " Re-issuing the same bot_goto will wedge again: check_path from"
                                    + " here, or bot_target with may_modify to break/bridge the"
                                    + " obstruction, or route via an intermediate point");
                        }
                    }
                    addVec(d, "pos", p.body.position());
                    attachTraversal(d, p.body); // proprioception: the trail + envelope (§4)
                    // A GOAL'S OWN refused leg is mechanism, not news (w1_42257 R3/F5): the goal
                    // loop probes "can I walk yet?" between repairs, and each refusal used to land
                    // in the agent's event window — the pit escape emitted one did_not_start per
                    // mined cell on a WORKING ascent, and g-49's tunnel flooded ~23 identical
                    // pairs. The goal is handling it; its terminal verdict (and the act warnings
                    // for real work) carry the story. Legs that moved or arrived stay visible, and
                    // every completion still flows to the goal machinery unchanged.
                    boolean internalRefusedLeg = p.waiter == null && slot.goal != null
                        && p.actionId.equals(slot.goal.waiting)
                        && "did_not_start".equals(outcome);
                    if (!internalRefusedLeg) {
                        EventLog.emit("action_completed", d, slot.target());
                    }
                    if (p.waiter != null) {
                        p.waiter.complete(d.deepCopy());
                    }
                    QueueRunner.onActionDone(slot, p.actionId, d);
                    GoalRunner.onActionDone(slot, p.actionId, d);
                }
            }

            // The PLAYER body's vitals watch — the drone branch below, for the body kind that can
            // actually starve and drown. Before this the whole watch was gated `if (drone != null)`,
            // so a player body took damage and DIED in total silence: the first watched session
            // drowned and the only trace in the log was its own absence. A player is also not
            // REMOVED when it dies (vanilla keeps the corpse for the respawn screen), so death is
            // detected on liveness, not removal, and the corpse is reaped here — otherwise
            // bot_status keeps answering spawned:true at health 0 and the name stays taken.
            FakePlayerEntity pb = slot.player();
            if (pb != null && !pb.isAlive()) {
                JsonObject d = new JsonObject();
                d.addProperty("body", "player");
                d.addProperty("name", pb.getGameProfile().name());
                addVec(d, "pos", pb.position());
                var src = pb.getLastDamageSource();
                d.addProperty("cause", src == null ? "unknown" : src.getMsgId());
                if (!slot.hazards.isEmpty()) {
                    // What the body was suffering when it died — the difference between "it died" and
                    // "it drowned", without making the agent reconstruct it from a health series.
                    JsonArray hz = new JsonArray();
                    for (String c : slot.hazards) {
                        hz.add(c);
                    }
                    d.add("hazards", hz);
                }
                // WHAT IT LOST, not just where. The event already named the place and the killer, so
                // an agent could walk back — but it had no idea what it was walking back FOR, and
                // could not tell a full recovery from half of one. Live 2026-08-10 (w3-86528): four
                // deaths, stone tools and copper dropped each time, and the agent never once
                // returned for them. Item entities despawn after 5 minutes, so this is a manifest
                // with a clock on it — say what is out there while it can still be fetched.
                if (slot.lastInventory != null && !slot.lastInventory.isEmpty()) {
                    d.add("dropped", slot.lastInventory);
                }
                stampEnvelope(d, pb);
                // The death site is the next respawn's anchor (drops are here, and the agent's
                // mental map is here) — recorded BEFORE teardown clears anything.
                slot.lastDeathPos = pb.position();
                slot.lastDeathTick = pb.level().getGameTime();
                slot.lastDeathDim = pb.level().dimension().identifier().toString();
                QueueRunner.abort(slot, "body_died");
                GoalRunner.abort(slot, "body_died");
                if (slot.pendingNav != null && slot.pendingNav.body == pb) {
                    failPending(slot, "body_died");
                }
                DroneHands.abort(slot, "body_died");
                Follow.clear(slot);
                FakePlayers.despawn(((ServerLevel) pb.level()).getServer(),
                    pb.getGameProfile().name(), "died");
                slot.player = null;
                slot.hadPlayer = false;
                slot.lastPlayerHealth = -1;
                slot.guard = null;   // the corpse is not blocking; a fresh body starts hands-down
                slot.blockHit = null;
                slot.load = null;    // nothing is being wound by a corpse
                // The errands die with the body that owned them. A fresh body did not throw those
                // weapons, its drops are somewhere else entirely, and sending it to fetch a
                // predecessor's trident is the last thing a just-respawned agent wants.
                Retrieve.clear(slot);
                slot.totemCount = 0; // a fresh body carries nothing, totems included
                slot.hazards.clear();
                slot.lastInventory = null; // consumed by this death; a fresh body carries nothing
                slot.foodWarned = false; // a fresh body starts full — the latch must not survive it
                slot.observer.reset();
                Perception.reset(slot);
                EventLog.emit("body_died", d, slot.target());
            } else if (pb != null) {
                float ph = pb.getHealth();
                // WHAT THE SHIELD ATE (COMBAT_KIT_PLAN.md §4.6). Drained by Shields.tick earlier in
                // this same pass. A blow blocked WHOLE moves no health, so the health-delta test
                // below cannot see it even in principle — and that blow is exactly the one an agent
                // most needs to hear about, because "nobody is shooting at me" and "somebody is
                // shooting at me and the shield is holding" look identical from every other angle.
                Shields.Hit blk = slot.blockHit;
                if (slot.hadPlayer && ph < slot.lastPlayerHealth - 1.0e-3F) {
                    JsonObject d = new JsonObject();
                    d.addProperty("body", "player");
                    d.addProperty("damage", slot.lastPlayerHealth - ph);
                    d.addProperty("health", ph);
                    d.addProperty("maxHealth", pb.getMaxHealth());
                    var src = pb.getLastDamageSource();
                    d.addProperty("cause", src == null ? "unknown" : src.getMsgId());
                    addShieldFacts(d, blk);
                    addVec(d, "pos", pb.position());
                    stampEnvelope(d, pb);
                    EventLog.emit("body_damaged", d, slot.target());
                    // Freshest snapshot of what is about to be lost if this damage proves fatal.
                    slot.lastInventory = inventorySummary(pb);
                } else if (blk != null) {
                    // Nothing got through. Still a hit, still news, and reported through the SAME
                    // event so an agent has one place to learn it is under attack — at damage 0,
                    // which is the honest number.
                    JsonObject d = new JsonObject();
                    d.addProperty("body", "player");
                    d.addProperty("damage", 0);
                    d.addProperty("health", ph);
                    d.addProperty("maxHealth", pb.getMaxHealth());
                    d.addProperty("cause", blk.cause);
                    addShieldFacts(d, blk);
                    d.addProperty("note", "the shield took it all — you are being attacked and are "
                        + "losing no health. The block is not free: the shield takes the damage, and "
                        + "an axe can knock it aside");
                    addVec(d, "pos", pb.position());
                    stampEnvelope(d, pb);
                    EventLog.emit("body_damaged", d, slot.target());
                }
                if (blk != null && blk.disabled) {
                    JsonObject d = new JsonObject();
                    d.addProperty("cause", blk.cause);
                    if (blk.disabledFor > 0) {
                        d.addProperty("ticks", blk.disabledFor);
                    }
                    d.addProperty("note", "your guard was knocked aside — the shield is on cooldown "
                        + "and CANNOT be raised until it clears. Break contact or fight with the "
                        + "weapon; raising it again refuses shield_disabled");
                    addVec(d, "pos", pb.position());
                    stampEnvelope(d, pb);
                    EventLog.emit("shield_disabled", d, slot.target());
                }
                // A DEATH THAT DID NOT HAPPEN IS STILL NEWS (COMBAT_KIT_PLAN.md §4.6). Vanilla's
                // checkTotemDeathProtection consumes the stack, sets health to 1.0 and moves on;
                // nothing in the toolkit said a word, so an agent reading a low health afterwards
                // would conclude it had merely been hurt — and would keep fighting the thing that
                // had just killed it, now with no totem.
                //
                // DETECTED BY THE COUNT, and by the count ALONE. Two earlier cuts of this were
                // wrong in instructive ways, both caught live on 2026-08-12:
                //
                //   "health is exactly the 1.0 vanilla sets" — never fired once. The totem grants
                //   itself Regeneration II in the same breath, so by the time any watcher looks the
                //   body already reads 2.0. The instant vanilla writes is not observable from here.
                //
                //   "...and a totem was in a hand LAST TICK" — fired only when the test was slow.
                //   That belief is refreshed once per tick, but the offhand policy equips the totem
                //   INSIDE a tool call: when the killing blow lands in the same inter-tick window
                //   as the equip, the flag still says what was true before it. Any per-tick "what
                //   was true last tick" state is stale for whatever the tool calls change mid-tick,
                //   and a detector resting on one is a race with a plausible-looking condition.
                //
                // The TOTAL CARRIED has neither problem. The player inventory's container spans the
                // equipment slots, so moving a totem between pack and offhand — the one thing the
                // policy does mid-tick — leaves the number untouched; only vanilla consuming one
                // changes it. A drop in that number, on a tick where the body took damage and is
                // still alive, is a totem spent, and it stays true however the ticks fall.
                int totems = totemCount(pb);
                if (slot.hadPlayer && totems < slot.totemCount
                        && ph < slot.lastPlayerHealth && pb.isAlive()) {
                    JsonObject d = new JsonObject();
                    d.addProperty("health", ph);
                    var src = pb.getLastDamageSource();
                    d.addProperty("cause", src == null ? "unknown" : src.getMsgId());
                    d.addProperty("totems_left", totems);
                    d.addProperty("note", "a totem of undying was CONSUMED — the body should have "
                        + "died. Vanilla set it to 1 health; the reading above is a moment later, "
                        + "after the totem's own Regeneration started. Disengage, heal, and equip "
                        + "another before the next hit"
                        + (totems == 0 ? " — there are NONE left" : ""));
                    addVec(d, "pos", pb.position());
                    stampEnvelope(d, pb);
                    EventLog.emit("totem_used", d, slot.target());
                }
                slot.totemCount = totems;
                slot.hadPlayer = true;
                slot.lastPlayerHealth = ph;
            } else if (slot.hadPlayer) {
                slot.hadPlayer = false;
                slot.lastPlayerHealth = -1;
                slot.totemCount = 0;
            }

            if (drone != null) {
                float health = drone.getHealth();
                // The drain follows activeBody(), which prefers the PLAYER when a slot somehow holds
                // both. Reading it here regardless would credit the drone with a block the player
                // made — rare (bot_body spawn replaces the body) and silent, which is the worst
                // combination for a fact an agent would act on.
                Shields.Hit dblk = pb == null ? slot.blockHit : null;
                if (slot.hadDrone && health < slot.lastHealth - 1.0e-3F) {
                    JsonObject d = new JsonObject();
                    d.addProperty("damage", slot.lastHealth - health);
                    d.addProperty("health", health);
                    d.addProperty("maxHealth", drone.getMaxHealth());
                    addShieldFacts(d, dblk);
                    addVec(d, "pos", drone.position());
                    EventLog.emit("drone_damaged", d, slot.target());
                } else if (dblk != null) {
                    // Blocked whole — same reasoning as the player branch above. A caller must not
                    // be able to tell the two body families apart by which facts they can state.
                    JsonObject d = new JsonObject();
                    d.addProperty("damage", 0);
                    d.addProperty("health", health);
                    d.addProperty("maxHealth", drone.getMaxHealth());
                    d.addProperty("cause", dblk.cause);
                    addShieldFacts(d, dblk);
                    addVec(d, "pos", drone.position());
                    EventLog.emit("drone_damaged", d, slot.target());
                }
                slot.hadDrone = true;
                slot.lastHealth = health;
            } else if (slot.hadDrone) {
                slot.hadDrone = false;
                slot.lastHealth = -1;
                JsonObject d = new JsonObject();
                d.addProperty("reason", "died_or_unloaded");
                EventLog.emit("drone_removed", d, slot.target());
            }
        }
    }

    /**
     * Stamp what the shield did onto a damage event (COMBAT_KIT_PLAN.md §4.6). Null-tolerant and
     * silent when nothing blocked, so a body with no shield gains no empty keys — the mere presence
     * of {@code blocked} is the fact, the same rule {@code drawing} and {@code blocking} follow.
     *
     * <p>{@code blocked_damage} is what the shield ABSORBED, not what got through: on a partial
     * block the event carries both, and {@code damage + blocked_damage} is what the blow was worth.
     */
    private static void addShieldFacts(final JsonObject d, final Shields.@Nullable Hit hit) {
        if (hit == null) {
            return;
        }
        d.addProperty("blocked", true);
        d.addProperty("blocked_damage", Math.round(hit.blocked * 100.0) / 100.0);
        if (hit.hits > 1) {
            d.addProperty("blocked_hits", hit.hits);
        }
        if (hit.disabled) {
            d.addProperty("shield_disabled", true);
        }
    }

    /**
     * True while a {@code wait:true} call from this session is still parked on an outstanding
     * action. Session liveness is refreshed per bridge CALL ({@code Sessions.touch}), so a session
     * whose one call is a long-running waited goal goes "stale" while its HTTP request is literally
     * still open — and reaping under it turns a merely-slow goal into {@code session_ended}
     * (live-caught: the probe battery's door course at ~3 minutes under full load). An open request
     * is the strongest liveness signal there is; the reap must wait for it to resolve.
     */
    static boolean waiterParked(final Slot slot) { // package: ActivitySnapshot reads it too
        return (slot.goal != null && slot.goal.waiter != null && !slot.goal.waiter.isDone())
            || (slot.queue != null && slot.queue.waiter != null && !slot.queue.waiter.isDone())
            // F1 turned `bot_attack` into a short act, so a wait:true attack now parks an OPEN
            // request on the turn exactly like a waited goal does (S11) — without this line the
            // reap could sweep the slot out from under that request and answer it session_ended.
            // Bounded by DroneHands.SWING_TIMEOUT_TICKS, whose clock now always runs (see the
            // unconditional swingTick in tickWatch), so this can never hold a slot open.
            || (slot.swing != null && slot.swing.waiter != null && !slot.swing.waiter.isDone())
            // A `bot_shoot {wait:true}` parks an open request on the draw, exactly as the swing
            // does. Bounded by PlayerVerbs.AIM_TIMEOUT_TICKS plus the draw, and its clock also
            // always runs (useTick is unconditional), so this cannot hold a slot open either.
            || (slot.use != null && slot.use.waiter != null && !slot.use.waiter.isDone())
            || (slot.pendingNav != null && slot.pendingNav.waiter != null
                && !slot.pendingNav.waiter.isDone());
    }

    /**
     * Close out a slot's outstanding flight (if any) with a structured reason. A supersede — a new
     * goto replacing the old one — is normal control flow, not a failure: it gets its own event type
     * so downstream consumers can ignore it without losing the audit trail. Everything else is a real
     * {@code action_failed}. Waiters and a queue waiting on the flight are notified either way.
     */
    static void failPending(final Slot slot, final String reason) {
        PendingNav p = slot.pendingNav;
        if (p == null) {
            return;
        }
        slot.pendingNav = null;
        JsonObject d = new JsonObject();
        d.addProperty("action_id", p.actionId);
        d.addProperty("action", "bot_goto");
        d.addProperty("reason", reason);
        // Cells walked before the stop were still walked — a failed flight discloses its trail too.
        if (p.body != null && !p.body.isRemoved()) {
            attachTraversal(d, p.body);
        }
        EventLog.emit("superseded".equals(reason) ? "action_superseded" : "action_failed", d, slot.target());
        if (p.waiter != null) {
            p.waiter.complete(d.deepCopy());
        }
        QueueRunner.onActionFailed(slot, p.actionId, reason);
        GoalRunner.onActionFailed(slot, p.actionId, reason);
    }

    /**
     * The embodied envelope (SURVIVAL_MODE_PLAN.md §4) — the read-side {@code addEnvelope}'s twin:
     * tick + dimension from the BODY's own level, so an embodied verdict is honestly datable and
     * placeable (capture refuses envelope-less results by contract).
     */
    static void stampEnvelope(final JsonObject r, final @Nullable LivingEntity body) {
        if (body == null || r.has("game_tick")) {
            return;
        }
        r.addProperty("game_tick", body.level().getGameTime());
        r.addProperty("dimension", body.level().dimension().identifier().toString());
    }

    /** {@link #stampEnvelope} by session id — the dispatch chokepoint's entry (BridgeServer). */
    public static void stampEnvelopeFor(final JsonObject r, final @Nullable String sessionId) {
        stampEnvelope(r, activeBodyFor(sessionId));
    }

    /**
     * The free half of {@code bot_status}, {@code bot_watch {list}} and "am I there yet", riding an
     * act the session was making anyway (see the call site in {@code BridgeServer} for why).
     *
     * <p>Everything here is conditional. A field that is always present is a field that is always
     * paid for, and the static prefix already measures 50–92% of the token bill
     * (TOKEN_PER_TOOL_FINDINGS.md Finding 1): vitals only when they are worth knowing, watches only
     * when a sighting actually happened since the last act, goal distance only while a goal is
     * running. On a quiet body this adds nothing at all.
     */
    public static void stampBodyStateFor(final JsonObject r, final @Nullable String sessionId) {
        Slot slot = peekSlot(sessionId);
        if (slot == null) {
            return;
        }
        LivingEntity body = slot.activeBody();
        if (body == null) {
            return;
        }
        // Watch sightings since the last act. `iron_ore:+2` is the whole message: what, how many,
        // and (by its absence) that nothing else was seen.
        JsonObject watches = null;
        for (Watch.Entry w : slot.watches) {
            int delta = w.sightings - w.reported;
            if (delta > 0) {
                w.reported = w.sightings;
                if (watches == null) {
                    watches = new JsonObject();
                }
                watches.addProperty(w.id, "+" + delta);
            }
        }
        if (watches != null) {
            r.add("watches", watches);
        }
        // "Am I there yet" — the question that was costing a whole movement goal to ask. 58 of ~185
        // bot_target calls in w2-56123 came back already_there, and the note scolded the agent for
        // re-issuing when what it was actually doing was reading a distance no cheaper read exposed.
        GoalRunner.Goal goal = slot.goal;
        if (goal != null && goal.target != null && !r.has("distance_to_goal")) {
            double d = body.position().distanceTo(goal.target.where());
            r.addProperty("distance_to_goal", Math.round(d * 10.0) / 10.0);
            r.addProperty("at_goal", d <= GoalRunner.MOVE_WITHIN);
        }
        // Vitals, on the cheap: health always (it is the number that ends runs), food only once it
        // matters, air only while it is draining.
        if (body instanceof net.minecraft.world.entity.player.Player p && !r.has("health")) {
            r.addProperty("health", Math.round(p.getHealth() * 10.0F) / 10.0F);
            int food = p.getFoodData().getFoodLevel();
            if (food <= 14) {
                r.addProperty("food", food);
            }
            if (p.getAirSupply() < p.getMaxAirSupply()) {
                r.addProperty("air", p.getAirSupply());
            }
        }
    }

    /**
     * Attach the body's drained proprioception trail to a nav verdict — {@code traversed} rows
     * {@code [x, y, z, feet_id, head_id, ground_id]} of cells the body actually reached, plus the
     * envelope that makes them capturable. Bodies without a trail (flyer, possessed) stamp the
     * envelope only.
     */
    static void attachTraversal(final JsonObject d, final LivingEntity body) {
        stampEnvelope(d, body);
        com.mattmc.mcptoolkit.nav.TraversalTrail trail = Bodies.nav(body).trail();
        if (trail == null) {
            return;
        }
        boolean truncated = trail.wasTruncated();
        java.util.List<com.mattmc.mcptoolkit.nav.TraversalTrail.Cell> cells = trail.drain();
        if (cells.isEmpty()) {
            return;
        }
        com.google.gson.JsonArray rows = new com.google.gson.JsonArray();
        for (var c : cells) {
            com.google.gson.JsonArray row = new com.google.gson.JsonArray();
            row.add(c.x());
            row.add(c.y());
            row.add(c.z());
            row.add(c.feet());
            row.add(c.head());
            row.add(c.ground());
            rows.add(row);
        }
        d.add("traversed", rows);
        if (truncated) {
            d.addProperty("traversed_truncated", true); // cells were dropped at the cap — say so
        }
    }

    /**
     * Displace whatever base intent currently drives the active body, then tag the slot with the
     * new one. The mutually-exclusive base intents (GOTO, RUN, FOLLOW, later ENGAGE) each install
     * through here instead of hand-listing their rivals, so adding a base intent — or the reflex
     * layer's "an explicit command cancels an in-flight reaction" — touches one place, not five.
     *
     * <p>Faithful to the pre-refactor teardown: the displaced queue is aborted with
     * {@code queueReason} and follow mode is cleared (silently). Outstanding flights
     * ({@code pendingNav}) are still superseded by each caller as before — a manual goto inside
     * {@link #startNav}, a queue/follow at its own call site — because that reason and timing vary.
     */
    static void claimBase(final Slot slot, final BaseKind kind, final String queueReason) {
        Reflexes.cancel(slot);                // an explicit command wins over an in-flight reaction
        QueueRunner.abort(slot, queueReason); // a sequenced queue yields to the new base intent
        Follow.clear(slot);                   // and continuous follow yields too (silent)
        Engage.clear(slot);                   // and combat engage
        GoalRunner.abort(slot, queueReason);  // ...and a running bot_target goal (a new one supersedes)
        slot.baseKind = kind;
    }

    /**
     * Re-issue navigation for a flight the reflex layer paused (suspend stops the body's navigation;
     * this drives it back toward the same target on resume). A reach goal re-solves its touch shell;
     * a plain goto re-heads to the point. Both the manual {@code bot_goto} and a queue's goto step
     * track their flight as {@link Slot#pendingNav}, so this one path resumes either. Speed defaults
     * to 1.0 — the original multiplier is not retained across the interrupt.
     */
    static void renav(final PendingNav p) {
        LivingEntity body = p.body;
        if (body.isRemoved() || !body.isAlive()) {
            return;
        }
        // The re-solve's verdict is honored, not discarded. This used to ignore both returns, so a
        // reflex that tore the path down and a re-plan that then FAILED left path == null with the
        // flight still pending — which the verdict block read as a plain `stopped_short traveled:0`,
        // the lying loop w2-79881 sat in for minutes. A failed re-plan is its own outcome now.
        boolean replanned;
        if (p.reachTarget != null) {
            ServerLevel level = (ServerLevel) body.level();
            com.mattmc.mcptoolkit.ReachSolver.Result res =
                com.mattmc.mcptoolkit.ReachSolver.solve(level, p.reachTarget, body.getEyeHeight(), true);
            replanned = res.visible() > 0
                && Bodies.nav(body).moveToStands(res.stands(), 1.0, p.profile) != null;
        } else {
            replanned = Bodies.nav(body).moveTo(p.target.x, p.target.y, p.target.z, 1.0, p.profile);
        }
        if (!replanned && p.stalledAs == null) {
            p.stalledAs = "replan_failed"; // the verdict block completes the flight honestly
        }
    }

    /** The slot's active body (possessed mob or drone), or throws with the spawn hint. */
    static LivingEntity requireBody(final Slot slot) {
        LivingEntity body = slot.activeBody();
        if (body == null) {
            throw new IllegalStateException(
                "your session has no body — spawn one with bot_body {action:\"spawn\"} first. If you "
                + "HAD a body, it is gone (died or despawned): check get_events for "
                + "body_died/body_removed before respawning");
        }
        return body;
    }

    /** The slot's drone specifically (beam/hands hardware), or throws. */
    static BotBodyEntity requireDrone(final Slot slot) {
        BotBodyEntity drone = slot.drone();
        if (drone == null) {
            throw new IllegalStateException(
                "your session has no drone — spawn one with bot_body {action:\"spawn\"} first "
                + "(this verb needs drone hardware)");
        }
        return drone;
    }

    // ---- json helpers --------------------------------------------------------

    /** Every death-protection item the body carries, hands and armor slots included (the player
     *  inventory's container spans them). By the COMPONENT vanilla itself consumes, not by item id,
     *  so a modded totem counts exactly as the vanilla one does. The number whose DROP means one
     *  was spent. */
    private static int totemCount(final ServerPlayer body) {
        net.minecraft.world.entity.player.Inventory inv = body.getInventory();
        int n = 0;
        for (int i = 0; i < inv.getContainerSize(); i++) {
            net.minecraft.world.item.ItemStack st = inv.getItem(i);
            if (st.has(net.minecraft.core.component.DataComponents.DEATH_PROTECTION)) {
                n += st.getCount();
            }
        }
        return n;
    }

    /**
     * The body's carried items, tallied by id — the manifest of what a death scatters on the ground.
     *
     * <p>Aggregated by item rather than listed per slot because that is the shape the answer is
     * used in: dropped stacks merge on the floor, and "iron_pickaxe ×1, cobblestone ×47" is what
     * you go back for. Empty slots are skipped; an empty inventory yields an empty array, which the
     * caller treats as "nothing to report" rather than emitting a hollow field.
     */
    private static JsonArray inventorySummary(final ServerPlayer sp) {
        java.util.Map<String, Integer> byItem = new java.util.LinkedHashMap<>();
        net.minecraft.world.entity.player.Inventory inv = sp.getInventory();
        for (int i = 0; i < inv.getContainerSize(); i++) {
            net.minecraft.world.item.ItemStack st = inv.getItem(i);
            if (st.isEmpty()) {
                continue;
            }
            String id = net.minecraft.core.registries.BuiltInRegistries.ITEM
                .getKey(st.getItem()).toString();
            byItem.merge(id, st.getCount(), Integer::sum);
        }
        JsonArray out = new JsonArray();
        for (java.util.Map.Entry<String, Integer> e : byItem.entrySet()) {
            JsonObject o = new JsonObject();
            o.addProperty("item", e.getKey());
            o.addProperty("count", e.getValue());
            out.add(o);
        }
        return out;
    }

    static void addVec(final JsonObject r, final String key, final Vec3 v) {
        // 3 decimals, matching WorldPerceptionTools.addVec: sub-millimeter precision is meaningless
        // in-world, and raw doubles serialize with 15+ digit tails that are pure token waste.
        JsonObject o = new JsonObject();
        o.addProperty("x", round3(v.x));
        o.addProperty("y", round3(v.y));
        o.addProperty("z", round3(v.z));
        r.add(key, o);
    }

    static double round3(final double v) {
        return Math.round(v * 1000.0) / 1000.0;
    }

    private static void addPos(final JsonObject r, final String key, final BlockPos p) {
        JsonObject o = new JsonObject();
        o.addProperty("x", p.getX());
        o.addProperty("y", p.getY());
        o.addProperty("z", p.getZ());
        r.add(key, o);
    }
}
