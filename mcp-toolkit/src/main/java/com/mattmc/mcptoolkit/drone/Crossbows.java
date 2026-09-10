package com.mattmc.mcptoolkit.drone;

import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.EventLog;
import net.minecraft.world.Container;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.item.CrossbowItem;
import net.minecraft.world.item.ItemStack;
import org.jspecify.annotations.Nullable;

/**
 * <b>The crossbow is loaded BEFORE it is needed</b> — COMBAT_KIT_PLAN.md §4.3, step 5.
 *
 * <p><b>Why this is a behaviour and not a detail.</b> A bow's draw is spent at the moment of the
 * shot and there is nothing to be done about it. A crossbow's is not: {@code onUseTick} writes
 * {@code CHARGED_PROJECTILES} once the hold passes {@code getChargeDuration} (25 ticks nominal,
 * quick-charge aware), the component <b>persists on the stack</b>, and vanilla will happily carry it
 * loaded forever. So the 25 ticks can be paid out of time the body was spending anyway — walking to
 * a vantage, turning toward the enemy, waiting out a shot rhythm — and the shot itself then costs
 * nothing. That is the same insight as arming during the turn in 0.71.0: the cost does not go away,
 * it moves to where nobody is waiting on it.
 *
 * <p><b>A FOURTH SIBLING, and the plan predicted the wrong shape twice before this.</b> §4.4 folded
 * the crossbow into {@link PlayerVerbs.UseHold}, and for the SHOT that is right — a caller who asked
 * for a bolt wants aim, hold, release, projectile. A pre-load wants none of them. It has no target,
 * so nothing to aim at and nothing to lose when the target dies; it produces no projectile; and it
 * does not end when we let go, it ends when the ITEM says it is charged. Riding {@code UseHold}
 * would have meant a target-shaped class with the target, the aim, the release verdict and the
 * flight watch all nulled — which is exactly the mistake §12.1 records the shield teaching. What
 * {@link PlayerVerbs.Chew}, {@link PlayerVerbs.UseHold}, {@link Shields.Guard} and this share is
 * vanilla's use ticks, and nothing else.
 *
 * <p><b>One hand, and vanilla enforces it.</b> {@code LivingEntity.useItem} is a single in-flight use
 * per entity, so a load, a draw, a meal and a raised shield are mutually exclusive by construction.
 * Each of the four cancels the others EXPLICITLY and says which — a load preempted by a shot reports
 * {@code preempted_by_shot} rather than dying of {@code interrupted} from an author it cannot name.
 * The wind-up is lost when that happens, and losing it is correct: the shot re-winds as part of its
 * own draw, and a speculative charge must never delay a bolt somebody actually asked for.
 */
final class Crossbows {

    private Crossbows() {}

    /**
     * Ticks of slack over the weapon's own {@code getChargeDuration} before a load is abandoned.
     * The charge lands inside {@code onUseTick} on the tick the percentage crosses 1.0, so the
     * budget is the nominal duration plus room for the tick the crossing is observed on — not a
     * tuning knob, and a load that overruns it means something is wrong rather than slow.
     */
    static final int LOAD_SLACK_TICKS = 10;

    /** One crossbow being wound. Held per slot ({@link DroneTools.Slot#load}) and serviced by
     *  {@link #tick} unconditionally, for {@link Shields.Guard}'s reason: winding drives no legs, so
     *  a reflex or a fight owning the body must not be able to freeze its clock. */
    static final class Load {
        final LivingEntity body;
        final String itemId;
        /** {@code CrossbowItem.getChargeDuration} for THIS stack and THIS body — quick-charge aware,
         *  so an enchanted crossbow is not held to the unenchanted schedule. */
        final int chargeTicks;
        final String why;
        int held;
        int ticksLeft;

        Load(final LivingEntity body, final String itemId, final int chargeTicks, final String why) {
            this.body = body;
            this.itemId = itemId;
            this.chargeTicks = chargeTicks;
            this.why = why;
            this.ticksLeft = chargeTicks + LOAD_SLACK_TICKS;
        }
    }

    // ---- the deliberate load -------------------------------------------------

    /**
     * Start winding a carried crossbow. The body arms itself for it, like every other act in this
     * workstream: the crossbow comes out of the pack and into the hand through the same
     * {@code selectIntoHand} seam a swing or a shot uses, so the hotbar press is recorded as the
     * choice it is.
     *
     * @return a verdict, ok or refused. {@code no_weapon} = no crossbow carried at all (a BOW is not
     *     one — it cannot be pre-loaded, and saying so is the difference between a fixable problem
     *     and a puzzling one); {@code item_missing} = carried but nothing to feed it;
     *     {@code already_charged} = the work is already done; {@code busy} = another use owns the
     *     hand.
     */
    static JsonObject load(final DroneTools.Slot slot, final String why) {
        JsonObject r = new JsonObject();
        LivingEntity body = slot.activeBody();
        if (body == null) {
            return DroneHands.fail(r, "no_body");
        }
        Hands hands = handsOrNull(slot);
        // PLAYER BODIES ONLY, like every other automatic arming decision here (the dig gate,
        // WeaponGate, CombatKit.equip, Engage.loose). The drone's shot is a launched arrow rather
        // than a use-hold, so there is no wind-up for it to pay early.
        if (hands == null || hands.handsPlayer() == null) {
            r.addProperty("note", "only a player body winds a crossbow — the drone's shot is a "
                + "launched arrow, not a use-hold, so it has no charge to pay in advance");
            return DroneHands.fail(r, "not_supported");
        }
        if (slot.load != null) {
            r.addProperty("note", "the body is already winding " + slot.load.itemId
                + " — it finishes within ~" + slot.load.ticksLeft + " ticks");
            return DroneHands.fail(r, "busy");
        }
        // ONE HAND (see the class note). A load is the LOWEST-priority of the four uses: it is
        // speculative work, and it must never take the hand from a shot, a meal or a raised shield.
        if (slot.use != null) {
            r.addProperty("note", "the body is drawing " + slot.use.weaponId
                + " — the same hand winds the crossbow");
            return DroneHands.fail(r, "busy");
        }
        if (slot.chew != null) {
            r.addProperty("note", "the body is " + (slot.chew.drink ? "drinking" : "eating") + " "
                + slot.chew.itemId + " — the same hand winds the crossbow");
            return DroneHands.fail(r, "busy");
        }
        if (slot.guard != null) {
            r.addProperty("note", "the shield is up — vanilla holds ONE use at a time, so winding "
                + "would lower it. Lower the guard first if the crossbow matters more");
            return DroneHands.fail(r, "busy");
        }

        int charged = chargedSlot(hands);
        if (charged >= 0) {
            r.addProperty("note", "the "
                + DroneHands.itemId(hands.container().getItem(charged).getItem())
                + " is already loaded — it stays loaded until it is fired");
            return DroneHands.fail(r, "already_charged");
        }
        int idx = unchargedSlot(hands);
        if (idx < 0) {
            boolean carried = carriesCrossbow(hands);
            r.addProperty("note", carried
                ? "the crossbow carried has nothing to fire — it needs arrows (or a firework rocket)"
                : "no crossbow carried. A BOW cannot be pre-loaded: its draw is spent at the moment "
                    + "of the shot, which is what bot_shoot already does");
            return DroneHands.fail(r, carried ? "item_missing" : "no_weapon");
        }

        String armed = WeaponGate.armSlot(hands, idx);
        ItemStack weapon = hands.selectedStack();
        if (!(weapon.getItem() instanceof CrossbowItem)) {
            // The stack moved between the scan and the arming. Nothing happened; say so plainly
            // rather than starting a use on whatever is in the hand now.
            return DroneHands.fail(r, "item_missing");
        }
        int charge = CrossbowItem.getChargeDuration(weapon, body);
        weapon.use(body.level(), hands.handsPlayer(), InteractionHand.MAIN_HAND);
        if (!body.isUsingItem()) {
            r.addProperty("note", "the crossbow would not start winding — it may be on cooldown, "
                + "or the ammunition vanished between the check and the press");
            return DroneHands.fail(r, "use_refused");
        }
        Load l = new Load(body, DroneHands.itemId(weapon.getItem()), charge, why);
        slot.load = l;

        r.addProperty("ok", true);
        r.addProperty("loading", l.itemId);
        r.addProperty("charge_ticks", charge);
        if (armed != null) {
            r.addProperty("weapon_switched", armed);
        }
        r.addProperty("why", why);
        r.addProperty("note", "winding for " + charge + " ticks. It then stays LOADED until fired — "
            + "carry it that way and the next bot_shoot leaves the weapon instantly (draw_ticks 0). "
            + "bot_status reports crossbow_charged; crossbow_loaded says when it is done");
        return r;
    }

    /**
     * The automatic half — <b>pay the wind-up out of time the body is spending anyway</b>
     * (§4.3). Called from the two places a ranged fight has such time: between the shots of a
     * fight-mode engagement (which is also when it is walking to its station or its vantage) and
     * between the shots of a hunt that has switched to shooting.
     *
     * <p>Deliberately silent about its refusals. Every reason to decline here — a bow is the better
     * weapon, the hand is busy, no crossbow carried, already loaded — is an ordinary state of an
     * ordinary fight, and an event stream that narrated each one every tick would bury the events
     * that matter. The one thing worth hearing is that it SUCCEEDED, which {@code crossbow_loaded}
     * says once.
     *
     * @return true when a wind-up was started
     */
    static boolean preload(final DroneTools.Slot slot, final LivingEntity body) {
        if (slot.load != null || slot.use != null || slot.chew != null || slot.guard != null
                || !(body instanceof FakePlayerEntity)) {
            return false;
        }
        Hands hands = handsOrNull(slot);
        if (hands == null || unchargedSlot(hands) < 0) {
            return false;
        }
        // A FED BOW BEATS AN UNLOADED CROSSBOW, and pre-loading must not quietly change which
        // weapon the fight is using. CombatKit.rangedSlot is the one owner of that ranking: it
        // prefers an already-charged crossbow (no draw at all) and otherwise the first weapon the
        // pack can feed. If that answer is not this crossbow, the body is fighting with something
        // else and taking the hand away from it to wind a spare is a downgrade, not a preparation.
        int ranged = CombatKit.rangedSlot(hands);
        if (ranged != unchargedSlot(hands)) {
            return false;
        }
        JsonObject r = load(slot, "wound between shots, so the next one costs no draw");
        return r.has("ok") && r.get("ok").getAsBoolean();
    }

    // ---- the watch -----------------------------------------------------------

    /**
     * Advance the wind-up. Serviced unconditionally from {@code tickWatch}, like the draw, the chew
     * and the raise — a load drives no legs, so whoever owns the body must not be able to strand one
     * mid-wind.
     *
     * <p>Completion is asked of the ITEM ({@code CrossbowItem.isCharged}), never counted off a
     * clock of ours: {@code getChargeDuration} is quick-charge aware and {@code onUseTick} is what
     * actually writes the component, so the stack is the only witness that cannot be wrong.
     */
    static void tick(final DroneTools.Slot slot) {
        Load l = slot.load;
        if (l == null) {
            return;
        }
        if (l.body.isRemoved() || !l.body.isAlive()) {
            slot.load = null;
            return;
        }
        ItemStack held = l.body.getMainHandItem();
        if (CrossbowItem.isCharged(held)) {
            done(slot, l, held);
            return;
        }
        // SOMETHING ELSE TOOK THE HAND. One use per entity, so a shot, a meal or a raised shield
        // all end the wind — and each of those cancels this explicitly and names itself, so an
        // `interrupted` here means something we do not model reached in.
        if (!l.body.isUsingItem() || !(held.getItem() instanceof CrossbowItem)) {
            cancel(slot, "interrupted");
            return;
        }
        l.held++;
        if (--l.ticksLeft <= 0) {
            cancel(slot, "timed_out");
        }
    }

    /** Stop winding. Silent when nothing is, so every teardown path may call it. */
    static void cancel(final DroneTools.Slot slot, final String reason) {
        Load l = slot.load;
        if (l == null) {
            return;
        }
        slot.load = null;
        if (!l.body.isRemoved() && l.body.isUsingItem()
                && l.body.getUseItem().getItem() instanceof CrossbowItem) {
            l.body.stopUsingItem();
        }
        JsonObject d = new JsonObject();
        d.addProperty("item", l.itemId);
        d.addProperty("reason", reason);
        d.addProperty("held_ticks", l.held);
        d.addProperty("charge_ticks", l.chargeTicks);
        EventLog.emit("crossbow_load_failed", d, slot.target());
    }

    /** The wind finished: the component is on the stack, so let the hand go and say so once. */
    private static void done(final DroneTools.Slot slot, final Load l, final ItemStack weapon) {
        slot.load = null;
        // stopUsingItem, NOT releaseUsingItem. The charge is already written to the stack by
        // onUseTick; releasing would run CrossbowItem.releaseUsing for no reason, and the two are
        // easy to confuse because for a BOW the release is the whole event.
        if (l.body.isUsingItem()) {
            l.body.stopUsingItem();
        }
        JsonObject d = new JsonObject();
        d.addProperty("item", l.itemId);
        d.addProperty("held_ticks", l.held);
        d.addProperty("charge_ticks", l.chargeTicks);
        d.addProperty("why", l.why);
        EventLog.emit("crossbow_loaded", d, slot.target());
    }

    // ---- what the body can see about its own crossbow -------------------------

    /**
     * Report the crossbow on {@code bot_status} — COMBAT_KIT_PLAN.md §4.6's last unbuilt status key.
     *
     * <p>Unlike {@code drawing} and {@code blocking}, {@code crossbow_charged} is reported as
     * {@code false} too, and the asymmetry is deliberate: those two report a MOMENT (the bow is bent
     * right now), where their mere presence is the fact. A crossbow's charge is a STANDING property
     * of a carried item, and "loaded" and "not loaded" are equally worth knowing to a body deciding
     * whether it has a free shot. Present only when a crossbow is actually carried, so it still
     * costs nothing in the ordinary read.
     */
    static void status(final DroneTools.Slot slot, final LivingEntity body, final JsonObject r) {
        Hands hands = handsOrNull(slot);
        if (hands == null || !carriesCrossbow(hands)) {
            return;
        }
        r.addProperty("crossbow_charged", chargedSlot(hands) >= 0);
        Load l = slot.load;
        if (l != null && l.body == body) {
            r.addProperty("loading", l.itemId);
            r.addProperty("load_ready_in", Math.max(1, l.chargeTicks - l.held));
        }
    }

    // ---- detectors -----------------------------------------------------------

    /** Is a crossbow carried at all — loaded, empty, feedable or not? */
    static boolean carriesCrossbow(final @Nullable Hands hands) {
        return crossbowSlot(hands, false, false) >= 0;
    }

    /** A pack slot holding a LOADED crossbow, or -1. Its bolt is free: no draw, no ammunition. */
    static int chargedSlot(final @Nullable Hands hands) {
        return crossbowSlot(hands, true, false);
    }

    /** A pack slot holding an unloaded crossbow this pack can FEED, or -1 — the wind-up candidate.
     *  Asked through the weapon's own projectile predicate ({@link CombatKit#hasAmmo}), so a modded
     *  bolt counts without a list here. */
    static int unchargedSlot(final @Nullable Hands hands) {
        return crossbowSlot(hands, false, true);
    }

    private static int crossbowSlot(final @Nullable Hands hands, final boolean mustBeCharged,
                                    final boolean mustBeFeedable) {
        if (hands == null) {
            return -1;
        }
        Container inv = hands.container();
        for (int i = 0; i < inv.getContainerSize(); i++) {
            ItemStack s = inv.getItem(i);
            if (!(s.getItem() instanceof CrossbowItem)) {
                continue;
            }
            boolean charged = CrossbowItem.isCharged(s);
            if (mustBeCharged && !charged) {
                continue;
            }
            if (mustBeFeedable && (charged || !CombatKit.hasAmmo(hands, s))) {
                continue;
            }
            return i;
        }
        return -1;
    }

    private static @Nullable Hands handsOrNull(final DroneTools.Slot slot) {
        try {
            return Actuator.require(slot).hands();
        } catch (RuntimeException e) {
            return null; // a possessed mob has no hands, and no pack to wind a crossbow out of
        }
    }
}
