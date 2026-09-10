package com.mattmc.mcptoolkit;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.commands.arguments.blocks.BlockInput;
import net.minecraft.core.BlockPos;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.Property;
import org.jspecify.annotations.Nullable;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Set;

/**
 * The transactional layer shared by every {@code world_edit} tool (ARCHITECTURE.md, "Transactional world
 * edits"): a bounded journal of applied edits, each identified by an {@code undo_id} and restorable
 * bit-identically. It generalizes the single-level undo that used to live inside {@code place_shape} — now
 * {@code place_shape}, {@code set_blocks}, and any future world-edit tool record here and share one
 * {@code undo_edit} / {@code list_edits} surface.
 *
 * <p><b>Fidelity.</b> An edit snapshots each changed cell's prior {@link BlockState} <em>and</em> its
 * block-entity NBT, and restores through vanilla {@link BlockInput} — so undoing an edit that overwrote a
 * chest brings the chest and its items back exactly, not just the block shell. This is what makes the
 * creative-edit eval ("undo restores the prior region bit-identically") pass.
 *
 * <p><b>Bounds, not silence.</b> The journal keeps the last {@link #MAX_EDITS} edits (older ids become
 * un-undoable, reported honestly as "unknown or evicted"); a single edit larger than {@link #UNDO_CAP}
 * cells is applied but not recorded (returns a null undo id), because holding an unbounded snapshot would
 * be the real hazard. No silent truncation of what's undoable.
 *
 * <p>All world-edit tools run on the server thread, so this is single-threaded by construction — no locking,
 * unlike the cross-thread {@link EventLog}.
 */
public final class EditJournal {
    private EditJournal() {}

    /** How many recent edits stay undoable. */
    private static final int MAX_EDITS = 32;
    /** An edit changing more cells than this is applied but not recorded (keeps snapshots bounded). */
    public static final int UNDO_CAP = 200_000;
    /** Quiet writes (no neighbour physics), matching how the world-edit tools place. */
    private static final int FLAGS = Block.UPDATE_CLIENTS;
    private static final Set<Property<?>> NO_PROPS = Set.of();

    private static final Deque<Edit> EDITS = new ArrayDeque<>();
    private static long seq = 0;

    /** A snapshot of one cell before it changed: its state and (if any) its block-entity NBT. */
    private record Cell(BlockPos pos, BlockState state, @Nullable CompoundTag nbt) {}

    private record Edit(String id, ServerLevel level, String tool, long gameTick,
                        List<Cell> before, int changed, int @Nullable [] bounds,
                        @Nullable String session) {}

    /** Begin recording an edit made by {@code tool} on {@code level}, attributed to {@code session}
     * (null = anonymous caller). The attribution is what lets a bare {@code undo_edit} default to
     * the caller's OWN latest edit instead of silently reverting another session's work. */
    public static Recorder recorder(final ServerLevel level, final String tool,
                                    final @Nullable String session) {
        return new Recorder(level, tool, session);
    }

    /**
     * Accumulates prior-state snapshots as a world-edit op runs. The tool calls {@link #capture} for each
     * cell it is about to change (passing the already-read current state so there is no double read), then
     * {@link #commit} once to file the edit and get its {@code undo_id}.
     */
    public static final class Recorder {
        private final ServerLevel level;
        private final String tool;
        private final @Nullable String session;
        private final List<Cell> cells = new ArrayList<>();
        private boolean overCap = false;

        private Recorder(final ServerLevel level, final String tool, final @Nullable String session) {
            this.level = level;
            this.tool = tool;
            this.session = session;
        }

        /** Snapshot the cell about to change. {@code prior} is its current state (block entity read here). */
        public void capture(final BlockPos pos, final BlockState prior) {
            if (overCap) {
                return;
            }
            if (cells.size() >= UNDO_CAP) {
                overCap = true;
                cells.clear(); // too large to keep; the op still applies, just isn't undoable
                return;
            }
            CompoundTag nbt = null;
            if (prior.hasBlockEntity()) {
                var be = level.getBlockEntity(pos);
                if (be != null) {
                    nbt = be.saveWithFullMetadata(level.registryAccess());
                }
            }
            cells.add(new Cell(pos.immutable(), prior, nbt));
        }

        public boolean overCap() {
            return overCap;
        }

        /** Discard the most recent capture — the write it anticipated was rejected by the world, so
         * that cell never changed and must not be "restored" by an undo. */
        public void dropLast() {
            if (!overCap && !cells.isEmpty()) {
                cells.remove(cells.size() - 1);
            }
        }

        /**
         * File the recorded snapshot as an undoable edit and return its id, or {@code null} if nothing was
         * recorded (dry run / zero changes / over cap) — in which case there is nothing to undo.
         */
        public @Nullable String commit(final int changed, final int @Nullable [] bounds) {
            if (overCap || cells.isEmpty() || changed == 0) {
                return null;
            }
            String id = "e-" + (++seq);
            EDITS.addLast(new Edit(id, level, tool, level.getGameTime(), cells, changed, bounds, session));
            while (EDITS.size() > MAX_EDITS) {
                EDITS.removeFirst();
            }
            return id;
        }
    }

    /**
     * Drop every recorded edit. Called at SERVER_STOPPING: an edit's snapshot is only restorable into
     * the level it was recorded against, and on the integrated server the process outlives worlds —
     * without this, world A's edits stay listed (pinning its ServerLevel) and {@code undo_edit} from
     * world B would "restore" into a closed level while reporting success.
     */
    public static void clear() {
        EDITS.clear();
    }

    /**
     * Undo the edit with {@code id}, restoring each cell in reverse. With no id, the default is the
     * {@code caller} session's own most recent edit — one global journal means "undo my last edit"
     * could silently revert another session's work and report success under the other session's tool
     * name. Undoing another session's edit stays possible, but only by explicit id.
     */
    public static JsonObject undo(final @Nullable String id, final @Nullable String caller) {
        Edit e = find(id, caller);
        if (e == null) {
            if (id != null) {
                throw new IllegalArgumentException("unknown or evicted edit id '" + id + "'");
            }
            throw new IllegalArgumentException(caller == null || EDITS.isEmpty()
                ? "no edits to undo"
                : "no edits made by your session to undo — pass `undo_id` explicitly to undo "
                    + "another session's edit (see list_edits)");
        }
        int restored = 0;
        List<Cell> notRestored = new ArrayList<>();
        List<Cell> cells = e.before();
        // Reverse order so overlapping writes within the edit come back in the order they were made.
        // The journal entry is removed only after every cell restored: a restore that throws mid-loop
        // must leave the un-restored remainder listed and retriable, not destroy the only record of it.
        for (int i = cells.size() - 1; i >= 0; i--) {
            Cell c = cells.get(i);
            try {
                // place() returning false means the cell was NOT rewritten (e.g. its chunk is no
                // longer resident) — counting it restored would sell a partial revert as complete.
                if (new BlockInput(c.state(), NO_PROPS, c.nbt()).place(e.level(), c.pos(), FLAGS)) {
                    restored++;
                } else {
                    notRestored.add(c);
                }
            } catch (RuntimeException ex) {
                EDITS.remove(e);
                List<Cell> remainder = new ArrayList<>(cells.subList(0, i + 1));
                remainder.addAll(notRestored);
                EDITS.addLast(new Edit(e.id(), e.level(), e.tool(), e.gameTick(),
                    remainder, remainder.size(), e.bounds(), e.session()));
                throw new IllegalStateException("undo of '" + e.id() + "' failed at "
                    + c.pos().toShortString() + " after restoring " + restored + " of " + cells.size()
                    + " cell(s): " + ex.getMessage() + " — the unrestored remainder stays listed under "
                    + "the same undo_id; retry undo_edit to continue", ex);
            }
        }
        EDITS.remove(e);
        if (!notRestored.isEmpty()) {
            // Same retriability contract as the exception path: the silently-refused cells stay
            // listed under the same id instead of vanishing behind a full-success envelope.
            EDITS.addLast(new Edit(e.id(), e.level(), e.tool(), e.gameTick(),
                new ArrayList<>(notRestored), notRestored.size(), e.bounds(), e.session()));
        }
        JsonObject r = new JsonObject();
        r.addProperty("undo_id", e.id());
        r.addProperty("tool", e.tool());
        r.addProperty("session", e.session());
        r.addProperty("restored", restored);
        if (!notRestored.isEmpty()) {
            r.addProperty("not_restored", notRestored.size());
            r.addProperty("note", notRestored.size() + " cell(s) could not be rewritten (chunk not "
                + "resident?) — they stay listed under the same undo_id; retry undo_edit to continue");
        }
        r.addProperty("game_tick", e.level().getGameTime());
        if (e.bounds() != null) {
            r.add("region", regionJson(e.bounds()));
        }
        return r;
    }

    /** The undoable edits, newest first. */
    public static JsonObject list() {
        JsonArray arr = new JsonArray();
        var it = EDITS.descendingIterator();
        while (it.hasNext()) {
            Edit e = it.next();
            JsonObject o = new JsonObject();
            o.addProperty("undo_id", e.id());
            o.addProperty("tool", e.tool());
            o.addProperty("session", e.session());
            o.addProperty("game_tick", e.gameTick());
            o.addProperty("changed", e.changed());
            if (e.bounds() != null) {
                o.add("region", regionJson(e.bounds()));
            }
            arr.add(o);
        }
        JsonObject r = new JsonObject();
        r.addProperty("count", EDITS.size());
        r.addProperty("capacity", MAX_EDITS);
        r.add("edits", arr);
        return r;
    }

    private static @Nullable Edit find(final @Nullable String id, final @Nullable String caller) {
        if (id == null) {
            if (caller == null) {
                return EDITS.peekLast(); // anonymous legacy caller: global latest, as before
            }
            var it = EDITS.descendingIterator();
            while (it.hasNext()) {
                Edit e = it.next();
                if (caller.equals(e.session())) {
                    return e;
                }
            }
            return null;
        }
        for (Edit e : EDITS) {
            if (e.id().equals(id)) {
                return e;
            }
        }
        return null;
    }

    /**
     * Stamp a world-edit tool response with the transactional envelope: {@code game_tick}, the
     * {@code dimension} actually written (identity over enforcement, same as the perception envelope —
     * a hidden dimension assumption is a silent-wrong-write path), the affected {@code region}
     * (min/max/size), and the {@code undo_id} (null on a dry run or an over-cap edit).
     */
    public static void stampEnvelope(final JsonObject r, final ServerLevel level,
                                     final int @Nullable [] bounds, final @Nullable String undoId) {
        r.addProperty("game_tick", level.getGameTime());
        r.addProperty("dimension", level.dimension().identifier().toString());
        if (bounds != null) {
            r.add("region", regionJson(bounds));
        }
        r.addProperty("undo_id", undoId);
    }

    /** Pack an inclusive min/max box as an {@code int[]} the envelope helpers understand. */
    public static int[] bounds(final int minX, final int minY, final int minZ,
                               final int maxX, final int maxY, final int maxZ) {
        return new int[] {minX, minY, minZ, maxX, maxY, maxZ};
    }

    private static JsonObject regionJson(final int[] b) {
        JsonObject o = new JsonObject();
        o.add("min", xyz(b[0], b[1], b[2]));
        o.add("max", xyz(b[3], b[4], b[5]));
        o.add("size", xyz(b[3] - b[0] + 1, b[4] - b[1] + 1, b[5] - b[2] + 1));
        return o;
    }

    private static JsonObject xyz(final int x, final int y, final int z) {
        JsonObject o = new JsonObject();
        o.addProperty("x", x);
        o.addProperty("y", y);
        o.addProperty("z", z);
        return o;
    }
}
