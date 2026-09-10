package com.example.examplemod.registry;

import net.minecraft.core.Registry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.Identifier;
import net.minecraft.resources.ResourceKey;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.Item;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockBehaviour;

/**
 * {@code examplemod:example_block} - scaffolded once by `gradlew scaffold` (mcp-toolkit), yours since.
 *
 * <p>Call {@link #register()} from your mod initializer, before anything reads the registries.
 * The creative tab is yours to add, because the hook is the loader's: Fabric API
 * {@code CreativeModeTabEvents.modifyOutputEvent(CreativeModeTabs.BUILDING_BLOCKS).register(o -> o.accept(RegisterExampleBlock.ITEM))};
 * NeoForge {@code BuildCreativeModeTabContentsEvent} on the mod bus, {@code event.accept(RegisterExampleBlock.ITEM)} for that tab key.
 */
public final class RegisterExampleBlock {
    public static final Identifier ID = Identifier.fromNamespaceAndPath("examplemod", "example_block");
    public static final ResourceKey<Block> BLOCK_KEY = ResourceKey.create(Registries.BLOCK, ID);
    public static final ResourceKey<Item> ITEM_KEY = ResourceKey.create(Registries.ITEM, ID);

    public static Block BLOCK;
    public static Item ITEM;

    private RegisterExampleBlock() {}

    public static void register() {
        BlockBehaviour.Properties props = BlockBehaviour.Properties.of()
            .strength(1.5F, 6.0F)
            .setId(BLOCK_KEY);
        BLOCK = Registry.register(BuiltInRegistries.BLOCK, BLOCK_KEY, new Block(props));
        ITEM = Registry.register(BuiltInRegistries.ITEM, ITEM_KEY,
            new BlockItem(BLOCK, new Item.Properties().useBlockDescriptionPrefix().setId(ITEM_KEY)));
    }
}
