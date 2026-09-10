package com.mattmc.mcptoolkit.agent;

import com.mattmc.mcptoolkit.CommandRoot;
import com.mattmc.mcptoolkit.hooks.ServerHooks;
import com.mojang.brigadier.arguments.StringArgumentType;
import net.minecraft.ChatFormatting;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.network.chat.Component;

import java.nio.file.InvalidPathException;
import java.nio.file.Path;
import java.util.List;

/**
 * {@code /mmcp server …} — this game's MCP-server registrations, for a human at a console and for the
 * probe that proves the merge (RELEASE_1 §B1).
 *
 * <pre>
 *   /mmcp server                   what is registered where, and whether each one is still true
 *   /mmcp server register &lt;dir&gt;    register THIS game's bridge in that directory
 *   /mmcp server remove &lt;dir&gt;      take this game's entry back out, leaving every other server
 * </pre>
 *
 * <h2>Why a command as well as a menu</h2>
 *
 * <p>Two reasons, and the second is the one that made it non-optional. A dedicated server has no
 * client screen and still has registrations to manage — §B2's whole argument for a command interface.
 * And the menu is a client surface no headless probe can drive, so without this the merge that stops
 * {@code registerServer} from deleting a human's other MCP servers would ship on a promise. A server
 * command is reachable from a probe through {@code run_command} at ZERO manifest cost — the rule
 * {@code FakePlayerCommand} wrote down and {@code CanvasCommands} followed.
 *
 * <p>The path argument is greedy on purpose: {@code C:\\Users\\me\\my mod} has a colon in it, which
 * Brigadier's unquoted word would refuse, and spaces, which {@code word()} would cut short.
 *
 * <p><b>Register runs the extract synchronously</b>, on the server thread. In a dev run that re-copies
 * the Node server every time (the version never bumps between edits), so it costs a visible hitch —
 * accepted, because a human typing a command is already waiting for its answer, and because the
 * alternative makes the probe's assertion race the write it is asserting.
 */
public final class AgentCommands {
    private AgentCommands() {}

    public static void register() {
        ServerHooks.COMMAND_REGISTRATION.register((dispatcher, registryAccess, environment) ->
            dispatcher.register(CommandRoot.root()
                .then(CommandRoot.gated("server")
                    .executes(ctx -> list(ctx.getSource()))
                    .then(Commands.literal("register")
                        .then(Commands.argument("dir", StringArgumentType.greedyString())
                            .executes(ctx -> register(ctx.getSource(),
                                StringArgumentType.getString(ctx, "dir")))))
                    .then(Commands.literal("remove")
                        .then(Commands.argument("dir", StringArgumentType.greedyString())
                            .executes(ctx -> remove(ctx.getSource(),
                                StringArgumentType.getString(ctx, "dir"))))))));
    }

    // ---------------------------------------------------------------------------------------------

    private static int list(final CommandSourceStack source) {
        String url = Registrations.bridgeUrl();
        reply(source, url == null
            ? "bridge: NOT BOUND — every registration below is dead until it binds"
            : "bridge: " + url + "  (server " + Registrations.serverIndex() + ")");
        List<Registrations.Status> rows = Registrations.survey();
        int current = 0;
        for (Registrations.Status s : rows) {
            ChatFormatting colour = switch (s.state()) {
                case CURRENT -> ChatFormatting.GREEN;
                case STALE, FOREIGN -> ChatFormatting.GOLD;
                case ABSENT -> ChatFormatting.DARK_GRAY;
                case UNREADABLE -> ChatFormatting.GRAY;
            };
            if (s.state() == Registrations.State.CURRENT) {
                current++;
            }
            StringBuilder line = new StringBuilder();
            line.append(s.state().name().toLowerCase(java.util.Locale.ROOT))
                .append("  ").append(s.site().workspace())
                .append("  [").append(s.site().label()).append(']');
            if (s.others() > 0) {
                // The number that used to go to zero on every registration.
                line.append("  +").append(s.others()).append(" other server(s) in the file");
            }
            if (s.detail() != null) {
                line.append("\n    ").append(s.detail());
            }
            final String text = line.toString();
            source.sendSuccess(() -> Component.literal(text).withStyle(colour), false);
        }
        reply(source, rows.size() + " site(s), " + current + " current");
        return current;
    }

    private static int register(final CommandSourceStack source, final String dir) {
        Path path = parse(source, dir);
        if (path == null) {
            return 0;
        }
        String outcome = Registrations.register(path, true);
        reply(source, outcome);
        return outcome.startsWith("refused") || outcome.startsWith("failed") ? 0 : 1;
    }

    private static int remove(final CommandSourceStack source, final String dir) {
        Path path = parse(source, dir);
        if (path == null) {
            return 0;
        }
        String outcome = Registrations.unregister(path);
        reply(source, outcome);
        return outcome.startsWith("failed") ? 0 : 1;
    }

    /** A path, or null with the refusal already sent — a relative one would mean the JVM's cwd. */
    private static Path parse(final CommandSourceStack source, final String dir) {
        String raw = dir.trim();
        if ((raw.startsWith("\"") && raw.endsWith("\"") && raw.length() > 1)
            || (raw.startsWith("'") && raw.endsWith("'") && raw.length() > 1)) {
            raw = raw.substring(1, raw.length() - 1);
        }
        Path path;
        try {
            path = Path.of(raw);
        } catch (InvalidPathException e) {
            reply(source, "refused: '" + raw + "' is not a path (" + e.getReason() + ")");
            return null;
        }
        if (!path.isAbsolute()) {
            // The game's working directory is the launcher's, not the human's shell — a relative path
            // would land somewhere neither of them meant and the registration would look fine.
            reply(source, "refused: give an absolute directory. A relative path would be resolved "
                + "against the game's working directory, which is not where you are typing from.");
            return null;
        }
        return path;
    }

    private static void reply(final CommandSourceStack source, final String text) {
        source.sendSuccess(() -> Component.literal(text), false);
    }
}
