package com.mattmc.mcptoolkit.drone;

import com.mattmc.mcptoolkit.hooks.ServerHooks;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.ai.goal.target.NearestAttackableTargetGoal;
import net.minecraft.world.entity.monster.Monster;

/**
 * Hostiles hunt the walker like a player (SURVIVAL_MODE_PLAN.md; the survival smoke's second
 * complaint: "not being targeted by mobs"). Vanilla monsters target the {@code Player} class —
 * a mob body is invisible to their target goals no matter how player-shaped it is, which is the
 * same MISC-category finding that blanked P-survive (CATEGORY_P_DESIGN §status).
 *
 * <p>Mechanism: every {@link Monster} gets a {@link NearestAttackableTargetGoal} for
 * {@link WalkerEntity} at load, priority 3 — beside (not above) its player goal, with
 * {@code mustSee = true} so the acquisition respects line of sight like the player goal does.
 * Load-time injection touches no vanilla class and re-applies naturally: an entity re-created
 * from NBT at chunk load runs through the event again on its fresh goal selectors.
 *
 * <p>The flyer drone is deliberately NOT targetable: it is the copilot's camera, not a
 * playing body. This ends when the FakeServerPlayer becomes the survival body — a real
 * {@code ServerPlayer} is hunted by the vanilla goals themselves.
 */
public final class WalkerThreat {
    private WalkerThreat() {}

    public static void register() {
        ServerHooks.ENTITY_LOAD.register(entity -> {
            if (entity instanceof Monster monster && !(entity instanceof BotBodyEntity)) {
                Possession.targetSelector((Mob) monster)
                    .addGoal(3, new NearestAttackableTargetGoal<>(monster, WalkerEntity.class, true));
            }
        });
    }
}
