package com.mattmc.mcptoolkit;

import com.google.gson.JsonObject;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.TicketType;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.chunk.ChunkAccess;
import net.minecraft.world.level.chunk.status.ChunkStatus;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

/**
 * The read-side support machinery every observe tool shares: on-demand chunk residency
 * ({@link ChunkLoader}), the coverage envelope ({@link #coverage}), and chunk-walk clamping for
 * segment reads. Promoted out of {@link WorldPerceptionTools} (2026-07-22) so new observe tools —
 * the {@code check_*} predicates, region rollups — ride the same never-generate, honest-coverage
 * contract instead of reimplementing it. Package-private on purpose: this is toolkit plumbing,
 * not API.
 */
final class ReadSupport {
    private ReadSupport() {}

    // ---- on-demand chunk residency -------------------------------------------

    /** Chunks one perception call may pull in before it starts reporting the remainder as unread. */
    private static final int LOAD_MAX_CHUNKS = 48;
    /**
     * Wall-clock ceiling on that paging, so one wide read can never stall the server thread.
     * Measured on this project's dev world: paging an existing chunk in costs ~12-16ms, so the
     * chunk count above is what normally binds and this is the backstop for a cold or slow disk.
     */
    private static final long LOAD_BUDGET_NANOS = 1_500_000_000L;
    /**
     * The ticket a read installs to pull a chunk in: loads, does <em>not</em> simulate, expires by
     * itself, and is never written to the save.
     *
     * <p>Deliberately the opposite of the {@code FORCED} ticket that {@code /forceload} installs
     * (persist | load | simulate | keep-dimension-active, and no timeout at all): that one leaves
     * the world ticking and survives restarts, which is why a forgotten one is permanent. Looking
     * at something should not do either. The timeout also makes this leak-proof — there is no
     * unload call to skip if the read throws halfway through.
     */
    private static final TicketType READ_TICKET = new TicketType(
        100L, TicketType.FLAG_LOADING | TicketType.FLAG_CAN_EXPIRE_IF_UNLOADED);

    /**
     * Pulls chunks in on demand so callers need not pre-stage the world by hand — but only chunks
     * that already exist. <b>Reading never runs world generation.</b>
     *
     * <p>The two costs are not comparable. Measured on this project's dev world: paging an existing
     * chunk in off disk takes ~12-16ms, while generating a virgin one takes <b>~900ms</b> — because
     * taking a chunk to FULL drags its neighbours through the generation pyramid out to
     * {@code ChunkStatus.MAX_STRUCTURE_DISTANCE} (8), so one virgin chunk touches hundreds of chunk
     * slots. A single generated chunk therefore costs more than an entire wide survey of existing
     * terrain, which makes implicit generation indefensible: looking at a map would silently create
     * world, slowly.
     *
     * <p>So a virgin chunk is reported, not paid for. Deliberately creating terrain stays available
     * through {@code run_command}'s {@code forceload}, where it is audited as {@code privileged}
     * rather than hidden inside an observe. Paging is additionally bounded by a chunk count and a
     * wall-clock deadline, whichever binds first.
     */
    static final class ChunkLoader {
        private final ServerLevel level;
        private final boolean enabled;
        private final long deadline = System.nanoTime() + LOAD_BUDGET_NANOS;
        private final java.util.HashSet<Long> ready = new java.util.HashSet<>();
        private final java.util.HashSet<Long> refused = new java.util.HashSet<>();
        private int resident;
        private int paged;
        private int ungenerated;
        private boolean budgetSpent;

        ChunkLoader(final ServerLevel level, final boolean enabled) {
            this.level = level;
            this.enabled = enabled;
        }

        /** True when the column at {@code probe} can be read — paging its chunk in first if needed. */
        boolean ensure(final BlockPos probe) {
            int cx = probe.getX() >> 4;
            int cz = probe.getZ() >> 4;
            long key = ChunkPos.pack(cx, cz);
            if (ready.contains(key)) {
                return true;
            }
            if (refused.contains(key)) {
                return false;
            }
            if (level.isLoaded(probe)) {
                ready.add(key);
                resident++;
                return true;
            }
            if (!enabled) {
                refused.add(key);
                return false;
            }
            if (paged >= LOAD_MAX_CHUNKS || System.nanoTime() > deadline) {
                budgetSpent = true;
                refused.add(key);
                return false;
            }
            // Probe at EMPTY — the first status, below where the generation pyramid begins. This
            // deserialises the chunk if the region file has it and fabricates a blank one if not,
            // either way without running worldgen. `getPersistedStatus` then says which happened.
            ChunkAccess probed = level.getChunkSource().getChunk(cx, cz, ChunkStatus.EMPTY, true);
            if (probed == null || !probed.getPersistedStatus().isOrAfter(ChunkStatus.FULL)) {
                ungenerated++;
                refused.add(key);
                return false;
            }
            ChunkPos pos = new ChunkPos(cx, cz);
            // Ticket first so the chunk lingers for the rest of this read (and any follow-up within
            // its timeout); the blocking get is what actually completes it to FULL.
            level.getChunkSource().addTicketWithRadius(READ_TICKET, pos, 0);
            if (level.getChunkSource().getChunk(cx, cz, ChunkStatus.FULL, true) == null) {
                refused.add(key);
                return false;
            }
            paged++;
            ready.add(key);
            return true;
        }

        /** Null when nothing had to be pulled in — the common case, and not worth a line of output. */
        @Nullable JsonObject report() {
            if (paged == 0 && ungenerated == 0) {
                return null;
            }
            JsonObject o = new JsonObject();
            o.addProperty("resident", resident);
            o.addProperty("paged_in", paged);
            o.addProperty("ungenerated", ungenerated);
            return o;
        }

        /** Why columns went unread, in the caller's words — the remedies differ per cause. */
        String shortfallReason() {
            if (!enabled) {
                return "loading is off for this call (load:false)";
            }
            if (ungenerated > 0 && budgetSpent) {
                return ungenerated + " chunk(s) have never been generated (reading does not create "
                    + "terrain — forceload them via run_command if you mean to), and the load budget "
                    + "ran out on the rest";
            }
            if (ungenerated > 0) {
                return ungenerated + " chunk(s) have never been generated; reading does not create "
                    + "terrain — forceload them via run_command if you actually mean to create it";
            }
            return "the chunk-loading budget ran out — read a smaller area, or repeat the call to "
                + "continue where this one stopped";
        }
    }

    /**
     * Ground-height stats over a set of columns — the numbers {@code check_site} and
     * {@code get_region_summary} share (write once, per the representation design).
     */
    static JsonObject groundStats(final java.util.List<Integer> heights) {
        int min = Integer.MAX_VALUE;
        int max = Integer.MIN_VALUE;
        double sum = 0;
        for (int y : heights) {
            min = Math.min(min, y);
            max = Math.max(max, y);
            sum += y;
        }
        double mean = sum / heights.size();
        double var = 0;
        for (int y : heights) {
            var += (y - mean) * (y - mean);
        }
        JsonObject o = new JsonObject();
        o.addProperty("min", min);
        o.addProperty("max", max);
        o.addProperty("mean", Math.round(mean * 10.0) / 10.0);
        o.addProperty("stddev", Math.round(Math.sqrt(var / heights.size()) * 100.0) / 100.0);
        return o;
    }

    /** Top-{@code cap} entries by count, the rest collapsed into {@code "other"}. */
    static JsonObject histogram(final java.util.Map<String, Integer> counts, final int cap) {
        JsonObject h = new JsonObject();
        int other = 0;
        int emitted = 0;
        for (var e : counts.entrySet().stream()
            .sorted(java.util.Map.Entry.<String, Integer>comparingByValue().reversed()).toList()) {
            if (emitted < cap) {
                h.addProperty(e.getKey(), e.getValue());
                emitted++;
            } else {
                other += e.getValue();
            }
        }
        if (other > 0) {
            h.addProperty("other", other);
        }
        return h;
    }

    /** Whether a perception call may pull chunks in; on by default. */
    static boolean loadArg(final JsonObject a) {
        return !a.has("load") || a.get("load").isJsonNull() || a.get("load").getAsBoolean();
    }

    /** Chunk-column visitor for {@link #walkChunks}; return false to stop the walk at this column. */
    interface ChunkColumnVisitor {
        boolean visit(int cx, int cz);
    }

    /**
     * Walk the chunk columns a segment crosses, in traversal order, until the visitor refuses one.
     * Returns the parameter {@code t} in [0,1] up to which every crossed column was accepted — 1.0
     * means the whole segment lies in accepted columns. 2D on purpose: chunks are full-height, so a
     * ray only changes column at x/z chunk boundaries.
     */
    static double walkChunks(final Vec3 from, final Vec3 to, final ChunkColumnVisitor visitor) {
        double dx = to.x - from.x;
        double dz = to.z - from.z;
        int cx = ((int) Math.floor(from.x)) >> 4;
        int cz = ((int) Math.floor(from.z)) >> 4;
        if (!visitor.visit(cx, cz)) {
            return 0.0;
        }
        int stepX = dx > 0 ? 1 : -1;
        int stepZ = dz > 0 ? 1 : -1;
        double tMaxX = dx == 0 ? Double.POSITIVE_INFINITY
            : ((dx > 0 ? (cx + 1) << 4 : cx << 4) - from.x) / dx;
        double tMaxZ = dz == 0 ? Double.POSITIVE_INFINITY
            : ((dz > 0 ? (cz + 1) << 4 : cz << 4) - from.z) / dz;
        double tDeltaX = dx == 0 ? Double.POSITIVE_INFINITY : 16.0 / Math.abs(dx);
        double tDeltaZ = dz == 0 ? Double.POSITIVE_INFINITY : 16.0 / Math.abs(dz);
        while (true) {
            double tNext = Math.min(tMaxX, tMaxZ);
            if (tNext >= 1.0) {
                return 1.0; // the rest of the segment stays inside already-accepted columns
            }
            if (tMaxX <= tMaxZ) {
                cx += stepX;
                tMaxX += tDeltaX;
            } else {
                cz += stepZ;
                tMaxZ += tDeltaZ;
            }
            if (!visitor.visit(cx, cz)) {
                // Stop just short of the boundary so the clamped segment stays in accepted columns.
                return Math.max(0.0, tNext - 1.0e-4);
            }
        }
    }

    /**
     * Clamp a ray to chunks the loader can supply. Vanilla {@code Level.clip} resolves every chunk it
     * crosses through the blocking load-or-generate path — so an unclamped ray into virgin terrain
     * would silently create world from an observe call and stall the server thread for seconds per
     * chunk, the exact failure {@link ChunkLoader} exists to prevent. Returns {@code to} unchanged
     * when the whole ray is readable (reference-comparable for a cheap truncation check).
     */
    static Vec3 clampToReadable(final ChunkLoader loader, final Vec3 from, final Vec3 to) {
        int y = (int) Math.floor(from.y);
        double t = walkChunks(from, to, (cx, cz) -> loader.ensure(new BlockPos(cx << 4, y, cz << 4)));
        if (t >= 1.0) {
            return to;
        }
        return from.add(to.subtract(from).scale(t));
    }

    /** True when every chunk column the segment crosses is resident (no paging — a cheap residency test). */
    static boolean segmentChunksLoaded(final ServerLevel level, final Vec3 from, final Vec3 to) {
        int y = (int) Math.floor(from.y);
        return walkChunks(from, to, (cx, cz) -> level.isLoaded(new BlockPos(cx << 4, y, cz << 4))) >= 1.0;
    }

    /**
     * Coverage verdict for a never-force-load read: how much of the requested extent was actually
     * readable, stated loudly enough that an unread result cannot be mistaken for an empty one.
     *
     * <p>Reads pull chunks in on demand ({@link ChunkLoader}), so a short read of somewhere nobody
     * stands normally comes back complete. What remains partial is what the loader's budget refused:
     * with no player nearby that can still be most of a wide grid, and the histogram/bbox/anomaly
     * outputs then describe only the columns that were actually reachable — or nothing at all, which
     * would otherwise read as a confident "there is nothing here". `state` is the field to branch
     * on: <b>none</b> means this result describes no world state whatsoever.
     */
    static JsonObject coverage(final int read, final int unloaded, final int requested,
                               final boolean truncated, final @Nullable ChunkLoader loader) {
        JsonObject c = new JsonObject();
        c.addProperty("requested", requested);
        c.addProperty("read", read);
        c.addProperty("unloaded", unloaded);
        if (loader != null) {
            JsonObject chunks = loader.report();
            if (chunks != null) {
                c.add("chunks", chunks);
            }
        }
        // Truncation stops the sweep early, so columns beyond the cut were never even looked at —
        // they are neither read nor known-unloaded, and quoting "unloaded of visited" as the ratio
        // would understate what was actually asked for.
        c.addProperty("unvisited", Math.max(0, requested - read - unloaded));
        // "complete" has to mean "I read everything you asked for", so a budget-truncated read is
        // partial too — otherwise an agent branching on state alone treats a capped scan as exhaustive.
        String state = read == 0 ? "none" : (read == requested ? "complete" : "partial");
        c.addProperty("state", state);
        // Existing chunks are pulled in automatically, so an unread column has a specific cause —
        // loading off, never-generated terrain, or a spent budget — and each wants a different fix.
        String unloadedRemedy = loader == null
            ? "those chunks are not resident"
            : loader.shortfallReason();
        if (read == 0) {
            c.addProperty("note", "NOTHING WAS READ — none of the " + requested + " requested columns "
                + "were readable: " + unloadedRemedy + ". This result describes no world state at all; "
                + "absence here is not evidence of absence.");
        } else if (read < requested) {
            // The two shortfalls have different remedies — load more vs. ask for less — so they stay
            // distinguishable rather than collapsing into one undifferentiated "partial".
            StringBuilder sb = new StringBuilder();
            sb.append("Read ").append(read).append(" of ").append(requested).append(" requested columns");
            if (unloaded > 0) {
                sb.append("; ").append(unloaded).append(" were not readable (").append(unloadedRemedy).append(")");
            }
            if (truncated) {
                sb.append("; the rest were cut by the response budget (ask for a smaller grid, or see "
                    + "covered_radius)");
            }
            sb.append(". Conclusions hold only for the ").append(read).append(" columns actually read.");
            c.addProperty("note", sb.toString());
        }
        return c;
    }
}
