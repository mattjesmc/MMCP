package com.mattmc.mcptoolkit.hooks.client;

import com.mattmc.mcptoolkit.hooks.HookEvent;
import net.fabricmc.api.EnvType;
import net.fabricmc.api.Environment;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.input.KeyEvent;
import net.minecraft.client.input.MouseButtonEvent;
import net.minecraft.network.chat.Component;
import org.jspecify.annotations.Nullable;

import java.util.function.Consumer;

/**
 * Client-side hooks, fired by the toolkit's own client mixins. Injection points (verified against
 * vanilla-src 26.2):
 *
 * <ul>
 *   <li>{@link #END_CLIENT_TICK} — {@code Minecraft.tick} TAIL.</li>
 *   <li>{@link #DISCONNECT} — {@code Minecraft.disconnect(Screen, boolean, boolean)} HEAD (the
 *       funnel every disconnect path flows through).</li>
 *   <li>{@link #CLIENT_STOPPING} — {@code Minecraft.close()} HEAD: the client is going away, and this
 *       is the last point at which a listener can still run. The counterpart of
 *       {@code ServerHooks.SERVER_STOPPING}, and the only place a non-daemon thread the toolkit owns
 *       can be told to end.</li>
 *   <li>{@link #CHAT_RECEIVED} — {@code ChatListener.handlePlayerChatMessage} (decorated content +
 *       sender profile name) and {@code handleDisguisedChatMessage} (bound chat-type name).</li>
 *   <li>{@link #GAME_RECEIVED} — {@code ChatListener.handleSystemMessage} (overlay=false) and
 *       {@code handleOverlay} (overlay=true).</li>
 *   <li>{@link #SCREEN_AFTER_INIT} — {@code Screen.init(II)} TAIL <b>and</b> {@code Screen.resize(II)}
 *       TAIL: resize rebuilds the widget list via {@code repositionElements → rebuildWidgets} without
 *       re-running {@code init(II)}, so both must fire for widgets added here to survive a resize
 *       (fabric AFTER_INIT parity). Listeners adding widgets must be idempotent — a screen whose
 *       {@code repositionElements} only moves widgets re-fires the hook with the widget still present.</li>
 *   <li>{@link #SCREEN_MOUSE_CLICKED} — {@code MouseHandler.onButton} at the
 *       {@code Screen.mouseClicked} call (fires whether or not the screen handles the click; global,
 *       not per-screen — filter on the screen argument).</li>
 *   <li>{@link #HUD_EXTRACT} — {@code Hud.extractRenderState(GuiGraphicsExtractor, DeltaTracker)}
 *       TAIL (26.2's HUD is render-state extraction, not immediate drawing). Fires every frame,
 *       including F1-hidden — {@code hidden} carries {@code Hud.isHidden()} so listeners can
 *       respect it.</li>
 *   <li>{@link #MOUSE_TURN} — {@code MouseHandler.turnPlayer} HEAD (grabbed, in-game only): the
 *       raw accumulated deltas about to become look rotation, per render frame.</li>
 *   <li>{@link #MOUSE_BUTTON} — {@code MouseHandler.onButton} HEAD when no screen is open: every
 *       physical gameplay button transition (runs on the render thread via the GLFW callback's
 *       {@code minecraft.execute} wrap).</li>
 * </ul>
 */
@Environment(EnvType.CLIENT)
public final class ClientHooks {
    private ClientHooks() {}

    public static final HookEvent<Consumer<Minecraft>> END_CLIENT_TICK = HookEvent.create("end_client_tick");
    public static final HookEvent<Runnable> DISCONNECT = HookEvent.create("client_disconnect");

    /**
     * The client is shutting down. Fabric's {@code ClientLifecycleEvents.CLIENT_STOPPING}, re-homed —
     * it was one of the fabric-api events the 0.79.0 removal did NOT replace, and its absence is what
     * made every dev-client quit write a crash report: nothing closed the bridge's HTTP server, whose
     * dispatcher thread is non-daemon, so the JVM never exited and the shutdown watchdog fired.
     */
    public static final HookEvent<Runnable> CLIENT_STOPPING = HookEvent.create("client_stopping");

    @FunctionalInterface
    public interface ChatReceived {
        /** A player-chat line as the client will show it; {@code senderName} may be null for disguised chat. */
        void onChat(Component decorated, @Nullable String senderName);
    }

    public static final HookEvent<ChatReceived> CHAT_RECEIVED = HookEvent.create("client_chat_received");

    @FunctionalInterface
    public interface GameReceived {
        void onGame(Component message, boolean overlay);
    }

    public static final HookEvent<GameReceived> GAME_RECEIVED = HookEvent.create("client_game_received");

    @FunctionalInterface
    public interface ScreenAfterInit {
        void afterInit(Minecraft client, Screen screen, int width, int height);
    }

    public static final HookEvent<ScreenAfterInit> SCREEN_AFTER_INIT = HookEvent.create("screen_after_init");

    @FunctionalInterface
    public interface ScreenMouseClicked {
        void onClick(Screen screen, MouseButtonEvent event);
    }

    public static final HookEvent<ScreenMouseClicked> SCREEN_MOUSE_CLICKED = HookEvent.create("screen_mouse_clicked");

    @FunctionalInterface
    public interface ScreenKeyPressed {
        /** @return true to CONSUME the key: vanilla's own handling never sees it. */
        boolean onKey(Screen screen, KeyEvent event);
    }

    /**
     * {@code Screen.keyPressed} HEAD, consuming ({@link HookEvent#fireHandled}). Every screen's key
     * handling flows through it, a container screen included - {@code AbstractContainerScreen}
     * calls {@code super.keyPressed(event)} FIRST, so a listener's chord is seen before vanilla's
     * inventory-key close. The toolkit's own screens read their keys in the screen, not here.
     */
    public static final HookEvent<ScreenKeyPressed> SCREEN_KEY_PRESSED = HookEvent.create("screen_key_pressed");

    @FunctionalInterface
    public interface HudExtract {
        void onHudExtract(net.minecraft.client.gui.GuiGraphicsExtractor graphics,
                          net.minecraft.client.DeltaTracker deltaTracker, boolean hidden);
    }

    public static final HookEvent<HudExtract> HUD_EXTRACT = HookEvent.create("hud_extract");

    @FunctionalInterface
    public interface MouseTurn {
        /** Raw pre-sensitivity pixel deltas about to be consumed for look control (mouse grabbed,
         *  in-game). Fires per render frame with movement — sub-tick resolution. */
        void onTurn(double dx, double dy);
    }

    /** {@code MouseHandler.turnPlayer} HEAD — only reached when the mouse is grabbed and a player
     *  exists, so screen-driven deltas never leak in. */
    public static final HookEvent<MouseTurn> MOUSE_TURN = HookEvent.create("mouse_turn");

    @FunctionalInterface
    public interface MouseButtonIngame {
        /** A physical in-game (no screen) mouse button transition, pre-{@code simulateRightClick} —
         *  keybind-level truth. Fires per GLFW event, so several presses can land in one tick. */
        void onButton(MouseButtonEvent event, boolean pressed);
    }

    /** {@code MouseHandler.onButton} HEAD, filtered to screen-less (gameplay) transitions. */
    public static final HookEvent<MouseButtonIngame> MOUSE_BUTTON = HookEvent.create("mouse_button");
}
