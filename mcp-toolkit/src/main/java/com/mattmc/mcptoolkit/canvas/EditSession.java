package com.mattmc.mcptoolkit.canvas;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.mattmc.mcptoolkit.McpToolkit;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Vec3i;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.Identifier;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import net.minecraft.world.phys.AABB;
import org.jspecify.annotations.Nullable;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * <b>One open edit: a structure id, a place in the canvas, and a frame.</b>
 * ({@code RENDER_SEAM_DESIGN.md} §10.2 — the session binding is the first of the three things the
 * loop was missing.)
 *
 * <p>{@code capture_structure} requires {@code min} and {@code size} explicitly and infers neither,
 * because "a piece captured one block off draws with a seam and nothing says so". That is right and
 * this class does not undo it: it <b>remembers</b> the two, so a human's save is one word instead of
 * six coordinates, and the remembered box is the frame they can see — never the template's own size.
 * §10.3 is the whole reason: the moment someone adds an eave one block outside a template-sized
 * capture box, the save truncates silently and the loss surfaces later as a seam.
 *
 * <h2>Two things this record deliberately does</h2>
 *
 * <p><b>Slots are allocated, not chosen.</b> The canvas is shared — that is the point of it being a
 * dimension rather than a throwaway world — so two sessions choosing their own origin is
 * {@code [[probe-site-ownership]]} again, where concurrent files sharing one site produced a "dig
 * timing" mystery that had nothing to do with digging. {@link #allocate} hands out the lowest free
 * slot and nobody asks for a coordinate.
 *
 * <p><b>Sessions persist to the world folder.</b> An edit that survives an hour must survive a
 * restart, or a crash mid-build silently becomes "which box was I capturing?" — and the answer to
 * that question is not recoverable from the blocks, which is exactly the shape of loss trap 11 is
 * about. The file holds the frame, not the blocks; the blocks were always in the world.
 */
public record EditSession(
    String owner,
    @Nullable Identifier id,
    ResourceKey<Level> dimension,
    int slot,
    BlockPos origin,
    Vec3i size,
    @Nullable Vec3i openedSize
) {

    /** Sessions in memory, keyed by owner. Re-read from disk on every server start. */
    private static final Map<String, EditSession> OPEN = new LinkedHashMap<>();

    // ---------------------------------------------------------------------------------------------
    // geometry

    /** The frame's maximum corner, inclusive. */
    public BlockPos max() {
        return origin.offset(size.getX() - 1, size.getY() - 1, size.getZ() - 1);
    }

    /** The frame as a bounding box, inclusive on both corners. */
    public BoundingBox box() {
        final BlockPos max = max();
        return BoundingBox.fromCorners(origin, max);
    }

    /** The frame as the gizmo draws it: the outer surface of the cells, not their centres. */
    public AABB aabb() {
        return new AABB(origin.getX(), origin.getY(), origin.getZ(),
            origin.getX() + size.getX(), origin.getY() + size.getY(), origin.getZ() + size.getZ());
    }

    public long volume() {
        return (long) size.getX() * size.getY() * size.getZ();
    }

    /** The same session with a different frame — the record is immutable, the store is not. */
    public EditSession withFrame(final BlockPos newOrigin, final Vec3i newSize) {
        return new EditSession(owner, id, dimension, slot, newOrigin, newSize, openedSize);
    }

    /** True when the frame is no longer the size the template was opened at. */
    public boolean frameMoved() {
        return openedSize != null && !openedSize.equals(size);
    }

    public String describe() {
        return (id == null ? "(blank frame)" : id.toString())
            + " in " + dimension.identifier()
            + " at " + origin.getX() + " " + origin.getY() + " " + origin.getZ()
            + ", frame " + size.getX() + "x" + size.getY() + "x" + size.getZ()
            + (frameMoved() ? " (grown from " + openedSize.getX() + "x" + openedSize.getY()
                + "x" + openedSize.getZ() + ")" : "");
    }

    // ---------------------------------------------------------------------------------------------
    // the store

    public static @Nullable EditSession of(final String owner) {
        return OPEN.get(owner);
    }

    public static List<EditSession> all() {
        return List.copyOf(OPEN.values());
    }

    public static void put(final MinecraftServer server, final EditSession session) {
        OPEN.put(session.owner(), session);
        persist(server);
    }

    public static @Nullable EditSession remove(final MinecraftServer server, final String owner) {
        final EditSession gone = OPEN.remove(owner);
        if (gone != null) {
            persist(server);
        }
        return gone;
    }

    /** The lowest slot nobody is standing in. Never the caller's choice — see the class javadoc. */
    public static int allocate() {
        for (int slot = 0; ; slot++) {
            final int candidate = slot;
            if (OPEN.values().stream().noneMatch(s -> s.slot() == candidate)) {
                return candidate;
            }
        }
    }

    // ---------------------------------------------------------------------------------------------
    // persistence

    /**
     * Per WORLD, not per game directory. A session names blocks that exist in one save; the review
     * layer's {@code server.getFile} home would follow the workspace into a different world and point
     * at a frame that is not there.
     */
    public static Path file(final MinecraftServer server) {
        return server.getWorldPath(net.minecraft.world.level.storage.LevelResource.ROOT)
            .resolve("mcptoolkit-canvas.json");
    }

    /** Read the store. A missing file is an empty store rather than an error — the normal first run. */
    public static void load(final MinecraftServer server) {
        OPEN.clear();
        final Path path = file(server);
        if (!Files.isRegularFile(path)) {
            return;
        }
        try {
            final JsonElement root = JsonParser.parseString(Files.readString(path, StandardCharsets.UTF_8));
            for (final JsonElement element : root.getAsJsonArray()) {
                final EditSession session = fromJson(element.getAsJsonObject());
                if (session != null) {
                    OPEN.put(session.owner(), session);
                }
            }
        } catch (final Exception e) {
            // A store that will not parse is reported and stepped over: refusing to start the server
            // over a bookkeeping file would be a worse failure than losing the frames it held.
            McpToolkit.LOGGER.warn("[canvas] could not read {}: {}", path, e.toString());
        }
    }

    private static void persist(final MinecraftServer server) {
        final JsonArray array = new JsonArray();
        OPEN.values().forEach(s -> array.add(s.toJson()));
        try {
            Files.writeString(file(server), array.toString().replace("},{", "},\n{") + "\n",
                StandardCharsets.UTF_8);
        } catch (final Exception e) {
            McpToolkit.LOGGER.error("[canvas] could not write {}: {}", file(server), e.toString());
        }
    }

    private JsonObject toJson() {
        final JsonObject o = new JsonObject();
        o.addProperty("owner", owner);
        if (id != null) {
            o.addProperty("id", id.toString());
        }
        o.addProperty("dimension", dimension.identifier().toString());
        o.addProperty("slot", slot);
        o.add("origin", vec(origin.getX(), origin.getY(), origin.getZ()));
        o.add("size", vec(size.getX(), size.getY(), size.getZ()));
        if (openedSize != null) {
            o.add("opened_size", vec(openedSize.getX(), openedSize.getY(), openedSize.getZ()));
        }
        return o;
    }

    private static @Nullable EditSession fromJson(final JsonObject o) {
        try {
            final Vec3i origin = readVec(o.getAsJsonObject("origin"));
            final Vec3i size = readVec(o.getAsJsonObject("size"));
            return new EditSession(
                o.get("owner").getAsString(),
                o.has("id") ? Identifier.parse(o.get("id").getAsString()) : null,
                ResourceKey.create(Registries.DIMENSION, Identifier.parse(o.get("dimension").getAsString())),
                o.get("slot").getAsInt(),
                new BlockPos(origin.getX(), origin.getY(), origin.getZ()),
                size,
                o.has("opened_size") ? readVec(o.getAsJsonObject("opened_size")) : null);
        } catch (final Exception e) {
            McpToolkit.LOGGER.warn("[canvas] skipping an unreadable session entry: {}", e.toString());
            return null;
        }
    }

    private static JsonObject vec(final int x, final int y, final int z) {
        final JsonObject o = new JsonObject();
        o.addProperty("x", x);
        o.addProperty("y", y);
        o.addProperty("z", z);
        return o;
    }

    private static Vec3i readVec(final JsonObject o) {
        return new Vec3i(o.get("x").getAsInt(), o.get("y").getAsInt(), o.get("z").getAsInt());
    }

    /** Every session standing in one canvas level — what {@link CanvasFrame} draws. */
    static List<EditSession> in(final ResourceKey<Level> dimension) {
        final List<EditSession> out = new ArrayList<>();
        OPEN.values().stream().filter(s -> s.dimension().equals(dimension)).forEach(out::add);
        return out;
    }

    /** Present so a caller can ask without importing Optional semantics into every branch. */
    public static Optional<EditSession> find(final String owner) {
        return Optional.ofNullable(OPEN.get(owner));
    }
}
