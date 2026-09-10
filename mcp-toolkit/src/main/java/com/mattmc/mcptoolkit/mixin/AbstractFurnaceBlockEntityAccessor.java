package com.mattmc.mcptoolkit.mixin;

import net.minecraft.world.inventory.ContainerData;
import net.minecraft.world.level.block.entity.AbstractFurnaceBlockEntity;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

/**
 * <b>The counters a furnace's screen is fed from</b>, for {@code bot_container}'s readout: burn
 * ticks left and cook progress, at {@code DATA_LIT_TIME} / {@code DATA_LIT_DURATION} /
 * {@code DATA_COOKING_PROGRESS} / {@code DATA_COOKING_TOTAL_TIME}.
 *
 * <p>These are real server state — the furnace ticks them, they persist to disk, and every player
 * watching the screen sees them. They are simply not <em>publicly</em> readable: the block entity
 * keeps them in private ints behind a {@code protected final ContainerData dataAccess}, the channel
 * that exists to sync a menu.
 *
 * <p><b>Why this exists at all.</b> {@code Containers}' original note said a cook-progress
 * percentage would not be reported rather than "invented or prised out by reflection", and that was
 * right about reflection. But the tool's own description had been promising {@code cook_progress}
 * and {@code fuel_ticks} to every caller since it shipped and neither was ever emitted — and a
 * description that lies is worse than either choice. Given a real decision between deleting the
 * promise and keeping it, the promise is worth keeping: {@code lit} answers "is it burning" but not
 * the question a body actually has — <em>should I wait here or walk away, and will this fuel outlast
 * this smelt?</em> An {@code @Accessor} is this toolkit's established, typed, loader-neutral way to
 * reach server state the API hides (see {@link ServerPlayerGameModeAccessor}); it is checked at
 * mixin-apply time and so fails loudly at startup rather than silently at runtime.
 *
 * <p>Read-only by design: nothing calls {@code ContainerData.set}. Writing a cook timer would be
 * hurrying a furnace, the exact false success {@code Containers} exists to refuse.
 */
@Mixin(AbstractFurnaceBlockEntity.class)
public interface AbstractFurnaceBlockEntityAccessor {

    @Accessor("dataAccess")
    ContainerData mcptoolkit$data();
}
