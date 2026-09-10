package com.mattmc.mcptoolkit;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.mojang.brigadier.CommandDispatcher;
import com.mojang.serialization.Codec;
import com.mojang.serialization.DataResult;
import com.mojang.serialization.DynamicOps;
import com.mojang.serialization.JsonOps;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.commands.functions.CommandFunction;
import net.minecraft.core.HolderLookup;
import net.minecraft.core.Registry;
import net.minecraft.core.registries.Registries;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.NbtAccounter;
import net.minecraft.nbt.NbtIo;
import net.minecraft.resources.Identifier;
import net.minecraft.resources.RegistryDataLoader;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.MinecraftServer;
import net.minecraft.tags.TagEntry;
import net.minecraft.tags.TagFile;
import net.minecraft.util.StrictJsonParser;
import net.minecraft.world.item.crafting.Recipe;
import net.minecraft.world.level.storage.loot.LootDataType;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * <b>Does the game's own loader accept this file?</b> — the read half of {@code push_data}
 * (RELEASE_1.md §E1). Every datapack file the server reads is decoded by a codec the running game is
 * holding right now; this asks that codec the question directly, on the bytes about to be written,
 * without a reload and without a restart.
 *
 * <p><b>Why this is not the same as {@code reload_data}'s {@code problems}.</b> Three reasons, in
 * order of how often they bite.
 * <ol>
 *   <li><b>Worldgen is never reloaded at all.</b> Biomes, features, structures, noise settings,
 *       dimension types — the whole {@code worldgen/} tree plus {@code dimension_type} and friends —
 *       are read once at world load. A reload logs nothing about them because it does not look at
 *       them. Today the only way to find out a biome JSON is malformed is to restart the world; the
 *       codec is loaded and can answer in a millisecond.</li>
 *   <li><b>A batched push has no reload to report from.</b> {@code reload:false} exists so several
 *       files land together, and it is exactly the mode where a typo goes unseen the longest.</li>
 *   <li><b>A directory nothing scans logs nothing.</b> {@code data/ns/tags/blocks/…} (plural) is a
 *       real and common typo — the directory is {@code tags/block} — and it fails by being silently
 *       ignored: no error, no warning, no loaded content. Path→kind resolution catches it, which is
 *       the same silent-failure class {@code query_registry}'s {@code tag_exists} closes one level
 *       up.</li>
 * </ol>
 *
 * <p><b>What "valid" means here, stated rather than implied.</b> It means the loader's own codec
 * decoded these bytes in this game, with this registry contents — so an id from a mod that is not
 * loaded fails here exactly as it would fail there. It does <em>not</em> mean the content is
 * correct, and it does not mean the file will end up in the game: a duplicate id, a pack that is not
 * selected, or a worldgen registry that is only read at world load all still apply. Every reply
 * names the mechanism that answered in {@code checked_by}, so a {@code valid} with
 * {@code checked_by: "none"} cannot be misread as a pass.
 */
public final class DataCodecs {
    private DataCodecs() {}

    /** How many unresolvable ids a tag report lists before it stops. */
    private static final int UNKNOWN_LIMIT = 12;

    /** A loader that scans one pack directory, and the codec it decodes each file with. */
    private record Kind(String dir, ResourceKey<? extends Registry<?>> registry, Codec<?> codec) {}

    /**
     * Every directory under {@code data/&lt;ns&gt;/} a server-side JSON loader scans, longest path
     * first so {@code worldgen/biome} wins over any shorter prefix.
     *
     * <p>The registry-data half is read out of {@link RegistryDataLoader}'s own three lists, exactly
     * as {@code query_registry}'s {@code json} rendering is, so a registry becomes checkable here at
     * the moment the game gains a way to load it from a file. The other five are the loaders that do
     * not go through {@code RegistryDataLoader} — but in 26.2 every one of them is still keyed by a
     * {@code ResourceKey<Registry<…>>} whose path IS its directory, so the same table holds them.
     */
    private static Map<String, Kind> kinds;

    private static synchronized Map<String, Kind> kinds() {
        if (kinds != null) {
            return kinds;
        }
        List<Kind> all = new ArrayList<>();
        List<RegistryDataLoader.RegistryData<?>> data = new ArrayList<>();
        data.addAll(RegistryDataLoader.WORLDGEN_REGISTRIES);
        data.addAll(RegistryDataLoader.DIMENSION_REGISTRIES);
        data.addAll(RegistryDataLoader.SYNCHRONIZED_REGISTRIES);
        for (RegistryDataLoader.RegistryData<?> d : data) {
            all.add(new Kind(Registries.elementsDirPath(d.key()), d.key(), d.elementCodec()));
        }
        // The loaders outside RegistryDataLoader. LootDataType carries its own three (predicate,
        // item_modifier, loot_table) and is asked rather than transcribed.
        LootDataType.values().forEach(t ->
            all.add(new Kind(Registries.elementsDirPath(t.registryKey()), t.registryKey(), t.codec())));
        all.add(new Kind(Registries.elementsDirPath(Registries.RECIPE), Registries.RECIPE, Recipe.CODEC));
        all.add(new Kind(Registries.elementsDirPath(Registries.ADVANCEMENT), Registries.ADVANCEMENT,
            net.minecraft.advancements.Advancement.CODEC));

        Map<String, Kind> m = new LinkedHashMap<>();
        all.sort((a, b) -> b.dir().length() - a.dir().length());
        for (Kind k : all) {
            m.putIfAbsent(k.dir(), k);
        }
        kinds = m;
        return m;
    }

    /**
     * Validate the bytes destined for {@code packRelPath}. Never throws: a file this cannot make
     * sense of comes back with {@code checked_by: "none"} and a note, because a validator that
     * refuses to answer is worse than one that says what it does not know.
     */
    public static JsonObject validate(final MinecraftServer server, final String packRelPath,
                                      final byte[] bytes) {
        JsonObject out = new JsonObject();
        String p = packRelPath.replace('\\', '/');
        while (p.startsWith("./")) {
            p = p.substring(2);
        }
        // pack root → data/<namespace>/<rest>
        if (!p.startsWith("data/")) {
            return none(out, "only files under data/ are datapack content — "
                + "pack.mcmeta and anything else is written as-is and not checked");
        }
        int slash = p.indexOf('/', 5);
        if (slash < 0) {
            return none(out, "expected data/<namespace>/<...>");
        }
        String namespace = p.substring(5, slash);
        String rest = p.substring(slash + 1);

        if (rest.startsWith("structure/") && rest.endsWith(".nbt")) {
            return structure(out, namespace, rest, bytes);
        }
        if (rest.startsWith("function/") && rest.endsWith(".mcfunction")) {
            return function(server, out, namespace, rest, bytes);
        }
        if (!rest.endsWith(".json")) {
            return none(out, "no server-side JSON loader scans data/" + namespace + "/"
                + dirOf(rest) + "/ — the file is written and nothing reads it");
        }

        boolean isTag = rest.startsWith("tags/");
        String lookup = isTag ? rest.substring("tags/".length()) : rest;
        Kind kind = null;
        for (Map.Entry<String, Kind> e : kinds().entrySet()) {
            if (lookup.startsWith(e.getKey() + "/")) {
                kind = e.getValue();
                break;
            }
        }
        if (isTag && kind == null) {
            // A tag directory names a registry rather than a loader, so it covers far more than the
            // datapack-loadable set above: tags/block, tags/item, tags/entity_type … are all real.
            kind = tagRegistryKind(server, lookup);
        }
        if (kind == null) {
            return none(out, "no server-side loader scans data/" + namespace + "/" + dirOf(rest)
                + "/ — the file is written and nothing reads it"
                + (isTag ? " (tag directories are SINGULAR since 1.21: tags/block, not tags/blocks)" : ""));
        }
        out.addProperty("kind", (isTag ? "tags/" : "") + kind.dir());
        String tail = lookup.substring(kind.dir().length() + 1);
        out.addProperty("id", namespace + ":" + tail.substring(0, tail.length() - ".json".length()));
        out.addProperty("checked_by", "codec");

        JsonElement json;
        try {
            json = StrictJsonParser.parse(new String(bytes, StandardCharsets.UTF_8));
        } catch (Exception e) {
            out.addProperty("valid", false);
            out.addProperty("error", "not valid JSON: " + message(e));
            return out;
        }
        if (isTag) {
            return tag(server, out, kind, json);
        }
        DataResult<?> res = kind.codec().parse(ops(server), json);
        return finish(out, res);
    }

    // ---- the kinds ----------------------------------------------------------

    /**
     * The serialization context the loaders themselves use. {@code reloadableRegistries().lookup()}
     * rather than {@code registryAccess()} because it is the strict superset: it layers the
     * datapack-loaded loot tables, predicates and item modifiers over every static and worldgen
     * registry, and a loot table referencing another loot table resolves through it exactly as it
     * does during a reload.
     */
    private static DynamicOps<JsonElement> ops(final MinecraftServer server) {
        HolderLookup.Provider provider = server.reloadableRegistries().lookup();
        return provider.createSerializationContext(JsonOps.INSTANCE);
    }

    /**
     * A tag file names a REGISTRY, not a loader, so its directory is resolved against the live
     * registry set rather than against the loadable-from-file table. {@code tags/block} is legal and
     * {@code block} is not.
     */
    private static Kind tagRegistryKind(final MinecraftServer server, final String lookup) {
        int cut = lookup.lastIndexOf('/');
        while (cut > 0) {
            String dir = lookup.substring(0, cut);
            if (registry(server, dir) != null) {
                ResourceKey<? extends Registry<?>> key =
                    ResourceKey.createRegistryKey(Identifier.withDefaultNamespace(dir));
                return new Kind(dir, key, TagFile.CODEC);
            }
            cut = lookup.lastIndexOf('/', cut - 1);
        }
        return null;
    }

    /** The live registry a directory path names, or null. */
    private static Registry<?> registry(final MinecraftServer server, final String dirPath) {
        ResourceKey<Registry<Object>> key =
            ResourceKey.createRegistryKey(Identifier.withDefaultNamespace(dirPath));
        return server.registryAccess().lookup(key).orElse(null);
    }

    /**
     * A tag decodes, and then its entries are looked up — which is the check worth having.
     * {@code TagFile.CODEC} accepts any well-formed id string, so a typo'd member passes the codec
     * and then vanishes: {@code TagLoader} logs it at bind time and carries on with a tag that is
     * quietly one element short. Entries marked {@code required: false} are the deliberate case and
     * are not reported, and a {@code #other:tag} reference is not resolved here (its own file may
     * legitimately arrive later in the same batch).
     */
    private static JsonObject tag(final MinecraftServer server, final JsonObject out, final Kind kind,
                                  final JsonElement json) {
        DataResult<TagFile> res = TagFile.CODEC.parse(JsonOps.INSTANCE, json);
        if (res.error().isPresent()) {
            return finish(out, res);
        }
        TagFile file = res.getOrThrow();
        out.addProperty("valid", true);
        out.addProperty("entries", file.entries().size());
        if (file.replace()) {
            out.addProperty("replace", true);
        }
        Registry<?> registry = registry(server, kind.dir());
        if (registry == null) {
            return out;
        }
        JsonArray unknown = new JsonArray();
        for (TagEntry entry : file.entries()) {
            // TagEntry keeps its id private, and `verifyIfPresent` is the public door vanilla built
            // for exactly this question: it short-circuits to true for a `required:false` member
            // without ever calling the predicate, so the author's declared intent is honoured for
            // free rather than re-implemented from a parsed string.
            String[] seen = new String[1];
            boolean present = entry.verifyIfPresent(
                id -> {
                    seen[0] = id.toString();
                    return registry.containsKey(id);
                },
                id -> true); // a `#tag` member: a sibling file may legitimately arrive later
            if (!present && seen[0] != null && unknown.size() < UNKNOWN_LIMIT) {
                unknown.add(seen[0]);
            }
        }
        if (!unknown.isEmpty()) {
            out.add("unknown_ids", unknown);
            out.addProperty("note", "these members are not in " + kind.dir()
                + " — the tag decodes, and the game will log and DROP them at bind time, leaving a "
                + "tag that is silently short");
        }
        return out;
    }

    /**
     * A function is compiled, not decoded — {@code CommandFunction.fromLines} is what the server's own
     * function library calls, so the error text and the LINE NUMBER are vanilla's own. Compiled with
     * the server's function-compilation permissions for the same reason: a command the datapack would
     * not be allowed to run must not pass here.
     */
    private static JsonObject function(final MinecraftServer server, final JsonObject out,
                                       final String namespace, final String rest, final byte[] bytes) {
        String tail = rest.substring("function/".length());
        out.addProperty("kind", "function");
        out.addProperty("id", namespace + ":" + tail.substring(0, tail.length() - ".mcfunction".length()));
        out.addProperty("checked_by", "command_dispatcher");
        List<String> lines = List.of(new String(bytes, StandardCharsets.UTF_8).split("\r?\n", -1));
        try {
            CommandDispatcher<CommandSourceStack> dispatcher = server.getCommands().getDispatcher();
            CommandSourceStack context =
                Commands.createCompilationContext(server.getFunctionCompilationPermissions());
            CommandFunction.fromLines(Identifier.fromNamespaceAndPath(namespace, tail), dispatcher,
                context, lines);
            out.addProperty("valid", true);
            out.addProperty("lines", lines.size());
        } catch (Exception e) {
            out.addProperty("valid", false);
            out.addProperty("error", message(e));
        }
        return out;
    }

    /**
     * A structure is NBT, and the one thing worth reading back out of it is the palette count. A
     * template written with more than one palette omits the singular {@code palette} key entirely,
     * and every reader that only knows that key then resolves the whole thing to air — a blank
     * building that passes every size check. {@code capture_structure} reports this for the files it
     * writes; a file pushed from disk had nowhere to be told.
     */
    private static JsonObject structure(final JsonObject out, final String namespace, final String rest,
                                        final byte[] bytes) {
        String tail = rest.substring("structure/".length());
        out.addProperty("kind", "structure");
        out.addProperty("id", namespace + ":" + tail.substring(0, tail.length() - ".nbt".length()));
        out.addProperty("checked_by", "nbt");
        try (ByteArrayInputStream in = new ByteArrayInputStream(bytes)) {
            CompoundTag tag = NbtIo.readCompressed(in, NbtAccounter.unlimitedHeap());
            out.addProperty("valid", true);
            tag.getList("size").ifPresent(size -> out.add("size", sizeArray(size)));
            int palettes = tag.getList("palettes").map(l -> l.size()).orElse(0);
            if (palettes > 1) {
                out.addProperty("palettes", palettes);
                out.addProperty("note", "MULTI-PALETTE: this template has no singular `palette` key, "
                    + "so a reader that expects one resolves every block to air");
            }
            tag.getList("blocks").ifPresent(b -> out.addProperty("blocks", b.size()));
        } catch (Exception e) {
            out.addProperty("valid", false);
            out.addProperty("error", "not a readable gzipped structure NBT: " + message(e));
        }
        return out;
    }

    // ---- plumbing -----------------------------------------------------------

    private static JsonArray sizeArray(final net.minecraft.nbt.ListTag list) {
        JsonArray a = new JsonArray();
        for (int i = 0; i < list.size(); i++) {
            a.add(list.getIntOr(i, 0));
        }
        return a;
    }

    private static JsonObject finish(final JsonObject out, final DataResult<?> res) {
        if (res.error().isPresent()) {
            out.addProperty("valid", false);
            out.addProperty("error", res.error().get().message());
        } else {
            out.addProperty("valid", true);
        }
        return out;
    }

    /**
     * The honest empty answer. {@code kind} is null and {@code checked_by} is {@code "none"} so no
     * caller can read a missing {@code valid} as a pass — the same rule {@code tag_exists} follows
     * for an empty tag.
     */
    private static JsonObject none(final JsonObject out, final String note) {
        out.add("kind", com.google.gson.JsonNull.INSTANCE);
        out.addProperty("checked_by", "none");
        out.addProperty("note", note);
        return out;
    }

    private static String dirOf(final String rest) {
        int i = rest.lastIndexOf('/');
        return i < 0 ? "" : rest.substring(0, i);
    }

    private static String message(final Throwable e) {
        String m = e.getMessage();
        return m == null || m.isBlank() ? e.getClass().getSimpleName() : m;
    }

}
