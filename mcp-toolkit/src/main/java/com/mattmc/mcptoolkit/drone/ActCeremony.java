package com.mattmc.mcptoolkit.drone;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

import java.util.concurrent.CompletableFuture;
import java.util.function.Supplier;

/**
 * A short tick-scripted performance around an instant, verified mutation — the visible ceremony of
 * acts that vanilla players take time over but this body used to do in zero ticks: opening a chest
 * (lid + sound), working at a crafting bench. The shape is always
 * {@code face → open → hold/swing → commit → close → finish}, where {@code commit} is the SAME
 * synchronous tool body that ran before ceremonies existed — the theater never touches the
 * mutation, so the reply and its honesty are exactly what they were.
 *
 * <p><b>Preemption rule.</b> If a reflex or fight claims the body mid-ceremony (the base branch
 * stops servicing us), {@link #resolveNow} runs the commit immediately, skips the remaining
 * theater, and completes the waiter — the mutation is never lost and the reply never lies; only
 * the animation is cut short. The one exception is a dead/removed body: committing a transfer
 * into a corpse's pack would strand the items, so that resolves as an honest
 * {@code {ok:false, reason:"body_removed"}} instead.
 */
final class ActCeremony {

    /** Ticks into the ceremony at which the container/bench is "opened" (facing has mostly landed). */
    private static final int OPEN_AT_TICK = 4;

    private ActCeremony() {}

    /** One ceremony in flight, held as {@code Slot.ceremony} and serviced in the base branch. */
    static final class Act {
        final String kind;                       // "container" | "craft" — /activity's hold label
        final LivingEntity body;
        final @Nullable Vec3 face;
        final Supplier<JsonObject> commit;       // the pre-existing verified mutation
        final @Nullable Runnable open;           // e.g. openMenu — lid + open sound, once
        final @Nullable Runnable close;          // e.g. closeContainer — lid down + close sound
        final @Nullable Runnable swing;          // periodic arm visual
        final CompletableFuture<JsonElement> waiter;
        final int swingEvery;
        int tick;
        final int commitAtTick;
        boolean opened;

        private Act(final String kind, final LivingEntity body, final @Nullable Vec3 face,
                    final Supplier<JsonObject> commit, final @Nullable Runnable open,
                    final @Nullable Runnable close, final @Nullable Runnable swing,
                    final int commitAtTick, final int swingEvery,
                    final CompletableFuture<JsonElement> waiter) {
            this.kind = kind;
            this.body = body;
            this.face = face;
            this.commit = commit;
            this.open = open;
            this.close = close;
            this.swing = swing;
            this.commitAtTick = commitAtTick;
            this.swingEvery = swingEvery;
            this.waiter = waiter;
        }
    }

    /** True while a ceremony holds this slot's hands — the `busy` answer for a second act. */
    static boolean busy(final DroneTools.Slot slot) {
        return slot.ceremony != null;
    }

    /**
     * Begin a ceremony. The caller has already validated the act (reach, container present) — a
     * refusal must be instant, never a one-second performance ending in "no". Returns false when a
     * ceremony is already in flight (the caller refuses `busy`).
     */
    static boolean begin(final DroneTools.Slot slot, final String kind, final LivingEntity body,
                         final @Nullable Vec3 face, final Supplier<JsonObject> commit,
                         final @Nullable Runnable open, final @Nullable Runnable close,
                         final @Nullable Runnable swing, final int ticks, final int swingEvery,
                         final CompletableFuture<JsonElement> waiter) {
        if (slot.ceremony != null) {
            return false;
        }
        slot.ceremony = new Act(kind, body, face, commit, open, close, swing,
            Math.max(ticks, 1), Math.max(swingEvery, 1), waiter);
        if (face != null) {
            LookDriver.holdOn(slot, body, face, 25f, "ceremony");
        }
        return true;
    }

    /** Advance one tick — called from the base branch of {@code tickWatch}. */
    static void tick(final DroneTools.Slot slot) {
        Act act = slot.ceremony;
        if (act == null) {
            return;
        }
        if (act.body.isRemoved() || !act.body.isAlive()) {
            resolveNow(slot, "body_removed");
            return;
        }
        act.tick++;
        if (!act.opened && act.tick >= OPEN_AT_TICK) {
            act.opened = true;
            if (act.open != null) {
                act.open.run();
            }
        }
        if (act.opened && act.swing != null && act.tick % act.swingEvery == 0
            && act.tick < act.commitAtTick) {
            act.swing.run();
        }
        if (act.tick >= act.commitAtTick) {
            finish(slot, act);
        }
    }

    /**
     * Cut the theater and resolve the act RIGHT NOW — reflex/fight preemption, session teardown.
     * The commit still runs (against a live body), so the mutation is never lost to an animation.
     */
    static void resolveNow(final DroneTools.Slot slot, final String cause) {
        Act act = slot.ceremony;
        if (act == null) {
            return;
        }
        if (act.body.isRemoved() || !act.body.isAlive()) {
            slot.ceremony = null;
            LookDriver.clear(slot, "ceremony");
            JsonObject r = new JsonObject();
            r.addProperty("ok", false);
            r.addProperty("reason", "body_removed");
            r.addProperty("note", "the body was lost mid-act (" + cause + ") — nothing was moved");
            act.waiter.complete(r);
            return;
        }
        finish(slot, act);
    }

    private static void finish(final DroneTools.Slot slot, final Act act) {
        slot.ceremony = null;
        LookDriver.clear(slot, "ceremony");
        JsonObject reply;
        try {
            if (act.open != null && !act.opened) {
                // Resolving before the open tick: still open-then-close so lid state and the
                // opener count stay balanced (a stopOpen without its startOpen underflows).
                act.opened = true;
                act.open.run();
            }
            reply = act.commit.get();
        } catch (RuntimeException e) {
            reply = new JsonObject();
            reply.addProperty("ok", false);
            reply.addProperty("reason", "act_failed");
            reply.addProperty("note", e.getMessage() == null ? e.getClass().getSimpleName()
                : e.getMessage());
        } finally {
            if (act.close != null && act.opened) {
                try {
                    act.close.run();
                } catch (RuntimeException ignored) {
                    // a close that fails (chunk unloaded under us) must not eat the reply
                }
            }
        }
        act.waiter.complete(reply);
    }
}
