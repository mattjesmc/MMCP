package com.mattmc.mcptoolkit.drone;

import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.EventLog;
import java.util.Iterator;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.projectile.arrow.ThrownTrident;
import org.jspecify.annotations.Nullable;

/**
 * <b>Did the arrow land?</b> A shot is two facts with two lifetimes: the body loosed it (that is
 * the act, and it completes at release), and it hit or it did not (that is a fact about a
 * projectile still in the air, arriving up to five seconds later).
 *
 * <p><b>Why they are not one event.</b> COMBAT_KIT_PLAN.md §4.6 asks for {@code hit} on the ranged
 * completion, and holding the act open through the flight would deliver it — at the cost of halving
 * the body's rate of fire, since {@code bot_shoot} answers {@code busy} while a draw is in flight
 * and the hunt looses on a 20-tick rhythm. A bow's rate of fire IS the weapon. So the act completes
 * when the body has done its part, and the landing arrives as {@code shot_landed} — the same shape
 * every other "the world answered later" fact in this stream has.
 *
 * <p><b>What "hit" means here, exactly.</b> The arrow is watched until it stops: vanilla discards an
 * arrow that strikes an entity (no piercing) and parks one that strikes a block with its motion
 * zeroed. So a vanished arrow whose TARGET lost health in the same window hit; a stopped-but-present
 * arrow is stuck in terrain and missed. That inference is named in the event ({@code damage} is the
 * health delta it rests on) rather than dressed up as ground truth, because vanilla exposes no
 * "who did this arrow hit" and a confident wrong answer here would be worse than a stated one.
 *
 * <p>Body-agnostic on purpose: the drone's own shot rides this too, so both bodies report a landing
 * the same way even though only the player draws for real.
 */
final class Shots {
    private Shots() {}

    /** How long an arrow may stay in the air before the watch gives up ({@code lost}). Five
     *  seconds: a full-draw arrow crosses its useful range in well under two. */
    static final int FLIGHT_TIMEOUT_TICKS = 100;

    /**
     * How long a THROWN WEAPON may be watched. Longer than an arrow's, because a Loyalty trident's
     * whole life is out and back — and the return leg accelerates from a standstill, so it takes
     * substantially longer than the throw did. A trident that has not come home in ten seconds is
     * not coming home, and where it lies is then the fact worth reporting.
     */
    static final int THROW_TIMEOUT_TICKS = 200;

    /** Consecutive motionless ticks before a thrown weapon is called settled. Two, not one: a
     *  single tick of stillness happens at the apex of a bounce. */
    static final int SETTLED_TICKS = 2;

    /** One arrow in the air, and the health its target had when it left the bow. */
    static final class Flight {
        final int arrowId;
        final int targetId;
        final String actionId;
        final String weaponId;
        final float targetHealth;
        /** A THROWN WEAPON, not ammunition: the projectile IS the item, so where it stops is a
         *  place the body may want to walk to (COMBAT_KIT_PLAN.md D2). */
        final boolean thrownWeapon;
        /** Loyalty's return acceleration, read off the stack at launch. Above zero the trident flies
         *  home by itself and there is nothing to fetch. */
        final boolean loyal;
        /** Consecutive ticks a thrown weapon has not moved at all. See the settling note in
         *  {@link #tick}: a deflected trident is slow long before it is stopped. */
        int stillTicks;
        int ticks;
        int ticksLeft;

        Flight(final int arrowId, final int targetId, final String actionId, final String weaponId,
               final float targetHealth, final boolean thrownWeapon, final boolean loyal) {
            this.arrowId = arrowId;
            this.targetId = targetId;
            this.actionId = actionId;
            this.weaponId = weaponId;
            this.targetHealth = targetHealth;
            this.thrownWeapon = thrownWeapon;
            this.loyal = loyal;
            this.ticksLeft = thrownWeapon ? THROW_TIMEOUT_TICKS : FLIGHT_TIMEOUT_TICKS;
        }
    }

    /** Start watching a projectile this body just launched. */
    static void track(final DroneTools.Slot slot, final Entity arrow, final Entity target,
                      final String actionId, final String weaponId) {
        boolean trident = arrow instanceof ThrownTrident;
        slot.flights.add(new Flight(arrow.getId(), target.getId(), actionId, weaponId,
            target instanceof LivingEntity le ? le.getHealth() : -1,
            trident, trident && loyalty((ThrownTrident) arrow) > 0));
    }

    /**
     * Does this trident come home? Asked of the enchantment helper rather than the synched byte,
     * because {@code ID_LOYALTY} is set from the stack at construction and reading the enchantment
     * back off the pickup stack is the same number from the side that cannot be stale.
     */
    private static int loyalty(final ThrownTrident t) {
        return t.level() instanceof ServerLevel level
            ? net.minecraft.world.item.enchantment.EnchantmentHelper
                .getTridentReturnToOwnerAcceleration(level, t.getWeaponItem(), t) : 0;
    }

    /**
     * Advance every in-flight arrow one tick. Serviced unconditionally from tickWatch, like the
     * swing clock and the chew: an arrow does not care who owns the body it left.
     */
    static void tick(final DroneTools.Slot slot) {
        if (slot.flights.isEmpty()) {
            return;
        }
        LivingEntity body = slot.activeBody();
        if (body == null) {
            slot.flights.clear(); // no body, no session view to report into
            return;
        }
        ServerLevel level = (ServerLevel) body.level();
        Iterator<Flight> it = slot.flights.iterator();
        while (it.hasNext()) {
            Flight f = it.next();
            f.ticks++;
            Entity arrow = level.getEntity(f.arrowId);
            Entity target = level.getEntity(f.targetId);
            if (arrow == null || arrow.isRemoved()) {
                // Gone: struck something. The target's health delta says whether it was the target.
                land(slot, f, target, target == null);
                if (f.thrownWeapon) {
                    // A THROWN WEAPON THAT VANISHES CAME HOME. Loyalty flies it back to the owner
                    // and vanilla's own tryPickup puts it in the inventory on touch, which discards
                    // the entity — so for a trident, "the projectile is gone" is the good ending
                    // rather than a hit, and the two must not read alike.
                    returned(slot, f);
                }
                it.remove();
                continue;
            }
            if (f.thrownWeapon) {
                // A trident is watched to a STANDSTILL, not to a slow tick. AbstractArrow parks an
                // arrow with its motion zeroed, but ThrownTrident.onHitEntity DEFLECTS — it keeps a
                // fraction of the motion (×0.02, ×0.2, ×0.02) — so the arrow test fires while the
                // weapon is still in the air above the target it just hit, and the coordinates that
                // reach the agent are a place the trident is not. Two consecutive ticks of not
                // having moved at all is the honest reading of "it has come to rest".
                //
                // And a LOYAL trident is never landed here: it sits in the ground for four ticks
                // before ThrownTrident.tick turns for home, which looks exactly like coming to rest.
                // If it truly never returns, the timeout below reports where it lies.
                if (!f.loyal && arrow.getDeltaMovement().lengthSqr() < 1.0e-6) {
                    f.stillTicks++;
                } else {
                    f.stillTicks = 0;
                }
                // ONE terminal decision per tick, not two. Written as two independent `if`s first,
                // which is a double `Iterator.remove()` — an IllegalStateException plus a duplicated
                // trident_landed — on the one tick a weapon settles as its watch expires. Rare, and
                // rare inside a watch that only runs after a throw is exactly how a defect reaches a
                // survival run instead of a probe.
                boolean settled = f.stillTicks >= SETTLED_TICKS;
                if (settled || --f.ticksLeft <= 0) {
                    land(slot, f, target, false);
                    rest(slot, f, arrow);
                    it.remove();
                }
                continue;
            }
            if (arrow.getDeltaMovement().lengthSqr() < 1.0e-4) {
                land(slot, f, target, false); // parked in terrain
                it.remove();
            } else if (--f.ticksLeft <= 0) {
                land(slot, f, target, false);
                it.remove();
            }
        }
    }

    private static void land(final DroneTools.Slot slot, final Flight f,
                             final @Nullable Entity target, final boolean targetGone) {
        float now = target instanceof LivingEntity le ? le.getHealth() : -1;
        double damage = f.targetHealth >= 0 && now >= 0 ? Math.max(0, f.targetHealth - now) : 0;
        boolean hit = targetGone || damage > 0;
        JsonObject d = new JsonObject();
        d.addProperty("action_id", f.actionId);
        d.addProperty("arrow_id", f.arrowId);
        d.addProperty("target_id", f.targetId);
        d.addProperty("weapon", f.weaponId);
        d.addProperty("hit", hit);
        d.addProperty("flight_ticks", f.ticks);
        if (damage > 0) {
            d.addProperty("damage", Math.round(damage * 100.0) / 100.0);
        }
        if (targetGone) {
            // The target left the world while our arrow was in the air. Almost always the kill;
            // occasionally a despawn. Say which fact is doing the work rather than asserting a hit.
            d.addProperty("target_gone", true);
        }
        if (f.ticksLeft <= 0) {
            d.addProperty("lost", true); // never seen to stop — out over a cliff, or unloaded
        }
        EventLog.emit("shot_landed", d, slot.target());
    }

    /**
     * <b>The thrown weapon is lying at x, y, z</b> — D2's answer, and the reason a throw is allowed
     * at all. A trident that leaves the hand and is never mentioned again is an item the body lost;
     * one whose resting place is named is an item the body left somewhere, which is a completely
     * different thing to an agent making decisions.
     *
     * <p>{@link Retrieve} takes it from here and schedules the walk back. Both events fire — the
     * coordinates are worth having even when the errand is also on the books, because the errand can
     * be preempted indefinitely by a body that never gets a quiet moment.
     */
    private static void rest(final DroneTools.Slot slot, final Flight f, final Entity item) {
        JsonObject d = new JsonObject();
        d.addProperty("action_id", f.actionId);
        d.addProperty("item", f.weaponId);
        d.addProperty("entity_id", f.arrowId);
        d.addProperty("x", Math.round(item.getX() * 100.0) / 100.0);
        d.addProperty("y", Math.round(item.getY() * 100.0) / 100.0);
        d.addProperty("z", Math.round(item.getZ() * 100.0) / 100.0);
        d.addProperty("loyalty", f.loyal);
        if (f.loyal) {
            // It had Loyalty and did not come back within the watch. Worth saying plainly: the
            // enchantment is the reason a body would throw without a second thought, and an agent
            // that believes it still holds is about to make the same call again.
            d.addProperty("note", "it did NOT return despite Loyalty — it may be stuck out of "
                + "reach, or the body moved too far while it flew");
        }
        EventLog.emit("trident_landed", d, slot.target());
        Retrieve.schedule(slot, item, f.weaponId);
    }

    /** Loyalty brought it home and vanilla's {@code tryPickup} put it back in the pack. Nothing to
     *  fetch, and the body should hear that it still has its weapon. */
    private static void returned(final DroneTools.Slot slot, final Flight f) {
        JsonObject d = new JsonObject();
        d.addProperty("action_id", f.actionId);
        d.addProperty("item", f.weaponId);
        d.addProperty("loyalty", f.loyal);
        d.addProperty("flight_ticks", f.ticks);
        d.addProperty("note", f.loyal
            ? "Loyalty flew it back and the body caught it — it is carried again"
            : "the thrown weapon left the world without coming to rest (picked up by something "
                + "else, or despawned)");
        EventLog.emit(f.loyal ? "trident_returned" : "trident_lost", d, slot.target());
    }
}
