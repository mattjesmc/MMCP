package com.mattmc.mcptoolkit.drone;

import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.EventLog;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.ai.goal.GoalSelector;
import org.jspecify.annotations.Nullable;

import java.lang.reflect.Field;

/**
 * Possession: the agent's ghost jumping into a mob already in the world — the second body kind the
 * {@link Actuator} seam anticipated. Mechanically it is two {@link PuppetGoal}s (one per selector)
 * injected at priority 0: the native AI is starved of its control flags but never cleared, so
 * {@link #release} restores the mob untouched. While a slot is possessed, its possessed mob is the
 * <em>active body</em>: bot_goto/bot_look/bot_attack/bot_follow and the perception {@code drone} origin
 * all route to it; the drone (if any) parks and waits.
 *
 * <p><b>Scope: goal-driven mobs only.</b> Brain-driven mobs (villagers, piglins, axolotls…) don't use
 * the goal system, so puppet goals can't silence them — possession is refused with
 * {@code brain_mob_unsupported} (detected via {@code Brain.isBrainDead()}: goal mobs carry an empty
 * dead brain). Capability honesty: a possessed body can move, look, and attack, but has no inventory —
 * the drone-hand tools refuse with {@code no_hands} (see {@link Actuator}).
 *
 * <p>{@code targetSelector} has no public accessor (unlike {@code Mob.getGoalSelector()}), so it is
 * reached reflectively — safe here: 26.x ships unobfuscated and Fabric loads Minecraft outside JPMS
 * modules, so the field name is stable and accessible.
 */
final class Possession {

    /** Ticks the puppet goal gets to actually start before possession is judged ineffective. The
     * selector re-evaluates goals every tick, so an honest goal-driven mob engages within 1–2. */
    private static final int ENGAGE_GRACE_TICKS = 5;

    /** One active possession: the mob, the injected puppet goals (removed on release), and the
     * engagement countdown ({@link #verifyTick}). */
    static final class Hold {
        final Mob mob;
        final PuppetGoal goal;
        final PuppetGoal targetGoal;
        int engageGrace = ENGAGE_GRACE_TICKS;

        Hold(final Mob mob, final PuppetGoal goal, final PuppetGoal targetGoal) {
            this.mob = mob;
            this.goal = goal;
            this.targetGoal = targetGoal;
        }

        Mob mob() {
            return mob;
        }

        PuppetGoal goal() {
            return goal;
        }

        PuppetGoal targetGoal() {
            return targetGoal;
        }
    }

    private static final Field TARGET_SELECTOR;

    static {
        try {
            TARGET_SELECTOR = Mob.class.getDeclaredField("targetSelector");
            TARGET_SELECTOR.setAccessible(true);
        } catch (NoSuchFieldException e) {
            throw new ExceptionInInitializerError(e);
        }
    }

    private Possession() {}

    /**
     * Take control of {@code mob} for {@code slot}, releasing any prior possession first.
     * Caller has already validated the mob (alive, not a drone, not brain-driven, not held elsewhere).
     */
    static void possess(final DroneTools.Slot slot, final Mob mob) {
        release(slot, "possessed_new_body");
        PuppetGoal goal = new PuppetGoal();
        PuppetGoal targetGoal = new PuppetGoal();
        mob.getGoalSelector().addGoal(0, goal);
        targetSelector(mob).addGoal(0, targetGoal);
        mob.setTarget(null);
        mob.getNavigation().stop();
        slot.possession = new Hold(mob, goal, targetGoal);
    }

    /**
     * End the slot's possession (if any) with a structured reason: pull the puppet goals so the native
     * AI resumes, and emit {@code possession_released} targeted at the owning session.
     */
    static void release(final DroneTools.Slot slot, final String reason) {
        release(slot, reason, null);
    }

    /** {@link #release} carrying the converted successor's identity, so a {@code body_converted}
     * release tells the agent which entity to re-possess. */
    static void release(final DroneTools.Slot slot, final String reason, final @Nullable Mob successor) {
        Hold hold = slot.possession;
        if (hold == null) {
            return;
        }
        slot.possession = null;
        Mob mob = hold.mob();
        if (!mob.isRemoved()) {
            mob.getGoalSelector().removeGoal(hold.goal());
            targetSelector(mob).removeGoal(hold.targetGoal());
            mob.getNavigation().stop();
        }
        JsonObject d = new JsonObject();
        d.addProperty("reason", reason);
        d.addProperty("entity_id", mob.getId());
        d.addProperty("type", BuiltInRegistries.ENTITY_TYPE.getKey(mob.getType()).toString());
        if (successor != null) {
            d.addProperty("successor_id", successor.getId());
            d.addProperty("successor_type",
                BuiltInRegistries.ENTITY_TYPE.getKey(successor.getType()).toString());
            d.addProperty("note", "the body converted into the successor entity — bot_possess the "
                + "successor_id to keep driving it");
        }
        EventLog.emit("possession_released", d, slot.target());
    }

    /**
     * MOB_CONVERSION: a possessed body was replaced by its converted successor (zombie→drowned).
     * The conversion discards the old entity, which the removal-reason word would report as a
     * despawn — release here first with the true reason and the successor's identity.
     */
    static void onConverted(final DroneTools.Slot slot, final Mob previous, final Mob converted) {
        Hold hold = slot.possession;
        if (hold != null && hold.mob() == previous) {
            release(slot, "body_converted", converted);
        }
    }

    /**
     * Per-tick engagement check: {@code isBrainDead()} admits mobs whose bespoke AI ignores the goal
     * system entirely (phase managers) — for those the puppet goal never starts and possession owns
     * nothing while reporting success. Releasing as {@code possession_ineffective} keeps the claim
     * honest: ownership is verified, not assumed from injection.
     */
    static void verifyTick(final DroneTools.Slot slot) {
        Hold hold = slot.possession;
        if (hold == null || hold.goal().engaged()) {
            return;
        }
        if (--hold.engageGrace <= 0) {
            release(slot, "possession_ineffective");
        }
    }

    /** The slot's live possessed mob, auto-releasing when it died, despawned, or unloaded. */
    static @Nullable Mob live(final DroneTools.Slot slot) {
        Hold hold = slot.possession;
        if (hold == null) {
            return null;
        }
        Mob mob = hold.mob();
        if (mob.isRemoved() || !mob.isAlive()) {
            release(slot, "body_" + Actuator.removalWord(mob));
            return null;
        }
        return mob;
    }

    /** Package-private: {@link WalkerThreat} injects its player-like target goal through the same
     *  reflective door possession uses. */
    static GoalSelector targetSelector(final Mob mob) {
        try {
            return (GoalSelector) TARGET_SELECTOR.get(mob);
        } catch (IllegalAccessException e) {
            throw new IllegalStateException("cannot access Mob.targetSelector", e);
        }
    }
}
