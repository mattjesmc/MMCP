package com.mattmc.mcptoolkit.drone;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.ExecutionContext;
import com.mattmc.mcptoolkit.McpTools;
import com.mattmc.mcptoolkit.Mechanism;
import com.mattmc.mcptoolkit.Schemas;
import com.mattmc.mcptoolkit.ToolDef;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.Container;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.crafting.CraftingInput;
import net.minecraft.world.item.crafting.CraftingRecipe;
import net.minecraft.world.item.crafting.Ingredient;
import net.minecraft.world.item.crafting.RecipeHolder;
import net.minecraft.world.item.crafting.RecipeType;
import net.minecraft.world.item.crafting.ShapedRecipe;
import net.minecraft.world.item.crafting.SingleItemRecipe;
import net.minecraft.world.item.crafting.SingleRecipeInput;
import net.minecraft.world.item.crafting.SmithingRecipe;
import net.minecraft.world.item.crafting.SmithingRecipeInput;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

/**
 * {@code bot_craft} — recipes as a hands verb (BOT_SURFACE_DESIGN.md §13.3). Before this there was
 * NO crafting surface at all: the first survival session failed planks not through incapacity but
 * through a missing verb.
 *
 * <p><b>The game's matcher is the authority.</b> Candidate ingredients are laid into the recipe's
 * own grid and verified by {@code recipe.matches(CraftingInput)} <em>before</em> anything is
 * consumed; the result comes from {@code recipe.assemble}; container items honour
 * {@code getRemainingItems}. Nothing is hand-priced.
 *
 * <p><b>The 3×3 gate is a world gate, not a menu.</b> A recipe wider than the 2×2 pocket grid
 * refuses {@code needs_crafting_table} unless a crafting table sits within block reach of the eye —
 * the same reach every hand verb enforces. No container UI is simulated; the rule that matters
 * (you carry 2×2, tables unlock 3×3, you must be AT the table) is enforced on world truth.
 *
 * <p><b>The stations whose grid is not a grid.</b> Smithing and stonecutting are recipes in the same
 * recipe manager, but their menus are {@code ItemCombinerMenu}/{@code StonecutterMenu} — code with no
 * block entity behind it, which is why {@code bot_container} cannot reach them the way it reaches a
 * furnace. So they arrive here instead, under the shape this class already chose once for the same
 * problem: match and assemble with the game's own matcher, and enforce the <em>world</em> rule
 * (vanilla's own {@code SmithingMenu.isValidBlock} / {@code StonecutterMenu.isValidBlock}: a smithing
 * table, a stonecutter, within reach) exactly as the 3×3 gate enforces the crafting table's. Netherite
 * upgrades and the stonecutter's better yield had <b>no route at all</b> before this; the anvil,
 * grindstone, loom and cartography table still do not, because their outputs are not recipes and a
 * verb for them would have to simulate the screen.
 *
 * <p><b>Armour trims are deliberately out of reach, and that is a statement about the verb.</b> A
 * trim recipe's result is the <em>same item id</em> as its base — a trimmed diamond chestplate is
 * still {@code minecraft:diamond_chestplate}. {@code bot_craft} addresses its goal by item id, so it
 * literally cannot express "trim this one" without claiming to have produced something the caller
 * did not ask for; worse, it would silently eat a smithing template and an ingot to change an id that
 * did not move. The test is behavioural rather than by class — result item equals base item — so a
 * modded trim is caught by the same rule.
 */
public final class Crafting {
    private Crafting() {}

    public static void register() {
        McpTools.register(ToolDef.async(
            "bot_craft",
            "Have YOUR body craft `item` from its own inventory (count is the number of RESULT items "
                + "wanted, default 1 — e.g. one log crafts 4 planks in one go). Pocket-grid (2x2) "
                + "recipes work anywhere: planks, sticks, torches, a crafting table itself. Recipes "
                + "needing the 3x3 grid require a crafting table within reach (~4.5 blocks of the "
                + "eye) — place one (bot_place) and stand at it. Consumes real ingredients only "
                + "after the game's own recipe matcher accepts them; returns what was consumed and "
                + "produced (produced/requested differ honestly when ingredients run out). Fails "
                + "ALSO runs the two stations whose grid is not a grid, same rule, same reach: a "
                + "SMITHING TABLE upgrades gear (netherite_sword = diamond_sword + netherite_ingot + "
                + "the upgrade template, all three consumed), and a STONECUTTER cuts stone-family "
                + "blocks at the better yield. Fails with reason: unknown_item, no_recipe (nothing "
                + "craftable makes this), ingredients_missing (names the closest recipe's shortfall), "
                + "needs_crafting_table, needs_smithing_table, or needs_stonecutter.",
            Schemas.objectOpt(Schemas.object(
                "item", Schemas.str("Item id to craft, e.g. minecraft:oak_planks."),
                "count", Schemas.integer("How many RESULT items are wanted (default 1).")),
                "count"),
            ExecutionContext.SERVER,
            Mechanism.EMBODIED,
            (ctx, a) -> {
                DroneTools.Slot slot = DroneTools.slotFor(ctx.sessionId());
                FakePlayerEntity fp = slot.player();
                if (fp == null || Possession.live(slot) != null) {
                    return java.util.concurrent.CompletableFuture.completedFuture(craft(a, slot));
                }
                ServerLevel level = (ServerLevel) fp.level();
                BlockPos bench = stationAt(level, fp.getEyePosition());
                if (bench == null) {
                    // Pocket craft (or a station recipe about to refuse for want of its station) —
                    // instant: there is nothing in the world to perform at.
                    return java.util.concurrent.CompletableFuture.completedFuture(craft(a, slot));
                }
                if (ActCeremony.busy(slot)) {
                    JsonObject r = new JsonObject();
                    r.addProperty("ok", false);
                    r.addProperty("reason", "busy");
                    r.addProperty("note", "another container/craft act is in progress — it "
                        + "finishes within ~1s; retry after its reply");
                    return java.util.concurrent.CompletableFuture.completedFuture(r);
                }
                // THE BENCH CEREMONY: a body at a crafting station turns to it and works at it
                // for ~0.75s (swings aimed at the bench) before the result lands — the same
                // verified craft() runs as the commit, so the reply and its honesty are unchanged.
                Hands hands = Actuator.require(slot).hands();
                java.util.concurrent.CompletableFuture<com.google.gson.JsonElement> waiter =
                    new java.util.concurrent.CompletableFuture<>();
                ActCeremony.begin(slot, "craft", fp, Vec3.atCenterOf(bench),
                    () -> craft(a, slot), null, null,
                    () -> hands.placeVisual(bench), 15, 5, waiter);
                return waiter;
            }).withTimeout(30));
    }

    /** One recipe candidate: the grid laid out and verified, ready to consume-and-assemble. */
    private record Candidate(RecipeHolder<CraftingRecipe> holder, int width, int height,
                             List<Optional<Ingredient>> grid, boolean needsTable) {}

    static JsonObject craft(final JsonObject a, final DroneTools.Slot slot) {
        Actuator act = Actuator.require(slot);
        Hands hands = act.hands();
        ServerLevel level = act.level();
        JsonObject r = new JsonObject();

        if (!a.has("item") || a.get("item").isJsonNull()) {
            throw new IllegalArgumentException("missing `item` id");
        }
        Identifier id = Identifier.parse(a.get("item").getAsString());
        Optional<Item> wantedOpt = BuiltInRegistries.ITEM.getOptional(id);
        if (wantedOpt.isEmpty()) {
            return DroneHands.fail(r, "unknown_item");
        }
        Item wanted = wantedOpt.get();
        int count = a.has("count") && !a.get("count").isJsonNull() ? a.get("count").getAsInt() : 1;
        if (count <= 0) {
            throw new IllegalArgumentException("`count` must be positive");
        }

        boolean tableNear = tableWithinReach(level, act.eye());
        Container inv = hands.container();

        // Walk every crafting recipe that could make the wanted item, preferring ones the body can
        // run RIGHT NOW (2x2, or a table in reach). Track the near-misses for honest refusals.
        boolean tableBlocked = false;
        String missingNote = null;
        Candidate chosen = null;
        for (RecipeHolder<?> anyHolder : level.recipeAccess().getRecipes()) {
            if (!(anyHolder.value() instanceof CraftingRecipe recipe) || recipe.isSpecial()
                || recipe.placementInfo().isImpossibleToPlace()) {
                continue;
            }
            @SuppressWarnings("unchecked")
            RecipeHolder<CraftingRecipe> holder = (RecipeHolder<CraftingRecipe>) anyHolder;
            Candidate cand = layOut(holder, recipe);
            if (cand == null) {
                continue;
            }
            // Cheap pre-filter: does assembling THIS recipe even yield the wanted item? Build the
            // grid from fresh single-item copies of matching ingredients (not the inventory) so the
            // result check never depends on what the body carries.
            CraftingInput probe = probeInput(cand);
            if (probe == null || !recipe.matches(probe, level)) {
                continue;
            }
            ItemStack result = recipe.assemble(probe);
            if (result.isEmpty() || result.getItem() != wanted) {
                continue;
            }
            // The recipe makes the wanted item. Can these hands run it here, from this inventory?
            int missing = countMissing(inv, cand);
            if (missing > 0) {
                if (missingNote == null) {
                    missingNote = "closest recipe " + holder.id().identifier() + " is missing "
                        + missing + " ingredient(s) — check bot_status {inventory:true}";
                }
                continue;
            }
            if (cand.needsTable() && !tableNear) {
                tableBlocked = true;
                continue;
            }
            chosen = cand;
            break;
        }

        if (chosen == null) {
            // Before refusing: the same item may be reachable at a station whose "grid" is not a
            // grid. A station reply is returned only when it can actually run, or when its refusal
            // is MORE specific than the grid's would have been (see stationCraft) — so this never
            // preempts a good crafting-table diagnosis with a vague smithing one.
            JsonObject station = stationCraft(level, act, hands, inv, wanted, count, slot,
                missingNote != null || tableBlocked);
            if (station != null) {
                return station;
            }
            if (tableBlocked) {
                r.addProperty("note", "the recipe needs the 3x3 grid — place a crafting table "
                    + "(bot_place) within reach (~4.5 blocks) and craft standing at it");
                return DroneHands.fail(r, "needs_crafting_table");
            }
            if (missingNote != null) {
                r.addProperty("note", missingNote);
                return DroneHands.fail(r, "ingredients_missing");
            }
            return DroneHands.fail(r, "no_recipe");
        }

        // Craft rounds until `count` results exist or the ingredients run dry. Every round
        // re-reserves from the LIVE container and re-verifies with the game's matcher.
        CraftingRecipe recipe = chosen.holder().value();
        int produced = 0;
        int rounds = 0;
        Map<String, Integer> consumed = new LinkedHashMap<>();
        while (produced < count) {
            List<int[]> reservation = reserve(inv, chosen); // [containerSlot] per filled grid cell
            if (reservation == null) {
                break; // ran dry mid-batch — reported honestly below
            }
            List<ItemStack> gridStacks = new ArrayList<>(chosen.grid().size());
            for (int i = 0, res = 0; i < chosen.grid().size(); i++) {
                if (chosen.grid().get(i).isEmpty()) {
                    gridStacks.add(ItemStack.EMPTY);
                } else {
                    gridStacks.add(inv.getItem(reservation.get(res++)[0]).copyWithCount(1));
                }
            }
            CraftingInput input = CraftingInput.of(chosen.width(), chosen.height(), gridStacks);
            if (!recipe.matches(input, level)) {
                break; // the live inventory no longer satisfies the recipe (should not happen)
            }
            ItemStack result = recipe.assemble(input);
            for (int[] res : reservation) {
                ItemStack st = inv.getItem(res[0]);
                consumed.merge(DroneHands.itemId(st.getItem()), 1, Integer::sum);
                st.shrink(1);
            }
            for (ItemStack remainder : recipe.getRemainingItems(input)) {
                if (!remainder.isEmpty()) {
                    spillLeftover(level, hands, hands.insert(remainder));
                }
            }
            produced += result.getCount();
            spillLeftover(level, hands, hands.insert(result));
            rounds++;
        }

        if (produced == 0) {
            r.addProperty("note", "ingredients ran out before anything was crafted");
            return DroneHands.fail(r, "ingredients_missing");
        }
        // The swing aims at the BENCH when one is in reach (the self-aimed swing read as nothing
        // on camera); a pocket craft still swings at the body's own cell.
        BlockPos bench = stationAt(level, act.eye());
        hands.placeVisual(bench != null ? bench : BlockPos.containing(act.eye()));
        r.addProperty("ok", true);
        r.addProperty("crafted", DroneHands.itemId(wanted));
        r.addProperty("produced", produced);
        r.addProperty("requested", count);
        r.addProperty("recipe", chosen.holder().id().identifier().toString());
        r.addProperty("rounds", rounds);
        JsonArray consumedArr = new JsonArray();
        for (var e : consumed.entrySet()) {
            JsonObject o = new JsonObject();
            o.addProperty("item", e.getKey());
            o.addProperty("count", e.getValue());
            consumedArr.add(o);
        }
        r.add("consumed", consumedArr);
        if (produced < count) {
            r.addProperty("note", "ingredients ran out at " + produced + "/" + count
                + " — gather more and re-craft");
        }
        int producedFinal = produced;
        DroneHands.emitDone(slot, "bot_craft", d -> {
            d.addProperty("item", DroneHands.itemId(wanted));
            d.addProperty("produced", producedFinal);
        });
        return r;
    }

    /**
     * The recipe's grid as per-cell optional ingredients: a shaped recipe in its own pattern at its
     * declared width/height; a shapeless one as a 1×N row (its matcher ignores geometry). Null when
     * the recipe kind exposes no placeable grid.
     */
    private static @Nullable Candidate layOut(final RecipeHolder<CraftingRecipe> holder,
                                              final CraftingRecipe recipe) {
        if (recipe instanceof ShapedRecipe shaped) {
            return new Candidate(holder, shaped.getWidth(), shaped.getHeight(),
                shaped.getIngredients(), shaped.getWidth() > 2 || shaped.getHeight() > 2);
        }
        List<Ingredient> flat = recipe.placementInfo().ingredients();
        if (flat.isEmpty()) {
            return null;
        }
        List<Optional<Ingredient>> grid = new ArrayList<>(flat.size());
        for (Ingredient ing : flat) {
            grid.add(Optional.of(ing));
        }
        return new Candidate(holder, flat.size(), 1, grid, flat.size() > 4);
    }

    /** A synthetic input from the ingredients' own representative items — for the result check only. */
    private static @Nullable CraftingInput probeInput(final Candidate cand) {
        List<ItemStack> stacks = new ArrayList<>(cand.grid().size());
        for (Optional<Ingredient> cell : cand.grid()) {
            if (cell.isEmpty()) {
                stacks.add(ItemStack.EMPTY);
                continue;
            }
            var first = cell.get().items().findFirst();
            if (first.isEmpty()) {
                return null;
            }
            stacks.add(new ItemStack(first.get(), 1));
        }
        return CraftingInput.of(cand.width(), cand.height(), stacks);
    }

    /** How many grid cells the container CANNOT fill (0 = fully satisfiable right now). */
    private static int countMissing(final Container inv, final Candidate cand) {
        List<int[]> reservation = reserveInner(inv, cand, true);
        int filled = reservation == null ? 0 : reservation.size();
        int needed = (int) cand.grid().stream().filter(Optional::isPresent).count();
        return needed - filled;
    }

    /** Reserve one container slot per filled grid cell, or null when the container cannot. */
    private static @Nullable List<int[]> reserve(final Container inv, final Candidate cand) {
        return reserveInner(inv, cand, false);
    }

    private static @Nullable List<int[]> reserveInner(final Container inv, final Candidate cand,
                                                      final boolean partial) {
        int[] reservedPerSlot = new int[inv.getContainerSize()];
        List<int[]> out = new ArrayList<>();
        for (Optional<Ingredient> cell : cand.grid()) {
            if (cell.isEmpty()) {
                continue;
            }
            Ingredient ing = cell.get();
            int found = -1;
            for (int i = 0; i < inv.getContainerSize(); i++) {
                ItemStack st = inv.getItem(i);
                if (!st.isEmpty() && st.getCount() - reservedPerSlot[i] > 0 && ing.test(st)) {
                    found = i;
                    break;
                }
            }
            if (found < 0) {
                if (partial) {
                    continue;
                }
                return null;
            }
            reservedPerSlot[found]++;
            out.add(new int[] { found });
        }
        return out;
    }

    /**
     * Is a crafting station within block reach of {@code eye}? Membership is the
     * {@code #mcptoolkit:crafting_stations} tag (vanilla's crafting table by default) so a modded
     * station can be FOUND; whether its menu can then be driven is the station's own business.
     */
    private static boolean tableWithinReach(final ServerLevel level, final Vec3 eye) {
        return tableAt(level, eye) != null;
    }

    /** The NEAREST crafting station within block reach of {@code eye}, or null — the 3×3 gate and
     *  the swing's aim for a grid craft (a craft used to swing at the body's own eye cell). */
    static @Nullable BlockPos tableAt(final ServerLevel level, final Vec3 eye) {
        return nearestWithin(level, eye, com.mattmc.mcptoolkit.McpToolkitTags::isCraftingStation);
    }

    /** The nearest station of ANY kind this verb can work at — the ceremony's facing target, so a
     *  body upgrading a sword turns to the smithing table rather than to a crafting bench it is not
     *  using. Grid table first: it is the common case and the only one with a tag behind it. */
    static @Nullable BlockPos stationAt(final ServerLevel level, final Vec3 eye) {
        BlockPos table = tableAt(level, eye);
        if (table != null) {
            return table;
        }
        BlockPos smithing = nearestWithin(level, eye, st -> st.is(Blocks.SMITHING_TABLE));
        return smithing != null ? smithing : nearestWithin(level, eye, st -> st.is(Blocks.STONECUTTER));
    }

    private static @Nullable BlockPos nearestWithin(final ServerLevel level, final Vec3 eye,
                                                    final java.util.function.Predicate<BlockState> is) {
        int reach = (int) Math.ceil(Actuator.BLOCK_REACH);
        BlockPos center = BlockPos.containing(eye);
        BlockPos best = null;
        double bestDist = Double.MAX_VALUE;
        for (BlockPos p : BlockPos.betweenClosed(center.offset(-reach, -reach, -reach),
                center.offset(reach, reach, reach))) {
            double dist = eye.distanceTo(Vec3.atCenterOf(p));
            if (dist <= Actuator.BLOCK_REACH && dist < bestDist && is.test(level.getBlockState(p))) {
                best = p.immutable();
                bestDist = dist;
            }
        }
        return best;
    }


    // ---- the menu-only stations: smithing and stonecutting -------------------

    /**
     * The station half of {@code bot_craft}, tried only once the crafting grid has come up empty.
     *
     * <p><b>The contract with the caller's diagnosis.</b> This returns non-null only when it has
     * something MORE useful to say than the grid would: it ran, or it found a runnable recipe and
     * only the station block was missing, or the grid had no diagnosis at all ({@code gridDiagnosed}
     * false) and a station recipe can name the shortfall. Otherwise it returns null and the grid's
     * own {@code needs_crafting_table} / {@code ingredients_missing} / {@code no_recipe} stands —
     * a vague "you have no netherite ingot" must never bury a precise "place a crafting table".
     */
    private static @Nullable JsonObject stationCraft(final ServerLevel level, final Actuator act,
                                                     final Hands hands, final Container inv,
                                                     final Item wanted, final int count,
                                                     final DroneTools.Slot slot,
                                                     final boolean gridDiagnosed) {
        JsonObject smithed = smith(level, act, hands, inv, wanted, count, slot, gridDiagnosed);
        if (smithed != null) {
            return smithed;
        }
        return stonecut(level, act, hands, inv, wanted, count, slot, gridDiagnosed);
    }

    /**
     * <b>Smithing.</b> Vanilla's own three roles — template, base, addition — each filled from one
     * carried stack, verified by {@code SmithingRecipe.matches} before anything is consumed, and each
     * shrunk by exactly one per upgrade, which is what {@code SmithingMenu.onTake} does. The world
     * rule is {@code SmithingMenu.isValidBlock}'s: a smithing table within block reach.
     */
    private static @Nullable JsonObject smith(final ServerLevel level, final Actuator act,
                                              final Hands hands, final Container inv,
                                              final Item wanted, final int count,
                                              final DroneTools.Slot slot,
                                              final boolean gridDiagnosed) {
        SmithingRecipe recipe = null;
        RecipeHolder<?> holder = null;
        String shortfall = null;
        for (RecipeHolder<?> anyHolder : level.recipeAccess().getRecipes()) {
            if (!(anyHolder.value() instanceof SmithingRecipe candidate)) {
                continue;
            }
            ItemStack tProbe = representative(candidate.templateIngredient());
            ItemStack bProbe = representative(Optional.of(candidate.baseIngredient()));
            ItemStack aProbe = representative(candidate.additionIngredient());
            if (bProbe.isEmpty()) {
                continue;
            }
            SmithingRecipeInput probe = new SmithingRecipeInput(tProbe, bProbe, aProbe);
            if (!candidate.matches(probe, level)) {
                continue;
            }
            ItemStack out = candidate.assemble(probe);
            if (out.isEmpty() || out.getItem() != wanted) {
                continue;
            }
            if (out.getItem() == bProbe.getItem()) {
                continue; // a TRIM: same item id in and out — see the class doc
            }
            String missing = smithingShortfall(inv, candidate);
            if (missing != null) {
                if (shortfall == null) {
                    shortfall = "the smithing recipe " + anyHolder.id().identifier() + " is missing "
                        + missing + " — check bot_status {inventory:true}";
                }
                continue;
            }
            recipe = candidate;
            holder = anyHolder;
            break;
        }

        if (recipe == null) {
            if (shortfall != null && !gridDiagnosed) {
                JsonObject r = new JsonObject();
                r.addProperty("note", shortfall);
                return DroneHands.fail(r, "ingredients_missing");
            }
            return null;
        }
        BlockPos table = nearestWithin(level, act.eye(), st -> st.is(Blocks.SMITHING_TABLE));
        if (table == null) {
            JsonObject r = new JsonObject();
            r.addProperty("note", "you have everything the upgrade needs but no SMITHING TABLE within"
                + " reach (~4.5 blocks) — place one (bot_place minecraft:smithing_table) and stand at"
                + " it, then craft again");
            return DroneHands.fail(r, "needs_smithing_table");
        }

        int produced = 0;
        int rounds = 0;
        Map<String, Integer> consumed = new LinkedHashMap<>();
        while (produced < count) {
            int[] reserved = new int[inv.getContainerSize()];
            int tSlot = slotFor(inv, recipe.templateIngredient(), reserved);
            int bSlot = slotFor(inv, Optional.of(recipe.baseIngredient()), reserved);
            int aSlot = slotFor(inv, recipe.additionIngredient(), reserved);
            if (bSlot < 0 || (recipe.templateIngredient().isPresent() && tSlot < 0)
                || (recipe.additionIngredient().isPresent() && aSlot < 0)) {
                break; // ran dry mid-batch — reported honestly below
            }
            SmithingRecipeInput input = new SmithingRecipeInput(one(inv, tSlot), one(inv, bSlot),
                one(inv, aSlot));
            if (!recipe.matches(input, level)) {
                break;
            }
            ItemStack result = recipe.assemble(input);
            if (result.isEmpty()) {
                break;
            }
            for (int used : new int[] { tSlot, bSlot, aSlot }) {
                if (used >= 0) {
                    ItemStack st = inv.getItem(used);
                    consumed.merge(DroneHands.itemId(st.getItem()), 1, Integer::sum);
                    st.shrink(1);
                }
            }
            produced += result.getCount();
            spillLeftover(level, hands, hands.insert(result));
            rounds++;
        }
        return stationReply(level, hands, slot, wanted, holder, "smithing_table", table,
            produced, count, rounds, consumed);
    }

    /**
     * <b>Stonecutting.</b> One carried block in, a fixed result out — and the reason it is worth a
     * route at all is the YIELD: a stonecutter turns one block into two slabs where the grid turns
     * three into six, so a body cutting stairs and slabs from a limited quarry gets strictly more
     * out of the same stone. The result is fixed per recipe, so the wanted item is what picks which
     * of the many recipes sharing an input is meant.
     */
    private static @Nullable JsonObject stonecut(final ServerLevel level, final Actuator act,
                                                 final Hands hands, final Container inv,
                                                 final Item wanted, final int count,
                                                 final DroneTools.Slot slot,
                                                 final boolean gridDiagnosed) {
        SingleItemRecipe recipe = null;
        RecipeHolder<?> holder = null;
        boolean sawRecipe = false;
        for (RecipeHolder<?> anyHolder : level.recipeAccess().getRecipes()) {
            if (!(anyHolder.value() instanceof SingleItemRecipe candidate)
                || candidate.getType() != RecipeType.STONECUTTING) {
                continue;
            }
            // A stonecutter recipe's result does not depend on its input, so an empty probe is a
            // legitimate way to ask "what does this one make?" — SingleItemRecipe.assemble ignores it.
            ItemStack out = candidate.assemble(new SingleRecipeInput(ItemStack.EMPTY));
            if (out.isEmpty() || out.getItem() != wanted) {
                continue;
            }
            sawRecipe = true;
            if (findMatching(inv, candidate.input(), new int[inv.getContainerSize()]) < 0) {
                continue;
            }
            recipe = candidate;
            holder = anyHolder;
            break;
        }

        if (recipe == null) {
            if (sawRecipe && !gridDiagnosed) {
                JsonObject r = new JsonObject();
                r.addProperty("note", "a stonecutter can make " + DroneHands.itemId(wanted)
                    + " but you are not carrying anything it cuts from");
                return DroneHands.fail(r, "ingredients_missing");
            }
            return null;
        }
        BlockPos cutter = nearestWithin(level, act.eye(), st -> st.is(Blocks.STONECUTTER));
        if (cutter == null) {
            JsonObject r = new JsonObject();
            r.addProperty("note", "you carry what it cuts from but there is no STONECUTTER within"
                + " reach (~4.5 blocks) — place one (bot_place minecraft:stonecutter) and stand at"
                + " it, then craft again");
            return DroneHands.fail(r, "needs_stonecutter");
        }

        int produced = 0;
        int rounds = 0;
        Map<String, Integer> consumed = new LinkedHashMap<>();
        while (produced < count) {
            int from = findMatching(inv, recipe.input(), new int[inv.getContainerSize()]);
            if (from < 0) {
                break;
            }
            SingleRecipeInput input = new SingleRecipeInput(one(inv, from));
            if (!recipe.matches(input, level)) {
                break;
            }
            ItemStack result = recipe.assemble(input);
            if (result.isEmpty()) {
                break;
            }
            ItemStack src = inv.getItem(from);
            consumed.merge(DroneHands.itemId(src.getItem()), 1, Integer::sum);
            src.shrink(1);
            produced += result.getCount();
            spillLeftover(level, hands, hands.insert(result));
            rounds++;
        }
        return stationReply(level, hands, slot, wanted, holder, "stonecutter", cutter,
            produced, count, rounds, consumed);
    }

    /** The reply a station run produces — deliberately the same shape {@link #craft} returns, with
     *  one field added, so a caller need not learn a second result format to read a second route. */
    private static JsonObject stationReply(final ServerLevel level, final Hands hands,
                                           final DroneTools.Slot slot, final Item wanted,
                                           final RecipeHolder<?> holder, final String station,
                                           final BlockPos at, final int produced, final int count,
                                           final int rounds, final Map<String, Integer> consumed) {
        JsonObject r = new JsonObject();
        if (produced == 0) {
            r.addProperty("note", "ingredients ran out before anything was made");
            return DroneHands.fail(r, "ingredients_missing");
        }
        hands.placeVisual(at);
        r.addProperty("ok", true);
        r.addProperty("crafted", DroneHands.itemId(wanted));
        r.addProperty("produced", produced);
        r.addProperty("requested", count);
        r.addProperty("recipe", holder.id().identifier().toString());
        r.addProperty("station", station);
        r.addProperty("rounds", rounds);
        JsonArray consumedArr = new JsonArray();
        for (var e : consumed.entrySet()) {
            JsonObject o = new JsonObject();
            o.addProperty("item", e.getKey());
            o.addProperty("count", e.getValue());
            consumedArr.add(o);
        }
        r.add("consumed", consumedArr);
        if (produced < count) {
            r.addProperty("note", "ingredients ran out at " + produced + "/" + count
                + " — gather more and craft again");
        }
        DroneHands.emitDone(slot, "bot_craft", d -> {
            d.addProperty("item", DroneHands.itemId(wanted));
            d.addProperty("produced", produced);
            d.addProperty("station", station);
        });
        return r;
    }

    /** Which of the three smithing roles the body cannot fill, in the caller's words, or null. */
    private static @Nullable String smithingShortfall(final Container inv,
                                                      final SmithingRecipe recipe) {
        int[] reserved = new int[inv.getContainerSize()];
        List<String> missing = new ArrayList<>();
        if (recipe.templateIngredient().isPresent()
            && slotFor(inv, recipe.templateIngredient(), reserved) < 0) {
            missing.add("the upgrade TEMPLATE");
        }
        if (slotFor(inv, Optional.of(recipe.baseIngredient()), reserved) < 0) {
            missing.add("the BASE item to upgrade");
        }
        if (recipe.additionIngredient().isPresent()
            && slotFor(inv, recipe.additionIngredient(), reserved) < 0) {
            missing.add("the material to add");
        }
        return missing.isEmpty() ? null : String.join(" and ", missing);
    }

    /** An ingredient's first representative item — the same trick {@link #probeInput} uses to ask
     *  what a recipe makes without consulting what the body happens to carry. */
    private static ItemStack representative(final Optional<Ingredient> ingredient) {
        if (ingredient.isEmpty()) {
            return ItemStack.EMPTY;
        }
        return ingredient.get().items().findFirst().map(i -> new ItemStack(i, 1)).orElse(ItemStack.EMPTY);
    }

    /** The container slot satisfying an optional ingredient, marking it reserved; −1 when the
     *  ingredient is absent (a role this recipe does not use) or nothing carried satisfies it. */
    private static int slotFor(final Container inv, final Optional<Ingredient> ingredient,
                               final int[] reserved) {
        return ingredient.map(ing -> findMatching(inv, ing, reserved)).orElse(-1);
    }

    /** The first carried slot satisfying {@code ing} and not already claimed this round, or −1. */
    private static int findMatching(final Container inv, final Ingredient ing, final int[] reserved) {
        for (int i = 0; i < inv.getContainerSize(); i++) {
            ItemStack st = inv.getItem(i);
            if (!st.isEmpty() && st.getCount() - reserved[i] > 0 && ing.test(st)) {
                reserved[i]++;
                return i;
            }
        }
        return -1;
    }

    /** One item off a reserved slot, for building a recipe input; EMPTY for an unused role. */
    private static ItemStack one(final Container inv, final int slot) {
        return slot < 0 ? ItemStack.EMPTY : inv.getItem(slot).copyWithCount(1);
    }

    private static void spillLeftover(final ServerLevel level, final Hands hands, final ItemStack leftover) {
        if (!leftover.isEmpty()) {
            Block.popResource(level, hands.handsBody().blockPosition(), leftover);
        }
    }
}
