package com.mattmc.mcptoolkit.drone;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.EventLog;
import java.util.concurrent.CompletableFuture;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.Block;
import org.jspecify.annotations.Nullable;

/**
 * The PLAYER body's native verb implementations (§11.8 widening, v1). Where {@code DroneHands}
 * drives a {@code SimpleContainer} and hand-rolled combat, a real {@code ServerPlayer} already has
 * the machinery — a 36-slot {@link Inventory} that auto-collects drops, {@code Player.attack} with
 * real crits/enchants/sweep, {@code FoodData} that food actually feeds. These branches call THAT,
 * mirroring the drone verbs' response shapes so callers cannot tell the bodies apart by contract.
 *
 * <p>v2 unifies the two through a Hands interface; v1 keeps the drone paths byte-identical and adds
 * these beside them (the same interim-vs-real trade as the walker renderer).
 */
final class PlayerVerbs {
    private PlayerVerbs() {}

    /** {@code bot_attack} — the player's own combat: crits, enchants, held-item damage, sweep.
     *  The F1 facing+LOS gate has already passed upstream ({@code DroneHands.performSwing});
     *  {@code actionId} non-null marks a post-turn async completion (rides the event). */
    static JsonObject attack(final DroneTools.Slot slot, final FakePlayerEntity fp,
                             final Entity target, final @Nullable String actionId) {
        JsonObject r = new JsonObject();
        float before = target instanceof LivingEntity le ? le.getHealth() : -1;
        // How charged the swing is, on vanilla's own curve (Player.baseDamageScaleFactor =
        // 0.2 + scale² × 0.8). REPORTED, not enforced: the rhythm swing paths here strike on a
        // fixed cadence, so a body holding a slow item lands part-charged blows and the verdict
        // has never said so. The 2026-08-11 session swung at a median 13 ticks while holding
        // pickaxes that want 16.7 — about 69% damage per blow, invisible in every reply.
        float charge = fp.getAttackStrengthScale(0.5F);
        fp.attack(target);
        fp.swing(InteractionHand.MAIN_HAND, true);
        // The attack button (world-model DESIGN.md §9 Phase 3): a combat swing is one attack press.
        com.mattmc.mcptoolkit.wm.Wm.actionPress(fp, false, true, -1);
        float after = target instanceof LivingEntity le ? le.getHealth() : -1;
        boolean hit = before < 0 || after < before;

        r.addProperty("ok", true);
        r.addProperty("hit", hit);
        r.addProperty("charge", Math.round(charge * 100.0) / 100.0);
        ItemStack held = fp.getMainHandItem();
        if (!held.isEmpty()) {
            r.addProperty("weapon", DroneHands.itemId(held.getItem()));
        }
        r.add("target", DroneHands.describeTarget(target, after));
        if (before >= 0) {
            r.addProperty("damageDealt", Math.max(0, before - after));
        }
        int targetId = target.getId();
        // WHAT THE BLOW WAS STRUCK WITH rides the completion event, not just the synchronous
        // reply: on the async path (the body turned first) the reply is {started, action_id} and
        // every later reader — a waiting caller, the event stream, the episodes an eval is built
        // from — could see that a swing landed but never with what. That is the exact blindness
        // the 2026-08-11 audit had to reconstruct from tick envelopes.
        String weapon = held.isEmpty() ? null : DroneHands.itemId(held.getItem());
        DroneHands.emitDone(slot, "bot_attack", d -> {
            if (actionId != null) {
                d.addProperty("action_id", actionId);
            }
            d.addProperty("target_id", targetId);
            d.addProperty("hit", hit);
            d.addProperty("weapon", weapon);
        });
        return r;
    }

    /**
     * One in-flight REAL consumption ({@link DroneTools.Slot#chew}): the food/potion is in the
     * hand, {@code startUsingItem} has begun the vanilla ~32-tick use — eating pose, munch
     * particles and sounds broadcast to every watcher — and vanilla's own
     * {@code completeUsingItem} will apply the nutrition/effects and any remainder (glass
     * bottle). This watch only OBSERVES completion; it consumes nothing itself. Serviced
     * unconditionally in tickWatch (the chew advances through the entity's own tick whether or
     * not a reflex owns the body — vanilla players eat through combat too).
     */
    static final class Chew {
        final FakePlayerEntity fp;
        final boolean drink;
        final String itemId;
        /** The hotbar slot doing the using, and where the displaced tool went (-1 = no swap). */
        final int handSlot;
        final int swapBack;
        final float healthBefore;
        final int foodBefore;
        /** Reply skeleton carrying `chose`/`chose_why` from selection time. */
        final JsonObject reply;
        final java.util.concurrent.CompletableFuture<com.google.gson.JsonElement> waiter;
        final DroneTools.Slot slot;
        int ticksLeft = 60; // backstop: a use that never completes resolves `interrupted`

        Chew(final FakePlayerEntity fp, final boolean drink, final String itemId,
             final int handSlot, final int swapBack, final float healthBefore,
             final int foodBefore, final JsonObject reply, final DroneTools.Slot slot,
             final java.util.concurrent.CompletableFuture<com.google.gson.JsonElement> waiter) {
            this.fp = fp;
            this.drink = drink;
            this.itemId = itemId;
            this.handSlot = handSlot;
            this.swapBack = swapBack;
            this.healthBefore = healthBefore;
            this.foodBefore = foodBefore;
            this.reply = reply;
            this.slot = slot;
            this.waiter = waiter;
        }
    }

    /**
     * {@code bot_eat}/{@code bot_drink} — REAL vanilla consumption against a real player: the item
     * moves to the hand, {@code startUsingItem} runs the engine's own use-ticks (~1.6s of visible
     * eating), and the reply completes through {@code waiter} when the swallow actually happened.
     * Returns {@code {started:true, eta_ticks}} when the chew began; a refusal or an
     * instant-fallback result otherwise (the caller completes immediately in that case).
     */
    static JsonObject consume(final JsonObject a, final DroneTools.Slot slot,
                              final FakePlayerEntity fp, final boolean drink,
                              final java.util.concurrent.CompletableFuture<com.google.gson.JsonElement> waiter) {
        Inventory inv = fp.getInventory();
        ServerLevel level = (ServerLevel) fp.level();
        JsonObject r = new JsonObject();
        if (slot.chew != null) {
            r.addProperty("note", "already " + (slot.chew.drink ? "drinking" : "eating") + " "
                + slot.chew.itemId + " — it finishes within ~2s");
            return DroneHands.fail(r, "busy");
        }

        int idx;
        if (a.has("item") && !a.get("item").isJsonNull()) {
            idx = findSlot(inv, a.get("item").getAsString());
            if (idx < 0) {
                r.addProperty("note", "no '" + a.get("item").getAsString()
                    + "' in the inventory — check bot_status {inventory:true} (drops are auto-collected by walking over them)");
                return DroneHands.fail(r, "item_missing");
            }
        } else if (drink) {
            idx = inv.getSelectedSlot();
        } else {
            // The held item stays the default WHEN IT IS FOOD — that is the documented contract and
            // the caller's stated choice. When it is not, we look for food rather than pretending to
            // eat a pickaxe: a body at 3 hearts holding dirt is the case that killed session
            // w2-75927, and "eat" can only ever have meant one thing there. The substitution is
            // reported (`chose`), never silent.
            int held = inv.getSelectedSlot();
            idx = DroneHands.isFood(inv.getItem(held)) ? held : DroneHands.bestPlainFoodSlot(inv);
            if (idx < 0) {
                r.addProperty("note", "nothing edible in the inventory. Foods with side effects "
                    + "(golden apples, chorus fruit, rotten flesh, pufferfish…) are never chosen "
                    + "automatically — name one with `item` if that is what you want.");
                return DroneHands.fail(r, "no_food");
            }
            if (idx != held) {
                r.addProperty("chose", DroneHands.itemId(inv.getItem(idx).getItem()));
                r.addProperty("chose_why", "the held item ("
                    + (inv.getItem(held).isEmpty() ? "nothing" : DroneHands.itemId(inv.getItem(held).getItem()))
                    + ") is not food");
            }
        }
        ItemStack stack = inv.getItem(idx);
        if (stack.isEmpty()) {
            return DroneHands.fail(r, "empty_hand");
        }
        // Symmetric with `not_a_potion` below, and for the same reason: consuming a non-consumable
        // is a no-op that used to report success.
        if (!drink && !DroneHands.isFood(stack)) {
            r.addProperty("note", DroneHands.itemId(stack.getItem()) + " is not food — eating it "
                + "would do nothing at all. Call bot_eat with no `item` to use the best food you "
                + "are carrying, or bot_status {inventory:true} to see what that is.");
            return DroneHands.fail(r, "not_food");
        }
        String consumed = DroneHands.itemId(stack.getItem());
        float healthBefore = fp.getHealth();
        int foodBefore = fp.getFoodData().getFoodLevel();
        if (drink && stack.get(net.minecraft.core.component.DataComponents.POTION_CONTENTS) == null) {
            return DroneHands.fail(r, "not_a_potion");
        }

        // REAL CONSUMPTION: move the item to the hand (a body eats what it HOLDS — the displaced
        // tool is restored when the chew ends, and any substitution is already disclosed via
        // `chose`), then hand the whole act to the engine: startUsingItem begins the vanilla
        // use-ticks, and completeUsingItem — not this code — applies nutrition, effects, and the
        // remainder item. The reply completes through the waiter when the swallow actually lands.
        int sel = inv.getSelectedSlot();
        int swapBack = -1;
        if (idx != sel) {
            ItemStack held = inv.getItem(sel);
            inv.setItem(sel, inv.getItem(idx));
            inv.setItem(idx, held);
            swapBack = idx;
        }
        fp.startUsingItem(InteractionHand.MAIN_HAND);
        if (!fp.isUsingItem()) {
            // The engine refused the use (an edible with no use animation?) — restore the hand
            // and fall back to the instant apply so the verb still works on the odd item.
            if (swapBack >= 0) {
                ItemStack food = inv.getItem(sel);
                inv.setItem(sel, inv.getItem(swapBack));
                inv.setItem(swapBack, food);
            }
            return instantConsume(r, slot, fp, drink, idx, consumed, healthBefore, foodBefore);
        }
        slot.chew = new Chew(fp, drink, consumed, sel, swapBack, healthBefore, foodBefore, r,
            slot, waiter);
        JsonObject started = new JsonObject();
        started.addProperty("started", true);
        started.addProperty(drink ? "drinking" : "eating", consumed);
        started.addProperty("eta_ticks", stack.getUseDuration(fp));
        return started;
    }

    /** Advance the slot's in-flight chew — serviced unconditionally in tickWatch (a reflex owning
     *  the legs does not stop a swallow; the entity's own tick is doing the eating). */
    static void chewTick(final DroneTools.Slot slot) {
        Chew c = slot.chew;
        if (c == null) {
            return;
        }
        if (c.fp.isRemoved() || !c.fp.isAlive()) {
            finishChew(slot, c, false, "body_removed");
            return;
        }
        if (c.fp.isUsingItem()) {
            if (--c.ticksLeft > 0) {
                return;
            }
            c.fp.releaseUsingItem(); // backstop: never completed — let go without consuming
            finishChew(slot, c, false, "interrupted");
            return;
        }
        // No longer using: either vanilla completed the consume, or something stopped it early.
        // The food-level/health delta tells the truth either way — completion applies nutrition
        // BEFORE isUsingItem flips, so a genuine swallow is visible in the delta.
        finishChew(slot, c, true, null);
    }

    /** Resolve the chew from what ACTUALLY happened (before/after deltas), restore the displaced
     *  tool, answer the waiter. */
    private static void finishChew(final DroneTools.Slot slot, final Chew c, final boolean completed,
                                   final @Nullable String reason) {
        slot.chew = null;
        Inventory inv = c.fp.getInventory();
        if (c.swapBack >= 0) {
            ItemStack now = inv.getItem(c.handSlot);
            inv.setItem(c.handSlot, inv.getItem(c.swapBack));
            inv.setItem(c.swapBack, now);
        }
        JsonObject r = c.reply;
        if (!completed) {
            r.addProperty("ok", false);
            r.addProperty("reason", reason);
            r.addProperty("note", "body_removed".equals(reason)
                ? "the body was lost mid-" + (c.drink ? "drink" : "meal") + " — nothing was consumed"
                : "the " + (c.drink ? "drink" : "meal") + " never completed — nothing was consumed");
            c.waiter.complete(r.deepCopy());
            return;
        }
        int foodNow = c.fp.getFoodData().getFoodLevel();
        r.addProperty("ok", true);
        r.addProperty(c.drink ? "drank" : "ate", c.itemId);
        r.addProperty("food", foodNow);
        if (foodNow != c.foodBefore) {
            r.addProperty("food_gained", foodNow - c.foodBefore);
        }
        JsonArray effects = new JsonArray();
        for (net.minecraft.world.effect.MobEffectInstance e : c.fp.getActiveEffects()) {
            effects.add(e.getEffect().getRegisteredName());
        }
        r.add("effects", effects);
        r.addProperty("effect_count", effects.size());
        if (c.fp.getHealth() != c.healthBefore) {
            r.addProperty("healed", c.fp.getHealth() - c.healthBefore);
        }
        int effectCount = effects.size();
        String consumed = c.itemId;
        DroneHands.emitDone(slot, c.drink ? "bot_drink" : "bot_eat", d -> {
            d.addProperty("item", consumed);
            d.addProperty("effect_count", effectCount);
        });
        c.waiter.complete(r.deepCopy());
    }

    /** The pre-0.52.0 instant apply — kept as the fallback for consumables the engine will not
     *  run a use animation for, so the verb never regresses on the odd item. */
    private static JsonObject instantConsume(final JsonObject r, final DroneTools.Slot slot,
                                             final FakePlayerEntity fp, final boolean drink,
                                             final int idx, final String consumed,
                                             final float healthBefore, final int foodBefore) {
        Inventory inv = fp.getInventory();
        ServerLevel level = (ServerLevel) fp.level();
        ItemStack stack = inv.getItem(idx);
        if (drink) {
            net.minecraft.world.item.alchemy.PotionContents potion =
                stack.get(net.minecraft.core.component.DataComponents.POTION_CONTENTS);
            if (potion == null) {
                return DroneHands.fail(r, "not_a_potion");
            }
            potion.applyToLivingEntity(fp, 1.0F);
            stack.shrink(1);
            if (!fp.getInventory().add(new ItemStack(net.minecraft.world.item.Items.GLASS_BOTTLE))) {
                Block.popResource(level, fp.blockPosition(), new ItemStack(net.minecraft.world.item.Items.GLASS_BOTTLE));
            }
        } else {
            ItemStack result = stack.finishUsingItem(level, fp);
            inv.setItem(idx, stack);
            if (result != stack && !result.isEmpty() && !fp.getInventory().add(result)) {
                Block.popResource(level, fp.blockPosition(), result);
            }
        }

        r.addProperty("ok", true);
        r.addProperty(drink ? "drank" : "ate", consumed);
        r.addProperty("food", fp.getFoodData().getFoodLevel());
        if (fp.getFoodData().getFoodLevel() != foodBefore) {
            r.addProperty("food_gained", fp.getFoodData().getFoodLevel() - foodBefore);
        }
        JsonArray effects = new JsonArray();
        for (net.minecraft.world.effect.MobEffectInstance e : fp.getActiveEffects()) {
            effects.add(e.getEffect().getRegisteredName());
        }
        r.add("effects", effects);
        r.addProperty("effect_count", effects.size());
        if (fp.getHealth() != healthBefore) {
            r.addProperty("healed", fp.getHealth() - healthBefore);
        }
        int effectCount = effects.size();
        DroneHands.emitDone(slot, drink ? "bot_drink" : "bot_eat", d -> {
            d.addProperty("item", consumed);
            d.addProperty("effect_count", effectCount);
        });
        return r;
    }

    /** Abort an in-flight chew (slot teardown) — releases the use, restores the hand, answers the
     *  waiter honestly instead of stranding it. */
    static void abortChew(final DroneTools.Slot slot, final String reason) {
        Chew c = slot.chew;
        if (c == null) {
            return;
        }
        if (!c.fp.isRemoved() && c.fp.isUsingItem()) {
            c.fp.releaseUsingItem();
        }
        finishChew(slot, c, false, reason);
    }

    // ---- UseHold: a REAL held use, released on purpose (COMBAT_KIT_PLAN.md §4.4) -------------

    /** Full draw for a bow — vanilla's own power curve tops out exactly here. */
    static final int FULL_DRAW_TICKS = net.minecraft.world.item.BowItem.MAX_DRAW_DURATION;
    /** Turn budget before a shot concedes {@code facing_timeout} — {@code Swing}'s number, same
     *  reason: a circuit breaker for a target dancing out of the epsilon, never a duration. */
    static final int AIM_TIMEOUT_TICKS = DroneHands.SWING_TIMEOUT_TICKS;

    /**
     * One in-flight HELD use per slot — the draw of a bow, the winding of a crossbow, and (steps
     * 4–5) the raised shield and the cocked trident.
     *
     * <p><b>Why this is not {@link Chew}, though the plan asked for one class.</b> Both hold an item
     * through vanilla's own use ticks, but their COMPLETIONS are opposites: a meal finishes itself
     * (the watch only observes {@code isUsingItem} going false and reads the nutrition delta), while
     * a draw ends when WE let go. Folding the two would have given one class a mode flag deciding
     * which half of its own body ran, so they stay siblings and share the seam that matters — a
     * single hand, so each refuses {@code busy} while the other holds it.
     *
     * <p><b>Two phases, and the order is the point.</b> AIM first ({@link AttackGate#aim}, the same
     * rate-limited turn a swing uses), then HOLD. Vanilla fires along the shooter's look vector, so
     * where the body looks IS where the arrow goes — and starting the draw only once the aim has
     * converged keeps {@code draw_ticks} an honest measurement rather than "however long the turn
     * took". The aim keeps running THROUGH the hold, because the target moves while you draw.
     */
    static final class UseHold {
        final FakePlayerEntity fp;
        final DroneTools.Slot slot;
        final String actionId;
        final int targetId;
        /** What the mode decision said, so the completion repeats the `mode`/`why` the start reply
         *  already gave — a reader that only sees the end learns the same facts. */
        final CombatKit.@Nullable Kit kit;
        final @Nullable CompletableFuture<JsonElement> waiter;
        /** The weapon id at install, for refusals that happen before anything is held. */
        String weaponId;
        /** Ticks of draw still owed once the use has begun; -1 while still turning. */
        int holdLeft = -1;
        /** The draw the caller asked for, quoted back in the verdict. */
        final int requested;
        int aimLeft = AIM_TIMEOUT_TICKS;

        UseHold(final FakePlayerEntity fp, final DroneTools.Slot slot, final String actionId,
                final int targetId, final String weaponId, final int requested,
                final CombatKit.@Nullable Kit kit,
                final @Nullable CompletableFuture<JsonElement> waiter) {
            this.fp = fp;
            this.slot = slot;
            this.actionId = actionId;
            this.targetId = targetId;
            this.weaponId = weaponId;
            this.requested = requested;
            this.kit = kit;
            this.waiter = waiter;
        }
    }

    /**
     * {@code bot_shoot} on a PLAYER body — a REAL draw, not a synthesized arrow.
     *
     * <p>The old path built an {@code Arrow} entity by hand and only borrowed the held bow for its
     * enchantments: no draw time, no power curve, no crossbow, and — the part that reaches past
     * play — a recorded press channel showing a shot with no {@code use}-hold before it, a frame no
     * human capture will ever match. Here the ITEM decides ({@code ItemStack.use} → vanilla's own
     * {@code startUsingItem} / {@code releaseUsing}), so power, enchantments, Infinity, ammunition
     * choice and the fired projectile are vanilla's, and {@link FakePlayerEntity#tick}'s existing
     * use-press tap records the draw exactly as a client would.
     *
     * @return {@code {started, action_id, eta_ticks}} once the shot is in flight as an act, or a
     *     synchronous refusal
     */
    static JsonObject startShot(final JsonObject a, final DroneTools.Slot slot,
                                final FakePlayerEntity fp, final Hands hands, final Entity target,
                                final @Nullable CompletableFuture<JsonElement> waiter) {
        JsonObject r = new JsonObject();
        // ONE HAND. A draw and a meal both own the mainhand through vanilla's use ticks, and a
        // second startUsingItem silently replaces the first — the eater would swallow nothing and
        // never learn why.
        if (slot.use != null) {
            r.addProperty("note", "the body is already drawing " + slot.use.weaponId
                + " — one draw at a time; it releases within ~1s");
            return DroneHands.fail(r, "busy");
        }
        if (slot.chew != null) {
            r.addProperty("note", "the body is " + (slot.chew.drink ? "drinking" : "eating") + " "
                + slot.chew.itemId + " — the same hand draws the bow; it finishes within ~2s");
            return DroneHands.fail(r, "busy");
        }
        // WHICH FIGHT IS THIS (COMBAT_KIT_PLAN.md §4.1) — `forShot`, because the caller asked for a
        // shot: the mode is not in question, only which of the carried weapons answers it and what
        // the offhand should hold while it does.
        //
        // THE CAPABILITY CHECK COMES BEFORE THE GATES, the same order and the same reason
        // botAttack validates a named `item` first: a body that cannot shoot at all must never be
        // told its problem is the sightline. It would go looking for a vantage it does not need.
        boolean allowThrow = !a.has("allow_throw") || a.get("allow_throw").isJsonNull()
            || a.get("allow_throw").getAsBoolean();
        CombatKit.Kit kit = CombatKit.forShot(fp, hands, target, allowThrow);
        if (kit.main().isEmpty()) {
            // "no bow" and "no arrows" are different problems with different fixes, and an agent can
            // only act on the one it is told. `no_weapon` is new; the empty quiver keeps the
            // `item_missing` word every caller already knows.
            r.addProperty("note", kit.why());
            // A trident held back by the caller's own `allow_throw:false` is neither of those: the
            // body is fully capable and was told not to. Reporting `no_weapon` for an instruction
            // the caller gave would send them looking for a bow they do not need.
            String why = CombatKit.throwSlot(hands) >= 0 && !allowThrow ? "throw_not_allowed"
                : CombatKit.carriesRangedWeapon(hands) ? "item_missing" : "no_weapon";
            return DroneHands.fail(r, why);
        }
        // An arrow through a wall is the ranged half of the capability cheat AttackGate.hasLos
        // exists to refuse. Checked again at release, because the draw takes a second and cover
        // moves.
        if (!AttackGate.hasLos(fp, target)) {
            r.addProperty("note", "a block stands between the eye and the target — the arrow would "
                + "hit it. Move to where you can SEE the target (bot_target action:\"attack\" "
                + "approaches, and shoots by itself when the legs cannot get there)");
            return DroneHands.fail(r, "occluded");
        }
        CombatKit.Equipped eq = CombatKit.equip(hands, kit);
        ItemStack weapon = hands.selectedStack();
        if (a.has("item") && !a.get("item").isJsonNull()
                && !preferAmmo(fp, weapon, a.get("item").getAsString())) {
            r.addProperty("note", "no '" + a.get("item").getAsString() + "' this "
                + DroneHands.itemId(weapon.getItem()) + " can fire — omit `item` to use whatever "
                + "ammunition is carried");
            return DroneHands.fail(r, "item_missing");
        }

        // ONE HAND, and vanilla is the one enforcing it: LivingEntity.useItem is a single in-flight
        // use for the whole entity, so beginning a draw REPLACES a raised shield whether or not
        // anyone says so. Lowering it here on purpose is the difference between a decision and an
        // accident — and it stops the guard's own watch reporting `interrupted` for something this
        // call did deliberately.
        Shields.lower(slot, "lowered_to_shoot");
        // A SPECULATIVE WIND-UP LOSES TO A BOLT SOMEBODY ASKED FOR. Same one-hand contention, and
        // the same rule as the shield: say which, so the load does not die of `interrupted` from an
        // author it cannot name. The charge is lost, which is correct — beginUse re-winds as part of
        // this shot's own draw, and a pre-load must never delay the shot it exists to speed up.
        Crossbows.cancel(slot, "preempted_by_shot");

        int draw = a.has("draw_ticks") && !a.get("draw_ticks").isJsonNull()
            ? Math.max(1, Math.min(a.get("draw_ticks").getAsInt(), 100)) : fullDraw(weapon, fp);
        String actionId = "shot-" + DroneHands.nextActionSeq();
        UseHold u = new UseHold(fp, slot, actionId, target.getId(),
            DroneHands.itemId(weapon.getItem()), draw, kit, waiter);
        slot.use = u;

        if (eq != null && eq.off() != null) {
            JsonObject od = new JsonObject();
            od.addProperty("item", eq.off());
            od.addProperty("why", kit.why());
            od.addProperty("health", fp.getHealth());
            EventLog.emit("offhand_switched", od, slot.target());
        }
        r.addProperty("started", true);
        r.addProperty("action_id", actionId);
        r.addProperty("weapon", u.weaponId);
        r.addProperty("draw_ticks", draw);
        CombatKit.report(r, kit, eq == null ? null : eq.main(), eq == null ? null : eq.off());
        r.addProperty("eta_ticks", AttackGate.turnTicks(fp, target) + draw);
        r.addProperty("note", "the body is aiming, then drawing for " + draw + " ticks; vanilla "
            + "looses the arrow on release. Completes via action_completed {power, draw_ticks, "
            + "arrow_id} or action_failed {reason}, and the LANDING arrives later as shot_landed "
            + "{hit}");
        return r;
    }

    /**
     * Advance the slot's in-flight held use — serviced UNCONDITIONALLY from tickWatch, for the
     * reason the swing clock is: a draw drives no legs, so a reflex or a fight owning the body must
     * not freeze it together with its own timeout. Every gate re-runs per tick, so a target that
     * dies or steps behind cover mid-draw fails the shot instead of loosing an arrow at a memory.
     */
    static void useTick(final DroneTools.Slot slot) {
        UseHold u = slot.use;
        if (u == null) {
            return;
        }
        if (u.fp.isRemoved() || !u.fp.isAlive()) {
            failUse(slot, "body_removed");
            return;
        }
        ServerLevel level = (ServerLevel) u.fp.level();
        Entity target = level.getEntity(u.targetId);
        if (target == null || !target.isAlive()) {
            failUse(slot, "target_lost");
            return;
        }
        boolean aimed = AttackGate.aim(u.fp, target);
        if (u.holdLeft < 0) {
            // Still turning. The draw has not begun, so nothing is wasted by waiting.
            if (--u.aimLeft < 0) {
                failUse(slot, "facing_timeout");
                return;
            }
            if (!aimed) {
                return;
            }
            beginUse(slot, u, target);
            return;
        }
        // Drawing. Vanilla's own use ticks are running underneath this.
        if (!u.fp.isUsingItem()) {
            failUse(slot, "draw_interrupted");
            return;
        }
        if (--u.holdLeft > 0) {
            return;
        }
        if (!aimed) {
            // Drawn, but the target has moved off the aim while we held. A real archer keeps the
            // bow drawn and tracks — and vanilla agrees, since holding past full draw costs
            // nothing. Loosing at where the target WAS would spend the arrow on the ground.
            if (--u.aimLeft < 0) {
                failUse(slot, "facing_timeout");
                return;
            }
            u.holdLeft = 1; // re-enter here next tick
            return;
        }
        release(slot, u, target);
    }

    /** Hand the act to the ITEM: {@code use} is what a right-click runs, so a bow starts drawing,
     *  an uncharged crossbow starts winding, and an already-charged one FIRES on the spot. */
    private static void beginUse(final DroneTools.Slot slot, final UseHold u, final Entity target) {
        ItemStack weapon = u.fp.getMainHandItem();
        u.weaponId = DroneHands.itemId(weapon.getItem());
        int ammoBefore = CombatKit.countAmmo(Hands.of(u.fp), weapon);
        weapon.use(u.fp.level(), u.fp, InteractionHand.MAIN_HAND);
        if (u.fp.isUsingItem()) {
            u.holdLeft = u.requested;
            return;
        }
        // Not holding anything: either the item shot at once (a charged crossbow — exactly the
        // "carry it loaded, fire instantly" the design wants) or it refused for want of ammunition.
        Entity shot = firedProjectile((ServerLevel) u.fp.level(), u.fp);
        if (shot == null && CombatKit.countAmmo(Hands.of(u.fp), weapon) >= ammoBefore) {
            failUse(slot, "item_missing");
            return;
        }
        finishShot(slot, u, target, shot, 0, 1.0F);
    }

    /** Let go: vanilla's {@code releaseUsing} looses the arrow (or finishes loading a crossbow, in
     *  which case the loaded weapon's own {@code use} is the trigger). */
    private static void release(final DroneTools.Slot slot, final UseHold u, final Entity target) {
        if (!AttackGate.hasLos(u.fp, target)) {
            // Do not spend the arrow on a shot that cannot land. stopUsingItem cancels the draw
            // without firing — vanilla's own way of lowering a bow.
            failUse(slot, "occluded");
            return;
        }
        ServerLevel level = (ServerLevel) u.fp.level();
        int drawTicks = u.fp.getTicksUsingItem();
        ItemStack weapon = u.fp.getMainHandItem();
        float power = powerFor(weapon, drawTicks, u.fp);
        int ammoBefore = CombatKit.countAmmo(Hands.of(u.fp), weapon);
        u.fp.releaseUsingItem();
        // A crossbow's release only LOADS it; the loaded weapon's use is what fires.
        weapon = u.fp.getMainHandItem();
        if (weapon.getItem() instanceof net.minecraft.world.item.CrossbowItem
                && net.minecraft.world.item.CrossbowItem.isCharged(weapon)) {
            weapon.use(level, u.fp, InteractionHand.MAIN_HAND);
        }
        Entity shot = firedProjectile(level, u.fp);
        // TWO WITNESSES, because neither alone is sound. The world lookup can miss an arrow that
        // has not settled into its section yet, and the ammo delta cannot see a shot from a body
        // that draws from nothing (infinite materials, where countAmmo answers -1 both times). A
        // shot reported as a failure is the worse error: the goal loop drops its ranged conclusion
        // on one, and the arrow is already in the air.
        if (shot == null && CombatKit.countAmmo(Hands.of(u.fp), weapon) >= ammoBefore) {
            // A draw under ~2 ticks is below vanilla's own 0.1 power floor and fires nothing. Say
            // so rather than reporting a shot that never left the bow.
            failUse(slot, "draw_too_short");
            return;
        }
        finishShot(slot, u, target, shot, drawTicks, power);
    }

    /** Resolve a shot that actually left the weapon: verdict, completion event, flight watch. */
    private static void finishShot(final DroneTools.Slot slot, final UseHold u, final Entity target,
                                   final @Nullable Entity shot, final int drawTicks,
                                   final float power) {
        slot.use = null;
        AttackGate.releaseGaze(u.fp.getId());
        ItemStack weapon = u.fp.getMainHandItem();
        JsonObject r = new JsonObject();
        r.addProperty("ok", true);
        r.addProperty("shot", u.targetId);
        r.addProperty("weapon", u.weaponId);
        r.addProperty("draw_ticks", drawTicks);
        r.addProperty("power", Math.round(power * 100.0) / 100.0);
        if (shot != null) {
            r.addProperty("arrow_id", shot.getId());
            // The launch speed the power curve actually produced — the difference between a snap
            // shot and a full draw, in blocks per tick, without asking the caller to trust `power`.
            r.addProperty("speed", Math.round(shot.getDeltaMovement().length() * 100.0) / 100.0);
        }
        // `arrows_left`, the drone path's own word, so the two body families answer in ONE
        // vocabulary — a caller must not be able to tell them apart by their keys. Omitted rather
        // than reported as -1 for a body that draws from nothing — and omitted entirely for a THROW,
        // where the weapon IS the ammunition: countAmmo answers 0 for a trident because a trident is
        // not a ProjectileWeaponItem, and "arrows_left: 0" after a perfectly good throw would read
        // as an empty quiver the body does not have.
        boolean thrown = u.kit != null && u.kit.mode() == CombatKit.Mode.THROW;
        int left = thrown ? -1 : CombatKit.countAmmo(Hands.of(u.fp), weapon);
        if (left >= 0) {
            r.addProperty("arrows_left", left);
        }
        CombatKit.report(r, u.kit, null, null);
        r.addProperty("note", thrown
            ? "the trident is in the air — whether it HITS arrives as shot_landed {hit, damage}, "
                + "and where it comes to rest as trident_landed {x, y, z} (or trident_returned, if "
                + "it has Loyalty). The body walks back for it once it has nothing else to do"
            : "the arrow is in the air — whether it LANDS arrives as shot_landed {hit, damage}");

        JsonObject done = r.deepCopy();
        done.addProperty("action_id", u.actionId);
        DroneHands.emitDone(slot, "bot_shoot", d -> {
            d.addProperty("action_id", u.actionId);
            d.addProperty("target_id", u.targetId);
            d.addProperty("weapon", u.weaponId);
            d.addProperty("draw_ticks", drawTicks);
            d.addProperty("power", Math.round(power * 100.0) / 100.0);
            if (shot != null) {
                d.addProperty("arrow_id", shot.getId());
            }
        });
        QueueRunner.onActionDone(slot, u.actionId, done);
        GoalRunner.onActionDone(slot, u.actionId, done);
        if (shot != null) {
            Shots.track(slot, shot, target, u.actionId, u.weaponId);
        }
        if (u.waiter != null) {
            u.waiter.complete(done);
        }
    }

    /** Abort the in-flight draw: action_failed + the waiter answered, never stranded. */
    static void failUse(final DroneTools.Slot slot, final String reason) {
        UseHold u = slot.use;
        if (u == null) {
            return;
        }
        slot.use = null;
        AttackGate.releaseGaze(u.fp.getId());
        if (!u.fp.isRemoved() && u.fp.isUsingItem()) {
            u.fp.stopUsingItem(); // lower the bow without spending the arrow
        }
        JsonObject data = new JsonObject();
        data.addProperty("action_id", u.actionId);
        data.addProperty("action", "bot_shoot");
        data.addProperty("reason", reason);
        EventLog.emit("action_failed", data, slot.target());
        QueueRunner.onActionFailed(slot, u.actionId, reason);
        GoalRunner.onActionFailed(slot, u.actionId, reason);
        if (u.waiter != null) {
            JsonObject r = data.deepCopy();
            r.addProperty("ok", false);
            u.waiter.complete(r);
        }
    }

    /**
     * The projectile this body just launched: owned by it and not yet ticked. Read from the world
     * rather than returned by vanilla, because {@code LivingEntity.releaseUsingItem} answers
     * nothing — and "did an arrow leave the bow" is the one fact a shot verdict may not guess at.
     */
    private static @Nullable Entity firedProjectile(final ServerLevel level, final FakePlayerEntity fp) {
        Entity best = null;
        for (Entity e : level.getEntities(fp, fp.getBoundingBox().inflate(6.0),
                x -> x instanceof net.minecraft.world.entity.projectile.Projectile p
                    && p.getOwner() == fp && p.tickCount <= 1)) {
            if (best == null || e.getId() > best.getId()) {
                best = e; // the newest, when a multishot crossbow put three in the air
            }
        }
        return best;
    }

    /** How long this weapon's full commitment is: a bow's power curve tops out at 20 ticks, a
     *  crossbow loads on its own (quick-charge aware) schedule, and a trident has a THRESHOLD
     *  rather than a curve. */
    private static int fullDraw(final ItemStack weapon, final FakePlayerEntity fp) {
        if (weapon.getItem() instanceof net.minecraft.world.item.CrossbowItem) {
            return net.minecraft.world.item.CrossbowItem.getChargeDuration(weapon, fp) + 1;
        }
        if (weapon.getItem() instanceof net.minecraft.world.item.TridentItem) {
            // TridentItem.releaseUsing returns false — silently, producing NOTHING — below
            // THROW_THRESHOLD_TIME. There is no power curve above it either: the launch is a flat
            // PROJECTILE_SHOOT_POWER of 2.5, so holding longer buys nothing at all and a throw is
            // the one ranged act where the fastest release is also the best one. Two ticks of slack
            // over the threshold, because the tick the hold is COUNTED on and the tick vanilla
            // measures from are not guaranteed to be the same one, and the cost of being one under
            // is a throw that fires no trident and reports draw_too_short.
            return net.minecraft.world.item.TridentItem.THROW_THRESHOLD_TIME + 2;
        }
        return FULL_DRAW_TICKS;
    }

    /** Vanilla's own power curve for what was held. Reported, never enforced. */
    private static float powerFor(final ItemStack weapon, final int drawTicks, final FakePlayerEntity fp) {
        if (weapon.getItem() instanceof net.minecraft.world.item.BowItem) {
            return net.minecraft.world.item.BowItem.getPowerForTime(drawTicks);
        }
        if (weapon.getItem() instanceof net.minecraft.world.item.CrossbowItem) {
            return Math.min(1.0F,
                drawTicks / (float) net.minecraft.world.item.CrossbowItem.getChargeDuration(weapon, fp));
        }
        return 1.0F;
    }

    /**
     * Make {@code want} the ammunition vanilla reaches for. {@code Player.getProjectile} scans the
     * inventory IN INDEX ORDER after the hands, so moving the named stack ahead of every other
     * supported one is the whole implementation — no second projectile-choosing path to diverge
     * from vanilla's.
     *
     * @return false when nothing carried by that name can be fired from this weapon
     */
    private static boolean preferAmmo(final FakePlayerEntity fp, final ItemStack weapon,
                                      final String want) {
        if (!(weapon.getItem() instanceof net.minecraft.world.item.ProjectileWeaponItem pw)) {
            return false;
        }
        java.util.function.Predicate<ItemStack> supported = pw.getAllSupportedProjectiles();
        Inventory inv = fp.getInventory();
        int named = findSlot(inv, want);
        if (named < 0 || !supported.test(inv.getItem(named))) {
            return false;
        }
        int first = -1;
        for (int i = 0; i < inv.getContainerSize() && first < 0; i++) {
            ItemStack s = inv.getItem(i);
            if (!s.isEmpty() && supported.test(s)) {
                first = i;
            }
        }
        if (first >= 0 && named != first) {
            ItemStack head = inv.getItem(first);
            inv.setItem(first, inv.getItem(named));
            inv.setItem(named, head);
        }
        return true;
    }

    /** The slots a PLAYER body may equip through this verb — mainhand is bot_select's (see below). */
    private static final java.util.Map<String, EquipmentSlot> EQUIP_SLOTS = java.util.Map.of(
        "head", EquipmentSlot.HEAD, "chest", EquipmentSlot.CHEST, "legs", EquipmentSlot.LEGS,
        "feet", EquipmentSlot.FEET, "offhand", EquipmentSlot.OFFHAND);

    /** {@code bot_equip} — real armor slots on a real player. Same move-not-copy discipline. */
    static JsonObject equip(final JsonObject a, final FakePlayerEntity fp) {
        Inventory inv = fp.getInventory();
        JsonObject r = new JsonObject();
        JsonObject equipped = new JsonObject();
        JsonArray missing = new JsonArray();

        // `mainhand` IS the selected hotbar slot — TWO TOOLS, ONE PHYSICAL SLOT, and until now they
        // never mentioned each other. bot_select {iron_pickaxe} followed four seconds later by
        // bot_equip {mainhand: iron_sword} left the sword in slot 8 and the pickaxe displaced to
        // wherever it fit, and the reply said `{ok:true, equipped:{...}, armor:0}` — armor
        // vocabulary, no word about the hotbar, the selected slot, or the tool it had just evicted.
        // Session w2-56123 mined with a sword for 3m44s after that call, twice, each time noticing
        // only by accident. Since 0.49.0's tier gate a wrong-tier dig destroys the block and
        // collects NOTHING, so the same mistake now costs the ore too.
        //
        // Echoing the eviction was the alternative and it is not enough: an agent that reads
        // `ok:true` and moves on is still holding the wrong tool. The collision is refused instead,
        // and the refusal names the tool that owns this slot. bot_equip keeps armor and offhand,
        // which is what it was built for and where nothing else writes.
        if (a.has("mainhand")) {
            throw new IllegalArgumentException(
                "bot_equip does not set `mainhand` — for a player body the mainhand IS the selected "
                + "hotbar slot, and writing it here would silently displace whatever tool you had "
                + "selected. THE BODY ARMS ITSELF: a dig reaches for the best harvesting tool and a "
                + "swing reaches for the best weapon carried, so the hand is already right for the "
                + "act you are about to run — name `item` on that act to override it. bot_equip owns "
                + "armor (head/chest/legs/feet) and offhand.");
        }

        for (var e : EQUIP_SLOTS.entrySet()) {
            String key = e.getKey();
            if (!a.has(key)) {
                continue;
            }
            EquipmentSlot es = e.getValue();
            if (a.get(key).isJsonNull()) {
                ItemStack worn = fp.getItemBySlot(es);
                if (!worn.isEmpty()) {
                    if (!inv.add(worn.copy())) {
                        Block.popResource((ServerLevel) fp.level(), fp.blockPosition(), worn.copy());
                    }
                    fp.setItemSlot(es, ItemStack.EMPTY);
                }
                equipped.add(key, com.google.gson.JsonNull.INSTANCE);
                continue;
            }
            String id = a.get(key).getAsString();
            int idx = findSlot(inv, id);
            if (idx < 0) {
                missing.add(key + ":" + id);
                continue;
            }
            equipFromPack(fp, es, idx);
            equipped.addProperty(key, id);
        }

        r.addProperty("ok", true);
        r.add("equipped", equipped);
        if (!missing.isEmpty()) {
            r.add("item_missing", missing);
        }
        r.addProperty("armor", fp.getArmorValue());
        return r;
    }

    /**
     * Move the pack stack at {@code packSlot} into equipment slot {@code es}, returning whatever
     * was worn there to the pack (spilled at the feet only when it will not fit). MOVE, NOT COPY —
     * the discipline every hand verb here keeps, so nothing is duplicated into an equipment slot
     * that vanilla death drop-chances could then dupe.
     *
     * <p>Extracted from {@link #equip} so the automatic offhand policy ({@code CombatKit}, the
     * shield/totem contention of COMBAT_KIT_PLAN.md §4.2) writes the offhand through the SAME seam
     * a caller's {@code bot_equip} does. Two ways to fill an equipment slot is how the drone and
     * player swing paths diverged in the first place.
     */
    static void equipFromPack(final ServerPlayer fp, final EquipmentSlot es, final int packSlot) {
        Inventory inv = fp.getInventory();
        ItemStack toEquip = inv.getItem(packSlot).copy();
        inv.getItem(packSlot).setCount(0);
        ItemStack prev = fp.getItemBySlot(es);
        if (!prev.isEmpty() && !inv.add(prev.copy())) {
            Block.popResource((ServerLevel) fp.level(), fp.blockPosition(), prev.copy());
        }
        fp.setItemSlot(es, toEquip);
    }

    /** {@code bot_select} — the real hotbar selection (slots 0..8). */
    static JsonObject select(final JsonObject a, final FakePlayerEntity fp) {
        Inventory inv = fp.getInventory();
        if (a.has("slot") && !a.get("slot").isJsonNull()) {
            int idx = a.get("slot").getAsInt();
            if (idx < 0 || idx > 8) {
                throw new IllegalArgumentException("a player's selectable hotbar is slots 0..8");
            }
            inv.setSelectedSlot(idx);
            // Hotbar input (world-model DESIGN.md §9 Phase 3): a selection is a number-key press.
            com.mattmc.mcptoolkit.wm.Wm.actionPress(fp, false, false, idx);
        } else if (a.has("item") && !a.get("item").isJsonNull()) {
            String id = a.get("item").getAsString();
            int idx = findSlot(inv, id);
            if (idx < 0) {
                throw new IllegalArgumentException("no such item in inventory: " + id);
            }
            if (idx > 8) {
                // Not in the hotbar: swap it into the current hotbar slot, real-player style.
                ItemStack hot = inv.getItem(inv.getSelectedSlot());
                inv.setItem(inv.getSelectedSlot(), inv.getItem(idx));
                inv.setItem(idx, hot);
            } else {
                inv.setSelectedSlot(idx);
                com.mattmc.mcptoolkit.wm.Wm.actionPress(fp, false, false, idx);
            }
        } else {
            throw new IllegalArgumentException("pass `slot` or `item`");
        }

        JsonObject r = new JsonObject();
        r.addProperty("selectedSlot", inv.getSelectedSlot());
        ItemStack held = inv.getSelectedItem();
        r.addProperty("held", held.isEmpty() ? null : DroneHands.itemId(held.getItem()));
        r.addProperty("count", held.getCount());
        return r;
    }

    /** {@code bot_inventory} — the real 36-slot inventory plus worn armor. */
    static JsonObject inventory(final FakePlayerEntity fp) {
        Inventory inv = fp.getInventory();
        JsonObject r = new JsonObject();
        r.addProperty("size", inv.getContainerSize());
        r.addProperty("selectedSlot", inv.getSelectedSlot());
        JsonArray slots = new JsonArray();
        for (int i = 0; i < inv.getContainerSize(); i++) {
            ItemStack st = inv.getItem(i);
            if (st.isEmpty()) {
                continue;
            }
            JsonObject o = new JsonObject();
            o.addProperty("slot", i);
            o.addProperty("item", DroneHands.itemId(st.getItem()));
            o.addProperty("count", st.getCount());
            slots.add(o);
        }
        r.add("slots", slots);
        ItemStack held = inv.getSelectedItem();
        r.addProperty("held", held.isEmpty() ? null : DroneHands.itemId(held.getItem()));
        JsonObject worn = new JsonObject();
        for (var e : EQUIP_SLOTS.entrySet()) {
            if (e.getValue().getType() != EquipmentSlot.Type.HUMANOID_ARMOR) {
                continue;
            }
            ItemStack st = fp.getItemBySlot(e.getValue());
            if (!st.isEmpty()) {
                worn.addProperty(e.getKey(), DroneHands.itemId(st.getItem()));
            }
        }
        if (!worn.entrySet().isEmpty()) {
            r.add("worn", worn);
        }
        return r;
    }

    /** {@code DroneHands.findItemSlot}, against the player inventory: id or bare-name match. */
    private static int findSlot(final Inventory inv, final String idStr) {
        String want = idStr.toLowerCase(java.util.Locale.ROOT);
        String bare = want.startsWith("minecraft:") ? want.substring("minecraft:".length()) : want;
        for (int i = 0; i < inv.getContainerSize(); i++) {
            ItemStack st = inv.getItem(i);
            if (st.isEmpty()) {
                continue;
            }
            String id = DroneHands.itemId(st.getItem());
            if (id.equals(want) || id.equals("minecraft:" + bare)) {
                return i;
            }
        }
        return -1;
    }
}
