package com.mattmc.mcptoolkit.drone;

import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.EventLog;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;

/**
 * The drone's derived observation events — the "what changed near my sensor" layer on top of the raw
 * perception tools (ARCHITECTURE.md, roadmap step 3). Diffs the entity population around the active drone
 * a few times per second and emits transitions into the {@link EventLog}:
 * <ul>
 *   <li>{@code entity_entered_radius} / {@code entity_left_radius} — with enter/leave hysteresis
 *       ({@value #ENTER_RADIUS}/{@value #LEAVE_RADIUS} blocks) so boundary-hovering mobs don't flap;</li>
 *   <li>{@code nearest_threat_changed} — on threat <em>identity</em> changes only (or {@code cleared}),
 *       never per-tick distance updates.</li>
 * </ul>
 *
 * <p>Precise semantics: "entered" means <em>became observable from the drone</em> — including entities
 * already present when the drone spawns — not "appeared in the world". Tracked kinds: <b>living entities
 * only</b> (arrows/orbs/etc. were always noise at event level; the raw tools still see them).
 *
 * <p><b>Dropped items were removed from the vocabulary in 0.42.0</b> and the reason is worth keeping:
 * a player body auto-collects, so every block it mines produced TWO events — an
 * {@code entity_entered_radius} when the drop appeared and an {@code entity_left_radius} when the body
 * walked over it. Thirty blocks of mining meant sixty events of pure self-noise, and because a paged
 * read is oldest-first, that noise is exactly what a {@code body_endangered} ends up queued behind. An
 * event stream's scarcest resource is the reader's attention, and items spend it on the agent's own
 * footsteps. Items are still perceived — {@code sense_entities} sees them, and the body's inventory is
 * the ground truth for the ones it picked up. One observer
 * instance per drone slot ({@link DroneTools.Slot}): with per-session drones each session gets its own
 * observation stream, and the emitted events are targeted at the owning session (broadcast for the
 * anonymous legacy slot). When the drone is removed the state clears silently — {@code drone_removed}
 * already tells that story, a flush of leave events would only bury it.
 */
final class DroneObserver {

    /** Entities within this range (blocks, from the drone's eye) are observable. */
    private static final double ENTER_RADIUS = 24.0;
    /** Leave threshold sits outside the enter threshold so boundary jitter doesn't flap events. */
    private static final double LEAVE_RADIUS = 26.0;
    /** Diff cadence in ticks — 4×/second is plenty for events; the raw tools give instant reads. */
    private static final int SCAN_INTERVAL = 5;

    private record Tracked(String type, String name) {}

    /** Session id these observation events are targeted at; null = broadcast (anonymous slot). */
    private final @Nullable String target;
    private final Map<UUID, Tracked> tracked = new HashMap<>();
    private @Nullable UUID nearestThreat;
    /** Perceived-mode diff state (SURVIVAL_SENSES_DESIGN.md §2.3) — belief ids, not uuids. */
    private final Map<Integer, Tracked> trackedBeliefs = new HashMap<>();
    private @Nullable Integer nearestBelievedThreat;
    private int tickCounter;
    /**
     * What the LAST ANNOUNCED nearest threat was — species and range. Identity alone is too twitchy
     * a trigger: four zombies at the same distance swap places every scan, and the urgent lane
     * (which nothing else may reorder) filled with a ping-pong of the same fact. A re-announcement
     * has to say something new: a different KIND of enemy, or a meaningful change in range.
     */
    private @Nullable String announcedThreatType;
    private double announcedThreatDist = Double.NaN;
    /** Entity id of the body this observer last ticked for — see the reset in {@link #tick}. */
    private int lastBodyId = -1;

    /** Range change (blocks) that makes the same species worth re-announcing. */
    private static final double THREAT_HYSTERESIS = 2.0;

    DroneObserver(final @Nullable String target) {
        this.target = target;
    }

    /** Called every server tick by {@link DroneTools} with the session's active body (drone or
     * possessed mob); internally rate-limited to {@link #SCAN_INTERVAL}. In perceived mode
     * ({@code bot_profile perception:"perceived"}) the diff source is the belief store, not a scan —
     * see {@link #perceivedTick}. */
    void tick(final DroneTools.Slot slot, final net.minecraft.world.entity.@Nullable LivingEntity body) {
        if (body == null) {
            reset();
            return;
        }
        // A DIFFERENT BODY HAS PERCEIVED NOTHING. Diff state is about one body's experience — what it
        // has seen enter, and what it was last told is hunting it — so carrying it across a
        // replacement makes the new body's first observations read as "no change". Live-caught by
        // the 0.50.0 probe run: a fresh body standing six blocks from a zombie was told nothing,
        // because the PREVIOUS body had been told "zombie, 5 blocks" and the new threat fell inside
        // the announcement hysteresis. The null-body path above only resets when a tick actually
        // lands between despawn and spawn, which a same-tick replacement never gives it.
        if (lastBodyId != body.getId()) {
            reset();
            lastBodyId = body.getId();
        }
        if (++tickCounter % SCAN_INTERVAL != 0) {
            return;
        }
        if (slot.perceivedMode && slot.perception != null) {
            perceivedTick(slot.perception, body);
        } else {
            authoritativeTick(body);
        }
    }

    /** The original radius diff — deliberately X-ray (the copilot's sensor). */
    private void authoritativeTick(final LivingEntity body) {
        if (!trackedBeliefs.isEmpty() || nearestBelievedThreat != null) {
            trackedBeliefs.clear(); // mode switched away from perceived — that diff's state is stale
            nearestBelievedThreat = null;
        }

        ServerLevel level = (ServerLevel) body.level();
        Vec3 eye = body.getEyePosition();
        AABB box = new AABB(eye, eye).inflate(LEAVE_RADIUS);
        List<Entity> near = level.getEntities(body, box,
            e -> e instanceof LivingEntity && e.isAlive() && !e.isSpectator());

        Map<UUID, Double> inRange = new HashMap<>();
        Entity bestThreat = null;
        double bestThreatDist = Double.MAX_VALUE;
        for (Entity e : near) {
            double dist = e.position().distanceTo(eye);
            if (dist > LEAVE_RADIUS) {
                continue; // corner of the AABB beyond the sphere
            }
            inRange.put(e.getUUID(), dist);
            if (dist > ENTER_RADIUS) {
                continue; // hysteresis band: keeps tracked entities, admits no new ones
            }
            if (!tracked.containsKey(e.getUUID())) {
                tracked.put(e.getUUID(), new Tracked(typeOf(e), nameOf(e)));
                JsonObject d = base();
                d.addProperty("radius", ENTER_RADIUS);
                d.add("entity", describe(e, dist));
                EventLog.emit("entity_entered_radius", d, target);
            }
            if (e instanceof Enemy && dist < bestThreatDist) {
                bestThreat = e;
                bestThreatDist = dist;
            }
        }

        // Leave events: tracked entities now gone (dead/unloaded) or beyond the leave threshold.
        Iterator<Map.Entry<UUID, Tracked>> it = tracked.entrySet().iterator();
        while (it.hasNext()) {
            Map.Entry<UUID, Tracked> entry = it.next();
            if (inRange.containsKey(entry.getKey())) {
                continue;
            }
            it.remove();
            JsonObject d = base();
            d.addProperty("radius", LEAVE_RADIUS);
            JsonObject ent = new JsonObject();
            ent.addProperty("uuid", entry.getKey().toString());
            ent.addProperty("type", entry.getValue().type());
            if (!isDefaultName(entry.getValue().name(), entry.getValue().type())) {
                ent.addProperty("name", entry.getValue().name());
            }
            d.add("entity", ent);
            EventLog.emit("entity_left_radius", d, target);
        }

        // Nearest-threat identity change (or cleared). Distance drift alone never re-fires.
        UUID threatId = bestThreat == null ? null : bestThreat.getUUID();
        boolean identityChanged = !Objects.equals(threatId, nearestThreat);
        nearestThreat = threatId;
        if (identityChanged && worthAnnouncing(bestThreat == null ? null : typeOf(bestThreat),
                bestThreatDist)) {
            JsonObject d = base();
            if (bestThreat == null) {
                d.addProperty("cleared", true);
            } else {
                JsonObject t = describe(bestThreat, bestThreatDist);
                t.addProperty("bearing", bearing(body, bestThreat.getX(), bestThreat.getZ()));
                d.add("threat", t);
            }
            EventLog.emit("nearest_threat_changed", d, target);
        }
    }

    /**
     * Does this nearest-threat change carry news? Hysteresis over the announced state, not over the
     * tracked one: the tracked identity still updates every scan (so a real swap is never lost), but
     * the urgent lane only hears about a different SPECIES or a range that moved more than
     * {@link #THREAT_HYSTERESIS}. Clearing always announces — "nothing is hunting you" is the one
     * transition that can never be inferred from silence.
     */
    private boolean worthAnnouncing(final @Nullable String type, final double dist) {
        if (type == null) {
            boolean news = announcedThreatType != null;
            announcedThreatType = null;
            announcedThreatDist = Double.NaN;
            return news;
        }
        boolean news = !type.equals(announcedThreatType)
            || Double.isNaN(announcedThreatDist)
            || Math.abs(dist - announcedThreatDist) > THREAT_HYSTERESIS;
        if (news) {
            announcedThreatType = type;
            announcedThreatDist = dist;
        }
        return news;
    }

    /**
     * Which way to turn, in the body's own frame: ahead / right / behind / left. A distance without
     * a direction is half an instruction, and the body cannot read its own yaw off a coordinate
     * triple without a round trip it does not have time for when this event fires.
     */
    private static String bearing(final LivingEntity body, final double x, final double z) {
        double rel = Math.toDegrees(Math.atan2(z - body.getZ(), x - body.getX())) - 90.0
            - body.getYRot();
        rel = ((rel % 360.0) + 540.0) % 360.0 - 180.0; // wrap to (-180, 180]
        double a = Math.abs(rel);
        if (a <= 45.0) {
            return "ahead";
        }
        if (a >= 135.0) {
            return "behind";
        }
        return rel > 0 ? "right" : "left";
    }

    /**
     * SURVIVAL_SENSES_DESIGN.md §2.3 — in perceived mode the observer CONSUMES the belief store
     * instead of running its own radius scan. The radius diff is X-ray (24 blocks, no FOV, no line
     * of sight): under the survival profile it announced entities <em>behind walls</em>, straight
     * into the session's context — the reflex door was made perception-legal ({@code bot_profile
     * perceived}) but the event door never was. Here "entered" = a belief newly exists (the body
     * first perceived it), "left" = the belief left the percept tier (aged out, refuted, or watched
     * die — the fate rides the event as {@code reason}), and the nearest threat is the nearest
     * <em>believed</em> hostile. No hysteresis: the percept tier's decay window already debounces.
     * Events carry {@code id} (the belief identity, same as {@code sense_entities} rows), not uuid —
     * the store holds no uuids, and inventing a second identity would unlink the two reads.
     */
    private void perceivedTick(final Perception.Store store, final LivingEntity body) {
        if (!tracked.isEmpty() || nearestThreat != null) {
            tracked.clear(); // mode switched away from authoritative — that diff's state is stale
            nearestThreat = null;
        }
        Vec3 eye = body.getEyePosition();

        Perception.Belief bestThreat = null;
        double bestThreatDist = Double.MAX_VALUE;
        Set<Integer> current = new HashSet<>();
        for (Perception.Belief b : store.beliefs.values()) {
            current.add(b.id);
            double dist = eye.distanceTo(new Vec3(b.x, b.y, b.z));
            if (!trackedBeliefs.containsKey(b.id) && !b.projectile) {
                trackedBeliefs.put(b.id, new Tracked(b.type, b.type));
                JsonObject d = senseBase();
                d.add("entity", describeBelief(b, dist));
                EventLog.emit("entity_entered_radius", d, target);
            }
            if (b.hostile && dist < bestThreatDist) {
                bestThreat = b;
                bestThreatDist = dist;
            }
        }

        Iterator<Map.Entry<Integer, Tracked>> it = trackedBeliefs.entrySet().iterator();
        while (it.hasNext()) {
            Map.Entry<Integer, Tracked> entry = it.next();
            if (current.contains(entry.getKey())) {
                continue;
            }
            it.remove();
            JsonObject d = senseBase();
            JsonObject ent = new JsonObject();
            ent.addProperty("id", entry.getKey());
            ent.addProperty("type", entry.getValue().type());
            d.add("entity", ent);
            // Why it left the percept tier, when the store still knows: lost|gone|died (§2.2).
            Perception.Remembered m = store.remembered.get(entry.getKey());
            d.addProperty("reason", m != null ? m.fate : "unperceived");
            EventLog.emit("entity_left_radius", d, target);
        }

        Integer threatId = bestThreat == null ? null : bestThreat.id;
        boolean identityChanged = !Objects.equals(threatId, nearestBelievedThreat);
        nearestBelievedThreat = threatId;
        if (identityChanged && worthAnnouncing(bestThreat == null ? null : bestThreat.type,
                bestThreatDist)) {
            JsonObject d = senseBase();
            if (bestThreat == null) {
                d.addProperty("cleared", true);
            } else {
                JsonObject t = describeBelief(bestThreat, bestThreatDist);
                t.addProperty("bearing", bearing(body, bestThreat.x, bestThreat.z));
                d.add("threat", t);
            }
            EventLog.emit("nearest_threat_changed", d, target);
        }
    }

    private static JsonObject senseBase() {
        JsonObject d = new JsonObject();
        d.addProperty("observer", "senses"); // the body's own perception, not the X-ray radius scan
        return d;
    }

    /** The belief as an event carries it — same trim rules as {@link #describe}, `channel` instead
     *  of a name (the store holds no display names; seen|heard is the fact worth a field). */
    private static JsonObject describeBelief(final Perception.Belief b, final double dist) {
        JsonObject o = new JsonObject();
        o.addProperty("id", b.id);
        o.addProperty("type", b.type);
        o.addProperty("channel", b.channel);
        o.addProperty("distance", Math.round(dist * 10.0) / 10.0);
        JsonObject pos = new JsonObject();
        pos.addProperty("x", Math.round(b.x * 10.0) / 10.0);
        pos.addProperty("y", Math.round(b.y * 10.0) / 10.0);
        pos.addProperty("z", Math.round(b.z * 10.0) / 10.0);
        o.add("pos", pos);
        return o;
    }

    /** Clear all observation state (drone gone or replaced — the new drone re-observes from scratch). */
    void reset() {
        tracked.clear();
        nearestThreat = null;
        trackedBeliefs.clear();
        nearestBelievedThreat = null;
        announcedThreatType = null;
        announcedThreatDist = Double.NaN;
        lastBodyId = -1;
    }

    private static JsonObject base() {
        JsonObject d = new JsonObject();
        d.addProperty("observer", "drone");
        return d;
    }

    /**
     * The entity as an event carries it. Trimmed 2026-08-01 after a live page measured 323 bytes for
     * "a tropical fish appeared 24 blocks away":
     * <ul>
     *   <li><b>{@code name} only when it says something {@code type} does not</b> — a vanilla mob's
     *       display name is just its type prettified ("Tropical Fish" / minecraft:tropical_fish), so
     *       it was a second copy of the same fact on every row. A NAMED entity (name tag, a player,
     *       a custom mob) still carries it, which is exactly when it matters.</li>
     *   <li><b>one decimal on distance and position</b> — this is a proximity notification, not a
     *       survey; millimetre precision on a moving mob is noise that is stale next tick anyway.
     *       {@code sense_entities} remains the read for exact positions.</li>
     * </ul>
     * {@code uuid} stays: it is the only stable identity across the enter/leave pair.
     */
    private static JsonObject describe(final Entity e, final double dist) {
        JsonObject o = new JsonObject();
        o.addProperty("uuid", e.getUUID().toString());
        String type = typeOf(e);
        o.addProperty("type", type);
        String name = nameOf(e);
        if (!isDefaultName(name, type)) {
            o.addProperty("name", name);
        }
        o.addProperty("distance", Math.round(dist * 10.0) / 10.0);
        JsonObject pos = new JsonObject();
        pos.addProperty("x", Math.round(e.getX() * 10.0) / 10.0);
        pos.addProperty("y", Math.round(e.getY() * 10.0) / 10.0);
        pos.addProperty("z", Math.round(e.getZ() * 10.0) / 10.0);
        o.add("pos", pos);
        return o;
    }

    /**
     * Is this display name merely the type restated? Compared on letters only, so "Tropical Fish"
     * matches minecraft:tropical_fish without depending on how vanilla capitalises or spaces it.
     */
    private static boolean isDefaultName(final String name, final String type) {
        String path = type.contains(":") ? type.substring(type.indexOf(':') + 1) : type;
        return squash(name).equals(squash(path));
    }

    private static String squash(final String s) {
        StringBuilder b = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = Character.toLowerCase(s.charAt(i));
            if (c >= 'a' && c <= 'z') {
                b.append(c);
            }
        }
        return b.toString();
    }

    private static String typeOf(final Entity e) {
        return BuiltInRegistries.ENTITY_TYPE.getKey(e.getType()).toString();
    }

    private static String nameOf(final Entity e) {
        return e.getDisplayName() == null ? e.getType().toShortString() : e.getDisplayName().getString();
    }
}
