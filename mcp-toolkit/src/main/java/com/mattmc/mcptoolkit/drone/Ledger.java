package com.mattmc.mcptoolkit.drone;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.core.BlockPos;
import org.jspecify.annotations.Nullable;

/**
 * What a multi-step embodied intent <em>actually did</em> before it finished or gave up
 * (BOT_SURFACE_DESIGN.md §2.2).
 *
 * <p>This is the piece that makes a partial failure <b>resumable without a re-survey turn</b>, which
 * is the whole token argument: today an aborted queue reports {@code steps_completed} and the agent
 * must re-read the world to discover what changed. A ledger states it. It is also where the search's
 * <em>optimism</em> (BuildWalkNodeEvaluator §1.3 — the plan assumes materials last and breaks
 * succeed) gets reconciled against what happened, so the disclosure is concrete rather than a
 * caveat in a description.
 *
 * <p>Every recorded entry is a real completed act, appended by the tool body that performed it —
 * never a prediction and never a plan.
 */
public final class Ledger {

    private final JsonArray mined = new JsonArray();
    private final JsonArray placed = new JsonArray();
    private final JsonArray doorsOpened = new JsonArray();
    private final JsonArray jumped = new JsonArray();
    private @Nullable BlockPos traveledTo;
    private int stepsCompleted;

    /** A block was actually broken at {@code at}. */
    public void mined(final BlockPos at, final String block) {
        mined.add(cell(at, "block", block));
    }

    /** A block was actually placed at {@code at} (bridging, or an explicit place step). */
    public void placed(final BlockPos at, final String item) {
        placed.add(cell(at, "item", item));
    }

    /** A door was actually opened at {@code at}. */
    public void doorOpened(final BlockPos at) {
        doorsOpened.add(cell(at, null, null));
    }

    /** A gap was cleared with a running jump, landing at {@code at} (no blocks spent). */
    public void jumped(final BlockPos at) {
        jumped.add(cell(at, null, null));
    }

    /**
     * The body arrived somewhere. Overwritten as it advances, and therefore <b>not</b> where the
     * body ended up: five different branches stamp this (one of them from a navigation completion
     * EVENT rather than from the body), so it is the last position some code path happened to
     * record. Session w2-56123 read it as ground truth and reported the goal "snapping back to a
     * coordinate I wasn't standing at" — an instrument that lies quietly is worse than a missing
     * one, and it cost that postmortem a whole wrong section on its first pass.
     *
     * <p>{@link #endedAt} now overwrites it once, at the terminal event, from
     * {@code body.blockPosition()}. This setter stays because the running record is still useful
     * (a goal that fails before the stamp has something rather than nothing), but the final answer
     * is the body's own.
     */
    public void traveledTo(final BlockPos at) {
        this.traveledTo = at;
    }

    /** Stamp the FINAL position from the body itself, at the terminal event. The last word. */
    public void endedAt(final BlockPos at) {
        this.traveledTo = at;
    }

    public void stepCompleted() {
        stepsCompleted++;
    }

    public void stepsCompleted(final int n) {
        stepsCompleted = n;
    }

    /** True when nothing was accomplished — callers omit an empty ledger rather than emit noise. */
    public boolean isEmpty() {
        return mined.isEmpty() && placed.isEmpty() && doorsOpened.isEmpty() && jumped.isEmpty()
            && traveledTo == null && stepsCompleted == 0;
    }

    /**
     * Render for an {@code action_completed} / {@code action_failed} payload. {@code reason} and
     * {@code obstruction} describe why it stopped (both optional — a clean completion has neither).
     */
    public JsonObject describe(final @Nullable String reason, final @Nullable JsonObject obstruction) {
        JsonObject o = new JsonObject();
        o.addProperty("steps_completed", stepsCompleted);
        if (traveledTo != null) {
            o.add("traveled_to", cell(traveledTo, null, null));
        }
        if (!mined.isEmpty()) {
            o.add("mined", mined);
        }
        if (!placed.isEmpty()) {
            o.add("placed", placed);
        }
        if (!doorsOpened.isEmpty()) {
            o.add("doors_opened", doorsOpened);
        }
        if (!jumped.isEmpty()) {
            o.add("jumped", jumped);
        }
        if (reason != null || obstruction != null) {
            JsonObject stopped = new JsonObject();
            if (reason != null) {
                stopped.addProperty("reason", reason);
            }
            if (obstruction != null) {
                stopped.add("obstruction", obstruction);
            }
            o.add("stopped", stopped);
        }
        return o;
    }

    private static JsonObject cell(final BlockPos at, final @Nullable String key,
                                   final @Nullable String value) {
        JsonObject c = new JsonObject();
        c.addProperty("x", at.getX());
        c.addProperty("y", at.getY());
        c.addProperty("z", at.getZ());
        if (key != null && value != null) {
            c.addProperty(key, value);
        }
        return c;
    }
}
