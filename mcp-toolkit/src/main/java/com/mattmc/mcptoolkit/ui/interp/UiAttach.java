package com.mattmc.mcptoolkit.ui.interp;

import com.mattmc.mcptoolkit.ui.GeneratedScreens;
import com.mattmc.mcptoolkit.ui.doc.UiDocument;
import com.mattmc.mcptoolkit.ui.doc.UiParseException;
import com.mojang.blaze3d.platform.InputConstants;
import net.fabricmc.api.EnvType;
import net.fabricmc.api.Environment;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.gui.screens.inventory.AbstractContainerScreen;
import net.minecraft.client.input.KeyEvent;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.resources.Identifier;
import org.jspecify.annotations.Nullable;

import java.io.IOException;

/**
 * <b>The attached preview</b> (SCREEN_AUTHORING_DESIGN.md section 6.1): the human opens the REAL
 * screen in the dev game, and the toolkit swaps the client screen for an interpreted one wrapping
 * the <b>same live menu instance</b>. Real slots, real stacks, real synced bindings, and still
 * live-draggable.
 *
 * <p><b>The swap is safe, and it was checked rather than assumed.</b> Setting another screen calls
 * {@code removed()} on the old one, and {@code AbstractContainerScreen.removed()}
 * ({@code vanilla-src/.../AbstractContainerScreen.java:525}) forwards to {@code menu.removed(player)},
 * whose whole body is guarded by {@code if (player instanceof ServerPlayer)}
 * ({@code AbstractContainerMenu.java:585}) - on the client the player is a {@code LocalPlayer}, so
 * it is a no-op. The close packet is sent only from {@code onClose()} -> {@code closeContainer()}
 * ({@code :579}), which a screen swap never calls. <b>The menu survives the swap, in both
 * directions</b>, which is why {@link #detach()} puts the ORIGINAL screen instance back rather than
 * constructing a new one: the same object, over the same menu, is the cheapest proof that nothing
 * was disturbed.
 *
 * <p><b>What attached mode can and cannot do.</b> It can move every label, button, gauge, icon and
 * layout node, because the interpreter draws those from the document on each {@code init()}. It
 * cannot move a slot: {@code Slot.x}/{@code Slot.y} are final in 26.2, and the slots belong to the
 * menu the mod's compiled code built. So a slot drag edits the document (correctly - the next
 * generate/rebuild applies it) while the screen keeps the old position, and that divergence is
 * measured, drawn and reported rather than left invisible - see {@code SlotPlan.compare}.
 */
@Environment(EnvType.CLIENT)
public final class UiAttach {
    private UiAttach() {}

    /** What a swap did, for the tool reply. */
    public record Attached(InterpretedScreen screen, String wrapped, String document, boolean derived) {}

    /**
     * Wrap the container screen that is currently open.
     *
     * @param source the document to interpret, or {@code null} to take it from the open screen - which
     *               works when that screen is a document's registered generated screen
     * @throws IllegalStateException    when nothing wrappable is open
     * @throws IllegalArgumentException when the document cannot be read or derived
     */
    public static Attached attach(final @Nullable UiSource source) throws IOException, UiParseException {
        Minecraft mc = Minecraft.getInstance();
        Screen open = mc.gui.screen();
        LocalPlayer player = mc.player;
        if (player == null) {
            throw new IllegalStateException("attaching needs the client in a world: the wrapped screen's"
                + " inventory label and player slots come from the player.");
        }
        if (open instanceof InterpretedScreen already && !already.isDetached()) {
            throw new IllegalStateException("already attached to " + already.menu().getClass().getSimpleName()
                + " (" + already.source().describe() + "); detach first");
        }
        if (open instanceof InterpretedScreen detached) {
            throw new IllegalStateException("the open screen is a DETACHED preview of "
                + detached.source().describe() + ", whose menu is synthetic. Attaching wraps a REAL"
                + " menu: open the mod's own screen first (open_screen generated:true for a document"
                + " that has a generated screen), then attach.");
        }
        if (!(open instanceof AbstractContainerScreen<?> acs)) {
            throw new IllegalStateException("nothing to attach to: "
                + (open == null ? "no screen is open" : open.getClass().getSimpleName()
                    + " is not a container screen, so it has no menu to wrap"));
        }
        UiSource use = source;
        boolean derived = false;
        if (use == null) {
            GeneratedScreens.Entry entry = GeneratedScreens.forScreenClass(open.getClass().getName());
            if (entry == null) {
                throw new IllegalArgumentException(open.getClass().getSimpleName() + " is not a document's"
                    + " generated screen, so there is no document to derive. Name one with 'ui' or"
                    + " 'ui_file' - any document can be interpreted over any menu, and the reply says"
                    + " how far the two disagree. Documents with a generated screen here: "
                    + GeneratedScreens.documents());
            }
            use = new UiSource.Res(Identifier.parse(entry.docId()));
            derived = true;
        }
        UiDocument doc = use.load();
        InterpretedScreen screen = new InterpretedScreen(use, doc, acs.getMenu(), player.getInventory());
        screen.wrap(open);
        mc.setScreenAndShow(screen);
        return new Attached(screen, open.getClass().getSimpleName(), use.describe(), derived);
    }

    /** Put the wrapped screen back. Refuses when the open screen is not an attached preview. */
    public static Screen detach() {
        Minecraft mc = Minecraft.getInstance();
        Screen open = mc.gui.screen();
        if (!(open instanceof InterpretedScreen is)) {
            throw new IllegalStateException("nothing to detach: "
                + (open == null ? "no screen is open" : open.getClass().getSimpleName() + " is open")
                + ", and detach puts back the screen an ATTACHED preview wrapped");
        }
        if (is.isDetached()) {
            throw new IllegalStateException("this preview is DETACHED (its menu is synthetic), so there is"
                + " no screen behind it. close_screen closes it.");
        }
        Screen back = is.wrapped();
        if (back == null) {
            throw new IllegalStateException("this preview is attached to a live menu but did not record the"
                + " screen it replaced, so there is nothing to put back. close_screen closes the menu.");
        }
        mc.setScreenAndShow(back);
        return back;
    }

    // ---------------------------------------------------------------------------------------------
    // The human's seam

    /**
     * <b>Ctrl+U attaches and detaches</b>, from any container screen - the hand section 6.1 is about:
     * stand in front of the real screen, press it, drag, press it again.
     *
     * <p>It rides {@code Screen.keyPressed} HEAD, which a container screen reaches through its own
     * {@code super.keyPressed(event)} FIRST ({@code AbstractContainerScreen.java:123}), so the chord
     * is seen before vanilla's inventory-key close. U carries no vanilla binding; the chord trap
     * slice 4 recorded ({@code KeyMapping.matches} ignores modifiers, so any chord containing the
     * inventory key closes the screen) is why it is not Ctrl+E.
     *
     * @return true when the key was consumed
     */
    public static boolean onKeyPressed(final Screen screen, final KeyEvent event) {
        if (!event.hasControlDown() || event.key() != InputConstants.KEY_U) {
            return false;
        }
        if (screen instanceof InterpretedScreen is && !is.isDetached()) {
            try {
                detach();
                return true;
            } catch (RuntimeException e) {
                say(e.getMessage());
                return true;
            }
        }
        if (!(screen instanceof AbstractContainerScreen<?>)) {
            return false; // not our chord on a screen with no menu: leave it to whoever wants it
        }
        try {
            Attached a = attach(null);
            say("attached the interpreter to " + a.wrapped() + " over " + a.document()
                + " - ctrl+g edits, ctrl+u goes back");
        } catch (IOException | UiParseException | RuntimeException e) {
            say("cannot attach: " + e.getMessage());
        }
        return true;
    }

    /** One line in chat: the key seam has no reply channel, and a silent refusal is a broken key. */
    private static void say(final String message) {
        Minecraft mc = Minecraft.getInstance();
        if (mc.gui != null) {
            mc.gui.hud.getChat().addClientSystemMessage(
                net.minecraft.network.chat.Component.literal("[ui] " + message));
        }
    }
}
