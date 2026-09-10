package com.mattmc.mcptoolkit.drone;

import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.EventLog;
import net.minecraft.core.component.DataComponents;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.damagesource.DamageSource;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.component.BlocksAttacks;
import org.jspecify.annotations.Nullable;

/**
 * <b>The raised shield</b> — COMBAT_KIT_PLAN.md §4.4/§4.6, step 4. Three facts live here, and they
 * are one story: getting the shield UP (with the arm it belongs to), knowing when it actually
 * PROTECTS, and saying what it ATE.
 *
 * <p><b>The defect this closes.</b> The {@code shield} reflex op has existed since 0.14.0 and has
 * never once blocked anything, because nothing ever filled the offhand: it refused with <i>"no
 * shield in the offhand (bot_equip {offhand:…})"</i> and no path called {@code bot_equip}. 0.72.0
 * gave the body an offhand policy ({@link CombatKit#wantOffhand}); this hands the op that policy and
 * makes the raise a real, reported, accountable act.
 *
 * <p><b>The sharp edge, verified in 26.2 source and not guessed.</b> {@code Items.SHIELD} carries
 * {@code BlocksAttacks(blockDelaySeconds=0.25, …)}, and
 * {@code LivingEntity.getItemBlockingWith()} returns null until {@code elapsedTicks >=
 * blockDelayTicks()}. <b>A shield raised as the arrow arrives blocks nothing.</b> That is why the
 * plan binds the reflex to {@code projectile_incoming} rather than to damage — by the time damage
 * has landed the five ticks are unaffordable — and why {@link #status} reports
 * {@code block_ready_in}: a raised-but-not-yet-live shield is a state the agent must be able to see,
 * because it looks identical to a live one from every other angle.
 *
 * <p><b>ONE HAND, and vanilla is the one enforcing it.</b> {@code LivingEntity.useItem} is a single
 * in-flight use for the whole entity, not one per hand: {@code startUsingItem(OFF_HAND)} silently
 * replaces a bow draw and a bow draw silently replaces a raised shield. Before this, the two could
 * livelock — the reflex re-raised the shield every tick it found the hand empty while
 * {@link PlayerVerbs.UseHold} re-armed the draw, and neither ever finished. So the seam is explicit
 * in both directions: a raise CANCELS an in-flight draw (a shield going up is an emergency and says
 * so), and a shot LOWERS the guard (lowering to shoot is a decision, not an accident).
 *
 * <p><b>What "blocked" is measured from.</b> Not a health delta — a fully blocked blow changes no
 * health at all, which is exactly the hit an agent most needs to hear about ("something is shooting
 * at you and the shield is holding"). The number comes from vanilla's own
 * {@code LivingEntity.applyItemBlocking}, which our body classes override to report what it
 * returned. {@link DroneTools} drains it in the same tick and stamps {@code blocked} /
 * {@code blocked_damage} onto {@code body_damaged}, emitting one at {@code damage: 0} when the
 * shield ate the blow whole.
 */
final class Shields {

    private Shields() {}

    /** Default hold for a raise that names no duration — three seconds, about one exchange. */
    static final int DEFAULT_TICKS = 60;
    /** Ceiling on a single hold. A shield up forever is a body that has stopped deciding; the
     *  caller re-raises, which is also when the offhand policy gets to re-run. */
    static final int MAX_TICKS = 600;

    // ---- what the body reports back from vanilla's own blocking maths --------

    /**
     * The blows this body's shield ate on ONE tick, accumulated. A scrum lands several in a tick and
     * three {@code body_damaged} events for one tick would be three fictions about the sequence;
     * one event carrying {@code blocked_hits: 3} is the fact.
     */
    static final class Hit {
        final long tick;
        int hits;
        float blocked;
        float incoming;
        String cause = "unknown";
        /** An axe (or anything with {@code getSecondsToDisableBlocking}) broke the guard open:
         *  vanilla put the shield on cooldown and lowered it. */
        boolean disabled;
        int disabledFor;

        Hit(final long tick) {
            this.tick = tick;
        }
    }

    /**
     * Implemented by the toolkit's own body classes so vanilla's blocking result can reach the
     * watch. An INTERFACE rather than a map keyed on entity id: the record is one field on the body
     * that owns it, so it cannot outlive the body, cannot leak, and cannot be read for the wrong
     * one.
     */
    interface Watcher {
        void mcptkRecordBlock(Hit hit);

        @Nullable Hit mcptkTakeBlock();
    }

    /**
     * Called from the body's {@code applyItemBlocking} override, AFTER vanilla has done the maths.
     * {@code blocking} is the stack captured BEFORE the super call, because an axe strike disables
     * the shield inside it ({@code Player.blockUsingItem} → {@code BlocksAttacks.disable}) and the
     * stack is no longer the one being blocked with by the time we look.
     */
    static void observe(final LivingEntity body, final DamageSource source, final float incoming,
                        final float blocked, final @Nullable ItemStack blocking) {
        if (blocked <= 0.0F || !(body instanceof Watcher w)) {
            return;
        }
        Hit hit = w.mcptkTakeBlock();
        long now = body.level().getGameTime();
        if (hit == null || hit.tick != now) {
            hit = new Hit(now);
        }
        hit.hits++;
        hit.blocked += blocked;
        hit.incoming += incoming;
        hit.cause = source.getMsgId();
        // THE SHIELD BROKE OPEN. Vanilla's disable adds an item cooldown and calls stopUsingItem, so
        // the guard is already down when we get here — the agent that keeps "holding" it would be
        // standing in the open believing otherwise.
        if (blocking != null && body instanceof ServerPlayer p
                && p.getCooldowns().isOnCooldown(blocking)) {
            hit.disabled = true;
            BlocksAttacks ba = blocking.get(DataComponents.BLOCKS_ATTACKS);
            hit.disabledFor = ba == null ? 0 : Math.round(
                source.getEntity() instanceof LivingEntity a
                    ? a.getSecondsToDisableBlocking() * ba.disableCooldownScale() * 20.0F : 0.0F);
        }
        w.mcptkRecordBlock(hit);
    }

    /** This tick's blocked blows for {@code body}, consumed. Null when the shield ate nothing. */
    private static @Nullable Hit take(final @Nullable LivingEntity body) {
        return body instanceof Watcher w ? w.mcptkTakeBlock() : null;
    }

    // ---- the guard: an intentional, ticked, accountable raise ----------------

    /** One raised shield. Held per slot ({@link DroneTools.Slot#guard}) and serviced by
     *  {@link #tick} unconditionally, for {@link PlayerVerbs.UseHold}'s reason: a raised shield
     *  drives no legs, so a reflex or a fight owning the body must not freeze its clock. */
    static final class Guard {
        final LivingEntity body;
        final String itemId;
        /** {@code BlocksAttacks.blockDelayTicks()} — how long after the raise it starts protecting. */
        final int blockDelay;
        final String why;
        int ticksLeft;
        int held;
        int hits;
        float blocked;

        Guard(final LivingEntity body, final String itemId, final int blockDelay, final int ticks,
              final String why) {
            this.body = body;
            this.itemId = itemId;
            this.blockDelay = blockDelay;
            this.ticksLeft = ticks;
            this.why = why;
        }

        /** Is it actually protecting yet? Vanilla's own question, asked vanilla's own way. */
        boolean live() {
            return body.getItemBlockingWith() != null;
        }
    }

    /**
     * Raise the shield and hold it for {@code ticks}. The offhand is filled from the pack first —
     * that is the whole point, and it rides {@link CombatKit#wantOffhand} rather than a shield
     * lookup of its own, so the D1 contention (shield while healthy, totem when one more hit is
     * death) is decided in ONE place and this cannot become a second, more eager opinion.
     *
     * @return a verdict, ok or refused. {@code no_shield} means the pack has none;
     *     {@code totem_preferred} means it has one but the policy is holding a totem instead, which
     *     is a different problem with a different fix (heal, or drop the totem).
     */
    static JsonObject raise(final DroneTools.Slot slot, final int requested) {
        JsonObject r = new JsonObject();
        LivingEntity body = slot.activeBody();
        if (body == null) {
            return DroneHands.fail(r, "no_body");
        }
        int ticks = Math.max(1, Math.min(requested, MAX_TICKS));
        Hands hands = handsOrNull(slot);
        ItemStack held = body.getItemBySlot(EquipmentSlot.OFFHAND);
        String switched = null;
        if (!held.has(DataComponents.BLOCKS_ATTACKS)) {
            // The body arms its own offhand (0.72.0). A player body only: the drone wields what it
            // was handed, exactly as WeaponGate and the dig gate treat it.
            ItemStack want = CombatKit.wantOffhand(body, hands);
            if (!want.has(DataComponents.BLOCKS_ATTACKS)) {
                // TWO REFUSALS, NOT ONE, and the difference is the whole value: "carry a shield" and
                // "you are too hurt for the policy to hold one" are different problems with
                // different fixes, and an agent can only act on the one it hears. Which applies is
                // decided by what the body CARRIES, never by what wantOffhand happened to return —
                // a body with a totem and no shield gets the totem back from the policy for the
                // trivial reason that there was nothing to compare it to, and reporting that as
                // "the policy preferred your totem" would invent a decision nobody made.
                boolean carried = CombatKit.carriesBlocker(body, hands);
                r.addProperty("note", carried
                    ? "the offhand policy is holding " + DroneHands.itemId(want.getItem())
                        + " instead: at " + fmt(body.getHealth()) + " health one more hit is death, "
                        + "so a totem outranks a 90° arc (COMBAT_KIT_PLAN.md D1). Heal past "
                        + fmt(CombatKit.SHIELD_HEALTH) + " and the shield goes back up by itself"
                    : "nothing carried blocks attacks — pick up or craft a shield (a plank-and-iron "
                        + "bench recipe) and the body will raise it by itself");
                return DroneHands.fail(r, carried ? "totem_preferred" : "no_shield");
            }
            switched = hands == null ? null : CombatKit.equipOffhand(hands, want);
            held = body.getItemBySlot(EquipmentSlot.OFFHAND);
            if (!held.has(DataComponents.BLOCKS_ATTACKS)) {
                return DroneHands.fail(r, "no_shield");
            }
        }
        // AN AXE BROKE THIS SHIELD AND VANILLA IS STILL COUNTING. Raising it again does nothing at
        // all (ItemStack.use refuses while the cooldown runs), so a body told "ok" here would stand
        // in the open holding a decoration.
        if (body instanceof ServerPlayer p && p.getCooldowns().isOnCooldown(held)) {
            r.addProperty("note", "that shield was knocked aside and is still on cooldown — it "
                + "cannot be raised yet. Break contact, or fight with the weapon");
            return DroneHands.fail(r, "shield_disabled");
        }

        // ONE HAND (see the class note): the draw goes down so the shield can go up, and it is told
        // why rather than dying of `draw_interrupted` from an author it cannot name.
        if (slot.use != null) {
            PlayerVerbs.failUse(slot, "shield_raised");
        }
        lower(slot, "re_raised");
        body.startUsingItem(InteractionHand.OFF_HAND);
        if (!body.isUsingItem()) {
            r.addProperty("note", "the body would not start using the offhand item — it may be on "
                + "cooldown, or the hand may be busy");
            return DroneHands.fail(r, "use_refused");
        }
        BlocksAttacks ba = held.get(DataComponents.BLOCKS_ATTACKS);
        String itemId = DroneHands.itemId(held.getItem());
        String why = switched != null ? "raised the " + itemId + " it was carrying"
            : "raised the " + itemId + " already in the offhand";
        Guard g = new Guard(body, itemId, ba == null ? 0 : ba.blockDelayTicks(), ticks, why);
        slot.guard = g;

        if (switched != null) {
            JsonObject od = new JsonObject();
            od.addProperty("item", switched);
            od.addProperty("why", why);
            od.addProperty("health", body.getHealth());
            EventLog.emit("offhand_switched", od, slot.target());
        }
        r.addProperty("ok", true);
        r.addProperty("blocking", itemId);
        r.addProperty("ticks", ticks);
        // The five ticks that decide whether any of this mattered. Stated on the way UP, because
        // after the blow has landed it is only an explanation.
        r.addProperty("block_ready_in", g.blockDelay);
        if (switched != null) {
            r.addProperty("offhand_switched", switched);
        }
        r.addProperty("why", why);
        r.addProperty("note", "the shield is up for " + ticks + " ticks. It protects a ~90° arc in "
            + "FRONT of where the head is looking, and NOT for the first " + g.blockDelay
            + " ticks (vanilla's block delay) — raise it before the blow, never as it lands. "
            + "Blocked blows arrive as body_damaged {blocked, blocked_damage}; an axe can knock it "
            + "aside (shield_disabled)");
        return r;
    }

    /** Lower a raised shield. Silent when nothing is up, so every teardown path may call it. */
    static void lower(final DroneTools.Slot slot, final String reason) {
        Guard g = slot.guard;
        if (g == null) {
            return;
        }
        slot.guard = null;
        boolean live = !g.body.isRemoved() && g.body.isUsingItem()
            && g.body.getUseItem().has(DataComponents.BLOCKS_ATTACKS);
        if (live) {
            g.body.stopUsingItem();
        }
        if ("re_raised".equals(reason)) {
            return; // an internal replace, not an event worth a line in anyone's stream
        }
        JsonObject d = new JsonObject();
        d.addProperty("item", g.itemId);
        d.addProperty("reason", reason);
        d.addProperty("held_ticks", g.held);
        d.addProperty("blocked_hits", g.hits);
        d.addProperty("blocked_damage", round(g.blocked));
        EventLog.emit("guard_lowered", d, slot.target());
    }

    /**
     * Drain this tick's blocked blows and advance the raise. Serviced unconditionally from
     * {@code tickWatch}, like the swing clock and the draw — and for the same reason: it drives no
     * legs, so whoever owns the body must not be able to freeze its clock and strand a shield up
     * forever.
     *
     * <p>The DRAIN happens here, EARLY in the pass, and parks the record on the slot for the vitals
     * watch to emit from at the end of it. One consumer clears it and everyone else reads what that
     * consumer parked — a second {@code take} would silently steal the record from whichever reader
     * ran second, and the two would then disagree about whether the body was hit at all.
     */
    static void tick(final DroneTools.Slot slot) {
        slot.blockHit = take(slot.activeBody());
        credit(slot, slot.blockHit);
        Guard g = slot.guard;
        if (g == null) {
            return;
        }
        if (g.body.isRemoved() || !g.body.isAlive()) {
            slot.guard = null;
            return;
        }
        // SOMETHING ELSE TOOK THE HAND. Vanilla holds one in-flight use per ENTITY, so an axe
        // disable, a bow draw, or a meal all end the block — and re-asserting it here is how the
        // livelock in the class note used to happen. The guard ends and says which.
        if (!g.body.isUsingItem() || !g.body.getUseItem().has(DataComponents.BLOCKS_ATTACKS)) {
            lower(slot, disabledNow(g) ? "shield_disabled" : "interrupted");
            return;
        }
        g.held++;
        if (--g.ticksLeft <= 0) {
            lower(slot, "expired");
        }
    }

    /** Report the raise on {@code bot_status}. Present only while one is up, so it costs nothing in
     *  the ordinary read and its mere presence is the fact — the same rule {@code drawing} follows. */
    static void status(final DroneTools.Slot slot, final LivingEntity body, final JsonObject r) {
        ItemStack use = body.isUsingItem() ? body.getUseItem() : ItemStack.EMPTY;
        if (!use.has(DataComponents.BLOCKS_ATTACKS)) {
            return;
        }
        r.addProperty("blocking", DroneHands.itemId(use.getItem()));
        // The difference between a shield that is UP and one that is WORKING. Vanilla answers it
        // exactly this way (getItemBlockingWith returns null through the delay), and an agent that
        // cannot see the difference will keep raising shields into arrows that are already at the
        // bowstring.
        if (body.getItemBlockingWith() == null) {
            BlocksAttacks ba = use.get(DataComponents.BLOCKS_ATTACKS);
            int delay = ba == null ? 0 : ba.blockDelayTicks();
            r.addProperty("block_ready_in", Math.max(1, delay - body.getTicksUsingItem()));
        }
        Guard g = slot.guard;
        if (g != null && g.body == body) {
            r.addProperty("blocking_ticks_left", g.ticksLeft);
        }
    }

    // ---- helpers ------------------------------------------------------------

    /**
     * Add a drained {@link Hit} to the running raise's tally, so {@code guard_lowered} can say what
     * the hold was WORTH ("held 60 ticks, ate 3 blows, 14 damage") rather than only that it
     * happened. Called by the one consumer of {@link #take}, in the same breath — a second reader
     * would have to un-consume the record, and that is how the two would drift.
     */
    private static void credit(final DroneTools.Slot slot, final @Nullable Hit hit) {
        Guard g = slot.guard;
        if (g != null && hit != null) {
            g.hits += hit.hits;
            g.blocked += hit.blocked;
        }
    }

    private static boolean disabledNow(final Guard g) {
        return g.body instanceof ServerPlayer p
            && p.getCooldowns().isOnCooldown(p.getItemBySlot(EquipmentSlot.OFFHAND));
    }

    private static @Nullable Hands handsOrNull(final DroneTools.Slot slot) {
        try {
            return Actuator.require(slot).hands();
        } catch (RuntimeException e) {
            return null; // a possessed mob has no hands; the raise then works only on what it holds
        }
    }

    private static double round(final double d) {
        return Math.round(d * 100.0) / 100.0;
    }

    private static String fmt(final float f) {
        return String.valueOf(Math.round(f * 10.0F) / 10.0F);
    }
}
