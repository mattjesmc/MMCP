package com.mattmc.spike;

import net.minecraft.core.Registry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.Identifier;
import net.minecraft.resources.ResourceKey;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.MobCategory;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Two entity types, registered through two different doors, so a failure in one cannot be mistaken
 * for a failure in the other.
 *
 * <p>Deliberately NOT built in static initializers, which is how mcp-toolkit's {@code DroneEntities}
 * does it. {@code EntityType.Builder.build(key)} needs the registry's intrusive-holder map, which
 * {@code freeze()} nulls — so where the build happens decides whether it can happen at all, and a
 * static initializer runs at whatever moment the class is first touched. Building inside each
 * door's own method makes the timing explicit and keeps one door's throw from poisoning the other.
 */
public final class SpikeEntities {
    private static final Logger LOG = LoggerFactory.getLogger("spike");

    public static final Identifier MIXIN_DOOR_ID = Identifier.fromNamespaceAndPath("spike", "mixin_door");
    public static final Identifier EVENT_DOOR_ID = Identifier.fromNamespaceAndPath("spike", "event_door");

    private static final ResourceKey<EntityType<?>> MIXIN_DOOR_KEY =
        ResourceKey.create(Registries.ENTITY_TYPE, MIXIN_DOOR_ID);
    private static final ResourceKey<EntityType<?>> EVENT_DOOR_KEY =
        ResourceKey.create(Registries.ENTITY_TYPE, EVENT_DOOR_ID);

    private SpikeEntities() {}

    private static EntityType<SpikeEntity> build(final ResourceKey<EntityType<?>> key) {
        return EntityType.Builder.of(SpikeEntity::new, MobCategory.MISC)
            .sized(0.5F, 0.5F)
            .clientTrackingRange(8)
            .build(key);
    }

    /**
     * Door 1 — from {@code BuiltInRegistriesMixin}, at the {@code freeze()} call inside
     * {@code BuiltInRegistries.bootStrap()}. This is mcp-toolkit's mechanism, verbatim.
     */
    public static void registerViaMixin() {
        if (BuiltInRegistries.ENTITY_TYPE.containsKey(MIXIN_DOOR_ID)) {
            LOG.info("[spike] DOOR 1 (bootStrap mixin): already registered, skipping");
            return;
        }
        try {
            Registry.register(BuiltInRegistries.ENTITY_TYPE, MIXIN_DOOR_KEY, build(MIXIN_DOOR_KEY));
            LOG.info("[spike] DOOR 1 (bootStrap mixin): REGISTERED spike:mixin_door");
        } catch (Throwable t) {
            LOG.error("[spike] DOOR 1 (bootStrap mixin): FAILED - {}", t.toString());
        }
    }

    /** Door 2 — from NeoForge's {@code RegisterEvent}, the loader's own supported window. */
    public static void registerViaEvent() {
        if (BuiltInRegistries.ENTITY_TYPE.containsKey(EVENT_DOOR_ID)) {
            LOG.info("[spike] DOOR 2 (RegisterEvent): already registered, skipping");
            return;
        }
        try {
            Registry.register(BuiltInRegistries.ENTITY_TYPE, EVENT_DOOR_KEY, build(EVENT_DOOR_KEY));
            LOG.info("[spike] DOOR 2 (RegisterEvent): REGISTERED spike:event_door");
        } catch (Throwable t) {
            LOG.error("[spike] DOOR 2 (RegisterEvent): FAILED - {}", t.toString());
        }
    }

    /**
     * The live type for an id, or null if that door did not open. {@code containsKey} first, for the
     * defaulted-registry reason spelled out on {@link #idOf} — {@code getValue(missing)} is a pig.
     *
     * <p>Exists so the CLIENT can hand each type a renderer. See {@link SpikeEntity}.
     */
    @SuppressWarnings("unchecked")
    public static EntityType<SpikeEntity> typeOrNull(final Identifier id) {
        if (!BuiltInRegistries.ENTITY_TYPE.containsKey(id)) {
            return null;
        }
        return (EntityType<SpikeEntity>) BuiltInRegistries.ENTITY_TYPE.getValue(id);
    }

    /**
     * One line that says what actually made it in. Called from both sides of the connection.
     *
     * <p>Reports the RAW NUMERIC ID too, not just presence. "The client joined" only proves registry
     * sync did not reject the connection; entity spawn packets carry the numeric id, so if the two
     * sides disagree on it they will happily exchange packets that mean different things. That is a
     * silent corruption, not a failed handshake, and presence alone cannot see it.
     */
    public static void report(final String where) {
        LOG.info("[spike] REPORT {} :: mixin_door={} event_door={} entity_types={}",
            where, idOf(MIXIN_DOOR_ID), idOf(EVENT_DOOR_ID), BuiltInRegistries.ENTITY_TYPE.size());
    }

    /**
     * {@code containsKey} FIRST, and that is not defensive style — the first run of this spike got a
     * false answer without it. {@code BuiltInRegistries.ENTITY_TYPE} is a DEFAULTED registry, so
     * {@code getValue(missing)} returns {@code minecraft:pig} rather than null, and an unregistered
     * type reported as "present(rawId=100)". A check whose subject degrades gracefully measures the
     * degradation unless it asks the question that cannot degrade.
     */
    private static String idOf(final Identifier id) {
        if (!BuiltInRegistries.ENTITY_TYPE.containsKey(id)) {
            return "ABSENT";
        }
        return "rawId=" + BuiltInRegistries.ENTITY_TYPE.getId(BuiltInRegistries.ENTITY_TYPE.getValue(id));
    }
}
