package com.mattmc.mcptoolkit.canvas;

import net.minecraft.core.BlockPos;
import net.minecraft.core.SectionPos;
import net.minecraft.core.Vec3i;
import net.minecraft.resources.Identifier;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.Entity;
import net.minecraft.util.RandomSource;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.Rotation;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.levelgen.structure.templatesystem.StructurePlaceSettings;
import net.minecraft.world.level.levelgen.structure.templatesystem.StructureTemplate;
import org.jspecify.annotations.Nullable;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

/**
 * <b>A subject standing in the studio, so the camera has something to photograph against nothing.</b>
 * ({@code RENDER_SEAM_DESIGN.md} §6's {@code op:"canvas"} — the last unbuilt line of that design,
 * built as the {@code studio} tool for the reason {@code StudioTools} gives.)
 *
 * <p>{@link CanvasCommands} opens a piece in the <i>workshop</i> for a human to edit;
 * this opens one in the <i>studio</i> for the camera to look at. Same canvas, same slot grid, same
 * "the toolkit allocates the coordinates, nobody chooses them" rule — and the two cannot collide,
 * because an edit session is always in {@link Canvas#WORKSHOP} and a stage is always in
 * {@link Canvas#STUDIO}. {@link Canvas#slotOrigin} answers the same coordinates for both, in two
 * different levels.
 *
 * <h2>Why a stage stays until it is cleared</h2>
 *
 * The alternative — sweep it in the same {@code finally} that puts the player back — makes the
 * picture unreproducible: nobody can walk in and look at the thing that was photographed, and §5 of
 * the design is explicit that the final judgement of appearance is a human's or an agent's <i>eye</i>.
 * So a stage persists, one region per calling session, and the next stage from that session clears
 * its own region before reusing it — the same "clear on open, because a session that ended when the
 * server died never ran its own clear" argument {@link CanvasCommands} makes about edit slots.
 * {@code studio {leave:true}} is the explicit sweep, and like {@code /mmcp cancel} it clears
 * <b>the caller's own</b> region and nobody else's.
 *
 * <h2>The invisible floor, and why a stage needs one at all</h2>
 *
 * The studio has no ground. The camera does not care — it is placed in mid-air by construction — but
 * the CLIENT has to stand in the studio for its level to be the one that renders (that is what makes
 * {@code op:"canvas"} more than sugar over {@code place_structure}), and a player standing in a void
 * dimension falls: roughly 78 blocks a second at terminal velocity, into void damage below
 * {@code min_y - 64}. A shot that took four seconds would be a shot that hurt somebody.
 *
 * <p>So a stage lays a 3x3 pad of {@code minecraft:barrier} under the spot it moves the client to.
 * Barrier is {@code RenderShape.INVISIBLE} ({@code BarrierBlock.java:51}), so the floor cannot appear
 * in the photograph — the one block in the game that is a floor to stand on and nothing to look at.
 * It sits inside the cleared region and is swept with it.
 */
public final class CanvasStage {

    private CanvasStage() {}

    /** The same cap {@code capture_structure} and {@code place_structure} use. A photo is not an area. */
    public static final int MAX_CELLS = 64 * 64 * 64;

    /** How far the cleared region extends past the subject on every side. Holds the pad, too. */
    private static final int MARGIN = 8;

    /** Where the client is put down, measured from the subject's minimum corner. Outside the box. */
    private static final int STAND_OFFSET = 6;

    /** The pad is {@code 2*PAD_RADIUS+1} square. Enough that a fall cannot start on its edge. */
    private static final int PAD_RADIUS = 1;

    /**
     * How many cells of the staged subject the client is asked to confirm it can see. Four, chosen
     * from four DIFFERENT chunk columns where the subject spans that many: the wait is really a wait
     * for chunk packets, and four witnesses in one chunk would answer the same question four times.
     */
    private static final int MAX_WITNESSES = 4;

    /** An invisible floor. See the class javadoc — the studio has no ground and a player falls. */
    private static final BlockState PAD = Blocks.BARRIER.defaultBlockState();

    /**
     * One subject standing in the studio.
     *
     * @param owner    the session that staged it; the only session that may sweep it
     * @param slot     its place in the canvas grid ({@link Canvas#slotOrigin})
     * @param origin   the subject's minimum corner
     * @param size     the subject's size in cells
     * @param from     where it came from, for the reply: a template id, or a dimension and a box
     * @param blocks   non-air cells placed — zero is refused, because an empty studio is not a photo
     * @param witnesses cells the CLIENT must confirm before the camera is allowed to look
     * @param stand    where the client is put down: on the pad, outside the subject
     */
    public record Staged(String owner, int slot, BlockPos origin, Vec3i size, String from, int blocks,
                         List<BlockPos> witnesses, BlockPos stand) {

        /** The subject's maximum corner, INCLUSIVE — the box `look_at` takes. */
        public BlockPos max() {
            return origin.offset(size.getX() - 1, size.getY() - 1, size.getZ() - 1);
        }
    }

    /**
     * Where the client's player was standing before a stage moved it — the whole content of the
     * restore, and the reason {@code leave} can put somebody back in a dimension the studio knows
     * nothing about.
     */
    public record Home(ResourceKey<Level> dimension, double x, double y, double z,
                       float yaw, float pitch) {}

    /**
     * Staged subjects by owner. Touched only from the server thread (both entry points are server
     * work), read from the client thread once per shot through the value the stage returned — never
     * through this map, which is why it needs no more synchronization than it has.
     */
    private static final Map<String, Staged> STAGED = Collections.synchronizedMap(new LinkedHashMap<>());

    /** Where each session was before it went to the studio. Present exactly while it is away. */
    private static final Map<String, Home> AWAY = Collections.synchronizedMap(new LinkedHashMap<>());

    /**
     * The LIVING subject each session staged (RELEASE_1.md section K3), by owner. A block subject
     * is swept by coordinates; an entity has to be found and discarded, so its id is kept here from
     * the spawn until {@link #clear} or the next stage by the same owner.
     */
    private static final Map<String, UUID> ENTITIES = Collections.synchronizedMap(new LinkedHashMap<>());

    /** This session's living subject, or null. Read from the client thread for the arrival check. */
    public static @Nullable UUID entityOf(final String owner) {
        return ENTITIES.get(owner);
    }

    public static void rememberEntity(final String owner, final UUID id) {
        ENTITIES.put(owner, id);
    }

    /** Discard this session's living subject if it has one. True when something was removed. */
    public static boolean discardEntity(final ServerLevel studio, final String owner) {
        final UUID id = ENTITIES.remove(owner);
        if (id == null) {
            return false;
        }
        final Entity entity = studio.getEntity(id);
        if (entity == null) {
            return false;
        }
        entity.discard();
        return true;
    }

    /**
     * A region for a living subject: allocated, emptied, an invisible floor laid under the box, and
     * nothing else - the subject itself is spawned by the caller, on the server thread, once this
     * returns. The witnesses are floor cells (one per chunk column), so the same arrival wait a
     * block subject gets covers "the chunk is here"; the caller adds "and so is the entity".
     */
    public static Staged stageEmpty(final MinecraftServer server, final String owner, final Vec3i size,
                                    final String from) {
        final ServerLevel studio = Canvas.level(server, Canvas.STUDIO);
        if (studio == null) {
            throw new IllegalStateException(Canvas.absentMessage(server));
        }
        if (size.getX() < 1 || size.getY() < 1 || size.getZ() < 1) {
            throw new IllegalArgumentException("a subject box needs every axis at least one block");
        }
        discardEntity(studio, owner);
        final int slot = slotFor(owner);
        final BlockPos origin = Canvas.slotOrigin(slot);
        sweep(studio, origin, size);
        final List<BlockPos> witnesses = new ArrayList<>();
        final Set<Long> chunks = new LinkedHashSet<>();
        int floor = 0;
        for (int x = 0; x < size.getX(); x++) {
            for (int z = 0; z < size.getZ(); z++) {
                final BlockPos cell = origin.offset(x, -1, z);
                studio.setBlock(cell, PAD, Block.UPDATE_CLIENTS);
                floor++;
                final long column = (SectionPos.blockToSectionCoord(cell.getX()) & 0xFFFFFFFFL)
                    | ((long) SectionPos.blockToSectionCoord(cell.getZ()) << 32);
                if (witnesses.size() < MAX_WITNESSES && chunks.add(column)) {
                    witnesses.add(cell);
                }
            }
        }
        final BlockPos stand = origin.offset(-STAND_OFFSET, 0, -STAND_OFFSET);
        pad(studio, stand);
        final Staged staged = new Staged(owner, slot, origin, size, from, floor, List.copyOf(witnesses), stand);
        STAGED.put(owner, staged);
        return staged;
    }

    public static @Nullable Staged of(final String owner) {
        return STAGED.get(owner);
    }

    /**
     * Record where a session was standing, and hand back the home it will be restored to.
     *
     * <p><b>The first one wins.</b> A session that stages a second subject without leaving in between
     * is already in the studio, so taking its position again would write "home is the studio" over
     * the only record of where it actually came from — a restore that runs, reports success and puts
     * nobody anywhere. Whoever calls this gets the home that is now in force, which may be the one
     * they offered or the one already held.
     */
    public static Home rememberHome(final String owner, final Home home) {
        synchronized (AWAY) {
            final Home held = AWAY.get(owner);
            if (held != null) {
                return held;
            }
            AWAY.put(owner, home);
            return home;
        }
    }

    /** The home this session is owed, removed from the store. Null when it never left. */
    public static @Nullable Home takeHome(final String owner) {
        return AWAY.remove(owner);
    }

    /** Every stage standing in the studio right now. Read for reporting, never for arbitration. */
    public static List<Staged> all() {
        synchronized (STAGED) {
            return List.copyOf(STAGED.values());
        }
    }

    // ---------------------------------------------------------------------------------------------
    // staging

    /**
     * Stage a loaded structure template. This is the case the studio exists for: a piece that lives
     * as an {@code .nbt} and has nowhere to stand, photographed without first being built into
     * somebody's world.
     */
    public static Staged stage(final MinecraftServer server, final String owner, final Identifier id) {
        final Optional<StructureTemplate> maybe = server.getStructureManager().get(id);
        if (maybe.isEmpty()) {
            throw new IllegalArgumentException("no loaded structure template '" + id + "'."
                + " query_registry {registry:\"structure_template\"} lists what is loaded; a template"
                + " just written into the live datapack needs a reload_data before the game can see it.");
        }
        final StructureTemplate template = maybe.get();
        final Vec3i size = template.getSize(Rotation.NONE);
        if (size.getX() < 1 || size.getY() < 1 || size.getZ() < 1) {
            throw new IllegalArgumentException("'" + id + "' has a degenerate size (" + size.getX()
                + "x" + size.getY() + "x" + size.getZ() + ") — there is nothing to photograph.");
        }
        return place(server, owner, template, size, id.toString());
    }

    /**
     * Stage a copy of blocks that are standing in a world right now — "photograph what I just built,
     * against nothing". The copy is taken through {@code StructureTemplate.fillFromWorld}, the same
     * engine {@code capture_structure} runs, so a subject that would capture cleanly stages cleanly
     * and one that would not fails the same way. Nothing is written to disk: the template lives for
     * the length of this call.
     */
    public static Staged stage(final MinecraftServer server, final String owner, final ServerLevel from,
                               final BlockPos min, final Vec3i size) {
        if (size.getX() < 1 || size.getY() < 1 || size.getZ() < 1) {
            throw new IllegalArgumentException("the subject box is " + size.getX() + "x" + size.getY()
                + "x" + size.getZ() + " — every axis must be at least one block.");
        }
        final long volume = (long) size.getX() * size.getY() * size.getZ();
        if (volume > MAX_CELLS) {
            throw new IllegalArgumentException("that subject is " + volume + " cells, past the "
                + MAX_CELLS + " a capture may cover — photograph it where it stands with `look_at`,"
                + " or stage one piece of it.");
        }
        // Page the footprint in before reading it. fillFromWorld reads cell by cell and an absent
        // chunk answers AIR — which is indistinguishable, in the staged copy, from a room with a wall
        // missing. capture_structure refuses in that case; here the columns are simply loaded, since
        // the caller is photographing a place they are looking at rather than authoring a file.
        for (int cx = SectionPos.blockToSectionCoord(min.getX());
             cx <= SectionPos.blockToSectionCoord(min.getX() + size.getX() - 1); cx++) {
            for (int cz = SectionPos.blockToSectionCoord(min.getZ());
                 cz <= SectionPos.blockToSectionCoord(min.getZ() + size.getZ() - 1); cz++) {
                from.getChunk(cx, cz);
            }
        }
        final StructureTemplate template = new StructureTemplate();
        template.fillFromWorld(from, min, size, false, List.of(Blocks.STRUCTURE_VOID));
        return place(server, owner, template, size, from.dimension().identifier() + " "
            + min.getX() + " " + min.getY() + " " + min.getZ());
    }

    /** The shared half: allocate a region, empty it, put the subject down, and look at what landed. */
    private static Staged place(final MinecraftServer server, final String owner,
                                final StructureTemplate template, final Vec3i size, final String from) {
        final ServerLevel studio = Canvas.level(server, Canvas.STUDIO);
        if (studio == null) {
            throw new IllegalStateException(Canvas.absentMessage(server));
        }
        final long volume = (long) size.getX() * size.getY() * size.getZ();
        if (volume > MAX_CELLS) {
            throw new IllegalArgumentException("that subject is " + volume + " cells, past the "
                + MAX_CELLS + " a stage may cover.");
        }
        final int slot = slotFor(owner);
        final BlockPos origin = Canvas.slotOrigin(slot);
        // Clear BEFORE placing, always: this session's own previous subject is standing here, and a
        // new one placed over it would photograph as both. A living one too.
        discardEntity(studio, owner);
        sweep(studio, origin, size);
        if (!template.placeInWorld(studio, origin, origin,
                new StructurePlaceSettings().setIgnoreEntities(true),
                RandomSource.create(), Block.UPDATE_CLIENTS)) {
            sweep(studio, origin, size);
            throw new IllegalArgumentException("that subject placed nothing — its palette is empty or"
                + " its size is degenerate on some axis. Nothing was staged.");
        }

        // What actually landed, read back off the world rather than counted off the template: this is
        // the number the witnesses are drawn from, and a subject nobody can see is not a photograph.
        final List<BlockPos> witnesses = new ArrayList<>();
        final Set<Long> chunks = new LinkedHashSet<>();
        int blocks = 0;
        final BlockPos.MutableBlockPos probe = new BlockPos.MutableBlockPos();
        for (int x = 0; x < size.getX(); x++) {
            for (int y = 0; y < size.getY(); y++) {
                for (int z = 0; z < size.getZ(); z++) {
                    probe.set(origin.getX() + x, origin.getY() + y, origin.getZ() + z);
                    if (studio.getBlockState(probe).isAir()) {
                        continue;
                    }
                    blocks++;
                    // Spread by COLUMN, because a column is the unit a chunk packet carries and the
                    // wait this feeds is really a wait for those packets.
                    final long column = (SectionPos.blockToSectionCoord(probe.getX()) & 0xFFFFFFFFL)
                        | ((long) SectionPos.blockToSectionCoord(probe.getZ()) << 32);
                    if (witnesses.size() < MAX_WITNESSES && chunks.add(column)) {
                        witnesses.add(probe.immutable());
                    }
                }
            }
        }
        if (blocks == 0) {
            sweep(studio, origin, size);
            throw new IllegalArgumentException("that subject is entirely air, so the studio would"
                + " photograph as an empty studio. Nothing was staged.");
        }

        final BlockPos stand = origin.offset(-STAND_OFFSET, 0, -STAND_OFFSET);
        pad(studio, stand);
        final Staged staged = new Staged(owner, slot, origin, size, from, blocks,
            List.copyOf(witnesses), stand);
        STAGED.put(owner, staged);
        return staged;
    }

    /**
     * The caller's own region emptied and forgotten. Returns what was swept, or null when this
     * session had nothing staged — which is an answer, not a failure.
     */
    public static @Nullable Staged clear(final MinecraftServer server, final String owner) {
        final Staged staged = STAGED.remove(owner);
        if (staged == null) {
            return null;
        }
        final ServerLevel studio = Canvas.level(server, Canvas.STUDIO);
        if (studio != null) {
            discardEntity(studio, owner);
            sweep(studio, staged.origin(), staged.size());
        } else {
            ENTITIES.remove(owner);
        }
        return staged;
    }

    // ---------------------------------------------------------------------------------------------
    // geometry

    /**
     * This session's slot: the one it already holds, or the lowest nobody else is staged in. An owner
     * keeps its slot for the life of the game, so a session that shoots twenty subjects leaves one
     * region behind rather than twenty.
     */
    private static int slotFor(final String owner) {
        final Staged mine = STAGED.get(owner);
        if (mine != null) {
            return mine.slot();
        }
        synchronized (STAGED) {
            for (int slot = 0; ; slot++) {
                final int candidate = slot;
                if (STAGED.values().stream().noneMatch(s -> s.slot() == candidate)) {
                    return candidate;
                }
            }
        }
    }

    /**
     * Empty the whole working region — the subject's box, the margin around it, and the pad below.
     * Both the placement and the sweep compute it from {@code (origin, size)} here, so a region that
     * is cleared is exactly the region that was written.
     */
    private static void sweep(final ServerLevel studio, final BlockPos origin, final Vec3i size) {
        final BlockState air = Blocks.AIR.defaultBlockState();
        for (int x = origin.getX() - MARGIN; x < origin.getX() + size.getX() + MARGIN; x++) {
            for (int z = origin.getZ() - MARGIN; z < origin.getZ() + size.getZ() + MARGIN; z++) {
                for (int y = origin.getY() - 1; y < origin.getY() + size.getY() + MARGIN; y++) {
                    studio.setBlock(new BlockPos(x, y, z), air, Block.UPDATE_CLIENTS);
                }
            }
        }
    }

    /** The invisible floor, one block below the standing spot. */
    private static void pad(final ServerLevel studio, final BlockPos stand) {
        for (int x = -PAD_RADIUS; x <= PAD_RADIUS; x++) {
            for (int z = -PAD_RADIUS; z <= PAD_RADIUS; z++) {
                studio.setBlock(stand.offset(x, -1, z), PAD, Block.UPDATE_CLIENTS);
            }
        }
    }
}
