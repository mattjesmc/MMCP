package com.mattmc.mcptoolkit.nav;

import java.util.ArrayList;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.util.Mth;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.phys.Vec3;

/**
 * The ONE driver of BOT_SURFACE_DESIGN.md §11.2: follows waypoints against a {@link NavBody} by
 * emitting per-tick input frames, never caring what the body is made of. It reproduces the two
 * things vanilla {@code MoveControl.tick} did for a Mob — turn-rate-limited yaw plus forward impulse,
 * and the step-up jump — and adds the one thing no vanilla control has: a <b>leap</b> across a
 * planned sprint-jump gap (ballistic launch + held sprint/forward through the arc, §11.6 decision 4).
 *
 * <p>Stateless except for the leap: a leap owns the inputs from launch until touchdown, because
 * mid-air is exactly when waypoint-chasing logic would steer wrong (the arc must be flown straight).
 */
public final class NavDriver {

    /** Max yaw change per tick, degrees — MoveControl's rot-lerp limit. Public because the attack
     * gate ({@code drone.AttackGate}) turns the body toward its target at THIS rate, so combat
     * turns and steering turns share one motion vocabulary (V3_PLAN.md §2 F1). */
    public static final float TURN_RATE = 90.0F;
    /** Below this horizontal distance² to the waypoint, its direction is numeric noise — the body is
     * standing on it (usually pending a vertical advance) and atan2 of centimetre jitter swings the
     * heading wildly every tick. Holding the current yaw instead is what stops a held body spinning
     * in place (live 2026-08-02: a wedged body's unwrapped yaw reached -545,604°). 0.3 blocks —
     * well inside every follower's advance tolerance, so normal steering never sees it. */
    private static final double YAW_HOLD_SQ = 0.09;
    /** Ballistic launch constants: vanilla jump velocity up, horizontal speed sized to cover the
     * span over the ~12 airborne ticks under 0.91/tick air drag (live-tuned 0.17.0: the original
     * 0.14/0.62 undershot the max-range 5-block landing into the gap — measured, not modeled). */
    private static final double LAUNCH_VY = 0.42;
    private static final double LAUNCH_SPEED_PER_BLOCK = 0.15;
    private static final double LAUNCH_SPEED_MAX = 0.68;
    /** Don't leap while the landing is farther than the actuation can carry (+margin): keep walking
     * toward the gap edge first. Without this gate the leap fires the moment the landing becomes the
     * next waypoint — possibly a full cell before the edge, wasting range the max-range jump needs. */
    private static final double LEAP_TRIGGER_MARGIN = 0.2;
    /** How far ahead of the body centre (blocks, along the heading) the driver probes for footing
     * before committing forward input. Half the body width (~0.3) plus a stopping margin, so the
     * leading face never crosses an unsupported lip before the hold takes hold. */
    private static final double EDGE_LOOKAHEAD = 0.7;
    /** A leap that hasn't landed after this many ticks is over regardless (fell, clipped a wall). */
    private static final int LEAP_TIMEOUT_TICKS = 40;
    /** Forward input while creeping to an unsupported lip SNEAKING (world-model DESIGN.md §9
     * Phase 3, the sneak author): vanilla's sneak-clip stops a crouched body at the edge of its
     * support, so the creep keeps the edge-care hold's guarantee — the body cannot go over — while
     * finally driving the sneak channel with real frames. Low, so friction still settles the body
     * within the lip cell rather than pressing the clip at speed. */
    private static final float CREEP_INPUT = 0.3F;
    /** How far ahead the SNEAK decision probes for footing — deliberately longer than
     * {@link #EDGE_LOOKAHEAD}: goals complete on their arrival tolerance BEFORE the body ever
     * enters the 0.7 hold zone (measured 2026-08-09: a full lips-lane round + the creep probe
     * recorded ZERO sneak frames — the author existed and never fired). The crouch has to start
     * where a careful player starts it: a body-length out, not at the last centimetre. */
    private static final double SNEAK_LOOKAHEAD = 1.2;
    /** Gaze pitch clamp, degrees: a walking body watches its feet (§13.2's gait-fan rationale made
     * an ACTUATED look), but never stares straight down at its own boots or up past the horizon
     * more than a path can warrant. */
    private static final float GAZE_PITCH_MAX = 60.0F;

    private boolean leaping;
    private Vec3 leapTarget = Vec3.ZERO;
    private int leapTicks;
    /**
     * Sprint EVERY forward frame of the current navigation, not just jump run-ups — fight-mode
     * repositioning sets this (V3_PLAN.md §2 F4: a kite that walks cannot open distance from a
     * zombie, live-proven). Off by default; the body sink still applies the vanilla client's own
     * sprint gate (forward motion, not sneaking), so this can never produce an illegal input.
     */
    private boolean sprintAll;
    /**
     * Does the CURRENT navigation grant the swim right ({@code NavProfile.canSwim})?
     *
     * <p><b>Why the driver needs its own copy.</b> Every swim decision here used to ask
     * {@link NavBody#canSwim()}, which is the body's INTRINSIC ability — hardcoded {@code true} on
     * the player body and the walker. The planner, meanwhile, asks the per-call profile. So
     * {@code swim:false} routed around water and then, the moment the body touched water for any
     * reason the plan did not intend (a slope run-out, a short leap, a shoreline waypoint), the
     * driver switched to the swim frame and thrust it in — including diving, since the swim frame
     * has a vertical component. That is how a "reach the shore, no swimming" goal walked a player
     * body into deep water and drowned it (2026-08-01 watched run).
     *
     * <p>Default {@code true} so a driver that is never told keeps the old behaviour, which is also
     * the right default: refusing to swim is the surprising request, not the ordinary one.
     */
    private boolean swimAllowed = true;
    /** The wet input frame + the air budget (§12.4); consulted whenever the body is in water. */
    private final SwimControl swim = new SwimControl();
    /**
     * VERIFIED landings of every leap this driver actuated — self-initiated while path-following
     * and externally requested via {@link #leap} alike. Recorded at TOUCHDOWN within range of the
     * planned landing, never at launch: the ledger's contract is "a real completed act, never a
     * prediction", and an undershoot into the gap is not a jump that happened. The goal loop drains
     * these for disclosure and logs nothing at actuation, so no jump is double-counted.
     */
    private final List<BlockPos> selfLeaps = new ArrayList<>();

    /**
     * Tell the driver which swim right the navigation it is about to follow was PLANNED with. Called
     * by the navigation when it accepts a path, so the steering and the plan agree about water.
     */
    public void setSwimAllowed(final boolean allowed) {
        this.swimAllowed = allowed;
    }

    /** Hold sprint through every forward frame (fight-mode repositioning). Sticky until changed —
     *  the caller that turns it on owns turning it off (Engage does both). */
    public void setSprintAll(final boolean on) {
        this.sprintAll = on;
    }

    /**
     * May this body swim RIGHT NOW — intrinsic ability AND the current navigation's grant. The only
     * question the driver should ever ask about water; see {@link #swimAllowed}.
     */
    private boolean canSwim(final NavBody body) {
        return swimAllowed && body.canSwim();
    }

    /** True while a leap owns the body's inputs (callers should not steer past it). */
    public boolean isLeaping() {
        return leaping;
    }

    /** True while the swim control has the body off its route to breathe (§12.4). */
    public boolean isSurfacing() {
        return swim.surfacing();
    }

    /**
     * One steering tick toward {@code waypoint}. {@code jumpWaypoint} marks the waypoint as a planned
     * sprint-jump landing (from the evaluator's plan): the driver leaps when it reaches the take-off
     * edge instead of walking off it.
     */
    public void steer(final NavBody body, final Vec3 waypoint, final double speedModifier,
                      final boolean jumpWaypoint) {
        steer(body, waypoint, speedModifier, jumpWaypoint, false);
    }

    /**
     * As above, with {@code approachingJump} telling the driver that a planned jump landing is a few
     * nodes ahead — the caller reads that off the path, which the driver (a one-waypoint-at-a-time
     * steerer) cannot see. It exists for the run-up: by the time the landing IS the next waypoint the
     * leap gate fires in the same tick, so a body that needs momentum has to start sprinting before
     * then. Bodies whose leap is a velocity write ignore it (see {@link NavBody#leapNeedsRunUp}).
     */
    public void steer(final NavBody body, final Vec3 waypoint, final double speedModifier,
                      final boolean jumpWaypoint, final boolean approachingJump) {
        if (leaping) {
            airborneTick(body);
            return;
        }

        // The perturbation hijack (V3_PLAN.md §4.3 tier 1): a dev-armed burst of random heading
        // owns this tick's inputs INSTEAD of the expert's steering, and records as actor 'perturb'
        // — off-distribution states, manufactured on purpose, so the expert's resume becomes the
        // recovery demonstration pure BC otherwise never has. Placed after the leap branch (an arc
        // must be flown straight) and before every other concern, because replacing the expert
        // this tick is the entire point. The budget lives in WmPerturb and expires on its own
        // clock, so nothing here can leave a body hijacked.
        com.mattmc.mcptoolkit.wm.WmPerturb.Step perturbation =
            com.mattmc.mcptoolkit.wm.WmPerturb.step(body);
        if (perturbation != null) {
            perturbTick(body, perturbation);
            return;
        }

        // In water the body does not walk, it swims — a different input frame entirely (yaw + forward
        // + a VERTICAL thrust, which walking has no notion of), and the only mode with an air budget.
        // Checked before every land concern below, because each of them is wrong when wet: the
        // step-up jump, the leap gate, and the edge-care hold all reason about ground that isn't there.
        if (canSwim(body) && body.inWater()) {
            // Actor labels (world-model DESIGN.md §13.3): swim is a separate control law and the
            // student must not clone an unlabeled mixture. Set before every drive, free when the
            // recorder is off.
            com.mattmc.mcptoolkit.wm.Wm.actor("swim");
            swim.tick(body, waypoint, speedModifier);
            return;
        }

        double dx = waypoint.x - body.x();
        double dz = waypoint.z - body.z();
        double dy = waypoint.y - body.y();
        double flatSq = dx * dx + dz * dz;

        if (jumpWaypoint && body.onGround() && flatSq > 1.6 * 1.6) {
            double gate = body.maxJumpGap() + LEAP_TRIGGER_MARGIN;
            if (flatSq <= gate * gate && readyToLeap(body, dx, dz, flatSq)) {
                leap(body, waypoint); // recorded at verified touchdown, not here
                return;
            }
            // Landing still beyond actuation range (or the take-off edge not yet reached): fall
            // through and WALK toward it — the gap edge is between here and there, and the gate
            // above fires before the body walks off it.
        }

        float desiredYaw = flatSq > YAW_HOLD_SQ
            ? (float) (Mth.atan2(dz, dx) * (180.0F / (float) Math.PI)) - 90.0F
            : body.yRot();
        float yaw = rotlerp(body.yRot(), desiredYaw, TURN_RATE);
        // The gaze author (world-model DESIGN.md §9 Phase 3 / §13.2): while walking, look AT the
        // waypoint — the "watch your feet" gaze the gait fan was built to legalize, now ACTUATED so
        // the gaze fan (which follows the look) sweeps the footing ahead instead of a stale
        // horizon. Rate-limited like the heading; held (like the yaw) when the waypoint is
        // underfoot and its direction is numeric noise. Narrow-frame bodies drop pitch at the sink.
        float desiredPitch = body.xRot();
        if (flatSq > YAW_HOLD_SQ) {
            double eyeY = body.y() + body.bbHeight() * 0.90;
            desiredPitch = Mth.clamp(
                (float) -Math.toDegrees(Math.atan2(waypoint.y - eyeY, Math.sqrt(flatSq))),
                -GAZE_PITCH_MAX, GAZE_PITCH_MAX);
        }
        float pitch = rotlerp(body.xRot(), desiredPitch, TURN_RATE);
        // Step-up: the path climbs more than the body can step and the ledge is underfoot — jump
        // (MoveControl's MOVE_TO condition, minus its partial-block special cases).
        boolean jump = dy > body.maxUpStep() && flatSq < Math.max(1.0F, body.bbWidth());

        // Edge care: hold at an unsupported lip instead of coasting off it. The search routes only
        // over solid ground, so a void a step ahead is never on the intended path — it is the end of
        // an in-progress bridge or a corner the straight-line steer would cut. Zeroing forward lets
        // travel()'s friction stop the body AT the edge; the goal loop then bridges the next cell and
        // the footing ahead goes solid, so this is also what paces place-step-place bridging. Skipped
        // for a jump waypoint (the leap gate above owns the approach to the take-off edge).
        float forward = (float) speedModifier;
        boolean sneak = false;
        if (forward > 0.0F && !jumpWaypoint && flatSq > 1.0e-6) {
            double inv = 1.0 / Math.sqrt(flatSq);
            double lookX = body.x() + dx * inv * EDGE_LOOKAHEAD;
            double lookZ = body.z() + dz * inv * EDGE_LOOKAHEAD;
            // The sneak author's gate (§9 Phase 3): sneak-capable, grounded, and no planned jump
            // anywhere ahead (the run-up must arrive sprinting — a creep would spend the momentum
            // the leap needs).
            boolean mayCreep = body.canSneak() && body.onGround() && !approachingJump;
            // A swimmable column is NOT an unsupported lip — it is the next medium. Without this
            // second clause the hold fired at every shoreline, because vanilla's
            // LiquidBlock.isPathfindable reports water as passable and footingAt therefore reads
            // deep water as "nothing to catch me". The body stopped at the water's edge with forward
            // zeroed, never reached the next node, and the navigation never finished: on the player
            // body, which has no stuck detection, that was the live hang.
            if (!body.footingAt(lookX, lookZ)
                && !(canSwim(body) && body.swimmableAt(lookX, lookZ))) {
                // At the lip itself: a creeping body ends ON the edge a careful player stands on
                // (sneak-clip enforces the old hold's cannot-go-over); every other body keeps the
                // exact old zeroed-forward hold.
                if (mayCreep) {
                    sneak = true;
                    forward = Math.min(forward, CREEP_INPUT);
                } else {
                    forward = 0.0F;
                }
            } else if (mayCreep) {
                // The approach: probe FURTHER than the hold does. Goals complete on their arrival
                // tolerance before the body ever enters the 0.7 hold zone, so a crouch that waits
                // for the hold never happens (measured: zero sneak frames from a full lips round).
                // A careful player starts the crouch a body-length out — so does the driver.
                double farX = body.x() + dx * inv * SNEAK_LOOKAHEAD;
                double farZ = body.z() + dz * inv * SNEAK_LOOKAHEAD;
                if (!body.footingAt(farX, farZ)
                    && !(canSwim(body) && body.swimmableAt(farX, farZ))) {
                    sneak = true;
                    forward = Math.min(forward, CREEP_INPUT);
                }
            }
        }
        // GAZE OWNERSHIP (V3_PLAN.md §2 F1, audit finding S2). An in-flight attack turn owns the
        // look, and this driver used to rewrite yaw/pitch on every driven frame from the path
        // heading — the gate turned at END_SERVER_TICK, this frame put the body back on the path
        // the next entity tick, and the swing gate re-evaluated from the path heading forever
        // (facing_timeout after 60 ticks, the live kite that died without landing a hit). ONE
        // owner: while the gate holds, the frame requests the body's CURRENT look and the route
        // goes into the LEGS instead — the path direction decomposed into the forward/strafe pair,
        // which is exactly how a player circles a mob with WASD while the mouse stays on it (and
        // it is what makes the turn's yaw the frame's yaw, so the recording stops claiming a
        // heading the body did not hold). A body with no strafe channel (the walker's narrow sink
        // drops it) keeps the forward projection alone: it loses the sideways component for the
        // ~2 ticks a 90°/tick turn takes, the honest cost of the gate being able to converge.
        // Not covered here, deliberately: the swim frame (yaw IS the thrust direction and there is
        // no strafe channel to hold the route with), the leap (an arc must be flown straight) and
        // the perturbation hijack (which owns the whole frame by construction). idle() already
        // holds the current yaw, so it never fought the gate.
        float strafe = 0.0F;
        if (body instanceof LivingEntity living
            && com.mattmc.mcptoolkit.drone.AttackGate.holdsGaze(living)) {
            yaw = body.yRot();
            pitch = body.xRot();
            if (forward != 0.0F) {
                double off = Math.toRadians(Mth.wrapDegrees(desiredYaw - yaw));
                // Vanilla's input frame: forward drives along the facing, strafe along facing+90°
                // (Entity.getInputVector). Projecting the desired heading onto that pair preserves
                // the input's magnitude, so the body walks the route at the commanded speed.
                strafe = (float) -Math.sin(off) * forward;
                forward = (float) Math.cos(off) * forward;
            }
        }
        // Run-up: a body whose leap is real physics rather than a velocity write must arrive at the
        // take-off edge ALREADY sprinting — vanilla's sprint-jump boost adds to existing momentum, so
        // strolling to the lip lands short (measured: 3.0 blocks of a 3-block gap). Only while the
        // approach is toward a planned jump landing, and only for bodies that say they need it, so a
        // ballistic-leap body's approach is byte-identical to before.
        boolean runUp = ((jumpWaypoint || approachingJump) && body.leapNeedsRunUp())
            || (sprintAll && forward > 0.0F && !sneak);
        com.mattmc.mcptoolkit.wm.Wm.actor("nav");
        // The widened frame carries the gaze and the creep; a narrow-frame body's default
        // driveMove narrows this to exactly the old driveInput call.
        body.driveMove(yaw, pitch, forward, strafe, jump, sneak, runUp);
    }

    /**
     * One hijacked tick (V3_PLAN.md §4.3 tier 1): drive the perturbation's random heading instead
     * of the route's, under the {@code perturb} actor label. Everything else the expert would have
     * done this tick — the gaze at the waypoint, the run-up sprint, the step-up jump — is dropped;
     * that IS the perturbation.
     *
     * <p>The edge-care hold is the one thing kept, deliberately. The point of a perturbation is to
     * leave the body in a state the expert must recover FROM; a body walked off a cliff ends the
     * episode instead of demonstrating the way back, and a recovery lane that kills its own
     * subject collects nothing. Same lookahead, same swimmable-column exception as {@link #steer}.
     */
    private void perturbTick(final NavBody body,
                             final com.mattmc.mcptoolkit.wm.WmPerturb.Step p) {
        com.mattmc.mcptoolkit.wm.Wm.actor("perturb");
        float yaw = rotlerp(body.yRot(), p.yaw(), TURN_RATE);
        if (canSwim(body) && body.inWater()) {
            // Wet ticks take the wet frame or the sink leaves walk inputs thrusting a swimming
            // body (the idle() lesson); a random heading perturbs either medium just as well.
            body.driveSwim(yaw, body.xRot(), p.forward(), 0.0F, false);
            return;
        }
        float forward = p.forward();
        // Heading → facing vector, vanilla's convention (yaw 0 = +z): (-sin, cos).
        double rad = Math.toRadians(yaw);
        double lookX = body.x() - Math.sin(rad) * EDGE_LOOKAHEAD;
        double lookZ = body.z() + Math.cos(rad) * EDGE_LOOKAHEAD;
        if (!body.footingAt(lookX, lookZ) && !(canSwim(body) && body.swimmableAt(lookX, lookZ))) {
            forward = 0.0F;
        }
        body.driveMove(yaw, body.xRot(), forward, 0.0F, p.jump(), false, false);
    }

    /**
     * May the body leap NOW, or should it keep walking to the lip first?
     *
     * <p>A ballistic-leap body may go the moment the landing is in range: its launch speed is sized
     * to the distance, so an early take-off just buys a bigger impulse. A body that leaps on real
     * physics has a FIXED arc, so every block it takes off early is a block of range thrown away —
     * measured (§11.8): the player body cleared 2.97 blocks of air whether it approached at a walk or
     * a sprint, because both times the in-range gate fired ~0.8 blocks before the edge; the run-up was
     * spent on ground it should have used to reach the lip. So a run-up body waits until there is no
     * footing ahead of it — which, over the void it is about to jump, is exactly the take-off edge.
     *
     * <p>If footing never disappears the leap simply does not fire and the body walks the route
     * instead; that is the honest outcome for a "jump" that turns out not to cross anything, and the
     * step-up jump in {@link #steer} still handles climbing.
     */
    private static boolean readyToLeap(final NavBody body, final double dx, final double dz,
                                       final double flatSq) {
        if (!body.leapNeedsRunUp()) {
            return true;
        }
        double inv = 1.0 / Math.sqrt(flatSq);
        return !body.footingAt(body.x() + dx * inv * EDGE_LOOKAHEAD,
                               body.z() + dz * inv * EDGE_LOOKAHEAD);
    }

    /**
     * Launch a leap toward {@code landing}: face it exactly, ballistic impulse, sprint+forward held
     * through the arc. Public so the goal loop's repair path can actuate a planned JUMP through the
     * same code that path-following uses — one leap, not two implementations.
     */
    public void leap(final NavBody body, final Vec3 landing) {
        com.mattmc.mcptoolkit.wm.Wm.actor("leap"); // launch ticks are open-loop, not nav policy (§13.3)
        double dx = landing.x - body.x();
        double dz = landing.z - body.z();
        double flat = Math.hypot(dx, dz);
        float yaw = (float) (Mth.atan2(dz, dx) * (180.0F / (float) Math.PI)) - 90.0F;
        double speed = Math.min(LAUNCH_SPEED_MAX, LAUNCH_SPEED_PER_BLOCK * Math.max(1.0, flat));
        double nx = flat < 1.0e-6 ? 0.0 : dx / flat;
        double nz = flat < 1.0e-6 ? 0.0 : dz / flat;
        body.driveInput(yaw, 1.0F, false, true);
        body.launch(nx * speed, LAUNCH_VY, nz * speed);
        leaping = true;
        leapTarget = landing;
        leapTicks = 0;
    }

    /** Mid-leap: hold the heading and the sprint/forward inputs; end on touchdown or timeout. */
    private void airborneTick(final NavBody body) {
        com.mattmc.mcptoolkit.wm.Wm.actor("leap");
        leapTicks++;
        // Splashdown ends a leap as surely as touchdown does. Without the water clause a body that
        // leapt into a river never reported onGround, so the arc ran to its 40-tick timeout with
        // sprint held — steering the body downstream the whole way.
        boolean landed = (body.onGround() || (canSwim(body) && body.inWater())) && leapTicks > 2;
        if (landed || leapTicks > LEAP_TIMEOUT_TICKS) {
            if (landed) {
                // Only a touchdown AT the landing is a jump that happened; coming down anywhere
                // else (undershoot into the gap, clipped a wall) is recorded nowhere — the honest
                // signal is the ledger entry that ISN'T there and the stall that follows.
                double ddx = body.x() - leapTarget.x;
                double ddz = body.z() - leapTarget.z;
                if (ddx * ddx + ddz * ddz <= 1.5 * 1.5 && Math.abs(body.y() - leapTarget.y) <= 1.0) {
                    selfLeaps.add(BlockPos.containing(leapTarget));
                }
            }
            leaping = false;
            body.driveInput(body.yRot(), 0.0F, false, false); // sprint off, stop; next tick re-steers
            return;
        }
        double dx = leapTarget.x - body.x();
        double dz = leapTarget.z - body.z();
        float yaw = (float) (Mth.atan2(dz, dx) * (180.0F / (float) Math.PI)) - 90.0F;
        body.driveInput(yaw, 1.0F, false, true);
    }

    /** Landings of self-initiated leaps since the last drain (see {@link #selfLeaps}). */
    public List<BlockPos> drainSelfLeaps() {
        if (selfLeaps.isEmpty()) {
            return List.of();
        }
        List<BlockPos> out = List.copyOf(selfLeaps);
        selfLeaps.clear();
        return out;
    }

    /** Stop: zero the inputs (the walker's MoveControl is inert, so nothing else would). */
    public void idle(final NavBody body) {
        // A zeroed frame is an ACTION, not an absence (the stale-yya lesson) — labeled as such.
        com.mattmc.mcptoolkit.wm.Wm.actor("idle");
        leaping = false;
        swim.reset(); // a new route must not inherit the last one's surfacing state
        if (canSwim(body) && body.inWater()) {
            // Zeroed WALK inputs leave zza/yya set from the swim frame, which would keep thrusting
            // an idle body across the water; the swim frame has to be zeroed by its own sink.
            body.driveSwim(body.yRot(), 0.0F, 0.0F, 0.0F, false);
            return;
        }
        body.driveInput(body.yRot(), 0.0F, false, false);
    }

    private static float rotlerp(final float current, final float desired, final float maxStep) {
        float delta = Mth.wrapDegrees(desired - current);
        if (delta > maxStep) {
            delta = maxStep;
        }
        if (delta < -maxStep) {
            delta = -maxStep;
        }
        // Wrapped so the stored yaw stays bounded: a body steered in circles used to accumulate
        // thousands of turns (live: -545,604°), where float resolution is ~0.03° and falling.
        return Mth.wrapDegrees(current + delta);
    }
}
