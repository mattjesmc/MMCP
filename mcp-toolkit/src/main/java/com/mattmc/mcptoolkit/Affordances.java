package com.mattmc.mcptoolkit;

import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.tags.FluidTags;

/**
 * Compact affordance flags for a block state — an observation should answer the <em>next</em>
 * question (can I walk through it, stand on it, place into it, does it hurt) in the same payload
 * (MineDojo affordance-carrying, RESEARCH_WORLD_REPRESENTATION.md round three). Attached at
 * <b>palette</b> level wherever reads emit palettes, so the cost is O(distinct blocks), not
 * O(cells).
 *
 * <p>Vocabulary — one mobility class first, then qualifiers, comma-joined:
 * <ul>
 *   <li>{@code solid} — blocks motion: a body cannot pass, can stand on it</li>
 *   <li>{@code pass} — no collision: a body walks/falls through</li>
 *   <li>{@code water} / {@code lava} — fluid (lava also carries {@code hazard})</li>
 *   <li>{@code repl} — replaceable: placing a block here overwrites it (grass, snow, water)</li>
 *   <li>{@code hazard} — damages on contact: lava via its fluid state, blocks via
 *       {@code #mcptoolkit:contact_hazards} (fire, cactus, magma, berry bush, wither rose, powder
 *       snow by default — a mod or datapack joins the tag to be recognized too)</li>
 *   <li>{@code tool} — drops require the correct tool</li>
 *   <li>{@code unbreakable} — cannot be mined in survival (bedrock class)</li>
 * </ul>
 * Flags are computed from an actually-observed state (the first one interned per palette entry),
 * never from a guessed default state.
 */
final class Affordances {
    private Affordances() {}

    static String flags(final BlockState state) {
        StringBuilder sb = new StringBuilder();
        FluidState fluid = state.getFluidState();
        boolean lava = fluid.is(FluidTags.LAVA);
        if (fluid.is(FluidTags.WATER)) {
            sb.append("water");
        } else if (lava) {
            sb.append("lava");
        } else if (state.isAir()) {
            sb.append("air");
        } else if (state.blocksMotion()) {
            sb.append("solid");
        } else {
            sb.append("pass");
        }
        if (!state.isAir() && state.canBeReplaced()) {
            sb.append(",repl");
        }
        if (lava || McpToolkitTags.isContactHazard(state)) {
            sb.append(",hazard");
        }
        if (state.requiresCorrectToolForDrops()) {
            sb.append(",tool");
        }
        if (state.getBlock().defaultDestroyTime() < 0) {
            sb.append(",unbreakable");
        }
        return sb.toString();
    }

    /**
     * 8-point compass bearing of the horizontal offset {@code (dx, dz)} — the relation models
     * mis-derive from raw coordinates (Minecraft north is −z). Null when there is no meaningful
     * horizontal direction (the target is essentially overhead/underfoot).
     */
    static @org.jspecify.annotations.Nullable String bearing(final double dx, final double dz) {
        if (dx * dx + dz * dz < 0.25) {
            return null;
        }
        double angle = Math.toDegrees(Math.atan2(dx, -dz)); // 0 = north (−z), 90 = east (+x)
        int octant = (int) Math.round(((angle % 360.0) + 360.0) % 360.0 / 45.0) % 8;
        return switch (octant) {
            case 0 -> "N";
            case 1 -> "NE";
            case 2 -> "E";
            case 3 -> "SE";
            case 4 -> "S";
            case 5 -> "SW";
            case 6 -> "W";
            default -> "NW";
        };
    }
}
