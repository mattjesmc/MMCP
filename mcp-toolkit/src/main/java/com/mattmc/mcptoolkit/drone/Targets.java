package com.mattmc.mcptoolkit.drone;

import com.google.gson.JsonObject;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

import java.util.Comparator;
import java.util.List;
import java.util.UUID;

/**
 * The one target grammar every embodied goal reads (BOT_SURFACE_DESIGN.md §3.1). Selection used to be
 * per-tool and inconsistent — {@code bot_attack} took {@code target}|{@code nearest}, {@code bot_follow}
 * {@code target}|{@code player}, {@code bot_engage} an entity id only, {@code bot_mine} an
 * {@code at{x,y,z}} — each described in its own words, and each costing a {@code get_entities} round
 * trip first.
 *
 * <p><b>Searching the world is {@code locate}'s question, not this one's.</b> {@code locate} is
 * two-way, is an index lookup rather than a scan, carries the {@code negative_is_proof} contract, and
 * hands back <em>handles</em> with the standing instruction "pass handles around, never retyped
 * coordinates". Re-implementing "find me the nearest oak log" here would duplicate that machinery and
 * its honesty contract, and would break the collapse criterion (TOOL_BILL_PLAN.md §3: never merge
 * tools that answer different questions). So {@code locate} finds, this acts, and the <b>handle is the
 * seam</b>.
 *
 * <p>The one search-shaped form that stays local is {@code kind}+{@code nearest}, resolved against what
 * the body can already perceive within a short radius. That is not a world search — it is "the thing in
 * front of me".
 *
 * <p>A selector is kept, not just its result: the goal loop <b>re-resolves</b> after a failure so a
 * dead mob or a changed block does not cost an agent turn.
 */
public final class Targets {

    /** How far {@code kind}+{@code nearest} looks — perception range, not a world search. */
    private static final double NEAREST_RADIUS = 32.0;

    /** A resolved referent: an entity, or a block position, never both. */
    public record Resolved(@Nullable Entity entity, @Nullable BlockPos pos, String describe) {

        public boolean isEntity() {
            return entity != null;
        }

        /** Where the referent is now — an entity's live position, or the block. */
        public Vec3 where() {
            return entity != null ? entity.position() : Vec3.atCenterOf(pos);
        }

        public BlockPos blockPos() {
            return entity != null ? entity.blockPosition() : pos;
        }
    }

    private Targets() {}

    /**
     * Resolve {@code target} against the world. Throws {@link IllegalArgumentException} for a
     * malformed selector and returns null when the selector is well-formed but matches nothing —
     * the caller decides whether that is a refusal or a retry.
     */
    public static @Nullable Resolved resolve(final ServerLevel level, final @Nullable LivingEntity body,
                                             final JsonObject sel) {
        if (sel == null || sel.isEmpty()) {
            throw new IllegalArgumentException("missing `target` selector");
        }

        if (has(sel, "entity")) {
            Entity e = level.getEntity(sel.get("entity").getAsInt());
            return e == null ? null : new Resolved(e, null, "entity " + e.getId());
        }
        if (has(sel, "uuid")) {
            Entity e = level.getEntity(UUID.fromString(sel.get("uuid").getAsString()));
            return e == null ? null : new Resolved(e, null, "uuid " + sel.get("uuid").getAsString());
        }
        if (has(sel, "player")) {
            String name = sel.get("player").getAsString();
            var p = level.getServer().getPlayerList().getPlayerByName(name);
            return p == null ? null : new Resolved(p, null, "player " + name);
        }
        if (has(sel, "at")) {
            JsonObject at = sel.getAsJsonObject("at");
            BlockPos pos = new BlockPos(at.get("x").getAsInt(), at.get("y").getAsInt(), at.get("z").getAsInt());
            return new Resolved(null, pos, "block " + pos.toShortString());
        }
        if (has(sel, "handle")) {
            BlockPos pos = parseHandle(sel.get("handle").getAsString());
            return new Resolved(null, pos, "handle " + sel.get("handle").getAsString());
        }
        if (has(sel, "kind")) {
            if (body == null) {
                throw new IllegalArgumentException(
                    "`kind` resolves against your body's surroundings, but you have no body — "
                        + "spawn one, or give an explicit target");
            }
            String kind = sel.get("kind").getAsString();
            Entity found = nearest(level, body, kind);
            return found == null ? null : new Resolved(found, null, "nearest " + kind);
        }

        throw new IllegalArgumentException("`target` must carry exactly one of: entity | uuid | "
            + "player | at | handle | kind");
    }

    /**
     * Parse a {@code locate} handle ({@code village_plains@-104,71,238}). A structure handle resolves a
     * COLUMN and reads {@code name@1488,~,-224} — the height genuinely is not known, so this refuses
     * rather than inventing one.
     */
    public static BlockPos parseHandle(final String handle) {
        int at = handle.lastIndexOf('@');
        if (at < 0 || at == handle.length() - 1) {
            throw new IllegalArgumentException("malformed handle '" + handle
                + "' (expected name@x,y,z from locate)");
        }
        String[] parts = handle.substring(at + 1).split(",");
        if (parts.length != 3) {
            throw new IllegalArgumentException("malformed handle '" + handle
                + "' (expected name@x,y,z from locate)");
        }
        if ("~".equals(parts[1].trim())) {
            throw new IllegalArgumentException("handle '" + handle + "' has no height (a structure "
                + "handle resolves a column) — locate a specific block, or give `at` with a y");
        }
        try {
            return new BlockPos(Integer.parseInt(parts[0].trim()),
                Integer.parseInt(parts[1].trim()), Integer.parseInt(parts[2].trim()));
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException("malformed handle '" + handle + "': " + e.getMessage());
        }
    }

    /**
     * The nearest living entity of {@code kind} the body could plausibly perceive. {@code kind} is an
     * entity type id ({@code minecraft:zombie}, or a bare {@code zombie}) or the category
     * {@code hostile}. Deliberately short-range: this is "the thing in front of me", not a search.
     */
    private static @Nullable Entity nearest(final ServerLevel level, final LivingEntity body, final String kind) {
        String wanted = kind.contains(":") ? kind : "minecraft:" + kind;
        boolean hostileCategory = "hostile".equals(kind);
        AABB box = body.getBoundingBox().inflate(NEAREST_RADIUS);
        List<LivingEntity> candidates = level.getEntitiesOfClass(LivingEntity.class, box, e -> {
            if (e == body || !e.isAlive()) {
                return false;
            }
            if (hostileCategory) {
                return e.getType().getCategory().isFriendly() == false;
            }
            return net.minecraft.core.registries.BuiltInRegistries.ENTITY_TYPE
                .getKey(e.getType()).toString().equals(wanted);
        });
        return candidates.stream()
            .min(Comparator.comparingDouble(e -> e.distanceToSqr(body)))
            .orElse(null);
    }

    private static boolean has(final JsonObject o, final String key) {
        return o.has(key) && !o.get(key).isJsonNull();
    }

    /** Schema fragment — described ONCE here and reused by every tool that takes a target. */
    public static JsonObject schema() {
        return com.mattmc.mcptoolkit.Schemas.objectOpt(com.mattmc.mcptoolkit.Schemas.object(
            "entity", com.mattmc.mcptoolkit.Schemas.integer("Entity id (from get_entities/raycast)."),
            "uuid", com.mattmc.mcptoolkit.Schemas.str("Entity UUID."),
            "player", com.mattmc.mcptoolkit.Schemas.str("Player name."),
            "at", com.mattmc.mcptoolkit.Schemas.vec3i(),
            "handle", com.mattmc.mcptoolkit.Schemas.str("A locate handle (name@x,y,z) — pass these "
                + "around rather than retyping coordinates."),
            "kind", com.mattmc.mcptoolkit.Schemas.str("Nearest living entity of this type (or "
                + "'hostile') within 32 blocks of your body — for things in front of you; use locate "
                + "to search the world.")),
            "entity", "uuid", "player", "at", "handle", "kind");
    }
}
