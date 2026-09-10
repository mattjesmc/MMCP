package com.mattmc.mcptoolkit.drone;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.phys.Vec3;

import java.util.ArrayDeque;
import java.util.Collection;
import java.util.HashMap;
import java.util.Map;

/**
 * The "is anything watchable happening" snapshot behind {@code GET /activity} — the OBS
 * record-supervisor's poll target. Built ON THE SERVER THREAD at the end of every
 * {@code DroneTools.tickWatch} pass (slot state is server-thread-only), published as one volatile
 * pre-serialized string so the HTTP handler is lock-free and never hops threads.
 *
 * <p>{@code busy} means a watcher would see something: an act in flight (dig — settle included —
 * nav, queue, goal, follow, fight, reflex, ceremony, chew, look sweep, a parked waiter) or real
 * displacement (&gt; {@link #MOVED_EPSILON} blocks over the last second). Idle thinking — a body
 * standing still with nothing in flight — is exactly what the recording should skip.
 */
public final class ActivitySnapshot {
    private ActivitySnapshot() {}

    /** Blocks moved over the trailing second below which a body counts as standing still. */
    private static final double MOVED_EPSILON = 0.5;
    private static final int TRAIL_TICKS = 20;

    private static volatile String json = "{\"tick\":0,\"busy\":false,\"sessions\":[]}";

    /** Per-session position ring (server thread only) — the "moved_last_sec" source. */
    private static final Map<String, ArrayDeque<Vec3>> TRAILS = new HashMap<>();

    /** The current snapshot as a JSON string — safe from any thread. */
    public static String json() {
        return json;
    }

    /** Rebuild — called at the end of tickWatch, server thread. */
    static void update(final Collection<DroneTools.Slot> slots, final long tick) {
        JsonObject root = new JsonObject();
        root.addProperty("tick", tick);
        JsonArray sessions = new JsonArray();
        boolean anyBusy = false;
        TRAILS.keySet().removeIf(owner -> slots.stream().noneMatch(s -> s.owner.equals(owner)));
        for (DroneTools.Slot slot : slots) {
            LivingEntity body = slot.activeBody();
            JsonArray holds = new JsonArray();
            if (slot.dig != null) {
                holds.add("dig");
            }
            if (slot.pendingNav != null) {
                holds.add("nav");
            }
            if (slot.queue != null) {
                holds.add("queue");
            }
            if (slot.goal != null) {
                holds.add("goal");
            }
            if (slot.follow != null) {
                holds.add("follow");
            }
            if (slot.combatHoldsBody) {
                holds.add("fight");
            }
            if (slot.active != null) {
                holds.add("reflex");
            }
            if (slot.ceremony != null) {
                holds.add("ceremony");
            }
            if (slot.chew != null) {
                holds.add("chew");
            }
            if (slot.look != null) {
                holds.add("look_sweep");
            }
            if (DroneTools.waiterParked(slot)) {
                holds.add("waiter");
            }
            double moved = 0;
            if (body != null) {
                ArrayDeque<Vec3> trail = TRAILS.computeIfAbsent(slot.owner, k -> new ArrayDeque<>());
                trail.addLast(body.position());
                while (trail.size() > TRAIL_TICKS + 1) {
                    trail.removeFirst();
                }
                moved = body.position().distanceTo(trail.getFirst());
            } else {
                TRAILS.remove(slot.owner);
                if (holds.isEmpty()) {
                    continue; // no body, nothing in flight — not a session worth reporting
                }
            }
            boolean busy = !holds.isEmpty() || moved > MOVED_EPSILON;
            anyBusy |= busy;

            JsonObject s = new JsonObject();
            s.addProperty("session", slot.owner);
            s.addProperty("body", body == null ? null
                : body instanceof FakePlayerEntity ? "player"
                : body instanceof BotBodyEntity ? "drone" : "possessed");
            s.addProperty("busy", busy);
            s.add("holds", holds);
            if (slot.dig != null) {
                s.addProperty("dig_eta_ticks", Math.max(0, slot.dig.remaining));
            }
            if (body != null) {
                JsonObject pos = new JsonObject();
                pos.addProperty("x", Math.round(body.getX() * 10.0) / 10.0);
                pos.addProperty("y", Math.round(body.getY() * 10.0) / 10.0);
                pos.addProperty("z", Math.round(body.getZ() * 10.0) / 10.0);
                s.add("pos", pos);
                s.addProperty("moved_last_sec", Math.round(moved * 10.0) / 10.0);
            }
            sessions.add(s);
        }
        root.addProperty("busy", anyBusy);
        root.add("sessions", sessions);
        json = root.toString();
    }
}
