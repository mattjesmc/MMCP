package com.mattmc.mcptoolkit.review;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.EventLog;
import com.mattmc.mcptoolkit.McpToolkit;
import net.minecraft.commands.CommandResultCallback;
import net.minecraft.commands.CommandSource;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import org.jspecify.annotations.Nullable;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

/**
 * <b>The walk: one human, one question at a time, standing in front of the answer.</b>
 *
 * <p>{@link ReviewQueue} is the storage; this is the instrument. It stages an ask, hands the person
 * the question, files what they say, and keeps the client card fed. {@link ReviewCommands} and
 * {@link ReviewTools} are both thin over this class, so an ask answered in-game and an ask read back
 * over MCP can never disagree about what happened.
 *
 * <h2>Staging is the point, and it is why this lives in the toolkit rather than in a text file</h2>
 *
 * An owed human test is almost never "look at the thing in front of you" — it is "does the night on
 * an airless world read as atmosphere or as a bug", which requires being on an airless world, at
 * night. Prose in a design document cannot do that; a command can. Each ask carries {@code setup},
 * a list of server commands run in order, so {@code next} means <b>travel to the right place, set
 * the right time, spawn the right subject, and then ask the question</b>, and the human's whole job
 * is to look and answer.
 *
 * <p><b>The setup commands run at the reviewer's own permission level, from a file.</b> That is
 * deliberate and it is the feature — an agent pre-stages a scenario it cannot otherwise describe —
 * but it means {@code asks.json} is as trusted as the console. It is written by whoever already has
 * the console, so this grants nothing new; it is stated because a file that runs commands should
 * never be a surprise.
 *
 * <p><b>Staging output is captured, not suppressed.</b> The ancestor of this class silenced its
 * setup commands so their chatter would not bury the question. Silencing threw away the one thing
 * that made a rejection reproducible: menagerie's staging prints the seed it drew, and a verdict on
 * "creature 4 looks wrong" is worthless without it. So the commands run against a capturing
 * {@link CommandSource}: the chat stays clean, the last line each command printed is kept as the
 * ask's {@link ReviewAsk#staged} note, and it rides the verdict into the file.
 *
 * <h2>The cursor is per player and in memory on purpose</h2>
 *
 * Where somebody has got to is not worth persisting: the queue itself records what is answered, so a
 * restart resumes at the first open ask, which is the right place anyway. Anything more would be
 * state that can disagree with the file.
 */
public final class ReviewWalk {

    private ReviewWalk() {}

    /**
     * Work that must not run inside a command.
     *
     * <p><b>A command run from inside a command does not execute — it is QUEUED.</b>
     * {@code Commands.executeCommandInContext} accepts the outer {@code ExecutionContext} when one
     * is already open and defers the nested command to its queue, which drains after the outer
     * handler has returned. So staging fired from {@code /mmcp review next} would have run <em>after</em>
     * the walk finished reading its results: the captured staging note would always have been empty
     * and every check would have read as "did not hold" — a silent, total failure of both features,
     * and the kind that looks like the feature simply not working rather than like a bug.
     *
     * <p>The fix is to do that work at {@code END_SERVER_TICK}, one tick later, where no execution
     * context is open and a nested command really runs (and its callback really fires). The visible
     * cost is that staging completes a tick after the question appears, which is invisible to a
     * human and honest in the reply.
     */
    private static final Deque<Runnable> PENDING = new ArrayDeque<>();

    /** Which ask each reviewer was last SHOWN. See the class doc for why it is not saved. */
    private static final Map<UUID, String> CURSOR = new HashMap<>();

    /** Which source each reviewer is walking, or null for all of them. */
    private static final Map<UUID, String> FILTER = new HashMap<>();

    /** The whole presenter state as one JSON string — safe from any thread, rebuilt on change. */
    private static volatile String snapshot = "{\"asks\":{}}";

    /** The {@code GET /review} body: {@code {"asks":{"<player lowercase>": {…}}}}. */
    public static String snapshotJson() {
        return snapshot;
    }

    static void forget(final UUID who) {
        CURSOR.remove(who);
        FILTER.remove(who);
    }

    /** Do this next tick, outside any command's execution context. See {@link #PENDING}. */
    static void later(final Runnable work) {
        PENDING.add(work);
    }

    /**
     * Drain the deferred work, once per tick.
     *
     * <p>Bounded by the queue's size at entry rather than looping until empty: a deferred job that
     * enqueues another must wait for the next tick, or one review command could spin the tick.
     */
    static void drain(final MinecraftServer server) {
        for (int i = PENDING.size(); i > 0 && !PENDING.isEmpty(); i--) {
            try {
                PENDING.poll().run();
            } catch (final RuntimeException e) {
                McpToolkit.LOGGER.error("[review] deferred work failed", e);
            }
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Selection
    // ---------------------------------------------------------------------------------------------

    /**
     * The asks this reviewer is walking: open ones, narrowed by their filter.
     *
     * <p>The filter matches a SOURCE or a TAG, with one term and no syntax to choose between them.
     * That is deliberate: "walk menagerie" and "walk the substance tier" are the same request in a
     * reviewer's head, and a mod with seventy subjects is unusable without the second one.
     */
    static List<ReviewAsk> walkable(final CommandSourceStack source, final List<ReviewAsk> asks) {
        final String only = filterOf(source);
        return asks.stream()
            .filter(ReviewAsk::open)
            .filter(a -> only == null || a.matches(only))
            .toList();
    }

    static @Nullable String filterOf(final CommandSourceStack source) {
        final UUID who = reviewerId(source);
        return who == null ? null : FILTER.get(who);
    }

    static void setFilter(final CommandSourceStack source, final @Nullable String only) {
        final UUID who = reviewerId(source);
        if (who != null) {
            if (only == null) {
                FILTER.remove(who);
            } else {
                FILTER.put(who, only);
            }
            CURSOR.remove(who); // a new filter means a new walk; a cursor into the old one misleads
            rebuildSnapshot(source.getServer());
        }
    }

    /**
     * Which ask this reviewer is on: the one they last staged, or the first still open.
     *
     * <p>Falling back to "first open" rather than to nothing is what makes the queue usable straight
     * after a restart, when the in-memory cursor is gone but the file remembers everything that
     * matters.
     */
    static @Nullable ReviewAsk current(final CommandSourceStack source, final List<ReviewAsk> asks) {
        final String pinned = pinnedId(source);
        if (pinned != null) {
            for (final ReviewAsk ask : asks) {
                if (ask.id().equals(pinned)) {
                    return ask;
                }
            }
        }
        final List<ReviewAsk> open = walkable(source, asks);
        return open.isEmpty() ? null : open.getFirst();
    }

    /** The ask this reviewer was last SHOWN, or null if they have not been shown one. */
    static @Nullable String pinnedId(final CommandSourceStack source) {
        final UUID who = reviewerId(source);
        return who == null ? null : CURSOR.get(who);
    }

    /**
     * Who is reviewing: the calling player, or — for a console/tool caller — the only human online.
     *
     * <p>The single-player fallback is what lets an agent stage an ask over MCP for the person
     * standing in the world. With nobody or several people connected there is no honest answer, and
     * a guess would file somebody else's verdict under their name.
     */
    private static @Nullable UUID reviewerId(final CommandSourceStack source) {
        final ServerPlayer player = reviewerPlayer(source);
        return player == null ? null : player.getUUID();
    }

    /** The reviewer as a live player -- re-read, never cached: staging moves them. */
    private static @Nullable ServerPlayer reviewerPlayer(final CommandSourceStack source) {
        final ServerPlayer player = source.getPlayer();
        if (player != null) {
            // Re-resolved through the player list so a source captured before a dimension change
            // does not hand back a stale entity.
            final ServerPlayer live = source.getServer().getPlayerList().getPlayer(player.getUUID());
            return live == null ? player : live;
        }
        final List<ServerPlayer> online = source.getServer().getPlayerList().getPlayers();
        return online.size() == 1 ? online.getFirst() : null;
    }

    // ---------------------------------------------------------------------------------------------
    // Staging
    // ---------------------------------------------------------------------------------------------

    /**
     * Put the reviewer where the answer is, then ask the question. Returns what to tell them.
     *
     * <p>Staging is best-effort and says so: if a setup command fails, the ask is still selected and
     * the human is told what did not run. Refusing to present the question because the scenery could
     * not be arranged would lose the question too — and an ask whose staging failed is exactly the
     * one a person should be looking at sceptically.
     */
    static String stage(final CommandSourceStack source, final ReviewAsk ask) {
        final MinecraftServer server = source.getServer();
        final UUID who = reviewerId(source);
        if (who != null) {
            CURSOR.put(who, ask.id());
        }
        // The ask is selected NOW — the cursor, the card and the question do not depend on the
        // scenery — and the scenery is arranged next tick, for the reason PENDING documents. The
        // reviewer therefore reads the question while the world is still arriving, which is the
        // honest order: a question you can read before the staging lands is better than one that
        // silently loses the note the staging printed.
        if (!ask.setup().isEmpty()) {
            later(() -> runSetup(source, ask));
        }
        rebuildSnapshot(server);
        return describe(ask)
            + (ask.setup().isEmpty() ? "" : "\n  staging: " + String.join("; ", ask.setup()))
            + "\n  Answer with /mmcp review ok | no <why> | note <what> | skip";
    }

    /**
     * Phase two of staging: run the commands, keep what they said, and report anything that broke.
     *
     * <p><b>Each command runs from where the reviewer NOW STANDS</b>, re-derived between commands
     * rather than taken once from the caller. This is not a nicety — it is rocketeer
     * {@code WORLDS_AND_RUINS.md} 17.1, which cost nine verdicts. Its asks staged with
     * {@code rocketeer visit <world>} followed by {@code time set midnight}, and a console command
     * executes in the OVERWORLD: every one of those set home's clock and left the planet in
     * daylight. The reviewer answered eight questions about times of day they were never shown, and
     * the only reason anyone found out is that they typed "I think all time was equalized to
     * overworld?" into a comment on a ninth. The first setup command is usually the one that TRAVELS,
     * so the ones after it must follow.
     */
    private static void runSetup(final CommandSourceStack source, final ReviewAsk ask) {
        final MinecraftServer server = source.getServer();
        final List<String> failed = new ArrayList<>();
        final List<String> said = new ArrayList<>();
        for (final String command : ask.setup()) {
            final Capture capture = new Capture();
            if (run(here(source), command, capture, null)) {
                said.addAll(capture.lines());
            } else {
                failed.add(command);
            }
        }
        // The SCENE, read after the staging rather than assumed from it -- 17.1's other half. A
        // stager that cannot describe what it staged will eventually stage the wrong thing silently,
        // and the fix is not "get the source right" (that is the fix above) but to put the actual
        // world, clock and light in front of the person answering, so a mis-staged scenario is wrong
        // on screen inside the sentence they are answering.
        said.addFirst(scene(source));
        final String note = String.join(" | ", said);
        if (!note.isBlank() || ask.staged() != null) {
            // Re-read rather than reusing the list `stage` saw: a verdict may have landed in the
            // meantime, and writing back a stale copy would undo it.
            ReviewQueue.replace(server, ReviewQueue.load(server), ask.withStaged(note));
        }
        rebuildSnapshot(server);
        final String text = "STAGED: " + note
            + (failed.isEmpty() ? ""
                : "\nSTAGING INCOMPLETE, these did not run: " + failed
                    + "\n  Judge that sceptically — you may not be looking at the subject.");
        source.sendSuccess(() -> Component.literal(text), false);
    }

    /**
     * The caller's command source, moved to wherever the reviewer currently is.
     *
     * <p>Position, level AND entity: {@code time set} reads the level, a relative coordinate reads
     * the position, and a selector reads the entity. Leaving any of the three behind gives a command
     * that runs somewhere other than where the question is being asked.
     */
    private static CommandSourceStack here(final CommandSourceStack source) {
        final ServerPlayer reviewer = reviewerPlayer(source);
        return reviewer == null ? source
            : source.withEntity(reviewer).withLevel(reviewer.level())
                .withPosition(reviewer.position());
    }

    /**
     * What the reviewer is actually standing in, in one line: world, biome, this world's own clock,
     * light, position.
     *
     * <p>{@code getDefaultClockTime}, not {@code getDayTime}: the first reads THIS level's clock and
     * the second the overworld's. Vanilla puts the two one line apart in {@code Level}, which is the
     * lost-verdicts bug rendered as an API, and reaching for the familiar name is how it happens.
     */
    private static String scene(final CommandSourceStack source) {
        final ServerPlayer reviewer = reviewerPlayer(source);
        if (reviewer == null) {
            return "nobody to stage for";
        }
        final ServerLevel level = reviewer.level();
        final BlockPos at = reviewer.blockPosition();
        final StringBuilder out = new StringBuilder(level.dimension().identifier().toString());
        level.getBiome(at).unwrapKey().ifPresent(key -> out.append(", ").append(key.identifier()));
        final long day = Math.floorMod(level.getDefaultClockTime(), 24000L);
        out.append(", time ").append(day).append(' ').append(partOfDay(day))
            .append(", light ").append(level.getMaxLocalRawBrightness(at))
            .append(", at ").append(at.getX()).append(' ').append(at.getY())
            .append(' ').append(at.getZ());
        return out.toString();
    }

    private static String partOfDay(final long dayTime) {
        if (dayTime < 3000) {
            return "(morning)";
        }
        if (dayTime < 9000) {
            return "(midday)";
        }
        if (dayTime < 12000) {
            return "(afternoon)";
        }
        return dayTime < 13000 ? "(dusk)" : "(night)";
    }

    /**
     * Run one command as the reviewer, capturing what it printed and (optionally) its numeric result.
     *
     * <p>Deliberately NOT {@code withSuppressedOutput()}: suppression sets {@code silent}, which
     * stops the capture too — see the class doc for what that costs. Swapping the {@link
     * CommandSource} instead keeps the reviewer's position, level and permissions (so a staging
     * teleport still moves the right person) while sending the text here rather than to their chat.
     */
    private static boolean run(final CommandSourceStack source, final String command,
                               final Capture capture, final @Nullable CommandResultCallback back) {
        try {
            CommandSourceStack staged = source.withSource(capture);
            if (back != null) {
                staged = staged.withCallback(back);
            }
            source.getServer().getCommands().performPrefixedCommand(staged, command);
            return true;
        } catch (final RuntimeException e) {
            McpToolkit.LOGGER.error("[review] command failed: {}", command, e);
            return false;
        }
    }

    /**
     * Collects what a staged command said, so the last thing it printed can ride the verdict.
     *
     * <p>Only the LAST line each command prints is kept: a staging command that prints a paragraph
     * is describing its work, and the note wants its conclusion ("Staged seed 8812440 as role
     * woolly"), not its narration.
     */
    private static final class Capture implements CommandSource {
        private @Nullable String last;

        /** The one line worth keeping, as a list so callers can concatenate several commands'. */
        private List<String> lines() {
            return this.last == null ? List.of() : List.of(this.last);
        }

        @Override
        public void sendSystemMessage(final Component message) {
            final String text = message.getString().trim();
            if (!text.isEmpty()) {
                this.last = text.length() > 160 ? text.substring(0, 157) + "…" : text;
            }
        }

        @Override
        public boolean acceptsSuccess() {
            return true;
        }

        @Override
        public boolean acceptsFailure() {
            return true;
        }

        @Override
        public boolean shouldInformAdmins() {
            return false;
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Verdicts
    // ---------------------------------------------------------------------------------------------

    /** File a human's verdict on the ask they are looking at. Returns what to tell them, or null. */
    static @Nullable String verdict(final CommandSourceStack source, final String state,
                                    final @Nullable String comment) {
        final MinecraftServer server = source.getServer();
        final List<ReviewAsk> asks = ReviewQueue.load(server);
        final ReviewAsk current = current(source, asks);
        if (current == null) {
            return null;
        }
        final ServerPlayer player = source.getPlayer();
        final String who = player != null ? player.getGameProfile().name() : source.getTextName();
        final List<ReviewAsk> saved = ReviewQueue.replace(server, asks,
            current.answered(state, comment, who, tick(server)));
        rebuildSnapshot(server);
        emit("review_answered", current, state, comment, who);
        final long open = walkable(source, saved).size();
        return current.id() + " -> " + state.toUpperCase(Locale.ROOT)
            + (comment == null ? "" : " (" + comment + ")")
            + "\n  " + open + " left. /mmcp review next";
    }

    /**
     * Answer every open ask whose {@code check} the world already satisfies.
     *
     * <p><b>A check can only ANSWER an ask, never fail one.</b> The asymmetry is the whole design: a
     * predicate that holds is proof the question is settled, while a predicate that does not hold is
     * ambiguous — the feature may be broken, or the world may simply not be staged yet, and those
     * two are indistinguishable from here. So a passing check closes the ask and a failing one is
     * silent, leaving it for the human it was always going to need.
     *
     * <p>The verdict is filed as {@link ReviewAsk#CHECKED} rather than {@code ok}, in its own
     * section of the rendering, because "the world satisfies this" and "a person looked at this and
     * was happy" are different facts and a layer that exists to stop confident nonsense must not
     * blur them.
     *
     * <p><b>A {@code checked} verdict is provisional and this sweep re-evaluates it.</b> It is the
     * world's answer as of the last time anyone asked, and worlds change: an ask closed because the
     * tree was there re-opens when the tree is gone, and the human who then walks it is being asked
     * a question that has genuinely become live again. Human verdicts are never re-evaluated —
     * {@code ok}, {@code no} and {@code note} are records of what a person said and nothing here
     * may overwrite one.
     *
     * @return the ids that closed
     */
    public static List<String> sweepChecks(final MinecraftServer server,
                                           final CommandSourceStack asWhom) {
        final List<String> closed = new ArrayList<>();
        List<ReviewAsk> asks = ReviewQueue.load(server);
        for (final ReviewAsk ask : List.copyOf(asks)) {
            final boolean provisional = ReviewAsk.CHECKED.equals(ask.state());
            if (!ask.open() && !provisional) {
                continue; // a person's verdict; nothing in here may touch one
            }
            if (ask.check() == null || ask.check().isBlank()) {
                continue;
            }
            final boolean[] held = {false};
            run(asWhom, ask.check(), new Capture(),
                (success, result) -> held[0] = success && result > 0);
            if (held[0] == provisional) {
                continue; // still satisfied, or still unanswerable — either way, no change
            }
            final ReviewAsk answered = held[0]
                ? ask.answered(ReviewAsk.CHECKED, "check passed: /" + ask.check(), "referee",
                    tick(server))
                : ask.reopened();
            asks = ReviewQueue.replace(server, asks, answered);
            closed.add(ask.id() + (held[0] ? "" : " (re-opened)"));
            emit("review_answered", ask, answered.state(), answered.comment(), "referee");
        }
        if (!closed.isEmpty()) {
            rebuildSnapshot(server);
        }
        return closed;
    }

    // ---------------------------------------------------------------------------------------------
    // Presentation
    // ---------------------------------------------------------------------------------------------

    /**
     * When a verdict was filed, in the WORLD's clock rather than the server process's.
     *
     * <p>{@code getTickCount()} counts from server start, so a verdict filed by the start-of-run
     * check sweep timestamps itself 0 and two runs' verdicts cannot be ordered against each other.
     * The overworld's game time is the same number every other envelope in the toolkit calls
     * {@code game_tick}, which is what makes a verdict comparable to the events around it.
     */
    private static long tick(final MinecraftServer server) {
        return server.overworld().getGameTime();
    }

    static String describe(final ReviewAsk ask) {
        return ask.id() + " — " + ask.title()
            + "\n  LOOK: " + ask.look()
            + "\n  FAILS IF: " + ask.failure()
            + "\n  from: " + ask.source()
            + (ask.from() == null ? "" : " — " + ask.from());
    }

    /**
     * Rebuild the client card's snapshot: for every online player, the ask they are looking at.
     *
     * <p>Pull, not push, exactly like the §15 task presenter: the client tails
     * {@code GET /review}, which works identically against the integrated server and a localhost
     * dedicated one, and a client that restarts mid-walk re-fetches the live question.
     */
    static void rebuildSnapshot(final @Nullable MinecraftServer server) {
        if (server == null) {
            snapshot = "{\"asks\":{}}";
            return;
        }
        final JsonObject asksByPlayer = new JsonObject();
        final List<ReviewAsk> asks = ReviewQueue.load(server);
        for (final ServerPlayer player : server.getPlayerList().getPlayers()) {
            final String pinned = CURSOR.get(player.getUUID());
            if (pinned == null) {
                continue; // nobody has shown them anything; an unasked question is not a card
            }
            for (final ReviewAsk ask : asks) {
                if (ask.id().equals(pinned)) {
                    asksByPlayer.add(player.getGameProfile().name().toLowerCase(Locale.ROOT),
                        card(ask, remaining(asks, FILTER.get(player.getUUID()))));
                    break;
                }
            }
        }
        final JsonObject out = new JsonObject();
        out.add("asks", asksByPlayer);
        snapshot = out.toString();
    }

    private static int remaining(final List<ReviewAsk> asks, final @Nullable String only) {
        int n = 0;
        for (final ReviewAsk ask : asks) {
            if (ask.open() && (only == null || ask.matches(only))) {
                n++;
            }
        }
        return n;
    }

    private static JsonObject card(final ReviewAsk ask, final int open) {
        final JsonObject o = new JsonObject();
        o.addProperty("id", ask.id());
        o.addProperty("source", ask.source());
        o.addProperty("title", ask.title());
        o.addProperty("look", ask.look());
        o.addProperty("failure", ask.failure());
        o.addProperty("state", ask.state());
        o.addProperty("open", open);
        if (ask.staged() != null) {
            o.addProperty("staged", ask.staged());
        }
        if (ask.at() != null) {
            final JsonObject at = new JsonObject();
            at.addProperty("x", ask.at().getX());
            at.addProperty("y", ask.at().getY());
            at.addProperty("z", ask.at().getZ());
            o.add("at", at);
        }
        return o;
    }

    // ---------------------------------------------------------------------------------------------

    /**
     * Announce a verdict on the event stream.
     *
     * <p>The file is how the NEXT session learns the answer; this is how a session that is still
     * running learns it. That difference is what turns an inbox into a conversation — an agent can
     * post an ask, watch for the verdict, fix the thing and stage it again while the human is still
     * standing there.
     */
    static void emit(final String type, final ReviewAsk ask, final @Nullable String state,
                     final @Nullable String comment, final @Nullable String who) {
        final JsonObject data = new JsonObject();
        data.addProperty("id", ask.id());
        data.addProperty("source", ask.source());
        data.addProperty("title", ask.title());
        if (state != null) {
            data.addProperty("verdict", state);
        }
        if (comment != null) {
            data.addProperty("comment", comment);
        }
        if (who != null) {
            data.addProperty("by", who);
        }
        if (ask.staged() != null) {
            data.addProperty("staged", ask.staged());
        }
        EventLog.emit(type, data);
    }

    static JsonArray idsOf(final List<ReviewAsk> asks) {
        final JsonArray out = new JsonArray();
        asks.forEach(a -> out.add(a.id()));
        return out;
    }
}
