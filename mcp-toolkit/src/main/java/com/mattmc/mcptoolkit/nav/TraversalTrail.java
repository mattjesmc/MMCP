package com.mattmc.mcptoolkit.nav;

import java.util.ArrayList;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.level.Level;

/**
 * The body's <b>proprioception trail</b> (SURVIVAL_MODE_PLAN.md §4): cells the grounded navigations
 * actually passed through, recorded AS they are reached with what the cells really contained —
 * feet, head, and the ground underfoot, by real block id. A swimming body's feet honestly record
 * water; nothing is assumed air. Node-side capture turns a drained trail into a legal
 * {@code proprioception} observation ("a player knows the corridor they walked through").
 *
 * <p>One cell per REACHED path node — the same granularity the search planned at, so the trail is
 * the plan's reconciliation, not a per-tick position log.
 */
public final class TraversalTrail {

    /** Trail ceiling per drain — a 512-node path cannot flood a verdict. Drains report hitting it. */
    public static final int CAP = 256;

    /** One reached cell: feet position + what feet/head/ground REALLY were at traversal time. */
    public record Cell(int x, int y, int z, String feet, String head, String ground) {}

    private final List<Cell> cells = new ArrayList<>();
    private boolean truncated;

    /** Record the feet cell {@code feetPos} as reached, reading its true contents NOW. */
    public void record(final Level level, final BlockPos feetPos) {
        if (cells.size() >= CAP) {
            truncated = true; // reported by the drain — a silent cap would read as full coverage
            return;
        }
        cells.add(new Cell(feetPos.getX(), feetPos.getY(), feetPos.getZ(),
            id(level, feetPos), id(level, feetPos.above()), id(level, feetPos.below())));
    }

    /** The trail since the last drain; clears. {@code wasTruncated()} BEFORE calling this. */
    public List<Cell> drain() {
        List<Cell> out = List.copyOf(cells);
        cells.clear();
        truncated = false;
        return out;
    }

    /** Did the trail hit {@link #CAP} since the last drain (cells were dropped)? */
    public boolean wasTruncated() {
        return truncated;
    }

    private static String id(final Level level, final BlockPos pos) {
        return BuiltInRegistries.BLOCK.getKey(level.getBlockState(pos).getBlock()).toString();
    }
}
