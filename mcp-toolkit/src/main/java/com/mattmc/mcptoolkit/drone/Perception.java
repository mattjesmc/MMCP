package com.mattmc.mcptoolkit.drone;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.ExecutionContext;
import com.mattmc.mcptoolkit.McpTools;
import com.mattmc.mcptoolkit.Mechanism;
import com.mattmc.mcptoolkit.Schemas;
import com.mattmc.mcptoolkit.ToolDef;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Player-legal perception — a per-body <b>belief store</b> of entities the body has actually perceived,
 * deliberately diverging from ground truth (PLAYER_CONTROL_DESIGN.md §9). It is NOT a replacement for
 * {@code get_entities}: that is authoritative and X-ray (the copilot's sensor); this is a lossy, stale,
 * perception-gated view — and that divergence is the point. It is admissible where a "mod-side world
 * mirror" was rejected precisely because it does not mirror truth.
 *
 * <p>Every tick (once tracking is on for a session) two passes update the beliefs from the active body:
 * <ul>
 *   <li><b>vision</b> — an entity inside the field-of-view cone <em>and</em> with line of sight
 *       (a real occlusion raycast) is {@code seen}: live position and velocity, this tick.</li>
 *   <li><b>hearing</b> — a living entity within hearing range that is not currently seen is {@code heard}:
 *       a coarser position (deterministic quantization, never injected noise), no velocity — you know
 *       roughly where, not exactly.</li>
 * </ul>
 * An entity perceived by neither this tick keeps its <b>frozen</b> last-known position (which may now be
 * wrong — honest, and exactly what a player experiences), its {@code age_ticks} growing until it
 * <b>decays</b> (is forgotten). Uncertainty is carried by staleness (age) and the channel label, never a
 * fabricated confidence or error term — matching the toolkit's "no detection noise" doctrine.
 *
 * <p>This is the perception half of the player-legal profile: in that mode the reflex triggers read this
 * store instead of ground truth, so the body reacts to what it perceives, not to an omniscient scan.
 */
public final class Perception {

    private Perception() {}

    /** Vision reach and the field-of-view cone (dot >= this ≈ a ~120° cone; cos 60°). */
    static final double VISION_RANGE = 32.0;
    static final double FOV_DOT = 0.5;
    /** Hearing reach (proximity model: nearby living things are audible even unseen). */
    static final double HEARING_RANGE = 16.0;
    /** Heard positions quantize to this grid — deterministic coarsening, not random noise. */
    static final double HEARD_GRID = 2.0;
    /** Ticks without any percept before a belief leaves the PERCEPT tier (10s). */
    static final int DECAY_TICKS = 200;
    /** Remembered tier (SURVIVAL_SENSES_DESIGN.md §2.1): how long a no-longer-perceived entity stays
     *  remembered (5 min from its last percept) and how many at most (LRU). Deliberately modest —
     *  entities move, and long retention of exact-sounding positions is confabulation food. */
    static final int REMEMBER_TICKS = 6000;
    static final int REMEMBER_CAP = 32;

    /** One believed entity — last-known state and how/when it was last perceived. */
    static final class Belief {
        final int id;
        String type = "?";
        double x, y, z;
        double vx, vy, vz;
        String channel = "seen"; // seen | heard (how last perceived)
        boolean hostile;
        /**
         * An arrow, fireball or thrown item. It stays a full belief — the dodge reflex needs it, and
         * {@code sense_entities} still reports it — but it does NOT get enter/leave EVENTS: an
         * in-flight arrow generates one of each in about a second, and 126 of the events session
         * w2-56123 actually read were the comings and goings of things that never mattered.
         */
        boolean projectile;
        long lastTick;
        boolean seenNow; // perceived by VISION this tick → position/velocity are live

        Belief(final int id) {
            this.id = id;
        }
    }

    /** A belief that left the percept tier — the body still REMEMBERS the entity (§2.1). Frozen
     *  last-known state plus a fate: how the percept ended. Never feeds reflexes or the threat
     *  summary — a memory must not trigger anything. */
    static final class Remembered {
        final int id;
        final String type;
        final boolean hostile;
        final double x, y, z;
        final String channel; // how it was last perceived (seen | heard)
        final long lastTick;  // when it was last perceived
        final String fate;    // lost = aged out unwatched | gone = looked at its spot, absent | died = watched it die

        Remembered(final Belief b, final String fate) {
            this.id = b.id;
            this.type = b.type;
            this.hostile = b.hostile;
            this.x = b.x;
            this.y = b.y;
            this.z = b.z;
            this.channel = b.channel;
            this.lastTick = b.lastTick;
            this.fate = fate;
        }
    }

    /** A session's belief store (present only once tracking has been switched on). */
    static final class Store {
        final Map<Integer, Belief> beliefs = new HashMap<>();
        /** Insertion-ordered oldest-first; re-remembering re-inserts at the tail (LRU by write). */
        final LinkedHashMap<Integer, Remembered> remembered = new LinkedHashMap<>();
    }

    public static void register() {
        McpTools.register(ToolDef.of(
            "sense_entities",
            "Player-legal perception: the entities YOUR body currently BELIEVES are around it, from what "
                + "it can see and hear — NOT authoritative (that is get_entities, which is X-ray). Each "
                + "entry has `channel` seen|heard, `pos` (live if seen this tick, else last-known — may be "
                + "wrong), `age_ticks` since last perceived, and `velocity` only while seen. An entity in "
                + "the field of view WITH line of sight is seen (exact); one nearby but unseen is heard "
                + "(coarser position, no velocity); one no longer perceived keeps its frozen last-known "
                + "position and ages out of perception after a few seconds — into `remembered`: "
                + "entities you recently perceived but no longer do (fate lost|gone|died — died means "
                + "you watched it die), last-known positions only, kept a few minutes. Calling this "
                + "turns on per-tick tracking for your session. Absence here is NOT proof of absence — "
                + "it is what the body has perceived. This is the honest sensor for a true-player "
                + "profile.",
            Schemas.object(),
            ExecutionContext.SERVER,
            Mechanism.OBSERVE,
            (ctx, a) -> sense(DroneTools.slotFor(ctx.sessionId()))));

        McpTools.register(ToolDef.of(
            "bot_profile",
            "Set how YOUR reflex triggers perceive threats. `perception`: 'authoritative' (default — "
                + "the copilot mode: threats_nearby/flee use ground truth) or 'perceived' (player-legal "
                + "— they count only hostiles the body has SEEN or HEARD via the belief store, so a "
                + "threat you can't perceive doesn't trigger a reaction). Turning on 'perceived' enables "
                + "belief tracking (see sense_entities). Call with no args to read the current mode.",
            Schemas.objectOpt(Schemas.object(
                "perception", Schemas.str("authoritative | perceived")),
                "perception"),
            ExecutionContext.SERVER,
            Mechanism.OBSERVE,
            (ctx, a) -> profile(a, DroneTools.slotFor(ctx.sessionId()))));
    }

    /** Tool body for bot_profile: read/set the session's perception mode for the reflex layer. */
    static JsonObject profile(final JsonObject a, final DroneTools.Slot slot) {
        if (a.has("perception") && !a.get("perception").isJsonNull()) {
            String mode = a.get("perception").getAsString();
            if ("perceived".equals(mode)) {
                slot.perceivedMode = true;
                if (slot.perception == null) {
                    slot.perception = new Store(); // start tracking so beliefs accumulate
                }
            } else if ("authoritative".equals(mode)) {
                slot.perceivedMode = false;
            } else {
                throw new IllegalArgumentException("`perception` must be authoritative | perceived");
            }
        }
        JsonObject r = new JsonObject();
        r.addProperty("perception", slot.perceivedMode ? "perceived" : "authoritative");
        return r;
    }

    /** Tool body: enable tracking, run one pass now (so the first call isn't empty), render the beliefs. */
    static JsonObject sense(final DroneTools.Slot slot) {
        JsonObject r = new JsonObject();
        LivingEntity body = slot.activeBody();
        if (slot.perception == null) {
            slot.perception = new Store();
        }
        if (body == null || body.isRemoved()) {
            r.add("perceived", new JsonArray());
            r.addProperty("count", 0);
            r.addProperty("note", "no active body to perceive from — spawn a drone or possess a mob");
            return r;
        }
        pass(slot.perception, body);
        long now = body.level().getGameTime();
        // The body's frame, so each belief carries its RELATION (distance, bearing) already — the model
        // reads "a hostile 5 blocks behind, closing", never subtracts coordinates (no-arithmetic rule).
        Vec3 bpos = body.position();
        Vec3 look = body.getViewVector(1.0F);
        Vec3 fwd = new Vec3(look.x, 0, look.z);
        fwd = fwd.lengthSqr() < 1.0e-6 ? new Vec3(0, 0, 1) : fwd.normalize();
        Vec3 right = new Vec3(-fwd.z, 0, fwd.x);

        JsonArray arr = new JsonArray();
        int hostiles = 0;
        Belief nearestThreat = null;
        double nearestThreatD = Double.MAX_VALUE;
        for (Belief b : slot.perception.beliefs.values()) {
            double dx = b.x - bpos.x, dy = b.y - bpos.y, dz = b.z - bpos.z;
            double distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
            double relDeg = 0.0;
            double hlen = Math.sqrt(dx * dx + dz * dz);
            if (hlen > 1.0e-6) {
                double rn_x = dx / hlen, rn_z = dz / hlen;
                relDeg = Math.toDegrees(Math.atan2(right.x * rn_x + right.z * rn_z, fwd.x * rn_x + fwd.z * rn_z));
            }
            JsonObject o = new JsonObject();
            o.addProperty("id", b.id);
            o.addProperty("type", b.type);
            o.addProperty("hostile", b.hostile);
            o.addProperty("channel", b.channel);
            o.addProperty("age_ticks", now - b.lastTick);
            o.addProperty("distance", round3(distance));
            o.addProperty("bearing", bearingLabel(relDeg)); // ahead|behind|left|right
            o.addProperty("relative_deg", round3(relDeg));  // 0 ahead, +90 right, ±180 behind
            JsonObject pos = new JsonObject();
            pos.addProperty("x", round3(b.x));
            pos.addProperty("y", round3(b.y));
            pos.addProperty("z", round3(b.z));
            o.add("pos", pos);
            if (b.seenNow) {
                o.addProperty("fresh", true);
                // closing = moving toward the body (server dots velocity with the bearing to the body).
                double speedSq = b.vx * b.vx + b.vy * b.vy + b.vz * b.vz;
                o.addProperty("closing", speedSq > 1.0e-6 && (b.vx * -dx + b.vy * -dy + b.vz * -dz) > 0);
                JsonObject v = new JsonObject();
                v.addProperty("x", round3(b.vx));
                v.addProperty("y", round3(b.vy));
                v.addProperty("z", round3(b.vz));
                o.add("velocity", v);
            } else {
                o.addProperty("stale", true); // last-known — may no longer be accurate
            }
            arr.add(o);
            if (b.hostile) {
                hostiles++;
                if (distance < nearestThreatD) {
                    nearestThreatD = distance;
                    nearestThreat = b;
                }
            }
        }
        r.add("perceived", arr);
        r.addProperty("count", arr.size());
        // Summary rung: the surrounded/where-is-the-threat question answered without the model counting
        // or comparing distances itself.
        JsonObject summary = new JsonObject();
        summary.addProperty("hostiles", hostiles);
        if (nearestThreat != null) {
            JsonObject nt = new JsonObject();
            nt.addProperty("id", nearestThreat.id);
            nt.addProperty("type", nearestThreat.type);
            nt.addProperty("distance", round3(nearestThreatD));
            nt.addProperty("channel", nearestThreat.channel);
            summary.add("nearest_threat", nt);
        }
        r.add("summary", summary);
        // Remembered tier (§2.1): entities no longer perceived but not forgotten. Newest first,
        // last-known only — never `fresh`, never velocity, never in the summary. A memory that
        // could still trigger a reflex or count as a threat would be a ghost with agency.
        JsonArray rem = new JsonArray();
        List<Remembered> rlist = new ArrayList<>(slot.perception.remembered.values());
        for (int i = rlist.size() - 1; i >= 0; i--) {
            Remembered m = rlist.get(i);
            JsonObject o = new JsonObject();
            o.addProperty("id", m.id);
            o.addProperty("type", m.type);
            o.addProperty("hostile", m.hostile);
            o.addProperty("fate", m.fate);
            o.addProperty("last_seen_ticks_ago", now - m.lastTick);
            JsonObject mp = new JsonObject();
            mp.addProperty("x", round3(m.x));
            mp.addProperty("y", round3(m.y));
            mp.addProperty("z", round3(m.z));
            o.add("pos", mp);
            rem.add(o);
        }
        r.add("remembered", rem);
        r.addProperty("remembered_count", rem.size());
        r.addProperty("note", "belief state (vision FOV+line-of-sight, plus hearing) — NOT authoritative; "
            + "stale/absent entries are last-known or unperceived, not ground truth. `remembered` = no "
            + "longer perceived (fate lost|gone|died — died means you watched it die): last-known, may "
            + "have moved, never counted in the summary. get_entities is the true list.");
        return r;
    }

    // ---- player-legal reads for the reflex layer (perceived mode) -----------------------------------

    /** Count hostile entities the body BELIEVES are within {@code within} (last-known positions). The
     *  player-legal replacement for a ground-truth scan: a threat the body can't see or hear is not
     *  counted, even if it is physically near. Zero if tracking is off. */
    static int perceivedThreatsWithin(final DroneTools.Slot slot, final LivingEntity body, final double within) {
        Store s = slot.perception;
        if (s == null) {
            return 0;
        }
        Vec3 p = body.position();
        double r2 = within * within;
        long now = body.level().getGameTime();
        int n = 0;
        for (Belief b : s.beliefs.values()) {
            // A HEARD belief can never be refuted by looking (the vision sweep only clears `seen`
            // entries), its position is quantized to a 2-block grid, and it lives DECAY_TICKS —
            // which let a wall-muffled footstep hold a melee trigger true for 10 straight seconds
            // in w2-79881. Hearing may still STARTLE (fresh heard counts); it may not sustain: a
            // heard belief older than HEARD_TRIGGER_TICKS no longer drives a threat trigger.
            if (!"seen".equals(b.channel) && now - b.lastTick > HEARD_TRIGGER_TICKS) {
                continue;
            }
            if (b.hostile && sqDist(b, p) <= r2) {
                n++;
            }
        }
        return n;
    }

    /** How long a heard-only belief may keep a reflex trigger true (3s — a startle, not a siege). */
    static final int HEARD_TRIGGER_TICKS = 60;

    /** Centroid of the hostiles the body believes are within {@code within}, or null if none — the
     *  player-legal swarm centre a flee moves away from. */
    static @Nullable Vec3 perceivedThreatCentroid(final DroneTools.Slot slot, final LivingEntity body, final double within) {
        Store s = slot.perception;
        if (s == null) {
            return null;
        }
        Vec3 p = body.position();
        double r2 = within * within;
        double sx = 0, sy = 0, sz = 0;
        int n = 0;
        for (Belief b : s.beliefs.values()) {
            if (b.hostile && sqDist(b, p) <= r2) {
                sx += b.x; sy += b.y; sz += b.z; n++;
            }
        }
        return n == 0 ? null : new Vec3(sx / n, sy / n, sz / n);
    }

    private static double sqDist(final Belief b, final Vec3 p) {
        double dx = b.x - p.x, dy = b.y - p.y, dz = b.z - p.z;
        return dx * dx + dy * dy + dz * dz;
    }

    /** Drop all beliefs — a new/removed body has no memory of what the old one perceived. Called when
     *  the drone is despawned or replaced (tracking stays on; it just re-perceives from scratch). */
    static void reset(final DroneTools.Slot slot) {
        if (slot.perception != null) {
            slot.perception.beliefs.clear();
            slot.perception.remembered.clear();
        }
    }

    /** Advance a slot's belief store one tick (no-op until tracking is on). From the tick watch. */
    static void tick(final DroneTools.Slot slot, final @Nullable LivingEntity body) {
        if (slot.perception == null || body == null || body.isRemoved()) {
            return;
        }
        pass(slot.perception, body);
    }

    /** One vision + hearing + decay pass, updating the store from the body's senses. */
    private static void pass(final Store s, final LivingEntity body) {
        ServerLevel level = (ServerLevel) body.level();
        long now = level.getGameTime();
        Vec3 eye = body.getEyePosition();
        Vec3 look = body.getViewVector(1.0F);

        // Vision: FOV cone + real line of sight.
        // SPECTATORS ARE NOT THERE. A spectating player is invisible to players and inaudible to
        // mobs in vanilla, so a body that perceives one is perceiving something it cannot legally
        // sense — the same class of leak as an X-ray read, and it has consequences: live on
        // 2026-08-10 the survival agent repeatedly broke off its objective to walk to the watching
        // human ("Found you!") and ask them for iron. The authoritative paths already exclude
        // spectators (DroneObserver.authoritativeTick, WorldPerceptionTools) and so does human
        // capture (WmHuman); the belief store was the one path that did not.
        AABB vbox = body.getBoundingBox().inflate(VISION_RANGE);
        for (Entity e : level.getEntities(body, vbox,
                x -> x.isAlive() && !x.isSpectator() && !(x instanceof BotBodyEntity))) {
            if (!visibleFrom(level, body, eye, look, e.getBoundingBox().getCenter())) {
                continue;
            }
            s.remembered.remove(e.getId()); // perceived again — it is a percept, not a memory
            Belief b = s.beliefs.computeIfAbsent(e.getId(), Belief::new);
            b.type = typeOf(e);
            b.hostile = e instanceof Enemy;
            b.projectile = e instanceof net.minecraft.world.entity.projectile.Projectile;
            Vec3 p = e.position();
            b.x = p.x; b.y = p.y; b.z = p.z;
            Vec3 v = e.getDeltaMovement();
            b.vx = v.x; b.vy = v.y; b.vz = v.z;
            b.channel = "seen";
            b.lastTick = now;
            b.seenNow = true;
        }

        // Hearing: nearby living things not seen this tick — coarse position, no velocity.
        // Hearing ignores line of sight, so an unfiltered spectator is heard THROUGH ROCK — that is
        // how the watching human kept being "found" while the body was underground.
        AABB hbox = body.getBoundingBox().inflate(HEARING_RANGE);
        for (Entity e : level.getEntities(body, hbox,
                x -> x instanceof LivingEntity && x.isAlive() && !x.isSpectator()
                    && !(x instanceof BotBodyEntity))) {
            if (body.distanceTo(e) > HEARING_RANGE) {
                continue;
            }
            Belief existing = s.beliefs.get(e.getId());
            if (existing != null && existing.lastTick == now) {
                continue; // already seen this tick — vision wins
            }
            s.remembered.remove(e.getId()); // perceived again — it is a percept, not a memory
            Belief b = s.beliefs.computeIfAbsent(e.getId(), Belief::new);
            b.type = typeOf(e);
            b.hostile = e instanceof Enemy;
            Vec3 p = e.position();
            b.x = Math.round(p.x / HEARD_GRID) * HEARD_GRID;
            b.y = Math.round(p.y / HEARD_GRID) * HEARD_GRID;
            b.z = Math.round(p.z / HEARD_GRID) * HEARD_GRID;
            b.channel = "heard";
            b.lastTick = now;
            b.seenNow = false;
        }

        // Witnessed death (§2.2): a DEAD entity in the vision cone whose id we hold a belief for —
        // the body saw it die (vanilla keeps the corpse for the ~20-tick death animation, which is
        // what makes a death perceivable at tick rate). Without this, a watched kill froze into a
        // stale hostile that haunted the store for DECAY_TICKS — a lie about the one event the body
        // actually witnessed.
        for (Entity e : level.getEntities(body, vbox, x -> !x.isAlive() && !(x instanceof BotBodyEntity))) {
            Belief b = s.beliefs.get(e.getId());
            if (b == null || !visibleFrom(level, body, eye, look, e.getBoundingBox().getCenter())) {
                continue;
            }
            remember(s, b, "died");
            s.beliefs.remove(e.getId());
        }

        // Refutation by observation (§2.2 — the entity analog of the block store's implied-air
        // VANISH rule): looking at where a belief lives and not perceiving the entity IS an
        // observation. Only `seen` beliefs are refutable — their position is exact; a heard position
        // is quantized up to a block off, and refuting a guess would manufacture certainty.
        for (Iterator<Belief> it = s.beliefs.values().iterator(); it.hasNext();) {
            Belief b = it.next();
            if (b.lastTick == now || !"seen".equals(b.channel)) {
                continue;
            }
            if (visibleFrom(level, body, eye, look, new Vec3(b.x, b.y + 0.5, b.z))) {
                remember(s, b, "gone");
                it.remove();
            }
        }

        // Freeze the unperceived (drop their live flag) and move the long-unperceived to the
        // remembered tier — aging out of perception is not amnesia (§2.1). Remembered prunes by TTL.
        for (Iterator<Belief> it = s.beliefs.values().iterator(); it.hasNext();) {
            Belief b = it.next();
            if (now - b.lastTick > DECAY_TICKS) {
                remember(s, b, "lost");
                it.remove();
            } else if (b.lastTick != now) {
                b.seenNow = false;
            }
        }
        s.remembered.values().removeIf(m -> now - m.lastTick > REMEMBER_TICKS);
    }

    /** Move a belief to the remembered tier: re-inserted at the newest end, capped drop-oldest. */
    private static void remember(final Store s, final Belief b, final String fate) {
        s.remembered.remove(b.id);
        s.remembered.put(b.id, new Remembered(b, fate));
        while (s.remembered.size() > REMEMBER_CAP) {
            s.remembered.remove(s.remembered.keySet().iterator().next());
        }
    }

    /** Is this point inside the body's vision: range, the FOV cone, and an occlusion raycast. */
    private static boolean visibleFrom(final ServerLevel level, final LivingEntity body,
            final Vec3 eye, final Vec3 look, final Vec3 to) {
        Vec3 dir = to.subtract(eye);
        double len = dir.length();
        if (len > VISION_RANGE || len < 1.0e-6) {
            return false;
        }
        if (look.dot(dir.scale(1.0 / len)) < FOV_DOT) {
            return false; // outside the field of view
        }
        HitResult hit = level.clip(new ClipContext(
            eye, to, ClipContext.Block.COLLIDER, ClipContext.Fluid.NONE, body));
        return hit.getType() == HitResult.Type.MISS;
    }

    private static String typeOf(final Entity e) {
        return BuiltInRegistries.ENTITY_TYPE.getKey(e.getType()).toString();
    }

    /** Coarse relative direction from a signed bearing (0 ahead, +90 right, ±180 behind, -90 left). */
    private static String bearingLabel(final double deg) {
        double a = Math.abs(deg);
        if (a <= 45.0) {
            return "ahead";
        }
        if (a >= 135.0) {
            return "behind";
        }
        return deg > 0 ? "right" : "left";
    }

    private static double round3(final double v) {
        return Math.round(v * 1000.0) / 1000.0;
    }
}
