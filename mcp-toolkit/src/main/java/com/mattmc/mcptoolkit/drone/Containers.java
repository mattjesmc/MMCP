package com.mattmc.mcptoolkit.drone;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.EventLog;
import com.mattmc.mcptoolkit.McpTools;
import com.mattmc.mcptoolkit.Schemas;
import com.mattmc.mcptoolkit.ToolDef;
import com.mattmc.mcptoolkit.ExecutionContext;
import com.mattmc.mcptoolkit.Mechanism;
import com.mattmc.mcptoolkit.mixin.AbstractFurnaceBlockEntityAccessor;
import com.mattmc.mcptoolkit.mixin.BrewingStandBlockEntityAccessor;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.Container;
import net.minecraft.world.inventory.ContainerData;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.ChestBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.entity.AbstractFurnaceBlockEntity;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.entity.BrewingStandBlockEntity;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

/**
 * <b>World containers</b> — reading and moving items in chests, furnaces, barrels and the rest
 * (BOT_SURFACE_DESIGN.md §12.6).
 *
 * <p><b>Why this is a tool and not a {@code bot_use} behaviour.</b> {@code bot_use} calls
 * {@code ItemStack.useOn}, which is the <em>item's</em> behaviour. A furnace answers to the
 * <em>block's</em> interaction, and that interaction's whole effect is to open a {@code MenuProvider}
 * — a screen. A headless body has no screen, and emulating the packet dance of one would make every
 * container operation depend on menu synchronisation that exists only to serve a client. So the body
 * reaches into the {@link Container} directly, which is what the menu would have done anyway, minus
 * the screen. This is the same reasoning that made {@code GoalRunner} open doors through
 * {@code DoorBlock.setOpen} instead of routing them through {@code bot_use}.
 *
 * <p><b>Slot routing is the game's rule, never ours.</b> {@code put} chooses a slot with
 * {@link Container#canPlaceItem} — the same predicate hoppers obey. That is why raw iron lands in a
 * furnace's ingredient slot and coal in its fuel slot without this class knowing anything about
 * furnaces: {@code AbstractFurnaceBlockEntity.canPlaceItem} refuses the result slot outright and
 * accepts the fuel slot only for real fuel. A future container with its own rules works on the day it
 * is added.
 *
 * <p><b>Smelting is not an action here, and saying so matters.</b> Nothing in this class smelts:
 * loading a furnace and lighting it is the whole of what a player does, and the furnace then cooks on
 * its own ticks. So {@code put} reports the furnace's state back ({@code lit}, {@code cook_progress})
 * rather than claiming a result it cannot have produced yet — the caller polls {@code read} or simply
 * comes back later. Reporting "smelted" the moment fuel went in would be a textbook false success.
 * The same holds for brewing, which is why it needed no verb of its own either.
 *
 * <p><b>Brewing was reachable here for a year before anything said so.</b> {@link #containerAt}
 * resolves generically on {@code be instanceof Container}, and {@code BrewingStandBlockEntity} is
 * one — so the body could already load and empty a stand, with {@code canPlaceItem} routing blaze
 * powder to the fuel slot, nether wart to the ingredient slot and bottles to the three below,
 * exactly as it routes a furnace. What was missing was not a capability but the two things that make
 * one usable: the tool's description never named a brewing stand, and there was no state readout, so
 * "still water bottles" and "brewing right now" read identically and a body would pull its potions
 * out one tick early. That is the mirror image of the pre-0.35.0 crafting hole — <em>the verb was
 * there and the words were missing</em> — and it is why nobody found it.
 *
 * <p><b>The progress counters, and a decision reversed on purpose.</b> This class used to report no
 * cook progress, on the grounds that the timers live behind a {@code protected dataAccess} and would
 * have to be invented or prised out by reflection. That was right about reflection and wrong about
 * the consequence: the tool's own description had been promising {@code cook_progress} and
 * {@code fuel_ticks} since it shipped and neither was ever emitted, so the choice was never
 * "silence or invention" — it was between deleting the promise and keeping it. Keeping it wins,
 * because {@code lit} answers "is it burning" and not the question a body actually has: <em>should I
 * wait here or walk away, and will this fuel outlast this smelt?</em> They are read through typed
 * {@code @Accessor} mixins ({@code AbstractFurnaceBlockEntityAccessor}), the toolkit's established
 * way to reach real server state the API hides — checked at mixin-apply time, so it fails at startup
 * rather than silently at runtime. Read-only: nothing here writes a timer, because hurrying a
 * furnace is the false success this whole class exists to refuse.
 */
public final class Containers {
    private Containers() {}

    /** Furnace slot indices, republished from {@code AbstractFurnaceBlockEntity}'s protected constants. */
    private static final int FURNACE_INPUT = 0;
    private static final int FURNACE_FUEL = 1;
    private static final int FURNACE_RESULT = 2;

    /** Brewing-stand slot indices ({@code BrewingStandBlockEntity} keeps its own private). Slots
     *  0-2 are the bottles under the arms, 3 the ingredient on top, 4 the blaze powder. */
    private static final int BREW_BOTTLE_COUNT = 3;
    private static final int BREW_INGREDIENT = 3;
    private static final int BREW_FUEL = 4;

    /** A full brew, from {@code BrewingStandBlockEntity.serverTick}: {@code brewTime} is set to 400
     *  and counts DOWN, so progress is {@code (400 - brewTime) / 400}. */
    private static final int BREW_TOTAL_TICKS = 400;

    public static void register() {
        McpTools.register(ToolDef.async(
            "bot_container",
            "Read and move items in a WORLD CONTAINER your body can reach — chest, barrel, furnace, "
                + "blast furnace, smoker, BREWING STAND, hopper, dispenser, shulker box. This is how "
                + "smelting, brewing and storage work: bot_use cannot do it, because a container's "
                + "block interaction opens a SCREEN and your body has none. `at` is the container "
                + "block (within hand reach 4.5 with line of sight — bot_goto `reach` first). "
                + "action:\"read\" (default) lists the non-empty slots with their `role`, plus the "
                + "station's live state: a furnace's `lit`, `cook_progress` 0-1, `fuel_ticks` and what "
                + "it is smelting; a brewing stand's `brew_progress` 0-1, `brew_ticks_left` and "
                + "`brew_fuel` (brews left on its blaze powder). "
                + "action:\"put\" moves `item` (x`count`, default all you carry) from your inventory "
                + "INTO the container; the slot is chosen by the game's own rule, so raw ore lands in a "
                + "furnace's ingredient slot and coal in its fuel slot automatically — pass `slot` only "
                + "to override. action:\"take\" moves items the other way (omit `item` to take "
                + "everything; for a furnace that means the RESULT slot and for a brewing stand the "
                + "three BOTTLE slots, unless you name a `slot`). "
                + "TO SMELT: put the ore, put a fuel (coal/charcoal/planks), then come back and take — "
                + "the furnace cooks on its own ticks and this tool never claims it already has. "
                + "TO BREW: put water bottles, put blaze_powder (it goes to the FUEL slot; pass "
                + "slot:3 to use it as an ingredient instead), put the ingredient (nether_wart "
                + "first, then a modifier) — same rule, it brews on its own ticks. "
                + "Partial moves are reported honestly (`moved` vs `requested`) with a reason.",
            Schemas.objectOpt(Schemas.object(
                "at", Schemas.vec3i(),
                "action", Schemas.str("read (default) | put | take"),
                "item", Schemas.str("Item id to move. put: required. take: omit to take everything."),
                "count", Schemas.integer("How many to move (default: as many as possible)."),
                "slot", Schemas.integer("Force a specific slot index instead of the game's routing.")),
                "action", "item", "count", "slot"),
            ExecutionContext.SERVER,
            Mechanism.EMBODIED,
            (ctx, a) -> {
                DroneTools.Slot slot = DroneTools.slotFor(ctx.sessionId());
                String action = a.has("action") && !a.get("action").isJsonNull()
                    ? a.get("action").getAsString() : "read";
                FakePlayerEntity fp = slot.player();
                boolean playerActs = fp != null && Possession.live(slot) == null
                    && ("put".equals(action) || "take".equals(action));
                if (!playerActs) {
                    // Reads are not acts, and the drone has no ContainerUser hands — both stay
                    // instant, exactly as before.
                    return java.util.concurrent.CompletableFuture.completedFuture(handle(a, slot));
                }
                // Validate FIRST: a refusal must be instant, never a one-second performance
                // ending in "no". handle() re-checks at commit time (the world can move on).
                JsonObject refusal = precheck(a, slot);
                if (refusal != null) {
                    return java.util.concurrent.CompletableFuture.completedFuture(refusal);
                }
                if (ActCeremony.busy(slot)) {
                    JsonObject r = new JsonObject();
                    r.addProperty("ok", false);
                    r.addProperty("reason", "busy");
                    r.addProperty("note", "another container/craft act is in progress — it "
                        + "finishes within ~1s; retry after its reply");
                    return java.util.concurrent.CompletableFuture.completedFuture(r);
                }
                ServerLevel level = (ServerLevel) fp.level();
                BlockPos at = parsePos(a, "at");
                Hands hands = Actuator.require(slot).hands();
                java.util.concurrent.CompletableFuture<com.google.gson.JsonElement> waiter =
                    new java.util.concurrent.CompletableFuture<>();
                // THE CEREMONY: face the container, really open its menu server-side (the lid
                // rises and the open sound plays — ContainerOpenersCounter counts a genuinely
                // open menu, so its 5-tick recheck agrees), swing while transferring, close (lid
                // falls, close sound). FakeConnection drops the outbound screen packet; the
                // mutation itself is the same handle() that always ran, at commit tick.
                ActCeremony.begin(slot, "container", fp, Vec3.atCenterOf(at),
                    () -> handle(a, slot),
                    () -> {
                        BlockState st = level.getBlockState(at);
                        net.minecraft.world.MenuProvider mp = st.getMenuProvider(level, at);
                        if (mp != null) {
                            fp.openMenu(mp);
                        }
                    },
                    fp::closeContainer,
                    () -> hands.placeVisual(at),
                    12, 4, waiter);
                return waiter;
            }).withTimeout(30));
    }

    /**
     * The instant-refusal subset of {@link #handle}: is there a container, is it in reach? Returns
     * the refusal reply, or null when the act may proceed to its ceremony.
     */
    private static @Nullable JsonObject precheck(final JsonObject a, final DroneTools.Slot slot) {
        Actuator act = Actuator.require(slot);
        ServerLevel level = act.level();
        BlockPos at = parsePos(a, "at");
        JsonObject r = new JsonObject();
        BlockState state = level.getBlockState(at);
        Container container = containerAt(level, at, state);
        if (container == null) {
            r.addProperty("ok", false);
            r.addProperty("reason", "not_a_container");
            r.addProperty("block", blockId(state));
            r.addProperty("note", blockId(state) + " at " + at.getX() + "," + at.getY() + ","
                + at.getZ() + " holds no items — bot_container works on chests, barrels, furnaces,"
                + " brewing stands, hoppers, dispensers and shulker boxes");
            return r;
        }
        if (!act.inBlockReach(Vec3.atCenterOf(at))) {
            r.addProperty("ok", false);
            r.addProperty("reason", "out_of_reach");
            r.addProperty("note", "the container is out of hand reach — bot_goto with `reach` "
                + "{x,y,z} to stand where you can touch it, then call this again");
            return r;
        }
        return null;
    }

    private static JsonObject handle(final JsonObject a, final DroneTools.Slot slot) {
        Actuator act = Actuator.require(slot);
        Hands hands = act.hands(); // refuses a possessed body honestly: no hands, no item moving
        ServerLevel level = act.level();
        BlockPos at = parsePos(a, "at");

        JsonObject r = new JsonObject();
        BlockState state = level.getBlockState(at);
        Container container = containerAt(level, at, state);
        if (container == null) {
            r.addProperty("ok", false);
            r.addProperty("reason", "not_a_container");
            r.addProperty("block", blockId(state));
            r.addProperty("note", blockId(state) + " at " + at.getX() + "," + at.getY() + "," + at.getZ()
                + " holds no items — bot_container works on chests, barrels, furnaces, brewing"
                + " stands, hoppers, dispensers and shulker boxes");
            return r;
        }
        if (!act.inBlockReach(Vec3.atCenterOf(at))) {
            r.addProperty("ok", false);
            r.addProperty("reason", "out_of_reach");
            r.addProperty("note", "the container is out of hand reach — bot_goto with `reach` "
                + "{x,y,z} to stand where you can touch it, then call this again");
            return r;
        }

        String action = a.has("action") && !a.get("action").isJsonNull()
            ? a.get("action").getAsString() : "read";
        return switch (action) {
            case "read" -> describe(r, container, state, level, at);
            case "put" -> put(r, a, container, state, level, at, hands, slot);
            case "take" -> take(r, a, container, state, level, at, hands, slot);
            default -> throw new IllegalArgumentException(
                "`action` must be read | put | take (got '" + action + "')");
        };
    }

    /**
     * Does this block hold items? {@code bot_use} asks before falling through to a block interaction,
     * because a container's interaction is "open a screen" — which for a headless body would succeed
     * in the engine's eyes and achieve nothing, the exact false success the act-verdict doctrine
     * exists to prevent.
     */
    static boolean isContainer(final ServerLevel level, final BlockPos at, final BlockState state) {
        return state.getBlock() instanceof ChestBlock || level.getBlockEntity(at) instanceof Container;
    }

    /**
     * The container at {@code at}, or null when the block holds no items. A double chest is resolved
     * through {@code ChestBlock.getContainer} so both halves read and fill as the one container the
     * player would see — treating half of a double chest as the whole thing would silently lose track
     * of the other 27 slots.
     */
    private static @Nullable Container containerAt(final ServerLevel level, final BlockPos at,
                                                   final BlockState state) {
        if (state.getBlock() instanceof ChestBlock chest) {
            Container combined = ChestBlock.getContainer(chest, state, level, at, false);
            if (combined != null) {
                return combined;
            }
            // Null means the chest is BLOCKED (a solid block or a cat sits on it) — vanilla's own
            // rule for "a player could not open this". Falling through to the block entity would be
            // us granting access the game refuses.
            return null;
        }
        BlockEntity be = level.getBlockEntity(at);
        return be instanceof Container c ? c : null;
    }

    // ---- read ----------------------------------------------------------------

    private static JsonObject describe(final JsonObject r, final Container container,
                                       final BlockState state, final ServerLevel level,
                                       final BlockPos at) {
        r.addProperty("ok", true);
        r.addProperty("block", blockId(state));
        r.addProperty("size", container.getContainerSize());
        JsonArray slots = new JsonArray();
        int used = 0;
        for (int i = 0; i < container.getContainerSize(); i++) {
            ItemStack st = container.getItem(i);
            if (st.isEmpty()) {
                continue;
            }
            used++;
            JsonObject s = new JsonObject();
            s.addProperty("slot", i);
            s.addProperty("item", itemId(st));
            s.addProperty("count", st.getCount());
            String role = slotRole(container, i);
            if (role != null) {
                s.addProperty("role", role);
            }
            slots.add(s);
        }
        r.add("slots", slots);
        r.addProperty("used_slots", used);
        r.addProperty("empty_slots", container.getContainerSize() - used);
        furnaceState(r, container, state);
        brewingState(r, container);
        return r;
    }

    /**
     * A furnace's live state. Without this the caller cannot tell "loaded and burning" from "loaded
     * and dead" — the difference between waiting and adding fuel — and would have to guess from a
     * result slot that stays empty either way.
     *
     * <p>{@code lit} comes from the BLOCK STATE's public {@code LIT} property — the same bit that
     * makes the furnace glow. The two counters come from the block entity's own {@code dataAccess}
     * through {@code AbstractFurnaceBlockEntityAccessor} (see the class doc for why that reversed an
     * earlier decision); they are the same numbers the screen draws its two bars from.
     *
     * <p><b>The note is where the two counters earn their place.</b> A body that can see only
     * {@code lit} cannot answer "will this fuel outlast this smelt?" — and that is the one question
     * whose wrong answer costs a trip: walk away from a furnace whose coal dies at 80% and the ore
     * is still ore when you come back, because {@code cookingTimer} decays at
     * {@code BURN_COOL_SPEED} once the fire is out.
     */
    private static void furnaceState(final JsonObject r, final Container container,
                                     final BlockState state) {
        if (!(container instanceof AbstractFurnaceBlockEntity furnace)) {
            return;
        }
        boolean lit = state.hasProperty(net.minecraft.world.level.block.AbstractFurnaceBlock.LIT)
            && state.getValue(net.minecraft.world.level.block.AbstractFurnaceBlock.LIT);
        ItemStack input = furnace.getItem(FURNACE_INPUT);
        ItemStack fuel = furnace.getItem(FURNACE_FUEL);
        ItemStack result = furnace.getItem(FURNACE_RESULT);
        ContainerData data = ((AbstractFurnaceBlockEntityAccessor) furnace).mcptoolkit$data();
        int fuelTicks = data.get(AbstractFurnaceBlockEntity.DATA_LIT_TIME);
        int cookTicks = data.get(AbstractFurnaceBlockEntity.DATA_COOKING_PROGRESS);
        int cookTotal = data.get(AbstractFurnaceBlockEntity.DATA_COOKING_TOTAL_TIME);
        int cookLeft = Math.max(0, cookTotal - cookTicks);
        r.addProperty("lit", lit);
        r.addProperty("smelting", input.isEmpty() ? null : itemId(input));
        r.addProperty("result_ready", result.getCount());
        r.addProperty("cook_progress", fraction(cookTicks, cookTotal));
        r.addProperty("fuel_ticks", fuelTicks);
        if (result.getCount() > 0 && input.isEmpty()) {
            r.addProperty("note", "done — " + result.getCount() + "x " + itemId(result)
                + " waiting in the result slot; take it");
        } else if (input.isEmpty()) {
            r.addProperty("note", "nothing to smelt — put an ingredient in"
                + (fuel.isEmpty() ? " (and a fuel: coal, charcoal, planks)" : ""));
        } else if (!lit && fuel.isEmpty()) {
            r.addProperty("note", "loaded but NOT BURNING — it has no fuel; put coal/charcoal/planks in");
        } else if (!lit) {
            r.addProperty("note", "has fuel but is not lit yet — it lights on the next furnace tick;"
                + " read again in a second");
        } else if (cookTotal > 0 && fuelTicks < cookLeft) {
            r.addProperty("note", "burning, but the FUEL RUNS OUT FIRST — ~" + seconds(fuelTicks)
                + "s of fire left and ~" + seconds(cookLeft) + "s of cooking to go; put more fuel in"
                + " now or the progress bleeds back off");
        } else {
            r.addProperty("note", "burning — ~" + seconds(cookLeft) + "s left on this one; come back"
                + " and take the result. A furnace cooks on its own ticks and nothing here can hurry"
                + " it.");
        }
    }

    /**
     * <b>A brewing stand's live state</b> — the readout the furnace has had since day one and this
     * station never did. {@code brew_ticks_left} counts DOWN from {@link #BREW_TOTAL_TICKS}, so it is
     * also the answer to "how long until I can take these"; zero means nothing is brewing, which for
     * loaded bottles is either not-yet-started or already-done, and the ingredient slot is what tells
     * those apart. {@code brew_fuel} is brews left on powder ALREADY CONSUMED, not the powder sitting
     * in the slot — a stand can read {@code brew_fuel: 0} with powder in it and simply not have
     * picked it up yet.
     */
    private static void brewingState(final JsonObject r, final Container container) {
        if (!(container instanceof BrewingStandBlockEntity stand)) {
            return;
        }
        ContainerData data = ((BrewingStandBlockEntityAccessor) stand).mcptoolkit$data();
        int ticksLeft = data.get(BrewingStandBlockEntity.DATA_BREW_TIME);
        int fuel = data.get(BrewingStandBlockEntity.DATA_FUEL_USES);
        int bottles = 0;
        for (int i = 0; i < BREW_BOTTLE_COUNT; i++) {
            if (!stand.getItem(i).isEmpty()) {
                bottles++;
            }
        }
        ItemStack ingredient = stand.getItem(BREW_INGREDIENT);
        ItemStack powder = stand.getItem(BREW_FUEL);
        r.addProperty("brew_ticks_left", ticksLeft);
        // Zero when nothing is running. The countdown makes `400 - 0` look like a finished brew,
        // and an idle stand reporting 100% is the same lie as a furnace reporting "smelted".
        r.addProperty("brew_progress",
            ticksLeft <= 0 ? 0.0 : fraction(BREW_TOTAL_TICKS - ticksLeft, BREW_TOTAL_TICKS));
        r.addProperty("brew_fuel", fuel);
        r.addProperty("bottles", bottles);
        r.addProperty("brewing_with", ingredient.isEmpty() ? null : itemId(ingredient));
        if (ticksLeft > 0) {
            r.addProperty("note", "brewing — ~" + seconds(ticksLeft) + "s left; come back and take"
                + " the bottles. Taking them now takes them UNFINISHED.");
        } else if (bottles == 0) {
            r.addProperty("note", "no bottles — put water_bottle in (up to 3 brew at once)");
        } else if (ingredient.isEmpty()) {
            r.addProperty("note", "idle — nothing more will happen until an ingredient goes in"
                + " (nether_wart first, then a modifier); the bottles are ready to take");
        } else if (fuel <= 0 && powder.isEmpty()) {
            r.addProperty("note", "loaded but NO FUEL — put blaze_powder in; one powder is 20 brews");
        } else {
            r.addProperty("note", "loaded — it starts on the next stand tick; read again in a second");
        }
    }

    /** The player-visible job of a slot, for the stations whose slots are not interchangeable. */
    private static @Nullable String slotRole(final Container container, final int slot) {
        if (container instanceof AbstractFurnaceBlockEntity) {
            return switch (slot) {
                case FURNACE_INPUT -> "ingredient";
                case FURNACE_FUEL -> "fuel";
                case FURNACE_RESULT -> "result";
                default -> "unknown";
            };
        }
        if (container instanceof BrewingStandBlockEntity) {
            return switch (slot) {
                case BREW_INGREDIENT -> "ingredient";
                case BREW_FUEL -> "fuel";
                default -> slot < BREW_BOTTLE_COUNT ? "bottle" : "unknown";
            };
        }
        return null;
    }

    /** A 0-1 progress fraction at three decimals — enough to plan against, not enough to imply a
     *  precision the tick clock does not have. Zero when nothing is running, which is what an
     *  untouched station should report rather than a division by zero. */
    private static double fraction(final int done, final int total) {
        return total <= 0 ? 0.0 : Math.round(1000.0 * done / total) / 1000.0;
    }

    /** Ticks as whole seconds — the unit the caller actually decides in. */
    private static int seconds(final int ticks) {
        return Math.max(0, ticks) / 20;
    }

    // ---- put -----------------------------------------------------------------

    private static JsonObject put(final JsonObject r, final JsonObject a, final Container container,
                                  final BlockState state, final ServerLevel level, final BlockPos at,
                                  final Hands hands, final DroneTools.Slot slot) {
        String id = a.has("item") && !a.get("item").isJsonNull() ? a.get("item").getAsString() : null;
        if (id == null) {
            throw new IllegalArgumentException("`put` needs an `item` id to move");
        }
        Container inv = hands.container();
        int want = a.has("count") && !a.get("count").isJsonNull() ? a.get("count").getAsInt()
            : Integer.MAX_VALUE;
        if (want <= 0) {
            throw new IllegalArgumentException("`count` must be positive");
        }
        Integer forced = forcedSlot(a, container);

        int carried = countIn(inv, id);
        if (carried == 0) {
            r.addProperty("ok", false);
            r.addProperty("reason", "item_missing");
            r.addProperty("note", "you are not carrying any " + id
                + " — bot_status {inventory:true} shows what you have");
            return r;
        }
        int requested = Math.min(want, carried);
        int moved = 0;
        String blocked = null;
        for (int i = 0; i < inv.getContainerSize() && moved < requested; i++) {
            ItemStack src = inv.getItem(i);
            if (src.isEmpty() || !itemId(src).equals(normalize(id))) {
                continue;
            }
            int take = Math.min(src.getCount(), requested - moved);
            int accepted = insert(container, src, take, forced);
            if (accepted == 0 && blocked == null) {
                blocked = whyRejected(container, src, forced);
            }
            src.shrink(accepted);
            if (src.isEmpty()) {
                inv.setItem(i, ItemStack.EMPTY);
            }
            moved += accepted;
        }
        if (moved > 0) {
            container.setChanged();
            inv.setChanged();
            hands.placeVisual(at); // the body reaches out — the same swing a place makes
        }

        r.addProperty("ok", moved > 0);
        r.addProperty("item", normalize(id));
        r.addProperty("requested", requested);
        r.addProperty("moved", moved);
        r.addProperty("still_carried", countIn(inv, id));
        if (moved == 0) {
            r.addProperty("reason", "rejected");
            r.addProperty("note", blocked != null ? blocked
                : "the container would not accept " + id + " (full, or no slot takes it)");
        } else if (moved < requested) {
            r.addProperty("note", "only " + moved + " of " + requested + " fit — "
                + (blocked != null ? blocked : "the container is full"));
        }
        describeAfter(r, container, state, level, at);
        audit(slot, "put", at, normalize(id), moved);
        return r;
    }

    /**
     * Insert up to {@code count} of {@code src} into the container, letting {@link
     * Container#canPlaceItem} decide which slots may take it. Stacks with a matching partial slot
     * first (what a player's shift-click does), then fills an empty one — and a preferred slot
     * before either, where {@link #preferred} says the game's rule leaves a genuine tie.
     */
    private static int insert(final Container container, final ItemStack src, final int count,
                              final @Nullable Integer forced) {
        int remaining = count;
        Integer pref = forced == null ? preferred(container, src) : null;
        if (pref != null) {
            remaining -= fill(container, src, remaining, pref, pref + 1);
        }
        int from = forced != null ? forced : 0;
        int to = forced != null ? forced + 1 : container.getContainerSize();
        remaining -= fill(container, src, remaining, from, to);
        return count - remaining;
    }

    /**
     * <b>Where the game's rule stops answering the question.</b> {@code canPlaceItem} answers "may
     * this go here", which is all a hopper ever needs — but {@code put} is asking "which here did
     * you mean", and for exactly one item in one station both slots say yes. A brewing stand's
     * ingredient slot takes anything {@code PotionBrewing.isIngredient} accepts, and blaze powder is
     * an ingredient (it brews strength); its fuel slot takes {@code #minecraft:brewing_fuel}, which
     * blaze powder also is. Scanning slots in index order therefore put every powder in slot 3 and
     * left the stand unfuelled AND unable to take the nether wart that belonged there — a stand that
     * could never brew, from two calls that both reported success.
     *
     * <p>The tie is broken toward the NARROWER predicate: the fuel slot accepts one tag, the
     * ingredient slot accepts a family, so an item both accept was meant for the fuel slot. That is
     * also what a player does — you cannot brew at all without fuel. Powder therefore never reaches
     * slot 3 by routing at all (a second one stacks in the fuel slot), so a caller who wants it as
     * the ingredient passes {@code slot: 3} — which is what the override is for, and which the tool
     * description names at exactly the point a caller meets it.
     *
     * <p>Deliberately not generalised into a "prefer the pickiest slot" rule: predicate breadth is
     * not something a {@link Container} exposes, and inventing a measure of it would be our rule
     * wearing the game's clothes. This is one named tie in one station.
     */
    private static @Nullable Integer preferred(final Container container, final ItemStack src) {
        if (container instanceof BrewingStandBlockEntity
            && src.is(net.minecraft.tags.ItemTags.BREWING_FUEL)
            && container.canPlaceItem(BREW_FUEL, src)) {
            return BREW_FUEL;
        }
        return null;
    }

    /** The two passes over one slot range: top up matching stacks, then claim empty slots. */
    private static int fill(final Container container, final ItemStack src, final int count,
                            final int from, final int to) {
        int remaining = count;
        for (int pass = 0; pass < 2 && remaining > 0; pass++) {
            boolean wantEmpty = pass == 1;
            for (int i = from; i < to && remaining > 0; i++) {
                ItemStack dst = container.getItem(i);
                boolean empty = dst.isEmpty();
                if (empty != wantEmpty) {
                    continue;
                }
                if (!container.canPlaceItem(i, src)) {
                    continue;
                }
                if (empty) {
                    int n = Math.min(remaining, Math.min(src.getMaxStackSize(),
                        container.getMaxStackSize()));
                    ItemStack put = src.copyWithCount(n);
                    container.setItem(i, put);
                    remaining -= n;
                } else {
                    if (!ItemStack.isSameItemSameComponents(dst, src)) {
                        continue;
                    }
                    int room = Math.min(dst.getMaxStackSize(), container.getMaxStackSize())
                        - dst.getCount();
                    int n = Math.min(remaining, Math.max(0, room));
                    dst.grow(n);
                    remaining -= n;
                }
            }
        }
        return count - remaining;
    }

    /**
     * Why a container refused an item, in the caller's terms. The furnace case is the one that
     * actually bites — "it wouldn't fit" is useless when the real answer is "that is not fuel".
     */
    private static String whyRejected(final Container container, final ItemStack src,
                                      final @Nullable Integer forced) {
        if (forced != null && !container.canPlaceItem(forced, src)) {
            if (container instanceof AbstractFurnaceBlockEntity && forced == FURNACE_FUEL) {
                return itemId(src) + " is not a fuel — a furnace's fuel slot takes coal, charcoal,"
                    + " planks, logs and the like";
            }
            if (container instanceof AbstractFurnaceBlockEntity && forced == FURNACE_RESULT) {
                return "slot 2 is the RESULT slot — nothing can be put into it; take from it instead";
            }
            return "slot " + forced + " does not accept " + itemId(src);
        }
        if (container instanceof AbstractFurnaceBlockEntity) {
            return itemId(src) + " was refused: a furnace takes an ingredient (slot 0) and a FUEL"
                + " (slot 1) only — if you meant it as fuel, it does not burn";
        }
        if (container instanceof BrewingStandBlockEntity) {
            return itemId(src) + " was refused: a brewing stand takes water/other bottles in slots"
                + " 0-2 (one each, and only into an EMPTY one), a brewing ingredient in slot 3 and"
                + " blaze_powder in slot 4 — nothing else, and no slot doubles up";
        }
        return "no slot accepted " + itemId(src) + " — the container is full";
    }

    /**
     * Why a take came back with nothing. The station cases matter because the honest answer is not
     * "nothing matched" but "what you asked for is not made yet", which is a different next move —
     * wait, rather than go somewhere else.
     */
    private static String emptyTakeNote(final Container container, final @Nullable Integer forced,
                                        final boolean stationDefault, final @Nullable String id) {
        boolean furnaceResult = container instanceof AbstractFurnaceBlockEntity
            && (stationDefault || (forced != null && forced == FURNACE_RESULT));
        if (furnaceResult) {
            return "the furnace's result slot is empty — it has not finished smelting; read it to"
                + " see whether it is lit and how far along it is";
        }
        if (stationDefault && container instanceof BrewingStandBlockEntity) {
            return "the stand's three bottle slots are empty — put water_bottle in before there is"
                + " anything to take";
        }
        return "nothing here matched" + (id == null ? "" : " " + id);
    }

    // ---- take ----------------------------------------------------------------

    private static JsonObject take(final JsonObject r, final JsonObject a, final Container container,
                                   final BlockState state, final ServerLevel level, final BlockPos at,
                                   final Hands hands, final DroneTools.Slot slot) {
        Container inv = hands.container();
        String id = a.has("item") && !a.get("item").isJsonNull() ? a.get("item").getAsString() : null;
        int want = a.has("count") && !a.get("count").isJsonNull() ? a.get("count").getAsInt()
            : Integer.MAX_VALUE;
        if (want <= 0) {
            throw new IllegalArgumentException("`count` must be positive");
        }
        Integer forced = forcedSlot(a, container);

        // "Take everything" from a STATION means "give me what it made". Emptying a furnace's fuel
        // and half-smelted ore, or a stand's blaze powder and nether wart, would be actively
        // unhelpful — and on the stand it would also stop a brew that was already running.
        int from = 0;
        int to = container.getContainerSize();
        boolean stationDefault = false;
        if (forced != null) {
            from = forced;
            to = forced + 1;
        } else if (id == null && container instanceof AbstractFurnaceBlockEntity) {
            from = FURNACE_RESULT;
            to = FURNACE_RESULT + 1;
            stationDefault = true;
        } else if (id == null && container instanceof BrewingStandBlockEntity) {
            to = BREW_BOTTLE_COUNT;
            stationDefault = true;
        }

        int moved = 0;
        boolean full = false;
        for (int i = from; i < to && moved < want; i++) {
            ItemStack src = container.getItem(i);
            if (src.isEmpty() || (id != null && !itemId(src).equals(normalize(id)))) {
                continue;
            }
            int n = Math.min(src.getCount(), want - moved);
            ItemStack leftover = hands.insert(src.copyWithCount(n));
            int accepted = n - leftover.getCount();
            if (accepted < n) {
                full = true;
            }
            src.shrink(accepted);
            if (src.isEmpty()) {
                container.setItem(i, ItemStack.EMPTY);
            }
            moved += accepted;
            if (full) {
                break;
            }
        }
        if (moved > 0) {
            container.setChanged();
            inv.setChanged();
            hands.placeVisual(at);
        }

        r.addProperty("ok", moved > 0);
        r.addProperty("moved", moved);
        if (id != null) {
            r.addProperty("item", normalize(id));
        }
        if (moved == 0) {
            r.addProperty("reason", full ? "inventory_full" : "nothing_to_take");
            r.addProperty("note", full
                ? "your inventory is full — drop or store something first"
                : emptyTakeNote(container, forced, stationDefault, id));
        } else if (full) {
            r.addProperty("note", "took " + moved + " and stopped — your inventory filled up");
        }
        if (full) {
            // Same reason the mining spill events: a partial take reads as a success, and "took 12
            // of the 40 you asked for" is the kind of shortfall a listening loop must be able to
            // subscribe to rather than re-read out of a result it already moved past.
            JsonObject fullEvt = new JsonObject();
            fullEvt.addProperty("action", "bot_container");
            addPos(fullEvt, "at", at);
            fullEvt.addProperty("took", moved);
            if (id != null) {
                fullEvt.addProperty("item", normalize(id));
            }
            fullEvt.addProperty("note", moved == 0
                ? "your pack is full — nothing could be taken; the items are STILL IN THE CONTAINER"
                : "your pack filled up after " + moved + " — the rest is still in the container");
            EventLog.emit("inventory_full", fullEvt, slot.target());
        }
        describeAfter(r, container, state, level, at);
        audit(slot, "take", at, id == null ? "any" : normalize(id), moved);
        return r;
    }

    // ---- shared --------------------------------------------------------------

    /** The container's state AFTER the move — so a put/take needs no follow-up `read` call. */
    private static void describeAfter(final JsonObject r, final Container container,
                                      final BlockState state, final ServerLevel level,
                                      final BlockPos at) {
        JsonObject after = new JsonObject();
        describe(after, container, state, level, at);
        after.remove("ok");
        r.add("container", after);
    }

    private static @Nullable Integer forcedSlot(final JsonObject a, final Container container) {
        if (!a.has("slot") || a.get("slot").isJsonNull()) {
            return null;
        }
        int s = a.get("slot").getAsInt();
        if (s < 0 || s >= container.getContainerSize()) {
            throw new IllegalArgumentException("`slot` " + s + " is outside this container (size "
                + container.getContainerSize() + ")");
        }
        return s;
    }

    /**
     * Disclose the move. Routed through {@code DroneHands.emitDone} rather than emitting directly, so
     * it carries the same envelope stamp every other embodied verdict does — a hand-rolled event that
     * skipped the stamp would be an undatable world interaction.
     */
    private static void addPos(final JsonObject o, final String key, final BlockPos pos) {
        JsonObject p = new JsonObject();
        p.addProperty("x", pos.getX());
        p.addProperty("y", pos.getY());
        p.addProperty("z", pos.getZ());
        o.add(key, p);
    }

    private static void audit(final DroneTools.Slot slot, final String what, final BlockPos at,
                              final String item, final int moved) {
        DroneHands.emitDone(slot, "bot_container", d -> {
            d.addProperty("op", what);
            d.addProperty("x", at.getX());
            d.addProperty("y", at.getY());
            d.addProperty("z", at.getZ());
            d.addProperty("item", item);
            d.addProperty("moved", moved);
        });
    }

    private static int countIn(final Container inv, final String id) {
        String want = normalize(id);
        int n = 0;
        for (int i = 0; i < inv.getContainerSize(); i++) {
            ItemStack st = inv.getItem(i);
            if (!st.isEmpty() && itemId(st).equals(want)) {
                n += st.getCount();
            }
        }
        return n;
    }

    /** An item id in canonical form, so `coal` and `minecraft:coal` compare equal. */
    private static String normalize(final String id) {
        Identifier rl = Identifier.parse(id);
        Item item = BuiltInRegistries.ITEM.getOptional(rl)
            .orElseThrow(() -> new IllegalArgumentException("unknown item '" + id + "'"));
        return BuiltInRegistries.ITEM.getKey(item).toString();
    }

    /** The container block position — this tool's own, since {@code DroneHands.parsePos} is private. */
    private static BlockPos parsePos(final JsonObject a, final String key) {
        if (!a.has(key) || !a.get(key).isJsonObject()) {
            throw new IllegalArgumentException("missing `" + key + "` {x,y,z}");
        }
        JsonObject p = a.getAsJsonObject(key);
        return new BlockPos(p.get("x").getAsInt(), p.get("y").getAsInt(), p.get("z").getAsInt());
    }

    private static String itemId(final ItemStack st) {
        return BuiltInRegistries.ITEM.getKey(st.getItem()).toString();
    }

    private static String blockId(final BlockState state) {
        return BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
    }
}
