package com.mattmc.mcptoolkit.ui;

import com.mattmc.mcptoolkit.McpToolkit;
import com.mattmc.mcptoolkit.hooks.ServerHooks;
import net.minecraft.commands.CommandSource;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.core.Holder;
import net.minecraft.core.HolderLookup;
import net.minecraft.core.HolderSet;
import net.minecraft.core.registries.Registries;
import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.Difficulty;
import net.minecraft.world.level.GameType;
import net.minecraft.world.level.LevelSettings;
import net.minecraft.world.level.WorldDataConfiguration;
import net.minecraft.world.level.biome.Biome;
import net.minecraft.world.level.biome.Biomes;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.gamerules.GameRule;
import net.minecraft.world.level.gamerules.GameRules;
import net.minecraft.world.level.levelgen.FlatLevelSource;
import net.minecraft.world.level.levelgen.WorldDimensions;
import net.minecraft.world.level.levelgen.WorldOptions;
import net.minecraft.world.level.levelgen.flat.FlatLayerInfo;
import net.minecraft.world.level.levelgen.flat.FlatLevelGeneratorSettings;
import net.minecraft.world.level.levelgen.presets.WorldPresets;
import net.minecraft.world.level.levelgen.structure.StructureSet;

import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * <b>The authoring world — a save whose whole job is to be nothing.</b>
 * ({@code SCREEN_AUTHORING_DESIGN.md} §23.)
 *
 * <p>A screen preview needs the client to be IN A WORLD — vanilla's requirement, not ours
 * ({@code ui/interp/UiPreview}: {@code AbstractContainerScreen} is built over an {@code Inventory},
 * and an {@code Inventory} is built over a {@code Player}). Until now the only world available was
 * the accumulated dev instance, and measuring what that costs is what produced this class:
 *
 * <ul>
 *   <li><b>13 seconds and 835 MB per cold cycle.</b> {@code run/saves/New World} loads 1044
 *       persistent chunks and spends 12.4s in "Preparing spawn area" before the client is playable.
 *       This world's chunks are one layer of stone over void: there is nothing to prepare.</li>
 *   <li><b>Nothing behind the panel is deterministic there.</b> A container screen draws the live
 *       world behind it, so the backdrop of a §12 pixel comparison is the time of day, the weather
 *       and whatever walked past. Here: no daylight cycle, no weather, no mobs, no night.</li>
 *   <li><b>It is somebody else's world.</b> Probe sites are forceloaded in it, other probes' screens
 *       close this one, and an hour of nudging buttons in it ticks a survival world that other
 *       sessions are measuring — {@code [[probe-site-ownership]]} with the roles swapped.</li>
 * </ul>
 *
 * <h2>Why a save and not a dimension</h2>
 *
 * <p>The toolkit already ships two empty dimensions ({@code canvas/Canvas} — {@code studio} and
 * {@code workshop}), and they are the wrong tool here for a reason that is about WHERE THE COST IS:
 * a dimension lives inside a save, so entering it still pays that save's load, still ticks its
 * overworld, and still shares its file with everyone else. The cost being attacked is at the LAUNCH,
 * so the answer has to be a different save.
 *
 * <p>And it must be a VANILLA superflat, not a toolkit dimension type. {@code Canvas}' javadoc
 * records why: this game is loader-only, a mod's {@code data/} is not read as a datapack without
 * fabric-api, so the toolkit's own dimensions reach a world by being written into that world's
 * datapack — which cannot exist before the world does. A fresh save with a toolkit dimension type as
 * its overworld would fail to load at the moment it was created. Vanilla's {@code the_void} biome
 * (no spawns, no features) over one layer of stone needs no datapack at all.
 *
 * <h2>The rules are re-applied on every start, not written once</h2>
 *
 * <p>{@code LevelSettings} in 26.2 carries no game rules, so they cannot be part of creation; they
 * are set on {@code SERVER_STARTED} instead. Doing that every start rather than once is deliberate
 * and is {@code Canvas.install}'s argument again — the toolkit made this world and nothing else
 * edits it, so re-asserting its rules is bookkeeping, and it self-heals a world someone left with
 * the sun moving.
 */
public final class UiWorld {

    private UiWorld() {}

    /** The save FOLDER, which is what {@code open_world} and {@code --quickPlaySingleplayer} name. */
    public static final String LEVEL_ID = "mcptk-ui";

    /**
     * The display name — and the only thing the server half can recognise this world BY. A
     * {@code MinecraftServer} exposes {@code getWorldData().getLevelName()}; the folder id lives on
     * {@code storageSource}, which is protected. One name, set at creation by us, is enough.
     */
    public static final String LEVEL_NAME = "MCP UI authoring";

    /** Void below, one layer of stone at y=0 to stand on: the floor is at y=1. */
    private static final int FLOOR_LAYERS_BELOW = 64;

    public static void register() {
        ServerHooks.SERVER_STARTED.register(UiWorld::applyRules);
    }

    /** True when this server is running the authoring world (by the name we gave it at creation). */
    public static boolean isAuthoringWorld(final MinecraftServer server) {
        return LEVEL_NAME.equals(server.getWorldData().getLevelName());
    }

    // ---------------------------------------------------------------------------------------------
    // creation

    /** How the world is created: creative, peaceful, commands on, and a name we can recognise. */
    public static LevelSettings levelSettings() {
        return new LevelSettings(
            LEVEL_NAME,
            GameType.CREATIVE,
            // Locked, so the difficulty cannot drift and take mob spawning back with it.
            new LevelSettings.DifficultySettings(Difficulty.PEACEFUL, false, true),
            true,
            WorldDataConfiguration.DEFAULT);
    }

    /** A fixed seed, no structures, no bonus chest — nothing here is generated twice differently. */
    public static WorldOptions worldOptions() {
        return new WorldOptions(0L, false, false);
    }

    /**
     * Vanilla's FLAT preset with its overworld replaced by void + one layer of stone, in the
     * {@code the_void} biome (which declares no mob spawns at all — the game rules below are the
     * belt, this is the braces).
     *
     * <p>The idiom is {@code DedicatedServerProperties}' own, down to the order: take the preset's
     * dimensions, then {@code replaceOverworldGenerator}. The nether and the end come along
     * untouched and unvisited.
     */
    public static WorldDimensions dimensions(final HolderLookup.Provider registries) {
        Holder<Biome> theVoid = registries.lookupOrThrow(Registries.BIOME).getOrThrow(Biomes.THE_VOID);
        Optional<HolderSet<StructureSet>> noStructures = Optional.of(HolderSet.direct(List.of()));
        FlatLevelGeneratorSettings flat =
            new FlatLevelGeneratorSettings(noStructures, theVoid, List.of())
                // Bottom-first, as FlatLevelGeneratorSettings stores them.
                .withBiomeAndLayers(
                    List.of(new FlatLayerInfo(FLOOR_LAYERS_BELOW, Blocks.AIR),
                        new FlatLayerInfo(1, Blocks.SMOOTH_STONE)),
                    noStructures, theVoid);
        WorldDimensions preset = registries.lookupOrThrow(Registries.WORLD_PRESET)
            .getOrThrow(WorldPresets.FLAT).value().createWorldDimensions();
        return preset.replaceOverworldGenerator(registries, new FlatLevelSource(flat));
    }

    // ---------------------------------------------------------------------------------------------
    // the rules

    /**
     * Everything that could make two screenshots of the same screen differ, turned off. The three
     * groups are named separately because they answer different questions: time and weather are the
     * BACKDROP, spawning is what walks into it, and the damage rules are what happens to a player
     * left standing here for an hour while somebody nudges a button 3px.
     */
    private static final Map<GameRule<Boolean>, Boolean> RULES = Map.ofEntries(
        Map.entry(GameRules.ADVANCE_TIME, false),
        Map.entry(GameRules.ADVANCE_WEATHER, false),
        Map.entry(GameRules.SPAWN_MOBS, false),
        Map.entry(GameRules.SPAWN_MONSTERS, false),
        Map.entry(GameRules.SPAWN_PATROLS, false),
        Map.entry(GameRules.SPAWN_PHANTOMS, false),
        Map.entry(GameRules.SPAWN_WANDERING_TRADERS, false),
        Map.entry(GameRules.SPAWN_WARDENS, false),
        Map.entry(GameRules.FALL_DAMAGE, false),
        Map.entry(GameRules.FIRE_DAMAGE, false),
        Map.entry(GameRules.DROWNING_DAMAGE, false),
        Map.entry(GameRules.KEEP_INVENTORY, true));

    /** The rules, as a probe can read them back: name -> expected value. */
    public static Map<String, Boolean> expectedRules() {
        return RULES.entrySet().stream()
            .collect(java.util.stream.Collectors.toMap(e -> e.getKey().id(), Map.Entry::getValue));
    }

    private static void applyRules(final MinecraftServer server) {
        if (!isAuthoringWorld(server)) {
            return;
        }
        for (Map.Entry<GameRule<Boolean>, Boolean> rule : RULES.entrySet()) {
            server.getGameRules().set(rule.getKey(), rule.getValue(), server);
        }
        server.setDifficulty(Difficulty.PEACEFUL, true);
        // The clock is a timeline in 26.2 and has no setter worth reaching through; the command is
        // the supported way to move it, and with ADVANCE_TIME off it is moved exactly once.
        silently(server, "time set noon");
        McpToolkit.LOGGER.info("[MCP Toolkit] authoring world '{}': {} game rules applied, peaceful,"
            + " noon, frozen", LEVEL_NAME, RULES.size());
    }

    /** Run a command with its feedback swallowed — this is setup, not something a player asked for. */
    private static void silently(final MinecraftServer server, final String command) {
        CommandSourceStack source = server.createCommandSourceStack().withSource(new CommandSource() {
            @Override public void sendSystemMessage(final Component message) { }
            @Override public boolean acceptsSuccess() { return false; }
            @Override public boolean acceptsFailure() { return false; }
            @Override public boolean shouldInformAdmins() { return false; }
        });
        try {
            server.getCommands().performPrefixedCommand(source, command);
        } catch (Exception e) {
            McpToolkit.LOGGER.warn("[MCP Toolkit] authoring world setup: '{}' failed: {}",
                command, e.toString());
        }
    }
}
