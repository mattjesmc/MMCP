package com.mattmc.mcptoolkit.drone;

import net.minecraft.core.component.DataComponents;
import net.minecraft.world.Container;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.ai.attributes.Attributes;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.ProjectileWeaponItem;
import net.minecraft.world.item.component.ItemAttributeModifiers;
import org.jspecify.annotations.Nullable;

/**
 * The hand reaches for a WEAPON before a swing, exactly as {@code DroneHands}' dig gate reaches
 * for the right pickaxe before a dig (toolkit 0.57.0). Same rule, other half of the game.
 *
 * <p><b>Why this exists, measured.</b> The dig gate auto-selects the fastest harvesting tool and
 * nothing ever selected back, so a mining body walked into every fight holding a pickaxe. Over the
 * whole recorded corpus (2026-08-12 audit) there are 1,798 fight-reflex ticks and 123 of them —
 * 6.8% — had a weapon in hand; in the 9h47m session of 2026-08-11 it was ZERO of 1,240, while the
 * agent crafted 29 swords it never once held. Vanilla prices that mistake precisely: a stone sword
 * is {@code sword(STONE, 3.0F, -2.4F)} = 5 damage at 1.6/s = 8 DPS, a stone pickaxe
 * {@code pickaxe(STONE, 1.0F, -2.8F)} = 3 at 1.2/s = 3.6 DPS. The body was fighting at under half
 * its own strength and died 37 times.
 *
 * <p><b>Ranked by DPS, from the item's own attributes</b> — never a hardcoded weapon list, so a
 * modded blade the toolkit has never heard of is ranked on the same terms as a sword (the modded
 * -data seam, 0.41.0). Damage-per-second rather than damage-per-swing because the swing paths here
 * strike on a rhythm: an axe out-hits a sword per blow and loses on the clock, which is why expert
 * play carries the sword.
 *
 * <p><b>Switching costs a cooldown, so it happens once.</b> {@code Player.tick} calls
 * {@code resetAttackStrengthTicker()} whenever the mainhand item CHANGES ITEM TYPE, so a gate that
 * re-armed every swing would hold the body at the 0.2 floor of vanilla's
 * {@code 0.2 + scale² × 0.8} charge curve forever — worse than the pickaxe it replaced. Hence
 * {@link #BETTER_BY}: switch only for a strictly better weapon, which by construction cannot fire
 * twice for the same pack.
 *
 * <p>PLAYER BODIES ONLY, mirroring the dig gate's asymmetry. The drone wields its selected slot or
 * whatever {@code bot_attack {item}} names, its damage comes from a flat entity attribute, and its
 * probe-pinned behaviour should not move under this change.
 */
final class WeaponGate {
    private WeaponGate() {}

    /** A candidate must beat the held weapon by this factor — the dig gate's 1.05, same reasoning:
     *  a switch is not free (here it costs a cooldown reset), so near-ties keep the hand as it is. */
    private static final double BETTER_BY = 1.05;

    /**
     * Damage-per-second this stack would give THIS body if it were in the mainhand, computed from
     * the stack's own attribute modifiers over the body's base attributes — the same numbers
     * vanilla applies when the item is equipped, asked without equipping it.
     */
    static double meleeDps(final ItemStack stack, final LivingEntity body) {
        ItemAttributeModifiers mods = stack.getOrDefault(DataComponents.ATTRIBUTE_MODIFIERS,
            ItemAttributeModifiers.EMPTY);
        double damage = mods.compute(Attributes.ATTACK_DAMAGE,
            body.getAttributeBaseValue(Attributes.ATTACK_DAMAGE), EquipmentSlot.MAINHAND);
        double speed = mods.compute(Attributes.ATTACK_SPEED,
            body.getAttributeBaseValue(Attributes.ATTACK_SPEED), EquipmentSlot.MAINHAND);
        return Math.max(0.0, damage) * Math.max(0.0, speed);
    }

    /** True if the stack adds any attack damage of its own — i.e. it is a weapon or a tool, not a
     *  block. Blocks and food compute to the body's bare-hand damage and must never be "armed". */
    private static boolean isArmament(final ItemStack stack, final LivingEntity body) {
        if (stack.isEmpty()) {
            return false;
        }
        double bare = body.getAttributeBaseValue(Attributes.ATTACK_DAMAGE);
        ItemAttributeModifiers mods = stack.getOrDefault(DataComponents.ATTRIBUTE_MODIFIERS,
            ItemAttributeModifiers.EMPTY);
        return mods.compute(Attributes.ATTACK_DAMAGE, bare, EquipmentSlot.MAINHAND) > bare + 1.0e-6;
    }

    /** The pack slot holding the highest-DPS armament, or -1 when the pack has none. */
    static int bestMeleeSlot(final Container inv, final LivingEntity body) {
        return bestMeleeSlot(inv, body, -1);
    }

    /**
     * The same question with one slot struck out — <b>"what would this body still have to swing with
     * if that were gone?"</b>
     *
     * <p>Which is not a hypothetical: a trident is {@code ATTACK_DAMAGE +8}, so it ranks top of this
     * very list, and throwing it is therefore the body disarming itself of its best weapon at the
     * exact moment it decided it had a fight (COMBAT_KIT_PLAN.md D2's disarm check). An unreachable
     * target is also the situation with the highest chance of a SECOND enemy that is not unreachable
     * at all, which is the one this matters for.
     */
    static int bestMeleeSlot(final Container inv, final LivingEntity body, final int except) {
        int best = -1;
        double bestDps = 0.0;
        for (int i = 0; i < inv.getContainerSize(); i++) {
            if (i == except) {
                continue;
            }
            ItemStack s = inv.getItem(i);
            if (!isArmament(s, body)) {
                continue;
            }
            double dps = meleeDps(s, body);
            if (best < 0 || dps > bestDps) {
                best = i;
                bestDps = dps;
            }
        }
        return best;
    }

    /**
     * Put the best carried weapon in the player's hand before a swing. Returns the item id now
     * held when the hand CHANGED, else null (already best-armed, nothing carried, or not a player
     * body). The selection rides {@code selectIntoHand}, so it is recorded as the hotbar press it
     * is — the training data shows the body choosing its weapon, which is the whole point.
     */
    static @Nullable String armMelee(final Hands hands) {
        if (hands.handsPlayer() == null) {
            return null;
        }
        LivingEntity body = hands.handsBody();
        int best = WeaponGate.bestMeleeSlot(hands.container(), body);
        if (best < 0 || best == hands.selectedSlot()) {
            return null;
        }
        ItemStack cand = hands.container().getItem(best);
        if (meleeDps(cand, body) <= meleeDps(hands.selectedStack(), body) * BETTER_BY) {
            return null;
        }
        DroneHands.selectIntoHand(hands, best);
        return DroneHands.itemId(hands.selectedStack().getItem());
    }

    /**
     * Put a carried bow/crossbow in the player's hand before a shot, so the shot is fired BY the
     * weapon (its enchantments, its identity in the verdict) instead of as a bare arrow that
     * happened to leave a body holding dirt. Same contract as {@link #armMelee}.
     *
     * <p>The candidate comes from {@link CombatKit#rangedSlot}, i.e. a weapon this pack can
     * actually FEED, not merely the first projectile weapon in it. A body carrying an empty
     * crossbow and a fed bow must not reach for the crossbow — 0.72.0 settled that carrying and
     * feeding is what "ranged" means, and the arming gate is the last place that could still
     * disagree with the decision that sent it here.
     */
    static @Nullable String armRanged(final Hands hands) {
        if (hands.handsPlayer() == null
                || (hands.selectedStack().getItem() instanceof ProjectileWeaponItem
                    && CombatKit.hasAmmo(hands, hands.selectedStack()))) {
            return null;
        }
        int slot = CombatKit.rangedSlot(hands);
        if (slot < 0) {
            return null;
        }
        DroneHands.selectIntoHand(hands, slot);
        return DroneHands.itemId(hands.selectedStack().getItem());
    }

    /**
     * Arm a pack slot the CALLER has already chosen, for the two acts where the ranking above does
     * not apply because the weapon IS the act: winding a crossbow ({@link Crossbows#load} — a bow
     * cannot be pre-loaded, so "the best ranged weapon" is the wrong question) and throwing a
     * trident ({@link CombatKit.Mode#THROW} — the throw is the reason the trident was chosen).
     *
     * <p>Still routed through here rather than calling {@code selectIntoHand} directly, so that
     * every path that puts a weapon in this body's hand is visible in ONE file. Returns the item id
     * now held when the hand CHANGED, else null — {@link #armMelee}'s contract.
     */
    static @Nullable String armSlot(final Hands hands, final int slot) {
        if (hands.handsPlayer() == null || slot < 0 || slot == hands.selectedSlot()) {
            return null;
        }
        DroneHands.selectIntoHand(hands, slot);
        return DroneHands.itemId(hands.selectedStack().getItem());
    }
}
