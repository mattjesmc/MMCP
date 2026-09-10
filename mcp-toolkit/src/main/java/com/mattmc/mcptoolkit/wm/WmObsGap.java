package com.mattmc.mcptoolkit.wm;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.ExecutionContext;
import com.mattmc.mcptoolkit.McpTools;
import com.mattmc.mcptoolkit.Mechanism;
import com.mattmc.mcptoolkit.Schemas;
import com.mattmc.mcptoolkit.ToolDef;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.level.Level;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * The §15.3 sighting window (HUMAN_RIG_PLAN.md phase 5): per session, which entities has ANY of
 * the session's fans sighted recently? The trap it exists for is named in DESIGN.md §15.3:
 * <b>the human sees pixels; the dataset sees fans</b> — a player reacts to a creeper glimpsed in
 * peripheral vision that no ray happened to walk, and BC on that observation-inexplicable
 * engagement is direct confabulation pressure (it teaches the student to act on information it
 * does not have). This is mitigation 2: <b>flag, don't silently keep</b> — a press edge naming a
 * target no fan sighted within {@link #WINDOW_TICKS} gets {@code obs_gap:true} on the press row
 * plus an episodes row ({@link WmHuman}'s capture), v1 training excludes the flagged spans (the
 * loader's job, phase 6), and the manifest's obs-gap rate is the §8 recorder-quality column.
 *
 * <p>Fed by {@link Wm#recordFan} from EVERY fan a session casts — gait, gaze, and tool fans
 * alike; the per-session keying IS the hermeticity boundary (one session's sightings must not
 * explain another's actions — the shared-seen-set lesson). Keyed by entity NETWORK id
 * ({@link Entity#getId()}) because that is what the client crosshair names at the press edge
 * ({@code HumanFramePayload.targetEid()}).
 *
 * <p>Server thread only (recordFan's callers and the WmHuman capture sweep all run on it) —
 * plain maps, no locks. Sized honestly: a session's map exceeding {@link #SWEEP_AT} entries
 * sweeps expired entries in place; all state drops wholesale at server stop.
 */
final class WmObsGap {
    private WmObsGap() {}

    /** The sighting window, ticks. HUMAN_RIG_PLAN decision 5: a knob kept as a constant like
     *  WmGait's profiles — tuned later against the manifest's obs-gap-rate, not guessed now. */
    static final int WINDOW_TICKS = 40;

    /** Map-size threshold that triggers an in-place sweep of expired entries. */
    private static final int SWEEP_AT = 128;

    /** session → (entity network id → last tick any of that session's fans picked it). */
    private static final Map<String, Map<Integer, Integer>> SIGHTED = new HashMap<>();

    /** A fan ray picked {@code eid} for {@code session} at {@code tick}. Null session = an
     *  unattributed fan — it can explain nobody's actions, so there is nothing to record. */
    static void note(final @Nullable String session, final int eid, final int tick) {
        if (session == null) {
            return;
        }
        Map<Integer, Integer> ring = SIGHTED.computeIfAbsent(session, s -> new HashMap<>());
        ring.put(eid, tick);
        if (ring.size() > SWEEP_AT) {
            ring.values().removeIf(last -> tick - last > WINDOW_TICKS);
        }
    }

    /** Has any of {@code session}'s fans sighted {@code eid} within the window ending at
     *  {@code tick}? Same-tick sightings count — an observation at tick t legally explains an
     *  action at tick t. */
    static boolean sighted(final String session, final int eid, final int tick) {
        Map<Integer, Integer> ring = SIGHTED.get(session);
        if (ring == null) {
            return false;
        }
        Integer last = ring.get(eid);
        return last != null && tick - last <= WINDOW_TICKS;
    }

    /** Server stopping: drop everything. Tick stamps are session-relative; carrying them across
     *  a restart would alias a fresh session's window onto stale sightings. */
    static void clear() {
        SIGHTED.clear();
    }

    // ---- the dev probe tool -----------------------------------------------------

    /**
     * {@code wm_obsgap} — the headless half of the obs-gap synthetic probe (HUMAN_RIG_PLAN
     * verification item 6). DEV_ONLY on the Node side: reads the sighting window for one
     * (session, entity) pair against the current tick, so a probe can cast a fan at a mob and
     * assert {@code sighted:true}, then assert the never-sighted control stays false — without a
     * human or a press. Read-only by construction: the window is only ever written by fan
     * recording.
     */
    static void register() {
        JsonObject near = Schemas.array(Schemas.number());
        near.addProperty("description", "[x, y, z] — with 'type': resolve the nearest loaded "
            + "entity of that type within 16 blocks of this point (overworld)");
        McpTools.register(ToolDef.of(
            "wm_obsgap",
            "DEV probe for the §15.3 obs-gap sighting window: has ANY fan a session cast sighted "
                + "an entity within the last " + WINDOW_TICKS + " ticks? Name the entity by eid "
                + "(network id, what press rows carry as tgt_eid) or by type + near (nearest "
                + "loaded entity of that type — never pages chunks). session defaults to YOUR "
                + "bridge session id, so a probe that just cast a fan queries its own window "
                + "without knowing its session name. Returns sighted (at the current tick), "
                + "last_sighted_tick (null = never), now and the window width.",
            Schemas.objectOpt(Schemas.object(
                "session", Schemas.str("whose sighting window — defaults to the calling bridge "
                    + "session"),
                "eid", Schemas.integer("entity network id, as press rows' tgt_eid carries"),
                "type", Schemas.str("entity type id, e.g. minecraft:creeper — used with 'near'"),
                "near", near),
                "session", "eid", "type", "near"),
            ExecutionContext.SERVER,
            Mechanism.OBSERVE,
            (ctx, a) -> {
                String session = a.has("session") && !a.get("session").isJsonNull()
                    ? a.get("session").getAsString() : ctx.sessionId();
                if (session == null) {
                    throw new IllegalArgumentException("no session to query: this call carried "
                        + "no bridge session id — pass 'session' explicitly");
                }
                MinecraftServer server = ctx.serverOrThrow();
                ServerLevel level = server.getLevel(Level.OVERWORLD);
                if (level == null) {
                    throw new IllegalStateException("no overworld");
                }
                int eid;
                String typeId = null;
                if (a.has("eid") && !a.get("eid").isJsonNull()) {
                    eid = a.get("eid").getAsInt();
                    Entity e = level.getEntity(eid);
                    if (e != null) {
                        typeId = BuiltInRegistries.ENTITY_TYPE.getKey(e.getType()).toString();
                    }
                } else if (a.has("type") && !a.get("type").isJsonNull()
                    && a.has("near") && a.get("near").isJsonArray()) {
                    String want = a.get("type").getAsString();
                    JsonArray n = a.getAsJsonArray("near");
                    Vec3 at = new Vec3(n.get(0).getAsDouble(), n.get(1).getAsDouble(),
                        n.get(2).getAsDouble());
                    // Entity AABB queries read only resident entity sections — they never page
                    // chunks in, so probing near unloaded terrain fails loudly instead of loading.
                    List<Entity> candidates = level.getEntities((Entity) null,
                        new AABB(at, at).inflate(16.0),
                        c -> c.isAlive() && want.equals(
                            BuiltInRegistries.ENTITY_TYPE.getKey(c.getType()).toString()));
                    Entity best = null;
                    double bestSq = Double.MAX_VALUE;
                    for (Entity c : candidates) {
                        double d = c.position().distanceToSqr(at);
                        if (d < bestSq) {
                            best = c;
                            bestSq = d;
                        }
                    }
                    if (best == null) {
                        throw new IllegalStateException("no loaded '" + want + "' within 16 "
                            + "blocks of [" + at.x + ", " + at.y + ", " + at.z + "] — spawn or "
                            + "move one there first, or name it by eid");
                    }
                    eid = best.getId();
                    typeId = want;
                } else {
                    throw new IllegalArgumentException("name the entity: 'eid' (network id), or "
                        + "'type' + 'near' together");
                }
                int now = server.getTickCount();
                Map<Integer, Integer> ring = SIGHTED.get(session);
                Integer last = ring == null ? null : ring.get(eid);
                JsonObject r = new JsonObject();
                r.addProperty("session", session);
                r.addProperty("eid", eid);
                if (typeId != null) {
                    r.addProperty("type", typeId);
                }
                r.addProperty("sighted", sighted(session, eid, now));
                r.addProperty("last_sighted_tick", last);
                r.addProperty("now", now);
                r.addProperty("window", WINDOW_TICKS);
                return r;
            }));
    }
}
