package com.mattmc.mcptoolkit.drone;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.EventLog;
import java.util.LinkedHashSet;
import java.util.Set;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.player.Player;
import org.jspecify.annotations.Nullable;

/**
 * The body's <b>danger sense</b> — the environmental half of proprioception.
 *
 * <p><b>Why this exists, measured.</b> The first watched survival session drowned. Neither layer
 * reacted, and neither COULD: {@code bot_status} reported health and food but nothing about air,
 * water or footing, and the reflex layer's trigger vocabulary had no environmental term at all. The
 * model saw health falling with no visible cause — and invented one (a cave pocket and a flee reflex
 * that never fired). A body that can be killed by something it has no word for will keep
 * confabulating, so the fix is a sense, not a prompt.
 *
 * <p><b>Onset events, not per-tick fields.</b> Each cause fires {@code body_endangered} ONCE when it
 * begins and {@code body_safe} once when it clears — the same enter/leave shape
 * {@link DroneObserver} already uses for entity radius, and for the same reason: a per-tick emit
 * would flood the log and drown the signal it exists to carry. That pairing is what makes
 * {@code get_events wait_ms:…} wake the agent ON DANGER instead of only on chat.
 *
 * <p>Every cause is also readable on demand from {@code bot_status} (`dangers`), because an event is
 * a notification and the agent may arrive late.
 */
final class Hazards {
    private Hazards() {}

    /**
     * The cause vocabulary, in the order {@link #current} evaluates it. Public within the package
     * because it is now also a REFLEX TRIGGER vocabulary: {@code bot_reactions} arms
     * {@code {kind:"hazard", cause:…}} against exactly these names ({@link Reflexes}). Keeping one
     * list is the point — the danger sense used to be able to name dangers the fast layer had no
     * word for, so the only cause a body could actually be saved from was {@code air_low}, and the
     * remedies for lava and fire were advice the agent's round-trip is too slow to take.
     */
    /**
     * The one bindable cause that is not a danger: it never enters {@code slot.hazards} and never
     * emits {@code body_endangered} (see {@link #foodTick}), but a body may absolutely arm
     * {@code {kind:"hazard", cause:"food_low"}} → {@code eat} against it. {@link Reflexes} reads the
     * latch directly for this one.
     */
    static final String FOOD_LOW_CAUSE = "food_low";

    static final Set<String> CAUSES = Set.of(
        "air_low", "in_lava", "on_fire", "falling", "suffocating", "starving", FOOD_LOW_CAUSE);

    /** Air supply at or below this (of 300 = 15s) is announced. Half-gone: still time to surface. */
    private static final int AIR_LOW = 150;
    /** Fall distance beyond this is announced — below it a landing is survivable for every body. */
    private static final float FALL_WARN = 4.0F;
    /** Player food at or below this is announced (6 = below the sprint threshold, hunger damage next). */
    private static final int FOOD_LOW = 6;
    /**
     * The GENTLE hunger tier: announced once on the way down, cleared on the way back up, and never
     * urgent. `starving` at 6 is an emergency — by then sprinting is gone and hunger damage is next
     * — so it is the wrong instrument for "eat before you commit to the next descent". Session
     * w2-56123 was told about hunger only through the danger sense, and the previous postmortem
     * answered the same gap with charter doctrine ("food before depth"). Doctrine the body has to
     * remember is weaker than an event that arrives; the hysteresis gap is what keeps this one from
     * becoming the chatter that gets filtered out.
     */
    private static final int FOOD_WARN = 10;
    private static final int FOOD_WARN_CLEAR = 12;

    /**
     * Re-evaluate the active body's hazards and emit the onset/clear transitions. Called once per
     * server tick from {@code DroneTools.tickWatch}. `active` is the slot's live cause set, mutated
     * in place. A null body clears everything silently (its removal is already evented).
     */
    static void tick(final DroneTools.Slot slot, final @Nullable LivingEntity body) {
        Set<String> active = slot.hazards;
        if (body == null || body.isRemoved()) {
            active.clear(); // no body, no hazards — its removal is already evented
            return;
        }
        if (!body.isAlive()) {
            // Dead but not yet reaped: HOLD the causes rather than clearing them. The death handler
            // in tickWatch runs LATER in the same tick and reports them as `hazards` on body_died —
            // the difference between "it died" and "it drowned" — then clears them itself. Clearing
            // here emptied that field before it could be read (caught by hazards.test.mjs, which is
            // exactly the confabulation this whole slice exists to prevent).
            return;
        }
        foodTick(slot, body);
        Set<String> now = current(body);
        for (String cause : now) {
            if (active.add(cause)) {
                JsonObject d = new JsonObject();
                d.addProperty("cause", cause);
                d.addProperty("body", Bodies.kind(body));
                detail(d, cause, body);
                DroneTools.addVec(d, "pos", body.position());
                DroneTools.stampEnvelope(d, body);
                EventLog.emit("body_endangered", d, slot.target());
            }
        }
        active.removeIf(cause -> {
            if (now.contains(cause)) {
                return false;
            }
            JsonObject d = new JsonObject();
            d.addProperty("cause", cause);
            d.addProperty("body", Bodies.kind(body));
            DroneTools.stampEnvelope(d, body);
            EventLog.emit("body_safe", d, slot.target());
            return true;
        });
    }

    /**
     * The gentle hunger warning, with its own hysteresis so a body hovering at the threshold does
     * not narrate every bite. Emitted outside the {@code body_endangered} vocabulary on purpose:
     * this is not danger, it is the last comfortable moment to do something about it.
     */
    private static void foodTick(final DroneTools.Slot slot, final LivingEntity body) {
        if (!(body instanceof Player p)) {
            return;
        }
        int food = p.getFoodData().getFoodLevel();
        if (!slot.foodWarned && food <= FOOD_WARN) {
            slot.foodWarned = true;
            JsonObject d = new JsonObject();
            d.addProperty("food", food);
            d.addProperty("max_food", 20);
            d.addProperty("remedy", "eat now while it is still a choice — bot_eat, or arm the "
                + "standing order {trigger:{kind:\"hazard\", cause:\"food_low\"}, response:{op:"
                + "\"eat\"}}. Below 6 you cannot sprint and hunger damage follows");
            DroneTools.addVec(d, "pos", body.position());
            DroneTools.stampEnvelope(d, body);
            EventLog.emit("food_low", d, slot.target());
        } else if (slot.foodWarned && food >= FOOD_WARN_CLEAR) {
            slot.foodWarned = false;
            JsonObject d = new JsonObject();
            d.addProperty("food", food);
            DroneTools.stampEnvelope(d, body);
            EventLog.emit("food_ok", d, slot.target());
        }
    }

    /** The hazards true of {@code body} right now. Order is stable so the event stream reads the same. */
    static Set<String> current(final LivingEntity body) {
        Set<String> out = new LinkedHashSet<>();
        // Drowning is FIRST because it is the fastest killer that looks like nothing: air runs out in
        // 15s and every symptom before that is "health is falling".
        if (!body.canBreatheUnderwater() && body.isEyeInFluid(net.minecraft.tags.FluidTags.WATER)
            && body.getAirSupply() <= AIR_LOW) {
            out.add("air_low");
        }
        if (body.isInLava()) {
            out.add("in_lava");
        }
        if (body.isOnFire() && !body.fireImmune()) {
            out.add("on_fire");
        }
        if (!body.onGround() && body.fallDistance > FALL_WARN) {
            out.add("falling");
        }
        if (body.isInWall()) {
            out.add("suffocating");
        }
        if (body instanceof Player p && p.getFoodData().getFoodLevel() <= FOOD_LOW) {
            out.add("starving");
        }
        return out;
    }

    /** Cause-specific numbers, so the event says HOW BAD rather than only THAT. */
    private static void detail(final JsonObject d, final String cause, final LivingEntity body) {
        switch (cause) {
            case "air_low" -> {
                d.addProperty("air", body.getAirSupply());
                d.addProperty("max_air", body.getMaxAirSupply());
                // The number that matters: seconds of breath left at vanilla's 1-per-tick drain.
                d.addProperty("seconds_left", Math.max(0, body.getAirSupply()) / 20);
                d.addProperty("remedy", "surface NOW — bot_goto to a shore cell, or arm a reflex "
                    + "{trigger:{kind:\"air_below\"}, response:{op:\"surface\"}} so the body saves itself");
            }
            case "on_fire" -> d.addProperty("remedy", "get into water, or step away from the fire source");
            case "in_lava" -> d.addProperty("remedy", "lava kills in about 4 seconds — FASTER THAN YOUR "
                + "TURN. Reading this event is already late; arm {trigger:{kind:\"hazard\", "
                + "cause:\"in_lava\"}, response:{op:\"surface\"}} so the body floats itself out on the "
                + "tick it happens");
            case "falling" -> {
                d.addProperty("fall_distance", Math.round(body.fallDistance * 10.0F) / 10.0F);
                // No remedy is offered on purpose: by the time a fall is 4 blocks deep, nothing the
                // agent OR a reflex can do changes the landing. The event is a witness, not a cue —
                // and saying so beats inventing advice that cannot work.
                d.addProperty("remedy", "none in flight — this is a witness event; prevent falls with "
                    + "check_path before committing to a route");
            }
            case "suffocating" -> d.addProperty("remedy", "you are inside a block — arm {trigger:{kind:"
                + "\"hazard\", cause:\"suffocating\"}, response:{op:\"backstep\"}} to step back out, or "
                + "bot_mine the block your head is in");
            case "starving" -> {
                if (body instanceof Player p) {
                    d.addProperty("food", p.getFoodData().getFoodLevel());
                    d.addProperty("remedy", "bot_eat — below 6 you cannot sprint and hunger damage "
                        + "follows. Standing order: {trigger:{kind:\"hazard\", cause:\"starving\"}, "
                        + "response:{op:\"eat\"}} feeds you without a round-trip");
                }
            }
            default -> { }
        }
    }

    /** The active causes as JSON, for {@code bot_status} — an event may have been missed. */
    static JsonArray describe(final LivingEntity body) {
        JsonArray arr = new JsonArray();
        for (String c : current(body)) {
            arr.add(c);
        }
        return arr;
    }
}
