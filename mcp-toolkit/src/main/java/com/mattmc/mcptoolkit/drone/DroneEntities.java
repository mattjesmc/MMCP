package com.mattmc.mcptoolkit.drone;

import com.mattmc.mcptoolkit.McpToolkit;
import com.mattmc.mcptoolkit.hooks.ToolkitAttributes;
import com.mattmc.mcptoolkit.preview.PreviewEntity;
import net.minecraft.core.Registry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.Identifier;
import net.minecraft.resources.ResourceKey;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.MobCategory;

/** Registers the toolkit body entity types (flyer + walker) and their attributes. */
public final class DroneEntities {
    public static final Identifier DRONE_ID = Identifier.fromNamespaceAndPath(McpToolkit.MOD_ID, "drone");
    public static final ResourceKey<EntityType<?>> DRONE_KEY = ResourceKey.create(Registries.ENTITY_TYPE, DRONE_ID);

    public static final Identifier WALKER_ID = Identifier.fromNamespaceAndPath(McpToolkit.MOD_ID, "walker");
    public static final ResourceKey<EntityType<?>> WALKER_KEY = ResourceKey.create(Registries.ENTITY_TYPE, WALKER_ID);

    public static final EntityType<DroneEntity> DRONE =
        EntityType.Builder.of(DroneEntity::new, MobCategory.MISC)
            .sized(0.7F, 0.7F)          // a compact hovering ball
            .eyeHeight(0.35F)           // eye at the body's centre
            .clientTrackingRange(10)
            .build(DRONE_KEY);

    public static final Identifier PREVIEW_ID = Identifier.fromNamespaceAndPath(McpToolkit.MOD_ID, "preview");
    public static final ResourceKey<EntityType<?>> PREVIEW_KEY = ResourceKey.create(Registries.ENTITY_TYPE, PREVIEW_ID);

    public static final EntityType<WalkerEntity> WALKER =
        EntityType.Builder.of(WalkerEntity::new, MobCategory.MISC)
            .sized(0.6F, 1.8F)          // player-shaped, so player routes fit it
            .eyeHeight(1.62F)           // player eye line
            .clientTrackingRange(10)
            .build(WALKER_KEY);

    /**
     * The authoring stage (ENTITY_AUTHORING_DESIGN.md §3) - not a body: it wears a model and stands
     * still. {@code noSave} because a preview is scaffolding, and because a registered type saved
     * into a world that later opens without this mod's renderer is a client crash that persists in
     * the save. Its real size arrives per stage over {@code DATA_WIDTH}/{@code DATA_HEIGHT}; the
     * declared 1x1 is only what an unconfigured instance falls back to.
     */
    public static final EntityType<PreviewEntity> PREVIEW =
        EntityType.Builder.of(PreviewEntity::new, MobCategory.MISC)
            .sized(1.0F, 1.0F)
            .noSave()
            .fireImmune()
            .clientTrackingRange(10)
            .build(PREVIEW_KEY);

    private DroneEntities() {}

    /** True once every toolkit entity type is in the registry, whichever path put them there. */
    public static boolean registered() {
        return BuiltInRegistries.ENTITY_TYPE.containsKey(DRONE_ID)
            && BuiltInRegistries.ENTITY_TYPE.containsKey(WALKER_ID)
            && BuiltInRegistries.ENTITY_TYPE.containsKey(PREVIEW_ID);
    }

    /**
     * Called from {@code BuiltInRegistriesMixin}, before {@code BuiltInRegistries.freeze()}, and
     * again from {@link #bootstrap()} if that injection did not get there first. Idempotent, because
     * with fabric-api on the classpath BOTH callers fire, in that order reversed.
     *
     * <p>Types ONLY. Attributes deliberately do not happen here: building an
     * {@link net.minecraft.world.entity.ai.attributes.AttributeSupplier} dereferences holders like
     * {@code minecraft:max_health}, and those are not bound until {@code freeze()} runs. Doing both
     * in one pass fails with "Trying to access unbound value ... minecraft:max_health" - which is
     * why {@link ToolkitAttributes} takes a supplier and builds on first use instead.
     */
    public static void registerTypes() {
        if (registered()) {
            return;
        }
        Registry.register(BuiltInRegistries.ENTITY_TYPE, DRONE_KEY, DRONE);
        Registry.register(BuiltInRegistries.ENTITY_TYPE, WALKER_KEY, WALKER);
        Registry.register(BuiltInRegistries.ENTITY_TYPE, PREVIEW_KEY, PREVIEW);
    }

    /**
     * Called from {@code McpToolkit.onInitialize()}. Guarantees the body types exist and their
     * default attributes are declared, in EITHER of the two worlds the toolkit has to boot in.
     *
     * <p><b>Without fabric-api.</b> {@code Bootstrap.bootStrap()} calls
     * {@code BuiltInRegistries.bootStrap()}, which is {@code createContents(); freeze();}, and
     * {@code BuiltInRegistriesMixin} slipped {@link #registerTypes()} in at that {@code freeze()}
     * call - the same moment vanilla registers its own entity types. By the time an entrypoint
     * runs the registry is frozen and the types are already there, so this method only declares
     * attributes.
     *
     * <p><b>With fabric-api.</b> fabric-registry-sync's {@code BootstrapMixin} {@code @Redirect}s
     * {@code Bootstrap.bootStrap()}'s call to {@code BuiltInRegistries.bootStrap()} down to
     * {@code createContents()} alone: the freeze is DELAYED until after mod init (fabric's own
     * {@code MainMixin} / client {@code MinecraftMixin} call {@code BuiltInRegistries.bootStrap()}
     * there). So the toolkit's injection applies fine and simply never runs in time - the method it
     * lives in is not called during bootstrap at all. The registry an entrypoint sees is therefore
     * still OPEN, which is exactly the door every fabric mod registers through, so registering here
     * works. The mixin then fires later against types that already exist, and no-ops.
     *
     * <p>That is the whole compatibility story: the toolkit needs no fabric-api, and does not care
     * if it is there.
     */
    public static void bootstrap() {
        registerTypes();
        if (!registered()) {
            throw new IllegalStateException(
                "[MCP Toolkit] body entity types could not be registered. BuiltInRegistriesMixin did"
                    + " not apply during BuiltInRegistries.bootStrap(), and the registry was already"
                    + " frozen by the time onInitialize ran - so neither registration window was"
                    + " open. Something else on the classpath is moving the freeze.");
        }
        // Suppliers, not built builders: see ToolkitAttributes. With fabric-api present the
        // attribute registry is not frozen yet at this point, so building now would throw.
        ToolkitAttributes.register(DRONE, DroneEntity::createAttributes);
        ToolkitAttributes.register(WALKER, WalkerEntity::createAttributes);
        ToolkitAttributes.register(PREVIEW, PreviewEntity::createAttributes);
        McpToolkit.LOGGER.info("[MCP Toolkit] Registered entity types (drone, walker, preview).");
    }
}
