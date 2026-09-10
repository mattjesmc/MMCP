package com.mattmc.mcptoolkit.mixin;

import net.minecraft.world.inventory.ContainerData;
import net.minecraft.world.level.block.entity.BrewingStandBlockEntity;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

/**
 * The brewing stand's half of {@link AbstractFurnaceBlockEntityAccessor} — {@code DATA_BREW_TIME}
 * (ticks left, counting DOWN from 400) and {@code DATA_FUEL_USES} (brews left on the blaze powder,
 * of {@code FUEL_USES} 20), both public index constants on {@code BrewingStandBlockEntity}.
 *
 * <p>Brewing reached {@code bot_container} by accident and had no state readout at all:
 * {@code Containers.containerAt} resolves on {@code be instanceof Container} and a brewing stand is
 * one, so the body could already load and empty a stand it could not observe. Without these two
 * numbers "the bottles are still water bottles" is indistinguishable from "it is brewing right now",
 * and a body would take its potions out one tick before they became potions.
 */
@Mixin(BrewingStandBlockEntity.class)
public interface BrewingStandBlockEntityAccessor {

    @Accessor("dataAccess")
    ContainerData mcptoolkit$data();
}
