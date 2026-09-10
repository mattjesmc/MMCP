package com.mattmc.mcptoolkit.client;

import com.mattmc.mcptoolkit.hooks.client.ClientHooks;
import com.mattmc.mcptoolkit.McpToolkit;
import com.mattmc.mcptoolkit.wm.HumanFramePayload;
import net.fabricmc.api.EnvType;
import net.fabricmc.api.Environment;
import net.minecraft.client.Minecraft;
import net.minecraft.client.input.MouseButtonEvent;
import net.minecraft.client.multiplayer.ServerData;
import net.minecraft.client.player.ClientInput;
import net.minecraft.network.protocol.common.ServerboundCustomPayloadPacket;
import net.minecraft.world.entity.player.Input;
import net.minecraft.world.phys.EntityHitResult;
import net.minecraft.world.phys.Vec2;

import java.util.Locale;

/**
 * §15 phase-2 client capture (HUMAN_RIG_PLAN.md channel 2): samples the TRUE input frame at
 * END_CLIENT_TICK — after {@code LocalPlayer.tick} has sent this tick's vanilla input packets, so
 * the {@link HumanFramePayload} rides the same TCP stream BEHIND them and the server-side
 * cross-check inherits ordering by connection FIFO.
 *
 * <p>Sampled per tick: analog {@code ClientInput.moveVector} (slowdown multipliers baked in — the
 * analog speed supervision the server-side ternary can never carry), the toggle-resolved
 * {@code keyPresses}, resolved effective sprint/sneak (decision 2), end-of-tick yaw/pitch, sub-tick
 * mouse delta sums + sample count (via {@code MOUSE_TURN}, per render frame), attack/use keybind
 * holds and press-edge counts (via {@code MOUSE_BUTTON} for mouse-bound keys at GLFW resolution;
 * an isDown-transition fallback catches keyboard-bound attack/use at one edge per tick), the
 * crosshair entity at the latest press edge, and the selected hotbar slot.
 *
 * <p>Sends UNCONDITIONALLY while in a world on a local server — zeroed frames are explicit idle
 * rows (§13.1), and the server side ({@code WmHuman}) is the single armed/recording gate, so the
 * client needs no capture-state round-trip. Paused integrated play is skipped (the server isn't
 * consuming; frames would only pile up as drops). Remote servers never see the payload — the rig
 * is localhost by design, and the gate keeps a dev client polite on any other server.
 *
 * <p>All state is render-thread only: the GLFW callbacks re-dispatch through
 * {@code minecraft.execute} before our hooks fire, and END_CLIENT_TICK is the client thread.
 */
@Environment(EnvType.CLIENT)
public final class HumanCapture {
    private HumanCapture() {}

    private static double mouseDx;
    private static double mouseDy;
    private static int mouseSamples;
    private static int atkEdges;
    private static int useEdges;
    private static int targetEid = HumanFramePayload.NO_TARGET;
    private static boolean atkWasDown;
    private static boolean useWasDown;

    public static void register() {
        // NB "section 14", not the section sign: MC's logger treats U+00A7 as its formatting-code
        // prefix, so a literal one swallows the character after it (this line printed "md 2)").
        //
        // The whole point of this subsystem is a payload sent to the server every tick. Where that
        // cannot work, register NOTHING rather than accumulate per-tick throws: HookEvent contains
        // them, so the game survives, but a contained failure repeated twenty times a second is a
        // log nobody can read. One line at startup is the honest form of the same information.
        if (!com.mattmc.mcptoolkit.platform.Platform.canSendCustomPayloads()) {
            McpToolkit.LOGGER.warn("[MCP Toolkit] human input capture is OFF on {}: the toolkit cannot"
                + " register a serverbound custom payload on this loader yet (CROSS_LOADER_DESIGN.md"
                + " section 14). Everything else is unaffected.",
                com.mattmc.mcptoolkit.platform.Platform.loaderName());
            return;
        }
        ClientHooks.MOUSE_TURN.register(HumanCapture::onTurn);
        ClientHooks.MOUSE_BUTTON.register(HumanCapture::onButton);
        ClientHooks.END_CLIENT_TICK.register(HumanCapture::tick);
        ClientHooks.DISCONNECT.register(HumanCapture::reset);
    }

    private static void onTurn(final double dx, final double dy) {
        mouseDx += dx;
        mouseDy += dy;
        mouseSamples++;
    }

    private static void onButton(final MouseButtonEvent event, final boolean pressed) {
        if (!pressed) {
            return;
        }
        Minecraft mc = Minecraft.getInstance();
        if (mc.player == null || mc.level == null) {
            return;
        }
        if (mc.options.keyAttack.matchesMouse(event)) {
            atkEdges++;
            stashTarget(mc);
        }
        if (mc.options.keyUse.matchesMouse(event)) {
            useEdges++;
            stashTarget(mc);
        }
    }

    private static void stashTarget(final Minecraft mc) {
        if (mc.hitResult instanceof EntityHitResult hit) {
            targetEid = hit.getEntity().getId();
        }
    }

    private static void tick(final Minecraft mc) {
        if (mc.player == null || mc.level == null || mc.getConnection() == null
            || mc.isPaused() || !localServer(mc)) {
            reset();
            return;
        }
        // Keyboard-bound attack/use edge fallback: the mouse hook counted nothing this tick, but
        // the keybind went down since last tick — one edge, at tick resolution.
        boolean atkDown = mc.options.keyAttack.isDown();
        boolean useDown = mc.options.keyUse.isDown();
        if (atkDown && !atkWasDown && atkEdges == 0) {
            atkEdges = 1;
            stashTarget(mc);
        }
        if (useDown && !useWasDown && useEdges == 0) {
            useEdges = 1;
            stashTarget(mc);
        }

        ClientInput in = mc.player.input;
        Vec2 mv = in.getMoveVector(); // y = forward impulse, x = leftward impulse (both analog)
        Input k = in.keyPresses;      // toggle-resolved — identical semantics to lastClientInput
        int keys = (k.forward() ? HumanFramePayload.KEY_FORWARD : 0)
            | (k.backward() ? HumanFramePayload.KEY_BACKWARD : 0)
            | (k.left() ? HumanFramePayload.KEY_LEFT : 0)
            | (k.right() ? HumanFramePayload.KEY_RIGHT : 0)
            | (k.jump() ? HumanFramePayload.KEY_JUMP : 0)
            | (k.shift() ? HumanFramePayload.KEY_SHIFT : 0)
            | (k.sprint() ? HumanFramePayload.KEY_SPRINT : 0);
        int state = (mc.player.isSprinting() ? HumanFramePayload.ST_SPRINT : 0)
            | (mc.player.isCrouching() ? HumanFramePayload.ST_SNEAK : 0)
            | (atkDown ? HumanFramePayload.ST_ATK_HELD : 0)
            | (useDown ? HumanFramePayload.ST_USE_HELD : 0);

        HumanFramePayload frame = new HumanFramePayload(
            HumanFramePayload.SCHEMA,
            mc.level.getGameTime(),
            mv.y, mv.x,
            keys, state,
            mc.player.getYRot(), mc.player.getXRot(),
            (float) mouseDx, (float) mouseDy, mouseSamples,
            atkEdges, useEdges,
            mc.player.getInventory().getSelectedSlot(),
            targetEid);
        mc.getConnection().send(new ServerboundCustomPayloadPacket(frame));

        mouseDx = 0.0;
        mouseDy = 0.0;
        mouseSamples = 0;
        atkEdges = 0;
        useEdges = 0;
        targetEid = HumanFramePayload.NO_TARGET;
        atkWasDown = atkDown;
        useWasDown = useDown;
    }

    /** Integrated server, or a dedicated server on this machine — the rig's two topologies. */
    private static boolean localServer(final Minecraft mc) {
        if (mc.isLocalServer()) {
            return true;
        }
        ServerData sd = mc.getCurrentServer();
        if (sd == null || sd.ip == null) {
            return false;
        }
        String ip = sd.ip.toLowerCase(Locale.ROOT);
        return ip.startsWith("127.") || ip.startsWith("localhost");
    }

    private static void reset() {
        mouseDx = 0.0;
        mouseDy = 0.0;
        mouseSamples = 0;
        atkEdges = 0;
        useEdges = 0;
        targetEid = HumanFramePayload.NO_TARGET;
        atkWasDown = false;
        useWasDown = false;
    }
}
