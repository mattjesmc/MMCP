package com.mattmc.mcptoolkit;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.mojang.serialization.Codec;
import com.mojang.serialization.DataResult;
import com.mojang.serialization.JsonOps;
import net.minecraft.core.Holder;
import net.minecraft.core.HolderLookup;
import net.minecraft.core.HolderSet;
import net.minecraft.core.Registry;
import net.minecraft.core.component.DataComponentMap;
import net.minecraft.resources.Identifier;
import net.minecraft.resources.RegistryDataLoader;
import net.minecraft.resources.RegistryOps;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.MinecraftServer;
import net.minecraft.tags.TagKey;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.crafting.Recipe;
import net.minecraft.world.item.crafting.RecipeHolder;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.Property;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.stream.Collectors;

/**
 * Registry introspection: ground authoring in what the running game actually has registered instead of
 * guessing ids from memory. {@code query_registry} lists the ids in any registry (blocks, items, entity
 * types, professions, POI types, biomes, structures, …), with substring/namespace/tag filtering, and
 * specially handles two pseudo-registries — {@code structure_template} (the loadable templates, which is
 * what {@code import_building} consumes) and {@code recipe} (what the {@code RecipeManager} loaded, which
 * is not a registry in {@code registryAccess} at all). Call with no {@code registry} to list the available
 * registry names.
 *
 * <p><b>It also reaches the RELOADABLE layer</b> — {@code loot_table}, {@code predicate},
 * {@code item_modifier} (0.101.0). Those ARE registries and their ids are the ones a modder writes,
 * but {@code MinecraftServer.registries} is the world stem's layers and its {@code RELOADABLE} layer
 * stays empty; the loaded three live on {@code reloadableRegistries()}, so the composite lookup misses
 * every one of them and "did my loot table load?" had no route at all. Listing, tags, tag filtering and
 * {@code entry}+codec JSON all work there unchanged ({@code LootDataType} supplies the three codecs).
 * The capability cost nothing in the manifest, because a registry id is what this description already
 * tells a caller to pass.
 *
 * <p><b>The detail half (RELEASE_1.md §D2) rides inside the same tool</b> rather than taking new manifest
 * lines, per {@code TOKEN_PER_TOOL_FINDINGS.md} finding 6: {@code entry} reports on ONE id, {@code tag}
 * filters a listing to a tag's members, and {@code tags:true} lists the registry's tag ids instead of its
 * entries. All four questions a modder actually asks — what tags is this in, what is in {@code #c:ores},
 * what properties does this block have, did my recipe load — are the same question this tool already
 * answers, asked about one thing instead of all of them.
 *
 * <p><b>Two honesty rules the shape exists to keep.</b> (1) A tag that failed to load and a tag that is
 * empty are indistinguishable from their member list, so {@code tag_exists} is reported separately —
 * {@link Registry#get(TagKey)} is empty for an unbound tag, and an empty {@code ids} array with no such
 * flag would read as "your tag loaded and matched nothing". (2) An {@code entry} that is not registered
 * answers {@code exists:false} rather than throwing, because "is my thing registered" is the question,
 * not a malformed call — an unknown REGISTRY still throws, since that is a typo in the question itself.
 *
 * <p><b>Datapack entries are rendered by the game's own codec</b> ({@link RegistryDataLoader}'s element
 * codecs, which is where a biome/feature/structure JSON is decoded in the first place), so there is no
 * second reading of those files in this repo to drift from the one that loaded them.
 */
public final class RegistryTools {
    private RegistryTools() {}

    private static final int DEFAULT_LIMIT = 200;
    private static final int MAX_LIMIT = 5000;
    /**
     * Character cap on an inlined codec dump. A configured feature or a big biome can encode to tens of
     * kilobytes, and a truncated JSON is worse than none — it reads as data and parses as nothing. Over
     * the cap the reply carries the SIZE and says the dump was omitted.
     */
    private static final int MAX_JSON_CHARS = 20_000;

    /** Aliases that mean "the structure template pool" rather than a game registry. */
    private static final List<String> TEMPLATE_ALIASES =
        List.of("structure_template", "structure_templates", "templates", "template");
    /**
     * Aliases for the loaded recipes. Recipes are NOT in {@code registryAccess()} — they live in the
     * {@link net.minecraft.world.item.crafting.RecipeManager}, reloaded with the datapacks — so they need
     * the same pseudo-registry route the templates take.
     */
    private static final List<String> RECIPE_ALIASES =
        List.of("recipe", "recipes", "minecraft:recipe");

    public static void register() {
        McpTools.register(ToolDef.of(
            "query_registry",
            "List the ids registered in a game registry, so you can pick valid block/item/entity/profession/etc. "
                + "ids instead of guessing. `registry` is a registry id or short name: block, item, entity_type, "
                + "villager_profession, point_of_interest_type, biome, structure, mob_effect, sound_event, … "
                + "plus two pseudo-registries — `structure_template` (loadable templates, what import_building "
                + "takes) and `recipe` (what the server LOADED, so a pushed recipe can be checked). `contains`, "
                + "`namespace`, `tag` and `limit` filter the listing; a missing tag is reported as "
                + "`tag_exists:false` rather than as an empty one. `entry` answers about ONE id instead: the "
                + "tags it is in, plus block properties + default state, item stack size + default components, "
                + "entity size/category, or the entry's own JSON as the game decoded it (recipes, biomes, "
                + "features, …). An unregistered id answers `exists:false`; an unknown registry is refused. "
                + "Call with no `registry` to list the registry names. Returns {registry, total, returned, "
                + "truncated, ids}.",
            Schemas.objectOpt(
                Schemas.object(
                    "registry", Schemas.str("Registry id/short name, or `structure_template`/`recipe`."),
                    "entry", Schemas.str("Report on this one id instead of listing."),
                    "tag", Schemas.str("Only this tag's members. `c:ores` or `#c:ores`."),
                    "tags", Schemas.bool("List the registry's tag ids instead of its entries."),
                    "contains", Schemas.str("Case-insensitive substring filter on the id."),
                    "namespace", Schemas.str("Exact namespace filter, e.g. minecraft."),
                    "limit", Schemas.integer("Max ids to return (default 200, max 5000).")),
                "registry", "entry", "tag", "tags", "contains", "namespace", "limit"),
            ExecutionContext.SERVER,
            Mechanism.OBSERVE,
            (ctx, a) -> query(ctx.serverOrThrow(), a)));
    }

    private static JsonObject query(final MinecraftServer server, final JsonObject a) {
        String registry = optString(a, "registry");
        if (registry == null || registry.isBlank()) {
            return listRegistries(server);
        }
        String reg = registry.toLowerCase(Locale.ROOT);
        String entry = optString(a, "entry");
        rejectDeadArgs(a, entry);
        if (TEMPLATE_ALIASES.contains(reg)) {
            rejectTagArgs(a, "structure_template");
            return entry != null ? templateEntry(server, entry) : templateListing(server, a);
        }
        if (RECIPE_ALIASES.contains(reg)) {
            rejectTagArgs(a, "recipe");
            return entry != null ? recipeEntry(server, entry) : recipeListing(server, a);
        }

        Identifier regId = reg.contains(":") ? Identifier.parse(reg) : Identifier.parse("minecraft:" + reg);
        ResourceKey<? extends Registry<Object>> key = ResourceKey.createRegistryKey(regId);
        Optional<Registry<Object>> maybe = server.registryAccess().lookup(key);
        if (maybe.isEmpty()) {
            // The RELOADABLE layer — loot_table, predicate, item_modifier. These ARE registries and their
            // ids are the ones a modder writes, but they live on `reloadableRegistries()` rather than in
            // `registryAccess()`'s composite (MinecraftServer.registries is the world stem's layers, whose
            // RELOADABLE layer stays empty), so the lookup above misses every one of them. Same reason
            // `recipe` needed a route; unlike recipes these are tagged, so the whole listing/tag/entry
            // surface applies unchanged.
            Optional<? extends HolderLookup.RegistryLookup<Object>> reloadable =
                server.reloadableRegistries().lookup().lookup(key);
            if (reloadable.isPresent()) {
                return reloadableQuery(server, reloadable.get(), key, regId.toString(), a, entry);
            }
            throw new IllegalArgumentException("no such registry '" + registry
                + "' — call query_registry with no `registry` to list the valid names.");
        }
        Registry<Object> r = maybe.get();
        String resolvedName = regId.toString();

        if (entry != null) {
            return entryDetail(server, r, resolvedName, entry);
        }
        if (a.has("tags") && !a.get("tags").isJsonNull() && a.get("tags").getAsBoolean()) {
            List<String> all = filtered(r.listTagIds().map(t -> t.location().toString()), a);
            JsonObject out = page(all, limit(a));
            out.addProperty("registry", resolvedName);
            out.add("tags", out.remove("ids"));
            return out;
        }

        String tag = optString(a, "tag");
        java.util.stream.Stream<String> ids;
        boolean tagExists = false;
        if (tag != null) {
            TagKey<Object> tagKey = TagKey.create(key, parseTagId(tag));
            Optional<HolderSet.Named<Object>> named = r.get(tagKey);
            tagExists = named.isPresent();
            ids = named.<java.util.stream.Stream<String>>map(
                    n -> n.stream().map(RegistryTools::idOf).filter(java.util.Objects::nonNull))
                .orElseGet(java.util.stream.Stream::of);
        } else {
            ids = r.keySet().stream().map(Identifier::toString);
        }

        JsonObject out = page(filtered(ids, a), limit(a));
        out.addProperty("registry", resolvedName);
        if (tag != null) {
            out.addProperty("tag", parseTagId(tag).toString());
            out.addProperty("tag_exists", tagExists);
        }
        return out;
    }

    /**
     * An argument that this call's MODE cannot use is a refusal, not a shrug — the same rule
     * {@link ArgCheck} enforces for arguments the TOOL does not have. {@code entry} answers about one id
     * and cannot filter; {@code tags:true} lists tag ids and has no tag to filter by. Silently dropping
     * either would answer a different question than the one asked and read back as agreement.
     */
    private static void rejectDeadArgs(final JsonObject a, final String entry) {
        boolean tagsFlag = a.has("tags") && !a.get("tags").isJsonNull() && a.get("tags").getAsBoolean();
        if (entry != null) {
            for (String dead : List.of("tag", "tags", "contains", "namespace", "limit")) {
                if (a.has(dead) && !a.get(dead).isJsonNull()) {
                    throw new IllegalArgumentException("`" + dead + "` does not apply with `entry` — `entry` "
                        + "reports on one id, it does not filter a listing. Drop one of the two.");
                }
            }
        } else if (tagsFlag && a.has("tag") && !a.get("tag").isJsonNull()) {
            throw new IllegalArgumentException("`tag` does not apply with `tags:true` — `tags:true` LISTS the "
                + "tag ids, `tag` filters entries to one tag's members. Drop one of the two.");
        }
    }

    /**
     * Neither pseudo-registry is tagged — templates are files on disk and recipes live outside
     * {@code registryAccess} — so a tag argument here can only ever be a wrong belief about the pool.
     */
    private static void rejectTagArgs(final JsonObject a, final String pool) {
        for (String dead : List.of("tag", "tags")) {
            if (a.has(dead) && !a.get(dead).isJsonNull()) {
                throw new IllegalArgumentException("`" + dead + "` does not apply to `" + pool
                    + "` — it is not a tagged registry.");
            }
        }
    }

    // ------------------------------------------------------------------ one entry

    private static JsonObject entryDetail(
            final MinecraftServer server, final Registry<Object> r, final String resolvedName, final String entry) {
        return holderDetail(server, resolvedName, parseId(entry), r.get(parseId(entry)), r.key());
    }

    /**
     * The entry view, over a {@link Holder.Reference} rather than a {@link Registry} — because the
     * reloadable layer serves {@link HolderLookup.RegistryLookup}s, which are not registries, and a
     * loot table has exactly the same four things to say about it as a biome does.
     */
    private static JsonObject holderDetail(
            final MinecraftServer server, final String resolvedName, final Identifier id,
            final Optional<Holder.Reference<Object>> ref, final ResourceKey<? extends Registry<?>> regKey) {
        JsonObject out = new JsonObject();
        out.addProperty("registry", resolvedName);
        out.addProperty("id", id.toString());
        out.addProperty("exists", ref.isPresent());
        if (ref.isEmpty()) {
            return out;
        }
        Holder.Reference<Object> holder = ref.get();
        JsonArray tags = new JsonArray();
        holder.tags().map(t -> t.location().toString()).sorted().forEach(tags::add);
        out.add("tags", tags);

        Object value = holder.value();
        switch (value) {
            case Block block -> describeBlock(out, block);
            case Item item -> describeItem(server, out, item);
            case EntityType<?> type -> describeEntityType(out, type);
            default -> {
                Codec<Object> codec = elementCodec(regKey);
                if (codec != null) {
                    addJson(out, "json", codec, value, server);
                } else {
                    // Never an empty answer: an entry with no typed view and no datapack codec still has
                    // an implementing class, which is what "what did this actually register as" means for
                    // a code-defined registry the toolkit has no special reading of.
                    out.addProperty("class", value.getClass().getName());
                }
            }
        }
        return out;
    }

    private static void describeBlock(final JsonObject out, final Block block) {
        BlockState def = block.defaultBlockState();
        JsonObject props = new JsonObject();
        for (Property<?> p : block.getStateDefinition().getProperties()) {
            JsonArray values = new JsonArray();
            p.getPossibleValues().stream().map(v -> name(p, v)).sorted().forEach(values::add);
            props.add(p.getName(), values);
        }
        out.add("properties", props);
        // set_blocks syntax, so a read round-trips into a write.
        out.addProperty("default_state", stateString(block, def));
        Item item = block.asItem();
        if (item != net.minecraft.world.item.Items.AIR) {
            out.addProperty("item", BuiltInIds.item(item));
        }
    }

    private static void describeItem(final MinecraftServer server, final JsonObject out, final Item item) {
        out.addProperty("max_stack_size", item.getDefaultMaxStackSize());
        if (item instanceof BlockItem blockItem) {
            out.addProperty("block", BuiltInIds.block(blockItem.getBlock()));
        }
        addJson(out, "components", DataComponentMap.CODEC, item.components(), server);
    }

    private static void describeEntityType(final JsonObject out, final EntityType<?> type) {
        out.addProperty("width", type.getWidth());
        out.addProperty("height", type.getHeight());
        out.addProperty("category", type.getCategory().getName());
        out.addProperty("summonable", type.canSummon());
    }

    // ------------------------------------------------------------------ pseudo-registries

    private static JsonObject templateListing(final MinecraftServer server, final JsonObject a) {
        List<String> all = filtered(server.getStructureManager().listTemplates().map(Identifier::toString), a);
        JsonObject out = page(all, limit(a));
        out.addProperty("registry", "structure_template");
        return out;
    }

    private static JsonObject templateEntry(final MinecraftServer server, final String entry) {
        Identifier id = parseId(entry);
        JsonObject out = new JsonObject();
        out.addProperty("registry", "structure_template");
        out.addProperty("id", id.toString());
        Optional<net.minecraft.world.level.levelgen.structure.templatesystem.StructureTemplate> t =
            server.getStructureManager().get(id);
        out.addProperty("exists", t.isPresent());
        t.ifPresent(template -> {
            var size = template.getSize();
            JsonObject s = new JsonObject();
            s.addProperty("x", size.getX());
            s.addProperty("y", size.getY());
            s.addProperty("z", size.getZ());
            out.add("size", s);
        });
        return out;
    }

    // ------------------------------------------------------------------ the reloadable layer

    /**
     * The same four questions as the main path, asked of a {@link HolderLookup.RegistryLookup}. Split
     * from {@link #query} only because the reloadable layer hands out lookups instead of registries;
     * every rule above it — {@code entry} answers {@code exists:false}, a missing tag is
     * {@code tag_exists:false}, a dead argument is refused — holds here unchanged because it is the
     * same code below the branch.
     */
    private static JsonObject reloadableQuery(
            final MinecraftServer server, final HolderLookup.RegistryLookup<Object> lookup,
            final ResourceKey<? extends Registry<Object>> key, final String resolvedName,
            final JsonObject a, final String entry) {
        if (entry != null) {
            Identifier id = parseId(entry);
            return holderDetail(server, resolvedName, id,
                lookup.get(ResourceKey.create(key, id)).map(h -> (Holder.Reference<Object>) h), key);
        }
        if (a.has("tags") && !a.get("tags").isJsonNull() && a.get("tags").getAsBoolean()) {
            JsonObject out = page(filtered(lookup.listTagIds().map(t -> t.location().toString()), a), limit(a));
            out.addProperty("registry", resolvedName);
            out.add("tags", out.remove("ids"));
            return out;
        }
        String tag = optString(a, "tag");
        java.util.stream.Stream<String> ids;
        boolean tagExists = false;
        if (tag != null) {
            Optional<HolderSet.Named<Object>> named = lookup.get(TagKey.create(key, parseTagId(tag)));
            tagExists = named.isPresent();
            ids = named.<java.util.stream.Stream<String>>map(
                    n -> n.stream().map(RegistryTools::idOf).filter(java.util.Objects::nonNull))
                .orElseGet(java.util.stream.Stream::of);
        } else {
            ids = lookup.listElementIds().map(k -> k.identifier().toString());
        }
        JsonObject out = page(filtered(ids, a), limit(a));
        out.addProperty("registry", resolvedName);
        if (tag != null) {
            out.addProperty("tag", parseTagId(tag).toString());
            out.addProperty("tag_exists", tagExists);
        }
        return out;
    }

    private static JsonObject recipeListing(final MinecraftServer server, final JsonObject a) {
        List<String> all = filtered(
            server.getRecipeManager().getRecipes().stream().map(h -> h.id().identifier().toString()), a);
        JsonObject out = page(all, limit(a));
        out.addProperty("registry", "recipe");
        return out;
    }

    private static JsonObject recipeEntry(final MinecraftServer server, final String entry) {
        Identifier id = parseId(entry);
        JsonObject out = new JsonObject();
        out.addProperty("registry", "recipe");
        out.addProperty("id", id.toString());
        RecipeHolder<?> found = null;
        for (RecipeHolder<?> h : server.getRecipeManager().getRecipes()) {
            if (h.id().identifier().equals(id)) {
                found = h;
                break;
            }
        }
        out.addProperty("exists", found != null);
        if (found == null) {
            return out;
        }
        Recipe<?> recipe = found.value();
        // NOT `type`, and the difference bit on this file's first live run. A recipe FILE's `type:`
        // field is dispatched on RECIPE_SERIALIZER (`Recipe.CODEC`), so the id a modder wrote is
        // `minecraft:crafting_shapeless` — while `Recipe.getType()` is the RECIPE_TYPE, which is
        // `minecraft:crafting`, i.e. WHICH STATION crafts it. Both are useful and they are not the
        // same registry; calling this one `type` would have handed back a word the caller's own file
        // uses for the other thing. The serializer id needs no field of its own: it is `json.type`.
        Identifier type = net.minecraft.core.registries.BuiltInRegistries.RECIPE_TYPE.getKey(recipe.getType());
        if (type != null) {
            out.addProperty("recipe_type", type.toString());
        }
        if (!recipe.group().isEmpty()) {
            out.addProperty("group", recipe.group());
        }
        // The recipe as the game re-encodes it: what actually loaded, not what the file said.
        addJson(out, "json", Recipe.CODEC, recipe, server);
        return out;
    }

    // ------------------------------------------------------------------ shared

    private static JsonObject listRegistries(final MinecraftServer server) {
        // The reloadable three are named here or they are invisible: a caller who cannot see
        // `loot_table` in this list has no way to learn the route exists (finding 6's corollary — the
        // only channel by which a capability is discovered is the one that names it).
        List<String> names = java.util.stream.Stream.concat(
                server.registryAccess().listRegistryKeys(),
                net.minecraft.world.level.storage.loot.LootDataType.values()
                    .map(t -> (ResourceKey<? extends Registry<?>>) t.registryKey()))
            .map(k -> k.identifier().toString())
            .distinct()
            .sorted()
            .collect(Collectors.toList());
        JsonArray arr = new JsonArray();
        arr.add("structure_template");
        arr.add("recipe");
        names.forEach(arr::add);
        JsonObject r = new JsonObject();
        r.addProperty("hint", "pass one of these as `registry` (short name without minecraft: also works)");
        r.addProperty("total", arr.size());
        r.add("registries", arr);
        return r;
    }

    /** Apply the `contains` / `namespace` filters and sort. */
    private static List<String> filtered(final java.util.stream.Stream<String> ids, final JsonObject a) {
        String contains = optString(a, "contains");
        String namespace = optString(a, "namespace");
        String containsLc = contains == null ? null : contains.toLowerCase(Locale.ROOT);
        return ids
            .filter(s -> namespace == null || s.startsWith(namespace + ":"))
            .filter(s -> containsLc == null || s.toLowerCase(Locale.ROOT).contains(containsLc))
            .sorted()
            .collect(Collectors.toList());
    }

    private static JsonObject page(final List<String> all, final int limit) {
        JsonArray out = new JsonArray();
        int returned = Math.min(limit, all.size());
        for (int i = 0; i < returned; i++) {
            out.add(all.get(i));
        }
        JsonObject r = new JsonObject();
        r.addProperty("total", all.size());
        r.addProperty("returned", returned);
        r.addProperty("truncated", returned < all.size());
        r.add("ids", out);
        return r;
    }

    private static int limit(final JsonObject a) {
        return a.has("limit") && !a.get("limit").isJsonNull()
            ? Math.min(MAX_LIMIT, Math.max(1, a.get("limit").getAsInt())) : DEFAULT_LIMIT;
    }

    /**
     * Encode a value with the game's own codec and inline it — or say why it is not there. A codec that
     * refuses is itself an answer (the entry loaded but cannot round-trip), and a dump over
     * {@link #MAX_JSON_CHARS} is reported by size rather than truncated into something that parses as
     * nothing.
     */
    private static <T> void addJson(
            final JsonObject out, final String field, final Codec<T> codec, final T value, final MinecraftServer server) {
        RegistryOps<JsonElement> ops = RegistryOps.create(JsonOps.INSTANCE, server.registryAccess());
        DataResult<JsonElement> result = codec.encodeStart(ops, value);
        Optional<JsonElement> ok = result.result();
        if (ok.isEmpty()) {
            out.addProperty(field + "_error", result.error().map(e -> e.message()).orElse("codec refused"));
            return;
        }
        JsonElement json = ok.get();
        String rendered = json.toString();
        if (rendered.length() > MAX_JSON_CHARS) {
            out.addProperty(field + "_omitted", true);
            out.addProperty(field + "_chars", rendered.length());
            return;
        }
        out.add(field, json);
    }

    /**
     * The element codecs the datapack loader itself uses, keyed by registry. Built once from
     * {@link RegistryDataLoader}'s own lists, so a registry gains a readable {@code json} here exactly
     * when the game gained a way to load it from a file.
     */
    private static Map<ResourceKey<? extends Registry<?>>, Codec<?>> elementCodecs;

    @SuppressWarnings("unchecked")
    private static Codec<Object> elementCodec(final ResourceKey<? extends Registry<?>> key) {
        if (elementCodecs == null) {
            Map<ResourceKey<? extends Registry<?>>, Codec<?>> m = new HashMap<>();
            List<RegistryDataLoader.RegistryData<?>> all = new ArrayList<>();
            all.addAll(RegistryDataLoader.WORLDGEN_REGISTRIES);
            all.addAll(RegistryDataLoader.DIMENSION_REGISTRIES);
            all.addAll(RegistryDataLoader.SYNCHRONIZED_REGISTRIES);
            for (RegistryDataLoader.RegistryData<?> d : all) {
                m.putIfAbsent(d.key(), d.elementCodec());
            }
            // The reloadable layer's three (loot_table, predicate, item_modifier) are loaded by
            // ReloadableServerRegistries, not RegistryDataLoader, so their codecs come from the type
            // that owns them there. Same rule as above: the entry is rendered by the codec that read it.
            net.minecraft.world.level.storage.loot.LootDataType.values()
                .forEach(t -> m.putIfAbsent(t.registryKey(), t.codec()));
            elementCodecs = m;
        }
        return (Codec<Object>) elementCodecs.get(key);
    }

    /** {@code id[state=…]} in set_blocks syntax. */
    private static String stateString(final Block block, final BlockState state) {
        String id = BuiltInIds.block(block);
        var props = state.getProperties();
        if (props.isEmpty()) {
            return id;
        }
        StringBuilder sb = new StringBuilder(id).append('[');
        boolean first = true;
        for (Property<?> p : props) {
            if (!first) {
                sb.append(',');
            }
            first = false;
            sb.append(p.getName()).append('=').append(value(state, p));
        }
        return sb.append(']').toString();
    }

    private static <T extends Comparable<T>> String value(final BlockState state, final Property<T> p) {
        return p.getName(state.getValue(p));
    }

    @SuppressWarnings("unchecked")
    private static <T extends Comparable<T>> String name(final Property<T> p, final Comparable<?> v) {
        return p.getName((T) v);
    }

    private static String idOf(final Holder<Object> holder) {
        return holder.unwrapKey().map(k -> k.identifier().toString()).orElse(null);
    }

    /** A bare id gets the vanilla namespace, matching how `registry` itself is read. */
    private static Identifier parseId(final String s) {
        String t = s.trim();
        return Identifier.parse(t.contains(":") ? t : "minecraft:" + t);
    }

    /** Same, with a leading `#` allowed — that is how a tag is written everywhere else in the game. */
    private static Identifier parseTagId(final String s) {
        String t = s.trim();
        return parseId(t.startsWith("#") ? t.substring(1) : t);
    }

    private static String optString(final JsonObject a, final String key) {
        return a.has(key) && !a.get(key).isJsonNull() ? a.get(key).getAsString() : null;
    }

    /** The two built-in registries this file names by value rather than by key. */
    private static final class BuiltInIds {
        private BuiltInIds() {}

        static String block(final Block b) {
            return net.minecraft.core.registries.BuiltInRegistries.BLOCK.getKey(b).toString();
        }

        static String item(final Item i) {
            return net.minecraft.core.registries.BuiltInRegistries.ITEM.getKey(i).toString();
        }
    }
}
