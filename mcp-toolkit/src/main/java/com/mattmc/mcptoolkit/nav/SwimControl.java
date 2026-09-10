package com.mattmc.mcptoolkit.nav;

import net.minecraft.util.Mth;
import net.minecraft.world.phys.Vec3;

/**
 * The <b>swim half of the driver</b> (BOT_SURFACE_DESIGN.md §12.4): it turns a waypoint into the wet
 * input frame, and it owns the one thing a walking driver never has to think about — <b>air</b>.
 *
 * <p><b>Why air lives here and not in the search.</b> Encoding breath into A* would mean searching over
 * (position × air), which is precisely the unbounded state space {@link BuildWalkNodeEvaluator}'s
 * tractability rule exists to refuse. So the split mirrors the one already proven for breaking and
 * bridging: the search <em>prices</em> submerged cells against the body's breath (a bias, cheap and
 * stateless), and the live body <em>enforces</em> the budget here, where the real number is known.
 *
 * <p><b>Surfacing is an override, not a failure.</b> When breath runs low the control takes the inputs
 * and swims straight up until the head is in air, then hands them back and the route resumes from
 * wherever the body now floats. That matters: the pre-existing {@code surface} reflex
 * ({@code Reflexes}) is an <em>interrupt</em> — it aborts whatever the body was doing — so under it a
 * long crossing could never complete, only fail politely. This breathes mid-route and keeps going, and
 * the reflex stays what it should be: the last resort for when this was not enough.
 *
 * <p>An unwinnable surfacing (ice overhead, a ceiling of stone) is deliberately time-boxed rather than
 * held forever: after {@link #SURFACE_TIMEOUT} ticks it concedes and lets the route continue, because
 * the way out from under a roof is usually forward, not up — and if it truly is stuck, the navigation
 * stall watchdog ends the goal honestly instead of leaving the agent waiting.
 */
public final class SwimControl {

    /** Breath (ticks, of 300) at or below which a submerged body breaks off to surface — ~4.5s left. */
    private static final int AIR_RESERVE = 90;
    /** Breath at which the route resumes; well clear of the reserve so it cannot oscillate. */
    private static final int AIR_RESTORED = 250;
    /** Sprint-swim needs breath to spare — it is faster but it is not free. */
    private static final int SPRINT_AIR_FLOOR = 120;
    /** A surfacing that has not reached air in this many ticks concedes (see the class javadoc). */
    private static final int SURFACE_TIMEOUT = 60;
    /** Below this vertical delta the body just holds depth — stops a waypoint dead ahead making it bob. */
    private static final double DEPTH_DEADZONE = 0.35;
    /** Horizontal distance under which the heading is meaningless and only depth is worth correcting. */
    private static final double FLAT_EPSILON = 1.0e-4;

    private boolean surfacing;
    private int surfacingTicks;

    /** True while the control has taken the body off its route to breathe. */
    public boolean surfacing() {
        return surfacing;
    }

    /** Forget any surfacing state — called when the path is dropped, so a new route starts clean. */
    public void reset() {
        surfacing = false;
        surfacingTicks = 0;
    }

    /**
     * One tick of swimming toward {@code waypoint}. Returns true when the control overrode the route
     * to surface, so the caller can report honestly that the body is breathing rather than travelling.
     */
    public boolean tick(final NavBody body, final Vec3 waypoint, final double speedModifier) {
        if (updateSurfacing(body)) {
            // Straight up, no horizontal thrust: the shortest line to air is the one gravity fights
            // least, and steering toward the route at the same time is what turns a 4-second reserve
            // into a drowning. Sprint stays OFF — the dolphin pose commits the body to its look
            // vector and is slower to change depth than plain vertical thrust.
            body.driveSwim(body.yRot(), -90.0F, 0.0F, 1.0F, false);
            return true;
        }

        double dx = waypoint.x - body.x();
        double dy = waypoint.y - body.y();
        double dz = waypoint.z - body.z();
        double flat = Math.sqrt(dx * dx + dz * dz);

        float yaw = flat < FLAT_EPSILON
            ? body.yRot()
            : (float) (Mth.atan2(dz, dx) * (180.0 / Math.PI)) - 90.0F;
        // Vanilla's pitch convention: negative looks UP. Aiming the body along its travel vector is
        // not merely cosmetic — a sprint-swimming player is pulled by its look vector
        // (Player.travel), and every perception read comes from this eye.
        float pitch = (float) (-Mth.atan2(dy, Math.max(flat, FLAT_EPSILON)) * (180.0 / Math.PI));
        pitch = Mth.clamp(pitch, -90.0F, 90.0F);

        float vertical = Math.abs(dy) < DEPTH_DEADZONE ? 0.0F : (float) Math.signum(dy);
        float forward = flat < FLAT_EPSILON ? 0.0F : (float) speedModifier;
        // Sprint-swim only with breath to spare and somewhere to actually go: a body correcting depth
        // in place has nothing to sprint at.
        boolean sprint = forward > 0.0F && flat > 1.0
            && (body.canBreatheUnderwater() || body.airSupply() > SPRINT_AIR_FLOOR);

        body.driveSwim(yaw, pitch, forward, vertical, sprint);
        return false;
    }

    /**
     * Should the body be surfacing right now? Hysteresis in both directions: it commits at
     * {@link #AIR_RESERVE} and only releases once the head is genuinely in air AND breath has come
     * back past {@link #AIR_RESTORED}, so a body bobbing at a wave crest does not flip every tick.
     */
    private boolean updateSurfacing(final NavBody body) {
        if (body.canBreatheUnderwater()) {
            surfacing = false;
            return false;
        }
        if (surfacing) {
            if (!body.submerged() && body.airSupply() >= AIR_RESTORED) {
                surfacing = false;
                surfacingTicks = 0;
                return false;
            }
            if (++surfacingTicks > SURFACE_TIMEOUT) {
                // Could not reach air in time — there is a roof. Concede and let the route run; the
                // way out is forward, and a genuine trap is the stall watchdog's to report.
                surfacing = false;
                surfacingTicks = 0;
                return false;
            }
            return true;
        }
        if (body.submerged() && body.airSupply() <= AIR_RESERVE) {
            surfacing = true;
            surfacingTicks = 0;
            return true;
        }
        return false;
    }
}
