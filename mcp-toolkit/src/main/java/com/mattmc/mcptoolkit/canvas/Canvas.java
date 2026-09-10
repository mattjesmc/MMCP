package com.mattmc.mcptoolkit.canvas;

import com.mattmc.mcptoolkit.DataTools;
import com.mattmc.mcptoolkit.McpToolkit;
import com.mattmc.mcptoolkit.hooks.ServerHooks;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.Identifier;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.Level;
import org.jspecify.annotations.Nullable;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * <b>The canvas — two shipped dimensions: one to build in, one to photograph in.</b>
 * ({@code RENDER_SEAM_DESIGN.md} §4.2 and §10.5.)
 *
 * <p>{@code mcptoolkit:workshop} is where a human works: a sky to orient by, a sun that never moves,
 * no night, no weather, and enough ambient light that nothing is unreadably dark.
 * {@code mcptoolkit:studio} is the camera's backdrop — {@code skybox:"none"}, white fog and flat
 * full-bright light, so a subject placed there photographs against nothing at all. They are two
 * dimensions rather than one with a toggle because {@code skybox} and the
 * {@code EnvironmentAttributeMap} are properties of the DIMENSION TYPE: static data read at world
 * load, not runtime state.
 *
 * <h2>Why the files are copied into the world datapack instead of only shipped</h2>
 *
 * The design assumed a {@code data/mcptoolkit/dimension/*.json} in the mod's own resources becomes a
 * level in every world. That is true on NeoForge and on a Fabric game that happens to have fabric-api
 * — and <b>false in this toolkit's own dev game</b>, which is loader-only by policy: a mod's
 * {@code data/} directory is read as a datapack by {@code fabric-resource-loader}, which is part of
 * fabric-api, which the toolkit deliberately does not depend on.
 * {@link com.mattmc.mcptoolkit.McpToolkitTags} already records that rule for tags and answers it with
 * a Java floor that is always in force. A dimension has no Java floor.
 *
 * <p>So the same bytes take a second road: on every server start they are written into the toolkit's
 * live world datapack — {@code push_data}'s pack, which vanilla itself discovers in
 * {@code <world>/datapacks} and selects automatically — where a loader-only game loads them like any
 * other datapack. Shipped in the mod AND installed into the world, from one source, so the two can
 * never disagree.
 *
 * <p><b>It costs one restart, and that is not something this class could fix.</b> Worldgen registries
 * are read once during world load, before the server this code runs on exists — the same fact
 * {@code push_data}'s own description states ("NOT reloadable: worldgen"). A world that has never had
 * the toolkit in it gets the files on its first start and the dimensions on its second.
 * {@link #present} is what every caller asks before assuming otherwise, and {@link #absentMessage}
 * is the refusal that says why.
 */
public final class Canvas {

    private Canvas() {}

    /** The human's canvas: sky, fixed sun, no weather, no night. */
    public static final ResourceKey<Level> WORKSHOP = ResourceKey.create(Registries.DIMENSION,
        Identifier.fromNamespaceAndPath(McpToolkit.MOD_ID, "workshop"));
    /** The camera's canvas: no sky, white background, flat full-bright light. */
    public static final ResourceKey<Level> STUDIO = ResourceKey.create(Registries.DIMENSION,
        Identifier.fromNamespaceAndPath(McpToolkit.MOD_ID, "studio"));

    /**
     * The working plane — the Y a frame's floor sits at, in both canvases.
     *
     * <p>Two facts pick it, and both were read rather than assumed. Void darkness is
     * {@code clamp((32 + min_y - camera_y) / 32)} ({@code FogRenderer}), so a canvas whose
     * {@code min_y} is -64 fades toward black for anyone below y=-32. The design's answer to that was
     * "use a flat generator", and <b>that does not work</b>: {@code ServerLevel.isFlat()} reads the
     * SAVE's {@code SpecialWorldProperty}, not the dimension's generator, so a canvas inside a normal
     * world is never flat by that test however its chunks are made. The other fact is the client's
     * horizon, which sits at y=63 in any non-flat level and draws the dark disc below itself. y=64
     * clears both, and it is one number rather than two rules.
     */
    public static final int PLANE_Y = 64;

    /** How far apart two sessions' origins sit. See {@link EditSession} on why they are allocated. */
    public static final int SLOT_STRIDE = 512;
    /** Slots per row before the grid wraps — cosmetic, so coordinates stay small and readable. */
    private static final int SLOT_ROW = 16;

    /**
     * The five files, at the same path in the jar and in the pack. The order is the report's, not the
     * loader's: the biome is what both dimensions point at, so it reads first.
     */
    static final List<String> FILES = List.of(
        "data/mcptoolkit/worldgen/biome/canvas.json",
        "data/mcptoolkit/dimension_type/studio.json",
        "data/mcptoolkit/dimension_type/workshop.json",
        "data/mcptoolkit/dimension/studio.json",
        "data/mcptoolkit/dimension/workshop.json");

    /** What {@link #install} did, so a caller can say it out loud rather than guess. */
    public record Install(List<String> written, List<String> unchanged, @Nullable String error) {
        public boolean wroteAnything() {
            return !written.isEmpty();
        }
    }

    public static void register() {
        // Install on every start, not only the first: the pack lives in the world folder and survives
        // restarts, so a canvas whose JSON a later version changed would otherwise stay on the old one
        // forever. The toolkit wrote these files and nothing else edits them, so rewriting a stale one
        // is bookkeeping — the same argument DataTools.ensureInit makes about its own pack.mcmeta.
        ServerHooks.SERVER_STARTED.register(server -> {
            // THE AUTHORING WORLD IS THE ONE WORLD THAT MUST NOT HAVE THESE (SCREEN_AUTHORING_DESIGN.md
            // section 23). A dimension whose key is not overworld/nether/end makes the whole level-stem
            // registry EXPERIMENTAL (WorldDimensions.checkStability -> isVanillaLike), and
            // WorldOpenFlows then stops every later open on a BackupConfirmScreen - which is the cause
            // of the long-standing "open_world parks on BackupConfirmScreen" trap, found by a door that
            // opened this world a second time. That world is a flat empty save whose whole point is to
            // be nothing, so the canvas has nothing to add there; the files are removed rather than
            // merely skipped, so a world that already got them heals on its next load.
            if (com.mattmc.mcptoolkit.ui.UiWorld.isAuthoringWorld(server)) {
                uninstall(server);
                EditSession.load(server);
                return;
            }
            Install result = install(server);
            if (result.error() != null) {
                McpToolkit.LOGGER.warn("[canvas] could not install the canvas datapack files: {}",
                    result.error());
            } else if (!present(server)) {
                McpToolkit.LOGGER.info("[canvas] {} canvas file(s) written into the live datapack; the"
                    + " workshop and studio dimensions appear after the NEXT world load — worldgen is"
                    + " read before the server starts and no reload can add a dimension",
                    result.written().size());
            }
            EditSession.load(server);
        });
        CanvasFrame.register();
        CanvasCommands.register();
    }

    /**
     * Copy the shipped canvas files into the live world datapack, skipping any whose bytes already
     * match. Never throws: a world whose datapack directory will not take a write is something to
     * report, not a reason to fail server start.
     */
    public static Install install(final MinecraftServer server) {
        final List<String> written = new ArrayList<>();
        final List<String> unchanged = new ArrayList<>();
        try {
            final Path root = DataTools.packRoot(server);
            DataTools.ensurePack(root);
            for (final String rel : FILES) {
                final byte[] want = shipped(rel);
                final Path target = root.resolve(rel).normalize();
                if (!target.startsWith(root)) {
                    throw new IOException("path escapes the pack root: " + rel);
                }
                if (Files.isRegularFile(target) && Arrays.equals(Files.readAllBytes(target), want)) {
                    unchanged.add(rel);
                    continue;
                }
                Files.createDirectories(target.getParent());
                Files.write(target, want);
                written.add(rel);
            }
        } catch (final Exception e) {
            return new Install(written, unchanged,
                e.getMessage() == null ? e.toString() : e.getMessage());
        }
        return new Install(written, unchanged, null);
    }

    /**
     * Remove the canvas files from a world that must not carry them. Only the five files this class
     * wrote, only by name, and never the pack itself - other subsystems (push_data) live in it.
     *
     * <p>It takes effect on the load AFTER this one: worldgen registries are read before this server
     * existed, which is the same fact {@link #absentMessage} states from the other side.
     */
    private static void uninstall(final MinecraftServer server) {
        int removed = 0;
        try {
            final Path root = DataTools.packRoot(server);
            for (final String rel : FILES) {
                final Path target = root.resolve(rel).normalize();
                if (target.startsWith(root) && Files.deleteIfExists(target)) {
                    removed++;
                }
            }
        } catch (final Exception e) {
            McpToolkit.LOGGER.warn("[canvas] could not remove the canvas files from the authoring"
                + " world: {}", e.toString());
            return;
        }
        if (removed > 0) {
            McpToolkit.LOGGER.info("[canvas] removed {} canvas file(s) from the authoring world: a"
                + " custom dimension makes a save EXPERIMENTAL and every later open asks for a backup."
                + " This load still has them; the next one will not.", removed);
        }
    }

    /** The shipped bytes for one canvas file, read out of the mod jar. */
    static byte[] shipped(final String rel) throws IOException {
        try (InputStream in = McpToolkit.class.getClassLoader().getResourceAsStream(rel)) {
            if (in == null) {
                throw new IOException("the mod jar is missing " + rel);
            }
            return in.readAllBytes();
        }
    }

    /** True when this world actually has the canvas dimensions — i.e. the pack was in place at load. */
    public static boolean present(final MinecraftServer server) {
        return server.getLevel(WORKSHOP) != null && server.getLevel(STUDIO) != null;
    }

    /** The canvas level, or null when this world has not loaded the datapack yet. */
    public static @Nullable ServerLevel level(final MinecraftServer server,
                                              final ResourceKey<Level> which) {
        return server.getLevel(which);
    }

    /**
     * The sentence to say when the canvas is not there — written once because three callers need it,
     * and three paraphrases of it would eventually stop agreeing.
     */
    public static String absentMessage(final MinecraftServer server) {
        final Install result = install(server);
        if (result.error() != null) {
            return "this world has no mcptoolkit:workshop, and the canvas datapack could not be"
                + " written: " + result.error();
        }
        return "this world has no mcptoolkit:workshop yet. The canvas datapack files are in place ("
            + (result.written().size() + result.unchanged().size()) + " of " + FILES.size()
            + "). Worldgen registries are read during world load, before this server existed, so"
            + " RESTART the world and run this again — a reload cannot add a dimension.";
    }

    /** The origin (the frame's minimum corner) for slot {@code n}. Slots are allocated, never chosen. */
    public static BlockPos slotOrigin(final int slot) {
        return new BlockPos((slot % SLOT_ROW) * SLOT_STRIDE, PLANE_Y, (slot / SLOT_ROW) * SLOT_STRIDE);
    }
}
