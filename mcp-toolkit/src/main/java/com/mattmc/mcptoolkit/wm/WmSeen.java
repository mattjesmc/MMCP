package com.mattmc.mcptoolkit.wm;

import com.mattmc.mcptoolkit.McpToolkit;
import it.unimi.dsi.fastutil.longs.LongOpenHashSet;
import net.minecraft.core.BlockPos;
import net.minecraft.util.Mth;
import net.minecraft.world.entity.LivingEntity;
import org.jspecify.annotations.Nullable;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.LongConsumer;
import java.util.function.LongPredicate;

/**
 * The per-session seen-cell set — CHECK_PATH_AUDIT.md R2's other half of the Sightlines tap ("one
 * tap, two consumers"): every cell a session's body has legally observed, fed from the same walks
 * the recorder serializes plus the body's own traversal. The knowledge-masked solve consults it so
 * a survival {@code check_path} can answer from HELD knowledge — unknown ≠ blocked, and a verdict
 * that would need unseen terrain says so instead of disclosing it.
 *
 * <p><b>Independent of recording</b>: legality does not switch off when the dataset does. The cost
 * is a hash-set add per visited cell — noise against the walks themselves.
 *
 * <p>Sources, and why each is legal provenance: ray-walked cells (every cell a fan/raycast/gait
 * ray visited, air included — certified-clear IS knowledge, §2.4); the body's own feet/head/floor
 * each tick (proprioception — you know what you stand on). Act outcomes (mined/placed cells) are
 * not fed separately: the act's own dig watch has already ray-walked them in practice, and adding
 * a third feed for cells the first two nearly always cover buys complexity, not legality.
 *
 * <p>Keyed by session (not body): knowledge belongs to the AGENT, which survives its bodies —
 * respawn does not amnesia the map, exactly as the Node-side observation store behaves. Sets die
 * with their session (the DroneTools reap calls {@link #drop}), and anonymous callers share the
 * {@code anon} set, mirroring the anon slot.
 */
public final class WmSeen {
    private WmSeen() {}

    private static final String ANON = "anon";
    /** Backstop against unbounded growth on a long-lived server (a set this size is ~10h of
     *  continuous fanning). Hitting it logs once and stops adding — stale knowledge stays valid;
     *  NEW terrain then honestly reads unknown, which errs legal. */
    private static final int CAP = 8_000_000;

    private static final Map<String, LongOpenHashSet> SETS = new ConcurrentHashMap<>();

    private static String key(final @Nullable String session) {
        return session == null || session.isBlank() ? ANON : session;
    }

    /** The walk-visitor for one session's observations — hand it to {@code Sightlines.walk}. */
    public static LongConsumer feed(final @Nullable String session) {
        LongOpenHashSet set = SETS.computeIfAbsent(key(session), k -> new LongOpenHashSet(1 << 16));
        return v -> {
            if (set.size() < CAP) {
                set.add(v);
            } else if (set.size() == CAP) {
                set.add(v); // push it over once so the log fires exactly once
                McpToolkit.LOGGER.warn("[MCP Toolkit] seen-set for a session hit its {}-cell cap — "
                    + "new terrain will read unknown to check_path until the session ends", CAP);
            }
        };
    }

    /**
     * Proprioception feed: what the body occupies and stands on, every tick - INCLUDING everything
     * between where it was last tick and where it is now. One sample per tick left holes: a walker
     * drifting one lane sideways at 0.2-0.28 blocks a tick can cross an x boundary and a z boundary
     * inside one tick, so neither of the two cells it passed through is ever sampled, and the
     * knowledge-masked solve (check_path under survival) then stops at a cell the body plainly
     * walked past - live at 0.124.0/0.125.0 with the recorder off (no gait fans to paper over it):
     * a straight eight-block walk left the corridor unknown from x+2 on. The segment is marched at
     * quarter-block steps, which is finer than any per-tick displacement a walking body makes.
     */
    public static void addBody(final @Nullable String session, final LivingEntity body) {
        LongConsumer feed = feed(session);
        double x1 = body.getX();
        double y1 = body.getY() + 1.0e-3;
        double z1 = body.getZ();
        double x0 = body.xo;
        double y0 = body.yo + 1.0e-3;
        double z0 = body.zo;
        double dx = x1 - x0;
        double dy = y1 - y0;
        double dz = z1 - z0;
        double len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        // A teleport (spawn, respawn, a shove across the map) is not a walk: feed only where it is.
        int steps = (len > 0 && len < 4.0) ? Math.max(1, (int) Math.ceil(len / 0.25)) : 0;
        int lastX = Integer.MIN_VALUE;
        int lastY = Integer.MIN_VALUE;
        int lastZ = Integer.MIN_VALUE;
        for (int i = steps; i >= 0; i--) {
            double t = steps == 0 ? 1.0 : (double) i / steps;
            int x = Mth.floor(x1 - dx * (1.0 - t));
            int y = Mth.floor(y1 - dy * (1.0 - t));
            int z = Mth.floor(z1 - dz * (1.0 - t));
            if (x == lastX && y == lastY && z == lastZ) {
                continue;
            }
            lastX = x;
            lastY = y;
            lastZ = z;
            feed.accept(BlockPos.asLong(x, y, z));
            feed.accept(BlockPos.asLong(x, y + 1, z));
            feed.accept(BlockPos.asLong(x, y - 1, z));
        }
    }

    /** The mask view for a solve: JDK-typed so the nav package needs no wm import. */
    public static LongPredicate view(final @Nullable String session) {
        LongOpenHashSet set = SETS.get(key(session));
        return set == null ? v -> false : set::contains;
    }

    /** How many cells this session has observed — for verdict notes and probes. */
    public static int size(final @Nullable String session) {
        LongOpenHashSet set = SETS.get(key(session));
        return set == null ? 0 : set.size();
    }

    /** Session ended: its knowledge goes with it (cross-session identity is the store's job). */
    public static void drop(final @Nullable String session) {
        SETS.remove(key(session));
    }
}
