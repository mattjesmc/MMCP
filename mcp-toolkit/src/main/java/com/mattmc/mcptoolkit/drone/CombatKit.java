package com.mattmc.mcptoolkit.drone;

import java.util.function.Predicate;
import net.minecraft.core.component.DataComponents;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.Container;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.item.CrossbowItem;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.ProjectileWeaponItem;
import org.jspecify.annotations.Nullable;

/**
 * <b>Which of the hands' options this fight wants</b> — one decision site for the whole arsenal
 * (COMBAT_KIT_PLAN.md §4.1), sitting above {@link WeaponGate}, which answers only "of the melee
 * weapons carried, which is best".
 *
 * <p><b>The defect this closes.</b> 0.71.0 fixed the mainhand: a mining body no longer walks into a
 * fight holding a pickaxe. What it could not fix is the fight the body cannot walk to. In the
 * 9h47m survival run of 2026-08-11, <b>7 attack goals died {@code target_unreachable} against
 * targets the body could see perfectly well</b> — across a gap, across water, on a ledge — because
 * being unable to put the feet next to something was the end of the fight. Nothing ever asked
 * whether the pack held a bow. The other half is the offhand, which no path has ever filled: the
 * {@code shield} reflex has always refused with "no shield in the offhand", and nothing called
 * {@code bot_equip} to put one there.
 *
 * <p><b>Two questions, and nothing else.</b> {@link #choose} answers "what kind of fight is this,
 * and what should be in each hand"; {@link #equip} puts it there. Every verdict carries the
 * {@link Kit#why()} clause: a body that changes weapon class without saying why is exactly the
 * silent behaviour the 2026-08-11 audit had to reconstruct from tick envelopes.
 *
 * <p><b>What this deliberately does NOT decide yet.</b> {@link Mode#CHARGE} is declared because the
 * decision table has a row for it, and {@link #choose} never returns it: the spear is a MOVEMENT
 * behaviour — withdraw, sprint in, thrust — because 26.2 spears carry a {@code KINETIC_WEAPON}
 * component whose damage condition is on RELATIVE SPEED. Its run-up distance is a measurement, not
 * a guess, and the arena has not made it yet; a spear held today is fought as melee, which is
 * correct on its own attributes ({@link WeaponGate} ranks it top) and merely leaves damage on the
 * table. Declaring the word without choosing it is the honest state: the enum documents the design,
 * {@link #isSpear} is the detector that step will use, and no body performs a manoeuvre nobody has
 * measured.
 *
 * <p><b>{@link Mode#THROW} became reachable in step 5</b>, once D2 was settled — and it was settled
 * by dissolving its premise rather than answering it. The objection to auto-throwing a trident
 * without Loyalty was that a thrown trident is a dropped item and this body loses dropped items. It
 * no longer loses it silently: {@link Shots} reports where the trident came to rest and
 * {@link Retrieve} schedules the walk back for it once the fight is over. What survives of the
 * gate is the DISARM check ({@link #keepsAWeapon}) — a trident is also the best melee weapon a body
 * carrying one has, and throwing the only weapon in the pack at something unreachable is how the
 * throw kills you instead of the target.
 *
 * <p>PLAYER BODIES ONLY for the equipping half, mirroring {@link WeaponGate} and the dig gate: the
 * drone wields its selected slot, its damage is a flat entity attribute, and its probe-pinned
 * behaviour must not move under this change. The mode DECISION is body-agnostic — a drone that
 * cannot reach its target should still be told so with the reason.
 */
final class CombatKit {

    private CombatKit() {}

    /** What kind of fight this is. See the class note on CHARGE/THROW: declared, not yet chosen. */
    enum Mode {
        /** Close and swing — {@link WeaponGate} picks the item. */
        MELEE,
        /** Spear: withdraw, sprint in, thrust. Reserved; see the class note. */
        CHARGE,
        /** Shoot it — a bow/crossbow the pack can actually feed. */
        RANGED,
        /** Throw the trident: a one-shot ranged weapon that LEAVES THE HAND, so it is chosen only
         *  when nothing repeatable is carried. See the class note on D2 and the disarm check. */
        THROW
    }

    /**
     * Can the legs get there? <b>Not a new solver</b> — this is what the attack goal already
     * LEARNS and then threw away: three fruitless legs from the same cell
     * ({@code GoalRunner.tickAttack} → {@code target_unreachable}), a refused leg naming
     * {@code no_floor} or {@code fluid_ahead}, the knowledge-masked {@code check_path} verdict.
     * The callers that know pass what they know; everyone else passes {@link #UNKNOWN}.
     */
    enum Reachability {
        /** A path exists, or none has been tried and nothing says otherwise. */
        REACHABLE,
        /** Proven not walkable-to: the approach was attempted and conceded. */
        UNREACHABLE,
        /** Nobody asked. Treated as reachable — today's behaviour, so a bare {@code bot_attack}
         *  is unchanged — but it never SUPPRESSES a ranged choice the distance already earns. */
        UNKNOWN
    }

    /**
     * The chosen kit. {@code main}/{@code off} are what the mode WANTS in each hand (empty when it
     * wants nothing in particular); {@code standRange} is the mode's band default for callers with
     * no slot to clamp against — {@code Engage} remains the single owner of clamping an explicit
     * caller range into a band. {@code why} is the short clause every verdict must carry.
     */
    record Kit(Mode mode, ItemStack main, ItemStack off, double standRange, String why) {}

    /**
     * The melee decision ceiling: at or under this, close and swing. Deliberately a hair ABOVE
     * {@link Engage#MELEE_BAND_MAX} (3.25, the widest melee STATION any body family gets), so a
     * body standing correctly on its own melee station is never told to reach for a bow instead.
     */
    static final double MELEE_CEILING = 3.5;

    /**
     * The ranged decision floor — {@link Engage#RANGED_BAND_MIN} itself, so the mode and the
     * station it implies cannot disagree: the distance at which this class says "shoot" is the
     * same distance at which {@code Engage} would stand to shoot.
     *
     * <p>The gap {@code (MELEE_CEILING, RANGED_FLOOR]} is <b>hysteresis, and it is deliberate</b>:
     * it belongs to melee (keep approaching), so a target dancing at 4 blocks cannot make the body
     * oscillate between drawing a bow and raising a sword. Oscillation is worse than either
     * choice — every flip costs a hotbar swap, and a mainhand item change resets vanilla's
     * attack-strength ticker ({@code Player.tick}), so a flapping body fights permanently at the
     * 0.2 floor of the charge curve. That is the same cost {@code WeaponGate}'s {@code BETTER_BY}
     * margin exists to avoid paying, one level up.
     */
    static final double RANGED_FLOOR = Engage.RANGED_BAND_MIN;

    /**
     * Health at or below which a totem outranks a shield in the offhand — one hit from death, at
     * which point preventing SOME damage matters less than not dying at all
     * (COMBAT_KIT_PLAN.md D1).
     */
    static final float TOTEM_HEALTH = 6.0F;

    /**
     * Health at or above which a shield outranks a totem again. The gap to {@link #TOTEM_HEALTH}
     * is the offhand's hysteresis band, for the reason the distance band has one: natural regen
     * ticks a body across a bare threshold repeatedly, and an offhand swap is a real action. Inside
     * the band the current choice stands.
     */
    static final float SHIELD_HEALTH = 7.0F;

    // ---- the two questions -------------------------------------------------

    /**
     * Pick the mode and the kit for this engagement (COMBAT_KIT_PLAN.md §4.3). Pure: reads the
     * body, the pack and the geometry, writes nothing. {@link #equip} applies the answer.
     *
     * <p>The table, in order:
     * <pre>
     *   no melee weapon carried at all, ranged carried+fed  → RANGED  (at any distance)
     *   ≤ MELEE_CEILING, reachable                          → MELEE   (today's behaviour)
     *   (MELEE_CEILING, RANGED_FLOOR], reachable            → MELEE   (approach; hysteresis)
     *   &gt; RANGED_FLOOR, reachable, ranged carried + fed  → RANGED
     *   UNREACHABLE at any distance, ranged carried + fed    → RANGED  (the 7 dead goals)
     *   UNREACHABLE, no ranged option                       → MELEE, and `why` names what was
     *                                                         missing — the caller fails as today
     * </pre>
     *
     * <p><b>LINE OF SIGHT IS DELIBERATELY NOT A TERM HERE</b>, though §4.3's table listed it.
     * Gating the MODE on the sightline inverts the decision: "I cannot see it, so I will walk into
     * melee" is backwards, because <em>where the body stands is exactly what fixes a blocked
     * sightline</em> — that is what {@link Vantage} is for. Caught live on the F5 archer probe: the
     * body started behind the plateau it was supposed to climb, read no sightline, chose MELEE, was
     * given a melee anchor beside the enemy, walked out from cover, regained the sightline, flipped
     * back to RANGED and was sent back to the ledge — an anchor oscillating between two answers
     * every few ticks, with the body jittering on the spot between them and never climbing.
     *
     * <p>So the sightline belongs to the SHOT, not to the plan: {@code Engage} stations through
     * {@code Vantage.candidates}, which requires line of sight FROM THE CANDIDATE (the right place
     * to ask), and the hunt loop checks it at the moment it must choose between shooting and
     * conceding ({@code GoalRunner.concedeOrShoot}), where "the sightline is blocked too" is a
     * verdict rather than a plan.
     */
    static Kit choose(final LivingEntity body, final @Nullable Hands hands, final Entity target,
                      final Reachability reach) {
        double dist = body.distanceTo(target);
        boolean unreachable = reach == Reachability.UNREACHABLE;
        boolean far = dist > RANGED_FLOOR;
        ItemStack off = wantOffhand(body, hands);

        // A pack with NO melee armament does not close and punch. §4.3's table starts from a body
        // that has a choice; this row is the case it does not cover, and getting it wrong is loud:
        // bare hands are 1 damage, so a bow-only body told to fight at melee range walks into the
        // enemy's arms carrying the one weapon that wanted distance. A player does the opposite.
        // Ranged at EVERY distance here, which also keeps Engage's station backing the body out
        // rather than pulling it in.
        if (hands != null && WeaponGate.bestMeleeSlot(hands.container(), body) < 0) {
            int only = rangedSlot(hands);
            if (only >= 0) {
                ItemStack weapon = hands.container().getItem(only);
                return new Kit(Mode.RANGED, weapon, off, Engage.RANGED_DEFAULT,
                    "no melee weapon carried — " + DroneHands.itemId(weapon.getItem())
                        + " is the whole arsenal");
            }
        }

        // Melee is the answer unless the fight is out of the legs' hands — either proven
        // unreachable, or simply further than an approach should be spent on.
        if (!unreachable && !far) {
            String why = dist <= MELEE_CEILING ? "in reach" : "closing";
            return new Kit(Mode.MELEE, bestMelee(body, hands), off, meleeStand(body), why);
        }

        // A ranged option is a projectile weapon the pack can actually FEED (or one already
        // charged). A bow with no arrows is not an option, and saying so by name is the whole
        // point of the `why` clause: "no arrows" and "no bow" are different problems with
        // different fixes, and the agent can only act on the one it is told.
        int slot = hands == null ? -1 : rangedSlot(hands);
        if (slot >= 0) {
            ItemStack weapon = hands.container().getItem(slot);
            return new Kit(Mode.RANGED, weapon, off, Engage.RANGED_DEFAULT,
                (unreachable ? "target cannot be walked to" : "target is " + round(dist)
                    + " blocks off") + ", " + DroneHands.itemId(weapon.getItem()) + " carried");
        }

        // NO BOW, BUT A SPEAR THAT FLIES. Last in the ranged pecking order on purpose: a trident is
        // a one-shot ranged weapon that leaves the hand, so it is what a body reaches for only when
        // there is no repeatable option at all.
        int tslot = hands == null ? -1 : throwSlot(hands);
        if (tslot >= 0 && keepsAWeapon(body, hands, tslot)) {
            ItemStack trident = hands.container().getItem(tslot);
            return new Kit(Mode.THROW, trident, off, Engage.RANGED_DEFAULT,
                (unreachable ? "target cannot be walked to" : "target is " + round(dist)
                    + " blocks off") + ", nothing to shoot with, and a "
                    + DroneHands.itemId(trident.getItem()) + " can be thrown");
        }

        // No ranged option. Melee, and the clause names the missing capability rather than the
        // symptom — `target_unreachable` alone sent the 2026-08-11 agent looking for a path bug
        // seven times when what it needed was a bow.
        return new Kit(Mode.MELEE, bestMelee(body, hands), off, meleeStand(body),
            unreachable ? "unreachable, and " + missingRanged(hands, tslot)
                : "too far to shoot, and " + missingRanged(hands, tslot));
    }

    /**
     * The kit for a SWING, where the mode is not actually in question: {@code bot_attack} has
     * already passed its reach gate and the caller asked for a blow, not for advice.
     *
     * <p>Without this, one row of {@link #choose}'s table bites: a body whose pack holds a bow and
     * NO melee weapon is told {@code RANGED} at any distance (correctly — it should back off and
     * shoot), and a swing site that took that literally would arm the bow, hit the target with it
     * for about one damage, and file a verdict reading {@code mode: ranged} for a melee blow. So
     * the mode is forced here and only the two useful halves are kept: the {@code why} — "no melee
     * weapon carried" is exactly what the agent needs to hear as its body clubs a zombie with a
     * bow — and the offhand, which is a different slot and a different decision.
     */
    static Kit forSwing(final LivingEntity body, final @Nullable Hands hands, final Entity target) {
        Kit k = choose(body, hands, target, Reachability.UNKNOWN);
        return k.mode() == Mode.MELEE ? k
            : new Kit(Mode.MELEE, bestMelee(body, hands), k.off(), meleeStand(body), k.why());
    }

    /**
     * The kit for a SHOT, where — as with {@link #forSwing} — the mode is not in question: the
     * caller asked for an arrow, so the only open questions are which carried weapon answers it and
     * what the offhand should hold while it does.
     *
     * <p>{@code main} is EMPTY when the body cannot shoot at all, and the {@code why} then names
     * which half is missing (the weapon or the ammunition) rather than the symptom — "no bow or
     * crossbow carried" is a thing an agent can act on; "item_missing" alone sent the 2026-08-11
     * agent looking for arrows it already had.
     *
     * <p><b>The trident is the fallback, never the first answer.</b> A bow the pack can feed and a
     * loaded crossbow are both repeatable; a throw spends the weapon. So {@link Mode#THROW} is
     * reached only when {@link #rangedSlot} has nothing, and {@code allowThrow} is the caller's
     * brake on even that (COMBAT_KIT_PLAN.md D2): the default is to throw, because the loss is no
     * longer silent — the body reports where the trident lies and {@link Retrieve} schedules the
     * walk back for it — but "do not spend THIS trident on THIS zombie" is a judgement only the
     * caller can make.
     */
    static Kit forShot(final LivingEntity body, final @Nullable Hands hands, final Entity target,
                       final boolean allowThrow) {
        ItemStack off = wantOffhand(body, hands);
        int slot = hands == null ? -1 : rangedSlot(hands);
        if (slot >= 0) {
            ItemStack weapon = hands.container().getItem(slot);
            return new Kit(Mode.RANGED, weapon, off, Engage.RANGED_DEFAULT,
                "a shot was asked for, " + DroneHands.itemId(weapon.getItem()) + " carried");
        }
        int tslot = hands == null ? -1 : throwSlot(hands);
        // The disarm check does NOT apply here and that asymmetry is the point: this is an explicit
        // act, and refusing a caller their own trident because the body would be left swinging bare
        // hands is the toolkit second-guessing a decision it was handed. It applies to `choose`,
        // where nobody asked.
        if (tslot >= 0 && allowThrow) {
            ItemStack trident = hands.container().getItem(tslot);
            return new Kit(Mode.THROW, trident, off, Engage.RANGED_DEFAULT,
                "a shot was asked for, and a " + DroneHands.itemId(trident.getItem())
                    + " is the only thing carried that flies");
        }
        return new Kit(Mode.RANGED, ItemStack.EMPTY, off, Engage.RANGED_DEFAULT,
            tslot >= 0 ? "a " + DroneHands.itemId(hands.container().getItem(tslot).getItem())
                + " is carried, but allow_throw is false — a thrown trident leaves the hand"
                : missingRanged(hands, -1));
    }

    /**
     * Put the chosen kit in the hands. Mainhand rides {@link WeaponGate} — the ONE arming seam, so
     * the hotbar press is recorded exactly as 0.71.0 records it — and the offhand rides
     * {@link PlayerVerbs#equipFromPack}, so armor bookkeeping stays in one place. Returns what
     * CHANGED, for the verdict, or null when the hands were already right.
     *
     * <p>Player bodies only (see the class note). A null return is the normal case in a steady
     * fight: nothing swaps when nothing needs to.
     */
    static @Nullable Equipped equip(final Hands hands, final Kit kit) {
        if (hands.handsPlayer() == null) {
            return null;
        }
        // A THROW arms the exact stack the kit chose, not "the best" of anything. Both ranking
        // gates would pick the wrong item here: armMelee ranks by DPS, so a body carrying a
        // netherite sword and a trident would come up holding the sword and throw THAT (it cannot;
        // the release would produce nothing), and armRanged asks rangedSlot, which does not consider
        // tridents at all because they are not ProjectileWeaponItems.
        String main = switch (kit.mode()) {
            case RANGED -> WeaponGate.armRanged(hands);
            case THROW -> WeaponGate.armSlot(hands, slotOf(hands, kit.main()));
            default -> WeaponGate.armMelee(hands);
        };
        String off = equipOffhand(hands, kit.off());
        return main == null && off == null ? null : new Equipped(main, off);
    }

    /** What {@link #equip} actually changed: the new mainhand id, the new offhand id, or nulls. */
    record Equipped(@Nullable String main, @Nullable String off) {}

    /**
     * Stamp the kit's facts onto a verdict (COMBAT_KIT_PLAN.md §4.6 — non-negotiable, because the
     * 2026-08-11 audit had to reconstruct every one of them from tick envelopes). {@code mode} and
     * {@code why} say what kind of fight the body decided this was; the two {@code *_switched}
     * fields say what it changed in its hands to fight it.
     *
     * <p>Null-tolerant on every argument: a drone swing has no kit and switches nothing, and must
     * not gain empty keys for facts that do not apply to it.
     */
    static void report(final com.google.gson.JsonObject o, final @Nullable Kit kit,
                       final @Nullable String weaponSwitched, final @Nullable String offhandSwitched) {
        if (kit != null) {
            o.addProperty("mode", kit.mode().name().toLowerCase(java.util.Locale.ROOT));
            o.addProperty("why", kit.why());
        }
        if (weaponSwitched != null) {
            o.addProperty("weapon_switched", weaponSwitched);
        }
        if (offhandSwitched != null) {
            o.addProperty("offhand_switched", offhandSwitched);
        }
    }

    // ---- the offhand (COMBAT_KIT_PLAN.md §4.2) ------------------------------

    /**
     * <b>The contention nobody can avoid</b>: a shield and a totem want the same slot, both are
     * real survival value, and the mainhand belongs to the weapon. D1's answer:
     *
     * <ul>
     *   <li>no shield carried → the totem, if one is carried;</li>
     *   <li>healthy (≥ {@link #SHIELD_HEALTH}) → the <b>shield</b>. It PREVENTS damage; a totem
     *       only converts a death into 1 HP and is consumed doing it;</li>
     *   <li>at or below {@link #TOTEM_HEALTH} → the <b>totem</b>, because one more hit is death
     *       and a 90° arc is not a promise;</li>
     *   <li>between the two → whatever is already held (the hysteresis band).</li>
     * </ul>
     *
     * <p>Read off the ITEMS' OWN components, never a name list: {@code DEATH_PROTECTION} is what
     * {@code LivingEntity.checkTotemDeathProtection} consumes and {@code BLOCKS_ATTACKS} is what
     * {@code LivingEntity.getItemBlockingWith} reads, so a modded totem or shield works here on
     * the same terms as vanilla's (the modded-data seam, 0.41.0).
     *
     * @return the stack that should be in the offhand — possibly the one already there — or
     *     {@link ItemStack#EMPTY} when the pack holds neither
     */
    static ItemStack wantOffhand(final LivingEntity body, final @Nullable Hands hands) {
        if (hands == null || hands.handsPlayer() == null) {
            return ItemStack.EMPTY;
        }
        ItemStack held = body.getItemBySlot(EquipmentSlot.OFFHAND);
        ItemStack shield = held.has(DataComponents.BLOCKS_ATTACKS) ? held : find(hands,
            s -> s.has(DataComponents.BLOCKS_ATTACKS));
        ItemStack totem = held.has(DataComponents.DEATH_PROTECTION) ? held : find(hands,
            s -> s.has(DataComponents.DEATH_PROTECTION));
        if (shield.isEmpty()) {
            return totem;
        }
        if (totem.isEmpty()) {
            return shield;
        }
        float health = body.getHealth();
        if (health <= TOTEM_HEALTH) {
            return totem;
        }
        if (health >= SHIELD_HEALTH) {
            return shield;
        }
        return held.isEmpty() ? shield : held; // inside the band: no swap
    }

    /**
     * Does this body carry anything it could BLOCK with — in the offhand already, or in the pack for
     * {@link Shields} to reach for? The other half of {@link #wantOffhand}'s answer, and the
     * difference between two refusals an agent must be able to tell apart: "you have no shield"
     * (carry one) and "you have one, but you are hurt enough that the policy is holding the totem
     * instead" (heal, or accept the trade).
     *
     * <p>The {@code BLOCKS_ATTACKS} component, never an id list — it is what
     * {@code LivingEntity.getItemBlockingWith} itself reads, so a modded shield answers on the same
     * terms as vanilla's (the modded-data seam, 0.41.0).
     */
    static boolean carriesBlocker(final LivingEntity body, final @Nullable Hands hands) {
        if (body.getItemBySlot(EquipmentSlot.OFFHAND).has(DataComponents.BLOCKS_ATTACKS)) {
            return true;
        }
        if (hands == null) {
            return false;
        }
        Container inv = hands.container();
        for (int i = 0; i < inv.getContainerSize(); i++) {
            if (inv.getItem(i).has(DataComponents.BLOCKS_ATTACKS)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Move {@code want} into the offhand if it is not already there. Returns the item id when the
     * offhand CHANGED (the {@code offhand_switched} fact), else null.
     *
     * <p>Callable on its own for the one path that must NOT re-arm the mainhand: an attack whose
     * caller named {@code item}. That is the caller's explicit choice of weapon and the automatic
     * gate must not overrule it — but the offhand is a different slot and a different decision,
     * and leaving it empty because the mainhand was specified would be the 0.71.0 bug in miniature.
     */
    static @Nullable String equipOffhand(final Hands hands, final ItemStack want) {
        if (want.isEmpty()) {
            return null;
        }
        ServerPlayer fp = hands.handsPlayer();
        if (fp == null) {
            return null;
        }
        ItemStack held = fp.getItemBySlot(EquipmentSlot.OFFHAND);
        // Identity, not equality: `want` is either the live offhand stack itself (nothing to do)
        // or a live PACK stack (move it). Two separate iron shields must not read as "already
        // equipped" and leave the pack copy sitting there — and must not swap themselves either.
        if (held == want) {
            return null;
        }
        Container inv = hands.container();
        for (int i = 0; i < inv.getContainerSize(); i++) {
            if (inv.getItem(i) == want) {
                // READ THE ID FIRST. equipFromPack MOVES the stack — it empties the pack slot in
                // place (`setCount(0)`), and `want` is that very stack, so asking it what it was
                // afterwards answers "minecraft:air". Live-caught by the probe: the shield and the
                // totem both went to the offhand correctly and both reported themselves as air.
                String id = DroneHands.itemId(want.getItem());
                PlayerVerbs.equipFromPack(fp, EquipmentSlot.OFFHAND, i);
                return id;
            }
        }
        return null; // it vanished between choose() and equip() — nothing to report
    }

    // ---- detectors ---------------------------------------------------------

    /**
     * A 26.2 spear: the {@code KINETIC_WEAPON} component, which is what
     * {@code Item.Properties.spear(...)} builds and what makes the weapon's damage a function of
     * RELATIVE SPEED. Component, not a name suffix, so a modded spear reads as one.
     */
    static boolean isSpear(final ItemStack stack) {
        return stack.has(DataComponents.KINETIC_WEAPON);
    }

    /** A weapon that is also a projectile — the trident, and anything modded that behaves like it. */
    static boolean isThrowable(final ItemStack stack) {
        return stack.getItem() instanceof net.minecraft.world.item.TridentItem;
    }

    /**
     * The pack slot holding a trident this body could actually throw, or -1.
     *
     * <p>Two of vanilla's own refusals are checked HERE rather than discovered at the release,
     * because {@code TridentItem.use} answers them by returning {@code FAIL} — which means
     * {@code startUsingItem} never happens and the body simply stands there holding a trident,
     * with nothing anywhere saying why. A weapon that cannot be used is not an option:
     * <ul>
     *   <li>{@code nextDamageWillBreak()} — the throw would destroy it, so vanilla declines;</li>
     *   <li><b>Riptide out of water and rain.</b> {@code releaseUsing} launches the PLAYER rather
     *       than the trident when {@code getTridentSpinAttackStrength > 0}, and {@code use} refuses
     *       outright when that body is dry. A Riptide trident is therefore not a ranged weapon at
     *       all in the open, which is a fact about the enchantment and not about this body.</li>
     * </ul>
     */
    static int throwSlot(final @Nullable Hands hands) {
        if (hands == null || hands.handsPlayer() == null) {
            return -1;
        }
        ServerPlayer p = hands.handsPlayer();
        Container inv = hands.container();
        for (int i = 0; i < inv.getContainerSize(); i++) {
            ItemStack s = inv.getItem(i);
            if (!isThrowable(s) || s.nextDamageWillBreak()) {
                continue;
            }
            if (net.minecraft.world.item.enchantment.EnchantmentHelper
                    .getTridentSpinAttackStrength(s, p) > 0.0F && !p.isInWaterOrRain()) {
                continue;
            }
            return i;
        }
        return -1;
    }

    /**
     * <b>The disarm check</b> (COMBAT_KIT_PLAN.md D2): would this body still have something to swing
     * with after throwing what is in {@code slot}?
     *
     * <p>A trident is {@code ATTACK_DAMAGE +8} and {@link WeaponGate} therefore ranks it top of the
     * melee list — so an automatic throw is the body voluntarily giving up its best weapon at the
     * moment it has decided it is in a fight. That trade is worth making when there is another blade
     * in the pack and reckless when the trident IS the pack: "unreachable target" is precisely the
     * situation with the best odds of a second enemy that is not unreachable at all, and a bare
     * body meeting it is how the throw kills you rather than the target.
     *
     * <p>An automatic decision only. {@link #forShot} deliberately skips it — a caller who asked for
     * the throw has made this judgement themselves, and overriding it would be the toolkit
     * second-guessing an instruction.
     */
    private static boolean keepsAWeapon(final LivingEntity body, final Hands hands, final int slot) {
        return WeaponGate.bestMeleeSlot(hands.container(), body, slot) >= 0;
    }

    /**
     * <b>Can this body fight at range at all?</b> The target-free half of the mode question, and
     * the one {@code Engage} asks to pick which BAND to station in — a decision made before there
     * is anything to shoot at.
     *
     * <p>This replaces {@code Engage.holdsRangedWeapon}, which asked whether the bow was in the
     * HAND. That was the same defect {@link WeaponGate} exists to fix, one level up: a body with a
     * bow in the pack and a pickaxe selected read as melee and stationed inside a zombie's reach.
     * Carrying the weapon and being able to feed it is the capability; which hand it is in is a
     * detail the arming gate settles at the moment of the shot.
     */
    static boolean rangedCapable(final @Nullable Hands hands) {
        return hands != null && rangedSlot(hands) >= 0;
    }

    /**
     * The pack slot holding a projectile weapon this body can actually FIRE, or -1. A charged
     * crossbow wins outright — it needs no draw and no ammo, so it is the fastest shot available —
     * and otherwise the first weapon the pack can feed.
     */
    static int rangedSlot(final Hands hands) {
        Container inv = hands.container();
        int fed = -1;
        for (int i = 0; i < inv.getContainerSize(); i++) {
            ItemStack s = inv.getItem(i);
            if (!(s.getItem() instanceof ProjectileWeaponItem)) {
                continue;
            }
            if (CrossbowItem.isCharged(s)) {
                return i;
            }
            if (fed < 0 && hasAmmo(hands, s)) {
                fed = i;
            }
        }
        return fed;
    }

    /**
     * Can this weapon be fired from this pack? Asked through the WEAPON'S OWN
     * {@code getAllSupportedProjectiles} predicate, so a crossbow's fireworks and any modded
     * ammunition count without a list here.
     */
    static boolean hasAmmo(final Hands hands, final ItemStack weapon) {
        if (!(weapon.getItem() instanceof ProjectileWeaponItem pw)) {
            return false;
        }
        if (CrossbowItem.isCharged(weapon)) {
            return true; // already loaded: the shot needs nothing more from the pack
        }
        Predicate<ItemStack> supported = pw.getAllSupportedProjectiles();
        Container inv = hands.container();
        for (int i = 0; i < inv.getContainerSize(); i++) {
            if (supported.test(inv.getItem(i))) {
                return true;
            }
        }
        // Vanilla's own last resort (Player.getProjectile): an infinite-materials body always has
        // an arrow, and refusing one a real client would fire would be a fiction of our own.
        ServerPlayer p = hands.handsPlayer();
        return p != null && p.hasInfiniteMaterials();
    }

    // ---- helpers -----------------------------------------------------------

    /** Where in the pack a stack the Kit is holding a reference to actually lives. Identity, not
     *  equality, for {@link #equipOffhand}'s reason: two tridents must not read as each other. */
    private static int slotOf(final Hands hands, final ItemStack stack) {
        Container inv = hands.container();
        for (int i = 0; i < inv.getContainerSize(); i++) {
            if (inv.getItem(i) == stack) {
                return i;
            }
        }
        return -1;
    }

    /** The first pack stack matching {@code test}, or empty. Returns the LIVE stack: the offhand
     *  move is a move, and identity is how {@link #equipOffhand} finds it again. */
    private static ItemStack find(final Hands hands, final Predicate<ItemStack> test) {
        Container inv = hands.container();
        for (int i = 0; i < inv.getContainerSize(); i++) {
            ItemStack s = inv.getItem(i);
            if (!s.isEmpty() && test.test(s)) {
                return s;
            }
        }
        return ItemStack.EMPTY;
    }

    /** The melee weapon {@link WeaponGate} would reach for, WITHOUT reaching for it — the Kit is a
     *  description; {@link #equip} is the only thing that moves an item. */
    private static ItemStack bestMelee(final LivingEntity body, final @Nullable Hands hands) {
        if (hands == null) {
            return body.getMainHandItem();
        }
        int slot = WeaponGate.bestMeleeSlot(hands.container(), body);
        return slot < 0 ? hands.selectedStack() : hands.container().getItem(slot);
    }

    /** The melee band default for this body, clamped by its own reach — {@code Engage}'s number,
     *  asked without a slot (callers that HAVE one let Engage clamp their explicit range). */
    private static double meleeStand(final LivingEntity body) {
        return Math.min(Engage.MELEE_DEFAULT, Engage.meleeStandMax(body));
    }

    /**
     * Which half of the ranged capability the pack is missing — the weapon or the ammunition, and
     * (since step 5) the third case: a trident IS carried but the disarm check is holding it,
     * because throwing it would leave the body with nothing to swing. That is the one of the three
     * an agent could otherwise never work out, since the capability is visibly in the pack.
     */
    static String missingRanged(final @Nullable Hands hands, final int heldBackTrident) {
        if (hands == null) {
            return "this body has no hands to carry a ranged weapon";
        }
        if (heldBackTrident >= 0) {
            return "the only thing carried that flies is a "
                + DroneHands.itemId(hands.container().getItem(heldBackTrident).getItem())
                + ", and it is also the only weapon carried — throwing it would leave the body "
                + "bare-handed against whatever comes next. Carry a second weapon and it will be "
                + "thrown, or ask for the throw outright (allow_throw)";
        }
        if (carriesRangedWeapon(hands)) {
            Container inv = hands.container();
            for (int i = 0; i < inv.getContainerSize(); i++) {
                ItemStack s = inv.getItem(i);
                if (s.getItem() instanceof ProjectileWeaponItem) {
                    return "the " + DroneHands.itemId(s.getItem()) + " carried has nothing to fire";
                }
            }
        }
        return "no bow or crossbow carried";
    }

    /** Is a projectile weapon carried AT ALL — fed or not? The other half of {@link #rangedSlot}'s
     *  answer, and the difference between "you need arrows" and "you need a bow". */
    static boolean carriesRangedWeapon(final @Nullable Hands hands) {
        if (hands == null) {
            return false;
        }
        Container inv = hands.container();
        for (int i = 0; i < inv.getContainerSize(); i++) {
            if (inv.getItem(i).getItem() instanceof ProjectileWeaponItem) {
                return true;
            }
        }
        return false;
    }

    /**
     * How many rounds this weapon could still fire from this pack — asked through the WEAPON'S OWN
     * predicate, so a crossbow's fireworks and any modded ammunition count without a list here.
     * -1 for a body that draws from nothing (creative/infinite materials), which is not zero and
     * must not read as an empty quiver.
     */
    static int countAmmo(final @Nullable Hands hands, final ItemStack weapon) {
        if (hands == null || !(weapon.getItem() instanceof ProjectileWeaponItem pw)) {
            return 0;
        }
        ServerPlayer p = hands.handsPlayer();
        if (p != null && p.hasInfiniteMaterials()) {
            return -1;
        }
        Predicate<ItemStack> supported = pw.getAllSupportedProjectiles();
        Container inv = hands.container();
        int n = 0;
        for (int i = 0; i < inv.getContainerSize(); i++) {
            ItemStack s = inv.getItem(i);
            if (!s.isEmpty() && supported.test(s)) {
                n += s.getCount();
            }
        }
        return n;
    }

    private static double round(final double d) {
        return Math.round(d * 10.0) / 10.0;
    }
}
