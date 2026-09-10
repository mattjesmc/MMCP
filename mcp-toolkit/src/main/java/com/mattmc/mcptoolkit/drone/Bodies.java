package com.mattmc.mcptoolkit.drone;

import com.mattmc.mcptoolkit.nav.NavProfile;
import java.util.Set;
import net.minecraft.core.BlockPos;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.level.pathfinder.Path;
import org.jspecify.annotations.Nullable;

/**
 * The navigation seam of the {@code Mob → LivingEntity} widening (BOT_SURFACE_DESIGN.md §11.8's
 * "own slice", built 2026-07-30): every control-surface caller that used to reach for
 * {@code body.getNavigation()} goes through {@link #nav} instead, and the two body families answer
 * with the same small contract — vanilla {@code PathNavigation} for Mob bodies (flyer, walker,
 * possessed), {@link com.mattmc.mcptoolkit.nav.PlayerNavigation} for the {@link FakePlayerEntity}.
 *
 * <p>This is deliberately the WHOLE abstraction: everything else the surface needs from a body
 * (position, health, level, {@code lookAt}, swing, equipment) already lives on {@code LivingEntity}
 * or {@code Entity}. Only navigation is Mob-rooted in vanilla, so only navigation gets a seam.
 */
public final class Bodies {
    private Bodies() {}

    /** What the control surface asks of a body's navigation — the used subset, nothing more. */
    public interface Nav {
        /**
         * Path toward a point under {@code profile}. False = no path (reported honestly, never
         * walked hopefully).
         *
         * <p>The profile is NOT decoration: it used to be hardcoded {@code NavProfile.DEFAULT} here,
         * so a caller's {@code swim:false} was parsed, echoed back in the verdict, and then dropped
         * before anything planned — the walking navigation always ran with the swim right. A
         * land-only goal therefore planned a water route and drowned a player body (2026-08-01).
         */
        boolean moveTo(double x, double y, double z, double speed, NavProfile profile);

        /**
         * Path toward the nearest of {@code stands} (a reach-goal's candidate stand cells).
         * Returns the stand actually pathed to, or null when no path exists.
         */
        @Nullable BlockPos moveToStands(Set<BlockPos> stands, double speed, NavProfile profile);

        void stop();

        boolean isDone();

        /** The current path's target, or null when idle. */
        @Nullable BlockPos targetPos();

        /**
         * Did this navigation END BECAUSE THE BODY WAS WEDGED, rather than by arriving or by running
         * out of path? (§12.4)
         *
         * <p>The signal has to live here because both body families detect it themselves and neither
         * used to say so: a Mob body has vanilla's {@code doStuckDetection} (which sets
         * {@code isStuck} and stops the path), and the player body has {@code PlayerNavigation}'s node
         * timeout. Whichever fires, it calls {@code stop()} — so by the time the pending-nav watcher
         * looks, the path is simply "done" and the verdict came out as an ordinary
         * {@code stopped_short}. That is a materially different fact: stopped-short invites
         * re-issuing the call, and a wedged body would wedge again.
         */
        default boolean stalled() {
            return false;
        }

        /**
         * The impassable node cell that ended the last path — the player follower's blocked-node
         * stop naming its obstruction (a cell the world changed under the plan, or a door still
         * closed). Null when the path ended any other way, and for body families whose navigation
         * does not detect it. Lets the nav verdict say WHICH cell, not just "wedged".
         */
        default @Nullable BlockPos blockedOn() {
            return null;
        }

        /** Node count of the current path (0 when idle) — report material only. */
        int nodeCount();

        /**
         * Sprint every forward frame of navigation until cleared — fight-mode repositioning
         * (V3_PLAN.md §2 F4). No-op for body families whose navigation has no sprint notion
         * (flyer, possessed vanilla navigations). Sticky: Engage sets AND clears it.
         */
        default void setSprint(final boolean on) {}

        /**
         * Verified landings of the driver's self-leaps since the last drain (walker + player
         * drivers; empty for bodies whose navigation never leaps). The goal loop folds these into
         * its ledger — an undisclosed leap is a silent world-interaction.
         */
        default java.util.List<BlockPos> drainSelfLeaps() {
            return java.util.List.of();
        }

        /**
         * The body's proprioception trail (SURVIVAL_MODE_PLAN.md §4), or null for bodies whose
         * feet read nothing (flyer, possessed vanilla navigations). Grounded navigations record
         * reached cells with their true contents; nav verdicts carry the drained trail.
         */
        default com.mattmc.mcptoolkit.nav.@Nullable TraversalTrail trail() {
            return null;
        }
    }

    /** The body's navigation through one contract. Throws for a body kind without navigation —
     *  which would be a new body class that forgot to wire this seam, a programmer error. */
    public static Nav nav(final LivingEntity body) {
        if (body instanceof Mob mob) {
            return new MobNav(mob);
        }
        if (body instanceof FakePlayerEntity player) {
            return new PlayerNav(player);
        }
        throw new IllegalStateException("body " + body.getType() + " has no navigation seam");
    }

    /** The body kind word every report uses. */
    public static String kind(final @Nullable LivingEntity body) {
        if (body == null) {
            return "none";
        }
        if (body instanceof WalkerEntity) {
            return "walker";
        }
        if (body instanceof DroneEntity) {
            return "flyer";
        }
        if (body instanceof FakePlayerEntity) {
            return "player";
        }
        return "possessed";
    }

    private record MobNav(Mob mob) implements Nav {
        @Override
        public boolean moveTo(final double x, final double y, final double z, final double speed,
                              final NavProfile profile) {
            applySwim(profile);
            return mob.getNavigation().moveTo(x, y, z, speed);
        }

        /**
         * A possessed mob keeps its OWN vanilla navigation, so the only part of the profile that can
         * be honoured here is the swim right — and it maps exactly onto vanilla's float flag. The
         * rest (break/place budgets, the build-aware search) belongs to bodies with hands and is
         * documented as not applying to possession, rather than silently pretended.
         */
        private void applySwim(final NavProfile profile) {
            if (mob.getNavigation() instanceof net.minecraft.world.entity.ai.navigation.GroundPathNavigation g) {
                g.setCanFloat(profile.canSwim());
            }
        }

        @Override
        public @Nullable BlockPos moveToStands(final Set<BlockPos> stands, final double speed,
                                               final NavProfile profile) {
            applySwim(profile);
            Path path = mob.getNavigation().createPath(stands, 0);
            if (path == null || !mob.getNavigation().moveTo(path, speed)) {
                return null;
            }
            return path.getTarget();
        }

        @Override
        public void stop() {
            mob.getNavigation().stop();
        }

        @Override
        public boolean isDone() {
            return mob.getNavigation().isDone();
        }

        @Override
        public @Nullable BlockPos targetPos() {
            return mob.getNavigation().getTargetPos();
        }

        @Override
        public int nodeCount() {
            Path p = mob.getNavigation().getPath();
            return p == null ? 0 : p.getNodeCount();
        }

        @Override
        public boolean stalled() {
            return mob.getNavigation().isStuck(); // vanilla's own doStuckDetection verdict
        }

        @Override
        public java.util.List<BlockPos> drainSelfLeaps() {
            return mob.getNavigation() instanceof com.mattmc.mcptoolkit.nav.WalkerNavigation nav
                ? nav.drainSelfLeaps() : java.util.List.of();
        }

        @Override
        public void setSprint(final boolean on) {
            if (mob.getNavigation() instanceof com.mattmc.mcptoolkit.nav.WalkerNavigation nav) {
                nav.setSprint(on);
            }
        }

        @Override
        public com.mattmc.mcptoolkit.nav.@Nullable TraversalTrail trail() {
            return mob.getNavigation() instanceof com.mattmc.mcptoolkit.nav.WalkerNavigation nav
                ? nav.trail() : null;
        }
    }

    private record PlayerNav(FakePlayerEntity player) implements Nav {
        @Override
        public boolean moveTo(final double x, final double y, final double z, final double speed,
                              final NavProfile profile) {
            return player.navigation().moveTo(player.level(),
                BlockPos.containing(x, y, z), speed, profile);
        }

        @Override
        public @Nullable BlockPos moveToStands(final Set<BlockPos> stands, final double speed,
                                               final NavProfile profile) {
            return player.navigation().moveToStands(player.level(), stands, speed, profile);
        }

        @Override
        public void stop() {
            player.navigation().stop();
        }

        @Override
        public boolean isDone() {
            return player.navigation().isDone();
        }

        @Override
        public @Nullable BlockPos targetPos() {
            Path p = player.navigation().path();
            return p == null ? null : p.getTarget();
        }

        @Override
        public int nodeCount() {
            Path p = player.navigation().path();
            return p == null ? 0 : p.getNodeCount();
        }

        @Override
        public boolean stalled() {
            return player.navigation().timedOut();
        }

        @Override
        public @Nullable BlockPos blockedOn() {
            return player.navigation().blockedOn();
        }

        @Override
        public java.util.List<BlockPos> drainSelfLeaps() {
            return player.navigation().drainSelfLeaps();
        }

        @Override
        public void setSprint(final boolean on) {
            player.navigation().setSprint(on);
        }

        @Override
        public com.mattmc.mcptoolkit.nav.TraversalTrail trail() {
            return player.navigation().trail();
        }
    }
}
