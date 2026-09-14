package com.mattmc.mcptoolkit.mixin;

import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.ai.goal.GoalSelector;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;
import org.spongepowered.asm.mixin.gen.Invoker;

/**
 * The two protected members the re-entry tier needs on a live mob ({@code Reentry}, {@code
 * HOTSWAP_CEILING.md} §3): the goal selectors, and the method that fills them.
 *
 * <p>{@code registerGoals()} runs exactly once, from the constructor, on the server — so every mob
 * already in the world keeps the goal list the pre-swap code built. Re-running it is the re-entry,
 * and it is reached through an {@code @Invoker} rather than by reflection on purpose: the name
 * {@code registerGoals} exists only in a dev workspace, and a reflective lookup by that name would
 * answer {@code NoSuchMethodException} in any remapped install while the toolkit claimed to support
 * it. Mixin remaps this with the rest of the jar.
 *
 * <p>The invoker dispatches virtually, which is the whole point: the goals worth re-registering are
 * the ones a MOD's {@code Mob} subclass overrides.
 */
@Mixin(Mob.class)
public interface MobAccessor {

    @Accessor("goalSelector")
    GoalSelector mcptoolkit$goalSelector();

    @Accessor("targetSelector")
    GoalSelector mcptoolkit$targetSelector();

    @Invoker("registerGoals")
    void mcptoolkit$registerGoals();
}
