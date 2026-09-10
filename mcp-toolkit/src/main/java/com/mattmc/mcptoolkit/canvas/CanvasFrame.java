package com.mattmc.mcptoolkit.canvas;

import com.mattmc.mcptoolkit.McpToolkit;
import com.mattmc.mcptoolkit.hooks.ServerHooks;
import net.minecraft.gizmos.GizmoStyle;
import net.minecraft.gizmos.Gizmos;

/**
 * <b>The visible frame.</b> ({@code RENDER_SEAM_DESIGN.md} §10.2, the second missing piece, and §10.3,
 * which is why it has to be seen rather than merely recorded.)
 *
 * <p>The failure it exists to prevent is quiet: a human adds an eave, a chimney or a step one block
 * outside the capture box, the save truncates, and the loss shows up much later as a seam. A number
 * in a chat message does not stop that. A box drawn around the work does.
 *
 * <h2>What was pinned down here, because the design left it open</h2>
 *
 * §9 listed "which entry point a mod uses to push a gizmo per tick" as unverified. It is
 * {@link Gizmos#addGizmo}, and the window it needs is already open around the server tick — but
 * <b>only on an integrated server</b>. {@code IntegratedServer.processPacketsAndTick} wraps
 * {@code super.processPacketsAndTick} in {@code Gizmos.withCollector(...)}, so anything drawn from a
 * server tick hook lands in that collector and {@code LevelExtractor.extractGizmos} pulls it into the
 * next frame. {@code MinecraftServer} itself has no collector at all: on a DEDICATED server
 * {@code Gizmos.addGizmo} throws {@code IllegalStateException("Gizmos cannot be created here!")}, and
 * {@code extractGizmos} only ever reads {@code Minecraft.getInstance()} and
 * {@code getSingleplayerServer()} — so a gizmo pushed from a dedicated server would not reach a
 * connected client even if one could be made.
 *
 * <p>That is a defined answer rather than a skipped case, which is what the standing rule about
 * probes that only ever ran one way asks for: {@link #available()} reports it, {@code /mmcp edit}
 * says it out loud when it is false, and the frame's numbers are still in every reply. The frame is
 * an aid to a human standing in the world; the CONTRACT is the session, and the contract holds
 * headlessly.
 */
final class CanvasFrame {

    private CanvasFrame() {}

    /** White. With {@code coloredCornerStroke} the three edges meeting the origin tint R/G/B for X/Y/Z. */
    private static final int STROKE = 0xFFFFFFFF;
    private static final float WIDTH = 3.0F;
    /** The label's colour, and a soft one: it sits over the work, not in front of it. */
    private static final int LABEL = 0xFFE8E8E8;

    /** Null until the first push has told us; then true or false for the rest of the run. */
    private static Boolean available;

    static void register() {
        ServerHooks.END_SERVER_TICK.register(server -> {
            if (Boolean.FALSE.equals(available)) {
                return;
            }
            if (EditSession.all().isEmpty()) {
                return;
            }
            try {
                for (final EditSession session : EditSession.all()) {
                    // A GIZMO CARRIES NO DIMENSION. `LevelExtractor` drains the collector into
                    // whatever level the viewer is standing in, so an unfiltered push draws every
                    // session's frame in the OVERWORLD too — seen on the first live run, a white box
                    // hanging over the spawn hills. There is no viewer to ask on this side, so the
                    // stand-in is the only one that exists: draw a frame only while somebody is in
                    // the level it belongs to. On an integrated server — the only place a gizmo
                    // reaches a screen at all — that player IS the viewer.
                    if (server.getLevel(session.dimension()) == null
                        || server.getLevel(session.dimension()).players().isEmpty()) {
                        continue;
                    }
                    // No fill: an author works INSIDE this box, and a translucent skin over every
                    // face is a haze on the thing being judged. Always-on-top instead, so the frame
                    // is visible from inside a finished room as well as from outside an empty one —
                    // an invisible frame is the failure mode this whole class is here to prevent.
                    Gizmos.cuboid(session.aabb(), GizmoStyle.stroke(STROKE, WIDTH), true)
                        .setAlwaysOnTop();
                    Gizmos.billboardTextOverBlock(
                        session.id() == null ? session.owner() + " (blank frame)"
                            : session.id() + "  [" + session.owner() + "]",
                        session.max(), 0, LABEL, 1.0F).setAlwaysOnTop();
                }
                if (available == null) {
                    available = true;
                }
            } catch (final Throwable t) {
                // The dedicated-server answer, taken once. Logged at INFO because it is a property of
                // where the toolkit is running, not a fault: the session still holds the frame and
                // every reply still prints its corners.
                available = false;
                McpToolkit.LOGGER.info("[canvas] no gizmo collector on this server — the edit frame"
                    + " will not be drawn (this is expected on a dedicated server; the frame's"
                    + " coordinates are still reported by /mmcp frame): {}", t.toString());
            }
        });
    }

    /**
     * Whether the frame is actually being drawn. Null until the first session has been pushed — the
     * honest third answer, and callers say "not yet known" rather than guessing either way.
     */
    static Boolean available() {
        return available;
    }
}
