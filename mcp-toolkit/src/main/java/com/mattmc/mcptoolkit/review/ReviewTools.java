package com.mattmc.mcptoolkit.review;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.ExecutionContext;
import com.mattmc.mcptoolkit.McpTools;
import com.mattmc.mcptoolkit.Mechanism;
import com.mattmc.mcptoolkit.Schemas;
import com.mattmc.mcptoolkit.ToolDef;
import net.minecraft.core.BlockPos;
import net.minecraft.server.MinecraftServer;
import org.jspecify.annotations.Nullable;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * <b>The agent's half of the review layer: post a question, read the answers.</b>
 *
 * <p>Two tools, and the second one is the point. Every owed human test in this workspace has been
 * recorded as prose in a design document addressed to nobody, and the standing instruction "read the
 * answers file first next session" is a handoff note doing a mechanism's job. {@code review_status}
 * is that mechanism: the verdicts are a tool call away from any session, in any world, with no
 * knowledge of where the file lives.
 *
 * <p>Both are dev/operator surface. Posting runs commands at the console's own authority when the
 * ask is later staged ({@link ReviewWalk}), which is why {@code review_post} declares
 * {@link Mechanism#PRIVILEGED} rather than pretending an ask is an inert record; and an agent that is
 * itself the embodied player has no business tasking the human, which is why the shim hides both
 * from the player-legal profile.
 */
public final class ReviewTools {

    private ReviewTools() {}

    private static final int DEFAULT_LIMIT = 50;

    public static void register() {
        McpTools.register(ToolDef.of(
            "review_post",
            "Ask a human to look at something and judge it — the owed-human-test queue. The ask is "
                + "written to <server dir>/review/asks.json; a person walks it with /mmcp review next, "
                + "which runs your `setup` commands to put them in front of the subject, shows the "
                + "question, and files their verdict. Read verdicts back with review_status. "
                + "REQUIRED: `failure` — what it looks like when it is wrong. An ask that cannot "
                + "fail collects a nod instead of a judgement and is refused. `check` is a command "
                + "(e.g. \"execute if block 10 64 20 minecraft:chest\") whose success means the "
                + "world already answers the ask: it closes as `checked` at the next server start "
                + "or /mmcp review check and never reaches a human. Passing an existing `id` updates that "
                + "ask's wording and keeps any verdict already given.",
            Schemas.objectOpt(Schemas.object(
                "title", Schemas.str("the question itself, one line"),
                "look", Schemas.str("where to point the eyes once staged — the thing being judged"),
                "failure", Schemas.str("what it looks like when it is wrong (required)"),
                "id", Schemas.str("stable short id; generated when absent. An existing id updates."),
                "source", Schemas.str("who is asking (default `agent`); also the /mmcp review only filter"),
                "setup", Schemas.array(Schemas.str("a server command, run in order, that stages the "
                    + "subject — e.g. \"rocketeer visit type ash\", \"time set midnight\". What the "
                    + "last one PRINTS is kept as the ask's staging note, so a stage command that "
                    + "names its seed makes a rejection reproducible.")),
                "check", Schemas.str("a command whose success means the world already answers this"),
                "from", Schemas.str("who is asking and why it matters — a document section, a bug, "
                    + "a promise made in a handoff, or why a previously-answered ask was re-opened. "
                    + "Free text, unlike `source`, which is the short thing the walk filters on."),
                "tags", Schemas.array(Schemas.str("free label a reviewer can narrow the walk by "
                    + "(/mmcp review only <tag>) — a theme or a tier, so a long queue can be walked in "
                    + "sittings")),
                "at", Schemas.vec3i("block the reviewer's on-screen card highlights, if any")),
                "id", "source", "setup", "check", "from", "tags", "at"),
            ExecutionContext.SERVER,
            Mechanism.PRIVILEGED,
            (ctx, args) -> post(ctx.serverOrThrow(), args)));

        McpTools.register(ToolDef.of(
            "review_status",
            "Read the human-review queue: what is still owed, and what people said about what they "
                + "already looked at. Verdicts are `ok`, `no` (always with a reason), `note`, or "
                + "`checked` — answered by an ask's own predicate with nobody looking, which is "
                + "deliberately NOT the same fact as a person's `ok`. Rejections come first. Every "
                + "answered ask carries `staged`, the line its staging command printed, so a "
                + "rejected subject can be stood in front of again. Filter with `state` or `source`. "
                + "A verdict gates nothing: this is evidence for you to decide on.",
            Schemas.objectOpt(Schemas.object(
                "state", Schemas.str("open | ok | no | note | checked — default: everything"),
                "source", Schemas.str("only asks whose source OR tag is this"),
                "limit", Schemas.integer("max asks returned (default " + DEFAULT_LIMIT + ")")),
                "state", "source", "limit"),
            ExecutionContext.SERVER,
            Mechanism.OBSERVE,
            (ctx, args) -> status(ctx.serverOrThrow(), args)));
    }

    // ---------------------------------------------------------------------------------------------

    private static JsonElement post(final MinecraftServer server, final JsonObject args) {
        final List<ReviewAsk> asks = ReviewQueue.load(server);
        final List<String> setup = new ArrayList<>();
        if (args.has("setup") && args.get("setup").isJsonArray()) {
            for (final JsonElement element : args.getAsJsonArray("setup")) {
                setup.add(element.getAsString());
            }
        }
        BlockPos at = null;
        if (args.has("at") && args.get("at").isJsonObject()) {
            final JsonObject p = args.getAsJsonObject("at");
            at = new BlockPos(p.get("x").getAsInt(), p.get("y").getAsInt(), p.get("z").getAsInt());
        }
        final List<String> tags = new ArrayList<>();
        if (args.has("tags") && args.get("tags").isJsonArray()) {
            for (final JsonElement element : args.getAsJsonArray("tags")) {
                tags.add(element.getAsString());
            }
        }
        final String id = str(args, "id") == null ? ReviewCommands.nextId(asks) : str(args, "id");
        // A record built from the arguments; the constructor is what refuses an ask with no failure
        // mode, and its message is the one the caller should read.
        final ReviewAsk fresh = ReviewAsk.open(id,
            str(args, "source") == null ? "agent" : str(args, "source"),
            require(args, "title"), require(args, "look"), require(args, "failure"),
            setup, str(args, "check"), at).withTags(tags.toArray(new String[0]));
        final String provenance = str(args, "from");
        final ReviewAsk described = provenance == null ? fresh : fresh.withFrom(provenance);

        ReviewAsk stored = described;
        boolean updated = false;
        final List<ReviewAsk> out = new ArrayList<>(asks.size() + 1);
        for (final ReviewAsk existing : asks) {
            if (existing.id().equals(id)) {
                // An existing id is an EDIT, and it keeps the answer. Re-posting a question whose
                // wording improved must not delete the judgement somebody already gave it — the
                // same rule declared subjects live by (ReviewQueue.merge).
                stored = existing.redescribed(described);
                out.add(stored);
                updated = true;
            } else {
                out.add(existing);
            }
        }
        if (!updated) {
            out.add(described);
        }
        ReviewQueue.save(server, out);
        ReviewWalk.rebuildSnapshot(server);
        ReviewWalk.emit("review_posted", stored, null, null, stored.source());

        final JsonObject result = new JsonObject();
        result.addProperty("id", stored.id());
        result.addProperty("updated", updated);
        result.addProperty("state", stored.state());
        result.addProperty("total", out.size());
        result.addProperty("open", out.stream().filter(ReviewAsk::open).count());
        result.addProperty("file", ReviewQueue.file(server).toString());
        result.addProperty("walked_by", "/mmcp review next");
        if (stored.check() != null) {
            result.addProperty("note", ReviewAsk.CHECKED.equals(stored.state())
                ? "already `checked` — its predicate holds, so no human is being asked; it re-opens"
                    + " by itself if the world stops satisfying it"
                : "the check runs at the next server start or /mmcp review check; if it passes, this"
                    + " closes as `checked` and no human is asked");
        }
        return result;
    }

    private static JsonElement status(final MinecraftServer server, final JsonObject args) {
        final List<ReviewAsk> asks = ReviewQueue.load(server);
        final String state = str(args, "state");
        final String source = str(args, "source");
        final int limit = args.has("limit") && !args.get("limit").isJsonNull()
            ? Math.max(1, args.get("limit").getAsInt()) : DEFAULT_LIMIT;

        final Map<String, Integer> counts = new LinkedHashMap<>();
        for (final String s : ReviewAsk.STATES) {
            counts.put(s, 0);
        }
        for (final ReviewAsk ask : asks) {
            counts.merge(ask.state(), 1, Integer::sum);
        }

        // Rejections first, then notes, then what is still owed, then the passes. The order of a
        // list is an argument about what matters, and the reader here is a session deciding what to
        // fix — a truncated page must lose an `ok`, never a `no`.
        final List<ReviewAsk> ordered = new ArrayList<>();
        for (final String s : List.of(ReviewAsk.NO, ReviewAsk.NOTE, ReviewAsk.OPEN, ReviewAsk.CHECKED,
                ReviewAsk.OK)) {
            for (final ReviewAsk ask : asks) {
                if (!ask.state().equals(s)) {
                    continue;
                }
                if (state != null && !state.equalsIgnoreCase(ask.state())) {
                    continue;
                }
                if (source != null && !ask.matches(source)) {
                    continue;
                }
                ordered.add(ask);
            }
        }

        final JsonArray rows = new JsonArray();
        for (final ReviewAsk ask : ordered.subList(0, Math.min(limit, ordered.size()))) {
            rows.add(row(ask));
        }

        final JsonObject result = new JsonObject();
        result.addProperty("total", asks.size());
        final JsonObject by = new JsonObject();
        counts.forEach(by::addProperty);
        result.add("by_state", by);
        result.add("asks", rows);
        if (ordered.size() > rows.size()) {
            result.addProperty("truncated", ordered.size() - rows.size());
        }
        result.addProperty("file", ReviewQueue.file(server).toString());
        result.addProperty("gates", "nothing — a verdict is a person's judgement, not a build result");
        return result;
    }

    private static JsonObject row(final ReviewAsk ask) {
        final JsonObject o = new JsonObject();
        o.addProperty("id", ask.id());
        o.addProperty("state", ask.state());
        o.addProperty("source", ask.source());
        o.addProperty("title", ask.title());
        if (ask.from() != null) {
            o.addProperty("from", ask.from());
        }
        if (!ask.tags().isEmpty()) {
            final JsonArray tags = new JsonArray();
            ask.tags().forEach(tags::add);
            o.add("tags", tags);
        }
        if (ask.open()) {
            o.addProperty("look", ask.look());
            o.addProperty("failure", ask.failure());
            if (!ask.setup().isEmpty()) {
                final JsonArray setup = new JsonArray();
                ask.setup().forEach(setup::add);
                o.add("setup", setup);
            }
            if (ask.check() != null) {
                o.addProperty("check", ask.check());
            }
        } else {
            if (ask.comment() != null) {
                o.addProperty("comment", ask.comment());
            }
            if (ask.answeredBy() != null) {
                o.addProperty("by", ask.answeredBy());
            }
            if (ask.answeredTick() != null) {
                o.addProperty("tick", ask.answeredTick());
            }
            // The reproducible subject. A rejection nobody can stand in front of again is a bug
            // report that cannot be acted on, which is why this rides every answered row.
            if (ask.staged() != null) {
                o.addProperty("staged", ask.staged());
            }
        }
        return o;
    }

    // ---------------------------------------------------------------------------------------------

    private static String require(final JsonObject args, final String key) {
        final String value = str(args, key);
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException("missing required argument '" + key + "'"
                + ("failure".equals(key)
                    ? " — what does it look like when this is WRONG? An ask that cannot fail spends"
                        + " a human's attention and returns nothing"
                    : ""));
        }
        return value;
    }

    private static @Nullable String str(final JsonObject args, final String key) {
        if (!args.has(key) || args.get(key).isJsonNull()) {
            return null;
        }
        final String value = args.get(key).getAsString();
        return "state".equals(key) || "source".equals(key) ? value.toLowerCase(Locale.ROOT) : value;
    }
}
