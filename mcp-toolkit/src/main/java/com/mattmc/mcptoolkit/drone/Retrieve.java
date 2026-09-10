package com.mattmc.mcptoolkit.drone;

import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.EventLog;
import java.util.Iterator;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.phys.Vec3;

/**
 * <b>Go back for it — later.</b> A weapon that left the hand and came to rest somewhere is not lost,
 * it is somewhere; this is the errand the body runs to make that true (COMBAT_KIT_PLAN.md D2).
 *
 * <p><b>Why "scheduled" and not "immediate" is the whole design.</b> The thing that makes a throw
 * worth allowing is that the trident comes back. The thing that would make it lethal is going to get
 * it NOW: the throw happens because a target was unreachable, which is the geometry with the best
 * odds of a second enemy that is not — so a body that turns and walks to a landing spot the instant
 * the trident stops moving is walking away from a fight, on a straight line, with its back turned.
 * So the errand waits for the body to have nothing else to do, and the bar for that is deliberately
 * high (see {@link #idle}): no goal, no queue, no fight, no reflex, no dig, no journey, no held use —
 * and then {@link #SETTLE_TICKS} of continuing to have nothing to do, so a lull inside a fight is
 * not mistaken for the end of one.
 *
 * <p><b>The pickup itself is free, and that is not a shortcut.</b> Vanilla's
 * {@code AbstractArrow.playerTouch} → {@code tryPickup} puts a landed trident into the inventory of
 * the player who walks over it, exactly as it does for a human. So the errand is a plain walk and
 * nothing else — no bespoke collect verb, no second way to acquire an item that could drift from
 * what a real client does. Walking is the pickup.
 *
 * <p><b>It never claims the body's bookkeeping.</b> The leg is issued straight on
 * {@link DroneTools#startNav}, the way reflex movement is, rather than as a {@link GoalRunner} goal:
 * a goal would occupy {@code slot.goal}, and the agent's next {@code bot_target} would then answer
 * {@code busy} because the body had privately decided to fetch a trident. Anything the agent asks
 * for simply takes the legs back, and the errand — which by then is no longer idle — stops asking.
 *
 * <p>Everything it does is announced: {@code pickup_scheduled} when the trident comes to rest,
 * {@code pickup_started} when the body sets off, {@code pickup_done} when the item is back in the
 * pack, {@code pickup_abandoned} with a reason when it is not. A body that quietly wanders is worse
 * than one that does not wander at all.
 */
final class Retrieve {

    private Retrieve() {}

    /** Ticks of UNINTERRUPTED idleness before the errand starts. Three seconds: long enough that a
     *  pause between two waves of a fight does not read as peace, short enough to feel prompt. */
    static final int SETTLE_TICKS = 60;

    /** How far the body will walk for a dropped weapon. Beyond this the walk is its own expedition
     *  with its own risks, and that is the agent's call to make, not a side effect of a throw. */
    static final double MAX_DISTANCE = 48.0;

    /** How long an errand stays on the books. {@code AbstractArrow} despawns after 1200 ticks, so a
     *  pending pickup outliving that is chasing something the world has already deleted. */
    static final int EXPIRY_TICKS = 1200;

    /** One thing lying on the ground that this body would like back. */
    static final class Pending {
        final int entityId;
        final String itemId;
        final Vec3 where;
        int expiresIn = EXPIRY_TICKS;
        /** Ticks of continuous idleness so far; reset by anything the body does instead. */
        int settled;
        /** The nav leg's action id once the errand is walking, else null. */
        String walking;

        Pending(final int entityId, final String itemId, final Vec3 where) {
            this.entityId = entityId;
            this.itemId = itemId;
            this.where = where;
        }
    }

    /**
     * Put a landed item on the books. Called by {@link Shots} when a thrown weapon comes to rest;
     * the {@code pickup_scheduled} event is the "or at least notify the agent" half of D2, and it
     * carries the coordinates because an agent that is told only "you lost your trident" has been
     * told nothing it can act on.
     */
    static void schedule(final DroneTools.Slot slot, final Entity item, final String itemId) {
        LivingEntity body = slot.activeBody();
        if (body == null) {
            return;
        }
        Vec3 at = item.position();
        JsonObject d = new JsonObject();
        d.addProperty("item", itemId);
        d.addProperty("entity_id", item.getId());
        d.addProperty("x", round(at.x));
        d.addProperty("y", round(at.y));
        d.addProperty("z", round(at.z));
        d.addProperty("distance", round(body.position().distanceTo(at)));
        if (body.position().distanceTo(at) > MAX_DISTANCE) {
            // Too far to fetch on the body's own initiative, and the coordinates are the whole
            // point: this is now the agent's errand, and it has what it needs to run it.
            d.addProperty("scheduled", false);
            d.addProperty("note", "too far for the body to fetch by itself (over " + (int) MAX_DISTANCE
                + " blocks) — walk there and over it to pick it up");
            EventLog.emit("pickup_scheduled", d, slot.target());
            return;
        }
        slot.pickups.add(new Pending(item.getId(), itemId, at));
        d.addProperty("scheduled", true);
        d.addProperty("note", "the body will walk back for it once it has nothing else to do — "
            + "walking over a landed trident IS the pickup (pickup_started / pickup_done say when)");
        EventLog.emit("pickup_scheduled", d, slot.target());
    }

    /**
     * Advance the errand list. Serviced from {@code tickWatch} like the other unconditional watches,
     * because the CLOCK must run even while something else owns the body — that is how an errand
     * expires honestly instead of waiting forever for an idleness that never comes.
     */
    static void tick(final DroneTools.Slot slot) {
        if (slot.pickups.isEmpty()) {
            return;
        }
        LivingEntity body = slot.activeBody();
        if (body == null) {
            slot.pickups.clear(); // no body, nobody to fetch anything
            return;
        }
        ServerLevel level = (ServerLevel) body.level();
        boolean free = idle(slot, body);
        boolean walkingAlready = false;
        Iterator<Pending> it = slot.pickups.iterator();
        while (it.hasNext()) {
            Pending p = it.next();
            Entity item = level.getEntity(p.entityId);
            if (item == null || item.isRemoved()) {
                // Gone: picked up (by us, walking over it) or despawned. Which one is answerable —
                // the pack either holds it or it does not — and answering is the difference between
                // an errand that reports and one that merely stops.
                finish(slot, p, holds(slot, p.itemId));
                it.remove();
                continue;
            }
            if (--p.expiresIn <= 0) {
                abandon(slot, p, "expired");
                it.remove();
                continue;
            }
            if (p.walking != null) {
                // AN ERRAND IN FLIGHT YIELDS TO EVERYTHING. The leg belongs to no goal, so anything
                // the agent (or a reflex, or a fight) starts simply takes the legs — and when it
                // does, this stops asking rather than re-issuing into the contest. It goes back on
                // the books and waits for the next lull.
                if (!free) {
                    p.walking = null;
                    p.settled = 0;
                }
                walkingAlready = true;
                continue;
            }
            if (!free) {
                p.settled = 0;
                continue;
            }
            if (++p.settled < SETTLE_TICKS || walkingAlready) {
                continue;
            }
            walkingAlready = start(slot, p, item);
        }
    }

    /** Drop every errand — the body died, was replaced, or the session let it go. */
    static void clear(final DroneTools.Slot slot) {
        slot.pickups.clear();
    }

    // ---- the errand ----------------------------------------------------------

    /** Set off. Returns true when a leg is actually walking. */
    private static boolean start(final DroneTools.Slot slot, final Pending p, final Entity item) {
        JsonObject args = new JsonObject();
        JsonObject to = new JsonObject();
        Vec3 at = item.position();
        to.addProperty("x", at.x);
        to.addProperty("y", at.y);
        to.addProperty("z", at.z);
        args.add("to", to);
        // Walk ONTO it, not near it: playerTouch is the pickup, and it needs the bounding boxes to
        // overlap. `within` is the arrival tolerance, so this is as tight as the navigator will
        // honour without the arrival oscillating on hover drift.
        args.addProperty("within", 1.0);
        JsonObject r = DroneTools.startNav(args, slot, null);
        if (!r.has("started") || !r.get("started").getAsBoolean()) {
            // Not a failure worth abandoning over — the terrain may be busy, the body may have just
            // been handed something else. The errand keeps its place and tries again after another
            // settling period.
            p.settled = 0;
            return false;
        }
        p.walking = r.get("action_id").getAsString();
        JsonObject d = new JsonObject();
        d.addProperty("item", p.itemId);
        d.addProperty("entity_id", p.entityId);
        d.addProperty("x", round(at.x));
        d.addProperty("y", round(at.y));
        d.addProperty("z", round(at.z));
        d.addProperty("note", "walking back for it — the body had nothing else to do for "
            + SETTLE_TICKS + " ticks");
        EventLog.emit("pickup_started", d, slot.target());
        return true;
    }

    private static void finish(final DroneTools.Slot slot, final Pending p, final boolean got) {
        if (!got) {
            abandon(slot, p, "vanished");
            return;
        }
        JsonObject d = new JsonObject();
        d.addProperty("item", p.itemId);
        EventLog.emit("pickup_done", d, slot.target());
    }

    private static void abandon(final DroneTools.Slot slot, final Pending p, final String reason) {
        JsonObject d = new JsonObject();
        d.addProperty("item", p.itemId);
        d.addProperty("entity_id", p.entityId);
        d.addProperty("reason", reason);
        d.addProperty("x", round(p.where.x));
        d.addProperty("y", round(p.where.y));
        d.addProperty("z", round(p.where.z));
        EventLog.emit("pickup_abandoned", d, slot.target());
    }

    // ---- "nothing else to do", spelled out -----------------------------------

    /**
     * Is this body genuinely free? Every in-flight thing the slot models is listed, and the list is
     * deliberately exhaustive rather than clever: the failure mode of getting this wrong is a body
     * that wanders off mid-fight, which is both the worst outcome available here and one that would
     * be read as a combat regression rather than as an errand.
     *
     * <p>The one item that is NOT a disqualifier is a walking leg this errand itself issued — that
     * is checked by the caller, which knows whose leg it is.
     */
    private static boolean idle(final DroneTools.Slot slot, final LivingEntity body) {
        return slot.goal == null && slot.queue == null && slot.follow == null
            && slot.pendingNav == null && slot.active == null && !slot.combatHoldsBody
            && slot.dig == null && slot.use == null && slot.chew == null && slot.guard == null
            && slot.load == null && slot.swing == null && slot.possession == null
            && slot.threats.pick((ServerLevel) body.level(), body) == null;
    }

    /** Does the pack hold one of these now? The question that turns "the entity is gone" into
     *  "the body has it back" — and it is asked of the inventory, never assumed from the walk. */
    private static boolean holds(final DroneTools.Slot slot, final String itemId) {
        Hands hands;
        try {
            hands = Actuator.require(slot).hands();
        } catch (RuntimeException e) {
            return false;
        }
        var inv = hands.container();
        for (int i = 0; i < inv.getContainerSize(); i++) {
            if (itemId.equals(DroneHands.itemId(inv.getItem(i).getItem()))) {
                return true;
            }
        }
        return false;
    }

    private static double round(final double d) {
        return Math.round(d * 100.0) / 100.0;
    }
}
