package com.mattmc.mcptoolkit.nav;

/**
 * The body as the <b>driver</b> sees it: a {@link NavPhysique} that can also be steered. The driver
 * emits a per-tick input frame — yaw, forward impulse, jump, sprint — and the body's sink translates
 * it into whatever its substrate understands (BOT_SURFACE_DESIGN.md §11.6 decision 2): a Mob body
 * writes {@code setYRot}/{@code setSpeed}(which sets zza)/{@code JumpControl}, exactly what vanilla's
 * {@code MoveControl.tick} compiles to; a player body (later) writes the same fields plus
 * {@code setSprinting}/{@code setShiftKeyDown}. Both feed the shared {@code LivingEntity.travel()},
 * so physics stays authentic — nothing here sets velocity directly except a leap's launch impulse.
 *
 * <p>Capabilities are per-body flags: the search may only plan what THIS body can actuate.
 */
public interface NavBody extends NavPhysique {

    /** Current yaw in degrees (the driver rot-lerps toward its desired heading). */
    float yRot();

    /** Current look pitch in degrees (vanilla convention, positive = down) — the driver rot-lerps
     *  gaze the same way it rot-lerps heading. A body that never actuates pitch reports level. */
    default float xRot() {
        return 0.0F;
    }

    /**
     * One tick of steering input. {@code yawDegrees} is the desired heading (the sink applies its own
     * turn-rate limit); {@code speedModifier} scales the body's MOVEMENT_SPEED attribute exactly as a
     * vanilla MoveControl speed modifier does — 0 means stand still; {@code jump} requests a jump
     * through the body's jump control (applied on the next control tick, ignored while airborne);
     * {@code sprint} holds the sprint flag (the speed-attribute modifier), used through a leap.
     */
    void driveInput(float yawDegrees, float speedModifier, boolean jump, boolean sprint);

    /**
     * The WIDENED input frame (world-model DESIGN.md §9 Phase 3): analog forward and strafe in
     * {@code [-1,1]}, sneak, plus the jump/sprint flags — and, since the second slice, the LOOK
     * half of the client frame: {@code pitchDegrees} is the requested look pitch (vanilla
     * convention, positive = down), making the dry frame carry the same rotation pair the wet
     * frame ({@link #driveSwim}) always had. The DRIVER rate-limits rotation (its rot-lerp is the
     * look-delta bound); the sink actuates the request. The default narrows to
     * {@link #driveInput} (pitch, strafe and sneak dropped), so substrate sinks that predate the
     * widening keep their exact behaviour; a body that actuates the extra channels overrides this
     * AND {@link #canStrafeInput}.
     */
    default void driveMove(float yawDegrees, float pitchDegrees, float forward, float strafe,
                           boolean jump, boolean sneak, boolean sprint) {
        driveInput(yawDegrees, forward, jump, sprint);
    }

    /**
     * Does {@link #driveMove} actuate strafe/sneak for real? Callers with a sideways intent (the
     * reflex dodges) fall back to their legacy actuation when false, rather than issuing a frame
     * whose strafe channel would be silently dropped.
     */
    default boolean canStrafeInput() {
        return false;
    }

    /**
     * The one velocity write the driver may make: a leap's launch impulse (BOT_SURFACE_DESIGN.md
     * §11.6 decision 4 — deterministic ballistic launch; the sprint flag and sustained forward input
     * ride along for air acceleration and authenticity). A player body should eventually make this a
     * no-op and let sprint+jump inputs produce the arc for real.
     */
    void launch(double vx, double vy, double vz);

    // ---- capabilities ----------------------------------------------------------

    /** Widest gap (blocks of clear span) this body's leap actuation can cross. */
    int maxJumpGap();

    /** Player-only pose; a Mob body reports false and the search must not plan sneak edges. */
    default boolean canSneak() {
        return false;
    }

    /**
     * Can this body swim under its own power (§12.4)? False here so any body that has not wired a
     * {@link #driveSwim} sink keeps its old land-only behaviour rather than silently drifting.
     */
    default boolean canSwim() {
        return false;
    }

    /**
     * The <b>swim input frame</b> — the wet sibling of {@link #driveInput}. Vanilla's
     * {@code LivingEntity.travelInWater} feeds the whole input vector through
     * {@code Entity.getInputVector}, which rotates x/z by yaw but passes <b>y straight through</b>: so
     * 3D swimming is exactly heading + forward + a vertical thrust, and needs no velocity writes at
     * all. {@code pitch} is not propulsion in that path — it is aim, and it matters anyway, because a
     * sprint-swimming player's look vector pulls it vertically ({@code Player.travel}) and because
     * every perception read comes from this body's eye.
     *
     * @param yawDegrees   desired heading
     * @param pitchDegrees desired pitch (negative = up, vanilla's convention)
     * @param forward      forward impulse along the heading (0 = no horizontal thrust)
     * @param vertical     vertical thrust (+1 = rise, -1 = dive, 0 = neutral buoyancy drift)
     * @param sprintSwim   hold the sprint-swim (dolphin) pose — faster, and it commits the look vector
     */
    default void driveSwim(float yawDegrees, float pitchDegrees, float forward, float vertical,
                           boolean sprintSwim) {
        driveInput(yawDegrees, forward, false, false);
    }

    /** Is the body in water right now — the driver's cue to swim rather than walk. */
    default boolean inWater() {
        return false;
    }

    /** Is the body's HEAD under water — i.e. is it spending air rather than merely wading? */
    default boolean submerged() {
        return false;
    }

    /**
     * Is the column at {@code (x,z)} water this body may swim in? The counterpart to
     * {@link #footingAt} for the driver's edge care: a swimmable column is not a void to freeze at,
     * it is a medium to enter. Without this the edge-care hold (§11.7) stops a swimming body dead at
     * every shoreline, because {@code LiquidBlock.isPathfindable} reports water as passable and so
     * "no footing" — the freeze that left a live goal waiting forever.
     */
    default boolean swimmableAt(double x, double z) {
        return false;
    }

    /** Player-only movement; a Mob body reports false. */
    default boolean canElytra() {
        return false;
    }

    /**
     * Does this body's leap need a RUN-UP — i.e. is its jump range a function of the momentum it
     * carries into take-off? False for a body whose {@link #launch} writes the arc directly (the Mob
     * walker's ballistic impulse overwrites velocity, so the approach speed is irrelevant); true for
     * one that jumps with real engine physics, where the vanilla sprint-jump boost is added to
     * existing momentum and a body that strolls to the lip falls short.
     *
     * <p>Measured, not assumed (BOT_SURFACE_DESIGN.md §11.8): the player body walked to the edge and
     * cleared 3.0 blocks of a 3-block gap, landing 0.3 short against the far face. This is the
     * per-body half of the §11.6 decision-4 split — the shared edge model says WHERE to jump, the
     * body says what its actuation needs to get there.
     */
    default boolean leapNeedsRunUp() {
        return false;
    }

    /**
     * Live footing check for the DRIVER, not the search: is there something solid to catch the body at
     * horizontal {@code (x,z)} within a survivable step-down of its current feet? The driver reads this
     * a step ahead of itself and refuses to drive forward off an unsupported lip that path-following
     * momentum would otherwise carry it over — a mid-bridge void, the trench edge it is bridging
     * (BOT_SURFACE_DESIGN.md §11.7, the driver-edge-fall fix). A body with no live world — a
     * {@link SyntheticPhysique} never drives — reports {@code true}; the search already refused
     * unsupported cells, so only a real driven body needs this.
     */
    default boolean footingAt(double x, double z) {
        return true;
    }
}
