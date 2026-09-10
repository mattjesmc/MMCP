package com.mattmc.mcptoolkit.drone;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import it.unimi.dsi.fastutil.ints.IntOpenHashSet;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.phys.AABB;
import org.jspecify.annotations.Nullable;

import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Who this session's body treats as an enemy (BOT_SURFACE_DESIGN.md §4.2). Designation and
 * <em>engagement</em> are deliberately separate: {@code bot_target action:"attack"} writes a row here,
 * and the engage toggle on {@code bot_body} decides whether anything acts on it.
 *
 * <p><b>Why a table and not a target.</b> The previous {@code bot_engage} bound combat to a single
 * entity id and emitted {@code engage_lost} when it died — so <b>every killed mob cost an agent
 * turn</b> to re-issue. A table means a dead target just yields to the next one. At a measured
 * 4.5–8.4k tokens per bench turn (and ~18.7k against the live manifest), that is the single most
 * mechanical saving in the combat layer.
 *
 * <p>Two kinds of row: an <b>individual</b> (entity id — "that zombie") and a <b>standing rule</b>
 * (type id or the {@code hostile} category — "zombies, generally"). Individuals are forgotten when
 * they die; rules persist until cleared.
 */
public final class ThreatTable {

    /** How far the combat watch will look for a designated enemy. */
    static final double ENGAGE_RADIUS = 24.0;

    private final IntOpenHashSet individuals = new IntOpenHashSet();
    private final Set<String> rules = new LinkedHashSet<>();

    /** Designate one entity. */
    public void designate(final Entity e) {
        individuals.add(e.getId());
    }

    /** Designate a standing rule: an entity type id, or the category {@code hostile}. */
    public void designateKind(final String kind) {
        rules.add(kind.contains(":") || "hostile".equals(kind) ? kind : "minecraft:" + kind);
    }

    public void clear() {
        individuals.clear();
        rules.clear();
    }

    public boolean isEmpty() {
        return individuals.isEmpty() && rules.isEmpty();
    }

    /** Does this entity match any row? */
    public boolean designated(final Entity e) {
        if (individuals.contains(e.getId())) {
            return true;
        }
        if (rules.isEmpty()) {
            return false;
        }
        if (rules.contains("hostile") && !e.getType().getCategory().isFriendly()) {
            return true;
        }
        return rules.contains(BuiltInRegistries.ENTITY_TYPE.getKey(e.getType()).toString());
    }

    /**
     * The enemy the body should be fighting right now: nearest living designated entity in range.
     * Dead individuals are reaped as a side effect, so the table does not grow stale.
     */
    public @Nullable LivingEntity pick(final ServerLevel level, final LivingEntity body) {
        AABB box = body.getBoundingBox().inflate(ENGAGE_RADIUS);
        List<LivingEntity> found = level.getEntitiesOfClass(LivingEntity.class, box,
            e -> e != body && e.isAlive() && designated(e));
        // Reap individuals that no longer exist (cheap: only ids we hold).
        individuals.removeIf((int id) -> {
            Entity e = level.getEntity(id);
            return e == null || !e.isAlive();
        });
        return found.stream().min(Comparator.comparingDouble(e -> e.distanceToSqr(body))).orElse(null);
    }

    public JsonObject describe() {
        JsonObject o = new JsonObject();
        if (!individuals.isEmpty()) {
            JsonArray arr = new JsonArray();
            individuals.forEach((int id) -> arr.add(id));
            o.add("entities", arr);
        }
        if (!rules.isEmpty()) {
            JsonArray arr = new JsonArray();
            rules.forEach(arr::add);
            o.add("kinds", arr);
        }
        return o;
    }
}
