package com.mattmc.mcptoolkit.drone;

import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.Container;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

/**
 * The <b>hands contract</b> — v2 of the hand-verb surface (BOT_SURFACE_DESIGN.md §13.1), the
 * interface PlayerVerbs' v1 comment promised. Two body kinds have hands: the drone
 * ({@link BotBodyEntity}, a {@code SimpleContainer} + beams — behaviour unchanged from v1) and the
 * player ({@link PlayerHands} over {@link FakePlayerEntity} — the real 36-slot {@code Inventory},
 * arm swings, and the engine's own dig timing). Possessed mobs have none, and
 * {@link Actuator#hands()} keeps refusing for them.
 *
 * <p>This is deliberately the USED subset, nothing more: what {@code DroneHands}' verb bodies
 * actually ask of a body's hands. Anything else the verbs need (position, level, reach) already
 * lives on {@link Actuator}.
 */
interface Hands {

    /** The body these hands belong to. */
    LivingEntity handsBody();

    /** The carried items — a {@code SimpleContainer} (drone) or the player {@code Inventory}. */
    Container container();

    /** The held slot index — the default item for place/use/attack. */
    int selectedSlot();

    /** The held stack (selected slot). */
    ItemStack selectedStack();

    /**
     * Insert a stack, returning the LEFTOVER that did not fit (empty when fully inserted). The
     * caller decides what to do with overflow — every verb here spills it at the body's feet.
     */
    ItemStack insert(ItemStack stack);

    /**
     * The hands as a real player, or null for the drone — what {@code UseOnContext} and the dig
     * formula key on. Item behaviours that require a player get one when the body IS one.
     */
    @Nullable ServerPlayer handsPlayer();

    /**
     * How many ticks a dig of {@code state} at {@code pos} takes for THESE hands. The drone keeps
     * its {@code hardness × 10} house rule; the player prices with the engine's own formula
     * ({@code getDestroyProgress}: tool tier, efficiency, haste, fatigue, water, off-ground —
     * zero tuned constants, §11.6 decision 4's hands half).
     */
    int digTicks(ServerLevel level, BlockState state, BlockPos pos);

    /** Show a dig in progress at {@code at} (orange beam / arm swing); re-called per crack stage. */
    void digVisual(BlockPos at, int ticks);

    /** Clear any dig visual (the crack overlay itself is cleared by the caller, body-agnostic). */
    void clearDigVisual();

    /** Show an attack/shot toward {@code target} (red beam + lunge / arm swing). */
    void attackVisual(Vec3 target);

    /** Show a placement (arm swing for the player; the drone historically shows nothing). */
    default void placeVisual(BlockPos at) {
    }

    /** The body's hands, or null when this body kind has none (possessed mobs). */
    static @Nullable Hands of(final @Nullable LivingEntity body) {
        if (body instanceof BotBodyEntity drone) {
            return drone;
        }
        if (body instanceof FakePlayerEntity player) {
            return new PlayerHands(player);
        }
        return null;
    }

    /** The player adapter: real inventory, real swings, real dig physics. */
    record PlayerHands(FakePlayerEntity player) implements Hands {
        @Override
        public LivingEntity handsBody() {
            return player;
        }

        @Override
        public Container container() {
            return player.getInventory();
        }

        @Override
        public int selectedSlot() {
            return player.getInventory().getSelectedSlot();
        }

        @Override
        public ItemStack selectedStack() {
            return player.getInventory().getSelectedItem();
        }

        @Override
        public ItemStack insert(final ItemStack stack) {
            // Inventory.add mutates the stack down to what did NOT fit — that remainder is the
            // leftover this contract returns.
            player.getInventory().add(stack);
            return stack;
        }

        @Override
        public ServerPlayer handsPlayer() {
            return player;
        }

        @Override
        public int digTicks(final ServerLevel level, final BlockState state, final BlockPos pos) {
            float perTick = state.getDestroyProgress(player, level, pos);
            if (perTick <= 0.0F) {
                return Integer.MAX_VALUE; // unbreakable for these hands; callers gate on hardness first
            }
            return Math.max(1, (int) Math.ceil(1.0F / perTick));
        }

        @Override
        public void digVisual(final BlockPos at, final int ticks) {
            player.swing(InteractionHand.MAIN_HAND, true);
        }

        @Override
        public void clearDigVisual() {
            // Nothing lingers: a swing is momentary, the crack overlay is cleared by the caller.
        }

        @Override
        public void attackVisual(final Vec3 target) {
            player.swing(InteractionHand.MAIN_HAND, true);
        }

        @Override
        public void placeVisual(final BlockPos at) {
            player.swing(InteractionHand.MAIN_HAND, true);
        }
    }
}
