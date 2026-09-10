package com.mattmc.mcptoolkit.drone;

import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.EventLog;
import net.minecraft.commands.arguments.EntityAnchorArgument;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Mob;
import org.jspecify.annotations.Nullable;

/**
 * Follow mode: a continuous behavior the agent sets once and Java renders every tick — the drone (or
 * possessed body) tails a moving target with automatic re-pathing and camera aim, instead of the agent
 * re-issuing {@code bot_goto} per correction (the "action_superseded while tailing a moving target"
 * loop the goto docs used to apologize for). One {@code bot_follow} call establishes the mode; the
 * agent is free to think while the body keeps station.
 *
 * <p>Look modes: {@code target} — aim the eye at the target (camera-follow); {@code mirror} — copy the
 * target's yaw/pitch, so combined with the behind-the-shoulder anchor a perception read/screenshot from
 * the body approximates what a player is looking at; {@code forward} — leave facing to navigation.
 *
 * <p>The mode ends on: an explicit {@code stop}, a manual {@code bot_goto}/{@code bot_run} (explicit
 * commands win), or the target dying/unloading — the latter emits {@code follow_lost {reason}} so the
 * agent hears about it without polling.
 */
final class Follow {

    /** Horizontal drift before we re-path, in blocks — small enough to track, big enough not to jitter. */
    private static final double REPATH_DISTANCE = 1.75;
    /** Minimum ticks between re-paths. */
    private static final int REPATH_INTERVAL = 5;

    final Entity target;
    final double distance;
    final double height;
    final String look; // target | mirror | forward
    private int repathCooldown;

    Follow(final Entity target, final double distance, final double height, final String look) {
        this.target = target;
        this.distance = distance;
        this.height = height;
        this.look = look;
    }

    /** Advance the slot's follow mode one tick (no-op when none). Server thread, from the tick watch. */
    static void tick(final DroneTools.Slot slot) {
        Follow f = slot.follow;
        if (f == null) {
            return;
        }
        LivingEntity body = slot.activeBody();
        if (body == null) {
            slot.follow = null;
            lost(slot, f, "no_body");
            return;
        }
        if (f.target.isRemoved() || !f.target.isAlive()) {
            slot.follow = null;
            lost(slot, f, "target_" + Actuator.removalWord(f.target));
            return;
        }
        if (f.target.level() != body.level()) {
            slot.follow = null;
            lost(slot, f, "target_changed_dimension");
            return;
        }

        // Station-keeping anchor. Mirror mode hangs behind the target's shoulder (so its view approximates
        // the target's); the other modes hold range on whichever side the body already is (no orbiting).
        net.minecraft.world.phys.Vec3 targetPos = f.target.position();
        net.minecraft.world.phys.Vec3 side;
        if ("mirror".equals(f.look)) {
            net.minecraft.world.phys.Vec3 view = f.target.getViewVector(1.0F);
            side = new net.minecraft.world.phys.Vec3(view.x, 0, view.z);
            side = side.lengthSqr() < 1.0e-6 ? new net.minecraft.world.phys.Vec3(0, 0, 1) : side.normalize().scale(-1);
        } else {
            side = body.position().subtract(targetPos);
            side = new net.minecraft.world.phys.Vec3(side.x, 0, side.z);
            side = side.lengthSqr() < 1.0e-6 ? new net.minecraft.world.phys.Vec3(1, 0, 0) : side.normalize();
        }
        net.minecraft.world.phys.Vec3 anchor = targetPos.add(side.scale(f.distance)).add(0, f.height, 0);

        if (f.repathCooldown > 0) {
            f.repathCooldown--;
        }
        double drift = body.position().distanceTo(anchor);
        if (drift > REPATH_DISTANCE && f.repathCooldown == 0) {
            // DEFAULT: following a target is not a caller-profiled route — it may swim, like the body itself.
            Bodies.nav(body).moveTo(anchor.x, anchor.y, anchor.z, 1.0,
                com.mattmc.mcptoolkit.nav.NavProfile.DEFAULT);
            f.repathCooldown = REPATH_INTERVAL;
        } else if (drift <= REPATH_DISTANCE && !Bodies.nav(body).isDone()) {
            Bodies.nav(body).stop(); // on station: park instead of overshooting the anchor
        }

        switch (f.look) {
            case "mirror" -> {
                body.setYRot(f.target.getYRot());
                body.setXRot(f.target.getXRot());
                body.setYHeadRot(f.target.getYRot());
                body.setYBodyRot(f.target.getYRot());
            }
            case "forward" -> { /* navigation owns the facing */ }
            default -> body.lookAt(EntityAnchorArgument.Anchor.EYES, f.target.getEyePosition());
        }
    }

    /** Clear any follow mode without an event (an explicit command replaced it). */
    static void clear(final DroneTools.Slot slot) {
        slot.follow = null;
    }

    private static void lost(final DroneTools.Slot slot, final Follow f, final String reason) {
        if (slot.baseKind == DroneTools.BaseKind.FOLLOW) {
            slot.baseKind = DroneTools.BaseKind.IDLE; // the FOLLOW base intent ended
        }
        JsonObject d = new JsonObject();
        d.addProperty("reason", reason);
        d.addProperty("target_id", f.target.getId());
        EventLog.emit("follow_lost", d, slot.target());
    }

    static @Nullable JsonObject describe(final DroneTools.Slot slot) {
        Follow f = slot.follow;
        if (f == null) {
            return null;
        }
        JsonObject o = new JsonObject();
        o.addProperty("target_id", f.target.getId());
        o.addProperty("distance", f.distance);
        o.addProperty("height", f.height);
        o.addProperty("look", f.look);
        return o;
    }
}
