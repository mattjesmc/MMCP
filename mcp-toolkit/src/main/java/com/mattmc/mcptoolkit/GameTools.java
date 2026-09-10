package com.mattmc.mcptoolkit;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.commands.CommandSource;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;

import java.util.ArrayList;
import java.util.List;

/** Game-control tools that run on the server: dispatch commands and capture their output. */
public final class GameTools {
    private GameTools() {}

    public static void register() {
        McpTools.register(ToolDef.of(
            "run_command",
            "Run a server command (with or without a leading slash) at full server permissions and return its chat output. Examples: \"time set day\", \"/tp @p 0 100 0\", \"reload\". Output from asynchronous parts (functions, scheduled commands) may instead surface via get_chat.",
            Schemas.object("command", Schemas.str("The command to run, e.g. \"time set day\" or \"/give @p diamond\".")),
            ExecutionContext.SERVER,
            Mechanism.PRIVILEGED,
            (ctx, a) -> runCommand(ctx.serverOrThrow(), a)));
    }

    private static JsonObject runCommand(final MinecraftServer server, final JsonObject a) {
        if (!a.has("command") || a.get("command").isJsonNull()) {
            throw new IllegalArgumentException("missing argument 'command'");
        }
        String command = a.get("command").getAsString();

        // Route command feedback (success + failure) into a collector instead of the server console.
        List<String> lines = new ArrayList<>();
        CommandSource collector = new CommandSource() {
            @Override public void sendSystemMessage(final Component message) { lines.add(message.getString()); }
            @Override public boolean acceptsSuccess() { return true; }
            @Override public boolean acceptsFailure() { return true; }
            @Override public boolean shouldInformAdmins() { return false; }
        };
        CommandSourceStack source = server.createCommandSourceStack().withSource(collector);
        try {
            server.getCommands().performPrefixedCommand(source, command);
        } catch (Exception e) {
            lines.add("error: " + (e.getMessage() == null ? e.toString() : e.getMessage()));
        }

        JsonObject r = new JsonObject();
        JsonArray out = new JsonArray();
        for (String line : lines) {
            out.add(line);
        }
        r.add("output", out);
        return r;
    }
}
