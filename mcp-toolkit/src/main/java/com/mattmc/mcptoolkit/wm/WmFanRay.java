package com.mattmc.mcptoolkit.wm;

import com.mattmc.mcptoolkit.Sightlines;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.item.ItemEntity;
import org.jspecify.annotations.Nullable;

/**
 * One ray of a fan, as the recorder wants it: the full {@link Sightlines.Walk} — occlusion kind,
 * entry face, through-fluid, the whole traversal — plus the entity pick, BEFORE the agent-facing
 * projection floors positions and drops kinds (the world-model project's DESIGN.md §2.1: the export rows are the
 * lossy view; the recorder serializes the walk itself).
 *
 * @param dYaw     ray yaw offset from fan center, degrees
 * @param dPitch   ray pitch offset from fan center, degrees
 * @param walk     what the ray saw and where its view ended
 * @param covered  distance actually walkable (== range unless the ray was clamped to readable chunks)
 * @param truncated whether the ray was clamped short of its range by unreadable chunks — beyond
 *                 {@code covered} is UNREAD, not empty, and the two must never collapse (§2.4)
 * @param entity   the nearest pickable entity the ray pierced before its block hit, or null
 * @param entityDistance distance to that entity (meaningless when {@code entity} is null)
 */
public record WmFanRay(double dYaw, double dPitch, Sightlines.Walk walk, double covered,
                       boolean truncated, @Nullable Entity entity, double entityDistance) {

    /** A dropped-item sighting collected over the fan's span (the fan's separate drops pass). */
    public record Item(ItemEntity drop, double distance, double dYaw, double dPitch) { }
}
