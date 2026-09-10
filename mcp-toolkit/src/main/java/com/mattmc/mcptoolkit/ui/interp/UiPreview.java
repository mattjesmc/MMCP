package com.mattmc.mcptoolkit.ui.interp;

import com.mattmc.mcptoolkit.ui.doc.UiDocument;
import com.mattmc.mcptoolkit.ui.doc.UiParseException;
import net.fabricmc.api.EnvType;
import net.fabricmc.api.Environment;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;

import java.io.IOException;

/**
 * Opens a DETACHED preview of a document (SCREEN_AUTHORING_DESIGN.md section 6.1): the menu is
 * synthetic, the stacks are placeholders, no mod and no server are involved.
 *
 * <p>It needs the client to be IN A WORLD, and the reason is vanilla's, not ours:
 * {@code AbstractContainerScreen}'s constructor reads {@code inventory.getDisplayName()} and
 * {@code Inventory} is built over a {@code Player} - there is no inventory to hand it at the title
 * screen. The player's inventory also supplies what the {@code player} container shows (copied, never
 * shared - see {@link DetachedMenu}). Section 9 optimises for exactly this moment anyway: standing
 * in the world with the screen open.
 */
@Environment(EnvType.CLIENT)
public final class UiPreview {
    private UiPreview() {}

    /**
     * Read the document, build its synthetic menu and show it. Throws with the parse problems, or with
     * a plain reason (no world, unreadable source), so a tool can refuse by name.
     */
    public static InterpretedScreen openDetached(final UiSource source) throws IOException, UiParseException {
        Minecraft mc = Minecraft.getInstance();
        LocalPlayer player = mc.player;
        if (player == null) {
            throw new IllegalStateException("a ui preview needs the client to be in a world: the container"
                + " screen's inventory label and its player slots come from the player. Join or create a"
                + " world first (open_world, or the title screen).");
        }
        UiDocument doc = source.load();
        DetachedMenu menu = new DetachedMenu(doc, player.getInventory());
        InterpretedScreen screen = new InterpretedScreen(source, doc, menu, player.getInventory());
        mc.setScreenAndShow(screen);
        return screen;
    }
}
