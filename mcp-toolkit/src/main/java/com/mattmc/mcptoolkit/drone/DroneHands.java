package com.mattmc.mcptoolkit.drone;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.BlockTools;
import com.mattmc.mcptoolkit.EventLog;
import com.mattmc.mcptoolkit.ExecutionContext;
import com.mattmc.mcptoolkit.McpTools;
import com.mattmc.mcptoolkit.Mechanism;
import com.mattmc.mcptoolkit.Schemas;
import com.mattmc.mcptoolkit.ToolDef;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.SimpleContainer;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.context.UseOnContext;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

/**
 * The drone's <b>hands</b> — the actuator contract's tool surface (ARCHITECTURE.md roadmap step 4). Where
 * {@code DroneTools} moves and aims the body and {@code WorldPerceptionTools} reads the world, these tools
 * make the body <em>act on</em> it: mine, place, use, attack, and manage what it carries. Every acting tool
 * passes through {@link Actuator#require} — no body means role {@code actuator: none} and the act is
 * refused. Hand tools (mine/place/use/inventory/select/give) additionally require the body to BE the drone
 * ({@link Actuator#hands()}) — a possessed mob can attack but holds nothing.
 *
 * <p><b>Embodied, never {@code world_edit}.</b> These are {@link Mechanism#EMBODIED}: a body does them, they
 * respect reach, and they fail on the game's own terms ({@code out_of_reach}, {@code obstructed},
 * {@code block_changed}) — the opposite of {@code set_blocks}/{@code place_shape}, which rewrite the world
 * instantly and at scale. "The drone mined this block" and "the server deleted this block" are different acts
 * and are reported as such. The one exception here is {@code bot_give}, which materializes items from nothing
 * — a creative act, so it is {@link Mechanism#PRIVILEGED} and audited at the dispatch chokepoint.
 *
 * <p><b>Player-visible action feedback.</b> A dig shows the vanilla crack overlay
 * ({@code destroyBlockProgress}, stages 0–9 scaled to dig progress) and aims the drone's orange dig beam
 * at the block; an attack fires the red beam plus a client-side lunge — the interactions run in code,
 * tick by tick, while the agent is off thinking.
 *
 * <p><b>Slow actions go async through the event log.</b> Mining takes time (hardness-scaled ticks), so
 * {@code bot_mine} returns {@code {started, action_id}} immediately and the dig finishes on a later tick with
 * an {@code action_completed} (mined block + drops harvested into the drone's inventory) or an
 * {@code action_failed} carrying a structured reason — the same feedback channel {@code bot_goto} uses; pass
 * {@code wait:true} to have the call itself return the outcome. Instant mutations (place/use/attack) return
 * synchronously and also drop an {@code action_completed} into the log so the embodiment trail is complete
 * beside the world-edit audit.
 */
public final class DroneHands {
    private DroneHands() {}

    /** How long the red attack beam (and lunge) lingers, in ticks. */
    static final int ATTACK_FLASH_TICKS = 7;

    /** Sequence for embodied action ids; the {@code m-} namespace keeps them distinct from bot_goto's {@code a-}. */
    private static long actionSeq = 0;

    /** The next embodied action number, for the act namespaces that live outside this class
     *  ({@code PlayerVerbs}' draw). One counter, so no two acts can ever share an id. */
    static long nextActionSeq() {
        return ++actionSeq;
    }

    /**
     * A dig longer than this (60s) is announced up front. Session w2-56123 spent 8m20s on ONE dig —
     * a water source, hardness 100 with no correct tool, 10 000 ticks — during which every other dig
     * in the world answered {@code busy}. The refusal below catches fluids specifically; this
     * catches the general shape, including whatever the next surprise is.
     */
    static final int SLOW_DIG_TICKS = 1200;

    /**
     * Ticks a dig may spend frozen under reflex/combat ownership before it is announced, and before
     * it is failed honestly. {@code slot.dig} is the one subsystem with no watchdog: while a
     * reaction owns the body the dig does not advance, does not fail, and does not time out — it
     * stops existing in time (DroneTools.tickWatch). Nav got {@code nav_starved} for exactly this
     * shape; the dig gets the same.
     */
    static final int DIG_STARVED_TICKS = 100;
    static final int DIG_STARVED_ABORT_TICKS = 600;

    /** Settle-phase pacing: ticks of natural pop-and-vacuum before the magnet assist starts, and
     *  the hard cap after which whatever is still on the ground is reported as spilled. */
    static final int SETTLE_MAGNET_TICKS = 15;
    static final int SETTLE_MAX_TICKS = 40;

    /** One outstanding dig, held per session slot ({@link DroneTools.Slot#dig}), advanced by {@link #tick}. */
    static final class Dig {
        final String actionId;
        final Hands hands;
        final BlockPos pos;
        final BlockState expected;
        final ItemStack tool;
        final int total;
        final @Nullable CompletableFuture<JsonElement> waiter;
        int remaining;
        int lastStage = -1;
        /** Game tick the dig started, so a `busy` refusal can say how long the holder has held. */
        long startedTick;
        /** Consecutive ticks this dig was skipped because a reflex or combat owned the body. */
        int starvedTicks;
        /** True once dig_starved has been announced for this dig — the event fires once, not 500x. */
        boolean starvedAnnounced;
        /**
         * SETTLE PHASE (player hands only): the block is broken and its drops are REAL item
         * entities in the world, popping and being vacuumed by the body's own vanilla pickup
         * sweep. Non-null = settling; {@code slot.dig} stays set so {@code busy} remains truthful,
         * and the completion event fires only when the inventory actually changed — with counts
         * derived from a before/after per-item delta, never from an assumed insert.
         */
        @Nullable List<net.minecraft.world.entity.item.ItemEntity> settling;
        int settleTicks;
        /** Per-item inventory counts snapshotted BEFORE spawning drops (delta = collected). */
        @Nullable Map<String, Integer> invBefore;
        /** Per-item counts actually spawned as entities (the delta's clamp — a same-item stray
         *  entity wandering into the pickup sweep must not inflate `collected`). */
        @Nullable Map<String, Integer> spawned;
        /** The mined state, held for the settle-end completion event. */
        @Nullable BlockState minedAs;

        Dig(String actionId, Hands hands, BlockPos pos, BlockState expected, ItemStack tool,
            int total, @Nullable CompletableFuture<JsonElement> waiter) {
            this.actionId = actionId;
            this.hands = hands;
            this.pos = pos;
            this.expected = expected;
            this.tool = tool;
            this.total = total;
            this.remaining = total;
            this.waiter = waiter;
        }
    }

    public static void register() {
        McpTools.register(ToolDef.async(
            "bot_mine",
            "Have YOUR body mine (break) the block at `at` {x,y,z}. The block must be within hand reach "
                + "(~4.5 blocks of the eye) — get there with bot_goto {reach:{x,y,z}} first, or use "
                + "bot_target {action:\"destroy\"} which does goto+mine in one call. Mining takes time "
                + "scaled by block hardness (a player body digs at the engine's own speed: the held tool "
                + "matters); returns {started, action_id, eta_ticks} immediately, then finishes with an "
                + "action_completed event (mined block + drops, collected into your inventory) or an "
                + "action_failed event {reason} — poll get_events, or pass `wait`:true to have THIS CALL "
                + "return the outcome. Drops that don't fit spill into the world. Fails before starting "
                + "with started:false and a reason: nothing_to_mine (air), unbreakable (bedrock etc), "
                + "fluid_target (water/lava — displace it, don't dig it), out_of_reach, occluded "
                + "(the block is hidden behind others — no sightline from the eye touches any face; "
                + "reposition, or bot_target {action:\"destroy\", may_modify:\"break\"} digs the "
                + "occluders for you), unreadable (the chunks between eye and target are not "
                + "loaded, so the sightline cannot be checked — move closer and retry), item_missing "
                + "(the named `item` is not in inventory), wrong_tool (player body, drop-gated block: "
                + "the tool you hold/named collects NOTHING from it and the dig is refused — the note "
                + "names the fix), or busy (a dig is already running — the reply "
                + "names the holder: {action_id, at, block, eta_ticks}). A PLAYER body reaches for its "
                + "own tools: when no `item` is named, the dig auto-selects the pack's FASTEST tool "
                + "that still harvests this block (tool_switched:true — fires both when the held tool "
                + "would lose the drops and when it is merely slower); a drop-gated block with no "
                + "correct-tier tool in the pack refuses wrong_tool unless accept_no_drops:true. The result "
                + "echoes `tool` (what is actually wielded) plus its enchantments, warns "
                + "drops_expected:false when the dig will collect nothing, and warns when a dig will "
                + "take over a minute. `action`:\"cancel\" abandons the running dig and frees the hands.",
            Schemas.objectOpt(Schemas.object(
                "at", Schemas.vec3i(),
                "action", Schemas.str("\"mine\" (default) or \"cancel\" to abandon the running dig."),
                "item", Schemas.str("Optional inventory item id to mine with (affects drops, e.g. a silk-touch "
                    + "or correct-tier tool); defaults to the held item."),
                "accept_no_drops", Schemas.bool("Break a drop-gated block even though the tool "
                    + "collects nothing from it (the player body refuses such digs otherwise: "
                    + "reason wrong_tool)."),
                "wait", Schemas.bool("If true, the call returns only when the dig completes/fails.")),
                "at", "action", "item", "accept_no_drops", "wait"),
            ExecutionContext.SERVER,
            Mechanism.EMBODIED,
            (ctx, a) -> {
                DroneTools.Slot slot = DroneTools.slotFor(ctx.sessionId());
                String action = a.has("action") && !a.get("action").isJsonNull()
                    ? a.get("action").getAsString() : "mine";
                if ("cancel".equals(action)) {
                    return CompletableFuture.completedFuture(cancelDig(slot));
                }
                if (!"mine".equals(action)) {
                    throw new IllegalArgumentException("bot_mine `action` is \"mine\" or \"cancel\"");
                }
                if (!a.has("at") || a.get("at").isJsonNull()) {
                    throw new IllegalArgumentException(
                        "bot_mine needs `at` {x,y,z} — the block to break (only action:\"cancel\" omits it)");
                }
                CompletableFuture<JsonElement> waiter =
                    DroneTools.wantsWait(a) ? new CompletableFuture<>() : null;
                JsonObject r = startMine(a, slot, waiter);
                if (waiter != null && r.get("started").getAsBoolean()) {
                    return waiter;
                }
                return CompletableFuture.completedFuture(r);
            }).withTimeout(60));

        McpTools.register(ToolDef.of(
            "bot_place",
            "Have the drone place a block from its inventory at `at` {x,y,z}. The item is the held one unless "
                + "`item` (a block id) is given; the target cell must be empty/replaceable and within reach. "
                + "Places the block's default state unless `state` gives an explicit block state (e.g. "
                + "\"minecraft:oak_stairs[facing=east]\") — its block must match the item. Consumes one item "
                + "only when the block actually lands. Fails with a reason: empty_hand, held_item_not_a_block (item "
                + "isn't a block), obstructed, out_of_reach, unsupported_position (it would immediately pop "
                + "off, e.g. a torch on air), or place_rejected (the world refused the write).",
            Schemas.objectOpt(Schemas.object(
                "at", Schemas.vec3i(),
                "state", Schemas.str("Optional full block state to place, e.g. minecraft:oak_stairs[facing=east]; "
                    + "its block must match the item. Defaults to the block's default state."),
                "item", Schemas.str("Block item id to place, e.g. minecraft:oak_planks. Defaults to the held item.")),
                "state", "item"),
            ExecutionContext.SERVER,
            Mechanism.EMBODIED,
            (ctx, a) -> botPlace(a, DroneTools.slotFor(ctx.sessionId()))));

        McpTools.register(ToolDef.of(
            "bot_use",
            "Have the drone use (right-click) its held item on the block at `at` {x,y,z} — e.g. bone meal on a "
                + "crop, a hoe to till, flint and steel to ignite. `face` (default up) is the clicked face, "
                + "`item` overrides the held item. Best-effort: item behaviours that require a real player are "
                + "not supported and return reason:use_unsupported (with the underlying `detail`). Reports "
                + "`effect` (used | none — the game's own verdict), whether the clicked block changed, and "
                + "how many items were consumed; effect:none with block_changed:false means nothing happened.",
            Schemas.objectOpt(Schemas.object(
                "at", Schemas.vec3i(),
                "face", Schemas.str("Clicked face: up|down|north|south|east|west (default up)."),
                "item", Schemas.str("Item id to use. Defaults to the held item.")),
                "face", "item"),
            ExecutionContext.SERVER,
            Mechanism.EMBODIED,
            (ctx, a) -> botUse(a, DroneTools.slotFor(ctx.sessionId()))));

        McpTools.register(ToolDef.async(
            "bot_attack",
            "Have YOUR body melee-attack an entity. Give `target` (an entity id from get_entities) "
                + "or set `nearest`:true to hit the nearest VISIBLE living entity in reach. The swing "
                + "is gated like a real player's: the target must be in reach (player body: the "
                + "vanilla entity-interaction range, ~3 blocks; drone/walker: 4), with LINE OF SIGHT "
                + "(reason `occluded` otherwise — no hitting through walls), and the body must be "
                + "FACING it (within ~10°). Already facing → the call is synchronous: {ok, hit, "
                + "weapon, target, damageDealt}. Not facing → the body TURNS toward the target at "
                + "its normal gaze rate and the call returns {started:true, action_id, eta_ticks}, "
                + "completing with an action_completed {hit, ...} or action_failed {reason: "
                + "target_lost | occluded | out_of_reach | facing_timeout} event — poll get_events, "
                + "or pass `wait`:true to have THIS CALL return the outcome. THE BODY ARMS ITSELF: a "
                + "player body reaches for the best weapon it carries before the swing (ranked by the "
                + "items' own damage × attack speed) and reports `weapon_switched` when the hand "
                + "changed — you never have to select a sword, and a body that just dug with a pickaxe "
                + "does not fight with it. Name `item` to override. Immediate failures: no_target, "
                + "out_of_reach, occluded, item_missing (the named `item` is not in inventory).",
            Schemas.objectOpt(Schemas.object(
                "target", Schemas.integer("Entity id to attack (from get_entities/raycast)."),
                "nearest", Schemas.bool("If true, attack the nearest visible living entity in reach instead of `target`."),
                "item", Schemas.str("Optional inventory item id to wield for the hit. Omit it and a "
                    + "player body auto-arms with its best weapon; the drone falls back to its held item."),
                "wait", Schemas.bool("If true and a facing turn is needed, the call returns only when "
                    + "the swing lands or fails.")),
                "target", "nearest", "item", "wait"),
            ExecutionContext.SERVER,
            Mechanism.EMBODIED,
            (ctx, a) -> {
                DroneTools.Slot slot = DroneTools.slotFor(ctx.sessionId());
                CompletableFuture<JsonElement> waiter =
                    DroneTools.wantsWait(a) ? new CompletableFuture<>() : null;
                JsonObject r = botAttack(a, slot, waiter);
                if (waiter != null && r.has("started") && r.get("started").getAsBoolean()) {
                    return waiter;
                }
                return CompletableFuture.completedFuture(r);
            }).withTimeout(15));

        McpTools.register(ToolDef.async(
            "bot_shoot",
            "SHOOT an entity — no reach limit (take a vantage, then rain arrows down). Give `target` "
                + "(entity id) or `nearest`:true (nearest hostile within ~32 blocks). THE BODY ARMS "
                + "ITSELF: it reaches for a bow/crossbow it CARRIES AND CAN FEED, so you never select "
                + "one, and refuses honestly when it cannot (no_weapon = nothing to shoot with, "
                + "item_missing = nothing to fire). The shot is a REAL DRAW: the body aims, holds the "
                + "bow to full draw (20 ticks — a tap fires a limp arrow), and vanilla looses it on "
                + "release, so power, enchantments and Infinity all behave. The call returns "
                + "{started:true, action_id, eta_ticks} and completes with action_completed {power, "
                + "draw_ticks, arrow_id, speed} — or pass `wait`:true to have THIS CALL return it. "
                + "Whether the arrow LANDS arrives later as a shot_landed {hit, damage} event. "
                + "A CROSSBOW is fired the same way and can be carried already loaded (bot_body "
                + "action:\"load\"), in which case the bolt leaves instantly — draw_ticks 0. "
                + "A TRIDENT is thrown when it is the only thing carried that flies: it LEAVES THE "
                + "HAND, so where it comes to rest is reported as trident_landed {x, y, z} and the "
                + "body walks back for it once it has nothing else to do (Loyalty returns it by "
                + "itself — trident_returned). Pass allow_throw:false to keep it. Fails: "
                + "no_target, no_weapon, item_missing, throw_not_allowed, occluded (a block is in "
                + "the way), busy, target_lost, facing_timeout.",
            Schemas.objectOpt(Schemas.object(
                "target", Schemas.integer("Entity id to shoot (from get_entities/sense_entities)."),
                "nearest", Schemas.bool("Shoot the nearest hostile within range instead of `target`."),
                "item", Schemas.str("Ammunition item id to prefer (e.g. a tipped arrow). Default: "
                    + "whatever the weapon can fire."),
                "draw_ticks", Schemas.integer("Hold the draw this long before releasing (default: "
                    + "full draw). Lower is faster and weaker — vanilla's own power curve."),
                "allow_throw", Schemas.bool("Default true. False keeps a carried trident in the "
                    + "hand rather than throwing it — a throw spends the weapon, and whether this "
                    + "target is worth it is the caller's call."),
                "wait", Schemas.bool("If true, the call returns only when the shot fires or fails.")),
                "target", "nearest", "item", "draw_ticks", "allow_throw", "wait"),
            ExecutionContext.SERVER,
            Mechanism.EMBODIED,
            (ctx, a) -> {
                DroneTools.Slot slot = DroneTools.slotFor(ctx.sessionId());
                CompletableFuture<JsonElement> waiter =
                    DroneTools.wantsWait(a) ? new CompletableFuture<>() : null;
                JsonObject r = botShoot(a, slot, waiter);
                if (waiter != null && r.has("started") && r.get("started").getAsBoolean()) {
                    return waiter;
                }
                return CompletableFuture.completedFuture(r);
            }).withTimeout(15));

        McpTools.register(ToolDef.async(
            "bot_eat",
            "EAT food from the body's inventory and apply its effects — e.g. a golden apple grants "
                + "Regeneration + Absorption. Without `item`: the HELD item if it is food, else the "
                + "most nourishing PLAIN food carried (reported as `chose`). Foods with side effects "
                + "— golden apples, chorus fruit, rotten flesh, pufferfish — are never picked for "
                + "you; name them. Consumes one; reports effects and any immediate heal. Fails with "
                + "not_food, no_food, empty_hand or item_missing. (Hunger applies only to players, "
                + "so on the drone the value is the food's status effects.)",
            Schemas.objectOpt(Schemas.object(
                "item", Schemas.str("Food item id to eat, e.g. minecraft:golden_apple. Defaults to the held item when that is food, else the best plain food carried.")),
                "item"),
            ExecutionContext.SERVER,
            Mechanism.EMBODIED,
            (ctx, a) -> {
                CompletableFuture<JsonElement> waiter = new CompletableFuture<>();
                JsonObject r = botConsume(a, DroneTools.slotFor(ctx.sessionId()), false, waiter);
                if (r.has("started") && r.get("started").getAsBoolean()) {
                    return waiter;
                }
                return CompletableFuture.completedFuture(r);
            }).withTimeout(30));

        McpTools.register(ToolDef.async(
            "bot_drink",
            "Have the drone DRINK a potion from its inventory (the held item unless `item` names one) and "
                + "apply its effects to the body — e.g. a Healing potion heals, Regeneration/Strength buff. "
                + "Consumes one (leaving a glass bottle); reports the effects now on the body and any heal. "
                + "Fails with empty_hand, item_missing, or not_a_potion (the item carries no potion effects).",
            Schemas.objectOpt(Schemas.object(
                "item", Schemas.str("Potion item id to drink, e.g. minecraft:potion. Defaults to the held item.")),
                "item"),
            ExecutionContext.SERVER,
            Mechanism.EMBODIED,
            (ctx, a) -> {
                CompletableFuture<JsonElement> waiter = new CompletableFuture<>();
                JsonObject r = botConsume(a, DroneTools.slotFor(ctx.sessionId()), true, waiter);
                if (r.has("started") && r.get("started").getAsBoolean()) {
                    return waiter;
                }
                return CompletableFuture.completedFuture(r);
            }).withTimeout(30));

        McpTools.register(ToolDef.of(
            "bot_equip",
            "Equip the drone from its inventory: move items into the armor and hand slots. Each of "
                + "`head`/`chest`/`legs`/`feet`/`mainhand`/`offhand` is an item id to equip (must be in "
                + "inventory; a swapped-out item returns to inventory), or null to unequip. Armor raises "
                + "the body's armor value (damage reduction); a shield in `offhand` enables the shield "
                + "reflex response. Returns what got equipped, any item_missing slots, and the resulting "
                + "armor value. A PLAYER body refuses `mainhand`: its main hand IS the selected hotbar "
                + "slot, and the body already arms itself for each act — digs reach for the best "
                + "harvesting tool, swings and shots for the best weapon carried. Name `item` on the "
                + "act itself to override that choice.",
            Schemas.objectOpt(Schemas.object(
                "head", Schemas.str("Helmet item id (or null to unequip)."),
                "chest", Schemas.str("Chestplate item id."),
                "legs", Schemas.str("Leggings item id."),
                "feet", Schemas.str("Boots item id."),
                "mainhand", Schemas.str("Main-hand item id (weapon)."),
                "offhand", Schemas.str("Off-hand item id (e.g. minecraft:shield).")),
                "head", "chest", "legs", "feet", "mainhand", "offhand"),
            ExecutionContext.SERVER,
            Mechanism.EMBODIED,
            (ctx, a) -> botEquip(a, DroneTools.slotFor(ctx.sessionId()))));

        McpTools.register(ToolDef.of(
            "bot_select",
            "Choose the drone's held slot — the default item for bot_place/bot_use/bot_attack. Give a `slot` "
                + "index or an `item` id to hold the first slot containing it. Returns the now-held slot.",
            Schemas.objectOpt(Schemas.object(
                "slot", Schemas.integer("Slot index to hold (0-based)."),
                "item", Schemas.str("Hold the first slot containing this item id.")),
                "slot", "item"),
            ExecutionContext.SERVER,
            Mechanism.EMBODIED,
            (ctx, a) -> botSelect(a, DroneTools.slotFor(ctx.sessionId()))));

        McpTools.register(ToolDef.of(
            "bot_give",
            "Put items into the drone's inventory out of nothing — a creative/dev convenience for seeding the "
                + "body so bot_place/bot_use have something to work with (privileged: this materializes items, "
                + "so it is audited). `item` is an item id, `count` defaults to 1. Overflow that doesn't fit "
                + "spills at the drone. Returns how many were added.",
            Schemas.objectOpt(Schemas.object(
                "item", Schemas.str("Item id to give, e.g. minecraft:oak_planks."),
                "count", Schemas.integer("How many (default 1).")),
                "count"),
            ExecutionContext.SERVER,
            Mechanism.PRIVILEGED,
            (ctx, a) -> botGive(a, DroneTools.slotFor(ctx.sessionId()))));
    }

    // ---- bot_mine (async) ----------------------------------------------------

    /**
     * Start a dig. Shared by the {@code bot_mine} handler and queue {@code mine} steps; {@code waiter},
     * when given, completes with the dig's final outcome.
     */
    static JsonObject startMine(final JsonObject a, final DroneTools.Slot slot,
                                final @Nullable CompletableFuture<JsonElement> waiter) {
        Actuator act = Actuator.require(slot);
        Hands hands = act.hands();
        ServerLevel level = act.level();
        BlockPos at = parsePos(a, "at");

        JsonObject r = new JsonObject();
        BlockState st = level.getBlockState(at);
        if (st.isAir()) {
            return started(r, false, "nothing_to_mine");
        }
        // A FLUID IS NOT A DIGGABLE BLOCK, and the engine's arithmetic says so in the most expensive
        // possible way. Water and lava carry strength(100.0F) and no tool is ever "correct" for
        // them, so getDestroyProgress yields 1/100/100 = 0.0001 per tick — 10 000 ticks, 8m20s —
        // and the hands are held for every one of them while `slot.dig` answers `busy` to every
        // other dig in the world. Water's loot table is empty, so the reward is nothing; a source
        // block refills from its neighbours, so the act is not even observable. Session w2-56123
        // lost minutes here twice, then wrote a fabricated repair recipe into persistent memory
        // because nothing on this surface would say why. Waterlogged solids are unaffected: they
        // have a real collision shape and remain perfectly diggable.
        if (!st.getFluidState().isEmpty() && st.getCollisionShape(level, at).isEmpty()) {
            note(r, "that cell is " + blockId(st) + " — a fluid, not a block you can break. Hands "
                + "make 0.0001 progress per tick on it (8+ minutes for nothing, blocking every "
                + "other dig meanwhile). Displace it with bot_place, or pick it up with a bucket "
                + "via bot_use");
            return started(r, false, "fluid_target");
        }
        float hardness = st.getDestroySpeed(level, at);
        if (hardness < 0) {
            return started(r, false, "unbreakable");
        }
        if (!act.inBlockReach(Vec3.atCenterOf(at))) {
            note(r, REACH_REMEDY);
            return started(r, false, "out_of_reach");
        }
        // F2 (V3_PLAN.md §2): the OCCLUDED-DIG gate on the raw path. Reach alone let bot_mine dig a
        // fully-hidden block through an intact wall (audited live) — a player cannot break what no
        // sightline touches. Same 4-ray touch the goal loop's canActNow already trusts; self/feet
        // cells trivially touch (an eye inside or above its own column always has a clear ray), and
        // passage/tunnel digs are adjacent-face by construction, so honest digs pass untouched.
        com.mattmc.mcptoolkit.ReachSolver.Touch touch =
            com.mattmc.mcptoolkit.ReachSolver.touch(level, act.eye(), at);
        if (touch.los() == null) {
            // A null los() has TWO causes, and only one of them is unreadable chunks: touch()
            // answers Touch(false, null) for an eye past HAND_REACH before it casts any ray
            // (ReachSolver:143). Discriminate on inRange() rather than trust that the reach gate
            // above already caught it — that gate measures Actuator.BLOCK_REACH (4.5) and this one
            // ReachSolver.HAND_REACH (4.5), two INDEPENDENT constants that happen to agree today.
            // If they ever drift apart, the honest answer is still out_of_reach; without this
            // branch the note would tell the agent to blame chunk loading for a body that is
            // simply standing too far away, and it would retry from the same spot forever.
            if (!touch.inRange()) {
                note(r, REACH_REMEDY);
                return started(r, false, "out_of_reach");
            }
            note(r, "cannot verify a sightline to that block — chunks between the eye and the "
                + "target are unreadable. Move closer and retry");
            return started(r, false, "unreadable");
        }
        if (!touch.ok()) {
            note(r, "no line of sight from the eye to any face of " + blockId(st) + " — it is "
                + "hidden behind other blocks, and hands cannot break what they cannot see. "
                + "Reposition to an exposed face (bot_goto {reach:{x,y,z}}), or use bot_target "
                + "{action:\"destroy\", may_modify:\"break\"} which walks to a seeing stand and "
                + "digs the occluders for you");
            return started(r, false, "occluded");
        }
        if (slot.dig != null) {
            // NAME THE LOCK-HOLDER. "busy" with no subject is unactionable — it says a dig exists
            // without saying which, where, or for how much longer, so the only move left is to
            // guess. Nine of these in w2-56123 produced a confabulated fix ("re-select the held
            // item clears it") that is false on every code path.
            Dig held = slot.dig;
            JsonObject holder = new JsonObject();
            holder.addProperty("action_id", held.actionId);
            addPos(holder, "at", held.pos);
            holder.addProperty("block", blockId(held.expected));
            holder.addProperty("eta_ticks", held.remaining);
            holder.addProperty("started_ticks_ago",
                Math.max(0, level.getGameTime() - held.startedTick));
            r.add("holder", holder);
            note(r, "a dig on " + blockId(held.expected) + " at " + held.pos.getX() + ","
                + held.pos.getY() + "," + held.pos.getZ() + " owns the hands for another "
                + (held.remaining / 20) + "s — wait for its action_completed, or abandon it with "
                + "bot_mine {action:\"cancel\"}");
            return started(r, false, "busy");
        }

        ItemStack tool;
        if (a.has("item") && !a.get("item").isJsonNull()) {
            String wanted = a.get("item").getAsString();
            int toolSlot = findItemSlot(hands.container(), wanted);
            if (toolSlot < 0) {
                // Refuse rather than silently digging bare-handed with the wrong drops.
                note(r, "no '" + wanted + "' in the body's inventory — check "
                    + "bot_status {inventory:true} first");
                return started(r, false, "item_missing");
            }
            // The player's dig formula reads what it HOLDS (you dig with the tool in your hand),
            // so a named tool is selected into the hand; the drone's house rule ignores the tool
            // for timing and only records it for drops, so its held slot stays untouched.
            if (hands.handsPlayer() != null) {
                selectIntoHand(hands, toolSlot);
                tool = hands.selectedStack();
            } else {
                tool = hands.container().getItem(toolSlot);
            }
        } else {
            tool = hands.selectedStack();
        }
        // THE WRONG TOOL IS A DECISION NOW, NOT A FOOTNOTE (live 2026-08-07): a survival session
        // mined 16 iron ore holding wood and bare hands. It was warned every single time —
        // drops_expected:false on the start, act_warning on the stream, "NOT harvested" on the
        // completion — and kept going, because a warning beside a success reads as noise while the
        // ore vanishes for nothing. So on the PLAYER body (the survival profile's hands, where
        // drops are livelihood) a drop-gated block now behaves the way a player does: reach into
        // the pack for the right tool yourself, and refuse to waste the block when there is none.
        // The drone keeps warn-only — it digs to clear, not to harvest, and its house-rule timing
        // never read the tool anyway.
        boolean explicitTool = a.has("item") && !a.get("item").isJsonNull();
        boolean acceptNoDrops = a.has("accept_no_drops") && !a.get("accept_no_drops").isJsonNull()
            && a.get("accept_no_drops").getAsBoolean();
        if (hands.handsPlayer() != null && !explicitTool) {
            // THE HAND REACHES FOR THE BEST TOOL, not merely a correct one (live 2026-08-07, round
            // two): the first cut of this gate only switched when the held tool would LOSE THE
            // DROPS, so a survival body walked a whole mining descent digging stone with a wooden
            // pickaxe while the stone pickaxe it had just crafted sat in slot 7 — tier-correct,
            // twice as slow, and exactly what the tool-blind warnings used to permit. A player's
            // hand goes to the fastest tool that still harvests; now so does this one. Correctness
            // still trumps speed (a gated block only considers correct-tier candidates), and a
            // pure speed switch carries no note — it is self-evident in the completion's `tool`
            // and must not become act_warning chatter on every dirt/stone boundary.
            boolean gated = st.requiresCorrectToolForDrops();
            int best = bestDigToolSlot(hands.container(), st, gated);
            if (best >= 0) {
                ItemStack cand = hands.container().getItem(best);
                boolean heldWrong = gated && !tool.isCorrectToolForDrops(st);
                if (heldWrong) {
                    ItemStack was = tool;
                    selectIntoHand(hands, best);
                    tool = hands.selectedStack();
                    r.addProperty("tool_switched", true);
                    note(r, "switched to " + itemId(tool.getItem()) + " — "
                        + (was.isEmpty() ? "bare hands" : itemId(was.getItem()))
                        + " would break " + blockId(st) + " and collect NOTHING");
                } else if (cand.getDestroySpeed(st) > tool.getDestroySpeed(st) * 1.05F) {
                    selectIntoHand(hands, best);
                    tool = hands.selectedStack();
                    r.addProperty("tool_switched", true);
                }
            }
        }
        if (hands.handsPlayer() != null && st.requiresCorrectToolForDrops()
                && !tool.isCorrectToolForDrops(st) && !acceptNoDrops) {
            // Still wrong after the auto-reach: either the caller NAMED a wrong tool, or the pack
            // has no correct one. The dig is refused — the block is worth more than the swing.
            int right = correctToolSlot(hands.container(), st);
            if (explicitTool && right >= 0) {
                note(r, itemId(tool.getItem()) + " cannot harvest " + blockId(st)
                    + " — this block only drops for a correct-tier tool, and you carry "
                    + itemId(hands.container().getItem(right).getItem())
                    + ": pass that as `item`, or omit `item` to auto-switch");
            } else {
                note(r, (tool.isEmpty() ? "bare hands" : itemId(tool.getItem()))
                    + " cannot harvest " + blockId(st) + " — this block only drops for a "
                    + "correct-tier tool and the pack has none. Craft or fetch one first; "
                    + "accept_no_drops:true breaks it anyway and collects NOTHING");
            }
            return started(r, false, "wrong_tool");
        }
        int ticks = hands.digTicks(level, st, at);
        if (ticks == Integer.MAX_VALUE) {
            // These hands cannot make progress on this block at all (the engine's own verdict). A
            // dig that can never finish must not start — it would sit "in progress" forever and the
            // slot's `busy` would block every later dig.
            note(r, "these hands make no progress on this block even with the best tool in the "
                + "pack — carry one that can break it, or mine something else");
            return started(r, false, "cannot_break");
        }
        String actionId = "m-" + (++actionSeq);
        slot.dig = new Dig(actionId, hands, at, st, tool.copy(), ticks, waiter);
        slot.dig.startedTick = level.getGameTime();
        // The dig is player-visible from tick one: beam/swing on the block + crack overlay stage 0.
        hands.digVisual(at, ticks);
        level.destroyBlockProgress(hands.handsBody().getId(), at, 0);
        // The body TURNS to its work and keeps its gaze there through the dig (and the drop
        // settle) — a watcher must see what the hands are doing, and a first-person camera must
        // have the block in frame. Held, not one-shot: the body may drift mid-dig. Combat aim and
        // a live nav leg veto it (LookDriver precedence), so aim never fights survival.
        LookDriver.holdOn(slot, hands.handsBody(), Vec3.atCenterOf(at), 25f, "dig");

        r.addProperty("started", true);
        r.addProperty("action_id", actionId);
        r.addProperty("block", blockId(st));
        r.addProperty("eta_ticks", ticks);
        // Echo what the hands actually wield, and announce a drop-less dig up front — today a
        // wrong-tier dig "succeeds" with collected:0 and the agent must infer why from silence.
        r.addProperty("tool", tool.isEmpty() ? null : itemId(tool.getItem()));
        describeTool(r, tool, st, level, at);
        if (ticks > SLOW_DIG_TICKS) {
            note(r, "this dig takes about " + (ticks / 20) + " seconds and blocks EVERY other dig "
                + "until it finishes — cancel it with bot_mine {action:\"cancel\"} if that is not "
                + "what you meant");
        }
        if (st.requiresCorrectToolForDrops() && !tool.isCorrectToolForDrops(st)) {
            r.addProperty("drops_expected", false);
            note(r, "this block only drops with a correct-tier tool and "
                + (tool.isEmpty() ? "bare hands are" : itemId(tool.getItem()) + " is")
                + " not one — the dig will break it but collect nothing; pass `item` with the "
                + "right tool for drops");
        }
        return r;
    }

    /**
     * Say WHICH pickaxe. {@code Block.getDrops} is handed the recorded stack, so the loot table
     * already consults its enchantments — Silk Touch flips an ore to the ore <em>block</em>, Fortune
     * multiplies the yield — yet {@code tool} echoed a bare item id, making a Silk Touch pickaxe and
     * a plain one byte-identical in every reply the agent can read. That is a quiet trap for a
     * survival body: it mines a coal vein, banks eight {@code coal_ore} items, owns no fuel, and
     * sits at a furnace it cannot light holding what it believes is coal. The class change is
     * pre-announced the way {@code drops_expected} announces a tier loss.
     */
    private static void describeTool(final JsonObject r, final ItemStack tool, final BlockState st,
                                     final ServerLevel level, final BlockPos at) {
        if (tool.isEmpty()) {
            return;
        }
        var ench = tool.getEnchantments();
        if (ench.isEmpty()) {
            return;
        }
        JsonArray names = new JsonArray();
        boolean silk = false;
        for (var e : ench.entrySet()) {
            String id = e.getKey().unwrapKey().map(k -> k.identifier().toString()).orElse("unknown");
            names.add(id + " " + e.getIntValue());
            silk |= id.endsWith("silk_touch");
        }
        r.add("tool_enchantments", names);
        if (!silk) {
            return;
        }
        // Would silk touch actually change WHAT ITEM CLASS this dig yields? Ask the loot table both
        // ways rather than hard-coding an ore list — the answer is then true for modded blocks too.
        List<ItemStack> silked = Block.getDrops(st, level, at, level.getBlockEntity(at), null, tool);
        List<ItemStack> plain = Block.getDrops(st, level, at, level.getBlockEntity(at), null,
            ItemStack.EMPTY);
        String silkedId = silked.isEmpty() ? null : itemId(silked.get(0).getItem());
        String plainId = plain.isEmpty() ? null : itemId(plain.get(0).getItem());
        if (silkedId != null && !silkedId.equals(plainId)) {
            r.addProperty("drops_as", silkedId);
            note(r, "SILK TOUCH: this yields " + silkedId + ", not " + plainId
                + " — the block itself, which is not fuel and not a recipe input. Mine with an "
                + "unenchanted tool (`item`) if you want " + plainId);
        }
    }

    /**
     * Which entity is standing in the cell — and whether it is the caller's own body. The refusal
     * used to say "possibly your own", a hedge the server never had to make: it has the entity list
     * and the shape that would be placed, so it can simply look.
     */
    private static @Nullable JsonObject blockingEntity(final ServerLevel level,
                                                       final BlockState toPlace, final BlockPos at,
                                                       final net.minecraft.world.entity.Entity self) {
        var shape = toPlace.getCollisionShape(level, at).move(at.getX(), at.getY(), at.getZ());
        if (shape.isEmpty()) {
            return null;
        }
        for (var e : level.getEntities((net.minecraft.world.entity.Entity) null, shape.bounds(),
                x -> x.blocksBuilding && !x.isRemoved())) {
            if (!net.minecraft.world.phys.shapes.Shapes.joinIsNotEmpty(shape,
                    net.minecraft.world.phys.shapes.Shapes.create(e.getBoundingBox()),
                    net.minecraft.world.phys.shapes.BooleanOp.AND)) {
                continue;
            }
            JsonObject o = new JsonObject();
            o.addProperty("type", BuiltInRegistries.ENTITY_TYPE.getKey(e.getType()).toString());
            o.addProperty("id", e.getId());
            o.addProperty("self", e == self);
            return o;
        }
        return null;
    }

    /**
     * Append a note instead of overwriting one. Several gates now have something to say about the
     * same dig (a slow eta AND a tier loss AND a silk-touch class change), and the last writer
     * silently winning is how a warning goes missing.
     */
    static void note(final JsonObject r, final String text) {
        if (r.has("note") && r.get("note").isJsonPrimitive()) {
            r.addProperty("note", r.get("note").getAsString() + " ALSO: " + text);
        } else {
            r.addProperty("note", text);
        }
    }

    /**
     * THE GOAL LOOP IS A ONE-WAY MIRROR — this is the mirror's other side.
     *
     * <p>{@code GoalRunner} and {@code QueueRunner} call {@link #startMine}/{@link #botPlace} on the
     * agent's behalf and read exactly three fields off the reply: {@code started}, {@code reason},
     * {@code action_id}. Everything else — {@code block}, {@code tool}, {@code eta_ticks},
     * {@code drops_expected}, {@code note} — is computed correctly and dropped on the floor. Since
     * most digs in a survival run are goal-driven, most warnings this toolkit produces have never
     * reached a reader: session w2-56123 mined with a SWORD for 7.5 minutes across two windows and
     * spent 8m20s on a single water source, and {@code drops_expected} appears ZERO times in its
     * 6 MB transcript. Both defects were visible in a reply nobody forwarded.
     *
     * <p>So every act a goal performs on the body's behalf now echoes anything worth reading into
     * the event stream, once, as {@code act_warning}. Silent on a clean act: this must not become
     * the chatter it exists to cut through.
     */
    static void echoAct(final DroneTools.Slot slot, final JsonObject reply, final String action,
                        final BlockPos at) {
        boolean warn = (reply.has("note") && reply.get("note").isJsonPrimitive())
            || (reply.has("drops_expected") && !reply.get("drops_expected").getAsBoolean())
            || (reply.has("eta_ticks") && reply.get("eta_ticks").getAsInt() > SLOW_DIG_TICKS);
        if (!warn) {
            return;
        }
        JsonObject d = new JsonObject();
        d.addProperty("action", action);
        d.addProperty("goal_driven", true);
        addPos(d, "at", at);
        for (String key : new String[] {"action_id", "block", "tool", "tool_enchantments",
            "tool_switched", "eta_ticks", "drops_expected", "drops_as", "note"}) {
            if (reply.has(key)) {
                d.add(key, reply.get(key));
            }
        }
        EventLog.emit("act_warning", d, slot.target());
    }

    /**
     * {@code bot_mine {action:"cancel"}} — abandon the outstanding dig. There was no way to do this
     * from the tool surface at all, which is why an eight-minute mistake stayed an eight-minute
     * mistake: {@code abort} existed but only teardown could reach it.
     */
    static JsonObject cancelDig(final DroneTools.Slot slot) {
        JsonObject r = new JsonObject();
        Dig d = slot.dig;
        if (d == null) {
            r.addProperty("ok", false);
            r.addProperty("reason", "no_dig");
            note(r, "no dig is running — nothing to cancel");
            return r;
        }
        if (d.settling != null) {
            r.addProperty("ok", false);
            r.addProperty("reason", "already_broken");
            note(r, "the block is already broken — its drops are settling into your pack; "
                + "the action_completed lands within ~2s");
            return r;
        }
        r.addProperty("ok", true);
        r.addProperty("cancelled", d.actionId);
        addPos(r, "at", d.pos);
        r.addProperty("block", blockId(d.expected));
        r.addProperty("remaining_ticks", d.remaining);
        failDig(slot, "cancelled"); // completes the waiter and fires action_failed, as any abort does
        return r;
    }

    /**
     * Advance the slot's outstanding dig one tick and complete/fail it. Called every server tick from
     * {@code DroneTools.tickWatch} with the slot's current hands-capable body (drone or player;
     * server thread, no synchronization needed). Updates the vanilla crack overlay as the dig
     * progresses.
     */
    static void tick(final DroneTools.Slot slot, final @Nullable LivingEntity handsBody) {
        Dig d = slot.dig;
        if (d == null) {
            return;
        }
        d.starvedTicks = 0; // serviced this tick — the starvation run (if any) is over
        if (d.settling != null) {
            // The block is already broken; its drops are settling into the pack. No reach or
            // block-changed checks apply any more — the world's part is done, only collection is
            // outstanding (and it finishes honestly even if the body is gone, see settleTick).
            settleTick(slot, d);
            return;
        }
        // Kind-aware failure words, matching DroneTools' removal vocabulary: the drone keeps its
        // historical drone_* reasons, the player body reports body_*.
        boolean droneHands = d.hands instanceof BotBodyEntity;
        if (handsBody == null) {
            failDig(slot, droneHands ? "drone_removed" : "body_removed");
            return;
        }
        if (handsBody != d.hands.handsBody()) {
            failDig(slot, droneHands ? "drone_replaced" : "body_replaced");
            return;
        }
        LivingEntity body = d.hands.handsBody();
        ServerLevel level = (ServerLevel) body.level();
        if (body.getEyePosition().distanceTo(Vec3.atCenterOf(d.pos)) > Actuator.BLOCK_REACH) {
            failDig(slot, "out_of_reach"); // the body moved out of reach mid-dig
            return;
        }
        BlockState now = level.getBlockState(d.pos);
        if (now.getBlock() != d.expected.getBlock()) {
            failDig(slot, "block_changed");
            return;
        }
        // The attack button (world-model DESIGN.md §9 Phase 3): every serviced dig tick is
        // attack-HELD — exactly the input a vanilla client emits while its player mines.
        com.mattmc.mcptoolkit.wm.Wm.actionPress(body, false, true, -1);
        if (--d.remaining > 0) {
            int stage = (int) (9.0 * (d.total - d.remaining) / d.total);
            if (stage != d.lastStage) {
                d.lastStage = stage;
                level.destroyBlockProgress(body.getId(), d.pos, stage);
                d.hands.digVisual(d.pos, d.remaining); // refresh beam / re-swing the arm
            }
            return;
        }

        // Done: harvest drops (with the recorded tool), then break the block.
        level.destroyBlockProgress(body.getId(), d.pos, -1);
        d.hands.clearDigVisual();
        BlockEntity be = level.getBlockEntity(d.pos);
        // THE TIER GATE IS NOT IN THE LOOT TABLE. Vanilla withholds a wrong-tool block's drops in
        // exactly one place — `hasCorrectToolForDrops` gating `playerDestroy` in
        // ServerPlayerGameMode#destroyBlock — and `Block.getDrops`, the only harvest entry point a
        // non-player body has, does not run it. Coal ore's table (VanillaBlockLoot#createOreDrop) is
        // a bare silk-touch dispatch with no tool condition, so before this gate a SWORD dug coal
        // ore and got the coal. That is how session w2-56123 mined stone and ore with a sword for a
        // whole run: it was never once punished for it, its pack filled anyway, and it therefore had
        // no reason to craft a pickaxe. Worse, `startMine` already announces `drops_expected:false`
        // on such a dig — so the one honest signal the body had was falsified by the very next
        // event, which is precisely how a body learns to ignore its own instruments.
        boolean mayHarvest = !now.requiresCorrectToolForDrops() || d.tool.isCorrectToolForDrops(now);
        List<ItemStack> drops = mayHarvest
            ? Block.getDrops(now, level, d.pos, be, body, d.tool)
            : List.of();
        level.destroyBlock(d.pos, false);

        // PLAYER HANDS: drops become REAL item entities — they pop from the block and the body's
        // own vanilla pickup sweep (Player.aiStep, running because FakePlayerEntity pumps doTick)
        // vacuums them. The act stays open through a short settle so the completion event fires
        // when the inventory actually changed; counts come from a before/after delta, never from
        // an assumed insert. The drone keeps the instant path below: it has no pickup sweep, and
        // it is not the body the camera follows.
        if (d.hands.handsPlayer() != null && !drops.isEmpty()) {
            d.minedAs = now;
            d.invBefore = new HashMap<>();
            d.spawned = new HashMap<>();
            d.settling = new ArrayList<>();
            for (ItemStack drop : drops) {
                if (drop.isEmpty()) {
                    continue;
                }
                d.spawned.merge(itemId(drop.getItem()), drop.getCount(), Integer::sum);
            }
            for (String id : d.spawned.keySet()) {
                d.invBefore.put(id, countInContainer(d.hands.container(), id));
            }
            Vec3 center = Vec3.atCenterOf(d.pos);
            Vec3 toward = body.position().subtract(center);
            Vec3 bias = toward.horizontalDistanceSqr() > 0.01
                ? new Vec3(toward.x, 0, toward.z).normalize().scale(0.12) : Vec3.ZERO;
            for (ItemStack drop : drops) {
                if (drop.isEmpty()) {
                    continue;
                }
                net.minecraft.world.entity.item.ItemEntity ie =
                    new net.minecraft.world.entity.item.ItemEntity(
                        level, center.x, center.y, center.z, drop.copy());
                ie.setPickUpDelay(2); // visible pop, then the sweep may take it
                ie.setDeltaMovement(bias.x + (level.getRandom().nextDouble() - 0.5) * 0.06, 0.2,
                    bias.z + (level.getRandom().nextDouble() - 0.5) * 0.06);
                level.addFreshEntity(ie);
                d.settling.add(ie);
            }
            return; // completion (event, waiter, queue/goal hand-off) fires at settle end
        }

        slot.dig = null;
        LookDriver.clear(slot, "dig");
        JsonArray dropsArr = new JsonArray();
        JsonArray spilledArr = new JsonArray();
        int collected = 0;
        for (ItemStack drop : drops) {
            // An EMPTY stack is not a drop. A wrong-tier dig can put one in the list, and reporting
            // it as `{item: "minecraft:air", count: 1, collected: 1}` — which the live probe caught
            // — claims the body picked something up when its inventory did not change. The
            // succeeds-falsely rule (ARCHITECTURE, "Act verdicts are verified") forbids exactly that.
            if (drop.isEmpty()) {
                continue;
            }
            // READ THE STACK BEFORE INSERTING IT. The player body's hands are a vanilla
            // `Inventory`, and `Inventory.add` MUTATES the stack it is given down to the remainder —
            // so a fully-collected drop comes back EMPTY, and asking it for its item afterwards
            // answers `minecraft:air`. The drone never showed this (`SimpleContainer.addItem` copies
            // first), which is why every probe was green while live play reported
            // `{item: "minecraft:air", count: 1, collected: 1}` on all 66 digs of session w1-85918 —
            // the exact falsehood the comment above forbids, from the line that names the item.
            // The agent mined ~48 cobblestone, was told it collected air, and never crafted the
            // stone pickaxe (or the pillar blocks) that its own inventory could already pay for.
            String dropId = itemId(drop.getItem());
            int total = drop.getCount();
            ItemStack leftover = d.hands.insert(drop);
            int got = total - leftover.getCount();
            collected += got;
            if (!leftover.isEmpty()) {
                Block.popResource(level, d.pos, leftover);
                JsonObject s = new JsonObject();
                s.addProperty("item", itemId(leftover.getItem()));
                s.addProperty("count", leftover.getCount());
                spilledArr.add(s);
            }
            JsonObject o = new JsonObject();
            o.addProperty("item", dropId);
            o.addProperty("count", total);
            o.addProperty("collected", got);
            dropsArr.add(o);
        }

        JsonObject data = new JsonObject();
        data.addProperty("action_id", d.actionId);
        data.addProperty("action", "bot_mine");
        data.addProperty("mined", blockId(now));
        data.addProperty("tool", d.tool.isEmpty() ? null : itemId(d.tool.getItem()));
        addPos(data, "pos", d.pos);
        data.addProperty("collected", collected);
        data.add("drops", dropsArr);
        // The completion must AGREE with the start's prediction. An empty `drops` array is otherwise
        // indistinguishable from a block that simply has no drops, and silence is what the body has
        // to guess against; say the tier out loud at the moment the loss happens.
        if (!mayHarvest) {
            data.addProperty("drops_expected", false);
            data.addProperty("note", "broken but NOT harvested — " + blockId(now) + " only drops for "
                + "a correct-tier tool and you swung "
                + (d.tool.isEmpty() ? "bare hands" : itemId(d.tool.getItem()))
                + ". The block is gone and you got nothing. Get the right tool before mining more "
                + "of this");
        }
        if (!spilledArr.isEmpty()) {
            data.add("spilled", spilledArr);
        }
        DroneTools.stampEnvelope(data, body); // embodied verdicts are datable (SURVIVAL_MODE_PLAN §4)
        EventLog.emit("action_completed", data, slot.target());
        // A full pack is a SUCCESS event carrying a loss, which is precisely how it gets missed: the
        // dig said action_completed, and `collected:0` against `count:6` sat inside a drops array
        // nobody re-read. Mining a vein you cannot carry and walking away is a survival failure with
        // no other witness, so it gets its own subscribable type.
        if (!spilledArr.isEmpty()) {
            JsonObject full = new JsonObject();
            full.addProperty("action", "bot_mine");
            addPos(full, "at", d.pos);
            full.add("spilled", spilledArr.deepCopy());
            full.addProperty("note", "your pack is full — these dropped on the ground at the dig "
                + "site and will despawn in ~5 minutes. Drop or store something, then re-collect");
            EventLog.emit("inventory_full", full, slot.target());
        }
        if (d.waiter != null) {
            d.waiter.complete(data.deepCopy());
        }
        QueueRunner.onActionDone(slot, d.actionId, data);
        GoalRunner.onActionDone(slot, d.actionId, data);
    }

    /**
     * One settle tick: prune what the body's own pickup sweep already vacuumed, magnet-assist the
     * stragglers after {@link #SETTLE_MAGNET_TICKS}, and finish — honestly, from the inventory
     * delta — when everything is collected, the cap lapses, or the body is gone.
     */
    private static void settleTick(final DroneTools.Slot slot, final Dig d) {
        d.settleTicks++;
        LivingEntity body = d.hands.handsBody();
        boolean bodyLive = !body.isRemoved() && body.isAlive();
        List<net.minecraft.world.entity.item.ItemEntity> alive = new ArrayList<>();
        for (net.minecraft.world.entity.item.ItemEntity ie : d.settling) {
            if (!ie.isRemoved() && !ie.getItem().isEmpty()) {
                alive.add(ie);
            }
        }
        d.settling = alive;
        if (bodyLive && d.settleTicks >= SETTLE_MAGNET_TICKS) {
            // The familiar item-attraction read: stragglers drift to the body instead of the act
            // hanging on a drop that bounced behind a ledge. A magnet, never a teleport.
            for (net.minecraft.world.entity.item.ItemEntity ie : alive) {
                ie.setPickUpDelay(0);
                Vec3 to = body.position().add(0, 0.9, 0).subtract(ie.position());
                double dist = to.length();
                if (dist > 0.05) {
                    ie.setDeltaMovement(to.normalize().scale(Math.min(0.3, 0.12 + dist * 0.05)));
                }
            }
        }
        if (!alive.isEmpty() && bodyLive && d.settleTicks < SETTLE_MAX_TICKS) {
            return;
        }
        finishSettle(slot, d, alive, bodyLive);
    }

    /** Emit the dig's completion from what ACTUALLY happened: per-item inventory delta (clamped to
     *  what was spawned — a stray same-item entity must not inflate the count), leftovers reported
     *  as spilled on the ground. The event shape is byte-compatible with the instant path. */
    private static void finishSettle(final DroneTools.Slot slot, final Dig d,
                                     final List<net.minecraft.world.entity.item.ItemEntity> leftovers,
                                     final boolean bodyLive) {
        slot.dig = null;
        LookDriver.clear(slot, "dig");
        JsonArray dropsArr = new JsonArray();
        JsonArray spilledArr = new JsonArray();
        int collected = 0;
        for (Map.Entry<String, Integer> e : d.spawned.entrySet()) {
            int before = d.invBefore.getOrDefault(e.getKey(), 0);
            int nowCount = countInContainer(d.hands.container(), e.getKey());
            int got = Math.max(0, Math.min(nowCount - before, e.getValue()));
            collected += got;
            JsonObject o = new JsonObject();
            o.addProperty("item", e.getKey());
            o.addProperty("count", e.getValue());
            o.addProperty("collected", got);
            dropsArr.add(o);
        }
        for (net.minecraft.world.entity.item.ItemEntity ie : leftovers) {
            JsonObject s = new JsonObject();
            s.addProperty("item", itemId(ie.getItem().getItem()));
            s.addProperty("count", ie.getItem().getCount());
            spilledArr.add(s);
        }

        JsonObject data = new JsonObject();
        data.addProperty("action_id", d.actionId);
        data.addProperty("action", "bot_mine");
        data.addProperty("mined", blockId(d.minedAs != null ? d.minedAs : d.expected));
        data.addProperty("tool", d.tool.isEmpty() ? null : itemId(d.tool.getItem()));
        addPos(data, "pos", d.pos);
        data.addProperty("collected", collected);
        data.add("drops", dropsArr);
        if (!spilledArr.isEmpty()) {
            data.add("spilled", spilledArr);
        }
        if (!bodyLive) {
            data.addProperty("note", "the body was lost while its drops settled — `collected` is "
                + "what actually reached the pack; the rest is on the ground at the dig site");
        }
        // Did this dig just undo something the body placed on purpose? See notePlacement. Skipped
        // when the body is gone: the tick source is the body's own level, and a warning aimed at a
        // corpse helps nobody.
        LivingEntity digBody = bodyLive ? d.hands.handsBody() : null;
        if (digBody != null) {
            long nowTick = digBody.level().getGameTime();
            Placement undone = takePlacement(slot, d.pos, nowTick);
            if (undone != null) {
                long agoTicks = nowTick - undone.tick();
                JsonObject w = new JsonObject();
                w.addProperty("action", "bot_mine");
                w.addProperty("action_id", d.actionId);
                addPos(w, "at", d.pos);
                w.addProperty("undid_own_placement", undone.block());
                w.addProperty("placed_ticks_ago", agoTicks);
                w.addProperty("note", "you MINED THE " + undone.block() + " YOU PLACED "
                    + (agoTicks / 20) + "s AGO at " + d.pos.getX() + "," + d.pos.getY() + ","
                    + d.pos.getZ() + " — an outstanding goal (bot_tunnel/bot_target) digs its whole "
                    + "line and does not know that cell was yours. If you placed a crafting table or "
                    + "a torch and it has vanished, this is why: cancel or finish the goal first, or "
                    + "place clear of its path, then place again");
                EventLog.emit("act_warning", w, slot.target());
            }
        }
        DroneTools.stampEnvelope(data, d.hands.handsBody());
        EventLog.emit("action_completed", data, slot.target());
        if (!spilledArr.isEmpty()) {
            JsonObject full = new JsonObject();
            full.addProperty("action", "bot_mine");
            addPos(full, "at", d.pos);
            full.add("spilled", spilledArr.deepCopy());
            full.addProperty("note", "these drops did not reach your pack — they are on the ground "
                + "at the dig site and will despawn in ~5 minutes. Make room (or go back), then "
                + "re-collect");
            EventLog.emit("inventory_full", full, slot.target());
        }
        if (d.waiter != null) {
            d.waiter.complete(data.deepCopy());
        }
        QueueRunner.onActionDone(slot, d.actionId, data);
        GoalRunner.onActionDone(slot, d.actionId, data);
    }

    /** Total count of {@code id} across a container — the settle phase's before/after probe. */
    private static int countInContainer(final net.minecraft.world.Container c, final String id) {
        int n = 0;
        for (int i = 0; i < c.getContainerSize(); i++) {
            ItemStack s = c.getItem(i);
            if (!s.isEmpty() && itemId(s.getItem()).equals(id)) {
                n += s.getCount();
            }
        }
        return n;
    }

    /**
     * One tick in which the dig was NOT serviced because a reaction or a fight owned the body.
     * Called from {@code DroneTools.tickWatch}'s else-branch — the branch that used to do nothing at
     * all, which is how a dig could sit frozen for minutes while its owner reported nothing.
     */
    static void starvedTick(final DroneTools.Slot slot, final String by) {
        Dig d = slot.dig;
        if (d == null) {
            return;
        }
        d.starvedTicks++;
        if (d.starvedTicks >= DIG_STARVED_ABORT_TICKS) {
            // Concede. A dig held hostage for 30 seconds is not going to finish, and the honest
            // failure is worth more than an indefinite `busy` nobody can explain.
            failDig(slot, "dig_starved");
            return;
        }
        if (d.starvedTicks == DIG_STARVED_TICKS && !d.starvedAnnounced) {
            d.starvedAnnounced = true;
            JsonObject data = new JsonObject();
            data.addProperty("action_id", d.actionId);
            data.addProperty("by", by);
            data.addProperty("starved_ticks", d.starvedTicks);
            addPos(data, "at", d.pos);
            data.addProperty("block", blockId(d.expected));
            data.addProperty("note", "your dig is FROZEN — " + by + " owns the body and the dig "
                + "cannot advance while it does. Deal with its trigger (or disarm the reaction), or "
                + "cancel the dig with bot_mine {action:\"cancel\"}; it will fail on its own in "
                + ((DIG_STARVED_ABORT_TICKS - DIG_STARVED_TICKS) / 20) + "s");
            EventLog.emit("dig_starved", data, slot.target());
        }
    }

    /**
     * Abort the slot's outstanding dig with a reason (called by {@code DroneTools} when the drone is
     * despawned or replaced, so the failure event fires immediately instead of on the next tick).
     */
    static void abort(final DroneTools.Slot slot, final String reason) {
        if (slot.dig != null) {
            failDig(slot, reason);
        }
        if (slot.swing != null) {
            failSwing(slot, reason);
        }
        if (slot.use != null) {
            PlayerVerbs.failUse(slot, reason);
        }
    }

    private static void failDig(final DroneTools.Slot slot, final String reason) {
        Dig d = slot.dig;
        if (d == null) {
            return;
        }
        if (d.settling != null) {
            // The block is ALREADY broken — a cancel/despawn/starve arriving mid-settle cannot
            // un-mine it, so an action_failed here would lie. Resolve as an honest completion of
            // what actually happened; anything uncollected is reported spilled.
            finishSettle(slot, d, d.settling, !d.hands.handsBody().isRemoved()
                && d.hands.handsBody().isAlive());
            return;
        }
        slot.dig = null;
        LookDriver.clear(slot, "dig");
        LivingEntity body = d.hands.handsBody();
        // The crack-overlay clear works for a removed entity too (it is just a broadcast keyed by
        // id) — gating it on isRemoved left the overlay stuck ~20s when a drone died mid-dig.
        ((ServerLevel) body.level()).destroyBlockProgress(body.getId(), d.pos, -1);
        if (!body.isRemoved()) {
            d.hands.clearDigVisual();
        }
        JsonObject data = new JsonObject();
        data.addProperty("action_id", d.actionId);
        data.addProperty("action", "bot_mine");
        data.addProperty("reason", reason);
        EventLog.emit("action_failed", data, slot.target());
        if (d.waiter != null) {
            d.waiter.complete(data.deepCopy());
        }
        QueueRunner.onActionFailed(slot, d.actionId, reason);
        GoalRunner.onActionFailed(slot, d.actionId, reason);
    }

    // ---- bot_place (sync) ----------------------------------------------------

    static JsonObject botPlace(final JsonObject a, final DroneTools.Slot slot) {
        Actuator act = Actuator.require(slot);
        Hands hands = act.hands();
        ServerLevel level = act.level();
        BlockPos at = parsePos(a, "at");

        ItemStack stack = resolveStack(act, a);
        JsonObject r = new JsonObject();
        if (stack.isEmpty()) {
            // The docs' two distinct words, kept distinct: a NAMED item that isn't carried is
            // item_missing (remedy: acquire it); a bare empty hand is empty_hand (remedy: select).
            return fail(r, namedItem(a) ? "item_missing" : "empty_hand");
        }
        if (!(stack.getItem() instanceof BlockItem blockItem)) {
            // Say what the refusal is ABOUT. This used to be `not_placeable`, which reads as a fact
            // about the terrain — w2-79881's goal loop surfaced it while the body held a pickaxe,
            // and the agent spent turns treating a wrong-held-item as an impossible cell.
            return fail(r, "held_item_not_a_block");
        }
        if (!act.inBlockReach(Vec3.atCenterOf(at))) {
            r.addProperty("note", REACH_REMEDY);
            return fail(r, "out_of_reach");
        }
        if (!level.getBlockState(at).canBeReplaced()) {
            // NAME THE OCCUPANT here too. A blind body underground has no other sense for what is
            // in the cell — w1_42257 spent 12 consecutive bot_place guesses on bare "obstructed"
            // while feeling for a climb column it could not see.
            String occupant = net.minecraft.core.registries.BuiltInRegistries.BLOCK
                .getKey(level.getBlockState(at).getBlock()).toString();
            r.addProperty("block", occupant);
            note(r, "the target cell already holds " + occupant
                + " — pick an air cell or mine this one first");
            return fail(r, "obstructed");
        }

        // Deterministic placement: the block's default state, or an explicit `state` the caller controls
        // (no fake-player BlockPlaceContext — that path was NPE-prone and inconsistent across items).
        final BlockState toPlace = resolvePlaceState(a, level, blockItem);
        // The item is only consumed after a CONFIRMED write: an unsupported position (torch on air —
        // it would pop right back off) or a rejected setBlock must not destroy the item and claim
        // success. UPDATE_ALL physics stays, so support checks reflect what would actually persist.
        if (!toPlace.canSurvive(level, at)) {
            return fail(r, "unsupported_position");
        }
        // Vanilla's placement obstruction gate (BlockItem.canPlace): a block may not materialize
        // where its collision shape intersects an entity — INCLUDING the placing body itself.
        // Live-caught 2026-08-02: without it the bot placed a crafting table into its own head
        // cell and took inWall suffocation damage every tick after.
        if (!level.isUnobstructed(toPlace, at,
                net.minecraft.world.phys.shapes.CollisionContext.of(act.body()))) {
            // NAME THE OCCUPANT. "possibly your own" is a question the server can answer
            // definitively, and the answer changes what the caller does next: step aside, or kill
            // the mob standing in the hole.
            JsonObject by = blockingEntity(level, toPlace, at, act.body());
            if (by != null) {
                r.add("blocked_by", by);
            }
            note(r, "an entity's body occupies this cell"
                + (by != null && by.get("self").getAsBoolean() ? " — IT IS YOURS"
                    : by != null ? " — a " + by.get("type").getAsString() : "")
                + "; placing here would entomb it. Step away or pick a free cell");
            return fail(r, "entity_in_the_way");
        }
        BlockState before = level.getBlockState(at);
        // The use button (world-model DESIGN.md §9 Phase 3): a committed placement is one use
        // press — a vanilla client places with right-click.
        com.mattmc.mcptoolkit.wm.Wm.actionPress(act.body(), true, false, -1);
        if (!level.setBlock(at, toPlace, Block.UPDATE_ALL)) {
            return fail(r, "place_rejected");
        }
        // VERIFY THE OUTCOME, not just the precondition. The gate above is vanilla's own
        // (Level.isUnobstructed → EntityGetter.isUnobstructed: an AABB intersection over every
        // blocksBuilding entity in the box) and it is the right test — but w2-56123's body reported
        // being sealed in anyway, and a check that passes cannot explain that. Worth knowing why it
        // CAN pass: vanilla's intersection is a STRICT overlap, so a 0.6-wide body at x.3 spans
        // exactly [x.0, x.6] and is flush with the neighbouring cell's face, which then reads as
        // free — legal, and also how a cell that behaves as occupied can test as empty.
        //
        // So the act confirms what it did rather than what it expected: if the body is suffocating
        // in the block it just placed, the write is reverted, the item is untouched, and the failure
        // is honest. An act may not report success while entombing its own body (ARCHITECTURE, "Act
        // verdicts are verified"). Placing a block flush UNDER the feet stays legal — that is
        // pillaring, and the harm test is suffocation, not contact.
        if (act.body().isInWall()) {
            level.setBlock(at, before, Block.UPDATE_ALL);
            note(r, "placing " + blockId(toPlace) + " there sealed your own head in, so it was "
                + "UNDONE and the item kept. Move first, then place");
            return fail(r, "would_entomb_self");
        }
        stack.shrink(1);
        hands.placeVisual(at);

        r.addProperty("ok", true);
        r.addProperty("placed", blockId(toPlace));
        addPos(r, "pos", at);
        r.addProperty("remaining", stack.getCount());
        notePlacement(slot, at, blockId(toPlace), level.getGameTime());
        emitDone(slot, "bot_place", d -> {
            d.addProperty("placed", blockId(toPlace));
            addPos(d, "pos", at);
        });
        return r;
    }

    // --- "my own goal ate what I just placed" -----------------------------------------------------
    //
    // Live, session w1-91288 (2026-08-10): the body placed a crafting table at (335,60,82), walked a
    // reach goal to it, and got `needs_crafting_table` three times running. Nothing was wrong with
    // reach (eye was 1.38 blocks away) or the station predicate — an OUTSTANDING bot_tunnel goal,
    // one the agent believed had finished because the call had been moved to the background at 120s,
    // mined the table back up 82 ticks after it went down. The refusal was accurate and unusable:
    // "place a crafting table" to an agent that just had.
    //
    // The interaction is invisible by construction — a goal's own digs are correct, individually
    // legal, and reported as ordinary action_completed rows — so the only honest fix is to say it
    // OUT LOUD at the moment it happens. Zero false positives by design: this fires when a block
    // this session placed is destroyed by this session's own dig, not when it merely might be.
    private static final int PLACEMENT_MEMORY_TICKS = 20 * 90;
    private static final int PLACEMENT_MEMORY_MAX = 32;

    private record Placement(BlockPos pos, String block, long tick) {}

    private static final java.util.Map<DroneTools.Slot, java.util.ArrayDeque<Placement>> RECENT_PLACEMENTS =
        java.util.Collections.synchronizedMap(new java.util.WeakHashMap<>());

    private static void notePlacement(final DroneTools.Slot slot, final BlockPos at,
                                      final String block, final long tick) {
        java.util.ArrayDeque<Placement> q =
            RECENT_PLACEMENTS.computeIfAbsent(slot, s -> new java.util.ArrayDeque<>());
        synchronized (q) {
            q.removeIf(p -> p.pos().equals(at) || tick - p.tick() > PLACEMENT_MEMORY_TICKS);
            q.addLast(new Placement(at.immutable(), block, tick));
            while (q.size() > PLACEMENT_MEMORY_MAX) {
                q.removeFirst();
            }
        }
    }

    /** The placement this dig just undid, or null — consumed, so the warning fires once. */
    private static @Nullable Placement takePlacement(final DroneTools.Slot slot, final BlockPos at,
                                                     final long tick) {
        java.util.ArrayDeque<Placement> q = RECENT_PLACEMENTS.get(slot);
        if (q == null) {
            return null;
        }
        synchronized (q) {
            for (java.util.Iterator<Placement> it = q.iterator(); it.hasNext();) {
                Placement p = it.next();
                if (tick - p.tick() > PLACEMENT_MEMORY_TICKS) {
                    it.remove();
                    continue;
                }
                if (p.pos().equals(at)) {
                    it.remove();
                    return p;
                }
            }
        }
        return null;
    }

    /** The state to place: an explicit `state` string (its block must match the item) or the default state. */
    private static BlockState resolvePlaceState(final JsonObject a, final ServerLevel level,
                                                final BlockItem blockItem) {
        if (a.has("state") && !a.get("state").isJsonNull()) {
            BlockState st = BlockTools.parseState(level.getServer(), a.get("state").getAsString());
            if (st.getBlock() != blockItem.getBlock()) {
                throw new IllegalArgumentException("`state` block " + blockId(st)
                    + " does not match the held item " + itemId(blockItem));
            }
            return st;
        }
        return blockItem.getBlock().defaultBlockState();
    }

    // ---- bot_use (sync) ------------------------------------------------------

    static JsonObject botUse(final JsonObject a, final DroneTools.Slot slot) {
        Actuator act = Actuator.require(slot);
        Hands hands = act.hands();
        ServerLevel level = act.level();
        BlockPos at = parsePos(a, "at");

        ItemStack stack = resolveStack(act, a);
        JsonObject r = new JsonObject();
        if (stack.isEmpty()) {
            return fail(r, namedItem(a) ? "item_missing" : "empty_hand");
        }
        if (!act.inBlockReach(Vec3.atCenterOf(at))) {
            r.addProperty("note", REACH_REMEDY);
            return fail(r, "out_of_reach");
        }

        Direction face = parseDir(a, "face", Direction.UP);
        Vec3 hit = Vec3.atCenterOf(at)
            .add(face.getStepX() * 0.5, face.getStepY() * 0.5, face.getStepZ() * 0.5);
        BlockHitResult hitResult = new BlockHitResult(hit, face, at, false);

        int beforeCount = stack.getCount();
        BlockState blockBefore = level.getBlockState(at);
        // The use button (world-model DESIGN.md §9 Phase 3): a bot_use is one use press,
        // whichever of the item/block interactions below ends up answering it.
        com.mattmc.mcptoolkit.wm.Wm.actionPress(act.body(), true, false, -1);
        net.minecraft.world.InteractionResult attempt;
        try {
            // The player body sheds bot_use's biggest caveat here: behaviours that "require a real
            // player" get one. The drone keeps the null-player best-effort path.
            UseOnContext use = new UseOnContext(level, hands.handsPlayer(), InteractionHand.MAIN_HAND,
                stack, hitResult);
            attempt = stack.useOn(use);
        } catch (Exception e) {
            // Keep the reason enumerable, but stop collapsing every distinct cause into it.
            r.addProperty("detail", e.toString());
            return fail(r, "use_unsupported");
        }

        // The ITEM had no behaviour here — which does not mean nothing can happen. A bed, a button, a
        // lever, a door all answer to the BLOCK's interaction, and bot_use only ever asked the item;
        // that asymmetry is why GoalRunner had to reach past this method to open doors. Ask the block
        // now. CONTAINERS are excluded first and deliberately: their interaction opens a SCREEN, which
        // the engine reports as a success while achieving exactly nothing for a headless body — a
        // textbook false success. They get named a tool that really works instead.
        if (!attempt.consumesAction()) {
            if (Containers.isContainer(level, at, blockBefore)) {
                r.addProperty("note", "that is a container — its interaction opens a screen, which a "
                    + "headless body has none of. Use bot_container {at, action} to read it, put items "
                    + "in, or take them out (that is also how smelting works: put ore + fuel into a "
                    + "furnace, then take the result).");
                return fail(r, "needs_container_tool");
            }
            net.minecraft.server.level.ServerPlayer asPlayer = hands.handsPlayer();
            if (asPlayer != null) {
                try {
                    BlockState now = level.getBlockState(at);
                    attempt = now.useItemOn(stack, level, asPlayer, InteractionHand.MAIN_HAND, hitResult);
                    if (!attempt.consumesAction()) {
                        attempt = now.useWithoutItem(level, asPlayer, hitResult);
                    }
                } catch (Exception e) {
                    r.addProperty("detail", e.toString());
                    return fail(r, "use_unsupported");
                }
            }
        }
        final net.minecraft.world.InteractionResult res = attempt;
        int consumed = beforeCount - stack.getCount();
        boolean blockChanged = level.getBlockState(at) != blockBefore;
        if (res.consumesAction()) {
            hands.placeVisual(at); // the player swings on a successful use; the drone shows nothing
        }

        r.addProperty("ok", true);
        // The game's own verdict on whether the use DID anything — a PASS/FAIL use that consumed
        // nothing and changed nothing used to be indistinguishable from a real effect.
        r.addProperty("effect", res.consumesAction() ? "used" : "none");
        r.addProperty("block_changed", blockChanged);
        r.addProperty("item", itemId(stack.isEmpty() ? null : stack.getItem()));
        r.addProperty("consumed", consumed);
        r.addProperty("remaining", stack.getCount());
        if (!res.consumesAction() && consumed == 0 && !blockChanged) {
            r.addProperty("note", "neither the item nor the block reported any use behaviour here ("
                + resultWord(res) + ") — nothing happened"
                + (hands.handsPlayer() == null
                    ? "; note this body is not a player, so behaviours that require one were not tried"
                    : ""));
        }
        emitDone(slot, "bot_use", d -> {
            addPos(d, "pos", at);
            d.addProperty("effect", res.consumesAction() ? "used" : "none");
            d.addProperty("consumed", consumed);
        });
        return r;
    }

    // ---- bot_attack (sync when facing; a short act when a turn is needed) ----

    /** Turn budget for an async attack: a 180° flip at the driver's rate is 2 ticks, so this is a
     *  circuit breaker for a target that keeps dancing out of the epsilon, never a duration. */
    static final int SWING_TIMEOUT_TICKS = 60;

    /**
     * One in-flight attack TURN (V3_PLAN.md §2 F1): the body is rotating toward {@code targetId}
     * at the nav driver's gaze rate, and the swing fires on the tick it is facing with line of
     * sight still clear. Held per slot ({@link DroneTools.Slot#swing}), serviced by
     * {@link #swingTick} from tickWatch.
     */
    static final class Swing {
        final String actionId;
        final int targetId;
        /** The turning body's entity id — kept so {@link #failSwing} can hand the gaze back
         *  (S2's {@code AttackGate.holdsGaze}) on the exit paths where the body is already gone. */
        final int bodyId;
        final @Nullable String wieldItem;
        /** The kit decided at target resolution, so the COMPLETION verdict says the same `mode`
         *  and `why` the start reply did (null on a drone body, which has no kit). */
        final CombatKit.@Nullable Kit kit;
        final @Nullable CompletableFuture<JsonElement> waiter;
        int ticksLeft = SWING_TIMEOUT_TICKS;

        Swing(final String actionId, final int targetId, final int bodyId,
              final @Nullable String wieldItem, final CombatKit.@Nullable Kit kit,
              final @Nullable CompletableFuture<JsonElement> waiter) {
            this.actionId = actionId;
            this.targetId = targetId;
            this.bodyId = bodyId;
            this.wieldItem = wieldItem;
            this.kit = kit;
            this.waiter = waiter;
        }
    }

    static JsonObject botAttack(final JsonObject a, final DroneTools.Slot slot) {
        return botAttack(a, slot, null);
    }

    static JsonObject botAttack(final JsonObject a, final DroneTools.Slot slot,
                                final @Nullable CompletableFuture<JsonElement> waiter) {
        Actuator act = Actuator.require(slot);
        LivingEntity body = act.body();
        ServerLevel level = act.level();
        JsonObject r = new JsonObject();

        Entity target;
        if (a.has("target") && !a.get("target").isJsonNull()) {
            target = level.getEntity(a.get("target").getAsInt());
            if (target == null || !target.isAlive()) {
                return fail(r, "no_target");
            }
        } else if (a.has("nearest") && !a.get("nearest").isJsonNull() && a.get("nearest").getAsBoolean()) {
            target = nearestLiving(level, body);
            if (target == null) {
                return fail(r, "no_target");
            }
        } else {
            throw new IllegalArgumentException("pass `target` (entity id) or `nearest`:true");
        }

        if (!act.inEntityReach(target)) {
            return fail(r, "out_of_reach");
        }

        // Validate a named wield item BEFORE any gate work: a turn must never start toward a swing
        // that can never be performed (and item_missing stays an instant, synchronous refusal).
        // THIS ORDER IS LOAD-BEARING, not tidiness: act-honesty.test.mjs:102 attacks `nearest` with
        // an item it does not carry from a stand that is not facing, and asserts {ok:false,
        // reason:"item_missing"}. Below the LOS/facing gates the same call would answer
        // {started:true} (a turn) or `occluded`, and the probe would read a refusal it never made.
        String wieldItem = a.has("item") && !a.get("item").isJsonNull()
            ? a.get("item").getAsString() : null;
        BotBodyEntity droneHands = act.droneOrNull();
        if (wieldItem != null && droneHands != null
                && findItemSlot(droneHands.inventory(), wieldItem) < 0) {
            r.addProperty("note", "no '" + wieldItem + "' in the drone's inventory — check "
                + "bot_status {inventory:true}, or bot_give it first");
            return fail(r, "item_missing");
        }
        // THE HAND IS ARMED HERE, before the gates, for the reason the comment above gives in the
        // other direction: on the async path the body spends ticks TURNING, and an item change
        // resets vanilla's attack-strength ticker (Player.tick) — arm at the swing and the first
        // blow of every fight lands at the 0.2 floor of the charge curve. Arm at target
        // resolution and the turn pays that cost instead. Every swing path in the toolkit reaches
        // the gate through this method (tool, attack goal, bot_run queue, fight reflex), so this
        // one site arms them all. A named `item` overrides the choice on a player body too — it
        // used to be read, validated for the drone, and then silently dropped for the player.
        // WHICH FIGHT IS THIS (COMBAT_KIT_PLAN.md §4.1). The kit answers BOTH hands, and `why`
        // rides every verdict below — a body that changes weapon class silently is exactly what
        // the 2026-08-11 audit had to reconstruct from tick envelopes. `forSwing`, not `choose`:
        // this call already refused `out_of_reach` above, so a hand-issued swing IS a melee act
        // and the mode is not open for negotiation here. The caller that genuinely gets to choose
        // is the goal loop, which is also the only one that LEARNS a target cannot be walked to
        // (GoalRunner.tickAttack).
        String armed = null;
        String offhand = null;
        CombatKit.Kit kit = null;
        if (act.playerOrNull() != null) {
            kit = CombatKit.forSwing(body, act.hands(), target);
            if (wieldItem != null) {
                if (findItemSlot(act.hands().container(), wieldItem) < 0) {
                    r.addProperty("note", "no '" + wieldItem + "' in the pack — check "
                        + "bot_status {inventory:true}, or omit `item` to swing with the best "
                        + "weapon carried");
                    return fail(r, "item_missing");
                }
                selectIntoHand(act.hands(), findItemSlot(act.hands().container(), wieldItem));
                armed = itemId(act.hands().selectedStack().getItem());
                // The caller chose the MAINHAND; the offhand is a different slot and still ours.
                offhand = CombatKit.equipOffhand(act.hands(), kit.off());
            } else {
                CombatKit.Equipped eq = CombatKit.equip(act.hands(), kit);
                armed = eq == null ? null : eq.main();
                offhand = eq == null ? null : eq.off();
            }
        }

        // F1 gate (a): LINE OF SIGHT. A swing through a wall is the audited capability cheat —
        // refused here so every caller (tool, goal, queue, reflex) inherits the refusal.
        if (!AttackGate.hasLos(body, target)) {
            r.addProperty("note", "a block stands between the eye and the target — no swing can "
                + "land through it. Move to where you can SEE the target (bot_target "
                + "action:\"attack\" approaches and re-aims for you)");
            return fail(r, "occluded");
        }

        // An offhand change is a real action and deserves an event of its own, not just a reply
        // field: the reflex layer and the event stream are how a later session reads a fight back,
        // and "the body raised a shield" that appears in no event never happened as far as they
        // are concerned.
        if (offhand != null) {
            JsonObject od = new JsonObject();
            od.addProperty("item", offhand);
            od.addProperty("why", kit.why());
            od.addProperty("health", body.getHealth());
            EventLog.emit("offhand_switched", od, slot.target());
        }

        // F1 gate (b): FACING. Already facing → the synchronous swing, exactly as before.
        if (AttackGate.gate(body, target, false) == AttackGate.Verdict.READY) {
            JsonObject swung = performSwing(wieldItem, slot, act, target, null);
            CombatKit.report(swung, kit, armed, offhand);
            return swung;
        }

        // Not facing: the body must TURN first — rate-limited at the driver's own gaze rate, so
        // the call becomes a short act completing via events (the bot_mine model).
        if (slot.swing != null) {
            failSwing(slot, "superseded"); // the newest deliberate attack wins
        }
        String actionId = "atk-" + (++actionSeq);
        slot.swing = new Swing(actionId, target.getId(), body.getId(), wieldItem, kit, waiter);
        r.addProperty("started", true);
        r.addProperty("action_id", actionId);
        // The hands changed BEFORE the turn, so the fact belongs in the reply that starts it; the
        // kit rides the Swing so the COMPLETION says the same thing to whoever only sees the end.
        CombatKit.report(r, kit, armed, offhand);
        r.addProperty("eta_ticks", AttackGate.turnTicks(body, target));
        r.addProperty("note", "not facing the target — the body is turning toward it at its "
            + "normal gaze rate; the swing fires once facing with line of sight still clear. "
            + "Completes via action_completed {hit, ...} or action_failed {reason}");
        return r;
    }

    /**
     * The actual swing, shared by the synchronous path and the post-turn completion. The caller
     * has already passed the F1 gates; {@code actionId} non-null marks an async completion (it
     * rides the action_completed event for correlation).
     */
    private static JsonObject performSwing(final @Nullable String wieldItem,
                                           final DroneTools.Slot slot, final Actuator act,
                                           final Entity target, final @Nullable String actionId) {
        LivingEntity body = act.body();
        ServerLevel level = act.level();
        JsonObject r = new JsonObject();

        FakePlayerEntity fp = act.playerOrNull();
        if (fp != null) {
            // The hand was armed at target resolution (botAttack, WeaponGate) so the turn could
            // absorb the cooldown reset — by here it already holds what it should, and the
            // verdict's `weapon` says which item that was.
            return PlayerVerbs.attack(slot, fp, target, actionId);
        }

        BotBodyEntity drone = act.droneOrNull();
        // Wield for the swing (drone hands only): the named `item`, else the HELD slot — the held
        // weapon genuinely applies now (there is no other selected→equipment sync, so before this
        // the default swing was always empty-handed while the docs claimed otherwise). The swing
        // gets a COPY: equipping the live inventory stack aliases it into the equipment slot, which
        // vanilla death drop-chances can dupe. Post-swing (durability) state is written back below.
        int wieldSlot = -1;
        if (drone != null) {
            if (wieldItem != null) {
                wieldSlot = findItemSlot(drone.inventory(), wieldItem);
                if (wieldSlot < 0) {
                    r.addProperty("note", "no '" + wieldItem + "' in the drone's inventory — check "
                        + "bot_status {inventory:true}, or bot_give it first");
                    return fail(r, "item_missing");
                }
            } else {
                wieldSlot = drone.selectedSlot();
            }
            drone.setItemInHand(InteractionHand.MAIN_HAND, drone.inventory().getItem(wieldSlot).copy());
        }

        float before = target instanceof LivingEntity le ? le.getHealth() : -1;
        boolean hit = body.doHurtTarget(level, target);
        float after = target instanceof LivingEntity le ? le.getHealth() : -1;

        if (drone != null) {
            // Write the swung copy back (durability changes land in the inventory, not a phantom
            // equipment stack) and clear the hand so nothing stays aliased/dupable.
            drone.inventory().setItem(wieldSlot, drone.getItemInHand(InteractionHand.MAIN_HAND));
            drone.setItemInHand(InteractionHand.MAIN_HAND, ItemStack.EMPTY);
        }

        if (drone != null) {
            // The attack reads on screen: red beam flash to the target + a client-side lunge.
            drone.setBeam(BotBodyEntity.BEAM_ATTACK, target.getEyePosition(), ATTACK_FLASH_TICKS);
            level.broadcastEntityEvent(drone, BotBodyEntity.EVENT_LUNGE);
        }

        r.addProperty("ok", true);
        r.addProperty("hit", hit);
        if (wieldSlot >= 0) {
            ItemStack swung = drone.inventory().getItem(wieldSlot);
            r.addProperty("weapon", swung.isEmpty() ? null : itemId(swung.getItem()));
        }
        r.add("target", describeTarget(target, after));
        if (before >= 0) {
            r.addProperty("damageDealt", Math.max(0, before - after));
        }
        int targetId = target.getId();
        emitDone(slot, "bot_attack", d -> {
            if (actionId != null) {
                d.addProperty("action_id", actionId);
            }
            d.addProperty("target_id", targetId);
            d.addProperty("hit", hit);
        });
        return r;
    }

    /**
     * Advance the slot's in-flight attack turn one tick (no-op when none). Serviced from tickWatch
     * before the LookDriver (which yields to it — the swing owns the head).
     * Every gate re-runs on every tick: a target that moved behind cover mid-turn fails
     * {@code occluded}, one that walked away fails {@code out_of_reach} — the swing NEVER fires on
     * stale geometry.
     *
     * <p>The turn also owns the body's GAZE while it runs (S2): {@code AttackGate.gate} re-stamps
     * {@code holdsGaze} on every TURNING tick — and on the READY tick, so the body is still
     * looking at what it hits — which is what keeps the movement drivers steering with the legs
     * and leaving the look alone. It releases at once on OCCLUDED / OUT_OF_REACH, and the three
     * exits above it ({@code body_removed}, {@code target_lost}, {@code facing_timeout}) go
     * through {@link #failSwing}, which releases too. Nothing here can strand a hold: it also
     * lapses one tick after the last gated tick, whoever stopped calling.
     */
    static void swingTick(final DroneTools.Slot slot) {
        Swing s = slot.swing;
        if (s == null) {
            return;
        }
        LivingEntity body = slot.activeBody();
        if (body == null || body.isRemoved() || !body.isAlive()) {
            failSwing(slot, "body_removed");
            return;
        }
        Entity target = ((ServerLevel) body.level()).getEntity(s.targetId);
        if (target == null || !target.isAlive()) {
            failSwing(slot, "target_lost");
            return;
        }
        if (--s.ticksLeft < 0) {
            failSwing(slot, "facing_timeout");
            return;
        }
        switch (AttackGate.gate(body, target, true)) {
            case OUT_OF_REACH -> failSwing(slot, "out_of_reach"); // it moved away mid-turn
            case OCCLUDED -> failSwing(slot, "occluded");         // it moved behind cover mid-turn
            case TURNING -> { }                                   // still sweeping — next tick
            case READY -> {
                slot.swing = null;
                JsonObject r = performSwing(s.wieldItem, slot, Actuator.require(slot), target,
                    s.actionId);
                CombatKit.report(r, s.kit, null, null);
                if (r.has("ok") && r.get("ok").getAsBoolean()) {
                    // A queue attack step parked on this action advances (the goal loop never
                    // parks on a swing — its tickAttack gates before calling).
                    JsonObject done = r.deepCopy();
                    done.addProperty("action_id", s.actionId);
                    QueueRunner.onActionDone(slot, s.actionId, done);
                    GoalRunner.onActionDone(slot, s.actionId, done);
                } else {
                    String why = r.has("reason") ? r.get("reason").getAsString() : "failed";
                    JsonObject data = new JsonObject();
                    data.addProperty("action_id", s.actionId);
                    data.addProperty("action", "bot_attack");
                    data.addProperty("reason", why);
                    EventLog.emit("action_failed", data, slot.target());
                    QueueRunner.onActionFailed(slot, s.actionId, why);
                    GoalRunner.onActionFailed(slot, s.actionId, why);
                }
                if (s.waiter != null) {
                    s.waiter.complete(r.deepCopy());
                }
            }
        }
    }

    /** Abort the in-flight attack turn: action_failed + the waiter answered, never stranded. */
    static void failSwing(final DroneTools.Slot slot, final String reason) {
        Swing s = slot.swing;
        if (s == null) {
            return;
        }
        slot.swing = null;
        // Hand the gaze back on EVERY abort path — superseded, target_lost, facing_timeout,
        // body_removed, session_ended, drone despawn (S2). The hold expires by itself within a
        // tick, so this is the explicit half of a belt-and-braces pair: a body that stops turning
        // must steer again immediately, and a gaze stuck on a dead target would be worse than the
        // convergence bug the hold exists to fix. By id, because `body_removed` means exactly that.
        AttackGate.releaseGaze(s.bodyId);
        JsonObject data = new JsonObject();
        data.addProperty("action_id", s.actionId);
        data.addProperty("action", "bot_attack");
        data.addProperty("reason", reason);
        EventLog.emit("action_failed", data, slot.target());
        QueueRunner.onActionFailed(slot, s.actionId, reason);
        GoalRunner.onActionFailed(slot, s.actionId, reason);
        if (s.waiter != null) {
            s.waiter.complete(data.deepCopy());
        }
    }

    /**
     * Nearest living entity within the body's HONEST reach that the eye can actually SEE — the
     * LOS filter is F1's reflex fix: the reflex swing used to pick nearest-in-sphere and hit a
     * zombie through an intact wall (audited live). Package-visible: the reflex attack resolves
     * its target here and then runs the same gate before swinging.
     */
    static @Nullable Entity nearestLiving(final ServerLevel level, final LivingEntity body) {
        double reach = AttackGate.entityReach(body);
        AABB box = body.getBoundingBox().inflate(reach);
        List<Entity> found = level.getEntities(body, box,
            e -> e instanceof LivingEntity && e.isAlive() && body.distanceTo(e) <= reach
                && AttackGate.hasLos(body, e));
        Entity best = null;
        double bestD = Double.MAX_VALUE;
        for (Entity e : found) {
            double d = body.distanceToSqr(e);
            if (d < bestD) {
                bestD = d;
                best = e;
            }
        }
        return best;
    }

    // ---- bot_shoot (a real draw on a player body; the drone's own actuation otherwise) --------

    /** Ranged scan reach for {@code nearest}. */
    private static final double SHOOT_RANGE = 32.0;
    /** Launch speed of the drone's shot — vanilla's own full-draw number ({@code pow × 3.0F}). */
    private static final float SHOOT_POWER = 3.0F;

    static JsonObject botShoot(final JsonObject a, final DroneTools.Slot slot) {
        return botShoot(a, slot, null);
    }

    /**
     * Fire at an entity. On a PLAYER body this is a real draw ({@link PlayerVerbs#startShot}) —
     * vanilla's own use-hold, power curve, ammunition choice and projectile — and therefore a short
     * act: {@code {started, action_id, eta_ticks}} while drawing, completing on release.
     *
     * <p><b>The drone keeps its synthesized arrow, and that is not the divergence §4.2 warns
     * about.</b> {@code BowItem.releaseUsing} begins {@code if (entity instanceof Player)} and
     * returns false for anything else, so a bow simply cannot be fired from a drone: it is not that
     * the toolkit prefers a second path there, it is that vanilla offers no first one. This is the
     * same asymmetry {@link #performSwing} already has ({@code PlayerVerbs.attack} for the player,
     * {@code doHurtTarget} for the drone) and the same one the dig gate and {@link WeaponGate} have.
     * What the plan rules out — a player body with two ways to shoot, one of which skips the
     * use-hold and poisons the recorded press channel — is gone.
     */
    static JsonObject botShoot(final JsonObject a, final DroneTools.Slot slot,
                               final @Nullable CompletableFuture<JsonElement> waiter) {
        Actuator act = Actuator.require(slot);
        Hands hands = act.hands();
        LivingEntity body = hands.handsBody();
        ServerLevel level = act.level();
        JsonObject r = new JsonObject();

        Entity target;
        if (a.has("target") && !a.get("target").isJsonNull()) {
            target = level.getEntity(a.get("target").getAsInt());
            if (target == null || !target.isAlive()) {
                return fail(r, "no_target");
            }
        } else if (a.has("nearest") && !a.get("nearest").isJsonNull() && a.get("nearest").getAsBoolean()) {
            target = nearestHostile(level, body, SHOOT_RANGE);
            if (target == null) {
                return fail(r, "no_target");
            }
        } else {
            throw new IllegalArgumentException("pass `target` (entity id) or `nearest`:true");
        }

        FakePlayerEntity fp = act.playerOrNull();
        if (fp != null) {
            return PlayerVerbs.startShot(a, slot, fp, hands, target, waiter);
        }
        return droneShot(a, slot, hands, body, level, target, r);
    }

    /**
     * The drone's shot: a launched arrow, borrowing a held bow only for its enchantments. Unchanged
     * from 0.72.0 except that it now reports its landing through {@link Shots} like the player's.
     */
    private static JsonObject droneShot(final JsonObject a, final DroneTools.Slot slot,
                                        final Hands hands, final LivingEntity body,
                                        final ServerLevel level, final Entity target,
                                        final JsonObject r) {
        String arrowId = a.has("item") && !a.get("item").isJsonNull() ? a.get("item").getAsString() : "minecraft:arrow";
        int idx = findItemSlot(hands.container(), arrowId);
        if (idx < 0) {
            r.addProperty("note", "no '" + arrowId + "' in the body's inventory — it needs arrows");
            return fail(r, "item_missing");
        }
        ItemStack held = hands.selectedStack();
        boolean isBow = !held.isEmpty()
            && BuiltInRegistries.ITEM.getKey(held.getItem()).getPath().endsWith("bow");
        net.minecraft.world.entity.projectile.arrow.Arrow arrow =
            new net.minecraft.world.entity.projectile.arrow.Arrow(
                level, body, new ItemStack(net.minecraft.world.item.Items.ARROW), isBow ? held : null);
        Vec3 dir = target.getEyePosition().subtract(arrow.position());
        arrow.shoot(dir.x, dir.y, dir.z, SHOOT_POWER, 0.5F); // slight spread; the profile can widen it
        level.addFreshEntity(arrow);
        hands.container().getItem(idx).shrink(1);
        // Read on screen: red beam at the target (drone) / arm swing (player).
        hands.attackVisual(target.getEyePosition());

        r.addProperty("ok", true);
        r.addProperty("shot", target.getId());
        r.addProperty("arrow_id", arrow.getId());
        r.addProperty("weapon", isBow ? itemId(held.getItem()) : null);
        r.addProperty("arrows_left", hands.container().getItem(idx).getCount());
        int tid = target.getId();
        int aid = arrow.getId();
        String weaponId = isBow ? itemId(held.getItem()) : "none";
        emitDone(slot, "bot_shoot", d -> {
            d.addProperty("target_id", tid);
            d.addProperty("arrow_id", aid);
        });
        Shots.track(slot, arrow, target, "drone-shot", weaponId);
        return r;
    }

    /**
     * Nearest hostile within {@code range} that the eye can actually SEE — the same LOS filter
     * {@link #nearestLiving} carries for the swing, and for the same reason one level out: a
     * {@code nearest:true} shot that picks a zombie through a wall has chosen a target the very
     * next gate must refuse {@code occluded}, while a hostile in the open stood two blocks further
     * away.
     */
    private static @Nullable Entity nearestHostile(final ServerLevel level, final LivingEntity body, final double range) {
        AABB box = body.getBoundingBox().inflate(range);
        Entity best = null;
        double bestD = Double.MAX_VALUE;
        for (Entity e : level.getEntities(body, box,
                x -> x instanceof net.minecraft.world.entity.monster.Enemy && x.isAlive()
                    && AttackGate.hasLos(body, x))) {
            double d = body.distanceToSqr(e);
            if (d < bestD) {
                bestD = d;
                best = e;
            }
        }
        return best;
    }

    // ---- bot_eat / bot_drink (sync) ------------------------------------------

    /**
     * Consume one food ({@code drink=false}) or potion ({@code drink=true}) from the drone's inventory
     * and apply its effects to the body. Shared by the {@code bot_eat}/{@code bot_drink} tools and the
     * eat/drink reflex responses. Honest outcome: refuses {@code empty_hand}/{@code item_missing}/
     * {@code not_a_potion} and reports the effects actually now on the body, not merely that it ran.
     */
    static JsonObject botConsume(final JsonObject a, final DroneTools.Slot slot, final boolean drink,
                                 final @Nullable CompletableFuture<JsonElement> waiter) {
        Actuator act = Actuator.require(slot);
        FakePlayerEntity fp = act.playerOrNull();
        if (fp != null) {
            // The player body eats for REAL (vanilla use-ticks): a {started:true} reply means the
            // outcome arrives through `waiter` (~1.6s); anything else is a refusal or an
            // instant-fallback result the caller completes with directly.
            return PlayerVerbs.consume(a, slot, fp, drink,
                waiter != null ? waiter : new CompletableFuture<>());
        }
        // The player returned above, so these hands are the drone's (possessed mobs throw here).
        BotBodyEntity drone = (BotBodyEntity) act.hands();
        ServerLevel level = act.level();
        SimpleContainer inv = drone.inventory();
        JsonObject r = new JsonObject();

        int idx;
        if (a.has("item") && !a.get("item").isJsonNull()) {
            idx = findItemSlot(inv, a.get("item").getAsString());
            if (idx < 0) {
                r.addProperty("note", "no '" + a.get("item").getAsString() + "' in the drone's inventory — "
                    + "check bot_status {inventory:true}, or bot_give it first");
                return fail(r, "item_missing");
            }
        } else if (drink) {
            idx = drone.selectedSlot();
        } else {
            // Same rule as the player path (PlayerVerbs.consume): the held item when it is food,
            // otherwise the best plain food, otherwise an honest refusal.
            int held = drone.selectedSlot();
            idx = isFood(inv.getItem(held)) ? held : bestPlainFoodSlot(inv);
            if (idx < 0) {
                r.addProperty("note", "nothing edible in the drone's inventory. Foods with side "
                    + "effects are never chosen automatically — name one with `item`.");
                return fail(r, "no_food");
            }
            if (idx != held) {
                r.addProperty("chose", itemId(inv.getItem(idx).getItem()));
                r.addProperty("chose_why", "the held item ("
                    + (inv.getItem(held).isEmpty() ? "nothing" : itemId(inv.getItem(held).getItem()))
                    + ") is not food");
            }
        }
        ItemStack stack = inv.getItem(idx);
        if (stack.isEmpty()) {
            return fail(r, "empty_hand");
        }
        if (!drink && !isFood(stack)) {
            r.addProperty("note", itemId(stack.getItem()) + " is not food — eating it would do "
                + "nothing at all.");
            return fail(r, "not_food");
        }
        String consumed = itemId(stack.getItem());
        float before = drone.getHealth();

        if (drink) {
            net.minecraft.world.item.alchemy.PotionContents potion =
                stack.get(net.minecraft.core.component.DataComponents.POTION_CONTENTS);
            if (potion == null) {
                return fail(r, "not_a_potion");
            }
            potion.applyToLivingEntity(drone, 1.0F); // the item's own effects, honest durations
            stack.shrink(1);
            ItemStack leftover = inv.addItem(new ItemStack(net.minecraft.world.item.Items.GLASS_BOTTLE));
            if (!leftover.isEmpty()) {
                Block.popResource(level, drone.blockPosition(), leftover);
            }
        } else {
            // finishUsingItem applies the food/consumable's effects to the body and returns the
            // remainder (usually empty); it mutates `stack` in place (shrinks it).
            ItemStack result = stack.finishUsingItem(level, drone);
            inv.setItem(idx, stack);
            if (result != stack && !result.isEmpty()) {
                ItemStack leftover = inv.addItem(result);
                if (!leftover.isEmpty()) {
                    Block.popResource(level, drone.blockPosition(), leftover);
                }
            }
        }
        float after = drone.getHealth();

        r.addProperty("ok", true);
        r.addProperty(drink ? "drank" : "ate", consumed);
        JsonArray effects = new JsonArray();
        for (net.minecraft.world.effect.MobEffectInstance e : drone.getActiveEffects()) {
            effects.add(e.getEffect().getRegisteredName());
        }
        r.add("effects", effects);
        r.addProperty("effect_count", effects.size());
        if (after != before) {
            r.addProperty("healed", after - before);
        }
        if (drone.getAbsorptionAmount() > 0) {
            r.addProperty("absorption", drone.getAbsorptionAmount());
        }
        if (effects.isEmpty() && after == before && drone.getAbsorptionAmount() <= 0) {
            r.addProperty("note", "consumed, but it applied no effect to the body (no potion contents / "
                + "food effects that affect a non-player)");
        }
        int effectCount = effects.size();
        emitDone(slot, drink ? "bot_drink" : "bot_eat", d -> {
            d.addProperty("item", consumed);
            d.addProperty("effect_count", effectCount);
        });
        return r;
    }

    // ---- bot_equip (sync) ----------------------------------------------------

    private static final java.util.Map<String, EquipmentSlot> EQUIP_SLOTS = java.util.Map.of(
        "head", EquipmentSlot.HEAD, "chest", EquipmentSlot.CHEST, "legs", EquipmentSlot.LEGS,
        "feet", EquipmentSlot.FEET, "mainhand", EquipmentSlot.MAINHAND, "offhand", EquipmentSlot.OFFHAND);

    static JsonObject botEquip(final JsonObject a, final DroneTools.Slot slot) {
        Actuator act = Actuator.require(slot);
        FakePlayerEntity fp = act.playerOrNull();
        if (fp != null) {
            return PlayerVerbs.equip(a, fp);
        }
        BotBodyEntity drone = (BotBodyEntity) act.hands();
        SimpleContainer inv = drone.inventory();
        JsonObject r = new JsonObject();
        JsonObject equipped = new JsonObject();
        JsonArray missing = new JsonArray();

        for (var e : EQUIP_SLOTS.entrySet()) {
            String key = e.getKey();
            if (!a.has(key)) {
                continue;
            }
            EquipmentSlot es = e.getValue();
            if (a.get(key).isJsonNull()) {
                // Unequip: return the worn item to inventory, clear the slot.
                ItemStack worn = drone.getItemBySlot(es);
                if (!worn.isEmpty()) {
                    inv.addItem(worn.copy());
                    drone.setItemSlot(es, ItemStack.EMPTY);
                }
                equipped.add(key, com.google.gson.JsonNull.INSTANCE);
                continue;
            }
            String id = a.get(key).getAsString();
            int idx = findItemSlot(inv, id);
            if (idx < 0) {
                missing.add(key + ":" + id);
                continue;
            }
            ItemStack toEquip = inv.getItem(idx).copy();
            inv.getItem(idx).setCount(0); // take it out of inventory
            ItemStack prev = drone.getItemBySlot(es);
            if (!prev.isEmpty()) {
                inv.addItem(prev.copy()); // swapped-out item goes back to inventory
            }
            drone.setItemSlot(es, toEquip);
            if (es == EquipmentSlot.MAINHAND) {
                // Keep the held-slot abstraction consistent: mainhand equip mirrors the selected item.
                drone.setSelectedSlot(drone.selectedSlot());
            }
            equipped.addProperty(key, id);
        }

        r.addProperty("ok", true);
        r.add("equipped", equipped);
        if (!missing.isEmpty()) {
            r.add("item_missing", missing);
        }
        r.addProperty("armor", drone.getArmorValue());
        return r;
    }

    // ---- bot_inventory / bot_select / bot_give -------------------------------

    static JsonObject botInventory(final DroneTools.Slot slot) {
        Actuator act = Actuator.require(slot);
        FakePlayerEntity fpInv = act.playerOrNull();
        if (fpInv != null) {
            return PlayerVerbs.inventory(fpInv);
        }
        net.minecraft.world.Container inv = act.inventory();
        JsonObject r = new JsonObject();
        r.addProperty("size", inv.getContainerSize());
        r.addProperty("selectedSlot", act.hands().selectedSlot());
        JsonArray slots = new JsonArray();
        for (int i = 0; i < inv.getContainerSize(); i++) {
            ItemStack st = inv.getItem(i);
            if (st.isEmpty()) {
                continue;
            }
            JsonObject o = new JsonObject();
            o.addProperty("slot", i);
            o.addProperty("item", itemId(st.getItem()));
            o.addProperty("count", st.getCount());
            slots.add(o);
        }
        r.add("slots", slots);
        ItemStack held = act.held();
        r.addProperty("held", held.isEmpty() ? null : itemId(held.getItem()));
        return r;
    }

    static JsonObject botSelect(final JsonObject a, final DroneTools.Slot slot) {
        Actuator act = Actuator.require(slot);
        FakePlayerEntity fp = act.playerOrNull();
        if (fp != null) {
            return PlayerVerbs.select(a, fp);
        }
        BotBodyEntity drone = (BotBodyEntity) act.hands();
        SimpleContainer inv = drone.inventory();
        if (a.has("slot") && !a.get("slot").isJsonNull()) {
            int idx = a.get("slot").getAsInt();
            if (idx < 0 || idx >= inv.getContainerSize()) {
                throw new IllegalArgumentException("slot out of range 0.." + (inv.getContainerSize() - 1));
            }
            drone.setSelectedSlot(idx);
        } else if (a.has("item") && !a.get("item").isJsonNull()) {
            String id = a.get("item").getAsString();
            int idx = findItemSlot(inv, id);
            if (idx < 0) {
                throw new IllegalArgumentException("no such item in inventory: " + id);
            }
            drone.setSelectedSlot(idx);
        } else {
            throw new IllegalArgumentException("pass `slot` or `item`");
        }

        JsonObject r = new JsonObject();
        r.addProperty("selectedSlot", drone.selectedSlot());
        ItemStack held = drone.selectedStack();
        r.addProperty("held", held.isEmpty() ? null : itemId(held.getItem()));
        r.addProperty("count", held.getCount());
        return r;
    }

    private static JsonObject botGive(final JsonObject a, final DroneTools.Slot slot) {
        Actuator act = Actuator.require(slot);
        Hands hands = act.hands();
        if (!a.has("item") || a.get("item").isJsonNull()) {
            throw new IllegalArgumentException("missing `item` id");
        }
        Identifier id = Identifier.parse(a.get("item").getAsString());
        Item item = BuiltInRegistries.ITEM.getOptional(id)
            .orElseThrow(() -> new IllegalArgumentException("unknown item '" + id + "'"));
        int count = a.has("count") && !a.get("count").isJsonNull() ? a.get("count").getAsInt() : 1;
        if (count <= 0) {
            throw new IllegalArgumentException("`count` must be positive");
        }

        ItemStack stack = new ItemStack(item, count);
        ItemStack leftover = hands.insert(stack);
        int added = count - leftover.getCount();
        if (!leftover.isEmpty()) {
            Block.popResource(act.level(), hands.handsBody().blockPosition(), leftover);
        }

        JsonObject r = new JsonObject();
        r.addProperty("item", itemId(item));
        r.addProperty("requested", count);
        r.addProperty("added", added);
        r.addProperty("overflow", leftover.getCount());
        return r;
    }

    // ---- helpers -------------------------------------------------------------

    /** The stack to act with: the named `item` (found in inventory) or the held stack. */
    private static ItemStack resolveStack(final Actuator act, final JsonObject a) {
        if (namedItem(a)) {
            return findItem(act.inventory(), a.get("item").getAsString());
        }
        return act.held();
    }

    /** Did the caller name an explicit `item` (vs relying on the held slot)? */
    private static boolean namedItem(final JsonObject a) {
        return a.has("item") && !a.get("item").isJsonNull();
    }

    /** The first inventory stack whose item matches {@code id}, or {@link ItemStack#EMPTY}. */
    private static ItemStack findItem(final net.minecraft.world.Container inv, final String id) {
        int slot = findItemSlot(inv, id);
        return slot < 0 ? ItemStack.EMPTY : inv.getItem(slot);
    }

    // ---- what counts as food (2026-08-02) ------------------------------------------------------
    //
    // Added after a live survival death: the `heal` reflex is `{trigger:{health_below:8},
    // response:{op:"eat"}}`, `eat` with no `item` fell back to the HELD slot, and the body was
    // holding dirt. `finishUsingItem` on a non-food is a no-op, so the reflex fired, reported
    // `ok:true, ate:"minecraft:dirt"`, healed nothing, and fired again until the body died. A
    // success verdict for an act that did nothing is the 0.6.0 succeeds-falsely class exactly.

    /** Edible at all — vanilla's own test (see {@code Fox.isFood}). */
    static boolean isFood(final ItemStack stack) {
        return stack.has(net.minecraft.core.component.DataComponents.FOOD)
            && stack.has(net.minecraft.core.component.DataComponents.CONSUMABLE);
    }

    /**
     * Food that nourishes and does nothing else — the only kind we will pick FOR the caller.
     *
     * <p>The rule is read off vanilla's data rather than a hand-written blocklist, which is what
     * makes it right for modded items too: anything whose {@code Consumable} carries
     * {@code onConsumeEffects} does something besides feed you. That one condition excludes rotten
     * flesh, spider eye, pufferfish and poisonous potato (they poison), chorus fruit (it teleports
     * — an auto-eat that moves the body would be a spectacular way to lose one), suspicious stew,
     * and both golden apples (so a reflex can never burn the rarest thing in the pack on a scratch).
     * Any of them can still be eaten; the caller just has to NAME it, which is the point.
     */
    static boolean isPlainFood(final ItemStack stack) {
        if (!isFood(stack)) {
            return false;
        }
        var consumable = stack.get(net.minecraft.core.component.DataComponents.CONSUMABLE);
        return consumable != null && consumable.onConsumeEffects().isEmpty();
    }

    /**
     * The slot holding the most nourishing plain food, or -1. Ties break to the lowest slot so the
     * choice is deterministic — a reflex that picked differently between two identical inventories
     * would be unreproducible in exactly the situation you most want to reproduce.
     */
    static int bestPlainFoodSlot(final net.minecraft.world.Container inv) {
        int best = -1;
        int bestNutrition = -1;
        for (int i = 0; i < inv.getContainerSize(); i++) {
            ItemStack st = inv.getItem(i);
            if (st.isEmpty() || !isPlainFood(st)) {
                continue;
            }
            var food = st.get(net.minecraft.core.component.DataComponents.FOOD);
            int nutrition = food == null ? 0 : food.nutrition();
            if (nutrition > bestNutrition) {
                bestNutrition = nutrition;
                best = i;
            }
        }
        return best;
    }

    static int findItemSlot(final net.minecraft.world.Container inv, final String idStr) {
        Identifier id = Identifier.parse(idStr);
        for (int i = 0; i < inv.getContainerSize(); i++) {
            ItemStack st = inv.getItem(i);
            if (!st.isEmpty() && BuiltInRegistries.ITEM.getKey(st.getItem()).equals(id)) {
                return i;
            }
        }
        return -1;
    }

    /**
     * Put the container slot {@code idx} into the player's HAND: hotbar slots are selected, a main
     * inventory slot is swapped into the current hotbar slot — the same real-player move
     * {@code PlayerVerbs.select} makes. Only meaningful for player hands.
     */
    static void selectIntoHand(final Hands hands, final int idx) {
        net.minecraft.server.level.ServerPlayer sp = hands.handsPlayer();
        if (sp == null) {
            return;
        }
        net.minecraft.world.entity.player.Inventory inv = sp.getInventory();
        if (idx <= 8) {
            inv.setSelectedSlot(idx);
            // Hotbar input (world-model DESIGN.md §9 Phase 3): the auto-switch is a number-key
            // press too — the tool-gate's hand move is an input the client frame can express.
            com.mattmc.mcptoolkit.wm.Wm.actionPress(sp, false, false, idx);
        } else {
            ItemStack hot = inv.getItem(inv.getSelectedSlot());
            inv.setItem(inv.getSelectedSlot(), inv.getItem(idx));
            inv.setItem(idx, hot);
        }
    }

    /**
     * The pack slot holding the FASTEST tool for digging {@code st}, or -1 when none qualifies.
     * "Fastest that still harvests" is the tool a player's hand goes to: when {@code mustHarvest}
     * (the block is drop-gated) only correct-tier candidates are considered — a fast wrong tool
     * digs quicker and collects nothing, which is strictly worse than slow-and-paid.
     */
    static int bestDigToolSlot(final net.minecraft.world.Container inv, final BlockState st,
                               final boolean mustHarvest) {
        int best = -1;
        float bestSpeed = 0.0F;
        for (int i = 0; i < inv.getContainerSize(); i++) {
            ItemStack s = inv.getItem(i);
            if (s.isEmpty() || (mustHarvest && !s.isCorrectToolForDrops(st))) {
                continue;
            }
            float speed = s.getDestroySpeed(st);
            if (best < 0 || speed > bestSpeed) {
                best = i;
                bestSpeed = speed;
            }
        }
        return best;
    }

    /** The fastest correct-tier pack slot for {@code st}, or -1 — the refusal note's "you carry" */
    static int correctToolSlot(final net.minecraft.world.Container inv, final BlockState st) {
        return bestDigToolSlot(inv, st, true);
    }

    static JsonObject describeTarget(final Entity e, final float healthNow) {
        JsonObject o = new JsonObject();
        o.addProperty("id", e.getId());
        o.addProperty("type", BuiltInRegistries.ENTITY_TYPE.getKey(e.getType()).toString());
        o.addProperty("name", e.getDisplayName() == null ? e.getType().toShortString() : e.getDisplayName().getString());
        if (e instanceof LivingEntity le) {
            o.addProperty("health", healthNow);
            o.addProperty("maxHealth", le.getMaxHealth());
            o.addProperty("alive", le.isAlive());
        }
        return o;
    }

    private static Direction parseDir(final JsonObject a, final String key, final Direction fallback) {
        if (!a.has(key) || a.get(key).isJsonNull()) {
            return fallback;
        }
        Direction d = Direction.byName(a.get(key).getAsString().toLowerCase(java.util.Locale.ROOT));
        if (d == null) {
            throw new IllegalArgumentException("`" + key + "` must be up|down|north|south|east|west");
        }
        return d;
    }

    static BlockPos parsePos(final JsonObject a, final String key) {
        if (!a.has(key) || !a.get(key).isJsonObject()) {
            throw new IllegalArgumentException("missing `" + key + "` {x,y,z}");
        }
        JsonObject o = a.getAsJsonObject(key);
        return new BlockPos(o.get("x").getAsInt(), o.get("y").getAsInt(), o.get("z").getAsInt());
    }

    private static String blockId(final BlockState st) {
        return BuiltInRegistries.BLOCK.getKey(st.getBlock()).toString();
    }

    /** The vanilla interaction verdict as a word for notes: pass | fail | empty_hand_interaction. */
    private static String resultWord(final net.minecraft.world.InteractionResult res) {
        if (res instanceof net.minecraft.world.InteractionResult.Pass) return "pass";
        if (res instanceof net.minecraft.world.InteractionResult.Fail) return "fail";
        return "empty_hand_interaction";
    }

    static String itemId(final @Nullable Item item) {
        return item == null ? null : BuiltInRegistries.ITEM.getKey(item).toString();
    }

    /** started:false with a reason — used for pre-start refusals of async actions (nothing was started). */
    /** Remedy stamped on hand out_of_reach refusals — names the goal-shaped goto that fixes them,
     * so the agent's next call is one re-position instead of blind coordinate arithmetic. */
    private static final String REACH_REMEDY = "re-position with bot_goto reach:{x,y,z} of this "
        + "block — it lands anywhere the hand can touch it (range + line of sight)";

    private static JsonObject started(final JsonObject r, final boolean started, final String reason) {
        r.addProperty("started", started);
        r.addProperty("reason", reason);
        return r;
    }

    /** ok:false with a reason — used for synchronous embodied failures returned in-result. */
    static JsonObject fail(final JsonObject r, final String reason) {
        r.addProperty("ok", false);
        r.addProperty("reason", reason);
        return r;
    }

    /** Emit an action_completed for a synchronous embodied mutation (the embodiment audit trail),
     * targeted at the acting session (broadcast for the anonymous slot). */
    static void emitDone(final DroneTools.Slot slot, final String action,
                                 final java.util.function.Consumer<JsonObject> fill) {
        JsonObject d = new JsonObject();
        d.addProperty("action", action);
        fill.accept(d);
        DroneTools.stampEnvelope(d, slot.activeBody()); // embodied events are datable (§4)
        EventLog.emit("action_completed", d, slot.target());
    }

    private static void addPos(final JsonObject r, final String key, final BlockPos p) {
        JsonObject o = new JsonObject();
        o.addProperty("x", p.getX());
        o.addProperty("y", p.getY());
        o.addProperty("z", p.getZ());
        r.add(key, o);
    }
}
