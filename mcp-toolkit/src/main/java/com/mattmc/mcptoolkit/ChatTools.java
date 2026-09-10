package com.mattmc.mcptoolkit;

import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.hooks.ServerHooks;
import net.minecraft.ChatFormatting;
import net.minecraft.network.chat.Component;

/**
 * In-game chat I/O — the production form of the companion chat slice (ARCHITECTURE.md roadmap step 8).
 *
 * <p><b>Inbound:</b> player chat lands in the {@link EventLog} as type {@code chat}, read through the
 * same cursor-consumed {@code get_events} stream as everything else — but ROUTED: while a chat
 * responder is bound ({@link Sessions}), only that session receives chat events (enforced in
 * {@code EventTools}, not by agent goodwill). Deliberately NOT capturing game/system messages:
 * {@code send_chat} broadcasts one, and capturing it would echo the agent's own output back into its
 * input — a self-reply loop.
 *
 * <p><b>Outbound:</b> {@code send_chat} broadcasts a clearly-attributed {@code [MMCP]} system message
 * (it was {@code [Claude]} until the B2 collapse; with an agent-client adapter the client may be
 * anything, and a Gemini session announcing itself as Claude is simply a false statement).
 * The 256-char cap is a hard argument constraint — over-cap messages are rejected, never truncated
 * (silent truncation would let the agent believe it said something it didn't).
 */
public final class ChatTools {
    private ChatTools() {}

    /** Hard cap on a single chat message. Charter asks for far shorter; this is the mechanical stop. */
    public static final int MAX_MESSAGE_CHARS = 256;

    /**
     * The player's hard switch: {@code /mmcp chat mute} stops chat events flowing AND rejects
     * {@code send_chat} — enforced here, not by agent goodwill, so it holds even against a hung or
     * misbehaving session. Persisted as a marker file so it survives restarts.
     */
    private static java.nio.file.Path muteFile() {
        return com.mattmc.mcptoolkit.platform.Platform.configDir()
            .resolve("mcptoolkit.chat-muted");
    }

    public static boolean muted() {
        return java.nio.file.Files.exists(muteFile());
    }

    /** Public for the responder picker ("none" maps to the hard mute). */
    public static void setMuted(final boolean m) {
        try {
            if (m) {
                java.nio.file.Files.createDirectories(muteFile().getParent());
                java.nio.file.Files.writeString(muteFile(),
                    "Agent chat is muted. Delete this file or run /mmcp chat unmute in game.\n");
            } else {
                java.nio.file.Files.deleteIfExists(muteFile());
            }
        } catch (java.io.IOException e) {
            throw new IllegalStateException("could not persist mute state: " + e);
        }
    }

    /** What {@code /mmcp} and {@code /mmcp chat status} both answer: the switch, then who is here. */
    private static String status() {
        return (muted() ? "Agent chat is MUTED (/mmcp chat unmute restores).\n"
                        : "Agent chat is live (/mmcp chat mute silences both directions).\n")
            + Sessions.describeAll();
    }

    public static void register() {
        ServerHooks.CHAT_MESSAGE.register((message, sender) -> {
            if (muted()) {
                return;
            }
            String senderName = sender.getName().getString();
            String text = message.decoratedContent().getString();
            JsonObject data = new JsonObject();
            data.addProperty("sender", senderName);
            data.addProperty("uuid", sender.getStringUUID());
            data.addProperty("text", text);
            EventLog.emit("chat", data);
            // The "mmcp stop"/"claude stop" chat kill switch went with the launcher in 0.143.0.
            // It killed PROCESSES THIS GAME HAD STARTED, and this game starts none any more: an
            // agent connected from outside is somebody else's process, and pretending a word typed
            // in chat could stop it would be a comforting lie. /mmcp chat mute is the switch that
            // still means something — it stops both directions, and it is mod-enforced.
        });

        ServerHooks.COMMAND_REGISTRATION.register(
            (dispatcher, registryAccess, environment) ->
                dispatcher.register(CommandRoot.root()
                    // The root itself answers the question a person actually arrives with: is
                    // anything attached to this game, and can it hear me? Ungated on purpose - see
                    // CommandRoot. The two SUBTREES below are, because muting chat and stopping
                    // somebody's sessions are not everyone's to do.
                    .executes(ctx -> {
                        ctx.getSource().sendSuccess(() -> Component.literal(status()), false);
                        return 1;
                    })
                    .then(CommandRoot.gated("chat")
                        .executes(ctx -> {
                            ctx.getSource().sendSuccess(() -> Component.literal(status()), false);
                            return 1;
                        })
                        .then(net.minecraft.commands.Commands.literal("mute").executes(ctx -> {
                            setMuted(true);
                            ctx.getSource().sendSuccess(() -> Component.literal(
                                "Agent chat MUTED - no session can hear or speak. /mmcp chat unmute restores."), false);
                            return 1;
                        }))
                        .then(net.minecraft.commands.Commands.literal("unmute").executes(ctx -> {
                            setMuted(false);
                            ctx.getSource().sendSuccess(() -> Component.literal(
                                "Agent chat unmuted - chat flows again (to the bound responder, or all "
                                + "sessions when none is bound)."), false);
                            return 1;
                        }))
                        .then(net.minecraft.commands.Commands.literal("status").executes(ctx -> {
                            ctx.getSource().sendSuccess(() -> Component.literal(status()), false);
                            return 1;
                        })))
                    .then(CommandRoot.gated("session")
                        .executes(ctx -> {
                            ctx.getSource().sendSuccess(() -> Component.literal(
                                Sessions.describeAll()), false);
                            return 1;
                        })
                        .then(net.minecraft.commands.Commands.literal("list").executes(ctx -> {
                            ctx.getSource().sendSuccess(() -> Component.literal(
                                Sessions.describeAll()), false);
                            return 1;
                        }))
                        .then(net.minecraft.commands.Commands.literal("responder")
                            .then(net.minecraft.commands.Commands.argument("session",
                                    com.mojang.brigadier.arguments.StringArgumentType.word())
                                .executes(ctx -> {
                                    String arg = com.mojang.brigadier.arguments.StringArgumentType
                                        .getString(ctx, "session");
                                    if ("none".equalsIgnoreCase(arg)) {
                                        Sessions.setChatResponder(null);
                                        ctx.getSource().sendSuccess(() -> Component.literal(
                                            "Chat responder cleared - all sessions hear chat. "
                                            + "(/mmcp chat mute silences everything.)"), false);
                                        return 1;
                                    }
                                    if (!Sessions.isLive(arg)) {
                                        ctx.getSource().sendFailure(Component.literal(
                                            "No live session '" + arg + "'.\n" + Sessions.describeAll()));
                                        return 0;
                                    }
                                    Sessions.setChatResponder(arg);
                                    ctx.getSource().sendSuccess(() -> Component.literal(
                                        "Chat now routed to " + arg + " only."), false);
                                    return 1;
                                }))))));

        McpTools.register(ToolDef.of(
            "send_chat",
            "Say something in the game chat, visible to all players as an aqua \"[MMCP] <message>\" "
                + "system line. Hard cap " + MAX_MESSAGE_CHARS + " characters — longer messages are "
                + "REJECTED, not truncated; keep replies short and conversational. Player chat arrives "
                + "as `chat` events in get_events (your own send_chat output does not, so you will not "
                + "hear yourself). The player can hard-mute both directions with /mmcp chat mute — then "
                + "this tool errors and no chat events flow until /mmcp chat unmute.",
            Schemas.object("message", Schemas.str(
                "The message to say (max " + MAX_MESSAGE_CHARS + " chars).", MAX_MESSAGE_CHARS)),
            ExecutionContext.SERVER,
            Mechanism.PRIVILEGED,
            (ctx, a) -> {
                if (muted()) {
                    throw new IllegalStateException(
                        "chat is muted by the player (/mmcp chat mute) — do not try to work around it; "
                        + "the player restores it with /mmcp chat unmute");
                }
                if (!a.has("message") || a.get("message").isJsonNull()) {
                    throw new IllegalArgumentException("missing argument 'message'");
                }
                String msg = a.get("message").getAsString();
                if (msg.length() > MAX_MESSAGE_CHARS) {
                    throw new IllegalArgumentException("message is " + msg.length()
                        + " chars; the hard cap is " + MAX_MESSAGE_CHARS
                        + " — rejected, not truncated. Send a shorter message.");
                }
                ctx.serverOrThrow().getPlayerList().broadcastSystemMessage(
                    Component.literal("[MMCP] ").withStyle(ChatFormatting.AQUA)
                        .append(Component.literal(msg).withStyle(ChatFormatting.RESET)),
                    false);
                JsonObject r = new JsonObject();
                r.addProperty("sent", true);
                r.addProperty("length", msg.length());
                return r;
            }));
    }
}
