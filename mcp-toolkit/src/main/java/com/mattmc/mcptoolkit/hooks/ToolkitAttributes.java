package com.mattmc.mcptoolkit.hooks;

import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.ai.attributes.AttributeSupplier;
import org.jspecify.annotations.Nullable;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Supplier;

/**
 * Default-attribute registration for the toolkit's entity types (FabricDefaultAttributeRegistry
 * replacement). Vanilla's {@code DefaultAttributes.SUPPLIERS} is an ImmutableMap, so instead of
 * mutating it, {@code DefaultAttributesMixin} consults this side table first in
 * {@code getSupplier}/{@code hasSupplier}.
 *
 * <p>Registration is LAZY on purpose: a caller hands over a {@link Supplier} of the builder, and it
 * is not invoked until something actually asks for the supplier. Building the builder is what
 * dereferences attribute holders ({@code new AttributeInstance} reads
 * {@code attribute.value().getDefaultValue()}), and those holders are only bound by
 * {@code MappedRegistry.freeze()}. WHEN that freeze happens is not the toolkit's to decide - with
 * fabric-api on the classpath, fabric-registry-sync delays it until after mod init, so an
 * entrypoint that builds attributes eagerly dies on "Trying to access unbound value". Deferring to
 * first use moves the dereference to entity construction, which is past every freeze in both
 * worlds, and makes registration order-independent.
 */
public final class ToolkitAttributes {
    private ToolkitAttributes() {}

    private static final Map<EntityType<?>, Supplier<AttributeSupplier.Builder>> PENDING = new ConcurrentHashMap<>();
    private static final Map<EntityType<?>, AttributeSupplier> BUILT = new ConcurrentHashMap<>();

    /**
     * Same shape as fabric's FabricDefaultAttributeRegistry.register, but deferred: the builder is
     * created on first use, not now. Pass a method reference - {@code MyEntity::createAttributes}.
     */
    public static void register(final EntityType<? extends LivingEntity> type,
                                final Supplier<AttributeSupplier.Builder> attributes) {
        PENDING.put(type, attributes);
        BUILT.remove(type);
    }

    /**
     * Eager form, kept for callers that already hold a built builder. Only safe once
     * {@code BuiltInRegistries} has frozen - i.e. NOT from a mod entrypoint when fabric-api is
     * present. Prefer {@link #register(EntityType, Supplier)}.
     */
    public static void register(final EntityType<? extends LivingEntity> type, final AttributeSupplier.Builder attributes) {
        PENDING.remove(type);
        BUILT.put(type, attributes.build());
    }

    public static @Nullable AttributeSupplier get(final EntityType<?> type) {
        AttributeSupplier built = BUILT.get(type);
        if (built != null) {
            return built;
        }
        Supplier<AttributeSupplier.Builder> pending = PENDING.get(type);
        if (pending == null) {
            return null;
        }
        // Not computeIfAbsent: the mapping function reaches into the attribute registry, and a
        // ConcurrentHashMap forbids re-entrant mutation of the map it is computing on.
        AttributeSupplier made = pending.get().build();
        BUILT.put(type, made);
        return made;
    }
}
