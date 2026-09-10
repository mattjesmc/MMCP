package com.mattmc.mcptoolkit.client;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.ExecutionContext;
import com.mattmc.mcptoolkit.McpToolkit;
import com.mattmc.mcptoolkit.McpTools;
import com.mattmc.mcptoolkit.Mechanism;
import com.mattmc.mcptoolkit.Schemas;
import com.mattmc.mcptoolkit.ToolDef;
import com.mattmc.mcptoolkit.hooks.ServerHooks;
import net.fabricmc.api.EnvType;
import net.fabricmc.api.Environment;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.TitleScreen;
import net.minecraft.core.Holder;
import net.minecraft.core.HolderLookup;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.Identifier;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.Difficulty;
import net.minecraft.world.flag.FeatureFlags;
import net.minecraft.world.level.DataPackConfig;
import net.minecraft.world.level.GameType;
import net.minecraft.world.level.LevelSettings;
import net.minecraft.world.level.WorldDataConfiguration;
import net.minecraft.world.level.levelgen.WorldDimensions;
import net.minecraft.world.level.levelgen.FlatLevelSource;
import net.minecraft.world.level.levelgen.WorldOptions;
import net.minecraft.world.level.levelgen.flat.FlatLevelGeneratorPreset;
import net.minecraft.world.level.levelgen.presets.WorldPreset;
import net.minecraft.world.level.levelgen.presets.WorldPresets;
import net.minecraft.world.level.storage.LevelStorageSource;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.OptionalLong;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Stream;

/**
 * {@code create_world} - a world from the title screen, with its datapacks enabled AT CREATION
 * (RELEASE_1.md section K2, ArmorPieces' ask 1). {@code open_world} opens what exists, and a suite
 * that reuses a world tests yesterday's state.
 *
 * <p>The mechanism is the authoring world's ({@code UiWorldClient}): vanilla's
 * {@code WorldOpenFlows.createFreshLevel} with a {@code LevelSettings}, a {@code WorldOptions} and a
 * dimensions function, exactly the call the Create World screen makes after its last click, minus
 * the screens. A pack given by path is copied into {@code saves/<name>/datapacks/} BEFORE the
 * creation call and named in the {@code WorldDataConfiguration} that call carries, which is where
 * the Create World screen's "Data Packs" button puts it - so the world's FIRST load already has it,
 * and a suite gets a fresh, seeded world with its pack on every run.
 *
 * <p>What this is NOT, measured (probes/create-world.test.mjs, its last case): the consumer's
 * finding that "a pack folder created after the world loaded is invisible to /reload" did not
 * reproduce on 26.2 - a valid pack dropped into the save's {@code datapacks/} is detected and
 * auto-enabled as a world pack by {@code /reload}, and so is one whose first {@code pack.mcmeta}
 * was broken and later fixed. Packs-at-creation is the clean path, not the only one.
 *
 * <p>Two things this call cannot do, said in the reply rather than discovered: game rules do not
 * ride creation in 26.2 ({@code LevelSettings} carries none - {@code UiWorld} found this first),
 * so they are applied on {@code SERVER_STARTED} for the world by name; and like {@code open_world}
 * it returns when the load has STARTED, never claiming it finished.
 */
@Environment(EnvType.CLIENT)
public final class WorldCreation {

    private WorldCreation() {}

    /** Game rules waiting for the server of the named world, applied once on its first start. */
    private static final Map<String, Map<String, String>> PENDING_RULES = new ConcurrentHashMap<>();

    public static void register() {
        ServerHooks.SERVER_STARTED.register(WorldCreation::applyPendingRules);
        McpTools.register(ToolDef.async(
            "create_world",
            "Create a singleplayer world from the title screen and open it - the cold path with no human "
                + "click in it - a fresh, seeded world for every suite run instead of yesterday's state. "
                + "`datapacks` are enabled AT CREATION: a path is copied into the save's datapacks/ before "
                + "the world exists and named in its pack configuration, so the first load has it (a pack "
                + "dropped in later is also picked up by /reload on this version; creation is the clean "
                + "path, not the only one). Game rules cannot ride creation in this "
                + "version; they are applied on the server's first start and the reply says so. Returns "
                + "as soon as the load is STARTED: poll get_world_info (or ping's serverRunning). Refuses "
                + "when a world is already open, and when the save exists unless `replace:true`.",
            Schemas.objectOpt(Schemas.object(
                    "name", Schemas.str("Save folder AND display name. Letters, digits, - _ and space."),
                    "seed", Schemas.str("Vanilla's seed field: a number, or any text hashed the way the screen hashes it. Omit for random."),
                    "generator", Schemas.str("normal (default) | flat"),
                    "flat", Schemas.str("With generator flat: a flat_level_generator_preset id, e.g. minecraft:classic_flat (default), minecraft:the_void, minecraft:redstone_ready."),
                    "gamemode", Schemas.str("survival (default) | creative | adventure | spectator"),
                    "difficulty", Schemas.str("peaceful | easy | normal (default) | hard"),
                    "cheats", Schemas.bool("Allow commands (default true - a suite drives it with run_command)."),
                    "structures", Schemas.bool("Generate structures (default true)."),
                    "datapacks", Schemas.array(Schemas.str("An absolute PATH to a pack folder or .zip (copied in and enabled as file/<name>), or a pack id already known to the game (e.g. file/<name> for one already in the save).")),
                    "gamerules", Schemas.object(),
                    "replace", Schemas.bool("Delete an existing save of this name first (default false: refuse).")),
                "seed", "generator", "flat", "gamemode", "difficulty", "cheats", "structures", "datapacks", "gamerules", "replace"),
            ExecutionContext.CLIENT,
            Mechanism.PRIVILEGED,
            (ctx, a) -> CompletableFuture.completedFuture(create(a))));
    }

    private static JsonElement create(final JsonObject a) {
        Minecraft mc = Minecraft.getInstance();
        if (mc.level != null) {
            throw new IllegalStateException("a world is already open ("
                + mc.level.dimension().identifier() + "); quit to the title screen first");
        }
        String name = str(a, "name", null);
        if (name == null || name.isBlank()) {
            throw new IllegalArgumentException("`name` is required");
        }
        if (!name.matches("[A-Za-z0-9 _-]{1,64}")) {
            throw new IllegalArgumentException("`name` must be letters, digits, space, - or _ (1-64), got '" + name + "'");
        }
        LevelStorageSource saves = mc.getLevelSource();
        boolean replace = bool(a, "replace", false);
        if (saves.levelExists(name)) {
            if (!replace) {
                throw new IllegalStateException("a save named \"" + name + "\" exists - open_world opens it, "
                    + "or create_world with replace:true deletes it first");
            }
            try (LevelStorageSource.LevelStorageAccess access = saves.createAccess(name)) {
                access.deleteLevel();
            } catch (IOException e) {
                throw new IllegalStateException("could not delete the existing save \"" + name + "\": " + e.getMessage(), e);
            }
        }

        GameType mode = GameType.byName(str(a, "gamemode", "survival"), null);
        if (mode == null) {
            throw new IllegalArgumentException("`gamemode` must be survival | creative | adventure | spectator");
        }
        Difficulty difficulty = Difficulty.byName(str(a, "difficulty", "normal"));
        if (difficulty == null) {
            throw new IllegalArgumentException("`difficulty` must be peaceful | easy | normal | hard");
        }
        String generator = str(a, "generator", "normal").toLowerCase(Locale.ROOT);
        if (!generator.equals("normal") && !generator.equals("flat")) {
            throw new IllegalArgumentException("`generator` must be normal | flat, got '" + generator + "'");
        }
        final Identifier flatPreset = generator.equals("flat")
            ? Identifier.parse(str(a, "flat", "minecraft:classic_flat"))
            : null;
        long seed;
        String seedText = str(a, "seed", null);
        if (seedText == null || seedText.isBlank()) {
            seed = WorldOptions.randomSeed();
        } else {
            OptionalLong parsed = WorldOptions.parseSeed(seedText);
            seed = parsed.orElse(WorldOptions.randomSeed());
        }
        WorldOptions options = new WorldOptions(seed, bool(a, "structures", true), false);

        // The packs: paths are copied in BEFORE creation, ids are enabled as given.
        List<String> enabled = new ArrayList<>(DataPackConfig.DEFAULT.getEnabled());
        JsonArray copied = new JsonArray();
        if (a.has("datapacks") && a.get("datapacks").isJsonArray()) {
            Path packsDir = saves.getBaseDir().resolve(name).resolve("datapacks");
            for (JsonElement e : a.getAsJsonArray("datapacks")) {
                String spec = e.getAsString();
                Path source = looksLikePath(spec) ? Path.of(spec) : null;
                if (source == null) {
                    if (!enabled.contains(spec)) {
                        enabled.add(spec);
                    }
                    continue;
                }
                if (!Files.exists(source)) {
                    throw new IllegalArgumentException("datapack path does not exist: " + source);
                }
                if (Files.isDirectory(source) && !Files.isRegularFile(source.resolve("pack.mcmeta"))) {
                    throw new IllegalArgumentException("not a pack: no pack.mcmeta at the root of " + source
                        + " (the game classifies a pack by that file once, at creation - this is the fact the tool exists for)");
                }
                Path target = packsDir.resolve(source.getFileName().toString());
                try {
                    copyTree(source, target);
                } catch (IOException ex) {
                    throw new IllegalStateException("could not copy " + source + " into the save: " + ex.getMessage(), ex);
                }
                String id = "file/" + source.getFileName();
                if (!enabled.contains(id)) {
                    enabled.add(id);
                }
                copied.add(target.toString());
            }
        }
        WorldDataConfiguration data = new WorldDataConfiguration(
            new DataPackConfig(enabled, List.of()), FeatureFlags.DEFAULT_FLAGS);
        LevelSettings settings = new LevelSettings(name, mode,
            new LevelSettings.DifficultySettings(difficulty, false, false),
            bool(a, "cheats", true), data);

        // The rules: parked by world name, applied on SERVER_STARTED (26.2 LevelSettings has none).
        Map<String, String> rules = new LinkedHashMap<>();
        if (a.has("gamerules") && a.get("gamerules").isJsonObject()) {
            for (Map.Entry<String, JsonElement> e : a.getAsJsonObject("gamerules").entrySet()) {
                rules.put(e.getKey(), e.getValue().getAsString());
            }
        }
        if (!rules.isEmpty()) {
            PENDING_RULES.put(name, rules);
        }

        mc.createWorldOpenFlows().createFreshLevel(name, settings, options,
            registries -> dimensions(registries, flatPreset), new TitleScreen());

        JsonObject r = new JsonObject();
        r.addProperty("creating", name);
        r.addProperty("seed", seed);
        r.addProperty("generator", flatPreset == null ? "normal" : "flat:" + flatPreset);
        JsonArray packs = new JsonArray();
        enabled.forEach(packs::add);
        r.add("datapacks_enabled", packs);
        if (copied.size() > 0) {
            r.add("datapacks_copied", copied);
        }
        r.addProperty("gamerules_pending", rules.size());
        r.addProperty("note", "the load has STARTED; poll get_world_info until the level answers"
            + (rules.isEmpty() ? "" : " - the game rules are applied on the server's first start"));
        return r;
    }

    /** NORMAL's dimensions, or FLAT's with the named preset's settings as the overworld. */
    private static WorldDimensions dimensions(final HolderLookup.Provider registries, final Identifier flatPreset) {
        if (flatPreset == null) {
            return registries.lookupOrThrow(Registries.WORLD_PRESET).getOrThrow(WorldPresets.NORMAL)
                .value().createWorldDimensions();
        }
        ResourceKey<FlatLevelGeneratorPreset> key =
            ResourceKey.create(Registries.FLAT_LEVEL_GENERATOR_PRESET, flatPreset);
        Holder<FlatLevelGeneratorPreset> preset = registries.lookupOrThrow(Registries.FLAT_LEVEL_GENERATOR_PRESET)
            .get(key)
            .orElseThrow(() -> new IllegalArgumentException("no flat preset " + flatPreset
                + "; query_registry {registry:\"worldgen/flat_level_generator_preset\"} lists them"));
        Holder<WorldPreset> flat = registries.lookupOrThrow(Registries.WORLD_PRESET).getOrThrow(WorldPresets.FLAT);
        return flat.value().createWorldDimensions()
            .replaceOverworldGenerator(registries, new FlatLevelSource(preset.value().settings()));
    }

    private static void applyPendingRules(final MinecraftServer server) {
        String level = server.getWorldData().getLevelName();
        Map<String, String> rules = PENDING_RULES.remove(level);
        if (rules == null) {
            return;
        }
        var source = server.createCommandSourceStack().withSuppressedOutput();
        for (Map.Entry<String, String> rule : rules.entrySet()) {
            server.getCommands().performPrefixedCommand(source, "gamerule " + rule.getKey() + " " + rule.getValue());
        }
        McpToolkit.LOGGER.info("[MCP Toolkit] create_world '{}': {} game rule(s) applied on first start",
            level, rules.size());
    }

    private static boolean looksLikePath(final String spec) {
        return spec.contains("/") && !spec.startsWith("file/") || spec.contains("\\") || spec.matches("[A-Za-z]:.*");
    }

    private static void copyTree(final Path source, final Path target) throws IOException {
        if (Files.isRegularFile(source)) {
            Files.createDirectories(target.getParent());
            Files.copy(source, target, StandardCopyOption.REPLACE_EXISTING);
            return;
        }
        try (Stream<Path> walk = Files.walk(source)) {
            for (Path p : (Iterable<Path>) walk::iterator) {
                Path dest = target.resolve(source.relativize(p).toString());
                if (Files.isDirectory(p)) {
                    Files.createDirectories(dest);
                } else {
                    Files.createDirectories(dest.getParent());
                    Files.copy(p, dest, StandardCopyOption.REPLACE_EXISTING);
                }
            }
        }
    }

    private static String str(final JsonObject a, final String key, final String fallback) {
        return a != null && a.has(key) && !a.get(key).isJsonNull() ? a.get(key).getAsString() : fallback;
    }

    private static boolean bool(final JsonObject a, final String key, final boolean fallback) {
        return a != null && a.has(key) && !a.get(key).isJsonNull() ? a.get(key).getAsBoolean() : fallback;
    }
}
