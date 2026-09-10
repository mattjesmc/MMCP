package com.mattmc.mcptoolkit.review;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.mattmc.mcptoolkit.McpToolkit;
import net.minecraft.server.MinecraftServer;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * <b>The queue: one file, shared by every mod on the server.</b>
 *
 * <p>{@code <server dir>/review/asks.json} holds the questions and their answers; {@code answers.md}
 * beside it is a rendering and never a source. One file rather than one per mod, and that is a
 * decision rather than an economy: a human walking a review session should answer whatever is owed
 * on this server, not be asked to know which mod owed it, and a later session reading back has one
 * path to know instead of a directory to discover. {@link ReviewAsk#source} keeps the attribution
 * that the separate files were carrying.
 *
 * <p>It is rewritten in full after <em>every</em> verdict rather than at the end, because a review
 * that ends by closing the client is the normal case and a buffered one would lose the whole walk.
 *
 * <p><b>A malformed entry is dropped with a log line and the rest of the file still loads.</b> This
 * file is hand-written by agents, so a broken entry is likely; refusing the whole queue for one bad
 * row would lose every other question a human was about to be asked, which is a worse failure than
 * skipping the row that is wrong.
 */
public final class ReviewQueue {

    /** Under the server directory, so a run keeps its own answers. */
    public static final String DIRECTORY = "review";

    private ReviewQueue() {}

    public static Path directory(final MinecraftServer server) {
        return server.getFile(DIRECTORY);
    }

    public static Path file(final MinecraftServer server) {
        return directory(server).resolve("asks.json");
    }

    public static Path rendering(final MinecraftServer server) {
        return directory(server).resolve("answers.md");
    }

    // ---------------------------------------------------------------------------------------------

    /** Read the queue. A missing file is an empty queue rather than an error — the normal first run. */
    public static List<ReviewAsk> load(final MinecraftServer server) {
        final Path path = file(server);
        final List<ReviewAsk> out = new ArrayList<>();
        if (!Files.exists(path)) {
            return out;
        }
        try {
            final JsonElement root = JsonParser.parseString(
                Files.readString(path, StandardCharsets.UTF_8));
            final JsonArray array = root.isJsonArray()
                ? root.getAsJsonArray() : root.getAsJsonObject().getAsJsonArray("asks");
            final Set<String> seen = new LinkedHashSet<>();
            for (final JsonElement element : array) {
                try {
                    final ReviewAsk ask = ReviewAsk.read(element.getAsJsonObject());
                    // A duplicate id is worse than a malformed row: a verdict filed under it could
                    // land on either copy, so the second one is refused rather than silently kept.
                    if (!seen.add(ask.id())) {
                        McpToolkit.LOGGER.error("[review] duplicate ask id '{}' in {} — dropping the"
                            + " later copy", ask.id(), path);
                        continue;
                    }
                    out.add(ask);
                } catch (final RuntimeException bad) {
                    McpToolkit.LOGGER.error("[review] dropping a malformed ask in {}: {}",
                        path, bad.getMessage());
                }
            }
        } catch (final IOException | RuntimeException e) {
            McpToolkit.LOGGER.error("[review] could not read {}: {}", path, e.toString());
        }
        return out;
    }

    /** Write the queue and its rendering. Both, always: a stale rendering is worse than none. */
    public static void save(final MinecraftServer server, final List<ReviewAsk> asks) {
        final JsonArray array = new JsonArray();
        for (final ReviewAsk ask : asks) {
            array.add(ask.write());
        }
        try {
            Files.createDirectories(directory(server));
            // One ask per line: the file's other author is an agent running a text editor, and a
            // single-line 6KB array is one it can only rewrite wholesale.
            Files.writeString(file(server), array.toString().replace("},{", "},\n{") + "\n",
                StandardCharsets.UTF_8);
            Files.writeString(rendering(server), render(asks), StandardCharsets.UTF_8);
        } catch (final IOException e) {
            McpToolkit.LOGGER.error("[review] could not write {}: {}", file(server), e.toString());
        }
    }

    /** Replace one ask by id and persist. Returns the saved list. */
    static List<ReviewAsk> replace(final MinecraftServer server, final List<ReviewAsk> asks,
                                   final ReviewAsk updated) {
        final List<ReviewAsk> out = new ArrayList<>(asks.size());
        for (final ReviewAsk ask : asks) {
            out.add(ask.id().equals(updated.id()) ? updated : ask);
        }
        save(server, out);
        return out;
    }

    // ---------------------------------------------------------------------------------------------

    /**
     * Merge a mod's freshly enumerated subjects into the queue.
     *
     * <p>Three rules, each of which exists because the alternative loses something real:
     *
     * <ul>
     *   <li><b>An existing id keeps its answer.</b> A mod that enumerates subjects from its own enums
     *       re-declares all of them on every boot; a declaration that reset the state would erase
     *       every verdict a human ever gave. The description is refreshed (it drifts with the code
     *       and should); the judgement is not (it is a record of a moment).</li>
     *   <li><b>An ask this source no longer declares, and nobody answered, is dropped.</b> Nothing is
     *       lost — it carries no judgement — and leaving it would send a human to look at a subject
     *       the mod can no longer stage.</li>
     *   <li><b>An answered one is kept even when it is no longer declared.</b> That is the history the
     *       rule above is careful not to destroy.</li>
     * </ul>
     */
    static List<ReviewAsk> merge(final List<ReviewAsk> existing, final String source,
                                 final List<ReviewAsk> declared) {
        final Set<String> declaredIds = new LinkedHashSet<>();
        for (final ReviewAsk ask : declared) {
            declaredIds.add(ask.id());
        }
        final List<ReviewAsk> out = new ArrayList<>();
        final Set<String> kept = new LinkedHashSet<>();
        for (final ReviewAsk ask : existing) {
            if (!source.equals(ask.source())) {
                out.add(ask);
                continue;
            }
            if (declaredIds.contains(ask.id())) {
                out.add(ask); // re-described below, in declaration order
                kept.add(ask.id());
            } else if (!ask.open()) {
                out.add(ask); // answered history from a subject that has since gone
            }
        }
        // Re-describe in place, then append the genuinely new ones. Order matters to a person
        // walking the queue: a subject list has an order its author chose, and reshuffling it every
        // boot would make "where was I" unanswerable.
        final List<ReviewAsk> merged = new ArrayList<>(out.size() + declared.size());
        for (final ReviewAsk ask : out) {
            if (kept.contains(ask.id())) {
                for (final ReviewAsk fresh : declared) {
                    if (fresh.id().equals(ask.id())) {
                        merged.add(ask.redescribed(fresh));
                        break;
                    }
                }
            } else {
                merged.add(ask);
            }
        }
        for (final ReviewAsk fresh : declared) {
            if (!kept.contains(fresh.id())) {
                merged.add(fresh);
            }
        }
        return merged;
    }

    // ---------------------------------------------------------------------------------------------

    /**
     * The markdown a later session actually reads.
     *
     * <p>Rejections first and unanswered last, because the reason this exists is to be scanned by
     * somebody deciding what to fix, and the order of a list is an argument about what matters.
     */
    private static String render(final List<ReviewAsk> asks) {
        final StringBuilder out = new StringBuilder("# review\n\n");
        out.append("Written by `/review` (mcp-toolkit). The queue itself is `asks.json` beside this\n");
        out.append("file — this is a rendering and never a source. A verdict gates nothing.\n");
        out.append("Ask the live server instead with the `review_status` tool.\n");
        section(out, asks, ReviewAsk.NO, "Rejected");
        section(out, asks, ReviewAsk.NOTE, "Noted");
        section(out, asks, ReviewAsk.OK, "Passed");
        section(out, asks, ReviewAsk.CHECKED, "Answered by check (nobody looked)");
        section(out, asks, ReviewAsk.OPEN, "Still owed");
        return out.toString();
    }

    private static void section(final StringBuilder out, final List<ReviewAsk> asks,
                                final String state, final String heading) {
        final List<ReviewAsk> rows = asks.stream().filter(a -> a.state().equals(state)).toList();
        out.append("\n## ").append(heading).append(" (").append(rows.size()).append(")\n\n");
        for (final ReviewAsk ask : rows) {
            out.append("- **").append(ask.id()).append("** — ").append(ask.title())
                .append("  `").append(ask.source()).append('`');
            for (final String tag : ask.tags()) {
                out.append(" `").append(tag).append('`');
            }
            out.append('\n');
            if (ask.comment() != null && !ask.comment().isBlank()) {
                out.append("  - ").append(ask.comment()).append('\n');
            }
            // Provenance rides EVERY row, answered or not: on an open one it is why somebody should
            // care, and on an answered one it is what a later session needs to place the verdict.
            if (ask.from() != null && !ask.from().isBlank()) {
                out.append("  - from: ").append(ask.from()).append('\n');
            }
            // The staging note is where a reproducible subject lives (menagerie's seed), so it rides
            // every answered row: a rejection nobody can stand in front of again is a bug report
            // that cannot be acted on.
            if (!ReviewAsk.OPEN.equals(state) && ask.staged() != null && !ask.staged().isBlank()) {
                out.append("  - staged: ").append(ask.staged()).append('\n');
            }
            if (ask.answeredBy() != null) {
                out.append("  - by: ").append(ask.answeredBy()).append('\n');
            }
            if (ReviewAsk.OPEN.equals(state)) {
                out.append("  - look: ").append(ask.look()).append('\n');
                out.append("  - fails if: ").append(ask.failure()).append('\n');
                if (!ask.setup().isEmpty()) {
                    out.append("  - staged by: `/").append(String.join("`, `", ask.setup()))
                        .append("`\n");
                }
                if (ask.check() != null) {
                    out.append("  - checked by: `/").append(ask.check()).append("`\n");
                }
            }
        }
    }
}
