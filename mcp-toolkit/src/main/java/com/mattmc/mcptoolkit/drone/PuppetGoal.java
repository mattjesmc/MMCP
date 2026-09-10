package com.mattmc.mcptoolkit.drone;

import net.minecraft.world.entity.ai.goal.Goal;

import java.util.EnumSet;

/**
 * The possession mechanism: a priority-0 goal claiming every control flag ({@code MOVE, LOOK, JUMP,
 * TARGET}) that is "in use" for as long as possession lasts. While it runs, the mob's native goals are
 * starved of their flags — they stay registered but cannot act — and the bot_* tools drive the mob's
 * navigation and look controls directly, the same way they drive the drone. Removing the goal returns
 * the mob to its untouched native AI: nothing was cleared, so nothing needs restoring.
 *
 * <p>One instance goes into the {@code goalSelector} and one into the {@code targetSelector} (separate
 * selectors have separate flag pools — a TARGET claim in one does not starve the other). Flagless goals
 * still run; that's fine, they are ambience, not control.
 */
final class PuppetGoal extends Goal {

    /** Set by the goal selector when it actually starts running this goal — the proof the mob's AI
     * routes through the goal system at all. A bespoke-AI mob (phase managers etc.) never starts it,
     * and possession of such a body owns nothing; {@link Possession#verifyTick} checks this. */
    private boolean engaged = false;

    PuppetGoal() {
        this.setFlags(EnumSet.of(Flag.MOVE, Flag.LOOK, Flag.JUMP, Flag.TARGET));
    }

    @Override
    public void start() {
        engaged = true;
    }

    boolean engaged() {
        return engaged;
    }

    @Override
    public boolean canUse() {
        return true;
    }

    @Override
    public boolean canContinueToUse() {
        return true;
    }
}
