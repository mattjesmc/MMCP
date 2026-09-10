package com.mattmc.mcptoolkit.drone;

import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.EventLog;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

/**
 * Combat movement — a per-tick watch driven by (threat table × combat mode), not a base intent
 * (BOT_SURFACE_DESIGN.md §4).
 *
 * <p><b>What changed and why it matters.</b> This used to be {@code BaseKind.ENGAGE}: it occupied the
 * single base slot, so starting a fight <em>cancelled the journey</em> and the body could never travel
 * and fight at once. Engagement is now a body <b>mode</b> ({@code bot_body engage:true}) and the target
 * comes from {@link ThreatTable}, so:
 *
 * <ul>
 *   <li><b>defend</b> — the reflex layer does the fighting with routing-free responses (strafe,
 *       backstep, shield, attack: PLAYER_CONTROL_DESIGN.md §2.5). This watch claims <em>no</em>
 *       movement, so a running {@code bot_target} goal keeps its path: mine, fight off what jumps
 *       you, resume mining.</li>
 *   <li><b>fight</b> — the body commits. The watch suspends the base intent (exactly as a reaction
 *       does), station-keeps at {@code range} until the enemy is down, then releases the base and
 *       re-issues the paused flight, so the interrupted goal continues rather than dying.</li>
 * </ul>
 *
 * <p>Because targets come from a table, a killed enemy no longer ends engagement — the watch simply
 * picks the next. The old per-kill {@code engage_lost}/re-issue round trip is gone.
 */
final class Engage {

    /** Widest drift before we re-path (ranged, and the melee ceiling), and minimum ticks between
     *  re-paths (matches Follow's cadence). Melee spends less — see {@link #repathDistance}. */
    private static final double REPATH_DISTANCE = 1.25;
    private static final int REPATH_INTERVAL = 5;
    /** Finest drift a melee station will re-path on, so a tight reach budget cannot turn into a
     *  re-path every tick (the {@link #REPATH_INTERVAL} cooldown still caps the rate). */
    private static final double MIN_REPATH_DISTANCE = 0.35;
    /** Melee station distance for the {@code close} policy. */
    private static final double MELEE_RANGE = 1.6;
    /** Legacy stored default (pre-F4); the weapon-derived default wins unless the caller passed an
     *  explicit range ({@code slot.combatRangeExplicit}). */
    static final double DEFAULT_RANGE = 6.0;

    // F4 (V3_PLAN.md §2): the stand range FOLLOWS THE HELD WEAPON, as the game itself fights.
    // Melee (sword/axe/empty/anything else) stations inside swing reach; ranged (bow/crossbow)
    // keeps the skeleton's distance. An explicit `range` clamps into the held weapon's band —
    // kite-at-6-with-a-sword (the fight the walker lost 20→0 without one swing) is unrequestable.
    static final double MELEE_BAND_MIN = 1.0;
    /**
     * The half-cell diagonal (0.707), rounded up: the most a whole-cell anchor snap can add to a
     * stand's distance from the enemy. {@link #anchorFor} derives a continuous point at stand range
     * and then hands back the CENTRE of the cell it lands in ({@code Vec3.atBottomCenterOf}), so
     * the melee reach budget pays for that snap up front instead of discovering it in a fight.
     */
    static final double ANCHOR_SNAP_SLACK = 0.75;
    /**
     * The widest melee band ANY body family can be given: the fictional 4.0-reach toolkit body
     * (drone/walker/possessed, {@link Actuator#ENTITY_REACH}) minus the snap. The EFFECTIVE ceiling
     * is per body — {@link #meleeStandMax} — because the player body's honest reach is the vanilla
     * {@code entity_interaction_range} (3.0). Kept as a constant only for the reply's band wording.
     */
    static final double MELEE_BAND_MAX = Actuator.ENTITY_REACH - ANCHOR_SNAP_SLACK;
    static final double MELEE_DEFAULT = 2.5;
    static final double RANGED_BAND_MIN = 6.0;
    static final double RANGED_BAND_MAX = 20.0;
    static final double RANGED_DEFAULT = 10.0;
    /** Ring bearings sampled when the preferred anchor is not standable. */
    private static final int RING_SAMPLES = 16;

    /**
     * The body a fight-mode station last put into SPRINT. The flag is sticky on the nav driver
     * ({@code NavDriver.sprintAll}) and survives every later path, so it has to be cleared on the
     * body it was SET on — not on whatever body the slot happens to hold when the fight ends. Take
     * or release a possession between {@link #station}'s sprint and the clear and the old body
     * sprints forever: harmless on a discarded drone, permanent on a released mob that keeps
     * walking the world. Weak keys (a dead slot takes its entry with it) and a weak value (this
     * bookkeeping must never pin a removed body alive). Server-thread only, like all slot state.
     */
    private static final java.util.Map<DroneTools.Slot, java.lang.ref.WeakReference<LivingEntity>>
        SPRINTING = new java.util.WeakHashMap<>();

    private Engage() {}

    /**
     * Can the body fight at range — i.e. does it CARRY a projectile weapon it can feed?
     * Delegates to {@link CombatKit#rangedCapable}, which is now the one owner of that question.
     *
     * <p>This used to read the HELD stack, and that was the {@link WeaponGate} defect one level
     * up: a body carrying a bow but holding the pickaxe the dig gate left it read as melee and
     * stationed inside a zombie's reach. It also now requires AMMUNITION, because a bow with an
     * empty quiver is not a ranged capability — it is a stick that keeps the body at 10 blocks
     * doing nothing, which is a worse death than closing.
     */
    static boolean holdsRangedWeapon(final LivingEntity body) {
        return CombatKit.rangedCapable(Hands.of(body));
    }

    /**
     * The melee band's ceiling FOR THIS BODY: its honest swing reach ({@link AttackGate#entityReach}
     * — the vanilla {@code entity_interaction_range} 3.0 on the player body, the disclosed fictional
     * 4.0 on drone/walker/possessed) minus the anchor's whole-cell snap.
     *
     * <p><b>The invariant this establishes:</b> a melee fight-mode stand is always inside the body's
     * OWN swing reach, whatever body it is. The audited death (EVAL_AUDIT_V2.md §10 item 3) was a
     * station outside that reach: a full-health walker in fight/kite(6) died to one zombie in ~170
     * ticks without landing a swing, because the standing attack rule can never fire from a stand
     * the arm cannot cross. A fixed band max re-created the same dead band in miniature — 3.5
     * against the player body's 3.0 reach was accepted, un-clamped, and silent (the old kite_note
     * that used to disclose the contradiction was deleted in the F4/F5 rewrite).
     */
    static double meleeStandMax(final LivingEntity body) {
        return Math.max(MELEE_BAND_MIN, AttackGate.entityReach(body) - ANCHOR_SNAP_SLACK);
    }

    /**
     * The effective stand range for this slot given the held weapon: the weapon's default, or the
     * caller's explicit range clamped into the weapon's band.
     *
     * <p>The MELEE band's ceiling is derived from the active body's reach ({@link #meleeStandMax}),
     * so the band cannot outrun the arm on any body family, and the default is capped by it too —
     * 2.5 with a 3.0 reach plus the snap plus the old fixed drift tolerance rested the body ~4.2
     * from the enemy, a melee kite that still never landed a swing. A caller's range that the cap
     * moves reports {@code range_clamped} + {@code note_range} in the {@code bot_body engage} reply
     * (V3_PLAN.md §2 F4: "an explicit range still wins but clamps into the held weapon's band with
     * a note in the reply"). The RANGED band is untouched by reach — an arrow is not reach-gated.
     */
    static double standRange(final DroneTools.Slot slot, final boolean ranged) {
        if (ranged) {
            return slot.combatRangeExplicit
                ? Math.min(Math.max(slot.combatRange, RANGED_BAND_MIN), RANGED_BAND_MAX)
                : RANGED_DEFAULT;
        }
        LivingEntity body = slot.activeBody();
        // No body to measure: quote the widest melee band any body could have, so the reply stays
        // conservative rather than promising a reach nothing here owns.
        double max = body == null ? MELEE_BAND_MAX : meleeStandMax(body);
        double want = slot.combatRangeExplicit ? slot.combatRange : MELEE_DEFAULT;
        return Math.min(Math.max(want, MELEE_BAND_MIN), max);
    }

    /**
     * How far the body may drift from its station before we re-path. Melee spends what is LEFT of
     * the swing-reach budget after the stand range and the anchor snap: a fixed 1.25 meant a
     * 2.5-block station could rest ~4.2 blocks from the enemy — inside the drift tolerance, outside
     * a 3.0 reach — so "on station" and "can swing" were different facts and the body died holding
     * the first. Ranged has no such budget (the arrow is not reach-gated) and keeps Follow's cadence.
     */
    private static double repathDistance(final LivingEntity body, final double standRange,
                                         final boolean ranged) {
        if (ranged) {
            return REPATH_DISTANCE;
        }
        double budget = AttackGate.entityReach(body) - ANCHOR_SNAP_SLACK - standRange;
        return Math.min(REPATH_DISTANCE, Math.max(MIN_REPATH_DISTANCE, budget));
    }

    /**
     * Melee only: can the body SWING from this stand? Both sides are feet positions — the anchor is
     * a cell's bottom centre and {@link AttackGate} gates on {@code Entity.distanceTo}, which is
     * position-to-position — so a stand that passes here is a stand the standing attack rule can
     * actually fire from. Ranged stands are exempt: the whole point of a bow is fighting outside it.
     */
    private static boolean inSwingReach(final Vec3 stand, final Vec3 targetPos, final double reach,
                                        final boolean ranged) {
        return ranged || stand.distanceTo(targetPos) <= reach;
    }

    /** Sprint this body's navigation for fight-mode repositioning, REMEMBERING which body it was
     *  (see {@link #SPRINTING}) so the clear can reach it after a possession change. */
    private static void sprintOn(final DroneTools.Slot slot, final LivingEntity body) {
        Bodies.nav(body).setSprint(true);
        SPRINTING.put(slot, new java.lang.ref.WeakReference<>(body));
    }

    /** Clear the combat sprint on the body that was actually set sprinting — and on nothing else.
     *  A removed body needs no clearing (its navigation went with it); a released mob does. */
    private static void sprintOff(final DroneTools.Slot slot) {
        java.lang.ref.WeakReference<LivingEntity> ref = SPRINTING.remove(slot);
        LivingEntity sprinting = ref == null ? null : ref.get();
        if (sprinting != null && !sprinting.isRemoved()) {
            Bodies.nav(sprinting).setSprint(false);
        }
    }

    /**
     * Advance combat one tick. Returns true when this watch owns the body's movement (fight mode with
     * a live enemy), so the caller knows the base intent is suspended.
     */
    static boolean tick(final DroneTools.Slot slot) {
        if (!slot.engaged) {
            return releaseIfHeld(slot);
        }
        LivingEntity body = slot.activeBody();
        if (body == null) {
            return releaseIfHeld(slot);
        }
        LivingEntity target = slot.threats.pick((net.minecraft.server.level.ServerLevel) body.level(), body);
        if (target == null) {
            return releaseIfHeld(slot);
        }

        // Face the enemy through the SWING GATE, not a lookAt (V3_PLAN.md §2 F1, decision 1:
        // "rate-limited turn, not flick"). This site is one of the two unverified courtesy lookAt
        // calls EVAL_AUDIT_V2.md §10 item 1 names, and only GoalRunner's was replaced in the F-block
        // rewrite: it snapped the head onto the enemy in a single tick, so AttackGate was already
        // READY by the time any swing path ran and the turn-then-press pattern — the gaze-leads-
        // action data the v3 campaign exists to collect — never appeared in COMBAT, the one mode
        // that fights. The gate turns at the driver's own gaze rate and OWNS the gaze while it does
        // (AttackGate.holdsGaze), so the movement drivers withhold yaw/pitch for this body instead
        // of overwriting the aim on every driven frame.
        // AIM, not gate: gate answers "may I swing?" and so releases the gaze and declines to turn
        // whenever the answer is no — out of reach or occluded. A ranged fight stations at 10 and
        // is out of SWING reach every tick of its life, so gating the aim left an archer facing its
        // nav heading for the whole duel while the line below claimed the head (found in review;
        // it is EVAL_AUDIT_V2.md §10 item 1 regrowing inside its own fix). Aim turns at the same
        // rate-limited gaze rate at any distance; only the swing itself is gated on reach.
        AttackGate.aim(body, target);
        // The LookDriver veto is now a true claim: aim holds the gaze unconditionally, so the head
        // really does belong to the fight on every tick a threat is picked.
        slot.enemyFacedThisTick = true;

        if (!"fight".equals(slot.combatMode)) {
            return false; // defend: reflexes handle it; the base intent keeps the body
        }

        if (!slot.combatHoldsBody) {
            slot.combatHoldsBody = true;
            Bodies.nav(body).stop();
            JsonObject d = new JsonObject();
            d.addProperty("target_id", target.getId());
            d.addProperty("mode", "fight");
            EventLog.emit("engage_started", d, slot.target());
        }
        loose(slot, body, target, station(slot, body, target));
        return true;
    }

    /** Ticks between arrows from a fight-mode engagement — a full draw (20) plus the aim, so the
     *  next shot is asked for at about the moment the previous one has left the bow. */
    private static final int SHOT_INTERVAL = 30;

    /**
     * <b>A fight-mode engagement that stands at bow range LOOSES ARROWS.</b>
     *
     * <p>Until toolkit 0.73.0 nothing here fired: {@link #station} would take a body carrying a fed
     * bow out to the ranged band (or up onto {@link Vantage}'s ledge), aim at the enemy every tick —
     * and then wait for the fight REFLEX to swing, which answers {@code out_of_reach} at 10 blocks
     * for as long as the duel lasts. The body backed away from its enemy and did nothing, which is
     * the {@code target_unreachable} defect wearing different clothes: the arsenal was carried, the
     * decision to use it was made, and no path pulled the trigger.
     *
     * <p>The shot is asked for, never forced: {@code botShoot} re-runs its own gates (ammunition,
     * sightline, one draw at a time) and refuses honestly. And this runs ONLY when no reflex owns
     * the body — a reaction returning true means {@code Engage.tick} is not called at all — so an
     * armed {@code shoot} reflex and the engagement can never both be drawing the same bow.
     *
     * <p><b>PLAYER BODIES ONLY</b>, like every other automatic arming decision in this workstream
     * (the dig gate, {@link WeaponGate}, {@link CombatKit#equip}). The drone is a recon instrument
     * whose shot is a launched arrow rather than a draw, and one that starts loosing arrows at
     * whatever it engages is both a surprise on the dev surface and a change to probe-pinned
     * behaviour — the kite cases in {@code reflexes-engage} stage an armed archer drone precisely to
     * exercise the ranged STATION, and it killed its own subject mid-measurement (caught live).
     */
    private static void loose(final DroneTools.Slot slot, final LivingEntity body,
                              final LivingEntity target, final CombatKit.Kit kit) {
        if (slot.combatShotCooldown > 0) {
            slot.combatShotCooldown--;
            // WIND THE CROSSBOW WITH THE TIME BETWEEN SHOTS (COMBAT_KIT_PLAN.md §4.3). This is the
            // richest such time there is: the cooldown covers a full draw, and station() has just
            // spent the same tick walking the body toward its band or up onto a vantage. A crossbow
            // charged here is a bolt that leaves instantly when the rhythm comes round.
            Crossbows.preload(slot, body);
            return;
        }
        if (!(body instanceof FakePlayerEntity) || kit.mode() != CombatKit.Mode.RANGED
                || slot.use != null || !AttackGate.hasLos(body, target)) {
            return;
        }
        JsonObject arg = new JsonObject();
        arg.addProperty("target", target.getId());
        DroneHands.botShoot(arg, slot);
        slot.combatShotCooldown = SHOT_INTERVAL;
    }

    /** Hand the body back when engagement ends, resuming whatever the base intent was doing. */
    private static boolean releaseIfHeld(final DroneTools.Slot slot) {
        if (!slot.combatHoldsBody) {
            return false;
        }
        slot.combatHoldsBody = false;
        sprintOff(slot); // combat sprint ends with the fight — on the body that was SET sprinting
        DroneTools.PendingNav p = slot.pendingNav;
        if (p != null) {
            DroneTools.renav(p); // the interrupted journey continues; it never learned it was paused
        }
        JsonObject d = new JsonObject();
        d.addProperty("reason", "no_designated_target_in_range");
        EventLog.emit("engage_ended", d, slot.target());
        return false;
    }

    /**
     * Station-keeping: hold the chosen relationship to the enemy (kite / strafe / close / hold).
     *
     * <p>F4/F5 rewrite: the anchor is no longer a bare geometric point on the enemy's Y-plane
     * (which was never standability-checked and pinned the walker into a death march along
     * whatever boundary it met — audited live). The stand range follows the HELD weapon, every
     * anchor is validated through {@link Vantage#standAt}'s column search (falling back to the
     * best standable ring bearing), a ranged weapon stations via {@link Vantage#candidates} with
     * elevation-weighted scoring (the archer's ledge), and repositioning SPRINTS — a kite that
     * walks cannot open distance from a zombie.
     *
     * <p>Melee stationing is additionally REACH-BUDGETED: the stand range, the anchor's cell snap
     * and the drift tolerance together must fit inside the body's own swing reach (see
     * {@link #meleeStandMax} / {@link #repathDistance}), because a melee station the arm cannot
     * cross is the audited death with a smaller number on it.
     */
    private static CombatKit.Kit station(final DroneTools.Slot slot, final LivingEntity body,
                                         final LivingEntity target) {
        String policy = slot.combatPolicy;
        net.minecraft.server.level.ServerLevel level =
            (net.minecraft.server.level.ServerLevel) body.level();
        // Decided BEFORE the `hold` early-return, because `hold`'s whole point is standing still
        // AND FIGHTING from there — a held position with a bow is the archer's case, not a reason
        // not to shoot, and the caller needs the kit to know that.
        CombatKit.Kit kit = CombatKit.choose(body, Hands.of(body), target,
            CombatKit.Reachability.UNKNOWN);
        if ("hold".equals(policy)) {
            if (!Bodies.nav(body).isDone()) {
                Bodies.nav(body).stop();
            }
            return kit;
        }
        // WHERE TO STAND FOLLOWS THE MODE, not merely the capability (COMBAT_KIT_PLAN.md §4.3):
        // stationing and weapon choice can no longer disagree. The capability answers "could this
        // body shoot" — which is the right question for the reply, issued before there is an enemy
        // — but the STATION is chosen with an enemy in front of it, and there the distance matters:
        // a body carrying bow AND sword backs out to 10 while the zombie is far and closes to
        // swing reach once it is near, which is what a player does and what the old held-item flag
        // could never express.
        boolean ranged = kit.mode() == CombatKit.Mode.RANGED;
        double standRange = "close".equals(policy) ? MELEE_RANGE : standRange(slot, ranged);
        Vec3 anchor = anchorFor(level, slot, body, target, policy, standRange, ranged);

        if (slot.combatRepathCooldown > 0) {
            slot.combatRepathCooldown--;
        }
        double drift = body.position().distanceTo(anchor);
        double tolerance = repathDistance(body, standRange, ranged);
        // A melee body that has fallen OUT OF ITS OWN SWING REACH re-stations even when the drift
        // alone reads tolerable: the anchor chases a moving enemy, and "on station" is worth nothing
        // if the station cannot swing. This is the second half of the invariant meleeStandMax sets
        // up — the anchor is inside reach by construction, and the body is kept on the anchor.
        boolean outOfSwingReach = !ranged && body.distanceTo(target) > AttackGate.entityReach(body);
        if ((drift > tolerance || outOfSwingReach) && slot.combatRepathCooldown == 0) {
            // DEFAULT: combat repositioning is not a caller-profiled route — it may swim, like the body itself.
            Bodies.Nav nav = Bodies.nav(body);
            nav.moveTo(anchor.x, anchor.y, anchor.z, 1.0,
                com.mattmc.mcptoolkit.nav.NavProfile.DEFAULT);
            sprintOn(slot, body); // F4: fight-mode repositioning sprints (live-proven necessary)
            slot.combatRepathCooldown = REPATH_INTERVAL;
        } else if (drift <= tolerance && !outOfSwingReach && !Bodies.nav(body).isDone()) {
            Bodies.nav(body).stop(); // on station
        }
        return kit;
    }

    /** The stationing anchor: ranged → elevation-weighted vantage (F5); else the geometric
     *  preference validated standable, else the best standable ring bearing (F4). */
    private static Vec3 anchorFor(final net.minecraft.server.level.ServerLevel level,
                                  final DroneTools.Slot slot, final LivingEntity body,
                                  final LivingEntity target, final String policy,
                                  final double standRange, final boolean ranged) {
        Vec3 targetPos = target.position();
        if (ranged && !"close".equals(policy)) {
            Vec3 v = vantageAnchor(level, body, target, standRange);
            if (v != null) {
                return v;
            }
        }
        // Side vector: the horizontal direction from the enemy to the body (hold this side); for
        // strafe, rotate it so the station point drifts around the enemy.
        Vec3 side = body.position().subtract(targetPos);
        side = new Vec3(side.x, 0, side.z);
        side = side.lengthSqr() < 1.0e-6 ? new Vec3(1, 0, 0) : side.normalize();
        Vec3 tangent = new Vec3(-side.z, 0, side.x); // 90° — orbit direction
        Vec3 preferred = "strafe".equals(policy) ? side.add(tangent.scale(0.6)).normalize() : side;
        Vec3 geometric = targetPos.add(preferred.scale(standRange));
        double reach = AttackGate.entityReach(body);
        net.minecraft.core.BlockPos stand = Vantage.standAt(level,
            (int) Math.floor(geometric.x), (int) Math.floor(targetPos.y), (int) Math.floor(geometric.z));
        Vec3 snapped = stand == null ? null : Vec3.atBottomCenterOf(stand);
        if (snapped != null && inSwingReach(snapped, targetPos, reach, ranged)) {
            return snapped;
        }
        // Either the preferred bearing has no footing (wall, drop, water column), or — MELEE — the
        // footing it found cannot swing: the column search answers anywhere within ±6 Y of the
        // enemy, and a stand three blocks below it is the audited dead band again, however good its
        // bearing. Search the ring at stand range for the best STANDABLE bearing — kite keeps the
        // body's side of the enemy and its distance, strafe maximizes the tangent component — with
        // in-swing-reach cells strictly preferred, not required (a body with no reachable footing
        // anywhere still gets a real stand rather than a wall-press).
        Vec3 best = null;
        double bestScore = -Double.MAX_VALUE;
        for (int s = 0; s < RING_SAMPLES; s++) {
            double angle = (2 * Math.PI * s) / RING_SAMPLES;
            net.minecraft.core.BlockPos c = Vantage.standAt(level,
                (int) Math.floor(targetPos.x + standRange * Math.cos(angle)),
                (int) Math.floor(targetPos.y),
                (int) Math.floor(targetPos.z + standRange * Math.sin(angle)));
            if (c == null) {
                continue;
            }
            Vec3 cv = Vec3.atBottomCenterOf(c);
            Vec3 dir = new Vec3(cv.x - targetPos.x, 0, cv.z - targetPos.z);
            dir = dir.lengthSqr() < 1.0e-6 ? side : dir.normalize();
            double score = "strafe".equals(policy)
                ? Math.abs(dir.dot(tangent)) + 0.25 * dir.dot(side)
                : dir.dot(side) * 2.0 + cv.distanceTo(targetPos) / Math.max(standRange, 1.0);
            if (!inSwingReach(cv, targetPos, reach, ranged)) {
                score -= 1000.0; // any stand that can swing beats every stand that cannot
            }
            if (score > bestScore) {
                bestScore = score;
                best = cv;
            }
        }
        // Nothing standable on the whole ring: the preferred bearing's own cell if the column search
        // found one (standable, merely out of swing reach), else the old geometric anchor — and the
        // navigation's own honesty (no path / stopped short) carries the verdict, never a silent
        // wall-press.
        if (best != null) {
            return best;
        }
        return snapped != null ? snapped : geometric;
    }

    /** F5: the archer's stand — a {@link Vantage} candidate with line of sight, preferring
     *  elevated cells (dy ≥ +2) near the weapon's distance, then the shortest walk. Null when no
     *  candidate exists (flat sealed arena) — the caller falls back to the melee ring. */
    private static @Nullable Vec3 vantageAnchor(final net.minecraft.server.level.ServerLevel level,
                                                final LivingEntity body, final LivingEntity target,
                                                final double standRange) {
        java.util.List<net.minecraft.core.BlockPos> cands = Vantage.candidates(level, body,
            target.getEyePosition(), (int) Math.ceil(standRange) + 2);
        net.minecraft.core.BlockPos best = null;
        double bestScore = Double.MAX_VALUE;
        for (net.minecraft.core.BlockPos c : cands) {
            double distT = Math.hypot(c.getX() + 0.5 - target.position().x,
                c.getZ() + 0.5 - target.position().z);
            if (distT < 2.0) {
                continue; // an archer does not stand under the enemy's nose
            }
            double dy = c.getY() - target.position().y;
            double score = (dy >= 2 ? 0.0 : 100.0)                       // elevation first
                + Math.abs(distT - standRange) * 3.0                     // the weapon's distance
                + body.position().distanceTo(Vec3.atBottomCenterOf(c)) * 0.5; // shortest walk
            if (score < bestScore) {
                bestScore = score;
                best = c;
            }
        }
        return best == null ? null : Vec3.atBottomCenterOf(best);
    }

    /** Stop engagement without an event (a body change or teardown). The sprint clear goes to the
     *  body that was set sprinting, which on a body change is exactly NOT the current one. */
    static void clear(final DroneTools.Slot slot) {
        slot.combatHoldsBody = false;
        sprintOff(slot);
    }

    static @Nullable JsonObject describe(final DroneTools.Slot slot) {
        if (!slot.engaged && slot.threats.isEmpty()) {
            return null;
        }
        JsonObject o = new JsonObject();
        o.addProperty("engaged", slot.engaged);
        o.addProperty("mode", slot.combatMode);
        o.addProperty("policy", slot.combatPolicy);
        // F4: report the range that will actually be USED — weapon-derived, explicit clamped in.
        LivingEntity body = slot.activeBody();
        double range = body == null ? slot.combatRange : standRange(slot, holdsRangedWeapon(body));
        o.addProperty("range", range);
        // ...and SAY when that is not the range the caller asked for. bot_status echoing a quietly
        // different number is how the audited kite-at-6 read as honoured all the way to the death:
        // the reply's clamp note is a one-time message, this is the standing one.
        if (slot.combatRangeExplicit && Math.abs(range - slot.combatRange) > 1.0e-6) {
            o.addProperty("range_requested", slot.combatRange);
            o.addProperty("range_clamped", true);
        }
        o.addProperty("holds_body", slot.combatHoldsBody);
        if (!slot.threats.isEmpty()) {
            o.add("designated", slot.threats.describe());
        }
        if (!slot.engaged && !slot.threats.isEmpty()) {
            o.addProperty("note", "targets are designated but combat is OFF — nothing will act on "
                + "them; bot_body engage:true to arm");
        }
        return o;
    }
}
