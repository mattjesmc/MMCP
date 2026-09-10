package com.mattmc.mcptoolkit;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.mojang.serialization.DataResult;
import com.mojang.serialization.JsonOps;
import net.minecraft.core.BlockPos;
import net.minecraft.core.component.DataComponentPatch;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.Identifier;
import net.minecraft.resources.RegistryOps;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.util.RandomSource;
import net.minecraft.util.context.ContextKey;
import net.minecraft.util.context.ContextKeySet;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntitySpawnReason;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.storage.loot.LootParams;
import net.minecraft.world.level.storage.loot.LootTable;
import net.minecraft.world.level.storage.loot.parameters.LootContextParamSets;
import net.minecraft.world.level.storage.loot.parameters.LootContextParams;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * What does this loot table actually produce? (RELEASE_1.md section E6.)
 *
 * <p>A modder can push a loot table ({@code push_data}), have its bytes checked by the game's own codec
 * ({@code push_data}'s {@code validation}, section E1) and see that it LOADED ({@code query_registry}) —
 * and still have no way to ask the only question that matters: <em>what comes out of it, how often</em>.
 * This tool asks the running game to roll it.
 *
 * <p><b>Why it is not {@code run_command "/loot"}.</b> Vanilla's command exists and is blind in three
 * ways this tool is not: its results go INTO an inventory rather than back to the caller, it rolls once
 * (a distribution is what "is my rare drop rare enough" means), and {@code run_command} answers
 * {@code ok:true} for a command that failed. It also cannot report the commonest failure at all — a
 * table asked in the wrong context — because the parameter set is exactly what the command's syntax
 * fixes for you.
 *
 * <p><b>The parameter set is the mechanism, not a lookup table in this file.</b> Every loot table
 * declares its own {@link ContextKeySet} (the JSON's {@code "type"}), and
 * {@link net.minecraft.util.context.ContextMap.Builder#create} refuses a build missing a required key.
 * So the tool offers every parameter it can construct, keeps the ones the table's own set ALLOWS, and
 * reports what it supplied. A table asked in a context its set forbids gets a named refusal listing the
 * missing keys and the argument that would supply each, instead of an empty roll — the honest answer,
 * and one no vanilla route gives.
 *
 * <p><b>It supplies its own randomness on purpose, and that is a correctness rule rather than a
 * convenience.</b> {@link net.minecraft.world.level.storage.loot.LootContext.Builder#create} falls back
 * to {@code server.getRandomSequence(key)} when no random is given, which CREATES AND ADVANCES a
 * persistent per-sequence RNG stored in the level's saved data. Rolling a table to look at it would
 * then consume the world's own loot randomness and dirty the save — a read with a side effect on the
 * world. Passing an explicit {@link RandomSource} every roll keeps the tool {@link Mechanism#OBSERVE}
 * in fact and not only in its declaration.
 *
 * <p><b>A whole run draws from one random stream, not one seed per roll.</b> The obvious shape —
 * {@code RandomSource.create(seed + i)} — asks a legacy LCG for its FIRST draw from adjacent seeds,
 * and those draws are correlated enough to make the aggregate wrong rather than merely noisy: the
 * probe's 50% pool fired zero times in 200 rolls. One source, created from {@code seed} and carried
 * across the run, is reproducible in the same way and correct; and because
 * {@code LootContext.Builder.withOptionalRandomSeed} is exactly {@code RandomSource.create(seed)},
 * roll 0 is what the game itself would produce for that loot-table seed.
 *
 * <p><b>A missing table is reported, never rolled.</b> {@code reloadableRegistries().getLootTable()}
 * answers {@link LootTable#EMPTY} for an id that does not exist, which would report a typo as "your
 * table drops nothing" — the succeeds-falsely class this repo keeps finding. The registry is asked
 * whether the id is there first, and a miss answers {@code exists:false} with no roll fields at all
 * (the section E1 rule: when nothing was looked at, emit no field that would read as a look).
 */
public final class LootTools {
    private LootTools() {}

    /**
     * Rolls per call. The cap is a runtime bound, not a statistical one — 10k rolls of a chest table is
     * milliseconds, and the point of a big count is a distribution you can trust.
     */
    private static final int MAX_ROLLS = 10_000;
    /**
     * Distinct item ids reported. A table that can roll hundreds of ids is real (fishing junk, chest
     * pools); printing all of them would bury the answer, so the tail is counted in {@code distinct}.
     */
    private static final int MAX_ITEMS = 100;

    public static void register() {
        McpTools.register(ToolDef.of(
            "roll_loot",
            // TRIMMED before shipping, per finding 5's rule (price the whole entry, then look for the
            // same words twice): the first draft glossed all four subjects HERE and again in the schema,
            // ~400 chars of the same sentences. The schema keeps the per-argument line — it is what a
            // caller reads while filling arguments — and the description keeps only what a schema cannot
            // say: that exactly one subject is named, and what the reply's numbers MEAN.
            "Roll a loot table in the running game and report what comes out — what push_data and "
                + "query_registry cannot answer (they check a table PARSED and LOADED, not what it "
                + "produces). Name exactly ONE subject: `table`, `block`, `entity`, or `at` alone, which "
                + "means the block actually there. `tool` takes vanilla item syntax, so Fortune/Silk Touch "
                + "ride through: minecraft:diamond_pickaxe[minecraft:enchantments={'minecraft:fortune':3}]; "
                + "`killer` fills the attacker slots, which killed_by_player drops need. `count` rolls "
                + "repeatedly and aggregates — per item `share` (fraction of rolls producing it) and `avg` "
                + "(per roll, counting empty ones) are what say whether a drop rate is right — and `seed` "
                + "makes the run reproducible, its first roll being exactly what the game rolls for that "
                + "loot-table seed. Reports the table's `param_set` and the parameters supplied; a table "
                + "asked in a context its own set forbids is refused by name rather than rolled empty, and "
                + "an unknown table answers exists:false. Changes nothing — it never touches the level's "
                + "own loot randomness.",
            Schemas.objectOpt(
                Schemas.object(
                    "table", Schemas.str("Loot table id, e.g. minecraft:chests/simple_dungeon."),
                    "block", Schemas.str("Block id or `id[state]`; rolls that block's table."),
                    "entity", Schemas.str("Entity type id; rolls its death drops."),
                    "at", Schemas.vec3i("Origin; ALONE it means the block there."),
                    "tool", Schemas.str("Item, vanilla syntax with [components]."),
                    "killer", Schemas.str("Attacker entity type id, or `player`."),
                    "count", Schemas.integer("Rolls to aggregate (default 1, max 10000)."),
                    "seed", Schemas.integer("Base seed for the run."),
                    "luck", Schemas.number("Luck parameter."),
                    "dimension", Schemas.str("Dimension id (default overworld).")),
                "table", "block", "entity", "at", "tool", "killer", "count", "seed", "luck", "dimension"),
            ExecutionContext.SERVER,
            Mechanism.OBSERVE,
            (ctx, a) -> roll(ctx.serverOrThrow(), a)));
    }

    // ------------------------------------------------------------------ the call

    private static JsonObject roll(final MinecraftServer server, final JsonObject a) {
        ServerLevel level = WorldPerceptionTools.levelArg(server, a);
        Subject subject = resolveSubject(server, level, a);

        JsonObject out = new JsonObject();
        out.addProperty("subject", subject.kind);
        if (subject.tableId != null) {
            out.addProperty("table", subject.tableId.toString());
        }
        if (subject.note != null) {
            out.addProperty("note", subject.note);
        }
        if (subject.tableId == null) {
            // A block or entity that declares NO table. Not a miss and not an empty roll: the thing has
            // no loot data at all, which is a different fact from "its table produced nothing".
            out.addProperty("exists", false);
            return out;
        }

        ResourceKey<LootTable> key = ResourceKey.create(Registries.LOOT_TABLE, subject.tableId);
        Optional<? extends net.minecraft.core.HolderLookup.RegistryLookup<LootTable>> lookup =
            server.reloadableRegistries().lookup().lookup(Registries.LOOT_TABLE);
        boolean exists = lookup.isPresent() && lookup.get().get(key).isPresent();
        out.addProperty("exists", exists);
        if (!exists) {
            out.addProperty("hint", "no such loot table — query_registry {registry:\"loot_table\", "
                + "contains:\"...\"} lists what the server actually loaded.");
            return out;
        }
        LootTable table = server.reloadableRegistries().getLootTable(key);

        ContextKeySet paramSet = table.getParamSet();
        out.addProperty("param_set", paramSetId(paramSet));
        out.add("origin", vec(subject.origin));

        LootParams params = buildParams(level, paramSet, subject, a, out);

        int count = countArg(a);
        long seed = a.has("seed") && !a.get("seed").isJsonNull()
            ? a.get("seed").getAsLong()
            : level.getRandom().nextLong();
        out.addProperty("rolls", count);
        out.addProperty("seed", seed);

        // ONE source for the whole run, and that is a correctness fix rather than a tidy-up. The first
        // draft seeded each roll separately with `seed + i`, which is a legacy LCG asked for its FIRST
        // draw from adjacent seeds — those draws are strongly correlated, and the probe caught it in the
        // most direct way available: a pool with `random_chance: 0.5` fired ZERO times in 200 rolls. An
        // aggregate produced that way is not a weak measurement, it is a wrong one, and a modder reading
        // a drop rate off it would tune against noise. Drawing every roll from one continuing stream is
        // both correct and still reproducible from `seed` — and roll 0 is byte-for-byte what vanilla
        // produces for that loot-table seed, since LootContext's own withOptionalRandomSeed is exactly
        // RandomSource.create(seed).
        RandomSource random = RandomSource.create(seed);
        Map<String, Agg> byId = new LinkedHashMap<>();
        int empty = 0;
        for (int i = 0; i < count; i++) {
            // An explicit RandomSource: see the class note — the no-random path advances the LEVEL's
            // persistent loot sequence, which would make this read a world write.
            List<ItemStack> stacks = table.getRandomItems(params, random);
            boolean any = false;
            for (ItemStack stack : stacks) {
                if (stack.isEmpty()) {
                    continue;
                }
                any = true;
                byId.computeIfAbsent(itemId(stack), id -> new Agg()).add(stack, i);
            }
            if (!any) {
                empty++;
            }
        }
        out.addProperty("empty_rolls", empty);
        out.addProperty("distinct", byId.size());
        out.add("items", renderItems(server, byId, count));
        return out;
    }

    // ------------------------------------------------------------------ subject

    /** What is being rolled, plus everything the roll needs that the subject itself decides. */
    private static final class Subject {
        String kind = "table";
        @Nullable Identifier tableId;
        @Nullable BlockState blockState;
        @Nullable BlockEntity blockEntity;
        @Nullable Entity entity;
        @Nullable String note;
        Vec3 origin = Vec3.ZERO;
    }

    private static Subject resolveSubject(
            final MinecraftServer server, final ServerLevel level, final JsonObject a) {
        String table = str(a, "table");
        String block = str(a, "block");
        String entity = str(a, "entity");
        boolean hasAt = a.has("at") && a.get("at").isJsonObject();

        int named = (table != null ? 1 : 0) + (block != null ? 1 : 0) + (entity != null ? 1 : 0);
        if (named > 1) {
            throw new IllegalArgumentException("name ONE subject — `table`, `block` and `entity` are three "
                + "different things to roll. Drop all but one.");
        }
        if (named == 0 && !hasAt) {
            throw new IllegalArgumentException("nothing to roll — give `table`, `block`, `entity`, or `at` "
                + "(which rolls the block at that position).");
        }

        Subject s = new Subject();
        s.origin = hasAt
            ? Vec3.atCenterOf(pos(a))
            : Vec3.atCenterOf(level.getLevelData().getRespawnData().pos());
        if (!hasAt) {
            s.note = "no `at`: origin defaulted to world spawn, so position-sensitive conditions "
                + "(location_check, biome) are judged there.";
        }

        if (table != null) {
            s.kind = "table";
            s.tableId = parseId(table);
            return s;
        }
        if (block != null) {
            s.kind = "block";
            s.blockState = BlockTools.parseState(server, block);
            s.tableId = lootTableOf(s.blockState);
            if (s.tableId == null) {
                s.note = block + " declares no loot table, so it drops nothing by definition — there is "
                    + "no table to roll.";
            }
            return s;
        }
        if (entity != null) {
            s.kind = "entity";
            s.entity = createEntity(level, entity, s.origin);
            s.tableId = entityLootTable(s.entity);
            s.note = s.tableId == null
                ? entity + " declares no loot table, so it drops nothing by definition."
                : "the entity is freshly created and NOT finalized (no spawn equipment, default "
                    + "variant/age), so conditions reading its state see defaults.";
            return s;
        }

        // `at` alone: the block actually there, with its block entity.
        s.kind = "block_at";
        BlockPos p = pos(a);
        if (!level.isLoaded(p)) {
            throw new IllegalArgumentException("chunk at " + p.toShortString() + " is not loaded, so the "
                + "block there cannot be read. Name the block by id instead, or load the chunk.");
        }
        s.blockState = level.getBlockState(p);
        s.blockEntity = level.getBlockEntity(p);
        s.tableId = lootTableOf(s.blockState);
        s.note = "rolled the block actually at " + p.toShortString() + ": "
            + net.minecraft.commands.arguments.blocks.BlockStateParser.serialize(s.blockState);
        if (s.tableId == null) {
            s.note += " — which declares no loot table, so it drops nothing by definition.";
        }
        return s;
    }

    private static @Nullable Identifier lootTableOf(final BlockState state) {
        return state.getBlock().getLootTable().map(ResourceKey::identifier).orElse(null);
    }

    private static @Nullable Identifier entityLootTable(final Entity entity) {
        Optional<ResourceKey<LootTable>> key = entity instanceof LivingEntity living
            ? living.getLootTable()
            : entity.getType().getDefaultLootTable();
        return key.map(ResourceKey::identifier).orElse(null);
    }

    private static Entity createEntity(final ServerLevel level, final String spec, final Vec3 origin) {
        Identifier id = parseId(spec);
        EntityType<?> type = BuiltInRegistries.ENTITY_TYPE.get(id)
            .map(net.minecraft.core.Holder::value)
            .orElseThrow(() -> new IllegalArgumentException("no such entity type '" + id + "' — "
                + "query_registry {registry:\"entity_type\"} lists what is registered."));
        Entity e = type.create(level, EntitySpawnReason.COMMAND);
        if (e == null) {
            throw new IllegalArgumentException(id + " cannot be created standalone (players and some "
                + "internal types refuse), so its death drops cannot be rolled this way.");
        }
        e.snapTo(origin.x, origin.y, origin.z, 0.0F, 0.0F);
        return e;
    }

    // ------------------------------------------------------------------ parameters

    /**
     * Offer every parameter this call can construct, keep the ones the TABLE's own set allows, and let
     * vanilla judge the result. The refusal path is the valuable one: a table asked in a context it was
     * never written for is the commonest way a roll comes back empty for a reason that is not the table.
     */
    private static LootParams buildParams(
            final ServerLevel level, final ContextKeySet paramSet, final Subject subject,
            final JsonObject a, final JsonObject out) {
        ItemStack tool = toolArg(level, a);
        Entity killer = killerArg(level, a, subject.origin);

        List<Offer> offers = new ArrayList<>();
        offers.add(new Offer(LootContextParams.ORIGIN, subject.origin));
        offers.add(new Offer(LootContextParams.TOOL, tool));
        if (subject.blockState != null) {
            offers.add(new Offer(LootContextParams.BLOCK_STATE, subject.blockState));
        }
        if (subject.blockEntity != null) {
            offers.add(new Offer(LootContextParams.BLOCK_ENTITY, subject.blockEntity));
        }
        if (subject.entity != null) {
            offers.add(new Offer(LootContextParams.THIS_ENTITY, subject.entity));
            offers.add(new Offer(LootContextParams.DAMAGE_SOURCE, subject.entity.damageSources().magic()));
        }
        if (killer != null) {
            offers.add(new Offer(LootContextParams.ATTACKING_ENTITY, killer));
            offers.add(new Offer(LootContextParams.DIRECT_ATTACKING_ENTITY, killer));
            if (killer instanceof Player player) {
                offers.add(new Offer(LootContextParams.LAST_DAMAGE_PLAYER, player));
            }
        }

        LootParams.Builder builder = new LootParams.Builder(level);
        JsonArray supplied = new JsonArray();
        for (Offer offer : offers) {
            if (paramSet.allowed().contains(offer.key())) {
                offer.apply(builder);
                supplied.add(offer.key().name().toString());
            }
        }
        out.add("supplied", supplied);
        if (a.has("luck") && !a.get("luck").isJsonNull()) {
            builder.withLuck(a.get("luck").getAsFloat());
        }

        try {
            return builder.create(paramSet);
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException(missingParamsMessage(paramSet, offers, e));
        }
    }

    /**
     * Name the gap the way the caller can close it: which keys the table's own set requires, which of
     * them this call could have supplied and with what argument, and which it cannot supply at all.
     */
    private static String missingParamsMessage(
            final ContextKeySet paramSet, final List<Offer> offers, final IllegalArgumentException cause) {
        List<String> fixable = new ArrayList<>();
        List<String> unreachable = new ArrayList<>();
        for (ContextKey<?> key : paramSet.required()) {
            if (offers.stream().anyMatch(o -> o.key() == key)) {
                continue;
            }
            String arg = ARG_FOR.get(key.name().toString());
            if (arg != null) {
                fixable.add(key.name().getPath() + " (give `" + arg + "`)");
            } else {
                unreachable.add(key.name().getPath());
            }
        }
        StringBuilder sb = new StringBuilder("this table's parameter set is ").append(paramSet)
            .append(" and the call cannot satisfy it: ").append(cause.getMessage());
        if (!fixable.isEmpty()) {
            sb.append(". Supply: ").append(String.join(", ", fixable));
        }
        if (!unreachable.isEmpty()) {
            sb.append(". roll_loot cannot supply: ").append(String.join(", ", unreachable))
                .append(" — this table is written for a context that needs a live event, not a probe.");
        }
        return sb.toString();
    }

    /** Which argument would supply a required parameter. Used only to write the refusal. */
    private static final Map<String, String> ARG_FOR = Map.of(
        "minecraft:origin", "at",
        "minecraft:tool", "tool",
        "minecraft:block_state", "block",
        "minecraft:this_entity", "entity",
        "minecraft:damage_source", "entity",
        "minecraft:attacking_entity", "killer",
        "minecraft:direct_attacking_entity", "killer",
        "minecraft:last_damage_player", "killer");

    /** One offered parameter, kept whole so the unchecked cast lives in exactly one place. */
    private record Offer(ContextKey<?> key, Object value) {
        @SuppressWarnings("unchecked")
        void apply(final LootParams.Builder builder) {
            builder.withParameter((ContextKey<Object>) key, value);
        }
    }

    private static ItemStack toolArg(final ServerLevel level, final JsonObject a) {
        String spec = str(a, "tool");
        if (spec == null) {
            return ItemStack.EMPTY;
        }
        return ItemSyntax.parse(level.registryAccess(), "tool", spec, 1);
    }

    private static @Nullable Entity killerArg(
            final ServerLevel level, final JsonObject a, final Vec3 origin) {
        String spec = str(a, "killer");
        if (spec == null) {
            return null;
        }
        if (spec.equals("player") || spec.equals("minecraft:player")) {
            ServerPlayer player =
                level.getServer().getPlayerList().getPlayers().stream().findFirst().orElse(null);
            if (player == null) {
                throw new IllegalArgumentException("`killer:\"player\"` needs a player online to stand in as "
                    + "the attacker, and none is. Attach a client, or name a mob type instead.");
            }
            return player;
        }
        Entity killer = createEntity(level, spec, origin);
        ItemStack tool = toolArg(level, a);
        if (!tool.isEmpty() && killer instanceof LivingEntity living) {
            living.setItemInHand(net.minecraft.world.InteractionHand.MAIN_HAND, tool);
        }
        return killer;
    }

    // ------------------------------------------------------------------ aggregation

    /** Per-item totals across the whole run. */
    private static final class Agg {
        int rollsWith;
        int total;
        int min = Integer.MAX_VALUE;
        int max;
        int lastRoll = -1;
        int perRoll;
        @Nullable DataComponentPatch patch;
        boolean seenOne;
        boolean patchVaries;

        void add(final ItemStack stack, final int roll) {
            if (roll != lastRoll) {
                closeRoll();
                lastRoll = roll;
                perRoll = 0;
                rollsWith++;
            }
            perRoll += stack.getCount();
            total += stack.getCount();
            // Components are reported only when EVERY stack of this id carried the same ones, so the
            // field is a property of the drop rather than a sample of one roll that happened to be first.
            DataComponentPatch p = stack.getComponentsPatch();
            if (!seenOne) {
                patch = p;
                seenOne = true;
            } else if (!patchVaries && !p.equals(patch)) {
                patchVaries = true;
            }
        }

        /** Close the roll in progress. Idempotent before the first one, so the caller need not check. */
        void closeRoll() {
            if (lastRoll < 0) {
                return;
            }
            min = Math.min(min, perRoll);
            max = Math.max(max, perRoll);
        }
    }

    private static JsonArray renderItems(
            final MinecraftServer server, final Map<String, Agg> byId, final int rolls) {
        List<Map.Entry<String, Agg>> entries = new ArrayList<>(byId.entrySet());
        entries.forEach(e -> e.getValue().closeRoll());
        entries.sort(Comparator.comparingInt((Map.Entry<String, Agg> e) -> e.getValue().total).reversed());
        JsonArray arr = new JsonArray();
        for (Map.Entry<String, Agg> e : entries) {
            if (arr.size() >= MAX_ITEMS) {
                break;
            }
            Agg agg = e.getValue();
            JsonObject o = new JsonObject();
            o.addProperty("id", e.getKey());
            o.addProperty("rolls_with", agg.rollsWith);
            o.addProperty("share", round(agg.rollsWith / (double) rolls));
            o.addProperty("total", agg.total);
            o.addProperty("avg", round(agg.total / (double) rolls));
            o.addProperty("min", agg.min);
            o.addProperty("max", agg.max);
            if (agg.patchVaries) {
                o.addProperty("components_vary", true);
            } else if (agg.patch != null && !agg.patch.isEmpty()) {
                addPatch(server, o, agg.patch);
            }
            arr.add(o);
        }
        return arr;
    }

    private static void addPatch(
            final MinecraftServer server, final JsonObject out, final DataComponentPatch patch) {
        RegistryOps<JsonElement> ops = RegistryOps.create(JsonOps.INSTANCE, server.registryAccess());
        DataResult<JsonElement> result = DataComponentPatch.CODEC.encodeStart(ops, patch);
        result.result().ifPresent(json -> out.add("components", json));
    }

    // ------------------------------------------------------------------ small parsing

    private static int countArg(final JsonObject a) {
        if (!a.has("count") || a.get("count").isJsonNull()) {
            return 1;
        }
        int n = a.get("count").getAsInt();
        if (n < 1 || n > MAX_ROLLS) {
            throw new IllegalArgumentException("`count` must be 1.." + MAX_ROLLS + " (got " + n + ")");
        }
        return n;
    }

    /** Ask the game what this parameter set is called rather than keeping a second table of the names. */
    private static String paramSetId(final ContextKeySet paramSet) {
        return LootContextParamSets.CODEC.encodeStart(JsonOps.INSTANCE, paramSet)
            .result().map(JsonElement::getAsString).orElse(paramSet.toString());
    }

    private static String itemId(final ItemStack stack) {
        return BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
    }

    private static BlockPos pos(final JsonObject a) {
        JsonObject o = a.getAsJsonObject("at");
        return new BlockPos(o.get("x").getAsInt(), o.get("y").getAsInt(), o.get("z").getAsInt());
    }

    private static JsonObject vec(final Vec3 v) {
        JsonObject o = new JsonObject();
        o.addProperty("x", v.x);
        o.addProperty("y", v.y);
        o.addProperty("z", v.z);
        return o;
    }

    private static Identifier parseId(final String spec) {
        try {
            return spec.contains(":") ? Identifier.parse(spec) : Identifier.withDefaultNamespace(spec);
        } catch (RuntimeException e) {
            throw new IllegalArgumentException("bad id '" + spec + "': " + e.getMessage());
        }
    }

    private static @Nullable String str(final JsonObject a, final String key) {
        return a.has(key) && !a.get(key).isJsonNull() ? a.get(key).getAsString() : null;
    }

    private static double round(final double v) {
        return Math.round(v * 10_000.0) / 10_000.0;
    }
}
