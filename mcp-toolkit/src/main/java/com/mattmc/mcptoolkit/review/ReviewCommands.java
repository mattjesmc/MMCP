package com.mattmc.mcptoolkit.review;

import com.mattmc.mcptoolkit.CommandRoot;
import com.mattmc.mcptoolkit.hooks.ServerHooks;
import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.context.CommandContext;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.commands.SharedSuggestionProvider;
import net.minecraft.network.chat.Component;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * <b>{@code /mmcp review} — the human's half of the review layer.</b>
 *
 * <pre>
 *   /mmcp review                     where you are in the queue
 *   /mmcp review list                every ask and its state
 *   /mmcp review next | prev         move, staging as it goes
 *   /mmcp review go &lt;id&gt;             jump to one
 *   /mmcp review skip                move on without answering
 *   /mmcp review ok [comment]        it is fine
 *   /mmcp review no &lt;comment&gt;        it is not, and why — the comment is required
 *   /mmcp review note &lt;comment&gt;      neither, but worth recording; stays on this ask
 *   /mmcp review only &lt;term|all&gt;     narrow the walk to a source or a tag, or open it up again
 *   /mmcp review check               close every open ask the world already answers
 *   /mmcp review drop &lt;id&gt;           withdraw an UNANSWERED ask (an answered one is kept)
 *   /mmcp review reload              re-read asks.json after an agent wrote to it
 *   /mmcp review ask &lt;title | look | failure [| setup;setup]&gt;   post one from in-game
 * </pre>
 *
 * <p>Everything here is thin over {@link ReviewWalk}, which is also what the MCP tools call, so a
 * verdict given in-game and a queue read back over the bridge can never disagree.
 */
public final class ReviewCommands {

    private ReviewCommands() {}

    static void register() {
        ServerHooks.COMMAND_REGISTRATION.register((dispatcher, registryAccess, environment) ->
            dispatcher.register(CommandRoot.root()
                .then(CommandRoot.gated("review")
                    .executes(ReviewCommands::status)
                    .then(Commands.literal("status").executes(ReviewCommands::status))
                    .then(Commands.literal("list").executes(ReviewCommands::list))
                    .then(Commands.literal("reload").executes(ReviewCommands::reload))
                    .then(Commands.literal("check").executes(ReviewCommands::check))
                    .then(Commands.literal("next").executes(context -> move(context, 1)))
                    .then(Commands.literal("prev").executes(context -> move(context, -1)))
                    .then(Commands.literal("skip").executes(context -> move(context, 1)))
                    .then(Commands.literal("only")
                        .then(Commands.argument("source", StringArgumentType.word())
                            .suggests((context, builder) -> SharedSuggestionProvider.suggest(
                                sources(context), builder))
                            .executes(ReviewCommands::only)))
                    .then(Commands.literal("go")
                        .then(Commands.argument("id", StringArgumentType.string())
                            .suggests((context, builder) -> SharedSuggestionProvider.suggest(
                                ReviewQueue.load(context.getSource().getServer()).stream()
                                    .filter(ReviewAsk::open).map(ReviewAsk::id).toList(), builder))
                            .executes(context -> go(context, StringArgumentType.getString(context, "id")))))
                    .then(Commands.literal("ok")
                        .executes(context -> verdict(context, ReviewAsk.OK, null))
                        .then(Commands.argument("comment", StringArgumentType.greedyString())
                            .executes(context -> verdict(context, ReviewAsk.OK,
                                StringArgumentType.getString(context, "comment")))))
                    // `no` requires a comment, and that is not an oversight: a rejection with no reason
                    // is the one verdict the session that reads this file cannot act on.
                    .then(Commands.literal("no")
                        .then(Commands.argument("comment", StringArgumentType.greedyString())
                            .executes(context -> verdict(context, ReviewAsk.NO,
                                StringArgumentType.getString(context, "comment")))))
                    .then(Commands.literal("note")
                        .then(Commands.argument("comment", StringArgumentType.greedyString())
                            .executes(context -> verdict(context, ReviewAsk.NOTE,
                                StringArgumentType.getString(context, "comment")))))
                    .then(Commands.literal("drop")
                        .then(Commands.argument("id", StringArgumentType.string())
                            .suggests((context, builder) -> SharedSuggestionProvider.suggest(
                                ReviewQueue.load(context.getSource().getServer()).stream()
                                    .filter(ReviewAsk::open).map(ReviewAsk::id).toList(), builder))
                            .executes(ReviewCommands::drop)))
                    .then(Commands.literal("ask")
                        .then(Commands.argument("spec", StringArgumentType.greedyString())
                            .executes(ReviewCommands::ask))))));
    }

    // ---------------------------------------------------------------------------------------------

    private static void reply(final CommandSourceStack source, final String text) {
        source.sendSuccess(() -> Component.literal(text), false);
    }

    private static List<String> sources(final CommandContext<CommandSourceStack> context) {
        final Set<String> out = new LinkedHashSet<>();
        out.add("all");
        ReviewQueue.load(context.getSource().getServer()).stream()
            .filter(ReviewAsk::open).forEach(a -> {
                out.add(a.source());
                out.addAll(a.tags());
            });
        return List.copyOf(out);
    }

    private static int status(final CommandContext<CommandSourceStack> context) {
        final CommandSourceStack source = context.getSource();
        final List<ReviewAsk> asks = ReviewQueue.load(source.getServer());
        if (asks.isEmpty()) {
            reply(source, "The review queue is empty. A mod fills it by declaring subjects, an agent"
                + " by writing " + ReviewQueue.file(source.getServer())
                + " or calling review_post, and you by /mmcp review ask <title | look | failure>.");
            return 0;
        }
        final List<ReviewAsk> walkable = ReviewWalk.walkable(source, asks);
        final ReviewAsk current = ReviewWalk.current(source, asks);
        final String only = ReviewWalk.filterOf(source);
        reply(source, walkable.size() + " of " + asks.size() + " ask(s) still open"
            + (only == null ? "" : " matching '" + only + "'") + "."
            + (current == null ? "\n  Nothing selected — /mmcp review next"
                : "\n  Current: " + ReviewWalk.describe(current)));
        return walkable.size();
    }

    private static int list(final CommandContext<CommandSourceStack> context) {
        final CommandSourceStack source = context.getSource();
        final List<ReviewAsk> asks = ReviewQueue.load(source.getServer());
        if (asks.isEmpty()) {
            return status(context);
        }
        final StringBuilder out = new StringBuilder("Review queue (" + asks.size() + "):");
        for (final ReviewAsk ask : asks) {
            out.append("\n  [").append(ask.state()).append("] ").append(ask.id())
                .append("  (").append(ask.source()).append(")  ").append(ask.title());
        }
        reply(source, out.toString());
        return asks.size();
    }

    private static int reload(final CommandContext<CommandSourceStack> context) {
        final CommandSourceStack source = context.getSource();
        final List<ReviewAsk> asks = ReviewQueue.load(source.getServer());
        // Re-rendering on reload is what makes a hand-written asks.json show up in answers.md
        // without anyone having to answer something first.
        ReviewQueue.save(source.getServer(), asks);
        ReviewWalk.rebuildSnapshot(source.getServer());
        reply(source, "Re-read " + ReviewQueue.file(source.getServer()) + ": " + asks.size()
            + " ask(s), " + asks.stream().filter(ReviewAsk::open).count() + " open.");
        return asks.size();
    }

    private static int check(final CommandContext<CommandSourceStack> context) {
        final CommandSourceStack source = context.getSource();
        // Deferred to the next tick, and it has to be: a check is a COMMAND, and a command run from
        // inside a command is queued rather than executed, so a sweep run here would read every
        // check as "did not hold". See ReviewWalk.PENDING.
        ReviewWalk.later(() -> {
            final List<String> closed = ReviewWalk.sweepChecks(source.getServer(), source);
            reply(source, closed.isEmpty()
                ? "Nothing changed — every ask carrying a check still reads the way it did."
                : "Settled by their own checks: " + String.join(", ", closed)
                    + "\n  A closed one is filed as `checked`, not `ok` — a satisfied predicate is"
                    + " not a person's opinion, and it re-opens if the world stops satisfying it.");
        });
        return 1;
    }

    private static int only(final CommandContext<CommandSourceStack> context) {
        final CommandSourceStack source = context.getSource();
        final String arg = StringArgumentType.getString(context, "source");
        final boolean all = "all".equalsIgnoreCase(arg);
        ReviewWalk.setFilter(source, all ? null : arg);
        reply(source, all ? "Walking every source. /mmcp review next"
            : "Walking '" + arg + "' only (source or tag). /mmcp review next");
        return 1;
    }

    /** Move to the next/previous open ask and stage it. */
    private static int move(final CommandContext<CommandSourceStack> context, final int delta) {
        final CommandSourceStack source = context.getSource();
        final List<ReviewAsk> asks = ReviewQueue.load(source.getServer());
        final List<ReviewAsk> open = ReviewWalk.walkable(source, asks);
        if (open.isEmpty()) {
            reply(source, "Nothing left open" + (ReviewWalk.filterOf(source) == null ? ""
                : " matching '" + ReviewWalk.filterOf(source) + "' (/mmcp review only all)")
                + ". " + ReviewQueue.rendering(source.getServer()) + " has the results.");
            return 0;
        }
        // Nothing pinned yet means nobody has been shown anything, so `next` must present the FIRST
        // open ask rather than step over it. Deriving this from `current` was the first version and
        // it skipped ask one on every fresh start — `current` falls back to the first open ask, and
        // advancing from a fallback treats "you have seen nothing" as "you have seen that one".
        final String pinned = ReviewWalk.pinnedId(source);
        if (pinned == null) {
            reply(source, ReviewWalk.stage(source, delta > 0 ? open.getFirst() : open.getLast()));
            return 1;
        }
        int index = -1;
        for (int i = 0; i < open.size(); i++) {
            if (open.get(i).id().equals(pinned)) {
                index = i;
                break;
            }
        }
        // The pinned ask may have just been answered, which takes it out of `open`. Landing on the
        // one that took its place is what a person expects after answering.
        index = index < 0 ? (delta > 0 ? 0 : open.size() - 1)
            : Math.floorMod(index + delta, open.size());
        reply(source, ReviewWalk.stage(source, open.get(index)));
        return 1;
    }

    private static int go(final CommandContext<CommandSourceStack> context, final String id) {
        final CommandSourceStack source = context.getSource();
        for (final ReviewAsk ask : ReviewQueue.load(source.getServer())) {
            if (ask.id().equalsIgnoreCase(id)) {
                reply(source, ReviewWalk.stage(source, ask));
                return 1;
            }
        }
        source.sendFailure(Component.literal("No ask called '" + id + "'."));
        return 0;
    }

    /**
     * Withdraw an ask that nobody has answered.
     *
     * <p><b>Only an open one.</b> Withdrawing a question is legitimate — an agent posts one, then
     * sees it was the wrong question — but an answered ask is a record of what a person said, and
     * a queue whose verdicts can be made to vanish is not evidence of anything. That asymmetry is
     * the same one {@link ReviewQueue#merge} applies to subjects a mod stops declaring.
     */
    private static int drop(final CommandContext<CommandSourceStack> context) {
        final CommandSourceStack source = context.getSource();
        final String id = StringArgumentType.getString(context, "id");
        final List<ReviewAsk> asks = ReviewQueue.load(source.getServer());
        for (final ReviewAsk ask : asks) {
            if (!ask.id().equalsIgnoreCase(id)) {
                continue;
            }
            if (!ask.open()) {
                source.sendFailure(Component.literal(ask.id() + " was answered ("
                    + ask.state().toUpperCase(Locale.ROOT) + (ask.answeredBy() == null ? ""
                        : " by " + ask.answeredBy()) + ") and is kept. Only an open ask can be"
                    + " withdrawn — a verdict that can be deleted is not evidence."));
                return 0;
            }
            asks.remove(ask);
            ReviewQueue.save(source.getServer(), asks);
            ReviewWalk.rebuildSnapshot(source.getServer());
            reply(source, "Withdrew " + ask.id() + ". " + asks.size() + " ask(s) left.");
            return 1;
        }
        source.sendFailure(Component.literal("No ask called '" + id + "'."));
        return 0;
    }

    private static int verdict(final CommandContext<CommandSourceStack> context, final String state,
                               final String comment) {
        final CommandSourceStack source = context.getSource();
        final String said = ReviewWalk.verdict(source, state, comment);
        if (said == null) {
            source.sendFailure(Component.literal("Nothing selected. /mmcp review next"));
            return 0;
        }
        reply(source, said);
        // A note is a remark on a subject the human is still looking at, so it does NOT advance; ok
        // and no are verdicts and they do. Getting this backwards makes it impossible to leave two
        // remarks on one subject.
        return ReviewAsk.NOTE.equals(state) ? 1 : move(context, 1);
    }

    /**
     * Post an ask from in-game — the convenience path; the file and {@code review_post} are the real
     * ones.
     *
     * <p>Pipe-separated because a Brigadier command cannot take four greedy strings. Anything richer
     * than these fields belongs in {@code asks.json}, where it can be written properly.
     */
    private static int ask(final CommandContext<CommandSourceStack> context) {
        final CommandSourceStack source = context.getSource();
        final String[] parts = StringArgumentType.getString(context, "spec")
            .split("\\s*\\|\\s*", 4);
        if (parts.length < 3) {
            source.sendFailure(Component.literal("Give at least three fields separated by |:"
                + " <title> | <what to look at> | <what failure looks like> [| <setup;commands>]."
                + " The failure field is not optional — an ask that cannot fail returns nothing."));
            return 0;
        }
        final List<ReviewAsk> asks = ReviewQueue.load(source.getServer());
        final List<String> setup = new ArrayList<>();
        if (parts.length > 3 && !parts[3].isBlank()) {
            for (final String command : parts[3].split("\\s*;\\s*")) {
                if (!command.isBlank()) {
                    setup.add(command.trim());
                }
            }
        }
        final ReviewAsk posted;
        try {
            posted = ReviewAsk.open(nextId(asks), source.getTextName().toLowerCase(Locale.ROOT),
                parts[0], parts[1], parts[2], setup, null, null);
        } catch (final IllegalArgumentException bad) {
            source.sendFailure(Component.literal("Refused: " + bad.getMessage()));
            return 0;
        }
        asks.add(posted);
        ReviewQueue.save(source.getServer(), asks);
        ReviewWalk.emit("review_posted", posted, null, null, source.getTextName());
        reply(source, "Posted " + posted.id() + ". " + asks.size() + " ask(s) in the queue.");
        return 1;
    }

    /** Short, stable, and never reused — a verdict is filed under it and later sessions cite it. */
    static String nextId(final List<ReviewAsk> asks) {
        int n = asks.size() + 1;
        while (true) {
            final String candidate = "ask-" + n;
            if (asks.stream().noneMatch(a -> a.id().equals(candidate))) {
                return candidate;
            }
            n++;
        }
    }
}
