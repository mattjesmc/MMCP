package com.mattmc.mcptoolkit.review;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.core.BlockPos;
import org.jspecify.annotations.Nullable;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * <b>One thing a human is being asked to look at, and what they said about it.</b>
 *
 * <p>This record is the whole vocabulary of the review layer. It was distilled from two independent
 * implementations of the same idea — menagerie's {@code ReviewCatalogue}/{@code ReviewSession}
 * (subjects enumerated from the enums, staged by spawning the real thing, the seed carried on the
 * verdict) and rocketeer's {@code ReviewQueue}/{@code ReviewCommands} (a JSON queue an agent writes
 * from outside the game, each ask carrying the commands that put a reviewer in front of it). Each
 * built half of the answer; the fields below are the union, and the rules in the constructor are the
 * rules both of them arrived at separately.
 *
 * <h2>The rules that are not negotiable</h2>
 *
 * <b>An ask with no failure mode is refused.</b> Both mods enforced this and it is the single best
 * rule either of them has: a step that cannot fail collects a nod rather than a judgement, and
 * agreement from someone who was never told what wrong looks like is the most expensive kind of
 * nothing. {@link #failure} is required and the constructor throws without it — including for an ask
 * that carries a {@link #check}, because the check is precisely a test for that failure's absence.
 *
 * <p><b>Staging is a list of server commands, and nothing else.</b> rocketeer's asks already worked
 * this way; menagerie's staged through Java, which is why its walk could not live anywhere but
 * menagerie. Commands are the general form: they cross the mod boundary, they can be written into a
 * file by an agent with no server running, and a mod that needs richer staging exposes one command
 * of its own and names it here. The cost is stated openly in {@link ReviewWalk}: this file is as
 * trusted as the console.
 *
 * <p><b>A verdict gates nothing.</b> Deliberately, in both ancestors and here: a subjective judgement
 * that could fail a build turns a person's opinion into a merge conflict. The consumer is the next
 * session, which reads the queue and decides.
 *
 * @param id       stable and short; what a verdict is filed under and what a later session cites
 * @param source   who asked — a mod id for a declared subject ({@link Review#declare}), otherwise
 *                 whatever the poster called itself. Also the walk's filter.
 * @param title    one line: the question itself
 * @param look     where to point the eyes once staged — the thing that is actually being judged
 * @param failure  <b>what it looks like when it is wrong.</b> Required; see above
 * @param setup    server commands run in order to put the reviewer in front of the subject
 * @param check    a command whose success means <em>the world already answers this</em>, so no human
 *                 is spent on it. It can only ever ANSWER an ask, never fail one — see
 *                 {@link ReviewWalk#sweepChecks}
 * @param at       optional world anchor: the block the client card highlights while this ask is up
 * @param state    {@code open}, a human verdict ({@code ok} | {@code no} | {@code note}), or
 *                 {@code checked} — answered by the referee with nobody looking, which is a
 *                 different fact from a human's {@code ok} and is filed as one
 * @param comment  the reviewer's words; required for {@code no}
 * @param answeredBy who answered — a player name, or {@code referee} for a {@code checked} ask
 * @param answeredTick the game tick the verdict was filed at, or null
 * @param from     who asked and why it matters, in free text — a document section, a bug, a promise
 *                 made in a handoff. Distinct from {@link #source}, which is a short attribution the
 *                 walk FILTERS on: "rocketeer" is a source, "WORLDS_AND_RUINS.md §14.4 — the five
 *                 numbers only a human can settle" is a from. It is also where a re-opened ask
 *                 records why it was re-opened, which is the one piece of an ask's history that has
 *                 ever actually been needed
 * @param tags     free labels for narrowing a walk — a mod's own tier or theme. {@code /mmcp review only}
 *                 matches a tag as readily as a source, which is what lets a mod with seventy
 *                 subjects hand a reviewer a subset small enough to actually finish
 * @param staged   what staging reported the last time this ask was presented. This is the field that
 *                 carries menagerie's seed across the command seam: its stage command prints the seed
 *                 it drew, the walk captures the line, and a rejection is reproducible again
 */
public record ReviewAsk(String id, String source, String title, String look, String failure,
                        List<String> setup, @Nullable String check, @Nullable BlockPos at,
                        @Nullable String from, List<String> tags, String state,
                        @Nullable String comment,
                        @Nullable String answeredBy, @Nullable Long answeredTick,
                        @Nullable String staged) {

    /** Every state an ask can be in. {@code open} is the only one the walk presents. */
    public static final String OPEN = "open";
    public static final String OK = "ok";
    public static final String NO = "no";
    public static final String NOTE = "note";
    /** Answered by {@link ReviewWalk#sweepChecks} — the world satisfied the ask; nobody looked. */
    public static final String CHECKED = "checked";

    public static final List<String> STATES = List.of(OPEN, OK, NO, NOTE, CHECKED);

    public ReviewAsk {
        if (id == null || id.isBlank()) {
            throw new IllegalArgumentException("a review ask needs an id");
        }
        if (title == null || title.isBlank()) {
            throw new IllegalArgumentException(id + ": a review ask needs a title");
        }
        if (look == null || look.isBlank()) {
            throw new IllegalArgumentException(id + ": a review ask needs something to look at");
        }
        if (failure == null || failure.isBlank()) {
            throw new IllegalArgumentException(id + ": a review ask needs a FAILURE mode — an ask"
                + " that cannot fail spends a human's attention and returns nothing");
        }
        if (state == null || !STATES.contains(state)) {
            throw new IllegalArgumentException(id + ": unknown state '" + state + "' (one of "
                + String.join(", ", STATES) + ")");
        }
        source = source == null || source.isBlank() ? "unattributed" : source;
        setup = setup == null ? List.of() : List.copyOf(setup);
        tags = tags == null ? List.of() : List.copyOf(tags);
    }

    /** A fresh, unanswered ask — the shape {@link Review#declare} and {@code review_post} build. */
    public static ReviewAsk open(final String id, final String source, final String title,
                                 final String look, final String failure, final List<String> setup,
                                 final @Nullable String check, final @Nullable BlockPos at) {
        return new ReviewAsk(id, source, title, look, failure, setup, check, at, null, List.of(),
            OPEN, null, null, null, null);
    }

    public boolean open() {
        return OPEN.equals(this.state);
    }

    /** The commands that put a reviewer in front of this subject. See {@link ReviewWalk}. */
    public ReviewAsk withSetup(final String... commands) {
        return new ReviewAsk(this.id, this.source, this.title, this.look, this.failure,
            List.of(commands), this.check, this.at, this.from, this.tags, this.state, this.comment,
            this.answeredBy, this.answeredTick, this.staged);
    }

    /** A command whose success means the world already answers this, so no human is spent on it. */
    public ReviewAsk withCheck(final String command) {
        return new ReviewAsk(this.id, this.source, this.title, this.look, this.failure, this.setup,
            command, this.at, this.from, this.tags, this.state, this.comment, this.answeredBy,
            this.answeredTick, this.staged);
    }

    /** The block the client card highlights while this ask is up. */
    public ReviewAsk withAt(final BlockPos pos) {
        return new ReviewAsk(this.id, this.source, this.title, this.look, this.failure, this.setup,
            this.check, pos, this.from, this.tags, this.state, this.comment, this.answeredBy,
            this.answeredTick, this.staged);
    }

    /** Who asked and why it matters — a document section, a bug, a promise. See {@link #from}. */
    public ReviewAsk withFrom(final String provenance) {
        return new ReviewAsk(this.id, this.source, this.title, this.look, this.failure, this.setup,
            this.check, this.at, provenance, this.tags, this.state, this.comment, this.answeredBy,
            this.answeredTick, this.staged);
    }

    /** Labels a reviewer can narrow the walk by: {@code /mmcp review only <tag>}. */
    public ReviewAsk withTags(final String... labels) {
        return new ReviewAsk(this.id, this.source, this.title, this.look, this.failure, this.setup,
            this.check, this.at, this.from, List.of(labels), this.state, this.comment,
            this.answeredBy, this.answeredTick, this.staged);
    }

    /** True when this ask answers to {@code term} as either its source or one of its tags. */
    public boolean matches(final String term) {
        if (this.source.equalsIgnoreCase(term)) {
            return true;
        }
        for (final String tag : this.tags) {
            if (tag.equalsIgnoreCase(term)) {
                return true;
            }
        }
        return false;
    }

    /**
     * The same ask attributed to the mod that declared it.
     *
     * <p>Package-private and applied by {@link Review#declare} from the entrypoint's own mod id —
     * never by the declaring mod itself, the same rule {@code ToolDef.withSource} follows, so the
     * attribution the walk filters on cannot be spoofed or forgotten.
     */
    ReviewAsk withSource(final String modId) {
        return new ReviewAsk(this.id, modId, this.title, this.look, this.failure, this.setup,
            this.check, this.at, this.from, this.tags, this.state, this.comment, this.answeredBy,
            this.answeredTick, this.staged);
    }

    ReviewAsk answered(final String verdict, final @Nullable String note, final String who,
                       final long tick) {
        return new ReviewAsk(this.id, this.source, this.title, this.look, this.failure, this.setup,
            this.check, this.at, this.from, this.tags, verdict, note, who, tick, this.staged);
    }

    /**
     * Back to open, with the machine verdict cleared.
     *
     * <p>Only ever applied to a {@link #CHECKED} ask whose predicate has stopped holding — see
     * {@link ReviewWalk#sweepChecks}. There is deliberately no path that re-opens a human verdict.
     */
    ReviewAsk reopened() {
        return new ReviewAsk(this.id, this.source, this.title, this.look, this.failure, this.setup,
            this.check, this.at, this.from, this.tags, OPEN, null, null, null, this.staged);
    }

    ReviewAsk withStaged(final @Nullable String note) {
        return new ReviewAsk(this.id, this.source, this.title, this.look, this.failure, this.setup,
            this.check, this.at, this.from, this.tags, this.state, this.comment, this.answeredBy,
            this.answeredTick, note);
    }

    /**
     * This ask's description replaced by a freshly declared one, <b>keeping every answer field</b>.
     *
     * <p>The reason {@link Review#declare} is safe to call on every boot: a mod that enumerates its
     * subjects from its own enums re-declares all of them each time the server starts, and a
     * declaration that reset the state would erase every verdict a human ever gave. Text drifts with
     * the code and should; a judgement is a record of a moment and must not.
     */
    ReviewAsk redescribed(final ReviewAsk fresh) {
        return new ReviewAsk(this.id, fresh.source, fresh.title, fresh.look, fresh.failure,
            fresh.setup, fresh.check, fresh.at, fresh.from, fresh.tags, this.state, this.comment,
            this.answeredBy, this.answeredTick, this.staged);
    }

    // -------------------------------------------------------------------------------------------
    // JSON. The file is hand-written by agents, so reading is forgiving about everything except the
    // four fields whose absence would make an ask meaningless; writing is exhaustive and stable.
    // -------------------------------------------------------------------------------------------

    static ReviewAsk read(final JsonObject o) {
        final List<String> setup = new ArrayList<>();
        if (o.has("setup") && o.get("setup").isJsonArray()) {
            for (final var element : o.getAsJsonArray("setup")) {
                setup.add(element.getAsString());
            }
        }
        // rocketeer's `stage` was arguments to one fixed command (`/rocketeer visit`). The general
        // layer has no fixed command, so a legacy `stage` reads as what it always meant — the first
        // staging step — and is written back as plain setup. Migration without a migration step.
        if (o.has("stage") && !o.get("stage").isJsonNull()) {
            final String stage = o.get("stage").getAsString();
            if (!stage.isBlank()) {
                setup.addFirst(stage);
            }
        }
        BlockPos at = null;
        if (o.has("at") && o.get("at").isJsonObject()) {
            final JsonObject p = o.getAsJsonObject("at");
            at = new BlockPos(p.get("x").getAsInt(), p.get("y").getAsInt(), p.get("z").getAsInt());
        }
        final List<String> tags = new ArrayList<>();
        if (o.has("tags") && o.get("tags").isJsonArray()) {
            for (final var element : o.getAsJsonArray("tags")) {
                tags.add(element.getAsString());
            }
        }
        final String state = o.has("state") && !o.get("state").isJsonNull()
            ? o.get("state").getAsString().toLowerCase(Locale.ROOT) : OPEN;
        return new ReviewAsk(
            require(o, "id"), optional(o, "source"), require(o, "title"), require(o, "look"),
            require(o, "failure"), setup, optional(o, "check"), at, optional(o, "from"), tags,
            state,
            optional(o, "comment"), optional(o, "answered_by"),
            o.has("answered_tick") && !o.get("answered_tick").isJsonNull()
                ? o.get("answered_tick").getAsLong() : null,
            optional(o, "staged"));
    }

    JsonObject write() {
        final JsonObject o = new JsonObject();
        o.addProperty("id", this.id);
        o.addProperty("source", this.source);
        o.addProperty("title", this.title);
        o.addProperty("look", this.look);
        o.addProperty("failure", this.failure);
        if (!this.setup.isEmpty()) {
            final JsonArray setup = new JsonArray();
            this.setup.forEach(setup::add);
            o.add("setup", setup);
        }
        if (this.check != null) {
            o.addProperty("check", this.check);
        }
        if (this.at != null) {
            final JsonObject p = new JsonObject();
            p.addProperty("x", this.at.getX());
            p.addProperty("y", this.at.getY());
            p.addProperty("z", this.at.getZ());
            o.add("at", p);
        }
        if (this.from != null) {
            o.addProperty("from", this.from);
        }
        if (!this.tags.isEmpty()) {
            final JsonArray tags = new JsonArray();
            this.tags.forEach(tags::add);
            o.add("tags", tags);
        }
        o.addProperty("state", this.state);
        if (this.comment != null) {
            o.addProperty("comment", this.comment);
        }
        if (this.answeredBy != null) {
            o.addProperty("answered_by", this.answeredBy);
        }
        if (this.answeredTick != null) {
            o.addProperty("answered_tick", this.answeredTick);
        }
        if (this.staged != null) {
            o.addProperty("staged", this.staged);
        }
        return o;
    }

    private static String require(final JsonObject o, final String key) {
        if (!o.has(key) || o.get(key).isJsonNull()) {
            throw new IllegalArgumentException("missing '" + key + "'");
        }
        return o.get(key).getAsString();
    }

    private static @Nullable String optional(final JsonObject o, final String key) {
        return o.has(key) && !o.get(key).isJsonNull() ? o.get(key).getAsString() : null;
    }
}
