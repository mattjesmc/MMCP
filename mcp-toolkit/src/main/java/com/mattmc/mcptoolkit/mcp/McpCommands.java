package com.mattmc.mcptoolkit.mcp;

import com.mattmc.mcptoolkit.BridgeServer;
import com.mattmc.mcptoolkit.CommandRoot;
import com.mattmc.mcptoolkit.McpTools;
import com.mattmc.mcptoolkit.hooks.ServerHooks;
import net.minecraft.ChatFormatting;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.network.chat.Component;

/**
 * {@code /mmcp mcp} — the URL to paste into an MCP client, and what each surface serves.
 *
 * <p>The whole promise of the in-jar server is that nothing has to be installed for it, so the last
 * thing it should need is a document to find the address in. A person who has just started their
 * game can type this and be told the one line they need. The counts are live: they are the tools the
 * registry actually holds right now, filtered by each surface, so a keep-list with a typo in it
 * shows up here as a number that is one short — which is the only check a keep-list gets.
 *
 * <p><b>The text is not here</b>, it is in {@link McpReport}, which has no Minecraft in it and is
 * unit-tested. What is left in this class is the colour of each line and the call that sends it —
 * which is exactly as much as a live look can confirm.
 *
 * <p>Gated like {@code /mmcp server}: the answer includes how to obtain full control of this game.
 */
public final class McpCommands {
    private McpCommands() {}

    public static void register() {
        ServerHooks.COMMAND_REGISTRATION.register((dispatcher, registryAccess, environment) ->
            dispatcher.register(CommandRoot.root()
                .then(CommandRoot.gated("mcp").executes(ctx -> report(ctx.getSource())))));
    }

    private static int report(final CommandSourceStack source) {
        for (McpReport.Line line : McpReport.lines(BridgeServer.mcpEnabled(), BridgeServer.boundPort(),
                BridgeServer.requestedPort(), Surfaces.installed(), McpTools.all(),
                McpConn.live().size())) {
            final String text = line.text();
            final ChatFormatting colour = colourOf(line.kind());
            source.sendSuccess(() -> Component.literal(text).withStyle(colour), false);
        }
        // Success is "there is a server and this is its address"; the two failure-shaped states are
        // reported in full and still answer 0, so a command block or a script can tell them apart.
        return BridgeServer.mcpEnabled() && BridgeServer.boundPort() > 0 ? 1 : 0;
    }

    private static ChatFormatting colourOf(final McpReport.Kind kind) {
        return switch (kind) {
            case URL -> ChatFormatting.GREEN;
            case SURFACE_DEFAULT -> ChatFormatting.WHITE;
            case SURFACE -> ChatFormatting.DARK_GRAY;
            case UNBOUND -> ChatFormatting.GOLD;
            case HINT, NOTE, OFF -> ChatFormatting.GRAY;
        };
    }
}
