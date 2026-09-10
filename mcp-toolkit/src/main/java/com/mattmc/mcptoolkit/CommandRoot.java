package com.mattmc.mcptoolkit;

import com.mojang.brigadier.builder.LiteralArgumentBuilder;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;

/**
 * The one in-game command root, and the only place its name is written (RELEASE_1.md section B2).
 *
 * <p>There used to be three — {@code /claude}, {@code /mcptk} and {@code /review} — registered from
 * five files, for no reason beyond the order they were built in. They are one tree now:
 *
 * <pre>
 *   /mmcp                      bridge, sessions, chat and companions in one answer
 *   /mmcp server …             this game's MCP-server registrations   (was /mcptk mcp)
 *   /mmcp client launch &lt;kit&gt;  start an agent session                 (was /claude launch, /claude survival)
 *   /mmcp session …            list, stop, bind the chat responder    (was /claude status|stop|responder)
 *   /mmcp chat mute|unmute     the player's hard switch on chat        (was /claude mute|unmute)
 *   /mmcp body …               where the session bodies are           (was /mcptk body)
 *   /mmcp fakeplayer …         the player-body probe surface          (was /mcptk fakeplayer)
 *   /mmcp edit|frame|save|cancel|canvas …   the workshop              (was /mcptk edit …)
 *   /mmcp review …             the human review queue                 (was /review)
 * </pre>
 *
 * <p><b>The permission moved DOWN, and that is not cosmetic — it is what makes the merge safe.</b>
 * Brigadier merges same-named literals in {@code CommandNode.addChild}: an existing node keeps its
 * own {@code requires} predicate and only absorbs the new node's CHILDREN. So when five files each
 * register a {@code /mmcp} root, the effective permission on that root is whichever file registered
 * FIRST — a class-loading order, silently deciding whether a plain player can see the tree. With
 * three roots that could not bite (every {@code /mcptk} registration happened to pass the same
 * predicate and {@code /claude} was a separate root); with one root it would. Every root here is
 * therefore built by {@link #root()}, which is unguarded and identical from every caller, and the
 * gate sits on the SUBTREE via {@link #gated(String)}. That is also the better answer on its own
 * merits: {@code /mmcp chat status} is a fair question for anyone on the server, and
 * {@code /mmcp server register} is not.
 *
 * <p><b>No aliases.</b> The old roots are gone rather than deprecated, because the argument for
 * doing this at all was that it is free exactly once — before the first person outside this machine
 * has typed one. A back-compatible alias would spend that and keep the three names alive in every
 * doc and every muscle memory it was meant to retire. The one exception is a chat KILL SWITCH, which
 * is argued where it lives ({@code ChatTools}).
 */
public final class CommandRoot {
    private CommandRoot() {}

    /** The root literal. Public so the rename is one edit, and so probes can be told the name. */
    public static final String NAME = "mmcp";

    /** An UNGUARDED {@code /mmcp} root — identical from every registration site, by the rule above. */
    public static LiteralArgumentBuilder<CommandSourceStack> root() {
        return Commands.literal(NAME);
    }

    /** A subtree only a gamemaster can run: the gate the root used to carry. */
    public static LiteralArgumentBuilder<CommandSourceStack> gated(final String name) {
        return Commands.literal(name).requires(Commands.hasPermission(Commands.LEVEL_GAMEMASTERS));
    }
}
