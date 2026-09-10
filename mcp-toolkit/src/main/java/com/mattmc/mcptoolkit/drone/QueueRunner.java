package com.mattmc.mcptoolkit.drone;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.EventLog;
import org.jspecify.annotations.Nullable;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;

/**
 * The {@code bot_run} step queue: a macro of embodied actions executed sequentially server-side — one
 * bridge call compresses a whole goto→mine→goto→place sequence that would otherwise cost a round-trip
 * (and its tokens) per action. Steps reuse the exact same bodies as the individual tools, so every step
 * gets the same events, reach checks, beam visuals, and audit trail it would get issued by hand.
 *
 * <p>Execution is a per-tick state machine driven from {@code DroneTools.tickWatch}: sync steps (look/
 * place/use/attack/select/point) run back-to-back within a tick (bounded burst), async steps (goto/mine)
 * park the queue until their completion flows back through {@link #onActionDone}/{@link #onActionFailed}
 * — the same hooks the action events come from, so the queue can never disagree with the event log.
 *
 * <p>Failure policy: abort-on-first-failure. The queue dies with an {@code action_failed} carrying the
 * failing step index, op, and reason, plus how many steps completed — the agent decides whether to
 * resume, replan, or drop it. A new {@code bot_run}, an explicit movement command, or a body change
 * supersedes a running queue the same way a new goto supersedes a flight.
 */
final class QueueRunner {

    /** Max steps accepted in one bot_run. */
    private static final int MAX_STEPS = 64;
    /** Max sync steps executed per tick (keeps one queue from monopolizing a server tick). */
    private static final int SYNC_BURST = 8;
    /** Cap on an op:wait pause, in ticks (30s). */
    private static final int MAX_WAIT_TICKS = 600;

    /** Sequence for queue action ids; the {@code q-} namespace keeps them distinct from a-/m- ids. */
    private static long actionSeq = 0;

    /** One running queue. */
    static final class Run {
        final String actionId;
        final List<JsonObject> steps;
        final @Nullable CompletableFuture<JsonElement> waiter;
        int index;                    // next step to start
        int current;                  // step currently executing (for failure reporting)
        @Nullable String waiting;     // action_id of the async sub-action in flight
        int waitTicks;                // countdown for op:wait
        int stepsDone;

        Run(final String actionId, final List<JsonObject> steps,
            final @Nullable CompletableFuture<JsonElement> waiter) {
            this.actionId = actionId;
            this.steps = steps;
            this.waiter = waiter;
        }
    }

    private QueueRunner() {}

    /** Tool body for {@code bot_run}: validate + install the queue; steps start on the next tick. */
    static JsonObject start(final JsonObject a, final DroneTools.Slot slot,
                            final @Nullable CompletableFuture<JsonElement> waiter) {
        JsonArray stepsArr = a.getAsJsonArray("steps");
        if (stepsArr == null || stepsArr.isEmpty()) {
            throw new IllegalArgumentException("missing `steps` (non-empty array of {op, ...})");
        }
        if (stepsArr.size() > MAX_STEPS) {
            throw new IllegalArgumentException("too many steps: " + stepsArr.size() + " (max " + MAX_STEPS + ")");
        }
        List<JsonObject> steps = new ArrayList<>(stepsArr.size());
        for (JsonElement el : stepsArr) {
            if (!el.isJsonObject() || !el.getAsJsonObject().has("op")) {
                throw new IllegalArgumentException("every step must be an object with an `op`");
            }
            String op = el.getAsJsonObject().get("op").getAsString();
            switch (op) {
                case "goto", "mine", "look", "place", "use", "attack", "select", "point", "wait" -> { }
                default -> throw new IllegalArgumentException("unknown op '" + op
                    + "' (goto|mine|look|place|use|attack|select|point|wait)");
            }
            steps.add(el.getAsJsonObject());
        }

        // Displace any queue/follow base intent (a new queue replaces a running one), then...
        DroneTools.claimBase(slot, DroneTools.BaseKind.RUN, "superseded");
        DroneTools.failPending(slot, "superseded"); // ...supersede any loose manual flight
        slot.queueInterruptedBy = null;             // fresh run: no reaction has interrupted it yet

        Run run = new Run("q-" + (++actionSeq), steps, waiter);
        slot.queue = run;

        JsonObject r = new JsonObject();
        r.addProperty("started", true);
        r.addProperty("action_id", run.actionId);
        r.addProperty("steps", steps.size());
        return r;
    }

    /** Advance the slot's queue one tick (no-op when none). Server thread, from the tick watch. */
    static void tick(final DroneTools.Slot slot) {
        Run run = slot.queue;
        if (run == null || run.waiting != null) {
            return;
        }
        if (run.waitTicks > 0) {
            if (--run.waitTicks == 0) {
                run.stepsDone++;
            }
            return;
        }
        int burst = 0;
        while (run.index < run.steps.size() && slot.queue == run && burst++ < SYNC_BURST) {
            run.current = run.index;
            JsonObject step = run.steps.get(run.index);
            String op = step.get("op").getAsString();
            try {
                switch (op) {
                    case "goto" -> {
                        JsonObject r = DroneTools.startNav(step, slot, null);
                        if (!r.get("started").getAsBoolean()) {
                            // A reach goto can refuse for reasons pathing can't fix (occluded,
                            // reach_unresolved) — forward the real reason, not a generic no_path.
                            fail(slot, run, r.has("reason") && !r.get("reason").isJsonNull()
                                ? r.get("reason").getAsString() : "no_path");
                            return;
                        }
                        run.waiting = r.get("action_id").getAsString();
                        run.index++;
                        return;
                    }
                    case "mine" -> {
                        JsonObject r = DroneHands.startMine(step, slot, null);
                        // Same one-way mirror as the goal loop: a queue step reads `started` and
                        // drops every warning the reply carried (DroneHands.echoAct).
                        DroneHands.echoAct(slot, r, "bot_mine", DroneHands.parsePos(step, "at"));
                        if (!r.get("started").getAsBoolean()) {
                            fail(slot, run, r.get("reason").getAsString());
                            return;
                        }
                        run.waiting = r.get("action_id").getAsString();
                        run.index++;
                        return;
                    }
                    case "wait" -> {
                        int ticks = step.has("ticks") && !step.get("ticks").isJsonNull()
                            ? step.get("ticks").getAsInt() : 20;
                        run.waitTicks = Math.min(Math.max(1, ticks), MAX_WAIT_TICKS);
                        run.index++;
                        return;
                    }
                    case "look" -> sync(slot, run, DroneTools.doLook(step, slot));
                    case "place" -> sync(slot, run, DroneHands.botPlace(step, slot));
                    case "use" -> sync(slot, run, DroneHands.botUse(step, slot));
                    case "attack" -> {
                        JsonObject r = DroneHands.botAttack(step, slot);
                        // F1: an attack that needs a facing turn is a short act now — the queue
                        // waits for its action_completed/failed exactly as it does for mine/goto.
                        if (r.has("started") && r.get("started").getAsBoolean()) {
                            run.waiting = r.get("action_id").getAsString();
                            run.index++;
                            return;
                        }
                        sync(slot, run, r);
                    }
                    case "select" -> sync(slot, run, DroneHands.botSelect(step, slot));
                    case "point" -> sync(slot, run, DroneTools.doPoint(step, slot));
                    default -> {
                        fail(slot, run, "unknown_op");
                        return;
                    }
                }
            } catch (Exception e) {
                fail(slot, run, e.getMessage() == null ? e.toString() : e.getMessage());
                return;
            }
            if (slot.queue != run) {
                return; // the step itself superseded the queue
            }
        }
        if (slot.queue == run && run.index >= run.steps.size()) {
            complete(slot, run);
        }
    }

    /** A sync step's result: ok (or absent, for tools that only throw) advances; ok:false aborts. */
    private static void sync(final DroneTools.Slot slot, final Run run, final JsonObject result) {
        if (result.has("ok") && !result.get("ok").getAsBoolean()) {
            fail(slot, run, result.has("reason") ? result.get("reason").getAsString() : "failed");
            return;
        }
        run.index++;
        run.stepsDone++;
        slot.queueInterruptedBy = null; // a step succeeded: a prior interrupt is no longer the story
    }

    /** Fields a failed goto step forwards into the queue's action_failed — the agent's next decision
     * ("re-goto with a higher within? replan?") needs the distance and partial-path facts, and losing
     * them here forced a follow-up read after every not_arrived. */
    private static final String[] GOTO_DETAIL = { "outcome", "distance_to_target", "traveled", "path_partial", "gates", "pos", "note" };

    /** Async sub-action finished: advance past it (a goto that didn't arrive is a failure). */
    static void onActionDone(final DroneTools.Slot slot, final String actionId, final JsonObject data) {
        Run run = slot.queue;
        if (run == null || !actionId.equals(run.waiting)) {
            return;
        }
        if (data.has("arrived") && !data.get("arrived").getAsBoolean()) {
            JsonObject detail = new JsonObject();
            for (String k : GOTO_DETAIL) {
                if (data.has(k)) {
                    detail.add(k, data.get(k));
                }
            }
            fail(slot, run, "not_arrived", detail);
            return;
        }
        run.waiting = null;
        run.stepsDone++;
        slot.queueInterruptedBy = null; // an async step arrived cleanly: prior interrupt is resolved
    }

    /** Async sub-action failed: the queue dies with its reason. */
    static void onActionFailed(final DroneTools.Slot slot, final String actionId, final String reason) {
        Run run = slot.queue;
        if (run != null && actionId.equals(run.waiting)) {
            fail(slot, run, reason);
        }
    }

    /** Kill the slot's queue (if any) with a reason — body change, despawn, session end, new queue. */
    static void abort(final DroneTools.Slot slot, final String reason) {
        Run run = slot.queue;
        if (run != null) {
            // A teardown (supersede / body change / despawn) is not a reaction-caused failure — drop
            // any interrupt marker so it isn't misattributed as after_reaction on this abort.
            slot.queueInterruptedBy = null;
            fail(slot, run, reason);
        }
    }

    static @Nullable JsonObject describe(final DroneTools.Slot slot) {
        Run run = slot.queue;
        if (run == null) {
            return null;
        }
        JsonObject o = new JsonObject();
        o.addProperty("action_id", run.actionId);
        o.addProperty("steps", run.steps.size());
        o.addProperty("done", run.stepsDone);
        return o;
    }

    private static void complete(final DroneTools.Slot slot, final Run run) {
        slot.queue = null;
        slot.baseKind = DroneTools.BaseKind.IDLE; // the RUN base intent ended
        JsonObject d = new JsonObject();
        d.addProperty("action_id", run.actionId);
        d.addProperty("action", "bot_run");
        d.addProperty("steps", run.steps.size());
        d.addProperty("completed", true);
        EventLog.emit("action_completed", d, slot.target());
        if (run.waiter != null) {
            run.waiter.complete(d.deepCopy());
        }
    }

    private static void fail(final DroneTools.Slot slot, final Run run, final String reason) {
        fail(slot, run, reason, null);
    }

    private static void fail(final DroneTools.Slot slot, final Run run, final String reason,
                             final @Nullable JsonObject detail) {
        if (slot.queue == run) {
            slot.queue = null;
            slot.baseKind = DroneTools.BaseKind.IDLE; // the RUN base intent ended (claimBase re-tags after)
        }
        JsonObject d = new JsonObject();
        d.addProperty("action_id", run.actionId);
        d.addProperty("action", "bot_run");
        d.addProperty("step_index", run.current);
        d.addProperty("op", run.current < run.steps.size()
            ? run.steps.get(run.current).get("op").getAsString() : "?");
        d.addProperty("reason", reason);
        d.addProperty("steps_completed", run.stepsDone);
        // If a reflex interrupted this queue and it then failed, name the reaction — so the agent sees
        // the step died because a reaction consumed its target / moved the body, not that the target
        // was never there. State truth (PLAYER_CONTROL_DESIGN.md §2.4).
        if (slot.queueInterruptedBy != null) {
            d.addProperty("after_reaction", slot.queueInterruptedBy);
            slot.queueInterruptedBy = null;
        }
        if (detail != null) {
            for (var e : detail.entrySet()) {
                d.add(e.getKey(), e.getValue());
            }
        }
        EventLog.emit("action_failed", d, slot.target());
        if (run.waiter != null) {
            run.waiter.complete(d.deepCopy());
        }
    }
}
