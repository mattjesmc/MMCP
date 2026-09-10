package com.mattmc.mcptoolkit.client;

import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import net.fabricmc.api.EnvType;
import net.fabricmc.api.Environment;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientLevel;

import java.util.Set;

/**
 * The observation envelope for CLIENT-context observe tools — the non-ladder backfill ARCHITECTURE.md
 * left open ("non-ladder observe tools don't carry the envelope yet — add it when those files are next
 * touched") and TODO §1.5 kept naming as the last structurally-unswept corner.
 *
 * <p>Why these needed it at all. The server-side ladder carries {@code perception_mode} /
 * {@code game_tick} / {@code dimension} so an observation can be dated, placed, and told apart from a
 * guess — and the rule behind that is not about the world side: <b>an observation nothing can date is
 * uncapturable</b>. {@code get_screen} and its siblings are observations. They were reaching the model
 * carrying a mechanism tag and nothing else, so a screen tree read three minutes ago and one read this
 * tick were indistinguishable in a transcript, and memory capture had to refuse them rather than date
 * them by guess.
 *
 * <p>Two things make the client envelope different from the server one, and both are stated rather
 * than papered over:
 * <ul>
 *   <li><b>The clock is the CLIENT's.</b> {@code game_tick} comes from {@code Minecraft.level}, not
 *       from the server level — on a multiplayer client those differ, and reporting the wrong one
 *       would be exactly the silent-wrong-answer path the {@code dimension} field exists to close.</li>
 *   <li><b>There may be no world at all.</b> A title screen, a server list, a disconnect screen: these
 *       are screens a client tool legitimately reads, and there is no tick and no dimension behind
 *       them. Those fields are written as explicit JSON <b>null</b>, never omitted and never faked.
 *       The absence of a clock is a fact about the read; a missing key is just a hole a consumer has
 *       to guess about.</li>
 * </ul>
 *
 * <p>Stamped at the {@code BridgeServer} dispatch chokepoint, alongside the mechanism tag and the
 * embodied envelope, and — like both of those — only into fields the tool did not already write. A
 * declared-but-unstamped contract is no contract, and a contract each tool body has to remember is
 * one that will be forgotten by the next tool.
 */
@Environment(EnvType.CLIENT)
public final class ClientEnvelope {
    private ClientEnvelope() {}

    /**
     * Tools that read PIXELS rather than client state. The perception-mode table calls that
     * {@code rendered} — what a framebuffer actually displays — and it is a genuinely different kind
     * of read from walking the widget tree: a rendered read sees what the human sees, including
     * anything the tree cannot enumerate, and misses anything scrolled off it.
     */
    private static final Set<String> RENDERED = Set.of("screenshot", "screenshot_annotated");

    /**
     * Everything else here is {@code authoritative} — a direct query of client state (the open
     * screen, its menu, the chat buffer, the loaded assets, the font metrics). That is the row the
     * perception-mode table already had marked "envelope label pending outside the perception
     * ladder"; this is the label arriving.
     */
    private static final String CLIENT_STATE = "authoritative";

    /** Add the envelope for {@code tool}'s result, filling only what the handler left unset. */
    public static void stamp(final String tool, final JsonObject r) {
        if (!r.has("perception_mode")) {
            r.addProperty("perception_mode", RENDERED.contains(tool) ? "rendered" : CLIENT_STATE);
        }
        // Reading the client level reference and its game time off the client thread is a benign
        // long read — the same call the embodied stamp makes off the server thread. The stamp is a
        // date, not a mutation, and a torn read of a monotonic tick counter is still a tick.
        ClientLevel level = Minecraft.getInstance().level;
        if (!r.has("game_tick")) {
            if (level != null) {
                r.addProperty("game_tick", level.getGameTime());
            } else {
                r.add("game_tick", JsonNull.INSTANCE);
            }
        }
        if (!r.has("dimension")) {
            if (level != null) {
                r.addProperty("dimension", level.dimension().identifier().toString());
            } else {
                r.add("dimension", JsonNull.INSTANCE);
            }
        }
    }
}
